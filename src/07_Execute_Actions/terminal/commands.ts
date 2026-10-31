// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Ring-0 shell: a pure line parser and command table behind the
 * developer terminal. Every command observes or tunes the city only through the TerminalBridge, so the
 * console stays air-gapped from the agents (`recruit` only asks: the physics worker decides who comes over),
 * and all of it is unit-testable without a browser. The
 * operator tier (`operator unlock`, then `run`, `api`, `get`, `set`, `harness`, `record`) reaches the
 * simulation only through the bridge's `operator` and `record` surfaces, and only once unlocked. A script
 * names the skills it needs (`run rust: …`) and runs only if the capability gateway authorizes it; the
 * console prints the gateway's three states as they happen: Authorized, Rejected, Aborted. A prompt to the
 * local model (`ask rust: …`) goes through the same gateway, and its answer streams in live (`ask file` keeps a model
 * file in this page for it, and `ask gpu` says where that runs: neither sends a prompt, so neither waits for the unlock);
 * so does speech (`say rust: …`), said by the person it is bound to; `swarm run <goal>` splits a goal over up to five roles, each one
 * such prompt through the gateway and the guardrails, with a hash-chained audit trail (`swarm audit`). An answer may end
 * with one city action from a fixed catalogue: the console shows who proposes what, and `act ok` / `act no` (or `y` / `n`
 * while one waits) decide it; nothing runs before that, `act log` prints its own hash-chained trail, and every decision
 * made off the console (the card, a host, the gateway) is printed by the terminal's follower (actEventLines). `memory` reads
 * what the people recruited remember. The view
 * knobs (`ghost`, `render`, `captions`), the pings (`ping`: a mark where the head looks; `recruit rally` sends an
 * Active recruit to it, through the same worker checks as asking), the player's look (`look`) and the opt-in network
 * session (`net`, operator-gated) go through the bridge the same way. `boot` asks the host to reload on a track
 * (the city, or the console alone); `r0` is the console's own stack machine (repl.ts): it touches no bridge at all.
 * `topic` reads the unified namespace (05_Observe_Environment/namespace.ts): every reading of the city as a retained
 * topic, listed by filter, read one at a time, walked as a tree, or watched live like `stats`; read-only, like `stats`.
 * What breaks if it is removed? The terminal cannot interpret a single line.
 */
import type {
  ActEnd, ActEvent, ActsBridge, AgentBridge, AskResult, ConciergeBridge, ExecResult, GateTether, GoalPlan, HalDevice, HarnessReport, LookBridge, LookChange, MemoryBridge, MindStatus, ModelBridge,
  NetBridge, NetReport, OperatorBridge, PendingAct, Piece, PingKind, PingPick, RecordBridge, RecruitBridge, Ring0Stats, RunResult, SayResult, TerminalBridge, TopicBridge, VoiceStatus,
} from './bridge.ts'
import type { QualityState, RecordingState } from '../../05_Observe_Environment/telemetry.ts'
import type { SwarmReport, SwarmStatus } from '../../08_Swarm/orchestrator.ts'
import { Machine } from './repl.ts'

/** The roster's pronoun choices, as its usage line names them (08_Swarm/roster.ts PRONOUNS; roster.test.ts pins the two). */
export const PRONOUN_WORDS = 'they/them|she/her|he/him|any'
/** A goal is at most this long (06_Make_Decisions/intent.ts GOAL_MAX; intent.test.ts pins the two). */
export const GOAL_CHARS = 160

export type LineKind = 'out' | 'err' | 'cmd' | 'sys'

/** 'cmd' echoes an entered line (the terminal prefixes the prompt); 'sys' is dim console chatter. */
export interface Line { kind: LineKind; text: string }

/**
 * Text that arrives over time (a model's answer): the terminal shows it live, under the command's lines, until the
 * command's `pending` settles, and then prints `pending`'s lines in its place.
 */
export interface TextStream {
  /** Calls `fn` with each piece as it arrives: text of the answer, or a token of thinking. Returns the unsubscribe. */
  subscribe(fn: (piece: Piece) => void): () => void
}

/** How a live view draws its next frame from the bridge (`stats`, `topic watch`): the terminal calls it ~4 times a second. */
export type LiveFrame = (b: TerminalBridge) => string[]

/**
 * `live`: redraw the view in place until cancelled, each frame drawn by the function from the bridge (lines are the
 * first frame). `pending`: lines that arrive later (a device picker, a script, a harness). `stream`: text shown live
 * until `pending` settles. `clear` wipes the screen, `close` hides the console, `boot` asks the host to reload the
 * page on that track ('gui': the city; 'tty': the full-screen console alone, ?boot=tty).
 */
/** `map`: the host keeps the choice (`default` forgets it) and reloads the page on that map (App.tsx remap). */
export interface CommandResult { lines: Line[]; clear?: boolean; live?: LiveFrame; close?: boolean; boot?: 'gui' | 'tty'; map?: 'city' | 'lakefront' | 'default'; pending?: Promise<Line[]>; stream?: TextStream }

/** Quality tier indices: -1 = Lite (governor.ts LITE, below the table) … 0 = Minimal … 4 = Ultra … 5 = Peak (governor.ts PEAK, above the table). */
const MIN_TIER = -1
const MAX_TIER = 5
/** A script slower than this gets its wall time printed after its output. */
const SLOW_MS = 500
/** An R0 line that took this many steps or more gets its count printed after its output. */
const R0_NOTE_STEPS = 100_000
/** A number as typed for a point: -12, 3.5. */
const NUMBER = /^-?\d+(?:\.\d+)?$/

/** Drives `help` and Tab completion. Order is the order `help` prints. */
const CORE = [
  { name: 'help', usage: 'help [command]', summary: 'list commands, or explain one' },
  { name: 'stats', usage: 'stats [--once]', summary: 'live Rapier3D, frame, crowd and kernel readout' },
  { name: 'laws', usage: 'laws', summary: 'the three laws the kernel enforces, in rank order' },
  { name: 'kernel', usage: 'kernel', summary: 'interventions per law, Solid->Sensor flips' },
  { name: 'topic', usage: 'topic [list [<filter>]|get <topic>|tree [<prefix>]|watch [<filter>]]', summary: 'the unified namespace: every reading as a retained topic under Enterprise/JCS/Site/AgentCity (~); filter with + for one level and # for the rest' },
  { name: 'quality', usage: 'quality [auto|lite|peak|-1|0-5]', summary: 'show or set the render quality tier' },
  { name: 'time', usage: 'time [HH[:MM]]', summary: 'show or set the city clock' },
  { name: 'audio', usage: 'audio [on|off|0-100]', summary: 'show or set the soundscape' },
  { name: 'ghost', usage: 'ghost [on|off]', summary: 'ghost view: the physics shapes as code over the frame (view-only; G)' },
  { name: 'rain', usage: 'rain [on|off]', summary: 'falling code on every surface, in world space; people and cars pass through each other (M)' },
  { name: 'render', usage: 'render [on|off]', summary: 'draw the city, or stop drawing it (physics, audio and this console keep running)' },
  { name: 'captions', usage: 'captions [on|off]', summary: 'closed captions for every sound: engines, signals, speech, pings (view-only)' },
  { name: 'ping', usage: 'ping [go|look|gather|wait|clear]', summary: 'mark where you look for your swarm (view-only; shown on the minimap and captioned; Q); alone, the marks standing' },
  { name: 'look', usage: 'look [show [<agent>]|<slot> <n|name>|preset <name>|code <code>|random [<seed>]|reset]', summary: "your look from the crowd's wardrobe (body, height, mass, muscle, shoulders, hips, legs, posture, head, skin, hair, top, bottom, shirt, shoes, tie, eyewear, bag, cup)" },
  { name: 'agent', usage: 'agent [new <name>|<name> pronouns|role|voice|look|name <value...>|hire <name> [<skill>]|dismiss <name>|forget <name>|voices]', summary: 'your own agents: name, pronouns, role, voice and look; hire one into a pedestrian with a skill (they answer ask and say as themselves)' },
  { name: 'sloane', usage: 'sloane [on|off|voice <name>|voices|say <text...>]', summary: "the concierge's spoken voice: the speech provider's voice at your own head when say has one, else the browser's offline voice" },
  { name: 'goal', usage: 'goal <words...>', summary: 'tell the city a goal in plain words, as you would tell Sloane: what can be done now is done, the rest is explained' },
  { name: 'hal', usage: 'hal [pair hid|serial|ble]', summary: 'hardware bus devices; pair a controller' },
  { name: 'recruit', usage: 'recruit [<skill>|rally <agent> [<x> <z>]|listen|stop|install|dismiss]', summary: 'ask someone nearby with a skill over, or an Active recruit to the pinged point; listen by voice (on-device)' },
  { name: 'memory', usage: 'memory [<agent>|forget <agent>|forget all]', summary: 'what the people you recruit remember in this city; forget erases it (operator)' },
  { name: 'clear', usage: 'clear', summary: 'clear the screen (Ctrl+L)' },
  { name: 'history', usage: 'history', summary: 'lines entered this session' },
  { name: 'echo', usage: 'echo [text]', summary: 'print text' },
  { name: 'uname', usage: 'uname [-asnrvmi]', summary: 'system information' },
  { name: 'whoami', usage: 'whoami', summary: 'print the current user' },
  { name: 'version', usage: 'version', summary: 'print the product version' },
  { name: 'boot', usage: 'boot [gui|tty|status]', summary: 'which shell is up; boot gui reloads as the city, boot tty as this console alone (?boot=tty, no 3D engine)' },
  { name: 'map', usage: 'map [city|lakefront|default|status]', summary: 'which map is walked; map city reloads into the procedural city (people and traffic), map lakefront into the metropolis; the choice is kept until map default' },
  { name: 'r0', usage: 'r0 <words...>|r0 reset|r0 words', summary: "the console's own stack machine (Turing-complete, sandboxed: it reaches nothing of the city)" },
  { name: 'exit', usage: 'exit', summary: 'close the console (also ` or Esc)' },
] as const

/** The operator tier; every one of these that changes anything is refused until `operator unlock`. */
const OPERATOR = [
  { name: 'operator', usage: 'operator [unlock|lock|status]', summary: 'the operator tier: scripts, tuning keys, harnesses' },
  { name: 'run', usage: 'run <skill>[,<skill>...]: <js...>', summary: 'run a script against sim.* while someone tethered has the skill (Shift+Enter adds a line)' },
  { name: 'ask', usage: 'ask [<skill>[,<skill>...]: <prompt...>|provider <name>|connect <provider> [<url>] [<key>]|model <name>|server <url>|key <key>|effort <level>|think on|off|api <format>|file [forget <name>|load|unload|log]|gpu auto|on|off|stop]', summary: 'ask the model, answering as someone tethered with the skill; the answer streams in' },
  { name: 'swarm', usage: 'swarm [run [--agents <1-5>] <goal...>|plan [--agents <1-5>] <goal...>|status|stop|roles|guardrails|audit [verify]]', summary: 'a goal over up to five roles (architect, coder, tester, auditor, verifier), one gated prompt each, guardrails before and after, a hash-chained audit trail' },
  { name: 'act', usage: 'act [ok|no|log [verify]|list]', summary: 'a city action an agent proposed: allow it, refuse it, read the hash-chained trail, or list the catalogue' },
  { name: 'say', usage: 'say [<skill>[,<skill>...]: <text...>|voice <name>|model <name>|server <url>|provider local|elevenlabs|key <key>|none|auto on|off|stop]', summary: 'said aloud by someone tethered with the skill, from where they stand (a speech server on this machine; or ElevenLabs through a gateway on it)' },
  { name: 'api', usage: 'api [path]', summary: 'the script API, or one branch of it' },
  { name: 'get', usage: 'get [path]', summary: 'read physics.* and shaders.* tuning keys' },
  { name: 'set', usage: 'set <path> <value>', summary: 'write a physics.* or shaders.* tuning key' },
  { name: 'harness', usage: 'harness [list|run <name>]', summary: 'physics harnesses: kernel stop, First-Law floor, sanctuary, brakes, lights, the spatial sweep' },
  { name: 'record', usage: 'record [start [canvas|camera]|stop|status]', summary: 'record the view (or the camera) with per-frame telemetry to a local .agv file' },
  { name: 'net', usage: 'net [join <ws-url> [<token>]|leave|status|forget]', summary: 'the opt-in network session: join a room on this machine with its token (kept on this machine), leave it, read it' },
  { name: 'sim', usage: 'sim', summary: 'one-screen summary of the simulation' },
] as const

const COMMANDS = [...CORE, ...OPERATOR] as const

type Name = (typeof COMMANDS)[number]['name']

const NAMES: readonly string[] = COMMANDS.map((c) => c.name).sort()

/** Commands whose argument is the rest of the line, untokenized (a script, a prompt or an R0 line keeps its quotes and newlines). */
const RAW: ReadonlySet<string> = new Set(['run', 'ask', 'say', 'r0', 'goal', 'agent', 'sloane', 'swarm'])

/** A persistent R0 machine (repl.ts): the terminal keeps one for the life of the console, so definitions outlive a line. */
export interface ReplSession { machine: Machine }
export const replSession = (): ReplSession => ({ machine: new Machine() })

/** The model providers, as typed after `ask provider` (commands.test.ts pins them to 09_Cognition/router.ts, which this file must not import). */
export const PROVIDER_ARGS = ['auto', 'claude', 'inpage', 'llamacpp', 'ollama', 'openai', 'scripted'] as const

/** The harness names, for completion (commands.test.ts pins them to harness.ts, which this file must not import). */
export const HARNESS_NAMES = ['brake-distance', 'first-law-floor', 'kernel-stop', 'sanctuary', 'spatial', 'traffic-lights'] as const

const PAIR_KINDS: Record<string, 'hid' | 'serial' | 'bluetooth'> = { hid: 'hid', serial: 'serial', ble: 'bluetooth', bluetooth: 'bluetooth' }

/** The skills, as typed after `recruit` (commands.test.ts pins them to skills.ts, which this file must not import). */
export const SKILL_ARGS = [
  'accessibility', 'audio', 'c++', 'data', 'design', 'go', 'networking', 'python', 'robotics', 'rust', 'security', 'shaders', 'testing',
  'typescript', 'wgsl', 'writing',
] as const
const RECRUIT_ACTIONS = ['dismiss', 'install', 'listen', 'rally', 'stop'] as const

/** What `ask file` does beside choosing a file (alone, it opens the picker), and the GPU switch's modes. */
const MODEL_FILE_ACTIONS = ['forget', 'load', 'log', 'unload'] as const
const GPU_MODES = ['auto', 'off', 'on'] as const
/** The runtime's log lines `ask file log` prints at most (the newest). */
const LOG_SHOWN = 40

/** The kinds of ping and their words (commands.test.ts pins them to 08_Swarm/ping.ts, which this file must not import). */
const PING_KINDS = ['gather', 'go', 'look', 'wait'] as const
const PING_WORDS: Record<PingKind, string> = { go: 'go there', look: 'look there', gather: 'gather there', wait: 'wait there' }

/** The look's slots, bodies and presets, as typed after `look` (commands.test.ts pins them to 03_Spawn_Agents/look.ts, not imported here). */
export const LOOK_SLOT_ARGS = [
  'body', 'height', 'mass', 'muscle', 'shoulders', 'hips', 'legs', 'posture', 'head', 'brow', 'jaw', 'chin', 'cheek', 'nose', 'eyes', 'lips',
  'skin', 'age', 'undertone', 'hairStyle', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'tie', 'eyewear', 'bag', 'cup',
] as const
export const LOOK_BODY_ARGS = ['pantsuit', 'skirt suit', 'smart casual', 'suit'] as const
export const LOOK_PRESET_ARGS = ['burgundy pantsuit', 'camel blazer', 'camel skirt suit', 'charcoal suit', 'cream pantsuit', 'navy blazer', 'navy skirt suit', 'navy suit'] as const
const LOOK_ACTIONS = ['code', 'preset', 'random', 'reset', 'show'] as const

/** Tab-completion candidates for arguments, keyed by the words before the one being completed. */
const ARGS: Record<string, readonly string[]> = {
  help: NAMES,
  stats: ['--once'],
  topic: ['get', 'list', 'tree', 'watch'],
  quality: ['-1', '0', '1', '2', '3', '4', '5', 'auto', 'lite', 'peak'],
  audio: ['off', 'on'],
  ghost: ['off', 'on'],
  rain: ['off', 'on'],
  render: ['off', 'on'],
  captions: ['off', 'on'],
  ping: ['clear', ...PING_KINDS],
  look: [...LOOK_ACTIONS, ...LOOK_SLOT_ARGS].sort(),
  agent: ['dismiss', 'forget', 'hire', 'new', 'voices'],
  sloane: ['off', 'on', 'say', 'voice', 'voices'],
  'look body': LOOK_BODY_ARGS,
  'look hairStyle': ['bald', 'bob', 'bun', 'long', 'short'],
  'look undertone': ['cool', 'neutral', 'olive', 'warm'],
  'look preset': LOOK_PRESET_ARGS,
  boot: ['gui', 'status', 'tty'],
  map: ['city', 'default', 'lakefront', 'status'],
  r0: ['reset', 'words'],
  hal: ['pair'],
  'hal pair': ['ble', 'hid', 'serial'],
  recruit: [...RECRUIT_ACTIONS, ...SKILL_ARGS].sort(),
  uname: ['-a'],
  operator: ['lock', 'status', 'unlock'],
  run: SKILL_ARGS.map((s) => `${s}:`),
  ask: [...SKILL_ARGS.map((s) => `${s}:`), 'api', 'connect', 'effort', 'file', 'gpu', 'key', 'model', 'provider', 'server', 'stop', 'think'].sort(),
  'ask think': ['off', 'on'],
  'ask file': MODEL_FILE_ACTIONS,
  'ask gpu': GPU_MODES,
  'ask api': ['chat', 'generate'],
  'ask provider': PROVIDER_ARGS,
  'ask connect': PROVIDER_ARGS,
  swarm: ['audit', 'guardrails', 'plan', 'roles', 'run', 'status', 'stop'],
  'swarm audit': ['verify'],
  act: ['list', 'log', 'no', 'ok'],
  'act log': ['verify'],
  'ask effort': ['high', 'low', 'max', 'medium', 'none', 'xhigh'],
  say: [...SKILL_ARGS.map((s) => `${s}:`), 'auto', 'key', 'model', 'provider', 'server', 'stop', 'voice'].sort(),
  'say auto': ['off', 'on'],
  'say provider': ['elevenlabs', 'local'],
  memory: ['forget'],
  'memory forget': ['all'],
  api: ['avatar', 'clock', 'console', 'crowd', 'kernel', 'physics', 'quality', 'shaders', 'signal', 'sleep', 'snapshot', 'vehicles'],
  get: ['physics', 'shaders'],
  harness: ['list', 'run'],
  'harness run': HARNESS_NAMES,
  record: ['start', 'status', 'stop'],
  'record start': ['camera', 'canvas'],
  net: ['forget', 'join', 'leave', 'status'],
}

const out = (text: string): Line => ({ kind: 'out', text })
const err = (text: string): Line => ({ kind: 'err', text })
const sys = (text: string): Line => ({ kind: 'sys', text })
const fail = (...text: string[]): CommandResult => ({ lines: text.map(err) })
const usage = (name: Name): string => `usage: ${COMMANDS.find((c) => c.name === name)!.usage}`
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const locked = (name: Name): CommandResult => fail(`${name}: locked; type 'operator unlock' first`)

const fixed = (v: number, digits: number): string => (Number.isFinite(v) ? v.toFixed(digits) : '-')
const count = (v: number): string => (Number.isFinite(v) ? String(Math.round(v)) : '-')
/** GPU timings are 0 until timestamp queries resolve (?profile, or a Peak range at Ultra or Peak), so 0 reads as "not measured". */
const gpuMs = (v: number): string => (Number.isFinite(v) && v > 0 ? v.toFixed(2) : '-')
const row = (label: string, text: string): string => label.padEnd(10) + text

/** A bridge built before the operator tier existed has no `operator`; say so instead of crashing. */
function operatorOf(b: TerminalBridge): OperatorBridge {
  const op = b.operator
  if (!op) throw new Error('operator tier not available on this bridge')
  return op
}

/** Likewise for a host that publishes no topics (the TTY shell, an older host). */
function topicsOf(b: TerminalBridge): TopicBridge {
  const t = b.topics
  if (!t) throw new Error('the namespace is not available on this bridge')
  return t
}

/** Likewise for a bridge built before recruitment existed. */
function recruitOf(b: TerminalBridge): RecruitBridge {
  const r = b.recruit
  if (!r) throw new Error('recruitment not available on this bridge')
  return r
}

/** Likewise for a bridge built before the swarm's memory existed. */
function memoryOf(b: TerminalBridge): MemoryBridge {
  const m = b.memory
  if (!m) throw new Error('memory not available on this bridge')
  return m
}

/** Likewise for a bridge built before the recorder existed. */
function recordOf(b: TerminalBridge): RecordBridge {
  const rec = b.record
  if (!rec) throw new Error('recorder not available on this bridge')
  return rec
}

/** Likewise for a bridge without a network client (the TTY shell, an older host). */
function netOf(b: TerminalBridge): NetBridge {
  const n = b.net
  if (!n) throw new Error('network not available on this bridge')
  return n
}

/** A page whose host keeps no model file (the onboarding page, the TTY shell, an older host) says so in plain words. */
function modelOf(b: TerminalBridge): ModelBridge {
  const m = b.model
  if (!m) throw new Error('this page cannot hold a model file')
  return m
}

/** Likewise for a bridge whose host keeps no look (the TTY shell, an older host). */
function lookOf(b: TerminalBridge): LookBridge {
  const l = b.look
  if (!l) throw new Error('look not available on this bridge')
  return l
}

function rosterOf(b: TerminalBridge): AgentBridge {
  const a = b.agent
  if (!a) throw new Error('the roster is not available on this bridge')
  return a
}

function conciergeOf(b: TerminalBridge): ConciergeBridge {
  const c = b.concierge
  if (!c) throw new Error('the concierge is not available on this bridge')
  return c
}

const AGENT_FIELDS = ['pronouns', 'role', 'voice', 'look', 'name'] as const
type AgentField = (typeof AGENT_FIELDS)[number]
const isAgentField = (v: string): v is AgentField => (AGENT_FIELDS as readonly string[]).includes(v)

/** A pedestrian's number as typed (`memory 7`, `look show 7`, `recruit rally 7`), or null. */
const agentOf = (a: string): number | null => (/^\d{1,9}$/.test(a) ? Number(a) : null)

/** mm:ss (minutes keep counting past 59). */
function clockOf(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function sizeOf(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** "360 frames  00:12  1.2 MB  av01.0.04M.08[  3 dropped]" — ASCII, two-space columns like the stats. */
function recordingParts(r: RecordingState): string {
  const parts = [`${count(r.frames)} frames`, clockOf(r.seconds), sizeOf(r.bytes), r.codec || '-']
  if (r.dropped > 0) parts.push(`${count(r.dropped)} dropped`)
  return parts.join('  ')
}

/** The `record status` line: what is being recorded, or 'idle' (with the last recording's figures, if any). */
export function formatRecording(r: RecordingState): string {
  if (r.active) return `recording ${r.source ?? '-'}  ${recordingParts(r)}`
  return r.frames > 0 || r.bytes > 0 ? `idle  last ${r.source ?? '-'}  ${recordingParts(r)}` : 'idle'
}

/** One line of the Ring-0 audit: ticks audited, watched-perimeter breaches, velocity caps, closest gap, panic. */
export function auditLine(a: { ticks: number; perimeterBreaches: number; velocityCaps: number; closest: number; panic: string | null }): string {
  const closest = Number.isFinite(a.closest) ? `${a.closest.toFixed(2)} m` : '-'
  return `ticks ${count(a.ticks)}  perimeter ${count(a.perimeterBreaches)}  caps ${count(a.velocityCaps)}  closest ${closest}  panic ${a.panic ?? 'none'}`
}

/** The quality line; a lite device profile says so, and in auto at Ultra or Peak on a Peak range the GPU reading the
 *  Peak rule judges against its limit, or that Peak is off for this visit. At most 80 columns in `stats`. */
export function formatQuality(q: QualityState): string {
  const p = q.peak && q.auto && q.tier >= MAX_TIER - 1 ? q.peak : undefined
  const peak = p ? (p.off ? '  peak off' : `  peak ${p.gpuMs === null ? '-' : fixed(Math.min(p.gpuMs, 999.9), 1)}/${fixed(p.limitMs, 1)} ms`) : ''
  return `tier ${q.tier} ${q.label} (${q.auto ? 'auto' : 'fixed'})  scale ${fixed(q.renderScale, 2)}x  budget ${fixed(q.targetMs, 1)} ms${q.lite ? '  lite profile' : ''}${peak}`
}

/** The cinema camera's row (none with ?cinema=0): presented frames, the shutter, the ND, the cuts. ASCII only. */
function cameraRows(s: Ring0Stats): string[] {
  const c = s.camera
  if (!c) return []
  const shutter = c.shutterS > 0 ? `shutter 1/${Math.round(1 / c.shutterS)} s` : 'shutter off (no post chain)'
  return [row('camera', `${fixed(c.fps, 1)} fps presented  ${shutter}  ND ${fixed(c.ndStops * Math.log10(2), 2)} (${fixed(c.ndStops, 2)} stops)  cuts ${count(c.cuts)}`)]
}

/** One `stats` frame: fixed-column text, ASCII only, at most ~80 columns per line. */
export function formatStats(s: Ring0Stats): string[] {
  const r = s.rapier, a = s.agents, k = s.kernel
  const drawn = a.drawnNear + a.drawnFar
  const share = a.population > 0 ? ` (${fixed((100 * drawn) / a.population, 1)}%)` : ''
  return [
    row('frame', `${fixed(s.fps, 1)} fps  ${fixed(s.frameMs, 2)} ms  p95 ${fixed(s.p95Ms, 2)} ms  cpu ${fixed(s.cpuMs, 2)} ms`),
    ...cameraRows(s),
    row('gpu', `render ${gpuMs(s.gpuRenderMs)} ms  compute ${gpuMs(s.gpuComputeMs)} ms`),
    row('rapier3d', `step ${fixed(r.stepMs, 3)} ms  physics ${fixed(r.physicsMs, 2)} ms/frame  substeps ${count(r.steps)}`),
    row('', `bodies ${count(r.bodies)}  colliders ${count(r.colliders)}  ccd ${count(r.ccd)}`),
    row('agents', `drawn ${count(drawn)} of ${count(a.population)}${share}  near ${count(a.drawnNear)}  far ${count(a.drawnFar)}`),
    row('', `waiting ${count(a.waiting)}  crossing ${count(a.crossing)}  yielding ${count(a.yielding)}  nudges ${count(a.nudges)}`),
    row('vehicles', count(s.vehicles)),
    row('quality', formatQuality(s.quality)),
    row('kernel', `law1 ${count(k.law1)}  law2 ${count(k.law2)}  law3 ${count(k.law3)}  flips ${count(k.sensorFlips)}  shielded ${k.shielded ? 'yes' : 'no'}`),
    row('', `last ${k.last || '-'}`),
    row('audit', auditLine(k.audit)),
  ]
}

function formatDevice(d: HalDevice): string {
  return `  ${d.transport.padEnd(10)}${d.state.padEnd(13)}${d.name}${d.detail ? `  ${d.detail}` : ''}${d.profile ? `  [${d.profile}]` : ''}`
}

/** A script's output: its captured console lines, then its error or its value (no value: nothing is printed). */
function execLines(r: ExecResult): Line[] {
  const lines = r.logs.flatMap((l) => l.split('\n').map(out))
  if (r.error !== undefined) lines.push(err(`run: ${r.error}`))
  else if (!r.empty) lines.push(...r.value.split('\n').map(out))
  if (r.ms >= SLOW_MS) lines.push(sys(`-- ${(r.ms / 1000).toFixed(1)} s --`))
  return lines
}

function reportLines(r: HarnessReport): Line[] {
  const verdict = `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}  (${(r.ms / 1000).toFixed(1)} s)`
  return [...r.lines.map(out), r.pass ? out(verdict) : err(verdict)]
}

/** A tether as the console names it: "agent 17 (Rust, Python)" (the gateway's own wording). */
const tetherText = (t: GateTether): string => `agent ${t.agent} (${t.skills.join(', ')})`

/**
 * A gated script's outcome: Rejected or Aborted in the gateway's words (an abort after whatever the script logged
 * before it), otherwise the script's own output.
 */
function runLines(r: RunResult): Line[] {
  if (r.state === 'Rejected') return [err(`run: Rejected (Insufficient Capabilities): ${r.reason ?? ''}`)]
  if (r.state === 'Aborted') return [...r.logs.flatMap((l) => l.split('\n').map(out)), err(`run: Aborted (Spatial Tether Lost): ${r.reason ?? ''}`)]
  return execLines(r)
}

/** An answer's text as lines (blank lines at its end dropped). */
function textLines(text: string): Line[] {
  const t = text.replace(/\s+$/, '')
  return t ? t.split('\n').map(out) : []
}

/**
 * An ask's outcome: the answer (or as much as arrived), then how it ended: Rejected or Aborted in the gateway's words,
 * the server's failure or the operator's stop, or a closing note with the time taken.
 */
function askLines(r: AskResult): Line[] {
  if (r.state === 'Rejected') return [err(`ask: Rejected (Insufficient Capabilities): ${r.reason ?? ''}`)]
  const answer = textLines(r.text)
  if (r.state === 'Aborted') return [...answer, err(`ask: Aborted (Spatial Tether Lost): ${r.reason ?? ''}`)]
  if (r.error !== undefined) return [...answer, err(`ask: ${r.error}`)]
  // 14A: the agent did not engage (the conduct screen, or the model's own refusal): no reply, and nothing about it.
  if (r.disengaged) return [sys('-- no reply --')]
  // The script stood in for a model that did not answer: said plainly, so its words are never taken for a model's.
  if (r.standIn !== undefined) return [...answer, err(`ask: no model answered, so the script spoke instead: ${r.standIn}`)]
  // An answer that was only its ACTION line (stripped, acts.ts) is not "no text": the act line below says what became of it.
  const none = answer.length || r.act ? [] : [sys(r.thinking > 0 ? '(no answer: the model spent its tokens thinking)' : '(the model returned no text)')]
  const thought = r.thinking > 0 ? `, after ${r.thinking} tokens of thinking` : ''
  const cut = r.done === 'length' ? ' (cut at the token limit)' : ''
  return [...answer, ...none, sys(`-- answered in ${(r.ms / 1000).toFixed(1)} s${thought}${cut} --`), ...actAskLines(r.act)]
}

/** A proposal's clamp note as the console shows it: ' (clamped from 9)', or nothing. */
const noteOf = (note: string | undefined): string => (note ? ` (${note})` : '')

/**
 * After an answer: the city action it proposed, now waiting for the OK (who proposes what, in the city's own words,
 * and how to decide it), or the line the city could not read and why; the gate's own refusals name nobody to tell.
 */
function actAskLines(act: AskResult['act']): Line[] {
  if (!act) return []
  if (act.kind === 'refused') return [err(`act: not run: ${act.reason}${act.told === undefined ? '' : ` (agent ${act.told} is told next time)`}`)]
  return [out(`act ${act.seq}: ${act.who} proposes: ${act.sentence}${noteOf(act.note)}`), sys('-- y allows it, n refuses it (act ok, act no); console closed: Y or N on the card --')]
}

/**
 * How a proposed city action ended, as the console prints it: the done line, the failure, the gateway's abort in its
 * own words (never retyped), the refusal (the proposer is told next time) or the withdrawal and why.
 */
function actEndLines(act: PendingAct, end: ActEnd): Line[] {
  const n = act.seq
  switch (end.state) {
    case 'done': return [out(`act ${n}: done: ${end.line}`)]
    case 'failed': return [err(`act ${n}: failed: ${end.line}`)]
    case 'aborted': return [err(`act ${n}: ${/^Aborted \(/.test(end.line) ? end.line : `Aborted (Spatial Tether Lost): ${end.line}`}`)]
    case 'refused': return [sys(`act ${n}: refused: ${act.sentence} (agent ${act.agent} is told next time)`)]
    case 'withdrawn': return [sys(`act ${n}: withdrawn: ${end.line.replace(/^withdrawn: /, '')}`)]
  }
}

/**
 * A proposal's event as the terminal's follower prints it: nothing for a proposal (the ask that made it prints it) and
 * nothing the console itself caused (`act ok`, `act no` print their own lines, so every line is printed once); a decision
 * made on the card or by a host says where, and an end from the gateway (the tether broke, the gateway closed) is its
 * own wording. Pure: Terminal.tsx appends what this returns, open or hidden, so the scrollback is complete on reopening.
 */
export function actEventLines(ev: ActEvent): Line[] {
  if (ev.kind === 'proposed' || ev.by === 'console') return []
  const n = ev.act.seq
  const by = ev.by === 'card' ? 'on the card' : ev.by === 'host' ? 'by the host' : 'by the gateway'
  if (ev.kind === 'allowed') return [sys(`act ${n}: allowed ${by}: ${ev.act.sentence}`)]
  if (ev.end.state === 'refused') return [sys(`act ${n}: refused ${by}: ${ev.act.sentence}`)]
  return actEndLines(ev.act, ev.end)
}

/** How a say ended: who said it and for how long, or why not (Rejected, Aborted, the server, the sound, a stop). */
function sayLines(r: SayResult): Line[] {
  if (r.state === 'Rejected') return [err(`say: Rejected (Insufficient Capabilities): ${r.reason ?? ''}`)]
  if (r.state === 'Aborted') return [err(`say: Aborted (Spatial Tether Lost): ${r.reason ?? ''}`)]
  if (r.error !== undefined) return [r.stopped ? sys(`say: ${r.error}`) : err(`say: ${r.error}`)]
  if (r.silent) return [sys('-- not said --')]
  const who = r.speaker ? tetherText(r.speaker) : 'someone tethered'
  return [sys(`-- said by ${who}${r.seconds !== undefined ? ` (${r.seconds.toFixed(1)} s)` : ''} --`)]
}

/** `say` alone: the speech server, the voice and model chosen, auto, and the voices the server lists. */
function voiceLines(v: VoiceStatus): Line[] {
  const lines = [
    ...(v.provider !== undefined ? [out(row('provider', v.provider === 'elevenlabs' ? 'elevenlabs: through a gateway on this machine' : 'local: a speech server on this machine'))] : []),
    out(row('server', `${v.server}  (this machine only)`)),
    ...(v.provider === 'elevenlabs' ? [out(row('key', v.key ?? 'none on the page: the gateway adds it (say key <key> keeps one here)'))] : []),
    out(row('voice', v.voice ?? 'none chosen: say voice <name>')),
    out(row('model', v.model ?? "the server's default")),
    out(row('auto', v.auto ? 'on: answers to ask are said aloud' : 'off')),
  ]
  if (v.speaking) lines.push(sys("saying something now: 'say stop' cuts it off"))
  if (v.error !== undefined) return [...lines, err(`say: ${v.error}`)]
  if (v.voices === null) return [...lines, sys("the server keeps no list of voices: name one its documentation gives (say voice <name>)")]
  if (!v.voices.length) return [...lines, out(row('voices', 'none'))]
  // A listed voice is its name, or 'Name (id)' from ElevenLabs: the chosen one by either.
  const chosen = (name: string): boolean => v.voice !== null && (name === v.voice || name.startsWith(`${v.voice} (`) || name.endsWith(` (${v.voice})`))
  lines.push(...v.voices.map((name, i) => out(row(i === 0 ? 'voices' : '', chosen(name) ? `${name}  (chosen)` : name))))
  return lines
}

/** What a ping met, for the console: 'person 12 at (312.4, 88.1), 8.3 m away'. ASCII only. */
function pickText(p: PingPick): string {
  const what = p.kind === 'point' ? 'a spot on the ground' : `${p.kind} ${p.index}`
  return `${what} at (${fixed(p.x, 1)}, ${fixed(p.z, 1)}), ${fixed(p.distance, 1)} m away`
}

/** `net status`: the session as plain rows (state, room, player number, peers, dropped, pending, voices, corrections, reason). */
function netLines(r: NetReport): Line[] {
  const lines = [
    out(row('state', r.state)),
    out(row('room', r.url ?? 'none (net join <ws-url> <token>)')),
    out(row('player', r.state === 'joined' ? String(r.id) : '-')),
    out(row('peers', `${count(r.peers)}  dropped ${count(r.dropped)}  pending ${count(r.pending)}  voices ${count(r.voices)}`)),
  ]
  // The room's authority snapped this page to its truth: how often, and the newest reason.
  if (r.corrections > 0) lines.push(out(row('snapped', `${count(r.corrections)}  last: ${r.corrected ?? 'unknown'}`)))
  if (r.reason) lines.push(out(row('reason', r.reason)))
  return lines
}

/**
 * `look <action> <rest...>` as a change (03_Spawn_Agents/look.ts LookChange), or the error line: the action and its
 * words are checked here, the values themselves by the host against the wardrobe.
 */
function lookChange(action: string, rest: readonly string[]): LookChange | string {
  if (action === 'reset') return rest.length ? usage('look') : { kind: 'reset' }
  if (action === 'random') {
    if (rest.length > 1) return usage('look')
    if (rest.length && !/^\d{1,9}$/.test(rest[0])) return `look: the seed must be a number, not '${rest[0]}'`
    return { kind: 'random', seed: rest.length ? Number(rest[0]) : Number.NaN }
  }
  if (action === 'preset') return rest.length ? { kind: 'preset', name: rest.join(' ') } : 'usage: look preset <name>'
  if (action === 'code') return rest.length === 1 ? { kind: 'code', code: rest[0] } : 'usage: look code <XXXXXXX-XXXXXXX-XXXXXXX>'
  const slot = LOOK_SLOT_ARGS.find((x) => x.toLowerCase() === action.toLowerCase())
  if (!slot) return `look: no slot named '${action}': ${LOOK_SLOT_ARGS.join(', ')}`
  return rest.length ? { kind: 'slot', slot, value: rest.join(' ') } : `usage: look ${slot} <n|name>`
}

/** Audit entries `swarm audit` and `act log` print at most (the newest). */
const AUDIT_SHOWN = 24

type AuditRows = ReturnType<ActsBridge['log']>
type AuditVerdict = ReturnType<ActsBridge['verify']>

/**
 * A hash-chained trail as the console prints it (`swarm audit`, `act log`): the newest entries, one row each (number,
 * kind, step, the start of its hash, the invariants it failed and its note), then the chain's verdict from genesis, or
 * `empty` alone when nothing has been written yet.
 */
function auditLines(entries: AuditRows, v: AuditVerdict, empty: string): Line[] {
  const shown = entries.slice(-AUDIT_SHOWN)
  const lines: Line[] = entries.length ? [] : [sys(empty)]
  if (entries.length > shown.length) lines.push(sys(`… ${entries.length - shown.length} earlier entries`))
  for (const e of shown) lines.push(out(`${String(e.seq).padStart(4)}  ${e.kind.padEnd(8)}${(e.step || '-').padEnd(10)}${e.hash.slice(0, 12)}  ${e.failed.length ? `${e.failed.join(',')}: ` : ''}${e.note}`))
  lines.push(v.ok ? sys(`chain: ${v.length} entries verify from genesis; head ${v.head.slice(0, 16)}… (SHA-256 of each entry's canonical body and the hash before it)`) : err(`chain: BROKEN at entry ${v.at}: ${v.why}`))
  return lines
}

/** The guardrail invariants, in one line each (commands.test.ts pins them to 02_Define_The_Rules/guardrails.ts, which this file must not import). */
const INVARIANT_LINES: readonly (readonly [string, string])[] = [
  ['HumanOverrideSupreme', 'a run the operator has stopped admits no further step, whatever else holds'],
  ['CapabilityTethered', "a step runs only while someone tethered to the operator has its role's skill (the capability gateway decides)"],
  ['ConductScreen14A', 'the prompt a role is given and the answer it gives both pass the 14A screen (a lexicon; the model under the conduct core is the second layer)'],
  ['LoopbackOnly', 'the model endpoint a step reaches is on this machine, or there is none (the scripted provider, or a model running in this page)'],
  ['BudgetWithinQuota', 'steps, prompt length, answer length and tokens stay within the quota'],
  ['ProvenanceChained', 'the hash-chained audit trail verifies before every step; a tampered record stops the run'],
]

/** `swarm` alone: whether a run is on, where it is, what it has spent, and the audit trail's size and head. */
function swarmStatusLines(s: SwarmStatus): Line[] {
  const lines = [out(row('swarm', s.running ? `running: "${s.goal ?? ''}", ${s.done} of ${s.total} steps answered${s.step ? `, asking ${s.step}` : ''}${s.stopped ? ' (stopping)' : ''}` : 'idle (swarm run <goal> starts one; swarm roles, swarm guardrails explain it)'))]
  if (s.running) lines.push(out(row('spent', `${s.spent.steps} step${s.spent.steps === 1 ? '' : 's'}, ${s.spent.tokens} tokens`)))
  lines.push(out(row('audit', s.audit ? `${s.audit} entries, head ${s.head.slice(0, 16)}… (swarm audit)` : 'empty')))
  return lines
}

/** A finished run: each step's answer under its role, how each ended, then the whole. */
function swarmReportLines(r: SwarmReport): Line[] {
  const lines: Line[] = []
  for (const st of r.steps) {
    lines.push(sys(`-- ${st.title} (${st.skill}) --`))
    lines.push(...textLines(st.text))
    if (st.state === 'answered') lines.push(sys(`   ${st.note}`))
    else lines.push(err(`   ${st.state}: ${st.note}`))
  }
  lines.push(r.ok ? sys(`-- swarm done: ${r.steps.length} step${r.steps.length === 1 ? '' : 's'} in ${(r.ms / 1000).toFixed(1)} s; audit head ${r.head.slice(0, 16)}… (swarm audit) --`) : err(`swarm: ended after ${r.steps.length} of ${r.agents} steps${r.stopped ? ' (stopped)' : ''}; audit head ${r.head.slice(0, 16)}… (swarm audit)`))
  return lines
}

/** `ask` alone: the provider, where its server is, the model chosen, and what the server says it has. */
function mindLines(m: MindStatus): Line[] {
  const auto = m.provider === 'auto'
  // Under auto, what it found decides the rows below (the gateway's key and effort when it found the Claude gateway;
  // the runtime and storage rows when it found the model file kept in this page).
  const network = m.provider === 'claude' || (auto && m.key !== undefined)
  const inPage = m.provider === 'inpage' || (auto && m.runtime !== undefined)
  const scripted = m.provider === 'scripted'
  const lines: Line[] = []
  if (m.provider !== undefined) {
    lines.push(out(row('provider', auto ? 'auto: the first model that answers on this machine, kept until it stops answering; ask alone looks again (ask provider ollama|llamacpp|openai|claude to choose one)'
      : network ? 'claude: the Claude API through a gateway on this machine (ask provider ollama|llamacpp|openai for a model on this machine, scripted for none)'
        : scripted ? 'scripted: no backend; the script answers on this page, and nothing reaches any network (ask provider claude|ollama|llamacpp|openai for a model)'
          : inPage ? 'inpage: a model file kept in this page, run here on this device; nothing is addressed (ask file chooses the file, ask gpu where it runs)'
            : `${m.provider}: a model server on this machine (ask provider claude for the Claude API)`)))
  }
  if (m.auto !== undefined) lines.push(out(row('found', m.auto)))
  // 'default' in the chat format is the placeholder the client resolves to the model the server has loaded (LM Studio
  // says which), else the first it lists that writes text, in its own order (localCompute.ts ANY_MODEL); `resolved`
  // names it once an answer has asked.
  const placeholder = m.model === 'default' && m.api === 'chat'
  // In this page, none chosen with files kept (the chosen one forgotten) means choosing one of them, not keeping another.
  const model = m.model === null ? (inPage && !m.installed?.length ? 'none chosen: Menu › Model file, or ask file' : 'none chosen: ask model <name>')
    : placeholder ? (m.resolved !== undefined ? `${m.resolved}  (the model the server has loaded, else the first it lists that writes text; ask model <name> to choose)` : 'default: the model the server has loaded, else the first it lists that writes text, asked at the next answer (ask model <name> to choose)')
      : m.model
  if (scripted) lines.push(out(row('server', 'none: nothing is addressed')), out(row('model', 'none: the script')))
  else if (inPage) lines.push(out(row('server', 'none: the model runs in this page')), out(row('model', model)))
  else lines.push(out(row('server', network ? `${m.server}  (a gateway on this machine only)` : `${m.server}  (this machine only)`)), out(row('model', model)))
  if (network) {
    lines.push(out(row('key', m.key ? `${m.key}  (kept in this browser's local storage: ask key none clears it)` : 'none in this page: the gateway on this machine adds it (recommended)')))
    lines.push(out(row('effort', m.effort ?? "the model's default (ask effort low|medium|high|xhigh|max)")))
  }
  if (m.api !== undefined) lines.push(out(row('api', m.api === 'chat' ? 'chat: /v1/chat/completions (ask api generate for /api/generate)' : `${m.api}: /api/generate (ask api chat for /v1/chat/completions)`)))
  if (m.think !== undefined) lines.push(out(row('think', m.api === 'chat' ? 'not sent in the chat format: the server decides' : m.think ? 'on: it reasons before it answers' : 'off: it answers without reasoning first (ask think on)')))
  if (m.runtime !== undefined) lines.push(out(row('runtime', m.runtime)))
  if (m.storage !== undefined) lines.push(out(row('storage', m.storage)))
  if (m.cache !== undefined) lines.push(out(row('cache', m.cache)))
  if (m.fallback !== undefined) lines.push(out(row('fallback', m.fallback)))
  if (m.scripted !== undefined) lines.push(out(row('scripted', m.scripted)))
  if (m.installed === null) return [...lines, err(`ask: ${m.error ?? (auto ? 'no model answered on this machine' : network ? 'the gateway to the Claude API did not answer' : inPage ? 'the model in this page cannot run here' : 'the local model server did not answer')}`)]
  if (scripted) return lines
  if (!m.installed.length) return [...lines, out(row('installed', inPage ? 'no model file kept: Menu › Model file, or ask file' : 'no models'))]
  const answers = placeholder ? m.resolved : m.model
  lines.push(...m.installed.map((name, i) => out(row(i === 0 ? 'installed' : '', name === answers ? `${name}  (chosen)` : name))))
  if (m.model === null) lines.push(sys(inPage ? 'choose one of the files kept: ask model <name>' : 'choose one that writes text: ask model <name>'))
  return lines
}

const isGpuMode = (v: string): v is (typeof GPU_MODES)[number] => (GPU_MODES as readonly string[]).includes(v)

/**
 * `ask file [forget <name>|load|unload|log]`: alone, the browser's file picker (opened inside the Enter keydown, like
 * `hal pair`), and the file chosen is kept in this page for the in-page provider; `forget` drops the kept model named
 * (a bare `forget`, which Tab completes to, is a usage error: it never drops every file kept), `load` and `unload`
 * load the chosen one now or free it, `log` prints the runtime's newest lines. None of it sends a prompt, so none of
 * it waits for `operator unlock`.
 */
function askFile(b: TerminalBridge, action: string | undefined, name: string): CommandResult {
  const later = (p: Promise<string>): Promise<Line[]> => Promise.resolve(p).then((t) => [out(row('file', t))], (e: unknown): Line[] => [err(`ask: ${message(e)}`)])
  if (action === undefined) {
    const pending = later(modelOf(b).pick())
    return { lines: [sys("ask: choose the model file (.gguf, or every part of a split one) in the browser's picker...")], pending }
  }
  if (action === 'forget') return name ? { lines: [], pending: later(modelOf(b).forget(name)) } : fail('usage: ask file forget <name>')
  if (name) return fail('usage: ask file [forget <name>|load|unload|log]')
  if (action === 'load') return { lines: [sys('ask: loading the model in this page...')], pending: later(modelOf(b).load()) }
  if (action === 'unload') return { lines: [], pending: later(modelOf(b).unload()) }
  if (action === 'log') {
    const log = modelOf(b).log().slice(-LOG_SHOWN)
    return { lines: log.length ? log.map(out) : [sys('ask: the runtime in this page has logged nothing yet')] }
  }
  return fail(`ask: no file command '${action}'`, 'usage: ask file [forget <name>|load|unload|log]')
}

/**
 * `run <skill>[,<skill>...]: <script>`: the skills are the words before the first colon, when those are only skill-like
 * words and commas (a script's own colon comes later: "run rust: ({ a: 1 })"), then the script. Null when the line
 * names no skill ("run 1 + 1", "run ({ a: 1 })", "run a ? b : c").
 */
function runIntent(rest: string): { skills: string[]; script: string } | null {
  const m = /^([A-Za-z][\w+#-]*(?:[ \t]*,[ \t]*[A-Za-z][\w+#-]*)*)[ \t]*:([\s\S]*)$/.exec(rest)
  return m ? { skills: m[1].split(',').map((s) => s.trim()), script: m[2].trim() } : null
}

/** The tuning tables as ['physics.car.power', '1'] rows, or null if they are not the expected shape. */
function tableRows(tables: unknown): [string, string][] | null {
  if (typeof tables !== 'object' || tables === null) return null
  const rows: [string, string][] = []
  for (const ns of ['physics', 'shaders'] as const) {
    const table = (tables as Record<string, unknown>)[ns]
    if (typeof table !== 'object' || table === null) return null
    for (const [k, v] of Object.entries(table)) rows.push([`${ns}.${k}`, typeof v === 'string' ? v : JSON.stringify(v)])
  }
  return rows
}

/**
 * Splits a line the way ash does for plain words: blanks separate words, '…' is literal, "…" honours
 * \" and \\, a bare backslash escapes the next character. Null on an unterminated quote.
 */
function tokenize(line: string): string[] | null {
  const words: string[] = []
  let word = ''
  let inWord = false
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = ''
      else word += c
    } else if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) word += line[++i]
      else word += c
    } else if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      word += line[++i]
      inWord = true
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (inWord) words.push(word)
      word = ''
      inWord = false
    } else {
      word += c
      inWord = true
    }
  }
  if (quote) return null
  if (inWord) words.push(word)
  return words
}

type Handler = (args: string[], b: TerminalBridge, history: readonly string[], line: string, session: ReplSession | null) => CommandResult

/** Commands that take no arguments reject stray ones instead of silently ignoring them. */
const bare = (name: Name, fn: (b: TerminalBridge, history: readonly string[], line: string) => CommandResult): Handler =>
  (args, b, history, line) => (args.length ? fail(`${name}: unexpected argument '${args[0]}'`, usage(name)) : fn(b, history, line))

/** A one-knob on|off command (ghost, rain, render, captions): the status alone, or the knob set; anything else is refused before the bridge. */
const knob = (name: Name, fn: (b: TerminalBridge, arg: 'on' | 'off' | undefined) => string): Handler => (args, b) => {
  if (args.length > 1) return fail(usage(name))
  if (args.length && args[0] !== 'on' && args[0] !== 'off') return fail(`${name}: invalid argument '${args[0]}'`, usage(name))
  return { lines: [out(fn(b, args[0] as 'on' | 'off' | undefined))] }
}

const HANDLERS: Record<Name, Handler> = {
  help(args) {
    if (args.length > 1) return fail(usage('help'))
    if (args.length === 1) {
      const c = COMMANDS.find((x) => x.name === args[0])
      return c ? { lines: [out(`usage: ${c.usage}`), out(`  ${c.summary}`)] } : fail(`help: no help for '${args[0]}'`)
    }
    const width = Math.max(...COMMANDS.map((c) => c.usage.length)) + 2
    const entry = (c: { usage: string; summary: string }) => out(`  ${c.usage.padEnd(width)}${c.summary}`)
    return {
      lines: [
        sys('Ring-0 commands: observe and tune through the bridge; only recruit reaches a pedestrian, and only to ask them over (or to a pinged point).'),
        ...CORE.map(entry),
        sys("Ring-0 operator (after 'operator unlock'): scripts, tuning and harnesses over the simulation; the laws stay in force."),
        ...OPERATOR.map(entry),
        sys('keys: Tab complete  Up/Down history  Shift+Enter new line  Ctrl+C stop live view  Ctrl+L clear  PgUp/PgDn scroll'),
      ],
    }
  },

  stats(args, b) {
    for (const a of args) if (a !== '--once') return fail(`stats: unrecognized option '${a}'`, usage('stats'))
    const lines = formatStats(b.stats()).map(out)
    return args.length ? { lines } : { lines, live: (bridge) => formatStats(bridge.stats()) }
  },

  // The unified namespace, read-only: the bridge formats every row (the console imports nothing of the bus).
  topic(args, b) {
    const t = topicsOf(b)
    const a = args[0]
    if (a === undefined) return { lines: [out(t.status()), ...t.children().map(out)] }
    if (args.length > 2) return fail(usage('topic'))
    const arg = args[1]
    if (a === 'list') {
      const rows = t.list(arg)
      return { lines: rows.length ? rows.map(out) : [sys(`topic: nothing retained matches '${arg ?? '#'}'`)] }
    }
    if (a === 'get') {
      if (arg === undefined) return fail('usage: topic get <topic>')
      const row = t.get(arg)
      return row === null ? fail(`topic: no topic '${arg}'`) : { lines: [out(row)] }
    }
    if (a === 'tree') {
      const rows = t.children(arg)
      return { lines: rows.length ? rows.map(out) : [sys(`topic: nothing under '${arg ?? '~'}'`)] }
    }
    if (a === 'watch') {
      const frame: LiveFrame = (bridge) => {
        const rows = topicsOf(bridge).list(arg)
        return rows.length ? rows : [`(nothing retained matches '${arg ?? '#'}')`]
      }
      return { lines: frame(b).map(out), live: frame }
    }
    return fail(`topic: unknown action '${a}'`, usage('topic'))
  },

  laws: bare('laws', (b) => {
    const lines: Line[] = []
    for (const l of b.laws()) lines.push(out(`${l.id}. ${l.title}`), out(`   ${l.text}`))
    lines.push(sys('Ranked: a lower law never overrides a higher one.'))
    return { lines }
  }),

  kernel: bare('kernel', (b) => {
    const st = b.stats()
    const k = st.kernel
    const counts = [0, k.law1, k.law2, k.law3]
    const laws = b.laws()
    const width = Math.max(0, ...laws.map((l) => l.title.length)) + 2
    return {
      lines: [
        out(`LAW  ${'TITLE'.padEnd(width)}INTERVENTIONS`),
        ...laws.map((l) => out(`${String(l.id).padEnd(5)}${l.title.padEnd(width)}${count(counts[l.id] ?? NaN)}`)),
        out(`Solid->Sensor flips ${count(k.sensorFlips)}  shielded ${k.shielded ? 'yes' : 'no'}`),
        out(`last ${k.last || '-'}`),
        out(`Ring-0 audit  ${auditLine(k.audit)}`),
        ...(st.sensing
          ? [out(`pedestrian sensing  physics worker GPU  reading ${st.sensing.ageMs === null ? '-' : `${Math.round(st.sensing.ageMs)} ms`} old  round trip ${Math.round(st.sensing.lagMs)} ms`)]
          : []),
      ],
    }
  }),

  quality(args, b) {
    if (args.length > 1) return fail(usage('quality'))
    if (!args.length) return { lines: [out(formatQuality(b.quality()))] }
    const a = args[0]
    if (a === 'auto') return { lines: [out(formatQuality(b.quality('auto')))] }
    if (a === 'lite') return { lines: [out(formatQuality(b.quality(MIN_TIER)))] }
    if (a === 'peak') return { lines: [out(formatQuality(b.quality(MAX_TIER)))] }
    if (/^(?:-1|\d)$/.test(a) && Number(a) >= MIN_TIER && Number(a) <= MAX_TIER) return { lines: [out(formatQuality(b.quality(Number(a))))] }
    return fail(`quality: invalid tier '${a}'`, usage('quality'))
  },

  time(args, b) {
    if (args.length > 1) return fail(usage('time'))
    if (!args.length) return { lines: [out(b.clock())] }
    const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(args[0])
    const hh = m ? Number(m[1]) : NaN
    const mm = m?.[2] ? Number(m[2]) : 0
    if (!m || hh > 23 || mm > 59) return fail(`time: invalid time '${args[0]}'`, usage('time'))
    b.setClock(hh + mm / 60)
    return { lines: [out(b.clock())] }
  },

  audio(args, b) {
    if (args.length > 1) return fail(usage('audio'))
    if (!args.length) return { lines: [out(b.audio())] }
    const a = args[0]
    if (a === 'on' || a === 'off') return { lines: [out(b.audio(a))] }
    const m = /^(\d{1,3})%?$/.exec(a)
    if (m && Number(m[1]) <= 100) return { lines: [out(b.audio(Number(m[1])))] }
    return fail(`audio: invalid argument '${a}'`, usage('audio'))
  },

  ghost: knob('ghost', (b, arg) => `ghost view ${b.ghost(arg)}`),

  rain: knob('rain', (b, arg) => `rain ${b.rain(arg)}`),

  render: knob('render', (b, arg) => `render ${b.render(arg)}`),

  captions: knob('captions', (b, arg) => b.captions(arg)),

  // View-only: a mark on the board where the head looks (cued, captioned, on the minimap). A walk ping (go, gather)
  // is offered to the host's recruiter by the engine, as a request the physics worker re-checks; nothing moves here.
  ping(args, b) {
    if (args.length > 1) return fail(usage('ping'))
    const a = args[0]
    if (a === undefined) {
      const lines = b.ping.list()
      return { lines: lines.length ? lines.map(out) : [sys('ping: nothing is pinged (ping go|look|gather|wait marks where you look; Q)')] }
    }
    if (a === 'clear') {
      const n = b.ping.clear()
      return { lines: [out(n ? `ping: ${n} ${n === 1 ? 'mark' : 'marks'} cleared` : 'ping: nothing to clear')] }
    }
    const kind = PING_KINDS.find((k) => k === a)
    if (!kind) return fail(`ping: unknown kind '${a}'`, usage('ping'))
    const pick = b.ping.at(kind)
    if (!pick) return fail('ping: nothing within reach where you look (or less than half a second since the last ping)')
    return { lines: [out(`ping: ${PING_WORDS[kind]}: ${pickText(pick)}`)] }
  },

  // The player's own look (the host keeps it between visits); `show <agent>` reads what a pedestrian wears.
  look(args, b) {
    const l = lookOf(b)
    const a = args[0] ?? 'show'
    if (a === 'show') {
      if (args.length > 2) return fail(usage('look'))
      if (args.length < 2) return { lines: l.show().map(out) }
      const agent = agentOf(args[1])
      return agent === null ? fail(`look: not a pedestrian's number: '${args[1]}'`, usage('look')) : { lines: l.show(agent).map(out) }
    }
    const change = lookChange(a, args.slice(1))
    if (typeof change === 'string') return fail(change)
    return { lines: l.set(change).map(out) }
  },

  /** The roster (08_Swarm/roster.ts). A raw line: names and roles keep their spaces. */
  agent(args, b) {
    const a = rosterOf(b)
    const rest = (args[0] ?? '').trim()
    if (!rest) return { lines: a.list().map(out) }
    if (rest === 'voices') return { lines: [sys('voice profiles (the browser tier shapes a voice with them; a provider voice is named instead):'), ...a.voices().map(out)] }
    const m = /^(\S+)\s+(\S+)(?:\s+([\s\S]*))?$/.exec(rest)
    if (!m) return fail(usage('agent'))
    const [, first, second, tail = ''] = m
    const value = tail.trim()
    try {
      if (first === 'new') return value ? fail(usage('agent')) : { lines: a.add(second).map(out) }
      if (first === 'dismiss') return value ? fail(usage('agent')) : { lines: [out(`agent: ${a.dismiss(second)}`)] }
      if (first === 'forget') return value ? fail(usage('agent')) : { lines: [out(`agent: ${a.forget(second)}`)] }
      if (first === 'hire') {
        const skills = b.recruit?.skills() ?? []
        const skill = value || skills[0] || ''
        if (!skill) return fail('agent: name a skill to hire with: agent hire <name> <skill>')
        if (value && skills.length && !skills.some((k) => k.toLowerCase() === value.toLowerCase())) return fail(`agent: unknown skill '${value}': ${skills.join(', ')}`)
        const pending = a.hire(second, skill).then((t) => [out(`agent: ${t}`)], (e: unknown) => [err(`agent: ${message(e)}`)])
        return { lines: [sys(`agent: asking someone with ${skill} over as ${second}...`)], pending }
      }
      // agent <name> <field> <value...>
      if (!isAgentField(second)) return fail(`agent: nothing to set called '${second}': ${AGENT_FIELDS.join(', ')}`, usage('agent'))
      if (!value) return fail(`usage: agent <name> ${second} <${second === 'pronouns' ? PRONOUN_WORDS : second === 'voice' ? 'profile|provider voice> (agent voices lists the profiles' : second === 'look' ? 'code|none' : 'value'}>`)
      return { lines: a.set(first, second, value).map(out) }
    } catch (e) {
      return fail(`agent: ${message(e)}`)
    }
  },

  /** Sloane's spoken voice (onboarding/speaker.ts). A raw line: a voice name or a line to say keeps its spaces. */
  sloane(args, b) {
    const c = conciergeOf(b)
    const rest = (args[0] ?? '').trim()
    if (!rest) return { lines: c.status().map(out) }
    if (rest === 'on' || rest === 'off') return { lines: [out(`sloane: ${c.on(rest === 'on')}`)] }
    if (rest === 'voices') return { lines: c.voices().map(out) }
    const m = /^(voice|say)(?:\s+([\s\S]*))?$/.exec(rest)
    if (!m) return fail(usage('sloane'))
    const value = (m[2] ?? '').trim()
    if (m[1] === 'voice') return { lines: [out(row('voice', c.voice(value)))] }
    if (!value) return fail('usage: sloane say <text...>')
    const pending = c.say(value).then((t) => [sys(`sloane: ${t}`)], (e: unknown) => [err(`sloane: ${message(e)}`)])
    return { lines: [], pending }
  },

  /** A goal in plain words: the host plans it as Sloane would (06_Make_Decisions/intent.ts) and applies what it can now. */
  goal(args, b) {
    const text = (args[0] ?? '').trim()
    if (!text) return fail(usage('goal'))
    if (text.length > GOAL_CHARS) return fail(`goal: at most ${GOAL_CHARS} characters`)
    if (!b.goal) return fail('goal: not available on this bridge')
    let plan: GoalPlan
    try {
      plan = b.goal(text)
    } catch (e) {
      return fail(`goal: ${message(e)}`)
    }
    const lines: Line[] = plan.steps.map((st) => (st.state === 'failed' ? err(`  failed   ${st.label}${st.detail ? `: ${st.detail}` : ''}`) : out(`  ${st.state.padEnd(8)} ${st.label}`)))
    for (const n of plan.notes) lines.push(sys(`  ${n}`))
    if (!lines.length) lines.push(sys('  nothing in the city maps to that yet'))
    const done = plan.steps.some((st) => st.state === 'done')
    return { lines: [out(plan.root), ...lines, ...(!done && plan.steps.length ? [sys('  nothing could be done now: the rest needs the operator, or a restart')] : [])] }
  },

  hal(args, b) {
    if (!args.length) {
      const devices = b.hal.devices()
      // The bus summary is '' while nothing is attached.
      const summary = b.hal.summary()
      const lines = summary ? [out(summary)] : []
      if (devices.length) lines.push(out(`  ${'BUS'.padEnd(10)}${'STATE'.padEnd(13)}DEVICE`), ...devices.map((d) => out(formatDevice(d))))
      else lines.push(sys('no devices; pair one with: hal pair hid|serial|ble'))
      return { lines }
    }
    if (args[0] !== 'pair') return fail(`hal: unknown command '${args[0]}'`, usage('hal'))
    if (args.length !== 2) return fail(usage('hal'))
    const kind = Object.hasOwn(PAIR_KINDS, args[1]) ? PAIR_KINDS[args[1]] : undefined
    if (!kind) return fail(`hal: unknown bus '${args[1]}'`, usage('hal'))
    // Called synchronously: the browser only shows its device picker inside the Enter keydown's user activation.
    // The bus resolves a device in state 'error' (API missing, request refused) rather than rejecting. Inside the
    // Windows app the shell lists the controllers itself and shows no picker (nativeHid.ts): said so.
    const shell = kind === 'hid' && b.hal.shellHid === true
    const pending = Promise.resolve(b.hal.pair(kind)).then(
      (d): Line[] => (!d ? [sys(shell ? 'hal: no controller plugged in or paired' : 'hal: no device selected')]
        : d.state === 'error' ? [err(`hal: pair failed: ${d.detail || d.name}`)]
        : [out(`hal: ${d.name} ${d.state} (${d.transport}${d.detail ? `, ${d.detail}` : ''})`)]),
      (e: unknown): Line[] => [err(`hal: pair failed: ${message(e)}`)],
    )
    return { lines: [sys(shell ? 'hal: asking the app for its controllers...' : `hal: waiting for the browser's ${kind} device picker...`)], pending }
  },

  memory(args, b) {
    const m = memoryOf(b)
    const lines = (p: Promise<string[]>, prefix = ''): CommandResult => ({
      lines: [],
      pending: p.then((t) => t.map((l) => out(prefix + l)), (e: unknown): Line[] => [err(`memory: ${message(e)}`)]),
    })
    if (!args.length) return lines(m.status())
    const agent = (a: string): number | null => (/^\d{1,9}$/.test(a) ? Number(a) : null)
    if (args.length === 1) {
      const n = agent(args[0])
      return n === null ? fail(`memory: not a pedestrian's number: '${args[0]}'`, usage('memory')) : lines(m.ledger(n))
    }
    if (args.length === 2 && args[0] === 'forget') {
      // Reading reaches nobody; erasing is for good, so it is the operator's, like every other change.
      if (!operatorOf(b).unlocked()) return locked('memory')
      const which = args[1] === 'all' ? 'all' : agent(args[1])
      if (which === null) return fail(`memory: not a pedestrian's number: '${args[1]}'`, usage('memory'))
      return { lines: [], pending: m.forget(which).then((t) => [out(`memory: ${t}`)], (e: unknown): Line[] => [err(`memory: ${message(e)}`)]) }
    }
    return fail(usage('memory'))
  },

  recruit(args, b) {
    const r = recruitOf(b)
    if (!args.length) return { lines: r.status().map(out) }
    const a = args[0]
    const line = (p: Promise<string>): Promise<Line[]> => p.then((t) => [out(`recruit: ${t}`)], (e: unknown) => [err(`recruit: ${message(e)}`)])
    if (args.length === 1 && a === 'listen') {
      // Called synchronously: the browser only asks for the microphone inside the Enter keydown's user activation.
      return { lines: [sys('recruit: opening the microphone (on-device recognition only)...')], pending: line(r.listen()) }
    }
    if (args.length === 1 && a === 'install') {
      return { lines: [sys("recruit: asking the browser to install its on-device speech model (the one download)...")], pending: line(r.install()) }
    }
    if (args.length === 1 && a === 'stop') return { lines: [out(`recruit: ${r.stop()}`)] }
    if (args.length === 1 && a === 'dismiss') return { lines: [out(`recruit: ${r.dismiss()}`)] }
    if (a === 'rally') {
      // An Active recruit to a sidewalk point: the newest ping's, or one typed. The page checks its copy, the worker decides.
      if (args.length !== 2 && args.length !== 4) return fail(usage('recruit'))
      const agent = agentOf(args[1])
      if (agent === null) return fail(`recruit: not a pedestrian's number: '${args[1]}'`, usage('recruit'))
      let x: number, z: number
      if (args.length === 4) {
        if (!NUMBER.test(args[2]) || !NUMBER.test(args[3])) return fail(`recruit: not a point: '${args[2]} ${args[3]}'`, usage('recruit'))
        x = Number(args[2])
        z = Number(args[3])
      } else {
        const p = b.ping.newest()
        if (!p) return fail('recruit: nothing is pinged: ping go where they should stand first (Q), or give a point: recruit rally <agent> <x> <z>')
        x = p.x
        z = p.z
      }
      const pending = r.rally(agent, x, z).then(
        (o): Line[] => [o.ok ? out(`recruit: ${o.message}`) : err(`recruit: ${o.message}`)],
        (e: unknown): Line[] => [err(`recruit: ${message(e)}`)],
      )
      return { lines: [sys(`recruit: asking agent ${agent} to walk to (${fixed(x, 1)}, ${fixed(z, 1)})...`)], pending }
    }
    const skill = args.join(' ')
    const pending = r.ask(skill).then(
      (o): Line[] => [o.ok ? out(`recruit: ${o.message}`) : err(`recruit: ${o.message}`)],
      (e: unknown): Line[] => [err(`recruit: ${message(e)}`)],
    )
    return { lines: [sys(`recruit: asking for ${skill}...`)], pending }
  },

  clear: bare('clear', () => ({ lines: [], clear: true })),

  // The terminal stores a line only when it differs from the previous one; number the list the same way.
  history: bare('history', (_b, history, line) => ({
    lines: (history[history.length - 1] === line ? history : [...history, line])
      .map((h, i) => out(`${String(i + 1).padStart(5)}  ${h.replace(/\n/g, '\n       ')}`)),
  })),

  echo(args) {
    return { lines: [out(args.join(' '))] }
  },

  uname(args, b) {
    const { name, host, version } = b.brand
    const all = 'snrvmi'
    let picked = ''
    for (const a of args) {
      if (!a.startsWith('-') || a.length < 2) return fail(`uname: extra operand '${a}'`, usage('uname'))
      for (const f of a.slice(1)) {
        if (f === 'a') picked = all
        else if (all.includes(f)) picked += f
        else return fail(`uname: unrecognized option: ${f}`, usage('uname'))
      }
    }
    const field: Record<string, () => string> = {
      s: () => name, n: () => host, r: () => version, v: () => '#1 Ring-0', m: () => 'webgpu', i: () => b.adapter() || 'unknown',
    }
    // Fields print in canonical order, each once, whatever order the flags came in.
    const text = [...(picked || 's')].filter((f, i, xs) => xs.indexOf(f) === i).sort((x, y) => all.indexOf(x) - all.indexOf(y))
    return { lines: [out(text.map((f) => field[f]()).join(' '))] }
  },

  whoami: bare('whoami', () => ({ lines: [out('root')] })),

  version: bare('version', (b) => ({ lines: [out(`${b.brand.name} ${b.brand.version} (Ring-0)`)] })),

  exit(args) {
    if (args.length > 1 || (args.length === 1 && !/^\d{1,3}$/.test(args[0]))) return fail(usage('exit'))
    return { lines: [], close: true }
  },

  // The track comes from the brand (the host that mounted the console); a switch is a reload the host performs.
  boot(args, b) {
    if (args.length > 1) return fail(usage('boot'))
    const track = b.brand.track ?? 'gui'
    const a = args[0] ?? 'status'
    if (a === 'status') {
      return { lines: [out(track === 'tty' ? 'boot: tty (Track B: this console alone, no 3D engine; boot gui for the city)' : 'boot: gui (Track A: the city; boot tty for this console alone)')] }
    }
    if (a !== 'gui' && a !== 'tty') return fail(`boot: unknown track '${a}'`, usage('boot'))
    if (a === track) return { lines: [sys(`boot: already on ${a}`)] }
    return { lines: [sys(a === 'tty' ? 'booting tty: reloading as this console alone (no 3D engine)...' : 'booting gui: reloading as the city...')], boot: a }
  },

  /** Which map the city shell walks; a change is a reload (App.tsx remap), like `boot`: the engine is built for one map. */
  map(args, b) {
    const a = args[0]
    const current = b.brand.map
    const described: Record<'city' | 'lakefront' | 'region', string> = {
      city: 'city (the procedural city: people and traffic)',
      lakefront: 'lakefront (the generated metropolis: people, traffic and indoor workplaces in the 16 blocks round where you start)',
      region: 'region (the embedded surveyed map: no people or traffic)',
    }
    if (a === undefined || a === 'status') {
      if (b.brand.track === 'tty' || current === undefined) return { lines: [out('map: none (this console alone; boot gui walks a map)')] }
      return { lines: [out(`map: ${described[current]}`)] }
    }
    if (a === 'default') return { lines: [sys('map: choice forgotten; reloading on the default map...')], map: 'default' }
    if (a !== 'city' && a !== 'lakefront') return fail(`map: unknown map '${a}'`, usage('map'))
    if (a === current) return { lines: [sys(`map: already on ${a}`)] }
    return { lines: [sys(a === 'city' ? 'map city: reloading into the procedural city (people and traffic)...' : 'map lakefront: reloading into the metropolis...')], map: a }
  },

  // Raw: the rest of the line is an R0 line for the session's machine. No bridge is touched: the machine is blind.
  r0(args, _b, _history, _line, session) {
    const rest = args[0] ?? ''
    if (!rest) return { lines: [out(usage('r0')), sys("the console's own stack machine: 'r0 1 2 + .' prints 3; ': sq dup * ;' defines sq for this console session")] }
    const m = (session ?? replSession()).machine
    if (rest === 'reset') {
      m.reset()
      return { lines: [out('r0: reset (every definition forgotten, memory zeroed)')] }
    }
    if (rest === 'words') return { lines: [out(m.words().join(' '))] }
    const r = m.run(rest)
    // `.` prints a number and a blank, as the language does; a line's trailing blanks are invisible here, so they go.
    const lines = r.out.map((t) => out(t.replace(/ +$/, '')))
    if (r.error !== undefined) lines.push(err(`r0: ${r.error}`))
    if (r.steps >= R0_NOTE_STEPS) lines.push(sys(`-- ${r.steps} steps --`))
    return { lines }
  },

  // ---- the operator tier ----

  operator(args, b) {
    if (args.length > 1) return fail(usage('operator'))
    const op = operatorOf(b)
    const a = args[0] ?? 'status'
    if (a === 'status') return { lines: [out(op.unlocked() ? 'operator: unlocked' : "operator: locked (type 'operator unlock')")] }
    if (a === 'lock') {
      // Read before the lock: the tier withdraws a waiting proposal as it locks (no proposal waits past a lock), so the
      // console says which one went.
      const waiting = op.acts.pending()
      op.lock()
      return { lines: waiting ? [out('operator: locked'), sys(`act ${waiting.seq}: withdrawn: the operator tier is locked`)] : [out('operator: locked')] }
    }
    if (a !== 'unlock') return fail(`operator: unknown command '${a}'`, usage('operator'))
    if (op.unlocked()) return { lines: [sys('operator: already unlocked')] }
    op.unlock()
    return {
      lines: [
        out('Ring-0 operator tier unlocked.'),
        out('Granted: run <skill>: <js> against sim.* (clock, quality, avatar, vehicles, physics and shader tuning,'),
        out('         crowd culling, kernel readouts, the HUD snapshot) while someone tethered to you has the skill;'),
        out('         ask <skill>: <prompt> of the local model, answered as them; say <skill>: <text> aloud, in their'),
        out('         voice, from where they stand; get/set tuning keys; harness run <name>.'),
        out('Still in force: the three laws (every vehicle intent is vetted by the kernel), the Sanctuary'),
        out('(Solid->Sensor on contact) and the crowd safety nudge. Scripts cannot reach or alter any of them.'),
        sys("Type 'api' for the script API, 'harness list' for the harnesses, 'operator lock' to close the tier."),
      ],
    }
  },

  // Raw: args[0] is the rest of the line, quotes and newlines intact: the skills the script needs, a colon, the script.
  // The gateway decides at once. Authorized says who the script is bound to now; its output, or the abort that stops
  // it when that tether breaks, follows. Rejected never ran.
  run(args, b) {
    const op = operatorOf(b)
    if (!op.unlocked()) return locked('run')
    const intent = runIntent(args[0] ?? '')
    if (!intent) return fail('run: name the skill the script needs first, e.g. run rust: sim.physics.tune()', usage('run'))
    if (!intent.script) return fail(usage('run'))
    const r = op.exec(intent.skills, intent.script)
    const pending = Promise.resolve(r.result).then(runLines, (e: unknown): Line[] => [err(`run: ${message(e)}`)])
    return { lines: r.state === 'Authorized' ? [sys(`run: Authorized: bound to ${r.bound.map(tetherText).join(' and ')}`)] : [], pending }
  },

  // Raw, like run: the skills the answer needs, a colon, then the prompt (quotes and newlines kept). Alone, it reports
  // the local model server; `model <name>` and `server <url>` set it up; `stop` stops the answer being generated.
  // `file` and `gpu` come first, before the lock: they keep a model file in this page or a setting, and send no prompt.
  ask(args, b) {
    const rest = args[0] ?? ''
    const file = /^file(?:\s+(\S+)(?:\s+([\s\S]*))?)?\s*$/.exec(rest)
    if (file) return askFile(b, file[1], (file[2] ?? '').trim())
    const gpu = /^gpu(?:\s+([\s\S]*))?$/.exec(rest)
    if (gpu) {
      const mode = (gpu[1] ?? '').trim().toLowerCase()
      if (!mode) return fail('usage: ask gpu <auto|on|off>')
      if (!isGpuMode(mode)) return fail('ask: ask gpu takes auto, on or off')
      return { lines: [out(row('gpu', modelOf(b).gpu(mode)))] }
    }
    const op = operatorOf(b)
    if (!op.unlocked()) return locked('ask')
    if (!rest) return { lines: [], pending: Promise.resolve(op.askStatus()).then(mindLines, (e: unknown): Line[] => [err(`ask: ${message(e)}`)]) }
    if (rest === 'stop') return { lines: [out(`ask: ${op.askStop()}`)] }
    // One line for a provider and its address (and the Claude provider's key): the router checks everything before it changes anything.
    const connect = /^connect(?:\s+(\S+))?(?:\s+(\S+))?(?:\s+(\S+))?\s*$/.exec(rest)
    if (connect) {
      if (!connect[1]) return fail(`usage: ask connect <${PROVIDER_ARGS.join('|')}> [<url>] [<key>]`)
      return { lines: [out(row('provider', op.askConnect(connect[1], connect[2], connect[3])))] }
    }
    const set = /^(model|server|think|api|provider|key|effort)(?:\s+([\s\S]*))?$/.exec(rest)
    if (set) {
      const key = set[1] as 'model' | 'server' | 'think' | 'api' | 'provider' | 'key' | 'effort'
      const value = (set[2] ?? '').trim()
      const takes = { model: 'name', server: 'url', api: 'generate|chat', think: 'on|off', provider: PROVIDER_ARGS.join('|'), key: 'key|none', effort: 'low|medium|high|xhigh|max|none' }[key]
      if (!value) return fail(`usage: ask ${key} <${takes}>`)
      return { lines: [out(row(key, op.askSet(key, value)))] }
    }
    const intent = runIntent(rest)
    if (!intent) return fail('ask: name the skill the answer needs first, e.g. ask rust: how does car.grip work?', usage('ask'))
    if (!intent.script) return fail(usage('ask'))
    const a = op.ask(intent.skills, intent.script)
    // Said aloud as well (say auto on): the answer stays on screen as it streamed until the speech is over.
    const pending = Promise.resolve(a.result).then(
      async (r): Promise<Line[]> => (r.speech ? [...askLines(r), ...sayLines(await r.speech)] : askLines(r)),
      (e: unknown): Line[] => [err(`ask: ${message(e)}`)],
    )
    if (a.state !== 'Authorized') return { lines: [], pending }
    return { lines: [sys(`ask: Authorized: bound to ${a.bound.map(tetherText).join(' and ')}`)], pending, stream: { subscribe: (fn) => a.follow(fn) } }
  },

  // Raw, like ask: the skills the speech needs, a colon, then the text. Alone, it reports the local speech server;
  // `voice`, `model`, `server` and `auto` set it up; `stop` cuts off whatever is being said.
  say(args, b) {
    const op = operatorOf(b)
    if (!op.unlocked()) return locked('say')
    const rest = args[0] ?? ''
    if (!rest) return { lines: [], pending: Promise.resolve(op.sayStatus()).then(voiceLines, (e: unknown): Line[] => [err(`say: ${message(e)}`)]) }
    if (rest === 'stop') return { lines: [out(`say: ${op.sayStop()}`)] }
    const set = /^(voice|model|server|auto|provider|key)(?:\s+([\s\S]*))?$/.exec(rest)
    if (set) {
      const key = set[1] as 'voice' | 'model' | 'server' | 'auto' | 'provider' | 'key'
      const value = (set[2] ?? '').trim()
      if (!value) return fail(`usage: say ${key} <${key === 'server' ? 'url' : key === 'auto' ? 'on|off' : key === 'provider' ? 'local|elevenlabs' : key === 'key' ? 'key|none' : 'name'}>`)
      return { lines: [out(row(key, op.saySet(key, value)))] }
    }
    const intent = runIntent(rest)
    if (!intent) return fail('say: name the skill of whoever should say it first, e.g. say rust: over here', usage('say'))
    if (!intent.script) return fail(usage('say'))
    const r = op.say(intent.skills, intent.script)
    const pending = Promise.resolve(r.result).then(sayLines, (e: unknown): Line[] => [err(`say: ${message(e)}`)])
    return { lines: r.state === 'Authorized' ? [sys(`say: Authorized: said by ${tetherText(r.bound[0])}`)] : [], pending }
  },

  // Raw: `run`/`plan` keep the goal as typed (after an optional --agents N). The orchestrator decides each step through
  // the same gate as `ask`; the console shows each step's answer live, then the report, and `swarm audit` the chain.
  swarm(args, b) {
    const op = operatorOf(b)
    if (!op.unlocked()) return locked('swarm')
    const rest = (args[0] ?? '').trim()
    const sw = op.swarm
    if (!rest || rest === 'status') return { lines: swarmStatusLines(sw.status()) }
    if (rest === 'stop') return { lines: [out(`swarm: ${sw.stop()}`)] }
    if (rest === 'roles') {
      const width = Math.max(...sw.roles.map((r) => r.title.length)) + 2
      return { lines: [sys('The roles, in the order they are rallied; each step is answered by someone tethered to you with the skill:'), ...sw.roles.map((r) => out(`  ${r.title.padEnd(width)}${r.skill.padEnd(12)}${r.brief.split('. ')[1] ?? ''}`))] }
    }
    if (rest === 'guardrails') {
      const q = sw.quota
      return {
        lines: [
          sys('Every step passes these before a model is asked and after it answers; a failure ends the run and is written to the audit trail:'),
          ...INVARIANT_LINES.map(([name, text]) => out(`  ${name.padEnd(22)}${text}`)),
          sys(`quota: ${q.agents} roles, ${q.steps} steps, a goal of ${q.goalChars} characters, a prompt of ${q.promptChars}, an answer of ${q.answerChars}, ${q.tokens} tokens a run`),
          sys('These are rules over text, settings and counts, applied the same way every time; they are not a proof about a model, and no model ships to inspect.'),
        ],
      }
    }
    const audit = /^audit(?:\s+(verify))?$/.exec(rest)
    if (audit) return { lines: auditLines(sw.audit(), sw.verify(), 'swarm: no audit entries yet (swarm run <goal> writes them)') }
    const m = /^(run|plan)(?:\s+--agents\s+(\S+))?(?:\s+([\s\S]*))?$/.exec(rest)
    if (!m) return fail(`swarm: unknown command '${rest.split(/\s+/)[0]}'`, usage('swarm'))
    const agents = m[2] === undefined ? undefined : Number(m[2])
    if (agents !== undefined && !Number.isInteger(agents)) return fail(`swarm: --agents takes a whole number, not '${m[2]}'`)
    const goal = (m[3] ?? '').trim()
    // A flag the pattern above did not take (`--agents` with no number, `--agents=2`, or after the goal) is a typo, not
    // part of the goal: a run on it would send every role a prompt about the flag.
    if (/(?:^|\s)--agents(?:[=\s]|$)/.test(goal)) return fail(`swarm: --agents takes a whole number and goes before the goal: swarm ${m[1]} --agents <1-5> <goal...>`)
    if (!goal) return fail(`usage: swarm ${m[1]} [--agents <1-5>] <goal...>`)
    if (m[1] === 'plan') {
      const plan = sw.plan(goal, agents)
      return { lines: [sys(`swarm plan: ${plan.agents} role${plan.agents === 1 ? '' : 's'} for "${plan.goal}"`), ...plan.steps.map((st) => { const r = sw.roles.find((x) => x.id === st.role)!; return out(`  ${st.id.padEnd(10)}${r.title.padEnd(22)}needs ${r.skill.padEnd(12)}${st.needs.length ? `after ${st.needs.join(', ')}` : 'first'}`) }), sys('swarm run runs it: each step is one gated prompt, answered by someone tethered to you with that skill.')] }
    }
    const run = sw.run(goal, agents)
    const pending = run.result.then(swarmReportLines, (e: unknown): Line[] => [err(`swarm: ${message(e)}`)])
    const stream: TextStream = {
      subscribe: (fn) => run.follow((ev) => {
        if (ev.kind === 'piece') fn(ev.piece)
        else if (ev.kind === 'step' && ev.step.state === 'answered') fn({ kind: 'text', text: '\n' })
      }),
    }
    const first = run.plan.steps[0]
    const role = sw.roles.find((r) => r.id === first.role)!
    return { lines: [sys(`swarm: ${run.plan.agents} role${run.plan.agents === 1 ? '' : 's'} for "${run.plan.goal}"; first the ${role.title} (${role.skill})`)], pending, stream }
  },

  // A city action an agent proposed at the end of an answer (acts.ts, one at a time): alone, what waits for the OK;
  // `ok` lets the tier run it once under the proposer's lease and prints how it ended, `no` refuses it (the proposer is
  // told next time); `log [verify]` prints the hash-chained trail of every proposal, decision and end, `list` the
  // catalogue. The reads work while locked (they change nothing); the two decisions do not. `y` and `n` alone stand for
  // `ok` and `no` while a proposal waits (run(), below).
  act(args, b) {
    if (args.length > 2 || (args.length === 2 && (args[0] !== 'log' || args[1] !== 'verify'))) return fail(usage('act'))
    const op = operatorOf(b)
    const acts = op.acts
    const a = args[0]
    if (a === undefined) {
      const p = acts.pending()
      if (!p) return { lines: [sys('act: nothing is waiting for your OK')] }
      return { lines: [out(`act ${p.seq}: waiting for your OK: ${p.who} proposes: ${p.sentence}${noteOf(p.note)}`), sys('  y allows it, n refuses it; it runs only while they stay tethered')] }
    }
    if (a === 'list') {
      // The offline bridge lists nothing (bridge.ts): the catalogue lives in the tier, so Track B says what the others say.
      const rows = acts.list()
      return rows.length ? { lines: rows.map(out) } : fail('act: engine not running')
    }
    if (a === 'log') return { lines: auditLines(acts.log(), acts.verify(), 'act: no entries yet (an ask that proposes an action writes them)') }
    if (a !== 'ok' && a !== 'no') return fail(`act: unknown command '${a}'`, usage('act'))
    if (!op.unlocked()) return locked('act')
    if (a === 'no') {
      const p = acts.refuse('console')
      return { lines: [sys(`act ${p.seq}: refused: ${p.sentence} (agent ${p.agent} is told next time)`)] }
    }
    // Allowed: the tier nulls the proposal and runs it once under the proposer's lease; the end follows as `pending`.
    const { act, result } = acts.allow('console')
    const pending = Promise.resolve(result).then((end) => actEndLines(act, end), (e: unknown): Line[] => [err(`act: ${message(e)}`)])
    return { lines: [sys(`act ${act.seq}: allowed: ${act.sentence}`)], pending }
  },

  api(args, b) {
    if (args.length > 1) return fail(usage('api'))
    const docs = operatorOf(b).api()
    if (!args.length) {
      return {
        lines: [
          sys('Script API: run <skill>: <js> with sim.* in scope, bound to someone tethered who has the skill; await is allowed; console output is captured.'),
          sys('An expression prints its value; a script of statements prints what it returns.'),
          ...docs.map((d) => out(`  ${d.signature}`)),
          sys("'api <path>' explains one branch, e.g. api vehicles"),
        ],
      }
    }
    const want = args[0].replace(/^sim\./, '')
    const hits = docs.filter((d) => {
      const p = d.path.replace(/^sim\./, '')
      return p === want || p.startsWith(`${want}.`)
    })
    if (!hits.length) return fail(`api: no member '${args[0]}'`)
    return { lines: hits.flatMap((d) => [out(d.signature), out(`    ${d.summary}`)]) }
  },

  get(args, b) {
    if (args.length > 1) return fail(usage('get'))
    const op = operatorOf(b)
    if (!op.unlocked()) return locked('get')
    const prefix = args[0] ?? ''
    const rows = tableRows(op.tuning())
    if (!rows) return fail('get: the tuning tables did not read back as expected')
    const hits = rows.filter(([k]) => k.startsWith(prefix))
    if (!hits.length) return fail(`get: no key matches '${prefix}'`)
    const width = Math.max(...hits.map(([k]) => k.length)) + 2
    return { lines: hits.map(([k, v]) => out(`${k.padEnd(width)}${v}`)) }
  },

  set(args, b) {
    if (args.length !== 2) return fail(usage('set'))
    const op = operatorOf(b)
    if (!op.unlocked()) return locked('set')
    const m = /^(physics|shaders)\.(.+)$/.exec(args[0])
    if (!m) return fail(`set: the path must be physics.<key> or shaders.<key>, not '${args[0]}'`, usage('set'))
    const value = Number(args[1])
    if (args[1].trim() === '' || !Number.isFinite(value)) return fail(`set: the value must be a number, not '${args[1]}'`)
    const now = op.tune(m[1] as 'physics' | 'shaders', m[2], value)
    return { lines: [out(`${args[0]} = ${now}`)] }
  },

  harness(args, b) {
    const op = operatorOf(b)
    const a = args[0] ?? 'list'
    if (a === 'list') {
      if (args.length > 1) return fail(usage('harness'))
      const list = op.harnesses()
      const width = Math.max(0, ...list.map((h) => h.name.length)) + 2
      return { lines: [...list.map((h) => out(`  ${h.name.padEnd(width)}${h.summary}`)), sys("'harness run <name>' runs one (operator unlock first)")] }
    }
    if (a !== 'run') return fail(`harness: unknown command '${a}'`, usage('harness'))
    if (args.length !== 2) return fail(usage('harness'))
    if (!op.unlocked()) return locked('harness')
    const name = args[1]
    const known = op.harnesses().map((h) => h.name)
    if (!known.includes(name)) return fail(`harness: unknown '${name}'`, `harnesses: ${known.join(', ')}`)
    const pending = Promise.resolve(op.harness(name)).then(reportLines, (e: unknown): Line[] => [err(`harness: ${message(e)}`)])
    return { lines: [sys(`harness: running ${name}... (the avatar and one car may be moved; they are put back after)`)], pending }
  },

  // `status` reads at any time; `start` and `stop` are operator-gated. The file is local: the host's
  // save dialog (or a download at stop); the terminal never sees the bytes.
  record(args, b) {
    if (args.length > 2) return fail(usage('record'))
    const rec = recordOf(b)
    const a = args[0] ?? 'status'
    if (a === 'status') {
      if (args.length > 1) return fail(usage('record'))
      return { lines: [out(`record: ${formatRecording(rec.status())}`)] }
    }
    if (a === 'stop') {
      if (args.length > 1) return fail(usage('record'))
      if (!operatorOf(b).unlocked()) return locked('record')
      if (!rec.status().active) return { lines: [sys('record: not recording')] }
      const pending = Promise.resolve(rec.stop()).then(
        (where): Line[] => [out(`record: stopped: ${recordingParts(rec.status())}${where ? `  ${where}` : ''}`)],
        (e: unknown): Line[] => [err(`record: ${message(e)}`)],
      )
      return { lines: [sys('record: stopping (flushing the encoder)...')], pending }
    }
    if (a !== 'start') return fail(`record: unknown command '${a}'`, usage('record'))
    const source = args[1] ?? 'canvas'
    if (source !== 'canvas' && source !== 'camera') return fail(`record: unknown source '${source}'`, usage('record'))
    if (!operatorOf(b).unlocked()) return locked('record')
    const support = rec.supported()
    if (!support.ok) return fail(`record: ${support.reason}`)
    const st = rec.status()
    if (st.active) return fail(`record: already ${formatRecording(st)}`)
    // Called synchronously: the save dialog (and the camera prompt) need the Enter keydown's user activation.
    const pending = Promise.resolve(rec.start(source)).then(
      (codec): Line[] => [out(`record: recording ${source} as ${codec}`)],
      (e: unknown): Line[] => [err(`record: ${message(e)}`)],
    )
    return { lines: [sys(`record: choose where to save the .agv file${source === 'camera' ? ', then allow the camera' : ''}...`)], pending }
  },

  // `status` reads at any time; joining, leaving and dropping the kept token are the operator's. The room's address
  // and the token go to the host's client and nowhere else; the token is kept on this machine for the next join.
  net(args, b) {
    const n = netOf(b)
    const a = args[0] ?? 'status'
    if (a === 'status') return args.length > 1 ? fail(usage('net')) : { lines: netLines(n.status()) }
    if (a === 'leave' || a === 'forget') {
      if (args.length > 1) return fail(usage('net'))
      if (!operatorOf(b).unlocked()) return locked('net')
      return { lines: [out(`net: ${a === 'leave' ? n.leave() : n.forget()}`)] }
    }
    if (a !== 'join') return fail(`net: unknown command '${a}'`, usage('net'))
    if (args.length < 2 || args.length > 3) return fail(usage('net'))
    const url = args[1]
    if (!/^wss?:\/\/\S+$/.test(url)) return fail(`net: not a room address: '${url}' (ws or wss, on this machine only)`, usage('net'))
    if (!operatorOf(b).unlocked()) return locked('net')
    const pending = n.join(url, args[2]).then((t): Line[] => [out(`net: ${t}`)], (e: unknown): Line[] => [err(`net: ${message(e)}`)])
    return { lines: [sys(`net: joining ${url}...`)], pending }
  },

  sim: bare('sim', (b) => {
    const s = b.stats(), r = s.rapier, a = s.agents, k = s.kernel
    const op = b.operator
    return {
      lines: [
        out(row('clock', b.clock())),
        out(row('quality', formatQuality(s.quality))),
        out(row('frame', `${fixed(s.fps, 1)} fps  ${fixed(s.frameMs, 2)} ms  p95 ${fixed(s.p95Ms, 2)} ms`)),
        ...cameraRows(s).map(out),
        out(row('agents', `drawn ${count(a.drawnNear + a.drawnFar)} of ${count(a.population)}  waiting ${count(a.waiting)}  crossing ${count(a.crossing)}${a.working === undefined ? '' : `  at work ${count(a.working)}`}`)),
        out(row('vehicles', count(s.vehicles))),
        out(row('rapier3d', `step ${fixed(r.stepMs, 3)} ms  bodies ${count(r.bodies)}  colliders ${count(r.colliders)}  ccd ${count(r.ccd)}`)),
        out(row('kernel', `law1 ${count(k.law1)}  law2 ${count(k.law2)}  law3 ${count(k.law3)}  flips ${count(k.sensorFlips)}  shielded ${k.shielded ? 'yes' : 'no'}`)),
        out(row('operator', op?.unlocked() ? 'unlocked' : "locked (type 'operator unlock')")),
      ],
    }
  }),
}

function dispatch(name: Name, args: string[], bridge: TerminalBridge, history: readonly string[], line: string, session: ReplSession | null): CommandResult {
  try {
    return HANDLERS[name](args, bridge, history, line, session)
  } catch (e) {
    return fail(`${name}: ${message(e)}`)
  }
}

/** Whether a proposed city action waits for the OK; false on a bridge without the tier (so `y` stays an unknown word there). */
function actWaiting(b: TerminalBridge): boolean {
  try {
    return operatorOf(b).acts.pending() !== null
  } catch {
    return false
  }
}

/**
 * Parses and runs one line (or several, joined by newlines, for a script). Pure apart from what the
 * bridge does; never throws (a failing bridge call becomes an error line). `history` is the lines
 * entered before this one, oldest first. `session` is the console's R0 machine (`r0` lines run on it, so
 * definitions persist); without one, each `r0` line runs on a fresh machine.
 */
export function run(input: string, bridge: TerminalBridge, history: readonly string[], session: ReplSession | null = null): CommandResult {
  // `y` and `n` alone are `act ok` and `act no` while a proposal waits; otherwise the console knows no such word (they
  // are in no table, so help, completion and the locked sweep never see them).
  const alias = /^\s*([yn])\s*$/i.exec(input)
  if (alias && actWaiting(bridge)) return dispatch('act', [alias[1].toLowerCase() === 'y' ? 'ok' : 'no'], bridge, history, input.trim(), session)
  const head = /^\s*(\S+)/.exec(input)
  if (head && RAW.has(head[1])) {
    const rest = input.slice(head.index + head[0].length).trim()
    return dispatch(head[1] as Name, rest ? [rest] : [], bridge, history, input.trim(), session)
  }
  const words = tokenize(input)
  if (!words) return fail('ash: syntax error: unterminated quoted string')
  if (!words.length) return { lines: [] }
  const [name, ...args] = words
  if (!Object.hasOwn(HANDLERS, name)) return fail(`ash: ${name}: not found`)
  return dispatch(name as Name, args, bridge, history, input.trim(), session)
}

/**
 * A line as the console's history keeps it: a key given to `ask key`, `say key` or `ask connect`, and a token given to
 * `net join`, are replaced by dots, so `history` and the Up arrow never show a secret typed earlier. After `ask connect
 * <provider>` only a leading http(s) address is kept; anything else there (a key typed where the url goes) is dotted
 * with everything after it. Every other line is kept as typed.
 */
export function redactForHistory(line: string): string {
  return line
    .replace(/^(\s*(?:ask|say)\s+key\s+)\S[\s\S]*$/, '$1••••')
    .replace(/^(\s*ask\s+connect\s+\S+\s+)(?!https?:\/\/[^\s@]*(?:\s|$))\S[\s\S]*$/i, '$1••••')
    .replace(/^(\s*ask\s+connect\s+\S+\s+\S+\s+)\S[\s\S]*$/, '$1••••')
    .replace(/^(\s*net\s+join\s+\S+\s+)\S[\s\S]*$/, '$1••••')
}

/**
 * Tab completion over the whole line: returns every full line that completes its last word, sorted
 * ('h' → hal, harness, help, history; 'hal pair ' → the three buses). Empty when nothing matches.
 */
export function complete(prefix: string): string[] {
  const words = prefix.trimStart().split(/[ \t]+/)
  const last = words[words.length - 1]
  const head = prefix.slice(0, prefix.length - last.length)
  const key = words.slice(0, -1).join(' ')
  const options = words.length === 1 ? NAMES : Object.hasOwn(ARGS, key) ? ARGS[key] : []
  return options.filter((o) => o.startsWith(last)).map((o) => head + o)
}

/** Longest string every word starts with. */
export function commonPrefix(words: readonly string[]): string {
  if (!words.length) return ''
  let p = words[0]
  for (const w of words) while (!w.startsWith(p)) p = p.slice(0, -1)
  return p
}

/**
 * The console toggle: the key left of 1 (Backquote) or a typed ` or ~. Plain Ctrl and Meta chords are
 * left to the browser; Ctrl+Alt is AltGr on Windows layouts, where ~ often lives.
 */
export function isToggleKey(e: { code: string; key: string; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  if (e.metaKey || (e.ctrlKey && !e.altKey)) return false
  return e.code === 'Backquote' || e.key === '`' || e.key === '~'
}

/**
 * The prompt of every line after the first in a multi-line entry: '…' right-aligned under the prompt's
 * last character, the same width as the prompt, so the hidden textarea and its visual mirror stay
 * column-aligned on every line.
 */
export function continuationPrompt(prompt: string): string {
  return prompt.length < 2 ? '… ' : `${'…'.padStart(prompt.length - 1)} `
}

/**
 * Up recalls history only from the first line of the buffer and Down only from the last; anywhere else
 * the arrows move the caret between the lines of a script.
 */
export function recallsHistory(key: 'ArrowUp' | 'ArrowDown', value: string, caret: number): boolean {
  return key === 'ArrowUp' ? !value.slice(0, caret).includes('\n') : !value.slice(caret).includes('\n')
}

/** Message of the day, printed once when the console first mounts; on Track B (?boot=tty) it says no city was built. */
export function motd(brand: TerminalBridge['brand']): Line[] {
  const tty = brand.track === 'tty'
  return [
    sys(`${brand.name} ${brand.version} Ring-0 console`),
    ...(tty ? [sys("Track B: this console alone; no 3D engine was built (?boot=tty). Type 'boot gui' for the city.")] : []),
    sys("Observe and tune; 'operator unlock' opens the scripted tier (the laws stay in force)."),
    sys(tty ? "Type 'help' for commands; 'r0' is the console's own stack machine." : "Type 'help' for commands. ` or Esc closes."),
    sys(''),
  ]
}
