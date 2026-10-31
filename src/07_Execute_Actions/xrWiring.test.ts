// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the headset's wiring across the engine, Input, the head rig, the frame pacer,
 * the session, the console, the bridge, the touch menu and App: the session asked for inside the user's gesture
 * with no await before the browser; the headset's loop driving the frame while the page's own frames are let go;
 * the head rig composed and given back; the controllers' edges under the pad's shield; the post chain, the ghost
 * and the canvas resize held off under a headset. Structural: nothing here runs a browser, and no headset has run
 * any of it (UNCONFIRMED on real hardware).
 * What breaks if it is removed? A refactor could ask for the session after an await (every browser refuses it
 * outside the activation), or leave the page's animation loop fighting the headset's.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const ENGINE = read('./engine.ts')
const INPUT = read('../04_Connect_Hardware/input.ts')
const HEAD = read('./head.ts')
const CINEMA = read('./cinema.ts')
const SESSION = read('./xrSession.ts')
const COMMANDS = read('./terminal/commands.ts')
const BRIDGE = read('./terminal/bridge.ts')
const TOUCH = read('../04_Connect_Hardware/TouchControls.tsx')
const APP = read('../App.tsx')
const NAMESPACE = read('../05_Observe_Environment/namespace.ts')
const TELEMETRY = read('../05_Observe_Environment/telemetry.ts')

const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing ${from}`)
  const b = src.indexOf(to, a + from.length)
  assert.ok(b > a, `missing ${to} after ${from}`)
  return src.slice(a, b)
}
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}

test('the engine owns one headset mapper and one session, built over the renderer; Input holds the mapper before any session can fill it', () => {
  assert.match(ENGINE, /^ {2}private readonly xrInput = new XrMapper\(\)$/m)
  assert.match(ENGINE, /^ {2}private readonly xr: XrPresence$/m)
  before(ENGINE, 'this.input.setXr(this.xrInput)', 'this.xr = new XrPresence(', 'Input reads the mapper before a session exists')
  assert.match(ENGINE, /this\.xr = new XrPresence\(xrSystemOf\(\(globalThis as \{ navigator\?: object \}\)\.navigator\), p\.gpu\.renderer as unknown as XrRendererLike, this\.xrHost\(\), this\.xrInput\)/)
  assert.match(ENGINE, /void this\.xr\.supported\(\)\.then\(\(m\) => \{ this\.xrModes = m \}\)/)
  assert.match(ENGINE, /this\.disposed = true\n\s+this\.stopLongTasks\(\)\n\s+this\.xr\.dispose\(\)/, 'the session ends before the renderer goes')
})

test('the frame: only the headset\'s frames run while presenting; the head offset is set before Input polls; a driven body faces the car', () => {
  assert.match(ENGINE, /if \(this\.xr\.presenting && \(this\.gpu\.renderer as unknown as XrRendererLike\)\.xr\.getFrame\(\) === null\) return/)
  before(ENGINE, '.xr.getFrame() === null) return', 'this.pacer.tick(nowMs)', 'a page frame without a headset frame is let go before anything is paced')
  before(ENGINE, 'this.xrInput.headOffset = this.rig.headset ? this.rig.pose.yaw - input.yaw : 0', 'input.poll(dt)', 'the offset is this frame\'s posed head against the body yaw, set before the poll reads the sticks')
  assert.match(ENGINE, /input\.yaw = this\.rig\.headset \? yawFacing\(h\) : carriedYaw\(input\.yaw, this\.carHeading, h\)/)
})

test('under a headset: the canvas resize waits, the post chain and the ghost are off, the pacer passes every frame through, and the host gives it all back', () => {
  assert.match(ENGINE, /resize\([^)]*\)[^{]*\{\n(?:\s*\/\/[^\n]*\n)*\s+if \(this\.rig\.headset\) return/, 'three refuses setSize while presenting')
  assert.match(ENGINE, /if \(on && this\.rig\.headset\) return 'needs the post-processing chain, which is off under a headset'/)
  assert.match(ENGINE, /if \(this\.rig\.headset\) k\.post = false/)
  const host = between(ENGINE, '  private xrHost(): XrHost {', '\n  }\n')
  assert.match(host, /started: \(mode, blend\) => \{\n\s+this\.rig\.setHeadset\(composerFor\(this\.gpu\.renderer as unknown as XrRendererLike\)\)\n\s+if \(this\.pacer\) this\.pacer\.passthrough = true\n\s+this\.applyTier\(\)/)
  assert.match(host, /ended: \(\) => \{\n\s+this\.rig\.setHeadset\(null\)\n\s+if \(this\.pacer\) this\.pacer\.passthrough = false\n\s+this\.applyTier\(\)\n\s+if \(!this\.disposed\) \{ this\.resize\(\); this\.toast\('Headset', 'off'\) \}/)
  assert.match(host, /sources: \(list\) => this\.input\.hal\.setHeadset\(list\)/)
  assert.match(host, /this\.input\.press\(near \? 'interact' : 'ping'\)/, 'a pinch is the interaction at hand, else a ping')
  assert.match(CINEMA, /if \(this\.passthrough\) return this\.present\(nowMs\)/)
})

test('the session is asked for synchronously inside the gesture, from the console and the touch menu; split screen refuses it', () => {
  assert.match(ENGINE, /^ {2}enterXr\(mode: 'immersive-vr' \| 'immersive-ar'\): Promise<string> \{\n\s+if \(this\.disposed\) return Promise\.resolve\('the city has stopped'\)\n\s+if \(this\.views\.length > 1\) return Promise\.resolve\('no headset while the screen is split'\)\n\s+return this\.xr\.enter\(mode\)\n\s+\}/m)
  assert.doesNotMatch(ENGINE, /async (enterXr|xrCommand|toggleXr)\(/, 'no await before the browser is asked: the user activation would be spent')
  assert.match(ENGINE, /^ {2}toggleXr\(\): void \{\n\s+if \(this\.xr\.presenting\) \{ void this\.xr\.exit\(\); return \}/m)
  assert.match(ENGINE, /xr: \(arg\?: 'vr' \| 'ar' \| 'off'\) => this\.xrCommand\(arg\),/)
  assert.match(ENGINE, /xr: \{ state: this\.xr\.state, detail: this\.xrLine\(\) \},/)
  const cmd = between(COMMANDS, '  xr(args, b) {', '\n  },\n')
  assert.match(cmd, /const r = b\.xr\(a\)\n\s+if \(typeof r === 'string'\) return/)
  assert.doesNotMatch(cmd, /await/)
  assert.match(COMMANDS, /\{ name: 'xr', usage: 'xr \[vr\|ar\|off\]', summary: /)
  assert.match(COMMANDS, /^ {2}xr: \['ar', 'off', 'vr'\],$/m)
  assert.match(BRIDGE, /^ {2}xr\(arg\?: 'vr' \| 'ar' \| 'off'\): string \| Promise<string>$/m)
  assert.match(BRIDGE, /xr: down,/)
  assert.match(TOUCH, /\.\.\.\(host\.onHeadset \? \[\{ label: 'Headset', on: host\.headset === true, run: host\.onHeadset \}\] : \[\]\),/)
  assert.match(APP, /onHeadset: hud\.supplier\.xr\.state === 'unsupported' \? undefined : \(\) => engine\.toggleXr\(\),/)
  assert.match(APP, /headset: hud\.supplier\.xr\.state === 'vr' \|\| hud\.supplier\.xr\.state === 'ar',/)
})

test('Input: the headset mapper is read with the pad under the same shield; its turn moves the body yaw once; suspend and release reset it; it counts as engagement', () => {
  const readXr = between(INPUT, '  private readXr(): number {', '\n  }\n')
  assert.match(readXr, /const edges = xr\.read\(\)\n\s+if \(xr\.turn !== 0\) \{ this\.yaw -= xr\.turn; xr\.turn = 0 \}\n\s+if \(xr\.active\) this\.lastSource = 'gamepad'\n\s+return edges/)
  assert.match(INPUT, /const a = this\.analog, p = xr \? mergeAnalog\(this\.padXr, this\.pad, xr\.analog\) : this\.pad/)
  assert.equal(INPUT.match(/this\.xr\?\.reset\(\)/g)?.length, 2, 'suspend and releaseHeld')
  assert.match(INPUT, /return this\.locked \|\| this\.touchEngaged \|\| this\.mapper\.used \|\| \(this\.xr\?\.used \?\? false\)/)
})

test('the head rig: under a headset the camera is composed under the rig and detached with its world transform; the eye point stays the driver\'s', () => {
  assert.match(HEAD, /if \(this\.compose\) \{ this\.applyHeadset\(camera, feetX, feetY, feetZ, yaw\); return \}/)
  assert.match(HEAD, /if \(this\.compose\) \{ this\.applyHeadset\(camera, x, y - this\.headHeight, z, yaw\); return \}/)
  const apply = between(HEAD, '  private applyHeadset(', '\n  }\n')
  assert.match(apply, /camera\.parent = rig\n\s+this\.compose!\(camera\)\n\s+camera\.parent = null\n\s+camera\.rotation\.order = 'YXZ'\n\s+camera\.matrix\.copy\(camera\.matrixWorld\)\n\s+camera\.matrix\.decompose\(camera\.position, camera\.quaternion, camera\.scale\)/)
  assert.match(apply, /pose\.pitch = camera\.rotation\.x/, 'unclamped: the headset owns the pitch')
})

test('the session: the loop is registered before setSession and the end listener after it; the loop is given back on every end; the state reaches the HUD and the namespace', () => {
  const start = between(SESSION, '  private async start(', '\n  }\n')
  before(start, 'void r.setAnimationLoop(this.loop)', 'await r.xr.setSession(session)', 'setSession captures the loop registered at that moment')
  before(start, 'await r.xr.setSession(session)', "session.addEventListener('end', this.onEnd)", "three's own end handler runs first")
  assert.match(start, /r\.xr\.cameraAutoUpdate = false/)
  const detach = between(SESSION, '  private detach(', '\n  }\n')
  assert.match(detach, /void r\.setAnimationLoop\(null\)\n\s+r\.xr\.enabled = false/)
  assert.match(SESSION, /required: Object\.freeze\(\['webgpu'\]\)/)
  assert.match(TELEMETRY, /xr: \{ state: XrState; detail: string \}/)
  assert.match(NAMESPACE, /put\('Hardware', 'Bus', 'xr', sup\.xr\.state\)/)
})
