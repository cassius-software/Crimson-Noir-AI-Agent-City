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
 * The people the player stops to talk with in the street (07_Execute_Actions/talk.ts) speak through this same mouth
 * (`person`), so one line is ever said at a time and the microphone's echo guard and barge-in cover them as they cover
 * Sloane. A person is never heard in her voice: a hired agent with a provider voice of their own is placed at their
 * head, and anyone else speaks in a browser voice other than hers, quieter with distance.
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
  /** From 0 to 1. Written only for a person in the street, quieter with distance; Sloane's lines leave the browser's 1. */
  volume?: number
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

/**
 * An English voice's language tag: `en` alone, or followed by a region after a hyphen or, as Android writes it
 * (`en_US`), an underscore. A word boundary is not enough there, because the underscore is a word character.
 */
const ENGLISH = /^en(?:[-_]|$)/i

/** The voices synthesised on this machine, English first (the lines are English), each language's default first. */
export function offlineVoices(voices: readonly SynthVoice[]): SynthVoice[] {
  const local = voices.filter((v) => v.localService === true)
  const rank = (v: SynthVoice): number => (ENGLISH.test(v.lang) ? 0 : 1) * 2 + (v.default ? 0 : 1)
  return [...local].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
}

/**
 * The browser voice a person in the street speaks in (ConciergeSpeaker.person): one of the offline voices, chosen by
 * `pick`, a fixed number per person (08_Swarm/talkLines.ts talkWho), so each person keeps one voice and two people
 * side by side are likely to differ. It is never `avoid`, the voice Sloane speaks in (by name), while the machine has
 * two offline voices or more, so a passer-by is not heard as her. English voices come first, because the lines are
 * English; another language's voice is used only when no English one is left. Null when the browser has no voice it
 * can synthesise here (a network voice is never used, as for Sloane).
 */
export function personVoice(voices: readonly SynthVoice[], pick: number, avoid: string | null): SynthVoice | null {
  const local = offlineVoices(voices)
  if (!local.length) return null
  const others = local.length >= 2 && avoid !== null ? local.filter((v) => v.name !== avoid) : local
  const pool = others.length ? others : local
  const english = pool.filter((v) => ENGLISH.test(v.lang))
  const from = english.length ? english : pool
  return from[Number.isFinite(pick) ? Math.abs(Math.trunc(pick)) % from.length : 0]
}

/** A loudness the browser accepts: from 0 to 1, and the browser's own 1 for anything that is not a number. */
const loudness = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1)

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

/**
 * How a person in the street is heard (ConciergeSpeaker.person). talk.ts builds it from the person's TalkVoice
 * (08_Swarm/talkLines.ts). `profile` shapes the browser voice's pitch and rate and is never Sloane's own. `pick`
 * chooses among the offline voices (personVoice). `provider` is a hired agent's own speech-provider voice, and null
 * for anyone else, so a passer-by never speaks in the operator's provider voice or spends its quota. `out` is where
 * that provider audio sounds: the engine's output at the person's own head. With no `out` the provider is not used,
 * because the speaker's own source plays at the player's head and captions the line as Sloane's. `volume` is the
 * browser voice's loudness from 0 to 1: that voice cannot be placed in space, so the caller makes it quieter with
 * distance (anything out of range is held to 0 to 1, and anything not a number is 1). `caption` is told true as a
 * browser line starts and false as it ends, so the city can caption where the voice comes from; the provider tier's
 * audio is captioned by the soundscape that plays it.
 */
export interface PersonVoice {
  readonly profile: VoiceProfile
  readonly pick: number
  readonly provider: string | null
  readonly out: ConciergeOut | null
  readonly volume: number
  readonly caption?: (on: boolean) => void
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

/**
 * Sloane's mouth on the page: `speak` says a line in the best tier available, `person` says a line for someone in
 * the street through the same mouth, `settings` and the setters are the console's.
 */
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
  /** Lines being said aloud now: 0 or 1, but for the instant a new line cuts the last. */
  #aloud = 0
  /** Told as Sloane starts (true) and stops (false) speaking aloud, once per change (onSpeaking). */
  readonly #ears = new Set<(on: boolean) => void>()
  /** Told at each line's first sound, a line that cuts the one still playing included (onLine). */
  readonly #lines = new Set<() => void>()

  constructor(o: SpeakerOptions) {
    this.#env = o.env
    this.#sound = o.sound
    this.#source = o.source ?? (() => null)
    this.#store = o.store
    this.#settings = loadConciergeSettings(o.store === undefined ? browserStore() : o.store)
  }

  settings(): ConciergeSettings { return this.#settings }
  get lastTier(): Tier { return this.#last }
  /** Whether a line is being said aloud now (either tier). */
  get speaking(): boolean { return this.#aloud > 0 }

  /**
   * Tells `fn` as Sloane starts (true) and stops (false) speaking aloud, once per change: the microphone's barge-in
   * and its pill's word (App wires it to 04_Connect_Hardware/microphone.ts setSpeaking). Returns the way to stop.
   */
  onSpeaking(fn: (on: boolean) => void): () => void {
    this.#ears.add(fn)
    return () => { this.#ears.delete(fn) }
  }

  /**
   * Tells `fn` at each line's first sound, after onSpeaking's edge when there is one. A line that cuts the one still
   * playing is no edge (speaking stays true across the cut), so this is how the microphone learns her echo afresh for
   * it (App wires it to 04_Connect_Hardware/microphone.ts newLine). Returns the way to stop.
   */
  onLine(fn: () => void): () => void {
    this.#lines.add(fn)
    return () => { this.#lines.delete(fn) }
  }

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
    if (tier === 'silent') {
      this.#last = 'silent'
      return 'silent'
    }
    return this.#saying(async (onAir) => {
      if (tier === 'provider') {
        try {
          await this.#provider(line, signal, undefined, onAir)
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
        await this.#browser(line, signal, undefined, onAir)
        this.#last = 'browser'
        return 'browser'
      }
      this.#last = 'silent'
      return 'silent'
    })
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
    return this.#saying(async (onAir) => {
      if (profile === null && this.#source() !== null) {
        try {
          await this.#provider(line, undefined, voice, onAir)
          this.#last = 'provider'
          return 'provider'
        } catch {
          if (cuts !== this.#cuts) return 'silent'
        }
      }
      if (!this.#sound() || !this.browserVoices().length) return 'silent'
      await this.#browser(line, undefined, profile ?? voiceProfile('even'), onAir)
      this.#last = 'browser'
      return 'browser'
    })
  }

  /**
   * Says `text` as a person in the street (07_Execute_Actions/talk.ts), cutting any line still being said, Sloane's
   * included, as her next line cuts theirs. It is one mouth: `speaking`, onSpeaking and onLine, and the microphone's
   * echo guard and barge-in that hang on them, cover people exactly as they cover her. Like `preview`, the city's
   * sound must be on and Sloane's own switch does not apply, because the switch is hers alone. The tiers: a hired
   * agent's own provider voice (`v.provider`) played through `v.out` at their head, when the provider is up; else a
   * browser offline voice of their own (personVoice by `v.pick`, never Sloane's while there is another), shaped by
   * `v.profile`, at `v.volume`, with `v.caption` told as it starts and ends; else silent, and the text on screen
   * carries everything. A provider that fails hands the line to the browser voice, unless it was cut on the way.
   * Resolves with the tier that said it, when it has ended, was cut, or could not be said.
   */
  async person(text: string, v: PersonVoice, signal?: AbortSignal): Promise<Tier> {
    this.stop()
    const cuts = this.#cuts
    const line = text.replace(/\s+/g, ' ').trim()
    if (!line || signal?.aborted || !this.#sound()) return 'silent'
    const provider = v.provider !== null && v.out !== null && this.#source() !== null ? v.provider : null
    if (provider === null && !this.browserVoices().length) return 'silent'
    return this.#saying(async (onAir) => {
      if (provider !== null) {
        try {
          await this.#provider(line, signal, provider, onAir, v.out)
          this.#last = 'provider'
          return 'provider'
        } catch {
          // As in speak: a line cut or aborted on the way is not said at all, nor one whose sound went off meanwhile.
          if (signal?.aborted || cuts !== this.#cuts) return 'silent'
        }
      }
      if (!this.#sound() || !this.browserVoices().length) return 'silent'
      let shown = false
      const caption = (on: boolean) => { try { v.caption?.(on) } catch { /* a listener's fault is not the line's */ } }
      const start = () => {
        onAir()
        if (shown) return
        shown = true
        caption(true)
      }
      try {
        await this.#browser(line, signal, v.profile, start, v.pick, v.volume)
      } finally {
        if (shown) caption(false)
      }
      this.#last = 'browser'
      return 'browser'
    })
  }

  /**
   * Runs a line as speech: `speaking` is true from its first sound to its end, and onSpeaking is told at each edge. The
   * first sound is when the tier hands its audio to the output (`onAir`: the provider's clip played, the browser's
   * utterance spoken), not when the line is asked for: a provider's voice is synthesised and decoded first, and may
   * fail over to the browser's, and the microphone learns her echo from the first sound (vad.ts echoFrames).
   */
  async #saying<T>(run: (onAir: () => void) => Promise<T>): Promise<T> {
    let sounding = false
    const onAir = () => {
      if (sounding) return
      sounding = true
      if (++this.#aloud === 1) this.#tell(true)
      for (const fn of this.#lines) { try { fn() } catch { /* a listener's fault is not the line's */ } }
    }
    try {
      return await run(onAir)
    } finally {
      if (sounding && --this.#aloud === 0) this.#tell(false)
    }
  }

  #tell(on: boolean): void {
    for (const fn of this.#ears) { try { fn(on) } catch { /* a listener's fault is not the line's */ } }
  }

  stop(): void {
    this.#cuts++
    const cut = this.#cut
    this.#cut = null
    cut?.()
  }

  /** Says `line` in the provider's voice (or `voice`), played through `out` when given (a person's head), else at the player's. */
  async #provider(line: string, signal?: AbortSignal, voice?: string, onAir: () => void = () => {}, out?: ConciergeOut | null): Promise<void> {
    const src = this.#source()
    if (!src) throw new Error('no provider')
    const sink = out ?? src.out
    const ctl = new AbortController()
    const onAbort = () => ctl.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    // This line's own cut: a line that ends after the next one began must not clear the next one's.
    const own = () => ctl.abort(new DOMException('cut', 'AbortError'))
    this.#cut = own
    try {
      const bytes = await src.voice.synthesize(line, ctl.signal, voice)
      ctl.signal.throwIfAborted()
      const clip = await sink.decode(bytes)
      ctl.signal.throwIfAborted()
      onAir()
      const u = sink.play(clip, line)
      // Cut or aborted while it plays: the clip fades out, and `ended` resolves (operator.ts Utterance).
      ctl.signal.addEventListener('abort', () => u.stop(), { once: true })
      await u.ended
    } finally {
      signal?.removeEventListener('abort', onAbort)
      if (this.#cut === own) this.#cut = null
    }
  }

  /**
   * Says `line` in a browser offline voice: Sloane's (her preference, or the first), or with `pick` a person's own
   * (personVoice, never hers while there is another); `volume` is written only when given.
   */
  #browser(line: string, signal?: AbortSignal, profile: VoiceProfile | null = voiceProfile(CONCIERGE_PROFILE), onAir: () => void = () => {}, pick?: number, volume?: number): Promise<void> {
    const { synth, Utterance } = this.#env
    if (!synth || !Utterance) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const u = new Utterance(line)
      const voices = synth.getVoices()
      const hers = pickVoice(voices, this.#settings.voice)
      u.voice = pick === undefined ? hers : personVoice(voices, pick, hers?.name ?? null)
      u.lang = u.voice?.lang ?? 'en'
      u.pitch = profile?.pitch ?? 1
      u.rate = profile?.rate ?? 1
      if (volume !== undefined) u.volume = loudness(volume)
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
      onAir()
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
