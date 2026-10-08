// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the boundary audit of the prompt-prefix page table (prefixCache.ts over the kv-pager
 * module kvPager.wasm.ts), seeded and replayable (02_Define_The_Rules/property.ts), on what the unit and fuzz suites
 * do not draw: tables of one page, of exactly the prefix's pages, and of a size the module's u32 cannot hold; prefixes
 * whose tail page is full, one token short, or empty; prompts of no tokens, of the prefix alone, longer than the
 * scratch; a key never paged; the same agent re-paged thousands of times; and the module's own eviction order. Over
 * random call sequences on pools that run out, every report is what a model of the cache predicts (a hit only for the
 * very tokens the agent's chain holds, a fork only for a prompt opening with the prefix, exactly one copy on write for
 * a forked prompt with own tokens and a partial tail), the counts add up (capacity − free = mapped + idle, shared ≤
 * mapped, agents = the keys alive), a failure is reported and changes nothing, and the pool and the JS heap are stable.
 * Through the module's ABI, the eviction order is the documented one: full pages left by released agents are
 * evicted oldest-released first, so the chain released last is the one still cached, and a page revived moves to the
 * back. Three tests are the regression tests of findings of the Phase 16 audit and fail until prefixCache.ts is fixed:
 * a table of 2^32 or more pages is truncated by the module's u32 to pages mod 2^32 (2^32 is a table of none, whose
 * stats still claim the capacity asked for); two prompts whose 32-bit digests collide make the second a "hit" for the
 * first's chain; and the output view the append loop reads its copy-on-write slot from is taken once before the loop,
 * so when an append grows the module's memory (a prefix cache rehash on a sealed page, which with the 95-token base
 * reality is the forked chain's very first append) the view is detached and the copy goes uncounted.
 * What breaks if it is removed? A size or sequence nobody drew could make the cache line say what the table does not
 * hold, and nobody would know.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forAll, gen, type Gen } from '../02_Define_The_Rules/property.ts'
import { createPrefixCache, DEFAULT_POOL_PAGES, kvPagerWasmBytes, MAX_POOL_PAGES, PAGE_TOKENS, SCRATCH_TOKENS, tokenize, type KvExports, type PrefixReport } from './prefixCache.ts'

const ERR = { pages: -1, unknown: -2, exists: -3 }
const words = (prefix: string, n: number): string => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')
const pages = (tokens: number): number => Math.ceil(tokens / PAGE_TOKENS)

// ---------------------------------------------------------------- sizes

test('a table of 0, a fraction, a non-number or a negative number of pages is refused before the module loads', () => {
  for (const n of [0, -1, -0, 0.5, 1.5, Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => createPrefixCache({ prefix: 'a b c', pages: n }), RangeError, `pages ${n}`)
  }
})

test('REGRESSION (Phase 16 audit): a table of 2^32 pages or more is refused, not truncated to pages mod 2^32 by the module\'s u32', async () => {
  for (const n of [2 ** 32, 2 ** 32 + 5, 2 ** 32 - 1, 2 ** 53, Number.MAX_SAFE_INTEGER]) {
    assert.throws(() => createPrefixCache({ prefix: 'a b c', pages: n }), RangeError, `pages ${n}: a table of ${n % 2 ** 32} pages would be built instead`)
  }
  // The largest table the wrapper makes is MAX_POOL_PAGES; that one, and one page, are built.
  for (const n of [1, MAX_POOL_PAGES]) assert.doesNotThrow(() => createPrefixCache({ prefix: 'a b c', pages: n }), `pages ${n}`)
})

test('a table of one page, of exactly the prefix\'s pages, and of one more: what fits is paged, what does not is reported and stops nothing', async () => {
  // A 16-token prefix fills its one page; a fork shares it; the first own token needs a page there is not.
  const full = createPrefixCache({ prefix: words('p', 16), pages: 1 })
  const a = await full.page('a', words('p', 16))
  assert.deepEqual([a.forked, a.hit, a.copies, a.error], [true, false, 0, undefined], 'the prefix alone forks without a page')
  let s = full.stats()!
  assert.deepEqual([s.capacity, s.free, s.mapped, s.shared, s.agents], [1, 0, 1, 1, 1])
  const b = await full.page('b', `${words('p', 16)} own`)
  assert.match(b.error ?? '', /appending token 16 for agent b: out of pages/)
  s = full.stats()!
  assert.deepEqual([s.refused, s.agents, s.mapped], [1, 1, 1], 'the failed fork was released')
  const again = await full.page('a', words('p', 16))
  assert.deepEqual([again.hit, again.error], [true, undefined])
  // A 15-token prefix: the first own token copies the tail, which needs a second page.
  const tail = createPrefixCache({ prefix: words('q', 15), pages: 1 })
  const c = await tail.page('a', `${words('q', 15)} own`)
  assert.match(c.error ?? '', /appending token 15 for agent a: out of pages/)
  assert.equal(tail.stats()!.agents, 0)
  const d = await tail.page('a', words('q', 15))
  assert.deepEqual([d.forked, d.hit, d.copies, d.error], [true, false, 0, undefined])
  const two = createPrefixCache({ prefix: words('q', 15), pages: 2 })
  const e = await two.page('a', `${words('q', 15)} own`)
  assert.deepEqual([e.forked, e.copies, e.error], [true, 1, undefined], 'the copy fits the second page')
  const f = await two.page('b', `${words('q', 15)} other`)
  assert.match(f.error ?? '', /out of pages/)
  assert.deepEqual([two.stats()!.agents, two.stats()!.refused], [1, 1])
  // A pool smaller than the prefix: the prefix itself is refused, every ask after it too, and nothing is live.
  const tiny = createPrefixCache({ prefix: words('r', 40), pages: 2 })
  for (let i = 0; i < 3; i++) {
    const g = await tiny.page(`a${i}`, `${words('r', 40)} x`)
    assert.match(g.error ?? '', /admitting 40 tokens: out of pages/)
    assert.equal(g.prefixHit, false)
  }
  assert.deepEqual([tiny.stats()!.asks, tiny.stats()!.refused, tiny.stats()!.agents], [3, 3, 0])
})

test('an empty prefix, an empty prompt, and a prompt longer than the scratch are paged without error and counted whole', async () => {
  const empty = createPrefixCache({ prefix: '', pages: 64 })
  const a = await empty.page('a', '')
  assert.deepEqual([a.tokens, a.prefixTokens, a.prefixPages, a.forked, a.hit, a.copies, a.error], [0, 0, 0, true, false, 0, undefined])
  const b = await empty.page('a', '')
  assert.equal(b.hit, true)
  const c = await empty.page('b', 'one two three')
  assert.deepEqual([c.tokens, c.forked, c.copies, c.error], [3, true, 0, undefined], 'no tail to copy')
  assert.deepEqual([empty.stats()!.agents, empty.stats()!.mapped], [2, 1])
  const long = createPrefixCache({ prefix: words('p', 95), pages: 2048 })
  const n = SCRATCH_TOKENS + 1000
  const d = await long.page('a', `${words('p', 95)} ${words('w', n - 95)}`)
  assert.deepEqual([d.tokens, d.forked, d.copies, d.error], [n, true, 1, undefined])
  const s = long.stats()!
  assert.ok(s.mapped <= pages(95) + pages(SCRATCH_TOKENS - 95) + 1 && s.mapped >= pages(SCRATCH_TOKENS), `${s.mapped} pages mapped for a prompt paged up to the scratch`)
  assert.equal(s.capacity - s.free, s.mapped + s.idleCached)
})

// ---------------------------------------------------------------- the model

interface Model {
  readonly live: Map<string, string>
  asks: number
  hits: number
  prefixHits: number
  copies: number
  refused: number
  prefixSpawned: boolean
}

/** What the cache must report for `prompt` on behalf of `agent`, given what it held. */
function expect(m: Model, prefix: Uint32Array, agent: string, prompt: string, r: PrefixReport): void {
  const tokens = tokenize(prompt)
  const key = [...tokens].join(',')
  const forked = tokens.length >= prefix.length && prefix.every((t, i) => tokens[i] === t)
  const prefixHit = m.prefixSpawned
  m.asks++
  assert.equal(r.tokens, tokens.length)
  assert.equal(r.prefixTokens, prefix.length)
  assert.equal(r.prefixPages, pages(prefix.length))
  if (r.error !== undefined) {
    assert.match(r.error, /out of pages/, 'the only failure a small pool has')
    m.refused++
    m.live.delete(agent)
    // The report says whether the prefix chain is there after the attempt: once there, it never leaves, and any
    // failure past admitting a prompt (a fork, an append) happened after it was.
    if (m.prefixSpawned || !r.error.startsWith('admitting ')) assert.equal(r.prefixHit, true)
    m.prefixSpawned = r.prefixHit
    return
  }
  m.prefixSpawned = true
  assert.equal(r.prefixHit, prefixHit, 'prefixHit says whether the prefix chain was there before this ask')
  const hit = m.live.get(agent) === key
  assert.equal(r.hit, hit, `hit only for the very tokens the chain holds (${agent}: ${prompt.slice(0, 40)})`)
  if (hit) {
    m.hits++
    assert.deepEqual([r.copies, r.cachedPages], [0, 0])
    // `forked` on a hit is the subject of its own regression test below.
    return
  }
  assert.equal(r.forked, forked, 'forked says whether the prompt opens with the prefix')
  const own = Math.min(tokens.length, SCRATCH_TOKENS) - prefix.length
  const copies = forked && own > 0 && prefix.length % PAGE_TOKENS !== 0 ? 1 : 0
  assert.equal(r.copies, copies, 'exactly one copy on write: the shared tail page, at the first own token')
  if (forked) {
    if (prefixHit) m.prefixHits++
    assert.equal(r.cachedPages, 0)
  } else assert.ok(r.cachedPages >= 0 && r.cachedPages <= Math.floor(tokens.length / PAGE_TOKENS), `${r.cachedPages} cached pages of ${tokens.length} tokens`)
  m.copies += copies
  m.live.set(agent, key)
}

/** A prompt an agent might send: the prefix with own words, the prefix alone, something else, nothing. */
function somePrompt(g: Gen, prefix: string, last: string | undefined): string {
  const own = (): string => Array.from({ length: g.int(0, 40) }, () => g.pick(['rust', 'go', 'ask', 'remember', 'hello', 'plan', 'who', 'skill', `w${g.int(0, 9)}`])).join(' ')
  switch (g.int(0, 6)) {
    case 0: return last ?? `${prefix} ${own()}`
    case 1: return prefix
    case 2: return own()
    case 3: return ''
    case 4: return `${prefix.split(' ').slice(0, -1).join(' ')} ${own()}`
    default: return `${prefix} ${own()}`
  }
}

test('over random asks on pools that run out, every report is the model\'s and the counts add up', async () => {
  const cases = gen(0x9a9e5)
  const RUNS = 120
  for (let i = 0; i < RUNS; i++) {
    const c = { seed: cases.int(0, 2 ** 31), pool: cases.pick([2, 4, 8, 16, 64, 256]), prefixWords: cases.pick([0, 1, 15, 16, 17, 31, 32, 40, 95]), ops: cases.int(10, 40) }
    try {
      const g = gen(c.seed)
      const prefix = words('base', c.prefixWords)
      const prefixTokens = tokenize(prefix)
      const cache = createPrefixCache({ prefix, pages: c.pool })
      assert.equal(cache.stats(), null)
      assert.equal(cache.line(), null)
      const m: Model = { live: new Map(), asks: 0, hits: 0, prefixHits: 0, copies: 0, refused: 0, prefixSpawned: false }
      const lastPrompt = new Map<string, string>()
      for (let op = 0; op < c.ops; op++) {
        const agent = `a${g.int(0, 5)}`
        const prompt = somePrompt(g, prefix, lastPrompt.get(agent))
        const r = await cache.page(agent, prompt)
        if (r.error === undefined) lastPrompt.set(agent, prompt)
        else lastPrompt.delete(agent)
        expect(m, prefixTokens, agent, prompt, r)
        const s = cache.stats()!
        assert.deepEqual([s.asks, s.hits, s.prefixHits, s.copies, s.refused, s.agents], [m.asks, m.hits, m.prefixHits, m.copies, m.refused, m.live.size], `op ${op}: counts`)
        assert.deepEqual([s.capacity, s.prefixTokens, s.prefixPages], [c.pool, prefixTokens.length, pages(prefixTokens.length)])
        assert.equal(s.capacity - s.free, s.mapped + s.idleCached, `op ${op}: every page free, idle or mapped`)
        assert.ok(s.shared <= s.mapped, `op ${op}: ${s.shared} shared of ${s.mapped} mapped`)
        // The pool counts are those of the last successful ask (a failure does not refresh them): after one, the
        // prefix chain and every live chain are mapped, and nothing beyond their pages is.
        if (r.error === undefined) {
          assert.ok(s.mapped >= pages(prefixTokens.length), `op ${op}: the prefix chain is mapped`)
          let most = 0
          for (const key of m.live.values()) most += pages(Math.min(key === '' ? 0 : key.split(',').length, SCRATCH_TOKENS))
          assert.ok(s.mapped <= pages(prefixTokens.length) + most, `op ${op}: ${s.mapped} mapped for chains of at most ${pages(prefixTokens.length) + most} pages`)
        }
        assert.equal(s.lastError, r.error ?? s.lastError)
        assert.ok((cache.line() ?? '').startsWith(`prefix ${s.prefixPages} page`), cache.line() ?? 'no line')
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      throw new Error(`property 'prefix cache model' failed on case ${i} of seed 0x9a9e5 (replay: skip ${i} cases): ${why}\ncase: ${JSON.stringify(c)}`, { cause: e })
    }
  }
})

test('a key never paged is never a hit, and the same agent re-paged 4,000 times leaves the pool and the JS heap where they were', async () => {
  const prefix = words('base', 95)
  const cache = createPrefixCache({ prefix, pages: 256 })
  const gc = (globalThis as { gc?: () => void }).gc
  const heap = (): number => {
    gc?.()
    gc?.()
    return process.memoryUsage().heapUsed
  }
  for (const key of ['never', 'seen', '7', '']) {
    const r = await cache.page(key, `${prefix} ${key}`)
    assert.equal(r.hit, false, `${key}: a first ask is never a hit`)
  }
  const cycle = async (n: number): Promise<void> => {
    for (let i = 0; i < n; i++) {
      await cache.page('a', `${prefix} ${i % 2 ? 'left' : 'right'} memory`)
      await cache.page('b', `${prefix} steady`)
    }
  }
  await cycle(20)
  const s0 = cache.stats()!
  const h0 = heap()
  await cycle(2000)
  const s1 = cache.stats()!
  assert.deepEqual([s1.mapped, s1.idleCached, s1.free, s1.shared, s1.agents, s1.refused], [s0.mapped, s0.idleCached, s0.free, s0.shared, 6, 0], 'the pool after 4,000 re-pages is the pool after 40')
  assert.equal(s1.asks - s0.asks, 4000)
  assert.equal(s1.hits - s0.hits, 2000, 'every steady ask was a hit')
  assert.equal(s1.copies - s0.copies, 2000, 'every re-page copied the tail once')
  if (gc !== undefined) {
    const grown = heap() - h0
    assert.ok(grown < 2 * 1024 * 1024, `the JS heap grew ${grown} bytes over 4,000 asks`)
  }
})

// ---------------------------------------------------------------- the regressions of the audit

test('REGRESSION (Phase 16 audit): two prompts whose 32-bit digests collide are not the same prompt: the second is no hit', async () => {
  // Found by a birthday search over two varying words (seed 0xc0111de): different tokens, one digest.
  const prefix = words('word', 40)
  const p1 = `${prefix} agent amln3i 2ct06j answers`
  const p2 = `${prefix} agent 63cvqg c70vsc answers`
  assert.notDeepEqual([...tokenize(p1)], [...tokenize(p2)])
  const cache = createPrefixCache({ prefix, pages: 64 })
  const a = await cache.page('7', p1)
  assert.deepEqual([a.forked, a.hit, a.copies, a.error], [true, false, 1, undefined])
  const b = await cache.page('7', p2)
  assert.equal(b.hit, false, 'a different prompt for the same agent is paged afresh, whatever its digest')
  assert.equal(b.copies, 1)
  assert.deepEqual([cache.stats()!.hits, cache.stats()!.asks], [0, 2])
})

test('REGRESSION (Phase 16 audit): every forked prompt with own tokens copies the tail page exactly once, also when an append grows the module\'s memory', async () => {
  // The base reality is 95 tokens (15 mod 16): a forked chain's first own token fills and seals the copied tail page,
  // a prefix cache insert that rehashes now and then, which grows the memory and detaches a view taken before the loop.
  const prefix = words('base', 95)
  const cache = createPrefixCache({ prefix, pages: DEFAULT_POOL_PAGES })
  const wrong: string[] = []
  let paged = 0
  for (let agent = 0; agent < 2045; agent++) {
    const r = await cache.page(`a${agent}`, `${prefix} agent-${agent} answers`)
    if (r.error !== undefined) break
    paged++
    if (!(r.forked && r.copies === 1)) wrong.push(`agent ${agent}: copies ${r.copies}`)
  }
  assert.ok(paged >= 2000, `${paged} prompts paged`)
  assert.deepEqual(wrong, [], 'reports with a copy uncounted')
  assert.equal(cache.stats()!.copies, paged)
})

test('REGRESSION (Phase 16 audit): a hit for a prompt that never opened with the prefix does not report it as forked', async () => {
  const cache = createPrefixCache({ prefix: 'a b', pages: 8 })
  const first = await cache.page('x', 'c d')
  assert.deepEqual([first.forked, first.hit], [false, false])
  const again = await cache.page('x', 'c d')
  assert.equal(again.hit, true)
  assert.equal(again.forked, false, 'a hit reports forked as the chain was made, not as a literal')
})

// ---------------------------------------------------------------- the module's eviction order

test('through the ABI: pages left by released agents are evicted oldest-released first, so the chains released last stay cached, and a key never spawned is unknown', async () => {
  const { instance } = await WebAssembly.instantiate(kvPagerWasmBytes(), {})
  const e = instance.exports as unknown as KvExports
  const spawn = (h: number, agent: number, tokens: number[]): number => {
    new Uint32Array(e.memory.buffer, e.kv_scratch(h), tokens.length).set(tokens)
    return e.kv_spawn(h, agent, tokens.length)
  }
  const stats = (h: number): { free: number; idle: number; mapped: number; agents: number } => {
    assert.equal(e.kv_stats(h), 0)
    const s = new Uint32Array(e.memory.buffer, e.kv_out(h), 8)
    return { free: s[1], idle: s[2], mapped: s[3], agents: s[7] }
  }
  const chain = (k: number): number[] => Array.from({ length: 2 * PAGE_TOKENS }, (_, i) => 1000 * (k + 1) + i)
  forAll('eviction order', { seed: 0xe71c, runs: 150 }, (g) => {
    const k = g.int(3, 12)
    const order = Array.from({ length: k }, (_, i) => i)
    for (let i = k - 1; i > 0; i--) {
      const j = g.int(0, i)
      ;[order[i], order[j]] = [order[j], order[i]]
    }
    return { k, order, evict: g.int(1, k - 1) }
  }, ({ k, order, evict }) => {
    const h = e.kv_new(2 * k, 4 * PAGE_TOKENS * k)
    assert.ok(h !== 0)
    try {
      for (let c = 0; c < k; c++) assert.equal(spawn(h, c + 1, chain(c)), 0, `chain ${c} has no cached page yet`)
      assert.deepEqual(stats(h), { free: 0, idle: 0, mapped: 2 * k, agents: k })
      for (const c of order) assert.equal(e.kv_despawn(h, c + 1), 0)
      assert.deepEqual(stats(h), { free: 0, idle: 2 * k, mapped: 0, agents: 0 })
      for (const unknown of [0, 99, 2 ** 32 - 1]) {
        assert.equal(e.kv_len(h, unknown), ERR.unknown)
        assert.equal(e.kv_despawn(h, unknown), ERR.unknown)
        assert.equal(e.kv_append(h, unknown, 1), ERR.unknown)
        assert.equal(e.kv_fork(h, unknown, 500), ERR.unknown)
      }
      // A newcomer needing 2 · evict pages takes the 2 · evict oldest idle pages: the first `evict` chains released.
      const newcomer = Array.from({ length: 2 * evict * PAGE_TOKENS }, (_, i) => 500_000 + i)
      assert.equal(spawn(h, 100, newcomer), 0)
      assert.deepEqual(stats(h), { free: 0, idle: 2 * (k - evict), mapped: 2 * evict, agents: 1 })
      assert.equal(e.kv_despawn(h, 100), 0)
      // The survivors, newest-released first: both pages cached, nothing evicted on the way.
      const survivors = order.slice(evict).reverse()
      for (const c of survivors) {
        assert.equal(spawn(h, 200 + c, chain(c)), 2, `chain ${c}, released ${order.indexOf(c) + 1}th of ${k}, survives ${evict} evicted chains`)
      }
      assert.deepEqual(stats(h), { free: 0, idle: 2 * evict, mapped: 2 * (k - evict), agents: k - evict })
      // The evicted: no page cached (a chain is cached from its first page on), paged afresh into the newcomer's pages.
      for (const c of order.slice(0, evict)) assert.equal(spawn(h, 200 + c, chain(c)), 0, `chain ${c}, released ${order.indexOf(c) + 1}th, was evicted`)
      assert.deepEqual(stats(h), { free: 0, idle: 0, mapped: 2 * k, agents: k })
      assert.equal(spawn(h, 300, [1]), ERR.pages, 'a full pool refuses')
      assert.equal(spawn(h, 200, chain(0)), ERR.exists)
      assert.equal(e.kv_check(h), 0)
      for (let c = 0; c < k; c++) assert.equal(e.kv_len(h, 200 + c), 2 * PAGE_TOKENS)
    } finally {
      e.kv_free(h)
    }
  })
})
