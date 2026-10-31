// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the unified namespace (05_Observe_Environment/namespace.ts),
 * which Node cannot run as a page: the engine publishes every snapshot into one bus and writes the bus's size onto the
 * snapshot, the terminal bridge exposes the bus read-only through four formatted readers and nothing else, the offline
 * stand-in refuses them, the HUD shows the topic count, and the console's `topic` command and live view know no bus of
 * their own (the terminal imports only types of the rest of the engine). It also runs the real bus over a real
 * snapshot-shaped object the way the engine does, so the engine's call compiles against the module's contract.
 * What breaks if it is removed? The engine could stop publishing, the console could grow a value import of the bus,
 * or the HUD line could go, and only the browser would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { offlineBridge } from './terminal/bridge.ts'
import { TopicBus, UNS, childLines, publishSnapshot, topicLines } from '../05_Observe_Environment/namespace.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}

test('engine: one bus, every snapshot published into it with a rising tick, and the bus size on the snapshot for the HUD', () => {
  const src = read('./engine.ts')
  assert.match(src, /^import \{ TopicBus, UNS, childLines, publishSnapshot, topicLines \} from '\.\.\/05_Observe_Environment\/namespace\.ts'$/m)
  assert.match(src, /^ {2}private readonly topics = new TopicBus\(\)$/m, "one bus for the engine's life")
  assert.match(src, /^ {2}private topicTick = 0$/m)
  const snapshot = between(src, '  snapshot(): SipocSnapshot {', '  terminalBridge(')
  assert.match(snapshot, /publishSnapshot\(this\.topics, snap, st\.physics, this\.topicTick\+\+\)/, 'published after the snapshot is built, with the physics counters')
  assert.match(snapshot, /snap\.output\.topics = \{ count: this\.topics\.count, publishes: this\.topics\.publishes \}/)
  assert.match(snapshot, /^ {8}rendering: this\.rendering,$/m, 'the snapshot literal itself is as it was')
  assert.equal(src.match(/publishSnapshot\(/g)?.length, 1, 'published from snapshot() alone')
  assert.match(read('../05_Observe_Environment/telemetry.ts'), /^ {4}topics\?: \{ count: number; publishes: number \}$/m)
})

test('bridge: the namespace is read-only through four formatted readers; the offline stand-in refuses them; the console imports no bus', () => {
  const src = read('./engine.ts')
  const bridge = between(src, '  terminalBridge(gate: SkillGate', '  /** Control glyphs')
  const topics = between(bridge, 'topics: Object.freeze({', '}),')
  assert.match(topics, /list: \(filter\?: string\) => topicLines\(this\.topics\.list\(/)
  assert.match(topics, /get: \(t: string\) =>/)
  assert.match(topics, /children: \(prefix\?: string\) => childLines\(this\.topics,/)
  assert.match(topics, /status: \(\) => `namespace {2}\$\{this\.topics\.count\} topics/)
  assert.doesNotMatch(topics, /\.publish\(|\.clear\(|\.subscribe\(/, 'nothing on the bridge writes the bus')
  assert.match(read('./terminal/bridge.ts'), /^ {2}topics\?: TopicBridge$/m)
  assert.match(read('./terminal/bridge.ts'), /^export interface TopicBridge \{\n {2}list\(filter\?: string\): string\[\]\n {2}get\(topic: string\): string \| null\n {2}children\(prefix\?: string\): string\[\]\n {2}status\(\): string\n\}$/m)
  const off = offlineBridge({ name: 'T', version: '0', host: 't' })
  assert.throws(() => off.topics!.list(), /engine not running/)
  assert.throws(() => off.topics!.get('x'), /engine not running/)
  assert.throws(() => off.topics!.children(), /engine not running/)
  assert.throws(() => off.topics!.status(), /engine not running/)
  // The console knows the bus only as a type: its rows come formatted from the bridge.
  for (const file of ['./terminal/commands.ts', './terminal/Terminal.tsx', './terminal/bridge.ts']) {
    assert.doesNotMatch(read(file), /^import (?!type ).*namespace\.ts'|new TopicBus|publishSnapshot\(/m, file)
  }
})

test('the bridge expands a leading ~ to the root, as the rows print it', () => {
  const src = read('./engine.ts')
  assert.match(src, /^const expandTopic = \(t: string\): string => \(t === '~' \? UNS\.root : t\.startsWith\('~\/'\) \? UNS\.root \+ t\.slice\(1\) : t\)$/m)
  const expandTopic = (t: string): string => (t === '~' ? UNS.root : t.startsWith('~/') ? UNS.root + t.slice(1) : t)
  assert.equal(expandTopic('~'), UNS.root)
  assert.equal(expandTopic('~/Area/#'), `${UNS.root}/Area/#`)
  assert.equal(expandTopic('Enterprise/JCS/Site/AgentCity/Area/#'), 'Enterprise/JCS/Site/AgentCity/Area/#')
  assert.equal(expandTopic('~x'), '~x', 'only a ~ alone or before a slash is the root')
})

test('HUD: the topic count is a readout line (not on a phone), from the snapshot field alone', () => {
  const hud = read('./Hud.tsx')
  assert.match(hud, /\{!compact && s\.output\.topics && \(\n\s*<div className=\{`truncate tabular-nums \$\{muted\}`\} data-hud="topics">\n\s*namespace \{s\.output\.topics\.count\.toLocaleString\(\)\} topics/)
  assert.doesNotMatch(hud, /namespace\.ts'|TopicBus/, 'the HUD reads the snapshot, never the bus')
})

test("the live view: the terminal redraws by the result's own function, so stats and topic watch share one path", () => {
  const term = read('./terminal/Terminal.tsx')
  assert.match(term, /const liveDraw = useRef<LiveFrame \| null>\(null\)/)
  assert.match(term, /const frame = draw\(bridgeRef\.current \?\? OFFLINE\)/)
  assert.match(term, /liveDraw\.current = r\.live/)
  assert.doesNotMatch(term, /formatStats/, "the terminal names no command's formatter")
  assert.match(read('./terminal/commands.ts'), /^export type LiveFrame = \(b: TerminalBridge\) => string\[\]$/m)
})

test("the real bus over a snapshot shaped as the engine builds one: topics land under the player's district and the status reads", () => {
  const bus = new TopicBus()
  const snapshot = {
    supplier: { device: 'Keyboard', pointerLocked: false, engaged: true, touch: false, triggerResistance: 0, hal: '', glyphs: 'keyboard', recording: { active: false, source: null, seconds: 0, frames: 0, bytes: 0, dropped: 0, codec: '' } },
    input: { mode: 'foot', nearVehicle: false },
    process: { pedestrians: 100, vehicles: 4, drawnNear: 10, drawnFar: 20, waiting: 3, crossing: 2, yielding: 1, safetyNudges: 0, gpu: 'test' },
    output: { fps: 60, frameMs: 16.6, p50Ms: 16, p95Ms: 18, cpuMs: 4, gpuRenderMs: 3, gpuComputeMs: 0, physicsMs: 1, rapierMs: 0.4 },
    kernel: { law1: 1, law2: 0, law3: 0, sensorFlips: 0, shielded: false, last: '', audit: { ticks: 10, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } },
    quality: { tier: 3, label: 'High', auto: true, renderScale: 1, targetMs: 16.7 },
    customer: { name: '', clock: '10:00', daylight: 1, viewYaw: 0, district: 'Heritage Quarter · 2nd Ave & 3rd St', speedKmh: 0, gear: 'N', x: 1, z: 2, heading: 0, signalEW: 'green', signalNS: 'red', signalRemaining: 5 },
    experience: { sessionSeconds: 1, longFrames: 0, distanceWalked: 0, distanceDriven: 0 },
    map: [{ x: 1, z: 2, heading: 0, player: false }],
    toasts: [],
  }
  const n = publishSnapshot(bus, snapshot as never, { stepMs: 0.4, steps: 2, bodies: 5, colliders: 6, ccd: 1 }, 0)
  assert.ok(n > 30, `${n} topics published`)
  assert.equal(bus.count, n)
  const fps = bus.get(`${UNS.root}/Area/HeritageQuarter/Line/Frame/Cell/Page/fps`)
  assert.equal(fps?.value, 60)
  assert.deepEqual(topicLines([fps!]), ['~/Area/HeritageQuarter/Line/Frame/Cell/Page/fps  60'])
  assert.ok(childLines(bus).some((l) => /^Area\//.test(l)), childLines(bus).join('\n'))
  assert.ok(bus.list(`${UNS.root}/Area/+/Line/Kernel/#`).length >= 10)
  for (const l of topicLines(bus.list('#'))) assert.ok(/^[\x20-\x7e]*$/.test(l), l)
})
