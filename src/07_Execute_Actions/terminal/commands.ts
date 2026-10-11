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
 * local model (`ask rust: …`) goes through the same gateway, and its answer streams in live; so does speech
 * (`say rust: …`), said by the person it is bound to. `memory` reads what the people recruited remember. The view
 * knobs (`ghost`, `render`, `captions`), the pings (`ping`: a mark where the head looks; `recruit rally` sends an
 * Active recruit to it, through the same worker checks as asking), the player's look (`look`) and the opt-in network
 * session (`net`, operator-gated) go through the bridge the same way. `boot` asks the host to reload on a track
 * (the city, or the console alone); `r0` is the console's own stack machine (repl.ts): it touches no bridge at all.
 * What breaks if it is removed? The terminal cannot interpret a single line.
 */
import type {
  AskResult, ExecResult, GateTether, HalDevice, HarnessReport, LookBridge, LookChange, MemoryBridge, MindStatus, NetBridge, NetReport, OperatorBridge,
  Piece, PingKind, PingPick, RecordBridge, RecruitBridge, Ring0Stats, RunResult, SayResult, TerminalBridge, VoiceStatus,
} from './bridge.ts'
import type { QualityState, RecordingState } from '../../05_Observe_Environment/telemetry.ts'
import { Machine } from './repl.ts'

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

/**
 * `live`: redraw formatStats() in place until cancelled (lines are the first frame). `pending`: lines
 * that arrive later (a device picker, a script, a harness). `stream`: text shown live until `pending`
 * settles. `clear` wipes the screen, `close` hides the console, `boot` asks the host to reload the page on
 * that track ('gui': the city; 'tty': the full-screen console alone, ?boot=tty).
 */
export interface CommandResult { lines: Line[]; clear?: boolean; live?: 'stats'; close?: boolean; boot?: 'gui' | 'tty'; pending?: Promise<Line[]>; stream?: TextStream }

/** Highest quality tier index (tiers are 0 = lowest … 4 = highest). */
const MAX_TIER = 4
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
  { name: 'quality', usage: 'quality [auto|0-4]', summary: 'show or set the render quality tier' },
  { name: 'time', usage: 'time [HH[:MM]]', summary: 'show or set the city clock' },
  { name: 'audio', usage: 'audio [on|off|0-100]', summary: 'show or set the soundscape' },
  { name: 'ghost', usage: 'ghost [on|off]', summary: 'ghost view: the physics shapes as code over the frame (view-only; G)' },
  { name: 'rain', usage: 'rain [on|off]', summary: 'falling code on every surface, in world space; people and cars pass through each other (M)' },
  { name: 'render', usage: 'render [on|off]', summary: 'draw the city, or stop drawing it (physics, audio and this console keep running)' },
  { name: 'captions', usage: 'captions [on|off]', summary: 'closed captions for every sound: engines, signals, speech, pings (view-only)' },
  { name: 'ping', usage: 'ping [go|look|gather|wait|clear]', summary: 'mark where you look for your swarm (view-only; shown on the minimap and captioned; Q); alone, the marks standing' },
  { name: 'look', usage: 'look [show [<agent>]|<slot> <n|name>|preset <name>|code <code>|random [<seed>]|reset]', summary: "your look from the crowd's wardrobe (body, height, build, skin, hair, top, bottom, shirt, shoes, tie, eyewear, bag, cup)" },
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
  { name: 'r0', usage: 'r0 <words...>|r0 reset|r0 words', summary: "the console's own stack machine (Turing-complete, sandboxed: it reaches nothing of the city)" },
  { name: 'exit', usage: 'exit', summary: 'close the console (also ` or Esc)' },
] as const

/** The operator tier; every one of these that changes anything is refused until `operator unlock`. */
const OPERATOR = [
  { name: 'operator', usage: 'operator [unlock|lock|status]', summary: 'the operator tier: scripts, tuning keys, harnesses' },
  { name: 'run', usage: 'run <skill>[,<skill>...]: <js...>', summary: 'run a script against sim.* while someone tethered has the skill (Shift+Enter adds a line)' },
  { name: 'ask', usage: 'ask [<skill>[,<skill>...]: <prompt...>|provider <name>|model <name>|server <url>|key <key>|effort <level>|think on|off|api <format>|stop]', summary: 'ask the model, answering as someone tethered with the skill; the answer streams in' },
  { name: 'say', usage: 'say [<skill>[,<skill>...]: <text...>|voice <name>|model <name>|server <url>|auto on|off|stop]', summary: 'said aloud by someone tethered with the skill, from where they stand (local speech server)' },
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
const RAW: ReadonlySet<string> = new Set(['run', 'ask', 'say', 'r0'])

/** A persistent R0 machine (repl.ts): the terminal keeps one for the life of the console, so definitions outlive a line. */
export interface ReplSession { machine: Machine }
export const replSession = (): ReplSession => ({ machine: new Machine() })

/** The harness names, for completion (commands.test.ts pins them to harness.ts, which this file must not import). */
export const HARNESS_NAMES = ['brake-distance', 'first-law-floor', 'kernel-stop', 'sanctuary', 'spatial', 'traffic-lights'] as const

const PAIR_KINDS: Record<string, 'hid' | 'serial' | 'bluetooth'> = { hid: 'hid', serial: 'serial', ble: 'bluetooth', bluetooth: 'bluetooth' }

/** The skills, as typed after `recruit` (commands.test.ts pins them to skills.ts, which this file must not import). */
export const SKILL_ARGS = [
  'accessibility', 'audio', 'c++', 'data', 'design', 'go', 'networking', 'python', 'robotics', 'rust', 'security', 'shaders', 'testing',
  'typescript', 'wgsl', 'writing',
] as const
const RECRUIT_ACTIONS = ['dismiss', 'install', 'listen', 'rally', 'stop'] as const

/** The kinds of ping and their words (commands.test.ts pins them to 08_Swarm/ping.ts, which this file must not import). */
const PING_KINDS = ['gather', 'go', 'look', 'wait'] as const
const PING_WORDS: Record<PingKind, string> = { go: 'go there', look: 'look there', gather: 'gather there', wait: 'wait there' }

/** The look's slots, bodies and presets, as typed after `look` (commands.test.ts pins them to 03_Spawn_Agents/look.ts, not imported here). */
export const LOOK_SLOT_ARGS = ['body', 'height', 'build', 'skin', 'hairStyle', 'hairColour', 'top', 'bottom', 'shirt', 'shoes', 'tie', 'eyewear', 'bag', 'cup'] as const
export const LOOK_BODY_ARGS = ['pantsuit', 'skirt suit', 'smart casual', 'suit'] as const
export const LOOK_PRESET_ARGS = ['burgundy pantsuit', 'camel blazer', 'camel skirt suit', 'charcoal suit', 'cream pantsuit', 'navy blazer', 'navy skirt suit', 'navy suit'] as const
const LOOK_ACTIONS = ['code', 'preset', 'random', 'reset', 'show'] as const

/** Tab-completion candidates for arguments, keyed by the words before the one being completed. */
const ARGS: Record<string, readonly string[]> = {
  help: NAMES,
  stats: ['--once'],
  quality: ['0', '1', '2', '3', '4', 'auto'],
  audio: ['off', 'on'],
  ghost: ['off', 'on'],
  rain: ['off', 'on'],
  render: ['off', 'on'],
  captions: ['off', 'on'],
  ping: ['clear', ...PING_KINDS],
  look: [...LOOK_ACTIONS, ...LOOK_SLOT_ARGS].sort(),
  'look body': LOOK_BODY_ARGS,
  'look hairStyle': ['long', 'short'],
  'look preset': LOOK_PRESET_ARGS,
  boot: ['gui', 'status', 'tty'],
  r0: ['reset', 'words'],
  hal: ['pair'],
  'hal pair': ['ble', 'hid', 'serial'],
  recruit: [...RECRUIT_ACTIONS, ...SKILL_ARGS].sort(),
  uname: ['-a'],
  operator: ['lock', 'status', 'unlock'],
  run: SKILL_ARGS.map((s) => `${s}:`),
  ask: [...SKILL_ARGS.map((s) => `${s}:`), 'api', 'effort', 'key', 'model', 'provider', 'server', 'stop', 'think'].sort(),
  'ask think': ['off', 'on'],
  'ask api': ['chat', 'generate'],
  'ask provider': ['claude', 'llamacpp', 'ollama'],
  'ask effort': ['high', 'low', 'max', 'medium', 'none', 'xhigh'],
  say: [...SKILL_ARGS.map((s) => `${s}:`), 'auto', 'model', 'server', 'stop', 'voice'].sort(),
  'say auto': ['off', 'on'],
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
/** GPU timings are 0 until timestamp queries resolve (?profile), so 0 reads as "not measured". */
const gpuMs = (v: number): string => (Number.isFinite(v) && v > 0 ? v.toFixed(2) : '-')
const row = (label: string, text: string): string => label.padEnd(10) + text

/** A bridge built before the operator tier existed has no `operator`; say so instead of crashing. */
function operatorOf(b: TerminalBridge): OperatorBridge {
  const op = b.operator
  if (!op) throw new Error('operator tier not available on this bridge')
  return op
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

/** Likewise for a bridge whose host keeps no look (the TTY shell, an older host). */
function lookOf(b: TerminalBridge): LookBridge {
  const l = b.look
  if (!l) throw new Error('look not available on this bridge')
  return l
}

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

export function formatQuality(q: QualityState): string {
  return `tier ${q.tier} ${q.label} (${q.auto ? 'auto' : 'fixed'})  scale ${fixed(q.renderScale, 2)}x  budget ${fixed(q.targetMs, 1)} ms`
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
  return `  ${d.transport.padEnd(10)}${d.state.padEnd(13)}${d.name}${d.detail ? `  ${d.detail}` : ''}`
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
  const none = answer.length ? [] : [sys(r.thinking > 0 ? '(no answer: the model spent its tokens thinking)' : '(the model returned no text)')]
  const thought = r.thinking > 0 ? `, after ${r.thinking} tokens of thinking` : ''
  const cut = r.done === 'length' ? ' (cut at the token limit)' : ''
  return [...answer, ...none, sys(`-- answered in ${(r.ms / 1000).toFixed(1)} s${thought}${cut} --`)]
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
    out(row('server', `${v.server}  (this machine only)`)),
    out(row('voice', v.voice ?? 'none chosen: say voice <name>')),
    out(row('model', v.model ?? "the server's default")),
    out(row('auto', v.auto ? 'on: answers to ask are said aloud' : 'off')),
  ]
  if (v.speaking) lines.push(sys("saying something now: 'say stop' cuts it off"))
  if (v.error !== undefined) return [...lines, err(`say: ${v.error}`)]
  if (v.voices === null) return [...lines, sys("the server keeps no list of voices: name one its documentation gives (say voice <name>)")]
  if (!v.voices.length) return [...lines, out(row('voices', 'none'))]
  lines.push(...v.voices.map((name, i) => out(row(i === 0 ? 'voices' : '', name === v.voice ? `${name}  (chosen)` : name))))
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
  if (action === 'code') return rest.length === 1 ? { kind: 'code', code: rest[0] } : 'usage: look code <XXXX-XXXX>'
  const slot = LOOK_SLOT_ARGS.find((x) => x.toLowerCase() === action.toLowerCase())
  if (!slot) return `look: no slot named '${action}': ${LOOK_SLOT_ARGS.join(', ')}`
  return rest.length ? { kind: 'slot', slot, value: rest.join(' ') } : `usage: look ${slot} <n|name>`
}

/** `ask` alone: the provider, where its server is, the model chosen, and what the server says it has. */
function mindLines(m: MindStatus): Line[] {
  const network = m.provider === 'claude'
  const lines: Line[] = []
  if (m.provider !== undefined) {
    lines.push(out(row('provider', network ? 'claude: the Claude API through a gateway on this machine (ask provider ollama|llamacpp for a model on this machine)' : `${m.provider}: a model server on this machine (ask provider claude for the Claude API)`)))
  }
  lines.push(out(row('server', network ? `${m.server}  (a gateway on this machine only)` : `${m.server}  (this machine only)`)), out(row('model', m.model ?? 'none chosen: ask model <name>')))
  if (network) {
    lines.push(out(row('key', m.key ? `${m.key}  (kept in this browser's local storage: ask key none clears it)` : 'none in this page: the gateway on this machine adds it (recommended)')))
    lines.push(out(row('effort', m.effort ?? "the model's default (ask effort low|medium|high|xhigh|max)")))
  }
  if (m.api !== undefined) lines.push(out(row('api', m.api === 'chat' ? 'chat: /v1/chat/completions (ask api generate for /api/generate)' : `${m.api}: /api/generate (ask api chat for /v1/chat/completions)`)))
  if (m.think !== undefined) lines.push(out(row('think', m.api === 'chat' ? 'not sent in the chat format: the server decides' : m.think ? 'on: it reasons before it answers' : 'off: it answers without reasoning first (ask think on)')))
  if (m.cache !== undefined) lines.push(out(row('cache', m.cache)))
  if (m.fallback !== undefined) lines.push(out(row('fallback', m.fallback)))
  if (m.installed === null) return [...lines, err(`ask: ${m.error ?? (network ? 'the gateway to the Claude API did not answer' : 'the local model server did not answer')}`)]
  if (!m.installed.length) return [...lines, out(row('installed', 'no models'))]
  lines.push(...m.installed.map((name, i) => out(row(i === 0 ? 'installed' : '', name === m.model ? `${name}  (chosen)` : name))))
  if (m.model === null) lines.push(sys('choose one that writes text: ask model <name>'))
  return lines
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
    return args.length ? { lines } : { lines, live: 'stats' }
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
    if (/^\d$/.test(a) && Number(a) <= MAX_TIER) return { lines: [out(formatQuality(b.quality(Number(a))))] }
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
    // The bus resolves a device in state 'error' (API missing, request refused) rather than rejecting.
    const pending = Promise.resolve(b.hal.pair(kind)).then(
      (d): Line[] => (!d ? [sys('hal: no device selected')]
        : d.state === 'error' ? [err(`hal: pair failed: ${d.detail || d.name}`)]
        : [out(`hal: ${d.name} ${d.state} (${d.transport}${d.detail ? `, ${d.detail}` : ''})`)]),
      (e: unknown): Line[] => [err(`hal: pair failed: ${message(e)}`)],
    )
    return { lines: [sys(`hal: waiting for the browser's ${kind} device picker...`)], pending }
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
      op.lock()
      return { lines: [out('operator: locked')] }
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
  ask(args, b) {
    const op = operatorOf(b)
    if (!op.unlocked()) return locked('ask')
    const rest = args[0] ?? ''
    if (!rest) return { lines: [], pending: Promise.resolve(op.askStatus()).then(mindLines, (e: unknown): Line[] => [err(`ask: ${message(e)}`)]) }
    if (rest === 'stop') return { lines: [out(`ask: ${op.askStop()}`)] }
    const set = /^(model|server|think|api|provider|key|effort)(?:\s+([\s\S]*))?$/.exec(rest)
    if (set) {
      const key = set[1] as 'model' | 'server' | 'think' | 'api' | 'provider' | 'key' | 'effort'
      const value = (set[2] ?? '').trim()
      const takes = { model: 'name', server: 'url', api: 'generate|chat', think: 'on|off', provider: 'claude|ollama|llamacpp', key: 'key|none', effort: 'low|medium|high|xhigh|max|none' }[key]
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
    const set = /^(voice|model|server|auto)(?:\s+([\s\S]*))?$/.exec(rest)
    if (set) {
      const key = set[1] as 'voice' | 'model' | 'server' | 'auto'
      const value = (set[2] ?? '').trim()
      if (!value) return fail(`usage: say ${key} <${key === 'server' ? 'url' : key === 'auto' ? 'on|off' : 'name'}>`)
      return { lines: [out(row(key, op.saySet(key, value)))] }
    }
    const intent = runIntent(rest)
    if (!intent) return fail('say: name the skill of whoever should say it first, e.g. say rust: over here', usage('say'))
    if (!intent.script) return fail(usage('say'))
    const r = op.say(intent.skills, intent.script)
    const pending = Promise.resolve(r.result).then(sayLines, (e: unknown): Line[] => [err(`say: ${message(e)}`)])
    return { lines: r.state === 'Authorized' ? [sys(`say: Authorized: said by ${tetherText(r.bound[0])}`)] : [], pending }
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
        out(row('agents', `drawn ${count(a.drawnNear + a.drawnFar)} of ${count(a.population)}  waiting ${count(a.waiting)}  crossing ${count(a.crossing)}`)),
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

/**
 * Parses and runs one line (or several, joined by newlines, for a script). Pure apart from what the
 * bridge does; never throws (a failing bridge call becomes an error line). `history` is the lines
 * entered before this one, oldest first. `session` is the console's R0 machine (`r0` lines run on it, so
 * definitions persist); without one, each `r0` line runs on a fresh machine.
 */
export function run(input: string, bridge: TerminalBridge, history: readonly string[], session: ReplSession | null = null): CommandResult {
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
 * A line as the console's history keeps it: a key given to `ask key` and a token given to `net join` are replaced
 * by dots, so `history` and the Up arrow never show a secret typed earlier. Every other line is kept as typed.
 */
export function redactForHistory(line: string): string {
  return line.replace(/^(\s*ask\s+key\s+)\S[\s\S]*$/, '$1••••').replace(/^(\s*net\s+join\s+\S+\s+)\S[\s\S]*$/, '$1••••')
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
