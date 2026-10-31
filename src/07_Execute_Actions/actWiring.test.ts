// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page's wiring of a proposed city action (the card, the input shield, the HUD
 * line and the toasts, the engine's two knobs and the proposer's name) at the source level, the way the other wiring
 * tests do, because the components need a browser: App derives the card and the shield from one `act` state fed by
 * the bridge's acts.follow, mounts the card over the console and under the recovery card, keeps the console's suspend
 * expression byte-identical, and toasts only while the console is closed; the card is an alertdialog with Refuse before
 * Allow, Y and N only with the console closed, and no Escape; the engine hands the operator tier rain mode and the
 * sound as senses with the pinned voiceOf before the elite vault, and lifts the sound loop into one place; the console follows every act
 * event; the base reality carries the four prompt lines; the scripted provider proposes; the swarm never imports the
 * catalogue; and everything the card, the HUD line and the toasts show passes 14A with no exclamation mark and no syntax.
 * What breaks if it is removed? A later edit could mount the card without the shield (a pad's OK would open a car door
 * and break the proposer's tether), take Escape from the console, put Allow first under a pad's south face button, toast
 * over an open console, or move voiceOf and break the engine pin, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { screen } from '../02_Define_The_Rules/conduct.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const APP = read('../App.tsx')
const CARD = read('./ActCard.tsx')
const ENGINE = read('./engine.ts')
const INPUT = read('../04_Connect_Hardware/input.ts')
const RECOVERY = read('./RecoveryCard.tsx')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing ${from}`)
  const b = src.indexOf(to, a)
  assert.ok(b > a, `missing ${to} after ${from}`)
  return src.slice(a, b)
}
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}
/** intent.test.ts's rules for anything the city shows: 14A and IP wording, and plain speech (no paths, code, keys or shell). */
const BANNED = /agent city|\bgta\b|matrix|pathfinder|pf2e|paizo|alpine|\bkill|attack|weapon|target|shoot|\bguns?\b|violen|injur|maim|wound|blood|\bdie\b|\bdead|death|crash|smash/i
const SYNTAX = /[`~/\\$<>{}|]|\.ts\b|\.tsx\b|--|\bnpm\b|\bsudo\b/

test('App: the card, the shield and the HUD line derive from one act state fed by acts.follow; toasts only with the console closed', () => {
  assert.match(APP, /const \[act, setAct\] = useState<PendingAct \| null>\(null\)/)
  assert.match(APP, /const actRef = useRef<PendingAct \| null>\(null\)/)
  const follow = between(APP, 'const actRef = useRef<PendingAct | null>(null)', '  }), [bridge])\n')
  assert.match(follow, /useEffect\(\(\) => bridge\?\.operator\.acts\.follow\(\(ev\) => \{\n\s+actRef\.current = ev\.kind === 'proposed' \? ev\.act : null\n\s+setAct\(actRef\.current\)/, 'proposed sets it, every decision and end clears it; the unsubscribe is the effect\'s cleanup')
  assert.match(follow, /if \(termOpenRef\.current\) return\n/, 'open, the lines are already in the scrollback')
  before(follow, 'if (termOpenRef.current) return', "toast('City action'", 'the console check comes before every toast')
  assert.match(follow, /if \(ev\.kind === 'proposed'\) engineRef\.current\?\.toast\('City action', `\$\{ev\.act\.who\} proposes: \$\{ev\.act\.sentence\} \(Y allows, N refuses\)`\)/)
  // The three ends a person did not make themselves are toasted: done, failed, and the action gate's refusal after their OK (as 'refused', with the law).
  assert.match(follow, /else if \(ev\.kind === 'ended' && \(ev\.end\.state === 'done' \|\| ev\.end\.state === 'failed' \|\| ev\.end\.state === 'denied'\)\) engineRef\.current\?\.toast\('City action', `\$\{ev\.end\.state === 'denied' \? 'refused' : ev\.end\.state\}: \$\{ev\.end\.line\}`\)/)
  assert.doesNotMatch(follow, /ev\.end\.state === '(?:refused|withdrawn|aborted)'/, 'a refusal and a withdrawal toast nothing (the person did it); an abort is the gate wrapper\'s Task aborted')
  assert.match(APP, /void h\.verdict\.then\(\(v\) => \{ if \(v\.state === 'Aborted'\) e\.toast\('Task aborted', `Spatial tether lost: \$\{v\.message\}`\) \}\)/, 'the gate wrapper\'s toast, unchanged')
  assert.match(APP, /useEffect\(\(\) => \{ engineRef\.current\?\.input\.shield\(act !== null\) \}, \[act\]\)/, 'the shield follows the same state as the card')
  assert.match(APP, /const allowAct = useCallback\(\(\) => \{ try \{ void bridge\?\.operator\.acts\.allow\('card'\)\.result\.catch\(noop\) \} catch \{ \/\* already ended \*\/ \} \}, \[bridge\]\)/)
  assert.match(APP, /const refuseAct = useCallback\(\(\) => \{ try \{ bridge\?\.operator\.acts\.refuse\('card'\) \} catch \{ \/\* already ended \*\/ \} \}, \[bridge\]\)/)
  assert.match(APP, /\{act && veilDone && locked === null && bridge && <ActCard act=\{act\} termOpen=\{termOpen\} onAllow=\{allowAct\} onRefuse=\{refuseAct\} \/>\}/)
  const tree = between(APP, '<Terminal ref={termRef} bridge={bridge}', 'export default App')
  before(tree, '<Terminal ref={termRef} bridge={bridge}', '<ActCard act={act}', 'the card is mounted after the console')
  before(tree, '<ActCard act={act}', '<BootVeil ready=', 'and before the veil and the recovery screens')
  before(tree, '<BootVeil ready=', '<RecoveryCard failure=', 'the recovery card comes last, over the card (z 10001)')
  assert.equal(APP.match(/<ActCard /g)?.length, 1)
  // The HUD line: the pinned expression stays byte-identical (inPageWiring.test.ts) and a waiting proposal takes it over.
  assert.match(APP, /if \(recruiter\) s\.supplier\.recruiting = hudLine\(recruiter, router\?\.running \?\? 0, activityText\(answering, engine\.speaking, modelPhase \?\? keepLine\)\)\n\s+\/\/[^\n]*\n\s+if \(recruiter && actRef\.current\) s\.supplier\.recruiting = hudLine\(recruiter, router\?\.running \?\? 0, `Waiting for your OK: \$\{actRef\.current\.who\} proposes: \$\{actRef\.current\.sentence\}`\)\n\s+setHud\(s\)/)
  // The console's suspend expressions are byte-identical (lookWiring.test.ts pins one): the shield is a second flag.
  assert.match(APP, /engineRef\.current\?\.input\.suspend\(open \|\| lookOpenRef\.current\)/)
  assert.match(APP, /engineRef\.current\?\.input\.suspend\(lookOpen \|\| termOpenRef\.current\)/)
  assert.doesNotMatch(APP, /suspend\([^)]*act\b/, 'the card never suspends game input: E and a walk-off still end the proposal')
  // The proposer's name reaches the engine beside the identity line, and the pinned bridge call keeps voiceOf before the elite vault (eliteWiring.test.ts).
  assert.match(APP, /useEffect\(\(\) => \{\n\s+engine\?\.setNameOf\(\(agent\) => roster\.byAgent\(agent\)\?\.name \?\? null\)\n\s+return \(\) => engine\?\.setNameOf\(null\)\n\s+\}, \[engine, roster\]\)/)
  assert.match(APP, /e\.terminalBridge\(gate, mind, voice, memory\.diary\(\), voiceOf, pageStore\(ELITE_KEY\)\)/)
  assert.match(APP, /^import \{ ActCard \} from '\.\/07_Execute_Actions\/ActCard\.tsx'$/m)
})

test('the card: an alertdialog with data-act over the console and under the recovery card, Refuse then Allow, one decision, Y and N only with the console closed, no Escape', () => {
  assert.match(CARD, /^(?:\/\/[^\n]*\n)*\/\*\*\n \* Why does this file exist\?[\s\S]*What breaks if it is removed\?/, 'the header (after the licence lines)')
  assert.match(CARD, /export function ActCard\(\{ act, termOpen, onAllow, onRefuse \}: \{ act: PendingAct; termOpen: boolean; onAllow\(\): void; onRefuse\(\): void \}\): JSX\.Element/)
  const root = CARD.match(/<div\n\s+ref=\{root\}\n([\s\S]*?)>\n/)?.[1] ?? ''
  assert.match(root, /role="alertdialog"/, 'the console\'s exemption (Terminal.tsx) leaves its keys alone')
  assert.match(root, /data-act=\{act\.seq\}/)
  assert.match(root, /aria-labelledby=\{title\}/)
  assert.doesNotMatch(root, /aria-modal/, 'the console beneath stays usable')
  assert.match(root, /className="pointer-events-none fixed inset-0 z-\[10000\] /, 'the root lets the pointer through to the city')
  assert.match(CARD, /<div className="pointer-events-auto w-full max-w-sm /, 'only the card takes taps')
  assert.match(read('./terminal/Terminal.tsx'), /\.r0-root\{position:absolute;top:0;left:0;right:0;z-index:9999;/, 'over the console')
  assert.match(RECOVERY, /className="fixed inset-0 z-\[10001\] /, 'under the recovery card')
  // Refuse first in DOM order (a pad's south face button presses the first button when none is focused), both min-h-11.
  const buttons = [...CARD.matchAll(/<button [\s\S]*?>(Refuse|Allow)<\/button>/g)]
  assert.deepEqual(buttons.map((m) => m[1]), ['Refuse', 'Allow'])
  for (const m of buttons) {
    assert.match(m[0], /className=\{`\$\{BUTTON\} /, `${m[1]} wears BUTTON`)
    assert.match(m[0], /disabled=\{decided\}/, `${m[1]} is dead after the first press`)
    assert.match(m[0], /type="button"/)
  }
  assert.match(buttons[0][0], /ref=\{refuseRef\}/)
  assert.match(CARD, /^const BUTTON = 'min-h-11 /m)
  assert.match(CARD, /const decided = decidedFor === act\.seq/, 'one decision per proposal, alive again for the next')
  // Focus: pointer lock released and Refuse focused, only while the console is closed, again for every proposal.
  assert.match(CARD, /useEffect\(\(\) => \{\n\s+if \(termOpen\) return\n\s+if \(document\.pointerLockElement\) document\.exitPointerLock\(\)\n\s+refuseRef\.current\?\.focus\(\{ preventScroll: true \}\)\n\s+\}, \[termOpen, act\.seq\]\)/)
  // Keys: a bubble-phase window listener, only while the console is closed and nothing was decided; repeats, chords
  // and text fields ignored; y allows, n refuses; no Escape anywhere in the card.
  const keys = between(CARD, '    if (termOpen || decided) return', '  }, [termOpen, decided, act.seq, onAllow, onRefuse])')
  assert.match(keys, /if \(e\.repeat \|\| e\.ctrlKey \|\| e\.metaKey \|\| e\.altKey \|\| isEditableTarget\(e\.target\)\) return/)
  assert.match(keys, /const key = e\.key\.toLowerCase\(\)\n\s+if \(key !== 'y' && key !== 'n'\) return/)
  assert.match(keys, /if \(key === 'y'\) onAllow\(\)\n\s+else onRefuse\(\)/)
  assert.match(keys, /window\.addEventListener\('keydown', onKey\)\n/, 'bubble phase: the console\'s capture listener runs first')
  const code = CARD.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, '')
  assert.doesNotMatch(code, /Escape|\bEsc\b/, 'Esc is the console\'s: the card has no Escape handler')
  assert.match(CARD, /usePadNav\(root\)/)
  assert.match(CARD, /\{termOpen \? HINT_CONSOLE : HINT_KEYS\}/)
  // The safe-area padding is RecoveryCard's, to the character.
  const padding = (src: string) => src.match(/const SAFE_PADDING = \{\n\s+padding: '([^']+)',\n\} as const/)?.[1]
  assert.ok(padding(CARD))
  assert.equal(padding(CARD), padding(RECOVERY))
  // The card knows the proposal's type, the pad reader and the editable-target rule: no engine, bridge value or renderer.
  const imports = [...CARD.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['react', '../04_Connect_Hardware/input.ts', './operator.ts', './padNav.ts'])
  assert.match(CARD, /^import type \{ PendingAct \} from '\.\/operator\.ts'$/m, 'a type only')
  assert.doesNotMatch(code, /engine\.ts|three\/|bridge\.ts|acts\.ts|actions\.ts/, 'the card runs nothing: no engine, no keeper, no catalogue')
})

test('content: everything the card, the HUD line and the toasts show passes 14A, with no exclamation mark and no syntax', () => {
  const word = (name: string) => {
    const v = CARD.match(new RegExp(`^const ${name} = '([^']*)'$`, 'm'))?.[1]
    assert.ok(v, name)
    return v
  }
  const who = 'Mara (agent 17, Design)', sentence = 'set the light haze to 4'
  const shown = [
    word('HEADING'), word('PROMISE'), word('HINT_KEYS'), word('HINT_CONSOLE'),
    `${who} proposes:`, 'Refuse', 'Allow',
    `(the model asked for 9; the most it goes is 4)`, `(the model asked for 0.1; the least it goes is 0.25)`,
    `Waiting for your OK: ${who} proposes: ${sentence}`,
    `${who} proposes: ${sentence} (Y allows, N refuses)`, 'done: the light haze is 4', 'failed: that car is being driven',
  ]
  assert.equal(word('HEADING'), 'City action')
  assert.equal(word('PROMISE'), 'Nothing changes until you allow it. It runs only while they stay with you.')
  assert.equal(word('HINT_KEYS'), 'Y allows · N refuses · the south face button presses')
  assert.equal(word('HINT_CONSOLE'), 'Type y or n in the console')
  for (const text of shown) {
    assert.deepEqual(screen(text), { admissible: true }, text)
    assert.doesNotMatch(text, BANNED, text)
    assert.doesNotMatch(text, SYNTAX, text)
    assert.ok(!text.includes('!'), `no exclamation mark: ${text}`)
  }
  // The note's words come from the clamp note and the canonical value (`clamped from 9` on `light haze 4`), never the model's.
  const note = between(CARD, 'function noteWords(act: PendingAct): string | null {', '\n}\n')
  assert.match(note, /act\.note\.match\(\/\^clamped from \(-\?\\d\+\(\?:\\\.\\d\+\)\?\)\$\/\)/)
  assert.match(note, /`\(the model asked for \$\{asked\}; the \$\{asked > got \? 'most' : 'least'\} it goes is \$\{got\}\)`/)
  assert.match(note, /return `\(\$\{act\.note\}\)`/, 'any other note as it came')
  // The card shows the city's own words for the proposal and who proposes it, nothing else of the answer.
  assert.match(CARD, /\{act\.who\} proposes:/)
  assert.match(CARD, /<span className="font-semibold text-white">\{act\.sentence\}<\/span>/)
  assert.doesNotMatch(CARD, /act\.canonical\}|act\.verb\}|\.text\b/, 'the sentence, not the line')
  assert.doesNotMatch(CARD, /!['"]/, 'no exclamation mark in a literal')
})

test('the input shield: a second flag beside suspend that drops the pad\'s edges after the mapper read and makes press() a no-op; keys untouched', () => {
  assert.match(INPUT, /^ {2}shielded = false$/m)
  assert.match(INPUT, /shield\(on: boolean\): void \{\n\s+this\.shielded = on\n\s+\}/)
  const poll = between(INPUT, '  poll(dt: number): void {', '  /** Virtual stick')
  assert.match(poll, /edges = this\.mapper\.read\(pads, this\.pad\)\n\s+\}\n\s+if \(this\.shielded\) edges = 0 \/\/[^\n]*\n\s+if \(edges & PAD_EDGE\.interact\) this\.queued\.add\('interact'\)/, 'after the mapper read (its held bits advance), before any edge is queued')
  assert.equal(poll.match(/this\.shielded/g)?.length, 1)
  assert.match(INPUT, /press\(action: Action\): void \{\n\s+if \(this\.shielded\) return\n\s+this\.queued\.add\(action\)\n\s+\}/)
  const keyboard = between(INPUT, "on(document, 'keydown', (e) => {", "on(document, 'keyup'")
  assert.doesNotMatch(keyboard, /shielded/, 'the keyboard is untouched: E still ends the proposal')
  assert.match(keyboard, /if \(this\.suspended \|\| isEditableTarget\(target\)\) return/, 'the console\'s own guard, unchanged')
  const suspend = between(INPUT, '  suspend(on: boolean): void {', '  /**\n   * A card waits')
  assert.doesNotMatch(suspend, /shielded/, 'the console opening and closing never touches the shield')
})

test('the engine: the proposer\'s name, the two city knobs and the air-gap vouch reach the operator tier as senses with voiceOf before the elite vault; the sound loop lives once', () => {
  assert.match(ENGINE, /operatorBridge\(this\.simControls\(\), gate, mind, undefined, \{ voice, speech: this\.speechOut\(\), diary, awareness: this\.awareness\(\), nameOf, city: this\.cityKnobs\(\), contained: \(\) => airgapInstalled\(globalThis\), voiceOf, vault \}\)/)
  assert.match(ENGINE, /operatorBridge\(this\.simControls\(\), gate, mind, undefined, \{[^}]*voiceOf, vault \}\)/, 'voiceWiring.test.ts\'s pin')
  assert.match(ENGINE, /^import type \{ CityKnobs \} from '\.\.\/06_Make_Decisions\/actions\.ts'$/m, 'a type only: the engine runs no action')
  assert.match(ENGINE, /const nameOf = \(agent: number\): string \| null => this\.nameOfAgent\?\.\(agent\) \?\? null/)
  assert.match(ENGINE, /^ {2}setNameOf\(fn: \(\(agent: number\) => string \| null\) \| null\): void \{\n\s+this\.nameOfAgent = fn\n\s+\}/m)
  before(ENGINE, '  setIdentities(fn:', '  setNameOf(fn:', 'beside the identity seam')
  // Rain mode: the knob calls the same engine switch as the console's `rain` knob (its name is engine-private and never spelt elsewhere).
  const knobs = between(ENGINE, '  cityKnobs(): CityKnobs {', '\n  }\n')
  const switchOf = knobs.match(/rain: \(on: boolean\): void => \{ this\.(\w+)\(on\) \}/)?.[1]
  assert.ok(switchOf, 'the rain knob')
  assert.match(ENGINE, new RegExp(`rain: \\(arg\\?: 'on' \\| 'off'\\) => \\(arg === undefined \\? \\(this\\.\\w+ \\? 'on' : 'off'\\) : this\\.${switchOf}\\(arg === 'on'\\)\\)`), 'the console\'s rain knob flips the same switch')
  assert.match(knobs, /audio: \(level: 'on' \| 'off' \| number\): void => \{ this\.setAudio\(level\) \}/)
  assert.match(knobs, /return Object\.freeze\(\{/)
  // The sound: one loop, lifted out of the bridge's audio arrow, which now calls it (splitWiring.test.ts's pin still finds the loop in the bridge region).
  assert.match(ENGINE, /^ {2}setAudio\(arg: 'on' \| 'off' \| number\): void \{\n\s+for \(const v of this\.views\) \{\n\s+if \(arg === 'on'\) \{ v\.audio\.unlock\(\); v\.audio\.setEnabled\(true\) \}\n\s+else if \(arg === 'off'\) v\.audio\.setEnabled\(false\)\n\s+else if \(typeof arg === 'number'\) v\.audio\.setVolume\(arg \/ 100\)\n\s+\}\n\s+\}/m)
  assert.equal(ENGINE.match(/v\.audio\.setVolume\(arg \/ 100\)/g)?.length, 1, 'the loop lives once')
  const bridge = between(ENGINE, '  terminalBridge(gate: SkillGate', '  /** Control glyphs')
  assert.match(bridge, /audio: \(arg\?: 'on' \| 'off' \| number\) => \{\n\s+\/\/[^\n]*\n\s+if \(arg !== undefined\) this\.setAudio\(arg\)\n\s+const st = audio\.status\(\)/)
  assert.match(bridge, /built over simControls\(\) and two host knobs handed in as senses/)
  assert.match(bridge, /never over the engine itself/)
  assert.ok(bridge.includes('setAudio(arg:') && bridge.includes('cityKnobs(): CityKnobs {'), 'both live in the bridge region')
  assert.match(ENGINE, /^ {2}terminalBridge\(gate: SkillGate, givenMind: Mind, voice\?: Voice, diary\?: Diary, voiceOf\?: \(agent: number\) => string \| null, vault\?: EliteVault\): TerminalBridge \{$/m, 'the signature App.tsx\'s pinned call matches')
  // The facade the operator tier scripts see is untouched: the two knobs are senses, not leaves.
  const controls = between(ENGINE, '  simControls(): SimControls {', '  /** ?debug harness hooks. */')
  assert.doesNotMatch(controls, /setAudio|cityKnobs|rain/)
})

test('the console follows every act event the console did not cause, so the card\'s decisions are in the scrollback when it reopens', () => {
  const term = read('./terminal/Terminal.tsx')
  assert.match(term, /\(bridge \?\? OFFLINE\)\.operator\.acts\.follow\(\(ev\) => append\(actEventLines\(ev\)\)\)/)
})

test('the base reality carries the four prompt lines, spread from the catalogue', () => {
  assert.match(read('../09_Cognition/localCompute.ts'), /\.\.\.ACTION_RULES/)
})

test('the scripted provider proposes from its own branch alone, never as the stand-in', () => {
  assert.match(read('../09_Cognition/router.ts'), /scriptedAction\(/)
  assert.doesNotMatch(read('../09_Cognition/scripted.ts'), /scriptedAction|ACTION:/)
})

test('nothing in the swarm imports the catalogue: a role\'s ACTION line is text', () => {
  const dir = new URL('../08_Swarm/', import.meta.url)
  for (const name of ['orchestrator.ts', 'taskRouter.ts', 'memory.ts', 'shortTerm.ts', 'recruitment.ts', 'roster.ts', 'ping.ts']) {
    assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /06_Make_Decisions\/actions\.ts|07_Execute_Actions\/acts\.ts/, name)
  }
})
