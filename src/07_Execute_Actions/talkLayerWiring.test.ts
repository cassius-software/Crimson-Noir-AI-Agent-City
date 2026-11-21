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
 * on closing, and keeps the console's files from importing any of it. On the page (App.tsx): the controller is ticked
 * right after the engine's frame, read by the HUD before the announcer, offered every heard line Sloane would get
 * before she gets it, built once over the engine's host with the raw router and the one staring adapter, blocked by
 * the page's own cards, and disposed with the microphone's wiring; Sloane holds her tongue while it talks, the walk's
 * card steps aside for its panel, and her card's visible condition is left as it was. The panel keeps a plain text
 * field, and the conversation's files carry the house header and ask no model themselves.
 * What breaks if it is removed? A label that reads a frame already handed back, a talk press that opens a
 * conversation on the first frame out of a car, a hired agent's voice captioned with its words or stuck where it
 * started, a pinned slice broken by a misplaced section, or heads turning every tick, all with every unit test green.
 * On the page: a label a frame behind, a greeting that Sloane takes as a goal, a passer-by's words on the HUD's
 * unscreened answer line, a conversation left open over the console or a city action's card, or one that outlives a
 * halted city and keeps the engine's press.
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

const APP = read('../App.tsx')
const LOOP = between(APP, '    const loop = (now: number) => {', '      raf = requestAnimationFrame(loop)')

test('App: the controller is ticked right after the engine\'s frame, read by the HUD before the announcer, and offered heard lines before Sloane', () => {
  assert.match(LOOP, /\n\s*engine\.frame\(now\)\n\s*talk\?\.tick\(now\)\n/, 'every frame, right after the engine\'s (the label moves with the projection just made)')
  assert.equal(count(APP, /talk\?\.tick\(/g), 1, 'ticked in one place')
  assert.match(LOOP, /const s = engine\.snapshot\(\)\n(?:\s*\/\/[^\n]*\n)*\s*s\.supplier\.talk = talk\?\.hud\(\)\n/, 'on every HUD snapshot')
  before(LOOP, 's.supplier.talk = talk?.hud()', 'announcer.next(s, now)', 'the announcer reads the proposal from the same snapshot')
  before(LOOP, 's.supplier.talk = talk?.hud()', 'setHud(s)', 'and the chip from the one React sees')
  assert.match(APP, /if \(!vouched && !heardNow\(speaker\.speaking, performance\.now\(\), quietAt\)\) return\n\s+if \(parseRequest\(t\) === null && !talk\?\.hear\(t\)\) setHeard\(\{ id: \+\+heardId, text: t \}\)\n/, 'the echo guard first, a recruitment request the recruiter\'s, then the conversation, then Sloane')
  assert.equal(count(APP, /talk\?\.hear\(/g), 1, 'heard lines are offered in one place')
})

test('App: one controller over the engine\'s host, with the raw router, the one staring adapter and the page\'s own reasons to block', () => {
  assert.equal(count(APP, /new TalkController\(/g), 1)
  const made = between(APP, '        const talker = new TalkController({', '\n        })\n')
  assert.match(made, /\n {10}host: e\.talkHost\(\),\n/)
  assert.match(made, /\n {10}chat: personChat\(local, peopleThink\),\n/, 'the raw router: no unscreened answer tail on the HUD, no reply counted as the visitor\'s prompt')
  assert.doesNotMatch(made, /personChat\(mind\b/)
  assert.match(made, /\n {10}speaker,\n/, 'Sloane\'s own speaker: one mouth, so the echo guard and barge-in cover people')
  assert.match(made, /who: \(row\) => talkWho\(row, roster\.byAgent\(row\), r\.recruits\.find\(\(v\) => v\.agent === row\) \?\? null, voiceOf\(row\)\),/)
  assert.equal(count(APP, /partner:/g), 1, 'the staring setter has one adapter in the page')
  assert.match(made, /\n {10}partner: noop,\n/, 'a no-op until heads can be told whom to face')
  assert.match(made, /onOpen: \(on\) => \{\n\s*talkingRef\.current = on\n\s*setTalking\(on\)\n\s*if \(on\) noteRef\.current\('talk'\)\n\s*\},/, 'an opening is the tutorial\'s talk')
  assert.match(made, /onSloane: \(text\) => setHeard\(\{ id: \+\+heardId, text \}\),/, 'a line typed to Sloane reaches her card as a heard one does')
  assert.match(made, /toast: \(title, body\) => e\.toast\(title, body\),/)
  assert.match(made, /micOpen: \(\) => mic\.open,/)
  before(APP, "setSloaneTalk(sloaneChat(mind, () => local.settings().provider !== 'scripted'))", 'const talker = new TalkController({', 'built with Sloane\'s conversation, once the router stands')
  const think = between(APP, '        const peopleThink = (): boolean => {', '\n        }\n')
  assert.match(think, /if \(s\.provider === 'scripted' \|\| s\.provider === 'claude' \|\| s\.found === 'claude' \|\| pageCold\(\)\) return false/, 'never the cloud key, never the answer that loads a model')
  assert.match(think, /return !shared \|\| \(e\.profile\.gpuClass === 'discrete' && !e\.profile\.mobile && !e\.profile\.lite\)/, 'the page\'s or the app\'s model only on a discrete desktop')
  assert.match(APP, /talker\.setBlocked\(true\)\n\s*talk = talker\n(?:\s*\/\/[^\n]*\n)*\s*e\.onTalk = \(how\) => talk\?\.press\(how\)\n\s*setTalkCtl\(talker\)/, 'blocked until the page\'s own reasons are read, then the engine\'s press')
  const blocked = /useEffect\(\(\) => \{\n\s*talkCtl\?\.setBlocked\(!\(([^\n]*)\)\)\n\s*\}, \[([^\]]*)\]\)/.exec(APP)
  assert.ok(blocked, 'the blocked effect')
  for (const part of ['veilDone', 'hudVisible', '!termOpen', '!lookOpen', 'storeOpen === null', 'homeOpen === null', 'act === null', 'locked === null', '!sloaneOpen']) {
    assert.ok(blocked[1].split(' && ').includes(part), `blocked unless ${part}`)
    const dep = part.replace(/^!/, '').replace(/ === null$/, '')
    assert.ok(blocked[2].split(', ').includes(dep), `re-read when ${dep} changes`)
  }
  assert.ok(blocked[2].split(', ').includes('talkCtl'))
})

test('App: the conversation goes with the city, disposed after unquiet() inside unlisten, the engine\'s press let go, and the controller dropped', () => {
  const unlisten = between(APP, '        unlisten = () => {', '\n        }\n')
  assert.match(unlisten, /\n\s*unquiet\(\)\n(?:\s*\/\/[^\n]*\n)*\s*talk\?\.dispose\(\)\n\s*talk = null\n\s*e\.onTalk = null$/, 'after the ear is let go: a halt and the city\'s end both run it')
  assert.equal(count(APP, /talk\?\.dispose\(\)/g), 1)
  assert.equal(count(APP, /e\.onTalk = /g), 2, 'set once, cleared once')
  const teardown = between(APP, '    return () => {\n      cancelled = true', '\n    }\n  }, [')
  assert.match(teardown, /\n\s*setTalkCtl\(null\)\n/, 'the label and the panel go with the city')
  before(APP, '          unlisten?.()\n          tasks.dispose()', '        talk = talker', 'the halt\'s handler reaches it through unlisten')
})

test('App: Sloane holds her tongue while a conversation is open, the walk\'s card steps aside, and her card\'s visible condition is unchanged', () => {
  assert.match(APP, /const onSay = useCallback\(\(text: string\) => \{ if \(!talkingRef\.current\) void speaker\.speak\(text\) \}, \[speaker\]\)/, 'her text still shows; her voice waits')
  assert.match(APP, /useMentor\(\{ active: mentored && veilDone && !walking && !talking, /, 'no nudge over a conversation')
  assert.match(APP, /crowded=\{sloaneOpen \|\| talking\}/)
  assert.match(APP, /<Concierge\n\s*visible=\{veilDone && hudVisible && !termOpen && !lookOpen && storeOpen === null && homeOpen === null && locked === null\}\n/, 'her chip stays through a conversation')
  assert.doesNotMatch(between(APP, '<Concierge\n', '/>'), /talkCtl|talking/, 'nothing of the conversation in her props')
})

test('App: the label under the HUD and the panel after Sloane\'s card at the city\'s top level; the chip opens with the serial it showed; a stand-in for the smoke run', () => {
  const view = APP.slice(APP.indexOf('    <main ref={mainRef}'))
  before(view, '<canvas ref={canvasRef}', '<TalkLabel talk={talkCtl}', 'over the city')
  before(view, '<TalkLabel talk={talkCtl}', '<Hud s={hud}', 'under the HUD\'s panels')
  assert.match(view, /\{talkCtl && <TalkLabel talk=\{talkCtl\} family=\{hud && !hud\.supplier\.touch \? hud\.supplier\.glyphs : undefined\} \/>\}/, 'no key named on a touch screen')
  before(view, '<Concierge\n', '<TalkPanel\n', 'after Sloane\'s card')
  before(view, '<TalkPanel\n', '<FirstWalkCard\n', 'and before the walk\'s, which steps aside for it')
  const panel = between(view, '<TalkPanel\n', '/>')
  for (const prop of ['talk={talkCtl}', 'family={hud.supplier.glyphs}', 'overlay={hud.supplier.touch}', 'dark={hud.customer.daylight < 0.35}', 'beside={walking && fw.card !== null}', 'zoom={access.scale / 100}', 'voice={hud.supplier.voice ?? null}']) {
    assert.ok(panel.includes(prop), `the panel is handed ${prop}, as Sloane's card is`)
  }
  assert.equal(count(view, /<TalkLabel /g), 1)
  assert.equal(count(view, /<TalkPanel\b/g), 1)
  assert.match(APP, /<Hud s=\{hud\}[^\n]* onHome=\{openHome\} onTalkChip=\{onTalkChip\} \/>/)
  assert.match(APP, /const onTalkChip = useCallback\(\(serial: number\) => talkCtl\?\.press\('tap', serial\), \[talkCtl\]\)/, 'a stale chip never opens the wrong person')
  assert.match(read('./Hud.tsx'), /onTalkChip\?\.\(talk\.serial\)/)
  assert.match(APP, /\n {14}talk: \(what\?: 'near' \| 'open' \| null\) => talk\?\.preview\(what \?\? null\),\n/, '?debug: __SIM__.talk')
  before(APP, 'if (options.debug) {', "talk: (what?: 'near' | 'open' | null) =>", 'only in a debug page')
})

test('TalkLayer: a plain text field in the panel, and no key grid of its own', () => {
  const layer = read('./TalkLayer.tsx')
  assert.match(layer, /<input type="text"\n/, 'any keyboard types into it: a system\'s, a phone\'s, a virtual one')
  assert.match(layer, /data-talk="panel"/)
  assert.match(layer, /data-talk="label"/)
  assert.equal(count(layer, /<input\b/g), 1, 'one field')
})

test('the conversation\'s files open with the house header and say why they exist; none asks a model itself or reaches the Ring-0 gate', () => {
  const header = APP.split('\n').slice(0, 3).join('\n')
  for (const rel of ['../08_Swarm/talkLink.ts', '../08_Swarm/talkLines.ts', './talk.ts', './TalkLayer.tsx']) {
    const src = read(rel)
    assert.ok(src.startsWith(`${header}\n/**`), `${rel}: the licence header, then the doc comment`)
    const head = src.split('\n').slice(0, 40).join('\n')
    assert.match(head, /Why does this file exist\?/, rel)
    assert.match(head, /What breaks if it is removed\?/, rel)
    assert.doesNotMatch(src, /\.answer\s*\(/, `${rel}: a reply goes through onboarding/voice.ts personChat`)
    assert.doesNotMatch(src, /\bperform\b/i, rel)
    assert.doesNotMatch(src, /ring0Gate/, rel)
  }
})
