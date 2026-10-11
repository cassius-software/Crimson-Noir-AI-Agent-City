#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It measures what the zero-copy bridge (src/07_Execute_Actions/sharedBridge.ts) replaces,
 * reproducibly, in Node: a physics worker thread publishing the positions of every vehicle, avatar and pedestrian to
 * the main thread at a steady step rate, two ways.
 * - `message`: the state crosses as a postMessage per step, the way StepState does (the typed arrays transferred,
 *   the rest structured-cloned), and the main thread copies the positions out into its own arrays, as the engine did
 *   for SimControls.crowd.positions.
 * - `bridge`: the worker writes the same positions into a SharedArrayBuffer under the bridge's spinlock, and the main
 *   thread reads them straight out under the lock. No message carries a position.
 * For each it reports the main thread's heap growth and garbage collections (PerformanceObserver 'gc' entries: how
 * many, how long, the longest pause) and the worst gap between two reads, after a one-second warm-up that is not
 * counted. Run it with --expose-gc for a heap reading after a full collection: `node --expose-gc tools/bridge/measure.mjs [agents] [seconds] [hz]` (defaults 4096, 10, 60).
 * The numbers describe this machine and Node's collector, not a browser's; they say which path allocates per step.
 * What breaks if it is removed? The bridge's claim ("no per-step allocation for positions") has no reproducible
 * evidence.
 */
import { PerformanceObserver } from 'node:perf_hooks'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'

const AGENTS = Number(process.argv[2] ?? 4096)
const SECONDS = Number(process.argv[3] ?? 10)
const HZ = Number(process.argv[4] ?? 60)
const VEHICLES = 48
const AVATARS = 4
const HEADER_WORDS = 16
const STRIDE = 4
const SLOTS = VEHICLES + AVATARS + AGENTS

// ---------------------------------------------------------------- the worker: a physics realm stand-in

if (!isMainThread) {
  const { mode, buffer, steps, hz } = workerData
  const poses = new Float32Array(VEHICLES * 28)
  const frame = new Float32Array(AGENTS * 12)
  const h = buffer ? new Int32Array(buffer, 0, HEADER_WORDS) : null
  const f = buffer ? new Float32Array(buffer) : null
  const i32 = buffer ? new Int32Array(buffer) : null
  let step = 0
  const spare = []
  const tick = () => {
    step++
    const t = step / hz
    for (let v = 0; v < VEHICLES; v++) { poses[v * 28] = v + Math.sin(t + v); poses[v * 28 + 2] = Math.cos(t + v); poses[v * 28 + 12] = v % 3 }
    for (let a = 0; a < AGENTS; a++) { frame[4 * a] = a + Math.sin(t); frame[4 * a + 2] = a - Math.cos(t) }
    if (mode === 'bridge') {
      let got = false
      for (let i = 0; i < 256 && !got; i++) got = Atomics.compareExchange(h, 0, 0, 1) === 0
      if (!got) { Atomics.wait(h, 0, 1, 2); got = Atomics.compareExchange(h, 0, 0, 1) === 0 }
      if (got) {
        let o = HEADER_WORDS
        for (let v = 0; v < VEHICLES; v++, o += STRIDE) { f[o] = poses[v * 28]; f[o + 1] = poses[v * 28 + 1]; f[o + 2] = poses[v * 28 + 2]; i32[o + 3] = poses[v * 28 + 12] | 0 }
        for (let k = 0; k < AVATARS; k++, o += STRIDE) { f[o] = k; f[o + 1] = 1; f[o + 2] = t; i32[o + 3] = 1 }
        for (let a = 0; a < AGENTS; a++, o += STRIDE) { f[o] = frame[4 * a]; f[o + 1] = frame[4 * a + 1]; f[o + 2] = frame[4 * a + 2]; i32[o + 3] = a & 7 }
        h[2] = step
        Atomics.add(h, 1, 1)
        Atomics.store(h, 0, 0)
        Atomics.notify(h, 0, 1)
      }
      // The rest of the state still crosses as a small message (events, stats), as it does in the product.
      parentPort.postMessage({ t: 'state', id: step, simTime: t, events: [], kernel: { law1: 0 }, physics: { stepMs: 1 } })
    } else {
      // The message path: the typed arrays transferred (recycled buffers when the page handed them back), the rest cloned.
      const take = (bytes) => { const k = spare.findIndex((b) => b.byteLength === bytes); return k < 0 ? new ArrayBuffer(bytes) : spare.splice(k, 1)[0] }
      const p = new Float32Array(take(VEHICLES * 28 * 4))
      p.set(poses)
      const fr = new Float32Array(take(AGENTS * 12 * 4))
      fr.set(frame)
      const avatars = Array.from({ length: AVATARS }, (_, k) => ({ x: k, y: 1, z: t, feetY: 0, speed: 1, enabled: true, sensor: false }))
      parentPort.postMessage({
        t: 'state', id: step, simTime: t, poses: p, crowdFrame: fr, avatar: avatars[0], avatars, driving: -1, drivings: [-1, -1, -1, -1],
        events: [], kernel: { law1: 0 }, physics: { stepMs: 1 }, recruits: [],
      }, [p.buffer, fr.buffer])
    }
    if (step < steps) setTimeout(tick, 1000 / hz)
    else parentPort.postMessage({ t: 'done' })
  }
  parentPort.on('message', (m) => { if (m.t === 'recycle') for (const b of m.buffers) spare.push(b) })
  tick()
}

// ---------------------------------------------------------------- the main thread: a page stand-in

function run(mode) {
  return new Promise((resolve) => {
    const steps = Math.round(SECONDS * HZ)
    const buffer = mode === 'bridge' ? new SharedArrayBuffer(4 * (HEADER_WORDS + STRIDE * SLOTS)) : null
    const h = buffer ? new Int32Array(buffer, 0, HEADER_WORDS) : null
    const f = buffer ? new Float32Array(buffer) : null
    const xz = new Float32Array(2 * AGENTS)
    const gcs = []
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) if (measuring) gcs.push(e) })
    obs.observe({ entryTypes: ['gc'] })
    // The first second is warm-up (the worker starting, the collector sizing its spaces): nothing of it is counted.
    const WARMUP = HZ
    let measuring = false
    let heap0 = 0
    const t0 = performance.now()
    let lastRead = t0, worstGap = 0, reads = 0, contended = 0, states = 0
    const worker = new Worker(new URL(import.meta.url), { workerData: { mode, buffer, steps, hz: HZ } })
    const readBridge = () => {
      let got = false
      for (let i = 0; i < 64 && !got; i++) got = Atomics.compareExchange(h, 0, 0, 1) === 0
      if (!got) { contended++; return }
      const base = HEADER_WORDS + STRIDE * (VEHICLES + AVATARS)
      for (let a = 0, o = base; a < AGENTS; a++, o += STRIDE) { xz[2 * a] = f[o]; xz[2 * a + 1] = f[o + 2] }
      Atomics.store(h, 0, 0)
      Atomics.notify(h, 0, 1)
    }
    worker.on('message', (m) => {
      if (m.t === 'done') {
        const wall = performance.now() - t0
        obs.disconnect()
        worker.terminate()
        const heapGrowth = process.memoryUsage().heapUsed - heap0
        if (global.gc) global.gc()
        const heapAfterGc = process.memoryUsage().heapUsed - heap0
        const gcMs = gcs.reduce((s, e) => s + e.duration, 0)
        const longestGc = gcs.reduce((s, e) => Math.max(s, e.duration), 0)
        resolve({ mode, steps: steps - WARMUP, wallMs: wall, states, reads, contended, gcs: gcs.length, gcMs, longestGcMs: longestGc, worstGapMs: worstGap, heapGrowthMb: heapGrowth / 1048576, heapAfterGcMb: heapAfterGc / 1048576 })
        return
      }
      states++
      const now = performance.now()
      if (states === WARMUP) {
        if (global.gc) global.gc()
        heap0 = process.memoryUsage().heapUsed
        measuring = true
      } else if (measuring) worstGap = Math.max(worstGap, now - lastRead)
      lastRead = now
      reads++
      if (mode === 'bridge') readBridge()
      else {
        // The engine's copy of the positions out of the frame, then the buffers back to the worker.
        const fr = m.crowdFrame
        for (let a = 0; a < AGENTS; a++) { xz[2 * a] = fr[4 * a]; xz[2 * a + 1] = fr[4 * a + 2] }
        worker.postMessage({ t: 'recycle', buffers: [m.poses.buffer, fr.buffer] }, [m.poses.buffer, fr.buffer])
      }
    })
  })
}

const results = []
for (const mode of ['message', 'bridge']) results.push(await run(mode))
const row = (r) => `${r.mode.padEnd(8)} ${String(r.steps).padStart(6)} ${r.gcs.toString().padStart(4)} ${r.gcMs.toFixed(1).padStart(8)} ${r.longestGcMs.toFixed(2).padStart(9)} ${r.worstGapMs.toFixed(1).padStart(9)} ${r.heapGrowthMb.toFixed(2).padStart(9)} ${r.heapAfterGcMb.toFixed(2).padStart(9)} ${String(r.contended).padStart(9)}`
console.log(`agents ${AGENTS}, vehicles ${VEHICLES}, ${SECONDS} s at ${HZ} Hz, node ${process.version}${global.gc ? '' : ' (run with --expose-gc for the heap after a full collection)'}`)
console.log('mode      steps  gcs    gc ms  longest   worst gap  heap +MB  after gc  contended')
for (const r of results) console.log(row(r))
console.log(JSON.stringify(results))
