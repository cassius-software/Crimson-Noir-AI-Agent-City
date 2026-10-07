#!/usr/bin/env node
/**
 * Why does this file exist? It is the headless smoke test of the authoritative room (`npm run smoke:net`): it starts
 * the real server as a process of its own (`node src/10_Network/replication.node.ts`, the headless Ring-0 mirror of the
 * city of seed 1337 and its garage for a fleet of 36 behind the WebSocket host, with a secret made for this run, its
 * snapshots once a second so the answer to a packet is plainly its correction), then plays a client over a real
 * loopback WebSocket. It knocks without a token and with a forged one (both must be refused before any socket opens),
 * joins, walks honestly (every step must be kept: its claims come from a mirror of its own, the controller the page's
 * realm runs), and then sends crafted, illegal movement packets: a position written into memory, a speed hack in the
 * packet's shape, a speed hack on the clock (honest bursts past the banked seconds: the one past the bank is the one
 * refused), a walk through a wall, an injected velocity, and the car exploits of Phase 13: a teleport through a car's
 * door (a car claimed where the player is not), a car claimed beside the player but off every ring, a door out of a car
 * never taken, and a wheel never taken. Each must be refused instantly: no message but its correction comes back, within
 * LIMIT_MS of the packet leaving, and the server's truth must not have moved. It prints one row per packet and exits 1
 * if any check fails. Nothing leaves this machine: the server listens on 127.0.0.1 and the client speaks only to it.
 * What breaks if it is removed? Nothing at runtime; the room's anti-cheat loses its one end-to-end check against the
 * server as it actually ships (a process, a socket, a token) rather than as the test suite builds it in-process.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Mirror } from '../../src/10_Network/mirror.node.ts'
import { AUTH_PREFIX, LIMITS, openServerFrame, PROTOCOL_VERSION, sealMessage, SUBPROTOCOL } from '../../src/10_Network/replication.ts'
import { RUN } from '../../src/07_Execute_Actions/simProtocol.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SEED = 1337
const CARS = 36
/** How soon a refused packet's correction must arrive, ms (one tick of the room is 50 ms). */
const LIMIT_MS = 50
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let failed = 0
const check = (ok, what) => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
}

// ---------------------------------------------------------------- the server, as it ships

const secret = randomBytes(32).toString('hex')
const server = spawn(process.execPath, [join(ROOT, 'src/10_Network/replication.node.ts')], {
  cwd: ROOT, env: { ...process.env, NET_SECRET: secret, NET_PORT: '0', NET_SEED: String(SEED), NET_CARS: String(CARS), NET_TICK_HZ: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
})
const started = await new Promise((resolve, reject) => {
  // A server that never comes up is not left running.
  const fail = (e) => { server.kill('SIGKILL'); reject(e) }
  let out = ''
  const timer = setTimeout(() => fail(new Error(`the server did not start:\n${out}`)), 30_000)
  server.stdout.on('data', (b) => {
    out += b
    const url = /listening on (ws:\/\/[\d.]+:\d+)/.exec(out)?.[1]
    const token = /a token for 'operator', good for [\d.]+ h: (\S+)/.exec(out)?.[1]
    if (url && token) { clearTimeout(timer); resolve({ url, token }) }
  })
  server.stderr.on('data', (b) => { out += b })
  server.once('exit', (code) => reject(new Error(`the server exited (${code}):\n${out}`)))
})
console.log(`server: ${started.url} (a process of its own, pid ${server.pid}), the city of seed ${SEED} and its fleet of ${CARS}`)

try {
  // ---------------------------------------------------------------- no token, no socket

  const knock = (protocols) => new Promise((resolve) => {
    const ws = new WebSocket(started.url, protocols)
    ws.onopen = () => { ws.close(); resolve('open') }
    ws.onerror = () => resolve('refused')
  })
  check(await knock([SUBPROTOCOL]) === 'refused', 'an upgrade without a token is refused before any socket opens')
  check(await knock([SUBPROTOCOL, `${AUTH_PREFIX}b3BlcmF0b3I.9999999999999.forged`]) === 'refused', 'an upgrade with a forged token is refused before any socket opens')

  // ---------------------------------------------------------------- an honest client

  const ws = new WebSocket(started.url, [SUBPROTOCOL, AUTH_PREFIX + started.token])
  const got = []
  let received = 0, sent = 0
  ws.onmessage = (ev) => {
    const read = openServerFrame(String(ev.data), started.token, received)
    if (!read.ok) { check(false, `the server sent a frame the core refuses: ${read.reason}`); return }
    received = read.n
    got.push({ msg: read.msg, at: performance.now() })
  }
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('the good token was refused')) })
  check(ws.protocol === SUBPROTOCOL, `the good token upgrades, answered with ${ws.protocol}`)
  const send = (msg) => ws.send(sealMessage(msg, ++sent, started.token))
  const next = async (t, from) => {
    for (let k = 0; k < 300; k++) {
      const hit = got.slice(from).find((g) => g.msg.t === t)
      if (hit) return hit
      await sleep(10)
    }
    return null
  }
  send({ t: 'join', v: PROTOCOL_VERSION, token: started.token, name: 'Smoke', world: `city/${SEED}/${CARS}` })
  const welcome = (await next('welcome', 0))?.msg
  check(welcome !== undefined && welcome !== null, `joined as player ${welcome?.id}, put down at (${welcome?.you.x.toFixed(2)}, ${welcome?.you.z.toFixed(2)})`)
  if (!welcome) throw new Error('no welcome')

  // The client's own prediction: the controller the page's realm runs, on the same city.
  const predictor = await Mirror.create(SEED, CARS)
  predictor.join(welcome.id)
  predictor.place(welcome.id, welcome.you.x, welcome.you.z)
  let seq = 0, fix = welcome.fix
  let truth = welcome.you
  const input = (segs, claim, o = {}) => ({ t: 'input', seq: ++seq, ack: 0, fix, mode: 'foot', segs, heading: 0, claim, ...o })
  const honest = (segs) => {
    const p = predictor.walk(welcome.id, segs)
    return input(segs, { x: p.x, y: p.y, z: p.z })
  }

  const before = got.length
  for (let k = 0; k < 40; k++) {
    send(honest([[0, RUN, 1]]))
    await sleep(1000 / 60)
  }
  // The room acknowledges in its snapshots (one a second here): wait for the one that names the last step, however
  // late a loaded machine makes it, rather than for a fixed time.
  let snap
  for (let t = 0; t < 10_000 && !snap; t += 20) {
    snap = got.slice(before).find((g) => g.msg.t === 'snapshot' && g.msg.ack === seq)?.msg
    if (!snap && !got.slice(before).some((g) => g.msg.t === 'correct')) await sleep(20)
    else if (!snap) break
  }
  snap ??= got.slice(before).filter((g) => g.msg.t === 'snapshot').at(-1)?.msg
  const corrected = got.slice(before).some((g) => g.msg.t === 'correct')
  check(!corrected && snap?.ack === seq, `an honest walk of 40 steps is kept: the snapshot acknowledges step ${snap?.ack}, no correction`)
  if (snap) truth = snap.you
  console.log(`truth: (${truth.x.toFixed(3)}, ${truth.z.toFixed(3)})`)

  // ---------------------------------------------------------------- crafted, illegal movement

  const rows = []
  // The newest input the room kept: every correction must acknowledge exactly it (a crafted packet is never kept).
  let kept = snap?.ack ?? 0
  const crafted = async (name, packet, why) => {
    const expect = kept
    const from = got.length
    const t0 = performance.now()
    send(packet)
    const hit = await next('correct', from)
    const ms = hit ? hit.at - t0 : Infinity
    // Nothing but its correction comes back (the room's snapshot, once a second, may pass by in between).
    const first = hit !== null && got.slice(from, got.indexOf(hit)).every((g) => g.msg.t === 'snapshot')
    const still = hit && hit.msg.you.x === truth.x && hit.msg.you.z === truth.z && hit.msg.ack === expect
    const ok = hit !== null && first && ms <= LIMIT_MS && why.test(hit.msg.reason) && still
    rows.push({ name, ok, ms, reason: hit?.msg.reason ?? 'no correction', first, still })
    if (hit) {
      fix = hit.msg.fix
      predictor.place(welcome.id, hit.msg.you.x, hit.msg.you.z)
    }
  }
  const at = { x: truth.x, y: truth.y, z: truth.z }
  const lie = honest([[0, RUN, 6]])
  await crafted('memory written: the claim 40 m along', { ...lie, claim: { ...lie.claim, z: lie.claim.z + 40 } }, /claim .* from the mirror's pose/)
  await crafted('speed hack in the shape: 600 substeps', input([[0, RUN, 600]], { ...at, z: at.z + 52 }), /input: substeps/)
  // The room banks three seconds of substeps (LIMITS.stepBurst, 180). Once the bank is full again, six honest bursts of
  // half a second spend it, each kept; the seventh, at once, is a clock running fast, and the correction says the
  // sixth was the last kept.
  await sleep(3200)
  const banked = LIMITS.stepBurst / LIMITS.stepsPerInput
  for (let k = 0; k < banked; k++) send(honest([[0, 0, LIMITS.stepsPerInput]]))
  kept = seq
  await crafted(`speed hack on the clock: a burst past the bank of ${LIMITS.stepBurst}`, honest([[0, 0, LIMITS.stepsPerInput]]), /more substeps than time allows/)
  await sleep(1100)
  await crafted('through a wall: the podium east of the sidewalk', input([[RUN, 0, 30]], { x: at.x + RUN * 0.5, y: at.y, z: at.z }), /claim .* from the mirror's pose/)
  await crafted('an injected velocity: three runs', input([[0, 3 * RUN, 4]], { ...at, z: at.z + 3 * RUN * 4 / 60 }), /input: velocity/)
  // The car exploits (Phase 13). A car's state as a page reads it back from its realm: 32-bit numbers.
  const f = Math.fround
  const carAt = (x, z, heading) => {
    const yaw = heading - Math.PI / 2
    return { x: f(x), y: f(0.56), z: f(z), qx: 0, qy: f(Math.sin(yaw / 2)), qz: 0, qw: f(Math.cos(yaw / 2)), vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
  }
  const seat = predictor.garage.plan[0].pose
  const far = carAt(seat.x, seat.z, seat.heading)
  const drive = (state, door) => input([[0.5, 0, 0, 0, 1]], { x: state.x, y: state.y, z: state.z }, { mode: 'drive', ...(door && { door }) })
  await crafted(`a teleport through a door: car 0 claimed ${Math.hypot(seat.x - at.x, seat.z - at.z).toFixed(0)} m away`, drive(far, { enter: { car: 0, state: far } }), /from the room's pose/)
  const beside = carAt(at.x - 2, at.z, 0)
  await crafted('a car claimed beside the player, off every ring', drive(beside, { enter: { car: 0, state: beside } }), /off its ring's lane/)
  await crafted('a door out of a car never taken', input([[0, 0, 1]], at, { door: { exit: { x: at.x - 2, z: at.z } } }), /exit: not at a wheel/)
  await crafted('a wheel never taken: a drive with no door', drive(beside), /at a wheel without taking one/)

  console.log('')
  console.log('packet                                                        refused  alone  truth   ms     reason')
  for (const r of rows) {
    console.log(`${r.name.padEnd(62)}${(r.ok ? 'yes' : 'NO').padEnd(9)}${(r.first ? 'yes' : 'no').padEnd(7)}${(r.still ? 'kept' : 'MOVED').padEnd(8)}${(Number.isFinite(r.ms) ? r.ms.toFixed(1) : '-').padEnd(7)}${r.reason}`)
  }
  console.log('')
  for (const r of rows) check(r.ok, `${r.name}: refused and corrected ${Number.isFinite(r.ms) ? `${r.ms.toFixed(1)} ms` : 'never'} after it left (limit ${LIMIT_MS} ms)`)
  ws.close(1000, 'done')
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e))
} finally {
  server.kill('SIGINT')
  await new Promise((r) => { server.once('exit', r); setTimeout(r, 3000) })
}
console.log(failed === 0 ? '\nsmoke: every crafted packet was refused instantly; the truth never moved' : `\nsmoke: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
