/**
 * Why does this file exist? It proves the room acoustics on the real city and on hand-built rooms: the probe finds a
 * canyon of the street's width between mid-block facades, a crossing at an intersection and the open on the pier,
 * and never throws on a non-finite probe; Sabine's time grows with height, clamps and survives degenerate rooms; the
 * masonry wall table is the occlusion table audio.ts has always used, number for number; eavesdropping reduces to it
 * when no rooms are known, is fainter across rooms but never silent, and gets wetter with distance; the rendered
 * impulse is deterministic, silent through its predelay, −60 dB at rt60, fades its highs first, and has unit energy;
 * and the room key only changes when a room's bucket does.
 * What breaks if it is removed? A wrong room, a tail that never ends or a click of a swapped impulse would only be
 * found by ear in a browser.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  ACOUSTICS, eavesdrop, impulseLength, renderImpulse, roomAt, roomKey, sabineRt60, sameRoom, transmissionLoss, type Room,
} from './acoustics.ts'
import { muffle, SYNTH_RATE } from './audio.ts'
import { CITY, LAKE, generateCity, type Box } from '../01_Initialize_World/city.ts'

const near = (a: number, b: number, tol: number, msg?: string) => assert.ok(Math.abs(a - b) <= tol, msg ?? `${a} ≉ ${b} (±${tol})`)

/** Goertzel power of `x[from, to)` at `f` Hz, normalised by length². */
function power(x: Float32Array, rate: number, f: number, from = 0, to = x.length): number {
  const c = 2 * Math.cos((2 * Math.PI * f) / rate)
  let s1 = 0, s2 = 0
  for (let i = from; i < to; i++) { const s = x[i] + c * s1 - s2; s2 = s1; s1 = s }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / ((to - from) * (to - from))
}

/** Mean Goertzel power over a band (one bin's estimate on noise is far too variable on its own). */
function bandPower(x: Float32Array, rate: number, centre: number, from: number, to: number): number {
  let sum = 0, n = 0
  for (let f = centre * 0.8; f <= centre * 1.2; f += 20) { sum += power(x, rate, f, from, to); n++ }
  return sum / n
}

function rms(x: Float32Array, from: number, to: number): number {
  let e = 0
  for (let i = from; i < to; i++) e += x[i] * x[i]
  return Math.sqrt(e / (to - from))
}

const dB = (ratio: number) => 20 * Math.log10(ratio)

const room = (w: number, l: number, h: number, kind: Room['kind'] = 'canyon', x = 0, z = 0): Room =>
  ({ x0: x - w / 2, z0: z - l / 2, x1: x + w / 2, z1: z + l / 2, height: h, kind })

const width = (r: Room) => Math.min(r.x1 - r.x0, r.z1 - r.z0)

// ---------------------------------------------------------------------------------------------- rooms

test('roomAt on the real city: a canyon between mid-block facades, a crossing at an intersection, the open on the pier', () => {
  const boxes = generateCity(1337)
  const streetWidth = 2 * (CITY.pitch / 2 - CITY.lotHalf)
  const sidewalk = roomAt(boxes, CITY.pitch * 8.5, CITY.pitch * 8 + CITY.lane)
  assert.equal(sidewalk.kind, 'canyon')
  near(width(sidewalk), streetWidth, CITY.pitch / 2 - CITY.lotHalf - CITY.roadHalf, 'canyon width is the street between the lots')
  assert.ok(sidewalk.z1 - sidewalk.z0 < sidewalk.x1 - sidewalk.x0, 'the canyon runs along the street')
  assert.ok(sidewalk.z0 <= CITY.pitch * 8 + CITY.lane && CITY.pitch * 8 + CITY.lane <= sidewalk.z1)
  assert.ok(sidewalk.height > 0 && Number.isFinite(sidewalk.height))
  const crossing = roomAt(boxes, CITY.pitch * 8, CITY.pitch * 8)
  assert.equal(crossing.kind, 'crossing')
  assert.ok(crossing.x1 - crossing.x0 > streetWidth && crossing.z1 - crossing.z0 > streetWidth)
  assert.ok(crossing.height > 0 && Number.isFinite(crossing.height), 'the corner buildings give the crossing its height')
  const pier = roomAt(boxes, LAKE.pier.x, LAKE.shore + 40)
  assert.equal(pier.kind, 'open')
  assert.equal(pier.height, ACOUSTICS.openHeight)
  assert.ok(pier.x1 - pier.x0 >= ACOUSTICS.maxSpan && pier.z1 - pier.z0 >= ACOUSTICS.maxSpan)
  const sky = roomAt(boxes, CITY.pitch * 8.5, CITY.pitch * 8 + CITY.lane, 1000)
  assert.equal(sky.kind, 'open', 'a probe above every roof is in the open')
})

test('roomAt never throws: a non-finite probe or no boxes is the open', () => {
  const boxes = generateCity(1337)
  for (const [x, z] of [[Number.NaN, 100], [100, Number.NaN], [Number.NaN, Number.NaN], [Infinity, 0], [0, -Infinity]]) {
    const r = roomAt(boxes, x, z)
    assert.equal(r.kind, 'open')
    assert.equal(r.height, ACOUSTICS.openHeight)
    assert.equal(typeof roomKey(r), 'string')
    assert.ok(Number.isFinite(sabineRt60(r)))
  }
  assert.equal(roomAt(boxes, 100, 100, Number.NaN).kind, 'open')
  assert.equal(roomAt([], 100, 100).kind, 'open')
})

test('roomAt on a hand-built street: exact faces, the lowest top, a wall under the probe does not count', () => {
  const boxes: Box[] = [
    [-50, 0, 10, 50, 30, 40],   // north row, 30 m tall
    [-50, 0, -40, 50, 9, -10],  // south row, 9 m tall
    [-50, 0, -1, 50, 1, 1],     // a seawall-height kerb under the probe
  ]
  const r = roomAt(boxes, 0, 0)
  assert.equal(r.kind, 'canyon')
  assert.equal(r.z0, -10)
  assert.equal(r.z1, 10)
  assert.equal(r.height, 9)
  assert.equal(r.x1 - r.x0, 2 * ACOUSTICS.maxSpan, 'open along the street')
  const far = roomAt(boxes, 0, -200)
  assert.equal(far.kind, 'open', 'nothing within reach')
  const edge = roomAt(boxes, 0, -40 - ACOUSTICS.openReach + 0.5)
  assert.notEqual(edge.kind, 'open', 'a face within reach encloses')
})

test('sabineRt60: monotonic in height, clamped, open at the floor, finite for degenerate rooms', () => {
  let last = 0
  for (let h = 1; h <= 60; h += 1) {
    const t = sabineRt60(room(14, 240, h))
    assert.ok(t >= last, `rt60 grows with height (${h} m)`)
    assert.ok(t >= ACOUSTICS.rt60.min && t <= ACOUSTICS.rt60.max)
    last = t
  }
  assert.equal(sabineRt60(room(14, 240, 500)), ACOUSTICS.rt60.max)
  assert.equal(sabineRt60(room(0.5, 0.5, 0.2)), ACOUSTICS.rt60.min)
  const canyon = sabineRt60(room(14, 240, 10))
  assert.ok(canyon > ACOUSTICS.rt60.min && canyon < ACOUSTICS.rt60.max, 'a three-storey street is between the clamps')
  near(canyon, 0.161 * (14 * 240 * 10) / (0.04 * 2 * 10 * 254 + 1.03 * 14 * 240), 1e-9)
  assert.ok(sabineRt60(room(14, 240, 10, 'open')) <= canyon)
  assert.equal(sabineRt60(room(240, 240, ACOUSTICS.openHeight, 'open')), ACOUSTICS.rt60.min)
  for (const r of [room(0, 240, 10), room(0, 0, 0), room(Number.NaN, 10, 10), room(10, 10, Number.NaN), room(10, 10, -5)]) {
    const t = sabineRt60(r)
    assert.ok(Number.isFinite(t) && t >= ACOUSTICS.rt60.min && t <= ACOUSTICS.rt60.max, `degenerate ${JSON.stringify(r)} → ${t}`)
  }
})

// ---------------------------------------------------------------------------------------------- walls

test('transmissionLoss through masonry is exactly muffle(); glass is lighter', () => {
  for (const n of [0, 1, 2, 7, Number.NaN, -1, 0.5, Infinity]) {
    assert.deepEqual(transmissionLoss(n, 'masonry'), muffle(n), `walls = ${n}`)
    assert.deepEqual(transmissionLoss(n), muffle(n), `default kind, walls = ${n}`)
  }
  assert.deepEqual(transmissionLoss(0, 'glass'), muffle(0))
  for (const n of [1, 2, 3, 7]) {
    const m = transmissionLoss(n, 'masonry'), g = transmissionLoss(n, 'glass')
    assert.ok(g.cutoff > m.cutoff && g.gain > m.gain, `glass is lighter at ${n}`)
    assert.ok(g.gain < 1 && g.cutoff < ACOUSTICS.wall.open)
  }
  const one = transmissionLoss(1)
  one.gain = 0
  assert.equal(transmissionLoss(1).gain, ACOUSTICS.wall.masonry.one.gain, 'the table is copied, never handed out')
})

test('eavesdrop reduces to muffle without rooms, is fainter across rooms but never silent, wetter with distance', () => {
  for (const n of [0, 1, 2, 7, Number.NaN]) {
    const e = eavesdrop(5, n)
    assert.deepEqual({ cutoff: e.cutoff, gain: e.gain }, muffle(n))
  }
  const here = room(14, 240, 10, 'canyon', 0, 0)
  const there = room(14, 240, 10, 'canyon', CITY.pitch, 0)
  const same = room(14, 100, 10, 'canyon', 0, 60)
  assert.ok(sameRoom(here, same) && sameRoom(same, here) && !sameRoom(here, there))
  for (const n of [0, 1, 2]) {
    const across = eavesdrop(20, n, here, there)
    const within = eavesdrop(20, n, here, same)
    near(across.gain, muffle(n).gain * ACOUSTICS.coupling, 1e-12)
    near(within.gain, muffle(n).gain, 1e-12)
    assert.equal(across.cutoff, muffle(n).cutoff)
    assert.ok(across.gain > 0, 'never silent')
  }
  assert.equal(eavesdrop(20, 1, here).gain, muffle(1).gain, 'one room known: no coupling')
  assert.equal(eavesdrop(20, 1, undefined, there).gain, muffle(1).gain)
  const glass = eavesdrop(20, 1, here, there, 'glass')
  near(glass.gain, ACOUSTICS.wall.glass.one.gain * ACOUSTICS.coupling, 1e-12)
  assert.equal(eavesdrop(0, 0).reverbSend, 0)
  let last = 0
  for (let d = 1; d <= 200; d *= 1.5) {
    const s = eavesdrop(d, 0).reverbSend
    assert.ok(s > last && s <= ACOUSTICS.wetMax, `send rises with distance (${d} m)`)
    last = s
  }
  near(eavesdrop(ACOUSTICS.wetDistance, 0).reverbSend, ACOUSTICS.wetMax / 2, 1e-12)
  assert.equal(eavesdrop(Number.NaN, 0).reverbSend, 0)
  assert.equal(eavesdrop(-5, 0).reverbSend, 0)
  assert.ok(Number.isFinite(eavesdrop(Infinity, 0).reverbSend))
})

// ---------------------------------------------------------------------------------------------- impulse

test('impulseLength: predelay plus the clamped tail, 0 for a bad rate', () => {
  assert.equal(impulseLength(1, SYNTH_RATE), Math.round((ACOUSTICS.impulse.predelay + 1) * SYNTH_RATE))
  assert.equal(impulseLength(100, SYNTH_RATE), Math.round((ACOUSTICS.impulse.predelay + ACOUSTICS.impulse.maxSeconds) * SYNTH_RATE))
  assert.equal(impulseLength(0, SYNTH_RATE), Math.round((ACOUSTICS.impulse.predelay + ACOUSTICS.rt60.min) * SYNTH_RATE))
  assert.equal(impulseLength(Number.NaN, SYNTH_RATE), impulseLength(0, SYNTH_RATE))
  assert.ok(impulseLength(0.5, 48000) > impulseLength(0.5, SYNTH_RATE))
  assert.equal(impulseLength(1, 0), 0)
  assert.equal(impulseLength(1, Number.NaN), 0)
  assert.ok(impulseLength(ACOUSTICS.impulse.maxSeconds, 48000) <= 48000 * 2.3, 'cheap enough to render in a control pass')
  renderImpulse(1, SYNTH_RATE, 1, new Float32Array(0))
})

test('renderImpulse: deterministic, silent through the predelay, unit energy, every sample finite', () => {
  const n = impulseLength(0.8, SYNTH_RATE)
  const a = new Float32Array(n), b = new Float32Array(n), c = new Float32Array(n)
  renderImpulse(0.8, SYNTH_RATE, 7, a)
  renderImpulse(0.8, SYNTH_RATE, 7, b)
  renderImpulse(0.8, SYNTH_RATE, 8, c)
  assert.deepEqual(a, b)
  assert.notDeepEqual(a, c)
  const pre = Math.round(ACOUSTICS.impulse.predelay * SYNTH_RATE)
  for (let i = 0; i < pre; i++) assert.equal(a[i], 0)
  assert.ok(a.subarray(pre, pre + 50).some((v) => v !== 0), 'the tail starts right after the predelay')
  let energy = 0
  for (const v of a) { assert.ok(Number.isFinite(v)); energy += v * v }
  near(energy, 1, 1e-3)
  const short = new Float32Array(impulseLength(Number.NaN, SYNTH_RATE))
  renderImpulse(Number.NaN, Number.NaN, Number.NaN, short)
  assert.ok(short.every((v) => Number.isFinite(v)), 'nonsense arguments still render finite samples')
})

test('renderImpulse: the envelope is exp(−6.908·t/rt60), −60 dB at rt60, monotone, highs fade first', () => {
  const rate = SYNTH_RATE
  const pre = Math.round(ACOUSTICS.impulse.predelay * rate)
  const sec = (s: number) => Math.round(s * rate)
  for (const rt60 of [0.5, 0.8, 1.2, 2.2]) {
    const k = 6.907755278982137 / rt60
    /** Mean of the squared envelope over [t1, t2], relative to t = 0. */
    const envelope = (t1: number, t2: number) => (Math.exp(-2 * k * t1) - Math.exp(-2 * k * t2)) / (2 * k * (t2 - t1))
    const out = new Float32Array(impulseLength(rt60, rate) + sec(0.05))
    renderImpulse(rt60, rate, 1337, out)
    const head = rms(out, pre, pre + sec(0.02))
    const tail = rms(out, pre + sec(rt60 - 0.05), pre + sec(rt60 + 0.05))
    const measured = dB(tail / head)
    const expected = 10 * Math.log10(envelope(rt60 - 0.05, rt60 + 0.05) / envelope(0, 0.02))
    near(measured, expected, 2, `rt60 ${rt60}: ${measured.toFixed(1)} dB at rt60, envelope says ${expected.toFixed(1)}`)
    near(measured, -60, 3, `rt60 ${rt60}: ${measured.toFixed(1)} dB at rt60`)
    const win = sec(rt60 / 5)
    let last = Infinity
    for (let i = pre; i + win <= pre + sec(rt60); i += win) {
      const level = rms(out, i, i + win)
      assert.ok(level < last, `window at ${((i - pre) / rate).toFixed(2)} s is lower than the one before`)
      const t = (i - pre) / rate
      const want = 10 * Math.log10(envelope(t, t + rt60 / 5) / envelope(0, 0.02))
      near(dB(level / head), want, 2.5, `window at ${t.toFixed(2)} s follows the envelope`)
      last = level
    }
    const early = [pre, pre + sec(0.1)] as const
    const later = [pre + sec(0.3 * rt60), pre + sec(0.3 * rt60) + sec(0.1)] as const
    const lowDrop = bandPower(out, rate, 300, later[0], later[1]) / bandPower(out, rate, 300, early[0], early[1])
    const highDrop = bandPower(out, rate, 4000, later[0], later[1]) / bandPower(out, rate, 4000, early[0], early[1])
    assert.ok(highDrop < lowDrop, `rt60 ${rt60}: 4 kHz fell ${(10 * Math.log10(highDrop)).toFixed(1)} dB, 300 Hz ${(10 * Math.log10(lowDrop)).toFixed(1)} dB`)
    assert.ok(10 * Math.log10(highDrop / lowDrop) < -6, 'the highs fade clearly faster')
  }
})

// ---------------------------------------------------------------------------------------------- keys

test('roomKey is stable within a bucket and changes with kind, width, length or height', () => {
  assert.equal(roomKey(room(14, 240, 10)), roomKey(room(14.9, 240, 10)))
  assert.equal(roomKey(room(14, 240, 10)), roomKey(room(14, 244, 14.9)))
  assert.equal(roomKey(room(14, 240, 10, 'canyon', 100, 100)), roomKey(room(14, 240, 10, 'canyon', -300, 50)), 'position does not matter')
  assert.notEqual(roomKey(room(14, 240, 10)), roomKey(room(16, 240, 10)))
  assert.notEqual(roomKey(room(14, 240, 10)), roomKey(room(14, 240, 15)))
  assert.notEqual(roomKey(room(14, 240, 10)), roomKey(room(14, 200, 10)))
  assert.notEqual(roomKey(room(14, 240, 10)), roomKey(room(14, 240, 10, 'crossing')))
  assert.equal(roomKey(room(14, 240, 12, 'open')), roomKey(room(240, 240, 12, 'open')), 'an open tail has no footprint')
  assert.equal(roomKey(room(Number.NaN, Number.NaN, 12, 'open')), roomKey(room(240, 240, 12, 'open')))
  const boxes = generateCity(1337)
  const keys = new Set<string>()
  for (let z = CITY.pitch * 8 + CITY.lane - 1; z <= CITY.pitch * 8 + CITY.lane + 1; z += 0.25) keys.add(roomKey(roomAt(boxes, CITY.pitch * 8.5, z)))
  assert.equal(keys.size, 1, 'walking along the sidewalk keeps the key')
})

test('acoustics.ts imports only city.ts and degrees.ts (the causal order)', () => {
  const src = readFileSync(new URL('./acoustics.ts', import.meta.url), 'utf8')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports.sort(), ['../01_Initialize_World/city.ts', '../02_Define_The_Rules/degrees.ts'])
})

// ---------------------------------------------------------------------------------------------------
// Wiring (engine.ts is not Node-testable: its text is pinned)

test('wiring: the engine finds the listener\'s and the speaker\'s rooms per 2 m cell; the soundscape\'s wall table is this one and its convolver is feature-detected', () => {
  const engine = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8')
  const listen = engine.slice(engine.indexOf('  private listen('), engine.indexOf('  private wallsTo('))
  assert.match(listen, /f\.room = Number\.isNaN\(cell\) \? undefined : roomAt\(this\.world\.boxes, cam\.position\.x, cam\.position\.z\)/)
  assert.match(listen, /if \(cell !== this\.listenerCell\) \{/, 'only when the cell changes')
  assert.match(listen, /sp\.room = Number\.isNaN\(speakerCell\) \? undefined : roomAt\(this\.world\.boxes, speaking!\.x, speaking!\.z\)/)
  assert.match(engine, /const cellOf = \(x: number, z: number\): number => \(Number\.isFinite\(x \+ z\) \? Math\.floor\(x \/ 2\) \* 1e6 \+ Math\.floor\(z \/ 2\) : Number\.NaN\)/, '2 m cells')
  assert.match(listen, /const cell = this\.places \? Number\.NaN : cellOf\(/, 'a region has no page-side boxes: no room there')
  assert.ok(listen.indexOf('f.room =') < listen.indexOf('this.audio.update(f)'), 'before the frame goes to the soundscape')
  const audio = readFileSync(new URL('./audio.ts', import.meta.url), 'utf8')
  assert.match(audio, /export function muffle\(walls: number\): \{ cutoff: number; gain: number \} \{\n  return transmissionLoss\(walls, 'masonry'\)\n\}/)
  assert.match(audio, /if \(typeof ctx\.createConvolver === 'function'\) \{/, 'the dry graph where there is no convolver')
  assert.match(audio, /typeof ctx\.createMediaStreamSource !== 'function'/, 'no peer source where there is none')
  assert.match(audio, /const m = eavesdrop\(Math\.hypot\(sp\.x - L\.x, sp\.z - L\.z\), walls, f\.room, sp\.room\)/, 'speech follows through eavesdrop')
  assert.match(audio, /renderImpulse\(rt60, SYNTH_RATE, REVERB\.seed, buffer\.getChannelData\(0\)\)/)
  // Nothing of this crosses to the worker: the protocol and the realm name no room, no caption, no peer.
  for (const file of ['./simProtocol.ts', './simCore.ts', './physics.worker.ts']) {
    const text = readFileSync(new URL(file, import.meta.url), 'utf8')
    assert.doesNotMatch(text, /acoustics|captions\.ts|roomAt|attachPeer|MediaStream/, file)
  }
})
