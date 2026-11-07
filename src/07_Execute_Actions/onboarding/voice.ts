// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how the concierge speaks during the onboarding: in its own scripted words always, and,
 * when a model backend is configured and answers in time (the cognition router: Claude through the visitor's loopback
 * gateway, Ollama or llama.cpp on this machine), in that model's rewording of the same line for a brand-new visitor.
 * The script is shown first and stays if the model is slow, silent, errors, or answers with something too long,
 * that drops a choice the line names, or that fails the 14A screen (02_Define_The_Rules/ring0Gate.ts admitWords: the
 * one place a model's words are shown as the city's own without the operator tier, so the Zeroth Law's screen is
 * applied here), so the onboarding never waits on a model, never loses a question and never shows a refused word.
 * What breaks if it is removed? The concierge has only its script (which is fine), and the configured backend is unused
 * until the console asks it something.
 */
import { admitWords } from '../../02_Define_The_Rules/ring0Gate.ts'
import type { Mind } from '../operator.ts'

/** Something that says a line: the words to show for it. */
export interface Voice {
  /** The words for `line`, aborted by `signal`; the line itself when nothing better is had in time. */
  say(line: string, signal: AbortSignal): Promise<string>
}

/** The script, word for word. */
export const scriptedVoice = (): Voice => ({ say: (line) => Promise.resolve(line) })

/** A reworded line may be at most this long: a model that rambles is not what a first visitor needs. */
export const REWORD_MAX = 240
/** How long the model has before the script stands. */
export const REWORD_MS = 2500

/** The onboarding's framing of a line for the model: plain words for a five-year-old, every question and choice kept. */
export const welcomePrompt = (line: string): string =>
  `You are a friendly guide welcoming someone who has never used a computer game. Say the following to them in plain, simple words a five-year-old would understand, in one or two short sentences. Keep every question and every choice it names exactly. Do not add offers, lists, or anything else. Reply with the words only.\n\n${line}`

/** How long Sloane's rewording of a brief may take: the card already shows the planner's sentence, so longer than the onboarding's. */
export const SLOANE_REWORD_MS = 4000

/** Sloane's framing of the planner's sentence (06_Make_Decisions/intent.ts rootOf): their own words, every number and place kept. */
export const sloanePrompt = (line: string): string =>
  `You are Sloane, the concierge of a city of software agents, telling the person you help what the city will do. Say the following in your own warm, plain words, in one or two short sentences. Keep every number and every place name exactly. Do not add offers, lists, questions, or anything else. Reply with the words only.\n\n${line}`

/** Every number the line carries (a count of sub-agents, a time): a rewording that drops one is not said. */
export const keepNumbers = (line: string): readonly string[] => line.match(/\d+/g) ?? []

/**
 * Sloane's voice over the page's mind for the card's brief: the planner's sentence reworded in Sloane's words (the
 * local servers first, then the model in this page, by the router's own order), screened as the onboarding's is
 * (REWORD_MAX, the numbers kept, admitWords), and the planner's sentence itself on any failure or timeout. The plan
 * under it, and the dispatch, never depend on the answer: this is Sloane's phrasing, not Sloane's decision.
 */
export function sloaneVoice(mind: Mind, timeoutMs = SLOANE_REWORD_MS): Voice {
  return modelVoice(mind, keepNumbers, timeoutMs, sloanePrompt)
}

/** Words a rewording must keep: the names and choices the line offers, so a chip still matches what was said. */
export function mustKeep(line: string, keep: readonly string[]): boolean {
  const low = line.toLowerCase()
  return keep.every((k) => low.includes(k.toLowerCase()))
}

/**
 * The model's voice over the page's mind: asks for the line in plain words for a five-year-old, keeping every question
 * and choice; falls back to the script on any failure, timeout, or an answer that is too long, drops a kept word or
 * fails the 14A screen.
 */
export function modelVoice(mind: Mind, keep: (line: string) => readonly string[] = () => [], timeoutMs = REWORD_MS, ask: (line: string) => string = welcomePrompt): Voice {
  return {
    say: async (line, signal) => {
      const ctl = new AbortController()
      const onAbort = () => ctl.abort(signal.reason)
      if (signal.aborted) return line
      signal.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => ctl.abort(new Error('the model took too long')), timeoutMs)
      let text = ''
      try {
        await mind.answer({
          tethers: [],
          signal: ctl.signal,
          prompt: ask(line),
        }, (p) => { if (p.kind === 'text') text += p.text })
      } catch {
        return line
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const said = text.replace(/\s+/g, ' ').trim()
      if (!said || said.length > REWORD_MAX || !mustKeep(said, keep(line)) || !admitWords(said).admitted) return line
      return said
    },
  }
}
