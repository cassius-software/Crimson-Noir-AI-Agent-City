// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is Sloane's team planner: the deterministic part of dispatch. A goal's work words
 * ("warehouse", "robotics drill", "metro schedule", "triage", "compliance") name the desks the work belongs to, one
 * desk per indoor workplace kind (01_Initialize_World/interiors.ts WORKPLACE_KINDS, the sixteen in slot order; the
 * six first rooms are found under their earlier kind names too) and, when a number is given ("a 24-agent drill"),
 * how many sub-agents to send; a goal that names no work and maps to no control gets two scouts (the twin studio
 * and the control tower), so no goal is ever a dead end. Each sub-agent is a lane (08_Swarm/lanes.ts): a NoirScript
 * program written here that reads a window of the city's columns around its desk each tick, under the lane limits,
 * with the capability word a sub-agent holds (move and a workplace task: never vehicle teleop, never spawning more
 * sub-agents). The plan is pure: no clock, no randomness, no I/O, and no model (a model may reword what Sloane says
 * about it; it never decides it). The runtime that opens the lanes, asks people over and reports the readings is
 * 08_Swarm/team.ts.
 * What breaks if it is removed? Sloane can apply the knobs a goal names and nothing else: a goal about work has
 * nowhere to go, and a goal nothing maps to is a dead end again.
 */
import { CAP_MOVE, CAP_WORKPLACE_TASK, capNames } from '../02_Define_The_Rules/capabilities.ts'
import type { Skill } from '../03_Spawn_Agents/skills.ts'

/** The most sub-agents one goal sends: the lane runner's LANE_MAX (08_Swarm/lanes.ts; a test pins the two equal). */
export const TEAM_MAX = 32
/** Rows of a column one lane reads a tick: the window keeps a probe near half its gas (MAX_OPS_PER_TICK). */
export const WINDOW = 48
/** The capability word every sub-agent holds: it may move a body and work a station; nothing more. */
export const TEAM_CAPS = (CAP_MOVE | CAP_WORKPLACE_TASK) >>> 0

/** A desk's id: the workplace kind it is at, in interiors.ts slot order (the planner's own copy, so a map built either way is read). */
export type DeskId =
  | 'roboticsLab' | 'warehouse' | 'serverVault' | 'metroOps' | 'controlTower' | 'kitchen' | 'microFab' | 'twinStudio'
  | 'fleetBay' | 'greenhouse' | 'acousticsLab' | 'responseCenter' | 'clearingFloor' | 'gaitLab' | 'microgrid' | 'consoleDeck'

/** Where a goal that names no work goes: the twin studio plans it, the control tower measures it. */
export const SCOUTS: readonly DeskId[] = Object.freeze(['twinStudio', 'controlTower'])

/** What a lane at a desk reads each tick (laneSpec writes the program). */
export type Probe = 'carsNear' | 'crowd20' | 'crowd12' | 'cars' | 'kernel' | 'laws' | 'frame'

/** A workplace as a desk sub-agents are sent to: the kinds it is found under, its name in a sentence, the skill a body for it is asked over by, what its lanes read, and the words that send work there. */
export interface Desk {
  readonly id: DeskId
  /** The workplace kinds this desk is at: its id and, for the six first rooms, the kind's earlier name. */
  readonly kinds: readonly string[]
  /** The desk in a sentence, article included ('the warehouse', 'metro operations'). */
  readonly title: string
  /** The short word a lane's tag starts with ('warehouse:3'). */
  readonly short: string
  /** The skill the recruiter asks for when a body is sent (03_Spawn_Agents/skills.ts). */
  readonly skill: Skill
  /** What a lane there reads each tick, in plain words. */
  readonly reads: string
  readonly probe: Probe
  readonly re: RegExp
}

const KERNEL = 'the kernel’s law counters and the frame rate'
const LAWS = 'the Second and Third Law counters and the frame’s slowest fraction'
const FRAME = 'the frame rate, its slowest fraction, and how many cars and people the city holds'
const desk = (d: Desk): Desk => Object.freeze({ ...d, kinds: Object.freeze([...d.kinds]) })

/**
 * The sixteen desks in slot order. A word here is never one of the intent engine's knob words (intent.ts RULES), so a
 * knob stays a knob: the console keeps 'automate' and 'ring 0', the traffic keeps 'congestion' and 'traffic flow', the
 * sound keeps 'sound proof'. A desk's own name ('the control tower', 'the console deck') is the desk.
 */
export const DESKS: readonly Desk[] = Object.freeze([
  desk({ id: 'roboticsLab', kinds: ['roboticsLab'], title: 'the robotics lab', short: 'robotics', skill: 'Robotics', reads: 'the vehicles within 30 m of the lab and the fastest of them', probe: 'carsNear',
    re: /\b(?:robot(?:ic|ics|s)?|drills?|servos?|actuators?|manipulat(?:or|ors|ion)|grippers?|sim(?: |-)?to(?: |-)?real)\b/ }),
  desk({ id: 'warehouse', kinds: ['warehouse'], title: 'the warehouse', short: 'warehouse', skill: 'Go', reads: 'the people within 20 m of the warehouse', probe: 'crowd20',
    re: /\b(?:ware ?houses?|logistics|inventory|shipments?|pallets?|fork ?lifts?|stock ?rooms?|supply chains?|deliver(?:y|ies)|fulfil?lment|parcels?|packages?)\b/ }),
  desk({ id: 'serverVault', kinds: ['serverVault'], title: 'the server vault', short: 'vault', skill: 'Networking', reads: KERNEL, probe: 'kernel',
    re: /\b(?:servers?|server ?vault|data ?cent(?:er|re)s?|racks?|cooling plant|backups?|uptime|storage)\b/ }),
  desk({ id: 'metroOps', kinds: ['metroOps'], title: 'metro operations', short: 'metro', skill: 'Data', reads: 'the cars moving and parked, and the frame rate', probe: 'cars',
    re: /\b(?:(?:lakefront )?metro(?:politan)?|schedul(?:e|es|ed|ing)|time ?tables?|transit|headways?|trains|train (?:lines?|times?|service)|subway|commut(?:e|ers?|ing)|ferr(?:y|ies))\b/ }),
  desk({ id: 'controlTower', kinds: ['controlTower', 'telemetryCommand'], title: 'the control tower', short: 'tower', skill: 'Python', reads: FRAME, probe: 'frame',
    re: /\b(?:telemetry|control tower|air ?traffic|airspace|flight paths?|vtol|monitoring|dash ?boards?|metrics|throughput)\b/ }),
  desk({ id: 'kitchen', kinds: ['kitchen'], title: 'the kitchen', short: 'kitchen', skill: 'Design', reads: 'the people within 12 m of the kitchen door', probe: 'crowd12',
    re: /\b(?:kitchens?|cook(?:s|ing)?|meals?|food|dinners?|catering|prep line|chefs?|recipes?)\b/ }),
  desk({ id: 'microFab', kinds: ['microFab'], title: 'the micro-fab', short: 'fab', skill: 'C++', reads: KERNEL, probe: 'kernel',
    re: /\b(?:cnc|clean ?rooms?|fabricat(?:e|ed|ion)|micro ?fab|machining|prototyp(?:e|es|ing)|tolerances?|milling|3d print(?:ing|ers?|s)?|wafers?)\b/ }),
  desk({ id: 'twinStudio', kinds: ['twinStudio', 'boardroom'], title: 'the twin studio', short: 'twin', skill: 'Design', reads: KERNEL, probe: 'kernel',
    re: /\b(?:board ?rooms?|the board|executives?(?! console)|strateg(?:y|ic|ies)|budgets?|road ?maps?|meetings?|decisions?|priorit(?:y|ies|i[sz]e)|digital twins?|twin studio|architecture|blueprints?|zoning|city plan(?:ning|s)?|urban planning)\b/ }),
  desk({ id: 'fleetBay', kinds: ['fleetBay'], title: 'the fleet bay', short: 'fleet', skill: 'Rust', reads: 'the vehicles within 30 m of the bay and the fastest of them', probe: 'carsNear',
    re: /\b(?:fleet|battery swap|charg(?:ers?|ing)|maintenance|garage|depot|taxis?|t[iy]res?)\b/ }),
  desk({ id: 'greenhouse', kinds: ['greenhouse'], title: 'the greenhouse', short: 'greenhouse', skill: 'Data', reads: 'the people within 20 m of the greenhouse', probe: 'crowd20',
    re: /\b(?:green ?houses?|hydroponics?|crops?|harvests?|seedlings?|planting|irrigation|farm(?:s|ing)?|agri(?:culture|tech)?|lettuce|tomatoes)\b/ }),
  desk({ id: 'acousticsLab', kinds: ['acousticsLab'], title: 'the acoustics chamber', short: 'acoustics', skill: 'Audio', reads: 'the people within 12 m of the chamber door', probe: 'crowd12',
    re: /\b(?:acoustics?|soundproof(?:ing)?|decibels?|vibrations?|resonance|materials testing|stress test(?:s|ing)?|anechoic)\b/ }),
  desk({ id: 'responseCenter', kinds: ['responseCenter'], title: 'the response centre', short: 'response', skill: 'Testing', reads: LAWS, probe: 'laws',
    re: /\b(?:emergenc(?:y|ies)|disasters?|evacuat(?:e|ion|ions)|triage|first aid|fire drills?|floods?|earthquakes?|rescue|paramedics?|incidents?|recovery|response cent(?:re|er)s?)\b/ }),
  desk({ id: 'clearingFloor', kinds: ['clearingFloor', 'legalChambers'], title: 'the clearing floor', short: 'clearing', skill: 'Security', reads: LAWS, probe: 'laws',
    re: /\b(?:legal|lawyers?|compliance|contracts?|smart contracts?|licen[cs]es?|licen[cs]ing|polic(?:y|ies)|regulat(?:ion|ions|ory|ors?)|audits?|counsel|privacy|settlements?|clearing floor|ledgers?|payments?|invoices?|trades|finance|accounting|payroll|taxes)\b/ }),
  desk({ id: 'gaitLab', kinds: ['gaitLab', 'clinic'], title: 'the gait lab', short: 'gait', skill: 'Accessibility', reads: 'the people within 12 m of the lab door', probe: 'crowd12',
    re: /\b(?:clinics?|medical|health ?care|health|nurses?|doctors?|patients?|prosthetics?|gait|rehab(?:ilitation)?|physio(?:therapy)?|biomedical|well ?being|wheel ?chairs?)\b/ }),
  desk({ id: 'microgrid', kinds: ['microgrid'], title: 'the microgrid room', short: 'grid', skill: 'Go', reads: FRAME, probe: 'frame',
    re: /\b(?:micro ?grids?|substations?|electricity|solar|energy|outages?|load balancing|voltage|turbines?|wind farms?|power (?:grid|plants?|lines?|cuts?))\b/ }),
  desk({ id: 'consoleDeck', kinds: ['consoleDeck'], title: 'the console deck', short: 'deck', skill: 'Rust', reads: KERNEL, probe: 'laws',
    re: /\b(?:sanctuary|console deck|zeroth law|first law|second law|third law|the kernel)\b/ }),
])
const DESK_OF: ReadonlyMap<DeskId, Desk> = new Map(DESKS.map((d) => [d.id, d]))
export const deskOf = (id: DeskId): Desk => DESK_OF.get(id) ?? DESKS[0]!
/** The desk at a workplace kind as a map names it (either name of a first room), or null for a kind no desk knows. */
export const deskAt = (kind: string): Desk | null => DESKS.find((d) => d.kinds.includes(kind)) ?? null
/** Every desk's id, in slot order. */
export const DESK_IDS: readonly DeskId[] = Object.freeze(DESKS.map((d) => d.id))

/**
 * How many: "24 agents", "a 24-agent drill", "six sub-agents", "twenty-four sub-agents" (the first walk's own swarm),
 * "fifteen robots". Never "ten people" (the crowd) or "three lanes" (the roads).
 */
const COUNT = /\b(\d{1,5}|(?:twenty|thirty)(?: ?- ?| )(?:one|two|three|four|five|six|seven|eight|nine)|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty)(?: ?- ?| )?(?:sub ?-? ?agents?|agents?|workers?|robots?|bots?|scouts?|hands)\b/
const WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
}
/** A count's number: digits, one word, or tens and units ("twenty four", "thirty-one"). */
const countOf = (word: string): number => (/^\d+$/.test(word) ? Number(word) : word.split(/[ -]+/).reduce((n, w) => n + (WORDS[w] ?? 0), 0))
/** The verb that sends work, at most two words before a work word or a count ("run a 24-agent drill", "run a quick warehouse audit", "optimize the metro schedule"): it goes with the work, so "run" is not a pace on foot. Never across a preposition ("run to the warehouse" stays a run). */
const VERB = /\b(?:run|running|hold|start|launch|stage|conduct|kick off|organi[sz]e|arrange|do|execute|carry out|optimi[sz]e|improve|review|measure|check|plan)(?: (?:a|an|the|another|our|my|some|this|that))?(?: (?!(?:to|around|through|into|onto|over|past|across|along|by|in|at|on|off|from|with|for|of|and|or|but|then|up|down|out|away|back|home)\b)[a-z0-9']+){0,2} $/

/** A span of the goal a work word or a count took, for the caller to blank. */
export interface Span { readonly index: number; readonly length: number }
/** What a goal says about work: the desks it names (in order of first mention), the count it asks for, where it first did, and the spans taken. */
export interface WorkScan { readonly kinds: readonly DeskId[]; readonly count: number | null; readonly at: number; readonly spans: readonly Span[] }

/** Lower-case ASCII words one space apart (06_Make_Decisions/intent.ts normalises the same way before it asks). */
export function plainWords(text: string): string {
  return text.slice(0, 1024).normalize('NFKC').toLowerCase().replace(/[’‘`´ʼ′]/g, "'").replace(/[^a-z0-9:'%]+/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Reads a normalised goal for work: every desk whose words appear, the count, the spans. Pure. */
export function scanWork(text: string): WorkScan {
  const found: { kind: DeskId; at: number }[] = []
  const spans: Span[] = []
  let at = Number.POSITIVE_INFINITY
  let count: number | null = null
  /** The span of a match, taking the verb before it with it. */
  const take = (index: number, length: number): void => {
    const v = VERB.exec(text.slice(0, index))
    const from = v ? v.index : index
    spans.push({ index: from, length: index + length - from })
    at = Math.min(at, from)
  }
  const c = COUNT.exec(text)
  if (c) {
    count = countOf(c[1]!)
    take(c.index, c[0].length)
  }
  // Every desk's matches; where two overlap ("fire drill" and "drill", "wind farms" and "farms") the longer phrase is
  // the desk meant, and the shorter is not a second desk.
  const hits: { kind: DeskId; index: number; length: number }[] = []
  for (const d of DESKS) {
    const re = new RegExp(d.re.source, 'g')
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue }
      hits.push({ kind: d.id, index: m.index, length: m[0].length })
    }
  }
  hits.sort((a, b) => b.length - a.length || a.index - b.index)
  const held: typeof hits = []
  for (const h of hits) if (!held.some((k) => h.index < k.index + k.length && k.index < h.index + h.length)) held.push(h)
  held.sort((a, b) => a.index - b.index)
  for (const h of held) {
    if (!found.some((f) => f.kind === h.kind)) found.push({ kind: h.kind, at: h.index })
    take(h.index, h.length)
  }
  return { kinds: found.map((f) => f.kind), count, at: Number.isFinite(at) ? at : text.length, spans }
}

/** One sub-agent as planned: its desk, its tag, its place among that desk's lanes, and what it holds. */
export interface TeamLane {
  readonly kind: DeskId
  readonly title: string
  readonly skill: Skill
  /** 'warehouse:3': the desk's short word and this lane's number there, from 1. */
  readonly tag: string
  /** This lane's number among its desk's lanes, from 0: its window of the columns starts WINDOW rows further on. */
  readonly slice: number
  readonly caps: number
  readonly reads: string
}

/** A goal's team: who goes where. `scouting`: the goal named no work, so the two scouts go. */
export interface Team {
  readonly goal: string
  readonly kinds: readonly DeskId[]
  readonly lanes: readonly TeamLane[]
  /** The count the goal asked for (or one per desk), and how many of those were beyond TEAM_MAX. */
  readonly asked: number
  readonly dropped: number
  readonly scouting: boolean
}

/** The team a scan plans: the desks named (or the scouts), `count` lanes dealt round the desks in order. */
export function teamOf(scan: WorkScan, goal: string): Team {
  const scouting = scan.kinds.length === 0
  const named = scouting ? SCOUTS : scan.kinds
  const asked = Math.max(1, scan.count ?? named.length)
  const size = Math.min(asked, TEAM_MAX)
  // Fewer sub-agents than desks named reach the first desks only, and the team names only those: no desk is promised a
  // lane it does not get.
  const kinds = named.slice(0, size)
  const lanes: TeamLane[] = []
  for (let i = 0; i < size; i++) {
    const kind = kinds[i % kinds.length]!
    const d = deskOf(kind)
    const slice = Math.floor(i / kinds.length)
    lanes.push(Object.freeze({ kind, title: d.title, skill: d.skill, tag: `${d.short}:${slice + 1}`, slice, caps: TEAM_CAPS, reads: d.reads }))
  }
  return Object.freeze({ goal, kinds: Object.freeze([...kinds]), lanes: Object.freeze(lanes), asked, dropped: asked - size, scouting })
}

/** The team for a goal in plain words: the desks it names, or the scouts. Never null. */
export const teamFor = (goal: string): Team => teamOf(scanWork(plainWords(goal)), goal)

/** The desks in a sentence: "metro operations, the warehouse and the robotics lab". */
export function teamNames(team: Team): string {
  const names = team.kinds.map((k) => deskOf(k).title)
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

const many = (n: number, one: string, more: string): string => (n === 1 ? `one ${one}` : `${n} ${more}`)

/** The plan step's label, plain words: "Send 24 sub-agents to metro operations, the warehouse and the robotics lab". */
export function teamLabel(team: Team): string {
  const who = team.scouting ? many(team.lanes.length, 'scout', 'scouts') : many(team.lanes.length, 'sub-agent', 'sub-agents')
  return `Send ${who} to ${teamNames(team)}`
}

/** The brief's Team section: one line a lane, what it reads and holds; a note when the goal asked for more than fit. */
export function teamLines(team: Team): string[] {
  const lines = team.lanes.map((l) => `- **${l.tag}** at ${l.title}: reads ${l.reads}; holds ${capNames(l.caps).join(', ')}`)
  if (team.dropped > 0) lines.push(`- ${team.dropped} more asked for than the ${TEAM_MAX}-lane cap allows: not sent`)
  return lines
}

/** The team as the console prints it under `goal`: one plain row a lane, and the cap's note. */
export function teamRows(team: Team): string[] {
  const rows = team.lanes.map((l) => `${l.tag.padEnd(14)}at ${l.title}: reads ${l.reads}`)
  if (team.dropped > 0) rows.push(`${team.dropped} more asked for than the ${TEAM_MAX}-lane cap allows: not sent`)
  return rows
}

/** A number as NoirScript writes an f32 literal. */
const f32 = (x: number): string => {
  const v = Number.isFinite(x) ? Math.fround(x) : 0
  const t = v.toFixed(3)
  return t.includes('.') ? t : `${t}.0`
}

/**
 * The lane's program (08_Swarm/lanes.ts LaneSpec): a prelude declaring the cursor, the desk's position and the probe,
 * and a line calling the probe each tick. A probe over a column reads WINDOW rows from the cursor (fewer in a city with
 * fewer rows), walks the cursor on, and prints one short reading; a probe over the kernel or the frame prints their counters. `at` is the desk's
 * door front in city metres (null: an unplaced desk reads around the origin).
 */
export function laneSpec(lane: TeamLane, at: { x: number; z: number } | null): { role: string; caps: number; program: string; prelude: string; tag: string } {
  const x = f32(at?.x ?? 0), z = f32(at?.z ?? 0)
  const start = lane.slice * WINDOW
  const head = `let mut cursor = ${start}; let at_x = ${x}; let at_z = ${z};`
  const walk = (table: 'crowd' | 'cars', body: string, print: string) =>
    `fn probe() { let n = ${table}.n; let m = max(n, 1); let base = cursor % m; let mut seen = 0; ${body.includes('near') ? 'let mut near = 0;' : ''} ${body.includes('fastest') ? 'let mut fastest = 0.0;' : ''} ${body.includes('moving') ? 'let mut moving = 0; let mut parked = 0;' : ''}
for i in 0..${WINDOW} { if i < n { let j = (base + i) % m; seen += 1; ${body} } }
cursor = (base + ${WINDOW}) % m; ${print} }`
  const radius = (table: 'crowd' | 'cars', r: number, extra = '') =>
    `let dx = ${table}.x[j] - at_x; let dz = ${table}.z[j] - at_z; if dx * dx + dz * dz < ${f32(r * r)} { near += 1; ${extra} }`
  let probe: string
  switch (deskOf(lane.kind).probe) {
    case 'carsNear': probe = walk('cars', radius('cars', 30, 'fastest = max(fastest, cars.speed[j]);'), 'print("vehicles within 30 m", near, "of", seen, "fastest", fastest);'); break
    case 'crowd20': probe = walk('crowd', radius('crowd', 20), 'print("people within 20 m", near, "of", seen, "from row", base);'); break
    case 'crowd12': probe = walk('crowd', radius('crowd', 12), 'print("people within 12 m", near, "of", seen, "from row", base);'); break
    case 'cars': probe = walk('cars', 'if cars.mode[j] == 2 { parked += 1; } else if cars.speed[j] > 0.5 { moving += 1; }', 'print("cars", n, "moving", moving, "parked", parked, "of", seen, "fps", frame.fps);'); break
    case 'kernel': probe = 'fn probe() { print("first law", kernel.law1, "second", kernel.law2, "third", kernel.law3, "sensor flips", kernel.flips, "shielded", kernel.shielded, "fps", frame.fps); }'; break
    case 'laws': probe = 'fn probe() { print("second law", kernel.law2, "third law", kernel.law3, "shielded", kernel.shielded, "p95 ms", frame.p95); }'; break
    case 'frame': probe = 'fn probe() { print("fps", frame.fps, "ms", frame.ms, "p95 ms", frame.p95, "cars", cars.n, "people", crowd.n); }'; break
  }
  return { role: lane.title, caps: lane.caps, program: 'probe();', prelude: `${head}\n${probe}`, tag: lane.tag }
}
