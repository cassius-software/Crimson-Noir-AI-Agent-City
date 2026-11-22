// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins tools/verify/site_budget.mjs, the check that refuses what GitHub would not
 * publish: the web copy (dist-web/, the site's model beside the page) at most 950,000,000 bytes, under the 1 GB GitHub
 * Pages publishes for a site, and every release file under 2 GiB, which GitHub refuses as a release asset. It pins
 * both numbers, shows each check passing a good input and failing a bad one by name (at the exact edges: the copy at
 * its budget and one byte over, a file one byte under 2 GiB and at 2 GiB), how links are measured (followed; a link
 * to nothing or back into its own folder fails), that the command line takes no limit, that macAudit.mjs takes the
 * 2 GiB from here, and that every workflow step that uploads the web copy or a release file runs the check first,
 * unconditionally, with the tool read from the workflow's own commit rather than an older commit the job bakes or
 * builds: web.yml, build-matrix.yml, current.yml (both jobs), build-release.yml and windows-app.yml; and that those
 * workflow rules refuse each way around them. The big files are sparse (fs.truncate): their sizes are real to fs.stat
 * and the disk holds almost none of them.
 * What breaks if it is removed? A limit could move, a workflow could lose its check or skip it, a re-bake of an old
 * tag could fail on a tool its commit lacks, or a link could hide a big file, and nothing would say so until GitHub
 * refused an upload or a release went stale.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A computed specifier: the script is tooling under tools/, outside the page's build, loaded as the test's own module.
const BUDGET: string = '../tools/verify/site_budget.mjs'
const MAC: string = '../tools/build/macAudit.mjs'
const s = await import(BUDGET)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'tools', 'verify', 'site_budget.mjs')
const workflow = (name: string): string => readFileSync(join(ROOT, '.github', 'workflows', name), 'utf8')

interface Measured { path: string; size: number }
interface Report { line: string; problems: string[] }

const GIB2 = 2 * 1024 ** 3
// Sparse files on NTFS take their whole size on the disk, and links there need developer mode: these run elsewhere.
const NEEDS_SPARSE = process.platform === 'win32' && 'sparse files and symbolic links (not on Windows)'

/** `text` matched literally inside a regular expression. */
const esc = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** A fresh folder for one test's fixtures, removed by `done()`. */
function fixture(): { root: string; done: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'site-budget-'))
  return { root, done: () => rmSync(root, { recursive: true, force: true }) }
}
/** A file of exactly `size` bytes that holds almost nothing on the disk. */
function sparse(path: string, size: number): string {
  writeFileSync(path, '')
  truncateSync(path, size)
  assert.equal(statSync(path).size, size, path)
  return path
}
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })

test('the limits: 950,000,000 bytes for the web copy, 2 GiB for a release file, and the 2 GiB macAudit.mjs checks is this one', async () => {
  assert.equal(s.SITE_BUDGET, 950_000_000)
  assert.equal(s.ASSET_LIMIT, 2_147_483_648)
  assert.equal(s.ASSET_LIMIT, GIB2)
  const mac = await import(MAC)
  assert.equal(mac.ASSET_LIMIT, s.ASSET_LIMIT)
  const src = readFileSync(join(ROOT, 'tools', 'build', 'macAudit.mjs'), 'utf8')
  assert.match(src, /^import \{ ASSET_LIMIT \} from '\.\.\/verify\/site_budget\.mjs'$/m)
  assert.match(src, /^export \{ ASSET_LIMIT \}$/m)
  assert.doesNotMatch(src, /ASSET_LIMIT\s*=|1024 \*\* 3|2 \*\* 31|2_?147_?483_?648/, 'no second definition of 2 GiB')
})

test('no workflow can move a limit or skip a check: the command line takes no flag, the tool reads no environment variable', () => {
  const src = readFileSync(SCRIPT, 'utf8')
  assert.doesNotMatch(src, /process\.env|getenv/)
  for (const argv of [['site', 'dist-web', '--budget', '1'], ['site', '--budget=1', 'dist-web'], ['assets', '--limit', '1', 'out'], ['assets', '-f', 'out'], ['site'], ['site', 'a', 'b'], ['assets'], ['size', 'out'], []]) {
    const r = run(...argv)
    assert.equal(r.status, 2, argv.join(' '))
    assert.equal(r.stderr.trim(), s.USAGE)
  }
  // main() takes the arguments and where to print, nothing else; only the pure checks take another limit, for a test.
  assert.equal(s.main.length, 1)
  assert.equal(s.siteReport('d', [{ path: 'd/a', size: 11 }], 10).problems.length, 1)
  assert.equal(s.assetReport({ path: 'a', size: 10 }, 10).problems.length, 1)
})

test('the edges, by size alone: the copy at exactly its budget passes and one byte over fails; a file one byte under 2 GiB passes and one at 2 GiB fails', () => {
  const site = (sizes: number[]): Report => s.siteReport('dist-web', sizes.map((size, i): Measured => ({ path: `dist-web/f${i}`, size })))
  const at = site([7_000_000, 943_000_000])
  assert.equal(at.line, 'site_budget: site dist-web 950000000 bytes in 2 files (budget: at most 950000000): ok')
  assert.deepEqual(at.problems, [])
  const over = site([7_000_000, 943_000_001])
  assert.equal(over.line, 'site_budget: site dist-web 950000001 bytes in 2 files (budget: at most 950000000): over by 1 byte')
  assert.deepEqual(over.problems, ["dist-web is 950000001 bytes, over the web copy's budget of 950000000 (GitHub Pages publishes no site over 1 GB); its largest files: dist-web/f1 (943000001), dist-web/f0 (7000000)"])
  // Over by more, with many files: the five largest are named, largest first.
  const many = site([1, 2, 3, 4, 5, 6, 950_000_000])
  assert.match(many.line, /950000021 bytes in 7 files .*: over by 21 bytes$/)
  assert.match(many.problems[0]!, /its largest files: dist-web\/f6 \(950000000\), dist-web\/f5 \(6\), dist-web\/f4 \(5\), dist-web\/f3 \(4\), dist-web\/f2 \(3\)$/)
  assert.equal(s.siteReport('dist-web', []).line, 'site_budget: site dist-web 0 bytes in 0 files (budget: at most 950000000): ok')

  const asset = (size: number): Report => s.assetReport({ path: 'out/macos-universal/x.dmg', size })
  const under = asset(GIB2 - 1)
  assert.equal(under.line, 'site_budget: asset out/macos-universal/x.dmg 2147483647 bytes (limit: under 2147483648): ok')
  assert.deepEqual(under.problems, [])
  const limit = asset(GIB2)
  assert.equal(limit.line, 'site_budget: asset out/macos-universal/x.dmg 2147483648 bytes (limit: under 2147483648): too big')
  assert.deepEqual(limit.problems, ['out/macos-universal/x.dmg is 2147483648 bytes, not under the 2147483648-byte limit (GitHub refuses a release asset of 2 GiB or more)'])
  assert.equal(asset(GIB2 + 1).problems.length, 1)
  assert.deepEqual(asset(0).problems, [])
})

test('walk: every file at any depth, sorted by name, at the size it holds; a folder itself counts nothing; a missing path is named', () => {
  const t = fixture()
  try {
    const d = join(t.root, 'site')
    mkdirSync(join(d, 'models', 'deep'), { recursive: true })
    mkdirSync(join(d, 'empty'))
    writeFileSync(join(d, 'index.html'), 'x'.repeat(1000))
    writeFileSync(join(d, '.nojekyll'), '')
    writeFileSync(join(d, 'models', 'LICENSE'), 'y'.repeat(300))
    writeFileSync(join(d, 'models', 'deep', 'b.bin'), 'z'.repeat(7))
    const w = s.walk(d)
    assert.deepEqual(w.problems, [])
    assert.deepEqual(w.files, [
      { path: join(d, '.nojekyll'), size: 0 },
      { path: join(d, 'index.html'), size: 1000 },
      { path: join(d, 'models', 'LICENSE'), size: 300 },
      { path: join(d, 'models', 'deep', 'b.bin'), size: 7 },
    ])
    assert.deepEqual(s.walk(join(d, 'index.html')).files, [{ path: join(d, 'index.html'), size: 1000 }], 'a file is itself')
    assert.deepEqual(s.walk(join(d, 'empty')), { files: [], problems: [] })
    assert.deepEqual(s.walk(join(d, 'nope')), { files: [], problems: [`${join(d, 'nope')} does not exist`] })
  } finally { t.done() }
})

test('links: followed, so the file a link names counts at its own size and a linked folder is walked; a link to nothing, a link to itself, a link back to a folder that holds it and a pipe each fail by name', { skip: NEEDS_SPARSE }, () => {
  const t = fixture()
  try {
    const outside = join(t.root, 'outside')
    mkdirSync(join(outside, 'inner'), { recursive: true })
    sparse(join(outside, 'big.gguf'), 900_000_000)
    writeFileSync(join(outside, 'inner', 'c.txt'), 'abc')
    const d = join(t.root, 'site')
    mkdirSync(d)
    symlinkSync(join(outside, 'big.gguf'), join(d, 'model.gguf'))
    symlinkSync(join(outside, 'inner'), join(d, 'linked'))
    const w = s.walk(d)
    assert.deepEqual(w.problems, [])
    assert.deepEqual(w.files, [{ path: join(d, 'linked', 'c.txt'), size: 3 }, { path: join(d, 'model.gguf'), size: 900_000_000 }])
    // A link that names nothing, one that names itself, and one back to a folder above it cannot be measured.
    symlinkSync(join(t.root, 'gone'), join(d, 'dangling'))
    symlinkSync('self', join(d, 'self'))
    mkdirSync(join(d, 'a', 'b'), { recursive: true })
    symlinkSync('../..', join(d, 'a', 'b', 'up'))
    const bad = s.walk(d)
    assert.deepEqual(bad.problems, [
      `${join(d, 'a', 'b', 'up')} is a link back to ${realpathSync(d)}, a folder that holds it: it cannot be measured`,
      `${join(d, 'dangling')} is a symbolic link to ${join(t.root, 'gone')}, which does not exist: it cannot be measured`,
      `${join(d, 'self')} is a symbolic link that loops (to self): it cannot be measured`,
    ])
    assert.deepEqual(bad.files, w.files, 'the files around them are still measured')
    // Anything that is neither a file nor a folder (a named pipe here) is named too.
    const fifo = join(t.root, 'pipe')
    if (spawnSync('mkfifo', [fifo]).status === 0) assert.deepEqual(s.walk(fifo).problems, [`${fifo} is neither a file nor a folder`])
    // A link whose target cannot be looked up for a reason other than its absence gives that reason, never "does not
    // exist": a name too long for the system here, and (where permissions bind, so not as root) a folder it cannot enter.
    const far = join(t.root, 'far')
    mkdirSync(far)
    symlinkSync('n'.repeat(300), join(far, 'long'))
    const long = s.walk(far).problems
    assert.equal(long.length, 1, long.join('\n'))
    assert.match(long[0], new RegExp(`^${esc(join(far, 'long'))} is a symbolic link to n{300}: ENAMETOOLONG: .+: it cannot be measured$`))
    if (process.getuid?.() !== 0) {
      const locked = join(t.root, 'locked')
      mkdirSync(locked)
      const big = sparse(join(locked, 'big.gguf'), 900_000_000)
      const site = join(t.root, 'behind')
      mkdirSync(site)
      symlinkSync(big, join(site, 'model.gguf'))
      chmodSync(locked, 0o000)
      try {
        const shut = s.walk(site).problems
        assert.equal(shut.length, 1, shut.join('\n'))
        assert.match(shut[0], new RegExp(`^${esc(join(site, 'model.gguf'))} is a symbolic link to ${esc(big)}: EACCES: .+: it cannot be measured$`))
      } finally { chmodSync(locked, 0o755) }
    }
  } finally { t.done() }
})

test('the command line, site: a copy of exactly 950,000,000 bytes passes, one byte more fails naming the folder and its largest file; a linked file counts; a file or a missing folder fails', { skip: NEEDS_SPARSE }, () => {
  const t = fixture()
  try {
    const d = join(t.root, 'dist-web')
    mkdirSync(join(d, 'models'), { recursive: true })
    writeFileSync(join(d, 'index.html'), 'x'.repeat(1000))
    sparse(join(d, 'models', 'm.gguf'), s.SITE_BUDGET - 1000)
    const at = run('site', d)
    assert.equal(at.status, 0, at.stderr)
    assert.equal(at.stdout, `site_budget: site ${d} 950000000 bytes in 2 files (budget: at most 950000000): ok\n`)
    assert.equal(at.stderr, '')
    writeFileSync(join(d, 'build.txt'), 'z')
    const over = run('site', d)
    assert.equal(over.status, 1)
    assert.equal(over.stdout, `site_budget: site ${d} 950000001 bytes in 3 files (budget: at most 950000000): over by 1 byte\n`)
    assert.equal(over.stderr, `::error::site_budget: ${d} is 950000001 bytes, over the web copy's budget of 950000000 (GitHub Pages publishes no site over 1 GB); its largest files: ${join(d, 'models', 'm.gguf')} (949999000), ${join(d, 'index.html')} (1000), ${join(d, 'build.txt')} (1)\n`)
    // A link inside the copy to a file outside it counts at that file's size.
    const e = join(t.root, 'linked-web')
    mkdirSync(e)
    writeFileSync(join(e, 'index.html'), 'x')
    symlinkSync(sparse(join(t.root, 'elsewhere.gguf'), s.SITE_BUDGET), join(e, 'model.gguf'))
    const linked = run('site', e)
    assert.equal(linked.status, 1)
    assert.match(linked.stderr, new RegExp(`its largest files: ${join(e, 'model.gguf').replace(/[.\\]/g, '\\$&')} \\(950000000\\)`))
    // Not a folder: a file, or nothing there.
    // Not a folder: a file, nothing there, or a link to nothing. Each fails by name, and the line gives no size and no
    // verdict, since nothing was measured ("0 bytes ... ok" would be false).
    const file = run('site', join(d, 'index.html'))
    assert.equal(file.status, 1)
    assert.equal(file.stdout, `site_budget: site ${join(d, 'index.html')}: not measured (1 problem)\n`)
    assert.match(file.stderr, new RegExp(`::error::site_budget: ${join(d, 'index.html').replace(/[.\\]/g, '\\$&')} is not a folder`))
    const missing = run('site', join(t.root, 'nope'))
    assert.equal(missing.status, 1)
    assert.equal(missing.stdout, `site_budget: site ${join(t.root, 'nope')}: not measured (1 problem)\n`)
    assert.match(missing.stderr, /nope does not exist/)
    symlinkSync(join(t.root, 'nowhere'), join(t.root, 'to-nothing'))
    const dangling = run('site', join(t.root, 'to-nothing'))
    assert.equal(dangling.status, 1)
    assert.equal(dangling.stdout, `site_budget: site ${join(t.root, 'to-nothing')}: not measured (1 problem)\n`)
    // A folder with something in it that cannot be measured: the files around it are not a total to judge.
    symlinkSync(join(t.root, 'nowhere'), join(e, 'gone.bin'))
    const partial = run('site', e)
    assert.equal(partial.status, 1)
    assert.equal(partial.stdout, `site_budget: site ${e}: not measured (1 problem)\n`)
    assert.equal(partial.stderr, `::error::site_budget: ${join(e, 'gone.bin')} is a symbolic link to ${join(t.root, 'nowhere')}, which does not exist: it cannot be measured\n`)
  } finally { t.done() }
})

test('the command line, assets: a file of exactly 2 GiB fails by name and one a byte less passes, one line each; folders are walked; a folder with no file passes; a missing path fails by name; a run through a link checks too', { skip: NEEDS_SPARSE }, () => {
  const t = fixture()
  try {
    const out = join(t.root, 'out')
    mkdirSync(join(out, 'sub'), { recursive: true })
    const ok = sparse(join(out, 'a.dmg'), GIB2 - 1)
    writeFileSync(join(out, 'sub', 'SHA256SUMS'), 'x'.repeat(64))
    const pass = run('assets', out)
    assert.equal(pass.status, 0, pass.stderr)
    assert.equal(pass.stdout, `site_budget: asset ${ok} 2147483647 bytes (limit: under 2147483648): ok\nsite_budget: asset ${join(out, 'sub', 'SHA256SUMS')} 64 bytes (limit: under 2147483648): ok\n`)
    const big = sparse(join(out, 'b.app.zip'), GIB2)
    const fail = run('assets', out)
    assert.equal(fail.status, 1)
    assert.match(fail.stdout, new RegExp(`^site_budget: asset ${big.replace(/[.\\]/g, '\\$&')} 2147483648 bytes \\(limit: under 2147483648\\): too big$`, 'm'))
    assert.match(fail.stdout, /a\.dmg 2147483647 bytes \(limit: under 2147483648\): ok$/m, 'the file under the limit still passes')
    assert.equal(fail.stderr, `::error::site_budget: ${big} is 2147483648 bytes, not under the 2147483648-byte limit (GitHub refuses a release asset of 2 GiB or more)\n`)
    // Several paths, a file named alone, and a folder with no file in it.
    const empty = join(t.root, 'empty')
    mkdirSync(empty)
    const several = run('assets', ok, empty)
    assert.equal(several.status, 0, several.stderr)
    assert.match(several.stdout, new RegExp(`^site_budget: asset ${empty.replace(/[.\\]/g, '\\$&')}: no files$`, 'm'))
    assert.equal(run('assets', big).status, 1)
    const missing = run('assets', ok, join(t.root, 'gone.msi'))
    assert.equal(missing.status, 1)
    assert.equal(missing.stderr, `::error::site_budget: ${join(t.root, 'gone.msi')} does not exist\n`)
    // Run through a link to the script (a checkout reached by a link), it still checks rather than exit 0 unseen.
    const link = join(t.root, 'site_budget.mjs')
    symlinkSync(SCRIPT, link)
    const linked = spawnSync(process.execPath, [link, 'assets', big], { encoding: 'utf8' })
    assert.equal(linked.status, 1, linked.stderr)
    assert.match(linked.stderr, /b\.app\.zip is 2147483648 bytes/)
  } finally { t.done() }
})

// ---- The workflows -----------------------------------------------------------------------------------------------

/** One job of a workflow: from its `  name:` line to the next job. */
function jobOf(yml: string, name: string): string {
  const jobs = yml.split(/^jobs:$/m)[1] ?? ''
  const job = (jobs.split(new RegExp(`^ {2}${name}:$`, 'm'))[1] ?? '').split(/^ {2}[a-z-]+:$/m)[0] ?? ''
  assert.ok(job.length > 0, `job ${name}`)
  return job
}
/** One step of a job: from its `- name:` (or `- uses:`) line to the next step. */
function stepOf(job: string, marker: string): string {
  const at = job.indexOf(marker)
  assert.ok(at > 0, marker)
  const start = job.lastIndexOf('\n      - ', at)
  const next = job.indexOf('\n      - ', at)
  return job.slice(start, next < 0 ? undefined : next)
}
/** The index of each marker in `text`, asserting each is there and they come in this order. */
function inOrder(text: string, markers: string[]): void {
  const at = markers.map((m) => text.indexOf(m))
  markers.forEach((m, k) => assert.ok(at[k]! >= 0, `missing: ${m}`))
  assert.ok(at.every((i, k) => k === 0 || i > at[k - 1]!), `in order: ${markers.join(' < ')}`)
}
/**
 * A check step runs on every run of its job and its failure fails the job: no `if:` (as its first key, where the step
 * starts, or any other), no continue-on-error, and no `||` after the command (`|| true`, `|| :`, `|| exit 0`,
 * `|| echo`), each of which turns a failed check into a skip.
 */
function unconditional(step: string): void {
  assert.doesNotMatch(step, /(?:^|\n)\s*if:|continue-on-error|\|\|/, step)
}
/** The steps of a job, each from just after its `- ` to the next step. */
const stepsOf = (job: string): string[] => job.split('\n      - ').slice(1)

interface Checkout { ref: string | undefined; path: string; sparse: string[] | undefined }
/** What a step checks out (its ref, its path, its sparse paths on one line or as a block), or null for another step. */
function checkoutOf(step: string): Checkout | null {
  if (!/(?:^|\n)\s*uses: actions\/checkout@v\d+\n/.test(step)) return null
  const input = (key: string): string | undefined => step.match(new RegExp(`\\n {10}${key}: (.*)`))?.[1]
  let sparse = input('sparse-checkout')?.split(/\s+/)
  if (sparse?.[0] === '|') {
    sparse = []
    for (const line of (step.split(/\n {10}sparse-checkout: \|\n/)[1] ?? '').split('\n')) {
      if (!/^ {12}\S/.test(line)) break
      sparse.push(line.trim())
    }
  }
  return { ref: input('ref'), path: input('path') ?? '', sparse }
}
/** Each run of the tool in a workflow, and the folder its script is read from (`''` for the workspace). */
const TOOL = /node (\S*)tools\/verify\/site_budget\.mjs/g
/** The checkout the tool comes from in build-release.yml, build-matrix.yml and windows-app.yml. */
const SIZE_CHECKOUT = 'uses: actions/checkout@v4\n        with:\n          ref: ${{ github.sha }}\n          path: .size-check\n          sparse-checkout: tools/verify\n          persist-credentials: false\n'
/**
 * Every run of the tool in a job reads the script from the commit the workflow file came from (github.sha), never
 * from an older commit the job checks out to build or bake, which may not hold the tool. The checkout the run reads
 * from (the workspace, or the folder its script path starts with) is the last one at that path before the step and
 * runs unconditionally; it takes github.sha, or no ref (the default checkout is that commit), or a ref in `own` that
 * the caller has shown is that commit; a sparse one holds tools/verify; no checkout of the workspace after it cleans it
 * away; and the step has no working-directory. Returns how many runs it checked.
 */
function fromOwnCommit(job: string, own: string[] = []): number {
  const steps = stepsOf(job)
  let runs = 0
  steps.forEach((step, k) => {
    for (const [, dir] of step.matchAll(TOOL)) {
      runs++
      const path = dir!.replace(/\/+$/, '')
      const where = path || 'the workspace'
      assert.doesNotMatch(step, /working-directory:/, `the check runs where its checkout put the tool: ${step}`)
      const before = steps.slice(0, k).map(checkoutOf)
      const at = before.findLastIndex((c) => c !== null && c.path === path)
      assert.ok(at >= 0, `a checkout at ${where} comes before: ${step}`)
      const co = before[at]!
      assert.ok(co.ref === undefined || co.ref === '${{ github.sha }}' || own.includes(co.ref),
        `the check reads the tool at ${where} from the workflow's own commit, not ${co.ref}: ${step}`)
      if (co.sparse) {
        assert.ok(co.sparse.some((p) => 'tools/verify/site_budget.mjs'.startsWith(`${p.replace(/\/+$/, '')}/`)),
          `the sparse checkout at ${where} holds the tool: ${co.sparse.join(' ')}`)
      }
      if (path) assert.ok(before.slice(at + 1).every((c) => c === null || c.path !== ''), `no checkout of the workspace after ${where}`)
      unconditional(steps[at]!)
    }
  })
  return runs
}

test('every workflow that uploads the web copy or a release file runs the check first, on what it uploads, unconditionally, from the workflow\'s own commit', () => {
  const CALL = 'node tools/verify/site_budget.mjs'
  const OWN = 'node .size-check/tools/verify/site_budget.mjs'
  const calls: Record<string, number> = {}
  for (const name of ['web.yml', 'build-matrix.yml', 'current.yml', 'build-release.yml', 'windows-app.yml']) {
    const yml = workflow(name)
    calls[name] = [...yml.matchAll(TOOL)].length
    for (const st of yml.split('\n      - ').filter((x) => x.match(TOOL))) unconditional(st)
  }
  assert.deepEqual(calls, { 'web.yml': 1, 'build-matrix.yml': 1, 'current.yml': 2, 'build-release.yml': 1, 'windows-app.yml': 1 })
  let fromOwn = 0

  // web.yml: the whole copy, after the model and the speech pack are placed in it and before the Pages upload. Its build checks out the
  // commit pick names: the newest commit on main that ci passed on (tools/build/current.mjs web-pick), or by hand
  // with "tip" main as it is. That commit can be older than the workflow file that runs (a workflow_run runs main's
  // own file, at main's tip), so the tool it calls must be in every commit ci can still pass on: this one has been
  // in main since 22 November 2026 (#166), before web.yml began to publish anything but the tip.
  const webYml = workflow('web.yml')
  const web = jobOf(webYml, 'build')
  inOrder(web, [
    'run: node tools/web/siteModel.mjs place --from "$RUNNER_TEMP/site-model" --out dist-web',
    'run: node tools/web/speechPack.mjs place --from "$RUNNER_TEMP/speech-pack" --out dist-web',
    `run: ${CALL} site dist-web\n`,
    'uses: actions/upload-pages-artifact@v3',
  ])
  assert.match(stepOf(web, 'uses: actions/upload-pages-artifact@v3'), /path: dist-web(?:\n|$)/, 'the folder checked is the folder uploaded')
  const pick = jobOf(webYml, 'pick')
  assert.equal(pick.split('echo "sha=').length - 1, 1, 'pick names a commit itself in one place alone: main as it is, by hand with "tip"')
  assert.match(pick, /if \[ "\$TIP" = true \]; then\n[^\n]+\n {14}echo "sha=\$GITHUB_SHA" >> "\$GITHUB_OUTPUT"\n/)
  assert.match(pick, /\n {10}node tools\/build\/current\.mjs web-pick "\$\{args\[@\]\}" \| tee -a "\$GITHUB_OUTPUT"\n/)
  fromOwn += fromOwnCommit(web, ['${{ needs.pick.outputs.sha }}'])

  // build-matrix.yml: each target's folder, after every check of the build and before its upload, which takes that folder.
  // It builds the call's commit (current.yml's ref) or a tag's, which may predate the tool: the tool is checked out
  // from the workflow's own commit beside it.
  const bm = workflow('build-matrix.yml')
  const build = jobOf(bm, 'build')
  inOrder(build, ['node tools/build/matrix.mjs --targets "${{ matrix.target }}" --out out', 'linuxAudit.mjs symbols', 'nativeE2e.mjs --packaged',
    'macAudit.mjs slices', 'tools/boot_test.py "$media.iso"', SIZE_CHECKOUT, `run: ${OWN} assets "out/\${{ matrix.target }}"\n`, 'name: matrix-${{ matrix.target }}'])
  assert.match(stepOf(build, 'name: matrix-${{ matrix.target }}'), /path: out\/\$\{\{ matrix\.target \}\}\/(?:\n|$)/)
  fromOwn += fromOwnCommit(build)
  // The release job uploads the very files the build jobs checked (artifacts carry them as they are), and a pull request
  // that changes the check runs the build matrix on real files.
  assert.match(jobOf(bm, 'release'), /pattern: matrix-\*\n/)
  assert.ok(bm.includes('      - tools/verify/site_budget.mjs\n'))

  // current.yml: every artifact it downloaded, before the publish (and its dry run) reads them; the tool comes from
  // the job's own default checkout of tools/.
  const cur = workflow('current.yml')
  for (const [job, publish] of [['publish', 'node tools/build/current.mjs publish --media media'], ['dry-run', 'node tools/build/current.mjs publish --dry-run --media media']] as const) {
    const j = jobOf(cur, job)
    inOrder(j, ['uses: actions/download-artifact@v4', `${CALL} assets media`, publish])
    assert.match(stepOf(j, `${CALL} assets media`), /mkdir -p media\n {10}node tools\/verify\/site_budget\.mjs assets media$/, job)
    fromOwn += fromOwnCommit(j)
  }

  // build-release.yml: the baked media, sums and notices included, after the sums and before the artifact the publish
  // job uploads as the release's files; Node set up first. A dispatch for a tag that exists bakes that tag's commit,
  // older than the tool for every tag made before it: the tool comes from the workflow's own commit.
  const bake = jobOf(workflow('build-release.yml'), 'bake')
  inOrder(bake, ['> SHA256SUMS', 'uses: actions/setup-node@v4', SIZE_CHECKOUT, `run: ${OWN} assets "$RUNNER_TEMP/media"\n`, 'uses: actions/upload-artifact@v4'])
  assert.match(bake, /- uses: actions\/checkout@v4\n {8}with:\n {10}ref: \$\{\{ steps\.ref\.outputs\.ref \}\}\n/, 'the bake itself is of the tag\'s commit')
  assert.match(stepOf(bake, 'uses: actions/upload-artifact@v4'), /path: \$\{\{ runner\.temp \}\}\/media\/(?:\n|$)/)
  assert.match(jobOf(workflow('build-release.yml'), 'publish'), /gh release upload "\$TAG" media\/\* --clobber/)
  fromOwn += fromOwnCommit(bake)

  // windows-app.yml: the three folders the build collects, before the three uploads, each of which takes one of them;
  // the tool from the workflow's own commit, as in build-matrix.yml.
  const win = jobOf(workflow('windows-app.yml'), 'build')
  const folders = ['out/installer', 'out/msi', 'out/portable']
  inOrder(win, ['ls -l out/installer out/msi out/portable', SIZE_CHECKOUT, `run: ${OWN} assets ${folders.join(' ')}\n`, 'uses: actions/upload-artifact@v4'])
  const check = win.indexOf(OWN)
  const uploads = [...win.matchAll(/uses: actions\/upload-artifact@v4\n {8}with:\n {10}name: .*\n {10}path: (\S+)\/\n/g)]
  assert.deepEqual(uploads.map((u) => u[1]), folders)
  for (const u of uploads) assert.ok(u.index! > check, `${u[1]} is uploaded after the check`)
  fromOwn += fromOwnCommit(win)

  assert.equal(fromOwn, Object.values(calls).reduce((a, b) => a + b), 'every run of the tool was checked for the commit it comes from')
})

test('the workflow rules refuse a check that can be skipped and a check read from the commit a job builds', () => {
  const job = (...steps: string[]): string => `\n    runs-on: ubuntu-24.04\n    steps:${steps.map((st) => `\n      - ${st}`).join('')}\n`
  const checkout = (ref: string | null, more = ''): string => `uses: actions/checkout@v4\n        with:\n${ref === null ? '' : `          ref: ${ref}\n`}${more}          persist-credentials: false`
  const SIZE = SIZE_CHECKOUT.trimEnd()
  const ROOT_RUN = 'name: Every file of the release is under 2 GiB\n        run: node tools/verify/site_budget.mjs assets "$RUNNER_TEMP/media"'
  const OWN_RUN = 'name: Every file of the release is under 2 GiB\n        run: node .size-check/tools/verify/site_budget.mjs assets "$RUNNER_TEMP/media"'
  const BAKED = checkout('${{ steps.ref.outputs.ref }}')

  // Read from the commit a job builds: the bake of a tag that exists (build-release.yml before the fix), and a call's
  // or a tag's commit (build-matrix.yml and windows-app.yml before it). Each is refused; the tool from github.sha passes.
  assert.throws(() => fromOwnCommit(job(BAKED, ROOT_RUN)), /from the workflow's own commit, not \$\{\{ steps\.ref\.outputs\.ref \}\}/)
  assert.throws(() => fromOwnCommit(job(checkout('${{ inputs.ref || inputs.tag || github.ref }}'), ROOT_RUN)), /own commit/)
  assert.equal(fromOwnCommit(job(BAKED, SIZE, OWN_RUN)), 1)
  assert.equal(fromOwnCommit(job(checkout(null, '          sparse-checkout: tools\n'), ROOT_RUN)), 1, 'the default checkout is the workflow\'s commit')
  assert.equal(fromOwnCommit(job(checkout('${{ github.sha }}'), ROOT_RUN)), 1)
  // The tool's checkout at another commit, after the check, without the tool, moved, cleaned away or skippable.
  assert.throws(() => fromOwnCommit(job(BAKED, SIZE.replace('${{ github.sha }}', '${{ inputs.ref }}'), OWN_RUN)), /not \$\{\{ inputs\.ref \}\}/)
  assert.throws(() => fromOwnCommit(job(BAKED, OWN_RUN, SIZE)), /a checkout at \.size-check comes before/)
  assert.throws(() => fromOwnCommit(job(BAKED, ROOT_RUN.replace('node tools', 'node .size-check/tools'))), /a checkout at \.size-check comes before/)
  assert.throws(() => fromOwnCommit(job(BAKED, SIZE.replace('tools/verify', 'crimson_noir_os'), OWN_RUN)), /holds the tool: crimson_noir_os/)
  assert.throws(() => fromOwnCommit(job(BAKED, SIZE.replace('tools/verify', 'tools/verifyx'), OWN_RUN)), /holds the tool/)
  assert.equal(fromOwnCommit(job(BAKED, SIZE.replace('sparse-checkout: tools/verify', 'sparse-checkout: |\n            docs\n            tools/verify/'), OWN_RUN)), 1)
  assert.throws(() => fromOwnCommit(job(BAKED, SIZE, `${OWN_RUN}\n        working-directory: crimson_noir_os`)), /runs where its checkout put the tool/)
  assert.throws(() => fromOwnCommit(job(SIZE, BAKED, OWN_RUN)), /no checkout of the workspace after \.size-check/)
  assert.throws(() => fromOwnCommit(job(`if: false\n        ${SIZE}`, OWN_RUN)), /if: false/)

  // A check that can be skipped: an if: as the first key or any other, continue-on-error, or a fallback after it.
  const RUN = 'run: node tools/verify/site_budget.mjs site dist-web'
  const NAME = 'name: The web copy is at most 950 MB'
  const step = (st: string): string => stepsOf(job(st))[0]!
  unconditional(step(`${NAME}\n        ${RUN}`))
  for (const bad of [`if: false\n        ${NAME}\n        ${RUN}`, `if: matrix.model\n        ${RUN}`, `${NAME}\n        if: failure()\n        ${RUN}`,
    `${NAME}\n        continue-on-error: true\n        ${RUN}`, `${NAME}\n        ${RUN} || exit 0`, `${NAME}\n        ${RUN} || echo skipped`,
    `${NAME}\n        ${RUN} || true`, `${NAME}\n        ${RUN} || :`, `${NAME}\n        run: |\n          ${RUN.slice(5)} ||\n            exit 0`]) {
    assert.throws(() => unconditional(step(bad)), `refused: ${bad}`)
  }
  // And a run line is pinned whole: nothing can follow the command, nor can a subfolder stand in for the folder uploaded.
  inOrder(`${RUN}\n`, [`${RUN}\n`])
  for (const bad of [`${RUN} || exit 0\n`, `${RUN}/models\n`, `${RUN}; true\n`]) assert.throws(() => inOrder(bad, [`${RUN}\n`]), `refused: ${bad}`)
})
