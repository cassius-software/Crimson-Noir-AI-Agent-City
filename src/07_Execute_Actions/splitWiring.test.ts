// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of local split screen (viewports.ts, seats.ts, controls.ts,
 * audio.ts Design B), which the engine, the input, the realm client and the host carry and Node cannot run: the
 * player count from the URL into the engine, the extra avatars asked of the physics realm at boot and their controls
 * in every step request through the one pinned request line, each seat's door and reset sent for its own avatar, a
 * seat and a head per player posed every animation frame, the view loop inside present() alone (one clear of the
 * whole canvas before the first scissored draw, the crowd culled for each camera before its draw, the sky re-centred
 * per head, view 0's exact draw lines untouched), the viewports cut again on resize, a soundscape per player in head
 * space over one shared context fed from its own head, speech and cues fanned out, the snapshot's report, the post
 * chain off while split, and that nothing of it reaches the physics realm's modules.
 * What breaks if it is removed? Players 2–4 could lose their car door again, and split screen could quietly draw
 * every viewport from player 1's head, cull once for four cameras, clear per quadrant (and lose three of them), leave
 * players 2–4 without a body in the realm or a listener of their own, or let the one-player path change, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}
/** Words no shipped line of this stage may carry (compliance.test.ts holds the product-wide list). */
const FORBIDDEN = /\btarget\b|\bthe matrix\b|\bmatrix[- ](?:style|like|rain|code|effect)\b|\bdigital rain\b|\bragdoll\b/i

test('wiring: ?players reaches the engine clamped, the realm gets a spawn per extra player, and the post chain is off while split', () => {
  const app = read('../App.tsx')
  assert.match(app, /players: clampPlayers\(q\.get\('players'\)\)/)
  assert.match(app, /const unlock = \(\) => engineRef\.current\?\.unlockAudio\(\)/, 'every player\'s soundscape takes the gesture')
  const src = read('./engine.ts')
  assert.match(src, /^ {2}players\?: number$/m, 'EngineOptions.players')
  const create = between(src, '  static async create(', '  /** The minimap')
  assert.match(create, /const players = clampPlayers\(requested\.players\)/)
  assert.match(create, /post: requested\.post && players === 1/, 'the post chain is player 1\'s alone: off while split')
  assert.match(create, /for \(let k = 1; k < players; k\+\+\) spawns\.push\(/, 'a spawn beside player 0 per extra player')
  assert.match(create, /\.\.\.\(spawns\.length > 0 && \{ spawns \}\)/, 'SimInit.spawns only when there are any')
  before(create, 'spawns.push(', 'SimClient.create({', 'the spawns go with the init')
})

test('wiring: a seat, a head and a control set per player; the pinned step request carries the extra players through the client', () => {
  const src = read('./engine.ts')
  const ctor = between(src, '  private constructor(p: {', '  static async create(')
  assert.match(ctor, /this\.input\.setPlayers\(players\)/)
  assert.match(ctor, /p\.sim\.setPlayers\(controls\)/, 'their records ride every step request')
  assert.match(ctor, /new Soundscape\(\{ context: share, space: 'head', voices: SPLIT\.voices, beds: SPLIT\.beds \}\)/, 'Design B per player')
  assert.match(ctor, /const share = players > 1 \? sharedAudioContext\(\) : null/, 'one shared context, only when split')
  const frame = between(src, '  frame(nowMs: number): void {', '  /** One drawn frame')
  assert.match(frame, /readControls\(input, driving >= 0, foot, drive\)/, 'player 1 through controls.ts')
  assert.match(frame, /readControls\(input\.intent\(v\.seat\), \(st\.drivings\[k\] \?\? -1\) >= 0, v\.foot, v\.drive\)/, 'every other seat the same way')
  assert.match(frame, /^ {4}if \(sim\.request\(\{ dt: this\.pendingDt, foot, drive \}\)\) this\.pendingDt = 0$/m, 'the one request line, unchanged')
  before(frame, 'readControls(input.intent(v.seat)', 'sim.request({ dt: this.pendingDt, foot, drive })', 'the other seats are read before the request')
  before(frame, 'this.rig.onFoot(', 'this.poseView(this.views[k], k, st, dt)', 'the other heads after player 1\'s')
  before(frame, 'this.poseView(this.views[k], k, st, dt)', 'this.pacer.tick(nowMs)', 'posed every animation frame, drawn or not')
  assert.ok(!frame.includes('.render('), 'frame() itself draws nothing')
  const pose = between(src, '  private poseView(', '  /** "Region')
  assert.match(pose, /v\.rig\.inVehicle\(v\.camera, t, r, this\.sim\.meta\.kind\[d\], seat\.yaw, seat\.pitch\)/)
  assert.match(pose, /v\.rig\.onFoot\(v\.camera, av\.x, av\.feetY, av\.z, seat\.yaw, seat\.pitch, dt\)/)
  assert.match(pose, /const av = st\.avatars\[k\] \?\? st\.avatar/, 'the realm\'s avatar for that player')
  // The client: the standing list goes out with every request, after the request's own fields.
  const client = read('./simClient.ts')
  assert.match(client, /setPlayers\(players: readonly PlayerControls\[\] \| null\): void/)
  assert.match(client, /const players = input\.players \?\? this\.#players \?\? undefined/)
  assert.match(client, /t: 'step', id: \+\+this\.#id, \.\.\.input, players, cmds,/)
  // Input: one readPads per frame, dealt to the seats; player 1 reads seat 0's pad alone while seated.
  const input = read('../04_Connect_Hardware/input.ts')
  const poll = between(input, '  poll(dt: number): void {', '  /** Virtual stick')
  assert.equal(poll.match(/readPads\(\)/g)?.length, 1, 'the pads are read once (readPads pumps the rumble)')
  assert.match(poll, /this\.seats\.assign\(pads\)/)
  assert.match(poll, /this\.seats\.seatOf\(p\.index\) === KEYBOARD_SEAT\) mine\.push\(p\)/)
  assert.match(poll, /this\.padSeats\[s - 1\]\.poll\(pads, this\.seats, s as Seat, dt, now\)/)
  assert.match(input, /intent\(seat: Seat\): PlayerIntent \{/)
})

test('wiring: every seat\'s door and reset reach the realm for its own avatar, a reset only from the wheel', () => {
  const src = read('./engine.ts')
  const loop = between(src, "if (input.take('reset') && driving >= 0) sim.send({ c: 'reset' })", 'readControls(input, driving >= 0, foot, drive)')
  assert.match(loop, /for \(let k = 1; k < this\.views\.length; k\+\+\)/)
  assert.match(loop, /const seat = input\.intent\(this\.views\[k\]\.seat\)/)
  assert.match(loop, /if \(seat\.take\('interact'\) && !this\.netRoom\) sim\.send\(\{ c: 'interact', player: k \}\)/, 'no door of theirs in a network room')
  assert.match(loop, /if \(seat\.take\('reset'\) && \(st\.drivings\[k\] \?\? -1\) >= 0\) sim\.send\(\{ c: 'reset', player: k \}\)/)
  const proto = read('./simProtocol.ts')
  assert.match(proto, /\| \{ c: 'reset'; player\?: number \}/)
})

test('wiring: the view loop lives in present() after view 0, one clear before the first scissored draw, a cull per camera before its draw', () => {
  const src = read('./engine.ts')
  const present = between(src, '  private present(', '  private presentView(')
  assert.ok(present.includes('this.post.render()') && present.includes('this.gpu.renderer.render(this.world.scene, cam)'), 'view 0 keeps its exact draw lines')
  assert.match(present, /const split = this\.views\.length > 1/)
  before(present, 'this.gpu.renderer.clear(true, true, true)', 'this.frameView(this.views[0])', 'cleared once before the first viewport is framed')
  before(present, 'this.frameView(this.views[0])', 'this.post.render()', 'player 1\'s rect set before its draw')
  before(present, 'this.gpu.renderer.render(this.world.scene, cam)', 'this.presentView(this.views[k])', 'the other viewports after view 0')
  assert.equal(present.match(/renderer\.clear\(/g)?.length, 1, 'one clear per presented frame')
  assert.doesNotMatch(between(src, '  private present(', 'const cam = this.world.camera'), /split|frameView|presentView/, 'nothing of it before the render guard')
  const view = between(src, '  private presentView(', '  /**\n   * Player k')
  before(view, 'packFrustumPlanes(v.frustum.planes, v.planes)', 'this.crowd.step({ camera: v.eye, planes: v.planes, global: this.world.matrixMode.state })', 'its own frustum')
  before(view, 'this.crowd.step({ camera: v.eye, planes: v.planes, global: this.world.matrixMode.state })', 'this.gpu.renderer.render(this.world.scene, cam)', 'culled for this camera before its draw')
  before(view, 'this.world.follow(cam)', 'this.gpu.renderer.render(this.world.scene, cam)', 'the sky on this head before its draw')
  before(view, 'this.frameView(v)', 'this.gpu.renderer.render(this.world.scene, cam)', 'viewport and scissor before its draw')
  assert.doesNotMatch(view, /post\.render|world\.update|ghost\.update|updateVolumetrics/, 'the direct path, under player 1\'s light')
  const frameView = between(src, '  private frameView(', '  /** How many local players')
  assert.match(frameView, /originBottomLeft\(v\.rect, Math\.max\(1, this\.canvas\.clientHeight\), ORIGIN_FLIP\)/)
  assert.match(frameView, /setViewport\(r\.x, r\.y, r\.width, r\.height\)\n\s*this\.gpu\.renderer\.setScissor\(r\.x, r\.y, r\.width, r\.height\)/)
  const layout = between(src, '  private layout(): void {', '  /** The renderer\'s viewport')
  assert.match(layout, /splitScreen\(this\.views\.length, w, h\)/)
  assert.match(layout, /v\.camera\.aspect = v\.rect\.width \/ v\.rect\.height/)
  assert.match(layout, /autoClear = false\n\s*this\.gpu\.renderer\.setScissorTest\(true\)/)
  const resize = between(src, '  resize(): void {', '  /** A view record')
  assert.match(resize, /if \(this\.views\.length > 1\) this\.layout\(\)/)
  assert.match(resize, /this\.marked = false/)
  // World: the sky follows another camera; update() is as it was.
  const world = read('../01_Initialize_World/world.ts')
  assert.match(world, /follow\(camera: PerspectiveCamera\): void/)
  assert.match(world, /const follow = \(other: PerspectiveCamera\) => \{ sky\.position\.copy\(other\.position\) \}/)
  assert.match(world, /sky\.position\.copy\(camera\.position\)/, 'update() still centres it on the world camera')
})

test('wiring: every player\'s soundscape is fed from its own head after player 1\'s; speech and cues fan out; the snapshot reports the split', () => {
  const src = read('./engine.ts')
  const listen = between(src, '  private listen(', '  private wallsTo(')
  assert.match(listen, /this\.soundFrame\(f, cam, st, dt, st\.driving\)/)
  before(listen, 'this.audio.update(f)', 'this.listenFor(this.views[k], k, st, dt, speaking, sp.room)', 'the others after player 1\'s')
  const each = between(src, '  private listenFor(', '  private wallsTo(')
  assert.match(each, /this\.soundFrame\(f, cam, st, dt, st\.drivings\[k\] \?\? -1\)/, 'their own cabin')
  assert.match(each, /f\.room = Number\.isNaN\(cell\) \? undefined : roomAt\(this\.world\.boxes, cam\.position\.x, cam\.position\.z\)/, 'their own room')
  assert.match(each, /this\.wallsFrom\(cam, speaking\.x, speaking\.z\)/, 'the walls from their head')
  assert.match(each, /v\.audio\.update\(f\)/)
  const speech = between(src, '  speechOut(): SpeechOut {', '  private panicked(')
  assert.match(speech, /this\.audio\.speak\(buffer, at\.x, at\.z, this\.wallsTo\(at\.x, at\.z\), text, \{ agent, label \}\)/, 'player 1\'s line untouched')
  assert.match(speech, /v\.audio\.speak\(buffer, at\.x, at\.z, this\.wallsFrom\(v\.camera, at\.x, at\.z\), text, \{ agent, label \}\)/)
  assert.match(speech, /stop: \(\) => \{ u\.stop\(\); for \(const o of others\) o\.stop\(\) \}/, 'one utterance, one stop')
  const ping = between(src, '  pingAt(kind: PingKind): Pick | null {', '  /** The kind the key')
  assert.match(ping, /this\.views\[k\]\.audio\.cuePing\(ping\.x, ping\.z\)/)
  const host = between(src, '  recruitHost(): RecruitHost {', '  /** The pedestrian speaking')
  assert.match(host, /this\.views\[k\]\.audio\.cue\(x, z\)/)
  const snapshot = between(src, '  snapshot(): SipocSnapshot {', '  terminalBridge(')
  assert.match(snapshot, /\.\.\.\(this\.views\.length > 1 && \{ players: this\.playersView\(st\) \}\)/, 'absent with one player')
  assert.match(read('../05_Observe_Environment/telemetry.ts'), /players\?: \{ count: number; rects: \{ x: number; y: number; width: number; height: number \}\[\]; seats: SeatView\[\] \}/)
  // Halt and dispose let every soundscape go; the console's audio knob reaches them all.
  assert.match(between(src, '  halt(reason: string): void {', '  dispose(): void {'), /this\.views\[k\]\.audio\.dispose\(\)/)
  assert.match(between(src, '  dispose(): void {', '\n}'), /this\.views\[k\]\.audio\.dispose\(\)/)
  assert.match(between(src, '  terminalBridge(gate: SkillGate', '  /** Control glyphs'), /for \(const v of this\.views\) \{\n\s*if \(arg === 'on'\) \{ v\.audio\.unlock\(\); v\.audio\.setEnabled\(true\) \}/)
})

test('air gap and the house style: nothing of split screen reaches the realm\'s modules; no forbidden word', () => {
  for (const f of ['./simProtocol.ts', './simCore.ts', './physics.worker.ts', './simHost.ts']) {
    assert.doesNotMatch(read(f), /viewports\.ts|seats\.ts|controls\.ts|Soundscape|splitScreen|setViewport|setScissor|PlayerView/, `${f} knows nothing of the page's viewports`)
  }
  for (const f of ['./viewports.ts', './controls.ts', '../04_Connect_Hardware/seats.ts']) assert.doesNotMatch(read(f), FORBIDDEN, f)
  const engine = read('./engine.ts')
  for (const [from, to] of [['interface PlayerView {', 'const ordinal'], ['  /** A view record', '  get adapter(): string {'], ['  private presentView(', '  /** "Region'], ['  private listenFor(', '  private wallsTo('], ['  private playersView(', '  /** The pings standing']]) {
    assert.doesNotMatch(between(engine, from, to), FORBIDDEN, `${from} …`)
  }
  assert.doesNotMatch(between(read('../04_Connect_Hardware/input.ts'), '  setPlayers(n: number): void {', '  /** Virtual stick'), FORBIDDEN)
  assert.doesNotMatch(between(read('./simClient.ts'), '  setPlayers(', '   * Queues a command'), FORBIDDEN)
  // The audio layer's split-screen additions carry no renderer, DOM or worker word of their own.
  const audio = read('./audio.ts')
  assert.match(audio, /export function sharedAudioContext\(\): AudioContextShare/)
  assert.match(audio, /export function toHeadSpace\(basis: ArrayLike<number>, lx: number, ly: number, lz: number, x: number, y: number, z: number, out: \{ x: number; y: number; z: number \}\): void/)
  assert.doesNotMatch(between(audio, 'export interface SoundscapeOptions', 'export class Soundscape'), /postMessage|Worker|renderer|document\./)
})
