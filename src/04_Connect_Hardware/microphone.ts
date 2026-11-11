// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the microphone as the page holds it: opened on the visitor's own tap or key (the
 * browser asks its permission then), closed by one tap, one key (V), one stick click (R3) or the Menu, and never open
 * without the pill on the HUD saying so. It owns the one stream, a Web Audio graph of its own (a media-stream source
 * into the voice activity detector, vad.ts, in an AudioWorklet where the browser has one, or an AnalyserNode polled
 * from the page where it does not; nothing is connected to the speakers, so the visitor never hears themselves),
 * the level and the speech state the pill draws, the switch kept between visits (MIC_KEY: the visitor who turned the
 * microphone on and left it on finds it on again; one who muted it finds it off), and the barge-in signal: speech
 * starting while the page itself is speaking. The audio never leaves this object: no recording, no network, no
 * transcript here (the on-device recogniser, 08_Swarm/recruitment.ts, opens its own session beside it; App wires the
 * two together). Mute releases the device (the browser's own indicator goes out with the pill's), it does not merely
 * silence a track: a privacy mute the visitor can trust. Pure where it can be: the settings, the phase words and the
 * meter are functions a Node test runs; `Microphone` takes the browser's objects as arguments.
 * MIC_OPEN_BY_DEFAULT is the one line that decides whether a first visit opens the microphone at boot: it ships true
 * (the owner's choice, 2026-11-07), so the browser asks its permission as the city starts; a saved switch (the visitor's
 * own choice: left on, or muted) wins over it either way, so a mute holds across visits.
 * What breaks if it is removed? No microphone pill, no voice to Sloane, no barge-in: the on-device recogniser still
 * answers `recruit listen` in the console, with its own small MIC chip.
 */
import { VAD, VAD_PROCESSOR, VadCore, vadFrame, vadWorkletSource, type VadMessage } from './vad.ts'

/**
 * Whether a visit with no kept switch opens the microphone as the city starts, without a tap. True (the owner's word,
 * 2026-11-07): the browser asks its permission as the city starts and the pill reads Listening once it is given (Mic
 * blocked when it is refused, and then again on the next visit, until the visitor presses the pill or mutes). A visitor
 * who muted it finds it muted on the next visit, and one who left it on finds it on, whatever this says (their choice,
 * kept under MIC_KEY). False would make a first visit wait for a press. Flip it here, nowhere else.
 */
export const MIC_OPEN_BY_DEFAULT = true

/** Where the switch is kept between visits. */
export const MIC_KEY = 'civic-simulation:voice:v1'

/** The microphone as the visitor sees it. */
export type MicPhase = 'off' | 'opening' | 'listening' | 'speech' | 'muted' | 'blocked' | 'unavailable' | 'error'

export interface MicState { phase: MicPhase; detail: string }

export interface VoiceSettings {
  /** The visitor turned the microphone on and has not muted it: it opens again on the next visit. */
  readonly on: boolean
  /** The visitor chose (opened it, or muted it) and the choice is kept: `on` decides the boot, not the default. */
  readonly kept: boolean
}
export const VOICE_DEFAULTS: VoiceSettings = Object.freeze({ on: false, kept: false })

export interface KeyStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

function browserStore(): KeyStore | null {
  try { return (globalThis as { localStorage?: KeyStore }).localStorage ?? null } catch { return null }
}

export function loadVoiceSettings(store: KeyStore | null = browserStore()): VoiceSettings {
  if (!store) return VOICE_DEFAULTS
  try {
    const raw = store.getItem(MIC_KEY)
    if (typeof raw !== 'string' || !raw || raw.length > 64) return VOICE_DEFAULTS
    const d = JSON.parse(raw) as { v?: unknown; on?: unknown }
    if (!d || typeof d !== 'object' || d.v !== 1 || typeof d.on !== 'boolean') return VOICE_DEFAULTS
    return Object.freeze({ on: d.on, kept: true })
  } catch { return VOICE_DEFAULTS }
}

export function saveVoiceSettings(s: VoiceSettings, store: KeyStore | null = browserStore()): void {
  if (!store) return
  try { store.setItem(MIC_KEY, JSON.stringify({ v: 1, on: s.on === true })) } catch { /* storage unavailable */ }
}

/** Whether the microphone opens at boot: the kept switch (left on, or muted), else the one line above. */
export function opensAtBoot(s: VoiceSettings, byDefault = MIC_OPEN_BY_DEFAULT): boolean {
  return s.kept ? s.on : byDefault
}

/** The pill's word for a phase (Sloane speaking is the host's word, not the microphone's: pillWord takes it). */
export function phaseWord(phase: MicPhase): string {
  switch (phase) {
    case 'off': return 'Mic off'
    case 'opening': return 'Mic opening'
    case 'listening': return 'Listening'
    case 'speech': return 'Hearing you'
    case 'muted': return 'Muted'
    case 'blocked': return 'Mic blocked'
    case 'unavailable': return 'No mic'
    case 'error': return 'Mic error'
  }
}

/** The pill's word: the page speaking (Sloane) over an open microphone reads Speaking; else the phase's word. */
export function pillWord(phase: MicPhase, speaking: boolean): string {
  return speaking && (phase === 'listening' || phase === 'speech') ? 'Speaking' : phaseWord(phase)
}

/** Whether the device is open (the pill shows the meter and the browser shows its own indicator). */
export function isOpen(phase: MicPhase): boolean {
  return phase === 'listening' || phase === 'speech'
}

/** What a tap on the pill does in a phase: open it, or mute it. */
export function tapMeans(phase: MicPhase): 'open' | 'mute' {
  return isOpen(phase) || phase === 'opening' ? 'mute' : 'open'
}

/**
 * The accessible name of the pill: the state, what a press does, and the key, in one sentence a screen reader says
 * ("Microphone: listening. Press to mute. Key V."). `detail` (why it failed) follows the state when there is one.
 */
export function pillLabel(phase: MicPhase, speaking: boolean, detail = '', key = 'V'): string {
  const word = pillWord(phase, speaking).toLowerCase()
  const state = word.startsWith('mic ') ? word.slice(4) : word
  const does = tapMeans(phase) === 'mute' ? 'mute' : 'listen'
  return `Microphone: ${state}${detail ? ` (${detail})` : ''}. Press to ${does}. Key ${key}.`
}

// ---------------------------------------------------------------- the browser's objects, by what is used of them

export interface TrackLike { enabled: boolean; readyState?: string; stop(): void; addEventListener?(type: 'ended', fn: () => void): void }
export interface StreamLike { getTracks(): TrackLike[]; getAudioTracks?(): TrackLike[] }
export interface MediaLike { getUserMedia(c: { audio: Record<string, unknown> }): Promise<StreamLike> }
export interface NodeLike { connect(to: NodeLike): unknown; disconnect(): void }
export interface AnalyserLike extends NodeLike { fftSize: number; getFloatTimeDomainData(out: Float32Array): void }
export interface WorkletNodeLike extends NodeLike { port: { onmessage: ((e: { data: VadMessage }) => void) | null; postMessage(m: unknown): void } }
export interface ContextLike {
  readonly state: string
  readonly sampleRate: number
  /** The context's clock (seconds of audio rendered): the polled path reads it to feed every sample, none twice. */
  readonly currentTime?: number
  readonly audioWorklet?: { addModule(url: string): Promise<void> }
  createMediaStreamSource(s: StreamLike): NodeLike
  createAnalyser(): AnalyserLike
  resume(): Promise<void>
  close(): Promise<void>
}
export interface MicEnv {
  media: MediaLike | null
  /** The AudioContext constructor, or null where Web Audio is missing (the pill then has no meter and no speech state). */
  Context: (new (o?: { latencyHint?: string }) => ContextLike) | null
  /** The AudioWorkletNode constructor, or null: the AnalyserNode path then. */
  WorkletNode: (new (ctx: ContextLike, name: string, o?: { processorOptions?: unknown }) => WorkletNodeLike) | null
  /** Makes a blob: URL of module source (URL.createObjectURL over a Blob), and revokes it; null where there is none. */
  moduleUrl: ((source: string) => { url: string; revoke(): void }) | null
  /** Schedules the AnalyserNode poll (setInterval) and clears it. */
  setInterval(fn: () => void, ms: number): unknown
  clearInterval(handle: unknown): void
}

export function micEnv(g: object = globalThis): MicEnv {
  const w = g as {
    navigator?: { mediaDevices?: MediaLike }
    AudioContext?: unknown
    webkitAudioContext?: unknown
    AudioWorkletNode?: unknown
    URL?: { createObjectURL?(b: unknown): string; revokeObjectURL?(u: string): void }
    Blob?: new (parts: string[], o: { type: string }) => unknown
    setInterval?: (fn: () => void, ms: number) => unknown
    clearInterval?: (h: unknown) => void
  }
  const media = w.navigator?.mediaDevices && typeof w.navigator.mediaDevices.getUserMedia === 'function' ? w.navigator.mediaDevices : null
  const C = w.AudioContext ?? w.webkitAudioContext
  const U = w.URL
  const canBlob = typeof w.Blob === 'function' && typeof U?.createObjectURL === 'function'
  return {
    media,
    Context: typeof C === 'function' ? (C as MicEnv['Context']) : null,
    WorkletNode: typeof w.AudioWorkletNode === 'function' ? (w.AudioWorkletNode as MicEnv['WorkletNode']) : null,
    moduleUrl: canBlob
      ? (source) => {
          const url = U!.createObjectURL!(new w.Blob!([source], { type: 'text/javascript' }))
          return { url, revoke: () => { try { U!.revokeObjectURL?.(url) } catch { /* already gone */ } } }
        }
      : null,
    setInterval: (fn, ms) => (w.setInterval ?? setInterval)(fn, ms),
    clearInterval: (h) => (w.clearInterval ?? clearInterval)(h as ReturnType<typeof setInterval>),
  }
}

/** The constraints asked of the device: the browser's own echo cancellation (the page's voice is not the visitor's), noise suppression and gain. */
export const MIC_CONSTRAINTS = Object.freeze({ audio: Object.freeze({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 }) })

/** Levels the meter keeps: the newest LEVELS readings, a ring. */
export const LEVELS = 48

/** The meter as the HUD's pill reads it (a Microphone is one): the ring of levels, the slot the next goes in, the newest. */
export interface MicMeter { readonly levels: Float32Array; readonly head: number; readonly level: number }
/** How often the AnalyserNode path polls, ms (the worklet path needs none). */
const POLL_MS = 16
/** A tap on the pill that lands within this many ms of the last is the same tap (a double-fire on touch). */
const DEBOUNCE_MS = 150

export interface MicEvents {
  change: MicState
  /** Speech started (true) or ended (false), as the detector sees it. */
  speech: boolean
  /** Speech started while the page itself was speaking: cut the page's voice. */
  barge: undefined
}

/** The microphone, its detector and its meter. One per page. */
export class Microphone extends EventTarget {
  readonly #env: MicEnv
  readonly #store: KeyStore | null | undefined
  readonly #now: () => number
  #settings: VoiceSettings
  #phase: MicPhase = 'off'
  #detail = ''
  #stream: StreamLike | null = null
  #ctx: ContextLike | null = null
  #source: NodeLike | null = null
  #worklet: WorkletNodeLike | null = null
  #analyser: AnalyserLike | null = null
  #poll: unknown = null
  /** The detector on the page's side (the AnalyserNode path runs it; the worklet path keeps it for `speech`), remade
   *  with the frame the context's rate asks for (vadFrame). */
  #core = new VadCore(VAD)
  /** The page is speaking (Sloane): told to the detector, and speech starting then is a barge-in. */
  #speaking = false
  #speech = false
  /** Bumped by every open() and mute(): an open() that awaited the device does nothing if it changed meanwhile. */
  #generation = 0
  #lastTap = -Infinity
  #disposed = false
  /** The meter: the newest LEVELS smoothed levels (0..1), `head` the slot the next one goes in. */
  readonly levels = new Float32Array(LEVELS)
  head = 0
  /** The newest level, 0..1. */
  level = 0
  /** Which path analyses the audio: the worklet, the page (AnalyserNode), or none yet. */
  path: 'worklet' | 'page' | 'none' = 'none'

  constructor(env: MicEnv = micEnv(), store?: KeyStore | null, now: () => number = () => (typeof performance === 'undefined' ? Date.now() : performance.now())) {
    super()
    this.#env = env
    this.#store = store
    this.#now = now
    this.#settings = loadVoiceSettings(store === undefined ? browserStore() : store)
  }

  get state(): MicState { return { phase: this.#phase, detail: this.#detail } }
  get phase(): MicPhase { return this.#phase }
  settings(): VoiceSettings { return this.#settings }
  /** Whether the microphone hears a person now. */
  get speech(): boolean { return this.#speech }
  /** Whether the page is speaking, as last told. */
  get speaking(): boolean { return this.#speaking }
  /** Whether the device is open. */
  get open(): boolean { return isOpen(this.#phase) }

  /** Whether this page would open the microphone at boot (the kept switch, or the one line). */
  opensAtBoot(byDefault = MIC_OPEN_BY_DEFAULT): boolean {
    return opensAtBoot(this.#settings, byDefault)
  }

  /** The pill's word now. */
  word(): string { return pillWord(this.#phase, this.#speaking) }

  /** The pill's accessible name now. */
  label(key = 'V'): string { return pillLabel(this.#phase, this.#speaking, this.#phase === 'listening' || this.#phase === 'speech' || this.#phase === 'off' || this.#phase === 'muted' ? '' : this.#detail, key) }

  /**
   * Opens the device (the browser asks its permission the first time). Resolves with the state once the device is
   * open or has refused. Call it from the visitor's gesture where the browser needs one (Safari); a boot's call
   * without one works where the permission was kept (Chrome) and reads blocked where it was not.
   */
  async listen(): Promise<MicState> {
    if (this.#disposed) return this.state
    if (this.#phase === 'opening' || this.open) return this.state
    const media = this.#env.media
    if (!media) return this.#set('unavailable', 'this browser has no microphone access (a secure page, https or localhost, is needed)')
    const generation = ++this.#generation
    this.#set('opening', 'waiting for the microphone (the browser may ask for permission)')
    let stream: StreamLike
    try {
      stream = await media.getUserMedia(MIC_CONSTRAINTS as unknown as { audio: Record<string, unknown> })
    } catch (e) {
      if (generation !== this.#generation) return this.state
      const [phase, detail] = refusal(e)
      // The visitor said no at the browser's prompt (or the browser keeps their no): kept like a mute, so a page that
      // opens at boot does not ask again on every visit (Firefox asks each time unless told to remember). A press asks
      // again. A missing device or an insecure page is not their choice and keeps nothing.
      if (phase === 'blocked') {
        this.#settings = Object.freeze({ on: false, kept: true })
        this.#keep()
      }
      return this.#set(phase, detail)
    }
    if (generation !== this.#generation || this.#disposed) {
      for (const t of stream.getTracks()) t.stop()
      return this.state
    }
    this.#stream = stream
    const tracks = stream.getAudioTracks?.() ?? stream.getTracks()
    for (const t of tracks) t.addEventListener?.('ended', () => { if (this.#stream === stream) this.#lost() })
    await this.#graph(stream)
    if (generation !== this.#generation || this.#disposed) return this.state
    this.#settings = Object.freeze({ on: true, kept: true })
    this.#keep()
    return this.#set('listening', this.path === 'worklet' ? 'on-device detector in an audio worklet' : this.path === 'page' ? 'on-device detector on the page' : 'open; this browser has no Web Audio, so no level or speech state')
  }

  /** Closes the device (the browser's indicator goes out), remembers the choice, and reads Muted. */
  mute(): MicState {
    this.#generation++
    this.#teardown()
    this.#settings = Object.freeze({ on: false, kept: true })
    this.#keep()
    return this.#set('muted', '')
  }

  /** The pill's tap, V, R3 and the Menu: open when closed, mute when open. Debounced against a touch double-fire. */
  toggle(): Promise<MicState> | MicState {
    const now = this.#now()
    if (now - this.#lastTap < DEBOUNCE_MS) return this.state
    this.#lastTap = now
    return tapMeans(this.#phase) === 'mute' ? this.mute() : this.listen()
  }

  /** The page is speaking (Sloane's voice): the detector allows for it, and speech starting now is a barge-in. */
  setSpeaking(on: boolean): void {
    const was = this.#speaking
    this.#speaking = on === true
    if (was === this.#speaking) return
    this.#core.speaking = this.#speaking
    this.#worklet?.port.postMessage({ speaking: this.#speaking })
  }

  /**
   * Her next line started while she speaks (speaker.ts onLine; a line that cuts the one still playing is no change of
   * setSpeaking): the detector learns her echo afresh for it (vad.ts VadCore.newLine). Nothing while she is quiet.
   */
  newLine(): void {
    if (!this.#speaking) return
    this.#core.newLine()
    this.#worklet?.port.postMessage({ line: true })
  }

  /** A gesture: a context the browser started asleep (opened at boot, without one) wakes up. */
  resume(): void {
    const ctx = this.#ctx
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(noop)
  }

  /** Closes the device and keeps the switch (the city going away, a halt): reads off, and the next listen() opens it again. */
  close(): MicState {
    this.#generation++
    this.#teardown()
    return this.open || this.#phase === 'opening' ? this.#set('off', '') : this.state
  }

  /** Closes the device for good (this shell unmounting); the kept switch stands for the next page. */
  dispose(): void {
    if (this.#disposed) return
    this.close()
    this.#disposed = true
  }

  /** Feeds a block of samples as the detector would get them: the AnalyserNode path's poll, and the tests. */
  feed(samples: Float32Array): void {
    if (!this.open) return
    const core = this.#core
    core.push(samples)
    this.#level(core.rms)
    if (core.changed) this.#heard(core.speech)
  }

  /** Builds the graph over the stream: the worklet where the browser has one, else the AnalyserNode poll. */
  async #graph(stream: StreamLike): Promise<void> {
    const C = this.#env.Context
    this.path = 'none'
    if (!C) return
    let ctx: ContextLike
    try { ctx = new C({ latencyHint: 'interactive' }) } catch { return }
    this.#ctx = ctx
    let source: NodeLike
    try { source = ctx.createMediaStreamSource(stream) } catch { return }
    this.#source = source
    // The frame follows the context's rate, which is the output device's (often 96 kHz on an audio interface), so every
    // count of frames in VAD is the time it says (vad.ts vadFrame).
    const rate = Number(ctx.sampleRate) > 0 ? Number(ctx.sampleRate) : VAD.rate
    const frame = vadFrame(rate)
    const opts = frame === VAD.frame && rate === VAD.rate ? VAD : Object.freeze({ ...VAD, frame, rate })
    if (this.#core.frame !== frame || this.#core.rate !== rate) this.#core = new VadCore(opts)
    this.#core.reset()
    this.#core.speaking = this.#speaking
    this.#speech = false
    const W = this.#env.WorkletNode
    const mod = this.#env.moduleUrl
    if (W && mod && ctx.audioWorklet) {
      const m = mod(vadWorkletSource(VAD))
      try {
        await ctx.audioWorklet.addModule(m.url)
        if (this.#ctx !== ctx) return
        const node = new W(ctx, VAD_PROCESSOR, { processorOptions: opts })
        node.port.onmessage = (e) => this.#message(e.data)
        node.port.postMessage({ speaking: this.#speaking })
        source.connect(node)
        this.#worklet = node
        this.path = 'worklet'
        return
      } catch {
        // No worklet (a policy, an older browser): the page polls an analyser instead.
      } finally {
        m.revoke()
      }
    }
    if (this.#ctx !== ctx) return
    try {
      const analyser = ctx.createAnalyser()
      // Room for eight frames: each poll feeds the detector the samples that came since the last one, by the context's
      // clock, so it sees the stream itself (its frames last what VAD says), not one frame a poll with gaps between;
      // polls further apart than eight frames (a throttled tab) lose the rest.
      const size = Math.min(32_768, frame * 8)
      analyser.fftSize = size
      source.connect(analyser)
      this.#analyser = analyser
      const buf = new Float32Array(size)
      let last = ctx.currentTime
      this.#poll = this.#env.setInterval(() => {
        if (this.#analyser !== analyser) return
        analyser.getFloatTimeDomainData(buf)
        const now = ctx.currentTime
        // A context with no clock to read: the latest frame, once a poll.
        if (typeof now !== 'number' || typeof last !== 'number') { this.feed(buf.subarray(size - frame)); return }
        const fresh = Math.min(size, Math.max(0, Math.round((now - last) * ctx.sampleRate)))
        last = now
        if (fresh > 0) this.feed(buf.subarray(size - fresh))
      }, POLL_MS)
      this.path = 'page'
    } catch {
      this.path = 'none'
    }
  }

  #message(m: VadMessage): void {
    if (!m || typeof m !== 'object') return
    if (typeof m.rms === 'number') this.#level(m.rms)
    if (typeof m.speech === 'boolean') this.#heard(m.speech)
  }

  #level(rms: number): void {
    const v = Number.isFinite(rms) ? Math.min(1, Math.max(0, rms)) : 0
    this.level = v
    this.levels[this.head] = v
    this.head = (this.head + 1) % LEVELS
  }

  #heard(speech: boolean): void {
    if (speech === this.#speech) return
    this.#speech = speech
    if (!this.open) return
    this.#emit('speech', speech)
    if (speech && this.#speaking) this.#emit('barge', undefined)
    this.#set(speech ? 'speech' : 'listening', this.#detail)
  }

  /** The device went away under the page (unplugged, taken by the system). */
  #lost(): void {
    this.#generation++
    this.#teardown()
    this.#set('error', 'the microphone went away; press the pill to open it again')
  }

  #teardown(): void {
    const stream = this.#stream
    this.#stream = null
    if (stream) for (const t of stream.getTracks()) { try { t.stop() } catch { /* already stopped */ } }
    if (this.#poll !== null) { this.#env.clearInterval(this.#poll); this.#poll = null }
    const worklet = this.#worklet
    this.#worklet = null
    if (worklet) { worklet.port.onmessage = null; try { worklet.disconnect() } catch { /* gone */ } }
    const analyser = this.#analyser
    this.#analyser = null
    if (analyser) { try { analyser.disconnect() } catch { /* gone */ } }
    const source = this.#source
    this.#source = null
    if (source) { try { source.disconnect() } catch { /* gone */ } }
    const ctx = this.#ctx
    this.#ctx = null
    if (ctx) void ctx.close().catch(noop)
    this.#speech = false
    this.path = 'none'
    this.level = 0
    this.levels.fill(0)
  }

  #set(phase: MicPhase, detail: string): MicState {
    const changed = phase !== this.#phase || detail !== this.#detail
    this.#phase = phase
    this.#detail = detail
    if (changed) this.#emit('change', this.state)
    return this.state
  }

  #keep(): void { saveVoiceSettings(this.#settings, this.#store === undefined ? browserStore() : this.#store) }

  #emit<K extends keyof MicEvents>(type: K, detail: MicEvents[K]): void {
    this.dispatchEvent(new CustomEvent(type, { detail }))
  }
}

const noop = (): void => {}

/** The phase and the words for a getUserMedia refusal (DOMException names, as the browsers raise them). */
export function refusal(e: unknown): [MicPhase, string] {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : ''
  const message = e instanceof Error ? e.message : String(e)
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return ['blocked', 'microphone permission was refused; allow it in the browser and press the pill again']
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return ['unavailable', 'no microphone found']
    case 'NotReadableError':
    case 'TrackStartError':
      return ['error', 'the microphone is in use by another program']
    case 'SecurityError':
      return ['unavailable', 'this page may not use the microphone (a secure page, https or localhost, is needed)']
    case 'OverconstrainedError':
      return ['error', 'no microphone matched what was asked']
    default:
      return ['error', `the microphone could not be opened: ${message}`]
  }
}

/** The console's `mic` lines over the microphone. */
export function voiceStatus(m: Microphone, speaking: boolean, recognition: string): string[] {
  const s = m.state
  return [
    `mic       ${s.phase}${s.detail ? ` · ${s.detail}` : ''}`,
    `pill      ${pillWord(s.phase, speaking)}  (V, R3, the pill or the Menu mute and unmute; mic on|off here)`,
    `detector  ${m.path === 'worklet' ? 'audio worklet' : m.path === 'page' ? 'on the page' : 'none'}${m.open ? m.speech ? ' · hearing you' : ' · the room' : ''}`,
    `boot      ${m.opensAtBoot() ? 'opens at boot' : 'off until pressed'}  (kept switch ${m.settings().kept ? m.settings().on ? 'on' : 'muted' : 'none'}; the default ${MIC_OPEN_BY_DEFAULT ? 'open' : 'off'})`,
    `words     ${recognition}`,
  ]
}
