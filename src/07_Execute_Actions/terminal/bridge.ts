/**
 * Why does this file exist? It is the air gap between the Ring-0 terminal and the running city: the
 * only surface the console can reach. It carries read-only telemetry plus a few operator knobs (clock,
 * quality tier, audio, ghost view, drawing, captions, hardware pairing), the view-only pings and the player's look,
 * recruitment (asking someone nearby over by skill, or an Active recruit to a pinged point: the one knob that
 * reaches a pedestrian, and only through the physics worker's own checks), the swarm's memory (read, or erased on
 * command), the opt-in network session and, behind an explicit `operator unlock`, the operator tier
 * (sandboxed scripts, prompts to the local model, speech, tuning keys, physics harnesses, the local .agv recorder)
 * that the engine builds over its SimControls. A script, a prompt or speech runs only through the capability gateway:
 * while someone tethered to the operator has the skills it names, and no longer. The console itself holds no engine,
 * physics, agent, gateway or storage reference: capability only ever flows through here.
 * What breaks if it is removed? The terminal has nothing to observe or tune and does not compile.
 */
import type { HalDevice } from '../../04_Connect_Hardware/hal.ts'
import type { LawText } from '../../02_Define_The_Rules/laws.ts'
import type { CameraStats, KernelStats, NetReport, QualityState, RecordingState, SipocSnapshot } from '../../05_Observe_Environment/telemetry.ts'
import type { RecorderSource } from '../../05_Observe_Environment/recorder.ts'
import type {
  AskResult, ExecResult, GatedAsk, GatedRun, GatedSay, GateTether, MindStatus, Piece, RunResult, RunState, SayResult, VoiceStatus, apiDoc,
} from '../operator.ts'
import type { HarnessReport, harnesses } from '../harness.ts'
import type { LookChange } from '../../03_Spawn_Agents/look.ts'

export type {
  HalDevice, LawText, AskResult, ExecResult, GatedAsk, GatedRun, GatedSay, GateTether, MindStatus, Piece, RunResult, RunState, SayResult,
  VoiceStatus, HarnessReport, RecorderSource, RecordingState, NetReport, LookChange,
}

export interface Ring0Stats {
  fps: number; frameMs: number; p95Ms: number; cpuMs: number; gpuRenderMs: number; gpuComputeMs: number
  /** stepMs: one world.step(); physicsMs: one whole step in the physics worker; steps: substeps last step. */
  rapier: { stepMs: number; physicsMs: number; steps: number; bodies: number; colliders: number; ccd: number }
  agents: { population: number; drawnNear: number; drawnFar: number; waiting: number; crossing: number; yielding: number; nudges: number }
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
  /** Stops the answer being generated, if any (the operator's own stop); returns what it did. */
  askStop(): string
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
  saySet(key: 'model' | 'server' | 'voice' | 'auto', value: string): string
  /** Stops whatever is being said, if anything (the operator's own stop); returns what it did. */
  sayStop(): string
  api(): ReturnType<typeof apiDoc>
  harnesses(): ReturnType<typeof harnesses>
  harness(name: string): Promise<HarnessReport>
}

/**
 * The .agv recorder (recorder.ts), operator-gated by the terminal. `start` prompts — the save dialog,
 * and the camera for source 'camera' — so the terminal calls it synchronously inside the Enter keydown,
 * like pair(); the host must reach showSaveFilePicker / getUserMedia before its first await. It
 * resolves with the codec in use ('av01.0.04M.08', 'avc1.42E01F', 'vp09.00.10.08'). `stop` flushes
 * and closes the file and resolves with where it went, e.g. "saved to onyx-2026….agv" or "downloaded
 * onyx-2026….agv" (may be ''). `status` is the live RecordingState the HUD shows; `supported` says why
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
  ask(skill: string): Promise<{ ok: boolean; message: string }>
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
 * tier 0–4, `audio` takes 'on' / 'off' or a volume in percent (0–100). Called with no argument, both
 * only report. A method may throw; the terminal prints the message and carries on.
 */
export interface TerminalBridge {
  /** `track`: which shell mounted the console: 'gui' (the city, the engine's bridge) or 'tty' (?boot=tty: the full-screen console alone). */
  readonly brand: { name: string; version: string; host: string; track?: 'gui' | 'tty' }
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
  hal: { summary(): string; devices(): HalDevice[]; pair(kind: 'hid' | 'serial' | 'bluetooth'): Promise<HalDevice | null> }
  /** GPU adapter description. */
  adapter(): string
  /** Ghost view (view-only: the physics shapes drawn as code over the frame): on, off, or the status line. */
  ghost(arg?: 'on' | 'off'): string
  /**
   * Drawing the city (view-only: physics, audio and this console keep running while it is off and the canvas stays
   * black): on, off, or the status line ('on' | 'off').
   */
  render(arg?: 'on' | 'off'): string
  /** Closed captions for every sound (view-only; the soundscape keeps sounding): on, off, or the status line ('captions: on' | 'captions: off'). */
  captions(arg?: 'on' | 'off'): string
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
    render: down,
    captions: down,
    ping: { at: down, list: down, newest: down, clear: down },
    operator: {
      unlock: down, lock: down, unlocked: down, exec: down, tuning: down, tune: down,
      ask: down, askStatus: down, askSet: down, askStop: down, say: down, sayStatus: down, saySet: down, sayStop: down,
      api: down, harnesses: down, harness: down,
    },
    record: { start: down, stop: down, status: down, supported: down },
    recruit: { ask: down, rally: down, listen: down, stop: down, install: down, dismiss: down, status: down, skills: () => [] },
    memory: { status: down, ledger: down, forget: down },
    look: { show: down, set: down },
  }
}
