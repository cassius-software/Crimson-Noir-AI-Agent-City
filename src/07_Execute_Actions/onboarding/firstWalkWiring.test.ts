// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence that the first walk is wired through the page: the hook's small
 * readers (the glyph family to the device's words, a bearing, the nearest workplace), the hook reading the engine
 * for nothing but its rooms and its car count, App switching the walk on from the URL and the pass record, feeding
 * it the Concierge's goal, the console's lines and opening, the HUD's microphone and captions, holding the quiet
 * watch until it is passed, and the card having no close, no skip and no key that puts it away while every stage
 * has its accessible button. Source-level, as the other wiring tests are: the components need a browser to render.
 * What breaks if it is removed? A prop or a report could be dropped and a stage would never finish, or a close could
 * be added and the walk would be a card like any other.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PROGRAM } from '../../09_Cognition/firstWalk.ts'
import { TICK_MS, bearingOf, nearestPlace, wordsOf } from './useFirstWalk.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const shown = (src: string) => src.replace(/^import .*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the hook\'s readers: the device\'s words from the glyphs, a bearing, the nearest workplace', () => {
  assert.deepEqual(wordsOf('keyboard'), { move: 'W A S D', look: 'Mouse', interact: 'E', console: '~' })
  assert.deepEqual(wordsOf('touch'), { move: 'Stick', look: 'Drag', interact: 'Enter car', console: 'Menu' })
  assert.deepEqual(wordsOf('abxy'), { move: 'L', look: 'R', interact: 'A', console: '~' })
  assert.equal(wordsOf('bayx').interact, 'B')
  assert.equal(bearingOf(0, 0, 10, 1), 'east')
  assert.equal(bearingOf(0, 0, -10, 1), 'west')
  assert.equal(bearingOf(0, 0, 1, -10), 'north')
  assert.equal(bearingOf(0, 0, 1, 10), 'south')
  const rooms = [{ name: 'Medical Triage Clinic', door: { x: 100, z: 0 } }, { name: 'Executive Boardroom', door: { x: 0, z: -30 } }]
  assert.deepEqual(nearestPlace(rooms, 0, 0), { name: 'the Executive Boardroom', metres: 30, bearing: 'north' })
  assert.deepEqual(nearestPlace(rooms, 90, 0), { name: 'the Medical Triage Clinic', metres: 10, bearing: 'east' })
  assert.equal(nearestPlace([], 0, 0), null)
  assert.equal(TICK_MS, 1000)
})

test('the hook listens and never writes: readings from the snapshot, the engine asked only for its rooms, its car count and whether it has shops and homes, the pass kept once', () => {
  const src = read('./useFirstWalk.ts')
  assert.match(src, /engine\.workplaces\(\)/)
  assert.match(src, /engine\.simControls\(\)\.vehicles\.count\(\) > 0/)
  assert.match(src, /stores: engine\.shops\.length > 0/, 'the look stage names the shops only on a map that has them')
  assert.doesNotMatch(src, /engine\.shops(?!\.length > 0)/, 'and of the shops, only whether there are any')
  assert.match(src, /homes: engine\.homes\.length > 0/, 'the look stage names the homes only on a map that has them')
  assert.doesNotMatch(src, /engine\.homes(?!\.length > 0)/, 'and of the homes, only whether there are any')
  assert.doesNotMatch(src, /engine\.(?!workplaces\b|simControls\b)[a-zA-Z]+\(/, 'nothing else of the engine is called')
  assert.doesNotMatch(src, /simControls\(\)\.(?!vehicles\.count\(\))/, 'and of the controls, only the car count')
  assert.match(src, /insideRoom\(r, x, z\)/)
  assert.match(src, /hud\.customer\.viewYaw/)
  assert.match(src, /hud\.input\.mode === 'vehicle'/)
  assert.match(src, /consoleOpen: termOpen/)
  assert.match(src, /if \(w\.passed && !kept\.current\) \{\s*kept\.current = true\s*saveFirstWalkPassed\(/)
  assert.match(src, /mustKeep\(s, b\.keep\)/, 'a rewording that drops the key or command is not shown')
  assert.match(src, /if \(lawLine\(text\)\) note\('law'\)/)
})

test('App: the walk is switched on from the URL and the pass record, fed the Concierge\'s goal, the console\'s lines and opening, the HUD\'s microphone and captions, the wardrobe, a shop\'s card or a home\'s doorstep card put away; the quiet watch waits for it', () => {
  const src = read('../../App.tsx')
  assert.match(src, /needsFirstWalk\(new URLSearchParams\(window\.location\.search\), loadFirstWalk\(\)\)/)
  assert.match(src, /useFirstWalk\(\{ active: walk && veilDone/)
  assert.match(src, /const walking = walk && !fw\.passed/)
  assert.match(src, /useMentor\(\{ active: mentored && veilDone && !walking/)
  assert.match(src, /onGoalSent=\{onGoalSent\}/)
  assert.match(src, /onLine=\{fw\.line\}/)
  // One city console, the one the walk hears: a branch update once left a second <Terminal> holding termRef without onLine.
  assert.equal(src.match(/<Terminal ref=\{termRef\}/g)?.length, 1, 'exactly one city console')
  assert.match(src, /<Terminal ref=\{termRef\}[^>]*onLine=\{fw\.line\}/)
  assert.match(src, /walkRef\.current\.note\('console'\)/)
  assert.match(src, /walkRef\.current\.note\('mic'\)/)
  assert.match(src, /walkRef\.current\.note\('captions'\)/)
  // The look stage: the wardrobe card put away (by Done, its close button, Escape or the console) after it was open.
  assert.match(src, /if \(lookWas\.current && !lookOpen\) walkRef\.current\.note\('wardrobe'\)\s*lookWas\.current = lookOpen/)
  // Or a shop's card put away (Done, ×, Escape, the console, walking out of the shop, a headset) after it was open.
  assert.match(src, /if \(storeWas\.current && storeOpen === null\) walkRef\.current\.note\('store'\)\s*storeWas\.current = storeOpen !== null/)
  // Or a home's doorstep card put away (Done, ×, Escape, B, the console, walking out of the home, a headset) after it was open.
  assert.match(src, /if \(homeWas\.current && homeOpen === null\) walkRef\.current\.note\('home'\)\s*homeWas\.current = homeOpen !== null/)
  assert.match(src, /\}, \[lookOpen, storeOpen, homeOpen\]\)/, 'the effect that hears the cards runs when the doorstep card opens or closes')
  assert.match(src, /<FirstWalkCard\s+visible=\{veilDone && !lookOpen && storeOpen === null && homeOpen === null && locked === null\}/, 'the walk\'s card steps aside for the wardrobe, a shop\'s card and a home\'s doorstep card')
  assert.match(src, /onShow=\{showWalk\}/)
  assert.match(src, /walk: \(\) => walkRef\.current\.stage/, 'the smoke reads the stage')
  // The accessible path goes through the same controls the operator tier has, and the console's handle.
  assert.match(src, /case 'move': \{\s*e\.input\.yaw \+= 0\.7/)
  assert.match(src, /case 'style': openLook\(\); return/, 'the look stage\'s button opens the wardrobe card the chip opens')
  assert.match(src, /case 'ring0': termRef\.current\?\.run\('laws'\)/)
  assert.match(src, /case 'exam': termRef\.current\?\.type\(`noir \$\{PROGRAM\[0\]\}`\)/)
  // The exam behind the exit program: composed in the console bridge over the host's vouch for the air gap, the
  // kernel-panic state, the bridge's laws, the recruiter's own lane and the walk; the nonce drawn once per page load.
  assert.match(src, /exam: createExam\(\{/)
  assert.match(src, /contained: \(\) => airgapInstalled\(globalThis\)/)
  assert.match(src, /standing: \(\) => lockedRef\.current === null/)
  assert.match(src, /laws: \(\) => engineBridge\.laws\(\)/)
  assert.match(src, /checks: \(\) => GATE_CHECK_NAMES/, 'the gate\'s check names come through the operator tier, one of the gate\'s three keepers')
  assert.match(src, /ask: \(skill\) => r\.tryAsk\(skill\)/)
  assert.match(src, /nonce: crypto\.getRandomValues\(new Uint32Array\(1\)\)\[0\]/)
  assert.match(src, /stage: \(\) => walkRef\.current\.stage/)
  assert.match(src, /on: \(\) => walk,/)
  assert.match(src, /note: \(ev\) => walkRef\.current\.note\(ev\)/)
})

test('the walk\'s card and Sloane\'s open card stand side by side on a wide screen, or the walk\'s steps aside where they cannot', () => {
  const app = read('../../App.tsx')
  const concierge = read('../Concierge.tsx')
  const card = read('./FirstWalk.tsx')
  // App: Sloane is told the walk's card is up and tells App when her card is open; the walk's card hears it.
  assert.match(app, /beside=\{walking && fw\.card !== null\}\s*onOpen=\{setSloaneOpen\}/)
  assert.match(app, /crowded=\{sloaneOpen\}/)
  // Sloane: her wide column moves left of the walk's card when there is room, and her open state is any view but the chip.
  assert.match(concierge, /className=\{beside && roomy \? WIDE_BESIDE : WIDE_COLUMN\}/)
  assert.match(concierge, /const opened = visible && view !== 'chip'/)
  assert.match(card, /import \{ BESIDE_ROOM_QUERY \} from '\.\.\/Concierge\.tsx'/, 'one query for both sides')
  assert.match(card, /const shown = visible && !\(crowded && !termOpen && !overlay && !compact && !roomy\)/)
  // A hint that comes while the card is away is let go, never spoken late (closing a doorstep card can pass the stage
  // in the same commit that shows the card again); an ask or the passed line waits for the card.
  assert.match(card, /if \(!beat \|\| beat\.id === said\.current\) return\s*(?:\/\/[^\n]*\s*)*if \(!shown\) \{ if \(beat\.kind === 'hint'\) said\.current = beat\.id; return \}\s*said\.current = beat\.id\s*sayRef\.current\?\.\(beat\.text\)/)
  // The measures agree: Sloane's column ends short of the walk's card (its right inset plus its width), and at the
  // query's width it still has at least the 22 rem her centred column never went under.
  const walkRight = Number(/wide: 'right-\[max\(([\d.]+)rem/.exec(card)?.[1])
  const walkWidth = Number(/wide: '[^']*\bw-\[([\d.]+)rem\]/.exec(card)?.[1])
  const beside = /const WIDE_BESIDE = '[^']*left-\[([\d.]+)rem\] right-\[calc\(max\(([\d.]+)rem,env\(safe-area-inset-right\)\)_\+_([\d.]+)rem\)\]/.exec(concierge)
  assert.ok(beside, 'WIDE_BESIDE has a left and a right')
  const [left, inset, past] = [Number(beside[1]), Number(beside[2]), Number(beside[3])]
  assert.equal(inset, walkRight, 'measured from the same right inset')
  assert.ok(past >= walkWidth + 0.5, `${past} rem clears the ${walkWidth} rem card with a gap`)
  const room = Number(/BESIDE_ROOM_QUERY = '\(min-width: (\d+)px\)'/.exec(concierge)?.[1]) / 16
  assert.ok(room - left - inset - past >= 22, `${room - left - inset - past} rem left for Sloane at ${room} rem`)
})

test('the exam reaches the walk\'s program and the bridge\'s type, and nothing else: no gate, no engine, no realm, no write', () => {
  const src = read('exam.ts')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['../../09_Cognition/firstWalk.ts', '../terminal/bridge.ts'])
  assert.match(src, /import type \{ ExamBridge \} from '\.\.\/terminal\/bridge\.ts'/, 'the bridge is a type only')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bengine\b|simControls|localStorage|fetch\(|\.write\b|write:/i)
  // The console's `tutorial program` without an exam prints the walk's own program (commands.ts keeps a copy; this pins them equal).
  const commands = read('../terminal/commands.ts')
  const copy = commands.match(/const EXAM_PROGRAM: readonly string\[\] = Object\.freeze\((\[[^\]]*\])\)/)
  assert.ok(copy, 'commands.ts keeps the program for the shell without an exam')
  assert.deepEqual([...copy![1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]), [...PROGRAM])
})

test('the console reports every line run and types or runs a line for the card; the Concierge reports a goal sent; the engine shows its rooms', () => {
  const term = read('../terminal/Terminal.tsx')
  assert.match(term, /onLine\?\(line: string\): void/)
  assert.match(term, /type\(text: string\): void/)
  assert.match(term, /run\(line\?: string\): void/)
  assert.match(term, /if \(line\) onLineRef\.current\?\.\(line\)/)
  assert.match(term, /submitRef\.current\(line \?\? inputRef\.current\?\.value \?\? ''\)/)
  const concierge = read('../Concierge.tsx')
  assert.match(concierge, /onGoalSent\?\(text: string\): void/)
  assert.match(concierge, /onGoalSent\?\.\(goalText\)/)
  const engine = read('../engine.ts')
  assert.match(engine, /workplaces\(\): readonly Workplace\[\] \{\s*return this\.rooms\s*\}/)
})

test('the card has no close, no skip and no key that puts it away; every stage has its button, the last its program lines and Run; it never calls the walk a lesson', () => {
  const src = read('./FirstWalk.tsx')
  assert.doesNotMatch(src, /onClose|onSkip|Escape|data-walk-close|data-walk-skip/, 'no way out but the program')
  assert.doesNotMatch(src, /<button[^>]*>\s*(?:Close|Skip|Dismiss|Later|Not now)\b/i)
  assert.match(src, /data-walk-show/)
  assert.match(src, /data-walk-why/)
  assert.match(src, /data-walk-run/)
  assert.match(src, /data-walk-line-button=\{i \+ 1\}/)
  assert.match(src, /onType\(`noir \$\{l\}`\)/)
  assert.match(src, /data-walk=\{card\.stage\}/)
  assert.match(src, /aria-live="polite"/)
  const text = shown(src)
  assert.doesNotMatch(text, /[Tt]utorial|lesson/, 'Sloane calls it a walk')
  assert.match(text, /No skip: the city opens when the program on the last card has run\./)
})
