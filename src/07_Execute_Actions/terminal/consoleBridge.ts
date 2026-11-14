// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the bridge of the console alone (App.tsx TtyShell, ?boot=tty), where no engine
 * runs: the offline bridge (bridge.ts offlineBridge: everything that needs the city says 'engine not running') with
 * the operator tier's latch and its `ask` family live, so a person whose web view cannot start the city still talks to
 * Sloane. `ask <words>` puts the words to her as Sloane's card does in the city (onboarding/voice.ts sloaneChat: the
 * person's words screened under 14A first, the console's framing, where no city runs and she offers no change to it,
 * and the last turns of this conversation, the reply streamed in whole words, each step screened, cut at an action
 * line and at its length; the scripted provider kept is never asked as a model), through the page's cognition router,
 * the one the city builds (09_Cognition/pageMind.ts), so the same providers answer in the same auto order. `ask`
 * alone, `ask <setting> <value>`, `ask connect …` and `ask stop` read and change that router as the city's tier does
 * (operator.ts mindStatus, setMind, connectMind). The latch gates them as it gates the city's `ask` (`operator unlock`
 * first), the same Zeroth Law check stands before each answer (operator.ts askRefusal: the page contained, the model on
 * this machine or none), and one answer comes at a time. The router is loaded the first time it is needed (`mind`),
 * never as the console starts (a load that failed is tried again at the next need), and nothing here fetches a model
 * file: the providers answer with what is there, and where nothing answers the router's own sentence says what would.
 * `ask file load|unload|forget|log` act on the model file already kept in this page through the router's own in-page
 * mind, as the city's do (so the router's "ask file load tries again" can be followed here); choosing a file (`ask
 * file`, the picker) and `ask gpu` stay the city's.
 * What breaks if it is removed? The console alone cannot talk to Sloane.
 */
import { sloaneChat, type ChatResult, type ChatTurn } from '../onboarding/voice.ts'
import { askRefusal, connectMind, mindStatus, setMind, type AskResult, type GatedAsk, type Mind, type MindStatus, type Piece } from '../operator.ts'
import { offlineBridge, type ModelBridge, type OperatorBridge, type TerminalBridge } from './bridge.ts'

/** What the console does with the model file already kept in this page (pageMind.ts createPageMind's in-page mind). */
export type ConsoleFile = Pick<ModelBridge, 'load' | 'unload' | 'forget' | 'log'>

export interface ConsoleDeps {
  /**
   * The page's cognition router and the in-page mind it holds, made the first time they are asked for (App.tsx:
   * pageMind.ts createPageMind's router and inPage).
   */
  mind: () => Promise<{ router: Mind; inPage: ConsoleFile }>
  /** What the host vouches to the gate (App.tsx: the air gap main.tsx installed). */
  contained: () => boolean
  now?: () => number
}

/** Why a second `ask` waits, in the city tier's own words. */
export const ANSWER_COMING = "an answer is still coming: wait for it, or type 'ask stop'"
/** Why an answer ended at the person's `ask stop`, in the city tier's own words. */
export const STOPPED = 'stopped by the operator'
/** The turns of this conversation kept for the next reply (sloaneChat shows the model the last CHAT_TURNS of them). */
const TURNS_KEPT = 16

const message = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e))

/**
 * How one of Sloane's replies reads as an operator's answer (terminal/commands.ts askLines prints it): her words and
 * the time; where nothing answers, the router's own sentence; a reply held by the screen, or words refused before
 * any model was asked, no reply (as the tier disengages); a stop, what was shown and the operator's stop.
 */
export function chatAnswer(r: ChatResult, shown: string, ms: number): AskResult {
  if (r.kind === 'said') return { state: 'Authorized', text: r.text, thinking: 0, done: 'stop', ms }
  if (r.kind === 'held' || r.kind === 'refused') return { state: 'Authorized', text: '', thinking: 0, disengaged: true, ms }
  if (r.kind === 'failed' && r.why === 'stopped') return { state: 'Authorized', text: shown, thinking: 0, error: STOPPED, stopped: true, ms }
  return { state: 'Authorized', text: r.kind === 'failed' ? shown : '', thinking: 0, error: r.why, ms }
}

/** The console alone's bridge: `brand` as offlineBridge takes it, the router and the vouch from the host. */
export function consoleBridge(brand: TerminalBridge['brand'], deps: ConsoleDeps): TerminalBridge {
  const base = offlineBridge(brand)
  const now = deps.now ?? Date.now
  let unlocked = false
  let mind: Mind | null = null
  let file: ConsoleFile | null = null
  let loading: Promise<Mind> | null = null
  let answering: AbortController | null = null
  let turns: ChatTurn[] = []
  const locked = (): Error => new Error("ask: locked; type 'operator unlock' first")
  /** The router, loaded once (a load that failed is tried again at the next ask). */
  const load = (): Promise<Mind> => (loading ??= deps.mind().then((r) => {
    file = r.inPage
    return (mind = r.router)
  }, (e: unknown) => {
    loading = null
    throw e
  }))
  const loaded = (): Mind => {
    if (mind === null) throw new Error('the model providers are still loading: try again in a moment')
    return mind
  }

  const ask = (_skills: readonly string[], prompt: string): GatedAsk => {
    if (!unlocked) throw locked()
    if (answering) throw new Error(ANSWER_COMING)
    const words = String(prompt).trim()
    const ctl = new AbortController()
    answering = ctl
    const followers = new Set<(p: Piece) => void>()
    const emit = (p: Piece): void => {
      for (const fn of followers) {
        try {
          fn(p)
        } catch {
          // a follower's own failure does not stop the answer
        }
      }
    }
    const began = now()
    let shown = ''
    const result = (async (): Promise<AskResult> => {
      const m = await load()
      // The Zeroth Law, as the city's tier asks it before every answer.
      const refusal = askRefusal(m, deps.contained(), unlocked)
      if (refusal !== null) return { state: 'Authorized', text: '', thinking: 0, error: refusal, ms: now() - began }
      const asked: ChatTurn[] = [...turns, { who: 'you', text: words }]
      const r = await sloaneChat(m, () => m.settings().provider !== 'scripted', 'console').reply(asked, ctl.signal, (soFar) => {
        // Whole words as they come: what is new since the last step (a reply cut shorter shows whole at the end).
        if (!soFar.startsWith(shown)) return
        const piece = soFar.slice(shown.length)
        shown = soFar
        if (piece) emit({ kind: 'text', text: piece })
      })
      if (r.kind === 'said') turns = [...asked, { who: 'sloane' as const, text: r.text }].slice(-TURNS_KEPT)
      return chatAnswer(r, shown, now() - began)
    })().catch((e: unknown): AskResult => ({ state: 'Authorized', text: shown, thinking: 0, error: message(e), ms: now() - began }))
      .finally(() => { if (answering === ctl) answering = null })
    return Object.freeze({
      state: 'Authorized' as const,
      bound: [],
      follow: (fn: (p: Piece) => void) => {
        followers.add(fn)
        return () => { followers.delete(fn) }
      },
      result,
    })
  }

  const operator: OperatorBridge = {
    ...base.operator,
    unlock: () => { unlocked = true },
    lock: () => { unlocked = false },
    unlocked: () => unlocked,
    ask,
    askStatus: (): Promise<MindStatus> => {
      if (!unlocked) throw locked()
      return load().then(mindStatus)
    },
    askSet: (key: 'model' | 'server' | 'think' | 'api' | 'provider' | 'key' | 'effort' | 'vram', value: string): string => {
      if (!unlocked) throw locked()
      return setMind(loaded(), key, value)
    },
    askConnect: (provider: string, url?: string, key?: string): string => {
      if (!unlocked) throw locked()
      return connectMind(loaded(), provider, url, key)
    },
    askStop: (): string => {
      if (!unlocked) throw locked()
      if (!answering) return 'no answer is being generated'
      answering.abort(new DOMException(STOPPED, 'AbortError'))
      return 'stopping the answer'
    },
    ready: () => (mind !== null ? null : load().then(() => undefined)),
  }
  /** The model file already kept here, as the city's console has it (App.tsx modelBridge); the picker and the GPU stay the city's. */
  const kept = (): Promise<ConsoleFile> => load().then(() => file as ConsoleFile)
  const model: ModelBridge = {
    // offlineBridge's: pick and gpu say engine not running.
    ...(base.model as ModelBridge),
    load: () => kept().then((f) => f.load()),
    unload: () => kept().then((f) => f.unload()),
    forget: (name?: string) => kept().then((f) => f.forget(name)),
    log: () => (file ? file.log() : []),
  }
  return { ...base, operator, model }
}
