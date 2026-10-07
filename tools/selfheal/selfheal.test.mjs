/**
 * Why does this file exist? It is the proof that the self-healing agent does what agent.mjs says, without a model
 * and without docker: the failure parsers read the real output formats of node's test runner, cargo, tsc and
 * Kani; the syntax-tree map finds the declaration a line is in and refuses a replacement that does not parse; the
 * loop stops after MAX_ATTEMPTS, and earlier when an attempt changes nothing (the dampening), and never proposes
 * when the failure does not reproduce; and, end to end on a small fixture repository with the host sandbox, a
 * planner that gets it wrong once and right once ends with a patch, a diff and a report that names every attempt.
 * What breaks if it is removed? The agent could silently stop isolating, mapping or stopping.
 */
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { MAX_ATTEMPTS, applyPlan, failuresOf, heal, lociOf, parseArgs, report } from './agent.mjs'
import { allLoci, replaceLocus, rustLocus, tsLocus } from './ast.mjs'
import { parseCargoTest, parseKani, parseNodeTest, parseOxlint, parseTsc, signature } from './failures.mjs'
import { builtinPlanner, chain, describe, nonePlanner, plan } from './planner.mjs'
import { copyTree, runChecks } from './sandbox.mjs'

const TAP = `TAP version 13
# Subtest: adds
not ok 1 - adds
  ---
  duration_ms: 3.03832
  type: 'test'
  location: '/repo/src/x.test.ts:8:1'
  failureType: 'testCodeFailure'
  error: |-
    Expected values to be strictly equal:
    
    -1 !== 3
    
  code: 'ERR_ASSERTION'
  stack: |-
    TestContext.<anonymous> (file:///repo/src/x.test.ts:8:29)
    Test.runInAsyncScope (node:async_hooks:214:14)
  ...
# Subtest: ok
ok 2 - ok
  ---
  duration_ms: 0.29
  ...
1..2
# tests 2
# pass 1
# fail 1
`

test('the node test parser reads the failing subtest, its message and its location', () => {
  const f = parseNodeTest(TAP, '/repo')
  assert.equal(f.length, 1)
  assert.deepEqual(f[0], { check: 'page-test', test: 'adds', message: 'Expected values to be strictly equal:\n\n-1 !== 3', file: 'src/x.test.ts', line: 8 })
})

test('the cargo test parser reads the panic site of each failed test', () => {
  const text = 'failures:\n\n---- tests::a stdout ----\n\nthread \'tests::a\' panicked at src/tests.rs:342:20:\nassertion `left == right` failed: two\n  left: 2\n right: 3\n\n---- tests::b stdout ----\n\nthread \'tests::b\' panicked at src/lib.rs:10:5:\nindex out of bounds\n\nfailures:\n    tests::a\n\ntest result: FAILED.'
  const f = parseCargoTest(text, 'native/routing')
  assert.equal(f.length, 2)
  assert.equal(f[0].test, 'tests::a')
  assert.equal(f[0].file, 'native/routing/src/tests.rs')
  assert.equal(f[0].line, 342)
  assert.match(f[0].message, /two/)
  assert.equal(f[1].file, 'native/routing/src/lib.rs')
})

test('the tsc, oxlint and kani parsers read their diagnostics', () => {
  assert.deepEqual(parseTsc('src/a.ts(12,5): error TS2322: Type string is not assignable to number.\nsrc/b.tsx(3,1): error TS1005: expected.'), [
    { check: 'page-tsc', test: 'TS2322', message: 'Type string is not assignable to number.', file: 'src/a.ts', line: 12 },
    { check: 'page-tsc', test: 'TS1005', message: 'expected.', file: 'src/b.tsx', line: 3 },
  ])
  const ox = parseOxlint('  × eslint(no-unused-vars): Variable x is declared but never used.\n   ,-[src/c.ts:7:9]\n 6 |\n')
  assert.equal(ox.length, 1)
  assert.equal(ox[0].file, 'src/c.ts')
  assert.equal(ox[0].line, 7)
  const k = parseKani('SUMMARY:\n ** 1 of 9 failed\nFailed Checks: assertion failed: m.px[i] >= 0.0\n File: "src/verify.rs", line 120, in verify::agent_tick_is_isolated\nVERIFICATION:- FAILED\nVerification failed for - verify::agent_tick_is_isolated\n', 'crimson_noir_os/crates/noir_core')
  assert.equal(k.length, 1)
  assert.equal(k[0].file, 'crimson_noir_os/crates/noir_core/src/verify.rs')
  assert.equal(k[0].line, 120)
})

test('a failure signature is the sorted failing tests and first lines, so order does not matter', () => {
  const a = parseTsc('a.ts(1,1): error TS1: x\nb.ts(2,1): error TS2: y')
  const b = parseTsc('b.ts(2,1): error TS2: y\na.ts(1,1): error TS1: x')
  assert.equal(signature(a), signature(b))
  assert.notEqual(signature(a), signature(a.slice(1)))
})

const TS = `import { test } from 'node:test'
import assert from 'node:assert/strict'
export function add(a: number, b: number): number { return a - b }
export class Box {
  size(): number { return 1 }
}
const K = 3
test('adds', () => { assert.equal(add(1, 2), K) })
`

test('the syntax-tree map finds the innermost declaration a line is in', () => {
  assert.equal(tsLocus(TS, 3, 'x.ts').name, 'add')
  assert.equal(tsLocus(TS, 5, 'x.ts').name, 'size')
  assert.equal(tsLocus(TS, 5, 'x.ts').kind, 'method')
  assert.equal(tsLocus(TS, 7, 'x.ts').name, 'K')
  assert.deepEqual([tsLocus(TS, 8, 'x.ts').kind, tsLocus(TS, 8, 'x.ts').name], ['test', 'adds'])
  assert.equal(tsLocus(TS, 1, 'x.ts'), null)
  assert.deepEqual(allLoci('x.ts', TS).map((l) => l.name), ['add', 'Box', 'size', 'K', 'adds'])
})

const RS = `//! doc
pub const N: usize = 3;

/// The index of the piece.
pub fn piece_at(s: f64) -> usize {
    let x = "}"; // a brace in a string
    if s > 0.0 { 1 } else { 0 }
}

impl<'a> Track<'a> {
    pub fn new(w: &'a [f64]) -> Self {
        Track { w }
    }
}
`

test('the Rust map finds the item a line is in, braces in strings and lifetimes notwithstanding', () => {
  const f = rustLocus(RS, 7)
  assert.equal(f.kind, 'fn')
  assert.equal(f.name, 'piece_at')
  assert.match(f.text, /^\/\/\/ The index/)
  assert.match(f.text, /\n}$/)
  assert.equal(rustLocus(RS, 2).name, 'N')
  assert.equal(rustLocus(RS, 12).name, 'new')
  assert.equal(rustLocus(RS, 10).name, "Track<'a>".replace(/<[^>]*>/g, ''))
  assert.deepEqual(allLoci('x.rs', RS).map((l) => l.name), ['N', 'piece_at', 'Track', 'new'])
})

test('a replacement swaps a whole declaration and is refused when it does not parse or is ambiguous', () => {
  const ok = replaceLocus('x.ts', TS, 'add', 'export function add(a: number, b: number): number { return a + b }')
  assert.equal(ok.ok, true)
  assert.match(ok.text, /return a \+ b/)
  assert.equal(ok.text.split('\n').length, TS.split('\n').length)
  const bad = replaceLocus('x.ts', TS, 'add', 'export function add(a {')
  assert.equal(bad.ok, false)
  assert.match(bad.reason, /does not parse/)
  assert.equal(replaceLocus('x.ts', TS, 'nope', 'x').ok, false)
  const two = TS + 'function add() {}\n'
  assert.match(replaceLocus('x.ts', two, 'add', 'function add() {}').reason, /2 declarations/)
})

test('the options are read with the attempt bound clamped to MAX_ATTEMPTS', () => {
  const o = parseArgs(['--checks', 'page-test,rust-test', '--planner', 'none', '--max-attempts', '9', '--run-id', 'r/1'])
  assert.deepEqual(o.checks, ['page-test', 'rust-test'])
  assert.equal(o.maxAttempts, MAX_ATTEMPTS)
  assert.equal(o.runId, 'r1')
  assert.throws(() => parseArgs(['--what']))
})

/** A checks.sh run's output with one failed check, located in `tree` when given. */
const failing = (msg, tree = '/repo') => `::group::check page-test\n${TAP.replace('-1 !== 3', msg).split('/repo').join(tree)}::endgroup::\ncheck page-test: FAILED (1)\n`

test('the loop stops when the failure does not reproduce', async () => {
  const s = await heal({ checks: ['page-test'], maxAttempts: 3, runId: 't', tree: '/repo', sandbox: 'host' }, { runChecks: () => ({ ok: true, output: '' }), planner: nonePlanner(), log: () => {} })
  assert.equal(s.result.ok, false)
  assert.match(s.result.reason, /did not reproduce/)
  assert.equal(s.attempts.length, 0)
})

test('the loop stops when the planner has nothing, and never exceeds MAX_ATTEMPTS', async () => {
  let runs = 0
  const s = await heal({ checks: ['page-test'], maxAttempts: 3, runId: 't', tree: '/repo', sandbox: 'host' }, { runChecks: () => { runs++; return { ok: false, output: failing('-1 !== 3') } }, planner: nonePlanner(), log: () => {} })
  assert.equal(s.attempts.length, 1)
  assert.match(s.result.reason, /no patch/)
  assert.equal(runs, 1)
})

test('the dampening: an attempt that leaves the same failures ends the loop before the bound', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'selfheal-t-'))
  mkdirSync(join(tree, 'src'))
  writeFileSync(join(tree, 'src/x.test.ts'), TS)
  const planner = { name: 'fake', calls: 0, async propose() { this.calls++; return plan('edits', { edits: [{ file: 'src/x.test.ts', name: 'adds', replacement: `test('adds', () => { assert.equal(add(1, 2), ${this.calls}) })` }], rationale: `try ${this.calls}` }) } }
  // Attempt 1 changes the failure; attempt 2 leaves it as attempt 1 left it: stop at 2 of 3.
  const outputs = ['-1 !== 3', '2 !== 3', '2 !== 3']
  let i = 0
  const s = await heal({ checks: ['page-test'], maxAttempts: 3, runId: 't', tree, sandbox: 'host' }, {
    runChecks: () => ({ ok: false, output: failing(outputs[Math.min(i++, 2)], tree) }),
    planner, log: () => {},
  })
  rmSync(tree, { recursive: true, force: true })
  assert.equal(s.loci.length, 1)
  assert.equal(s.attempts.length, 2)
  assert.equal(planner.calls, 2)
  assert.match(s.result.reason, /left exactly the failures/)
})

test('two patches refused for the same reason end the loop too', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'selfheal-t-'))
  mkdirSync(join(tree, 'src'))
  writeFileSync(join(tree, 'src/x.test.ts'), TS)
  const planner = { name: 'fake', calls: 0, async propose() { this.calls++; return plan('edits', { edits: [{ file: 'src/x.test.ts', name: 'Box', replacement: 'class Box {}' }], rationale: 'wrong locus' }) } }
  const s = await heal({ checks: ['page-test'], maxAttempts: 3, runId: 't', tree, sandbox: 'host' }, { runChecks: () => ({ ok: false, output: failing('-1 !== 3', tree) }), planner, log: () => {} })
  rmSync(tree, { recursive: true, force: true })
  assert.equal(s.attempts.length, 2)
  assert.match(s.result.reason, /could not be applied for the same reason/)
})

test('the loop runs the full bound when every attempt changes something and none passes', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'selfheal-t-'))
  mkdirSync(join(tree, 'src'))
  writeFileSync(join(tree, 'src/x.test.ts'), TS)
  let n = 0
  const planner = { name: 'fake', calls: 0, async propose() { this.calls++; return plan('edits', { edits: [{ file: 'src/x.test.ts', name: 'adds', replacement: `test('adds', () => { assert.equal(add(1, 2), ${this.calls}) })` }], rationale: `try ${this.calls}` }) } }
  const s = await heal({ checks: ['page-test'], maxAttempts: 3, runId: 't', tree, sandbox: 'host' }, {
    runChecks: () => ({ ok: false, output: failing(`${n++} !== 3`, tree) }),
    planner, log: () => {},
  })
  rmSync(tree, { recursive: true, force: true })
  assert.equal(s.attempts.length, 3)
  assert.match(s.result.reason, /3 attempts did not resolve/)
  assert.equal(planner.calls, 3)
})

test('a plan may only edit a locus it was shown, and a built-in remedy answers the stale-module failure', async () => {
  const tree = mkdtempSync(join(tmpdir(), 'selfheal-t-'))
  writeFileSync(join(tree, 'x.ts'), TS)
  const r = applyPlan(plan('edits', { edits: [{ file: 'x.ts', name: 'Box', replacement: 'class Box {}' }] }), tree, [{ file: 'x.ts', name: 'add' }])
  assert.equal(r.ok, false)
  assert.match(r.reason, /not among the loci/)
  rmSync(tree, { recursive: true, force: true })
  const b = await builtinPlanner().propose({ failures: [{ check: 'page-test', test: 'the module in the tree', message: 'routing core: layout entry 3 is 32 in the module and 33 here' }], loci: [], attempts: [] })
  assert.equal(b.kind, 'commands')
  assert.equal(b.commands[0].argv.join(' '), 'npm run native:wasm')
  const none = await builtinPlanner().propose({ failures: [{ check: 'page-test', test: 'x', message: 'y' }], loci: [], attempts: [] })
  assert.equal(none.kind, 'none')
  const c = chain(builtinPlanner(), nonePlanner())
  assert.equal((await c.propose({ failures: [], loci: [], attempts: [] })).kind, 'none')
  const text = describe({ failures: [{ check: 'page-test', test: 't', message: 'm', file: 'x.ts', line: 3 }], loci: [{ file: 'x.ts', kind: 'function', name: 'add', line: 3, endLine: 3, text: 'x'.repeat(7000) }], attempts: [] })
  assert.match(text, /more characters/)
  assert.match(text, /x\.ts — function add/)
})

/** A fixture repository: one test, one function with a bug, and a checks.sh that runs the test. */
function fixture() {
  const tree = mkdtempSync(join(tmpdir(), 'selfheal-fx-'))
  mkdirSync(join(tree, 'tools/selfheal'), { recursive: true })
  mkdirSync(join(tree, 'src'), { recursive: true })
  writeFileSync(join(tree, 'src/x.test.ts'), TS)
  writeFileSync(join(tree, 'tools/selfheal/checks.sh'), '#!/bin/sh\ncd "$(dirname "$0")/../.."\nfor c in "$@"; do\n  [ "$c" = all ] && c=page-test\n  echo "::group::check $c"\n  if node --test src/x.test.ts; then echo "::endgroup::"; echo "check $c: ok"; else echo "::endgroup::"; echo "check $c: FAILED (1)"; exit 1; fi\ndone\n')
  chmodSync(join(tree, 'tools/selfheal/checks.sh'), 0o755)
  return tree
}

test('end to end on a fixture: isolate, map, a wrong patch, a right patch, a diff and a report', async () => {
  const tree = fixture()
  const planner = {
    name: 'fake', calls: 0,
    async propose({ loci, attempts }) {
      this.calls++
      assert.ok(loci.some((l) => l.name === 'adds' && l.kind === 'test'), 'the failing test is a locus')
      if (attempts.length === 0) return plan('edits', { edits: [{ file: 'src/x.test.ts', name: 'adds', replacement: "test('adds', () => { assert.equal(add(1, 2), K + 1) })" }], rationale: 'first guess: the expectation' })
      assert.match(attempts[0].summary, /!== 4/, 'the second attempt sees how the first failed')
      return plan('edits', { edits: [{ file: 'src/x.test.ts', name: 'adds', replacement: "test('adds', () => { assert.equal(add(1, 2) + 4, K) })" }], rationale: 'second guess' })
    },
  }
  const s = await heal({ checks: ['page-test'], maxAttempts: 3, runId: 'fx', tree, sandbox: 'host' }, { planner, log: () => {} })
  assert.equal(s.failures[0].test, 'adds')
  assert.equal(s.failures[0].file, 'src/x.test.ts')
  assert.equal(s.result.ok, true)
  assert.equal(s.result.attempt, 2)
  assert.equal(s.attempts[0].ok, false)
  assert.match(s.diff, /^\+.*add\(1, 2\) \+ 4/m)
  assert.deepEqual(s.changed, ['src/x.test.ts'])
  // The tree itself was never touched: only the copy was patched.
  assert.equal(readFileSync(join(tree, 'src/x.test.ts'), 'utf8'), TS)
  const body = report(s)
  assert.match(body, /Attempt 1: failed/)
  assert.match(body, /Attempt 2: passed/)
  assert.match(body, /never merges/)
  assert.match(body, /```diff/)
  rmSync(s.patched, { recursive: true, force: true })
  rmSync(tree, { recursive: true, force: true })
})

test('the host sandbox runs the checks on a copy and leaves the tree alone', () => {
  const tree = fixture()
  const r = runChecks(tree, ['page-test'], { kind: 'host', log: () => {} })
  assert.equal(r.ok, false)
  assert.match(r.output, /not ok 1 - adds/)
  const copy = copyTree(tree)
  assert.equal(readFileSync(join(copy, 'src/x.test.ts'), 'utf8'), TS)
  rmSync(copy, { recursive: true, force: true })
  rmSync(tree, { recursive: true, force: true })
  const f = failuresOf(r.output, tree)
  assert.equal(f[0].test, 'adds')
  assert.equal(lociOf(f, tree).length, 0, 'the tree is gone: no locus can be read')
})
