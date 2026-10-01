/**
 * Why does this file exist? It proves the WebAssembly routing core (routingWasm.ts, native/routing) is the
 * TypeScript reference of tracks.ts: over every car track of two seeds, poseAt, projectOnto, nextStop and
 * speedLimitAt agree within 1e-9 on 20,000 seeded samples (corner look-up regions, s at the wrap, projections with
 * exact, stale and no hints, points off the track); a TrackDriver driven 240 s in the kinematic model with the core
 * installed matches one without it bit for bit; the generated module's bytes carry the SHA-256 it records; the
 * layout both sides define agrees; and a core whose arena cannot hold a track refuses it, leaving that track to the
 * reference. What breaks if it is removed? The core could drift from the reference (a different corner tangent, a
 * projection that converges elsewhere) and the fleet would drive on numbers nobody checked.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { ROUTING_WASM_BASE64, ROUTING_WASM_BYTES, ROUTING_WASM_SHA256 } from './routing.wasm.ts'
import { LAYOUT, createRoutingCore, decodeBase64, routingWasmBytes, trackWords } from './routingWasm.ts'
import { TrackDriver } from './trackDriver.ts'
import {
  buildTrackNetwork, nextStop, poseAt, projectOnto, referenceNextStop, referencePoseAt, referenceProjectOnto, referenceSpeedLimitAt, routingCore, seats,
  slotStart, speedLimitAt, useRoutingCore, type Track, type TrackNetwork,
} from './tracks.ts'

const TOL = 1e-9
const SAMPLES = 20_000
const networks: TrackNetwork[] = [buildTrackNetwork(1337), buildTrackNetwork(1337 ^ 7)]
const carTracks = networks.flatMap((n) => n.tracks.filter((t) => t.kind === 'car'))

test('the generated module is the bytes it records: length, SHA-256 and the WebAssembly magic', () => {
  const bytes = decodeBase64(ROUTING_WASM_BASE64)
  assert.equal(bytes.length, ROUTING_WASM_BYTES)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), ROUTING_WASM_SHA256)
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0x61, 0x73, 0x6d], '\\0asm')
  assert.equal(routingWasmBytes().length, ROUTING_WASM_BYTES)
  assert.ok(ROUTING_WASM_BASE64.length < 64 * 1024, `the base64 module is ${ROUTING_WASM_BASE64.length} chars`)
})

test('the layout is defined once on each side and the two agree; every car track of both seeds lays and fits', () => {
  const core = createRoutingCore()
  const table = [LAYOUT.T_HEADER, LAYOUT.PIECE_WORDS, LAYOUT.STOP_WORDS, LAYOUT.LUT_SIZE, LAYOUT.P_LUT, LAYOUT.P_X0, LAYOUT.P_EX, LAYOUT.T_PIECES, LAYOUT.T_STOPS, LAYOUT.T_DECEL, LAYOUT.S_AXIS, LAYOUT.P_S0]
  table.forEach((v, i) => assert.equal(core.exports.routing_layout(i), v, `layout entry ${i}`))
  assert.equal(core.exports.routing_layout(table.length), 0)
  assert.equal(LAYOUT.PIECE_WORDS, LAYOUT.P_LUT + LAYOUT.LUT_SIZE, 'a corner fills its piece exactly')
  let words = 0
  for (const t of carTracks) {
    assert.ok(core.lay(t), `track ${t.id} lays`)
    assert.ok(core.laid(t))
    words += trackWords(t)
  }
  assert.equal(core.laidCount, carTracks.length)
  assert.equal(core.usedWords, words)
  assert.ok(core.usedWords < core.arenaWords / 2, `${core.usedWords} of ${core.arenaWords} words used by ${carTracks.length} rings`)
  // The arcs of the train loop and the racetrack are not the core's; the drone corridors (lines and corners) are.
  for (const t of networks[0].tracks) {
    if (t.kind === 'car') continue
    assert.equal(core.lay(t), t.kind === 'drone', `${t.kind} track ${t.id}`)
  }
})

interface Stats { max: number; exact: number; total: number }
const stat = (): Stats => ({ max: 0, exact: 0, total: 0 })
function compare(st: Stats, a: number, b: number, what: string): void {
  st.total++
  if (Object.is(a, b)) st.exact++
  const d = Math.abs(a - b)
  if (!(d <= TOL)) assert.fail(`${what}: core ${a}, reference ${b} (off by ${d})`)
  if (d > st.max) st.max = d
}

test(`poseAt, projectOnto, nextStop and speedLimitAt agree with the reference within 1e-9 over ${SAMPLES} seeded samples on every car ring of both seeds`, () => {
  const core = createRoutingCore()
  const rng = createRng(0xa11ce)
  const stats = { pose: stat(), project: stat(), stop: stat(), speed: stat() }
  let hintRejected = 0, noStops = 0, cornerSamples = 0
  for (let i = 0; i < SAMPLES; i++) {
    const track = carTracks[Math.floor(rng() * carTracks.length)]
    const L = track.length
    const mode = i % 8
    let s: number
    if (mode <= 2) {
      // Anywhere, laps either way.
      s = (rng() * 5 - 2) * L
    } else if (mode <= 5) {
      // Inside a corner's look-up region, with the two ends and a lap on.
      const corners = track.pieces.filter((p) => p.kind === 'corner')
      const c = corners[Math.floor(rng() * corners.length)]
      const u = rng()
      const local = u < 0.1 ? 0 : u < 0.2 ? c.length : u < 0.3 ? c.length * (Math.floor(rng() * 32) / 32) : rng() * c.length
      s = c.s0 + local + (rng() < 0.3 ? L : 0)
      cornerSamples++
    } else {
      // At the wrap, exactly and just either side.
      const edge = [0, L, -L, 2 * L, L - 1e-12, -1e-12, L + 1e-12, L / 2][Math.floor(rng() * 8)]
      s = edge
    }
    const p = core.poseAt(track, s), q = referencePoseAt(track, s)
    for (const k of ['x', 'y', 'z', 'heading', 'tangentX', 'tangentZ'] as const) compare(stats.pose, p[k], q[k], `track ${track.id} s=${s} pose.${k}`)
    compare(stats.speed, core.speedLimitAt(track, s), referenceSpeedLimitAt(track, s), `track ${track.id} s=${s} speedLimitAt`)
    const behind = rng() < 0.2 ? rng() * 30 : 17.4
    const a = core.nextStop(track, s, behind), b = referenceNextStop(track, s, behind)
    if (a === null || b === null) {
      assert.equal(a, b)
      noStops++
    } else {
      compare(stats.stop, a.s, b.s, `track ${track.id} s=${s} nextStop.s`)
      compare(stats.stop, a.distance, b.distance, `track ${track.id} s=${s} nextStop.distance`)
      assert.equal(a.axis, b.axis, `track ${track.id} s=${s} nextStop.axis`)
    }
    // A point beside the pose: in lane, off the lane (past HINT_LATERAL, so a hint is rejected), or a little ahead.
    const lateral = rng() < 0.15 ? (rng() - 0.5) * 20 : (rng() - 0.5) * 9
    const along = (rng() - 0.5) * 2
    const x = q.x + q.tangentX * along - q.tangentZ * lateral
    const z = q.z + q.tangentZ * along + q.tangentX * lateral
    const hintMode = i % 4
    const hint = hintMode === 0 ? NaN : hintMode === 1 ? s : hintMode === 2 ? s + (rng() - 0.5) * L : s + 20 * (rng() < 0.5 ? 1 : -1)
    if (Math.abs(lateral) > 5) hintRejected++
    const r = core.projectOnto(track, x, z, hint), t = referenceProjectOnto(track, x, z, hint)
    compare(stats.project, r.s, t.s, `track ${track.id} s=${s} hint=${hint} projectOnto.s`)
    compare(stats.project, r.lateral, t.lateral, `track ${track.id} s=${s} hint=${hint} projectOnto.lateral`)
  }
  assert.ok(cornerSamples > SAMPLES / 4 && hintRejected > 100 && noStops === 0, `${cornerSamples} corner samples, ${hintRejected} off-lane points, ${noStops} without stops`)
  for (const [name, st] of Object.entries(stats)) {
    assert.ok(st.max <= TOL, `${name}: max difference ${st.max}`)
    // Bit-for-bit is the aim, not the bound: report it.
    console.log(`parity ${name}: ${st.total} values, max |diff| ${st.max.toExponential(2)}, ${st.exact} bit-identical (${((100 * st.exact) / st.total).toFixed(3)}%)`)
  }
})

// ---------------------------------------------------------------- the driver, with and without the core

const DT = 1 / 60
const WHEELBASE = 2.8
interface Pose { x: number; z: number; heading: number; speed: number }

/** The kinematic bicycle model of trackDriver.test.ts: accel = throttle · 2.5 − brake. */
function advance(p: Pose, cmd: { throttle: number; brake: number; steer: number }): void {
  p.speed = Math.max(0, p.speed + (cmd.throttle * 2.5 - cmd.brake) * DT)
  p.heading += (p.speed * Math.tan(cmd.steer)) / WHEELBASE * DT
  p.x += Math.sin(p.heading) * p.speed * DT
  p.z += Math.cos(p.heading) * p.speed * DT
}

/** 240 s of one TrackDriver on `track` from its first seat: every command and pose, as the fleet would see them. */
function drive(track: Track, seconds: number): Float64Array {
  const s0 = slotStart(track, seats(track)[0])
  const driver = new TrackDriver(track, s0, () => 0.5)
  const q = poseAt(track, s0)
  const p: Pose = { x: q.x, z: q.z, heading: q.heading, speed: 0 }
  const steps = Math.round(seconds / DT)
  const trace = new Float64Array(steps * 8)
  for (let i = 0; i < steps; i++) {
    const t = i * DT
    const cmd = driver.command(p, t, Infinity, DT)
    advance(p, cmd)
    trace.set([cmd.throttle, cmd.brake, cmd.steer, p.x, p.z, p.heading, p.speed, driver.progress], i * 8)
  }
  return trace
}

test('a TrackDriver driven 240 s with the core installed matches one without it bit for bit; nothing changes with none installed', () => {
  assert.equal(routingCore(), null, 'no core is installed by default')
  const tracks = [carTracks[11], carTracks[37], carTracks[64 + 5]]
  const reference = tracks.map((t) => drive(t, 240))
  const core = createRoutingCore()
  useRoutingCore(core)
  try {
    assert.equal(routingCore(), core)
    const withCore = tracks.map((t) => drive(t, 240))
    for (let k = 0; k < tracks.length; k++) {
      assert.ok(core.laid(tracks[k]), 'the drive laid its ring')
      const a = reference[k], b = withCore[k]
      assert.equal(a.length, b.length)
      for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) assert.fail(`track ${tracks[k].id}, step ${Math.floor(i / 8)}, value ${i % 8}: ${a[i]} without the core, ${b[i]} with it`)
      }
      // The car went somewhere: it drove, stopped and turned.
      assert.ok(a[a.length - 1] !== a[7] && a.some((_, i) => i % 8 === 6 && a[i] > 8), 'the car moved')
    }
    // The delegating functions answer through the core for a laid track, and still through the reference for one with arcs.
    const ring = tracks[0]
    assert.deepEqual(poseAt(ring, 12.5), core.poseAt(ring, 12.5))
    assert.deepEqual(projectOnto(ring, 10, 10, NaN), core.projectOnto(ring, 10, 10, NaN))
    assert.deepEqual(nextStop(ring, 3), core.nextStop(ring, 3, 17.4))
    assert.equal(speedLimitAt(ring, 3), core.speedLimitAt(ring, 3))
    const train = networks[0].tracks.find((t) => t.kind === 'train')!
    assert.equal(core.laid(train), false)
    assert.deepEqual(poseAt(train, 100), referencePoseAt(train, 100))
  } finally {
    useRoutingCore(null)
  }
  assert.equal(routingCore(), null)
  const again = drive(tracks[0], 30)
  assert.deepEqual([...again.subarray(0, 8 * 600)], [...reference[0].subarray(0, 8 * 600)], 'the reference is itself again')
})

test('a core whose arena cannot hold a track refuses it, and the reference answers for that track', () => {
  const small = createRoutingCore({ arenaWords: trackWords(carTracks[0]) + LAYOUT.T_HEADER })
  assert.equal(small.lay(carTracks[0]), true, 'the first ring fits')
  assert.equal(small.lay(carTracks[1]), false, 'the second does not')
  assert.equal(small.laid(carTracks[1]), false)
  assert.equal(small.laidCount, 1)
  assert.throws(() => small.poseAt(carTracks[1], 0), /not laid in the arena/)
  useRoutingCore(small)
  try {
    assert.deepEqual(poseAt(carTracks[1], 5), referencePoseAt(carTracks[1], 5))
    assert.deepEqual(poseAt(carTracks[0], 5), small.poseAt(carTracks[0], 5))
  } finally {
    useRoutingCore(null)
  }
  // The module itself refuses an offset past the arena, a misaligned arena and an empty one.
  const e = small.exports
  assert.equal(e.routing_check(small.arenaWords), 0)
  assert.equal(e.routing_check(small.arenaWords + 1000), 0)
  assert.equal(e.routing_pose_at(small.arenaWords, 0), 0)
  assert.equal(e.routing_next_stop(small.arenaWords, 0, 17.4), 0)
  assert.ok(Number.isNaN(e.routing_speed_limit_at(small.arenaWords, 0)))
  const throwaway = createRoutingCore({ arenaWords: 8 }).exports
  assert.equal(throwaway.routing_arena(12, 4), 0, 'misaligned')
  assert.equal(throwaway.routing_arena(16, 0), 0, 'empty')
  assert.equal(throwaway.routing_arena(16, 0x7fffffff), 0, 'past the memory')
  assert.throws(() => createRoutingCore({ arenaWords: 0 }), RangeError)
})
