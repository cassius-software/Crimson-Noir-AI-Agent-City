/**
 * Why does this file exist? It is the protocol core of the replication scaffold, the one language the page's client
 * (netClient.ts) and the Node host (replication.node.ts) share, written the way simProtocol.ts writes the realm
 * boundary: every message is plain data (numbers, strings, booleans), and every message is read as untrusted. The
 * validators refuse anything malformed the way simHost does (shape, finite numbers, bounds, string lengths, sequence
 * order) and hand back a frozen copy with nothing extra in it. The room is server-authoritative (Phase 12): a peer's
 * input says what the client's own physics realm applied for each run of fixed substeps (on foot the walking velocity,
 * at the wheel the vetted wheel command) and where that left it (the claim, its prediction); the room hands it to its
 * Authority (the host's is the headless Ring-0 mirror, mirror.node.ts, the same city, the same character controller
 * and the same car physics), which replays it and keeps it only if the claim matches. Taking a car's wheel and leaving
 * it are doors (Phase 13): an input names the car and the state the realm took it over in, or the point the realm put
 * the player down at, and the authority checks each against its own numbers before the runs are replayed. An input it
 * refuses is answered at once with a correction: the truth (and, at the wheel, the car's full state), under a new
 * correction number, which the client snaps to (inputs under an older number predate the snap and are dropped unread
 * for a grace after it). A peer may not run more substeps or take more doors than time allows, and a peer that keeps
 * earning corrections is removed. The snapshot each tick is the truth: every other player's pose, and this peer's own. On the page a remote
 * player is only a pose that is drawn, modelled on the pose buffer's layout (REMOTE_POSE), never a body in the physics
 * realm: the kernel stays single. Every peer has token buckets (inputs per second, substeps per second, corrections per
 * minute, chat per minute, pings per second), every refusal is counted and a peer that keeps earning them is removed. The 14A screen of 02_Define_The_Rules/conduct.ts reads every player name and
 * every chat line: an inadmissible one is dropped silently and counted, so a griefer gets no reaction and no stage.
 * Every frame on the wire is sealed (02_Define_The_Rules/integrity.ts): an envelope number that must rise, and an
 * HMAC-SHA256 under the session token over the canonical message, checked on both sides before the message is read
 * any further, so a forged, altered or replayed frame is refused and counted like any other malformed one. The token
 * itself rides the WebSocket upgrade as a subprotocol (authProtocol), so the host checks it before a socket exists.
 * Pure: no socket, no clock of its own (the caller passes `now`), no randomness, no I/O; the authority is handed in.
 * What breaks if it is removed? The client and the host have no agreed language, nothing vets what a peer says, and a
 * remote player could become a body in the realm.
 */
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { canonical, hmacSha256, isDigest, sameDigest } from '../02_Define_The_Rules/integrity.ts'
import { RUN, type CarBodyState, type Door as RealmDoor } from '../07_Execute_Actions/simProtocol.ts'
import { PING_KINDS, type PingKind } from '../08_Swarm/ping.ts'

/**
 * The protocol's version; a join naming another is refused. 2: every frame is sealed (sealMessage). 3: the room is
 * authoritative (inputs are runs of substeps and a claim, a refused one is answered with a correction), and the token
 * rides the upgrade (authProtocol). 4: the room replays cars too (runs at the wheel carry the wheel command, doors are
 * checked, a correction at the wheel carries the car's state), and the world names the fleet ('city/<seed>/<cars>').
 */
export const PROTOCOL_VERSION = 4
/** The WebSocket subprotocol a client offers and the host answers with. */
export const SUBPROTOCOL = 'onyx.4'
/** The subprotocol entry that carries the session token, `auth.<token>`: the host checks it before it upgrades. */
export const AUTH_PREFIX = 'auth.'

/** Every bound the validators and the room enforce, frozen. */
export const LIMITS = Object.freeze({
  /** A player's name, characters (trimmed, printable). */
  name: 24,
  /** One chat line, characters. */
  chat: 240,
  /** A session token, characters. */
  token: 512,
  /** One encoded message from a client (one text frame), bytes. */
  message: 4096,
  /** One encoded message from the host, bytes: a snapshot carries every player's pose. */
  hostMessage: 16384,
  /** Peers a room holds at once (joined or not). */
  peers: 32,
  /** |x| and |z| of any position or ping, m; |y| at most `height`. */
  range: 4096,
  height: 1024,
  /** Inputs a peer may send: a steady rate and the burst it may bank (a network stall of 3 s delivers 3 s of them at once). */
  inputsPerSecond: 60,
  inputBurst: 180,
  /** Runs of substeps one input may carry, and the substeps in all. */
  runs: 8,
  stepsPerInput: 30,
  /**
   * Substeps a peer may run: the realm's fixed rate (physics.ts PHYSICS_HZ) and three seconds banked (a network stall up
   * to 3 s delivers an honest client's steps at once). A client that runs its physics faster than time (a speed hack on
   * the clock) runs out, and gains at most those seconds, once: the room never keeps a claim it did not replay.
   */
  stepsPerSecond: 60,
  stepBurst: 180,
  /**
   * How much faster than the realm's own rate the host refills a peer's inputs and substeps: an honest page steps at
   * exactly that rate, so without it a bank spent in a stall would never come back, and a page whose clock runs a
   * little fast against the host's would drain it in a long session. With it a spent bank is whole again within a
   * minute; a client running its physics faster than the clock gains at most this (5 %), never more. The page's own
   * client paces itself at the realm's rate (netClient.ts).
   */
  headroom: 1.05,
  /**
   * How long after a correction an input under the correction before it is still dropped unread, ms: the inputs an
   * honest client had in flight (a stall included) when the correction reached it. Past it, one is a refusal.
   */
  staleGraceMs: 5000,
  /** Corrections a peer may earn per minute (burst: the same) before the host removes it. */
  correctionsPerMinute: 10,
  /** A walker's speed bound (RUN) and a car's (the Ring-0 velocity cap, ring0.ts RING0.maxVelocity), m/s. */
  driveSpeed: 50,
  /**
   * A run at the wheel: the bounds of the command the realm's bouncer lets through (vehicles.ts sanitize): throttle
   * −1..1, brake 0..KERNEL.maxBrake m/s², steer ±CAR.maxSteer rad (replication.test.ts pins them to the realm's).
   */
  throttle: 1,
  brake: 8,
  steer: 0.6,
  /** The largest fleet a room may name, and so the car indices a door may carry (simCore.ts MAX_CARS). */
  cars: 48,
  /** Doors (into or out of a car) a peer may take per second, and the burst. */
  doorsPerSecond: 2,
  doorBurst: 4,
  /** Chat lines a peer may send per minute (burst: the same). */
  chatPerMinute: 20,
  /** Pings a peer may relay per second (burst: 4). */
  pingsPerSecond: 2,
  pingBurst: 4,
  /** Refusals a peer may earn before the host removes it. */
  refusalsBeforeKick: 8,
  /** The room's fixed tick rate, Hz. */
  tickHz: 20,
  /** A peer that has not joined within this long is dropped, ms. */
  joinTimeoutMs: 5000,
  /**
   * A joined peer silent for this long is dropped, ms. The page sends a keepalive every few seconds (netClient.ts
   * KEEPALIVE_MS), but a browser runs a tab hidden for minutes on one timer a minute: past that, not before.
   */
  idleTimeoutMs: 75000,
  /** Sequence and tick numbers stay below this (a safe integer, so JSON carries them exactly). */
  maxSeq: 2 ** 40,
  /** The longest a remote pose is carried forward between snapshots, s. */
  predictS: 0.25,
})

// ---------------------------------------------------------------------------------------------------
// Remote players: poses the page draws

/** One remote player as the page draws it: plain floats, like one vehicle's slice of the pose buffer. */
export interface RemotePlayer {
  id: number
  name: string
  x: number
  y: number
  z: number
  /** Facing, rad. */
  heading: number
  /** Velocity over the ground, m/s. */
  vx: number
  vz: number
  /** |(vx, vz)|, m/s. */
  speed: number
  /** At a wheel (the pose is the chassis), or on foot. */
  driving: boolean
}

/** One remote player's slice of a Float32Array (`stride` floats per player, replica order), for the page's drawing. */
export const REMOTE_POSE = { x: 0, y: 1, z: 2, heading: 3, vx: 4, vz: 5, speed: 6, stride: 7 } as const

/** Writes every player's pose into `out` (REMOTE_POSE layout) and returns how many fit. */
export function packPoses(players: readonly RemotePlayer[], out: Float32Array): number {
  const n = Math.min(players.length, Math.floor(out.length / REMOTE_POSE.stride))
  for (let i = 0; i < n; i++) {
    const p = players[i]
    const o = i * REMOTE_POSE.stride
    out[o + REMOTE_POSE.x] = p.x
    out[o + REMOTE_POSE.y] = p.y
    out[o + REMOTE_POSE.z] = p.z
    out[o + REMOTE_POSE.heading] = p.heading
    out[o + REMOTE_POSE.vx] = p.vx
    out[o + REMOTE_POSE.vz] = p.vz
    out[o + REMOTE_POSE.speed] = p.speed
  }
  return n
}

// ---------------------------------------------------------------------------------------------------
// Messages

/**
 * Client → host: the first message, once; `token` is the session token the operator handed out (the same one the
 * upgrade carried), and `world` the world the page is walking (mirror.node.ts worldOf: 'city/<seed>').
 */
export interface JoinMessage { t: 'join'; v: number; token: string; name: string; world: string }
/** A run of fixed substeps on foot: the walking velocity (x, z, m/s) the client's realm applied to each, and how many. */
export type FootRun = readonly [x: number, z: number, n: number]
/**
 * A run of fixed substeps at the wheel: the command the realm's car ran (the bouncer's vetted throttle, brake and
 * steer, the handbrake as 0 or 1), and how many.
 */
export type DriveRun = readonly [throttle: number, brake: number, steer: number, handbrake: number, n: number]
export type Run = FootRun | DriveRun
/** A car's full rigid-body state as plain numbers (simProtocol.ts CarBodyState). */
export type CarState = CarBodyState
/** A car and its state: what a door into it and a correction at its wheel carry. */
export interface CarFix { index: number; state: CarState }
/**
 * A door, taken before the input's runs: the realm took car `enter.car`'s wheel in `enter.state`, or put the player down
 * at `exit` beside the car they drove (simProtocol.ts doorOf reads it from a realm step).
 */
export type Door = RealmDoor
/**
 * Client → host: what the client's realm did since the last input. `door`, when the player took a car's wheel or left
 * it, comes first; `segs` are then the runs of substeps in `mode` (on foot the walking velocity, at the wheel the
 * command); `claim` is where the realm then had the player (the capsule centre on foot, the chassis centre at the
 * wheel). `heading` is the way the player faces. `seq` rises by one per input; `ack` is the newest snapshot tick seen;
 * `fix` the newest correction applied (an input under an older one is dropped).
 */
export interface InputMessage {
  t: 'input'
  seq: number
  ack: number
  fix: number
  mode: 'foot' | 'drive'
  segs: Run[]
  heading: number
  claim: { x: number; y: number; z: number }
  door?: Door
}
/** Client → host: the newest snapshot tick seen, from an idle client. */
export interface AckMessage { t: 'ack'; ack: number }
/** Client → host: a chat line for the room. */
export interface ChatMessage { t: 'chat'; seq: number; text: string }
/** Client → host: a ping or rally mark (08_Swarm/ping.ts kinds) for the room to relay. */
export interface PingMessage { t: 'ping'; seq: number; kind: PingKind; x: number; y: number; z: number }
/** Client → host: goodbye. */
export interface LeaveMessage { t: 'leave' }
export type ClientMessage = JoinMessage | InputMessage | AckMessage | ChatMessage | PingMessage | LeaveMessage

/** Host → client: the answer to a good join: the peer's own truth (its spawn, correction 1: the client snaps to it) and everyone else. */
export interface WelcomeMessage { t: 'welcome'; v: number; id: number; tick: number; tickHz: number; fix: number; you: RemotePlayer; players: RemotePlayer[] }
/** Host → client, every tick: this peer's truth, every other joined player's, the newest input seq kept and correction made. */
export interface SnapshotMessage { t: 'snapshot'; tick: number; ack: number; fix: number; you: RemotePlayer; players: RemotePlayer[] }
/**
 * Host → client, at once, for an input the room refused: the truth to snap to under correction `fix` (on foot the
 * client puts the player down there, standing; at the wheel, `car`, it puts the car in exactly that state), the newest
 * input seq kept, and why. The client numbers its inputs under `fix` from then on.
 */
export interface CorrectMessage { t: 'correct'; fix: number; ack: number; you: RemotePlayer; reason: string; tick: number; car?: CarFix }
export interface ChatRelayMessage { t: 'chat'; from: number; name: string; text: string; tick: number }
export interface PingRelayMessage { t: 'ping'; from: number; kind: PingKind; x: number; y: number; z: number; tick: number }
export interface JoinedMessage { t: 'joined'; player: RemotePlayer; tick: number }
export interface LeftMessage { t: 'left'; id: number; reason: string; tick: number }
export type ServerMessage = WelcomeMessage | SnapshotMessage | CorrectMessage | ChatRelayMessage | PingRelayMessage | JoinedMessage | LeftMessage

/** What a validator says: the message as a frozen plain copy, or why it was refused. */
export type Read<T> = { ok: true; msg: T } | { ok: false; reason: string }

const refusal = <T,>(reason: string): Read<T> => ({ ok: false, reason })
/** A value named in a refusal: a short string or a number as it is, anything else only by its type (never converted: an object may refuse to be). */
const shown = (u: unknown): string =>
  typeof u === 'string' ? JSON.stringify(u.slice(0, 32)) : typeof u === 'number' || typeof u === 'boolean' ? String(u) : u === null ? 'null' : typeof u
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const fin = (u: unknown, lo: number, hi: number): u is number => typeof u === 'number' && Number.isFinite(u) && u >= lo && u <= hi
const count = (u: unknown): u is number => typeof u === 'number' && Number.isSafeInteger(u) && u >= 0 && u < LIMITS.maxSeq

/** A string of at most `max` characters with nothing unprintable in it (no control characters, no line breaks). */
function text(u: unknown, max: number): u is string {
  if (typeof u !== 'string' || u.length > max) return false
  for (const ch of u) {
    const c = ch.codePointAt(0) ?? 0
    if (c < 32 || c === 127) return false
  }
  return true
}

/**
 * A remote player as a frozen plain copy, or null. The name is read through the same 14A screen the room applies at
 * join (admissibleName): the host is not trusted either, and a name reaches the page's captions and voice labels.
 */
function player(u: unknown): RemotePlayer | null {
  if (!isRecord(u)) return null
  const { id, x, y, z, heading, vx, vz, speed, driving } = u
  const name = admissibleName(u.name)
  if (!count(id) || name === null || !fin(x, -LIMITS.range, LIMITS.range) || !fin(y, -LIMITS.height, LIMITS.height) || !fin(z, -LIMITS.range, LIMITS.range)) return null
  if (typeof driving !== 'boolean') return null
  // A walker is never faster than a run; a car never faster than the velocity cap.
  const top = driving ? LIMITS.driveSpeed : RUN
  if (!fin(heading, -Math.PI * 2, Math.PI * 2) || !fin(vx, -top, top) || !fin(vz, -top, top) || !fin(speed, 0, top)) return null
  return Object.freeze({ id, name, x, y, z, heading, vx, vz, speed, driving })
}

function players(u: unknown): RemotePlayer[] | null {
  if (!Array.isArray(u) || u.length > LIMITS.peers) return null
  const out: RemotePlayer[] = []
  for (const p of u) {
    const r = player(p)
    if (!r) return null
    out.push(r)
  }
  return Object.freeze(out) as RemotePlayer[]
}

const STATE_KEYS = ['x', 'y', 'z', 'qx', 'qy', 'qz', 'qw', 'vx', 'vy', 'vz', 'wx', 'wy', 'wz'] as const

/**
 * A car's state as a frozen plain copy, or null: a chassis within the world's range, a unit orientation (within 1 %),
 * a velocity within the velocity cap, a spin within 4π rad/s.
 */
function carState(u: unknown): CarState | null {
  if (!isRecord(u)) return null
  for (const k of STATE_KEYS) if (typeof u[k] !== 'number' || !Number.isFinite(u[k])) return null
  const s = u as unknown as CarState
  if (!fin(s.x, -LIMITS.range, LIMITS.range) || !fin(s.y, -LIMITS.height, LIMITS.height) || !fin(s.z, -LIMITS.range, LIMITS.range)) return null
  const q = Math.hypot(s.qx, s.qy, s.qz, s.qw)
  if (!(q > 0.99 && q < 1.01)) return null
  if (!(Math.hypot(s.vx, s.vy, s.vz) <= LIMITS.driveSpeed) || !(Math.hypot(s.wx, s.wy, s.wz) <= 4 * Math.PI)) return null
  const out = {} as Record<(typeof STATE_KEYS)[number], number>
  for (const k of STATE_KEYS) out[k] = s[k]
  return Object.freeze(out)
}

/** A car index a room's fleet may hold. */
const carIndex = (u: unknown): u is number => typeof u === 'number' && Number.isInteger(u) && u >= 0 && u < LIMITS.cars

function carFix(u: unknown): CarFix | null {
  if (!isRecord(u) || !carIndex(u.index)) return null
  const state = carState(u.state)
  return state ? Object.freeze({ index: u.index, state }) : null
}

/** A point within the world's range: x and z within ±range, y within ±height when it has one. */
function point(u: unknown, withY: boolean): { x: number; y: number; z: number } | null {
  if (!isRecord(u)) return null
  const { x, y, z } = u
  if (!fin(x, -LIMITS.range, LIMITS.range) || !fin(z, -LIMITS.range, LIMITS.range)) return null
  if (withY && !fin(y, -LIMITS.height, LIMITS.height)) return null
  return { x, y: withY ? (y as number) : 0, z }
}

/** A run's substep count: a whole number, 0..LIMITS.stepsPerInput. */
const steps = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= LIMITS.stepsPerInput

/** A door as a frozen plain copy, or null: into a car (its index and state), or out of one (the point, x and z). */
function door(u: unknown): Door | null {
  if (!isRecord(u)) return null
  if (u.enter !== undefined && u.exit === undefined) {
    const e = u.enter
    if (!isRecord(e) || !carIndex(e.car)) return null
    const state = carState(e.state)
    return state ? Object.freeze({ enter: Object.freeze({ car: e.car, state }) }) : null
  }
  if (u.exit !== undefined && u.enter === undefined) {
    const p = point(u.exit, false)
    return p ? Object.freeze({ exit: Object.freeze({ x: p.x, z: p.z }) }) : null
  }
  return null
}

/**
 * An input, field by field: the counters, the mode, 1..LIMITS.runs runs (on foot [x, z, n], x and z within a run per
 * axis, the authority clamping the length as the realm does; at the wheel [throttle, brake, steer, handbrake, n] within
 * the bouncer's bounds and a handbrake of 0 or 1; n a whole number, LIMITS.stepsPerInput in all), the heading, the
 * claim, and a door that agrees with the mode (into a car: at the wheel after it; out of one: on foot).
 */
function readInput(u: Record<string, unknown>): Read<ClientMessage> {
  if (!count(u.seq) || !count(u.ack) || !count(u.fix)) return refusal('input: seq, ack and fix')
  if (u.mode !== 'foot' && u.mode !== 'drive') return refusal('input: mode')
  const mode = u.mode
  if (!Array.isArray(u.segs) || u.segs.length === 0 || u.segs.length > LIMITS.runs) return refusal('input: runs')
  const segs: Run[] = []
  let total = 0
  for (const r of u.segs) {
    if (!Array.isArray(r) || r.length !== (mode === 'foot' ? 3 : 5)) return refusal('input: runs')
    const n = r[r.length - 1] as unknown
    if (!steps(n)) return refusal('input: substeps')
    if (mode === 'foot') {
      const [x, z] = r as unknown[]
      if (!fin(x, -RUN, RUN) || !fin(z, -RUN, RUN)) return refusal('input: velocity')
      segs.push(Object.freeze([x, z, n] as const))
    } else {
      const [throttle, brake, steer, handbrake] = r as unknown[]
      if (!fin(throttle, -LIMITS.throttle, LIMITS.throttle) || !fin(brake, 0, LIMITS.brake) || !fin(steer, -LIMITS.steer, LIMITS.steer)) return refusal('input: wheel command')
      if (handbrake !== 0 && handbrake !== 1) return refusal('input: handbrake')
      segs.push(Object.freeze([throttle, brake, steer, handbrake, n] as const))
    }
    total += n
  }
  if (total > LIMITS.stepsPerInput) return refusal('input: substeps')
  if (!fin(u.heading, -Math.PI * 2, Math.PI * 2)) return refusal('input: heading')
  const claim = point(u.claim, true)
  if (!claim) return refusal('input: claim')
  let d: Door | undefined
  if (u.door !== undefined) {
    const read = door(u.door)
    if (!read) return refusal('input: door')
    if ('enter' in read ? mode !== 'drive' : mode !== 'foot') return refusal('input: door and mode')
    d = read
  }
  return {
    ok: true,
    msg: Object.freeze({
      t: 'input', seq: u.seq, ack: u.ack, fix: u.fix, mode, segs: Object.freeze(segs) as Run[], heading: u.heading, claim: Object.freeze(claim),
      ...(d && { door: d }),
    }),
  }
}

/** A client's message, checked field by field; anything else in it is never read. */
export function readClientMessage(u: unknown): Read<ClientMessage> {
  if (!isRecord(u)) return refusal('not a message object')
  switch (u.t) {
    case 'join': {
      if (u.v !== PROTOCOL_VERSION) return refusal(`join: protocol ${shown(u.v)} is not ${PROTOCOL_VERSION}`)
      if (!text(u.token, LIMITS.token) || u.token.length === 0) return refusal('join: token')
      if (!text(u.name, LIMITS.name)) return refusal('join: name')
      if (!text(u.world, LIMITS.name) || u.world.length === 0) return refusal('join: world')
      return { ok: true, msg: Object.freeze({ t: 'join', v: PROTOCOL_VERSION, token: u.token, name: u.name, world: u.world }) }
    }
    case 'input':
      return readInput(u)
    case 'ack':
      if (!count(u.ack)) return refusal('ack: ack')
      return { ok: true, msg: Object.freeze({ t: 'ack', ack: u.ack }) }
    case 'chat':
      if (!count(u.seq)) return refusal('chat: seq')
      if (!text(u.text, LIMITS.chat) || u.text.trim().length === 0) return refusal('chat: text')
      return { ok: true, msg: Object.freeze({ t: 'chat', seq: u.seq, text: u.text }) }
    case 'ping': {
      if (!count(u.seq)) return refusal('ping: seq')
      if (typeof u.kind !== 'string' || !PING_KINDS.includes(u.kind as PingKind)) return refusal('ping: kind')
      if (!fin(u.x, -LIMITS.range, LIMITS.range) || !fin(u.y, -LIMITS.height, LIMITS.height) || !fin(u.z, -LIMITS.range, LIMITS.range)) return refusal('ping: position')
      return { ok: true, msg: Object.freeze({ t: 'ping', seq: u.seq, kind: u.kind as PingKind, x: u.x, y: u.y, z: u.z }) }
    }
    case 'leave':
      return { ok: true, msg: Object.freeze({ t: 'leave' }) }
    default:
      return refusal(`unknown message ${shown(u.t)}`)
  }
}

/** The host's message as the client checks it: the host is not trusted either. */
export function readServerMessage(u: unknown): Read<ServerMessage> {
  if (!isRecord(u)) return refusal('not a message object')
  switch (u.t) {
    case 'welcome': {
      if (u.v !== PROTOCOL_VERSION) return refusal(`welcome: protocol ${shown(u.v)} is not ${PROTOCOL_VERSION}`)
      if (!count(u.id) || !count(u.tick) || !fin(u.tickHz, 1, 240) || !count(u.fix)) return refusal('welcome: id, tick, tickHz and fix')
      const you = player(u.you)
      if (!you || you.id !== u.id) return refusal('welcome: you')
      const list = players(u.players)
      if (!list) return refusal('welcome: players')
      return { ok: true, msg: Object.freeze({ t: 'welcome', v: PROTOCOL_VERSION, id: u.id, tick: u.tick, tickHz: u.tickHz, fix: u.fix, you, players: list }) }
    }
    case 'snapshot': {
      if (!count(u.tick) || !count(u.ack) || !count(u.fix)) return refusal('snapshot: tick, ack and fix')
      const you = player(u.you)
      if (!you) return refusal('snapshot: you')
      const list = players(u.players)
      if (!list) return refusal('snapshot: players')
      return { ok: true, msg: Object.freeze({ t: 'snapshot', tick: u.tick, ack: u.ack, fix: u.fix, you, players: list }) }
    }
    case 'correct': {
      if (!count(u.fix) || !count(u.ack) || !count(u.tick) || !text(u.reason, LIMITS.chat)) return refusal('correct: fix, ack, tick and reason')
      const you = player(u.you)
      if (!you) return refusal('correct: you')
      let car: CarFix | undefined
      if (u.car !== undefined) {
        const c = carFix(u.car)
        // A car correction is for a player at the wheel, and its chassis is where `you` is.
        if (!c || !you.driving || c.state.x !== you.x || c.state.y !== you.y || c.state.z !== you.z) return refusal('correct: car')
        car = c
      }
      return { ok: true, msg: Object.freeze({ t: 'correct', fix: u.fix, ack: u.ack, you, reason: u.reason, tick: u.tick, ...(car && { car }) }) }
    }
    case 'chat':
      if (!count(u.from) || !count(u.tick) || !text(u.name, LIMITS.name) || !text(u.text, LIMITS.chat)) return refusal('chat: from, name, text and tick')
      return { ok: true, msg: Object.freeze({ t: 'chat', from: u.from, name: u.name, text: u.text, tick: u.tick }) }
    case 'ping': {
      if (!count(u.from) || !count(u.tick)) return refusal('ping: from and tick')
      if (typeof u.kind !== 'string' || !PING_KINDS.includes(u.kind as PingKind)) return refusal('ping: kind')
      if (!fin(u.x, -LIMITS.range, LIMITS.range) || !fin(u.y, -LIMITS.height, LIMITS.height) || !fin(u.z, -LIMITS.range, LIMITS.range)) return refusal('ping: position')
      return { ok: true, msg: Object.freeze({ t: 'ping', from: u.from, kind: u.kind as PingKind, x: u.x, y: u.y, z: u.z, tick: u.tick }) }
    }
    case 'joined': {
      const p = player(u.player)
      if (!p || !count(u.tick)) return refusal('joined: player and tick')
      return { ok: true, msg: Object.freeze({ t: 'joined', player: p, tick: u.tick }) }
    }
    case 'left':
      if (!count(u.id) || !count(u.tick) || !text(u.reason, LIMITS.chat)) return refusal('left: id, reason and tick')
      return { ok: true, msg: Object.freeze({ t: 'left', id: u.id, reason: u.reason, tick: u.tick }) }
    default:
      return refusal(`unknown message ${shown(u.t)}`)
  }
}

/** One text frame as JSON, bounded (a client's at `message`, the host's at `hostMessage`), then read as `read` reads it. */
export function decode<T>(wire: string, read: (u: unknown) => Read<T>, max: number = LIMITS.message): Read<T> {
  if (typeof wire !== 'string') return refusal('not text')
  if (wire.length > max) return refusal(`message longer than ${max}`)
  let u: unknown
  try {
    u = JSON.parse(wire)
  } catch {
    return refusal('not JSON')
  }
  return read(u)
}

export const decodeClientMessage = (wire: string): Read<ClientMessage> => decode(wire, readClientMessage)
export const decodeServerMessage = (wire: string): Read<ServerMessage> => decode(wire, readServerMessage, LIMITS.hostMessage)

/** A message as JSON, unsealed (the validators' tests; the wire carries sealMessage). */
export const encode = (msg: ClientMessage | ServerMessage): string => JSON.stringify(msg)

// ---------------------------------------------------------------------------------------------------
// Sealed frames: what the wire carries (02_Define_The_Rules/integrity.ts)

/**
 * What rides the wire, both ways: the envelope number `n` (1, 2, 3… per direction per session: a frame whose number
 * does not rise is a replay and is refused), the message as plain data, and `mac`, the HMAC-SHA256 under the session
 * token of canonical({ n, body }), so neither the number nor a field of the body can be altered. The seal is checked
 * before the message is applied, and compared in constant time.
 */
export interface SealedFrame { n: number; body: unknown; mac: string }

/** A frame opened: the message, and the envelope number it came as. */
export type Opened<T> = { ok: true; msg: T; n: number } | { ok: false; reason: string }

/**
 * HMAC-SHA256 of a text under a key, as 64 lower-case hex digits: integrity.ts by default (dependency-free, the page's);
 * the host passes node:crypto's, the same digest, faster.
 */
export type Mac = (key: string, message: string) => string

/** `msg` sealed as envelope `n` under `key`, for the wire. */
export function sealMessage(msg: ClientMessage | ServerMessage, n: number, key: string, mac: Mac = hmacSha256): string {
  if (!count(n)) throw new RangeError(`sealMessage: n ${String(n)}`)
  return JSON.stringify({ n, body: msg, mac: mac(key, canonical({ n, body: msg })) })
}

/** The wire as an envelope: bounded text (a client's frame at `message`, the host's at `hostMessage`), JSON, the shape, before anything in it is trusted. */
export function readEnvelope(wire: unknown, max: number = LIMITS.message): Read<SealedFrame> {
  if (typeof wire !== 'string') return refusal('not text')
  if (wire.length > max) return refusal(`message longer than ${max}`)
  let u: unknown
  try {
    u = JSON.parse(wire)
  } catch {
    return refusal('not JSON')
  }
  if (!isRecord(u)) return refusal('not an envelope')
  if (!count(u.n)) return refusal('envelope: n')
  if (!isDigest(u.mac)) return refusal('envelope: mac')
  if (!isRecord(u.body)) return refusal('envelope: body')
  return { ok: true, msg: Object.freeze({ n: u.n, body: u.body, mac: u.mac }) }
}

/**
 * Why `env` is not the genuine next frame under `key` after envelope `after`: a seal that is not the HMAC of its own
 * number and body (forged, altered, or under another token), or a number that does not rise (a replay). Null when it
 * is. The seal is checked first, so a forgery is never told apart from a replay by the reason it earns.
 */
export function sealFault(env: SealedFrame, key: string, after: number, mac: Mac = hmacSha256): string | null {
  let want: string
  try {
    want = mac(key, canonical({ n: env.n, body: env.body }))
  } catch {
    // JSON that is not plain data (1e999 parses as Infinity): nothing to seal, nothing to accept.
    return 'envelope: body'
  }
  if (!sameDigest(env.mac, want)) return 'envelope: bad seal'
  if (env.n <= after) return 'envelope: replayed'
  return null
}

/**
 * A client's frame opened for `peer`: the envelope, then the message's shape, then the seal under the peer's session
 * token (before the peer has joined, only a join is read, under the token it carries: the room then verifies that
 * token itself), then the envelope number, which must rise. A good frame moves `peer.received`; a refused one moves
 * nothing, so a forgery or a replay never advances a thing.
 */
export function openClientFrame(peer: Peer, wire: unknown, mac: Mac = hmacSha256): Read<ClientMessage> {
  const env = readEnvelope(wire)
  if (!env.ok) return env
  const read = readClientMessage(env.msg.body)
  if (!read.ok) return read
  const key = peer.joined ? peer.key : read.msg.t === 'join' ? read.msg.token : ''
  if (key === '') return refusal(`${read.msg.t} before join`)
  const fault = sealFault(env.msg, key, peer.received, mac)
  if (fault !== null) return refusal(fault)
  peer.received = env.msg.n
  return read
}

/** The host's frame opened on the page: the envelope, the message's shape, the seal under the session token, a number above `after`. */
export function openServerFrame(wire: unknown, key: string, after: number): Opened<ServerMessage> {
  const env = readEnvelope(wire, LIMITS.hostMessage)
  if (!env.ok) return env
  const read = readServerMessage(env.msg.body)
  if (!read.ok) return read
  const fault = sealFault(env.msg, key, after)
  if (fault !== null) return { ok: false, reason: fault }
  return { ok: true, msg: read.msg, n: env.msg.n }
}

/**
 * The subprotocol entry that carries a session token through the WebSocket upgrade (`auth.<token>`), or null for a
 * token a subprotocol cannot carry: the host's tokens are base64url and dots (replication.node.ts mintToken), all of
 * them characters RFC 6455 allows there.
 */
export function authProtocol(token: unknown): string | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > LIMITS.token || !/^[A-Za-z0-9._-]+$/.test(token)) return null
  return AUTH_PREFIX + token
}

/** A bucket with `n` tokens taken at once at `now`, if it holds them: a run of substeps against the peer's budget. */
export function takeMany(b: Bucket, n: number, now: number): boolean {
  if (n <= 0) return true
  const dt = Math.max(0, now - b.at) / 1000
  b.tokens = Math.min(b.capacity, b.tokens + dt * b.perSecond)
  b.at = Math.max(b.at, now)
  if (b.tokens < n) return false
  b.tokens -= n
  return true
}

// ---------------------------------------------------------------------------------------------------
// The 14A screen on what peers say

/** A player's name as the room keeps it, or null: trimmed, 1..LIMITS.name printable characters, admissible under 14A. */
export function admissibleName(name: unknown): string | null {
  if (!text(name, LIMITS.name)) return null
  const n = name.trim()
  if (n.length === 0 || !screen(n).admissible) return null
  return n
}

/** A chat line as the room relays it, or null: trimmed, 1..LIMITS.chat printable characters, admissible under 14A. */
export function admissibleChat(line: unknown): string | null {
  if (!text(line, LIMITS.chat)) return null
  const l = line.trim()
  if (l.length === 0 || !screen(l).admissible) return null
  return l
}

// ---------------------------------------------------------------------------------------------------
// Rate limits: token buckets, each on the caller's clock

export interface Bucket {
  /** Most tokens the bucket holds (the burst). */
  capacity: number
  /** Tokens added per second. */
  perSecond: number
  tokens: number
  /** When `tokens` was last brought up to date, ms. */
  at: number
}

export const bucket = (capacity: number, perSecond: number, now: number): Bucket => ({ capacity, perSecond, tokens: capacity, at: now })

/** Takes one token at `now` if there is one: true when the action is within its rate. The clock never runs backwards here. */
export function take(b: Bucket, now: number): boolean {
  const dt = Math.max(0, now - b.at) / 1000
  b.tokens = Math.min(b.capacity, b.tokens + dt * b.perSecond)
  b.at = Math.max(b.at, now)
  if (b.tokens < 1) return false
  b.tokens -= 1
  return true
}

export interface PeerBuckets { input: Bucket; stale: Bucket; steps: Bucket; doors: Bucket; corrections: Bucket; chat: Bucket; ping: Bucket }

/**
 * A new peer's buckets, full: inputs and substeps refilled `headroom` times the realm's rate (the host's: LIMITS.headroom;
 * the page's own client paces itself at 1, the realm's rate exactly).
 */
export const peerBuckets = (now: number, headroom: number = LIMITS.headroom): PeerBuckets => ({
  input: bucket(LIMITS.inputBurst, LIMITS.inputsPerSecond * headroom, now),
  // Inputs under an old correction dropped unread: an honest stall's backlog fits (the input burst); a flood does not.
  stale: bucket(LIMITS.inputBurst, LIMITS.inputsPerSecond * headroom, now),
  steps: bucket(LIMITS.stepBurst, LIMITS.stepsPerSecond * headroom, now),
  doors: bucket(LIMITS.doorBurst, LIMITS.doorsPerSecond, now),
  corrections: bucket(LIMITS.correctionsPerMinute, LIMITS.correctionsPerMinute / 60, now),
  chat: bucket(LIMITS.chatPerMinute, LIMITS.chatPerMinute / 60, now),
  ping: bucket(LIMITS.pingBurst, LIMITS.pingsPerSecond, now),
})

// ---------------------------------------------------------------------------------------------------
// The authoritative room

/** A peer's truth as the authority holds it; at the wheel, from a settle, the car's full state too. */
export interface Truth { x: number; y: number; z: number; heading: number; vx: number; vz: number; speed: number; driving: boolean; car?: CarFix }

/**
 * What decides where the room's players are (the host's: the headless Ring-0 mirror, mirror.node.ts). The room only
 * knows that every input must be judged and every refusal settled.
 */
export interface Authority {
  /** The world a joining page must be walking (a join naming another is refused). */
  readonly world: string
  /** A new peer's body at its spawn: its truth. */
  join(id: number): Truth
  leave(id: number): void
  /** One input on trial: kept (the new truth), or refused (the truth exactly as before) and why. */
  judge(id: number, input: InputMessage): { ok: true; pose: Truth } | { ok: false; pose: Truth; reason: string }
  /**
   * The peer put down at its truth again, as the client is by a correction: on foot standing, at the wheel the car
   * built again in its own state (`car`). Its truth.
   */
  settle(id: number): Truth
}

/** One peer as the room holds it; `joined` is false between the socket and a good join. */
export interface Peer {
  id: number
  name: string
  joined: boolean
  /** The newest input seq kept. */
  seq: number
  /** The newest correction made (the welcome is the first): inputs under an older one predate the snap. */
  fix: number
  /** When the newest correction was made, ms. */
  fixedAt: number
  /** The newest chat or ping seq relayed. */
  said: number
  /** The newest snapshot tick the peer acknowledged. */
  ack: number
  refusals: number
  /** Corrections made since the peer joined. */
  corrections: number
  buckets: PeerBuckets
  /** The session token the peer joined with: the key its frames are sealed under both ways ('' until it has joined). */
  key: string
  /** The newest envelope number received from the peer (openClientFrame): the next must be above it. */
  received: number
  /** When the socket arrived and when the peer last said anything well-formed, ms. */
  arrived: number
  seen: number
  /** The truth, as the authority last gave it. */
  x: number
  y: number
  z: number
  heading: number
  vx: number
  vz: number
  driving: boolean
}

export interface Room {
  tick: number
  tickHz: number
  /** The next peer id. */
  next: number
  peers: Map<number, Peer>
  readonly authority: Authority
}

/** What the room wants done after a message: a reply to the peer, a broadcast to every joined peer, a refusal counted, a removal. */
export interface Outcome {
  reply?: ServerMessage
  broadcast?: ServerMessage
  refused?: string
  /** The peer has earned its removal (the host closes the socket with this reason). */
  kick?: string
  /** The peer said goodbye. */
  left?: boolean
}

export const createRoom = (authority: Authority, tickHz: number = LIMITS.tickHz): Room => ({ tick: 0, tickHz, next: 1, peers: new Map(), authority })

/** A socket arrived: a new, unjoined peer, or null when the room is full. */
export function admit(room: Room, now: number): Peer | null {
  if (room.peers.size >= LIMITS.peers) return null
  const peer: Peer = {
    id: room.next++, name: '', joined: false, seq: 0, fix: 0, fixedAt: now, said: 0, ack: 0, refusals: 0, corrections: 0, buckets: peerBuckets(now), key: '',
    received: 0, arrived: now, seen: now, x: 0, y: 0, z: 0, heading: 0, vx: 0, vz: 0, driving: false,
  }
  room.peers.set(peer.id, peer)
  return peer
}

/** Counts one refusal against a peer; past the limit, the peer is to be removed. */
export function refuse(peer: Peer, reason: string): Outcome {
  peer.refusals++
  return peer.refusals >= LIMITS.refusalsBeforeKick ? { refused: reason, kick: 'repeated refusals' } : { refused: reason }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

const round = (v: number, places: number): number => {
  const k = 10 ** places
  return Math.round(v * k) / k
}

/**
 * A peer's pose on the wire: the others' in millimetres and milliradians, so a full room's snapshot stays small; a
 * peer's own exact (`exact`), since its client snaps to it and must put the player down where the authority did.
 */
const pose = (p: Peer, exact = false): RemotePlayer => {
  const top = p.driving ? LIMITS.driveSpeed : RUN
  const at = (v: number): number => (exact ? v : round(v, 3))
  const vx = Math.max(-top, Math.min(top, at(p.vx))), vz = Math.max(-top, Math.min(top, at(p.vz)))
  return Object.freeze({
    id: p.id, name: p.name, x: at(p.x), y: at(p.y), z: at(p.z), heading: at(p.heading), vx, vz,
    speed: Math.min(top, at(Math.hypot(vx, vz))), driving: p.driving,
  })
}

/** The authority's truth onto the peer. */
function hold(peer: Peer, t: Truth): void {
  peer.x = t.x
  peer.y = t.y
  peer.z = t.z
  peer.heading = t.heading
  peer.vx = t.vx
  peer.vz = t.vz
  peer.driving = t.driving
}

/** Every joined player's pose, by id. */
export function poses(room: Room): RemotePlayer[] {
  const out: RemotePlayer[] = []
  for (const p of room.peers.values()) if (p.joined) out.push(pose(p))
  return out
}

/**
 * An input the room will not keep: nothing of it is applied, and the peer is answered at once with a correction (the
 * truth, put down standing, under the next correction number). A peer past its corrections a minute is to be removed.
 */
export function correct(room: Room, peer: Peer, reason: string, now: number): Outcome {
  peer.fix++
  peer.corrections++
  peer.fixedAt = now
  const t = room.authority.settle(peer.id)
  hold(peer, t)
  const reply: CorrectMessage = { t: 'correct', fix: peer.fix, ack: peer.seq, you: pose(peer, true), reason, tick: room.tick, ...(t.car && { car: t.car }) }
  const out: Outcome = { reply, refused: reason }
  if (!take(peer.buckets.corrections, now)) out.kick = 'repeated illegal movement'
  return out
}

/**
 * One well-formed message from a peer, applied. `verify` says whether a session token is good (the host's HMAC check,
 * bound to the token its upgrade carried); the room only knows that it must be. Nothing here replies to a refusal but
 * an input's (a correction): a malformed, out-of-order, over-rate or inadmissible message is silently counted, exactly
 * as the physics worker treats the page.
 */
export function handle(room: Room, peer: Peer, msg: ClientMessage, now: number, verify: (token: string) => boolean): Outcome {
  if (!peer.joined) {
    if (msg.t !== 'join') return refuse(peer, `${msg.t} before join`)
    if (!verify(msg.token)) return refuse(peer, 'join: bad token')
    if (msg.world !== room.authority.world) return refuse(peer, 'join: world')
    const name = admissibleName(msg.name)
    if (name === null) return refuse(peer, 'join: name')
    peer.joined = true
    peer.name = name
    peer.key = msg.token
    peer.seen = now
    peer.fix = 1
    peer.fixedAt = now
    hold(peer, room.authority.join(peer.id))
    const others = poses(room).filter((p) => p.id !== peer.id)
    return {
      reply: { t: 'welcome', v: PROTOCOL_VERSION, id: peer.id, tick: room.tick, tickHz: room.tickHz, fix: peer.fix, you: pose(peer, true), players: others },
      broadcast: { t: 'joined', player: pose(peer), tick: room.tick },
    }
  }
  switch (msg.t) {
    case 'join':
      return refuse(peer, 'join: already joined')
    case 'input': {
      // Sent before the client applied the last correction: it describes a body the room never had. Dropped unread while
      // an honest client could still have it in flight (a stall included), on an allowance of its own, never the input
      // rate (a stall's backlog under an old correction must not cost the inputs after it); past either, a refusal.
      if (msg.fix < peer.fix) {
        if (now - peer.fixedAt > LIMITS.staleGraceMs) return refuse(peer, 'input: under a correction long past')
        return take(peer.buckets.stale, now) ? {} : refuse(peer, 'input: under an old correction, over rate')
      }
      // Over rate is a refusal, counted toward removal (a flood that ignores its corrections is still a flood), and
      // corrected.
      if (!take(peer.buckets.input, now)) {
        const counted = refuse(peer, 'input: over rate')
        if (msg.fix !== peer.fix || counted.kick) return counted
        return correct(room, peer, 'input: over rate', now)
      }
      peer.seen = now
      if (msg.fix > peer.fix) return correct(room, peer, 'input: a correction that was never made', now)
      if (msg.seq <= peer.seq) return correct(room, peer, 'input: stale seq', now)
      if (msg.ack > room.tick) return correct(room, peer, 'input: ack from the future', now)
      // Every run's substeps are its last entry (on foot [x, z, n], at the wheel [throttle, brake, steer, handbrake, n]).
      let n = 0
      for (const r of msg.segs) n += r[r.length - 1]
      // More substeps than time allows: a client running its physics faster than the clock.
      // More doors than time allows: a client hopping in and out of cars to carry itself along.
      if (msg.door && !take(peer.buckets.doors, now)) return correct(room, peer, 'input: more doors than time allows', now)
      if (!takeMany(peer.buckets.steps, n, now)) return correct(room, peer, 'input: more substeps than time allows', now)
      const v = room.authority.judge(peer.id, msg)
      if (!v.ok) return correct(room, peer, v.reason, now)
      hold(peer, v.pose)
      peer.seq = msg.seq
      peer.ack = Math.max(peer.ack, msg.ack)
      return {}
    }
    case 'ack':
      if (msg.ack > room.tick) return refuse(peer, 'ack: from the future')
      peer.ack = Math.max(peer.ack, msg.ack)
      peer.seen = now
      return {}
    case 'chat': {
      if (!take(peer.buckets.chat, now)) return refuse(peer, 'chat: over rate')
      if (msg.seq <= peer.said) return refuse(peer, 'chat: stale seq')
      peer.said = msg.seq
      peer.seen = now
      const line = admissibleChat(msg.text)
      // Inadmissible: dropped without a word, and counted. The room never acknowledges it.
      if (line === null) return refuse(peer, 'chat: inadmissible')
      return { broadcast: { t: 'chat', from: peer.id, name: peer.name, text: line, tick: room.tick } }
    }
    case 'ping':
      if (!take(peer.buckets.ping, now)) return refuse(peer, 'ping: over rate')
      if (msg.seq <= peer.said) return refuse(peer, 'ping: stale seq')
      peer.said = msg.seq
      peer.seen = now
      return { broadcast: { t: 'ping', from: peer.id, kind: msg.kind, x: msg.x, y: msg.y, z: msg.z, tick: room.tick } }
    case 'leave':
      return { left: true }
  }
}

/**
 * An input frame the core refused before reading it (malformed or forged, from a joined peer): counted as a refusal,
 * and answered with a correction like any input the room will not keep.
 */
export function refuseInput(room: Room, peer: Peer, reason: string, now: number): Outcome {
  const counted = refuse(peer, reason)
  const fixed = correct(room, peer, reason, now)
  return { ...fixed, ...(counted.kick && { kick: counted.kick }) }
}

/** Removes a peer (its body leaves the authority); the broadcast for the others when it had joined, else null. */
export function depart(room: Room, peer: Peer, reason: string): LeftMessage | null {
  room.peers.delete(peer.id)
  if (!peer.joined) return null
  room.authority.leave(peer.id)
  return { t: 'left', id: peer.id, reason, tick: room.tick }
}

/** One fixed tick: the snapshots' clock counts up (the authority has already moved everyone, input by input). */
export function tickRoom(room: Room): void {
  room.tick++
}

/** The snapshot for one peer after a tick: its own truth, every other joined player's, and the newest input seq kept. */
export function snapshotFor(room: Room, peer: Peer, players: RemotePlayer[] = poses(room)): SnapshotMessage {
  return { t: 'snapshot', tick: room.tick, ack: peer.seq, fix: peer.fix, you: pose(peer, true), players: players.filter((p) => p.id !== peer.id) }
}

/** Peers the host should drop at `now`: not joined in time, or joined and silent too long; each with its reason. */
export function expired(room: Room, now: number): { peer: Peer; reason: string }[] {
  const out: { peer: Peer; reason: string }[] = []
  for (const p of room.peers.values()) {
    if (!p.joined && now - p.arrived >= LIMITS.joinTimeoutMs) out.push({ peer: p, reason: 'join timeout' })
    else if (p.joined && now - p.seen >= LIMITS.idleTimeoutMs) out.push({ peer: p, reason: 'idle' })
  }
  return out
}

// ---------------------------------------------------------------------------------------------------
// The page's replica: reconciliation with the authoritative snapshot

/**
 * What the page holds of the room: the newest snapshot's tick, the newest input seq and correction the host has
 * acknowledged, this client's own truth, and every other player's pose, by id. The local avatar stays the local
 * realm's (the prediction); `you` is what the host says, which the client snaps to only on a correction.
 */
export interface Replica {
  /** This client's own id. */
  self: number
  tick: number
  /** The newest input seq the host has kept from this client. */
  ack: number
  /** The newest correction the host has made (the welcome is the first). */
  fix: number
  /** This client's truth in the newest snapshot (null before the first). */
  you: RemotePlayer | null
  players: readonly RemotePlayer[]
}

export const emptyReplica = (self: number): Replica => Object.freeze({ self, tick: 0, ack: 0, fix: 0, you: null, players: Object.freeze([]) })

/**
 * The replica after a snapshot: the host's word replaces every remote pose and this client's truth; an entry for this
 * client among the others is dropped; a snapshot no newer than the one held is ignored (out of order or repeated).
 * Deterministic: the same replica and the same snapshot always give the same result, players by rising id, frozen.
 */
export function reconcile(r: Replica, s: SnapshotMessage): Replica {
  if (s.tick <= r.tick) return r
  const players = s.players.filter((p) => p.id !== r.self).sort((a, b) => a.id - b.id)
  return Object.freeze({ self: r.self, tick: s.tick, ack: Math.max(r.ack, s.ack), fix: Math.max(r.fix, s.fix), you: s.you, players: Object.freeze(players) })
}

/** Inputs the host has not yet applied: those with a seq above the replica's ack. */
export const pending = (inputs: readonly InputMessage[], ack: number): InputMessage[] => inputs.filter((i) => i.seq > ack)

/** A remote pose carried forward by its own velocity for `dt` seconds (at most LIMITS.predictS), within the world's range. */
export function predict(p: RemotePlayer, dt: number): RemotePlayer {
  const t = clamp(Number.isFinite(dt) ? dt : 0, 0, LIMITS.predictS)
  if (t === 0) return p
  return Object.freeze({ ...p, x: clamp(p.x + p.vx * t, -LIMITS.range, LIMITS.range), z: clamp(p.z + p.vz * t, -LIMITS.range, LIMITS.range) })
}

/** The shortest turn from heading a to heading b, rad, in (−π, π]. */
const turn = (a: number, b: number): number => {
  let d = (b - a) % (Math.PI * 2)
  if (d > Math.PI) d -= Math.PI * 2
  if (d <= -Math.PI) d += Math.PI * 2
  return d
}

/** A pose between two of the same player (alpha 0 = a, 1 = b), the heading on the shortest arc. */
export function blend(a: RemotePlayer, b: RemotePlayer, alpha: number): RemotePlayer {
  const k = clamp(Number.isFinite(alpha) ? alpha : 0, 0, 1)
  const mix = (p: number, q: number): number => p + (q - p) * k
  return Object.freeze({
    id: b.id, name: b.name, driving: b.driving,
    x: mix(a.x, b.x), y: mix(a.y, b.y), z: mix(a.z, b.z),
    heading: a.heading + turn(a.heading, b.heading) * k,
    vx: mix(a.vx, b.vx), vz: mix(a.vz, b.vz), speed: mix(a.speed, b.speed),
  })
}
