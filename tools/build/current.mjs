#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It keeps the downloads current with main. `.github/workflows/current.yml` builds every
 * target of tools/build/matrix.mjs from a commit on main that ci passed (the Windows x64 app through windows-app.yml,
 * the other eight through build-matrix.yml), then this script puts the files on one GitHub pre-release, tag `current`,
 * titled "Crimson Noir: Agent City, current build", whose files are replaced the same way after each later green run.
 * It never makes a numbered release (those stay build-release.yml's); its only tags are `current` and, for a few
 * seconds when GitHub refuses to move `current`, the stand-in `current-next`.
 * - `pick --sha <commit> [--force] [--strict]`: which commit to build, given the one that started the run. It prints
 *   `sha=<commit>` and `ci=<the ci run that passed on it>` (for $GITHUB_OUTPUT) for the newest commit on main that ci
 *   passed on there (a push or a run by hand, never a pull request's run), so a run that took a waiting run's place
 *   still builds the newest green commit; nothing on stdout, and why on stderr, when the given commit is not on main,
 *   no commit on main passed ci, the release already holds a newer one, or it holds that one for every target
 *   and that publish finished (`--force` builds it again). When GitHub cannot say whether a commit is on main, it
 *   exits 1 rather than pass the commit over. `--strict` exits 1 when refused (not on main, nothing green), for a
 *   run by hand.
 * - `publish --media <dir> --sha <commit> [--source <dir>] [--ci <url>] [--run <url>] [--stage <dir>]
 *   [--summary <file>] [--dry-run] [--reused-pick]`:
 *   <dir> holds the run's artifacts, one folder each (`matrix-<id>`, and `windows-installer-*`, `windows-msi-*`,
 *   `windows-portable-*` for windows-x64, which counts as built only with all three); a target whose artifact is
 *   missing failed its job, whose uploads come after its gates (a UEFI job's bake twice and QEMU boot). It asks again
 *   that the commit is on main and not older than the release's (and stops, writing nothing, when it cannot read the
 *   release's record or GitHub cannot compare the two), then puts the tag at the commit before any file is written,
 *   uploads each new or changed file, writes current.json (which commit, run and time made each target's files: first
 *   as current.next.json, deleted once current.json holds it, so the release always has one of the two), SHA256SUMS
 *   (every built file), deletes the files no target names any more and rewrites the notes. A target that failed keeps
 *   the files of the last commit it built while the release still holds them byte for byte, and the notes say so; the
 *   exit is then 1, except for the iOS build (best effort, as in build-matrix.yml). `--reused-pick` (a re-run of the
 *   failed jobs, which keeps an earlier attempt's pick) exits 1 unless the release then holds the newest green commit
 *   on main, or GitHub says it holds a newer one. `--stage` is the folder the files are copied into, named as GitHub
 *   keeps them, before they go up (a fresh temporary folder, removed afterwards, when not given).
 *   `--source` is a checkout of the built commit: its package.json gives the version the notes name, and
 *   crimson_noir_os/'s containment.nix, containment.lock, NOTICE.txt and LICENSE go with the x86-64 media, as
 *   build-release.yml publishes them. `--dry-run` reads the release, prints the plan and the notes, and writes nothing
 *   (a pull request's run of the workflow).
 * - The tag. GitHub is reported (not yet seen here) to let the workflow's own token move a tag only when no workflow
 *   file differs between where it was and where it goes, and to let it make a tag at a commit whose workflow files
 *   match main's tip. So when a move is refused, the release is set on a stand-in tag, `current-next`, at the commit,
 *   `current` is made again there, the release goes back onto it and the stand-in is deleted: the release is never on
 *   a tag being deleted (that would turn it into a draft, and publishing it again would notify everyone watching), and
 *   for those few seconds its download addresses answer 404. A run that stops halfway leaves the release on
 *   `current-next`; the next run sets it back on `current` (an existing `current` is not deleted for this; it is made
 *   only if the stopped run had already deleted it, which GitHub allows once the commit has main's tip's workflow
 *   files), then moves the tag as usual. When GitHub refuses the stand-in as well (a later commit on main changed a workflow), the tag stays where
 *   it was, the files are still published, and the notes and current.json say where the tag is; the next publish
 *   tries again.
 * GitHub is reached only through the `gh` command line (GH_TOKEN, GH_REPO), run with argument vectors, never a shell.
 * What breaks if it is removed? The workflow has nothing to publish with, and the downloads wait for the next
 * numbered release; the web copy still follows main (web.yml).
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IDS } from './matrix.mjs'

export const TAG = 'current'
/** The tag the release stands on for the seconds `current` is made again; see the header. */
export const NEXT = 'current-next'
export const TITLE = 'Crimson Noir: Agent City, current build'
export const STATE = 'current.json'
/** current.json's next version, uploaded before it is replaced: `gh release upload --clobber` deletes the old file before
 * it uploads the new one, so a run that stops there would otherwise leave the release with no record at all. */
export const STAGED = 'current.next.json'
export const SUMS = 'SHA256SUMS'
/** The targets whose failure never turns the run red: the iOS build, as build-matrix.yml's `bestEffort` says. */
export const BEST_EFFORT = Object.freeze(['ios-ipa'])
/** Each target's name in the notes, in matrix.mjs's order. */
export const LABELS = Object.freeze({
  'windows-x64': 'Windows x64',
  'windows-arm64': 'Windows on Arm (arm64)',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux arm64',
  'macos-universal': 'macOS (Apple silicon and Intel)',
  'android-apk': 'Android (arm64)',
  'ios-ipa': 'iOS (arm64, unsigned)',
  'uefi-x64': 'Crimson Noir OS, UEFI x86-64',
  'uefi-arm64': 'Crimson Noir OS, UEFI aarch64',
})
/** The files build-release.yml puts beside the x86-64 media: the configuration they were built with and its notices. */
export const NOTICES = Object.freeze(['containment.nix', 'containment.lock', 'NOTICE.txt', 'LICENSE'])
/** The three Windows x64 artifacts windows-app.yml leaves; the target is built only when all three are there. */
const WINDOWS_PARTS = Object.freeze(['installer', 'msi', 'portable'])
const SHA = /^[0-9a-f]{40}$/

/**
 * The name GitHub keeps for an uploaded file. GitHub renames an asset whose name has a space or another special
 * character (each becomes a period) and drops leading and trailing periods; every Tauri bundle's name carries the
 * product's, spaces and all. Naming the file this way before the upload makes the name on the release the one this
 * script records, links and lists in SHA256SUMS.
 */
export function assetName(name) {
  const safe = String(name).replace(/[^A-Za-z0-9._-]/g, '.').replace(/^\.+|\.+$/g, '')
  if (!safe) throw new Error(`no usable file name in ${JSON.stringify(name)}`)
  return safe
}

/** Which target an artifact of the run belongs to, and which part of it: null for a report or anything else. */
export function targetOf(artifact) {
  if (artifact.startsWith('matrix-report-')) return null
  if (artifact.startsWith('matrix-')) {
    const id = artifact.slice('matrix-'.length)
    return IDS.includes(id) ? { id, part: 'all' } : null
  }
  const w = /^windows-(installer|msi|portable)-./.exec(artifact)
  return w ? { id: 'windows-x64', part: w[1] } : null
}

function walkFiles(dir) {
  const out = []
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) out.push(...walkFiles(p))
    else out.push(p)
  }
  return out
}

/** A file's SHA-256, read a megabyte at a time (the media and the AppImages run to tens of megabytes). */
export function sha256File(path) {
  const h = createHash('sha256')
  const fd = openSync(path, 'r')
  try {
    const buf = Buffer.alloc(1 << 20)
    for (let n; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n))
  } finally { closeSync(fd) }
  return h.digest('hex')
}

/**
 * The targets the run built, from its artifacts in `media` (one folder each, as actions/download-artifact leaves
 * them): each file copied into `stage` under the name GitHub will keep, with its SHA-256 and size. Two files with one
 * name, or a file named like SHA256SUMS or current.json, is an error: one would overwrite the other on the release.
 */
export function collect({ media, stage, source }) {
  const found = new Map()
  if (existsSync(media)) {
    for (const artifact of readdirSync(media).sort()) {
      const dir = join(media, artifact)
      const t = statSync(dir).isDirectory() ? targetOf(artifact) : null
      if (!t) continue
      const entry = found.get(t.id) ?? { parts: new Set(), files: [] }
      entry.parts.add(t.part)
      for (const p of walkFiles(dir)) entry.files.push({ from: p, name: assetName(basename(p)) })
      found.set(t.id, entry)
    }
  }
  mkdirSync(stage, { recursive: true })
  const owner = new Map([[SUMS, 'this script'], [STATE, 'this script'], [STAGED, 'this script']])
  const built = {}
  for (const id of IDS) {
    const e = found.get(id)
    if (!e || e.files.length === 0) continue
    if (!e.parts.has('all') && !(id === 'windows-x64' && WINDOWS_PARTS.every((p) => e.parts.has(p)))) continue
    if (id === 'uefi-x64' && source) {
      for (const n of NOTICES) {
        const from = join(source, 'crimson_noir_os', n)
        if (!existsSync(from)) throw new Error(`the x86-64 media's ${n} is missing from the built commit (${from})`)
        e.files.push({ from, name: n })
      }
    }
    const files = []
    for (const f of e.files) {
      if (owner.has(f.name)) throw new Error(`two files would be ${f.name} on the release: one from ${owner.get(f.name)}, one from ${id}`)
      owner.set(f.name, id)
      const to = join(stage, f.name)
      copyFileSync(f.from, to)
      files.push({ name: f.name, path: to, sha256: sha256File(to), size: statSync(to).size })
    }
    built[id] = files.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
  return built
}

/** A release's current.json as this script wrote it, or an empty one for anything else (a first run, a file edited by hand). */
export function readStateText(text) {
  let s
  try { s = JSON.parse(text) } catch { return { targets: {} } }
  if (!s || typeof s !== 'object' || s.schema !== 1 || typeof s.targets !== 'object' || s.targets === null) return { targets: {} }
  const targets = {}
  for (const id of IDS) {
    const t = s.targets[id]
    const fileOk = (f) => f && typeof f.name === 'string' && /^[0-9a-f]{64}$/.test(f.sha256) && Number.isInteger(f.size)
    if (t && SHA.test(t.commit) && Array.isArray(t.files) && t.files.length > 0 && t.files.every(fileOk)) targets[id] = t
  }
  return { ...s, commit: SHA.test(s.commit) ? s.commit : undefined, targets }
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)

/**
 * What a publish does, worked out before anything is written: the new current.json (each target built now at this
 * commit; each that failed keeps its last files, as long as the release still holds them byte for byte), the files to
 * upload (new, or not the bytes the release has under that name), the files to delete (named by no target any more),
 * SHA256SUMS, the targets missing, the missing ones that turn the run red, and the notes. `tagAt` is the commit the
 * tag is at when it could not be moved to `sha` (see the header).
 */
export function plan({ state, built, sha, run = '', ci = '', time, version = 'unknown', repo, assets = null, tagAt = sha }) {
  const prev = state ?? { targets: {} }
  const have = assets ? new Map(assets.map((a) => [a.name, a])) : null
  // A file is still on the release as recorded: its size, and its SHA-256 where GitHub gives the asset's digest. The
  // UEFI media keep one size from commit to commit (a fixed 36 MiB disk) while their bytes change, so size alone is
  // not enough; an earlier publish that stopped halfway can have replaced a file under the same name.
  const same = (f) => {
    const a = have?.get(f.name)
    return Boolean(a) && a.size === f.size && (!a.digest || a.digest === `sha256:${f.sha256}`)
  }
  const targets = {}
  const dropped = []
  for (const id of IDS) {
    if (built[id]) {
      targets[id] = { commit: sha, run, time, files: built[id].map(({ name, sha256, size }) => ({ name, sha256, size })) }
    } else if (prev.targets?.[id]) {
      const t = prev.targets[id]
      if (!have || t.files.every(same)) targets[id] = t
      else dropped.push(id)
    }
  }
  const files = IDS.flatMap((id) => targets[id]?.files ?? [])
  const seen = new Map()
  for (const id of IDS) for (const f of targets[id]?.files ?? []) {
    if (seen.has(f.name)) throw new Error(`two targets name ${f.name}: ${seen.get(f.name)} and ${id}`)
    seen.set(f.name, id)
  }
  const uploads = IDS.flatMap((id) => built[id] ?? []).filter((f) => {
    const a = have?.get(f.name)
    return !(a && a.size === f.size && a.digest === `sha256:${f.sha256}`)
  })
  const keep = new Set([...files.map((f) => f.name), SUMS, STATE, STAGED])
  const deletes = have ? [...have.keys()].filter((n) => !keep.has(n)).sort() : []
  const missing = IDS.filter((id) => !built[id])
  const failed = missing.filter((id) => !BEST_EFFORT.includes(id))
  const sums = [...files].sort(byName).map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n'
  const next = { schema: 1, tag: TAG, tagAt, commit: sha, time, run, ci, version, targets }
  return { state: next, uploads, deletes, sums, missing, failed, dropped, notes: notes(next, { repo, missing }) }
}

const mib = (n) => `${(n / 2 ** 20).toFixed(1)} MiB`
const when = (iso) => (iso ? iso.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC') : 'unknown')

/** The release's notes, from the new current.json alone. */
export function notes(state, { repo, missing = [] }) {
  const url = `https://github.com/${repo}`
  const [owner, name] = String(repo).split('/')
  const web = `https://${owner}.github.io/${name}/`
  const short = (c) => c.slice(0, 7)
  const commit = (c) => `[\`${short(c)}\`](${url}/commit/${c})`
  const dl = (n) => `${url}/releases/download/${TAG}/${encodeURIComponent(n)}`
  const rows = IDS.map((id) => {
    const t = state.targets[id]
    const effort = BEST_EFFORT.includes(id) ? ' (best effort)' : ''
    if (!t) return `| ${LABELS[id]} | no files yet | its build failed at ${commit(state.commit)}${effort} |`
    const files = t.files.map((f) => `[\`${f.name}\`](${dl(f.name)}) ${mib(f.size)}`).join('<br>')
    const from = t.commit === state.commit ? commit(t.commit)
      : `${commit(t.commit)}, ${when(t.time)}: its build failed at ${commit(state.commit)}${effort}, so these are its last good files`
    return `| ${LABELS[id]} | ${files} | ${from} |`
  })
  const ci = state.ci ? `[ci](${state.ci})` : 'ci'
  return [
    '<!-- tools/build/current.mjs: written on every publish; an edit here is replaced by the next one -->',
    `The current build of Crimson Noir: Agent City and Crimson Noir OS. Every file here was built from a commit on \`main\` that ${ci} passed on, and is replaced the same way after each later green run, as the [web copy](${web}) is. This is a pre-release: the latest numbered release is unchanged, and numbered releases are still cut by hand.`,
    '',
    `**Commit** ${commit(state.commit)} on main, published ${when(state.time)}${state.run ? ` by [this run](${state.run})` : ''}.${missing.length ? ` Not built at this commit: ${missing.map((id) => LABELS[id]).join(', ')}.` : ''}`,
    ...(state.tagAt && state.tagAt !== state.commit
      ? ['', `**The tag \`${TAG}\` is still at ${commit(state.tagAt)}**, and so are the source code archives GitHub adds below: GitHub refused to move it to ${commit(state.commit)}, as it is reported to when a later commit on main changed a workflow file. The files in the table are from the commits beside them; the next publish tries again.`]
      : []),
    '',
    '| Platform | Files | Built from |',
    '| :--- | :--- | :--- |',
    ...rows,
    '',
    `- **Checked before publishing.** ci passed on the commit: the page's type check, lint, tests and single-file build, the city in Chrome on a software WebGPU adapter, the Rust workspace on CPU and a software GPU, the SMT theorems, the IR call graph, the WebAssembly air gap and the Kani harnesses. Each UEFI image was then baked a second time from a clean build and compared byte for byte, and booted in QEMU (x86-64 on OVMF, aarch64 on edk2) through the self-test, the tutorial and the terminal's scripted run to power-off, and each ISO to its self-test. No physical machine is part of these checks.`,
    '- **Run on a device so far:** the Windows x64 app. The other apps are built and not yet run on a device; the iPhone can play the web copy instead.',
    "- **Nothing is signed.** Windows SmartScreen asks once (\"More info\", then \"Run anyway\"); the macOS app opens with right-click › Open the first time; the `.apk` carries the Android debug key; the `.ipa` must be re-signed before a device takes it. The OS images run on a UEFI machine with Secure Boot off.",
    `- **Versions.** The apps' file names carry the version in \`package.json\` at the commit they were built from (\`${state.version}\` at this one), the \`.rpm\` with its pre-release part as its release number; the zipped macOS \`.app\`, the UEFI files and images, and the notices beside them carry none. The commit above, and each file's row, tell one current build from the next.`,
    `- **Checking a download.** \`sha256sum --check --ignore-missing ${SUMS}\` in the folder you downloaded into; \`${SUMS}\` lists every file here but itself and \`${STATE}\`, which records which commit, run and time made each.`,
    `- **A link that stays current.** \`${url}/releases/download/${TAG}/<file>\` gives the newest file of that name (but for the few seconds after a workflow change while the tag is made again).`,
    `- **On NixOS.** \`nix run github:${repo}\` builds main's tip from source in Nix's sandbox.`,
    '',
  ].join('\n')
}

// ---------------------------------------------------------------------------------------------------------------
// GitHub, through `gh`. Every function takes `gh(argv) -> { ok, out, err }`, so a test can stand in for GitHub.

/** The real `gh`, with an argument vector (never a shell). */
export function realGh(argv) {
  const r = spawnSync('gh', argv, { encoding: 'utf8', maxBuffer: 64 * 2 ** 20 })
  if (r.error) return { ok: false, out: '', err: r.error.message }
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

const notFound = (r) => !r.ok && /HTTP 404|Not Found/i.test(r.err)

function api(gh, path, ...rest) {
  const r = gh(['api', ...rest, path])
  if (!r.ok) throw new Error(`gh api ${path}: ${r.err.trim() || 'failed'}`)
  return r.out
}

export function mainTip(gh, repo) {
  const sha = JSON.parse(api(gh, `repos/${repo}/git/ref/heads/main`)).object?.sha
  if (!SHA.test(sha ?? '')) throw new Error(`main's tip is not a commit: ${sha}`)
  return sha
}

function compared(gh, repo, base, head, wait) {
  const r = attempt(gh, ['api', `repos/${repo}/compare/${base}...${head}?per_page=1`], `compare ${base} with ${head}`, wait)
  let status = null
  if (r.ok) { try { status = JSON.parse(r.out).status ?? null } catch { status = null } }
  return { r, status }
}

/**
 * GitHub's comparison of two commits: `ahead` (head is newer), `behind`, `identical`, `diverged`, or null when it
 * cannot say (tried again over a lost connection first).
 */
export function compare(gh, repo, base, head, { wait = 5000 } = {}) {
  return compared(gh, repo, base, head, wait).status
}

/**
 * Whether `sha` is main's tip or behind it on main's own history. A commit GitHub does not know is not; when GitHub
 * cannot answer, this throws rather than guess, so neither pick nor publish passes over a commit for want of an answer.
 */
export function onMain(gh, repo, sha, tip = mainTip(gh, repo), { wait = 5000 } = {}) {
  if (sha === tip) return true
  const { r, status } = compared(gh, repo, sha, tip, wait)
  if (notFound(r)) return false
  if (status === null) throw new Error(`GitHub could not compare ${sha} with main's tip ${tip} (${r.err.trim() || 'no answer'}), so whether it is on main is unknown`)
  return status === 'ahead'
}

/**
 * The newest commit on main that ci passed on there (a push, or ci run by hand, in this repository), with that run's
 * address, or null. GitHub lists runs newest first; a commit is taken only while it is still on main's history.
 */
export function newestGreen(gh, repo, tip = mainTip(gh, repo), { wait = 5000 } = {}) {
  const runs = JSON.parse(api(gh, `repos/${repo}/actions/workflows/ci.yml/runs?branch=main&status=success&per_page=50`)).workflow_runs ?? []
  const seen = new Set()
  for (const r of runs) {
    if (!(SHA.test(r.head_sha ?? '') && r.conclusion === 'success' && r.head_branch === 'main' && (r.event === 'push' || r.event === 'workflow_dispatch') && r.head_repository?.full_name === repo)) continue
    if (seen.has(r.head_sha)) continue
    seen.add(r.head_sha)
    if (onMain(gh, repo, r.head_sha, tip, { wait })) return { sha: r.head_sha, ci: r.html_url }
  }
  return null
}

/**
 * The `current` release (its id, the tag it stands on, its notes, its assets with name, size, digest and id), or null
 * when there is none. A release still on the stand-in tag (a run stopped halfway through remaking `current`) is found too.
 */
export function getRelease(gh, repo) {
  for (const tag of [TAG, NEXT]) {
    const r = gh(['api', `repos/${repo}/releases/tags/${tag}`])
    if (notFound(r)) continue
    if (!r.ok) throw new Error(`gh api releases/tags/${tag}: ${r.err.trim()}`)
    const rel = JSON.parse(r.out)
    return { id: rel.id, tag: rel.tag_name ?? tag, notes: rel.body ?? '', assets: (rel.assets ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size, digest: a.digest ?? null })) }
  }
  return null
}

/**
 * The release's record of what it holds: current.next.json when a run stopped between uploading it and deleting it (it
 * is then the newer), else current.json; an empty one for a release with no files yet, or a record that does not
 * parse. It throws when the record cannot be downloaded, or when the release holds files and no record: publishing as
 * if there were none would delete a failed target's last files and lose the check against stepping back.
 */
export function readState(gh, repo, release, { wait = 5000 } = {}) {
  const asset = release?.assets.find((a) => a.name === STAGED) ?? release?.assets.find((a) => a.name === STATE)
  if (!asset) {
    if (release?.assets.length) throw new Error(`the release holds files but neither ${STATE} nor ${STAGED}, so which commit made them is unknown: nothing was published (delete the release's files by hand, then run the workflow by hand on main)`)
    return { targets: {} }
  }
  const r = retry(gh, ['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`], `read the release's ${asset.name} (nothing was published)`, { wait })
  return readStateText(r.out)
}

/**
 * Whether the release holds exactly what its record says, finished: on the tag `current`, every recorded file there
 * with its size and digest, nothing else but SHA256SUMS and current.json, no staged record left, and the notes naming
 * the commit. A run that stopped after writing the record fails this, so pick builds the commit again.
 */
export function holds(release, state) {
  if (!release || release.tag !== TAG || !state.commit) return false
  const files = IDS.flatMap((id) => state.targets[id]?.files ?? [])
  const have = new Map(release.assets.map((a) => [a.name, a]))
  const same = (f) => { const a = have.get(f.name); return Boolean(a) && a.size === f.size && (!a.digest || a.digest === `sha256:${f.sha256}`) }
  const wanted = new Set([...files.map((f) => f.name), SUMS, STATE])
  return files.every(same) && have.has(SUMS) && have.has(STATE) && [...have.keys()].every((n) => wanted.has(n)) && (release.notes ?? '').includes(state.commit)
}

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }

/** One gh step, tried `tries` times (an upload over a flaky connection), throwing with the last error. */
function retry(gh, argv, what, { tries = 3, wait = 15000 } = {}) {
  let r
  for (let i = 1; i <= tries; i++) {
    r = gh(argv)
    if (r.ok) return r
    if (i < tries) { console.error(`${what} failed (${r.err.trim()}); trying again (${i}/${tries - 1})`); pause(wait) }
  }
  throw new Error(`${what}: ${r.err.trim() || 'failed'}`)
}

/** GitHub's answer, not a lost connection: a 4xx is not tried again. */
const answered = (r) => /HTTP 4\d\d/.test(r.err)
/**
 * GitHub refused the workflow's token this tag (its message for a workflow file it may not touch, or a plain 403), as
 * opposed to a missing or existing ref, a rate limit or a lost connection, which are not taken as a refusal.
 */
const refused = (r) => !r.ok && !/rate limit/i.test(r.err) && (/not accessible by integration|workflows?` permission|without `?workflows/i.test(r.err) || /HTTP 403/.test(r.err))

/** A ref step, tried again over a lost connection but not after GitHub answered; the result, never a throw. */
function attempt(gh, argv, what, wait) {
  let r
  for (let i = 1; i <= 3; i++) {
    r = gh(argv)
    if (r.ok || answered(r)) return r
    if (i < 3) { console.error(`${what} failed (${r.err.trim()}); trying again (${i}/2)`); pause(wait) }
  }
  return r
}

/** Where a tag points, or null when there is no such tag. */
export function tagAt(gh, repo, name) {
  const r = gh(['api', `repos/${repo}/git/ref/tags/${name}`])
  if (notFound(r)) return null
  if (!r.ok) throw new Error(`gh api git/ref/tags/${name}: ${r.err.trim()}`)
  return JSON.parse(r.out).object?.sha ?? null
}

/**
 * The tag `current` at `sha` before any file is written; see the header. Returns { at, how }: `at` the commit the
 * tag is at afterwards, `how` one of made, kept, moved, remade (through the stand-in) or refused (it stays at `at`).
 * Throws, with the release where the next run can finish, when GitHub fails partway (not when it refuses).
 */
export function placeTag(gh, repo, sha, release, { log = console.log, wait = 15000 } = {}) {
  const ref = (name) => `repos/${repo}/git/refs/tags/${name}`
  // A make whose try landed though its answer was lost comes back "already exists" on the next try: only then is the
  // tag read, and taken as made when it is at the commit. A tag that was there before this call is never taken for
  // GitHub's leave to make one now.
  const make = (name, at) => {
    let r
    let lost = false
    for (let i = 1; i <= 3; i++) {
      r = gh(['api', '-X', 'POST', '-f', `ref=refs/tags/${name}`, '-f', `sha=${at}`, `repos/${repo}/git/refs`])
      if (r.ok) return r
      if (answered(r)) return lost && /already exists/i.test(r.err) && tagAt(gh, repo, name) === at ? { ...r, ok: true } : r
      lost = true
      if (i < 3) { console.error(`make the tag ${name} failed (${r.err.trim()}); trying again (${i}/2)`); pause(wait) }
    }
    return r
  }
  // Gone counts as deleted only when GitHub says the tag does not exist and a read agrees; any other answer (a rule
  // that forbids deleting tags, say) throws before anything else is changed.
  const drop = (name) => {
    const r = attempt(gh, ['api', '-X', 'DELETE', ref(name)], `delete the tag ${name}`, wait)
    if (r.ok || ((notFound(r) || /Reference does not exist/i.test(r.err)) && tagAt(gh, repo, name) === null)) return
    throw new Error(`delete the tag ${name}: ${r.err.trim() || 'failed'}`)
  }
  // A stand-in left by an earlier run (its deletion failed) goes whenever the release is on `current`.
  const tidy = () => {
    try { if (tagAt(gh, repo, NEXT) !== null) drop(NEXT) } catch (e) { log(`::warning::${e.message}; the next run tries again`) }
  }
  const stand = (name) => retry(gh, ['api', '-X', 'PATCH', '-f', `tag_name=${name}`, '-f', 'make_latest=false', `repos/${repo}/releases/${release.id}`], `set the release on the tag ${name}`, { wait })
  const must = (r, what) => { if (!r.ok) throw new Error(`${what}: ${r.err.trim() || 'failed'}`); return r }

  // A run stopped halfway: the release is on the stand-in. An existing `current` is never deleted here, since GitHub
  // might refuse to make it again; a missing one is made, at this commit or where the stand-in is. The release goes
  // back onto it, and the usual steps below move the tag if it is not at this commit yet.
  if (release?.tag === NEXT) {
    let made = null
    if (tagAt(gh, repo, TAG) === null) {
      const was = tagAt(gh, repo, NEXT)
      for (const want of [sha, was]) {
        if (!want || made) continue
        const r = make(TAG, want)
        if (r.ok) made = want
        else if (!refused(r)) throw new Error(`make the tag ${TAG} at ${want} (the release is on ${NEXT}; the next run tries again): ${r.err.trim() || 'failed'}`)
      }
      if (!made) throw new Error(`the release is on the tag ${NEXT}, and GitHub refused to make ${TAG} again at ${sha}${was && was !== sha ? ` or ${was}` : ''}: a run can once main's tip passes ci, so the next publish (or a run by hand on main then) finishes this`)
    }
    stand(TAG)
    release.tag = TAG
    log(`tag ${TAG}: the release is back on it, after an earlier run stopped halfway`)
    if (made === sha) { tidy(); return { at: sha, how: 'remade' } }
  }
  if (release) tidy()

  const at = tagAt(gh, repo, TAG)
  if (at === sha) return { at, how: 'kept' }
  if (at === null) {
    must(make(TAG, sha), `make the tag ${TAG} at ${sha}`)
    return { at: sha, how: 'made' }
  }
  const moved = attempt(gh, ['api', '-X', 'PATCH', '-f', `sha=${sha}`, '-F', 'force=true', ref(TAG)], `move the tag ${TAG}`, wait)
  if (moved.ok) return { at: sha, how: 'moved' }
  if (!refused(moved)) throw new Error(`move the tag ${TAG} to ${sha}: ${moved.err.trim() || 'failed'}`)
  log(`tag ${TAG}: GitHub refused to move it from ${at} (${moved.err.trim()}); making it again at ${sha}`)

  // No release yet: nothing stands on the tag, so it is simply made again.
  if (!release) {
    drop(TAG)
    must(make(TAG, sha), `make the tag ${TAG} at ${sha}`)
    return { at: sha, how: 'remade' }
  }

  // The swap through the stand-in. If GitHub refuses the stand-in, nothing has changed and the tag stays. A stand-in
  // still there (tidy only warns) is deleted first, and if that fails the run stops here, with nothing changed.
  if (tagAt(gh, repo, NEXT) !== null) drop(NEXT)
  const next = make(NEXT, sha)
  if (!next.ok) {
    if (!refused(next)) throw new Error(`make the tag ${NEXT} at ${sha}: ${next.err.trim() || 'failed'}`)
    log(`::warning::GitHub refused a tag at ${sha} as well (${next.err.trim()}): the tag ${TAG} stays at ${at}, and the files are published all the same`)
    return { at, how: 'refused' }
  }
  stand(NEXT)
  release.tag = NEXT
  try { drop(TAG) } catch (e) {
    // When current is still there (a rule that forbids deleting tags, say), the release goes straight back onto it.
    // When it may be gone, the release stays on the stand-in: setting it on a missing tag would have GitHub make that
    // tag at the release's target, and the next run makes it properly.
    let still = false
    try { still = tagAt(gh, repo, TAG) !== null } catch { still = false }
    if (still) {
      stand(TAG)
      release.tag = TAG
      tidy()
    }
    throw e
  }
  must(make(TAG, sha), `make the tag ${TAG} again at ${sha} (the release is on ${NEXT}; the next run finishes this)`)
  stand(TAG)
  release.tag = TAG
  tidy()
  return { at: sha, how: 'remade' }
}

/** Which commit to build; see the header. Returns { sha, ci, note } or { skip, refused }. */
export function pick({ sha, force = false, repo, wait = 5000 }, gh) {
  if (!SHA.test(sha ?? '')) return { skip: `not a commit: ${sha}`, refused: true }
  const tip = mainTip(gh, repo)
  if (!onMain(gh, repo, sha, tip, { wait })) return { skip: `${sha} is not on main (main is at ${tip}): the current build follows main alone`, refused: true }
  // The newest green commit, not only the one that started this run: one run waits at a time, and a run that took a
  // waiting one's place (a re-run, a run by hand before main's tip passed ci) must not leave the newest one unpublished.
  const green = newestGreen(gh, repo, tip, { wait })
  if (!green) return { skip: `ci has not passed on ${sha} or on any newer commit on main`, refused: true }
  const note = green.sha === sha ? '' : `building ${green.sha}, the newest commit on main that ci passed on (this run was started for ${sha})`
  const release = getRelease(gh, repo)
  const state = release ? readState(gh, repo, release, { wait }) : { targets: {} }
  if (state.commit && state.commit !== green.sha && compare(gh, repo, state.commit, green.sha, { wait }) === 'behind') {
    return { skip: `the release already holds ${state.commit}, which is newer than ${green.sha}`, refused: false }
  }
  // Already done only when the release holds that commit for every required target and the publish finished (see holds).
  const required = IDS.filter((id) => !BEST_EFFORT.includes(id))
  if (!force && state.commit === green.sha && required.every((id) => state.targets[id]?.commit === green.sha) && holds(release, state)) {
    return { skip: `the release already holds ${green.sha} for every target (run by hand with force to build it again)`, refused: false }
  }
  return { sha: green.sha, ci: green.ci, note }
}

/**
 * Publishes (or, with dryRun, plans) the current build; see the header. Returns { status, plan, tag } where status is
 * `published`, `planned` (a dry run) or `stale` (the release already holds a newer commit: nothing written).
 */
export function publish({ media, stage, source, sha, ci = '', run = '', repo, dryRun = false, time = new Date().toISOString(), log = console.log, wait = 15000, verifyWait = 10000 }, gh) {
  if (!SHA.test(sha ?? '')) throw new Error(`not a commit: ${sha}`)
  const built = collect({ media, stage, source })
  const version = source && existsSync(join(source, 'package.json')) ? JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version : 'unknown'
  if (dryRun) log(`dry run: nothing is written, and ${sha} is not checked against main`)
  else if (!onMain(gh, repo, sha, undefined, { wait })) throw new Error(`${sha} is not on main any more: nothing was published`)
  const release = getRelease(gh, repo)
  const state = release ? readState(gh, repo, release, { wait }) : { targets: {} }
  if (state.commit && state.commit !== sha) {
    const s = compare(gh, repo, state.commit, sha, { wait })
    if (s === 'behind' && dryRun) log(`the release holds ${state.commit}, newer than ${sha}: a real publish would stop here; the plan below is as if it did not`)
    else if (s === 'behind') {
      log(`::notice::the release already holds ${state.commit}, newer than ${sha}: nothing was published`)
      return { status: 'stale', plan: null, tag: null, held: state.commit }
    }
    else if (s === null && !dryRun) throw new Error(`GitHub could not compare ${state.commit}, which the release holds, with ${sha}: nothing was published`)
    else if (s !== 'ahead' && !dryRun) log(`::warning::GitHub compares ${state.commit} and ${sha} as ${s}; publishing ${sha}, which is on main`)
  }
  if (Object.keys(built).length === 0) throw new Error('no target was built: nothing to publish')
  const args = { state, built, sha, run, ci, time, version, repo, assets: release ? release.assets : [] }
  let p = plan(args)
  log(`release ${TAG}: ${release ? `exists${release.tag === NEXT ? ` (on the tag ${NEXT}: an earlier run stopped halfway)` : ''}` : 'to be made'}; commit ${sha}; version ${version}`)
  for (const id of IDS) {
    const t = p.state.targets[id]
    log(`  ${id.padEnd(16)} ${built[id] ? `built: ${built[id].map((f) => f.name).join(', ')}` : t ? `failed: keeps ${t.commit.slice(0, 7)}'s files` : 'failed: no files'}`)
  }
  for (const f of p.uploads) log(`  upload ${f.name} (${mib(f.size)})`)
  for (const n of p.deletes) log(`  delete ${n}`)
  for (const id of p.dropped) log(`  ::warning::${id}: its last files are gone from the release or no longer the bytes it recorded, so it is listed with none`)
  if (dryRun) return { status: 'planned', plan: p, tag: null }

  // The tag first: should GitHub fail here, no file has been touched.
  const tag = placeTag(gh, repo, sha, release, { log, wait })
  log(`tag ${TAG}: ${tag.how}, at ${tag.at}`)
  if (tag.at !== sha) p = plan({ ...args, tagAt: tag.at })
  const notesFile = join(stage, '.notes.md')
  writeFileSync(notesFile, p.notes)
  const R = ['--repo', repo]
  const upload = (path, what) => retry(gh, ['release', 'upload', TAG, path, '--clobber', ...R], `upload ${what}`, { wait })
  // A delete whose answer was lost fails again with "not found" on the next try: the release is read, and a file no
  // longer there counts as deleted.
  const removeAsset = (name) => {
    let r
    for (let i = 1; i <= 3; i++) {
      r = gh(['release', 'delete-asset', TAG, name, '--yes', ...R])
      if (r.ok || !getRelease(gh, repo)?.assets.some((a) => a.name === name)) return
      if (i < 3) { console.error(`delete ${name} failed (${r.err.trim()}); trying again (${i}/2)`); pause(wait) }
    }
    throw new Error(`delete ${name}: ${r.err.trim() || 'failed'}`)
  }
  const record = `${JSON.stringify(p.state, null, 2)}\n`
  if (!release) {
    retry(gh, ['release', 'create', TAG, '--verify-tag', '--prerelease', '--latest=false', '--title', TITLE, '--notes-file', notesFile, ...R], `gh release create ${TAG}`, { wait })
    // An empty record first, so a first run that stops partway leaves a release whose files the next run can account for.
    writeFileSync(join(stage, STATE), `${JSON.stringify({ schema: 1, tag: TAG, targets: {} })}\n`)
    upload(join(stage, STATE), `an empty ${STATE}`)
  }
  // Only the staged copy is left (an earlier run stopped inside current.json's --clobber): it goes back up as
  // current.json first, with nothing for gh to delete, so the staged copy is never the only record when it is replaced.
  if (release && release.assets.some((a) => a.name === STAGED) && !release.assets.some((a) => a.name === STATE)) {
    writeFileSync(join(stage, STATE), `${JSON.stringify(state, null, 2)}\n`)
    upload(join(stage, STATE), `${STATE} (from ${STAGED})`)
  }
  for (const f of p.uploads) upload(f.path, f.name)
  // The record goes up under its staged name before current.json is replaced, and is deleted once current.json holds
  // it: at every moment the release has at least one of the two. Then SHA256SUMS, the files no target names, the notes.
  writeFileSync(join(stage, STAGED), record)
  upload(join(stage, STAGED), STAGED)
  writeFileSync(join(stage, STATE), record)
  upload(join(stage, STATE), STATE)
  removeAsset(STAGED)
  writeFileSync(join(stage, SUMS), p.sums)
  upload(join(stage, SUMS), SUMS)
  for (const n of p.deletes) removeAsset(n)
  retry(gh, ['release', 'edit', TAG, '--title', TITLE, '--notes-file', notesFile, '--prerelease', '--latest=false', ...R], `gh release edit ${TAG}`, { wait })

  // What the release now holds is what the plan says: on the tag `current`, every file at its size (and its digest
  // where GitHub gives one), and nothing else. Asked up to three times, a few seconds apart, in case GitHub's listing
  // lags a change.
  const want = [...IDS.flatMap((id) => p.state.targets[id]?.files ?? []), { name: SUMS, size: Buffer.byteLength(p.sums) }, { name: STATE, size: null }]
  let problems = []
  for (let i = 0; i < 3; i++) {
    if (i) pause(verifyWait)
    const after = getRelease(gh, repo)
    if (!after) { problems = [`the release ${TAG} is gone`]; continue }
    const now = new Map(after.assets.map((a) => [a.name, a]))
    problems = [
      ...(after.tag === TAG ? [] : [`the release is on the tag ${after.tag}`]),
      ...want.filter((f) => {
        const a = now.get(f.name)
        return !a || (f.size !== null && a.size !== f.size) || (f.sha256 && a.digest && a.digest !== `sha256:${f.sha256}`)
      }).map((f) => `${f.name} missing or different`),
      ...[...now.keys()].filter((n) => !want.some((f) => f.name === n)).map((n) => `${n} left over`),
    ]
    if (problems.length === 0) break
  }
  if (problems.length) throw new Error(`the release does not hold what was published: ${problems.join('; ')}`)
  log(`published ${sha} to ${TAG}: ${want.length} files`)
  return { status: 'published', plan: p, tag }
}

export function main(argv, gh = realGh) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const flag = (name) => argv.includes(`--${name}`)
  const [cmd] = argv
  const repo = arg('repo') ?? process.env.GH_REPO
  if (!['pick', 'publish'].includes(cmd) || flag('help')) {
    console.log('usage: node tools/build/current.mjs pick --sha <commit> [--force] [--strict]\n       node tools/build/current.mjs publish --media <dir> --sha <commit> [--source <dir>] [--ci <url>] [--run <url>] [--stage <dir>] [--summary <file>] [--dry-run] [--reused-pick]\n(GH_REPO names the repository, or --repo owner/name)')
    return cmd && !flag('help') ? 1 : 0
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(repo ?? '')) { console.error('::error::GH_REPO (or --repo owner/name) must name the repository'); return 1 }
  try {
    if (cmd === 'pick') {
      const r = pick({ sha: arg('sha'), force: flag('force'), repo }, gh)
      if (r.skip) {
        console.error(`${r.refused && flag('strict') ? '::error::' : '::notice::'}${r.skip}`)
        return r.refused && flag('strict') ? 1 : 0
      }
      if (r.note) console.error(`::notice::${r.note}`)
      console.log(`sha=${r.sha}\nci=${r.ci}`)
      return 0
    }
    const stage = arg('stage') ?? mkdtempSync(join(tmpdir(), 'current-stage-'))
    const r = publish({
      media: resolve(arg('media') ?? 'media'), stage: resolve(stage), source: arg('source') && resolve(arg('source')),
      sha: arg('sha'), ci: arg('ci') ?? '', run: arg('run') ?? '', repo, dryRun: flag('dry-run'),
    }, gh)
    if (arg('summary') && r.plan) appendFileSync(arg('summary'), `## The current build${r.status === 'planned' ? ' (dry run: nothing was published)' : ''}\n\n${r.plan.notes}\n`)
    if (!arg('stage')) rmSync(stage, { recursive: true, force: true })
    let code = 0
    if (r.plan?.failed.length) {
      for (const id of r.plan.failed) console.error(`::error::${id} was not built at ${arg('sha')}${r.plan.state.targets[id] ? `; the release keeps its files from ${r.plan.state.targets[id].commit}` : ''}`)
      code = 1
    }
    // "Re-run failed jobs" keeps pick's answer from the earlier attempt, and its place in the queue can have cancelled
    // the run waiting for a newer green commit. Unless the release now holds the newest green commit (or GitHub says
    // it holds a newer one), that is said in red, so someone runs the workflow by hand; an unanswered question too.
    if (flag('reused-pick') && r.status !== 'planned') {
      const held = r.status === 'stale' ? r.held : arg('sha')
      const by = `this re-run kept the commit an earlier attempt picked, ${arg('sha')}${r.status === 'stale' ? ` (the release already holds ${held})` : ', and published it'}`
      try {
        const g = newestGreen(gh, repo)
        const s = g && g.sha !== held ? compare(gh, repo, held, g.sha) : 'identical'
        if (s !== 'behind' && s !== 'identical') {
          console.error(`::error::${by}; ${s === 'ahead' ? `${g.sha} is newer and ci passed on it` : `GitHub could not compare that with ${g.sha}, the newest commit on main ci passed on (${s ?? 'no answer'})`}, and its own run may have been cancelled: Actions > current > Run workflow, on main`)
          code = 1
        }
      } catch (e) {
        console.error(`::error::${by}; whether a newer commit on main is green could not be checked (${e.message}): Actions > current > Run workflow, on main, if one is`)
        code = 1
      }
    }
    return code
  } catch (e) {
    console.error(`::error::${e.message}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
