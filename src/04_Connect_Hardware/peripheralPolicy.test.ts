// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the draft peripheral gate: legacy HAL/1 gadgets stay telemetry-only, the CAPS
 * handshake refuses payload release, projectile and aiming capabilities for good, every refusal reason fires on the
 * state that should cause it (and only after the checks above it pass), and a Ring-0 panic, a broken tether or a lost
 * heartbeat disarms at once with the right broadcast.
 * What breaks if it is removed? A later change to the gate could admit an actuation it should refuse, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  admit, confirmArm, heartbeat, initialState, LEGACY_CAPABILITIES, parseCapabilities, POLICY, requestArm, ring0Panic,
  tetherBroken, watchdog, type Capabilities, type Command, type PolicyState,
} from './peripheralPolicy.ts'

const T0 = 10_000
const liveLease = { signal: { aborted: false } }
const fence = { minX: -40, maxX: 40, minZ: -40, maxZ: 40 }

function caps(line: string): Capabilities {
  const c = parseCapabilities(line)
  assert.ok(c && !('error' in c), `parsed: ${JSON.stringify(c)}`)
  return c
}

/** A device armed and ready: every check before the command's own passes. */
function armed(line: string): PolicyState {
  let s: PolicyState = { ...initialState(caps(line), T0), operator: true, lease: liveLease, geofence: fence, operatorAt: { x: 0, z: 0 } }
  const r = requestArm(s, 'n1', T0)
  assert.ok('state' in r, JSON.stringify(r))
  assert.equal(r.line, 'ARM n1\n')
  s = confirmArm(r.state, 'n1', T0)
  assert.equal(s.armed, true)
  return s
}

const DRONE = 'CAPS 1 {"class":"drone","telemetry":["gps","battery"],"actuation":["flight","light"],"limits":{"ceilingM":20}}'
const SERVO = 'CAPS 1 {"class":"actuator","telemetry":["angle"],"actuation":["servo"]}'
const servo = (seq: number, issuedAt = T0): Command => ({ kind: 'actuate', capability: 'servo', seq, issuedAt, ttlMs: 100, value: 0.5 })
const fly = (seq: number, p: Partial<{ x: number; z: number; altitudeM: number; speedMs: number }> = {}): Command =>
  ({ kind: 'flight', seq, issuedAt: T0, ttlMs: 100, setpoint: { x: 5, z: 5, altitudeM: 10, speedMs: 2, ...p } })

function refusal(s: PolicyState, c: Command, now = T0): string {
  const a = admit(s, c, now)
  return a.ok ? 'admitted' : a.refused
}

test('parseCapabilities: not a CAPS line is null; bad versions, bodies and classes are errors', () => {
  assert.equal(parseCapabilities('READY board'), null)
  assert.equal(parseCapabilities('{"speedKmh":4}'), null)
  assert.match((parseCapabilities('CAPS 2 {}') as { error: string }).error, /version 2/)
  assert.match((parseCapabilities('CAPS 1 {nope') as { error: string }).error, /JSON/)
  assert.match((parseCapabilities('CAPS 1 []') as { error: string }).error, /object/)
  assert.match((parseCapabilities('CAPS 1 {"class":"rover"}') as { error: string }).error, /class/)
})

test('parseCapabilities: payload release, projectile and aiming are refused as never; others by class; drone limits only go down', () => {
  const c = caps('CAPS 1 {"class":"drone","actuation":["flight","payload_release","drop","aim","projectile","launch","servo","Light","flight"],"limits":{"ceilingM":500,"speedMs":3,"rangeM":-1}}')
  assert.deepEqual(c.actuation, ['flight', 'light'])
  assert.deepEqual(c.refused, [
    { name: 'payload_release', reason: 'never' }, { name: 'drop', reason: 'never' }, { name: 'aim', reason: 'never' },
    { name: 'projectile', reason: 'never' }, { name: 'launch', reason: 'never' }, { name: 'servo', reason: 'not-allowed-for-class' },
  ])
  assert.deepEqual(c.limits, { ceilingM: POLICY.drone.ceilingM, speedMs: 3, rangeM: POLICY.drone.rangeM })
  const sensor = caps('CAPS 1 {"class":"sensor","telemetry":["temp"],"actuation":["motor"]}')
  assert.deepEqual([sensor.actuation, sensor.refused], [[], [{ name: 'motor', reason: 'not-allowed-for-class' }]])
})

test('a legacy HAL/1 gadget (no CAPS line): telemetry in is allowed, nothing out, and it cannot be armed', () => {
  const s: PolicyState = { ...initialState(LEGACY_CAPABILITIES, T0), operator: true, lease: liveLease }
  assert.deepEqual(admit(s, { kind: 'telemetry-in' }, T0), { ok: true, state: s })
  assert.equal(refusal(s, servo(1)), 'not-declared')
  assert.deepEqual(requestArm(s, 'n', T0), { refused: 'not-declared' })
})

test('the gate in order: operator tier, lease, arming — each refusal names the first missing condition', () => {
  const base = initialState(caps(SERVO), T0)
  assert.equal(refusal(base, servo(1)), 'no-operator-tier')
  const op = { ...base, operator: true }
  assert.equal(refusal(op, servo(1)), 'no-lease')
  assert.equal(refusal({ ...op, lease: { signal: { aborted: true } } }, servo(1)), 'no-lease')
  const leased = { ...op, lease: liveLease }
  assert.equal(refusal(leased, servo(1)), 'not-armed')
  assert.deepEqual(requestArm(base, 'n', T0), { refused: 'no-operator-tier' })
  assert.deepEqual(requestArm(op, 'n', T0), { refused: 'no-lease' })
  const pending = requestArm(leased, 'n7', T0)
  assert.ok('state' in pending)
  assert.equal(confirmArm(pending.state, 'wrong', T0).armed, false, 'a wrong echo does not arm')
  assert.equal(confirmArm(leased, 'n7', T0).armed, false, 'an echo with nothing pending does not arm')
  assert.equal(admit(armed(SERVO), servo(1), T0).ok, true)
})

test('refused at the handshake means refused for the session, whatever the state becomes', () => {
  const s = armed('CAPS 1 {"class":"actuator","actuation":["servo","payload_release","spray"]}')
  for (const capability of ['payload_release', 'spray', 'PAYLOAD_RELEASE', 'aim', 'projectile']) {
    assert.equal(refusal(s, { kind: 'actuate', capability, seq: 1, issuedAt: T0, ttlMs: 100, value: 1 }), 'refused-at-handshake', capability)
  }
  const s2 = { ...s, operator: true, lease: liveLease, armed: true, caps: { ...s.caps, actuation: [...s.caps.actuation, 'payload_release'] } }
  assert.equal(refusal(s2, { kind: 'actuate', capability: 'payload_release', seq: 1, issuedAt: T0, ttlMs: 100, value: 1 }), 'refused-at-handshake', 'even if its accepted list were edited')
})

test('sequence numbers only go up; time-to-live is short and checked both ways', () => {
  let s = armed(SERVO)
  const a = admit(s, servo(5), T0)
  assert.ok(a.ok)
  s = a.state
  assert.equal(refusal(s, servo(5)), 'stale-sequence', 'a replay')
  assert.equal(refusal(s, servo(4)), 'stale-sequence')
  assert.equal(refusal(s, servo(1.5)), 'stale-sequence')
  assert.equal(refusal(s, servo(6, T0 - 101)), 'expired')
  assert.equal(refusal(s, servo(6, T0 + 1)), 'expired', 'issued in the future')
  assert.equal(refusal(s, { ...servo(6), ttlMs: POLICY.maxTtlMs + 1 } as Command), 'expired')
  assert.equal(refusal(s, { ...servo(6), value: Number.NaN } as Command), 'non-finite')
  assert.equal(admit(s, servo(6, T0 - 100), T0).ok, true)
})

test('rate limit: the rolling second holds maxRatePerSecond commands', () => {
  let s = armed(SERVO)
  for (let i = 1; i <= POLICY.maxRatePerSecond; i++) {
    s = heartbeat(s, T0 + i)
    const a = admit(s, servo(i, T0 + i), T0 + i)
    assert.ok(a.ok, `command ${i}`)
    s = a.state
  }
  const n = POLICY.maxRatePerSecond + 1
  assert.equal(refusal(heartbeat(s, T0 + 50), servo(n, T0 + 50), T0 + 50), 'rate-limited')
  assert.equal(admit(heartbeat(s, T0 + 1001), servo(n, T0 + 1001), T0 + 1001).ok, true, 'the first one has left the window')
})

test('a drone: no geofence no arming; fence, ceiling (device lowered it), speed and range each refuse', () => {
  const noFence = { ...initialState(caps(DRONE), T0), operator: true, lease: liveLease }
  assert.deepEqual(requestArm(noFence, 'n', T0), { refused: 'no-geofence' })
  const s = armed(DRONE)
  assert.equal(admit(s, fly(1), T0).ok, true)
  assert.equal(refusal(s, fly(1, { x: 41 })), 'outside-geofence')
  assert.equal(refusal(s, fly(1, { altitudeM: -1 })), 'outside-geofence')
  assert.equal(refusal(s, fly(1, { altitudeM: 21 })), 'above-ceiling', 'the device declared 20 m')
  assert.equal(refusal(s, fly(1, { speedMs: POLICY.drone.speedMs + 0.1 })), 'over-speed')
  assert.equal(refusal({ ...s, operatorAt: { x: -39, z: -39 } }, fly(1, { x: 39, z: 39 })), 'beyond-range')
  assert.equal(refusal({ ...s, operatorAt: null }, fly(1)), 'beyond-range', 'no known operator position')
  assert.equal(refusal(s, fly(1, { x: Number.POSITIVE_INFINITY })), 'non-finite')
})

test('a lost heartbeat disarms: the watchdog and the gate both broadcast DISARM, and a drone lands where it is', () => {
  const s = armed(DRONE)
  assert.deepEqual(watchdog(s, T0 + POLICY.watchdogMs).broadcast, [])
  const w = watchdog(s, T0 + POLICY.watchdogMs + 1)
  assert.deepEqual(w.broadcast, ['DISARM heartbeat-lost\n', 'FAILSAFE LAND\n'])
  assert.equal(w.state.armed, false)
  const a = admit(s, { ...fly(1), issuedAt: T0 + 600 } as Command, T0 + 600)
  assert.ok(!a.ok)
  assert.equal(a.refused, 'heartbeat-lost')
  assert.deepEqual(a.broadcast, ['DISARM heartbeat-lost\n', 'FAILSAFE LAND\n'])
  assert.equal(a.state.armed, false)
  assert.deepEqual(watchdog(armed(SERVO), T0 + 9999).broadcast, ['DISARM heartbeat-lost\n'], 'no land line for a microcontroller')
})

test('a broken tether disarms at once, from the bridge, the watchdog or the gate', () => {
  const s = armed(SERVO)
  const t = tetherBroken(s, T0)
  assert.deepEqual([t.state.armed, t.state.lease, t.broadcast], [false, null, ['DISARM tether-broken\n']])
  const aborted = { ...s, lease: { signal: { aborted: true } } }
  assert.deepEqual(watchdog(aborted, T0).broadcast, ['DISARM tether-broken\n'])
  const a = admit(aborted, servo(1), T0)
  assert.ok(!a.ok)
  assert.deepEqual([a.refused, a.state.armed, a.broadcast], ['no-lease', false, ['DISARM tether-broken\n']])
})

test('a Ring-0 panic disarms, latches the lock and nothing re-arms or is admitted again', () => {
  const p = ring0Panic(armed(DRONE), T0)
  assert.deepEqual(p.broadcast, ['DISARM ring0-panic\n', 'FAILSAFE LAND\n'])
  assert.deepEqual([p.state.armed, p.state.locked], [false, true])
  assert.deepEqual(requestArm(p.state, 'n', T0), { refused: 'locked' })
  assert.equal(confirmArm({ ...p.state, armNonce: 'n' }, 'n', T0).armed, false)
  assert.equal(refusal({ ...p.state, armed: true }, fly(9)), 'locked')
  assert.deepEqual(p.state.audit.slice(-2).map((e) => e.event), ['disarmed', 'locked'])
})

test('the audit log records admissions and refusals and keeps the newest auditLength', () => {
  let s = armed(SERVO)
  s = (admit(s, servo(1), T0) as { state: PolicyState }).state
  s = admit(s, servo(1), T0).state
  assert.deepEqual(s.audit.slice(-2).map((e) => [e.event, e.detail]), [['admitted', 'servo #1'], ['refused', 'stale-sequence']])
  for (let i = 0; i < POLICY.auditLength + 10; i++) s = admit(s, servo(0), T0).state
  assert.equal(s.audit.length, POLICY.auditLength)
})

test('pacifist wording in the gate, its tests and its specification', () => {
  const words = /\b(attack|damage|weapon|kill|combat|target|shoot|gun|injur\w*|violen\w*|hit|crash\w*|collid\w*|collision|dead|death|die|blood|maim|wound|smash)\b/i
  for (const f of ['./peripheralPolicy.ts', './peripheralPolicy.test.ts', '../../docs/hal-peripherals-spec.md']) {
    const text = readFileSync(new URL(f, import.meta.url), 'utf8').replace(/const words = .*\n/, '')
    assert.doesNotMatch(text, words, f)
  }
})
