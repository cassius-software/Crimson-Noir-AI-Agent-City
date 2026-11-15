// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is where recorded work is handed to the device. A queue takes submissions of command
 * lists, checks them as a whole before anything changes (each list ready, not stale, of an arena of the queue's group
 * and named once; each semaphore signalled before it is waited on and waited on once per signal; the fence
 * unsignalled and not already waiting), marks the lists pending and every object they use held, hands the lists'
 * commands to the back end in order, and when the back end says the work is done lets everything go and signals the
 * fence.
 * What breaks if it is removed? Recorded work would never run, and nothing would keep an object alive while queued
 * work still reads it or tell the host when that work is done.
 *
 * Rules (all pinned by queue.test.ts):
 * - A submit is all or nothing: a refused one changes no list, semaphore or fence.
 * - Within a submit, submissions run in order; within a submission its waits come first, then its lists, then its
 *   signals. A semaphore is armed by a signal and disarmed by the one wait that takes it, so a wait needs a signal
 *   in an earlier submission (of this submit or an earlier one), a submission cannot wait on its own signal, and a
 *   semaphore is not signalled again before its signal is taken. The back end is given the lists in that order; it
 *   runs in order on its one queue, so a semaphore never reaches it.
 * - One submit hands the back end all of its lists at once and gets one `done`. When it comes, every list is ready
 *   again (a `once` list invalid), every object they held is let go, and the fence is signalled. `done` called a
 *   second time does nothing.
 * - Callbacks waiting on the fence run after the back end's submit returns when it finishes the work at once (as the
 *   reference renderer does), outside any refusal handling, so whatever an app's callback raises is its own.
 * - A back end that refuses a submit (it raises) gets the submit undone: lists ready, objects let go, semaphores and
 *   fence as they were. A back end that stopped part way has lost the device (see BackendDevice), so every later
 *   call that reaches it is refused with `device`; the undo then only lets the objects go so they can be destroyed.
 * - When the instance checks, the ordering checker (order.ts) simulates the whole submit after every other check and
 *   before anything changes, so a hazard or a wrong layout refuses it whole. Its simulated state becomes the device's
 *   with the commit, is put back with everything else when the back end refuses the submit, and its writes count as
 *   in flight for invalidate() until `done`.
 */
import type { Fence, Queue, Submission } from './api.ts'
import { fail } from './fault.ts'
import { CommandListImpl, PIPE_STAGES } from './commands.ts'
import { checkOrder } from './order.ts'
import type { Step } from './order.ts'
import { FenceImpl, SemaphoreImpl, guard, listOf, names, own, record } from './sync.ts'
import type { Core } from './sync.ts'

export class QueueImpl implements Queue {
  readonly group: number
  readonly index: number
  private readonly core: Core
  private readonly name: string

  constructor(core: Core, group: number, index: number) {
    this.core = core
    this.group = group
    this.index = index
    this.name = `queue ${group}.${index}`
  }

  submit(submissions: readonly Submission[], fence?: Fence): void {
    const where = `${this.name} submit`
    const due = guard(this.core.report, where, () => this.run(submissions, fence, where))
    for (const callback of due) callback()
  }

  /** Checks, commits and hands over one submit; returns the fence callbacks to run if the work finished at once. */
  private run(submissions: unknown, fence: unknown, where: string): (() => void)[] {
    const core = this.core
    core.enter(where)
    const subs = listOf(submissions, where, 'the submissions')
    const f = fence === undefined ? null : own(core, FenceImpl, fence, where, 'the fence', 'Fence')
    if (f !== null && f.waiting) fail('state', `${where}: ${f.name} already waits on submitted work`)
    if (f !== null && f.signalled) fail('state', `${where}: ${f.name} is signalled; reset it first`)
    const lists: CommandListImpl[] = []
    const steps: Step[] = []
    const armed = new Map<SemaphoreImpl, boolean>()
    const isArmed = (s: SemaphoreImpl): boolean => armed.get(s) ?? s.armed
    subs.forEach((x, i) => {
      const at = `${where}: submissions[${i}]`
      const o = record(x, ['lists', 'wait', 'signal'], at, 'the submission')
      const step = { waits: [] as Step['waits'][number][], lists: [] as Step['lists'][number][], signals: [] as SemaphoreImpl[] }
      steps.push(step)
      const waits = o.wait === undefined ? [] : listOf(o.wait, at, 'the waits')
      waits.forEach((w, j) => {
        const wat = `${at} wait[${j}]`
        const wo = record(w, ['semaphore', 'stages'], wat, 'the wait')
        const sem = own(core, SemaphoreImpl, wo.semaphore, wat, 'the semaphore', 'Semaphore')
        const stages = names(PIPE_STAGES, wo.stages, wat, 'the stages')
        if (!isArmed(sem)) fail('state', `${wat}: no earlier submission signals ${sem.name} that a wait has not already taken`)
        armed.set(sem, false)
        step.waits.push({ semaphore: sem, stages })
      })
      listOf(o.lists, at, 'the lists').forEach((l, j) => {
        const lat = `${at} lists[${j}]`
        const list = own(core, CommandListImpl, l, lat, 'the list', 'CommandList')
        if (lists.includes(list)) fail('state', `${lat}: ${list.name} is submitted twice`)
        const state = list.state
        if (state === 'invalid') {
          const why = list.stale()
          if (why !== null) fail(why.code, `${lat}: ${why.message}`)
          fail('state', `${lat}: ${list.name} ran once and must be reset and recorded again`)
        }
        if (state !== 'ready') fail('state', `${lat}: ${list.name} is ${state}, not ready`)
        if (list.arena.group !== this.group) fail('mismatch', `${lat}: ${list.name} was recorded for queue group ${list.arena.group}, and this queue is of group ${this.group}`)
        lists.push(list)
        step.lists.push({ list, at: lat })
      })
      const signals = o.signal === undefined ? [] : listOf(o.signal, at, 'the signals')
      signals.forEach((s, j) => {
        const sat = `${at} signal[${j}]`
        const sem = own(core, SemaphoreImpl, s, sat, 'the semaphore', 'Semaphore')
        if (isArmed(sem)) fail('state', `${sat}: ${sem.name} is already signalled and no wait has taken that signal`)
        armed.set(sem, true)
        step.signals.push(sem)
      })
    })
    const order = core.checks ? checkOrder(core, steps) : null
    // Everything is checked; commit.
    const before = new Map([...armed.keys()].map((s) => [s, s.armed] as const))
    for (const [s, on] of armed) {
      s.armed = on
      s.pending++
    }
    for (const l of lists) l.hold()
    if (f !== null) f.pending++
    order?.commit()
    core.inFlight++
    let finished = false
    let calling = true
    let due: (() => void)[] = []
    const settle = (ran: boolean): void => {
      finished = true
      for (const l of lists) l.release(ran)
      for (const s of armed.keys()) s.pending--
      core.inFlight--
      if (f !== null) f.pending--
      order?.settle(ran)
    }
    const done = (): void => {
      if (finished) return
      settle(true)
      if (f === null) return
      const callbacks = f.signal()
      if (calling) due = callbacks
      else for (const callback of callbacks) callback()
    }
    try {
      core.call(where, () => core.backend.submit(lists.map((l) => l.commands), done))
    } catch (e) {
      if (!finished) {
        settle(false)
        for (const [s, on] of before) s.armed = on
      }
      throw e
    }
    calling = false
    return due
  }
}
