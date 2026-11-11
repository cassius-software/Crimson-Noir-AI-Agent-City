// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the rule auto follows to size Ollama's model by the GPUs' memory (modelFit.ts),
 * as pure functions. One grammar reads the figure at the console and in the address: the console refuses anything
 * else, the address ignores it, and nothing is capped. The console beats the address, and 0 there sizes nothing. A
 * measurement's place and verdict follow Ollama's own /api/ps in every combination. A model whose weights alone exceed
 * the figure is never chosen while a smaller one is listed, today's pick included. No step up comes before a
 * measurement on the GPU, and the need uses the largest loaded-to-weights ratio measured, not the newest. What is kept
 * between visits is read back checked and bounded, and every sentence of the console's fit row is exact, ASCII and
 * free of the words the console never carries. Ollama's context grows only on a cut answer measured all on the GPU at
 * the context Ollama said, fast enough and with room, once, to at most 32,768, each boundary one step either side; the
 * answer cap is a quarter of it and never below 2,048; and the verdict on a larger context follows every branch.
 * What breaks if it is removed? Auto could give a big GPU's Ollama a model that cannot fit, grow on a guess, keep a
 * corrupt record, ask Ollama for a context that does not fit, or say something on the fit row that is not what it
 * did, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ANSWER_TOKENS, answerTokensFor, CONTEXT_MAX, CONTEXT_TOKENS, DEFAULT_MODEL, FIRST_PIECE_MS, type Placement, type Weighed } from './localCompute.ts'
import {
  ANSWER_WAIT_S, budgetOf, choose, COLD_READ_BYTES_S, coldWaitMs, contextVerdict, FAILS_KEPT, failed, DXGI_FLOOR_BYTES, figureFromAdapters, figureOf, fitLine, gbText, GIB, grouped, PACE_FLOOR, PACE_TOKENS, parseVram, readFit, readGb, remember,
  RESERVE_BYTES, SEEN_MAX, todaysPick, VRAM_MAX_GB, VRAM_USAGE, whereOf, widen, WIDEN_FLOOR_BYTES, type Figure, type FitInput, type Seen, type Where, type Wide,
} from './modelFit.ts'

/** The words no console text may carry, spelled backwards here so this file carries none of them itself (features.test.ts). */
const WORDS = new RegExp(`\\b(${['tegrat', 'hsarc', 'tih', 'erif', 'ekirts', 'llik', 'daed', 'eid', 'xirtam'].map((w) => [...w].reverse().join('')).join('|')})\\b`, 'i')
const ASCII = /^[\x20-\x7e]*$/

const SERVER = 'http://localhost:11434'
const W = (name: string, bytes: number | null, text = true): Weighed => ({ name, bytes, text })
/** A measurement on this machine's Ollama: all on the GPU unless `gpu` says otherwise. */
const S = (model: string, weights: number, loaded: number, gpu = loaded, over: Partial<Seen> = {}): Seen => ({ server: SERVER, model, weights, loaded, gpu, pace: 40, fails: 0, ...over })
const ADDRESS = (gb: number): Figure => ({ gb, from: 'address' })
const ASK = (gb: number): Figure => ({ gb, from: 'ask' })
const NONE: ReadonlySet<string> = new Set()

test('readGb and parseVram: one grammar, plain decimals from 0 to 4096; the console refuses the rest, the address ignores it, nothing is capped', () => {
  for (const [text, gb] of [['0', 0], ['24', 24], ['24.0', 24], ['318.5', 318.5], ['4096', 4096]] as const) {
    assert.equal(readGb(text), gb, text)
    assert.equal(parseVram(text), gb, text)
  }
  // At the console the figure may come with spaces around it; 'auto' in any case hands sizing back to the address.
  assert.equal(parseVram(' 24 '), 24)
  assert.equal(parseVram(' AUTO '), 'auto')
  assert.equal(parseVram('auto'), 'auto')
  for (const bad of ['-1', '4096.1', '5000', '1e3', '24GB', '24,5', '0x10', 'Infinity', 'NaN', '', ' ', '.5', '24.', '+24', '12345']) {
    assert.equal(readGb(bad), null, `readGb ${JSON.stringify(bad)}`)
    assert.throws(() => parseVram(bad), (e: unknown) => e instanceof TypeError && e.message === VRAM_USAGE, `parseVram ${JSON.stringify(bad)}`)
  }
  // Not text at all: the address ignores it, the console refuses it.
  for (const bad of [24, null, undefined, {}, ['24']]) {
    assert.equal(readGb(bad), null)
    assert.throws(() => parseVram(bad), (e: unknown) => e instanceof TypeError && e.message === VRAM_USAGE)
  }
  // The address is read as typed: spaces are not part of the grammar there.
  assert.equal(readGb(' 24'), null)
  assert.equal(VRAM_MAX_GB, 4096)
  assert.equal(VRAM_USAGE, "ask vram takes the GPUs' memory in GB, from 0 to 4096 (such as ask vram 24; 0 sizes nothing), or auto")
  assert.match(VRAM_USAGE, ASCII)
  assert.doesNotMatch(VRAM_USAGE, WORDS)
})

test('figureOf: the console beats the address; 0 at the console sizes nothing whatever the address says; a bad or zero address is no figure', () => {
  assert.deepEqual(figureOf(24, null), { gb: 24, from: 'ask' })
  assert.deepEqual(figureOf(24, '100'), { gb: 24, from: 'ask' }, 'the console beats the address')
  assert.deepEqual(figureOf(0.5, '100'), { gb: 0.5, from: 'ask' })
  assert.equal(figureOf(0, '24'), null, '0 at the console: off, whatever the address says')
  assert.equal(figureOf(0, null), null)
  assert.deepEqual(figureOf(null, '24'), { gb: 24, from: 'address' })
  assert.deepEqual(figureOf(null, '318.5'), { gb: 318.5, from: 'address' })
  for (const address of ['0', '0.0', 'lots', '5000', '-1', '24GB', '', null, undefined]) assert.equal(figureOf(null, address), null, String(address))
  // The Windows app's reading: below the console and the address. vram=0 in the address sizes nothing, as at the
  // console; an address figure the page does not take is no address at all, so the app's reading stands.
  assert.deepEqual(figureOf(null, null, 7.9), { gb: 7.9, from: 'app' })
  assert.deepEqual(figureOf(null, 'lots', 7.9), { gb: 7.9, from: 'app' }, 'an address the page does not take leaves the app\'s reading')
  assert.deepEqual(figureOf(null, '24', 7.9), { gb: 24, from: 'address' }, 'the address beats the app')
  assert.deepEqual(figureOf(16, '24', 7.9), { gb: 16, from: 'ask' }, 'the console beats both')
  assert.equal(figureOf(0, null, 7.9), null, '0 at the console: off, whatever the app read')
  assert.equal(figureOf(null, '0', 7.9), null, 'vram=0 in the address: off, whatever the app read')
  for (const app of [0, -1, NaN, Infinity, VRAM_MAX_GB + 0.1, null]) assert.equal(figureOf(null, null, app), null, String(app))
  assert.deepEqual(figureOf(null, null, VRAM_MAX_GB), { gb: VRAM_MAX_GB, from: 'app' })
  // The budget a bigger model's need must fit: the figure less the reserve.
  assert.equal(RESERVE_BYTES, 2 * GIB)
  assert.equal(GIB, 2 ** 30)
  assert.equal(budgetOf(ASK(24)), 22 * GIB)
  assert.equal(budgetOf(ADDRESS(23.9)), 23.9 * GIB - 2 * GIB)
})

test('figureFromAdapters: the Windows app\'s reading: adapters under 3.5 GiB are not counted, the rest summed as the launcher sums, in GB rounded down to 0.1', () => {
  assert.equal(DXGI_FLOOR_BYTES, 3.5 * GIB)
  // An integrated GPU's carve-out (512 MB) alone: no figure, so auto keeps its usual model, as before.
  assert.equal(figureFromAdapters([512 * 2 ** 20]), null)
  assert.equal(figureFromAdapters([]), null)
  // A 3 GB card, or a 3 GB carve-out, is not counted; the floor itself is.
  assert.equal(figureFromAdapters([3 * GIB]), null)
  assert.equal(figureFromAdapters([3.5 * GIB - 1]), null, 'just under the floor')
  assert.equal(figureFromAdapters([3.5 * GIB]), 3.5)
  // A laptop's 4 GB card beside its integrated GPU, as DXGI reads it (3,949 MB, a little under 4 GiB): the card alone
  // counts, rounded down (3.856 is 3.8, not 3.9).
  assert.equal(figureFromAdapters([512 * 2 ** 20, 3949 * 2 ** 20]), 3.8)
  assert.equal(figureFromAdapters([4 * GIB]), 4)
  // Four 80 GB data-centre GPUs are summed.
  assert.equal(figureFromAdapters([80 * GIB, 80 * GIB, 80 * GIB, 80 * GIB]), 320)
  // A sum above the page's ceiling is no figure; nothing is capped.
  assert.equal(figureFromAdapters(Array.from({ length: 52 }, () => 80 * GIB)), null)
  assert.equal(figureFromAdapters(Array.from({ length: 51 }, () => 80 * GIB)), 4080)
  // Anything that is not a whole number of bytes up to 2^50 is not counted; anything not a list is no figure.
  assert.equal(figureFromAdapters([8 * GIB, -8 * GIB, 8.5 * GIB + 0.5, NaN, Infinity, 2 ** 51, '8589934592', null]), 8)
  for (const reading of [null, undefined, 8 * GIB, '8589934592', { 0: 8 * GIB, length: 1 }]) assert.equal(figureFromAdapters(reading), null, String(reading))
})

test('whereOf: nothing on the GPU is the processor, all of it the GPU, between is split', () => {
  assert.equal(whereOf({ loaded: 5e9, gpu: 0 }), 'cpu')
  assert.equal(whereOf({ loaded: 5e9, gpu: -1 }), 'cpu')
  assert.equal(whereOf({ loaded: 5e9, gpu: 5e9 }), 'gpu')
  assert.equal(whereOf({ loaded: 5e9, gpu: 6e9 }), 'gpu')
  assert.equal(whereOf({ loaded: 5e9, gpu: 1 }), 'split')
  assert.equal(whereOf({ loaded: 5e9, gpu: 5e9 - 1 }), 'split')
})

test('failed: a cold wait fails only a split model; otherwise a model no bigger than usual fails when split and slow, a bigger one when slow', () => {
  // Every combination, written out: the ones that fail, and every other passes.
  const fails = new Set([
    // A cold wait (the first piece never came): split, whatever else.
    'cold split slow larger', 'cold split slow usual', 'cold split quick larger', 'cold split quick usual',
    // A bigger model: slow, wherever it sits.
    'warm gpu slow larger', 'warm split slow larger', 'warm cpu slow larger',
    // A model no bigger than usual: split and slow.
    'warm split slow usual',
  ])
  let n = 0
  for (const cold of [true, false]) for (const where of ['gpu', 'split', 'cpu'] as Where[]) for (const slow of [true, false]) for (const larger of [true, false]) {
    const key = `${cold ? 'cold' : 'warm'} ${where} ${slow ? 'slow' : 'quick'} ${larger ? 'larger' : 'usual'}`
    assert.equal(failed({ where, slow }, { larger, cold }), fails.has(key), key)
    n++
  }
  assert.equal(n, 24)
  assert.equal(PACE_FLOOR, 5)
  assert.equal(PACE_TOKENS, 32)
  assert.equal(FAILS_KEPT, 2)
})

test('todaysPick is router.ts\'s own rule: the model kept while listed, else the default, else the first text model by name', () => {
  assert.equal(todaysPick(['a:1b', 'qwen3-vl:4b', 'z:7b'], 'z:7b'), 'z:7b', 'the model kept, while listed')
  assert.equal(todaysPick(['a:1b', 'qwen3-vl:4b', 'z:7b'], 'gone:1b'), DEFAULT_MODEL, 'else the default')
  assert.equal(todaysPick(['all-minilm', 'kimi-k3:cloud', 'nomic-embed-text', 'x:7b', 'y:7b'], DEFAULT_MODEL), 'x:7b', 'else the first that writes text on this machine')
  assert.equal(todaysPick(['nomic-embed-text'], DEFAULT_MODEL), DEFAULT_MODEL, 'none: the model as it is')
  assert.equal(todaysPick([], 'mine:1b'), 'mine:1b')
})

test('choose: no step up without a measurement on the GPU; then the largest that fits by need; ties go to the first by name', () => {
  const listed = [W('qwen3-vl:4b', 3.3e9), W('qwen3:14b', 9.3e9), W('qwen3:32b', 20e9)]
  const base = { listed, usual: 'qwen3-vl:4b', figure: ADDRESS(23.9), avoided: NONE, grow: true }
  assert.deepEqual(choose({ ...base, seen: [] }), { name: 'qwen3-vl:4b', step: 'usual', bytes: 3.3e9 }, 'nothing measured: no step')
  // Measured at 5.0e9 loaded for 3.3e9 of weights, all on the GPU: 14b needs 13.1 GB and fits 21.9; 32b needs 28.2 and does not.
  const seen = [S('qwen3-vl:4b', 3.3e9, 5e9)]
  assert.deepEqual(choose({ ...base, seen }), { name: 'qwen3:14b', step: 'up', bytes: 9.3e9, need: Math.ceil(9.3e9 * (5e9 / 3.3e9)) })
  assert.equal(choose({ ...base, seen }).need, 14_090_909_091)
  // A bigger figure: straight to the largest that fits, in one step.
  assert.deepEqual(choose({ ...base, figure: ADDRESS(48), seen }), { name: 'qwen3:32b', step: 'up', bytes: 20e9, need: Math.ceil(20e9 * (5e9 / 3.3e9)) })
  // A model's own measured size is its need, whatever the ratio says.
  const own = [S('qwen3:32b', 20e9, 21e9), S('qwen3-vl:4b', 3.3e9, 5e9)]
  assert.deepEqual(choose({ ...base, seen: own }), { name: 'qwen3:32b', step: 'up', bytes: 20e9, need: 21e9 })
  // A need just over the budget does not fit; just at it does.
  const budget = budgetOf(ADDRESS(23.9))
  assert.equal(choose({ ...base, seen: [S('qwen3:32b', 20e9, budget + 1), S('qwen3-vl:4b', 3.3e9, 5e9)] }).name, 'qwen3:14b')
  assert.equal(choose({ ...base, seen: [S('qwen3:32b', 20e9, budget), S('qwen3-vl:4b', 3.3e9, 5e9)] }).name, 'qwen3:32b')
  // Ties: the first by name (the list arrives sorted by name).
  const tied = [W('alpha:14b', 9.3e9), W('beta:14b', 9.3e9), W('small:1b', 1e9)]
  assert.deepEqual(choose({ listed: tied, usual: 'small:1b', figure: ASK(24), seen: [S('small:1b', 1e9, 1.2e9)], avoided: NONE, grow: true }), { name: 'alpha:14b', step: 'up', bytes: 9.3e9, need: Math.ceil(9.3e9 * 1.2) })
  // The usual model's size unknown (not listed, or no size): nothing to compare, no step.
  assert.deepEqual(choose({ ...base, usual: 'elsewhere:7b', seen }), { name: 'elsewhere:7b', step: 'usual', bytes: null })
  assert.deepEqual(choose({ ...base, listed: [W('qwen3-vl:4b', null), ...listed.slice(1)], seen }), { name: 'qwen3-vl:4b', step: 'usual', bytes: null })
})

test('choose: need uses the largest loaded-to-weights ratio measured, not the newest', () => {
  // Ratio 1.8, then 1.1 (the newest). c (10e9) needs 18e9 at 1.8, 11e9 at 1.1; the budget at 16 GB is 15.0e9.
  const listed = [W('a:1b', 1e9), W('b:2b', 2e9), W('c:10b', 10e9)]
  const base = { listed, usual: 'b:2b', figure: ADDRESS(16), avoided: NONE, grow: true }
  const both = [S('a:1b', 1e9, 1.8e9), S('b:2b', 2e9, 2.2e9)]
  assert.deepEqual(choose({ ...base, seen: both }), { name: 'b:2b', step: 'usual', bytes: 2e9 }, 'fits only at the newest ratio: not chosen')
  // The same candidate with only the smaller ratio measured would be chosen: the larger one is what holds it back.
  assert.deepEqual(choose({ ...base, seen: [S('b:2b', 2e9, 2.2e9)] }).name, 'c:10b')
  // A ratio below 1 (a model loaded smaller than its listed weights) never shrinks the need below the weights.
  const shrunk = choose({ ...base, figure: ADDRESS(11.5), seen: [S('b:2b', 2e9, 1e9)] })
  assert.deepEqual(shrunk, { name: 'c:10b', step: 'up', bytes: 10e9, need: 10e9 })
})

test('choose: a usual model whose weights alone exceed the figure steps down to the largest smaller one that fits, or is stuck', () => {
  const listed = [W('deepseek-r1:671b', 404e9), W('qwen3:235b', 142e9), W('qwen3:8b', 5.2e9)]
  // Today's pick by name, with the default not listed, is the 671b.
  const usual = todaysPick(listed.map((m) => m.name), DEFAULT_MODEL)
  assert.equal(usual, 'deepseek-r1:671b')
  const base = { listed, usual, figure: ADDRESS(318.5), avoided: NONE, grow: true }
  assert.deepEqual(choose({ ...base, seen: [] }), { name: 'qwen3:235b', step: 'down', bytes: 142e9, cause: 'misfit' }, 'nothing measured needed: the weights alone decide')
  // Even with a measurement on the GPU, the misfit steps down first.
  assert.deepEqual(choose({ ...base, seen: [S('qwen3:8b', 5.2e9, 6e9)] }), { name: 'qwen3:235b', step: 'down', bytes: 142e9, cause: 'misfit' })
  // A smaller figure: the largest smaller one that fits.
  assert.deepEqual(choose({ ...base, figure: ADDRESS(100), seen: [] }), { name: 'qwen3:8b', step: 'down', bytes: 5.2e9, cause: 'misfit' })
  // Nothing smaller fits: stuck, with the usual model.
  assert.deepEqual(choose({ ...base, listed: listed.slice(0, 2), figure: ADDRESS(100), seen: [] }), { name: 'deepseek-r1:671b', step: 'stuck', bytes: 404e9, cause: 'misfit' })
  assert.deepEqual(choose({ ...base, listed: listed.slice(0, 1), seen: [] }), { name: 'deepseek-r1:671b', step: 'stuck', bytes: 404e9, cause: 'misfit' })
  // Weights exactly at the figure fit.
  assert.deepEqual(choose({ ...base, listed: [W('just:1b', 24 * GIB), W('small:1b', 1e9)], usual: 'just:1b', figure: ASK(24), seen: [] }), { name: 'just:1b', step: 'usual', bytes: 24 * GIB })
})

test('choose: an avoided model is neither a step nor kept; a model that writes no text is never a step', () => {
  const listed = [W('a:1b', 1e9), W('b:4b', 3.3e9), W('c:8b', 5e9), W('d:14b', 9e9, false), W('e:20b', null)]
  const base = { listed, figure: ASK(24), seen: [] as Seen[], grow: true }
  assert.deepEqual(choose({ ...base, usual: 'c:8b', avoided: new Set(['c:8b']) }), { name: 'b:4b', step: 'down', bytes: 3.3e9, cause: 'measured' })
  assert.deepEqual(choose({ ...base, usual: 'c:8b', avoided: new Set(['c:8b', 'b:4b']) }), { name: 'a:1b', step: 'down', bytes: 1e9, cause: 'measured' })
  assert.deepEqual(choose({ ...base, usual: 'c:8b', avoided: new Set(['a:1b', 'b:4b', 'c:8b']) }), { name: 'c:8b', step: 'stuck', bytes: 5e9, cause: 'measured' })
  // Measured on the GPU: every bigger one is avoided, writes no text, or has no known size, so nothing steps up.
  const grown = { ...base, usual: 'b:4b', seen: [S('b:4b', 3.3e9, 4e9)] }
  assert.deepEqual(choose({ ...grown, avoided: new Set(['c:8b']) }), { name: 'b:4b', step: 'usual', bytes: 3.3e9 })
  assert.equal(choose({ ...grown, avoided: NONE }).name, 'c:8b', 'without the mark the bigger one is chosen')
  // A model that writes no text is not a step down either.
  assert.deepEqual(choose({ listed: [W('emb:1b', 1e9, false), W('big:70b', 40e9)], usual: 'big:70b', figure: ASK(24), seen: [], avoided: NONE, grow: true }), { name: 'big:70b', step: 'stuck', bytes: 40e9, cause: 'misfit' })
})

test('choose: a newest measurement all on the processor, or grow off, never grows', () => {
  const listed = [W('a:1b', 1e9), W('b:2b', 2e9), W('c:8b', 5e9)]
  const base = { listed, usual: 'b:2b', figure: ASK(24), avoided: NONE }
  const onGpu = S('a:1b', 1e9, 1.2e9)
  const onCpu = S('b:2b', 2e9, 2.5e9, 0)
  assert.equal(choose({ ...base, seen: [onGpu, onCpu], grow: true }).step, 'usual', 'the newest ran on the processor')
  assert.equal(choose({ ...base, seen: [onCpu], grow: true }).step, 'usual')
  assert.equal(choose({ ...base, seen: [onCpu, onGpu], grow: true }).name, 'c:8b', 'the newest on the GPU: it grows')
  assert.equal(choose({ ...base, seen: [onCpu, onGpu], grow: false }).step, 'usual', 'grow off')
})

test('coldWaitMs: a second per 200 MB of weights; nothing for an unknown size', () => {
  assert.equal(COLD_READ_BYTES_S, 200e6)
  assert.equal(coldWaitMs(142e9), 710_000)
  assert.equal(coldWaitMs(200e6), 1000)
  assert.equal(coldWaitMs(20e6), 100)
  assert.equal(coldWaitMs(1), 1, 'rounded up')
  assert.equal(coldWaitMs(null), 0)
  assert.equal(coldWaitMs(0), 0)
  assert.equal(coldWaitMs(-5), 0)
})

test('remember: one entry per server and model, newest last, at most 16', () => {
  const a = S('a:1b', 1e9, 1.2e9)
  const b = S('b:2b', 2e9, 2.4e9)
  const elsewhere = S('a:1b', 1e9, 1.3e9, undefined, { server: 'http://127.0.0.1:11435' })
  let seen = remember([], a)
  seen = remember(seen, b)
  seen = remember(seen, elsewhere)
  assert.deepEqual(seen, [a, b, elsewhere], 'another server keeps its own')
  const again = S('a:1b', 1e9, 1.5e9, undefined, { pace: 12 })
  assert.deepEqual(remember(seen, again), [b, elsewhere, again], 'the same server and model: replaced, and newest last')
  assert.deepEqual(seen, [a, b, elsewhere], 'the list given is not changed')
  let many: Seen[] = []
  for (let k = 0; k < 20; k++) many = remember(many, S(`m${k}:1b`, 1e9, 1.1e9))
  assert.equal(SEEN_MAX, 16)
  assert.equal(many.length, 16)
  assert.deepEqual(many.map((s) => s.model), Array.from({ length: 16 }, (_, k) => `m${k + 4}:1b`))
})

test('readFit: keeps what is well formed; drops a server off this machine, bad bytes, a bad count, a bad figure; keeps the newest 16', () => {
  const good = { server: SERVER, model: 'qwen3-vl:4b', weights: 3_300_000_000, loaded: 5_000_000_000, gpu: 5_000_000_000, pace: 41.2, fails: 0 }
  assert.deepEqual(readFit({ vram: 24, seen: [good], usual: 'qwen3-vl:4b' }), { vram: 24, seen: [good], usual: 'qwen3-vl:4b' })
  assert.deepEqual(readFit({ vram: null, seen: [] }), { vram: null, seen: [] })
  assert.deepEqual(readFit({}), { vram: null, seen: [] })
  // The figure: null, or a number from 0 to 4096; anything else is none.
  for (const [vram, want] of [[0, 0], [4096, 4096], [318.5, 318.5], [5000, null], [-1, null], ['24', null], [Number.NaN, null], [Infinity, null], [true, null]] as const) {
    assert.equal(readFit({ vram, seen: [] })!.vram, want, String(vram))
  }
  // Each measurement is checked field by field; one that fails anything is dropped, the rest kept.
  const bad: unknown[] = [
    { ...good, server: 'http://example.com:11434' },
    { ...good, server: 'http://localhost:11434/' },
    { ...good, server: 42 },
    { ...good, model: '' },
    { ...good, model: 7 },
    { ...good, weights: 0 },
    { ...good, weights: 2 ** 51 },
    { ...good, weights: 1.5 },
    { ...good, loaded: -1 },
    { ...good, loaded: '5000000000' },
    { ...good, gpu: 5_000_000_001 },
    { ...good, gpu: -1 },
    { ...good, gpu: 1.5 },
    { ...good, pace: -1 },
    { ...good, pace: '40' },
    { ...good, pace: Infinity },
    { ...good, fails: 3 },
    { ...good, fails: 1.5 },
    { ...good, fails: undefined },
    42, null, 'seen',
  ]
  const kept = { ...good, model: 'qwen3:14b', pace: null, fails: 2, extra: 'dropped' }
  const read = readFit({ vram: 24, seen: [...bad, kept], usual: 7 })!
  assert.deepEqual(read, { vram: 24, seen: [{ server: SERVER, model: 'qwen3:14b', weights: 3_300_000_000, loaded: 5_000_000_000, gpu: 5_000_000_000, pace: null, fails: 2 }] })
  assert.equal('usual' in read, false, 'a usual that is not a name is absent')
  assert.equal('usual' in readFit({ vram: 24, seen: [], usual: '' })!, false)
  assert.equal(readFit({ vram: 24, seen: [{ ...good, server: 'http://127.0.0.1:11434' }] })!.seen.length, 1, 'any loopback origin, as the gate spells it')
  // The newest 16.
  const many = Array.from({ length: 20 }, (_, k) => ({ ...good, model: `m${k}:1b` }))
  assert.deepEqual(readFit({ vram: 24, seen: many })!.seen.map((s) => s.model), Array.from({ length: 16 }, (_, k) => `m${k + 4}:1b`))
  // Not a list of measurements, or not a record at all.
  assert.deepEqual(readFit({ vram: 24, seen: 'lots' }), { vram: 24, seen: [] })
  for (const raw of [null, undefined, 42, 'fit', true, [good]]) assert.equal(readFit(raw), undefined, String(raw))
})

test('fitLine: every sentence, exactly', () => {
  const BASE: FitInput = {
    figure: ADDRESS(23.9), off: false, found: 'ollama', chat: false, theirs: null, choice: null,
    usual: { name: 'qwen3-vl:4b', bytes: 3.3e9 }, last: null, verdict: null, anyAside: false, grow: true, coldMs: 0,
  }
  const line = (over: Partial<FitInput>): string | undefined => fitLine({ ...BASE, ...over })
  const small = S('qwen3-vl:4b', 3.3e9, 5e9, 5e9, { pace: 41.2 })
  const listed = [W('qwen3-vl:4b', 3.3e9), W('qwen3:14b', 9.3e9), W('qwen3:32b', 20e9)]
  const up = choose({ listed, usual: 'qwen3-vl:4b', figure: ADDRESS(23.9), seen: [small], avoided: NONE, grow: true })
  const big = [W('deepseek-r1:671b', 404e9), W('qwen3:235b', 142e9), W('qwen3:8b', 5.2e9)]
  const misfit = choose({ listed: big, usual: 'deepseek-r1:671b', figure: ADDRESS(318.5), seen: [], avoided: NONE, grow: true })
  const smallBig = S('qwen3:8b', 5.2e9, 6e9, 6e9, { pace: 60 })
  const upBig = choose({ listed: big.slice(1).concat([W('qwen3:32b', 20e9)]).sort((a, b) => (a.name < b.name ? -1 : 1)), usual: 'qwen3:8b', figure: ADDRESS(318.5), seen: [smallBig], avoided: NONE, grow: true })
  assert.equal(upBig.name, 'qwen3:235b')
  const ADDR = "23.9 GB given by the page's address (vram=)"
  const table: [string, Partial<FitInput>, string | undefined][] = [
    ['off', { off: true, figure: null },
      "off at the console (ask vram 0): auto keeps its usual model (ask vram auto hands sizing back to the page's address or the Windows app)"],
    ['off, whatever the address', { off: true },
      "off at the console (ask vram 0): auto keeps its usual model (ask vram auto hands sizing back to the page's address or the Windows app)"],
    ['no figure', { figure: null }, undefined],
    ['another provider', { figure: ADDRESS(8), found: 'inpage' },
      "8.0 GB given by the page's address (vram=); auto sizes only a model Ollama lists (inpage answers now)"],
    ['chat', { figure: ASK(24), chat: true },
      "24.0 GB given at the console (ask vram); auto sizes Ollama's model only in the generate format (ask api generate)"],
    ['the Windows app', { figure: { gb: 7.9, from: 'app' }, found: null, choice: null },
      "7.9 GB read from the GPUs by the Windows app; auto sizes Ollama's model once a look finds Ollama on this machine"],
    ['the Windows app, stepped down', { figure: { gb: 100, from: 'app' }, usual: { name: 'deepseek-r1:671b', bytes: 404e9 }, choice: { name: 'qwen3:8b', step: 'down', bytes: 5.2e9, cause: 'misfit' } },
      "100.0 GB read from the GPUs by the Windows app; deepseek-r1:671b has 376.3 GB of weights alone, more than the GPU's 100.0 GB; auto answers with qwen3:8b, the largest smaller one Ollama lists (ask model <name> keeps another); ask vram auto measures afresh"],
    ['theirs', { theirs: 'llama3:70b', last: small },
      `${ADDR}; the model is yours (ask model chose it): auto sizes only a model it chose (ask model auto hands it back)`],
    ['theirs, measured', { theirs: 'llama3:70b', last: S('llama3:70b', 40e9, 42e9, 21e9, { pace: 3.2 }) },
      `${ADDR}; the model is yours (ask model chose it): auto sizes only a model it chose (ask model auto hands it back); llama3:70b measured 39.1 GB loaded, 50% on the GPU, the rest on the processor, 3.2 tokens a second`],
    ['misfit', { figure: ADDRESS(318.5), usual: { name: 'deepseek-r1:671b', bytes: 404e9 }, choice: misfit },
      "318.5 GB given by the page's address (vram=); deepseek-r1:671b has 376.3 GB of weights alone, more than the GPU's 318.5 GB; auto answers with qwen3:235b, the largest smaller one Ollama lists (ask model <name> keeps another); ask vram auto measures afresh"],
    ['no choice yet', {}, `${ADDR}; the next answer is measured before auto picks bigger`],
    ['usual, unmeasured', { choice: { name: 'qwen3-vl:4b', step: 'usual', bytes: 3.3e9 } }, `${ADDR}; the next answer is measured before auto picks bigger`],
    ['usual, measured', { choice: { name: 'qwen3-vl:4b', step: 'usual', bytes: 3.3e9 }, last: small },
      `${ADDR}; qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.2 tokens a second; nothing bigger that Ollama lists fits by what was measured, so auto keeps qwen3-vl:4b`],
    ['usual, on the processor, no pace', { choice: { name: 'qwen3-vl:4b', step: 'usual', bytes: 3.3e9 }, last: S('qwen3-vl:4b', 3.3e9, 5e9, 0, { pace: null }) },
      `${ADDR}; qwen3-vl:4b measured 4.7 GB loaded, all on the processor; nothing bigger that Ollama lists fits by what was measured, so auto keeps qwen3-vl:4b`],
    ['usual, no grow', { choice: { name: 'qwen3-vl:4b', step: 'usual', bytes: 3.3e9 }, last: S('qwen3:14b', 9.3e9, 14e9, 14e9, { pace: 3.1, fails: 1 }), verdict: 'slow', anyAside: true, grow: false },
      `${ADDR}; qwen3:14b measured 13.0 GB loaded, all on the GPU, 3.1 tokens a second: too slow here; auto keeps qwen3-vl:4b for the rest of this visit; ask vram auto measures afresh`],
    ['up', { choice: up, last: small },
      `${ADDR}; qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.2 tokens a second; auto answers with qwen3:14b, the largest that fits by what was measured (8.7 GB of weights, about 13.1 GB loaded by that measure; ask model <name> keeps another)`],
    ['up, with the cold wait', { figure: ADDRESS(318.5), usual: { name: 'qwen3:8b', bytes: 5.2e9 }, choice: upBig, last: smallBig, coldMs: coldWaitMs(142e9) },
      "318.5 GB given by the page's address (vram=); qwen3:8b measured 5.6 GB loaded, all on the GPU, 60.0 tokens a second; auto answers with qwen3:235b, the largest that fits by what was measured (132.2 GB of weights, about 152.6 GB loaded by that measure; its first answer may wait up to 12 minutes while Ollama reads it; ask model <name> keeps another)"],
    ['up, a minute at most', { choice: up, last: small, coldMs: 45_000 },
      `${ADDR}; qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.2 tokens a second; auto answers with qwen3:14b, the largest that fits by what was measured (8.7 GB of weights, about 13.1 GB loaded by that measure; its first answer may wait up to 1 minute while Ollama reads it; ask model <name> keeps another)`],
    ['up, just over a minute', { choice: up, last: small, coldMs: 60_001 },
      `${ADDR}; qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.2 tokens a second; auto answers with qwen3:14b, the largest that fits by what was measured (8.7 GB of weights, about 13.1 GB loaded by that measure; its first answer may wait up to 2 minutes while Ollama reads it; ask model <name> keeps another)`],
    ['down, measured, the console tail', {
      figure: ASK(16), usual: { name: 'qwen3:14b', bytes: 9.3e9 }, choice: { name: 'qwen3:8b', step: 'down', bytes: 5.2e9, cause: 'measured' },
      last: S('qwen3:14b', 9.3e9, 12e9, 9e9, { pace: 2, fails: 1 }), verdict: 'big', anyAside: true, grow: false,
    }, "16.0 GB given at the console (ask vram); qwen3:14b measured 11.2 GB loaded, 75% on the GPU, the rest on the processor, 2.0 tokens a second: too big for this GPU; auto answers with qwen3:8b, the largest smaller one Ollama lists (ask model <name> keeps another); ask vram 16 measures afresh"],
    ['stuck', { figure: ADDRESS(100), usual: { name: 'deepseek-r1:671b', bytes: 404e9 }, choice: { name: 'deepseek-r1:671b', step: 'stuck', bytes: 404e9, cause: 'misfit' } },
      "100.0 GB given by the page's address (vram=); deepseek-r1:671b has 376.3 GB of weights alone, more than the GPU's 100.0 GB; Ollama lists nothing smaller that fits, so auto keeps deepseek-r1:671b; ask vram auto measures afresh"],
    ['set aside, the console tail as typed', { figure: ASK(24.5), choice: { name: 'qwen3-vl:4b', step: 'usual', bytes: 3.3e9 }, last: small, anyAside: true },
      "24.5 GB given at the console (ask vram); qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.2 tokens a second; nothing bigger that Ollama lists fits by what was measured, so auto keeps qwen3-vl:4b; ask vram 24.5 measures afresh"],
    ['nothing found yet', { found: null }, `${ADDR}; auto sizes Ollama's model once a look finds Ollama on this machine`],
    ['nothing found yet, a choice kept', { found: null, choice: { name: 'qwen3-vl:4b', step: 'usual', bytes: 3.3e9 } }, `${ADDR}; the next answer is measured before auto picks bigger`],
  ]
  for (const [name, over, want] of table) {
    const got = line(over)
    assert.equal(got, want, name)
    if (got === undefined) continue
    assert.match(got, ASCII, name)
    assert.doesNotMatch(got, WORDS, name)
  }
  // The sizes it shows are the page's: GB of 2^30 bytes, one decimal (Ollama's own 142GB shows as 132.2).
  assert.equal(gbText(142e9), '132.2 GB')
  assert.equal(gbText(GIB), '1.0 GB')
  // The word check itself catches what it is for.
  assert.match(`${[...'tih'].reverse().join('')} it`, WORDS)
  assert.doesNotMatch('within, thistle', WORDS, 'whole words only')
})

test('answerTokensFor: a quarter of the context, never below 2,048; 8,192 still gives exactly 2,048', () => {
  assert.equal(CONTEXT_TOKENS, 8192, 'unchanged: the in-page rows import it')
  assert.equal(ANSWER_TOKENS, 2048, 'unchanged: the in-page rows import it')
  assert.equal(CONTEXT_MAX, 32768)
  assert.equal(answerTokensFor(CONTEXT_TOKENS), ANSWER_TOKENS)
  for (const [ctx, want] of [[8192, 2048], [8193, 2048], [8195, 2048], [12288, 3072], [12290, 3072], [16384, 4096], [32768, 8192], [4096, 2048], [0, 2048]] as const) {
    assert.equal(answerTokensFor(ctx), want, String(ctx))
  }
})

test('widen: a cut answer, counted and quick enough, on a model measured all on the GPU at the context Ollama said, with room, grows once to twice its context; each boundary one step either side', () => {
  // 10 GB loaded at 8,192 for 8 GB of weights: doubling costs 2 GB; the figure of 24 leaves 22 GiB.
  const placed: Placement = { loaded: 10e9, gpu: 10e9, ctx: 8192 }
  const base: Parameters<typeof widen>[0] = { reason: 'length', tokens: 2048, pace: 41.2, ctx: 8192, placed, weights: 8e9, figure: ASK(24), grown: false }
  const at = (over: Partial<typeof base>): number | null => widen({ ...base, ...over })
  assert.equal(at({}), 16384)
  assert.equal(ANSWER_WAIT_S, FIRST_PIECE_MS / 1000)
  assert.equal(ANSWER_WAIT_S, 300)
  assert.equal(WIDEN_FLOOR_BYTES, GIB)
  // Room: loaded plus what doubling costs (loaded less weights) at the budget grows; a byte over does not.
  const B = budgetOf(ASK(24))
  assert.equal(at({ placed: { loaded: 12 * GIB, gpu: 12 * GIB, ctx: 8192 }, weights: 2 * GIB }), 16384, '12 + 10 = 22 GiB: exactly at it')
  assert.equal(at({ placed: { loaded: 12 * GIB, gpu: 12 * GIB, ctx: 8192 }, weights: 2 * GIB - 1 }), null, 'one byte over')
  assert.equal(12 * GIB + (12 * GIB - 2 * GIB), B)
  // What doubling costs is never taken below 1 GiB: loaded at or under its weights.
  assert.equal(at({ placed: { loaded: 21 * GIB, gpu: 21 * GIB, ctx: 8192 }, weights: 21 * GIB }), 16384, '21 + 1 = 22 GiB')
  assert.equal(at({ placed: { loaded: 21 * GIB + 1, gpu: 21 * GIB + 1, ctx: 8192 }, weights: 21 * GIB }), null, '1 byte beyond the weights still costs 1 GiB')
  assert.equal(at({ placed: { loaded: 21 * GIB, gpu: 21 * GIB, ctx: 8192 }, weights: 25 * GIB }), 16384, 'loaded under its weights: the floor')
  assert.equal(at({ placed: { loaded: 21 * GIB + 1, gpu: 21 * GIB + 1, ctx: 8192 }, weights: 25 * GIB }), null)
  // All on the GPU: gpu equal to loaded grows; a byte short (split) does not, nor all on the processor.
  assert.equal(at({ placed: { loaded: 10e9, gpu: 10e9, ctx: 8192 } }), 16384)
  assert.equal(at({ placed: { loaded: 10e9, gpu: 10e9 - 1, ctx: 8192 } }), null)
  assert.equal(at({ placed: { loaded: 10e9, gpu: 0, ctx: 8192 } }), null)
  // The pace writes the larger answer cap (4,096) in at most 300 s: exactly that grows, a hair under does not.
  const edge = answerTokensFor(16384) / ANSWER_WAIT_S
  assert.equal(edge * ANSWER_WAIT_S, 4096)
  assert.equal(at({ pace: edge }), 16384)
  assert.equal(at({ pace: edge - 1e-9 }), null)
  assert.equal(at({ pace: null }), null, 'no pace said')
  // Counted over at least 32 tokens.
  assert.equal(at({ tokens: PACE_TOKENS }), 16384)
  assert.equal(at({ tokens: PACE_TOKENS - 1 }), null)
  // Cut at its answer cap, and nothing else.
  for (const reason of ['stop', 'scripted', '', 'refusal', 'LENGTH']) assert.equal(at({ reason }), null, reason)
  // Ollama said it ran at the context sent (v0.10.0 and later, trained on at least that).
  const { ctx: _, ...silent } = placed
  for (const p of [silent, { ...placed, ctx: 0 }, { ...placed, ctx: 4096 }, { ...placed, ctx: 16384 }]) assert.equal(at({ placed: p }), null, JSON.stringify(p))
  assert.equal(at({ placed: null }), null, 'nothing measured at that context this visit')
  assert.equal(at({ weights: null }), null, 'weights not listed')
  // Once a visit, whatever came of it.
  assert.equal(at({ grown: true }), null)
  // Never above 32,768.
  assert.equal(at({ ctx: 16384, placed: { ...placed, ctx: 16384 } }), CONTEXT_MAX)
  assert.equal(at({ ctx: 32768, placed: { ...placed, ctx: 32768 }, pace: 1000 }), null, 'fast enough and with room, but past 32,768')
  // 8,192 for 32,768 at the same 300 s: 27.31 a second.
  assert.equal(at({ ctx: 16384, placed: { ...placed, ctx: 16384 }, pace: 8192 / 300 }), 32768)
  assert.equal(at({ ctx: 16384, placed: { ...placed, ctx: 16384 }, pace: 27.3 }), null)
  // A smaller figure leaves less room.
  assert.equal(at({ figure: ADDRESS(13.2) }), 16384, '12e9 fits 11.2 GiB')
  assert.equal(at({ figure: ADDRESS(13.1) }), null, '12e9 does not fit 11.1 GiB')
})

test('contextVerdict: every branch of the first measured answer at a larger context', () => {
  const gpu: Placement = { loaded: 6e9, gpu: 6e9, ctx: 16384 }
  const v = (placed: Placement | null, o: { slow?: boolean; cold?: boolean } = {}) => contextVerdict({ placed, from: 8192, ctx: 16384, slow: o.slow ?? false, cold: o.cold ?? false })
  assert.deepEqual(v(gpu), { kind: 'good' })
  assert.deepEqual(v({ ...gpu, ctx: undefined }), { kind: 'good' }, 'no context_length: the placement decides')
  assert.deepEqual(v(gpu, { slow: true }), { kind: 'back', why: 'slow' })
  assert.deepEqual(v({ ...gpu, gpu: 6e9 - 1 }), { kind: 'back', why: 'split' })
  assert.deepEqual(v({ ...gpu, gpu: 0 }), { kind: 'back', why: 'cpu' })
  // Ollama ran it at its trained context, below the context sent: that, when above the one it grew from, else that one.
  assert.deepEqual(v({ ...gpu, ctx: 12288 }), { kind: 'trained', trained: 12288, ctx: 12288 })
  assert.deepEqual(v({ ...gpu, ctx: 16383 }), { kind: 'trained', trained: 16383, ctx: 16383 })
  assert.deepEqual(v({ ...gpu, ctx: 8193 }), { kind: 'trained', trained: 8193, ctx: 8193 })
  assert.deepEqual(v({ ...gpu, ctx: 8192 }), { kind: 'trained', trained: 8192, ctx: 8192 })
  assert.deepEqual(v({ ...gpu, ctx: 4096 }), { kind: 'trained', trained: 4096, ctx: 8192 })
  // Run at its trained context but split, on the processor or slow there: back, since that is the context it would run at.
  assert.deepEqual(v({ ...gpu, ctx: 12288, gpu: 0 }, { slow: true }), { kind: 'back', why: 'cpu' })
  assert.deepEqual(v({ ...gpu, ctx: 12288, gpu: 3e9 }), { kind: 'back', why: 'split' })
  assert.deepEqual(v({ ...gpu, ctx: 12288 }, { slow: true }), { kind: 'back', why: 'slow' })
  // A first wait that ran out: split or on the processor goes back (Ollama plans the place before it loads); whole on
  // the GPU may still be loading.
  assert.deepEqual(v({ ...gpu, gpu: 3e9 }, { cold: true }), { kind: 'back', why: 'split' })
  assert.deepEqual(v({ ...gpu, gpu: 0 }, { cold: true }), { kind: 'back', why: 'cpu' })
  assert.equal(v(gpu, { cold: true }), null)
  assert.equal(v({ ...gpu, ctx: 12288 }, { cold: true }), null, 'trained or not, nothing is learned while it may be loading')
  assert.equal(v({ ...gpu, ctx: 8192 }, { cold: true }), null, 'a runner still at the old context while the new one loads says nothing')
  // Not loaded: no verdict.
  assert.equal(v(null), null)
  assert.equal(v(null, { cold: true }), null)
})

test('fitLine: the context clause, once something grew or was learned; with none the row is byte-identical', () => {
  const BASE: FitInput = {
    figure: ADDRESS(24), off: false, found: 'ollama', chat: false, theirs: null, choice: { name: 'qwen3:14b', step: 'usual', bytes: 9.3e9 },
    usual: { name: 'qwen3:14b', bytes: 9.3e9 }, last: S('qwen3:14b', 9.3e9, 14e9, 14e9, { pace: 41 }), verdict: null, anyAside: false, grow: true, coldMs: 0,
  }
  const ROW = "24.0 GB given by the page's address (vram=); qwen3:14b measured 13.0 GB loaded, all on the GPU, 41.0 tokens a second; nothing bigger that Ollama lists fits by what was measured, so auto keeps qwen3:14b"
  assert.equal(fitLine(BASE), ROW)
  assert.equal(fitLine({ ...BASE, context: null }), ROW, 'nothing grew: byte-identical')
  const W14 = (w: Wide) => ({ ...w, model: 'qwen3:14b' })
  const table: [string, Wide, string][] = [
    ['grown, not yet measured', { state: 'grown', from: 8192, ctx: 16384, tried: 16384 },
      'an answer was cut at 2,048 tokens, so qwen3:14b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured'],
    ['measured good', { state: 'good', from: 8192, ctx: 16384, tried: 16384, loaded: 15.8e9 },
      'qwen3:14b runs at 16,384 tokens of context with answers of up to 4,096 (measured 14.7 GB loaded at that context, all on the GPU)'],
    ['trained context learned', { state: 'grown', from: 8192, ctx: 12288, tried: 12288, trained: 12288 },
      'qwen3:14b was trained on 12,288 tokens of context, so it runs at that with answers of up to 3,072'],
    ['trained context, measured good', { state: 'good', from: 8192, ctx: 12288, tried: 12288, trained: 12288, loaded: 14.9e9 },
      'qwen3:14b was trained on 12,288 tokens of context, so it runs at that with answers of up to 3,072 (measured 13.9 GB loaded at that context, all on the GPU)'],
    ['trained on what it grew from', { state: 'back', from: 8192, ctx: 8192, tried: 16384, why: 'trained', trained: 8192 },
      'qwen3:14b was trained on 8,192 tokens of context, so it stays at 8,192 for this visit'],
    ['trained below what it grew from', { state: 'back', from: 8192, ctx: 8192, tried: 16384, why: 'trained', trained: 4096 },
      'qwen3:14b was trained on 4,096 tokens of context, so it stays at 8,192 for this visit'],
    ['back: split', { state: 'back', from: 8192, ctx: 8192, tried: 16384, why: 'split' },
      '16,384 tokens of context did not fit the GPU (some of it ran on the processor), so qwen3:14b stays at 8,192 for this visit'],
    ['back: on the processor', { state: 'back', from: 8192, ctx: 8192, tried: 16384, why: 'cpu' },
      '16,384 tokens of context did not fit the GPU (all of it ran on the processor), so qwen3:14b stays at 8,192 for this visit'],
    ['back: slow', { state: 'back', from: 8192, ctx: 8192, tried: 16384, why: 'slow' },
      '16,384 tokens of context was too slow here, so qwen3:14b stays at 8,192 for this visit'],
    ['back: refused', { state: 'back', from: 8192, ctx: 8192, tried: 16384, why: 'load' },
      '16,384 tokens of context would not load in Ollama, so qwen3:14b stays at 8,192 for this visit'],
    ['back: failed partway through an answer', { state: 'back', from: 8192, ctx: 8192, tried: 16384, why: 'partway' },
      '16,384 tokens of context failed partway through an answer in Ollama, so qwen3:14b stays at 8,192 for this visit'],
    ['back from the trained context', { state: 'back', from: 8192, ctx: 8192, tried: 12288, why: 'split', trained: 12288 },
      '12,288 tokens of context did not fit the GPU (some of it ran on the processor), so qwen3:14b stays at 8,192 for this visit'],
  ]
  for (const [name, w, clause] of table) {
    const got = fitLine({ ...BASE, context: W14(w) })
    assert.equal(got, `${ROW}; ${clause}`, name)
    assert.match(got ?? '', ASCII, name)
    assert.doesNotMatch(got ?? '', WORDS, name)
  }
  // After the model clause and before the way back.
  const tail = fitLine({ ...BASE, anyAside: true, context: W14({ state: 'grown', from: 8192, ctx: 16384, tried: 16384 }) })
  assert.match(tail ?? '', /so auto keeps qwen3:14b; an answer was cut at 2,048 tokens, .*, which is measured; ask vram auto measures afresh$/)
  // Rows that return before the model clause never carry it: the operator's model, the chat format, another provider.
  const grown = W14({ state: 'good', from: 8192, ctx: 16384, tried: 16384, loaded: 15.8e9 })
  for (const over of [{ theirs: 'qwen3:14b' }, { chat: true }, { found: 'inpage' }, { figure: null }] as Partial<FitInput>[]) {
    assert.doesNotMatch(fitLine({ ...BASE, ...over, context: grown }) ?? '', /tokens of context/, JSON.stringify(over))
  }
  // Token counts in comma groups, whatever the locale.
  for (const [n, want] of [[0, '0'], [123, '123'], [2048, '2,048'], [16384, '16,384'], [1234567, '1,234,567']] as const) assert.equal(grouped(n), want)
})
