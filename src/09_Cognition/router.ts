// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the cognition router: the one Mind the operator tier is handed (operator.ts Mind),
 * behind which any of six model providers answers, swapped at the console without a restart (ask provider <name>,
 * or in one line ask connect <provider> [<url>] [<key>]), or the first of them that answers (`auto`, the default):
 * - `auto`: at an ask, the first provider whose server answers on this machine, in AUTO_ORDER (the local model
 *   servers first, then a model file kept in this page, then the Claude gateway), kept for the visit and looked for
 *   again when it stops answering (and at `ask` alone); a model server installed with its defaults is used with
 *   nothing set at the console, at the newer default addresses too (KNOWN_SERVERS: llama-server's 9931, vLLM's 8000,
 *   SGLang's 30000), asked with the usual ones and used only when none lists a text model at its usual one;
 * - `claude`: the Claude Messages API through a gateway on this machine (claudeApi.ts), with the key the operator
 *   gives the console;
 * - `ollama`: a local model server on this machine speaking the Ollama API (localCompute.ts generate);
 * - `llamacpp`: a packaged, quantized model under a llama.cpp server on this machine (localCompute.ts chat, the
 *   OpenAI-compatible format that server speaks), for offline environments;
 * - `openai`: any other server on this machine that speaks the OpenAI-compatible chat-completions format (LM Studio,
 *   vLLM, a loopback proxy), at its own address and with the model it lists; the same client as llamacpp, its own
 *   settings. OpenAI's own service is not one of them: the air gap admits loopback only;
 * - `inpage`: a model file the operator keeps in this page (Menu › Model file, or ask file), run by the page itself
 *   on this device; it addresses no server at all. The host hands the router that mind (App.tsx); without one (a Node
 *   test, the onboarding page) a stand-in keeps nothing, lists nothing and answers 'offline', so the script speaks;
 * - `scripted`: no backend at all; every answer is the deterministic script (scripted.ts), so the page is complete
 *   with nothing installed and nothing reaches any network.
 * Every provider answers with the same system prompt (the conduct core, the bound people's skills and memories), so a
 * swap changes nothing an agent is or knows. Each keeps its own server and model, remembered between visits in one
 * store; every provider only ever addresses a loopback origin (02_Define_The_Rules/airgap.ts is the gate), or none
 * at all (the in-page and scripted providers), so no prompt leaves this machine from the page. The 14A screen is not here: it is applied once for every provider in the
 * operator tier (gatedAsk), before a prompt reaches this router.
 * Under auto, given the GPUs' memory (ask vram, vram= in the address, or the Windows app's reading), it sizes
 * Ollama's model by what Ollama measured (modelFit.ts), and, for this visit, its context and answer cap too.
 * What breaks if it is removed? `ask` has one provider and no way to swap it; an offline environment has no drop-in.
 */
import { scriptedAction } from '../06_Make_Decisions/actions.ts'
import type { Answer, AnswerRequest, GateTether, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { CLAUDE_GATEWAY, claudeAnswer, claudeModels, claudeServer, DEFAULT_CLAUDE_MODEL, EFFORTS, isEffort, maskKey } from './claudeApi.ts'
import { ANY_MODEL, BASE_REALITY, CognitionError, CONTEXT_TOKENS, createLocalCompute, DEFAULT_MODEL, installedModels, installedSizes, isolatedPage, localText, placementOf, promptHash, sameModel, systemPrompt, TIMEOUTS, type FetchLike, type Placement, type SettingsStore, type Timeouts, type Weighed } from './localCompute.ts'
import { choose, coldWaitMs, contextVerdict, failed, figureOf, fitLine, FAILS_KEPT, PACE_FLOOR, PACE_TOKENS, parseVram, readFit, remember, todaysPick, whereOf, widen, type Back, type Choice, type FitKept, type Wide } from './modelFit.ts'
import { createPrefixCache } from './prefixCache.ts'
import { SCRIPTED, scriptedAnswer } from './scripted.ts'

export type Provider = 'auto' | 'claude' | 'ollama' | 'llamacpp' | 'openai' | 'inpage' | 'scripted'
export const PROVIDERS: readonly Provider[] = Object.freeze(['auto', 'claude', 'ollama', 'llamacpp', 'openai', 'inpage', 'scripted'])
/** A provider auto may answer with: one that asks a model (a server, or the model file kept in this page). */
export type Found = Exclude<Provider, 'auto' | 'scripted'>
/**
 * The order auto looks in: the model servers on this machine (Ollama, llama.cpp, LM Studio's port), then the model
 * file kept in this page, then the Claude gateway.
 */
export const AUTO_ORDER: readonly Found[] = Object.freeze(['ollama', 'llamacpp', 'openai', 'inpage', 'claude'])
/** How long each server has to answer auto's look, ms: a server on this machine answers in a moment, or not at all. */
export const AUTO_LOOK_MS = 2000
/**
 * The phases of auto's look, each in AUTO_ORDER: the servers on this machine, asked at once; then the model file kept
 * in this page, which no server answers for (so it never stands ahead of one); then the gateway, which asks the
 * Claude API, so it is asked only when nothing on this device will do.
 */
const LOOK_PHASES: readonly (readonly Found[])[] = Object.freeze([
  AUTO_ORDER.filter((p) => p !== 'inpage' && p !== 'claude'),
  AUTO_ORDER.filter((p) => p === 'inpage'),
  AUTO_ORDER.filter((p) => p === 'claude'),
])
/** Where the in-page provider is, in a look's sentence and in auto's found line. */
const IN_PAGE_PLACE = 'the model file kept in this page'
/** What each provider is, in the words the console prints after a swap. */
export const PROVIDER_TEXT: Readonly<Record<Provider, string>> = Object.freeze({
  auto: 'auto: the first model that answers on this machine (Ollama, a llama.cpp server, an OpenAI-compatible server such as LM Studio, vLLM or SGLang, a model file kept in this page, then the gateway to the Claude API), kept until it stops answering; the script when none does',
  claude: 'claude: the Claude API through a gateway on this machine (best with the key in the gateway; ask key <key> keeps one in this browser)',
  ollama: 'ollama: a model server on this machine (the Ollama API)',
  llamacpp: 'llamacpp: a packaged model under a llama.cpp server on this machine',
  openai: 'openai: an OpenAI-compatible server on this machine (LM Studio, vLLM, SGLang, a loopback proxy; ask server <url> and ask model <name> point at it)',
  inpage: 'inpage: a model file kept in this page, run by the page itself on this device; nothing is addressed (Menu › Model file, or ask file, chooses one)',
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
/** Where vLLM listens unless told otherwise (its own default port). */
export const VLLM_SERVER = 'http://localhost:8000'
/**
 * The addresses a provider's server listens at when it is started with its own defaults, the provider's default
 * first: llama-server moved from 8080 to 9931 in build b11521 (October 2026); vLLM listens on 8000 and SGLang on
 * 30000. A provider set to one of these is asked at its others too by auto's look (the second round), at the same
 * time as the first, and they are used only when no server lists a model that writes text at the address its
 * provider is set to. Ollama has one.
 */
export const KNOWN_SERVERS: Readonly<Partial<Record<Found, readonly string[]>>> = Object.freeze({
  llamacpp: Object.freeze([LLAMACPP_SERVER, 'http://localhost:9931']),
  openai: Object.freeze([OPENAI_SERVER, VLLM_SERVER, 'http://localhost:30000']),
})
/** What the scripted provider reports as its server and model: nothing is addressed, nothing is loaded. */
export const SCRIPTED_SERVER = 'none'
/** What the in-page provider reports as its server: nothing is addressed, the model runs in this page. */
export const INPAGE_SERVER = 'this page'
/** Why the stand-in for the in-page provider cannot answer: the host handed the router no runtime for one. */
export const NO_INPAGE_RUNTIME = 'no in-page runtime here'
export const isProvider = (v: unknown): v is Provider => (PROVIDERS as readonly unknown[]).includes(v)

/** The port an address on this machine listens at (a missing port is the scheme's own); '' when it is no address. */
const portOf = (url: string): string => {
  try {
    const u = new URL(url)
    return u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    return ''
  }
}
/**
 * Which server on this machine an address names, as far as a look can tell: localhost and 127.0.0.1 at one port are
 * the same server (the page's connect-src allows both, and the model servers listen on 127.0.0.1 by default), so the
 * key is the port alone; [::1] and the rest of 127.0.0.0/8 may be another server at that port, so their host is kept.
 */
const serverKey = (url: string): string => {
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '127.0.0.1' ? portOf(url) : `${host}:${portOf(url)}`
  } catch {
    return ''
  }
}

/**
 * What the router keeps between visits: the provider, the Claude provider's own settings, each local provider's (the
 * in-page provider's too, which the router stores but never reads), and who chose the Ollama model (`picked`): absent,
 * nobody (the default stands); a name, auto chose it for a server that lacked the default, so auto chooses again when
 * that one goes too; null, the operator chose, and it is left alone. `fit` is what auto's sizing of the Ollama model
 * keeps (modelFit.ts FitKept): the console's GPU figure, what was measured, and the model auto moved from. An older
 * build ignores the key, so the version stays; it answers with the model auto last moved to (kept as its own pick)
 * until ask model <name>, and the next save there drops `fit`.
 */
interface Kept {
  v: 3
  provider: Provider
  claude: { server: string; model: string; key: string | null; effort: string | null }
  ollama: string | null
  llamacpp: string | null
  openai: string | null
  inpage: string | null
  picked?: string | null
  fit?: FitKept
}

/** A view of one slice of the router's store, handed to a local provider (or the in-page one) as its own SettingsStore. */
function slice(kept: Kept, key: 'ollama' | 'llamacpp' | 'openai' | 'inpage', keep: () => void): SettingsStore {
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
  /** The GPUs' memory in GB for auto's Ollama model, 0 for none, or auto (the page's address, else the Windows app's reading); forgets what was measured; returns what it now is. */
  setVram(value: string): string
  /**
   * One line: chooses the provider and, when given, its server (a loopback address) and, for the Claude provider,
   * its key. The scripted and in-page providers take neither. Returns the provider's line (PROVIDER_TEXT) and what was set.
   */
  connect(provider: string, url?: string, key?: string): string
  readonly provider: Provider
  /**
   * The cloud provider on its own (the Claude API through the gateway on this machine), whichever provider is chosen:
   * the cloud fallback throttle (cloudFallback.ts) hands complex prompts to it while the frames are slow.
   */
  readonly cloud: Mind
}

/**
 * The in-page provider when the host has no runtime for one (a Node test, the onboarding page): it keeps nothing, so
 * it lists nothing, makes no request and answers 'offline' (the script stands in, and auto passes it by unremarked).
 */
function noInPage(): Mind {
  return Object.freeze({
    settings: () => ({ server: INPAGE_SERVER, model: null, runtime: NO_INPAGE_RUNTIME, storage: 'none' }),
    setServer: (): string => { throw new Error('the inpage provider has no server: the model runs in this page (ask provider <name> for one that does)') },
    setModel: (): string => { throw new Error(`the inpage provider cannot choose a model: ${NO_INPAGE_RUNTIME}`) },
    installed: async (): Promise<string[]> => [],
    answer: async (req: AnswerRequest): Promise<Answer> => {
      if (req.signal.aborted) throw req.signal.reason instanceof Error ? req.signal.reason : new DOMException('aborted', 'AbortError')
      throw new CognitionError('offline', NO_INPAGE_RUNTIME)
    },
  })
}

/**
 * `inPage` builds the in-page provider over its own slice of the router's store (09_Cognition/inPage.ts, from the
 * host); without it the stand-in above answers for that provider.
 */
export function createMindRouter({ fetch: fetchFn, store, timeouts, lookMs = AUTO_LOOK_MS, inPage = noInPage, vram, appVram }: {
  fetch: FetchLike; store?: SettingsStore; timeouts?: Timeouts; lookMs?: number; inPage?: (store: SettingsStore) => Mind
  /** the page's vram= query value, for auto's Ollama model (modelFit.ts) */
  vram?: string | null
  /** the Windows app's reading of the GPUs' memory, GB (modelFit.ts figureFromAdapters); null until it arrives, or none */
  appVram?: () => number | null
}): MindRouter {
  const kept: Kept = { v: 3, provider: DEFAULT_PROVIDER, claude: { server: CLAUDE_GATEWAY, model: DEFAULT_CLAUDE_MODEL, key: null, effort: null }, ollama: null, llamacpp: null, openai: null, inpage: null }
  try {
    const saved: unknown = JSON.parse(store?.load() ?? 'null')
    if (typeof saved === 'object' && saved !== null) {
      const s = saved as Partial<Kept> & { claude?: Partial<Kept['claude']>; fit?: unknown }
      if (isProvider(s.provider)) kept.provider = s.provider
      kept.claude.server = claudeServer(s.claude?.server) ?? CLAUDE_GATEWAY
      if (typeof s.claude?.model === 'string' && s.claude.model.trim()) kept.claude.model = s.claude.model.trim()
      if (typeof s.claude?.key === 'string' && s.claude.key) kept.claude.key = s.claude.key
      if (isEffort(s.claude?.effort)) kept.claude.effort = s.claude.effort
      if (typeof s.ollama === 'string') kept.ollama = s.ollama
      if (typeof s.llamacpp === 'string') kept.llamacpp = s.llamacpp
      if (typeof s.openai === 'string') kept.openai = s.openai
      if (typeof s.inpage === 'string') kept.inpage = s.inpage
      if (s.picked === null || typeof s.picked === 'string') kept.picked = s.picked
      // What auto's sizing kept (modelFit.ts readFit): every field checked, whatever does not pass dropped.
      const fit = readFit(s.fit); if (fit) kept.fit = fit
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
  // Auto's sizing of the Ollama model (modelFit.ts), for this visit: Ollama's list with sizes as the last look read it,
  // the model auto answers with and why, the models set aside (a key per server and model), the ones measured, the ones
  // given one more chance after a first wait ran out with nothing loaded, whether a bigger step may still be tried, a
  // count every settings change bumps (a measurement sent before one is dropped), and the measurement under way.
  let catalog: { server: string; models: readonly Weighed[] } | null = null
  let choice: Choice | null = null
  const aside = new Set<string>(); const verified = new Set<string>(); const coldOnce = new Set<string>()
  let grow = true
  let generation = 0
  let measuring: Promise<void> | null = null
  // Ollama's context, for this visit only (modelFit.ts widen and contextVerdict): what became of each model's that grew
  // (a key per server and model; absent, CONTEXT_TOKENS), the newest placement measured at each context (a key per
  // server, model and context), and the grown contexts given one more chance after a first wait ran out with nothing
  // loaded. ask vram clears them; nothing of them is kept between visits.
  const wide = new Map<string, Wide>(); const placements = new Map<string, Placement>(); const coldWide = new Set<string>()
  // The Ollama answers auto measures, as they go (crossed): for each server and model (keyOf), each context's answers
  // in flight and the count `tick` stood at when the last one ended; `tick` counts each one sent and each one ended.
  // They follow requests, not settings: ask vram leaves them.
  let tick = 0
  const flights = new Map<string, Map<number, { open: number; ended: number }>>()
  // Under auto, a big model may wait longer for its first piece while Ollama reads it (modelFit.ts coldWaitMs; never
  // shorter); under ask provider ollama the wait is the client's own. The context is the router's (contextFor).
  const ollama = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'ollama', keep), ...(timeouts && { timeouts }), coldWait: (n) => (kept.provider === 'auto' ? coldWaitMs(bytesOf(n)) : 0), contextFor: (n) => contextFor(n) })
  const llamacpp = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'llamacpp', keep), defaults: { server: LLAMACPP_SERVER, model: LLAMACPP_MODEL, api: 'chat' }, ...(timeouts && { timeouts }) })
  const openai = createLocalCompute({ fetch: fetchFn, store: slice(kept, 'openai', keep), defaults: { server: OPENAI_SERVER, model: OPENAI_MODEL, api: 'chat' }, ...(timeouts && { timeouts }) })
  // The model file kept in this page: its own settings (the file chosen, think, the GPU) in its own slice.
  const inpage = inPage(slice(kept, 'inpage', keep))
  // No backend: the script answers (scripted.ts), with the same system prompt hashed, so an audit still says what
  // the people were told. It addresses nothing, so its server and model cannot be set. Chosen on purpose, it also
  // proposes the one city action a prompt plainly asks for (06_Make_Decisions/actions.ts scriptedAction), so the
  // browser smoke drives the whole path with no model; the script standing in for another provider (scripted.ts
  // withScriptedFallback) never does.
  const scripted: Mind = Object.freeze({
    settings: () => ({ server: SCRIPTED_SERVER, model: SCRIPTED }),
    setServer: (): string => { throw new Error('the scripted provider has no server: it answers on this page (ask provider <name> for one that does)') },
    setModel: (): string => { throw new Error('the scripted provider has no model: it answers on this page (ask provider <name> for one that does)') },
    installed: async (): Promise<string[]> => [SCRIPTED],
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      if (req.signal.aborted) throw req.signal.reason instanceof Error ? req.signal.reason : new DOMException('aborted', 'AbortError')
      const line = scriptedAction(req.prompt)
      const text = scriptedAnswer(req) + (line ? `\n${line}` : '')
      onPiece({ kind: 'text', text })
      return { text, thinking: 0, tokens: 0, reason: SCRIPTED, promptHash: promptHash(systemPrompt(req.tethers, req.memories, req.context, req.steering)) }
    },
  })
  const byName = (p: Found): Mind => (p === 'claude' ? claude : p === 'ollama' ? ollama : p === 'openai' ? openai : p === 'inpage' ? inpage : llamacpp)
  // The prompt-prefix page table (prefixCache.ts): asked before every answer, its counts are the `cache` setting.
  const cache = createPrefixCache({ prefix: BASE_REALITY })
  const agentKey = (tethers: readonly GateTether[]): string => [...new Set(tethers.map((t) => t.agent))].sort((a, b) => a - b).join('+')

  // The Claude provider answers with the hash of the exact system prompt it sent, as the local providers do (the
  // swarm's memory records it, so an audit can prove what the model was given).
  const claudeAnswerHashed = async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
    const system = systemPrompt(req.tethers, req.memories, req.context, req.steering)
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
  /** One model on one server, as aside, coldOnce and wide hold it. */
  const keyOf = (server: string, model: string): string => `${server} ${model}`
  /** Ollama's list with sizes as the last look read it, when it was this server's. */
  const listedHere = (): readonly Weighed[] | null => (catalog?.server === ollama.settings().server ? catalog.models : null)
  /** A model's listed weight bytes on this server (null: not listed, or no size); `qwen3` is the listed `qwen3:latest`. */
  const bytesOf = (n: string): number | null => listedHere()?.find((m) => sameModel(m.name, n))?.bytes ?? null
  /** The GPU figure in force: the console's, else the page's address, else the Windows app's (modelFit.ts figureOf). */
  const figure = () => figureOf(kept.fit?.vram ?? null, vram, appVram?.() ?? null)
  /** The measurements kept that still count (R12): this server's, at the weights it lists now. */
  const seenHere = () => {
    const server = ollama.settings().server
    return (kept.fit?.seen ?? []).filter((x) => x.server === server && x.weights === bytesOf(x.model))
  }
  /** The listed models auto does not choose: set aside this visit, or too big in FAILS_KEPT visits. */
  const avoided = (): Set<string> => {
    const server = ollama.settings().server
    const worn = new Set(seenHere().filter((x) => x.fails >= FAILS_KEPT).map((x) => x.model))
    return new Set((listedHere() ?? []).map((m) => m.name).filter((n) => aside.has(keyOf(server, n)) || worn.has(n)))
  }
  /** The Ollama model as the client has it (never null there). */
  const ollamaModel = (): string => ollama.settings().model ?? DEFAULT_MODEL
  /** Whether the operator never chose the Ollama model (the default stands, or auto chose it): only then does auto choose. */
  const unchosen = (): boolean => {
    const mine = ollamaModel()
    return kept.picked === undefined ? mine === DEFAULT_MODEL : mine === kept.picked
  }
  /** Whether Ollama's context may be other than CONTEXT_TOKENS (R1): under auto with Ollama found, a figure, the generate format, and auto's own model. */
  const gate = (): boolean => kept.provider === 'auto' && found === 'ollama' && figure() !== null && ollama.settings().api !== 'chat' && unchosen()
  /** The context Ollama's next answer with `n` asks for (R1, R2): this visit's for that model inside the gate, else CONTEXT_TOKENS. */
  const contextFor = (n: string): number => (gate() ? wide.get(keyOf(ollama.settings().server, n))?.ctx ?? CONTEXT_TOKENS : CONTEXT_TOKENS)
  /** The model auto would answer with unsized (today's pick), or the one it moved from. */
  const usualName = (): string => kept.fit?.usual ?? ollamaModel()
  /** Whether `n` lists more weight bytes than the usual model (both known). */
  const larger = (n: string): boolean => {
    const b = bytesOf(n); const u = bytesOf(usualName())
    return b !== null && u !== null && b > u
  }
  /** Whether auto has moved the Ollama model off the usual one. */
  const moved = (): boolean => kept.fit?.usual !== undefined && ollamaModel() !== kept.fit.usual
  /**
   * Auto chooses the Ollama model from `names` (Ollama's list): today's pick (the model kept while listed, else the
   * default, else the first text model by name); with a GPU figure, in the generate format, and the sizes listed, the
   * model modelFit.ts choose steps to. The model it moved from is kept as `fit.usual`. Without a figure and with
   * nothing kept, this is the look's old rule exactly.
   */
  const repick = (names: readonly string[]): void => {
    const s = ollama.settings(); const f = figure(); const listed = listedHere()
    const mine = s.model ?? DEFAULT_MODEL
    const usual = todaysPick(names, kept.fit?.usual ?? mine)
    let next = usual
    if (f !== null && s.api !== 'chat' && listed !== null) { choice = choose({ listed, usual, figure: f, seen: seenHere(), avoided: avoided(), grow }); next = choice.name } else choice = null
    let dirty = false
    if (next !== mine) { ollama.setModel(next); kept.picked = next; dirty = true }
    if (next !== usual) { if (kept.fit?.usual !== usual) { kept.fit = { ...(kept.fit ?? { vram: null, seen: [] }), usual }; dirty = true } }
    else if (kept.fit?.usual !== undefined) { delete kept.fit.usual; dirty = true }
    if (dirty) keep()
  }
  /**
   * A provider's models for a look: Ollama's without the ones it runs on its own cloud, as its list marks them. In the
   * generate format Ollama's list is read with each model's size, kept for auto's sizing and the first-piece wait.
   */
  const listOf = async (p: Found, signal: AbortSignal): Promise<string[]> => {
    if (p !== 'ollama') return byName(p).installed(signal)
    const s = ollama.settings()
    if (s.api === 'chat') return installedModels(fetchFn, s.server, signal, 'chat', true, true)
    const w = await installedSizes(fetchFn, s.server, signal); catalog = { server: s.server, models: w }; return w.map((m) => m.name)
  }
  /**
   * Whether the in-page provider has a model file chosen (so one is kept): only then is it found, and only then is it
   * named in a look that it cannot run (a list that failed says nothing of what is kept).
   */
  const chosenInPage = (): boolean => inpage.settings().model !== null
  /** Where a look asked a provider, as its sentence names it: its address, and the second round's ports there (same host). */
  const placeOf = (p: Found, also: readonly string[] = []): string => {
    if (p === 'inpage') return IN_PAGE_PLACE
    const ports = also.map((u) => u.slice(u.lastIndexOf(':')))
    const more = ports.length ? ` (also ${ports.length > 1 ? `${ports.slice(0, -1).join(', ')} and ${ports.at(-1)}` : ports[0]})` : ''
    return `${p} at ${byName(p).settings().server}${more}`
  }
  /** One address of a look's second round: the provider, the address, and where the provider was set when the look began. */
  type Elsewhere = { readonly p: Found; readonly url: string; readonly from: string }
  /**
   * The second round of a look (KNOWN_SERVERS): each local provider set to one of its known addresses, at its others
   * the look does not ask already, in AUTO_ORDER and each list's order: one is asked already when a provider is set to
   * the same server (serverKey). The gateway's port is never asked, whatever name for this machine the gateway is set
   * at: a list read there as a model server's would send the prompts on to the Claude API. An address set to anything
   * else is the operator's: none.
   */
  const secondRound = (): Elsewhere[] => {
    const asked = new Set([...LOOK_PHASES[0].map((p) => serverKey(byName(p).settings().server)), portOf(byName('claude').settings().server)])
    return LOOK_PHASES[0].flatMap((p) => {
      const known = KNOWN_SERVERS[p]; const from = byName(p).settings().server
      return known?.includes(from) ? known.filter((url) => !asked.has(serverKey(url))).map((url) => ({ p, url, from })) : []
    })
  }
  /**
   * The second round's lists, read once the first round found nothing usable: the first in order that lists a model
   * that writes text here (and the model kept for that provider, when one was chosen) is found, and kept as that
   * provider's server as ask server keeps one; a provider set elsewhere since the look began (by the operator, or by
   * another look that found it answering) is found where it is now, not moved. Nothing
   * listening is the usual case here, and port 8000 is many a web server's, so only what is worth fixing is said: a
   * server refusing this page, one with no text model, one without the model kept; nothing answering at vLLM's
   * address is said only through vLLM's hint (`unseenVllm`).
   */
  const adopt = (second: readonly Elsewhere[], lists: readonly unknown[], notes: string[], unseenVllm: () => void): Mind | null => {
    for (const [i, { p, url, from }] of second.entries()) {
      const names = lists[i]
      if (!Array.isArray(names)) {
        if (names instanceof CognitionError && names.code === 'refused') {
          notes.push(`something at ${url} is running but refused this page (${url === VLLM_SERVER ? "if it is vLLM 0.32 or later, start it with --allowed-origins naming this page's origin" : "if it is a model server, allow this page's origin in its settings"})`)
        } else if (url === VLLM_SERVER && ((names instanceof CognitionError && names.code === 'offline') || (names instanceof DOMException && names.name === 'TimeoutError'))) unseenVllm()
        continue
      }
      if (!names.some(localText)) { notes.push(`the ${p} server at ${url} is running but has no model that writes text on this machine`); continue }
      const mind = byName(p); const s = mind.settings()
      if (s.model !== null && s.model !== ANY_MODEL && !names.includes(s.model)) {
        notes.push(`the ${p} server at ${url} is running but does not list ${s.model}, the model kept for ${p} (ask connect ${p} ${url}, then ask model <name>)`)
        continue
      }
      if (s.server === from) mind.setServer(url)
      found = p
      return mind
    }
    return null
  }
  /**
   * Looks for a model on this machine: asks the model servers on this machine in AUTO_ORDER for their models at once,
   * each for at most `lookMs`, and keeps the first in that order that answers with one that writes text here
   * (localText: not an embedding model, not one of Ollama's cloud models); only when none does is the model file kept
   * in this page asked (it makes no request and loads nothing: it lists what is kept, or says why it cannot run here),
   * and only when that has none is the Claude gateway asked, since it asks the Claude API. With the servers go the
   * newer default addresses of the providers still set to a known one (secondRound), asked at the same time (each
   * list given `lookMs`, as the first round's are), read only when the servers at their own addresses gave nothing
   * usable (adopt), and called off once the first round has settled with a text model. An Ollama whose model the operator never chose (the default, or one auto chose before) but which lacks it is given
   * the default if it has it now, else the first such model. Throws the 'offline' failure (the script stands in for
   * it) when none answers, naming why each server it heard from would not do; the page's own model is named only when
   * a file is kept.
   */
  const look = async (signal?: AbortSignal): Promise<Mind> => {
    await settled(signal)
    found = null
    // The second round's addresses, fixed as the look begins (another look may move a provider meanwhile).
    const second = secondRound()
    const also = new Map<Found, string[]>()
    for (const { p, url } of second) also.set(p, [...(also.get(p) ?? []), url])
    const notes: string[] = []
    // Whether a server at the address its provider is set to seemed not to be running, and vLLM's address did (each
    // may be refusing this page's origin instead, which an isolated page cannot tell apart).
    let unseen = false
    let vllmUnseen = false
    /** A list that failed in the first round, said in the notes the way its cause is fixed. */
    const heard = (p: Found, server: string, e: unknown): void => {
      const at = `the ${p} server at ${server}`
      const missing = (): void => {
        if (p === 'claude') return
        unseen = true
        if (server === VLLM_SERVER) vllmUnseen = true
      }
      // Running but refusing this page is worth saying: it is fixed in that server's settings, not by starting one.
      if (e instanceof CognitionError && e.code === 'refused') notes.push(e.message)
      else if (e instanceof CognitionError && e.code === 'offline') missing()
      // Cut off by the look's own wait: busy, or the browser is still asking whether this page may reach it.
      else if (e instanceof DOMException && e.name === 'TimeoutError') {
        notes.push(`${at} did not list its models within ${lookMs / 1000} s (busy, or the browser is asking whether this page may reach it: allow it, then ask again)`)
        missing()
      }
      // Running, but its list failed or could not be read: starting it again is not the fix.
      else if (e instanceof CognitionError && (e.code === 'server' || e.code === 'unreadable')) notes.push(`${at} is running but did not give its list of models (${e.message})`)
    }
    // Whether the look's sentence names the page's own model: only when a file is kept there.
    let pageNamed = false
    for (const group of LOOK_PHASES) {
      const within = (): AbortSignal => (signal ? AbortSignal.any([signal, AbortSignal.timeout(lookMs)]) : AbortSignal.timeout(lookMs))
      const pending = Promise.all(group.map((p) => listOf(p, within()).then((names): string[] | unknown => names, (e: unknown) => e)))
      // The second round goes with the first, in each provider's own wire format, and is called off once the first round
      // has settled (with a text model, or with nothing usable and the second round read).
      const off = new AbortController()
      const others = group === LOOK_PHASES[0] && second.length
        ? Promise.all(second.map(({ p, url }) => installedModels(fetchFn, url, AbortSignal.any([within(), off.signal]), byName(p).settings().api === 'generate' ? 'generate' : 'chat').then((names): string[] | unknown => names, (e: unknown) => e)))
        : null
      try {
        const lists = await pending
        if (signal?.aborted) throw signal.reason
        for (const [i, p] of group.entries()) {
          const names = lists[i]
          if (p === 'inpage') {
            // The model file kept in this page: found when one is kept and chosen and this browser can run it. Why it
            // cannot is said only when a file is kept (with none, a look reads as it always has), and never as a server
            // that may be refusing this page: nothing was asked of any server. Files kept with none chosen are passed
            // over with how to choose one: auto never runs a file the operator did not choose (it may be gigabytes).
            if (Array.isArray(names) && names.length && chosenInPage()) {
              found = p
              return inpage
            }
            if (Array.isArray(names) && names.length) {
              pageNamed = true
              notes.push(`inpage: ${names.length === 1 ? 'a model file is' : `${names.length} model files are`} kept in this page but none is chosen (ask provider inpage, then ask model <name>)`)
              continue
            }
            if (Array.isArray(names) || !chosenInPage()) continue
            pageNamed = true
            if (names instanceof DOMException && names.name === 'TimeoutError') notes.push(`inpage: ${IN_PAGE_PLACE} did not say within ${lookMs / 1000} s whether this browser can run it`)
            else notes.push(`inpage: ${names instanceof Error ? names.message : String(names)}`)
            continue
          }
          const server = byName(p).settings().server
          if (!Array.isArray(names)) {
            heard(p, server, names)
            continue
          }
          if (p !== 'claude' && !names.some(localText)) {
            notes.push(`the ${p} server at ${server} is running but has no model that writes text on this machine${p === 'ollama' ? ` (ollama pull ${DEFAULT_MODEL})` : ''}`)
            continue
          }
          if (p === 'ollama' && unchosen()) repick(names)
          found = p
          return byName(p)
        }
        // Nothing usable at the providers' own addresses: the second round's lists are read.
        if (others !== null) {
          const heardElsewhere = await others
          if (signal?.aborted) throw signal.reason
          const elsewhere = adopt(second, heardElsewhere, notes, () => { vllmUnseen = true })
          if (elsewhere !== null) return elsewhere
        }
      } finally {
        off.abort()
      }
    }
    // On an isolated page a local server refusing the origin cannot be told from one not running: say it may be that.
    // vLLM 0.32 and later refuses every other page unless it is started with --allowed-origins.
    const fixes = [...(unseen ? ["Ollama: add this page's origin to OLLAMA_ORIGINS"] : []), ...(vllmUnseen ? ['vLLM 0.32 and later: start it with --allowed-origins naming that origin'] : [])]
    if (fixes.length && isolatedPage()) notes.push(`one that is running may be refusing this page's origin, which looks the same from here (${fixes.join('; ')})`)
    lookNote = notes.map((n) => `; ${n}`).join('')
    const where = AUTO_ORDER.filter((p) => p !== 'inpage' || pageNamed).map((p) => placeOf(p, also.get(p))).join(', ')
    throw new CognitionError('offline', `no model is answering on this machine (looked for ${where})${lookNote}: start one, or choose one with ask provider <name>`)
  }
  /** The measurement under way, awaited before a look or an answer; a stop (the signal aborting) ends the wait at once. */
  const settled = async (signal?: AbortSignal): Promise<void> => {
    const m = measuring
    if (m === null) return
    if (signal === undefined) return m
    let stop = (): void => {}
    const stopped = new Promise<void>((r) => { stop = r })
    signal.addEventListener('abort', stop, { once: true })
    try {
      if (!signal.aborted) await Promise.race([m, stopped])
    } finally {
      signal.removeEventListener('abort', stop)
    }
    if (signal.aborted) throw signal.reason
  }
  /**
   * An Ollama answer under auto with a GPU figure: where and what it was sent, at which context, the settings count
   * then, and `tick` as it was sent.
   */
  type Sent = { readonly server: string; readonly model: string; readonly gen: number; readonly ctx: number; readonly at: number }
  /** What an Ollama answer to `model` at `server` is sent with now: the context contextFor gives it, under today's settings count. */
  const sending = (server: string, model: string): Sent => ({ server, model, gen: generation, ctx: contextFor(model), at: ++tick })
  /** One model on one server at one context, as verified and placements hold it: a grown context is measured apart. */
  const measuredKey = (s: Sent): string => `${keyOf(s.server, s.model)} ${s.ctx}`
  /** `go`, the answer `s` says is sent (null: one auto does not measure), noted as in flight until it ends (crossed). */
  const flown = async (s: Sent | null, go: () => Promise<Answer>): Promise<Answer> => {
    if (s === null) return go()
    const k = keyOf(s.server, s.model); const each = flights.get(k) ?? new Map<number, { open: number; ended: number }>()
    const f = each.get(s.ctx) ?? { open: 0, ended: 0 }
    each.set(s.ctx, f); flights.set(k, each)
    f.open++
    try {
      return await go()
    } finally {
      f.open--; f.ended = ++tick
    }
  }
  /**
   * Whether an answer to the same server and model at another context was in flight, or ended, since `s` was sent:
   * Ollama may have loaded the model again for it (R6), so what /api/ps says now is not `s`'s placement.
   */
  const crossed = (s: Sent): boolean => [...(flights.get(keyOf(s.server, s.model)) ?? [])].some(([ctx, f]) => ctx !== s.ctx && (f.open > 0 || f.ended > s.at))
  /**
   * After an Ollama answer under auto with a figure (R3): one GET of /api/ps, detached and chained, when the answer was
   * slow, ran out of time, or this server, model and context were not measured this visit; the next look or answer
   * awaits it. Then, the context's growth is decided (R4), with no request of its own.
   */
  const after = (sent: Sent, a: Answer | null, timedOut: 'cold' | 'stall' | null): void => {
    if (sent.gen !== generation) return
    const counted = a !== null && a.pace !== undefined && a.tokens >= PACE_TOKENS
    const pace = a?.pace ?? (timedOut === 'stall' ? 0 : null)
    const slow = timedOut !== null || (counted && pace !== null && pace < PACE_FLOOR)
    const k = measuredKey(sent)
    // Measured once a visit while quick; a measurement dropped or failed (nothing kept) is asked again after the next.
    if (!slow && verified.has(k)) { widenAfter(sent, a); return }
    // Once measured, the model the next answer goes to (and what the row says) follows at once.
    const follow = (): void => { if (kept.provider === 'auto' && found === 'ollama' && unchosen()) { const n = listedHere()?.map((m) => m.name); if (n) repick(n) } }
    const run = (measuring ?? Promise.resolve()).then(() => measure(sent, pace, slow, timedOut === 'cold')).then(follow).then(() => widenAfter(sent, a)).catch(() => {})
    measuring = run
    void run.finally(() => { if (measuring === run) measuring = null })
  }
  /**
   * R4: after an answer cut at its answer cap, the model's context doubles for the rest of the visit when modelFit.ts
   * widen says so, inside the gate, with no settings change since it was sent and the model the next answer goes to
   * (after the measurement's own repick) still the one that answered. It asks nothing.
   */
  const widenAfter = (sent: Sent, a: Answer | null): void => {
    const f = figure()
    if (a === null || sent.gen !== generation || f === null || !gate()) return
    if (ollama.settings().server !== sent.server || ollamaModel() !== sent.model) return
    const k = keyOf(sent.server, sent.model)
    const n = widen({ reason: a.reason, tokens: a.tokens, pace: a.pace ?? null, ctx: sent.ctx, placed: placements.get(measuredKey(sent)) ?? null, weights: bytesOf(sent.model), figure: f, grown: wide.has(k) })
    if (n !== null) wide.set(k, { state: 'grown', from: sent.ctx, ctx: n, tried: n })
  }
  /**
   * A grown context goes back to the one it grew from for the rest of this visit (R5), and why: only while it is the
   * context `sent` was sent at (an answer from an older one says nothing of it).
   */
  const back = (sent: Sent, why: Back): void => {
    const k = keyOf(sent.server, sent.model); const w = wide.get(k)
    if (w !== undefined && w.state !== 'back' && w.ctx === sent.ctx) wide.set(k, { state: 'back', from: w.from, ctx: w.from, tried: sent.ctx, why, ...(w.trained !== undefined && { trained: w.trained }) })
  }
  /**
   * R5: the measurement of an answer at a grown context: modelFit.ts contextVerdict says whether it stays, takes the
   * trained context Ollama reported, or goes back. It never sets a model aside, never stops a bigger step, and is never
   * kept as a measurement (R6). Not loaded after a first wait ran out: one more chance this visit, then back.
   */
  const judge = (sent: Sent, placed: Placement | null, slow: boolean, cold: boolean): void => {
    const k = keyOf(sent.server, sent.model); const w = wide.get(k)
    if (w === undefined || w.state === 'back' || w.ctx !== sent.ctx) return
    if (placed === null) {
      if (cold) { const m = measuredKey(sent); if (coldWide.has(m)) back(sent, 'load'); else coldWide.add(m) }
      return
    }
    const v = contextVerdict({ placed, from: w.from, ctx: sent.ctx, slow, cold })
    if (v === null) return
    if (v.kind === 'good') { wide.set(k, { ...w, state: 'good', loaded: placed.loaded }); verified.add(measuredKey(sent)); return }
    if (v.kind === 'back') { back(sent, v.why); return }
    // Ollama ran it at its trained context: that, measured at the next answer, when above the context it grew from.
    wide.set(k, v.ctx > w.from ? { state: 'grown', from: w.from, ctx: v.ctx, tried: v.ctx, trained: v.trained } : { state: 'back', from: w.from, ctx: w.from, tried: sent.ctx, why: 'trained', trained: v.trained })
  }
  /**
   * The measurement itself (R4): where Ollama has the model loaded, and the verdict. A measurement sent before a
   * settings change is dropped, before and after the request, and so is one read once an answer at another context
   * may have loaded the model again (crossed). One at a grown context is judged apart (R5).
   */
  const measure = async (sent: Sent, pace: number | null, slow: boolean, cold: boolean): Promise<void> => {
    if (sent.gen !== generation) return
    const placed = await placementOf(fetchFn, sent.server, sent.model, AbortSignal.timeout(lookMs))
    if (sent.gen !== generation || crossed(sent)) return
    if (sent.ctx !== CONTEXT_TOKENS) { judge(sent, placed, slow, cold); return }
    const k = keyOf(sent.server, sent.model); const big = larger(sent.model)
    // Not loaded after a first wait ran out: one more chance this visit, then set aside.
    if (placed === null) { if (cold) { if (coldOnce.has(k)) { aside.add(k); if (big && moved()) grow = false } else coldOnce.add(k) } return }
    const where = whereOf(placed)
    // Whole on the GPU, or whole on the processor, after a first wait ran out: still loading, no verdict.
    if (cold && where !== 'split') return
    const bad = failed({ where, slow }, { larger: big, cold })
    const prev = seenHere().find((x) => x.model === sent.model)?.fails ?? 0
    const fails = bad ? (aside.has(k) ? prev : Math.min(FAILS_KEPT, prev + 1)) : 0
    if (bad) { aside.add(k); if (big && moved()) grow = false }
    verified.add(measuredKey(sent)); placements.set(measuredKey(sent), placed)
    const weights = bytesOf(sent.model); if (weights === null) return
    const fit = kept.fit ?? (kept.fit = { vram: null, seen: [] })
    fit.seen = remember(fit.seen, { server: sent.server, model: sent.model, weights, loaded: placed.loaded, gpu: placed.gpu, pace, fails })
    keep()
  }
  /**
   * The ask's one answer more (R5's at the context grown from, or R8's from the model auto picks next), sent as `retry`
   * says (null: not measured) and measured as any other. When it went at a grown context (R8's may) and Ollama refuses
   * it or fails partway, that context goes back (R5), and the failure is the ask's.
   */
  const once = async (req: AnswerRequest, onPiece: (p: Piece) => void, retry: Sent | null): Promise<Answer> => {
    let arrived = false
    try {
      const a = await flown(retry, () => ollama.answer(req, (p) => { arrived = true; onPiece(p) }))
      if (retry) after(retry, a, null)
      return a
    } catch (e) {
      if (retry && retry.ctx !== CONTEXT_TOKENS && !req.signal.aborted && e instanceof CognitionError && e.code === 'server') back(retry, arrived ? 'partway' : 'load')
      throw e
    }
  }
  /**
   * auto's answer: the provider found at the last look (looking first when there is none); when it stops answering
   * before any of the answer arrived, one more look, and the answer from whatever answers now. A model that would not
   * load or run ('model', the in-page provider's own failure) is that answer's failure: never a reason to look again.
   * With a GPU figure, Ollama's model is chosen again from the list kept before it is sent, the answer is measured
   * after (R3), and a model auto moved to that Ollama will not load is set aside and the same ask answered once more
   * by the next one (R8). A grown context Ollama will not load goes back, and the same ask is answered once more at the
   * context it grew from (R5): that, not R8 or a look, is the ask's one retry, and there is none after a settings
   * change. One that fails after some of the answer arrived goes back too, with no retry (the text shown would be
   * written twice).
   */
  const autoAnswer = async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
    await settled(req.signal)
    // With a figure, an Ollama found without this server's list of sizes (found in the chat format, or another server
    // set since) has its list read first (one GET of /api/tags, given lookMs), so the model is sized before it is sent
    // (R5) and the operator's own can be measured; if the list cannot be read, the answer below says what is wrong.
    const os0 = ollama.settings()
    if (found === 'ollama' && figure() !== null && os0.api !== 'chat' && listedHere() === null) {
      try {
        catalog = { server: os0.server, models: await installedSizes(fetchFn, os0.server, AbortSignal.any([req.signal, AbortSignal.timeout(lookMs)])) }
      } catch {
        // not read: sent as it is
      }
      if (req.signal.aborted) throw req.signal.reason
    }
    const first = found
    if (first === 'ollama' && figure() !== null && unchosen()) { const n = listedHere()?.map((m) => m.name); if (n) repick(n) }
    const m = first !== null ? byName(first) : await look(req.signal)
    const os = ollama.settings()
    const sent: Sent | null = m === ollama && os.api !== 'chat' && os.model !== null && figure() !== null ? sending(os.server, os.model) : null
    let arrived = false
    try {
      const a = await flown(sent, () => m.answer(req, (p) => { arrived = true; onPiece(p) }))
      if (sent) after(sent, a, null)
      return a
    } catch (e) {
      if (sent && !req.signal.aborted && e instanceof CognitionError && e.code === 'timeout') after(sent, null, arrived ? 'stall' : 'cold')
      if (sent && sent.ctx !== CONTEXT_TOKENS && !req.signal.aborted && e instanceof CognitionError && e.code === 'server') {
        // R5: back for the visit, whatever changed since it was sent (back acts only while that context is the model's).
        // Some of the answer shown, or a settings change since it was sent: the failure is the ask's (no retry, never R8
        // or a look, so the model is never set aside for its context).
        back(sent, arrived ? 'partway' : 'load')
        if (arrived || sent.gen !== generation) throw e
        // Once, at the context it grew from, and that answer is measured as any other: what it is sent with is taken
        // before it is sent, so a settings change while it runs drops its measurement.
        const again = ollama.settings()
        return once(req, onPiece, again.model !== null ? sending(again.server, again.model) : null)
      }
      if (sent && !arrived && !req.signal.aborted && e instanceof CognitionError && e.code === 'server' && moved() && unchosen()) {
        aside.add(keyOf(sent.server, sent.model)); if (larger(sent.model)) grow = false
        const n = listedHere()?.map((x) => x.name); if (n) repick(n)
        const again = ollama.settings()
        // R8: once, and that answer is measured too (unless the settings change while it runs).
        if (again.model !== null && again.model !== sent.model) return once(req, onPiece, sending(again.server, again.model))
      }
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
  const autoLine = (): string => (found === 'inpage' ? `inpage: ${IN_PAGE_PLACE}, found ready to run on this device (ask provider inpage keeps it)`
    : found !== null ? `${found} at ${byName(found).settings().server}, found answering on this machine (ask provider ${found} keeps it)` : `nothing found yet: the next ask looks on this machine${lookNote}`)
  /** The Ollama client's own first-piece wait, ms. */
  const firstMs = (timeouts ?? TIMEOUTS).firstMs
  /** The fit row under auto (modelFit.ts fitLine): undefined under another provider, and with no figure (unless off). */
  const fitNow = (): string | undefined => {
    if (kept.provider !== 'auto') return undefined
    const s = ollama.settings()
    const usual = usualName()
    const last = seenHere().at(-1) ?? null
    const verdict: 'big' | 'slow' | null = last !== null && (aside.has(keyOf(last.server, last.model)) || last.fails > 0) ? (whereOf(last) === 'split' ? 'big' : 'slow') : null
    const cold = choice !== null ? coldWaitMs(choice.bytes) : 0
    const model = ollamaModel(); const w = wide.get(keyOf(s.server, model))
    return fitLine({
      figure: figure(), off: kept.fit?.vram === 0, found, chat: s.api === 'chat', theirs: unchosen() ? null : s.model,
      choice, usual: { name: usual, bytes: bytesOf(usual) }, last, verdict, anyAside: avoided().size > 0, grow,
      coldMs: cold > firstMs ? cold : 0, context: w !== undefined ? { ...w, model } : null,
    })
  }
  /** `ask model auto` (R10): the Ollama model is auto's to choose again: the default for now, auto's own pick at once when Ollama's list is kept. */
  const handBack = (): string => {
    generation++
    delete kept.picked
    if (kept.fit) delete kept.fit.usual
    ollama.setModel(DEFAULT_MODEL)
    choice = null
    keep()
    if (kept.provider !== 'auto') return `auto: ${DEFAULT_MODEL} for now; auto chooses the Ollama model only under ask provider auto`
    const names = found === 'ollama' ? listedHere()?.map((m) => m.name) : undefined
    if (names) {
      repick(names)
      return `auto: auto chooses the Ollama model again (${ollamaModel()} now)`
    }
    found = null // so the next ask really looks, and chooses from what Ollama lists then
    return 'auto: auto chooses the Ollama model again at its next look'
  }

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
      const fit = fitNow()
      return { ...s, ...own, ...(line !== null && { cache: line }), ...(kept.provider === 'auto' && { auto: autoLine(), ...(found !== null && { found }), ...(fit !== undefined && { fit }) }) }
    },
    setServer: (url: string) => {
      const set = settable().setServer(url)
      generation++
      return set
    },
    setModel: (name: string) => {
      const n = typeof name === 'string' ? name.trim() : ''
      if (n === 'auto' && (kept.provider === 'ollama' || (kept.provider === 'auto' && (found === null || found === 'ollama')))) return handBack()
      const m = settable()
      const set = m.setModel(name)
      generation++
      // The operator chose the Ollama model: auto leaves it alone from now on.
      if (m === ollama) {
        kept.picked = null
        if (kept.fit) delete kept.fit.usual
        choice = null
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
      const set = m.setApi(format)
      generation++
      return set
    },
    setProvider: (name: string): Provider => {
      const n = typeof name === 'string' ? name.trim().toLowerCase() : ''
      if (!isProvider(n)) throw new TypeError(`ask provider takes ${PROVIDERS.join(', ')}`)
      generation++
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
    setVram: (value: string): string => {
      const v = parseVram(value) // TypeError(VRAM_USAGE)
      generation++
      const fit: FitKept = kept.fit ?? { vram: null, seen: [] }
      fit.vram = v === 'auto' ? null : v; fit.seen = []
      aside.clear(); verified.clear(); coldOnce.clear(); grow = true; choice = null
      // R7: the contexts grown this visit go back to CONTEXT_TOKENS with what was measured.
      wide.clear(); placements.clear(); coldWide.clear()
      // The model auto had moved to goes back to the usual one, while it is still auto's own.
      if (fit.usual !== undefined && unchosen()) { ollama.setModel(fit.usual); kept.picked = fit.usual }
      delete fit.usual; kept.fit = fit; keep()
      const under = kept.provider !== 'auto' ? '; it applies under ask provider auto' : ''
      if (v === 'auto') {
        const f = figure()
        const from = f?.from === 'app' ? 'read from the GPUs by the Windows app' : "from the page's address (vram=)"
        return `${f !== null ? `auto: ${f.gb.toFixed(1)} GB ${from}; what was measured before is forgotten` : 'auto: no GPU size given, so auto keeps its usual model; what was measured before is forgotten'}${under}`
      }
      if (v === 0) return `0: auto sizes nothing by the GPU, whatever the page's address or the Windows app says; what was measured before is forgotten (ask vram auto hands it back)${under}`
      return `${v.toFixed(1)} GB at the console, kept: auto may give Ollama a bigger model it already has once an answer has been measured; what was measured before is forgotten${under}`
    },
    connect: (provider: string, url?: string, key?: string): string => {
      const n = typeof provider === 'string' ? provider.trim().toLowerCase() : ''
      if (!isProvider(n)) throw new TypeError(`ask connect takes ${PROVIDERS.join(', ')}, then an optional server url and, for claude, a key`)
      const u = typeof url === 'string' ? url.trim() : ''
      const k = typeof key === 'string' ? key.trim() : ''
      if (n === 'scripted' && (u || k)) throw new Error('the scripted provider takes no server and no key: it answers on this page')
      if (n === 'auto' && (u || k)) throw new Error('auto takes no server and no key: it looks at each provider\'s own (ask connect <provider> <url> sets one)')
      if (n === 'inpage' && (u || k)) throw new Error('the inpage provider takes no server and no key: the model runs in this page (Menu › Model file, or ask file, chooses one)')
      if (k && n !== 'claude') throw new Error(`the ${n} provider takes no key: a server on this machine needs none`)
      // Checked before anything changes, so a bad address leaves the provider as it was.
      const target = n === 'scripted' || n === 'auto' ? scripted : byName(n)
      // A rejected value is quoted only when it reads as a plain address: a key typed where the url goes (`ask connect
      // claude <key>`) is never echoed back to the screen.
      const said = /^https?:\/\/[^\s@]*$/i.test(u) ? `, not '${u}'` : ': the second word must be a server url such as http://localhost:8089 (a key alone goes in with ask key <key>)'
      if (u && n === 'claude' && claudeServer(u) === null) throw new Error(`the Claude provider speaks only to a gateway on this machine (localhost, 127.0.0.1 or [::1])${said}`)
      if (u && n !== 'claude' && n !== 'scripted' && n !== 'auto' && n !== 'inpage' && claudeServer(u) === null) throw new Error(`the local model server must be on this machine (localhost, 127.0.0.1 or [::1])${said}`)
      generation++
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
      await cache.page(agentKey(req.tethers), systemPrompt(req.tethers, req.memories, req.context, req.steering))
      return kept.provider === 'auto' ? autoAnswer(req, onPiece) : active().answer(req, onPiece)
    },
  }
  return Object.freeze(router)
}
