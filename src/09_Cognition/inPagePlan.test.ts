// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the in-page model's policy (inPagePlan.ts, plan 3.4): every row
 * of the table (a desktop with a discrete GPU, one with an integrated GPU, a phone, the lite profile) placed in full;
 * which profile a device gets; every combination of the operator's GPU mode, shader-f16 and a GPU load that failed;
 * threads only in a cross-origin isolated page and clamped to the cores there are; thinking only when the operator
 * asks; the size limits on the whole model, each at exactly its limit and one byte over, with the sentences the
 * console shows; and the city's tier cap while the model works, which always holds the governor (a discrete GPU's
 * caps nothing but keeps the steps down under it from counting).
 * What breaks if it is removed? A change to a number in the table could load a model a phone cannot hold, ask for
 * threads a page that is not isolated cannot have, or leave the city at full quality while the model works, and
 * nothing would say so before a device did.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  HIDDEN_UNLOAD_MS, IDLE_UNLOAD_MS, LOAD_MS, START_MS, fits, holdTier, placement,
  type FileSize, type GpuMode, type Placement, type PlanEnv,
} from './inPagePlan.ts'
import { Governor, LITE_TIER, PEAK_TIER, TIERS } from '../05_Observe_Environment/governor.ts'
import { ANSWER_TOKENS, CONTEXT_TOKENS } from './localCompute.ts'

const GIB = 2 ** 30

/** A desktop with a discrete GPU that has shader-f16, 16 cores, served cross-origin isolated; `over` changes it. */
const env = (over: Partial<PlanEnv> = {}): PlanEnv => ({
  mobile: false, lite: false, gpuClass: 'discrete', cores: 16, memoryGb: 8, isolated: true, f16: true, gpuMode: 'auto', gpuFailed: false, ...over,
})

/** The four rows of the table, as the device profile (governor.ts profileDevice) describes such devices. */
const DISCRETE = env()
const INTEGRATED = env({ gpuClass: 'integrated', cores: 8 })
/** A capable phone (an Adreno 6xx class GPU with shader-f16), 8 cores, deviceMemory 4. */
const PHONE = env({ mobile: true, gpuClass: 'mobile', cores: 8, memoryGb: 4 })
/** The lite profile: a Mali-G52 phone (no shader-f16), 8 cores, deviceMemory 4. */
const LITE = env({ mobile: true, lite: true, gpuClass: 'mobile', cores: 8, memoryGb: 4, f16: false })

const ROWS = { discrete: DISCRETE, integrated: INTEGRATED, phone: PHONE, lite: LITE } as const

/** One file of `bytes`. */
const one = (bytes: number): FileSize[] => [{ name: 'model.gguf', bytes }]
/** fits() for one file of `bytes` on `e`, placed as `e` places it. */
const fitOf = (bytes: number, e: PlanEnv) => fits(one(bytes), e, placement(e))

test('the timeouts: a whole load, the start, idle and hidden unloads', () => {
  assert.equal(LOAD_MS, 600_000)
  assert.equal(START_MS, 30_000)
  assert.equal(IDLE_UNLOAD_MS, 600_000)
  assert.equal(HIDDEN_UNLOAD_MS, 60_000)
  assert.ok(START_MS < LOAD_MS, 'the start watchdog fires inside the load')
  assert.ok(HIDDEN_UNLOAD_MS < IDLE_UNLOAD_MS, 'a hidden phone lets go sooner than an idle page')
})

test('every row of the table, placed in full', () => {
  const want: Record<keyof typeof ROWS, Placement> = {
    discrete: { gpu: true, threads: 8, ctx: 8192, batch: undefined, ubatch: undefined, maxTokens: 2048, warmup: true, think: false, profile: 'discrete' },
    integrated: { gpu: true, threads: 4, ctx: 8192, batch: 512, ubatch: 256, maxTokens: 2048, warmup: true, think: false, profile: 'integrated' },
    phone: { gpu: false, threads: 4, ctx: 4096, batch: 256, ubatch: 128, maxTokens: 512, warmup: false, think: false, profile: 'phone' },
    lite: { gpu: false, threads: 2, ctx: 4096, batch: 256, ubatch: 128, maxTokens: 512, warmup: false, think: false, profile: 'lite' },
  }
  for (const [row, e] of Object.entries(ROWS)) assert.deepEqual(placement(e), want[row as keyof typeof ROWS], row)
  // A desktop answers with the local server's context and length (localCompute.ts), so the page and a server agree.
  assert.equal(placement(DISCRETE).ctx, CONTEXT_TOKENS)
  assert.equal(placement(INTEGRATED).maxTokens, ANSWER_TOKENS)
  // Each call is a fresh object: changing one placement changes no later one.
  const p = placement(PHONE)
  p.ctx = 1
  p.batch = 1
  assert.equal(placement(PHONE).ctx, 4096)
  assert.equal(placement(PHONE).batch, 256)
})

test('the profile: lite before phone, phone before the GPU class, an unknown GPU counts as integrated', () => {
  const profile = (over: Partial<PlanEnv>) => placement(env(over)).profile
  assert.equal(profile({ mobile: true, lite: true }), 'lite')
  assert.equal(profile({ mobile: false, lite: true, gpuClass: 'discrete' }), 'lite', '?lite=1 on a desktop')
  assert.equal(profile({ mobile: true, gpuClass: 'discrete' }), 'phone')
  assert.equal(profile({ mobile: true, gpuClass: 'unknown' }), 'phone')
  assert.equal(profile({ gpuClass: 'discrete' }), 'discrete')
  assert.equal(profile({ gpuClass: 'integrated' }), 'integrated')
  assert.equal(profile({ gpuClass: 'unknown' }), 'integrated')
  assert.equal(profile({ gpuClass: 'mobile' }), 'integrated', 'a phone-class GPU in a page that is not a phone')
})

test('the GPU: off and a failed GPU load mean the processor, on means the GPU, auto means a desktop with shader-f16', () => {
  // [auto with f16, auto without, on (f16 or not), off (f16 or not)] for each profile, with no failed GPU load.
  const want: Record<keyof typeof ROWS, readonly [boolean, boolean, boolean, boolean]> = {
    discrete: [true, false, true, false],
    integrated: [true, false, true, false],
    phone: [false, false, true, false],
    lite: [false, false, true, false],
  }
  const gpu = (e: PlanEnv, gpuMode: GpuMode, f16: boolean, gpuFailed = false) => placement({ ...e, gpuMode, f16, gpuFailed }).gpu
  for (const [row, e] of Object.entries(ROWS)) {
    const [autoF16, autoNoF16, on, off] = want[row as keyof typeof ROWS]
    assert.equal(gpu(e, 'auto', true), autoF16, `${row} auto, f16`)
    assert.equal(gpu(e, 'auto', false), autoNoF16, `${row} auto, no f16`)
    for (const f16 of [true, false]) {
      assert.equal(gpu(e, 'on', f16), on, `${row} on, f16 ${f16}`)
      assert.equal(gpu(e, 'off', f16), off, `${row} off, f16 ${f16}`)
      // A GPU load that failed this visit keeps every later load on the processor, whatever the mode.
      for (const mode of ['auto', 'on', 'off'] as const) assert.equal(gpu(e, mode, f16, true), false, `${row} ${mode}, f16 ${f16}, failed`)
    }
  }
})

test('threads: one in a page that is not isolated; otherwise per profile, clamped to the cores there are', () => {
  for (const [row, e] of Object.entries(ROWS)) {
    for (const cores of [1, 2, 4, 8, 16, 64]) assert.equal(placement({ ...e, cores, isolated: false }).threads, 1, `${row}, ${cores} cores, not isolated`)
  }
  const threads = (e: PlanEnv, cores: number) => placement({ ...e, cores }).threads
  // Desktops: half the cores, at least 1, at most 8.
  for (const e of [DISCRETE, INTEGRATED]) {
    const got = [1, 2, 3, 4, 5, 8, 15, 16, 17, 32, 128].map((c) => threads(e, c))
    assert.deepEqual(got, [1, 1, 1, 2, 2, 4, 7, 8, 8, 8, 8], e.gpuClass)
  }
  // A phone leaves two cores, at least 1, at most 4.
  assert.deepEqual([1, 2, 3, 4, 5, 6, 8, 12].map((c) => threads(PHONE, c)), [1, 1, 1, 2, 3, 4, 4, 4])
  // The lite profile takes 2, never more than the cores there are.
  assert.deepEqual([1, 2, 4, 8].map((c) => threads(LITE, c)), [1, 2, 2, 2])
  // A core count that makes no sense counts as 4 (navigator.hardwareConcurrency || 4); a fraction is rounded down.
  for (const bad of [0, -2, NaN, Infinity]) assert.equal(threads(DISCRETE, bad), 2, `cores ${bad}`)
  assert.equal(threads(DISCRETE, 4.9), 2)
  assert.equal(threads(PHONE, NaN), 2)
})

test('thinking only when the operator asks, on every profile', () => {
  for (const [row, e] of Object.entries(ROWS)) {
    assert.equal(placement(e).think, false, `${row}, not said`)
    assert.equal(placement(e, false).think, false, `${row}, off`)
    assert.equal(placement(e, true).think, true, `${row}, on`)
  }
})

test('a desktop: on the processor warns above 3 GB and refuses above 3.75 GB (the 4 GB heap); on the GPU warns above 4 GB and never refuses', () => {
  for (const base of [DISCRETE, INTEGRATED]) {
    const cpu = { ...base, gpuMode: 'off' as const }
    const gpu = { ...base, gpuMode: 'auto' as const, f16: true }
    assert.equal(placement(cpu).gpu, false)
    assert.equal(placement(gpu).gpu, true)
    // The processor: the warn limit, then the refuse limit, each exactly at and one byte over.
    assert.deepEqual(fitOf(3 * GIB, cpu), { ok: true }, `${base.gpuClass} cpu at 3 GB`)
    assert.deepEqual(fitOf(3 * GIB + 1, cpu), { ok: true, warn: 'this model is 3.1 GB; above 3.0 GB this page may answer slowly or run out of memory' })
    assert.equal(fitOf(3.75 * GIB, cpu).ok, true, 'exactly at the refuse limit loads')
    assert.ok('warn' in fitOf(3.75 * GIB, cpu))
    assert.deepEqual(fitOf(3.75 * GIB + 1, cpu), { ok: false, reason: 'this model is 3.8 GB; this page can hold about 3.7 GB (a page gets 4 GB of memory in all)' })
    // The GPU: the weights go to its own memory (plan 3.4), so a warning above 4 GB and no refusal; a 7B or 8B model
    // at Q4 (4.1 to 4.6 GB) loads there with the warning.
    assert.deepEqual(fitOf(3.5 * GIB, gpu), { ok: true }, 'no warning on the GPU where the processor warns')
    assert.ok('warn' in fitOf(3.5 * GIB, cpu))
    assert.deepEqual(fitOf(3.75 * GIB + 1, gpu), { ok: true }, 'over the processor\'s refuse limit, on the GPU')
    assert.deepEqual(fitOf(4 * GIB, gpu), { ok: true }, `${base.gpuClass} gpu at 4 GB`)
    assert.deepEqual(fitOf(4 * GIB + 1, gpu), { ok: true, warn: 'this model is 4.1 GB; above 4.0 GB this page may answer slowly or run out of memory' })
    assert.deepEqual(fitOf(4.6 * GIB, gpu), { ok: true, warn: 'this model is 4.6 GB; above 4.0 GB this page may answer slowly or run out of memory' })
    assert.equal(fitOf(64 * GIB, gpu).ok, true)
    assert.equal(fitOf(4.6 * GIB, cpu).ok, false, 'the same model on the processor is refused')
    assert.deepEqual(fitOf(0, cpu), { ok: true })
  }
})

test("a phone: warns above 1 GB and refuses above 2 GB or 40% of what it says it has, whichever is less", () => {
  // deviceMemory 4: 1.6 GB.
  assert.deepEqual(fitOf(GIB, PHONE), { ok: true })
  assert.deepEqual(fitOf(GIB + 1, PHONE), { ok: true, warn: 'this model is 1.1 GB; above 1.0 GB this phone may answer slowly or close the page' })
  const limit = Math.floor(1.6 * GIB)
  assert.equal(fitOf(limit, PHONE).ok, true)
  assert.deepEqual(fitOf(limit + 1, PHONE), { ok: false, reason: 'this model is 1.7 GB; this phone can hold about 1.6 GB' }, 'a byte over never reads as 1.6 GB')
  assert.deepEqual(fitOf(Math.round(2.4 * GIB), PHONE), { ok: false, reason: 'this model is 2.4 GB; this phone can hold about 1.6 GB' })
  // Unknown memory (Safari, Firefox) or a value that makes no sense counts as 4.
  for (const memoryGb of [undefined, NaN, 0, -1]) {
    const e = { ...PHONE, memoryGb }
    assert.equal(fitOf(limit, e).ok, true, `memory ${memoryGb}`)
    assert.equal(fitOf(limit + 1, e).ok, false, `memory ${memoryGb}`)
  }
  // 8 GB (Chrome's cap) and 5 GB both stop at 2 GB.
  for (const memoryGb of [8, 5]) {
    const e = { ...PHONE, memoryGb }
    assert.ok(fitOf(2 * GIB, e).ok, `memory ${memoryGb}`)
    assert.deepEqual(fitOf(2 * GIB + 1, e), { ok: false, reason: 'this model is 2.1 GB; this phone can hold about 2.0 GB' })
  }
  // 2 GB of memory: 0.8 GB, below the warn limit, so a model over it is refused rather than warned about.
  const small = { ...PHONE, memoryGb: 2 }
  assert.deepEqual(fitOf(Math.floor(0.8 * GIB), small), { ok: true })
  assert.deepEqual(fitOf(0.9 * GIB, small), { ok: false, reason: 'this model is 0.9 GB; this phone can hold about 0.8 GB' })
  assert.equal(fitOf(Math.floor(0.2 * GIB) + 1, { ...PHONE, memoryGb: 0.5 }).ok, false)
  // The GPU on a phone (ask gpu on) changes none of a phone's limits.
  const onGpu = { ...PHONE, gpuMode: 'on' as const }
  assert.equal(placement(onGpu).gpu, true)
  assert.equal(fitOf(limit + 1, onGpu).ok, false)
  assert.ok('warn' in fitOf(GIB + 1, onGpu))
})

test('the lite profile: warns above 0.6 GB and refuses above 1.5 GB, whatever memory it says it has', () => {
  const warn = Math.floor(0.6 * GIB)
  assert.deepEqual(fitOf(warn, LITE), { ok: true })
  assert.deepEqual(fitOf(warn + 1, LITE), { ok: true, warn: 'this model is 0.7 GB; above 0.6 GB this phone may answer slowly or close the page' })
  assert.equal(fitOf(1.5 * GIB, LITE).ok, true)
  assert.ok('warn' in fitOf(1.5 * GIB, LITE))
  assert.deepEqual(fitOf(1.5 * GIB + 1, LITE), { ok: false, reason: 'this model is 1.6 GB; this phone can hold about 1.5 GB' })
  for (const memoryGb of [undefined, 1, 8]) {
    assert.equal(fitOf(1.5 * GIB, { ...LITE, memoryGb }).ok, true, `memory ${memoryGb}`)
    assert.equal(fitOf(1.5 * GIB + 1, { ...LITE, memoryGb }).ok, false, `memory ${memoryGb}`)
  }
  // ?lite=1 on a desktop: the lite limits, and the sentence says device rather than phone.
  const desk = env({ lite: true })
  assert.equal(placement(desk).profile, 'lite')
  assert.deepEqual(fitOf(1.5 * GIB + 1, desk), { ok: false, reason: 'this model is 1.6 GB; this device can hold about 1.5 GB' })
})

test('the limits are on the whole model: every shard counts, and a size that is not known is refused', () => {
  const shards: FileSize[] = [{ name: 'm-00001-of-00002.gguf', bytes: GIB }, { name: 'm-00002-of-00002.gguf', bytes: GIB }]
  for (const s of shards) assert.equal(fits([s], PHONE, placement(PHONE)).ok, true, 'each shard alone fits')
  assert.deepEqual(fits(shards, PHONE, placement(PHONE)), { ok: false, reason: 'this model is 2.0 GB; this phone can hold about 1.6 GB' })
  const cpu = { ...DISCRETE, gpuMode: 'off' as const }
  assert.deepEqual(fits([...shards, { name: 'm-00003-of-00003.gguf', bytes: 1.75 * GIB + 1 }], cpu, placement(cpu)), { ok: false, reason: 'this model is 3.8 GB; this page can hold about 3.7 GB (a page gets 4 GB of memory in all)' })
  assert.deepEqual(fits([...shards, { name: 'm-00003-of-00003.gguf', bytes: 2 * GIB + 1 }], DISCRETE, placement(DISCRETE)), { ok: true, warn: 'this model is 4.1 GB; above 4.0 GB this page may answer slowly or run out of memory' })
  assert.deepEqual(fits([], DISCRETE, placement(DISCRETE)), { ok: false, reason: 'there is no model file to load' })
  for (const bytes of [NaN, -1, Infinity]) {
    assert.deepEqual(fits([shards[0], { name: 'broken.gguf', bytes }], DISCRETE, placement(DISCRETE)), { ok: false, reason: 'the size of broken.gguf is not known' })
  }
  // The placement decides: the same desktop on the processor warns (or refuses) where on the GPU it does not.
  const files = one(3.5 * GIB)
  assert.ok('warn' in fits(files, DISCRETE, { ...placement(DISCRETE), gpu: false }))
  assert.deepEqual(fits(files, DISCRETE, { ...placement(DISCRETE), gpu: true }), { ok: true })
  assert.equal(fits(one(4 * GIB), DISCRETE, { ...placement(DISCRETE), gpu: false }).ok, false)
  assert.deepEqual(fits(one(4 * GIB), DISCRETE, { ...placement(DISCRETE), gpu: true }), { ok: true })
})

test('every sentence is plain: lower case, sizes in GB with one decimal, no em-dash, the model always over its limit', () => {
  const sentences: string[] = []
  for (const e of [...Object.values(ROWS), { ...DISCRETE, gpuMode: 'off' as const }, { ...PHONE, memoryGb: 2 }, env({ lite: true })]) {
    for (let tenths = 1; tenths <= 50; tenths++) {
      for (const bytes of [Math.floor((tenths / 10) * GIB), Math.floor((tenths / 10) * GIB) + 1, Math.floor((tenths / 10 + 0.04) * GIB)]) {
        const f = fitOf(bytes, e)
        const text = f.ok ? f.warn : f.reason
        if (text === undefined) continue
        sentences.push(text)
        const [model, limit] = [...text.matchAll(/(\d+\.\d) GB/g)].map((m) => Number(m[1]))
        assert.ok(model > limit, `${text}: the model reads as over its limit`)
      }
    }
  }
  assert.ok(sentences.length > 100)
  for (const s of sentences) {
    assert.match(s, /^this model is \d+\.\d GB; /)
    assert.doesNotMatch(s, /\u2014|\u2013|undefined|NaN|\d\.\d\d/)
  }
})

test('the city is capped while the model works: the top tier on a discrete GPU, Low, Minimal on a phone, Lite on the lite profile', () => {
  for (const gpu of [true, false]) {
    assert.equal(holdTier(DISCRETE, gpu), gpu ? TIERS.length - 1 : PEAK_TIER, 'a model on the processor leaves Peak alone; the governor clamps the cap into the range, so below Peak it is Ultra as before')
    assert.equal(holdTier(INTEGRATED, gpu), 1)
    assert.equal(holdTier(PHONE, gpu), 0)
    assert.equal(holdTier(LITE, gpu), LITE_TIER)
    assert.equal(holdTier({ mobile: false, lite: false, gpuClass: 'unknown' }, gpu), 1, 'unknown counts as integrated')
    assert.equal(holdTier({ mobile: false, lite: true, gpuClass: 'discrete' }, gpu), LITE_TIER, '?lite=1 on a desktop')
    assert.equal(holdTier({ mobile: true, lite: false, gpuClass: 'discrete' }, gpu), 0)
  }
  assert.equal(TIERS[holdTier(DISCRETE, true)!].label, 'Ultra')
  assert.notEqual(holdTier(DISCRETE, true), PEAK_TIER, 'a model on a Peak machine\'s GPU is held at Ultra: it gets the memory Peak takes')
  const noF16 = env({ f16: false })
  assert.equal(holdTier(noF16, placement(noF16).gpu), PEAK_TIER, 'a discrete card without shader-f16 runs the model on the processor')
  assert.equal(TIERS[holdTier(INTEGRATED, true)!].label, 'Low')
  assert.equal(TIERS[holdTier(PHONE, false)!].label, 'Minimal')
  assert.equal(LITE_TIER, -1)
  // The cap follows the same profile the placement reports.
  const cap = { discrete: TIERS.length - 1, integrated: 1, phone: 0, lite: LITE_TIER }
  for (const e of Object.values(ROWS)) assert.equal(holdTier(e, placement(e).gpu), cap[placement(e).profile])
})

test('a discrete desktop\'s hold lowers nothing but still holds: a step down while the model works is not remembered', () => {
  // The host's wiring (plan step 7): busy(true) holds at holdTier, busy(false) releases with null. A null cap here
  // would be no hold at all, and the steps down below would back off for minutes.
  const g = new Governor({ tier: 4, auto: true })
  let now = 1000
  const run = (seconds: number, ms: number): void => {
    for (const end = now + seconds * 1000; now < end;) {
      now += ms
      g.sample(ms, now)
    }
  }
  run(3, 1000 / 60)
  g.hold(holdTier(DISCRETE, placement(DISCRETE).gpu), now)
  assert.equal(g.tier, 4, 'the city keeps its tier')
  assert.equal(g.state().held, 4, 'and is held')
  run(7, 50)                                        // the model has the GPU: 20 FPS
  assert.ok(g.tier < 4, `the city still steps down while the model works (${g.tier})`)
  g.hold(null, now)
  assert.equal(g.tier, 4, 'the release returns the tier from before, as after any hold')
  assert.equal(g.state().held, undefined)
})
