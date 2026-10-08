/**
 * Why does this file exist? It is the Node host of the network room: one authoritative room (replication.ts) behind
 * a dependency-free WebSocket door, with the headless Ring-0 mirror (mirror.node.ts: the page's city of the same seed
 * in Rapier, the realm's own character controller, and its garage replaying every player's car with the realm's own
 * car physics) as its authority. It is Node-only and never part of the page:
 * node:http takes the upgrade, the RFC 6455 frames are read and written here (a client's frame must be masked, the
 * host's never is; ping is answered with pong, at most PINGS_PER_SECOND; close is a handshake; anything fragmented or
 * over the message bound closes the socket, and a binary frame is refused and counted like any malformed one), and
 * node:crypto signs the session tokens (HMAC, with an expiry) the operator hands out; a secret shorter than MIN_SECRET
 * starts no host.
 * No connection is upgraded without one: the token rides the upgrade as a subprotocol (`auth.<token>`, beside
 * `onyx.4`), its HMAC and expiry are checked before the 101, a failure is a 401 with no socket and no room slot (a
 * 429, unlogged, for an address that keeps failing; a good token is always admitted, since behind a proxy everyone
 * shares one address); a refused upgrade's socket is ended and destroyed within a second (a client that resets it is
 * no error of the host's), and a connection whose request has not arrived whole within HEADERS_TIMEOUT_MS is dropped.
 * The join must carry the same token. A token's subject is one player: a second connection under it replaces the first
 * (4010), and a session ends when its token expires (4003). Every frame then goes through the core's seal (replication.ts openClientFrame: the envelope number must
 * rise and the HMAC under the session token must hold, or the frame is refused and counted; the host's own frames are
 * sealed the same way, so the page can tell a forged or replayed one), the core's validator and the peer's rate
 * limits; every name and chat line through the 14A screen. An input is judged by the mirror the moment it arrives, and
 * one it refuses is answered with a correction in the same turn, before anything else is read from that socket. A
 * peer that keeps earning refusals or corrections is removed; one that never joins or goes silent is dropped; one too
 * slow to take what it is sent (a backlog past maxBacklog, checked before every write) is closed. Untrusted text reaches
 * the log escaped, on one line (loggable). The room ticks at a fixed rate and every joined
 * peer gets its snapshot each tick. Seals use node:crypto's HMAC (the same digest as integrity.ts, faster). The host
 * listens in plain text on the loopback address by default: TLS (wss) is terminated by the operator's reverse proxy
 * in front of it, which is also where an origin or a client certificate would be checked. Run it with `npm run
 * serve:net` (Node 22 strips the types); the tsconfig split keeps it in the node type project and out of the app's,
 * and airgap.test.ts proves nothing on the page imports it.
 * What breaks if it is removed? There is no host for netClient.ts to join; the page is unchanged.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { isIP, type Socket } from 'node:net'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDigest } from '../02_Define_The_Rules/integrity.ts'
import { LEDGER_SUBPROTOCOL, readSeal, type LedgerSeal } from './ledger.ts'
import { ledgerDoor, type LedgerDoor, type LedgerStats } from './ledger.node.ts'
import { Mirror } from './mirror.node.ts'
import {
  admit, AUTH_PREFIX, bucket, createRoom, depart, expired, handle, LIMITS, openClientFrame, poses, readEnvelope, refuse, refuseInput, sealMessage,
  snapshotFor, SUBPROTOCOL, take, tickRoom, unprintable,
  type Authority, type Bucket, type Mac, type Outcome, type Peer, type Room, type ServerMessage,
} from './replication.ts'

// ---------------------------------------------------------------------------------------------------
// Session tokens: `<subject>.<expires ms>.<hmac>` in base64url, signed with the operator's secret

const b64url = (b: Buffer): string => b.toString('base64url')

const sign = (secret: string, body: string): Buffer => createHmac('sha256', secret).update(body).digest()

/** The seals' HMAC-SHA256 through node:crypto: the digest integrity.ts computes, at native speed. */
export const nodeMac: Mac = (key, message) => createHmac('sha256', key).update(message).digest('hex')

/** Two tokens compared in constant time (for equal lengths; different lengths are simply different). */
function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8'), y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

/** Whether an upgrade's Sec-WebSocket-Protocol list offers `protocol`. */
export function offers(header: unknown, protocol: string): boolean {
  return typeof header === 'string' && header.length <= 2 * LIMITS.token && header.split(',').map((p) => p.trim()).includes(protocol)
}

/**
 * The session token an upgrade offers, from its Sec-WebSocket-Protocol list: the door's own protocol (`onyx.4` for the
 * room, SUBPROTOCOL; `crimson.1` for the ledger door) must be offered, and exactly one `auth.<token>` entry. Null for
 * anything else.
 */
export function offeredToken(header: unknown, protocol: string = SUBPROTOCOL): string | null {
  if (typeof header !== 'string' || header.length > 2 * LIMITS.token) return null
  const offered = header.split(',').map((p) => p.trim())
  if (!offered.includes(protocol)) return null
  const auth = offered.filter((p) => p.startsWith(AUTH_PREFIX))
  if (auth.length !== 1) return null
  const token = auth[0].slice(AUTH_PREFIX.length)
  return token.length > 0 ? token : null
}

/** A token for `subject` (a printable name of at most LIMITS.name characters) that expires at `expiresAt` (ms). */
export function mintToken(secret: string, subject: string, expiresAt: number): string {
  if (!/^[\w .-]{1,24}$/.test(subject)) throw new Error('mintToken: subject')
  if (!Number.isSafeInteger(expiresAt)) throw new Error('mintToken: expiresAt')
  const body = `${b64url(Buffer.from(subject, 'utf8'))}.${expiresAt}`
  return `${body}.${b64url(sign(secret, body))}`
}

/** When a token says it expires, ms (the signature is not checked here: verifyToken first). NaN for anything else. */
export function tokenExpiry(token: string): number {
  const parts = token.split('.')
  return parts.length === 3 && /^\d{1,16}$/.test(parts[1]) ? Number(parts[1]) : Number.NaN
}

/** The subject of a good, unexpired token at `now`, or null: the signature is compared in constant time. */
export function verifyToken(secret: string, token: unknown, now: number): string | null {
  if (typeof token !== 'string' || token.length > LIMITS.token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [subject64, expires, mac] = parts
  // Written so an unordered clock refuses: a token lives only while its expiry is strictly ahead of `now`.
  if (!/^\d{1,16}$/.test(expires) || !(Number(expires) > now)) return null
  const body = `${subject64}.${expires}`
  const want = sign(secret, body)
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
  // One spelling per token: base64url's last character carries bits the decoder ignores, so '...A' and '...B' can
  // decode to the same signature. Only the encoding mintToken writes is a token.
  if (b64url(got) !== mac) return null
  const subject = Buffer.from(subject64, 'base64url').toString('utf8')
  return /^[\w .-]{1,24}$/.test(subject) ? subject : null
}

// ---------------------------------------------------------------------------------------------------
// RFC 6455 frames

export const OP = Object.freeze({ continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 })

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** The Sec-WebSocket-Accept value for a client's Sec-WebSocket-Key. */
export const acceptKey = (key: string): string => createHash('sha1').update(key + GUID).digest('base64')

export type FrameRead =
  | { kind: 'frame'; opcode: number; payload: Buffer; used: number }
  | { kind: 'more' }
  /** The socket is to be closed with this code (1002 protocol error, 1003 unsupported data, 1009 too big). */
  | { kind: 'bad'; code: number; reason: string }

/**
 * One frame from the front of `buf`, as a client sends it: FIN set (no fragments here), no reserved bits, masked
 * (RFC 6455 §5.1: an unmasked client frame closes the connection), at most `max` payload bytes.
 */
export function readFrame(buf: Buffer, max: number = LIMITS.message): FrameRead {
  if (buf.length < 2) return { kind: 'more' }
  const b0 = buf[0]
  const b1 = buf[1]
  const fin = (b0 & 0x80) !== 0
  const opcode = b0 & 0x0f
  if ((b0 & 0x70) !== 0) return { kind: 'bad', code: 1002, reason: 'reserved bits' }
  if (!fin || opcode === OP.continuation) return { kind: 'bad', code: 1003, reason: 'fragmented frame' }
  if (opcode !== OP.text && opcode !== OP.binary && opcode !== OP.close && opcode !== OP.ping && opcode !== OP.pong) return { kind: 'bad', code: 1002, reason: 'opcode' }
  if ((b1 & 0x80) === 0) return { kind: 'bad', code: 1002, reason: 'unmasked client frame' }
  let len = b1 & 0x7f
  let at = 2
  if (len === 126) {
    if (buf.length < 4) return { kind: 'more' }
    len = buf.readUInt16BE(2)
    // RFC 6455 5.2: the shortest encoding of a length is the only one.
    if (len < 126) return { kind: 'bad', code: 1002, reason: 'non-minimal length' }
    at = 4
  } else if (len === 127) {
    if (buf.length < 10) return { kind: 'more' }
    const big = buf.readBigUInt64BE(2)
    // Judged as a BigInt before any allocation; `max` is read as a whole number whatever a caller passed.
    if (big > BigInt(Math.min(Math.floor(max), Number.MAX_SAFE_INTEGER))) return { kind: 'bad', code: 1009, reason: 'frame too big' }
    if (big < 65536n) return { kind: 'bad', code: 1002, reason: 'non-minimal length' }
    len = Number(big)
    at = 10
  }
  if (len > max) return { kind: 'bad', code: 1009, reason: 'frame too big' }
  if (opcode >= OP.close && len > 125) return { kind: 'bad', code: 1002, reason: 'control frame too big' }
  if (buf.length < at + 4 + len) return { kind: 'more' }
  const mask = buf.subarray(at, at + 4)
  const payload = Buffer.allocUnsafe(len)
  for (let i = 0; i < len; i++) payload[i] = buf[at + 4 + i] ^ mask[i & 3]
  return { kind: 'frame', opcode, payload, used: at + 4 + len }
}

/** One frame as the host sends it: FIN set, unmasked. */
export function writeFrame(opcode: number, payload: Buffer = Buffer.alloc(0)): Buffer {
  const len = payload.length
  const head = len < 126 ? Buffer.from([0x80 | opcode, len]) : len < 65536 ? Buffer.from([0x80 | opcode, 126, len >> 8, len & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); return b })()])
  return Buffer.concat([head, payload])
}

/** A close frame's payload: the code, then the reason (at most 123 bytes). */
export function closePayload(code: number, reason: string): Buffer {
  const text = Buffer.from(reason, 'utf8').subarray(0, 123)
  const b = Buffer.alloc(2 + text.length)
  b.writeUInt16BE(code)
  text.copy(b, 2)
  return b
}

// ---------------------------------------------------------------------------------------------------
// The host

export interface HostOptions {
  /** The operator's secret for the session tokens. */
  secret: string
  /** Loopback unless the operator's proxy needs another address. */
  host?: string
  /**
   * The host sits behind the operator's reverse proxy, and every connection reaches it through that proxy: the
   * client's own address is read from the `X-Forwarded-For` header the proxy writes (deploy/nginx.conf), so the
   * failure throttle keys on the client, not on the proxy's one address. Never set on a host anyone reaches directly:
   * a direct client would then name any address it liked, and a bucket per invented address is a bucket per request.
   */
  trustProxy?: boolean
  /** 0 picks a free port. */
  port?: number
  tickHz?: number
  /** The city the mirror builds and a joining page must be walking (the page's ?seed; 1337 by default). */
  seed?: number
  /** The fleet a joining page must be running (the page's ?cars; 36 by default, mirror.node.ts MIRROR.cars). */
  cars?: number
  /** Another authority than the mirror (the protocol's tests run the open plane, plane.node.ts). */
  authority?: Authority
  /** How long a connection may take to send its request's headers (a slow-header client is dropped after it), ms. */
  headersTimeoutMs?: number
  /** Bytes a peer may leave unread before the host closes it as too slow. */
  maxBacklog?: number
  /** Wall clock, ms (injectable for tests). */
  now?: () => number
  log?: (line: string) => void
  /**
   * The SHA-256 the operator pinned for the Crimson Noir OS configuration (crimson_noir_os/containment.lock): with it
   * the host also opens the ledger door (ledger.node.ts, `crimson.1`); without it that door answers 404.
   */
  ledgerLock?: string
  /**
   * The seal of the configuration's own run (crimson_noir_os/containment.seal): with it the ledger door keeps only
   * that run for the fleet (ledger.node.ts). Without it, the last verified ledger.
   */
  ledgerSeal?: LedgerSeal
}

/** What the host has done since it started, for the console and the tests. */
export interface HostStats {
  peers: number
  /** Upgrades refused for want of a good token: answered 401 (`unauthorized`), or 429 once the address had spent its failures (`throttled`). */
  unauthorized: number
  throttled: number
  /**
   * Inputs read, kept, and corrected; kept but put back for drift (resynced); inputs neither kept nor corrected (dropped
   * unread for predating a correction, or refused and counted).
   */
  inputs: number
  kept: number
  corrected: number
  resynced: number
  stale: number
  /** Microseconds to handle one input (the mirror's judgement included) and one tick (every snapshot sealed and sent), moving averages. */
  inputUs: number
  tickUs: number
}

/**
 * The shortest secret a host accepts, characters: the HMAC key every session token is signed with. An empty or short
 * secret would let anyone mint tokens (an HMAC under '' is no secret at all).
 */
export const MIN_SECRET = 16
/** WebSocket pings a peer may send per second (burst: twice that); past it each one is a refusal. */
export const PINGS_PER_SECOND = 4
/** How long a connection may take to send its request's headers, ms (HostOptions.headersTimeoutMs). */
export const HEADERS_TIMEOUT_MS = 5000
/** How long a refused upgrade's socket is given to flush its HTTP answer before it is destroyed, ms. */
const REFUSED_LINGER_MS = 1000

/**
 * A line of untrusted text as the log may print it: one line of at most 160 characters, with every character a
 * terminal could act on or a reader could be misled by escaped as \uXXXX: C0, DEL and C1 controls (an escape sequence
 * or a "next line"), the line and paragraph separators, and bidi controls (see replication.ts `unprintable`).
 */
export function loggable(text: string): string {
  let one = ''
  for (const ch of JSON.stringify(String(text)).slice(1, -1)) {
    const c = ch.codePointAt(0) ?? 0
    one += unprintable(c) ? `\\u${c.toString(16).padStart(4, '0')}` : ch
  }
  if (one.length <= 160) return one
  // Cut on a whole character: never half of a surrogate pair.
  const cut = one.slice(0, 159)
  return `${/[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut}…`
}

/** The city a host builds unless told otherwise: the page's default seed (App.tsx). */
export const DEFAULT_SEED = 1337
/** Unread bytes past which a peer is too slow to keep (about two seconds of a full room's snapshots). */
export const MAX_BACKLOG = 512 * 1024
/**
 * The client's address as a trusted proxy reports it: the last entry of `X-Forwarded-For` (the one the nearest proxy
 * appended; nginx.conf writes exactly one), only when it is an IP literal. Anything else gives null, and the caller
 * falls back to the socket's own address.
 */
export function forwardedFor(header: string | string[] | undefined): string | null {
  if (header === undefined) return null
  const text = Array.isArray(header) ? header.join(',') : header
  const last = text.slice(text.lastIndexOf(',') + 1).trim()
  return last.length > 0 && last.length <= 45 && isIP(last) !== 0 ? last : null
}

/** Failed upgrades an address may make before its failures are answered 429 (unlogged), and how fast it earns another. */
export const AUTH_FAILURES = Object.freeze({ burst: 5, perSecond: 0.2, addresses: 4096 })

export interface Host {
  readonly host: string
  readonly port: number
  readonly room: Room
  /** The world a page must be running to join (the mirror's: 'city/<seed>/<cars>'). */
  readonly world: string
  stats(): HostStats
  /** The URL a client on this machine joins. */
  readonly url: string
  /** Sockets open (joined or not). */
  connections(): number
  /** A token for `subject` good for `ttlMs` from now. */
  token(subject: string, ttlMs?: number): string
  /** What the ledger door has done, or null when the host was started without a pinned digest. */
  ledger(): LedgerStats | null
  /** Closes every socket (a close handshake each) and the server. */
  close(): Promise<void>
}

interface Conn {
  socket: Socket
  peer: Peer
  /** The token the upgrade carried: the join must carry the same. */
  token: string
  /** Whom the token was minted for: one player, one connection. */
  subject: string
  /** When that token expires, ms: the session ends then (4003), whatever it is doing. */
  expires: number
  /** WebSocket pings from this peer, metered (PINGS_PER_SECOND). */
  pings: Bucket
  buf: Buffer
  closing: boolean
  /** Envelopes sent to this peer: the next frame is numbered one above (replication.ts sealMessage). */
  sent: number
}

/** One day: how long a token minted by `host.token` is good for unless told otherwise. */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export async function startHost(o: HostOptions): Promise<Host> {
  // Measured in bytes, as HMAC takes it, and with no NUL (which HMAC's zero padding would make part of no key).
  const secretBytes = typeof o.secret === 'string' ? Buffer.from(o.secret, 'utf8') : Buffer.alloc(0)
  if (secretBytes.length < MIN_SECRET || secretBytes.includes(0)) throw new Error(`the host's secret must be at least ${MIN_SECRET} characters (bytes of UTF-8, none of them NUL)`)
  const now = o.now ?? Date.now
  const log = o.log ?? ((): void => {})
  const bind = o.host ?? '127.0.0.1'
  const maxBacklog = o.maxBacklog ?? MAX_BACKLOG
  const authority = o.authority ?? (await Mirror.create(o.seed ?? DEFAULT_SEED, o.cars))
  const room = createRoom(authority, o.tickHz ?? LIMITS.tickHz)
  const conns = new Map<number, Conn>()
  /** The live connection of each subject: a token's subject is one player, so a second connection replaces the first. */
  const bySubject = new Map<string, Conn>()
  const failures = new Map<string, Bucket>()
  let sweptAt = now()
  const stats: HostStats = { peers: 0, unauthorized: 0, throttled: 0, inputs: 0, kept: 0, corrected: 0, resynced: 0, stale: 0, inputUs: 0, tickUs: 0 }
  const average = (was: number, us: number): number => (was === 0 ? us : was * 0.95 + us * 0.05)
  if (o.ledgerLock !== undefined && !isDigest(o.ledgerLock)) throw new Error('ledgerLock must be a SHA-256 digest (64 lowercase hex characters)')
  const ledger: LedgerDoor | null = o.ledgerLock === undefined ? null : ledgerDoor({
    pinned: o.ledgerLock, seal: o.ledgerSeal, now, log, mac: nodeMac, maxBacklog, loggable, io: { readFrame, writeFrame, closePayload, acceptKey, OP },
  })

  /**
   * Every byte the host sends a peer goes through here: a peer that does not read what it is sent would have the host
   * hold it all, so past maxBacklog it is closed instead (pongs and close frames included).
   */
  const write = (c: Conn, frame: Buffer): void => {
    if (!c.socket.writable) return
    if (c.socket.writableLength > maxBacklog) {
      if (!c.closing) close(c, 4009, 'too slow to keep up')
      c.socket.destroy()
      return
    }
    c.socket.write(frame)
  }
  /** One message to a joined peer, sealed under the token it joined with (nothing is ever sent to a peer without one). */
  const send = (c: Conn, msg: ServerMessage): void => {
    if (c.closing || c.peer.key === '') return
    write(c, writeFrame(OP.text, Buffer.from(sealMessage(msg, ++c.sent, c.peer.key, nodeMac), 'utf8')))
  }
  const broadcast = (msg: ServerMessage): void => {
    for (const c of conns.values()) if (c.peer.joined) send(c, msg)
  }
  /** Starts the close handshake and takes the peer out of the room at once; the socket ends when the client answers or soon after. */
  const close = (c: Conn, code: number, reason: string): void => {
    if (c.closing) return
    c.closing = true
    // Nothing more is read from it: what it still sends is dropped, not buffered.
    c.buf = Buffer.alloc(0)
    conns.delete(c.peer.id)
    if (bySubject.get(c.subject) === c) bySubject.delete(c.subject)
    const left = depart(room, c.peer, reason)
    if (left) broadcast(left)
    log(`peer ${c.peer.id} closed: ${loggable(reason)}`)
    if (c.socket.writable && c.socket.writableLength <= maxBacklog) c.socket.write(writeFrame(OP.close, closePayload(code, reason)))
    const t = setTimeout(() => c.socket.destroy(), 1000)
    t.unref()
    c.socket.once('close', () => clearTimeout(t))
    c.socket.end()
  }
  const apply = (c: Conn, out: Outcome): void => {
    if (out.reply) send(c, out.reply)
    if (out.broadcast) broadcast(out.broadcast)
    if (out.refused) log(`peer ${c.peer.id} refused: ${loggable(out.refused)}`)
    if (out.kick) close(c, 4008, out.kick)
    else if (out.left) close(c, 1000, 'left')
  }

  const onFrame = (c: Conn, opcode: number, payload: Buffer): void => {
    switch (opcode) {
      case OP.text: {
        // The seal first (a forgery or a replay is a refusal like any malformed frame), then the room. An input is
        // judged here and now: a refused one is answered with its correction before the next frame is read.
        const wire = payload.toString('utf8')
        const t0 = performance.now()
        const read = openClientFrame(c.peer, wire, nodeMac)
        const verify = (token: string): boolean => sameToken(token, c.token) && verifyToken(o.secret, token, now()) !== null
        let out: Outcome
        let input = false
        if (read.ok) {
          input = read.msg.t === 'input'
          const fixWas = c.peer.fix, seqWas = c.peer.seq
          out = handle(room, c.peer, read.msg, now(), verify)
          if (input) {
            if (c.peer.fix !== fixWas) {
              if (out.refused === undefined) stats.resynced++
              else stats.corrected++
            }
            else if (c.peer.seq !== seqWas) stats.kept++
            else stats.stale++
          }
        } else {
          // An input that failed its seal or its shape from a joined peer is refused and corrected like any other.
          const env = readEnvelope(wire)
          input = c.peer.joined && env.ok && (env.msg.body as { t?: unknown }).t === 'input'
          out = input ? refuseInput(room, c.peer, read.reason, now()) : refuse(c.peer, read.reason, now())
          if (input) stats.corrected++
        }
        if (input) {
          stats.inputs++
          stats.inputUs = average(stats.inputUs, (performance.now() - t0) * 1000)
        }
        apply(c, out)
        return
      }
      case OP.binary:
        apply(c, refuse(c.peer, 'binary frame', now()))
        return
      case OP.ping:
        // Answered while within the peer's ping rate; past it each one is a refusal like any other.
        if (!take(c.pings, now())) apply(c, refuse(c.peer, 'ping: over rate', now()))
        else write(c, writeFrame(OP.pong, payload))
        return
      case OP.pong:
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
      const r = readFrame(c.buf)
      if (r.kind === 'more') return
      if (r.kind === 'bad') return close(c, r.code, r.reason)
      c.buf = c.buf.subarray(r.used)
      onFrame(c, r.opcode, r.payload)
    }
  }

  /**
   * An upgrade turned away: the status line, then the socket is ended, and destroyed if the client does not close its
   * side within REFUSED_LINGER_MS. A reset from the client is expected here and is no error of the host's.
   */
  const turnAway = (socket: Socket, status: string): void => {
    socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`)
    const t = setTimeout(() => socket.destroy(), REFUSED_LINGER_MS)
    t.unref()
    socket.once('close', () => clearTimeout(t))
  }

  /** Sockets whose request arrived whole (an upgrade or a plain request): the header deadline no longer applies. */
  const answered = new WeakSet<Socket>()

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    answered.add(socket)
    // Before anything is read or written: a client may reset the connection at any moment, and an 'error' with no
    // listener would bring the whole host down.
    socket.on('error', () => socket.destroy())
    const key = req.headers['sec-websocket-key']
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
      turnAway(socket, '400 Bad Request')
      return
    }
    // The token before anything else. A good one is always admitted: behind the operator's proxy every client arrives
    // from one address (unless the proxy is trusted to name the client, below), so a stranger's failures must never
    // lock anyone out. An address that keeps failing is turned away with 429 instead of 401, unlogged, until its
    // budget refills.
    const from = (o.trustProxy ? forwardedFor(req.headers['x-forwarded-for']) : null) ?? socket.remoteAddress ?? '?'
    const t = now()
    // Which door: the ledger's when `crimson.1` is offered and the room's `onyx.4` is not; the room's otherwise. The
    // token is checked the same way for both.
    const protocols = req.headers['sec-websocket-protocol']
    const toLedger = offers(protocols, LEDGER_SUBPROTOCOL) && !offers(protocols, SUBPROTOCOL)
    const token = offeredToken(protocols, toLedger ? LEDGER_SUBPROTOCOL : SUBPROTOCOL)
    const subject = token === null ? null : verifyToken(o.secret, token, t)
    if (token === null || subject === null) {
      let budget = failures.get(from)
      if (!budget) {
        // Bounded: past the cap the address that failed longest ago is forgotten, so a flood of addresses (a host
        // exposed without its proxy) holds a fixed amount of memory.
        if (failures.size >= AUTH_FAILURES.addresses) {
          let oldest: string | null = null
          let at = Infinity
          for (const [addr, b] of failures) if (b.at < at) { at = b.at; oldest = addr }
          if (oldest !== null) failures.delete(oldest)
        }
        failures.set(from, (budget = bucket(AUTH_FAILURES.burst, AUTH_FAILURES.perSecond, t)))
      }
      if (!take(budget, t)) {
        stats.throttled++
        turnAway(socket, '429 Too Many Requests')
        return
      }
      stats.unauthorized++
      log(`upgrade from ${loggable(from)} refused: ${token === null ? 'no session token offered' : 'a token that does not verify'}`)
      turnAway(socket, '401 Unauthorized')
      return
    }
    if (toLedger) {
      if (ledger === null) {
        turnAway(socket, '404 Not Found')
        return
      }
      ledger.open(socket, key, token, subject, tokenExpiry(token), head)
      return
    }
    // A subject is one player: a second connection under it (the same token, or another minted for the same name)
    // replaces the first (a reconnect after a dropped link, or a token shared out), so no player holds two slots.
    const before = bySubject.get(subject)
    if (before) close(before, 4010, 'replaced by a new connection')
    const peer = admit(room, t)
    if (!peer) {
      turnAway(socket, '503 Service Unavailable')
      return
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\nSec-WebSocket-Protocol: ${SUBPROTOCOL}\r\n\r\n`)
    const c: Conn = {
      socket, peer, token, subject, expires: tokenExpiry(token), pings: bucket(2 * PINGS_PER_SECOND, PINGS_PER_SECOND, t), buf: Buffer.alloc(0), closing: false, sent: 0,
    }
    conns.set(peer.id, c)
    bySubject.set(subject, c)
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => onData(c, chunk))
    socket.on('error', () => close(c, 1006, 'socket error'))
    // node:http keeps its sockets half-open: a client that drops the connection without a close frame only ends it.
    socket.on('end', () => close(c, 1006, 'socket ended'))
    socket.on('close', () => close(c, 1006, 'socket closed'))
    log(`peer ${peer.id} connected`)
    if (head.length > 0) onData(c, head)
  }

  // A client that dribbles its request's headers (slowloris) holds a socket only this long: the parser's own timeouts,
  // checked often.
  const headersTimeout = o.headersTimeoutMs ?? HEADERS_TIMEOUT_MS
  const server: Server = createServer({ headersTimeout, requestTimeout: 2 * headersTimeout, connectionsCheckingInterval: Math.min(1000, headersTimeout) }, (req, res) => {
    answered.add(req.socket)
    res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket', connection: 'close' })
    res.end('Upgrade Required: this is a WebSocket host.\n')
  })
  server.on('upgrade', onUpgrade)
  // And a deadline of the host's own on every connection, beside the parser's (which, under a churn of upgraded
  // sockets, does not always fire): one whose request has not arrived whole by then is destroyed.
  server.on('connection', (socket: Socket) => {
    socket.on('error', () => socket.destroy())
    const t = setTimeout(() => { if (!answered.has(socket)) socket.destroy() }, headersTimeout)
    t.unref()
    socket.once('close', () => clearTimeout(t))
  })

  const ticker = setInterval(() => {
    const t0 = performance.now()
    const t = now()
    for (const { peer, reason } of expired(room, t)) {
      const c = conns.get(peer.id)
      if (c) close(c, 4001, reason)
      else depart(room, peer, reason)
    }
    // A session lives no longer than its token.
    for (const c of [...conns.values()]) if (!(t < c.expires)) close(c, 4003, 'token expired')
    ledger?.tick(t)
    tickRoom(room)
    const players = poses(room)
    for (const c of [...conns.values()]) if (c.peer.joined) send(c, snapshotFor(room, c.peer, players))
    // Addresses that stopped failing are forgotten once their budget is whole again (swept once a second, so the
    // tick's cost does not grow with the addresses that failed).
    if (t - sweptAt >= 1000) {
      sweptAt = t
      for (const [addr, b] of failures) if (t - b.at > (AUTH_FAILURES.burst / AUTH_FAILURES.perSecond) * 1000) failures.delete(addr)
    }
    stats.tickUs = average(stats.tickUs, (performance.now() - t0) * 1000)
  }, 1000 / room.tickHz)
  ticker.unref()

  return new Promise<Host>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port ?? 0, bind, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const hostname = bind.includes(':') ? `[${bind}]` : bind
      log(`replication host listening on ws://${hostname}:${port} (wss is the proxy's); the world is ${authority.world}`)
      resolve({
        host: bind,
        port,
        room,
        world: authority.world,
        stats: () => ({ ...stats, peers: conns.size }),
        url: `ws://${hostname}:${port}`,
        connections: () => conns.size,
        token: (subject, ttlMs = TOKEN_TTL_MS) => mintToken(o.secret, subject, now() + ttlMs),
        ledger: () => ledger?.stats() ?? null,
        close: () =>
          new Promise<void>((done) => {
            clearInterval(ticker)
            for (const c of [...conns.values()]) close(c, 1001, 'host closing')
            ledger?.close()
            server.close(() => done())
            setTimeout(() => server.closeAllConnections(), 1100).unref()
          }),
      })
    })
  })
}

/**
 * The digest a containment.lock pins: its last line that is neither blank nor a comment, which must be a SHA-256
 * digest. Null for anything else.
 */
export function readLock(text: string): string | null {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#'))
  const last = lines.at(-1)
  return last !== undefined && isDigest(last) ? last : null
}

// ---------------------------------------------------------------------------------------------------
// `npm run serve:net`

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The secret: NET_SECRET_FILE names a file holding it (a container's secret, which `docker inspect` and the process's
  // environment never show; one trailing newline is not part of it), or NET_SECRET holds it, or one is made for this
  // run. Both set is refused as ambiguous; a set one must be long enough (startHost refuses a short one).
  if (process.env.NET_SECRET !== undefined && process.env.NET_SECRET_FILE !== undefined) throw new Error('set NET_SECRET or NET_SECRET_FILE, not both')
  // A secret made for this run with no token printed would admit nobody, ever: refused rather than run that way.
  if (process.env.NET_PRINT_TOKEN === '0' && process.env.NET_SECRET === undefined && process.env.NET_SECRET_FILE === undefined) {
    throw new Error('NET_PRINT_TOKEN=0 needs the secret set (NET_SECRET_FILE or NET_SECRET), so tokens can be minted for it')
  }
  const secretFile = process.env.NET_SECRET_FILE
  const secret = secretFile !== undefined ? readFileSync(secretFile, 'utf8').replace(/\r?\n$/, '')
    : process.env.NET_SECRET === undefined ? randomBytes(32).toString('hex') : process.env.NET_SECRET
  const port = Number(process.env.NET_PORT ?? 8787)
  const seed = Number(process.env.NET_SEED ?? DEFAULT_SEED)
  const cars = process.env.NET_CARS === undefined ? undefined : Number(process.env.NET_CARS)
  if (cars !== undefined && !(Number.isInteger(cars) && cars >= 0 && cars <= LIMITS.cars)) throw new Error(`NET_CARS must be a whole number 0..${LIMITS.cars}`)
  const tickHz = process.env.NET_TICK_HZ === undefined ? undefined : Number(process.env.NET_TICK_HZ)
  if (tickHz !== undefined && !(tickHz >= 1 && tickHz <= 120)) throw new Error('NET_TICK_HZ must be 1..120')
  // The ledger door opens on the digest the OS's own lock pins (or NET_LEDGER_LOCK's file), and stays shut without one.
  const lockPath = process.env.NET_LEDGER_LOCK ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crimson_noir_os', 'containment.lock')
  const ledgerLock = existsSync(lockPath) ? readLock(readFileSync(lockPath, 'utf8')) ?? undefined : undefined
  // The run the door keeps for the fleet (NET_LEDGER_SEAL, or the OS's own containment.seal); a seal file that does
  // not read is refused rather than run without.
  const sealPath = process.env.NET_LEDGER_SEAL ?? join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crimson_noir_os', 'containment.seal')
  let ledgerSeal: LedgerSeal | undefined
  if (ledgerLock !== undefined && existsSync(sealPath)) {
    const read = readSeal(readFileSync(sealPath, 'utf8'))
    if (read === null) throw new Error(`${sealPath} is not a seal (head, count and weights lines)`)
    ledgerSeal = read
  }
  // NET_TRUST_PROXY=1: the client's address is the one the proxy forwards (see HostOptions.trustProxy); only behind it.
  const trust = process.env.NET_TRUST_PROXY
  if (trust !== undefined && trust !== '0' && trust !== '1') throw new Error('NET_TRUST_PROXY must be 0 or 1')
  const trustProxy = trust === '1'
  const host = await startHost({ secret, host: process.env.NET_HOST ?? '127.0.0.1', port, seed, cars, tickHz, trustProxy, ledgerLock, ledgerSeal, log: (line) => console.log(line) })
  console.log(trustProxy ? 'clients are named by the proxy\'s X-Forwarded-For (NET_TRUST_PROXY=1): the failure throttle keys on each client' : 'clients are named by their socket address: behind a proxy, the failure throttle sees one address (set NET_TRUST_PROXY=1 there)')
  console.log(ledgerLock ? `the ledger door (crimson.1) checks ledgers against ${ledgerLock.slice(0, 16)}… (${lockPath})` : `no ledger door: ${lockPath} pins no digest`)
  if (ledgerLock) console.log(ledgerSeal ? `the ledger door keeps for the fleet only the run sealed in ${sealPath} (head ${ledgerSeal.head.slice(0, 12)}, ${ledgerSeal.count} entries)` : `the ledger door keeps the last verified ledger: no seal pinned at ${sealPath}`)
  const [, s, n] = host.world.split('/')
  console.log(`room ticks at ${host.room.tickHz} Hz; at most ${LIMITS.peers} peers; the authority is the headless Ring-0 mirror of ${host.world} (pages with ?seed=${s} and ${n} cars join)`)
  console.log(secretFile !== undefined ? `secret from NET_SECRET_FILE (${secretFile})` : process.env.NET_SECRET ? 'secret from NET_SECRET' : 'secret made for this run (set NET_SECRET or NET_SECRET_FILE to keep tokens across restarts)')
  // A deployment whose logs are kept (a container's) sets NET_PRINT_TOKEN=0 and mints its tokens with
  // tools/net/mint-token.mjs instead: a token in a log is a credential anyone who reads the log holds.
  if (process.env.NET_PRINT_TOKEN === '0') console.log('no token printed (NET_PRINT_TOKEN=0): mint them with tools/net/mint-token.mjs')
  else console.log(`a token for 'operator', good for ${TOKEN_TTL_MS / 3600000} h: ${host.token('operator')}`)
  console.log('clients off this machine join through the reverse proxy that terminates wss in front of this port')
  process.once('SIGINT', () => { void host.close().then(() => process.exit(0)) })
}
