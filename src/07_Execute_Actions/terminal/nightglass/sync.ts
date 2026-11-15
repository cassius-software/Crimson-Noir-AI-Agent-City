// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what every Nightglass object shares, and the host's half of keeping step with the
 * device. Every object the core hands out (memory, buffers, images, views, samplers, layouts, pools and sets, shaders,
 * pipelines, arenas, command lists, fences, semaphores and the device itself) stands on Base: its label, the name its
 * refusals use, whether it is destroyed, how many submissions in flight still hold it, and a version that a recorded
 * command list compares to learn that the object changed after the list recorded it. Every public call runs inside
 * guard(), which hands each Fault to the instance's report callback before it is thrown and turns anything else a
 * malformed argument raises into a Fault, so a caller only ever catches Faults. The descriptor readers here give
 * every create call one strict reading and one way of wording a refusal. Fences and semaphores, which say when
 * queued work is done and order one submission after another, live here too.
 * What breaks if it is removed? Every object would track its own lifetime, refusals would reach the report callback
 * from some calls and not others, a TypeError could escape a public call, and the queue would have nothing to signal.
 *
 * Genuine objects and one call at a time (both pinned by core.test.ts and queue.test.ts):
 * - Base's constructor brands each object it makes. own() and alive() refuse anything without the brand (code
 *   `invalid`), before any other test of it, so an Object.create() copy or a Proxy wrapper of a real object never
 *   stands in for it: hold counts, fences and the ordering checker's books only ever land on objects the core made.
 * - One public call runs at a time. A public call made while another runs (from a getter, a Proxy trap or a toString
 *   of that call's arguments) is refused with code `state`, so nothing an argument runs can destroy, reset, submit or
 *   bind between a call's checks and what it changes. The latch is let go before the report callback runs, and fence
 *   callbacks and the reports of refusals made inside a call run once it has let go (outside()), so app code they
 *   call may call Nightglass again.
 * - The guard describes whatever an argument raised without letting that value raise again: a revoked Proxy, or an
 *   Error whose name getter throws, becomes a Fault of code `invalid` like any other.
 *
 * Lifetime, as every object keeps it:
 * - `destroy()` refuses an object already destroyed, and (when the instance checks) one that a submission in flight
 *   still holds (`pending` above zero). An object's own rules on what must go first (an image's views, a memory's
 *   resources) run next, and only then is anything freed, so a refused destroy changes nothing.
 * - An owner that frees its children (a pool's reset, an arena's destroy, the device's destroy) calls `drop()` and
 *   `retire()` on each, without the checks.
 * - `version` rises when the object changes in a way a recorded list depends on (a binding set's write) and when it
 *   is destroyed. A command list keeps the version of each object it recorded and is invalid once any differs.
 */
import type { Adapter, BackendDevice, Fence, Feature, Limits, Range, Semaphore, Thing } from './api.ts'
import { Fault, fail, isFault } from './fault.ts'
import { say } from './verify.ts'

/** The instance's report callback, or null when it has none. */
export type Report = ((fault: Fault) => void) | null

/** Faults already handed to a report callback, so a refusal that passes through two guards is reported once. */
const reported = new WeakSet<Fault>()

/** Every object the core made: Base's constructor adds it (see the head of the file). */
const genuine = new WeakSet<object>()

/** True for an object the core made. WeakSet.has runs no Proxy trap, and is false for a copy or wrapper of one. */
export function isGenuine(x: unknown): boolean {
  return genuine.has(x as object)
}

/** The public call running now, by its name in refusals, or null (see guard). */
let running: string | null = null

/** Work held until the running call lets go: reports of calls refused inside it, and fence callbacks. */
let held: (() => void)[] = []

/**
 * Runs `f` now when no public call is running, else as soon as the running one lets go, so the app code it calls
 * may call Nightglass again. The queue hands it the callbacks of a fence signalled while some call runs.
 */
export function outside(f: () => void): void {
  if (running === null) f()
  else held.push(f)
}

/** Runs the work held for the call that just let go, in order; the first error raised is thrown once all have run. */
function release(): void {
  const due = held
  held = []
  let raised: { readonly e: unknown } | null = null
  for (const g of due) {
    try {
      g()
    } catch (e) {
      if (raised === null) raised = { e }
    }
  }
  if (raised !== null) throw raised.e
}

/** The Fault a caught value becomes. Describing it cannot raise: a value that will not be described gets a plain one. */
function faultOf(e: unknown, where: string): Fault {
  try {
    if (isFault(e)) return e
    return new Fault('invalid', `${where}: reading the arguments raised ${e instanceof Error ? `a ${e.name}` : say(e)}`)
  } catch {
    return new Fault('invalid', `${where}: reading the arguments raised a value that cannot be described`)
  }
}

/**
 * Runs one public call. A Fault it raises goes to `report` (once) and is thrown on; anything else it raises (a
 * getter that throws, a Proxy, a value read as an object that is not one) becomes a Fault of code `invalid` first.
 * A call made while another runs is refused with code `state` (see the head of the file); its report waits until
 * the running call lets go. A report callback that throws replaces the Fault with its own error: the callback is the
 * app's code.
 */
export function guard<T>(report: Report, where: string, f: () => T): T {
  if (running !== null) {
    const fault = new Fault('state', `${where}: called from inside another Nightglass call (${running}); calls run one at a time, so a getter, Proxy trap or callback of a call's arguments cannot make one`)
    if (report !== null) {
      reported.add(fault)
      held.push(() => report(fault))
    }
    throw fault
  }
  running = where
  let out: T
  try {
    out = f()
  } catch (e) {
    const fault = faultOf(e, where)
    running = null
    if (report !== null && !reported.has(fault)) {
      reported.add(fault)
      held.push(() => report(fault))
    }
    release()
    throw fault
  }
  running = null
  release()
  return out
}

/** Runs a back end call. A Fault it raises passes through; anything else becomes a Fault of code `device`. */
export function drive<T>(where: string, f: () => T): T {
  try {
    return f()
  } catch (e) {
    if (isFault(e)) throw e
    return fail('device', `${where}: the back end raised ${e instanceof Error ? `${e.name}: ${e.message}` : say(e)}`)
  }
}

/** What one opened device shares with every object it makes. */
export class Core {
  readonly backend: BackendDevice
  readonly adapter: Adapter
  readonly limits: Limits
  readonly features: readonly Feature[]
  readonly checks: boolean
  readonly report: Report
  /** Every live object the device made, oldest first (a Set keeps the order things were added). */
  readonly live = new Set<Base>()
  /** Bytes allocated from each heap, by heap index. */
  readonly heapUsed: number[]
  /** Memory allocations alive. */
  allocations = 0
  /** Submissions queued on any of the device's queues whose work has not finished. */
  inFlight = 0
  /** Set once the device is destroyed. */
  closed = false
  private serial = 0

  constructor(backend: BackendDevice, adapter: Adapter, limits: Limits, features: readonly Feature[], checks: boolean, report: Report) {
    this.backend = backend
    this.adapter = adapter
    this.limits = limits
    this.features = features
    this.checks = checks
    this.report = report
    this.heapUsed = adapter.heaps.map(() => 0)
  }

  /** The next serial number, which names an object that has no label. */
  next(): number {
    this.serial++
    return this.serial
  }

  /** Runs a back end call (see drive()). */
  call<T>(where: string, f: () => T): T {
    return drive(where, f)
  }

  /** Refuses a call that reaches the back end on a destroyed or lost device. */
  enter(where: string): void {
    if (this.closed) fail('lifetime', `${where}: the device is destroyed`)
    const lost = this.call(where, () => this.backend.lost())
    if (lost !== null) fail('device', `${where}: the device is lost (${lost})`)
  }
}

/** The footing of every Nightglass object (see the head of the file). */
export abstract class Base implements Thing {
  readonly core: Core
  readonly label: string
  /** How refusals name it: its kind and label, or its kind and serial number when it has no label. */
  readonly name: string
  /** Submissions in flight that hold it. */
  pending = 0
  /** Rises with each change a recorded command list depends on, and when the object is destroyed. */
  version = 0
  private gone = false

  constructor(core: Core, kind: string, label: string) {
    this.core = core
    this.label = label
    this.name = label === '' ? `${kind} ${core.next()}` : `${kind} ${JSON.stringify(label)}`
    core.live.add(this)
    genuine.add(this)
  }

  get destroyed(): boolean {
    return this.gone
  }

  destroy(): void {
    const where = `${this.name} destroy`
    guard(this.core.report, where, () => {
      this.alive(where)
      if (this.core.checks && this.pending > 0) fail('lifetime', `${where}: queued work still uses it; wait for its fence first`)
      this.check(where)
      this.drop()
      this.retire()
    })
  }

  /** Refuses the use of a destroyed object, and of a copy or wrapper of one (see the head of the file). */
  alive(where: string): void {
    if (!genuine.has(this)) fail('invalid', `${where}: the object is a copy or wrapper of one Nightglass made, not one it made`)
    if (this.gone) fail('lifetime', `${where}: ${this.name} is destroyed`)
  }

  /** Marks the object destroyed. Its owner calls this, after drop(), when it frees the object without checks. */
  retire(): void {
    this.gone = true
    this.version++
    this.core.live.delete(this)
  }

  /** The object's own rules on what must go before it does. Raises before anything is freed. */
  protected check(_where: string): void {}

  /** Frees what the object holds at the back end and detaches it from the objects it hangs from. */
  drop(): void {}
}

// ---------------------------------------------------------------------------------------------------
// Fences and semaphores

/** A fence (see api.ts). The queue sets it waiting when it is handed to a submission and signals it when that is done. */
export class FenceImpl extends Base implements Fence {
  private on: boolean
  private callbacks: (() => void)[] = []

  constructor(core: Core, signalled: boolean, label: string) {
    super(core, 'fence', label)
    this.on = signalled
  }

  get signalled(): boolean {
    return this.on
  }

  /** Handed to a submission whose completion will signal it. */
  get waiting(): boolean {
    return this.pending > 0
  }

  reset(): void {
    const where = `${this.name} reset`
    guard(this.core.report, where, () => {
      this.alive(where)
      if (this.waiting) fail('state', `${where}: the fence waits on submitted work; it resets once that work signals it`)
      this.on = false
    })
  }

  onSignal(callback: () => void): void {
    const where = `${this.name} onSignal`
    const now = guard(this.core.report, where, () => {
      this.alive(where)
      if (typeof callback !== 'function') fail('invalid', `${where}: the callback is a function, not ${say(callback)}`)
      if (this.on) return true
      this.callbacks.push(callback)
      return false
    })
    // Called outside the guard: whatever the app's callback raises is its own.
    if (now) callback()
  }

  /** Signals the fence and hands back the callbacks waiting on it, in the order they came, for the caller to run. */
  signal(): (() => void)[] {
    this.on = true
    const due = this.callbacks
    this.callbacks = []
    return due
  }

  override drop(): void {
    this.callbacks = []
  }
}

/** A semaphore (see api.ts): armed by a submission that signals it, disarmed by the one later submission that waits on it. */
export class SemaphoreImpl extends Base implements Semaphore {
  /** A signal has been submitted that no wait has taken yet. */
  armed = false

  constructor(core: Core, label: string) {
    super(core, 'semaphore', label)
  }
}

// ---------------------------------------------------------------------------------------------------
// Reading descriptors

export type Obj = { readonly [key: string]: unknown }

export function isObj(x: unknown): x is Obj {
  return typeof x === 'object' && x !== null && !Array.isArray(x)
}

/** The members of a string union as a frozen list. The table's type makes the compiler hold it to the union exactly. */
export function every<T extends string>(table: { readonly [K in T]: true }): readonly T[] {
  return Object.freeze(Object.keys(table) as T[])
}

/**
 * A descriptor: an object holding none but the named fields (each may be absent). With `optional`, an absent
 * descriptor reads as an empty one. A field the call does not know is refused, so a misspelt one is never ignored.
 */
export function record(x: unknown, allowed: readonly string[], where: string, what: string, optional = false): Obj {
  if (x === undefined && optional) return {}
  if (!isObj(x)) fail('invalid', `${where}: ${what} is an object, not ${say(x)}`)
  for (const k of Object.keys(x)) if (!allowed.includes(k)) fail('invalid', `${where}: ${what} has no field ${say(k)}`)
  return x
}

/** A whole number of at least `min`. */
export function whole(x: unknown, where: string, what: string, min = 0): number {
  if (typeof x !== 'number' || !Number.isSafeInteger(x) || x < min) fail('invalid', `${where}: ${what} ${say(x)} is not a whole number of at least ${min}`)
  return x
}

/** A whole number from 0 to 2^32 - 1, as a draw's or a dispatch's counts are; absent gives `fallback`. */
export function word(x: unknown, where: string, what: string, fallback: number): number {
  if (x === undefined) return fallback
  if (typeof x !== 'number' || !Number.isInteger(x) || x < 0 || x > 0xffffffff) fail('invalid', `${where}: ${what} ${say(x)} is not a whole number from 0 to 4294967295`)
  return x
}

/** A finite number. */
export function finite(x: unknown, where: string, what: string): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) fail('invalid', `${where}: ${what} ${say(x)} is not a finite number`)
  return x
}

/** One of a list of names; absent gives `fallback` when there is one. */
export function choice<T extends string>(list: readonly T[], x: unknown, where: string, what: string, fallback?: T): T {
  if (x === undefined && fallback !== undefined) return fallback
  if (!(list as readonly unknown[]).includes(x)) fail('invalid', `${where}: ${what} ${say(x)} is not one of ${list.join(', ')}`)
  return x as T
}

/** true or false; absent gives `fallback`. */
export function flag(x: unknown, where: string, what: string, fallback: boolean): boolean {
  if (x === undefined) return fallback
  if (typeof x !== 'boolean') fail('invalid', `${where}: ${what} is true or false, not ${say(x)}`)
  return x
}

/** A list. */
export function listOf(x: unknown, where: string, what: string): readonly unknown[] {
  if (!Array.isArray(x)) fail('invalid', `${where}: ${what} is a list, not ${say(x)}`)
  return x
}

/** A list of names, each at most once (and at least one unless `empty`), frozen. */
export function names<T extends string>(list: readonly T[], x: unknown, where: string, what: string, empty = false): readonly T[] {
  const items = listOf(x, where, what)
  if (items.length === 0 && !empty) fail('invalid', `${where}: ${what} is empty; it names at least one of ${list.join(', ')}`)
  const out: T[] = []
  for (const item of items) {
    const n = choice(list, item, where, `${what} entry`)
    if (out.includes(n)) fail('invalid', `${where}: ${what} names ${n} twice`)
    out.push(n)
  }
  return Object.freeze(out)
}

/** A label: absent gives the empty string. */
export function labelOf(x: unknown, where: string): string {
  if (x === undefined) return ''
  if (typeof x !== 'string') fail('invalid', `${where}: the label is a string, not ${say(x)}`)
  return x
}

/** A range of `total` levels or layers; absent gives all of them. */
export function span(x: unknown, total: number, where: string, what: string): Range {
  if (x === undefined) return Object.freeze({ base: 0, count: total })
  const o = record(x, ['base', 'count'], where, what)
  const base = whole(o.base, where, `${what} base`)
  const count = whole(o.count, where, `${what} count`, 1)
  if (base + count > total) fail('invalid', `${where}: ${what} ${base} to ${base + count - 1} run past the ${total} there are`)
  return Object.freeze({ base, count })
}

/** A word with its indefinite article: `an image`, `a sampler`. */
export function an(word: string): string {
  return `${/^[aeiou]/i.test(word) ? 'an' : 'a'} ${word}`
}

/** Refuses an object made by another device, or destroyed. */
export function mine(core: Core, x: Base, where: string): void {
  if (x.core !== core) fail('mismatch', `${where}: ${x.name} belongs to another device`)
  x.alive(where)
}

/**
 * An object of one of the core's classes, made by this device and not destroyed. `kind` names the class in a
 * refusal. The brand is tested first, so a Proxy's traps never run and a copy of a real object is refused.
 */
export function own<T extends Base>(core: Core, cls: abstract new (...args: never[]) => T, x: unknown, where: string, what: string, kind: string): T {
  if (!isGenuine(x) || !(x instanceof cls)) fail('invalid', `${where}: ${what} is not ${an(kind)}, but ${say(x)}`)
  mine(core, x, where)
  return x
}
