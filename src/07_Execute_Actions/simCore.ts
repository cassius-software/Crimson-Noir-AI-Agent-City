/**
 * Why does this file exist? It is the whole physical simulation as one object with a plain-data interface,
 * built to live alone in the physics worker (physics.worker.ts): the Rapier world, the fleet and its
 * Ring-0 Bouncer, the avatar, the Sanctuary, the Ring-0 auditor, and the GPU pedestrian crowd that senses
 * for the Bouncer (a CrowdSensor on the worker's own device, crowdSim.ts). One step() takes the page's input
 * as numbers (controls and queued commands, nothing about pedestrians or time) and runs: commands, sensing
 * (the avatar exactly, the crowd's newest readings aged for how stale they are), vetted controls, AI drivers,
 * the fixed substeps (Sanctuary, avatar, wheels), then the audit, synchronously after the last substep and in
 * the same realm (including the crowd's own Ring-0 flags), then the crowd's next step, and only then packs the
 * poses and the pedestrians' render state the page may draw. Recruitment is decided here too: a request is
 * checked against this realm's own readings of the crowd (earshot, the sidewalk, the skill), the person is asked
 * over through the crowd's summon slots, becomes Active (tethered: following the operator) on arrival, and is released
 * when the operator walks off, drives off or dismisses them. Nothing it returns is a reference into it. It
 * imports no DOM, no worker API and no GPU code, so the node tests drive it directly with a stand-in sensor.
 * What breaks if it is removed? The worker has nothing to run, and the page has no simulation.
 */
import { CITY_SIZE, inLot } from '../01_Initialize_World/city.ts'
import { KERNEL } from '../02_Define_The_Rules/civic.ts'
import { panicReason, RING0, Ring0Auditor, type AuditPerson, type AuditVehicle } from '../02_Define_The_Rules/ring0.ts'
import type { KernelStats } from '../05_Observe_Environment/telemetry.ts'
import { CAR, CAR_TUNE_RANGE, type CarTuning } from './car.ts'
import { Physics } from './physics.ts'
import { Avatar } from './player.ts'
import { Sanctuary, type Nudge } from './sanctuary.ts'
import { Fleet, type Vehicle } from './vehicles.ts'
import { AGENTS_RANGE, MAX_CARS, PEDESTRIAN_MAX_SPEED, type CrowdSensor, type Summon } from '../03_Spawn_Agents/crowdSensor.ts'
import {
  ACTIVITY, APPROACH_SECONDS, AUDIBLE_RADIUS, eligible, findRecruit, RECRUIT_SLOTS, RELEASE_DISTANCE, skillNamed, skillsOf, whyNot,
  type Skill,
} from '../03_Spawn_Agents/skills.ts'
import type { Intent } from '../02_Define_The_Rules/laws.ts'
import {
  ENTER_RANGE, RUN, type AvatarState, type DriveControls, type FootControls, type RecruitView, type SimCommand, type SimEvent, type SimInit, type SimMeta,
  type StepState,
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
  cmds: readonly unknown[]
}

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
}

const finite = (n: unknown, fallback = 0): number => (typeof n === 'number' && Number.isFinite(n) ? n : fallback)
const clamp = (n: number, lo: number, hi: number): number => (n < lo ? lo : n > hi ? hi : n)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())

export class SimCore {
  readonly meta: SimMeta
  readonly #physics: Physics
  readonly #fleet: Fleet
  readonly #avatar: Avatar
  readonly #sanctuary: Sanctuary
  /** Centred on the city, or on a region with a slab that holds it (and a margin). */
  readonly #auditor: Ring0Auditor
  readonly #debug: boolean
  /** The GPU pedestrians and their First-Law sensing (null only in tests without a crowd). */
  readonly #crowd: CrowdSensor | null
  #driving: Vehicle | null = null
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
  readonly #auditPeople: AuditPerson[] = [{ id: 0, x: 0, y: 0, z: 0, solid: true }]
  readonly #wish = { x: 0, z: 0 }
  /** The way the player's own body faces (the page's view heading): it only turns that figure in the crowd. */
  #bodyHeading = 0
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
  #holdWas = false
  #fullBrakeWas = false
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
    this.#fleet = new Fleet(physics, o.cars, o.seed, { exposeRig: this.#debug })
    this.#avatar = new Avatar(physics, o.spawn.x, o.spawn.z)
    this.#sanctuary = new Sanctuary(physics.world)
    this.#sanctuary.register(this.#avatar.person)
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
      person: { radius: this.#avatar.person.radius, halfHeight: this.#avatar.person.halfHeight },
      debug: this.#debug,
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
    const physics = await Physics.create(o.boxes, o.furniture, o.region ?? null)
    const crowd = makeCrowd ? await makeCrowd(agents) : null
    physics.streamAt(spawn.x, spawn.z)
    const core = new SimCore(physics, { ...o, cars, agents, seed: Math.floor(finite(o.seed)) >>> 0, spawn }, crowd)
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
   * state. After a panic it changes nothing and reports the frozen state.
   */
  step(input: StepInput, poses: Float32Array): Omit<StepState, 't' | 'id'> {
    const t0 = now()
    let trigger = 0, limited = false, thump = false
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
      const fleet = this.#fleet, avatar = this.#avatar

      // Everyone the First Law protects, as the fleet will see them this step.
      const blind = this.#simTime < this.#blindUntil
      fleet.setAvatar(avatar.x, avatar.z, this.#driving === null && !blind)
      if (blind) fleet.setPersonHazards(this.#noHazards, this.#noHazards)
      else this.#feedHazards()
      // Scripted intents are ruled on this step's sensing (as the player's controls below are), never on the
      // previous step's: a setMode or interact later in the same batch still wins.
      for (const [i, cmd] of this.#intents) {
        const v = fleet.vehicles[i]
        if (v !== this.#driving && v.mode === 'player') fleet.drive(v, cmd, false)
      }
      this.#intents.clear()

      const v = this.#driving
      if (v === null) {
        // On foot: the desired walking velocity, never faster than a run.
        const wx = finite(input.foot?.x), wz = finite(input.foot?.z)
        const len = Math.hypot(wx, wz)
        const k = len > RUN ? RUN / len : 1
        this.#wish.x = wx * k
        this.#wish.z = wz * k
        // Wrapped in f64 so the crowd's f32 uniform always holds a small angle: 1e39 is finite here and
        // Infinity there, and would turn the player's figure (and, through the grid, its neighbours) into NaN.
        const h = finite(input.foot?.heading, NaN)
        if (!Number.isNaN(h)) this.#bodyHeading = Math.atan2(Math.sin(h), Math.cos(h))
        this.#holdWas = false
        this.#fullBrakeWas = false
      } else {
        const d = input.drive
        const steerIn = clamp(finite(d?.steer), -1, 1)
        const fwd = clamp(finite(d?.fwd), 0, 1), back = clamp(finite(d?.back), 0, 1)
        const speed = fleet.speed(v)
        const target = steerIn * CAR.maxSteer * (1 - Math.min(0.6, Math.abs(speed) / 28))
        v.steer += (target - v.steer) * Math.min(1, dt * 5)
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
        thump = (hold && !this.#holdWas) || (fullBrake && !this.#fullBrakeWas)
        this.#holdWas = hold
        this.#fullBrakeWas = fullBrake
      }

      fleet.think(dt, signalTime)
      // Pre-step velocities for the audit's IMPACT test (a contact resolves inside the step it happens in).
      this.#capturePreStep()
      const driving = this.#driving
      // A region streams its walls around the player (the car driven, or the avatar): built before this step solves.
      if (driving !== null) {
        const p = fleet.position(driving)
        this.#physics.streamAt(p.x, p.z)
      } else {
        this.#physics.streamAt(avatar.x, avatar.z)
      }
      this.#physics.step(dt, (h) => {
        // Sanctuary first: a person a vehicle is about to reach becomes a sensor before this step solves.
        const n = this.#sanctuaryOn ? this.#sanctuary.guard(fleet.footprints(), h)[0] : ZERO_NUDGE
        if (driving === null) {
          avatar.nudge(n.dx, n.dz)
          avatar.move(this.#wish.x, this.#wish.z, h)
        }
        fleet.updateControllers(h)
        // The odometer: how far each car can have driven since any crowd reading (the speed at the substep's
        // start never undercounts a braking car).
        for (let i = 0; i < this.#odo.length; i++) this.#odo[i] += Math.abs(fleet.speed(fleet.vehicles[i])) * h
      })
      // RING-0 AUDIT SITE: in this realm, synchronously after the last substep, before any state leaves it.
      this.#ring0Audit(this.#crowd ? this.#crowd.takeFlags() : 0)
      // The crowd steps on this step's outcome: the cars where they now are, the avatar, this clock, the summons.
      if (this.#panic === null) {
        this.#tendRecruits()
        this.#stepCrowd(dt)
      }
    }
    this.#fleet.writePoses(poses)
    const ms = now() - t0
    this.#workerMs = this.#workerMs === 0 ? ms : this.#workerMs * 0.9 + ms * 0.1
    const events = this.#events
    this.#events = []
    const st = this.#physics.stats
    return {
      simTime: this.#simTime,
      poses,
      avatar: this.#avatarState(),
      driving: this.#driving ? this.#driving.index : -1,
      kernel: this.#kernelStats(),
      physics: { stepMs: st.stepMs, steps: st.steps, bodies: st.bodies, colliders: st.colliders, ccd: st.ccd, workerMs: this.#workerMs },
      tuning: { ...this.#fleet.tuning },
      haptics: { trigger, limited, thump },
      crowd: {
        stats: { ...(this.#crowd?.readout?.stats ?? { nudges: 0, waiting: 0, crossing: 0, retreating: 0 }) },
        ageMs: this.#crowdAgeMs,
        lagMs: (this.#crowd as { lagMs?: number } | null)?.lagMs ?? 0,
      },
      // A frame ships only from a realm that is still running: its flags were audited in this very step (they
      // arrive with it), so a frame whose flags halted the realm never leaves it.
      crowdFrame: this.#crowd && this.#panic === null ? this.#crowd.takeFrame() : null,
      recruits: this.#recruits.map((r): RecruitView => ({
        agent: r.agent, serial: r.serial, skill: r.skill, state: r.arrivedAt >= 0 ? 'Active' : 'Interviewing', arrived: r.arrivedAt >= 0,
        skills: [...r.skills], distance: r.distance, x: r.x, z: r.z,
        seconds: this.#simTime - r.since,
      })),
      events,
      rejected: this.#rejected,
      blind: this.#simTime < this.#blindUntil,
    }
  }

  #avatarState(): AvatarState {
    const a = this.#avatar, p = a.person
    const t = a.body.translation(this.#pos)
    return {
      x: t.x, y: t.y, z: t.z, feetY: t.y - p.halfHeight - p.radius, speed: this.#driving ? 0 : a.speed,
      enabled: a.collider.isEnabled(), sensor: this.#sanctuary.isSensor(0),
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
    if (v === this.#driving) throw new Error('that car is being driven')
    return v
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
      case 'interact': this.#interact(); return
      case 'reset': if (this.#driving) fleet.recover(this.#driving); return
      case 'teleport': {
        const x = finite(cmd.x, NaN), z = finite(cmd.z, NaN)
        if (Number.isNaN(x) || Number.isNaN(z)) throw new Error('teleport: x and z must be finite')
        if (this.#driving) this.#interact()
        this.#avatar.teleport(x, z)
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
        // Never drop a car onto a person: the spot must clear the avatar on foot by a car's half-length and a margin.
        const at = fleet.position(v, this.#pos)
        const tx = x ?? at.x, tz = z ?? at.z
        if (this.#driving === null && Math.hypot(tx - this.#avatar.x, tz - this.#avatar.z) < CAR.halfLength + this.#avatar.person.radius + 0.5) {
          throw new Error('recover: a person is standing there')
        }
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
      case 'recruit': this.#recruit(cmd); return
      case 'dismiss': {
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
    const operator = this.#driving ? null : { x: this.#avatar.x, z: this.#avatar.z }
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
      x: r.xz[2 * pick.agent], z: r.xz[2 * pick.agent + 1],
    })
    this.#events.push({ e: 'recruit', id, ok: true, agent: pick.agent, skill, distance: pick.distance })
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
    const ax = this.#avatar.x, az = this.#avatar.z, t = this.#simTime
    for (const rec of [...this.#recruits]) {
      if (this.#driving) { this.#release(rec, 'the operator drove off'); continue }
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
    }
    const summons = this.#summons
    summons.length = this.#recruits.length
    for (let k = 0; k < summons.length; k++) {
      const m = summons[k] ?? (summons[k] = { agent: 0, x: 0, z: 0, tethered: false })
      m.agent = this.#recruits[k].agent; m.x = ax; m.z = az; m.tethered = this.#recruits[k].arrivedAt >= 0
    }
  }

  /** Enter the nearest car, or leave the current one on the driver's (left) side. */
  #interact(): void {
    const fleet = this.#fleet, avatar = this.#avatar
    if (this.#driving) {
      const v = this.#driving
      const t = fleet.position(v, this.#pos)
      const h = fleet.heading(v)
      const lx = Math.cos(h), lz = -Math.sin(h)
      let ex = t.x + lx * 2.1, ez = t.z + lz * 2.1
      if (inLot(ex, ez, 0.4)) { ex = t.x - lx * 2.1; ez = t.z - lz * 2.1 }
      v.mode = 'parked'
      this.#driving = null
      avatar.setEnabled(true)
      avatar.teleport(ex, ez)
      avatar.heading = h
      this.#holdWas = false
      this.#fullBrakeWas = false
      this.#events.push({ e: 'exited', x: ex, z: ez, heading: h })
      return
    }
    const v = fleet.nearest(avatar.x, avatar.z, ENTER_RANGE)
    if (!v) return
    v.mode = 'player'
    v.steer = 0
    this.#driving = v
    avatar.setEnabled(false)
    this.#events.push({ e: 'entered', index: v.index, heading: fleet.heading(v), suv: v.suv })
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

  /** One crowd step on this step's outcome: the realm's cars, the avatar as the player's own body, its clock. */
  #stepCrowd(dt: number): void {
    const crowd = this.#crowd
    if (!crowd) return
    const a = this.#avatar
    const seq = ++this.#crowdSeq
    // The odometers now: the reading this step returns measured the cars here. Kept as long as a reading can be used.
    this.#dispatches.push({ seq, time: this.#simTime, odo: this.#odo.slice() })
    while (this.#dispatches.length > 1 && this.#dispatches[0].time < this.#simTime - CROWD_STALE_S - MAX_DT) this.#dispatches.shift()
    crowd.step({
      seq, dt, time: this.#simTime,
      player: { x: a.x, z: a.z, heading: this.#bodyHeading, speed: this.#driving ? 0 : a.speed, visible: this.#driving === null },
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
   */
  #ring0Audit(gpuFlags: number): void {
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
      r.occupant = v === this.#driving ? 0 : -1
    }
    list.length = vehicles.length
    const p = this.#auditPeople[0]
    const at = this.#avatar.body.translation(this.#pos)
    p.x = at.x; p.y = at.y; p.z = at.z
    // Inside a car the avatar's collider is disabled; on foot it is solid unless the Sanctuary shields it.
    p.solid = this.#driving === null && !this.#sanctuary.isSensor(0)
    p.radius = this.#avatar.person.radius
    const result = this.#auditor.run(list, this.#auditPeople, this.#simTime < this.#blindUntil)
    for (let i = 0; i < result.capped.length; i++) fleet.clampSpeed(vehicles[result.capped[i]], RING0.maxVelocity)
    if (gpuFlags & 1) result.violations.push({ code: 'NON_FINITE', subject: 'pedestrians', detail: 'a GPU pedestrian state was non-finite' })
    if (result.violations.length) this.halt(panicReason(result.violations[0]))
  }
}

Object.freeze(SimCore.prototype)
Object.freeze(SimCore)
