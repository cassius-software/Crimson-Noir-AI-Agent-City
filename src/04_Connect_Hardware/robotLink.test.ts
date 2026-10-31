// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the page's robot bridge (robotLink.ts) against fakes of its three doors and
 * of the realm: a sim robot's life (demo, spawn, mode, set, remove, and the realm commands each sends); a HAL/1
 * robot that announces itself and whose frames a twin follows, once per frame and not when stale; the whole gate
 * around a leader over HAL/1 (arm refused without the operator tier, the ARM/ARMED nonce, setpoints out as JT lines
 * at the rate and re-sent when held, the lost heartbeat, the tether, the operator lock, the hidden page, `disarm`,
 * `panic`); the relay door (the gate's URL rule, the subprotocols, hello/state/arm/armed/targets/close); and a
 * calibration of a sim robot against a realm the test plays as a first-order lag, recovering its time constant.
 * No device, no browser: UNCONFIRMED on real hardware.
 * What breaks if it is removed? A setpoint could leave the page outside the gate, or a twin could follow a stale frame.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { demoArm, ROBOT_LINK, RobotBridge, type HalDoor, type RobotHost, type SocketLike } from './robotLink.ts'
import type { HalRobot, HalRobotEvent } from './hal.ts'
import { checkTargets, type JointFrame, type Manifest } from './jointState.ts'
import { LEGACY_CAPABILITIES, parseCapabilities, type Capabilities } from './peripheralPolicy.ts'
import { JOINT_FLAG, JOINT_SLOT, JointBuffer } from '../07_Execute_Actions/jointBridge.ts'
import { MAX_ROBOTS } from './jointState.ts'
import type { SimCommand } from '../07_Execute_Actions/simProtocol.ts'

const SERVO: Capabilities = (() => { const c = parseCapabilities('CAPS 1 {"class":"actuator","actuation":["servo"]}'); if (!c || 'error' in c) throw new Error('caps'); return c })()

/** The HAL bus's robot side as a fake: robots the test announces, lines the bridge sends. */
class FakeHal implements HalDoor {
  readonly rows = new Map<string, HalRobot>()
  readonly listeners: ((e: HalRobotEvent) => void)[] = []
  readonly lines: string[] = []
  readonly setpoints: string[] = []
  readonly cleared: string[] = []
  readonly armed: [string, boolean][] = []
  ready = true
  robots(): HalRobot[] { return [...this.rows.values()] }
  onRobot(l: (e: HalRobotEvent) => void): () => void { this.listeners.push(l); return () => { const i = this.listeners.indexOf(l); if (i >= 0) this.listeners.splice(i, 1) } }
  sendLine(id: string, line: string): boolean { if (!this.ready) return false; this.lines.push(`${id} ${line.trim()}`); return true }
  sendSetpoint(id: string, line: string): void { this.setpoints.push(`${id} ${line.trim()}`) }
  clearSetpoint(id: string): void { this.cleared.push(id) }
  markArmed(id: string, armed: boolean): void { this.armed.push([id, armed]) }
  emit(e: HalRobotEvent): void { for (const l of [...this.listeners]) l(e) }
  announce(id: string, manifest: Manifest, caps: Capabilities = SERVO, transport = 'serial'): void {
    this.rows.set(id, { id, name: manifest.robot, transport: transport as never, manifest, caps, frame: null, frameAt: 0, frames: 0, badFrames: 0, ack: -1, armed: false } as HalRobot)
    this.emit({ kind: 'manifest', id, manifest })
  }
}

class FakeSocket implements SocketLike {
  readyState = 0
  sent: string[] = []
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  closed: [number | undefined, string | undefined] | null = null
  readonly url: string
  readonly protocols: string[]
  constructor(url: string, protocols: string[]) { this.url = url; this.protocols = protocols }
  send(data: string): void { this.sent.push(data) }
  close(code?: number, reason?: string): void { this.closed = [code, reason]; this.readyState = 3 }
  open(): void { this.readyState = 1; this.onopen?.({}) }
  say(m: unknown): void { this.onmessage?.({ data: JSON.stringify(m) }) }
  drop(code = 1006, reason = ''): void { this.readyState = 3; this.onclose?.({ code, reason }) }
  json(): Record<string, unknown>[] { return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>) }
}

/** A host with a clock the test moves, a realm that records commands and a joint buffer the test fills. */
function host() {
  const hal = new FakeHal()
  const joints = JointBuffer.create(false)
  const sent: SimCommand[] = []
  const sockets: FakeSocket[] = []
  const clock = { t: 1000 }
  const flags = { unlocked: false }
  const op = { x: 10, y: 0, z: 20, heading: 0 }
  const dom = {
    state: 'visible',
    handlers: new Map<string, () => void>(),
    addEventListener(t: string, f: () => void) { this.handlers.set(t, f) },
    removeEventListener(t: string) { this.handlers.delete(t) },
    get visibilityState() { return this.state },
  }
  const robotHost: RobotHost = {
    hal, joints, send: (c: SimCommand) => { sent.push(c) }, operatorUnlocked: () => flags.unlocked, operatorAt: () => op, now: () => clock.t,
    connect: (url: string, protocols: string[]) => { const s = new FakeSocket(url, protocols); sockets.push(s); return s },
    dom,
  }
  return {
    get t() { return clock.t },
    get unlocked() { return flags.unlocked },
    set unlocked(v: boolean) { flags.unlocked = v },
    op, hal, joints, sent, sockets, dom, host: robotHost,
    /** The realm's answer: body `id` standing at q, placed at (x, z), as the joint buffer would carry it. */
    body(id: number, q: number[], at: [number, number, number] = [10, 0, 18], ack = -1, holding = false): void {
      const slots = new Float32Array(JOINT_SLOT.words)
      slots[JOINT_SLOT.id] = id; slots[JOINT_SLOT.joints] = q.length; slots[JOINT_SLOT.links] = 4; slots[JOINT_SLOT.flags] = holding ? JOINT_FLAG.holding : 0; slots[JOINT_SLOT.ack] = ack
      q.forEach((v, k) => { slots[JOINT_SLOT.q + k] = v })
      slots.set(at, JOINT_SLOT.poses)
      joints.publish(1, clock.t / 1000, slots)
    },
    /** The last realm command of a kind. */
    last<K extends SimCommand['c']>(c: K): Extract<SimCommand, { c: K }> | undefined { return sent.filter((x): x is Extract<SimCommand, { c: K }> => x.c === c).at(-1) },
    tick(ms = 1000 / 60, bridge?: RobotBridge): void { clock.t += ms; bridge?.tick() },
  }
}

const frame = (seq: number, q: number[], ack?: number): JointFrame => ({ stamp: seq, seq, q, qd: q.map(() => 0), tau: [], ...(ack !== undefined ? { ack } : {}) })

test('a sim robot: demo, spawn (the realm commands), mode, set (clamped), remove; the list rows', () => {
  const h = host()
  const b = new RobotBridge(h.host)
  assert.deepEqual(b.list(), [])
  assert.match(b.demo(), /^sim:demo: 4 links, 3 movable joints/)
  assert.throws(() => b.demo('bad name!'), /letters, digits/)
  let row = b.row('sim:demo')!
  assert.deepEqual([row.door, row.mode, row.joints, row.armed, row.body, row.frameAgeMs, row.calibrated], ['sim', 'sim', 3, false, null, null, false])
  assert.match(b.set('sim:demo', 'elbow', 1), /no body/)
  assert.match(b.spawn('sim:demo'), /^sim:demo: body 1 at 10, 22 \(3 joints, mode sim\)$/, 'two metres ahead (heading 0 is +z)')
  const spawn = h.last('robotSpawn')!
  assert.deepEqual([spawn.id, spawn.x, spawn.y, spawn.z, spawn.heading, spawn.manifest.robot], [1, 10, 0, 22, Math.PI, 'demo'])
  assert.deepEqual(h.last('robotMode'), { c: 'robotMode', id: 1, mode: 'filter', tauMs: 0, delaySteps: 0 })
  assert.match(b.spawn('sim:demo'), /already in the realm/)
  assert.match(b.spawn('nobody'), /no robot/)
  assert.match(b.set('sim:demo', 'wrist', 1), /no movable joint 'wrist' \(base_yaw, shoulder, elbow\)/)
  assert.equal(b.set('sim:demo', 'elbow', 1.25), 'sim:demo: elbow → 1.25')
  assert.equal(b.set('sim:demo', '1', 9), 'sim:demo: shoulder → 2 (clamped to the limit)')
  // The body gets the setpoint every tick (the realm holds a stale one on its own).
  h.tick(16, b)
  let t = h.last('robotTargets')!
  assert.deepEqual([t.id, t.q], [1, [0, 2, 1.25]])
  h.tick(16, b)
  assert.ok(h.last('robotTargets')!.seq > t.seq, 'a rising seq')
  assert.match(b.mode('sim:demo', 'twin'), /sends no frames to follow/)
  assert.match(b.mode('sim:demo', 'watch'), /mode watch/)
  assert.equal(h.last('robotMode')!.mode, 'hold')
  const n = h.sent.length
  h.tick(16, b)
  assert.equal(h.sent.length, n, 'watching: nothing goes to the body')
  assert.equal(b.remove('sim:demo'), 'sim:demo: removed')
  assert.deepEqual(h.last('robotRemove'), { c: 'robotRemove', id: 1 })
  assert.deepEqual(b.list(), [], 'a sim robot leaves altogether')
  assert.equal(b.summary().count, 0)
  b.dispose()
})

test('a HAL/1 robot announces itself; a twin follows each frame once, not a stale one; the device going takes the body', () => {
  const h = host()
  const b = new RobotBridge(h.host)
  h.hal.announce('hal:7', demoArm('arm'))
  let row = b.row('hal:7')!
  assert.deepEqual([row.door, row.mode, row.name, row.joints], ['hal', 'twin', 'arm', 3])
  h.hal.emit({ kind: 'frame', id: 'hal:7', frame: frame(1, [0.1, 0.2, 0.3]), at: h.t })
  h.tick(16, b)
  assert.equal(h.last('robotTargets'), undefined, 'no body yet: nothing to drive')
  assert.match(b.spawn('hal:7', 1, 2), /body 1 at 1, 2/)
  assert.equal(h.last('robotMode')!.mode, 'follow')
  h.tick(16, b)
  let t = h.last('robotTargets')!
  assert.deepEqual([t.id, t.seq, t.q], [1, 1, [0.1, 0.2, 0.3]])
  const n = h.sent.length
  h.tick(16, b)
  assert.equal(h.sent.length, n, 'the same frame is handed once')
  h.hal.emit({ kind: 'frame', id: 'hal:7', frame: frame(2, [0.2, 0.2, 0.3]), at: h.t })
  h.tick(16, b)
  assert.equal(h.last('robotTargets')!.seq, 2)
  h.tick(600)
  h.hal.emit({ kind: 'frame', id: 'hal:7', frame: frame(3, [0.3, 0.2, 0.3]), at: h.t - 600 })
  row = b.row('hal:7')!
  assert.equal(row.frameAgeMs, 0, 'the frame is stamped on arrival')
  h.tick(16, b)
  assert.equal(h.last('robotTargets')!.seq, 3)
  h.tick(600, b)
  assert.equal(b.row('hal:7')!.stale, true)
  assert.equal(b.summary().detail.includes('hal:7 twin, 3 joints'), true)
  h.hal.emit({ kind: 'gone', id: 'hal:7' })
  assert.deepEqual(h.last('robotRemove'), { c: 'robotRemove', id: 1 })
  assert.equal(b.row('hal:7'), null)
  b.dispose()
})

test('a leader over HAL/1: the whole gate around it', async () => {
  const h = host()
  const b = new RobotBridge(h.host)
  h.hal.announce('hal:1', demoArm('arm'))
  assert.match(await b.arm('hal:1'), /arm needs mode leader/)
  assert.equal(b.mode('hal:1', 'leader'), 'hal:1: mode leader')
  assert.match(await b.arm('hal:1'), /no body/)
  b.spawn('hal:1', 10, 18)
  assert.match(await b.arm('hal:1'), /arm refused: no-operator-tier \(operator unlock\)/)
  h.unlocked = true
  // The handshake: ARM out, ARMED back with the nonce.
  const arming = b.arm('hal:1')
  const armLine = h.hal.lines.at(-1)!
  const nonce = /^hal:1 ARM ([0-9a-f]{8})$/.exec(armLine)?.[1]
  assert.ok(nonce, armLine)
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: 'deadbeef' })
  assert.equal(b.row('hal:1')!.armed, false, 'a wrong nonce arms nothing')
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: nonce! })
  assert.equal(await arming, 'hal:1: armed')
  assert.deepEqual(h.hal.armed.at(-1), ['hal:1', true])
  assert.equal(await b.arm('hal:1'), 'hal:1: armed')
  // Setpoints out: the body's own joints, as JT lines, at most 20 a second, the newest winning, re-sent at 200 ms.
  h.body(1, [0.1, 0.2, 0.3])
  h.tick(16, b)
  assert.equal(h.hal.setpoints.length, 1)
  const jt = h.hal.setpoints[0]
  assert.match(jt, /^hal:1 JT \{/)
  const t1 = checkTargets(3, JSON.parse(jt.slice('hal:1 JT '.length)))
  assert.ok(t1.ok && t1.value.q[0] === 0.1 && t1.value.issuedAt === h.t && t1.value.ttlMs === ROBOT_LINK.ttlMs)
  h.body(1, [0.11, 0.2, 0.3])
  h.tick(16, b)
  assert.equal(h.hal.setpoints.length, 1, 'under 50 ms: held back')
  h.tick(40, b)
  assert.equal(h.hal.setpoints.length, 2, 'past the period, and changed: sent')
  const t2 = checkTargets(3, JSON.parse(h.hal.setpoints[1].slice('hal:1 JT '.length)))
  assert.ok(t2.ok && t1.ok && t2.value.seq > t1.value.seq)
  h.hal.emit({ kind: 'beat', id: 'hal:1', n: 1 })
  h.tick(60, b)
  assert.equal(h.hal.setpoints.length, 2, 'unchanged: not re-sent yet')
  h.hal.emit({ kind: 'beat', id: 'hal:1', n: 2 })
  h.tick(150, b)
  assert.equal(h.hal.setpoints.length, 3, 'held 200 ms: re-sent')
  // The heartbeat lost: DISARM out, the device told, the slot cleared.
  h.tick(600, b)
  assert.equal(b.row('hal:1')!.armed, false)
  assert.equal(h.hal.lines.at(-1), 'hal:1 DISARM heartbeat-lost')
  assert.deepEqual(h.hal.armed.at(-1), ['hal:1', false])
  assert.ok(h.hal.cleared.includes('hal:1'))
  const before = h.hal.setpoints.length
  h.tick(300, b)
  assert.equal(h.hal.setpoints.length, before, 'disarmed: nothing goes out')
  // Arm again (with beats), then the tether: the body 13 m from the operator.
  const again = b.arm('hal:1')
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: /ARM ([0-9a-f]{8})$/.exec(h.hal.lines.at(-1)!)![1] })
  assert.equal(await again, 'hal:1: armed')
  h.body(1, [0.1, 0.2, 0.3], [10, 0, 20 + 13])
  h.tick(16, b)
  assert.equal(h.hal.lines.at(-1), 'hal:1 DISARM tether-broken')
  // The operator lock.
  h.body(1, [0.1, 0.2, 0.3])
  const third = b.arm('hal:1')
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: /ARM ([0-9a-f]{8})$/.exec(h.hal.lines.at(-1)!)![1] })
  assert.equal(await third, 'hal:1: armed')
  h.unlocked = false
  h.tick(16, b)
  assert.equal(h.hal.lines.at(-1), 'hal:1 DISARM tether-broken', 'the lock breaks the lease')
  assert.ok(b.notes.some((n) => /operator-locked/.test(n)))
  h.unlocked = true
  // The hidden page.
  const fourth = b.arm('hal:1')
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: /ARM ([0-9a-f]{8})$/.exec(h.hal.lines.at(-1)!)![1] })
  assert.equal(await fourth, 'hal:1: armed')
  h.dom.state = 'hidden'
  h.dom.handlers.get('visibilitychange')!()
  assert.equal(b.row('hal:1')!.armed, false)
  assert.ok(b.notes.some((n) => /page-hidden/.test(n)))
  assert.match(await b.arm('hal:1'), /not while the page is hidden/)
  h.dom.state = 'visible'
  h.dom.handlers.get('visibilitychange')!()
  // `disarm`, the device's own DISARM, an ARM that is never answered, and the panic.
  const fifth = b.arm('hal:1')
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: /ARM ([0-9a-f]{8})$/.exec(h.hal.lines.at(-1)!)![1] })
  await fifth
  assert.equal(b.disarm('hal:1'), 'hal:1: disarmed')
  assert.equal(h.hal.lines.at(-1), 'hal:1 DISARM operator')
  assert.equal(b.disarm('hal:1'), 'hal:1: not armed')
  const sixth = b.arm('hal:1')
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: /ARM ([0-9a-f]{8})$/.exec(h.hal.lines.at(-1)!)![1] })
  await sixth
  h.hal.emit({ kind: 'disarm', id: 'hal:1', cause: 'estop' })
  assert.equal(b.row('hal:1')!.armed, false)
  const linesBefore = h.hal.lines.length
  assert.equal(h.hal.lines.length, linesBefore, 'the device disarmed itself: no DISARM echoed back')
  const seventh = b.arm('hal:1')
  await new Promise((r) => setTimeout(r, ROBOT_LINK.armMs + 50))
  assert.match(await seventh, /no ARMED answer/)
  const eighth = b.arm('hal:1')
  h.hal.emit({ kind: 'armed', id: 'hal:1', nonce: /ARM ([0-9a-f]{8})$/.exec(h.hal.lines.at(-1)!)![1] })
  await eighth
  b.panic()
  assert.equal(h.hal.lines.at(-1), 'hal:1 DISARM ring0-panic')
  b.dispose()
})

test('a robot with no servo capability (a sensor) is a twin only: arm says not-declared', async () => {
  const h = host()
  const b = new RobotBridge(h.host)
  h.hal.announce('hal:2', demoArm('sensor'), LEGACY_CAPABILITIES)
  b.mode('hal:2', 'leader')
  b.spawn('hal:2')
  h.unlocked = true
  assert.match(await b.arm('hal:2'), /not-declared \(the robot declared no servo capability: a sensor\)/)
  b.dispose()
})

test('the relay door: only a loopback ws URL, the subprotocols, hello/state/arm/armed/targets, a close drops its robots', async () => {
  const h = host()
  const b = new RobotBridge(h.host)
  await assert.rejects(b.relay('ws://robots.example.net/', 'tok'), /not on this machine/)
  await assert.rejects(b.relay('http://127.0.0.1:8790/', 'tok'), /not on this machine/)
  await assert.rejects(b.relay('ws://127.0.0.1:8790/', 'bad token!'), /not one the relay printed/)
  assert.match(b.relayStatus(), /^relay: off/)
  const joining = b.relay('ws://localhost:8790/', 'abc.123.xyz')
  const ws = h.sockets[0]
  assert.deepEqual(ws.protocols, ['joints.1', 'auth.abc.123.xyz'])
  ws.open()
  ws.say({ t: 'hello', relay: 'agentcity', robots: [
    { id: 'ws:1', name: 'peer', via: 'ws', manifest: demoArm('peer'), caps: { class: 'actuator', actuation: ['servo'] } },
    { id: 'hal:9', manifest: demoArm('x') },
    { id: 'plant/edge/robot-a', manifest: demoArm('spark') },
  ] })
  assert.equal(await joining, 'joined ws://localhost:8790/: 2 robot(s)')
  assert.match(b.relayStatus(), /^relay: open ws:\/\/localhost:8790\/ · 2 robot/)
  assert.deepEqual(b.list().map((r) => [r.id, r.door, r.mode]), [['ws:1', 'relay', 'twin'], ['plant/edge/robot-a', 'relay', 'twin']], 'a hal: id from the relay is not taken')
  // Frames and a twin.
  b.spawn('ws:1')
  ws.say({ t: 'state', id: 'ws:1', frame: frame(5, [0.5, 0.4, 0.3], 0) })
  h.tick(16, b)
  assert.deepEqual(h.last('robotTargets')!.q, [0.5, 0.4, 0.3])
  ws.say({ t: 'state', id: 'ws:1', frame: { seq: 6, q: [NaN, 0, 0] } })
  assert.equal(b.frameOf('ws:1')?.seq, 5, 'a frame that fails the judge is dropped')
  assert.equal(b.row('ws:1')!.frameAgeMs, 16)
  // A leader: arm through the relay, then targets as messages.
  h.unlocked = true
  b.mode('ws:1', 'leader')
  const arming = b.arm('ws:1')
  const arm = ws.json().at(-1)!
  assert.equal(arm.t, 'arm')
  assert.equal(arm.id, 'ws:1')
  ws.say({ t: 'armed', id: 'ws:1', nonce: arm.nonce })
  assert.equal(await arming, 'ws:1: armed')
  h.body(1, [0.1, 0.2, 0.3])
  h.tick(16, b)
  const targets = ws.json().at(-1)!
  assert.equal(targets.t, 'targets')
  const t = checkTargets(3, targets.setpoints)
  assert.ok(t.ok && Math.abs(t.value.q[2] - 0.3) < 1e-6, 'the body (as Float32) leads')
  ws.say({ t: 'beat', id: 'ws:1', n: 3 })
  ws.say({ t: 'ack', id: 'ws:1', seq: t.ok ? t.value.seq : 0 })
  ws.say({ t: 'refused', id: 'ws:1', why: 'rate' })
  assert.ok(b.notes.some((n) => /relay refused ws:1: rate/.test(n)))
  ws.say({ t: 'robot', id: 'plant/edge/robot-a', gone: true })
  assert.equal(b.row('plant/edge/robot-a'), null)
  // The relay closing: its robots leave, their bodies with them; a second relay replaces the first.
  ws.drop(1001, 'bye')
  assert.deepEqual(b.list(), [])
  assert.deepEqual(h.last('robotRemove'), { c: 'robotRemove', id: 1 })
  assert.match(b.relayStatus(), /^relay: off/)
  const second = b.relay('ws://127.0.0.1:8790/', 'tok2')
  const ws2 = h.sockets[1]
  ws2.open()
  ws2.say({ t: 'hello', robots: [] })
  assert.equal(await second, 'joined ws://127.0.0.1:8790/: 0 robot(s)')
  assert.equal(b.relayOff(), 'relay: left ws://127.0.0.1:8790/')
  assert.deepEqual(ws2.closed, [1000, 'operator'])
  // A relay that closes before hello: the join rejects.
  const third = b.relay('ws://127.0.0.1:8790/', 'tok3')
  h.sockets[2].drop(1008, 'token')
  await assert.rejects(third, /closed the socket \(token\)/)
  b.dispose()
})

test('calibrating a sim robot against a realm the test plays as a first-order lag recovers its time constant', async () => {
  const h = host()
  const b = new RobotBridge(h.host)
  b.demo('cal')
  b.spawn('sim:cal')
  h.unlocked = true
  assert.match(await b.calibrate('sim:cal', 'elbow'), /arm first/)
  assert.equal(await b.arm('sim:cal'), 'sim:cal: armed (sim)')
  assert.match(await b.calibrate('sim:cal', 'nothing'), /no movable joint/)
  const done = b.calibrate('sim:cal', 'elbow')
  assert.match(await b.calibrate('sim:cal', 'elbow'), /a calibration is running \(elbow\)/)
  // The realm: three joints answering the newest setpoint as y' = (u − y) / τ with τ = 120 ms, one step a tick.
  const TAU = 120, H = 1000 / 60
  const y = [0, 0, 0]
  let resolved: string | null = null
  void done.then((s) => { resolved = s })
  for (let i = 0; i < 60 * 6 && !resolved; i++) {
    const t = h.last('robotTargets')
    if (t) for (let k = 0; k < 3; k++) y[k] += (t.q[k] - y[k]) * (1 - Math.exp(-H / TAU))
    h.body(1, [...y], [10, 0, 18], t?.seq ?? -1)
    h.tick(H, b)
    await Promise.resolve()
  }
  assert.ok(resolved, 'the calibration finished')
  assert.match(resolved!, /^sim:cal: elbow: delay \d+ ms \(return trip \d+ ms\), τ (\d+) ms, gain/)
  const tau = Number(/τ (\d+) ms, gain/.exec(resolved!)![1])
  assert.ok(Math.abs(tau - TAU) < 40, `τ ${tau} ms (the realm's was ${TAU})`)
  assert.equal(b.row('sim:cal')!.calibrated, true)
  const mode = h.last('robotMode')!
  assert.ok(mode.mode === 'filter' && Math.abs(mode.tauMs! - TAU) < 40 && mode.delaySteps! <= 2, JSON.stringify(mode))
  assert.equal(b.remove('sim:cal'), 'sim:cal: removed')
  b.dispose()
})

test('the spawn cap and the summary', () => {
  const h = host()
  const b = new RobotBridge(h.host)
  for (let i = 0; i <= MAX_ROBOTS; i++) b.demo(`r${i}`)
  for (let i = 0; i < MAX_ROBOTS; i++) assert.match(b.spawn(`sim:r${i}`), /body/)
  assert.match(b.spawn(`sim:r${MAX_ROBOTS}`), /at most 4 robots/)
  const s = b.summary()
  assert.equal(s.count, MAX_ROBOTS + 1)
  assert.match(s.detail, /^5 · sim:r0 sim, 3 joints$/)
  b.dispose()
})
