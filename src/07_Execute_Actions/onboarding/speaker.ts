// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is Sloane's spoken voice: how a line of the concierge (a greeting, an onboarding turn,
 * a quiet nudge) is said aloud, and in what. Two tiers, chosen per line, never a download: the operator's speech
 * provider when one has a voice chosen (09_Cognition/localSpeech.ts: a speech server on this machine, or ElevenLabs
 * through a gateway on it; the audio is placed at the player's own head by the soundscape, so Sloane is in the
 * earbuds, not on the street), else the browser's own speech synthesis in one of its offline voices only (a voice the
 * browser would fetch from a network service is never used: the page is air-gapped), shaped by Sloane's voice profile
 * (08_Swarm/roster.ts `velvet`). Neither tier is a neural voice bundled with the page: the page carries no model, so
 * the browser tier sounds like the operating system's voices and no better, and says so in the console (`sloane`).
 * Sloane speaks only while the city's sound is on and the switch is on (kept between visits); nothing is said while
 * the sound is off, and a line stops the moment the next one starts or its signal aborts. Pure where it can be: the
 * tier choice, the voice pick and the settings are functions a Node test runs; only `ConciergeSpeaker` touches the
 * browser's objects, and it takes them as arguments.
 * What breaks if it is removed? Sloane is text on a card: the onboarding and the nudges make no sound.
 */
import type { SpeechClip, Utterance, Voice } from '../operator.ts'
import type { ConciergeBridge } from '../terminal/bridge.ts'
import { CONCIERGE_PROFILE, voiceProfile, type VoiceProfile } from '../../08_Swarm/roster.ts'

/** A voice the browser's speech synthesis offers (SpeechSynthesisVoice, by the fields read here). */
export interface SynthVoice {
  readonly name: string
  readonly lang: string
  /** Whether the voice is synthesised on this machine (a remote one needs the network: never used). */
  readonly localService: boolean
  readonly default?: boolean
}

/** An utterance as the browser speaks it (SpeechSynthesisUtterance, by the fields written here). */
export interface UtteranceLike {
  text: string
  voice: SynthVoice | null
  pitch: number
  rate: number
  lang: string
  onend: ((e: unknown) => void) | null
  onerror: ((e: unknown) => void) | null
}

/** The browser's speech synthesis (window.speechSynthesis), by what is used of it. */
export interface SynthLike {
  getVoices(): readonly SynthVoice[]
  speak(u: UtteranceLike): void
  cancel(): void
  addEventListener?(type: 'voiceschanged', fn: () => void): void
  removeEventListener?(type: 'voiceschanged', fn: () => void): void
}

/** What the page has of speech synthesis, or nulls. */
export interface SynthEnv {
  synth: SynthLike | null
  Utterance: (new (text: string) => UtteranceLike) | null
}

export function synthEnv(g: object = globalThis): SynthEnv {
  const w = g as { speechSynthesis?: unknown; SpeechSynthesisUtterance?: unknown }
  const synth = w.speechSynthesis
  const U = w.SpeechSynthesisUtterance
  return {
    synth: typeof synth === 'object' && synth !== null && typeof (synth as SynthLike).speak === 'function' ? (synth as SynthLike) : null,
    Utterance: typeof U === 'function' ? (U as new (text: string) => UtteranceLike) : null,
  }
}

/** The voices synthesised on this machine, English first (the lines are English), each language's default first. */
export function offlineVoices(voices: readonly SynthVoice[]): SynthVoice[] {
  const local = voices.filter((v) => v.localService === true)
  const rank = (v: SynthVoice): number => (/^en\b/i.test(v.lang) ? 0 : 1) * 2 + (v.default ? 0 : 1)
  return [...local].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * The voice to speak with: the one named (by its whole name, or a word of it, case-insensitively) among the offline
 * voices, else the first offline voice; null when the browser has none it can synthesise here.
 */
export function pickVoice(voices: readonly SynthVoice[], prefer: string | null): SynthVoice | null {
  const local = offlineVoices(voices)
  if (!local.length) return null
  if (prefer) {
    const p = prefer.trim().toLowerCase()
    const exact = local.find((v) => v.name.toLowerCase() === p)
    if (exact) return exact
    const part = local.find((v) => v.name.toLowerCase().includes(p))
    if (part) return part
  }
  return local[0]
}

/** Where Sloane's own switch and voice are kept between visits. */
export const CONCIERGE_KEY = 'civic-simulation:concierge:v1'

export interface ConciergeSettings {
  /** Whether Sloane speaks at all (the city's sound must be on as well). */
  readonly on: boolean
  /** The browser voice preferred, by name, or null for the first offline one. */
  readonly voice: string | null
}
export const CONCIERGE_DEFAULTS: ConciergeSettings = Object.freeze({ on: true, voice: null })

export interface KeyStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

function browserStore(): KeyStore | null {
  try { return (globalThis as { localStorage?: KeyStore }).localStorage ?? null } catch { return null }
}

export function loadConciergeSettings(store: KeyStore | null = browserStore()): ConciergeSettings {
  if (!store) return CONCIERGE_DEFAULTS
  try {
    const raw = store.getItem(CONCIERGE_KEY)
    if (typeof raw !== 'string' || !raw || raw.length > 256) return CONCIERGE_DEFAULTS
    const d = JSON.parse(raw) as { v?: unknown; on?: unknown; voice?: unknown }
    if (!d || typeof d !== 'object' || d.v !== 1) return CONCIERGE_DEFAULTS
    const voice = typeof d.voice === 'string' && d.voice.trim() && !/[\r\n]/.test(d.voice) ? d.voice.trim().slice(0, 64) : null
    return Object.freeze({ on: d.on !== false, voice })
  } catch { return CONCIERGE_DEFAULTS }
}

export function saveConciergeSettings(s: ConciergeSettings, store: KeyStore | null = browserStore()): void {
  if (!store) return
  try { store.setItem(CONCIERGE_KEY, JSON.stringify({ v: 1, on: s.on, voice: s.voice })) } catch { /* storage unavailable */ }
}

/** Which tier says a line. */
export type Tier = 'provider' | 'browser' | 'silent'

/**
 * The tier for a line: silent while the sound or the switch is off; the speech provider when it has a voice chosen
 * and the soundscape can place the audio; else the browser's synthesis when it has an offline voice; else silent.
 */
export function tierFor(o: { sound: boolean; on: boolean; providerVoice: string | null; placed: boolean; browserVoices: number }): Tier {
  if (!o.sound || !o.on) return 'silent'
  if (o.providerVoice !== null && o.placed) return 'provider'
  if (o.browserVoices > 0) return 'browser'
  return 'silent'
}

/** Where the provider tier's audio is heard: the soundscape at the player's own head (engine.ts conciergeOut). */
export interface ConciergeOut {
  decode(bytes: ArrayBuffer): Promise<SpeechClip>
  play(clip: SpeechClip, text: string): Utterance
}

export interface SpeakerOptions {
  /** The browser's synthesis (synthEnv()); nulls for a page without it. */
  env: SynthEnv
  /** Whether the city's sound is on right now. */
  sound(): boolean
  /** The operator's voice and the soundscape that places it, once the city is up; null before, or with no engine. */
  source?(): { voice: Voice; out: ConciergeOut } | null
  store?: KeyStore | null
}

/** Sloane's mouth on the page: `speak` says a line in the best tier available, `settings` and the setters are the console's. */
export class ConciergeSpeaker {
  readonly #env: SynthEnv
  readonly #sound: () => boolean
  readonly #source: () => { voice: Voice; out: ConciergeOut } | null
  readonly #store: KeyStore | null | undefined
  #settings: ConciergeSettings
  /** Cuts the line being said. */
  #cut: (() => void) | null = null
  /** Counts the lines cut, so a line cut while its audio was still coming is not said by the browser instead. */
  #cuts = 0
  /** The last tier that spoke, for the console. */
  #last: Tier = 'silent'

  constructor(o: SpeakerOptions) {
    this.#env = o.env
    this.#sound = o.sound
    this.#source = o.source ?? (() => null)
    this.#store = o.store
    this.#settings = loadConciergeSettings(o.store === undefined ? browserStore() : o.store)
  }

  settings(): ConciergeSettings { return this.#settings }
  get lastTier(): Tier { return this.#last }

  setOn(on: boolean): boolean {
    this.#settings = Object.freeze({ ...this.#settings, on: on === true })
    this.#keep()
    if (!on) this.stop()
    return this.#settings.on
  }

  /** Prefers a browser voice by name (or clears the preference with null); returns the voice that would be used, by name. */
  setVoice(name: string | null): string | null {
    const voice = name === null ? null : name.trim() ? name.trim().slice(0, 64) : null
    this.#settings = Object.freeze({ ...this.#settings, voice })
    this.#keep()
    return pickVoice(this.#env.synth?.getVoices() ?? [], voice)?.name ?? null
  }

  /** The browser's offline voices, by name. */
  browserVoices(): string[] { return offlineVoices(this.#env.synth?.getVoices() ?? []).map((v) => v.name) }

  /** The tier a line would take now. */
  tier(): Tier {
    const src = this.#source()
    const providerVoice = src?.voice.settings().voice ?? null
    return tierFor({ sound: this.#sound(), on: this.#settings.on, providerVoice, placed: src !== null, browserVoices: this.browserVoices().length })
  }

  /** Says `text` (cutting any line still being said) and resolves with the tier that said it, when it has ended, was cut, or could not be said. */
  async speak(text: string, signal?: AbortSignal): Promise<Tier> {
    this.stop()
    const cuts = this.#cuts
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line || signal?.aborted) return 'silent'
    let tier = this.tier()
    if (tier === 'provider') {
      try {
        await this.#provider(line, signal)
        this.#last = 'provider'
        return 'provider'
      } catch {
        // The provider failed (down, refused, no such voice): the browser's voice, so the line is still heard. A line
        // cut on the way (the next line, an abort) is not said at all, nor one whose sound went off meanwhile (the
        // soundscape refusing to decode is often why the provider failed).
        if (signal?.aborted || cuts !== this.#cuts) return 'silent'
        tier = this.#sound() && this.#settings.on && this.browserVoices().length ? 'browser' : 'silent'
      }
    }
    if (tier === 'browser') {
      await this.#browser(line, signal)
      this.#last = 'browser'
      return 'browser'
    }
    this.#last = 'silent'
    return 'silent'
  }

  /**
   * Says `text` in an agent's voice, for the card's Hear button: a voice profile (roster.ts) shapes the browser's
   * offline voice; a provider voice name is said by the speech provider at the player's head, or by the browser's
   * voice when the provider cannot. Sloane's switch does not apply (the visitor asked to hear it); the city's sound does.
   */
  async preview(text: string, voice: string): Promise<Tier> {
    this.stop()
    const cuts = this.#cuts
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line || !this.#sound()) return 'silent'
    const profile = voiceProfile(voice)
    if (profile === null && this.#source() !== null) {
      try {
        await this.#provider(line, undefined, voice)
        this.#last = 'provider'
        return 'provider'
      } catch {
        if (cuts !== this.#cuts) return 'silent'
      }
    }
    if (!this.#sound() || !this.browserVoices().length) return 'silent'
    await this.#browser(line, undefined, profile ?? voiceProfile('even'))
    this.#last = 'browser'
    return 'browser'
  }

  stop(): void {
    this.#cuts++
    const cut = this.#cut
    this.#cut = null
    cut?.()
  }

  async #provider(line: string, signal?: AbortSignal, voice?: string): Promise<void> {
    const src = this.#source()
    if (!src) throw new Error('no provider')
    const ctl = new AbortController()
    const onAbort = () => ctl.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    // This line's own cut: a line that ends after the next one began must not clear the next one's.
    const own = () => ctl.abort(new DOMException('cut', 'AbortError'))
    this.#cut = own
    try {
      const bytes = await src.voice.synthesize(line, ctl.signal, voice)
      ctl.signal.throwIfAborted()
      const clip = await src.out.decode(bytes)
      ctl.signal.throwIfAborted()
      const u = src.out.play(clip, line)
      // Cut or aborted while it plays: the clip fades out, and `ended` resolves (operator.ts Utterance).
      ctl.signal.addEventListener('abort', () => u.stop(), { once: true })
      await u.ended
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.#cut === own) this.#cut = null
    }
  }

  #browser(line: string, signal?: AbortSignal, profile: VoiceProfile | null = voiceProfile(CONCIERGE_PROFILE)): Promise<void> {
    const { synth, Utterance } = this.#env
    if (!synth || !Utterance) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const u = new Utterance(line)
      u.voice = pickVoice(synth.getVoices(), this.#settings.voice)
      u.lang = u.voice?.lang ?? 'en'
      u.pitch = profile?.pitch ?? 1
      u.rate = profile?.rate ?? 1
      let done = false
      const finish = () => {
        if (done) return
        done = true
        signal?.removeEventListener('abort', cut)
        if (this.#cut === cut) this.#cut = null
        resolve()
      }
      const cut = () => {
        if (done) return
        try { synth.cancel() } catch { /* nothing to cancel */ }
        finish()
      }
      u.onend = finish
      u.onerror = finish
      this.#cut = cut
      signal?.addEventListener('abort', cut, { once: true })
      try { synth.speak(u) } catch { finish() }
    })
  }

  #keep(): void { saveConciergeSettings(this.#settings, this.#store === undefined ? browserStore() : this.#store) }
}

/** The console's `sloane` command over the speaker (terminal/bridge.ts ConciergeBridge). */
export function conciergeBridge(speaker: ConciergeSpeaker): ConciergeBridge {
  const tierLine = (t: Tier): string => (t === 'provider' ? "the speech provider's voice (say), at your own head" : t === 'browser' ? "the browser's own offline voice (no neural model is bundled with the page)" : 'silent (sound off, the switch off, or no offline voice on this machine)')
  return Object.freeze({
    status: (): string[] => {
      const s = speaker.settings()
      const voices = speaker.browserVoices()
      return [
        `switch    ${s.on ? 'on' : 'off'}  (sloane on|off)`,
        `tier      ${tierLine(speaker.tier())}`,
        `voice     ${s.voice ?? 'the first offline voice'}${voices.length ? `  (sloane voice <name>; ${voices.length} offline voice${voices.length === 1 ? '' : 's'}: sloane voices)` : '  (this browser has no offline voice)'}`,
        `profile   ${CONCIERGE_PROFILE}: ${voiceProfile(CONCIERGE_PROFILE)?.blurb ?? ''}`,
      ]
    },
    on: (on: boolean): string => (speaker.setOn(on) ? 'on: Sloane speaks while the sound is on' : 'off: Sloane is text on the card'),
    voice: (name: string): string => {
      const picked = speaker.setVoice(name.trim() ? name : null)
      return picked === null ? 'no offline voice on this machine: the provider tier (say voice <name>) still speaks' : `${picked}${name.trim() && picked.toLowerCase() !== name.trim().toLowerCase() ? `  (the nearest to '${name.trim()}')` : ''}`
    },
    voices: (): string[] => {
      const v = speaker.browserVoices()
      return v.length ? v : ['no offline voice on this machine']
    },
    say: (text: string): Promise<string> => speaker.speak(text).then((t) => `said by ${tierLine(t)}`),
  })
}
