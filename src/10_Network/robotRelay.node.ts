// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the loopback robot relay of the joint bridge (docs/joint-bridge-spec.md §3.2): the
 * second Node module that serves the network, beside the room host (replication.node.ts), bound to 127.0.0.1 unless
 * ROBOT_HOST says otherwise, on port 8790 (ROBOT_PORT). The page never opens a socket off this machine, so whatever is
 * not on it (a ROS 2 bridge, a vendor adapter, the simulated arm, a Sparkplug B broker's devices) reaches the page
 * through here. Two WebSocket doors, text frames only: `/` for the page, which needs the page token as `auth.<token>`
 * beside `joints.1` in the subprotocol list and a loopback Origin (an absent or `null` Origin is 403, a wrong token
 * 401, both with no socket); `/robot` for a peer, which needs the robot token the same way. A peer says hello with a
 * manifest or a URDF and its CAPS body, is welcomed with an id (`ws:<n>`) and the movable joints' order, and then
 * sends frames at its rate; the relay keeps the newest per robot and flushes them to every page at most 120 times a
 * second. The page arms a robot with a nonce, the peer echoes it, and from then on, for that page connection alone, the
 * relay forwards setpoints through its own gate (a second gate, not the gate: peripheralPolicy.ts admit on the page is
 * the gate): a rising seq, finite numbers, arrays of the manifest's length, issuedAt within ttlMs by the relay's clock
 * plus 100 ms of round trip, under 25 a second per robot; anything else is dropped and `{t:'refused'}` says why. When
 * the page that armed a robot closes, the robot is told `disarm page-gone`. With ROBOT_MQTT set the relay is also a
 * Sparkplug B host (sparkplugHost.node.ts): a broker's device whose birth carries a manifest is a robot like any
 * other, its DDATA frames judged by the same checkFrame, its setpoints going out as DCMDs. The RFC 6455 frames, the
 * tokens and the socket rules are replication.node.ts's, reused as they are. Every count (frames, accepted, refused
 * by reason, disarmed) is kept and printed on SIGINT. Run it with `npm run serve:robots`.
 * What breaks if it is removed? The page can reach a robot only over a serial or BLE line it was granted; nothing off
 * this machine, and no broker, can stand in the realm.
 */
import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import { checkFrame, checkTargets, manifestJson, readManifest, type Checked, type JointFrame, type JointTargets, type Manifest } from '../04_Connect_Hardware/jointState.ts'
import { parseUrdf } from '../04_Connect_Hardware/urdf.ts'
import { parseCapabilities, type Capabilities } from '../04_Connect_Hardware/peripheralPolicy.ts'
import {
  acceptKey, closePayload, HEADERS_TIMEOUT_MS, loggable, MAX_BACKLOG, MIN_SECRET, mintToken, OP, offeredToken, readFrame, TOKEN_TTL_MS, verifyToken, writeFrame,
} from './replication.node.ts'
import { armMetrics, commandMetrics, disarmMetrics, type SparkplugRobot } from './sparkplug.ts'
import { startSparkplugHost, type SparkplugEvent, type SparkplugHost, type SparkplugHostOptions } from './sparkplugHost.node.ts'

/** The door's subprotocol; the token rides beside it as `auth.<token>` (replication.node.ts offeredToken). */
export const RELAY_SUBPROTOCOL = 'joints.1'
export const RELAY_PORT = 8790
/** The two tokens' subjects: a page token opens `/`, a robot token `/robot`, never the other way. */
export const SUBJECTS = Object.freeze({ page: 'page', robot: 'robot' } as const)
export const RELAY = Object.freeze({
  /** One WebSocket frame, bytes. */
  frame: 1 << 20,
  /** A peer's hello (a URDF can be long), bytes. */
  hello: 512 * 1024,
  /** A state or targets message, bytes. */
  message: 16 * 1024,
  /** Unread bytes past which a page or a peer is too slow to keep. */
  backlog: MAX_BACKLOG,
  /** Setpoints forwarded per robot per rolling second; the page itself sends at most 20. */
  targetsPerSecond: 25,
  /** How far past ttlMs an issuedAt may be by the relay's clock: the page's round trip to here. */
  roundTripMs: 100,
  /** Frames are flushed to the pages at most this often. */
  flushHz: 120,
  pages: 8,
  peers: 64,
  nonce: 64,
  cause: 64,
})

/**
 * Whether an Origin header is a loopback origin: http or https, the host 127.0.0.1, localhost or [::1], any port. An
 * absent or `null` Origin (a file: page, a sandboxed frame, a non-browser client) is not one: the page token could
 * otherwise be replayed by anything that learnt it.
 */
export function loopbackOrigin(origin: unknown): boolean {
  if (typeof origin !== 'string' || origin.length === 0 || origin.length > 256 || origin === 'null') return false
  let u: URL
  try { u = new URL(origin) } catch { return false }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
  if (u.pathname !== '/' || u.search !== '' || u.hash !== '' || u.username !== '' || u.password !== '') return false
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]'
}

export interface RobotInfo {
  id: string
  name: string
  via: 'ws' | 'mqtt'
  manifest: Manifest
  /** The CAPS body as the robot declared it (`{class, telemetry, actuation}`; the page runs it through the gate's own parseCapabilities), or null for a sensor. */
  caps: Record<string, unknown> | null
}

export type ToPage =
  | { t: 'hello'; relay: { v: 1; mqtt: string | null }; robots: RobotInfo[] }
  | ({ t: 'robot'; id: string; gone?: true } & Partial<Omit<RobotInfo, 'id'>>)
  | { t: 'state'; id: string; frame: JointFrame }
  | { t: 'armed'; id: string; nonce: string }
  | { t: 'beat'; id: string; n: number }
  | { t: 'ack'; id: string; seq: number }
  | { t: 'echo'; seq: number; at: number }
  | { t: 'refused'; id: string; why: string }
  /** The relay disarmed a robot on its own (the peer gone, a rebirth, the relay closing): told to the page that armed it. */
  | { t: 'disarm'; id: string; cause: string }

export type ToPeer =
  | { t: 'welcome'; id: string; manifest: Manifest; order: string[] }
  | { t: 'arm'; nonce: string }
  | { t: 'disarm'; cause: string }
  | { t: 'targets'; setpoints: JointTargets }

export interface RelayOptions {
  /** The secret both tokens are minted from; at least MIN_SECRET characters. */
  secret: string
  /** Loopback unless the operator says otherwise. */
  host?: string
  /** 0 picks a free port. */
  port?: number
  headersTimeoutMs?: number
  maxBacklog?: number
  /** Frames flushed to the pages at most this often (tests lower it to see the newest frame win). */
  flushHz?: number
  /** Wall clock, ms (injectable for tests). */
  now?: () => number
  log?: (line: string) => void
  /** With it the relay is also a Sparkplug B host application on that broker. */
  mqtt?: Omit<SparkplugHostOptions, 'onEvent' | 'now' | 'log'>
}

export interface RelayStats {
  pages: number
  peers: number
  robots: number
  /** Upgrades refused: a wrong or missing token (401), a page without a loopback Origin (403). */
  unauthorized: number
  forbidden: number
  /** Frames taken from robots; setpoints forwarded; disarms the relay sent or recorded. */
  frames: number
  accepted: number
  disarmed: number
  /** Everything dropped, by reason. */
  refused: Record<string, number>
  mqtt: { sessions: number; online: boolean; rebirths: number; ignored: number; devices: number } | null
}

export interface Relay {
  readonly host: string
  readonly port: number
  /** The URL the page joins; a peer joins `${url}/robot`. */
  readonly url: string
  /** A token for `page` or `robot`, good for `ttlMs` from now. */
  token(subject: string, ttlMs?: number): string
  stats(): RelayStats
  /** Sockets open, pages and peers. */
  connections(): number
  robots(): RobotInfo[]
  /** Disarms every armed robot, closes every socket and the server. */
  close(): Promise<void>
}

type Json = Record<string, unknown>

interface Page { kind: 'page'; n: number; socket: Socket; buf: Buffer; closing: boolean }
interface Peer { kind: 'peer'; n: number; socket: Socket; buf: Buffer; closing: boolean; robot: Robot | null }
type Conn = Page | Peer

interface Robot {
  info: RobotInfo
  /** Declared `servo` in an actuator's CAPS (and, over MQTT, the command metrics in its birth). */
  armable: boolean
  frame: JointFrame | null
  /** The newest frame not yet flushed to the pages. */
  pending: JointFrame | null
  /** The page connection that armed (or is arming) this robot. */
  armedBy: Page | null
  nonce: string | null
  /** The peer echoed the nonce: setpoints may flow. */
  armed: boolean
  lastSeq: number
  /** When setpoints were forwarded in the last second. */
  sentAt: number[]
  peer: Peer | null
  sp: SparkplugRobot | null
}

/** How long a refused upgrade's socket is given to flush its HTTP answer before it is destroyed, ms. */
const REFUSED_LINGER_MS = 1000

const servoDeclared = (caps: Capabilities | null): boolean => caps !== null && caps.deviceClass === 'actuator' && caps.actuation.includes('servo')

/**
 * A hello's `caps` (an object, or the body as text) through the gate's own reader, so one judge serves every door:
 * the body as it travels on to the page, and what the gate made of it.
 */
function readCaps(caps: unknown): { body: Record<string, unknown> | null; caps: Capabilities | null } | { error: string } {
  if (caps === undefined || caps === null) return { body: null, caps: null }
  const text = typeof caps === 'string' ? caps : JSON.stringify(caps)
  if (typeof text !== 'string' || /[\r\n]/.test(text)) return { error: 'caps: not a CAPS body' }
  const read = parseCapabilities(`CAPS 1 ${text}`)
  if (read === null) return { error: 'caps: not a CAPS body' }
  if ('error' in read) return { error: `caps: ${read.error}` }
  return { body: JSON.parse(text) as Record<string, unknown>, caps: read }
}

/** One message as it arrives: a JSON object with a string `t`, or null. */
function parseMessage(text: string): (Json & { t: string }) | null {
  let v: unknown
  try { v = JSON.parse(text) } catch { return null }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const m = v as Json
  return typeof m.t === 'string' ? (m as Json & { t: string }) : null
}

export async function startRelay(o: RelayOptions): Promise<Relay> {
  const secretBytes = typeof o.secret === 'string' ? Buffer.from(o.secret, 'utf8') : Buffer.alloc(0)
  if (secretBytes.length < MIN_SECRET || secretBytes.includes(0)) throw new Error(`the relay's secret must be at least ${MIN_SECRET} characters (bytes of UTF-8, none of them NUL)`)
  const now = o.now ?? Date.now
  const log = o.log ?? ((): void => {})
  const bind = o.host ?? '127.0.0.1'
  const maxBacklog = o.maxBacklog ?? RELAY.backlog
  const flushMs = 1000 / (o.flushHz ?? RELAY.flushHz)
  const conns = new Set<Conn>()
  const pages = new Set<Page>()
  const robots = new Map<string, Robot>()
  let connCount = 0
  let peerCount = 0
  const stats = { unauthorized: 0, forbidden: 0, frames: 0, accepted: 0, disarmed: 0, refused: {} as Record<string, number> }

  // ------------------------------------------------------------------ sockets

  const write = (c: Conn, frame: Buffer): void => {
    if (!c.socket.writable) return
    if (c.socket.writableLength > maxBacklog) {
      if (!c.closing) close(c, 4009, 'too slow to keep up')
      c.socket.destroy()
      return
    }
    c.socket.write(frame)
  }
  const send = (c: Conn, msg: ToPage | ToPeer): void => {
    if (c.closing) return
    write(c, writeFrame(OP.text, Buffer.from(JSON.stringify(msg), 'utf8')))
  }
  const broadcast = (msg: ToPage): void => {
    for (const p of pages) send(p, msg)
  }
  /** Starts the close handshake and forgets the connection at once; the socket ends when the client answers or soon after. */
  const close = (c: Conn, code: number, reason: string): void => {
    if (c.closing) return
    c.closing = true
    c.buf = Buffer.alloc(0)
    conns.delete(c)
    if (c.kind === 'page') {
      pages.delete(c)
      for (const r of robots.values()) if (r.armedBy === c) disarm(r, 'page-gone', true)
    } else if (c.robot) {
      removeRobot(c.robot, reason)
    }
    log(`${c.kind} ${c.n} closed: ${loggable(reason)}`)
    if (c.socket.writable && c.socket.writableLength <= maxBacklog) c.socket.write(writeFrame(OP.close, closePayload(code, reason)))
    const t = setTimeout(() => c.socket.destroy(), 1000)
    t.unref()
    c.socket.once('close', () => clearTimeout(t))
    c.socket.end()
  }

  // ------------------------------------------------------------------ robots

  const refuse = (page: Page | null, id: string, why: string): void => {
    stats.refused[why] = (stats.refused[why] ?? 0) + 1
    log(`${id === '' ? 'page' : `robot ${loggable(id)}`}: refused: ${loggable(why)}`)
    if (page) send(page, { t: 'refused', id, why })
  }

  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const flush = (): void => {
    flushTimer = null
    for (const r of robots.values()) {
      if (r.pending === null) continue
      const frame = r.pending
      r.pending = null
      broadcast({ t: 'state', id: r.info.id, frame })
    }
  }
  const scheduleFlush = (): void => {
    if (flushTimer !== null) return
    flushTimer = setTimeout(flush, flushMs)
    flushTimer.unref()
  }
  /** A frame as a robot sent it: judged against its manifest, kept when good (the newest wins the next flush). */
  const takeFrame = (r: Robot, frame: unknown): void => {
    const read = checkFrame(r.info.manifest.movable.length, frame)
    if (!read.ok) { refuse(null, r.info.id, `state: ${read.reason}`); return }
    r.frame = read.value
    r.pending = read.value
    stats.frames++
    scheduleFlush()
  }

  /** The relay's word to a robot, by its door: a message to a peer, a DCMD to a broker's device. */
  const out = (r: Robot, msg: ToPeer): void => {
    if (r.peer) { send(r.peer, msg); return }
    if (!r.sp || !mqtt) return
    const t = now()
    const metrics = msg.t === 'arm' ? armMetrics(r.sp, msg.nonce, t) : msg.t === 'disarm' ? disarmMetrics(r.sp, msg.cause, t) : msg.t === 'targets' ? commandMetrics(r.sp, msg.setpoints, t) : null
    if (metrics) mqtt.command(r.info.id, metrics)
  }
  /** Disarms: the robot is told unless `tell` is false (it is gone); the page is told unless it asked itself. */
  const disarm = (r: Robot, cause: string, tell: boolean, asked: Page | null = null): void => {
    if (r.armedBy === null) return
    const page = r.armedBy
    r.armedBy = null
    r.nonce = null
    r.armed = false
    stats.disarmed++
    log(`robot ${loggable(r.info.id)} disarmed: ${loggable(cause)}`)
    if (tell) out(r, { t: 'disarm', cause })
    if (page !== asked) send(page, { t: 'disarm', id: r.info.id, cause })
  }
  const addRobot = (r: Robot): void => {
    robots.set(r.info.id, r)
    log(`robot ${loggable(r.info.id)} (${loggable(r.info.name)}, ${r.info.via}, ${r.info.manifest.movable.length} joints${r.armable ? ', servo' : ''}) joined`)
    broadcast({ t: 'robot', ...r.info })
  }
  const removeRobot = (r: Robot, why: string): void => {
    if (robots.get(r.info.id) !== r) return
    robots.delete(r.info.id)
    // Nobody is there to tell: the disarm is recorded, and the pages learn it from `gone`.
    disarm(r, why, false)
    log(`robot ${loggable(r.info.id)} gone: ${loggable(why)}`)
    broadcast({ t: 'robot', id: r.info.id, gone: true })
  }
  /** The page holding any arm: one page at a time arms, another may watch. */
  const armingPage = (): Page | null => {
    for (const r of robots.values()) if (r.armedBy) return r.armedBy
    return null
  }

  // ------------------------------------------------------------------ the page's door

  const onArm = (c: Page, id: unknown, nonce: unknown): void => {
    const r = typeof id === 'string' ? robots.get(id) : undefined
    if (!r) { refuse(c, typeof id === 'string' ? id : '', 'arm: unknown robot'); return }
    if (typeof nonce !== 'string' || nonce.length === 0 || nonce.length > RELAY.nonce) { refuse(c, r.info.id, 'arm: a nonce of 1 to 64 characters'); return }
    if (!r.armable) { refuse(c, r.info.id, 'arm: servo not declared'); return }
    const other = armingPage()
    if (other !== null && other !== c) { refuse(c, r.info.id, 'arm: another page is arming'); return }
    r.armedBy = c
    r.nonce = nonce
    r.armed = false
    r.lastSeq = -1
    r.sentAt = []
    out(r, { t: 'arm', nonce })
  }
  /** The second gate: the page's own gate judged these setpoints first; the relay forwards nothing it would not. */
  const onTargets = (c: Page, id: unknown, setpoints: unknown, bytes: number): void => {
    const r = typeof id === 'string' ? robots.get(id) : undefined
    if (!r) { refuse(c, typeof id === 'string' ? id : '', 'targets: unknown robot'); return }
    if (bytes > RELAY.message) { refuse(c, r.info.id, 'targets: over 16 KiB'); return }
    if (r.armedBy !== c) { refuse(c, r.info.id, 'targets: not armed by this page'); return }
    if (!r.armed) { refuse(c, r.info.id, 'targets: not armed'); return }
    const read = checkTargets(r.info.manifest.movable.length, setpoints)
    if (!read.ok) { refuse(c, r.info.id, `targets: ${read.reason}`); return }
    const t = read.value
    const at = now()
    if (t.seq <= r.lastSeq) { refuse(c, r.info.id, 'targets: stale seq'); return }
    if (at - t.issuedAt > t.ttlMs + RELAY.roundTripMs) { refuse(c, r.info.id, 'targets: expired issuedAt'); return }
    if (t.issuedAt - at > RELAY.roundTripMs) { refuse(c, r.info.id, 'targets: issuedAt ahead of the relay clock'); return }
    r.sentAt = r.sentAt.filter((x) => at - x < 1000)
    if (r.sentAt.length >= RELAY.targetsPerSecond) { refuse(c, r.info.id, 'targets: over rate'); return }
    r.sentAt.push(at)
    r.lastSeq = t.seq
    stats.accepted++
    out(r, { t: 'targets', setpoints: t })
  }
  const onPageMessage = (c: Page, text: string, bytes: number): void => {
    const m = parseMessage(text)
    if (m === null) { close(c, 1003, 'a text frame must be a JSON object with a string t'); return }
    switch (m.t) {
      case 'echo':
        if (typeof m.seq === 'number' && typeof m.at === 'number') send(c, { t: 'echo', seq: m.seq, at: m.at })
        else refuse(c, '', 'echo: seq and at are numbers')
        return
      case 'arm':
        onArm(c, m.id, m.nonce)
        return
      case 'disarm': {
        const r = typeof m.id === 'string' ? robots.get(m.id) : undefined
        if (!r) { refuse(c, typeof m.id === 'string' ? m.id : '', 'disarm: unknown robot'); return }
        if (r.armedBy !== c) { refuse(c, r.info.id, 'disarm: not armed by this page'); return }
        disarm(r, typeof m.cause === 'string' && m.cause.length > 0 && m.cause.length <= RELAY.cause ? m.cause : 'page', true, c)
        return
      }
      case 'targets':
        onTargets(c, m.id, m.setpoints, bytes)
        return
      default:
        refuse(c, '', `page: unknown message '${m.t.slice(0, 24)}'`)
    }
  }

  // ------------------------------------------------------------------ the peers' door

  const onHello = (c: Peer, m: Json, bytes: number): void => {
    if (bytes > RELAY.hello) { close(c, 1009, 'hello over 512 KiB'); return }
    if (m.v !== 1) { close(c, 4002, 'hello: v must be 1'); return }
    let read: Checked<Manifest>
    if (typeof m.urdf === 'string') read = parseUrdf(m.urdf)
    else if (typeof m.manifest === 'string') read = readManifest(m.manifest)
    else if (typeof m.manifest === 'object' && m.manifest !== null) read = readManifest(JSON.stringify(m.manifest))
    else { close(c, 4002, 'hello: a manifest or a urdf'); return }
    if (!read.ok) { close(c, 4002, `hello: ${read.reason}`); return }
    const caps = readCaps(m.caps)
    if ('error' in caps) { close(c, 4002, `hello: ${caps.error}`); return }
    const manifest = read.value
    const order = manifest.movable.map((ji) => manifest.joints[ji].name)
    if (c.robot) {
      // A second hello replaces the first only while the robot is disarmed (the HAL/1 rule for a second JOINTS).
      if (c.robot.armedBy !== null) { refuse(null, c.robot.info.id, 'hello: a second hello while armed'); return }
      c.robot.info = { ...c.robot.info, name: manifest.robot, manifest, caps: caps.body }
      c.robot.armable = servoDeclared(caps.caps)
      c.robot.frame = null
      c.robot.pending = null
      broadcast({ t: 'robot', ...c.robot.info })
      send(c, { t: 'welcome', id: c.robot.info.id, manifest, order })
      return
    }
    const id = `ws:${++peerCount}`
    const robot: Robot = {
      info: { id, name: manifest.robot, via: 'ws', manifest, caps: caps.body }, armable: servoDeclared(caps.caps),
      frame: null, pending: null, armedBy: null, nonce: null, armed: false, lastSeq: -1, sentAt: [], peer: c, sp: null,
    }
    c.robot = robot
    addRobot(robot)
    send(c, { t: 'welcome', id, manifest, order })
  }
  const onPeerMessage = (c: Peer, text: string, bytes: number): void => {
    const m = parseMessage(text)
    if (m === null) { close(c, 1003, 'a text frame must be a JSON object with a string t'); return }
    if (c.robot === null) {
      if (m.t === 'hello') onHello(c, m, bytes)
      else close(c, 4002, 'hello first')
      return
    }
    const r = c.robot
    switch (m.t) {
      case 'hello':
        onHello(c, m, bytes)
        return
      case 'state':
        if (bytes > RELAY.message) { refuse(null, r.info.id, 'state: over 16 KiB'); return }
        takeFrame(r, m.frame)
        return
      case 'armed':
        if (r.armedBy !== null && !r.armed && typeof m.nonce === 'string' && m.nonce === r.nonce) {
          r.armed = true
          log(`robot ${loggable(r.info.id)} armed by page ${r.armedBy.n}`)
          broadcast({ t: 'armed', id: r.info.id, nonce: m.nonce })
        } else refuse(null, r.info.id, 'armed: no arm with that nonce')
        return
      case 'beat':
        if (typeof m.n === 'number' && Number.isFinite(m.n)) broadcast({ t: 'beat', id: r.info.id, n: m.n })
        else refuse(null, r.info.id, 'beat: n is a number')
        return
      case 'ack':
        if (Number.isSafeInteger(m.seq) && (m.seq as number) >= 0) broadcast({ t: 'ack', id: r.info.id, seq: m.seq as number })
        else refuse(null, r.info.id, 'ack: seq is a whole number')
        return
      default:
        refuse(null, r.info.id, `peer: unknown message '${m.t.slice(0, 24)}'`)
    }
  }

  // ------------------------------------------------------------------ frames in

  const onFrame = (c: Conn, opcode: number, payload: Buffer): void => {
    switch (opcode) {
      case OP.text: {
        const text = payload.toString('utf8')
        if (c.kind === 'page') onPageMessage(c, text, payload.length)
        else onPeerMessage(c, text, payload.length)
        return
      }
      case OP.binary:
        close(c, 1003, 'text frames only')
        return
      case OP.ping:
        write(c, writeFrame(OP.pong, payload))
        return
      case OP.close:
        close(c, 1000, 'client closed')
        return
      default:
        return
    }
  }
  const onData = (c: Conn, chunk: Buffer): void => {
    if (c.closing) return
    c.buf = c.buf.length === 0 ? chunk : Buffer.concat([c.buf, chunk])
    while (!c.closing) {
      const r = readFrame(c.buf, RELAY.frame)
      if (r.kind === 'more') return
      if (r.kind === 'bad') { close(c, r.code, r.reason); return }
      c.buf = c.buf.subarray(r.used)
      onFrame(c, r.opcode, r.payload)
    }
  }

  // ------------------------------------------------------------------ the upgrade

  const turnAway = (socket: Socket, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    const t = setTimeout(() => socket.destroy(), REFUSED_LINGER_MS)
    t.unref()
    socket.once('close', () => clearTimeout(t))
  }
  const answered = new WeakSet<Socket>()
  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    answered.add(socket)
    socket.on('error', () => socket.destroy())
    const key = req.headers['sec-websocket-key']
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
      turnAway(socket, '400 Bad Request')
      return
    }
    const path = (req.url ?? '/').split('?')[0]
    const door = path === '/' ? 'page' : path === '/robot' ? 'peer' : null
    if (door === null) { turnAway(socket, '404 Not Found'); return }
    const from = socket.remoteAddress ?? '?'
    // The token first: the page's needs the subject `page`, a peer's `robot`; neither opens the other door.
    const token = offeredToken(req.headers['sec-websocket-protocol'], RELAY_SUBPROTOCOL)
    const subject = token === null ? null : verifyToken(o.secret, token, now())
    if (subject !== (door === 'page' ? SUBJECTS.page : SUBJECTS.robot)) {
      stats.unauthorized++
      log(`upgrade of ${path} from ${loggable(from)} refused: ${token === null ? 'no token offered' : subject === null ? 'a token that does not verify' : `a token for '${loggable(subject)}'`}`)
      turnAway(socket, '401 Unauthorized')
      return
    }
    // Then, for the page, where it came from: a loopback origin, or nothing.
    if (door === 'page' && !loopbackOrigin(req.headers.origin)) {
      stats.forbidden++
      log(`upgrade of / from ${loggable(from)} refused: Origin ${req.headers.origin === undefined ? 'absent' : loggable(req.headers.origin)} is not loopback`)
      turnAway(socket, '403 Forbidden')
      return
    }
    if (door === 'page' ? pages.size >= RELAY.pages : conns.size - pages.size >= RELAY.peers) { turnAway(socket, '503 Service Unavailable'); return }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: ${RELAY_SUBPROTOCOL}\r\n\r\n`)
    const n = ++connCount
    const c: Conn = door === 'page'
      ? { kind: 'page', n, socket, buf: Buffer.alloc(0), closing: false }
      : { kind: 'peer', n, socket, buf: Buffer.alloc(0), closing: false, robot: null }
    conns.add(c)
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => onData(c, chunk))
    socket.on('error', () => close(c, 1006, 'socket error'))
    socket.on('end', () => close(c, 1006, 'socket ended'))
    socket.on('close', () => close(c, 1006, 'socket closed'))
    log(`${c.kind} ${n} connected`)
    if (c.kind === 'page') {
      pages.add(c)
      send(c, { t: 'hello', relay: { v: 1, mqtt: mqtt?.hostId ?? null }, robots: [...robots.values()].map((r) => r.info) })
    }
    if (head.length > 0) onData(c, head)
  }

  const headersTimeout = o.headersTimeoutMs ?? HEADERS_TIMEOUT_MS
  const server: Server = createServer({ headersTimeout, requestTimeout: 2 * headersTimeout, connectionsCheckingInterval: Math.min(1000, headersTimeout) }, (req, res) => {
    answered.add(req.socket)
    res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket', connection: 'close' })
    res.end('Upgrade Required: this is the robot relay, a WebSocket host.\n')
  })
  server.on('upgrade', onUpgrade)
  server.on('connection', (socket: Socket) => {
    socket.on('error', () => socket.destroy())
    const t = setTimeout(() => { if (!answered.has(socket)) socket.destroy() }, headersTimeout)
    t.unref()
    socket.once('close', () => clearTimeout(t))
  })

  // ------------------------------------------------------------------ the broker's robots

  const onSparkplug = (e: SparkplugEvent): void => {
    switch (e.kind) {
      case 'session':
        log(`sparkplug: ${e.online ? 'online' : 'offline'}: ${loggable(e.why)}`)
        return
      case 'birth': {
        const caps = readCaps(e.robot.caps)
        if ('error' in caps) log(`robot ${loggable(e.id)}: ${caps.error}: read as a sensor`)
        const info: RobotInfo = { id: e.id, name: e.robot.manifest.robot, via: 'mqtt', manifest: e.robot.manifest, caps: 'error' in caps ? null : caps.body }
        const armable = e.robot.armable && servoDeclared('error' in caps ? null : caps.caps)
        const was = robots.get(e.id)
        if (was) {
          // Born again (after our Rebirth request, or the node's own): the same robot unless its manifest changed.
          if (was.armedBy !== null && manifestJson(was.info.manifest) !== manifestJson(info.manifest)) disarm(was, 'rebirth: another manifest', false)
          was.info = info
          was.armable = armable
          was.sp = e.robot
          broadcast({ t: 'robot', ...info })
        } else {
          addRobot({ info, armable, frame: null, pending: null, armedBy: null, nonce: null, armed: false, lastSeq: -1, sentAt: [], peer: null, sp: e.robot })
        }
        takeFrame(robots.get(e.id)!, e.read.frame)
        return
      }
      case 'data': {
        const r = robots.get(e.id)
        if (!r) return
        takeFrame(r, e.read.frame)
        if (e.read.armed !== undefined && r.armedBy !== null && !r.armed && e.read.armed === r.nonce) {
          r.armed = true
          log(`robot ${loggable(r.info.id)} armed by page ${r.armedBy.n}`)
          broadcast({ t: 'armed', id: r.info.id, nonce: e.read.armed })
        }
        if (e.read.beat !== undefined) broadcast({ t: 'beat', id: r.info.id, n: e.read.beat })
        if (e.read.ack !== undefined) broadcast({ t: 'ack', id: r.info.id, seq: e.read.ack })
        return
      }
      case 'gone': {
        const r = robots.get(e.id)
        if (r) removeRobot(r, e.why)
        return
      }
      default:
        return
    }
  }
  const mqtt: SparkplugHost | null = o.mqtt ? startSparkplugHost({ ...o.mqtt, now, log, onEvent: onSparkplug }) : null

  return new Promise<Relay>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port ?? 0, bind, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const hostname = bind.includes(':') ? `[${bind}]` : bind
      const url = `ws://${hostname}:${port}`
      log(`robot relay listening on ${url} (the page joins /, a peer /robot)${mqtt ? `; Sparkplug host ${mqtt.hostId}` : ''}`)
      resolve({
        host: bind,
        port,
        url,
        token: (subject, ttlMs = TOKEN_TTL_MS) => mintToken(o.secret, subject, now() + ttlMs),
        stats: () => ({ ...stats, refused: { ...stats.refused }, pages: pages.size, peers: conns.size - pages.size, robots: robots.size, mqtt: mqtt ? mqtt.stats() : null }),
        connections: () => conns.size,
        robots: () => [...robots.values()].map((r) => r.info),
        close: () =>
          new Promise<void>((done) => {
            if (flushTimer !== null) clearTimeout(flushTimer)
            flushTimer = null
            for (const r of robots.values()) disarm(r, 'relay-closing', true)
            for (const c of [...conns]) close(c, 1001, 'relay closing')
            const rest = (): void => {
              server.close(() => done())
              setTimeout(() => server.closeAllConnections(), 1100).unref()
            }
            if (mqtt) void mqtt.close().then(rest)
            else rest()
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------------------------------
// `npm run serve:robots`

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The secret: ROBOT_SECRET, or one made for this run (then the tokens exist only in this process: print them).
  const secret = process.env.ROBOT_SECRET ?? randomBytes(32).toString('hex')
  const port = Number(process.env.ROBOT_PORT ?? RELAY_PORT)
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('ROBOT_PORT must be a port number')
  const anyHost = process.env.ROBOT_MQTT_ANY_HOST
  if (anyHost !== undefined && anyHost !== '0' && anyHost !== '1') throw new Error('ROBOT_MQTT_ANY_HOST must be 0 or 1')
  const mqtt: RelayOptions['mqtt'] = process.env.ROBOT_MQTT === undefined ? undefined : {
    url: process.env.ROBOT_MQTT, username: process.env.ROBOT_MQTT_USER, password: process.env.ROBOT_MQTT_PASSWORD, anyHost: anyHost === '1', hostId: process.env.ROBOT_SPARKPLUG_HOST,
  }
  const relay = await startRelay({ secret, host: process.env.ROBOT_HOST ?? '127.0.0.1', port, mqtt, log: (line) => console.log(line) })
  console.log(`port ${relay.port}: the page joins ${relay.url}/ with the page token, a peer ${relay.url}/robot with the robot token`)
  console.log(process.env.ROBOT_SECRET === undefined ? 'secret made for this run (set ROBOT_SECRET, 16+ characters, to keep tokens across restarts)' : 'secret from ROBOT_SECRET')
  if (process.env.ROBOT_PRINT_TOKEN === '1') {
    console.log(`page token, good for ${TOKEN_TTL_MS / 3600000} h: ${relay.token(SUBJECTS.page)}`)
    console.log(`robot token, good for ${TOKEN_TTL_MS / 3600000} h: ${relay.token(SUBJECTS.robot)}`)
  } else console.log('no token printed (set ROBOT_PRINT_TOKEN=1 to print the page and robot tokens; a token in a log is a credential)')
  console.log(mqtt ? `Sparkplug B host '${mqtt.hostId ?? 'agentcity'}' on ${mqtt.url}` : 'no broker (set ROBOT_MQTT=mqtt://127.0.0.1:1883 to be a Sparkplug B host)')
  process.once('SIGINT', () => {
    console.log(`relay counts: ${JSON.stringify(relay.stats())}`)
    void relay.close().then(() => process.exit(0))
  })
}
