#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? Two workflows publish after each green ci on main: web.yml puts the web copy on GitHub
 * Pages and current.yml puts every download (the ten targets of tools/build/matrix.mjs, the UEFI media among them)
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
 *   `settling` something is behind, and something can still mend it: ci passed on that commit a few minutes ago and
 *              no run of that publisher begun since has ended, a publisher's run has not ended (and is not older
 *              than a run can be, its wait for runners included), or the web copy was published minutes ago (the
 *              host may serve the copy before for ten minutes). What has never been published at all (a copy from
 *              before copies were stamped, a target new to the tool) waits for ci while it runs on a newer commit:
 *              it arrives with the first publish of a commit that has it. While a current run has not ended, files
 *              that are not yet the ones the record names are behind too: a publish moves the tag, then replaces
 *              each file under its name, and writes the record last;
 *   `drift`    something is behind and nothing is on its way: exit 1, one error line for each thing, each with the
 *              commit it is at and the workflow to run by hand;
 *   `unknown`  a source could not be read after three tries (every read of GitHub and of the site is made again
 *              when it got no answer): exit 2, since "could not look" is not "in sync".
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
 * two publishers are started by that; it ends for a publisher as soon as a run of it begun since has ended);
 * `web`, `current` and `ci` are what the jobs of one run may take once they have runners (web.yml's are limited to
 * 35 minutes in all; current.yml's to 145: its pick, the builds' 90 and the publish's 45; ci.yml's longest, the
 * browser and Kani jobs, to 90 each), and `queued` is how long a run may wait for runners on top of that. GitHub
 * gives a run's creation alone, not when its jobs got runners, so a run that has not ended counts as on its way
 * while it is younger than the two together (on 21 November 2026 a web run waited 29 minutes for 2 of work).
 * `served` is after a web run that published ended (GitHub Pages lets an answer be kept ten minutes).
 */
export const GRACE = Object.freeze({ start: 10, web: 35, current: 145, served: 15, ci: 90, queued: 180 })

/**
 * The UEFI disk images and the word crimson_noir_os/tools/build-image.sh puts before the commit for the image's GUIDs
 * (nothing for x86-64, whose bytes are what they were before there was a second architecture).
 */
export const MEDIA = Object.freeze({
  'uefi-x64': Object.freeze({ file: 'crimson_noir_os.img', arch: '' }),
  'uefi-arm64': Object.freeze({ file: 'crimson_noir_os-aarch64.img', arch: 'aarch64:' }),
  'uefi-riscv64': Object.freeze({ file: 'crimson_noir_os-riscv64.img', arch: 'riscv64:' }),
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
 *   ended    [{ workflow: 'web' | 'current', created, conclusion }] the newest runs on main of each that have
 *   served   ISO time the last web run that published ended (see `published`), or null
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
  const age = (iso) => minutes(facts.now, iso)
  // A run that has not ended is on its way while it is younger than its jobs' limits and the wait for runners.
  const running = (workflow, limit, which = () => true) => (facts.runs ?? []).find((r) => r.workflow === workflow && which(r) && age(r.created) < limit + grace.queued)
  const publishing = Boolean(running('current', grace.current))
  const rows = [['main, newest commit ci passed on', G, `ci passed ${facts.green.at || 'at a time GitHub did not give'}`]]

  // The web copy: its stamp names the commit, and the build the host names is the stamp's.
  const stamp = facts.web.stamp
  // What has never been published: a copy from before copies were stamped, a target the release has never held.
  const never = []
  if (!stamp) {
    behind.web.push('the web copy has no build.json, so it was published before copies were stamped with their commit (or not by web.yml)')
    never.push(...behind.web)
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
  let held = false
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
      if (!best && !t) never.push(said)
    }
    // A publish moves the tag first, then replaces each file under its own name (the old one deleted, the new one
    // uploaded), and writes the record last (staged for the seconds that takes). So while a current run has not
    // ended, or a staged record is there, the tag, the files and the record disagree by design: behind, and mended
    // when that publish ends. With no publish under way they must agree, and a file that is not the one the record
    // names is broken, not behind.
    const midway = rel.staged || publishing
    const broken = midway ? behind.current : problems
    if (s.commit && rel.tag !== s.commit) {
      // The one state a finished publish leaves on purpose: GitHub refused to move the tag, the files went up all
      // the same, and the record says where the tag stayed. Noted; the next publish tries again.
      if (!midway && s.tagAt && s.tagAt === rel.tag) warnings.push(`the tag ${TAG} is at ${short(rel.tag)}, where the last publish left it: GitHub refused to move it to ${short(s.commit)} (as it is reported to when a later commit on main changed a workflow file), and the next publish tries again`)
      else behind.current.push(`the tag ${TAG} is at ${short(rel.tag)}, and the release's record says ${short(s.commit)}`)
    }
    rows.push([`tag ${TAG}`, rel.tag ?? '', rel.tag && rel.tag === G ? 'same commit' : 'another commit'])
    if (!rel.staged) {
      const have = new Map(rel.assets.map((a) => [a.name, a]))
      for (const id of IDS) for (const f of s.targets[id]?.files ?? []) {
        const a = have.get(f.name)
        if (!a) broken.push(`${f.name} (${id}) is in the release's record and not on the release`)
        else if (a.size !== f.size || (a.digest && a.digest !== `sha256:${f.sha256}`)) broken.push(`${f.name} (${id}) on the release is not the file its record names (size or SHA-256 differs)`)
      }
    }
    // The disk images say their commit themselves: the GUID in the image is the recorded commit's.
    for (const [id, { file, arch }] of Object.entries(MEDIA)) {
      const t = s.targets[id]
      if (!t) continue
      const guid = facts.media?.[id]
      if (!guid) warnings.push(`${file}: its disk GUID could not be read, so the image was not asked which commit it is`)
      else if (guid !== mediaGuid(t.commit, arch)) broken.push(`${file} carries the disk GUID ${guid}, which is not the one ${short(t.commit)} bakes (${mediaGuid(t.commit, arch)}): the image is not the commit its record names`)
    }
    // A run by hand builds nothing when the release already holds the commit for every required target (pick), so
    // what is still behind then (the tag moved by hand, say) needs the run's "force".
    const required = IDS.filter((id) => !BEST_EFFORT.includes(id))
    held = !rel.staged && s.commit === G && required.every((id) => s.targets[id]?.commit === G)
  }

  // What can still mend "behind": ci passed moments ago, a publisher that has not ended, a publish minutes old. Both
  // publishers build the newest commit ci passed on (current.mjs pick and web-pick), so ci still running on a newer
  // commit mends nothing here: that commit is not green yet, and the one that is should be up. "Moments ago"
  // covers the time a publisher takes to begin, so it ends for a publisher once a run of it begun since ci passed
  // has ended: that run was its answer (a run skipped whole was for another ci run, one that did not pass), and a
  // look started by that very run's end must not read "on its way" where nothing is.
  const answered = (workflow) => (facts.ended ?? []).some((r) => r.workflow === workflow && r.conclusion !== 'skipped' && minutes(r.created, facts.green.at) > -1)
  const fresh = (workflow) => Boolean(facts.green.at) && age(facts.green.at) < grace.start && !answered(workflow)
  const waiting = []
  const settle = (list, why) => { for (const p of list) waiting.push(`${p} (${why})`) }
  // What has never been published cannot come from publishing the green commit again when that commit is the one
  // without it (a new target is in the tool before it is in any commit ci passed on): it arrives with the first
  // publish of a commit that has it. So while ci is still running on a newer commit, that much is on its way, and a
  // run by hand, which would build the green commit, is not the advice. Anything else behind is judged as ever.
  const newer = running('ci', grace.ci, (r) => r.sha !== G)
  const blame = (list, mend) => {
    for (const p of list) {
      if (newer && never.includes(p)) waiting.push(`${p} (never published yet, and ci is still running on ${short(newer.sha)}: it arrives with the first publish of a commit that has it)`)
      else problems.push(`${p}: ${mend}`)
    }
  }
  if (behind.web.length) {
    const web = running('web', grace.web)
    if (fresh('web')) settle(behind.web, `ci passed ${Math.max(0, Math.round(age(facts.green.at)))} min ago`)
    else if (web) settle(behind.web, 'a web run has not ended')
    else if (facts.served && age(facts.served) < grace.served) settle(behind.web, `a web run published ${Math.max(0, Math.round(age(facts.served)))} min ago, and the host may serve the copy before for ten`)
    // A run by hand publishes the newest commit ci passed on, which is the one named here (leave "tip" unticked).
    else blame(behind.web, 'Actions > web > Run workflow, on main')
  }
  if (behind.current.length) {
    const mend = `Actions > current > Run workflow, on main${held ? ', with "force" ticked (the release already holds that commit, so a run without it builds nothing)' : ''}`
    if (publishing) settle(behind.current, 'a current run has not ended')
    else if (fresh('current')) settle(behind.current, `ci passed ${Math.max(0, Math.round(age(facts.green.at)))} min ago`)
    else blame(behind.current, mend)
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

/** A pause that holds the thread, as `gh` does (it is run with spawnSync). */
function pause(ms) { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/**
 * `gh`, with a call that got no answer (a lost connection, a 5xx from GitHub) made again, three times in all, a
 * little longer apart each time. An answer GitHub gave (HTTP 4xx: no such release, no such tag) is final.
 */
export function patient(gh, { wait = 5000 } = {}) {
  return (argv) => {
    let r = gh(argv)
    for (let i = 1; i < 3 && !r.ok && !/HTTP 4\d\d/.test(r.err); i++) {
      pause(wait * i)
      r = gh(argv)
    }
    return r
  }
}

function runsOf(gh, repo, file) {
  const r = gh(['api', `repos/${repo}/actions/workflows/${file}/runs?per_page=30`])
  if (!r.ok) throw new Error(`gh api actions/workflows/${file}/runs: ${r.err.trim() || 'failed'}`)
  return JSON.parse(r.out).workflow_runs ?? []
}

/**
 * Whether a web run published: its `deploy` job passed and the step that hands the copy to GitHub Pages
 * (actions/deploy-pages, which GitHub names "Run actions/deploy-pages@v4") ran and passed in it. A web run also ends
 * green having published nothing: its pick found main had moved on (the jobs after it are skipped), or its deploy job
 * found that at the last moment (the job passes, the step is skipped).
 */
function published(gh, repo, run) {
  const r = gh(['api', `repos/${repo}/actions/runs/${run.id}/jobs?per_page=30`])
  if (!r.ok) throw new Error(`gh api actions/runs/${run.id}/jobs: ${r.err.trim() || 'failed'}`)
  const deploy = (JSON.parse(r.out).jobs ?? []).find((j) => j.name === 'deploy')
  return deploy?.conclusion === 'success' && (deploy.steps ?? []).some((step) => /actions\/deploy-pages@/.test(step.name ?? '') && step.conclusion === 'success')
}

/** Everything `verdict` judges, read now. No source's failure stops the others: each is recorded where it belongs. */
export async function gather({ repo, site = siteOf(repo), now = new Date().toISOString(), wait = 5000 }, once, get) {
  const gh = patient(once, { wait })
  const facts = { now, runs: [], ended: [], served: null, media: {} }
  try {
    facts.tip = mainTip(gh, repo, { wait })
    facts.green = choose({ repo, wait }, gh, facts.tip).green
  } catch (e) { facts.green = { error: e.message } }
  facts.web = await readWeb(site, get, now)
  try {
    const release = getRelease(gh, repo, { wait })
    if (!release) facts.release = null
    else {
      facts.release = {
        state: readState(gh, repo, release, { wait }),
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
  // The runs on main alone (a pull request's dry run of current.yml publishes nothing): those that have not ended,
  // and the newest of each publisher that have (whether a run begun since ci passed has already given its answer).
  try {
    for (const [workflow, file] of [['web', 'web.yml'], ['current', 'current.yml'], ['ci', 'ci.yml']]) {
      const runs = runsOf(gh, repo, file).filter((r) => r.head_branch === 'main' && r.event !== 'pull_request')
      const begun = (r) => r.run_started_at ?? r.created_at
      for (const r of runs) if (r.status !== 'completed') facts.runs.push({ workflow, created: begun(r), sha: r.head_sha })
      if (workflow !== 'ci') for (const r of runs.filter((x) => x.status === 'completed').slice(0, 10)) facts.ended.push({ workflow, created: begun(r), conclusion: r.conclusion ?? '' })
      // When the web copy was last published: the newest web run of the last hour that passed and did publish (a
      // publish older than that is served everywhere by now, so its jobs are not read).
      if (workflow === 'web') {
        const lately = runs.filter((r) => r.status === 'completed' && r.conclusion === 'success' && minutes(now, r.updated_at) < 60).slice(0, 3)
        facts.served = lately.find((r) => published(gh, repo, r))?.updated_at ?? null
      }
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
