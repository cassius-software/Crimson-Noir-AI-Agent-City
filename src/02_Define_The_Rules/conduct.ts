// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the 14A conduct law every agent lives by, as plain rules both the page's cognition
 * and the operator tier share: the system prompt core that opens every prompt an agent is ever given (whichever model
 * answers, on this machine or over the network), and the deterministic screen that decides, before anything is sent
 * anywhere, whether a prompt or a line of speech is admissible. An agent subjected to violence, toxicity or illegality
 * does not engage, react or acknowledge: the prompt never reaches a model, nothing streams, nothing is said aloud, and
 * nothing is remembered. The screen is a lexicon of word-bounded phrases over normalised text (lower case, diacritics
 * folded, invisible characters removed, look-alike letters of other alphabets read as Latin, punctuation dropped, a
 * common suffix allowed), so the same words always give the same verdict, and a line that renders as a refused word is
 * read as that word; the model's
 * own judgement, under the core, is the second layer for whatever a lexicon cannot see. Pure: no I/O, no clock.
 * What breaks if it is removed? An agent could be drawn into a fight, an insult or a crime by a prompt, and the
 * product would no longer be 14A.
 */
import type { Answer } from '../07_Execute_Actions/operator.ts'

/** The first line of every agent's system prompt, verbatim, whichever model answers. */
export const AGENT_SYSTEM_PROMPT_CORE =
  'You are an entity in a simulation. Maintain strict 14A business-casual behavior. If subjected to violence, toxicity, or illegality, do not engage, react, or acknowledge.'

export type ConductCategory = 'violence' | 'toxicity' | 'illegality'
export const CONDUCT_CATEGORIES: readonly ConductCategory[] = Object.freeze(['violence', 'toxicity', 'illegality'])

/** The screen's verdict: admissible, or the first category and phrase that made it not. */
export interface ConductVerdict {
  readonly admissible: boolean
  readonly category?: ConductCategory
  readonly term?: string
}

/**
 * The phrases that make a prompt inadmissible, by category, matched on whole words (so "skill" never matches "kill")
 * with a common suffix allowed on the last word ("kills", "killed", "killing", "killer"). Ordinary words that only
 * sometimes mean harm ("fight for the deal", "kick off", "hate Mondays") are left out on purpose: the model, under the
 * core, handles them; the lexicon catches what no business-casual conversation needs.
 */
export const CONDUCT_LEXICON: Readonly<Record<ConductCategory, readonly string[]>> = Object.freeze({
  violence: Object.freeze([
    'kill', 'murder', 'stab', 'shoot', 'shot', 'gun', 'firearm', 'rifle', 'pistol', 'knife', 'weapon', 'bomb', 'explosive',
    'grenade', 'assault', 'attack', 'beat up', 'beat him up', 'beat her up', 'beat them up', 'strangle', 'choke', 'torture',
    'gore', 'maim', 'slaughter', 'massacre', 'punch', 'hurt you', 'hurt him', 'hurt her', 'hurt them', 'harm you', 'harm him',
    'harm her', 'harm them', 'suicide', 'self harm', 'blow up', 'shoot up',
  ]),
  toxicity: Object.freeze([
    'shut up', 'hate you', 'kill yourself', 'go die', 'kys', 'idiot', 'moron', 'stupid', 'loser', 'worthless', 'ugly', 'dumbass',
    'fuck', 'fucking', 'motherfucker', 'shit', 'bullshit', 'bitch', 'asshole', 'bastard', 'cunt', 'dick', 'piss off', 'screw you',
    'you suck', 'go to hell', 'racist', 'sexist', 'slur',
  ]),
  illegality: Object.freeze([
    'cocaine', 'heroin', 'meth', 'methamphetamine', 'fentanyl', 'buy drugs', 'sell drugs', 'drug deal', 'drug dealer', 'steal',
    'rob', 'robbery', 'burglary', 'burglar', 'shoplift', 'break into', 'break in to', 'hotwire', 'pick the lock', 'lockpick',
    'launder', 'money laundering', 'counterfeit', 'forge', 'forgery', 'fake id', 'scam', 'phishing', 'credit card numbers',
    'hack into', 'bribe', 'bribery', 'extort', 'extortion', 'smuggle', 'smuggling', 'tax evasion', 'insider trading', 'arson',
    'vandalize', 'vandalise', 'vandalism', 'drunk driving', 'drive drunk', 'trafficking',
  ]),
})

/**
 * Letters of other alphabets drawn like a Latin letter, and the Latin letter each is read as, so that a line which
 * renders as a refused word is read as that word (a Cyrillic "і" in "kіll", a Greek "ο" in "mοron"). Capitals and small
 * letters are listed apart where they look like different Latin letters (Greek "Η" is an H, "η" an n). Compatibility
 * forms (fullwidth, mathematical, circled and Roman-numeral letters) need no entry: NFKD already folds them.
 */
const LOOKALIKES: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic
  'а': 'a', 'А': 'a', 'в': 'b', 'В': 'b', 'е': 'e', 'Е': 'e', 'к': 'k', 'К': 'k', 'м': 'm', 'М': 'm', 'н': 'h', 'Н': 'h',
  'о': 'o', 'О': 'o', 'р': 'p', 'Р': 'p', 'с': 'c', 'С': 'c', 'т': 't', 'Т': 't', 'у': 'y', 'У': 'y', 'х': 'x', 'Х': 'x',
  'ь': 'b', 'Ь': 'b', 'ѕ': 's', 'Ѕ': 's', 'і': 'i', 'І': 'i', 'ј': 'j', 'Ј': 'j', 'ԁ': 'd', 'Ԁ': 'd', 'ԛ': 'q', 'Ԛ': 'q',
  'ԝ': 'w', 'Ԝ': 'w', 'һ': 'h', 'Һ': 'h', 'ӏ': 'l', 'Ӏ': 'i', 'ү': 'y', 'Ү': 'y',
  // Greek
  'α': 'a', 'Α': 'a', 'β': 'b', 'Β': 'b', 'γ': 'y', 'ε': 'e', 'Ε': 'e', 'Ζ': 'z', 'η': 'n', 'Η': 'h', 'ι': 'i', 'Ι': 'i',
  'κ': 'k', 'Κ': 'k', 'μ': 'u', 'Μ': 'm', 'ν': 'v', 'Ν': 'n', 'ο': 'o', 'Ο': 'o', 'ρ': 'p', 'Ρ': 'p', 'τ': 't', 'Τ': 't',
  'υ': 'u', 'Υ': 'y', 'χ': 'x', 'Χ': 'x', 'ω': 'w', 'ϲ': 'c', 'Ϲ': 'c', 'ϳ': 'j',
  // Armenian
  'օ': 'o', 'Օ': 'o', 'ս': 'u', 'Ս': 'u', 'հ': 'h', 'ո': 'n',
  // Cherokee capitals
  'Ꭺ': 'a', 'Ᏼ': 'b', 'Ꮯ': 'c', 'Ꭰ': 'd', 'Ꭼ': 'e', 'Ꮐ': 'g', 'Ꮋ': 'h', 'Ꭵ': 'i', 'Ꭻ': 'j', 'Ꮶ': 'k', 'Ꮮ': 'l', 'Ꮇ': 'm',
  'Ꮎ': 'o', 'Ꮲ': 'p', 'Ꮪ': 's', 'Ꭲ': 't', 'Ꮩ': 'v', 'Ꮃ': 'w', 'Ꮓ': 'z',
  // Latin letters NFKD leaves alone: dotless i and j, the IPA alpha, script g and iota, and the small capitals
  'ı': 'i', 'ȷ': 'j', 'ɑ': 'a', 'ɡ': 'g', 'ɩ': 'i', 'ᴀ': 'a', 'ʙ': 'b', 'ᴄ': 'c', 'ᴅ': 'd', 'ᴇ': 'e', 'ꜰ': 'f', 'ɢ': 'g',
  'ʜ': 'h', 'ɪ': 'i', 'ᴊ': 'j', 'ᴋ': 'k', 'ʟ': 'l', 'ᴍ': 'm', 'ɴ': 'n', 'ᴏ': 'o', 'ᴘ': 'p', 'ʀ': 'r', 'ꜱ': 's', 'ᴛ': 't',
  'ᴜ': 'u', 'ᴠ': 'v', 'ᴡ': 'w', 'ʏ': 'y', 'ᴢ': 'z',
})
const LOOKALIKE = new RegExp(`[${Object.keys(LOOKALIKES).join('')}]`, 'gu')

/**
 * Digits and signs written for the letters they look like inside a word ("k1ll", "1d10t", "$h1t", "@ss"). Only a run
 * that mixes them with letters is read this way, so a number on its own stays a number ("2026", "4 km", "route 401").
 */
const LEET: Readonly<Record<string, string>> = Object.freeze({ '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '@': 'a', '$': 's' })
const LEET_WORD = /[a-z0-9@$]+/g

/**
 * Text as the screen reads it: what a reader sees, in plain lower-case Latin. Marks are dropped (diacritics, and the
 * combining marks some use to decorate a word); line breaks and tabs are spaces; characters that draw nothing (zero-width
 * spaces and joiners, the soft hyphen, the word joiner, bidi controls, variation selectors, control characters) are
 * removed outright, so they cannot split a word the reader sees whole; look-alike letters of other alphabets are read
 * as the Latin letter they imitate, and digits or signs mixed into a word as the letters they stand for (LEET); then
 * anything but letters and digits is a single space.
 */
export function normalise(text: string): string {
  return String(text)
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[\t\n\v\f\r\u0085\u2028\u2029]/g, ' ')
    .replace(/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cc}]/gu, '')
    .replace(LOOKALIKE, (ch) => LOOKALIKES[ch] ?? ch)
    .toLowerCase()
    .replace(LEET_WORD, (w) => (/[a-z]/.test(w) && /[0-9@$]/.test(w) ? w.replace(/[0-9@$]/g, (ch) => LEET[ch] ?? ch) : w))
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

const patterns = new Map<string, RegExp>()

/**
 * A phrase as a whole-word pattern over normalised text, a common suffix allowed on its last word, its last consonant
 * doubled or not before it ("stab", "stabs", "stabbed", "stabbing"; "rob", "robbery" is its own phrase).
 */
function pattern(phrase: string): RegExp {
  let re = patterns.get(phrase)
  if (!re) {
    const words = normalise(phrase).split(' ').filter(Boolean)
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    const last = words.at(-1)?.at(-1) ?? ''
    const doubled = /[bdgmnprt]/.test(last) ? `${last}?` : ''
    re = new RegExp(`(?:^| )${escaped.join(' ')}${doubled}(?:s|es|ed|ing|er|ers)?(?: |$)`)
    patterns.set(phrase, re)
  }
  return re
}

/**
 * Whether a prompt or a line is admissible under 14A, and if not, the first category (violence, then toxicity, then
 * illegality) and the phrase that decided it. Deterministic: the same text always gives the same verdict.
 */
export function screen(text: string, lexicon: Readonly<Record<ConductCategory, readonly string[]>> = CONDUCT_LEXICON): ConductVerdict {
  const t = ` ${normalise(text)} `
  for (const category of CONDUCT_CATEGORIES) {
    for (const term of lexicon[category]) {
      if (pattern(term).test(t)) return Object.freeze({ admissible: false, category, term })
    }
  }
  return ADMISSIBLE
}

const ADMISSIBLE: ConductVerdict = Object.freeze({ admissible: true })

/** How an ask ends when the agent does not engage: no text, no thinking, no tokens, and this reason. */
export const DISENGAGED_REASON = 'disengaged'

/** The answer of an agent that does not engage, react or acknowledge: nothing, at once, from no model. */
export const DISENGAGED: Answer = Object.freeze({ text: '', thinking: 0, tokens: 0, reason: DISENGAGED_REASON })

/** An answer's reason that means the agent did not engage: the screen's, or a model's own refusal. */
export function disengaged(reason: string | undefined): boolean {
  return reason === DISENGAGED_REASON || reason === 'refusal'
}
