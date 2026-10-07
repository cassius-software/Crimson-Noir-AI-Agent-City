/**
 * Why does this file exist? It is the property-based fuzzing of the WebAssembly routing core (routingWasm.ts) against
 * its TypeScript reference (tracks.ts), seeded and replayable (02_Define_The_Rules/property.ts), on the inputs the
 * seeded parity test does not draw: arc lengths a unit in the last place either side of every piece's ends, rounded to
 * 32 bits, laps away in both directions and far beyond (to 1e12 m), and the values that are not numbers (NaN, the
 * infinities); points a kilometre off the ring or not numbers at all; hints of every kind. Over every car ring of two
 * seeds the core and the reference never throw and agree: within 1e-9 m wherever the reference gives a finite answer
 * (relative to the lap for the arc lengths past a million metres, where an f64 itself holds no finer), and as the same
 * kind of non-number wherever it does not.
 * What breaks if it is removed? A value nobody drew could take the core and the reference apart, and the fleet would
 * drive on the core's answer alone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forAll, ulp, type Gen } from '../02_Define_The_Rules/property.ts'
import { createRoutingCore } from './routingWasm.ts'
import { buildTrackNetwork, referenceNextStop, referencePoseAt, referenceProjectOnto, referenceSpeedLimitAt, type Track } from './tracks.ts'

const tracks: Track[] = [buildTrackNetwork(1337), buildTrackNetwork(1337 ^ 7)].flatMap((n) => n.tracks.filter((t) => t.kind === 'car'))
const core = createRoutingCore()

/** An arc length the seeded parity test would not draw. */
function nastyS(g: Gen, t: Track): number {
  const piece = g.pick(t.pieces)
  const edge = g.pick([piece.s0, piece.s0 + piece.length, 0, t.length])
  switch (g.int(0, 7)) {
    case 0: return edge + (g.bool() ? 1 : -1) * ulp(edge)
    case 1: return Math.fround(edge + g.float(-1, 1))
    case 2: return edge + g.int(-50, 50) * t.length
    case 3: return g.pick([1e6, -1e6, 1e9, 1e12, -1e12]) + g.float(0, t.length)
    case 4: return g.pick([Number.NaN, Infinity, -Infinity])
    case 5: return -0
    case 6: return edge + g.pick([1e-15, -1e-15, 1e-9, -1e-9])
    default: return g.float(-3, 3) * t.length
  }
}

/** Agreement: the same non-number, or within `tol` of each other. */
function agree(a: number, b: number, tol: number, what: string): void {
  if (!Number.isFinite(b) || !Number.isFinite(a)) {
    assert.ok(Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)), `${what}: core ${a}, reference ${b}`)
    return
  }
  assert.ok(Math.abs(a - b) <= tol, `${what}: core ${a}, reference ${b} (off by ${Math.abs(a - b)})`)
}

test('the core is its reference on adversarial arc lengths: poseAt, speedLimitAt and nextStop', () => {
  forAll('routing s', { seed: 0x7a11, runs: 40_000 }, (g) => {
    const t = g.pick(tracks)
    return { t, s: nastyS(g, t), behind: g.pick([0, 17.4, g.float(0, 40), Number.NaN, -1]) }
  }, ({ t, s, behind }) => {
    // Past a million metres an f64 holds an arc length to ~1e-10 of itself: the answer is good to the lap's rounding.
    const tol = Math.abs(s) > 1e6 ? 1e-9 + Math.abs(s) * 4e-16 * 64 : 1e-9
    let q
    try {
      q = referencePoseAt(t, s)
    } catch {
      return
    }
    const p = core.poseAt(t, s)
    for (const k of ['x', 'z', 'heading', 'tangentX', 'tangentZ'] as const) agree(p[k], q[k], tol, `track ${t.id} s=${s} ${k}`)
    agree(core.speedLimitAt(t, s), referenceSpeedLimitAt(t, s), 1e-12, `track ${t.id} s=${s} speedLimitAt`)
    const a = core.nextStop(t, s, behind), b = referenceNextStop(t, s, behind)
    if (a === null || b === null) assert.equal(a === null, b === null, `track ${t.id} s=${s} nextStop`)
    else {
      agree(a.s, b.s, tol, `track ${t.id} s=${s} nextStop.s`)
      agree(a.distance, b.distance, tol, `track ${t.id} s=${s} nextStop.distance`)
      assert.equal(a.axis, b.axis)
    }
  })
})

test('the core is its reference on adversarial points: projectOnto far off the ring, not a number, with every kind of hint', () => {
  forAll('routing project', { seed: 0x7b22, runs: 30_000 }, (g) => {
    const t = g.pick(tracks)
    const q = referencePoseAt(t, g.float(0, t.length))
    const lateral = g.pick([g.float(-6, 6), g.float(-1000, 1000), 0])
    const x = g.bool(0.03) ? g.pick([Number.NaN, Infinity]) : q.x - q.tangentZ * lateral + g.float(-1, 1)
    const z = g.bool(0.03) ? g.pick([Number.NaN, -Infinity]) : q.z + q.tangentX * lateral
    return { t, x, z, hint: g.pick([Number.NaN, nastyS(g, t), g.float(0, t.length)]) }
  }, ({ t, x, z, hint }) => {
    let b
    try {
      b = referenceProjectOnto(t, x, z, hint)
    } catch {
      return
    }
    const a = core.projectOnto(t, x, z, hint)
    agree(a.s, b.s, 1e-9, `track ${t.id} (${x}, ${z}) hint ${hint} s`)
    agree(a.lateral, b.lateral, 1e-9, `track ${t.id} (${x}, ${z}) hint ${hint} lateral`)
  })
})
