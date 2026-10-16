// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the operator's local voice: a client for a speech server running on this machine,
 * reachable only at a loopback address and asked only when the operator asks. It speaks the JSON API that local
 * open-weights speech servers commonly offer (POST /v1/audio/speech: the text, a voice, optionally a model; audio
 * back as WAV), reads the audio whole, stops the request the moment the task's signal aborts (the spatial lease
 * breaking, or the operator's own stop), and turns every way the server can fail into one plain sentence. No speech
 * engine is bundled: the server is a separate program the operator runs, under its own licence, and nothing sent to
 * it can leave the machine. What it returns is only bytes; the soundscape decodes and places them (audio.ts).
 * A second, optional provider (say provider elevenlabs) speaks the ElevenLabs text-to-speech API, through a gateway
 * on this machine exactly as the Claude provider does (09_Cognition/claudeApi.ts): the page addresses a loopback
 * origin only, the gateway holds the key (or `say key <key>` keeps one in this browser, masked everywhere it is
 * shown), and nothing is sent until the operator chooses that provider. Off by default: the local server is the
 * product's voice.
 * What breaks if it is removed? `say` has nothing behind it. Nothing else in the city needs it.
 */
import { loopbackServer, type FetchLike, type SettingsStore } from './localCompute.ts'
import type { Voice } from '../07_Execute_Actions/operator.ts'

/** Where the local speech server listens unless the operator says otherwise (say server <url>). */
export const DEFAULT_SPEECH_SERVER = 'http://localhost:8880'
/** The speech providers: a speech server on this machine, or the ElevenLabs API through a gateway on this machine. */
export const SPEECH_PROVIDERS = ['local', 'elevenlabs'] as const
export type SpeechProvider = (typeof SPEECH_PROVIDERS)[number]
export const DEFAULT_SPEECH_PROVIDER: SpeechProvider = 'local'
/** The gateway the ElevenLabs provider speaks to unless the operator names another loopback address (say server <url>). */
export const ELEVEN_GATEWAY = 'http://localhost:8090'
/** The ElevenLabs model asked unless the operator chooses another (say model <name>): the low-latency one. */
export const DEFAULT_ELEVEN_MODEL = 'eleven_turbo_v2_5'
/** An ElevenLabs voice id as the API issues them (a name the operator typed instead is looked up in its list). */
const ELEVEN_ID = /^[A-Za-z0-9]{20}$/
/** Longest text one request carries, characters (about a minute of speech). A longer text is refused, never cut here. */
export const SPEECH_CHARS = 1200
/** Largest answer read, bytes: a minute of 24 kHz 16-bit mono WAV is 2.9 MB, so anything past this is not one utterance. */
export const SPEECH_BYTES = 32 * 1024 * 1024
/** Longest server message kept in a sentence. */
const MESSAGE_CHARS = 160

/** How a request to the local speech server failed. */
export type SpeechFailure = 'offline' | 'refused' | 'voice' | 'server' | 'unreadable' | 'text'

export class SpeechError extends Error {
  override readonly name = 'SpeechError'
  readonly code: SpeechFailure
  constructor(code: SpeechFailure, message: string) {
    super(message)
    this.code = code
  }
}

/** The first line of a server's message, cut to MESSAGE_CHARS. */
function sentence(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS)}…` : line
}

/** What a server said in an error body, in any of the shapes these servers use: detail, error, error.message. */
function said(body: unknown): string {
  if (typeof body !== 'object' || body === null) return ''
  const b = body as { detail?: unknown; error?: unknown; message?: unknown }
  const pick = (v: unknown): string => {
    if (typeof v === 'string') return v
    if (Array.isArray(v)) return v.map(pick).filter(Boolean).join('; ')
    if (typeof v === 'object' && v !== null) {
      const o = v as { message?: unknown; msg?: unknown; detail?: unknown }
      return pick(o.message ?? o.msg ?? o.detail)
    }
    return ''
  }
  return pick(b.detail) || pick(b.error) || pick(b.message)
}

/**
 * After a request failed without an answer (the browser says only "network error" for both), whether the server is
 * down or up but refusing this page's origin: an opaque no-cors request reaches a running server whatever its origin
 * rules, and fails only if nothing is listening.
 */
async function diagnose(fetchFn: FetchLike, server: string): Promise<SpeechError> {
  try {
    await fetchFn(`${server}/`, { mode: 'no-cors', cache: 'no-store', referrerPolicy: 'no-referrer' })
    return new SpeechError('refused', `the local speech server at ${server} is running but refused this page: allow this page's origin in its settings (a page opened from a file sends 'null'), or open the page from http://localhost`)
  } catch {
    return new SpeechError('offline', `no local speech server is answering at ${server}: start it, or point say at the right address (say server <url>)`)
  }
}

/** A request that failed before any answer: the signal's own reason if it aborted, else what the server's state was. */
async function unreachable(fetchFn: FetchLike, server: string, signal: AbortSignal | undefined, error: unknown): Promise<unknown> {
  if (signal?.aborted) return signal.reason
  if (error instanceof DOMException && error.name === 'AbortError') return error
  return diagnose(fetchFn, server)
}

/** A non-2xx answer as one sentence, from the server's own error body when it sends one. */
async function httpFailure(res: Response, voice: string | null): Promise<SpeechError> {
  let message = ''
  try {
    message = said(JSON.parse(await res.text()))
  } catch {
    // not JSON: the status alone
  }
  if (res.status === 403) return new SpeechError('refused', "the local speech server refused this page (403): allow this page's origin in its settings, or open the page from http://localhost")
  if (res.status === 404) return new SpeechError('server', 'the server at this address has no /v1/audio/speech: is it a speech server? (say server <url>)')
  if ((res.status === 400 || res.status === 422) && voice !== null && /voice/i.test(message)) {
    return new SpeechError('voice', `the local speech server has no voice '${voice}': type say to list the ones it has`)
  }
  return new SpeechError('server', `the local speech server failed (${res.status})${message ? `: ${sentence(message)}` : ''}`)
}

/** Reads a whole body, at most SPEECH_BYTES, every read racing the signal (the reader is cancelled either way). */
async function readAll(res: Response, signal: AbortSignal | undefined): Promise<ArrayBuffer> {
  if (!res.body) throw new SpeechError('unreadable', "the local speech server's audio could not be read")
  const reader = res.body.getReader()
  const stopped = signal ? new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) : null
  stopped?.catch(() => {})
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await (stopped ? Promise.race([reader.read(), stopped]) : reader.read())
      if (done) break
      total += value.byteLength
      if (total > SPEECH_BYTES) throw new SpeechError('unreadable', `the local speech server sent more than ${SPEECH_BYTES / 1024 / 1024} MB: not one utterance`)
      chunks.push(value)
    }
  } catch (e) {
    void reader.cancel().catch(() => {})
    if (signal?.aborted) throw signal.reason
    throw e
  }
  if (total === 0) throw new SpeechError('unreadable', 'the local speech server sent no audio')
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.byteLength
  }
  return out.buffer
}

/**
 * One utterance: POSTs the text to `server` + /v1/audio/speech (the server must be a loopback address, or nothing is
 * sent) with the voice, the model if one is chosen, and WAV asked for, and resolves with the audio's bytes. Rejects
 * with a SpeechError for anything the server or the network did, for no text, or for more than SPEECH_CHARS of it;
 * with the signal's reason the moment it aborts (the request is cancelled with it).
 */
export async function synthesize(
  fetchFn: FetchLike,
  req: { server: string; model: string | null; voice: string; text: string; signal?: AbortSignal },
): Promise<ArrayBuffer> {
  const server = loopbackServer(req.server)
  if (server === null) throw new SpeechError('refused', `not a server on this machine: ${String(req.server)}`)
  const text = typeof req.text === 'string' ? req.text.trim() : ''
  if (!text) throw new SpeechError('text', 'nothing to say')
  if (text.length > SPEECH_CHARS) throw new SpeechError('text', `too long to say at once: ${text.length} characters (at most ${SPEECH_CHARS})`)
  const body = JSON.stringify({ ...(req.model ? { model: req.model } : {}), input: text, voice: req.voice, response_format: 'wav' })
  let res: Response
  try {
    res = await fetchFn(`${server}/v1/audio/speech`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: req.signal, cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  } catch (e) {
    throw await unreachable(fetchFn, server, req.signal, e)
  }
  if (!res.ok) throw await httpFailure(res, req.voice)
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type && !type.startsWith('audio/') && type !== 'application/octet-stream') {
    let message = ''
    try {
      message = said(JSON.parse(await res.text()))
    } catch {
      // not JSON either
    }
    throw new SpeechError('unreadable', `the local speech server answered with ${type}, not audio${message ? `: ${sentence(message)}` : ''}`)
  }
  return readAll(res, req.signal)
}

/**
 * The voices the server lists (GET /v1/audio/voices), sorted: names, or objects with an id or a name, bare or under
 * `voices`. Null when the server has no such list (404): it may still speak, in the voices its documentation gives.
 */
export async function speechVoices(fetchFn: FetchLike, server: string, signal?: AbortSignal): Promise<string[] | null> {
  const origin = loopbackServer(server)
  if (origin === null) throw new SpeechError('refused', `not a server on this machine: ${String(server)}`)
  let res: Response
  try {
    res = await fetchFn(`${origin}/v1/audio/voices`, { signal, cache: 'no-store', referrerPolicy: 'no-referrer' })
  } catch (e) {
    throw await unreachable(fetchFn, origin, signal, e)
  }
  if (res.status === 404) return null
  if (!res.ok) throw await httpFailure(res, null)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new SpeechError('unreadable', "the local speech server's list of voices could not be read")
  }
  const list = Array.isArray(body) ? body : (body as { voices?: unknown } | null)?.voices
  if (!Array.isArray(list)) throw new SpeechError('unreadable', "the local speech server's list of voices could not be read")
  const names = list.map((v): unknown => (typeof v === 'string' ? v : typeof v === 'object' && v !== null ? (v as { id?: unknown; name?: unknown }).id ?? (v as { name?: unknown }).name : null))
  return [...new Set(names.filter((n): n is string => typeof n === 'string' && n.trim() !== ''))].sort()
}

/** A name the operator typed (a model or a voice): trimmed, one line, not blank. */
function nameOf(what: 'model' | 'voice', name: unknown): string {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || /[\r\n]/.test(n)) throw new Error(`name the ${what}, e.g. say ${what} <name> (type say to list the voices)`)
  return n
}

/** A key as it is shown: the first few and last few characters, never the middle (claudeApi.ts shows keys the same way). */
export function maskSpeechKey(key: string | null): string | null {
  if (key === null) return null
  return key.length <= 8 ? '****' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

/** An ElevenLabs request that failed before any answer: its abort, or the gateway down or refusing this page. */
async function elevenUnreachable(fetchFn: FetchLike, server: string, signal: AbortSignal | undefined, error: unknown): Promise<unknown> {
  if (signal?.aborted) return signal.reason
  if (error instanceof DOMException && error.name === 'AbortError') return error
  try {
    await fetchFn(`${server}/`, { mode: 'no-cors', cache: 'no-store', referrerPolicy: 'no-referrer' })
    return new SpeechError('refused', `the ElevenLabs gateway at ${server} is running but refused this page: allow this page's origin in it (a page opened from a file sends 'null'), or open the page from http://localhost`)
  } catch {
    return new SpeechError('offline', `no ElevenLabs gateway is answering at ${server}: start it (docs/zero-trust-audit.md has an example), or point say at it (say server <url>)`)
  }
}

/** A non-2xx answer from the ElevenLabs gateway as one sentence, from ElevenLabs' own error body when it sends one. */
async function elevenFailure(res: Response, voice: string | null, path: string): Promise<SpeechError> {
  let message = ''
  let status = ''
  try {
    const body = JSON.parse(await res.text()) as { detail?: { status?: unknown } } | null
    message = said(body)
    status = typeof body?.detail?.status === 'string' ? body.detail.status : ''
  } catch {
    // not JSON: the status alone
  }
  if (res.status === 401) return new SpeechError('refused', 'ElevenLabs refused the key (401): put the key in the gateway on this machine, or say key <key>')
  if (res.status === 403) return new SpeechError('refused', `the ElevenLabs gateway refused this page (403)${message ? `: ${sentence(message)}` : ''}`)
  if (voice !== null && (res.status === 404 || res.status === 400 || res.status === 422) && /voice/i.test(`${status} ${message}`)) {
    return new SpeechError('voice', `ElevenLabs has no voice '${voice}': type say to list the ones it has, and name one or paste its id`)
  }
  if (res.status === 404) return new SpeechError('server', `the gateway at this address has no ${path}: is it the ElevenLabs gateway? (say server <url>)`)
  return new SpeechError('server', `ElevenLabs failed (${res.status})${message ? `: ${sentence(message)}` : ''}`)
}

/**
 * One ElevenLabs utterance through the gateway at `server` (a loopback origin, or nothing is sent): POST
 * /v1/text-to-speech/<voice> with the text and the model, MP3 asked for (the soundscape decodes any format the browser
 * reads), the key as the `xi-api-key` header only when one is kept on the page (else the gateway adds its own). A
 * voice that is not an id is looked up by name in the gateway's list first ('Name (id)', as `say` lists them, is
 * the id). Failures are one sentence each, naming the gateway.
 */
export async function synthesizeEleven(
  fetchFn: FetchLike,
  req: { server: string; key: string | null; model: string; voice: string; text: string; signal?: AbortSignal },
): Promise<ArrayBuffer> {
  const server = loopbackServer(req.server)
  if (server === null) throw new SpeechError('refused', `not a gateway on this machine: ${String(req.server)}`)
  const text = typeof req.text === 'string' ? req.text.trim() : ''
  if (!text) throw new SpeechError('text', 'nothing to say')
  if (text.length > SPEECH_CHARS) throw new SpeechError('text', `too long to say at once: ${text.length} characters (at most ${SPEECH_CHARS})`)
  const listed = /\(([A-Za-z0-9]{20})\)\s*$/.exec(req.voice)
  let voice = listed ? listed[1] : req.voice.trim()
  if (!ELEVEN_ID.test(voice)) {
    const list = await elevenVoices(fetchFn, server, req.key, req.signal)
    const found = list.find((v) => v.name.toLowerCase() === voice.toLowerCase())
    if (!found) throw new SpeechError('voice', `ElevenLabs has no voice '${voice}': type say to list the ones it has, and name one or paste its id`)
    voice = found.id
  }
  const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'audio/mpeg', ...(req.key ? { 'xi-api-key': req.key } : {}) }
  const body = JSON.stringify({ text, model_id: req.model })
  let res: Response
  try {
    res = await fetchFn(`${server}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST', headers, body, signal: req.signal, cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  } catch (e) {
    throw await elevenUnreachable(fetchFn, server, req.signal, e)
  }
  if (!res.ok) throw await elevenFailure(res, req.voice, '/v1/text-to-speech')
  const type = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (type && !type.startsWith('audio/') && type !== 'application/octet-stream') {
    throw new SpeechError('unreadable', `the gateway answered with ${type}, not audio`)
  }
  return readAll(res, req.signal)
}

/** The voices ElevenLabs lists for the key (GET /v1/voices): name and id, sorted by name. */
export async function elevenVoices(fetchFn: FetchLike, server: string, key: string | null, signal?: AbortSignal): Promise<{ name: string; id: string }[]> {
  const origin = loopbackServer(server)
  if (origin === null) throw new SpeechError('refused', `not a gateway on this machine: ${String(server)}`)
  let res: Response
  try {
    res = await fetchFn(`${origin}/v1/voices`, { signal, cache: 'no-store', referrerPolicy: 'no-referrer', headers: key ? { 'xi-api-key': key } : {} })
  } catch (e) {
    throw await elevenUnreachable(fetchFn, origin, signal, e)
  }
  if (!res.ok) throw await elevenFailure(res, null, '/v1/voices')
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new SpeechError('unreadable', "the gateway's list of voices could not be read")
  }
  const list = (body as { voices?: unknown } | null)?.voices
  if (!Array.isArray(list)) throw new SpeechError('unreadable', "the gateway's list of voices could not be read")
  const out: { name: string; id: string }[] = []
  for (const v of list) {
    if (typeof v !== 'object' || v === null) continue
    const { voice_id: id, name } = v as { voice_id?: unknown; name?: unknown }
    if (typeof id === 'string' && ELEVEN_ID.test(id) && typeof name === 'string' && name.trim()) out.push({ name: name.trim(), id })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** What is kept between visits: the provider chosen, each provider's own settings, and auto. v1 records (the local server alone) still read. */
interface Kept {
  v: 2
  provider: SpeechProvider
  auto: boolean
  local: { server: string; model: string | null; voice: string | null }
  elevenlabs: { server: string; model: string; voice: string | null; key: string | null }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

/** A kept record read back, whatever version wrote it; the defaults for anything missing or unreadable. */
export function readKept(raw: string | null | undefined): Kept {
  const kept: Kept = {
    v: 2, provider: DEFAULT_SPEECH_PROVIDER, auto: false,
    local: { server: DEFAULT_SPEECH_SERVER, model: null, voice: null },
    elevenlabs: { server: ELEVEN_GATEWAY, model: DEFAULT_ELEVEN_MODEL, voice: null, key: null },
  }
  try {
    const saved: unknown = JSON.parse(raw ?? 'null')
    if (typeof saved !== 'object' || saved === null) return kept
    const s = saved as { v?: unknown; server?: unknown; model?: unknown; voice?: unknown; auto?: unknown; provider?: unknown; local?: unknown; elevenlabs?: unknown }
    kept.auto = s.auto === true
    if (s.v === 2) {
      if (s.provider === 'elevenlabs') kept.provider = 'elevenlabs'
      const l = (typeof s.local === 'object' && s.local !== null ? s.local : {}) as { server?: unknown; model?: unknown; voice?: unknown }
      kept.local = { server: loopbackServer(l.server) ?? DEFAULT_SPEECH_SERVER, model: str(l.model), voice: str(l.voice) }
      const e = (typeof s.elevenlabs === 'object' && s.elevenlabs !== null ? s.elevenlabs : {}) as { server?: unknown; model?: unknown; voice?: unknown; key?: unknown }
      kept.elevenlabs = { server: loopbackServer(e.server) ?? ELEVEN_GATEWAY, model: str(e.model) ?? DEFAULT_ELEVEN_MODEL, voice: str(e.voice), key: str(e.key) }
    } else {
      kept.local = { server: loopbackServer(s.server) ?? DEFAULT_SPEECH_SERVER, model: str(s.model), voice: str(s.voice) }
    }
  } catch {
    // nothing kept, or not readable: the defaults
  }
  return kept
}

/**
 * The operator's voice as the operator tier uses it (operator.ts Voice): the provider chosen (`local`, the speech
 * server on this machine, unless the operator chose `elevenlabs`, the ElevenLabs API through a gateway on this
 * machine), that provider's server (a loopback address), its voice (none until the operator chooses one: voice names
 * differ from one server to the next, so none is guessed), its model (the local server's is optional; ElevenLabs has
 * a default), the ElevenLabs key when one is kept on the page, and whether answers to `ask` are spoken as well; all
 * kept in `store`. Utterances (optionally in another voice of the same provider, a hired agent's) and the voices the
 * provider lists.
 */
export function createLocalSpeech({ fetch: fetchFn, store }: { fetch: FetchLike; store?: SettingsStore }): Voice {
  let raw: string | null | undefined
  try {
    raw = store?.load()
  } catch {
    raw = null // storage refused: the defaults
  }
  const kept = readKept(raw)
  const keep = (): void => {
    try {
      store?.save(JSON.stringify(kept))
    } catch {
      // storage refused: the settings last for this visit
    }
  }
  const current = () => (kept.provider === 'elevenlabs' ? kept.elevenlabs : kept.local)
  const voices = async (signal?: AbortSignal): Promise<string[] | null> => {
    if (kept.provider === 'elevenlabs') {
      const list = await elevenVoices(fetchFn, kept.elevenlabs.server, kept.elevenlabs.key, signal)
      return list.map((v) => `${v.name} (${v.id})`)
    }
    return speechVoices(fetchFn, kept.local.server, signal)
  }
  const say = (text: string, signal: AbortSignal, voice: string): Promise<ArrayBuffer> => {
    if (kept.provider === 'elevenlabs') {
      const e = kept.elevenlabs
      return synthesizeEleven(fetchFn, { server: e.server, key: e.key, model: e.model, voice, text, signal })
    }
    const l = kept.local
    return synthesize(fetchFn, { server: l.server, model: l.model, voice, text, signal })
  }
  return Object.freeze({
    settings: () => ({ server: current().server, model: current().model, voice: current().voice, auto: kept.auto, provider: kept.provider, key: maskSpeechKey(kept.elevenlabs.key) }),
    setProvider: (name: string): SpeechProvider => {
      const p = typeof name === 'string' ? name.trim().toLowerCase() : ''
      if (p !== 'local' && p !== 'elevenlabs') throw new Error(`no speech provider called '${String(name)}': local or elevenlabs`)
      kept.provider = p
      keep()
      return p
    },
    setKey: (key: string): string | null => {
      const k = typeof key === 'string' ? key.trim() : ''
      if (/[\r\n\s]/.test(k)) throw new Error('a key is one word')
      kept.elevenlabs.key = k && k !== 'none' ? k : null
      keep()
      return maskSpeechKey(kept.elevenlabs.key)
    },
    setServer: (url: string): string => {
      const origin = loopbackServer(url)
      if (origin === null) throw new Error(`the ${kept.provider === 'elevenlabs' ? 'gateway' : 'local speech server'} must be on this machine (localhost, 127.0.0.1 or [::1]), not '${String(url)}'`)
      current().server = origin
      keep()
      return origin
    },
    setModel: (name: string): string => {
      const m = nameOf('model', name)
      current().model = m
      keep()
      return m
    },
    setVoice: (name: string): string => {
      const v = nameOf('voice', name)
      current().voice = v
      keep()
      return v
    },
    setAuto: (on: boolean): boolean => {
      kept.auto = on === true
      keep()
      return kept.auto
    },
    voices,
    synthesize: (text: string, signal: AbortSignal, voice?: string): Promise<ArrayBuffer> => {
      const chosen = typeof voice === 'string' && voice.trim() ? voice.trim() : current().voice
      if (chosen === null) return Promise.reject(new SpeechError('voice', 'choose a voice first: say voice <name> (type say to list them)'))
      return say(text, signal, chosen)
    },
  })
}
