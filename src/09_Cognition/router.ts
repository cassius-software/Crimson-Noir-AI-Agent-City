/**
 * Why does this file exist? It is the cognition router: the one Mind the operator tier is handed (operator.ts Mind),
 * behind which any of three model providers answers, swapped at the console without a restart (ask provider <name>):
 * - `claude`: the Claude Messages API over the network (claudeApi.ts), the default for testing, with the key the
 *   operator gives the console;
 * - `ollama`: a local model server on this machine speaking the Ollama API (localCompute.ts generate);
 * - `llamacpp`: a packaged, quantized model under a llama.cpp server on this machine (localCompute.ts chat, the
 *   OpenAI-compatible format that server speaks), for offline environments.
 * Every provider answers with the same system prompt (the conduct core, the bound people's skills and memories), so a
 * swap changes nothing an agent is or knows. Each keeps its own server and model, remembered between visits in one
 * store; the local providers still only ever address a loopback server, and only the Claude provider may address the
 * network. The 14A screen is not here: it is applied once for every provider in the operator tier (gatedAsk), before
 * a prompt reaches this router.
 * What breaks if it is removed? `ask` has one provider and no way to swap it; an offline environment has no drop-in.
 */
import type { Answer, GateTether, Memories, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { CLAUDE_API, claudeAnswer, claudeModels, claudeServer, DEFAULT_CLAUDE_MODEL, EFFORTS, isEffort, maskKey } from './claudeApi.ts'
import { createLocalCompute, systemPrompt, type FetchLike, type SettingsStore } from './localCompute.ts'

export type Provider = 'claude' | 'ollama' | 'llamacpp'
export const PROVIDERS: readonly Provider[] = Object.freeze(['claude', 'ollama', 'llamacpp'])
/** The provider unless the operator chooses another: the Claude API, for testing. */
export const DEFAULT_PROVIDER: Provider = 'claude'
/** Where a llama.cpp server listens unless the operator says otherwise (its own default port). */
export const LLAMACPP_SERVER = 'http://localhost:8080'
/** llama.cpp serves the one model it was started with, whatever name a request gives. */
export const LLAMACPP_MODEL = 'default'
export const isProvider = (v: unknown): v is Provider => v === 'claude' || v === 'ollama' || v === 'llamacpp'

/** What the router keeps between visits: the provider, the Claude provider's own settings, and each local provider's. */
interface Kept {
  v: 2
  provider: Provider
  claude: { server: string; model: string; key: string | null; effort: string | null }
  ollama: string | null
  llamacpp: string | null
}

/** A view of one slice of the router's store, handed to a local provider as its own SettingsStore. */
function slice(kept: Kept, key: 'ollama' | 'llamacpp', keep: () => void): SettingsStore {
  return {
    load: () => kept[key],
    save: (json) => {
      kept[key] = json
      keep()
    },
  }
}

/**
 * The router as the operator tier uses it: a Mind whose settings are the chosen provider's, whose `installed` asks that
 * provider's server, and whose `answer` goes to it. `provider`, `key` and `effort` are the router's own settings; the
 * others (server, model, think, api) are the chosen provider's.
 */
export interface MindRouter extends Mind {
  setProvider(name: string): Provider
  /** Sets the Claude provider's key (empty clears it); returns it masked. */
  setKey(key: string): string | null
  /** Sets the Claude provider's effort (empty clears it); returns it. */
  setEffort(level: string): string | null
  readonly provider: Provider
}

export function createMindRouter({ fetch: fetchFn, store }: { fetch: FetchLike; store?: SettingsStore }): MindRouter {
  const kept: Kept = { v: 2, provider: DEFAULT_PROVIDER, claude: { server: CLAUDE_API, model: DEFAULT_CLAUDE_MODEL, key: null, effort: null }, ollama: null, llamacpp: null }
  try {
    const saved: unknown = JSON.parse(store?.load() ?? 'null')
    if (typeof saved === 'object' && saved !== null) {
      const s = saved as Partial<Kept> & { claude?: Partial<Kept['claude']> }
      if (isProvider(s.provider)) kept.provider = s.provider
      kept.claude.server = claudeServer(s.claude?.server) ?? CLAUDE_API
      if (typeof s.claude?.model === 'string' && s.claude.model.trim()) kept.claude.model = s.claude.model.trim()
      if (typeof s.claude?.key === 'string' && s.claude.key) kept.claude.key = s.claude.key
      if (isEffort(s.claude?.effort)) kept.claude.effort = s.claude.effort
      if (typeof s.ollama === 'string') kept.ollama = s.ollama
      if (typeof s.llamacpp === 'string') kept.llamacpp = s.llamacpp
    }
  } catch {
    // nothing kept, or not readable: the defaults
  }
  const keep = (): void => {
    try {
      store?.save(JSON.stringify(kept))
    } catch {
      // storage refused: the settings last for this visit
    }
  }
  const ollama = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'ollama', keep) })
  const llamacpp = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'llamacpp', keep), defaults: { server: LLAMACPP_SERVER, model: LLAMACPP_MODEL, api: 'chat' } })
  const local = (): Mind => (kept.provider === 'ollama' ? ollama : llamacpp)

  const claude: Mind = Object.freeze({
    settings: () => ({ server: kept.claude.server, model: kept.claude.model }),
    setServer: (url: string): string => {
      const origin = claudeServer(url)
      if (origin === null) throw new Error(`the Claude provider speaks only https, or http to a gateway on this machine, not '${String(url)}'`)
      kept.claude.server = origin
      keep()
      return origin
    },
    setModel: (name: string): string => {
      const n = typeof name === 'string' ? name.trim() : ''
      if (!n) throw new Error('name the model, e.g. ask model <name> (type ask to list them)')
      kept.claude.model = n
      keep()
      return n
    },
    installed: (signal?: AbortSignal) => claudeModels(fetchFn, kept.claude.server, kept.claude.key ?? '', signal),
    answer: (req: { tethers: readonly GateTether[]; prompt: string; signal: AbortSignal; memories?: readonly Memories[] }, onPiece: (p: Piece) => void): Promise<Answer> =>
      claudeAnswer(fetchFn, {
        server: kept.claude.server, key: kept.claude.key ?? '', model: kept.claude.model, system: systemPrompt(req.tethers, req.memories), prompt: req.prompt, signal: req.signal,
        ...(kept.claude.effort && { effort: kept.claude.effort }),
      }, onPiece),
  })
  const active = (): Mind => (kept.provider === 'claude' ? claude : local())

  const router: MindRouter = {
    get provider() {
      return kept.provider
    },
    settings: () => {
      const s = active().settings()
      const own = { provider: kept.provider, key: kept.provider === 'claude' ? maskKey(kept.claude.key) : undefined, effort: kept.provider === 'claude' ? kept.claude.effort ?? undefined : undefined }
      return { ...s, ...own }
    },
    setServer: (url: string) => active().setServer(url),
    setModel: (name: string) => active().setModel(name),
    setThink: (on: boolean): boolean => {
      const m = active()
      if (!m.setThink) throw new Error(`the ${kept.provider} provider has no think switch`)
      return m.setThink(on)
    },
    setApi: (format: string): string => {
      const m = active()
      if (!m.setApi) throw new Error(`the ${kept.provider} provider speaks one wire format only`)
      return m.setApi(format)
    },
    setProvider: (name: string): Provider => {
      const n = typeof name === 'string' ? name.trim().toLowerCase() : ''
      if (!isProvider(n)) throw new TypeError(`ask provider takes ${PROVIDERS.join(', ')}`)
      kept.provider = n
      keep()
      return n
    },
    setKey: (key: string): string | null => {
      const k = typeof key === 'string' ? key.trim() : ''
      kept.claude.key = k || null
      keep()
      return maskKey(kept.claude.key)
    },
    setEffort: (level: string): string | null => {
      const l = typeof level === 'string' ? level.trim().toLowerCase() : ''
      if (l && !isEffort(l)) throw new TypeError(`ask effort takes ${EFFORTS.join(', ')} (or none)`)
      kept.claude.effort = l || null
      keep()
      return kept.claude.effort
    },
    installed: (signal?: AbortSignal) => active().installed(signal),
    answer: (req, onPiece) => active().answer(req, onPiece),
  }
  return Object.freeze(router)
}
