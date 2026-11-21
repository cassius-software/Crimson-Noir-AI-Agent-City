#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? Two workflows publish after each green ci on main: web.yml puts the web copy on GitHub
 * Pages and current.yml puts every download (the nine targets of tools/build/matrix.mjs, the UEFI media among them)
 * on the `current` pre-release. Each can skip, wait or fail without the other, and a run that publishes nothing can
 * still end green: on 21 November 2026 the web copy, the downloads and main stood at three commits for hours with
 * every run green. This script looks at what is published and says, in red when it must, whether everything comes
 * from one commit: the newest commit on main that ci passed on (current.mjs `choose`, the rule the downloads follow).
 * `.github/workflows/sync.yml` runs it after each run of the two publishers and every hour.
 * - `check [--site <address>] [--summary <file>] [--report-only]` reads:
 *   the web copy's build.json (the commit web.yml built it from, tools/web/pwa.mjs STAMP) and build.txt (the build the
 *   host names), asked for past every cache; the release's record current.json (the commit of the publish and of each
 *   target's files), whether a staged record is still there, the tag `current`, and each recorded file's size and
 *   digest as GitHub holds it; the first sectors of each UEFI disk image, whose disk GUID
 *   crimson_noir_os/tools/build-image.sh derives from the commit it bakes, so the image itself says which commit it
 *   is; and the runs of web, current and ci on main that have not ended.
 * - The verdict (`verdict`, a pure function over those facts):
 *   `in-sync`  the web copy, the release's record, every required target, the tag and the bytes all name that commit;
 *   `settling` something is behind, and something can still mend it: ci passed on that commit a few minutes ago, a
 *              publisher's run has not ended (and is not older than a run can be), the web copy was published
 *              minutes ago (the host may serve the copy before for ten minutes), or, for the web copy alone, ci
 *              is still running on a newer commit (web.yml publishes main's tip alone, so it waits for that one);
 *   `drift`    something is behind and nothing is on its way: exit 1, one error line for each thing, each with the
 *              commit it is at and the workflow to run by hand;
 *   `unknown`  a source could not be read after three tries: exit 2, since "could not look" is not "in sync".
 *   The iOS build is best effort everywhere (build-matrix.yml, current.mjs BEST_EFFORT): behind, it is a warning.
 *   `--report-only` prints the same and exits 0 (a pull request that changes this tool: what is published is not
 *   the pull request's doing).
 * It writes nothing anywhere: GitHub is read through `gh api` (GH_TOKEN, GH_REPO), the site and the disk images
 * through plain https.
 * What breaks if it is removed? Nothing is published differently; a web copy and downloads that have come apart
 * stay that way behind green runs until someone compares them by hand.
 */
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BEST_EFFORT, STAGED, TAG, choose, getRelease, mainTip, readState, realGh, tagAt } from './current.mjs'
import { IDS } from './matrix.mjs'

/**
 * How long each thing may take, in minutes, before "behind" stops being "on its way": `start` after ci passed (the
 * two publishers are started by that and may wait for a runner); `web` and `current` for a run of each that has not
 * ended (web.yml's jobs are limited to 35 minutes in all, current.yml's builds to about two hours, and both can wait
 * for runners first); `served` after a web run ended (GitHub Pages lets an answer be kept ten minutes); `ci` for a ci
 * run on a newer commit that has not ended (its browser job alone is limited to 45 minutes).
 */
export const GRACE = Object.freeze({ start: 10, web: 45, current: 180, served: 15, ci: 100 })

/**
 * The UEFI disk images and the word crimson_noir_os/tools/build-image.sh puts before the commit for the image's GUIDs
 * (nothing for x86-64, whose bytes are what they were before there was a second architecture).
 */
export const MEDIA = Object.freeze({
  'uefi-x64': Object.freeze({ file: 'crimson_noir_os.img', arch: '' }),
  'uefi-arm64': Object.freeze({ file: 'crimson_noir_os-aarch64.img', arch: 'aarch64:' }),
})

const SHA = /^[0-9a-f]{40}$/
const short = (sha) => (SHA.test(String(sha ?? '')) ? String(sha).slice(0, 7) : String(sha ?? 'nothing'))
const minutes = (later, earlier) => (Date.parse(later) - Date.parse(earlier)) / 60000

/** The disk GUID crimson_noir_os/tools/build-image.sh gives a commit's disk image: the first 32 hex digits of its hash. */
export function mediaGuid(commit, arch = '') {
  const h = createHash('sha256').update(`crimson-noir-media:${arch}${commit}`).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

/**
 * The disk GUID in a GPT disk's first sectors (the header is the second 512-byte sector, the GUID 56 bytes into it,
 * its first three fields little-endian), written as sgdisk takes it; null when the bytes are not a GPT header.
 */
export function diskGuid(bytes) {
  const b = Buffer.from(bytes ?? [])
  if (b.length < 512 + 72 || b.subarray(512, 520).toString('latin1') !== 'EFI PART') return null
  const g = b.subarray(512 + 56, 512 + 72)
  const le = (from, to) => Buffer.from(g.subarray(from, to)).reverse().toString('hex')
  return `${le(0, 4)}-${le(4, 6)}-${le(6, 8)}-${g.subarray(8, 10).toString('hex')}-${g.subarray(10, 16).toString('hex')}`
}

/** Where GitHub Pages serves a repository's site when it has no domain of its own. */
export function siteOf(repo) {
  const [owner, name] = String(repo).split('/')
  return `https://${owner.toLowerCase()}.github.io/${name}/`
}

/**
 * The verdict over what was read; see the header. `facts`:
 *   now      ISO time of the look
 *   tip      main's tip, when it was read (only to say why a web copy that is behind cannot be mended by hand)
 *   green    { sha, ci, at } the newest commit on main ci passed on and when, or null; or { error }
 *   web      { stamp: build.json's object or null when the site has none, probe: build.txt's word } or { error }
 *   release  { state: current.json as current.mjs reads it, staged: a staged record is there, tag: where `current`
 *            points or null, assets: [{ name, size, digest }] }, null when there is no release, or { error }
 *   media    { <target>: the image's disk GUID, or null when it could not be read }
 *   runs     [{ workflow: 'web' | 'current' | 'ci', created, sha }] runs on main that have not ended
 *   served   ISO time the last web run that passed ended, or null
 * Returns { status, problems, waiting, warnings, rows }: `rows` is [thing, commit, state] for the summary.
 */
export function verdict(facts, grace = GRACE) {
  const unknown = []
  if (!facts.green) unknown.push('no commit on main has passed ci, by ci\'s list of runs')
  else if (facts.green.error) unknown.push(`the newest commit on main that ci passed on: ${facts.green.error}`)
  if (facts.web?.error) unknown.push(`the web copy: ${facts.web.error}`)
  if (facts.release?.error) unknown.push(`the release: ${facts.release.error}`)
  if (unknown.length) return { status: 'unknown', problems: unknown, waiting: [], warnings: [], rows: [] }

  const G = facts.green.sha
  const behind = { web: [], current: [] }
  const problems = []
  const warnings = []
  const rows = [['main, newest commit ci passed on', G, `ci passed ${facts.green.at || 'at a time GitHub did not give'}`]]

  // The web copy: its stamp names the commit, and the build the host names is the stamp's.
  const stamp = facts.web.stamp
  if (!stamp) {
    behind.web.push('the web copy has no build.json, so it was published before copies were stamped with their commit (or not by web.yml)')
    rows.push(['web copy', '', 'no build.json'])
  } else {
    if (stamp.commit !== G) behind.web.push(`the web copy is built from ${short(stamp.commit)}, not ${short(G)}`)
    // The page (build.txt) and the stamp come up in one publish, but the host's network can serve one of them from
    // the publish before for some minutes: behind, not broken, unless nothing is on its way.
    if (facts.web.probe !== stamp.cache) behind.web.push(`the web copy's build.txt names ${facts.web.probe || 'nothing'} and its build.json ${stamp.cache || 'nothing'}: two publishes at once`)
    rows.push(['web copy', stamp.commit, stamp.commit === G ? 'same commit' : 'another commit'])
  }

  // The release: its record, every required target, the tag, and the bytes GitHub holds under each recorded name.
  const rel = facts.release
  if (!rel) {
    behind.current.push('there is no `current` release')
    rows.push(['downloads (the current release)', '', 'no release'])
  } else {
    const s = rel.state
    if (!s.commit) behind.current.push('the release has no record of the commit it holds (current.json)')
    else if (s.commit !== G) behind.current.push(`the downloads are built from ${short(s.commit)}, not ${short(G)}`)
    rows.push(['downloads (the current release)', s.commit ?? '', s.commit === G ? 'same commit' : 'another commit'])
    if (rel.staged) behind.current.push(`a publish is under way or stopped half way (${STAGED} is on the release)`)
    for (const id of IDS) {
      const t = s.targets[id]
      const best = BEST_EFFORT.includes(id)
      const state = !t ? 'no files' : t.commit === G ? 'same commit' : 'another commit'
      rows.push([`  ${id}${best ? ' (best effort)' : ''}`, t?.commit ?? '', state])
      if (t?.commit === G) continue
      const said = t ? `${id} is built from ${short(t.commit)}, not ${short(G)}` : `${id} has no files on the release`
      if (best) warnings.push(`${said} (best effort: it never turns a publish red)`)
      else behind.current.push(said)
    }
    if (s.commit && rel.tag !== s.commit) behind.current.push(`the tag ${TAG} is at ${short(rel.tag)}, and the release's record says ${short(s.commit)}`)
    rows.push([`tag ${TAG}`, rel.tag ?? '', rel.tag && rel.tag === G ? 'same commit' : 'another commit'])
    // While a publish replaces files one at a time the names and the record disagree by design; once the record is
    // whole (no staged one), every recorded file must be there as recorded. That is broken, not behind.
    if (!rel.staged) {
      const have = new Map(rel.assets.map((a) => [a.name, a]))
      for (const id of IDS) for (const f of s.targets[id]?.files ?? []) {
        const a = have.get(f.name)
        if (!a) problems.push(`${f.name} (${id}) is in the release's record and not on the release`)
        else if (a.size !== f.size || (a.digest && a.digest !== `sha256:${f.sha256}`)) problems.push(`${f.name} (${id}) on the release is not the file its record names (size or SHA-256 differs)`)
      }
    }
    // The disk images say their commit themselves: the GUID in the image is the recorded commit's.
    for (const [id, { file, arch }] of Object.entries(MEDIA)) {
      const t = s.targets[id]
      if (!t) continue
      const guid = facts.media?.[id]
      if (!guid) warnings.push(`${file}: its disk GUID could not be read, so the image was not asked which commit it is`)
      else if (guid !== mediaGuid(t.commit, arch)) problems.push(`${file} carries the disk GUID ${guid}, which is not the one ${short(t.commit)} bakes (${mediaGuid(t.commit, arch)}): the image is not the commit its record names`)
    }
  }

  // What can still mend "behind": ci passed moments ago, a publisher that has not ended, a publish minutes old, or
  // (the web copy alone, while web.yml publishes main's tip alone) ci still running on a newer commit.
  const age = (iso) => minutes(facts.now, iso)
  const fresh = facts.green.at && age(facts.green.at) < grace.start
  const running = (workflow, limit) => (facts.runs ?? []).find((r) => r.workflow === workflow && age(r.created) < limit)
  const waiting = []
  const settle = (list, why) => { for (const p of list) waiting.push(`${p} (${why})`) }
  if (behind.web.length) {
    const web = running('web', grace.web)
    const ci = (facts.runs ?? []).find((r) => r.workflow === 'ci' && r.sha !== G && age(r.created) < grace.ci)
    if (fresh) settle(behind.web, `ci passed ${Math.max(0, Math.round(age(facts.green.at)))} min ago`)
    else if (web) settle(behind.web, 'a web run has not ended')
    else if (facts.served && age(facts.served) < grace.served) settle(behind.web, `a web run ended ${Math.max(0, Math.round(age(facts.served)))} min ago, and the host may serve the copy before for ten`)
    else if (ci) settle(behind.web, `ci is still running on ${short(ci.sha)}, and the web copy waits for main's tip`)
    else {
      // web.yml publishes main's tip alone, by hand too: when ci has not passed on the tip, a run by hand would
      // publish a commit nothing vouches for, so that is said in place of the advice.
      const mend = facts.tip && facts.tip !== G
        ? `ci has not passed on main's tip (${short(facts.tip)}), the one commit web.yml publishes, so the web copy follows when ci passes there (a web run by hand would publish that tip untested)`
        : 'Actions > web > Run workflow, on main'
      for (const p of behind.web) problems.push(`${p}: ${mend}`)
    }
  }
  if (behind.current.length) {
    if (fresh) settle(behind.current, `ci passed ${Math.max(0, Math.round(age(facts.green.at)))} min ago`)
    else if (running('current', grace.current)) settle(behind.current, 'a current run has not ended')
    else for (const p of behind.current) problems.push(`${p}: Actions > current > Run workflow, on main`)
  }
  return { status: problems.length ? 'drift' : waiting.length ? 'settling' : 'in-sync', problems, waiting, warnings, rows }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading. `gh(argv) -> { ok, out, err }` as in current.mjs; `get(url, { range }) -> Promise<{ status, bytes }>`.

/** The first `limit` bytes of an answer's body; the rest is never read (a host may ignore a range and send it all). */
async function head(res, limit) {
  const parts = []
  let have = 0
  const reader = res.body?.getReader()
  while (reader && have < limit) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
    have += value.length
  }
  await reader?.cancel().catch(() => {})
  return Buffer.concat(parts).subarray(0, limit)
}

/**
 * A plain https GET past every cache, with a deadline; a lost connection or a 5xx is tried three times. With a
 * `range` (`bytes=0-<last>`) only those first bytes are read, whether or not the host kept to the range.
 */
export async function realGet(url, { range = '' } = {}) {
  const first = /^bytes=0-(\d+)$/.exec(range)
  let last = 'no answer'
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(url, { cache: 'no-store', redirect: 'follow', headers: range ? { Range: range } : {}, signal: AbortSignal.timeout(30_000) })
      if (res.status < 500) return { status: res.status, bytes: first ? await head(res, Number(first[1]) + 1) : Buffer.from(await res.arrayBuffer()) }
      last = `HTTP ${res.status}`
    } catch (e) { last = e instanceof Error ? e.message : String(e) }
    if (i < 3) await new Promise((done) => setTimeout(done, 5000 * i))
  }
  throw new Error(last)
}

/** The web copy's stamp and the build its host names, each asked for under an address no cache has seen. */
export async function readWeb(site, get, salt) {
  const fresh = (file) => `${site}${file}?sync=${encodeURIComponent(salt)}`
  try {
    const probe = await get(fresh('build.txt'))
    if (probe.status !== 200) return { error: `${site}build.txt answered HTTP ${probe.status}` }
    const word = probe.bytes.toString('utf8').trim()
    if (!/^agent-city-[\w.+-]+-[0-9a-f]{12}$/.test(word)) return { error: `${site}build.txt is not a build's name: ${JSON.stringify(word.slice(0, 80))}` }
    const stamped = await get(fresh('build.json'))
    if (stamped.status === 404) return { stamp: null, probe: word }
    if (stamped.status !== 200) return { error: `${site}build.json answered HTTP ${stamped.status}` }
    let stamp
    try { stamp = JSON.parse(stamped.bytes.toString('utf8')) } catch { return { error: `${site}build.json is not JSON` } }
    if (!stamp || typeof stamp !== 'object' || stamp.schema !== 1 || !SHA.test(String(stamp.commit ?? ''))) return { error: `${site}build.json names no commit` }
    return { stamp, probe: word }
  } catch (e) {
    return { error: `${site} could not be read (${e instanceof Error ? e.message : String(e)})` }
  }
}

function runsOf(gh, repo, file) {
  const r = gh(['api', `repos/${repo}/actions/workflows/${file}/runs?per_page=30`])
  if (!r.ok) throw new Error(`gh api actions/workflows/${file}/runs: ${r.err.trim() || 'failed'}`)
  return JSON.parse(r.out).workflow_runs ?? []
}

/** Everything `verdict` judges, read now. No source's failure stops the others: each is recorded where it belongs. */
export async function gather({ repo, site = siteOf(repo), now = new Date().toISOString() }, gh, get) {
  const facts = { now, runs: [], served: null, media: {} }
  try {
    facts.tip = mainTip(gh, repo)
    facts.green = choose({ repo }, gh, facts.tip).green
  } catch (e) { facts.green = { error: e.message } }
  facts.web = await readWeb(site, get, now)
  try {
    const release = getRelease(gh, repo)
    if (!release) facts.release = null
    else {
      facts.release = {
        state: readState(gh, repo, release),
        staged: release.assets.some((a) => a.name === STAGED),
        tag: tagAt(gh, repo, TAG),
        assets: release.assets.map(({ name, size, digest }) => ({ name, size, digest })),
      }
      for (const [id, { file }] of Object.entries(MEDIA)) {
        if (!facts.release.state.targets[id]) continue
        try {
          const head = await get(`https://github.com/${repo}/releases/download/${TAG}/${file}`, { range: 'bytes=0-1023' })
          facts.media[id] = head.status === 200 || head.status === 206 ? diskGuid(head.bytes) : null
        } catch { facts.media[id] = null }
      }
    }
  } catch (e) { facts.release = { error: e.message } }
  // The runs that have not ended, on main alone: a pull request's dry run of current.yml publishes nothing.
  try {
    for (const [workflow, file] of [['web', 'web.yml'], ['current', 'current.yml'], ['ci', 'ci.yml']]) {
      const runs = runsOf(gh, repo, file).filter((r) => r.head_branch === 'main' && r.event !== 'pull_request')
      for (const r of runs) if (r.status !== 'completed') facts.runs.push({ workflow, created: r.run_started_at ?? r.created_at, sha: r.head_sha })
      if (workflow === 'web') facts.served = runs.find((r) => r.status === 'completed' && r.conclusion === 'success')?.updated_at ?? null
    }
  } catch (e) {
    // Without the runs nothing is known to be on its way, so "behind" reads as drift: said, so the red is understood.
    facts.runsError = e.message
  }
  return facts
}

/** The verdict as lines for the log (workflow commands for the red and yellow ones) and as a table for the summary. */
export function report(v, facts) {
  const lines = []
  const head = {
    'in-sync': `in sync: the web copy and every download are built from ${facts.green?.sha}`,
    settling: 'settling: something is behind and on its way',
    drift: 'drift: what is published does not come from one commit, and nothing is on its way to mend it',
    unknown: 'unknown: what is published could not be read, so nothing is vouched for',
  }[v.status]
  lines.push(head)
  for (const p of v.problems) lines.push(`::error::${p}`)
  for (const w of v.waiting) lines.push(`::notice::${w}`)
  for (const w of v.warnings) lines.push(`::warning::${w}`)
  if (facts.runsError) lines.push(`::warning::the runs under way could not be listed (${facts.runsError}), so nothing counts as on its way`)
  const cell = (c) => String(c).replace(/\|/g, '\\|')
  const table = v.rows.length
    ? ['| What | Commit | |', '| :--- | :--- | :--- |', ...v.rows.map(([what, commit, state]) => `| ${cell(what).replace(/^ {2}/, '&nbsp;&nbsp;')} | ${commit ? `\`${short(commit)}\`` : ''} | ${cell(state)} |`)].join('\n')
    : ''
  const list = (title, items) => (items.length ? `\n**${title}**\n\n${items.map((i) => `- ${i}`).join('\n')}\n` : '')
  const summary = `## Is everything published from one commit?\n\n**${head}**\n\n${table}\n${list('Wrong', v.problems)}${list('On its way', v.waiting)}${list('Noted', v.warnings)}`
  return { lines, summary }
}

export async function main(argv, gh = realGh, get = realGet) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const flag = (name) => argv.includes(`--${name}`)
  const [cmd] = argv
  const repo = arg('repo') ?? process.env.GH_REPO
  if (cmd !== 'check' || flag('help')) {
    console.log('usage: node tools/build/sync.mjs check [--site <address>] [--summary <file>] [--report-only]\n(GH_REPO names the repository, or --repo owner/name)')
    return cmd && !flag('help') ? 1 : 0
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) { console.error('::error::GH_REPO (or --repo owner/name) must name the repository'); return 1 }
  const site = arg('site') ?? siteOf(repo)
  if (!/^https:\/\/[^\s]+\/$/.test(site)) { console.error(`::error::--site must be an https address ending in a slash, not ${site}`); return 1 }
  try {
    const facts = await gather({ repo, site }, gh, get)
    const v = verdict(facts)
    const { lines, summary } = report(v, facts)
    for (const l of lines) console.log(l)
    if (arg('summary')) appendFileSync(arg('summary'), `${summary}\n`)
    if (flag('report-only')) return 0
    return v.status === 'drift' ? 1 : v.status === 'unknown' ? 2 : 0
  } catch (e) {
    // Not a verdict: the tool itself stopped. Red even for a pull request's report, whose point is that it runs.
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`)
    return 2
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(await main(process.argv.slice(2)))
