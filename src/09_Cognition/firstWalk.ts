// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the first-run walk as pure data and timing: the six things a brand-new visitor does
 * before the city is theirs (turn the head and walk; tell Sloane a goal; get into a parked car; step inside a
 * workplace; choose a look in the wardrobe or a shop, or read a home's deed; open the console), what counts as having
 * done each one (a reading of the page, or an event the page reports), and what Sloane says at each: the thing to do in
 * the visitor's own device's words, one plain line of what it is (for an eight-year-old), and five whys that go one
 * deeper each time, every one of them true of the city as it runs today. The walk is held only until the visitor
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
  /** What this is, for an eight-year-old. */
  readonly eli8: string
  /** The five whys, one deeper each. */
  readonly whys: readonly string[]
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
      return { text: `Now talk to me${name}. ${tap(o)} my name on the chip and tell me a goal in your own words, like “make it night”. I ask why a few times, then I do what can be done now.`, keep: ['chip'] }
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
      if (o.family === 'pad') return { text: `Last one${name}, and then the city is yours. Open the console with the button on this card, or the ${o.words.console} key on a keyboard: the city’s command line, where the city answers to typed words. The moment it opens, everything here is open to you.`, keep: ['console'] }
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
      if (o.family === 'pad') return { text: 'The button on this card opens the console; on a keyboard it is the key left of 1, under Esc.', keep: ['console'] }
      return { text: `The ${o.words.console} key is the one left of 1, under Esc. Press it once and the console drops down from the top of the screen; the button on this card opens it too.`, keep: [o.words.console] }
  }
}

/**
 * What a stage is, for an eight-year-old. One or two plain sentences, all true of the city as it runs; the look stage
 * names the shops and the homes only on a map that has them (`city.stores`, `city.homes`).
 */
export function eli8Of(s: Stage, city?: FirstWalkOptions['city']): string {
  switch (s) {
    case 'move': return 'You are a person in this city, not a camera floating about. Your head turns, your feet carry you, and the picture follows you the way a film does.'
    case 'voice': return 'I am the city’s concierge. Tell me what you want in plain words and I ask you why, a few times, until we both know what you really mean; then I set what I can (the time, the quality, the sound) and write the rest down for you.'
    case 'fleet': return 'The streets have a fleet: cars of eight kinds that drive, park and let you take the wheel, and craft that fly between rooftop pads above the avenues. Every one of them keeps the same laws as the people.'
    case 'work': return 'Inside, the people of the city work: they type, inspect and talk at their stations, and what an agent does there is real agent work, prompts and answers, not a cartoon of it. A robot, real or simulated, can take a body in this city too, over the joint bridge.'
    case 'style': return `You choose how you look: your clothes and their colours, your hair, your skin, your face and your build. Everyone on the street is dressed from the same wardrobe you are, the city’s own business-casual one.${city?.stores === true ? ' The shops on the street sell lines from it too, and trying them on costs nothing.' : ''}${city?.homes === true ? ' A home can be yours as well: the homes on the street are for sale, and the smallest costs nothing to claim.' : ''}`
    case 'console': return 'The console is the city’s command line. Type a word, press Enter, and the city answers: the clock, the people, the cars, the kernel underneath. A lot of what you do with your hands you can also do with words there, and some things only words can do.'
  }
}

/** The five whys of a stage, one deeper each. Plain words; nothing here that the city does not do (the shops only where `city.stores`, the homes only where `city.homes`). */
export function whysOf(s: Stage, city?: FirstWalkOptions['city']): readonly string[] {
  const shops = city?.stores === true
  const homes = city?.homes === true
  switch (s) {
    case 'move': return Object.freeze([
      'Why does the picture smear a little when you turn fast? Because the camera is a film camera: it shows twenty-four pictures a second and each one is open for half of its moment (a 180-degree shutter), so motion blurs the way it does at the cinema.',
      'Why twenty-four and not more? Because that is the rate films have used for a hundred years; your eye reads it as a story rather than a screen. Your hands are not slowed by it: the controls and the physics run at the display’s own rate.',
      'Why do wet streets shine the way they do? Because every surface answers light by how rough it is, with the same maths film studios use (it is called GGX), and your graphics chip works it out for every pixel.',
      'Why can a whole city be on screen at once? Because the people far away are drawn simpler than the ones near you, and swap as you walk; the HUD even counts the near and the far ones.',
      'Why start with walking? Because everything else in this city is somewhere, and you will have to get there.',
    ])
    case 'voice': return Object.freeze([
      'Why do I ask why five times? Because the first wish is rarely the real one: “make it night” may mean “show me the lights”, and five whys get us there in a minute.',
      'Why can you also talk out loud? Because the city can listen through your microphone, but only when you ask it to (the console’s recruit listen), and the words stay on this device.',
      'Why are there words at the foot of the screen when something makes a sound? Because every sound in the city has a caption, so you can play with the sound off, or without hearing, and miss nothing.',
      'Why does my voice sometimes come out of the speakers? Because with sound on I say my lines with the browser’s own voice, at your own head, so you can look away from the screen and still hear me.',
      'Why does this matter? Because the city is yours to direct, and directing starts with being understood.',
    ])
    case 'fleet': return Object.freeze([
      'Why do the cars never run anyone over? Because every car’s wish to move is checked against the First Law before the wheels turn: a person in the way, and the car stops. Yours is the one exception, and it still harms nobody: while you sit at the wheel it passes through people, and nobody is pushed or moved.',
      'Why do they stop at the lights? Because every junction runs a real signal cycle and the cars read it; so can you, on the console, with stats.',
      'Why do parked cars stay parked? Because a parked car is in a mode the realm keeps until someone at its door asks for it; nobody drives off in one on their own.',
      'Why does the readout count “interventions”? Because every time a law overruled a driver it is counted, per law, so you can watch the city keep its promise.',
      'Why does the fleet matter for agents? Because an agent that can be trusted with a car can be trusted with a robot arm later, and the proof is the same: the law sits under the wheel, not in the driver’s good manners.',
    ])
    case 'work': return Object.freeze([
      'Why are there workplaces at all? Because agents need somewhere to do a job, and a job needs a bench, a table or a bed to stand by; the rooms give every task a place.',
      'Why sixteen kinds? Because sixteen trades cover most of what an agent is asked for: build, store, compute, route, watch, cook, make, model, move, grow, test, respond, settle, heal, power and command.',
      'Why can the HUD count who is at work? Because every station knows whether someone stands at it, and that number is a reading like any other, the same one the console shows.',
      'Why mention robots in here? Because a robot’s joints can drive a body in this city and a body here can lead a robot’s joints, over the joint bridge; the city is where the simulated and the real meet.',
      'Why does it matter to you? Because what you ask the city to do ends up at a station like these, done by someone, and you can walk in and watch.',
    ])
    case 'style': return Object.freeze([
      'Why business casual? Because the city is a place of work: everyone in it, you included, is dressed as for an office, a lab or a studio, in a suit, smart casual, a pantsuit or a skirt suit, with a jacket, shirt sleeves or a coat.',
      'Why does everyone on the street look different? Because each person’s look is drawn from that same wardrobe by a hash of their own number: a different draw for every one of them, across all ten skin tones of the Monk scale, with freckles on some and vitiligo on a few, and nobody has to pick.',
      `Why can nothing outside the wardrobe be worn? Because every choice is a number pointing into the crowd’s own catalogue, so no saved look, no typed command${shops ? ', no shared code and no shop' : ' and no shared code'} can put anyone in anything else.`,
      `Why does the wardrobe card draw you rather than show a mirror? Because out on the street you see through your own eyes; the card draws you from the very rings your graphics chip builds your body from, and your shadow and everyone else see the rest, freckles and vitiligo included.${shops ? ' In a shop, while its card is open, the camera steps out and circles you like a mirror (not in a headset or a shared room).' : ''}`,
      `Why does your look have a short code? Because a look is a set of numbers: the code, with a check built in, carries them to another device or a friend; and beside You, the card has a tab for each of your own agents, with a voice and a look from the same wardrobe.${homes ? ' A home is a number too: its deed is one line of the shops’ catalogue, kept by the one shopkeeper, so every card agrees on what is yours.' : ''}`,
    ])
    case 'console': return Object.freeze([
      'Why a command line in a city? Because this city is a coding tool you live in: telling a machine exactly what you mean, in words, is the thing you will do most here.',
      'Why does help list so many words? Because the console reads the city the way the HUD does, and further: the clock, the crowd, the traffic, the frame rate and the lanes your sub-agents run in are each one word away.',
      'Why can nothing you type turn the laws off? Because underneath the city is a kernel called Ring-0 that holds four laws in rank order; every car, every agent and every command passes through them, and the console has no word that sets them aside.',
      'Why does the city open here? Because from now on the console is where you meet the city as it is, and the city should meet you there too.',
      'Why is there more to find in here? Because the console has its own typed language, Crimson Noir Script, that runs in a machine with walls: a fixed amount of memory, a fixed number of steps, and only the doors the kernel opens; type noir and a line to try it.',
    ])
  }
}

/** The card for a stage. */
export function cardFor(s: Stage, o: FirstWalkOptions): StageCard {
  return Object.freeze({ stage: s, index: STAGES.indexOf(s) + 1, count: STAGES.length, title: titleOf(s), ask: askFor(s, o).text, eli8: eli8Of(s, o.city), whys: whysOf(s, o.city), show: showOf(s) })
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
