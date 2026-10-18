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
import type { AgentContext, Answer, AnswerRequest as MindRequest, GateTether, Memories, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { contextSection } from '../08_Swarm/shortTerm.ts'

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
 * The model asked of an Ollama server unless the operator chooses another (ask model <name>): Qwen3-VL 4B, an
 * open-weights model under Apache-2.0 that writes text and shows its thinking. A server without it says so in one
 * sentence; the router's auto provider gives such a server the first text model it has instead (router.ts).
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
/**
 * How long a server may send nothing at all before the request is given up, ms: long enough for a server to load a
 * model from a slow disk and read the prompt on a modest machine (a 4B model took 51 s for a whole answer on an
 * integrated GPU), short enough that a server that will never answer does not hold `ask` until the operator stops it.
 */
export const FIRST_PIECE_MS = 300_000
/** How long a server may go quiet in the middle of an answer before it is given up, ms. */
export const STALL_MS = 120_000
/**
 * The model name the chat format sends when the operator has not chosen one (the router's llama.cpp and OpenAI-compatible
 * providers start with it): before the first answer the client asks the server which models it lists and sends the
 * first that writes text, in the server's own order, since a server that serves several (LM Studio, vLLM) refuses a
 * name it does not know.
 */
export const ANY_MODEL = 'default'
/** Names a server lists for models that write no text (embeddings, rerankers, speech): never sent a prompt. */
const NOT_TEXT = /embed|rerank|bge|minilm|whisper|paraphrase|(^|[-_.:])(e5|gte)([-_.:]|$)/i
/** Ollama's names for models it runs on its own cloud (`gpt-oss:120b-cloud`, `kimi-k3:cloud`): a prompt to one leaves the machine. */
const CLOUD = /[:-]cloud$/i
/**
 * Whether a model a server lists, by its name, writes text on this machine: not an embedding, reranking or speech
 * model, and not one Ollama runs on its cloud. Only such a model is ever chosen without the operator naming it. A
 * llama.cpp server started without an alias lists the model's file path: only its last part is the model's name.
 */
export const localText = (name: string): boolean => !NOT_TEXT.test(name.slice(Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\')) + 1)) && !CLOUD.test(name)

/**
 * LM Studio's own list of models (/api/v0/models), which says which are loaded and which kind each is: with its
 * just-in-time loading on (its default), the OpenAI-compatible list holds every model downloaded, and sending the
 * first would load a second model beside the one the operator loaded. The first loaded model that writes text, else
 * the first that writes text; null for any server that does not answer it (llama.cpp, vLLM, a proxy) or lists none;
 * LATE for one that has not answered within `ms` (busy, or a browser still asking whether this page may reach it), which
 * may yet be LM Studio. Only the operator's stop (`signal`) ends the answer.
 */
async function lmStudioPick(fetchFn: FetchLike, server: string, signal: AbortSignal, ms: number): Promise<string | null | typeof LATE> {
  try {
    const res = await fetchFn(`${server}/api/v0/models`, { signal: AbortSignal.any([signal, AbortSignal.timeout(ms)]), cache: 'no-store', referrerPolicy: 'no-referrer' })
    if (!res.ok) return null
    const data = ((await res.json()) as { data?: unknown }).data
    if (!Array.isArray(data)) return null
    const text = data.filter((m): m is { id: string; state?: unknown } => {
      const e = m as { id?: unknown; type?: unknown; state?: unknown }
      return typeof e.id === 'string' && typeof e.state === 'string' && (e.type === 'llm' || e.type === 'vlm') && localText(e.id)
    })
    return (text.find((m) => m.state === 'loaded') ?? text[0])?.id ?? null
  } catch (e) {
    if (signal.aborted) throw signal.reason
    return e instanceof DOMException && e.name === 'TimeoutError' ? LATE : null
  }
}
/** lmStudioPick's answer for a server that did not say within its wait whether it is LM Studio. */
const LATE: unique symbol = Symbol('late')
/** Longest server message kept in a sentence. */
const MESSAGE_CHARS = 160
/** How long a server has to list its models when the chat format asks which one to send, ms (each list asked). */
export const LIST_MS = 10_000

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
export type CognitionFailure = 'offline' | 'refused' | 'model' | 'server' | 'unreadable' | 'timeout'

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
  'You may be told where you stand right now and what just happened between you and the player: speak from that place and moment, as someone who was there.',
  'Be brief and practical. Plain text: no headings, no tables.',
].join('\n')

/** What follows the base reality when nobody is bound to the request: the expertise rule has no one to apply to. */
export const NO_ONE_BOUND = "No one is tethered for this request: you speak as the city's guide, and the expertise rule above does not apply."

/**
 * The system prompt for an answer given for the people a task is bound to: the base reality, then who they are, the
 * skills they bring as the whole of the expertise, and what each remembers of the operator (oldest first; only the
 * people bound, only what the memory gave). The same people with the same memories always give the same prompt.
 */
export function systemPrompt(tethers: readonly GateTether[], memories: readonly Memories[] = [], context: readonly AgentContext[] = []): string {
  // Nobody bound (the onboarding's guide rewording a line): no person and no expertise to name, so none is invented.
  if (!tethers.length) return [BASE_REALITY, NO_ONE_BOUND].join('\n')
  const skills = [...new Set(tethers.flatMap((t) => t.skills))]
  const who = tethers.map((t) => `agent ${t.agent} (${t.skills.join(', ')})`).join(' and ')
  const history = memories
    .filter((m) => m.lines.length > 0 && tethers.some((t) => t.agent === m.agent))
    .flatMap((m) => [`Agent ${m.agent} remembers, oldest first:`, ...m.lines.map((l) => `- ${l}`)])
  // The here and now last (08_Swarm/shortTerm.ts): it changes every moment, so it must not break the cached prefix.
  const now = contextSection(tethers.map((t) => t.agent), context)
  return [
    BASE_REALITY,
    `You are answering for ${who}.`,
    `Your expertise is exactly: ${skills.join(', ')}.`,
    ...history,
    ...now,
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

/** Whether this page is cross-origin isolated (the launcher, the preview, the Windows app, the installed web copy). */
export const isolatedPage = (): boolean => (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true
/**
 * On an isolated page, what a server that seems not to be running may be instead: the opaque request below cannot
 * reach a server that sends no Cross-Origin-Resource-Policy, so a server refusing this page's origin looks the same.
 */
export const ISOLATED_HINT = "if it is running, it may be refusing this page's origin, which looks the same from here (Ollama: add this page's origin to OLLAMA_ORIGINS)"

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
    return new CognitionError('offline', `no local model server is answering at ${server}: start it, or point ask at the right address (ask server <url>)${isolatedPage() ? `; ${ISOLATED_HINT}` : ''}`)
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

/** How long a request may wait for its server (FIRST_PIECE_MS, STALL_MS; shorter in the tests). */
export interface Timeouts { readonly firstMs: number; readonly stallMs: number; readonly listMs?: number }
export const TIMEOUTS: Timeouts = Object.freeze({ firstMs: FIRST_PIECE_MS, stallMs: STALL_MS, listMs: LIST_MS })

/** A span of milliseconds in words: "5 minutes", "1 minute", "90 s". */
const span = (ms: number): string => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${Math.round(ms / 1000)} s`)

/**
 * A request's watch: a signal that aborts when `signal` does, and with a 'timeout' CognitionError when the server sends
 * nothing for `firstMs` from the start or, once it has begun, nothing for `stallMs`. `beat` says something arrived;
 * `end` clears the timer (the request is over, however it ended).
 */
function watch(server: string, signal: AbortSignal | undefined, t: Timeouts): { signal: AbortSignal; beat(): void; end(): void } {
  const ctl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, why: string): void => {
    clearTimeout(timer)
    timer = setTimeout(() => ctl.abort(new CognitionError('timeout', why)), ms)
  }
  arm(t.firstMs, `the model server at ${server} sent nothing for ${span(t.firstMs)}: it may still be loading the model (ask again), or the model is too big for this machine (ask model <name> for a smaller one)`)
  return {
    signal: signal ? AbortSignal.any([signal, ctl.signal]) : ctl.signal,
    beat: () => arm(t.stallMs, `the model server at ${server} went quiet for ${span(t.stallMs)} in the middle of the answer`),
    end: () => clearTimeout(timer),
  }
}

/** What both wire formats take. */
export interface AnswerRequest { server: string; model: string; system: string; prompt: string; signal?: AbortSignal; think?: boolean; timeouts?: Timeouts }

/**
 * One streamed answer in the generate format: POSTs the prompt to `server` + /api/generate (the server must be a
 * loopback address, or nothing is sent) and reads the NDJSON it streams back line by line, calling `onPiece` with each
 * piece of thinking and each piece of text as it arrives. Resolves with the whole answer when the server says it is
 * done; rejects with a CognitionError for anything the server or the network did ('timeout' when it sends nothing for
 * FIRST_PIECE_MS, or goes quiet for STALL_MS once it has begun), or with the signal's reason the moment it aborts (the
 * request is cancelled with it). A piece `onPiece` refuses (it throws) ends the answer there, with that error.
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
  // The first-piece wait runs until the first line of the body: a server may send its headers at once and only then
  // load the model and read the prompt.
  const w = watch(server, req.signal, req.timeouts ?? TIMEOUTS)
  try {
    const res = await post(fetchFn, server, '/api/generate', body, w.signal, req.model)
    return await generated(res, w, onPiece)
  } finally {
    w.end()
  }
}

/** The generate format's NDJSON answer, read under its request's watch. */
async function generated(res: Response, w: { signal: AbortSignal; beat(): void }, onPiece: (p: Piece) => void): Promise<Answer> {
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
  await readLines(res, w.signal, (raw) => { w.beat(); return line(raw) })
  return { text, thinking, tokens, reason }
}

/**
 * One streamed answer in the chat format (OpenAI-compatible): POSTs a system and a user message to `server` +
 * /v1/chat/completions (loopback only, as generate) and reads the server-sent events back: each `data:` line is a
 * chunk whose first choice's delta carries text (`content`) or thinking (`reasoning_content` or `reasoning`, as
 * servers name it); `data: [DONE]` ends it (a server that closes after the finish reason without it is done too).
 * The context window is the server's own; `think` is not sent (the server decides). Resolves and rejects as generate,
 * including its timeouts.
 */
export async function chat(fetchFn: FetchLike, req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> {
  const server = loopbackServer(req.server)
  if (server === null) throw new CognitionError('refused', `not a server on this machine: ${String(req.server)}`)
  const body = JSON.stringify({
    model: req.model,
    messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.prompt }],
    stream: true, max_tokens: ANSWER_TOKENS, stream_options: { include_usage: true },
  })
  const w = watch(server, req.signal, req.timeouts ?? TIMEOUTS)
  try {
    const res = await post(fetchFn, server, '/v1/chat/completions', body, w.signal, req.model, 'text/event-stream')
    return await chatted(res, w, onPiece)
  } finally {
    w.end()
  }
}

/** The chat format's server-sent events, read under its request's watch. */
async function chatted(res: Response, w: { signal: AbortSignal; beat(): void }, onPiece: (p: Piece) => void): Promise<Answer> {
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
  await readLines(res, w.signal, (raw) => { w.beat(); return line(raw) }, () => reason !== '')
  return { text, thinking, tokens, reason }
}

/** The models the server has, by name, sorted (or in the server's own order): /api/tags (generate) or /v1/models (chat). */
export async function installedModels(fetchFn: FetchLike, server: string, signal?: AbortSignal, api: WireFormat = DEFAULT_API, sorted = true, onMachine = false): Promise<string[]> {
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
  // `onMachine`: not the models Ollama runs on its own cloud, which its own list marks with where they run, whatever
  // they are called (a cloud model copied under another name, one offered only there).
  const here = onMachine && api !== 'chat' ? models.filter((m) => !remote(m)) : models
  const names = here.map((m) => (m as Record<string, unknown>)[key]).filter((n): n is string => typeof n === 'string')
  return sorted ? names.sort() : names
}

/** Whether an entry of Ollama's list (/api/tags) is one of its cloud models: it names the host or model it runs as. */
const remote = (m: unknown): boolean => {
  const e = m as { remote_host?: unknown; remote_model?: unknown } | null
  return (typeof e?.remote_host === 'string' && e.remote_host !== '') || (typeof e?.remote_model === 'string' && e.remote_model !== '')
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
 * format); the Ollama API's are used without them. In the chat format the model ANY_MODEL means the first one the
 * server lists that writes text, asked once per server (LM Studio: before every answer and at `ask` alone).
 */
export function createLocalCompute({ fetch: fetchFn, store, defaults = {}, timeouts = TIMEOUTS }: { fetch: FetchLike; store?: SettingsStore; defaults?: { server?: string; model?: string; api?: WireFormat }; timeouts?: Timeouts }): Mind {
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
  const listMs = timeouts.listMs ?? LIST_MS
  // ANY_MODEL in the chat format: the first model the server lists that writes text on this machine, in its own
  // order, for this server, asked before the first answer. LM Studio (`studio`) is asked again before every answer
  // and at `ask` alone, since the operator may load another model there at any time and its just-in-time loading
  // would load the old one again beside it rather than refuse it. A server that did not say in time whether it is
  // LM Studio ('unsure') is asked once more, at the next answer.
  let listed: { server: string; name: string; studio: boolean | 'unsure' } | null = null
  const modelFor = async (signal: AbortSignal): Promise<string> => {
    if (api !== 'chat' || model !== ANY_MODEL) return model
    const known = listed?.server === server ? listed : null
    if (known !== null && known.studio === false) return known.name
    // LM Studio says which model is loaded; any other server is asked its OpenAI-compatible list.
    const loaded = await lmStudioPick(fetchFn, server, signal, listMs)
    if (typeof loaded === 'string') {
      listed = { server, name: loaded, studio: true }
      return loaded
    }
    if (known !== null) {
      if (known.studio === 'unsure') listed = { ...known, studio: false }
      return known.name
    }
    let names: string[] = []
    try {
      names = await installedModels(fetchFn, server, AbortSignal.any([signal, AbortSignal.timeout(listMs)]), 'chat', false)
    } catch (e) {
      // Not running, or refusing this page: the answer would fail the same way, so it fails now. A server that lists
      // nothing it can be read from is sent the placeholder, and says itself what it makes of it.
      if (signal.aborted || (e instanceof CognitionError && (e.code === 'offline' || e.code === 'refused'))) throw e
    }
    const name = names.find(localText)
    if (name === undefined) return model
    listed = { server, name, studio: loaded === LATE ? 'unsure' : false }
    return name
  }
  return Object.freeze({
    // `resolved`: the model ANY_MODEL stands for on this server, once an answer has asked which it lists.
    settings: () => ({ server, model, think, api, ...(api === 'chat' && model === ANY_MODEL && listed?.server === server && { resolved: listed.name }) }),
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
    installed: async (signal?: AbortSignal) => {
      const names = await installedModels(fetchFn, server, signal, api)
      // `ask` alone: LM Studio says again which model is loaded, so the model row names the one the next answer sends.
      if (api === 'chat' && model === ANY_MODEL && listed?.server === server && listed.studio !== false) {
        const loaded = await lmStudioPick(fetchFn, server, signal ?? new AbortController().signal, listMs).catch(() => null)
        if (typeof loaded === 'string') listed = { server, name: loaded, studio: true }
      }
      return names
    },
    answer: async (req: MindRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      const system = systemPrompt(req.tethers, req.memories, req.context)
      const r = { server, model: await modelFor(req.signal), system, prompt: req.prompt, signal: req.signal, think, timeouts }
      try {
        // The hash of the exact string sent, for the audit: computed here, over `system` as it goes into the request.
        const a = await (api === 'chat' ? chat(fetchFn, r, onPiece) : generate(fetchFn, r, onPiece))
        return { ...a, promptHash: promptHash(system) }
      } catch (e) {
        // The listed model has gone (unloaded, renamed): the next answer asks the server again.
        if (e instanceof CognitionError && e.code === 'model') listed = null
        throw e
      }
    },
  })
}
