// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the autoscaler: the operator's step-down rule (FPS below 60 for more
 * than 2 s, one tier) on synthetic frame streams (vsync-quantized, jittered, overloaded, hitching), the
 * slow backed-off upgrades, the device profiles for real adapter strings, the tier table's crowd and
 * texture culling, the hitch-free FBM texture set, and the quality applier's "only what changed, never a
 * needless recompile" contract.
 * What breaks if it is removed? A tuning change could make the governor oscillate, ignore a struggling
 * phone, stop culling the crowd, or flip renderer state that rebuilds every pipeline mid-drive.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Frustum, Matrix4, PerspectiveCamera, RepeatWrapping, Vector3 } from 'three/webgpu'
import { vec2 } from 'three/tsl'
import {
  CROWD_DEFAULT, Governor, TIERS, defaultAgents, degradeBudgetMs, estimateRefreshHz, nativeHost, profileDevice, readDeviceHints, tierRange, type DeviceHints,
  type QualityKnobs,
} from './governor.ts'
import { PARKED_SHADOW_MAP, applyQuality, type QualityTargets } from '../07_Execute_Actions/quality.ts'
import { FBM_SIZES, FbmSet, bakeFbm, downsampleRgba } from '../01_Initialize_World/fbmTexture.ts'
import { CITY } from '../01_Initialize_World/city.ts'

// ---------------------------------------------------------------------------------------------------
// Frame stream harness

interface Change { at: number; tier: number }

class Clock {
  now = 1000
  readonly changes: Change[] = []
  readonly g: Governor
  constructor(g: Governor) { this.g = g }
  /** Feeds frames for `seconds`; `frame` returns the next rAF interval given the current tier. */
  run(seconds: number, frame: number | ((tier: number, i: number) => number)): this {
    const end = this.now + seconds * 1000
    for (let i = 0; this.now < end; i++) {
      const ms = typeof frame === 'number' ? frame : frame(this.g.tier, i)
      this.now += ms
      const r = this.g.sample(ms, this.now)
      if (r !== null) this.changes.push({ at: this.now, tier: r })
    }
    return this
  }
}

const hz = (rate: number) => 1000 / rate
/** rAF intervals on a fixed-refresh display: a frame that costs `cost` ms waits for the next vsync. */
const vsync = (rate: number, cost: number) => Math.max(1, Math.ceil(cost / hz(rate) - 1e-9)) * hz(rate)
/** Deterministic jitter in [-a, a]. */
const jitter = (i: number, a: number) => (((i * 7919) % 101) / 50 - 1) * a
const near = (x: number, y: number, eps = 1e-6) => Math.abs(x - y) <= eps
/** Seeded uniform [0, 1). */
const lcg = (seed: number) => () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }

// ---------------------------------------------------------------------------------------------------
// Tier table

test('tiers: five frozen, uniquely named steps that only ever add work going up', () => {
  assert.equal(TIERS.length, 5)
  assert.ok(Object.isFrozen(TIERS))
  assert.equal(new Set(TIERS.map((t) => t.label)).size, TIERS.length)
  for (let i = 0; i < TIERS.length; i++) {
    const t = TIERS[i]
    assert.ok(Object.isFrozen(t), `${t.label} frozen`)
    assert.ok(t.renderScale > 0.5 && t.renderScale <= 1, `${t.label} renderScale never supersamples`)
    assert.ok(t.crowdDensity > 0 && t.crowdDensity <= 1)
    assert.ok(t.nearRadius <= t.lodDistance && t.lodDistance < t.maxDistance, `${t.label} radii ordered`)
    assert.ok(Number.isInteger(Math.log2(t.shadowMapSize)), 'shadow map is a power of two')
    assert.ok(FBM_SIZES.includes(t.textureSize), `${t.label} texture size ${t.textureSize} is baked at startup`)
    if (i === 0) continue
    const p = TIERS[i - 1]
    for (const k of ['renderScale', 'crowdDensity', 'lodDistance', 'nearRadius', 'maxDistance', 'textureSize'] as const) {
      assert.ok(t[k] >= p[k], `${t.label}.${k} >= ${p.label}.${k}`)
    }
    assert.ok(!p.shadows || t.shadows, 'shadows never switch off going up')
    assert.ok(!p.post || t.post, 'post never switches off going up')
    assert.ok(!p.volumetrics || t.volumetrics, 'volumetrics never switch off going up')
    if (p.shadows) assert.ok(t.shadowMapSize >= p.shadowMapSize)
    const cost = (k: QualityKnobs) => k.renderScale + Number(k.shadows) + Number(k.post) + Number(k.volumetrics) + k.crowdDensity + k.maxDistance / 1000 + k.shadowMapSize / 8192 + k.textureSize / 1024
    assert.ok(cost(t) > cost(p), `${t.label} is strictly more work than ${p.label}`)
  }
  for (const t of TIERS) assert.ok(!t.volumetrics || t.post, `${t.label}: volumetrics live in the post chain`)
})

test('tiers: golden-hour volumetrics are the Ultra tier alone', () => {
  assert.deepEqual(TIERS.map((t) => t.volumetrics), [false, false, false, false, true])
  assert.equal(TIERS[4].label, 'Ultra')
})

test('tiers: High keeps the pre-governor look (bar a thinner far crowd); the lowest drops shadows, post and texture detail', () => {
  const high = TIERS[3]
  assert.equal(high.label, 'High')
  assert.deepEqual(
    { renderScale: high.renderScale, shadows: high.shadows, shadowMapSize: high.shadowMapSize, post: high.post, volumetrics: high.volumetrics, lodDistance: high.lodDistance, nearRadius: high.nearRadius, textureSize: high.textureSize },
    { renderScale: 1, shadows: true, shadowMapSize: 2048, post: true, volumetrics: false, lodDistance: 30, nearRadius: 22, textureSize: 256 },
  )
  assert.ok(high.crowdDensity >= 0.8 && high.crowdDensity < 1)
  assert.equal(TIERS[0].shadows, false)
  assert.equal(TIERS[0].post, false)
  assert.equal(TIERS[0].textureSize, 64)
  assert.equal(TIERS[4].shadowMapSize, 4096)
  assert.equal(TIERS[4].crowdDensity, 1)
  assert.equal(Math.max(...TIERS.map((t) => t.textureSize)), Math.max(...FBM_SIZES))
})

/** Pedestrians drawn per the WGSL `cull` pass (crowd.wgsl): nobody at or beyond maxDistance; everyone
 *  inside nearRadius; between them a fixed per-agent lottery keeps `density` of them, and only those
 *  within 1.2 m of the camera frustum. Agents stand on the sidewalk lanes of every block. */
function crowdDrawn(k: QualityKnobs): number {
  const rnd = lcg(11)
  const agents: [number, number, number][] = []
  for (let i = 0; i < 6000; i++) {
    const bx = Math.floor(rnd() * CITY.blocks), bz = Math.floor(rnd() * CITY.blocks), edge = Math.floor(rnd() * 4), t = rnd()
    const x0 = bx * CITY.pitch + CITY.lane, x1 = (bx + 1) * CITY.pitch - CITY.lane
    const z0 = bz * CITY.pitch + CITY.lane, z1 = (bz + 1) * CITY.pitch - CITY.lane
    const along = edge < 2
    const x = along ? x0 + (x1 - x0) * t : edge === 2 ? x0 : x1
    const z = along ? (edge === 0 ? z0 : z1) : z0 + (z1 - z0) * t
    agents.push([x, z, rnd()])
  }
  const cam = new PerspectiveCamera(62, 16 / 9, 0.1, 2400)
  const frustum = new Frustum()
  const m = new Matrix4()
  const c = new Vector3()
  const mid = (CITY.blocks / 2) * CITY.pitch
  let drawn = 0
  for (const [ex, ez] of [[mid + CITY.lane, mid + 12], [3 * CITY.pitch + CITY.lane, 5 * CITY.pitch + 20], [CITY.lane, 20], [11 * CITY.pitch + CITY.lane, mid]]) {
    for (let h = 0; h < 8; h++) {
      cam.position.set(ex, 1.7, ez)
      cam.rotation.set(0, (h * Math.PI) / 4, 0, 'YXZ')
      cam.updateMatrixWorld()
      frustum.setFromProjectionMatrix(m.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
      for (const [x, z, lot] of agents) {
        c.set(x, 0.9, z)
        const d = c.distanceTo(cam.position)
        if (d >= k.maxDistance) continue
        if (d >= k.nearRadius) {
          if (lot >= k.crowdDensity) continue
          if (frustum.planes.some((pl) => pl.normal.dot(c) + pl.constant < -1.2)) continue
        }
        drawn++
      }
    }
  }
  return drawn
}

test('tiers: every step down culls the drawn crowd substantially, and below High lowers the texture resolution', () => {
  const drawn = TIERS.map(crowdDrawn)
  const share = drawn.map((d) => d / drawn[4])
  const msg = share.map((s) => `${(100 * s).toFixed(1)} %`).join(' / ')
  for (let i = 0; i < TIERS.length - 1; i++) assert.ok(drawn[i] <= 0.85 * drawn[i + 1], `step ${TIERS[i + 1].label} → ${TIERS[i].label} culls ≥ 15 %: ${msg}`)
  assert.ok(share[2] <= 0.55, `Medium draws about half: ${msg}`)
  assert.ok(share[1] <= 0.2, `Low draws a fifth or less: ${msg}`)
  assert.ok(share[0] <= 0.06, `Minimal draws a few percent: ${msg}`)
  for (let i = 0; i < 3; i++) {
    const texels = (k: QualityKnobs) => k.textureSize ** 2
    assert.ok(texels(TIERS[i]) <= 0.6 * texels(TIERS[i + 1]), `${TIERS[i + 1].label} → ${TIERS[i].label} lowers the texture resolution`)
  }
})

// ---------------------------------------------------------------------------------------------------
// Refresh estimate and target

test('estimateRefreshHz: median of vsync intervals, snapped to a standard rate', () => {
  assert.equal(estimateRefreshHz(Array(50).fill(hz(60))), 60)
  assert.equal(estimateRefreshHz(Array(50).fill(hz(144))), 144)
  assert.equal(estimateRefreshHz(Array.from({ length: 80 }, (_, i) => hz(60) + jitter(i, 1.5))), 60)
  assert.equal(estimateRefreshHz(Array.from({ length: 80 }, (_, i) => hz(120) + jitter(i, 0.4))), 120)
  assert.equal(estimateRefreshHz(Array(50).fill(40)), 60, 'slow start is not a 25 Hz display')
  assert.equal(estimateRefreshHz([]), 60)
  assert.equal(estimateRefreshHz([NaN, -3, Infinity, hz(90), hz(90), hz(90)]), 90)
  const mixed = Array.from({ length: 60 }, (_, i) => (i % 2 ? hz(120) : 2 * hz(120)))
  assert.equal(estimateRefreshHz(mixed, 0.2), 120, 'the fast end is the refresh period')
})

test('target: 1000 / clamp(refresh, 60, 90) estimated from the first frames', () => {
  const cases: [number, number][] = [[60, hz(60)], [75, hz(75)], [90, hz(90)], [120, hz(90)], [144, hz(90)], [240, hz(90)]]
  for (const [rate, target] of cases) {
    const g = new Governor({ tier: 2, auto: false })
    assert.ok(near(g.targetMs, hz(60)), 'assumes 60 Hz until measured')
    new Clock(g).run(4, hz(rate))
    assert.ok(near(g.targetMs, target, 1e-3), `${rate} Hz → ${target.toFixed(2)} ms (got ${g.targetMs.toFixed(3)})`)
  }
  const slow = new Governor({ tier: 2, auto: false })
  new Clock(slow).run(4, 45)
  assert.ok(near(slow.targetMs, hz(60), 1e-3), 'a device that starts slow still aims for 60')
  const jittery = new Governor({ tier: 2, auto: false })
  new Clock(jittery).run(4, (_, i) => hz(60) + jitter(i, 1.5))
  assert.ok(near(jittery.targetMs, hz(60), 1e-3))
})

test('target: an explicit targetMs is held as given', () => {
  const g = new Governor({ tier: 2, auto: false, targetMs: 8 })
  new Clock(g).run(4, hz(60))
  assert.equal(g.targetMs, 8)
  // 1000 / 0 from an unset FPS option (or NaN) means "not given": the refresh is estimated as usual.
  for (const targetMs of [Infinity, NaN, 0, -5]) {
    const u = new Governor({ tier: 2, auto: false, targetMs })
    new Clock(u).run(4, hz(144))
    assert.ok(near(u.targetMs, hz(90), 1e-3), `targetMs ${targetMs} → ${u.targetMs}`)
  }
  // 120 FPS asked for on a 144 Hz display where tiers 2+ only reach 72 FPS: it steps down to a tier that
  // holds 144 (the 60 FPS floor applies to an estimated target only).
  const cost = (tier: number) => vsync(144, tier >= 2 ? 9 : 6)
  const h = new Governor({ tier: 3, auto: true, targetMs: hz(120) })
  const c = new Clock(h).run(20, cost)
  assert.deepEqual(c.changes.map((x) => x.tier), [2, 1], JSON.stringify(c.changes))
  assert.ok(near(h.targetMs, hz(120)))
  assert.ok(near(degradeBudgetMs(hz(120), true), hz(120) * 1.05))
  assert.ok(near(degradeBudgetMs(hz(90), false), hz(60) * 1.05), 'an estimated target is judged against the 60 FPS floor')
})

test('target: a display faster than the start-up frames suggested is picked up later', () => {
  const g = new Governor({ tier: 2, auto: true, min: 2, max: 2 })
  const c = new Clock(g).run(3, 20)
  assert.ok(near(g.targetMs, hz(60), 1e-3))
  c.run(8, hz(144))
  assert.ok(near(g.targetMs, hz(90), 1e-3), `refined to 90 FPS target (got ${g.targetMs})`)
})

// ---------------------------------------------------------------------------------------------------
// Stepping down: the operator's rule

test('degrade: FPS below 60 for more than 2 s steps down one tier, and not before', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60))
  assert.equal(c.changes.length, 0)
  const onset = c.now
  c.run(4, hz(30) + 0.01)
  assert.ok(c.changes.length >= 1, 'stepped down')
  const dt = c.changes[0].at - onset
  assert.ok(dt > 2000 && dt <= 2500, `first step ${dt.toFixed(0)} ms after the frame rate fell`)
  assert.equal(c.changes[0].tier, 2)
})

test('degrade: a clean 60 FPS on a 60 Hz display never steps down (rAF jitter, 59.94 Hz, a rare dropped frame)', () => {
  const streams: [string, (i: number, rnd: () => number) => number][] = [
    ['exact', () => hz(60)],
    ['jitter ±2 ms', (i) => hz(60) + jitter(i, 2)],
    ['alternating 14.2 / 19.1 ms', (i) => (i % 2 ? 14.2 : 19.13)],
    ['59.94 Hz', () => hz(59.94)],
    ['1 % dropped frames', (_, rnd) => (rnd() < 0.01 ? 2 * hz(60) : hz(60))],
  ]
  for (const [name, frame] of streams) {
    const rnd = lcg(3)
    const g = new Governor({ tier: 3, auto: true, max: 3 })
    const c = new Clock(g).run(600, (_, i) => frame(i, rnd))
    assert.deepEqual(c.changes, [], `${name}: 10 minutes without a change`)
  }
})

test('degrade: the 5 % tolerance — 57.5 FPS holds, 56 FPS steps down after 2 s (variable refresh display)', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60)).run(120, hz(57.5))
  assert.equal(c.changes.length, 0, '57.5 FPS is within vsync jitter of 60')
  const onset = c.now
  c.run(3, hz(56))
  assert.equal(c.changes[0]?.tier, 2)
  assert.ok(c.changes[0].at - onset > 2000)
})

test('degrade: a dip of up to 2 s, at any depth or phase, never steps down; 2.5 s does', () => {
  for (const ms of [hz(30) + 0.01, 50, 100]) {
    for (const dip of [1, 1.5, 2]) {
      const g = new Governor({ tier: 3, auto: true, max: 3 })
      const c = new Clock(g).run(4, hz(60))
      for (let k = 0; k < 24; k++) c.run(dip, ms).run(0.5 + k * 0.011, hz(60))
      assert.deepEqual(c.changes, [], `${dip} s dips of ${ms.toFixed(1)} ms frames, half a second apart`)
    }
  }
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60)).run(2.5, hz(30) + 0.01).run(1, hz(60))
  assert.equal(c.changes[0]?.tier, 2)
})

test('degrade: "continuously" — a 240 ms stall each second (mean under 57 FPS) is not below 60 throughout', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60))
  // Over any 2 s the mean frame is ~21 ms (47 FPS), but most quarter-seconds run at a clean 60.
  c.run(60, (_, i) => (i % 46 === 45 ? 240 : hz(60)))
  assert.deepEqual(c.changes, [])
})

test('degrade: a short burst of late frames, a tab switch and GC pauses are ignored', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60))
  c.run(0.25, 40).run(3, hz(60))                    // 250 ms of 25 FPS
  c.run(1.5, 40).run(3, hz(60))                     // 1.5 s of 25 FPS
  c.run(0.001, 5000).run(3, hz(60))                 // tab hidden for 5 s
  for (let k = 0; k < 6; k++) c.run(0.001, 180).run(0.5, hz(60))  // a pause every half second
  c.run(0.001, 900).run(0.001, 600).run(3, hz(60))  // two hitches in a row
  assert.equal(c.changes.length, 0, JSON.stringify(c.changes))
})

test('degrade: janky frames right after a tab switch or app resume are not a sustained slowdown', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(10, hz(60))
  c.run(0.001, 5000).run(0.3, 60).run(5, hz(60))    // tab back: 300 ms of 60 ms frames
  c.run(0.001, 2000).run(0.32, 80).run(5, hz(60))   // phone resumed: four 80 ms frames
  c.run(0.001, 3000).run(1.9, hz(30)).run(5, hz(60)) // tab back to 1.9 s of 30 FPS
  assert.equal(c.changes.length, 0, JSON.stringify(c.changes))
  // A real slowdown after the gap is still caught, a little over 2 s after the frames resume.
  c.run(0.001, 3000)
  const back = c.now
  c.run(4, hz(30) + 0.01)
  assert.equal(c.changes[0]?.tier, 2)
  const dt = c.changes[0].at - back
  assert.ok(dt > 2000 && dt <= 2500, `stepped down ${dt.toFixed(0)} ms after the gap`)
})

test('degrade: the first frames (compiles, first allocations) are ignored', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(0.7, 120).run(10, hz(60))
  assert.equal(c.changes.length, 0)
})

test('degrade: a device slower than the outlier cutoff still steps all the way down', () => {
  const g = new Governor({ tier: 3, auto: true })
  const c = new Clock(g).run(40, 400)
  assert.equal(g.tier, 0, JSON.stringify(c.changes))
  // Below 1 FPS, 5 s of history holds fewer frames than a step needs: the newest ones still count.
  for (const [ms, seconds] of [[1500, 90], [2500, 160]]) {
    const s = new Governor({ tier: 3, auto: true })
    const cs = new Clock(s).run(seconds, ms)
    assert.deepEqual(cs.changes.map((x) => x.tier), [2, 1, 0], `${ms} ms frames`)
  }
})

test('degrade: a jittery device at a few FPS (frames either side of the hitch cutoff) still walks all the way down', () => {
  const streams: [string, (i: number, rnd: () => number) => number][] = [
    ['150 / 300 ms', (i) => (i % 2 ? 300 : 150)],
    ['150–400 ms', (_, rnd) => 150 + 250 * rnd()],
    ['90–270 ms', (_, rnd) => 90 + 180 * rnd()],
  ]
  for (const [name, frame] of streams) {
    const rnd = lcg(9)
    const g = new Governor({ tier: 3, auto: true })
    const c = new Clock(g).run(30, (_, i) => frame(i, rnd))
    assert.deepEqual(c.changes.map((x) => x.tier), [2, 1, 0], name)
  }
})

test('degrade: isolated hitches (0.3–1 s) among 60 FPS frames never step down', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60))
  for (let k = 0; k < 90; k++) c.run(0.001, [300, 600, 950][k % 3]).run(0.6, hz(60))
  assert.deepEqual(c.changes, [])
})

test('degrade: one tier per step even far below 60, with a cooldown between steps (≥ 3.5 s apart)', () => {
  for (const ms of [50, hz(30) + 0.01, hz(45)]) {
    const g = new Governor({ tier: 4, auto: true })
    const c = new Clock(g).run(4, hz(60)).run(30, ms)
    assert.deepEqual(c.changes.map((x) => x.tier), [3, 2, 1, 0], `${ms.toFixed(1)} ms frames`)
    for (let i = 1; i < c.changes.length; i++) {
      const gap = c.changes[i].at - c.changes[i - 1].at
      assert.ok(gap >= 3450 && gap <= 4000, `gap ${gap.toFixed(0)} ms`)
    }
  }
})

test('degrade: 72 FPS on a 144 Hz display and 60 FPS on a 120 Hz display are inside the band', () => {
  const a = new Governor({ tier: 3, auto: true })
  const ca = new Clock(a).run(3, hz(144)).run(90, vsync(144, 9))
  assert.ok(near(a.targetMs, hz(90), 1e-3))
  assert.deepEqual(ca.changes, [], '72 FPS: no step down, no step up')
  const b = new Governor({ tier: 3, auto: true })
  const cb = new Clock(b).run(3, hz(120)).run(90, vsync(120, 12))
  assert.deepEqual(cb.changes, [])
})

test('degrade: 12 % dropped frames at 60 Hz (53 FPS) is below 60', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60))
  const onset = c.now
  c.run(3, (_, i) => (i % 8 === 0 ? hz(30) : hz(60)))
  assert.equal(c.changes.length, 1)
  assert.equal(c.changes[0].tier, 2)
  assert.ok(c.changes[0].at - onset > 2000, 'sustained for more than 2 s')
})

// ---------------------------------------------------------------------------------------------------
// Stepping up

test('upgrade: slow, after ≥ 5 s on target, one tier at a time', () => {
  const g = new Governor({ tier: 1, auto: true })
  const c = new Clock(g).run(30, hz(60))
  assert.ok(c.changes.length >= 2)
  assert.deepEqual(c.changes.map((x) => x.tier).slice(0, 3), [2, 3, 4])
  assert.ok(c.changes[0].at - 1000 >= 5000, `first probe at ${c.changes[0].at - 1000} ms`)
  for (let i = 1; i < c.changes.length; i++) assert.ok(c.changes[i].at - c.changes[i - 1].at >= 6500)
})

test('upgrade: no step up while frames are being missed (even a few)', () => {
  const g = new Governor({ tier: 1, auto: true })
  const c = new Clock(g).run(60, (_, i) => (i % 20 === 0 ? hz(30) : hz(60)))   // 5 % late: inside the band
  assert.deepEqual(c.changes, [])
})

test('upgrade: a hitch restarts the 5 s wait (a hitch every 4 s holds the tier)', () => {
  const g = new Governor({ tier: 1, auto: true })
  const c = new Clock(g).run(4, hz(60))
  for (let k = 0; k < 30; k++) c.run(0.001, 400).run(4, hz(60))
  assert.equal(c.changes.length, 0)
  c.run(6, hz(60))
  assert.equal(c.changes[0]?.tier, 2, 'steps up once 5 s pass without one')
})

test('upgrade: a failed probe backs off, doubling each time; no oscillation', () => {
  // Tiers 0–2 fit a 60 Hz frame; tier 3 costs 20 ms (drops to 30 FPS).
  const cost = (tier: number) => (tier >= 3 ? 20 : 12)
  const g = new Governor({ tier: 2, auto: true })
  const c = new Clock(g).run(900, (tier) => vsync(60, cost(tier)))
  const ups = c.changes.filter((x) => x.tier === 3)
  const downs = c.changes.filter((x) => x.tier === 2)
  assert.ok(ups.length >= 3 && ups.length <= 7, `${ups.length} probes in 15 min`)
  assert.ok(downs.length >= ups.length - 1 && downs.length <= ups.length, 'every probe is withdrawn')
  assert.ok(c.changes.every((x) => x.tier === 2 || x.tier === 3), 'never overshoots below the working tier')
  const gaps = ups.slice(1).map((u, i) => u.at - ups[i].at)
  assert.ok(gaps[0] >= 40000, `a failed probe waits longer than a plain step down (${gaps[0]} ms)`)
  for (let i = 1; i < gaps.length; i++) assert.ok(gaps[i] >= gaps[i - 1] * 1.5 || gaps[i] >= 300000, `gaps grow: ${gaps.join(', ')}`)
  for (const d of downs) {
    const up = [...ups].reverse().find((u) => u.at < d.at)
    assert.ok(up && d.at - up.at < 4000, 'a failed probe is withdrawn within ~4 s (cooldown + the 2 s rule)')
  }
})

test('upgrade: a probe that fails badly returns to the tier it came from, never below it', () => {
  // Tier 2 holds 60 Hz; tier 3 drops to 20 FPS.
  const g = new Governor({ tier: 2, auto: true, max: 3 })
  let atWorking = 0, total = 0
  const c = new Clock(g).run(600, (tier) => {
    const ms = vsync(60, tier >= 3 ? 45 : 12)
    total += ms
    if (tier === 2) atWorking += ms
    return ms
  })
  assert.ok(c.changes.some((x) => x.tier === 3), 'probed')
  assert.ok(c.changes.every((x) => x.tier >= 2), JSON.stringify(c.changes))
  assert.ok(atWorking / total > 0.95, `${((100 * atWorking) / total).toFixed(1)} % of the time on the working tier`)
})

test('upgrade: a marginal tier that trips every minute or two is re-probed ever more rarely', () => {
  // Tier 2 drops 7 % of frames at random (≈56 FPS on average): now and then 2 s in a row read as below 60.
  const rnd = lcg(1)
  const g = new Governor({ tier: 2, auto: true, max: 2 })
  const c = new Clock(g).run(1800, (tier) => (tier === 2 && rnd() < 0.07 ? 2 * hz(60) : hz(60)))
  const downs = c.changes.filter((x) => x.tier === 1).map((x) => x.at)
  const gaps = downs.slice(1).map((d, i) => d - downs[i])
  assert.ok(downs.length >= 2 && downs.length <= 10, `${downs.length} step downs in 30 min (shadows flip each time)`)
  assert.ok(gaps.slice(-3).every((gap) => gap >= 250000), `gaps grow to the maximum back-off: ${gaps.map((x) => Math.round(x / 1000)).join(', ')} s`)
})

test('upgrade: after a slow spell walks down two tiers, each climbs back after its own back-off; a repeat offender waits longer', () => {
  const g = new Governor({ tier: 4, auto: true })
  const c = new Clock(g).run(4, hz(60)).run(6.5, 50)   // 20 FPS for 6.5 s: 4 → 3 → 2
  assert.deepEqual(c.changes.map((x) => x.tier), [3, 2])
  const [left4, left3] = c.changes.map((x) => x.at)
  c.run(60, hz(60))
  const up3 = c.changes.find((x) => x.tier === 3 && x.at > left3)
  const up4 = c.changes.find((x) => x.tier === 4 && x.at > left3)
  assert.ok(up3 && up3.at - left3 >= 20000 && up3.at - left3 < 26000, `3 re-probed ${up3 ? up3.at - left3 : '-'} ms after it tripped`)
  assert.ok(up4 && up4.at - up3.at >= 6500, 'then 4, one probe at a time')
  assert.ok(up4.at - left4 >= 20000)
  assert.equal(g.tier, 4)
  const again = c.now
  c.run(3, 50).run(90, hz(60))                         // 4 trips again within the memory: it waits 40 s
  const back = c.changes.find((x) => x.tier === 4 && x.at > again)
  const drop = c.changes.find((x) => x.tier === 3 && x.at > again)
  assert.ok(drop && back && back.at - drop.at >= 40000, `re-probed ${back && drop ? back.at - drop.at : '-'} ms after its second trip`)
})

test('upgrade: a tier that failed long after arriving (heat) is retried after the base back-off only', () => {
  const g = new Governor({ tier: 2, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60))
  c.run(10, hz(60))                        // probe to 3 succeeds
  assert.equal(g.tier, 3)
  c.run(90, hz(60))                        // held: its first step down is not a failed probe
  const hot = c.now
  c.run(3, hz(30) + 0.01)                  // throttled
  assert.equal(g.tier, 2)
  c.run(60, hz(60))                        // cooled down
  const back = c.changes.find((x) => x.at > hot && x.tier === 3)
  assert.ok(back, 'retried')
  assert.ok(back.at - hot >= 20000 && back.at - hot <= 30000, `retried after ${back.at - hot} ms`)
})

// ---------------------------------------------------------------------------------------------------
// Controls

test('range: auto stays inside [min, max]; manual may leave it', () => {
  const g = new Governor({ tier: 4, auto: true, min: 1, max: 2 })
  assert.equal(g.tier, 2, 'clamped at construction')
  const c = new Clock(g).run(40, hz(60))
  assert.equal(g.tier, 2)
  c.run(30, 50)
  assert.equal(g.tier, 1)
  g.setTier(4)
  assert.equal(g.tier, 4)
  assert.equal(g.auto, false)
  assert.equal(c.run(0.1, 50).changes.at(-1)?.tier, 4, 'setTier is reported by sample()')
  g.setAuto(true)
  assert.equal(g.tier, 2, 'auto clamps back into range')
  assert.equal(c.run(0.1, hz(60)).changes.at(-1)?.tier, 2)
})

test('controls: auto off freezes the tier; setTier clamps and ignores NaN; knobs and state follow', () => {
  const g = new Governor({ tier: 3, auto: false })
  const c = new Clock(g).run(10, 60)
  assert.equal(c.changes.length, 0, 'auto off: overload changes nothing')
  g.setTier(9)
  assert.equal(g.tier, 4)
  g.setTier(-2)
  assert.equal(g.tier, 0)
  g.setTier(NaN)
  assert.equal(g.tier, 0)
  g.setTier(1.4)
  assert.equal(g.tier, 1)
  assert.equal(g.knobs(), TIERS[1])
  assert.deepEqual(g.state(), { tier: 1, label: 'Low', auto: false, renderScale: TIERS[1].renderScale, targetMs: g.targetMs })
  c.run(0.05, hz(60))
  assert.equal(c.changes.length, 1, 'only the net change is reported')
  assert.equal(c.changes[0].tier, 1)
  assert.equal(c.run(1, hz(60)).changes.length, 1)
})

test('controls: malformed samples and a clock that jumps backwards are harmless', () => {
  const g = new Governor({ tier: 3, auto: true, max: 3 })
  const c = new Clock(g).run(4, hz(60))
  assert.equal(g.sample(NaN, c.now + 1), null)
  assert.equal(g.sample(-5, c.now + 2), null)
  assert.equal(g.sample(16, Infinity), null)
  c.now = 10
  c.run(4, hz(60))
  assert.deepEqual(c.changes, [])
  assert.equal(g.tier, 3)
  // A backwards jump during warm-up restarts the warm-up instead of stretching it to the old origin.
  const w = new Governor({ tier: 3, auto: true, max: 3 })
  const cw = new Clock(w)
  cw.now = 1e6
  cw.run(0.3, hz(60))
  cw.now = 10
  cw.run(6, hz(30) + 0.01)
  assert.equal(cw.changes[0]?.tier, 2, 'governs again within seconds of the new origin')
  // NaN bounds fall back to the full range instead of disabling stepping.
  const n = new Governor({ tier: 3, auto: true, min: NaN, max: NaN })
  new Clock(n).run(10, hz(30) + 0.01)
  assert.ok(n.tier < 3)
})

test('controls: setAuto clamping a manual tier back into range gets the usual cooldown', () => {
  const g = new Governor({ tier: 1, auto: true, max: 2 })
  const c = new Clock(g).run(4, hz(60))
  g.setTier(4)
  c.run(3, hz(60))
  g.setAuto(true)
  assert.equal(g.tier, 2)
  const at = c.now
  c.run(5, 50)   // the compile hitch and settling right after a change must not count
  const down = c.changes.find((x) => x.at > at && x.tier < 2)
  assert.ok(down && down.at - at >= 3450, `first step down ${down ? down.at - at : '-'} ms after re-enabling auto`)
})

// ---------------------------------------------------------------------------------------------------
// Device profile

const base: DeviceHints = {
  adapter: 'unknown adapter', userAgent: '', mobileHint: undefined, maxTouchPoints: 0, coarsePointer: false,
  cores: 8, memoryGb: 8, screenPixels: 1920 * 1080,
}
const WIN = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15'
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1'
const ANDROID = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'
const CROS = 'Mozilla/5.0 (X11; CrOS aarch64 15329.44.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const phone = { mobileHint: true, maxTouchPoints: 5, coarsePointer: true, screenPixels: 412 * 915 }

test('profile: desktop GPUs', () => {
  const p = (h: Partial<DeviceHints>) => profileDevice({ ...base, userAgent: WIN, ...h })
  assert.deepEqual(p({ adapter: 'nvidia / lovelace' }), { mobile: false, gpuClass: 'discrete', startTier: 4 })
  assert.deepEqual(p({ adapter: 'nvidia / blackwell / NVIDIA GeForce RTX 5080' }), { mobile: false, gpuClass: 'discrete', startTier: 4 })
  assert.deepEqual(p({ adapter: 'nvidia / pascal' }), { mobile: false, gpuClass: 'discrete', startTier: 3 })
  assert.deepEqual(p({ adapter: 'nvidia / ampere', cores: 4 }), { mobile: false, gpuClass: 'discrete', startTier: 3 })
  assert.deepEqual(p({ adapter: 'amd / rdna-3' }), { mobile: false, gpuClass: 'discrete', startTier: 3 })
  assert.deepEqual(p({ adapter: 'amd / rdna-3 / AMD Radeon RX 7900 XTX' }), { mobile: false, gpuClass: 'discrete', startTier: 4 })
  assert.deepEqual(p({ adapter: 'amd / rdna-3 / AMD Radeon 780M Graphics' }), { mobile: false, gpuClass: 'integrated', startTier: 2 })
  assert.deepEqual(p({ adapter: 'intel / gen-12hp' }), { mobile: false, gpuClass: 'discrete', startTier: 3 })
  assert.deepEqual(p({ adapter: 'intel / xe-lpg / Intel(R) Arc(TM) Graphics' }), { mobile: false, gpuClass: 'integrated', startTier: 2 })
  assert.deepEqual(p({ adapter: 'intel / gen-12lp' }), { mobile: false, gpuClass: 'integrated', startTier: 2 })
  assert.deepEqual(p({ adapter: 'intel / gen-9' }), { mobile: false, gpuClass: 'integrated', startTier: 1 })
  assert.deepEqual(p({ adapter: 'intel / gen-9', memoryGb: 4 }), { mobile: false, gpuClass: 'integrated', startTier: 0 })
  assert.deepEqual(p({ adapter: 'qualcomm / adreno-x1' }), { mobile: false, gpuClass: 'integrated', startTier: 2 })
  assert.deepEqual(p({ adapter: 'apple / metal-3', userAgent: MAC }), { mobile: false, gpuClass: 'integrated', startTier: 3 })
  assert.deepEqual(p({ adapter: 'apple / metal-3', userAgent: MAC, screenPixels: 2560 * 1440 }), { mobile: false, gpuClass: 'integrated', startTier: 2 })
  assert.deepEqual(p({ adapter: 'nvidia / lovelace', screenPixels: 3840 * 2160 }), { mobile: false, gpuClass: 'discrete', startTier: 3 })
  assert.deepEqual(p({ adapter: '', userAgent: MAC_SAFARI }), { mobile: false, gpuClass: 'unknown', startTier: 2 })
  assert.deepEqual(p({ adapter: 'unknown adapter' }), { mobile: false, gpuClass: 'unknown', startTier: 2 })
  assert.deepEqual(p({ adapter: 'google / swiftshader' }), { mobile: false, gpuClass: 'unknown', startTier: 0 })
  assert.deepEqual(p({ adapter: 'microsoft / / Microsoft Basic Render Driver' }), { mobile: false, gpuClass: 'unknown', startTier: 0 })
  const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
  assert.deepEqual(p({ adapter: 'mesa', userAgent: LINUX }), { mobile: false, gpuClass: 'unknown', startTier: 0 })
  assert.deepEqual(p({ adapter: 'intel / gen-12lp / Mesa Intel(R) Xe Graphics (TGL GT2)', userAgent: LINUX }), { mobile: false, gpuClass: 'integrated', startTier: 2 })
  assert.deepEqual(p({ adapter: 'arm / valhall', userAgent: CROS, coarsePointer: true, maxTouchPoints: 10 }), { mobile: false, gpuClass: 'mobile', startTier: 1 })
})

test('profile: phones and tablets', () => {
  const p = (h: Partial<DeviceHints>) => profileDevice({ ...base, ...h })
  assert.deepEqual(p({ ...phone, userAgent: ANDROID, adapter: 'qualcomm / adreno-7xx' }), { mobile: true, gpuClass: 'mobile', startTier: 1 })
  assert.deepEqual(p({ ...phone, userAgent: ANDROID, adapter: 'arm / valhall' }), { mobile: true, gpuClass: 'mobile', startTier: 1 })
  assert.deepEqual(p({ ...phone, userAgent: ANDROID, adapter: 'arm / valhall', memoryGb: 4 }), { mobile: true, gpuClass: 'mobile', startTier: 0 })
  assert.deepEqual(p({ ...phone, userAgent: ANDROID, adapter: 'samsung / rdna-2' }), { mobile: true, gpuClass: 'mobile', startTier: 1 })
  assert.deepEqual(p({ ...phone, userAgent: ANDROID, adapter: 'qualcomm / adreno-6xx' }), { mobile: true, gpuClass: 'mobile', startTier: 0 })
  assert.deepEqual(p({ ...phone, userAgent: ANDROID, adapter: 'img-tec / rogue' }), { mobile: true, gpuClass: 'mobile', startTier: 0 })
  assert.deepEqual(p({ ...phone, userAgent: ANDROID, mobileHint: undefined, adapter: 'arm / bifrost' }), { mobile: true, gpuClass: 'mobile', startTier: 0 })
  // Safari: no userAgentData, no deviceMemory; adapter info may be empty.
  const safari = { ...phone, mobileHint: undefined, memoryGb: undefined }
  assert.deepEqual(p({ ...safari, userAgent: IPHONE, adapter: 'apple / common-3' }), { mobile: true, gpuClass: 'mobile', startTier: 1 })
  assert.deepEqual(p({ ...safari, userAgent: IPHONE, adapter: '' }), { mobile: true, gpuClass: 'unknown', startTier: 1 })
  // iPadOS asks for the desktop site: a Mac user agent with multi-touch.
  assert.deepEqual(p({ ...safari, userAgent: MAC_SAFARI, adapter: 'apple / common-3', screenPixels: 1024 * 1366 }), { mobile: true, gpuClass: 'mobile', startTier: 1 })
  // A plain Mac with a trackpad is not an iPad.
  assert.equal(p({ userAgent: MAC_SAFARI, adapter: 'apple / common-3', maxTouchPoints: 0 }).mobile, false)
})

test('profile: tierRange keeps phones at Medium or below', () => {
  assert.deepEqual(tierRange({ mobile: true, gpuClass: 'mobile', startTier: 1 }), { min: 0, max: 2 })
  assert.deepEqual(tierRange({ mobile: false, gpuClass: 'discrete', startTier: 4 }), { min: 0, max: 4 })
})

test('profile: readDeviceHints degrades to neutral values outside a browser', () => {
  const h = readDeviceHints('nvidia / ampere')
  assert.equal(h.adapter, 'nvidia / ampere')
  assert.equal(typeof h.userAgent, 'string')
  assert.ok(h.cores >= 1)
  assert.equal(h.coarsePointer, false)
  assert.ok(h.screenPixels >= 0)
  const p = profileDevice(h)
  assert.ok(p.startTier >= 0 && p.startTier < TIERS.length)
})

// ---------------------------------------------------------------------------------------------------
// Procedural texture resolutions (the swap itself is verified in a browser; three r186 source reasoning
// is in fbmTexture.ts)

test('fbm: downsampling is an exact area average — 2:1 is the 2×2 box, tone is kept, tiling survives', () => {
  // 4×4 → 2×2 and 4×4 → 3×3 on a known image.
  const src = new Uint8Array(4 * 4 * 4)
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) for (let c = 0; c < 4; c++) src[(y * 4 + x) * 4 + c] = (x + 4 * y) * 16 + c
  const half = downsampleRgba(src, 4, 2)
  const at = (img: Uint8Array, w: number, x: number, y: number, c = 0) => img[(y * w + x) * 4 + c]
  assert.equal(at(half, 2, 0, 0), Math.round((0 + 16 + 64 + 80) / 4))
  assert.equal(at(half, 2, 1, 1, 3), Math.round((10 * 16 + 11 * 16 + 14 * 16 + 15 * 16) / 4 + 3))
  // 4 → 3: output texel 1 covers source [4/3, 8/3), half of texels 1 and 2 on each axis; output texel 0
  // covers [0, 4/3), three quarters of texel 0 and a quarter of texel 1.
  const third = downsampleRgba(src, 4, 3)
  const box = (at(src, 4, 1, 1) + at(src, 4, 2, 1) + at(src, 4, 1, 2) + at(src, 4, 2, 2)) / 4
  assert.ok(Math.abs(at(third, 3, 1, 1) - box) <= 0.5, `${at(third, 3, 1, 1)} vs ${box}`)
  const corner = 0.5625 * at(src, 4, 0, 0) + 0.1875 * (at(src, 4, 1, 0) + at(src, 4, 0, 1)) + 0.0625 * at(src, 4, 1, 1)
  assert.ok(Math.abs(at(third, 3, 0, 0) - corner) <= 0.5, `${at(third, 3, 0, 0)} vs ${corner}`)
  const flat = new Uint8Array(8 * 8 * 4).fill(173)
  assert.ok(downsampleRgba(flat, 8, 3).every((v) => v === 173), 'a flat image stays flat')
  assert.throws(() => downsampleRgba(flat, 8, 16))
  assert.throws(() => downsampleRgba(flat, 4, 2))

  // The real bake: every size keeps the mean tone per channel and still tiles (the wrap-around step
  // between the last and first column/row looks like any interior step).
  const full = bakeFbm(256, 1337)
  const mean = (img: Uint8Array, c: number) => { let s = 0; for (let i = c; i < img.length; i += 4) s += img[i]; return s / (img.length / 4) }
  for (const size of [192, 128, 64]) {
    const img = downsampleRgba(full, 256, size)
    for (let c = 0; c < 4; c++) assert.ok(Math.abs(mean(img, c) - mean(full, c)) < 1, `${size}² channel ${c} tone`)
    let seam = 0, inner = 0
    for (let y = 0; y < size; y++) {
      for (let c = 0; c < 4; c++) {
        seam += Math.abs(at(img, size, size - 1, y, c) - at(img, size, 0, y, c)) + Math.abs(at(img, size, y, size - 1, c) - at(img, size, y, 0, c))
        inner += Math.abs(at(img, size, size / 2 - 1, y, c) - at(img, size, size / 2, y, c)) + Math.abs(at(img, size, y, size / 2 - 1, c) - at(img, size, y, size / 2, c))
      }
    }
    assert.ok(seam < inner * 1.6 + size, `${size}²: seam ${seam} vs interior ${inner}`)
  }
})

test('fbm: one bake, every tier size resident, swapped through one base node every sample follows', () => {
  const set = new FbmSet(1337)
  assert.deepEqual(set.sizes, [...FBM_SIZES])
  for (const t of TIERS) assert.ok(set.textureOf(t.textureSize), `${t.label} size baked`)
  assert.equal(set.size, 256)
  // Identical sampler state and format at every size: the same sampler key and bind group layout, so a
  // swap never needs a new pipeline.
  const sig = (s: number) => {
    const t = set.textureOf(s)!
    return [t.format, t.type, t.wrapS, t.wrapT, t.magFilter, t.minFilter, t.anisotropy, t.generateMipmaps, t.flipY, t.colorSpace].join()
  }
  for (const s of set.sizes) {
    assert.equal(sig(s), sig(256))
    const img = set.textureOf(s)!.image as { width: number; height: number; data: Uint8Array }
    assert.deepEqual([img.width, img.height, img.data.length], [s, s, s * s * 4])
    assert.equal(set.textureOf(s)!.wrapS, RepeatWrapping)
    assert.ok(set.textureOf(s)!.version > 0, 'flagged for upload')
  }
  const a = set.sample(vec2(0.3, 0.7)), b = set.sample(vec2(1, 2))
  assert.equal(a.updateMatrix, false, 'world-space tiling: no texture matrix uniform')
  assert.equal(a.value, set.textureOf(256))
  assert.equal(set.setSize(64), true)
  assert.equal(a.value, set.textureOf(64), 'every sample follows the base node')
  assert.equal(b.value, set.textureOf(64))
  assert.equal(set.size, 64)
  assert.equal(set.setSize(64), false, 'same size: nothing to do')
  assert.equal(set.setSize(100), false, 'unbaked sizes fit down to the nearest baked one (64)')
  set.setSize(200)
  assert.equal(set.size, 192)
  set.setSize(Infinity)
  assert.equal(set.size, 256)
  assert.equal(set.setSize(NaN), false)
  assert.equal(set.size, 256)
  set.setSize(1)
  assert.equal(set.size, 64, 'never below the smallest bake')
  // Pre-upload: every size once, so a swap mid-drive never uploads or builds mips.
  const uploaded: unknown[] = []
  set.upload({ initTexture: (t) => { uploaded.push(t) } })
  assert.deepEqual(uploaded, set.sizes.map((s) => set.textureOf(s)))
  assert.throws(() => new FbmSet(1, []))
})

// ---------------------------------------------------------------------------------------------------
// Quality applier (mock renderer: no WebGPU in Node)

function mockTargets() {
  const log: string[] = []
  let enabled = true
  let castShadow = true
  const mapSize = { x: 2048, y: 2048, set(x: number, y: number) { this.x = x; this.y = y; log.push(`mapSize ${x}`) } }
  const shadow = { mapSize, intensity: 1, autoUpdate: true, needsUpdate: false }
  const renderer = {
    pixelRatio: 1,
    setPixelRatio(r: number) { this.pixelRatio = r; log.push(`pixelRatio ${r}`) },
    shadowMap: {
      get enabled() { return enabled },
      set enabled(v: boolean) { if (v !== enabled) log.push(`shadowMap.enabled ${v}`); enabled = v },
    },
  }
  const sun = {
    shadow,
    get castShadow() { return castShadow },
    set castShadow(v: boolean) { if (v !== castShadow) log.push(`castShadow ${v}`); castShadow = v },
  }
  const crowd: { lodDistance: number; nearRadius: number; density: number; maxDistance: number }[] = []
  const post: boolean[] = []
  const volumetrics: boolean[] = []
  const texture: number[] = []
  const t = {
    renderer, sun, basePixelRatio: 2,
    setCrowd: (c: (typeof crowd)[number]) => { crowd.push(c); log.push('crowd') },
    setPost: (on: boolean) => { post.push(on); log.push(`post ${on}`) },
    setVolumetrics: (on: boolean) => { volumetrics.push(on); log.push(`volumetrics ${on}`) },
    setTextureSize: (size: number) => { texture.push(size); log.push(`texture ${size}`) },
  }
  return { t: t as unknown as QualityTargets, renderer, shadow, sun, crowd, post, volumetrics, texture, log }
}

test('applyQuality: first application sets everything and decides the compiled shadow variant', () => {
  const m = mockTargets()
  applyQuality(TIERS[3], m.t)
  assert.equal(m.renderer.pixelRatio, 2)
  assert.equal(m.renderer.shadowMap.enabled, true)
  assert.equal(m.shadow.mapSize.x, 2048)
  assert.equal(m.shadow.autoUpdate, true)
  assert.deepEqual(m.post, [true])
  assert.deepEqual(m.volumetrics, [false], 'High: the ray strength is written to 0 once, before the first frame')
  assert.deepEqual(m.texture, [256])
  assert.deepEqual(m.crowd, [{ lodDistance: 30, nearRadius: 22, density: TIERS[3].crowdDensity, maxDistance: 450 }])

  const handset = mockTargets()
  applyQuality(TIERS[1], handset.t)
  assert.equal(handset.renderer.shadowMap.enabled, false, 'a phone that starts without shadows never compiles them')
  assert.equal(handset.renderer.pixelRatio, 2 * TIERS[1].renderScale)
  assert.equal(handset.shadow.intensity, 0)
  assert.deepEqual(handset.texture, [128])
  assert.deepEqual(handset.volumetrics, [false])

  const desktop = mockTargets()
  applyQuality(TIERS[4], desktop.t)
  assert.deepEqual(desktop.volumetrics, [true], 'Ultra starts with the sun shafts on')
})

test('applyQuality: only what changed; identical knobs touch nothing', () => {
  const m = mockTargets()
  applyQuality(TIERS[3], m.t)
  m.log.length = 0
  applyQuality(TIERS[3], m.t, TIERS[3])
  assert.deepEqual(m.log, [])
  applyQuality(TIERS[4], m.t, TIERS[3])
  assert.deepEqual(m.log, ['mapSize 4096', 'volumetrics true', 'crowd'], 'Ultra differs from High in shadow texels, sun shafts and crowd only')
  m.log.length = 0
  applyQuality(TIERS[3], m.t, TIERS[4])
  assert.deepEqual(m.log, ['mapSize 2048', 'volumetrics false', 'crowd'], 'and back: one uniform write, no post toggle')
  m.log.length = 0
  applyQuality(TIERS[2], m.t, TIERS[3])
  assert.deepEqual(m.log, ['pixelRatio 1.7', 'mapSize 1024', 'texture 192', 'crowd'], 'the operator\'s rule: crowd and texture detail go down together')
})

test('applyQuality: the sun shafts follow the post cap — Ultra with post capped off never turns them on', () => {
  // engine.ts folds the ?post=0 cap into every tier's knobs; volumetrics stay true there, but they live in
  // the post chain, so the applied state must read "off" (the operator's shader readout shows it).
  const capped = Object.freeze({ ...TIERS[4], post: false })
  const m = mockTargets()
  applyQuality(capped, m.t)
  assert.deepEqual(m.post, [false])
  assert.deepEqual(m.volumetrics, [false])
  m.log.length = 0
  applyQuality(TIERS[3], m.t, capped)
  assert.ok(!m.log.some((l) => l.startsWith('volumetrics')), 'off to off: no write')
  m.log.length = 0
  applyQuality(TIERS[4], m.t, capped)
  assert.deepEqual(m.log, ['post true', 'volumetrics true'], 'lifting the cap at Ultra brings the shafts with it')
  m.log.length = 0
  applyQuality(capped, m.t, TIERS[4])
  assert.deepEqual(m.log, ['post false', 'volumetrics false'])
})

test('applyQuality: shadows off/on never flips the renderer-wide or light cache keys', () => {
  const m = mockTargets()
  applyQuality(TIERS[2], m.t)
  m.log.length = 0
  applyQuality(TIERS[1], m.t, TIERS[2])
  assert.equal(m.renderer.shadowMap.enabled, true)
  assert.equal(m.sun.castShadow, true)
  assert.equal(m.shadow.intensity, 0, 'parked: fully lit')
  assert.equal(m.shadow.autoUpdate, false, 'parked: shadow pass skipped')
  assert.equal(m.shadow.mapSize.x, PARKED_SHADOW_MAP, 'parked: full-size target released')
  assert.equal(m.shadow.needsUpdate, true, 'one render applies the tiny map')
  assert.ok(!m.log.some((l) => l.startsWith('shadowMap.enabled') || l.startsWith('castShadow')))
  applyQuality(TIERS[3], m.t, TIERS[1])
  assert.equal(m.shadow.intensity, 1)
  assert.equal(m.shadow.autoUpdate, true)
  assert.equal(m.shadow.mapSize.x, 2048)
  assert.ok(!m.log.some((l) => l.startsWith('shadowMap.enabled') || l.startsWith('castShadow')), m.log.join(' | '))
})

test('applyQuality: a renderer that started without shadows compiles them once when a tier needs them', () => {
  const m = mockTargets()
  m.shadow.intensity = 0.8
  applyQuality(TIERS[0], m.t)
  assert.equal(m.renderer.shadowMap.enabled, false)
  assert.equal(m.shadow.mapSize.x, 2048, 'nothing to release: the shadow map was never allocated')
  applyQuality(TIERS[2], m.t, TIERS[0])
  assert.equal(m.renderer.shadowMap.enabled, true)
  assert.equal(m.shadow.mapSize.x, 1024)
  assert.equal(m.shadow.intensity, 0.8, 'tuned intensity restored')
  applyQuality(TIERS[1], m.t, TIERS[2])
  applyQuality(TIERS[2], m.t, TIERS[1])
  assert.equal(m.log.filter((l) => l.startsWith('shadowMap.enabled')).length, 2, 'off at start, on once, never off again')
  assert.deepEqual(m.post, [false, true])
})

test('governor + applier: a sustained slowdown walks down tier by tier, culling crowd and textures each time', () => {
  const m = mockTargets()
  const g = new Governor({ tier: 4, auto: true })
  let prev = g.knobs()
  applyQuality(prev, m.t)
  const c = new Clock(g)
  c.run(4, hz(60))
  for (let s = 0; s < 30; s++) {
    c.run(1, hz(30) + 0.01)
    if (g.knobs() !== prev) {
      applyQuality(g.knobs(), m.t, prev)
      prev = g.knobs()
    }
  }
  assert.equal(g.tier, 0)
  assert.equal(m.renderer.pixelRatio, 2 * TIERS[0].renderScale)
  assert.equal(m.shadow.intensity, 0)
  assert.deepEqual(m.post, [true, false])
  assert.deepEqual(m.volumetrics, [true, false], 'the shafts go with the first step down from Ultra and never come back on the way down')
  assert.deepEqual(m.crowd.map((x) => x.density), [1, 0.85, 0.65, 0.4, 0.2])
  assert.deepEqual(m.texture, [256, 192, 128, 64])
  assert.equal(m.crowd.at(-1)?.maxDistance, TIERS[0].maxDistance)
})

// ---------------------------------------------------------------------------------------------------
// Under the cinema camera: the animation frames at the 60 FPS floor, and the camera's 24 held too

const PACER = 1000 / 24

/**
 * Feeds animation frames for `seconds` as the cinema camera shapes them: a frame at or after each 1/24 s due time is
 * drawn (the pacer's cadence, simplified), so the next frame comes `drawn(tier)` ms later; every other frame costs
 * `idle` ms. `drop(k, tier)` says the camera missed its k-th frame (drawn, but late: not presented).
 */
function runCinema(c: Clock, seconds: number, cost: number | { idle: number; drawn: (tier: number) => number }, drop: (k: number, tier: number) => boolean = () => false): Clock {
  const g = c.g
  const idle = typeof cost === 'number' ? cost : cost.idle
  const drawn = typeof cost === 'number' ? () => cost : cost.drawn
  const end = c.now + seconds * 1000
  let due = c.now + PACER
  let k = 0
  let ms = idle
  while (c.now < end) {
    c.now += ms
    const r = g.sample(ms, c.now)
    if (r !== null) c.changes.push({ at: c.now, tier: r })
    if (c.now >= due) {
      if (!drop(k++, g.tier)) g.present(c.now)
      due += PACER * Math.max(1, Math.floor((c.now - due) / PACER) + 1)
      ms = drawn(g.tier)
    } else ms = idle
  }
  return c
}

test('cinema: the animation frames are held at the 60 FPS floor whatever the display, so a fast display keeps its fidelity', () => {
  for (const rate of [60, 120, 144, 240]) {
    const g = new Governor({ tier: 3, auto: true, pacerMs: PACER })
    assert.equal(g.pacer, true)
    runCinema(new Clock(g), 4, hz(rate))
    assert.ok(near(g.targetMs, hz(60), 1e-3), `${rate} Hz → the 60 FPS floor (got ${g.targetMs.toFixed(3)})`)
  }
  // A tier whose frames take a 144 Hz display three refreshes (48 FPS when every frame is drawn): without the camera
  // it steps down; with it only 24 frames a second are drawn, the rest take one refresh, and the tier stays.
  const drawn = (tier: number) => vsync(144, tier >= 3 ? 16 : 6)
  const video = new Clock(new Governor({ tier: 3, auto: true })).run(20, drawn)
  assert.ok(video.changes.length >= 1 && video.changes[0].tier === 2, JSON.stringify(video.changes))
  const film = runCinema(new Clock(new Governor({ tier: 3, auto: true, pacerMs: PACER, max: 3 })), 20, { idle: hz(144), drawn })
  assert.equal(film.changes.length, 0, `the camera presents all 24 at the higher tier: ${JSON.stringify(film.changes)}`)
  // And from a tier whose frames take a 144 Hz display two refreshes it climbs under the camera (the frames it draws
  // fit a 60 FPS frame, and they are all it draws), where without it (every frame drawn, 90 aimed for) it holds.
  // Both start on a light tier, so both measure the display as 144 Hz.
  const light = { idle: hz(144), drawn: (tier: number) => vsync(144, tier >= 2 ? 13 : 6) }
  const cinema = new Governor({ tier: 1, auto: true, pacerMs: PACER, max: 3 })
  runCinema(new Clock(cinema), 30, light)
  assert.equal(cinema.tier, 3, 'under the camera: up to the top of its range')
  const plain = new Governor({ tier: 1, auto: true, max: 3 })
  new Clock(plain).run(30, light.drawn)
  assert.equal(plain.tier, 2, 'without it: held at 2 (every frame drawn at 72 FPS, short of the 90 a step up needs)')
})

test('cinema: the camera missing its frames steps down (after 2 s) even while the animation frames look fine', () => {
  const g = new Governor({ tier: 3, auto: true, pacerMs: PACER, max: 3 })
  const c = runCinema(new Clock(g), 4, hz(60))
  assert.equal(c.changes.length, 0)
  const onset = c.now
  // Every third camera frame missed (16 a second): the tier that does it steps down, one tier.
  runCinema(c, 6, hz(60), (k, tier) => tier === 3 && k % 3 === 0)
  assert.ok(c.changes.length >= 1, 'stepped down')
  assert.equal(c.changes[0].tier, 2)
  const dt = c.changes[0].at - onset
  assert.ok(dt > 2000 && dt <= 3000, `${dt.toFixed(0)} ms after the camera fell behind`)
  assert.equal(c.changes.length, 1, 'the tier below presents all of them: it stays')
})

test('cinema: 4 of every 5 camera frames (under the 90 % floor) steps down and says why; at the bottom of its range it neither steps nor says so', () => {
  const g = new Governor({ tier: 3, auto: true, pacerMs: PACER, max: 3 })
  const c = runCinema(new Clock(g), 4, hz(60))
  runCinema(c, 6, hz(60), (k, tier) => tier === 3 && k % 5 === 0)
  assert.equal(c.changes[0]?.tier, 2, JSON.stringify(c.changes))
  assert.equal(g.reason, 'camera behind')
  const floor = new Governor({ tier: 1, auto: true, pacerMs: PACER, min: 1, max: 3 })
  const f = runCinema(new Clock(floor), 4, hz(60))
  runCinema(f, 10, hz(60), (k) => k % 3 === 0)
  assert.deepEqual(f.changes, [])
  assert.equal(floor.reason, '', 'the tier never changed')
})

test('cinema: a camera that stays behind walks down one tier per whole window, never one per cooldown', () => {
  const g = new Governor({ tier: 3, auto: true, pacerMs: PACER, max: 3 })
  const c = runCinema(new Clock(g), 4, hz(60))
  runCinema(c, 16, hz(60), (k) => k % 3 === 0)
  assert.ok(c.changes.length >= 2, JSON.stringify(c.changes))
  for (let i = 1; i < c.changes.length; i++) {
    const gap = c.changes[i].at - c.changes[i - 1].at
    // The 1.5 s cooldown after a change, then a whole 2.5 s window judged at the new tier.
    assert.ok(gap >= 4000, `step ${i}: ${gap.toFixed(0)} ms after the one before`)
  }
})

test('cinema: all 24 presented holds the tier; a few missed (a stall) never steps down; present() without a camera is ignored', () => {
  const g = new Governor({ tier: 3, auto: true, pacerMs: PACER, max: 3 })
  const c = runCinema(new Clock(g), 30, hz(60))
  assert.equal(c.changes.length, 0)
  // One camera frame in twelve missed (22 a second): above the floor.
  runCinema(c, 20, hz(60), (k) => k % 12 === 0)
  assert.equal(c.changes.length, 0)
  // Without a camera, present() is ignored: 60 FPS animation frames hold, whatever it is told.
  const v = new Governor({ tier: 3, auto: true, max: 3 })
  assert.equal(v.pacer, false)
  const vc = new Clock(v)
  for (let i = 0; i < 10; i++) vc.run(1, hz(60))
  assert.deepEqual(vc.changes, [])
})

test('cinema: a step up waits for the camera too: no probe while it is presenting under 97 % of its frames', () => {
  const on = runCinema(new Clock(new Governor({ tier: 1, auto: true, pacerMs: PACER })), 12, hz(60))
  assert.equal(on.changes[0]?.tier, 2, 'every frame presented: the usual probe')
  const short = runCinema(new Clock(new Governor({ tier: 1, auto: true, pacerMs: PACER })), 30, hz(60), (k) => k % 12 === 0)
  assert.deepEqual(short.changes, [], '22 of 24: held, not probed higher')
})

test('crowd: the pedestrians simulated when the page does not say, by profile', () => {
  const p = (h: Partial<DeviceHints>) => defaultAgents(profileDevice({ ...base, userAgent: WIN, ...h }))
  assert.equal(p({ adapter: 'nvidia / lovelace' }), CROWD_DEFAULT.full)
  assert.equal(p({ adapter: 'amd / gcn-5' }), CROWD_DEFAULT.full)
  assert.equal(p({ adapter: 'intel / gen-9' }), CROWD_DEFAULT.full)
  assert.equal(p({ adapter: 'google / swiftshader' }), CROWD_DEFAULT.minimal)
  assert.equal(p({ adapter: 'intel / gen-9', memoryGb: 4 }), CROWD_DEFAULT.minimal)
  assert.equal(p({ ...phone, userAgent: ANDROID, adapter: 'qualcomm / adreno-7xx' }), CROWD_DEFAULT.phone)
  assert.equal(p({ ...phone, userAgent: ANDROID, adapter: 'qualcomm / adreno-6xx' }), CROWD_DEFAULT.minimal)
  assert.deepEqual(CROWD_DEFAULT, { full: 14000, phone: 8000, minimal: 5000 })
})

test('host: a Tauri v2 window is told from a browser tab, by what Tauri injects', () => {
  assert.equal(nativeHost({}), false)
  assert.equal(nativeHost({ isTauri: true }), true)
  assert.equal(nativeHost({ __TAURI_INTERNALS__: { invoke() {} } }), true)
  assert.equal(nativeHost({ isTauri: 'yes', __TAURI_INTERNALS__: null }), false)
  assert.equal(readDeviceHints('nvidia / ampere').host, 'browser', 'Node is no Tauri window')
  // A native shell on Windows 11 is WebView2: the desktop profile, top tier and full crowd for a high-end GPU.
  const WEBVIEW2 = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0'
  const native = profileDevice({ ...base, userAgent: WEBVIEW2, adapter: 'nvidia / blackwell / NVIDIA GeForce RTX 5080', host: 'native' })
  assert.deepEqual(native, { mobile: false, gpuClass: 'discrete', startTier: 4 })
  assert.deepEqual(tierRange(native), { min: 0, max: 4 })
  assert.equal(defaultAgents(native), CROWD_DEFAULT.full)
})
