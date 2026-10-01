/**
 * Why does this file exist? It is the whole physical simulation as one object with a plain-data interface,
 * built to live alone in the physics worker (physics.worker.ts): the Rapier world, the fleet and its
 * Ring-0 Bouncer, the avatars (up to MAX_PLAYERS local players, each a person to the Sanctuary, the Bouncer and
 * the audit; player 0 is the operator), the Sanctuary, the Ring-0 auditor, and the GPU pedestrian crowd that senses
 * for the Bouncer (a CrowdSensor on the worker's own device, crowdSim.ts). One step() takes the page's input
 * as numbers (controls and queued commands, nothing about pedestrians or time) and runs: commands, sensing
 * (every avatar exactly, the crowd's newest readings aged for how stale they are), vetted controls, AI drivers,
 * the fixed substeps (Sanctuary, avatars, wheels), then the audit, synchronously after the last substep and in
 * the same realm (including the crowd's own Ring-0 flags), then the crowd's next step, and only then packs the
 * poses and the pedestrians' render state the page may draw. The ragdoll balance machine runs here as well
 * (ragdollRealm.ts): on the realm's own crowd readout a shove, a kerb trip or a slip near the operator promotes a
 * pedestrian to a Rapier rig whose every shape is a Sanctuary ward and an audit person, handed back on recovery;
 * the rig stream leaves with the poses. Recruitment is decided here too: a request is
 * checked against this realm's own readings of the crowd (earshot, the sidewalk, the skill), the person is asked
 * over through the crowd's summon slots, becomes Active (tethered: following the operator) on arrival, and is released
 * when the operator walks off, drives off or dismisses them. Nothing it returns is a reference into it. It
 * imports no DOM, no worker API and no GPU code, so the node tests drive it directly with a stand-in sensor.
 * What breaks if it is removed? The worker has nothing to run, and the page has no simulation.
 */
import { CITY, CITY_SIZE, inLot } from '../01_Initialize_World/city.ts'
import { KERNEL } from '../02_Define_The_Rules/civic.ts'
import { auditCraft, panicReason, RING0, Ring0Auditor, type AuditPerson, type AuditVehicle } from '../02_Define_The_Rules/ring0.ts'
import type { KernelStats } from '../05_Observe_Environment/telemetry.ts'
import { CAR, CAR_TUNE_RANGE, type CarTuning } from './car.ts'
import { Physics } from './physics.ts'
import { Avatar } from './player.ts'
import { Sanctuary, type Nudge } from './sanctuary.ts'
import { Fleet, type Person, type Vehicle } from './vehicles.ts'
import { TrackFleet } from './trackFleet.ts'
import { RagdollRealm } from './ragdollRealm.ts'
import { buildTrackNetwork } from '../06_Make_Decisions/tracks.ts'
import { AGENTS_RANGE, MAX_CARS, PEDESTRIAN_MAX_SPEED, type CrowdSensor, type Summon } from '../03_Spawn_Agents/crowdSensor.ts'
import {
  ACTIVITY, APPROACH_SECONDS, AUDIBLE_RADIUS, eligible, findRecruit, RALLY_RANGE, RECRUIT_SLOTS, RECRUITING_PLAYER, RELEASE_DISTANCE, skillNamed, skillsOf, whyNot, whyNotRally,
  type Skill,
} from '../03_Spawn_Agents/skills.ts'
import type { Intent } from '../02_Define_The_Rules/laws.ts'
import {
  ENTER_RANGE, footWish, MAX_PLAYERS, RIG_SLOTS, type AvatarState, type DriveControls, type FootControls, type PlayerControls, type RecruitView, type SimCommand,
  type SimEvent, type SimInit, type SimMeta, type StepState,
} from './simProtocol.ts'

/** Longest step accepted, s (a page that skipped frames sends the sum; the physics caps its own substeps). */
const MAX_DT = 0.1
/** Commands applied per step; the rest of a flood is refused. */
const MAX_COMMANDS = 64
/** A harness may blind person sensing for at most this long, ms. */
const MAX_BLIND_MS = 20_000
/** How long the crowd may take to deliver its first reading at boot, ms. */
const CROWD_PRIME_MS = 10_000
/**
 * Beyond this age (s) a crowd reading is not trusted at all: every car is fed a person at the bumper and holds
 * until the sensor answers again. Younger readings are shortened continuously (#feedHazards).
 */
const CROWD_STALE_S = 1.0
/**
 * A summons the crowd has not taken this long after it was sent, s, was not heard: the person had stepped onto a
 * crosswalk or out of earshot in the moment the request crossed the realms. They are let go.
 */
const SUMMON_GRACE_S = 1.0
const ZERO_NUDGE: Nudge = Object.freeze({ dx: 0, dz: 0 })
const TUNING_KEYS = Object.keys(CAR_TUNE_RANGE) as (keyof CarTuning)[]
/** How far past a building lot's edge a spawn inside one is moved, m (onto the sidewalk; #interact exits with 0.4). */
const LOT_PAD = 0.4
const IDLE_FOOT: FootControls = Object.freeze({ x: 0, z: 0, heading: NaN })
const IDLE_DRIVE: DriveControls = Object.freeze({ steer: 0, fwd: 0, back: 0, handbrake: false })

export type SimCoreOptions = Omit<SimInit, 't'>

/** How far a region's containment slab reaches past its bounds, m: its ground tiles reach 100 m past the edge wall. */
const REGION_SLAB_MARGIN = 200

/** Builds the realm's GPU pedestrian sensor (the worker passes crowdSim.ts on its own device; tests pass stand-ins). */
export type CrowdFactory = (agents: number) => Promise<CrowdSensor>

/** One step's input after the host has checked its shape (every number is still clamped here). */
export interface StepInput {
  dt: number
  foot: FootControls
  drive: DriveControls
  /** Players 1..3 (index k − 1 for player k), shape-checked by the host to records; a missing entry is idle. */
  players?: readonly Partial<PlayerControls>[]
  cmds: readonly unknown[]
}

/** What one player's controls gave the page to feel this step (reported for player 0). */
interface Haptics { trigger: number; limited: boolean; thump: boolean }

/** Someone the operator asked over. */
interface Recruit {
  /** The page's request number, echoed in the answer. */
  id: number
  /** This realm's number for the recruitment (RecruitView.serial): counted here, never reused. */
  serial: number
  agent: number
  skill: Skill
  /** Every skill they have, `skill` first. */
  skills: Skill[]
  /** This realm's clock at the request, and the last crowd step dispatched before it (the next one carries the summons). */
  since: number
  seq: number
  /** When they reached the operator and became Active (-1: still coming, Interviewing). */
  arrivedAt: number
  /** Metres from the operator, and where they stand, in the newest reading. */
  distance: number
  x: number
  z: number
  /** The sidewalk point this (Active) recruit walks to instead of the operator, while a rally is in force. */
  rally: { x: number; z: number } | null
}

const finite = (n: unknown, fallback = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : fallback)
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

/**
 * A spawn inside one of the city's building lots, moved onto the nearest sidewalk (a person cannot start inside a
 * building); anywhere else it is kept as it is. The city only: a surveyed region has no lots.
 */
function offLot(x: number, z: number): { x: number; z: number } {
  if (!inLot(x, z, LOT_PAD)) return { x, z }
  const cx = (Math.floor(x / CITY.pitch) + 0.5) * CITY.pitch, cz = (Math.floor(z / CITY.pitch) + 0.5) * CITY.pitch
  const dx = x - cx, dz = z - cz
  const out = CITY.lotHalf + LOT_PAD + 1
  if (Math.abs(dx) >= Math.abs(dz)) return { x: cx + (dx < 0 ? -out : out), z }
  return { x, z: cz + (dz < 0 ? -out : out) }
}

export class SimCore {
  readonly meta: SimMeta
  readonly #physics: Physics
  readonly #fleet: Fleet
  /** The scheduled craft (train sets, drones, planes) on the city's corridors: with tracks on, in the city only. */
  readonly #craft: TrackFleet | null
  /** Every player's body, index = player: Sanctuary ward k and audit person k. */
  readonly #avatars: readonly Avatar[]
  readonly #sanctuary: Sanctuary
  /** The ragdoll balance machine over the pedestrians near the operator (ragdoll on, in the city, with a crowd), or null. */
  readonly #realm: RagdollRealm | null
  /** Centred on the city, or on a region with a slab that holds it (and a margin). */
  readonly #auditor: Ring0Auditor
  readonly #debug: boolean
  /** The GPU pedestrians and their First-Law sensing (null only in tests without a crowd). */
  readonly #crowd: CrowdSensor | null
  /** Per player: the car they drive, or null on foot. */
  readonly #driving: (Vehicle | null)[]
  /** This realm's own clock (the sum of accepted dt): harness time limits never trust the page's clock. */
  #simTime = 0
  #blindUntil = -1
  #panic: string | null = null
  #sanctuaryOn = true
  readonly #hazardOverride = new Map<number, number>()
  readonly #hazardAhead: Float32Array
  readonly #hazardBehind: Float32Array
  readonly #noHazards: Float32Array
  #preVel: Float32Array
  readonly #auditVehicles: AuditVehicle[] = []
  /** One audit person per avatar, id = player; then one per rig shape (ragdollRealm.ts PERSON_ID_BASE and up). */
  readonly #auditPeople: AuditPerson[]
  /** Per player: the walking velocity asked for this step, clamped. */
  readonly #wish: { x: number; z: number }[]
  /** Per player: the way their body faces (the page's view heading); player 0's turns that figure in the crowd. */
  readonly #bodyHeading: number[]
  /** Everyone the fleet sees this step (scratch for setPeople): per player, then one per rig. */
  readonly #people: Person[]
  #crowdAgeMs: number | null = null
  /** Number of the last crowd step dispatched; every readback echoes the number of the step it measured. */
  #crowdSeq = 0
  /** Per car: metres driven since boot (|chassis speed| at each substep's start × h), on this realm's clock. */
  readonly #odo: Float64Array
  /** Per crowd step dispatched: when, and every car's odometer then (the reading it returns measured the cars there). */
  readonly #dispatches: { seq: number; time: number; odo: Float64Array }[] = []
  /** Per car: the last crowd step dispatched before the car was moved by a recover (readings up to it describe another street). */
  readonly #movedSeq: Float64Array
  /** Scripted intents this step, per car: vetted after this step's sensing, like the player's own controls. */
  readonly #intents = new Map<number, Intent>()
  readonly #pos = { x: 0, y: 0, z: 0 }
  readonly #vel = { x: 0, y: 0, z: 0 }
  /** Per player: the First-Law hold and the full-brake edge last step (for the thump). */
  readonly #holdWas: boolean[]
  readonly #fullBrakeWas: boolean[]
  #events: SimEvent[] = []
  /** Everyone the operator has asked over (at most RECRUIT_SLOTS), and their summons as the crowd receives them. */
  readonly #recruits: Recruit[] = []
  /** The last recruitment serial given out. */
  #serial = 0
  readonly #summons: Summon[] = []
  #rejected = 0
  #workerMs = 0

  private constructor(physics: Physics, o: SimCoreOptions, crowd: CrowdSensor | null) {
    this.#physics = physics
    this.#crowd = crowd
    this.#debug = o.debug === true
    const r = o.region?.bounds
    this.#auditor = r
      ? new Ring0Auditor({ x: (r.x0 + r.x1) / 2, z: (r.z0 + r.z1) / 2 }, { extent: Math.max(r.x1 - r.x0, r.z1 - r.z0) / 2 + REGION_SLAB_MARGIN })
      : new Ring0Auditor({ x: CITY_SIZE / 2, z: CITY_SIZE / 2 })
    // The Rapier handles leave the Fleet only for the debug fault-injection commands (dbgVelocity).
    // On tracks, the network is built here from the seed: nothing about the routes crosses from the page.
    const network = o.tracks === true ? buildTrackNetwork(o.seed) : null
    this.#fleet = new Fleet(physics, o.cars, o.seed, { exposeRig: this.#debug, network: network ?? undefined })
    // The corridors are laid over the city's grid: a surveyed region has no elevated loop and no racetrack over it.
    this.#craft = network && !r ? new TrackFleet(network) : null
    // Every player's body, in player order: Sanctuary ward k and audit person k are player k.
    const spawns = [o.spawn, ...(o.spawns ?? [])]
    this.#avatars = Object.freeze(spawns.map((p) => new Avatar(physics, p.x, p.z)))
    this.#sanctuary = new Sanctuary(physics.world)
    for (const a of this.#avatars) this.#sanctuary.register(a.person)
    // The ragdoll realm registers its wards after the avatars (ward k is player k; a rig's come later, by index).
    this.#realm = o.ragdoll === true && !r && crowd ? new RagdollRealm(physics, this.#sanctuary, o.seed, crowd.agentCount) : null
    const players = this.#avatars.length
    this.#driving = this.#avatars.map(() => null)
    this.#wish = this.#avatars.map(() => ({ x: 0, z: 0 }))
    this.#bodyHeading = this.#avatars.map(() => 0)
    this.#holdWas = this.#avatars.map(() => false)
    this.#fullBrakeWas = this.#avatars.map(() => false)
    this.#people = this.#avatars.map(() => ({ x: 0, z: 0, present: false }))
    this.#auditPeople = this.#avatars.map((_, k) => ({ id: k, x: 0, y: 0, z: 0, solid: true }))
    const n = this.#fleet.vehicles.length
    this.#hazardAhead = new Float32Array(n).fill(Infinity)
    this.#hazardBehind = new Float32Array(n).fill(Infinity)
    this.#noHazards = new Float32Array(n).fill(Infinity)
    this.#preVel = new Float32Array(2 * n)
    this.#odo = new Float64Array(n)
    this.#movedSeq = new Float64Array(n).fill(-1)
    this.meta = Object.freeze({
      count: n,
      agents: crowd ? crowd.agentCount : 0,
      suv: this.#fleet.vehicles.map((v) => v.suv),
      paint: [...this.#fleet.paint],
      person: { radius: this.#avatars[0].person.radius, halfHeight: this.#avatars[0].person.halfHeight },
      debug: this.#debug,
      craft: this.#craft?.count ?? 0,
      players,
      rigSlots: this.#realm ? RIG_SLOTS : 0,
    })
    Object.freeze(this)
  }

  /**
   * Builds the world and, with `makeCrowd`, the GPU crowd, then primes the crowd: its first step is read back
   * before this resolves, so the Bouncer never runs a step without a pedestrian reading.
   */
  static async create(o: SimCoreOptions, makeCrowd: CrowdFactory | null = null): Promise<SimCore> {
    // No car the GPU cannot sense: the fleet is never larger than the hazard slots.
    const cars = Math.floor(finite(o.cars))
    if (!(cars >= 0 && cars <= MAX_CARS)) throw new Error(`cars must be 0–${MAX_CARS}, got ${o.cars}`)
    const [lo, hi] = AGENTS_RANGE
    const agents = Math.floor(finite(o.agents, lo))
    if (makeCrowd && !(agents >= lo && agents <= hi)) throw new Error(`agents must be ${lo}–${hi}, got ${o.agents}`)
    const spawn = { x: finite(o.spawn?.x, CITY_SIZE / 2), z: finite(o.spawn?.z, CITY_SIZE / 2) }
    // Players 1..3: each a finite pair (anything else is refused, like a malformed region), and in the city never
    // inside a building lot.
    const extra = o.spawns ?? []
    if (!Array.isArray(extra) || extra.length > MAX_PLAYERS - 1) throw new Error(`spawns must list at most ${MAX_PLAYERS - 1} players`)
    const spawns = extra.map((p, k) => {
      const x = finite(p?.x, NaN), z = finite(p?.z, NaN)
      if (Number.isNaN(x) || Number.isNaN(z)) throw new Error(`spawns[${k}] must be a finite x, z pair`)
      return o.region ? { x, z } : offLot(x, z)
    })
    const physics = await Physics.create(o.boxes, o.furniture, o.region ?? null)
    const crowd = makeCrowd ? await makeCrowd(agents) : null
    physics.streamAt(spawn.x, spawn.z)
    for (const p of spawns) physics.streamAt(p.x, p.z)
    const core = new SimCore(physics, { ...o, cars, agents, seed: Math.floor(finite(o.seed)) >>> 0, spawn, spawns }, crowd)
    if (crowd) {
      core.#stepCrowd(0)
      const t0 = now()
      while (crowd.readout === null) {
        if (crowd.lost) throw new Error(`pedestrian sensing failed to start: ${crowd.lost}`)
        if (now() - t0 > CROWD_PRIME_MS) throw new Error('pedestrian sensing failed to start: no reading from the GPU')
        await new Promise((r) => setTimeout(r, 1))
      }
    }
    return core
  }

  get halted(): boolean {
    return this.#panic !== null
  }

  get panic(): string | null {
    return this.#panic
  }

  /** A render frame's buffer the page handed back, for the crowd to fill again. */
  recycleCrowd(buffer: unknown): void {
    if (buffer instanceof ArrayBuffer) this.#crowd?.recycle(buffer)
  }

  /** Counts a refused message or command (the host calls this for malformed messages). */
  noteRejected(reason: string): void {
    this.#rejected++
    if (this.#events.length < 16) this.#events.push({ e: 'rejected', reason })
  }

  /** Stops the simulation for good (a panic, or a fault in this realm). The first reason stands. */
  halt(reason: string): void {
    if (this.#panic !== null) return
    this.#panic = reason
    this.#auditor.markPanic(reason)
  }

  /**
   * One frame: commands, sensing, vetted controls, AI, the fixed substeps, the Ring-0 audit, then the packed
   * state. After a panic it changes nothing and reports the frozen state. `craft` is the buffer the scheduled
   * craft are packed into (meta.craft slices; the host sizes it): it is returned filled from a running realm with
   * tracks on, and null otherwise (a halted realm's clock has stopped, and a buffer that halted it never leaves).
   * `rigs` is the buffer the promoted pedestrians' rigs are packed into (meta.rigSlots slices): returned filled from
   * a running realm with the ragdoll on, after the audit has checked every shape, and null otherwise.
   */
  step(input: StepInput, poses: Float32Array, craft: Float32Array | null = null, rigs: Float32Array | null = null): Omit<StepState, 't' | 'id'> {
    const t0 = now()
    let haptics: Haptics = { trigger: 0, limited: false, thump: false }
    let craftOut: Float32Array | null = null
    let rigsOut: Float32Array | null = null
    // A crowd that can no longer see anyone leaves the Bouncer blind to pedestrians: that is a broken kernel.
    if (this.#panic === null && this.#crowd?.lost) this.halt(`Sensing Failure: pedestrian sensing stopped (${this.#crowd.lost}).`)
    if (this.#panic === null) {
      const dt = clamp(finite(input.dt), 0, MAX_DT)
      this.#simTime += dt
      // One clock for every signal in the city: the cars', the crowd's, and the lights the page draws (from simTime).
      const signalTime = this.#simTime
      const cmds = input.cmds
      for (let i = 0; i < cmds.length; i++) {
        if (i >= MAX_COMMANDS) { this.noteRejected(`command flood: ${cmds.length - MAX_COMMANDS} dropped`); break }
        try {
          this.#command(cmds[i])
        } catch (e) {
          this.noteRejected(message(e))
        }
      }
      const fleet = this.#fleet, avatars = this.#avatars, driving = this.#driving

      // Everyone the First Law protects, as the fleet will see them this step: every avatar on foot, exactly.
      const blind = this.#simTime < this.#blindUntil
      const people = this.#people
      for (let k = 0; k < avatars.length; k++) {
        people[k].x = avatars[k].x
        people[k].z = avatars[k].z
        people[k].present = driving[k] === null && !blind
      }
      // And every promoted pedestrian's rig (its pelvis), exactly, as long as it stands.
      people.length = this.#realm ? this.#realm.peopleInto(people, avatars.length, !blind) : avatars.length
      fleet.setPeople(people)
      if (blind) fleet.setPersonHazards(this.#noHazards, this.#noHazards)
      else this.#feedHazards()
      // Scripted intents are ruled on this step's sensing (as the players' controls below are), never on the
      // previous step's: a setMode or interact later in the same batch still wins.
      for (const [i, cmd] of this.#intents) {
        const v = fleet.vehicles[i]
        if (!driving.includes(v) && v.mode === 'player') fleet.drive(v, cmd, false)
      }
      this.#intents.clear()

      // Player 0's controls are foot and drive; players 1..3 ride in `players` (a missing entry is idle). The
      // haptics reported are player 0's.
      haptics = this.#control(0, input.foot, input.drive, dt)
      const extra = input.players
      for (let k = 1; k < avatars.length; k++) {
        const c = extra?.[k - 1]
        this.#control(k, c?.foot ?? IDLE_FOOT, c?.drive ?? IDLE_DRIVE, dt)
      }

      fleet.think(dt, signalTime)
      // The ragdoll realm reads this realm's own crowd readout: a shove, a kerb trip or a slip near the operator (on
      // foot or at the wheel) is offered to the pool; the next substep builds the rig. Never a vehicle.
      if (this.#realm) {
        const v = driving[0]
        const op = v !== null ? fleet.position(v, this.#pos) : { x: avatars[0].x, z: avatars[0].z }
        this.#realm.observe(this.#crowd?.readout ?? null, op.x, op.z, fleet.footprints())
      }
      // Pre-step velocities for the audit's IMPACT test (a contact resolves inside the step it happens in).
      this.#capturePreStep()
      // A region streams its walls around every player (the car driven, or the avatar): built before this step solves.
      for (let k = 0; k < avatars.length; k++) {
        const v = driving[k]
        if (v !== null) {
          const p = fleet.position(v, this.#pos)
          this.#physics.streamAt(p.x, p.z)
        } else {
          this.#physics.streamAt(avatars[k].x, avatars[k].z)
        }
      }
      const wish = this.#wish
      this.#physics.step(dt, (h) => {
        // The rigs first: the pool steps, rigs are removed and built, so the guard sweeps every shape as it now is.
        this.#realm?.tend(h)
        // Sanctuary next: a person a vehicle is about to reach becomes a sensor before this step solves. Its nudges
        // are index-aligned with the wards, registered in player order, then the rigs' shapes.
        const nudges = this.#sanctuaryOn ? this.#sanctuary.guard(fleet.footprints(), h) : null
        for (let k = 0; k < avatars.length; k++) {
          if (driving[k] !== null) continue
          const n = nudges?.[k] ?? ZERO_NUDGE
          avatars[k].nudge(n.dx, n.dz)
          avatars[k].move(wish[k].x, wish[k].z, h)
        }
        // The rigs' gains, shields and nudges, then their powered joints.
        this.#realm?.drive(h, nudges)
        fleet.updateControllers(h)
        // The odometer: how far each car can have driven since any crowd reading (the speed at the substep's
        // start never undercounts a braking car).
        for (let i = 0; i < this.#odo.length; i++) this.#odo[i] += Math.abs(fleet.speed(fleet.vehicles[i])) * h
      })
      // The scheduled craft where this realm's clock has them: packed before the audit, which reads the buffer.
      if (this.#craft && craft) craftOut = this.#craft.writePoses(this.#simTime, craft)
      // RING-0 AUDIT SITE: in this realm, synchronously after the last substep, before any state leaves it.
      this.#ring0Audit(this.#crowd ? this.#crowd.takeFlags() : 0, craftOut)
      // The crowd steps on this step's outcome: the cars where they now are, the avatar, this clock, the summons.
      if (this.#panic === null) {
        this.#tendRecruits()
        this.#stepCrowd(dt)
        // The rigs as the audit checked them: packed only now, from a realm still running.
        if (this.#realm && rigs) rigsOut = this.#realm.write(rigs)
      }
    }
    this.#fleet.writePoses(poses)
    const ms = now() - t0
    this.#workerMs = this.#workerMs === 0 ? ms : this.#workerMs * 0.9 + ms * 0.1
    const events = this.#events
    this.#events = []
    const st = this.#physics.stats
    const avatars = this.#avatars.map((_, k) => this.#avatarState(k))
    const drivings = this.#driving.map((v) => (v ? v.index : -1))
    return {
      simTime: this.#simTime,
      poses,
      avatar: avatars[0],
      driving: drivings[0],
      avatars,
      drivings,
      kernel: this.#kernelStats(),
      physics: { stepMs: st.stepMs, steps: st.steps, bodies: st.bodies, colliders: st.colliders, ccd: st.ccd, workerMs: this.#workerMs },
      tuning: { ...this.#fleet.tuning },
      haptics,
      crowd: {
        stats: { ...(this.#crowd?.readout?.stats ?? { nudges: 0, waiting: 0, crossing: 0, retreating: 0 }) },
        ageMs: this.#crowdAgeMs,
        lagMs: (this.#crowd as { lagMs?: number } | null)?.lagMs ?? 0,
      },
      // A frame ships only from a realm that is still running: its flags were audited in this very step (they
      // arrive with it), so a frame whose flags halted the realm never leaves it.
      crowdFrame: this.#crowd && this.#panic === null ? this.#crowd.takeFrame() : null,
      craft: this.#panic === null ? craftOut : null,
      rigs: this.#panic === null ? rigsOut : null,
      recruits: this.#recruits.map((r): RecruitView => ({
        agent: r.agent, serial: r.serial, skill: r.skill, state: r.arrivedAt >= 0 ? 'Active' : 'Interviewing', arrived: r.arrivedAt >= 0,
        skills: [...r.skills], distance: r.distance, x: r.x, z: r.z,
        seconds: this.#simTime - r.since,
        ...(r.rally ? { rally: { x: r.rally.x, z: r.rally.z } } : {}),
      })),
      events,
      rejected: this.#rejected,
      blind: this.#simTime < this.#blindUntil,
    }
  }

  /**
   * Player k's controls this step: on foot the desired walking velocity, never faster than a run, and the way their
   * body faces; in a car the wheel and pedals, clamped, L2-limited and vetted by the Bouncer. Returns what the
   * trigger should feel (the brake the wheels received, the limiter, a First-Law or full-brake edge).
   */
  #control(k: number, foot: FootControls | undefined, drive: DriveControls | undefined, dt: number): Haptics {
    const fleet = this.#fleet
    const v = this.#driving[k]
    let trigger = 0, limited = false, thump = false
    if (v === null) {
      // On foot: the desired walking velocity, never faster than a run (footWish: the mirror clamps the same way).
      const w = footWish(finite(foot?.x), finite(foot?.z))
      const wish = this.#wish[k]
      wish.x = w.x
      wish.z = w.z
      // Wrapped in f64 so the crowd's f32 uniform always holds a small angle: 1e39 is finite here and
      // Infinity there, and would turn the player's figure (and, through the grid, its neighbours) into NaN.
      const h = finite(foot?.heading, NaN)
      if (!Number.isNaN(h)) this.#bodyHeading[k] = Math.atan2(Math.sin(h), Math.cos(h))
      this.#holdWas[k] = false
      this.#fullBrakeWas[k] = false
    } else {
      const d = drive
      const steerIn = clamp(finite(d?.steer), -1, 1)
      const fwd = clamp(finite(d?.fwd), 0, 1), back = clamp(finite(d?.back), 0, 1)
      const speed = fleet.speed(v)
      const aim = steerIn * CAR.maxSteer * (1 - Math.min(0.6, Math.abs(speed) / 28))
      v.steer += (aim - v.steer) * Math.min(1, dt * 5)
      let throttle = 0, brake = 0
      if (fwd > 0) {
        if (speed < -0.5) brake = KERNEL.maxBrake * fwd
        else throttle = fwd
      }
      if (back > 0) {
        if (speed > 0.5) brake = Math.max(brake, KERNEL.maxBrake * back)
        else throttle = -0.55 * back
      }
      // Ring-0 L2 on the input, before the step: no drive further along the direction of travel within 0.5 m/s
      // of the cap, so the audit's post-step clamp stays a backstop that never has to act on a player's car.
      const asked = throttle
      if (speed >= RING0.maxVelocity - 0.5) throttle = Math.min(throttle, 0)
      else if (speed <= -(RING0.maxVelocity - 0.5)) throttle = Math.max(throttle, 0)
      limited = throttle !== asked
      // The bouncer vets the driver's intent; what reaches the wheels is what the trigger should feel.
      fleet.drive(v, { throttle, brake, steer: v.steer }, d?.handbrake === true)
      trigger = Math.min(1, v.lastCommand.brake / KERNEL.maxBrake)
      // A thump when the First Law takes the car, or when the driver stands on the brake.
      const hold = fleet.bouncer.holding(v.index)
      const fullBrake = brake >= KERNEL.maxBrake && speed > 0.5
      thump = (hold && !this.#holdWas[k]) || (fullBrake && !this.#fullBrakeWas[k])
      this.#holdWas[k] = hold
      this.#fullBrakeWas[k] = fullBrake
    }
    return { trigger, limited, thump }
  }

  #avatarState(k: number): AvatarState {
    const a = this.#avatars[k], p = a.person
    const t = a.body.translation(this.#pos)
    return {
      x: t.x, y: t.y, z: t.z, feetY: t.y - p.halfHeight - p.radius, speed: this.#driving[k] ? 0 : a.speed,
      enabled: a.collider.isEnabled(), sensor: this.#sanctuary.isSensor(k),
    }
  }

  #kernelStats(): KernelStats {
    const counts = this.#fleet.bouncer.counts
    return {
      law1: counts[1], law2: counts[2], law3: counts[3],
      sensorFlips: this.#sanctuary.flips, shielded: this.#sanctuary.shielded(), last: this.#fleet.bouncer.last,
      audit: { ...this.#auditor.stats },
    }
  }

  #car(i: unknown): Vehicle {
    const v = typeof i === 'number' && Number.isInteger(i) ? this.#fleet.vehicles[i] : undefined
    if (!v) throw new Error(`no vehicle ${String(i)} (0–${this.#fleet.vehicles.length - 1})`)
    return v
  }

  #notDriven(v: Vehicle): Vehicle {
    if (this.#driving.includes(v)) throw new Error('that car is being driven')
    return v
  }

  /**
   * Never drop a car onto a person (audit invariant 8): a car put down at (tx, tz) must clear every avatar on foot by a
   * car's half-length and a margin, or the command is refused. Players inside cars are not on foot.
   */
  #clearOfPeople(what: string, tx: number, tz: number): void {
    for (let k = 0; k < this.#avatars.length; k++) {
      const a = this.#avatars[k]
      if (this.#driving[k] === null && Math.hypot(tx - a.x, tz - a.z) < CAR.halfLength + a.person.radius + 0.5) {
        throw new Error(`${what}: a person is standing there`)
      }
    }
  }

  /** A command's player: absent is player 0; anything but an index into the avatars is malformed. */
  #player(u: unknown): number {
    if (u === undefined) return 0
    if (typeof u !== 'number' || !Number.isInteger(u) || u < 0 || u >= this.#avatars.length) {
      throw new Error(`player must be 0–${this.#avatars.length - 1}, got ${String(u)}`)
    }
    return u
  }

  /** Recruitment is player 1's alone (skills.ts RECRUITING_PLAYER): a command that names another player is refused. */
  #recruiter(cmd: SimCommand): void {
    const p = (cmd as { player?: unknown }).player
    if (p !== undefined && this.#player(p) !== RECRUITING_PLAYER) throw new Error(`${cmd.c}: only player 1 recruits`)
  }

  #debugOnly(c: string): void {
    if (!this.#debug) throw new Error(`${c}: fault injection is refused outside ?debug`)
  }

  /** One page command. Anything malformed throws; step() counts it as refused and goes on. */
  #command(raw: unknown): void {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { c?: unknown }).c !== 'string') throw new Error('malformed command')
    const cmd = raw as SimCommand
    const fleet = this.#fleet
    switch (cmd.c) {
      case 'interact': this.#interact(this.#player(cmd.player)); return
      case 'reset': {
        // Player 0's car, righted where it stands: never put down beside a player on foot (the driver is inside).
        const v = this.#driving[0]
        if (!v) return
        const at = fleet.position(v, this.#pos)
        this.#clearOfPeople('reset', at.x, at.z)
        fleet.recover(v)
        return
      }
      case 'teleport': {
        const k = this.#player(cmd.player)
        const x = finite(cmd.x, NaN), z = finite(cmd.z, NaN)
        if (Number.isNaN(x) || Number.isNaN(z)) throw new Error('teleport: x and z must be finite')
        if (this.#driving[k]) this.#interact(k)
        this.#avatars[k].teleport(x, z)
        return
      }
      case 'setMode': {
        const v = this.#notDriven(this.#car(cmd.i))
        if (cmd.mode !== 'ai' && cmd.mode !== 'parked') throw new Error(`setMode: mode must be 'ai' or 'parked'`)
        v.mode = cmd.mode
        return
      }
      case 'recover': {
        const v = this.#car(cmd.i)
        const opt = (n: unknown): number | undefined => (n === undefined ? undefined : finite(n, NaN))
        const x = opt(cmd.x), z = opt(cmd.z), heading = opt(cmd.heading)
        if ([x, z, heading].some((n) => Number.isNaN(n))) throw new Error('recover: x, z and heading must be finite')
        const at = fleet.position(v, this.#pos)
        this.#clearOfPeople('recover', x ?? at.x, z ?? at.z)
        fleet.recover(v, x, z, heading)
        // Moved: every reading dispatched so far measured it somewhere else. It holds until one taken here lands.
        if (x !== undefined || z !== undefined || heading !== undefined) this.#movedSeq[v.index] = this.#crowdSeq
        return
      }
      case 'intent': {
        const v = this.#notDriven(this.#car(cmd.i))
        if (v.mode === 'ai') v.mode = 'player'
        // A scripted intent is a player-style command: same Bouncer, same envelope, same latch. It is ruled after
        // this step's sensing (step()), so never on a reading one step staler than the player's own controls.
        this.#intents.set(v.index, { throttle: finite(cmd.throttle), brake: finite(cmd.brake), steer: finite(cmd.steer) })
        return
      }
      case 'tune': {
        if (!TUNING_KEYS.includes(cmd.key)) throw new Error(`tune: unknown key '${String(cmd.key)}'`)
        fleet.setTuning(cmd.key, finite(cmd.value, NaN))
        return
      }
      case 'blind': {
        // Blinding person sensing weakens the kernel on purpose (a harness proving the Sanctuary alone): only a
        // ?debug worker grants it, never a production one, whoever asks. Turning it off is always allowed.
        if (cmd.on !== true) { this.#blindUntil = -1; return }
        this.#debugOnly('blind')
        const ttl = clamp(finite(cmd.ttlMs, 5000), 0, MAX_BLIND_MS)
        this.#blindUntil = this.#simTime + ttl / 1000
        return
      }
      case 'recruit': this.#recruiter(cmd); this.#recruit(cmd); return
      case 'rally': this.#recruiter(cmd); this.#rally(cmd); return
      case 'dismiss': {
        this.#recruiter(cmd)
        if (cmd.agent !== undefined && !Number.isInteger(cmd.agent)) throw new Error('dismiss: agent must be a pedestrian index')
        for (const r of [...this.#recruits]) if (cmd.agent === undefined || r.agent === cmd.agent) this.#release(r, 'dismissed')
        return
      }
      case 'dbgVelocity': {
        this.#debugOnly(cmd.c)
        const v = this.#car(cmd.i)
        fleet.rig(v).body.setLinvel({ x: finite(cmd.x), y: finite(cmd.y), z: finite(cmd.z) }, true)
        return
      }
      case 'dbgMode': {
        this.#debugOnly(cmd.c)
        const v = this.#notDriven(this.#car(cmd.i))
        if (cmd.mode !== 'ai' && cmd.mode !== 'player' && cmd.mode !== 'parked') throw new Error('dbgMode: unknown mode')
        v.mode = cmd.mode
        return
      }
      case 'dbgSanctuary': {
        this.#debugOnly(cmd.c)
        this.#sanctuaryOn = cmd.on === true
        return
      }
      case 'dbgHazard': {
        this.#debugOnly(cmd.c)
        const v = this.#car(cmd.i)
        if (cmd.ahead === null) this.#hazardOverride.delete(v.index)
        else this.#hazardOverride.set(v.index, Math.max(0, finite(cmd.ahead, Infinity)))
        return
      }
      default:
        throw new Error(`unknown command '${String((cmd as { c: unknown }).c)}'`)
    }
  }

  /**
   * A recruitment request, decided on this realm's own readings. The skill must be one the city knows (anything else
   * is malformed and refused like any bad command). The answer is a 'recruit' event either way: nobody while the
   * operator drives or stands in the road, or while RECRUIT_SLOTS people are already over; otherwise the page's pick
   * if it still qualifies here (within earshot, on the sidewalk, with a sidewalk path to the operator, the skill,
   * not already asked), else the nearest person who does, else nobody.
   */
  #recruit(cmd: Extract<SimCommand, { c: 'recruit' }>): void {
    const skill = typeof cmd.skill === 'string' ? skillNamed(cmd.skill) : null
    if (skill === null) throw new Error(`recruit: unknown skill '${String(cmd.skill)}'`)
    const id = finite(cmd.id)
    const refuse = (reason: string): void => { this.#events.push({ e: 'recruit', id, ok: false, skill, reason }) }
    const r = this.#crowd?.readout ?? null
    if (r === null) return refuse('nobody can hear you: the crowd is not running')
    const operator = this.#driving[0] ? null : { x: this.#avatars[0].x, z: this.#avatars[0].z }
    const why = whyNot(operator)
    if (why !== null || operator === null) return refuse(why ?? 'recruiting works on foot')
    if (this.#recruits.length >= RECRUIT_SLOTS) return refuse(`the swarm is full (${RECRUIT_SLOTS} people): dismiss someone first`)
    const busy = (agent: number): boolean => this.#recruits.some((x) => x.agent === agent)
    let pick: { agent: number; distance: number } | null = null
    if (typeof cmd.agent === 'number' && !busy(cmd.agent)) {
      const d = eligible(r.xz, cmd.agent, operator, skill)
      if (d >= 0) pick = { agent: cmd.agent, distance: d }
    }
    pick ??= findRecruit(r.xz, operator, skill, busy)
    if (pick === null) return refuse(`nobody within ${AUDIBLE_RADIUS} m on this side of the street knows ${skill}`)
    this.#recruits.push({
      id, serial: ++this.#serial, agent: pick.agent, skill, skills: [skill, ...skillsOf(pick.agent).filter((s) => s !== skill)], since: this.#simTime, seq: this.#crowdSeq, arrivedAt: -1, distance: pick.distance,
      x: r.xz[2 * pick.agent], z: r.xz[2 * pick.agent + 1], rally: null,
    })
    this.#events.push({ e: 'recruit', id, ok: true, agent: pick.agent, skill, distance: pick.distance })
  }

  /**
   * A rally request, decided on this realm's own readings: Active recruit `agent` is asked to walk to the sidewalk
   * point (x, z) instead of to the operator. A malformed one (no pedestrian number, a non-finite point) is refused like
   * any bad command; otherwise the answer is a 'rally' event: no while the operator drives, for someone not over or
   * still walking over (only an Active recruit is sent anywhere), for a point in the road, farther than RALLY_RANGE
   * from the operator, or with no sidewalk path from where the recruit stands (skills.ts whyNotRally); yes otherwise,
   * and the next crowd step's summons points them at it. Nothing here promotes, demotes, places or releases anyone.
   */
  #rally(cmd: Extract<SimCommand, { c: 'rally' }>): void {
    if (!Number.isInteger(cmd.agent)) throw new Error('rally: agent must be a pedestrian index')
    const x = finite(cmd.x, NaN), z = finite(cmd.z, NaN)
    if (Number.isNaN(x) || Number.isNaN(z)) throw new Error('rally: x and z must be finite')
    const agent = cmd.agent
    const refuse = (reason: string): void => { this.#events.push({ e: 'rally', agent, ok: false, reason }) }
    const r = this.#crowd?.readout ?? null
    if (r === null) return refuse('the crowd is not running')
    const operator = this.#driving[0] ? null : { x: this.#avatars[0].x, z: this.#avatars[0].z }
    if (operator === null) return refuse('rallying works on foot')
    const rec = this.#recruits.find((q) => q.agent === agent)
    if (!rec) return refuse('nobody by that number was asked over')
    if (rec.arrivedAt < 0) return refuse('they are still walking over: only an Active recruit is sent to a rally point')
    const why = whyNotRally(operator, r.xz, agent, x, z)
    if (why !== null) return refuse(why)
    rec.rally = { x, z }
    this.#events.push({ e: 'rally', agent, ok: true })
  }

  #release(r: Recruit, reason: string): void {
    const k = this.#recruits.indexOf(r)
    if (k < 0) return
    this.#recruits.splice(k, 1)
    this.#events.push({ e: 'released', agent: r.agent, skill: r.skill, reason })
  }

  /**
   * Each recruit against the newest reading taken since they were asked (it carried their summons): Active when the
   * crowd first reports them stopped at the operator (ACTIVITY.interviewing), and tethered from then on: every step's
   * summons points at where the operator stands now, so they follow and stop INTERVIEW_DISTANCE away again, the GPU
   * keeping them on the sidewalk and a car's step back first. Let go when the crowd never took the summons, when they
   * cannot reach the operator in APPROACH_SECONDS, when the operator is more than RELEASE_DISTANCE away (the tether
   * breaks, Active or not), or when the operator drives off. Then the summons for the next crowd step.
   */
  #tendRecruits(): void {
    const r = this.#crowd?.readout ?? null
    const ax = this.#avatars[0].x, az = this.#avatars[0].z, t = this.#simTime
    for (const rec of [...this.#recruits]) {
      if (this.#driving[0]) { this.#release(rec, 'the operator drove off'); continue }
      if (r !== null && r.seq > rec.seq) {
        rec.x = r.xz[2 * rec.agent]
        rec.z = r.xz[2 * rec.agent + 1]
        rec.distance = Math.hypot(rec.x - ax, rec.z - az)
        const act = r.activity[rec.agent]
        if (act === ACTIVITY.interviewing && rec.arrivedAt < 0) {
          rec.arrivedAt = t
          this.#events.push({ e: 'active', agent: rec.agent, skill: rec.skill, skills: [...rec.skills] })
        }
        const taken = act === ACTIVITY.coming || act === ACTIVITY.interviewing || act === ACTIVITY.steppingBack
        if (!taken && rec.arrivedAt < 0 && t - rec.since > SUMMON_GRACE_S) { this.#release(rec, 'they did not hear the operator'); continue }
      }
      if (rec.arrivedAt < 0 && t - rec.since > APPROACH_SECONDS) this.#release(rec, 'they could not reach the operator')
      else if (rec.distance > RELEASE_DISTANCE) this.#release(rec, 'the operator walked away')
      // A rally ends on its own once the operator has walked more than RALLY_RANGE from its point: the summons
      // points at the operator again, and the tether above (measured from the operator, never the point) is as it was.
      else if (rec.rally && Math.hypot(rec.rally.x - ax, rec.rally.z - az) > RALLY_RANGE) rec.rally = null
    }
    const summons = this.#summons
    summons.length = this.#recruits.length
    for (let k = 0; k < summons.length; k++) {
      const m = summons[k] ?? (summons[k] = { agent: 0, x: 0, z: 0, tethered: false })
      const rec = this.#recruits[k]
      // An Active recruit with a rally in force walks to its point (and the GPU holds them INTERVIEW_DISTANCE short of
      // it, as it does at the operator); everyone else walks to the operator.
      const at = rec.arrivedAt >= 0 && rec.rally ? rec.rally : null
      m.agent = rec.agent; m.x = at ? at.x : ax; m.z = at ? at.z : az; m.tethered = rec.arrivedAt >= 0
    }
  }

  /**
   * Player k enters the nearest car, or leaves the one they drive on the driver's (left) side. A car another player
   * is driving is refused (a 'rejected' event, never a silent no-op): one driver per car, one car per driver.
   */
  #interact(k: number): void {
    const fleet = this.#fleet, avatar = this.#avatars[k]
    const cur = this.#driving[k]
    if (cur) {
      const v = cur
      const t = fleet.position(v, this.#pos)
      const h = fleet.heading(v)
      const lx = Math.cos(h), lz = -Math.sin(h)
      let ex = t.x + lx * 2.1, ez = t.z + lz * 2.1
      if (inLot(ex, ez, 0.4)) { ex = t.x - lx * 2.1; ez = t.z - lz * 2.1 }
      v.mode = 'parked'
      this.#driving[k] = null
      avatar.setEnabled(true)
      avatar.teleport(ex, ez)
      avatar.heading = h
      this.#holdWas[k] = false
      this.#fullBrakeWas[k] = false
      this.#events.push({ e: 'exited', player: k, x: ex, z: ez, heading: h })
      return
    }
    const v = fleet.nearest(avatar.x, avatar.z, ENTER_RANGE)
    if (!v) return
    this.#notDriven(v)
    v.mode = 'player'
    v.steer = 0
    this.#driving[k] = v
    avatar.setEnabled(false)
    this.#events.push({ e: 'entered', player: k, index: v.index, heading: fleet.heading(v), suv: v.suv })
  }

  /**
   * The crowd's newest readings, made safe to act on however old they are. A reading measured every car where it
   * stood when that crowd step was dispatched, and every pedestrian a moment before. Since then:
   * - the car has driven whatever its odometer says (at least |speed now|·age; the First-Law envelope already
   *   absorbs speed·KERNEL.sensingLatency of it), so that distance comes off;
   * - a pedestrian can have walked PEDESTRIAN_MAX_SPEED·age toward it, so that comes off too;
   * - "nobody" only ever meant nobody within KERNEL.range: past the latency the envelope absorbs, it is a reading
   *   at the range, aged like any other (someone just beyond it can have closed in).
   * A stale reading therefore only ever brings a person nearer. A car moved (recover) since the reading, a reading
   * whose dispatch is no longer on record, or a sensor silent for CROWD_STALE_S vouches for nobody: the car holds.
   * Without a crowd (tests) nobody is sensed. Debug overrides apply last.
   */
  #feedHazards(): void {
    const vehicles = this.#fleet.vehicles
    const r = this.#crowd?.readout ?? null
    const d = r === null ? undefined : this.#dispatches.find((x) => x.seq === r.seq)
    if (this.#crowd && (r === null || d === undefined)) {
      // A crowd that has not reported (or a reading we cannot place) cannot vouch for anyone: hold.
      this.#hazardAhead.fill(0)
      this.#hazardBehind.fill(0)
      this.#crowdAgeMs = null
    } else if (r === null || d === undefined) {
      this.#hazardAhead.fill(Infinity)
      this.#hazardBehind.fill(Infinity)
      this.#crowdAgeMs = null
    } else if (this.#simTime - r.time > CROWD_STALE_S) {
      // The sensor has not answered for too long: nobody can be vouched for, so every car holds.
      this.#hazardAhead.fill(0)
      this.#hazardBehind.fill(0)
      this.#crowdAgeMs = (this.#simTime - r.time) * 1000
    } else {
      const age = Math.max(0, this.#simTime - r.time)
      this.#crowdAgeMs = age * 1000
      const walk = PEDESTRIAN_MAX_SPEED * age
      const carAge = Math.max(0, this.#simTime - d.time)
      const horizon = age > KERNEL.sensingLatency ? KERNEL.range : Infinity
      for (let i = 0; i < vehicles.length; i++) {
        if (!(r.seq > this.#movedSeq[i])) {
          this.#hazardAhead[i] = 0
          this.#hazardBehind[i] = 0
          continue
        }
        const v = Math.abs(this.#fleet.speed(vehicles[i]))
        const driven = Math.max(this.#odo[i] - d.odo[i], v * carAge)
        const shrink = Math.max(0, driven - v * Math.min(carAge, KERNEL.sensingLatency)) + walk
        // A car without a slot is not vouched for (the fleet is capped at MAX_CARS, so none should be).
        const ahead = i < r.hazardsAhead.length ? Math.min(r.hazardsAhead[i], horizon) : 0
        const behind = i < r.hazardsBehind.length ? Math.min(r.hazardsBehind[i], horizon) : 0
        // NaN is no reading (the Fleet reads it as Infinity; Math.min keeps it NaN); a negative one is an overlap (0).
        this.#hazardAhead[i] = Number.isNaN(ahead) ? NaN : Math.max(0, ahead - shrink)
        this.#hazardBehind[i] = Number.isNaN(behind) ? NaN : Math.max(0, behind - shrink)
      }
    }
    for (const [i, ahead] of this.#hazardOverride) this.#hazardAhead[i] = Math.min(this.#hazardAhead[i], ahead)
    this.#fleet.setPersonHazards(this.#hazardAhead, this.#hazardBehind)
  }

  /**
   * One crowd step on this step's outcome: the realm's cars, player 0's avatar as the crowd's one player figure (the
   * shader has one player slot; players 1..3 are protected exactly on the CPU, by the fleet, the Sanctuary and the
   * audit, and are no one's neighbour in the crowd, as player 0 is not), its clock.
   */
  #stepCrowd(dt: number): void {
    const crowd = this.#crowd
    if (!crowd) return
    const a = this.#avatars[0]
    const seq = ++this.#crowdSeq
    // The odometers now: the reading this step returns measured the cars here. Kept as long as a reading can be used.
    this.#dispatches.push({ seq, time: this.#simTime, odo: this.#odo.slice() })
    while (this.#dispatches.length > 1 && this.#dispatches[0].time < this.#simTime - CROWD_STALE_S - MAX_DT) this.#dispatches.shift()
    crowd.step({
      seq, dt, time: this.#simTime,
      player: { x: a.x, z: a.z, heading: this.#bodyHeading[0], speed: this.#driving[0] ? 0 : a.speed, visible: this.#driving[0] === null },
      cars: this.#fleet.crowdStates(),
      summons: this.#summons,
    })
  }

  #capturePreStep(): void {
    const vehicles = this.#fleet.vehicles
    for (let i = 0; i < vehicles.length; i++) {
      const lv = this.#fleet.velocity(vehicles[i], this.#vel)
      this.#preVel[2 * i] = lv.x; this.#preVel[2 * i + 1] = lv.z
    }
  }

  /**
   * The Ring-0 audit: every vehicle and every Rapier person, after the physics step and before any state leaves
   * this realm. Non-finite state, an escape from the world, a runaway speed, a solid person overlapped by a moving
   * car, or a moving car within the standoff of a solid person in its path without an emergency stop applied:
   * any one halts the simulation. Speeds over the cap are clamped and counted. `gpuFlags` bit 0 is this realm's
   * GPU crowd reporting a non-finite pedestrian state (read back from its own buffers, never from the page).
   * `craft` is the scheduled craft buffer packed this step (null with tracks off): every value finite and every
   * craft at or above its corridor's floor, or the realm halts (auditCraft; it never corrects).
   */
  #ring0Audit(gpuFlags: number, craft: Float32Array | null): void {
    const fleet = this.#fleet
    const vehicles = fleet.vehicles
    const list = this.#auditVehicles
    for (let i = 0; i < vehicles.length; i++) {
      const v = vehicles[i]
      const t = fleet.position(v, this.#pos)
      const r = list[i] ?? (list[i] = { id: i, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, heading: 0, halfLength: CAR.halfLength, halfWidth: CAR.halfWidth, speed: 0, throttle: 0, brake: 0, occupant: -1, curvature: 0 })
      r.x = t.x; r.y = t.y; r.z = t.z
      const lv = fleet.velocity(v, this.#vel)
      r.vx = lv.x; r.vy = lv.y; r.vz = lv.z
      // The path test bends with the wheels, exactly as the Bouncer's corridor does (a straight band would panic in turns).
      r.heading = fleet.heading(v); r.speed = fleet.speed(v); r.curvature = fleet.curvature(v)
      r.throttle = v.lastCommand.throttle; r.brake = v.lastCommand.brake
      r.preVx = this.#preVel[2 * i]; r.preVz = this.#preVel[2 * i + 1]
      // The person driving it (the audit exempts only them from its own footprint), or nobody.
      r.occupant = this.#driving.indexOf(v)
    }
    list.length = vehicles.length
    // Every avatar is a person, id = player. Inside a car the collider is disabled; on foot it is solid unless the
    // Sanctuary shields it (ward k is player k). Then every shape of every rig, each a person with an id of its own.
    const people = this.#auditPeople, avatars = this.#avatars
    for (let k = 0; k < avatars.length; k++) {
      const p = people[k]
      const at = avatars[k].body.translation(this.#pos)
      p.x = at.x; p.y = at.y; p.z = at.z
      p.solid = this.#driving[k] === null && !this.#sanctuary.isSensor(k)
      p.radius = avatars[k].person.radius
    }
    people.length = this.#realm ? this.#realm.auditInto(people, avatars.length) : avatars.length
    const result = this.#auditor.run(list, this.#auditPeople, this.#simTime < this.#blindUntil)
    for (let i = 0; i < result.capped.length; i++) fleet.clampSpeed(vehicles[result.capped[i]], RING0.maxVelocity)
    if (gpuFlags & 1) result.violations.push({ code: 'NON_FINITE', subject: 'pedestrians', detail: 'a GPU pedestrian state was non-finite' })
    if (craft) {
      const fault = auditCraft(craft)
      if (fault) result.violations.push(fault)
    }
    if (result.violations.length) this.halt(panicReason(result.violations[0]))
  }
}

Object.freeze(SimCore.prototype)
Object.freeze(SimCore)
