// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It decides whether the page gets the model its site serves (siteModel.ts) by itself, with
 * no tap, once the city is on screen: the rules (autoVerdict, linkHold) and the one record kept between visits
 * (createAutoRecord). The model is the default wherever the site serves one, so a visitor talks to Sloane without
 * finding a model first, and the page gets it only where that is safe to do unasked:
 * - where this browser can run it and keep it (a copy that could not last would download again on every visit);
 * - where the visitor has not chosen otherwise (the scripted provider, a model server by name, a model file of their own);
 * - where the browser does not say the data costs (data saver on, mobile data, a 2G link: the Network Information API,
 *   which only Chromium has, and only Chrome on Android says which kind of network it is);
 * - where the visitor has not stopped it before (their Stop is remembered: the card's button still gets it in a tap);
 * - and not again and again where it keeps failing: a try that ended short waits an hour, a second one a day, a third
 *   leaves it to the tap. A page that closed in the middle of a try (no pagehide: the system killed it, often for its
 *   memory) leaves a mark with no lock held behind it; the first such mark lets the next visit try once more, the
 *   second leaves it to the tap.
 * One tab gets it at a time (a Web Lock, asked for only if it is free). Nothing here fetches, reads the DOM or the
 * global: the facts, the storage and the locks are handed in, so the Node tests hand it fakes.
 * What breaks if it is removed? The served model would wait for a tap again on every platform, or a page that cannot
 * keep it, a phone on mobile data or a device that dies in the copy would download it on every visit.
 */
import { SITE_MODEL, type SiteModelPin } from './siteModel.ts'

/** Where the record is kept between visits (the page's local storage). */
export const AUTO_KEY = 'civic-simulation:sitemodel:auto:v1'
/** The Web Lock one try holds while it runs, asked for only if it is free: one tab gets the model at a time. */
export const AUTO_LOCK = `${AUTO_KEY}:get`

/** What the browser says of the connection (the Network Information API), each part null where it says nothing. */
export interface Link {
  /** 'cellular', 'wifi', 'ethernet', … (Chrome on Android and ChromeOS only). */
  readonly type: string | null
  /** The visitor asked the browser to save data. */
  readonly saveData: boolean
  /** 'slow-2g', '2g', '3g' or '4g', as measured. */
  readonly effectiveType: string | null
}

/** The connection as `nav` (the page's navigator) reports it, or null where it reports nothing (Firefox, Safari, Brave). */
export function readLink(nav: unknown): Link | null {
  let c: unknown
  try {
    c = (nav as { connection?: unknown } | null | undefined)?.connection
  } catch {
    return null
  }
  if (typeof c !== 'object' || c === null) return null
  const o = c as { type?: unknown; saveData?: unknown; effectiveType?: unknown }
  return {
    type: typeof o.type === 'string' ? o.type : null,
    saveData: o.saveData === true,
    effectiveType: typeof o.effectiveType === 'string' ? o.effectiveType : null,
  }
}

/** Why the connection says not to download unasked, or null: data saver, mobile data, or a 2G link. */
export function linkHold(link: Link | null): string | null {
  if (!link) return null
  if (link.saveData) return 'the browser is set to save data'
  if (link.type === 'cellular') return 'this device is on mobile data'
  if (link.effectiveType === 'slow-2g' || link.effectiveType === '2g') return 'the connection is too slow for it'
  return null
}

/** What the page knows when it decides, all of it read without a request. */
export interface AutoFacts {
  /** Why this page cannot run a model in it (inPageCaps.ts runtimeMode), or null. */
  readonly cannot: string | null
  /** The provider the router is set to (router.ts Provider). */
  readonly provider: string
  /** The model file chosen for the in-page provider, or null. */
  readonly chosen: string | null
  /** The site's model is kept in this page already. */
  readonly kept: boolean
  /** The page can keep files that last (its origin private file system). */
  readonly lasting: boolean
  /** The connection, as readLink read it. */
  readonly link: Link | null
}

/** Go, or the plain reason not to. */
export type AutoVerdict = { readonly go: true } | { readonly go: false; readonly why: string }

/** The providers that ask a model server by name: the visitor chose one, and the page gets nothing unasked. */
const SERVERS: ReadonlySet<string> = new Set(['claude', 'ollama', 'llamacpp', 'openai'])

/**
 * Whether to get the site's model unasked, by the facts alone (the record's holds are asked after, createAutoRecord
 * hold): the browser can run it, no other model was chosen, it is not kept yet, a copy would last, and the connection
 * does not say the data costs. Under auto a model server on this machine still answers first once it is got, so none
 * is looked for here: a look reaches the loopback, which a browser may ask the visitor about before any word of theirs.
 */
export function autoVerdict(f: AutoFacts, pin: SiteModelPin = SITE_MODEL): AutoVerdict {
  const no = (why: string): AutoVerdict => ({ go: false, why })
  if (f.cannot !== null) return no(f.cannot)
  if (f.provider === 'scripted') return no('the scripted provider is chosen')
  if (SERVERS.has(f.provider)) return no(`the ${f.provider} provider is chosen`)
  if (f.provider !== 'auto' && f.provider !== 'inpage') return no(`the ${f.provider} provider is chosen`)
  if (f.chosen !== null && f.chosen !== pin.file) return no(`a model file of your own (${f.chosen}) is chosen`)
  if (f.kept) return no(`${pin.file} is kept in this page already`)
  if (!f.lasting) return no('this browser cannot keep files for the page, so the model would download again on every visit')
  const held = linkHold(f.link)
  if (held !== null) return no(held)
  return { go: true }
}

/** How a try ended, for the record: kept, stopped by the visitor, ended short, or paused (the network changed, the city ended). */
export type AutoOutcome = 'done' | 'stopped' | 'failed' | 'paused'

/** One try in this tab: it ends once, with its outcome (the lock goes with it). */
export interface AutoTry {
  end(outcome: AutoOutcome, now: number): void
}

/** The record between visits (see the file's comment). */
export interface AutoRecord {
  /**
   * Why the page should not try by itself now, or null: the visitor's Stop, the tries that failed (waiting their hour
   * or day, or for good after three), or two pages that closed mid-way. A mark a page left with no lock held behind it
   * is counted here, once, and taken away.
   */
  hold(now: number): Promise<string | null>
  /** The one try in this origin, marked while it runs; null when another tab holds the lock. */
  begin(now: number): Promise<AutoTry | null>
  /** The page is going (pagehide): its own mark goes, so a reload or a closed tab is not counted as a page that died. */
  leave(): void
}

/** The page's local storage, as far as the record uses it. */
export type AutoStore = { getItem(k: string): string | null; setItem(k: string, v: string): void; removeItem(k: string): void }
/** The page's Web Locks, as far as the record uses them. */
export type AutoLocks = {
  request(name: string, options: { ifAvailable: true }, granted: (lock: unknown) => Promise<void> | void): Promise<unknown>
  query(): Promise<{ held?: readonly { name?: string }[] }>
}

/** An hour and a day, in ms: how long the next try waits after the first and the second that ended short. */
export const BACKOFF_MS: readonly number[] = Object.freeze([60 * 60 * 1000, 24 * 60 * 60 * 1000])
/** Tries that end short in a row before the page leaves it to the tap. */
export const FAILS_TO_STOP = 3
/** Pages that close mid-way in a row before the page leaves it to the tap. */
export const KILLS_TO_STOP = 2

/** The visitor's Stop, as the record says it. */
export const STOPPED = 'you stopped it last time, so it waits for the button'

/** The record as kept: v 1, and only what is set. */
interface Saved {
  off?: string
  fails?: number
  failedAt?: number
  kills?: number
  mark?: { at: number; lock: string | null }
}

/** "in 42 minutes", "in 3 hours". */
function inWords(ms: number): string {
  const min = Math.max(1, Math.ceil(ms / 60_000))
  if (min < 90) return `in ${min} minute${min === 1 ? '' : 's'}`
  const h = Math.round(min / 60)
  return `in ${h} hour${h === 1 ? '' : 's'}`
}

/** The record over `store` and `locks` (null: none; then every mark found is a page that died, and tabs are not kept apart). */
export function createAutoRecord(store: AutoStore | null, locks: AutoLocks | null): AutoRecord {
  const read = (): Saved => {
    let raw: string | null = null
    try {
      raw = store?.getItem(AUTO_KEY) ?? null
    } catch {
      return {}
    }
    if (raw === null) return {}
    try {
      const v: unknown = JSON.parse(raw)
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return {}
      const o = v as Record<string, unknown>
      const count = (n: unknown): number | undefined => (typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : undefined)
      const m = o.mark as { at?: unknown; lock?: unknown } | undefined
      return {
        ...(typeof o.off === 'string' && o.off && { off: o.off }),
        ...(count(o.fails) !== undefined && { fails: count(o.fails) }),
        ...(typeof o.failedAt === 'number' && Number.isFinite(o.failedAt) && { failedAt: o.failedAt }),
        ...(count(o.kills) !== undefined && { kills: count(o.kills) }),
        ...(typeof m === 'object' && m !== null && { mark: { at: typeof m.at === 'number' ? m.at : 0, lock: typeof m.lock === 'string' ? m.lock : null } }),
      }
    } catch {
      // Unreadable: nothing held, nothing marked.
      return {}
    }
  }
  const write = (s: Saved): void => {
    try {
      if (!Object.keys(s).length) store?.removeItem(AUTO_KEY)
      else store?.setItem(AUTO_KEY, JSON.stringify({ v: 1, ...s }))
    } catch {
      // storage refused: the record lasts for this visit
    }
  }
  const heldLocks = async (): Promise<ReadonlySet<string> | null> => {
    if (!locks) return null
    try {
      const q = await locks.query()
      return new Set((q.held ?? []).map((l) => l.name).filter((n): n is string => typeof n === 'string'))
    } catch {
      return null
    }
  }
  /** This tab's try, while it runs (its mark is written as `mine`). */
  let mine: { at: number; lock: string | null } | null = null

  return Object.freeze<AutoRecord>({
    hold: async (now) => {
      let s = read()
      // A mark with no lock held behind it: a page that closed mid-way (a mark of this tab's own is never found here).
      if (s.mark && mine === null) {
        const held = s.mark.lock !== null ? await heldLocks() : null
        const alive = s.mark.lock !== null && held !== null && held.has(s.mark.lock)
        if (!alive) {
          s = read()
          const { mark: _gone, ...rest } = s
          const kills = (rest.kills ?? 0) + 1
          s = { ...rest, kills, ...(kills >= KILLS_TO_STOP && !rest.off && { off: 'the page closed while it was getting the model, twice, so it waits for the button' }) }
          write(s)
        } else return 'another tab is getting it'
      }
      if (s.off) return s.off
      const fails = s.fails ?? 0
      if (fails >= FAILS_TO_STOP) return 'the last tries to get it ended short, so it waits for the button'
      if (fails > 0) {
        const wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1]
        const left = (s.failedAt ?? 0) + wait - now
        if (left > 0) return `the last try to get it ended short: the next one is ${inWords(left)}, or now with the button`
      }
      return null
    },

    begin: async (now) => {
      if (mine !== null) return null
      let release = (): void => undefined
      let lock: string | null = null
      if (locks) {
        let free!: () => void
        const held = new Promise<void>((resolve) => { free = resolve })
        const granted = await new Promise<boolean>((resolve) => {
          try {
            locks.request(AUTO_LOCK, { ifAvailable: true }, (l) => {
              if (l === null || l === undefined) {
                resolve(false)
                return
              }
              resolve(true)
              return held
            }).catch(() => resolve(false))
          } catch {
            resolve(false)
          }
        })
        if (!granted) {
          free()
          return null
        }
        lock = AUTO_LOCK
        release = free
      }
      const mark = { at: now, lock }
      mine = mark
      write({ ...read(), mark })
      let ended = false
      return Object.freeze<AutoTry>({
        end: (outcome, at) => {
          if (ended) return
          ended = true
          const { mark: _gone, ...rest } = read()
          let s: Saved = rest
          if (outcome === 'done') s = {}
          else if (outcome === 'stopped') s = { ...rest, off: STOPPED }
          else if (outcome === 'failed') {
            const fails = (rest.fails ?? 0) + 1
            s = { ...rest, fails, failedAt: at }
          }
          // A try that ran to its end (whatever its outcome) is not a page that died: the kills in a row start again.
          if (outcome !== 'paused' && s.kills !== undefined) {
            const { kills: _k, ...no } = s
            s = no
          }
          write(s)
          mine = null
          release()
        },
      })
    },

    leave: () => {
      if (mine === null) return
      const s = read()
      if (s.mark && s.mark.at === mine.at && s.mark.lock === mine.lock) {
        const { mark: _gone, ...rest } = s
        write(rest)
      }
    },
  })
}
