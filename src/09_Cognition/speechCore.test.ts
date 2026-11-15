// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the speech recogniser's reading loop (speechCore.ts) against a scripted model: the
 * decoder is fed the start mark and an empty memory, then each token it chose with the memory it handed back (its
 * own grows, the audio's is taken once); the loop stops at the end mark and at the length a sentence of that duration
 * cannot pass (where a repeating tail is cut to one copy, and only there: a person's "no, no, no" and a number's
 * digits are kept); an utterance is cut to its voiced part before it is read; tokens become text by the model's vocabulary (the committed file, whose hash is the
 * pack's pin), byte tokens together as UTF-8; and an utterance too short, too quiet, unsure or wordless gives no text
 * and says why.
 * What breaks if it is removed? A change to the loop could feed the decoder the wrong memory (it then writes
 * nonsense, with no error), never stop on a noise, or pass a guess on as the visitor's words, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import {
  SPEECH_LIMITS, SPEECH_SHAPE, holdChecked, likeliest, loopCut, parseVocabulary, peak, readTokens, readUtterance, repeatCut, saysSomething, tokensText, voicedSpan,
  type SessionLike, type SpeechRuntime, type TensorOut,
} from './speechCore.ts'
import { speechFile } from './speechPack.ts'

const VOCAB_SIZE = 12

/** A tensor as the fake runtime makes it. */
interface Fed { kind: 'float' | 'token' | 'flag'; data: unknown; dims: readonly number[] }

/** One row of scores where `id` wins with probability about `p`. */
function row(id: number, p = 0.9): Float32Array {
  const out = new Float32Array(VOCAB_SIZE)
  // The winner at `top`, the rest equal: p = 1 / (1 + (n - 1) * e^(-top)).
  const top = Math.log(((VOCAB_SIZE - 1) * p) / (1 - p))
  out[id] = top
  return out
}

/** A runtime whose decoder writes `script` (token ids; the end mark when it runs out), recording what it was fed. */
function fake(script: readonly number[], p: number | ((step: number) => number) = 0.9) {
  const fed: Record<string, Fed>[] = []
  const encoded: Fed[] = []
  let step = 0
  const present = (name: string, n: number): TensorOut => ({ data: new Float32Array([n]), dims: [1, name.includes('.decoder.') ? n : 0] })
  const names = ['logits']
  for (let l = 0; l < SPEECH_SHAPE.layers; l++) for (const half of ['decoder', 'encoder']) for (const kind of ['key', 'value']) names.push(`present.${l}.${half}.${kind}`)
  const encoder: SessionLike = {
    outputNames: ['last_hidden_state'],
    run: async (feeds) => { encoded.push(feeds.input_values as Fed); return { last_hidden_state: { data: new Float32Array([7]), dims: [1, 1, 1] } } },
  }
  const decoder: SessionLike = {
    outputNames: names,
    run: async (feeds) => {
      fed.push(feeds as Record<string, Fed>)
      const id = step < script.length ? script[step] : SPEECH_SHAPE.end
      const out: Record<string, TensorOut> = { logits: { data: row(id, typeof p === 'function' ? p(step) : p), dims: [1, 1, VOCAB_SIZE] } }
      for (const n of names) if (n !== 'logits') out[n] = present(n, step + 1)
      step++
      return out
    },
  }
  const rt: SpeechRuntime = {
    encoder, decoder,
    float: (data, dims) => ({ kind: 'float', data, dims }) satisfies Fed,
    token: (id) => ({ kind: 'token', data: id, dims: [1, 1] }) satisfies Fed,
    flag: (on) => ({ kind: 'flag', data: on, dims: [1] }) satisfies Fed,
  }
  return { rt, fed, encoded, steps: () => step }
}

const seconds = (s: number, level = 0.1): Float32Array => new Float32Array(Math.round(s * SPEECH_SHAPE.rate)).fill(level)

test('likeliest: the top score and the probability the model gave it; a row of nothing is no choice', () => {
  const r = likeliest(row(5, 0.8))
  assert.equal(r.id, 5)
  assert.ok(Math.abs(r.p - 0.8) < 1e-6, String(r.p))
  // A window of a longer buffer (the last position's row), ids counted from the window's start.
  const two = new Float32Array([...row(1), ...row(4, 0.5)])
  const last = likeliest(two, VOCAB_SIZE, 2 * VOCAB_SIZE)
  assert.equal(last.id, 4)
  assert.ok(Math.abs(last.p - 0.5) < 1e-6)
  assert.ok(likeliest(new Float32Array([1000, -1000, 999])).p > 0.7, 'large scores do not overflow')
  assert.deepEqual(likeliest(new Float32Array(3).fill(Number.NaN)), { id: 0, p: 0 })
  assert.equal(likeliest(new Float32Array([0, Number.NaN, 3])).id, 2, 'a NaN is passed over')
})

test('repeatCut: a tail that is the same run three times over is cut to one copy; anything else is left', () => {
  assert.equal(repeatCut([1, 2, 3]), -1)
  assert.equal(repeatCut([5, 5]), -1, 'twice is a stutter, not a loop')
  assert.equal(repeatCut([9, 5, 5, 5]), 2, 'one token three times: the first copy stays')
  assert.equal(repeatCut([9, 1, 2, 1, 2, 1, 2]), 3, 'a pair three times')
  assert.equal(repeatCut([1, 2, 3, 1, 2, 3, 1, 2, 3]), 3, 'a clause three times')
  assert.equal(repeatCut([1, 2, 1, 2, 1, 3]), -1)
  assert.equal(repeatCut([4, 4, 4, 4], 4), 1)
  assert.equal(repeatCut([]), -1)
})

test('loopCut: a tail looping until the limit comes back to one copy, even with its last copy cut short; anything else is left', () => {
  assert.equal(loopCut([4, 9, 9, 9, 9, 9, 9, 9]), 2)
  assert.equal(loopCut([7, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 2]), 4, 'the last copy cut short by the limit')
  assert.equal(loopCut([7, 1, 2, 1, 2, 1, 2, 1, 2, 1]), 3)
  assert.equal(loopCut([4, 9, 9, 9, 9], 3, 0), 2, 'four copies are three too many')
  assert.equal(loopCut([4, 9, 9, 6], 3, 0), -1, 'two copies are a stutter')
  assert.equal(loopCut([1, 2, 3, 4, 5, 6]), -1)
  assert.equal(loopCut([5, 5]), -1)
  assert.equal(loopCut([]), -1)
})

test('the loop: the start mark and an empty memory first, then each chosen token with the memory handed back (its own every step, the audio\'s once), until the end mark', async () => {
  const f = fake([4, 5, 6])
  const samples = seconds(2)
  const r = await readTokens(f.rt, samples)
  assert.deepEqual(r.tokens, [4, 5, 6])
  assert.equal(r.cut, false)
  assert.ok(Math.abs(r.sure - 0.9) < 1e-6, 'the geometric mean of the chosen tokens\' probabilities')
  assert.equal(f.encoded.length, 1, 'the audio is read once')
  assert.deepEqual([f.encoded[0].kind, f.encoded[0].data, f.encoded[0].dims], ['float', samples, [1, samples.length]])
  assert.equal(f.fed.length, 4, 'three tokens and the step that said the end')
  const first = f.fed[0]
  assert.deepEqual([first.input_ids.data, first.use_cache_branch.data], [SPEECH_SHAPE.start, false])
  assert.equal(Object.keys(first).filter((k) => k.startsWith('past_key_values.')).length, SPEECH_SHAPE.layers * 4)
  for (const [k, v] of Object.entries(first)) {
    if (!k.startsWith('past_key_values.')) continue
    assert.deepEqual([(v.data as Float32Array).length, v.dims], [0, [0, SPEECH_SHAPE.heads, 1, SPEECH_SHAPE.width]], `${k}: nothing, in the shape the model expects`)
  }
  assert.deepEqual(first.encoder_hidden_states, { data: new Float32Array([7]), dims: [1, 1, 1] }, 'what the encoder made of the audio')
  const second = f.fed[1], third = f.fed[2]
  assert.deepEqual([second.input_ids.data, second.use_cache_branch.data], [4, true])
  assert.deepEqual([third.input_ids.data, third.use_cache_branch.data], [5, true])
  // Its own memory is each step's newest; the audio's is the first step's, kept.
  assert.deepEqual((second['past_key_values.0.decoder.key'] as unknown as TensorOut).data, new Float32Array([1]))
  assert.deepEqual((third['past_key_values.0.decoder.key'] as unknown as TensorOut).data, new Float32Array([2]))
  assert.deepEqual((third['past_key_values.5.decoder.value'] as unknown as TensorOut).data, new Float32Array([2]))
  assert.deepEqual((second['past_key_values.3.encoder.value'] as unknown as TensorOut).data, new Float32Array([1]))
  assert.deepEqual((third['past_key_values.3.encoder.value'] as unknown as TensorOut).data, new Float32Array([1]), 'taken once')
})

test('the loop stops at the length a sentence of that duration cannot pass, a repeating tail there is cut to one copy, a repeat before it is kept; an end mark at once is nothing said', async () => {
  // Two seconds: 13 tokens at most. A decoder that never ends is cut there.
  const endless = fake(Array.from({ length: 100 }, (_, i) => 3 + (i % 7)))
  const long = await readTokens(endless.rt, seconds(2))
  assert.equal(long.tokens.length, Math.trunc(2 * SPEECH_LIMITS.tokensPerSecond))
  assert.equal(long.cut, true)
  assert.equal(endless.steps(), long.tokens.length, 'no step is run past the limit')
  // A very short utterance still gets the floor.
  const short = await readTokens(fake(Array.from({ length: 100 }, (_, i) => 3 + (i % 7))).rt, seconds(0.4))
  assert.equal(short.tokens.length, SPEECH_LIMITS.floor)
  // A decoder that lost the audio writes the same token until the limit: one copy is kept, and the certainty is that
  // of what was kept.
  const loop = fake([4, ...Array.from({ length: 100 }, () => 9)], (s) => (s === 0 ? 0.9 : 0.5))
  const r = await readTokens(loop.rt, seconds(2))
  assert.deepEqual(r.tokens, [4, 9])
  assert.equal(r.cut, true)
  assert.equal(loop.steps(), Math.trunc(2 * SPEECH_LIMITS.tokensPerSecond), 'read to the limit, no further')
  assert.ok(Math.abs(r.sure - Math.sqrt(0.9 * 0.5)) < 1e-6, `the kept tokens' certainty, not the cut ones': ${r.sure}`)
  // A repeat the person said ("no, no, no", "five five five", a number's zeros) ends where the decoder ends it.
  const said = fake([4, 9, 9, 9, 9, 6])
  const kept = await readTokens(said.rt, seconds(5))
  assert.deepEqual([kept.tokens, kept.cut], [[4, 9, 9, 9, 9, 6], false])
  const nothing = await readTokens(fake([]).rt, seconds(1))
  assert.deepEqual([nothing.tokens, nothing.sure, nothing.cut], [[], 0, false])
})

test('tokens as text: pieces in order, the word mark a space, byte tokens together as UTF-8, specials and ids past the vocabulary nothing', () => {
  const vocab = ['<unk>', '<s>', '</s>', '<0xC3>', '<0xA9>', '▁Take', '▁me', '▁to', '▁the', '▁tail', 'or', '.', '▁caf', '<0xE2>', '<0x82>', '<0xAC>']
  assert.equal(tokensText([5, 6, 7, 8, 9, 10, 11], vocab), 'Take me to the tailor.')
  assert.equal(tokensText([1, 5, 2, 0, 6, 999, -1], vocab), 'Take me', 'the start, end and unknown marks, and ids outside the vocabulary, say nothing')
  assert.equal(tokensText([12, 3, 4], vocab), 'café', 'two byte tokens are one letter')
  assert.equal(tokensText([13, 14, 15, 5], vocab), '€ Take', 'three bytes, then a piece')
  assert.equal(tokensText([3, 5], vocab), '� Take', 'half a letter is the replacement mark, not a throw')
  assert.equal(tokensText([], vocab), '')
  assert.equal(tokensText([5, 5], ['a', 'b', 'c', 'd', 'e', '▁▁x▁']), 'x x', 'spaces are single and the ends trimmed')
})

test('the committed vocabulary is the pack\'s: its hash is the pin\'s, 32000 pieces, the marks where the loop expects them', () => {
  const text = readFileSync(new URL('../../third_party/moonshine-tiny-en/tokens.json', import.meta.url), 'utf8')
  const pin = speechFile('tokens')
  assert.equal(Buffer.byteLength(text), pin.bytes)
  assert.equal(sha256(text), pin.sha256)
  const vocab = parseVocabulary(text)
  assert.equal(vocab.length, 32_000)
  assert.deepEqual([vocab[0], vocab[SPEECH_SHAPE.start], vocab[SPEECH_SHAPE.end], vocab[3], vocab[258]], ['<unk>', '<s>', '</s>', '<0x00>', '<0xFF>'])
  for (const bad of ['', 'nope', '{}', '[1,2,3]', JSON.stringify(['a', 'b'])]) assert.throws(() => parseVocabulary(bad), /speech vocabulary/, bad)
})

test('an utterance: too short or too quiet is not read; unsure or wordless gives no text and says why; over the limit is read up to it', async () => {
  const vocab = ['<unk>', '<s>', '</s>', '▁yes', '.', '▁no']
  const run = (script: number[], samples: Float32Array, p: number | ((s: number) => number) = 0.9) => { const f = fake(script, p); return readUtterance(f.rt, samples, vocab).then((r) => ({ r, f })) }
  const short = await run([3], seconds(SPEECH_LIMITS.minSeconds - 0.05))
  assert.deepEqual([short.r.text, short.r.dropped, short.f.encoded.length], ['', 'short', 0], 'not read at all')
  const quiet = await run([3], seconds(1, SPEECH_LIMITS.quiet / 2))
  assert.deepEqual([quiet.r.text, quiet.r.dropped, quiet.f.encoded.length], ['', 'quiet', 0])
  const said = await run([3, 4], seconds(1))
  assert.deepEqual([said.r.text, said.r.dropped, said.r.tokens, said.r.cut], ['yes.', '', [3, 4], false])
  assert.ok(Math.abs(said.r.seconds - 1) < 1e-9 && said.r.sure > 0.89)
  const unsure = await run([3, 5], seconds(1), SPEECH_LIMITS.sure - 0.05)
  assert.deepEqual([unsure.r.text, unsure.r.dropped], ['', 'unsure'], 'a guess at a noise is not passed on as words')
  assert.deepEqual(unsure.r.tokens, [3, 5], 'what it wrote is kept for the count')
  const mixed = await run([3, 5], seconds(1), (s) => (s === 0 ? 0.99 : 0.2))
  assert.equal(mixed.r.dropped, '', 'one unsure token in a sure sentence does not drop it')
  const empty = await run([], seconds(1))
  assert.deepEqual([empty.r.text, empty.r.dropped], ['', 'empty'])
  const dots = await run([4, 4], seconds(1))
  assert.deepEqual([dots.r.text, dots.r.dropped], ['', 'empty'], 'punctuation alone says nothing')
  const long = await run([3], seconds(SPEECH_LIMITS.maxSeconds + 5))
  assert.equal(long.f.encoded[0].dims[1], SPEECH_LIMITS.maxSeconds * SPEECH_SHAPE.rate, 'read up to the limit')
  // The microphone's room around the words is not read: a word in two seconds of near silence reaches the model as the
  // word and a little either side.
  const room = new Float32Array(2 * SPEECH_SHAPE.rate).fill(0.0005)
  room.fill(0.2, 0.8 * SPEECH_SHAPE.rate, 1.2 * SPEECH_SHAPE.rate)
  const word = await run([3], room)
  const fed = word.f.encoded[0].data as Float32Array
  assert.equal(fed.length, Math.round((0.4 + 2 * SPEECH_LIMITS.margin) * SPEECH_SHAPE.rate), 'the word and the margin either side')
  assert.equal(fed[Math.round(SPEECH_LIMITS.margin * SPEECH_SHAPE.rate)], Math.fround(0.2), 'the word starts after the margin')
  assert.ok(Math.abs(word.r.seconds - 2) < 1e-9, 'the utterance\'s own length is reported')
  assert.ok(Math.abs(long.r.seconds - (SPEECH_LIMITS.maxSeconds + 5)) < 1e-9, 'and its true length reported')
})

test('voicedSpan: from a margin before the first loud frame to a margin after the last, as a view; the whole when nothing is loud', () => {
  const rate = SPEECH_SHAPE.rate
  const a = new Float32Array(3 * rate).fill(0.001)
  a.fill(0.3, rate, Math.round(1.5 * rate))
  a.fill(0.05, Math.round(1.7 * rate), 2 * rate) // a quiet last syllable: a sixth of the peak, still words
  const v = voicedSpan(a, rate, 0.05, 0.15)
  assert.equal(v.buffer, a.buffer, 'a view, not a copy')
  assert.equal(v.byteOffset / 4, Math.round(0.85 * rate))
  assert.equal(v.length, Math.round((2.15 - 0.85) * rate))
  // Speech at the very start or end: the margin stops at the edge.
  const edge = new Float32Array(rate).fill(0.2)
  assert.equal(voicedSpan(edge, rate), edge, 'all of it voiced: the same array')
  // Nothing over the floor (all quieter than SPEECH_LIMITS.quiet): left whole for the quiet check to judge.
  const hush = new Float32Array(rate).fill(SPEECH_LIMITS.quiet / 2)
  assert.equal(voicedSpan(hush, rate), hush)
  // Under one frame: left whole.
  const tiny = new Float32Array(10).fill(0.5)
  assert.equal(voicedSpan(tiny, rate), tiny)
  // One loud click among speech-level sound does not hide the speech: the bar is set by the third loudest frame.
  const click = new Float32Array(2 * rate).fill(0.0001)
  click.fill(0.06, Math.round(0.5 * rate), Math.round(1.5 * rate))
  click.fill(0.9, Math.round(1.0 * rate), Math.round(1.0 * rate) + 320)
  const c = voicedSpan(click, rate)
  assert.equal(c.byteOffset / 4, Math.round(0.35 * rate))
})

test('saysSomething and peak', () => {
  assert.ok(saysSomething('yes') && saysSomething('7') && saysSomething('é') && saysSomething('你好'))
  assert.ok(!saysSomething('') && !saysSomething('...') && !saysSomething(' ?! '))
  assert.equal(peak(new Float32Array([0.1, -0.5, 0.25])), 0.5)
  assert.equal(peak(new Float32Array(0)), 0)
})

test('holdChecked: every file is checked; the good are held, a bad one is forgotten and named, and the rest of its round is still held', async () => {
  const bytes = (n: number): ArrayBuffer => Uint8Array.from({ length: 8 }, () => n).buffer
  const digest = async (b: ArrayBuffer): Promise<string> => sha256(new Uint8Array(b))
  const file = (role: string, n: number, lie = false) => ({ role, bytes: bytes(n), sha256: sha256(new Uint8Array(bytes(lie ? n + 1 : n))) })
  const held = new Map<string, ArrayBuffer>()
  // The second of four is bad: the two after it are held all the same (a round that stopped there would never finish).
  assert.deepEqual(await holdChecked(held, [file('a', 1), file('b', 2, true), file('c', 3), file('d', 4)], digest), ['b'])
  assert.deepEqual([...held.keys()], ['a', 'c', 'd'])
  // It comes again, right this time.
  assert.deepEqual(await holdChecked(held, [file('b', 2)], digest), [])
  assert.deepEqual([...held.keys()].sort(), ['a', 'b', 'c', 'd'])
  // A bad copy of a role already held forgets the held one: nothing unchecked is ever left under that role.
  assert.deepEqual(await holdChecked(held, [file('a', 9, true), file('c', 9, true)], digest), ['a', 'c'])
  assert.deepEqual([...held.keys()].sort(), ['b', 'd'])
  assert.deepEqual(await holdChecked(held, [], digest), [])
})
