// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Sparkplug B Host Application inside the robot relay (docs/joint-bridge-spec.md
 * §3.3): one MQTT 3.1.1 session over node:net to a broker on this machine (off it only when the operator says
 * ROBOT_MQTT_ANY_HOST=1), opened in the order the Sparkplug specification requires (CONNECT with a clean session and a
 * retained Will of `{"online":false,"timestamp":T}` on the host's STATE topic, SUBSCRIBE to `spBv1.0/#` and that
 * STATE topic, then the retained `{"online":true,"timestamp":T}` with the same T; online again when a retained
 * offline older than T arrives), kept alive with PINGREQ at two thirds of the keepalive (a missed PINGRESP closes), and
 * reopened as a whole new session after a backoff from one second to thirty. It reads the broker's robots by the joint
 * convention sparkplug.ts defines: a DBIRTH with `Joints/Manifest` makes a device a robot, DDATA folds onto its last
 * frame (DDATA before DBIRTH is ignored), a gap in a node's seq asks for a rebirth once per five seconds, DDEATH takes
 * the device offline and NDEATH with the birth's bdSeq every device of the node, and commands to the host are ignored.
 * It hands the relay events (a session, a birth, data, a device gone) and takes DCMDs back (QoS 0, not retained, no seq).
 * It judges no frame itself: the relay runs checkFrame on what it reads, so one judge serves every door.
 * What breaks if it is removed? The relay has no broker door: a Sparkplug edge node cannot be a robot of the city.
 */
import { randomBytes } from 'node:crypto'
import { connect, type Socket } from 'node:net'
import { CONNACK_TEXT, encodePacket, PacketReader, SUBACK_FAILURE, type Packet } from './mqttCodec.ts'
import {
  decodePayload, encodePayload, frameFromData, metric, metricValue, nextSeq, parseState, parseTopic, robotFromBirth, SPARKPLUG, stateJson, stateTopic, topic,
  type DataRead, type Metric, type Payload, type SparkplugRobot,
} from './sparkplug.ts'

export const SPARKPLUG_HOST = Object.freeze({
  /** The host application id unless ROBOT_SPARKPLUG_HOST says otherwise. */
  hostId: 'agentcity',
  port: 1883,
  keepAliveS: 30,
  backoffMinMs: 1000,
  backoffMaxMs: 30_000,
  /** How long after one Rebirth request a node's next gap waits before another, ms. */
  rebirthDebounceMs: 5000,
  /** The largest MQTT packet read from the broker, bytes (a 64-joint birth with aliases is a few kilobytes). */
  maxPacket: 1 << 20,
})

export type SparkplugEvent =
  | { kind: 'session'; online: boolean; why: string }
  /** A DBIRTH that carried a manifest: `read` holds the birth's own values as the first frame. */
  | { kind: 'birth'; id: string; robot: SparkplugRobot; read: DataRead }
  | { kind: 'data'; id: string; read: DataRead }
  | { kind: 'gone'; id: string; why: string }

export interface SparkplugHostOptions {
  /** `mqtt://host:port` (plain TCP; TLS is not built). */
  url: string
  hostId?: string
  /** `<hostId>-<8 hex>` unless given (tests pin one). */
  clientId?: string
  username?: string
  password?: string
  /** The broker may be off loopback (ROBOT_MQTT_ANY_HOST=1). */
  anyHost?: boolean
  keepAliveS?: number
  backoff?: { minMs: number; maxMs: number }
  rebirthDebounceMs?: number
  now?: () => number
  log?: (line: string) => void
  onEvent: (e: SparkplugEvent) => void
}

export interface SparkplugHostStats {
  /** Sessions the broker accepted (CONNACK 0). */
  sessions: number
  online: boolean
  rebirths: number
  /** Messages read and set aside: DDATA before DBIRTH, a birth the judge refused, a payload that would not decode. */
  ignored: number
  devices: number
}

export interface SparkplugHost {
  readonly hostId: string
  readonly clientId: string
  /** A DCMD to the device: QoS 0, not retained, a payload timestamp and no seq. False when the device or the session is not there. */
  command(id: string, metrics: readonly Metric[]): boolean
  stats(): SparkplugHostStats
  /** Publishes the host offline (the same T as its birth), disconnects and stops reconnecting. */
  close(): Promise<void>
}

const isLoopback = (hostname: string): boolean => hostname === 'localhost' || hostname === '[::1]' || hostname === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)

/** The broker a `mqtt://` URL names. Throws on another scheme, a bad URL, or a host off this machine without `anyHost`. */
export function brokerAddress(url: string, anyHost: boolean): { host: string; port: number } {
  let u: URL
  try { u = new URL(url) } catch { throw new Error(`ROBOT_MQTT is not a URL: ${url}`) }
  if (u.protocol !== 'mqtt:') throw new Error(`ROBOT_MQTT must be mqtt://host:port (plain TCP; got ${u.protocol})`)
  if (u.hostname === '') throw new Error('ROBOT_MQTT names no host')
  if (!anyHost && !isLoopback(u.hostname)) throw new Error(`the broker ${u.hostname} is off this machine: set ROBOT_MQTT_ANY_HOST=1 to allow it`)
  const port = u.port === '' ? SPARKPLUG_HOST.port : Number(u.port)
  const host = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname
  return { host, port }
}

interface NodeState { group: string; node: string; bdSeq: number | undefined; seq: number; rebirthAt: number }
interface DeviceState { id: string; key: string; group: string; node: string; device: string; robot: SparkplugRobot; frame: DataRead['frame']; count: number }

const bdSeqOf = (p: Payload): number | undefined => {
  const m = p.metrics.find((x) => x.name === SPARKPLUG.bdSeq)
  const v = m ? metricValue(m) : undefined
  return typeof v === 'number' ? v : undefined
}

export function startSparkplugHost(o: SparkplugHostOptions): SparkplugHost {
  const now = o.now ?? Date.now
  const log = o.log ?? ((): void => {})
  const hostId = o.hostId ?? SPARKPLUG_HOST.hostId
  const state = stateTopic(hostId)
  const address = brokerAddress(o.url, o.anyHost ?? false)
  const clientId = o.clientId ?? `${hostId}-${randomBytes(4).toString('hex')}`
  const keepAliveS = o.keepAliveS ?? SPARKPLUG_HOST.keepAliveS
  const backoff = o.backoff ?? { minMs: SPARKPLUG_HOST.backoffMinMs, maxMs: SPARKPLUG_HOST.backoffMaxMs }
  const debounce = o.rebirthDebounceMs ?? SPARKPLUG_HOST.rebirthDebounceMs
  const nodes = new Map<string, NodeState>()
  const devices = new Map<string, DeviceState>()
  const stats = { sessions: 0, rebirths: 0, ignored: 0 }
  let socket: Socket | null = null
  let reader = new PacketReader(SPARKPLUG_HOST.maxPacket)
  let stopped = false
  let online = false
  /** This session's T: the Will's timestamp, the birth's and the graceful leave's. */
  let birthT = 0
  let delay = backoff.minMs
  let packetId = 0
  let awaitingPong = false
  let pinger: ReturnType<typeof setInterval> | null = null
  let reconnect: ReturnType<typeof setTimeout> | null = null

  const nextId = (): number => { packetId = (packetId % 65_535) + 1; return packetId }
  const send = (p: Packet): void => { if (socket && !socket.destroyed) socket.write(encodePacket(p)) }
  const publishState = (up: boolean): void => send({ type: 'publish', topic: state, payload: stateJson(up, birthT), qos: 1, retain: true, dup: false, packetId: nextId() })
  const stopPinger = (): void => { if (pinger) clearInterval(pinger); pinger = null }

  /** Every device goes offline with the session: a new session asks the nodes to be born again. */
  const forget = (why: string): void => {
    for (const id of [...devices.keys()]) {
      devices.delete(id)
      o.onEvent({ kind: 'gone', id, why })
    }
    nodes.clear()
  }

  const drop = (why: string): void => {
    const s = socket
    socket = null
    stopPinger()
    if (s && !s.destroyed) s.destroy()
    const was = online
    online = false
    forget('offline')
    log(`sparkplug: session dropped: ${why}${stopped ? '' : `; reconnecting in ${delay} ms`}`)
    if (was || stats.sessions > 0) o.onEvent({ kind: 'session', online: false, why })
    if (!stopped && reconnect === null) {
      reconnect = setTimeout(open, delay)
      reconnect.unref()
      delay = Math.min(backoff.maxMs, delay * 2)
    }
  }

  const rebirth = (n: NodeState): void => {
    const t = now()
    if (t - n.rebirthAt < debounce) return
    n.rebirthAt = t
    stats.rebirths++
    log(`sparkplug: asking ${n.group}/${n.node} to be born again`)
    send({ type: 'publish', topic: topic(n.group, 'NCMD', n.node), payload: encodePayload({ timestamp: t, metrics: [metric(SPARKPLUG.rebirth, 'Boolean', true, t)] }), qos: 0, retain: false, dup: false })
  }

  /** A node's seq must rise by one (wrapping at 255) across every message it and its devices send; a gap asks for a rebirth. */
  const seqCheck = (n: NodeState, p: Payload): void => {
    if (p.seq === undefined) return
    if (p.seq !== nextSeq(n.seq)) rebirth(n)
    n.seq = p.seq
  }
  const nodeOf = (group: string, node: string, p: Payload): NodeState => {
    const key = `${group}/${node}`
    let n = nodes.get(key)
    // A node first seen through one of its own messages (no NBIRTH yet) starts one behind that message's seq, so the
    // message itself is no gap; its NBIRTH, when it comes, resets the count.
    if (!n) nodes.set(key, (n = { group, node, bdSeq: undefined, seq: ((p.seq ?? 1) + 255) & 255, rebirthAt: Number.NEGATIVE_INFINITY }))
    return n
  }

  const onPublish = (p: Extract<Packet, { type: 'publish' }>): void => {
    if (p.topic === state) {
      // The broker delivered our own retained offline certificate from an earlier life: say online again.
      const st = parseState(p.payload)
      if (st && !st.online && st.timestamp < birthT && online) {
        log('sparkplug: a retained offline STATE older than this session: publishing online again')
        publishState(true)
      }
      return
    }
    const t = parseTopic(p.topic)
    if (t === null || t.kind === 'state') return
    let payload: Payload
    try { payload = decodePayload(p.payload) } catch (e) {
      stats.ignored++
      log(`sparkplug: ${p.topic}: ${e instanceof Error ? e.message : String(e)}`)
      return
    }
    const key = `${t.group}/${t.node}`
    switch (t.type) {
      case 'NBIRTH': {
        const n = nodeOf(t.group, t.node, payload)
        n.bdSeq = bdSeqOf(payload)
        n.seq = payload.seq ?? 0
        return
      }
      case 'NDEATH': {
        const n = nodes.get(key)
        const bd = bdSeqOf(payload)
        if (!n || (bd !== undefined && n.bdSeq !== undefined && bd !== n.bdSeq)) {
          stats.ignored++
          log(`sparkplug: NDEATH for ${key} with bdSeq ${bd} (the birth said ${n?.bdSeq}): ignored`)
          return
        }
        for (const d of [...devices.values()]) {
          if (d.key !== key) continue
          devices.delete(d.id)
          o.onEvent({ kind: 'gone', id: d.id, why: 'NDEATH' })
        }
        nodes.delete(key)
        return
      }
      case 'NDATA':
        seqCheck(nodeOf(t.group, t.node, payload), payload)
        return
      case 'DBIRTH': {
        const n = nodeOf(t.group, t.node, payload)
        seqCheck(n, payload)
        const read = robotFromBirth(payload.metrics)
        if (read === null) return
        const id = `${t.group}/${t.node}/${t.device}`
        if (!read.ok) {
          stats.ignored++
          log(`sparkplug: ${id} is born with a manifest the judge refuses: ${read.reason}`)
          return
        }
        const first = frameFromData(read.value, payload, null, 0, now())
        devices.set(id, { id, key, group: t.group, node: t.node, device: t.device, robot: read.value, frame: first.frame, count: 0 })
        o.onEvent({ kind: 'birth', id, robot: read.value, read: first })
        return
      }
      case 'DDEATH': {
        const id = `${t.group}/${t.node}/${t.device}`
        const n = nodes.get(key)
        if (n) seqCheck(n, payload)
        if (devices.delete(id)) o.onEvent({ kind: 'gone', id, why: 'DDEATH' })
        return
      }
      case 'DDATA': {
        const id = `${t.group}/${t.node}/${t.device}`
        const d = devices.get(id)
        if (!d) {
          stats.ignored++
          log(`sparkplug: DDATA for ${id} before its DBIRTH: ignored`)
          return
        }
        seqCheck(nodeOf(t.group, t.node, payload), payload)
        const read = frameFromData(d.robot, payload, d.frame, ++d.count, now())
        d.frame = read.frame
        if (read.unknownAliases > 0) rebirth(nodeOf(t.group, t.node, payload))
        o.onEvent({ kind: 'data', id, read })
        return
      }
      default:
        // NCMD and DCMD are for the nodes; the host takes no command.
        return
    }
  }

  const onPacket = (p: Packet): void => {
    switch (p.type) {
      case 'connack':
        if (p.code !== 0) {
          drop(`the broker refused the session: ${CONNACK_TEXT[p.code] ?? p.code}`)
          return
        }
        stats.sessions++
        delay = backoff.minMs
        send({ type: 'subscribe', packetId: nextId(), topics: [{ filter: `${SPARKPLUG.namespace}/#`, qos: 0 }, { filter: state, qos: 1 }] })
        awaitingPong = false
        stopPinger()
        pinger = setInterval(() => {
          if (awaitingPong) { drop('missed PINGRESP'); return }
          awaitingPong = true
          send({ type: 'pingreq' })
        }, Math.max(1, Math.floor((keepAliveS * 1000 * 2) / 3)))
        pinger.unref()
        return
      case 'suback':
        if (p.codes.includes(SUBACK_FAILURE)) {
          drop(`the broker refused a subscription (SUBACK ${p.codes.map((c) => c.toString(16)).join(',')})`)
          return
        }
        if (!online) {
          online = true
          publishState(true)
          log(`sparkplug: online as ${hostId} (${clientId}) at mqtt://${address.host}:${address.port}`)
          o.onEvent({ kind: 'session', online: true, why: 'subscribed' })
        }
        return
      case 'publish':
        if (p.qos === 1 && p.packetId !== undefined) send({ type: 'puback', packetId: p.packetId })
        else if (p.qos === 2 && p.packetId !== undefined) send({ type: 'pubrec', packetId: p.packetId })
        onPublish(p)
        return
      case 'pubrel':
        send({ type: 'pubcomp', packetId: p.packetId })
        return
      case 'pingresp':
        awaitingPong = false
        return
      default:
        return
    }
  }

  const open = (): void => {
    reconnect = null
    if (stopped) return
    reader = new PacketReader(SPARKPLUG_HOST.maxPacket)
    birthT = now()
    const s = connect(address.port, address.host)
    socket = s
    s.setNoDelay(true)
    s.on('connect', () => {
      const c: Packet = {
        type: 'connect', clientId, keepAlive: keepAliveS, cleanSession: true, protocolLevel: 4,
        will: { topic: state, payload: stateJson(false, birthT), qos: 1, retain: true },
      }
      if (o.username !== undefined) c.username = o.username
      if (o.password !== undefined && o.username !== undefined) c.password = new TextEncoder().encode(o.password)
      send(c)
    })
    s.on('data', (chunk: Buffer) => {
      if (socket !== s) return
      for (const p of reader.feed(chunk)) {
        onPacket(p)
        if (socket !== s) return
      }
      if (reader.error !== null) drop(`a malformed packet from the broker: ${reader.error}`)
    })
    s.on('error', (e: Error) => { if (socket === s) drop(`socket error: ${e.message}`) })
    s.on('close', () => { if (socket === s) drop('the broker closed the connection') })
  }

  open()

  return {
    hostId,
    clientId,
    command: (id, metrics) => {
      const d = devices.get(id)
      if (!d || !online) return false
      send({ type: 'publish', topic: topic(d.group, 'DCMD', d.node, d.device), payload: encodePayload({ timestamp: now(), metrics: [...metrics] }), qos: 0, retain: false, dup: false })
      return true
    },
    stats: () => ({ ...stats, online, devices: devices.size }),
    close: () =>
      new Promise<void>((done) => {
        stopped = true
        if (reconnect) clearTimeout(reconnect)
        reconnect = null
        stopPinger()
        const s = socket
        // The graceful leave: offline (the same T), then DISCONNECT so the broker drops the Will, then the socket.
        if (s && !s.destroyed && online) publishState(false)
        socket = null
        online = false
        forget('closing')
        if (!s || s.destroyed) { done(); return }
        s.write(encodePacket({ type: 'disconnect' }), () => s.end())
        const t = setTimeout(() => s.destroy(), 500)
        t.unref()
        s.once('close', () => { clearTimeout(t); done() })
      }),
  }
}
