#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is a simulated three-joint arm that joins the robot relay as a `/robot` peer
 * (docs/joint-bridge-spec.md §3.2), so the bridge can be tried end to end with no hardware:
 *
 *   node tools/robot/sim-arm.mjs ws://127.0.0.1:8790/robot <robot token> [--tau-ms 120] [--delay-ms 0] [--hz 50]
 *
 * It says hello with its manifest and the CAPS body of a servo actuator, answers `arm` with `armed`, beats every
 * 150 ms while armed, sends a state frame at --hz, and follows admitted setpoints as a first-order lag (time
 * constant --tau-ms) after a transport delay (--delay-ms), acknowledging each one. It keeps the device rule a real
 * arm must keep: hold q and report q̇ = 0 and τ = 0 when no fresh setpoints have arrived for 500 ms or the current
 * ttlMs has elapsed (judged from arrival), and on disarm; resume on the next fresh setpoints. Dependency-free: Node
 * 22's own WebSocket. The relay's test imports start() and drives the same code; the CLI below runs only when this
 * file is the program.
 * What breaks if it is removed? There is no peer to try the relay, the console and the twin against without a robot.
 */
import { pathToFileURL } from 'node:url'

/** The device rule's two numbers: the hold after the last fresh setpoints, and the beat period while armed. */
export const RULE = Object.freeze({ holdMs: 500, beatMs: 150 })

/** A three-joint arm: shoulder, elbow and wrist, revolute, with a fixed tool. */
export const MANIFEST = Object.freeze({
  robot: 'sim-arm',
  links: [
    { name: 'base', mass: 2, shape: { kind: 'cylinder', radius: 0.06, length: 0.08 } },
    { name: 'upper', mass: 1.2, shape: { kind: 'capsule', radius: 0.03, length: 0.3 } },
    { name: 'fore', mass: 0.8, shape: { kind: 'capsule', radius: 0.025, length: 0.25 } },
    { name: 'hand', mass: 0.3, shape: { kind: 'box', size: [0.05, 0.05, 0.08] } },
    { name: 'tool', mass: 0.05 },
  ],
  joints: [
    { name: 'shoulder', kind: 'revolute', parent: 'base', child: 'upper', origin: { xyz: [0, 0, 0.08], rpy: [0, 0, 0] }, axis: [0, 1, 0], lower: -1.6, upper: 1.6, effort: 12, velocity: 3 },
    { name: 'elbow', kind: 'revolute', parent: 'upper', child: 'fore', origin: { xyz: [0, 0, 0.3], rpy: [0, 0, 0] }, axis: [0, 1, 0], lower: -2.2, upper: 2.2, effort: 8, velocity: 3 },
    { name: 'wrist', kind: 'revolute', parent: 'fore', child: 'hand', origin: { xyz: [0, 0, 0.25], rpy: [0, 0, 0] }, axis: [0, 0, 1], lower: -3.1, upper: 3.1, effort: 2, velocity: 6 },
    { name: 'grip', kind: 'fixed', parent: 'hand', child: 'tool', origin: { xyz: [0, 0, 0.08], rpy: [0, 0, 0] } },
  ],
})

/** The CAPS body (docs/hal-peripherals-spec.md §3): an actuator with servo actuation. */
export const CAPS = Object.freeze({ class: 'actuator', telemetry: ['joints'], actuation: ['servo'] })

const JOINTS = 3

/**
 * Starts the arm against `url` with the robot `token`. Options: tauMs (120), delayMs (0), hz (50), log. Returns the
 * socket's `opened` and `closed` promises, `state()` (q, qd, tau, armed, holding, ack), and `close()`.
 */
export function start(url, token, options = {}) {
  const tauMs = options.tauMs ?? 120
  const delayMs = options.delayMs ?? 0
  const hz = options.hz ?? 50
  const log = options.log ?? (() => {})
  const ws = new WebSocket(url, ['joints.1', `auth.${token}`])
  const q = [0, 0, 0], qd = [0, 0, 0], tau = [0, 0, 0]
  let id = null
  let seq = 0
  let beats = 0
  let ack
  let armed = false
  let holding = true
  /** The setpoints being tracked, and those still in the transport delay. */
  let goal = null
  let queue = []
  let lastFreshAt = Number.NEGATIVE_INFINITY
  let ttlMs = 0
  let lastStepAt = 0
  let stateTimer = null
  let beatTimer = null
  const send = (m) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)) }
  const stopBeats = () => { if (beatTimer) clearInterval(beatTimer); beatTimer = null }

  const step = () => {
    const t = Date.now()
    const dt = Math.max(1, t - lastStepAt) / 1000
    lastStepAt = t
    while (queue.length > 0 && queue[0].at <= t) goal = queue.shift().sp
    const fresh = armed && goal !== null && t - lastFreshAt <= RULE.holdMs && t - lastFreshAt <= ttlMs
    if (fresh) {
      holding = false
      const a = 1 - Math.exp(-(dt * 1000) / tauMs)
      for (let i = 0; i < JOINTS; i++) {
        const was = q[i]
        q[i] += (goal.q[i] - q[i]) * a
        qd[i] = (q[i] - was) / dt
        // The effort reported is the servo's: the commanded one, or a spring on the error with the joint's cap.
        const cap = MANIFEST.joints[i].effort
        tau[i] = goal.tau.length > 0 ? goal.tau[i] : Math.max(-cap, Math.min(cap, (goal.q[i] - q[i]) * 10))
      }
    } else {
      // The device rule: hold where it is, report no motion and no effort.
      holding = true
      qd.fill(0)
      tau.fill(0)
    }
    const frame = { stamp: t, seq: seq++, q: [...q], qd: [...qd], tau: [...tau] }
    if (ack !== undefined) frame.ack = ack
    send({ t: 'state', frame })
  }

  const opened = new Promise((resolve, reject) => {
    ws.onopen = () => { send({ t: 'hello', v: 1, manifest: MANIFEST, caps: CAPS }); resolve() }
    ws.onerror = () => reject(new Error(`sim-arm: the relay at ${url} refused the socket`))
  })
  const closed = new Promise((resolve) => {
    ws.onclose = (ev) => {
      if (stateTimer) clearInterval(stateTimer)
      stopBeats()
      armed = false
      resolve({ code: ev.code, reason: ev.reason })
    }
  })
  ws.onmessage = (ev) => {
    let m
    try { m = JSON.parse(String(ev.data)) } catch { return }
    if (typeof m !== 'object' || m === null) return
    switch (m.t) {
      case 'welcome':
        id = m.id
        log(`sim-arm: welcomed as ${id} (${m.order.join(', ')})`)
        lastStepAt = Date.now()
        if (!stateTimer) stateTimer = setInterval(step, 1000 / hz)
        return
      case 'arm':
        if (typeof m.nonce !== 'string') return
        armed = true
        goal = null
        queue = []
        send({ t: 'armed', nonce: m.nonce })
        stopBeats()
        beatTimer = setInterval(() => send({ t: 'beat', n: ++beats }), RULE.beatMs)
        log(`sim-arm: armed (${m.nonce})`)
        return
      case 'disarm':
        armed = false
        goal = null
        queue = []
        stopBeats()
        log(`sim-arm: disarmed: ${m.cause}`)
        return
      case 'targets': {
        if (!armed) return
        const sp = m.setpoints
        if (typeof sp !== 'object' || sp === null || !Array.isArray(sp.q) || sp.q.length !== JOINTS) return
        const t = Date.now()
        queue.push({ at: t + delayMs, sp: { q: sp.q.map(Number), tau: Array.isArray(sp.tau) ? sp.tau.map(Number) : [] } })
        lastFreshAt = t
        ttlMs = Number(sp.ttlMs) || 0
        ack = sp.seq
        send({ t: 'ack', seq: sp.seq })
        return
      }
      default:
        return
    }
  }
  return {
    opened,
    closed,
    get id() { return id },
    state: () => ({ q: [...q], qd: [...qd], tau: [...tau], armed, holding, ack, seq }),
    close: () => { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, 'done') },
  }
}

// ---------------------------------------------------------------------------------------------------
// The program

function usage() {
  console.error('usage: node tools/robot/sim-arm.mjs ws://127.0.0.1:8790/robot <robot token> [--tau-ms 120] [--delay-ms 0] [--hz 50]')
  process.exit(2)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2)
  const positional = []
  const options = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--tau-ms' || a === '--delay-ms' || a === '--hz') {
      const v = Number(args[++i])
      if (!Number.isFinite(v) || v < 0 || (a === '--hz' && v === 0)) usage()
      options[a === '--tau-ms' ? 'tauMs' : a === '--delay-ms' ? 'delayMs' : 'hz'] = v
    } else if (a.startsWith('--')) usage()
    else positional.push(a)
  }
  if (positional.length !== 2) usage()
  const [url, token] = positional
  const arm = start(url, token, { ...options, log: (line) => console.log(line) })
  arm.opened.catch((e) => { console.error(e.message); process.exit(1) })
  arm.closed.then(({ code, reason }) => { console.log(`sim-arm: closed (${code} ${reason})`); process.exit(0) })
  process.once('SIGINT', () => arm.close())
}
