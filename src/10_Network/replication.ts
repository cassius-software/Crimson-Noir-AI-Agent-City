/**
 * Why does this file exist? It is the protocol core of the replication scaffold, the one language the page's client
 * (netClient.ts) and the Node host (replication.node.ts) share, written the way simProtocol.ts writes the realm
 * boundary: every message is plain data (numbers, strings, booleans), and every message is read as untrusted. The
 * validators refuse anything malformed the way simHost does (shape, finite numbers, bounds, string lengths, sequence
 * order) and hand back a frozen copy with nothing extra in it. The room is server-authoritative: a peer sends inputs
 * (a desired walking velocity and a heading), the room integrates them on its own fixed tick, clamped to a run and to
 * the world's range, and the snapshot it sends is the truth. On the page a remote player is only a pose that is drawn,
 * modelled on the pose buffer's layout (REMOTE_POSE), never a body in the physics realm: the kernel stays single. Every
 * peer has token buckets (inputs per second, chat per minute, pings per second), every refusal is counted and a peer
 * that keeps earning them is removed. The 14A screen of 02_Define_The_Rules/conduct.ts reads every player name and
 * every chat line: an inadmissible one is dropped silently and counted, so a griefer gets no reaction and no stage.
 * Every frame on the wire is sealed (02_Define_The_Rules/integrity.ts): an envelope number that must rise, and an
 * HMAC-SHA256 under the session token over the canonical message, checked on both sides before the message is read
 * any further, so a forged, altered or replayed frame is refused and counted like any other malformed one.
 * Pure: no socket, no clock of its own (the caller passes `now`), no randomness, no I/O.
 * What breaks if it is removed? The client and the host have no agreed language, nothing vets what a peer says, and a
 * remote player could become a body in the realm.
 */
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { canonical, hmacSha256, isDigest, sameDigest } from '../02_Define_The_Rules/integrity.ts'
import { RUN } from '../07_Execute_Actions/simProtocol.ts'
import { PING_KINDS, type PingKind } from '../08_Swarm/ping.ts'

/** The protocol's version; a join naming another is refused. 2: every frame is sealed (sealMessage). */
export const PROTOCOL_VERSION = 2

/** Every bound the validators and the room enforce, frozen. */
export const LIMITS = Object.freeze({
  /** A player's name, characters (trimmed, printable). */
  name: 24,
  /** One chat line, characters. */
  chat: 240,
  /** A session token, characters. */
  token: 512,
  /** One encoded message (one text frame), bytes. */
  message: 4096,
  /** Peers a room holds at once (joined or not). */
  peers: 32,
  /** |x| and |z| of any position or ping, m; |y| at most `height`. */
  range: 4096,
  height: 1024,
  /** Inputs a peer may send: a steady rate and the burst it may bank. */
  inputsPerSecond: 60,
  inputBurst: 120,
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
  /** A joined peer silent for this long is dropped, ms. */
  idleTimeoutMs: 15000,
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

/** Client → host: the first message, once; `token` is the session token the operator handed out. */
export interface JoinMessage { t: 'join'; v: number; token: string; name: string }
/**
 * Client → host: one frame of input. `x`, `z` is the desired walking velocity (m/s, the room caps it at a run) and
 * `heading` the way the player faces (rad). `seq` rises by one per input; `ack` is the newest snapshot tick seen.
 */
export interface InputMessage { t: 'input'; seq: number; ack: number; x: number; z: number; heading: number }
/** Client → host: the newest snapshot tick seen, from an idle client. */
export interface AckMessage { t: 'ack'; ack: number }
/** Client → host: a chat line for the room. */
export interface ChatMessage { t: 'chat'; seq: number; text: string }
/** Client → host: a ping or rally mark (08_Swarm/ping.ts kinds) for the room to relay. */
export interface PingMessage { t: 'ping'; seq: number; kind: PingKind; x: number; y: number; z: number }
/** Client → host: goodbye. */
export interface LeaveMessage { t: 'leave' }
export type ClientMessage = JoinMessage | InputMessage | AckMessage | ChatMessage | PingMessage | LeaveMessage

/** Host → client: the answer to a good join. */
export interface WelcomeMessage { t: 'welcome'; v: number; id: number; tick: number; tickHz: number; players: RemotePlayer[] }
/** Host → client, every tick: every joined player's pose; `ack` is the newest input seq the room applied from this peer. */
export interface SnapshotMessage { t: 'snapshot'; tick: number; ack: number; players: RemotePlayer[] }
export interface ChatRelayMessage { t: 'chat'; from: number; name: string; text: string; tick: number }
export interface PingRelayMessage { t: 'ping'; from: number; kind: PingKind; x: number; y: number; z: number; tick: number }
export interface JoinedMessage { t: 'joined'; player: RemotePlayer; tick: number }
export interface LeftMessage { t: 'left'; id: number; reason: string; tick: number }
export type ServerMessage = WelcomeMessage | SnapshotMessage | ChatRelayMessage | PingRelayMessage | JoinedMessage | LeftMessage

/** What a validator says: the message as a frozen plain copy, or why it was refused. */
export type Read<T> = { ok: true; msg: T } | { ok: false; reason: string }

const refusal = <T,>(reason: string): Read<T> => ({ ok: false, reason })
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
  const { id, x, y, z, heading, vx, vz, speed } = u
  const name = admissibleName(u.name)
  if (!count(id) || name === null || !fin(x, -LIMITS.range, LIMITS.range) || !fin(y, -LIMITS.height, LIMITS.height) || !fin(z, -LIMITS.range, LIMITS.range)) return null
  if (!fin(heading, -Math.PI * 2, Math.PI * 2) || !fin(vx, -RUN, RUN) || !fin(vz, -RUN, RUN) || !fin(speed, 0, RUN)) return null
  return Object.freeze({ id, name, x, y, z, heading, vx, vz, speed })
}

function players(u: unknown): RemotePlayer[] | null {
  if (!Array.isArray(u) || u.length > LIMITS.peers) return null
  const out: RemotePlayer[] = []
  for (const p of u) {
    const r = player(p)
    if (!r) return null
    out.push(r)
  }
  return out
}

/** A client's message, checked field by field; anything else in it is never read. */
export function readClientMessage(u: unknown): Read<ClientMessage> {
  if (!isRecord(u)) return refusal('not a message object')
  switch (u.t) {
    case 'join': {
      if (u.v !== PROTOCOL_VERSION) return refusal(`join: protocol ${String(u.v)} is not ${PROTOCOL_VERSION}`)
      if (!text(u.token, LIMITS.token) || u.token.length === 0) return refusal('join: token')
      if (!text(u.name, LIMITS.name)) return refusal('join: name')
      return { ok: true, msg: Object.freeze({ t: 'join', v: PROTOCOL_VERSION, token: u.token, name: u.name }) }
    }
    case 'input': {
      if (!count(u.seq) || !count(u.ack)) return refusal('input: seq and ack')
      if (!fin(u.x, -RUN, RUN) || !fin(u.z, -RUN, RUN)) return refusal('input: velocity')
      if (!fin(u.heading, -Math.PI * 2, Math.PI * 2)) return refusal('input: heading')
      return { ok: true, msg: Object.freeze({ t: 'input', seq: u.seq, ack: u.ack, x: u.x, z: u.z, heading: u.heading }) }
    }
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
      return refusal(`unknown message '${String(u.t)}'`)
  }
}

/** The host's message as the client checks it: the host is not trusted either. */
export function readServerMessage(u: unknown): Read<ServerMessage> {
  if (!isRecord(u)) return refusal('not a message object')
  switch (u.t) {
    case 'welcome': {
      if (u.v !== PROTOCOL_VERSION) return refusal(`welcome: protocol ${String(u.v)} is not ${PROTOCOL_VERSION}`)
      if (!count(u.id) || !count(u.tick) || !fin(u.tickHz, 1, 240)) return refusal('welcome: id, tick and tickHz')
      const list = players(u.players)
      if (!list) return refusal('welcome: players')
      return { ok: true, msg: Object.freeze({ t: 'welcome', v: PROTOCOL_VERSION, id: u.id, tick: u.tick, tickHz: u.tickHz, players: list }) }
    }
    case 'snapshot': {
      if (!count(u.tick) || !count(u.ack)) return refusal('snapshot: tick and ack')
      const list = players(u.players)
      if (!list) return refusal('snapshot: players')
      return { ok: true, msg: Object.freeze({ t: 'snapshot', tick: u.tick, ack: u.ack, players: list }) }
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
      return refusal(`unknown message '${String(u.t)}'`)
  }
}

/** One text frame as JSON, bounded, then read as `read` reads it. */
export function decode<T>(wire: string, read: (u: unknown) => Read<T>): Read<T> {
  if (typeof wire !== 'string') return refusal('not text')
  if (wire.length > LIMITS.message) return refusal(`message longer than ${LIMITS.message}`)
  let u: unknown
  try {
    u = JSON.parse(wire)
  } catch {
    return refusal('not JSON')
  }
  return read(u)
}

export const decodeClientMessage = (wire: string): Read<ClientMessage> => decode(wire, readClientMessage)
export const decodeServerMessage = (wire: string): Read<ServerMessage> => decode(wire, readServerMessage)

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

/** `msg` sealed as envelope `n` under `key`, for the wire. */
export function sealMessage(msg: ClientMessage | ServerMessage, n: number, key: string): string {
  if (!count(n)) throw new RangeError(`sealMessage: n ${String(n)}`)
  return JSON.stringify({ n, body: msg, mac: hmacSha256(key, canonical({ n, body: msg })) })
}

/** The wire as an envelope: bounded text, JSON, the shape, before anything in it is trusted. */
export function readEnvelope(wire: unknown): Read<SealedFrame> {
  if (typeof wire !== 'string') return refusal('not text')
  if (wire.length > LIMITS.message) return refusal(`message longer than ${LIMITS.message}`)
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
export function sealFault(env: SealedFrame, key: string, after: number): string | null {
  let want: string
  try {
    want = hmacSha256(key, canonical({ n: env.n, body: env.body }))
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
export function openClientFrame(peer: Peer, wire: unknown): Read<ClientMessage> {
  const env = readEnvelope(wire)
  if (!env.ok) return env
  const read = readClientMessage(env.msg.body)
  if (!read.ok) return read
  const key = peer.joined ? peer.key : read.msg.t === 'join' ? read.msg.token : ''
  if (key === '') return refusal(`${read.msg.t} before join`)
  const fault = sealFault(env.msg, key, peer.received)
  if (fault !== null) return refusal(fault)
  peer.received = env.msg.n
  return read
}

/** The host's frame opened on the page: the envelope, the message's shape, the seal under the session token, a number above `after`. */
export function openServerFrame(wire: unknown, key: string, after: number): Opened<ServerMessage> {
  const env = readEnvelope(wire)
  if (!env.ok) return env
  const read = readServerMessage(env.msg.body)
  if (!read.ok) return read
  const fault = sealFault(env.msg, key, after)
  if (fault !== null) return { ok: false, reason: fault }
  return { ok: true, msg: read.msg, n: env.msg.n }
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

export interface PeerBuckets { input: Bucket; chat: Bucket; ping: Bucket }

/** A new peer's buckets, full. */
export const peerBuckets = (now: number): PeerBuckets => ({
  input: bucket(LIMITS.inputBurst, LIMITS.inputsPerSecond, now),
  chat: bucket(LIMITS.chatPerMinute, LIMITS.chatPerMinute / 60, now),
  ping: bucket(LIMITS.pingBurst, LIMITS.pingsPerSecond, now),
})

// ---------------------------------------------------------------------------------------------------
// The authoritative room

/** One peer as the room holds it; `joined` is false between the socket and a good join. */
export interface Peer {
  id: number
  name: string
  joined: boolean
  /** The newest input seq applied. */
  seq: number
  /** The newest chat or ping seq relayed. */
  said: number
  /** The newest snapshot tick the peer acknowledged. */
  ack: number
  refusals: number
  buckets: PeerBuckets
  /** The session token the peer joined with: the key its frames are sealed under both ways ('' until it has joined). */
  key: string
  /** The newest envelope number received from the peer (openClientFrame): the next must be above it. */
  received: number
  /** When the socket arrived and when the peer last said anything well-formed, ms. */
  arrived: number
  seen: number
  x: number
  y: number
  z: number
  heading: number
  vx: number
  vz: number
}

export interface Room {
  tick: number
  tickHz: number
  /** The next peer id. */
  next: number
  peers: Map<number, Peer>
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

export const createRoom = (tickHz: number = LIMITS.tickHz): Room => ({ tick: 0, tickHz, next: 1, peers: new Map() })

/** A socket arrived: a new, unjoined peer, or null when the room is full. */
export function admit(room: Room, now: number): Peer | null {
  if (room.peers.size >= LIMITS.peers) return null
  const peer: Peer = {
    id: room.next++, name: '', joined: false, seq: 0, said: 0, ack: 0, refusals: 0, buckets: peerBuckets(now), key: '', received: 0,
    arrived: now, seen: now, x: 0, y: 0, z: 0, heading: 0, vx: 0, vz: 0,
  }
  room.peers.set(peer.id, peer)
  return peer
}

/** Counts one refusal against a peer; past the limit, the peer is to be removed. */
export function refuse(peer: Peer, reason: string): Outcome {
  peer.refusals++
  return peer.refusals >= LIMITS.refusalsBeforeKick ? { refused: reason, kick: 'repeated refusals' } : { refused: reason }
}

const pose = (p: Peer): RemotePlayer => Object.freeze({ id: p.id, name: p.name, x: p.x, y: p.y, z: p.z, heading: p.heading, vx: p.vx, vz: p.vz, speed: Math.hypot(p.vx, p.vz) })

/** Every joined player's pose, by id. */
export function poses(room: Room): RemotePlayer[] {
  const out: RemotePlayer[] = []
  for (const p of room.peers.values()) if (p.joined) out.push(pose(p))
  return out
}

/**
 * One well-formed message from a peer, applied. `verify` says whether a session token is good (the host's HMAC check);
 * the room only knows that it must be. Nothing here replies to a refusal: a malformed, out-of-order, over-rate or
 * inadmissible message is silently counted, exactly as the physics worker treats the page.
 */
export function handle(room: Room, peer: Peer, msg: ClientMessage, now: number, verify: (token: string) => boolean): Outcome {
  if (!peer.joined) {
    if (msg.t !== 'join') return refuse(peer, `${msg.t} before join`)
    if (!verify(msg.token)) return refuse(peer, 'join: bad token')
    const name = admissibleName(msg.name)
    if (name === null) return refuse(peer, 'join: name')
    peer.joined = true
    peer.name = name
    peer.key = msg.token
    peer.seen = now
    const me = pose(peer)
    const others = poses(room).filter((p) => p.id !== peer.id)
    return {
      reply: { t: 'welcome', v: PROTOCOL_VERSION, id: peer.id, tick: room.tick, tickHz: room.tickHz, players: others },
      broadcast: { t: 'joined', player: me, tick: room.tick },
    }
  }
  switch (msg.t) {
    case 'join':
      return refuse(peer, 'join: already joined')
    case 'input': {
      if (!take(peer.buckets.input, now)) return refuse(peer, 'input: over rate')
      if (msg.seq <= peer.seq) return refuse(peer, 'input: stale seq')
      if (msg.ack > room.tick) return refuse(peer, 'input: ack from the future')
      peer.seq = msg.seq
      peer.ack = Math.max(peer.ack, msg.ack)
      peer.seen = now
      const speed = Math.hypot(msg.x, msg.z)
      const k = speed > RUN ? RUN / speed : 1
      peer.vx = msg.x * k
      peer.vz = msg.z * k
      peer.heading = msg.heading
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

/** Removes a peer; the broadcast for the others when it had joined, else null. */
export function depart(room: Room, peer: Peer, reason: string): LeftMessage | null {
  room.peers.delete(peer.id)
  return peer.joined ? { t: 'left', id: peer.id, reason, tick: room.tick } : null
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v)

/** One fixed tick: every joined peer moves by its velocity, kept within the world's range; the tick counts up. */
export function tickRoom(room: Room): void {
  const dt = 1 / room.tickHz
  for (const p of room.peers.values()) {
    if (!p.joined) continue
    p.x = clamp(p.x + p.vx * dt, -LIMITS.range, LIMITS.range)
    p.z = clamp(p.z + p.vz * dt, -LIMITS.range, LIMITS.range)
  }
  room.tick++
}

/** The snapshot for one peer after a tick: every joined player, and the newest input seq applied from this peer. */
export function snapshotFor(room: Room, peer: Peer, players: RemotePlayer[] = poses(room)): SnapshotMessage {
  return { t: 'snapshot', tick: room.tick, ack: peer.seq, players }
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

/** What the page holds of the room: the newest snapshot's tick and ack, and every other player's pose, by id. */
export interface Replica {
  /** This client's own id (its own pose is never taken from a snapshot: the local avatar is the local realm's). */
  self: number
  tick: number
  /** The newest input seq the host has applied from this client. */
  ack: number
  players: readonly RemotePlayer[]
}

export const emptyReplica = (self: number): Replica => Object.freeze({ self, tick: 0, ack: 0, players: Object.freeze([]) })

/**
 * The replica after a snapshot: the host's word replaces every remote pose; this client's own entry is dropped; a
 * snapshot no newer than the one held is ignored (out of order or repeated). Deterministic: the same replica and the
 * same snapshot always give the same result, players by rising id, frozen.
 */
export function reconcile(r: Replica, s: SnapshotMessage): Replica {
  if (s.tick <= r.tick) return r
  const players = s.players.filter((p) => p.id !== r.self).sort((a, b) => a.id - b.id)
  return Object.freeze({ self: r.self, tick: s.tick, ack: Math.max(r.ack, s.ack), players: Object.freeze(players) })
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
    id: b.id, name: b.name,
    x: mix(a.x, b.x), y: mix(a.y, b.y), z: mix(a.z, b.z),
    heading: a.heading + turn(a.heading, b.heading) * k,
    vx: mix(a.vx, b.vx), vz: mix(a.vz, b.vz), speed: mix(a.speed, b.speed),
  })
}
