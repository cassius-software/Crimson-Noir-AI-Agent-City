// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins NoirScript's session and its view of the city: the public API of index.ts and
 * the order of `words()`; every reference example of the specification; the tables a fake host hands over (ten
 * crowd rows, three cars) read through `query`, indexed columns and `load_f32x4` with its zero fill; the snapshot
 * taken once per run; the null host as EMPTY_TABLES; the write intrinsics failing with the host's locked message,
 * calling through with `write` (the calls recorded), and turning a throw into the run's error; what a bad line
 * installs (nothing) and what a failing run keeps (its fns and globals); the Turing witnesses (Rule 110 over 64
 * cells for 32 generations against a JS implementation here, and a tape-machine interpreter written in NoirScript);
 * and determinism: two sessions fed the same thirty lines print the same text and count the same steps.
 * What breaks if it is removed? The console's `noir` command could drift from the specification, read the host's
 * arrays live, or let a locked write through, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as api from './index.ts'
import type { NoirHost, NoirLimits, NoirResult, NoirTables, NoirWrites } from './index.ts'
import { EMPTY_TABLES, INTRINSIC_NAMES, KEYWORDS, LIMITS, NoirSession, TYPE_NAMES, f32Text } from './index.ts'
import { MAX_CELLS, MAX_DEPTH, saneLimits } from './vm.ts'

const fresh = (): NoirSession => new NoirSession()
const say = (s: NoirSession, src: string, host?: NoirHost | null): string[] => {
  const r = s.run(src, host)
  assert.equal(r.error, undefined, `${src} -> ${r.error}`)
  return r.out
}
const err = (s: NoirSession, src: string, host?: NoirHost | null): string => {
  const r = s.run(src, host)
  assert.ok(r.error !== undefined, `${src} should fail`)
  return r.error
}

/** The fake city: ten crowd rows and three cars, with every scalar set. */
interface Fake { readonly host: NoirHost; readonly tables: NoirTables; readonly calls: unknown[][] }
function fake(write = true, locked?: string): Fake {
  const tables: NoirTables = {
    crowd: { n: 10, x: Float32Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), z: Float32Array.from([0.5, -0.5, 1.5, -1.5, 2.5, -2.5, 3.5, -3.5, 4.5, -4.5]) },
    cars: { n: 3, x: Float32Array.of(0, 10, 20), z: Float32Array.of(0, -10, 5), heading: Float32Array.of(0, 1.5, 3), speed: Float32Array.of(3, 6, 9.5), mode: Int32Array.of(0, 1, 2) },
    kernel: { law1: 1, law2: 2, law3: 3, flips: 4, shielded: true },
    frame: { fps: 60, ms: 16.5, p95: 20.25 },
  }
  const calls: unknown[][] = []
  const writes: NoirWrites = {
    tune: (key, value) => { calls.push(['tune', key, value]); return value * 2 },
    intent: (car, throttle, brake, steer) => { calls.push(['intent', car, throttle, brake, steer]); return car === 1 },
    cull: (density) => { calls.push(['cull', density]); return density + 1 },
    steer: (feature, value) => { calls.push(['steer', feature, value]); if (feature === 'boom') throw new Error('steer refused'); return -value },
  }
  const host: NoirHost = write ? { tables: () => tables, write: writes } : locked === undefined ? { tables: () => tables } : { tables: () => tables, locked }
  return { host, tables, calls }
}

// ---------------------------------------------------------------------------------------------------
// The public API

test('index.ts exports exactly the public API of the specification, frozen where it is a constant', () => {
  assert.deepEqual(Object.keys(api).sort(), ['ELITE_LIMITS', 'EMPTY_TABLES', 'INTRINSIC_NAMES', 'KEYWORDS', 'LIMITS', 'NoirSession', 'TYPE_NAMES', 'f32Text'])
  assert.deepEqual([...KEYWORDS], ['fn', 'let', 'mut', 'if', 'else', 'while', 'for', 'in', 'loop', 'break', 'continue', 'return', 'true', 'false', 'as', 'query', 'where'])
  assert.deepEqual([...TYPE_NAMES], ['i32', 'u32', 'f32', 'bool', 'void', 'f32x4', 'i32x4', 'u32x4', 'u32x8', 'col'])
  for (const name of ['min', 'max', 'abs', 'clamp', 'sqrt', 'floor', 'ceil', 'trunc', 'select', 'mask', 'popcount', 'clz', 'ctz', 'rotl', 'rotr', 'morton2', 'demorton2x', 'demorton2y',
    'f32x4', 'i32x4', 'u32x4', 'u32x8', 'splat_f32x4', 'splat_i32x4', 'splat_u32x4', 'splat_u32x8', 'vlt', 'vle', 'vgt', 'vge', 'veq', 'vne', 'hsum', 'hmin', 'hmax', 'any', 'all',
    'load_f32x4', 'load_i32x4', 'load_u32x4', 'load_u32x8', 'tune', 'intent', 'cull', 'steer', 'print', 'println']) {
    assert.ok(INTRINSIC_NAMES.includes(name), name)
  }
  assert.equal(new Set(INTRINSIC_NAMES).size, INTRINSIC_NAMES.length, 'no intrinsic twice')
  assert.ok(Object.isFrozen(KEYWORDS) && Object.isFrozen(TYPE_NAMES) && Object.isFrozen(INTRINSIC_NAMES) && Object.isFrozen(EMPTY_TABLES))
  assert.deepEqual(EMPTY_TABLES, {
    crowd: { n: 0, x: new Float32Array(0), z: new Float32Array(0) },
    cars: { n: 0, x: new Float32Array(0), z: new Float32Array(0), heading: new Float32Array(0), speed: new Float32Array(0), mode: new Int32Array(0) },
    kernel: { law1: 0, law2: 0, law3: 0, flips: 0, shielded: false },
    frame: { fps: 0, ms: 0, p95: 0 },
  })
  assert.equal(f32Text(0.1), '0.1')
  const s = fresh()
  assert.deepEqual(s.words(), [...KEYWORDS, ...TYPE_NAMES, 'crowd', 'cars', 'kernel', 'frame', ...INTRINSIC_NAMES], 'words: keywords, types, tables, intrinsics')
  say(s, 'fn f() { } let g = 1; fn h() -> i32 { g }')
  assert.deepEqual(s.words().slice(-3), ['f', 'g', 'h'], 'then user fns and globals in the order they are written')
  const r: NoirResult = s.run('print(h());')
  assert.deepEqual(r, { out: ['1'], steps: r.steps, defined: [] })
  assert.ok(r.steps > 0)
  assert.ok(!('error' in r), 'no error key on success')
  const lim: NoirLimits = LIMITS
  assert.equal(new NoirSession(lim).run('print(1);').out[0], '1')
})

test('the reference examples of the specification work, line by line, on one session with the fake city', () => {
  const s = fresh()
  const { host } = fake()
  assert.deepEqual(say(s, 'let mut s = 0; for i in 0..10 { s += i * i; } print(s);', host), ['285'])
  assert.deepEqual(say(s, 'fn fib(n: i32) -> i32 { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } } print(fib(20));', host), ['6765'])
  assert.deepEqual(say(s, 'let v = f32x4(1.0, 2.0, 3.0, 4.0); let w = v * splat_f32x4(2.0); print(w, hsum(w));', host), ['f32x4(2, 4, 6, 8) 20'])
  assert.deepEqual(say(s, 'let m = vlt(f32x4(1.0, 5.0, 3.0, 7.0), splat_f32x4(4.0)); print(select(m, splat_f32x4(1.0), splat_f32x4(0.0)));', host), ['f32x4(1, 0, 1, 0)'])
  assert.deepEqual(say(s, 'let near = query cars where speed > 5.0; print(near);', host), ['2'])
  assert.deepEqual(say(s, 'let mut acc = splat_f32x4(0.0); let mut i = 0; while i < crowd.n { acc = acc + load_f32x4(crowd.x, i); i += 4; } print(hsum(acc));', host), ['55'])
  assert.deepEqual(say(s, 'print(morton2(3u, 5u), popcount(0xF0F0u), 7 >> 1, -8 >> 1, (0u - 1u) >> 28);', host), ['39 8 3 -4 15'])
  assert.deepEqual(s.words().slice(-8), ['s', 'fib', 'v', 'w', 'm', 'near', 'acc', 'i'])
})

// ---------------------------------------------------------------------------------------------------
// Tables

test('tables: query counts rows, columns index and iterate, load_f32x4 strides by 4 with zero fill, scalars read', () => {
  const s = fresh()
  const { host, tables } = fake()
  const bySpeed = Array.from(tables.cars.speed).filter((v) => v > 5).length
  assert.equal(bySpeed, 2, 'the hand count')
  assert.deepEqual(say(s, 'print(query cars where speed > 5.0, query crowd where z > 0.0, query crowd where x > 3.0 && z < 0.0, query cars where mode == 1 || speed < 4.0, query cars where true, query crowd where false);', host),
    [`${bySpeed} 5 4 2 3 0`])
  const sum = Array.from(tables.crowd.x).reduce((a, b) => a + b, 0)
  assert.deepEqual(say(s, 'let mut sum = 0.0; for i in 0..crowd.n { sum += crowd.x[i]; } print(sum, crowd.n, cars.n);', host), [`${sum} 10 3`])
  assert.deepEqual(say(s, 'let mut acc = splat_f32x4(0.0); let mut i = 0; while i < crowd.n { acc = acc + load_f32x4(crowd.x, i); i += 4; } print(acc, hsum(acc), load_f32x4(crowd.x, 8), load_f32x4(crowd.x, 10), load_f32x4(crowd.x, -2), load_i32x4(cars.mode, 1), load_f32x4(cars.speed, 0));', host),
    ['f32x4(15, 18, 10, 12) 55 f32x4(9, 10, 0, 0) f32x4(0, 0, 0, 0) f32x4(0, 0, 1, 2) i32x4(1, 2, 0, 0) f32x4(3, 6, 9.5, 0)'])
  assert.deepEqual(say(s, 'print(kernel.law1, kernel.law2, kernel.law3, kernel.flips, kernel.shielded, frame.fps, frame.ms, frame.p95);', host), ['1 2 3 4 true 60 16.5 20.25'])
  assert.deepEqual(say(s, 'print(cars.mode[2], cars.speed[1], cars.heading[1], cars.x[2], cars.z[1], crowd.z[9], cars.x.len(), crowd.x.len(), crowd.x, cars.mode);', host), ['2 6 1.5 20 -10 -4.5 3 10 col<f32>[10] col<i32>[3]'])
  assert.deepEqual(say(s, 'fn total(xs: col<f32>) -> f32 { let mut t = 0.0; for i in 0..xs.len() { t += xs[i]; } t } let zs = crowd.z; print(total(crowd.x), total(zs), total(cars.speed), zs[0]);', host), ['55 0 18.5 0.5'])
  assert.deepEqual(say(s, 'let lim = 5.0; fn fast(limit: f32) -> i32 { query cars where speed > limit } print(fast(lim), fast(9.0), query crowd where (query cars where speed > 0.0) > 1 && x > 1.0);', host), ['2 1 9'])
  assert.equal(err(s, 'print(cars.speed[3]);', host), 'index 3 out of bounds (len 3)')
  assert.equal(err(s, 'print(crowd.x[-1]);', host), 'index -1 out of bounds (len 10)')
  assert.deepEqual(say(s, 'let mut parked = 0; for i in 0..cars.n { if cars.mode[i] == 2 { parked += 1; } } print(parked);', host), ['1'])
})

test('tables are a snapshot taken once per run; the host\'s arrays are never written and a change mid-run is not seen', () => {
  const xs = Float32Array.of(1, 2, 3)
  let reads = 0
  const host: NoirHost = {
    tables: () => { reads++; return { ...EMPTY_TABLES, crowd: { n: 3, x: xs, z: xs } } },
    write: { tune: () => { xs[0] = 99; return 0 }, intent: () => true, cull: () => 0, steer: () => 0 },
  }
  const s = fresh()
  assert.deepEqual(say(s, 'print(crowd.x[0]); let t = tune("k", 1.0); print(crowd.x[0], query crowd where x > 50.0);', host), ['1', '1 0'], 'the write changed the host mid-run; the run kept its copy')
  assert.equal(reads, 1, 'tables() is read once per run')
  assert.equal(xs[0], 99)
  assert.deepEqual(say(s, 'print(crowd.x[0]);', host), ['99'], 'the next run takes a new snapshot')
  assert.equal(reads, 2)
  assert.deepEqual(say(s, 'let c = crowd.x; print(c[1]);', host), ['2'])
  assert.deepEqual(Array.from(xs), [99, 2, 3], 'nothing wrote to the host')
  // Rows are the shortest column when a table claims more than its arrays hold; a bad n is 0 rows (pinned decisions).
  const short: NoirHost = { tables: () => ({ ...EMPTY_TABLES, crowd: { n: 10, x: Float32Array.of(1, 2, 3, 4), z: Float32Array.of(1, 2) } }) }
  assert.deepEqual(say(s, 'print(crowd.n, crowd.x.len(), crowd.z.len(), query crowd where x > 0.0);', short), ['2 2 2 2'])
  const bad: NoirHost = { tables: () => ({ ...EMPTY_TABLES, crowd: { n: -4, x: Float32Array.of(1), z: Float32Array.of(1) }, cars: { ...EMPTY_TABLES.cars, n: Number.NaN } }) }
  assert.deepEqual(say(s, 'print(crowd.n, cars.n);', bad), ['0 0'])
  const fractional: NoirHost = { tables: () => ({ ...EMPTY_TABLES, crowd: { n: 2.7, x: Float32Array.of(1, 2, 3), z: Float32Array.of(1, 2, 3) } }) }
  assert.deepEqual(say(s, 'print(crowd.n);', fractional), ['2'])
})

test('a null or absent host is EMPTY_TABLES; a host whose tables() throws fails the run with its message', () => {
  const s = fresh()
  const expected = '0 0 0 0 0 0 false 0 0 0 col<f32>[0] col<i32>[0] 0 0 f32x4(0, 0, 0, 0) i32x4(0, 0, 0, 0)'
  const probe = 'print(crowd.n, cars.n, kernel.law1, kernel.law2, kernel.law3, kernel.flips, kernel.shielded, frame.fps, frame.ms, frame.p95, crowd.x, cars.mode, query cars where true, query crowd where x == 0.0, load_f32x4(crowd.x, 0), load_i32x4(cars.mode, 4));'
  assert.deepEqual(say(s, probe, null), [expected])
  assert.deepEqual(say(s, probe), [expected])
  assert.deepEqual(say(s, probe, undefined), [expected])
  const t = fresh()
  const r = t.run('let g9 = 1; fn k() -> i32 { 7 } print(1);', { tables: () => { throw new Error('tables down') } })
  assert.equal(r.error, 'tables down')
  assert.deepEqual(r.out, [])
  assert.deepEqual(r.defined, ['g9', 'k'], 'the line compiled, so its names are installed')
  // A global whose `let` never ran reads as 0 (new globals start zeroed): the pinned decision.
  assert.deepEqual(say(t, 'print(g9, k());'), ['0 7'])
  const u = fresh()
  assert.equal(u.run('print(1);', { tables: () => 'nonsense' as unknown as NoirTables }).error?.startsWith('internal error:'), true, 'a host that is not a host is reported, not thrown')
  assert.deepEqual(say(u, 'print(2);'), ['2'])
})

test('write intrinsics fail with the host\'s locked message without write, call through with it, and a throw becomes the error', () => {
  const s = fresh()
  assert.equal(err(s, 'print(tune("car.power", 2.0));', fake(false).host), 'elite tier locked')
  assert.equal(err(s, 'print(intent(0, 1.0, 0.0, 0.0));', fake(false).host), 'elite tier locked')
  assert.equal(err(s, 'print(cull(0.5));', fake(false).host), 'elite tier locked')
  assert.equal(err(s, 'print(steer("rain", 1.0));', fake(false).host), 'elite tier locked')
  assert.equal(err(s, 'print(tune("k", 1.0));'), 'elite tier locked', 'no host at all is locked too')
  assert.equal(err(s, 'print(tune("k", 1.0));', null), 'elite tier locked')
  assert.equal(err(s, 'print(cull(1.0));', fake(false, 'no writes in this build').host), 'no writes in this build', 'host.locked overrides the message')
  assert.equal(err(s, 'print(1); print(cull(1.0)); print(2);', fake(false, '').host), '', 'an empty locked message is still the failure')
  const r = s.run('print(1); print(steer("x", 1.0)); print(2);', fake(false).host)
  assert.deepEqual(r.out, ['1'])
  assert.equal(r.error, 'elite tier locked')
  assert.ok(s.asm('print(tune("k", 1.0), intent(1, 0.5, 0.0, 0.0), cull(0.5), steer("f", 1.0));').out.length > 5, 'they type-check and compile without a host')
  const live = fake()
  assert.deepEqual(say(s, 'print(tune("car.power", 2.0), intent(1, 0.5, 0.0, -0.25), intent(2, 1.0, 1.0, 1.0), cull(0.5), steer("rain", 1.5));', live.host), ['4 true false 1.5 -1.5'])
  assert.deepEqual(live.calls, [['tune', 'car.power', 2], ['intent', 1, 0.5, 0, -0.25], ['intent', 2, 1, 1, 1], ['cull', 0.5], ['steer', 'rain', 1.5]])
  assert.deepEqual(say(s, 'fn t() -> f32 { tune("deep", 3.0) } let mut k = 0.0; for i in 0..3 { k += t(); } print(k);', live.host), ['18'])
  assert.deepEqual(live.calls.slice(5), [['tune', 'deep', 3], ['tune', 'deep', 3], ['tune', 'deep', 3]])
  const boom = s.run('print(1); print(steer("boom", 1.0)); print(2);', live.host)
  assert.deepEqual(boom.out, ['1'])
  assert.equal(boom.error, 'steer refused')
  assert.deepEqual(live.calls.slice(8), [['steer', 'boom', 1]])
  const notError: NoirHost = { tables: () => EMPTY_TABLES, write: { ...live.host.write!, cull: () => { throw 'plain text' } } }
  assert.equal(err(s, 'print(cull(1.0));', notError), 'plain text')
  assert.deepEqual(say(s, 'print(3);'), ['3'], 'the session is usable after a host failure')
  assert.deepEqual(say(s, 'print(tune("a\\tb", 1.0));', live.host), ['2'])
  assert.deepEqual(live.calls[live.calls.length - 1], ['tune', 'a\tb', 1], 'the string reaches the host with its escapes decoded')
})

test('a host\'s columns that do not fit the arena fail the run with "memory exhausted", and the next run works', () => {
  const s = fresh()
  const n = 200_000
  const huge: NoirHost = { tables: () => ({ ...EMPTY_TABLES, crowd: { n, x: new Float32Array(n), z: new Float32Array(n) } }) }
  assert.equal(err(s, 'print(crowd.n);', huge), 'memory exhausted')
  assert.deepEqual(say(s, 'print(crowd.n);', null), ['0'])
  const fits: NoirHost = { tables: () => ({ ...EMPTY_TABLES, crowd: { n: 10_000, x: new Float32Array(10_000).fill(1), z: new Float32Array(10_000) } }) }
  assert.deepEqual(say(s, 'print(query crowd where x > 0.5);', fits), ['10000'])
})

// ---------------------------------------------------------------------------------------------------
// Lines, errors and installation

test('a line installs its fns and globals only if the whole line compiles; a run-time error keeps them; reset forgets everything', () => {
  const s = fresh()
  const bad = s.run('fn good() -> i32 { 1 } let g = 2; fn bad() -> i32 { 1.5 }')
  assert.equal(bad.error, "1:53: fn 'bad' -> i32 ends with a f32 value")
  assert.deepEqual(bad.defined, [])
  assert.equal(err(s, 'print(good());'), "1:7: unknown fn 'good'")
  const run = s.run('fn half(n: i32) -> i32 { n / 2 } let mut hits = 0; hits += 1; print(half(8)); print(1 / 0); hits += 1;')
  assert.deepEqual(run.out, ['4'])
  assert.equal(run.error, 'division by zero')
  assert.deepEqual(run.defined, ['half', 'hits'])
  assert.deepEqual(say(s, 'print(half(10), hits);'), ['5 1'], 'the globals hold what ran before the error')
  s.reset()
  assert.equal(err(s, 'print(half(10));'), "1:7: unknown fn 'half'")
  assert.equal(err(s, 'print(hits);'), "1:7: unknown name 'hits'")
  assert.deepEqual(s.words(), fresh().words())
  assert.deepEqual(say(s, 'let hits = 5; print(hits);'), ['5'])
  const multi = s.run('// a line may hold several statements and newlines\nlet a = 1;\n/* and\n   comments */ let b = a + 1;\nprint(a, b);')
  assert.deepEqual(multi.out, ['1 2'])
  assert.deepEqual(multi.defined, ['a', 'b'])
  assert.equal(s.run('let x = 1;\n{ let yy = 2 }').error, "2:14: expected ';' after statement, got '}'", 'the spec\'s own example of a position')
  assert.equal(s.run('let q = 1;\n\n  let r: i32 = 2.5;').error, "3:16: cannot initialize i32 'r' with f32")
  assert.deepEqual(s.run('').out, [], 'an empty line is fine')
  assert.deepEqual(s.run(';;;').defined, [])
  assert.deepEqual(say(s, 'print(); println(); print(""); print("a\\tb", "q\\"q", "x\\\\y", "n\\nl");'), ['', '', '', 'a\tb q"q x\\y n\nl'])
  assert.deepEqual(say(s, 'println("x", 2, true, 1.5, splat_u32x4(1u), [1, 2], crowd.x);'), ['x 2 true 1.5 u32x4(1, 1, 1, 1) [1, 2] col<f32>[0]'], 'println is print')
})

// ---------------------------------------------------------------------------------------------------
// Turing witnesses

/** Rule 110 over 64 cells with zero boundaries, as plain JS: the reference the NoirScript run is pinned against. */
function rule110(generations: number): string[] {
  let cells = Array<number>(64).fill(0)
  cells[63] = 1
  const out: string[] = []
  for (let g = 0; g < generations; g++) {
    out.push(`[${cells.join(', ')}]`)
    const next = Array<number>(64).fill(0)
    for (let i = 0; i < 64; i++) {
      const l = i === 0 ? 0 : cells[i - 1]!
      const r = i === 63 ? 0 : cells[i + 1]!
      next[i] = (110 >> (l * 4 + cells[i]! * 2 + r)) & 1
    }
    cells = next
  }
  return out
}

test('Turing witness: Rule 110 over a 64-cell array for 32 generations matches a direct JS implementation', () => {
  const s = fresh()
  say(s, [
    '// Rule 110: the rule number is the lookup table, indexed by the three-cell neighbourhood.',
    'fn rule110(l: i32, c: i32, r: i32) -> i32 { (110 >> (l * 4 + c * 2 + r)) & 1 }',
    'fn step(cur: [i32; 64]) -> [i32; 64] {',
    '  let mut next = [0; 64];',
    '  for i in 0..64 {',
    '    let l = if i == 0 { 0 } else { cur[i - 1] };',
    '    let r = if i == 63 { 0 } else { cur[i + 1] };',
    '    next[i] = rule110(l, cur[i], r);',
    '  }',
    '  next',
    '}',
    'let mut cells = [0; 64]; cells[63] = 1;',
  ].join('\n'))
  const r = s.run('for g in 0..32 { print(cells); cells = step(cells); }')
  assert.equal(r.error, undefined)
  const expected = rule110(32)
  assert.equal(expected.length, 32)
  assert.deepEqual(r.out, expected)
  assert.ok(r.out[31]!.includes('1, 1, 0, 1, 1'), 'the triangle has grown')
  assert.ok(r.steps > 50_000 && r.steps < LIMITS.steps, `${r.steps} steps`)
  assert.notDeepEqual(r.out[31], r.out[0])
})

test('Turing witness: a tape-machine interpreter written in NoirScript runs two programs to their known output', () => {
  // The machine: a tape of 64 cells, a data pointer and seven instructions coded 1..7 (> < + - . [ ]), 0 ending the
  // program; `.` prints the cell as a number. The programs are the ones repl.test.ts runs through R0's interpreter.
  const codes = (text: string): number[] => [...text].map((c) => '><+-.[]'.indexOf(c) + 1)
  const first = codes('++++++++[>+++++++++<-]>.+.>+++[>+++++++++++<-]>.')
  const second = codes('+[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>[<+>-]<[>++<-]>.>>++++++[>++++++++<-]+++++[>.+<-]')
  const size = Math.max(first.length, second.length) + 1
  const program = (p: number[]): string => `[${[...p, ...Array<number>(size - p.length).fill(0)].join(', ')}]`
  const s = fresh()
  say(s, [
    `fn runprog(prog: [i32; ${size}]) {`,
    '  let mut tape = [0; 64];',
    '  let mut pc = 0;',
    '  let mut dp = 0;',
    '  while prog[pc] != 0 {',
    '    let ins = prog[pc];',
    '    if ins == 1 { dp += 1; }',
    '    else if ins == 2 { dp -= 1; }',
    '    else if ins == 3 { tape[dp] += 1; }',
    '    else if ins == 4 { tape[dp] -= 1; }',
    '    else if ins == 5 { print(tape[dp]); }',
    '    else if ins == 6 {',
    '      if tape[dp] == 0 {',
    '        let mut depth = 1;',
    '        while depth > 0 { pc += 1; if prog[pc] == 6 { depth += 1; } if prog[pc] == 7 { depth -= 1; } }',
    '      }',
    '    }',
    '    else if ins == 7 {',
    '      if tape[dp] != 0 {',
    '        let mut depth = 1;',
    '        while depth > 0 { pc -= 1; if prog[pc] == 7 { depth += 1; } if prog[pc] == 6 { depth -= 1; } }',
    '      }',
    '    }',
    '    pc += 1;',
    '  }',
    '}',
  ].join('\n'))
  const a = s.run(`runprog(${program(first)});`)
  assert.equal(a.error, undefined)
  assert.deepEqual(a.out, ['72', '73', '33'], 'H I !')
  assert.ok(a.steps > 1000 && a.steps < LIMITS.steps, `${a.steps} steps`)
  const b = s.run(`runprog(${program(second)});`)
  assert.equal(b.error, undefined)
  assert.deepEqual(b.out, ['64', '48', '49', '50', '51', '52'], '@ 0 1 2 3 4')
  assert.deepEqual(say(s, `runprog(${program(codes('+++.'))});`), ['3'])
})

// ---------------------------------------------------------------------------------------------------
// Determinism

test('determinism: two sessions fed the same thirty lines print identical output and count identical steps', () => {
  const lines = [
    'let mut s = 0; for i in 0..10 { s += i * i; } print(s);',
    'fn fib(n: i32) -> i32 { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } } print(fib(15));',
    'let v = f32x4(1.0, 2.0, 3.0, 4.0); let w = v * splat_f32x4(2.0); print(w, hsum(w));',
    'let m = vlt(f32x4(1.0, 5.0, 3.0, 7.0), splat_f32x4(4.0)); print(select(m, splat_f32x4(1.0), splat_f32x4(0.0)));',
    'let near = query cars where speed > 5.0; print(near);',
    'let mut acc = splat_f32x4(0.0); let mut i = 0; while i < crowd.n { acc = acc + load_f32x4(crowd.x, i); i += 4; } print(hsum(acc));',
    'print(morton2(3u, 5u), popcount(0xF0F0u), 7 >> 1, -8 >> 1, (0u - 1u) >> 28);',
    'print(1 / 0);',
    'let x: i32 = true;',
    'loop { }',
    'print(s, fib(10), near);',
    'fn sq(x: i32) -> i32 { x * x } print(sq(7), sq(-7));',
    'let mut g = 0.0; for k in 0..100 { g += 0.1; } print(g);',
    'print(tune("car.power", 2.0));',
    'fn r(n: i32) -> i32 { r(n + 1) } print(r(0));',
    'print(crowd.n, cars.n, kernel.law1, frame.fps, cars.mode[1]);',
    'let arr = [3, 1, 4, 1, 5]; let mut best = arr[0]; for i in 1..arr.len() { best = max(best, arr[i]); } print(best, arr);',
    'print(query crowd where x > 5.0 && z < 0.0, query cars where mode == 2);',
    'let big = [0; 1048576];',
    'print(1.5 as i32, -1 as u32, 4294967295u as f32, 0.1 + 0.2);',
    'fn ev(n: i32) -> bool { if n == 0 { true } else { od(n - 1) } } fn od(n: i32) -> bool { if n == 0 { false } else { ev(n - 1) } } print(ev(10), od(10));',
    'print(arr[5]);',
    'let mut u = 0u; u -= 1u; print(u, u >> 4, rotl(u, 3u), clz(u), ctz(8u));',
    'print(select(mask(1 < 2), 10, 20), select(mask(1 > 2), 10, 20), any(vne(w, w)), all(veq(w, w)));',
    'for i in 0..3 { print(i, if i % 2 == 0 { "even" } else { "odd" }); }',
    'let z = if s > 100 { s } else { 0 }; print(z, if false { 1.5 } else { 2.5 });',
    'print(steer("boom", 1.0));',
    'fn sq(x: f32) -> f32 { x * x } print(sq(1.5));',
    'print(hmin(w), hmax(w), hsum(splat_u32x8(7u)), splat_u32x8(1u) << 3, -v);',
    'print(1);',
  ]
  assert.equal(lines.length, 30)
  const a = fresh(), b = fresh()
  const ha = fake(), hb = fake()
  const ra: string[] = [], rb: string[] = []
  for (const line of lines) {
    ra.push(JSON.stringify(a.run(line, ha.host)))
    rb.push(JSON.stringify(b.run(line, hb.host)))
  }
  assert.deepEqual(ra, rb)
  assert.deepEqual(ha.calls, hb.calls)
  assert.deepEqual(a.words(), b.words())
  assert.ok(ra.some((r) => r.includes('"error"')), 'the lines include failures')
  assert.ok(ra.filter((r) => !r.includes('"error"')).length > 20, 'and successes')
  assert.deepEqual(a.asm('print(fib(5), sq(2.0));').out, b.asm('print(fib(5), sq(2.0));').out)
  const again = fresh()
  for (const line of lines) again.run(line, fake().host)
  assert.deepEqual(again.words(), a.words())
})

test('a col is the column\'s name: a binding from an earlier line reads each run\'s snapshot, and a zeroed one names no column', () => {
  const s = fresh()
  const four: NoirHost = { tables: () => ({ ...EMPTY_TABLES, crowd: { n: 4, x: Float32Array.of(10, 20, 30, 40), z: Float32Array.of(1, 2, 3, 4) } }) }
  assert.deepEqual(say(s, 'let xs = crowd.x; print(xs, xs[3], xs.len());', four), ['col<f32>[4] 40 4'])
  assert.deepEqual(say(s, 'print(xs, xs.len(), crowd.n);', null), ['col<f32>[0] 0 0'], 'the same name over an empty snapshot')
  assert.equal(err(s, 'print(xs[3]);', null), 'index 3 out of bounds (len 0)')
  assert.deepEqual(say(s, 'let big = [7; 100]; print(xs, big[19]);'), ['col<f32>[0] 7'], 'a later global never shows through a col')
  assert.deepEqual(say(s, 'fn f(c: col<f32>) -> f32 { c[3] } print(f(xs), xs[3], query crowd where x > 0.0, load_f32x4(xs, 1));', four), ['40 40 4 f32x4(20, 30, 40, 0)'])
  // A col global whose `let` never ran holds 0, which names no column.
  const t = fresh()
  assert.equal(t.run('let d = 1 / 0; let c = crowd.x;', four).error, 'division by zero')
  assert.deepEqual(say(t, 'print(c, c.len());', four), ['col<f32>[0] 0'])
  assert.equal(err(t, 'print(c[0]);', four), 'index 0 out of bounds (len 0)')
  assert.deepEqual(say(t, 'let mut m = crowd.z; m = crowd.x; print(m[0], m.len());', four), ['10 4'])
})

test('limits are made sane before a run: a bad field falls back, cells and depth are capped, and run never throws', () => {
  assert.deepEqual(saneLimits(LIMITS, LIMITS), LIMITS)
  assert.deepEqual(saneLimits({}, LIMITS), LIMITS)
  assert.deepEqual(saneLimits(null, LIMITS), LIMITS)
  assert.deepEqual(saneLimits({ steps: NaN, out: Infinity, cells: -5, depth: 2.9 }, LIMITS), { ...LIMITS, cells: 0, depth: 2 })
  assert.deepEqual(saneLimits({ cells: 1e12, depth: 1e12 }, LIMITS), { ...LIMITS, cells: MAX_CELLS, depth: MAX_DEPTH })
  assert.equal(MAX_CELLS, 16_777_216)
  const s = fresh()
  assert.deepEqual(say(s, 'let g = 5; fn d(n: i32) -> i32 { if n == 0 { 0 } else { d(n - 1) + 1 } }'), [])
  for (const lim of [{ ...LIMITS, depth: 1e12 }, { ...LIMITS, depth: -1 }, { ...LIMITS, cells: NaN }, {} as NoirLimits, { steps: 1000 } as NoirLimits, { ...LIMITS, steps: NaN }, { ...LIMITS, cells: 2 ** 31 }]) {
    assert.deepEqual(s.run('print(g);', null, lim).out, ['5'], JSON.stringify(lim))
  }
  assert.equal(s.run('print(d(3));', null, { ...LIMITS, depth: -1 }).error, 'stack overflow (depth 0)')
  assert.deepEqual(s.run('print(d(2));', null, { ...LIMITS, depth: 3.5 }).out, ['2'], 'three frames: d(2), d(1), d(0)')
  assert.equal(s.run('print(d(3));', null, { ...LIMITS, depth: 3.5 }).error, 'stack overflow (depth 3)')
  const nan = s.run('loop { }', null, { ...LIMITS, steps: NaN })
  assert.equal(nan.error, 'step budget exhausted (1000000)', 'NaN is the session\'s budget, not no budget')
  assert.equal(s.run('print(1);', null, { ...LIMITS, steps: 0 }).error, 'step budget exhausted (0)')
  assert.equal(new NoirSession({ cells: 0 } as NoirLimits).run('let x = 1;').error, 'memory exhausted')
  assert.deepEqual(new NoirSession({ steps: NaN, out: NaN, cells: NaN, depth: NaN }).run('print(2);').out, ['2'])
  assert.deepEqual(say(s, 'print(g, d(2));'), ['5 2'], 'the session is whole afterwards')
})

test('a host write that re-enters run() on the same session gets "session busy" and the outer run is untouched', () => {
  const s = fresh()
  let inner: NoirResult | undefined
  const host: NoirHost = { tables: () => EMPTY_TABLES, write: { tune: () => { inner = s.run('let zz = [1; 1000]; print(zz.len());'); return 0 }, intent: () => false, cull: () => 0, steer: () => 0 } }
  const r = s.run('fn f() -> i32 { let loc = [7; 8]; let r = tune("k", 1.0); loc[3] } print(f());', host)
  assert.deepEqual(r.out, ['7'])
  assert.equal(r.error, undefined)
  assert.deepEqual(inner, { out: [], error: 'session busy: a host write re-entered run()', steps: 0, defined: [] })
  assert.equal(err(s, 'print(zz.len());'), "1:7: unknown name 'zz'", 'the inner line installed nothing')
  assert.deepEqual(say(s, 'print(f());', host), ['7'])
})

test('a host whose write is null or not an object has no write surface: the locked message, not a JS error', () => {
  const s = fresh()
  for (const write of [null, 1, 'w', true]) {
    const r = s.run('print(tune("k", 1.0));', { tables: () => EMPTY_TABLES, write: write as unknown as NoirWrites })
    assert.equal(r.error, 'elite tier locked', String(write))
  }
  assert.equal(s.run('print(cull(0.5));', { tables: () => EMPTY_TABLES, write: null as unknown as NoirWrites, locked: 'no' }).error, 'no')
})

test('a row count of Infinity or beyond the columns is as many rows as the columns hold; NaN and negatives are none', () => {
  const s = fresh()
  const with_ = (n: number): NoirHost => ({ tables: () => ({ ...EMPTY_TABLES, crowd: { n, x: Float32Array.of(1, 2, 3), z: Float32Array.of(1, 2, 3) } }) })
  assert.deepEqual(say(s, 'print(crowd.n, crowd.x.len(), query crowd where x > 0.0);', with_(Infinity)), ['3 3 3'])
  assert.deepEqual(say(s, 'print(crowd.n, crowd.x.len());', with_(1e300)), ['3 3'])
  assert.deepEqual(say(s, 'print(crowd.n, crowd.x.len());', with_(2.9)), ['2 2'])
  assert.deepEqual(say(s, 'print(crowd.n, crowd.x.len());', with_(NaN)), ['0 0'])
  assert.deepEqual(say(s, 'print(crowd.n, crowd.x.len());', with_(-1)), ['0 0'])
})

test('a query row costs its where expression plus the loop\'s own three instructions (pinned; the spec said one)', () => {
  const s = fresh()
  const { host } = fake()
  const none = s.run('print(query cars where true);', { tables: () => EMPTY_TABLES })
  const three = s.run('print(query cars where true);', host)
  assert.deepEqual([none.out, three.out], [['0'], ['3']])
  assert.equal((three.steps - none.steps) / 3, 4, 'QNEXT, the where (PUSH true), QACC, JMP: four a row with a one-instruction where')
  const ten = s.run('print(query crowd where x > 3.0);', host)
  assert.equal((ten.steps - none.steps) / 10, 6, 'a where of three instructions (QCOL, PUSH, GT) makes six')
})
