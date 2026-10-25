// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the policy for a model that runs inside the page (the `inpage` provider, wllama
 * in inPage.ts): from what the page knows of the device (phone or desktop, the lite profile, the GPU's class, the
 * cores and memory, whether the page is cross-origin isolated, whether the city's GPU device has shader-f16, and what
 * the operator asked of the GPU) it decides where the model runs (the GPU or the processor, and on how many
 * threads), how large its context and batches are, how long an answer may be and whether it thinks; whether a model
 * file of a given total size may be loaded at all, or only with a warning; and how far the city's quality is capped
 * while the model works (governor.ts). It is pure: no DOM, no wllama, no timers, so every row of its table is tested
 * in Node. The numbers are starting values, inferred and not yet measured on the devices they are for.
 * What breaks if it is removed? The in-page mind has no defaults: a phone would try a model too large for it and the
 * system would kill the tab, a desktop would never use its GPU or its cores, and the city would keep its full quality
 * while the model takes the same processor and GPU from it.
 */
import { LITE_TIER, PEAK_TIER, TIERS } from '../05_Observe_Environment/governor.ts'
import { ANSWER_TOKENS, CONTEXT_TOKENS } from './localCompute.ts'

/** What the operator asked of the GPU (ask gpu): the profile decides, always, or never. */
export type GpuMode = 'auto' | 'on' | 'off'

/** What the page knows of the device, read once per load (inPage.ts fills gpuMode and gpuFailed). */
export interface PlanEnv {
  mobile: boolean; lite: boolean
  gpuClass: 'mobile' | 'integrated' | 'discrete' | 'unknown'
  cores: number                 // navigator.hardwareConcurrency || 4
  memoryGb: number | undefined  // navigator.deviceMemory
  isolated: boolean             // canShareMemory(): threads > 1 only when true
  f16: boolean                  // the city's GPU device has 'shader-f16'
  gpuMode: GpuMode
  gpuFailed: boolean            // a GPU load failed this visit
}

/** How one load runs: what wllama is asked for (inPage.ts LoadOptions) and how long an answer may be. */
export interface Placement {
  gpu: boolean; threads: number; ctx: number
  batch: number | undefined; ubatch: number | undefined   // undefined = wllama's own (512)
  maxTokens: number; warmup: boolean
  think: boolean                // D11: false on phones/lite unless the operator turned it on
  profile: 'discrete' | 'integrated' | 'phone' | 'lite'
}

/** One file of a model (a GGUF, or one shard of it). */
export interface FileSize { readonly name: string; readonly bytes: number }

/** Whether a model may load here: yes, yes with a warning to show, or no and why. */
export type Fit = { ok: true; warn?: string } | { ok: false; reason: string }

/** The whole load may take this long before it is given up, ms: a phone reading a large file and building the model. */
export const LOAD_MS = 600_000
/** The runtime must report that it started within this, ms: a damaged runtime binary hangs the load forever with no error (spike). */
export const START_MS = 30_000
/** A loaded model nobody has asked anything for this long is unloaded, ms, so its memory goes back to the city. */
export const IDLE_UNLOAD_MS = 600_000
/** On a phone, a model in a page hidden for this long is unloaded, ms: a hidden tab holding a large heap is the first one the system kills. */
export const HIDDEN_UNLOAD_MS = 60_000

type Profile = Placement['profile']

/** A gibibyte. Every size here is counted in these and written as "GB", as navigator.deviceMemory counts memory. */
const GIB = 2 ** 30

/** What navigator.deviceMemory is taken to be when the browser does not say (Safari, Firefox), GB. */
const MEMORY_UNKNOWN_GB = 4

/**
 * The plan's table (plan 3.4), one row per profile, apart from the GPU, the threads and the size limits (below).
 * Desktops take the local server's context and answer length (localCompute.ts), so a model answers alike in the page
 * and on a server; phones take half the context and a quarter of the answer, and smaller batches so one step of the
 * prompt holds the processor for less time. Warmup on a desktop is what wllama does when the option is unset
 * (llama.cpp's own default, true; inferred from wllama-context.h passing it through only when set).
 */
const ROWS: Readonly<Record<Profile, Pick<Placement, 'ctx' | 'batch' | 'ubatch' | 'maxTokens' | 'warmup'>>> = Object.freeze({
  discrete: Object.freeze({ ctx: CONTEXT_TOKENS, batch: undefined, ubatch: undefined, maxTokens: ANSWER_TOKENS, warmup: true }),
  integrated: Object.freeze({ ctx: CONTEXT_TOKENS, batch: 512, ubatch: 256, maxTokens: ANSWER_TOKENS, warmup: true }),
  phone: Object.freeze({ ctx: 4096, batch: 256, ubatch: 128, maxTokens: 512, warmup: false }),
  lite: Object.freeze({ ctx: 4096, batch: 256, ubatch: 128, maxTokens: 512, warmup: false }),
})

/**
 * The city's tier cap while the model works (governor.ts tiers): Low on an integrated GPU (the city and the model
 * share one chip and its memory), Minimal on a phone and Lite on the lite profile. A discrete GPU is capped at the top
 * tier, which caps nothing (the governor clamps a cap to the device's range) but still holds the city: the plan's "none
 * (failures not recorded)". A step down while the model has the GPU is then not remembered against the tier, and the
 * release returns the tier from before; a null here would release instead, and every such step would back off.
 */
const HOLD: Readonly<Record<Profile, number>> = Object.freeze({ discrete: TIERS.length - 1, integrated: 1, phone: 0, lite: LITE_TIER })

/**
 * The size limits on the whole model (every shard together), GB: above `warn` it loads with a warning, above
 * `refuse` it does not load. A desktop's processor limits are wasm's: a page's heap stops at 4 GB (wllama's build
 * sets the maximum to 4096 MB), and the spike showed the weights are read into that heap even with async reads ("CPU
 * model buffer size" in the log), so the model and its cache and working memory must fit in 4 GB together. On the GPU
 * the weights go to the GPU's own memory, so the plan sets no refuse limit there, only a warning above 4 GB
 * (inferred: no GPU load was measured; plan step 10 tunes it). A GPU load that fails is tried on the processor only
 * when the model fits the processor's limits (inPage.ts).
 */
const LIMITS = Object.freeze({
  desktop: Object.freeze({ warnCpu: 3, warnGpu: 4, refuseCpu: 3.75 }),
  /** The refuse limit is the smaller of the two: a fixed ceiling, and a share of what the phone says it has. */
  phone: Object.freeze({ warn: 1, refuse: 2, memoryShare: 0.4 }),
  lite: Object.freeze({ warn: 0.6, refuse: 1.5 }),
})

/** The profile a device runs under. The lite profile wins over the phone; a GPU of unknown class counts as integrated, the careful choice. */
function profileOf(env: Pick<PlanEnv, 'mobile' | 'lite' | 'gpuClass'>): Profile {
  if (env.lite) return 'lite'
  if (env.mobile) return 'phone'
  return env.gpuClass === 'discrete' ? 'discrete' : 'integrated'
}

/**
 * Whether the model runs on the GPU. The operator's `off` and a GPU load that already failed this visit both mean
 * the processor; `on` means the GPU on any device; otherwise a desktop uses it only when the city's GPU device has
 * shader-f16 (the spike saw wllama, asked for the GPU on a device without it, run on the processor without a word),
 * and a phone never does, so the model does not take the GPU the city is drawn with. A failed load wins over `on`
 * for the rest of the visit (inPage.ts).
 */
function gpuFor(env: PlanEnv, profile: Profile): boolean {
  if (env.gpuMode === 'off' || env.gpuFailed) return false
  if (env.gpuMode === 'on') return true
  return (profile === 'discrete' || profile === 'integrated') && env.f16
}

/**
 * How many threads the model runs on. Only a cross-origin isolated page can share memory between them; without it
 * wllama runs one thread whatever it is asked (spike), so one is asked. A desktop takes half its cores (up to 8), a
 * phone leaves two cores to the city and the system (up to 4), and the lite profile takes 2. Never more than the
 * cores there are; a core count that makes no sense counts as 4, as the page reads an absent one.
 */
function threadsFor(profile: Profile, env: PlanEnv): number {
  if (!env.isolated) return 1
  const cores = Number.isFinite(env.cores) && env.cores >= 1 ? Math.floor(env.cores) : 4
  switch (profile) {
    case 'lite': return Math.min(2, cores)
    case 'phone': return Math.min(4, Math.max(1, cores - 2))
    default: return Math.min(8, Math.max(1, Math.floor(cores / 2)))
  }
}

/**
 * Where and how a model runs on this device (plan 3.4). `think` is the operator's choice: thinking is never turned on
 * by the profile (D11), on a phone because it multiplies the time to an answer, on a desktop because the operator
 * has not asked for it.
 */
export function placement(env: PlanEnv, think?: boolean): Placement {
  const profile = profileOf(env)
  return { gpu: gpuFor(env, profile), threads: threadsFor(profile, env), ...ROWS[profile], think: think === true, profile }
}

/** Tenths of a GB in `bytes`, to the nearest. */
const tenthsOf = (bytes: number): number => Math.round((bytes / GIB) * 10)
/** "2.4 GB" from tenths of a GB. */
const gb = (tenths: number): string => `${(tenths / 10).toFixed(1)} GB`

/**
 * The two sizes of a sentence: the model's and the limit it is over. The limit is rounded down (it is "about"), and
 * the model never reads as at or under it, so a model a few bytes over a limit does not say "1.6 GB; about 1.6 GB".
 */
function sizes(total: number, limitGb: number): { model: string; limit: string } {
  const limit = Math.floor(limitGb * 10 + 1e-9)
  return { model: gb(Math.max(tenthsOf(total), limit + 1)), limit: gb(limit) }
}

type Sizes = ReturnType<typeof sizes>

/** A profile's two limits, GB, and the sentence for a model over each. */
interface Limits { warn: number; refuse: number; tooBig(s: Sizes): string; risky(s: Sizes): string }

/** The limits for a placement (LIMITS): a phone's refuse limit follows its memory, a desktop's limits where the model runs. */
function limitsOf(env: PlanEnv, place: Placement): Limits {
  if (place.profile === 'discrete' || place.profile === 'integrated') {
    return {
      warn: place.gpu ? LIMITS.desktop.warnGpu : LIMITS.desktop.warnCpu,
      refuse: place.gpu ? Infinity : LIMITS.desktop.refuseCpu,
      tooBig: (s) => `this model is ${s.model}; this page can hold about ${s.limit} (a page gets 4 GB of memory in all)`,
      risky: (s) => `this model is ${s.model}; above ${s.limit} this page may answer slowly or run out of memory`,
    }
  }
  // The lite profile can be asked for on a desktop (?lite=1); a phone profile is always a phone.
  const where = env.mobile ? 'this phone' : 'this device'
  const memory = env.memoryGb !== undefined && Number.isFinite(env.memoryGb) && env.memoryGb > 0 ? env.memoryGb : MEMORY_UNKNOWN_GB
  return {
    warn: place.profile === 'lite' ? LIMITS.lite.warn : LIMITS.phone.warn,
    refuse: place.profile === 'lite' ? LIMITS.lite.refuse : Math.min(LIMITS.phone.refuse, LIMITS.phone.memoryShare * memory),
    tooBig: (s) => `this model is ${s.model}; ${where} can hold about ${s.limit}`,
    risky: (s) => `this model is ${s.model}; above ${s.limit} ${where} may answer slowly or close the page`,
  }
}

/**
 * Whether the model's files fit this device as placed: their total size against the profile's limits (LIMITS).
 * A size exactly at a limit passes it; one byte over does not. The reason and the warning are plain sentences that
 * name both sizes, for the console.
 */
export function fits(files: readonly FileSize[], env: PlanEnv, place: Placement): Fit {
  if (!files.length) return { ok: false, reason: 'there is no model file to load' }
  let total = 0
  for (const f of files) {
    if (!Number.isFinite(f.bytes) || f.bytes < 0) return { ok: false, reason: `the size of ${f.name} is not known` }
    total += f.bytes
  }
  const l = limitsOf(env, place)
  if (total > l.refuse * GIB) return { ok: false, reason: l.tooBig(sizes(total, l.refuse)) }
  if (total > l.warn * GIB) return { ok: true, warn: l.risky(sizes(total, l.warn)) }
  return { ok: true }
}

/**
 * The tier cap while the model works (plan 3.4 "City cap while busy"), for governor.hold. Never null today, because
 * hold(null) is the release. A discrete GPU gets the top of the table (Ultra), a hold that lowers nothing below Peak
 * (HOLD). `gpu` is where the model runs: on a discrete card's processor path (no shader-f16, or `ask gpu off`) the
 * model takes none of the card's memory, so the cap is Peak (PEAK_TIER), which lowers nothing on a Peak range; the
 * governor clamps a cap into the device's range, so every other discrete desktop is still capped at Ultra, as before.
 */
export function holdTier(env: Pick<PlanEnv, 'mobile' | 'lite' | 'gpuClass'>, gpu: boolean): number | null {
  const profile = profileOf(env)
  return profile === 'discrete' && !gpu ? PEAK_TIER : HOLD[profile]
}
