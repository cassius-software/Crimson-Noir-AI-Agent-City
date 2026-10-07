/**
 * Why does this file exist? It proves client-side prediction with snap reconciliation end to end, the way the page runs
 * it: the page's own physics realm (SimCore, the code the worker runs: the city of the seed, its fleet of 36 cars on
 * the track network, player 1 in a network room) is the prediction, the page's network client (netClient.ts over
 * Node's WebSocket) reports each realm step exactly as engine.ts does (the door the step took, read by simProtocol.ts
 * doorOf; the walking velocity as the realm clamps it, or the wheel command the car ran; the substeps; the pose; the
 * correction carried out), and the real host (replication.node.ts) judges every step on its headless Ring-0 mirror and
 * its garage. Two players each walk to a car through the city, take its wheel, drive at the same time and leave it,
 * and neither is ever corrected: the room keeps a claim only within a micrometre of its own replay, so every one of
 * thousands of steps agreed to that bound, and the last pose of each agrees to the bit. A position written into the
 * page's realm (a teleport the room never made) and a chassis claim written into the page's report are each refused
 * the moment they arrive; the page, snapped to the truth (on foot one teleport, at the wheel its car rebuilt in the
 * room's state), goes on honest with the room. The other player sees the truth, never the lie. The host runs on an
 * injected clock advanced with the pages' own time, so a minute of the city takes seconds and every rate still holds.
 * What breaks if it is removed? The engine's report of a step, a door or a correction could drift from what the room
 * replays, and every honest driver would be snapped for nothing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateCity, streetFurniture } from '../01_Initialize_World/city.ts'
import { SimCore } from '../07_Execute_Actions/simCore.ts'
import { doorOf, ENTER_RANGE, footWish, POSE, RUN, type DriveControls, type SimCommand, type StepState } from '../07_Execute_Actions/simProtocol.ts'
import { createNetClient, type Move, type NetClient } from './netClient.ts'
import { startHost } from './replication.node.ts'

const SEED = 1337
const CARS = 36
const IDLE: DriveControls = { steer: 0, fwd: 0, back: 0, handbrake: false }
const H = 1 / 60
const yieldNow = (): Promise<void> => new Promise((r) => setImmediate(r))

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  for (let t = 0; t < ms; t += 5) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

/**
 * The page: its realm, its client, and engine.ts's bookkeeping in miniature (netFrame, netSent, netMoveOf): once
 * welcomed, the room mode and then each new correction ride the next request (at the wheel the car in the room's
 * state, on foot a teleport), and the state that answers is reported as the room's move. `lie` shifts the reported
 * pose (a claim written into the report, not the realm).
 */
async function page(url: string, token: string, name: string, clock: { now: number }) {
  const sim = await SimCore.create({ seed: SEED, cars: CARS, agents: 256, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: 500, z: 500 }, debug: false, tracks: true }, null)
  const poses = new Float32Array(sim.meta.count * POSE.stride)
  const client: NetClient = createNetClient({ now: () => clock.now, every: () => () => {} })
  let fix = 0
  let room = false
  const queued: SimCommand[] = []
  let st: StepState | null = null
  let reported: Move | null = null
  const frame = (o: { foot?: { x: number; z: number }; drive?: DriveControls; cmds?: SimCommand[]; lie?: number } = {}): void => {
    if (client.status === 'joined') {
      if (!room) {
        queued.push({ c: 'room', on: true })
        room = true
      }
      const c = client.correction()
      if (c && c.fix > fix) {
        fix = c.fix
        queued.push(c.car ? { c: 'netCar', i: c.car.index, state: c.car.state } : { c: 'teleport', x: c.x, z: c.z })
      }
    }
    const foot = o.foot ?? { x: 0, z: 0 }
    const w = footWish(foot.x, foot.z)
    const sent = { x: w.x, z: w.z, fix }
    const s = { ...sim.step({ dt: H, foot: { ...foot, heading: 0 }, drive: o.drive ?? IDLE, cmds: [...queued.splice(0), ...(o.cmds ?? [])] }, poses), t: 'state' as const, id: 0 }
    st = s
    const door = doorOf(s.events)
    let m: Move
    if (s.driving >= 0) {
      const at = { x: poses[s.driving * POSE.stride + POSE.x], y: poses[s.driving * POSE.stride + POSE.y], z: poses[s.driving * POSE.stride + POSE.z] }
      m = { mode: 'drive', x: 0, z: 0, ...(s.wheels && { wheels: s.wheels }), n: s.physics.steps, heading: poses[s.driving * POSE.stride + POSE.heading], at, fix: sent.fix }
    } else {
      m = { mode: 'foot', x: sent.x, z: sent.z, n: s.physics.steps, heading: 0, at: { x: s.avatar.x, y: s.avatar.y, z: s.avatar.z }, fix: sent.fix }
    }
    if (door) m = { ...m, door }
    if (o.lie) m = { ...m, at: { ...m.at, x: m.at.x + o.lie } }
    if (client.status === 'joined') {
      client.move(m)
      reported = m
    }
  }
  /** The nearest car's chassis in this page's realm. */
  const nearest = (): { i: number; x: number; z: number; d: number } => {
    const a = st!.avatar
    let best = { i: -1, x: 0, z: 0, d: Infinity }
    for (let i = 0; i < CARS; i++) {
      const x = poses[i * POSE.stride + POSE.x], z = poses[i * POSE.stride + POSE.z]
      const d = Math.hypot(x - a.x, z - a.z)
      if (d < best.d) best = { i, x, z, d }
    }
    return best
  }
  assert.equal(client.connect(url, token, name, `city/${SEED}/${CARS}`), null)
  return {
    client, frame, nearest,
    get st() { return st! },
    get reported() { return reported },
    /** Where this page has its player 1 now: the capsule, or the chassis at the wheel. */
    get at() {
      const s = st!
      return s.driving >= 0 ? { x: poses[s.driving * POSE.stride + POSE.x], y: poses[s.driving * POSE.stride + POSE.y], z: poses[s.driving * POSE.stride + POSE.z] } : s.avatar
    },
  }
}

type Page = Awaited<ReturnType<typeof page>>

/**
 * One player's errand: chase the nearest car on foot until one is within the door, take its wheel, drive for
 * `driveFrames` (a steady throttle, a slow weave), leave it, and stand. Advanced one frame at a time.
 */
function errand(p: Page, driveFrames: number, weave: number) {
  let phase: 'chase' | 'drive' | 'out' | 'stand' = 'chase'
  let driven = 0
  return {
    get phase() { return phase },
    frame(): void {
      if (phase === 'chase') {
        const car = p.nearest()
        if (car.d < ENTER_RANGE - 0.4) {
          p.frame({ cmds: [{ c: 'interact' }] })
          if (p.st.driving >= 0) phase = 'drive'
          return
        }
        const a = p.st.avatar
        p.frame({ foot: { x: ((car.x - a.x) / car.d) * RUN, z: ((car.z - a.z) / car.d) * RUN } })
      } else if (phase === 'drive') {
        p.frame({ drive: { steer: Math.sin(driven / 40) * weave, fwd: 0.7, back: 0, handbrake: false } })
        if (++driven >= driveFrames) phase = 'out'
      } else if (phase === 'out') {
        p.frame({ drive: { steer: 0, fwd: 0, back: 0, handbrake: false }, cmds: [{ c: 'interact' }] })
        if (p.st.driving < 0) phase = 'stand'
      } else {
        p.frame()
      }
    },
  }
}

test('prediction and snap reconciliation end to end: two players walk to cars, drive at once and leave them, never corrected; lies on foot and at the wheel are refused at once and snapped back', async () => {
  const clock = { now: Date.now() }
  const host = await startHost({ secret: 'authority-secret-of-sixteen', tickHz: 20, now: () => clock.now })
  try {
    assert.equal(host.world, `city/${SEED}/${CARS}`)
    const ada = await page(host.url, host.token('ada'), 'Ada', clock)
    const bob = await page(host.url, host.token('bob'), 'Bob', clock)
    await until(() => ada.client.status === 'joined' && bob.client.status === 'joined', 'both welcomed')
    const truthOf = (p: Page) => host.room.peers.get(p.client.id)!
    const tick = async (n: number, each: () => void): Promise<void> => {
      for (let k = 0; k < n; k++) {
        clock.now += H * 1000
        each()
        await yieldNow()
      }
    }
    // The welcome: the room mode and the spawn's teleport ride the first request.
    await tick(5, () => { ada.frame(); bob.frame() })
    // Ada and Bob each run their errand in their own city: the chase, a door, ten seconds at the wheel, out.
    const a = errand(ada, 600, 0.3), b = errand(bob, 600, -0.25)
    let bothDriving = 0
    for (let k = 0; k < 60 * 120 && (a.phase !== 'stand' || b.phase !== 'stand'); k++) {
      await tick(1, () => { a.frame(); b.frame() })
      if (a.phase === 'drive' && b.phase === 'drive') bothDriving++
    }
    assert.equal(a.phase, 'stand', 'Ada drove and left her car')
    assert.equal(b.phase, 'stand', 'Bob drove and left his car')
    assert.ok(bothDriving > 60, `both at a wheel at once for ${bothDriving} frames`)
    await tick(30, () => { ada.frame(); bob.frame() })
    await until(() => [ada, bob].every((p) => { const t = truthOf(p), r = p.reported!; return t.x === r.at.x && t.y === r.at.y && t.z === r.at.z }), 'the room holds where each page is, to the bit')
    assert.equal(ada.client.corrections, 0, `Ada honest: ${ada.client.corrected}`)
    assert.equal(bob.client.corrections, 0, `Bob honest: ${bob.client.corrected}`)
    const kept = host.stats().kept
    assert.ok(kept > 2000, `${kept} steps kept, each within a micrometre of the room's replay`)
    assert.equal(host.stats().corrected, 0)

    // Memory manipulation on foot: the page's own realm is told to put Ada 30 m along, a teleport the room never made.
    const honest = { x: truthOf(ada).x, z: truthOf(ada).z }
    await tick(1, () => { ada.frame({ cmds: [{ c: 'teleport', x: honest.x, z: honest.z + 30 }] }); bob.frame() })
    await until(() => ada.client.corrections === 1, 'the correction')
    assert.match(ada.client.corrected ?? '', /claim .* from the mirror's pose/)
    assert.deepEqual([truthOf(ada).x, truthOf(ada).z], [honest.x, honest.z], 'the room never moved her')
    // Bob, in the same room, sees Ada where the room has her, never where she claimed to be.
    await until(() => bob.client.poses().some((p) => p.id === ada.client.id), 'Bob sees Ada')
    const seen = bob.client.poses().find((p) => p.id === ada.client.id)!
    assert.ok(Math.abs(seen.z - honest.z) < 0.5, `Bob sees Ada at z ${seen.z.toFixed(2)}, the truth ${honest.z.toFixed(2)}`)
    // Snapped by one teleport, she walks on honest.
    await tick(60, () => { ada.frame({ foot: { x: 0.5, z: 0.5 } }); bob.frame() })
    await until(() => { const t = truthOf(ada), r = ada.reported!; return t.x === r.at.x && t.z === r.at.z }, 'the room and Ada agree again, to the bit')
    assert.equal(ada.client.corrections, 1)

    // A chassis claim written into the report at the wheel: the room keeps its replay, corrects with the car's state,
    // and the page, its car rebuilt in exactly that state, drives on honest.
    const c = errand(ada, 120, 0.2)
    for (let k = 0; k < 60 * 120 && c.phase === 'chase'; k++) await tick(1, () => { c.frame(); bob.frame() })
    assert.equal(c.phase, 'drive')
    await tick(30, () => { c.frame(); bob.frame() })
    // A centimetre off is within the room's drift bound: kept as the room replayed it, the page put back (drift),
    // nothing counted.
    const fixed = ada.client.correction()!.fix
    await tick(1, () => { ada.frame({ drive: { steer: 0, fwd: 0.7, back: 0, handbrake: false }, lie: 0.01 }); bob.frame() })
    await until(() => ada.client.correction()!.fix > fixed, 'put back at the wheel')
    assert.deepEqual([ada.client.correction()!.drift, ada.client.correction()!.reason], [true, "chassis claim 0.01 m from the room's car"])
    assert.ok(ada.client.correction()?.car, 'it carries the car')
    assert.equal(ada.client.corrections, 1, 'a drift is not counted')
    await tick(60, () => { ada.frame({ drive: { steer: 0.1, fwd: 0.6, back: 0, handbrake: false } }); bob.frame() })
    // Two metres off is a lie: corrected and counted.
    await tick(1, () => { ada.frame({ drive: { steer: 0, fwd: 0.7, back: 0, handbrake: false }, lie: 2 }); bob.frame() })
    await until(() => ada.client.corrections === 2, 'the correction at the wheel')
    assert.match(ada.client.corrected ?? '', /chassis claim 2\.\d\d m from the room's car/)
    assert.ok(ada.client.correction()?.car, 'it carries the car')
    await tick(120, () => { ada.frame({ drive: { steer: 0.1, fwd: 0.6, back: 0, handbrake: false } }); bob.frame() })
    await until(() => { const t = truthOf(ada), r = ada.reported!; return t.driving && t.x === r.at.x && t.y === r.at.y && t.z === r.at.z }, 'the room and Ada\'s car agree again, to the bit')
    assert.equal(ada.client.corrections, 2, `no correction after the snap: ${ada.client.corrected}`)
    assert.equal(bob.client.corrections, 0)
    assert.equal(host.stats().corrected, 2)
    assert.equal(host.stats().resynced, 1)
    ada.client.leave()
    bob.client.leave()
  } finally {
    await host.close()
  }
})
