/**
 * Why does this file exist? It is the operator's local voice: a client for a speech server running on this machine,
 * reachable only at a loopback address and asked only when the operator asks. It speaks the JSON API that local
 * open-weights speech servers commonly offer (POST /v1/audio/speech: the text, a voice, optionally a model; audio
 * back as WAV), reads the audio whole, stops the request the moment the task's signal aborts (the spatial lease
 * breaking, or the operator's own stop), and turns every way the server can fail into one plain sentence. No speech
 * engine is bundled: the server is a separate program the operator runs, under its own licence, and nothing sent to
 * it can leave the machine. What it returns is only bytes; the soundscape decodes and places them (audio.ts).
 * What breaks if it is removed? `say` has nothing behind it. Nothing else in the city needs it.
 */
import { loopbackServer, type FetchLike, type SettingsStore } from './localCompute.ts'
import type { Voice } from '../07_Execute_Actions/operator.ts'

/** Where the local speech server listens unless the operator says otherwise (say server <url>). */
export const DEFAULT_SPEECH_SERVER = 'http://localhost:8880'
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

/**
 * The local speech server as the operator tier uses it (operator.ts Voice): the server's address (a loopback address;
 * the default unless the operator set one), the voice (none until the operator chooses one: voice names differ from
 * one server to the next, so none is guessed), the model (optional: sent only once chosen), and whether answers to
 * `ask` are spoken as well; all kept in `store`. Utterances and the voices the server lists.
 */
export function createLocalSpeech({ fetch: fetchFn, store }: { fetch: FetchLike; store?: SettingsStore }): Voice {
  let server = DEFAULT_SPEECH_SERVER
  let model: string | null = null
  let voice: string | null = null
  let auto = false
  try {
    const saved: unknown = JSON.parse(store?.load() ?? 'null')
    if (typeof saved === 'object' && saved !== null) {
      const s = saved as { server?: unknown; model?: unknown; voice?: unknown; auto?: unknown }
      server = loopbackServer(s.server) ?? DEFAULT_SPEECH_SERVER
      model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : null
      voice = typeof s.voice === 'string' && s.voice.trim() ? s.voice.trim() : null
      auto = s.auto === true
    }
  } catch {
    // nothing kept, or not readable: the defaults
  }
  const keep = (): void => {
    try {
      store?.save(JSON.stringify({ v: 1, server, model, voice, auto }))
    } catch {
      // storage refused: the settings last for this visit
    }
  }
  return Object.freeze({
    settings: () => ({ server, model, voice, auto }),
    setServer: (url: string): string => {
      const origin = loopbackServer(url)
      if (origin === null) throw new Error(`the local speech server must be on this machine (localhost, 127.0.0.1 or [::1]), not '${String(url)}'`)
      server = origin
      keep()
      return server
    },
    setModel: (name: string): string => {
      model = nameOf('model', name)
      keep()
      return model
    },
    setVoice: (name: string): string => {
      voice = nameOf('voice', name)
      keep()
      return voice
    },
    setAuto: (on: boolean): boolean => {
      auto = on === true
      keep()
      return auto
    },
    voices: (signal?: AbortSignal) => speechVoices(fetchFn, server, signal),
    synthesize: (text: string, signal: AbortSignal): Promise<ArrayBuffer> => {
      if (voice === null) return Promise.reject(new SpeechError('voice', 'choose a voice first: say voice <name> (type say to list them)'))
      return synthesize(fetchFn, { server, model, voice, text, signal })
    },
  })
}
