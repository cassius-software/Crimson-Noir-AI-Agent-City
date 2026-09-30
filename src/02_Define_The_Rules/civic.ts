/**
 * Why does this file exist? It holds the 14A civic limits and the city's traffic law: pedestrians are
 * never harmed (a vehicle that touches one only nudges them aside), the signal cycle that drivers and
 * pedestrians both obey (crowd.wgsl mirrors signalFor/walkAllowed), speed limits, and the Reflex save a
 * pedestrian makes to get out of a vehicle's path.
 * What breaks if it is removed? Cars ignore lights, pedestrians cross into traffic, and nothing
 * guarantees a vehicle cannot hurt anyone.
 */

/** 14A: no violence and no harm to pedestrians. Contact with a vehicle is a nudge, never an injury. */
export const CIVIC = {
  rating: 'Canada-14A',
  pedestriansHarmable: false,
  violence: false,
} as const

export type Axis = 'ew' | 'ns'
export type Light = 'green' | 'amber' | 'red'

/**
 * One cycle, coordinated city-wide:
 * [0, ewGreen) east-west green · [ewGreen, ewAmber) east-west amber ·
 * [ewAmber, nsGreen) north-south green · [nsGreen, cycle) north-south amber.
 * Pedestrians walk parallel to the green axis during the first `walkSeconds` of its green.
 */
export const SIGNAL = {
  cycle: 32,
  ewGreen: 13,
  ewAmber: 16,
  nsGreen: 29,
  walkSeconds: 10,
} as const

function phase(t: number): number {
  const c = SIGNAL.cycle
  return ((t % c) + c) % c
}

export function signalFor(axis: Axis, t: number): Light {
  const p = phase(t)
  if (axis === 'ew') return p < SIGNAL.ewGreen ? 'green' : p < SIGNAL.ewAmber ? 'amber' : 'red'
  return p < SIGNAL.ewAmber ? 'red' : p < SIGNAL.nsGreen ? 'green' : 'amber'
}

/** A pedestrian walking along `axis` crosses the perpendicular street, parallel to that traffic. */
export function walkAllowed(axis: Axis, t: number): boolean {
  const p = phase(t)
  const start = axis === 'ew' ? 0 : SIGNAL.ewAmber
  return p >= start && p < start + SIGNAL.walkSeconds
}

export const TRAFFIC = {
  /** 40 km/h, a common Canadian downtown limit. */
  speedLimit: 40 / 3.6,
  turnSpeed: 5.5,
  comfortableDecel: 3,
  /** Right-hand traffic: lane centre this far to the right of the street centreline. */
  laneOffset: 2,
  /** Distance from an intersection centre to the stop line. */
  stopLine: 8.8,
  /** Zebra crosswalk band (distance from the intersection centre): in line with the sidewalks. */
  crosswalk: [4.4, 7.4] as const,
} as const

/** Reflex save a pedestrian in the roadway makes when a vehicle closes on them. Faster = harder. */
export const YIELD_SAVE = {
  modifier: 7,
  baseDc: 13,
  maxDcBonus: 8,
  lookahead: 16,
} as const

/**
 * Perception check an AI driver makes when a person appears in the path ahead. The degree of success
 * sets how quickly the driver starts a comfortable stop. It only shapes behaviour: the First Law floor in
 * laws.ts brakes regardless of the roll.
 */
export const DRIVER_REACTION = {
  modifier: 9,
  dc: 15,
  /** Seconds before the driver reacts, by degree: [critical failure, failure, success, critical success]. */
  latency: [1.0, 0.6, 0.25, 0.1],
} as const

/** Perception check a waiting pedestrian makes to notice the walk signal: start delay by degree. */
export const WALK_START = {
  modifier: 6,
  dc: 12,
  /** Seconds after the walk signal starts, by degree: [critical failure, failure, success, critical success]. */
  delay: [1.8, 1.0, 0.4, 0.0],
} as const

/** The physical envelope the First Law enforces (laws.ts, crowd.wgsl hazard sensing, sanctuary.ts). */
export const KERNEL = {
  /** Emergency deceleration the bouncer commands, m/s² (dry asphalt with ABS). */
  emergencyDecel: 7.5,
  /** Brake command (desired deceleration, m/s²) sent on a First Law stop; Fleet.apply's ceiling. */
  maxBrake: 8,
  /** Deceleration the Third Law uses to protect the vehicle itself, m/s². */
  selfDecel: 4.5,
  /** Metres left between a stopped bumper and a person. */
  standoff: 1.5,
  /** Seconds of sensing latency (GPU readback, frame pacing) the stopping envelope absorbs. */
  sensingLatency: 0.1,
  /** Sensing corridor half-width beyond the vehicle's own half-width, metres. */
  corridor: 0.45,
  /** Sensing range from the bumper, metres. */
  range: 30,
} as const
