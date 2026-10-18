// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the cloud fallback throttle: when the page's own frame rate has fallen below
 * FALLBACK.fps over a rolling window, a complex prompt bound for a model server on this machine (ollama, llamacpp, openai:
 * the same GPU and CPU the city is drawn with) goes to the cognition router's cloud provider instead (the Claude API
 * through the operator's loopback gateway), so local compute stays with the frames. It wraps a Mind (operator.ts)
 * and changes nothing else about it: the same prompt, tethers and memories, the same pieces streamed, the same
 * answer and prompt hash. It never adds a network call of its own: the cloud provider it hands a prompt to is the
 * router's, which speaks only to a loopback origin (02_Define_The_Rules/airgap.ts is the gate). It does nothing at
 * all when the mind has no cloud provider, when the cloud provider is already the chosen one, when the frame rate
 * is unknown (fewer than FALLBACK.minFrames in the window) or fine, and for a simple prompt (one person, a short
 * line, nothing remembered), which a local model answers cheaply. The cloud provider is a gateway the operator may
 * never have started: when it fails before any of its answer arrived, the local model answers after all, and the
 * throttle leaves prompts local for FALLBACK.retryMs before it tries the gateway again.
 * What breaks if it is removed? A heavy prompt to a local model contends with the frames on the same machine, and
 * the page stutters while it thinks.
 */
import type { Answer, AnswerRequest as MindRequest, Mind, Piece } from '../07_Execute_Actions/operator.ts'

/** The throttle's policy, frozen. */
export const FALLBACK = Object.freeze({
  /** Below this many frames a second, over the window, local compute is spared. */
  fps: 30,
  /** The rolling window the rate is measured over, ms: several seconds, so one long frame decides nothing. */
  windowMs: 2000,
  /** Frames the window must hold before the rate means anything (a page that has just started is not slow). */
  minFrames: 30,
  /** A prompt longer than this is complex on its own, characters. */
  promptChars: 240,
  /** After the cloud provider failed to answer, how long prompts stay local before it is tried again, ms. */
  retryMs: 60_000,
} as const)

/**
 * A rolling window of frame times: `push` each frame's time, `fps` the rate over the last FALLBACK.windowMs. The
 * window is a ring of fixed size (no allocation per frame); frames older than the window are ignored.
 */
export class FrameRate {
  readonly #times: Float64Array
  #n = 0
  #last = NaN

  constructor(capacity = 600) {
    this.#times = new Float64Array(capacity)
  }

  push(nowMs: number): void {
    if (!Number.isFinite(nowMs)) return
    this.#times[this.#n++ % this.#times.length] = nowMs
    this.#last = nowMs
  }

  /** Frames a second over the window ending at `nowMs` (the last pushed time by default), or null before FALLBACK.minFrames. */
  fps(nowMs = this.#last): number | null {
    if (!Number.isFinite(nowMs)) return null
    const cap = this.#times.length
    const count = Math.min(this.#n, cap)
    let inWindow = 0, oldest = nowMs
    for (let k = 1; k <= count; k++) {
      const t = this.#times[(this.#n - k + cap) % cap]
      if (t < nowMs - FALLBACK.windowMs) break
      inWindow++
      oldest = t
    }
    if (inWindow < FALLBACK.minFrames) return null
    const span = nowMs - oldest
    return span > 0 ? ((inWindow - 1) * 1000) / span : null
  }

  /** True when the window is full enough and the rate is below FALLBACK.fps. */
  get slow(): boolean {
    const f = this.fps()
    return f !== null && f < FALLBACK.fps
  }
}

export type AnswerRequest = MindRequest

/** A complex swarm intent: more than one person speaks, the prompt is long, or what they remember (long term, or the last moments) is in it. */
export function isComplex(req: AnswerRequest): boolean {
  const agents = new Set(req.tethers.map((t) => t.agent)).size
  if (agents > 1) return true
  if (req.prompt.length > FALLBACK.promptChars) return true
  if ((req.memories?.some((m) => m.lines.length > 0)) === true) return true
  return (req.context?.some((c) => c.recent.length > 0)) === true
}

/** The provider names the cognition router gives a model server on this machine (router.ts Provider). */
export const LOCAL_PROVIDERS: readonly string[] = Object.freeze(['ollama', 'llamacpp', 'openai'])

/** A Mind that may carry the router's cloud provider beside it (router.ts MindRouter.cloud). */
export type CloudCapable = Mind & { readonly cloud?: Mind }

/** What the throttle reports (the console's `ask` shows it as the `fallback` setting). */
export interface FallbackReport {
  /** The frame rate over the window, or null while unknown. */
  fps: number | null
  /** True while the rate is below the threshold and a cloud provider stands ready behind a local one. */
  throttled: boolean
  /** Prompts sent to the cloud provider so far because of the throttle. */
  offloaded: number
  /** Of those, the ones the cloud provider did not answer, so the local model did. */
  missed: number
}

/**
 * The mind with the throttle in front of it: `answer` goes to `mind.cloud` when the frames are slow, a local
 * provider is chosen and the prompt is complex; to `mind` otherwise. `settings()` gains a `fallback` line.
 */
export function withCloudFallback(mind: CloudCapable, rate: FrameRate, now: () => number = Date.now): Mind & { readonly fallback: FallbackReport } {
  let offloaded = 0
  let missed = 0
  /** When the cloud provider last failed to answer (prompts stay local for FALLBACK.retryMs after). */
  let missedAt = -Infinity
  const cloud = mind.cloud ?? null
  // The provider that answers: the chosen one, or the one the auto provider found (router.ts).
  const provider = (): string | undefined => {
    const s = mind.settings()
    return s.provider === 'auto' ? s.found : s.provider
  }
  const standsReady = (): boolean => cloud !== null && LOCAL_PROVIDERS.includes(provider() ?? '')
  const resting = (): boolean => now() - missedAt < FALLBACK.retryMs
  const report = (): FallbackReport => ({ fps: rate.fps(), throttled: standsReady() && rate.slow && !resting(), offloaded, missed })
  const line = (): string => {
    const r = report()
    if (cloud === null) return 'none: this mind has no cloud provider'
    if (provider() === 'scripted') return 'off: the scripted provider asks no model, so there is nothing to move'
    if (provider() === undefined) return 'off: no model has been found on this machine yet'
    if (!LOCAL_PROVIDERS.includes(provider() ?? '')) return `off: the ${provider() ?? 'chosen'} provider is not on this machine's compute`
    const fps = r.fps === null ? 'frame rate not yet known' : `${r.fps.toFixed(0)} fps`
    const miss = missed ? `; ${missed} of them unanswered there, so answered here${resting() ? ', and prompts stay here for a minute' : ''}` : ''
    return `${r.throttled ? 'on' : 'off'}: complex prompts go to the Claude API below ${FALLBACK.fps} fps (${fps}; ${offloaded} sent so far${miss})`
  }
  const wrapped = {
    ...mind,
    settings: () => ({ ...mind.settings(), fallback: line() }),
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      if (cloud === null || !standsReady() || !rate.slow || resting() || !isComplex(req)) return mind.answer(req, onPiece)
      offloaded++
      let arrived = false
      try {
        return await cloud.answer(req, (p) => { arrived = true; onPiece(p) })
      } catch (e) {
        // The gateway is not there (or would not answer): the local model the operator chose answers after all. Once
        // the cloud's answer has begun, its failure is the answer's.
        if (arrived || req.signal.aborted) throw e
        missed++
        missedAt = now()
        return mind.answer(req, onPiece)
      }
    },
    get fallback(): FallbackReport {
      return report()
    },
  }
  // The optional setters stay the mind's own (bound to it), so a provider swap at the console still lands there.
  for (const k of ['setThink', 'setApi', 'setProvider', 'setKey', 'setEffort', 'connect'] as const) {
    const fn = mind[k]
    if (fn) (wrapped as unknown as Record<string, unknown>)[k] = fn.bind(mind)
  }
  wrapped.setServer = mind.setServer.bind(mind)
  wrapped.setModel = mind.setModel.bind(mind)
  wrapped.installed = mind.installed.bind(mind)
  return Object.freeze(wrapped) as Mind & { readonly fallback: FallbackReport }
}
