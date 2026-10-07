/**
 * Why does this file exist? It pins the page-side wiring of the operator's ping (08_Swarm/ping.ts), which the
 * engine, the HUD and the hardware layer carry and Node cannot run: the one edge from the Q key, the middle mouse
 * button, a pad's right shoulder and the touch button; the engine's frame hook (the look ray from the head just
 * posed, the pick over the page's own copies, the board, the cue that captions it, the rally hand-off through the
 * host and never a command of the engine's own); the snapshot's marks; the minimap ring and the world chip; and
 * that nothing of it reaches the physics realm's modules.
 * What breaks if it is removed? The ping could quietly move off the head's ray, read the realm instead of the
 * page's copies, send a rally around the recruiter, or vanish from the HUD, unnoticed.
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

test('wiring: one ping edge from the key, the middle button, the right shoulder and the touch button', () => {
  const input = read('../04_Connect_Hardware/input.ts')
  assert.match(input, /export type Action = [^\n]*'ping'/)
  assert.match(input, /KeyQ: 'ping'/)
  assert.match(between(input, "on(canvas, 'pointerdown'", "on(canvas, 'pointermove'"), /if \(e\.button === 1\) \{\n\s*if \(!this\.suspended\) \{ this\.queued\.add\('ping'\)/, 'the middle button pings, never drags')
  assert.match(input, /if \(edges & PAD_EDGE\.ping\) this\.queued\.add\('ping'\)/)
  const pad = read('../04_Connect_Hardware/gamepad.ts')
  assert.match(pad, /ping: 16/)
  assert.match(pad, /if \(rising & \(1 << PAD\.r1\)\) edges \|= PAD_EDGE\.ping/)
  const touch = read('../04_Connect_Hardware/TouchControls.tsx')
  assert.equal(touch.match(/<TapButton label="Ping"[^\n]*input\.press\('ping'\)/g)?.length, 2, 'on foot and at the wheel')
})

test('wiring: the engine pings from the head just posed over its own copies, cues and captions it, and offers a walk ping to the host alone', () => {
  const src = read('./engine.ts')
  const frame = between(src, '  frame(nowMs: number): void {', '  /** One drawn frame')
  assert.match(frame, /^ {4}if \(input\.take\('ping'\)\) this\.pingAt\(this\.pingKindFor\(this\.simTime\)\)$/m)
  before(frame, 'this.rig.onFoot(', "if (input.take('ping'))", 'after the head is posed, so the ray is this frame\'s')
  before(frame, "if (input.take('ping'))", 'this.contactPulse.update(', 'before the contact pulse and the drawn frame')
  const ping = between(src, '  pingAt(kind: PingKind): Pick | null {', '  /** The kind the key, button or touch asks')
  assert.match(ping, /aimRay\(this\.rig\.pose, this\.ray\)/, 'the look ray is the head\'s')
  assert.match(ping, /pickPing\(this\.ray, \{ frame: this\.crowdPose, agents: this\.options\.agents, poses: s\.poses, suv: this\.sim\.meta\.suv, furniture: this\.world\.furniture \}, this\.lastPick\)/, 'the page\'s own copies')
  assert.match(ping, /this\.pings\.place\(kind, this\.lastPick, this\.simTime\)/, 'simulation seconds, no clock of its own')
  assert.match(ping, /this\.audio\.cuePing\(ping\.x, ping\.z, `\$\{PING_WORDS\[kind\]\}: \$\{pingWhat\(ping\)\}`\)/, 'cued and captioned with its label')
  assert.match(ping, /if \(ping\.kind === 'go' \|\| ping\.kind === 'gather'\) this\.rallyFor\(ping\)/)
  assert.doesNotMatch(ping, /sim\.send/, 'a ping sends the realm nothing')
  const rally = between(src, '  private rallyFor(ping: Ping): void {', '  /** The pings standing now')
  assert.match(rally, /rallyPlan\(this\.pings, recruits, operator, this\.simTime, agent\)/)
  assert.match(rally, /const operator = st\.driving >= 0 \? null : \{ x: this\.rig\.pose\.x, z: this\.rig\.pose\.z \}/)
  assert.match(rally, /if \(!recruits\.some\(\(r\) => r\.arrived\)\) return/, 'quiet while nobody is tethered')
  assert.match(rally, /const fn = this\.onRally/, 'the host\'s recruiter, or nothing')
  assert.doesNotMatch(rally, /sim\.send|recruitHost/, 'never a rally of the engine\'s own')
  // The engine's only rally send is the recruiter's, through RecruitHost.
  assert.equal(src.match(/c: 'rally'/g)?.length, 1)
  assert.ok(between(src, '  recruitHost(): RecruitHost {', '  /** The pedestrian speaking').includes("else if (cmd?.c === 'rally')"))
  // The crowd copy the pick reads is taken before the frame goes back to the worker.
  const received = between(src, '  private received(', '    for (const ev of s.events) {')
  before(received, 'this.crowdPose.set(frame.subarray(0, 4 * n))', 'this.crowd.upload(', 'copied before the upload')
  assert.match(src, /onRally: \(\(request: RallyRequest\) => void\) \| null = null/)
  // The snapshot carries the marks, with their place on the screen, only while some stand.
  assert.match(between(src, '  snapshot(): SipocSnapshot {', '  terminalBridge('), /\.\.\.\(pings && \{ pings \}\)/)
  const marks = between(src, '  private pingMarks(', '  /** A new state from the physics realm')
  assert.match(marks, /v\.set\(p\.x, p\.y, p\.z\)\.project\(cam\)/)
  assert.match(marks, /sx: ahead \? \(v\.x \+ 1\) \/ 2 : Number\.NaN, sy: ahead \? \(1 - v\.y\) \/ 2 : Number\.NaN/)
  assert.doesNotMatch(ping + rally + marks, /target/i, 'not the word the console forbids')
  assert.match(read('../05_Observe_Environment/telemetry.ts'), /pings\?: HudPing\[\]/)
  assert.match(read('./audio.ts'), /cuePing\(x: number, z: number, label\?: string\): boolean/)
})

test('wiring: the HUD rings every ping on the minimap and chips the newest over the world; the host hands a rally to the recruiter', () => {
  const hud = read('./Hud.tsx')
  assert.match(hud, /for \(const p of s\.output\.pings \?\? \[\]\) \{/, 'a ring per mark on the minimap')
  assert.match(hud, /const newestPing = s\.output\.pings\?\.at\(-1\)/)
  assert.match(hud, /\{newestPing\.distance\.toFixed\(0\)\} m/, 'the distance on the chip')
  assert.ok(hud.includes('{visible && pingChip}'), 'a HUD marker: it goes with the H key')
  const app = read('../App.tsx')
  assert.match(app, /e\.onRally = \(req\) => \{ void r\.rally\(req\.agent, req\.x, req\.z\)/, 'the recruiter decides on the page, then the realm')
  // Nothing of the ping crosses to the realm: the protocol, the core and the worker name none of it.
  for (const file of ['./simProtocol.ts', './simCore.ts', './physics.worker.ts']) {
    assert.doesNotMatch(read(file), /ping\.ts|PingBoard|pickPing|aimRay|onRally/, file)
  }
})

test('pings are player 1\'s alone: the engine takes one from seat 0\'s input only, and drops every other seat\'s press each frame', () => {
  const engine = read('./engine.ts')
  const taken = engine.indexOf("if (input.take('ping')) this.pingAt(")
  const drained = engine.indexOf("this.input.intent(this.views[k].seat).take('ping')")
  assert.ok(taken > 0, 'player 1 pings from seat 0')
  assert.ok(drained > taken, 'the other seats are drained right after')
  assert.match(engine.slice(drained - 200, drained), /for \(let k = 1; k < this\.views\.length; k\+\+\)/)
  assert.equal(engine.split("take('ping')").length - 1, 2, 'no other place takes a ping')
  assert.match(read('../03_Spawn_Agents/skills.ts'), /export const RECRUITING_PLAYER = 0\b/)
})
