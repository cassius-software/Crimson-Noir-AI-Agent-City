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
  | 'sound-root' | 'feel' | 'perf-root' | 'crossing' | 'look-roads' | 'on-foot' | 'by-car' | 'anywhere'

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
  return text.slice(0, 1024).normalize('NFKC').toLowerCase().replace(/[’‘`´]/g, "'").replace(/[^a-z0-9:'%]+/g, ' ').replace(/\s+/g, ' ').trim()
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
  // ask never takes the half gigabyte Peak's shadows need. Before the Ultra rule, which would read "beyond ultra".
  one(/\bpeak (?:quality|graphics|settings|detail|fidelity)\b|\b(?:above|beyond|past) ultra\b/, 'quality', PEAK_TIER, 1, 'fidelity'),
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

/** Keeps the stronger reading of a control; among equals the first. A value is never lost to a reading
 *  without one ("noisy roads" stays fewer cars). */
function mergeHyp(hyps: Hyp[], h: Hyp): void {
  const i = hyps.findIndex((x) => x.control === h.control)
  if (i < 0) { hyps.push(h); return }
  const old = hyps[i]
  if (h.confidence > old.confidence) hyps[i] = h.value === undefined && old.value !== undefined ? { ...h, value: old.value } : h
  else if (old.value === undefined && h.value !== undefined) hyps[i] = { ...old, value: h.value }
}

function analyze(input: string): Analysis {
  let text = normalize(input)
  const tags = new Set<Tag>()
  const unmapped: Unmapped[] = []
  const hyps: Hyp[] = []
  const consume = (m: RegExpExecArray) => { text = `${text.slice(0, m.index)}${' '.repeat(m[0].length)}${text.slice(m.index + m[0].length)}` }
  const harm = HARM.test(text)
  for (const u of UNSUPPORTED) {
    const m = u.re.exec(text)
    if (m) { unmapped.push({ label: u.label, modules: u.modules }); consume(m) }
  }
  let unsure = false
  const unsureMatch = UNSURE.exec(text)
  if (unsureMatch) { unsure = true; consume(unsureMatch) }
  if (!harm) {
    for (const r of RULES) {
      const m = r.re.exec(text)
      if (!m) continue
      consume(m)
      for (const e of r.emit) {
        const value = typeof e.value === 'function' ? e.value(m) : e.value
        if (typeof e.value === 'function' && value === undefined) continue
        if (e.tag) tags.add(e.tag)
        mergeHyp(hyps, { control: e.control, value, confidence: e.confidence, at: m.index, derived: false })
      }
    }
  }
  hyps.sort((a, b) => b.confidence - a.confidence || a.at - b.at)
  const flag: Flag = harm ? 'harm' : hyps.length ? 'none' : unsure ? 'unsure' : 'unmapped'
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

/** Free text in an answer can name a control outright ("fewer people"): it joins the frame. */
function absorb(f: Frame, answer: string, derived: boolean): Control[] {
  const a = analyze(answer)
  for (const h of a.hyps) put(f, h.control, h.value, h.confidence, derived)
  for (const t of a.tags) f.tags.add(t)
  for (const u of a.unmapped) if (!f.unmapped.some((x) => x.label === u.label)) f.unmapped.push(u)
  return a.hyps.map((h) => h.control)
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
    key: 'quality.value',
    when: (f) => has(f, 'quality') && find(f, 'quality')?.value === undefined && !any(f, 'performance', 'fidelity'),
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
    when: (f) => has(f, 'quality') && f.tags.has('fidelity') && !any(f, 'detail', 'light'),
    ask: () => ({ question: 'Is it sharper detail you’re after, or the light and the sky?', options: ['Sharper detail', 'The light', 'Both'] }),
    resolve: (a, f) => {
      const k = pick(a, [BOTH, ['light', 'the light', 'light', 'sky', 'sun', 'rays', 'shafts', 'golden', 'atmosphere', 'mood'], ['detail', 'sharper detail', 'sharper', 'detail', 'sharp', 'crisp', 'resolution', 'textures']])
      const light = () => { f.tags.add('light'); if (find(f, 'time')?.value === undefined) put(f, 'time', 17.4, 1, true) }
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
    if (!p) { absorb(this.frame, a, false); return }
    this.pending = null
    this.frame.asked.add(p.probe.key)
    this.whys.push({ question: p.step.question, answer: a })
    p.probe.resolve(a, this.frame)
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
