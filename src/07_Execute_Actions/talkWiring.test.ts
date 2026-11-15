// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the engine's side of who looks at the operator (03_Spawn_Agents/talkGaze.ts),
 * which Node cannot run: nobody is named until a caller names them, and nothing but a pedestrian's index can be;
 * the recruits standing by are read from the kernel's own report before the upload hands the frame back; every
 * animation frame eases the slots toward the people the operator is talking to (nobody from a car, nobody once a
 * named person is out of reach, which ends that conversation) and hands them to the crowd's uniforms with the place
 * their heads look at, as TalkGaze.look keeps it, written there alone; and the boot gives the engine the crowd
 * view's slots.
 * What breaks if it is removed? Someone could put the old eye write back (every passer-by within reach staring), let a
 * conversation outlive its person walking away, or name the operator's own figure, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const ENGINE = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8')
// crowdCompute.ts imports the kernel's .wgsl, which Node cannot load: read as text.
const COMPUTE = readFileSync(new URL('../03_Spawn_Agents/crowdCompute.ts', import.meta.url), 'utf8')
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

test('engine: the eye reaches the crowd in lookAtOperator alone, with the slots; the old write that had everyone near look is gone', () => {
  assert.equal((ENGINE.match(/this\.crowdGaze\.value\.set\(/g) ?? []).length, 1, 'one write of the eye')
  assert.doesNotMatch(ENGINE, /driving >= 0 \? 0 : 1\)/, 'no longer on for everyone afoot')
  const look = between(ENGINE, '  private lookAtOperator(driving: boolean, dt: number): void {', '\n  }\n')
  assert.match(look, /this\.talk\.look\(talkers, eye, driving, dt\)\n\s+const at = this\.talk\.eye\n\s+this\.crowdGaze\.value\.set\(at\[0\], at\[1\], at\[2\], 1\)\n\s+this\.crowdTalk\(this\.talk\.who, this\.talk\.weight\)/, 'the slots eased and the place their heads look at kept (held through a cut: a car seat, another floor or a teleport swings nobody round), then both handed over')
  assert.doesNotMatch(look, /crowdGaze\.value\.set\(eye\./, 'never the raw eye, which jumps when the operator gets into a car or changes floor')
  assert.match(look, /talkers\.length = 0\n\s+if \(!driving && seen\) \{/, 'nobody from a car, nobody without an eye')
  assert.match(look, /if \(this\.talkingTo > PLAYER_INDEX\) \{\n\s+const near = withinTalk\(this\.crowdPose, this\.talkingTo, eye\)\n\s+if \(near === false\) this\.talkingTo = -1\n\s+else if \(near === true\) talkers\.push\(this\.talkingTo\)\n\s+\}\n\s+for \(const a of this\.standingBy\) if \(a !== this\.talkingTo && withinTalk\(this\.crowdPose, a, eye\) === true\) talkers\.push\(a\)/, 'the named person first, while within reach (out of reach the conversation ends; with no reading yet it waits), then the recruits standing by, within reach and on the floor')
  assert.equal((look.match(/talkers\.push\(/g) ?? []).length, 2, 'those two and nobody else: no passer-by is ever added')
  assert.equal((ENGINE.match(/\btalkers\.push\(/g) ?? []).length, 2, 'nor anywhere else in the engine')
})

test('engine: frame() looks after the operator\'s head is posed and the furnishing has ended, before the other seats\' heads', () => {
  const frame = between(ENGINE, '  frame(nowMs: number): void {', '  /** One drawn frame')
  assert.equal((frame.match(/this\.lookAtOperator\(driving >= 0, dt\)/g) ?? []).length, 1)
  before(frame, 'this.rig.onFoot(cam, av.x, av.feetY, av.z, input.yaw, input.pitch, dt)', 'this.lookAtOperator(driving >= 0, dt)', 'the eye of this frame')
  before(frame, 'this.endFurnish()', 'this.lookAtOperator(driving >= 0, dt)', 'after the furnishing line')
  before(frame, 'this.lookAtOperator(driving >= 0, dt)', 'this.poseView(this.views[k], k, st, dt)', 'before the other heads')
})

test('engine: setTalkingTo names a pedestrian by index or nobody; nobody is named to start with', () => {
  assert.match(ENGINE, /^ {2}private talkingTo = -1$/m)
  const set = between(ENGINE, '  setTalkingTo(agent: number | null): void {', '\n  }\n')
  assert.match(set, /this\.talkingTo = agent !== null && Number\.isInteger\(agent\) && agent > PLAYER_INDEX && agent < this\.options\.agents \? agent : -1/, 'never the operator\'s own figure, never past the crowd')
  assert.equal((ENGINE.match(/this\.talkingTo = /g) ?? []).length, 2, 'named by the setter, ended by the leash, nowhere else')
})

test('engine: the recruits standing by are those the kernel reports interviewing with no rally, read from the newest frame before the upload hands it back', () => {
  assert.match(COMPUTE, /^export const RENDER_FLOATS = 12$/m, 'pos, vel, pose: the pose block starts at 8n, its fourth float the activity')
  const stand = between(ENGINE, '  private standBy(s: StepState): void {', '\n  }\n')
  assert.match(stand, /if \(frame && frame\.length >= 3 \* 4 \* n\) \{/)
  assert.match(stand, /for \(const r of s\.recruits\) if \(!r\.rally && r\.agent > PLAYER_INDEX && r\.agent < n && frame\[8 \* n \+ 4 \* r\.agent \+ 3\] === ACTIVITY\.interviewing\) list\.push\(r\.agent\)/)
  assert.match(stand, /if \(!s\.recruits\.some\(\(r\) => r\.agent === list\[k\] && !r\.rally\)\) list\.splice\(k, 1\)/, 'a step without a frame keeps only those still recruited and not sent off')
  const received = between(ENGINE, '  private received(s: StepState, prev: StepState): void {', '\n  }\n')
  before(received, 'this.standBy(s)', 'this.crowd.upload(s.crowdFrame)', 'read before the upload hands the frame back')
})

test('engine: the boot hands the engine the crowd view\'s slots', () => {
  assert.match(ENGINE, /crowdGaze: view0\.gazeTarget, crowdRigs: \(stream\) => view0\.rigs\(stream\), crowdTalk: \(who, weight\) => view0\.talk\(who, weight\), ghost, options,/)
  assert.match(ENGINE, /^ {4}this\.crowdTalk = p\.crowdTalk$/m)
  assert.match(ENGINE, /import \{ TalkGaze, withinTalk \} from '\.\.\/03_Spawn_Agents\/talkGaze\.ts'/)
})
