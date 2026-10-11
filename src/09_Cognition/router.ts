// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the cognition router: the one Mind the operator tier is handed (operator.ts Mind),
 * behind which any of three model providers answers, swapped at the console without a restart (ask provider <name>):
 * - `claude`: the Claude Messages API through a gateway on this machine (claudeApi.ts), the default for testing,
 *   with the key the operator gives the console;
 * - `ollama`: a local model server on this machine speaking the Ollama API (localCompute.ts generate);
 * - `llamacpp`: a packaged, quantized model under a llama.cpp server on this machine (localCompute.ts chat, the
 *   OpenAI-compatible format that server speaks), for offline environments.
 * Every provider answers with the same system prompt (the conduct core, the bound people's skills and memories), so a
 * swap changes nothing an agent is or knows. Each keeps its own server and model, remembered between visits in one
 * store; every provider only ever addresses a loopback origin (02_Define_The_Rules/airgap.ts is the gate), so no
 * prompt leaves this machine from the page. The 14A screen is not here: it is applied once for every provider in the
 * operator tier (gatedAsk), before a prompt reaches this router.
 * What breaks if it is removed? `ask` has one provider and no way to swap it; an offline environment has no drop-in.
 */
import type { Answer, GateTether, Memories, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { CLAUDE_GATEWAY, claudeAnswer, claudeModels, claudeServer, DEFAULT_CLAUDE_MODEL, EFFORTS, isEffort, maskKey } from './claudeApi.ts'
import { BASE_REALITY, createLocalCompute, promptHash, systemPrompt, type FetchLike, type SettingsStore } from './localCompute.ts'
import { createPrefixCache } from './prefixCache.ts'

export type Provider = 'claude' | 'ollama' | 'llamacpp'
export const PROVIDERS: readonly Provider[] = Object.freeze(['claude', 'ollama', 'llamacpp'])
/** The provider unless the operator chooses another: the Claude API through a gateway on this machine, for testing. */
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
  /**
   * The cloud provider on its own (the Claude API through the gateway on this machine), whichever provider is chosen:
   * the cloud fallback throttle (cloudFallback.ts) hands complex prompts to it while the frames are slow.
   */
  readonly cloud: Mind
}

export function createMindRouter({ fetch: fetchFn, store }: { fetch: FetchLike; store?: SettingsStore }): MindRouter {
  const kept: Kept = { v: 2, provider: DEFAULT_PROVIDER, claude: { server: CLAUDE_GATEWAY, model: DEFAULT_CLAUDE_MODEL, key: null, effort: null }, ollama: null, llamacpp: null }
  try {
    const saved: unknown = JSON.parse(store?.load() ?? 'null')
    if (typeof saved === 'object' && saved !== null) {
      const s = saved as Partial<Kept> & { claude?: Partial<Kept['claude']> }
      if (isProvider(s.provider)) kept.provider = s.provider
      kept.claude.server = claudeServer(s.claude?.server) ?? CLAUDE_GATEWAY
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
  // The prompt-prefix page table (prefixCache.ts): asked before every answer, its counts are the `cache` setting.
  const cache = createPrefixCache({ prefix: BASE_REALITY })
  const agentKey = (tethers: readonly GateTether[]): string => [...new Set(tethers.map((t) => t.agent))].sort((a, b) => a - b).join('+')

  // The Claude provider answers with the hash of the exact system prompt it sent, as the local providers do (the
  // swarm's memory records it, so an audit can prove what the model was given).
  const claudeAnswerHashed = async (req: { tethers: readonly GateTether[]; prompt: string; signal: AbortSignal; memories?: readonly Memories[] }, onPiece: (p: Piece) => void): Promise<Answer> => {
    const system = systemPrompt(req.tethers, req.memories)
    const answer = await claudeAnswer(fetchFn, {
      server: kept.claude.server, key: kept.claude.key ?? '', model: kept.claude.model, system, prompt: req.prompt, signal: req.signal,
      ...(kept.claude.effort && { effort: kept.claude.effort }),
    }, onPiece)
    return { ...answer, promptHash: promptHash(system) }
  }
  const claude: Mind = Object.freeze({
    settings: () => ({ server: kept.claude.server, model: kept.claude.model }),
    setServer: (url: string): string => {
      const origin = claudeServer(url)
      if (origin === null) throw new Error(`the Claude provider speaks only to a gateway on this machine (localhost, 127.0.0.1 or [::1]), not '${String(url)}'`)
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
      claudeAnswerHashed(req, onPiece),
  })
  const active = (): Mind => (kept.provider === 'claude' ? claude : local())

  const router: MindRouter = {
    get provider() {
      return kept.provider
    },
    cloud: claude,
    settings: () => {
      const s = active().settings()
      const own = { provider: kept.provider, key: kept.provider === 'claude' ? maskKey(kept.claude.key) : undefined, effort: kept.provider === 'claude' ? kept.claude.effort ?? undefined : undefined }
      const line = cache.line()
      return { ...s, ...own, ...(line !== null && { cache: line }) }
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
    answer: async (req, onPiece) => {
      await cache.page(agentKey(req.tethers), systemPrompt(req.tethers, req.memories))
      return active().answer(req, onPiece)
    },
  }
  return Object.freeze(router)
}
