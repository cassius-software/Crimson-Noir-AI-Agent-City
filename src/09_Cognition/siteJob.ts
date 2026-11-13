// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Getting the site's model (siteModel.ts, App.tsx's siteHost) is one job a page runs at a
 * time, started either by the visitor's tap on Sloane's card or by the page itself once the city is on screen
 * (siteAuto.ts). Both show the same progress and the same Stop, wherever Sloane is on screen (her card, her chip), and
 * the card must know how a job it did not start ended (kept: ask the last turn again; ended short: say why). So the job
 * lives here, outside the card: one state any number of views subscribe to (React's useSyncExternalStore), one Stop
 * that only stops before the file is handed to the copy into the page (from then on the copy runs to its end, kept and
 * chosen, so a Stop never leaves half a model behind), and one end each start resolves with. The work itself (the
 * checks, the download, the copy) is handed in; nothing here fetches.
 * What breaks if it is removed? A download the page started by itself would show nowhere and could not be stopped, and
 * a tap during it would be refused as busy with no reason the visitor can see.
 */
import type { SiteModelProgress } from './siteModel.ts'

/** Who started the job: the visitor's tap, or the page by itself. */
export type SiteJobHow = 'tap' | 'auto'
/**
 * Who stopped it: the visitor's Stop, the connection turning costly (siteAuto.ts linkHold), the city ending, or the
 * visitor's other choice made while the page's own download ran (a provider, a model of their own: SiteJobHeld).
 */
export type SiteJobStop = 'person' | 'network' | 'page' | 'choice'

/** Thrown by the work to end the job as stopped (by `by`), not as ended short: nothing went wrong, it is not wanted now. */
export class SiteJobHeld extends Error {
  readonly by: SiteJobStop
  constructor(by: SiteJobStop, message: string) {
    super(message)
    this.name = 'SiteJobHeld'
    this.by = by
  }
}

/** Where the job is: running (downloading, then keeping), or how it ended. Every job has its own id. */
export type SiteJobState =
  | { readonly id: number; readonly how: SiteJobHow; readonly phase: 'running'; readonly step: SiteModelProgress['step']; readonly done: number; readonly total: number }
  | { readonly id: number; readonly how: SiteJobHow; readonly phase: 'done'; readonly line: string }
  | { readonly id: number; readonly how: SiteJobHow; readonly phase: 'failed'; readonly why: string }
  | { readonly id: number; readonly how: SiteJobHow; readonly phase: 'stopped'; readonly by: SiteJobStop }

/** The work: checks, downloads, keeps and chooses the model, telling its progress; resolves with a plain line. */
export type SiteGet = (how: SiteJobHow, onProgress: (p: SiteModelProgress) => void, signal: AbortSignal) => Promise<string>

/** The one job (see the file's comment). */
export interface SiteJob {
  /** Where the job is now (null: none has run this visit). The same object until it changes. */
  state(): SiteJobState | null
  /** Called after every change of state(); returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Starts a job (one running already is returned instead, whoever started it); resolves with how it ended. */
  start(how: SiteJobHow): Promise<SiteJobState>
  /** Stops the running job, unless its file is with the copy already; true when it stopped. */
  stop(by: SiteJobStop): boolean
}

/** An error's message as one plain sentence. */
const said = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** The job over `get` (see the file's comment). */
export function createSiteJob(get: SiteGet): SiteJob {
  let cur: SiteJobState | null = null
  let seq = 0
  /** The running job's abort, its end, and whether its file is with the copy. */
  let run: { id: number; ctl: AbortController; end: Promise<SiteJobState>; handed: boolean } | null = null
  const listeners = new Set<() => void>()
  const put = (s: SiteJobState): void => {
    cur = s
    for (const l of [...listeners]) {
      try {
        l()
      } catch {
        // one view's failure is not the job's
      }
    }
  }

  const job: SiteJob = {
    state: () => cur,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start: (how) => {
      if (run !== null) return run.end
      const id = ++seq
      const ctl = new AbortController()
      // The job is running before the work is called, so a work that reports or fails at once finds it.
      const r: { id: number; ctl: AbortController; end: Promise<SiteJobState>; handed: boolean } = { id, ctl, end: Promise.resolve(null as unknown as SiteJobState), handed: false }
      run = r
      put({ id, how, phase: 'running', step: 'download', done: 0, total: 0 })
      r.end = (async (): Promise<SiteJobState> => {
        try {
          const line = await get(how, (p) => {
            if (run !== r || cur?.id !== id || cur.phase !== 'running') return
            if (p.step === 'keep') r.handed = true
            put({ id, how, phase: 'running', step: p.step, done: p.done, total: p.total })
          }, ctl.signal)
          const done: SiteJobState = { id, how, phase: 'done', line }
          put(done)
          return done
        } catch (e) {
          // A stop has said so already (stop puts it at once); a work that held itself back stopped; anything else ended
          // short, with its reason.
          if (cur?.id === id && cur.phase === 'stopped') return cur
          if (e instanceof SiteJobHeld) {
            const stopped: SiteJobState = { id, how, phase: 'stopped', by: e.by }
            put(stopped)
            return stopped
          }
          const failed: SiteJobState = { id, how, phase: 'failed', why: said(e) }
          put(failed)
          return failed
        } finally {
          if (run === r) run = null
        }
      })()
      return r.end
    },
    stop: (by) => {
      const r = run
      if (r === null || r.handed || cur?.id !== r.id || cur.phase !== 'running') return false
      // Said at once, so the view drops its Stop now; the work's own rejection, when it comes, changes nothing.
      put({ id: r.id, how: cur.how, phase: 'stopped', by })
      r.ctl.abort(new DOMException(`stopped (${by})`, 'AbortError'))
      return true
    },
  }
  return Object.freeze(job)
}
