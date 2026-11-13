// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It decides whether the page gets the model its site serves (siteModel.ts) by itself, with
 * no tap, once the city is on screen: the rules (autoVerdict, linkHold) and the one record kept between visits
 * (createAutoRecord). The model is the default wherever the site serves one, so a visitor talks to Sloane without
 * finding a model first, and the page gets it only where that is safe to do unasked:
 * - where this browser can run it and keep it (a copy that could not last would download again on every visit), and
 *   can keep this record (a Stop it could not remember would be met again on every visit);
 * - where the visitor has not chosen otherwise (the scripted provider, a model server by name, a model file of their
 *   own, chosen or kept in the page), and is not keeping a file of their own just now;
 * - where the browser does not say the data costs (data saver on, mobile data, a 2G link: the Network Information API,
 *   which only Chromium has, and only Chrome on Android says which kind of network it is);
 * - where the visitor has not stopped it before (their Stop is remembered: the card's button still gets it in a tap);
 * - and not again and again where it keeps failing: a try that ended short waits an hour, a second one a day, a third
 *   leaves it to the tap. A page that closed in the middle of a try (no pagehide: the system killed it, often for its
 *   memory) leaves a mark with no lock held behind it; the first such mark lets the next visit try once more, the
 *   second leaves it to the tap.
 * One tab gets it at a time (a Web Lock, asked for only if it is free, which a tapped download in another tab holds
 * too). createSiteAuto runs the page's own start in that order, reads the facts again once it holds the lock, and
 * records how the try ended. Nothing here fetches, reads the DOM or the global: the facts, the storage, the locks and
 * the page's own steps are handed in, so the Node tests hand it fakes.
 * The Windows app runs the same start over the model its installer puts beside the app (siteModel.ts APP_MODEL, read
 * through the shell): its host reports no connection (the copy never leaves the machine), and the words say "app".
 * What breaks if it is removed? The served model would wait for a tap again on every platform, or a page that cannot
 * keep it, a phone on mobile data or a device that dies in the copy would download it on every visit.
 */
import type { SiteJob, SiteJobState } from './siteJob.ts'
import { SITE_MODEL, type SiteModelFrom, type SiteModelPin } from './siteModel.ts'

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
  /**
   * A model file of the visitor's own in this page, or null: the one chosen for the in-page provider, else any kept
   * that is not the site's (under the inpage provider the newest kept file answers when none is chosen).
   */
  readonly own: string | null
  /** Why a model file is being kept in this page just now (a pick, a drop, the console), or null. */
  readonly busy: string | null
  /** The site's model is kept in this page already. */
  readonly kept: boolean
  /** The page can keep files that last: its origin private file system answers. */
  readonly lasting: boolean
  /** The page can keep this record (createAutoRecord remembers), so a Stop is remembered. */
  readonly remembers: boolean
  /** The connection, as readLink read it. */
  readonly link: Link | null
}

/** Go, or the plain reason not to. */
export type AutoVerdict = { readonly go: true } | { readonly go: false; readonly why: string }

/** The providers that ask a model server by name: the visitor chose one, and the page gets nothing unasked. */
const SERVERS: ReadonlySet<string> = new Set(['claude', 'ollama', 'llamacpp', 'openai'])

/**
 * Whether to get the site's model unasked, by the facts alone (the record's holds are asked after, createAutoRecord
 * hold): the browser can run it, no other model was chosen or kept, no file is being kept, it is not kept yet, a copy
 * and this record would last, and the connection does not say the data costs. Under auto a model server on this
 * machine (Ollama, llama.cpp, an OpenAI-compatible server) still answers first once it is got, so none is looked for
 * here: a look reaches the loopback, which a browser may ask the visitor about before any word of theirs.
 */
export function autoVerdict(f: AutoFacts, pin: SiteModelPin = SITE_MODEL): AutoVerdict {
  const no = (why: string): AutoVerdict => ({ go: false, why })
  if (f.cannot !== null) return no(f.cannot)
  if (f.provider === 'scripted') return no('the scripted provider is chosen')
  if (SERVERS.has(f.provider)) return no(`the ${f.provider} provider is chosen`)
  if (f.provider !== 'auto' && f.provider !== 'inpage') return no(`the ${f.provider} provider is chosen`)
  if (f.own !== null && f.own !== pin.file) return no(`a model file of your own (${f.own}) is in this page`)
  if (f.busy !== null) return no(f.busy)
  if (f.kept) return no(`${pin.file} is kept in this page already`)
  if (!f.lasting) return no('this browser cannot keep files for the page, so the model would download again on every visit')
  if (!f.remembers) return no('this browser cannot keep the page\'s record of it, so a Stop could not be remembered')
  const held = linkHold(f.link)
  if (held !== null) return no(held)
  return { go: true }
}

/** How a try ended, for the record: kept, stopped by the visitor, ended short, or paused (the network, a choice, the city's end). */
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
  /**
   * The one try in this origin, marked while it runs; or why not: another tab holds the lock, or a hold another tab
   * wrote since this one asked (its Stop, its try that ended short) is read again once the lock is this tab's.
   */
  begin(now: number): Promise<AutoTry | string>
  /**
   * A tapped download in this tab: the lock while it is free, so another tab's page does not start beside it (no mark:
   * a tap the system ends is not the page's try); returns its release, which does nothing where it was not free.
   */
  claim(): Promise<() => void>
  /** This browser keeps the record (its local storage takes a write), so a Stop can be remembered. */
  remembers(): boolean
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

/** The same mark: the same try's. */
const sameMark = (a: { at: number; lock: string | null }, b: { at: number; lock: string | null }): boolean => a.at === b.at && a.lock === b.lock

/** Why the record holds the page back now (the visitor's Stop, tries that ended short), or null; marks aside. */
function heldBy(s: Saved, now: number): string | null {
  if (s.off) return s.off
  const fails = s.fails ?? 0
  if (fails >= FAILS_TO_STOP) return 'the last tries to get it ended short, so it waits for the button'
  if (fails > 0) {
    const wait = BACKOFF_MS[Math.min(fails, BACKOFF_MS.length) - 1]
    const left = (s.failedAt ?? 0) + wait - now
    if (left > 0) return `the last try to get it ended short: the next one is ${inWords(left)}, or now with the button`
  }
  return null
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
  /** The lock, if it is free: its release, or null where another tab holds it (or the browser refused). */
  const take = async (): Promise<(() => void) | null> => {
    if (!locks) return null
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
    return free
  }
  /** This tab's try, while it runs (its mark is written as `mine`), and whether a tap of this tab holds the lock. */
  let mine: { at: number; lock: string | null } | null = null
  let claimed = false

  return Object.freeze<AutoRecord>({
    hold: async (now) => {
      let s = read()
      // A mark with no lock held behind it: a page that closed mid-way (a mark of this tab's own is never found here).
      if (s.mark && mine === null) {
        const judged = s.mark
        const held = judged.lock !== null ? await heldLocks() : null
        if (judged.lock !== null && held !== null && held.has(judged.lock)) return 'another tab is getting it'
        // Read again after the wait: counted only if it is still the mark judged, so two tabs that judged the same dead
        // mark count it once, and a mark another tab took away (its try ended) or wrote since is not counted at all.
        s = read()
        if (s.mark && sameMark(s.mark, judged)) {
          const { mark: _gone, ...rest } = s
          const kills = (rest.kills ?? 0) + 1
          s = { ...rest, kills, ...(kills >= KILLS_TO_STOP && !rest.off && { off: 'the page closed while it was getting the model, twice, so it waits for the button' }) }
          write(s)
        } else if (s.mark) return 'another tab is getting it'
      }
      return heldBy(s, now)
    },

    begin: async (now) => {
      if (mine !== null || claimed) return 'it is being got in this tab already'
      let release = (): void => undefined
      let lock: string | null = null
      if (locks) {
        const free = await take()
        if (!free) return 'another tab is getting it'
        lock = AUTO_LOCK
        release = free
      }
      // What another tab wrote since hold() (its Stop, its try that ended short) holds this one back too.
      const why = heldBy(read(), now)
      if (why !== null) {
        release()
        return why
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

    claim: async () => {
      if (mine !== null || claimed) return () => undefined
      const free = await take()
      if (!free) return () => undefined
      claimed = true
      let done = false
      return () => {
        if (done) return
        done = true
        claimed = false
        free()
      }
    },

    remembers: () => {
      if (!store) return false
      const probe = `${AUTO_KEY}:probe`
      try {
        store.setItem(probe, '1')
        store.removeItem(probe)
        return true
      } catch {
        return false
      }
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

/** What the page's own start needs of the page (App.tsx hands the real ones, the tests fakes). */
export interface AutoHost {
  /** Resolves once the page is in view (at once when it is), or once the city ends. */
  seen(): Promise<void>
  /** Why nothing more may start (the city ended or halted), or null. */
  ended(): string | null
  /** The page is the web copy, served with a model beside it (or the Windows app, which can read the one it carries). */
  served(): boolean
  /** The facts, read now, with no request. */
  facts(): Promise<AutoFacts>
  /** The site's offer of the pin (it asks for the manifest), or null where it serves none; kept: this browser has it. */
  offer(): Promise<{ readonly kept: boolean } | null>
  /** Why this device or its storage cannot take it now (the checks a tap meets), or null. */
  refusal(): Promise<string | null>
  /** The connection as the browser reports it now (null where the copy uses none: the app's own file, the launcher's). */
  link(): Link | null
  /** Calls back on each change of the connection; returns the unsubscribe. */
  onLink(changed: () => void): () => void
  /** The browser says it is offline. */
  offline(): boolean
  readonly record: AutoRecord
  readonly job: SiteJob
  /** Tells the visitor (a toast). */
  say(line: string): void
  now(): number
}

/** The page's own start's words for where the model comes from (siteModel.ts SiteModelFrom). */
const WHERE = Object.freeze({
  site: Object.freeze({ unserved: 'only the web copy is served with a model beside it', none: 'this site serves no model beside the page' }),
  app: Object.freeze({ unserved: 'this app cannot read a model of its own', none: 'this app carries no model (the installer puts one beside the app; the bare .exe has none)' }),
  launcher: Object.freeze({ unserved: 'only a page the launcher opened with models=1 is served its model', none: 'the launcher serves no model beside the page (its package was built without one, or another server took its address)' }),
})

/**
 * How a try that ended short is recorded: as a pause when the connection says why (it turned costly, or dropped) or
 * the visitor chose otherwise meanwhile, so a train ride does not count against the next visit; else as ended short.
 */
function outcomeOf(end: SiteJobState, link: string | null, offline: boolean): AutoOutcome {
  if (end.how !== 'auto') return 'paused'
  if (end.phase === 'done') return 'done'
  if (end.phase === 'stopped') return end.by === 'person' ? 'stopped' : 'paused'
  if (end.phase === 'failed') return link !== null || offline ? 'paused' : 'failed'
  return 'paused'
}

/**
 * The page's own start, run once a city (the returned function says why it did or did not get the model, for the
 * console): once the page is in view, where its source serves it a model (the web copy, the Windows app, the page the
 * NixOS launcher opened), the facts (autoVerdict), the record's holds, the site's manifest naming the pin, the
 * device's and the storage's room, then the lock; once the lock is this tab's the facts are read again, so what
 * changed while it asked (the connection, a pick, a provider, another tab's keep, the city's halt) holds it back. The
 * connection turning costly while it downloads stops it. How it ended goes in the record, and to the visitor in a
 * toast: kept, ended short (why), or waiting for a better connection.
 */
export function createSiteAuto(h: AutoHost, pin: SiteModelPin = SITE_MODEL, who = 'Sloane', from: SiteModelFrom = 'site'): () => Promise<string> {
  const where = WHERE[from]
  let ran = false
  return async () => {
    if (ran) return 'the page has looked already this visit'
    ran = true
    await h.seen()
    const ended = h.ended()
    if (ended !== null) return ended
    if (!h.served()) return where.unserved
    const first = autoVerdict(await h.facts(), pin)
    if (!first.go) return first.why
    const held = await h.record.hold(h.now())
    if (held !== null) return held
    const offer = await h.offer()
    if (!offer) return where.none
    if (offer.kept) return `${pin.file} is kept in this page already`
    const refused = await h.refusal()
    if (refused !== null) return refused
    if (h.job.state()?.phase === 'running') return 'it is being got already'
    const attempt = await h.record.begin(h.now())
    if (typeof attempt === 'string') return attempt
    // The lock is this tab's: the facts again, for what changed while it asked.
    const late = h.ended()
    const again = late !== null ? { go: false as const, why: late } : autoVerdict(await h.facts(), pin)
    if (!again.go) {
      attempt.end('paused', h.now())
      return again.why
    }
    const unlink = h.onLink(() => { if (linkHold(h.link()) !== null) h.job.stop('network') })
    let end: SiteJobState
    try {
      end = await h.job.start('auto')
    } finally {
      unlink()
    }
    const costly = linkHold(h.link())
    const offline = h.offline()
    const outcome = outcomeOf(end, costly, offline)
    attempt.end(outcome, h.now())
    const later = `the page gets it on a later visit, or now with the button on ${who}'s card`
    if (end.how === 'auto') {
      if (end.phase === 'done') h.say(end.line)
      else if (end.phase === 'failed' && outcome === 'failed') h.say(`${who}'s model was not kept: ${end.why}`)
      else if ((end.phase === 'failed' || (end.phase === 'stopped' && end.by === 'network')) && outcome === 'paused') h.say(`${who}'s model waits: ${costly ?? 'the connection dropped'}; ${later}`)
    }
    if (end.phase === 'done') return end.line
    if (end.phase === 'failed') return outcome === 'paused' ? `paused: ${costly ?? 'the connection dropped'} (${end.why})` : end.why
    return `stopped (${end.phase === 'stopped' ? end.by : end.phase})`
  }
}
