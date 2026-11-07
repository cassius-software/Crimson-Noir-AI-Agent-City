// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the first-run tutorial as pure data and timing: the seven things a brand-new visitor
 * does before the city is theirs (turn the head and walk; tell Sloane a goal; get into a parked car; step inside a
 * workplace; choose a look in the wardrobe; read the four laws at the Ring-0 console; run the three-line NoirScript
 * program that is the only way out), what counts as having done each one (a reading of the page, or an event the page reports), and what Sloane
 * says at each: the thing to do in the visitor's own device's words, one plain line of what it is (for an
 * eight-year-old), and five whys that go one deeper each time, every one of them true of the city as it runs today.
 * Sloane calls it "your first walk"; the words "tutorial", "lesson" and "step" never appear in a spoken line. Like the
 * quiet watch beside it (tutorial.ts Mentor) this reads the simulation and never writes to it, and every moment comes
 * from the clock values it is given, never from Date.now, so a test can walk the seven stages in a microsecond. The
 * React side (07_Execute_Actions/onboarding/useFirstWalk.ts, FirstWalk.tsx) feeds it and shows it; the exit itself
 * is the console's (terminal/noirscript: verify_ring0, spawn_subagents, unlock_city) and reaches here as events.
 * The look stage teaches what the city has for it today, the wardrobe card (Customizer.tsx); stores and owned places,
 * when the city has them, join that stage as more ways to finish it (a city flag beside `wardrobe`, an event beside
 * 'wardrobe'), so its place in the order and the exit stay as they are.
 * What breaks if it is removed? The first run has no stages, no words and no notion of having been passed.
 */
import type { InputFamily } from './tutorial.ts'

export type { InputFamily } from './tutorial.ts'

/** The seven stages, in order. */
export type Stage = 'move' | 'voice' | 'fleet' | 'work' | 'style' | 'ring0' | 'exam'
export const STAGES: readonly Stage[] = Object.freeze(['move', 'voice', 'fleet', 'work', 'style', 'ring0', 'exam'])

/** How patient Sloane is, ms, and what counts. */
export const WALK = Object.freeze({
  /** A stage with no progress for this long, and Sloane says the how again, more plainly. */
  hintMs: 45_000,
  /** The least time between two of Sloane's unasked lines. */
  cooldownMs: 45_000,
  /** Looking around: this much turn of the head counts, radians (about 20 degrees). */
  lookRadians: 0.35,
  /** Walking: this much ground counts, metres. */
  walkMetres: 3,
} as const)

/** The role the exit program names and the swarm it asks for (docs/noirscript.md, "The first walk's exit"). */
export const SWARM_ROLE = 'sim2real_workplaces'
export const SWARM_SIZE = 24

/** The exit program, one console line each (typed after `noir `; the session keeps `seal` and `swarm` between lines). */
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
   * Whether this map has cars to get into and rooms to walk into (a surveyed region has no rooms), and whether the page
   * has the wardrobe card (absent counts as present): a stage with nothing to do is passed over.
   */
  city: { fleet: boolean; rooms: boolean; wardrobe?: boolean }
  /** The nearest workplace, asked when the hint for the indoor stage is said; null or absent when there is none. */
  place?: () => WalkPlace | null
  /** Stages already done (a reload mid-walk; nothing is kept unless the walk was passed, so usually none). */
  done?: readonly Stage[]
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
 * entered, a room entered, the wardrobe card put away after it was opened, the console opened, a law line run there
 * (`laws`, `kernel`, `act gate`, `ring0`), and the exit program's three doors as the console's exam reports them (a
 * seal checked, a swarm called, the city unlocked).
 */
export type WalkEvent = 'look' | 'move' | 'goal' | 'mic' | 'captions' | 'vehicle' | 'inside' | 'wardrobe' | 'console' | 'law' | 'seal' | 'swarm' | 'unlock'

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

/** Console lines that are reading Ring-0: the laws, the kernel's interventions, the action gate, the elite tier's status. */
const LAW_LINES = /^(?:laws|kernel|act\s+gate|act\s+list|ring0(?:\s+status)?)$/
export function lawLine(line: string): boolean {
  return LAW_LINES.test(line.trim().toLowerCase())
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

/** A number in words, for the few the lines say. */
const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'twenty-one', 'twenty-two', 'twenty-three', 'twenty-four']
export const inWords = (n: number): string => WORDS[n] ?? String(n)

/** Whether a stage exists on this map: no cars means nothing to get into, no rooms nothing to walk into, no wardrobe nothing to put on. */
export function available(s: Stage, city: FirstWalkOptions['city']): boolean {
  switch (s) {
    case 'fleet': return city.fleet
    case 'work': return city.rooms
    case 'style': return city.wardrobe !== false
    default: return true
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
    case 'ring0': return 'Ring-0'
    case 'exam': return 'The way out'
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
    case 'ring0': return 'Open it for me'
    case 'exam': return 'Type it for me'
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
      return { text: 'Now go indoors. Six workplaces have open doors on the street: a robotics lab, a boardroom, a warehouse, a clinic, the legal chambers and a control room. Step through any one of them.', keep: ['door'] }
    case 'style':
      return { text: `Now choose how you look${name}. ${tap(o)} Look beside my name on the chip: pick your clothes and their colours, your hair, your face and your build, then press Done.`, keep: ['Look', 'Done'] }
    case 'ring0':
      if (o.family === 'touch') return { text: 'Under the city is a kernel called Ring-0. Open the Menu in the corner, tap Console, type the word laws and tap go.', keep: ['Console', 'laws'] }
      return { text: `Under the city is a kernel called Ring-0. Open the console with the ${o.words.console} key, type the word laws and press Enter.`, keep: [o.words.console, 'laws'] }
    case 'exam':
      return { text: `Last thing, and the only way out. In the console, run the three lines on this card, in order: verify_ring0 checks the seal on the kernel, spawn_subagents calls ${inWords(SWARM_SIZE)} sub-agents to work, and unlock_city opens the city when both hold.`, keep: ['verify_ring0', 'spawn_subagents', 'unlock_city'] }
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
    case 'style':
      return { text: `Look is the small word at the end of my chip, after my name. ${tap(o)} it, change anything you like or nothing at all, and press Done; the button on this card opens the wardrobe for you.`, keep: ['Look', 'Done'] }
    case 'ring0':
      return { text: o.family === 'touch'
        ? 'The console drops down from the top of the screen once you tap Console in the Menu. Type laws and tap go; act gate and kernel work too.'
        : `The console drops down from the top of the screen on the ${o.words.console} key. Type laws and press Enter; act gate and kernel work too.`, keep: ['laws'] }
    case 'exam':
      return { text: 'Type noir, a space, then the first line, and press Enter; the console keeps seal for the next line. The buttons on this card type each line for you, and the last one runs it.', keep: ['noir'] }
  }
}

/** What a stage is, for an eight-year-old. One or two plain sentences, all true of the city as it runs. */
export function eli8Of(s: Stage): string {
  switch (s) {
    case 'move': return 'You are a person in this city, not a camera floating about. Your head turns, your feet carry you, and the picture follows you the way a film does.'
    case 'voice': return 'I am the city’s concierge. Tell me what you want in plain words and I ask you why, a few times, until we both know what you really mean; then I set what I can (the time, the quality, the sound) and write the rest down for you.'
    case 'fleet': return 'The streets have a fleet: cars of eight kinds that drive, park and let you take the wheel, and craft that fly between rooftop pads above the avenues. Every one of them keeps the same laws as the people.'
    case 'work': return 'Inside, the people of the city work: they type, inspect and talk at their stations, and what an agent does there is real agent work, prompts and answers, not a cartoon of it. A robot, real or simulated, can take a body in this city too, over the joint bridge.'
    case 'style': return 'You choose how you look: your clothes and their colours, your hair, your face and your build. Everyone on the street is dressed from the same wardrobe you are, the city’s own business-casual one.'
    case 'ring0': return 'Underneath the city is a kernel called Ring-0. It holds four laws in rank order, and every car, every agent and every command passes through them. Nothing in the city, and nothing you type, can turn them off.'
    case 'exam': return 'This is a tiny program in NoirScript, the console’s own typed language. It runs in a machine with walls: a fixed amount of memory, a fixed number of steps, and only the doors the kernel opens. The three words are doors.'
  }
}

/** The five whys of a stage, one deeper each. Plain words; nothing here that the city does not do. */
export function whysOf(s: Stage): readonly string[] {
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
      'Why do the cars never run anyone over? Because every car’s wish to move is checked against the First Law before the wheels turn: a person in the way, and the car stops, whoever is driving, you included.',
      'Why do they stop at the lights? Because every junction runs a real signal cycle and the cars read it; so can you, on the console, with stats.',
      'Why do parked cars stay parked? Because a parked car is in a mode the realm keeps until someone at its door asks for it; nobody drives off in one on their own.',
      'Why does the readout count “interventions”? Because every time a law overruled a driver it is counted, per law, so you can watch the city keep its promise.',
      'Why does the fleet matter for agents? Because an agent that can be trusted with a car can be trusted with a robot arm later, and the proof is the same: the law sits under the wheel, not in the driver’s good manners.',
    ])
    case 'work': return Object.freeze([
      'Why are there workplaces at all? Because agents need somewhere to do a job, and a job needs a bench, a table or a bed to stand by; the rooms give every task a place.',
      'Why six kinds? Because six trades cover most of what an agent is asked for: build, decide, move, heal, judge, watch.',
      'Why can the HUD count who is at work? Because every station knows whether someone stands at it, and that number is a reading like any other, the same one the console shows.',
      'Why mention robots in here? Because a robot’s joints can drive a body in this city and a body here can lead a robot’s joints, over the joint bridge; the city is where the simulated and the real meet.',
      'Why does it matter to you? Because what you ask the city to do ends up at a station like these, done by someone, and you can walk in and watch.',
    ])
    case 'style': return Object.freeze([
      'Why business casual? Because the city is a place of work: everyone in it, you included, is dressed as for an office, a lab or a studio, in a suit, smart casual, a pantsuit or a skirt suit, with a jacket, shirt sleeves or a coat.',
      'Why does everyone on the street look different? Because each person’s look is drawn from that same wardrobe by a hash of their own number: the same choices, a different draw for every one of them, and nobody has to pick.',
      'Why can nothing outside the wardrobe be worn? Because every choice is a number pointing into what the crowd already wears, so no saved look, no typed command and no shared code can put anyone in anything else.',
      'Why is there no mirror? Because in this city you see through your own eyes, never at yourself; the card draws you instead, from the very rings your graphics chip builds your body from, and your shadow and everyone else see the rest.',
      'Why does your look have a short code? Because a look is a handful of choices: the code, with a check built in, carries them to another device or a friend; and the Agents tab gives each of your own agents a name, a voice and a look from the same wardrobe.',
    ])
    case 'ring0': return Object.freeze([
      'Why four laws and not three? Because the Zeroth Law sits above the others: no action may harm the city as a whole, and the action gate holds every ask, proposal and run to it before the First, Second and Third.',
      'Why is there a gate at all? Because an agent that can act is allowed to act only through a catalogue of named actions, each checked twelve ways, and each one waits for your OK on a card; the agent never gets its hands on the engine.',
      'Why is the city air-gapped? Because its scripts reach no network, no clock and no file on their own; a container that fails that check keeps the gate closed.',
      'Why is the console a shell? Because operators read root shells, and this one shows you what the kernel sees: the laws, the interventions, the gate, and the audit trail with its hash chain.',
      'Why must you see this before the city opens? Because you are about to be given a swarm, and you should know what holds it.',
    ])
    case 'exam': return Object.freeze([
      'Why a program and not a button? Because this city is a coding tool you live in: the first thing you do here should be the thing you will do most, which is tell a machine exactly what you mean.',
      'Why does verify_ring0 give a number? Because it is a seal: a checksum of the kernel’s live state, the four laws, the twelve checks and the air gap; if any of them is off, the seal is zero and the city stays shut.',
      `Why ${inWords(SWARM_SIZE)} sub-agents? Because that is a swarm you can count: people asked over one by one, each one tethered to you and counted on the HUD; what cannot be asked is not pretended, and the console tells you how many came.`,
      'Why can the program not simply set a flag? Because NoirScript writes to nothing it is not handed; unlock_city is handed one door, this walk’s own, and only the kernel’s seal opens it.',
      'Why does the walk end in the console? Because from here on the console is where you meet the city as it is, and the city should meet you there too.',
    ])
  }
}

/** The card for a stage. */
export function cardFor(s: Stage, o: FirstWalkOptions): StageCard {
  return Object.freeze({ stage: s, index: STAGES.indexOf(s) + 1, count: STAGES.length, title: titleOf(s), ask: askFor(s, o).text, eli8: eli8Of(s), whys: whysOf(s), show: showOf(s) })
}

/** Sloane's line when the city opens. */
export function passedLine(name?: string): string {
  const n = name?.trim() ? `, ${name.trim()}` : ''
  return `The city is yours${n}. Everything you just did, you can do again any time; and I am on the chip whenever you want me.`
}

/**
 * The walk: told when the visitor is in (`start`), fed readings (`read`) and events (`note`), and asked a few times a
 * second (`tick`) whether there is something to say. A stage is done when its readings or events say so; the walk is
 * passed when the console's exam reports `unlock`. Everything is timed from the clock values it is given.
 */
export class FirstWalk {
  readonly options: Readonly<FirstWalkOptions>
  readonly #done = new Set<Stage>()
  #started = Number.NaN
  #progress = Number.NaN
  #lastSaid = Number.NaN
  #last: WalkReading | null = null
  #yaw0 = Number.NaN
  #travelled0 = Number.NaN
  #looked = false
  #walked = false
  #seal = false
  #swarm = false
  #passed = false
  #said = 0
  #hinted = new Set<Stage>()
  #pending: Beat | null = null

  constructor(options: FirstWalkOptions) {
    this.options = Object.freeze({ ...options, words: Object.freeze({ ...options.words }), city: Object.freeze({ ...options.city }) })
    for (const s of options.done ?? []) this.#done.add(s)
    for (const s of STAGES) if (!available(s, options.city)) this.#done.add(s)
    if (this.#done.has('exam')) this.#done.delete('exam') // the exit is never passed over
  }

  /** The visitor is in: the first stage starts now, and Sloane says it. */
  start(now: number): void {
    if (this.started) return
    this.#started = now
    this.#progress = now
    this.#pending = this.#beat('ask', this.stage, askFor(this.stage, this.options))
  }

  get started(): boolean {
    return Number.isFinite(this.#started)
  }

  /** The city was unlocked: the walk is over. */
  get passed(): boolean {
    return this.#passed
  }

  /** The stage the visitor is on (the exit, once every other is done). */
  get stage(): Stage {
    return STAGES.find((s) => !this.#done.has(s)) ?? 'exam'
  }

  get done(): ReadonlySet<Stage> {
    return this.#done
  }

  /** What the card shows now. */
  get card(): StageCard {
    return cardFor(this.stage, this.options)
  }

  /** The exit's doors so far: the seal checked, the swarm called. */
  get exam(): { seal: boolean; swarm: boolean } {
    return { seal: this.#seal, swarm: this.#swarm }
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
      case 'wardrobe': this.#finish('style', now); break
      case 'law': this.#finish('ring0', now); break
      case 'seal': this.#seal = true; break
      case 'swarm': this.#swarm = true; break
      case 'unlock':
        if (this.stage !== 'exam') return
        this.#passed = true
        this.#done.add('exam')
        this.#pending = this.#beat('passed', 'exam', { text: passedLine(this.options.name), keep: [] })
        break
      default: break
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
      return
    }
    let active = false
    if (Number.isFinite(r.yaw) && Number.isFinite(this.#yaw0) && Math.abs(turn(r.yaw - this.#yaw0)) >= WALK.lookRadians) { if (!this.#looked) active = true; this.#looked = true }
    if (Number.isFinite(r.travelled) && Number.isFinite(this.#travelled0) && r.travelled - this.#travelled0 >= WALK.walkMetres) { this.#walked = true; this.#travelled0 = r.travelled; active = true }
    if (this.#looked && this.#walked) this.#finish('move', now)
    if (r.driving && !last.driving) { active = true; this.#finish('fleet', now) }
    if (r.inside && !last.inside) { active = true; this.#finish('work', now) }
    if (r.consoleOpen && !last.consoleOpen) active = true
    if (active) this.#progress = now
  }

  /**
   * Whether this is a moment for Sloane to speak: a stage just started or the walk was just passed (said at once),
   * or the stage has had no progress for hintMs and the last line was cooldownMs ago (one hint per stage). Returns
   * the line (marked as said) or null.
   */
  tick(now: number): Beat | null {
    if (!this.started) return null
    const p = this.#pending
    if (p) {
      this.#pending = null
      this.#lastSaid = now
      return p
    }
    if (this.#passed) return null
    const o = this.options
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

  /** A stage is done: the next one starts, and Sloane says it (the exit is finished only by `unlock`). */
  #finish(s: Stage, now: number): void {
    if (s === 'exam' || this.#done.has(s)) return
    const before = this.stage
    this.#done.add(s)
    this.#progress = now
    // A later stage done early (a car entered while still learning to walk) is kept, and said nothing of until its turn
    // would have come: Sloane speaks only when the stage on the card changes.
    const next = this.stage
    if (next !== before) this.#pending = this.#beat('ask', next, askFor(next, this.options))
  }
}

/** A turn wrapped to (−π, π]. */
function turn(rad: number): number {
  const t = ((rad + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  return t <= -Math.PI ? t + 2 * Math.PI : t
}
