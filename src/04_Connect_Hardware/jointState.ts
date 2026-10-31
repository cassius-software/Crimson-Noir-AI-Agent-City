// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the vocabulary of the joint bridge, the one language every door of it speaks: a
 * robot's manifest (its links and joints as a URDF describes them: six joint kinds, parent and child, origin, axis,
 * limits, dynamics), the joint state frame (q, q̇, τ: the positions in rad or m, the velocities in rad/s or m/s, the
 * efforts in N·m or N, every array the length of the robot's movable joints or empty, each joint known by its index,
 * as a ROS JointState message is read), the targets the city may send back (the same three arrays with a sequence
 * number, an issue time and a time to live, so the peripheral gate can judge each one), and the HAL/1 extension lines
 * that carry them over a serial or Bluetooth link (`JOINTS` for the manifest, in numbered parts when it is longer than
 * a line, `JS` for a state frame, `JT` for targets). It checks what arrives (lengths, finiteness, the tree of links:
 * one root, one parent per link, every link reached) and clamps what leaves to the manifest's own limits. It is pure:
 * no DOM, no clock, no import, so every rule is proved in Node and the relay and the page read the same words.
 * What breaks if it is removed? The URDF reader, the serial door, the relay and the realm have no common shape for a
 * joint vector, and nothing checks a frame before it moves a body.
 */

/** URDF's six joint kinds. Only the first three have a scalar state (an entry in q); the rest are held or refused. */
export type JointKind = 'revolute' | 'continuous' | 'prismatic' | 'fixed' | 'floating' | 'planar'
export const JOINT_KINDS: readonly JointKind[] = Object.freeze(['revolute', 'continuous', 'prismatic', 'fixed', 'floating', 'planar'])
/** Kinds with one number of state: revolute and continuous (rad), prismatic (m). */
export const SCALAR_KINDS: readonly JointKind[] = Object.freeze(['revolute', 'continuous', 'prismatic'])

export type Vec3 = readonly [number, number, number]
/** A pose as URDF's `<origin>`: a translation and fixed-axis roll, pitch, yaw (rad). */
export interface Pose { readonly xyz: Vec3; readonly rpy: Vec3 }
export const ORIGIN: Pose = Object.freeze({ xyz: Object.freeze([0, 0, 0]) as Vec3, rpy: Object.freeze([0, 0, 0]) as Vec3 })

/** A link's shape for the realm's collider; a mesh (which the realm cannot load) or no geometry is `none`. */
export type Shape =
  | { readonly kind: 'box'; readonly size: Vec3 }
  | { readonly kind: 'cylinder'; readonly radius: number; readonly length: number }
  | { readonly kind: 'capsule'; readonly radius: number; readonly length: number }
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'none' }

export interface LinkSpec {
  readonly name: string
  /** kg from `<inertial><mass>`; 0 when the file gave none (the realm then uses its own default). */
  readonly mass: number
  readonly shape: Shape
  /** Where the shape sits in the link's frame. */
  readonly shapeOrigin: Pose
}

export interface Mimic { readonly joint: string; readonly multiplier: number; readonly offset: number }

export interface JointSpec {
  readonly name: string
  readonly kind: JointKind
  readonly parent: string
  readonly child: string
  /** The child's frame in the parent's, at q = 0. */
  readonly origin: Pose
  /** Unit axis in the joint (child) frame; meaningless for fixed and floating. */
  readonly axis: Vec3
  /** rad or m; 0 and 0 for a continuous joint; the file's own numbers for revolute and prismatic. */
  readonly lower: number
  readonly upper: number
  /** The effort cap (N·m or N) and the speed cap (rad/s or m/s); 0 when the kind has no `<limit>`. */
  readonly effort: number
  readonly velocity: number
  /** N·m·s/rad or N·s/m, and N·m or N. */
  readonly damping: number
  readonly friction: number
  /** Recorded as the file gave it; the realm does not apply it (said in the manual). */
  readonly mimic?: Mimic
}

export interface Manifest {
  readonly robot: string
  readonly links: readonly LinkSpec[]
  /** In document order. */
  readonly joints: readonly JointSpec[]
  /** The one link no joint has as its child. */
  readonly root: string
  /** Indices into `joints` of the scalar-state joints, in order: the order of q, q̇ and τ. */
  readonly movable: readonly number[]
}

/** Most joints a manifest may carry (the realm's and the shared buffer's bound) and most robots at once. */
export const MAX_JOINTS = 64
export const MAX_ROBOTS = 4
/**
 * What the realm will build (checked by `buildable` before any physics call): a tree of revolute, continuous,
 * prismatic and fixed joints within these bounds. A floating or planar joint is read and kept in the manifest but
 * the realm refuses to build it. Masses in kg, lengths in m, effort in N·m or N, velocity in rad/s or m/s.
 */
export const REALM_BOUNDS = Object.freeze({
  kinds: Object.freeze(['revolute', 'continuous', 'prismatic', 'fixed']) as readonly JointKind[],
  mass: 500,
  extent: 3,
  offset: 3,
  effort: 1e4,
  velocity: 100,
  range: 1000,
})
/** Names (robot, link, joint): printable ASCII without the characters MQTT topics and HAL/1 lines reserve. */
const NAME = /^[\x21-\x7e]{1,64}$/
const NAME_RESERVED = /[+#/\s"\\]/
export function validName(s: unknown): s is string {
  return typeof s === 'string' && NAME.test(s) && !NAME_RESERVED.test(s)
}

const finite = (...n: unknown[]): boolean => n.every((x) => typeof x === 'number' && Number.isFinite(x))
const isVec3 = (v: unknown): v is Vec3 => Array.isArray(v) && v.length === 3 && finite(...v)
const isPose = (p: unknown): p is Pose => typeof p === 'object' && p !== null && isVec3((p as Pose).xyz) && isVec3((p as Pose).rpy)
const norm = (v: Vec3): Vec3 | null => {
  const l = Math.hypot(v[0], v[1], v[2])
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : null
}

export type Checked<T> = { ok: true; value: T } | { ok: false; reason: string }
const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** The one place a manifest is judged: a URDF the reader parsed, or JSON a door received, both come through here. */
export function buildManifest(robot: unknown, links: readonly unknown[], joints: readonly unknown[]): Checked<Manifest> {
  if (!validName(robot)) return bad('the robot needs a name (printable ASCII, no spaces, 1 to 64 characters)')
  if (links.length === 0) return bad('a robot needs at least one link')
  if (links.length > MAX_JOINTS + 1) return bad(`too many links (${links.length}; at most ${MAX_JOINTS + 1})`)
  if (joints.length > MAX_JOINTS) return bad(`too many joints (${joints.length}; at most ${MAX_JOINTS})`)
  const linkNames = new Set<string>()
  const outLinks: LinkSpec[] = []
  for (const l of links) {
    const c = checkLink(l)
    if (!c.ok) return c
    if (linkNames.has(c.value.name)) return bad(`link '${c.value.name}' is declared twice`)
    linkNames.add(c.value.name)
    outLinks.push(c.value)
  }
  const jointNames = new Set<string>()
  const parentOf = new Map<string, string>()
  const outJoints: JointSpec[] = []
  for (const j of joints) {
    const c = checkJoint(j)
    if (!c.ok) return c
    const s = c.value
    if (jointNames.has(s.name)) return bad(`joint '${s.name}' is declared twice`)
    jointNames.add(s.name)
    if (!linkNames.has(s.parent)) return bad(`joint '${s.name}': parent link '${s.parent}' is not declared`)
    if (!linkNames.has(s.child)) return bad(`joint '${s.name}': child link '${s.child}' is not declared`)
    if (s.parent === s.child) return bad(`joint '${s.name}' joins link '${s.child}' to itself`)
    if (parentOf.has(s.child)) return bad(`link '${s.child}' has two parents (joints '${parentOf.get(s.child)}' and '${s.name}')`)
    parentOf.set(s.child, s.parent)
    outJoints.push(s)
  }
  for (const s of outJoints) {
    if (s.mimic && !jointNames.has(s.mimic.joint)) return bad(`joint '${s.name}' mimics '${s.mimic.joint}', which is not declared`)
  }
  const roots = outLinks.filter((l) => !parentOf.has(l.name))
  if (roots.length !== 1) return bad(roots.length === 0 ? 'the links form a loop: no root link' : `more than one root link (${roots.map((r) => `'${r.name}'`).join(', ')}): one tree per robot`)
  const root = roots[0].name
  // Every link must hang from the root (a loop off to the side has no root of its own and would pass the count).
  const reached = new Set<string>([root])
  let grew = true
  while (grew) {
    grew = false
    for (const [child, parent] of parentOf) {
      if (!reached.has(child) && reached.has(parent)) { reached.add(child); grew = true }
    }
  }
  for (const l of outLinks) if (!reached.has(l.name)) return bad(`link '${l.name}' is not reached from the root '${root}'`)
  const movable: number[] = []
  outJoints.forEach((j, i) => { if (SCALAR_KINDS.includes(j.kind)) movable.push(i) })
  return { ok: true, value: Object.freeze({ robot, links: Object.freeze(outLinks), joints: Object.freeze(outJoints), root, movable: Object.freeze(movable) }) }
}

function checkShape(s: unknown): Checked<Shape> {
  if (typeof s !== 'object' || s === null) return bad('a link shape must be an object')
  const o = s as { kind?: unknown; size?: unknown; radius?: unknown; length?: unknown }
  switch (o.kind) {
    case 'none': return { ok: true, value: { kind: 'none' } }
    case 'box': return isVec3(o.size) && o.size.every((x) => x > 0) ? { ok: true, value: { kind: 'box', size: [o.size[0], o.size[1], o.size[2]] } } : bad('a box needs a positive size')
    case 'sphere': return finite(o.radius) && (o.radius as number) > 0 ? { ok: true, value: { kind: 'sphere', radius: o.radius as number } } : bad('a sphere needs a positive radius')
    case 'cylinder':
    case 'capsule':
      return finite(o.radius, o.length) && (o.radius as number) > 0 && (o.length as number) > 0
        ? { ok: true, value: { kind: o.kind, radius: o.radius as number, length: o.length as number } }
        : bad(`a ${o.kind} needs a positive radius and length`)
    default: return bad(`unknown shape kind '${String(o.kind)}'`)
  }
}

function checkLink(l: unknown): Checked<LinkSpec> {
  if (typeof l !== 'object' || l === null) return bad('a link must be an object')
  const o = l as { name?: unknown; mass?: unknown; shape?: unknown; shapeOrigin?: unknown }
  if (!validName(o.name)) return bad(`a link needs a name (got ${JSON.stringify(o.name ?? null)})`)
  const mass = o.mass === undefined ? 0 : o.mass
  if (!finite(mass) || (mass as number) < 0) return bad(`link '${o.name}': the mass must be a finite number of kg, 0 or more`)
  const shape = o.shape === undefined ? { ok: true as const, value: { kind: 'none' as const } } : checkShape(o.shape)
  if (!shape.ok) return bad(`link '${o.name}': ${shape.reason}`)
  const origin = o.shapeOrigin === undefined ? ORIGIN : o.shapeOrigin
  if (!isPose(origin)) return bad(`link '${o.name}': the shape origin needs xyz and rpy`)
  return { ok: true, value: { name: o.name, mass: mass as number, shape: shape.value, shapeOrigin: { xyz: [...origin.xyz] as unknown as Vec3, rpy: [...origin.rpy] as unknown as Vec3 } } }
}

function checkJoint(j: unknown): Checked<JointSpec> {
  if (typeof j !== 'object' || j === null) return bad('a joint must be an object')
  const o = j as Record<string, unknown>
  if (!validName(o.name)) return bad(`a joint needs a name (got ${JSON.stringify(o.name ?? null)})`)
  const name = o.name
  if (!JOINT_KINDS.includes(o.kind as JointKind)) return bad(`joint '${name}' has no known type (${JSON.stringify(o.kind ?? null)}; one of ${JOINT_KINDS.join(', ')})`)
  const kind = o.kind as JointKind
  if (!validName(o.parent)) return bad(`joint '${name}' names no parent link`)
  if (!validName(o.child)) return bad(`joint '${name}' names no child link`)
  const origin = o.origin === undefined ? ORIGIN : o.origin
  if (!isPose(origin)) return bad(`joint '${name}': the origin needs xyz and rpy`)
  const rawAxis = o.axis === undefined ? ([1, 0, 0] as Vec3) : o.axis
  if (!isVec3(rawAxis)) return bad(`joint '${name}': the axis needs three numbers`)
  const axis = norm(rawAxis)
  if (!axis) return bad(`joint '${name}': the axis is the zero vector`)
  const limited = kind === 'revolute' || kind === 'prismatic'
  const lower = o.lower === undefined ? 0 : o.lower, upper = o.upper === undefined ? 0 : o.upper
  const effort = o.effort === undefined ? 0 : o.effort, velocity = o.velocity === undefined ? 0 : o.velocity
  if (!finite(lower, upper, effort, velocity)) return bad(`joint '${name}': lower, upper, effort and velocity must be finite numbers`)
  if (limited) {
    if (o.effort === undefined || o.velocity === undefined) return bad(`joint '${name}' is ${kind} but its limit has no effort or no velocity`)
    if ((lower as number) > (upper as number)) return bad(`joint '${name}': lower ${lower} is above upper ${upper}`)
    if ((effort as number) < 0 || (velocity as number) < 0) return bad(`joint '${name}': effort and velocity caps cannot be negative`)
  }
  const damping = o.damping === undefined ? 0 : o.damping, friction = o.friction === undefined ? 0 : o.friction
  if (!finite(damping, friction) || (damping as number) < 0 || (friction as number) < 0) return bad(`joint '${name}': damping and friction must be finite and 0 or more`)
  let mimic: Mimic | undefined
  if (o.mimic !== undefined) {
    const m = o.mimic as { joint?: unknown; multiplier?: unknown; offset?: unknown } | null
    if (typeof m !== 'object' || m === null || !validName(m.joint)) return bad(`joint '${name}': a mimic names the joint it follows`)
    const multiplier = m.multiplier === undefined ? 1 : m.multiplier, offset = m.offset === undefined ? 0 : m.offset
    if (!finite(multiplier, offset)) return bad(`joint '${name}': the mimic's multiplier and offset must be finite`)
    mimic = { joint: m.joint, multiplier: multiplier as number, offset: offset as number }
  }
  const spec: JointSpec = {
    name, kind, parent: o.parent, child: o.child,
    origin: { xyz: [...origin.xyz] as unknown as Vec3, rpy: [...origin.rpy] as unknown as Vec3 }, axis,
    lower: limited ? (lower as number) : 0, upper: limited ? (upper as number) : 0,
    effort: limited ? (effort as number) : (finite(effort) ? (effort as number) : 0), velocity: limited ? (velocity as number) : (finite(velocity) ? (velocity as number) : 0),
    damping: damping as number, friction: friction as number,
  }
  return { ok: true, value: mimic ? { ...spec, mimic } : spec }
}

/** The manifest as it travels (JSON): the same fields, nothing derived. */
export function manifestJson(m: Manifest): string {
  return JSON.stringify({ robot: m.robot, links: m.links, joints: m.joints })
}

/** A manifest received as JSON text: parsed and judged by the same rules as a URDF. */
export function readManifest(text: string): Checked<Manifest> {
  let o: unknown
  try { o = JSON.parse(text) } catch { return bad('the manifest is not JSON') }
  if (typeof o !== 'object' || o === null) return bad('the manifest is not an object')
  const r = o as { robot?: unknown; links?: unknown; joints?: unknown }
  if (!Array.isArray(r.links) || !Array.isArray(r.joints)) return bad('the manifest needs links and joints arrays')
  return buildManifest(r.robot, r.links, r.joints)
}

/** Why the realm would refuse to build this manifest, or null when it fits REALM_BOUNDS. Pure; run before any physics call. */
export function buildable(m: Manifest): string | null {
  const B = REALM_BOUNDS
  const far = (v: Vec3): boolean => Math.hypot(v[0], v[1], v[2]) > B.offset
  for (const l of m.links) {
    if (l.mass > B.mass) return `link '${l.name}': ${l.mass} kg is over the realm's ${B.mass} kg`
    const s = l.shape
    const extent = s.kind === 'box' ? Math.max(...s.size) : s.kind === 'sphere' ? 2 * s.radius : s.kind === 'none' ? 0 : Math.max(2 * s.radius, s.length + (s.kind === 'capsule' ? 2 * s.radius : 0))
    if (extent > B.extent) return `link '${l.name}': a ${s.kind} ${extent.toFixed(2)} m across is over the realm's ${B.extent} m`
    if (far(l.shapeOrigin.xyz)) return `link '${l.name}': its shape sits more than ${B.offset} m from the link`
  }
  for (const j of m.joints) {
    if (!B.kinds.includes(j.kind)) return `joint '${j.name}' is ${j.kind}: the realm builds ${B.kinds.join(', ')} joints`
    if (far(j.origin.xyz)) return `joint '${j.name}' is more than ${B.offset} m from its parent link`
    if (j.effort > B.effort || j.velocity > B.velocity) return `joint '${j.name}': effort ${j.effort} or velocity ${j.velocity} is over the realm's ${B.effort} / ${B.velocity}`
    if (Math.abs(j.lower) > B.range || Math.abs(j.upper) > B.range) return `joint '${j.name}': a limit beyond ±${B.range} is not a limit`
  }
  return null
}

/** One reading of a robot's joints (sensor_msgs/JointState): each array `movable.length` long or empty. */
export interface JointFrame {
  /** When it was read, ms on the sender's own clock (spacing within one sender; never compared with ours). */
  readonly stamp: number
  /** The sender's count, rising. */
  readonly seq: number
  readonly q: readonly number[]
  readonly qd: readonly number[]
  readonly tau: readonly number[]
  /** The seq of the last setpoints the sender applied, when it says: the end-to-end acknowledgement a latency fit needs. */
  readonly ack?: number
}

/** What the city sends a robot: the gate's fields (peripheralPolicy.ts Command) and the three arrays. */
export interface JointTargets {
  readonly seq: number
  readonly issuedAt: number
  readonly ttlMs: number
  readonly q: readonly number[]
  readonly qd: readonly number[]
  readonly tau: readonly number[]
}

const numbers = (a: unknown, n: number, what: string): string | null => {
  if (a === undefined) return null
  if (!Array.isArray(a)) return `${what} is not an array`
  if (a.length !== 0 && a.length !== n) return `${what} has ${a.length} entries for ${n} movable joints`
  for (let i = 0; i < a.length; i++) if (typeof a[i] !== 'number' || !Number.isFinite(a[i])) return `${what}[${i}] is not a finite number`
  return null
}

/** Judges a frame as received (any JSON value) against a robot of `n` movable joints. */
export function checkFrame(n: number, f: unknown): Checked<JointFrame> {
  if (typeof f !== 'object' || f === null) return bad('a frame must be an object')
  const o = f as Record<string, unknown>
  if (!finite(o.stamp) || (o.stamp as number) < 0) return bad('a frame needs a stamp (ms, 0 or more)')
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 0) return bad('a frame needs a whole, non-negative seq')
  for (const k of ['q', 'qd', 'tau'] as const) {
    const why = numbers(o[k], n, k)
    if (why) return bad(why)
  }
  if (o.ack !== undefined && (!Number.isSafeInteger(o.ack) || (o.ack as number) < 0)) return bad('a frame\'s ack is a whole, non-negative seq')
  const arr = (k: 'q' | 'qd' | 'tau'): readonly number[] => Object.freeze([...((o[k] as number[] | undefined) ?? [])])
  const frame: JointFrame = { stamp: o.stamp as number, seq: o.seq as number, q: arr('q'), qd: arr('qd'), tau: arr('tau') }
  return { ok: true, value: Object.freeze(o.ack === undefined ? frame : { ...frame, ack: o.ack as number }) }
}

/** Judges targets as received; the gate's own fields are checked again by the gate. */
export function checkTargets(n: number, t: unknown): Checked<JointTargets> {
  if (typeof t !== 'object' || t === null) return bad('targets must be an object')
  const o = t as Record<string, unknown>
  if (!Number.isSafeInteger(o.seq) || (o.seq as number) < 0) return bad('targets need a whole, non-negative seq')
  if (!finite(o.issuedAt, o.ttlMs) || (o.ttlMs as number) <= 0) return bad('targets need issuedAt (ms) and a positive ttlMs')
  for (const k of ['q', 'qd', 'tau'] as const) {
    const why = numbers(o[k], n, k)
    if (why) return bad(why)
  }
  if (!Array.isArray(o.q) || o.q.length !== n) return bad(`targets need q for all ${n} movable joints`)
  const arr = (k: 'q' | 'qd' | 'tau'): readonly number[] => Object.freeze([...((o[k] as number[] | undefined) ?? [])])
  return { ok: true, value: Object.freeze({ seq: o.seq as number, issuedAt: o.issuedAt as number, ttlMs: o.ttlMs as number, q: arr('q'), qd: arr('qd'), tau: arr('tau') }) }
}

/**
 * Targets held inside the manifest's own limits: a revolute or prismatic position within [lower, upper], a speed
 * within ±velocity and an effort within ±effort where the joint has a cap. Returns how many numbers were changed.
 */
export function clampTargets(m: Manifest, t: JointTargets): { targets: JointTargets; clamped: number } {
  let clamped = 0
  const clip = (v: number, lo: number, hi: number): number => {
    const c = Math.min(hi, Math.max(lo, v))
    if (c !== v) clamped++
    return c
  }
  const q = t.q.map((v, i) => {
    const j = m.joints[m.movable[i]]
    return j.kind === 'continuous' ? v : clip(v, j.lower, j.upper)
  })
  const qd = t.qd.map((v, i) => {
    const j = m.joints[m.movable[i]]
    return j.velocity > 0 ? clip(v, -j.velocity, j.velocity) : v
  })
  const tau = t.tau.map((v, i) => {
    const j = m.joints[m.movable[i]]
    return j.effort > 0 ? clip(v, -j.effort, j.effort) : v
  })
  return { targets: { seq: t.seq, issuedAt: t.issuedAt, ttlMs: t.ttlMs, q, qd, tau }, clamped }
}

/** The HAL/1 extension lines (docs/joint-bridge-spec.md), each ending in '\n' and at most LINE.maxLine bytes. */
export const JOINT_LINE = Object.freeze({
  /** `JOINTS 1 {json}` or `JOINTS 1 <i>/<n> {part}` (parts 1-based), device → host, after READY (and CAPS). */
  manifest: 'JOINTS',
  /** `JS {frame json}`, device → host, at the device's rate; the newest frame wins. */
  state: 'JS',
  /** `JT {targets json}`, host → device, only through the gate. */
  targets: 'JT',
  /** `JA <seq>`, device → host: the setpoints of that seq were applied (a frame's `ack` says the same). */
  ack: 'JA',
  version: 1,
  /** Most parts a manifest may be split into (a 64-joint manifest is about sixteen 1,024-byte parts). */
  maxParts: 64,
  /** A manifest's parts must all arrive within this long, ms. */
  windowMs: 10_000,
  /**
   * Most movable joints a robot on a HAL/1 line may have: a state line with q, q̇ and τ at five figures for 24 joints
   * fits the 1,024-byte line; a bigger robot speaks to the relay.
   */
  halJoints: 24,
} as const)

const utf8 = new TextEncoder()
export const byteLength = (s: string): number => utf8.encode(s).length

/** The manifest as `JOINTS` lines that each fit `maxLine` bytes (with the '\n'); null when it cannot be split that small. */
export function manifestLines(m: Manifest, maxLine: number): string[] | null {
  const json = manifestJson(m)
  const whole = `${JOINT_LINE.manifest} ${JOINT_LINE.version} ${json}\n`
  if (byteLength(whole) <= maxLine) return [whole]
  // The longest head is "JOINTS 1 64/64 " (15 bytes) plus the newline: the body of every part fits under that.
  const room = maxLine - `${JOINT_LINE.manifest} ${JOINT_LINE.version} ${JOINT_LINE.maxParts}/${JOINT_LINE.maxParts} \n`.length
  if (room < 16) return null
  const parts: string[] = []
  // Split on ASCII (the manifest's JSON is ASCII: names are printable ASCII and numbers are numbers), so bytes are chars.
  for (let i = 0; i < json.length; i += room) parts.push(json.slice(i, i + room))
  if (parts.length > JOINT_LINE.maxParts) return null
  return parts.map((p, i) => `${JOINT_LINE.manifest} ${JOINT_LINE.version} ${i + 1}/${parts.length} ${p}\n`)
}

export type JointLine =
  | { kind: 'manifest'; version: number; part: number; parts: number; body: string }
  | { kind: 'state'; body: string }
  | { kind: 'targets'; body: string }
  | { kind: 'ack'; seq: number }

/** Reads one line (without or with its newline); null for a line that is not the bridge's. */
export function parseJointLine(line: string): JointLine | null {
  const s = line.endsWith('\n') ? line.slice(0, -1) : line
  if (s.startsWith(`${JOINT_LINE.state} `)) return { kind: 'state', body: s.slice(JOINT_LINE.state.length + 1) }
  if (s.startsWith(`${JOINT_LINE.targets} `)) return { kind: 'targets', body: s.slice(JOINT_LINE.targets.length + 1) }
  if (s.startsWith(`${JOINT_LINE.ack} `)) {
    const seq = /^\d{1,15}$/.test(s.slice(3)) ? Number(s.slice(3)) : NaN
    return Number.isSafeInteger(seq) ? { kind: 'ack', seq } : null
  }
  if (!s.startsWith(`${JOINT_LINE.manifest} `)) return null
  const m = /^JOINTS (\d+) (?:(\d+)\/(\d+) )?(.*)$/s.exec(s)
  if (!m) return null
  const version = Number(m[1])
  const part = m[2] === undefined ? 1 : Number(m[2]), parts = m[3] === undefined ? 1 : Number(m[3])
  if (!(part >= 1 && parts >= 1 && part <= parts && parts <= JOINT_LINE.maxParts)) return null
  return { kind: 'manifest', version, part, parts, body: m[4] }
}

/** Collects a manifest's parts in order; a part out of order, one past the window, or a new `1/n` starts over. */
export class ManifestAssembler {
  private parts: string[] = []
  private expected = 0
  private startedAt = 0
  /** Feeds one manifest line at `now` ms; the manifest once the last part is in, a reason when it is refused, else null. */
  feed(l: Extract<JointLine, { kind: 'manifest' }>, now: number = 0): Checked<Manifest> | null {
    if (l.version !== JOINT_LINE.version) { this.reset(); return bad(`JOINTS version ${l.version} is not known (this host speaks ${JOINT_LINE.version})`) }
    if (l.part === 1) { this.parts = []; this.expected = l.parts; this.startedAt = now }
    else if (l.parts !== this.expected || l.part !== this.parts.length + 1) { this.reset(); return bad(`JOINTS part ${l.part}/${l.parts} out of order`) }
    else if (now - this.startedAt > JOINT_LINE.windowMs) { this.reset(); return bad(`JOINTS part ${l.part}/${l.parts} came more than ${JOINT_LINE.windowMs / 1000} s after the first`) }
    this.parts.push(l.body)
    if (this.parts.length < this.expected) return null
    const text = this.parts.join('')
    this.reset()
    return readManifest(text)
  }
  reset(): void { this.parts = []; this.expected = 0 }
}

/** A number as the line carries it: `digits` significant figures, no exponent for the usual range. */
const fixed = (v: number, digits: number): string => {
  if (v === 0) return '0'
  const s = Number(v.toPrecision(digits)).toString()
  return s
}

/**
 * A state or targets line that fits `maxLine` bytes: numbers at six significant figures, then fewer, then without τ,
 * then without q̇; null when q alone at three figures does not fit (a robot of that size must use the relay).
 */
export function frameLine(kind: 'state' | 'targets', f: JointFrame | JointTargets, maxLine: number): string | null {
  const head = kind === 'state' ? JOINT_LINE.state : JOINT_LINE.targets
  const meta = kind === 'state'
    ? `"stamp":${fixed((f as JointFrame).stamp, 15)},"seq":${(f as JointFrame).seq}${(f as JointFrame).ack === undefined ? '' : `,"ack":${(f as JointFrame).ack}`}`
    : `"seq":${f.seq},"issuedAt":${fixed((f as JointTargets).issuedAt, 15)},"ttlMs":${fixed((f as JointTargets).ttlMs, 15)}`
  const arr = (a: readonly number[], digits: number) => `[${a.map((v) => fixed(v, digits)).join(',')}]`
  for (const drop of [0, 1, 2]) {
    for (const digits of [6, 5, 4, 3]) {
      const fields = [meta, `"q":${arr(f.q, digits)}`]
      if (drop < 2) fields.push(`"qd":${arr(f.qd, digits)}`)
      if (drop < 1) fields.push(`"tau":${arr(f.tau, digits)}`)
      const line = `${head} {${fields.join(',')}}\n`
      if (byteLength(line) <= maxLine) return line
    }
  }
  return null
}
