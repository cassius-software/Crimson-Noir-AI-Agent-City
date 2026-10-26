// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Concierge's 5-Whys intent engine. A plain-language goal ("make it
 * night", "it feels laggy", "take me to the harbour") is classified against a keyword taxonomy of the
 * city's operator controls, refined by up to five "why" questions with quick replies, and turned into a
 * brief: the root intent, a plan of steps (those the host can apply now, and those that need the
 * operator's console or a restart) and a copyable architecture brief naming the modules an engineer would
 * touch. It is deterministic and offline — no language model, no I/O, no clock, no randomness — so the
 * same goal and answers always give the same brief. It never writes code and never shows terminal syntax;
 * module paths appear only in the copyable brief.
 * What breaks if it is removed? Sloane can only greet and list controls: a goal typed into the Concierge
 * has nowhere to go.
 */
import { formatClock } from '../01_Initialize_World/solar.ts'
import { LITE_TIER, PEAK_TIER, TIERS, knobsOf } from '../05_Observe_Environment/governor.ts'

export type Control = 'time' | 'quality' | 'audio' | 'crowd' | 'cars' | 'district' | 'walk' | 'drive' | 'console' | 'controls'

export interface PlanStep {
  control: Control
  /** Human sentence, no syntax: "Set the clock to 21:00". */
  label: string
  /** time: hours 0–24 · quality: tier index or 'auto' · audio: 'on' | 'off' | percent 0–100 ·
   *  crowd and cars: 'more' | 'fewer' | 'none' · district: its name · walk: 'run' | 'explore' or none. */
  value?: number | string
  /** true = the Concierge can apply it now through the host (time, quality, audio); false = needs a restart or the operator. */
  immediate: boolean
  /** quality only: the value is a ceiling, not a target. A fix for heat or a slow frame never raises the tier, so the
   *  host pins the lower of this value and the live tier (an entry-level phone on Lite stays on Lite). */
  ceiling?: true
  /** The modules an engineer would touch to go further (the "architecture" part), e.g. ['01_Initialize_World/solar.ts']. */
  modules: string[]
}
/** One why-question; the options are quick replies, free text is always allowed. */
export interface WhyStep { depth: number; question: string; options: string[] }
export interface Brief { goal: string; whys: { question: string; answer: string }[]; root: string; plan: PlanStep[]; unmapped: string[]; markdown: string }
export interface Classification { control: Control; value?: number | string; confidence: number }

/** Whys asked at most, per goal. */
export const MAX_WHYS = 5
/** Characters kept from a goal or an answer. */
export const GOAL_MAX = 160

type Value = number | string
/** Notes a rule or an answer leaves on the frame: they pick the why-questions and word the root intent. */
type Tag =
  | 'quiet' | 'noisy' | 'performance' | 'battery' | 'fidelity' | 'music' | 'operator' | 'maybe-operator' | 'fast'
  | 'look' | 'light' | 'crowd-root' | 'busier' | 'hitch' | 'steady' | 'smooth' | 'detail-too' | 'detail'
  | 'sound-root' | 'feel' | 'perf-root' | 'crossing' | 'look-roads' | 'on-foot' | 'by-car' | 'anywhere' | 'no-peak' | 'peak-ask'

interface Hyp {
  control: Control
  value?: Value
  confidence: number
  /** Where the goal mentioned it (plan order among equals). */
  at: number
  /** Added by a why-answer as a means to the goal, not by the goal itself: no why-question of its own. */
  derived: boolean
}
interface Unmapped { label: string; modules: readonly string[] }
/** Why a goal has no hypotheses: it asked for harm, it was "I don't know", or nothing in the taxonomy fits. */
type Flag = 'none' | 'harm' | 'unsure' | 'unmapped'
interface Frame {
  readonly goal: string
  readonly hyps: Hyp[]
  readonly tags: Set<Tag>
  readonly unmapped: Unmapped[]
  readonly asked: Set<string>
  readonly flag: Flag
}

// ---------------------------------------------------------------------------------------------------
// Text

/** Lower-case ASCII words one space apart; apostrophes, colons and percent signs survive for times and volumes. */
function normalize(text: string): string {
  return text.slice(0, 1024).normalize('NFKC').toLowerCase().replace(/[’‘`´ʼ′]/g, "'").replace(/[^a-z0-9:'%]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** A goal or answer as kept: one line, no control characters, at most GOAL_MAX characters (a cut never
 *  leaves half a surrogate pair behind). */
function clean(text: string): string {
  if (typeof text !== 'string') return ''
  return text.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, GOAL_MAX).replace(/[\uD800-\uDBFF]$/, '').trim()
}

/** Hours from a clock reading: "21:30" and "17h" as written, "9 pm" by its suffix, "6 o'clock" as the evening. */
function clockHours(h: number, m: number, suffix: string | undefined): number | undefined {
  if (h > 23 || m > 59) return undefined
  const s = suffix?.replace(/\s/g, '')
  if (s === 'am') return (h % 12) + m / 60
  if (s === 'pm') return (h % 12) + 12 + m / 60
  if (s && h <= 6) return h + 12 + m / 60
  return h + m / 60
}

/** Named times of day; a plan says "22:00 (night)" and the root intent says "at night"; a city action's clock takes them by name (actions.ts). */
export const TIMES = [
  [0, 'midnight'], [6.25, 'dawn'], [8, 'morning'], [12, 'noon'], [15, 'afternoon'], [17.4, 'golden hour'],
  [18, 'sunset'], [18.5, 'dusk'], [20, 'evening'], [22, 'night'],
] as const satisfies readonly (readonly [number, string])[]

export function timeName(hours: number): string | undefined {
  return TIMES.find(([h]) => h === hours)?.[1]
}

const DISTRICTS = {
  Lakefront: 'on the south side',
  'Market Quarter': 'on the east side',
  'Civic Centre': 'on the west side',
  Midtown: 'on the north side',
  'Financial District': 'in the middle of the city',
} as const
type District = keyof typeof DISTRICTS
/** A district in a sentence: "the Lakefront", but "Midtown". */
const place = (d: Value | undefined) => (d === 'Midtown' ? 'Midtown' : `the ${String(d)}`)

// ---------------------------------------------------------------------------------------------------
// Taxonomy

interface Emit { control: Control; value?: Value | ((m: RegExpExecArray) => Value | undefined); confidence: number; tag?: Tag }
interface Rule { re: RegExp; emit: readonly Emit[] }
const one = (re: RegExp, control: Control, value: Emit['value'], confidence: number, tag?: Tag): Rule => ({ re, emit: [{ control, value, confidence, tag }] })

/** People a car could be asked to drive at. Only the phrasing a civic sim might hear; a match sets the goal
 *  aside (the First Law is not a control). "Running into people" is left alone: it is how a crowd feels. */
const PERSON = "(?:a |the |some |those |that |any |every |all the |all )?(?:person|people|someone|somebody|anyone|anybody|everyone|everybody|pedestrians?|walkers?|crowds?|guys?|man|men|woman|women|kids?|child|children|folks|citizens?|residents?|them|him|her)"
const HARM = new RegExp(`\\b(?:(?:hurt|harm)(?:ing)? ${PERSON}|run(?:ning)? ${PERSON} over|(?:run|drive|plough|plow|mow)(?:ning|ing)? (?:over|down) ${PERSON}|(?:crash|smash|ram|slam|drive|plough|plow)(?:m?ing)? (?:into|through) ${PERSON}|hit(?:ting)? ${PERSON})\\b`)

const UNSURE = /\b(?:(?:i )?(?:don'?t|dont|do not) (?:know|mind|care)|dunno|not sure|no idea|unsure|just (?:browsing|curious|here|visiting|checking)|just looking(?! around)|nothing(?: really| much| in particular)?|whatever|anything|surprise me|you (?:choose|pick|decide)|no goal|idk|not much|i'?m (?:fine|good|ok|okay)|all good|no thanks?|nope|hmm+|not really)\b|^no$/

/** Peak by name (the Peak rule's words). */
const PEAK_NAMED = /\bpeak (?:quality|graphics|settings|detail|fidelity)\b|\b(?:above|beyond|(?<!\b(?:my|the|your|our|those|these) )past) ultra\b/
const PEAK_NAMED_ALL = new RegExp(PEAK_NAMED.source, 'g')
/** Whether one stretch of a goal names Peak: "sun at its peak, graphics on ultra" and "not peak. graphics on ultra" do
 *  not, though normalize runs their words together. */
const peakNamed = (input: string): boolean =>
  input.slice(0, 1024).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}\s'’‘`´ʼ′_-]+/u).some((c) => PEAK_NAMED.test(normalize(c)))
/** Ways of asking for Peak in a typed answer to Sloane's Peak question: phrases, not single words, so "give up" or "take
 *  out" never choose it. */
const PEAK_ASKS = [
  "i(?:'d| would)?(?: really)? (?:want|like|love|need)(?: it)?(?: to (?:have|use|try|see|get))?", 'i wanna', "we(?:'d| would)? (?:want|like|love|need)",
  'give me', 'let me (?:have|use|try|see)', "let'?s (?:have|use|try|see|go(?: with| for)?)",
  '(?:turn|switch)(?: it)? on', 'switch(?: it)? to', 'go (?:to|for|with)',
  'set(?: it| the quality| quality| the graphics| graphics| my graphics)?(?: to| at)?', 'put (?:it|the quality|the graphics) (?:on|at|to)', 'use', 'try',
  'enable', 'show me', '(?:bump|crank|push|take) (?:it )?(?:up )?to', 'upgrade(?: it)? to', 'change(?: it)? to', 'keep(?: it)?(?: on| at)?', 'stay (?:on|at)',
  'stick (?:with|to)', 'i prefer', 'go all out with', 'max(?: it)? out(?: to| with)?', 'make it', "(?:i )?(?:don'?t|do not) mind",
]
/** Everything a typed choice of Peak may hold beside the word ("set peak please", "yes, go with peak graphics"): ways of
 *  asking, and words that only join. */
const PEAK_PLAIN = new RegExp(`\\b(?:${[...PEAK_ASKS,
  'please', 'pls', 'plz', 'now', 'ok', 'okay', 'yes', 'yeah', 'yep', 'yup', 'sure', 'thanks', 'thank you',
  'just', 'then', 'also', 'too', 'as well', 'and', 'with', 'plus', 'only', 'mode', 'the', 'a', 'my', 'on', 'at', 'in',
  'for', 'to', 'level', 'tier', 'preset', 'quality', 'graphics', 'settings', 'detail', 'fidelity',
].join('|')})\\b`, 'g')
/** Peak passed over for something else ("i prefer the light to peak graphics", "golden hour instead of peak graphics"):
 *  a turn-down. */
const PEAK_PASSED = new RegExp(`\\b(?:(?:prefer\\w*|rather|sooner)\\b.*?\\b(?:to|too|than|then|over)|over|instead of|rather than|better than)\\s+(?:(?:the|my|a|just|only|even|all|that) )*(?:${PEAK_NAMED.source}|peak\\b)`)
/**
 * Words beside a named Peak that turn it down or count its cost: a negation ("i don't want peak graphics"), a turn-down or
 * a move away ("turn off peak graphics", "give up on peak graphics", "switch from peak graphics"), or a complaint ("peak
 * graphics is too heavy", "my card has 4gb"). In a goal they count only outside the other things it asks for, so "peak
 * graphics and no traffic" is a mention Sloane asks about, not a turn-down.
 */
const PEAK_DOUBT = /\b(?:no|not|never|none|nothing|nor|neither|nobody|no ?one|without|rather|no longer|nah|nope|n't|(?:don|doesn|didn|won|can|isn|aren|wasn|weren|wouldn|shouldn|couldn|haven|hasn|hadn|ain|needn)'?t|cannot|avoid|skip|stop|disable|off|down|lower|reduce|drop|cut|remove|downgrade|less|undo|revert|rid|quit|exit|end|pause|enough|ditch|instead|forget|scrap|nix|overkill|never ?mind|chang\w* my mind|from(?! now)|give (?:\w+ )?up|(?<!\b(?:all|max|maxed|it|everything|things|them) )out with|(?:take|switch|get|put|turn) (?:\w+ )?(?:out|back(?! (?:to|on|up)\b)|away)|hate|ugly|worse|bad|lag\w*|slow\w*|stutter\w*|chopp\w*|jerk\w*|jank\w*|freez\w*|hang\w*|hitch\w*|crash\w*|struggl\w*|heavy|hurt\w*|kill\w*|hot|heat\w*|warm|overheat\w*|fans?|loud|noisy|battery|batteries|memory|vram|weak|old|cheap|\d+ ?(?:gb|mb))\b|\btoo\s+(?!(?:and|please|now|then|thanks|thank|as|also|ok|okay|i|we)\b)\w+/
/** A turn-down with a pronoun ("peak graphics, turn it down"): Peak too, though the sound's rule reads it as well. */
const PEAK_OFF = /\b(?:turn|switch|shut|put) (?:it|that|this|them) (?:down|off|out)\b/
/** Nobody using Peak ("nobody would use peak graphics"), though the crowd's rule reads "nobody" ("peak graphics and
 *  nobody on the streets" is a mention). */
const PEAK_NOBODY = /\b(?:nobody|no ?one|no people) (?:would |will |could |really )?(?:use|want|need|like|care|run|play)s?\b/
/** Peak struck through with a sign ("!peak graphics", "-peak graphics", "~~beyond ultra~~", "night,—peak graphics"). */
const PEAK_STRUCK = /(?:^|[^\p{L}\p{N}])(?:!=|=\/=|\/=|<>|[!~¬‐‑‒–—―-])[\s"'“”‘’«»‹›([{<*_`]*(?:peak|above|beyond|past)\b/u
/** Peak turned down by a word the doubt list leaves out because it reads otherwise elsewhere in a goal: next to Peak
 *  ("cancel peak graphics", "lose the peak", "pass on peak") or said of it ("peak was a mistake"). Read on asPeak. */
const PEAK_CANCEL = /\b(?:cancel\w*|unset|lose|losing|decline|deactivate|uncheck|untick|delete|abort|dump|decreas\w*|lessen|minimi[sz]e|lighten|(?:scale|dial|roll|step) back(?: on| from)?|pass on|second thoughts? (?:on|about)) (?:the |my |that |this )?peak\b(?! (?:hours?|times?|traffic|season|rush|of|period|demand)\b)|\bpeak(?: \w+)?(?: is| was| seems| feels| sounds|'s) (?:\w+ )?(?:unnecessary|excessive|a waste|wasteful|pointless|a mistake|a misclick|wrong)\b/
/** Asking to keep Peak is no turn-down ("don't turn off peak graphics", "leave it on peak graphics"): Sloane asks. */
const PEAK_KEEP = /\b(?:don'?t|do not|never|no need to) (?:turn (?:it |that )?(?:off|down)|switch (?:it )?off|change|touch|lower|reduce|drop|disable|remove|stop|hold back|go below|forget)\b|\b(?:don'?t|do not|never) (?:cancel|lose|unset|deactivate|delete) (?:the |my )?(?:peak|above|beyond|past)\b|\bleave (?:it |them |the (?:quality|graphics|settings) )?(?:on|at|as)\b|\bleave peak (?:quality|graphics|settings|detail|fidelity) on\b/
/** "I don't mind" is a yes, and so are "nothing less than", "no compromises" and "can't wait". */
const YES_ALL = /\b(?:(?:i )?(?:don'?t|do not) mind|nothing less than|no compromises?|(?:can'?t|cannot|couldn'?t) wait)\b/g
/** Another tier beside a named Peak ("from peak graphics to ultra", "set peak graphics to low"). */
const OTHER_TIER = /\b(?:ultra|high(?:er)?|medium|mid|low(?:er|est)?|minimal|lite|potato|auto(?:matic)?|adaptive)\b/
/** Ultra passed over for Peak ("peak, not ultra", "peak graphics instead of ultra", "i prefer peak to ultra"): a choice of
 *  Peak, not another tier beside it. */
const PEAK_OVER_ULTRA = new RegExp(`(?:(?<=\\bprefer\\w* )(?:${PEAK_NAMED.source}|\\bpeak\\b) (?:to|over|than|rather than|instead of)|(?:${PEAK_NAMED.source}|\\bpeak\\b) (?:not|not just|instead of|rather than|over|above)) (?:the |plain |just )?ultra\\b`, 'g')
/** The tier above Ultra by what it is, in answer to her question ("higher than ultra", "more than ultra"). */
const PEAK_ABOVE = /\b(?:higher|more|better|greater|bigger|sharper|prettier|nicer) than ultra\b/g
/** Peak's names read as "peak", so a rule can look beside it ("cancel peak graphics" is "cancel peak"). */
const asPeak = (s: string) => s.replace(PEAK_NAMED_ALL, ' peak ').replace(/\s+/g, ' ')
/** `s` with the stretches `re` (global) finds in `from` blanked; `from` lines up with `s` character for character. */
function blankAt(s: string, re: RegExp, from = s): string {
  let out = s
  for (const m of from.matchAll(re)) out = `${out.slice(0, m.index)}${' '.repeat(m[0].length)}${out.slice(m.index + m[0].length)}`
  return out
}
/** An answer to the Peak question may open by asking for it to be done ("can you set peak", "may i have peak"); any other
 *  question is no choice ("would you go with peak", "can i try peak"). Question marks outside ASCII are FOREIGN. */
const ASKING = /^(?:(?:please|pls|plz) )?(?:(?:can|could|would|will) (?:you|u)(?: please| pls| plz)? (?:turn|switch|set|put|give|enable|make|bump|crank|change|upgrade|max|bring)|(?:can|could|may) (?:i|we) (?:have|get))\b/
/** Letters, numbers and signs outside plain ASCII that normalize drops ("не peak", "peak 👎", "peak⸮"): Sloane cannot read
 *  them, so the answer is no choice of Peak. Typed quotes, apostrophes and dashes pass. */
const FOREIGN = /[^\p{ASCII}\p{Z}ʼ′‘’‚“”„«»‹›‐‑‒–—―…]/u
/** Sloane's own words for picking Peak in her question ("definitely peak", "yes, go peak", "set peak please"). */
const PEAK_CHOICE = /\b(?:peak|set|go|definitely|absolutely|of course|for sure|do it|that one|choose|pick|take|i'?ll take|sounds good|great|cool|perfect|alright|fine)\b/g
/** ASCII signs normalize drops that may say something else about Peak: a comparison ("night > peak"), a box ("[ ] peak"),
 *  or a face of signs ("peak -_-", "peak =(", "peak -.-"). Never a choice of Peak. */
const SIGNS = /[<>=|\\^_{}[\]()]|(?:^|\s)(?![.,!?'"]+(?:\s|$))[^\s\p{L}\p{N}]{2,}(?=\s|$)/u
/** The tiers by the words for them, as a choice ("medium please"). "Higher", "lower", "max" and "highest" name no tier of
 *  their own: with Peak set, the highest is Peak. */
const TIER_WORDS: ReadonlyMap<string, Value> = new Map<string, Value>([
  ['lite', LITE_TIER], ['potato', LITE_TIER], ['lowest', LITE_TIER], ['minimal', 0], ['low', 1], ['medium', 2], ['mid', 2], ['high', 3],
  ['ultra', 4], ['auto', 'auto'], ['automatic', 'auto'], ['adaptive', 'auto'],
])
/** What may stand beside a tier word in a choice: a no to Peak, ways of asking, and verdicts on the tier. */
const TIER_BESIDE = /\b(?:no thanks|not peak|no peak|no|nah|nope|thanks|thank you|please|pls|plz|ok|okay|yes|yeah|sure|just|only|instead|then|go|set|use|pick|take|try|keep|stay|stick|switch|put|make|turn|change|drop|lower|bring|it|to|on|at|with|for|the|quality|graphics|settings|mode|tier|level|preset|is fine|is enough|is good|would do|will do|works|would be (?:good|fine))\b/g
/**
 * A tier an answer names as a choice: a stretch of it (split at punctuation, "and" and "but") that holds one tier word and
 * nothing but TIER_BESIDE ("medium please", "no, auto", "the light, on high"), or "let it decide". "High noon", "low sun"
 * and "higher" name none.
 */
function tierOf(text: string): Value | undefined {
  for (const c of text.slice(0, 1024).normalize('NFKC').toLowerCase().split(/[^\p{L}\p{N}\s'’‘`´ʼ′_-]+|\b(?:and|but)\b/u)) {
    const n = normalize(c)
    if (/\b(?:let it decide|you decide|up to you|your call)\b/.test(n)) return 'auto'
    const w = n.replace(TIER_BESIDE, ' ').trim()
    const t = TIER_WORDS.get(w)
    if (t !== undefined) return t
  }
  return undefined
}
/** Bare "peak" once Peak is set ("no peak", "skip peak"), not the peak of something or peak hours. */
const PEAK_BARE = /(?<!\b(?:its|a|at the) )\bpeak\b(?! (?:hours?|times?|traffic|season|rush|of|period|demand)\b)/
/** The picture by name, as a turn-down names it ("the graphics", "detail"). */
const PICTURE = '(?:the )?(?:graphics|quality|settings?|detail|visuals|resolution|picture|tier|preset)'
/** "It", "that" or "this" for the picture: on its own, or before words that only say how much ("drop it a tier"). */
const IT = '(?:it|that|this)(?= *$| (?:down|back|a bit|a little|a tier|a notch|please|pls|now|then|thanks|again|some|way|right|for me|instead)\\b)'
/**
 * A turn-down of the picture with Peak set, where Peak is not named, after any question: in either order ("turn it down",
 * "turn down the graphics", "scale the detail back"), a lowering verb on it ("reduce the graphics", "lower it"), less of it
 * ("less detail", "use less memory") or too much of it ("too much", "overkill").
 */
const PEAK_DROP = new RegExp([
  `\\b(?:turn|tone|dial|bring|knock|take|scale|ease|roll|step) (?:it|that|this|${PICTURE})(?: \\w+)? down\\b`,
  `\\b(?:tone|dial|scale|ease|roll|pull) (?:it|that|this|${PICTURE})(?: \\w+)? back\\b`,
  `\\b(?:turn|tone|dial|bring|knock|take|scale|ease|roll|step) down (?:on )?${PICTURE}\\b`,
  `\\b(?:tone|dial|scale|ease|roll|pull) back (?:on )?${PICTURE}\\b`,
  `\\b(?:lower|reduce|decrease|drop|cut|lessen|minimi[sz]e|downgrade|lighten|downscale|degrade) ${PICTURE}\\b|\\blower (?:it|that|this)\\b`,
  '\\bless (?:detail|graphics|quality|resolution|memory|vram)\\b|\\b(?:save|free up) (?:some )?(?:memory|vram)\\b',
  '\\btoo (?:much|heavy|demanding)\\b|\\boverkill\\b',
].join('|'))
/**
 * A turn-down that names nothing, so it is the picture's only in answer to a question about the picture (another
 * question's "less" is less traffic): a lowering verb on "it" ("reduce it", "drop it a tier"), a tier down ("a notch
 * lower"), a lowering on its own ("lower please", "go lower", "the light, but lower", "step down") or too much of it
 * ("too high", "too detailed").
 */
const PEAK_LOWER = new RegExp([
  `\\b(?:reduce|decrease|drop|cut|lessen|minimi[sz]e|downgrade|lighten|downscale|degrade) ${IT}`,
  '\\b(?:drop|go|step|come|move) (?:down )?(?:a|one) (?:tier|notch)\\b|\\b(?:a|one) (?:tier|notch) (?:lower|down)\\b',
  '(?:^|\\b(?:but|and|so) )(?:(?:ok|okay|actually|hmm|wait|um|uh|then|please|pls|just|maybe|yes|yeah|no|nah) )*(?:(?:go|a bit|a little|bit|one|slightly|even|much) )?' +
    '(?:lower|less|downgrade|step down)(?: (?:please|pls|then|thanks|thank you|a bit|a little|than that|one))*$',
  "\\btoo (?:expensive|sharp|detailed)\\b|^(?:it'?s |that'?s |(?:it|that) is )?too high\\b|\\bless demanding\\b",
].join('|'))
/** Taking back the choice just made ("changed my mind", "misclicked"), right after Peak was set, in an answer that asks
 *  for nothing else. */
const PEAK_UNDO = /\b(?:chang\w* my mind|(?<!\bno )second thoughts?|mis ?click\w*|wrong (?:one|button|choice|chip)|clicked (?:the )?wrong|by mistake|didn'?t mean (?:to|that|it)|undo|revert|scratch that|take (?:it|that) back)\b/
/** The visitor's machine, as in a complaint about it ("my card only has 4gb", "my laptop can't take it"). */
const PEAK_MACHINE = /\b(?:my|the|this|our) (?:graphics card|card|gpu|laptop|pc|computer|machine|phone|device|mac|tablet)\b|\b\d+ ?(?:gb|mb)\b|\bvram\b/

/** Wishes the city cannot grant yet: named in the brief with the modules a change would touch. Matched
 *  first, so "speed up the day" never reads as "day". */
const UNSUPPORTED: readonly (Unmapped & { re: RegExp })[] = [
  { re: /\b(?:speed(?:ing)? up|slow(?:ing)? down|faster|slower|shorter|longer|freeze|stop|pause|hold) (?:the |a )?(?:time|clock|day|days|night|nights|sun)\b|\b(?:day|night) length\b|\btime (?:go|goes|pass|passes|passing|flies|fly|run|runs) (?:faster|slower|quicker|by)\b|\bdays? (?:are|is) too (?:short|long|fast|slow)\b|\b(?:freeze|pause|stop) time\b/,
    label: 'How fast the day passes: set when the city starts, not while it runs', modules: ['07_Execute_Actions/engine.ts', 'App.tsx'] },
  { re: /\b(?:rain(?:ing|y|s)?|snow(?:ing|y|s)?|fog(?:gy)?|mist(?:y)?|storm(?:y|s)?|clouds?|cloudy|overcast|wind(?:y)?|thunder|lightning|weather|seasons?|winter|summer|autumn|hail|puddles?)\b/,
    label: 'Weather: the city has one clear late-September day so far', modules: ['01_Initialize_World/solar.ts', '01_Initialize_World/world.ts', '07_Execute_Actions/postfx.ts'] },
  { re: /\b(?:dogs?|cats?|birds?|pigeons?|animals?|pets?|horses?|squirrels?|wildlife|deer)\b/,
    label: 'Animals: only people and cars live here so far', modules: ['03_Spawn_Agents/crowd.ts', '03_Spawn_Agents/crowdCompute.ts', '03_Spawn_Agents/crowd.wgsl'] },
  { re: /\b(?:friends?|multiplayer|online|other players?|co ?op|chat(?:ting)?|talk(?:ing)? (?:to|with)|conversation|dialogue|say hello|make friends)\b/,
    label: 'Company: the city is single-player; you can ask someone over by their skill (say "recruit" and a skill, or type recruit <skill> in the console), but nobody holds a conversation yet', modules: ['08_Swarm/recruitment.ts', '03_Spawn_Agents/skills.ts', '06_Make_Decisions/intent.ts'] },
  { re: /\b(?:fly(?:ing)?|flight|jet ?pack|wings|helicopters?|drones?|planes?|aircraft|hover|float up|climb (?:a |the )?(?:building|tower|roof)|roof ?tops?)\b/,
    label: 'Flying and rooftops: everyone here stays on the ground', modules: ['07_Execute_Actions/player.ts', '07_Execute_Actions/physics.ts'] },
  { re: /\b(?:go (?:inside|indoors)|indoors?|interiors?|inside (?:a |the )?(?:building|shop|house|tower)|enter (?:a |the )?(?:building|shop|house|tower)|apartments?|my (?:house|home|place)|houses?|homes?)\b/,
    label: 'Going indoors: only the six workplaces open onto the street, in the city and in the lakefront metropolis; every other building is a solid shell for now',
    modules: ['01_Initialize_World/interiors.ts', '01_Initialize_World/city.ts', '01_Initialize_World/world.ts'] },
  { re: /\b(?:missions?|quests?|objectives?|high ?scores?|level up|achievements?|rewards?|unlock(?:s|able)?|money|cash|coins?|buy(?:ing)?|purchase|jobs?|tasks?)\b/,
    label: 'Missions and scores: there are none; the city is a place, not a game to beat', modules: ['07_Execute_Actions/engine.ts', '06_Make_Decisions/intent.ts'] },
  { re: /\b(?:more (?:buildings|streets|blocks)|bigger city|larger city|expand the city|new (?:buildings|district)|build (?:a |something|houses)|construct)\b/,
    label: 'A bigger city: the street grid is fixed when the city starts', modules: ['01_Initialize_World/city.ts', '01_Initialize_World/world.ts'] },
  { re: /\b(?:vr|virtual reality|headset|webxr|xr)\b/,
    label: 'A headset: the head rig is ready for one, but there is no XR session yet', modules: ['07_Execute_Actions/player.ts', '07_Execute_Actions/engine.ts'] },
  { re: /\b(?:change|different|new|customi[sz]e|edit|pick|choose) (?:my |the )?(?:avatar|character|outfit|clothes|body|face|skin|hair)\b|\b(?:avatar|outfit|clothes|clothing|hair|skin colou?r)\b/,
    label: 'Your look: the wardrobe is a tap away (Look on Sloane\'s chip, or Change my look in the full list): presets, swatches and a code to share', modules: ['07_Execute_Actions/Customizer.tsx', '03_Spawn_Agents/look.ts', '05_Observe_Environment/lookStore.ts'] },
  { re: /\b(?:save (?:the |my )?(?:game|city|progress|state)|load (?:the |my )?(?:game|save)|checkpoint|photo mode|record(?:ing)? (?:a |the )?(?:video|clip)|screenshots?|share (?:this|it|the city))\b/,
    label: 'Saving, sharing and photo mode: not in the city yet (your name is the only thing remembered)', modules: ['05_Observe_Environment/profile.ts', 'App.tsx'] },
]

const PEAK_RULE = one(PEAK_NAMED, 'quality', PEAK_TIER, 0.9, 'fidelity')

/** Ordered: clock readings and specific phrases before the bare nouns; a match consumes its words, so
 *  "warm light" is golden hour before "warm" can mean a hot device. */
const RULES: readonly Rule[] = [
  // Time of day.
  one(/\b([01]?\d|2[0-3]):([0-5]\d) ?(am|pm|a m|p m)?\b/, 'time', (m) => clockHours(Number(m[1]), Number(m[2]), m[3]), 1),
  one(/\b(1[0-2]|0?\d) ?(am|pm|a m|p m|o'clock)\b/, 'time', (m) => clockHours(Number(m[1]), 0, m[2]), 1),
  one(/\b(1\d|2[0-3]|0?\d)h\b/, 'time', (m) => clockHours(Number(m[1]), 0, undefined), 1),
  one(/\btime of (?:the )?day\b/, 'time', undefined, 0.6),
  one(/\bmidnight\b/, 'time', 0, 1),
  // A complaint about the light asks for its opposite: "too dark" wants the day, "too bright" the evening.
  one(/\b(?:too (?:dark|dim|gloomy)|can'?t see(?: anything| a thing)?|more light|lights? on|light it up)\b/, 'time', 12, 0.9),
  one(/\b(?:too (?:bright|sunny|harsh)|too much (?:sun|light|glare)|glare|less light|dim (?:it|the light|the lights)|dimmer)\b/, 'time', 20, 0.9),
  one(/\b(?:golden hour|golden|magic hour|long shadows|warm light|low sun|late afternoon)\b/, 'time', 17.4, 1),
  one(/\b(?:night ?time|tonight|nights?|dark(?:er|ness)?|after dark|moon(?:light|lit)?|stars|starry)\b/, 'time', 22, 1),
  one(/\bevening\b/, 'time', 20, 1),
  one(/\b(?:dusk|twilight|blue hour)\b/, 'time', 18.5, 1),
  one(/\b(?:sun ?sets?|sun ?down|sun (?:goes|going) down)\b/, 'time', 18, 1),
  one(/\bafternoon\b/, 'time', 15, 1),
  one(/\b(?:noon|midday|mid day|lunch(?:time)?)\b/, 'time', 12, 1),
  one(/\b(?:day ?time|day ?light|bright(?:er)?|sunny|sunshine|light(?:er)? out|in the day|during the day|make it day|day)\b/, 'time', 12, 0.9),
  one(/\b(?:morning|breakfast)\b/, 'time', 8, 1),
  one(/\b(?:dawn|sun ?rise|daybreak|first light|early)\b/, 'time', 6.25, 1),
  // "Runs slow" and "run faster" are performance (the city runs); "walk faster" and "go faster" are a
  // walk; "speed up" is performance; "speed" is a drive.
  one(/\b(?:runs?|running|plays?|playing|performs?|performing|performance|frame ?rate|fps) (?:\w+ )?(?:faster|smoother|smoothly|better|slow|slowly|badly|poorly|bad)\b/, 'quality', undefined, 0.9, 'performance'),
  one(/\b(?:speed(?:ing)?(?: it)? up|speedier)\b/, 'quality', undefined, 0.9, 'performance'),
  one(/\b(?:drive faster|fast(?:er)? car|speed(?:ing)?|floor it|burn rubber)\b/, 'drive', undefined, 0.9, 'fast'),
  one(/\b(?:walk faster|move faster|go faster|hurry|sprint(?:ing)?|jog(?:ging)?|run(?:ning)?|dash)\b/, 'walk', 'run', 1),
  // Performance and fidelity.
  one(/\b(?:lag(?:gy|ging|s)?|slow(?:er|ly)?|sluggish|stutter(?:s|ing|y)?|jank(?:y)?|chopp(?:y|ing)|jerky|frame ?rate|fps|frames?|freez(?:es|ing|e)|hitch(?:es|ing)?|dropp?ing frames|not smooth|smooth(?:er|ly)?|snappier|unresponsive|responsive|performance|faster|quicker)\b/, 'quality', undefined, 0.9, 'performance'),
  one(/\b(?:battery|batteries|hot|heat(?:ing)?|warm|too warm|overheat(?:s|ing)?|fan|fans|thermals?|cool(?:er)? down|cooler)\b/, 'quality', 1, 0.9, 'battery'),
  // Peak, above Ultra (governor.ts PEAK_TIER), only when named: "best", "max" and "ultra" keep meaning Ultra, so a casual
  // ask never takes the half gigabyte Peak's shadows need. Before the Ultra rule, which would read "beyond ultra". As
  // sure as the heat and battery rule, so "hot on peak graphics" keeps that rule's Low (the first of equals). Never kept
  // as it stands: analyze turns it into Sloane's Peak question or Ultra at most.
  PEAK_RULE,
  one(/\b(?:ultra|max(?:imum|ed)?|highest|best|top|full) ?(?:quality|graphics|detail|settings|fidelity|res(?:olution)?)\b|\b(?:ultra|max(?:ed)? out|max fidelity)\b/, 'quality', 4, 0.9, 'fidelity'),
  one(/\b(?:prett(?:y|ier)|nicer|beautiful|gorgeous|stunning|sharp(?:er)?|crisp(?:er)?|detail(?:ed|s)?|fidelity|better (?:looking|graphics|visuals)|looks? better|graphics|visuals|shadows|god ?rays|light ?shafts|sun ?rays|volumetrics?|glow|hdr|eye candy|cinematic|photo ?real(?:istic)?)\b/, 'quality', 4, 0.85, 'fidelity'),
  // The lowest setting is Lite now (governor.ts LITE_TIER, below Minimal); asking for Minimal by name still means Minimal.
  one(/\b(?:lowest (?:quality|settings|graphics)|potato)\b/, 'quality', LITE_TIER, 1),
  one(/\bminimal\b/, 'quality', 0, 1),
  one(/\b(?:low|lower|reduce|drop|turn down)(?: the)? (?:quality|graphics|settings|detail|resolution)\b/, 'quality', 1, 1),
  one(/\bmedium (?:quality|graphics|settings)\b/, 'quality', 2, 1),
  one(/\bhigh (?:quality|graphics|settings)\b/, 'quality', 3, 1),
  one(/\b(?:auto(?:matic)? quality|quality auto|let it decide|adaptive)\b/, 'quality', 'auto', 1),
  one(/\b(?:quality|settings|resolution|render(?:ing)?)\b/, 'quality', undefined, 0.6),
  // Sound.
  one(/\b(?:mute(?:d)?|silen(?:t|ce)|no (?:sound|audio|noise|music)|(?:sound|audio|noise|volume|music) off|turn (?:off|down)(?: the)? (?:sound|audio|volume|noise|music)|(?:turn|switch|shut) (?:the )?(?:sound|audio|noise|music) off|without (?:sound|music|audio)|stop the (?:sound|music|noise))\b/, 'audio', 'off', 1),
  one(/\b(?:unmute|(?:sound|audio|volume) (?:on|up|back)|turn (?:on|up)(?: the)? (?:sound|audio|volume)|(?:can'?t|cannot|don'?t) hear|hear (?:it|the city|something|anything)|with sound|sound please)\b/, 'audio', 'on', 1),
  one(/\b(?:too loud|softer|quieter sound|turn it down|volume down|less volume|lower the volume|not so loud|bit loud)\b/, 'audio', 30, 1),
  one(/\b(?:loud(?:er)?|turn it up|volume up|more volume|max(?:imum)? volume)\b/, 'audio', 100, 1),
  one(/\b(?:volume|sound level)(?: to| at)? (\d{1,3}) ?%?\b/, 'audio', (m) => Math.min(100, Number(m[1])), 1),
  one(/\b(\d{1,3}) ?% (?:volume|sound)\b/, 'audio', (m) => Math.min(100, Number(m[1])), 1),
  one(/\b(?:music|songs?|soundtrack|radio|playlist|tunes?)\b/, 'audio', undefined, 0.7, 'music'),
  // "Quieter roads" is traffic, before "quieter" can be read as people or sound.
  one(/\b(?:quieter|calmer|quiet(?:en)?|calm|tame) (?:down )?(?:the |all the )?(?:roads?|traffic)\b/, 'cars', 'fewer', 1),
  // Both people and sound ("quiet"), both sound and traffic ("noisy"): a why-question settles it.
  { re: /\b(?:quiet(?:er)?|calm(?:er)?|peaceful|peace|tranquil|relax(?:ing|ed)?|chill(?:ed)?|serene|mellow|less noise)\b/, emit: [
    { control: 'crowd', value: 'fewer', confidence: 0.5, tag: 'quiet' }, { control: 'audio', value: 30, confidence: 0.5, tag: 'quiet' },
  ] },
  { re: /\b(?:noisy|noise|noises|racket|din)\b/, emit: [
    { control: 'audio', value: 30, confidence: 0.5, tag: 'noisy' }, { control: 'cars', value: 'fewer', confidence: 0.5, tag: 'noisy' },
  ] },
  one(/\b(?:sound|sounds|audio|hear|listen|ambien(?:ce|t))\b/, 'audio', undefined, 0.6),
  // Traffic (before people: "busy roads" is cars, "busy" is people).
  one(/\b(?:no (?:traffic|cars|vehicles)|empty roads|clear(?: the)? roads|car ?free|without (?:cars|traffic)|(?:remove|stop|halt) (?:the |all |all the )?(?:cars|traffic|vehicles)|get rid of (?:the )?(?:cars|traffic|vehicles)|no more cars|zero traffic|(?:take|get) (?:the |all the )?cars (?:off|away))\b/, 'cars', 'none', 1),
  one(/\b(?:less traffic|fewer (?:cars|vehicles)|less cars|not so many cars|too (?:much|many) (?:traffic|cars|vehicles)|traffic is (?:heavy|bad|terrible)|gridlock(?:ed)?|traffic jams?|jammed|congest(?:ed|ion)|lighter traffic)\b/, 'cars', 'fewer', 1),
  one(/\b(?:more (?:traffic|cars|vehicles)|busy roads|busier roads|heavy traffic|rush hour|lots of cars|more (?:driving|drivers)|full roads|busy traffic)\b/, 'cars', 'more', 1),
  one(/\b(?:traffic|cars|vehicles|roads|drivers)\b/, 'cars', undefined, 0.6),
  // People.
  one(/\b(?:too (?:busy|crowded|packed|many people)|less (?:busy|crowded|people)|fewer (?:people|pedestrians|folks|crowds)|not so (?:busy|crowded|many people)|thin(?:ner)? (?:the )?crowd|smaller crowd)\b/, 'crowd', 'fewer', 1),
  one(/\b(?:empty|emptier|deserted|abandoned|ghost town|nobody|no ?one|no (?:people|pedestrians|crowds?)|on my own|to myself|alone|clear the streets)\b/, 'crowd', 'none', 1),
  one(/\b(?:more (?:people|pedestrians|folks|crowds?)|busier|busy|crowded|crowds?|packed|bustling|lively|livelier|vibrant|alive|full of (?:people|life)|lots of people|more life|populated)\b/, 'crowd', 'more', 1),
  one(/\b(?:people|pedestrians|folks|population|citizens|residents|walkers)\b/, 'crowd', undefined, 0.6),
  // Districts.
  one(/\b(?:harbou?r(?:front)?|water ?front|the water|sea(?:side|front)?|docks?|piers?|shore(?:line)?|beach|lake(?:side|front)?|marina|boats?|ships?)\b/, 'district', 'Lakefront', 1),
  one(/\b(?:markets?(?: quarter)?|shops?|shopping|stalls?|bazaar|vendors?|stores?)\b/, 'district', 'Market Quarter', 1),
  one(/\b(?:civic(?: cent(?:re|er))?|city hall|town hall|court ?house|library|the square|town square)\b/, 'district', 'Civic Centre', 1),
  one(/\b(?:mid ?town|up ?town|north side|the north)\b/, 'district', 'Midtown', 1),
  one(/\b(?:financial(?: district)?|down ?town|cbd|city cent(?:re|er)|cent(?:re|er) of (?:town|the city)|the cent(?:re|er)|towers?|sky ?scrapers?|high ?rises?|business district|banks?|offices?)\b/, 'district', 'Financial District', 1),
  one(/\b(?:somewhere (?:new|else|different|nice|interesting)|the sights|sight ?seeing|landmarks?|neighbou?rhoods?|districts?|parts? of (?:town|the city)|around town)\b/, 'district', undefined, 0.6),
  // On foot and by car.
  one(/\b(?:explore|exploring|wander(?:ing)?|roam(?:ing)?|look(?:ing)? around|walk around|show me around|take me around|tour|have a look|see what(?:'s| is) (?:here|there|around)|stroll|amble|meander|poke around|check (?:it|things) out)\b/, 'walk', 'explore', 1),
  one(/\b(?:walk(?:ing)?|on foot|by foot|stretch my legs|get out(?: of the car)?|leave the car|exit the car|step out|hop out)\b/, 'walk', undefined, 1),
  one(/\b(?:drive|driving|drove|take a car|get (?:a|in a|into a|in the) car|grab a car|find a car|hop in a car|jump in a car|behind the wheel|go for a (?:drive|spin|ride)|ride|cruise|cruising|road trip|motor(?:ing)?|a car|the car|car|steering wheel)\b/, 'drive', undefined, 1),
  // The operator's console, and learning the controls.
  one(/\b(?:console|terminal|command ?line|cli|shell|ring ?0|ring zero|operator(?:'?s)?|script(?:s|ing)?|api|automat(?:e|ion)|commands?|root access|sudo)\b/, 'console', undefined, 0.95, 'operator'),
  one(/\b(?:developer|dev|engineer(?:ing)?|under the hood|hack(?:ing)?|tinker(?:ing)?|tweak(?:ing)?|physics|shaders?|uniforms?|code|coding|program(?:ming)?|debug(?:ging)?|inspect|internals|advanced|expert|power user)\b/, 'console', undefined, 0.7, 'maybe-operator'),
  one(/\b(?:how (?:do|can|could|would|should) (?:i|you|we)|how to|how does|what (?:do|should|can) i (?:press|do|use)|which (?:key|button)|what (?:key|button)|controls?|keys|buttons|help(?: me)?|tutorial|guide|instructions|teach me|show me how|learn|lost|confused|stuck|what is this|what'?s this|where am i|beginner|new here|first time|get(?:ting)? started)\b/, 'controls', undefined, 0.9),
]

interface Analysis { hyps: Hyp[]; tags: Set<Tag>; unmapped: Unmapped[]; flag: Flag }
/** The taxonomy's reading. `kept` is the goal with only the Peak name and the other controls' settled asks (with the words
 *  that only turn them) blanked out, where a goal's turn-down of Peak is looked for; `unsure` is the "I don't know" said. */
interface Reading { hyps: Hyp[]; tags: Set<Tag>; unmapped: Unmapped[]; harm: boolean; unsure: string | null; kept: string }

/** Keeps the stronger reading of a control; among equals the first. A value is never lost to a reading
 *  without one ("noisy roads" stays fewer cars). */
function mergeHyp(hyps: Hyp[], h: Hyp): void {
  const i = hyps.findIndex((x) => x.control === h.control)
  if (i < 0) { hyps.push(h); return }
  const old = hyps[i]
  if (h.confidence > old.confidence) hyps[i] = h.value === undefined && old.value !== undefined ? { ...h, value: old.value } : h
  else if (old.value === undefined && h.value !== undefined) hyps[i] = { ...old, value: h.value }
}

/** Words before or after another control's ask that only turn it ("without any traffic", "not too many people", "turn the
 *  music down"): they go with that ask, so they say nothing about Peak. A word after it goes only with words before it,
 *  since "calm down the peak graphics" turns Peak down. "No" is left out: the rules take it in themselves, and in "peak
 *  graphics? no, at night" it answers Peak. */
const TURN_BEFORE = /\b(?:without|not|never|less|fewer|turn|switch|put|shut|get rid of)(?: (?:any|the|my|too|so|as|that|much|many|of|all|at|in|on|during))* $/
const TURN_AFTER = /^ (?:down|off|out|up|away)\b/
/** The same turn-down going on to Peak ("without any traffic or peak graphics", "turn the music down and peak graphics
 *  too"): it stays a turn-down of Peak. */
const TURN_SHARED = /^(?: (?:down|off|out|up|away))? (?:(?:or|nor)(?: (?:even|also|any|the|my))* (?:peak|above ultra|beyond ultra|past ultra)\b|(?:and |also )*(?:the |my )?(?:peak|above ultra|beyond ultra|past ultra)\b(?: \w+)? (?:too|as well)\b)/
/** The taxonomy over a goal; with `peak` false the Peak rule sits out and the goal reads as it did before Peak. */
function read(input: string, peak: boolean): Reading {
  let text = normalize(input)
  const base = text
  let kept = text
  const tags = new Set<Tag>()
  const unmapped: Unmapped[] = []
  const hyps: Hyp[] = []
  const blank = (s: string, m: RegExpExecArray) => `${s.slice(0, m.index)}${' '.repeat(m[0].length)}${s.slice(m.index + m[0].length)}`
  const consume = (m: RegExpExecArray) => { text = blank(text, m) }
  const harm = HARM.test(text)
  for (const u of UNSUPPORTED) {
    const m = u.re.exec(text)
    if (m) { unmapped.push({ label: u.label, modules: u.modules }); consume(m) }
  }
  const unsureMatch = UNSURE.exec(text)
  const unsure = unsureMatch ? unsureMatch[0] : null
  if (unsureMatch) consume(unsureMatch)
  if (!harm) {
    for (const r of RULES) {
      if (r === PEAK_RULE && !peak) continue
      const m = r.re.exec(text)
      if (!m) continue
      consume(m)
      let settled = true
      for (const e of r.emit) {
        const value = typeof e.value === 'function' ? e.value(m) : e.value
        // Another control's ask settles its words, so a negation there is its own ("peak graphics and no traffic"); the
        // tier's own words, the controls and the console do not.
        if (r !== PEAK_RULE && (e.control === 'quality' || e.control === 'controls' || e.control === 'console')) settled = false
        if (typeof e.value === 'function' && value === undefined) continue
        if (e.tag) tags.add(e.tag)
        mergeHyp(hyps, { control: e.control, value, confidence: e.confidence, at: m.index, derived: false })
      }
      if (settled) {
        let from = m.index
        let to = m.index + m[0].length
        const before = r === PEAK_RULE || TURN_SHARED.test(base.slice(to)) ? null : TURN_BEFORE.exec(kept.slice(0, from))
        if (before) {
          from = before.index
          to += TURN_AFTER.exec(kept.slice(to))?.[0].length ?? 0
        }
        kept = `${kept.slice(0, from)}${' '.repeat(to - from)}${kept.slice(to)}`
      }
    }
  }
  return { hyps, tags, unmapped, harm, unsure, kept }
}

/**
 * A goal never sets Peak: Sloane asks first (quality.peak), and the console's goal, which asks nothing, leaves the tier
 * alone. Peak turned down or doubted (PEAK_DOUBT outside the other things the goal asks for, a struck Peak, Peak passed
 * over, another tier, a slow frame) is Ultra at most, which stepFor makes a ceiling the host never raises; a lower tier
 * or auto the goal names stands, and so does the heat and battery rule's Low. The rest of the goal reads as it did before
 * Peak.
 */
function analyze(input: string): Analysis {
  let r = read(input, peakNamed(input))
  const q = r.hyps.find((h) => h.control === 'quality')
  if (q?.value === PEAK_TIER) {
    const raw = input.slice(0, 1024).normalize('NFKC').toLowerCase()
    const said = normalize(input)
    const beside = blankAt(said, PEAK_OVER_ULTRA).replace(PEAK_NAMED_ALL, ' ')
    const kept = blankAt(r.kept, PEAK_OVER_ULTRA, said).replace(YES_ALL, ' ')
    const down = (!PEAK_KEEP.test(said) && (PEAK_DOUBT.test(kept) || PEAK_OFF.test(beside) || PEAK_NOBODY.test(beside) ||
      PEAK_STRUCK.test(raw) || PEAK_CANCEL.test(asPeak(said)))) || OTHER_TIER.test(beside) || PEAK_PASSED.test(said) || r.tags.has('performance')
    r = read(input, false)
    let b = r.hyps.find((h) => h.control === 'quality')
    if (b === undefined) { b = { ...q, value: undefined }; r.hyps.push(b) }
    // A lower tier or auto the goal names stands ("peak quality auto", "peak graphics, medium please").
    const t = tierOf(input)
    if (down && t !== undefined && t !== TIERS.length - 1) b.value = t
    else if (b.value === undefined || b.value === TIERS.length - 1) {
      if (down) { b.value = TIERS.length - 1; r.tags.add('no-peak') }
      else { b.value = undefined; r.tags.add('peak-ask') }
    }
  }
  const { hyps, tags, unmapped, harm, unsure } = r
  hyps.sort((a, b) => b.confidence - a.confidence || a.at - b.at)
  const flag: Flag = harm ? 'harm' : hyps.length ? 'none' : unsure !== null ? 'unsure' : 'unmapped'
  return { hyps, tags, unmapped, flag }
}

/** The controls a goal names, strongest first: the keyword/phrase taxonomy on its own. */
export function classify(text: string): Classification[] {
  return analyze(clean(text)).hyps.map(({ control, value, confidence }) => (value === undefined ? { control, confidence } : { control, value, confidence }))
}

// ---------------------------------------------------------------------------------------------------
// The why-questions

const find = (f: Frame, c: Control) => f.hyps.find((h) => h.control === c)
const has = (f: Frame, c: Control) => find(f, c) !== undefined
const any = (f: Frame, ...tags: Tag[]) => tags.some((t) => f.tags.has(t))
function put(f: Frame, control: Control, value: Value | undefined, confidence: number, derived: boolean): void {
  const h = find(f, control)
  if (h) {
    h.confidence = Math.max(h.confidence, confidence)
    if (value !== undefined) h.value = value
    return
  }
  f.hyps.push({ control, value, confidence, at: f.hyps.length, derived })
}
const drop = (f: Frame, c: Control) => { const i = f.hyps.findIndex((h) => h.control === c); if (i >= 0) f.hyps.splice(i, 1) }
const primary = (f: Frame): Hyp | undefined => f.hyps[0]
const hoursOf = (f: Frame): number => { const v = find(f, 'time')?.value; return typeof v === 'number' ? v : Number.NaN }

/** The option an answer means: the first choice with a cue phrase in it; null for free text. Chips match
 *  themselves, so "Both" goes first wherever it is offered. */
function pick(answer: string, choices: readonly (readonly [key: string, ...cues: string[]])[]): string | null {
  const a = ` ${normalize(answer)} `
  for (const [key, ...cues] of choices) {
    for (const cue of cues) if (a.includes(` ${cue} `)) return key
  }
  return null
}

/** Free text in an answer can name a control outright ("fewer people"): it joins the frame. With Peak set, or in an
 *  answer that names it, the tier is left to peakAnswer, so "detail please" never trades Peak for Ultra. */
function absorb(f: Frame, answer: string, derived: boolean): Control[] {
  const a = analyze(answer)
  const named = peakNamed(answer) || find(f, 'quality')?.value === PEAK_TIER
  for (const h of a.hyps) if (!(named && h.control === 'quality')) put(f, h.control, h.value, h.confidence, derived)
  for (const t of a.tags) if (!(named && (t === 'no-peak' || t === 'peak-ask'))) f.tags.add(t)
  for (const u of a.unmapped) if (!f.unmapped.some((x) => x.label === u.label)) f.unmapped.push(u)
  return a.hyps.map((h) => h.control)
}

/**
 * The last word on Peak after every answer (`key` is the question it answers, `prev` the one before). With Peak set, an
 * answer that turns it down ("no peak", "cancel peak", "the light, but not peak graphics", "turn down the graphics", "my
 * card only has 4gb", and to a question about the picture "lower please" or "reduce it"; "changed my mind" right after
 * Set Peak), names another tier ("the light, on high", "let it decide") or tells of a slow frame or heat lowers it, to
 * the tier it names or reads ("reduce the quality" is Low) or Ultra at most; anything else keeps it ("max graphics" and
 * "peak, not ultra" too). Without Peak, an answer that names it reads as a goal would (analyze): a turn-down brings an
 * unset or Ultra tier to Ultra at most (a lower tier or auto the frame holds stands, unless the answer chooses a tier),
 * and a mention leaves an unset or Ultra tier to Sloane's Peak question. Nothing but her question sets Peak.
 */
function peakAnswer(f: Frame, answer: string, key?: string, prev?: string): void {
  const q = find(f, 'quality')
  const held = q?.value
  const named = peakNamed(answer)
  if (!named && held !== PEAK_TIER) return
  const a = analyze(answer)
  const v = a.hyps.find((h) => h.control === 'quality')?.value
  const n = normalize(answer).replace(PEAK_OVER_ULTRA, ' peak ').replace(PEAK_ABOVE, ' peak ')
  const chosen = tierOf(answer) ?? ((typeof v === 'number' && v < TIERS.length - 1) || v === 'auto' ? v : undefined)
  const t = chosen ?? (OTHER_TIER.test(n.replace(PEAK_NAMED_ALL, ' ')) ? v : undefined)
  if (q && held === PEAK_TIER) {
    const raw = answer.slice(0, 1024).normalize('NFKC').toLowerCase()
    const perf = a.tags.has('performance') || a.tags.has('battery')
    for (const tag of ['performance', 'battery'] as const) if (a.tags.has(tag)) f.tags.add(tag)
    const doubt = PEAK_DOUBT.test(n.replace(YES_ALL, ' '))
    const lone = a.hyps.every((h) => h.control === 'quality')
    const picture = key === undefined || key.startsWith('quality.')
    if (t !== undefined) q.value = t
    else if (perf || a.tags.has('no-peak') || PEAK_DROP.test(n) || (picture && PEAK_LOWER.test(n)) ||
      (lone && prev === 'quality.peak' && PEAK_UNDO.test(n)) || PEAK_CANCEL.test(n) ||
      (PEAK_MACHINE.test(n) && doubt) ||
      (PEAK_BARE.test(n) && (doubt || PEAK_STRUCK.test(raw) || PEAK_PASSED.test(n)))) q.value = TIERS.length - 1
    if (q.value === TIERS.length - 1) f.tags.add('no-peak')
    return
  }
  if (a.tags.has('peak-ask')) {
    // An Ultra the frame holds ("make it prettier", "turn off peak graphics") gives way to her question while she can
    // still ask it.
    const ask = held === TIERS.length - 1 && !f.asked.has('quality.peak') && f.asked.size < MAX_WHYS
    if (held === undefined || ask) {
      if (q) q.value = undefined
      else put(f, 'quality', undefined, 0.9, false)
      f.tags.add('peak-ask')
      f.tags.delete('no-peak')
    }
  } else if (v !== undefined && (held === undefined || held === TIERS.length - 1 || chosen !== undefined)) {
    put(f, 'quality', v, 1, false)
    if (a.tags.has('no-peak')) f.tags.add('no-peak')
  }
}

interface Probe {
  key: string
  when(f: Frame): boolean
  ask(f: Frame): { question: string; options: readonly string[] }
  resolve(answer: string, f: Frame): void
}

const REDIRECT = ['Look around', 'How it looks', 'How it runs', 'The controls'] as const
const BOTH = ['both', 'both', 'all', 'either', 'each'] as const

/** In priority order: a goal with nothing to map is redirected, a reading with two meanings is settled, a
 *  control without a value gets one, then the "why" of the primary control, then how to get there. Each
 *  is asked at most once, and none is asked when nothing is ambiguous. */
const PROBES: readonly Probe[] = [
  {
    key: 'redirect',
    when: (f) => f.hyps.length === 0,
    // A goal with nothing to map, or (flag 'none') an answer that emptied the frame.
    ask: (f) => ({
      question: f.flag === 'harm'
        ? 'Nothing here can hurt anyone — every car stops for people, always. Would you rather look around, change how the city looks, or how it runs?'
        : f.flag === 'unsure'
          ? 'No pressure. Would you rather look around, change how the city looks, or how it runs?'
          : f.flag === 'unmapped'
            ? 'That’s not something I can do yet. Would you rather look around, change how the city looks, or how it runs?'
            : 'I didn’t catch that. Would you rather look around, change how the city looks, or how it runs?',
      options: REDIRECT,
    }),
    resolve: (a, f) => {
      const k = pick(a, [
        ['looks', 'how it looks', 'the look', 'looks', 'appearance', 'light', 'time of day', 'night', 'day', 'pretty'],
        ['runs', 'how it runs', 'runs', 'performance', 'smooth', 'smoother', 'fps', 'lag', 'laggy', 'faster'],
        ['controls', 'controls', 'control', 'keys', 'buttons', 'help'],
        ['around', 'look around', 'looking around', 'around', 'explore', 'wander', 'walk', 'look'],
      ])
      if (k === 'around') put(f, 'walk', 'explore', 1, false)
      else if (k === 'looks') put(f, 'time', undefined, 0.6, false)
      else if (k === 'runs') { put(f, 'quality', undefined, 0.6, false); f.tags.add('performance') }
      else if (k === 'controls') put(f, 'controls', undefined, 1, false)
      else absorb(f, a, false)
    },
  },
  {
    key: 'quiet',
    when: (f) => f.tags.has('quiet') && has(f, 'crowd') && has(f, 'audio'),
    ask: () => ({ question: 'Quiet as in fewer people about, or as in less sound?', options: ['Fewer people', 'Less sound', 'Both'] }),
    resolve: (a, f) => {
      const k = pick(a, [BOTH, ['people', 'fewer people', 'people', 'crowd', 'streets', 'busy', 'empty'], ['sound', 'less sound', 'sound', 'audio', 'volume', 'noise', 'mute', 'softer']])
      if (k === 'people') { drop(f, 'audio'); put(f, 'crowd', 'fewer', 1, false) }
      else if (k === 'sound') { drop(f, 'crowd'); put(f, 'audio', 30, 1, false) }
      else if (k === 'both') { put(f, 'crowd', 'fewer', 1, false); put(f, 'audio', 30, 1, false) }
      else absorb(f, a, false)
    },
  },
  {
    key: 'noisy',
    when: (f) => f.tags.has('noisy') && has(f, 'audio') && has(f, 'cars'),
    ask: () => ({ question: 'Is it the sound level, or the traffic itself?', options: ['The sound', 'The traffic', 'Both'] }),
    resolve: (a, f) => {
      const k = pick(a, [BOTH, ['sound', 'the sound', 'sound', 'audio', 'volume', 'level', 'softer'], ['traffic', 'the traffic', 'traffic', 'cars', 'roads', 'vehicles']])
      if (k === 'sound') { drop(f, 'cars'); put(f, 'audio', 30, 1, false) }
      else if (k === 'traffic') { drop(f, 'audio'); put(f, 'cars', 'fewer', 1, false) }
      else if (k === 'both') { put(f, 'audio', 30, 1, false); put(f, 'cars', 'fewer', 1, false) }
      else absorb(f, a, false)
    },
  },
  {
    key: 'time.value',
    when: (f) => has(f, 'time') && find(f, 'time')?.value === undefined,
    ask: () => ({ question: 'What time of day would suit you?', options: ['Morning', 'Noon', 'Golden hour', 'Sunset', 'Night'] }),
    // The whole answer joins the frame: "night, and fewer people" has answered the next why as well.
    resolve: (a, f) => {
      absorb(f, a, false)
      if (typeof find(f, 'time')?.value !== 'number') { drop(f, 'time'); f.unmapped.push({ label: 'A time of day: I didn’t catch one', modules: [] }) }
    },
  },
  {
    key: 'quality.peak',
    // Any goal that names Peak without turning it down (analyze): set nothing until the visitor says.
    when: (f) => f.tags.has('peak-ask') && find(f, 'quality')?.value === undefined,
    ask: () => ({ question: 'Peak takes a big graphics card and about half a gigabyte more of its memory. Set Peak, or keep to Ultra at most?', options: ['Set Peak', 'Ultra at most'] }),
    resolve: (a, f) => {
      const raw = a.slice(0, 1024).normalize('NFKC').toLowerCase()
      // Ultra passed over for Peak, or the tier above it, is Peak's name here ("peak, not ultra", "higher than ultra").
      const n = normalize(a).replace(PEAK_OVER_ULTRA, ' peak ').replace(PEAK_ABOVE, ' peak ')
      const r = analyze(a)
      // A lower tier named as a choice stands ("medium please", "no, auto"), and so does one the taxonomy reads (the heat
      // rule's Low). Ultra is the turn-down's to give, with its ceiling, never a cue's ("sharper detail").
      let v = tierOf(a) ?? r.hyps.find((h) => h.control === 'quality')?.value
      if (v === TIERS.length - 1) v = undefined
      // Peak by any of its names: "beyond ultra" is Peak, not Ultra.
      const c = asPeak(n).replace(YES_ALL, ' ')
      // "Higher" alone names no tier ("the higher one"), so it is no turn-down either.
      const down = PEAK_STRUCK.test(raw) || PEAK_PASSED.test(n) || PEAK_DOUBT.test(n.replace(YES_ALL, ' ')) || PEAK_CANCEL.test(c) ||
        OTHER_TIER.test(n.replace(PEAK_NAMED_ALL, ' ').replace(/\bhigher\b/g, ' ')) || r.tags.has('performance')
      // Peak with nothing beside it but ways of asking or choosing ("Set Peak", "peak please", "yes, go peak", "beyond
      // ultra") sets it; a sign, a question or a word Sloane cannot read is no choice ("!peak", "peak?", "would you go
      // with peak", "не peak").
      const peak = !down && v === undefined && /\bpeak\b/.test(c) && !FOREIGN.test(raw) && !SIGNS.test(raw) && !raw.includes('?') &&
        c.replace(ASKING, ' ').replace(PEAK_PLAIN, ' ').replace(PEAK_CHOICE, ' ').trim() === ''
      if (peak) { put(f, 'quality', PEAK_TIER, 1, false); f.tags.add('fidelity'); f.tags.delete('peak-ask') }
      else if ((typeof v === 'number' && v < TIERS.length - 1) || v === 'auto') put(f, 'quality', v, 1, false)
      else if (down) { put(f, 'quality', TIERS.length - 1, 1, false); f.tags.add('no-peak') }
      // Anything else ("yes" to an either-or, "maybe", "peak?") leaves the tier as it is.
      for (const t of ['performance', 'battery'] as const) if (r.tags.has(t)) f.tags.add(t)
    },
  },
  {
    key: 'quality.value',
    when: (f) => has(f, 'quality') && find(f, 'quality')?.value === undefined && !any(f, 'performance', 'fidelity', 'peak-ask'),
    ask: () => ({ question: 'Smoother, or more detail?', options: ['Smoother', 'More detail', 'Let it decide'] }),
    resolve: (a, f) => {
      const k = pick(a, [['smooth', 'smoother', 'smooth', 'faster', 'speed', 'fps', 'lower'], ['detail', 'more detail', 'detail', 'prettier', 'sharper', 'higher', 'better'], ['auto', 'let it decide', 'decide', 'auto', 'automatic', 'whatever']])
      if (k === 'smooth') { put(f, 'quality', 1, 1, false); f.tags.add('smooth') }
      else if (k === 'detail') { put(f, 'quality', 4, 1, false); f.tags.add('detail') }
      else put(f, 'quality', 'auto', 1, false)
    },
  },
  {
    key: 'audio.music',
    when: (f) => f.tags.has('music') && has(f, 'audio') && find(f, 'audio')?.value === undefined,
    ask: () => ({ question: 'There’s no music here, only the city’s own sound. Would you like that on, or off?', options: ['On', 'Off'] }),
    resolve: (a, f) => put(f, 'audio', pick(a, [['off', 'off', 'no', 'nope', 'nah', 'mute', 'silent', 'silence'], ['on', 'on', 'yes', 'sure', 'please']]) === 'off' ? 'off' : 'on', 1, false),
  },
  {
    key: 'audio.value',
    when: (f) => has(f, 'audio') && find(f, 'audio')?.value === undefined,
    ask: () => ({ question: 'Sound on, or off?', options: ['On', 'Off', 'Softer', 'Louder'] }),
    resolve: (a, f) => {
      const k = pick(a, [['off', 'off', 'mute', 'silent', 'silence', 'no', 'nope', 'nah'], ['softer', 'softer', 'quieter', 'down', 'lower', 'less'], ['louder', 'louder', 'loud', 'up', 'more'], ['on', 'on', 'yes', 'sure', 'please']])
      put(f, 'audio', k === 'off' ? 'off' : k === 'softer' ? 30 : k === 'louder' ? 100 : 'on', 1, false)
    },
  },
  {
    key: 'crowd.value',
    when: (f) => has(f, 'crowd') && find(f, 'crowd')?.value === undefined,
    ask: () => ({ question: 'More people about, or fewer?', options: ['More', 'Fewer', 'None at all'] }),
    resolve: (a, f) => {
      const k = pick(a, [['none', 'none', 'nobody', 'empty', 'no one', 'noone'], ['fewer', 'fewer', 'less', 'quieter', 'thinner'], ['more', 'more', 'busier', 'lots', 'busy', 'crowded']])
      if (k) put(f, 'crowd', k, 1, false)
      else if (!absorb(f, a, false).includes('crowd') || find(f, 'crowd')?.value === undefined) { drop(f, 'crowd'); f.unmapped.push({ label: 'How many people: I didn’t catch more or fewer', modules: [] }) }
    },
  },
  {
    key: 'cars.value',
    when: (f) => has(f, 'cars') && find(f, 'cars')?.value === undefined,
    ask: () => ({ question: 'More traffic, or less?', options: ['More', 'Fewer', 'None at all'] }),
    resolve: (a, f) => {
      const k = pick(a, [['none', 'none', 'no cars', 'empty', 'zero'], ['fewer', 'fewer', 'less', 'quieter', 'calmer'], ['more', 'more', 'busier', 'lots', 'busy', 'heavy']])
      if (k) put(f, 'cars', k, 1, false)
      else if (!absorb(f, a, false).includes('cars') || find(f, 'cars')?.value === undefined) { drop(f, 'cars'); f.unmapped.push({ label: 'How much traffic: I didn’t catch more or less', modules: [] }) }
    },
  },
  {
    key: 'district.which',
    when: (f) => (has(f, 'district') && find(f, 'district')?.value === undefined) || (find(f, 'walk')?.value === 'explore' && !has(f, 'district') && !f.tags.has('anywhere')),
    ask: () => ({ question: 'Anywhere in particular?', options: ['The harbour', 'The market', 'The civic centre', 'Midtown', 'The financial district', 'Anywhere'] }),
    resolve: (a, f) => {
      const d = analyze(a).hyps.find((h) => h.control === 'district' && h.value !== undefined)
      const named = has(f, 'district')
      if (d) put(f, 'district', d.value, 1, !named)
      else {
        drop(f, 'district')
        f.tags.add('anywhere')
        // "Somewhere new" with no district in mind is a wander, not an empty frame.
        if (!has(f, 'walk') && !has(f, 'drive')) put(f, 'walk', 'explore', 1, false)
      }
    },
  },
  {
    key: 'console.why',
    when: (f) => has(f, 'console') && f.tags.has('maybe-operator') && !f.tags.has('operator'),
    ask: () => ({ question: 'The console is the operator’s desk: commands and scripts over the running city. Is that what you’re after, or the everyday controls?', options: ['The console', 'Everyday controls'] }),
    resolve: (a, f) => {
      const k = pick(a, [['controls', 'everyday controls', 'everyday', 'controls', 'keys', 'buttons', 'no'], ['console', 'the console', 'console', 'yes', 'operator', 'scripts', 'commands']])
      if (k === 'controls') { drop(f, 'console'); put(f, 'controls', undefined, 1, false) }
      else f.tags.add('operator')
    },
  },
  {
    key: 'time.why',
    // A goal that names the crowd as well ("3 pm and busy") has answered this already.
    when: (f) => { const t = primary(f); return t?.control === 'time' && typeof t.value === 'number' && !t.derived && !has(f, 'crowd') && !any(f, 'look', 'light', 'crowd-root', 'busier') },
    ask: (f) => {
      const h = hoursOf(f)
      return h >= 18.5 || h < 6
        ? { question: 'Is it the look you’re after, or fewer people about?', options: ['The look', 'Fewer people', 'Both'] }
        : { question: 'Is it the light you’re after, or busier streets too?', options: ['The light', 'Busier too', 'Both'] }
    },
    resolve: (a, f) => {
      const h = hoursOf(f)
      const night = h >= 18.5 || h < 6
      const k = pick(a, [BOTH, ['look', 'the look', 'look', 'the light', 'light', 'mood', 'vibe', 'atmosphere', 'pretty', 'view'], ['people', 'fewer people', 'busier too', 'people', 'crowd', 'fewer', 'busier', 'busy', 'quiet', 'streets']])
      const crowd = () => { put(f, 'crowd', night ? 'fewer' : 'more', 1, true); f.tags.add(night ? 'crowd-root' : 'busier') }
      if (k === 'look') f.tags.add(night ? 'look' : 'light')
      else if (k === 'people') crowd()
      else if (k === 'both') { f.tags.add(night ? 'look' : 'light'); crowd() }
      else if (absorb(f, a, true).includes('crowd')) f.tags.add(night ? 'crowd-root' : 'busier')
      else f.tags.add(night ? 'look' : 'light')
    },
  },
  {
    key: 'quality.perf',
    when: (f) => has(f, 'quality') && f.tags.has('performance') && !any(f, 'hitch', 'steady', 'battery'),
    ask: () => ({ question: 'Is it every few seconds, or all the time?', options: ['Every few seconds', 'All the time'] }),
    resolve: (a, f) => {
      const k = pick(a, [['hitch', 'every few seconds', 'few seconds', 'sometimes', 'bursts', 'now and then', 'occasionally', 'spikes', 'hitches', 'hitch', 'periodically', 'every few'], ['steady', 'all the time', 'always', 'constant', 'constantly', 'whole time', 'steady', 'continuous', 'entire', 'the time']])
      if (k === 'hitch') { put(f, 'quality', 'auto', 1, false); f.tags.add('hitch') }
      else { put(f, 'quality', 1, 1, false); f.tags.add('steady') }
    },
  },
  {
    key: 'quality.trade',
    when: (f) => has(f, 'quality') && f.tags.has('steady') && !any(f, 'smooth', 'detail-too'),
    ask: () => ({ question: 'Would you trade some detail for a steady frame rate?', options: ['Steady first', 'Keep the detail'] }),
    resolve: (a, f) => {
      const k = pick(a, [['detail', 'keep the detail', 'keep', 'detail', 'no', 'nope', 'nah', 'not', "don't", 'rather not'], ['steady', 'steady first', 'steady', 'yes', 'sure', 'ok', 'okay', 'trade', 'smooth', 'yep', 'please', 'fine', 'frame']])
      if (k === 'detail') { put(f, 'quality', 'auto', 1, false); f.tags.add('detail-too') }
      else { put(f, 'quality', 1, 1, false); f.tags.add('smooth') }
    },
  },
  {
    key: 'quality.fidelity',
    // Not while Peak waits on her question, or after an answer to it that set nothing.
    when: (f) => has(f, 'quality') && f.tags.has('fidelity') && !any(f, 'detail', 'light', 'no-peak') &&
      !(f.tags.has('peak-ask') && find(f, 'quality')?.value === undefined),
    ask: () => ({ question: 'Is it sharper detail you’re after, or the light and the sky?', options: ['Sharper detail', 'The light', 'Both'] }),
    resolve: (a, f) => {
      const k = pick(a, [BOTH, ['light', 'the light', 'light', 'sky', 'sun', 'rays', 'shafts', 'golden', 'atmosphere', 'mood'], ['detail', 'sharper detail', 'sharper', 'detail', 'sharp', 'crisp', 'resolution', 'textures']])
      const light = () => { f.tags.add('light'); if (find(f, 'time')?.value === undefined) put(f, 'time', 17.4, 1, true) }
      // On Peak, peakAnswer reads the tier from the answer, as after any other question ("my card only has 4gb").
      if (k === 'light') light()
      else if (k === 'both') { f.tags.add('detail'); light() }
      else f.tags.add('detail')
    },
  },
  {
    key: 'crowd.why',
    when: (f) => { const p = primary(f); return p?.control === 'crowd' && !p.derived && (p.value === 'fewer' || p.value === 'none') && !any(f, 'quiet', 'feel', 'perf-root') },
    ask: () => ({ question: 'Is it the feel of the streets, or to help the city run smoother?', options: ['The feel', 'Smoother', 'Both'] }),
    resolve: (a, f) => {
      const k = pick(a, [BOTH, ['smooth', 'smoother', 'smooth', 'faster', 'lag', 'laggy', 'fps', 'performance', 'runs'], ['feel', 'the feel', 'feel', 'look', 'mood', 'vibe', 'atmosphere', 'quiet', 'space']])
      const perf = () => { put(f, 'quality', 1, 1, true); f.tags.add('perf-root') }
      if (k === 'smooth') perf()
      else if (k === 'both') { f.tags.add('feel'); perf() }
      else f.tags.add('feel')
    },
  },
  {
    key: 'cars.why',
    when: (f) => { const p = primary(f); return p?.control === 'cars' && !p.derived && (p.value === 'fewer' || p.value === 'none') && !any(f, 'noisy', 'sound-root', 'crossing', 'look-roads') },
    ask: () => ({ question: 'Is it the sound of the traffic, crossing the road, or the look of the streets?', options: ['The sound', 'Crossing', 'The look'] }),
    resolve: (a, f) => {
      const k = pick(a, [['sound', 'the sound', 'sound', 'noise', 'noisy', 'loud', 'engines'], ['crossing', 'crossing', 'cross', 'road', 'safe', 'safely', 'safety', 'walk'], ['look', 'the look', 'look', 'calm', 'calmer', 'empty', 'quiet', 'feel']])
      if (k === 'sound') { put(f, 'audio', 30, 1, true); f.tags.add('sound-root') }
      else if (k === 'crossing') { put(f, 'walk', undefined, 1, true); f.tags.add('crossing') }
      else f.tags.add('look-roads')
    },
  },
  {
    key: 'district.how',
    when: (f) => has(f, 'district') && find(f, 'district')?.value !== undefined && !has(f, 'walk') && !has(f, 'drive'),
    ask: () => ({ question: 'On foot, or by car?', options: ['On foot', 'By car'] }),
    resolve: (a, f) => {
      const k = pick(a, [['car', 'by car', 'car', 'drive', 'driving', 'ride'], ['foot', 'on foot', 'foot', 'walk', 'walking', 'stroll', 'run']])
      if (k === 'car') { put(f, 'drive', undefined, 1, true); f.tags.add('by-car') }
      else if (k === 'foot') { put(f, 'walk', undefined, 1, true); f.tags.add('on-foot') }
      else absorb(f, a, true)
    },
  },
]

// ---------------------------------------------------------------------------------------------------
// The brief

const MODULES: Record<Control, readonly string[]> = {
  time: ['01_Initialize_World/solar.ts', '07_Execute_Actions/engine.ts'],
  quality: ['05_Observe_Environment/governor.ts', '07_Execute_Actions/quality.ts'],
  audio: ['07_Execute_Actions/audio.ts'],
  crowd: ['03_Spawn_Agents/crowdCompute.ts', '05_Observe_Environment/governor.ts', '07_Execute_Actions/engine.ts'],
  cars: ['07_Execute_Actions/vehicles.ts', '06_Make_Decisions/traffic.ts', '07_Execute_Actions/engine.ts'],
  district: ['01_Initialize_World/city.ts', '07_Execute_Actions/engine.ts'],
  walk: ['07_Execute_Actions/player.ts', '04_Connect_Hardware/input.ts'],
  drive: ['07_Execute_Actions/vehicles.ts', '07_Execute_Actions/player.ts'],
  console: ['07_Execute_Actions/terminal/commands.ts', '07_Execute_Actions/operator.ts'],
  controls: ['07_Execute_Actions/glyphs.ts', '07_Execute_Actions/Concierge.tsx'],
}

const CROWD_LABEL: Record<string, string> = { more: 'Bring more people onto the streets', fewer: 'Thin the crowd', none: 'Clear the streets of people' }
const CARS_LABEL: Record<string, string> = { more: 'Put more cars on the roads', fewer: 'Take some cars off the roads', none: 'Take every car off the roads' }

function stepFor(h: Hyp, f: Frame): PlanStep | null {
  const step = (label: string, immediate: boolean, extra: readonly string[] = []): PlanStep => {
    const modules = [...MODULES[h.control], ...extra]
    return h.value === undefined ? { control: h.control, label, immediate, modules } : { control: h.control, label, value: h.value, immediate, modules }
  }
  switch (h.control) {
    case 'time': {
      if (typeof h.value !== 'number') return null
      const name = timeName(h.value)
      return step(`Set the clock to ${formatClock(h.value)}${name ? ` (${name})` : ''}`, true)
    }
    case 'quality': {
      if (h.value === 'auto') return step('Let the quality govern itself', true)
      if (typeof h.value !== 'number' || !Number.isInteger(h.value) || h.value < LITE_TIER || h.value > PEAK_TIER) return null
      // Peak turned down, or named beside a complaint ("it lags on peak settings"), says where the trouble is: Ultra is the
      // most the host may pin, never a raise to Peak.
      if (h.value === PEAK_TIER ? any(f, 'performance', 'battery', 'smooth', 'steady', 'perf-root', 'hitch') : h.value === TIERS.length - 1 && f.tags.has('no-peak'))
        return { ...step('Lower the quality to Ultra or below', true), value: TIERS.length - 1, ceiling: true }
      const light = h.value >= TIERS.length - 1 && f.tags.has('light')
      // Heat, battery and a slow frame ask for less work, so the tier named is the most the host may pin, never a raise.
      if (h.value < TIERS.length - 1 && any(f, 'smooth', 'steady', 'battery', 'perf-root')) return { ...step(`Lower the quality to ${knobsOf(h.value).label} or below`, true), ceiling: true }
      return step(`Set the quality to ${knobsOf(h.value).label}${light ? ' (the golden-hour light shafts come with it)' : ''}`, true, light ? ['07_Execute_Actions/volumetrics.ts'] : [])
    }
    case 'audio':
      if (h.value === 'off') return step('Turn the sound off', true)
      if (h.value === 'on') return step('Turn the sound on', true)
      if (typeof h.value === 'number') return step(`Set the volume to ${Math.round(h.value)}%`, true)
      return null
    case 'crowd': return typeof h.value === 'string' && CROWD_LABEL[h.value] ? step(CROWD_LABEL[h.value], false) : null
    case 'cars': return typeof h.value === 'string' && CARS_LABEL[h.value] ? step(CARS_LABEL[h.value], false) : null
    case 'district': return typeof h.value === 'string' && h.value in DISTRICTS ? step(`Make for ${place(h.value)}, ${DISTRICTS[h.value as District]}`, false) : null
    case 'walk':
      if (f.tags.has('crossing')) return step('Cross wherever you like: every car stops for people', false)
      if (h.value === 'run') return step('Pick up the pace on foot', false)
      if (h.value === 'explore') return step('Wander on foot and see what you find', false)
      return step('Set off on foot', false)
    case 'drive': return step('Find a car and get in', false)
    case 'console': return step('Open the Ring-0 console', false)
    case 'controls': return step('Show the full control list', false)
  }
}

function rootOf(f: Frame): string {
  const p = primary(f)
  const t = (x: Tag) => f.tags.has(x)
  if (!p) {
    if (f.flag === 'harm') return 'Nothing here can hurt anyone, so let’s find what the city can do for you.'
    if (f.flag === 'unsure') return 'You’re happy just looking around for now.'
    return 'I couldn’t map this one yet.'
  }
  const district = find(f, 'district')?.value
  const learning = has(f, 'controls')
  switch (p.control) {
    case 'time': {
      if (typeof p.value !== 'number') return 'You want a different time of day.'
      const name = timeName(p.value) ?? formatClock(p.value)
      const at = ['morning', 'afternoon', 'evening'].includes(name) ? `in the ${name}` : `at ${name}`
      // The crowd came from a why-answer (a tag) or from the goal itself (a hypothesis of its own).
      const crowd = find(f, 'crowd')?.value
      const quieter = t('crowd-root') || crowd === 'fewer' || crowd === 'none'
      const busier = t('busier') || crowd === 'more'
      if (t('crowd-root') && !t('look')) return `Quieter streets are what you’re after; ${name} is a way to get there.`
      if (quieter) return `You want the look of ${name} and quieter streets.`
      if (t('busier') && !t('light')) return `Livelier streets are what you’re after; ${name} is a way to get there.`
      if (busier) return `You want the ${name} light and busier streets.`
      return `You want the city ${at}.`
    }
    case 'quality':
      if (t('battery')) return 'You want the device to stay cool and its battery to last.'
      if (t('hitch')) return 'The stutter comes in bursts: hitches rather than a steady overload.'
      if (t('smooth')) return 'A steady frame rate matters more to you than detail.'
      if (t('detail-too')) return 'You want a steady frame rate without giving up detail.'
      if (t('no-peak')) return t('performance') ? 'You want the city to run smoother.' : 'You want the city at Ultra or below, not Peak.'
      if (t('peak-ask') && p.value === undefined) return 'You asked about Peak, the tier above Ultra.'
      if (p.value === PEAK_TIER && t('performance')) return 'You want the city to run smoother.'
      if (t('light')) return 'You want the golden-hour light at full fidelity.'
      if (t('detail') || t('fidelity')) return 'You want the sharpest picture this machine can draw.'
      if (p.value === 'auto') return 'You want the city to look after its own frame rate.'
      return 'You want the city to run smoother.'
    case 'audio':
      if (p.value === 'off') return 'You want the sound off.'
      if (p.value === 'on') return t('music') ? 'You want to hear the city; it has no music of its own.' : 'You want the sound on.'
      if (typeof p.value === 'number') return p.value >= 60 ? 'You want the sound louder.' : 'You want the sound softer.'
      return 'You want the sound changed.'
    case 'crowd':
      if (t('perf-root')) return 'Quieter streets, mainly so the city runs smoother.'
      if (p.value === 'more') return 'You want livelier streets.'
      if (p.value === 'none') return 'You want the streets to yourself.'
      return 'You want quieter streets.'
    case 'cars':
      if (t('sound-root')) return 'It’s the sound of the traffic that bothers you.'
      if (t('crossing')) return 'You want to cross the road with confidence.'
      if (p.value === 'more') return 'You want busier roads.'
      return 'You want calmer roads.'
    case 'district': return `You want to see ${place(p.value)}${t('by-car') ? ' by car' : t('on-foot') ? ' on foot' : ''}.`
    case 'walk':
      if (t('crossing')) return 'You want to cross the road with confidence.'
      if (p.value === 'run') return learning ? 'You want to learn how to run.' : 'You want to move fast on foot.'
      if (p.value === 'explore') return district ? `You want to wander over to ${place(district)}.` : 'You want to wander and see what’s here.'
      if (learning) return 'You want to learn how to get around on foot.'
      return district ? `You want to walk to ${place(district)}.` : 'You want to get around on foot.'
    case 'drive':
      if (district) return `You want to drive to ${place(district)}.`
      if (learning) return 'You want to learn how to drive.'
      return t('fast') ? 'You want to drive, and not slowly.' : 'You want to drive.'
    case 'console': return 'You want the operator’s console.'
    case 'controls': return 'You want to learn the controls.'
  }
}

const code = (paths: readonly string[]) => paths.map((p) => `\`${p}\``).join(', ')

function markdownOf(goal: string, whys: readonly { question: string; answer: string }[], root: string, plan: readonly PlanStep[], unmapped: readonly Unmapped[], applied: ReadonlySet<Control>): string {
  const now = plan.filter((s) => s.immediate)
  const later = plan.filter((s) => !s.immediate)
  const item = (s: PlanStep) => `- [${applied.has(s.control) ? 'x' : ' '}] ${s.label} — ${code(s.modules)}`
  const lines = [
    '# Architecture brief', '', `**Goal:** ${goal}`, '', '## Why',
    ...(whys.length ? whys.map((w, i) => `${i + 1}. ${w.question} — **${w.answer}**`) : ['_No questions needed: the goal was clear._']),
    '', '## Root intent', root, '', '## Plan',
  ]
  if (!plan.length) lines.push('_Nothing to change._')
  if (now.length) lines.push('### Now — the Concierge applies these', ...now.map(item))
  if (later.length) lines.push('### Later — the operator’s console or a restart', ...later.map(item))
  if (unmapped.length) lines.push('', '## Not mapped', ...unmapped.map((u) => `- ${u.label}${u.modules.length ? ` — would touch ${code(u.modules)}` : ''}`))
  lines.push('', '---', '_Written by the concierge’s 5-Whys engine (deterministic, offline). Module paths are under `src/`._', '')
  return lines.join('\n')
}

/**
 * One goal refined by up to five why-questions. `next()` is the question to ask (stable until answered;
 * null once the mapping is unambiguous or five whys are spent); `answer()` takes a chip or free text;
 * `brief()` is always available and grows as answers arrive.
 */
export class FiveWhys {
  private readonly frame: Frame
  private readonly whys: { question: string; answer: string }[] = []
  private pending: { probe: Probe; step: WhyStep } | null = null
  private last: string | undefined

  constructor(goal: string) {
    const text = clean(goal)
    const a = analyze(text)
    this.frame = { goal: text, hyps: a.hyps, tags: a.tags, unmapped: a.unmapped, asked: new Set(), flag: a.flag }
  }

  /** Whys asked so far (0..5). */
  get depth(): number { return this.whys.length }

  next(): WhyStep | null {
    if (this.pending) return this.pending.step
    if (this.whys.length >= MAX_WHYS) return null
    const probe = PROBES.find((p) => !this.frame.asked.has(p.key) && p.when(this.frame))
    if (!probe) return null
    const q = probe.ask(this.frame)
    const step: WhyStep = { depth: this.whys.length, question: q.question, options: [...q.options] }
    this.pending = { probe, step }
    return step
  }

  /** Answers the pending question (asking it first if `next()` was not called). With no question left
   *  the text still refines the goal. Nothing said (blank, or only control characters) is not an answer. */
  answer(text: string): void {
    const a = clean(text)
    if (!a) return
    if (!this.pending) this.next()
    const p = this.pending
    if (!p) { absorb(this.frame, a, false); peakAnswer(this.frame, a, undefined, this.last); return }
    this.pending = null
    this.frame.asked.add(p.probe.key)
    this.whys.push({ question: p.step.question, answer: a })
    p.probe.resolve(a, this.frame)
    peakAnswer(this.frame, a, p.probe.key, this.last)
    this.last = p.probe.key
  }

  /** `applied`: the immediate steps the host has carried out, ticked in the markdown. */
  brief(applied: Iterable<Control> = []): Brief {
    const f = this.frame
    const done = new Set(applied)
    const plan: PlanStep[] = []
    for (const h of f.hyps) {
      const s = stepFor(h, f)
      if (s) plan.push(s)
    }
    const unmapped: Unmapped[] = []
    if (f.flag === 'harm') unmapped.push({ label: 'Harm to anyone: not something this city can do. Every car stops for people, and nothing here can hurt anyone', modules: [] })
    else if (f.flag === 'unmapped' && !f.unmapped.length) unmapped.push({ label: `“${f.goal}”: nothing in the city maps to that yet`, modules: [] })
    unmapped.push(...f.unmapped)
    const root = rootOf(f)
    return {
      goal: f.goal,
      whys: this.whys.map((w) => ({ ...w })),
      root,
      plan,
      unmapped: unmapped.map((u) => u.label),
      markdown: markdownOf(f.goal, this.whys, root, plan, unmapped, done),
    }
  }
}
