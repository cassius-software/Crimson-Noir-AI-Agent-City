// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It says who a person is when the player talks to them, and what they say when no model
 * answers. Who they are is a TalkWho: the label over their head (the city's own 'Pedestrian 1234 (Rust)', the form
 * the engine's speech captions use, or a hired agent's roster name), the short line beneath it, their two skills, and
 * the voice they speak in (a voice profile that is never Sloane's, a number that picks one of the browser's offline
 * voices, and a hired agent's own speech-provider voice when the roster names one). What they say without a model is
 * a scripted line chosen by role (a passer-by, a recruit the player asked over, or one of the player's own agents) and
 * by what the player seems to want (a greeting, who they are, their work, help, a change to the city, thanks, goodbye,
 * anything else, or words the 14A screen refuses). The choice is deterministic: the same person, intent and turn give
 * the same line, and a conversation never repeats a line until it has used every other one for that intent. Every
 * line is original, short (at most three sentences and 240 characters), in a light noir tone in plain words, names no
 * place and says nothing of the weather or the news; every filled line passes the 14A screen (02_Define_The_Rules/
 * conduct.ts) and is never heard as a recruitment request (03_Spawn_Agents/skills.ts parseRequest), because the
 * browser's own recogniser could hear a line coming back through the speakers and act on it. The tests hold every
 * line to that for every role, skill, sample name and time of day, and a filled line that still failed would be
 * replaced by the role's fixed line at run time. It also builds the prompt a model is given when one may answer
 * (personPrompt): who the person is, the rules of the conversation, what is known about them, and the last few turns.
 * Pure: no DOM, no engine, no clock, no randomness. The conversation's controller (07_Execute_Actions/talk.ts) uses it.
 * What breaks if it is removed? People fall silent on every phone (where no model answers them), and nobody the
 * player walks up to has a name or a voice.
 */
import { normalise, screen } from '../02_Define_The_Rules/conduct.ts'
import { mix, parseRequest, SKILL_WORDS, SKILLS, skillsOf } from '../03_Spawn_Agents/skills.ts'
import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'
import { VOICE_PROFILES, voiceProfile, type AgentIdentity, type VoiceProfile } from './roster.ts'

/**
 * Who a person is to the player. A stranger is anyone walking by. A recruit is someone the player asked over by
 * skill, walking over or walking with them. Crew is one of the player's own agents from the roster, hired as that
 * person (a hired agent is a recruit too; the roster record wins).
 */
export type TalkRole = 'stranger' | 'recruit' | 'crew'

/**
 * How a person sounds. `profile` shapes a browser voice's pitch and rate and is never Sloane's (`velvet`); `pick` is
 * a fixed number per person that chooses among the browser's offline voices (the speaker takes it modulo how many
 * there are); `provider` is a hired agent's own speech-provider voice, and null for everyone else, so a passer-by never
 * speaks in the operator's provider voice or spends its quota.
 */
export interface TalkVoice {
  readonly profile: VoiceProfile
  readonly pick: number
  readonly provider: string | null
}

/**
 * A person as the conversation knows them. `label` is what the label over their head, the chip and the toasts call
 * them; `name` is what the transcript and the prompt call them (a pedestrian's number without the skill, or the
 * roster name); `line` is the short line under the label; `skill` and `skill2` fill the scripted lines.
 */
export interface TalkWho {
  readonly row: number
  readonly role: TalkRole
  readonly label: string
  readonly name: string
  readonly line: string
  readonly skill: string
  readonly skill2: string
  readonly voice: TalkVoice
}

/** Keeps the browser-voice pick apart from the profile choice, which mixes the bare row. */
const PICK_SALT = 0x68e31da4

/**
 * Who pedestrian `row` is to the player: crew when the roster has a record hired as them, else a recruit when the
 * recruiter lists them, else a stranger. The label of a stranger or a recruit is `Pedestrian ${row} (${skill})`, the
 * form the engine's speech captions use (engine.ts speechOut), where a recruit's skill is the one they were asked over
 * for and a stranger's is the first of their two; a hired agent is labelled by their roster name. The voice profile
 * is a hired agent's own when the roster names a profile other than Sloane's, else one of the eleven others chosen
 * by the row; `provider` is passed through for a hired agent only.
 */
export function talkWho(row: number, identity: AgentIdentity | null, recruit: Pick<RecruitView, 'skill' | 'state'> | null, provider: string | null): TalkWho {
  const own = skillsOf(row)
  const spare = SKILLS[mix(row | 0) % SKILLS.length]
  const asked = recruit && typeof recruit.skill === 'string' && recruit.skill.trim() ? recruit.skill.trim() : ''
  const skill = asked || own[0] || spare
  const skill2 = own.find((s) => s !== skill) ?? SKILLS[((SKILLS as readonly string[]).indexOf(skill) + 1) % SKILLS.length]
  const role: TalkRole = identity ? 'crew' : recruit ? 'recruit' : 'stranger'
  const numbered = skill ? `Pedestrian ${row} (${skill})` : `Pedestrian ${row}`
  const label = identity ? identity.name : numbered
  const name = identity ? identity.name : `Pedestrian ${row}`
  const line = identity
    ? identity.role ? `${identity.role} · ${skill}` : `${skill} · ${skill2}`
    : recruit ? `${skill} · ${recruit.state === 'Active' ? 'with you' : 'coming over'}` : `${skill} · ${skill2}`
  const chosen = identity ? voiceProfile(identity.voice) : null
  const profile = chosen && chosen !== VOICE_PROFILES[0] ? chosen : VOICE_PROFILES[1 + (mix(row | 0) % (VOICE_PROFILES.length - 1))]
  const voice: TalkVoice = Object.freeze({ profile, pick: mix((row | 0) ^ PICK_SALT), provider: identity ? provider : null })
  return Object.freeze({ row, role, label, name, line, skill, skill2, voice })
}

/**
 * What the player seems to want from one line: a greeting, who the person is, their work, help (to follow, to do
 * something for them, to be told where to go), a change to the city (Sloane's to make), thanks, goodbye, anything
 * else, or `refused` when the 14A screen does not admit the words. The order is the index the variant formula uses.
 */
export const INTENTS = ['greet', 'who', 'work', 'help', 'city', 'thanks', 'bye', 'other', 'refused'] as const
export type Intent = (typeof INTENTS)[number]

/** The skill words a line about someone's work names, as the screen's normal form reads them (lone letters left out). */
const SKILL_TALK = [...new Set(Object.values(SKILL_WORDS).flat())].filter((w) => w.length > 2 && normalise(w) === w)

/**
 * How each intent is recognised, in the order they are tried, over the screen's normal form of the line (lower case,
 * letters and digits, single spaces) padded with a space at each end, so ' bye ' is a whole word. A goodbye wins over
 * thanks ('thanks, bye' ends the conversation), a change to the city or a mention of Sloane over the rest, and a
 * greeting only when nothing more specific was asked ('hi, what is your name' asks who they are).
 */
const INTENT_RES: readonly (readonly [Intent, RegExp])[] = [
  ['bye', / (?:bye|goodbye|good bye|byebye|farewell|take care|catch you later|talk later|talk to you later|gotta go|got to go|have to go|need to go|must go|i m off|i m leaving|good night|goodnight|cya)(?= )| see (?:you|ya)(?: later| around| soon| then| again)? $| see (?:you|ya) (?:later|around|soon) |^ (?:later|so long) $/],
  ['thanks', / (?:thanks|thank you|thank u|thx|cheers|much obliged|appreciate it|appreciated|grateful)(?= )/],
  ['city', / sloane? | (?:make|turn|switch|change|set|speed up|slow down|skip|dim|brighten)(?: \S+)* (?:night|day|daytime|morning|noon|evening|dusk|dawn|time|traffic|cars|crowd|crowds|sound|music|volume|quality|graphics|picture|lights|clock|city)(?= )| take me (?:to|home|somewhere) | teleport| controls /],
  ['who', / (?:who are you|who r u|who s this|who is this|what s your name|whats your name|what is your name|your name|introduce yourself|tell me about yourself|about you|where are you from|where you from|who you are)(?= )/],
  ['help', / (?:help|assist|come with|come along|follow me|walk with me|join me|join us|tag along|work for me|work with me|team up|hire|recruit|lost|directions|where should i|what should i|where do i|what do i do|how do i|advice|any tips|a tip|recommend|what can you do|can you do|a hand)(?= )/],
  ['work', new RegExp(` (?:what do you do|what you do|your job|a job|for work|for a living|work on|working on|you work|your work|your skills?|good at|you know about|your trade|line of work|busy|code|coding|program|programming|skills?|craft|${SKILL_TALK.join('|')})(?= )`)],
  ['greet', / (?:hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening|good day|morning|evening|afternoon|how are you|how s it going|how you doing|how are things|what s up|whats up|sup|excuse me|pardon me|greetings)(?= )/],
]

/** Characters of a line read for its intent (a heard or typed line is at most 200; the screen still reads it whole). */
const INTENT_READ = 400

/** What the player seems to want from `text` (Intent); `refused` when the 14A screen does not admit it, `other` when nothing matches. */
export function intentOf(text: string): Intent {
  const raw = typeof text === 'string' ? text : ''
  if (!screen(raw).admissible) return 'refused'
  const t = ` ${normalise(raw.slice(0, INTENT_READ))} `
  for (const [intent, re] of INTENT_RES) if (re.test(t)) return intent
  return 'other'
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** The small words people put before a name or after a greeting. */
const LEAD = '(?:(?:hi|hello|hey|hiya|ok|okay|so|right|please|excuse me|pardon me)[\\s,.!:;-]+)*'
/** A line that speaks to Sloane first ("hi Sloane, …", "Sloan?"): hers, never a greeting to the person near. */
const TO_SLOANE = new RegExp(`^${LEAD}sloane?\\b(?!['’])`, 'i')
/** A greeting at the head of a line. */
const GREETING = /^(?:hi|hello|hey|hiya|excuse me|pardon me|good (?:morning|afternoon|evening))\b/i

/**
 * Whether `text` greets the person near (so a spoken greeting may open the conversation): a greeting at the head of
 * the line (hi, hello, hey, hiya, excuse me, pardon me, good morning, afternoon or evening), or a hired agent's own
 * name at its head. A line that speaks to Sloane first is hers, and plain talk greets nobody, so the room's talk never
 * opens a conversation.
 */
export function greets(text: string, who: TalkWho): boolean {
  const t = (typeof text === 'string' ? text : '').replace(/\s+/g, ' ').trim().replace(/^[^\p{L}\p{N}]+/u, '')
  if (!t || TO_SLOANE.test(t)) return false
  if (GREETING.test(t)) return true
  return who.role === 'crew' && who.name !== '' && new RegExp(`^${LEAD}${escape(who.name)}(?![\\p{L}\\p{N}'’])`, 'iu').test(t)
}

/** The part of the day an opener is chosen for: day from 06:00, dusk from 17:00, night from 20:00. */
export type Daypart = 'day' | 'dusk' | 'night'
export const DAYPARTS: readonly Daypart[] = Object.freeze(['day', 'dusk', 'night'])

/** The part of the day at clock hour `hour` (any number; one that is not finite counts as day). */
export function daypartOf(hour: number): Daypart {
  if (!Number.isFinite(hour)) return 'day'
  const h = ((hour % 24) + 24) % 24
  return h >= 6 && h < 17 ? 'day' : h >= 17 && h < 20 ? 'dusk' : 'night'
}

/**
 * The first thing a person says when the player starts a conversation by key, pad or tap, by role and part of the
 * day. Slots: {skill}, {skill2}, {a skill} (the skill with its article) and, for crew alone, {name}.
 */
export const OPENERS: Readonly<Record<TalkRole, Readonly<Record<Daypart, readonly string[]>>>> = Object.freeze({
  stranger: Object.freeze({
    day: Object.freeze([
      "Hey. Didn't see you there. What's on your mind?",
      'Hi there. Most folks walk right past me. What can I do for you?',
      'Hello. I do {skill} work, some {skill2} when it pays.',
      "You look like you've got a question. Go on, I'm listening.",
    ]),
    dusk: Object.freeze([
      "Evening coming on. I'm about done with {skill} for today. What's up?",
      "The lights are coming up. You look like you've got a question.",
      "Hey. Long day of {skill2}, but I've got a minute.",
    ]),
    night: Object.freeze([
      "Late to be out walking. {skill} keeps me up too. What's on your mind?",
      'Quiet hours. Just me, the street and some {skill} on my mind.',
      'Night owl too? I keep odd hours. {skill} does that to a person.',
    ]),
  }),
  recruit: Object.freeze({
    day: Object.freeze([
      "You called for {skill}? Here I am. What's the plan?",
      "Heard you wanted {a skill} hand. I'm listening.",
      'Here, as asked. {skill} is my trade, {skill2} on a good day.',
    ]),
    dusk: Object.freeze([
      'Evening. You asked for {skill}, so I came. What now?',
      "The light's going and I'm still on the clock for you. Talk to me.",
      "I'm here. {skill} at your service, while the day lasts.",
    ]),
    night: Object.freeze([
      'Late call, but I came. {skill} keeps no hours.',
      'Night shift, then. What do you have for {a skill} hand?',
      "I'm here. The street is quiet, so talk freely.",
    ]),
  }),
  crew: Object.freeze({
    day: Object.freeze([
      '{name} here. Ready when you are.',
      "Boss. {name}, checking in. What's the word?",
      'Hey. {name} on hand, {skill} sharp.',
    ]),
    dusk: Object.freeze([
      'Evening, boss. {name}, still on the clock.',
      "{name} here. The light's fading, but I'm not.",
      "Dusk already. {name}, at your side. What's next?",
    ]),
    night: Object.freeze([
      'Late one, boss. {name} is still with you.',
      "{name} here. The night's young. What's on your mind?",
      'Quiet night. {name}, listening.',
    ]),
  }),
})

/** What anyone says when the player asks for a change to the city: that is Sloane's to make, by her name. */
const CITY_LINES: readonly string[] = Object.freeze([
  "That's Sloane's department. Say her name first, she'll sort it.",
  'Not my call. Sloane runs that side of things, just ask her.',
  "Out of my hands. Start with Sloane's name and she'll hear you.",
])

/**
 * What a person says without a model, by role and intent, at least three variants each. Slots: {skill}, {skill2},
 * {a skill} and {a skill2} (with their article) and, for crew alone, {name}. A `refused` line is a neutral deflection: it neither repeats nor answers what was refused.
 */
export const LINES: Readonly<Record<TalkRole, Readonly<Record<Intent, readonly string[]>>>> = Object.freeze({
  stranger: Object.freeze({
    greet: Object.freeze([
      'Hey yourself. Doing fine, all things told.',
      'Hi. Good to meet someone who stops to talk.',
      "Hello. The street's busy, but I've got a minute.",
      'Hey. Getting by, same as everyone.',
    ]),
    who: Object.freeze([
      'Just a face in the crowd. I do {skill}, and some {skill2}.',
      "Nobody you'd know. {skill} by day, {skill2} when I can.",
      'Someone who keeps {skill} running and keeps their head down.',
    ]),
    work: Object.freeze([
      '{skill}, mostly. Some {skill2} when the work is slow.',
      'I keep {skill} things working. Nobody notices until they break.',
      'A little {skill}, a little {skill2}. It pays the rent.',
      '{skill} work. Quiet, careful, and never quite done.',
    ]),
    help: Object.freeze([
      "I can't walk with you, I've got my own day. Want {a skill} hand? Ask around for one by name.",
      'Not much I can do from here. Ask Sloane, she runs things.',
      "Something to get done? Say Sloane's name first, she'll sort it.",
    ]),
    city: CITY_LINES,
    thanks: Object.freeze([
      'Any time.',
      "Don't mention it.",
      'Glad to help, such as it was.',
    ]),
    bye: Object.freeze([
      'See you around.',
      'Take it easy out there.',
      'So long. Mind the crossings.',
    ]),
    other: Object.freeze([
      "Can't say I follow. Ask me about my work, if you like.",
      "Hm. That one's past me. I mostly know {skill}.",
      'You lost me there. Try me on {skill} or {skill2}.',
    ]),
    refused: Object.freeze([
      'Not my kind of talk. Ask me about the work.',
      "I'll leave that one alone. Anything else?",
      "Let's keep it friendly. What else is on your mind?",
    ]),
  }),
  recruit: Object.freeze({
    greet: Object.freeze([
      'Hey again. Still here, still listening.',
      "Hi. You've got my attention.",
      "Hello. I'm right here, say the word.",
    ]),
    who: Object.freeze([
      'The {skill} hand you called over. {skill2} too, if it comes up.',
      'Someone who heard you ask for {skill} and came.',
      'Just {a skill} type who answered the call.',
    ]),
    work: Object.freeze([
      "{skill} is what I bring. {skill2} if you're short.",
      "Point me at {skill} work and I'll get to it. Sloane hands out the jobs.",
      'I do {skill}. Sloane sets the jobs, I just turn up.',
    ]),
    help: Object.freeze([
      "I'm already with you. For a job, tell Sloane and she'll pass it on.",
      'I go where you go. Sloane is the one who hands out work.',
      'Want another {skill} hand? Ask around for one by name.',
    ]),
    city: CITY_LINES,
    thanks: Object.freeze([
      "That's what I'm here for.",
      'No trouble at all.',
      'Happy to.',
    ]),
    bye: Object.freeze([
      "I'll be close by.",
      'Right behind you.',
      "Call if you want me. I won't be far.",
    ]),
    other: Object.freeze([
      "Not sure I follow. I'm better on {skill}.",
      "That's beyond me. Ask me about {skill} or {skill2}.",
      'Lost me there. Give it to me plain.',
    ]),
    refused: Object.freeze([
      'Not my kind of talk. Ask me about the work.',
      "I'll let that one pass. What's the plan?",
      "Let's keep it friendly. What else?",
    ]),
  }),
  crew: Object.freeze({
    greet: Object.freeze([
      'Hey, boss. {name} here.',
      'Hi. Still with you.',
      'Hello again. {name}, at your side.',
    ]),
    who: Object.freeze([
      '{name}. You took me on, remember? {skill}, mostly.',
      "It's {name}. {skill} and {skill2}, on your side.",
      '{name}, your {skill} hand. Same as ever.',
    ]),
    work: Object.freeze([
      "{skill} is my trade. Give Sloane the job and I'll be ready.",
      'I bring {skill}, and some {skill2}. Sloane hands out the work.',
      'Whatever {skill} needs doing. Sloane sets the jobs.',
    ]),
    help: Object.freeze([
      "I'm with you already. For a job, ask Sloane and she'll pass it on.",
      'I stick close. The work itself comes through Sloane.',
      'Short {a skill2} hand? Ask around for one by name.',
    ]),
    city: CITY_LINES,
    thanks: Object.freeze([
      'Any time, boss.',
      "That's the job.",
      'Glad to be useful.',
    ]),
    bye: Object.freeze([
      '{name}, standing by.',
      "I'll be around, boss.",
      "Right here when you want me.",
    ]),
    other: Object.freeze([
      'Not following, boss. Try me on {skill}.',
      "That's past me. Ask Sloane, or ask me about {skill2}.",
      'Hm. Say it another way?',
    ]),
    refused: Object.freeze([
      'Not my kind of talk. Ask me about the work.',
      "I'll let that pass, boss. What's next?",
      "Let's keep it friendly. Anything else?",
    ]),
  }),
})

/** The line each role falls back to when a filled line would fail the screen or read as a request: fixed, no slots. */
export const FALLBACK: Readonly<Record<TalkRole, string>> = Object.freeze({
  stranger: 'Hm. Let me think on that.',
  recruit: 'Give me a second on that one.',
  crew: 'Let me think on that, boss.',
})

/** The article a skill takes when it is said: 'an Audio hand', 'a Rust hand' ('a C++', 'a WGSL': said by letter). */
const article = (skill: string) => (/^[aeiou]/i.test(skill) ? 'an' : 'a')

/** `line` with its slots filled for `who`: {skill}, {skill2}, {name}, and {a skill} or {a skill2} with its article. */
export function fillLine(line: string, who: TalkWho): string {
  return line
    .replace(/\{a (skill2?)\}/g, (_, slot: string) => { const s = slot === 'skill2' ? who.skill2 : who.skill; return `${article(s)} ${s}` })
    .replace(/\{skill2\}/g, who.skill2)
    .replace(/\{skill\}/g, who.skill)
    .replace(/\{name\}/g, who.name)
}

/** A filled line as it may be said: the role's fixed line instead when the screen refuses it or it reads as a request. */
function safe(line: string, who: TalkWho): string {
  return screen(line).admissible && parseRequest(line) === null ? line : FALLBACK[who.role]
}

/** The opener `who` says at clock hour `hour`: one of their role's for that part of the day, fixed per person. */
export function openerFor(who: TalkWho, hour: number): string {
  const part = daypartOf(hour)
  const lines = OPENERS[who.role][part]
  return safe(fillLine(lines[(mix(who.row | 0) + 3 * DAYPARTS.indexOf(part)) % lines.length], who), who)
}

/**
 * The ids `lineFor` keeps in a conversation's `used` set are intent × VARIANT_SPAN + variant, so one set serves every
 * intent. No table has this many variants (the tests hold it).
 */
export const VARIANT_SPAN = 16

/**
 * What `who` says for `intent` on conversation turn `turn` without a model. The variant is (mix(row) + turn + 7 ×
 * the intent's index) modulo the variants, stepping on past any this conversation already said (`used`, which this
 * records the choice in). Once every variant of the intent was said, they are free again, except the one said last, so
 * a line is never said twice in a row. Deterministic: the same person, intent, turn and `used` give the same line.
 */
export function lineFor(who: TalkWho, intent: Intent, turn: number, used: Set<number>): string {
  const k = Math.max(0, INTENTS.indexOf(intent))
  const lines = LINES[who.role][INTENTS[k]]
  const n = lines.length
  const base = k * VARIANT_SPAN
  let said = 0
  let last = -1
  for (const id of used) if (id >= base && id < base + n) { said++; last = id - base }
  const full = said >= n
  if (full) for (let v = 0; v < n; v++) used.delete(base + v)
  const start = (mix(who.row | 0) + (Number.isFinite(turn) ? Math.max(0, Math.floor(turn)) : 0) + 7 * k) % n
  for (let s = 0; s < n; s++) {
    const v = (start + s) % n
    if (used.has(base + v) || (full && n > 1 && v === last)) continue
    used.add(base + v)
    return safe(fillLine(lines[v], who), who)
  }
  return FALLBACK[who.role]
}

/** The longest the prompt's framing may be (who the person is and the rules), characters. */
export const PROMPT_MAX = 520
/** The most of what is known about the person the prompt carries, characters (whole lines). */
export const ABOUT_MAX = 300
/** The turns of the conversation the prompt carries, the last one the player's. */
export const PROMPT_TURNS = 4
/** Characters kept from each of those turns. */
export const TURN_CHARS = 200

/** Who the person is, in the prompt's words, after their label. */
function selfLine(who: TalkWho): string {
  if (who.role === 'crew') return `one of the agents they took on, good at ${who.skill} and ${who.skill2}`
  if (who.role === 'recruit') return `${article(who.skill)} ${who.skill} hand they asked over, also good at ${who.skill2}`
  return `a passer-by who works in ${who.skill} and ${who.skill2}`
}

/** What the person cannot do from a conversation, and who can. */
function limits(who: TalkWho): string {
  return who.role === 'stranger'
    ? 'You cannot change the city, follow them or do work for them; for that they ask Sloane.'
    : 'You already walk with them, but you cannot change the city or take on work by talking; for that they ask Sloane.'
}

const oneLine = (s: string) => String(s ?? '').replace(/\s+/g, ' ').trim()

/**
 * The prompt a model is given to answer as `who` (the conversation's system prompt stays the page's own TALK_PROMPT;
 * the persona is all here). The framing says who they are and the rules: plain and brief, a light noir tone, one to
 * three short sentences, no lists, no ACTION line, nothing changed, followed or done for the player (Sloane does
 * that), nothing known of the news or the weather. It is at most PROMPT_MAX characters. Then what is known about them
 * (`about`, the lines 08_Swarm/shortTerm.ts contextLines gives; whole lines, at most ABOUT_MAX characters), then the
 * last PROMPT_TURNS turns, each at most TURN_CHARS, as 'Person:' and their name, ending with their name for the model to
 * go on from.
 */
export function personPrompt(who: TalkWho, about: readonly string[], turns: readonly { readonly who: 'you' | 'them'; readonly text: string }[]): string {
  const frame = [
    `You are ${who.label}, ${selfLine(who)}, a person in Crimson Noir: Agent City. The person walking through has stopped to talk with you.`,
    `Talk as yourself: plain, brief, a light noir tone, one to three short sentences, no lists. ${limits(who)} Never write an ACTION line. You know nothing of the news or the weather.`,
  ]
  const known: string[] = []
  let spent = 0
  for (const raw of about) {
    const line = oneLine(raw).slice(0, ABOUT_MAX - 1)
    if (!line) continue
    if (spent + line.length + 1 > ABOUT_MAX) break
    known.push(line)
    spent += line.length + 1
  }
  const said = turns.slice(-PROMPT_TURNS).map((t) => `${t.who === 'you' ? 'Person' : who.name}: ${oneLine(t.text).slice(0, TURN_CHARS)}`)
  return [...frame, ...(known.length ? ['What is known about you:', ...known] : []), ...said, `${who.name}:`].join('\n')
}
