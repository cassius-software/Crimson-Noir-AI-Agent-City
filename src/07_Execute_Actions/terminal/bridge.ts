// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the air gap between the Ring-0 terminal and the running city: the
 * only surface the console can reach. It carries read-only telemetry (the stats, and the unified namespace of topics
 * the engine publishes every snapshot into, read by filter) plus a few operator knobs (clock,
 * quality tier, audio, ghost view, drawing, captions, hardware pairing), the view-only pings and the player's look,
 * recruitment (asking someone nearby over by skill, or an Active recruit to a pinged point: the one knob that
 * reaches a pedestrian, and only through the physics worker's own checks), the swarm's memory (read, or erased on
 * command), the opt-in network session, the model file kept in this page and, behind an explicit `operator unlock`,
 * the operator tier (sandboxed scripts, prompts to the local model, speech, tuning keys, physics harnesses, the local
 * .agv recorder) that the engine builds over its SimControls. A script, a prompt or speech runs only through the capability gateway:
 * while someone tethered to the operator has the skills it names, and no longer. The console itself holds no engine,
 * physics, agent, gateway or storage reference: capability only ever flows through here.
 * What breaks if it is removed? The terminal has nothing to observe or tune and does not compile.
 */
import type { HalDevice } from '../../04_Connect_Hardware/hal.ts'
import type { LawText } from '../../02_Define_The_Rules/laws.ts'
import type { CameraStats, KernelStats, NetReport, QualityState, RecordingState, SipocSnapshot } from '../../05_Observe_Environment/telemetry.ts'
import type { RecorderSource } from '../../05_Observe_Environment/recorder.ts'
import type {
  ActBy, ActEnd, ActEvent, ActsBridge, AskResult, ExecResult, GatedAsk, GatedRun, GatedSay, GateTether, MindStatus, PendingAct, Piece, RunResult, RunState,
  SayResult, VoiceStatus, apiDoc,
} from '../operator.ts'
import type { HarnessReport, harnesses } from '../harness.ts'
import type { LookChange } from '../../03_Spawn_Agents/look.ts'
import type { Swarm } from '../../08_Swarm/orchestrator.ts'
import type { NoirTables } from './noirscript/index.ts'

export type {
  HalDevice, LawText, ActBy, ActEnd, ActEvent, ActsBridge, AskResult, ExecResult, GatedAsk, GatedRun, GatedSay, GateTether, MindStatus, PendingAct, Piece,
  RunResult, RunState, SayResult, VoiceStatus, HarnessReport, RecorderSource, RecordingState, NetReport, LookChange,
}

export interface Ring0Stats {
  fps: number; frameMs: number; p95Ms: number; cpuMs: number; gpuRenderMs: number; gpuComputeMs: number
  /** stepMs: one world.step(); physicsMs: one whole step in the physics worker; steps: substeps last step. */
  rapier: { stepMs: number; physicsMs: number; steps: number; bodies: number; colliders: number; ccd: number }
  agents: { population: number; drawnNear: number; drawnFar: number; waiting: number; crossing: number; yielding: number; nudges: number; working?: number }
  vehicles: number
  quality: QualityState
  kernel: KernelStats
  /** Pedestrian sensing in the physics worker: the age of the readings the Bouncer used, and the GPU round trip, ms. */
  sensing?: { ageMs: number | null; lagMs: number }
  /** The cinema camera (absent with ?cinema=0); `fps` above stays the animation-frame rate input runs at. */
  camera?: CameraStats
}

/**
 * The operator tier (operator.ts builds it over the engine's SimControls and the capability gateway). `exec`,
 * `tuning`, `tune` and `harness` throw while locked; the terminal refuses those commands before calling them.
 * `api` and `harnesses` are documentation and may be read at any time.
 */
export interface OperatorBridge {
  unlock(): void
  lock(): void
  unlocked(): boolean
  /**
   * A script that needs `skills`, through the capability gateway (08_Swarm/taskRouter.ts), decided at once: Rejected
   * (it never runs), or Authorized and bound to the tethers that cover the skills, and Aborted the moment one breaks.
   * The only way a script runs. Throws while locked, or when no skill is named.
   */
  exec(skills: readonly string[], script: string): GatedRun
  /** The tuning keys `get` lists, both tables, read through the script facade. */
  tuning(): { physics: Record<string, number>; shaders: Record<string, number> }
  /** `set`: one physics.* or shaders.* key through the facade (validated, clamped by the engine); returns its value now. */
  tune(table: 'physics' | 'shaders', key: string, value: number): number
  /** The feature inspector and its steering (reads work while locked; steer, clamp, release and reset throw while locked). */
  features: FeaturesBridge
  /** The Ring-0 elite tier above this one (status and lock work while locked; unlock and set need this tier open). */
  elite: EliteBridge
  /**
   * A prompt for the local model, through the capability gateway like a script: decided at once, answered for the
   * people it is bound to, streamed while they stay tethered, cut off when they do not. One answer at a time. Throws
   * while locked, while another answer is coming, when no model is chosen, or when no skill is named.
   */
  ask(skills: readonly string[], prompt: string): GatedAsk
  /** The local model server's address and model, and (asking the server, on this call only) the models it has. */
  askStatus(): Promise<MindStatus>
  /**
   * Chooses the model, the server's address, the wire format, the provider (09_Cognition/router.ts: claude over the
   * network, or ollama or llamacpp on this machine), the network provider's key or effort, or turns thinking on or
   * off; returns the new value. Throws on a bad one.
   */
  askSet(key: 'model' | 'server' | 'think' | 'api' | 'provider' | 'key' | 'effort', value: string): string
  /**
   * `ask connect`: the provider and, when given, its server and (the Claude provider's) key in one line
   * (09_Cognition/router.ts connect); returns what the provider is and what was set. Throws on a bad one, and while locked.
   */
  askConnect(provider: string, url?: string, key?: string): string
  /** Stops the answer being generated, if any (the operator's own stop); returns what it did. */
  askStop(): string
  /**
   * The swarm orchestrator (08_Swarm/orchestrator.ts) over this tier's gated ask: a goal split over up to five roles,
   * each one prompt through the gateway and the guardrails, with the hash-chained audit trail of every run. The host
   * (a voice line, the onboarding) reaches it through this same surface. `run` throws while locked.
   */
  swarm: SwarmBridge
  /**
   * The city actions an agent proposes at the end of an answer (acts.ts): the one waiting for the operator's OK, the
   * follow for the card and a host, allow and refuse (through the gateway, under the proposer's tether; they throw
   * while locked), the hash-chained trail and the catalogue. Reads work while locked; nothing runs before the OK.
   */
  acts: ActsBridge
  /**
   * Text said aloud through the local speech server, through the capability gateway like a prompt: decided at once,
   * said by the first person it is bound to from where they stand (the voice follows them), and cut off the moment the
   * tether breaks. One utterance at a time. Throws while locked, while something is being said, when no voice is
   * chosen, when the page has no speech, or when no skill is named.
   */
  say(skills: readonly string[], text: string): GatedSay
  /** The local speech server's address, voice, model and auto setting, and (asking the server) the voices it lists. */
  sayStatus(): Promise<VoiceStatus>
  /** Chooses the server (this machine only), the voice or the model, or turns auto on or off; returns the new value. */
  saySet(key: 'model' | 'server' | 'voice' | 'auto' | 'provider' | 'key', value: string): string
  /** Stops whatever is being said, if anything (the operator's own stop); returns what it did. */
  sayStop(): string
  api(): ReturnType<typeof apiDoc>
  harnesses(): ReturnType<typeof harnesses>
  harness(name: string): Promise<HarnessReport>
}

/**
 * The feature inspector (09_Cognition/features.ts) over the operator tier: the named features of the city read from
 * the newest snapshot, the operator's steering (a bias in [-1, 1] or a clamp in [0, 1] per feature) and the fixed lines
 * it adds to every provider's system prompt. Every row comes formatted. Reads work while locked; steer, clamp,
 * release and reset throw while locked, and a RangeError names an unknown feature or a value out of range.
 */
export interface FeaturesBridge {
  /** The inspector's rows over the newest snapshot: steered, sparsified, the top k (all by default), largest first. */
  lines(k?: number): string[]
  /** One feature: id and title, what it measures, its threshold, its activation now and its steering; null for an unknown name. */
  about(name: string): string[] | null
  /** The steering lines in every provider's system prompt now; empty when nothing is steered. */
  prompt(): string[]
  /** What the inspector is and is not, plainly. */
  explain(): string[]
  /** Leans a feature by a bias in [-1, 1]: the line kept, then each tuning knob it moved, one line each. */
  steer(name: string, bias: number): string[]
  /** Holds a feature's lane at a value in [0, 1]; returns the line kept. */
  clamp(name: string, value: number): string
  /** Drops a feature's bias and clamp: the line, then each knob returned to its middle. */
  release(name: string): string[]
  /** Drops every bias and clamp: the line, then each knob returned to its middle. */
  reset(): string[]
}

/**
 * The writes the elite tier opens to NoirScript (terminal/noirscript's NoirWrites has this shape), each through the
 * operator's own facade: the tuning knobs `set` uses, a scripted intent (the same Bouncer, envelope and latch as the
 * wheel, in the physics worker), the crowd's density, and the feature inspector's bias. Each throws while the tier is
 * locked. Nothing here reaches the laws, the Sanctuary, the Ring-0 auditor or the 14A screen.
 */
export interface EliteWrites {
  /** `physics.<k>` or `shaders.<k>` (a bare `car.<k>` is physics, anything else bare is shaders); the value the knob holds now. */
  tune(key: string, value: number): number
  /** A player-style intent for car `car`; true once sent (the realm vets it as it vets the wheel). */
  intent(car: number, throttle: number, brake: number, steer: number): boolean
  /** The crowd's density until the quality tier next changes; returns it. */
  cull(density: number): number
  /** A feature bias in [-1, 1] (FeaturesBridge.steer); returns it. */
  steer(feature: string, value: number): number
}

/**
 * The Ring-0 elite tier, above the operator tier: a passphrase the operator sets once (kept by the host as a salted
 * SHA-256 record, never the words) opens NoirScript's writes and its raised limits for this console session. `unlock`
 * and `set` throw while the operator tier is locked; `set` also throws while a passphrase is set and this tier closed;
 * `unlock` throws on a wrong passphrase and refuses after five wrong in a row until the operator tier is locked and
 * unlocked again. `operator lock` closes this tier too. Nothing it opens reaches the laws, the Sanctuary, the Ring-0
 * auditor or the 14A screen.
 */
export interface EliteBridge {
  /** One line: locked or unlocked, whether a passphrase is set (or can be kept), writes this session. */
  status(): string
  unlocked(): boolean
  /** Opens the tier; returns the banner (what is open now, what stays in force). */
  unlock(passphrase: string): string[]
  lock(): string
  /** Sets the passphrase (8 to 256 characters); returns the line. */
  set(passphrase: string): string
  /** The write surface while the tier is open, else null. */
  writes(): EliteWrites | null
}

/** The swarm as the console and the host see it (08_Swarm/orchestrator.ts Swarm): plan, run, status, stop, the audit trail. */
export type SwarmBridge = Pick<Swarm, 'plan' | 'run' | 'status' | 'stop' | 'audit' | 'verify' | 'roles' | 'quota'>

/**
 * The .agv recorder (recorder.ts), operator-gated by the terminal. `start` prompts — the save dialog,
 * and the camera for source 'camera' — so the terminal calls it synchronously inside the Enter keydown,
 * like pair(); the host must reach showSaveFilePicker / getUserMedia before its first await. It
 * resolves with the codec in use ('av01.0.04M.08', 'avc1.42E01F', 'vp09.00.10.08'). `stop` flushes
 * and closes the file and resolves with where it went, e.g. "saved to crimson-noir-2026….agv" or "downloaded
 * crimson-noir-2026….agv" (may be ''). `status` is the live RecordingState the HUD shows; `supported` says why
 * this browser cannot record, if it cannot. Nothing is ever transmitted: the only sink is a local file.
 */
export interface RecordBridge {
  start(source: RecorderSource): Promise<string>
  stop(): Promise<string>
  status(): RecordingState
  supported(): { ok: boolean; reason: string }
}

/**
 * Recruitment (08_Swarm/recruitment.ts): ask the nearest person within earshot who knows a skill to come over,
 * by command or by voice. The physics worker re-checks every request on its own readings (earshot, the sidewalk,
 * the skill) and walks the person over; nothing here moves anyone. `listen` opens the microphone and `install`
 * asks the browser for its on-device speech model: the terminal calls both synchronously inside the Enter keydown
 * (user activation), like pair(). Recognition is on-device only; `install` is the one step that downloads.
 */
export interface RecruitBridge {
  /** Resolves with the outcome: who is coming over, or why nobody is. */
  ask(skill: string): Promise<{ ok: boolean; message: string; agent?: number }>
  /**
   * Asks the Active recruit `agent` to walk to the sidewalk point (x, z), usually the one the operator pinged
   * (`ping`): the page checks the point and the tether on its own copy, the physics worker decides on its own
   * readings. Resolves with the outcome either way; nothing here moves anyone.
   */
  rally(agent: number, x: number, z: number): Promise<{ ok: boolean; message: string }>
  /** Resolves with the microphone's status line. */
  listen(): Promise<string>
  stop(): string
  install(): Promise<string>
  /** Lets every recruit go (breaks every tether). */
  dismiss(): string
  /** The microphone, everyone coming over or tethered, the swarm's skills, and the last outcome, one line each. */
  status(): string[]
  /** Skill names, for help. */
  skills(): readonly string[]
}

/**
 * The swarm's memory (08_Swarm/memory.ts): each pedestrian's episodes in this city, kept on this machine. Reading it
 * reaches nobody; forgetting erases the ledger for good.
 */
export interface MemoryBridge {
  /** Where the memory is kept and how many people it holds, then one line per person tethered now. */
  status(): Promise<string[]>
  /** Pedestrian `agent`'s episodes, oldest first, one line each. */
  ledger(agent: number): Promise<string[]>
  /** Erases one pedestrian's ledger, or every one in this city ('all'); resolves with what it did. */
  forget(which: number | 'all'): Promise<string>
}

/**
 * The opt-in network session (10_Network/netClient.ts; the engine's NetControls, App adds the kept token): nothing
 * connects until `join`, which takes the room's address (ws or wss, on this machine only) and the session
 * token the operator was handed; a token given is kept on this machine between visits and reused when none is given.
 * The room's other players are drawn as pose-only ghosts and never enter the physics realm. `join` resolves with the
 * status line once the room welcomes this page and rejects with why it did not; `leave` and `forget` (drops the
 * kept token) return what they did; `status` is plain data.
 */
export interface NetBridge {
  join(url: string, token?: string): Promise<string>
  leave(): string
  status(): NetReport
  forget(): string
}

/**
 * The model file kept in this page (09_Cognition/inPage.ts, the in-page provider): `ask file` and `ask gpu` reach it
 * without `operator unlock`, since they keep a file or a setting and send no prompt. `pick` opens the browser's file
 * picker, so the terminal calls it synchronously inside the Enter keydown (user activation), like pair(); it resolves
 * with what was kept, or that nothing was chosen. `forget` drops the kept model of that name (every one, with no name),
 * `load` loads the chosen one now (clearing a failed load or a crash mark from before), `unload` frees it, `gpu` says
 * whether it runs on the GPU (auto: as this device suits), and `log` is the runtime's newest lines, oldest first. Each
 * resolves with, or returns, one line for the console; each may throw or reject with the reason.
 */
export interface ModelBridge {
  pick(): Promise<string>
  forget(name?: string): Promise<string>
  load(): Promise<string>
  unload(): Promise<string>
  gpu(mode: 'auto' | 'on' | 'off'): string
  log(): readonly string[]
}

/**
 * The unified namespace (05_Observe_Environment/namespace.ts TopicBus): every reading of the city as a retained topic in
 * the ISA-95 shape Enterprise/JCS/Site/AgentCity/Area/{District}/Line/{Subsystem}/Cell/{Entity}/{Tag}, read-only. The
 * engine formats the rows (the console imports nothing of the bus): `list` the retained topics a filter matches ('+'
 * one level, '#' the rest; none: every topic), one row each; `get` one topic's row, or null; `children` the next level
 * under a prefix (none: the root) with how many topics each holds; `status` one line (topics, publishes, the head digest).
 */
export interface TopicBridge {
  list(filter?: string): string[]
  get(topic: string): string | null
  children(prefix?: string): string[]
  status(): string
}

/**
 * The city's structure-of-arrays columns for NoirScript (noirscript/index.ts NoirTables): the crowd's x and z, the
 * cars' x, z, heading, speed and mode, the kernel's counters and the frame clock, every array a copy taken at the
 * call. Read-only: the VM copies them again into its own arena, and the host hands it no write surface.
 */
export interface SoaBridge {
  tables(): NoirTables
}

/** A ping's kind (08_Swarm/ping.ts PingKind): what the operator means by the mark. */
export type PingKind = 'go' | 'look' | 'gather' | 'wait'

/** What a ping met (08_Swarm/ping.ts Pick), as plain data: the ground, a person, a car or a pole, its index, and where. */
export interface PingPick { kind: 'point' | 'person' | 'car' | 'pole'; index: number; x: number; y: number; z: number; distance: number }

/** The newest ping standing: its number, kind and point. */
export interface PingPoint { id: number; kind: PingKind; x: number; z: number }

/**
 * The operator's pings (08_Swarm/ping.ts): a mark where the head looks, view-only (the board, a cue, a caption, the
 * minimap); a walk ping (go, gather) is also offered to the host's recruiter as a plain request the physics worker
 * re-checks. Nothing here moves anyone or crosses into the physics realm.
 */
export interface PingBridge {
  /** A ping of `kind` where the head looks: what it met, or null (nothing within range, too soon after the last, the city stopped). */
  at(kind: PingKind): PingPick | null
  /** The pings standing now, oldest first, one line each (none: an empty list). */
  list(): string[]
  /** The newest ping standing, or null. */
  newest(): PingPoint | null
  /** Takes every ping off the board; returns how many stood. */
  clear(): number
}

/**
 * The player's look (03_Spawn_Agents/look.ts): the closed business-casual wardrobe the crowd already wears, worn by
 * the player's own body (the eye never sees it; its shadow and every other viewer do) and kept on this machine
 * between visits by the host. View-only: nothing reaches the physics realm.
 */
export interface LookBridge {
  /** The look worn now, one line per slot then its code (describeLook); `agent` reads a pedestrian's instead. Throws for no such pedestrian. */
  show(agent?: number): string[]
  /** Changes the player's look and returns it as show() prints it; throws with the reason when the change is outside the wardrobe. */
  set(change: LookChange): string[]
}

/**
 * Implemented by the host (App/engine). Arguments mirror the command line: `quality` takes 'auto' or a
 * tier from -1 (Lite) to 5 (Peak), `audio` takes 'on' / 'off' or a volume in percent (0–100). Called with no argument, both
 * only report. A method may throw; the terminal prints the message and carries on.
 */
export interface TerminalBridge {
  /** `track`: which shell mounted the console: 'gui' (the city, the engine's bridge) or 'tty' (?boot=tty: the full-screen console alone).
   *  `map`: which map the city shell walks (onboarding/script.ts MapChoice), for the `map` command's status line. */
  readonly brand: { name: string; version: string; host: string; track?: 'gui' | 'tty'; map?: 'lakefront' | 'region' | 'city' }
  stats(): Ring0Stats
  laws(): readonly LawText[]
  /** Local solar time as HH:MM. */
  clock(): string
  /** Hours 0 ≤ h < 24, fractional minutes included. */
  setClock(hours: number): void
  quality(arg?: 'auto' | number): QualityState
  /** Returns a one-line status, e.g. "on · 70 % · HRTF · 12 voices". */
  audio(arg?: 'on' | 'off' | number): string
  /** pair() prompts: the terminal calls it synchronously inside the Enter keydown (user activation). */
  hal: { summary(): string; devices(): HalDevice[]; pair(kind: 'hid' | 'serial' | 'bluetooth'): Promise<HalDevice | null>; readonly shellHid?: boolean }
  /** GPU adapter description. */
  adapter(): string
  /** Ghost view (view-only: the physics shapes drawn as code over the frame): on, off, or the status line. */
  ghost(arg?: 'on' | 'off'): string
  /**
   * The rain (01_Initialize_World's rain-mode module, the engine's rain-mode switch): falling code on every surface, and
   * in the physics realm people and cars passing through each other (the crowd's physics mask): on, off, or the status line.
   */
  rain(arg?: 'on' | 'off'): string
  /**
   * Drawing the city (view-only: physics, audio and this console keep running while it is off and the canvas stays
   * black): on, off, or the status line ('on' | 'off').
   */
  render(arg?: 'on' | 'off'): string
  /** Closed captions for every sound (view-only; the soundscape keeps sounding): on, off, or the status line ('captions: on' | 'captions: off'). */
  captions(arg?: 'on' | 'off'): string
  /** The unified namespace of topics (read-only); absent on a host that publishes none (the TTY shell, an older host). */
  topics?: TopicBridge
  /** The city's columns for NoirScript (read-only copies); absent on a host without a running city (the TTY shell). */
  soa?: SoaBridge
  ping: PingBridge
  operator: OperatorBridge
  record: RecordBridge
  /** Absent until the host has built its recruiter (the terminal then says so). */
  recruit?: RecruitBridge
  /** Absent until the host has opened the swarm's memory (the terminal then says so). */
  memory?: MemoryBridge
  /** Absent until the host has attached its network client (the terminal then says so). */
  net?: NetBridge
  /** Absent until the host keeps a look for the player (the terminal then says so). */
  look?: LookBridge
  /** Absent when the host cannot keep a model file in this page (the terminal then says so). */
  model?: ModelBridge
  /** Absent until the host keeps a roster of the player's own agents (the terminal then says so). */
  agent?: AgentBridge
  /** Absent until the host has a concierge that can speak (the terminal then says so). */
  concierge?: ConciergeBridge
  /** A goal in plain words, planned as Sloane plans one (06_Make_Decisions/intent.ts) with what can be done now done; absent in the console shell. */
  goal?(text: string): GoalPlan
}

/** What came of a goal: the root the plan answers, each step and its state, and notes for what nothing maps to. */
export interface GoalPlan {
  readonly root: string
  readonly steps: readonly { readonly label: string; readonly state: 'done' | 'later' | 'failed'; readonly detail?: string }[]
  readonly notes: readonly string[]
}

/**
 * The player's own agents (08_Swarm/roster.ts): named, given pronouns, a role, a voice and a look, hired into a
 * pedestrian with a skill (through the recruiter) and dressed in that look, let go, forgotten. Every line is for the
 * console; the identities also reach the prompts of the people hired and the voice `say` speaks them in.
 */
export interface AgentBridge {
  /** Every record, a few lines each; one line when the roster is empty. */
  list(): string[]
  add(name: string): string[]
  set(name: string, field: 'pronouns' | 'role' | 'voice' | 'look' | 'name', value: string): string[]
  /** Asks someone nearby with `skill` over as `name` and dresses them; resolves with the outcome. */
  hire(name: string, skill: string): Promise<string>
  /** Lets `name`'s pedestrian go (the record stays). */
  dismiss(name: string): string
  forget(name: string): string
  /** The twelve voice profiles, one line each. */
  voices(): string[]
}

/** Sloane's spoken voice (onboarding/speaker.ts): the switch, the browser voice preferred, the tier a line takes, a line said now. */
export interface ConciergeBridge {
  status(): string[]
  on(on: boolean): string
  /** Prefers a browser voice by name ('' clears the preference); returns the line for the console. */
  voice(name: string): string
  voices(): string[]
  /** Says `text` now; resolves with the tier that said it. */
  say(text: string): Promise<string>
}

/** Rapier world counters, the shape of Physics.stats. */
export interface PhysicsCounters { stepMs: number; steps: number; bodies: number; colliders: number; ccd: number }

/** Maps a HUD snapshot plus the physics counters onto the terminal's stats. Pure; allocates one object (~4 Hz). */
export function ring0Stats(s: SipocSnapshot, physics: PhysicsCounters): Ring0Stats {
  const o = s.output, p = s.process
  return {
    fps: o.fps, frameMs: o.frameMs, p95Ms: o.p95Ms, cpuMs: o.cpuMs, gpuRenderMs: o.gpuRenderMs, gpuComputeMs: o.gpuComputeMs,
    rapier: {
      stepMs: physics.stepMs, physicsMs: o.physicsMs, steps: physics.steps,
      bodies: physics.bodies, colliders: physics.colliders, ccd: physics.ccd,
    },
    agents: {
      population: p.pedestrians, drawnNear: p.drawnNear, drawnFar: p.drawnFar,
      waiting: p.waiting, crossing: p.crossing, yielding: p.yielding, nudges: p.safetyNudges,
      ...(p.working === undefined ? {} : { working: p.working }),
    },
    vehicles: p.vehicles,
    quality: s.quality,
    kernel: s.kernel,
    sensing: { ageMs: p.sensingAgeMs ?? null, lagMs: p.sensingLagMs ?? 0 },
    ...(o.camera && { camera: { ...o.camera } }),
  }
}

/**
 * Stand-in while the engine is still booting (or failed to): identity commands work, everything that
 * needs the city reports "engine not running", the operator tier included (there is nothing to unlock).
 */
export function offlineBridge(brand: TerminalBridge['brand']): TerminalBridge {
  const down = (): never => { throw new Error('engine not running') }
  return {
    brand,
    stats: down, laws: down, clock: down, setClock: down, quality: down, audio: down,
    hal: { summary: down, devices: down, pair: down },
    adapter: () => '',
    ghost: down,
    rain: down,
    render: down,
    captions: down,
    topics: { list: down, get: down, children: down, status: down },
    ping: { at: down, list: down, newest: down, clear: down },
    operator: {
      unlock: down, lock: down, unlocked: down, exec: down, tuning: down, tune: down,
      features: { lines: down, about: down, prompt: down, explain: down, steer: down, clamp: down, release: down, reset: down },
      elite: { status: down, unlocked: down, unlock: down, lock: down, set: down, writes: down },
      ask: down, askStatus: down, askSet: down, askConnect: down, askStop: down, say: down, sayStatus: down, saySet: down, sayStop: down,
      api: down, harnesses: down, harness: down,
      swarm: { plan: down, run: down, status: down, stop: down, audit: down, verify: down, get roles() { return down() }, get quota() { return down() } },
      acts: { pending: () => null, follow: () => () => {}, allow: down, refuse: down, log: () => [], verify: down, list: () => [] },
    },
    record: { start: down, stop: down, status: down, supported: down },
    recruit: { ask: down, rally: down, listen: down, stop: down, install: down, dismiss: down, status: down, skills: () => [] },
    memory: { status: down, ledger: down, forget: down },
    look: { show: down, set: down },
    model: { pick: down, forget: down, load: down, unload: down, gpu: down, log: down },
  }
}
