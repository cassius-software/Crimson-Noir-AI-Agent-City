#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It keeps the downloads current with main. `.github/workflows/current.yml` builds every
 * target of tools/build/matrix.mjs from a commit on main that ci passed (the Windows x64 app through windows-app.yml,
 * the other eight through build-matrix.yml), then this script puts the files on one GitHub pre-release, tag `current`,
 * titled "Crimson Noir: Agent City, current build", whose files are replaced the same way after each later green run.
 * It never makes a numbered release or any tag but `current`; numbered releases stay build-release.yml's.
 * - `pick --sha <commit> [--force] [--strict]`: whether that commit should be built. It prints `sha=<commit>` and
 *   `ci=<the ci run that passed on it>` (for $GITHUB_OUTPUT) when the commit is on main, ci passed on it there (a push
 *   or a run by hand, never a pull request's run), it is at least as new as what the release holds, and the release
 *   does not already hold it for every target (`--force` builds it anyway); otherwise it prints why on stderr and
 *   nothing on stdout. `--strict` exits 1 when the commit is refused (not on main, no green ci), for a run by hand.
 * - `publish --media <dir> --sha <commit> [--source <dir>] [--ci <url>] [--run <url>] [--summary <file>] [--dry-run]`:
 *   <dir> holds the run's artifacts, one folder each (`matrix-<id>`, and `windows-installer-*`, `windows-msi-*`,
 *   `windows-portable-*` for windows-x64, which counts as built only with all three); a target whose artifact is
 *   missing failed its job, whose uploads come after its gates (a UEFI job's bake twice and QEMU boot). It asks again
 *   that the commit is on main and not older than the release's, then uploads each new or changed file, deletes the
 *   files no target names any more, writes SHA256SUMS (every file on the release) and current.json (which commit,
 *   run and time made each target's files), moves the tag to the commit and rewrites the notes. A target that failed
 *   keeps the files of the last commit it built, and the notes say so; the exit is then 1, except for the iOS build
 *   (best effort, as in build-matrix.yml). `--source` is a checkout of the built commit: its package.json gives the
 *   version the notes name, and crimson_noir_os/'s containment.nix, containment.lock, NOTICE.txt and LICENSE go with
 *   the x86-64 media, as build-release.yml publishes them. `--dry-run` reads the release, prints the plan and the
 *   notes, and writes nothing (a pull request's run of the workflow).
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
export const TITLE = 'Crimson Noir: Agent City, current build'
export const STATE = 'current.json'
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
  const owner = new Map([[SUMS, 'this script'], [STATE, 'this script']])
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
 * commit; each that failed keeps its last files, as long as the release still has them), the files to upload (new,
 * or not the bytes the release has under that name), the files to delete (named by no target any more), SHA256SUMS,
 * the targets missing, the missing ones that turn the run red, and the notes.
 */
export function plan({ state, built, sha, run = '', ci = '', time, version = 'unknown', repo, assets = null }) {
  const prev = state ?? { targets: {} }
  const have = assets ? new Map(assets.map((a) => [a.name, a])) : null
  const targets = {}
  const dropped = []
  for (const id of IDS) {
    if (built[id]) {
      targets[id] = { commit: sha, run, time, files: built[id].map(({ name, sha256, size }) => ({ name, sha256, size })) }
    } else if (prev.targets?.[id]) {
      const t = prev.targets[id]
      // Kept only while every file is still on the release with the size it was recorded at (when the release is known).
      if (!have || t.files.every((f) => have.get(f.name)?.size === f.size)) targets[id] = t
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
  const keep = new Set([...files.map((f) => f.name), SUMS, STATE])
  const deletes = have ? [...have.keys()].filter((n) => !keep.has(n)).sort() : []
  const missing = IDS.filter((id) => !built[id])
  const failed = missing.filter((id) => !BEST_EFFORT.includes(id))
  const sums = [...files].sort(byName).map((f) => `${f.sha256}  ${f.name}`).join('\n') + '\n'
  const next = { schema: 1, tag: TAG, commit: sha, time, run, ci, version, targets }
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
    '',
    '| Platform | Files | Built from |',
    '| :--- | :--- | :--- |',
    ...rows,
    '',
    `- **Checked before publishing.** ci passed on the commit: the page's type check, lint, tests and single-file build, the city in Chrome on a software WebGPU adapter, the Rust workspace on CPU and a software GPU, the SMT theorems, the IR call graph, the WebAssembly air gap and the Kani harnesses. Each UEFI image was then baked a second time from a clean build and compared byte for byte, and booted in QEMU (x86-64 on OVMF, aarch64 on edk2) through the self-test, the tutorial and the terminal's scripted run to power-off, and each ISO to its self-test. No physical machine is part of these checks.`,
    '- **Run on a device so far:** the Windows x64 app. The other apps are built and not yet run on a device; the iPhone can play the web copy instead.',
    "- **Nothing is signed.** Windows SmartScreen asks once (\"More info\", then \"Run anyway\"); the macOS app opens with right-click › Open the first time; the `.apk` carries the Android debug key; the `.ipa` must be re-signed before a device takes it. The OS images run on a UEFI machine with Secure Boot off.",
    `- **Versions.** The file names carry the version in \`package.json\` at this commit (\`${state.version}\`); the commit above is what tells one current build from the next.`,
    `- **Checking a download.** \`sha256sum --check --ignore-missing ${SUMS}\` in the folder you downloaded into; \`${SUMS}\` lists every file here, and \`${STATE}\` records which commit, run and time made each.`,
    `- **A link that stays current.** \`${url}/releases/download/${TAG}/<file>\` always gives the newest file of that name.`,
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

/** GitHub's comparison of two commits: `ahead` (head is newer), `behind`, `identical`, `diverged`, or null when it cannot say. */
export function compare(gh, repo, base, head) {
  const r = gh(['api', `repos/${repo}/compare/${base}...${head}?per_page=1`])
  if (!r.ok) return null
  try { return JSON.parse(r.out).status ?? null } catch { return null }
}

/** Whether `sha` is main's tip or behind it on main's own history. */
export function onMain(gh, repo, sha, tip = mainTip(gh, repo)) {
  if (sha === tip) return true
  return compare(gh, repo, sha, tip) === 'ahead'
}

/** The ci run that passed on `sha` on main (a push, or ci run by hand there), as its address, or null. */
export function ciPassed(gh, repo, sha) {
  const runs = JSON.parse(api(gh, `repos/${repo}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`)).workflow_runs ?? []
  const run = runs.find((r) => r.head_sha === sha && r.conclusion === 'success' && r.head_branch === 'main' && (r.event === 'push' || r.event === 'workflow_dispatch') && r.head_repository?.full_name === repo)
  return run ? run.html_url : null
}

/** The `current` release (its id, assets with name, size, digest and id), or null when there is none. */
export function getRelease(gh, repo) {
  const r = gh(['api', `repos/${repo}/releases/tags/${TAG}`])
  if (notFound(r)) return null
  if (!r.ok) throw new Error(`gh api releases/tags/${TAG}: ${r.err.trim()}`)
  const rel = JSON.parse(r.out)
  return { id: rel.id, assets: (rel.assets ?? []).map((a) => ({ id: a.id, name: a.name, size: a.size, digest: a.digest ?? null })) }
}

/** The release's current.json, read (an empty one when it has none or it does not parse). */
export function readState(gh, repo, release) {
  const asset = release?.assets.find((a) => a.name === STATE)
  if (!asset) return { targets: {} }
  const r = gh(['api', '-H', 'Accept: application/octet-stream', `repos/${repo}/releases/assets/${asset.id}`])
  if (r.ok) return readStateText(r.out)
  // Unread, every target is treated as never built: a failed one's last files are then not kept.
  console.error(`::warning::the release's ${STATE} could not be read (${r.err.trim()}); publishing as if it had none`)
  return { targets: {} }
}

/** The tag `current` at `sha`: made when missing, moved when elsewhere (a lightweight tag, as the API makes it). */
export function setTag(gh, repo, sha) {
  const r = gh(['api', `repos/${repo}/git/ref/tags/${TAG}`])
  if (notFound(r)) {
    api(gh, `repos/${repo}/git/refs`, '-X', 'POST', '-f', `ref=refs/tags/${TAG}`, '-f', `sha=${sha}`)
    return 'made'
  }
  if (!r.ok) throw new Error(`gh api git/ref/tags/${TAG}: ${r.err.trim()}`)
  if (JSON.parse(r.out).object?.sha === sha) return 'kept'
  api(gh, `repos/${repo}/git/refs/tags/${TAG}`, '-X', 'PATCH', '-f', `sha=${sha}`, '-F', 'force=true')
  return 'moved'
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

/** Whether a commit should be built; see the header. Returns { sha, ci } or { skip, refused }. */
export function pick({ sha, force = false, repo }, gh) {
  if (!SHA.test(sha ?? '')) return { skip: `not a commit: ${sha}`, refused: true }
  const tip = mainTip(gh, repo)
  if (!onMain(gh, repo, sha, tip)) return { skip: `${sha} is not on main (main is at ${tip}): the current build follows main alone`, refused: true }
  const ci = ciPassed(gh, repo, sha)
  if (!ci) return { skip: `ci has not passed on ${sha} on main`, refused: true }
  const release = getRelease(gh, repo)
  const state = release ? readState(gh, repo, release) : { targets: {} }
  if (state.commit && state.commit !== sha && compare(gh, repo, state.commit, sha) === 'behind') {
    return { skip: `the release already holds ${state.commit}, which is newer than ${sha}`, refused: false }
  }
  const required = IDS.filter((id) => !BEST_EFFORT.includes(id))
  if (!force && state.commit === sha && required.every((id) => state.targets[id]?.commit === sha)) {
    return { skip: `the release already holds ${sha} for every target (run by hand with force to build it again)`, refused: false }
  }
  return { sha, ci }
}

/**
 * Publishes (or, with dryRun, plans) the current build; see the header. Returns { status, plan } where status is
 * `published`, `planned` (a dry run) or `stale` (the release already holds a newer commit: nothing written).
 */
export function publish({ media, stage, source, sha, ci = '', run = '', repo, dryRun = false, time = new Date().toISOString(), log = console.log, verifyWait = 10000 }, gh) {
  if (!SHA.test(sha ?? '')) throw new Error(`not a commit: ${sha}`)
  const built = collect({ media, stage, source })
  const version = source && existsSync(join(source, 'package.json')) ? JSON.parse(readFileSync(join(source, 'package.json'), 'utf8')).version : 'unknown'
  if (dryRun) log(`dry run: nothing is written, and ${sha} is not checked against main`)
  else if (!onMain(gh, repo, sha)) throw new Error(`${sha} is not on main any more: nothing was published`)
  const release = getRelease(gh, repo)
  const state = release ? readState(gh, repo, release) : { targets: {} }
  if (state.commit && state.commit !== sha) {
    const s = compare(gh, repo, state.commit, sha)
    if (s === 'behind' && dryRun) log(`the release holds ${state.commit}, newer than ${sha}: a real publish would stop here; the plan below is as if it did not`)
    else if (s === 'behind') {
      log(`::notice::the release already holds ${state.commit}, newer than ${sha}: nothing was published`)
      return { status: 'stale', plan: null }
    }
    else if (s !== 'ahead' && !dryRun) log(`::warning::GitHub compares ${state.commit} and ${sha} as ${s ?? 'unknown'}; publishing ${sha}, which is on main`)
  }
  if (Object.keys(built).length === 0) throw new Error('no target was built: nothing to publish')
  const p = plan({ state, built, sha, run, ci, time, version, repo, assets: release ? release.assets : [] })
  log(`release ${TAG}: ${release ? 'exists' : 'to be made'}; commit ${sha}; version ${version}`)
  for (const id of IDS) {
    const t = p.state.targets[id]
    log(`  ${id.padEnd(16)} ${built[id] ? `built: ${built[id].map((f) => f.name).join(', ')}` : t ? `failed: keeps ${t.commit.slice(0, 7)}'s files` : 'failed: no files'}`)
  }
  for (const f of p.uploads) log(`  upload ${f.name} (${mib(f.size)})`)
  for (const n of p.deletes) log(`  delete ${n}`)
  for (const id of p.dropped) log(`  ::warning::${id}: its last files are gone from the release, so it is listed with none`)
  if (dryRun) return { status: 'planned', plan: p }

  const notesFile = join(stage, '.notes.md')
  writeFileSync(notesFile, p.notes)
  const R = ['--repo', repo]
  if (!release) {
    log(`tag ${TAG}: ${setTag(gh, repo, sha)} at ${sha}`)
    retry(gh, ['release', 'create', TAG, '--verify-tag', '--prerelease', '--latest=false', '--title', TITLE, '--notes-file', notesFile, ...R], `gh release create ${TAG}`)
  }
  for (const f of p.uploads) retry(gh, ['release', 'upload', TAG, f.path, '--clobber', ...R], `upload ${f.name}`)
  writeFileSync(join(stage, SUMS), p.sums)
  writeFileSync(join(stage, STATE), `${JSON.stringify(p.state, null, 2)}\n`)
  retry(gh, ['release', 'upload', TAG, join(stage, SUMS), join(stage, STATE), '--clobber', ...R], `upload ${SUMS} and ${STATE}`)
  for (const n of p.deletes) retry(gh, ['release', 'delete-asset', TAG, n, '--yes', ...R], `delete ${n}`)
  if (release) log(`tag ${TAG}: ${setTag(gh, repo, sha)} at ${sha}`)
  retry(gh, ['release', 'edit', TAG, '--title', TITLE, '--notes-file', notesFile, '--prerelease', '--latest=false', ...R], `gh release edit ${TAG}`)

  // What the release now holds is what the plan says: every file, at its size (and its digest where GitHub gives
  // one), and nothing else. Asked up to three times, a few seconds apart, in case GitHub's listing lags a change.
  const want = [...IDS.flatMap((id) => p.state.targets[id]?.files ?? []), { name: SUMS, size: Buffer.byteLength(p.sums) }, { name: STATE, size: null }]
  let problems = []
  for (let i = 0; i < 3; i++) {
    if (i) pause(verifyWait)
    const after = getRelease(gh, repo)
    if (!after) { problems = [`the release ${TAG} is gone`]; continue }
    const now = new Map(after.assets.map((a) => [a.name, a]))
    problems = [
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
  return { status: 'published', plan: p }
}

export function main(argv, gh = realGh) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const flag = (name) => argv.includes(`--${name}`)
  const [cmd] = argv
  const repo = arg('repo') ?? process.env.GH_REPO
  if (!['pick', 'publish'].includes(cmd) || flag('help')) {
    console.log('usage: node tools/build/current.mjs pick --sha <commit> [--force] [--strict]\n       node tools/build/current.mjs publish --media <dir> --sha <commit> [--source <dir>] [--ci <url>] [--run <url>] [--summary <file>] [--dry-run]\n(GH_REPO names the repository, or --repo owner/name)')
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
    if (r.plan?.failed.length) {
      for (const id of r.plan.failed) console.error(`::error::${id} was not built at ${arg('sha')}${r.plan.state.targets[id] ? `; the release keeps its files from ${r.plan.state.targets[id].commit}` : ''}`)
      return 1
    }
    return 0
  } catch (e) {
    console.error(`::error::${e.message}`)
    return 1
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
