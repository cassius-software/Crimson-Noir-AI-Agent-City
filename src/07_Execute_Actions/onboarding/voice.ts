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
 * It is also Sloane in conversation (sloaneChat): talk on the card (intent.ts Brief.chat) put to the same mind with
 * Sloane's framing, streamed back under the same screen, never acting, and `none` with the router's reason where no
 * model answers, so the card can say so plainly instead of refusing.
 * What breaks if it is removed? The concierge has only its script (which is fine), the configured backend is unused
 * until the console asks it something, and nobody answers talk on Sloane's card.
 */
import { admitWords } from '../../02_Define_The_Rules/ring0Gate.ts'
import { actionCut } from '../../06_Make_Decisions/actions.ts'
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
 * under it, and the dispatch, never depend on the answer: this is Sloane's phrasing, not Sloane's decision. `live` is
 * asked at every sentence, not once when the city starts: false (the player set the scripted provider since) keeps the
 * planner's sentence and asks no mind. An answer carrying an action line ("ACTION: quality low", what the scripted mind
 * appends) is a command, never Sloane's sentence.
 */
export function sloaneVoice(mind: Mind, timeoutMs = SLOANE_REWORD_MS, live: () => boolean = () => true): Voice {
  const voice = modelVoice(mind, keepNumbers, timeoutMs, sloanePrompt)
  return {
    say: async (line, signal) => {
      let asks = false
      try {
        asks = live()
      } catch {
        asks = false
      }
      if (!asks) return line
      const said = await voice.say(line, signal)
      return ACTION_LINE.test(said) ? line : said
    },
  }
}
/** An action line in a mind's answer (06_Make_Decisions/actions.ts parses these): never said as a sentence. */
const ACTION_LINE = /\bACTION\s*:/i

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

/** One turn of the conversation on Sloane's card: the person's words, or Sloane's reply as shown. */
export interface ChatTurn { readonly who: 'you' | 'sloane'; readonly text: string }
/**
 * How one reply ended. `said`: the model's words, screened and cut to CHAT_MAX. `none`: no model answers this page (the
 * router found no server and no kept file, or the scripted provider is set), with the router's reason. `slow`: the model
 * timed out. `held`: the 14A screen stopped the model's words (nothing of them is shown). `refused`: the person's own
 * words failed the 14A screen, so no model was asked (as the operator tier disengages). `failed`: anything else, with why.
 */
export type ChatResult =
  | { readonly kind: 'said'; readonly text: string }
  | { readonly kind: 'none'; readonly why: string }
  | { readonly kind: 'slow' }
  | { readonly kind: 'held' }
  | { readonly kind: 'refused' }
  | { readonly kind: 'failed'; readonly why: string }
/** Sloane in conversation: a reply to the last of `turns`, the words so far given to `onText` as they arrive. */
export interface Chat {
  reply(turns: readonly ChatTurn[], signal: AbortSignal, onText?: (soFar: string) => void): Promise<ChatResult>
}

/** A chat reply is cut here (at the last sentence end before it, where there is one) and the model is stopped. */
export const CHAT_MAX = 600
/** The turns of the conversation the model is shown, the last one the person's. */
export const CHAT_TURNS = 8
/** Characters kept from each turn the model is shown. */
const TURN_MAX = 400
/** Why the chat answers nothing when the player set the scripted provider. */
export const SCRIPTED_CHOSEN = 'the scripted mind is chosen, and it does not hold a conversation (ask provider auto)'

/** The person's turns the model would be shown, each through the 14A screen the operator tier puts every prompt through. */
const admitted = (turns: readonly ChatTurn[]): boolean => turns.slice(-CHAT_TURNS).every((t) => t.who !== 'you' || admitWords(t.text).admitted)

/** Sloane's framing for a conversation: who Sloane is, what the city can do when asked, and the turns so far. */
export function chatPrompt(turns: readonly ChatTurn[]): string {
  const said = turns.slice(-CHAT_TURNS).map((t) => `${t.who === 'you' ? 'Person' : 'Sloane'}: ${t.text.replace(/\s+/g, ' ').trim().slice(0, TURN_MAX)}`)
  return [
    'You are Sloane, the concierge of Crimson Noir: Agent City, a city of software agents that the person is walking through. Talk with them as yourself: warm, plain and brief, one to three short sentences, no lists and no headings.',
    'If they ask what you can do: you can change the time of day, the crowds, the traffic, the picture quality and the sound, show them the controls, and send sub-agents to work at the city\'s sixteen workplaces; they only need to say what they want.',
    'Nothing you say in this conversation changes the city, so never write an ACTION line; tell them what to ask for instead. You know nothing of the news, the weather outside or the person beyond what they tell you, and you say so when asked.',
    '',
    'The conversation so far:',
    ...said,
    'Sloane:',
  ].join('\n')
}

/**
 * The words of a reply as they may be shown: nothing from the first action line on (06_Make_Decisions/actions.ts
 * actionCut, the parser's own reading, so a dressed-up line such as `**Action**: time 21:00` is cut and prose such as
 * "the best course of action: tell me" is kept), no echoed name, one line, and at most CHAT_MAX characters, cut at a
 * sentence end where there is one, else at a whole word.
 */
export function chatWords(text: string): string {
  const at = actionCut(text)
  const kept = (at < 0 ? text : text.slice(0, at)).replace(/\s+/g, ' ').trim().replace(/^sloane\s*:\s*/i, '')
  if (kept.length <= CHAT_MAX) return kept
  const cut = kept.slice(0, CHAT_MAX)
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '))
  if (end > CHAT_MAX / 2) return cut.slice(0, end + 1)
  const word = cut.lastIndexOf(' ')
  return `${(word > 0 ? cut.slice(0, word) : cut).trimEnd()}…`
}

/** A last line that may still be turning into an action line: its decoration and the word, and nothing yet to say. */
const ACTION_START = /^\s*(?:\d+[.)]\s+)?[\x60*_>"#\-\s]*(?:city\s+)?action[\x60*_"]*\s*$/i
/**
 * The words of a reply still streaming that may be shown now: whole words only (the last may still be growing, and a
 * part of a word reads as another word to the screen), and nothing of a last line that may be becoming an action line.
 */
export function chatSoFar(text: string): string {
  const nl = text.lastIndexOf('\n')
  const whole = ACTION_START.test(text.slice(nl + 1)) ? text.slice(0, nl + 1) : text
  const space = whole.search(/\s\S*$/)
  return chatWords(space < 0 ? '' : whole.slice(0, space + 1))
}

/** The failure code a cognition error carries (09_Cognition/localCompute.ts CognitionError), read without importing it. */
const codeOf = (e: unknown): string | undefined => {
  if (typeof e !== 'object' || e === null || !('code' in e)) return undefined
  const c = (e as { code?: unknown }).code
  return typeof c === 'string' ? c : undefined
}
const messageOf = (e: unknown): string => (e instanceof Error && e.message ? e.message : String(e))

/**
 * Sloane in conversation over the page's mind, as the brief's rewording is (the local servers first, then the model in
 * this page, by the router's own order; no person is tethered, so the expertise rule is lifted). The person's words are
 * screened first, as the operator tier screens every prompt (the router screens nothing): words the 14A screen refuses
 * reach no model (`refused`). Otherwise they go to the model with Sloane's framing and the last CHAT_TURNS turns; the
 * reply is streamed in whole words, each step screened with admitWords (a refused word stops the model and shows nothing
 * of the reply), cut at the first action line by the parser's own reading (a conversation never acts: the planner does,
 * from what the person asks) and at CHAT_MAX, and screened whole once more at the end. The router's own waits bound the
 * reply (the first piece, a stall, a load in this page), so nothing here times it out: a model loading in this page is
 * never stopped by a deadline of Sloane's. `live` is asked at every reply: false (the scripted provider is set) answers
 * `none`.
 */
export function sloaneChat(mind: Mind, live: () => boolean = () => true): Chat {
  return {
    reply: async (turns, signal, onText) => {
      let asks = false
      try {
        asks = live()
      } catch {
        asks = false
      }
      if (!admitted(turns)) return { kind: 'refused' }
      if (!asks) return { kind: 'none', why: SCRIPTED_CHOSEN }
      if (signal.aborted) return { kind: 'failed', why: 'stopped' }
      const ctl = new AbortController()
      const onAbort = () => ctl.abort(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
      let text = ''
      let shown = ''
      let held = false
      let full = false
      try {
        const answer = await mind.answer({ tethers: [], signal: ctl.signal, prompt: chatPrompt(turns) }, (p) => {
          if (p.kind !== 'text' || held || full) return
          text += p.text
          const words = chatSoFar(text)
          if (!admitWords(words).admitted) {
            held = true
            ctl.abort(new Error('the 14A screen stopped the reply'))
            return
          }
          // At an action line, or past the cap (the words shown are already cut to it): enough, and the model stops.
          if (actionCut(text) >= 0 || text.replace(/\s+/g, ' ').trim().length > CHAT_MAX) {
            full = true
            ctl.abort(new Error('the reply is long enough'))
          }
          if (words !== shown) {
            shown = words
            onText?.(words)
          }
        })
        if (answer.standIn !== undefined) return { kind: 'none', why: answer.standIn }
      } catch (e) {
        if (held) return { kind: 'held' }
        if (!full) {
          if (signal.aborted) return { kind: 'failed', why: 'stopped' }
          const code = codeOf(e)
          if (code === 'offline') return { kind: 'none', why: messageOf(e) }
          if (code === 'timeout') return { kind: 'slow' }
          return { kind: 'failed', why: messageOf(e) }
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
      const said = chatWords(text)
      if (!said) return { kind: 'failed', why: 'the model said nothing' }
      if (!admitWords(said).admitted) return { kind: 'held' }
      return { kind: 'said', text: said }
    },
  }
}
