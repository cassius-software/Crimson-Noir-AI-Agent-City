// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of talking to the person near (talk.ts over the engine's
 * talkHost()), which the engine carries and Node cannot run. The followed row is read from every state after the
 * contact scan and before the crowd frame goes back to the worker. The label's place is projected in present(), after
 * the frustum is packed, and the render switch is checked outside frame(), which keeps its one use of it. The talk key
 * is taken right after the microphone's mute and opens nothing at the wheel. A partner's provider voice is spoken
 * with no words for the caption and marks itself, Sloane's voice and a pedestrian's clear the mark, and the split
 * listener keeps both of its pinned lines. The host's section sits after the halt's handler, outside the slices the
 * split-screen and voice tests pin. It also holds the conversation controller to one staring call on opening and one
 * on closing, and keeps the console's files from importing any of it.
 * What breaks if it is removed? A label that reads a frame already handed back, a talk press that opens a
 * conversation on the first frame out of a car, a hired agent's voice captioned with its words or stuck where it
 * started, a pinned slice broken by a misplaced section, or heads turning every tick, all with every unit test green.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}
const before = (src: string, first: string, second: string, why: string): void => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}
/** A method's text, from its signature line to its closing brace at two spaces. */
const method = (src: string, head: string): string => between(src, head, '\n  }\n')
const count = (src: string, re: RegExp): number => src.match(re)?.length ?? 0

const ENGINE = read('./engine.ts')
const FRAME = between(ENGINE, '  frame(nowMs: number): void {', '  /** One drawn frame')

test('engine: the followed row is read from every state after the contact scan and before the upload hands the frame back', () => {
  const received = between(ENGINE, '  private received(', '    for (const ev of s.events) {')
  assert.match(received, /^ {4}if \(s\.crowdFrame && this\.talkRow >= 0\) this\.talkFollow\(s\.crowdFrame\)$/m, 'only while a row is followed')
  before(received, 'if (s.crowdFrame) this.contactScan(s)', 'this.talkFollow(s.crowdFrame)', 'after the contact scan, so its order pin holds')
  before(received, 'this.talkFollow(s.crowdFrame)', 'this.crowd.upload(', 'before the frame goes back to the worker')
  assert.equal(count(ENGINE, /this\.talkFollow\(/g), 1, 'read in one place')
  const follow = method(ENGINE, '  private talkFollow(frame: Float32Array): void {')
  assert.match(follow, /const o = 4 \* this\.talkRow/, 'the one row, x, feet y and z')
  assert.doesNotMatch(follow, /for \(/, 'one row a state, never the crowd')
})

test('engine: the label\'s place is projected in present() after the frustum is packed; the render switch is read outside frame()', () => {
  const present = between(ENGINE, '  private present(', '  private presentView(')
  before(present, 'packFrustumPlanes(this.frustum.planes, this.planes)', 'this.talkSpot = ', 'right after the frustum is packed')
  before(present, 'const mirror = ', 'this.talkSpot = ', 'with the mirror or the draft camera known')
  before(present, 'this.talkSpot = ', 'cam.quaternion.copy(this.headRot)', 'before the head goes back')
  assert.match(present, /this\.talkSpot = this\.talkRow >= 0 && !mirror && !this\.rig\.headset \? this\.screenOf\(this\.talkAt\.x, this\.talkAt\.y \+ LABEL_ABOVE, this\.talkAt\.z\) : OFF_SCREEN/)
  assert.doesNotMatch(between(present, '  private present(', 'const cam = this.world.camera'), /talkSpot/, 'nothing before the render guard')
  assert.equal(count(present, /this\.talkSpot = /g), 1, 'one projection a presented frame')
  assert.equal(count(FRAME, /this\.rendering/g), 1, 'frame() keeps its one use of the render switch')
  assert.doesNotMatch(FRAME, /talkSpot|talkHost/, 'frame() places no label')
  const host = method(ENGINE, '  talkHost(): TalkHost {')
  assert.match(host, /place: \(\) => \(this\.rendering && !this\.halted && !this\.disposed \? this\.talkSpot : OFF_SCREEN\)/, 'off the screen while nothing is drawn')
})

test('engine: the talk key is taken right after the mute, on foot only, and handed to the host', () => {
  assert.match(FRAME, /if \(mute\) this\.onMute\?\.\(\)\n(?:\s*\/\/[^\n]*\n)*\s*if \(input\.take\('talk'\) && driving < 0\) this\.onTalk\?\.\(input\.device === 'gamepad' \? 'pad' : 'keyboard'\)\n/, 'taken first, so a press at the wheel is used up there')
  assert.equal(count(ENGINE, /input\.take\('talk'\)/g), 1, 'one take')
  assert.match(ENGINE, /^ {2}onTalk: \(\(how: 'keyboard' \| 'pad'\) => void\) \| null = null$/m)
  before(ENGINE, '  onMute: (() => void) | null = null', '  onTalk: ', 'beside the mute')
  before(ENGINE, '  onTalk: ', '  onBrowse: ', 'and before the shop\'s')
  assert.equal(count(ENGINE, /this\.onTalk\?\.\(/g), 1, 'called from that line alone')
})

test('engine: a partner\'s provider voice speaks with no words for the caption and marks itself; Sloane\'s and a pedestrian\'s clear the mark', () => {
  const out = method(ENGINE, '  private talkOut(row: number, label: string): ConciergeOut {')
  assert.match(out, /this\.audio\.speak\(buffer, at\.x, at\.z, this\.wallsTo\(at\.x, at\.z\), undefined, \{ agent: row, label \}\)/, 'at their head, the walls between, no words')
  before(out, 'this.audio.speak(', 'this.talkVoice = true', 'marked once it sounds')
  assert.match(out, /this\.conciergeVoice = false/)
  assert.match(out, /if \(this\.halted \|\| this\.disposed\) throw /, 'nothing once the city has stopped')
  assert.match(out, /if \(row !== this\.talkRow \|\| !Number\.isFinite\(at\.x \+ at\.z\)\) throw /, 'only the one followed, where they stand')
  assert.doesNotMatch(out, /this\.speaker = /, 'the pedestrian speaker is left as it was')
  assert.equal(count(ENGINE, /this\.talkVoice = true/g), 1, 'marked by talkOut alone')
  const concierge = between(ENGINE, '  conciergeOut(): ConciergeOut {', '  /** The pedestrian speaking')
  assert.match(concierge, /this\.conciergeVoice = true\n\s*this\.talkVoice = false\n/)
  const speech = between(ENGINE, '  speechOut(): SpeechOut {', '  private panicked(')
  assert.match(speech, /this\.conciergeVoice = false\n\s*this\.talkVoice = false\n/)
  assert.match(ENGINE, /get speaking\(\): number \{\n\s*return this\.speaker >= 0 && this\.audio\.speaking && !this\.talkVoice \? this\.speaker : -1\n/, 'the HUD never names a pedestrian under a partner\'s voice')
})

test('engine: the listener follows a walking partner, and the split loop keeps both pinned lines with the partner\'s branch between', () => {
  const listen = between(ENGINE, '  private listen(', '  private wallsTo(')
  assert.match(listen, /const speaking = !this\.audio\.speaking \? undefined : this\.conciergeVoice \? \{ x: cam\.position\.x, z: cam\.position\.z \} : this\.talkVoice \? this\.talkVoiceAt\(\) : pedestrian\n/)
  assert.match(listen, /\n\s*if \(this\.conciergeVoice\) this\.listenFor\(this\.views\[k\], k, st, dt, pedestrian, undefined\)\n\s*else if \(this\.talkVoice\) this\.listenFor\(this\.views\[k\], k, st, dt, pedestrian, undefined\)\n\s*else this\.listenFor\(this\.views\[k\], k, st, dt, speaking, sp\.room\)\n/, 'players 2 to 4 keep hearing their pedestrian')
  before(listen, 'this.audio.update(f)', 'else if (this.talkVoice) this.listenFor(', 'after player 1\'s frame')
})

test('engine: the host\'s section sits after the halt\'s handler, outside the pinned split-screen and voice slices, and carries no forbidden word', () => {
  const panicked = ENGINE.indexOf('  private panicked(')
  assert.ok(panicked > 0, 'private panicked(')
  for (const head of ['  talkHost(): TalkHost {', '  private talkBlocked(', '  private talkScan(', '  private talkFollow(', '  private talkVoiceAt(', '  private talkOut(', '  private talkCaption(']) {
    assert.equal(ENGINE.split(head).length, 2, `${head} once`)
    assert.ok(ENGINE.indexOf(head) > panicked, `${head} after private panicked(`)
  }
  assert.doesNotMatch(between(ENGINE, '  speechOut(): SpeechOut {', '  private panicked('), /talkHost|talkOut\(/, 'the speech slice holds none of it')
  assert.doesNotMatch(between(ENGINE, '  recruitHost(): RecruitHost {', '  /** The pedestrian speaking'), /talkHost/, 'nor the recruiter\'s')
  assert.doesNotMatch(between(ENGINE, '  private listenFor(', '  private wallsTo('), /talk/i, 'nor the split listener')
  const bootloader = read('./bootloader.test.ts')
  const forbidden = /^const FORBIDDEN = \/(.+)\/([a-z]*)$/m.exec(bootloader)
  assert.ok(forbidden, 'the house regex is read from bootloader.test.ts')
  const section = between(ENGINE, '  talkHost(): TalkHost {', '  /** Rumble, the throttle trigger')
  assert.doesNotMatch(section, new RegExp(forbidden[1], forbidden[2]))
  assert.doesNotMatch(section, /\.answer\s*\(|sim\.send\(/, 'it asks no model and sends the realm nothing')
})

test('talk.ts calls the staring setter only inside #link and #unlink', () => {
  const talk = read('./talk.ts')
  // Comments may name the option; only code is counted.
  const code = talk.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.equal(count(code, /\.partner\(/g), 2, 'two calls in all')
  assert.equal(count(method(code, '  #link(row: number): void {'), /\.partner\(/g), 1, 'one on opening')
  assert.equal(count(method(code, '  #unlink(): void {'), /\.partner\(/g), 1, 'one on closing')
})

test('nothing under terminal/ imports any of the conversation\'s files', () => {
  const root = fileURLToPath(new URL('./terminal/', import.meta.url))
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      if (statSync(path).isDirectory()) walk(path)
      else if (/\.(?:ts|tsx|mjs|js)$/.test(name)) files.push(path)
    }
  }
  walk(root)
  assert.ok(files.length > 5, 'the console\'s files were found')
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    const specs = [...text.matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1])
    for (const spec of specs) assert.doesNotMatch(spec, /(?:^|\/)talk[^/]*$/i, `${file} imports ${spec}`)
  }
})
