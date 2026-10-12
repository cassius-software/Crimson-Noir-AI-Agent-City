// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's micro-stutter telemetry: a PerformanceObserver on the browser's
 * `longtask` entries (any main-thread task over 50 ms, the Long Tasks API's own threshold) that, for each one,
 * silently writes one trace line to the console: when the task started, how long it ran, which frame it blocked,
 * the JS heap in use (performance.memory where the browser has it, measureUserAgentSpecificMemory on a cross-origin
 * isolated page, otherwise "n/a") and how many of the page's worker threads were alive (the physics worker is the
 * WASM thread: Rapier and the pedestrians run there; the map builder is the other). Nothing of it reaches the UI
 * or the network: a 30 s DevTools recording on a stuttering machine now has a console line beside each stall,
 * and a stall that keeps coming back shows as a storm of them, rate-limited so that storm cannot flood the console
 * (a burst per window, then one count of what was dropped). Where the browser has no PerformanceObserver or no
 * `longtask` entry type (tests under Node, older webviews) nothing is installed, and nothing is lost.
 * What breaks if it is removed? A frame-dropping stall on a player's machine leaves no trace but their word.
 */

/** The Long Tasks API threshold: every `longtask` entry is at least this long, ms. */
export const LONG_TASK_MS = 50
/** Trace lines written per window before the rest of the window's long tasks are only counted. */
export const TRACE_BURST = 8
/** The rate limiter's window, ms. */
export const TRACE_WINDOW_MS = 10_000
/** The console prefix every trace line carries (grep for it in a saved console log). */
export const TRACE_TAG = '[longtask]'

/** One `longtask` entry, as the Long Tasks API hands it over (the attribution is optional, and often empty). */
export interface LongTaskEntry {
  readonly startTime: number
  readonly duration: number
  readonly name?: string
  readonly attribution?: readonly { readonly containerType?: string; readonly containerName?: string; readonly containerSrc?: string }[]
}

/** One trace line's fields, in the order they print. */
export interface LongTaskTrace {
  /** Milliseconds since the page's time origin at which the task began, rounded to 0.1 ms. */
  startMs: number
  /** The task's length, rounded to 0.1 ms. */
  durationMs: number
  /** Where the browser attributes the task: its container type (window, iframe, …) or "self". */
  where: string
  /** JS heap in use, MiB rounded to 0.1, or "n/a" where the browser gives no figure. */
  heapMiB: number | 'n/a'
  /** The page's worker threads alive at the time (the physics worker among them). */
  workers: number
}

// The registry of live workers: whoever starts a worker thread records it, and takes the record back on terminate.
let liveWorkerCount = 0

/**
 * Records a worker thread as alive and returns the function that records its end. Calling that function twice is
 * harmless (a worker terminated by a fault and again by dispose). The count is what every trace line reports.
 */
export function trackWorker(): () => void {
  liveWorkerCount++
  let done = false
  return () => {
    if (done) return
    done = true
    liveWorkerCount--
  }
}

/** How many worker threads are recorded alive now. */
export function liveWorkers(): number {
  return liveWorkerCount
}

/** The narrow view of `performance` this module reads (Chromium's `memory` is non-standard, hence optional). */
export interface HeapSource {
  memory?: { usedJSHeapSize?: number }
  measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>
}

/** JS heap bytes in use when the browser exposes them synchronously (Chromium's performance.memory), else null. */
export function heapBytesNow(perf: HeapSource | undefined): number | null {
  const used = perf?.memory?.usedJSHeapSize
  return typeof used === 'number' && Number.isFinite(used) && used >= 0 ? used : null
}

/** Bytes to MiB at one decimal place. */
export function toMiB(bytes: number): number {
  return Math.round(bytes / 1048576 * 10) / 10
}

/** Where the browser attributes an entry: the first attribution's container type, or "self" without one. */
export function whereOf(entry: LongTaskEntry): string {
  const a = entry.attribution?.[0]
  if (!a) return 'self'
  const type = a.containerType || 'unknown'
  return a.containerName ? `${type} ${a.containerName}` : a.containerSrc ? `${type} ${a.containerSrc}` : type
}

/** The trace line for one entry, with the heap figure and the worker count the caller measured. */
export function traceOf(entry: LongTaskEntry, heapBytes: number | null, workers: number): LongTaskTrace {
  return {
    startMs: Math.round(entry.startTime * 10) / 10,
    durationMs: Math.round(entry.duration * 10) / 10,
    where: whereOf(entry),
    heapMiB: heapBytes === null ? 'n/a' : toMiB(heapBytes),
    workers,
  }
}

/**
 * A burst-then-count rate limiter: the first TRACE_BURST calls of a window pass, the rest of the window's calls are
 * counted and `drained` tells how many were dropped when the next window opens (zero while nothing was dropped).
 */
export class TraceLimiter {
  private windowStart = -Infinity
  private passed = 0
  private dropped = 0
  private readonly burst: number
  private readonly windowMs: number

  constructor(burst = TRACE_BURST, windowMs = TRACE_WINDOW_MS) {
    this.burst = burst
    this.windowMs = windowMs
  }

  /** Whether a trace at `nowMs` may be written; `dropped` is reset at each new window after it is read. */
  allow(nowMs: number): boolean {
    if (nowMs - this.windowStart >= this.windowMs) {
      this.windowStart = nowMs
      this.passed = 0
    }
    if (this.passed < this.burst) { this.passed++; return true }
    this.dropped++
    return false
  }

  /** The count of traces dropped so far, and clears it. */
  drain(): number {
    const n = this.dropped
    this.dropped = 0
    return n
  }
}

/** The pieces of the global this module touches, so a test can hand in fakes (and a browser without them is a no-op). */
export interface LongTaskGlobals {
  PerformanceObserver?: {
    new (cb: (list: { getEntries(): LongTaskEntry[] }) => void): { observe(o: { type?: string; entryTypes?: string[]; buffered?: boolean }): void; disconnect(): void }
    supportedEntryTypes?: readonly string[]
  }
  performance?: HeapSource & { now?(): number }
  crossOriginIsolated?: boolean
}

/** Where the trace lines go: console.debug by default (silent at the default console level in most browsers). */
export type TraceSink = (tag: string, trace: LongTaskTrace | { dropped: number; windowMs: number }) => void

/**
 * Installs the observer and returns the function that uninstalls it. Returns a no-op (and installs nothing) where the
 * global has no PerformanceObserver or it does not support `longtask`. Each entry yields one sink call, rate-limited;
 * when a window dropped traces the next trace is preceded by one `{ dropped }` line. The heap comes from
 * performance.memory when the browser has it; on a cross-origin isolated page without it,
 * measureUserAgentSpecificMemory is asked and the line is written when it answers (its figure is then "n/a" only
 * if that fails); with neither, "n/a".
 */
export function watchLongTasks(sink: TraceSink = (tag, t) => console.debug(tag, t), g: LongTaskGlobals = globalThis as never, limiter = new TraceLimiter()): () => void {
  const PO = g.PerformanceObserver
  if (typeof PO !== 'function') return () => {}
  const types = PO.supportedEntryTypes
  if (!Array.isArray(types) || !types.includes('longtask')) return () => {}
  const perf = g.performance
  const now = () => (typeof perf?.now === 'function' ? perf.now() : Date.now())
  const workers = () => liveWorkers()
  const write = (entry: LongTaskEntry, heap: number | null) => {
    const dropped = limiter.drain()
    if (dropped > 0) sink(TRACE_TAG, { dropped, windowMs: TRACE_WINDOW_MS })
    sink(TRACE_TAG, traceOf(entry, heap, workers()))
  }
  let stopped = false
  let observer: { disconnect(): void } | null = null
  try {
    const po = new PO((list) => {
      if (stopped) return
      for (const entry of list.getEntries()) {
        if (!limiter.allow(now())) continue
        const sync = heapBytesNow(perf)
        if (sync !== null || g.crossOriginIsolated !== true || typeof perf?.measureUserAgentSpecificMemory !== 'function') {
          write(entry, sync)
          continue
        }
        const count = workers()
        perf.measureUserAgentSpecificMemory().then(
          (m) => { if (!stopped) write(entry, Number.isFinite(m?.bytes) ? m.bytes : null) },
          () => { if (!stopped) sink(TRACE_TAG, traceOf(entry, null, count)) },
        )
      }
    })
    po.observe({ type: 'longtask', buffered: true })
    observer = po
  } catch {
    // An observer the browser refuses (a webview that lists the type but rejects it) installs nothing.
    return () => {}
  }
  return () => {
    if (stopped) return
    stopped = true
    try { observer?.disconnect() } catch { /* already gone */ }
  }
}
