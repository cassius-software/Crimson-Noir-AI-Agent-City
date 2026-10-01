/**
 * Why does this file exist? It is the page's half of the replication scaffold: the room client. It is opt-in only:
 * nothing imports it at boot, it opens no socket until the operator asks (a later console command hands it a URL, a
 * session token and a name), and it speaks only ws or wss to a loopback address (the gate of
 * 02_Define_The_Rules/airgap.ts: the host on this machine, or the local end of a proxy the operator runs), so neither
 * a token nor a pose leaves this machine from the page. It sends inputs at the core's own rate, reads every message from the
 * host through the core's validator (the host is not trusted either: enough malformed messages and the client leaves),
 * reconciles each snapshot into a replica of remote POSES the page draws (never bodies in the physics realm), relays
 * chat and pings to callbacks, and screens its own chat under 14A before sending. Voice: a peer's MediaStream is
 * handed to a callback; the RTCPeerConnection plumbing (offer, answer and candidates relayed through this socket) is
 * a documented stub in this scaffold, so no voice is sent or received yet. The socket factory is injectable, so the
 * whole client is tested in Node without a browser.
 * What breaks if it is removed? The page cannot join a host; the host and the core are unchanged.
 */
import {
  admissibleChat, emptyReplica, LIMITS, openServerFrame, peerBuckets, predict, PROTOCOL_VERSION, reconcile, sealMessage, take,
  type ClientMessage, type InputMessage, type PeerBuckets, type PingRelayMessage, type ChatRelayMessage, type RemotePlayer, type Replica,
} from './replication.ts'
import type { PingKind } from '../08_Swarm/ping.ts'
import { netServer } from '../02_Define_The_Rules/airgap.ts'

/**
 * The host's address, path included, if it may be spoken to: ws or wss to a loopback address only (a host on this
 * machine, or the local end of a proxy); no user name or password; nothing else. Null for anything else. The gate
 * itself (airgap.ts netServer) under the name this client has always used.
 */
export { netServer }

/** The slice of a WebSocket the client uses, so a test can hand it a fake and Node 22 can hand it its global. */
export interface NetSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: { code: number; reason: string }) => void) | null
  onerror: ((ev: unknown) => void) | null
}

export type NetStatus = 'idle' | 'connecting' | 'joining' | 'joined' | 'closed'

export interface NetClientOptions {
  /** Opens a socket to a URL netServer has accepted; the browser's WebSocket unless a test injects one. */
  open?: (url: string) => NetSocket
  /** Wall clock, ms. */
  now?: () => number
  onStatus?: (status: NetStatus, reason: string | null) => void
  onChat?: (msg: ChatRelayMessage) => void
  onPing?: (msg: PingRelayMessage) => void
}

export interface NetClient {
  readonly status: NetStatus
  /** This client's id in the room (0 until welcomed). */
  readonly id: number
  readonly replica: Replica
  /** Why the client is closed, once it is. */
  readonly reason: string | null
  /** Starts a session, or says why it did not (a refused URL, or a session already open). */
  connect(url: string, token: string, name: string): string | null
  /** One frame of input (desired walking velocity, heading): false when not joined or over the client's own rate. */
  sendInput(x: number, z: number, heading: number): boolean
  /** A chat line, screened here first: false when inadmissible, not joined, or over rate. */
  sendChat(text: string): boolean
  sendPing(kind: PingKind, x: number, y: number, z: number): boolean
  /** Every remote pose, carried forward to `now` by its own velocity (at most LIMITS.predictS). */
  poses(now?: number): readonly RemotePlayer[]
  /** Inputs the host has not yet applied. */
  pending(): readonly InputMessage[]
  leave(): void
  /** A peer's voice as a MediaStream, when one arrives; returns the unsubscribe. */
  onVoice(cb: (id: number, stream: MediaStream) => void): () => void
  /**
   * Offers this player's voice to the room. A documented stub: the RTCPeerConnection offer, answer and candidates
   * would ride this socket as a `signal` message the protocol does not carry yet, so it returns why nothing happened.
   */
  offerVoice(stream: MediaStream): string
}

/** Malformed messages from the host the client tolerates before it leaves. */
export const HOST_REFUSALS = LIMITS.refusalsBeforeKick

export function createNetClient(o: NetClientOptions = {}): NetClient {
  const now = o.now ?? (() => Date.now())
  const open = o.open ?? ((url: string): NetSocket => {
    // connect() has already held the URL to this machine; the socket is still only ever made for one the gate admits.
    if (netServer(url) === null) throw new Error('only ws or wss to this machine, with no credentials')
    return new WebSocket(url) as unknown as NetSocket
  })
  let status: NetStatus = 'idle'
  let reason: string | null = null
  let socket: NetSocket | null = null
  let id = 0
  let replica: Replica = emptyReplica(0)
  let seq = 0
  let said = 0
  let refusals = 0
  let buckets: PeerBuckets = peerBuckets(now())
  let snapshotAt = 0
  let unsent: InputMessage[] = []
  // The seal (replication.ts sealMessage): every frame out is numbered and signed under the session token, every
  // frame in must be signed under it and numbered above the last; one that is not is dropped as a host refusal.
  let key = ''
  let sent = 0
  let received = 0
  const voice = new Set<(id: number, stream: MediaStream) => void>()

  const setStatus = (s: NetStatus, why: string | null = null): void => {
    status = s
    if (s === 'closed') reason = why
    o.onStatus?.(s, why)
  }
  const send = (msg: ClientMessage): boolean => {
    if (!socket || status === 'idle' || status === 'closed' || status === 'connecting') return false
    socket.send(sealMessage(msg, ++sent, key))
    return true
  }
  const end = (code: number, why: string): void => {
    if (!socket) return
    const s = socket
    socket = null
    try {
      s.close(code, why)
    } catch {
      // already gone
    }
    setStatus('closed', why)
  }

  const onMessage = (data: unknown): void => {
    const read = openServerFrame(data, key, received)
    if (!read.ok) {
      if (++refusals >= HOST_REFUSALS) end(1002, `host: ${read.reason}`)
      return
    }
    received = read.n
    const msg = read.msg
    switch (msg.t) {
      case 'welcome':
        if (status !== 'joining') return
        id = msg.id
        replica = reconcile(emptyReplica(id), { t: 'snapshot', tick: msg.tick, ack: 0, players: msg.players })
        snapshotAt = now()
        setStatus('joined')
        return
      case 'snapshot': {
        const next = reconcile(replica, msg)
        if (next !== replica) {
          replica = next
          snapshotAt = now()
          unsent = unsent.filter((i) => i.seq > replica.ack)
        }
        return
      }
      case 'chat':
        o.onChat?.(msg)
        return
      case 'ping':
        o.onPing?.(msg)
        return
      case 'joined':
      case 'left':
        // The next snapshot carries the room; nothing to do here.
        return
    }
  }

  return {
    get status() { return status },
    get id() { return id },
    get replica() { return replica },
    get reason() { return reason },
    connect(url, token, name) {
      if (socket) return 'a session is already open'
      const href = netServer(url)
      if (href === null) return 'only ws or wss to this machine, with no credentials'
      if (typeof token !== 'string' || token.length === 0 || token.length > LIMITS.token) return 'a session token is required'
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > LIMITS.name) return `a name of 1 to ${LIMITS.name} characters is required`
      let s: NetSocket
      try {
        s = open(href)
      } catch (e) {
        return `cannot open: ${e instanceof Error ? e.message : String(e)}`
      }
      socket = s
      id = 0
      replica = emptyReplica(0)
      seq = 0
      said = 0
      refusals = 0
      buckets = peerBuckets(now())
      unsent = []
      key = token
      sent = 0
      received = 0
      reason = null
      setStatus('connecting')
      s.onopen = () => {
        if (socket !== s) return
        setStatus('joining')
        send({ t: 'join', v: PROTOCOL_VERSION, token, name: name.trim() })
      }
      s.onmessage = (ev) => { if (socket === s) onMessage(ev.data) }
      s.onclose = (ev) => {
        if (socket !== s) return
        socket = null
        setStatus('closed', ev.reason || `closed (${ev.code})`)
      }
      s.onerror = () => { if (socket === s) end(1006, 'socket error') }
      return null
    },
    sendInput(x, z, heading) {
      if (status !== 'joined' || ![x, z, heading].every(Number.isFinite)) return false
      if (!take(buckets.input, now())) return false
      const msg: InputMessage = { t: 'input', seq: ++seq, ack: replica.tick, x, z, heading }
      if (unsent.length < LIMITS.inputBurst) unsent.push(msg)
      return send(msg)
    },
    sendChat(text) {
      if (status !== 'joined') return false
      const line = admissibleChat(text)
      if (line === null || !take(buckets.chat, now())) return false
      return send({ t: 'chat', seq: ++said, text: line })
    },
    sendPing(kind, x, y, z) {
      if (status !== 'joined' || ![x, y, z].every(Number.isFinite)) return false
      if (!take(buckets.ping, now())) return false
      return send({ t: 'ping', seq: ++said, kind, x, y, z })
    },
    poses(at = now()) {
      const dt = (at - snapshotAt) / 1000
      return dt > 0 ? replica.players.map((p) => predict(p, dt)) : replica.players
    },
    pending: () => unsent,
    leave() {
      if (!socket) return
      send({ t: 'leave' })
      end(1000, 'left')
    },
    onVoice(cb) {
      voice.add(cb)
      return () => { voice.delete(cb) }
    },
    offerVoice(stream) {
      if (status !== 'joined') return 'voice: not joined'
      if (typeof RTCPeerConnection === 'undefined') return 'voice: this page has no peer connection (the air gap removes it)'
      if (stream.getAudioTracks().length === 0) return 'voice: the stream has no audio track'
      return 'voice: signalling is not in this scaffold (no offer is sent)'
    },
  }
}
