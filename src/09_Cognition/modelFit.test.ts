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
 * free of the words the console never carries.
 * What breaks if it is removed? Auto could give a big GPU's Ollama a model that cannot fit, grow on a guess, keep a
 * corrupt record, or say something on the fit row that is not what it did, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_MODEL, type Weighed } from './localCompute.ts'
import {
  budgetOf, choose, COLD_READ_BYTES_S, coldWaitMs, FAILS_KEPT, failed, figureOf, fitLine, gbText, GIB, PACE_FLOOR, PACE_TOKENS, parseVram, readFit, readGb, remember,
  RESERVE_BYTES, SEEN_MAX, todaysPick, VRAM_MAX_GB, VRAM_USAGE, whereOf, type Figure, type FitInput, type Seen, type Where,
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
  // The budget a bigger model's need must fit: the figure less the reserve.
  assert.equal(RESERVE_BYTES, 2 * GIB)
  assert.equal(GIB, 2 ** 30)
  assert.equal(budgetOf(ASK(24)), 22 * GIB)
  assert.equal(budgetOf(ADDRESS(23.9)), 23.9 * GIB - 2 * GIB)
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
      "off at the console (ask vram 0): auto keeps its usual model (ask vram auto hands sizing back to the page's address)"],
    ['off, whatever the address', { off: true },
      "off at the console (ask vram 0): auto keeps its usual model (ask vram auto hands sizing back to the page's address)"],
    ['no figure', { figure: null }, undefined],
    ['another provider', { figure: ADDRESS(8), found: 'inpage' },
      "8.0 GB given by the page's address (vram=); auto sizes only a model Ollama lists (inpage answers now)"],
    ['chat', { figure: ASK(24), chat: true },
      "24.0 GB given at the console (ask vram); auto sizes Ollama's model only in the generate format (ask api generate)"],
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
    ['nothing found yet', { found: null }, `${ADDR}; the next answer is measured before auto picks bigger`],
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
