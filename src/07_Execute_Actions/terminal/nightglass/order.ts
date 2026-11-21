// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the ordering checker of the specification. Work on a queue starts in order but may
 * overlap, so a read of what an earlier command wrote, a write over what an earlier command read or wrote, and a
 * change of an image's layout each need a barrier or a semaphore that says so. When the instance checks, every submit
 * is simulated here, command by command, against what the device's queues have already been given (each buffer
 * whole, each image by level and layer), before anything reaches the back end; a submit that leaves a hazard or uses
 * an image in the wrong layout is refused with a Fault that names the command, the resource and the barrier or layout
 * it lacks. It also says whether the host may take a range of memory back with `invalidate()`.
 * What breaks if it is removed? A missing barrier would draw correctly on the reference renderer, which runs every
 * command at once, and wrongly or differently on a GPU, and nothing would tell the app which command was at fault.
 *
 * THE MODEL (the spec's, pinned by order.test.ts). Each unit (a buffer, or one level of one layer of an image) keeps
 * its last write (the stage and access, or the image barrier that moved it), the (stage, access) pairs that write
 * has been made visible to, the latest read at each stage since that write with the stages ordered after it, and
 * for an image its layout, which starts at `blank`.
 * - A read at (stage, access) needs no write yet, or the last write made visible to (stage, access).
 * - A write needs the same, and every read since the last write ordered before its stage.
 * - A barrier whose before covers a write's own stage and access makes it visible to every (stage, access) of its
 *   after; one whose before covers a read's stage orders the stages of its after after that read. There is no chain
 *   through an earlier barrier's after: the before names the write or the read itself.
 * - Stages: `all` covers every stage, `top` and `bottom` none. Accesses: `any-read` covers every read access and
 *   `any-write` every write access. The reads are READ_ACCESSES and the writes WRITE_ACCESSES below.
 * - An image barrier whose from differs from its to is a move. Its from must be the layout of every unit it covers,
 *   or `blank` (the contents are thrown away). Its before must cover the last write (stage and access) and every
 *   read since (stage), and the move is then itself the last write, made visible to its after. A later barrier
 *   covers a move when its before names one of the move's after stages, or is `all` (the one cover of a move whose
 *   after names only `top` or `bottom`). An image barrier whose from equals its to moves nothing: it checks the
 *   layout and acts as a buffer barrier does.
 * - A memory barrier acts on every unit; a buffer barrier, whatever its range, on the whole buffer.
 * - Each command's accesses are checked against the state before it; a command does not conflict with itself.
 * - A semaphore wait makes every write made up to the signal it takes visible to every access of its stages, and
 *   orders every read made up to that signal before them. Writes after the signal are not covered.
 * - Work being done (the back end calling `done`) makes nothing visible: the state carries over from submit to submit.
 * - Inside a pass, the attachments are touched once, when the pass begins, and no draw may bind, through an image
 *   binding, a level and layer that is an attachment of the pass (a read-only depth attachment included). A write by
 *   one draw and a read or write by a later draw of the same pass is a hazard, since a barrier cannot sit in a pass.
 * - `invalidate()`: for each buffer bound in the range, no submit that writes it is still in flight, and its last
 *   write is visible to (host, host-read).
 *
 * What each command touches (stage, access, and the layouts an image may be in):
 * - pass: each colour attachment at color: color-read when loaded with keep, and color-write; layout color. Its
 *   resolve view at color: color-write; layout color. The depth attachment at depth: depth-read, and depth-write
 *   unless read-only; layout depth, or depth-read when read-only.
 * - draw: vertex buffers at vertex-input (vertex-read); the index buffer at vertex-input (index-read); an indirect
 *   buffer at indirect (indirect-read); each binding at each of vertex and fragment its layout entry lists.
 * - dispatch: each binding whose entry lists compute, at compute; an indirect buffer at indirect (indirect-read).
 * - bindings: uniform uniform-read; storage-read shader-read; storage shader-read and shader-write; image
 *   shader-read in layout shader-read or general (or depth-read for a depth format); storage image shader-write in
 *   layout general; a sampler nothing.
 * - copies, update, zero: the source at copy (copy-read), in layout copy-src or general; the destination at copy
 *   (copy-write), in layout copy-dst or general.
 * For each access of a command its layout is checked, then its hazard. An image attached to a pass and also bound in
 * it never reaches the checker: commands.ts refuses that as a usage-scope conflict when the draw is recorded.
 *
 * HOW THE STATE IS KEPT (order.test.ts runs it at scales where a state per unit, or a barrier applied to every unit,
 * would take minutes to hours). A unit's state is never changed once made: a command or barrier makes one new state for
 * each state the units it changes were in, so units changed together (the layers of an array one barrier moves) share
 * one. A resource's units are kept as one state and the units that differ from it: a resource never touched costs
 * nothing, and one always touched whole costs one state. Memory barriers and semaphore waits act on every unit, so they
 * are not applied to units at all but kept in a ledger by kind of write and read: for each kind of write (a command's
 * stage and write access, or a stage a move's after names) and each place (stage, access), the clock of the last memory
 * barrier that made such a write visible there; for each pair of stages, the clock of the last one that ordered the
 * second after a read at the first; and for each stage, the latest submission a wait made visible to it. Every command
 * simulated takes the next number on the device's clock, so a unit's last write is visible to (stage, access) when its
 * own barriers made it so (the unit's state says), or a memory barrier later on the clock covers its kind, or a wait
 * covers its submission; a read is ordered before a stage likewise. The clocks of writes are kept in parts (see
 * Ledger), so a barrier that covers every kind of write, or makes them visible at every place, sets one clock per place
 * or per kind it names, or one in all, rather than one for each pair of kind and place.
 * A memory barrier or a wait then costs the same however many units the device has state for, a command costs what
 * it touches, and a check of one unit costs the same however many barriers came before it.
 * The state lives per device. A submit is simulated on copies of what it changes (the states of the resources it
 * touches, the parts of the ledger it changes); they replace the device's only when the queue commits the submit, and
 * are put back if the back end refuses it. Once the back end has taken it, the submit keeps only the buffers it
 * writes, for invalidate(), until its work is done.
 */
import type { Access, Buffer, Image, ImageLayout, PipeStage, Range, View } from './api.ts'
import type { BoundSet, CommandListImpl, FullScope, Recorded } from './commands.ts'
import { fail } from './fault.ts'
import { FORMATS } from './formats.ts'
import type { Stage } from './lens.ts'
import type { MemoryImpl } from './memory.ts'
import { BufferImpl } from './resources.ts'
import type { ImageImpl, ViewImpl } from './resources.ts'
import type { Core, SemaphoreImpl } from './sync.ts'

/** The stages work runs at; `top`, `bottom` and `all` name sets of them. */
export const ORDER_STAGES: readonly PipeStage[] = Object.freeze(['indirect', 'vertex-input', 'vertex', 'fragment', 'depth', 'color', 'compute', 'copy', 'host'])
/** The accesses that read. `any-read` stands for all of them. */
export const READ_ACCESSES: readonly Access[] = Object.freeze(['indirect-read', 'index-read', 'vertex-read', 'uniform-read', 'shader-read', 'color-read', 'depth-read', 'copy-read', 'host-read'])
/** The accesses that write. `any-write` stands for all of them. */
export const WRITE_ACCESSES: readonly Access[] = Object.freeze(['shader-write', 'color-write', 'depth-write', 'copy-write', 'host-write'])

const ACCESS_LIST: readonly Access[] = [...READ_ACCESSES, ...WRITE_ACCESSES]
const N = ORDER_STAGES.length
const EVERY_STAGE = (1 << N) - 1
/** Marks only a move carries: its after named `top` or `bottom`. Only `all` covers them. */
const TOP = 1 << N
const BOTTOM = TOP << 1
const ALL = EVERY_STAGE | TOP | BOTTOM
const READ_BITS = (1 << READ_ACCESSES.length) - 1
const EVERY_ACCESS = (1 << ACCESS_LIST.length) - 1
const WRITE_BITS = EVERY_ACCESS & ~READ_BITS

const stageAt = (s: PipeStage): number => ORDER_STAGES.indexOf(s)
const accessAt = (a: Access): number => ACCESS_LIST.indexOf(a)

// The ledger (see the head of the file and Ledger below).
const NR = READ_ACCESSES.length
const NA = ACCESS_LIST.length
/** The marks a move's after leaves: one per stage, then TOP and BOTTOM. */
const MARKS = N + 2
/** The kinds of write: a command's (stage, write access), then each mark a move's after leaves. */
const KINDS = N * (NA - NR) + MARKS
/** The places a write is made visible at: (stage, access). */
const PLACES = N * NA
/** The kind of a command's write at stage w with write access x. */
const kindOf = (w: number, x: number): number => w * (NA - NR) + x - NR
/** The kind of a move whose after carries mark m. */
const markKind = (m: number): number => N * (NA - NR) + m
const placeOf = (s: number, a: number): number => s * NA + a

/** The bits of a mask below bit n, lowest first. */
function bitsOf(mask: number, n: number): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) if ((mask & (1 << i)) !== 0) out.push(i)
  return out
}

/** The stages a scope covers: `all` every one (and a move's marks), `top` and `bottom` none. */
function covered(stages: readonly PipeStage[]): number {
  let m = 0
  for (const s of stages) m |= s === 'all' ? ALL : s === 'top' || s === 'bottom' ? 0 : 1 << stageAt(s)
  return m
}

/** What a move's after leaves for a later barrier to cover: its stages, with `top` and `bottom` as marks. */
function marked(stages: readonly PipeStage[]): number {
  let m = 0
  for (const s of stages) m |= s === 'all' ? ALL : s === 'top' ? TOP : s === 'bottom' ? BOTTOM : 1 << stageAt(s)
  return m
}

/** The accesses a scope covers: `any-read` every read, `any-write` every write. */
function accessed(access: readonly Access[]): number {
  let m = 0
  for (const a of access) m |= a === 'any-read' ? READ_BITS : a === 'any-write' ? WRITE_BITS : 1 << accessAt(a)
  return m
}

/** The names of the stages in a mask, joined for a message. */
function stageNames(mask: number): string {
  const names = ORDER_STAGES.filter((_, i) => (mask & (1 << i)) !== 0)
  return names.length === 0 ? 'all' : names.join(' or ')
}

// ---------------------------------------------------------------------------------------------------
// State

/** A command, as a write or read remembers it. */
interface Origin {
  /** The name of its list, its position in the list's commands and its kind. */
  readonly list: string
  readonly at: number
  readonly c: string
  /** The pass it ran in (one token per pass run), or null outside a pass. */
  readonly pass: object | null
  /** The submission it ran in, counted on the device's timeline from 1. */
  readonly serial: number
  /** Its number on the device's clock: each command simulated takes the next one, from 1. */
  readonly tick: number
}

interface Move {
  readonly from: ImageLayout
  readonly to: ImageLayout
  /** The stages of its after (see marked()). */
  readonly marks: number
}

interface Write {
  readonly by: Origin
  /** The stage and access (indices) of a command's write; unused for a move. */
  readonly stage: number
  readonly access: number
  readonly move: Move | null
}

interface Read {
  readonly by: Origin
  readonly access: number
  /** The stages ordered after the read by its own barriers (the ledger holds what memory barriers and waits did). */
  readonly after: number
}

/** One unit's state, never changed once made: units a command or barrier changes together share the new one. */
interface Unit {
  readonly write: Write | null
  /** For each stage, the accesses its own barriers made the last write visible to (the ledger holds the rest). */
  readonly seen: readonly number[]
  /** For each stage, the latest read there since the last write. */
  readonly reads: readonly (Read | null)[]
  readonly layout: ImageLayout
}

/** The states of a resource's units: `rest` for each unit that `some` does not list. */
interface Spread {
  rest: Unit
  some: Map<number, Unit> | null
}

type Resource = BufferImpl | ImageImpl

const NO_SEEN: readonly number[] = Object.freeze(new Array<number>(N).fill(0))
const NO_READS: readonly (Read | null)[] = Object.freeze(new Array<Read | null>(N).fill(null))
const FRESH: Unit = Object.freeze({ write: null, seen: NO_SEEN, reads: NO_READS, layout: 'blank' as ImageLayout })

/**
 * What the memory barriers and waits so far did. A memory barrier covers some kinds of write and makes them visible at
 * some places, and its clock goes into the one part that holds exactly that: `every` when it covers every kind and
 * every place, `toPlace` when every kind and some places, `ofKind` when some kinds and every place, and otherwise the
 * rows of `rows`, one per kind, each made when first written. A write of a kind is visible at a place through the
 * memory barriers when any of the four holds a clock there later than the write's. `reads` holds, for stages r and s
 * (at r * N + s), the clock of the last memory barrier that ordered s after a read at r, and `waits`, for each stage,
 * the latest submission a wait made visible to it and whose reads it ordered before it. A ledger a device holds is
 * never changed: a submit changes copies of the parts it changes.
 */
interface Ledger {
  every: number
  toPlace: Float64Array
  ofKind: Float64Array
  rows: (Float64Array | null)[]
  reads: Float64Array
  waits: Float64Array
}

/** The ledger before any memory barrier or wait; never changed, as no ledger a device holds is. */
const BLANK: Ledger = Object.freeze({
  every: 0,
  toPlace: new Float64Array(PLACES),
  ofKind: new Float64Array(KINDS),
  rows: new Array<Float64Array | null>(KINDS).fill(null),
  reads: new Float64Array(N * N),
  waits: new Float64Array(N),
})

/** What a device's queues have been given, as of the last committed submit. */
class Timeline {
  /** The states of each resource's units; a Spread here is never changed (a submit changes its own copy). */
  readonly units = new WeakMap<Resource, Spread>()
  /** For each armed semaphore, the submission that signalled it. */
  readonly signals = new WeakMap<SemaphoreImpl, number>()
  /** For each buffer, the submits in flight that write it. */
  readonly writing = new Map<BufferImpl, number>()
  serial = 0
  /** The clock of the last command simulated. */
  clock = 0
  /** What the memory barriers and waits so far did, by kind of write and read; never changed (a submit changes copies). */
  ledger: Ledger = BLANK
}

const timelines = new WeakMap<Core, Timeline>()

function timelineOf(core: Core): Timeline {
  let t = timelines.get(core)
  if (t === undefined) {
    t = new Timeline()
    timelines.set(core, t)
  }
  return t
}

// The records name resources by their api types; commands.ts only ever stores the core's classes there.
const asBuffer = (b: Buffer): BufferImpl => b as BufferImpl
const asImage = (i: Image): ImageImpl => i as ImageImpl
const imageOf = (v: View): ImageImpl => (v as ViewImpl).image

function unitName(r: Resource, i: number): string {
  if (r instanceof BufferImpl) return r.name
  return `level ${Math.floor(i / r.layers)} layer ${i % r.layers} of ${r.name}`
}

/** The units of an image's levels and layers, level by level. */
function unitsIn(img: ImageImpl, levels: Range, layers: Range): number[] {
  const out: number[] = []
  for (let l = levels.base; l < levels.base + levels.count; l++) for (let y = layers.base; y < layers.base + layers.count; y++) out.push(l * img.layers + y)
  return out
}

const origin = (by: Origin): string => `${by.list} command ${by.at} (${by.c})`

function describe(w: Write): string {
  return w.move === null
    ? `at ${ORDER_STAGES[w.stage]} (${ACCESS_LIST[w.access]}) by ${origin(w.by)}`
    : `the move from ${w.move.from} to ${w.move.to} by ${origin(w.by)}`
}

/** What a before scope must cover to cover the write. */
const coverOf = (w: Write): string => (w.move === null ? `${ORDER_STAGES[w.stage]} and ${ACCESS_LIST[w.access]}` : stageNames(w.move.marks))

/** A barrier's two scopes as masks, and the marks a move by it leaves. */
interface Edge {
  readonly before: number
  readonly beforeAccess: number
  readonly after: number
  readonly afterAccess: number
  readonly marks: number
}

const edgeOf = (b: { readonly before: FullScope; readonly after: FullScope }): Edge => ({
  before: covered(b.before.stages),
  beforeAccess: accessed(b.before.access),
  after: covered(b.after.stages) & EVERY_STAGE,
  afterAccess: accessed(b.after.access),
  marks: marked(b.after.stages),
})

function coversWrite(e: Edge, w: Write): boolean {
  return w.move === null ? (e.before & (1 << w.stage)) !== 0 && (e.beforeAccess & (1 << w.access)) !== 0 : (e.before & w.move.marks) !== 0
}

/** What a barrier that moves nothing makes of a unit: the last write made visible to its after, covered reads ordered before it. */
function widened(u: Unit, e: Edge): Unit {
  let seen: number[] | null = null
  if (u.write !== null && coversWrite(e, u.write)) {
    for (let s = 0; s < N; s++) {
      if ((e.after & (1 << s)) === 0 || (u.seen[s] & e.afterAccess) === e.afterAccess) continue
      seen ??= u.seen.slice()
      seen[s] |= e.afterAccess
    }
  }
  let reads: (Read | null)[] | null = null
  for (let s = 0; s < N; s++) {
    const rd = u.reads[s]
    if (rd === null || (e.before & (1 << s)) === 0 || (rd.after & e.after) === e.after) continue
    reads ??= u.reads.slice()
    reads[s] = { by: rd.by, access: rd.access, after: rd.after | e.after }
  }
  return seen === null && reads === null ? u : { write: u.write, seen: seen ?? u.seen, reads: reads ?? u.reads, layout: u.layout }
}

/**
 * Whether a unit's last write is visible to (stage s, access a): by its own barriers, by a memory barrier later on the
 * clock that covers its kind, or by a wait that covers its submission.
 */
function visible(ledger: Ledger, u: Unit, s: number, a: number): boolean {
  const w = u.write
  if (w === null || (u.seen[s] & (1 << a)) !== 0 || w.by.serial <= ledger.waits[s]) return true
  const t = w.by.tick
  const d = placeOf(s, a)
  if (ledger.every > t || ledger.toPlace[d] > t) return true
  if (w.move === null) return later(ledger, kindOf(w.stage, w.access), d, t)
  for (let m = 0; m < MARKS; m++) if ((w.move.marks & (1 << m)) !== 0 && later(ledger, markKind(m), d, t)) return true
  return false
}

/** Whether a memory barrier later than clock t made writes of kind k visible at place d, by the parts of that kind. */
function later(ledger: Ledger, k: number, d: number, t: number): boolean {
  if (ledger.ofKind[k] > t) return true
  const row = ledger.rows[k]
  return row !== null && row[d] > t
}

/** Whether a read at stage r is ordered before stage s: by its own barriers, a later memory barrier, or a wait. */
function ordered(ledger: Ledger, rd: Read, r: number, s: number): boolean {
  return (rd.after & (1 << s)) !== 0 || rd.by.serial <= ledger.waits[s] || ledger.reads[r * N + s] > rd.by.tick
}

// ---------------------------------------------------------------------------------------------------
// Simulation

/** One submission as the queue read it: its waits, its lists (each with the place a refusal names) and its signals. */
export interface Step {
  readonly waits: readonly { readonly semaphore: SemaphoreImpl; readonly stages: readonly PipeStage[] }[]
  readonly lists: readonly { readonly list: CommandListImpl; readonly at: string }[]
  readonly signals: readonly SemaphoreImpl[]
}

/** A simulated submit the queue commits, then settles when the back end is done with it or refused it. */
export interface Plan {
  /** Makes the simulated state the device's. */
  commit(): void
  /** The back end took the submit, so it will not be undone: the plan lets go of all but the buffers it writes. */
  accepted(): void
  /** The work is done (`ran`), or the back end refused it and the commit is undone. */
  settle(ran: boolean): void
}

/** One access a command makes of some units of a resource. */
interface Touch {
  readonly res: Resource
  readonly units: readonly number[]
  readonly stage: number
  readonly access: number
  readonly write: boolean
  /** The layouts an image may be in for it; null for a buffer. */
  readonly layouts: readonly ImageLayout[] | null
  /** What the command touches it as, for a message: `vertex buffer 0`, `binding 1 of set 0`. */
  readonly what: string
}

/** The command being simulated: its origin and the words a refusal starts with. */
interface Cmd {
  readonly by: Origin
  readonly name: string
}

const COPY_SRC: readonly ImageLayout[] = ['copy-src', 'general']
const COPY_DST: readonly ImageLayout[] = ['copy-dst', 'general']
const SAMPLED: readonly ImageLayout[] = ['shader-read', 'general']
const SAMPLED_DEPTH: readonly ImageLayout[] = ['shader-read', 'general', 'depth-read']
const DRAW_STAGES: readonly Stage[] = ['vertex', 'fragment']
const DISPATCH_STAGES: readonly Stage[] = ['compute']

class Run implements Plan {
  private readonly tl: Timeline
  /** The states of the resources the submit changed: its own copies, made the first time it changes each. */
  private readonly units = new Map<Resource, Spread>()
  private readonly signals = new Map<SemaphoreImpl, number>()
  /** Buffers the submit writes, which invalidate() waits on while it is in flight. */
  private readonly wrote = new Set<BufferImpl>()
  private serial: number
  private clock: number
  /** The device's ledger until the submit first changes it, then the submit's own, sharing the parts it did not change. */
  private ledger: Ledger
  /** The parts of the ledger the submit copied, so are its own to change. */
  private readonly made = new Set<object>()
  /**
   * The clock of the last command that made a write or a read, and the clock each memory barrier (by its scopes) was
   * last put in the ledger at: one put there again with nothing written or read since changes nothing, so is skipped.
   */
  private touched = 0
  private readonly granted = new Map<number, number>()
  /** The pass being simulated: a token its commands share. */
  private pass: object | null = null
  /** What commit() replaced, for settle(false) to put back. */
  private saved: {
    readonly serial: number
    readonly clock: number
    readonly ledger: Ledger
    readonly units: readonly (readonly [Resource, Spread | undefined])[]
    readonly signals: readonly (readonly [SemaphoreImpl, number | undefined])[]
  } | null = null

  constructor(tl: Timeline) {
    this.tl = tl
    this.serial = tl.serial
    this.clock = tl.clock
    this.ledger = tl.ledger
  }

  // -------------------------------------------------------------------------------------------------
  // The plan

  commit(): void {
    const tl = this.tl
    this.saved = {
      serial: tl.serial,
      clock: tl.clock,
      ledger: tl.ledger,
      units: [...this.units.keys()].map((r) => [r, tl.units.get(r)] as const),
      signals: [...this.signals.keys()].map((s) => [s, tl.signals.get(s)] as const),
    }
    for (const [r, us] of this.units) tl.units.set(r, us)
    for (const [s, n] of this.signals) tl.signals.set(s, n)
    tl.serial = this.serial
    tl.clock = this.clock
    tl.ledger = this.ledger
    for (const b of this.wrote) tl.writing.set(b, (tl.writing.get(b) ?? 0) + 1)
  }

  accepted(): void {
    // Only settle(true) can follow, and it needs only the buffers written: an in-flight submit holds nothing else.
    this.saved = null
    this.units.clear()
    this.signals.clear()
    this.granted.clear()
    this.made.clear()
    this.ledger = BLANK
  }

  settle(ran: boolean): void {
    const tl = this.tl
    for (const b of this.wrote) {
      const n = (tl.writing.get(b) ?? 1) - 1
      if (n === 0) tl.writing.delete(b)
      else tl.writing.set(b, n)
    }
    const saved = this.saved
    if (ran || saved === null) return
    tl.serial = saved.serial
    tl.clock = saved.clock
    tl.ledger = saved.ledger
    for (const [r, us] of saved.units) {
      if (us === undefined) tl.units.delete(r)
      else tl.units.set(r, us)
    }
    for (const [s, n] of saved.signals) {
      if (n === undefined) tl.signals.delete(s)
      else tl.signals.set(s, n)
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Submissions

  submission(step: Step): void {
    this.serial++
    for (const w of step.waits) this.wait(w.semaphore, w.stages)
    for (const { list, at } of step.lists) {
      for (const rec of list.records) {
        if (rec.r === 'pass') this.pass = {}
        const c = list.commands[rec.at].c
        const by: Origin = { list: list.name, at: rec.at, c, pass: this.pass, serial: this.serial, tick: ++this.clock }
        this.command(rec, { by, name: `${at}: ${list.name} command ${rec.at} (${c})` })
        if (rec.r === 'end-pass') this.pass = null
      }
    }
    for (const s of step.signals) this.signals.set(s, this.serial)
  }

  /** Calls `check` once for each state the units are in, at the first of them in it: a check reads only the state. */
  private eachState(r: Resource, units: readonly number[], check: (u: Unit, i: number) => void): void {
    const { rest, some } = this.units.get(r) ?? this.tl.units.get(r) ?? { rest: FRESH, some: null }
    if (some === null) {
      if (units.length > 0) check(rest, units[0])
      return
    }
    const done = new Set<Unit>()
    for (const i of units) {
      const u = some.get(i) ?? rest
      if (done.has(u)) continue
      done.add(u)
      check(u, i)
    }
  }

  /**
   * Gives each of the units the state `next` makes of its own, calling it once for each state they are in, so that
   * units that shared a state share the new one. The resource's states are copied out of the device's the first time.
   */
  private change(r: Resource, units: readonly number[], next: (u: Unit) => Unit): void {
    let sp = this.units.get(r)
    if (sp === undefined) {
      const was = this.tl.units.get(r)
      sp = was === undefined ? { rest: FRESH, some: null } : { rest: was.rest, some: was.some === null ? null : new Map(was.some) }
      this.units.set(r, sp)
    }
    const made = new Map<Unit, Unit>()
    const map = (u: Unit): Unit => {
      let n = made.get(u)
      if (n === undefined) {
        n = next(u)
        made.set(u, n)
      }
      return n
    }
    if (units.length === (r instanceof BufferImpl ? 1 : r.levels * r.layers)) {
      // Every unit (the lists never repeat one): the states that differ from the new rest are all that is kept.
      const rest = map(sp.rest)
      let some: Map<number, Unit> | null = null
      if (sp.some !== null) {
        for (const [i, u] of sp.some) {
          const n = map(u)
          if (n !== rest) (some ??= new Map()).set(i, n)
        }
      }
      sp.rest = rest
      sp.some = some
      return
    }
    for (const i of units) {
      const n = map(sp.some?.get(i) ?? sp.rest)
      if (n !== sp.rest) (sp.some ??= new Map()).set(i, n)
      else sp.some?.delete(i)
    }
    if (sp.some?.size === 0) sp.some = null
  }

  /** The ledger, for this submit to change: the device's shell copied the first time, its parts as part() and row() need. */
  private mine(): Ledger {
    if (this.ledger === this.tl.ledger) this.ledger = { ...this.tl.ledger }
    return this.ledger
  }

  /** A part of the ledger, for this submit to change: copied the first time. */
  private part(name: 'toPlace' | 'ofKind' | 'reads' | 'waits'): Float64Array {
    const ledger = this.mine()
    let p = ledger[name]
    if (!this.made.has(p)) {
      p = p.slice()
      ledger[name] = p
      this.made.add(p)
    }
    return p
  }

  /** The row of a kind, for this submit to change: made or copied the first time, as is the list of rows. */
  private row(k: number): Float64Array {
    const ledger = this.mine()
    if (!this.made.has(ledger.rows)) {
      ledger.rows = ledger.rows.slice()
      this.made.add(ledger.rows)
    }
    let row = ledger.rows[k]
    if (row === null || !this.made.has(row)) {
      row = row === null ? new Float64Array(PLACES) : row.slice()
      ledger.rows[k] = row
      this.made.add(row)
    }
    return row
  }

  /** A wait: the submissions up to its signal made visible to its stages, their reads ordered before them. */
  private wait(sem: SemaphoreImpl, stages: readonly PipeStage[]): void {
    const upTo = this.signals.get(sem) ?? this.tl.signals.get(sem) ?? 0
    const w = covered(stages) & EVERY_STAGE
    for (let s = 0; s < N; s++) if ((w & (1 << s)) !== 0 && this.ledger.waits[s] < upTo) this.part('waits')[s] = upTo
  }

  /**
   * A memory barrier: its command's clock, for each pair of a stage its before covers and one its after names, and for
   * the kinds of write its before covers at the places its after names, in the one part of the ledger that holds them.
   */
  private grant(e: Edge, tick: number): void {
    // The four masks as one number: 11 + 14 + 9 + 14 bits, well inside a double's 53.
    const key = ((e.before * (1 << NA) + e.beforeAccess) * (1 << N) + e.after) * (1 << NA) + e.afterAccess
    if (e.after === 0 || (this.granted.get(key) ?? 0) > this.touched) return
    this.granted.set(key, tick)
    const stages = bitsOf(e.after, N)
    if ((e.before & EVERY_STAGE) !== 0) {
      const reads = this.part('reads')
      for (let r = 0; r < N; r++) if ((e.before & (1 << r)) !== 0) for (const s of stages) reads[r * N + s] = tick
    }
    if ((e.before & ALL) === 0 || (e.afterAccess & EVERY_ACCESS) === 0) return
    const everyKind = (e.before & ALL) === ALL && (e.beforeAccess & WRITE_BITS) === WRITE_BITS
    const everyPlace = e.after === EVERY_STAGE && (e.afterAccess & EVERY_ACCESS) === EVERY_ACCESS
    if (everyKind && everyPlace) {
      this.mine().every = tick
      return
    }
    const places: number[] = []
    if (!everyPlace) for (const s of stages) for (const a of bitsOf(e.afterAccess, NA)) places.push(placeOf(s, a))
    const kinds: number[] = []
    if (!everyKind) {
      for (let w = 0; w < N; w++) {
        if ((e.before & (1 << w)) !== 0) for (let x = NR; x < NA; x++) if ((e.beforeAccess & (1 << x)) !== 0) kinds.push(kindOf(w, x))
      }
      for (let m = 0; m < MARKS; m++) if ((e.before & (1 << m)) !== 0) kinds.push(markKind(m))
    }
    if (everyKind) {
      const toPlace = this.part('toPlace')
      for (const d of places) toPlace[d] = tick
    } else if (everyPlace) {
      const ofKind = this.part('ofKind')
      for (const k of kinds) ofKind[k] = tick
    } else {
      for (const k of kinds) {
        const row = this.row(k)
        for (const d of places) row[d] = tick
      }
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Commands

  private command(rec: Recorded, cmd: Cmd): void {
    switch (rec.r) {
      case 'pass':
        this.run(this.passTouches(rec), cmd)
        return
      case 'end-pass':
        return
      case 'draw': {
        const t: Touch[] = []
        for (const v of rec.vertices) t.push(this.buffer(v.buffer, 'vertex-input', 'vertex-read', false, `vertex buffer ${v.slot}`))
        if (rec.indices !== null) t.push(this.buffer(rec.indices.buffer, 'vertex-input', 'index-read', false, 'the index buffer'))
        if (rec.indirect !== null) t.push(this.buffer(rec.indirect.buffer, 'indirect', 'indirect-read', false, 'the indirect buffer'))
        this.run([...t, ...this.bindings(rec.sets, DRAW_STAGES)], cmd)
        return
      }
      case 'dispatch': {
        const t = this.bindings(rec.sets, DISPATCH_STAGES)
        if (rec.indirect !== null) t.push(this.buffer(rec.indirect.buffer, 'indirect', 'indirect-read', false, 'the indirect buffer'))
        this.run(t, cmd)
        return
      }
      case 'copy-buffer':
        this.run([this.buffer(rec.src, 'copy', 'copy-read', false, 'the source'), this.buffer(rec.dst, 'copy', 'copy-write', true, 'the destination')], cmd)
        return
      case 'copy-buffer-image':
        this.run([this.buffer(rec.src, 'copy', 'copy-read', false, 'the source'), this.image(asImage(rec.dst), rec.regions.map((x) => x.region), 'copy-write', true, 'the destination')], cmd)
        return
      case 'copy-image-buffer':
        this.run([this.image(asImage(rec.src), rec.regions.map((x) => x.region), 'copy-read', false, 'the source'), this.buffer(rec.dst, 'copy', 'copy-write', true, 'the destination')], cmd)
        return
      case 'copy-image':
        this.run([this.image(asImage(rec.src), rec.regions.map((x) => x.from), 'copy-read', false, 'the source'), this.image(asImage(rec.dst), rec.regions.map((x) => x.to), 'copy-write', true, 'the destination')], cmd)
        return
      case 'update':
      case 'zero':
        this.run([this.buffer(rec.dst, 'copy', 'copy-write', true, 'the destination')], cmd)
        return
      case 'barrier':
        this.barrier(rec, cmd)
    }
  }

  private buffer(b: Buffer, stage: PipeStage, access: Access, write: boolean, what: string): Touch {
    return { res: asBuffer(b), units: [0], stage: stageAt(stage), access: accessAt(access), write, layouts: null, what }
  }

  /** A copy's access of the levels and layers its regions cover. */
  private image(img: ImageImpl, regions: readonly { readonly level: number; readonly layer: number }[], access: Access, write: boolean, what: string): Touch {
    const units = [...new Set(regions.map((r) => r.level * img.layers + r.layer))]
    return { res: img, units, stage: stageAt('copy'), access: accessAt(access), write, layouts: write ? COPY_DST : COPY_SRC, what }
  }

  private view(v: View, stage: number, access: Access, write: boolean, layouts: readonly ImageLayout[], what: string): Touch {
    const img = imageOf(v)
    return { res: img, units: unitsIn(img, v.levels, v.layers), stage, access: accessAt(access), write, layouts, what }
  }

  /** The attachments' accesses. */
  private passTouches(rec: Extract<Recorded, { readonly r: 'pass' }>): Touch[] {
    const t: Touch[] = []
    const attach = (v: View, stage: PipeStage, access: Access, write: boolean, layout: ImageLayout, what: string): void => {
      t.push(this.view(v, stageAt(stage), access, write, [layout], what))
    }
    rec.colors.forEach((c, i) => {
      if (c === null) return
      if (c.load === 'keep') attach(c.view, 'color', 'color-read', false, 'color', `colour attachment ${i}`)
      attach(c.view, 'color', 'color-write', true, 'color', `colour attachment ${i}`)
      if (c.resolve !== null) attach(c.resolve, 'color', 'color-write', true, 'color', `the resolve view of colour attachment ${i}`)
    })
    const d = rec.depth
    if (d !== null) {
      attach(d.view, 'depth', 'depth-read', false, d.readOnly ? 'depth-read' : 'depth', 'the depth attachment')
      if (!d.readOnly) attach(d.view, 'depth', 'depth-write', true, 'depth', 'the depth attachment')
    }
    return t
  }

  /** The accesses of each binding of each set, at each of the command's stages its layout entry lists. */
  private bindings(sets: readonly BoundSet[], stages: readonly Stage[]): Touch[] {
    const t: Touch[] = []
    for (const s of sets) {
      for (const b of s.bindings) {
        const what = `binding ${b.entry.binding} of set ${s.index}`
        for (const st of b.entry.stages.filter((x) => stages.includes(x))) {
          const at = stageAt(st)
          if ('buffer' in b) {
            const one = (access: Access, write: boolean): Touch => ({ res: asBuffer(b.buffer), units: [0], stage: at, access: accessAt(access), write, layouts: null, what })
            if (b.entry.kind === 'uniform') t.push(one('uniform-read', false))
            else t.push(one('shader-read', false))
            if (b.entry.kind === 'storage') t.push(one('shader-write', true))
          } else if ('view' in b) {
            if (b.entry.kind === 'image') t.push(this.view(b.view, at, 'shader-read', false, FORMATS[imageOf(b.view).format].depth ? SAMPLED_DEPTH : SAMPLED, what))
            else t.push(this.view(b.view, at, 'shader-write', true, ['general'], what))
          }
        }
      }
    }
    return t
  }

  /** Checks every access of one command against the state before it, then applies them: reads, then writes. */
  private run(touches: readonly Touch[], cmd: Cmd): void {
    for (const t of touches) {
      this.eachState(t.res, t.units, (u, i) => {
        if (t.layouts !== null && !t.layouts.includes(u.layout)) {
          fail('layout', `${cmd.name}: ${unitName(t.res, i)} is in layout ${u.layout}, and ${t.what} needs ${t.layouts.join(' or ')}; move it there with an image barrier first`)
        }
        this.hazardRule(u, t, unitName(t.res, i), cmd)
      })
    }
    for (const t of touches) {
      if (t.write) continue
      const read: Read = { by: cmd.by, access: t.access, after: 0 }
      this.change(t.res, t.units, (u) => {
        const reads = u.reads.slice()
        reads[t.stage] = read
        return { write: u.write, seen: u.seen, reads, layout: u.layout }
      })
    }
    for (const t of touches) {
      if (!t.write) continue
      const write: Write = { by: cmd.by, stage: t.stage, access: t.access, move: null }
      const byLayout = new Map<ImageLayout, Unit>()
      this.change(t.res, t.units, (u) => {
        let n = byLayout.get(u.layout)
        if (n === undefined) {
          n = { write, seen: NO_SEEN, reads: NO_READS, layout: u.layout }
          byLayout.set(u.layout, n)
        }
        return n
      })
      if (t.res instanceof BufferImpl) this.wrote.add(t.res)
    }
    if (touches.length > 0) this.touched = cmd.by.tick
  }

  private hazardRule(u: Unit, t: Touch, name: string, cmd: Cmd): void {
    const here = `${ORDER_STAGES[t.stage]} (${ACCESS_LIST[t.access]})`
    const doing = `${name} is ${t.write ? 'written' : 'read'} as ${t.what} at ${here}`
    const samePass = (by: Origin, did: string): string | null => (cmd.by.pass !== null && by.pass === cmd.by.pass ? `${origin(by)} ${did} it in the same pass, and a barrier cannot sit in a pass: split the pass there` : null)
    const w = u.write
    if (w !== null && !visible(this.ledger, u, t.stage, t.access)) {
      const fix = samePass(w.by, 'wrote') ?? `a barrier between them needs a before covering ${coverOf(w)} and an after covering ${ORDER_STAGES[t.stage]} and ${ACCESS_LIST[t.access]}`
      fail('hazard', `${cmd.name}: ${doing}, and its last write, ${describe(w)}, was not made visible to it; ${fix}`)
    }
    if (!t.write) return
    for (let s = 0; s < N; s++) {
      const rd = u.reads[s]
      if (rd === null || ordered(this.ledger, rd, s, t.stage)) continue
      const fix = samePass(rd.by, 'read') ?? `a barrier between them needs a before covering ${ORDER_STAGES[s]} and an after covering ${ORDER_STAGES[t.stage]}`
      fail('hazard', `${cmd.name}: ${doing}, and the read at ${ORDER_STAGES[s]} (${ACCESS_LIST[rd.access]}) by ${origin(rd.by)} is not ordered before it; ${fix}`)
    }
  }

  private barrier(rec: Extract<Recorded, { readonly r: 'barrier' }>, cmd: Cmd): void {
    const images = rec.images.map((ib, k) => ({ ib, img: asImage(ib.image), e: edgeOf(ib), name: `${cmd.name}: images[${k}]` }))
    // Every move is checked against the state before the barrier, which the others do not change: they only widen.
    for (const { ib, img, e, name } of images) {
      this.eachState(img, unitsIn(img, ib.levels, ib.layers), (u, i) => {
        if (ib.from !== 'blank' && ib.from !== u.layout) fail('layout', `${name}: the barrier takes ${unitName(img, i)} from layout ${ib.from}, and it is in layout ${u.layout}`)
        if (ib.from !== ib.to) this.moveRule(u, e, `${name}: moving ${unitName(img, i)} from ${ib.from} to ${ib.to}`)
      })
    }
    // A memory barrier goes into the ledger at this command's clock, so it covers neither the moves below nor anything later.
    for (const m of rec.memory) this.grant(edgeOf(m), cmd.by.tick)
    for (const b of rec.buffers) {
      const e = edgeOf(b)
      this.change(asBuffer(b.buffer), [0], (u) => widened(u, e))
    }
    for (const { ib, img, e } of images) if (ib.from === ib.to) this.change(img, unitsIn(img, ib.levels, ib.layers), (u) => widened(u, e))
    for (const { ib, img, e } of images) {
      if (ib.from === ib.to) continue
      const moved: Unit = {
        write: { by: cmd.by, stage: 0, access: 0, move: { from: ib.from, to: ib.to, marks: e.marks } },
        seen: ORDER_STAGES.map((_, s) => ((e.after & (1 << s)) !== 0 ? e.afterAccess : 0)),
        reads: NO_READS,
        layout: ib.to,
      }
      this.change(img, unitsIn(img, ib.levels, ib.layers), () => moved)
      this.touched = cmd.by.tick
    }
  }

  /** A move waits for the last write and every read since, through its own before. */
  private moveRule(u: Unit, e: Edge, doing: string): void {
    const w = u.write
    if (w !== null && !coversWrite(e, w)) fail('hazard', `${doing} does not wait for its last write, ${describe(w)}; the barrier's before must cover ${coverOf(w)}`)
    for (let s = 0; s < N; s++) {
      const rd = u.reads[s]
      if (rd !== null && (e.before & (1 << s)) === 0) fail('hazard', `${doing} does not wait for the read at ${ORDER_STAGES[s]} (${ACCESS_LIST[rd.access]}) by ${origin(rd.by)}; the barrier's before must cover ${ORDER_STAGES[s]}`)
    }
  }
}

/**
 * Simulates a submit on the device's timeline and refuses it (code `hazard` or `layout`) if it leaves a hazard or uses
 * an image in the wrong layout. Nothing changes until the queue calls commit() on the plan it hands back.
 */
export function checkOrder(core: Core, steps: readonly Step[]): Plan {
  // A destroyed resource is never used again; its state goes with it, as the device's state holds resources weakly.
  const run = new Run(timelineOf(core))
  for (const step of steps) run.submission(step)
  return run
}

/**
 * Refuses (code `hazard`) to take a range of host memory back while a submit in flight writes a buffer bound there,
 * or while the last write to one was not made visible to (host, host-read): the check for memory.invalidate() to run
 * before it takes the range back.
 */
export function hostRead(memory: MemoryImpl, offset: number, size: number, where: string): void {
  // A device that does not check never simulates a submit, so it has no timeline and nothing is refused.
  const tl = timelines.get(memory.core)
  if (tl === undefined) return
  for (const r of memory.bound) {
    if (!(r instanceof BufferImpl) || r.offset >= offset + size || offset >= r.offset + r.size) continue
    if (tl.writing.has(r)) fail('hazard', `${where}: submitted work that writes ${r.name} is not done; invalidate once its fence is signalled`)
    const u = tl.units.get(r)?.rest
    if (u === undefined || u.write === null || visible(tl.ledger, u, stageAt('host'), accessAt('host-read'))) continue
    fail('hazard', `${where}: the last write to ${r.name}, ${describe(u.write)}, was not made visible to host (host-read); a barrier after it needs a before covering ${coverOf(u.write)} and an after covering host and host-read`)
  }
}
