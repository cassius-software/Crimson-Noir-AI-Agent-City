// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how anything in the console's operating layer waits without a timer, a callback
 * or a thread: a piece of work is a generator (a Task), and when it cannot go on (a pipe is empty, a drive has not
 * answered yet, a child has not finished) it yields a Wait, which is nothing but a question the scheduler can ask
 * again later: "ready?". The kernel resumes the task when the answer is yes. A drive that answers later (a folder on
 * the person's own disk) hands back a Later, which the host settles when the answer arrives; a drive that answers at
 * once (memory) hands back the value itself, and the same code serves both. `now` runs a task that should never have
 * to wait and refuses, by name, if it would. Because every wait is a question and never a clock, the whole layer is
 * deterministic: the same calls in the same order give the same result.
 * What breaks if it is removed? The file system and the kernel would need two versions of every call, one for
 * drives that answer at once and one for drives that do not, and a program could not block on a pipe at all.
 */
import { OsError, refuse } from './errno.ts'

/**
 * A question the scheduler asks until the answer is yes. `why` is what `ps` shows for a task that waits; `at`, when a
 * wait is for the clock, is the time it names, so the host knows when to look again.
 */
export interface Wait { readonly why: string; readonly at?: number; ready(): boolean }

/** A piece of work that may wait: it yields each Wait and returns its result. */
export type Task<T> = Generator<Wait, T, void>

/** An answer that arrives later: the host settles it once, with a value or a refusal. */
export class Later<T> {
  done = false
  value: T | undefined = undefined
  error: OsError | null = null
  private heard: ((from: Later<T>) => void)[] | null = null

  /** Settles with the value (a second settling is ignored). */
  resolve(value: T): void {
    if (this.done) return
    this.done = true
    this.value = value
    this.tell()
  }

  /** Settles with a refusal (a second settling is ignored). */
  reject(error: OsError): void {
    if (this.done) return
    this.done = true
    this.error = error
    this.tell()
  }

  private tell(): void {
    const heard = this.heard
    this.heard = null
    if (heard !== null) for (const fn of heard) fn(this)
  }

  /** Calls `fn` when this settles: at once when it already has. */
  settled(fn: (from: Later<T>) => void): void {
    if (this.done) fn(this)
    else (this.heard ??= []).push(fn)
  }

  /** A Later that settles with `fn` of this one's value; a refusal, here or thrown by `fn`, passes through. */
  map<U>(fn: (value: T) => U): Later<U> {
    const out = new Later<U>()
    this.settled((from) => {
      if (from.error !== null) { out.reject(from.error); return }
      try {
        out.resolve(fn(from.value as T))
      } catch (e) {
        out.reject(e instanceof OsError ? e : new OsError('EIO', e instanceof Error ? e.message : String(e)))
      }
    })
    return out
  }
}

/** What a driver hands back: the value, or a Later that will hold it. */
export type Io<T> = T | Later<T>

/** The value of an Io, waiting for it when it is a Later; a Later settled with a refusal throws it here. */
export function* io<T>(x: Io<T>): Task<T> {
  if (!(x instanceof Later)) return x
  while (!x.done) yield { why: 'io', ready: () => x.done }
  if (x.error !== null) throw x.error
  return x.value as T
}

/** A wait that is over at once: a task yields it to let the others run. */
export const BREATH: Wait = Object.freeze({ why: 'run', ready: () => true })

/** The most times `now` lets a task yield a wait that is already over before it calls the task a runaway. */
const NOW_SPINS = 1_000_000

/**
 * Runs a task to its end where nothing may wait (a host reading a file in memory, a test). A wait that is not over
 * is refused as EAGAIN: the caller reached a drive that answers later and must go through the kernel instead.
 */
export function now<T>(task: Task<T>): T {
  for (let spins = 0; spins < NOW_SPINS; spins++) {
    const step = task.next()
    if (step.done === true) return step.value
    if (!step.value.ready()) {
      // The task is abandoned here: run its cleanup (its `finally` blocks) before refusing.
      task.return(undefined as never)
      refuse('EAGAIN', `this would wait (${step.value.why})`)
    }
  }
  task.return(undefined as never)
  return refuse('EAGAIN', 'a task that never ends')
}
