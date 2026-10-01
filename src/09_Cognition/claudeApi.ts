/**
 * Why does this file exist? It is the Claude provider of the cognition router (router.ts): a streaming client for the
 * Claude Messages API, the default engine for testing, spoken to only through a gateway the operator runs on this
 * machine (a reverse proxy at http://localhost:8089 unless `ask server` names another loopback address) with a key
 * the operator gives the console (ask key <key>; kept in this browser's local storage, never in the page). Like every
 * client in the product it addresses a loopback origin and nothing else: the gate is 02_Define_The_Rules/airgap.ts,
 * and the page's own fetch refuses anything off this machine besides. It sends the same system prompt as the local
 * providers (the agent's persona: 02_Define_The_Rules/conduct.ts core, then localCompute.ts systemPrompt), reads the
 * server-sent events back (thinking summaries and text as pieces, the stop reason, the output tokens), stops the
 * moment the task's signal aborts, and turns every failure into one plain sentence, like the local client. A refusal
 * by the model's own safeguards ends the answer with the reason 'refusal', which the operator tier treats as the agent
 * not engaging.
 * What breaks if it is removed? `ask provider claude` has nothing behind it; the local providers are untouched.
 */
import { loopbackServer } from '../02_Define_The_Rules/airgap.ts'
import type { Answer, Piece } from '../07_Execute_Actions/operator.ts'
import { CognitionError, readLines, sentence, type FetchLike } from './localCompute.ts'

/**
 * Where the operator's gateway to the Claude API listens unless `ask server` names another loopback address: a reverse
 * proxy on this machine that forwards /v1/messages and /v1/models to the API. No gateway ships with the product.
 */
export const CLAUDE_GATEWAY = 'http://localhost:8089'
/** The model asked unless the operator chooses another (ask model <name>). */
export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5'
/** The API version every request names. */
export const ANTHROPIC_VERSION = '2023-06-01'
/** Betas the request opts into: the server-side refusal fallback, so a safeguard decline is retried on a fallback model in the same call. */
export const ANTHROPIC_BETAS = 'server-side-fallback-2026-07-01'
/** The longest answer, thinking included, tokens. */
export const CLAUDE_ANSWER_TOKENS = 4096
/** How hard the model works on an answer (output_config.effort); the API's own default when unset. */
export const EFFORTS: readonly string[] = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max'])
export const isEffort = (v: unknown): v is string => typeof v === 'string' && EFFORTS.includes(v)

/**
 * The gateway's address as an origin, if the provider may speak to it: http or https to a loopback address only
 * (localhost, 127.0.0.0/8, [::1]), no user name or password. Null for anything else. The gate itself
 * (airgap.ts loopbackServer) under the name this provider has always used.
 */
export const claudeServer: (url: unknown) => string | null = loopbackServer

/** A key as the console shows it: its first six and last four characters, never the whole. */
export function maskKey(key: string | null): string | null {
  if (!key) return null
  return key.length <= 12 ? '••••' : `${key.slice(0, 6)}…${key.slice(-4)}`
}

const headers = (key: string): Record<string, string> => ({
  'content-type': 'application/json',
  'x-api-key': key,
  'anthropic-version': ANTHROPIC_VERSION,
  'anthropic-beta': ANTHROPIC_BETAS,
  // The page itself calls the API: the browser's cross-origin request is only allowed with this header.
  'anthropic-dangerous-direct-browser-access': 'true',
})

/** A non-2xx answer as one sentence, from the API's own error object when it sends one. */
async function httpFailure(res: Response, model: string | null): Promise<CognitionError> {
  let said = ''
  let type = ''
  try {
    const body: unknown = JSON.parse(await res.text())
    const e = typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined
    if (typeof e === 'object' && e !== null) {
      const o = e as { message?: unknown; type?: unknown }
      if (typeof o.message === 'string') said = o.message
      if (typeof o.type === 'string') type = o.type
    }
  } catch {
    // not JSON: the status alone
  }
  const tail = said ? `: ${sentence(said)}` : ''
  if (res.status === 401) return new CognitionError('refused', `the Claude API did not accept the key (401)${tail}; set it with ask key <key>`)
  if (res.status === 403) return new CognitionError('refused', `the Claude API refused this request (403)${tail}`)
  if (res.status === 404 && model !== null && type === 'not_found_error') return new CognitionError('model', `the Claude API has no model '${model}': choose one it lists (type ask)`)
  if (res.status === 404) return new CognitionError('server', `the Claude API answered 404${tail}`)
  if (res.status === 429) return new CognitionError('server', `the Claude API is rate limiting this key (429)${tail}; try again in a moment`)
  if (res.status === 529) return new CognitionError('server', `the Claude API is overloaded (529); try again in a moment`)
  return new CognitionError('server', `the Claude API failed (${res.status})${tail}`)
}

/** A request that failed before any answer: the signal's own reason if it aborted, else the network. */
function unreachable(server: string, signal: AbortSignal | undefined, error: unknown): unknown {
  if (signal?.aborted) return signal.reason
  if (error instanceof DOMException && error.name === 'AbortError') return error
  return new CognitionError('offline', `no gateway to the Claude API is answering at ${server}: start one on this machine (ask server <url>), or ask provider ollama for a model on this machine`)
}

export interface ClaudeRequest {
  server: string
  key: string
  model: string
  system: string
  prompt: string
  signal?: AbortSignal
  /** output_config.effort; absent: the API's default for the model. */
  effort?: string
}

/**
 * One streamed answer: POSTs the system prompt and the prompt as one user message to the gateway at `server` + /v1/messages with
 * `stream: true` and reads the server-sent events back, calling `onPiece` with each thinking summary and each piece of
 * text as it arrives. Resolves when the message stops: 'stop' (end_turn), 'length' (max_tokens), 'refusal' (the
 * model's safeguards declined, whichever model ran), or the API's own word. Rejects with a CognitionError for anything
 * the API or the network did, or with the signal's reason the moment it aborts (the request is cancelled with it).
 */
export async function claudeAnswer(fetchFn: FetchLike, req: ClaudeRequest, onPiece: (p: Piece) => void): Promise<Answer> {
  const server = claudeServer(req.server)
  if (server === null) throw new CognitionError('refused', `the Claude provider speaks only to a gateway on this machine (localhost, 127.0.0.1 or [::1]), not '${String(req.server)}'`)
  if (!req.key) throw new CognitionError('refused', 'no API key is set: ask key <key>, or ask provider ollama for a model on this machine')
  const body = JSON.stringify({
    model: req.model,
    max_tokens: CLAUDE_ANSWER_TOKENS,
    stream: true,
    system: req.system,
    messages: [{ role: 'user', content: req.prompt }],
    thinking: { type: 'adaptive', display: 'summarized' },
    ...(req.effort && { output_config: { effort: req.effort } }),
    fallbacks: 'default',
  })
  let res: Response
  try {
    res = await fetchFn(`${server}/v1/messages`, {
      method: 'POST', headers: { ...headers(req.key), accept: 'text/event-stream' }, body, signal: req.signal, cache: 'no-store', referrerPolicy: 'no-referrer',
    })
  } catch (e) {
    throw unreachable(server, req.signal, e)
  }
  if (!res.ok) throw await httpFailure(res, req.model)
  let text = '', thinking = 0, tokens = 0, reason = ''
  const line = (raw: string): boolean => {
    const t = raw.trim()
    // Blank lines end an event; the event name repeats the data's own type.
    if (!t.startsWith('data:')) return false
    let o: {
      type?: unknown
      delta?: { type?: unknown; text?: unknown; thinking?: unknown; stop_reason?: unknown }
      usage?: { output_tokens?: unknown }
      error?: { type?: unknown; message?: unknown }
    }
    try {
      o = JSON.parse(t.slice(5).trim())
    } catch {
      throw new CognitionError('unreadable', "the Claude API's answer could not be read")
    }
    if (o.type === 'error') {
      const said = typeof o.error?.message === 'string' ? o.error.message : 'an error'
      throw new CognitionError('server', `the Claude API failed mid-answer: ${sentence(said)}`)
    }
    if (o.type === 'content_block_delta') {
      const d = o.delta
      if (d?.type === 'thinking_delta' && typeof d.thinking === 'string' && d.thinking) {
        thinking++
        onPiece({ kind: 'thinking', text: d.thinking })
      } else if (d?.type === 'text_delta' && typeof d.text === 'string' && d.text) {
        text += d.text
        onPiece({ kind: 'text', text: d.text })
      }
      return false
    }
    if (o.type === 'message_delta') {
      const r = o.delta?.stop_reason
      if (typeof r === 'string' && r) reason = r === 'end_turn' ? 'stop' : r === 'max_tokens' ? 'length' : r
      if (typeof o.usage?.output_tokens === 'number') tokens = o.usage.output_tokens
      return false
    }
    if (o.type === 'message_stop') {
      if (!reason) reason = 'stop'
      return true
    }
    return false
  }
  await readLines(res, req.signal, line, () => reason !== '')
  return { text, thinking, tokens, reason }
}

/** The models the API lists for this key (through the gateway), by id, sorted. */
export async function claudeModels(fetchFn: FetchLike, server: string, key: string, signal?: AbortSignal): Promise<string[]> {
  const origin = claudeServer(server)
  if (origin === null) throw new CognitionError('refused', `the Claude provider speaks only to a gateway on this machine (localhost, 127.0.0.1 or [::1]), not '${String(server)}'`)
  if (!key) throw new CognitionError('refused', 'no API key is set: ask key <key>, or ask provider ollama for a model on this machine')
  let res: Response
  try {
    res = await fetchFn(`${origin}/v1/models?limit=100`, { headers: headers(key), signal, cache: 'no-store', referrerPolicy: 'no-referrer' })
  } catch (e) {
    throw unreachable(origin, signal, e)
  }
  if (!res.ok) throw await httpFailure(res, null)
  let body: unknown
  try {
    body = await res.json()
  } catch {
    throw new CognitionError('unreadable', "the Claude API's list of models could not be read")
  }
  const models = (body as { data?: unknown }).data
  if (!Array.isArray(models)) throw new CognitionError('unreadable', "the Claude API's list of models could not be read")
  return models.map((m) => (m as Record<string, unknown>).id).filter((n): n is string => typeof n === 'string').sort()
}
