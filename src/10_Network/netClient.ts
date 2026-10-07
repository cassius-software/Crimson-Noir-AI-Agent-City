/**
 * Why does this file exist? It is the page's half of the network room: the room client. It is opt-in only: nothing
 * imports it at boot, it opens no socket until the operator asks (a later console command hands it a URL, a session
 * token and a name), and it speaks only ws or wss to `localhost` or `127.0.0.1`, the hosts the page's content security
 * policy reaches (the gate of 02_Define_The_Rules/airgap.ts: the host on this machine, or the local end of a proxy the
 * operator runs), so neither a token nor a pose leaves this machine from the page. The token rides the upgrade as a
 * subprotocol (replication.ts authProtocol), so the host checks it before a socket exists. The room is authoritative
 * (Phase 12) and the page's own physics realm is the prediction: the player moves at once, and every realm step the
 * engine hands over (move) is reported as what the realm applied to each run of fixed substeps (on foot the walking
 * velocity, at the wheel the vetted wheel command) and where the realm then had the player (the claim), coalesced into
 * runs while the input rate is spent; a step that took a door (into a car, in the state the realm took it over in, or
 * out of one) starts an input of its own (Phase 13). A correction from the host (the welcome's spawn is the first) is
 * the truth to snap to: the engine puts the player down there (at the wheel, the car in the room's state), and steps
 * the realm ran before that are never sent (the host would drop them unread). While nothing else goes out (a hidden
 * tab, a player standing still) a keepalive ack does, so a quiet page is not taken for a gone one. It reads every
 * message from the host through the core's validator (the host is not trusted either: enough malformed messages and the
 * client leaves), reconciles each snapshot into a replica of remote POSES the page draws (never bodies in the physics
 * realm), relays chat and pings to callbacks, and screens its own chat under 14A before sending. Voice: a peer's
 * MediaStream is handed to a callback; the RTCPeerConnection plumbing (offer, answer and candidates relayed through
 * this socket) is a documented stub in this scaffold, so no voice is sent or received yet. The socket factory is
 * injectable, so the whole client is tested in Node without a browser.
 * What breaks if it is removed? The page cannot join a host; the host and the core are unchanged.
 */
import {
  admissibleChat, authProtocol, emptyReplica, LIMITS, openServerFrame, peerBuckets, predict, PROTOCOL_VERSION, reconcile, sealMessage, SUBPROTOCOL,
  take, type CarFix, type ClientMessage, type Door, type InputMessage, type PeerBuckets, type PingRelayMessage, type ChatRelayMessage,
  type RemotePlayer, type Replica, type Run,
} from './replication.ts'
import type { PingKind } from '../08_Swarm/ping.ts'
import { netServer } from '../02_Define_The_Rules/airgap.ts'

/**
 * The host's address, path included, if it may be spoken to: ws or wss to `localhost` or `127.0.0.1` only (a host on this
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
  /** Opens a socket to a URL netServer has accepted, offering `protocols`; the browser's WebSocket unless a test injects one. */
  open?: (url: string, protocols: string[]) => NetSocket
  /** Wall clock, ms. */
  now?: () => number
  onStatus?: (status: NetStatus, reason: string | null) => void
  onChat?: (msg: ChatRelayMessage) => void
  onPing?: (msg: PingRelayMessage) => void
  /** Runs `fn` every `ms` until the returned stop is called: setInterval unless a test injects a clock of its own. */
  every?: (fn: () => void, ms: number) => () => void
}

/** How long the client stays silent before it sends a keepalive ack (the host drops a peer silent for LIMITS.idleTimeoutMs), ms. */
export const KEEPALIVE_MS = 5000

/**
 * One step of the page's physics realm, as the engine reports it: the door it took first, if any (the realm's own
 * entered or exited event), then what the room replays for each of its `n` fixed substeps (on foot the walking velocity
 * `x`, `z` as the realm clamped it; at the wheel the command its car ran, `wheels`), where the realm then had the player
 * (`at`: the capsule centre on foot, the chassis centre at the wheel), and the correction the realm had applied when
 * it ran the step.
 */
export interface Move {
  mode: 'foot' | 'drive'
  x: number
  z: number
  wheels?: { throttle: number; brake: number; steer: number; handbrake: boolean }
  n: number
  heading: number
  at: { x: number; y: number; z: number }
  door?: Door
  fix: number
}

/**
 * What became of a step: sent in an input, held for the next one (the input rate is spent), idle (no substep and no
 * door: nothing to say), stale (run before the page applied the newest correction: the room would drop it unread), or
 * refused (not joined, or not a step the room could read).
 */
export type MoveStatus = 'sent' | 'held' | 'idle' | 'stale' | 'refused'

/**
 * The truth to snap to: where the host has the player, under correction `fix`, and why (the welcome's spawn is the
 * first); at the wheel, `car`, the car's full state, which the page puts its car in. `drift`: the room kept the input
 * and only puts the page back where its replay ended (not a correction of the player's: no count, no notice).
 */
export interface Correction { fix: number; x: number; y: number; z: number; reason: string; car?: CarFix; drift?: true }

export interface NetClient {
  readonly status: NetStatus
  /** This client's id in the room (0 until welcomed). */
  readonly id: number
  readonly replica: Replica
  /** Why the client is closed, once it is. */
  readonly reason: string | null
  /** Corrections the host has sent this session (the welcome's spawn not counted), and the newest one's reason. */
  readonly corrections: number
  readonly corrected: string | null
  /** Starts a session in `world` (the room refuses another), or says why it did not (a refused URL or token, a session already open). */
  connect(url: string, token: string, name: string, world: string): string | null
  /** One step of the realm, reported (MoveStatus says what became of it). */
  move(m: Move): MoveStatus
  /** The newest correction (null before the welcome): the engine snaps to it once, when its `fix` is new to the page. */
  correction(): Correction | null
  /** A chat line, screened here first: false when inadmissible, not joined, or over rate. */
  sendChat(text: string): boolean
  sendPing(kind: PingKind, x: number, y: number, z: number): boolean
  /** Every remote pose, carried forward to `now` by its own velocity (at most LIMITS.predictS). */
  poses(now?: number): readonly RemotePlayer[]
  /**
   * Inputs sent and not yet acknowledged by the host. A correction empties it: the host drops unread everything sent
   * under the correction before.
   */
  pending(): readonly InputMessage[]
  /**
   * The link is stalled: MAX_IN_FLIGHT inputs are in flight unacknowledged, so steps are held (and past one input's
   * bounds dropped) until the host answers.
   */
  readonly stalled: boolean
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

/**
 * The inputs a client keeps in flight, unacknowledged, before it reads its link as stalled and sends nothing more until
 * the host answers: the host's input burst less a margin (two and a half seconds of steps; a room acknowledges at least
 * once a second). A stall's backlog then always arrives within the host's input allowance, which refilled while the
 * link was stalled, so an honest client is never refused for one: a stall shorter than this costs nothing, and a
 * longer one costs one correction (the steps taken past the cap are held, and past one input's bounds dropped, so the
 * room corrects the next input), never a refusal.
 */
export const MAX_IN_FLIGHT = LIMITS.inputBurst - 30

export function createNetClient(o: NetClientOptions = {}): NetClient {
  const now = o.now ?? (() => Date.now())
  const open = o.open ?? ((url: string, protocols: string[]): NetSocket => {
    // connect() has already held the URL to this machine; the socket is still only ever made for one the gate admits.
    if (netServer(url) === null) throw new Error('only ws or wss to localhost or 127.0.0.1 (this machine, as the page\'s policy allows), with no credentials')
    return new WebSocket(url, protocols) as unknown as NetSocket
  })
  let status: NetStatus = 'idle'
  let reason: string | null = null
  let socket: NetSocket | null = null
  let id = 0
  let replica: Replica = emptyReplica(0)
  let seq = 0
  let said = 0
  let refusals = 0
  let buckets: PeerBuckets = peerBuckets(now(), 1)
  let snapshotAt = 0
  let unsent: InputMessage[] = []
  // The authority: the newest correction received, and the steps not yet sent (runs of one mode, claimed at `claim`).
  let fix = 0
  let truth: Correction | null = null
  let corrections = 0
  let corrected: string | null = null
  let world = ''
  /** Steps not yet sent: runs of one mode (each a run's key, then its substeps last), claimed at `claim`, after `door`. */
  let held: { mode: 'foot' | 'drive'; segs: number[][]; heading: number; claim: { x: number; y: number; z: number }; door?: Door } | null = null
  /** When anything last went out, ms (the keepalive's clock), and the keepalive's stop. */
  let lastSent = 0
  let stopKeepalive: (() => void) | null = null
  const every = o.every ?? ((fn: () => void, ms: number): (() => void) => {
    const t = setInterval(fn, ms)
    // In Node (the tests, the smoke) the keepalive never holds the process open on its own.
    ;(t as unknown as { unref?: () => void }).unref?.()
    return () => clearInterval(t)
  })
  // The seal (replication.ts sealMessage): every frame out is numbered and signed under the session token, every
  // frame in must be signed under it and numbered above the last; one that is not is dropped as a host refusal.
  let key = ''
  let sent = 0
  let received = 0
  const voice = new Set<(id: number, stream: MediaStream) => void>()

  const setStatus = (s: NetStatus, why: string | null = null): void => {
    status = s
    if (s === 'closed') {
      reason = why
      stopKeepalive?.()
      stopKeepalive = null
    }
    o.onStatus?.(s, why)
  }
  const send = (msg: ClientMessage): boolean => {
    if (!socket || status === 'idle' || status === 'closed' || status === 'connecting') return false
    socket.send(sealMessage(msg, ++sent, key))
    lastSent = now()
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
        replica = reconcile(emptyReplica(id), { t: 'snapshot', tick: msg.tick, ack: 0, fix: msg.fix, you: msg.you, players: msg.players })
        snapshotAt = now()
        // The spawn is the first correction: the page puts the player down where the room has them.
        fix = msg.fix
        truth = { fix: msg.fix, x: msg.you.x, y: msg.you.y, z: msg.you.z, reason: 'welcome' }
        held = null
        setStatus('joined')
        return
      case 'correct':
        if (status !== 'joined' || msg.fix <= fix) return
        fix = msg.fix
        truth = { fix: msg.fix, x: msg.you.x, y: msg.you.y, z: msg.you.z, reason: msg.reason, ...(msg.car && { car: msg.car }), ...(msg.drift && { drift: true as const }) }
        // A drift resync (an input the room kept, the page put back) is no correction of the player's.
        if (!msg.drift) {
          corrections++
          corrected = msg.reason
        }
        // Steps the realm ran before it is put down at the truth describe a body the room never had, and everything sent
        // under the correction before is dropped by the room unread: nothing is pending any more.
        held = null
        unsent = []
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

  /** A run's substeps (its last entry), and whether two runs share a key (everything but the substeps). */
  const stepsOf = (r: readonly number[]): number => r[r.length - 1]
  const sameKey = (a: readonly number[] | undefined, key: readonly number[]): boolean =>
    a !== undefined && a.length === key.length + 1 && key.every((v, i) => a[i] === v)
  /** Whether a run of `n` substeps under `key` can join `segs` within one input's bounds. */
  const fits = (segs: readonly (readonly number[])[], key: readonly number[], n: number): boolean => {
    const total = segs.reduce((a, r) => a + stepsOf(r), 0)
    return total + n <= LIMITS.stepsPerInput && (sameKey(segs[segs.length - 1], key) || segs.length < LIMITS.runs)
  }

  /** Sends what is held as one input when the rate allows (or `force`d: a mode change, a door, a full input). */
  const flush = (force: boolean): boolean => {
    if (!held) return true
    // A stalled link: nothing more goes out until the host acknowledges what is in flight. What a forced flush would have
    // sent is dropped instead (the room corrects the next input, once).
    if (unsent.length >= MAX_IN_FLIGHT) {
      if (force) held = null
      return false
    }
    if (!take(buckets.input, now()) && !force) return false
    const h = held
    held = null
    const segs = h.segs.map((r) => Object.freeze([...r])) as unknown as Run[]
    const msg: InputMessage = {
      t: 'input', seq: ++seq, ack: replica.tick, fix, mode: h.mode, segs, heading: Math.atan2(Math.sin(h.heading), Math.cos(h.heading)), claim: h.claim,
      ...(h.door && { door: h.door }),
    }
    unsent.push(msg)
    return send(msg)
  }

  /** The keepalive: what is held goes out once the rate allows, and a client silent for KEEPALIVE_MS acknowledges the newest snapshot. */
  const keepalive = (): void => {
    if (status !== 'joined') return
    if (held) flush(false)
    if (now() - lastSent >= KEEPALIVE_MS) send({ t: 'ack', ack: replica.tick })
  }

  return {
    get status() { return status },
    get id() { return id },
    get replica() { return replica },
    get reason() { return reason },
    connect(url, token, name, place) {
      if (socket) return 'a session is already open'
      const href = netServer(url)
      if (href === null) return 'only ws or wss to localhost or 127.0.0.1 (this machine, as the page\'s policy allows), with no credentials'
      if (typeof token !== 'string' || token.length === 0 || token.length > LIMITS.token) return 'a session token is required'
      const auth = authProtocol(token)
      if (auth === null) return 'that session token cannot be offered to a host (letters, digits, dots, dashes and underscores only)'
      if (typeof name !== 'string' || name.trim().length === 0 || name.length > LIMITS.name) return `a name of 1 to ${LIMITS.name} characters is required`
      if (typeof place !== 'string' || place.length === 0 || place.length > LIMITS.name) return 'the world this page walks is required'
      let s: NetSocket
      try {
        s = open(href, [SUBPROTOCOL, auth])
      } catch (e) {
        return `cannot open: ${e instanceof Error ? e.message : String(e)}`
      }
      socket = s
      id = 0
      replica = emptyReplica(0)
      seq = 0
      said = 0
      refusals = 0
      buckets = peerBuckets(now(), 1)
      unsent = []
      key = token
      sent = 0
      received = 0
      reason = null
      fix = 0
      truth = null
      corrections = 0
      corrected = null
      held = null
      world = place
      lastSent = now()
      stopKeepalive?.()
      stopKeepalive = every(keepalive, 1000)
      setStatus('connecting')
      s.onopen = () => {
        if (socket !== s) return
        setStatus('joining')
        send({ t: 'join', v: PROTOCOL_VERSION, token, name: name.trim(), world })
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
    move(m) {
      if (status !== 'joined') return 'refused'
      if (![m.n, m.heading, m.at.x, m.at.y, m.at.z].every(Number.isFinite)) return 'refused'
      // Run before the page applied the newest correction: the room would drop it unread.
      if (m.fix < fix) return 'stale'
      const n = Math.max(0, Math.floor(m.n))
      // What the room replays for each substep: the walking velocity, or the wheel command (the handbrake as 0 or 1).
      let key: number[]
      if (m.mode === 'foot') key = [m.x, m.z]
      else if (m.wheels) key = [m.wheels.throttle, m.wheels.brake, m.wheels.steer, m.wheels.handbrake ? 1 : 0]
      else return 'refused'
      if (!key.every(Number.isFinite)) return 'refused'
      const door = m.door
      // A step that ran no substep and took no door moved nothing (the heading rides the next input).
      if (n === 0 && !door) return 'idle'
      // A held input's claim is where its last run ended, so a step that cannot join it (another mode, a door, which
      // comes first in an input of its own, or no room) sends it first, whatever the rate says.
      if (held && (held.mode !== m.mode || door || !fits(held.segs, key, n))) flush(true)
      const segs = held?.segs ?? []
      const last = segs[segs.length - 1]
      if (sameKey(last, key)) last[last.length - 1] += n
      else segs.push([...key, n])
      const keep = door ?? held?.door
      held = { mode: m.mode, segs, heading: m.heading, claim: { x: m.at.x, y: m.at.y, z: m.at.z }, ...(keep && { door: keep }) }
      return flush(false) ? 'sent' : 'held'
    },
    correction: () => truth,
    get corrections() { return corrections },
    get corrected() { return corrected },
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
    get stalled() { return unsent.length >= MAX_IN_FLIGHT },
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
