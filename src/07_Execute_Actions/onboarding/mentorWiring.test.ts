// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence that Sloane's watch is wired through the page: the hook's small readers
 * (the HUD's clock to hours, the glyph family to the mentor's word), the Concierge taking a nudge as a view of its own
 * that waits while a question or goal is open, App handing the nudge over and reporting a prompt sent to someone, and
 * the engine's awareness feeding every provider's prompt and remembering a rally. Source-level, as the other wiring
 * tests are: the components need a browser to render.
 * What breaks if it is removed? A hook or a prop could be dropped and Sloane would watch, and say, nothing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { familyOf, hoursOf, TICK_MS } from './useMentor.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('the hook\'s readers: the HUD clock to hours, the glyph family to keyboard, pad or touch', () => {
  assert.equal(hoursOf('17:30'), 17.5)
  assert.equal(hoursOf('00:00'), 0)
  assert.ok(Number.isNaN(hoursOf('noon')))
  assert.equal(familyOf('keyboard'), 'keyboard')
  assert.equal(familyOf('touch'), 'touch')
  assert.equal(familyOf('abxy'), 'pad')
  assert.equal(familyOf('generic'), 'pad')
  assert.equal(TICK_MS, 1000)
})

test('the hook listens and never writes: readings from the snapshot, events from the window, the engine asked only for its landmark', () => {
  const src = read('./useMentor.ts')
  assert.match(src, /engine\.landmark\(\)/)
  assert.doesNotMatch(src, /engine\.(?!landmark\b)[a-zA-Z]+\(/, 'nothing else of the engine is called')
  assert.match(src, /hud\.customer\.viewYaw/)
  assert.match(src, /hud\.output\.matrix === true/)
  assert.match(src, /addEventListener\('keydown'/)
  assert.match(src, /addEventListener\('pointermove'/)
  assert.match(src, /mustKeep\(s, n\.keep\)/, 'a rewording that drops the key or name is not shown')
})

test('the Concierge takes a nudge as its own view: opened only from the chip, a greeting or the help, settled like a greeting, never shown twice', () => {
  const src = read('../Concierge.tsx')
  assert.match(src, /nudge\?: Nudge \| null/)
  assert.match(src, /type View = [^\n]*'nudge'/)
  assert.match(src, /if \(nudge && nudge\.id !== seenNudge\) \{\s*setSeenNudge\(nudge\.id\)\s*if \(view === 'chip' \|\| view === 'greet' \|\| view === 'help' \|\| view === 'nudge'\) open\('nudge'\)/)
  assert.match(src, /view !== 'greet' && view !== 'nudge' && !padAsk/)
  assert.match(src, /view === 'nudge' \? \(nudge\?\.text \?\? ''\)/)
  assert.match(src, /onGoal\?\.\(\)/, 'opening the goal dialogue is reported')
  const shown = src.replace(/^import .*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(shown, /[Tt]utorial|lesson/, 'never called a lesson in the card either')
})

test('App: Sloane watches a first visitor who walked in from the onboarding, hands their lines to the card, and reports a prompt sent to someone', () => {
  const src = read('../../App.tsx')
  assert.match(src, /const mentored = outcome !== null && !outcome\.saved\.skipped/)
  assert.match(src, /useMentor\(\{ active: mentored && veilDone/)
  assert.match(src, /nudge=\{nudge\}/)
  assert.match(src, /onGoal=\{onGoal\}/)
  assert.match(src, /noteRef\.current\('talk'\)/)
})

test('the engine: its awareness is handed to the operator tier beside the diary, built from the page\'s own copies; a rally is a moment remembered; the script stands behind the throttle', () => {
  const src = read('../engine.ts')
  assert.match(src, /awareness: this\.awareness\(\)/)
  assert.match(src, /withScriptedFallback\(withCloudFallback\(givenMind, this\.frameRate\)\)/)
  assert.match(src, /this\.awareness\(\)\.remember\(plan\.request\.agent, 'the player'/)
  assert.match(src, /landmarkOf\(pack, layout\.offset\)/)
  const surroundings = src.slice(src.indexOf('private surroundingsOf('), src.indexOf('private awareness('))
  assert.doesNotMatch(surroundings, /this\.sim\.send|sim\.send/, 'reads the newest state; asks the physics realm nothing')
})

test('the operator tier: the context rides every request beside the memories, and an answer is a moment both people remember', () => {
  const src = read('../operator.ts')
  assert.match(src, /memories: remembered\(lease\.bound\), \.\.\.\(awareness && \{ context: aware\(lease\.bound\) \}\)/)
  assert.match(src, /awareness\?\.remember\(t\.agent, 'the player', `asked "/)
  const local = read('../../09_Cognition/localCompute.ts')
  assert.match(local, /systemPrompt\(req\.tethers, req\.memories, req\.context\)/)
  const router = read('../../09_Cognition/router.ts')
  assert.equal((router.match(/systemPrompt\(req\.tethers, req\.memories, req\.context\)/g) ?? []).length, 3, 'the Claude provider, the scripted provider and the prefix page table')
})
