// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the long-task telemetry: a browser without the API gets a no-op,
 * one with it gets one trace line per entry carrying the heap and the live worker count, a storm of entries is held
 * to a burst per window with the dropped count reported once, and the asynchronous heap measurement is used only on
 * a cross-origin isolated page without the synchronous figure.
 * What breaks if it is removed? A console flood, a missing heap figure or a crash on an old webview ships unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  heapBytesNow, liveWorkers, LONG_TASK_MS, TRACE_BURST, TRACE_TAG, TRACE_WINDOW_MS, TraceLimiter, traceOf, trackWorker, watchLongTasks, whereOf,
  type LongTaskEntry, type LongTaskGlobals, type LongTaskTrace,
} from './longTasks.ts'

type Callback = (list: { getEntries(): LongTaskEntry[] }) => void

/** A fake PerformanceObserver that records what it was asked to observe and lets the test deliver entries. */
function fakeObserver(types: readonly string[] | undefined = ['longtask', 'mark']) {
  const state = { observed: [] as unknown[], disconnected: 0, cb: null as Callback | null }
  class PO {
    static supportedEntryTypes = types
    constructor(cb: Callback) { state.cb = cb }
    observe(o: unknown) { state.observed.push(o) }
    disconnect() { state.disconnected++ }
  }
  const deliver = (...entries: LongTaskEntry[]) => state.cb?.({ getEntries: () => entries })
  return { PO: PO as unknown as NonNullable<LongTaskGlobals['PerformanceObserver']>, state, deliver }
}

const entry = (startTime: number, duration: number, attribution?: LongTaskEntry['attribution']): LongTaskEntry => ({ startTime, duration, name: 'self', attribution })

test('the threshold is the Long Tasks API\'s 50 ms and the tag is greppable', () => {
  assert.equal(LONG_TASK_MS, 50)
  assert.equal(TRACE_TAG, '[longtask]')
})

test('no PerformanceObserver, or one without longtask, installs nothing and returns a harmless stop', () => {
  const a = watchLongTasks(() => assert.fail('no trace expected'), {})
  a(); a()
  const { PO, state } = fakeObserver(['mark', 'measure'])
  const b = watchLongTasks(() => assert.fail('no trace expected'), { PerformanceObserver: PO })
  b()
  assert.equal(state.observed.length, 0)
  const c = watchLongTasks(() => assert.fail('no trace expected'), { PerformanceObserver: fakeObserver(undefined).PO })
  c()
})

test('Node\'s own PerformanceObserver has no longtask type, so the default global is a no-op here', () => {
  const stop = watchLongTasks(() => assert.fail('no trace expected'))
  stop()
})

test('one trace per entry: start, duration, where, the heap in MiB and the live worker count', () => {
  const { PO, state, deliver } = fakeObserver()
  const lines: LongTaskTrace[] = []
  const g: LongTaskGlobals = { PerformanceObserver: PO, performance: { now: () => 1000, memory: { usedJSHeapSize: 3 * 1048576 + 52429 } } }
  const stop = watchLongTasks((tag, t) => { assert.equal(tag, TRACE_TAG); lines.push(t as LongTaskTrace) }, g)
  assert.deepEqual(state.observed, [{ type: 'longtask', buffered: true }])
  const untrack = trackWorker()
  const before = liveWorkers()
  deliver(entry(1234.56, 87.44), entry(2000, 51, [{ containerType: 'iframe', containerName: 'ads' }]))
  untrack(); untrack()
  assert.equal(liveWorkers(), before - 1)
  assert.deepEqual(lines, [
    { startMs: 1234.6, durationMs: 87.4, where: 'self', heapMiB: 3.1, workers: before },
    { startMs: 2000, durationMs: 51, where: 'iframe ads', heapMiB: 3.1, workers: before },
  ])
  stop()
  assert.equal(state.disconnected, 1)
  deliver(entry(3000, 60))
  assert.equal(lines.length, 2, 'nothing after stop')
  stop()
  assert.equal(state.disconnected, 1, 'disconnect once')
})

test('a storm is held to a burst per window, and the dropped count is reported once with the next trace', () => {
  const { PO, deliver } = fakeObserver()
  let clock = 0
  const lines: unknown[] = []
  const g: LongTaskGlobals = { PerformanceObserver: PO, performance: { now: () => clock } }
  const stop = watchLongTasks((_tag, t) => lines.push(t), g)
  for (let k = 0; k < TRACE_BURST + 5; k++) { clock = k; deliver(entry(k * 100, 60)) }
  assert.equal(lines.length, TRACE_BURST)
  assert.equal((lines[0] as LongTaskTrace).heapMiB, 'n/a', 'no heap figure without performance.memory and without isolation')
  clock = TRACE_WINDOW_MS + 1
  deliver(entry(99_000, 70))
  assert.equal(lines.length, TRACE_BURST + 2)
  assert.deepEqual(lines[TRACE_BURST], { dropped: 5, windowMs: TRACE_WINDOW_MS })
  assert.equal((lines[TRACE_BURST + 1] as LongTaskTrace).durationMs, 70)
  stop()
})

test('TraceLimiter: burst, then counted drops, a new window after windowMs, drain clears', () => {
  const l = new TraceLimiter(2, 100)
  assert.equal(l.allow(0), true)
  assert.equal(l.allow(10), true)
  assert.equal(l.allow(20), false)
  assert.equal(l.allow(99), false)
  assert.equal(l.drain(), 2)
  assert.equal(l.drain(), 0)
  assert.equal(l.allow(100), true, 'a new window opens at windowMs')
  assert.equal(l.allow(101), true)
  assert.equal(l.allow(102), false)
  assert.equal(l.drain(), 1)
})

test('the asynchronous heap measurement is used only on a cross-origin isolated page without performance.memory', async () => {
  const { PO, deliver } = fakeObserver()
  const lines: LongTaskTrace[] = []
  let asked = 0
  const measure = async () => { asked++; return { bytes: 10 * 1048576 } }
  // Isolated, no sync figure: asked, and the line waits for the answer.
  const g1: LongTaskGlobals = { PerformanceObserver: PO, crossOriginIsolated: true, performance: { now: () => 0, measureUserAgentSpecificMemory: measure } }
  const stop1 = watchLongTasks((_t, t) => lines.push(t as LongTaskTrace), g1)
  deliver(entry(1, 55))
  assert.equal(lines.length, 0, 'the line waits for the measurement')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(asked, 1)
  assert.equal(lines[0].heapMiB, 10)
  stop1()
  // Not isolated: never asked, "n/a" at once.
  const f2 = fakeObserver()
  const g2: LongTaskGlobals = { PerformanceObserver: f2.PO, crossOriginIsolated: false, performance: { now: () => 0, measureUserAgentSpecificMemory: measure } }
  const stop2 = watchLongTasks((_t, t) => lines.push(t as LongTaskTrace), g2)
  f2.deliver(entry(2, 55))
  assert.equal(lines.length, 2)
  assert.equal(lines[1].heapMiB, 'n/a')
  assert.equal(asked, 1)
  stop2()
  // Isolated with the sync figure: the sync figure wins, nothing asked.
  const f3 = fakeObserver()
  const g3: LongTaskGlobals = { PerformanceObserver: f3.PO, crossOriginIsolated: true, performance: { now: () => 0, memory: { usedJSHeapSize: 1048576 }, measureUserAgentSpecificMemory: measure } }
  const stop3 = watchLongTasks((_t, t) => lines.push(t as LongTaskTrace), g3)
  f3.deliver(entry(3, 55))
  assert.equal(lines[2].heapMiB, 1)
  assert.equal(asked, 1)
  stop3()
  // A measurement that fails still writes the line, with "n/a".
  const f4 = fakeObserver()
  const g4: LongTaskGlobals = { PerformanceObserver: f4.PO, crossOriginIsolated: true, performance: { now: () => 0, measureUserAgentSpecificMemory: async () => { throw new Error('refused') } } }
  const stop4 = watchLongTasks((_t, t) => lines.push(t as LongTaskTrace), g4)
  f4.deliver(entry(4, 55))
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
  assert.equal(lines[3].heapMiB, 'n/a')
  stop4()
})

test('heapBytesNow and whereOf read what the browser gives and nothing more', () => {
  assert.equal(heapBytesNow(undefined), null)
  assert.equal(heapBytesNow({}), null)
  assert.equal(heapBytesNow({ memory: { usedJSHeapSize: -1 } }), null)
  assert.equal(heapBytesNow({ memory: { usedJSHeapSize: NaN } }), null)
  assert.equal(heapBytesNow({ memory: { usedJSHeapSize: 42 } }), 42)
  assert.equal(whereOf(entry(0, 50)), 'self')
  assert.equal(whereOf(entry(0, 50, [])), 'self')
  assert.equal(whereOf(entry(0, 50, [{ containerType: 'window' }])), 'window')
  assert.equal(whereOf(entry(0, 50, [{ containerType: 'iframe', containerSrc: 'https://x.example/' }])), 'iframe https://x.example/')
  assert.deepEqual(traceOf(entry(10.04, 50.06), null, 2), { startMs: 10, durationMs: 50.1, where: 'self', heapMiB: 'n/a', workers: 2 })
})

test('a PerformanceObserver that throws on construction or observe installs nothing', () => {
  class Throwing {
    static supportedEntryTypes = ['longtask']
    constructor() { throw new Error('no') }
  }
  const stop = watchLongTasks(() => assert.fail('no trace expected'), { PerformanceObserver: Throwing as never })
  stop()
})
