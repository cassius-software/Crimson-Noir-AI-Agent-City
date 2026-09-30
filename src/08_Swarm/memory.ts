/**
 * Why does this file exist? It is the swarm's memory: an episodic ledger per pedestrian, kept on this machine in the
 * page's IndexedDB and keyed by the world seed and the pedestrian's number, so the same person in the same city
 * remembers being asked over, what the operator had them do and how it ended, however many times they are recruited.
 * Each recruitment's serial is written into its episodes and never used as the key (a serial is never reused, so a
 * ledger keyed by it could never be read again). The operator's prompts to the local model carry the bound people's
 * recent episodes (operator.ts Diary); `memory` reads a ledger and `memory forget` erases. It lives on the main thread
 * with the recruiter and the gateway, fed by their events: nothing here reaches the physics worker, and nothing leaves
 * the machine.
 * What breaks if it is removed? Every recruitment starts from nothing: a person asked over again has no history, and
 * an answer knows nothing of what came before.
 */
import type { Diary, GateTether, RunState } from '../07_Execute_Actions/operator.ts'
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

/** What happened: asked over and arrived, let go, or a task the operator ran with them. */
export type EpisodeKind = 'tethered' | 'released' | 'run' | 'ask' | 'say'

/** One thing a pedestrian remembers. Plain data: it is stored as it is. */
export interface Episode {
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
}

/** A ledger's key: the world seed and the pedestrian's number (both non-negative integers). */
export function ledgerKey(seed: number, agent: number): string {
  if (!Number.isInteger(seed) || seed < 0) throw new TypeError(`not a world seed: ${String(seed)}`)
  if (!Number.isInteger(agent) || agent < 0) throw new TypeError(`not a pedestrian's number: ${String(agent)}`)
  return `${seed}:${agent}`
}

/**
 * `e` in its place in a ledger kept in time order: after every episode at or before its moment (a task is noted when
 * it ends but belongs where it began, so it can land before a release that cut it short).
 */
export function placed(list: readonly Episode[], e: Episode): Episode[] {
  let i = list.length
  while (i > 0 && list[i - 1].at > e.at) i--
  return [...list.slice(0, i), e, ...list.slice(i)]
}

/** Every key of one city's ledgers starts with this. */
const cityPrefix = (seed: number): string => `${seed}:`

/** Text as an episode keeps it: one line, runs of space folded, cut to EPISODE_CHARS with an ellipsis. */
export function clipText(text: string): string {
  const t = String(text).replace(/\s+/g, ' ').trim()
  return t.length > EPISODE_CHARS ? `${t.slice(0, EPISODE_CHARS - 1)}…` : t
}

/** Only a well-formed episode is kept or read back (storage can be edited, and old versions leave odd rows). */
export function isEpisode(e: unknown): e is Episode {
  if (typeof e !== 'object' || e === null) return false
  const o = e as { [K in keyof Episode]?: unknown }
  return typeof o.at === 'number' && Number.isFinite(o.at) &&
    typeof o.serial === 'number' && Number.isInteger(o.serial) &&
    (o.kind === 'tethered' || o.kind === 'released' || o.kind === 'run' || o.kind === 'ask' || o.kind === 'say') &&
    Array.isArray(o.skills) && o.skills.every((s) => typeof s === 'string') &&
    typeof o.text === 'string' &&
    (o.state === undefined || o.state === 'Authorized' || o.state === 'Rejected' || o.state === 'Aborted')
}

// ---------------------------------------------------------------- storage

/** Where the ledgers are kept. Each call is atomic on its own ledger. */
export interface LedgerStore {
  /** Adds `e` to ledger `key` in its place in time (placed), keeping its newest `limit` episodes. */
  append(key: string, e: Episode, limit: number): Promise<void>
  /** Ledger `key`, oldest first (empty if there is none). */
  read(key: string): Promise<Episode[]>
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
  const map = new Map<string, Episode[]>()
  return Object.freeze({
    kind: 'memory' as const,
    append: async (key: string, e: Episode, limit: number) => {
      const list = placed(map.get(key) ?? [], e)
      map.set(key, list.slice(Math.max(0, list.length - limit)))
    },
    read: async (key: string) => [...(map.get(key) ?? [])],
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
 * Ledgers in the page's IndexedDB (database MEMORY_DB, one row per ledger: { key, episodes }), kept between visits.
 * Opens the database now; rejects if the browser refuses it (the host then keeps memory for the visit only).
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
  const episodesOf = (row: unknown): Episode[] => {
    const list = (row as { episodes?: unknown } | undefined)?.episodes
    return Array.isArray(list) ? list.filter(isEpisode) : []
  }
  return Object.freeze({
    kind: 'indexeddb' as const,
    append: async (key: string, e: Episode, limit: number) => {
      // Read and write in one transaction: two appends to the same ledger cannot interleave.
      const { t, store } = tx('readwrite')
      const finished = completed(t)
      const list = placed(episodesOf(await done(store.get(key))), e)
      store.put({ key, episodes: list.slice(Math.max(0, list.length - limit)) })
      await finished
    },
    read: async (key: string) => episodesOf(await done(tx('readonly').store.get(key))),
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
    append: async (key: string, e: Episode, limit: number) => (await ready).append(key, e, limit),
    read: async (key: string) => (await ready).read(key),
    keys: async (prefix: string) => (await ready).keys(prefix),
    remove: async (key: string) => (await ready).remove(key),
    removeAll: async (prefix: string) => (await ready).removeAll(prefix),
  })
}

// ---------------------------------------------------------------- the memory

/**
 * The swarm's memory for one city (one world seed). Writes go to the store in the order they are made; the ledgers of
 * the people tethered now are also held here (loaded when they arrive), so a prompt can carry them without waiting.
 */
export class SwarmMemory {
  readonly store: LedgerStore
  readonly seed: number
  readonly #held = new Map<number, Episode[]>()
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
  record(agent: number, e: Omit<Episode, 'at' | 'text'> & { text: string; at?: number }): Promise<void> {
    const key = ledgerKey(this.seed, agent)
    const episode: Episode = Object.freeze({
      at: e.at ?? this.#clock(), serial: e.serial, kind: e.kind, skills: Object.freeze([...e.skills]), text: clipText(e.text),
      ...(e.state !== undefined && { state: e.state }),
    })
    if (!isEpisode(episode)) return Promise.reject(new TypeError('not an episode'))
    const held = this.#held.get(agent)
    if (held) {
      held.splice(0, held.length, ...placed(held, episode))
      if (held.length > LEDGER_LIMIT) held.splice(0, held.length - LEDGER_LIMIT)
    }
    return this.#then(() => this.store.append(key, episode, LEDGER_LIMIT))
  }

  /** Pedestrian `agent`'s ledger, oldest first. */
  ledger(agent: number): Promise<Episode[]> {
    const key = ledgerKey(this.seed, agent)
    return this.#then(() => this.store.read(key))
  }

  /** Loads pedestrian `agent`'s ledger and holds it for recall() while they are tethered; resolves with it. */
  async hold(agent: number): Promise<readonly Episode[]> {
    // Held from now on: an episode recorded while the read is on its way is stored after it (so the read misses it)
    // and lands in `later` instead; the two are joined when the read arrives.
    const later: Episode[] = []
    this.#held.set(agent, later)
    const list = later.reduce((l, e) => placed(l, e), await this.ledger(agent)).slice(-LEDGER_LIMIT)
    // Let go (or held again) meanwhile: that newer call decides what is held.
    if (this.#held.get(agent) === later) this.#held.set(agent, list)
    return list
  }

  /** Stops holding pedestrian `agent`'s ledger (they were let go); it stays in the store. */
  release(agent: number): void {
    this.#held.delete(agent)
  }

  /** The newest RECALL episodes of a held ledger, oldest first (none if it is not held). Synchronous. */
  recall(agent: number): readonly Episode[] {
    const held = this.#held.get(agent)
    return held ? held.slice(-RECALL) : []
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
      for (const list of this.#held.values()) list.length = 0
      return this.#then(() => this.store.removeAll(cityPrefix(this.seed)))
    }
    const key = ledgerKey(this.seed, which)
    const held = this.#held.get(which)
    if (held) held.length = 0
    return this.#then(async () => ((await this.store.remove(key)) ? 1 : 0))
  }

  /** The operator tier's view (operator.ts Diary): prompt lines for a person, and a note of what a task did with people. */
  diary(): Diary {
    return Object.freeze({
      recall: (agent: number): readonly string[] => this.recall(agent).map(recollection),
      note: (bound: readonly GateTether[], kind: 'run' | 'ask' | 'say', skills: readonly string[], text: string, state: RunState, at: number): void => {
        for (const t of bound) void this.record(t.agent, { serial: t.serial, kind, skills, text, state, at }).catch(() => {})
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

/** One episode as the person remembers it, for a prompt (second person, no clock: the model gets "ago" words). */
export function recollection(e: Episode, now: number = Date.now()): string {
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

/** One episode as the console lists it: the time (the date too when not today), the recruitment, what happened. */
export function ledgerLine(e: Episode, now: number = Date.now()): string {
  const d = new Date(e.at)
  const pad = (n: number) => String(n).padStart(2, '0')
  const today = new Date(now).toDateString() === d.toDateString()
  const time = `${today ? '' : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `}${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  const state = e.state && e.state !== 'Authorized' ? ` (${e.state})` : ''
  const what = e.kind === 'tethered' ? `tethered · ${e.skills.join(', ')}` : `${e.kind}${state}${e.text ? ` · ${e.text}` : ''}`
  return `${time}  #${e.serial}  ${what}`
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

/** The console's view of the memory (bridge.ts MemoryBridge), over the recruiter's newest list for who is here now. */
export function memoryBridge(memory: SwarmMemory, feed: Pick<RecruitFeed, 'recruits'>, now: () => number = Date.now): MemoryBridge {
  return Object.freeze({
    status: async (): Promise<string[]> => {
      const people = await memory.people()
      // Read after the store has answered: until IndexedDB opens, the store cannot say what it became.
      const where = memory.store.kind === 'indexeddb' ? 'kept on this machine between visits' : 'kept for this visit only (this browser refused storage)'
      const lines = [`memory: ${people.length} ${people.length === 1 ? 'person' : 'people'} remembered in this city (seed ${memory.seed}), ${where}`]
      for (const r of feed.recruits) {
        if (r.state !== 'Active' || !r.arrived) continue
        const list = await memory.ledger(r.agent)
        const last = list[list.length - 1]
        lines.push(`agent ${r.agent} (${r.skills.join(', ')}): ${list.length} ${list.length === 1 ? 'episode' : 'episodes'}${last ? `, last ${ago(last.at, now())}: ${last.kind}` : ''}`)
      }
      return lines
    },
    ledger: async (agent: number): Promise<string[]> => {
      const list = await memory.ledger(agent)
      if (!list.length) return [`agent ${agent} remembers nothing in this city`]
      const t = now()
      return list.map((e) => ledgerLine(e, t))
    },
    forget: async (which: number | 'all'): Promise<string> => {
      const n = await memory.forget(which)
      if (which === 'all') return `forgot ${n} ${n === 1 ? 'person' : 'people'} in this city`
      return n ? `agent ${which} remembers nothing now` : `agent ${which} had nothing to forget`
    },
  })
}
