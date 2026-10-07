/**
 * Why does this file exist? It is the host's second door: where the Crimson Noir OS hosted runtime (crimson_noir_os
 * src/bridge.rs) brings its weight ledger to be verified, and where the runtimes of the same configuration fetch the
 * weights of the last ledger that verified (the fleet sync). The room's door (replication.node.ts) takes the upgrade
 * and checks the session token exactly as it does for a player (`auth.<token>`, 401/429), then hands the socket here
 * when the upgrade offers `crimson.1` instead of `onyx.4`. From then on:
 * - Every frame is read by the same RFC 6455 rules (masked, bounded at LEDGER_FRAME, no fragments; binary refused).
 * - Every message is sealed under the session token with a rising envelope number, as the room's are (replication.ts
 *   readEnvelope and sealFault): a forged, altered or replayed frame is refused.
 * - The ledger itself is judged by ledger.ts, pure: the configuration against the operator's pinned digest, every
 *   entry against the containment rules and the chain, the seal against the fold.
 * A refusal is one sealed `refused` message and a close (4008); nothing half-verified is ever stored. A verified
 * ledger's weights replace the last ones kept for its configuration; a `fetch` sends them back in chunks, with their
 * head, count and digest, so the runtime can check them again before it adopts them. Sessions end with their token, a
 * connection is bounded in frames, and one too slow to read what it is sent is closed, as in the room. Nothing here
 * opens a connection of its own: the door only answers.
 * What breaks if it is removed? A runtime's learned weights could not be verified, nor shared with another.
 */
import type { Socket } from 'node:net'
import { canonical } from '../02_Define_The_Rules/integrity.ts'
import { admit, begin, LEDGER_CHUNK, LEDGER_FRAME, LEDGER_MAX_ENTRIES, LEDGER_SUBPROTOCOL, newSession, pairs, readLedgerMessage, seal, WEIGHTS_CHUNK, type LedgerSession, type LedgerSeal } from './ledger.ts'
import { readEnvelope, sealFault, type Mac } from './replication.ts'
import type { FrameRead } from './replication.node.ts'

/** The room's frame code, handed in by the host (so this file does not import it back). */
export interface FrameIo {
  readFrame(buf: Buffer, max: number): FrameRead
  writeFrame(opcode: number, payload?: Buffer): Buffer
  closePayload(code: number, reason: string): Buffer
  acceptKey(key: string): string
  readonly OP: { readonly text: number; readonly binary: number; readonly close: number; readonly ping: number; readonly pong: number }
}

export interface LedgerDoorOptions {
  /** The SHA-256 the operator pinned for the OS's configuration (crimson_noir_os/containment.lock). */
  pinned: string
  now: () => number
  log: (line: string) => void
  mac: Mac
  io: FrameIo
  maxBacklog: number
  /** Escapes untrusted text for the log (replication.node.ts loggable). */
  loggable: (text: string) => string
  /**
   * The seal of the configuration's own run (crimson_noir_os/containment.seal). With it, only that run is kept for
   * the fleet; another verified ledger is answered `verified` with `kept: false`. Without it, the last verified
   * ledger is kept, whatever it folds to: a door for tests and development.
   */
  seal?: LedgerSeal
}

export interface LedgerStats {
  /** Sessions open now. */
  sessions: number
  verified: number
  refused: number
  fetched: number
}

export interface LedgerDoor {
  /** Takes over an upgrade the host has authenticated: writes the 101 and reads from there. */
  open(socket: Socket, key: string, token: string, subject: string, expires: number, head: Buffer): void
  /** Ends the sessions whose token has expired. */
  tick(now: number): void
  close(): void
  stats(): LedgerStats
}

/** Frames one connection may send: a full ledger in chunks, and room for the rest. */
export const LEDGER_MAX_FRAMES = Math.ceil(LEDGER_MAX_ENTRIES / LEDGER_CHUNK) + 64

interface LedgerConn {
  socket: Socket
  token: string
  subject: string
  expires: number
  session: LedgerSession
  buf: Buffer
  closing: boolean
  /** Envelopes sent, and the number of the last one received (both rise). */
  sent: number
  received: number
  frames: number
}

/** The weights kept from the last verified ledger of a configuration (by its digest). */
interface Verified {
  head: string
  count: number
  digest: string
  weights: Int32Array
}

export function ledgerDoor(o: LedgerDoorOptions): LedgerDoor {
  const { io } = o
  const conns = new Set<LedgerConn>()
  const bySubject = new Map<string, LedgerConn>()
  const kept = new Map<string, Verified>()
  const stats = { verified: 0, refused: 0, fetched: 0 }

  const write = (c: LedgerConn, frame: Buffer): void => {
    if (!c.socket.writable) return
    if (c.socket.writableLength > o.maxBacklog) {
      if (!c.closing) close(c, 4009, 'too slow to keep up')
      c.socket.destroy()
      return
    }
    c.socket.write(frame)
  }
  /** One message, sealed under the session token as the room seals its own (replication.ts sealMessage). */
  const send = (c: LedgerConn, body: Record<string, unknown>): void => {
    if (c.closing) return
    const n = ++c.sent
    const wire = JSON.stringify({ n, body, mac: o.mac(c.token, canonical({ n, body })) })
    write(c, io.writeFrame(io.OP.text, Buffer.from(wire, 'utf8')))
  }
  const close = (c: LedgerConn, code: number, reason: string): void => {
    if (c.closing) return
    c.closing = true
    c.buf = Buffer.alloc(0)
    conns.delete(c)
    if (bySubject.get(c.subject) === c) bySubject.delete(c.subject)
    o.log(`ledger session ${o.loggable(c.subject)} closed: ${o.loggable(reason)}`)
    if (c.socket.writable && c.socket.writableLength <= o.maxBacklog) c.socket.write(io.writeFrame(io.OP.close, io.closePayload(code, reason)))
    const t = setTimeout(() => c.socket.destroy(), 1000)
    t.unref()
    c.socket.once('close', () => clearTimeout(t))
    c.socket.end()
  }
  /** A refusal: said once, sealed, then the session ends. Nothing it sent is kept. */
  const refuse = (c: LedgerConn, reason: string): void => {
    stats.refused++
    send(c, { t: 'refused', reason })
    close(c, 4008, reason)
  }

  const onMessage = (c: LedgerConn, wire: string): void => {
    const env = readEnvelope(wire, LEDGER_FRAME)
    if (!env.ok) return refuse(c, env.reason)
    const fault = sealFault(env.msg, c.token, c.received, o.mac)
    if (fault !== null) return refuse(c, fault)
    c.received = env.msg.n
    const read = readLedgerMessage(env.msg.body)
    if (!read.ok) return refuse(c, read.reason)
    const m = read.value
    const s = c.session
    switch (m.t) {
      case 'hello': {
        const opened = begin(s, m.config, o.pinned)
        if (!opened.ok) return refuse(c, opened.reason)
        const cfg = opened.value
        send(c, { t: 'ready', digest: s.digest, name: cfg.name, capacity: cfg.capacity, stations: cfg.stations })
        return
      }
      case 'entries':
        for (const e of m.list) {
          const a = admit(s, e)
          if (!a.ok) return refuse(c, a.reason)
        }
        return
      case 'seal': {
        const sealed = seal(s, m as unknown as Record<string, unknown>)
        if (!sealed.ok) return refuse(c, sealed.reason)
        // Only now is anything kept: a copy of the folded weights, replacing the last of this configuration, and
        // only if it is the run the operator pinned (or nothing is pinned). A verified ledger that is another run is
        // lawful but not the fleet's: it is answered, not kept, so no token-holder can replace the fleet's weights.
        const pinned = o.seal
        const keep = pinned === undefined || (pinned.head === sealed.value.head && pinned.count === sealed.value.count && pinned.weights === sealed.value.weights)
        if (keep) kept.set(s.digest, { head: sealed.value.head, count: sealed.value.count, digest: sealed.value.weights, weights: s.weights.slice() })
        stats.verified++
        o.log(`ledger of ${o.loggable(c.subject)} verified: ${sealed.value.count} entries, head ${sealed.value.head.slice(0, 12)}${keep ? '' : ', not kept (not the pinned run)'}`)
        send(c, { t: 'verified', head: sealed.value.head, count: sealed.value.count, weights: sealed.value.weights, kept: keep })
        return
      }
      case 'fetch': {
        if (s.config === null) return refuse(c, 'fetch before hello')
        const v = kept.get(s.digest)
        if (!v) {
          send(c, { t: 'none' })
          return
        }
        const list = pairs(v.weights)
        for (let i = 0; i < list.length; i += WEIGHTS_CHUNK) send(c, { t: 'weights', list: list.slice(i, i + WEIGHTS_CHUNK) })
        send(c, { t: 'end', head: v.head, count: v.count, weights: v.digest, pairs: list.length })
        stats.fetched++
        return
      }
    }
  }

  const onFrame = (c: LedgerConn, opcode: number, payload: Buffer): void => {
    if (++c.frames > LEDGER_MAX_FRAMES) return refuse(c, 'too many frames')
    switch (opcode) {
      case io.OP.text:
        return onMessage(c, payload.toString('utf8'))
      case io.OP.binary:
        return refuse(c, 'binary frame')
      case io.OP.ping:
        write(c, io.writeFrame(io.OP.pong, payload))
        return
      case io.OP.close:
        return close(c, 1000, 'client closed')
      default:
        return
    }
  }

  const onData = (c: LedgerConn, chunk: Buffer): void => {
    if (c.closing) return
    c.buf = c.buf.length === 0 ? chunk : Buffer.concat([c.buf, chunk])
    while (!c.closing) {
      const r = io.readFrame(c.buf, LEDGER_FRAME)
      if (r.kind === 'more') return
      if (r.kind === 'bad') return close(c, r.code, r.reason)
      c.buf = c.buf.subarray(r.used)
      onFrame(c, r.opcode, r.payload)
    }
  }

  return {
    open(socket, key, token, subject, expires, head) {
      // One session per token subject, as one player holds one connection in the room.
      const before = bySubject.get(subject)
      if (before) close(before, 4010, 'replaced by a new connection')
      socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${io.acceptKey(key)}\r\nSec-WebSocket-Protocol: ${LEDGER_SUBPROTOCOL}\r\n\r\n`)
      const c: LedgerConn = { socket, token, subject, expires, session: newSession(), buf: Buffer.alloc(0), closing: false, sent: 0, received: 0, frames: 0 }
      conns.add(c)
      bySubject.set(subject, c)
      socket.setNoDelay(true)
      socket.on('data', (chunk: Buffer) => onData(c, chunk))
      socket.on('error', () => close(c, 1006, 'socket error'))
      socket.on('end', () => close(c, 1006, 'socket ended'))
      socket.on('close', () => close(c, 1006, 'socket closed'))
      o.log(`ledger session ${o.loggable(subject)} opened`)
      if (head.length > 0) onData(c, head)
    },
    tick(now) {
      for (const c of [...conns]) if (!(now < c.expires)) close(c, 4003, 'token expired')
    },
    close() {
      for (const c of [...conns]) close(c, 1001, 'host closing')
    },
    stats: () => ({ sessions: conns.size, ...stats }),
  }
}
