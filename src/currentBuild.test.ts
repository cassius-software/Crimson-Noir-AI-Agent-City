// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the current build (tools/build/current.mjs, .github/workflows/current.yml): every
 * target of the build matrix published from a commit on main that ci passed, onto one pre-release whose files follow
 * main. It holds the publish step against a stand-in for GitHub (the release, its assets with their digests, the
 * tags with GitHub's rules for the workflow's token, main's history, ci's runs): a first publish makes the tag and the
 * release, a later one puts the tag at the commit before any file is written (through the stand-in tag when GitHub
 * refuses the move, never turning the release into a draft, and finishing a run that stopped halfway), uploads only
 * changed files, deletes the ones no target names, and keeps a failed target's last files with their commit while
 * they are still those bytes; it never steps back to an older commit, never publishes one off main, stops when it
 * cannot read what the release holds or GitHub cannot answer, never leaves the release without its record (gh's
 * --clobber deletes before it uploads), builds the newest green commit whichever run starts (and says so in red when
 * a re-run of failed jobs could not), and a dry run writes nothing. It also holds the
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
interface State { schema: number; commit: string; tagAt: string; version: string; targets: Record<string, TargetRecord> }

const commitOf = (n: number) => createHash('sha1').update(`commit ${n}`).digest('hex')
const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex')

/** The address of the ci run that passed on a commit, as the stand-in lists it. */
const ciUrl = (sha: string) => `https://github.com/${REPO}/actions/runs/${parseInt(sha.slice(0, 6), 16)}`

/**
 * A stand-in for GitHub as `gh` sees it: main's history (a line of commits, oldest first, which a test can extend),
 * ci's green runs, the tags, and the release with its assets. It keeps GitHub's rules for the workflow's own token as
 * far as they are known: a tag is not moved across a change to a workflow file (each commit's workflow files are
 * named by `workflows`, the same for all unless given), a tag is not made at a commit whose workflow files differ from
 * main's tip, and deleting the tag a release stands on turns the release into a draft (`everDraft` remembers it).
 * An upload with --clobber deletes the old file before it uploads the new one, as gh does. `fail` lets a test make any
 * call fail, `failUpload` an upload after its old file is gone. Every call is logged; `writes` are the calls that change
 * anything.
 */
interface Release { id: number; tag: string; draft: boolean; title: string; notes: string; prerelease: boolean; latest: boolean; assets: Map<string, Asset> }

function fakeGitHub(history: string[], { green = history, workflows = {} }: { green?: string[]; workflows?: Record<string, string> } = {}) {
  const refs = new Map<string, string>()
  const s = {
    history: [...history],
    green: new Set(green),
    workflows: { ...workflows } as Record<string, string>,
    refs,
    get tag() { return refs.get('current') ?? null },
    release: null as Release | null,
    everDraft: false,
    fail: null as ((argv: string[]) => GhResult | null) | null,
    // As gh does with --clobber: the old file is deleted first, then the new one uploaded, which this can fail.
    failUpload: null as ((name: string) => boolean) | null,
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
  const tip = () => s.history[s.history.length - 1]
  const wf = (c: string) => s.workflows[c] ?? 'w0'
  const live = (tag: string) => (s.release && !s.release.draft && s.release.tag === tag && refs.has(tag) ? s.release : null)
  const gh: Gh = (argv) => {
    s.calls.push(argv)
    const injected = s.fail?.(argv)
    if (injected) return injected
    const [cmd, sub] = argv
    if (cmd === 'api') {
      const path = argv[argv.length - 1]
      const method = opt(argv, '-X') ?? 'GET'
      const base = `repos/${REPO}/`
      if (!path.startsWith(base)) return { ok: false, out: '', err: `unexpected path ${path}` }
      const p = path.slice(base.length)
      if (method !== 'GET') s.writes.push(argv)
      if (p === 'git/ref/heads/main') return ok({ object: { sha: tip() } })
      let k = /^compare\/([0-9a-f]+)\.\.\.([0-9a-f]+)\?per_page=1$/.exec(p)
      if (k) {
        const [a, b] = [pos(k[1]), pos(k[2])]
        return ok({ status: a < 0 || b < 0 ? 'diverged' : b > a ? 'ahead' : b < a ? 'behind' : 'identical' })
      }
      if (p === 'actions/workflows/ci.yml/runs?branch=main&status=success&per_page=50') {
        const run = (sha: string) => ({ head_sha: sha, conclusion: 'success', head_branch: 'main', event: 'push', head_repository: { full_name: REPO }, html_url: ciUrl(sha) })
        // A fork's pull request from its own branch named main is listed too, and must be passed over.
        const fork = { ...run(tip()), event: 'pull_request', head_repository: { full_name: 'someone/fork' }, html_url: 'https://fork' }
        return ok({ workflow_runs: [fork, ...[...s.history].reverse().filter((c) => s.green.has(c)).map(run)] })
      }
      k = /^releases\/tags\/([a-z-]+)$/.exec(p)
      if (k) {
        const rel = live(k[1])
        return rel ? ok({ id: rel.id, tag_name: rel.tag, body: rel.notes, assets: [...rel.assets.values()].map(({ id, name, size, digest }) => ({ id, name, size, digest })) }) : missing
      }
      k = /^releases\/assets\/(\d+)$/.exec(p)
      if (k) {
        const a = [...(s.release?.assets.values() ?? [])].find((x) => x.id === Number(k?.[1]))
        return a ? ok(a.body.toString('utf8')) : missing
      }
      if (p === 'releases/7' && method === 'PATCH') {
        const f = fields(argv)
        assert.equal(f.make_latest, 'false', 'never Latest')
        if (!s.release || !refs.has(f.tag_name)) return { ok: false, out: '', err: 'gh: Validation Failed (HTTP 422)' }
        s.release.tag = f.tag_name
        return ok({})
      }
      k = /^git\/ref\/tags\/([a-z-]+)$/.exec(p)
      if (k) return refs.has(k[1]) ? ok({ object: { sha: refs.get(k[1]), type: 'commit' } }) : missing
      if (p === 'git/refs' && method === 'POST') {
        const f = fields(argv)
        const name = f.ref.replace(/^refs\/tags\//, '')
        assert.ok(['current', 'current-next'].includes(name), `only the two tags: ${f.ref}`)
        if (refs.has(name)) return { ok: false, out: '', err: 'gh: Reference already exists (HTTP 422)' }
        if (pos(f.sha) < 0) return { ok: false, out: '', err: 'gh: Object does not exist (HTTP 422)' }
        if (wf(f.sha) !== wf(tip())) return { ok: false, out: '', err: 'gh: Resource not accessible by integration (HTTP 403)' }
        refs.set(name, f.sha)
        return ok({})
      }
      k = /^git\/refs\/tags\/([a-z-]+)$/.exec(p)
      if (k && method === 'PATCH') {
        const f = fields(argv)
        assert.equal(f.force, 'true')
        const was = refs.get(k[1])
        if (!was) return { ok: false, out: '', err: 'gh: Reference does not exist (HTTP 422)' }
        if (wf(was) !== wf(f.sha)) return { ok: false, out: '', err: 'gh: refusing to allow a GitHub App to create or update workflow `.github/workflows/ci.yml` without `workflows` permission (HTTP 422)' }
        refs.set(k[1], f.sha)
        return ok({})
      }
      if (k && method === 'DELETE') {
        if (!refs.delete(k[1])) return { ok: false, out: '', err: 'gh: Reference does not exist (HTTP 422)' }
        if (s.release?.tag === k[1]) { s.release.draft = true; s.everDraft = true }
        return ok('')
      }
      return { ok: false, out: '', err: `unexpected api call ${argv.join(' ')}` }
    }
    if (cmd === 'release') {
      s.writes.push(argv)
      assert.equal(argv[2], 'current', 'only the current release is touched')
      assert.equal(opt(argv, '--repo'), REPO)
      if (sub === 'create') {
        assert.ok(argv.includes('--verify-tag') && refs.has('current'), 'the tag is made before the release')
        assert.ok(argv.includes('--prerelease') && argv.includes('--latest=false'))
        s.release = { id: 7, tag: 'current', draft: false, title: opt(argv, '--title') ?? '', notes: readFileSync(opt(argv, '--notes-file') ?? '', 'utf8'), prerelease: true, latest: false, assets: new Map() }
        return ok('')
      }
      const rel = live('current')
      if (!rel) return { ok: false, out: '', err: 'release not found' }
      if (sub === 'upload') {
        assert.ok(argv.includes('--clobber'))
        for (const f of argv.slice(3).filter((a) => !a.startsWith('--') && a !== REPO)) {
          const body = readFileSync(f)
          rel.assets.delete(basename(f))
          if (s.failUpload?.(basename(f))) return { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' }
          rel.assets.set(basename(f), { id: s.nextAsset++, name: basename(f), size: body.length, digest: `sha256:${sha256(body)}`, body })
        }
        return ok('')
      }
      if (sub === 'delete-asset') {
        assert.ok(argv.includes('--yes'))
        if (!rel.assets.delete(argv[3])) return { ok: false, out: '', err: `asset ${argv[3]} not found in release current` }
        return ok('')
      }
      if (sub === 'edit') {
        assert.ok(argv.includes('--prerelease') && argv.includes('--latest=false'), 'never Latest')
        rel.title = opt(argv, '--title') ?? ''
        rel.notes = readFileSync(opt(argv, '--notes-file') ?? '', 'utf8')
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
    // The UEFI applications keep their bytes from commit to commit when their code does; the images carry the commit's
    // time and GUIDs, so their bytes change with every commit at one fixed size.
    'matrix-uefi-x64': { 'BOOTX64.EFI': 'efi (same code)', 'crimson_noir_os.img': `img ${tag}`, 'crimson_noir_os.iso': `iso ${tag}` },
    'matrix-uefi-arm64': { 'BOOTAA64.EFI': 'aa64 efi', 'crimson_noir_os-aarch64.img': `aa64 img ${tag}`, 'crimson_noir_os-aarch64.iso': `aa64 iso ${tag}` },
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
    assert.match(rel.notes, /The apps' file names carry the version in `package\.json` at the commit they were built from \(`1\.0\.0-stable-beta` at this one\)/)
    assert.match(rel.notes, /the zipped macOS `\.app`, the UEFI files and images, and the notices beside them carry none/)
    assert.match(rel.notes, /`SHA256SUMS` lists every file here but itself and `current\.json`/)
    assert.doesNotMatch(rel.notes, /is still at/, 'the tag is where the files are from')
    assert.equal(state.tagAt, c1)
    assert.equal(rel.tag, 'current')
    assert.deepEqual([...gh.s.refs.keys()], ['current'])
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
    // At c2 the version moved on (every app's name changes), linux-arm64's job failed, the UEFI applications are the
    // same bytes and the images are not.
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
    for (const same of ['BOOTX64.EFI', 'BOOTAA64.EFI', 'LICENSE', 'containment.nix']) assert.ok(!uploaded.includes(same), `${same}: the same bytes are not uploaded again`)
    for (const changed of ['crimson_noir_os.img', 'crimson_noir_os.iso', 'crimson_noir_os-aarch64.img']) assert.ok(uploaded.includes(changed), `${changed}: new bytes under the same name and size`)
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

test('the tag across a workflow change: GitHub refuses the move, so the release stands on current-next while current is made again at the commit, and is never a draft', () => {
  const t = scratch()
  try {
    const [c1, c2] = [commitOf(1), commitOf(2)]
    const gh = fakeGitHub([commitOf(0), c1])
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), source: source(join(t.dir, 'src1')), sha: c1, repo: REPO, log: quiet }, gh.gh)
    // c2 changes a workflow file, as this very change does.
    gh.s.history.push(c2)
    gh.s.workflows[c2] = 'w1'
    const logs: string[] = []
    const r = c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), source: source(join(t.dir, 'src2')), sha: c2, repo: REPO, log: (l: string) => logs.push(l) }, gh.gh)
    assert.equal(r.status, 'published')
    assert.deepEqual(r.tag, { at: c2, how: 'remade' })
    assert.match(logs.join('\n'), /GitHub refused to move it from .*workflows.*; making it again at/)
    assert.equal(gh.s.tag, c2)
    assert.deepEqual([...gh.s.refs.keys()], ['current'], 'the stand-in is gone')
    assert.equal(gh.s.release?.tag, 'current')
    assert.equal(gh.s.everDraft, false, 'the release was never on a tag being deleted')
    // The tag was placed before any file was written.
    const firstUpload = gh.s.calls.findIndex((a) => a[0] === 'release' && a[1] === 'upload' && a.includes(join(t.dir, 's2', 'crimson_noir_os.img')))
    const madeAgain = gh.s.calls.findIndex((a) => a.includes('POST') && a.includes('ref=refs/tags/current') && a.includes(`sha=${c2}`))
    assert.ok(madeAgain >= 0 && firstUpload > madeAgain)
    const state: State = JSON.parse(gh.s.release?.assets.get('current.json')?.body.toString('utf8') ?? '{}')
    assert.equal(state.tagAt, c2)
    assert.doesNotMatch(gh.s.release?.notes ?? '', /is still at/)
  } finally { t.done() }
})

test('when GitHub refuses the stand-in too (a later commit changed a workflow), the tag stays, the files are published, the notes say where the tag is, and a later publish moves it once GitHub allows', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([commitOf(0), c1])
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    gh.s.history.push(c2, c3)
    Object.assign(gh.s.workflows, { [c2]: 'w1', [c3]: 'w2' })
    const r = c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    assert.equal(r.status, 'published')
    assert.deepEqual(r.tag, { at: c1, how: 'refused' })
    assert.equal(gh.s.tag, c1)
    assert.deepEqual([...gh.s.refs.keys()], ['current'])
    assert.equal(gh.s.everDraft, false)
    const state: State = JSON.parse(gh.s.release?.assets.get('current.json')?.body.toString('utf8') ?? '{}')
    assert.equal(state.commit, c2)
    assert.equal(state.tagAt, c1)
    assert.ok(Object.values(state.targets).every((x) => x.commit === c2), 'every file is c2\'s')
    assert.match(gh.s.release?.notes ?? '', new RegExp(`^\\*\\*The tag \`current\` is still at \\[\`${c1.slice(0, 7)}\`\\]\\(.*\\)\\*\\*, and so are the source code archives GitHub adds below: GitHub refused to move it to \\[\`${c2.slice(0, 7)}\`\\]`, 'm'))
    const r3 = c.publish({ media: artifacts(join(t.dir, 'm3'), allBuilt('c')), stage: join(t.dir, 's3'), sha: c3, repo: REPO, log: quiet }, gh.gh)
    assert.deepEqual(r3.tag, { at: c3, how: 'remade' })
    assert.equal(gh.s.tag, c3)
    assert.doesNotMatch(gh.s.release?.notes ?? '', /is still at/)
  } finally { t.done() }
})

test('a run that stops halfway through remaking the tag leaves the release on current-next with its files untouched; the next run finds it there and finishes', () => {
  const t = scratch()
  try {
    const [c1, c2] = [commitOf(1), commitOf(2)]
    const gh = fakeGitHub([commitOf(0), c1])
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    const before = new Map([...(gh.s.release?.assets ?? [])].map(([n, a]) => [n, a.digest]))
    gh.s.history.push(c2)
    gh.s.workflows[c2] = 'w1'
    // GitHub stops answering just as current is made again.
    gh.s.fail = (argv) => (argv.includes('POST') && argv.includes('ref=refs/tags/current') ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    const media = artifacts(join(t.dir, 'm2'), allBuilt('b'))
    assert.throws(() => c.publish({ media, stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /make the tag current again at .* \(the release is on current-next; the next run finishes this\): gh: Bad Gateway/)
    assert.equal(gh.s.release?.tag, 'current-next')
    assert.equal(gh.s.tag, null)
    assert.equal(gh.s.everDraft, false)
    assert.deepEqual(new Map([...(gh.s.release?.assets ?? [])].map(([n, a]) => [n, a.digest])), before, 'no file was touched')
    // pick still reads the release where it stands.
    gh.s.green.add(c2)
    assert.equal(c.pick({ sha: c2, repo: REPO }, gh.gh).sha, c2)
    gh.s.fail = null
    const r = c.publish({ media, stage: join(t.dir, 's3'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    assert.equal(r.status, 'published')
    assert.deepEqual(r.tag, { at: c2, how: 'remade' })
    assert.equal(gh.s.release?.tag, 'current')
    assert.deepEqual([...gh.s.refs.entries()], [['current', c2]])
    assert.equal(gh.s.everDraft, false)
    assert.equal(JSON.parse(gh.s.release?.assets.get('current.json')?.body.toString('utf8') ?? '{}').commit, c2)
  } finally { t.done() }
})

test('it stops, writing nothing, when it cannot read the release\'s current.json or GitHub cannot compare the commits; a kept target whose file was replaced under the same name and size is dropped', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([commitOf(0), c1, c2, c3])
    const first = allBuilt('a')
    c.publish({ media: artifacts(join(t.dir, 'm1'), first), stage: join(t.dir, 's1'), source: source(join(t.dir, 'src1')), sha: c1, repo: REPO, log: quiet }, gh.gh)
    const noArm = allBuilt('b')
    delete noArm['matrix-linux-arm64']
    const media = artifacts(join(t.dir, 'm2'), noArm)
    const writes = gh.s.writes.length
    gh.s.fail = (argv) => (/releases\/assets\/\d+$/.test(argv[argv.length - 1]) ? { ok: false, out: '', err: 'gh: Service Unavailable (HTTP 503)' } : null)
    assert.throws(() => c.publish({ media, stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /read the release's current\.json \(nothing was published\): gh: Service Unavailable/)
    assert.throws(() => c.pick({ sha: c2, repo: REPO, wait: 0 }, gh.gh), /current\.json/, 'pick does not guess either')
    // The release's commit against this one (whether c2 is still on main is asked first, and answered).
    gh.s.fail = (argv) => (argv[argv.length - 1].includes(`compare/${c1}...${c2}`) ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media, stage: join(t.dir, 's3'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /GitHub could not compare .*, which the release holds, with .*: nothing was published/)
    // And when GitHub cannot say whether the commit is on main, it stops rather than guess.
    gh.s.fail = (argv) => (argv[argv.length - 1].includes(`compare/${c2}...`) ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media, stage: join(t.dir, 's3b'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /GitHub could not compare .* with main's tip .*, so whether it is on main is unknown/)
    gh.s.fail = null
    assert.equal(gh.s.writes.length, writes, 'nothing written')
    assert.ok(gh.s.release?.assets.has('Crimson.Noir.Agent.City_1.0.0-stable-beta_arm64.deb'), 'linux-arm64\'s last file is still there')

    // An earlier publish that stopped halfway replaced the x86-64 image under its name, at its size; then uefi-x64 fails.
    const img = gh.s.release?.assets.get('crimson_noir_os.img')
    assert.ok(img)
    const body = Buffer.from('img z')
    assert.equal(body.length, img.size)
    gh.s.release?.assets.set('crimson_noir_os.img', { ...img, body, digest: `sha256:${sha256(body)}` })
    const noUefi = allBuilt('c')
    delete noUefi['matrix-uefi-x64']
    const r = c.publish({ media: artifacts(join(t.dir, 'm4'), noUefi), stage: join(t.dir, 's4'), sha: c3, repo: REPO, log: quiet }, gh.gh)
    assert.deepEqual(r.plan.dropped, ['uefi-x64'])
    assert.equal(r.plan.state.targets['uefi-x64'], undefined)
    assert.ok(!gh.s.release?.assets.has('crimson_noir_os.img'), 'a file whose bytes nobody recorded is not offered')
    assert.doesNotMatch(gh.s.release?.assets.get('SHA256SUMS')?.body.toString('utf8') ?? '', /crimson_noir_os\.img/)
  } finally { t.done() }
})

test('a run stopped halfway with current already remade is put back on current without deleting it, even when GitHub would refuse to make it again', () => {
  const t = scratch()
  try {
    const [b, cc, d] = [commitOf(11), commitOf(12), commitOf(13)]
    const gh = fakeGitHub([commitOf(10)])
    c.publish({ media: artifacts(join(t.dir, 'm0'), allBuilt('a')), stage: join(t.dir, 's0'), sha: commitOf(10), repo: REPO, log: quiet }, gh.gh)
    gh.s.history.push(b)
    gh.s.workflows[b] = 'w1'
    // The swap gets as far as making current at b; setting the release back on it fails.
    let backOn = 0
    gh.s.fail = (argv) => (argv.includes('tag_name=current') && ++backOn ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('b')), stage: join(t.dir, 's1'), sha: b, repo: REPO, log: quiet, wait: 0 }, gh.gh), /set the release on the tag current/)
    assert.equal(gh.s.release?.tag, 'current-next')
    assert.equal(gh.s.tag, b)
    gh.s.fail = null
    // cc merges (no workflow change) and passes ci; d changes a workflow and has not: GitHub would refuse a tag at cc.
    gh.s.history.push(cc, d)
    Object.assign(gh.s.workflows, { [cc]: 'w1', [d]: 'w2' })
    const r = c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('c')), stage: join(t.dir, 's2'), sha: cc, repo: REPO, log: quiet }, gh.gh)
    assert.equal(r.status, 'published', 'the files go up')
    assert.deepEqual(r.tag, { at: cc, how: 'moved' }, 'b and cc share their workflow files, so the tag simply moves')
    assert.equal(gh.s.release?.tag, 'current')
    assert.deepEqual([...gh.s.refs.entries()], [['current', cc]], 'the stand-in is tidied away')
    assert.equal(gh.s.everDraft, false)
  } finally { t.done() }
})

test('the record is never missing: an upload of current.json that fails after gh deleted the old one leaves current.next.json, so the next run keeps a failed target\'s files and still refuses an older commit', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([commitOf(0), c1, c2, c3], { green: [c1, c2] })
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    assert.ok(!gh.s.release?.assets.has('current.next.json'), 'a finished publish leaves no staged record')
    gh.s.failUpload = (name) => name === 'current.json'
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /upload current\.json/)
    gh.s.failUpload = null
    const assets = gh.s.release?.assets
    assert.ok(assets && !assets.has('current.json') && assets.has('current.next.json'))
    const staged: State = JSON.parse(assets.get('current.next.json')?.body.toString('utf8') ?? '{}')
    assert.equal(staged.commit, c2)
    // pick sees that publish did not finish, and builds c2 again rather than call it done.
    assert.equal(c.pick({ sha: c2, repo: REPO }, gh.gh).sha, c2)
    // An older commit is still refused, by the staged record.
    assert.equal(c.publish({ media: artifacts(join(t.dir, 'm3'), allBuilt('x')), stage: join(t.dir, 's3'), sha: c1, repo: REPO, log: quiet }, gh.gh).status, 'stale')
    // c3 with linux-arm64 failed keeps c2's arm64 file.
    const noArm = allBuilt('c')
    delete noArm['matrix-linux-arm64']
    const r = c.publish({ media: artifacts(join(t.dir, 'm4'), noArm), stage: join(t.dir, 's4'), sha: c3, repo: REPO, log: quiet }, gh.gh)
    assert.equal(r.status, 'published')
    assert.equal(r.plan.state.targets['linux-arm64'].commit, c2)
    assert.ok(gh.s.release?.assets.has('current.json') && !gh.s.release?.assets.has('current.next.json'))
    // A release with files and no record at all (deleted by hand) is not taken for an empty one.
    gh.s.release?.assets.delete('current.json')
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm5'), allBuilt('d')), stage: join(t.dir, 's5'), sha: c3, repo: REPO, log: quiet }, gh.gh), /holds files but neither current\.json nor current\.next\.json/)
  } finally { t.done() }
})

test('pick builds a commit again when its publish stopped after writing the record (files left to delete, notes not written), and stops, red, when GitHub cannot say whether a commit is on main', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([c1, c2, c3], { green: [c1, c2] })
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    gh.s.fail = (argv) => (argv[1] === 'delete-asset' && argv[3] !== 'current.next.json' ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b', '1.0.1-stable-beta')), stage: join(t.dir, 's2'), source: source(join(t.dir, 'src2'), '1.0.1-stable-beta'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /delete Crimson/)
    gh.s.fail = null
    assert.equal(JSON.parse(gh.s.release?.assets.get('current.json')?.body.toString('utf8') ?? '{}').commit, c2, 'the record says c2')
    assert.equal(c.pick({ sha: c2, repo: REPO }, gh.gh).sha, c2, 'but the old version\'s files are still there: build it again')
    c.publish({ media: artifacts(join(t.dir, 'm3'), allBuilt('b', '1.0.1-stable-beta')), stage: join(t.dir, 's3'), source: source(join(t.dir, 'src3'), '1.0.1-stable-beta'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    assert.match(c.pick({ sha: c2, repo: REPO }, gh.gh).skip, /already holds .* for every required target/)

    gh.s.green.add(c3)
    gh.s.history.push(commitOf(4))
    gh.s.fail = (argv) => (argv[argv.length - 1].includes(`compare/${c3}...`) ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.pick({ sha: c3, repo: REPO, wait: 0 }, gh.gh), /GitHub could not compare/, 'not skipped for want of an answer')
    const err: string[] = []
    const error = console.error
    console.error = (...a: unknown[]) => { err.push(a.join(' ')) }
    try {
      assert.equal(c.main(['pick', '--sha', c3, '--repo', REPO], (argv: string[]) => (argv[argv.length - 1].includes('/compare/') ? { ok: false, out: '', err: 'gh: Not Acceptable (HTTP 406)' } : gh.gh(argv))), 1)
    } finally { console.error = error }
    assert.match(err.join('\n'), /::error::GitHub could not compare/)
  } finally { t.done() }
})

test('tag steps GitHub half-answers: a make whose answer was lost counts once the tag is there, a rate limit is not a refusal, a rule that forbids deleting the tag stops before anything changes, and a leftover stand-in is tidied away', () => {
  const t = scratch()
  try {
    const [c1, c2, c3, c4] = [commitOf(1), commitOf(2), commitOf(3), commitOf(4)]
    const gh = fakeGitHub([commitOf(0), c1])
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    gh.s.history.push(c2)
    gh.s.workflows[c2] = 'w1'
    // The stand-in's make lands, but its answer is lost; the retry hears "already exists".
    let lost = true
    const base = gh.gh
    const flaky: Gh = (argv) => {
      if (lost && argv.includes('ref=refs/tags/current-next')) { lost = false; base(argv); return { ok: false, out: '', err: 'gh: connection reset' } }
      return base(argv)
    }
    const r2 = c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet, wait: 0 }, flaky)
    assert.deepEqual(r2.tag, { at: c2, how: 'remade' })
    assert.deepEqual([...gh.s.refs.keys()], ['current'])

    // A secondary rate limit on the move is not taken for GitHub refusing the token: the run stops, nothing changed.
    gh.s.history.push(c3)
    gh.s.workflows[c3] = 'w2'
    const fileWrites = () => gh.s.writes.filter((w) => w[0] === 'release').length
    const before = fileWrites()
    gh.s.fail = (argv) => (argv.includes('PATCH') && argv[argv.length - 1].endsWith('git/refs/tags/current') ? { ok: false, out: '', err: 'gh: You have exceeded a secondary rate limit (HTTP 403)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm3'), allBuilt('c')), stage: join(t.dir, 's3'), sha: c3, repo: REPO, log: quiet, wait: 0 }, gh.gh), /move the tag current to .*rate limit/)
    // A tag rule that forbids deleting current stops the swap: the release goes straight back onto current, untouched.
    gh.s.fail = (argv) => (argv.includes('DELETE') && argv[argv.length - 1].endsWith('git/refs/tags/current') ? { ok: false, out: '', err: 'gh: Repository rule violations found: Cannot delete this tag (HTTP 422)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm4'), allBuilt('c')), stage: join(t.dir, 's4'), sha: c3, repo: REPO, log: quiet, wait: 0 }, gh.gh), /delete the tag current: .*Repository rule violations/)
    assert.equal(gh.s.tag, c2, 'current was not touched')
    assert.equal(gh.s.release?.tag, 'current', 'the release is back on it')
    assert.deepEqual([...gh.s.refs.keys()], ['current'], 'and the stand-in is gone')
    assert.equal(fileWrites(), before, 'no file was uploaded or deleted in either try')
    gh.s.fail = null
    const r4 = c.publish({ media: artifacts(join(t.dir, 'm5'), allBuilt('c')), stage: join(t.dir, 's5'), sha: c3, repo: REPO, log: quiet }, gh.gh)
    assert.equal(r4.status, 'published')
    assert.equal(gh.s.release?.tag, 'current')
    assert.equal(gh.s.tag, c3)
    assert.equal(gh.s.everDraft, false)

    // A stand-in whose deletion failed is tidied by the next publish, whose tag simply moves.
    gh.s.refs.set('current-next', c3)
    gh.s.history.push(c4)
    gh.s.workflows[c4] = 'w2'
    const r5 = c.publish({ media: artifacts(join(t.dir, 'm6'), allBuilt('d')), stage: join(t.dir, 's6'), sha: c4, repo: REPO, log: quiet }, gh.gh)
    assert.deepEqual(r5.tag, { at: c4, how: 'moved' })
    assert.deepEqual([...gh.s.refs.keys()], ['current'])
  } finally { t.done() }
})

test('a stand-in left at the very commit, which tidying could not delete, is never taken for GitHub\'s leave: the swap deletes it first, and when GitHub then refuses, current stays', () => {
  const t = scratch()
  try {
    const [x, y, z] = [commitOf(21), commitOf(22), commitOf(23)]
    const gh = fakeGitHub([commitOf(20), x])
    c.publish({ media: artifacts(join(t.dir, 'm0'), allBuilt('a')), stage: join(t.dir, 's0'), sha: x, repo: REPO, log: quiet }, gh.gh)
    gh.s.history.push(y)
    gh.s.workflows[y] = 'w1'
    // A first run for y makes the stand-in, then cannot set the release on it: the release stays on current at x.
    gh.s.fail = (argv) => (argv.includes('tag_name=current-next') ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('b')), stage: join(t.dir, 's1'), sha: y, repo: REPO, log: quiet, wait: 0 }, gh.gh), /set the release on the tag current-next/)
    assert.deepEqual([...gh.s.refs.entries()].sort(), [['current', x], ['current-next', y]])
    // z changes a workflow again and has not passed ci; the next run's tidy fails once to read the stand-in.
    gh.s.history.push(z)
    gh.s.workflows[z] = 'w2'
    let once = true
    gh.s.fail = (argv) => (once && argv[argv.length - 1].endsWith('git/ref/tags/current-next') ? ((once = false), { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' }) : null)
    const r = c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: y, repo: REPO, log: quiet, wait: 0 }, gh.gh)
    assert.equal(r.status, 'published')
    assert.deepEqual(r.tag, { at: x, how: 'refused' })
    assert.deepEqual([...gh.s.refs.entries()], [['current', x]], 'current was never deleted; the stand-in is gone')
    assert.equal(gh.s.release?.tag, 'current')
    assert.equal(gh.s.everDraft, false)
  } finally { t.done() }
})

test('two record uploads failing in a row never leave the release without one: a staged copy left alone goes back up as current.json before anything replaces it; a delete whose answer was lost counts once the file is gone', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([commitOf(0), c1, c2, c3], { green: [c1, c2, c3] })
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    gh.s.failUpload = (name) => name === 'current.json'
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /upload current\.json/)
    assert.deepEqual(['current.json', 'current.next.json'].map((n) => gh.s.release?.assets.has(n)), [false, true])
    gh.s.failUpload = (name) => name === 'current.next.json'
    const noArm = allBuilt('c')
    delete noArm['matrix-linux-arm64']
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm3'), noArm), stage: join(t.dir, 's3'), sha: c3, repo: REPO, log: quiet, wait: 0 }, gh.gh), /upload current\.next\.json/)
    gh.s.failUpload = null
    assert.ok(gh.s.release?.assets.has('current.json'), 'the record survived')
    assert.equal(JSON.parse(gh.s.release?.assets.get('current.json')?.body.toString('utf8') ?? '{}').commit, c2)
    // The next run finishes, linux-arm64 keeping c2's file; deleting the staged copy loses its answer once.
    let lost = true
    const flaky: Gh = (argv) => {
      if (lost && argv[1] === 'delete-asset' && argv[3] === 'current.next.json') { lost = false; gh.gh(argv); return { ok: false, out: '', err: 'gh: connection reset' } }
      return gh.gh(argv)
    }
    const r = c.publish({ media: artifacts(join(t.dir, 'm4'), noArm), stage: join(t.dir, 's4'), sha: c3, repo: REPO, log: quiet, wait: 0 }, flaky)
    assert.equal(r.status, 'published')
    assert.equal(r.plan.state.targets['linux-arm64'].commit, c2)
    assert.ok(gh.s.release?.assets.has('Crimson.Noir.Agent.City_1.0.0-stable-beta_arm64.deb'))
    assert.ok(!gh.s.release?.assets.has('current.next.json'))
  } finally { t.done() }
})

test('a staged record beside an older current.json is the newest: it goes up as current.json before the staged copy is replaced, so a failed staged upload never steps the record back', () => {
  const t = scratch()
  try {
    const [c1, c2, c3, c4] = [commitOf(1), commitOf(2), commitOf(3), commitOf(4)]
    const gh = fakeGitHub([commitOf(0), c1, c2, c3, c4])
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet }, gh.gh)
    // c2's run uploads its files and the staged record, then current.json's upload fails before gh deletes the old one.
    gh.s.fail = (argv) => (argv[1] === 'upload' && basename(argv[3]) === 'current.json' ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /upload current\.json/)
    gh.s.fail = null
    const recorded = (n: string) => JSON.parse(gh.s.release?.assets.get(n)?.body.toString('utf8') ?? '{}').commit
    assert.deepEqual([recorded('current.json'), recorded('current.next.json')], [c1, c2])
    // c3's run, linux-arm64 failed: its staged record's upload fails after gh deleted c2's.
    const noArm = allBuilt('c')
    delete noArm['matrix-linux-arm64']
    gh.s.failUpload = (name) => name === 'current.next.json'
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm3'), noArm), stage: join(t.dir, 's3'), sha: c3, repo: REPO, log: quiet, wait: 0 }, gh.gh), /upload current\.next\.json/)
    gh.s.failUpload = null
    assert.ok(!gh.s.release?.assets.has('current.next.json'))
    assert.equal(recorded('current.json'), c2, 'current.json holds c2, not c1')
    // c1 is refused as older, and c4 with linux-arm64 failed again keeps c2's arm64 file.
    assert.equal(c.publish({ media: artifacts(join(t.dir, 'm4'), allBuilt('x')), stage: join(t.dir, 's4'), sha: c1, repo: REPO, log: quiet }, gh.gh).status, 'stale')
    const r = c.publish({ media: artifacts(join(t.dir, 'm5'), noArm), stage: join(t.dir, 's5'), sha: c4, repo: REPO, log: quiet }, gh.gh)
    assert.equal(r.status, 'published')
    assert.deepEqual(r.plan.dropped, [])
    assert.equal(r.plan.state.targets['linux-arm64'].commit, c2)
    assert.equal(gh.s.release?.assets.get('Crimson.Noir.Agent.City_1.0.0-stable-beta_arm64.deb')?.body.toString('utf8'), 'arm deb b')
  } finally { t.done() }
})

test('a release with no record gets an empty one before any file, whether its first run stopped before the record or its files were deleted by hand, so a run stopped among its uploads never strands it', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([commitOf(0), c1, c2, c3])
    // The first run makes the tag and the release, then cannot upload the empty record.
    gh.s.fail = (argv) => (argv[1] === 'upload' && basename(argv[3]) === 'current.json' ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, log: quiet, wait: 0 }, gh.gh), /upload an empty current\.json/)
    assert.equal(gh.s.release?.assets.size, 0)
    // The next run stops among its uploads (the macOS image fails).
    const dmg = 'Crimson.Noir.Agent.City_1.0.0-stable-beta_universal.dmg'
    gh.s.fail = (argv) => (argv[1] === 'upload' && basename(argv[3]) === dmg ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('b')), stage: join(t.dir, 's2'), sha: c2, repo: REPO, log: quiet, wait: 0 }, gh.gh), /upload Crimson\.Noir\.Agent\.City_1\.0\.0-stable-beta_universal\.dmg/)
    assert.ok(gh.s.release?.assets.has('current.json') && gh.s.release.assets.size > 1, 'files went up after an empty record')
    gh.s.fail = null
    assert.equal(c.publish({ media: artifacts(join(t.dir, 'm3'), allBuilt('c')), stage: join(t.dir, 's3'), sha: c3, repo: REPO, log: quiet }, gh.gh).status, 'published')
    // Every file deleted by hand: the release is empty, and the same holds.
    for (const n of [...(gh.s.release?.assets.keys() ?? [])]) gh.s.release?.assets.delete(n)
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm4'), allBuilt('d')), stage: join(t.dir, 's4'), sha: c3, repo: REPO, log: quiet, wait: 0 }, (argv: string[]) => (argv[1] === 'upload' && basename(argv[3]) === dmg ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : gh.gh(argv))), /upload Crimson/)
    assert.ok(gh.s.release?.assets.has('current.json'))
    assert.equal(c.publish({ media: artifacts(join(t.dir, 'm5'), allBuilt('d')), stage: join(t.dir, 's5'), sha: c3, repo: REPO, log: quiet }, gh.gh).status, 'published')
  } finally { t.done() }
})

test('the swap goes on when deleting current lost its answer and the read confirming it failed, but a second read finds it gone: the release ends on current at the commit', () => {
  const t = scratch()
  try {
    const [x, y] = [commitOf(31), commitOf(32)]
    const gh = fakeGitHub([commitOf(30), x])
    c.publish({ media: artifacts(join(t.dir, 'm0'), allBuilt('a')), stage: join(t.dir, 's0'), sha: x, repo: REPO, log: quiet }, gh.gh)
    gh.s.history.push(y)
    gh.s.workflows[y] = 'w1'
    // The delete lands with its answer lost; the retry hears "Reference does not exist"; the read confirming it fails once.
    let step = 0
    const flaky: Gh = (argv) => {
      const path = argv[argv.length - 1]
      if (step === 0 && argv.includes('DELETE') && path.endsWith('git/refs/tags/current')) { step = 1; gh.gh(argv); return { ok: false, out: '', err: 'gh: connection reset' } }
      if (step === 1 && !argv.includes('-X') && path.endsWith('git/ref/tags/current')) { step = 2; return { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } }
      return gh.gh(argv)
    }
    const r = c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('b')), stage: join(t.dir, 's1'), sha: y, repo: REPO, log: quiet, wait: 0 }, flaky)
    assert.equal(step, 2, 'both faults happened')
    assert.equal(r.status, 'published')
    assert.deepEqual(r.tag, { at: y, how: 'remade' })
    assert.deepEqual([...gh.s.refs.entries()], [['current', y]])
    assert.equal(gh.s.release?.tag, 'current')
    assert.equal(gh.s.everDraft, false)
  } finally { t.done() }
})

test('pick builds a commit again when a second publish of it stopped after its record, though the first one\'s notes name the commit: SHA256SUMS must list the recorded files and the notes carry that publish\'s time', () => {
  const t = scratch()
  try {
    const c1 = commitOf(1)
    const gh = fakeGitHub([commitOf(0), c1])
    const [t1, t2] = ['2026-11-13T02:00:00.000Z', '2026-11-13T03:00:00.000Z']
    c.publish({ media: artifacts(join(t.dir, 'm1'), allBuilt('a')), stage: join(t.dir, 's1'), sha: c1, repo: REPO, time: t1, log: quiet }, gh.gh)
    assert.ok(c.pick({ sha: c1, repo: REPO }, gh.gh).skip)
    const noSums = (argv: string[]) => (argv[1] === 'upload' && basename(argv[3]) === 'SHA256SUMS' ? { ok: false, out: '', err: 'gh: Bad Gateway (HTTP 502)' } : null)
    // The same bytes again, stopped before SHA256SUMS: only the notes' time tells the publishes apart.
    gh.s.fail = noSums
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm2'), allBuilt('a')), stage: join(t.dir, 's2'), sha: c1, repo: REPO, time: t2, log: quiet, wait: 0 }, gh.gh), /upload SHA256SUMS/)
    gh.s.fail = null
    assert.equal(c.pick({ sha: c1, repo: REPO }, gh.gh).sha, c1)
    // New bytes under the first publish's time, stopped the same way: SHA256SUMS no longer lists the recorded files.
    c.publish({ media: artifacts(join(t.dir, 'm3'), allBuilt('a')), stage: join(t.dir, 's3'), sha: c1, repo: REPO, time: t1, log: quiet }, gh.gh)
    assert.ok(c.pick({ sha: c1, repo: REPO }, gh.gh).skip)
    gh.s.fail = noSums
    assert.throws(() => c.publish({ media: artifacts(join(t.dir, 'm4'), allBuilt('b')), stage: join(t.dir, 's4'), sha: c1, repo: REPO, time: t1, log: quiet, wait: 0 }, gh.gh), /upload SHA256SUMS/)
    gh.s.fail = null
    assert.equal(c.pick({ sha: c1, repo: REPO }, gh.gh).sha, c1)
  } finally { t.done() }
})

test('a re-run of the failed jobs, which keeps an earlier attempt\'s pick, fails when a newer commit on main is green, so someone runs the workflow by hand', () => {
  const t = scratch()
  const err: string[] = []
  const error = console.error
  console.error = (...a: unknown[]) => { err.push(a.join(' ')) }
  try {
    const [c1, c2] = [commitOf(1), commitOf(2)]
    const gh = fakeGitHub([c1, c2], { green: [c1, c2] })
    const run = (sha: string, dir: string, extra: string[]) => c.main(['publish', '--repo', REPO, '--media', artifacts(join(t.dir, dir), allBuilt(dir)), '--sha', sha, '--stage', join(t.dir, `s-${dir}`), ...extra], gh.gh)
    assert.equal(run(c1, 'a', ['--reused-pick']), 1)
    assert.match(err.splice(0).join('\n'), new RegExp(`::error::this re-run kept the commit an earlier attempt picked, ${c1}, and published it; ${c2} is newer and ci passed on it`))
    assert.equal(JSON.parse(gh.s.release?.assets.get('current.json')?.body.toString('utf8') ?? '{}').commit, c1, 'what it built is still published')
    // GitHub not answering the comparison is said in red too, not taken for "nothing newer".
    // (Only once this run has written its notes: the publish itself asks the same question first.)
    const mark = gh.s.calls.length
    gh.s.fail = (argv) => (argv[argv.length - 1].includes(`compare/${c1}...${c2}`) && gh.s.calls.slice(mark).some((a) => a[1] === 'edit') ? { ok: false, out: '', err: 'gh: You have exceeded a secondary rate limit (HTTP 403)' } : null)
    assert.equal(run(c1, 'a2', ['--reused-pick']), 1)
    assert.match(err.splice(0).join('\n'), new RegExp(`::error::this re-run kept .*; GitHub could not compare that with ${c2}, the newest commit on main ci passed on \\(no answer\\)`))
    gh.s.fail = null
    assert.equal(run(c2, 'b', ['--reused-pick']), 0, 'the newest green: nothing to say')
    assert.equal(run(c1, 'c', ['--reused-pick']), 0, 'stale, but the release already holds the newest green commit: nothing to say')
    assert.deepEqual(err.splice(0), [])
    assert.equal(run(c1, 'd', []), 0, 'a first attempt: stale, and quiet')
  } finally {
    console.error = error
    t.done()
  }
})

test('pick: the newest commit on main that ci passed on, whichever commit started the run, unless the release holds it for every target already (force builds it again) or holds a newer one; refused off main or with nothing green', () => {
  const t = scratch()
  try {
    const [c1, c2, c3] = [commitOf(1), commitOf(2), commitOf(3)]
    const gh = fakeGitHub([c1, c2, c3], { green: [c1, c2] })
    assert.deepEqual(c.pick({ sha: c2, repo: REPO }, gh.gh), { sha: c2, ci: ciUrl(c2), note: '' }, 'behind main\'s tip is still on main')
    // A run that took a waiting one's place (a re-run for an older commit, a run by hand before the tip passed ci)
    // builds the newest green commit all the same.
    const older = c.pick({ sha: c1, repo: REPO }, gh.gh)
    assert.equal(older.sha, c2)
    assert.equal(older.ci, ciUrl(c2))
    assert.match(older.note, new RegExp(`building ${c2}, the newest commit on main that ci passed on \\(this run was started for ${c1}\\)`))
    assert.equal(c.pick({ sha: c3, repo: REPO }, gh.gh).sha, c2, 'main\'s tip has not passed ci yet')
    assert.match(c.pick({ sha: commitOf(42), repo: REPO }, gh.gh).skip, /is not on main/)
    assert.equal(c.pick({ sha: 'main', repo: REPO }, gh.gh).refused, true)
    const none = c.pick({ sha: c3, repo: REPO }, fakeGitHub([c1, c2, c3], { green: [] }).gh)
    assert.equal(none.refused, true, 'nothing green, and a fork\'s run from its own main does not count')
    assert.match(none.skip, /ci has not passed/)
    c.publish({ media: artifacts(join(t.dir, 'm'), allBuilt('a')), stage: join(t.dir, 's'), sha: c2, repo: REPO, log: quiet }, gh.gh)
    const done = c.pick({ sha: c2, repo: REPO }, gh.gh)
    assert.match(done.skip, /already holds .* for every required target/)
    assert.equal(done.refused, false)
    assert.equal(c.pick({ sha: c2, force: true, repo: REPO }, gh.gh).sha, c2)
    c.publish({ media: artifacts(join(t.dir, 'm3'), allBuilt('c')), stage: join(t.dir, 's3'), sha: c3, repo: REPO, log: quiet }, gh.gh)
    const behind = c.pick({ sha: c1, repo: REPO }, gh.gh)
    assert.match(behind.skip, new RegExp(`already holds ${c3}, which is newer than ${c2}`))
    assert.equal(behind.refused, false)
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
    assert.deepEqual(out.splice(0), [`sha=${c1}\nci=${ciUrl(c1)}`])
    assert.equal(c.main(['pick', '--sha', c2, '--strict', '--repo', REPO], gh.gh), 0, 'run by hand before the tip passed ci')
    assert.deepEqual(out.splice(0), [`sha=${c1}\nci=${ciUrl(c1)}`], 'the newest green commit')
    assert.match(err.splice(0).join('\n'), new RegExp(`::notice::building ${c1}`))
    const off = commitOf(77)
    assert.equal(c.main(['pick', '--sha', off, '--repo', REPO], gh.gh), 0)
    assert.deepEqual(out.splice(0), [], 'refused: nothing for the outputs')
    assert.match(err.splice(0).join('\n'), /::notice::.* is not on main/)
    assert.equal(c.main(['pick', '--sha', off, '--strict', '--repo', REPO], gh.gh), 1)
    assert.match(err.splice(0).join('\n'), /::error::.* is not on main/)
    assert.equal(c.main(['pick', '--sha', c2, '--strict', '--repo', REPO], fakeGitHub([c1, c2], { green: [] }).gh), 1)
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
  // A run by hand joins the one queue only on main: elsewhere it is refused by pick, and must not take a real run's place.
  assert.match(WORKFLOW, /\(\(\(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\) \|\|\n/)
  assert.equal((WORKFLOW.match(/github\.event_name == 'workflow_dispatch'/g) ?? []).length, 2, 'the queue and the pick job')
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
