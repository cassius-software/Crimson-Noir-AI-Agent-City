// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the current build (tools/build/current.mjs, .github/workflows/current.yml): every
 * target of the build matrix published from a commit on main that ci passed, onto one pre-release whose files follow
 * main. It holds the publish step against a stand-in for GitHub (the release, its assets with their digests, the
 * tag, main's history, ci's runs): a first publish makes the tag and the release, a later one moves the tag, uploads
 * only changed files, deletes the ones no target names, and keeps a failed target's last files with their commit; it
 * never steps back to an older commit, never publishes one off main, and a dry run writes nothing. It also holds the
 * workflow: what starts it, the two workflows it calls with the commit (and that a call never cancels or is cancelled
 * by their own runs), its access, and the bare Windows executables' names, which once collided on a release.
 * What breaks if it is removed? The downloads could step back, publish an untested commit, lose a platform's files
 * when one build fails, or carry two executables under one name, and nothing would notice until someone downloaded one.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Computed specifiers: the scripts are tooling under tools/, outside the page's build, loaded as the test's own modules.
const CURRENT: string = '../tools/build/current.mjs'
const MATRIX: string = '../tools/build/matrix.mjs'
const c = await import(CURRENT)
const m = await import(MATRIX)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')
const WORKFLOW = read('.github/workflows/current.yml')
const WINDOWS = read('.github/workflows/windows-app.yml')
const BUILD_MATRIX = read('.github/workflows/build-matrix.yml')
const IDS: readonly string[] = m.IDS
const REPO = 'cassius-software/Crimson-Noir-AI-Agent-City'
const VERSION = '1.0.0-stable-beta'

interface GhResult { ok: boolean; out: string; err: string }
type Gh = (argv: string[]) => GhResult
interface Asset { id: number; name: string; size: number; digest: string; body: Buffer }
interface FileRecord { name: string; sha256: string; size: number }
interface TargetRecord { commit: string; files: FileRecord[] }
interface State { schema: number; commit: string; version: string; targets: Record<string, TargetRecord> }

const commitOf = (n: number) => createHash('sha1').update(`commit ${n}`).digest('hex')
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/**
 * A stand-in for GitHub as `gh` sees it: main's history (a line of commits, oldest first), ci's green runs, the tag
 * `current`, and its release with assets. Every call is logged; `writes` are the calls that change anything.
 */
function fakeGitHub(history: string[], { green = history, release = false }: { green?: string[]; release?: boolean } = {}) {
  const s = {
    history: [...history],
    green: new Set(green),
    tag: null as string | null,
    release: release ? { id: 7, title: '', notes: '', prerelease: true, latest: false, assets: new Map<string, Asset>() } : null,
    calls: [] as string[][],
    writes: [] as string[][],
    nextAsset: 100,
  }
  const ok = (out: unknown): GhResult => ({ ok: true, out: typeof out === 'string' ? out : JSON.stringify(out), err: '' })
  const missing: GhResult = { ok: false, out: '', err: 'gh: Not Found (HTTP 404)' }
  const opt = (argv: string[], name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined }
  const fields = (argv: string[]) => {
    const f: Record<string, string> = {}
    argv.forEach((a, i) => { if ((a === '-f' || a === '-F') && argv[i + 1]) { const [k, ...v] = argv[i + 1].split('='); f[k] = v.join('=') } })
    return f
  }
  const pos = (a: string) => s.history.indexOf(a)
  const gh: Gh = (argv) => {
    s.calls.push(argv)
    const [cmd, sub] = argv
    if (cmd === 'api') {
      const path = argv[argv.length - 1]
      const method = opt(argv, '-X') ?? 'GET'
      const base = `repos/${REPO}/`
      if (!path.startsWith(base)) return { ok: false, out: '', err: `unexpected path ${path}` }
      const p = path.slice(base.length)
      if (method !== 'GET') s.writes.push(argv)
      if (p === 'git/ref/heads/main') return ok({ object: { sha: s.history[s.history.length - 1] } })
      let k = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)\?per_page=1$/.exec(p)
      if (k) {
        const [a, b] = [pos(k[1]), pos(k[2])]
        return ok({ status: a < 0 || b < 0 ? 'diverged' : b > a ? 'ahead' : b < a ? 'behind' : 'identical' })
      }
      k = /^actions\/workflows\/ci\.yml\/runs\?head_sha=([0-9a-f]+)&status=success&per_page=100$/.exec(p)
      if (k) {
        const sha = k[1]
        return ok({ workflow_runs: s.green.has(sha) ? [{ head_sha: sha, conclusion: 'success', head_branch: 'main', event: 'push', head_repository: { full_name: REPO }, html_url: `https://github.com/${REPO}/actions/runs/1` }] : [] })
      }
      if (p === 'releases/tags/current') {
        if (!s.release || !s.tag) return missing
        return ok({ id: s.release.id, assets: [...s.release.assets.values()].map(({ id, name, size, digest }) => ({ id, name, size, digest })) })
      }
      k = /^releases\/assets\/(\d+)$/.exec(p)
      if (k) {
        const a = [...(s.release?.assets.values() ?? [])].find((x) => x.id === Number(k?.[1]))
        return a ? ok(a.body.toString('utf8')) : missing
      }
      if (p === 'git/ref/tags/current') return s.tag ? ok({ object: { sha: s.tag, type: 'commit' } }) : missing
      if (p === 'git/refs' && method === 'POST') {
        const f = fields(argv)
        assert.equal(f.ref, 'refs/tags/current')
        s.tag = f.sha
        return ok({})
      }
      if (p === 'git/refs/tags/current' && method === 'PATCH') {
        const f = fields(argv)
        assert.equal(f.force, 'true')
        s.tag = f.sha
        return ok({})
      }
      return { ok: false, out: '', err: `unexpected api call ${argv.join(' ')}` }
    }
    if (cmd === 'release') {
      s.writes.push(argv)
      assert.equal(argv[2], 'current', 'only the current release is touched')
      assert.equal(opt(argv, '--repo'), REPO)
      if (sub === 'create') {
        assert.ok(argv.includes('--verify-tag') && s.tag, 'the tag is made before the release')
        assert.ok(argv.includes('--prerelease') && argv.includes('--latest=false'))
        s.release = { id: 7, title: opt(argv, '--title') ?? '', notes: readFileSync(opt(argv, '--notes-file') ?? '', 'utf8'), prerelease: true, latest: false, assets: new Map() }
        return ok('')
      }
      if (!s.release) return missing
      if (sub === 'upload') {
        assert.ok(argv.includes('--clobber'))
        for (const f of argv.slice(3).filter((a) => !a.startsWith('--') && a !== REPO)) {
          const body = readFileSync(f)
          s.release.assets.set(basename(f), { id: s.nextAsset++, name: basename(f), size: body.length, digest: `sha256:${sha256(body)}`, body })
        }
        return ok('')
      }
      if (sub === 'delete-asset') {
        assert.ok(argv.includes('--yes'))
        s.release.assets.delete(argv[3])
        return ok('')
      }
      if (sub === 'edit') {
        assert.ok(argv.includes('--prerelease') && argv.includes('--latest=false'), 'never Latest')
        s.release.title = opt(argv, '--title') ?? ''
        s.release.notes = readFileSync(opt(argv, '--notes-file') ?? '', 'utf8')
        return ok('')
      }
    }
    return { ok: false, out: '', err: `unexpected call ${argv.join(' ')}` }
  }
  return { s, gh }
}

/** A run's artifacts as actions/download-artifact leaves them, one folder each, with given file contents. */
function artifacts(dir: string, tree: Record<string, Record<string, string>>) {
  for (const [artifact, files] of Object.entries(tree)) {
    mkdirSync(join(dir, artifact), { recursive: true })
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, artifact, name), body)
  }
  return dir
}

/** Every target built, with bodies that carry a tag so a rebuild can change them or not. */
function allBuilt(tag: string, version = VERSION): Record<string, Record<string, string>> {
  const app = `Crimson Noir Agent City_${version}`
  return {
    [`windows-installer-${version}`]: { [`${app}_x64-setup.exe`]: `nsis ${tag}` },
    [`windows-msi-${version}`]: { [`Crimson Noir Agent City_1.0.0_x64_en-US.msi`]: `msi ${tag}` },
    [`windows-portable-${version}`]: { [`crimson-noir-app_${version}_x64.exe`]: `exe ${tag}` },
    'matrix-windows-arm64': { [`${app}_arm64-setup.exe`]: `arm nsis ${tag}`, [`crimson-noir-app_${version}_arm64.exe`]: `arm exe ${tag}` },
    'matrix-linux-x64': { [`${app}_amd64.deb`]: `deb ${tag}`, [`${app}_amd64.AppImage`]: `appimage ${tag}` },
    'matrix-linux-arm64': { [`${app}_arm64.deb`]: `arm deb ${tag}` },
    'matrix-macos-universal': { [`${app}_universal.dmg`]: `dmg ${tag}` },
    'matrix-android-apk': { [`crimson-noir-agent-city_${version}_arm64-v8a-debugsigned.apk`]: `apk ${tag}` },
    'matrix-ios-ipa': { [`crimson-noir-agent-city_${version}_ios-arm64-unsigned.ipa`]: `ipa ${tag}` },
    'matrix-uefi-x64': { 'BOOTX64.EFI': 'efi (reproducible)', 'crimson_noir_os.img': 'img (reproducible)', 'crimson_noir_os.iso': 'iso (reproducible)' },
    'matrix-uefi-arm64': { 'BOOTAA64.EFI': 'aa64 efi', 'crimson_noir_os-aarch64.img': 'aa64 img', 'crimson_noir_os-aarch64.iso': 'aa64 iso' },
    'matrix-report-linux-x64': { 'matrix.json': '{}' },
  }
}

/** A checkout of the built commit: package.json and the four files that go beside the x86-64 media. */
function source(dir: string, version = VERSION) {
  mkdirSync(join(dir, 'crimson_noir_os'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version }))
  for (const n of c.NOTICES as string[]) writeFileSync(join(dir, 'crimson_noir_os', n), `${n} text`)
  return dir
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'current-test-'))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

const quiet = () => {}

test('the names: one label per target of the build matrix, the iOS build best effort as build-matrix.yml says, and each file named as GitHub keeps it', () => {
  assert.deepEqual(Object.keys(c.LABELS), [...IDS])
  assert.deepEqual(c.BEST_EFFORT, ['ios-ipa'])
  assert.match(BUILD_MATRIX, /- target: ios-ipa\n {12}runner: macos-15\n {12}bestEffort: true/)
  assert.equal((BUILD_MATRIX.match(/bestEffort: true/g) ?? []).length, 1)
  assert.equal(c.assetName('Crimson Noir Agent City_1.0.0-stable-beta_x64-setup.exe'), 'Crimson.Noir.Agent.City_1.0.0-stable-beta_x64-setup.exe')
  assert.equal(c.assetName('crimson_noir_os.img'), 'crimson_noir_os.img')
  assert.equal(c.assetName('.hidden (copy).txt'), 'hidden..copy..txt')
  assert.throws(() => c.assetName('...'), /no usable file name/)
  assert.deepEqual(c.targetOf('matrix-uefi-arm64'), { id: 'uefi-arm64', part: 'all' })
  assert.equal(c.targetOf('matrix-report-uefi-arm64'), null)
  assert.equal(c.targetOf('matrix-nope'), null)
  assert.deepEqual(c.targetOf('windows-msi-1.0.0-stable-beta'), { id: 'windows-x64', part: 'msi' })
  assert.equal(c.targetOf('browser-smoke-1-2'), null)
})

test('collect: every target from its artifacts, the reports left out, the files named as GitHub keeps them and hashed, the x86-64 media with their notices; Windows x64 only with all three of its artifacts', () => {
  const t = scratch()
  try {
    const media = artifacts(join(t.dir, 'media'), allBuilt('a'))
    const built = c.collect({ media, stage: join(t.dir, 'stage'), source: source(join(t.dir, 'src')) })
    assert.deepEqual(Object.keys(built), [...IDS])
    const names = (id: string) => (built[id] as FileRecord[]).map((f) => f.name)
    assert.deepEqual(names('windows-x64'), ['Crimson.Noir.Agent.City_1.0.0-stable-beta_x64-setup.exe', 'Crimson.Noir.Agent.City_1.0.0_x64_en-US.msi', 'crimson-noir-app_1.0.0-stable-beta_x64.exe'])
    assert.deepEqual(names('uefi-x64'), ['BOOTX64.EFI', 'LICENSE', 'NOTICE.txt', 'containment.lock', 'containment.nix', 'crimson_noir_os.img', 'crimson_noir_os.iso'])
    assert.ok(!Object.values(built).flat().some((f) => (f as FileRecord).name === 'matrix.json'), 'a report is not a download')
    const deb = (built['linux-x64'] as (FileRecord & { path: string })[]).find((f) => f.name.endsWith('.deb'))
    assert.ok(deb)
    assert.equal(deb.sha256, sha256('deb a'))
    assert.equal(deb.size, 5)
    assert.equal(readFileSync(deb.path, 'utf8'), 'deb a')

    const partial = artifacts(join(t.dir, 'partial'), { 'windows-installer-1': { 'a-setup.exe': 'x' }, 'windows-msi-1': { 'a.msi': 'y' } })
    assert.deepEqual(Object.keys(c.collect({ media: partial, stage: join(t.dir, 'stage2') })), [], 'no portable artifact: the Windows build did not finish')
    assert.deepEqual(Object.keys(c.collect({ media: join(t.dir, 'none'), stage: join(t.dir, 'stage3') })), [], 'no artifacts at all')

    const clash = artifacts(join(t.dir, 'clash'), { 'matrix-linux-x64': { 'same name.deb': '1' }, 'matrix-linux-arm64': { 'same.name.deb': '2' } })
    assert.throws(() => c.collect({ media: clash, stage: join(t.dir, 'stage4') }), /two files would be same\.name\.deb on the release: one from linux-x64, one from linux-arm64/)
    const reserved = artifacts(join(t.dir, 'reserved'), { 'matrix-linux-x64': { SHA256SUMS: 'x' } })
    assert.throws(() => c.collect({ media: reserved, stage: join(t.dir, 'stage5') }), /two files would be SHA256SUMS/)
  } finally { t.done() }
})

test('a first publish makes the tag at the commit, then the release as a pre-release that is never Latest, with every file, SHA256SUMS over all of them and current.json', () => {
  const t = scratch()
  try {
    const [c1] = [commitOf(1)]
    const gh = fakeGitHub([commitOf(0), c1])
    const media = artifacts(join(t.dir, 'media'), allBuilt('a'))
    const r = c.publish({ media, stage: join(t.dir, 'stage'), source: source(join(t.dir, 'src')), sha: c1, ci: 'https://ci', run: 'https://run', repo: REPO, time: '2026-11-13T02:14:05.000Z', log: quiet }, gh.gh)
    assert.equal(r.status, 'published')
    assert.deepEqual(r.plan.failed, [])
    assert.equal(gh.s.tag, c1)
    const rel = gh.s.release
    assert.ok(rel)
    assert.equal(rel.title, 'Crimson Noir: Agent City, current build')
    const assets = [...rel.assets.keys()].sort()
    assert.equal(assets.length, 3 + 2 + 2 + 1 + 1 + 1 + 1 + 7 + 3 + 2)
    assert.ok(assets.includes('SHA256SUMS') && assets.includes('current.json'))
    assert.ok(assets.every((n) => !/\s/.test(n)), 'every name as GitHub keeps it')
    // SHA256SUMS checks every other file on the release, as `sha256sum --check` would.
    const sums = rel.assets.get('SHA256SUMS')?.body.toString('utf8') ?? ''
    const lines = sums.trim().split('\n')
    assert.equal(lines.length, assets.length - 2)
    for (const line of lines) {
      const [hash, name] = line.split('  ')
      assert.equal(sha256(rel.assets.get(name)?.body ?? ''), hash, name)
    }
    const state: State = JSON.parse(rel.assets.get('current.json')?.body.toString('utf8') ?? '{}')
    assert.equal(state.schema, 1)
    assert.equal(state.commit, c1)
    assert.equal(state.version, VERSION)
    assert.deepEqual(Object.keys(state.targets), [...IDS])
    assert.ok(Object.values(state.targets).every((x) => x.commit === c1))
    assert.match(rel.notes, /^The current build of Crimson Noir: Agent City and Crimson Noir OS\. Every file here was built from a commit on `main` that \[ci\]\(https:\/\/ci\) passed on/m)
    assert.match(rel.notes, /This is a pre-release: the latest numbered release is unchanged, and numbered releases are still cut by hand\./)
    assert.match(rel.notes, new RegExp(`\\*\\*Commit\\*\\* \\[\`${c1.slice(0, 7)}\`\\]\\(https://github\\.com/${REPO}/commit/${c1}\\) on main, published 2026-11-13 02:14 UTC by \\[this run\\]\\(https://run\\)\\.`))
    for (const id of IDS) assert.match(rel.notes, new RegExp(`^\\| ${c.LABELS[id].replace(/[()]/g, '\\$&')} \\| \\[`, 'm'), id)
    assert.match(rel.notes, /\[web copy\]\(https:\/\/cassius-software\.github\.io\/Crimson-Noir-AI-Agent-City\/\)/)
    assert.match(rel.notes, /The file names carry the version in `package\.json` at this commit \(`1\.0\.0-stable-beta`\)/)
    assert.match(rel.notes, /releases\/download\/current\/Crimson\.Noir\.Agent\.City_1\.0\.0-stable-beta_x64-setup\.exe/)
    // The scrub list the WebAssembly air gap applies to shipped text holds for the notes too.
    for (const word of [/\bthe matrix\b/i, /\bdigital rain\b/i, /\bxbox\b/i, /\bnintendo\b/i]) assert.doesNotMatch(rel.notes, word)
  } finally { t.done() }
})

test('a later publish moves the tag, uploads only what changed, deletes files no target names, and a failed target keeps its last files with their commit, said in the notes', () => {
  const t = scratch()
  try {
    const [c1, c2] = [commitOf(1), commitOf(2)]
    const gh = fakeGitHub([commitOf(0), c1, c2])
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), source: source(join(t.dir, 'src1')), sha: c1, repo: REPO, log: quiet }, gh.gh)
    const before = new Map(gh.s.release?.assets ?? [])
    // At c2 the version moved on (every app's name changes), linux-arm64's job failed, and the UEFI media are the same bytes.
    const next = allBuilt('b', '1.0.1-stable-beta')
    delete next['matrix-linux-arm64']
    const callsBefore = gh.s.writes.length
    const r = c.publish({ media: artifacts(join(t.dir, 'm2'), next), stage: join(t.dir, 's2'), source: source(join(t.dir, 'src2'), '1.0.1-stable-beta'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    assert.equal(r.status, 'published')
    assert.deepEqual(r.plan.missing, ['linux-arm64'])
    assert.deepEqual(r.plan.failed, ['linux-arm64'])
    assert.equal(gh.s.tag, c2, 'the tag moved')
    const writes = gh.s.writes.slice(callsBefore)
    const uploaded = writes.filter((w) => w[1] === 'upload').flatMap((w) => w.slice(3).filter((a) => !a.startsWith('--') && a !== REPO).map((p) => basename(p)))
    for (const same of ['BOOTX64.EFI', 'crimson_noir_os.img', 'crimson_noir_os.iso', 'BOOTAA64.EFI', 'LICENSE', 'containment.nix']) assert.ok(!uploaded.includes(same), `${same}: the same bytes are not uploaded again`)
    assert.ok(uploaded.includes('Crimson.Noir.Agent.City_1.0.1-stable-beta_amd64.deb'))
    const deleted = writes.filter((w) => w[1] === 'delete-asset').map((w) => w[3])
    assert.ok(deleted.includes('Crimson.Noir.Agent.City_1.0.0-stable-beta_amd64.deb'), 'the old version\'s file goes')
    assert.ok(!deleted.includes('Crimson.Noir.Agent.City_1.0.0-stable-beta_arm64.deb'), 'the failed target\'s last file stays')
    const assets = gh.s.release?.assets
    assert.ok(assets)
    assert.equal(assets.get('Crimson.Noir.Agent.City_1.0.0-stable-beta_arm64.deb')?.digest, before.get('Crimson.Noir.Agent.City_1.0.0-stable-beta_arm64.deb')?.digest)
    assert.ok(![...assets.keys()].some((n) => n.includes('1.0.0-stable-beta') && !n.includes('arm64.deb')), 'nothing else of the old version is left')
    const state: State = JSON.parse(assets.get('current.json')?.body.toString('utf8') ?? '{}')
    assert.equal(state.commit, c2)
    assert.equal(state.targets['linux-arm64'].commit, c1)
    assert.equal(state.targets['linux-x64'].commit, c2)
    const sums = assets.get('SHA256SUMS')?.body.toString('utf8') ?? ''
    assert.match(sums, new RegExp(`^${sha256('arm deb a')}  Crimson\\.Noir\\.Agent\\.City_1\\.0\\.0-stable-beta_arm64\\.deb$`, 'm'), 'the kept file is in SHA256SUMS')
    assert.equal(sums.trim().split('\n').length, assets.size - 2)
    const notes = gh.s.release?.notes ?? ''
    assert.match(notes, new RegExp(`^\\| Linux arm64 \\| .* \\| \\[\`${c1.slice(0, 7)}\`\\]\\(.*\\), .*: its build failed at \\[\`${c2.slice(0, 7)}\`\\]\\(.*\\), so these are its last good files \\|$`, 'm'))
    assert.match(notes, /Not built at this commit: Linux arm64\./)
  } finally { t.done() }
})

test('a target that never built is listed with no files; the iOS build missing is no failure; a kept target whose files were deleted by hand is dropped', () => {
  const t = scratch()
  try {
    const [c1, c2] = [commitOf(1), commitOf(2)]
    const gh = fakeGitHub([c1, c2])
    const first = allBuilt('a')
    delete first['matrix-ios-ipa']
    const r1 = c.publish({ media: artifacts(join(t.dir, 'm1'), first), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    assert.deepEqual(r1.plan.missing, ['ios-ipa'])
    assert.deepEqual(r1.plan.failed, [], 'best effort')
    assert.match(gh.s.release?.notes ?? '', /^\| iOS \(arm64, unsigned\) \| no files yet \| its build failed at .* \(best effort\) \|$/m)
    assert.ok(!gh.s.release?.assets.has('LICENSE'), 'without --source, no notices are added')
    // Someone deletes the macOS file by hand; macOS then fails at c2: nothing of it is listed or summed.
    gh.s.release?.assets.delete('Crimson.Noir.Agent.City_1.0.0-stable-beta_universal.dmg')
    const second = allBuilt('b')
    delete second['matrix-macos-universal']
    const r2 = c.publish({ media: artifacts(join(t.dir, 'm2'), second), stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    assert.deepEqual(r2.plan.dropped, ['macos-universal'])
    assert.equal(r2.plan.state.targets['macos-universal'], undefined)
    assert.doesNotMatch(gh.s.release?.assets.get('SHA256SUMS')?.body.toString('utf8') ?? '', /universal\.dmg/)
  } finally { t.done() }
})

test('it never steps back: an older commit than the release holds publishes nothing, a commit off main is refused, and a dry run writes nothing at all', () => {
  const t = scratch()
  try {
    const [c1, c2] = [commitOf(1), commitOf(2)]
    const gh = fakeGitHub([commitOf(0), c1, c2])
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    const writes = gh.s.writes.length
    const stale = c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    assert.equal(stale.status, 'stale')
    assert.equal(gh.s.writes.length, writes, 'nothing written')
    assert.equal(gh.s.tag, c2)
    const off = commitOf(99)
    assert.throws(() => c.publish({ media: join(t.dir, 'm2'), stage: join(t.dir, 's3'), sha: off, repo: REPO, log: quiet }, gh.gh), /is not on main any more: nothing was published/)
    assert.equal(gh.s.writes.length, writes)
    const logs: string[] = []
    const dry = c.publish({ media: join(t.dir, 'm2'), stage: join(t.dir, 's4'), sha: off, repo: REPO, dryRun: true, log: (l: string) => logs.push(l) }, gh.gh)
    assert.equal(dry.status, 'planned')
    assert.equal(gh.s.writes.length, writes, 'a dry run writes nothing')
    assert.ok(logs.some((l) => l.startsWith('  upload ')), 'and says what it would upload')
    assert.match(logs.join('\n'), /dry run: nothing is written/)
    assert.throws(() => c.publish({ media: join(t.dir, 'empty'), stage: join(t.dir, 's5'), sha: c2, repo: REPO, log: quiet }, gh.gh), /no target was built: nothing to publish/)
  } finally { t.done() }
})

test('pick: a commit on main that ci passed on, unless the release holds it for every target already (force builds it again) or holds a newer one', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([c1, c2, c3], { green: [c1, c2] })
    assert.deepEqual(c.pick({ sha: c2, repo: REPO }, gh.gh), { sha: c2, ci: `https://github.com/${REPO}/actions/runs/1` }, 'behind main\'s tip is still on main')
    assert.equal(c.pick({ sha: c3, repo: REPO }, gh.gh).refused, true, 'no green ci')
    assert.match(c.pick({ sha: c3, repo: REPO }, gh.gh).skip, /ci has not passed/)
    assert.match(c.pick({ sha: commitOf(42), repo: REPO }, gh.gh).skip, /is not on main/)
    assert.equal(c.pick({ sha: 'main', repo: REPO }, gh.gh).refused, true)
    c.publish({ media: artifacts(join(t.dir, 'm'), allBuilt('a')), stage: join(t.dir, 's'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    const done = c.pick({ sha: c2, repo: REPO }, gh.gh)
    assert.match(done.skip, /already holds .* for every target/)
    assert.equal(done.refused, false)
    assert.equal(c.pick({ sha: c2, force: true, repo: REPO }, gh.gh).sha, c2)
    const older = c.pick({ sha: c1, repo: REPO }, gh.gh)
    assert.match(older.skip, /newer than/)
    assert.equal(older.refused, false)
    assert.equal(gh.s.writes.length > 0, true)
    assert.ok(gh.s.calls.filter((a) => a[0] === 'api' && a.includes('-X')).length >= 1)
  } finally { t.done() }
})

test('the command line: pick prints the outputs or nothing, --strict fails a refused commit; publish exits 1 when a required target failed (after publishing the rest) and 0 when only the iOS build did', () => {
  const t = scratch()
  const out: string[] = []
  const err: string[] = []
  const [log, error] = [console.log, console.error]
  console.log = (...a: unknown[]) => { out.push(a.join(' ')) }
  console.error = (...a: unknown[]) => { err.push(a.join(' ')) }
  try {
    const [c1, c2] = [commitOf(1), commitOf(2)]
    const gh = fakeGitHub([c1, c2], { green: [c1] })
    assert.equal(c.main(['pick', '--sha', c1, '--repo', REPO], gh.gh), 0)
    assert.deepEqual(out.splice(0), [`sha=${c1}\nci=https://github.com/${REPO}/actions/runs/1`])
    assert.equal(c.main(['pick', '--sha', c2, '--repo', REPO], gh.gh), 0)
    assert.deepEqual(out.splice(0), [], 'a commit ci has not passed: nothing for the outputs')
    assert.match(err.splice(0).join('\n'), /::notice::ci has not passed/)
    assert.equal(c.main(['pick', '--sha', c2, '--strict', '--repo', REPO], gh.gh), 1)
    assert.match(err.splice(0).join('\n'), /::error::ci has not passed/)
    assert.equal(c.main(['pick', '--sha', c1], gh.gh), process.env.GH_REPO ? 0 : 1, 'the repository must be named')
    out.splice(0); err.splice(0)

    const noArm = allBuilt('a')
    delete noArm['matrix-linux-arm64']
    const summary = join(t.dir, 'summary.md')
    assert.equal(c.main(['publish', '--repo', REPO, '--media', artifacts(join(t.dir, 'm1'), noArm), '--sha', c1, '--stage', join(t.dir, 's1'), '--summary', summary], gh.gh), 1)
    assert.match(err.splice(0).join('\n'), new RegExp(`::error::linux-arm64 was not built at ${c1}`))
    assert.ok(gh.s.release?.assets.has('Crimson.Noir.Agent.City_1.0.0-stable-beta_amd64.deb'), 'the rest was published')
    assert.match(readFileSync(summary, 'utf8'), /^## The current build\n\n/)
    const noIos = allBuilt('b')
    delete noIos['matrix-ios-ipa']
    gh.s.green.add(c2)
    assert.equal(c.main(['publish', '--repo', REPO, '--media', artifacts(join(t.dir, 'm2'), noIos), '--sha', c2, '--stage', join(t.dir, 's2')], gh.gh), 0)
    assert.equal(c.main(['nope'], gh.gh), 1)
    assert.equal(c.main(['--help'], gh.gh), 0)
  } finally {
    console.log = log
    console.error = error
    t.done()
  }
})

test('the workflow: started by a green ci on main, a pull request that touches it (a dry run) or by hand on main; one run at a time; the two build workflows called with the commit; write access only where it publishes', () => {
  assert.match(WORKFLOW, /^on:\n {2}workflow_run:\n {4}workflows: \[ci\]\n {4}types: \[completed\]\n {4}branches: \[main\]\n {2}pull_request:\n {4}paths:\n/m)
  for (const p of ['.github/workflows/current.yml', '.github/workflows/windows-app.yml', '.github/workflows/build-matrix.yml', 'tools/build/current.mjs']) assert.ok(WORKFLOW.includes(`      - ${p}\n`), p)
  assert.match(WORKFLOW, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}force:\n/m)
  assert.match(WORKFLOW, /^permissions: \{\}$/m)
  // As web.yml picks: ci passed, on a push (or ci run by hand) to main in this repository.
  assert.match(WORKFLOW, /github\.event\.workflow_run\.conclusion == 'success' &&\n {6}\(github\.event\.workflow_run\.event == 'push' \|\| github\.event\.workflow_run\.event == 'workflow_dispatch'\) &&\n {6}github\.event\.workflow_run\.head_branch == 'main' &&\n {6}github\.event\.workflow_run\.head_repository\.full_name == github\.repository/)
  assert.match(WORKFLOW, /&& 'current'\) \|\| format\('current-skip-\{0\}', github\.run_id\) \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/)
  assert.match(WORKFLOW, /\[ "\$GITHUB_REF" = refs\/heads\/main \] \|\| \{ echo "::error::run it on main/)
  assert.match(WORKFLOW, /node tools\/build\/current\.mjs pick "\$\{args\[@\]\}" \| tee -a "\$GITHUB_OUTPUT"/)
  const jobs = WORKFLOW.split(/^jobs:$/m)[1] ?? ''
  const job = (name: string) => (jobs.split(new RegExp(`^ {2}${name}:$`, 'm'))[1] ?? '').split(/^ {2}[a-z-]+:$/m)[0]
  for (const [name, file] of [['windows', 'windows-app.yml'], ['matrix', 'build-matrix.yml']]) {
    assert.match(job(name), new RegExp(`uses: \\./\\.github/workflows/${file.replace('.', '\\.')}\\n {4}with:\\n {6}ref: \\$\\{\\{ needs\\.pick\\.outputs\\.sha \\}\\}`), name)
    assert.match(job(name), /if: needs\.pick\.outputs\.sha != ''/)
  }
  assert.match(job('publish'), /needs: \[pick, windows, matrix\]\n {4}if: \$\{\{ !cancelled\(\) && needs\.pick\.outputs\.sha != '' && needs\.pick\.outputs\.dry != 'true' \}\}/)
  assert.match(job('publish'), /permissions:\n {6}contents: write\n/)
  assert.match(job('publish'), /node tools\/build\/current\.mjs publish --media media --source built --sha "\$SHA"/)
  assert.doesNotMatch(job('publish'), /--dry-run/)
  assert.match(job('dry-run'), /needs\.pick\.outputs\.dry == 'true'/)
  assert.match(job('dry-run'), /permissions:\n {6}contents: read\n/)
  assert.match(job('dry-run'), /node tools\/build\/current\.mjs publish --dry-run/)
  assert.match(job('pick'), /permissions:\n {6}contents: read\n {6}actions: read\n/)
  for (const line of WORKFLOW.split('\n').filter((l) => /^\s*(- )?uses:/.test(l))) assert.match(line, /uses: (actions\/[a-z-]+@v\d+|\.\/\.github\/workflows\/[a-z-]+\.yml)$/, line)
  assert.doesNotMatch(WORKFLOW, /persist-credentials: true/)
  assert.doesNotMatch(WORKFLOW, /^\s*- [*&]|: [*&][a-z]/m, 'no YAML anchors')
})

test('the two called workflows: a workflow_call with the commit as ref, built at that commit, a concurrency group of its own so neither a push nor a pull request cancels a call, and the release jobs left to a v* tag', () => {
  for (const [name, yml] of [['windows-app.yml', WINDOWS], ['build-matrix.yml', BUILD_MATRIX]]) {
    assert.match(yml, /^ {2}workflow_call:\n {4}inputs:\n {6}ref:\n {8}description: .*\n {8}required: true\n {8}type: string$/m, name)
    assert.match(yml, /^ {2}group: [a-z-]+-\$\{\{ inputs\.ref \|\| inputs\.tag \|\| github\.ref \}\}$/m, name)
    assert.doesNotMatch(yml, /ref: \$\{\{ inputs\.tag \|\| github\.ref \}\}/, `${name}: every checkout takes the call's commit`)
    assert.match(yml, /^permissions:\n {2}contents: read$/m, `${name}: its builds stay read-only`)
    assert.match(yml, /^ {4}if: \(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\) \|\| \(github\.event_name == 'workflow_dispatch' && startsWith\(inputs\.tag, 'v'\)\)$/m, `${name}: the release job runs on a v* tag alone`)
  }
  assert.equal((BUILD_MATRIX.match(/ref: \$\{\{ inputs\.ref \|\| inputs\.tag \|\| github\.ref \}\}/g) ?? []).length, 2, 'the build and the summary')
})

test('the bare Windows executables carry the version and the architecture, so x64 and arm64 never share a name on a release', () => {
  assert.equal(m.portableName('crimson-noir-app.exe', VERSION, 'x64'), 'crimson-noir-app_1.0.0-stable-beta_x64.exe')
  assert.equal(m.portableName('crimson-noir-app.EXE', VERSION, 'arm64'), 'crimson-noir-app_1.0.0-stable-beta_arm64.exe')
  const matrix = read('tools/build/matrix.mjs')
  assert.match(matrix, /globs\(join\(ROOT, 'src-tauri\/target\/release'\), \(n\) => n\.endsWith\('\.exe'\)\)\.map\(\(\[p, n\]\) => \[p, portableName\(n, version, 'x64'\)\]\)/)
  assert.match(matrix, /release`\), \(n\) => n\.endsWith\('\.exe'\)\)\.map\(\(\[p, n\]\) => \[p, portableName\(n, version, 'arm64'\)\]\)/)
  assert.match(WINDOWS, /for exe in src-tauri\/target\/release\/\*\.exe; do cp "\$exe" "out\/portable\/\$\(basename "\$exe" \.exe\)_\$\{version\}_x64\.exe"; done/)
  // windows-app.yml's release job keeps this version's files and removes other versions' (the arm64 ones stay).
  assert.ok(m.portableName('crimson-noir-app.exe', VERSION, 'arm64').includes(`_${VERSION}_`))
})
