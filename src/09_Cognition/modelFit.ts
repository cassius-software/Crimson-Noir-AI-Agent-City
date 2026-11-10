// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the rule auto follows to give Ollama the largest model it already has that fits
 * the GPUs' memory the operator, the launcher or the Windows app gave, by what Ollama itself measured: when to measure, what a
 * measurement says, which model steps in, and the one console line that says so. It makes no request.
 * What breaks if it is removed? The router cannot size Ollama's model; auto keeps today's pick on every machine.
 *
 * The figure is the GPUs' memory in GB: `ask vram <GB>` at the console (kept between visits), else `vram=` in the
 * page's address (the NixOS launcher adds it), else what the Windows app read from DXGI (figureFromAdapters), else
 * nothing, and with nothing the router does exactly what it did before. A model whose listed weights alone exceed the figure is never chosen while a smaller one is listed (today's
 * pick included). A bigger model is chosen only after Ollama's own /api/ps has shown how much a loaded model takes and
 * that some of it sits on the GPU; then the largest listed model whose need, its weights times the largest
 * loaded-to-weights ratio measured on this server, fits the figure less RESERVE_BYTES. A measured model that was too
 * slow (a bigger one), split and slow (one no bigger), or split when its first wait ran out, is set aside (failed).
 * The same measurement also lets Ollama's context grow, for this visit only: after an answer cut at its answer cap, on
 * a model measured all on the GPU at the context it was sent (Ollama's own context_length), fast enough to write the
 * longer answer within FIRST_PIECE_MS, with room under the figure less RESERVE_BYTES, the context doubles once (widen,
 * at most CONTEXT_MAX) and the answer cap with it (answerTokensFor); the first answer at the larger context is measured,
 * and one split, slow, on the processor (contextVerdict), refused or failing partway (the router's) goes back for the
 * rest of the visit. A context verdict never sets a model aside, and only measurements at CONTEXT_TOKENS are kept as
 * Seen, so choose is unchanged.
 * Every number marked a starting value is a guess the MANUAL names as one; none is from a real big GPU. Everything here
 * is a pure function of what it is given: the router (router.ts) asks the server and keeps what was measured.
 */
import { answerTokensFor, BYTES_MAX, CONTEXT_MAX, DEFAULT_MODEL, FIRST_PIECE_MS, localText, loopbackServer, type Placement, type Weighed } from './localCompute.ts'

export const GIB = 2 ** 30
/** Starting value: llama.cpp --fit keeps 1 GiB per device; 1 GiB more for the city's own WebGPU. */
export const RESERVE_BYTES = 2 * GIB
/** Starting values: slower than this many tokens a second, over at least PACE_TOKENS, is slow. */
export const PACE_FLOOR = 5
export const PACE_TOKENS = 32
/** Starting value: too big in this many visits, and a model is avoided until ask vram or a re-pull. */
export const FAILS_KEPT = 2
/** Starting value: the first-piece wait allows this many bytes of weights read a second. */
export const COLD_READ_BYTES_S = 200e6
/** The most measurements kept between visits (the newest). */
export const SEEN_MAX = 16
/** The largest figure taken, GB. */
export const VRAM_MAX_GB = 4096
/** What the console says to anything ask vram does not take. */
export const VRAM_USAGE = "ask vram takes the GPUs' memory in GB, from 0 to 4096 (such as ask vram 24; 0 sizes nothing), or auto"

/**
 * One measurement: on `server`, `model` with `weights` listed bytes was loaded at `loaded` bytes in all, `gpu` of them
 * on GPUs, writing `pace` tokens a second (null when the server did not say, 0 for a stall); `fails` is in how many
 * visits it was found too big or too slow (FAILS_KEPT and it is avoided).
 */
export interface Seen { readonly server: string; readonly model: string; readonly weights: number; readonly loaded: number; readonly gpu: number; readonly pace: number | null; readonly fails: number }
/** What the router keeps between visits: the console figure (null: none; 0: off), the measurements, and the model auto moved from. */
export interface FitKept { vram: number | null; seen: Seen[]; usual?: string }
/** The figure in force, GB, and where it came from: the console, the page's address, or the Windows app's reading. */
export interface Figure { readonly gb: number; readonly from: 'ask' | 'address' | 'app' }
/** Where a loaded model sits: all on GPUs, split between them and the processor, or all on the processor. */
export type Where = 'gpu' | 'split' | 'cpu'
/** What auto did with the usual model: kept it, stepped up, stepped down, or could not step down. */
export type Step = 'usual' | 'up' | 'down' | 'stuck'
/** The model auto answers with, its listed bytes, what it needs by measure (up), and why it stepped down. */
export interface Choice { readonly name: string; readonly step: Step; readonly bytes: number | null; readonly need?: number; readonly cause?: 'misfit' | 'measured' }

/** The one grammar of a figure, at the console and in the address: a plain decimal. */
const GB = /^\d{1,4}(\.\d+)?$/

/** A figure in GB from text: a plain decimal from 0 to VRAM_MAX_GB; null for anything else (never capped). */
export function readGb(text: unknown): number | null {
  if (typeof text !== 'string' || !GB.test(text)) return null
  const n = Number(text)
  return Number.isFinite(n) && n >= 0 && n <= VRAM_MAX_GB ? n : null
}

/** What ask vram takes: 'auto' (any case), or a figure readGb takes; anything else is refused with VRAM_USAGE. */
export function parseVram(text: unknown): number | 'auto' {
  const t = typeof text === 'string' ? text.trim() : ''
  if (t.toLowerCase() === 'auto') return 'auto'
  const n = readGb(t)
  if (n === null) throw new TypeError(VRAM_USAGE)
  return n
}

/**
 * The figure in force: the console's (0 there sizes nothing, whatever else says), else the address's (vram=0 there
 * sizes nothing too), else the Windows app's reading when above 0.
 */
export function figureOf(asked: number | null, address: string | null | undefined, app: number | null = null): Figure | null {
  if (asked !== null) return asked === 0 ? null : { gb: asked, from: 'ask' }
  const gb = readGb(address)
  if (gb !== null) return gb > 0 ? { gb, from: 'address' } : null
  return app !== null && app > 0 && app <= VRAM_MAX_GB ? { gb: app, from: 'app' } : null
}

/**
 * Starting value: an adapter with less is not counted. DXGI gives the memory the driver leaves to Windows, a little
 * under the card's size (one 4 GB card is reported at 3,949 MB by dxdiag, which reads the same number), so the floor
 * sits under the NixOS launcher's 4 GiB (tools/web/launch.mjs GPU_FLOOR_BYTES, nvidia-smi's total): a 4 GB card counts
 * on both and a 3 GB card on neither; an integrated GPU counts only when its firmware gives it 3.5 GiB or more.
 */
export const DXGI_FLOOR_BYTES = 3.5 * GIB

/**
 * The figure from the Windows app's reading (src-tauri/src/gpu.rs: each hardware adapter's dedicated memory, bytes):
 * adapters under DXGI_FLOOR_BYTES are not counted, the rest are summed, in GB rounded down to 0.1, as the launcher
 * sums (tools/web/launch.mjs gpuMemory); null when none counts, the sum is above VRAM_MAX_GB, or the reading is not a
 * list. Anything in it that is not a whole number of bytes up to BYTES_MAX is not counted.
 */
export function figureFromAdapters(bytes: unknown): number | null {
  if (!Array.isArray(bytes)) return null
  const kept = bytes.filter((b): b is number => Number.isSafeInteger(b) && b >= DXGI_FLOOR_BYTES && b <= BYTES_MAX)
  if (kept.length === 0) return null
  const gb = Math.floor(kept.reduce((a, b) => a + b, 0) / GIB * 10) / 10
  return gb > VRAM_MAX_GB ? null : gb
}

/** The bytes a bigger model may need by measure: the figure less RESERVE_BYTES. */
export const budgetOf = (f: Figure): number => f.gb * GIB - RESERVE_BYTES

/** Where a loaded model sits, by Ollama's /api/ps: nothing on GPUs, all of it, or between. */
export function whereOf(p: { loaded: number; gpu: number }): Where {
  return p.gpu <= 0 ? 'cpu' : p.gpu >= p.loaded ? 'gpu' : 'split'
}

/**
 * Whether a measurement fails a model. A cold wait (the first piece never came) fails only a split model. Otherwise a
 * model no bigger than the usual one fails when split and slow, a bigger one when slow.
 */
export function failed(m: { where: Where; slow: boolean }, o: { larger: boolean; cold: boolean }): boolean {
  return o.cold ? m.where === 'split' : o.larger ? m.slow : m.where === 'split' && m.slow
}

/** Today's pick (router.ts's own rule): the model kept while listed, else the default while listed, else the first text model by name. */
export function todaysPick(names: readonly string[], mine: string): string {
  return names.includes(mine) ? mine : names.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : names.find(localText) ?? mine
}

/**
 * The model auto answers with, given the figure. `listed` is Ollama's list sorted by name, so ties go to the first by
 * name. A usual model that is a certain misfit (its weights alone above the figure) or avoided steps down to the
 * largest eligible smaller one, or is stuck. Otherwise, with a measurement whose newest sat partly on the GPU and
 * `grow` still on, it steps up to the largest eligible bigger one whose need fits the budget.
 */
export function choose(i: { listed: readonly Weighed[]; usual: string; figure: Figure; seen: readonly Seen[]; avoided: ReadonlySet<string>; grow: boolean }): Choice {
  const cap = i.figure.gb * GIB
  const u = i.listed.find((m) => m.name === i.usual); const ub = u?.bytes ?? null
  const fits = (m: Weighed) => m.text && m.bytes !== null && m.bytes <= cap && !i.avoided.has(m.name)
  const largest = (ms: Weighed[]) => ms.reduce<Weighed | null>((a, m) => (a === null || m.bytes! > a.bytes! ? m : a), null)
  const misfit = ub !== null && ub > cap
  if (misfit || i.avoided.has(i.usual)) {
    const below = ub === null ? null : largest(i.listed.filter((m) => fits(m) && m.bytes! < ub))
    const cause = misfit ? 'misfit' : 'measured'
    return below ? { name: below.name, step: 'down', bytes: below.bytes, cause } : { name: i.usual, step: 'stuck', bytes: ub, cause }
  }
  const newest = i.seen.at(-1)
  if (i.grow && ub !== null && newest !== undefined && newest.gpu > 0) {
    const ratio = Math.max(1, ...i.seen.map((s) => s.loaded / s.weights))
    const need = (m: Weighed) => i.seen.find((s) => s.model === m.name)?.loaded ?? Math.ceil(m.bytes! * ratio)
    const up = largest(i.listed.filter((m) => fits(m) && m.bytes! > ub && need(m) <= budgetOf(i.figure)))
    if (up) return { name: up.name, step: 'up', bytes: up.bytes, need: need(up) }
  }
  return { name: i.usual, step: 'usual', bytes: ub }
}

/** The first-piece wait a model's weights earn, ms: a second per COLD_READ_BYTES_S bytes; nothing for an unknown size. */
export function coldWaitMs(bytes: number | null): number {
  return bytes !== null && bytes > 0 ? Math.ceil(bytes / COLD_READ_BYTES_S * 1000) : 0
}

/** The measurements with `s` in: one per server and model, the newest last, at most SEEN_MAX. */
export function remember(seen: readonly Seen[], s: Seen): Seen[] {
  return [...seen.filter((x) => x.server !== s.server || x.model !== s.model), s].slice(-SEEN_MAX)
}

/** A byte count kept between visits: a whole number above 0, at most BYTES_MAX. */
const keptBytes = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= BYTES_MAX

/** One kept measurement read back, every field checked (its server must be on this machine, as the gate spells it); null when any fails. */
function readSeen(raw: unknown): Seen | null {
  if (typeof raw !== 'object' || raw === null) return null
  const e = raw as { server?: unknown; model?: unknown; weights?: unknown; loaded?: unknown; gpu?: unknown; pace?: unknown; fails?: unknown }
  const { server, model, weights, loaded, gpu, pace, fails } = e
  if (typeof server !== 'string' || loopbackServer(server) !== server) return null
  if (typeof model !== 'string' || model.trim() === '') return null
  if (!keptBytes(weights) || !keptBytes(loaded)) return null
  if (typeof gpu !== 'number' || !Number.isSafeInteger(gpu) || gpu < 0 || gpu > loaded) return null
  if (pace !== null && (typeof pace !== 'number' || !Number.isFinite(pace) || pace < 0)) return null
  if (typeof fails !== 'number' || !Number.isInteger(fails) || fails < 0 || fails > FAILS_KEPT) return null
  return { server, model, weights, loaded, gpu, pace, fails }
}

/** What the router kept, read back: each field checked, whatever does not pass dropped; undefined for anything but an object. */
export function readFit(raw: unknown): FitKept | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const r = raw as { vram?: unknown; seen?: unknown; usual?: unknown }
  const vram = typeof r.vram === 'number' && Number.isFinite(r.vram) && r.vram >= 0 && r.vram <= VRAM_MAX_GB ? r.vram : null
  const seen = Array.isArray(r.seen) ? r.seen.map(readSeen).filter((s): s is Seen => s !== null).slice(-SEEN_MAX) : []
  const usual = typeof r.usual === 'string' && r.usual.trim() !== '' ? r.usual : undefined
  return { vram, seen, ...(usual !== undefined && { usual }) }
}

/** Starting value: the longest a longer answer may take at the pace measured, seconds (FIRST_PIECE_MS, the first wait). */
export const ANSWER_WAIT_S = FIRST_PIECE_MS / 1000
/** Starting value: the least a doubled context is taken to cost, bytes (about one 8B model's cache at 8,192 tokens). */
export const WIDEN_FLOOR_BYTES = GIB

/**
 * The larger context a model's next answers get (twice `ctx`), or null (R4). Only when the answer was cut at its answer
 * cap (reason 'length'); it reported at least PACE_TOKENS tokens and a pace at which the larger answer cap takes at most
 * ANSWER_WAIT_S; the newest measurement of the model at `ctx` this visit (`placed`) was all on the GPU and Ollama said
 * it ran at `ctx` (so its trained context is not below it); the bytes loaded there plus what doubling costs (what was
 * loaded beyond the weights, at least WIDEN_FLOOR_BYTES) fit the figure less RESERVE_BYTES; the larger context is at
 * most CONTEXT_MAX; and the model has not grown this visit (`grown`: grown once, whatever came of it).
 */
export function widen(i: { reason: string; tokens: number; pace: number | null; ctx: number; placed: Placement | null; weights: number | null; figure: Figure; grown: boolean }): number | null {
  const n = i.ctx * 2
  if (i.grown || n > CONTEXT_MAX || i.reason !== 'length') return null
  if (i.tokens < PACE_TOKENS || i.pace === null || !(i.pace * ANSWER_WAIT_S >= answerTokensFor(n))) return null
  const p = i.placed
  if (p === null || p.ctx !== i.ctx || p.gpu < p.loaded || i.weights === null) return null
  return p.loaded + Math.max(p.loaded - i.weights, WIDEN_FLOOR_BYTES) <= budgetOf(i.figure) ? n : null
}

/**
 * Why a larger context went back to the one it grew from: split, all on the processor, too slow, refused by Ollama, or
 * failed in Ollama after some of an answer arrived.
 */
export type Back = 'split' | 'cpu' | 'slow' | 'load' | 'partway'
/**
 * What the first measured answer at a grown context `ctx` (grown from `from`) says (R5): good (keep it); trained (Ollama
 * ran it at its trained context, `placed.ctx`, below `ctx`: `ctx` becomes that when it is above `from`, else `from`, and
 * nothing grows again); or back to `from` and why. Null when it says nothing: not loaded, or a first wait that ran out
 * (the model may still be loading) with the model not split.
 */
export type ContextVerdict = { readonly kind: 'good' } | { readonly kind: 'trained'; readonly trained: number; readonly ctx: number } | { readonly kind: 'back'; readonly why: Exclude<Back, 'load' | 'partway'> }
export function contextVerdict(i: { placed: Placement | null; from: number; ctx: number; slow: boolean; cold: boolean }): ContextVerdict | null {
  const p = i.placed
  if (p === null) return null
  const where = whereOf(p)
  if (i.cold) return where === 'split' ? { kind: 'back', why: 'split' } : null
  if (p.ctx !== undefined && p.ctx < i.ctx) return { kind: 'trained', trained: p.ctx, ctx: p.ctx > i.from ? p.ctx : i.from }
  if (where !== 'gpu') return { kind: 'back', why: where }
  return i.slow ? { kind: 'back', why: 'slow' } : { kind: 'good' }
}

/**
 * What became of a model's context this visit (the router keeps one per server and model it grew): grown (sent at
 * `ctx`, not yet measured there), good (measured all on the GPU at `ctx`, `loaded` bytes), or back (at `from` again,
 * `why`, after `tried`). `trained` is the trained context Ollama reported, when below the context sent.
 */
export interface Wide {
  readonly state: 'grown' | 'good' | 'back'
  readonly from: number
  readonly ctx: number
  readonly tried: number
  readonly trained?: number
  readonly loaded?: number
  readonly why?: Back | 'trained'
}

/** A whole number with comma groups, as the console writes token counts (16,384); ASCII whatever the locale. */
export const grouped = (n: number): string => String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** Bytes as the page's other sizes show them: GB of 2^30 bytes, one decimal. */
export const gbText = (bytes: number): string => `${(bytes / GIB).toFixed(1)} GB`

/** What the fit row is made from (the router's state under auto). */
export interface FitInput {
  readonly figure: Figure | null; readonly off: boolean
  readonly found: string | null; readonly chat: boolean; readonly theirs: string | null
  readonly choice: Choice | null; readonly usual: { readonly name: string; readonly bytes: number | null } | null
  readonly last: Seen | null; readonly verdict: 'big' | 'slow' | null; readonly anyAside: boolean; readonly grow: boolean
  readonly coldMs: number   // the chosen model's first-piece wait when longer than the usual one; 0 otherwise
  /** What became of the context of the model auto answers with this visit; null (or absent) while nothing grew. */
  readonly context?: (Wide & { readonly model: string }) | null
}

/** The fit row's clause on the context of the model auto answers with (R4, R5), once it grew. */
function contextLine(w: Wide & { readonly model: string }): string {
  const n = grouped
  const at = (ctx: number): string => `${n(ctx)} tokens of context`
  const measuredAt = w.loaded !== undefined ? ` (measured ${gbText(w.loaded)} loaded at that context, all on the GPU)` : ''
  if (w.state === 'back') {
    if (w.why === 'trained') return `${w.model} was trained on ${at(w.trained ?? w.from)}, so it stays at ${n(w.from)} for this visit`
    const why = w.why === 'split' ? 'did not fit the GPU (some of it ran on the processor)' : w.why === 'cpu' ? 'did not fit the GPU (all of it ran on the processor)' : w.why === 'slow' ? 'was too slow here' : w.why === 'partway' ? 'failed partway through an answer in Ollama' : 'would not load in Ollama'
    return `${at(w.tried)} ${why}, so ${w.model} stays at ${n(w.from)} for this visit`
  }
  if (w.trained !== undefined) return `${w.model} was trained on ${at(w.trained)}, so it runs at that with answers of up to ${n(answerTokensFor(w.ctx))}${measuredAt}`
  if (w.state === 'good') return `${w.model} runs at ${at(w.ctx)} with answers of up to ${n(answerTokensFor(w.ctx))}${measuredAt}`
  return `an answer was cut at ${n(answerTokensFor(w.from))} tokens, so ${w.model} gets ${at(w.ctx)} and answers of up to ${n(answerTokensFor(w.ctx))} from its next answer, which is measured`
}

/** A measurement in words: how much was loaded, where, how fast, and what it says. */
function measured(last: Seen, verdict: 'big' | 'slow' | null): string {
  const where = whereOf(last)
  const place = where === 'cpu' ? 'all on the processor' : where === 'gpu' ? 'all on the GPU' : `${Math.round(last.gpu / last.loaded * 100)}% on the GPU, the rest on the processor`
  const pace = last.pace !== null ? `, ${last.pace.toFixed(1)} tokens a second` : ''
  const said = verdict === 'big' ? ': too big for this GPU' : verdict === 'slow' ? ': too slow here' : ''
  return `${last.model} measured ${gbText(last.loaded)} loaded, ${place}${pace}${said}`
}

/**
 * The console's fit row (ask, under auto): the figure and where it came from, what was measured, which model auto
 * answers with and why, what became of its context once it grew, and the way back. Undefined with no figure (but off
 * at the console, which says so). ASCII.
 */
export function fitLine(i: FitInput): string | undefined {
  if (i.off) return "off at the console (ask vram 0): auto keeps its usual model (ask vram auto hands sizing back to the page's address or the Windows app)"
  const f = i.figure
  if (f === null) return undefined
  const gb = f.gb.toFixed(1)
  const fig = f.from === 'ask' ? `${gb} GB given at the console (ask vram)` : f.from === 'address' ? `${gb} GB given by the page's address (vram=)` : `${gb} GB read from the GPUs by the Windows app`
  if (i.found !== null && i.found !== 'ollama') return `${fig}; auto sizes only a model Ollama lists (${i.found} answers now)`
  // Nothing found yet (before the first look, or a look that found no server): no model to size, no measurement to come.
  if (i.found === null && i.choice === null) return `${fig}; auto sizes Ollama's model once a look finds Ollama on this machine`
  if (i.chat) return `${fig}; auto sizes Ollama's model only in the generate format (ask api generate)`
  const meas = i.last !== null ? measured(i.last, i.verdict) : null
  if (i.theirs !== null) {
    const yours = `${fig}; the model is yours (ask model chose it): auto sizes only a model it chose (ask model auto hands it back)`
    return meas !== null && i.last?.model === i.theirs ? `${yours}; ${meas}` : yours
  }
  const parts = [fig]
  const c = i.choice
  if (c?.cause === 'misfit' && i.usual !== null && i.usual.bytes !== null) parts.push(`${i.usual.name} has ${gbText(i.usual.bytes)} of weights alone, more than the GPU's ${gb} GB`)
  if (meas !== null) parts.push(meas)
  if (c === null || (c.step === 'usual' && i.last === null)) parts.push('the next answer is measured before auto picks bigger')
  else if (c.step === 'usual' && i.grow) parts.push(`nothing bigger that Ollama lists fits by what was measured, so auto keeps ${c.name}`)
  else if (c.step === 'usual') parts.push(`auto keeps ${c.name} for the rest of this visit`)
  else if (c.step === 'up') {
    const m = Math.max(1, Math.ceil(i.coldMs / 60_000))
    const cold = i.coldMs > 0 ? `; its first answer may wait up to ${m} minute${m === 1 ? '' : 's'} while Ollama reads it` : ''
    parts.push(`auto answers with ${c.name}, the largest that fits by what was measured (${gbText(c.bytes ?? 0)} of weights, about ${gbText(c.need ?? 0)} loaded by that measure${cold}; ask model <name> keeps another)`)
  } else if (c.step === 'down') parts.push(`auto answers with ${c.name}, the largest smaller one Ollama lists (ask model <name> keeps another)`)
  else parts.push(`Ollama lists nothing smaller that fits, so auto keeps ${i.usual?.name ?? c.name}`)
  if (i.context) parts.push(contextLine(i.context))
  if (c?.step === 'down' || c?.step === 'stuck' || i.anyAside) parts.push(f.from === 'ask' ? `ask vram ${f.gb} measures afresh` : 'ask vram auto measures afresh')
  return parts.join('; ')
}
