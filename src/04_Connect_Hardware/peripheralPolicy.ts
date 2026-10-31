// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the draft gate for peripherals that can move things in the real world: a
 * microcontroller driving a light, a servo or a motor, and an aerial drone. HAL/1 today only feeds devices telemetry
 * ("a device cannot steer the city"); this is the policy that has to say yes before the city may send anything that
 * actuates. It is pure and deterministic (the clock is an argument, nothing is imported), so every refusal can be
 * proved in Node. The HAL bus itself keeps no policy state: the page's robot bridge (robotLink.ts) runs this gate for
 * the joint bridge's setpoints (docs/joint-bridge-spec.md §4); docs/hal-peripherals-spec.md is the specification.
 *
 * Default deny. Telemetry in is always allowed. Anything out needs, in order: no Ring-0 lock, a capability the device
 * declared and the handshake accepted, the operator tier, a live Spatial Lease, an explicit arming handshake, a fresh
 * heartbeat, a sequence number above the last one, a command still inside its short time-to-live, room under the rate
 * limit and, for a drone, a setpoint inside the geofence, under the ceiling, under the speed cap and within range of
 * the operator. Payload release, projectile and aiming capabilities are refused at the handshake, for the session:
 * no later state can admit them. A Ring-0 panic latches the lock; a panic, a broken tether or a lost heartbeat
 * disarms at once and broadcasts DISARM (a drone's failsafe is to hold and land where it is, never to fly back).
 * What breaks if it is removed? The joint bridge has no gate: robotLink.ts could not arm a robot or admit a setpoint
 * with every refusal proved, and a future driver for any other actuating device would have none either.
 */

/** The HAL/1 extension this policy reads: `CAPS <version> <json>` after READY. */
export const CAPS_VERSION = 1

export type DeviceClass = 'sensor' | 'actuator' | 'drone'

/** Actuation kinds a device may declare; anything else is refused at the handshake. */
export const ACTUATION_ALLOWED: Readonly<Record<DeviceClass, readonly string[]>> = Object.freeze({
  sensor: Object.freeze([]),
  actuator: Object.freeze(['light', 'display', 'haptic', 'servo', 'motor']),
  drone: Object.freeze(['flight', 'light']),
})

/** Capability names that are never admitted, whatever the class, tier or lease (the pacifist rule). */
const NEVER = /payload|projectile|launch|dispens|spray|(^|[_-])(release|drop|aim|aiming|fire)([_-]|$)/i

export const POLICY = Object.freeze({
  /** Longest a command may live, ms, from when the host issued it. */
  maxTtlMs: 250,
  /** Heartbeat (`BEAT`) older than this disarms, ms. */
  watchdogMs: 500,
  /** Commands per device per rolling second. */
  maxRatePerSecond: 20,
  /** Audit entries kept (oldest dropped). */
  auditLength: 256,
  /** A drone's host-side limits; the device's own declared limits can only lower them. */
  drone: Object.freeze({ ceilingM: 30, speedMs: 5, rangeM: 50 }),
})

export interface DroneLimits { ceilingM: number; speedMs: number; rangeM: number }

export interface RefusedCapability { name: string; reason: 'never' | 'not-allowed-for-class' }

export interface Capabilities {
  version: number
  deviceClass: DeviceClass
  telemetry: readonly string[]
  /** Accepted actuation kinds. */
  actuation: readonly string[]
  /** Refused at the handshake: never admitted in this session. */
  refused: readonly RefusedCapability[]
  /** A drone's declared limits (already lowered to POLICY.drone). */
  limits?: DroneLimits
}

/** A device that sends no CAPS line (every HAL/1 gadget today): telemetry only. */
export const LEGACY_CAPABILITIES: Capabilities = Object.freeze({ version: 0, deviceClass: 'sensor', telemetry: Object.freeze([]), actuation: Object.freeze([]), refused: Object.freeze([]) })

const CLASSES: readonly DeviceClass[] = ['sensor', 'actuator', 'drone']
const NAME = /^[a-z][a-z0-9_-]{0,31}$/

const names = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string').map((s) => s.toLowerCase()) : [])
const positive = (v: unknown, cap: number) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.min(v, cap) : cap)

/**
 * Reads a `CAPS 1 {"class":"drone","telemetry":[…],"actuation":[…],"limits":{…}}` line. Null when the line is not a
 * CAPS line; an error string when it is one this host cannot accept (unknown version, bad JSON, unknown class).
 */
export function parseCapabilities(line: string): Capabilities | { error: string } | null {
  const m = /^CAPS[ \t]+(\d+)[ \t]+(.*)$/.exec(line.trim())
  if (!m) return null
  const version = Number(m[1])
  if (version !== CAPS_VERSION) return { error: `CAPS version ${version} is not supported (this host reads ${CAPS_VERSION})` }
  let body: unknown
  try { body = JSON.parse(m[2]) } catch { return { error: 'CAPS body is not JSON' } }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'CAPS body is not an object' }
  const b = body as Record<string, unknown>
  const deviceClass = CLASSES.find((c) => c === b.class)
  if (!deviceClass) return { error: `unknown device class ${JSON.stringify(b.class)}` }
  const actuation: string[] = []
  const refused: RefusedCapability[] = []
  for (const name of new Set(names(b.actuation))) {
    if (NEVER.test(name) || !NAME.test(name)) refused.push({ name, reason: 'never' })
    else if (!ACTUATION_ALLOWED[deviceClass].includes(name)) refused.push({ name, reason: 'not-allowed-for-class' })
    else actuation.push(name)
  }
  const caps: Capabilities = { version, deviceClass, telemetry: [...new Set(names(b.telemetry))].filter((n) => NAME.test(n)), actuation, refused }
  if (deviceClass === 'drone') {
    const l = (typeof b.limits === 'object' && b.limits !== null ? b.limits : {}) as Record<string, unknown>
    caps.limits = { ceilingM: positive(l.ceilingM, POLICY.drone.ceilingM), speedMs: positive(l.speedMs, POLICY.drone.speedMs), rangeM: positive(l.rangeM, POLICY.drone.rangeM) }
  }
  return caps
}

/** Metres, world axes (x east, z south); altitude above the ground. */
export interface Geofence { minX: number; maxX: number; minZ: number; maxZ: number }

export type AuditEvent = 'admitted' | 'refused' | 'armed' | 'disarmed' | 'locked'
export interface AuditEntry { at: number; event: AuditEvent; detail: string }

export interface PolicyState {
  readonly caps: Capabilities
  /** The operator tier is unlocked (Ring-0 terminal, `operator unlock`). */
  readonly operator: boolean
  /** The Spatial Lease of the task this device serves (taskRouter's Lease fits); null: none. */
  readonly lease: { readonly signal: { readonly aborted: boolean } } | null
  /** The nonce the host sent in ARM, until the device echoes it. */
  readonly armNonce: string | null
  readonly armed: boolean
  /** A Ring-0 panic: nothing is ever admitted again in this session. */
  readonly locked: boolean
  readonly lastSeq: number
  readonly lastBeat: number
  /** When admitted commands were issued, within the last second. */
  readonly recent: readonly number[]
  readonly geofence: Geofence | null
  /** The operator's position (x, z), m. */
  readonly operatorAt: { x: number; z: number } | null
  /** The robot's movable joint count, the length of a 'joints' command's arrays (0: no manifest, so no joint positions). */
  readonly joints: number
  readonly audit: readonly AuditEntry[]
}

export function initialState(caps: Capabilities, now: number, joints = 0): PolicyState {
  return { caps, operator: false, lease: null, armNonce: null, armed: false, locked: false, lastSeq: 0, lastBeat: now, recent: [], geofence: null, operatorAt: null, joints, audit: [] }
}

export type Command =
  | { kind: 'telemetry-in' }
  | { kind: 'actuate'; capability: string; seq: number; issuedAt: number; ttlMs: number; value: number }
  | { kind: 'flight'; seq: number; issuedAt: number; ttlMs: number; setpoint: { x: number; z: number; altitudeM: number; speedMs: number } }
  /** Joint setpoints (jointState.ts JointTargets, for a servo): each array empty or `joints` long, every number finite. */
  | { kind: 'joints'; capability: 'servo'; seq: number; issuedAt: number; ttlMs: number; q: readonly number[]; qd: readonly number[]; tau: readonly number[] }

export type RefusalReason =
  | 'locked' | 'refused-at-handshake' | 'not-declared' | 'no-operator-tier' | 'no-lease' | 'not-armed' | 'heartbeat-lost'
  | 'stale-sequence' | 'expired' | 'rate-limited' | 'non-finite' | 'wrong-length' | 'no-geofence' | 'outside-geofence'
  | 'above-ceiling' | 'over-speed' | 'beyond-range'

export type Admission =
  | { ok: true; state: PolicyState }
  | { ok: false; refused: RefusalReason; state: PolicyState; /** Lines to broadcast (a lost heartbeat disarms). */ broadcast: readonly string[] }

function log(s: PolicyState, at: number, event: AuditEvent, detail: string): readonly AuditEntry[] {
  const next = [...s.audit, { at, event, detail }]
  return next.length > POLICY.auditLength ? next.slice(next.length - POLICY.auditLength) : next
}

/** Disarms now and says what to send: DISARM, and for a drone the land-in-place failsafe. */
export function disarm(s: PolicyState, cause: string, now: number): { state: PolicyState; broadcast: readonly string[] } {
  const broadcast = [`DISARM ${cause.replace(/\s+/g, '-')}\n`, ...(s.caps.deviceClass === 'drone' ? ['FAILSAFE LAND\n'] : [])]
  return { state: { ...s, armed: false, armNonce: null, audit: log(s, now, 'disarmed', cause) }, broadcast }
}

/** A Ring-0 panic: disarm and latch the lock for the rest of the session. */
export function ring0Panic(s: PolicyState, now: number): { state: PolicyState; broadcast: readonly string[] } {
  const d = disarm(s, 'ring0-panic', now)
  return { state: { ...d.state, locked: true, audit: log(d.state, now, 'locked', 'ring0-panic') }, broadcast: d.broadcast }
}

/** The tether broke (the lease aborted): disarm. */
export function tetherBroken(s: PolicyState, now: number): { state: PolicyState; broadcast: readonly string[] } {
  return disarm({ ...s, lease: null }, 'tether-broken', now)
}

/** Starts the arming handshake: the host sends `ARM <nonce>`. Null while anything but the sequence would refuse. */
export function requestArm(s: PolicyState, nonce: string, now: number): { state: PolicyState; line: string } | { refused: RefusalReason } {
  if (s.locked) return { refused: 'locked' }
  if (s.caps.actuation.length === 0) return { refused: 'not-declared' }
  if (!s.operator) return { refused: 'no-operator-tier' }
  if (!s.lease || s.lease.signal.aborted) return { refused: 'no-lease' }
  if (s.caps.deviceClass === 'drone' && !s.geofence) return { refused: 'no-geofence' }
  return { state: { ...s, armNonce: nonce, armed: false, lastBeat: now }, line: `ARM ${nonce}\n` }
}

/** The device answered `ARMED <nonce>`: armed only if it echoes the nonce of the pending request. */
export function confirmArm(s: PolicyState, echoed: string, now: number): PolicyState {
  if (s.locked || s.armNonce === null || echoed !== s.armNonce) return s
  return { ...s, armed: true, armNonce: null, lastBeat: now, audit: log(s, now, 'armed', s.caps.deviceClass) }
}

/** A `BEAT` from the device. */
export function heartbeat(s: PolicyState, now: number): PolicyState {
  return { ...s, lastBeat: now }
}

/** Run on every host tick: a lost heartbeat or an aborted lease while armed disarms. */
export function watchdog(s: PolicyState, now: number): { state: PolicyState; broadcast: readonly string[] } {
  if (!s.armed) return { state: s, broadcast: [] }
  if (!s.lease || s.lease.signal.aborted) return tetherBroken(s, now)
  if (now - s.lastBeat > POLICY.watchdogMs) return disarm(s, 'heartbeat-lost', now)
  return { state: s, broadcast: [] }
}

const finite = (...v: number[]) => v.every(Number.isFinite)

/** The gate. Pure: the state it returns carries the new sequence, the rate window and the audit entry. */
export function admit(s: PolicyState, c: Command, now: number): Admission {
  if (c.kind === 'telemetry-in') return { ok: true, state: s }
  const refuse = (refused: RefusalReason, state: PolicyState = s, broadcast: readonly string[] = []): Admission =>
    ({ ok: false, refused, state: { ...state, audit: log(state, now, 'refused', refused) }, broadcast })
  if (s.locked) return refuse('locked')
  const capability = c.kind === 'flight' ? 'flight' : c.capability.toLowerCase()
  if (s.caps.refused.some((r) => r.name === capability) || NEVER.test(capability)) return refuse('refused-at-handshake')
  // Joint setpoints drive a servo and nothing else: another capability on a 'joints' command is not declared for it.
  if (!s.caps.actuation.includes(capability) || (c.kind === 'joints' && capability !== 'servo')) return refuse('not-declared')
  if (!s.operator) return refuse('no-operator-tier')
  if (!s.lease || s.lease.signal.aborted) {
    const d = s.armed ? tetherBroken(s, now) : { state: s, broadcast: [] }
    return refuse('no-lease', d.state, d.broadcast)
  }
  if (!s.armed) return refuse('not-armed')
  if (now - s.lastBeat > POLICY.watchdogMs) {
    const d = disarm(s, 'heartbeat-lost', now)
    return refuse('heartbeat-lost', d.state, d.broadcast)
  }
  if (!Number.isSafeInteger(c.seq) || c.seq <= s.lastSeq) return refuse('stale-sequence')
  if (!finite(c.issuedAt, c.ttlMs) || c.ttlMs <= 0 || c.ttlMs > POLICY.maxTtlMs || c.issuedAt > now || now - c.issuedAt > c.ttlMs) return refuse('expired')
  const recent = s.recent.filter((t) => now - t < 1000)
  if (recent.length >= POLICY.maxRatePerSecond) return refuse('rate-limited')
  if (c.kind === 'actuate') {
    if (!finite(c.value)) return refuse('non-finite')
  } else if (c.kind === 'joints') {
    // Each array speaks for every movable joint, or for none: a shorter or longer one would move the wrong joints.
    for (const a of [c.q, c.qd, c.tau]) {
      if (!Array.isArray(a) || (a.length !== 0 && a.length !== s.joints)) return refuse('wrong-length')
    }
    if (!finite(...c.q, ...c.qd, ...c.tau)) return refuse('non-finite')
  } else {
    const p = c.setpoint
    if (!finite(p.x, p.z, p.altitudeM, p.speedMs)) return refuse('non-finite')
    const f = s.geofence
    const lim = s.caps.limits ?? POLICY.drone
    if (!f) return refuse('no-geofence')
    if (p.x < f.minX || p.x > f.maxX || p.z < f.minZ || p.z > f.maxZ || p.altitudeM < 0) return refuse('outside-geofence')
    if (p.altitudeM > lim.ceilingM) return refuse('above-ceiling')
    if (p.speedMs < 0 || p.speedMs > lim.speedMs) return refuse('over-speed')
    if (!s.operatorAt || Math.hypot(p.x - s.operatorAt.x, p.z - s.operatorAt.z) > lim.rangeM) return refuse('beyond-range')
  }
  const state: PolicyState = { ...s, lastSeq: c.seq, recent: [...recent, now], audit: log(s, now, 'admitted', `${capability} #${c.seq}`) }
  return { ok: true, state }
}
