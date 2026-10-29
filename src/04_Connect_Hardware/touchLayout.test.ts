// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the touch layout's judge (touchLayout.ts): a layout drawn as the overlay draws
 * it, on foot and at the wheel, at the browser smoke test's phone sizes, is valid; and each rule is caught on its
 * own (off screen, under 44 pt, under 48 dp, off the size ladder, overlapping, under the 8 px gap, in the swipe
 * band at either edge, under the bottom inset, not laid out). It also pins PointerOwner's rule (the first finger
 * owns a held control; a second finger neither presses nor releases it) and the overlay's wiring: every control
 * marked for the judge, its insets from the rule book, the attribute it writes, the hold buttons owned per pointer.
 * What breaks if it is removed? A rule could be dropped or loosened, and the overlay could stop being judged at all.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { layoutAttribute, PointerOwner, SIZE_LADDER, stickBase, stickCentreBounds, TOUCH, validateTouchLayout, viewport, type ControlRect } from './touchLayout.ts'

const rect = (name: string, kind: ControlRect['kind'], x: number, y: number, w: number, h: number): ControlRect => ({ name, kind, x, y, w, h })

/** The overlay as drawn at a viewport: the stick zone, the look zone and the button cluster of each mode. */
function drawn(w: number, h: number, mode: 'foot' | 'car', nearVehicle = true, safe = { left: 0, right: 0, bottom: 0 }): ControlRect[] {
  // Tailwind's max-[376px] / max-[600px] are (width < 376px) / (width < 600px).
  const portrait = h > w, narrow = w < 376, short = h < 500
  const out: ControlRect[] = [
    rect('look', 'look', w / 2, 0, w / 2, h),
    rect('stick', 'stick', safe.left + TOUCH.stickInset, h - safe.bottom - TOUCH.stickInset - 184, 184, 184),
  ]
  // The cluster grows up and to the left from the bottom-right corner (inside the safe-area insets), rows 12 px apart
  // (gap-3); at the wheel in landscape under 600 px across the tap row closes up to 8 px (gap-2).
  const right = w - safe.right - TOUCH.insetX
  let bottom = h - safe.bottom - TOUCH.insetY
  // A column stacks its items top to bottom as flex-col does (the first item on top), or bottom to top for flex-col-reverse.
  const row = (items: [string, ControlRect['kind'], number, number][], column: false | 'col' | 'col-reverse', gap = 12) => {
    let x = right, tallest = 0
    if (column) {
      for (const [name, kind, bw, bh] of column === 'col' ? items.slice().reverse() : items) {
        out.push(rect(name, kind, right - bw, bottom - bh, bw, bh))
        bottom -= bh + gap
      }
      return
    }
    for (const [name, kind, bw, bh] of items.slice().reverse()) {
      out.push(rect(name, kind, x - bw, bottom - bh, bw, bh))
      x -= bw + gap
      tallest = Math.max(tallest, bh)
    }
    bottom -= tallest + 12
  }
  if (mode === 'car') {
    const brake = short ? 72 : 84, hand = short ? 64 : 72
    row([['Handbrake', 'hold', hand, hand], ['Brake', 'hold', brake, brake]], portrait && narrow ? 'col' : false)
    if (portrait) {
      row([['Reset', 'tap', 88, 48], ['Exit car', 'tap', 96, 48]], narrow ? false : 'col')
      row([['Menu', 'menu', 48, 48], ['Ping', 'tap', 88, 48]], false)
    } else row([['Menu', 'menu', 48, 48], ['Ping', 'tap', 88, 48], ['Reset', 'tap', 88, 48], ['Exit car', 'tap', 96, 48]], false, w < 600 ? 8 : 12)
  } else {
    row([['Ping', 'tap', 76, 76], ['Run', 'tap', 76, 76]], portrait && narrow ? 'col' : false)
    row(nearVehicle ? [['Menu', 'menu', 48, 48], ['Enter car', 'tap', 104, 48]] : [['Menu', 'menu', 48, 48]], portrait && narrow ? 'col-reverse' : false)
  }
  return out
}

/** The browser smoke test's views: six phone and tablet sizes both ways up, and two landscape views under browser bars. */
const SIZES = [[874, 402], [667, 375], [956, 440], [568, 320], [640, 360], [1180, 820]]
const VIEWS = [...SIZES.flatMap(([long, short]) => [[long, short], [short, long]]), [667, 325], [752, 280]]

test('the overlay as drawn is valid on foot and at the wheel at every phone and tablet size of the smoke test', () => {
  for (const [w, h] of VIEWS) {
    for (const mode of ['foot', 'car'] as const) {
      const v = validateTouchLayout(drawn(w, h, mode), viewport(w, h))
      assert.deepEqual(v.problems, [], `${w}x${h} ${mode}`)
      assert.equal(v.valid, true)
    }
    assert.equal(validateTouchLayout(drawn(w, h, 'foot', false), viewport(w, h)).valid, true, `${w}x${h} away from any car`)
  }
  // With a notch and a home indicator (an iPhone in landscape: 59 px at the sides, 21 at the foot), the insets move everything in.
  const safe = { left: 59, right: 59, bottom: 21 }
  for (const mode of ['foot', 'car'] as const) assert.deepEqual(validateTouchLayout(drawn(874, 402, mode, true, safe), viewport(874, 402, safe)).problems, [], mode)
  // Drawn without them where the browser reports them, the brakes sit in the band and under the home indicator.
  assert.deepEqual(validateTouchLayout(drawn(874, 402, 'car'), viewport(874, 402, safe)).problems.map((p) => p.split(':')[0]).sort(), ['Brake', 'Brake', 'Exit car', 'Handbrake', 'stick base'])
})

test('every rule is caught on its own, in words', () => {
  const vp = viewport(640, 360)
  const ok = drawn(640, 360, 'car')
  assert.equal(validateTouchLayout(ok, vp).valid, true)
  const problems = (over: ControlRect[]) => validateTouchLayout(over, vp).problems
  assert.deepEqual(problems([rect('Ping', 'tap', 600, 100, 88, 48)]), ['Ping: off screen', 'Ping: in the system\'s swipe band at the right edge (-48 px in, 24 needed)'])
  assert.deepEqual(problems([rect('Ping', 'tap', 100, 100, 40, 40)]), ['Ping: 40 px, under the 44 pt a finger needs', 'Ping: 40 px is not a size on the ladder'])
  assert.deepEqual(problems([rect('Ping', 'tap', 100, 100, 46, 46)]), ['Ping: 46 px, under the 48 dp a finger needs', 'Ping: 46 px is not a size on the ladder'])
  assert.deepEqual(problems([rect('Ping', 'tap', 100, 100, 50, 50)]), ['Ping: 50 px is not a size on the ladder'])
  assert.deepEqual(problems([rect('Ping', 'tap', 100, 100, 88, 48), rect('Run', 'tap', 150, 120, 76, 76)]), ['Ping over Run'])
  assert.deepEqual(problems([rect('Ping', 'tap', 100, 100, 88, 48), rect('Run', 'tap', 192, 100, 76, 76)]), ['Ping and Run: 4 px apart, under the 8 px gap'])
  assert.deepEqual(problems([rect('Ping', 'tap', 100, 100, 88, 48), rect('Run', 'tap', 196, 100, 76, 76)]), [], 'exactly the gap')
  assert.deepEqual(problems([rect('Menu', 'menu', 10, 100, 48, 48)]), ['Menu: in the system\'s swipe band at the left edge (10 px in, 24 needed)'])
  assert.deepEqual(problems([rect('Brake', 'hold', 540, 100, 84, 84)]), ['Brake: in the system\'s swipe band at the right edge (16 px in, 24 needed)'])
  assert.deepEqual(problems([rect('Brake', 'hold', 400, 300, 84, 84)]), ['Brake: off screen', 'Brake: under the bottom safe-area inset'])
  assert.deepEqual(validateTouchLayout([rect('Brake', 'hold', 400, 250, 84, 84)], viewport(640, 360, { bottom: 34 })).problems, ['Brake: under the bottom safe-area inset'])
  assert.deepEqual(problems([rect('stick', 'stick', 8, 168, 184, 184)]), [], 'the zone reaches into the band; its base does not')
  assert.deepEqual(problems([rect('stick', 'stick', -20, 168, 184, 184)]), ['stick: off screen', 'stick base: in the system\'s swipe band at the left edge (14 px in, 24 needed)'])
  assert.deepEqual(problems([rect('stick', 'stick', 30, 168, 100, 100)]), ['stick: 100 px, smaller than the stick\'s base', 'stick: 100 px is not a size on the ladder'])
  assert.deepEqual(problems([rect('Ping', 'tap', NaN, 100, 88, 48), rect('Run', 'tap', 300, 100, 76, 76)]), ['Ping: not laid out'])
  assert.deepEqual(problems([rect('look', 'look', 320, 0, 320, 360), rect('Ping', 'tap', 400, 100, 88, 48)]), [], 'the look zone is the ground the buttons stand on')
  assert.deepEqual(problems([rect('Menu', 'menu', 100, 100, 48, 48), rect('Brake', 'hold', 160, 100, 84, 84), rect('stick', 'stick', 260, 100, 184, 184)]), [], 'a gap of 12, and the stick 16 px on')
  assert.deepEqual(problems([rect('Brake', 'hold', 160, 100, 84, 84), rect('stick', 'stick', 240, 100, 184, 184)]), ['Brake over stick'], 'a button over the zone is over the stick')
})

test('the size ladder has eight rungs from the 48 px a finger needs to the stick\'s zone; stickBase is the middle 116', () => {
  assert.deepEqual([...SIZE_LADDER], [48, 64, 72, 76, 84, 88, 116, 184])
  assert.equal(SIZE_LADDER[0], TOUCH.minTarget)
  assert.ok(TOUCH.minTarget >= TOUCH.appleMinTarget)
  assert.deepEqual(stickBase(rect('stick', 'stick', 8, 100, 184, 184)), rect('stick base', 'stick', 42, 134, 116, 116))
  assert.deepEqual(stickBase(rect('stick', 'stick', 8, 100, 100, 100)), rect('stick base', 'stick', 8, 100, 100, 100), 'a zone no larger than the base is its own base')
  assert.equal(TOUCH.insetX, TOUCH.gestureInset, 'the cluster keeps out of the band by its own inset')
})

test('a rung of the ladder in rem, drawn larger by the root font size, is still a rung', () => {
  // Android text scaling at 1.25: the Menu (3 rem) draws at 60 px, a pill (h-12) at 60, the short-screen handbrake (4 rem)
  // at 80, while the px-sized brake (84) and the stick stay as they are.
  const controls = [
    rect('Menu', 'menu', 100, 100, 60, 60), rect('Ping', 'tap', 200, 100, 110, 60), rect('Handbrake', 'hold', 400, 100, 80, 80),
    rect('Brake', 'hold', 600, 100, 84, 84), rect('stick', 'stick', 100, 300, 184, 184),
  ]
  assert.deepEqual(validateTouchLayout(controls, { ...viewport(1180, 820), fontScale: 1.25 }).problems, [])
  const plain = validateTouchLayout(controls, viewport(1180, 820)).problems
  assert.deepEqual(plain, ['Menu: 60 px is not a size on the ladder', 'Ping: 60 px is not a size on the ladder', 'Handbrake: 80 px is not a size on the ladder'], 'without the scale the same layout fails the ladder')
  const odd = validateTouchLayout([rect('Menu', 'menu', 100, 100, 66, 66)], { ...viewport(800, 600), fontScale: 1.25 })
  assert.deepEqual(odd.problems, ['Menu: 66 px is not a size on the ladder'], 'a size on neither ladder (66, or 52.8 unscaled) still fails')
  assert.deepEqual(validateTouchLayout(controls, { ...viewport(1180, 820), fontScale: 0 }).problems, plain, 'a scale of 0 is no scale')
})

test('layoutAttribute: "valid", or "invalid: " and every problem', () => {
  assert.equal(layoutAttribute({ valid: true, problems: [] }), 'valid')
  assert.equal(layoutAttribute({ valid: false, problems: ['a', 'b'] }), 'invalid: a; b')
})

test('wiring: a hold whose capture was never taken is taken over by the next finger; sizes are measured without transforms', () => {
  const src = readFileSync(new URL('./TouchControls.tsx', import.meta.url), 'utf8')
  assert.match(src, /if \(o\.held && !owns\(e, o\.id\)\) \{ o\.clear\(\); set\(false\) \}/)
  assert.match(src, /const w = el\.offsetWidth \|\| r\.width, h = el\.offsetHeight \|\| r\.height/)
  assert.match(src, /fontScale = \(px\(getComputedStyle\(document\.documentElement\)\.fontSize\) \|\| 16\) \/ 16/)
})

test('PointerOwner: the first finger owns the hold; a second neither presses nor releases it', () => {
  const o = new PointerOwner()
  assert.equal(o.held, false)
  assert.equal(o.claim(5), true, 'free: taken')
  assert.equal(o.id, 5)
  assert.equal(o.claim(5), true, 'the owner may press again (a re-entered move)')
  assert.equal(o.claim(9), false, 'a second finger is refused')
  assert.equal(o.release(9), false, 'and its lift lets nothing go')
  assert.equal(o.held, true)
  assert.equal(o.release(5), true, 'the owner\'s lift releases')
  assert.equal(o.release(5), false, 'once')
  assert.equal(o.claim(9), true, 'free again: the next finger may take it')
  o.clear()
  assert.equal(o.held, false)
  assert.equal(o.id, -1)
})

test('wiring: the overlay marks every control for the judge, takes its insets from the rule book, writes the verdict, and owns each hold per pointer', () => {
  const src = readFileSync(new URL('./TouchControls.tsx', import.meta.url), 'utf8')
  assert.match(src, /import \{ layoutAttribute, PointerOwner, stickCentreBounds, TOUCH, validateTouchLayout/)
  for (const kind of ['tap', 'hold', 'menu', 'stick', 'look']) assert.match(src, new RegExp(`data-touch="${kind}"`), kind)
  assert.match(src, /right: `calc\(env\(safe-area-inset-right, 0px\) \+ \$\{TOUCH\.insetX\}px\)`, bottom: `calc\(env\(safe-area-inset-bottom, 0px\) \+ \$\{TOUCH\.insetY\}px\)`/)
  assert.match(src, /left: `calc\(env\(safe-area-inset-left, 0px\) \+ \$\{TOUCH\.stickInset\}px\)`/)
  assert.match(src, /root\.setAttribute\('data-touch-layout', layoutAttribute\(validateTouchLayout\(measureControls\(root\), viewportOf\(root\)\)\)\)/)
  assert.match(src, /\}, \[epoch, driving, nearVehicle\]\)/, 'judged again when the buttons change with the mode')
  const hold = src.slice(src.indexOf('function HoldButton'))
  assert.match(hold, /if \(!o\.claim\(e\.pointerId\)\) return/)
  assert.match(hold, /onPointerUp=\{release\}/)
  assert.match(hold, /onLostPointerCapture=\{release\}/)
  assert.match(hold, /own\(\)\.release\(e\.pointerId\)/)
  assert.doesNotMatch(src, /\bINSET\b/, 'no inset of its own beside the rule book')
  assert.match(src, /const STICK = \{ zone: 184, base: 116,/, 'the stick is drawn at the rule book\'s sizes')
  assert.match(src, /const b = stickCentreBounds\(rect\)/, 'a drag starts where the rule book allows')
})

test('stickCentreBounds: a thumb may put the base anywhere in the zone but never into the swipe band', () => {
  const zone = { left: 8, right: 192, top: 300, bottom: 484 }
  const b = stickCentreBounds(zone)
  assert.deepEqual(b, { minX: 8 + 16 + 58, maxX: 192 - 58, minY: 300 + 58, maxY: 484 - 58 })
  assert.equal(b.minX - 58, TOUCH.gestureInset, 'the base\'s left edge stops at the band')
  const v = validateTouchLayout([rect('stick base', 'stick', b.minX - 58, 300, 116, 116)], viewport(800, 600))
  assert.ok(!v.problems.some((p) => p.includes('band')), v.problems.join('; '))
})

test('a text pill narrower than the ladder\'s 88 is a problem; a round button of the same width is not', () => {
  const v = validateTouchLayout([rect('Ping', 'tap', 100, 100, 80, 48), rect('Run', 'tap', 300, 100, 76, 76)], viewport(800, 600))
  assert.deepEqual(v.problems, ['Ping: 80 px wide, under a text pill\'s 88'])
})
