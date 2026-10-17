// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the whole contract across the realm boundary between the page and the
 * physics worker: the messages each side may send, the commands the page may ask for, and the layout of the
 * pose buffer the worker hands back every step. Everything crossing is plain data (numbers, strings,
 * booleans, typed arrays); no object reference can cross a postMessage, so the page never holds a Rapier
 * handle, the Bouncer, the Sanctuary or the Ring-0 auditor. Pure: it imports only types.
 * What breaks if it is removed? The two realms have no agreed language, and nothing checks either side.
 */
import type { Box, Furniture } from '../01_Initialize_World/city.ts'
import type { RegionGround } from './physics.ts'
import type { StreetGrid } from '../01_Initialize_World/region/streets.ts'
import type { WorkplaceLot } from '../01_Initialize_World/interiors.ts'
import type { KernelStats } from '../05_Observe_Environment/telemetry.ts'
import type { CrowdSimStats } from '../03_Spawn_Agents/crowdSensor.ts'
import type { CarTuning, DriveMode } from './car.ts'
import type { TrackKind } from '../06_Make_Decisions/tracks.ts'
import type { BalanceState } from '../03_Spawn_Agents/ragdoll.ts'

/**
 * One vehicle's slice of the pose buffer (Float32Array, `POSE.stride` floats per vehicle, fleet order). The
 * wheels follow as `[suspension length, rolling angle, steering angle]` for each of the four wheels.
 */
export const POSE = {
  x: 0, y: 1, z: 2, qx: 3, qy: 4, qz: 5, qw: 6,
  heading: 7, speed: 8, curvature: 9, throttle: 10, brake: 11, mode: 12, vx: 13, vy: 14, vz: 15,
  wheels: 16,
  stride: 28,
} as const

/**
 * The person model: an upright capsule of this radius around a cylinder of 2 × halfHeight, feet at its bottom (1.8 m
 * tall). The avatar's Rapier body is built from it (player.ts); the ghost view draws every pedestrian's contact
 * envelope with it (ghost.ts).
 */
export const PERSON = Object.freeze({ radius: 0.3, halfHeight: 0.6 })

/** Walking and running speed, m/s: the worker caps the page's foot controls at a run. */
export const WALK = 2.0
export const RUN = 5.2

/**
 * The walking velocity the realm applies for foot controls (x, z) that are already finite: the same direction, never
 * faster than a run. One definition for the physics worker (simCore.ts) and the network's authoritative mirror
 * (10_Network/mirror.node.ts), so a client's prediction and the server's truth clamp alike, to the bit.
 */
export function footWish(x: number, z: number): { x: number; z: number } {
  const len = Math.hypot(x, z)
  const s = len > RUN ? RUN / len : 1
  return { x: x * s, z: z * s }
}
/** How close the avatar must stand to a car to take its wheel, m. */
export const ENTER_RANGE = 3.8
/**
 * Most people the realm holds for the page: local split-screen players, each an Avatar in the Rapier world, a ward of
 * the Sanctuary and a person to the Bouncer and the Ring-0 audit. Player 0 is the operator (foot/drive, avatar,
 * driving, recruitment, the crowd's one player figure); players 1..3 ride beside them in `players`, `avatars` and
 * `drivings`.
 */
export const MAX_PLAYERS = 4

/** DriveMode as it is stored in the pose buffer. */
export const MODES: readonly DriveMode[] = ['ai', 'player', 'parked']

/**
 * One scheduled craft's slice of the craft buffer (Float32Array, `TRACK_POSE.stride` floats per craft): the train
 * sets, drones and planes that follow the corridors of 06_Make_Decisions/tracks.ts on the realm's own clock
 * (trackFleet.ts), in network order (track by track, each track's craft by index). `kind` is the craft's index in
 * TRACK_KINDS, `track` its track id, `s` its arc length along the track (m) and `speed` its speed along it (m/s).
 * The page only draws it; the Ring-0 audit reads it (every value finite, every craft at or above its corridor's
 * floor) before it leaves the realm.
 */
export const TRACK_POSE = { x: 0, y: 1, z: 2, heading: 3, kind: 4, track: 5, s: 6, speed: 7, stride: 8 } as const

/** TrackKind as it is stored in the craft buffer (index = code). Cars never appear in it: they are in the pose buffer. */
export const TRACK_KINDS: readonly TrackKind[] = ['car', 'train', 'drone', 'plane']

/**
 * The rig stream (StepState.rigs): one slice of `RIG_POSE.stride` floats per rig slot (`SimMeta.rigSlots` of them),
 * for the pedestrians near the operator the realm has promoted to a physical body (ragdollRealm.ts over
 * 03_Spawn_Agents/ragdoll.ts): `agent` is the pedestrian's index in the crowd (−1: an empty slot, nothing follows),
 * `state` the balance machine's state as RIG_STATES codes it, then `segments` poses of `segmentStride` floats each
 * (x, y, z, qx, qy, qz, qw), one per RIG_SEGMENTS entry. The page hides the crowd's figure of a listed agent and draws
 * the rig in its place (rigView.ts); the Ring-0 audit has already checked every segment as a person before it leaves.
 */
export const RIG_POSE = { agent: 0, state: 1, segments: 2, segmentStride: 7, segmentCount: 13, stride: 2 + 13 * 7 } as const

/** Rig slots the realm holds at most (03_Spawn_Agents/ragdoll.ts POOL_CAPACITY; pinned equal by ragdollRealm.test.ts). */
export const RIG_SLOTS = 8

/** BalanceState as the rig stream codes it (index = code). */
export const RIG_STATES: readonly BalanceState[] = ['kinematic', 'perturbed', 'catchStep', 'sittingDown', 'seated', 'recovering']

/**
 * The thirteen shapes of a rig in stream order, with the capsule each is drawn as: [half height of the cylinder part,
 * radius], m. The eleven segments match 03_Spawn_Agents/ragdollRig.ts SEGMENTS (which the page never loads: it
 * imports Rapier); the two flat feet are drawn as short capsules of their footprint. Pinned equal by
 * ragdollRealm.test.ts.
 */
export const RIG_SEGMENTS: readonly (readonly [name: string, halfHeight: number, radius: number])[] = Object.freeze([
  ['pelvis', 0.04, 0.14], ['torso', 0.12, 0.16], ['head', 0.01, 0.11],
  ['upperLegL', 0.14, 0.07], ['lowerLegL', 0.14, 0.055], ['upperLegR', 0.14, 0.07], ['lowerLegR', 0.14, 0.055],
  ['upperArmL', 0.1, 0.05], ['lowerArmL', 0.1, 0.045], ['upperArmR', 0.1, 0.05], ['lowerArmR', 0.1, 0.045],
  ['footL', 0.07, 0.05], ['footR', 0.07, 0.05],
] as const)

/** The page's one-time request to build the world in the worker. A second init is refused. */
export interface SimInit {
  t: 'init'
  seed: number
  cars: number
  /** Pedestrians simulated on the worker's own GPU device (the first is the player's own body). */
  agents: number
  boxes: Box[]
  furniture: Furniture
  spawn: { x: number; z: number }
  /**
   * Where players 1..3 start (index k − 1 for player k), at most MAX_PLAYERS − 1 of them: each a finite pair, moved out
   * of a building lot by the worker. Absent for one player.
   */
  spawns?: { x: number; z: number }[]
  /** ?debug: the worker also accepts the fault-injection commands (dbg*). Fixed for the worker's lifetime. */
  debug: boolean
  /**
   * A surveyed region to build instead of the procedural city's boxes and furniture (physics.ts RegionGround): its
   * bounds and walls. Absent (or null) for the city.
   */
  region?: RegionGround | null
  /**
   * A region's street window (01_Initialize_World/region/streets.ts): the CITY.blocks × CITY.blocks blocks of a generated
   * map the crowd walks and the fleet drives. With one, a region has people and traffic like the city: the crowd is
   * compiled for the window and the cars are seated on its rings (with tracks on). Absent (or null) for the city and
   * for a surveyed region (hidden crowd, empty fleet).
   */
  streets?: StreetGrid | null
  /**
   * A generated region's indoor workplaces (01_Initialize_World/region/workplaces.ts regionWorkplaceLots): at most
   * six lots of the street window, each with its kind and its doorway's street front, which the page picked from its
   * pack and the worker builds the same rooms from (interiors.ts workplacesAt), so the two never disagree. Their boxes
   * come in `boxes`. Only with a street window; absent (or null) for none, and for the city, whose rooms are its seed's.
   */
  workplaces?: WorkplaceLot[] | null
  /**
   * Seat the AI fleet on the fixed track network (06_Make_Decisions/tracks.ts, built in the worker from the seed, or
   * the street window's rings in a region with one) and drive it with track followers; anything but true keeps the
   * random street-hopping drivers.
   */
  tracks?: boolean
  /**
   * Wire the ragdoll balance machine to the pedestrians near the operator (ragdollRealm.ts; the page's default, ?ragdoll=0
   * off): anything but true keeps every pedestrian on the GPU alone, and the rig stream null. Never in a region.
   */
  ragdoll?: boolean
}

/** Static facts about the world the worker built, sent once in `ready`. */
export interface SimMeta {
  count: number
  /** Pedestrians in the worker's crowd, and so in every render frame (12 floats each). */
  agents: number
  /** Per vehicle: the heavy chassis class (the SUV's box; car.ts chassisBox). Every scan of a chassis reads this. */
  suv: boolean[]
  /** Per vehicle: its kind, an index into car.ts VEHICLE_KINDS (the silhouette drawn, the HUD's name). */
  kind: number[]
  /** Body colour per vehicle, 0xRRGGBB (sRGB). */
  paint: number[]
  person: { radius: number; halfHeight: number }
  debug: boolean
  /** Scheduled craft (train sets, drones, planes) in every craft buffer, TRACK_POSE.stride floats each; 0 with tracks off. */
  craft: number
  /** Avatars the realm holds (1 + spawns.length, at most MAX_PLAYERS): the length of every `avatars` and `drivings`. */
  players: number
  /** Rig slots in every rig stream (RIG_SLOTS with the ragdoll on in the city; 0 off, or in a region: the stream is null). */
  rigSlots: number
  /**
   * Indoor workplaces this realm's crowd was handed (01_Initialize_World/interiors.ts): the city's six, a generated
   * region's that came in SimInit.workplaces, none in a surveyed region or without a crowd. A read-out for the page.
   */
  rooms: number
}

/**
 * On foot: the desired walking velocity in the world (x, z), m/s, which the worker caps at a run; and the way
 * the player's body faces (the view's heading), which only turns the player's own figure in the crowd.
 */
export interface FootControls { x: number; z: number; heading: number }

/** In a car: raw controls, each clamped by the worker. steer −1..1 (positive = left), fwd and back 0..1. */
export interface DriveControls { steer: number; fwd: number; back: number; handbrake: boolean }

/** One extra player's frame of controls (players 1..3): the same foot and drive the operator sends, clamped the same. */
export interface PlayerControls { foot: FootControls; drive: DriveControls }

/** What the page may ask of the simulation. Every command is validated again in the worker. */
export type SimCommand =
  // `player` picks the avatar (0..players − 1, default 0): a car another player is driving is refused.
  | { c: 'interact'; player?: number }
  // `player` picks whose car is righted (default 0); a player on foot has none, and the reset does nothing.
  | { c: 'reset'; player?: number }
  // `y`: put down at that height (a network room's truth), else just above standing height.
  | { c: 'teleport'; x: number; z: number; y?: number; player?: number }
  /**
   * A network room's drift resync: player 1, on foot, carried by (dx, dy, dz) with nothing else
   * changed. Refused outside a room and at the wheel (a car's correction is a netCar).
   */
  | { c: 'shift'; dx: number; dy: number; dz: number }
  | { c: 'setMode'; i: number; mode: 'ai' | 'parked' }
  | { c: 'recover'; i: number; x?: number; z?: number; heading?: number }
  | { c: 'intent'; i: number; throttle: number; brake: number; steer: number }
  | { c: 'tune'; key: keyof CarTuning; value: number }
  | { c: 'blind'; on: boolean; ttlMs?: number }
  /**
   * Matrix mode (01_Initialize_World/matrixMode.ts) for the crowd: on, the pedestrians keep only the static world's
   * physics layer (crowd.wgsl physicsMaskFor), so people and cars phase through them while the ground and the lots
   * still hold them; the First-Law sensing and the Sanctuary are untouched. The page's own surfaces take the mode
   * from the same global state, so the drawing and the simulation agree.
   */
  | { c: 'matrix'; on: boolean }
  // Recruitment (skills.ts): ask someone with `skill` within earshot over. `agent` is the page's pick; the worker
  // checks it against its own readings and, if it no longer qualifies, asks the nearest person who does. `id` is
  // echoed by the 'recruit' event that answers it.
  | { c: 'recruit'; id: number; skill: string; agent?: number }
  /** Lets one recruit (`agent`) go, or every one: the tether breaks. */
  | { c: 'dismiss'; agent?: number }
  /**
   * Asks Active recruit `agent` to walk to the sidewalk point (x, z) instead of to the operator (skills.ts RALLY_RANGE,
   * whyNotRally): the worker checks the point on its own readings and answers with a 'rally' event. The tether is
   * unchanged: it still breaks when the operator is RELEASE_DISTANCE from them, and the rally ends on its own when the
   * operator walks more than RALLY_RANGE from the point, or when they are dismissed.
   */
  | { c: 'rally'; agent: number; x: number; z: number }
  /**
   * A network room (10_Network): on while the page is joined to one, off when it leaves. Player 1 becomes a ghost
   * (player.ts setGhost, sanctuary.ts ghost: only fixed geometry stops them and no vehicle can touch them, while the
   * Bouncer still brakes every car for them), the cars' tuning returns to the authored car, and the commands that
   * would move a car behind the room's back (tune, setMode, recover, intent, reset and the fault injections) are refused:
   * the room's authority replays player 1's walk and car and must find the same physics.
   */
  | { c: 'room'; on: boolean }
  /**
   * A network room's correction at the wheel (room only): player 1 put in car `i`, its chassis in exactly `state`, with a
   * fresh controller, as the room's authority has it (leaving the car they were in, if another, where it is).
   */
  | { c: 'netCar'; i: number; state: CarBodyState }
  // Fault injection for the ?debug harness only: refused by a worker built without debug.
  | { c: 'dbgVelocity'; i: number; x: number; y: number; z: number }
  | { c: 'dbgMode'; i: number; mode: DriveMode }
  | { c: 'dbgSanctuary'; on: boolean }
  | { c: 'dbgHazard'; i: number; ahead: number | null }

/**
 * One frame's worth of input. There is deliberately nothing about pedestrians or time in it: the crowd, its
 * First-Law hazard readings, its Ring-0 flags and the signal clock all live in the worker.
 */
export interface StepRequest {
  t: 'step'
  id: number
  /** Real seconds since the last step request (the worker clamps it and runs its own clock). */
  dt: number
  foot: FootControls
  drive: DriveControls
  /** Players 1..3 (index k − 1 for player k); a missing entry is an idle player. Player 0 is foot and drive above. */
  players?: PlayerControls[]
  cmds: SimCommand[]
  /** A pose buffer handed back for reuse (transferred). */
  buffer?: ArrayBuffer
  /** A crowd render frame's buffer handed back for reuse (transferred). */
  crowdBuffer?: ArrayBuffer
  /** A craft buffer handed back for reuse (transferred). */
  craftBuffer?: ArrayBuffer
  /** A rig stream's buffer handed back for reuse (transferred). */
  rigBuffer?: ArrayBuffer
}

export interface AvatarState {
  x: number
  /** Capsule centre height, m. */
  y: number
  z: number
  /** The feet (bottom of the capsule), m. */
  feetY: number
  /** Achieved walking speed, m/s. */
  speed: number
  /** False while seated in a car (the collider is out of the world). */
  enabled: boolean
  /** True while the Sanctuary shields the avatar (its collider is a sensor). */
  sensor: boolean
}

/** A car's full rigid-body state as plain numbers: chassis centre, orientation, linear and angular velocity. */
export interface CarBodyState {
  x: number; y: number; z: number
  qx: number; qy: number; qz: number; qw: number
  vx: number; vy: number; vz: number
  wx: number; wy: number; wz: number
}

/** A door player 1 took: into car `car` in the state the realm took it over in, or out at a point (the room's own word for it). */
export type Door = { enter: { car: number; state: CarBodyState } } | { exit: { x: number; z: number } }

/**
 * The door player 1 took in a step, as a network room hears it (engine.ts reports it with the step): the last of the
 * step's own doors (an entered event the realm did not make for a room correction, an exited event no teleport or
 * correction forced), unless a correction came after it (the room's truth then stands). Undefined for none.
 */
export function doorOf(events: readonly SimEvent[]): Door | undefined {
  let door: Door | undefined
  for (const e of events) {
    if (e.e === 'entered' && e.player === 0) door = e.room ? undefined : { enter: { car: e.index, state: e.state } }
    else if (e.e === 'exited' && e.player === 0) door = e.forced ? undefined : { exit: { x: e.x, z: e.z } }
  }
  return door
}

/** The command player 1's car ran this step (the bouncer's vetted throttle, brake and steer, and the handbrake). */
export interface WheelsState { throttle: number; brake: number; steer: number; handbrake: boolean }

export type SimEvent =
  /**
   * `state`: the car's full state the moment the player took the wheel, before this step's substeps (what a network
   * room's authority takes over). `room`: the room's correction seated them (netCar), not the player.
   */
  | { e: 'entered'; player: number; index: number; heading: number; suv: boolean; kind: number; state: CarBodyState; room?: boolean }
  /** `forced`: a teleport or a network room's correction took the player out (no door of theirs). */
  | { e: 'exited'; player: number; x: number; z: number; heading: number; forced?: boolean }
  | { e: 'rejected'; reason: string }
  /** The answer to a recruit command: who is coming over (distance at the request, m), or why nobody is. */
  | { e: 'recruit'; id: number; ok: true; agent: number; skill: string; distance: number }
  | { e: 'recruit'; id: number; ok: false; skill: string; reason: string }
  /** A recruit reached the operator and stopped: Active, tethered from now on, with every skill they have. */
  | { e: 'active'; agent: number; skill: string; skills: string[] }
  /** A recruit went back to their day, and why. */
  | { e: 'released'; agent: number; skill: string; reason: string }
  /** The answer to a rally command: the recruit is walking to the point, or why not. */
  | { e: 'rally'; agent: number; ok: boolean; reason?: string }

export interface SimPhysicsStats {
  /** EMA of one world.step(), ms. */
  stepMs: number
  steps: number
  bodies: number
  colliders: number
  ccd: number
  /** EMA of the whole step request in the worker (controls, vetting, substeps, audit, packing), ms. */
  workerMs: number
}

/** The pedestrians as the worker reports them. */
export interface CrowdState {
  stats: CrowdSimStats
  /** How old the hazard readings the Bouncer used this step were, ms of simulation time (null: no crowd). */
  ageMs: number | null
  /** Wall time from a crowd step's dispatch to its readback in the worker, ms (EMA). */
  lagMs: number
}

/**
 * Someone the operator asked over, as the worker tracks them. From the request they are Interviewing, walking over;
 * once they have reached the operator they are Active (`arrived` true): tethered, following the operator and stopping
 * INTERVIEW_DISTANCE away each time, until the operator walks RELEASE_DISTANCE off, drives off, or dismisses them.
 */
export interface RecruitView {
  agent: number
  /**
   * This realm's number for this recruitment, never reused: the same person asked over again is a new tether with a
   * new serial (a task lease binds to the tether, 08_Swarm/taskRouter.ts, not to the person).
   */
  serial: number
  skill: string
  state: 'Interviewing' | 'Active'
  arrived: boolean
  /** Every skill they have (skills.ts skillsOf), the one they were asked for first: what an Active recruit brings. */
  skills: string[]
  /** Metres from the operator, and where they stand, in the newest reading (NaN until one has measured them). */
  distance: number
  x: number
  z: number
  /** Seconds since the request. */
  seconds: number
  /** The sidewalk point an Active recruit was asked to walk to, while that rally is in force (absent otherwise). */
  rally?: { x: number; z: number }
}

/** The worker's reply to every step: plain numbers only. */
export interface StepState {
  t: 'state'
  id: number
  /** Worker simulation seconds (its own clock, from the clamped dt it accepted): the signals run on it. */
  simTime: number
  poses: Float32Array
  /** Player 0 (the operator): the same values as avatars[0]. */
  avatar: AvatarState
  /** Index of the car player 0 drives, or −1 on foot: the same value as drivings[0]. */
  driving: number
  /** What player 0's car ran this step (null on foot): a network room replays it. */
  wheels: WheelsState | null
  /** Every avatar the realm holds, index = player (meta.players of them). */
  avatars: AvatarState[]
  /** Per player, the index of the car they drive, or −1 on foot. */
  drivings: number[]
  kernel: KernelStats
  physics: SimPhysicsStats
  tuning: CarTuning
  /** Brake the wheels received / max, whether the L2 limiter withheld throttle, and a First-Law or full-brake edge. */
  haptics: { trigger: number; limited: boolean; thump: boolean }
  events: SimEvent[]
  crowd: CrowdState
  /**
   * The newest pedestrian render state since the last reply, or null: every pos, then every vel, then every pose
   * (12 floats per agent), transferred. The page only draws it; the Bouncer reads the worker's own buffers.
   */
  crowdFrame: Float32Array | null
  /**
   * The scheduled craft (TRACK_POSE, `meta.craft` of them) where the realm's clock has them this step, transferred;
   * null with tracks off, and from a halted realm (its clock has stopped, and a buffer that halted it never leaves).
   */
  craft: Float32Array | null
  /**
   * The promoted pedestrians' rigs (RIG_POSE, `meta.rigSlots` slices, empty slots with agent −1) as this step left
   * them, transferred; null with the ragdoll off, in a region, and from a halted realm.
   */
  rigs: Float32Array | null
  /** Everyone the operator has asked over and not yet released. */
  recruits: RecruitView[]
  /** Messages and commands the worker refused since it started. */
  rejected: number
  /** True while a harness has person sensing blinded. */
  blind: boolean
}

/**
 * The page's zero-copy bridge (07_Execute_Actions/sharedBridge.ts), sent once after `ready`: a SharedArrayBuffer of
 * exactly the layout the worker's meta implies (bridgeBytes of count, players, agents), which the realm fills after
 * every step with every vehicle's, avatar's and pedestrian's x, y, z and state. Anything else is refused and counted.
 * Only on a cross-origin isolated page: elsewhere the page keeps a plain buffer of its own and fills it itself.
 */
export interface SimBridge { t: 'bridge'; buffer: SharedArrayBuffer }

export interface SimReady { t: 'ready'; meta: SimMeta }
export interface SimPanic { t: 'panic'; reason: string }
/**
 * Why the realm could not start, when the worker can tell (the recovery card words it: bootFailure.ts): no WebGPU
 * inside the worker although the page has it, or no WebAssembly for Rapier.
 */
export type SimFailureCode = 'worker-gpu' | 'wasm'
export const SIM_FAILURE_CODES: readonly SimFailureCode[] = Object.freeze(['worker-gpu', 'wasm'])
/** The realm could not start (`init: …`); `code` when the worker knows the class of the failure. */
export interface SimFailure { t: 'error'; message: string; code?: SimFailureCode }

/** An Error carrying a SimFailureCode (the worker throws it; simHost forwards the code; SimClient keeps it). */
export function coded(code: SimFailureCode, message: string): Error & { code: SimFailureCode } {
  return Object.assign(new Error(message), { code })
}

/** The SimFailureCode an error carries, or undefined (a DOMException's numeric `code` is not one). */
export function failureCode(e: unknown): SimFailureCode | undefined {
  const c = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
  return SIM_FAILURE_CODES.includes(c as SimFailureCode) ? (c as SimFailureCode) : undefined
}

export type ToWorker = SimInit | SimBridge | StepRequest
export type FromWorker = SimReady | StepState | SimPanic | SimFailure
