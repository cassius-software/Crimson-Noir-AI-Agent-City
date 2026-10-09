// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the swarm's memory: an episodic ledger per pedestrian, kept on this machine in the
 * page's IndexedDB and keyed by the world seed and the pedestrian's number, so the same person in the same city
 * remembers being asked over, what the operator had them do and how it ended, however many times they are recruited.
 * Each recruitment's serial is written into its episodes and never used as the key (a serial is never reused, so a
 * ledger keyed by it could never be read again). The operator's prompts to the local model carry the bound people's
 * recent episodes (operator.ts Diary); `memory` reads a ledger and `memory forget` erases. It lives on the main thread
 * with the recruiter and the gateway, fed by their events: nothing here reaches the physics worker, and nothing leaves
 * the machine. Every episode is hash-chained (02_Define_The_Rules/integrity.ts): its hash is the SHA-256 of its
 * canonical body followed by the hash of the episode before it, from a root the ledger carries to a head it carries
 * too, so an episode edited, inserted or removed in storage breaks the chain where it happened; a prompt carries only
 * the episodes the chain verifies from the root, the console reports the verdict and where the break is, and an ask's
 * episode records the hash of the exact system prompt the model was given, so an audit can prove what it saw.
 * It is also a weight ledger: every task episode records how it ended (its outcome), and a pedestrian's behavioural
 * weights (how work with each skill has gone; whether answers ran long) are a pure fold of those outcomes over the
 * episodes the chain verifies, from the weights the dropped episodes left (the ledger's base). The fold's result is
 * stored beside the episodes and checked against a replay of the chain on every read, and it adjusts the prompt only
 * through at most three fixed sentences (learnedLines), each passed through the 14A screen. What an agent learns can
 * never touch the conduct core, the laws or the host's code, and an inadmissible prompt is never noted, so it never
 * trains anyone.
 * What breaks if it is removed? Every recruitment starts from nothing: a person asked over again has no history, and
 * an answer knows nothing of what came before; a payload slipped into a ledger would be read back in silence.
 */
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { canonical, isDigest, sha256 } from '../02_Define_The_Rules/integrity.ts'
import { SKILLS } from '../03_Spawn_Agents/skills.ts'
import type { Diary, GateTether, Outcome, RunState } from '../07_Execute_Actions/operator.ts'
import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'
import type { MemoryBridge } from '../07_Execute_Actions/terminal/bridge.ts'

/** Episodes kept per pedestrian; past this the oldest are dropped. */
export const LEDGER_LIMIT = 200
/** Episodes a prompt carries per person, the newest ones. */
export const RECALL = 6
/** Characters of text kept per episode (a prompt and the start of its answer, a script's first line). */
export const EPISODE_CHARS = 280
/** The IndexedDB database and its one object store. */
export const MEMORY_DB = 'civic-simulation:swarm-memory'
const STORE = 'ledgers'
/** The hash before the first episode of a ledger that has never dropped one: no episode came before it. */
export const GENESIS = '0'.repeat(64)

/** What happened: asked over and arrived, let go, or a task the operator ran with them. */
export type EpisodeKind = 'tethered' | 'released' | 'run' | 'ask' | 'say'

/** One thing a pedestrian remembers, before it is chained: everything but its hash. */
export interface EpisodeBody {
  /** When, ms since the epoch (wall clock: a ledger outlives the page). */
  readonly at: number
  /** The recruitment it happened under (RecruitView.serial). */
  readonly serial: number
  readonly kind: EpisodeKind
  /** The skills it was about: those they were tethered with, or those the task required of them. */
  readonly skills: readonly string[]
  /** What was asked, run or said, or why they were let go; at most EPISODE_CHARS. */
  readonly text: string
  /** A task's outcome in the gateway's words. */
  readonly state?: RunState
  /** An ask: the SHA-256 of the exact system prompt the model was given (operator.ts AskResult.promptHash). */
  readonly promptHash?: string
  /** An Authorized task: how it ended (operator.ts taskOutcome), what the weights learn from. */
  readonly outcome?: Outcome
}

/** Every outcome an episode may carry (operator.ts Outcome). */
export const OUTCOMES: readonly Outcome[] = Object.freeze(['answered', 'cut', 'stopped', 'failed', 'ok', 'error', 'said'])

/** One thing a pedestrian remembers, chained. Plain data: it is stored as it is. */
export interface Episode extends EpisodeBody {
  /** sha256(canonical(body) + the hash of the episode before it, or the ledger's root). */
  readonly hash: string
}

/**
 * A ledger as it is stored and held: its episodes in time order, the hash before the first (GENESIS until the oldest
 * are dropped, then the hash of the last one dropped) and the hash of the last (GENESIS when there is none).
 */
export interface Ledger {
  readonly episodes: readonly Episode[]
  readonly root: string
  readonly head: string
  /** The weights as of the root: what the episodes dropped off the old end taught (absent: NEUTRAL). */
  readonly base?: Weights
  /** As read from storage: the weights the store kept and their hash, to check against a replay of the chain. */
  readonly stored?: { readonly weights: unknown; readonly hash: unknown }
}

export const emptyLedger = (): Ledger => Object.freeze({ episodes: Object.freeze([]), root: GENESIS, head: GENESIS })

/** A ledger's key: the world seed and the pedestrian's number (both non-negative integers). */
export function ledgerKey(seed: number, agent: number): string {
  if (!Number.isInteger(seed) || seed < 0) throw new TypeError(`not a world seed: ${String(seed)}`)
  if (!Number.isInteger(agent) || agent < 0) throw new TypeError(`not a pedestrian's number: ${String(agent)}`)
  return `${seed}:${agent}`
}

/** The link: an episode's hash is the SHA-256 of its canonical body (never its hash) followed by the hash before it. */
export function link(e: EpisodeBody, previous: string): string {
  const { at, serial, kind, skills, text, state, promptHash, outcome } = e
  return sha256(canonical({ at, serial, kind, skills, text, state, promptHash, outcome }) + previous)
}

/** Where the chain of a ledger holds: how many episodes link from the root, and the first fault when not all do. */
export interface ChainVerdict {
  /** Every link holds and the head is the hash of the last episode. */
  readonly intact: boolean
  /** Episodes from the first that link from the root: a prompt carries only these. */
  readonly verified: number
  /** Not intact: where, in words ("episode 3 of 5 does not link to episode 2"). */
  readonly fault?: string
}

/** Verifies a ledger's chain from its root, episode by episode, then its head. Pure. */
export function audit(ledger: Ledger): ChainVerdict {
  const list = ledger.episodes
  let prev = ledger.root
  for (let i = 0; i < list.length; i++) {
    const e = list[i]
    if (!isDigest(e.hash) || e.hash !== link(e, prev)) {
      return Object.freeze({ intact: false, verified: i, fault: `episode ${i + 1} of ${list.length} does not link to ${i === 0 ? 'the root' : `episode ${i}`}` })
    }
    prev = e.hash
  }
  if (ledger.head !== prev) return Object.freeze({ intact: false, verified: list.length, fault: `the head is not the hash of ${list.length ? `episode ${list.length}` : 'the root'}` })
  return Object.freeze({ intact: true, verified: list.length })
}

/**
 * Where an episode at `at` goes in a ledger kept in time order: after every episode at or before its moment (a task is
 * noted when it ends but belongs where it began, so it can land before a release that cut it short).
 */
export function placeIndex(list: readonly EpisodeBody[], at: number): number {
  let i = list.length
  while (i > 0 && list[i - 1].at > at) i--
  return i
}

const freezeEpisode = (e: EpisodeBody, hash: string): Episode => Object.freeze({
  at: e.at, serial: e.serial, kind: e.kind, skills: Object.freeze([...e.skills]), text: e.text,
  ...(e.state !== undefined && { state: e.state }), ...(e.promptHash !== undefined && { promptHash: e.promptHash }),
  ...(e.outcome !== undefined && { outcome: e.outcome }), hash,
})

/**
 * `ledger` with `e` in its place in time and the chain rebuilt from there: `e` links to the episode before it, and
 * every episode after it that linked before is linked again; one that did not link keeps its hash, so an insertion
 * never hides a break. Then the newest `limit` episodes are kept, and the root becomes the hash of the last one
 * dropped. Pure and deterministic: the held copy and the stored one are built the same way and agree.
 */
export function appended(ledger: Ledger, e: EpisodeBody, limit: number): Ledger {
  const old = ledger.episodes
  const good = audit(ledger).verified
  const i = placeIndex(old, e.at)
  const bodies: readonly EpisodeBody[] = [...old.slice(0, i), e, ...old.slice(i)]
  const drop = Math.max(0, bodies.length - Math.max(1, limit))
  const kept: Episode[] = []
  let root = ledger.root
  let prev = root
  // What the dropped episodes taught moves into the base, as long as they link: a broken one teaches nothing.
  let base = ledger.base ?? NEUTRAL
  let linked = true
  for (let j = 0; j < bodies.length; j++) {
    // Old index j (before the insertion) or j − 1 (after it): re-linked when it is `e` or an old episode that linked.
    const fresh = j === i || (j > i && j - 1 < good)
    const ep = fresh ? freezeEpisode(bodies[j], link(bodies[j], prev)) : (bodies[j] as Episode)
    linked = linked && ep.hash === link(ep, prev)
    prev = ep.hash
    if (j < drop) {
      root = ep.hash
      if (linked) base = learn(base, ep)
    } else kept.push(ep)
  }
  return Object.freeze({ episodes: Object.freeze(kept), root, head: prev, ...(base !== NEUTRAL && { base }) })
}

/** Every key of one city's ledgers starts with this. */
const cityPrefix = (seed: number): string => `${seed}:`

/** Text as an episode keeps it: one line, runs of space folded, cut to EPISODE_CHARS with an ellipsis. */
export function clipText(text: string): string {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > EPISODE_CHARS ? `${t.slice(0, EPISODE_CHARS - 1)}…` : t
}

/** Only a well-formed body is recorded. */
export function isEpisodeBody(e: unknown): e is EpisodeBody {
  if (typeof e !== 'object' || e === null) return false
  const o = e as { [K in keyof EpisodeBody]?: unknown }
  return typeof o.at === 'number' && Number.isFinite(o.at) &&
    typeof o.serial === 'number' && Number.isInteger(o.serial) &&
    (o.kind === 'tethered' || o.kind === 'released' || o.kind === 'run' || o.kind === 'ask' || o.kind === 'say') &&
    Array.isArray(o.skills) && o.skills.every((s) => typeof s === 'string') &&
    typeof o.text === 'string' &&
    (o.state === undefined || o.state === 'Authorized' || o.state === 'Rejected' || o.state === 'Aborted') &&
    (o.promptHash === undefined || isDigest(o.promptHash)) &&
    (o.outcome === undefined || (OUTCOMES as readonly unknown[]).includes(o.outcome))
}

/** Only a well-formed, chained episode is read back (storage can be edited, and old versions leave odd rows). */
export function isEpisode(e: unknown): e is Episode {
  return isEpisodeBody(e) && isDigest((e as { hash?: unknown }).hash)
}

// ---------------------------------------------------------------- storage

/** Where the ledgers are kept. Each call is atomic on its own ledger. */
export interface LedgerStore {
  /** Adds `e` to ledger `key` in its place in time, chained (appended), keeping its newest `limit` episodes. */
  append(key: string, e: EpisodeBody, limit: number): Promise<void>
  /** Ledger `key`, oldest first, with its root and head (empty if there is none). */
  read(key: string): Promise<Ledger>
  /** The keys that start with `prefix`, sorted. */
  keys(prefix: string): Promise<string[]>
  /** Deletes ledger `key`; resolves with whether there was one. */
  remove(key: string): Promise<boolean>
  /** Deletes every ledger whose key starts with `prefix`; resolves with how many. */
  removeAll(prefix: string): Promise<number>
  /** 'indexeddb' (kept between visits) or 'memory' (this visit only). */
  readonly kind: 'indexeddb' | 'memory'
}

/** Ledgers in this page's memory only: for the tests, and for a browser that refuses storage. */
export function memoryLedger(): LedgerStore {
  const map = new Map<string, Ledger>()
  return Object.freeze({
    kind: 'memory' as const,
    append: async (key: string, e: EpisodeBody, limit: number) => {
      map.set(key, appended(map.get(key) ?? emptyLedger(), e, limit))
    },
    read: async (key: string) => map.get(key) ?? emptyLedger(),
    keys: async (prefix: string) => [...map.keys()].filter((k) => k.startsWith(prefix)).sort(),
    remove: async (key: string) => map.delete(key),
    removeAll: async (prefix: string) => {
      let n = 0
      for (const k of [...map.keys()]) if (k.startsWith(prefix) && map.delete(k)) n++
      return n
    },
  })
}

/** An IDBRequest as a promise. */
function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('storage request failed'))
  })
}

/** A transaction's completion as a promise (a write is only kept once its transaction completes). */
function completed(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('storage transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('storage transaction aborted'))
  })
}

/** The keys between `prefix` and every key that extends it. */
const prefixRange = (prefix: string): IDBKeyRange => IDBKeyRange.bound(prefix, `${prefix}￿`)

/**
 * A stored row as a ledger: its well-formed episodes, its root and head as written (a row with nothing well-formed in
 * it, such as one from before the chain, is an empty ledger; a root or head that is not a digest is kept as it is,
 * so the audit says so rather than this reader mending it).
 */
export function ledgerOf(row: unknown): Ledger {
  const r = (row ?? {}) as { episodes?: unknown; root?: unknown; head?: unknown; base?: unknown; weights?: unknown; weightsHash?: unknown }
  const episodes = Array.isArray(r.episodes) ? r.episodes.filter(isEpisode) : []
  if (episodes.length === 0 && !isDigest(r.root) && !isDigest(r.head)) return emptyLedger()
  const digest = (u: unknown): string => (typeof u === 'string' ? u : '')
  return Object.freeze({
    episodes: Object.freeze(episodes.map((e) => freezeEpisode(e, e.hash))), root: digest(r.root), head: digest(r.head),
    // A base that is not well-formed is dropped (the weights then start from NEUTRAL, and the check says the copy differs).
    ...(isWeights(r.base) && { base: freezeWeights(r.base) }),
    ...((r.weights !== undefined || r.weightsHash !== undefined) && { stored: Object.freeze({ weights: r.weights, hash: r.weightsHash }) }),
  })
}

/** A ledger as the store writes it: its chain, its base, and the weights the chain gives with their hash. */
export function rowOf(key: string, ledger: Ledger): { key: string; episodes: readonly Episode[]; root: string; head: string; base?: Weights; weights: Weights; weightsHash: string } {
  const weights = weightsOf(ledger)
  return { key, episodes: ledger.episodes, root: ledger.root, head: ledger.head, ...(ledger.base && { base: ledger.base }), weights, weightsHash: weightsHash(weights, ledger.head) }
}

/**
 * Ledgers in the page's IndexedDB (database MEMORY_DB, one row per ledger: { key, episodes, root, head }), kept between
 * visits. Opens the database now; rejects if the browser refuses it (the host then keeps memory for the visit only).
 */
export async function indexedDbLedger(factory: IDBFactory, name: string = MEMORY_DB): Promise<LedgerStore> {
  const open = factory.open(name, 1)
  open.onupgradeneeded = () => {
    if (!open.result.objectStoreNames.contains(STORE)) open.result.createObjectStore(STORE, { keyPath: 'key' })
  }
  const db = await done(open)
  const tx = (mode: IDBTransactionMode) => {
    const t = db.transaction(STORE, mode)
    return { t, store: t.objectStore(STORE) }
  }
  return Object.freeze({
    kind: 'indexeddb' as const,
    append: async (key: string, e: EpisodeBody, limit: number) => {
      // Read and write in one transaction: two appends to the same ledger cannot interleave.
      const { t, store } = tx('readwrite')
      const finished = completed(t)
      const next = appended(ledgerOf(await done(store.get(key))), e, limit)
      store.put(rowOf(key, next))
      await finished
    },
    read: async (key: string) => ledgerOf(await done(tx('readonly').store.get(key))),
    keys: async (prefix: string) => (await done(tx('readonly').store.getAllKeys(prefixRange(prefix)))).map(String).sort(),
    remove: async (key: string) => {
      const { t, store } = tx('readwrite')
      const finished = completed(t)
      const had = (await done(store.count(key))) > 0
      store.delete(key)
      await finished
      return had
    },
    removeAll: async (prefix: string) => {
      const { t, store } = tx('readwrite')
      const finished = completed(t)
      const n = await done(store.count(prefixRange(prefix)))
      store.delete(prefixRange(prefix))
      await finished
      return n
    },
  })
}

/**
 * A store usable at once: its calls wait for `opening` (the IndexedDB store, say), or fall back to this page's memory
 * if it cannot open. `kind` says which it became ('memory' until then).
 */
export function deferredLedger(opening: Promise<LedgerStore>): LedgerStore {
  let kind: LedgerStore['kind'] = 'memory'
  const ready = opening.then((s) => {
    kind = s.kind
    return s
  }, () => memoryLedger())
  return Object.freeze({
    get kind() {
      return kind
    },
    append: async (key: string, e: EpisodeBody, limit: number) => (await ready).append(key, e, limit),
    read: async (key: string) => (await ready).read(key),
    keys: async (prefix: string) => (await ready).keys(prefix),
    remove: async (key: string) => (await ready).remove(key),
    removeAll: async (prefix: string) => (await ready).removeAll(prefix),
  })
}

// ---------------------------------------------------------------- the memory

/** A held ledger: one cell per tethered person, replaced whole on every append (a Ledger is immutable). */
interface Held {
  ledger: Ledger
}

/**
 * The swarm's memory for one city (one world seed). Writes go to the store in the order they are made; the ledgers of
 * the people tethered now are also held here (loaded when they arrive), so a prompt can carry them without waiting.
 */
export class SwarmMemory {
  readonly store: LedgerStore
  readonly seed: number
  readonly #held = new Map<number, Held>()
  /** Every write, chained: a read after a write sees it, whatever the store does in between. */
  #queue: Promise<unknown> = Promise.resolve()
  #clock: () => number

  constructor(store: LedgerStore, seed: number, clock: () => number = Date.now) {
    ledgerKey(seed, 0)
    this.store = store
    this.seed = seed
    this.#clock = clock
  }

  /** Runs `op` after every write made before it; its failure is reported to its caller, never to the next one. */
  #then<T>(op: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(op, op)
    this.#queue = run.catch(() => {})
    return run
  }

  /** Records one episode for pedestrian `agent`, at `e.at` or now; resolves once it is stored. */
  record(agent: number, e: Omit<EpisodeBody, 'at' | 'text'> & { text: string; at?: number }): Promise<void> {
    const key = ledgerKey(this.seed, agent)
    const body: EpisodeBody = Object.freeze({
      at: e.at ?? this.#clock(), serial: e.serial, kind: e.kind, skills: Object.freeze([...e.skills]), text: clipText(e.text),
      ...(e.state !== undefined && { state: e.state }), ...(e.promptHash !== undefined && { promptHash: e.promptHash }),
      ...(e.outcome !== undefined && { outcome: e.outcome }),
    })
    if (!isEpisodeBody(body)) return Promise.reject(new TypeError('not an episode'))
    const held = this.#held.get(agent)
    if (held) held.ledger = appended(held.ledger, body, LEDGER_LIMIT)
    return this.#then(() => this.store.append(key, body, LEDGER_LIMIT))
  }

  /** Pedestrian `agent`'s ledger as stored: its episodes oldest first, its root and its head. */
  read(agent: number): Promise<Ledger> {
    const key = ledgerKey(this.seed, agent)
    return this.#then(() => this.store.read(key))
  }

  /** Pedestrian `agent`'s episodes, oldest first. */
  async ledger(agent: number): Promise<Episode[]> {
    return [...(await this.read(agent)).episodes]
  }

  /** Loads pedestrian `agent`'s ledger and holds it for recall() while they are tethered; resolves with its episodes. */
  async hold(agent: number): Promise<readonly Episode[]> {
    // Held from now on: an episode recorded while the read is on its way is stored after it (so the read misses it)
    // and lands in the cell meanwhile; the two are joined when the read arrives.
    const cell: Held = { ledger: emptyLedger() }
    this.#held.set(agent, cell)
    const stored = await this.read(agent)
    const joined = cell.ledger.episodes.reduce((l, e) => appended(l, e, LEDGER_LIMIT), stored)
    // Let go (or held again) meanwhile: that newer call decides what is held.
    if (this.#held.get(agent) === cell) cell.ledger = joined
    return joined.episodes
  }

  /** Stops holding pedestrian `agent`'s ledger (they were let go); it stays in the store. */
  release(agent: number): void {
    this.#held.delete(agent)
  }

  /**
   * The newest RECALL episodes of a held ledger that the chain verifies from the root, oldest first (none if it is not
   * held). A break stops the recall there: nothing after it reaches a prompt. Synchronous.
   */
  recall(agent: number): readonly Episode[] {
    const held = this.#held.get(agent)
    if (!held) return []
    return held.ledger.episodes.slice(0, audit(held.ledger).verified).slice(-RECALL)
  }

  /** What a held person has learned, from the chain as it verifies (NEUTRAL if they are not held). Synchronous. */
  weights(agent: number): Weights {
    const held = this.#held.get(agent)
    return held ? weightsOf(held.ledger) : NEUTRAL
  }

  /** The pedestrians of this city who have a ledger, by number. */
  async people(): Promise<number[]> {
    const prefix = cityPrefix(this.seed)
    const keys = await this.#then(() => this.store.keys(prefix))
    return keys.map((k) => Number(k.slice(prefix.length))).filter((n) => Number.isInteger(n) && n >= 0).sort((a, b) => a - b)
  }

  /** Forgets pedestrian `agent`, or everyone in this city ('all'); resolves with how many ledgers were erased. */
  forget(which: number | 'all'): Promise<number> {
    if (which === 'all') {
      for (const held of this.#held.values()) held.ledger = emptyLedger()
      return this.#then(() => this.store.removeAll(cityPrefix(this.seed)))
    }
    const key = ledgerKey(this.seed, which)
    const held = this.#held.get(which)
    if (held) held.ledger = emptyLedger()
    return this.#then(async () => ((await this.store.remove(key)) ? 1 : 0))
  }

  /** The operator tier's view (operator.ts Diary): prompt lines for a person, and a note of what a task did with people. */
  diary(): Diary {
    return Object.freeze({
      // What they remember, then what they have learned (fixed sentences only, after the episodes). 14A: a remembered line
      // that fails the screen (a diary kept before answers were screened, or a store edited by hand) is never recalled.
      recall: (agent: number): readonly string[] => [
        ...this.recall(agent).map((e) => recollection(e)).filter((l) => screen(l).admissible), ...learnedLines(this.weights(agent)),
      ],
      note: (bound: readonly GateTether[], kind: 'run' | 'ask' | 'say', skills: readonly string[], text: string, state: RunState, at: number, promptHash?: string, outcome?: Outcome): void => {
        for (const t of bound) {
          void this.record(t.agent, {
            serial: t.serial, kind, skills, text, state, at, ...(isDigest(promptHash) && { promptHash }),
            ...(outcome !== undefined && (OUTCOMES as readonly unknown[]).includes(outcome) && { outcome }),
          }).catch(() => {})
        }
      },
    })
  }
}

/** How long ago `at` was, from `now`, in words: "just now", "5 min ago", "3 h ago", "2 days ago". */
export function ago(at: number, now: number): string {
  const s = Math.max(0, (now - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? '1 day ago' : `${d} days ago`
}

/** One episode as the person remembers it, for a prompt (second person, no clock: the model gets "ago" words; never a hash). */
export function recollection(e: EpisodeBody, now: number = Date.now()): string {
  const when = ago(e.at, now)
  const how = e.state === 'Aborted' ? ' (cut short: the tether broke)' : e.state === 'Rejected' ? ' (refused)' : ''
  const skills = e.skills.join(', ')
  switch (e.kind) {
    case 'tethered': return `${when}: you were asked over for ${skills} and joined the operator`
    case 'released': return `${when}: you left the operator (${e.text || 'let go'})`
    case 'run': return `${when}: the operator ran a script with your ${skills}${how}: ${e.text}`
    case 'ask': return `${when}: the operator asked you about ${skills}${how}: ${e.text}`
    case 'say': return `${when}: you said aloud${how}: ${e.text}`
  }
}

/**
 * One episode as the console lists it: the time (the date too when not today), the recruitment, what happened, and for
 * an ask the hash of the system prompt the model was given.
 */
export function ledgerLine(e: EpisodeBody, now: number = Date.now()): string {
  const d = new Date(e.at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = new Date(now).toDateString() === d.toDateString()
  const time = `${today ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const state = e.state && e.state !== 'Authorized' ? ` (${e.state})` : ''
  const what = e.kind === 'tethered' ? `tethered · ${e.skills.join(', ')}` : `${e.kind}${state}${e.text ? ` · ${e.text}` : ''}`
  const prompt = e.promptHash ? `  prompt ${e.promptHash}` : ''
  return `${time}  #${e.serial}  ${what}${prompt}`
}

/** A chain's verdict as the console says it: intact with its head, or where it breaks and where the recall stops. */
export function chainLine(ledger: Ledger): string {
  const v = audit(ledger)
  if (v.intact) return `chain intact (head ${ledger.head.slice(0, 12)})`
  return `chain broken: ${v.fault} (recall stops at ${v.verified === 0 ? 'nothing' : `episode ${v.verified}`})`
}

/** The recruiter as the memory follows it: its newest list, and its active/released events (recruitment.ts). */
export interface RecruitFeed extends EventTarget {
  readonly recruits: readonly RecruitView[]
}

/**
 * Writes the recruiter's events into the memory: an arrival (tethered, with the recruitment's serial and the skills
 * they bring; their ledger is then held for prompts) and a release (with the reason). Returns the unsubscribe.
 */
export function followRecruiter(memory: SwarmMemory, feed: RecruitFeed): () => void {
  // The serial of each tethered person: the worker's list no longer holds them by the time their release arrives.
  const serials = new Map<number, number>()
  const onActive = (ev: Event): void => {
    const d = (ev as CustomEvent<{ agent: number; skill: string; skills: string[] }>).detail
    const view = feed.recruits.find((r) => r.agent === d.agent)
    if (!view) return
    serials.set(d.agent, view.serial)
    void memory.hold(d.agent).catch(() => {})
    void memory.record(d.agent, { serial: view.serial, kind: 'tethered', skills: d.skills, text: '' }).catch(() => {})
  }
  const onReleased = (ev: Event): void => {
    const d = (ev as CustomEvent<{ agent: number; skill: string; reason: string }>).detail
    const serial = serials.get(d.agent)
    serials.delete(d.agent)
    memory.release(d.agent)
    // Someone let go before they ever arrived was never tethered: nothing happened with them to remember.
    if (serial === undefined) return
    void memory.record(d.agent, { serial, kind: 'released', skills: [d.skill], text: d.reason }).catch(() => {})
  }
  feed.addEventListener('active', onActive)
  feed.addEventListener('released', onReleased)
  return () => {
    feed.removeEventListener('active', onActive)
    feed.removeEventListener('released', onReleased)
  }
}

/**
 * The console's view of the memory (bridge.ts MemoryBridge), over the recruiter's newest list for who is here now.
 * The status lines carry each tethered person's chain verdict; a ledger listing marks where its chain breaks.
 */
export function memoryBridge(memory: SwarmMemory, feed: Pick<RecruitFeed, 'recruits'>, now: () => number = Date.now): MemoryBridge {
  return Object.freeze({
    status: async (): Promise<string[]> => {
      const people = await memory.people()
      // Read after the store has answered: until IndexedDB opens, the store cannot say what it became.
      const where = memory.store.kind === 'indexeddb' ? 'kept on this machine between visits' : 'kept for this visit only (this browser refused storage)'
      const lines = [`memory: ${people.length} ${people.length === 1 ? 'person' : 'people'} remembered in this city (seed ${memory.seed}), ${where}`]
      for (const r of feed.recruits) {
        if (r.state !== 'Active' || !r.arrived) continue
        const ledger = await memory.read(r.agent)
        const list = ledger.episodes
        const last = list[list.length - 1]
        lines.push(`agent ${r.agent} (${r.skills.join(', ')}): ${list.length} ${list.length === 1 ? 'episode' : 'episodes'}, ${chainLine(ledger)}${last ? `, last ${ago(last.at, now())}: ${last.kind}` : ''}`)
        lines.push(`  ${weightsLine(weightsOf(ledger))} (${weightsCheck(ledger)})`)
      }
      return lines
    },
    ledger: async (agent: number): Promise<string[]> => {
      const ledger = await memory.read(agent)
      const list = ledger.episodes
      if (!list.length) return [`agent ${agent} remembers nothing in this city`]
      const t = now()
      const v = audit(ledger)
      const lines = list.map((e) => ledgerLine(e, t))
      // The break is marked where it is: before the first episode that does not link, or after the last when the head is wrong.
      if (!v.intact) lines.splice(v.verified, 0, `-- ${chainLine(ledger)} --`)
      lines.push(`-- ${weightsLine(weightsOf(ledger))} (${weightsCheck(ledger)}) --`, ...learnedLines(weightsOf(ledger)).map((l) => `   ${l}`))
      return lines
    },
    forget: async (which: number | 'all'): Promise<string> => {
      const n = await memory.forget(which)
      if (which === 'all') return `forgot ${n} ${n === 1 ? 'person' : 'people'} in this city`
      return n ? `agent ${which} remembers nothing now` : `agent ${which} had nothing to forget`
    },
  })
}

// ---------------------------------------------------------------- what the swarm learns

/** One weight: an exponential average of rewards in [−1, 1], and how many rewards it has seen. */
export interface Weight {
  readonly value: number
  readonly n: number
}

/** A pedestrian's behavioural weights. Plain data: stored as it is. */
export interface Weights {
  /** Per skill (the city's own names only, skills.ts SKILLS): how work with it has gone, +1 well, −1 badly. */
  readonly skills: Readonly<Record<string, Weight>>
  /** How much shorter answers should be: +1 they ran long or were stopped, 0 no pressure. */
  readonly brevity: Weight
}

/** The learning's constants: the step of the average, and when a weight is strong enough to be said. */
export const LEARN = Object.freeze({
  /** Each reward moves a weight this fraction of the way to it. */
  rate: 0.25,
  /** Rewards a weight must have seen before a learned line may cite it. */
  minCount: 2,
  /** A skill at or above this has gone well; at or below `poor`, badly. */
  good: 0.4,
  poor: -0.3,
  /** Brevity at or above this: answers have run long. */
  long: 0.3,
  /** Learned lines a prompt carries at most, and the longest one. */
  lines: 3,
  chars: 160,
})

const ZERO: Weight = Object.freeze({ value: 0, n: 0 })
/** No weights yet: nothing learned. */
export const NEUTRAL: Weights = Object.freeze({ skills: Object.freeze({}), brevity: ZERO })
const KNOWN: ReadonlySet<string> = new Set(SKILLS)

/**
 * The reward an episode carries: for the skills it was about, and for brevity, each a value the weight moves toward.
 * Only an Authorized task with an outcome teaches: a Rejected one never involved the agent, an Aborted one ended with
 * the tether (not the work), and a server's failure is the server's. An inadmissible prompt is never noted at all.
 */
export function rewardOf(e: EpisodeBody): { readonly skill?: number; readonly brevity?: number } | null {
  if (e.state !== 'Authorized') return null
  switch (e.outcome) {
    case 'answered': return { skill: 1, brevity: 0 }
    case 'cut': return { skill: -0.25, brevity: 1 }
    case 'stopped': return { skill: -0.5, brevity: 1 }
    case 'ok': return { skill: 1 }
    case 'error': return { skill: -0.5 }
    case 'said': return { skill: 0.5 }
    default: return null
  }
}

/** Kept to six places, so the stored copy and a replay agree as text. */
const round6 = (x: number): number => Math.round(x * 1e6) / 1e6
const toward = (w: Weight, target: number): Weight =>
  Object.freeze({ value: round6(Math.min(1, Math.max(-1, w.value + LEARN.rate * (target - w.value)))), n: w.n + 1 })

/** The weights after one more episode. Pure and deterministic: replaying a chain gives the same weights. */
export function learn(w: Weights, e: EpisodeBody): Weights {
  const r = rewardOf(e)
  if (!r) return w
  let skills = w.skills
  if (r.skill !== undefined) {
    const next: Record<string, Weight> = { ...w.skills }
    for (const s of new Set(e.skills)) if (KNOWN.has(s)) next[s] = toward(next[s] ?? ZERO, r.skill)
    skills = Object.freeze(next)
  }
  const brevity = r.brevity !== undefined ? toward(w.brevity, r.brevity) : w.brevity
  return Object.freeze({ skills, brevity })
}

/** A ledger's weights: its base, then every episode the chain verifies from the root, in order. Pure. */
export function weightsOf(ledger: Ledger): Weights {
  const verified = audit(ledger).verified
  let w = ledger.base ?? NEUTRAL
  for (let i = 0; i < verified; i++) w = learn(w, ledger.episodes[i])
  return w
}

/** The hash that binds stored weights to the head of the chain they were folded from. */
export function weightsHash(w: Weights, head: string): string {
  return sha256(canonical(w) + head)
}

const isWeight = (u: unknown): u is Weight => {
  const o = u as { value?: unknown; n?: unknown } | null
  return typeof o === 'object' && o !== null && typeof o.value === 'number' && Number.isFinite(o.value) && Math.abs(o.value) <= 1 &&
    typeof o.n === 'number' && Number.isInteger(o.n) && o.n >= 0
}

/** Only well-formed weights over the city's own skills are read back. */
export function isWeights(u: unknown): u is Weights {
  const o = u as { skills?: unknown; brevity?: unknown } | null
  if (typeof o !== 'object' || o === null || !isWeight(o.brevity)) return false
  if (typeof o.skills !== 'object' || o.skills === null || Array.isArray(o.skills)) return false
  return Object.entries(o.skills).every(([k, v]) => KNOWN.has(k) && isWeight(v))
}

const freezeWeights = (w: Weights): Weights => Object.freeze({
  skills: Object.freeze(Object.fromEntries(Object.entries(w.skills).map(([k, v]) => [k, Object.freeze({ value: v.value, n: v.n })]))),
  brevity: Object.freeze({ value: w.brevity.value, n: w.brevity.n }),
})

/** Whether the weights the store kept are the ones the chain gives (the chain is the truth; a copy that differs is replayed). */
export function weightsCheck(ledger: Ledger): string {
  if (!ledger.stored) return 'replayed from the chain'
  const replay = weightsOf(ledger)
  const same = isWeights(ledger.stored.weights) && canonical(ledger.stored.weights) === canonical(replay) && ledger.stored.hash === weightsHash(replay, ledger.head)
  return same ? 'the stored copy matches the chain' : 'the stored copy does not match the chain: replayed'
}

const signed = (x: number): string => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`

/** Weights as the console says them: each skill with its count, then brevity. */
export function weightsLine(w: Weights): string {
  const skills = Object.entries(w.skills).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${k} ${signed(v.value)} (${v.n})`)
  const parts = [...skills, ...(w.brevity.n ? [`brevity ${signed(w.brevity.value)} (${w.brevity.n})`] : [])]
  return `weights: ${parts.length ? parts.join(', ') : 'none yet'}`
}

/**
 * What a person has learned, as at most LEARN.lines fixed sentences for their prompt: the skill that has gone best,
 * the one that has gone worst, and whether answers have run long. Every word is this file's or a skill's own name, so
 * nothing a model or a player wrote can reach a prompt this way; each line is still passed through the 14A screen.
 */
export function learnedLines(w: Weights): string[] {
  const seen = Object.entries(w.skills).filter(([k, v]) => KNOWN.has(k) && v.n >= LEARN.minCount)
  const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)
  const best = seen.filter(([, v]) => v.value >= LEARN.good).sort((a, b) => b[1].value - a[1].value || byName(a[0], b[0]))[0]
  const worst = seen.filter(([, v]) => v.value <= LEARN.poor).sort((a, b) => a[1].value - b[1].value || byName(a[0], b[0]))[0]
  const lines: string[] = []
  if (best) lines.push(`learned: your work on ${best[0]} has gone well; keep to what worked`)
  if (worst) lines.push(`learned: your work on ${worst[0]} was often cut short or stopped; be careful and brief there`)
  if (w.brevity.n >= LEARN.minCount && w.brevity.value >= LEARN.long) lines.push('learned: your recent answers ran long; keep them short')
  return lines.filter((l) => l.length <= LEARN.chars && screen(l).admissible).slice(0, LEARN.lines)
}
