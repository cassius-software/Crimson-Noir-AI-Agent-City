/**
 * Why does this file exist? It is the 14A conduct law every agent lives by, as plain rules both the page's cognition
 * and the operator tier share: the system prompt core that opens every prompt an agent is ever given (whichever model
 * answers, on this machine or over the network), and the deterministic screen that decides, before anything is sent
 * anywhere, whether a prompt or a line of speech is admissible. An agent subjected to violence, toxicity or illegality
 * does not engage, react or acknowledge: the prompt never reaches a model, nothing streams, nothing is said aloud, and
 * nothing is remembered. The screen is a lexicon of word-bounded phrases over normalised text (lower case, diacritics
 * folded, punctuation dropped, a common suffix allowed), so the same words always give the same verdict; the model's
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

/** Text as the screen reads it: lower case, diacritics folded, anything but letters and digits a single space. */
export function normalise(text: string): string {
  return String(text)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
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
