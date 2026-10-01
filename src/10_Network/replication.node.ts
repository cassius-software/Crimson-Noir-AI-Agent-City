/**
 * Why does this file exist? It is the Node host of the replication scaffold: one authoritative room (replication.ts)
 * behind a dependency-free WebSocket door. It is Node-only and never part of the page: node:http takes the upgrade,
 * the RFC 6455 frames are read and written here (a client's frame must be masked, the host's never is; ping is
 * answered with pong; close is a handshake; anything binary, fragmented or over the message bound closes the socket),
 * and node:crypto signs the session tokens (HMAC, with an expiry) the operator hands out. Every frame goes through the
 * core's seal (replication.ts openClientFrame: the envelope number must rise and the HMAC under the session token must
 * hold, or the frame is refused and counted; the host's own frames are sealed the same way, so the page can tell a
 * forged or replayed one), the core's validator and the peer's rate limits; every name and chat line through the 14A screen; a peer that keeps
 * earning refusals is removed; a peer that never joins or goes silent is dropped. The room ticks at a fixed rate and
 * every joined peer gets its snapshot each tick. The host listens in plain text on the loopback address by default:
 * TLS (wss) is terminated by the operator's reverse proxy in front of it, which is also where an origin or a client
 * certificate would be checked. Run it with `npm run serve:net` (Node 22 strips the types); the tsconfig split keeps
 * it in the node type project and out of the app's, and airgap.test.ts proves nothing on the page imports it.
 * What breaks if it is removed? There is no host for netClient.ts to join; the page is unchanged.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { Socket } from 'node:net'
import { pathToFileURL } from 'node:url'
import {
  admit, createRoom, depart, expired, handle, LIMITS, openClientFrame, poses, refuse, sealMessage, snapshotFor, tickRoom,
  type Outcome, type Peer, type Room, type ServerMessage,
} from './replication.ts'

// ---------------------------------------------------------------------------------------------------
// Session tokens: `<subject>.<expires ms>.<hmac>` in base64url, signed with the operator's secret

const b64url = (b: Buffer): string => b.toString('base64url')

const sign = (secret: string, body: string): Buffer => createHmac('sha256', secret).update(body).digest()

/** A token for `subject` (a printable name of at most LIMITS.name characters) that expires at `expiresAt` (ms). */
export function mintToken(secret: string, subject: string, expiresAt: number): string {
  if (!/^[\w .-]{1,24}$/.test(subject)) throw new Error('mintToken: subject')
  if (!Number.isSafeInteger(expiresAt)) throw new Error('mintToken: expiresAt')
  const body = `${b64url(Buffer.from(subject, 'utf8'))}.${expiresAt}`
  return `${body}.${b64url(sign(secret, body))}`
}

/** The subject of a good, unexpired token at `now`, or null: the signature is compared in constant time. */
export function verifyToken(secret: string, token: unknown, now: number): string | null {
  if (typeof token !== 'string' || token.length > LIMITS.token) return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const [subject64, expires, mac] = parts
  if (!/^\d{1,16}$/.test(expires) || Number(expires) <= now) return null
  const body = `${subject64}.${expires}`
  const want = sign(secret, body)
  const got = Buffer.from(mac, 'base64url')
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null
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
    at = 4
  } else if (len === 127) {
    if (buf.length < 10) return { kind: 'more' }
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(max)) return { kind: 'bad', code: 1009, reason: 'frame too big' }
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
  /** 0 picks a free port. */
  port?: number
  tickHz?: number
  /** Wall clock, ms (injectable for tests). */
  now?: () => number
  log?: (line: string) => void
}

export interface Host {
  readonly host: string
  readonly port: number
  readonly room: Room
  /** The URL a client on this machine joins. */
  readonly url: string
  /** Sockets open (joined or not). */
  connections(): number
  /** A token for `subject` good for `ttlMs` from now. */
  token(subject: string, ttlMs?: number): string
  /** Closes every socket (a close handshake each) and the server. */
  close(): Promise<void>
}

interface Conn {
  socket: Socket
  peer: Peer
  buf: Buffer
  closing: boolean
  /** Envelopes sent to this peer: the next frame is numbered one above (replication.ts sealMessage). */
  sent: number
}

/** One day: how long a token minted by `host.token` is good for unless told otherwise. */
export const TOKEN_TTL_MS = 24 * 60 * 60 * 1000

export function startHost(o: HostOptions): Promise<Host> {
  const now = o.now ?? Date.now
  const log = o.log ?? ((): void => {})
  const bind = o.host ?? '127.0.0.1'
  const room = createRoom(o.tickHz ?? LIMITS.tickHz)
  const conns = new Map<number, Conn>()
  const verify = (token: string): boolean => verifyToken(o.secret, token, now()) !== null

  /** One message to a joined peer, sealed under the token it joined with (nothing is ever sent to a peer without one). */
  const send = (c: Conn, msg: ServerMessage): void => {
    if (c.closing || !c.socket.writable || c.peer.key === '') return
    c.socket.write(writeFrame(OP.text, Buffer.from(sealMessage(msg, ++c.sent, c.peer.key), 'utf8')))
  }
  const broadcast = (msg: ServerMessage): void => {
    for (const c of conns.values()) if (c.peer.joined) send(c, msg)
  }
  /** Starts the close handshake and takes the peer out of the room at once; the socket ends when the client answers or soon after. */
  const close = (c: Conn, code: number, reason: string): void => {
    if (c.closing) return
    c.closing = true
    conns.delete(c.peer.id)
    const left = depart(room, c.peer, reason)
    if (left) broadcast(left)
    log(`peer ${c.peer.id} closed: ${reason}`)
    if (c.socket.writable) c.socket.write(writeFrame(OP.close, closePayload(code, reason)))
    const t = setTimeout(() => c.socket.destroy(), 1000)
    c.socket.once('close', () => clearTimeout(t))
    c.socket.end()
  }
  const apply = (c: Conn, out: Outcome): void => {
    if (out.reply) send(c, out.reply)
    if (out.broadcast) broadcast(out.broadcast)
    if (out.refused) log(`peer ${c.peer.id} refused: ${out.refused}`)
    if (out.kick) close(c, 4008, out.kick)
    else if (out.left) close(c, 1000, 'left')
  }

  const onFrame = (c: Conn, opcode: number, payload: Buffer): void => {
    switch (opcode) {
      case OP.text: {
        // The seal first (a forgery or a replay is a refusal like any malformed frame), then the room.
        const read = openClientFrame(c.peer, payload.toString('utf8'))
        apply(c, read.ok ? handle(room, c.peer, read.msg, now(), verify) : refuse(c.peer, read.reason))
        return
      }
      case OP.binary:
        apply(c, refuse(c.peer, 'binary frame'))
        return
      case OP.ping:
        if (c.socket.writable) c.socket.write(writeFrame(OP.pong, payload))
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
    c.buf = c.buf.length === 0 ? chunk : Buffer.concat([c.buf, chunk])
    while (!c.closing) {
      const r = readFrame(c.buf)
      if (r.kind === 'more') return
      if (r.kind === 'bad') return close(c, r.code, r.reason)
      c.buf = c.buf.subarray(r.used)
      onFrame(c, r.opcode, r.payload)
    }
  }

  const onUpgrade = (req: IncomingMessage, socket: Socket, head: Buffer): void => {
    const key = req.headers['sec-websocket-key']
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || req.headers['sec-websocket-version'] !== '13' || typeof key !== 'string') {
      socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      return
    }
    const peer = admit(room, now())
    if (!peer) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      return
    }
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`)
    const c: Conn = { socket, peer, buf: Buffer.alloc(0), closing: false, sent: 0 }
    conns.set(peer.id, c)
    socket.setNoDelay(true)
    socket.on('data', (chunk: Buffer) => onData(c, chunk))
    socket.on('error', () => close(c, 1006, 'socket error'))
    socket.on('close', () => close(c, 1006, 'socket closed'))
    log(`peer ${peer.id} connected`)
    if (head.length > 0) onData(c, head)
  }

  const server: Server = createServer((_req, res) => {
    res.writeHead(426, { 'content-type': 'text/plain', upgrade: 'websocket', connection: 'close' })
    res.end('Upgrade Required: this is a WebSocket host.\n')
  })
  server.on('upgrade', onUpgrade)

  const ticker = setInterval(() => {
    const t = now()
    for (const { peer, reason } of expired(room, t)) {
      const c = conns.get(peer.id)
      if (c) close(c, 4001, reason)
      else depart(room, peer, reason)
    }
    tickRoom(room)
    const players = poses(room)
    for (const c of conns.values()) if (c.peer.joined) send(c, snapshotFor(room, c.peer, players))
  }, 1000 / room.tickHz)
  ticker.unref()

  return new Promise<Host>((resolve, reject) => {
    server.once('error', reject)
    server.listen(o.port ?? 0, bind, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      const hostname = bind.includes(':') ? `[${bind}]` : bind
      log(`replication host listening on ws://${hostname}:${port} (wss is the proxy's)`)
      resolve({
        host: bind,
        port,
        room,
        url: `ws://${hostname}:${port}`,
        connections: () => conns.size,
        token: (subject, ttlMs = TOKEN_TTL_MS) => mintToken(o.secret, subject, now() + ttlMs),
        close: () =>
          new Promise<void>((done) => {
            clearInterval(ticker)
            for (const c of [...conns.values()]) close(c, 1001, 'host closing')
            server.close(() => done())
            setTimeout(() => server.closeAllConnections(), 1100).unref()
          }),
      })
    })
  })
}

// ---------------------------------------------------------------------------------------------------
// `npm run serve:net`

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.NET_SECRET ?? randomBytes(32).toString('hex')
  const port = Number(process.env.NET_PORT ?? 8787)
  const host = await startHost({ secret, host: process.env.NET_HOST ?? '127.0.0.1', port, log: (line) => console.log(line) })
  console.log(`room ticks at ${host.room.tickHz} Hz; at most ${LIMITS.peers} peers; ${process.env.NET_SECRET ? 'secret from NET_SECRET' : 'secret made for this run (set NET_SECRET to keep tokens across restarts)'}`)
  console.log(`a token for 'operator', good for ${TOKEN_TTL_MS / 3600000} h: ${host.token('operator')}`)
  console.log('clients off this machine join through the reverse proxy that terminates wss in front of this port')
  process.once('SIGINT', () => { void host.close().then(() => process.exit(0)) })
}
