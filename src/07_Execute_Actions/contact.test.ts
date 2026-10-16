// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the contact wipe's decisions (contact.ts): the pole index agrees with a brute
 * force over the real city, gaps to boxes and bodies are exact, the avatar's own row and hidden rows are never met,
 * the deepest contact wins, and the pulse opens over `attack`, holds, clears over `release`, plays whole for a
 * glancing touch and counts each passage once. It also pins the wiring: the engine scans each crowd frame before
 * the upload hands it back, updates the pulse every animation frame, and keeps the post chain on while the wipe
 * plays; the composite runs on either uniform.
 * What breaks if it is removed? The wipe could fire on the user's own body, miss a lamp one cell over, stutter
 * on a glancing touch, or vanish at the Minimal tier, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { POLES, streetFurniture } from '../01_Initialize_World/city.ts'
import { chassisBox } from './car.ts'
import { CONTACT, CONTACT_KIND, ContactPulse, PoleIndex, boxGap, carGap, personGap, personGapToBox, touching } from './contact.ts'
import { GHOST_KIND } from './ghost.ts'
import { PERSON, POSE } from './simProtocol.ts'

const near = (a: number, b: number, eps = 1e-5) => Math.abs(a - b) <= eps

test('the kinds are the ghost view\'s, so the dissolve takes the same greens', () => {
  assert.equal(CONTACT_KIND.pole, GHOST_KIND.pole)
  assert.equal(CONTACT_KIND.vehicle, GHOST_KIND.vehicle)
  assert.equal(CONTACT_KIND.person, GHOST_KIND.person)
  assert.equal(CONTACT_KIND.none, 0)
})

test('PoleIndex: the nearest pole\'s surface, as a brute force over the real city finds it, everywhere within a cell', () => {
  const f = streetFurniture(1337)
  const index = new PoleIndex(f)
  const all = [
    ...f.lamps.map(([x, z]) => [x, z, POLES.lamp.radius]),
    ...f.trees.map(([x, z]) => [x, z, POLES.tree.radius]),
    ...f.signals.map(([x, z]) => [x, z, POLES.signal.radius]),
  ]
  assert.equal(index.count, all.length)
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32)
  let checked = 0
  for (let k = 0; k < 4000; k++) {
    // Around a random pole (so most probes have one near), or anywhere.
    const [px, pz] = all[Math.floor(rnd() * all.length)]
    const x = k % 2 ? px + (rnd() - 0.5) * 6 : rnd() * 700 - 30
    const z = k % 2 ? pz + (rnd() - 0.5) * 6 : rnd() * 700 - 30
    const pad = rnd() < 0.5 ? 0 : PERSON.radius
    const brute = Math.min(...all.map(([ax, az, r]) => Math.hypot(ax - x, az - z) - r - pad))
    const got = index.gap(x, z, pad)
    if (brute < CONTACT.cell - pad - 0.5) {
      assert.ok(near(got, brute, 1e-3), `(${x.toFixed(2)}, ${z.toFixed(2)}): ${got} against ${brute}`)
      checked++
    } else {
      assert.ok(got >= Math.min(brute, CONTACT.cell - pad - 0.5) - 1e-3, 'never nearer than the truth')
    }
  }
  assert.ok(checked > 2000, `${checked} probes had a pole within reach`)
  assert.equal(index.gap(Number.NaN, 0), CONTACT.far)
  assert.equal(index.gap(-5000, -5000), CONTACT.far, 'nothing out in the lake')
})

test('boxGap: outside is the distance to the rectangle, inside minus the depth, turned with the heading', () => {
  // Facing +z (heading 0): half length along z, half width along x.
  assert.ok(near(boxGap(0, 3, 0, 2, 1), 1))
  assert.ok(near(boxGap(2, 0, 0, 2, 1), 1))
  assert.ok(near(boxGap(2, 3, 0, 2, 1), Math.SQRT2))
  assert.ok(near(boxGap(0, 0, 0, 2, 1), -1), 'the centre is a half width deep')
  assert.ok(near(boxGap(0.5, 1.8, 0, 2, 1), -0.2))
  // Facing +x: the long side now runs along x.
  assert.ok(near(boxGap(3, 0, Math.PI / 2, 2, 1), 1))
  assert.ok(near(boxGap(0, 2, Math.PI / 2, 2, 1), 1))
  // Symmetric front and back, left and right.
  for (const h of [0, 0.7, 2.9, -1.3]) {
    assert.ok(near(boxGap(1.3, -2.2, h, 2, 1), boxGap(-1.3, 2.2, h, 2, 1)))
  }
})

/** A crowd render frame: pos (x, y, z, heading) per person first. */
function frame(people: [number, number, number][]): Float32Array {
  const f = new Float32Array(people.length * 12)
  people.forEach(([x, y, z], i) => { f[4 * i] = x; f[4 * i + 1] = y; f[4 * i + 2] = z })
  return f
}

test('personGap: body to body, never the avatar\'s own row 0, never a hidden row', () => {
  // Row 0 (the avatar) stands exactly on the point; row 1 is hidden; row 2 is 2 m away; row 3 is 0.4 m away.
  const f = frame([[10, 0, 10], [10.1, -100, 10], [12, 0, 10], [10, 0, 10.4]])
  assert.ok(near(personGap(f, 4, 10, 10, PERSON.radius), 0.4 - 2 * PERSON.radius), 'overlapping bodies: a negative gap')
  assert.ok(near(personGap(f, 3, 10, 10, PERSON.radius), 2 - 2 * PERSON.radius), 'agents limits the scan')
  assert.equal(personGap(frame([[10, 0, 10]]), 1, 10, 10, 0.3), CONTACT.far, 'alone: nobody to meet')
  assert.equal(personGap(null, 4, 10, 10, 0.3), CONTACT.far)
  assert.equal(personGap(f, 4, Number.NaN, 10, 0.3), CONTACT.far)
  // A frame shorter than the count says is read only as far as it goes.
  assert.ok(near(personGap(f.subarray(0, 12), 99, 10, 10, 0), 2 - PERSON.radius))
})

test('personGapToBox and carGap: a body in a car\'s footprint is inside it; the driven car is skipped', () => {
  const c = chassisBox(false)
  const f = frame([[0, 0, 0], [100 + c.hz + PERSON.radius + 1, 0, 50], [100, 0, 50 + c.hx]])
  // Car at (100, 50) facing +z: row 2 stands at the bumper, inside the footprint by a body radius.
  assert.ok(near(personGapToBox(f, 3, 100, 50, 0, c.hx, c.hz), -PERSON.radius))
  assert.ok(near(personGapToBox(f, 2, 100, 50, 0, c.hx, c.hz), 1), 'row 1 is a metre clear of the side')
  const poses = new Float32Array(2 * POSE.stride)
  poses[POSE.x] = 100; poses[POSE.z] = 50; poses[POSE.heading] = 0
  poses[POSE.stride + POSE.x] = -500; poses[POSE.stride + POSE.z] = -500
  const suv = [false, true]
  assert.ok(near(carGap(poses, suv, 100, 50 + c.hx + 1, 0.3), 0.7))
  assert.ok(carGap(poses, suv, 100, 50, 0.3) < 0, 'standing in the chassis')
  assert.ok(carGap(poses, suv, 100, 50, 0.3, 0) > 100, 'the skipped car is not met')
  assert.ok(carGap(poses, suv, -500, -500, 0) < 0, 'car 1 stands on the point')
  assert.ok(carGap(poses.subarray(0, POSE.stride), suv, -500, -500, 0) > 600, 'a short pose buffer ends the scan before car 1')
})

test('touching: the deepest contact wins; a gap of 0 or more, or not a number, is no contact', () => {
  assert.equal(touching({ pole: 0.1, person: 5, vehicle: CONTACT.far }), CONTACT_KIND.none)
  assert.equal(touching({ pole: 0, person: 0, vehicle: 0 }), CONTACT_KIND.none)
  assert.equal(touching({ pole: -0.1, person: 5, vehicle: CONTACT.far }), CONTACT_KIND.pole)
  assert.equal(touching({ pole: -0.1, person: -0.3, vehicle: CONTACT.far }), CONTACT_KIND.person)
  assert.equal(touching({ pole: -0.1, person: -0.3, vehicle: -0.5 }), CONTACT_KIND.vehicle)
  assert.equal(touching({ pole: Number.NaN, person: Number.NaN, vehicle: -Infinity }), CONTACT_KIND.none)
})

test('the pulse: open over attack while touching, hold, clear over release; the colour stays until it clears', () => {
  const p = new ContactPulse()
  const dt = 1 / 120
  let t = 0
  while (p.value < 1 && t < 1) { p.update(CONTACT_KIND.person, dt); t += dt }
  assert.ok(near(t, CONTACT.attack, dt + 1e-9), `full cover after ${t.toFixed(3)} s`)
  assert.equal(p.kind, CONTACT_KIND.person)
  assert.equal(p.count, 1)
  for (let i = 0; i < 100; i++) p.update(CONTACT_KIND.person, dt)
  assert.equal(p.value, 1, 'held while still inside')
  assert.equal(p.count, 1, 'one passage, one count')
  // Out: full for `hold`, then down over `release`.
  let out = 0
  while (p.value === 1 && out < 1) { p.update(CONTACT_KIND.none, dt); out += dt }
  assert.ok(near(out, CONTACT.hold, 2 * dt), `held ${out.toFixed(3)} s after leaving`)
  assert.equal(p.kind, CONTACT_KIND.person, 'the colour stays while it clears')
  let fall = 0
  while (p.value > 0 && fall < 2) { p.update(CONTACT_KIND.none, dt); fall += dt }
  assert.ok(near(fall, CONTACT.release, 2 * dt), `cleared in ${fall.toFixed(3)} s`)
  assert.equal(p.kind, CONTACT_KIND.none)
})

test('the pulse: a glancing touch still plays the whole wipe; a new passage counts again; bad intervals stall it', () => {
  const p = new ContactPulse()
  const dt = 1 / 60
  p.update(CONTACT_KIND.pole, dt)
  assert.ok(p.value > 0 && p.value < 1)
  let peak = p.value
  for (let i = 0; i < 120; i++) { p.update(CONTACT_KIND.none, dt); peak = Math.max(peak, p.value) }
  assert.equal(peak, 1, 'climbed to full cover after one frame of contact')
  assert.equal(p.value, 0, 'and cleared')
  p.update(CONTACT_KIND.vehicle, dt)
  assert.equal(p.count, 2)
  assert.equal(p.kind, CONTACT_KIND.vehicle)
  const v = p.value
  p.update(CONTACT_KIND.vehicle, Number.NaN)
  p.update(CONTACT_KIND.vehicle, -1)
  assert.equal(p.value, v, 'a broken interval moves nothing')
  p.update(CONTACT_KIND.vehicle, 10)
  assert.ok(p.value <= 1)
})

test('wiring: scanned before the upload, pulsed every animation frame; nothing of it reaches the frame as a whole', () => {
  const src = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8')
  const received = src.slice(src.indexOf('  private received('), src.indexOf('    for (const ev of s.events) {'))
  assert.ok(received.indexOf('this.contactScan(s)') > 0 && received.indexOf('this.contactScan(s)') < received.indexOf('this.crowd.upload('), 'the frame is read before it goes back to the worker')
  const frameFn = src.slice(src.indexOf('  frame(nowMs: number): void {'), src.indexOf('  /** One drawn frame'))
  assert.ok(frameFn.indexOf('this.contactPulse.update(this.contactNow(st), realDt / 1000)') > 0, 'every animation frame, on the wall clock')
  assert.ok(frameFn.indexOf('this.contactPulse.update(') < frameFn.indexOf('this.present('), 'before the drawn frame reads it')
  const present = src.slice(src.indexOf('  private present('), src.indexOf('  private contactScan('))
  assert.match(present, /const post = this\.quality\.live\.post\n/, 'the post chain runs on the quality tier alone: no passage turns it on')
  assert.ok(!present.includes('this.ghost.contact'), 'the pulse reaches no uniform of the composite')
  const ghost = readFileSync(new URL('./ghost.ts', import.meta.url), 'utf8')
  assert.match(ghost, /If\(g\.strength\.greaterThan\(0\), /, 'the composite runs on ghost view alone')
  for (const word of ['contact', 'wipe', 'iris']) assert.ok(!ghost.includes(word), `ghost.ts has no ${word}: no full-screen overlay for a passage`)
  const postfx = readFileSync(new URL('./postfx.ts', import.meta.url), 'utf8')
  assert.ok(!postfx.includes('contact'), 'the post chain takes no contact uniform')
})
