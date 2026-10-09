// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the proof of invariant parity under sustained adversarial load (Phase 13): the server
 * realm (the real host, replication.node.ts, its headless Ring-0 mirror and garage) and the client realms (two pages,
 * each the code the physics worker runs: the city of the seed, 36 cars on the track network, player 1 in a network
 * room, reported through the real network client exactly as engine.ts reports) never diverge by more than a
 * micrometre. The room keeps a claim only within a micrometre of its own replay (MIRROR.tolerance), so an honest page
 * that is never corrected agreed to that bound on every step it sent; and the last pose of each agrees to the bit.
 * The load is adversarial on every axis the directive names: the network jitters both ways (in order, as TCP is, from
 * a few milliseconds to latency spikes of a second and a half and stalls of 2.5 s that deliver everything at once);
 * frames run 0 to 3 substeps; the drivers take doors in and out of cars, floor the throttle, haul the handbrake and
 * crash into buildings, both at once; and a third player in the same room lies all the while (claims written into its
 * report, a micrometre and a half off and ten metres off, doors to cars it is nowhere near), each lie corrected, none
 * touching the honest two. The host runs on an injected clock advanced with the pages' own time, seeded throughout.
 * What breaks if it is removed? The micrometre is proved only on calm networks and polite drivers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateCity, streetFurniture } from '../01_Initialize_World/city.ts'
import { gen, type Gen } from '../02_Define_The_Rules/property.ts'
import { SimCore } from '../07_Execute_Actions/simCore.ts'
import { doorOf, ENTER_RANGE, footWish, POSE, RUN, type DriveControls, type SimCommand, type StepState } from '../07_Execute_Actions/simProtocol.ts'
import { Mirror } from './mirror.node.ts'
import { createNetClient, type Move, type NetClient, type NetSocket } from './netClient.ts'
import { startHost } from './replication.node.ts'

const SEED = 1337
const CARS = 36
const IDLE: DriveControls = { steer: 0, fwd: 0, back: 0, handbrake: false }
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let t = 0; t < ms; t += 5) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

/**
 * A chaotic link: every frame either way is held for a latency drawn from `g` (in order: it never overtakes the one
 * before it, as on TCP), now and then a spike, at most once a minute a stall that releases everything at once; the
 * clock is the test's. `flush` delivers what is due.
 */
function chaos(g: Gen, clock: { now: number }) {
  const links: ((now: number) => void)[] = []
  let stalls = 0, spikes = 0
  let lastStall = -Infinity
  const latency = (): number => {
    const now = clock.now
    if (now - lastStall >= 60_000 && g.bool(0.0015)) {
      lastStall = now
      stalls++
      return g.float(1000, 2500)
    }
    if (g.bool(0.01)) {
      spikes++
      return g.float(300, 1500)
    }
    return g.float(2, 80)
  }
  const open = (url: string, protocols: string[]): NetSocket => {
    const ws = new WebSocket(url, protocols)
    const up: { at: number; data: string }[] = [], down: { at: number; data: unknown }[] = []
    let upDue = 0, downDue = 0
    const fake: NetSocket = {
      send(data) { up.push({ at: (upDue = Math.max(upDue, clock.now + latency())), data }) },
      close(code, reason) { ws.close(code, reason) },
      onopen: null, onmessage: null, onclose: null, onerror: null,
    }
    ws.onopen = (ev) => fake.onopen?.(ev)
    ws.onmessage = (ev) => { down.push({ at: (downDue = Math.max(downDue, clock.now + latency())), data: ev.data }) }
    ws.onclose = (ev) => fake.onclose?.({ code: ev.code, reason: ev.reason })
    ws.onerror = (ev) => fake.onerror?.(ev)
    links.push((now) => {
      while (up.length > 0 && up[0].at <= now && ws.readyState === WebSocket.OPEN) ws.send(up.shift()!.data)
      while (down.length > 0 && down[0].at <= now) fake.onmessage?.({ data: down.shift()!.data })
    })
    return fake
  }
  return { open, flush: (now: number) => { for (const l of links) l(now) }, get stalls() { return stalls }, get spikes() { return spikes } }
}

/** A page as engine.ts runs it (see authority.node.test.ts), over the chaotic link, with a driver of random temper. */
async function page(url: string, token: string, name: string, clock: { now: number }, open: (url: string, p: string[]) => NetSocket, g: Gen) {
  const sim = await SimCore.create({ seed: SEED, cars: CARS, agents: 256, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: 500, z: 500 }, debug: false, tracks: true }, null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const client: NetClient = createNetClient({ now: () => clock.now, open, every: () => () => {} })
  let fix = 0
  let shift = 0
  let room = false
  const queued: SimCommand[] = []
  let st: StepState | null = null
  let reported: Move | null = null
  let doors = 0, crashes = 0, driven = 0, speedWas = 0
  const frame = (dt: number, foot: { x: number; z: number }, drive: DriveControls, cmds: SimCommand[] = []): void => {
    if (client.status === 'joined') {
      if (!room) { queued.push({ c: 'room', on: true }); room = true }
      const c = client.correction()
      if (c && c.fix > fix) {
        fix = c.fix
        queued.push(c.car ? { c: 'netCar', i: c.car.index, state: c.car.state } : { c: 'teleport', x: c.x, z: c.z, y: c.y })
      }
      const d = client.drift()
      if (d) {
        shift = d.epoch
        queued.push({ c: 'shift', dx: d.x, dy: d.y, dz: d.z })
      }
    }
    const w = footWish(foot.x, foot.z)
    const sentFix = fix, sentShift = shift
    const s = { ...sim.step({ dt, foot: { ...foot, heading: 0 }, drive, cmds: [...queued.splice(0), ...cmds] }, poses), t: 'state' as const, id: 0 }
    st = s
    const door = doorOf(s.events)
    if (door) doors++
    let m: Move
    if (s.driving >= 0) {
      const o = s.driving * POSE.stride
      m = { mode: 'drive', x: 0, z: 0, ...(s.wheels && { wheels: s.wheels }), n: s.physics.steps, heading: poses[o + POSE.heading], at: { x: poses[o + POSE.x], y: poses[o + POSE.y], z: poses[o + POSE.z] }, fix: sentFix, shift: sentShift }
      // A crash: the car shed more than 5 m/s in one frame with the brakes off.
      const speed = Math.abs(poses[o + POSE.speed])
      if (speedWas - speed > 5 && s.wheels && s.wheels.brake === 0 && !s.wheels.handbrake) crashes++
      speedWas = speed
      driven += s.physics.steps
    } else {
      m = { mode: 'foot', x: w.x, z: w.z, n: s.physics.steps, heading: 0, at: { x: s.avatar.x, y: s.avatar.y, z: s.avatar.z }, fix: sentFix, shift: sentShift }
      speedWas = 0
    }
    if (door) m = { ...m, door }
    if (client.status === 'joined') {
      client.move(m)
      reported = m
    }
  }
  const nearest = () => {
    const a = st!.avatar
    let best = { x: 0, z: 0, d: Infinity }
    for (let i = 0; i < CARS; i++) {
      const x = poses[i * POSE.stride + POSE.x], z = poses[i * POSE.stride + POSE.z]
      const d = Math.hypot(x - a.x, z - a.z)
      if (d < best.d) best = { x, z, d }
    }
    return best
  }
  // The driver: chase a car, take it, drive it hard for a few seconds (full throttle, a weave, the handbrake, now and
  // then reverse), leave it, and again.
  let phase: 'chase' | 'drive' = 'chase'
  let left = 0
  let steer = 0
  const act = (dt: number): void => {
    if (st === null || client.status !== 'joined') { frame(dt, { x: 0, z: 0 }, IDLE); return }
    if (phase === 'chase') {
      const car = nearest()
      if (car.d < ENTER_RANGE - 0.4) {
        frame(dt, { x: 0, z: 0 }, IDLE, [{ c: 'interact' }])
        if (st.driving >= 0) { phase = 'drive'; left = g.float(2, 8) }
        return
      }
      const a = st.avatar
      // Past a run on purpose now and then: the realm and the room clamp it alike.
      const pace = g.bool(0.1) ? RUN * 1.6 : RUN
      frame(dt, { x: ((car.x - a.x) / car.d) * pace, z: ((car.z - a.z) / car.d) * pace }, IDLE)
      return
    }
    left -= dt
    if (left <= 0) {
      frame(dt, { x: 0, z: 0 }, IDLE, [{ c: 'interact' }])
      if (st.driving < 0) phase = 'chase'
      return
    }
    if (g.bool(0.05)) steer = g.float(-1, 1)
    const back = g.bool(0.03) ? g.float(0, 1) : 0
    frame(dt, { x: 0, z: 0 }, { steer, fwd: back > 0 ? 0 : g.float(0.6, 1), back, handbrake: g.bool(0.04) })
  }
  assert.equal(client.connect(url, token, name, `city/${SEED}/${CARS}`), null)
  return {
    client, act,
    get reported() { return reported },
    get counts() { return { doors, crashes, driven } },
  }
}

test('parity under sustained adversarial load: two drivers on a chaotic network, never a micrometre apart from the room; a liar beside them corrected every time', { timeout: 600_000 }, async () => {
  const g = gen(0x5eed13)
  const clock = { now: Date.now() }
  const link = chaos(gen(g.int(0, 2 ** 31)), clock)
  const host = await startHost({ secret: 'parity-secret-sixteen+', tickHz: 20, now: () => clock.now })
  try {
    const ada = await page(host.url, host.token('ada'), 'Ada', clock, link.open, gen(g.int(0, 2 ** 31)))
    const bob = await page(host.url, host.token('bob'), 'Bob', clock, link.open, gen(g.int(0, 2 ** 31)))
    // The liar: an honest walker's prediction (the mirror's own controller), and a lie every few seconds.
    const eveToken = host.token('eve')
    const eve = createNetClient({ now: () => clock.now, open: link.open, every: () => () => {} })
    assert.equal(eve.connect(host.url, eveToken, 'Eve', `city/${SEED}/${CARS}`), null)
    const predictor = await Mirror.create(SEED, CARS)
    // The welcome comes through the link too: the clock runs and the link flushes while it does.
    for (let k = 0; k < 2000 && ![ada.client, bob.client, eve].every((c) => c.status === 'joined'); k++) {
      clock.now += 20
      link.flush(clock.now)
      await new Promise((r) => setTimeout(r, 1))
    }
    assert.ok([ada.client, bob.client, eve].every((c) => c.status === 'joined'), 'all three welcomed')
    predictor.join(eve.id)
    let eveFix = 0, lies = 0, drifts = 0, nextLie = 4
    const eg = gen(g.int(0, 2 ** 31))
    const seat = predictor.garage.plan[3].pose
    const eveFrame = (n: number, t: number): void => {
      const c = eve.correction()
      if (c && c.fix > eveFix) {
        eveFix = c.fix
        predictor.place(eve.id, c.x, c.z, c.y)
      }
      const v = { x: eg.float(-RUN, RUN), z: eg.float(-RUN, RUN) }
      const at = predictor.walk(eve.id, [[v.x, v.z, n]])
      let m: Move = { mode: 'foot', x: v.x, z: v.z, n, heading: 0, at: { x: at.x, y: at.y, z: at.z }, fix: eveFix }
      if (t >= nextLie) {
        nextLie = t + eg.float(6, 9)
        // In turn: a drift, a lie on foot, a door to a car it is nowhere near.
        const kind = (lies + drifts) % 3
        // A micrometre and a half off is within the room's drift bound: kept as replayed and put back, not counted.
        if (kind === 0) drifts++
        else lies++
        if (kind === 0) m = { ...m, n: Math.max(1, n), at: { ...m.at, x: m.at.x + 1.5e-6 } }
        else if (kind === 1) m = { ...m, n: Math.max(1, n), at: { ...m.at, z: m.at.z + 10 } }
        else {
          const yaw = seat.heading - Math.PI / 2
          const state = { x: Math.fround(seat.x), y: Math.fround(0.56), z: Math.fround(seat.z), qx: 0, qy: Math.fround(Math.sin(yaw / 2)), qz: 0, qw: Math.fround(Math.cos(yaw / 2)), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
          m = { mode: 'drive', x: 0, z: 0, wheels: { throttle: 1, brake: 0, steer: 0, handbrake: false }, n: 1, heading: 0, at: { x: state.x, y: state.y, z: state.z }, fix: eveFix, door: { enter: { car: 3, state } } }
        }
      }
      eve.move(m)
    }
    // A minute and a half of the city: frames of 0 to 3 substeps, every frame through the chaotic link.
    let t = 0
    const dts = [1 / 144, 1 / 60, 1 / 60, 1 / 30, 0.05]
    while (t < 90) {
      const dt = g.pick(dts)
      t += dt
      clock.now += dt * 1000
      ada.act(dt)
      bob.act(dt)
      // Eve's realm runs the same substeps a frame would.
      eveFrame(dt >= 0.05 ? 3 : dt >= 1 / 30 ? 2 : dt >= 1 / 60 ? 1 : 0, t)
      link.flush(clock.now)
      await yieldNow()
    }
    // Let the link drain: no frames, the clock on, until every page's last step has reached the room and it agrees.
    for (let k = 0; k < 400; k++) {
      clock.now += 20
      link.flush(clock.now)
      await new Promise((r) => setTimeout(r, 1))
    }
    const truthOf = (c: NetClient) => host.room.peers.get(c.id)!
    await until(() => [ada, bob].every((p) => { const tr = truthOf(p.client), r = p.reported!; return tr.x === r.at.x && tr.y === r.at.y && tr.z === r.at.z }), 'the room holds where each page is, to the bit')
    const a = ada.counts, b = bob.counts
    assert.equal(ada.client.corrections, 0, `Ada corrected: ${ada.client.corrected}`)
    assert.equal(bob.client.corrections, 0, `Bob corrected: ${bob.client.corrected}`)
    assert.ok(a.doors >= 2 && b.doors >= 2, `doors taken: Ada ${a.doors}, Bob ${b.doors}`)
    assert.ok(a.driven > 600 && b.driven > 600, `substeps at the wheel: Ada ${a.driven}, Bob ${b.driven}`)
    assert.ok(a.crashes + b.crashes >= 1, `crashes: Ada ${a.crashes}, Bob ${b.crashes}`)
    assert.ok(link.stalls >= 1 && link.spikes >= 10, `${link.stalls} stalls, ${link.spikes} spikes`)
    // The liar: every lie corrected, every drift put back uncounted, still in the room (under the corrections' own
    // limit), the honest two untouched.
    await until(() => eve.corrections === lies, `Eve's ${lies} lies corrected (${eve.corrections})`)
    assert.ok(lies >= 6 && drifts >= 3, `${lies} lies, ${drifts} drifts`)
    assert.equal(eve.status, 'joined')
    const st = host.stats()
    assert.equal(st.corrected, lies, 'every correction the room made was for a lie')
    assert.equal(st.resynced, drifts, 'every page put back was Eve\'s drift: the honest two never drifted')
    assert.ok(st.kept > 5000, `${st.kept} steps kept, each within a micrometre of the room's replay`)
    console.log(`parity: ${st.kept} steps kept, ${st.corrected} corrections (all lies), ${st.resynced} put back (Eve's drifts), ${link.stalls} stalls, ${link.spikes} latency spikes; Ada ${a.doors} doors, ${a.driven} substeps at the wheel, ${a.crashes} crashes; Bob ${b.doors} doors, ${b.driven} substeps, ${b.crashes} crashes`)
    for (const c of [ada.client, bob.client, eve]) c.leave()
  } finally {
    await host.close()
  }
})
