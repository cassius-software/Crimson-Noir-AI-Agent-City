// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the cognition router: the one Mind the operator tier is handed (operator.ts Mind),
 * behind which any of five model providers answers, swapped at the console without a restart (ask provider <name>,
 * or in one line ask connect <provider> [<url>] [<key>]), or the first of them that answers (`auto`, the default):
 * - `auto`: at an ask, the first provider whose server answers on this machine, in AUTO_ORDER (the local model
 *   servers first, then the Claude gateway), kept for the visit and looked for again when it stops answering (and at
 *   `ask` alone); a model server installed with its defaults is used with nothing set at the console;
 * - `claude`: the Claude Messages API through a gateway on this machine (claudeApi.ts), with the key the operator
 *   gives the console;
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
import { ANY_MODEL, BASE_REALITY, CognitionError, createLocalCompute, DEFAULT_MODEL, installedModels, isolatedPage, localText, promptHash, systemPrompt, type FetchLike, type SettingsStore, type Timeouts } from './localCompute.ts'
import { createPrefixCache } from './prefixCache.ts'
import { SCRIPTED, scriptedAnswer } from './scripted.ts'

export type Provider = 'auto' | 'claude' | 'ollama' | 'llamacpp' | 'openai' | 'scripted'
export const PROVIDERS: readonly Provider[] = Object.freeze(['auto', 'claude', 'ollama', 'llamacpp', 'openai', 'scripted'])
/** A provider auto may answer with: one that addresses a server. */
export type Found = Exclude<Provider, 'auto' | 'scripted'>
/** The order auto looks in: the model servers on this machine (Ollama, llama.cpp, LM Studio's port), then the Claude gateway. */
export const AUTO_ORDER: readonly Found[] = Object.freeze(['ollama', 'llamacpp', 'openai', 'claude'])
/** How long each server has to answer auto's look, ms: a server on this machine answers in a moment, or not at all. */
export const AUTO_LOOK_MS = 2000
/** What each provider is, in the words the console prints after a swap. */
export const PROVIDER_TEXT: Readonly<Record<Provider, string>> = Object.freeze({
  auto: 'auto: the first model that answers on this machine (Ollama, a llama.cpp server, an OpenAI-compatible server such as LM Studio, then the gateway to the Claude API), kept until it stops answering; the script when none does',
  claude: 'claude: the Claude API through a gateway on this machine (best with the key in the gateway; ask key <key> keeps one in this browser)',
  ollama: 'ollama: a model server on this machine (the Ollama API)',
  llamacpp: 'llamacpp: a packaged model under a llama.cpp server on this machine',
  openai: 'openai: an OpenAI-compatible server on this machine (LM Studio, vLLM, a loopback proxy; ask server <url> and ask model <name> point at it)',
  scripted: 'scripted: no backend; every answer is the deterministic script, and nothing reaches any network',
})
/** The provider unless the operator chooses another: the first model that answers on this machine. */
export const DEFAULT_PROVIDER: Provider = 'auto'
/** Where a llama.cpp server listens unless the operator says otherwise (its own default port). */
export const LLAMACPP_SERVER = 'http://localhost:8080'
/** llama.cpp serves the one model it was started with: the first it lists is sent (localCompute.ts ANY_MODEL). */
export const LLAMACPP_MODEL = ANY_MODEL
/** Where an OpenAI-compatible server listens unless the operator says otherwise (LM Studio's own default port). */
export const OPENAI_SERVER = 'http://localhost:1234'
/** The model asked of it unless the operator chooses one it lists (ask model <name>): the first it lists. */
export const OPENAI_MODEL = ANY_MODEL
/** What the scripted provider reports as its server and model: nothing is addressed, nothing is loaded. */
export const SCRIPTED_SERVER = 'none'
export const isProvider = (v: unknown): v is Provider => (PROVIDERS as readonly unknown[]).includes(v)

/**
 * What the router keeps between visits: the provider, the Claude provider's own settings, each local provider's, and
 * who chose the Ollama model (`picked`): absent, nobody (the default stands); a name, auto chose it for a server that
 * lacked the default, so auto chooses again when that one goes too; null, the operator chose, and it is left alone.
 */
interface Kept {
  v: 3
  provider: Provider
  claude: { server: string; model: string; key: string | null; effort: string | null }
  ollama: string | null
  llamacpp: string | null
  openai: string | null
  picked?: string | null
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

export function createMindRouter({ fetch: fetchFn, store, timeouts, lookMs = AUTO_LOOK_MS }: { fetch: FetchLike; store?: SettingsStore; timeouts?: Timeouts; lookMs?: number }): MindRouter {
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
      if (s.picked === null || typeof s.picked === 'string') kept.picked = s.picked
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
  const ollama = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'ollama', keep), ...(timeouts && { timeouts }) })
  const llamacpp = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'llamacpp', keep), defaults: { server: LLAMACPP_SERVER, model: LLAMACPP_MODEL, api: 'chat' }, ...(timeouts && { timeouts }) })
  const openai = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'openai', keep), defaults: { server: OPENAI_SERVER, model: OPENAI_MODEL, api: 'chat' }, ...(timeouts && { timeouts }) })
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
  const byName = (p: Found): Mind => (p === 'claude' ? claude : p === 'ollama' ? ollama : p === 'openai' ? openai : llamacpp)
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
  // auto: the provider found answering at the last look, for this visit (null until an ask has looked, or after it stopped answering).
  let found: Found | null = null
  /** Why the last look found nothing usable, beyond nothing answering (a running server with no model). */
  let lookNote = ''
  /** A provider's models for a look: Ollama's without the ones it runs on its own cloud, as its list marks them. */
  const listOf = (p: Found, signal: AbortSignal): Promise<string[]> => {
    if (p !== 'ollama') return byName(p).installed(signal)
    const s = ollama.settings()
    return installedModels(fetchFn, s.server, signal, s.api === 'chat' ? 'chat' : 'generate', true, true)
  }
  /**
   * Looks for a model on this machine: asks the model servers on this machine in AUTO_ORDER for their models at once,
   * each for at most `lookMs`, and keeps the first in that order that answers with one that writes text here
   * (localText: not an embedding model, not one of Ollama's cloud models); only when none does is the Claude gateway
   * asked, since it asks the Claude API. An Ollama whose model the operator never chose (the default, or one auto
   * chose before) but which lacks it is given the default if it has it now, else the first such model. Throws the
   * 'offline' failure (the script stands in for it) when none answers, naming why each server it heard from would
   * not do.
   */
  const look = async (signal?: AbortSignal): Promise<Mind> => {
    found = null
    const notes: string[] = []
    let unseen = false
    for (const group of [AUTO_ORDER.filter((p) => p !== 'claude'), AUTO_ORDER.filter((p) => p === 'claude')]) {
      const lists = await Promise.all(group.map((p) => {
        const within = AbortSignal.timeout(lookMs)
        return listOf(p, signal ? AbortSignal.any([signal, within]) : within).then((names): string[] | unknown => names, (e: unknown) => e)
      }))
      if (signal?.aborted) throw signal.reason
      for (const [i, p] of group.entries()) {
        const names = lists[i]
        const at = `the ${p} server at ${byName(p).settings().server}`
        if (!Array.isArray(names)) {
          // Running but refusing this page is worth saying: it is fixed in that server's settings, not by starting one.
          if (names instanceof CognitionError && names.code === 'refused') notes.push(names.message)
          else if (names instanceof CognitionError && names.code === 'offline') unseen ||= p !== 'claude'
          // Cut off by the look's own wait: busy, or the browser is still asking whether this page may reach it.
          else if (names instanceof DOMException && names.name === 'TimeoutError') {
            notes.push(`${at} did not list its models within ${lookMs / 1000} s (busy, or the browser is asking whether this page may reach it: allow it, then ask again)`)
            unseen ||= p !== 'claude'
          }
          // Running, but its list failed or could not be read: starting it again is not the fix.
          else if (names instanceof CognitionError && (names.code === 'server' || names.code === 'unreadable')) notes.push(`${at} is running but did not give its list of models (${names.message})`)
          continue
        }
        if (p !== 'claude' && !names.some(localText)) {
          notes.push(`${at} is running but has no model that writes text on this machine${p === 'ollama' ? ` (ollama pull ${DEFAULT_MODEL})` : ''}`)
          continue
        }
        const mine = ollama.settings().model
        const unchosen = kept.picked === undefined ? mine === DEFAULT_MODEL : mine === kept.picked
        if (p === 'ollama' && unchosen && !names.includes(mine)) {
          const pick = names.includes(DEFAULT_MODEL) ? DEFAULT_MODEL : names.find(localText) ?? mine
          ollama.setModel(pick)
          kept.picked = pick
          keep()
        }
        found = p
        return byName(p)
      }
    }
    // On an isolated page a local server refusing the origin cannot be told from one not running: say it may be that.
    if (unseen && isolatedPage()) notes.push("one that is running may be refusing this page's origin, which looks the same from here (Ollama: add this page's origin to OLLAMA_ORIGINS)")
    lookNote = notes.map((n) => `; ${n}`).join('')
    const where = AUTO_ORDER.map((p) => `${p} at ${byName(p).settings().server}`).join(', ')
    throw new CognitionError('offline', `no model is answering on this machine (looked for ${where})${lookNote}: start one, or choose one with ask provider <name>`)
  }
  /**
   * auto's answer: the provider found at the last look (looking first when there is none); when it stops answering
   * before any of the answer arrived, one more look, and the answer from whatever answers now.
   */
  const autoAnswer = async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
    const first = found
    const m = first !== null ? byName(first) : await look(req.signal)
    let arrived = false
    try {
      return await m.answer(req, (p) => { arrived = true; onPiece(p) })
    } catch (e) {
      if (first === null || arrived || req.signal.aborted || !(e instanceof CognitionError && (e.code === 'offline' || e.code === 'refused'))) throw e
      return (await look(req.signal)).answer(req, onPiece)
    }
  }
  // What answers: the chosen provider, or under auto the one found (Ollama's settings until a look has found one).
  const active = (): Mind => (kept.provider === 'auto' ? byName(found ?? 'ollama') : kept.provider === 'scripted' ? scripted : byName(kept.provider))
  /** A setting changed under auto goes to the provider found, once there is one. */
  const settable = (): Mind => {
    if (kept.provider === 'auto' && found === null) throw new Error('auto has not found a model on this machine yet: type ask to look, or choose one first (ask provider <name>)')
    return active()
  }
  /** The provider that answers: the chosen one, or under auto the one found (null before a look finds one). */
  const answering = (): Provider | null => (kept.provider === 'auto' ? found : kept.provider)
  const autoLine = (): string => (found !== null ? `${found} at ${byName(found).settings().server}, found answering on this machine (ask provider ${found} keeps it)` : `nothing found yet: the next ask looks on this machine${lookNote}`)

  const router: MindRouter = {
    get provider() {
      return kept.provider
    },
    cloud: claude,
    settings: () => {
      const s = active().settings()
      const claudeAnswers = answering() === 'claude'
      const own = { provider: kept.provider, key: claudeAnswers ? maskKey(kept.claude.key) : undefined, effort: claudeAnswers ? kept.claude.effort ?? undefined : undefined }
      const line = cache.line()
      return { ...s, ...own, ...(line !== null && { cache: line }), ...(kept.provider === 'auto' && { auto: autoLine(), ...(found !== null && { found }) }) }
    },
    setServer: (url: string) => settable().setServer(url),
    setModel: (name: string) => {
      const m = settable()
      const set = m.setModel(name)
      // The operator chose the Ollama model: auto leaves it alone from now on.
      if (m === ollama) {
        kept.picked = null
        keep()
      }
      return set
    },
    setThink: (on: boolean): boolean => {
      const m = settable()
      if (!m.setThink) throw new Error(`the ${answering() ?? kept.provider} provider has no think switch`)
      return m.setThink(on)
    },
    setApi: (format: string): string => {
      const m = settable()
      if (!m.setApi) throw new Error(`the ${answering() ?? kept.provider} provider speaks one wire format only`)
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
      if (n === 'auto' && (u || k)) throw new Error('auto takes no server and no key: it looks at each provider\'s own (ask connect <provider> <url> sets one)')
      if (k && n !== 'claude') throw new Error(`the ${n} provider takes no key: a server on this machine needs none`)
      // Checked before anything changes, so a bad address leaves the provider as it was.
      const target = n === 'scripted' || n === 'auto' ? scripted : byName(n)
      // A rejected value is quoted only when it reads as a plain address: a key typed where the url goes (`ask connect
      // claude <key>`) is never echoed back to the screen.
      const said = /^https?:\/\/[^\s@]*$/i.test(u) ? `, not '${u}'` : ': the second word must be a server url such as http://localhost:8089 (a key alone goes in with ask key <key>)'
      if (u && n === 'claude' && claudeServer(u) === null) throw new Error(`the Claude provider speaks only to a gateway on this machine (localhost, 127.0.0.1 or [::1])${said}`)
      if (u && n !== 'claude' && n !== 'scripted' && n !== 'auto' && claudeServer(u) === null) throw new Error(`the local model server must be on this machine (localhost, 127.0.0.1 or [::1])${said}`)
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
    // `ask` alone under auto looks again (a server started since the last look is found) and lists what that one has.
    installed: async (signal?: AbortSignal) => (kept.provider === 'auto' ? (await look(signal)).installed(signal) : active().installed(signal)),
    answer: async (req, onPiece) => {
      await cache.page(agentKey(req.tethers), systemPrompt(req.tethers, req.memories, req.context))
      return kept.provider === 'auto' ? autoAnswer(req, onPiece) : active().answer(req, onPiece)
    },
  }
  return Object.freeze(router)
}
