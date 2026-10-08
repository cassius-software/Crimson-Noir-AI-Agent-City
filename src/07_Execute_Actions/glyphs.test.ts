// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the control glyphs match the hardware in the player's hands: the
 * exact keyboard keys, the position-true face buttons of each controller layout (on the 'bayx' layout the
 * south button is B), the touch control labels, the device → family choice, and the hint lists the HUD and
 * the Concierge render — with no platform names, logos or button symbols: letters, numbers, positions and
 * arrows only.
 * What breaks if it is removed? A hint telling a controller player to press a key, the wrong face button on a
 * swapped letter layout, or a trademarked button symbol could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  controlHints, familyOf, glyph, glyphKind, isPadFamily, spokenGlyph, type ControlAction, type GlyphFamily,
} from './glyphs.ts'

const ACTIONS: readonly ControlAction[] = ['move', 'look', 'run', 'interact', 'handbrake', 'reset', 'throttle', 'brake', 'clock', 'console', 'hud', 'ghost', 'ping']
const FAMILIES: readonly GlyphFamily[] = ['keyboard', 'abxy', 'bayx', 'numbered', 'generic', 'touch']
const row = (family: GlyphFamily) => Object.fromEntries(ACTIONS.map((a) => [a, glyph(a, family)]))

test('keyboard glyphs are the keys the Input class reads', () => {
  assert.deepEqual(row('keyboard'), {
    move: 'W A S D', look: 'Mouse', run: 'Shift', interact: 'E', handbrake: 'Space', reset: 'R',
    throttle: 'W', brake: 'S', clock: '[ ]', console: '~', hud: 'H', ghost: 'G', ping: 'Q',
  })
})

test('numbered layout: face buttons by position (no button symbols), shoulders and stick clicks by number', () => {
  assert.deepEqual(row('numbered'), {
    move: 'L', look: 'R', run: 'L3', interact: 'South', handbrake: 'East', reset: 'North',
    throttle: 'R2', brake: 'L2', clock: 'D-pad ◀ ▶', console: '~', hud: 'H', ghost: 'G', ping: 'R1',
  })
})

test('abxy layout: A south, B east, Y north', () => {
  assert.deepEqual(row('abxy'), {
    move: 'L', look: 'R', run: 'LS', interact: 'A', handbrake: 'B', reset: 'Y',
    throttle: 'RT', brake: 'LT', clock: 'D-pad ◀ ▶', console: '~', hud: 'H', ghost: 'G', ping: 'RB',
  })
})

test('bayx layout is position-true: south B, east A, north X', () => {
  const n = row('bayx')
  assert.equal(n.interact, 'B')
  assert.equal(n.handbrake, 'A')
  assert.equal(n.reset, 'X')
  assert.equal(n.throttle, 'ZR')
  assert.equal(n.brake, 'ZL')
  assert.equal(n.ping, 'R', 'the right shoulder, by this layout\'s name')
  // Same positions, different letters from the abxy layout.
  assert.notEqual(n.interact, glyph('interact', 'abxy'))
})

test('generic pads are named by button position', () => {
  const g = row('generic')
  assert.equal(g.interact, 'South')
  assert.equal(g.handbrake, 'East')
  assert.equal(g.reset, 'North')
  assert.equal(g.move, 'L')
  assert.equal(g.look, 'R')
  assert.equal(g.ping, 'RB')
})

test('touch glyphs are the on-screen control labels; missing controls are empty', () => {
  const t = row('touch')
  assert.equal(t.move, 'Stick')
  assert.equal(t.look, 'Drag')
  assert.equal(t.run, 'Run')
  assert.equal(t.interact, 'Enter car')
  assert.equal(t.brake, 'Brake')
  assert.equal(t.handbrake, 'Handbrake')
  assert.equal(t.reset, 'Reset')
  assert.equal(t.ping, 'Ping')
  assert.equal(t.clock, '')
  assert.equal(t.console, '')
  assert.equal(t.hud, '')
  assert.equal(t.ghost, '', 'no touch control for ghost view')
})

test('every glyph is plain text or an arrow: no private-use logo code points, no button symbols', () => {
  for (const f of FAMILIES) {
    for (const a of ACTIONS) {
      const g = glyph(a, f)
      assert.ok(/^[A-Za-z0-9 [\]~\-◀▶▲]*$/u.test(g), `${f}.${a} = ${JSON.stringify(g)}`)
      assert.ok(!/[✕×○◯△□▢⨯]/u.test(g), `${f}.${a}: a button symbol`)
      assert.ok(!/[-]/u.test(g))
    }
    // Controllers have no console, HUD or ghost view binding: the key is shown.
    if (isPadFamily(f)) {
      assert.equal(glyph('console', f), '~')
      assert.equal(glyph('hud', f), 'H')
      assert.equal(glyph('ghost', f), 'G')
      assert.equal(glyphKind('ghost', f), 'key')
    }
  }
  assert.equal(glyph('move', 'bogus' as GlyphFamily), '')
})

test('familyOf follows the device in use and the pad vendor', () => {
  assert.equal(familyOf('keyboard+mouse', null), 'keyboard')
  assert.equal(familyOf('keyboard+mouse', 'numbered'), 'keyboard', 'a pad that was set down does not win')
  assert.equal(familyOf('touch', 'abxy'), 'touch')
  assert.equal(familyOf('gamepad', 'numbered'), 'numbered')
  assert.equal(familyOf('gamepad', 'abxy'), 'abxy')
  assert.equal(familyOf('gamepad', 'bayx'), 'bayx')
  assert.equal(familyOf('gamepad', 'generic'), 'generic')
  assert.equal(familyOf('gamepad', null), 'generic')
  assert.deepEqual(FAMILIES.filter(isPadFamily), ['abxy', 'bayx', 'numbered', 'generic'])
})

test('glyphKind: keycaps, round face buttons, sticks, pills', () => {
  assert.equal(glyphKind('interact', 'keyboard'), 'key')
  assert.equal(glyphKind('move', 'keyboard'), 'key')
  assert.equal(glyphKind('interact', 'abxy'), 'button')
  assert.equal(glyphKind('reset', 'bayx'), 'button')
  assert.equal(glyphKind('interact', 'numbered'), 'pill', 'a position word, not a button symbol')
  assert.equal(glyphKind('interact', 'generic'), 'pill', 'a word does not fit a round button')
  assert.equal(glyphKind('move', 'abxy'), 'stick')
  assert.equal(glyphKind('look', 'bayx'), 'stick')
  assert.equal(glyphKind('throttle', 'numbered'), 'pill')
  assert.equal(glyphKind('run', 'abxy'), 'pill')
  assert.equal(glyphKind('ping', 'abxy'), 'pill', 'a shoulder button is a pill, not a face button')
  assert.equal(glyphKind('ping', 'keyboard'), 'key')
  assert.equal(glyphKind('console', 'numbered'), 'key', 'keyboard-only actions stay keycaps')
  assert.equal(glyphKind('hud', 'generic'), 'key')
  for (const a of ACTIONS) assert.equal(glyphKind(a, 'touch'), 'pill')
})

test('spokenGlyph reads the arrows and symbols as words for screen readers', () => {
  assert.equal(spokenGlyph('South'), 'South')
  assert.equal(spokenGlyph('D-pad ◀ ▶'), 'D-pad left right')
  assert.equal(spokenGlyph('~'), 'Tilde')
  assert.equal(spokenGlyph('W A S D'), 'W A S D')
  assert.equal(spokenGlyph('Stick ▲'), 'Stick up')
})

const summary = (family: GlyphFamily, driving: boolean, scope: 'tips' | 'all') =>
  controlHints(family, driving, scope).map((h) => `${h.glyph}=${h.label}`)

test('Concierge tips: three per family and mode, glyph-aware', () => {
  assert.deepEqual(summary('keyboard', false, 'tips'), ['W A S D=Walk', 'Mouse=Look around', '~=Ring-0 console'])
  assert.deepEqual(summary('numbered', false, 'tips'), ['L=Walk', 'R=Look around', 'South=Enter a car'])
  assert.deepEqual(summary('bayx', false, 'tips'), ['L=Walk', 'R=Look around', 'B=Enter a car'])
  assert.deepEqual(summary('touch', false, 'tips'), ['Stick=Walk', 'Drag=Look around', 'Enter car=Appears near a car'])
  assert.deepEqual(summary('keyboard', true, 'tips'), ['W=Accelerate', 'A D=Steer', 'E=Leave the car'])
  assert.deepEqual(summary('abxy', true, 'tips'), ['RT=Accelerate', 'LT=Brake · reverse', 'A=Leave the car'])
  assert.deepEqual(summary('touch', true, 'tips'), ['Stick=Steer and accelerate', 'Brake=Brake · reverse', 'Exit car=Leave the car'])
  for (const f of FAMILIES) for (const d of [false, true]) assert.equal(controlHints(f, d, 'tips').length, 3, `${f} ${d}`)
})

test('all controls: complete per family, unbound ones skipped', () => {
  assert.deepEqual(summary('keyboard', false, 'all'), [
    'W A S D=Walk', 'Mouse=Look around', 'Shift=Run', 'E=Enter a car', 'Q=Ping a spot or a person', '[ ]=Clock −1 h / +1 h', '~=Ring-0 console', 'H=Hide the HUD', 'G=Ghost view',
  ])
  assert.deepEqual(summary('keyboard', true, 'all'), [
    'A D=Steer', 'W=Accelerate', 'S=Brake · reverse', 'Space=Handbrake', 'R=Right the car', 'E=Leave the car', 'Q=Ping a spot or a person',
    'Mouse=Look around', '[ ]=Clock −1 h / +1 h', '~=Ring-0 console', 'H=Hide the HUD', 'G=Ghost view',
  ])
  assert.deepEqual(summary('numbered', true, 'all'), [
    'L=Steer', 'R2=Accelerate', 'L2=Brake · reverse', 'East=Handbrake', 'North=Right the car', 'South=Leave the car', 'R1=Ping a spot or a person',
    'R=Look around', 'D-pad ◀ ▶=Clock −1 h / +1 h', '~=Ring-0 console', 'H=Hide the HUD', 'G=Ghost view',
  ])
  assert.deepEqual(summary('touch', false, 'all'), ['Stick=Walk', 'Drag=Look around', 'Run=Run', 'Enter car=Enter a car', 'Ping=Ping a spot or a person'])
  assert.deepEqual(summary('touch', true, 'all'), [
    'Stick=Steer and accelerate', 'Brake=Brake · reverse', 'Handbrake=Handbrake', 'Reset=Right the car', 'Exit car=Leave the car', 'Ping=Ping a spot or a person', 'Drag=Look around',
  ])
  for (const f of FAMILIES) {
    for (const d of [false, true]) {
      const hints = controlHints(f, d, 'all')
      assert.equal(new Set(hints.map((h) => h.action)).size, hints.length, 'no action twice')
      for (const h of hints) {
        assert.ok(h.glyph.length > 0 && h.label.length > 0)
        assert.equal(h.kind, glyphKind(h.action, f))
      }
    }
  }
})
