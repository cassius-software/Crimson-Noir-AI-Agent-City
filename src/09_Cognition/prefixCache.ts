/**
 * Why does this file exist? It is the cognition router's prompt-prefix page table: kv-pager's page table
 * (native/kv-pager, compiled to WebAssembly through native/kv-pager-wasm and carried as kvPager.wasm.ts, generated)
 * applied to the system prompts the router sends. Every prompt is cut into fixed pages of PAGE_TOKENS tokens by a
 * cheap, deterministic tokenizer (whitespace words, hashed); the shared prefix (the 14A conduct core and the base
 * reality, the same for every agent) is one page chain the table holds once and forks for each agent who answers,
 * whose own tokens (who they are, their skills, what they remember) are appended after it: the first append copies
 * the shared tail page once (copy-on-write), exactly as a paged KV cache would. The router asks the table before
 * every answer, so `ask` can show what a prompt cache sees: how many pages the prefix is, how often it was reused,
 * how many pages are mapped and shared, what the forks cost in copies. Its honest limit: this is the product's own
 * count over its own token ids, which makes the prefix ordering of its prompts explicit and measurable; a model
 * server's KV cache is still the server's own, with its own tokenizer, and nothing here reaches it. The table never
 * stops an answer: a failure to load or to page is reported in the line and the prompt goes out as before. The
 * module is instantiated asynchronously on first use (the router lives on the page's main thread).
 * What breaks if it is removed? `ask` has no cache line; nothing else.
 */
import { KV_PAGER_WASM_BASE64, KV_PAGER_WASM_BYTES } from './kvPager.wasm.ts'

/** Tokens per page (kv-pager BLOCK_TOKENS; the module is checked for it at load). */
export const PAGE_TOKENS = 16
/** Pages in the table unless the host says otherwise: 4,096 pages hold 65,536 tokens, eight contexts of 8,192. */
export const DEFAULT_POOL_PAGES = 4096
/** The longest prompt the table pages whole (CONTEXT_TOKENS is 8,192); a longer one is paged up to here. */
export const SCRATCH_TOKENS = 16384
/** The agent id of the shared prefix's chain; agents are numbered from ROOT + 1. */
const ROOT = 1
const OUT_WORDS = 8
/** Where kv_stats writes each number (native/kv-pager-wasm STAT_*). */
const STAT = { capacity: 0, free: 1, idleCached: 2, mapped: 3, shared: 4, emptySlots: 5, cachedKeys: 6, agents: 7 } as const
/** Where kv_append writes the slot (SLOT_*): the token slots a copy-on-write copied, or 0. */
const SLOT_COPIED = 3
const ERRORS: Readonly<Record<number, string>> = { [-1]: 'out of pages', [-2]: 'unknown agent', [-3]: 'agent exists', [-4]: 'invariant broken', [-5]: 'no table', [-6]: 'longer than the scratch' }

/** The module's C ABI (native/kv-pager-wasm/src/lib.rs). `h` is a table handle; addresses are byte offsets. */
export interface KvExports {
  readonly memory: WebAssembly.Memory
  kv_block_tokens(): number
  kv_new(blocks: number, scratch: number): number
  kv_free(h: number): void
  kv_scratch(h: number): number
  kv_scratch_len(h: number): number
  kv_out(h: number): number
  kv_spawn(h: number, agent: number, len: number): number
  kv_fork(h: number, parent: number, child: number): number
  kv_append(h: number, agent: number, token: number): number
  kv_despawn(h: number, agent: number): number
  kv_len(h: number, agent: number): number
  kv_stats(h: number): number
  kv_check(h: number): number
}

/** What paging one prompt did. */
export interface PrefixReport {
  /** Tokens of the prompt, and of them the shared prefix's. */
  readonly tokens: number
  readonly prefixTokens: number
  /** Pages the shared prefix is. */
  readonly prefixPages: number
  /** The prompt opened with the shared prefix, so its chain was forked from the prefix's. */
  readonly forked: boolean
  /** The shared prefix's chain was already in the table. */
  readonly prefixHit: boolean
  /** This agent's chain was already in the table for this very prompt: nothing was paged. */
  readonly hit: boolean
  /** Pages copied on write while the agent's own tokens were appended. */
  readonly copies: number
  /** For a prompt not opening with the prefix: full pages found in the prefix cache when it was admitted. */
  readonly cachedPages: number
  /** The table could not page it (the prompt went out regardless). */
  readonly error?: string
}

/** The table's counts so far. */
export interface PrefixStats {
  readonly asks: number
  readonly prefixHits: number
  readonly hits: number
  readonly copies: number
  readonly refused: number
  readonly prefixTokens: number
  readonly prefixPages: number
  readonly agents: number
  readonly capacity: number
  readonly free: number
  readonly mapped: number
  readonly shared: number
  readonly idleCached: number
  readonly emptySlots: number
  readonly cachedKeys: number
  readonly lastError: string | null
}

export interface PrefixCache {
  /** Pages the system prompt `system` for `agent` (a key naming who answers): never rejects. */
  page(agent: string, system: string): Promise<PrefixReport>
  stats(): PrefixStats | null
  /** The counts as one line for `ask`, or null before anything was paged. */
  line(): string | null
}

/** FNV-1a (32-bit) of a word: the token id. */
function fnv1a(word: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < word.length; i++) {
    h ^= word.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** The cheap, deterministic tokenizer: whitespace-separated words, each hashed to a 32-bit id. */
export function tokenize(text: string): Uint32Array {
  const words = text.split(/\s+/).filter((w) => w.length > 0)
  const out = new Uint32Array(words.length)
  for (let i = 0; i < words.length; i++) out[i] = fnv1a(words[i])
  return out
}

/** A 32-bit digest of a token stream (which prompt an agent's chain holds). */
function digest(tokens: Uint32Array): number {
  let h = 0x811c9dc5
  for (let i = 0; i < tokens.length; i++) {
    h ^= tokens[i]
    h = Math.imul(h, 0x01000193)
    h ^= h >>> 13
  }
  return h >>> 0
}

export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(text.length))
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

/** The page table module's bytes, checked against the length the generator recorded. */
export function kvPagerWasmBytes(): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(KV_PAGER_WASM_BASE64)
  if (bytes.length !== KV_PAGER_WASM_BYTES) throw new Error(`kvPager.wasm.ts: ${bytes.length} bytes decoded, ${KV_PAGER_WASM_BYTES} recorded`)
  return bytes
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * A table of `pages` pages whose shared prefix is `prefix`, instantiated on the first page() (asynchronously, as the
 * page's main thread requires of a module this size).
 */
export function createPrefixCache({ prefix, pages = DEFAULT_POOL_PAGES }: { prefix: string; pages?: number }): PrefixCache {
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError(`the prefix cache needs a positive whole number of pages, not ${pages}`)
  const prefixTokens = tokenize(prefix)
  const prefixPages = Math.ceil(prefixTokens.length / PAGE_TOKENS)
  let loading: Promise<{ e: KvExports; h: number }> | null = null
  const load = (): Promise<{ e: KvExports; h: number }> => {
    loading ??= WebAssembly.instantiate(kvPagerWasmBytes(), {}).then(({ instance }) => {
      const e = instance.exports as unknown as KvExports
      if (e.kv_block_tokens() !== PAGE_TOKENS) throw new Error(`the page table module pages ${e.kv_block_tokens()} tokens, not ${PAGE_TOKENS}`)
      const h = e.kv_new(pages, SCRATCH_TOKENS)
      if (h === 0) throw new Error('the page table module gave no table')
      return { e, h }
    })
    return loading
  }
  /** Each agent key's id in the table and the digest of the prompt its chain holds. */
  const agents = new Map<string, { id: number; prompt: number }>()
  let nextId = ROOT + 1
  let prefixSpawned = false
  const counts = { asks: 0, prefixHits: 0, hits: 0, copies: 0, refused: 0 }
  let pool: Pick<PrefixStats, 'capacity' | 'free' | 'mapped' | 'shared' | 'idleCached' | 'emptySlots' | 'cachedKeys'> | null = null
  let lastError: string | null = null

  const fail = (what: string, code: number): never => {
    throw new Error(`${what}: ${ERRORS[code] ?? `code ${code}`}`)
  }
  const spawn = (e: KvExports, h: number, agent: number, tokens: Uint32Array): number => {
    const n = Math.min(tokens.length, e.kv_scratch_len(h))
    new Uint32Array(e.memory.buffer, e.kv_scratch(h), n).set(tokens.subarray(0, n))
    const r = e.kv_spawn(h, agent, n)
    return r < 0 ? fail(`admitting ${n} tokens`, r) : r
  }
  const refresh = (e: KvExports, h: number): void => {
    const r = e.kv_stats(h)
    if (r < 0) fail('reading the statistics', r)
    const out = new Uint32Array(e.memory.buffer, e.kv_out(h), OUT_WORDS)
    pool = { capacity: out[STAT.capacity], free: out[STAT.free], mapped: out[STAT.mapped], shared: out[STAT.shared], idleCached: out[STAT.idleCached], emptySlots: out[STAT.emptySlots], cachedKeys: out[STAT.cachedKeys] }
  }
  const startsWithPrefix = (tokens: Uint32Array): boolean => {
    if (tokens.length < prefixTokens.length) return false
    for (let i = 0; i < prefixTokens.length; i++) if (tokens[i] !== prefixTokens[i]) return false
    return true
  }

  const page = async (agent: string, system: string): Promise<PrefixReport> => {
    const tokens = tokenize(system)
    const base = { tokens: tokens.length, prefixTokens: prefixTokens.length, prefixPages }
    counts.asks++
    try {
      const { e, h } = await load()
      const prefixHit = prefixSpawned
      if (!prefixSpawned) {
        spawn(e, h, ROOT, prefixTokens)
        prefixSpawned = true
      }
      const prompt = digest(tokens)
      const known = agents.get(agent)
      if (known !== undefined && known.prompt === prompt) {
        counts.hits++
        refresh(e, h)
        return { ...base, forked: true, prefixHit, hit: true, copies: 0, cachedPages: 0 }
      }
      if (known !== undefined) {
        agents.delete(agent)
        const r = e.kv_despawn(h, known.id)
        if (r < 0) fail(`releasing agent ${agent}`, r)
      }
      const id = nextId++
      const forked = startsWithPrefix(tokens)
      let copies = 0
      let cachedPages = 0
      if (forked) {
        const r = e.kv_fork(h, ROOT, id)
        if (r < 0) fail(`forking the prefix for agent ${agent}`, r)
        const out = new Uint32Array(e.memory.buffer, e.kv_out(h), OUT_WORDS)
        const end = Math.min(tokens.length, SCRATCH_TOKENS)
        for (let i = prefixTokens.length; i < end; i++) {
          const a = e.kv_append(h, id, tokens[i])
          if (a < 0) {
            e.kv_despawn(h, id)
            fail(`appending token ${i} for agent ${agent}`, a)
          }
          if (out[SLOT_COPIED] > 0) copies++
        }
        if (prefixHit) counts.prefixHits++
      } else {
        cachedPages = spawn(e, h, id, tokens)
      }
      agents.set(agent, { id, prompt })
      counts.copies += copies
      refresh(e, h)
      return { ...base, forked, prefixHit, hit: false, copies, cachedPages }
    } catch (err) {
      counts.refused++
      lastError = err instanceof Error ? err.message : String(err)
      return { ...base, forked: false, prefixHit: prefixSpawned, hit: false, copies: 0, cachedPages: 0, error: lastError }
    }
  }

  const stats = (): PrefixStats | null => {
    if (counts.asks === 0) return null
    const p = pool ?? { capacity: pages, free: pages, mapped: 0, shared: 0, idleCached: 0, emptySlots: 0, cachedKeys: 0 }
    return { ...counts, prefixTokens: prefixTokens.length, prefixPages, agents: agents.size, ...p, lastError }
  }
  const line = (): string | null => {
    const s = stats()
    if (s === null) return null
    const parts = [
      `prefix ${plural(s.prefixPages, 'page')} (${plural(s.prefixTokens, 'token')}), forked for ${plural(s.agents, 'agent')}`,
      `${plural(s.asks, 'ask')}: ${s.prefixHits} reused the prefix, ${s.hits} the whole prompt`,
      `${plural(s.mapped, 'page')} mapped, ${s.shared} shared`,
      `${plural(s.copies, 'copy', 'copies')} on write`,
      `pool ${s.capacity - s.free}/${s.capacity} pages`,
    ]
    if (s.refused > 0) parts.push(`${s.refused} not paged: ${s.lastError}`)
    return parts.join(' · ')
  }
  return Object.freeze({ page, stats, line })
}
