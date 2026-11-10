// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It observes the running city and packages each HUD tick as a SIPOC X
 * snapshot (Supplier, Input, Process, Output, Customer, eXperience), shaped so a later phase can
 * serialize it as a Sparkplug B metric set without renaming anything.
 * What breaks if it is removed? The HUD loses its readouts and frame-time budgets go unmeasured.
 */
import type { MicPhase } from '../04_Connect_Hardware/microphone.ts'
import type { XrState } from '../04_Connect_Hardware/xrSystem.ts'
import type { HardwareClass } from './governor.ts'

/** Frames the HUD's clock remembers (over 4 s at 60 fps): a power of two, so the ring is walked by a mask, never a modulo. */
export const FRAME_RING = 256
const FRAME_MASK = FRAME_RING - 1

export class FrameClock {
  private readonly samples = new Float32Array(FRAME_RING)
  private readonly scratch = new Float32Array(FRAME_RING)
  private n = 0
  longFrames = 0

  push(ms: number): void {
    this.samples[this.n++ & FRAME_MASK] = ms
    if (ms > 33.4) this.longFrames++
  }

  /** [mean, p50, p95, p99] over the last FRAME_RING frames, in milliseconds (floor index: p99 of 256 frames is the
   *  third slowest). Allocation-free: sorts a scratch copy in place, so a HUD tick never feeds the garbage collector. */
  stats(): [number, number, number, number] {
    const count = Math.min(this.n, FRAME_RING)
    if (count === 0) return [0, 0, 0, 0]
    const s = this.scratch.subarray(0, count)
    s.set(this.samples.subarray(0, count))
    s.sort()
    let sum = 0
    for (let i = 0; i < count; i++) sum += s[i]
    const at = (p: number): number => s[Math.min(count - 1, Math.floor(count * p))]
    return [sum / count, at(0.5), at(0.95), at(0.99)]
  }
}

export type Light = 'green' | 'amber' | 'red'

export interface Toast { id: number; title: string; body: string; time: number }

/** The network client's state (10_Network/netClient.ts NetStatus, carried here without the import). */
export type NetState = 'idle' | 'connecting' | 'joining' | 'joined' | 'closed'

/**
 * The network session as the console's `net status` reports it (the engine's net.status()): the client's state, the
 * room's address once joined, this page's id in it (0 until welcomed), the other players drawn, steps the client held
 * back or dropped and inputs the room has not yet acknowledged, peer voices attached, the room's corrections (snaps to
 * its truth), and why the session closed, if it did.
 */
export interface NetReport {
  state: NetState
  url: string | null
  id: number
  peers: number
  dropped: number
  pending: number
  voices: number
  reason: string | null
  /** Corrections the room's authority made this session (the welcome's spawn not counted), and the newest one's reason. */
  corrections: number
  corrected: string | null
}

/** One ping as the HUD draws it: plain data, in metres and seconds, plus its place on the screen. */
export interface HudPing {
  id: number
  /** What it asks (go, look, gather, wait) and what it landed on (the ground, a person, a car, a pole). */
  kind: 'go' | 'look' | 'gather' | 'wait'
  pick: 'point' | 'person' | 'car' | 'pole'
  /** The pedestrian row, car index or pole index it landed on; −1 for the ground. */
  index: number
  x: number
  z: number
  /** Seconds since it was placed, and seconds until it fades. */
  age: number
  left: number
  /** Metres from the head now. */
  distance: number
  /** Where it falls on the screen (0..1 across and down) while it is in front of the camera; NaN when it is not. */
  sx: number
  sy: number
}

/**
 * The operator's progression as the HUD shows it: finished strings (07_Execute_Actions/progress.ts hudProgress), so the
 * HUD stays a view of the snapshot and every word stays where progress.test.ts can read it.
 */
export interface HudProgress {
  /** The chip's line: 'Level 3 · 420 of 1,000 XP · 1,250 credits · hero 2 · ◆◆◇ ↺'. */
  text: string
  /** The same standing in full words (the chip's aria-label), and the fresh check's words while there is one. */
  label: string
  /** The round alone: ◆ for each action left, ◇ for each spent, ↺ while the reaction is ready. */
  pips: string
  /** The fresh check: a success or a critical success; null when there is none or it is no longer fresh. */
  cue: 'success' | 'critical' | null
  /** What the fresh check was, 'Critical success in Piloting', and what it paid, '+40 XP, +150 credits'; '' with no cue. */
  cueText: string
  delta: string
  /** When the fresh check was made (the host's clock, ms), so a glow can key on it once; -1 with no cue. */
  cueAt: number
  /** Ms since the fresh check; Infinity with no cue. */
  cueAge: number
}

export interface MapCar { x: number; z: number; heading: number; player: boolean; /** Nobody at its wheel: a car to take. */ parked: boolean }

/** Which control glyphs the HUD shows: the keyboard, a controller family, or touch. */
export type GlyphFamily = 'keyboard' | 'abxy' | 'bayx' | 'numbered' | 'generic' | 'touch'

/** One seat at the local split-screen table (SipocSnapshot.output.players). */
export interface SeatView {
  /** 0..3: player 1 is seat 0. */
  seat: number
  /** The index of the gamepad in this seat, −1 for none (seat 0 then runs on the keyboard, the mouse or touch). */
  pad: number
  /** The pad's face-button family (gamepad.ts PadFamily), for that viewport's glyphs; null before any input (or with no pad). */
  family: Exclude<GlyphFamily, 'keyboard' | 'touch'> | null
  mode: 'foot' | 'vehicle'
}

/** What the HUD shows about a recording in progress. */
export interface RecordingState {
  active: boolean
  source: 'canvas' | 'camera' | null
  seconds: number
  frames: number
  bytes: number
  /** Frames dropped to encoder backpressure. */
  dropped: number
  codec: string
}

/** The Ring-0 audit (ring0.ts): a post-physics, pre-render invariant check over every vehicle and person. */
export interface AuditStats {
  ticks: number
  /** Ticks in which a solid person stood within the watched 1.85 m perimeter of a moving vehicle. */
  perimeterBreaches: number
  /** Vehicle speeds clamped to the 50 m/s cap. */
  velocityCaps: number
  /** Closest footprint gap to a solid person in a moving vehicle's path this session, m (Infinity if none). */
  closest: number
  /** The kernel panic reason, once one has fired (the engine is halted from then on). */
  panic: string | null
}

/** Ring-0 kernel counters: rising-edge interventions per law, and Solid→Sensor collider flips. */
export interface KernelStats {
  law1: number
  law2: number
  law3: number
  sensorFlips: number
  /** True while any person collider is currently a sensor. */
  shielded: boolean
  /** Human-readable reason of the most recent intervention ('' if none yet). */
  last: string
  audit: AuditStats
}

/** The adaptive quality governor's current state. */
export interface QualityState {
  tier: number
  label: string
  auto: boolean
  /** Multiplier on the base pixel ratio. */
  renderScale: number
  /** Frame-time target the governor holds, ms. */
  targetMs: number
  /** The device profile is lite (governor.ts DeviceProfile.lite: an entry-level phone GPU, or ?lite=1); absent otherwise. */
  lite?: boolean
  /** The hardware class the engine sized the city for (governor.ts classifyHardware); absent on a governor given none. */
  hardware?: HardwareClass
  /** The highest tier the governor may take while the in-page model works (governor.ts hold()); absent when not held. */
  held?: number
  /** The Peak rule (governor.ts PEAK_GOV), present only on a Peak range: the GPU render time it judges, ms (p90 at Ultra,
   *  median at Peak, in auto and unheld; null otherwise or without enough readings), its limit, ms, and whether Peak is
   *  off for this visit. */
  peak?: { gpuMs: number | null; limitMs: number; off: boolean }
}

/** The cinema camera as the HUD and the console show it. */
export interface CameraStats {
  /** Presented frames per second (the pacer holds 24). */
  fps: number
  /** Seconds the shutter is open (1/48), 0 while the quality tier draws without the post chain (no blur, no film). */
  shutterS: number
  /** The variable ND filter's strength, stops (0 at night, about 0.84 in daylight). */
  ndStops: number
  /** Presented frames that were cuts (no blur across them), since boot. */
  cuts: number
}

export interface SipocSnapshot {
  supplier: {
    device: string; pointerLocked: boolean
    /** Pointer locked, touch controls engaged, or a gamepad in use: the capture hint can go. */
    engaged: boolean
    /** Coarse-pointer touch device (touch controls shown). */
    touch: boolean
    triggerResistance: number
    /** One-line hardware bus summary, e.g. "1 device · DualSense (USB) ready". */
    hal: string
    /** Control glyphs matching the input in use (silently swapped when a controller is picked up). */
    glyphs: GlyphFamily
    /** The headset (xrSession.ts): its state and one line (what the session holds, or the last answer to an ask). */
    xr: { state: XrState; detail: string }
    /** The robots' bridge (04_Connect_Hardware/robotLink.ts), added by the host: how many robots, how many armed, one line. */
    robots?: { count: number; armed: number; detail: string }
    /** The .agv recorder (recorder.ts): local-only capture of the canvas or the camera with per-frame telemetry. */
    recording: RecordingState
    /** The operator's progression (progress.ts hudProgress), added by the host. */
    progress?: HudProgress
    /**
     * Recruitment (08_Swarm/recruitment.ts), added by the host: whether the microphone is open (on-device speech
     * recognition), and one line about the Active swarm's skills and who is coming over (or the last outcome).
     */
    recruiting?: { listening: boolean; line: string }
    /**
     * The microphone (04_Connect_Hardware/microphone.ts), added by the host: its phase and detail for the HUD's pill
     * (the browser's own indicator is never on without it), whether the page itself is speaking (Sloane; the pill
     * reads Speaking), which detector analyses the audio ('worklet', 'page' or 'none'), and whether on-device speech
     * recognition is running beside it (`words`; Firefox has none, so the pill shows level and speech only).
     */
    voice?: { phase: MicPhase; detail: string; speaking: boolean; path: 'worklet' | 'page' | 'none'; words: boolean }
  }
  input: { mode: 'foot' | 'vehicle'; nearVehicle: boolean }
  process: {
    pedestrians: number; vehicles: number; drawnNear: number; drawnFar: number
    waiting: number; crossing: number; yielding: number; safetyNudges: number; gpu: string
    /** How old the pedestrian hazard readings the Bouncer used were, ms of simulation time (physics worker). */
    sensingAgeMs?: number | null
    /** GPU round trip of one crowd step in the physics worker, ms. */
    sensingLagMs?: number
    /** Pedestrian render frames received from the physics worker and drawn, since boot. */
    crowdFrames?: number
    /** The world seed the city was generated from. */
    seed?: number
    /** People at a workstation in the indoor workplaces (01_Initialize_World/interiors.ts), the city's or a generated region's; absent in a surveyed region. */
    working?: number
    /** Where the page runs: a browser tab, or a native shell (a Tauri v2 window). */
    host?: 'browser' | 'native'
  }
  output: {
    fps: number; frameMs: number; p50Ms: number; p95Ms: number; p99Ms: number; cpuMs: number; gpuRenderMs: number; gpuComputeMs: number
    /** One whole step in the physics worker (controls, vetting, substeps, Ring-0 audit, packing), ms: off this thread. */
    physicsMs: number
    /** Rapier world.step() alone, per step, ms. */
    rapierMs: number
    /** Posting one step request to the physics worker (this thread's share of the realm crossing), ms. */
    postMs?: number
    /**
     * The cinema camera; absent with ?cinema=0, where every animation frame is drawn. `fps` above stays the animation
     * frame rate: input, step requests and haptics run at it whatever the camera presents.
     */
    camera?: CameraStats
    /** Ghost view is on: the physics shapes drawn as code over the frame (view-only). */
    ghost?: boolean
    /** Matrix mode on (01_Initialize_World/matrixMode.ts). */
    matrix?: boolean
    /**
     * Whether the city is drawn (engine.setRendering, the console's render knob). False is Track B's override: the
     * canvas is black while physics, audio and the console keep running.
     */
    rendering?: boolean
    /**
     * Ghost-mode collision's passages (contact.ts): the passage envelope (0..1, up while the user's body is inside a
     * lamp, a car or a person and down after), the kind last passed through (GHOST_KIND; 0 none), and how many
     * passages there have been since boot. Nothing is drawn over the frame for one: the mesh itself dissolves.
     */
    contact?: { passage: number; kind: number; count: number }
    /**
     * The code dissolve (dissolve.ts): how many mesh instances (poles, cars, people) are dissolved or reinstantiating
     * now, and how many passages have dissolved one since boot.
     */
    dissolve?: { active: number; count: number }
    /**
     * The unified namespace (namespace.ts TopicBus): how many topics the bus retains and how many publishes it has
     * accepted since boot. The engine publishes every snapshot into it; absent before the first publish.
     */
    topics?: { count: number; publishes: number }
    /**
     * The operator's pings standing now (08_Swarm/ping.ts PingBoard), oldest first, each placed where the head looked,
     * with where it falls on the screen: a marker on the minimap and a chip over the world for the newest. Absent when
     * none stands.
     */
    pings?: HudPing[]
    /**
     * The network session (10_Network/netClient.ts, the engine's net seam): the client's state, how many other players'
     * poses the page draws, and how many of this page's inputs the client refused since the session began (over its
     * own rate). Absent until the host has attached a client; 'idle' then until the operator joins a room.
     */
    net?: { state: NetState; peers: number; dropped: number }
    /**
     * Local split screen (?players=2..4; viewports.ts, seats.ts): how many players share the canvas, each viewport's
     * rect in logical pixels (index = player, top-left first), and each seat: the pad in it (−1 none; seat 0 is the
     * keyboard, the mouse and the touch overlay, pad or not), its face-button family, and whether that player is at a
     * wheel. Absent with one player.
     */
    players?: { count: number; rects: { x: number; y: number; width: number; height: number }[]; seats: SeatView[] }
  }
  kernel: KernelStats
  quality: QualityState
  customer: {
    /** The region being walked (its fictional name), or null in the procedural city. */
    region?: string | null
    /** The region has a street window (its people, traffic and signals are real); absent or false in a surveyed region. */
    streets?: boolean
    /**
     * The storefront the avatar stands in (01_Initialize_World/storefronts.ts): its index in the engine's shops, its kind
     * and name, and whether the mirror camera circles the body now (its catalogue open). Absent outside every shop.
     */
    shop?: { index: number; kind: string; name: string; showroom: boolean }
    /** The name the user gave the Concierge ('' until they do). */
    name: string
    clock: string; daylight: number; viewYaw: number; district: string; speedKmh: number; gear: string
    x: number; z: number; heading: number; signalEW: Light; signalNS: Light; signalRemaining: number
    /**
     * Closed captions of the soundscape (captions.ts): the lines to show now, each a sound with its bearing and
     * distance, speech with its words. Absent while captions are off (?captions=0 or setCaptions(false)).
     */
    captions?: string[]
    /** What the screen reader is told this interval (07_Execute_Actions/announcer.ts), added by the host; absent when there is nothing new. */
    announce?: string
  }
  experience: { sessionSeconds: number; longFrames: number; distanceWalked: number; distanceDriven: number }
  map: MapCar[]
  toasts: Toast[]
}
