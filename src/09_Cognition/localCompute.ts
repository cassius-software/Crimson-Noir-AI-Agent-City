// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the operator's local model: a client for a model server running on this machine,
 * reachable only at a loopback address and asked only when the operator asks. It speaks two wire formats (`ask api`):
 * `generate`, the Ollama API's streaming /api/generate (the default), and `chat`, the OpenAI-compatible streaming
 * /v1/chat/completions that most local model servers also speak, so any of them, or a gateway the operator runs on
 * this machine in front of another service, can answer. Either way the
 * address must be loopback: the page itself never sends a prompt off the machine. It turns the people a task is bound to into the system prompt (the skills they bring are the persona and the
 * limit of the answer; what they remember of the operator, 08_Swarm/memory.ts, is their history), streams the answer as the server generates it (its thinking and its text), stops the request
 * the moment the task's signal aborts (the spatial lease breaking, or the operator's own stop), and turns every way
 * the server can fail into one plain sentence: not running, running but refusing this page, no such model, not a
 * model that writes text, out of memory. Nothing it sends can leave the machine.
 * What breaks if it is removed? `ask` has nothing behind it. Nothing else in the city needs it.
 */
import { loopbackServer } from '../02_Define_The_Rules/airgap.ts'
import { AGENT_SYSTEM_PROMPT_CORE } from '../02_Define_The_Rules/conduct.ts'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import type { Answer, GateTether, Memories, Mind, Piece } from '../07_Execute_Actions/operator.ts'

/**
 * The server's address as an origin ("http://localhost:11434"), if it is on this machine: http or https, a loopback
 * host (localhost, 127.0.0.0/8, [::1]), no user name or password. Null for anything else, so a prompt can never be
 * sent off the machine. Paths are dropped: the API's own paths are added to the origin. It is the gate of
 * 02_Define_The_Rules/airgap.ts under the name this client has always used.
 */
export { loopbackServer }

/** Where the local model server listens unless the operator says otherwise (the Ollama API's default port). */
export const DEFAULT_SERVER = 'http://localhost:11434'
/**
 * The model asked unless the operator chooses another (ask model <name>): Qwen3-VL 4B, an open-weights model under
 * Apache-2.0 that writes text and shows its thinking, run by the local server. The product's default cognitive engine,
 * so `ask` answers as soon as the server has it; a server without it says so in one sentence.
 */
export const DEFAULT_MODEL = 'qwen3-vl:4b'
/**
 * The context window asked of the server, tokens: room for the prompt, a thinking model's thinking and the answer. A
 * model's own maximum can be far larger, and a server that sizes its cache to it can run out of memory before the
 * first token (seen: 20.5 GB asked for a 4B model), so it is always set.
 */
export const CONTEXT_TOKENS = 8192
/** The longest answer, thinking included, tokens. */
export const ANSWER_TOKENS = 2048
/** Longest server message kept in a sentence. */
const MESSAGE_CHARS = 160

/**
 * The wire format (ask api): `generate` is the Ollama API (/api/generate, /api/tags; the context window and `think`
 * are sent); `chat` is the OpenAI-compatible one (/v1/chat/completions streamed as server-sent events, /v1/models;
 * the server sets its own context window, and thinking shows when the server streams it).
 */
export type WireFormat = 'generate' | 'chat'
export const WIRE_FORMATS: readonly WireFormat[] = Object.freeze(['generate', 'chat'])
export const DEFAULT_API: WireFormat = 'generate'
const isWireFormat = (v: unknown): v is WireFormat => v === 'generate' || v === 'chat'

/** How a request to the local model server failed. */
export type CognitionFailure = 'offline' | 'refused' | 'model' | 'server' | 'unreadable'

export class CognitionError extends Error {
  override readonly name = 'CognitionError'
  readonly code: CognitionFailure
  constructor(code: CognitionFailure, message: string) {
    super(message)
    this.code = code
  }
}

/** The fetch this client uses (the page's own, or a stand-in in the tests). */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/**
 * The Agent City base reality: the part of the system prompt that is the same for every agent, and so comes first,
 * opening with the 14A conduct core (02_Define_The_Rules/conduct.ts) whichever model answers. A model server that
 * caches prompts (the local one reuses the longest prefix of a prompt it has already computed) computes it once for
 * all of them; only what follows (who answers, their skills, what they remember) is theirs.
 */
export const BASE_REALITY = [
  AGENT_SYSTEM_PROMPT_CORE,
  'You are a person in a city simulation, standing with its operator and tethered to them in person.',
  'You answer only from the expertise named below; if a question needs anything else, say which skill it needs and stop.',
  'You may be told what you remember of the operator, oldest first: use it only where it helps with the question.',
  'Be brief and practical. Plain text: no headings, no tables.',
].join('\n')

/**
 * The system prompt for an answer given for the people a task is bound to: the base reality, then who they are, the
 * skills they bring as the whole of the expertise, and what each remembers of the operator (oldest first; only the
 * people bound, only what the memory gave). The same people with the same memories always give the same prompt.
 */
export function systemPrompt(tethers: readonly GateTether[], memories: readonly Memories[] = []): string {
  const skills = [...new Set(tethers.flatMap((t) => t.skills))]
  const who = tethers.map((t) => `agent ${t.agent} (${t.skills.join(', ')})`).join(' and ')
  const history = memories
    .filter((m) => m.lines.length > 0 && tethers.some((t) => t.agent === m.agent))
    .flatMap((m) => [`Agent ${m.agent} remembers, oldest first:`, ...m.lines.map((l) => `- ${l}`)])
  return [
    BASE_REALITY,
    `You are answering for ${who}.`,
    `Your expertise is exactly: ${skills.join(', ')}.`,
    ...history,
  ].join('\n')
}

/**
 * The provenance of a prompt: the SHA-256 (02_Define_The_Rules/integrity.ts) of the exact system prompt string sent,
 * carried on the answer (Answer.promptHash) and noted in the diary, so an audit can prove what a model was given
 * without keeping the prompt. Every provider computes it over the very string it sends.
 */
export const promptHash = (system: string): string => sha256(system)

/** The first line of a server's message, cut to MESSAGE_CHARS. */
export function sentence(text: string): string {
  const line = text.split('\n')[0].trim()
  return line.length > MESSAGE_CHARS ? `${line.slice(0, MESSAGE_CHARS)}…` : line
}

/**
 * After a request failed without an answer (the browser says only "network error" for both), whether the server is
 * down or up but refusing this page's origin: an opaque no-cors request reaches a running server whatever its
 * origin rules, and fails only if nothing is listening.
 */
async function diagnose(fetchFn: FetchLike, server: string): Promise<CognitionError> {
  try {
    await fetchFn(`${server}/api/version`, { mode: 'no-cors', cache: 'no-store', referrerPolicy: 'no-referrer' })
    return new CognitionError('refused', `the local model server at ${server} is running but refused this page: allow this page's origin in its settings (a page opened from a file sends 'null'), or open the page from http://localhost`)
  } catch {
    return new CognitionError('offline', `no local model server is answering at ${server}: start it, or point ask at the right address (ask server <url>)`)
  }
}

/**
 * A non-2xx answer as one sentence, from the server's own error when it sends one: `{ "error": "…" }` (generate) or
 * `{ "error": { "message": "…" } }` (chat).
 */
async function httpFailure(res: Response, model: string | null): Promise<CognitionError> {
  let said = ''
  try {
    const body: unknown = JSON.parse(await res.text())
    const e = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
    if (typeof e === 'string') said = e
    else if (typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string') said = (e as { message: string }).message
  } catch {
    // not JSON: the status alone
  }
  if (res.status === 403) return new CognitionError('refused', `the local model server refused this page (403): allow this page's origin in its settings, or open the page from http://localhost`)
  if (res.status === 404 && model === DEFAULT_MODEL) {
    return new CognitionError('model', `the local model server does not have the default model '${model}': pull it into the server, or choose one it has (ask model <name>; type ask to list them)`)
  }
  if (res.status === 404 && model !== null) return new CognitionError('model', `the local model server has no model '${model}': type ask to list the ones it has`)
  if (res.status === 400 && /does not support generate/i.test(said)) return new CognitionError('model', `the model '${model}' does not write text: choose another (type ask to list them)`)
  if (res.status === 400 && /does not support think/i.test(said)) return new CognitionError('model', `the model '${model}' does not think before it answers: ask think off`)
  return new CognitionError('server', `the local model server failed (${res.status})${said ? `: ${sentence(said)}` : ''}`)
}

/** A request that failed before any answer: the signal's own reason if it aborted, else what the server's state was. */
async function unreachable(fetchFn: FetchLike, server: string, signal: AbortSignal | undefined, error: unknown): Promise<unknown> {
  if (signal?.aborted) return signal.reason
  if (error instanceof DOMException && error.name === 'AbortError') return error
  return diagnose(fetchFn, server)
}

/**
 * Reads a streamed answer's body line by line, calling `line` with each; every read races `signal`, so the answer
 * stops the moment it aborts, whatever the body does (the reader is then cancelled, which closes the request if the
 * fetch has not already). Resolves when `line` says the answer is done, or when the body ends and `ended` says it
 * already was; rejects with the signal's reason once it aborts, with what `line` threw, or because the server
 * stopped short.
 */
export async function readLines(res: Response, signal: AbortSignal | undefined, line: (raw: string) => boolean, ended: () => boolean = () => false): Promise<void> {
  if (!res.body) throw new CognitionError('unreadable', "the local model server's answer could not be read")
  const reader = res.body.getReader()
  const stopped = signal ? new Promise<never>((_, reject) => {
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) : null
  stopped?.catch(() => {})
  const read = () => (stopped ? Promise.race([reader.read(), stopped]) : reader.read())
  const decoder = new TextDecoder()
  let buffered = ''
  try {
    for (;;) {
      const { value, done } = await read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const raw = buffered.slice(0, nl)
        buffered = buffered.slice(nl + 1)
        if (line(raw)) {
          void reader.cancel().catch(() => {})
          return
        }
      }
    }
    buffered += decoder.decode()
    if (line(buffered) || ended()) return
    throw new CognitionError('unreadable', 'the local model server stopped before the answer was done')
  } catch (e) {
    void reader.cancel().catch(() => {})
    if (signal?.aborted) throw signal.reason
    throw e
  }
}

/** POSTs a JSON body to a loopback server's path, turning a failure to reach it into one sentence. */
async function post(fetchFn: FetchLike, server: string, path: string, body: string, signal: AbortSignal | undefined, model: string, accept?: string): Promise<Response> {
  let res: Response
  try {
    res = await fetchFn(`${server}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json', ...(accept && { accept }) }, body, signal, cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  } catch (e) {
    throw await unreachable(fetchFn, server, signal, e)
  }
  if (!res.ok) throw await httpFailure(res, model)
  return res
}

/** What both wire formats take. */
export interface AnswerRequest { server: string; model: string; system: string; prompt: string; signal?: AbortSignal; think?: boolean }

/**
 * One streamed answer in the generate format: POSTs the prompt to `server` + /api/generate (the server must be a
 * loopback address, or nothing is sent) and reads the NDJSON it streams back line by line, calling `onPiece` with each
 * piece of thinking and each piece of text as it arrives. Resolves with the whole answer when the server says it is
 * done; rejects with a CognitionError for anything the server or the network did, or with the signal's reason the
 * moment it aborts (the request is cancelled with it). A piece `onPiece` refuses (it throws) ends the answer there,
 * with that error.
 */
export async function generate(fetchFn: FetchLike, req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> {
  const server = loopbackServer(req.server)
  if (server === null) throw new CognitionError('refused', `not a server on this machine: ${String(req.server)}`)
  // `think` is always sent: false asks a thinking model to answer without reasoning first (a model that cannot think
  // accepts it), true asks for its reasoning (streamed as thinking pieces).
  const body = JSON.stringify({
    model: req.model, system: req.system, prompt: req.prompt, stream: true, think: req.think === true,
    options: { num_ctx: CONTEXT_TOKENS, num_predict: ANSWER_TOKENS },
  })
  const res = await post(fetchFn, server, '/api/generate', body, req.signal, req.model)
  let text = '', thinking = 0, tokens = 0, reason = ''
  const line = (raw: string): boolean => {
    if (!raw.trim()) return false
    let o: { response?: unknown; thinking?: unknown; done?: unknown; done_reason?: unknown; eval_count?: unknown; error?: unknown }
    try {
      o = JSON.parse(raw)
    } catch {
      throw new CognitionError('unreadable', "the local model server's answer could not be read")
    }
    if (typeof o.error === 'string') throw new CognitionError('server', `the local model server failed: ${sentence(o.error)}`)
    if (typeof o.thinking === 'string' && o.thinking) {
      thinking++
      onPiece({ kind: 'thinking', text: o.thinking })
    }
    if (typeof o.response === 'string' && o.response) {
      text += o.response
      onPiece({ kind: 'text', text: o.response })
    }
    if (o.done === true) {
      reason = typeof o.done_reason === 'string' ? o.done_reason : 'stop'
      tokens = typeof o.eval_count === 'number' ? o.eval_count : 0
      return true
    }
    return false
  }
  await readLines(res, req.signal, line)
  return { text, thinking, tokens, reason }
}

/**
 * One streamed answer in the chat format (OpenAI-compatible): POSTs a system and a user message to `server` +
 * /v1/chat/completions (loopback only, as generate) and reads the server-sent events back: each `data:` line is a
 * chunk whose first choice's delta carries text (`content`) or thinking (`reasoning_content` or `reasoning`, as
 * servers name it); `data: [DONE]` ends it (a server that closes after the finish reason without it is done too).
 * The context window is the server's own; `think` is not sent (the server decides). Resolves and rejects as generate.
 */
export async function chat(fetchFn: FetchLike, req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> {
  const server = loopbackServer(req.server)
  if (server === null) throw new CognitionError('refused', `not a server on this machine: ${String(req.server)}`)
  const body = JSON.stringify({
    model: req.model,
    messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }],
    stream: true, max_tokens: ANSWER_TOKENS, stream_options: { include_usage: true },
  })
  const res = await post(fetchFn, server, '/v1/chat/completions', body, req.signal, req.model, 'text/event-stream')
  let text = '', thinking = 0, tokens = 0, reason = ''
  const line = (raw: string): boolean => {
    const t = raw.trim()
    // Blank lines end an event; comments, event names and ids carry nothing an answer needs.
    if (!t.startsWith('data:')) return false
    const data = t.slice(5).trim()
    if (data === '[DONE]') {
      if (!reason) reason = 'stop'
      return true
    }
    type Delta = { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
    let o: { choices?: { delta?: Delta; finish_reason?: unknown }[]; usage?: { completion_tokens?: unknown }; error?: unknown }
    try {
      o = JSON.parse(data)
    } catch {
      throw new CognitionError('unreadable', "the local model server's answer could not be read")
    }
    const e = o.error
    if (e !== undefined && e !== null) {
      const said = typeof e === 'string' ? e : typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : 'an error'
      throw new CognitionError('server', `the local model server failed: ${sentence(said)}`)
    }
    const choice = Array.isArray(o.choices) ? o.choices[0] : undefined
    const d = choice?.delta
    const think = typeof d?.reasoning_content === 'string' ? d.reasoning_content : typeof d?.reasoning === 'string' ? d.reasoning : ''
    if (think) {
      thinking++
      onPiece({ kind: 'thinking', text: think })
    }
    if (typeof d?.content === 'string' && d.content) {
      text += d.content
      onPiece({ kind: 'text', text: d.content })
    }
    if (typeof choice?.finish_reason === 'string' && choice.finish_reason) reason = choice.finish_reason
    if (typeof o.usage?.completion_tokens === 'number') tokens = o.usage.completion_tokens
    return false
  }
  await readLines(res, req.signal, line, () => reason !== '')
  return { text, thinking, tokens, reason }
}

/** The models the server has, by name, sorted: /api/tags (generate) or /v1/models (chat). */
export async function installedModels(fetchFn: FetchLike, server: string, signal?: AbortSignal, api: WireFormat = DEFAULT_API): Promise<string[]> {
  const origin = loopbackServer(server)
  if (origin === null) throw new CognitionError('refused', `not a server on this machine: ${String(server)}`)
  let res: Response
  try {
    res = await fetchFn(`${origin}${api === 'chat' ? '/v1/models' : '/api/tags'}`, { signal, cache: 'no-store', referrerPolicy: 'no-referrer' })
  } catch (e) {
    throw await unreachable(fetchFn, origin, signal, e)
  }
  if (!res.ok) throw await httpFailure(res, null)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new CognitionError('unreadable', "the local model server's list of models could not be read")
  }
  const models = api === 'chat' ? (body as { data?: unknown }).data : (body as { models?: unknown }).models
  if (!Array.isArray(models)) throw new CognitionError('unreadable', "the local model server's list of models could not be read")
  const key = api === 'chat' ? 'id' : 'name'
  return models.map((m) => (m as Record<string, unknown>)[key]).filter((n): n is string => typeof n === 'string').sort()
}

/** Where the settings are kept between visits (the page's local storage in the product; a stand-in in the tests). */
export interface SettingsStore {
  load(): string | null
  save(json: string): void
}

/**
 * The local model as the operator tier uses it (operator.ts Mind): the server's address (a loopback address; the
 * default unless the operator set one), its wire format (generate unless the operator chose chat), the model (DEFAULT_MODEL unless the operator chose another) and whether it
 * thinks before it answers (off unless the operator turns it on: a small model on a modest machine can spend minutes,
 * and all of its tokens, reasoning about a one-line question), all kept in `store`; the models the server has; and
 * answers. `defaults` are another server's own (the router's llama.cpp provider: its port, its one model, the chat
 * format); the Ollama API's are used without them.
 */
export function createLocalCompute({ fetch: fetchFn, store, defaults = {} }: { fetch: FetchLike; store?: SettingsStore; defaults?: { server?: string; model?: string; api?: WireFormat } }): Mind {
  const defaultServer = loopbackServer(defaults.server) ?? DEFAULT_SERVER
  const defaultModel = defaults.model?.trim() || DEFAULT_MODEL
  const defaultApi: WireFormat = isWireFormat(defaults.api) ? defaults.api : DEFAULT_API
  let server = defaultServer
  let model: string = defaultModel
  let think = false
  let api: WireFormat = defaultApi
  try {
    const saved: unknown = JSON.parse(store?.load() ?? 'null')
    if (typeof saved === 'object' && saved !== null) {
      const s = saved as { server?: unknown; model?: unknown; think?: unknown; api?: unknown }
      server = loopbackServer(s.server) ?? defaultServer
      model = typeof s.model === 'string' && s.model.trim() ? s.model.trim() : defaultModel
      think = s.think === true
      api = isWireFormat(s.api) ? s.api : defaultApi
    }
  } catch {
    // nothing kept, or not readable: the defaults
  }
  const keep = (): void => {
    try {
      store?.save(JSON.stringify({ v: 1, server, model, think, api }))
    } catch {
      // storage refused: the settings last for this visit
    }
  }
  return Object.freeze({
    settings: () => ({ server, model, think, api }),
    setServer: (url: string): string => {
      const origin = loopbackServer(url)
      if (origin === null) throw new Error(`the local model server must be on this machine (localhost, 127.0.0.1 or [::1]), not '${String(url)}'`)
      server = origin
      keep()
      return server
    },
    setModel: (name: string): string => {
      const n = typeof name === 'string' ? name.trim() : ''
      if (!n) throw new Error('name the model, e.g. ask model <name> (type ask to list them)')
      model = n
      keep()
      return model
    },
    setApi: (format: string): WireFormat => {
      if (!isWireFormat(format)) throw new TypeError(`ask api takes ${WIRE_FORMATS.join(' or ')}`)
      api = format
      keep()
      return api
    },
    setThink: (on: boolean): boolean => {
      think = on === true
      keep()
      return think
    },
    installed: (signal?: AbortSignal) => installedModels(fetchFn, server, signal, api),
    answer: (req: { tethers: readonly GateTether[]; prompt: string; signal: AbortSignal; memories?: readonly Memories[] }, onPiece: (p: Piece) => void): Promise<Answer> => {
      const system = systemPrompt(req.tethers, req.memories)
      const r = { server, model, system, prompt: req.prompt, signal: req.signal, think }
      // The hash of the exact string sent, for the audit: computed here, over `system` as it goes into the request.
      return (api === 'chat' ? chat(fetchFn, r, onPiece) : generate(fetchFn, r, onPiece)).then((a) => ({ ...a, promptHash: promptHash(system) }))
    },
  })
}
