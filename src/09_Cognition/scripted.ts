// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how an agent still answers when no model backend is there: the Claude gateway on
 * this machine is not running, a local model server is down, or the page was opened with no provider set up. Instead
 * of an error in the console the bound people answer in a few scripted sentences built from exactly what a model
 * would have been told (operator.ts AnswerRequest: their skills, where they stand and what just happened, 08_Swarm
 * shortTerm.ts), so a brand-new visitor who talks to someone in the city gets a person answering from that place and
 * moment rather than a message about servers. It wraps a Mind (operator.ts) and changes nothing else about it: when
 * the mind answers, its answer is the answer; only an offline or refused backend (localCompute.ts CognitionError
 * 'offline' or 'refused') falls back to the script. The script is deterministic (the same request gives the same
 * words), carries no model and makes no request, and its words are screened on the way out like any answer (the
 * operator tier's 14A screen in gatedAsk sees every piece). A script is never mistaken for a model: the answer's
 * reason says 'scripted' and its standIn says why no model answered, so the console says so under the answer and
 * neither the diary nor the short-term memory keeps the script's words as something a person said.
 * What breaks if it is removed? With no backend, `ask` fails with a server message, and the city's people are mute.
 */
import type { Answer, AnswerRequest, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { CognitionError } from './localCompute.ts'

/** The reason a scripted answer carries (Answer.reason), so a diary or a log tells it from a model's 'stop'. */
export const SCRIPTED = 'scripted'

/** The failures the script stands in for: nothing is listening, or it will not talk to this page. Anything else is reported as before. */
const STANDS_IN_FOR: readonly string[] = Object.freeze(['offline', 'refused'])

/** The first few words of a prompt, for a reply that echoes the question. */
function gist(prompt: string, max = 60): string {
  const line = prompt.split('\n')[0].replace(/\s+/g, ' ').trim().replace(/[?!.]+$/, '')
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * The scripted answer for a request: who speaks (the first bound person), from where (their surroundings sentence
 * when known), what they recall of the last moments, what they can help with (their skills) and a plain word on the
 * question. Deterministic; a few short sentences; plain text.
 */
export function scriptedAnswer(req: AnswerRequest): string {
  const bound = req.tethers
  if (!bound.length) return 'Nobody is here to answer.'
  const me = bound[0]
  const ctx = req.context?.find((c) => c.agent === me.agent)
  const skills = [...new Set(bound.flatMap((t) => t.skills))]
  const lines: string[] = []
  if (ctx?.surroundings) lines.push(ctx.surroundings.replace(/^Standing/, "I'm standing"))
  const last = ctx?.recent.at(-1)
  if (last && last.who !== 'you') lines.push(`A moment ago ${last.who} ${last.what.replace(/^asked "([^"]*)" and you answered "([^"]*)"$/, 'asked me "$1" and I said "$2"')}.`)
  const q = gist(req.prompt)
  if (q) lines.push(`You ask about "${q}".`)
  if (skills.length) lines.push(`I can help with ${skills.join(', ')}; that is what I know.`)
  lines.push(bound.length > 1 ? `There are ${bound.length} of us here with you; ask and we will do what we can.` : 'Ask me plainly and I will do what I can.')
  return lines.join(' ')
}

/** Whether `err` is a backend that is not there, which the script stands in for. */
export const scriptStandsIn = (err: unknown): boolean => err instanceof CognitionError && STANDS_IN_FOR.includes(err.code)

/**
 * The mind with the script behind it: `answer` asks the mind and, only when its backend is offline or refused, streams
 * the scripted answer instead (one piece, then an Answer with reason SCRIPTED and no tokens). `scripted` counts the
 * answers the script gave; `settings()` says so in a `scripted` line once it has.
 */
export function withScriptedFallback(mind: Mind): Mind & { readonly scripted: number } {
  let scripted = 0
  const wrapped = {
    ...mind,
    settings: () => {
      const s = mind.settings()
      return scripted ? { ...s, scripted: `${scripted} answer${scripted === 1 ? '' : 's'} came from the script (no backend was answering)` } : s
    },
    answer: async (req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      try {
        return await mind.answer(req, onPiece)
      } catch (err) {
        if (!scriptStandsIn(err) || req.signal.aborted) throw err
        scripted++
        const text = scriptedAnswer(req)
        onPiece({ kind: 'text', text })
        // Why the model did not answer goes with the script's words, so the console says so and nothing remembers them.
        return { text, thinking: 0, tokens: 0, reason: SCRIPTED, standIn: (err as Error).message }
      }
    },
    get scripted(): number {
      return scripted
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
  return Object.freeze(wrapped) as Mind & { readonly scripted: number }
}
