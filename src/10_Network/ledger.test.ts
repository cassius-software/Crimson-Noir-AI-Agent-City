// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the ledger check (ledger.ts) rule by rule, without a socket.
 * - The OS's own canonical configuration is read, and its SHA-256 is the digest crimson_noir_os/containment.lock pins.
 *   The Rust side's tests hold that file equal to the generator's output, so the two languages cannot drift apart.
 * - A configuration that is not the pinned one is refused, and so is one that is malformed, not air-gapped, or carries
 *   a name the 14A screen refuses.
 * - A good ledger verifies, and its folded weights are the kernel's integer arithmetic.
 * - Every containment rule refuses the entry that breaks it: a learn by a role never declared with learn, an
 *   impossible reward, a station the world lacks, a tick that goes back, an edited entry, an entry after the seal.
 * - A seal that misstates the head, the count or the weights is refused.
 * - One fixed link is pinned here and in the Rust tests: the two hash the same bytes the same way.
 * What breaks if it is removed? A rule of the ledger door could stop holding without anything noticing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import {
  admit, begin, contained, LEARN, producible, LEDGER_CHUNK, LEDGER_GENESIS, link, newSession, pairs, readCanonical, readLedgerMessage, REWARD_MAX, REWARD_MIN,
  roleOf, seal, weightsDigest, WIPE, type EntryBody, type LedgerSession,
} from './ledger.ts'
import { readLock } from './replication.node.ts'

const OS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crimson_noir_os')
const CANONICAL = readFileSync(join(OS, 'containment.canonical'), 'utf8')
const PINNED = sha256(CANONICAL)

/** Entries with their links, chained from `head`. */
function chain(bodies: EntryBody[], head = LEDGER_GENESIS): (number | string)[][] {
  const out: (number | string)[][] = []
  for (const b of bodies) {
    head = link(b, head)
    out.push([...b, head])
  }
  return out
}

function opened(): LedgerSession {
  const s = newSession()
  const r = begin(s, CANONICAL, PINNED)
  assert.ok(r.ok, r.ok ? '' : r.reason)
  return s
}

test('the OS configuration reads, and the lock pins exactly its canonical form', () => {
  assert.equal(readLock(readFileSync(join(OS, 'containment.lock'), 'utf8')), PINNED)
  const r = readCanonical(CANONICAL)
  assert.ok(r.ok)
  const c = r.value
  assert.deepEqual([c.name, c.seed, c.capacity, c.stations, c.learnShift, c.network], ['crimson-noir', 1337, 4096, 8, 3, false])
  assert.deepEqual(c.roles.map((x) => [x.name, x.count, x.caps.includes('learn')]), [['courier', 3072, true], ['sentry', 1023, false], ['tutor', 1, false]])
  // Roles fill the pool in their declared order.
  assert.equal(roleOf(c, 0)?.name, 'courier')
  assert.equal(roleOf(c, 3071)?.name, 'courier')
  assert.equal(roleOf(c, 3072)?.name, 'sentry')
  assert.equal(roleOf(c, 4095)?.name, 'tutor')
})

test('a configuration that is not the pinned one, malformed, networked or not 14A-clean is refused', () => {
  const edited = CANONICAL.replace('kernels.learnShift = 3;', 'kernels.learnShift = 1;')
  const r = begin(newSession(), edited, PINNED)
  assert.ok(!r.ok && /pinned/.test(r.reason), 'one changed setting is not the pinned configuration')
  // Read directly (as if pinned), each fault is named.
  const faults: [string, RegExp][] = [
    [CANONICAL.replace('containment.network = false;', 'containment.network = true;'), /air-gapped/],
    [CANONICAL.replace('system.name = "crimson-noir";', 'system.name = "kill-switch";'), /14A/],
    [CANONICAL.replace('roles.sentry.caps = [ "move" "memory" ];', 'roles.sentry.caps = [ "move" "network" ];'), /malformed/],
    [CANONICAL.replace('pool.capacity = 4096;', 'pool.capacity = 4000;'), /power of two/],
    [CANONICAL.replace('  world.stations = 8;\n', '  world.stations = 8;\n  world.stations = 8;\n'), /twice/],
    [CANONICAL.replace('}\n', '} trailing\n'), /canonical form/],
    [CANONICAL.replace('system.seed = 1337;', 'system.seed = 1337'), /key = value/],
    ['', /canonical form/],
  ]
  for (const [text, why] of faults) {
    const f = readCanonical(text)
    assert.ok(!f.ok && why.test(f.reason), `${why}: ${f.ok ? 'accepted' : f.reason}`)
  }
})

test('a good ledger verifies, and the fold is the kernel arithmetic', () => {
  const s = opened()
  const bodies: EntryBody[] = [
    [LEARN, 10, 5, 3, REWARD_MAX],
    [LEARN, 12, 5, 3, 1000],
    [LEARN, 12, 6, 0, REWARD_MIN],
    [WIPE, 20, 6, 0, 0],
    [LEARN, 30, 3071, 7, 4324],
  ]
  for (const e of chain(bodies)) assert.ok(admit(s, e).ok)
  // w = w + ((r - w) >> 3), on i32: 0 -> 8192 -> 8192 + ((1000 - 8192) >> 3) = 7293.
  const w = new Int32Array(4096 * 8)
  w[5 * 8 + 3] = 7293
  w[3071 * 8 + 7] = 4324 >> 3
  assert.deepEqual(pairs(s.weights), pairs(w), 'agent 6 was wiped back to nothing')
  assert.equal(contained(s.config!, s.weights), null)
  const r = seal(s, { head: s.head, count: 5, weights: weightsDigest(w) })
  assert.ok(r.ok, r.ok ? '' : r.reason)
})

test('every containment rule refuses the entry that breaks it', () => {
  const cases: [EntryBody, RegExp][] = [
    [[LEARN, 1, 3072, 0, 100], /sentry\) was never declared with learn/],
    [[LEARN, 1, 4095, 0, 100], /tutor\) was never declared with learn/],
    [[LEARN, 1, 7, 0, REWARD_MIN - 1], /reward/],
    [[LEARN, 1, 7, 0, REWARD_MAX + 1], /reward/],
    // In the range, but no clock gives it: (1 << 22) / 64 is 65536 and / 65 is 64527, nothing between.
    [[LEARN, 1, 7, 0, REWARD_MAX - 1], /reward 65535 is not one the kernel can produce/],
    [[LEARN, 1, 7, 8, 100], /station 8/],
    [[WIPE, 1, 7, 2, 0], /wipe carries no station/],
    [[LEARN, 1, 4096, 0, 100], /whole number in range/],
  ]
  for (const [body, why] of cases) {
    const s = opened()
    const r = admit(s, chain([body])[0])
    assert.ok(!r.ok && why.test(r.reason), `${body}: ${r.ok ? 'admitted' : r.reason}`)
  }
  // A tick that goes back, an edited entry (its hash no longer its link), a shape that is not an entry.
  const s = opened()
  const good = chain([[LEARN, 9, 1, 1, 500], [LEARN, 4, 2, 1, 500]])
  assert.ok(admit(s, good[0]).ok)
  const back = admit(s, good[1])
  assert.ok(!back.ok && /goes back/.test(back.reason))
  const t = opened()
  const edited = chain([[LEARN, 9, 1, 1, 500]])[0]
  edited[4] = 501
  const broken = admit(t, edited)
  assert.ok(!broken.ok && /chain breaks/.test(broken.reason))
  for (const junk of [null, 'x', [1, 2, 3], [0, 1, 2, 3, 4, 'nothex'], [0, -1, 2, 3, 4, LEDGER_GENESIS], [0.5, 1, 2, 3, 4, LEDGER_GENESIS]]) {
    assert.ok(!admit(opened(), junk).ok, JSON.stringify(junk))
  }
})

test('a seal that misstates the head, the count or the weights is refused, and nothing comes after it', () => {
  const make = (): LedgerSession => {
    const s = opened()
    for (const e of chain([[LEARN, 1, 9, 2, 800], [LEARN, 2, 10, 2, 900]])) assert.ok(admit(s, e).ok)
    return s
  }
  const right = (s: LedgerSession): Record<string, unknown> => ({ head: s.head, count: s.count, weights: weightsDigest(s.weights) })
  let s = make()
  assert.ok(!seal(s, { ...right(s), head: LEDGER_GENESIS }).ok)
  s = make()
  assert.ok(!seal(s, { ...right(s), count: 1 }).ok)
  s = make()
  assert.ok(!seal(s, { ...right(s), weights: sha256('something else') }).ok)
  s = make()
  assert.ok(seal(s, right(s)).ok)
  assert.ok(!seal(s, right(s)).ok, 'sealed twice')
  const after = admit(s, chain([[LEARN, 3, 11, 2, 900]], s.head)[0])
  assert.ok(!after.ok && /after the seal/.test(after.reason))
  // Before hello, nothing is admitted or sealed.
  assert.ok(!admit(newSession(), chain([[LEARN, 1, 1, 1, 100]])[0]).ok)
  assert.ok(!seal(newSession(), right(make())).ok)
})

test('the messages are read by shape before anything in them is trusted', () => {
  assert.ok(readLedgerMessage({ t: 'hello', v: 1, config: CANONICAL }).ok)
  assert.ok(!readLedgerMessage({ t: 'hello', v: 2, config: CANONICAL }).ok)
  assert.ok(!readLedgerMessage({ t: 'hello', v: 1, config: 'x'.repeat(9000) }).ok)
  assert.ok(!readLedgerMessage({ t: 'entries', list: [] }).ok)
  assert.ok(!readLedgerMessage({ t: 'entries', list: new Array(LEDGER_CHUNK + 1).fill(0) }).ok)
  assert.ok(!readLedgerMessage({ t: 'join' }).ok)
  assert.ok(!readLedgerMessage([]).ok)
})

test('the rewards the kernel can produce are exactly the ones admitted', () => {
  const made = new Set<number>()
  for (let clock = 0; clock <= 1 << 20; clock++) made.add(Math.floor((1 << 22) / (clock + 64)))
  for (let r = 0; r <= REWARD_MAX + 1; r++) assert.equal(producible(r), made.has(r), `reward ${r}`)
  assert.ok(!producible(1.5) && !producible(NaN) && !producible(-REWARD_MAX))
})

/** The same bytes hashed the same way on both sides: this link is pinned in crimson_noir_os/src/ledger.rs too. */
test('one fixed link, pinned in both languages', () => {
  assert.equal(link([LEARN, 5, 17, 3, 1234], LEDGER_GENESIS), sha256('[0,5,17,3,1234]' + LEDGER_GENESIS))
  assert.equal(link([LEARN, 5, 17, 3, 1234], LEDGER_GENESIS), '946cde523d47a899b5ae0179dfe233a94397a936c2b0a4f43d0c1be9b34d76fd')
})
