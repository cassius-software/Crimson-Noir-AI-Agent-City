/**
 * Why does this file exist? It pins the page-side wiring of the network session (Phase 10.2), which the engine, the
 * host and the console carry and Node cannot run: the engine holds no network code (it imports nothing from
 * 10_Network, names no socket, and reaches the client only through the NetHost seam App hands it), offers one input
 * per frame after the head is posed and before the pacer, draws the room's poses as ghosts in present() alone,
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
  // The join: the Concierge's name, else the default; nothing is sent without the console's join.
  const net = between(src, '  get net(): NetControls {', '  netChat(')
  assert.match(net, /c\.connect\(url, token, this\.playerName\.trim\(\) \|\| NET\.defaultName\)/)
  assert.match(net, /this\.netJoin = \{ resolve, reject \}/, 'settled by the room\'s welcome or the socket\'s end (netFrame)')
})

test('each frame: one input after the head is posed and before the pacer; the poses drawn in present() alone; the voices placed before the soundscape', () => {
  const src = read('./engine.ts')
  const frame = between(src, '  frame(nowMs: number): void {', '  /** One drawn frame')
  assert.match(frame, /^ {4}this\.netFrame\(st, driving\)$/m)
  before(frame, 'this.rig.onFoot(', 'this.netFrame(st, driving)', 'the heading the input carries is this frame\'s')
  before(frame, 'this.dissolve.update(realDt / 1000)', 'this.netFrame(st, driving)', 'after the local scans')
  before(frame, 'this.netFrame(st, driving)', 'this.pacer.tick(nowMs)', 'every animation frame, drawn or not')
  const nf = between(src, '  private netFrame(', '  /** The session over')
  assert.match(nf, /if \(state !== 'joined'\) return/, 'nothing offered or read between sessions')
  assert.match(nf, /if \(!c\.sendInput\(vx, vz, heading\)\) this\.netDropped\+\+/)
  assert.match(nf, /this\.netPeers = c\.poses\(performance\.now\(\)\)/)
  assert.match(nf, /vx = Math\.sin\(heading\) \* speed\n\s*vz = Math\.cos\(heading\) \* speed/, 'at the wheel the car\'s own velocity, the realm\'s forward')
  assert.doesNotMatch(nf, /sim\.send|sim\.request|sendChat|sendPing|connect\(/, 'the engine neither commands the realm for the room nor speaks for the player')
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
  assert.match(between(src, '  private netFrame(', '  /** The session over'), /this\.simTime - v\.since >= NET\.voiceGraceS && !this\.netPeers\.some\(\(p\) => p\.id === id\)/)
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
