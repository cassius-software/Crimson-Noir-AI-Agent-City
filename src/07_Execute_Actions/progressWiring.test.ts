// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the operator's progression cues and the checks the city
 * earns, which App, the engine and the HUD carry and Node cannot run: the deeds the engine hands App (the door key's
 * boarding, the clock, ghost and rain keys, a headset from the touch menu) and nowhere else, so no setter the console,
 * a script or an agent's act shares ever earns; a check's tap on the pad only while no guardrail holds the motors and
 * the page is shown, on the rumble alone; the chime in player 1's ears alone; one keeper listener in App, cueing a
 * success but not a reroll that stayed one, taken back on a halt and with the city; the wardrobe's check once per
 * visit from the card; the HUD's chip from the snapshot alone, read as text, its glow once, never cut, and still under
 * reduced motion; and the keeper never built at module scope or by the engine or the recruiter.
 * What breaks if it is removed? A shared setter could start earning (the console's own check would then be lost to the
 * skill's rest), a check's tap could drown out or stand in for the limiter's hum, the chime could play in every seat,
 * a stale listener could drive a stopped city, or a Node test could build the page's keeper, with no test going red.
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
/** The code without its comments (a line comment starts at // not preceded by a colon, as in URLs; JSX comments too). */
const code = (text: string): string => text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const count = (src: string, re: RegExp): number => src.match(re)?.length ?? 0
/** A method of the engine, from its signature to its closing brace at two spaces. */
const method = (src: string, signature: string): string => between(src, `  ${signature}`, '\n  }\n')

const ENGINE = read('./engine.ts')
const ENGINE_CODE = code(ENGINE)
const APP = read('../App.tsx')
const APP_CODE = code(APP)
const HUD = read('./Hud.tsx')
const RECRUITMENT = read('../08_Swarm/recruitment.ts')
const FRAME = between(ENGINE, '  frame(nowMs: number): void {', '  /** One drawn frame')
const RECEIVED = method(ENGINE, 'private received(s: StepState, prev: StepState): void {')
const ENTERED = between(RECEIVED, "if (ev.e === 'entered') {", "} else if (ev.e === 'exited') {")
const TOGGLE_XR = method(ENGINE, 'toggleXr(): void {')
const CHECK_CUE = method(ENGINE, 'checkCue(degree: number, label?: string): void {')
/** The effect that builds the city around the engine (its frame loop, the engine's wiring, its teardown). */
const EFFECT = between(APP, '    const canvas = canvasRef.current\n', '  // The boot\'s failure first')
const HALT = between(EFFECT, '        e.onHalt = (reason) => {', '\n        }\n')
const TEARDOWN = between(EFFECT, '    return () => {\n      cancelled = true', '\n    }\n  }, [')
const GUI = between(APP, 'function GuiShell(', 'export default App')

test('engine: a check\'s tap joins the rumble alone, after the guardrails, and only where they leave the motors still', () => {
  const motors = between(FRAME, 'lightbar: number = LIGHTBAR.rest\n', 'this.rumble(rumble, hold, snap, lightbar)')
  assert.equal(count(ENGINE, /this\.rumble\(rumble, hold, snap, lightbar\)/g), 1, 'one send to the motors a frame, byte-identical')
  assert.match(motors, /\n {4}if \(rumble === 0\) rumble = pulseLevel\(nowMs - this\.rewardAt, this\.rewardTaps\)\n {4}if \(!this\.hapticsOn\) \{ rumble = 0; snap = 0 \}\n/)
  before(motors, 'rumble = thump ? HAPTICS.pulse : st.haptics.limited ? HAPTICS.limiter : 0', 'if (rumble === 0) rumble = pulseLevel(', 'the guardrails decide first, so the thump and the limiter\'s hum win')
  const body = code(motors)
  for (const line of body.split('\n').filter((l) => /pulseLevel|rewardAt|rewardTaps/.test(l))) {
    assert.doesNotMatch(line, /\b(?:hold|snap|lightbar|trigger)\s*=(?!=)/, `a cue never reaches the hold, the snap, the lightbar or the trigger: ${line.trim()}`)
  }
  assert.deepEqual(body.match(/\bsnap = [^\n;}]+/g)?.map((m) => m.trim()), ['snap = thump ? HAPTICS.pulse : 0', 'snap = 0'], 'the thump and the haptics-off zeroing, nothing else')
  assert.deepEqual(body.match(/\blightbar = [^\n;}]+/g)?.map((m) => m.trim()), ['lightbar = thump ? LIGHTBAR.thump : st.haptics.limited ? LIGHTBAR.limited : LIGHTBAR.rest'])
  assert.deepEqual(body.match(/\bhold = [^\n;}]+/g)?.map((m) => m.trim()), ['hold = st.haptics.limited ? HAPTICS.hold : 0'])
  // The guardrails' own resets leave the cue's fields alone.
  for (const reset of [FRAME, RECEIVED]) assert.doesNotMatch(code(reset), /this\.reward(?:At|Taps) = /, 'only checkCue and setHaptics write the cue')
  assert.match(ENGINE, /^import \{ PULSE, pulseLevel, type HalOutputs \} from '\.\.\/04_Connect_Hardware\/hal\.ts'$/m, 'the envelope is hal.ts\'s, tested there')
})

test('engine: checkCue chimes in player 1\'s ears alone, taps a pad only unsplit and unguarded, and vibrates a phone; all of it behind haptics', () => {
  assert.match(CHECK_CUE, /if \(this\.halted \|\| this\.disposed \|\| !\(degree >= SUCCESS\)\) return/, 'nothing once the city has stopped, nothing for a miss')
  assert.equal(count(CHECK_CUE, /this\.audio\.chime\(/g), 1, 'player 1\'s soundscape')
  assert.doesNotMatch(code(CHECK_CUE), /views\[|for \(|forEach|\.map\(/, 'never every seat\'s soundscape')
  before(CHECK_CUE, 'this.audio.chime(', 'if (!this.hapticsOn) return', 'the chime is sound, not haptics')
  assert.match(CHECK_CUE, /if \(device === 'touch'\) \{\n\s+this\.input\.hal\.vibrate\(critical \? PULSE\.phoneCritical : PULSE\.phone\)/)
  assert.match(CHECK_CUE, /if \(device !== 'gamepad' \|\| this\.views\.length > 1 \|\| this\.input\.hal\.asleep\) return/, 'the bus sends one rumble to every pad, so never in split screen; and no tap kept while the page is hidden')
  before(CHECK_CUE, 'this.input.hal.asleep) return', 'this.rewardAt = performance.now()', 'a hidden page stamps no tap')
  before(CHECK_CUE, 'this.input.hal.asleep) return', 'this.input.hal.output(', 'and sends none for the bus to replay on return (hal.test.ts asleep)')
  assert.match(CHECK_CUE, /if \(!guarded\) this\.input\.hal\.output\(\{ rumble: PULSE\.level \}\)/, 'the first tap at once, on the rumble alone')
  assert.doesNotMatch(CHECK_CUE, /\b(?:hold|snap|lightbar|trigger):/, 'the immediate tap carries nothing but the rumble')
  assert.doesNotMatch(code(CHECK_CUE), /\bset[A-Z]\w*\(|await\b|new (?:Float32Array|AudioBuffer)\b/, 'it starts a buffer and sets numbers, nothing more')
})

test('engine: the deeds are player 1\'s presses and boarding, never a setter the console, a script or an agent\'s act shares', () => {
  const deeds = count(ENGINE_CODE, /this\.deed\(/g)
  const inFrame = count(code(FRAME), /this\.deed\(/g)
  const inEntered = count(code(ENTERED), /this\.deed\(/g)
  const inXr = count(code(TOGGLE_XR), /this\.deed\(/g)
  assert.equal(inFrame, 4, 'the two clock keys, the ghost key and the rain key')
  assert.equal(inEntered, 1, 'the boarding')
  assert.equal(inXr, 1, 'a headset from the touch menu')
  assert.equal(deeds, inFrame + inEntered + inXr, 'and nowhere else')
  for (const sig of ['setGhost(on: boolean): string {', 'setMatrix(on: boolean): string {', 'debugSetHour(h: number): void {', 'cityKnobs(): CityKnobs {', 'interact(): void {', 'private xrHost(): XrHost {', 'checkCue(degree: number, label?: string): void {']) {
    assert.doesNotMatch(code(method(ENGINE, sig)), /\bdeed\(|onDeed/, `${sig} earns nothing`)
  }
  // Once per press: each of the frame's deeds sits on a key's edge.
  assert.match(FRAME, /^ {4}if \(input\.take\('timeForward'\)\) \{ [^\n]*this\.deed\('optics'\) \}$/m)
  assert.match(FRAME, /^ {4}if \(input\.take\('timeBack'\)\) \{ [^\n]*this\.deed\('optics'\) \}$/m)
  assert.match(FRAME, /^ {4}if \(input\.take\('matrix'\)\) \{ this\.toast\('Rain mode', [^\n]*this\.deed\('optics'\) \}$/m, 'the touch menu\'s name for it')
  const ghost = between(FRAME, "    if (input.take('ghost')) {", '\n    }\n')
  assert.match(ghost, /if \(line\.startsWith\('on:'\) \|\| \(line === 'off' && this\.views\.length === 1 && !this\.rig\.headset && this\.options\.post\)\) this\.deed\('optics'\)/, 'only a view that showed or went away')
  // The door key is stamped where the press is taken, never in interact() (scripts, harnesses and __SIM__ share it).
  // (A press a shop's card took is no door press: storefronts.ts, storeWiring.test.ts.)
  assert.match(FRAME, /^ {4}if \(input\.take\('interact'\) && !this\.browse\(true\)\) \{ this\.doorPressedAt = performance\.now\(\); this\.interact\(\) \}$/m)
  assert.doesNotMatch(method(ENGINE, 'interact(): void {'), /doorPressedAt/)
  assert.equal(count(ENGINE_CODE, /this\.doorPressedAt = performance\.now\(\)/g), 1)
  assert.match(ENTERED, /if \(!ev\.room && performance\.now\(\) - this\.doorPressedAt < DOOR_DEED_MS\) \{\n\s+this\.doorPressedAt = -Infinity\n\s+this\.deed\('piloting'\)/, 'a room\'s correction never pays, and one press pays one boarding')
  assert.match(TOGGLE_XR, /if \(!this\.xr\.presenting\) this\.toast\('Headset', line\)\n\s+else this\.deed\('optics'\)/)
  // A host's error never breaks the frame.
  assert.match(method(ENGINE, 'private deed(skill: OperatorSkill): void {'), /try \{ this\.onDeed\?\.\(skill\) \} catch \(e\) \{ this\.errors\.push\(`progress: /)
})

test('the keeper: built in App\'s city shell alone, never at module scope, never by the engine or the recruiter', () => {
  const calls = count(APP_CODE, /\bpageProgress\(/g)
  assert.ok(calls > 0)
  assert.equal(count(code(GUI), /\bpageProgress\(/g), calls, 'every call inside GuiShell\'s closures')
  assert.doesNotMatch(between(APP, 'function TtyShell() {', 'function App() {'), /pageProgress|progress/i, 'the console shell has no city to earn in')
  for (const [name, src] of [['engine.ts', ENGINE], ['recruitment.ts', RECRUITMENT]] as const) {
    assert.doesNotMatch(code(src), /pageProgress|progress\.ts'/, `${name} never reaches the keeper`)
  }
  assert.match(ENGINE, /^import type \{ OperatorSkill \} from '\.\.\/02_Define_The_Rules\/progression\.ts'$/m, 'a type, erased at runtime')
  assert.doesNotMatch(ENGINE, /^import \{[^}]*\} from '[^']*progression\.ts'$/m, 'no value from the rules')
})

test('App: one keeper listener cues every success and is taken back on a halt and with the city; the deeds and the recruiter earn into the same keeper', () => {
  assert.equal(count(APP_CODE, /pageProgress\(\)\.subscribe\(/g), 1, 'one listener')
  const listener = between(EFFECT, '        uncheck = pageProgress().subscribe((c) => {', '\n        })\n')
  assert.match(listener, /if \(worthCue\(c\)\) \{\n\s+cue = cueOf\(c, performance\.now\(\)\)\n\s+e\.checkCue\(c\.degree, SKILL_TITLE\[c\.skill\]\)\n\s+\}/, 'a success, but not a reroll that stayed one (progress.ts worthCue, tested there)')
  assert.doesNotMatch(code(listener), /\bset[A-Z]\w*\(|await\b/, 'a check inside a frame or a worker message touches no React state')
  assert.match(EFFECT, /^ {8}e\.onDeed = \(skill\) => \{ pageProgress\(\)\.earn\(skill\) \}$/m)
  assert.match(EFFECT, /^ {8}unearn = earnFromRecruiter\(pageProgress\(\), r\)$/m)
  before(EFFECT, 'e.onRally = (req) =>', 'e.onDeed = (skill) =>', 'beside the engine\'s other host seam')
  for (const [where, slice] of [['onHalt', HALT], ['the cleanup', TEARDOWN]] as const) {
    assert.match(slice, /unfollow\?\.\(\)\n\s+uncheck\?\.\(\)\n\s+unearn\?\.\(\)\n/, `${where} takes both back after the recruiter's other listeners`)
  }
  assert.match(EFFECT, /unfollow = \(\) => \{ unfollowMemory\(\); unmirror\(\); roster\.keepOnly\(\[\]\) \}/, 'unfollow is unchanged')
  // The HUD's chip: from the loop, read off the plain cue, before the snapshot goes to React.
  const loop = between(EFFECT, 'const loop = (now: number) => {', 'raf = requestAnimationFrame(loop)')
  assert.match(loop, /s\.supplier\.progress = hudProgress\(pageProgress\(\), cue, now\)/)
  before(loop, 's.supplier.progress = hudProgress(', 'setHud(s)', 'on the snapshot React sees')
  assert.equal(count(APP_CODE, /\bhudProgress\(/g), 1)
  assert.match(APP, /^ {4}haptics: q\.get\('haptics'\) !== '0',$/m, '?haptics=0 starts them off')
})

test('App: the wardrobe card earns once a visit when the look really changes; the console\'s look keeps wearLook', () => {
  assert.match(APP, /onChange=\{wearFromCard\}/)
  assert.doesNotMatch(APP, /onChange=\{wearLook\}/)
  assert.match(APP, /^ {12}wear: wearLook,$/m, 'the console\'s knob earns for itself through its command')
  assert.match(APP, /const wearLook = useCallback\(\(next: Look\) => \{ setLook\(next\); saveLook\(next\) \}, \[\]\)/, 'and earns nothing itself')
  assert.match(APP, /const openLook = useCallback\(\(\) => \{ lookDeedRef\.current = false; setLookOpen\(true\)/, 'a new visit starts again')
  const card = between(APP, 'const wearFromCard = useCallback((next: Look) => {', '}, [wearLook])')
  assert.match(card, /wearLook\(next\)/)
  assert.match(card, /if \(!lookDeedRef\.current && LOOK_SLOTS\.some\(\(slot\) => next\[slot\] !== was\[slot\]\) && pageProgress\(\)\.earn\('commerce'\)\) lookDeedRef\.current = true/)
  assert.equal(count(APP_CODE, /earn\('commerce'\)/g), 1)
})

test('HUD: the progress chip reads the snapshot alone, goes with the H key, and glows once, softly, and never under reduced motion', () => {
  assert.doesNotMatch(HUD, /^import[^\n]*progress(?:Store)?\.ts'/m, 'the HUD imports no keeper: its words come finished in the snapshot')
  assert.match(HUD, /^import type \{ HudPing, HudProgress, Light, SipocSnapshot \} from '\.\.\/05_Observe_Environment\/telemetry\.ts'$/m)
  assert.match(HUD, /^const CALM = mediaStore\('\(prefers-reduced-motion: reduce\)'\)$/m)
  assert.match(HUD, /const progressChip = pr && \(!compact \|\| \(pr\.cue !== null && !short\)\) && <ProgressChip /, 'on a phone only while a check is fresh, never on a short screen')
  before(HUD, 'const progressChip =', 'const renderChip =', 'before the render chip\'s pinned stretch')
  assert.equal(count(HUD, /\{progressChip\}/g), 2, 'after the render chip in both layouts')
  assert.equal(count(HUD, /\{renderChip\}/g), 3, 'the render chip\'s pin is untouched')
  assert.match(HUD, /\{renderChip\}\n\s+\{progressChip\}\n\s+<\/div>/, 'the wide column\'s last chip')
  assert.match(HUD, /\{renderChip\}\n\s+\{progressChip\}\n\s+\{stacked && /, 'the compact column\'s, measured with the panels')
  const hidden = HUD.slice(HUD.indexOf('{!visible && (recChip || rc?.listening || captionStrip) && ('))
  assert.doesNotMatch(hidden, /progressChip|ProgressChip p=/, 'game feedback: it goes with the H key')
  const chip = between(HUD, 'function ProgressChip(', '\n}\n')
  assert.match(chip, /\n {6}<span className="sr-only">\{p\.label\}<\/span>\n/, 'read in full words, as text a browse mode lands on (GlyphKey\'s way)')
  assert.doesNotMatch(chip, /role="group"|aria-label=/, 'no name on a container whose content is all hidden')
  assert.match(chip, /\{p\.delta \? `\$\{p\.cueText\} · \$\{p\.delta\}` : p\.cueText\}/, 'no separator left hanging when the check paid nothing')
  assert.doesNotMatch(code(chip), /\.cancel\(|return \(\) =>/, 'a ring still fading finishes: never cut by the next check or a remount')
  assert.doesNotMatch(chip, /aria-live|role="status"|role="alert"|animate-pulse|animate-ping|scale-|translate-/, 'not a live region; no pulse, no strobe, no movement')
  assert.match(chip, /if \(!el \|\| cueAt < 0 \|\| !young \|\| CALM\.matches\(\)\) return/, 'a fresh check only, and still under reduced motion')
  assert.match(chip, /if \(now - glowedAt < GLOW_GAP_MS\) return/, 'at most once a second')
  assert.match(chip, /el\.animate\(\[\{ opacity: 0 \}, \{ opacity: 1, offset: 0\.3 \}, \{ opacity: 0 \}\], \{ duration: GLOW_MS, easing: 'ease-out' \}\)/, 'opacity alone, once')
  assert.match(chip, /\}, \[cueAt\]\)/, 'keyed on the check, so a later snapshot never replays it')
  assert.match(HUD, /^const GLOW_MS = 600$/m)
  assert.match(HUD, /^const GLOW_GAP_MS = 1000$/m)
})
