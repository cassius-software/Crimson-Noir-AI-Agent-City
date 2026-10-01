/**
 * Why does this file exist? It is what recruitment means, as plain rules both realms share: every pedestrian's
 * skills (fixed per agent, derived from its index), the words that name a skill in speech or on the console,
 * the proximity rule (only someone within earshot, on the operator's own side of the street), and the search
 * for the nearest such person. The page runs it to answer the operator at once (08_Swarm/recruitment.ts); the
 * physics worker runs it again on its own positions before it lets anyone walk over (simCore.ts), and the
 * crowd's summon slots are sized here (crowdCompute.ts). Pure: no DOM, no GPU, no clock, no randomness.
 * What breaks if it is removed? Nobody has a skill, and the two realms could disagree about who was asked.
 */
import { CITY, inLot } from '../01_Initialize_World/city.ts'

/**
 * The skills the city's people have: programming languages and crafts, named only so the operator can ask for
 * them (the language names are their owners' marks; NOTICE.md).
 */
export const SKILLS = [
  'Rust', 'TypeScript', 'Python', 'Go', 'C++', 'WGSL', 'Shaders', 'Audio',
  'Design', 'Testing', 'Security', 'Data', 'Robotics', 'Networking', 'Writing', 'Accessibility',
] as const
export type Skill = (typeof SKILLS)[number]

/**
 * How each skill is said (lower case). A bare "go" is left out on purpose ("let's go" is not a request for
 * a Go programmer); letters spelled out by a recogniser are covered ("w g s l").
 */
export const SKILL_WORDS: Readonly<Record<Skill, readonly string[]>> = {
  Rust: ['rust', 'rustacean'],
  TypeScript: ['typescript', 'type script'],
  Python: ['python'],
  Go: ['golang', 'go developer', 'go programmer', 'go engineer'],
  'C++': ['c++', 'c plus plus', 'see plus plus', 'cpp'],
  WGSL: ['wgsl', 'w g s l'],
  Shaders: ['shader', 'shaders', 'graphics'],
  Audio: ['audio', 'sound'],
  Design: ['design', 'designer'],
  Testing: ['testing', 'tester', 'qa'],
  Security: ['security'],
  Data: ['data', 'analytics'],
  Robotics: ['robotics', 'robot', 'robots'],
  Networking: ['networking', 'network'],
  Writing: ['writing', 'writer', 'documentation', 'docs'],
  Accessibility: ['accessibility', 'a11y'],
}

/**
 * Phrases that make an utterance a request. The microphone listens all the time, so they are explicit ("need a…",
 * "anyone who…", never a bare "need" or "anyone"), and a request counts only with the skill right after it: filler
 * words may stand between ("recruit a good rust developer", "I need someone who knows TypeScript"), anything else
 * may not ("is there a problem with the network", "who can hear that sound" ask nobody).
 */
export const RECRUIT_WORDS: readonly string[] = [
  'recruit', 'hire', 'hiring', 'looking for', 'who knows', 'who can', 'find me', 'find a', 'find an', 'find someone',
  'need a', 'need an', 'need someone', 'need somebody', 'anyone who', 'anyone here', 'anyone know', 'anybody who',
  'anybody here', 'anybody know', 'is there a', 'is there an', 'is there anyone',
]
/** Words allowed between a request phrase and the skill. */
const FILLERS = new Set([
  'a', 'an', 'some', 'someone', 'somebody', 'anyone', 'anybody', 'people', 'person', 'for', 'me', 'us', 'who', 'that',
  'knows', 'know', 'can', 'do', 'does', 'with', 'in', 'good', 'great', 'strong', 'skilled', 'experienced', 'senior',
  'junior', 'another', 'more', 'please',
])
/**
 * Words that turn a request down when they come shortly before it in the same clause ("I don't need a Rust developer",
 * "we aren't hiring"). Apostrophes are blanks by then. "isn't" is left out: "isn't there anyone who knows rust" asks.
 */
const NEGATIONS = [
  'no', 'not', 'never', 'nobody', 'without', 'cannot', 'can t', 'dont', 'don t', 'do not', 'doesn t', 'does not',
  'didn t', 'did not', 'won t', 'will not', 'aren t', 'shouldn t', 'wouldn t', 'couldn t', 'haven t', 'hasn t',
  'wasn t', 'weren t', 'mustn t', 'needn t',
]
/** How many words before a request a negation still turns it down (within its clause). */
const NEGATION_REACH = 5

/** Earshot, m: only people this close hear the operator. */
export const AUDIBLE_RADIUS = 5.0
/**
 * A recruit stops this far from the operator and faces them, m (crowd.wgsl SUMMON_STOP): on arriving, and again each
 * time they catch up while tethered (Active). It is the First Law standoff (civic.ts KERNEL.standoff) kept by people.
 */
export const INTERVIEW_DISTANCE = 1.5
/**
 * Farthest a summoned person may be when the GPU takes the request, m (crowd.wgsl SUMMON_ACCEPT): earshot plus
 * what they can walk in the few frames the request spends crossing the realms.
 */
export const SUMMON_ACCEPT = AUDIBLE_RADIUS + 1.0
/**
 * How fast a tethered (Active) recruit who has fallen behind hurries after the operator, m/s (crowd.wgsl TETHER_PACE):
 * above the operator's walk (simProtocol WALK, 2 m/s) so they keep up, below the pedestrian speed the First Law's
 * sensing assumes (crowdSensor.ts PEDESTRIAN_MAX_SPEED, 3 m/s, which the shader's cap enforces). A run outpaces them.
 */
export const TETHER_PACE = 2.4
/** The tether breaks when the operator is this far from a recruit (they walked off), m. */
export const RELEASE_DISTANCE = 12
/** A recruit who has not arrived after this long goes back to their day, s. */
export const APPROACH_SECONDS = 15
/**
 * Farthest from the operator a rally point may be, m: an Active recruit asked to walk to a sidewalk point stops
 * INTERVIEW_DISTANCE short of it, and the tether still breaks at RELEASE_DISTANCE from the operator (never from the
 * point), so the point stays a metre inside that: a rally never ends the tether it rides on.
 */
export const RALLY_RANGE = RELEASE_DISTANCE - INTERVIEW_DISTANCE - 1
/** People who can be over at once, walking over or Active (summon slots in the crowd's uniform): the swarm's size. */
export const RECRUIT_SLOTS = 8

/**
 * What a pedestrian is doing, as the crowd reports it per agent (crowd.wgsl writes it into pose.w): the recruiter
 * reads COMING and INTERVIEWING to know a summons was taken; the others describe their ordinary day.
 */
export const ACTIVITY = { routine: 0, waiting: 1, crossing: 2, steppingBack: 3, coming: 4, interviewing: 5 } as const
/** Samples along a recruit's straight path to the operator when checking it stays off the road, m. */
const PATH_STEP = 0.25

/** A 32-bit integer mix (lowbias32): the same index always gives the same skills. */
function mix(x: number): number {
  x = Math.imul(x ^ (x >>> 16), 0x7feb352d)
  x = Math.imul(x ^ (x >>> 15), 0x846ca68b)
  return (x ^ (x >>> 16)) >>> 0
}

/** Pedestrian `agent`'s two skills (agent 0 is the player's own body: none). */
export function skillsOf(agent: number): Skill[] {
  if (!(Number.isInteger(agent) && agent > 0)) return []
  const h = mix(Math.imul(agent, 0x9e3779b1) ^ 0x51ed270b)
  const n = SKILLS.length
  const a = h % n
  let b = (h >>> 8) % (n - 1)
  if (b >= a) b++
  return [SKILLS[a], SKILLS[b]]
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const phrase = (w: string) => new RegExp(`(?:^|[^a-z0-9+])${escape(w)}(?:$|[^a-z0-9+])`)
const WORD_RES = new Map<Skill, RegExp[]>(SKILLS.map((s) => [s, SKILL_WORDS[s].map(phrase)]))
const NEGATION_RE = new RegExp(` (?:${NEGATIONS.map(escape).join('|')})(?= )`)
/** Clause breaks become a '|' word; apostrophes and other marks become blanks; words are lower case. */
const words = (s: string): string[] => s.toLowerCase().replace(/[,.;:!?]+/g, ' | ').replace(/[^a-z0-9+| ]+/g, ' ').split(/\s+/).filter(Boolean)
const TRIGGERS = RECRUIT_WORDS.map((w) => w.split(' '))
const SKILL_TOKENS = new Map<Skill, string[][]>(SKILLS.map((s) => [s, SKILL_WORDS[s].map((w) => w.split(' '))]))
/** Whether words `p` start at `w[j]` (the last one may be a plural). */
const startsAt = (w: readonly string[], j: number, p: readonly string[]): boolean =>
  p.every((tok, k) => w[j + k] === tok || (k === p.length - 1 && w[j + k] === `${tok}s`))
/** A negation among the NEGATION_REACH words before `w[i]`, not crossing a clause break. */
function negatedBefore(w: readonly string[], i: number): boolean {
  let k = i
  while (k > 0 && i - k < NEGATION_REACH && w[k - 1] !== '|') k--
  return NEGATION_RE.test(` ${w.slice(k, i).join(' ')} `)
}
const normalise = (s: string) => ` ${s.toLowerCase().replace(/[^a-z0-9+ ]+/g, ' ').replace(/\s+/g, ' ').trim()} `

/** The skill a name refers to ("rust", "C++", "type script"…), for the console; null if none. */
export function skillNamed(name: string): Skill | null {
  const t = normalise(String(name ?? ''))
  for (const s of SKILLS) if (normalise(s) === t) return s
  for (const s of SKILLS) if (WORD_RES.get(s)!.some((re) => re.test(t))) return s
  return null
}

/**
 * The skill a spoken request asks for: a request phrase ("recruit", "hire", "I need a…", "anyone who knows…") with a
 * skill word right after it, only filler words between ("recruit a good rust developer"; across a clause break too:
 * "hiring: security"). A negation shortly before the phrase in the same clause turns that request down ("I don't need
 * a Rust developer"); a later request in the utterance may still stand ("…, I need a designer"). The first request
 * that names a skill wins; null when none does.
 */
export function parseRequest(transcript: string): Skill | null {
  const w = words(String(transcript ?? ''))
  for (let i = 0; i < w.length; i++) {
    const trigger = TRIGGERS.find((p) => startsAt(w, i, p) && w[i + p.length - 1] === p[p.length - 1])
    if (!trigger || negatedBefore(w, i)) continue
    let j = i + trigger.length
    while (j < w.length && (FILLERS.has(w[j]) || w[j] === '|')) j++
    for (const s of SKILLS) if (SKILL_TOKENS.get(s)!.some((p) => startsAt(w, j, p))) return s
  }
  return null
}

/** True on a carriageway (within CITY.roadHalf of a street centreline): crowd.wgsl onRoad(), on the CPU. */
export function onRoad(x: number, z: number): boolean {
  const ox = Math.abs(x - Math.round(x / CITY.pitch) * CITY.pitch)
  const oz = Math.abs(z - Math.round(z / CITY.pitch) * CITY.pitch)
  return Math.min(ox, oz) < CITY.roadHalf
}

/** True when the straight walk from (ax, az) to (bx, bz) never touches a carriageway. */
export function sidewalkPath(ax: number, az: number, bx: number, bz: number): boolean {
  const d = Math.hypot(bx - ax, bz - az)
  const n = Math.max(1, Math.ceil(d / PATH_STEP))
  for (let k = 0; k <= n; k++) if (onRoad(ax + ((bx - ax) * k) / n, az + ((bz - az) * k) / n)) return false
  return true
}

/** Why nobody could be asked; null when the operator may recruit from where they stand. */
export function whyNot(operator: { x: number; z: number } | null): string | null {
  if (!operator) return 'recruiting works on foot'
  if (!Number.isFinite(operator.x) || !Number.isFinite(operator.z)) return 'the operator is nowhere'
  if (onRoad(operator.x, operator.z)) return 'step onto the sidewalk first: nobody is called into the road'
  return null
}

/**
 * Why Active recruit `agent` (at `xz[2·agent]`, `xz[2·agent + 1]`) may not be sent to the rally point (x, z); null
 * when they may. The point must be finite, off the carriageway, outside every building lot (the crowd never enters
 * one: crowd.wgsl pushOut), within RALLY_RANGE of the operator, and reachable from where the recruit stands without a
 * step into the road. The page runs it on its copy to answer at once; the
 * physics worker runs it again on its own reading before anyone walks (simCore.ts).
 */
export function whyNotRally(operator: { x: number; z: number } | null, xz: ArrayLike<number>, agent: number, x: number, z: number): string | null {
  if (!operator || !Number.isFinite(operator.x) || !Number.isFinite(operator.z)) return 'rallying works on foot'
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 'the rally point is nowhere'
  if (onRoad(x, z)) return 'nobody is sent into the road: pick a sidewalk point'
  if (inLot(x, z)) return 'nobody is sent into a building: pick a sidewalk point'
  if (Math.hypot(x - operator.x, z - operator.z) > RALLY_RANGE) return `the rally point is too far: within ${RALLY_RANGE} m of the operator`
  if (!(Number.isInteger(agent) && agent > 0 && 2 * agent + 1 < xz.length)) return 'nobody by that number'
  const ax = xz[2 * agent], az = xz[2 * agent + 1]
  if (!Number.isFinite(ax) || !Number.isFinite(az)) return 'they have not been seen yet'
  if (!sidewalkPath(ax, az, x, z)) return 'no sidewalk from where they stand to the rally point'
  return null
}

/**
 * May pedestrian `agent` (at `xz[2·agent]`, `xz[2·agent + 1]`) be asked over for `skill`? It must not be the
 * player, must have the skill, stand on the sidewalk within AUDIBLE_RADIUS, and reach the operator without
 * stepping into the road. Returns the distance, or -1.
 */
export function eligible(xz: ArrayLike<number>, agent: number, operator: { x: number; z: number }, skill: Skill): number {
  if (!(Number.isInteger(agent) && agent > 0 && 2 * agent + 1 < xz.length)) return -1
  const x = xz[2 * agent], z = xz[2 * agent + 1]
  if (!Number.isFinite(x) || !Number.isFinite(z)) return -1
  const d = Math.hypot(x - operator.x, z - operator.z)
  if (!(d <= AUDIBLE_RADIUS)) return -1
  if (!skillsOf(agent).includes(skill)) return -1
  if (onRoad(x, z) || !sidewalkPath(x, z, operator.x, operator.z)) return -1
  return d
}

/** The nearest pedestrian who may be asked over for `skill` and is not `busy`; null if nobody. */
export function findRecruit(xz: ArrayLike<number>, operator: { x: number; z: number }, skill: Skill, busy: (agent: number) => boolean = () => false): { agent: number; distance: number } | null {
  let best: { agent: number; distance: number } | null = null
  const count = xz.length >> 1
  const r2 = AUDIBLE_RADIUS * AUDIBLE_RADIUS
  for (let i = 1; i < count; i++) {
    const dx = xz[2 * i] - operator.x, dz = xz[2 * i + 1] - operator.z
    if (!(dx * dx + dz * dz <= r2) || busy(i)) continue
    const d = eligible(xz, i, operator, skill)
    if (d >= 0 && (best === null || d < best.distance)) best = { agent: i, distance: d }
  }
  return best
}
