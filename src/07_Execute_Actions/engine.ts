/**
 * Why does this file exist? It wires the causal stages into one frame on the page: input (keyboard, mouse,
 * touch, gamepad, HAL peripherals) → controls sent to the physics realm → the first-person head → the crowd's
 * cull for this camera → solar cycle → post-processed render → spatial audio, while the quality governor keeps
 * the frame inside its budget. In cinema mode (the default) drawing is decoupled from that loop: every animation
 * frame still polls input, sends its step request, drives the haptics, poses the head and feeds the audio, but only
 * the frames the 24 fps pacer presents (cinema.ts) cull, light and render, through the 180° shutter, the ND and the
 * film response (postfx.ts). The simulation itself (Rapier, the fleet and its Ring-0 Bouncer, the avatar, the
 * Sanctuary, the Ring-0 audit, and the GPU pedestrians with their First-Law hazard sensing on a device of their
 * own) runs in a dedicated worker (physics.worker.ts): this file only sends it controls and commands, and draws
 * the plain numbers it sends back — the cars' poses and the pedestrians' render frames. It exposes a SIPOC X
 * snapshot for the HUD, the only bridge the Ring-0 terminal may use, and the narrow host recruitment uses (the
 * operator's position, the states, two commands, a sound cue). The operator's ping (08_Swarm/ping.ts) is resolved
 * here from the head's look ray against the page's own copies (never the realm) and kept on a board the HUD
 * draws; a walk ping is handed to the host's recruiter (onRally) as a plain request the physics realm re-validates.
 * A person's look (03_Spawn_Agents/look.ts) is a word per agent in the crowd's page-only storage attribute: setLook
 * writes it the way the dissolve amounts are written, and nothing of it reaches the physics realm either.
 * Local split screen (?players=2..4; viewports.ts, seats.ts, controls.ts): every player is a head of their own on a
 * camera of their own, an avatar of their own in the physics realm (SimInit.spawns, StepRequest.players, the realm's
 * avatars and drivings), a seat at the input's table, a viewport of the one canvas and a soundscape of their own in
 * head space over one shared audio context; view 0 is player 1's and is this engine's own camera, head and soundscape,
 * so with one player nothing of this changes. The post chain, the ghost view, the contact wipe, the dissolve scans,
 * the ping, the captions, the haptics and the HUD stay player 1's, and the post chain is off while the screen is split.
 * App.tsx owns the requestAnimationFrame loop and calls frame().
 * What breaks if it is removed? Nothing runs; every module is inert without this orchestration.
 */
import { Frustum, Matrix4, Vector3, type PerspectiveCamera, type RenderPipeline, type UniformNode } from 'three/webgpu'
import { BRAND } from '../brand.ts'
import { buildWorld, createRenderer, gpuBufferOf, LIGHT_TUNE_RANGE, ndStopsFor, type Gpu, type LightTuning, type World } from '../01_Initialize_World/world.ts'
import { CITY, CITY_SIZE, districtName } from '../01_Initialize_World/city.ts'
import { RegionPlaces, layoutOf, regionPhysics } from '../01_Initialize_World/region/regionWorld.ts'
import type { RegionPack } from '../01_Initialize_World/region/pack.ts'
import { formatClock, sunAt, type SunState } from '../01_Initialize_World/solar.ts'
import { SIGNAL, signalFor, walkAllowed } from '../02_Define_The_Rules/civic.ts'
import { THREE_LAWS } from '../02_Define_The_Rules/laws.ts'
import { kernelPanic } from '../02_Define_The_Rules/ring0Panic.ts'
import { CrowdView } from '../03_Spawn_Agents/crowd.ts'
import { LOOK_NONE, packLook, unpackLook, validateLook, type Look } from '../03_Spawn_Agents/look.ts'
import { packFrustumPlanes, type CrowdStats, type CullSettings } from '../03_Spawn_Agents/crowdCompute.ts'
import { CrowdCull } from '../03_Spawn_Agents/crowdCull.ts'
import { AGENTS_RANGE } from '../03_Spawn_Agents/crowdSensor.ts'
import { Input, TriggerFeedback } from '../04_Connect_Hardware/input.ts'
import { KEYBOARD_SEAT, type Seat } from '../04_Connect_Hardware/seats.ts'
import { FrameClock, type GlyphFamily, type KernelStats, type SeatView, type SipocSnapshot, type Toast } from '../05_Observe_Environment/telemetry.ts'
import { MemorySink, Recorder, fileSink, markdownFor, type RecorderSink, type RecorderSource } from '../05_Observe_Environment/recorder.ts'
import type { AgentTelemetry } from '../05_Observe_Environment/agv.ts'
import { Governor, defaultAgents, profileDevice, readDeviceHints, tierRange, type QualityKnobs } from '../05_Observe_Environment/governor.ts'
import { CAR_TUNE_RANGE, chassisBox, clampTuning, type CarTuning } from './car.ts'
import { FleetView } from './fleetView.ts'
import { HeadRig, aimRay, carriedYaw, yawFacing, type AimRay } from './head.ts'
import { SimClient } from './simClient.ts'
import { applyWalk, requestWalk, type ScriptedWalk } from './scriptedWalk.ts'
import { ENTER_RANGE, MODES, PERSON, POSE, RUN, type DriveControls, type FootControls, type PlayerControls, type SimCommand, type StepState } from './simProtocol.ts'
import { readControls } from './controls.ts'
import { clampPlayers, originBottomLeft, splitScreen, type Rect } from './viewports.ts'
import { buildPost, type CinemaPost } from './postfx.ts'
import { createGhost, type GhostView } from './ghost.ts'
import { CONTACT, ContactPulse, PoleIndex, carGap, carsWithin, peopleWithin, peopleWithinBox, personGap, personGapToBox, touching } from './contact.ts'
import { DISSOLVE, DissolveSet, carsOverlapping, copyDirty, poleSlot, type DissolveBuffer } from './dissolve.ts'
import { CINEMA, FramePacer, SHUTTER_SECONDS, exposureFor, type CameraMark } from './cinema.ts'
import { updateVolumetrics, type Volumetrics } from './volumetrics.ts'
import { operatorBridge, type Diary, type Mind, type SimControls, type SkillGate, type SpeechClip, type SpeechOut, type Utterance, type Voice } from './operator.ts'
import { applyQuality, type QualityTargets } from './quality.ts'
import { SPEECH, Soundscape, sharedAudioContext, wallsBetween, type AudioFrame } from './audio.ts'
import { roomAt } from './acoustics.ts'
import { CaptionTrack, captionText } from './captions.ts'
import { ring0Stats, type TerminalBridge } from './terminal/bridge.ts'
import { familyOf, glyph } from './glyphs.ts'
import { PING_KINDS, PING_WORDS, PingBoard, pickPing, rallyPlan, type Ping, type Pick, type PingKind, type RallyRequest } from '../08_Swarm/ping.ts'

export interface EngineOptions {
  /** Pedestrians to simulate; absent: as many as the device profile allows (governor.ts defaultAgents). */
  agents?: number
  cars: number
  pixelRatio: number
  seed: number
  /** Starting local solar time, hours. */
  startHour: number
  /** Real minutes per simulated day. */
  dayMinutes: number
  /** Caps: `false` keeps shadows / post-processing off at every quality tier. */
  shadows: boolean
  post: boolean
  profile: boolean
  /** A fixed quality tier (0–4), or 'auto' for the governor. */
  quality: number | 'auto'
  /** Frame-rate target; 0 = estimate from the display (held within 60–90). */
  targetFps: number
  /** Start with spatial audio enabled (it still waits for a user gesture). */
  audio: boolean
  /**
   * Closed captions of every spatial sound (captions.ts; default on, ?captions=0 off): each sound's start, change and
   * stop as a HUD line with its bearing and distance, speech with its words. setCaptions() turns them at run time.
   */
  captions?: boolean
  /** ?debug: the physics worker also accepts fault-injection commands (the harness's). Fixed at boot; off in production. */
  debug?: boolean
  /**
   * The AI fleet on the fixed track network (default on; ?tracks=0 turns it off): cars seated in headway slots on the
   * right-turn rings of 06_Make_Decisions/tracks.ts. Off, they take the random street-hopping routes.
   */
  tracks?: boolean
  /**
   * The cinema camera (default on; ?cinema=0 turns it off): 24 presented frames per second through a 180° shutter,
   * a variable ND and the film response. Off, every animation frame is drawn and tone-mapped with ACES.
   */
  cinema?: boolean
  /**
   * A surveyed region to walk instead of the procedural city (the pilot build). Its streets have no traffic or crowd
   * yet: the fleet is empty and the GPU crowd, still simulated on the procedural grid far from the region, is not drawn.
   */
  region?: RegionPack | null
  /**
   * Local players on this one canvas, 1 (default) to 4 (?players; viewports.ts PLAYERS_RANGE): each a viewport, a
   * head, an avatar in the physics realm, a seat for a gamepad (seats.ts) and a soundscape of their own. More than
   * one turns the post chain off (it is player 1's alone); the HUD stays player 1's.
   */
  players?: number
}

/** The options as the engine runs them: the crowd's size decided, the player count clamped, and where the page runs. */
export type EngineConfig = EngineOptions & { agents: number; players: number; host: 'browser' | 'native' }

/**
 * Guardrail haptics (rumble 0..1, sent through the HAL bus, which picks WebHID or the Gamepad API and never
 * awaits the device): a steady low hum while the L2 limiter withholds throttle, and a short strong thump on
 * the rising edge of a First-Law hold or a full manual brake (both decided in the physics realm).
 */
const HAPTICS = { limiter: 0.2, pulse: 1, pulseMs: 180 } as const
/** Longest simulated time one step request carries when the worker fell behind, s. */
const MAX_STEP_DT = 0.1
/** How often the pedestrians' positions are copied out of the crowd frames for SimControls.crowd.positions, ms. */
const CROWD_COPY_MS = 250
/**
 * Split screen: how far apart players 1..3 spawn along the sidewalk beside player 0, m, and each player's audio pools
 * (audio.ts Design B: smaller car-voice and murmur pools per head keep the panner count near forty for four players).
 */
const SPLIT = { spawnGap: 1.5, voices: 3, beds: 2 } as const
/**
 * Whether three's WebGPU canvas viewport is measured from the bottom-left corner (viewports.ts originBottomLeft). The
 * WebGPU backend hands setViewport/setScissor straight to the pass, whose origin is the top-left corner: no flip.
 */
const ORIGIN_FLIP = false

/**
 * One local player's view: their head (HeadRig) on a camera of their own, its frustum pack for the crowd cull, the
 * viewport it draws into, the car heading the head is carried by, the controls the realm gets for them, and their
 * soundscape with its frame. View 0 is player 1's and wraps the engine's own camera, rig, frame and soundscape.
 */
interface PlayerView {
  readonly seat: Seat
  readonly camera: PerspectiveCamera
  readonly rig: HeadRig
  readonly frustum: Frustum
  readonly projScreen: Matrix4
  readonly planes: Float32Array
  /** The camera's position for the cull, copied without allocating. */
  readonly eye: { x: number; y: number; z: number }
  /** In logical pixels, y down from the canvas's top edge (resize); the full canvas with one player. */
  rect: Rect
  /** The driven car's heading last frame, so the head turns with the car. */
  carHeading: number
  readonly foot: FootControls
  readonly drive: DriveControls
  readonly sound: AudioFrame
  readonly audio: Soundscape
  /** The 2 m cell this head was last found in (its room). */
  listenerCell: number
}

/** One soundscape's frame, mutated in place every tick; car slots keep fleet order (voice hysteresis is by index). */
function audioFrameOf(cars: number): AudioFrame {
  const list = []
  for (let i = 0; i < cars; i++) list.push({ x: 0, z: 0, heading: 0, speed: 0, player: false })
  return {
    dt: 0,
    listener: { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 },
    cars: list,
    crowd: { near: 0, waiting: 0, crossing: 0 },
    daylight: 1,
    walk: { ew: false, ns: false },
    intersection: { x: 0, z: 0 },
    interior: false,
    speaker: { x: Number.NaN, z: Number.NaN, walls: 0 },
  }
}

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th'}`
/** What a ping landed on, for its caption: 'a spot', 'person 12', 'car 3', 'pole 7'. */
const pingWhat = (p: Ping): string => (p.pick === 'point' ? 'a spot' : `${p.pick} ${p.index}`)

/** One prop's dissolve amounts to its instanced attribute (dirty range only), marked for three's upload, then cleaned. */
function flushProp(b: DissolveBuffer, attr: { array: ArrayLike<number>; needsUpdate: boolean }): void {
  if (!b.dirty) return
  copyDirty(b, attr.array as Float32Array)
  attr.needsUpdate = true
  b.clean()
}

/** The 2 m cell of a point as one number (NaN for a point that is not finite), for the room caches. */
const cellOf = (x: number, z: number): number => (Number.isFinite(x + z) ? Math.floor(x / 2) * 1e6 + Math.floor(z / 2) : Number.NaN)


/** Quality state shared by create() and the running engine: what is applied, and where it lands. */
interface QualityRig {
  governor: Governor
  targets: QualityTargets
  applied: QualityKnobs
  /** URL caps (?shadows=0, ?post=0) folded into every tier. */
  mask: (k: QualityKnobs) => QualityKnobs
  live: { post: boolean; volumetrics: boolean; cull: CullSettings; crowd: CrowdCull | null }
}

/** The ?debug harness's view of the physics realm: the mirrored state and the command queue, nothing more. */
/**
 * What recruitment (08_Swarm/recruitment.ts) may use of the engine, and nothing more: where the operator's head
 * is, the states the physics realm sends (to read the pedestrians' positions and the answers), a way to send the
 * two recruitment commands, and the soundscape's cue. No body, car, pedestrian buffer or other command is reachable.
 */
export interface RecruitHost {
  /** Pedestrians in each render frame (the first is the player's own body). */
  readonly agents: number
  /** The operator's head position on foot (head.ts), or null while driving or halted. */
  operator(): { x: number; z: number } | null
  /** Queues a recruitment command for the physics realm; any other command is dropped here. */
  send(cmd: Extract<SimCommand, { c: 'recruit' | 'dismiss' | 'rally' }>): void
  /** Calls `fn` with each state the physics realm sends (its render frame still attached); returns the unsubscribe. */
  onState(fn: (s: StepState) => void): () => void
  /** The soundscape's recruitment cue at (x, z); false when it cannot sound. */
  cue(x: number, z: number): boolean
}

export interface DebugSim {
  state(): StepState
  send(cmd: SimCommand): void
  /** Resolves with the next state the worker sends. */
  next(): Promise<StepState>
}

export class Engine {
  readonly errors: string[] = []
  readonly input: Input
  /** Player 1's soundscape (every player has one: views). Over a context of its own alone; in head space over the shared one split. */
  readonly audio: Soundscape
  /** One view per local player (PlayerView); views[0] is player 1's, this engine's own camera, head and soundscape. */
  private readonly views: readonly PlayerView[]
  private readonly canvas: HTMLCanvasElement
  private readonly gpu: Gpu
  private readonly world: World
  /** The page's share of the crowd: its render buffers and the cull pass (the crowd itself lives in the worker). */
  private readonly crowd: CrowdCull
  /** The page's end of the physics realm: numbers in, numbers out. */
  private readonly sim: SimClient
  private readonly view: FleetView
  /** The first-person head: the only thing that places the camera (future WebXR reads/overrides its pose). */
  private readonly rig = new HeadRig()
  /** The driven car's heading last frame, so the head turns with the car. */
  private carHeading = 0
  /** On foot the body faces where the head looks. */
  private avatarHeading = 0
  private readonly post: RenderPipeline
  private readonly volumetrics: Volumetrics
  /** The cinema camera's pacer and post uniforms (both null with ?cinema=0: every animation frame is drawn). */
  private readonly pacer: FramePacer | null
  private readonly cinema: CinemaPost | null
  /** The span the pedestrians' motion vectors cover (crowd.ts CrowdView.frameSeconds). */
  private readonly crowdFrameSeconds: UniformNode<'float', number>
  /** Ghost view: the physics shapes as code over the finished frame (G, or the console's ghost). */
  private readonly ghost: GhostView
  /** When the last frame was drawn, ms (the ghost view's fade runs on drawn frames). */
  private lastDrawnMs = Number.NaN
  /** The region being walked (?region), its places (street names, the minimap), or null in the procedural city. */
  private readonly places: RegionPlaces | null
  private readonly regionName: string | null
  /** Ghost-mode collision's transition (contact.ts): the city's poles, the wipe's pulse, and the nearest pedestrian's
   *  gap to the user's body as of the newest crowd frame (on foot, and at the wheel). */
  private readonly poles: PoleIndex
  private readonly contactPulse = new ContactPulse()
  private personGapFoot: number = CONTACT.far
  private personGapCar: number = CONTACT.far
  /** The code dissolve: which instances the user's body is inside, and how far each has dissolved (view-only). */
  private readonly dissolve: DissolveSet
  /** The crowd's amounts on the GPU (three's buffer for CrowdView.dissolve), written like the frame upload. */
  private readonly crowdDissolve: GPUBuffer
  /** The crowd's look words on the GPU (three's buffer for CrowdView.look) and the page's copy of them (setLook, lookOf). */
  private readonly crowdLook: GPUBuffer
  private readonly lookWords: Uint32Array
  private readonly poleOut = new Int32Array(DISSOLVE.maxPoles)
  private readonly carOut = new Int32Array(DISSOLVE.maxCars)
  private readonly overlapOut: Int32Array
  private readonly peopleOut = new Int32Array(DISSOLVE.maxPeople)
  /** The people gathered with the newest crowd frame (received), touched every animation frame until the next. */
  private peopleCount = 0
  /** Where the camera was at the last frame drawn through the velocity buffer (valid while `marked`; not: a cut). */
  private readonly lastMark: CameraMark = { x: 0, y: 0, z: 0, seat: -1 }
  private marked = false
  private readonly mark: CameraMark = { x: 0, y: 0, z: 0, seat: -1 }
  /**
   * Whether present() draws (setRendering). Off is Track B's override: the console has the screen, the canvas is
   * black, and everything else in frame() (the step requests, the head, the haptics, the audio) runs as before.
   */
  private rendering = true
  /** The camera's projection × view at the last presented frame. */
  private readonly lastViewProjection = new Matrix4()
  private lastPresentMs = Number.NaN
  /** Presented frames drawn as cuts (no blur), since boot. */
  private cuts = 0
  /** Operator scale on the sun shafts (0–2; the tier decides whether they run at all). */
  private volumetricsScale = 1
  private controls: SimControls | null = null
  /** The .agv recorder: local-only capture of the canvas or the camera, one telemetry record per frame. */
  private readonly recorder = new Recorder(() => this.frameTelemetry())
  /** Kernel/audit counters at the previous recorded frame, so the markdown log names only what changed. */
  private readonly recSeen = { law1: 0, flips: 0, tier: '', panic: null as string | null }
  private cameraTrack: MediaStreamTrack | null = null
  /** Where the current recording goes, for the console's stop line. */
  private recordingWhere = ''
  private readonly options: EngineConfig
  private readonly quality: QualityRig
  private readonly clock = new FrameClock()
  private readonly trigger: TriggerFeedback
  private readonly frustum = new Frustum()
  private readonly projScreen = new Matrix4()
  private readonly planes = new Float32Array(24)
  private readonly toasts: Toast[] = []
  private readonly sound: AudioFrame
  /** Reused haptics request (the bus copies values and writes only on change). */
  private readonly haptics = { rumble: 0 }
  /** The pedestrian whose speech is playing (speechOut), or −1: the voice follows them. */
  private speaker = -1
  /** The 2 m cells the listener and the speaker were last found in: their rooms (acoustics.ts) are recomputed on a change. */
  private listenerCell = Number.NaN
  private speakerCell = Number.NaN
  /** The soundscape's closed captions (captions.ts), fed by every sound event with the head pose as the listener. */
  private readonly captions = new CaptionTrack()
  private captionsOn: boolean
  /** A scripted walk (SimControls.avatar.walk): the velocity it asks for, and until when (performance.now() ms). */
  private readonly scriptedWalk: ScriptedWalk = { x: 0, z: 0, until: 0 }
  /** Every pedestrian's x, z from the newest crowd frame, refreshed at most CROWD_COPY_MS apart (SimControls.crowd.positions). */
  private crowdXZ = new Float32Array(0)
  private crowdCopiedAt = -Infinity
  /** Every pedestrian's x, y, z, heading from the same copy (the ping's capsules, 08_Swarm/ping.ts PingWorld.frame). */
  private crowdPose = new Float32Array(0)
  /** The ping: the head's look ray, the last thing it met, the board of marks standing, and a point to project them. */
  private readonly ray: AimRay = { ox: 0, oy: 0, oz: 0, dx: 0, dy: 0, dz: -1 }
  private readonly lastPick: Pick = { kind: 'point', index: -1, x: 0, y: 0, z: 0, distance: 0 }
  private readonly pings = new PingBoard()
  private readonly pingPoint = new Vector3()
  /**
   * The host's rally hand-off (App.tsx: the recruiter's rally): called with the plain request a walk ping (go or
   * gather) makes for an Active recruit once rallyPlan allows it; the recruiter checks the page's copy and the physics
   * realm decides on its own readings. Null: a ping is a mark and nothing more. The engine never sends a rally itself.
   */
  onRally: ((request: RallyRequest) => void) | null = null
  /** Real-time end of the current haptic thump (ms, rAF clock). */
  private pulseUntil = 0
  private readonly foot: FootControls = { x: 0, z: 0, heading: 0 }
  private readonly drive: DriveControls = { steer: 0, fwd: 0, back: 0, handbrake: false }
  /** Simulated seconds not yet sent to the worker (it was still busy with the previous step). */
  private pendingDt = 0
  /** A state arrived since the fleet's instance matrices were last written. */
  private fresh = true
  /** The operator's car tuning as this page set it (the worker clamps identically and is authoritative). */
  private readonly tuning: CarTuning = { power: 1, drag: 1, grip: 1, brake: 1 }
  private readonly carPos = { x: 0, y: 0, z: 0 }
  private readonly carRot = { x: 0, y: 0, z: 0, w: 1 }
  private readonly waiters: ((s: StepState) => void)[] = []
  /** Recruitment's view of each state (recruitHost). */
  private readonly stateListeners = new Set<(s: StepState) => void>()
  /** The name the user gave the Concierge ('' until they do). */
  private playerName = ''
  private bridge: TerminalBridge | null = null
  private toastId = 0
  private hours: number
  private sun: SunState
  private simTime = 0
  private lastMs = -1
  private cpuMs = 0
  /** EMA of posting one step request (structured clone of the controls), ms: the realm crossing's cost here. */
  private postMs = 0
  private gpuRenderMs = 0
  private resolving = false
  /** Pedestrian render frames received from the worker and uploaded. */
  private crowdFrames = 0
  private walked = 0
  private driven = 0
  private disposed = false
  /** Why the simulation halted, when the worker's state could not carry it (a fault in the physics realm). */
  private lockReason: string | null = null
  /** Set by a Ring-0 kernel panic: the frame loop is frozen from then on (App stops scheduling frames). */
  halted = false
  /** The host's lock-screen hook, called once with the panic reason. */
  onHalt: ((reason: string) => void) | null = null

  private constructor(p: {
    canvas: HTMLCanvasElement; gpu: Gpu; world: World; crowd: CrowdCull; sim: SimClient; view: FleetView
    post: RenderPipeline; volumetrics: Volumetrics; cinema: CinemaPost | null; crowdFrameSeconds: UniformNode<'float', number>; ghost: GhostView
    options: EngineConfig; quality: QualityRig; places: RegionPlaces | null; crowdDissolve: GPUBuffer; crowdLook: GPUBuffer
  }) {
    this.places = p.places
    this.regionName = p.options.region?.name ?? null
    this.canvas = p.canvas
    this.gpu = p.gpu
    this.world = p.world
    this.crowd = p.crowd
    this.sim = p.sim
    this.view = p.view
    this.post = p.post
    this.volumetrics = p.volumetrics
    this.cinema = p.cinema
    this.pacer = p.cinema ? new FramePacer(CINEMA.fps) : null
    this.crowdFrameSeconds = p.crowdFrameSeconds
    this.ghost = p.ghost
    this.poles = new PoleIndex(p.world.furniture)
    const f = p.world.furniture
    this.dissolve = new DissolveSet({ lamps: f.lamps.length, trees: f.trees.length, signals: f.signals.length, cars: p.sim.meta.suv.length, people: p.options.agents })
    this.crowdDissolve = p.crowdDissolve
    this.crowdLook = p.crowdLook
    this.lookWords = new Uint32Array(p.options.agents)
    this.overlapOut = new Int32Array(p.sim.meta.suv.length)
    this.options = p.options
    this.quality = p.quality
    this.hours = p.options.startHour
    this.sun = sunAt(this.hours)
    // Input opens the hardware bus and re-attaches previously granted peripherals (never prompts).
    this.input = new Input(p.canvas)
    this.trigger = new TriggerFeedback(this.input.hal)
    // Split screen: every player's soundscape over one shared context, each in head space (Web Audio has one listener
    // per context); alone, player 1's soundscape owns its context and its listener is the head, as ever.
    const players = p.options.players
    const share = players > 1 ? sharedAudioContext() : null
    const soundscape = () => (share ? new Soundscape({ context: share, space: 'head', voices: SPLIT.voices, beds: SPLIT.beds }) : new Soundscape())
    this.audio = soundscape()
    if (!p.options.audio) this.audio.setEnabled(false)
    this.captionsOn = p.options.captions !== false
    // Every sound's start, change and stop, captioned from where the head is (HeadRig.pose is the listener).
    this.audio.onSound = (e) => { if (this.captionsOn) this.captions.push(e, this.rig.pose) }
    // One audio frame, mutated in place every tick; car slots keep fleet order (voice hysteresis is by index).
    this.sound = audioFrameOf(p.sim.meta.suv.length)
    // The views: player 1's wraps this engine's own camera, head, controls, frame and soundscape; every other player
    // gets their own, a seat at the input's table and their controls in every step request (SimClient.setPlayers).
    const cars = p.sim.meta.suv.length
    const views: PlayerView[] = [this.viewOf(KEYBOARD_SEAT, p.world.camera, this.rig, this.foot, this.drive, this.sound, this.audio)]
    for (let k = 1; k < players; k++) {
      const audio = soundscape()
      if (!p.options.audio) audio.setEnabled(false)
      views.push(this.viewOf(k as Seat, p.world.camera.clone(), new HeadRig(), { x: 0, z: 0, heading: 0 }, { steer: 0, fwd: 0, back: 0, handbrake: false }, audioFrameOf(cars), audio))
    }
    this.views = views
    this.input.setPlayers(players)
    const controls: PlayerControls[] = []
    for (let k = 1; k < views.length; k++) controls.push({ foot: views[k].foot, drive: views[k].drive })
    p.sim.setPlayers(controls)
    if (views.length > 1) this.layout()
    this.recorder.onEnd = (st, error) => {
      this.cameraTrack?.stop()
      this.cameraTrack = null
      if (error) this.toast('Recording stopped', `${error} · ${st.frames} frames kept`)
    }
    p.sim.listen((s, prev) => this.received(s, prev), (reason) => this.panicked(reason))
    p.gpu.device.addEventListener('uncapturederror', (e) => this.errors.push((e as GPUUncapturedErrorEvent).error.message))
    void p.gpu.device.lost.then((info) => { if (!this.disposed) this.errors.push(`device lost: ${info.message}`) })
  }

  static async create(canvas: HTMLCanvasElement, requested: EngineOptions): Promise<Engine> {
    const gpu = await createRenderer(canvas, requested.pixelRatio, requested.profile)
    // The device profile first: it decides the starting tier and, unless the page said (?crowd), how many pedestrians
    // the physics realm simulates (the GPU buffers are sized for them at boot; the governor scales how many are drawn).
    const hints = readDeviceHints(gpu.adapterInfo)
    const profile = profileDevice(hints)
    const pack = requested.region ?? null
    // A region has no traffic yet: its fleet is empty (the AI drives the procedural grid only).
    // Nor pedestrians: its crowd is hidden, so it runs at the smallest size the realm takes (the GPU is the region's).
    // Split screen: the post chain is player 1's alone (one pipeline, one velocity history, one full-screen pass), so
    // with more than one player it is off at every tier, as ?post=0 is, and every viewport takes the direct path.
    const players = clampPlayers(requested.players)
    const options: EngineConfig = {
      ...requested, players, post: requested.post && players === 1,
      cars: pack ? 0 : requested.cars, agents: pack ? AGENTS_RANGE[0] : requested.agents ?? defaultAgents(profile), host: hints.host ?? 'browser',
    }
    const layout = pack ? layoutOf(pack) : null
    const places = pack && layout ? new RegionPlaces(pack, layout) : null
    const world = buildWorld(gpu.renderer, options.seed, pack && layout ? { pack, layout } : null)
    // In a region: a sidewalk of the arterial nearest the region's origin (its downtown), facing along the street.
    const start = places && layout ? places.spawn({ x: layout.offset.x, z: layout.offset.z }) : null
    const spawn = start ? { x: start.x, z: start.z } : { x: CITY_SIZE / 2 + CITY.lane, z: CITY_SIZE / 2 + 12 }
    // Players 1..3 (split screen) start beside player 0 along the sidewalk (the city's spawn sidewalk runs along z; a
    // region's along its street heading); the realm moves a spawn out of a building lot itself.
    const along = start ? { x: Math.sin(start.heading), z: Math.cos(start.heading) } : { x: 0, z: 1 }
    const spawns: { x: number; z: number }[] = []
    for (let k = 1; k < players; k++) spawns.push({ x: spawn.x + along.x * SPLIT.spawnGap * k, z: spawn.z + along.z * SPLIT.spawnGap * k })
    // The physics realm boots (Rapier, the city's colliders or the region's, the fleet) while this thread sets up quality.
    const simBoot = SimClient.create({
      seed: options.seed, cars: options.cars, agents: options.agents, boxes: world.boxes, furniture: world.furniture, spawn, debug: options.debug === true,
      region: pack && layout ? regionPhysics(pack, layout) : null, tracks: options.tracks !== false,
      ...(spawns.length > 0 && { spawns }),
    })

    // Start on the tier the device profile suggests (or the one the URL pins), before anything compiles:
    // the first applyQuality decides which shadow variant the materials are built with. Under the cinema camera the
    // governor holds its 24 presented frames as well as the animation frames' 60 FPS floor.
    const range = tierRange(profile)
    const targetMs = options.targetFps > 0 ? 1000 / options.targetFps : undefined
    const pacerMs = options.cinema === false ? undefined : 1000 / CINEMA.fps
    const governor = options.quality === 'auto'
      ? new Governor({ tier: profile.startTier, auto: true, targetMs, pacerMs, ...range })
      : new Governor({ tier: options.quality, auto: false, targetMs, pacerMs, ...range })
    const mask = (k: QualityKnobs): QualityKnobs => ({ ...k, shadows: k.shadows && options.shadows, post: k.post && options.post })
    const first = governor.knobs()
    // In a region nobody of the procedural crowd is drawn (they walk the procedural grid, kilometres from the region).
    const hidden = (c: CullSettings): CullSettings => (pack ? { ...c, maxDistance: 0 } : c)
    const live: QualityRig['live'] = {
      post: true,
      volumetrics: false,
      cull: hidden({ lodDistance: first.lodDistance, nearRadius: first.nearRadius, density: first.crowdDensity, maxDistance: first.maxDistance }),
      crowd: null,
    }
    const targets: QualityTargets = {
      renderer: gpu.renderer, sun: world.sun, basePixelRatio: options.pixelRatio,
      setCrowd: (c) => { live.cull = hidden(c); live.crowd?.setCull(live.cull) },
      setPost: (on) => { live.post = on },
      setVolumetrics: (on) => { live.volumetrics = on },
      setTextureSize: (size) => world.setTextureSize(size),
    }
    const applied = mask(first)
    applyQuality(applied, targets)

    const view0 = new CrowdView(options.agents)
    const sim = await simBoot
    if (sim.meta.agents !== options.agents) throw new Error(`the physics worker simulates ${sim.meta.agents} pedestrians, the page draws ${options.agents}`)
    const view = new FleetView(sim.meta.suv, sim.meta.paint, world.night)
    view.sync(sim.state.poses)
    world.scene.add(...view0.meshes, view.bodies, view.wheels)
    const ghost = createGhost({ boxes: world.boxes, furniture: world.furniture, suv: sim.meta.suv, crowdPos: view0.pos, agents: options.agents })
    const { pipeline: post, volumetrics, cinema } = buildPost(gpu.renderer, world.scene, world.camera, options.cinema === false ? null : { resorted: world.resorted }, ghost)

    const w = Math.max(1, canvas.clientWidth), h = Math.max(1, canvas.clientHeight)
    gpu.renderer.setSize(w, h, false)
    world.camera.aspect = w / h
    world.camera.updateProjectionMatrix()
    world.camera.position.set(spawn.x, 1.7, spawn.z + 4)
    world.update(options.startHour, 0, spawn.x, spawn.z)
    // Compile off the critical path, then draw once so three allocates every storage buffer the
    // compute passes share (crowd state, draw lists, indirect draw arguments).
    await gpu.renderer.compileAsync(world.scene, world.camera)
    // Draw once on BOTH paths (post and direct), so a later quality step that toggles post never compiles a
    // pipeline mid-game; the boot veil hides these frames.
    gpu.renderer.render(world.scene, world.camera)
    post.render()
    // The render buffers exist once three has drawn them (above); the worker's first frame goes straight in. The
    // looks (03_Spawn_Agents/look.ts): every body material reads the attribute, so the draws allocated it as well;
    // the cull reads each agent's body from it, setLook writes it.
    const crowdLook = gpuBufferOf(gpu.renderer, view0.look)
    const crowd = await CrowdCull.create(gpu.device, {
      pos: gpuBufferOf(gpu.renderer, view0.pos),
      vel: gpuBufferOf(gpu.renderer, view0.vel),
      pose: gpuBufferOf(gpu.renderer, view0.pose),
      drawArgs: gpuBufferOf(gpu.renderer, view0.drawArgs),
      drawLists: gpuBufferOf(gpu.renderer, view0.drawLists),
      look: crowdLook,
    }, view0.drawTemplate, options.agents, live.cull)
    live.crowd = crowd
    if (sim.state.crowdFrame) crowd.upload(sim.state.crowdFrame)
    if (options.profile) crowd.enableProfiling()
    const engine = new Engine({
      canvas, gpu, world, crowd, sim, view, post, volumetrics, cinema, crowdFrameSeconds: view0.frameSeconds, ghost, options,
      quality: { governor, targets, applied, mask, live }, places,
      // The code dissolve's crowd amounts: allocated by the draws above like the frame's buffers, written the same way.
      crowdDissolve: gpuBufferOf(gpu.renderer, view0.dissolve),
      crowdLook,
    })
    if (start) engine.input.yaw = yawFacing(start.heading)
    return engine
  }

  /** The minimap's layer in a region (its water, buildings and streets near a point); null in the procedural city. */
  get mapLayer(): ((ctx: CanvasRenderingContext2D, x: number, z: number, radius: number, dark: boolean) => void) | null {
    const p = this.places
    return p ? (ctx, x, z, radius, dark) => p.drawMap(ctx, x, z, radius, dark) : null
  }

  resize(): void {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight)
    this.gpu.renderer.setSize(w, h, false)
    this.world.camera.aspect = w / h
    this.world.camera.updateProjectionMatrix()
    // Split: the viewports are cut again and every camera takes its rect's aspect (player 1's included).
    if (this.views.length > 1) this.layout()
    // A new projection moves every pixel without anything moving: the next presented frame is a cut (player 1's: the
    // other viewports take the direct path, which keeps no velocity history to smear from).
    this.marked = false
  }

  /** A view record (PlayerView) over its parts; the rect is the whole canvas until layout() cuts it. */
  private viewOf(seat: Seat, camera: PerspectiveCamera, rig: HeadRig, foot: FootControls, drive: DriveControls, sound: AudioFrame, audio: Soundscape): PlayerView {
    const frustum = seat === KEYBOARD_SEAT ? this.frustum : new Frustum()
    const projScreen = seat === KEYBOARD_SEAT ? this.projScreen : new Matrix4()
    const planes = seat === KEYBOARD_SEAT ? this.planes : new Float32Array(24)
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight)
    return {
      seat, camera, rig, frustum, projScreen, planes, eye: { x: 0, y: 0, z: 0 }, rect: { x: 0, y: 0, width: w, height: h },
      carHeading: 0, foot, drive, sound, audio, listenerCell: Number.NaN,
    }
  }

  /**
   * Split screen: cuts the canvas into one rect per player (viewports.ts splitScreen, logical pixels; three scales them
   * by the pixel ratio in setViewport/setScissor), gives each camera its rect's aspect, and sets the renderer up for
   * scissored draws: autoClear off (present() clears the whole canvas once, then draws each rect) and the scissor test
   * on. Called at boot and on every resize, never per frame.
   */
  private layout(): void {
    const w = Math.max(1, this.canvas.clientWidth), h = Math.max(1, this.canvas.clientHeight)
    const rects = splitScreen(this.views.length, w, h)
    for (let k = 0; k < this.views.length; k++) {
      const v = this.views[k]
      v.rect = rects[k]
      v.camera.aspect = v.rect.width / v.rect.height
      v.camera.updateProjectionMatrix()
    }
    this.gpu.renderer.autoClear = false
    this.gpu.renderer.setScissorTest(true)
  }

  /** The renderer's viewport and scissor at a view's rect (split screen only; with one player neither is ever set). */
  private frameView(v: PlayerView): void {
    const r = originBottomLeft(v.rect, Math.max(1, this.canvas.clientHeight), ORIGIN_FLIP)
    this.gpu.renderer.setViewport(r.x, r.y, r.width, r.height)
    this.gpu.renderer.setScissor(r.x, r.y, r.width, r.height)
  }

  /** How many local players share the canvas (1..4). */
  get players(): number {
    return this.views.length
  }

  /** Every player's soundscape takes the gesture (App calls this on each click, key and touch): the shared context opens with the first. */
  unlockAudio(): void {
    for (const v of this.views) v.audio.unlock()
  }

  get adapter(): string {
    return this.gpu.adapterInfo
  }

  toast(title: string, body: string): void {
    this.toasts.unshift({ id: this.toastId++, title, body, time: this.simTime })
    if (this.toasts.length > 3) this.toasts.length = 3
  }

  /**
   * Drawing on or off (Track B's override: the console takes the screen). Off, present() draws nothing and the
   * canvas is cleared once to black; the physics realm, the step requests, the head, the haptics, the audio and the
   * console keep running, and the governor holds its tier (frames without a draw would read as cheap). On again, the
   * first frame drawn is a cut. View-only: nothing reaches the physics realm. Returns the status line the console
   * prints.
   */
  setRendering(on: boolean): string {
    const off = 'off: physics, audio and the console run; nothing is drawn (render on)'
    if (on === this.rendering) return on ? 'on' : off
    this.rendering = on
    if (on) {
      // The shutter has nothing to smear from: the next presented frame is a cut.
      this.marked = false
      return 'on'
    }
    this.gpu.renderer.clear()
    return off
  }

  /**
   * Ghost view on or off: the physics shapes as code over the finished frame (ghost.ts). View-only: nothing reaches
   * the physics realm. It lives in the post chain, so the chain stays on at every tier while it shows. Returns the
   * status line the toast and the console print.
   */
  setGhost(on: boolean): string {
    this.ghost.setOn(on)
    this.applyTier()
    if (on && this.views.length > 1) return 'needs the post-processing chain, which is off while the screen is split'
    if (on && !this.options.post) return 'needs the post-processing chain, which ?post=0 turned off'
    return on ? 'on: every physics shape as code (G to hide)' : 'off'
  }

  /**
   * Dresses an agent (0 is the player's own body; a recruit by their pedestrian number) in a look out of the crowd's
   * closed wardrobe (03_Spawn_Agents/look.ts), or null to dress them as the hash does again. The word goes to the
   * crowd's page-only storage attribute the way the dissolve amounts do (queue.writeBuffer; view-only: nothing
   * reaches the physics realm, nobody moves for it). Refused (false) for an agent outside the crowd, a look outside
   * the wardrobe, or once the city has stopped; the eye never sees its own body, but its shadow, the cull's body
   * choice and every other viewer do.
   */
  setLook(agent: number, look: Look | null): boolean {
    if (this.halted || this.disposed) return false
    if (!Number.isInteger(agent) || agent < 0 || agent >= this.lookWords.length) return false
    const word = look === null ? LOOK_NONE : validateLook(look) === null ? -1 : packLook(look)
    if (word < 0) return false
    this.lookWords[agent] = word
    this.gpu.device.queue.writeBuffer(this.crowdLook, agent * 4, this.lookWords, agent, 1)
    return true
  }

  /** The look an agent was dressed in (setLook), or null while the hash dresses them (or for no such agent). */
  lookOf(agent: number): Look | null {
    if (!Number.isInteger(agent) || agent < 0 || agent >= this.lookWords.length) return null
    return unpackLook(this.lookWords[agent])
  }

  /** Enter the nearest car, or leave the current one on the driver's (left) side (decided in the physics realm). */
  interact(): void {
    this.sim.send({ c: 'interact' })
  }

  /**
   * A ping of `kind` where the head looks (08_Swarm/ping.ts): the look ray (head.ts aimRay, on foot or at the wheel)
   * meets the page's own copies — the pedestrians' capsules in the crowd copy, the cars' chassis in the newest poses,
   * the lamps, trees and signal poles, else the ground — and the mark goes on the board, is cued and captioned where
   * it landed, and, for a walk ping (go or gather), is offered to the host's recruiter through onRally. Returns what
   * the ray met as plain data, or null when nothing was within range, the board refused (less than PING_INTERVAL_S
   * after the last, an unknown kind) or the city has stopped. Nothing here reaches the physics realm.
   */
  pingAt(kind: PingKind): Pick | null {
    if (this.halted || this.disposed || !PING_KINDS.includes(kind)) return null
    aimRay(this.rig.pose, this.ray)
    const s = this.sim.state
    const met = pickPing(this.ray, { frame: this.crowdPose, agents: this.options.agents, poses: s.poses, suv: this.sim.meta.suv, furniture: this.world.furniture }, this.lastPick)
    if (!met) return null
    const ping = this.pings.place(kind, this.lastPick, this.simTime)
    if (!ping) return null
    const pick = { kind: ping.pick, index: ping.index, x: ping.x, y: ping.y, z: ping.z, distance: this.lastPick.distance }
    // Cued and captioned where it landed: the cue's own 'ping' event carries this label into the captions.
    this.audio.cuePing(ping.x, ping.z, `${PING_WORDS[kind]}: ${pingWhat(ping)}`)
    for (let k = 1; k < this.views.length; k++) this.views[k].audio.cuePing(ping.x, ping.z)
    if (ping.kind === 'go' || ping.kind === 'gather') this.rallyFor(ping)
    return pick
  }

  /** The kind the key, button or touch asks: 'go', or the kind after the newest ping's when it was placed within a second. */
  private pingKindFor(now: number): PingKind {
    const newest = this.pings.newest(now)
    if (!newest || now - newest.at >= 1) return 'go'
    return PING_KINDS[(PING_KINDS.indexOf(newest.kind) + 1) % PING_KINDS.length]
  }

  /**
   * A walk ping as a rally: rallyPlan (08_Swarm/ping.ts) turns it into the plain request for one Active recruit (a go
   * ping) or one per Active recruit (a gather ping), or says why not; a request goes to the host (onRally), a reason to
   * a toast. Quiet while nobody is tethered: a ping then is a mark and nothing more.
   */
  private rallyFor(ping: Ping): void {
    const st = this.sim.state
    const recruits = st.recruits
    if (!recruits.some((r) => r.arrived)) return
    const operator = st.driving >= 0 ? null : { x: this.rig.pose.x, z: this.rig.pose.z }
    const agents = ping.kind === 'gather' ? recruits.filter((r) => r.arrived).map((r) => r.agent) : [undefined]
    for (const agent of agents) {
      const plan = rallyPlan(this.pings, recruits, operator, this.simTime, agent)
      if (plan.request) {
        const fn = this.onRally
        if (fn) {
          try { fn(plan.request) } catch (e) { this.errors.push(`rally: ${e instanceof Error ? e.message : String(e)}`) }
        }
      } else {
        this.toast('Rally', plan.reason)
      }
    }
  }

  /** Split screen as the snapshot reports it: the player count, each viewport's rect and each seat (its pad, glyph family and mode). */
  private playersView(st: StepState): NonNullable<SipocSnapshot['output']['players']> {
    const seats: SeatView[] = []
    for (let k = 0; k < this.views.length; k++) {
      const seat = this.views[k].seat
      seats.push({ seat, pad: this.input.seats.padIndexOf(seat), family: this.input.familyOf(seat), mode: (st.drivings[k] ?? -1) >= 0 ? 'vehicle' : 'foot' })
    }
    return { count: this.views.length, rects: this.views.map((v) => ({ x: v.rect.x, y: v.rect.y, width: v.rect.width, height: v.rect.height })), seats }
  }

  /** The pings standing now as the HUD draws them: the board's marks with their distance from the head and their place on the screen. */
  private pingMarks(): SipocSnapshot['output']['pings'] {
    const alive = this.pings.alive(this.simTime)
    if (alive.length === 0) return undefined
    const cam = this.world.camera, eye = this.rig.pose, v = this.pingPoint, now = this.simTime
    return alive.map((p) => {
      v.set(p.x, p.y, p.z).project(cam)
      const ahead = v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1
      return {
        id: p.id, kind: p.kind, pick: p.pick, index: p.index, x: p.x, z: p.z, age: now - p.at, left: p.until - now,
        distance: Math.hypot(p.x - eye.x, p.y - eye.y, p.z - eye.z),
        sx: ahead ? (v.x + 1) / 2 : Number.NaN, sy: ahead ? (1 - v.y) / 2 : Number.NaN,
      }
    })
  }

  /** A new state from the physics realm: what changed for the player, the distance counters, the haptic edge. */
  private received(s: StepState, prev: StepState): void {
    this.fresh = true
    // Where they stand, for SimControls.crowd.positions (the frame's first 4 floats per person are its position), a few
    // times a second: before the upload, which hands the buffer back to the worker.
    const now = performance.now()
    if (s.crowdFrame && now - this.crowdCopiedAt >= CROWD_COPY_MS) {
      const n = this.options.agents, frame = s.crowdFrame
      if (frame.length >= 4 * n) {
        if (this.crowdXZ.length !== 2 * n) this.crowdXZ = new Float32Array(2 * n)
        for (let i = 0; i < n; i++) {
          this.crowdXZ[2 * i] = frame[4 * i]
          this.crowdXZ[2 * i + 1] = frame[4 * i + 2]
        }
        if (this.crowdPose.length !== 4 * n) this.crowdPose = new Float32Array(4 * n)
        this.crowdPose.set(frame.subarray(0, 4 * n))
        this.crowdCopiedAt = now
      }
    }
    // The contact wipe's view of the crowd: who is nearest the user's body in this frame (and, for the code dissolve,
    // whose bodies it is inside).
    if (s.crowdFrame) this.contactScan(s)
    // The pedestrians the worker simulated: straight into the render buffers (the copy is only ever drawn).
    if (s.crowdFrame && this.crowd.upload(s.crowdFrame)) this.crowdFrames++
    for (const ev of s.events) {
      // Another local player's car: their head sits down facing its windscreen; the toasts and the haptics are player 1's.
      if ((ev.e === 'entered' || ev.e === 'exited') && ev.player > 0) {
        const v = this.views[ev.player]
        if (v && ev.e === 'entered') {
          v.carHeading = ev.heading
          this.input.intent(v.seat).yaw = yawFacing(ev.heading)
        }
        continue
      }
      if (ev.e === 'entered') {
        // Sit down facing the windscreen; the head then turns with the car.
        this.carHeading = ev.heading
        this.input.yaw = yawFacing(ev.heading)
        const g = (a: Parameters<typeof glyph>[0]) => glyph(a, this.glyphs)
        this.toast(ev.suv ? 'SUV' : 'Sedan', `${g('throttle')} / ${g('brake')} throttle and brake · ${g('handbrake')} handbrake · ${g('interact')} to exit`)
      } else if (ev.e === 'exited') {
        this.pulseUntil = 0
        this.toast('Vehicle parked', 'Hazards on, doors locked.')
      }
    }
    const stepDt = Math.max(0, s.simTime - prev.simTime)
    if (s.driving < 0 && prev.driving < 0) {
      const d = Math.hypot(s.avatar.x - prev.avatar.x, s.avatar.z - prev.avatar.z)
      // A teleport is not a walk.
      if (d <= 0.5 + RUN * stepDt * 1.5) this.walked += d
    } else if (s.driving >= 0) {
      this.driven += Math.abs(s.poses[s.driving * POSE.stride + POSE.speed]) * stepDt
    }
    if (s.driving >= 0 && s.haptics.thump) this.pulseUntil = performance.now() + HAPTICS.pulseMs
    const waiters = this.waiters.splice(0)
    for (const w of waiters) w(s)
    for (const l of this.stateListeners) {
      try { l(s) } catch (e) { this.errors.push(`recruitment: ${e instanceof Error ? e.message : String(e)}`) }
    }
  }

  /** Recruitment's narrow view of the engine (RecruitHost). Built per call, frozen. */
  recruitHost(): RecruitHost {
    return Object.freeze({
      agents: this.options.agents,
      operator: () => (this.halted || this.disposed || this.sim.state.driving >= 0 ? null : { x: this.rig.pose.x, z: this.rig.pose.z }),
      send: (cmd: Extract<SimCommand, { c: 'recruit' | 'dismiss' | 'rally' }>) => {
        if (cmd?.c === 'recruit') this.sim.send({ c: 'recruit', id: cmd.id, skill: cmd.skill, agent: cmd.agent })
        else if (cmd?.c === 'dismiss') this.sim.send(cmd.agent === undefined ? { c: 'dismiss' } : { c: 'dismiss', agent: cmd.agent })
        else if (cmd?.c === 'rally') this.sim.send({ c: 'rally', agent: cmd.agent, x: cmd.x, z: cmd.z })
      },
      onState: (fn: (s: StepState) => void) => {
        this.stateListeners.add(fn)
        return () => { this.stateListeners.delete(fn) }
      },
      cue: (x: number, z: number) => {
        const heard = this.audio.cue(x, z)
        for (let k = 1; k < this.views.length; k++) this.views[k].audio.cue(x, z)
        return heard
      },
    })
  }

  /** The pedestrian speaking aloud now (speechOut), or −1. */
  get speaking(): number {
    return this.speaker >= 0 && this.audio.speaking ? this.speaker : -1
  }

  /**
   * Where the operator tier's speech is heard (operator.ts SpeechOut): the soundscape, at the head of the pedestrian
   * named, following them in every state that lists them. Only audio flows through it: the bytes come from the host's
   * speech client (the engine holds no network code), and the pedestrian is one the gateway bound the text to. Built
   * per call, frozen.
   */
  speechOut(): SpeechOut {
    const clips = new WeakMap<SpeechClip, AudioBuffer>()
    return Object.freeze({
      decode: async (bytes: ArrayBuffer): Promise<SpeechClip> => {
        const buffer = await this.audio.decodeSpeech(bytes)
        const clip: SpeechClip = Object.freeze({ seconds: buffer.duration })
        clips.set(clip, buffer)
        return clip
      },
      play: (clip: SpeechClip, agent: number, text?: string): Utterance => {
        const buffer = clips.get(clip)
        if (!buffer) throw new Error('not speech this soundscape decoded')
        if (this.halted || this.disposed) throw new Error('the city has stopped')
        const at = this.sim.state.recruits.find((r) => r.agent === agent)
        if (!at || !Number.isFinite(at.x + at.z)) throw new Error(`agent ${agent} is not with the operator`)
        // The caption names them by number and skill (pedestrians have no names): 'Pedestrian 1234 (Rust)'.
        const label = at.skill ? `Pedestrian ${agent} (${at.skill})` : `Pedestrian ${agent}`
        const u = this.audio.speak(buffer, at.x, at.z, this.wallsTo(at.x, at.z), text, { agent, label })
        this.speaker = agent
        this.speakerCell = Number.NaN
        if (this.views.length === 1) return u
        // Split: the same clip at the same head for every other player, muffled by the walls from their own head; a
        // soundscape that cannot sound (still locked, failed) is skipped. One utterance: its stop stops them all.
        const others: Utterance[] = []
        for (let k = 1; k < this.views.length; k++) {
          const v = this.views[k]
          try { others.push(v.audio.speak(buffer, at.x, at.z, this.wallsFrom(v.camera, at.x, at.z), text, { agent, label })) } catch { /* that player hears nothing of it */ }
        }
        return Object.freeze({ ended: u.ended, stop: () => { u.stop(); for (const o of others) o.stop() } })
      },
    })
  }

  /**
   * The physics realm halted: its Ring-0 audit found a broken invariant (or the realm faulted). Severs the
   * real-to-sim bridge, freezes this page's frame loop, shows the lock screen and throws SYSTEM LOCKED.
   */
  private panicked(reason: string): void {
    this.lockReason = reason
    this.halt(reason)
    kernelPanic(reason, () => { void Promise.resolve(this.input.hal.dispose()).catch(() => {}) })
  }

  private rumble(level: number): void {
    this.haptics.rumble = level
    this.input.hal.output(this.haptics)
  }

  /** Applies the governor's current tier (minus URL caps) wherever it differs from what is live. */
  private applyTier(): void {
    const q = this.quality
    const k = q.mask(q.governor.knobs())
    // Ghost view lives in the post chain: while it is on, the chain runs at every tier (unless ?post=0 forbids it).
    if (this.ghost.on && this.options.post) k.post = true
    applyQuality(k, q.targets, q.applied)
    q.applied = k
  }

  frame(nowMs: number): void {
    if (this.disposed || this.halted) return
    const cpuStart = performance.now()
    const realDt = this.lastMs < 0 ? 16.7 : nowMs - this.lastMs
    this.lastMs = nowMs
    this.clock.push(realDt)
    // The governor reads the raw frame interval (not the clamped simulation step); it holds while nothing is drawn
    // (setRendering), since an idle GPU would read as room to step the tier up.
    if (this.rendering && this.quality.governor.sample(realDt, nowMs) !== null) this.applyTier()
    const dt = Math.min(realDt / 1000, 0.05)
    this.simTime += dt
    this.hours = (this.hours + (dt / (this.options.dayMinutes * 60)) * 24) % 24
    const input = this.input
    const sim = this.sim
    // The newest audited state: this frame renders it and reads the player's situation from it.
    const st = sim.state
    const driving = st.driving
    // Gamepads and touch first, so their presses are seen by take() this same frame.
    input.poll(dt)

    if (input.take('interact')) this.interact()
    if (input.take('timeForward')) { this.hours = (this.hours + 1) % 24; this.toast('Clock', formatClock(this.hours)) }
    if (input.take('timeBack')) { this.hours = (this.hours + 23) % 24; this.toast('Clock', formatClock(this.hours)) }
    if (input.take('ghost')) this.toast('Ghost view', this.setGhost(!this.ghost.on))
    if (input.take('reset') && driving >= 0) sim.send({ c: 'reset' })

    // Controls for the physics realm (controls.ts readControls, the same maths for every seat); it applies the set that
    // matches its own state (on foot or at the wheel). The other local players' sets ride in the same request
    // (SimClient.setPlayers holds their records; the realm reads avatars[k] from players[k − 1]).
    const foot = this.foot, drive = this.drive
    readControls(input, driving >= 0, foot, drive)
    for (let k = 1; k < this.views.length; k++) {
      const v = this.views[k]
      readControls(input.intent(v.seat), (st.drivings[k] ?? -1) >= 0, v.foot, v.drive)
    }
    let rumble = 0, trigger = 0
    if (driving < 0) {
      // A script's walk (a harness's, say) overrides the keys while it lasts; the worker still caps it at a run.
      applyWalk(this.scriptedWalk, nowMs, foot)
      this.pulseUntil = 0
    } else {
      // What the wheels received (vetted, L2-limited) in the audited state: the trigger feels it, the rumble reports it.
      trigger = st.haptics.trigger
      rumble = nowMs < this.pulseUntil ? HAPTICS.pulse : st.haptics.limited ? HAPTICS.limiter : 0
    }
    this.pendingDt = Math.min(MAX_STEP_DT, this.pendingDt + dt)
    const physicsStart = performance.now()
    if (sim.request({ dt: this.pendingDt, foot, drive })) this.pendingDt = 0
    const postMs = performance.now() - physicsStart
    // Hardware hears only audited states: the worker sends a state after its Ring-0 audit, a panic instead of one.
    this.trigger.set(trigger)
    this.rumble(rumble)

    // First person only: the camera is the avatar's head (eye level on foot, the driver's seat in a car). Posed on
    // every animation frame, drawn or not: recruitment reads it, the audio listener is it, and the car carries it.
    const cam = this.world.camera
    const av = st.avatar
    let focusX = av.x, focusZ = av.z
    if (driving >= 0) {
      const p = st.poses, o = driving * POSE.stride
      const t = this.carPos, r = this.carRot
      t.x = p[o + POSE.x]; t.y = p[o + POSE.y]; t.z = p[o + POSE.z]
      r.x = p[o + POSE.qx]; r.y = p[o + POSE.qy]; r.z = p[o + POSE.qz]; r.w = p[o + POSE.qw]
      focusX = t.x; focusZ = t.z
      const h = p[o + POSE.heading]
      input.yaw = carriedYaw(input.yaw, this.carHeading, h)
      this.carHeading = h
      this.rig.inVehicle(cam, t, r, this.sim.meta.suv[driving], input.yaw, input.pitch)
    } else {
      // The body faces where the head looks (forward (sin h, cos h) = the view's horizontal forward).
      this.avatarHeading = input.yaw + Math.PI
      this.rig.onFoot(cam, av.x, av.feetY, av.z, input.yaw, input.pitch, dt)
    }
    // The other local players' heads, each on its own camera from its own avatar (or the car it drives) and its seat's
    // yaw and pitch; posed every animation frame like player 1's (their listeners read it; the car carries it).
    for (let k = 1; k < this.views.length; k++) this.poseView(this.views[k], k, st, dt)

    // The ping (08_Swarm/ping.ts): the look ray from the head just posed meets the page's own copies, never the realm.
    // A press within a second of the last ping asks the next kind (go, look, gather, wait); the board rates and bounds it.
    if (input.take('ping')) this.pingAt(this.pingKindFor(this.simTime))

    // Ghost-mode collision: what the user's body passes through this frame shapes the contact wipe (drawn frames read it).
    // On the wall clock (the pulse bounds a step itself), not the simulation's capped step: at a low frame rate the
    // wipe must not outlast its passage.
    this.contactPulse.update(this.contactNow(st), realDt / 1000)
    // The code dissolve: every mesh the body is inside this frame goes to code at once; the rest reinstantiate over
    // DISSOLVE.release on the same wall clock. The amounts reach the GPU in present() (view-only: instance data).
    this.dissolveNow(st)
    this.dissolve.update(realDt / 1000)

    // Drawing: every animation frame, or in cinema mode only those the pacer presents (24 a second). Nothing above
    // waits for it: the step request, the haptics and the head pose ran this frame whether or not it is drawn.
    if (this.pacer === null || this.pacer.tick(nowMs)) {
      // The governor holds the camera's 24 presented frames too (governor.ts present()).
      if (this.pacer !== null) this.quality.governor.present(nowMs)
      this.present(nowMs, st, focusX, focusZ)
    }
    this.listen(dt, st)
    this.cpuMs = this.cpuMs * 0.9 + (performance.now() - cpuStart) * 0.1
    this.postMs = this.postMs * 0.9 + postMs * 0.1
  }

  /** One drawn frame: the cull for this camera, the city's light, the cinema camera's uniforms, the render. */
  private present(nowMs: number, st: StepState, focusX: number, focusZ: number): void {
    // Render off (setRendering): nothing is drawn, but the sun keeps its place for the listener and the snapshot.
    if (!this.rendering) {
      this.sun = sunAt(this.hours)
      return
    }
    const cam = this.world.camera
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projScreen)
    packFrustumPlanes(this.frustum.planes, this.planes)

    if (this.fresh) {
      this.view.sync(st.poses)
      this.fresh = false
    }
    // Who is drawn for this camera, over the newest pedestrian frame from the worker.
    this.crowd.step({ camera: { x: cam.position.x, y: cam.position.y, z: cam.position.z }, planes: this.planes })
    // The signal lights run on the worker's clock: the same one its cars and its pedestrians obey.
    this.sun = this.world.update(this.hours, st.simTime, focusX, focusZ)
    // Sun shafts: the camera matrices are final (head rig) and the sun colour is this frame's.
    updateVolumetrics(this.volumetrics, cam, this.sun, this.world.sun.color)
    this.volumetrics.strength.value = this.quality.live.volumetrics ? this.volumetricsScale : 0

    // The contact wipe lives in the post chain like ghost view: while it plays the chain runs (unless ?post=0).
    const wipe = this.contactPulse.value
    const post = this.quality.live.post || (wipe > 0 && this.options.post)
    if (this.cinema) this.expose(this.cinema, nowMs, st.driving, post)
    this.ghost.update(st.poses, (nowMs - this.lastDrawnMs) / 1000, nowMs / 1000)
    this.ghost.contact.value = wipe
    this.ghost.contactKind.value = this.contactPulse.kind
    this.lastDrawnMs = nowMs
    // The code dissolve's amounts, to the meshes that read them, before the frame that reads them.
    this.flushDissolve()
    const split = this.views.length > 1
    if (split) {
      // One clear of the whole canvas (colour, depth, stencil: a clear pass ignores the scissor), then each viewport is
      // drawn into its own rect with autoClear off (layout); player 1's first.
      this.gpu.renderer.clear(true, true, true)
      this.frameView(this.views[0])
    }
    if (post) this.post.render()
    else this.gpu.renderer.render(this.world.scene, cam)
    // The other players' viewports: each culled for its own camera, under the sky re-centred on that head, drawn on the
    // direct path. The sun's shadow focus, the lamp lights and the building sort stay player 1's (world.update above).
    if (split) for (let k = 1; k < this.views.length; k++) this.presentView(this.views[k])
    if (this.options.profile && !this.resolving) {
      this.resolving = true
      this.gpu.renderer.resolveTimestampsAsync('render').then((ms) => {
        if (typeof ms === 'number' && ms > 0) this.gpuRenderMs = this.gpuRenderMs * 0.9 + ms * 0.1
        this.resolving = false
      }, () => { this.resolving = false })
    }
  }

  /** One split-screen viewport after player 1's: the crowd cull for its camera, the sky on its head, its scissored draw. */
  private presentView(v: PlayerView): void {
    const cam = v.camera
    v.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    v.frustum.setFromProjectionMatrix(v.projScreen)
    packFrustumPlanes(v.frustum.planes, v.planes)
    v.eye.x = cam.position.x; v.eye.y = cam.position.y; v.eye.z = cam.position.z
    this.crowd.step({ camera: v.eye, planes: v.planes })
    this.world.follow(cam)
    this.frameView(v)
    this.gpu.renderer.render(this.world.scene, cam)
  }

  /**
   * Player k's head (k ≥ 1) on its view's camera: the driver's seat of the car they drive (the head carried by the car,
   * their seat's yaw turning with it), else eye level over their avatar's feet. The same HeadRig calls as player 1's.
   */
  private poseView(v: PlayerView, k: number, st: StepState, dt: number): void {
    const seat = this.input.intent(v.seat)
    const d = st.drivings[k] ?? -1
    if (d >= 0) {
      const p = st.poses, o = d * POSE.stride
      const t = this.carPos, r = this.carRot
      t.x = p[o + POSE.x]; t.y = p[o + POSE.y]; t.z = p[o + POSE.z]
      r.x = p[o + POSE.qx]; r.y = p[o + POSE.qy]; r.z = p[o + POSE.qz]; r.w = p[o + POSE.qw]
      const h = p[o + POSE.heading]
      seat.yaw = carriedYaw(seat.yaw, v.carHeading, h)
      v.carHeading = h
      v.rig.inVehicle(v.camera, t, r, this.sim.meta.suv[d], seat.yaw, seat.pitch)
    } else {
      const av = st.avatars[k] ?? st.avatar
      v.rig.onFoot(v.camera, av.x, av.feetY, av.z, seat.yaw, seat.pitch, dt)
    }
  }

  /** "Region · Street & Cross Street" (the region's name alone where no street is near). */
  private regionPlace(x: number, z: number): string {
    const here = this.places?.place(x, z) ?? ''
    return here && here !== this.regionName ? `${this.regionName} · ${here}` : (this.regionName ?? '')
  }

  /**
   * The nearest pedestrian to the user's body in a crowd frame: to the avatar's capsule on foot, to the driven car's
   * chassis at the wheel. Read before the frame goes to the render buffers (and back to the worker).
   */
  private contactScan(s: StepState): void {
    const frame = s.crowdFrame, n = this.options.agents
    this.personGapFoot = personGap(frame, n, s.avatar.x, s.avatar.z, PERSON.radius)
    const d = s.driving
    if (d >= 0) {
      const o = d * POSE.stride, c = chassisBox(this.sim.meta.suv[d])
      this.personGapCar = personGapToBox(frame, n, s.poses[o + POSE.x], s.poses[o + POSE.z], s.poses[o + POSE.heading], c.hx, c.hz)
      // The code dissolve: the people the chassis (grown by the reach) stands in, by row.
      this.peopleCount = peopleWithinBox(frame, n, s.poses[o + POSE.x], s.poses[o + POSE.z], s.poses[o + POSE.heading], c.hx + DISSOLVE.reach, c.hz + DISSOLVE.reach, this.peopleOut)
    } else {
      this.personGapCar = CONTACT.far
      this.peopleCount = peopleWithin(frame, n, s.avatar.x, s.avatar.z, PERSON.radius + DISSOLVE.reach, this.peopleOut)
    }
  }

  /** What the user's body is passing through now (contact.ts touching): poles and people, and cars on foot. */
  private contactNow(st: StepState): ReturnType<typeof touching> {
    const d = st.driving
    if (d >= 0) {
      const o = d * POSE.stride, c = chassisBox(this.sim.meta.suv[d])
      const pole = this.poles.gapToBox(st.poses[o + POSE.x], st.poses[o + POSE.z], st.poses[o + POSE.heading], c.hx, c.hz)
      return touching({ pole, person: this.personGapCar, vehicle: CONTACT.far })
    }
    const x = st.avatar.x, z = st.avatar.z
    return touching({
      pole: this.poles.gap(x, z, PERSON.radius),
      person: this.personGapFoot,
      vehicle: carGap(st.poses, this.sim.meta.suv, x, z, PERSON.radius),
    })
  }

  /**
   * What the user's body is inside this frame, by instance, each put at 1 (dissolve.ts): the poles (lamps, trees,
   * signals) around the avatar's disc or under the driven car's footprint, the cars the avatar on foot stands in (the
   * driven car never dissolves: its shell is drawn from inside by design, as contactNow exempts it), the people
   * gathered with the newest crowd frame, and every car passing through another car (7.1), so neither is seen
   * interpenetrating. Reads poses, the furniture and the frame's rows; nothing crosses to the worker.
   */
  private dissolveNow(st: StepState): void {
    const set = this.dissolve, suv = this.sim.meta.suv, d = st.driving
    let poles = 0
    if (d >= 0) {
      const o = d * POSE.stride, c = chassisBox(suv[d])
      poles = this.poles.withinBox(st.poses[o + POSE.x], st.poses[o + POSE.z], st.poses[o + POSE.heading], c.hx + DISSOLVE.reach, c.hz + DISSOLVE.reach, this.poleOut)
    } else {
      const x = st.avatar.x, z = st.avatar.z, pad = PERSON.radius + DISSOLVE.reach
      poles = this.poles.within(x, z, pad, this.poleOut)
      const cars = carsWithin(st.poses, suv, x, z, pad, this.carOut)
      for (let i = 0; i < cars; i++) set.touch('cars', this.carOut[i])
    }
    for (let i = 0; i < poles; i++) {
      const slot = poleSlot(this.poleOut[i], this.world.furniture)
      if (slot) set.touch(slot.list, slot.index)
    }
    for (let i = 0; i < this.peopleCount; i++) set.touch('people', this.peopleOut[i])
    const overlapping = carsOverlapping(st.poses, suv, DISSOLVE.reach, this.overlapOut, d)
    for (let i = 0; i < overlapping; i++) set.touch('cars', this.overlapOut[i])
  }

  /**
   * The amounts changed since the last drawn frame, to the GPU: the props' and the fleet's instanced attributes are
   * marked for three's upload (whole buffers of a few kilobytes, only when one changed; the wheels take their car's
   * value four times), the crowd's storage buffer is written directly, as the frame upload is (CrowdCull.upload).
   */
  private flushDissolve(): void {
    const set = this.dissolve, props = this.world.dissolve, fleet = this.view.dissolve
    flushProp(set.lamps, props.lamps)
    flushProp(set.trees, props.trees)
    flushProp(set.signals, props.signals)
    if (set.cars.dirty) {
      copyDirty(set.cars, fleet.bodies.array as Float32Array)
      copyDirty(set.cars, fleet.wheels.array as Float32Array, 4)
      fleet.bodies.needsUpdate = true
      fleet.wheels.needsUpdate = true
      set.cars.clean()
    }
    const people = set.people
    if (people.dirty) {
      this.gpu.device.queue.writeBuffer(this.crowdDissolve, people.dirtyStart * 4, people.values, people.dirtyStart, people.dirtyEnd - people.dirtyStart)
      people.clean()
    }
  }

  /**
   * The cinema camera's uniforms for the frame about to be drawn. The velocity buffer spans the interval since the
   * last presented frame, so the shutter takes SHUTTER_SECONDS of it (shutterScale) and the pedestrians' motion
   * vectors cover exactly it; across a cut (a seat change, a teleport, a stall, a resize, or a last frame drawn
   * without the post chain, whose velocity history is stale) the blur is 0. The ND follows the light.
   */
  private expose(c: CinemaPost, nowMs: number, seat: number, post: boolean): void {
    const cam = this.world.camera
    const interval = nowMs - this.lastPresentMs
    const mark = this.mark
    mark.x = cam.position.x; mark.y = cam.position.y; mark.z = cam.position.z; mark.seat = seat
    const scale = exposureFor(this.marked ? this.lastMark : null, mark, interval, post)
    const cut = scale === 0
    c.shutter.exposure.value = scale
    this.crowdFrameSeconds.value = cut ? 0 : interval / 1000
    c.previousViewProjection.value.copy(this.lastViewProjection)
    c.nd.value = ndStopsFor(this.sun.daylight)
    c.exposure.value = this.world.tuning.exposure
    this.lastViewProjection.copy(this.projScreen)
    this.lastPresentMs = nowMs
    Object.assign(this.lastMark, mark)
    this.marked = post
    if (cut) this.cuts++
  }

  /**
   * One soundscape's frame from a head's final camera pose, the fleet, the crowd and the signals: the listener is that
   * head (HeadRig sets rotation (pitch, yaw, 0, 'YXZ')), `driving` the car that player drives (−1 on foot), whose cabin
   * muffles the city for them. The listener's and the speaker's rooms are the caller's (listen).
   */
  private soundFrame(f: AudioFrame, cam: PerspectiveCamera, st: StepState, dt: number, driving: number): void {
    f.dt = dt
    f.listener.x = cam.position.x; f.listener.y = cam.position.y; f.listener.z = cam.position.z
    f.listener.yaw = cam.rotation.y; f.listener.pitch = cam.rotation.x
    const p = st.poses
    for (let i = 0; i < f.cars.length; i++) {
      const c = f.cars[i], o = i * POSE.stride
      c.x = p[o + POSE.x]; c.z = p[o + POSE.z]; c.heading = p[o + POSE.heading]; c.speed = p[o + POSE.speed]; c.player = i === driving
    }
    f.crowd.near = this.crowd.stats.drawnNear; f.crowd.waiting = st.crowd.stats.waiting; f.crowd.crossing = st.crowd.stats.crossing
    f.daylight = this.sun.daylight
    f.walk.ew = walkAllowed('ew', st.simTime); f.walk.ns = walkAllowed('ns', st.simTime)
    // The walk-signal tones sound at the procedural grid's intersections; a region has no signals yet (NaN: silent).
    f.intersection.x = this.places ? Number.NaN : Math.max(0, Math.min(CITY.blocks, Math.round(cam.position.x / CITY.pitch))) * CITY.pitch
    f.intersection.z = this.places ? Number.NaN : Math.max(0, Math.min(CITY.blocks, Math.round(cam.position.z / CITY.pitch))) * CITY.pitch
    // In first person the listener sits in the cabin while driving: the city outside is muffled.
    f.interior = driving >= 0
  }

  /** Feeds the soundscape from the final camera pose, the fleet, the crowd and the signals (then every other player's from theirs). */
  private listen(dt: number, st: StepState): void {
    const f = this.sound
    const cam = this.world.camera
    // HeadRig sets rotation (pitch, yaw, 0, 'YXZ'): the listener is the head, on foot or in the driver's seat.
    this.soundFrame(f, cam, st, dt, st.driving)
    // The room the listener stands in (acoustics.ts), found again when the head crosses into another 2 m cell. A region
    // has no page-side geometry (its walls live in the worker): no room there, every voice dry.
    const cell = this.places ? Number.NaN : cellOf(cam.position.x, cam.position.z)
    if (cell !== this.listenerCell) {
      this.listenerCell = cell
      f.room = Number.isNaN(cell) ? undefined : roomAt(this.world.boxes, cam.position.x, cam.position.z)
    }
    // The person speaking, where the newest state has them (NaN: nobody, or not measured; the voice then holds).
    const speaking = this.speaker >= 0 && this.audio.speaking ? st.recruits.find((r) => r.agent === this.speaker) : undefined
    const sp = f.speaker!
    sp.x = speaking ? speaking.x : Number.NaN
    sp.z = speaking ? speaking.z : Number.NaN
    sp.walls = speaking && Number.isFinite(speaking.x + speaking.z) ? this.wallsTo(speaking.x, speaking.z) : 0
    const speakerCell = speaking && !this.places ? cellOf(speaking.x, speaking.z) : Number.NaN
    if (speakerCell !== this.speakerCell) {
      this.speakerCell = speakerCell
      sp.room = Number.isNaN(speakerCell) ? undefined : roomAt(this.world.boxes, speaking!.x, speaking!.z)
    }
    this.audio.update(f)
    // Captions outlive nothing: when the soundscape is not sounding (off, hidden, failed), what it said is gone.
    if (this.captions.size > 0 && this.audio.status().state !== 'running') this.captions.clear()
    // Split: every other player's soundscape from their own head (their room, their cabin, the speaker's walls from
    // them); the speaker's room is the same room whoever listens.
    for (let k = 1; k < this.views.length; k++) this.listenFor(this.views[k], k, st, dt, speaking, sp.room)
  }

  /** One more player's frame (listenFor): their head's room, the walls from their head to the speaker, then their soundscape. */
  private listenFor(v: PlayerView, k: number, st: StepState, dt: number, speaking: { x: number; z: number } | undefined, speakerRoom: AudioFrame['room']): void {
    const f = v.sound, cam = v.camera
    this.soundFrame(f, cam, st, dt, st.drivings[k] ?? -1)
    const cell = this.places ? Number.NaN : cellOf(cam.position.x, cam.position.z)
    if (cell !== v.listenerCell) {
      v.listenerCell = cell
      f.room = Number.isNaN(cell) ? undefined : roomAt(this.world.boxes, cam.position.x, cam.position.z)
    }
    const sp = f.speaker!
    sp.x = speaking ? speaking.x : Number.NaN
    sp.z = speaking ? speaking.z : Number.NaN
    sp.walls = speaking && Number.isFinite(speaking.x + speaking.z) ? this.wallsFrom(cam, speaking.x, speaking.z) : 0
    sp.room = speakerRoom
    v.audio.update(f)
  }

  /** Walls of the physics realm's own geometry between the listener's head and a speaker's at (x, z) (audio.ts OCCLUSION). */
  private wallsTo(x: number, z: number): number {
    return this.wallsFrom(this.world.camera, x, z)
  }

  /** The same walls from another player's head. */
  private wallsFrom(cam: PerspectiveCamera, x: number, z: number): number {
    const at = cam.position
    return wallsBetween(this.world.boxes, { x: at.x, y: at.y, z: at.z }, { x, y: SPEECH.height, z })
  }

  /** Closed captions on or off (view-only; the soundscape keeps sounding). Returns the status line the console prints. */
  setCaptions(on: boolean): string {
    this.captionsOn = on
    if (!on) this.captions.clear()
    return on ? 'captions: on' : 'captions: off'
  }

  /** The caption lines to show now, in the house style (captions.ts captionText), bearings taken from the head. */
  private captionLines(): string[] {
    const out: string[] = []
    for (const line of this.captions.lines(this.audio.clock, this.rig.pose)) out.push(captionText(line))
    return out
  }

  /** Index of the car nearest (x, z) within `range` in the newest state, or −1. */
  private nearestCar(x: number, z: number, range: number): number {
    const p = this.sim.state.poses
    let best = -1, bestD = range
    for (let i = 0; i < this.sim.meta.count; i++) {
      const o = i * POSE.stride
      const d = Math.hypot(p[o + POSE.x] - x, p[o + POSE.z] - z)
      if (d < bestD) { bestD = d; best = i }
    }
    return best
  }

  /** The crowd's figures: what the page drew, and what the worker's crowd did. */
  private crowdStats(): CrowdStats {
    const w = this.sim.state.crowd.stats
    return { drawnNear: this.crowd.stats.drawnNear, drawnFar: this.crowd.stats.drawnFar, nudges: w.nudges, waiting: w.waiting, crossing: w.crossing, retreating: w.retreating }
  }

  private kernelStats(): KernelStats {
    const k = this.sim.state.kernel
    return { ...k, audit: { ...k.audit, panic: k.audit.panic ?? this.lockReason } }
  }

  snapshot(): SipocSnapshot {
    const [mean, p50, p95] = this.clock.stats()
    const s = this.crowdStats()
    const st = this.sim.state
    const p = st.poses, o = st.driving * POSE.stride
    const driving = st.driving >= 0
    const x = driving ? p[o + POSE.x] : st.avatar.x
    const z = driving ? p[o + POSE.z] : st.avatar.z
    const heading = driving ? p[o + POSE.heading] : this.avatarHeading
    const speed = driving ? p[o + POSE.speed] : 0
    const phase = ((st.simTime % SIGNAL.cycle) + SIGNAL.cycle) % SIGNAL.cycle
    const next = [SIGNAL.ewGreen, SIGNAL.ewAmber, SIGNAL.nsGreen, SIGNAL.cycle].find((b) => b > phase) ?? SIGNAL.cycle
    const kernel = this.kernelStats()
    const pings = this.pingMarks()
    const fps = mean > 0 ? 1000 / mean : 0
    const clock = formatClock(this.hours)
    const speedKmh = Math.abs(speed) * 3.6
    const gear = speed < -0.3 ? 'R' : Math.abs(speed) < 0.3 ? 'N' : 'D'
    // HAL/1 peripherals get a telemetry line; the bus drops it when none is ready and caps it at 10 Hz.
    this.input.hal.telemetry({ clock, speedKmh: Math.round(speedKmh), gear, mode: driving ? 'vehicle' : 'foot', law1: kernel.law1, sensorFlips: kernel.sensorFlips, fps: Math.round(fps) })
    const map = []
    for (let i = 0; i < this.sim.meta.count; i++) {
      const q = i * POSE.stride
      map.push({ x: p[q + POSE.x], z: p[q + POSE.z], heading: p[q + POSE.heading], player: i === st.driving })
    }
    return {
      supplier: {
        device: this.input.device, pointerLocked: this.input.locked, engaged: this.input.engaged, touch: this.input.touch,
        triggerResistance: this.trigger.level, hal: this.input.hal.summary(),
        glyphs: this.glyphs,
        recording: this.recorder.state,
      },
      input: { mode: driving ? 'vehicle' : 'foot', nearVehicle: !driving && this.nearestCar(st.avatar.x, st.avatar.z, ENTER_RANGE) >= 0 },
      process: {
        // A region has no pedestrians of its own yet (the procedural crowd it keeps is hidden, kilometres away).
        pedestrians: this.places ? 0 : this.options.agents - 1, vehicles: this.options.cars, drawnNear: s.drawnNear, drawnFar: s.drawnFar,
        waiting: this.places ? 0 : s.waiting, crossing: this.places ? 0 : s.crossing, yielding: s.retreating, safetyNudges: s.nudges, gpu: this.gpu.adapterInfo,
        sensingAgeMs: st.crowd.ageMs, sensingLagMs: st.crowd.lagMs, crowdFrames: this.crowdFrames, seed: this.options.seed, host: this.options.host,
      },
      output: {
        fps, frameMs: mean, p50Ms: p50, p95Ms: p95, cpuMs: this.cpuMs,
        gpuRenderMs: this.gpuRenderMs, gpuComputeMs: this.crowd.gpuMs, physicsMs: st.physics.workerMs, rapierMs: st.physics.stepMs,
        postMs: this.postMs,
        ghost: this.ghost.on,
        rendering: this.rendering,
        contact: { wipe: this.contactPulse.value, kind: this.contactPulse.kind, count: this.contactPulse.count },
        dissolve: { active: this.dissolve.active, count: this.dissolve.count },
        ...(pings && { pings }),
        ...(this.views.length > 1 && { players: this.playersView(st) }),
        ...(this.pacer && {
          camera: {
            fps: this.pacer.fps(this.lastMs), shutterS: this.quality.live.post ? SHUTTER_SECONDS : 0,
            ndStops: ndStopsFor(this.sun.daylight), cuts: this.cuts,
          },
        }),
      },
      kernel,
      quality: this.quality.governor.state(),
      customer: {
        name: this.playerName,
        clock, daylight: this.sun.daylight, viewYaw: this.input.yaw,
        district: this.places ? this.regionPlace(x, z) : `${districtName(x, z)} · ${ordinal(Math.round(x / CITY.pitch) + 1)} Ave & ${ordinal(Math.round(z / CITY.pitch) + 1)} St`,
        speedKmh, gear,
        x, z, heading, signalEW: signalFor('ew', st.simTime), signalNS: signalFor('ns', st.simTime), signalRemaining: next - phase,
        region: this.regionName,
        ...(this.captionsOn && { captions: this.captionLines() }),
      },
      experience: { sessionSeconds: this.simTime, longFrames: this.clock.longFrames, distanceWalked: this.walked, distanceDriven: this.driven },
      map,
      toasts: this.toasts.filter((t) => this.simTime - t.time < 6),
    }
  }

  /**
   * The Ring-0 terminal's only way in (the air gap): read-only statistics, the laws, and a short list of
   * operator controls (clock, quality, audio, peripheral pairing). Nothing here can move, spawn or alter
   * an agent, a vehicle or the physics world. Built once, frozen, stable identity. (App.tsx adds `recruit`
   * from the recruiter over recruitHost(): it only asks, and the physics worker decides.) Every operator
   * script and every prompt goes through `gate`, the capability gateway App builds over the recruiter
   * (08_Swarm/taskRouter.ts), and prompts are answered by `mind`, the local model client App builds
   * (09_Cognition/localCompute.ts): the engine never learns who is tethered, and holds no network code.
   * Speech comes the same way: `voice` is the host's local speech client (09_Cognition/localSpeech.ts), and what
   * it returns is played through speechOut(); `diary` is the swarm's memory (08_Swarm/memory.ts), which the engine
   * never reads. The gate, mind, voice and diary given on the first call are the ones kept.
   */
  terminalBridge(gate: SkillGate, mind: Mind, voice?: Voice, diary?: Diary): TerminalBridge {
    if (this.bridge) return this.bridge
    const hal = this.input.hal
    const audio = this.audio
    const governor = this.quality.governor
    this.bridge = Object.freeze({
      brand: Object.freeze({ name: BRAND.name, version: BRAND.version, host: BRAND.host, track: 'gui' as const }),
      stats: () => ring0Stats(this.snapshot(), this.sim.state.physics),
      laws: () => THREE_LAWS,
      clock: () => formatClock(this.hours),
      setClock: (h: number) => this.debugSetHour(h),
      quality: (arg?: 'auto' | number) => {
        if (arg === 'auto') governor.setAuto(true)
        else if (typeof arg === 'number') governor.setTier(arg)
        if (arg !== undefined) this.applyTier()
        return governor.state()
      },
      audio: (arg?: 'on' | 'off' | number) => {
        // Every player's soundscape together (they share one context in split screen); the line reads player 1's.
        for (const v of this.views) {
          if (arg === 'on') { v.audio.unlock(); v.audio.setEnabled(true) }
          else if (arg === 'off') v.audio.setEnabled(false)
          else if (typeof arg === 'number') v.audio.setVolume(arg / 100)
        }
        const st = audio.status()
        const split = this.views.length > 1 ? ` · ${this.views.length} players` : ''
        return `audio: ${st.state} · ${st.voices} voices · ${st.hrtf ? 'HRTF' : 'stereo'} · volume ${Math.round(st.volume * 100)}%${split}`
      },
      // pair() must stay synchronous up to requestDevice/requestPort: the Enter keydown is the user gesture.
      hal: Object.freeze({ summary: () => hal.summary(), devices: () => hal.devices(), pair: (k: 'hid' | 'serial' | 'bluetooth') => hal.pair(k) }),
      adapter: () => this.adapter,
      ghost: (arg?: 'on' | 'off') => (arg === undefined ? (this.ghost.on ? 'on' : 'off') : this.setGhost(arg === 'on')),
      render: (arg?: 'on' | 'off') => (arg === undefined ? (this.rendering ? 'on' : 'off') : this.setRendering(arg === 'on')),
      // The operator tier: unlockable, sandboxed, built over simControls() (never over the engine itself), its
      // scripts bound to the swarm through the gate.
      operator: operatorBridge(this.simControls(), gate, mind, undefined, { voice, speech: this.speechOut(), diary }),
      record: Object.freeze({
        start: (source: RecorderSource) => this.startRecording(source),
        stop: () => this.stopRecording(),
        status: () => this.recorder.state,
        supported: () => Recorder.supported(),
      }),
    })
    return this.bridge
  }

  /** Control glyphs for the input in use; a phone shows touch glyphs even before its first touch. */
  private get glyphs(): GlyphFamily {
    const d = this.input.device
    return familyOf(d === 'gamepad' ? 'gamepad' : this.input.touch ? 'touch' : d, this.input.padFamily)
  }

  /** The Concierge hands over the name the user chose; it labels their avatar in the HUD. */
  setPlayerName(name: string): void {
    this.playerName = name
  }

  /** One telemetry record for the frame being encoded: real state only, never an invented observation. */
  private frameTelemetry(): AgentTelemetry {
    const s = this.snapshot()
    const k = s.kernel, seen = this.recSeen
    const events = {
      law1: k.law1 > seen.law1 ? k.law1 - seen.law1 : undefined,
      flips: k.sensorFlips > seen.flips ? k.sensorFlips - seen.flips : undefined,
      tier: s.quality.label !== seen.tier ? s.quality.label : undefined,
      panic: k.audit.panic !== seen.panic ? k.audit.panic : undefined,
    }
    seen.law1 = k.law1; seen.flips = k.sensorFlips; seen.tier = s.quality.label; seen.panic = k.audit.panic
    const cam = this.world.camera
    return {
      intent: `${s.input.mode === 'vehicle' ? 'Driving' : 'Walking'} · ${s.customer.district}`,
      markdown_log: markdownFor(events),
      confidence: 1,
      spatial_coordinates: [cam.position.x, cam.position.y, cam.position.z],
      state: {
        clock: s.customer.clock, tier: s.quality.label, mode: s.input.mode, heading: s.customer.heading, speedKmh: s.customer.speedKmh,
        kernel: { law1: k.law1, law2: k.law2, law3: k.law3, sensorFlips: k.sensorFlips, shielded: k.shielded, last: k.last },
        audit: { ...k.audit }, fps: Math.round(s.output.fps), drawn: s.process.drawnNear + s.process.drawnFar,
      },
    }
  }

  /**
   * Starts a local-only recording. Called synchronously from the console's Enter keydown so the file picker (and
   * the camera prompt) keep the user activation. Never sends anything anywhere: the sink is a file the user picks,
   * or a download at stop where the picker is unavailable. Resolves with the codec (the console phrases the line).
   */
  private async startRecording(source: RecorderSource): Promise<string> {
    if (this.recorder.state.active) throw new Error('already recording')
    const brand = BRAND.name.toLowerCase()
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const name = `${brand}-${stamp}.agv`
    const picker = (globalThis as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker
    // Both prompts are requested before the first await, inside the gesture.
    const filePromise = picker
      ? picker({ suggestedName: name, types: [{ description: 'Agent video', accept: { 'application/octet-stream': ['.agv'] } }] })
      : null
    const camPromise = source === 'camera' ? navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720, frameRate: 30 } }) : null
    // A canvas recording under the cinema camera is 24p: the canvas only changes on presented frames.
    const fps = source === 'canvas' && this.pacer ? CINEMA.fps : 30
    // Whichever prompt is refused, the other's grant is released: no camera left on, no empty file left behind.
    const camOff = () => camPromise?.then((m) => m.getTracks().forEach((t) => t.stop()), () => {})
    let sink: RecorderSink
    if (filePromise) {
      let handle: FileSystemFileHandle
      try {
        handle = await filePromise
      } catch (e) {
        void camOff()
        throw e
      }
      // Seekable (the header is finalized at stop) and abortable (a failed start discards the empty file).
      sink = fileSink(await handle.createWritable())
      this.recordingWhere = `saved to ${handle.name || name}`
    } else {
      // MemorySink is seekable too, so the download gets the same finalized header as a picked file.
      sink = new MemorySink((blob) => {
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url; a.download = name; a.click()
        setTimeout(() => URL.revokeObjectURL(url), 10000)
      })
      this.recordingWhere = `downloaded ${name}`
    }
    let track: MediaStreamTrack
    try {
      if (camPromise) {
        track = (await camPromise).getVideoTracks()[0]
        this.cameraTrack = track
      } else {
        track = this.canvas.captureStream(fps).getVideoTracks()[0]
      }
    } catch (e) {
      void camOff()
      await (sink.abort ?? sink.close)()
      throw e
    }
    return this.recorder.start(track, source, sink, { width: 1280, height: 720, framerate: fps, bitrate: 2_000_000, keyframeInterval: 2 * fps })
  }

  private async stopRecording(): Promise<string> {
    if (!this.recorder.state.active) throw new Error('not recording')
    await this.recorder.stop()
    this.cameraTrack?.stop()
    this.cameraTrack = null
    // Resolves with where the file went: the console prints the figures itself from the RecordingState.
    return this.recordingWhere
  }

  /**
   * The Ring-0 operator tier's view of the simulation (operator.ts wraps it in a frozen facade for scripts).
   * Reads come from the newest state the physics realm sent (one step old); writes are commands queued for its
   * next step, validated here for a script's error message and again in the worker, which alone can act on
   * them: vehicle intents are vetted by the Bouncer, tuning is clamped to ranges that can only strengthen
   * stopping, and nothing reaches the laws, the Sanctuary or the crowd's safety nudge.
   */
  simControls(): SimControls {
    if (this.controls) return this.controls
    const sim = this.sim
    const car = (i: number): number => {
      if (!(Number.isInteger(i) && i >= 0 && i < sim.meta.count)) throw new Error(`no vehicle ${i} (0–${sim.meta.count - 1})`)
      return i
    }
    const notDriven = (i: number): number => {
      if (i === sim.state.driving) throw new Error('that car is being driven')
      return i
    }
    const carKeys = Object.keys(CAR_TUNE_RANGE) as (keyof CarTuning)[]
    const lightKeys = Object.keys(LIGHT_TUNE_RANGE) as (keyof LightTuning)[]
    const clampLight = (key: keyof LightTuning, value: number) => {
      const [lo, hi] = LIGHT_TUNE_RANGE[key]
      return Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : 1
    }
    this.controls = {
      clock: { hours: () => this.hours, set: (h) => this.debugSetHour(h) },
      quality: {
        state: () => this.quality.governor.state(),
        set: (tier) => { if (tier === 'auto') this.quality.governor.setAuto(true); else this.quality.governor.setTier(tier); this.applyTier() },
      },
      avatar: {
        position: () => ({ x: sim.state.avatar.x, z: sim.state.avatar.z, heading: this.avatarHeading, feetY: sim.state.avatar.feetY }),
        teleport: (x, z, yaw) => this.debugTeleport(x, z, yaw ?? this.input.yaw),
        interact: () => this.interact(),
        walk: (vx, vz, ms) => { requestWalk(this.scriptedWalk, performance.now(), vx, vz, ms) },
      },
      vehicles: {
        count: () => sim.meta.count,
        state: (i) => {
          const p = sim.state.poses, o = car(i) * POSE.stride
          return { x: p[o + POSE.x], z: p[o + POSE.z], heading: p[o + POSE.heading], speed: p[o + POSE.speed], mode: MODES[p[o + POSE.mode]] ?? 'ai', suv: sim.meta.suv[i] }
        },
        setMode: (i, mode) => { sim.send({ c: 'setMode', i: notDriven(car(i)), mode }) },
        recover: (i, x, z, heading) => { sim.send({ c: 'recover', i: car(i), x, z, heading }) },
        // A scripted intent is a player-style command: same Bouncer, same envelope, same latch (in the worker).
        intent: (i, throttle, brake, steer) => { sim.send({ c: 'intent', i: notDriven(car(i)), throttle, brake, steer }) },
        nearest: (x, z) => this.nearestCar(x, z, Infinity),
      },
      physics: {
        tune: () => Object.fromEntries(carKeys.map((k) => [`car.${k}`, this.tuning[k]])),
        set: (key, value) => {
          const k = key.replace(/^car\./, '') as keyof CarTuning
          if (!key.startsWith('car.') || !carKeys.includes(k)) throw new Error(`unknown physics key '${key}' (car.${carKeys.join(', car.')})`)
          this.tuning[k] = clampTuning(k, value)
          sim.send({ c: 'tune', key: k, value })
        },
      },
      shaders: {
        uniforms: () => ({
          ...Object.fromEntries(lightKeys.map((k) => [`light.${k}`, this.world.tuning[k]])),
          'volumetrics.strength': this.volumetricsScale,
        }),
        set: (key, value) => {
          if (key === 'volumetrics.strength') { this.volumetricsScale = Number.isFinite(value) ? Math.min(2, Math.max(0, value)) : 1; return }
          const k = key.replace(/^light\./, '') as keyof LightTuning
          if (!key.startsWith('light.') || !lightKeys.includes(k)) throw new Error(`unknown shader key '${key}' (light.${lightKeys.join(', light.')}, volumetrics.strength)`)
          this.world.tuning[k] = clampLight(k, value)
        },
      },
      crowd: {
        stats: () => this.crowdStats(),
        positions: () => this.crowdXZ.slice(),
        cull: (c) => {
          const cur = this.quality.live.cull
          this.quality.targets.setCrowd({ lodDistance: c.lodDistance ?? cur.lodDistance, nearRadius: c.nearRadius ?? cur.nearRadius, density: c.density ?? cur.density, maxDistance: c.maxDistance ?? cur.maxDistance })
        },
      },
      kernel: {
        stats: () => this.kernelStats(),
        // Harness-only (never on the script facade), and only on a ?debug page: a production physics worker refuses to
        // weaken the kernel for anyone. Bounded to 20 s in the worker, so a crashed harness cannot leave it on.
        blindSensing: (on, ttlMs = 5000) => {
          if (on && !sim.meta.debug) throw new Error('blinding person sensing is refused by a production physics worker (reload with ?debug to run this harness)')
          sim.send({ c: 'blind', on, ttlMs })
        },
      },
      snapshot: () => this.snapshot(),
    }
    return this.controls
  }

  /** ?debug harness hooks. */
  debugSetHour(h: number): void {
    if (!Number.isFinite(h)) return
    this.hours = ((h % 24) + 24) % 24
  }

  debugTeleport(x: number, z: number, yaw: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z) || !Number.isFinite(yaw)) return
    this.sim.send({ c: 'teleport', x, z })
    this.input.yaw = yaw
  }

  /** The ?debug harness's handle on the physics realm (App exposes it only with ?debug; the worker refuses dbg* otherwise). */
  debugSim(): DebugSim {
    return Object.freeze({
      state: () => this.sim.state,
      send: (cmd: SimCommand) => this.sim.send(cmd),
      next: () => new Promise<StepState>((resolve) => { this.waiters.push(resolve) }),
    })
  }

  /**
   * Ring-0 kernel panic: the physics realm's audit found a broken invariant. Severs the real-to-sim bridge (the
   * hardware bus sends its trigger-off report and closes every port), stops the soundscape, freezes the frame
   * loop and tells the host to show the lock screen. The caller then throws SYSTEM LOCKED. Idempotent.
   */
  halt(reason: string): void {
    if (this.halted) return
    this.halted = true
    if (this.lockReason === null) this.lockReason = reason
    try { this.audio.dispose() } catch { /* the halt must complete whatever the audio stack does */ }
    for (let k = 1; k < this.views.length; k++) try { this.views[k].audio.dispose() } catch { /* likewise */ }
    void Promise.resolve(this.input.hal.dispose()).catch(() => {})
    try { this.onHalt?.(reason) } catch { /* likewise */ }
  }

  dispose(): void {
    this.disposed = true
    if (this.recorder.state.active) void this.recorder.stop().catch(() => {})
    this.cameraTrack?.stop()
    this.audio.dispose()
    for (let k = 1; k < this.views.length; k++) this.views[k].audio.dispose()
    // Input.dispose() also disposes the hardware bus, which resets trigger effects and closes ports.
    this.input.dispose()
    this.sim.terminate()
    this.gpu.renderer.dispose()
  }
}
