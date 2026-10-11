// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how the concierge speaks during the onboarding: in its own scripted words always, and,
 * when a model backend is configured and answers in time (the cognition router: Claude through the visitor's loopback
 * gateway, Ollama or llama.cpp on this machine), in that model's rewording of the same line for a brand-new visitor.
 * The script is shown first and stays if the model is slow, silent, errors, or answers with something too long or
 * that drops a choice the line names, so the onboarding never waits on a model and never loses a question.
 * What breaks if it is removed? The concierge has only its script (which is fine), and the configured backend is unused
 * until the console asks it something.
 */
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

/** Words a rewording must keep: the names and choices the line offers, so a chip still matches what was said. */
export function mustKeep(line: string, keep: readonly string[]): boolean {
  const low = line.toLowerCase()
  return keep.every((k) => low.includes(k.toLowerCase()))
}

/**
 * The model's voice over the page's mind: asks for the line in plain words for a five-year-old, keeping every question
 * and choice; falls back to the script on any failure, timeout, or an answer that is too long or drops a kept word.
 */
export function modelVoice(mind: Mind, keep: (line: string) => readonly string[] = () => [], timeoutMs = REWORD_MS): Voice {
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
          prompt: `You are a friendly guide welcoming someone who has never used a computer game. Say the following to them in plain, simple words a five-year-old would understand, in one or two short sentences. Keep every question and every choice it names exactly. Do not add offers, lists, or anything else. Reply with the words only.\n\n${line}`,
        }, (p) => { if (p.kind === 'text') text += p.text })
      } catch {
        return line
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
      const said = text.replace(/\s+/g, ' ').trim()
      if (!said || said.length > REWORD_MAX || !mustKeep(said, keep(line))) return line
      return said
    },
  }
}
