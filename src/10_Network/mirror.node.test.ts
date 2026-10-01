/**
 * Why does this file exist? It proves the headless Ring-0 mirror (mirror.node.ts) is the authority the room needs: that
 * an honest client's prediction (the page's own physics realm, SimCore, as the worker runs it) and the mirror's truth
 * agree within a micrometre for the same inputs (a 32-bit coordinate's last bit), through the seeded city's walls, at
 * every substep count a frame can bring;
 * and that every lie a client can tell about where it is (a speed hack, a velocity past a run, a wall walked through, a
 * car faster than the velocity cap or through a building, a door out of reach) is refused with the truth left exactly
 * as it was. It also pins the Ring-0 person audit, the spawns, a departure, and what a move costs.
 * What breaks if it is removed? The room could snap honest players for nothing, or keep a cheater's word, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY, CITY_SIZE, generateCity, inLot, streetFurniture } from '../01_Initialize_World/city.ts'
import { Ring0Auditor } from '../02_Define_The_Rules/ring0.ts'
import { SimCore } from '../07_Execute_Actions/simCore.ts'
import { footWish, POSE, RUN, type FootControls } from '../07_Execute_Actions/simProtocol.ts'
import { Mirror, MIRROR, personViolation, substeps, worldOf, type MirrorPose, type MoveInput } from './mirror.node.ts'

const SEED = 1337
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }
const C = CITY_SIZE / 2

let shared: Mirror | null = null
/** One mirror for the tests that only judge (building the city takes a few hundred milliseconds). */
async function mirror(): Promise<Mirror> {
  shared ??= await Mirror.create(SEED)
  return shared
}

/** A deterministic stream of numbers in [0, 1). */
function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32)
}

/**
 * The page's realm as an honest client runs it (the city of the seed, no traffic), put where the mirror spawned peer
 * `id` (the room's welcome is a teleport), and a step that also says what the client would send: the run of
 * substeps, and the claim.
 */
async function client(m: Mirror, id: number) {
  const start = m.join(id)
  const sim = await SimCore.create({ seed: SEED, cars: 0, agents: 256, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: m.spawnOf(id), debug: false }, null)
  const poses = new Float32Array(Math.max(1, sim.meta.count) * POSE.stride)
  let teleport: { x: number; z: number } | null = { x: start.x, z: start.z }
  const step = (dt: number, foot: FootControls): MoveInput & { n: number } => {
    const cmds = teleport ? [{ c: 'teleport', ...teleport }] : []
    teleport = null
    const st = sim.step({ dt, foot, drive: IDLE, cmds }, poses)
    const n = st.physics.steps
    return { mode: 'foot', segs: [[foot.x, foot.z, n]], heading: foot.heading, claim: { x: st.avatar.x, y: st.avatar.y, z: st.avatar.z }, n }
  }
  return { start, step, snap: (p: MirrorPose) => { teleport = { x: p.x, z: p.z } } }
}

const same = (a: MirrorPose, b: MirrorPose) => assert.deepEqual(a, b)

test('the mirror builds the page\'s city from the seed: its world name, one fixed body, a body per peer, gone on leave', async () => {
  const m = await Mirror.create(SEED)
  assert.equal(m.world, worldOf(SEED))
  assert.equal(m.world, 'city/1337')
  assert.equal(m.bodies, 1, 'the city is one fixed body')
  const p = m.join(1)
  m.join(2)
  assert.equal(m.bodies, 3)
  assert.equal(m.peers, 2)
  assert.throws(() => m.join(1), /already/)
  // Put down standing, the way the page is told to (a teleport).
  assert.ok(Math.abs(p.y - 0.95) < 1e-6, `y ${p.y}`)
  assert.equal(p.driving, false)
  m.leave(2)
  m.leave(2)
  assert.equal(m.bodies, 2)
  assert.throws(() => m.pose(2), /not in the mirror/)
})

test('spawns: the page\'s own spawn sidewalk, a step apart per peer, cycling, never inside a lot', async () => {
  const m = await mirror()
  assert.deepEqual(m.spawnOf(1), { x: C + CITY.lane, z: C + 12 })
  for (let id = 1; id <= 40; id++) {
    const s = m.spawnOf(id)
    assert.ok(!inLot(s.x, s.z), `peer ${id} at ${s.x}, ${s.z}`)
    assert.deepEqual(s, m.spawnOf(id + MIRROR.spawnSlots))
  }
  assert.equal(m.spawnOf(2).z - m.spawnOf(1).z, MIRROR.spawnGap)
})

test('prediction is the truth: the page\'s realm and the mirror agree within a micrometre, walls and every substep count included', async () => {
  const m = await Mirror.create(SEED)
  const c = await client(m, 1)
  const r = rng(7)
  // Frames of 1/144 s (often no substep) to 50 ms (three), a run, a walk and a stand, past a run (the clamp), and
  // headings that keep turning into the buildings beside the spawn sidewalk.
  const dts = [1 / 144, 1 / 60, 2 / 60, 0.05]
  let worst = 0, blocked = 0, substepsSeen = 0, zero = 0
  for (let k = 0; k < 700; k++) {
    const a = Math.floor(k / 50) * 1.3 + r() * 0.4
    const speed = [0, 2, RUN, 9][Math.floor(r() * 4)]
    const foot = { x: Math.sin(a) * speed, z: Math.cos(a) * speed, heading: a }
    const before = m.pose(1)
    const input = c.step(dts[Math.floor(r() * dts.length)], foot)
    const v = m.judge(1, input)
    assert.ok(v.ok, `step ${k}: ${v.ok ? '' : v.reason}`)
    const off = Math.hypot(v.pose.x - input.claim.x, v.pose.y - input.claim.y, v.pose.z - input.claim.z)
    worst = Math.max(worst, off)
    substepsSeen += input.n
    if (input.n === 0) zero++
    // A wall: the body went less than half as far as the clamped velocity asks.
    const w = footWish(foot.x, foot.z)
    const want = Math.hypot(w.x, w.z) * input.n * MIRROR.h
    if (want > 0.05 && Math.hypot(v.pose.x - before.x, v.pose.z - before.z) < want / 2) blocked++
  }
  // A world step lands a kinematic body on its next translation through a velocity, which can round the last bit of a
  // 32-bit coordinate the other way (one step of 6e-8 m at standing height); it never builds up.
  assert.ok(worst <= 1e-6, `the realm and the mirror differ by ${worst} m`)
  assert.ok(zero > 0 && substepsSeen > 700, `${zero} frames without a substep, ${substepsSeen} substeps`)
  assert.ok(blocked > 20, `walls met: ${blocked} frames`)
})

test('a claim off the truth is refused and the truth stays exactly as it was: a teleport, a speed hack, a wall walked through', async () => {
  const m = await Mirror.create(SEED)
  const c = await client(m, 1)
  // Warm up: the welcome's teleport, a few honest frames.
  for (let k = 0; k < 10; k++) assert.ok(m.judge(1, c.step(1 / 60, { x: 0, z: 1, heading: 0 })).ok)
  const honest = c.step(1 / 60, { x: 0, z: RUN, heading: 0 })
  const before = m.pose(1)
  // Memory written: the claim 40 m along.
  const teleport = m.judge(1, { ...honest, claim: { ...honest.claim, z: honest.claim.z + 40 } })
  assert.ok(!teleport.ok && /claim 40\.\d\d m from the mirror's pose/.test(teleport.reason), JSON.stringify(teleport))
  same(teleport.pose, before)
  same(m.pose(1), before)
  // Just past the tolerance.
  const nudge = m.judge(1, { ...honest, claim: { ...honest.claim, x: honest.claim.x + MIRROR.tolerance + 0.01 } })
  assert.ok(!nudge.ok)
  same(m.pose(1), before)
  // The honest frame after all that is still the truth: every refusal put the body back exactly.
  const kept = m.judge(1, honest)
  assert.ok(kept.ok)
  assert.ok(Math.hypot(kept.pose.x - honest.claim.x, kept.pose.y - honest.claim.y, kept.pose.z - honest.claim.z) <= 1e-6)

  // A speed hack: a client that moves at three runs and says so. The mirror clamps the velocity to a run (footWish).
  const fast = { x: 0, z: 3 * RUN, heading: 0 }
  const at = m.pose(1)
  const hacked: MoveInput = { mode: 'foot', segs: [[fast.x, fast.z, 4]], heading: 0, claim: { x: at.x, y: at.y, z: at.z + 3 * RUN * 4 * MIRROR.h } }
  const sped = m.judge(1, hacked)
  assert.ok(!sped.ok, 'three runs refused')
  same(m.pose(1), at)

  // A wall: east of the spawn sidewalk is a building lot. Walk into it for two seconds, claiming the straight line.
  const m2 = await Mirror.create(SEED)
  const c2 = await client(m2, 1)
  const start = m2.pose(1)
  let claimed = { x: start.x, y: start.y, z: start.z }
  let refused = 0
  for (let k = 0; k < 120; k++) {
    const honestStep = c2.step(1 / 60, { x: RUN, z: 0, heading: Math.PI / 2 })
    claimed = { x: claimed.x + RUN * honestStep.n * MIRROR.h, y: claimed.y, z: claimed.z }
    const v = m2.judge(1, { ...honestStep, claim: claimed })
    if (!v.ok) {
      refused++
      // The room snaps the client: both take the next step from the truth.
      c2.snap(m2.settle(1))
      claimed = { x: m2.pose(1).x, y: m2.pose(1).y, z: m2.pose(1).z }
    }
  }
  const end = m2.pose(1)
  assert.ok(refused > 0, 'walking through the wall was refused')
  assert.ok(end.x < start.x + 2, `the truth stopped at the wall: x ${start.x.toFixed(2)} → ${end.x.toFixed(2)}`)
  assert.ok(inLot(start.x + 3, start.z), 'there is a lot to walk into')
})

test('after a snap the client and the mirror take the same next steps: both put down at the truth, standing', async () => {
  const m = await Mirror.create(SEED)
  const c = await client(m, 1)
  for (let k = 0; k < 30; k++) assert.ok(m.judge(1, c.step(1 / 60, { x: 1, z: RUN, heading: 0 })).ok)
  // The client lies once; the room refuses it and snaps it to the truth.
  const lie = c.step(1 / 60, { x: 1, z: RUN, heading: 0 })
  assert.ok(!m.judge(1, { ...lie, claim: { ...lie.claim, z: lie.claim.z + 5 } }).ok)
  c.snap(m.settle(1))
  // From here every honest frame is the truth again, to the bit.
  for (let k = 0; k < 120; k++) {
    const input = c.step(k % 3 === 0 ? 0.05 : 1 / 60, { x: Math.sin(k / 20) * RUN, z: Math.cos(k / 20) * RUN, heading: 0 })
    const v = m.judge(1, input)
    const off = Math.hypot(v.pose.x - input.claim.x, v.pose.y - input.claim.y, v.pose.z - input.claim.z)
    assert.ok(v.ok && off <= 1e-6, `frame ${k} after the snap: ${v.ok ? `${off} m` : v.reason}`)
  }
})

test('at the wheel the mirror bounds the claim: the velocity cap, the buildings, the door, the exit point', async () => {
  const m = await Mirror.create(SEED)
  const s = m.join(1)
  const drive = (x: number, y: number, z: number, n: number): MoveInput => ({ mode: 'drive', segs: [[0, 0, n]], heading: 0, claim: { x, y, z } })
  // Into a car parked in the street beside the sidewalk (the chassis 3 m off, within reach).
  const car = { x: s.x - 3, y: 0.7, z: s.z }
  const into = m.judge(1, drive(car.x, car.y, car.z, 1))
  assert.ok(into.ok && into.pose.driving, JSON.stringify(into))
  // Out of reach of the door: refused.
  const m2 = await Mirror.create(SEED)
  m2.join(1)
  assert.ok(!m2.judge(1, drive(s.x - 20, 0.7, s.z, 1)).ok, 'a car 20 m away is not the one the player stepped into')
  // Along the street, beside the lot: 10 m in 30 substeps is well inside the cap (50 m/s: 25 m and the slack); 30 m is not.
  assert.ok(m.judge(1, drive(car.x, car.y, car.z + 10, 30)).ok)
  const at = m.pose(1)
  const fast = m.judge(1, drive(car.x, car.y, car.z + 10 + 30, 30))
  assert.ok(!fast.ok && /cannot cover 30\.0 m in 30 substeps/.test(fast.reason), JSON.stringify(fast))
  same(m.pose(1), at)
  // Through the lot east of the street (a podium fills it from x 327 m): refused, whatever the speed allows.
  const through = m.judge(1, drive(at.x + 24, at.y, at.z, 30))
  assert.ok(!through.ok && /through a building/.test(through.reason), JSON.stringify(through))
  assert.ok(!m.judge(1, drive(at.x, -3, at.z, 1)).ok, 'under the ground floor')
  // On foot again: only with an exit point, within reach of the car, standing clear of the buildings.
  const walk = (from?: { x: number; z: number }): MoveInput => ({ mode: 'foot', segs: [[0, 0, 1]], heading: 0, claim: { x: 0, y: 0, z: 0 }, ...(from && { from }) })
  assert.match((m.judge(1, walk()) as { reason: string }).reason, /without leaving the car/)
  assert.match((m.judge(1, walk({ x: at.x + 30, z: at.z })) as { reason: string }).reason, /out of reach/)
  // A point inside the lot beside the street (a building stands there).
  let inside: { x: number; z: number } | null = null
  for (let dx = 1; dx < MIRROR.reach && !inside; dx += 0.5) {
    const p = { x: at.x + dx, z: at.z }
    if (inLot(p.x, p.z, -2)) inside = p
  }
  assert.ok(inside, 'a lot within reach')
  const blocked = m.judge(1, walk(inside))
  assert.ok(!blocked.ok && /exit point (inside|through) a building/.test(blocked.reason), JSON.stringify(blocked))
  // The kerb beside the car: kept, and the walk replayed from there.
  const kerb = { x: at.x + 2, z: at.z }
  const out = m.judge(1, { mode: 'foot', segs: [[0, 0, 1]], heading: 0, claim: { x: kerb.x, y: 0.95, z: kerb.z }, from: kerb })
  assert.ok(out.ok && !out.pose.driving, JSON.stringify(out))
  assert.ok(Math.abs(out.pose.x - kerb.x) < 1e-6 && Math.abs(out.pose.z - kerb.z) < 1e-6)
  assert.match((m.judge(1, walk(kerb)) as { reason: string }).reason, /exit point without a car/)
})

test('the Ring-0 person audit on every pose the mirror keeps: finite, inside the slab, above the ground floor', () => {
  const a = new Ring0Auditor({ x: C, z: C })
  assert.equal(personViolation(a, 1, C, 0.95, C), null)
  assert.match(personViolation(a, 1, Number.NaN, 0.95, C) ?? '', /person 1/)
  assert.match(personViolation(a, 2, C + 1601, 0.95, C) ?? '', /^OOB Exploit: person 2 breached the 1600m containment slab/)
  assert.match(personViolation(a, 3, C, -0.6, C) ?? '', /OOB Exploit: person 3/)
  assert.equal(personViolation(a, 4, C - 1599, 0.95, C + 1599), null)
})

test('substeps and the world name are what the room reads; a move costs microseconds, not a world step', async () => {
  assert.equal(substeps([[0, 0, 2], [1, 1, 3]]), 5)
  assert.equal(worldOf(-1), 'city/4294967295')
  const m = await mirror()
  m.join(99)
  const before = m.counts.substeps
  const t0 = performance.now()
  let kept = 0
  for (let k = 0; k < 2000; k++) {
    const p = m.pose(99)
    const v = m.judge(99, { mode: 'foot', segs: [[0, 0, 1]], heading: 0, claim: { x: p.x, y: p.y, z: p.z } })
    if (v.ok) kept++
  }
  const us = ((performance.now() - t0) / 2000) * 1000
  assert.ok(kept >= 1990, `standing still is kept (${kept})`)
  assert.equal(m.counts.substeps - before, 2000)
  assert.ok(us < 1000, `${us.toFixed(1)} µs a judged substep`)
  m.leave(99)
})
