// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the network session (Phase 10.2, made authoritative in
 * Phase 12), which the engine, the host and the console carry and Node cannot run: the engine holds no network code
 * (it imports nothing from 10_Network, names no socket, and reaches the client only through the NetHost seam App hands
 * it), pairs each realm state with the one step request that ran it (its walking velocity as the realm clamps it and
 * the correction it carried out) and reports it as one move per new state (the door the step took, read by
 * simProtocol.ts doorOf; at the wheel the command the car ran), puts the realm in room mode for the session and out of it
 * after, applies a new correction from the room as one command and nothing else (on foot a teleport, at the wheel the
 * car in the room's state), joins only the procedural city of its seed with its fleet on the track network, counts as
 * dropped only the steps the room could not have kept, draws the room's poses as ghosts in present() alone,
 * places the peer voices before the soundscape's update, captions the room's chat and pings through the captions
 * feed, reports the session in the snapshot, leaves on dispose; App builds the client once, connects it never (only
 * the console's `join` does), screens the room's lines under 14A once more, keeps the token on this machine and
 * hands the client to the engine and the bridge; and nothing of it reaches the physics realm's modules.
 * What breaks if it is removed? A socket could creep into the engine, a remote pose could become a body in the realm,
 * the client could connect at boot, or a room's line could reach the captions unscreened, with no test going red.
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
const specifiers = (text: string): string[] =>
  [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2])
/** Words no shipped line of this stage may carry (compliance.test.ts holds the product-wide list). */
const FORBIDDEN = /\btarget\b|\bthe matrix\b|\bmatrix[- ](?:style|like|rain|code|effect)\b|\bdigital rain\b|\bragdoll\b/i

test('the engine holds no network code: nothing from 10_Network, no socket, the client only through the NetHost seam', () => {
  const src = read('./engine.ts')
  for (const spec of specifiers(src)) assert.ok(!spec.includes('10_Network'), `engine.ts imports ${spec}`)
  assert.doesNotMatch(src, /\bWebSocket\b|\bRTCPeerConnection\b|\bfetch\(/, 'no socket, no request')
  assert.match(src, /^export interface NetHost \{$/m)
  assert.match(src, /^export interface NetControls \{$/m)
  assert.match(src, /^export type NetPeer = RemotePose$/m, 'the pose shape is the view\'s, not the protocol\'s')
  assert.match(src, /^ {2}setNet\(client: NetHost\): void \{$/m)
  assert.match(src, /^ {2}get net\(\): NetControls \{$/m)
  assert.match(src, /^ {2}netChat\(from: number, name: string, text: string\): void \{$/m)
  assert.match(src, /^ {2}netPing\(from: number, kind: PingKind, x: number, _y: number, z: number\): void \{$/m)
  const seam = between(src, 'export interface NetHost {', 'export interface NetControls {')
  assert.doesNotMatch(seam, /sendChat|sendPing|replica/, 'the engine is never handed a way to speak for the player')
  // The join: the Concierge's name, else the default, in the city of this page's seed and the fleet it runs (a region
  // has no mirror yet, and street-hopping traffic no plan); nothing is sent without the console's join, and whatever
  // the last session left is let go first.
  const net = between(src, '  get net(): NetControls {', '  netChat(')
  assert.match(net, /const world = `city\/\$\{this\.options\.seed >>> 0\}\/\$\{this\.sim\.meta\.suv\.length\}`\n\s*const why = c\.connect\(url, token, this\.playerName\.trim\(\) \|\| NET\.defaultName, world\)/)
  before(net, 'if (this.places) { reject(', 'c.connect(', 'a region is refused before any socket')
  before(net, 'if (this.options.tracks === false) { reject(', 'c.connect(', 'traffic off the track network is refused before any socket')
  before(net, "this.netLetGo('a new session')", 'c.connect(', 'a new session starts from nothing')
  assert.match(net, /this\.netJoin = \{ resolve, reject \}/, 'settled by the room\'s welcome or the socket\'s end (netFrame)')
})

test('each realm state: one move, paired with the request that ran it; a new correction is one teleport; the poses drawn in present() alone; the voices placed before the soundscape', () => {
  const src = read('./engine.ts')
  const frame = between(src, '  frame(nowMs: number): void {', '  /** One drawn frame')
  assert.match(frame, /^ {4}this\.netFrame\(\)$/m)
  before(frame, 'this.dissolve.update(realDt / 1000)', 'this.netFrame()', 'after the local scans')
  before(frame, 'this.netFrame()', 'this.pacer.tick(nowMs)', 'every animation frame, drawn or not')
  // The request in flight (one at a time) remembers what the room must replay: the walking velocity it asks for and the
  // correction it carries out (a teleport queued by netFrame rides the next request).
  before(frame, 'readControls(input, driving >= 0, foot, drive)', 'if (!sim.pending) {', 'the controls of this frame')
  assert.match(frame, /if \(!sim\.pending\) \{\n(?:\s*\/\/.*\n)*\s*const w = footWish\(foot\.x, foot\.z\)\n\s*this\.netSent\.x = w\.x\n\s*this\.netSent\.z = w\.z\n\s*this\.netSent\.fix = this\.netFix\n\s*this\.netSent\.shift = this\.netShift\n\s*\}\n\s*if \(sim\.request\(\{ dt: this\.pendingDt, foot, drive \}\)\) this\.pendingDt = 0\n/, 'recorded just before the one request line, which is unchanged: the velocity the realm applies')
  // Its answer is the next state the worker sends: paired there, before anything else reads it.
  const received = between(src, '  private received(s: StepState, prev: StepState): void {', '\n  }\n')
  assert.match(received, /^ {4}this\.fresh = true\n(?:\s*\/\/.*\n)*\s*if \(this\.netClient\?\.status === 'joined'\) this\.netMove = this\.netMoveOf\(s\)$/m)
  const moveOf = between(src, '  private netMoveOf(s: StepState): NetMove {', '  /** The session over')
  assert.match(moveOf, /const n = s\.physics\.steps/, 'the substeps the realm ran')
  assert.match(moveOf, /mode: 'drive', x: 0, z: 0, \.\.\.\(s\.wheels && \{ wheels: s\.wheels \}\)/, 'at the wheel the command the car ran; the chassis is the claim')
  assert.match(moveOf, /const door = doorOf\(s\.events\)/, 'the step\'s own door: never one a correction made or forced')
  assert.equal(moveOf.match(/\.\.\.\(door && \{ door \}\)/g)?.length, 2, 'on foot and at the wheel')
  assert.match(moveOf, /fix: sent\.fix/)
  assert.equal(moveOf.match(/shift: sent\.shift/g)?.length, 2, 'the drift epoch the step ran under, on foot and at the wheel')
  // The door rule itself: the last of the step's own doors, a later correction cancelling it.
  const doors = between(read('./simProtocol.ts'), 'export function doorOf(', '\n}\n')
  assert.match(doors, /door = e\.room \? undefined : \{ enter: \{ car: e\.index, state: e\.state \} \}/)
  assert.match(doors, /door = e\.forced \? undefined : \{ exit: \{ x: e\.x, z: e\.z \} \}/)
  const nf = between(src, '  private netFrame(', '  /**\n   * A realm state as the room')
  assert.match(nf, /if \(state !== 'joined'\) return/, 'nothing offered or read between sessions')
  assert.match(nf, /const m = this\.netMove\n\s*this\.netMove = null\n(?:\s*\/\/.*\n)*\s*if \(m\) \{\n\s*const done = c\.move\(m\)\n\s*if \(done === 'stale' \|\| done === 'refused'\) this\.netDropped\+\+/, 'each state reported once; dropped only what the room could not keep')
  assert.match(nf, /if \(fix && fix\.fix > this\.netFix\) \{\n\s*this\.netFix = fix\.fix\n(?:\s*\/\/[^\n]*\n)*\s*this\.sim\.send\(fix\.car \? \{ c: 'netCar', i: fix\.car\.index, state: fix\.car\.state \} : \{ c: 'teleport', x: fix\.x, z: fix\.z, y: fix\.y \}, true\)/, 'each correction once: the car in the room\'s state, or a teleport at the truth\'s own height, ahead of anything the player queued')
  // A drift on foot: the live body carried by what the room still asks, after the correction above, stamped on the steps after it.
  assert.match(nf, /const drift = c\.drift\(\)\n\s*if \(drift\) \{\n\s*this\.netShift = drift\.epoch\n\s*this\.sim\.send\(\{ c: 'shift', dx: drift\.x, dy: drift\.y, dz: drift\.z \}, true\)/)
  before(nf, "c: 'teleport'", "c: 'shift'", 'a correction in the same frame is queued first; the shift then applies on the truth')
  assert.match(nf, /if \(fix\.fix > 1 && !fix\.drift\) this\.toast\(/, 'a drift resync is no correction to tell the player about')
  assert.match(nf, /this\.sim\.send\(\{ c: 'room', on: true \}, true\)/, 'the room mode on the welcome, ahead of its teleport and of the player\'s commands')
  assert.equal(nf.match(/sim\.send\(/g)?.length, 3, 'the room mode, the correction and the drift shift are all the room may ask of the realm')
  // The realm client's lane for them: what is sent `first` goes ahead of everything queued the ordinary way.
  const client = read('./simClient.ts')
  assert.match(client, /if \(first\) this\.#first\.push\(cmd\)\n\s*else this\.#queue\.push\(cmd\)/)
  assert.match(client, /const cmds = this\.#first\.length > 0 \? \[\.\.\.this\.#first, \.\.\.this\.#queue\] : this\.#queue/)
  assert.match(nf, /this\.netPeers = c\.poses\(performance\.now\(\)\)/)
  assert.doesNotMatch(nf, /sim\.request|sendChat|sendPing|connect\(/, 'the engine neither steps the realm for the room nor speaks for the player')
  const present = between(src, '  private present(', '  private presentView(')
  assert.match(present, /^ {4}this\.netView\.update\(this\.netPeers\)$/m)
  before(present, 'this.flushDissolve()', 'this.netView.update(this.netPeers)', 'after the dissolve amounts')
  before(present, 'this.netView.update(this.netPeers)', 'const split = this.views.length > 1', 'before any viewport is drawn')
  assert.doesNotMatch(between(src, '  private present(', 'const cam = this.world.camera'), /netView/, 'nothing drawn while render is off')
  assert.ok(!frame.includes('netView'), 'frame() draws nothing of it')
  const listen = between(src, '  private listen(', '  private wallsTo(')
  assert.match(listen, /f\.peers = this\.netVoices\.size > 0 \? this\.placePeers\(\) : undefined/)
  before(listen, 'this.placePeers()', 'this.audio.update(f)', 'placed before the soundscape reads the frame')
  const place = between(src, '  private placePeers(', '  /** Enter the nearest car')
  assert.match(place, /slot\.walls = this\.wallsTo\(p\.x, p\.z\)/, 'the walls from this head')
  assert.match(place, /roomAt\(this\.world\.boxes, p\.x, p\.z\)/, 'their room, found again on a cell change')
  assert.doesNotMatch(place, /new |\.push\(|\.map\(|\.filter\(/, 'no allocation per frame beyond the first slot')
})

test('the room\'s chat and pings become captions through the feed; the snapshot reports the session; dispose leaves it', () => {
  const src = read('./engine.ts')
  const chat = between(src, '  netChat(from: number', '  /**\n   * A ping from the room')
  assert.match(chat, /if \(!this\.captionsOn \|\| this\.halted \|\| this\.disposed\) return/)
  assert.match(chat, /kind: 'peer' as const/, 'the peer kind: read as speech, held like speech')
  assert.match(chat, /this\.captions\.push\(\{ \.\.\.e, phase: 'start' \}, this\.rig\.pose\)\n\s*this\.captions\.push\(\{ \.\.\.e, phase: 'stop' \}, this\.rig\.pose\)/)
  assert.doesNotMatch(chat, /speak\(|cue\(|sim\.send/, 'nothing spoken, nothing commanded')
  const ping = between(src, '  netPing(from: number', '  /** A peer\'s name')
  assert.match(ping, /this\.audio\.cuePing\(x, z, `\$\{this\.netName\(from\)\}: \$\{PING_WORDS\[kind\]\}`\)/, 'captioned by the cue\'s own event')
  assert.match(ping, /this\.views\[k\]\.audio\.cuePing\(x, z\)/, 'heard by every local player')
  assert.doesNotMatch(ping, /pings\.place|rallyFor|onRally|sim\.send/, 'on no board, asking nobody over')
  const snapshot = between(src, '  snapshot(): SipocSnapshot {', '  terminalBridge(')
  assert.match(snapshot, /\.\.\.\(this\.netClient && \{ net: \{ state: this\.netClient\.status, peers: this\.netPeers\.length, dropped: this\.netDropped \} \}\)/)
  assert.match(read('../05_Observe_Environment/telemetry.ts'), /net\?: \{ state: NetState; peers: number; dropped: number \}/)
  assert.match(between(src, '  halt(reason: string): void {', '  dispose(): void {'), /this\.netClient\?\.leave\(\)/)
  const dispose = between(src, '  dispose(): void {', '\n}')
  assert.match(dispose, /this\.netUnvoice\?\.\(\)/)
  assert.match(dispose, /this\.netClient\?\.leave\(\)/)
  assert.match(dispose, /this\.netView\.dispose\(\)/)
  // The voices: attached under the peer's name to player 1's soundscape, let go after the grace once their pose stops coming.
  const set = between(src, '  setNet(client: NetHost): void {', '  /**\n   * The console\'s hold')
  assert.match(set, /this\.audio\.attachPeer\(stream, id, this\.netName\(id\)\)/)
  assert.match(between(src, '  private netFrame(', '  /**\n   * A realm state as the room'), /this\.simTime - v\.since >= NET\.voiceGraceS && !this\.netPeers\.some\(\(p\) => p\.id === id\)/)
  // A session over forgets its corrections (the next one starts from the welcome) and takes the realm out of room mode.
  const letGo = between(src, '  private netLetGo(why: string): void {', '\n  }\n')
  assert.match(letGo, /this\.netMove = null\n\s*this\.netFix = 0\n\s*this\.netSent\.fix = 0\n\s*this\.netShift = 0\n\s*this\.netSent\.shift = 0/)
  assert.match(letGo, /if \(this\.netRoom && !this\.halted && !this\.disposed\) this\.sim\.send\(\{ c: 'room', on: false \}, true\)/)
})

test('the view: the crowd\'s body and the fleet\'s car, hidden until poses arrive, added to the scene at boot', () => {
  const src = read('./engine.ts')
  const create = between(src, '  static async create(', '  /** The minimap')
  assert.match(create, /const netView = new NetView\(\)\n\s*world\.scene\.add\(netView\.people, netView\.cars\)/)
  before(create, 'world.scene.add(netView.people, netView.cars)', 'compileAsync(', 'compiled with the rest')
  assert.match(read('../03_Spawn_Agents/crowd.ts'), /^export function bodyGeometry\(variant: number, detailed = true\): BufferGeometry \{$/m)
  assert.match(read('./fleetView.ts'), /^export function carBodyGeometry\(\): ExtrudeGeometry \{$/m)
  const view = read('./netView.ts')
  assert.match(view, /import \{ bodyGeometry \} from '\.\.\/03_Spawn_Agents\/crowd\.ts'/)
  assert.match(view, /import \{ carBodyGeometry \} from '\.\/fleetView\.ts'/)
  for (const spec of specifiers(view)) assert.ok(!/10_Network|simCore|simClient|simHost|physics\.worker|vehicles|laws|ring0/.test(spec), `netView.ts imports ${spec}`)
  assert.match(view, /mesh\.castShadow = false/)
})

test('App: the client built once and never connected here, the room\'s lines screened again, the token kept on this machine, the client handed to the engine and the bridge', () => {
  const app = read('../App.tsx')
  assert.equal(app.match(/createNetClient\(\{/g)?.length, 1)
  assert.doesNotMatch(app, /\.connect\(/, 'nothing connects at boot: only the console\'s join does, through the engine')
  assert.match(app, /^ {8}e\.setNet\(net\)$/m)
  assert.match(app, /const name = admissibleName\(m\.name\), text = admissibleChat\(m\.text\)\n\s*if \(name !== null && text !== null\) e\.netChat\(m\.from, name, text\)/, 'the host is not trusted either')
  assert.match(app, /onPing: \(m\) => e\.netPing\(m\.from, m\.kind, m\.x, m\.y, m\.z\)/)
  assert.match(app, /const NET_TOKEN_KEY = 'civic-simulation:net:v1'/)
  assert.match(app, /net: netBridge\(e\.net, pageStore\(NET_TOKEN_KEY\)\)/)
  assert.match(app, /^ {14}net: e\.net,$/m, '?debug: __SIM__.net')
  const bridge = between(app, 'function netBridge(', '\n}\n')
  assert.match(bridge, /const t = token\?\.trim\(\) \|\| kept \|\| ''/, 'a token given, else the kept one')
  assert.match(bridge, /store\.save\(token\.trim\(\)\)/, 'kept for next time')
  assert.match(bridge, /store\.save\(''\)/, 'forget drops it')
  assert.doesNotMatch(bridge, /localStorage/, 'through the page store like every other key')
  assert.equal(app.match(/Engine\.create\(/g)?.length, 1)
  // The bridge: an optional member, absent until the host attaches a client; the offline bridge has none.
  const b = read('./terminal/bridge.ts')
  assert.match(b, /^export interface NetBridge \{$/m)
  assert.match(b, /^ {2}net\?: NetBridge$/m)
  assert.match(b, /join\(url: string, token\?: string\): Promise<string>/)
  assert.doesNotMatch(between(b, 'export function offlineBridge(', '\n}'), /net:/)
})

test('air gap and the house style: nothing of the session reaches the realm\'s modules; the client never joins the page\'s boot; no forbidden word', () => {
  for (const f of ['./simProtocol.ts', './simCore.ts', './physics.worker.ts', './simHost.ts', './simClient.ts']) {
    assert.doesNotMatch(read(f), /netClient|replication|NetHost|NetPeer|RemotePlayer|RemotePose|netView|NetView/, `${f} knows nothing of the room`)
  }
  for (const f of ['./netView.ts', './netView.test.ts', '../10_Network/netClient.test.ts']) assert.doesNotMatch(read(f), FORBIDDEN, f)
  const engine = read('./engine.ts')
  for (const [from, to] of [['export interface NetHost {', 'export interface DebugSim {'], ['  setNet(client: NetHost): void {', '  /** Enter the nearest car'], ['const NET = {', 'const NO_PEERS']]) {
    assert.doesNotMatch(between(engine, from, to), FORBIDDEN, `${from} …`)
  }
  // The crowd stays the worker's: no remote pose is ever uploaded as a crowd frame or sent as a step.
  const nf = between(engine, '  private netFrame(', '  /** The session over')
  assert.doesNotMatch(nf, /crowd\.upload|crowdFrame|request\(/)
})
