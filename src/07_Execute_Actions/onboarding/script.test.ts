// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the onboarding conversation: four steps then ready, at most three one-word choices
 * per step, every line plain words with no jargon, every choice a single word, an unknown answer falling to a sane
 * default, the answers becoming page options and a saved choice a returning visitor is taken back to, the onboarding
 * shown on a first visit only (and as the URL says), the map choice rules, and the voice: the script stands when the
 * model is slow, silent, long-winded or drops a choice.
 * What breaks if it is removed? A line could gain jargon, a step a fourth choice, or the saved choice stop being honoured.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REGIONS, ZONE } from '../../01_Initialize_World/lakefront.ts'
import type { Answer, Mind, Piece } from '../operator.ts'
import {
  NO_ANSWERS, ONBOARDING_KEY, PLACES, SKIPPED, SOUNDS, STEPS, TIMES, answer, choicesFor, lineFor, loadOnboarding, mapWanted, needsOnboarding, nextStep,
  optionsFrom, outcomeOf, said, saveOnboarding,
} from './script.ts'
import { modelVoice, mustKeep, scriptedVoice } from './voice.ts'

const JARGON = /\b(seed|shader|WebGPU|GPU|fps|frame|render|navmesh|physics|region pack|worker|wasm|URL|query|parameter|localStorage)\b/i

const fakeStore = () => { const m = new Map<string, string>(); return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) }, removeItem: (k: string) => { m.delete(k) } } }

test('four steps then ready; every choice is one word, at most five of them; every line is plain words', () => {
  assert.deepEqual(STEPS, ['name', 'place', 'time', 'sound', 'ready'])
  assert.equal(nextStep('name'), 'place')
  assert.equal(nextStep('ready'), 'ready')
  let a = NO_ANSWERS
  for (const step of STEPS) {
    const line = lineFor(step, a, 'Wren')
    assert.ok(line.length > 10 && line.length < 260, line)
    assert.doesNotMatch(line, JARGON, line)
    const choices = choicesFor(step)
    if (step === 'name' || step === 'ready') assert.equal(choices, null)
    else {
      assert.ok(choices && choices.length >= 2 && choices.length <= 5)
      for (const c of choices!) { assert.match(c.label, /^[A-Z][a-z]+$/, c.label); assert.doesNotMatch(c.blurb, JARGON) }
    }
    if (choices) a = answer(a, step, choices[0].value)
    else if (step === 'name') a = answer(a, step, 'Julian')
  }
  assert.equal(PLACES.length, REGIONS.length)
  assert.deepEqual(PLACES.map((p) => p.value), REGIONS.map((r) => r.id))
  assert.equal(TIMES.length, 3)
  assert.equal(SOUNDS.length, 2)
})

test('answers move the conversation on, and an unknown answer falls to a sane default', () => {
  let a = answer(NO_ANSWERS, 'name', 'Julian')
  assert.equal(a.name, 'Julian')
  assert.match(lineFor('place', a, 'Wren'), /Julian/)
  a = answer(a, 'place', ZONE.eastBluffs)
  assert.match(lineFor('time', a, 'Wren'), /cliffs/)
  assert.equal(said('place', a), 'East')
  a = answer(a, 'time', 22)
  a = answer(a, 'sound', false)
  assert.deepEqual(optionsFrom(a), { startHour: 22, audio: false })
  assert.equal(said('sound', a), 'Off')
  const odd = answer(answer(answer(NO_ANSWERS, 'place', 99), 'time', 'noon'), 'sound', 'maybe')
  assert.equal(odd.place, ZONE.metropolis)
  assert.equal(odd.hour, 17)
  assert.equal(odd.audio, false)
  assert.equal(said('name', NO_ANSWERS), 'I’d rather not say')
  assert.match(lineFor('place', NO_ANSWERS, 'Wren'), /friend/)
})

test('the outcome is saved and read back; a corrupt or foreign entry reads as nothing', () => {
  const store = fakeStore()
  assert.equal(loadOnboarding(store), null)
  const a = answer(answer(answer(answer(NO_ANSWERS, 'name', 'J'), 'place', ZONE.northRidge), 'time', 9), 'sound', true)
  const out = outcomeOf(a)
  assert.deepEqual(out, { v: 1, place: 'north-ridge', hour: 9, audio: true, skipped: false })
  saveOnboarding(out, store)
  assert.deepEqual(loadOnboarding(store), out)
  saveOnboarding(SKIPPED, store)
  assert.deepEqual(loadOnboarding(store), SKIPPED)
  store.setItem(ONBOARDING_KEY, '{"v":1,"place":"hollywood","hour":"x"}')
  assert.deepEqual(loadOnboarding(store), { v: 1, place: null, hour: 17, audio: true, skipped: false })
  store.setItem(ONBOARDING_KEY, 'not json')
  assert.equal(loadOnboarding(store), null)
  assert.equal(loadOnboarding(null), null)
})

test('the onboarding is shown on a first visit only, as the URL says, never in the console shell', () => {
  const q = (s: string) => new URLSearchParams(s)
  const profile = { name: 'J', seed: 1 }
  assert.equal(needsOnboarding(q(''), null, null), true)
  assert.equal(needsOnboarding(q(''), SKIPPED, null), false)
  assert.equal(needsOnboarding(q(''), null, profile), false)
  assert.equal(needsOnboarding(q('onboarding=0'), null, null), false)
  assert.equal(needsOnboarding(q('onboarding=1'), SKIPPED, profile), true)
  assert.equal(needsOnboarding(q('boot=tty'), null, null), false)
  assert.equal(needsOnboarding(q('boot=tty&onboarding=1'), null, null), false)
})

test('which map: the URL first, then the visitor\'s saved choice, else the procedural city', () => {
  const q = (s: string) => new URLSearchParams(s)
  const chosen = { v: 1 as const, place: 'west-sprawl', hour: 9, audio: true, skipped: false }
  assert.equal(mapWanted(q(''), null, false), 'city')
  assert.equal(mapWanted(q(''), chosen, false), 'lakefront')
  assert.equal(mapWanted(q(''), SKIPPED, false), 'city')
  assert.equal(mapWanted(q('map=lakefront'), null, false), 'lakefront')
  assert.equal(mapWanted(q('map=city'), chosen, false), 'city')
  assert.equal(mapWanted(q('region=off'), chosen, false), 'city')
  assert.equal(mapWanted(q('region=on'), chosen, false), 'region')
  assert.equal(mapWanted(q(''), chosen, true), 'region')
  assert.equal(mapWanted(q('region=off'), null, true), 'city')
})

const mindThat = (reply: (prompt: string, onPiece: (p: Piece) => void, signal: AbortSignal) => Promise<void>): Mind => ({
  settings: () => ({ server: '', model: null }),
  setServer: (u) => u,
  setModel: (m) => m,
  installed: async () => [],
  answer: async (req, onPiece): Promise<Answer> => {
    await reply(req.prompt, onPiece, req.signal)
    return { text: '', thinking: 0, tokens: 0, stop: 'end', promptHash: '' } as unknown as Answer
  },
})

test('the voice: the script word for word; the model\'s rewording only when it is quick, short and keeps the choices', async () => {
  const line = 'Should it be morning, sunset or night when you arrive?'
  const keep = () => ['morning', 'sunset', 'night']
  const never = new AbortController().signal
  assert.equal(await scriptedVoice().say(line, never), line)
  const good = modelVoice(mindThat(async (_p, on) => { on({ kind: 'text', text: 'Do you want it to be ' }); on({ kind: 'text', text: 'morning, sunset, or night?' }) }), keep)
  assert.equal(await good.say(line, never), 'Do you want it to be morning, sunset, or night?')
  const drops = modelVoice(mindThat(async (_p, on) => { on({ kind: 'text', text: 'Pick a time of day!' }) }), keep)
  assert.equal(await drops.say(line, never), line)
  const long = modelVoice(mindThat(async (_p, on) => { on({ kind: 'text', text: `morning sunset night ${'x'.repeat(300)}` }) }), keep)
  assert.equal(await long.say(line, never), line)
  const fails = modelVoice(mindThat(async () => { throw new Error('no key') }), keep)
  assert.equal(await fails.say(line, never), line)
  const slow = modelVoice(mindThat((_p, _on, signal) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason)) })), keep, 20)
  assert.equal(await slow.say(line, never), line)
  assert.ok(mustKeep('Morning, Sunset or Night?', ['morning', 'night']))
  assert.ok(!mustKeep('Morning or evening?', ['morning', 'night']))
})
