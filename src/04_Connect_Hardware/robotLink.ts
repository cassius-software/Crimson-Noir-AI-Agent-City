// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's end of the joint bridge (docs/joint-bridge-spec.md): the one object the
 * console's `robot` command and the HUD talk to. It knows every robot the page can see, through three doors: the HAL
 * bus (a device that sent JOINTS over Web Serial or BLE), the loopback relay (a WebSocket on this machine, opened by
 * `robot relay`, carrying its WebSocket peers and its Sparkplug devices) and no door at all (a `sim` robot from a
 * URDF file or the built-in demo arm, whose only body is the one in the realm). For each it keeps the newest frame,
 * the body in the physics realm (spawned and driven with SimCommands, read back from the joint buffer), the mode
 * (twin: the body follows the robot; leader: the body leads and its joints go out as setpoints; watch; sim), the
 * gate's state (peripheralPolicy.ts: caps, the operator tier, the lease the console holds, the arming handshake, the
 * heartbeat, the sequence, the time-to-live and the rate) and the calibration (actuatorFit.ts). Nothing goes out to a
 * robot except through `admit`; every door's outbound lines are built here, at most 20 a second (10 over BLE), the
 * newest winning and a held setpoint re-sent every 200 ms. The socket is made only inside connect() and only for a
 * URL the air gap's netServer admits; a URDF file is read only through loopbackFetch. The lease breaks when the body
 * is more than 12 m from the operator, on `robot disarm`, on `operator lock`, on a halt (panic) or when the page is
 * hidden. No engine reference: the engine hands it a small host (the HAL bus, the joint buffer, a send(), the
 * operator's tier and position, a clock), so the tests drive it with fakes.
 * What breaks if it is removed? The console has no robots, the realm's robot bodies have no one to spawn or drive
 * them, and no setpoint could ever reach a device, gated or not.
 */
import { loopbackFetch, netServer, refusal } from '../02_Define_The_Rules/airgap.ts'
import {
  admit, confirmArm, disarm as disarmState, heartbeat, initialState, LEGACY_CAPABILITIES, parseCapabilities, POLICY, requestArm, tetherBroken, watchdog,
  type Capabilities, type PolicyState,
} from './peripheralPolicy.ts'
import { buildable, buildManifest, checkFrame, clampTargets, frameLine, MAX_ROBOTS, type JointFrame, type Manifest } from './jointState.ts'
import { Calibrator, gainsFor, RoundTrip, type TwinGains } from './actuatorFit.ts'
import { parseUrdf } from './urdf.ts'
import { LINE } from './lineLink.ts'
import type { HalRobot, HalRobotEvent } from './hal.ts'
import { JOINT_FLAG, JOINT_SLOT, JointBuffer, slotView } from '../07_Execute_Actions/jointBridge.ts'
import type { RobotMode as RealmMode, SimCommand } from '../07_Execute_Actions/simProtocol.ts'

/** How a robot and its body relate (spec §2). */
export type BridgeMode = 'twin' | 'leader' | 'watch' | 'sim'
export const BRIDGE_MODES: readonly BridgeMode[] = Object.freeze(['twin', 'leader', 'watch', 'sim'])
export type Door = 'hal' | 'relay' | 'sim'

export const ROBOT_LINK = Object.freeze({
  /** The lease breaks when the body is farther than this from the operator, m (the Spatial Lease's tether). */
  tetherM: 12,
  /** Setpoints out: at most this often, ms (POLICY.maxRatePerSecond), and over BLE half as often. */
  periodMs: 1000 / POLICY.maxRatePerSecond,
  blePeriodMs: 2000 / POLICY.maxRatePerSecond,
  /** A held setpoint is re-sent this often, ms, so it never lapses. */
  resendMs: 200,
  /** Every setpoint's time-to-live, ms (under POLICY.maxTtlMs). */
  ttlMs: 200,
  /** The ARM handshake must be answered within this long, ms. */
  armMs: 2000,
  /** A frame older than this is stale (the twin holds), ms. */
  staleMs: POLICY.watchdogMs,
  /** The relay's subprotocol. */
  protocol: 'joints.1',
  /** The default relay address (spec §3.2). */
  relayUrl: 'ws://127.0.0.1:8790/',
  /** Longest relay message read, bytes. */
  maxMessage: 1 << 20,
  /** Longest URDF file read, bytes. */
  maxUrdf: 4 << 20,
})

/** The HAL bus's robot side (hal.ts), as this bridge needs it. */
export interface HalDoor {
  robots(): HalRobot[]
  onRobot(listener: (e: HalRobotEvent) => void): () => void
  sendLine(id: string, line: string): boolean
  sendSetpoint(id: string, line: string): void
  clearSetpoint(id: string): void
  markArmed(id: string, armed: boolean): void
}

/** A WebSocket as this bridge uses it (the browser's, or a fake in the tests). */
export interface SocketLike {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

type DomLike = { addEventListener?(t: string, f: () => void): void; removeEventListener?(t: string, f: () => void): void; visibilityState?: string }

/** What the engine gives the bridge. */
export interface RobotHost {
  readonly hal: HalDoor
  /** The joint buffer the realm fills (simClient.ts joints). */
  readonly joints: JointBuffer
  /** A command for the realm (simClient.ts send). */
  send(cmd: SimCommand): void
  operatorUnlocked(): boolean
  /** Where the operator stands: the feet, and the way they face. */
  operatorAt(): { x: number; y: number; z: number; heading: number }
  /** The wall clock in ms (Date.now() in the engine): a setpoint's issuedAt crosses the wire, and the relay judges its age on its own wall clock. */
  now(): number
  /** Reads a URL's text (robot urdf); the default is the page's fetch under loopbackFetch. */
  fetchText?(url: string): Promise<string>
  /** Opens a socket (the tests' fake); the default is the browser's WebSocket, for a URL netServer admits. */
  connect?(url: string, protocols: string[]): SocketLike
  /** The document, for the hidden-page rule; the default is globalThis.document. */
  dom?: DomLike | null
  log?(line: string): void
}

/** One robot as the console lists it. */
export interface RobotRow {
  id: string
  door: Door
  name: string
  mode: BridgeMode
  joints: number
  armed: boolean
  /** The body is in the realm (its realm id), or null. */
  body: number | null
  /** The newest frame's age, ms, or null without one. */
  frameAgeMs: number | null
  stale: boolean
  calibrated: boolean
  refusals: number
}

interface Robot {
  readonly id: string
  readonly door: Door
  name: string
  manifest: Manifest
  caps: Capabilities
  transport: string
  mode: BridgeMode
  frame: JointFrame | null
  frameAt: number
  /** The frame's seq last handed to the realm (twin). */
  handed: number
  ack: number
  body: number | null
  /** The newest reading of the body out of the joint buffer: q, q̇, τ and the root link's position. */
  q: number[]
  qd: number[]
  tau: number[]
  at: [number, number, number] | null
  holding: boolean
  bodyAck: number
  policy: PolicyState
  lease: AbortController | null
  armWait: { resolve: (s: string) => void; timer: ReturnType<typeof setTimeout> } | null
  gains: TwinGains | null
  /** The console's setpoint (leader, sim), per movable joint; null until set (the body stands where it was built). */
  setpoint: number[] | null
  seq: number
  lastSentAt: number
  lastSentKey: string
  refusals: number
  readonly rtt: RoundTrip
  cal: { c: Calibrator; joint: string; resolve: (s: string) => void } | null
}

type RelayMessage = Record<string, unknown> & { t: string }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const fmt = (n: number, d = 3): string => {
  if (!Number.isFinite(n)) return 'nan'
  const s = n.toFixed(d)
  return s.includes('.') ? s.replace(/\.?0+$/, '') || '0' : s
}

/** The built-in demo arm (`robot demo`): three joints, so the bridge can be tried with nothing attached. */
export function demoArm(name = 'demo'): Manifest {
  const m = buildManifest(name, [
    { name: 'base', mass: 4, shape: { kind: 'cylinder', radius: 0.12, length: 0.1 }, shapeOrigin: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] } },
    { name: 'shoulder_link', mass: 1.2, shape: { kind: 'capsule', radius: 0.04, length: 0.35 }, shapeOrigin: { xyz: [0, 0, 0.175], rpy: [0, 0, 0] } },
    { name: 'elbow_link', mass: 0.8, shape: { kind: 'capsule', radius: 0.035, length: 0.3 }, shapeOrigin: { xyz: [0, 0, 0.15], rpy: [0, 0, 0] } },
    { name: 'wrist_link', mass: 0.3, shape: { kind: 'box', size: [0.06, 0.06, 0.1] }, shapeOrigin: { xyz: [0, 0, 0.05], rpy: [0, 0, 0] } },
  ], [
    { name: 'base_yaw', kind: 'revolute', parent: 'base', child: 'shoulder_link', origin: { xyz: [0, 0, 0.1], rpy: [0, 0, 0] }, axis: [0, 0, 1], lower: -2.9, upper: 2.9, effort: 40, velocity: 3 },
    { name: 'shoulder', kind: 'revolute', parent: 'shoulder_link', child: 'elbow_link', origin: { xyz: [0, 0, 0.35], rpy: [0, 0, 0] }, axis: [0, 1, 0], lower: -2, upper: 2, effort: 30, velocity: 3 },
    { name: 'elbow', kind: 'revolute', parent: 'elbow_link', child: 'wrist_link', origin: { xyz: [0, 0, 0.3], rpy: [0, 0, 0] }, axis: [0, 1, 0], lower: -2.5, upper: 2.5, effort: 15, velocity: 4 },
  ])
  if (!m.ok) throw new Error(m.reason)
  return m.value
}

/** The caps a sim robot declares (an actuator with servos: the whole handshake runs against the realm). */
const SIM_CAPS: Capabilities = Object.freeze({ version: 1, deviceClass: 'actuator', telemetry: Object.freeze([]), actuation: Object.freeze(['servo']), refused: Object.freeze([]) })

/** The page's robot bridge. */
export class RobotBridge {
  private readonly host: RobotHost
  private readonly robots = new Map<string, Robot>()
  private readonly unlisten: (() => void)[] = []
  private readonly snapshot = new Float32Array(MAX_ROBOTS * JOINT_SLOT.words)
  private socket: SocketLike | null = null
  private relayUrl: string | null = null
  private relayState: 'off' | 'connecting' | 'open' = 'off'
  private nextBody = 1
  private hidden = false
  private disposed = false
  /** Lines the bridge wants the operator to see (the console's `robot` prints and clears them). */
  readonly notes: string[] = []

  constructor(host: RobotHost) {
    this.host = host
    this.unlisten.push(host.hal.onRobot((e) => this.onHal(e)))
    const dom = host.dom === undefined ? ((globalThis as { document?: DomLike }).document ?? null) : host.dom
    if (dom?.addEventListener) {
      const onVisibility = () => this.setHidden(dom.visibilityState === 'hidden')
      const onHide = () => this.setHidden(true)
      dom.addEventListener('visibilitychange', onVisibility)
      dom.addEventListener('pagehide', onHide)
      this.unlisten.push(() => { dom.removeEventListener?.('visibilitychange', onVisibility); dom.removeEventListener?.('pagehide', onHide) })
    }
    for (const r of host.hal.robots()) this.fromHal(r)
  }

  // ---- the doors -------------------------------------------------------------------------------------------------

  /** `robot relay <url> <token>`: opens the relay's page socket (one at a time); resolves with the hello's count. */
  relay(url: string, token: string): Promise<string> {
    if (this.disposed) return Promise.resolve('the city has stopped')
    const admitted = netServer(url)
    if (admitted === null) return Promise.reject(new Error(refusal(url)))
    if (!/^[\w.-]{1,512}$/.test(token)) return Promise.reject(new Error('the token is not one the relay printed'))
    this.relayOff('replaced')
    this.relayState = 'connecting'
    this.relayUrl = admitted
    return new Promise<string>((resolve, reject) => {
      let settled = false
      const settle = (f: () => void) => { if (!settled) { settled = true; f() } }
      let ws: SocketLike
      try {
        ws = this.openSocket(admitted, [ROBOT_LINK.protocol, `auth.${token}`])
      } catch (e) {
        this.relayState = 'off'
        this.relayUrl = null
        reject(e instanceof Error ? e : new Error(String(e)))
        return
      }
      this.socket = ws
      const timer = setTimeout(() => settle(() => { this.relayOff('no answer'); reject(new Error('the relay did not answer in time')) }), 5000)
      ws.onopen = () => { this.relayState = 'open' }
      ws.onmessage = (ev) => {
        const m = this.readRelay(ev.data)
        if (!m) return
        this.onRelay(m)
        if (m.t === 'hello') settle(() => { clearTimeout(timer); resolve(`joined ${admitted}: ${this.relayRobots().length} robot(s)`) })
      }
      ws.onclose = (ev) => {
        if (this.socket !== ws) return
        this.socket = null
        this.relayState = 'off'
        this.relayUrl = null
        const why = ev?.reason ? `${ev.reason}` : `code ${ev?.code ?? '?'}`
        for (const r of this.relayRobots()) this.drop(r, `relay closed (${why})`)
        settle(() => { clearTimeout(timer); reject(new Error(`the relay closed the socket (${why}): a wrong token, or a page the relay does not take`)) })
      }
      ws.onerror = () => { /* onclose follows with the code */ }
    })
  }

  /** `robot relay off`: closes the relay socket; every relay robot leaves (the relay disarms its devices itself). */
  relayOff(cause = 'operator'): string {
    const ws = this.socket
    if (!ws) return 'relay: off'
    this.socket = null
    this.relayState = 'off'
    const url = this.relayUrl
    this.relayUrl = null
    for (const r of this.relayRobots()) {
      if (r.policy.armed) this.sendDisarm(r, cause, false)
      this.drop(r, `relay ${cause}`)
    }
    try { ws.close(1000, cause) } catch { /* already gone */ }
    return `relay: left ${url ?? ''}`.trim()
  }

  /** The relay's state line. */
  relayStatus(): string {
    return this.relayState === 'off' ? 'relay: off (robot relay <ws url> <token>)' : `relay: ${this.relayState} ${this.relayUrl ?? ''} · ${this.relayRobots().length} robot(s)`.trim()
  }

  /** `robot urdf <url> [name]`: a sim robot from a URDF file on this machine. */
  async urdf(url: string, name?: string): Promise<string> {
    const read = this.host.fetchText ?? defaultFetchText
    const text = await read(url)
    if (text.length > ROBOT_LINK.maxUrdf) throw new Error('the URDF file is too big')
    const m = parseUrdf(text)
    if (!m.ok) throw new Error(`urdf: ${m.reason}`)
    const id = `sim:${name ?? m.value.robot}`
    if (!/^sim:[A-Za-z0-9_.-]{1,32}$/.test(id)) throw new Error('name: letters, digits, _ . - (at most 32)')
    this.addSim(id, m.value)
    return `${id}: ${m.value.links.length} links, ${m.value.movable.length} movable joints (robot spawn ${id})`
  }

  /** `robot demo [name]`: the built-in arm as a sim robot. */
  demo(name = 'demo'): string {
    if (!/^[A-Za-z0-9_.-]{1,32}$/.test(name)) throw new Error('name: letters, digits, _ . - (at most 32)')
    const m = demoArm(name)
    this.addSim(`sim:${name}`, m)
    return `sim:${name}: ${m.links.length} links, ${m.movable.length} movable joints (robot spawn sim:${name})`
  }

  // ---- the robots -------------------------------------------------------------------------------------------------

  /** Every robot the page can see, as rows. */
  list(): RobotRow[] {
    const now = this.host.now()
    return [...this.robots.values()].map((r) => ({
      id: r.id, door: r.door, name: r.name, mode: r.mode, joints: r.manifest.movable.length, armed: r.policy.armed, body: r.body,
      frameAgeMs: r.frame ? Math.max(0, now - r.frameAt) : null, stale: r.frame !== null && now - r.frameAt > ROBOT_LINK.staleMs,
      calibrated: r.gains !== null, refusals: r.refusals,
    }))
  }

  /** The row of robot `id`, or null. */
  row(id: string): RobotRow | null {
    return this.list().find((r) => r.id === id) ?? null
  }

  /** The newest frame of robot `id` (its own, or for a sim robot the body's reading as a frame), or null. */
  frameOf(id: string): JointFrame | null {
    const r = this.robots.get(id)
    if (!r) return null
    if (r.door === 'sim' && r.body !== null) return { stamp: this.host.now(), seq: r.bodyAck, q: [...r.q], qd: [...r.qd], tau: [...r.tau], ack: r.bodyAck }
    return r.frame
  }

  /** The body's newest reading out of the joint buffer (q, q̇, τ, the root link's position), or null without a body. */
  bodyOf(id: string): { q: readonly number[]; qd: readonly number[]; tau: readonly number[]; at: readonly [number, number, number] | null; holding: boolean } | null {
    const r = this.robots.get(id)
    return r && r.body !== null ? { q: r.q, qd: r.qd, tau: r.tau, at: r.at, holding: r.holding } : null
  }

  /** `robot spawn <id> [x z]`: the body in the realm, at (x, z) on the operator's ground or two metres before them. */
  spawn(id: string, x?: number, z?: number): string {
    const r = this.robots.get(id)
    if (!r) return `no robot '${id}'`
    if (r.body !== null) return `${id}: already in the realm (body ${r.body}); robot remove first`
    const bodies = [...this.robots.values()].filter((o) => o.body !== null).length
    if (bodies >= MAX_ROBOTS) return `the realm holds at most ${MAX_ROBOTS} robots`
    const why = buildable(r.manifest)
    if (why) return `${id}: ${why}`
    const op = this.host.operatorAt()
    const px = x ?? op.x + 2 * Math.sin(op.heading), pz = z ?? op.z + 2 * Math.cos(op.heading)
    if (!Number.isFinite(px) || !Number.isFinite(pz)) return 'x and z must be numbers'
    r.body = this.nextBody++
    r.q = r.manifest.movable.map(() => 0)
    r.qd = r.manifest.movable.map(() => 0)
    r.tau = r.manifest.movable.map(() => 0)
    r.at = null
    r.holding = true
    this.host.send({ c: 'robotSpawn', id: r.body, manifest: r.manifest, x: px, y: op.y, z: pz, heading: op.heading + Math.PI })
    this.sendMode(r)
    return `${id}: body ${r.body} at ${fmt(px, 1)}, ${fmt(pz, 1)} (${r.manifest.movable.length} joints, mode ${r.mode})`
  }

  /** `robot mode <id> twin|leader|watch|sim`. */
  mode(id: string, mode: BridgeMode): string {
    const r = this.robots.get(id)
    if (!r) return `no robot '${id}'`
    if (!BRIDGE_MODES.includes(mode)) return `unknown mode '${String(mode)}' (twin, leader, watch, sim)`
    if (mode === 'sim' && r.door !== 'sim') return `${id}: sim is for a robot with no door (robot urdf, robot demo)`
    if (mode !== 'sim' && mode !== 'leader' && r.door === 'sim' && mode === 'twin') return `${id}: a sim robot sends no frames to follow`
    if (r.policy.armed && mode !== 'leader') this.disarm(id, 'mode')
    r.mode = mode
    if (mode === 'leader' || mode === 'sim') r.setpoint = r.body !== null ? [...r.q] : null
    this.sendMode(r)
    return `${id}: mode ${mode}`
  }

  /** `robot set <id> <joint> <q>`: a leader's or sim's setpoint for one joint (rad or m, clamped to its limits). */
  set(id: string, joint: string, q: number): string {
    const r = this.robots.get(id)
    if (!r) return `no robot '${id}'`
    if (r.mode !== 'leader' && r.mode !== 'sim') return `${id}: set needs mode leader or sim`
    if (r.body === null) return `${id}: no body in the realm (robot spawn ${id})`
    const k = this.jointIndex(r, joint)
    if (k < 0) return `${id}: no movable joint '${joint}' (${r.manifest.movable.map((j) => r.manifest.joints[j].name).join(', ')})`
    if (!Number.isFinite(q)) return 'q must be a number'
    const spec = r.manifest.joints[r.manifest.movable[k]]
    const v = spec.kind === 'continuous' ? q : Math.min(spec.upper, Math.max(spec.lower, q))
    if (!r.setpoint) r.setpoint = [...r.q]
    r.setpoint[k] = v
    return `${id}: ${spec.name} → ${fmt(v)}${v !== q ? ' (clamped to the limit)' : ''}`
  }

  /** `robot arm <id>`: the handshake, for a leader with a body; resolves with the outcome. */
  arm(id: string): Promise<string> {
    const r = this.robots.get(id)
    if (!r) return Promise.resolve(`no robot '${id}'`)
    if (r.mode !== 'leader' && r.mode !== 'sim') return Promise.resolve(`${id}: arm needs mode leader (robot mode ${id} leader)`)
    if (r.body === null) return Promise.resolve(`${id}: no body in the realm (robot spawn ${id})`)
    if (r.policy.armed) return Promise.resolve(`${id}: armed`)
    if (this.hidden) return Promise.resolve(`${id}: not while the page is hidden`)
    const now = this.host.now()
    const lease = new AbortController()
    r.lease = lease
    r.policy = { ...r.policy, operator: this.host.operatorUnlocked(), lease: { signal: lease.signal } }
    const nonce = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0')
    const asked = requestArm(r.policy, nonce, now)
    if ('refused' in asked) {
      r.lease = null
      r.policy = { ...r.policy, lease: null }
      return Promise.resolve(`${id}: arm refused: ${asked.refused}${asked.refused === 'no-operator-tier' ? ' (operator unlock)' : asked.refused === 'not-declared' ? ' (the robot declared no servo capability: a sensor)' : ''}`)
    }
    r.policy = asked.state
    if (r.door === 'sim') {
      // The realm is the robot: it answers the handshake at once.
      r.policy = confirmArm(r.policy, nonce, now)
      return Promise.resolve(`${id}: armed (sim)`)
    }
    this.sendOut(r, asked.line.trim(), { t: 'arm', id: r.id, nonce })
    return new Promise<string>((resolve) => {
      const timer = setTimeout(() => {
        if (r.armWait) {
          r.armWait = null
          r.policy = { ...r.policy, armNonce: null }
          r.lease = null
          resolve(`${id}: no ARMED answer within ${ROBOT_LINK.armMs / 1000} s`)
        }
      }, ROBOT_LINK.armMs)
      r.armWait = { resolve, timer }
    })
  }

  /** `robot disarm <id>`: DISARM out, the lease broken. */
  disarm(id: string, cause = 'operator'): string {
    const r = this.robots.get(id)
    if (!r) return `no robot '${id}'`
    if (!r.policy.armed && !r.armWait) return `${id}: not armed`
    this.sendDisarm(r, cause, true)
    return `${id}: disarmed`
  }

  /** `robot calibrate <id> <joint>`: one joint's step response, armed; resolves with the fit and the twin's new lag. */
  calibrate(id: string, joint: string): Promise<string> {
    const r = this.robots.get(id)
    if (!r) return Promise.resolve(`no robot '${id}'`)
    if (r.mode !== 'leader' && r.mode !== 'sim') return Promise.resolve(`${id}: calibrate needs mode leader or sim`)
    if (r.body === null) return Promise.resolve(`${id}: no body in the realm (robot spawn ${id})`)
    if (!r.policy.armed) return Promise.resolve(`${id}: arm first (robot arm ${id})`)
    if (r.cal) return Promise.resolve(`${id}: a calibration is running (${r.cal.joint})`)
    const k = this.jointIndex(r, joint)
    if (k < 0) return Promise.resolve(`${id}: no movable joint '${joint}'`)
    const spec = r.manifest.joints[r.manifest.movable[k]]
    const limited = spec.kind !== 'continuous'
    const c = new Calibrator([{ index: k, name: spec.name, lower: limited ? spec.lower : null, upper: limited ? spec.upper : null }])
    return new Promise<string>((resolve) => { r.cal = { c, joint: spec.name, resolve } })
  }

  /** `robot remove <id>`: the body out of the realm (a sim robot leaves altogether). */
  remove(id: string): string {
    const r = this.robots.get(id)
    if (!r) return `no robot '${id}'`
    if (r.policy.armed || r.armWait) this.sendDisarm(r, 'removed', true)
    this.unspawn(r)
    if (r.door === 'sim') this.robots.delete(id)
    return `${id}: removed`
  }

  /** The HUD's and the namespace's summary. */
  summary(): { count: number; armed: number; detail: string } {
    const rows = this.list()
    const armed = rows.filter((r) => r.armed).length
    if (rows.length === 0) return { count: 0, armed: 0, detail: '' }
    const first = rows[0]
    const age = first.frameAgeMs === null ? '' : ` · frame ${Math.round(first.frameAgeMs)} ms ago`
    return { count: rows.length, armed, detail: `${rows.length}${armed ? `, ${armed} armed` : ''} · ${first.id} ${first.mode}, ${first.joints} joints${age}` }
  }

  // ---- the beat ---------------------------------------------------------------------------------------------------

  /**
   * Once per realm state (the engine's received): reads the bodies out of the joint buffer, drives twins from
   * their frames and leaders' bodies from the console, sends setpoints out through the gate, runs the watchdog,
   * the tether and the calibration.
   */
  tick(): void {
    if (this.disposed) return
    const now = this.host.now()
    this.readBodies()
    const op = this.host.operatorAt()
    const unlocked = this.host.operatorUnlocked()
    for (const r of this.robots.values()) {
      // The gate's view of the operator tier, and the tether.
      if (r.policy.operator !== unlocked) r.policy = { ...r.policy, operator: unlocked }
      if (r.lease && !r.lease.signal.aborted) {
        const far = r.at ? Math.hypot(r.at[0] - op.x, r.at[2] - op.z) > ROBOT_LINK.tetherM : false
        if (!unlocked) this.breakLease(r, 'operator-locked', now)
        else if (far) this.breakLease(r, 'tether-broken', now)
        else if (this.hidden) this.breakLease(r, 'page-hidden', now)
      }
      // The heartbeat: a sim robot's is the realm's own step; a device's came through its door.
      if (r.door === 'sim' && r.policy.armed) r.policy = heartbeat(r.policy, now)
      const w = watchdog(r.policy, now)
      if (w.broadcast.length) { r.policy = w.state; this.afterDisarm(r, w.broadcast, 'watchdog') }
      if (r.body === null) continue
      if (r.mode === 'twin') {
        // The newest frame, once: the body follows it.
        if (r.frame && r.frame.seq !== r.handed && now - r.frameAt <= ROBOT_LINK.staleMs) {
          r.handed = r.frame.seq
          this.host.send({ c: 'robotTargets', id: r.body, seq: r.frame.seq, q: [...r.frame.q], qd: [...r.frame.qd], tau: [] })
        }
        continue
      }
      if (r.mode === 'watch') continue
      // A leader or a sim: the calibration's setpoint, else the console's; the body gets it every step (none yet:
      // the realm holds the body where it stands).
      if (r.cal) this.tickCalibration(r, now)
      const sp = r.setpoint
      if (sp) this.host.send({ c: 'robotTargets', id: r.body, seq: ++r.seq, q: sp, qd: [], tau: [] })
      // Out to the robot (a leader with a door), through the gate, decimated: the body's own joints lead, whether
      // the console moved them or not.
      if (r.mode === 'leader' && r.door !== 'sim' && r.policy.armed) this.sendSetpoints(r, now)
    }
  }

  /** A halt (the engine's panic): DISARM on every door, the relay closed. Best effort, synchronous. */
  panic(): void {
    for (const r of this.robots.values()) if (r.policy.armed || r.armWait) this.sendDisarm(r, 'ring0-panic', false)
    this.relayOff('panic')
  }

  dispose(): void {
    if (this.disposed) return
    this.panic()
    this.disposed = true
    for (const u of this.unlisten.splice(0)) u()
  }

  // ---- inside ------------------------------------------------------------------------------------------------------


  private jointIndex(r: Robot, joint: string): number {
    const k = Number(joint)
    if (Number.isInteger(k) && k >= 0 && k < r.manifest.movable.length && /^\d+$/.test(joint)) return k
    return r.manifest.movable.findIndex((j) => r.manifest.joints[j].name === joint)
  }

  private realmMode(r: Robot): RealmMode {
    return r.mode === 'twin' ? 'follow' : r.mode === 'watch' ? 'hold' : 'filter'
  }

  private sendMode(r: Robot): void {
    if (r.body === null) return
    const g = r.gains
    this.host.send({ c: 'robotMode', id: r.body, mode: this.realmMode(r), tauMs: g?.tauMs ?? 0, delaySteps: g?.delaySteps ?? 0 })
  }

  private note(line: string): void {
    if (this.notes.length < 32) this.notes.push(line)
    this.host.log?.(line)
  }

  private setHidden(hidden: boolean): void {
    this.hidden = hidden
    if (!hidden) return
    const now = this.host.now()
    for (const r of this.robots.values()) if (r.lease && !r.lease.signal.aborted) this.breakLease(r, 'page-hidden', now)
  }

  private newRobot(id: string, door: Door, manifest: Manifest, caps: Capabilities, transport: string): Robot {
    const n = manifest.movable.length
    return {
      id, door, name: manifest.robot, manifest, caps, transport, mode: door === 'sim' ? 'sim' : 'twin',
      frame: null, frameAt: 0, handed: -1, ack: -1, body: null, q: new Array<number>(n).fill(0), qd: new Array<number>(n).fill(0), tau: new Array<number>(n).fill(0), at: null, holding: true, bodyAck: -1,
      policy: initialState(caps, this.host.now(), n), lease: null, armWait: null, gains: null, setpoint: null, seq: 0, lastSentAt: -Infinity, lastSentKey: '', refusals: 0,
      rtt: new RoundTrip(), cal: null,
    }
  }

  private addSim(id: string, manifest: Manifest): void {
    const old = this.robots.get(id)
    if (old) this.remove(id)
    this.robots.set(id, this.newRobot(id, 'sim', manifest, SIM_CAPS, 'realm'))
  }

  /** A robot's manifest arrived (or arrived again): a new robot, or the manifest replaced while disarmed. */
  private announce(id: string, door: Door, manifest: Manifest, caps: Capabilities, transport: string): void {
    const old = this.robots.get(id)
    if (old) {
      if (old.policy.armed) { this.note(`${id}: a new manifest while armed is ignored`); return }
      this.unspawn(old)
      old.manifest = manifest
      old.name = manifest.robot
      old.caps = caps
      old.policy = initialState(caps, this.host.now(), manifest.movable.length)
      old.frame = null
      old.gains = null
      old.setpoint = null
      return
    }
    this.robots.set(id, this.newRobot(id, door, manifest, caps, transport))
  }

  private fromHal(h: HalRobot): void {
    this.announce(h.id, 'hal', h.manifest, h.caps, h.transport)
    const r = this.robots.get(h.id)
    if (r && h.frame) { r.frame = h.frame; r.frameAt = this.host.now(); r.ack = h.ack }
  }

  private onHal(e: HalRobotEvent): void {
    if (this.disposed) return
    const now = this.host.now()
    if (e.kind === 'manifest') {
      const h = this.host.hal.robots().find((x) => x.id === e.id)
      this.announce(e.id, 'hal', e.manifest, h?.caps ?? LEGACY_CAPABILITIES, h?.transport ?? 'serial')
      return
    }
    const r = this.robots.get(e.id)
    if (!r || r.door !== 'hal') return
    this.onDoor(r, e, now)
  }

  /** One event from a door (the HAL bus's shape; the relay's messages are turned into it). */
  private onDoor(r: Robot, e: HalRobotEvent, now: number): void {
    switch (e.kind) {
      case 'frame':
        r.frame = e.frame
        r.frameAt = now
        if (e.frame.ack !== undefined) this.acked(r, e.frame.ack, now)
        return
      case 'ack': this.acked(r, e.seq, now); return
      case 'armed': {
        const was = r.policy
        r.policy = confirmArm(r.policy, e.nonce, now)
        if (r.policy.armed && !was.armed) {
          if (r.door === 'hal') this.host.hal.markArmed(r.id, true)
          if (r.armWait) { clearTimeout(r.armWait.timer); r.armWait.resolve(`${r.id}: armed`); r.armWait = null }
        }
        return
      }
      case 'beat': r.policy = heartbeat(r.policy, now); return
      case 'disarm': {
        // The device (or the relay) disarmed itself: our state follows, nothing more goes out.
        if (r.policy.armed || r.armWait) {
          r.policy = disarmState(r.policy, `device-${e.cause}`, now).state
          this.afterDisarm(r, [], `device: ${e.cause}`)
        }
        return
      }
      case 'gone': this.drop(r, 'gone'); return
      default: return
    }
  }

  private acked(r: Robot, seq: number, now: number): void {
    if (seq > r.ack) r.ack = seq
    r.rtt.echo(seq, now)
  }

  /** The robot left (its device unplugged, the relay closed): its body goes, its state with it. */
  private drop(r: Robot, why: string): void {
    if (r.policy.armed || r.armWait) {
      r.policy = disarmState(r.policy, why, this.host.now()).state
      this.afterDisarm(r, [], why)
    }
    this.unspawn(r)
    this.robots.delete(r.id)
  }

  private unspawn(r: Robot): void {
    if (r.cal) { r.cal.c.abort(); r.cal.resolve(`${r.id}: calibration stopped (${r.cal.joint})`); r.cal = null }
    if (r.body !== null) this.host.send({ c: 'robotRemove', id: r.body })
    r.body = null
    r.at = null
    r.setpoint = null
  }

  private breakLease(r: Robot, cause: string, now: number): void {
    r.lease?.abort()
    const d = r.policy.armed || r.policy.armNonce !== null ? tetherBroken(r.policy, now) : { state: { ...r.policy, lease: null }, broadcast: [] as readonly string[] }
    r.policy = d.state
    this.afterDisarm(r, d.broadcast, cause)
  }

  /** DISARM from our side: the gate's state, the lines out, the lease broken. */
  private sendDisarm(r: Robot, cause: string, breakLease: boolean): void {
    const d = disarmState(r.policy, cause, this.host.now())
    r.policy = d.state
    if (breakLease) r.lease?.abort()
    this.afterDisarm(r, d.broadcast, cause)
  }

  /** After any disarm: the broadcast lines go out, the door is told, the arm wait and the calibration end. */
  private afterDisarm(r: Robot, broadcast: readonly string[], cause: string): void {
    r.lease = null
    r.policy = { ...r.policy, lease: null }
    for (const line of broadcast) this.sendOut(r, line.trim(), { t: 'disarm', id: r.id, cause: line.trim().split(/\s+/)[1] ?? cause })
    if (r.door === 'hal') { this.host.hal.markArmed(r.id, false); this.host.hal.clearSetpoint(r.id) }
    if (r.armWait) { clearTimeout(r.armWait.timer); r.armWait.resolve(`${r.id}: arm ended: ${cause}`); r.armWait = null }
    if (r.cal) { r.cal.c.abort(); r.cal.resolve(`${r.id}: calibration stopped: ${cause}`); r.cal = null }
    this.note(`${r.id}: disarmed (${cause})`)
  }

  /** A control line (ARM, DISARM) to the robot's door: the HAL line, or the relay message. */
  private sendOut(r: Robot, line: string, relay: RelayMessage): void {
    if (r.door === 'hal') { if (!this.host.hal.sendLine(r.id, `${line}\n`)) this.note(`${r.id}: the line '${line}' was not sent (queue full or not ready)`) } else if (r.door === 'relay') this.relaySend(relay)
  }

  private relaySend(m: RelayMessage): void {
    const ws = this.socket
    if (!ws || ws.readyState !== 1) return
    try { ws.send(JSON.stringify(m)) } catch { /* the close follows */ }
  }

  /** The leader's body as setpoints for the robot, through the gate, decimated; a held setpoint re-sent. */
  private sendSetpoints(r: Robot, now: number): void {
    const period = r.transport === 'bluetooth' ? ROBOT_LINK.blePeriodMs : ROBOT_LINK.periodMs
    const key = r.q.map((v) => v.toFixed(4)).join(',')
    const since = now - r.lastSentAt
    if (since < period) return
    if (key === r.lastSentKey && since < ROBOT_LINK.resendMs) return
    const seq = ++r.seq
    const { targets } = clampTargets(r.manifest, { seq, issuedAt: now, ttlMs: ROBOT_LINK.ttlMs, q: [...r.q], qd: [...r.qd], tau: [] })
    const a = admit(r.policy, { kind: 'joints', capability: 'servo', seq, issuedAt: now, ttlMs: ROBOT_LINK.ttlMs, q: targets.q, qd: targets.qd, tau: targets.tau }, now)
    r.policy = a.state
    if (!a.ok) {
      r.refusals++
      if (a.broadcast.length) this.afterDisarm(r, a.broadcast, a.refused)
      return
    }
    r.lastSentAt = now
    r.lastSentKey = key
    r.rtt.send(seq, now)
    if (r.door === 'hal') {
      const line = frameLine('targets', targets, LINE.maxLine)
      if (line) this.host.hal.sendSetpoint(r.id, line)
      else this.note(`${r.id}: the setpoints do not fit a HAL/1 line`)
    } else this.relaySend({ t: 'targets', id: r.id, setpoints: targets })
  }

  private tickCalibration(r: Robot, now: number): void {
    const cal = r.cal!
    // The robot's own answer: its frames; for a sim robot the body's reading (the realm is the robot).
    const f = r.door === 'sim' ? null : r.frame
    const q = r.door === 'sim' ? r.q : f?.q ?? null
    if (!q || q.length !== r.manifest.movable.length) return
    if (r.door === 'sim' && r.bodyAck > 0) r.rtt.echo(r.bodyAck, now)
    const out = cal.c.tick(now, q)
    if (out.targets) r.setpoint = out.targets
    if (!out.results) return
    r.cal = null
    const res = out.results[0]
    if (!res) { cal.resolve(`${r.id}: nothing to calibrate`); return }
    if ('error' in res) { cal.resolve(`${r.id}: calibration of ${res.name} failed: ${res.error}`); return }
    const fit = res.fit
    const returnTrip = Number.isFinite(r.rtt.meanMs) ? r.rtt.meanMs : 0
    r.gains = gainsFor(fit, returnTrip)
    this.sendMode(r)
    cal.resolve(`${r.id}: ${res.name}: delay ${fmt(fit.deadTimeMs, 0)} ms (return trip ${fmt(returnTrip, 0)} ms), τ ${fmt(fit.timeConstantMs, 0)} ms, gain ${fmt(fit.gain, 2)}, rmse ${fmt(fit.rmse, 4)}${fit.settled ? '' : ', not settled'} · twin: ${r.gains.delaySteps} step(s) back, τ ${fmt(r.gains.tauMs, 0)} ms`)
  }

  /** The bodies' slots out of the joint buffer, into each robot. */
  private readBodies(): void {
    const n = this.host.joints.snapshot(this.snapshot)
    if (n < 0) return
    const seen = new Set<number>()
    for (let i = 0; i < n; i++) {
      const v = slotView(this.snapshot, i)
      if (!v) continue
      seen.add(v.id)
      for (const r of this.robots.values()) {
        if (r.body !== v.id) continue
        if (v.joints !== r.q.length) continue
        for (let k = 0; k < v.joints; k++) { r.q[k] = v.q[k]; r.qd[k] = v.qd[k]; r.tau[k] = v.tau[k] }
        r.at = [v.poses[0], v.poses[1], v.poses[2]]
        r.holding = (v.flags & JOINT_FLAG.holding) !== 0
        r.bodyAck = v.ack
      }
    }
  }

  private relayRobots(): Robot[] {
    return [...this.robots.values()].filter((r) => r.door === 'relay')
  }

  private readRelay(data: unknown): RelayMessage | null {
    if (typeof data !== 'string' || data.length > ROBOT_LINK.maxMessage) return null
    let m: unknown
    try { m = JSON.parse(data) } catch { return null }
    return isRecord(m) && typeof m.t === 'string' ? (m as RelayMessage) : null
  }

  private relayRobot(entry: unknown): void {
    if (!isRecord(entry) || typeof entry.id !== 'string' || !/^[\w./:-]{1,96}$/.test(entry.id) || entry.id.startsWith('hal:') || entry.id.startsWith('sim:')) return
    const man = entry.manifest
    if (!isRecord(man)) return
    const judged = buildManifest(man.robot, Array.isArray(man.links) ? man.links : [], Array.isArray(man.joints) ? man.joints : [])
    if (!judged.ok) { this.note(`${entry.id}: manifest refused: ${judged.reason}`); return }
    const caps = isRecord(entry.caps) ? parseCapabilities(`CAPS 1 ${JSON.stringify(entry.caps)}`) : null
    this.announce(entry.id, 'relay', judged.value, caps && !('error' in caps) ? caps : LEGACY_CAPABILITIES, typeof entry.via === 'string' ? entry.via : 'relay')
  }

  private onRelay(m: RelayMessage): void {
    const now = this.host.now()
    if (m.t === 'hello') {
      if (Array.isArray(m.robots)) for (const e of m.robots) this.relayRobot(e)
      return
    }
    if (m.t === 'robot') {
      if (m.gone === true && typeof m.id === 'string') { const r = this.robots.get(m.id); if (r && r.door === 'relay') this.drop(r, 'gone'); return }
      this.relayRobot(m)
      return
    }
    if (m.t === 'refused') { this.note(`relay refused ${typeof m.id === 'string' ? m.id : ''}: ${typeof m.why === 'string' ? m.why : '?'}`.replace('  ', ' ')); return }
    if (typeof m.id !== 'string') return
    const r = this.robots.get(m.id)
    if (!r || r.door !== 'relay') return
    if (m.t === 'state') {
      const f = checkFrame(r.manifest.movable.length, m.frame)
      if (f.ok) this.onDoor(r, { kind: 'frame', id: r.id, frame: f.value, at: now }, now)
      return
    }
    if (m.t === 'armed' && typeof m.nonce === 'string') return this.onDoor(r, { kind: 'armed', id: r.id, nonce: m.nonce }, now)
    if (m.t === 'beat') return this.onDoor(r, { kind: 'beat', id: r.id, n: typeof m.n === 'number' ? m.n : 0 }, now)
    if (m.t === 'ack' && typeof m.seq === 'number') return this.onDoor(r, { kind: 'ack', id: r.id, seq: m.seq }, now)
    if (m.t === 'disarm') return this.onDoor(r, { kind: 'disarm', id: r.id, cause: typeof m.cause === 'string' ? m.cause : 'relay' }, now)
  }

  /** The one socket this bridge ever opens: for a URL netServer admits (the gate), else the refusal. */
  private openSocket(url: string, protocols: string[]): SocketLike {
    if (this.host.connect) return this.host.connect(url, protocols)
    if (netServer(url) === null) throw new Error(refusal(url))
    return new WebSocket(url, protocols) as unknown as SocketLike
  }
}

/** The page's fetch under the air gap: a URL on this machine, read as text. */
async function defaultFetchText(url: string): Promise<string> {
  const f = loopbackFetch((u: string, init?: RequestInit) => fetch(u, init))
  const res = await f(url)
  if (!res.ok) throw new Error(`${url}: ${res.status}`)
  return res.text()
}
