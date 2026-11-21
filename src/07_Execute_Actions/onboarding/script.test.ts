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
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { REGIONS, ZONE } from '../../01_Initialize_World/lakefront.ts'
import type { Answer, Mind, Piece } from '../operator.ts'
import {
  MAP_KEY, NO_ANSWERS, ONBOARDING_KEY, PLACES, SKIPPED, SOUNDS, STEPS, TIMES, answer, choicesFor, lineFor, loadMapChoice, loadOnboarding, mapWanted, needsOnboarding, nextStep, saveMapChoice,
  onboardingPackFor, optionsFrom, outcomeOf, placeWanted, said, saveOnboarding,
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
    const line = lineFor(step, a, 'Sloane')
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
  assert.match(lineFor('place', a, 'Sloane'), /Julian/)
  a = answer(a, 'place', ZONE.eastBluffs)
  assert.match(lineFor('time', a, 'Sloane'), /cliffs/)
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
  assert.match(lineFor('place', NO_ANSWERS, 'Sloane'), /friend/)
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

test('which region to stand in: ?place= first, then the onboarding\'s choice, else none; a word that names no region is no word', () => {
  const q = (s: string) => new URLSearchParams(s)
  const chosen = { v: 1 as const, place: 'west-sprawl', hour: 9, audio: true, skipped: false }
  assert.equal(placeWanted(q(''), null), null)
  assert.equal(placeWanted(q(''), SKIPPED), null)
  assert.equal(placeWanted(q(''), chosen), ZONE.westSprawl)
  // Every region's slug, as the onboarding saves it (lakefront.ts REGIONS), reaches its own zone from the address bar.
  for (const r of REGIONS) assert.equal(placeWanted(q(`place=${r.slug}`), null), r.id)
  assert.equal(REGIONS.length, 5)
  assert.equal(placeWanted(q('place=the-grand-ravine'), chosen), ZONE.grandRavine, 'the address bar ahead of the saved choice')
  assert.equal(placeWanted(q('map=lakefront&place=north-ridge&quality=3'), null), ZONE.northRidge)
  // A word that names no region (a typo, another case, an empty value) falls through to the saved choice, then to none.
  for (const word of ['', 'narnia', 'West-Sprawl', 'west sprawl', '1']) {
    assert.equal(placeWanted(q(`place=${encodeURIComponent(word)}`), chosen), ZONE.westSprawl, `"${word}" with a saved choice`)
    assert.equal(placeWanted(q(`place=${encodeURIComponent(word)}`), null), null, `"${word}" alone`)
  }
  // It only says where to stand: the map is mapWanted's, and ?place= alone does not choose the lakefront.
  assert.equal(mapWanted(q('place=north-ridge'), null, false), 'city')
  // App reads it once, with the metropolis as the default.
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  assert.ok(app.includes('const zone = placeWanted(new URLSearchParams(window.location.search), chosen) ?? ZONE.metropolis'))
})

test('the onboarding\'s pack is used only when it starts where the visitor stands; ?place= naming another region wins on that visit too', () => {
  const built = (home: number) => ({ name: 'Lakefront Metro', quarters: { home } })
  for (const r of REGIONS) {
    const pack = built(r.id)
    assert.equal(onboardingPackFor(pack, r.id), pack, `${r.slug}: the onboarding's own pack, not built again`)
    for (const other of REGIONS) if (other.id !== r.id) assert.equal(onboardingPackFor(pack, other.id), null, `${r.slug} pack, ${other.slug} wanted: built again`)
  }
  assert.equal(onboardingPackFor(null, ZONE.metropolis), null, 'skipped onboarding: no pack')
  assert.equal(onboardingPackFor(undefined, ZONE.metropolis), null, 'no onboarding this visit: no pack')
  const old: { name: string; quarters?: { home: number } } = { name: 'old' }
  assert.equal(onboardingPackFor(old, ZONE.metropolis), null, 'a pack with no quarters layer says nothing of its start: built again')
  // App hands the shell the pack through it, and loadMap builds one for the zone when it hands none.
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  assert.ok(app.includes('plan={{ choice, pack: onboardingPackFor(outcome?.pack, zone), zone }}'))
  assert.ok(app.includes('if (plan.pack) return plan.pack') && app.includes('return await b.pack(plan.zone)'))
  assert.ok(!app.includes('pack: outcome?.pack ?? null'), 'the onboarding\'s pack never reaches the shell unchecked')
})

test('the onboarding builds its pack for the very region its saved answer names, so with no ?place= the page never builds a second', () => {
  // Onboarding.tsx saves outcomeOf(answers) and builds the pack for answers.place (the metropolis when none): App then
  // reads the region back from that saved answer (placeWanted), and onboardingPackFor keeps the pack when the two agree.
  const q = (s: string) => new URLSearchParams(s)
  for (const r of REGIONS) {
    const answers = { ...NO_ANSWERS, name: 'Ada', place: r.id, hour: 9, audio: true }
    const zone = placeWanted(q(''), outcomeOf(answers))
    assert.equal(zone, answers.place ?? ZONE.metropolis, `${r.slug}: the saved answer reads back as the region built for`)
    assert.ok(onboardingPackFor({ quarters: { home: answers.place ?? ZONE.metropolis } }, zone ?? ZONE.metropolis), `${r.slug}: the pack is kept`)
  }
  const none = { ...NO_ANSWERS, name: 'Ada' }
  assert.equal(placeWanted(q(''), outcomeOf(none)), ZONE.metropolis, 'no place answered: saved and built as the metropolis')
  const onboarding = readFileSync(new URL('./Onboarding.tsx', import.meta.url), 'utf8')
  assert.ok(onboarding.includes('const saved = outcomeOf(answers)'))
  assert.ok(onboarding.includes('pack = (await builderRef.current?.pack(answers.place ?? ZONE.metropolis)) ?? null'), 'built for the answer it saves')
})

test('a map chosen at the console is kept between visits and beats the onboarding and the pilot default, never the URL', () => {
  const q = (s: string) => new URLSearchParams(s)
  const chosen = { v: 1 as const, place: 'west-sprawl', hour: 9, audio: true, skipped: false }
  assert.equal(mapWanted(q(''), chosen, false, 'city'), 'city')
  assert.equal(mapWanted(q(''), null, false, 'lakefront'), 'lakefront')
  assert.equal(mapWanted(q(''), chosen, true, 'city'), 'city')
  assert.equal(mapWanted(q('map=lakefront'), null, false, 'city'), 'lakefront')
  assert.equal(mapWanted(q('region=on'), null, false, 'city'), 'region')
  const store = new Map<string, string>()
  const kv = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) }, removeItem: (k: string) => { store.delete(k) } }
  assert.equal(loadMapChoice(kv), null)
  saveMapChoice('city', kv)
  assert.equal(store.get(MAP_KEY), 'city')
  assert.equal(loadMapChoice(kv), 'city')
  saveMapChoice(null, kv)
  assert.equal(loadMapChoice(kv), null)
  store.set(MAP_KEY, 'moon')
  assert.equal(loadMapChoice(kv), null, 'an unknown word is no choice')
  assert.equal(loadMapChoice(null), null)
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
  // A rewording that keeps the choices but fails the 14A screen (the Ring-0 gate's admitWords) is never the city's own words.
  const foul = modelVoice(mindThat(async (_p, on) => { on({ kind: 'text', text: 'Morning, sunset or night, you idiot?' }) }), keep)
  assert.equal(await foul.say(line, never), line)
  assert.ok(mustKeep('Morning, Sunset or Night?', ['morning', 'night']))
  assert.ok(!mustKeep('Morning or evening?', ['morning', 'night']))
})
