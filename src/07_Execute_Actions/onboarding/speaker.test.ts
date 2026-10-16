// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for Sloane's spoken voice (speaker.ts): only a voice synthesised on this
 * machine is ever picked (a remote one is never used, whatever its name), the tier follows the sound and the switch,
 * the speech provider is preferred when it has a voice and the soundscape can place it, a provider that fails falls
 * back to the browser's voice so the line is still heard, a new line cuts the one before, an abort cuts a line, the
 * switch and the voice are kept, and the console bridge reads it all back. Nothing here touches a real browser: the
 * synthesis and the provider are fakes handed in.
 * What breaks if it is removed? A network voice could be picked behind the air gap, or Sloane could talk over the
 * sound being off, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SpeechClip, Utterance, Voice } from '../operator.ts'
import {
  CONCIERGE_DEFAULTS, CONCIERGE_KEY, ConciergeSpeaker, conciergeBridge, loadConciergeSettings, offlineVoices, pickVoice, saveConciergeSettings, synthEnv, tierFor,
  type KeyStore, type SynthLike, type SynthVoice, type UtteranceLike,
} from './speaker.ts'

const VOICES: SynthVoice[] = [
  { name: 'Google UK English Male', lang: 'en-GB', localService: false },
  { name: 'Microsoft Zira', lang: 'en-US', localService: true },
  { name: 'Microsoft David', lang: 'en-US', localService: true, default: true },
  { name: 'Microsoft Hortense', lang: 'fr-FR', localService: true },
]

function memoryStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}

/** A fake speechSynthesis: utterances end when the test says so. */
function fakeSynth(voices: SynthVoice[] = VOICES) {
  const spoken: UtteranceLike[] = []
  let cancelled = 0
  class U implements UtteranceLike {
    text: string
    voice: SynthVoice | null = null
    pitch = 1
    rate = 1
    lang = ''
    onend: ((e: unknown) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    constructor(text: string) { this.text = text }
  }
  const synth: SynthLike = {
    getVoices: () => voices,
    speak: (u) => { spoken.push(u) },
    cancel: () => { cancelled++; const u = spoken[spoken.length - 1]; u?.onend?.({}) },
  }
  return { env: { synth, Utterance: U }, spoken, get cancelled() { return cancelled }, end: () => spoken[spoken.length - 1]?.onend?.({}) }
}

test('synthEnv reads the browser\'s objects, or nulls; only offline voices are ever picked, English and the default first; a preference by whole name or a word of it', () => {
  assert.deepEqual(synthEnv({}), { synth: null, Utterance: null })
  const { env } = fakeSynth()
  assert.equal(synthEnv({ speechSynthesis: env.synth, SpeechSynthesisUtterance: env.Utterance }).synth, env.synth)
  assert.deepEqual(offlineVoices(VOICES).map((v) => v.name), ['Microsoft David', 'Microsoft Zira', 'Microsoft Hortense'])
  assert.equal(pickVoice(VOICES, null)?.name, 'Microsoft David')
  assert.equal(pickVoice(VOICES, 'zira')?.name, 'Microsoft Zira')
  assert.equal(pickVoice(VOICES, 'Microsoft Zira')?.name, 'Microsoft Zira')
  assert.equal(pickVoice(VOICES, 'Google UK English Male')?.name, 'Microsoft David', 'a network voice is never picked, even by name')
  assert.equal(pickVoice(VOICES, 'nobody')?.name, 'Microsoft David')
  assert.equal(pickVoice([VOICES[0]], null), null)
})

test('the tier: silent while the sound or the switch is off; the provider when it has a voice and a place to sound; else the browser; else silent', () => {
  assert.equal(tierFor({ sound: false, on: true, providerVoice: 'v1', placed: true, browserVoices: 3 }), 'silent')
  assert.equal(tierFor({ sound: true, on: false, providerVoice: 'v1', placed: true, browserVoices: 3 }), 'silent')
  assert.equal(tierFor({ sound: true, on: true, providerVoice: 'v1', placed: true, browserVoices: 3 }), 'provider')
  assert.equal(tierFor({ sound: true, on: true, providerVoice: 'v1', placed: false, browserVoices: 3 }), 'browser', 'no soundscape yet (the onboarding): the browser')
  assert.equal(tierFor({ sound: true, on: true, providerVoice: null, placed: true, browserVoices: 3 }), 'browser')
  assert.equal(tierFor({ sound: true, on: true, providerVoice: null, placed: true, browserVoices: 0 }), 'silent')
})

test('the settings: on by default with no voice preferred; kept under one key; anything odd reads as the defaults', () => {
  const store = memoryStore()
  assert.deepEqual(loadConciergeSettings(store), CONCIERGE_DEFAULTS)
  saveConciergeSettings({ on: false, voice: 'zira' }, store)
  assert.deepEqual([...store.map.keys()], [CONCIERGE_KEY])
  assert.deepEqual(loadConciergeSettings(store), { on: false, voice: 'zira' })
  store.map.set(CONCIERGE_KEY, JSON.stringify({ v: 1, on: 'yes', voice: 'a\nb' }))
  assert.deepEqual(loadConciergeSettings(store), { on: true, voice: null })
  store.map.set(CONCIERGE_KEY, '{not json')
  assert.deepEqual(loadConciergeSettings(store), CONCIERGE_DEFAULTS)
  assert.deepEqual(loadConciergeSettings(null), CONCIERGE_DEFAULTS)
})

/** A fake provider: the operator's voice and the soundscape at the player's head. */
function fakeProvider(o: { voice?: string | null; fail?: boolean } = {}) {
  const said: string[] = []
  const played: string[] = []
  let stops = 0
  let finish: (() => void) | null = null
  const voice: Voice = {
    settings: () => ({ server: 'http://localhost:8880', model: null, voice: o.voice === undefined ? 'v1' : o.voice, auto: false }),
    setServer: (u) => u, setModel: (m) => m, setVoice: (v) => v, setAuto: (a) => a,
    voices: () => Promise.resolve(['v1']),
    synthesize: (text, signal) => {
      said.push(text)
      if (o.fail) return Promise.reject(new Error('no local speech server is answering'))
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        resolve(new ArrayBuffer(8))
      })
    },
  }
  const out = {
    decode: (bytes: ArrayBuffer): Promise<SpeechClip> => Promise.resolve({ seconds: bytes.byteLength / 8 }),
    play: (_clip: SpeechClip, text: string): Utterance => {
      played.push(text)
      const ended = new Promise<void>((resolve) => { finish = resolve })
      return Object.freeze({ ended, stop: () => { stops++; finish?.() } })
    },
  }
  return { voice, out, said, played, get stops() { return stops }, end: () => finish?.() }
}

test('speak: the provider at the player\'s head when it has a voice; a failing provider falls back to the browser; no voice chosen, the browser; sound off, nothing; a new line cuts the last; an abort cuts', async () => {
  const synth = fakeSynth()
  const store = memoryStore()
  let sound = true
  const p = fakeProvider()
  let source: { voice: Voice; out: typeof p.out } | null = null
  const s = new ConciergeSpeaker({ env: synth.env, sound: () => sound, source: () => source, store })
  // The onboarding: no engine yet, the browser's offline voice, shaped by Sloane's profile.
  const first = s.speak('Hi, I’m Sloane.')
  assert.equal(synth.spoken.length, 1)
  assert.equal(synth.spoken[0].voice?.name, 'Microsoft David')
  assert.ok(synth.spoken[0].pitch < 1 && synth.spoken[0].rate < 1, 'velvet: a little lower and slower')
  synth.end()
  assert.equal(await first, 'browser')
  assert.equal(s.lastTier, 'browser')
  // The city: the provider has a voice and the soundscape can place it.
  source = { voice: p.voice, out: p.out }
  assert.equal(s.tier(), 'provider')
  const second = s.speak('  Beautiful city,   isn’t it?  ')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(p.said, ['Beautiful city, isn’t it?'], 'one line, white space folded')
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(p.played, ['Beautiful city, isn’t it?'])
  // A new line cuts the one being said.
  const third = s.speak('See the tallest needle?')
  assert.equal(p.stops, 1)
  assert.equal(await second, 'provider')
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  p.end()
  assert.equal(await third, 'provider')
  // The provider fails: the browser's voice says the line instead.
  const failing = fakeProvider({ fail: true })
  source = { voice: failing.voice, out: failing.out }
  const fourth = s.speak('Still here.')
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(synth.spoken.length, 2)
  synth.end()
  assert.equal(await fourth, 'browser')
  // No voice chosen at the provider: the browser.
  source = { voice: fakeProvider({ voice: null }).voice, out: p.out }
  assert.equal(s.tier(), 'browser')
  // Sound off: nothing at all, and the switch off likewise; both read back.
  sound = false
  assert.equal(await s.speak('Quiet.'), 'silent')
  sound = true
  assert.equal(s.setOn(false), false)
  assert.equal(await s.speak('Quiet.'), 'silent')
  assert.deepEqual(loadConciergeSettings(store), { on: false, voice: null })
  s.setOn(true)
  assert.equal(s.setVoice('zira'), 'Microsoft Zira')
  assert.deepEqual(loadConciergeSettings(store), { on: true, voice: 'zira' })
  assert.equal(s.setVoice(null), 'Microsoft David')
  // An abort cuts a browser line.
  const ctl = new AbortController()
  const fifth = s.speak('Cut me off.', ctl.signal)
  ctl.abort()
  assert.equal(await fifth, 'browser')
  assert.ok(synth.cancelled >= 1)
  assert.equal(await s.speak('   '), 'silent', 'nothing to say')
})

test('a line cut while its audio is still coming is said by nobody, the next line keeps its own cut, and an abort while a clip plays fades it out', async () => {
  const tick = () => new Promise((r) => setTimeout(r, 0))
  const synth = fakeSynth()
  const pending: ((b: ArrayBuffer) => void)[] = []
  const played: { text: string; stopped: boolean }[] = []
  const voice: Voice = {
    settings: () => ({ server: 'http://localhost:8880', model: null, voice: 'v1', auto: false }),
    setServer: (u) => u, setModel: (m) => m, setVoice: (v) => v, setAuto: (a) => a,
    voices: () => Promise.resolve(['v1']),
    synthesize: (_text, signal) => new Promise((resolve, reject) => {
      pending.push(resolve)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
  }
  const out = {
    decode: (bytes: ArrayBuffer): Promise<SpeechClip> => Promise.resolve({ seconds: bytes.byteLength / 8 }),
    play: (_clip: SpeechClip, text: string): Utterance => {
      const rec = { text, stopped: false }
      played.push(rec)
      let finish = () => {}
      const ended = new Promise<void>((resolve) => { finish = resolve })
      return Object.freeze({ ended, stop: () => { rec.stopped = true; finish() } })
    },
  }
  const s = new ConciergeSpeaker({ env: synth.env, sound: () => true, source: () => ({ voice, out }), store: memoryStore() })
  const first = s.speak('First line.')
  const second = s.speak('Second line.')
  assert.equal(await first, 'silent', 'cut on its way: said by nobody')
  assert.equal(synth.spoken.length, 0, 'not by the browser in its place either')
  // The first line's end left the second's cut in place: stop still reaches it.
  await tick()
  s.stop()
  assert.equal(await second, 'silent')
  assert.equal(played.length, 0)
  // An abort while the clip plays fades it out, and the line ends.
  const ctl = new AbortController()
  const third = s.speak('Third line.', ctl.signal)
  await tick()
  pending[pending.length - 1](new ArrayBuffer(8))
  await tick()
  await tick()
  assert.deepEqual(played.map((p) => p.text), ['Third line.'])
  ctl.abort()
  assert.equal(await third, 'provider')
  assert.equal(played[0].stopped, true)
  assert.equal(synth.spoken.length, 0)
})

test('a provider line whose sound went off on the way is not handed to the browser\'s voice instead', async () => {
  const synth = fakeSynth()
  let sound = true
  const p = fakeProvider()
  const out = { ...p.out, decode: () => { sound = false; return Promise.reject(new Error("the city's sound is off")) } }
  const s = new ConciergeSpeaker({ env: synth.env, sound: () => sound, source: () => ({ voice: p.voice, out }), store: memoryStore() })
  assert.equal(await s.speak('Over here.'), 'silent')
  assert.equal(synth.spoken.length, 0)
  sound = true
  assert.equal(await s.preview('Hi.', 'af_sky'), 'silent', 'the Hear button likewise')
  assert.equal(synth.spoken.length, 0)
})

test('preview: the card\'s Hear button; a profile shapes the browser\'s voice, a provider voice is said by the provider in that voice; the sound must be on, Sloane\'s switch need not be', async () => {
  const synth = fakeSynth()
  let sound = true
  const p = fakeProvider()
  const asked: (string | undefined)[] = []
  const voice: Voice = { ...p.voice, synthesize: (text, signal, v) => { asked.push(v); return p.voice.synthesize(text, signal) } }
  const s = new ConciergeSpeaker({ env: synth.env, sound: () => sound, source: () => ({ voice, out: p.out }), store: memoryStore() })
  s.setOn(false)
  const deep = s.preview('Hi, I’m Nova.', 'deep')
  assert.equal(synth.spoken.length, 1, 'a profile: the browser, even with a provider up')
  assert.equal(synth.spoken[0].pitch, 0.78)
  assert.equal(synth.spoken[0].rate, 0.95)
  synth.end()
  assert.equal(await deep, 'browser')
  const named = s.preview('Hi, I’m Nova.', 'af_sky')
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(asked, ['af_sky'], 'the provider, asked for that voice alone')
  p.end()
  assert.equal(await named, 'provider')
  assert.equal(p.voice.settings().voice, 'v1', 'the provider\'s own choice untouched')
  sound = false
  assert.equal(await s.preview('Quiet.', 'deep'), 'silent')
  assert.equal(synth.spoken.length, 1)
})

test('the console bridge: status names the switch, the tier and the voice; on and off; a voice by name; the list; a line said now', async () => {
  const synth = fakeSynth()
  const s = new ConciergeSpeaker({ env: synth.env, sound: () => true, store: memoryStore() })
  const b = conciergeBridge(s)
  assert.deepEqual(b.status(), [
    'switch    on  (sloane on|off)',
    "tier      the browser's own offline voice (no neural model is bundled with the page)",
    'voice     the first offline voice  (sloane voice <name>; 3 offline voices: sloane voices)',
    'profile   velvet: smooth and unhurried; Sloane\'s own',
  ])
  assert.equal(b.on(false), 'off: Sloane is text on the card')
  assert.match(b.status()[1], /^tier {6}silent/)
  assert.equal(b.on(true), 'on: Sloane speaks while the sound is on')
  assert.equal(b.voice('zira'), "Microsoft Zira  (the nearest to 'zira')")
  assert.equal(b.voice('Microsoft David'), 'Microsoft David')
  assert.deepEqual(b.voices(), ['Microsoft David', 'Microsoft Zira', 'Microsoft Hortense'])
  const said = b.say('Hello there.')
  synth.end()
  assert.equal(await said, "said by the browser's own offline voice (no neural model is bundled with the page)")
  const none = conciergeBridge(new ConciergeSpeaker({ env: { synth: null, Utterance: null }, sound: () => true, store: memoryStore() }))
  assert.deepEqual(none.voices(), ['no offline voice on this machine'])
  assert.match(none.status()[2], /this browser has no offline voice/)
})
