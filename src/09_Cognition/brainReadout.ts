// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one read-only answer to two questions: which brain Sloane is using (a model
 * server, the model the app carries, the model kept in this page, or the scripted planner when nothing answers), and
 * how the model this build gets for her by default stands (kept, on its way, checked by the app, held back and why).
 * The first walk's machine check reads it, the console's `ask` prints it as its brain row (operator.ts mindStatus),
 * and the browser smoke reads it through ?debug's window.__SIM__.brain. It reads only what the page holds in memory
 * already: the router's provider, where auto's looks stand and the model it has (router.ts lookState and settings),
 * what the app last said of the model it carries (nativeMind.ts status and present), whether this page keeps no model
 * file as last listed (inPage.ts empty), the site's model's job (siteJob.ts state) and what the page knows of that
 * model (SiteFacts, App.tsx). A model chosen that the page already knows cannot run here is the scripted planner, said
 * with why. It never asks a provider for its models or an answer, never fetches the site's manifest, never starts the
 * job and never asks the shell, so reading it, however often, starts no look and no download. The router, the job
 * and the app's model tell it of their changes. buildBrain is the rule, pure; createBrainReadout reads the sources
 * and keeps one readout, the same frozen object until something in it changes, and tells its listeners once per
 * change (React's useSyncExternalStore can read it directly); bindBrain, readBrain and subscribeBrain are the
 * module's one accessor, which App.tsx binds as the city (or the console alone) builds its router, so a reader
 * imports them and needs no props passed down. Before anything is bound, readBrain returns BRAIN_UNKNOWN. This module
 * imports types only, so importing it costs a reader nothing.
 * What breaks if it is removed? The walk and the console would each have to probe for themselves, and a probe can
 * start a look at this machine or a download nobody asked for.
 */
import type { NativeHeard } from './nativeMind.ts'
import type { MindRouter, RouterLook } from './router.ts'
import type { SiteJob, SiteJobState, SiteJobStop } from './siteJob.ts'

/**
 * Which brain answers Sloane: a model server (one on this machine, or the gateway to the Claude API, which answers from
 * off this machine), the model the app carries and runs itself, the model file kept in this page, or the scripted
 * planner (router.ts calls that provider `scripted`).
 */
export type Brain = 'server' | 'app' | 'page' | 'scripted'
/**
 * Where the default model comes from: the web copy's own site, the file the Windows app carries (copied into the
 * page), the NixOS launcher (siteModel.ts SiteModelFrom), or the runner inside the Linux and macOS apps (nativeMind.ts).
 */
export type DefaultFrom = 'site' | 'app' | 'launcher' | 'native'
/**
 * How the default model stands: `kept` (ready on this device: kept in this page, or the app's own file checked),
 * `getting` (on its way into this page: its bytes arriving, then kept), `checking` (the app checks its file),
 * `held` (not got now: `why` says why), `waiting` (the page has not decided yet: it does once the city is on screen),
 * `none` (this page is served no default model).
 */
export type DefaultState = 'kept' | 'getting' | 'checking' | 'held' | 'waiting' | 'none'

/** The default model and how it stands. */
export interface BrainDefault {
  readonly from: DefaultFrom
  readonly file: string
  /** Its plain name (siteModel.ts SiteModelPin title), or the file's name where the app carries another. */
  readonly title: string
  /** Its size in bytes (0 where nothing said it). */
  readonly bytes: number
  readonly state: DefaultState
  /** While `getting`: 'download' (its bytes arrive) or 'keep' (it is copied into the page's storage); else null. */
  readonly step: 'download' | 'keep' | null
  /** While `getting` or `checking`: how far that step is, in bytes (both 0 before the first count, and otherwise). */
  readonly done: number
  readonly total: number
  /** Why it is `held`; for `none`, why the page said so (null until it has). Null otherwise. */
  readonly why: string | null
}

/** The readout (see the file's comment). Frozen; the same object until something in it changes. */
export interface BrainReadout {
  /** The provider the router is set to (router.ts Provider: auto by default); null before anything is bound. */
  readonly provider: string | null
  /**
   * Which brain answers is known: false before anything is bound, and under auto before a look stands, during one, and
   * while its next answer looks again for a reason the page knows (its default model kept since a look found nothing,
   * or the model found cannot run here now).
   */
  readonly settled: boolean
  /**
   * Which brain answers (null while not settled). Under auto after a look that found nothing: 'scripted', unless the
   * page has kept its default model since (then not settled: the next answer looks again and finds it). A model chosen
   * by name that the page already knows cannot run here (the app's runner failed or is absent; this page cannot run a
   * model, or keeps no model file): 'scripted', and `where` says why.
   */
  readonly brain: Brain | null
  /** The brain is a model on this device: a server on this machine (not the gateway), the app's model or the page's. */
  readonly local: boolean
  /** The brain is the gateway to the Claude API, which answers from off this machine (never called local). */
  readonly gateway: boolean
  /** The address a server brain answers at; null for every other brain. */
  readonly server: string | null
  /** The model's name: the server's, the app's file, the page's file; null for the scripted planner and when unknown. */
  readonly model: string | null
  /** All of the above and the default model, as one plain line (the console's brain row). */
  readonly where: string
  /** While the default model is on its way into this page (`getting`, either step): how far, in bytes; else null. */
  readonly downloading: { readonly done: number; readonly total: number } | null
  /** The default model, or null where nothing gets one here (the console alone, a page with no source bound). */
  readonly default: BrainDefault | null
}

/**
 * What the page knows of the site's model (App.tsx, from memory; its source's words are siteModel.ts SiteModelFrom):
 * whether this page is one its source serves a model to, why this page cannot run it (inPageCaps.ts runtimeMode), the
 * source's offer as last heard (true: it serves the pin; false: it serves none; null: not asked yet, or it could not
 * say), whether it is kept in this page as last read (or chosen there), and the line the page's own start ended with
 * (siteAuto.ts createSiteAuto; null until it has).
 */
export interface SiteFacts {
  readonly from: 'site' | 'app' | 'launcher'
  readonly file: string
  readonly title: string
  readonly bytes: number
  readonly served: boolean
  readonly refusal: string | null
  readonly offered: boolean | null
  readonly kept: boolean
  readonly decided: string | null
}

/** Everything buildBrain decides by, read from memory (createBrainReadout reads it from the sources). */
export interface BrainFacts {
  /** The provider the router is set to. */
  readonly provider: string
  /** Where auto's looks stand. */
  readonly look: RouterLook
  /**
   * The answering provider's server and model as the router has them: the name a server's placeholder resolved to at
   * an answer; null while it has not (or no model is chosen).
   */
  readonly server: string
  readonly model: string | null
  /** What the app last said of the model it carries (null: no runner, no model, nothing heard yet). */
  readonly native: NativeHeard | null
  /** Known from memory that this page has no app model to run (a browser, a shell without the runner, an app with none). */
  readonly appAbsent: boolean
  /** Known from memory that this page keeps no model file, as last listed (inPage.ts empty). */
  readonly pageEmpty: boolean
  readonly site: SiteFacts | null
  readonly job: SiteJobState | null
}

/** The readout before anything is bound: nothing known yet. */
export const BRAIN_UNKNOWN: BrainReadout = Object.freeze({
  provider: null,
  settled: false,
  brain: null,
  local: false,
  gateway: false,
  server: null,
  model: null,
  where: "Sloane's brain is not known yet: the page has not built her mind",
  downloading: null,
  default: null,
})

/** The brain each provider is (router.ts Provider; auto is whichever it found). */
const BRAIN_OF: Readonly<Record<string, Brain>> = Object.freeze({
  ollama: 'server', llamacpp: 'server', openai: 'server', claude: 'server', native: 'app', inpage: 'page', scripted: 'scripted',
})

/** Why a job someone stopped did not get the model, in plain words (siteJob.ts SiteJobStop). */
const STOPPED_BY: Readonly<Record<SiteJobStop, string>> = Object.freeze({
  person: "it was stopped: the button on Sloane's card gets it",
  network: 'the connection turned costly while it came, so it waits for a later visit',
  page: 'the city ended before it arrived',
  choice: 'another model was chosen while it came',
})

/**
 * The name a server's model goes by until an answer says which it is (localCompute.ts ANY_MODEL: the model the server
 * has loaded, else the first it lists): no name yet. A types-only module cannot import it; the tests hold the two equal.
 */
const PLACEHOLDER = 'default'
/**
 * Why the app's model cannot run where the page knows it has none (nativeMind.ts NO_RUNNER, the words the provider's
 * own refusal uses). A types-only module cannot import it; the tests hold the two equal.
 */
const NO_APP_MODEL = 'this page is not inside an app that runs a model itself'
/** Why the page's model cannot run where the page knows it keeps no file (the start of inPage.ts NO_MODEL). */
const NO_PAGE_MODEL = 'no model file is kept in this page'

/** Why a default model the page got this visit is not kept now (ask file forget removed it). */
const FORGOTTEN = "it is no longer kept in this page, and the button on Sloane's card gets it again"

/** A share in whole percent (0 with nothing to count). */
const pct = (done: number, total: number): number => (total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0)

/** The default model by the facts: the app's own runner's first, else the site's model's. */
function defaultOf(f: BrainFacts): BrainDefault | null {
  const n = f.native
  const s = f.site
  if (n !== null) {
    const same = s !== null && s.file === n.file
    const base = { from: 'native' as const, file: n.file, title: same ? s.title : n.file, bytes: n.bytes ?? (same ? s.bytes : 0), step: null, done: 0, total: 0, why: null }
    const st = n.status
    if (st.state === 'preparing') return Object.freeze({ ...base, state: 'checking', done: st.done, total: st.total })
    if (st.state === 'failed') return Object.freeze({ ...base, state: 'held', why: st.reason })
    return Object.freeze({ ...base, state: 'kept' })
  }
  if (s === null) return null
  const j = f.job
  const base = { from: s.from, file: s.file, title: s.title, bytes: s.bytes, step: null, done: 0, total: 0, why: null }
  if (j?.phase === 'running') return Object.freeze({ ...base, state: 'getting', step: j.step, done: j.done, total: j.total })
  // Kept by the facts alone: a job that ended 'done' says only that it was got this visit.
  if (s.kept) return Object.freeze({ ...base, state: 'kept' })
  // Served none: no default model comes to this page, whether or not it could run one.
  if (!s.served || s.offered === false) return Object.freeze({ ...base, state: 'none', why: s.decided })
  if (s.refusal !== null) return Object.freeze({ ...base, state: 'held', why: s.refusal })
  // Got this visit, but no longer kept (ask file forget): said so, not kept.
  if (j?.phase === 'done') return Object.freeze({ ...base, state: 'held', why: FORGOTTEN })
  if (j?.phase === 'failed') return Object.freeze({ ...base, state: 'held', why: j.why })
  if (j?.phase === 'stopped') return Object.freeze({ ...base, state: 'held', why: STOPPED_BY[j.by] })
  if (s.decided !== null) return Object.freeze({ ...base, state: 'held', why: s.decided })
  return Object.freeze({ ...base, state: 'waiting' })
}

/** The default model's part of the line, after the brain's ('' where it adds nothing). */
function defaultLine(d: BrainDefault | null, brain: Brain | null, model: string | null): string {
  if (d === null) return ''
  const name = `her default model (${d.title})`
  if (d.state === 'getting') {
    const how = d.step === 'keep' ? 'being kept in this page' : d.from === 'site' ? 'downloading from this site' : `being copied from the ${d.from === 'app' ? 'app' : 'launcher'}`
    return `; ${name} is ${how}, ${pct(d.done, d.total)}%`
  }
  if (d.state === 'checking') return `; the app is checking ${name}, ${pct(d.done, d.total)}%`
  if (d.state === 'kept') {
    // Said once: the brain's own part names the file already when it is the one answering.
    if ((brain === 'page' || brain === 'app') && model === d.file) return ''
    return `; ${name} is ${d.from === 'native' ? 'ready in the app' : 'kept in this page'}`
  }
  if (d.state === 'held') return `; ${name} waits: ${d.why ?? 'the page did not say why'}`
  if (d.state === 'waiting') return `; ${name} is not decided yet: the page decides once the city is on screen`
  return ''
}

/**
 * Why the brain `chosen` (by name, or found by auto) cannot run here by what the page already knows, or null: the
 * app's runner failed, or this page has no app model to run; this page cannot run a model, or keeps no model file.
 */
function cannotRun(f: BrainFacts, chosen: Brain | null): string | null {
  if (chosen === 'app') return f.native?.status.state === 'failed' ? f.native.status.reason : f.appAbsent ? NO_APP_MODEL : null
  if (chosen === 'page') return f.site?.refusal ?? (f.pageEmpty ? NO_PAGE_MODEL : null)
  return null
}

/** The readout the facts give (see the file's comment). Pure: the same facts give an equal readout. */
export function buildBrain(f: BrainFacts): BrainReadout {
  const auto = f.provider === 'auto'
  const d = defaultOf(f)
  // Under auto a look that found nothing leaves the next answer to look again; once the page has its default model
  // kept where this page can run it, that look finds it (keeping it chose it): the scripted planner is not next.
  const pageKept = d !== null && d.from !== 'native' && d.state === 'kept' && f.site?.refusal == null && !f.pageEmpty
  const picked = auto ? (f.look.looking ? null : f.look.found ?? (f.look.looked && !pageKept ? 'scripted' : null)) : f.provider
  const chosen = picked !== null ? BRAIN_OF[picked] ?? null : null
  // The model picked cannot run here, by what the page already knows: chosen by name, the scripted planner answers
  // every ask; found by auto, the next answer looks again.
  const cannot = cannotRun(f, chosen)
  const answering = cannot === null ? picked : auto ? null : 'scripted'
  const brain = answering !== null ? BRAIN_OF[answering] ?? null : null
  const gateway = answering === 'claude'
  const server = brain === 'server' ? f.server : null
  const model = brain === 'server' || brain === 'page' ? f.model : brain === 'app' ? f.native?.file ?? null : null
  const named = model !== null ? ` (${model})` : ''
  const what = chosen === 'app' ? 'the model this app carries' : 'the model kept in this page'
  const head = brain === null ? (auto && f.look.looking ? 'Sloane is looking for a model on this machine'
    : auto && cannot !== null ? `Sloane looks for a model on this machine again at her next answer: ${what}, found at the last look, cannot run here now (${cannot})`
      : auto && f.look.looked ? 'Sloane looks for a model on this machine again at her next answer: none answered at the last look'
        : auto ? 'Sloane has found no model yet: her next answer looks on this machine'
          : `Sloane's brain is not known: the ${f.provider} provider is not one this readout knows`)
    : cannot !== null ? `Sloane is set to ${what}, but it cannot run here (${cannot}): the scripted planner answers`
      : gateway ? `Sloane answers through the gateway at ${server}${named}, which asks the Claude API off this machine`
        : brain === 'server' ? `Sloane answers with ${answering} at ${server}${named}, a model server on this machine`
          : brain === 'app' ? `Sloane answers with the model this app carries${named}, run by the app on this device`
            : brain === 'page' ? `Sloane answers with the model kept in this page${named}, run on this device`
              : auto ? 'Sloane answers from the scripted planner: no model answered at the last look on this machine'
                : 'Sloane answers from the scripted planner, as chosen: no model is asked'
  return Object.freeze({
    provider: f.provider,
    settled: brain !== null,
    brain,
    local: brain === 'app' || brain === 'page' || (brain === 'server' && !gateway),
    gateway,
    server,
    model,
    // The reason the head gave is not said twice by the default's part.
    where: `${head}${cannot !== null && d?.state === 'held' && d.why === cannot ? '' : defaultLine(d, brain, model)}`,
    downloading: d?.state === 'getting' ? Object.freeze({ done: d.done, total: d.total }) : null,
    default: d,
  })
}

/** What createBrainReadout reads, and nothing else of them: no call here asks a provider, a server or the shell anything. */
export interface BrainSources {
  /** The page's router: its provider, where auto's looks stand, its settings (all from memory) and its change hook. */
  readonly router: Pick<MindRouter, 'provider' | 'lookState' | 'settings' | 'onChange'>
  /**
   * The app's own model (nativeMind.ts): what it last said, whether this page has one to run (false: known absent;
   * null: not asked yet), and its hook for a change of either; absent or null where there is none.
   */
  readonly native?: { status(): NativeHeard | null; present?(): boolean | null; onStatus?(listener: () => void): () => void } | null
  /** The model kept in this page (inPage.ts): whether it keeps no file, as last listed (null: not listed yet). */
  readonly page?: { empty(): boolean | null } | null
  /** The site's model: what the page knows of it, and its one job (state and subscribe only); absent where none is got. */
  readonly site?: { facts(): SiteFacts; readonly job: Pick<SiteJob, 'state' | 'subscribe'> } | null
}

/** One page's readout over its sources. */
export interface BrainStore {
  /** The readout now: read from memory, the same object while nothing in it changed. */
  read(): BrainReadout
  /** Calls `listener` once after each change of read(); returns the unsubscribe. */
  subscribe(listener: () => void): () => void
  /** Reads the sources again and tells the listeners if anything changed (App.tsx, after a fact only it holds changed). */
  refresh(): void
  /** Stops hearing the sources (the city ended); read() still answers. */
  dispose(): void
}

/** The readout over `s` (see the file's comment). */
export function createBrainReadout(s: BrainSources): BrainStore {
  const facts = (): BrainFacts => {
    const r = s.router.settings()
    return {
      provider: s.router.provider,
      look: s.router.lookState(),
      server: r.server,
      model: r.resolved ?? (r.model === PLACEHOLDER ? null : r.model),
      native: s.native?.status() ?? null,
      appAbsent: s.native?.present?.() === false,
      pageEmpty: s.page?.empty() === true,
      site: s.site?.facts() ?? null,
      job: s.site?.job.state() ?? null,
    }
  }
  let last: BrainReadout = buildBrain(facts())
  let key = JSON.stringify(last)
  const listeners = new Set<() => void>()
  /** Reads again; true when the readout changed. */
  const again = (): boolean => {
    const next = buildBrain(facts())
    const k = JSON.stringify(next)
    if (k === key) return false
    last = next
    key = k
    return true
  }
  const tellAll = (): void => {
    for (const l of [...listeners]) {
      try {
        l()
      } catch {
        // one reader's failure is not the readout's
      }
    }
  }
  const refresh = (): void => {
    if (again()) tellAll()
  }
  const offs = [s.router.onChange(refresh), s.site?.job.subscribe(refresh) ?? (() => undefined), s.native?.onStatus?.(refresh) ?? (() => undefined)]
  return Object.freeze<BrainStore>({
    // The router, the job and the app's model announce their changes; one no source announces (a file the in-page mind
    // chose or forgot, a fact App.tsx notes without a refresh) is found by the read itself: its listeners hear it after
    // this turn, never inside the read (React may be rendering).
    read: () => {
      if (again()) queueMicrotask(tellAll)
      return last
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    refresh,
    dispose: () => {
      for (const off of offs.splice(0)) off()
    },
  })
}

/** The store bound now (null: none), how to stop hearing it, and who hears the accessor. */
let bound: BrainStore | null = null
let unhear: () => void = () => undefined
const readers = new Set<() => void>()
const tell = (): void => {
  for (const l of [...readers]) {
    try {
      l()
    } catch {
      // one reader's failure is not the readout's
    }
  }
}

/**
 * Binds `store` as the page's readout (null: none), telling every reader; returns the unbind, which unbinds only while
 * `store` is still the one bound (a city that ended after another began leaves the new one bound).
 */
export function bindBrain(store: BrainStore | null): () => void {
  unhear()
  bound = store
  unhear = store !== null ? store.subscribe(tell) : () => undefined
  tell()
  return () => {
    if (bound === store && store !== null) bindBrain(null)
  }
}

/** The page's readout now, from memory: BRAIN_UNKNOWN before anything is bound. */
export function readBrain(): BrainReadout {
  return bound?.read() ?? BRAIN_UNKNOWN
}

/** Calls `listener` after each change of readBrain(), whichever store is bound (binding one counts); returns the unsubscribe. */
export function subscribeBrain(listener: () => void): () => void {
  readers.add(listener)
  return () => { readers.delete(listener) }
}
