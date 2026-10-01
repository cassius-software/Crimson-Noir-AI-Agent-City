/**
 * Why does this file exist? It proves the prompt-prefix page table (prefixCache.ts) over the real kv-pager module:
 * the generated module is the bytes it records; the tokenizer is deterministic; the shared prefix is one chain,
 * forked per agent, whose first own token copies the shared tail page once; the same prompt again is a hit; a prompt
 * not opening with the prefix is its own chain and a second copy of it finds its full pages cached; a table too
 * small refuses a prompt in the report without stopping anything; and the `ask` line says all of it in one line.
 * What breaks if it is removed? The counts `ask` shows could stop meaning what the README says they mean.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { KV_PAGER_WASM_BASE64, KV_PAGER_WASM_BYTES, KV_PAGER_WASM_SHA256 } from './kvPager.wasm.ts'
import { BASE_REALITY, systemPrompt } from './localCompute.ts'
import { PAGE_TOKENS, createPrefixCache, decodeBase64, kvPagerWasmBytes, tokenize } from './prefixCache.ts'

/** A 40-word prefix: two full pages and a tail of eight tokens. */
const PREFIX = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
const prompt = (who: string): string => `${PREFIX}\nYou are answering for ${who}.\nYour expertise is exactly: ${who}.`

test('the generated module is the bytes it records: length, SHA-256 and the WebAssembly magic', () => {
  const bytes = decodeBase64(KV_PAGER_WASM_BASE64)
  assert.equal(bytes.length, KV_PAGER_WASM_BYTES)
  assert.equal(createHash('sha256').update(bytes).digest('hex'), KV_PAGER_WASM_SHA256)
  assert.deepEqual([...bytes.subarray(0, 4)], [0, 0x61, 0x73, 0x6d])
  assert.equal(kvPagerWasmBytes().length, KV_PAGER_WASM_BYTES)
})

test('the tokenizer: whitespace words to 32-bit ids, the same text to the same ids, a page is 16 of them', () => {
  const a = tokenize('You are an entity in a simulation.\n  Maintain strict\tbehavior.')
  assert.equal(a.length, 10)
  assert.deepEqual([...tokenize('You are an entity in a simulation. Maintain strict behavior.')], [...a])
  assert.notEqual(a[0], a[1])
  assert.equal(a[0], tokenize('You')[0])
  assert.ok([...a].every((t) => Number.isInteger(t) && t >= 0 && t < 2 ** 32))
  assert.equal(tokenize('   ').length, 0)
  assert.equal(PAGE_TOKENS, 16)
  assert.equal(tokenize(PREFIX).length, 40)
  // The real prefix is pages long, and the real system prompt opens with it.
  assert.ok(tokenize(BASE_REALITY).length > 2 * PAGE_TOKENS)
  const real = tokenize(systemPrompt([{ agent: 7, serial: 1, skills: ['Rust'] }]))
  assert.deepEqual([...real.subarray(0, tokenize(BASE_REALITY).length)], [...tokenize(BASE_REALITY)])
})

test('the shared prefix is one chain forked per agent; the first own token copies the shared tail page once; the same prompt again is a hit', async () => {
  const cache = createPrefixCache({ prefix: PREFIX, pages: 64 })
  assert.equal(cache.stats(), null)
  assert.equal(cache.line(), null)
  const a = await cache.page('7', prompt('agent 7 (Rust)'))
  assert.deepEqual(a, { tokens: a.tokens, prefixTokens: 40, prefixPages: 3, forked: true, prefixHit: false, hit: false, copies: 1, cachedPages: 0 })
  assert.ok(a.tokens > 40)
  let s = cache.stats()!
  assert.deepEqual([s.asks, s.prefixHits, s.hits, s.copies, s.refused, s.agents], [1, 0, 0, 1, 0, 1])
  // The prefix chain (3 pages) plus the agent's private tail copy and whatever its own words fill: the two full
  // prefix pages are shared by the prefix chain and the agent; the prefix's tail is the prefix chain's alone.
  assert.equal(s.shared, 2)
  assert.ok(s.mapped >= 4 && s.capacity === 64 && s.capacity - s.free === s.mapped + s.idleCached, JSON.stringify(s))
  const b = await cache.page('9', prompt('agent 9 (Go)'))
  assert.deepEqual([b.forked, b.prefixHit, b.hit, b.copies], [true, true, false, 1])
  s = cache.stats()!
  assert.deepEqual([s.asks, s.prefixHits, s.hits, s.copies, s.agents, s.shared], [2, 1, 0, 2, 2, 2])
  const c = await cache.page('7', prompt('agent 7 (Rust)'))
  assert.deepEqual([c.forked, c.prefixHit, c.hit, c.copies], [true, true, true, 0])
  s = cache.stats()!
  assert.deepEqual([s.asks, s.prefixHits, s.hits, s.copies, s.agents], [3, 1, 1, 2, 2])
  // The same agent with a new prompt (a memory added) is paged afresh: its old chain is released first.
  const mapped = s.mapped
  const d = await cache.page('7', prompt('agent 7 (Rust)') + '\nAgent 7 remembers, oldest first:\n- ask: hi → hello')
  assert.deepEqual([d.forked, d.prefixHit, d.hit, d.copies], [true, true, false, 1])
  s = cache.stats()!
  assert.deepEqual([s.asks, s.prefixHits, s.hits, s.copies, s.agents], [4, 2, 1, 3, 2])
  assert.ok(s.mapped >= mapped, 'the released chain left its pages cached or freed, not leaked into the count')
  assert.equal(cache.line(), `prefix 3 pages (40 tokens), forked for 2 agents · 4 asks: 2 reused the prefix, 1 the whole prompt · ${s.mapped} pages mapped, ${s.shared} shared · 3 copies on write · pool ${s.capacity - s.free}/64 pages`)
})

test('a prompt not opening with the prefix is its own chain; a second copy of it finds its full pages cached', async () => {
  const cache = createPrefixCache({ prefix: PREFIX, pages: 64 })
  const other = Array.from({ length: 35 }, (_, i) => `other${i}`).join(' ')
  const a = await cache.page('1', other)
  assert.deepEqual([a.forked, a.prefixHit, a.hit, a.copies, a.cachedPages], [false, false, false, 0, 0])
  const b = await cache.page('2', other)
  assert.deepEqual([b.forked, b.prefixHit, b.hit, b.cachedPages], [false, true, false, 2], 'two full pages of the same words, the tail is its own')
  const s = cache.stats()!
  assert.deepEqual([s.asks, s.prefixHits, s.hits, s.agents, s.shared], [2, 0, 0, 2, 2])
})

test('a table too small refuses in the report and the line, stops nothing, and goes on paging what fits', async () => {
  // Five pages: the prefix's three, and two for an agent's tail copy and one page of its own words.
  const cache = createPrefixCache({ prefix: PREFIX, pages: 5 })
  const a = await cache.page('7', prompt('agent 7 (Rust) with a long enough tail to need pages ' + 'x '.repeat(40)))
  assert.equal(a.forked, false)
  assert.match(a.error ?? '', /appending token \d+ for agent 7: out of pages/)
  const s = cache.stats()!
  assert.deepEqual([s.asks, s.refused, s.agents], [1, 1, 0])
  assert.match(cache.line() ?? '', / · 1 not paged: appending token \d+ for agent 7: out of pages$/)
  // The table is as it was: the prefix chain alone, and a short prompt still fits.
  const b = await cache.page('9', prompt('agent 9'))
  assert.deepEqual([b.forked, b.prefixHit, b.hit, b.error], [true, true, false, undefined])
  assert.throws(() => createPrefixCache({ prefix: PREFIX, pages: 0 }), RangeError)
})
