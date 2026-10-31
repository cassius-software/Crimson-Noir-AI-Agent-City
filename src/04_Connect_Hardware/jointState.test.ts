// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the joint bridge's vocabulary (jointState.ts): a manifest judged from JSON by
 * the URDF reader's rules (names, the tree, the kinds, the limits, the bounds), a manifest's JSON read back equal, a
 * frame and targets judged (lengths against the movable count, empty arrays allowed, finiteness, seq and stamps),
 * targets clamped to the manifest's limits with the count, the HAL/1 lines: one line or numbered parts that each fit
 * the bound, reassembled in order and refused out of order or at another version, a frame line that shrinks its
 * digits and then drops τ and q̇ to fit, and lines that are not the bridge's left alone. No robot here.
 * What breaks if it is removed? A frame of the wrong length or a split manifest out of order could reach a body.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildManifest, byteLength, checkFrame, checkTargets, clampTargets, frameLine, JOINT_LINE, manifestJson, manifestLines, ManifestAssembler, MAX_JOINTS, parseJointLine, readManifest, validName,
  type JointFrame, type JointTargets, type Manifest,
} from './jointState.ts'
import { LINE } from './lineLink.ts'

const link = (name: string, mass = 1) => ({ name, mass, shape: { kind: 'sphere', radius: 0.05 } })
const joint = (name: string, parent: string, child: string, kind = 'revolute', extra: Record<string, unknown> = {}) =>
  ({ name, kind, parent, child, axis: [0, 0, 1], lower: -1, upper: 1, effort: 10, velocity: 2, ...extra })

function arm(n: number): Manifest {
  const links = [link('base', 0)]
  const joints = []
  for (let i = 0; i < n; i++) {
    links.push(link(`l${i}`))
    joints.push(joint(`j${i}`, i === 0 ? 'base' : `l${i - 1}`, `l${i}`))
  }
  const r = buildManifest('arm', links, joints)
  assert.ok(r.ok, r.ok ? '' : r.reason)
  return r.value
}

test('names: printable ASCII without spaces, slashes, +, # or quotes, 1 to 64 characters', () => {
  assert.ok(validName('shoulder_pan.1') && validName('a') && validName('x'.repeat(64)))
  for (const bad of ['', 'x'.repeat(65), 'a b', 'a/b', 'a+b', 'a#b', 'a"b', 'é', 42, null, undefined]) assert.equal(validName(bad), false, String(bad))
})

test('a manifest from JSON: judged by the reader\'s rules, read back equal from its own JSON, bounded', () => {
  const m = arm(2)
  assert.deepEqual(m.movable, [0, 1])
  assert.equal(m.root, 'base')
  const back = readManifest(manifestJson(m))
  assert.ok(back.ok)
  assert.deepEqual(back.value, m)
  assert.deepEqual(m.joints[0].axis, [0, 0, 1])
  for (const [robot, links, joints, why] of [
    ['', [link('a')], [], /robot needs a name/],
    ['r', [], [], /at least one link/],
    ['r', [{ name: 'a', shape: { kind: 'box', size: [1, 0, 1] } }], [], /box needs a positive size/],
    ['r', [link('a'), link('b')], [joint('j', 'a', 'b', 'revolute', { effort: undefined })], /no effort or no velocity/],
    ['r', [link('a'), link('b')], [joint('j', 'a', 'b', 'revolute', { lower: NaN })], /finite numbers/],
    ['r', [link('a'), link('b')], [joint('j', 'a', 'b', 'revolute', { damping: -1 })], /damping and friction/],
    ['r', [link('a'), link('b')], [joint('j', 'a', 'b', 'revolute', { mimic: { joint: 'zz' } })], /mimics 'zz', which is not declared/],
    ['r', [link('a'), link('b')], [joint('j', 'a', 'a')], /to itself/],
    ['r', [link('a'), link('b')], [joint('j', 'a', 'b', 'revolute', { axis: [0, 0] })], /axis needs three numbers/],
    ['r', [link('a'), link('b')], [joint('j', 'a', 'b', 'revolute', { origin: { xyz: [0, 0, 0] } })], /origin needs xyz and rpy/],
  ] as const) {
    const r = buildManifest(robot, [...links], [...joints])
    assert.ok(!r.ok && why.test(r.reason), `${JSON.stringify(joints)}: ${r.ok ? 'accepted' : r.reason}`)
  }
  const planar = buildManifest('r', [link('a'), link('b')], [joint('j', 'a', 'b', 'planar')])
  assert.ok(planar.ok && planar.value.movable.length === 0, 'a planar joint is read and has no scalar state')
  const big = arm(MAX_JOINTS)
  assert.equal(big.movable.length, MAX_JOINTS)
  const tooBig = buildManifest('r', Array.from({ length: MAX_JOINTS + 2 }, (_, i) => link(`l${i}`)), Array.from({ length: MAX_JOINTS + 1 }, (_, i) => joint(`j${i}`, `l${i}`, `l${i + 1}`)))
  assert.ok(!tooBig.ok && /too many (links|joints)/.test(tooBig.reason))
  assert.ok(!readManifest('nope').ok && !readManifest('[]').ok && !readManifest('{"robot":"r"}').ok)
})

test('frames and targets: lengths against the movable count, empty arrays allowed, finite numbers, seq and stamps', () => {
  const ok = checkFrame(2, { stamp: 10, seq: 1, q: [0.1, 0.2], qd: [], tau: [1, 2] })
  assert.ok(ok.ok)
  assert.deepEqual(ok.value, { stamp: 10, seq: 1, q: [0.1, 0.2], qd: [], tau: [1, 2] })
  assert.ok(Object.isFrozen(ok.value) && Object.isFrozen(ok.value.q))
  const missing = checkFrame(2, { stamp: 10, seq: 1 })
  assert.ok(missing.ok && missing.value.q.length === 0, 'a frame with no arrays is a stamp alone')
  for (const [f, why] of [
    [null, /must be an object/],
    [{ seq: 1, q: [0, 0] }, /needs a stamp/],
    [{ stamp: -1, seq: 1 }, /needs a stamp/],
    [{ stamp: 1, seq: 1.5 }, /whole, non-negative seq/],
    [{ stamp: 1, seq: 1, q: [0] }, /q has 1 entries for 2 movable joints/],
    [{ stamp: 1, seq: 1, q: [0, NaN] }, /q\[1\] is not a finite number/],
    [{ stamp: 1, seq: 1, tau: 'x' }, /tau is not an array/],
  ] as const) {
    const r = checkFrame(2, f)
    assert.ok(!r.ok && why.test(r.reason), `${JSON.stringify(f)}: ${r.ok ? 'accepted' : r.reason}`)
  }
  const t = checkTargets(2, { seq: 3, issuedAt: 100, ttlMs: 200, q: [0, 1] })
  assert.ok(t.ok && t.value.qd.length === 0 && t.value.tau.length === 0)
  assert.ok(!checkTargets(2, { seq: 3, issuedAt: 100, ttlMs: 200 }).ok, 'targets need q')
  assert.ok(!checkTargets(2, { seq: 3, issuedAt: 100, ttlMs: 0, q: [0, 1] }).ok, 'a positive ttl')
  assert.ok(!checkTargets(2, { seq: -1, issuedAt: 100, ttlMs: 1, q: [0, 1] }).ok)
})

test('clampTargets holds q within the limits, q̇ within ±velocity and τ within ±effort, and counts what it changed', () => {
  const m = arm(2)
  const r = clampTargets(m, { seq: 1, issuedAt: 0, ttlMs: 1, q: [2, -0.5], qd: [-3, 1], tau: [11, 5] })
  assert.deepEqual(r.targets.q, [1, -0.5])
  assert.deepEqual(r.targets.qd, [-2, 1])
  assert.deepEqual(r.targets.tau, [10, 5])
  assert.equal(r.clamped, 3)
  const free = buildManifest('r', [link('a'), link('b')], [joint('j', 'a', 'b', 'continuous', { lower: undefined, upper: undefined, effort: 0, velocity: 0 })])
  assert.ok(free.ok)
  const c = clampTargets(free.value, { seq: 1, issuedAt: 0, ttlMs: 1, q: [100], qd: [1e3], tau: [-1e3] })
  assert.equal(c.clamped, 0, 'a continuous joint without caps is not clamped')
  assert.deepEqual(c.targets.q, [100])
})

test('manifest lines: one line when it fits, else numbered parts that each fit the bound and reassemble in order', () => {
  const small = arm(1)
  const one = manifestLines(small, LINE.maxLine)
  assert.ok(one && one.length === 1 && one[0].startsWith('JOINTS 1 {') && one[0].endsWith('\n'))
  const asm = new ManifestAssembler()
  const p = parseJointLine(one![0])
  assert.ok(p && p.kind === 'manifest' && p.part === 1 && p.parts === 1)
  const got = asm.feed(p as Extract<ReturnType<typeof parseJointLine>, { kind: 'manifest' }>)
  assert.ok(got && got.ok && got.value.robot === 'arm')
  const big = arm(12)
  const lines = manifestLines(big, LINE.maxLine)
  assert.ok(lines && lines.length > 1, 'twelve joints do not fit one line')
  for (const l of lines!) assert.ok(byteLength(l) <= LINE.maxLine, `${byteLength(l)} bytes`)
  assert.match(lines![0], /^JOINTS 1 1\/\d+ /)
  const asm2 = new ManifestAssembler()
  let out: ReturnType<ManifestAssembler['feed']> = null
  for (const l of lines!) {
    const pl = parseJointLine(l)
    assert.ok(pl && pl.kind === 'manifest')
    out = asm2.feed(pl as Extract<ReturnType<typeof parseJointLine>, { kind: 'manifest' }>)
  }
  assert.ok(out && out.ok)
  assert.deepEqual(out.value, big)
  // Out of order: part 3 after part 1 starts over; a new 1/n restarts; another version is refused.
  const asm3 = new ManifestAssembler()
  const parts = lines!.map((l) => parseJointLine(l) as Extract<ReturnType<typeof parseJointLine>, { kind: 'manifest' }>)
  assert.equal(asm3.feed(parts[0]), null)
  const oo = asm3.feed(parts[2])
  assert.ok(oo && !oo.ok && /out of order/.test(oo.reason))
  assert.equal(asm3.feed(parts[0]), null, 'starts again')
  const v = asm3.feed({ ...parts[1], version: 2 })
  assert.ok(v && !v.ok && /version 2 is not known/.test(v.reason))
  assert.equal(manifestLines(big, 40), null, 'a bound too small for sixteen bytes of body: no lines')
  assert.equal(manifestLines(arm(MAX_JOINTS), 300), null, 'more than maxParts parts: no lines')
  assert.equal(JOINT_LINE.maxParts, 64)
})

test('parseJointLine reads JS, JT and JOINTS lines with or without the newline, and leaves other lines alone', () => {
  assert.deepEqual(parseJointLine('JS {"a":1}\n'), { kind: 'state', body: '{"a":1}' })
  assert.deepEqual(parseJointLine('JT {"a":1}'), { kind: 'targets', body: '{"a":1}' })
  assert.deepEqual(parseJointLine('JOINTS 1 2/5 abc'), { kind: 'manifest', version: 1, part: 2, parts: 5, body: 'abc' })
  assert.deepEqual(parseJointLine('JOINTS 3 {}'), { kind: 'manifest', version: 3, part: 1, parts: 1, body: '{}' })
  for (const l of ['PING', 'PONG', 'READY x', '{"trigger":0.4}', 'JOINTS', 'JOINTSX 1 {}', 'JOINTS 1 0/5 x', 'JOINTS 1 6/5 x', 'JOINTS 1 1/65 x', 'js {}', 'JS', 'JT']) assert.equal(parseJointLine(l), null, l)
})

test('frameLine fits the bound by fewer digits, then no τ, then no q̇; null when q alone cannot fit', () => {
  const f: JointFrame = { stamp: 1234.5, seq: 7, q: [0.123456789, -1.5], qd: [0.000123456, 2], tau: [10.123456, -0.5] }
  const full = frameLine('state', f, LINE.maxLine)
  assert.equal(full, 'JS {"stamp":1234.5,"seq":7,"q":[0.123457,-1.5],"qd":[0.000123456,2],"tau":[10.1235,-0.5]}\n')
  const parsed = parseJointLine(full!)
  assert.ok(parsed?.kind === 'state')
  const back = checkFrame(2, JSON.parse(parsed.body))
  assert.ok(back.ok && back.value.seq === 7)
  const tight = frameLine('state', f, 89)
  assert.ok(tight && byteLength(tight) <= 89 && /"tau":\[10\.123,-0\.5\]/.test(tight), `fewer digits first: ${tight}`)
  const noTau = frameLine('state', f, 70)
  assert.ok(noTau && !/"tau"/.test(noTau) && /"qd"/.test(noTau), noTau ?? 'null')
  const qOnly = frameLine('state', f, 50)
  assert.ok(qOnly && !/"qd"/.test(qOnly) && byteLength(qOnly) === 48, qOnly ?? 'null')
  assert.equal(frameLine('state', f, 44), null)
  assert.equal(frameLine('state', f, 30), null)
  const t: JointTargets = { seq: 9, issuedAt: 5000, ttlMs: 100, q: [1, 2, 3], qd: [], tau: [] }
  const tl = frameLine('targets', t, LINE.maxLine)
  assert.equal(tl, 'JT {"seq":9,"issuedAt":5000,"ttlMs":100,"q":[1,2,3],"qd":[],"tau":[]}\n')
  const big: JointFrame = { stamp: 0, seq: 0, q: Array.from({ length: MAX_JOINTS }, (_, i) => i * 0.1234567), qd: Array.from({ length: MAX_JOINTS }, () => 1.23456), tau: Array.from({ length: MAX_JOINTS }, () => 12.3456) }
  const bl = frameLine('state', big, LINE.maxLine)
  assert.ok(bl && byteLength(bl) <= LINE.maxLine, 'sixty-four joints still fit with fewer figures')
})
