// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the first-run walk as pure data and timing: the six things a brand-new visitor does
 * before the city is theirs (turn the head and walk; tell Sloane a goal; get into a parked car; step inside a
 * workplace; choose a look in the wardrobe or a shop, or read a home's deed; open the console), what counts as having
 * done each one (a reading of the page, or an event the page reports), and what Sloane says at each: the thing to do in
 * the visitor's own device's words, what it is in words a five-year-old follows, and the five W's (who, what, when,
 * where and why), each answered as plainly, every one of them true of the city as it runs today. The walk is held only until the visitor
 * reaches the console: the moment it opens on the last stage the city is theirs and the pass is kept. A visitor who
 * stalls is never left alone: after a few seconds with nothing done the walk lends a hand (`assisting`: the card shows
 * the keys and offers its one-tap button, the page lights the control to use), and later Sloane says the how again.
 * The console's Crimson Noir Script exit program (terminal/noirscript: verify_ring0, spawn_subagents, unlock_city) ends the
 * walk from any stage, for the visitor who already knows the way. Sloane calls it "your first walk"; the words
 * "tutorial", "lesson" and "step" never appear in a spoken line. Like the quiet watch beside it (tutorial.ts Mentor)
 * this reads the simulation and never writes to it, and every moment comes from the clock values it is given, never
 * from Date.now, so a test can walk the six stages in a microsecond. The React side
 * (07_Execute_Actions/onboarding/useFirstWalk.ts, FirstWalk.tsx) feeds it and shows it.
 * The look stage teaches what the city has for it: the wardrobe card (Customizer.tsx), on a map with shops
 * (01_Initialize_World/storefronts.ts) the shops' cards (StoreCard.tsx), and on a map with homes
 * (01_Initialize_World/properties.ts) a home's doorstep card (HomeCard.tsx); any one of them put away after it was open
 * finishes it, so its place in the order and the exit stay as they are.
 * What breaks if it is removed? The first run has no stages, no words and no notion of having been passed.
 */
import type { InputFamily } from './tutorial.ts'

export type { InputFamily } from './tutorial.ts'

/** The six stages, in order; the last one, the console, is where the walk ends. */
export type Stage = 'move' | 'voice' | 'fleet' | 'work' | 'style' | 'console'
export const STAGES: readonly Stage[] = Object.freeze(['move', 'voice', 'fleet', 'work', 'style', 'console'])

/** How patient the walk is, ms, and what counts. */
export const WALK = Object.freeze({
  /** A stage with nothing done for this long, and the walk lends a hand: the keys on the card, its button offered, the control lit. */
  assistMs: 8_000,
  /** A stage with no progress for this long, and Sloane says the how again, more plainly (once a stage). */
  hintMs: 20_000,
  /** The least time between two of Sloane's unasked lines. */
  cooldownMs: 20_000,
  /** Looking around: this much turn of the head counts, radians (about 20 degrees). */
  lookRadians: 0.35,
  /** Walking: this much ground counts, metres. */
  walkMetres: 3,
} as const)

/** The role the exit program names and the swarm it asks for (docs/crimson-noir-script.md, the exam intrinsics). */
export const SWARM_ROLE = 'sim2real_workplaces'
export const SWARM_SIZE = 24

/** The exit program, one console line each (typed after `noir `; the session keeps `seal` and `swarm` between lines): it ends the walk from any stage. */
export const PROGRAM: readonly string[] = Object.freeze([
  'let seal = verify_ring0();',
  `let swarm = spawn_subagents(${SWARM_SIZE}, "${SWARM_ROLE}");`,
  'unlock_city(seal, swarm);',
])

/** The device's own words for the controls the walk names (07_Execute_Actions/glyphs.ts gives them per family). */
export interface ControlWords {
  /** The walking control: 'W A S D', 'L', 'Stick'. */
  move: string
  /** The looking control: 'Mouse', 'R', 'Drag'. */
  look: string
  /** The enter-vehicle control: 'E', 'A', 'Enter car'. */
  interact: string
  /** The console key: '~' (touch opens it from the Menu). */
  console: string
}

/** The nearest workplace from where the visitor stands, for the hint. */
export interface WalkPlace { readonly name: string; readonly metres: number; readonly bearing: string }

export interface FirstWalkOptions {
  family: InputFamily
  words: ControlWords
  /** The visitor's name, or '' (Sloane then says nothing in its place). */
  name?: string
  /**
   * Whether this map has cars to get into and rooms to walk into (a surveyed region has no rooms), whether the page has
   * the wardrobe card (absent counts as present), whether the map has shops to walk into and whether it has homes for
   * sale (each absent counts as none: the city's five shops and seven homes, Lakefront Metro's up to five and up to
   * seven, a surveyed region's none): a stage with nothing to do is passed over, and Sloane names the shops and the homes
   * only where there are some.
   */
  city: { fleet: boolean; rooms: boolean; wardrobe?: boolean; stores?: boolean; homes?: boolean }
  /** The nearest workplace, asked when the hint for the indoor stage is said; null or absent when there is none. */
  place?: () => WalkPlace | null
  /** Stages already done (a reload mid-walk; nothing is kept unless the walk was passed, so usually none). */
  done?: readonly Stage[]
  assistMs?: number
  hintMs?: number
  cooldownMs?: number
}

/** A reading of the page, as the hook takes it from the HUD's snapshot a few times a second. */
export interface WalkReading {
  x: number
  z: number
  /** The head's yaw, radians. */
  yaw: number
  /** Metres walked and driven so far. */
  travelled: number
  /** At the wheel of a car. */
  driving: boolean
  /** Standing inside one of the workplaces. */
  inside: boolean
  /** The Ring-0 console is open. */
  consoleOpen: boolean
}

/**
 * An event the page reports outright: a goal told to Sloane, the microphone opened, the captions turned, a car
 * entered, a room entered, the wardrobe card, a shop's card or a home's doorstep card put away after it was opened, the
 * console opened or a line run there, and the exit program's three doors as the console's exam reports them (a seal
 * checked, a swarm called, the city unlocked).
 */
export type WalkEvent = 'goal' | 'mic' | 'captions' | 'vehicle' | 'inside' | 'wardrobe' | 'store' | 'home' | 'console' | 'seal' | 'swarm' | 'unlock'

/** One of Sloane's lines: at a stage's start (the thing to do), as a hint, or when the walk is passed. */
export interface Beat {
  readonly id: number
  readonly stage: Stage
  readonly kind: 'ask' | 'hint' | 'passed'
  readonly text: string
  /** The words a model's rewording must keep (a key, a button, a command). */
  readonly keep: readonly string[]
}

/** What the card shows for a stage. */
export interface StageCard {
  readonly stage: Stage
  /** 1-based, of `count`. */
  readonly index: number
  readonly count: number
  readonly title: string
  /** The one thing to do, in the device's words. */
  readonly ask: string
  /** What this is, explained as to a five-year-old. */
  readonly eli5: string
  /** The five W's (who, what, when, where, why), each answered in a five-year-old's words. */
  readonly ws: readonly FiveW[]
  /** The accessible path's button: what Sloane does for a visitor who cannot do the action themselves. */
  readonly show: string
}

/** What the visitor does to turn the head and walk, in their own device's words. */
function lookHow(o: FirstWalkOptions): { text: string; keep: string } {
  switch (o.family) {
    case 'keyboard': return { text: 'hold the mouse button down and drag', keep: 'drag' }
    case 'pad': return { text: `push the ${o.words.look} stick`, keep: o.words.look }
    case 'touch': return { text: 'drag one finger across the screen', keep: 'drag' }
  }
}
function walkHow(o: FirstWalkOptions): { text: string; keep: string } {
  switch (o.family) {
    case 'keyboard': return { text: `walk a few steps with ${o.words.move} or the arrow keys`, keep: o.words.move }
    case 'pad': return { text: `walk a few steps with the ${o.words.move} stick`, keep: o.words.move }
    case 'touch': return { text: 'walk a few steps with the stick in the corner', keep: 'stick' }
  }
}
function pressHow(o: FirstWalkOptions, action: string): string {
  return o.family === 'touch' ? `tap ${action}` : `press ${action}`
}
const tap = (o: FirstWalkOptions): string => (o.family === 'touch' ? 'Tap' : 'Click')
/** How a shop's card opens from inside the shop: B on a keyboard (E too, with no car near), the face button that enters a car on a pad, the Browse chip on touch. */
function browseHow(o: FirstWalkOptions): string {
  switch (o.family) {
    case 'keyboard': return 'press B'
    case 'pad': return `press ${o.words.interact}`
    case 'touch': return 'tap Browse'
  }
}
/** How a home's doorstep card opens from inside the home: the shop's keys (B, E with no car near; the pad's enter button), and on touch the chip, which reads For sale. */
function doorstepHow(o: FirstWalkOptions): string {
  return o.family === 'touch' ? 'tap For sale' : browseHow(o)
}

/**
 * Where the visitor's eye should go while the walk lends a hand: the control the stage asks for, lit on the page
 * (App.tsx sets it on the root as `data-walk-assist`; index.css draws the ring). The touch stick, Sloane's chip, the
 * touch Enter car button, the Look word on her chip, the touch Menu (whose first item is Console); null where the
 * thing to use is a key or a place, which the card's keys and the walk's marker show instead.
 */
export type AssistTarget = 'stick' | 'chip' | 'enter' | 'look' | 'menu'
export function assistTargetOf(s: Stage, family: InputFamily): AssistTarget | null {
  switch (s) {
    case 'move': return family === 'touch' ? 'stick' : null
    case 'voice': return 'chip'
    case 'fleet': return family === 'touch' ? 'enter' : null
    case 'work': return null
    case 'style': return 'look'
    case 'console': return family === 'touch' ? 'menu' : null
  }
}

/** The controls a stage asks for, in glyph names (07_Execute_Actions/glyphs.ts): the card draws them as keys while it lends a hand. */
export type AssistControl = 'look' | 'move' | 'interact' | 'console'
export function assistControlsOf(s: Stage): readonly AssistControl[] {
  switch (s) {
    case 'move': return LOOK_MOVE
    case 'fleet': return INTERACT
    case 'console': return CONSOLE
    default: return NONE
  }
}
const LOOK_MOVE: readonly AssistControl[] = Object.freeze(['look', 'move'])
const INTERACT: readonly AssistControl[] = Object.freeze(['interact'])
const CONSOLE: readonly AssistControl[] = Object.freeze(['console'])
const NONE: readonly AssistControl[] = Object.freeze([])

/** The card's offer while it lends a hand (shown beside the keys, not spoken: Sloane's spoken hint comes later). */
export function assistLine(s: Stage, o: Pick<FirstWalkOptions, 'family'>): string {
  const button = o.family === 'touch' ? 'tap the button below' : 'use the button below'
  switch (s) {
    case 'fleet': return `Want a hand? Follow the marker to a parked car, or ${button} and I’ll take you there.`
    case 'work': return `Want a hand? Follow the marker to a doorway, or ${button} and I’ll take you in.`
    default: return `Want a hand? ${button.charAt(0).toUpperCase()}${button.slice(1)} and I’ll do it for you.`
  }
}

/** A number in words, for the few the lines say. */
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four']
export const inWords = (n: number): string => WORDS[n] ?? String(n)

/** Whether a stage exists on this map: no cars means nothing to get into, no rooms nothing to walk into, no wardrobe, no shop and no home nothing to choose. */
export function available(s: Stage, city: FirstWalkOptions['city']): boolean {
  switch (s) {
    case 'fleet': return city.fleet
    case 'work': return city.rooms
    case 'style': return city.wardrobe !== false || city.stores === true || city.homes === true
    case 'move': case 'voice': case 'console': return true
  }
}

/** The title of a stage, as the card's header shows it. */
export function titleOf(s: Stage): string {
  switch (s) {
    case 'move': return 'Look and walk'
    case 'voice': return 'Talk to Sloane'
    case 'fleet': return 'The parked fleet'
    case 'work': return 'Inside a workplace'
    case 'style': return 'Your look'
    case 'console': return 'The console'
  }
}

/** The accessible path's button, per stage. */
export function showOf(s: Stage): string {
  switch (s) {
    case 'move': return 'Walk for me'
    case 'voice': return 'Plan one for me'
    case 'fleet': return 'Take me to a car'
    case 'work': return 'Take me inside'
    case 'style': return 'Open the wardrobe'
    case 'console': return 'Open the console'
  }
}

/** Sloane's line at a stage's start: the one thing to do, in the device's words, and the words a rewording must keep. */
export function askFor(s: Stage, o: FirstWalkOptions): { text: string; keep: readonly string[] } {
  const name = o.name?.trim() ? `, ${o.name.trim()}` : ''
  switch (s) {
    case 'move': {
      const l = lookHow(o), w = walkHow(o)
      return { text: `Welcome in${name}. Let’s start with your eyes and your feet: ${l.text} and the whole view turns with you; then ${w.text}.`, keep: [l.keep] }
    }
    case 'voice':
      return { text: `Now talk to me${name}. ${tap(o)} my name on the chip and tell me a goal in your own words, like “make it night”. I may ask a few questions to be sure what you mean, then I do what can be done now.`, keep: ['chip'] }
    case 'fleet':
      return { text: `See the cars? Find one that is parked, stand right by its door until a prompt appears, and ${pressHow(o, o.words.interact)} to get in. Drive a little; the car will not let you hurt anyone.`, keep: [o.words.interact] }
    case 'work':
      return { text: 'Now go indoors. Sixteen workplaces have open doors on the street, from a robotics lab, a warehouse and a kitchen to a greenhouse, a control tower and a server vault. Step through any one of them.', keep: ['door'] }
    case 'style': {
      const shops = o.city.stores === true ? ` Or walk into one of the shops on the street and ${browseHow(o)} to try its lines on; trying on is free.` : ''
      const homes = o.city.homes === true ? ` Or step into a home for sale, a glass room on its own lot, and ${doorstepHow(o)} to read its deed; the smallest is free to claim.` : ''
      return { text: `Now choose how you look${name}. ${tap(o)} Look at the end of my chip: pick your clothes and their colours, your hair, your skin, your face and your build, then press Done.${shops}${homes}`, keep: ['Look', 'Done'] }
    }
    case 'console':
      if (o.family === 'touch') return { text: `Last one${name}, and then the city is yours. Open the Menu in the corner and tap Console: the city’s command line, where the city answers to typed words. The moment it opens, everything here is open to you.`, keep: ['Menu', 'Console'] }
      // A pad has no ~ key: its own menu opens the console too, and the on-screen keys rise with it to type on.
      if (o.family === 'pad') return { text: `Last one${name}, and then the city is yours. Open the console with the button on this card, or press ${o.words.console} and choose Console: the city’s command line, where the city answers to typed words, on keys that rise with it. The moment it opens, everything here is open to you.`, keep: ['console'] }
      return { text: `Last one${name}, and then the city is yours. Press the ${o.words.console} key to open the console: the city’s command line, where the city answers to typed words. The moment it opens, everything here is open to you.`, keep: [o.words.console] }
  }
}

/** Sloane's hint for a stage with no progress: the how again, more plainly. */
export function hintFor(s: Stage, o: FirstWalkOptions): { text: string; keep: readonly string[] } {
  switch (s) {
    case 'move': {
      const l = lookHow(o), w = walkHow(o)
      return { text: `Nothing has moved yet. First ${l.text}, then ${w.text}; three steps is plenty.`, keep: [l.keep] }
    }
    case 'voice':
      return { text: `My chip is the small card with my name on it. ${tap(o)} it, choose a goal, type a few words and send them; “make it night” works.`, keep: ['chip'] }
    case 'fleet':
      return { text: `Cars park along the kerbs. Walk up to one until the prompt appears at the bottom of the screen, then ${pressHow(o, o.words.interact)}; the button on this card takes you to the nearest one.`, keep: [o.words.interact] }
    case 'work': {
      const p = o.place?.() ?? null
      const where = p ? `The nearest is ${p.name}, about ${Math.max(1, Math.round(p.metres))} metres to the ${p.bearing}; its door faces the street.` : 'A workplace is a low building with a wide open doorway on the street.'
      return { text: `${where} Walk through the doorway and stop inside; the button on this card takes you there.`, keep: ['doorway'] }
    }
    case 'style': {
      const shops = o.city.stores === true ? ` A shop works too: walk in, ${browseHow(o)}, and press Done when you have looked.` : ''
      const homes = o.city.homes === true ? ` So does a home: step inside, ${doorstepHow(o)}, and press Done when you have read its deed.` : ''
      return { text: `Look is the small word at the end of my chip. ${tap(o)} it, change anything you like or nothing at all, and press Done.${shops}${homes} The button on this card opens the wardrobe for you.`, keep: ['Look', 'Done'] }
    }
    case 'console':
      if (o.family === 'touch') return { text: 'The Menu is the button marked Menu in the corner. Tap it, then tap Console at the top of the list; the button on this card opens it too.', keep: ['Menu', 'Console'] }
      if (o.family === 'pad') return { text: `The button on this card opens the console; so does ${o.words.console}, then Console, with keys that rise with it. On a keyboard it is the key left of 1, under Esc.`, keep: ['console'] }
      return { text: `The ${o.words.console} key is the one left of 1, under Esc. Press it once and the console drops down from the top of the screen; the button on this card opens it too.`, keep: [o.words.console] }
  }
}

/**
 * What a stage is, explained as to a five-year-old: two or three short sentences in small words, all true of the city
 * as it runs; the look stage names the shops and the homes only on a map that has them (`city.stores`, `city.homes`).
 */
export function eli5Of(s: Stage, city?: FirstWalkOptions['city']): string {
  switch (s) {
    case 'move': return 'This is you, in the city. Turn your head to look around, and walk to go somewhere. The picture goes where you go.'
    case 'voice': return 'I’m Sloane, the city’s helper. Tell me what you want in your own words, and I’ll do what I can.'
    case 'fleet': return 'The city has cars. Find a parked one, get in and drive. Your car will never hurt anyone.'
    case 'work': return 'The people of the city have jobs. Walk through an open door and watch them at work.'
    case 'style': return `You choose how you look: your clothes, your hair, your skin, your face and your shape.${city?.stores === true ? ' Shops on the street sell clothes too, and trying them on is free.' : ''}${city?.homes === true ? ' You can even have a home: the homes on the street are for sale, and the smallest one is free.' : ''}`
    case 'console': return 'The console is where you type to the city. Type a word, press Enter, and the city answers.'
  }
}

/** The five W's, in the order the card asks them. */
export const FIVE_WS = Object.freeze(['Who', 'What', 'When', 'Where', 'Why'] as const)
export type W = (typeof FIVE_WS)[number]
/** One of the five W's of a stage: the question word and its answer. */
export interface FiveW { readonly w: W; readonly answer: string }

/**
 * The five W's of a stage (who, what, when, where, why), each answered in a five-year-old's words, and nothing in them
 * that the city does not do (the shops only where `city.stores`, the homes only where `city.homes`).
 */
export function fiveWsOf(s: Stage, city?: FirstWalkOptions['city']): readonly FiveW[] {
  const shops = city?.stores === true
  const homes = city?.homes === true
  return Object.freeze(answersOf(s, shops, homes).map((answer, i) => Object.freeze({ w: FIVE_WS[i]!, answer })))
}

/** The answers to who, what, when, where and why, in that order. */
function answersOf(s: Stage, shops: boolean, homes: boolean): readonly string[] {
  switch (s) {
    case 'move': return [
      'You. You are a person in this city, standing on the street like everyone else, not a camera floating in the sky.',
      'Looking and walking. Turn your head and the whole picture turns with you; walk, and you move through the city.',
      'Right now, and any time after. There is no rush: if nothing happens for a few seconds, I show you which control to use.',
      'Anywhere on the streets and pavements, and in through any open door.',
      'Because everything else in the city is somewhere, and you have to get there first.',
    ]
    case 'voice': return [
      'Me, Sloane, the city’s concierge. That is a grown-up word for a helper who looks after visitors like you.',
      'A goal, in your own words, like “make it night”. I may ask you a few questions to be sure what you mean, then I change what I can, like the time of day, the picture or the sound, and write the rest down for you.',
      'Whenever you want me. I am on my chip during this walk, and after it too.',
      'On my chip: the small card with my name on it. Open it and tell me there.',
      'Because the city is yours to direct, and that starts with me understanding what you want.',
    ]
    case 'fleet': return [
      'The people of the city, and you. Cars of eight kinds drive, park and wait for a driver, and flying craft hop between pads on the rooftops.',
      'A car you can drive. Before any car moves, it checks the city’s First Law: if a person is in the way, it stops. Yours keeps people safe too: while you drive, it passes right through them, and nobody is pushed.',
      'When a car is parked. A parked car stays where it is until someone stands at its door and gets in; nobody drives off in one on their own.',
      'Along the kerbs, where cars park. Stand right by a door until a prompt appears at the bottom of the screen, then do what it says.',
      'Because it shows the city keeps its promise: the law sits under every wheel, so nobody gets hurt, and a readout counts every time a law steps in.',
    ]
    case 'work': return [
      'The people of the city, at work. Some of them are agents: computer helpers that do real work, reading and answering, not pretending.',
      'Jobs. They type, check things and talk at their stations, by a bench, a table or a bed, and the HUD counts who is at work.',
      'Whenever you ask the city for something: the job ends up at a station like these, and you can walk in and watch it being done.',
      'In sixteen kinds of workplace with open doors on the street, from a robotics lab, a warehouse and a kitchen to a greenhouse, a control tower and a server vault.',
      'Because every job needs a place to be done. A robot, real or make-believe, can drive a body here too, over the joint bridge: this is where the make-believe and the real meet.',
    ]
    case 'style': return [
      'You, and everyone else. Everyone on the street is dressed from the same wardrobe as you, and each person gets their own look, across all ten skin tones, with freckles on some and vitiligo on a few. Your own agents get a tab each, with a voice and a look.',
      'Your look: your clothes and their colours, your hair, skin, face and build. It all comes from the city’s own business-casual wardrobe: suits, smart casual, pantsuits and skirt suits, with a jacket, shirt sleeves or a coat.',
      'Any time. Look, at the end of my chip, opens the wardrobe during this walk and after it. Your look has a short code, so you can take it to another device or give it to a friend.',
      `On the wardrobe card, which draws you just as you look on the street.${shops ? ' In a shop, while its card is open, the camera steps out and circles you like a mirror (not in a headset or a shared room).' : ''}${homes ? ' Inside a home for sale, its doorstep card shows the deed: the paper that says who owns it.' : ''}`,
      `Because the city is yours, so you should look like you. Only the city’s own wardrobe can be worn: no typed word${shops ? ', no shared code and no shop' : ' and no shared code'} can dress anyone in anything else.${homes ? ' A home works the same way: its deed is one line in the city’s catalogue, kept in one place, so every card agrees on what is yours.' : ''}`,
    ]
    case 'console': return [
      'You and the city. You type the words, and the city answers: the clock, the people, the cars, and the kernel underneath it all.',
      'A command line: a place to tell the computer exactly what you mean, in words. help lists every command, and the console has its own language too, Crimson Noir Script: type noir and a line to try it.',
      'Now, to finish this walk: the moment the console opens, the whole city is yours. After that, open it whenever you like.',
      'At the top of the screen. It drops down over the city when you open it, and goes away again when you close it.',
      'Because this city is a coding tool you live in, and telling a computer exactly what you mean is what you will do most here. Nothing you type can switch the laws off: underneath, a kernel called Ring-0 holds four laws in rank order, and every car, agent and command goes through them.',
    ]
  }
}

/** The card for a stage. */
export function cardFor(s: Stage, o: FirstWalkOptions): StageCard {
  return Object.freeze({ stage: s, index: STAGES.indexOf(s) + 1, count: STAGES.length, title: titleOf(s), ask: askFor(s, o).text, eli5: eli5Of(s, o.city), ws: fiveWsOf(s, o.city), show: showOf(s) })
}

/** Sloane's line when the city opens. */
export function passedLine(name?: string): string {
  const n = name?.trim() ? `, ${name.trim()}` : ''
  return `The city is yours${n}. Everything you just did, you can do again any time; and I am on the chip whenever you want me.`
}

/** What the console prints when the walk ends: Sloane's line, then where to go from here (its Close button on touch, where there is no Esc). */
export function passedBanner(name?: string, family: InputFamily = 'keyboard'): readonly string[] {
  const away = family === 'touch' ? 'Close puts the console away' : 'Esc closes the console'
  return Object.freeze([
    `Sloane: ${passedLine(name)}`,
    `The city is open: nothing is held back any more. ${away}; help lists every command.`,
  ])
}

/**
 * The walk: told when the visitor is in (`start`), fed readings (`read`) and events (`note`), and asked a few times a
 * second (`tick`) whether there is something to say and whether to lend a hand. A stage is done when its readings or
 * events say so; the walk is passed when the console opens on its last stage, or when the console's exam reports
 * `unlock` (the exit program, from any stage). Everything is timed from the clock values it is given.
 */
export class FirstWalk {
  readonly options: Readonly<FirstWalkOptions>
  readonly #done = new Set<Stage>()
  #started = Number.NaN
  /** The last progress of any kind (the hint's clock). */
  #progress = Number.NaN
  /** When the stage on the card began, or last moved forward (the hand's clock). */
  #since = Number.NaN
  #lastSaid = Number.NaN
  #last: WalkReading | null = null
  #yaw0 = Number.NaN
  #travelled0 = Number.NaN
  #looked = false
  #walked = false
  #seal = false
  #swarm = false
  #passed = false
  #assisting = false
  #said = 0
  #hinted = new Set<Stage>()
  #pending: Beat | null = null

  constructor(options: FirstWalkOptions) {
    this.options = Object.freeze({ ...options, words: Object.freeze({ ...options.words }), city: Object.freeze({ ...options.city }) })
    for (const s of options.done ?? []) this.#done.add(s)
    for (const s of STAGES) if (!available(s, options.city)) this.#done.add(s)
    if (this.#done.has('console')) this.#done.delete('console') // the console is never passed over: it is where the walk ends
  }

  /** The visitor is in: the first stage starts now, and Sloane says it. */
  start(now: number): void {
    if (this.started) return
    this.#started = now
    this.#progress = now
    this.#since = now
    this.#pending = this.#beat('ask', this.stage, askFor(this.stage, this.options))
  }

  get started(): boolean {
    return Number.isFinite(this.#started)
  }

  /** The city is the visitor's: the walk is over. */
  get passed(): boolean {
    return this.#passed
  }

  /** The stage the visitor is on (the console, once every other is done). */
  get stage(): Stage {
    return STAGES.find((s) => !this.#done.has(s)) ?? 'console'
  }

  get done(): ReadonlySet<Stage> {
    return this.#done
  }

  /** What the card shows now. */
  get card(): StageCard {
    return cardFor(this.stage, this.options)
  }

  /** The exit program's doors so far: the seal checked, the swarm called. */
  get exam(): { seal: boolean; swarm: boolean } {
    return { seal: this.#seal, swarm: this.#swarm }
  }

  /** Whether the walk is lending a hand on this stage (assistMs with nothing done on it, as of the last tick). */
  get assisting(): boolean {
    return this.#assisting
  }

  /** How many lines Sloane has said. */
  get said(): number {
    return this.#said
  }

  /** The visitor did something the readings cannot show. */
  note(e: WalkEvent, now: number): void {
    if (!this.started || this.#passed) return
    this.#progress = now
    switch (e) {
      case 'goal': case 'mic': case 'captions': this.#finish('voice', now); break
      case 'vehicle': this.#finish('fleet', now); break
      case 'inside': this.#finish('work', now); break
      case 'wardrobe': case 'store': case 'home': this.#finish('style', now); break
      case 'console': if (this.stage === 'console') this.#pass(); break
      case 'seal': this.#seal = true; break
      case 'swarm': this.#swarm = true; break
      case 'unlock': this.#pass(); break
    }
  }

  /** A reading of the page: a change from the last one is progress, and some readings finish a stage. */
  read(r: WalkReading, now: number): void {
    if (!this.started || this.#passed) return
    const last = this.#last
    this.#last = { ...r }
    if (!last) {
      this.#yaw0 = r.yaw
      this.#travelled0 = r.travelled
      if (r.consoleOpen && this.stage === 'console') this.#pass()
      return
    }
    let active = false
    if (Number.isFinite(r.yaw) && Number.isFinite(this.#yaw0) && Math.abs(turn(r.yaw - this.#yaw0)) >= WALK.lookRadians) {
      if (!this.#looked) { active = true; if (this.stage === 'move') this.#since = now }
      this.#looked = true
    }
    if (Number.isFinite(r.travelled) && Number.isFinite(this.#travelled0) && r.travelled - this.#travelled0 >= WALK.walkMetres) {
      this.#walked = true
      this.#travelled0 = r.travelled
      active = true
      if (this.stage === 'move') this.#since = now
    }
    if (this.#looked && this.#walked) this.#finish('move', now)
    if (r.driving && !last.driving) { active = true; this.#finish('fleet', now) }
    if (r.inside && !last.inside) { active = true; this.#finish('work', now) }
    if (r.consoleOpen && !last.consoleOpen) active = true
    if (active) this.#progress = now
    // The console open on the last stage, however it got there (opened just now, or open already when the stage came).
    if (r.consoleOpen && this.stage === 'console') this.#pass()
  }

  /**
   * Whether this is a moment for Sloane to speak: a stage just started or the walk was just passed (said at once),
   * or the stage has had no progress for hintMs and the last line was cooldownMs ago (one hint per stage). Returns
   * the line (marked as said) or null. It also decides whether the walk lends a hand (`assisting`): assistMs since
   * the stage began or last moved forward.
   */
  tick(now: number): Beat | null {
    if (!this.started) return null
    const o = this.options
    this.#assisting = !this.#passed && now - this.#since >= (o.assistMs ?? WALK.assistMs)
    const p = this.#pending
    if (p) {
      this.#pending = null
      this.#lastSaid = now
      return p
    }
    if (this.#passed) return null
    const s = this.stage
    if (this.#hinted.has(s)) return null
    if (now - this.#progress < (o.hintMs ?? WALK.hintMs)) return null
    if (Number.isFinite(this.#lastSaid) && now - this.#lastSaid < (o.cooldownMs ?? WALK.cooldownMs)) return null
    this.#hinted.add(s)
    this.#lastSaid = now
    return this.#beat('hint', s, hintFor(s, o))
  }

  #beat(kind: Beat['kind'], stage: Stage, line: { text: string; keep: readonly string[] }): Beat {
    this.#said++
    return Object.freeze({ id: this.#said, stage, kind, text: line.text, keep: Object.freeze([...line.keep]) })
  }

  /** A stage is done: the next one starts, and Sloane says it (the console is finished only by `#pass`). */
  #finish(s: Stage, now: number): void {
    if (s === 'console' || this.#done.has(s)) return
    const before = this.stage
    this.#done.add(s)
    this.#progress = now
    // A later stage done early (a car entered while still learning to walk) is kept, and said nothing of until its turn
    // would have come: Sloane speaks only when the stage on the card changes.
    const next = this.stage
    if (next === before) return
    this.#since = now
    this.#assisting = false
    // Arriving at the last stage with the console already open is reaching it: the walk is passed at once.
    if (next === 'console' && this.#last?.consoleOpen === true) { this.#pass(); return }
    this.#pending = this.#beat('ask', next, askFor(next, this.options))
  }

  /** The city is the visitor's: every stage counts as done, the hand is withdrawn, and Sloane says so. */
  #pass(): void {
    if (this.#passed) return
    this.#passed = true
    this.#assisting = false
    for (const s of STAGES) this.#done.add(s)
    this.#pending = this.#beat('passed', 'console', { text: passedLine(this.options.name), keep: [] })
  }
}

/** A turn wrapped to (−π, π]. */
function turn(rad: number): number {
  const t = ((rad + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  return t <= -Math.PI ? t + 2 * Math.PI : t
}
