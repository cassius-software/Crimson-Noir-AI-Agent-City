// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the on-screen keys' wiring across the page: mounted once beside the app (so the
 * console shell, which App returns on its own, has them too); the pad's menu and keys buttons carried from the engine
 * to App; the pads lent per lender and given back; a card that must be answered first folding the keys; Sloane's card
 * and the first walk not taking a finger on a key for a press outside them; the panels standing clear of the keys; the
 * watcher's device changes reaching the desk. Structural: the behaviour is in keysDesk.test.ts, keyboardSense.test.ts,
 * keysPad.test.ts and the browser smoke test (tty, lite).
 * What breaks if it is removed? A refactor could mount the keys inside one shell only, leave the game reading the pad
 * while the keys type, or let a tap on a key put Sloane's card away under the player's thumb.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const MAIN = read('../main.tsx')
const APP = read('../App.tsx')
const ENGINE = read('../07_Execute_Actions/engine.ts')
const CONCIERGE = read('../07_Execute_Actions/Concierge.tsx')
const FIRST_WALK = read('../07_Execute_Actions/onboarding/FirstWalk.tsx')
const PAD_MENU = read('../07_Execute_Actions/PadMenu.tsx')
const SCREEN_KEYS = read('./ScreenKeys.tsx')
const CSS = read('../index.css')

const count = (src: string, s: string) => src.split(s).length - 1
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}

test('the keys are mounted once, after the app, outside every shell', () => {
  assert.equal(count(MAIN, '<ScreenKeys />'), 1, 'one mount, in main.tsx')
  before(MAIN, '<App />', '<ScreenKeys />', 'after the app: above the console at its height, in the console shell too')
  assert.equal(count(APP, '<ScreenKeys'), 0, 'not inside App, which returns the console shell on its own')
})

test('the pad\'s menu and keys buttons go from the engine to App, unless a doorstep card has the pad', () => {
  before(ENGINE, 'if (this.homeCard !== null || this.drainNext) { input.drain(); this.drainNext = false }', 'const padUi = input.takeUi()',
    'taken after the drain, which leaves the page\'s buttons alone')
  assert.match(ENGINE, /if \(padUi !== 0 && this\.homeCard === null\) this\.onPadUi\?\.\(padUi\)/)
  assert.match(APP, /e\.onPadUi = \(ui\) => \{\n\s+if \(ui & PAD_UI\.menu\) setPadMenu\(\(o\) => !o\)\n\s+if \(ui & PAD_UI\.keys\) summonKeys\(\)\n\s+\}/)
})

test('the pads are lent per lender and the game has them back once every lender gave them back', () => {
  assert.match(APP, /lend: \(owner, on\) => \{\n\s+if \(on\) lenders\.add\(owner\)\n\s+else lenders\.delete\(owner\)\n\s+engine\.input\.lend\(lenders\.size > 0\)\n\s+\}/)
  assert.match(APP, /return \(\) => \{\n\s+keysHost\.set\(null\)\n\s+engine\.input\.lend\(false\)\n\s+\}/)
  assert.match(PAD_MENU, /lentTo\?\.lend\('menu', true\)\n\s+const giveBack = borrowPads\('menu'\)/)
  assert.match(PAD_MENU, /lentTo\?\.lend\('menu', false\)\n\s+giveBack\(\)/)
  assert.match(SCREEN_KEYS, /lentTo\?\.lend\('keys', true\)\n\s+giveBack = borrowPads\('keys'\)/)
  assert.match(SCREEN_KEYS, /lentTo\?\.lend\('keys', false\)/)
})

test('a card that must be answered first closes the pad\'s menu and folds the keys', () => {
  assert.match(APP, /keysBlocked\.set\(blocked\)\n\s+if \(blocked\) setPadMenu\(false\)/)
  assert.match(APP, /<PadMenu open=\{padMenu && !blocked\} items=\{padItems\} onClose=\{closePadMenu\} \/>/)
  assert.match(APP, /\{ label: 'Keyboard', run: \(\) => \{ summonKeys\(\) \} \}/)
  assert.match(APP, /\.\.\.menuItems\(menuHost, engine\.input\),/)
})

test('a finger on a key is not a press outside Sloane\'s card or the first walk', () => {
  assert.match(CONCIERGE, /if \(e\.pointerType === 'mouse' \|\| cardRef\.current\?\.contains\(e\.target as Node\) \|\| insideKeys\(e\.target\)\) return/)
  assert.match(FIRST_WALK, /if \(e\.pointerType === 'mouse' \|\| insideKeys\(e\.target\)\) return/)
  assert.match(SCREEN_KEYS, /<div \{\.\.\.\{ \[KEYS_ROOT\]: '' \}\} data-way-out="">/)
})

test('the watcher\'s device changes reach the desk, and the panels stand clear of the open keys', () => {
  assert.match(SCREEN_KEYS, /sense\.onChange = \(\) => d\.deviceChanged\(\)/)
  assert.match(CSS, /html\[data-keys-open\] main > \.ui-zoom \{[^}]*bottom: calc\(var\(--keys-height, 0px\) \/ var\(--ui-zoom, 1\)\) !important;/)
  assert.match(CSS, /html\[data-keys-open\] \.r0-root\[data-full\] \{[^}]*height: calc\(100% - var\(--keys-height, 0px\)\)/)
})
