// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the cognition router: the one Mind the operator tier is handed (operator.ts Mind),
 * behind which any of five model providers answers, swapped at the console without a restart (ask provider <name>,
 * or in one line ask connect <provider> [<url>] [<key>]):
 * - `claude`: the Claude Messages API through a gateway on this machine (claudeApi.ts), the default for testing,
 *   with the key the operator gives the console;
 * - `ollama`: a local model server on this machine speaking the Ollama API (localCompute.ts generate);
 * - `llamacpp`: a packaged, quantized model under a llama.cpp server on this machine (localCompute.ts chat, the
 *   OpenAI-compatible format that server speaks), for offline environments;
 * - `openai`: any other server on this machine that speaks the OpenAI-compatible chat-completions format (LM Studio,
 *   vLLM, a loopback proxy), at its own address and with the model it lists; the same client as llamacpp, its own
 *   settings. OpenAI's own service is not one of them: the air gap admits loopback only;
 * - `scripted`: no backend at all; every answer is the deterministic script (scripted.ts), so the page is complete
 *   with nothing installed and nothing reaches any network.
 * Every provider answers with the same system prompt (the conduct core, the bound people's skills and memories), so a
 * swap changes nothing an agent is or knows. Each keeps its own server and model, remembered between visits in one
 * store; every provider only ever addresses a loopback origin (02_Define_The_Rules/airgap.ts is the gate), so no
 * prompt leaves this machine from the page. The 14A screen is not here: it is applied once for every provider in the
 * operator tier (gatedAsk), before a prompt reaches this router.
 * What breaks if it is removed? `ask` has one provider and no way to swap it; an offline environment has no drop-in.
 */
import type { Answer, AnswerRequest, GateTether, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { CLAUDE_GATEWAY, claudeAnswer, claudeModels, claudeServer, DEFAULT_CLAUDE_MODEL, EFFORTS, isEffort, maskKey } from './claudeApi.ts'
import { BASE_REALITY, createLocalCompute, promptHash, systemPrompt, type FetchLike, type SettingsStore } from './localCompute.ts'
import { createPrefixCache } from './prefixCache.ts'
import { SCRIPTED, scriptedAnswer } from './scripted.ts'

export type Provider = 'claude' | 'ollama' | 'llamacpp' | 'openai' | 'scripted'
export const PROVIDERS: readonly Provider[] = Object.freeze(['claude', 'ollama', 'llamacpp', 'openai', 'scripted'])
/** What each provider is, in the words the console prints after a swap. */
export const PROVIDER_TEXT: Readonly<Record<Provider, string>> = Object.freeze({
  claude: 'claude: the Claude API through a gateway on this machine (best with the key in the gateway; ask key <key> keeps one in this browser)',
  ollama: 'ollama: a model server on this machine (the Ollama API)',
  llamacpp: 'llamacpp: a packaged model under a llama.cpp server on this machine',
  openai: 'openai: an OpenAI-compatible server on this machine (LM Studio, vLLM, a loopback proxy; ask server <url> and ask model <name> point at it)',
  scripted: 'scripted: no backend; every answer is the deterministic script, and nothing reaches any network',
})
/** The provider unless the operator chooses another: the Claude API through a gateway on this machine, for testing. */
export const DEFAULT_PROVIDER: Provider = 'claude'
/** Where a llama.cpp server listens unless the operator says otherwise (its own default port). */
export const LLAMACPP_SERVER = 'http://localhost:8080'
/** llama.cpp serves the one model it was started with, whatever name a request gives. */
export const LLAMACPP_MODEL = 'default'
/** Where an OpenAI-compatible server listens unless the operator says otherwise (LM Studio's own default port). */
export const OPENAI_SERVER = 'http://localhost:1234'
/** The model asked of it unless the operator chooses one it lists (ask model <name>). */
export const OPENAI_MODEL = 'default'
/** What the scripted provider reports as its server and model: nothing is addressed, nothing is loaded. */
export const SCRIPTED_SERVER = 'none'
export const isProvider = (v: unknown): v is Provider => (PROVIDERS as readonly unknown[]).includes(v)

/** What the router keeps between visits: the provider, the Claude provider's own settings, and each local provider's. */
interface Kept {
  v: 3
  provider: Provider
  claude: { server: string; model: string; key: string | null; effort: string | null }
  ollama: string | null
  llamacpp: string | null
  openai: string | null
}

/** A view of one slice of the router's store, handed to a local provider as its own SettingsStore. */
function slice(kept: Kept, key: 'ollama' | 'llamacpp' | 'openai', keep: () => void): SettingsStore {
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
  /**
   * One line: chooses the provider and, when given, its server (a loopback address) and, for the Claude provider,
   * its key. The scripted provider takes neither. Returns the provider's line (PROVIDER_TEXT) and what was set.
   */
  connect(provider: string, url?: string, key?: string): string
  readonly provider: Provider
  /**
   * The cloud provider on its own (the Claude API through the gateway on this machine), whichever provider is chosen:
   * the cloud fallback throttle (cloudFallback.ts) hands complex prompts to it while the frames are slow.
   */
  readonly cloud: Mind
}

export function createMindRouter({ fetch: fetchFn, store }: { fetch: FetchLike; store?: SettingsStore }): MindRouter {
  const kept: Kept = { v: 3, provider: DEFAULT_PROVIDER, claude: { server: CLAUDE_GATEWAY, model: DEFAULT_CLAUDE_MODEL, key: null, effort: null }, ollama: null, llamacpp: null, openai: null }
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
      if (typeof s.openai === 'string') kept.openai = s.openai
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
  const openai = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'openai', keep), defaults: { server: OPENAI_SERVER, model: OPENAI_MODEL, api: 'chat' } })
  // No backend: the script answers (scripted.ts), with the same system prompt hashed, so an audit still says what
  // the people were told. It addresses nothing, so its server and model cannot be set.
  const scripted: Mind = Object.freeze({
    settings: () => ({ server: SCRIPTED_SERVER, model: SCRIPTED }),
    setServer: (): string => { throw new Error('the scripted provider has no server: it answers on this page (ask provider <name> for one that does)') },
    setModel: (): string => { throw new Error('the scripted provider has no model: it answers on this page (ask provider <name> for one that does)') },
    installed: async (): Promise<string[]> => [SCRIPTED],
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      if (req.signal.aborted) throw req.signal.reason instanceof Error ? req.signal.reason : new DOMException('aborted', 'AbortError')
      const text = scriptedAnswer(req)
      onPiece({ kind: 'text', text })
      return { text, thinking: 0, tokens: 0, reason: SCRIPTED, promptHash: promptHash(systemPrompt(req.tethers, req.memories, req.context)) }
    },
  })
  const local = (): Mind => (kept.provider === 'ollama' ? ollama : kept.provider === 'openai' ? openai : kept.provider === 'scripted' ? scripted : llamacpp)
  // The prompt-prefix page table (prefixCache.ts): asked before every answer, its counts are the `cache` setting.
  const cache = createPrefixCache({ prefix: BASE_REALITY })
  const agentKey = (tethers: readonly GateTether[]): string => [...new Set(tethers.map((t) => t.agent))].sort((a, b) => a - b).join('+')

  // The Claude provider answers with the hash of the exact system prompt it sent, as the local providers do (the
  // swarm's memory records it, so an audit can prove what the model was given).
  const claudeAnswerHashed = async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
    const system = systemPrompt(req.tethers, req.memories, req.context)
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
    answer: (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => claudeAnswerHashed(req, onPiece),
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
    connect: (provider: string, url?: string, key?: string): string => {
      const n = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
      if (!isProvider(n)) throw new TypeError(`ask connect takes ${PROVIDERS.join(', ')}, then an optional server url and, for claude, a key`)
      const u = typeof url === 'string' ? url.trim() : ''
      const k = typeof key === 'string' ? key.trim() : ''
      if (n === 'scripted' && (u || k)) throw new Error('the scripted provider takes no server and no key: it answers on this page')
      if (k && n !== 'claude') throw new Error(`the ${n} provider takes no key: a server on this machine needs none`)
      // Checked before anything changes, so a bad address leaves the provider as it was.
      const target = n === 'claude' ? claude : n === 'ollama' ? ollama : n === 'openai' ? openai : n === 'scripted' ? scripted : llamacpp
      if (u && n === 'claude' && claudeServer(u) === null) throw new Error(`the Claude provider speaks only to a gateway on this machine (localhost, 127.0.0.1 or [::1]), not '${u}'`)
      if (u && n !== 'claude' && n !== 'scripted' && claudeServer(u) === null) throw new Error(`the local model server must be on this machine (localhost, 127.0.0.1 or [::1]), not '${u}'`)
      kept.provider = n
      const set: string[] = []
      if (u) set.push(`server ${target.setServer(u)}`)
      if (k) {
        kept.claude.key = k
        set.push(`key ${maskKey(k)}`)
      }
      keep()
      return set.length ? `${PROVIDER_TEXT[n]}; ${set.join(', ')}` : PROVIDER_TEXT[n]
    },
    installed: (signal?: AbortSignal) => active().installed(signal),
    answer: async (req, onPiece) => {
      await cache.page(agentKey(req.tethers), systemPrompt(req.tethers, req.memories, req.context))
      return active().answer(req, onPiece)
    },
  }
  return Object.freeze(router)
}
