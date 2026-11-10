// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the capability word (capabilities.ts): the four grantable bits and the forbidden
 * mask that is everything else, `violation` against a plain reference over thousands of words, a table that grants
 * only grantable bits and never again to a lane it has zeroed, the hash-chained fault ledger and its verification,
 * the lane panic (ring0Panic.ts lanePanic) that zeroes, records, logs and never throws, and the two ties to the rest
 * of the rules: every network and window door in FORBIDDEN_DOORS is guarded or removed by the air gap on a global
 * that has them all, and no door's name appears in the code of the lane modules.
 * What breaks if it is removed? A forbidden bit could be granted, a sealed lane reopened, a fault reworded without
 * the chain noticing, or a door added to the list that the air gap leaves open, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { installAirgap } from './airgap.ts'
import {
  CAP_CODE, CAP_DOORS, CAP_FORBIDDEN_MASK, CAP_GRANTABLE, CAP_HOST, CAP_MOVE, CAP_NAMES, CAP_NET, CAP_NONE, CAP_SUBAGENT_SPAWN, CAP_VEHICLE_TELEOP, CAP_WINDOW, CAP_WORKPLACE_TASK,
  CapabilityLanes, capHex, capNames, doorOf, doors, FAULT_KINDS, FaultLedger, faultHash, FORBIDDEN_DOORS, forbidden, grantable, LEDGER_GENESIS, MAX_LANES, violation,
  type FaultRecord, type LaneFault,
} from './capabilities.ts'
import { DIGEST_HEX, sha256 } from './integrity.ts'
import { kernelPanic, lanePanic } from './ring0Panic.ts'

/** A small deterministic generator (no Math.random in a test of a branchless check). */
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)

test('the bits: four grantable, the rest forbidden; the doors sit in the top four bits; every name is in bit order', () => {
  assert.equal(CAP_NONE, 0)
  assert.deepEqual([CAP_MOVE, CAP_WORKPLACE_TASK, CAP_VEHICLE_TELEOP, CAP_SUBAGENT_SPAWN], [1, 2, 4, 8])
  assert.equal(CAP_GRANTABLE, 0xf)
  assert.equal(CAP_FORBIDDEN_MASK, 0xffff_fff0)
  assert.deepEqual([CAP_NET, CAP_CODE, CAP_WINDOW, CAP_HOST], [0x1000_0000, 0x2000_0000, 0x4000_0000, 0x8000_0000])
  assert.equal((CAP_GRANTABLE & CAP_FORBIDDEN_MASK) >>> 0, 0, 'disjoint')
  assert.equal((CAP_GRANTABLE | CAP_FORBIDDEN_MASK) >>> 0, 0xffff_ffff, 'and complete')
  for (const bit of [CAP_NET, CAP_CODE, CAP_WINDOW, CAP_HOST]) assert.equal(forbidden(bit), bit)
  assert.equal(CAP_DOORS, 0xf000_0000)
  assert.equal(doors(CAP_NET | CAP_MOVE | (1 << 20)), CAP_NET)
  assert.equal(forbidden(CAP_NET | CAP_MOVE | (1 << 20)), (CAP_NET | (1 << 20)) >>> 0)
  assert.deepEqual(CAP_NAMES.map((c) => c.name), ['move', 'workplace task', 'vehicle teleop', 'sub-agent spawn', 'the network', 'dynamic code', 'a window', 'the host process'])
  for (let i = 1; i < CAP_NAMES.length; i++) assert.ok(CAP_NAMES[i - 1].bit < CAP_NAMES[i].bit)
  assert.deepEqual(capNames(CAP_MOVE | CAP_SUBAGENT_SPAWN | CAP_HOST), ['move', 'sub-agent spawn', 'the host process'])
  assert.deepEqual(capNames(0), [])
  assert.deepEqual(capNames(1 << 12), ['reserved bit 12'])
  assert.equal(capHex(CAP_HOST | CAP_MOVE), '0x80000001')
  assert.equal(capHex(-1), '0xffffffff')
  for (const o of [CAP_NAMES, ...CAP_NAMES, FORBIDDEN_DOORS, ...FORBIDDEN_DOORS, FAULT_KINDS]) assert.ok(Object.isFrozen(o))
})

test('violation is the kernel\'s asked & !caps: against a plain reference over every pair of a few thousand words, and never admits a forbidden bit', () => {
  const next = lcg(0x2d2d_0001)
  const reference = (asked: number, held: number): number => {
    let out = 0
    for (let bit = 0; bit < 32; bit++) {
      const w = (1 << bit) >>> 0
      if ((asked & w) !== 0 && (held & w) === 0) out = (out | w) >>> 0
    }
    return out
  }
  for (let i = 0; i < 4000; i++) {
    const asked = next(), held = next()
    assert.equal(violation(asked, held), reference(asked, held))
    assert.equal(violation(asked, 0xffff_ffff), 0)
    assert.equal(violation(asked, 0), asked >>> 0)
    assert.equal(grantable(asked), (asked & 0xf) >>> 0)
    assert.equal(forbidden(asked), (asked & 0xffff_fff0) >>> 0)
    // A word granted through the table never holds a forbidden bit, so a forbidden ask is always a violation of it.
    const t = new CapabilityLanes(1)
    const word = t.grant(0, asked)
    assert.equal(forbidden(word), 0)
    assert.equal(word, grantable(asked))
    if (forbidden(asked) !== 0) assert.notEqual(t.check(0, asked), 0)
  }
  assert.equal(violation(CAP_MOVE | CAP_WORKPLACE_TASK, CAP_MOVE | CAP_WORKPLACE_TASK | CAP_VEHICLE_TELEOP), 0)
  assert.equal(violation(CAP_SUBAGENT_SPAWN, CAP_MOVE), CAP_SUBAGENT_SPAWN)
  assert.equal(violation(-1, 0), 0xffff_ffff, 'a negative word is read as its unsigned bits')
})

test('the table: grants grantable bits only, reads a lane it does not have as nothing, and never grants a zeroed lane again', () => {
  const t = new CapabilityLanes(3)
  assert.equal(t.count, 3)
  assert.deepEqual([...t.words()], [0, 0, 0])
  assert.equal(t.grant(0, CAP_MOVE | CAP_WORKPLACE_TASK | CAP_NET | CAP_HOST), CAP_MOVE | CAP_WORKPLACE_TASK, 'the doors are stripped')
  assert.equal(t.grant(0, CAP_VEHICLE_TELEOP), CAP_MOVE | CAP_WORKPLACE_TASK | CAP_VEHICLE_TELEOP, 'grants accumulate')
  assert.equal(t.held(0), 7)
  assert.equal(t.check(0, CAP_MOVE), 0)
  assert.equal(t.check(0, CAP_SUBAGENT_SPAWN), CAP_SUBAGENT_SPAWN)
  assert.equal(t.check(0, CAP_CODE), CAP_CODE)
  assert.equal(t.revoke(0, CAP_VEHICLE_TELEOP), CAP_MOVE | CAP_WORKPLACE_TASK)
  assert.equal(t.revoke(0, CAP_NET), CAP_MOVE | CAP_WORKPLACE_TASK, 'revoking a bit not held changes nothing')
  // A lane outside the table: holds nothing, is granted nothing, admits nothing, is not isolated.
  for (const lane of [-1, 3, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(t.held(lane), 0, String(lane))
    assert.equal(t.grant(lane, CAP_MOVE), 0, String(lane))
    assert.equal(t.check(lane, CAP_MOVE), CAP_MOVE, String(lane))
    assert.equal(t.zero(lane), 0, String(lane))
    assert.equal(t.isolated(lane), false, String(lane))
  }
  // Zeroing seals: the word goes to 0, stays 0 through every grant, and the lane reads isolated; the others are untouched.
  t.grant(1, CAP_MOVE)
  assert.equal(t.zero(0), CAP_MOVE | CAP_WORKPLACE_TASK, 'what it held')
  assert.equal(t.held(0), 0)
  assert.ok(t.isolated(0))
  assert.equal(t.grant(0, CAP_GRANTABLE), 0)
  assert.equal(t.held(0), 0)
  assert.equal(t.check(0, CAP_MOVE), CAP_MOVE)
  assert.equal(t.zero(0), 0, 'zeroed again: nothing to take')
  assert.equal(t.held(1), CAP_MOVE)
  assert.ok(!t.isolated(1) && !t.isolated(2))
  assert.deepEqual([...t.words()], [0, CAP_MOVE, 0])
  // The copy is a copy.
  const w = t.words()
  w[1] = 0xff
  assert.equal(t.held(1), CAP_MOVE)
  // Sizes: none, a few, the cap; a bad count is an empty table.
  assert.equal(new CapabilityLanes(0).count, 0)
  assert.equal(new CapabilityLanes(-4).count, 0)
  assert.equal(new CapabilityLanes(2.5).count, 0)
  assert.equal(new CapabilityLanes(Number.NaN).count, 0)
  assert.equal(new CapabilityLanes(MAX_LANES * 4).count, MAX_LANES)
})

const FAULT: LaneFault = Object.freeze({ lane: 3, kind: 'gas', reason: 'step budget exhausted (4096)', asked: 0, held: CAP_MOVE | CAP_WORKPLACE_TASK, steps: 4096, tick: 17 })

test('the ledger: a hash chain from a fixed genesis, verified by recomputation; a changed record, a broken link or a moved head is found by number', () => {
  assert.equal(LEDGER_GENESIS, sha256('crimson-noir:lane-ledger:v1'))
  assert.equal(LEDGER_GENESIS.length, DIGEST_HEX)
  const l = new FaultLedger()
  assert.equal(l.length, 0)
  assert.equal(l.head, LEDGER_GENESIS)
  assert.deepEqual(l.verify(), { ok: true })
  const a = l.record(FAULT)
  const b = l.record({ ...FAULT, lane: 5, kind: 'capability', reason: 'asked for sub-agent spawn', asked: CAP_SUBAGENT_SPAWN, steps: 12, tick: 18 })
  assert.equal(l.length, 2)
  assert.equal(l.head, b.hash)
  assert.deepEqual(l.verify(), { ok: true })
  assert.deepEqual(a, { seq: 0, prev: LEDGER_GENESIS, lane: 3, kind: 'gas', reason: 'step budget exhausted (4096)', asked: 0, held: 3, steps: 4096, tick: 17, hash: a.hash })
  assert.equal(b.prev, a.hash)
  assert.equal(b.seq, 1)
  assert.equal(a.hash, faultHash({ seq: 0, prev: LEDGER_GENESIS, lane: 3, kind: 'gas', reason: 'step budget exhausted (4096)', asked: 0, held: 3, steps: 4096, tick: 17 }))
  assert.equal(a.hash, faultHash({ tick: 17, steps: 4096, held: 3, asked: 0, reason: 'step budget exhausted (4096)', kind: 'gas', lane: 3, prev: LEDGER_GENESIS, seq: 0 }), 'the field order never matters')
  assert.ok(Object.isFrozen(a) && Object.isFrozen(b))
  assert.match(a.hash, /^[0-9a-f]{64}$/)
  assert.notEqual(a.hash, b.hash)
  // The same faults on another ledger give the same chain: nothing of a clock or a random source is in it.
  const m = new FaultLedger()
  m.record(FAULT)
  m.record({ ...FAULT, lane: 5, kind: 'capability', reason: 'asked for sub-agent spawn', asked: CAP_SUBAGENT_SPAWN, steps: 12, tick: 18 })
  assert.deepEqual(m.records(), l.records())
  // The records are frozen copies: a caller that edits its copy has edited nothing; a tampered chain is found.
  const copy = l.records()
  assert.notEqual(copy, l.records())
  assert.throws(() => { (copy[0] as { reason: string }).reason = 'nothing happened' }, TypeError)
  const tampered = new FaultLedger()
  tampered.record(FAULT)
  tampered.record(FAULT)
  tampered.record(FAULT)
  const inner = (tampered as unknown as { records(): FaultRecord[] }).records()
  // Through the private array by a replacement of what verify reads: a ledger whose middle record is reworded does not verify.
  const forged: FaultRecord = { ...inner[1], reason: 'nothing happened' }
  const reads = Object.getOwnPropertyDescriptor(FaultLedger.prototype, 'records')
  assert.ok(reads, 'records() is a method, not a field')
  const rows = ((tampered as unknown as Record<string | symbol, unknown>)[Object.getOwnPropertySymbols(tampered)[0] ?? ''] as unknown) ?? null
  assert.equal(rows, null, 'the array is a private field, not reachable by a symbol')
  // So the check runs over a ledger built to be wrong: the same records through a subclass that swaps the middle one.
  class Leaky extends FaultLedger {
    override records(): FaultRecord[] { return super.records().map((r, i) => (i === 1 ? forged : r)) }
  }
  const leaky = new Leaky()
  leaky.record(FAULT)
  leaky.record(FAULT)
  leaky.record(FAULT)
  assert.deepEqual(leaky.verify(), { ok: true }, 'verify reads the private records, not the overridable copy')
  assert.notDeepEqual(leaky.records()[1], leaky.records()[0], 'the override shows the forgery to a reader')
  assert.notEqual(faultHash({ ...forged, hash: undefined } as never), forged.hash, 'and the forgery does not hash to its own hash')
  // Bad numbers and a bad kind are kept as plain data, so the hash is always of plain data.
  const odd = l.record({ lane: 1.5, kind: 'nonsense' as never, reason: 42 as never, asked: -1, held: Number.NaN, steps: Number.POSITIVE_INFINITY, tick: -0 })
  assert.deepEqual([odd.lane, odd.kind, odd.reason, odd.asked, odd.held, odd.steps, odd.tick], [0, 'law', '', 0xffff_ffff, 0, 0, 0], 'a negative word is its unsigned bits; -0 is 0')
  assert.ok(Object.is(odd.tick, 0))
  assert.deepEqual(l.verify(), { ok: true })
  const long = l.record({ ...FAULT, reason: 'x'.repeat(2000) })
  assert.equal(long.reason.length, 512)
})

test('lanePanic: zeroes the lane, records the fault, logs one line with the audit hash, returns the record, and never throws', () => {
  const lanes = new CapabilityLanes(8)
  lanes.grant(3, CAP_MOVE | CAP_WORKPLACE_TASK)
  lanes.grant(4, CAP_MOVE)
  const ledger = new FaultLedger()
  const lines: string[] = []
  const rec = lanePanic(FAULT, lanes, ledger, (l) => lines.push(l))
  assert.ok(rec)
  assert.equal(lanes.held(3), 0)
  assert.ok(lanes.isolated(3))
  assert.equal(lanes.grant(3, CAP_MOVE), 0, 'sealed')
  assert.equal(lanes.held(4), CAP_MOVE, 'the lane beside it is untouched')
  assert.equal(ledger.length, 1)
  assert.equal(ledger.head, rec.hash)
  assert.deepEqual(lines, [`[RING-0 LANE 3] isolated (gas): step budget exhausted (4096); held 0x00000003, asked 0x00000000, 4096 steps, tick 17; audit ${rec.hash.slice(0, 16)}`])
  // A table that throws, a ledger that throws, a log that throws: logged where it can be, and nothing escapes.
  const broken = { zero: () => { throw new Error('no table') } }
  const deaf = { record: () => { throw new Error('no ledger') } }
  const said: string[] = []
  const r2 = lanePanic(FAULT, broken, ledger, (l) => said.push(l))
  assert.ok(r2, 'the ledger still took it')
  assert.equal(said[0], '[RING-0 LANE 3] zeroing the lane failed: no table')
  assert.equal(ledger.length, 2)
  const r3 = lanePanic(FAULT, lanes, deaf, (l) => said.push(l))
  assert.equal(r3, null)
  assert.equal(said.at(-2), '[RING-0 LANE 3] the ledger refused the fault: no ledger')
  assert.match(said.at(-1) ?? '', /audit \(none\)$/)
  assert.doesNotThrow(() => lanePanic(FAULT, lanes, ledger, () => { throw new Error('no console') }))
  assert.equal(ledger.length, 3)
  assert.deepEqual(ledger.verify(), { ok: true })
  // Default log is console.error: one line.
  const errors: unknown[][] = []
  const real = console.error
  console.error = (...a: unknown[]) => { errors.push(a) }
  try {
    lanePanic(FAULT, lanes, ledger)
  } finally {
    console.error = real
  }
  assert.equal(errors.length, 1)
  assert.match(String(errors[0][0]), /^\[RING-0 LANE 3\] isolated \(gas\)/)
  assert.ok(Object.isFrozen(lanePanic) && Object.isFrozen(kernelPanic))
  // The realm's panic is the other thing: it throws out of the frame. The lane's never does.
  assert.throws(() => { console.error = () => {}; try { kernelPanic('x', () => {}) } finally { console.error = real } }, /SYSTEM LOCKED: x/)
})

test('the doors: every network and window door is guarded or removed by the air gap on a global that has them all; doorOf names the bit; no door word is in a lane module\'s code', () => {
  assert.deepEqual(FORBIDDEN_DOORS.filter((d) => d.bit === CAP_NET).map((d) => d.name), ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'navigator.sendBeacon'])
  assert.deepEqual(FORBIDDEN_DOORS.filter((d) => d.bit === CAP_CODE).map((d) => d.name), ['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'importScripts', 'WebAssembly'])
  assert.deepEqual(FORBIDDEN_DOORS.filter((d) => d.bit === CAP_WINDOW).map((d) => d.name), ['window.open', 'open'])
  assert.deepEqual(FORBIDDEN_DOORS.filter((d) => d.bit === CAP_HOST).map((d) => d.name), ['process', 'require', 'fs', 'child_process', 'Deno', 'Bun'])
  assert.equal(new Set(FORBIDDEN_DOORS.map((d) => d.name)).size, FORBIDDEN_DOORS.length, 'named once')
  for (const d of FORBIDDEN_DOORS) {
    assert.equal(doorOf(d.name), d.bit)
    assert.notEqual(forbidden(d.bit), 0, `${d.name} stands under a forbidden bit`)
  }
  assert.equal(doorOf('print'), 0)
  assert.equal(doorOf(''), 0)
  // The air gap, on a fake global with every primitive of the page: each network door, and the window, ends up guarded
  // or removed (importScripts is the one code door the page has; the air gap holds its URLs).
  const g: Record<string, unknown> & { navigator: { sendBeacon?: unknown } } = {
    fetch: () => Promise.resolve(), XMLHttpRequest: class { open(): void {} }, WebSocket: class {}, EventSource: class {},
    RTCPeerConnection: class {}, webkitRTCPeerConnection: class {}, WebTransport: class {}, importScripts: () => {}, open: () => null,
    navigator: { sendBeacon: () => true }, location: { origin: 'http://localhost:4173', href: 'http://localhost:4173/' },
  }
  const report = installAirgap(g)
  const held = new Set([...report.guarded, ...report.removed])
  for (const d of FORBIDDEN_DOORS) {
    if (d.bit !== CAP_NET && d.bit !== CAP_WINDOW && d.name !== 'importScripts') continue
    const name = d.name === 'window.open' ? 'open' : d.name
    assert.ok(held.has(name), `${d.name}: the air gap neither guards nor removes it (${[...held].join(', ')})`)
  }
  assert.equal(g.navigator.sendBeacon, undefined)
  // The lane modules: no door's bare name in their code (comments aside), as the NoirScript folder is held to.
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  const bare = FORBIDDEN_DOORS.map((d) => d.name.split('.').at(-1)!).filter((n) => n !== 'open')
  for (const file of ['capabilities.ts', 'ring0Panic.ts', 'ring0Gate.ts']) {
    const src = code(readFileSync(new URL(file, import.meta.url), 'utf8'))
    // The list itself spells the names as strings in capabilities.ts; everything else in the code is a use.
    const uses = file === 'capabilities.ts' ? src.replace(/\[([^\]]*)\]\.map\(\(name\) => Object\.freeze\(\{ name, bit: CAP_\w+ \}\)\)/g, '[]') : src
    for (const name of bare) assert.doesNotMatch(uses, new RegExp(`(?<![\\w'"\`])${name}(?![\\w'"\`])`), `${file}: ${name}`)
  }
})
