// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what the page remembers about this GPU and the crowd's kernels (crowdSensor.ts
 * CROWD_KERNELS), so a start never asks a GPU twice for a kernel it could not build. Two things are worth keeping.
 * A kernel the GPU's own compiler refused costs a phone the whole compile before it says no, on every start. And a
 * kernel that took the GPU down with it (the driver crashed or hung compiling it, and the browser's GPU process
 * went: every device on the page is lost with it, the page's own included) cannot be stepped past in place at all:
 * the page has to start again, and without a memory it would ask for the same kernel and go down the same way,
 * each time costing the browser a GPU process (Chrome stops offering a GPU after a few). So the page keeps one small
 * record in localStorage: the rung the next start begins at, why, and where it was learnt: the kernels' own
 * fingerprint (a build that changes them asks afresh), the browser's user agent (an update asks afresh) and the
 * adapter's line. The policy is here too: after a refusal the ladder's next rung, in order; after a loss straight to
 * the light kernel, skipping the narrow one (the same module at half the workgroup: a compiler that died on the one
 * is not worth a second GPU process to learn about the other), and after the light kernel's own loss nothing, for
 * NONE_RETRY_MS (a day once it has gone down twice running), so a start that cannot work is not paid for with a
 * crash each time. One loss is one piece of evidence, and a GPU process is shared with every tab (another tab's
 * work, the browser's own watchdog or the system short of memory end it the same way): so a single loss is asked
 * about once more a day later (LOST_RETRY_MS), and only a second loss under the same kernel holds for as long as
 * the record matches; a refusal, cheap to ask again, is asked again after a week (REFUSED_RETRY_MS), and one whose
 * words name memory is not kept at all. One GPU family starts lower before anything is learnt (familyKernel): Mali
 * Bifrost, whose driver took Chrome's GPU process down compiling the full kernel and refused it in Brave, so a first
 * visit, and every browser update (which asks afresh), does not cost such a phone a GPU process to learn it again.
 * The record changes at two moments of a boot
 * only: a loss blamed on a kernel (the verdict, once), and the realm standing (stood, once); nothing the worker says
 * in between or afterwards touches it. One record serves every tab of the page, so two tabs learn from each other
 * and the last writer wins. Pure: storage is handed in (pageKernelStore reads the browser's, guarded like every
 * store here), and the tests hand in their own.
 * What breaks if it is removed? A phone whose driver dies on the full kernel shows the same failure at every
 * restart, and one whose driver refuses it compiles it again on every visit before the kernel that runs.
 */
import { CROWD_KERNELS, crowdKernelOf, KERNEL_WORDS, kernelBelow, type CrowdKernel } from './crowdSensor.ts'
import { WebGPUUnavailableError } from '../01_Initialize_World/gpuDevice.ts'

/** Keyed by the package id like every store of the page. */
export const KERNEL_MEMORY_KEY = 'civic-simulation:crowd-kernel:v1'
export const KERNEL_RECORD_VERSION = 1
/** A stored value longer than this is corrupt, not a record. */
const RAW_MAX = 4096
/** The browser's words kept with a record, at most (a driver's message can run long). */
const WORDS_MAX = 600
/** How long 'none' holds before the light kernel is asked of this GPU once more, ms: an hour, so crashes are far apart. */
export const NONE_RETRY_MS = 3_600_000
/** How long one loss under a kernel holds before that kernel is asked of this GPU once more, ms: a day. */
export const LOST_RETRY_MS = 86_400_000
/** How long a refusal holds before the ladder is asked from the top again, ms: a week (a refusal costs only its compile). */
export const REFUSED_RETRY_MS = 7 * 86_400_000
/** Losses under one kernel after which it is not asked again while the record matches. */
export const LOST_STRIKES = 2
/** A refusal in these words is the system short of memory at that moment, not the kernel: nothing to remember. */
const MEMORY_WORDS = /OUT_OF_(?:HOST_|DEVICE_)?MEMORY|out of memory/i

/** Pure. How long a record of 'none' holds, ms: an hour after the lightest kernel's first loss, a day once it went down twice running. */
export function noneHoldMs(strikes: number): number {
  return strikes >= LOST_STRIKES ? LOST_RETRY_MS : NONE_RETRY_MS
}

/** Where the next start begins: a rung below the full one, or 'none' once the lightest took the GPU down. */
export type KernelFloor = Exclude<CrowdKernel, 'full'> | 'none'

/** Where a record was learnt: it holds only there. */
export interface KernelWhere {
  /** crowdCompute.ts kernelSourcesKey(): the kernels' own fingerprint. */
  sources: string
  /** navigator.userAgent. */
  ua: string
  /** The page adapter's line (gpuDevice.ts adapterLine). */
  adapter: string
}

/** What is kept. */
export interface KernelMemory extends KernelWhere {
  v: typeof KERNEL_RECORD_VERSION
  from: KernelFloor
  /** 'refused': the GPU's compiler said no, cleanly. 'lost': the GPU went while the rung was built. */
  why: 'refused' | 'lost'
  /** The rung that was refused or lost. */
  rung: CrowdKernel
  /** The browser's words for it. */
  words: string
  /** When, ms since the epoch. */
  at: number
  /** How many starts in a row lost the GPU under `rung` (1 for a refusal): LOST_STRIKES makes it stand. */
  strikes: number
}

/** The storage this needs (localStorage's own shape). */
export interface KernelStore {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** localStorage, or null where the page may not use it (reading the property itself can throw). */
export function pageKernelStore(): KernelStore | null {
  try { return (globalThis as { localStorage?: KernelStore }).localStorage ?? null } catch { return null }
}

/**
 * Pure. The rung a GPU family starts at before anything is learnt of this GPU, from the adapter's line (gpuDevice.ts
 * adapterLine: vendor / architecture / description), or null: the full kernel, as for every other GPU. Mali Bifrost
 * (architecture 'bifrost', or a Mali-G31, G51, G52, G71, G72 or G76 by name) starts on the light kernel: on a Mali-G52
 * (Android 16) Chrome's GPU process died compiling the full kernel, and Brave's compiler refused it and the narrow
 * one, so asking costs a crash, or two refused compiles, and never gives more. Valhall and later Malis are not known
 * to fail and keep the full kernel; ?kernel=full still asks for everything.
 */
export function familyKernel(adapter: string): Exclude<CrowdKernel, 'full'> | null {
  const a = adapter.toLowerCase()
  return /\bbifrost\b|\bmali-g(?:31|51|52|71|72|76)\b/.test(a) ? 'lite' : null
}

/** Pure. Whether `a` is a heavier kernel than `b` (higher on the ladder). */
const heavier = (a: CrowdKernel, b: CrowdKernel): boolean => CROWD_KERNELS.indexOf(a) < CROWD_KERNELS.indexOf(b)

/**
 * Pure. Whether `raw` holds a record of a kernel that took the GPU down, learnt anywhere (any build, browser version or
 * adapter: a browser update asks the kernels afresh but does not undo what its GPU process went through). The
 * recovery card's evidence that this browser's GPU went down under the city before (bootFailure.ts pageEnv).
 */
export function lostBefore(raw: string | null): boolean {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return false
  let data: unknown
  try { data = JSON.parse(raw) } catch { return false }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false
  const r = data as { sources?: unknown; ua?: unknown }
  return parseKernelMemory(raw, { sources: str(r.sources) ? r.sources : '', ua: str(r.ua) ? r.ua : '', adapter: null })?.why === 'lost'
}

/** Pure. Where the next start begins after `rung` took the GPU down: the light kernel, or nothing after its own loss. */
export function afterLoss(rung: CrowdKernel): KernelFloor {
  return rung === 'lite' ? 'none' : 'lite'
}

/** Pure. The rung below `rung` as a floor: where a start begins once `rung` was refused; 'none' below the last. */
export function afterRefusal(rung: CrowdKernel): KernelFloor {
  return (kernelBelow(rung) as Exclude<CrowdKernel, 'full'> | null) ?? 'none'
}

const str = (v: unknown): v is string => typeof v === 'string'

/**
 * Pure. The record in `raw` if it is one and was learnt `where`; null otherwise (nothing kept, corrupt, another GPU,
 * browser or build). An `adapter` of null matches any: the read before a device exists (heldNone).
 */
export function parseKernelMemory(raw: string | null, where: Omit<KernelWhere, 'adapter'> & { adapter: string | null }): KernelMemory | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > RAW_MAX) return null
  let data: unknown
  try { data = JSON.parse(raw) } catch { return null }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  const r = data as Partial<Record<keyof KernelMemory, unknown>>
  if (r.v !== KERNEL_RECORD_VERSION || !str(r.sources) || !str(r.ua) || !str(r.adapter) || !str(r.words)) return null
  const from = r.from === 'none' ? 'none' : crowdKernelOf(r.from)
  const rung = crowdKernelOf(r.rung)
  if (!from || from === 'full' || !rung || (r.why !== 'refused' && r.why !== 'lost') || typeof r.at !== 'number' || !Number.isFinite(r.at)) return null
  if (typeof r.strikes !== 'number' || !Number.isInteger(r.strikes) || r.strikes < 1) return null
  if (r.sources !== where.sources || r.ua !== where.ua || (where.adapter !== null && r.adapter !== where.adapter)) return null
  return { v: KERNEL_RECORD_VERSION, sources: r.sources, ua: r.ua, adapter: r.adapter, from, why: r.why, rung, words: r.words.slice(0, WORDS_MAX), at: r.at, strikes: Math.min(r.strikes, LOST_STRIKES) }
}

/** What is remembered `where`, or null: no storage, nothing kept, or kept for another GPU, browser or build. */
export function loadKernelMemory(store: KernelStore | null, where: KernelWhere): KernelMemory | null {
  if (!store) return null
  try { return parseKernelMemory(store.getItem(KERNEL_MEMORY_KEY), where) } catch { return null }
}

/**
 * Keeps a record and reads it back: true only when the next start will find it. Never throws (quota, a private
 * window, blocked site data: false).
 */
export function saveKernelMemory(store: KernelStore | null, where: KernelWhere, what: Pick<KernelMemory, 'from' | 'why' | 'rung' | 'words'> & { strikes?: number }, nowMs: number): boolean {
  if (!store) return false
  const record: KernelMemory = { v: KERNEL_RECORD_VERSION, sources: where.sources, ua: where.ua, adapter: where.adapter, from: what.from, why: what.why, rung: what.rung, words: what.words.slice(0, WORDS_MAX), at: nowMs, strikes: Math.min(Math.max(1, Math.trunc(what.strikes ?? 1)), LOST_STRIKES) }
  try {
    store.setItem(KERNEL_MEMORY_KEY, JSON.stringify(record))
    return parseKernelMemory(store.getItem(KERNEL_MEMORY_KEY), where)?.from === what.from
  } catch {
    return false
  }
}

/** Forgets the record (the full kernel stood here after all). No-op without storage. */
export function clearKernelMemory(store: KernelStore | null): void {
  if (!store) return
  try { store.removeItem(KERNEL_MEMORY_KEY) } catch { /* storage unavailable */ }
}

/** Where a start begins, and what it says of why. */
export interface KernelPlan {
  /** The first rung asked of the GPU, or null: none is asked (every kernel took this GPU down within NONE_RETRY_MS). */
  from: CrowdKernel | null
  /**
   * 'address': ?kernel= said. 'memory': a record did. 'retry': a record of one loss, old enough that the kernel it
   * names is asked once more. 'family': the GPU's family starts lower (familyKernel), nothing learnt of this GPU (or
   * a refusal old enough to ask again). 'default': the full kernel, the same with nothing against it.
   */
  by: 'address' | 'memory' | 'retry' | 'family' | 'default'
}

/** Pure. Whether a record written at `at` still holds at `nowMs` for `ms` (a clock that went back holds nothing). */
const holds = (at: number, nowMs: number, ms: number): boolean => nowMs - at >= 0 && nowMs - at < ms

/**
 * Pure. The first rung of this start: the address's word (?kernel=) when it has one, else the record's, else where
 * the GPU's family starts (`family`, familyKernel), else the full kernel. A record of 'none' stops the start for
 * noneHoldMs after it was written, whatever the address says, save `?kernel=full`, which asks for everything again
 * (the page's own restart writes ?kernel=lite into the address, so only the word it never writes is taken as the
 * player's own); after that the light kernel is asked once more. A record of one loss asks for the lost kernel again
 * after LOST_RETRY_MS, once ('retry'), unless that kernel is above where the family starts (the record then stands);
 * a refusal asks from the top again after REFUSED_RETRY_MS, the family's top for a family that starts lower, save
 * where the rung the record saw stand is above the family's (asked for by address once, and it ran): that rung.
 */
export function planKernel(asked: CrowdKernel | null, memory: KernelMemory | null, nowMs: number, family: Exclude<CrowdKernel, 'full'> | null = null): KernelPlan {
  const top: KernelPlan = family ? { from: family, by: 'family' } : { from: 'full', by: 'default' }
  if (memory?.from === 'none' && asked !== 'full') {
    if (holds(memory.at, nowMs, noneHoldMs(memory.strikes))) return { from: null, by: 'memory' }
    // After the hold the light kernel is asked once more: the record's doing, or the family's where the family starts
    // there (nothing heavier was asked of such a GPU, so no heavier kernel is to blame: engine.ts kernelWhy).
    return asked ? { from: asked, by: 'address' } : { from: 'lite', by: family === 'lite' ? 'family' : 'memory' }
  }
  if (asked) return { from: asked, by: 'address' }
  if (memory && memory.from !== 'none') {
    if (memory.why === 'refused') return holds(memory.at, nowMs, REFUSED_RETRY_MS) || (family && heavier(memory.from, family)) ? { from: memory.from, by: 'memory' } : top
    if (memory.strikes < LOST_STRIKES && !holds(memory.at, nowMs, LOST_RETRY_MS) && !(family && heavier(memory.rung, family))) return { from: memory.rung, by: 'retry' }
    return { from: memory.from, by: 'memory' }
  }
  return top
}

/**
 * The record of 'none' that stops this start, read before any device is asked for (so with no adapter to match: a
 * phone has one GPU, and a browser that lost it twice in two minutes hands the page no adapter for a while, when
 * the record could never be read at all). Null: nothing stops it.
 */
export function heldNone(store: KernelStore | null, where: Omit<KernelWhere, 'adapter'>, asked: CrowdKernel | null, nowMs: number): KernelMemory | null {
  if (!store) return null
  let memory: KernelMemory | null
  try { memory = parseKernelMemory(store.getItem(KERNEL_MEMORY_KEY), { ...where, adapter: null }) } catch { return null }
  return memory && planKernel(asked, memory, nowMs).from === null ? memory : null
}

/** One step of the worker's ladder as the page hears it (07_Execute_Actions/simProtocol.ts SimCrowdKernel). */
export interface LadderStep { rung: CrowdKernel; step: 'trying' | 'refused' | 'running' | 'lost'; words?: string }

/** What a loss under a kernel comes to: the kernel, where the next start begins, and whether that was kept. */
export interface KernelVerdict {
  rung: CrowdKernel
  next: KernelFloor
  /** The record was written and read back: the next start finds it without being told. */
  saved: boolean
  /** The browser's words for the loss. */
  words: string
  /**
   * From the rung being asked for to its loss, ms (null where the page never heard it asked for). A hang the
   * browser's own watchdog ended takes fifteen seconds or more; a crash, or the system ending the GPU process, less.
   */
  elapsedMs: number | null
  /** For 'none': how long the GPU is left alone from here, ms (noneHoldMs). */
  holdMs: number
}

/**
 * One boot's view of the ladder: what this start asks for (planKernel), what the worker then says (note), what a loss
 * comes to (lost, pageLost) and what standing comes to (stood). The record is written at those two moments only. A
 * loss under a rung, seen while the page was in front the whole time, makes the light kernel the next start
 * (afterLoss); a loss while the page was hidden is the phone taking the GPU back from an app in the background,
 * blamed on no kernel and never kept. Once the realm stands (its crowd's first reading is in), the full kernel
 * forgets the record, and a rung reached by a refusal in this very boot becomes where later starts begin.
 */
export class KernelWatch {
  readonly plan: KernelPlan
  readonly memory: KernelMemory | null
  readonly #store: KernelStore | null
  readonly #where: KernelWhere
  readonly #now: () => number
  /** The newest step the worker told, or null before the crowd's build began. */
  #last: LadderStep | null = null
  /** The last rung this boot saw refused, with the browser's words. */
  #refused: { rung: CrowdKernel; words: string } | null = null
  /** The rung the worker last said it was asking for, and when. */
  #asked: { rung: CrowdKernel; at: number } | null = null
  #verdict: KernelVerdict | null = null
  #stood = false

  constructor(store: KernelStore | null, where: KernelWhere, asked: CrowdKernel | null, now: () => number = Date.now) {
    this.#store = store
    this.#where = where
    this.#now = now
    this.memory = loadKernelMemory(store, where)
    this.plan = planKernel(asked, this.memory, now(), familyKernel(where.adapter))
  }

  /** The newest step the worker told, or null. */
  get last(): LadderStep | null {
    return this.#last
  }

  /** What the loss under a kernel came to in this boot, or null: none, or none blamed on a kernel. */
  get verdict(): KernelVerdict | null {
    return this.#verdict
  }

  /** The rung the worker is building now (asked for, or built with its first reading still to come), or null. */
  get building(): CrowdKernel | null {
    const last = this.#last
    return !this.#verdict && !this.#stood && last && last.step !== 'refused' ? last.rung : null
  }

  /**
   * Hears the worker's ladder. `visible`: the page has been in front for the whole boot so far. Nothing is heard
   * after the boot's verdict or after the realm stood: a worker still running under a failed boot changes no record.
   */
  note(step: LadderStep, visible: boolean): void {
    if (this.#verdict || this.#stood) return
    this.#last = step
    if (step.step === 'trying') this.#asked = { rung: step.rung, at: this.#now() }
    else if (step.step === 'refused') this.#refused = { rung: step.rung, words: step.words ?? '' }
    else if (step.step === 'lost') this.lost(step.rung, step.words ?? '', visible)
  }

  /**
   * The GPU went while `rung` was being built (the worker said so, or the page's own device was lost while the worker
   * built it: pageLost). Seen in front, the rung is blamed and the next start's rung kept; hidden, nothing is. The
   * first verdict of a boot stands: the worker and the page both report the one loss. A second loss under the kernel
   * a 'retry' asked for again is its last (LOST_STRIKES). A loss never raises what the record holds: where 'none'
   * still holds (the address asked for everything again, and a heavier kernel went down), nothing lighter is left to
   * go to and the record stands as it is, its time too.
   */
  lost(rung: CrowdKernel, words: string, visible: boolean): KernelVerdict | null {
    if (this.#verdict || this.#stood || !visible) return this.#verdict
    const now = this.#now()
    const before = this.memory
    const held = before?.from === 'none' && rung !== 'lite' && holds(before.at, now, noneHoldMs(before.strikes))
    const next = held ? 'none' : afterLoss(rung)
    const elapsedMs = this.#asked?.rung === rung ? Math.max(0, now - this.#asked.at) : null
    if (held) {
      this.#verdict = { rung, next, saved: true, words, elapsedMs, holdMs: Math.max(0, before.at + noneHoldMs(before.strikes) - now) }
      return this.#verdict
    }
    // Strikes count losses in a row under the one kernel: the lightest's own for 'none', else the rung's.
    const again = next === 'none' ? before?.from === 'none' : before?.why === 'lost' && before.from !== 'none' && before.rung === rung
    const strikes = again && before ? before.strikes + 1 : 1
    const saved = saveKernelMemory(this.#store, this.#where, { from: next, why: 'lost', rung, words, strikes }, now)
    this.#verdict = { rung, next, saved, words, elapsedMs, holdMs: next === 'none' ? noneHoldMs(strikes) : 0 }
    return this.#verdict
  }

  /**
   * The page's own device was lost before the realm stood. `processGone`: the browser's words were those of its GPU
   * process going (gpuPipelines.ts processGone), which takes every device of the page at once, the worker's with it:
   * then the kernel the worker was building is the one thing this page was asking of the GPU, and its loss. A loss of
   * the page's device alone says nothing of the worker's kernel (the worker says so itself if its device went too:
   * note), and before the crowd's build began, or between rungs, no kernel is blamed either (null).
   */
  pageLost(words: string, visible: boolean, processGone: boolean): KernelVerdict | null {
    if (this.#verdict) return this.#verdict
    const rung = this.building
    return rung && processGone ? this.lost(rung, words, visible) : null
  }

  /**
   * The realm stands: the crowd's kernel is built and its first reading is in (`kernel`: the one that runs; 'none'
   * where no crowd was asked for). Once per boot, and never after a verdict. The full kernel forgets the record. A
   * rung reached because the one above was refused in this very boot becomes where later starts begin (unless the
   * refusal's words name memory: the system was short of it then, which says nothing of the kernel). The light
   * kernel standing where the record said 'none' leaves the record of one loss above it, to be asked about a day
   * later, save on a GPU whose family starts at the kernel that stood (familyKernel): nothing above it was asked of
   * that GPU, so the record is forgotten and later starts begin where the family does. A kernel asked for again
   * ('retry') that stands below the full one forgets the record, so the next start learns the ladder afresh. Anything else (the remembered rung ran, or the address's) changes nothing.
   */
  stood(kernel: CrowdKernel | 'none'): void {
    if (this.#verdict || this.#stood) return
    this.#stood = true
    if (kernel === 'none') return
    const before = this.memory
    if (kernel === 'full') clearKernelMemory(this.#store)
    else if (this.#refused) {
      if (!MEMORY_WORDS.test(this.#refused.words)) saveKernelMemory(this.#store, this.#where, { from: kernel, why: 'refused', rung: this.#refused.rung, words: this.#refused.words }, this.#now())
    }
    else if (before?.from === 'none') {
      const family = familyKernel(this.#where.adapter)
      if (family && !heavier(kernel, family)) clearKernelMemory(this.#store)
      else saveKernelMemory(this.#store, this.#where, { from: kernel, why: 'lost', rung: 'full', words: before.words }, this.#now())
    }
    else if (this.plan.by === 'retry') clearKernelMemory(this.#store)
  }
}

/** Pure. A record in one line, for the console's `hardware` and the card's details. */
export function describeKernelMemory(m: KernelMemory): string {
  const did = m.why === 'lost' ? `${KERNEL_WORDS[m.rung]} took this GPU down` : `this GPU's compiler refused ${KERNEL_WORDS[m.rung]}`
  const times = m.why === 'lost' && m.strikes > 1 ? `on ${m.strikes} earlier starts` : 'on an earlier start'
  return `${did} ${times} (${m.words || 'no message'}); ${m.from === 'none' ? 'no kernel is left to ask for' : `starts begin at ${KERNEL_WORDS[m.from]}`}`
}

/**
 * The boot's failure for a kernel that took the GPU down while a lighter one is left: the recovery card's
 * 'kernel-lost' (bootFailure.ts). `lighter` is the kernel the next start asks for, and where the card's Restart goes
 * (?kernel=, so the restart is right even in a browser that kept no record). `auto`: the page may make that restart
 * itself, at once: only when this start's kernel was not the address's own word, so a page that restarted with
 * ?kernel= never restarts itself again, whatever its storage does.
 */
export class KernelResetError extends WebGPUUnavailableError {
  readonly lighter: Exclude<CrowdKernel, 'full'>
  readonly auto: boolean
  constructor(message: string, lighter: Exclude<CrowdKernel, 'full'>, auto: boolean) {
    super('kernel-lost', message)
    this.name = 'KernelResetError'
    this.lighter = lighter
    this.auto = auto
  }
}

/**
 * The boot's failure once no kernel is left to ask this GPU for: the recovery card's 'kernel-none'. `kept`: the
 * browser holds the record that leaves the GPU alone, so the card's Restart costs nothing (it goes to the address
 * without ?kernel=, which the hold then stops before any GPU is asked for); false where the browser keeps nothing
 * for this page, and a restart asks the GPU again.
 */
export class KernelNoneError extends WebGPUUnavailableError {
  readonly kept: boolean
  constructor(message: string, kept: boolean) {
    super('kernel-none', message)
    this.name = 'KernelNoneError'
    this.kept = kept
  }
}

/** Pure. How long the GPU is left alone, in the card's words. */
function holdWords(ms: number): string {
  const minutes = Math.ceil(ms / 60_000)
  if (minutes >= 90) return `about ${Math.round(minutes / 60)} hours`
  if (minutes >= 55) return 'about an hour'
  return minutes <= 1 ? 'a minute' : `about ${minutes} minutes`
}
/** The words for when a GPU held at 'none' is asked again, in the card's details. */
const retryWords = (holdMs: number): string => `The city leaves this GPU alone for ${holdWords(holdMs)}, then asks it for the light kernel once more; ?kernel=full in the address asks for everything again at once.`
/** The same where the browser kept no record: nothing holds the next start back. */
const UNKEPT_WORDS = 'This browser kept no note of it (no storage for this page), so a restart asks this GPU again.'

/**
 * Pure. The failure a verdict comes to: 'kernel-lost' with the lighter kernel to restart on, or, after the lightest
 * kernel's own loss, 'kernel-none' (nothing is left to ask this GPU for). The words name the kernel, say how long
 * after it was asked for the GPU went, carry the browser's own, and say where the next start begins and whether
 * that was kept.
 */
export function kernelLostFailure(v: KernelVerdict, plan: KernelPlan): WebGPUUnavailableError {
  const took = v.elapsedMs === null ? '' : `, ${(v.elapsedMs / 1000).toFixed(1)} s after it was asked for`
  const head = `The GPU was lost while ${KERNEL_WORDS[v.rung]} of the crowd was being built${took} (${v.words || 'no message'}).`
  if (v.next === 'none') {
    const none = v.rung === 'lite' ? 'That is the lightest kernel: none is left to ask this GPU for.' : 'The light kernel took this GPU down on an earlier start as well: none is left to ask this GPU for.'
    return new KernelNoneError(`${head} ${none} ${v.saved ? retryWords(v.holdMs) : UNKEPT_WORDS}`, v.saved)
  }
  const kept = v.saved ? 'the page remembers it for later visits' : 'this browser kept no note of it for later visits (no storage for this page)'
  return new KernelResetError(`${head} Restart asks for ${KERNEL_WORDS[v.next]} (?kernel=${v.next}); ${kept}.`, v.next, plan.by !== 'address')
}

/**
 * Pure. The failure of a start that asks nothing of the GPU: every kernel took it down, and the record still holds
 * (planKernel). `nowMs` is when, for how long is left.
 */
export function kernelNoneFailure(memory: KernelMemory, nowMs: number): WebGPUUnavailableError {
  const said = describeKernelMemory(memory)
  const left = Math.max(0, memory.at + noneHoldMs(memory.strikes) - nowMs)
  return new KernelNoneError(`${said.charAt(0).toUpperCase()}${said.slice(1)}. ${retryWords(left)}`, true)
}
