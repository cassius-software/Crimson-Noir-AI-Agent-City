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

test('the hook listens and never writes: readings from the snapshot, the engine asked only for its rooms and its car count, the pass kept once', () => {
  const src = read('./useFirstWalk.ts')
  assert.match(src, /engine\.workplaces\(\)/)
  assert.match(src, /engine\.simControls\(\)\.vehicles\.count\(\) > 0/)
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

test('App: the walk is switched on from the URL and the pass record, fed the Concierge\'s goal, the console\'s lines and opening, the HUD\'s microphone and captions; the quiet watch waits for it', () => {
  const src = read('../../App.tsx')
  assert.match(src, /needsFirstWalk\(new URLSearchParams\(window\.location\.search\), loadFirstWalk\(\)\)/)
  assert.match(src, /useFirstWalk\(\{ active: walk && veilDone/)
  assert.match(src, /const walking = walk && !fw\.passed/)
  assert.match(src, /useMentor\(\{ active: mentored && veilDone && !walking/)
  assert.match(src, /onGoalSent=\{onGoalSent\}/)
  assert.match(src, /onLine=\{fw\.line\}/)
  assert.match(src, /walkRef\.current\.note\('console'\)/)
  assert.match(src, /walkRef\.current\.note\('mic'\)/)
  assert.match(src, /walkRef\.current\.note\('captions'\)/)
  assert.match(src, /<FirstWalkCard/)
  assert.match(src, /onShow=\{showWalk\}/)
  assert.match(src, /walk: \(\) => walkRef\.current\.stage/, 'the smoke reads the stage')
  // The accessible path goes through the same controls the operator tier has, and the console's handle.
  assert.match(src, /case 'move': \{\s*e\.input\.yaw \+= 0\.7/)
  assert.match(src, /case 'ring0': termRef\.current\?\.run\('laws'\)/)
  assert.match(src, /case 'exam': termRef\.current\?\.type\(`noir \$\{PROGRAM\[0\]\}`\)/)
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
