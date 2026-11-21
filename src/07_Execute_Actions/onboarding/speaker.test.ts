// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for Sloane's spoken voice (speaker.ts): only a voice synthesised on this
 * machine is ever picked (a remote one is never used, whatever its name), the tier follows the sound and the switch,
 * the speech provider is preferred when it has a voice and the soundscape can place it, a provider that fails falls
 * back to the browser's voice so the line is still heard, a new line cuts the one before, an abort cuts a line, the
 * switch and the voice are kept, and the console bridge reads it all back. A person in the street speaks through the
 * same mouth (`person`): a hired agent's own provider voice through their own output, never the source's; anyone else
 * in an offline voice picked by their number and never Sloane's while there is another (Android's `en_US` counted as
 * English), at their profile's pitch and rate and their volume, captioned around it; the city's sound applies and
 * Sloane's switch does not; their lines and hers cut each other and are told as speech like hers. Nothing here
 * touches a real browser: the synthesis and the provider are fakes handed in.
 * What breaks if it is removed? A network voice could be picked behind the air gap, or Sloane could talk over the
 * sound being off, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SpeechClip, Utterance, Voice } from '../operator.ts'
import type { VoiceProfile } from '../../08_Swarm/roster.ts'
import {
  CONCIERGE_DEFAULTS, CONCIERGE_KEY, ConciergeSpeaker, conciergeBridge, loadConciergeSettings, offlineVoices, personVoice, pickVoice, saveConciergeSettings, synthEnv, tierFor,
  type KeyStore, type PersonVoice, type SynthLike, type SynthVoice, type UtteranceLike,
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
function fakeProvider(o: { voice?: string | null; fail?: boolean; holdDecode?: boolean } = {}) {
  const said: string[] = []
  /** With holdDecode, each decode waits here until the test settles it. */
  const decodes: { done: (ok: boolean) => void }[] = []
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
    decode: (bytes: ArrayBuffer): Promise<SpeechClip> => !o.holdDecode
      ? Promise.resolve({ seconds: bytes.byteLength / 8 })
      : new Promise<SpeechClip>((resolve, reject) => { decodes.push({ done: (ok) => (ok ? resolve({ seconds: bytes.byteLength / 8 }) : reject(new Error('the soundscape refused to decode'))) }) }),
    play: (_clip: SpeechClip, text: string): Utterance => {
      played.push(text)
      const ended = new Promise<void>((resolve) => { finish = resolve })
      return Object.freeze({ ended, stop: () => { stops++; finish?.() } })
    },
  }
  return { voice, out, said, played, decodes, get stops() { return stops }, end: () => finish?.() }
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

test('speaking: on from the first sound of a line to its end, once across a cut to the next line, off after an abort; told to onSpeaking at each edge', async () => {
  const f = fakeSynth()
  const sp = new ConciergeSpeaker({ env: f.env, sound: () => true, store: memoryStore() })
  const told: boolean[] = []
  const stopTelling = sp.onSpeaking((on) => { told.push(on) })
  assert.equal(sp.speaking, false)
  const p1 = sp.speak('One.')
  assert.equal(sp.speaking, true, 'speaking as soon as the line is handed to the voice')
  assert.deepEqual(told, [true])
  const p2 = sp.speak('Two.')
  assert.equal(await p1, 'browser')
  assert.equal(sp.speaking, true, 'the cut line ending does not end the next')
  assert.deepEqual(told, [true], 'one edge across the cut')
  f.end()
  assert.equal(await p2, 'browser')
  assert.equal(sp.speaking, false)
  assert.deepEqual(told, [true, false])
  const ctl = new AbortController()
  const p3 = sp.speak('Three.', ctl.signal)
  ctl.abort()
  await p3
  assert.deepEqual(told, [true, false, true, false])
  assert.equal(await sp.speak('   '), 'silent')
  assert.deepEqual(told, [true, false, true, false], 'nothing said: nothing told')
  const off = new ConciergeSpeaker({ env: f.env, sound: () => false, store: memoryStore() })
  off.onSpeaking((on) => { told.push(on) })
  assert.equal(await off.speak('Quiet.'), 'silent')
  assert.equal(told.length, 4, 'the silent tier is never speaking')
  const pv = sp.preview('As Nova.', 'even')
  assert.equal(sp.speaking, true, 'a preview is speech too')
  f.end()
  assert.equal(await pv, 'browser')
  assert.deepEqual(told, [true, false, true, false, true, false])
  stopTelling()
  const p4 = sp.speak('Four.')
  f.end()
  await p4
  assert.deepEqual(told, [true, false, true, false, true, false], 'untold after the way to stop is taken')
})

test('onLine: told at each line\'s first sound, a line that cuts the one still playing included (no edge of speaking there), and a preview\'s; not for a silent line', async () => {
  const f = fakeSynth()
  const sp = new ConciergeSpeaker({ env: f.env, sound: () => true, store: memoryStore() })
  const heard: string[] = []
  sp.onSpeaking((on) => { heard.push(on ? 'on' : 'off') })
  const stop = sp.onLine(() => { heard.push('line') })
  const p1 = sp.speak('One.')
  assert.deepEqual(heard, ['on', 'line'], 'the edge first, then the line')
  const p2 = sp.speak('Two.')
  await p1
  assert.deepEqual(heard, ['on', 'line', 'line'], 'the cut: a new line, no new edge')
  f.end()
  await p2
  assert.equal(await sp.speak('  '), 'silent')
  const pv = sp.preview('As Nova.', 'even')
  f.end()
  await pv
  assert.deepEqual(heard, ['on', 'line', 'line', 'off', 'on', 'line', 'off'])
  stop()
  const p3 = sp.speak('Three.')
  f.end()
  await p3
  assert.deepEqual(heard.slice(-2), ['on', 'off'], 'untold after the way to stop is taken')
})

test('speaking starts at the first sound, not when the line is asked for: a provider line while it is synthesised and decoded is not yet speech; one that fails over to the browser starts when the browser speaks', async () => {
  const f = fakeSynth()
  const p = fakeProvider()
  const sp = new ConciergeSpeaker({ env: f.env, sound: () => true, source: () => ({ voice: p.voice, out: p.out }), store: memoryStore() })
  const told: boolean[] = []
  sp.onSpeaking((on) => { told.push(on) })
  const line = sp.speak('From the provider.')
  assert.deepEqual([sp.speaking, told], [false, []], 'synthesising: nothing is heard yet')
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual(p.played, ['From the provider.'])
  assert.deepEqual([sp.speaking, told], [true, [true]], 'the clip played: speaking')
  p.end()
  assert.equal(await line, 'provider')
  assert.deepEqual(told, [true, false])
  const failing = fakeProvider({ fail: true })
  const sp2 = new ConciergeSpeaker({ env: f.env, sound: () => true, source: () => ({ voice: failing.voice, out: failing.out }), store: memoryStore() })
  const told2: boolean[] = []
  sp2.onSpeaking((on) => { told2.push(on) })
  const fallback = sp2.speak('Through the browser.')
  assert.deepEqual(told2, [], 'the provider failing: nothing heard')
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
  assert.deepEqual([sp2.speaking, told2], [true, [true]], 'the browser speaking it: speaking from here')
  f.end()
  assert.equal(await fallback, 'browser')
  assert.deepEqual(told2, [true, false])
  const cutEarly = sp.speak('Never heard.')
  sp.stop()
  assert.equal(await cutEarly, 'silent')
  assert.deepEqual(told, [true, false], 'a provider line cut before its first sound was never speech')
})

test('a provider line being decoded is not yet speech: it starts when the clip plays, or, the decode refused, when the browser speaks it', async () => {
  const tick = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }
  const f = fakeSynth()
  const p = fakeProvider({ holdDecode: true })
  const sp = new ConciergeSpeaker({ env: f.env, sound: () => true, source: () => ({ voice: p.voice, out: p.out }), store: memoryStore() })
  const told: boolean[] = []
  sp.onSpeaking((on) => { told.push(on) })
  const line = sp.speak('Decoded first.')
  await tick()
  assert.deepEqual([p.said, p.decodes.length, p.played], [['Decoded first.'], 1, []], 'synthesised, now decoding')
  assert.deepEqual([sp.speaking, told], [false, []], 'decoding: nothing is heard yet')
  p.decodes[0].done(true)
  await tick()
  assert.deepEqual([p.played, sp.speaking, told], [['Decoded first.'], true, [true]], 'the clip played: speaking from here')
  p.end()
  assert.equal(await line, 'provider')
  // The decode refused: the browser says it, and speaking starts only then.
  const spoken = f.spoken.length
  const refused = sp.speak('Decoded never.')
  await tick()
  assert.deepEqual([p.decodes.length, sp.speaking, told], [2, false, [true, false]], 'decoding again: not speaking')
  p.decodes[1].done(false)
  await tick()
  assert.deepEqual([p.played.length, f.spoken.length - spoken, f.spoken.at(-1)?.text], [1, 1, 'Decoded never.'], 'the browser speaks it, the provider never played it')
  assert.deepEqual([sp.speaking, told], [true, [true, false, true]], 'speaking from the browser\'s first sound')
  f.end()
  assert.equal(await refused, 'browser')
  assert.deepEqual(told, [true, false, true, false])
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

/** A phone's voices as Android lists them, with underscored language tags; one is a network voice. */
const PHONE: SynthVoice[] = [
  { name: 'Ash', lang: 'en_US', localService: true, default: true },
  { name: 'Birch', lang: 'en_GB', localService: true },
  { name: 'Cedar', lang: 'en-AU', localService: true },
  { name: 'Fern', lang: 'fr_FR', localService: true },
  { name: 'Remote', lang: 'en_US', localService: false },
]

/** A deeper profile than Sloane's, as roster.ts has it. */
const GRAVEL: VoiceProfile = { name: 'gravel', pitch: 0.8, rate: 1.02, blurb: 'deeper, rough-edged' }

/** A passer-by's voice unless told otherwise: no provider, no output, half volume. */
function walker(o: Partial<PersonVoice> = {}): PersonVoice {
  return { profile: GRAVEL, pick: 0, provider: null, out: null, volume: 0.5, ...o }
}

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0)) }

test('an underscored tag (en_US) is English; personVoice: picked by number among the English offline voices, never Sloane\'s while there is another, another language only when no English one is left, never a network voice', () => {
  assert.deepEqual(offlineVoices(PHONE).map((v) => v.name), ['Ash', 'Birch', 'Cedar', 'Fern'], 'en_US and en_GB rank as English')
  assert.deepEqual(offlineVoices([{ name: 'Fern', lang: 'fr_FR', localService: true, default: true }, { name: 'Ash', lang: 'en_US', localService: true }]).map((v) => v.name), ['Ash', 'Fern'])
  assert.deepEqual(offlineVoices([{ name: 'Fern', lang: 'es-ES', localService: true, default: true }, { name: 'Ash', lang: 'EN', localService: true }]).map((v) => v.name), ['Ash', 'Fern'], 'a bare en, any case')
  assert.deepEqual(offlineVoices([{ name: 'Ash', lang: 'eng', localService: true }, { name: 'Fern', lang: 'fr-FR', localService: true, default: true }]).map((v) => v.name), ['Fern', 'Ash'], 'eng is not a region of en')
  assert.equal(pickVoice(PHONE, null)?.name, 'Ash', 'Sloane\'s: the English default')
  assert.deepEqual([0, 1, 2, 3, 7].map((n) => personVoice(PHONE, n, 'Ash')?.name), ['Birch', 'Cedar', 'Birch', 'Cedar', 'Cedar'])
  for (let n = 0; n < 40; n++) {
    const v = personVoice(PHONE, n, 'Ash')
    assert.ok(v && v.name !== 'Ash' && v.name !== 'Fern' && v.localService, `${n}: ${v?.name}`)
    assert.equal(personVoice(PHONE, n, 'Ash'), v, 'the same number, the same voice')
  }
  assert.equal(personVoice(PHONE, 0, 'Birch')?.name, 'Ash', 'Sloane in another voice: that one is avoided instead')
  assert.equal(personVoice(PHONE, 0, null)?.name, 'Ash', 'nothing to avoid')
  assert.equal(personVoice([PHONE[0], PHONE[3]], 0, 'Ash')?.name, 'Fern', 'two voices: never hers, even if the other is not English')
  assert.equal(personVoice([PHONE[0]], 5, 'Ash')?.name, 'Ash', 'one voice: hers is all there is')
  assert.equal(personVoice([PHONE[4]], 0, null), null, 'a network voice is never used')
  assert.equal(personVoice([], 0, null), null)
  assert.equal(personVoice(PHONE, Number.NaN, 'Ash')?.name, 'Birch', 'not a number: the first')
  assert.equal(personVoice(PHONE, -1, 'Ash')?.name, 'Cedar')
  assert.equal(personVoice(PHONE, 0xffffffff, 'Ash')?.name, 'Cedar', 'a whole 32-bit number (skills.ts mix)')
  assert.equal(personVoice(PHONE, 2.9, 'Ash')?.name, 'Birch', 'a fraction is cut to its whole part')
})

test('person: a browser voice of their own, picked by their number, at their profile\'s pitch and rate and their volume; Sloane\'s switch does not apply, the city\'s sound does; nothing to say, an aborted signal or no offline voice is silent', async () => {
  const f = fakeSynth(PHONE)
  let sound = true
  const s = new ConciergeSpeaker({ env: f.env, sound: () => sound, store: memoryStore() })
  assert.equal(s.setOn(false), false)
  const first = s.person('  Evening.   Nice night   for it.  ', walker({ pick: 0, volume: 0.5 }))
  assert.equal(f.spoken.length, 1, 'said with Sloane\'s switch off')
  const u = f.spoken[0]
  assert.deepEqual([u.text, u.voice?.name, u.lang, u.pitch, u.rate, u.volume], ['Evening. Nice night for it.', 'Birch', 'en_GB', 0.8, 1.02, 0.5])
  f.end()
  assert.equal(await first, 'browser')
  assert.equal(s.lastTier, 'browser')
  const second = s.person('Hello.', walker({ pick: 1 }))
  assert.equal(f.spoken[1].voice?.name, 'Cedar', 'another number, another voice')
  f.end()
  await second
  assert.equal(s.setVoice('birch'), 'Birch')
  const third = s.person('Hello.', walker({ pick: 0 }))
  assert.equal(f.spoken[2].voice?.name, 'Ash', 'Sloane now speaks in Birch: the person does not')
  f.end()
  await third
  s.setOn(true)
  const hers = s.speak('Hi.')
  assert.deepEqual([f.spoken[3].voice?.name, f.spoken[3].volume], ['Birch', undefined], 'Sloane\'s own line: her voice, the volume left alone')
  f.end()
  await hers
  for (const [given, set] of [[3, 1], [-1, 0], [Number.NaN, 1], [0.35, 0.35], [1, 1]] as const) {
    const line = s.person('Hello.', walker({ volume: given }))
    assert.equal(f.spoken.at(-1)?.volume, set, `volume ${given}`)
    f.end()
    await line
  }
  const said = f.spoken.length
  sound = false
  assert.equal(await s.person('Quiet.', walker()), 'silent', 'the city\'s sound off')
  sound = true
  assert.equal(await s.person('   ', walker()), 'silent', 'nothing to say')
  const ctl = new AbortController()
  ctl.abort()
  assert.equal(await s.person('Too late.', walker(), ctl.signal), 'silent', 'aborted before it began')
  assert.equal(f.spoken.length, said)
  const remoteOnly = new ConciergeSpeaker({ env: fakeSynth([PHONE[4]]).env, sound: () => true, store: memoryStore() })
  assert.equal(await remoteOnly.person('Hello.', walker()), 'silent', 'no offline voice (a web view)')
  const bare = new ConciergeSpeaker({ env: { synth: null, Utterance: null }, sound: () => true, store: memoryStore() })
  assert.equal(await bare.person('Hello.', walker()), 'silent', 'no speech synthesis at all')
})

test('person: a hired agent\'s own provider voice is asked for by name and played through their own output, never the source\'s; a passer-by, no output or no provider up takes the browser; a failing provider hands the line to the browser; a cut line is said by nobody', async () => {
  const f = fakeSynth(PHONE)
  const p = fakeProvider()
  const asked: (string | undefined)[] = []
  const voice: Voice = { ...p.voice, synthesize: (text, signal, v) => { asked.push(v); return p.voice.synthesize(text, signal) } }
  const head = fakeProvider()
  let source: { voice: Voice; out: typeof p.out } | null = { voice, out: p.out }
  const s = new ConciergeSpeaker({ env: f.env, sound: () => true, source: () => source, store: memoryStore() })
  s.setOn(false)
  const captions: boolean[] = []
  const crew = walker({ provider: 'af_sky', out: head.out, caption: (on) => { captions.push(on) } })
  const line = s.person('Boss.', crew)
  await settle()
  assert.deepEqual(asked, ['af_sky'], 'their own voice, by name, with Sloane\'s switch off')
  assert.deepEqual(head.played, ['Boss.'], 'played at their head')
  assert.deepEqual(p.played, [], 'not through the source\'s output at the player\'s head')
  assert.equal(f.spoken.length, 0)
  head.end()
  assert.equal(await line, 'provider')
  assert.equal(s.lastTier, 'provider')
  assert.deepEqual(captions, [], 'the soundscape captions the provider\'s audio itself')
  assert.equal(p.voice.settings().voice, 'v1', 'the provider\'s own choice untouched')
  // A passer-by has no provider voice: the browser, and the provider is never asked.
  const passing = s.person('Evening.', walker({ out: head.out }))
  assert.equal(f.spoken.length, 1)
  f.end()
  assert.equal(await passing, 'browser')
  // A provider voice with nowhere at their head to play it: the browser, never the source's output.
  const nowhere = s.person('Evening.', walker({ provider: 'af_sky' }))
  assert.equal(f.spoken.length, 2)
  f.end()
  assert.equal(await nowhere, 'browser')
  // No provider up yet (the onboarding): the browser.
  source = null
  const early = s.person('Evening.', crew)
  assert.equal(f.spoken.length, 3)
  f.end()
  assert.equal(await early, 'browser')
  assert.deepEqual(asked, ['af_sky'], 'the provider was asked once only')
  assert.deepEqual(captions, [true, false], 'the browser line captioned')
  // The provider fails: the browser says it, captioned.
  const failing = fakeProvider({ fail: true })
  source = { voice: failing.voice, out: failing.out }
  const fails = s.person('Still here.', crew)
  await settle()
  assert.deepEqual([failing.said, f.spoken.length, f.spoken.at(-1)?.text], [['Still here.'], 4, 'Still here.'])
  f.end()
  assert.equal(await fails, 'browser')
  assert.deepEqual(captions, [true, false, true, false])
  // Cut while their clip plays: it fades, and the line ends. Cut on its way: nobody says it.
  source = { voice, out: p.out }
  const playing = s.person('Boss.', crew)
  await settle()
  assert.equal(head.played.length, 2)
  s.stop()
  assert.equal(head.stops, 1)
  assert.equal(await playing, 'provider')
  const cut = s.person('Never heard.', crew)
  s.stop()
  assert.equal(await cut, 'silent')
  assert.deepEqual([head.played.length, f.spoken.length, p.played.length], [2, 4, 0])
})

test('person: one mouth with Sloane; speaking, onSpeaking and onLine cover a person\'s line; stop and an abort cut it; a person\'s line cuts hers and hers cuts theirs; caption brackets a browser line, and a caption that throws does not stop it', async () => {
  const f = fakeSynth(PHONE)
  const s = new ConciergeSpeaker({ env: f.env, sound: () => true, store: memoryStore() })
  const heard: string[] = []
  s.onSpeaking((on) => { heard.push(on ? 'on' : 'off') })
  s.onLine(() => { heard.push('line') })
  const v = walker({ caption: (on) => { heard.push(on ? 'caption' : 'uncaption') } })
  const whole = ['on', 'line', 'caption', 'uncaption', 'off']
  const one = s.person('One.', v)
  assert.equal(s.speaking, true, 'speaking from the first sound')
  assert.deepEqual(heard, ['on', 'line', 'caption'], 'the edge, the line, then the caption')
  f.end()
  assert.equal(await one, 'browser')
  assert.equal(s.speaking, false)
  assert.deepEqual(heard, whole, 'the caption ends before speaking does')
  heard.length = 0
  const cancelled = f.cancelled
  const two = s.person('Two.', v)
  s.stop()
  assert.equal(await two, 'browser')
  assert.deepEqual([f.cancelled - cancelled, heard], [1, whole], 'stop cuts a person\'s line')
  heard.length = 0
  const ctl = new AbortController()
  const three = s.person('Three.', v, ctl.signal)
  ctl.abort()
  assert.equal(await three, 'browser')
  assert.deepEqual([f.cancelled - cancelled, heard], [2, whole], 'an abort cuts it')
  heard.length = 0
  const hers = s.speak('Mine first.')
  const theirs = s.person('No, mine.', v)
  assert.equal(await hers, 'browser')
  assert.equal(f.cancelled - cancelled, 3, 'a person\'s line cuts Sloane\'s')
  assert.deepEqual(heard, ['on', 'line', 'line', 'caption'], 'one edge across the cut, a new line for the echo guard')
  assert.equal(f.spoken.at(-1)?.text, 'No, mine.')
  const again = s.speak('Excuse me.')
  assert.equal(await theirs, 'browser')
  assert.equal(f.cancelled - cancelled, 4, 'Sloane\'s line cuts a person\'s')
  assert.deepEqual(heard, ['on', 'line', 'line', 'caption', 'line', 'uncaption'])
  assert.equal(s.speaking, true)
  f.end()
  assert.equal(await again, 'browser')
  assert.deepEqual([s.speaking, heard.at(-1)], [false, 'off'])
  const loud = s.person('Still said.', walker({ caption: () => { throw new Error('a caption that fails') } }))
  assert.equal(f.spoken.at(-1)?.text, 'Still said.')
  f.end()
  assert.equal(await loud, 'browser')
})
