/**
 * Why does this file exist? It proves the split-screen arithmetic: every layout tiles the canvas exactly at odd and
 * even sizes in both orientations, the aspect and the origin flip are right, a spectator is never the player's own
 * row and prefers tethered recruits, the spare pad's look stays within the head's pitch limit without allocating,
 * and the player count clamps into its range.
 * What breaks if it is removed? A one-pixel seam or overlap between quadrants, or a spectator on row 0, would reach
 * the browser unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PITCH_LIMIT } from '../04_Connect_Hardware/input.ts'
import {
  LOOK_AXES, NO_SPECTATOR, PLAYERS_RANGE, aspectOf, clampPlayers, createLookState, originBottomLeft, padLook, resetLook,
  spectatorFor, splitScreen, type Rect, type SpectatorCandidate,
} from './viewports.ts'

const SIZES: readonly [number, number][] = [
  [1920, 1080], [1280, 720], [1366, 768], [1081, 1081], [800, 600], [360, 780], [393, 851], [1, 1], [2, 3], [3, 2], [7, 5], [1023, 767],
]

/** The canvas a layout really tiles: a split canvas has at least two pixels per edge so each half keeps one. */
const canvasFor = (players: number, w: number, h: number): [number, number] => {
  const min = players > 1 ? 2 : 1
  return [Math.max(w, min), Math.max(h, min)]
}

const disjoint = (a: Rect, b: Rect): boolean =>
  a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y

/** Every rect has integer edges, no zero side, lies inside the canvas, overlaps none of the others, and together they cover it. */
function assertTiles(rects: Rect[], w: number, h: number, label: string): void {
  let area = 0
  for (const r of rects) {
    for (const v of [r.x, r.y, r.width, r.height]) assert.ok(Number.isInteger(v), `${label}: integer edges ${JSON.stringify(r)}`)
    assert.ok(r.width >= 1 && r.height >= 1, `${label}: no zero-size rect ${JSON.stringify(r)}`)
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= w && r.y + r.height <= h, `${label}: inside the canvas ${JSON.stringify(r)}`)
    area += r.width * r.height
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) assert.ok(disjoint(rects[i], rects[j]), `${label}: rects ${i} and ${j} overlap`)
  }
  assert.equal(area, w * h, `${label}: the union is the whole canvas`)
}

test('splitScreen: one to four rects tile the canvas exactly at every size and orientation', () => {
  for (const [w, h] of SIZES) {
    for (let players = PLAYERS_RANGE[0]; players <= PLAYERS_RANGE[1]; players++) {
      const rects = splitScreen(players, w, h)
      assert.equal(rects.length, players)
      assertTiles(rects, ...canvasFor(players, w, h), `${players}p ${w}x${h}`)
      assert.deepEqual([rects[0].x, rects[0].y], [0, 0], 'the first player is at the top-left corner')
    }
  }
})

test('splitScreen: one player is the full canvas; four are quadrants in reading order', () => {
  assert.deepEqual(splitScreen(1, 1920, 1080), [{ x: 0, y: 0, width: 1920, height: 1080 }])
  assert.deepEqual(splitScreen(4, 1920, 1080), [
    { x: 0, y: 0, width: 960, height: 540 },
    { x: 960, y: 0, width: 960, height: 540 },
    { x: 0, y: 540, width: 960, height: 540 },
    { x: 960, y: 540, width: 960, height: 540 },
  ])
  // The odd pixel goes to the second half.
  assert.deepEqual(splitScreen(4, 7, 5).map((r) => [r.width, r.height]), [[3, 2], [4, 2], [3, 3], [4, 3]])
})

test('splitScreen: two players sit side by side in landscape (and square), stacked in portrait', () => {
  const land = splitScreen(2, 1280, 720)
  assert.equal(land[0].height, 720)
  assert.equal(land[1].x, 640)
  assert.equal(land[1].y, 0)
  const square = splitScreen(2, 500, 500)
  assert.equal(square[1].x, 250, 'square counts as landscape')
  const port = splitScreen(2, 393, 851)
  assert.equal(port[0].width, 393)
  assert.equal(port[1].x, 0)
  assert.equal(port[1].y, 425)
  assert.equal(port[1].height, 426)
})

test('splitScreen: three players get one wide view across the top and two below it', () => {
  for (const [rw, rh] of SIZES) {
    const [w, h] = canvasFor(3, rw, rh)
    const [top, left, right] = splitScreen(3, rw, rh)
    assert.equal(top.width, w, 'the top view spans the width')
    assert.equal(top.y, 0)
    assert.equal(left.y, top.height)
    assert.equal(right.y, top.height)
    assert.equal(left.x, 0)
    assert.equal(right.x, left.width)
    assert.equal(left.height, right.height)
    assert.equal(left.height + top.height, h)
  }
})

test('splitScreen: the player count and the edges are clamped, never NaN or zero', () => {
  assert.equal(splitScreen(0, 100, 100).length, 1)
  assert.equal(splitScreen(9, 100, 100).length, 4)
  assert.equal(splitScreen(NaN, 100, 100).length, 1)
  assert.equal(splitScreen(2.9, 100, 100).length, 2)
  assertTiles(splitScreen(4, 100.7, 60.2), 100, 60, 'fractional edges floor')
  assert.deepEqual(splitScreen(1, 0, -5), [{ x: 0, y: 0, width: 1, height: 1 }])
  assert.deepEqual(splitScreen(1, NaN, Infinity), [{ x: 0, y: 0, width: 1, height: 1 }])
  // A canvas under two pixels cannot hold two non-empty halves: the split rects cover a two-pixel edge instead.
  assertTiles(splitScreen(4, 1, 1), 2, 2, 'a one-pixel canvas still gets four one-pixel rects')
  assertTiles(splitScreen(2, 0, 0), 2, 2, 'a collapsed canvas too')
  assert.deepEqual(splitScreen(1, 1, 1), [{ x: 0, y: 0, width: 1, height: 1 }], 'one player keeps the one pixel')
})

test('aspectOf: width over height, square for a degenerate rect', () => {
  assert.equal(aspectOf({ x: 0, y: 0, width: 1920, height: 1080 }), 1920 / 1080)
  assert.equal(aspectOf(splitScreen(2, 1280, 720)[0]), 640 / 720)
  assert.equal(aspectOf({ x: 0, y: 0, width: 10, height: 0 }), 1)
  assert.equal(aspectOf({ x: 0, y: 0, width: 0, height: 0 }), 1)
})

test('originBottomLeft: flips y from the bottom edge when asked, returns the rect unchanged otherwise, still tiles', () => {
  const r = { x: 960, y: 540, width: 960, height: 540 }
  assert.equal(originBottomLeft(r, 1080, false), r, 'no flip: the same object')
  assert.deepEqual(originBottomLeft(r, 1080, true), { x: 960, y: 0, width: 960, height: 540 })
  assert.deepEqual(originBottomLeft({ x: 0, y: 0, width: 1920, height: 540 }, 1080, true), { x: 0, y: 540, width: 1920, height: 540 })
  // Flipping twice is the identity, and the flipped set still tiles the canvas.
  for (const [w, h] of SIZES) {
    for (let players = 1; players <= 4; players++) {
      const [cw, ch] = canvasFor(players, w, h)
      const rects = splitScreen(players, w, h)
      const flipped = rects.map((x) => originBottomLeft(x, ch, true))
      assertTiles(flipped, cw, ch, `flipped ${players}p ${w}x${h}`)
      assert.deepEqual(flipped.map((x) => originBottomLeft(x, ch, true)), rects)
    }
  }
  // The wide top view of three ends up at the top of a bottom-left canvas: its y is the bottom row's height.
  const [top] = splitScreen(3, 1280, 721)
  assert.equal(originBottomLeft(top, 721, true).y, 361)
})

const recruit = (agent: number, state: SpectatorCandidate['state'] = 'Active'): SpectatorCandidate => ({ agent, state })

test('spectatorFor: never row 0, deterministic, distinct per viewport, and NO_SPECTATOR without a second row', () => {
  for (const agents of [2, 3, 7, 64, 4096, 20000]) {
    const picks = [1, 2, 3].map((k) => spectatorFor(k, agents, []))
    for (const p of picks) assert.ok(Number.isInteger(p) && p > 0 && p < agents, `${agents} rows: pick ${p} is a pedestrian row`)
    assert.equal(new Set(picks).size, 3 <= agents - 1 ? 3 : agents - 1, `${agents} rows: viewports share no person`)
    assert.deepEqual([1, 2, 3].map((k) => spectatorFor(k, agents, [])), picks, 'the same crowd gives the same picks')
  }
  assert.equal(spectatorFor(1, 1, []), NO_SPECTATOR, 'only the player: no one to look through')
  assert.equal(spectatorFor(1, 0, []), NO_SPECTATOR)
  assert.equal(spectatorFor(1, NaN, []), NO_SPECTATOR)
  assert.equal(spectatorFor(1, 2, []), 1, 'two rows: the one pedestrian')
  assert.equal(spectatorFor(2, 2, []), 1, 'a third viewport with one pedestrian looks through the same person rather than row 0')
})

test('spectatorFor: tethered recruits come first, Active before Interviewing, in list order, each once, row 0 refused', () => {
  const list = [recruit(0), recruit(17, 'Interviewing'), recruit(42), recruit(42), recruit(9), recruit(NaN), recruit(99999)]
  assert.equal(spectatorFor(1, 1000, list), 42, 'the first Active recruit (row 0 and NaN skipped)')
  assert.equal(spectatorFor(2, 1000, list), 9, 'the second Active recruit (42 once)')
  assert.equal(spectatorFor(3, 1000, list), 17, 'then the Interviewing one; 99999 is beyond the crowd')
  const fourth = spectatorFor(4, 1000, list)
  assert.ok(fourth > 0 && fourth < 1000 && ![42, 9, 17].includes(fourth), 'past the tethers: a hashed row no viewport holds')
  // A hashed pick never lands on a tethered row either.
  const base = spectatorFor(1, 64, [])
  assert.notEqual(spectatorFor(2, 64, [recruit(base)]), base)
  for (const k of [1, 2, 3]) assert.notEqual(spectatorFor(k, 3, [recruit(1), recruit(2)]), 0)
  assert.equal(spectatorFor(0, 1000, list), 42, 'k below 1 reads as the first spectating viewport')
})

test('padLook: pitch stays within the head limit, yaw accumulates unwrapped, look right = yaw down', () => {
  const s = createLookState()
  const up = [0, 0, 0, -1]
  for (let i = 0; i < 2000; i++) padLook(up, 1 / 60, s)
  assert.ok(s.pitch <= PITCH_LIMIT && s.pitch > PITCH_LIMIT - 1e-9, `pitch clamped at the limit (${s.pitch})`)
  const down = [0, 0, 0, 1]
  for (let i = 0; i < 2000; i++) padLook(down, 1 / 60, s)
  assert.ok(s.pitch >= -PITCH_LIMIT && s.pitch < -PITCH_LIMIT + 1e-9, 'and at the opposite limit')
  const right = [0, 0, 1, 0]
  const yaw0 = s.yaw
  for (let i = 0; i < 600; i++) padLook(right, 1 / 60, s)
  assert.ok(s.yaw < yaw0 - Math.PI * 2, `holding right for ten seconds turns more than a full circle, unwrapped (${s.yaw - yaw0})`)
  assert.ok(Number.isFinite(s.yaw) && Number.isFinite(s.pitch))
})

test('padLook: the dead zone, short or broken axes and bad dt all read as a still head', () => {
  const s = createLookState()
  for (const axes of [[0, 0, 0.1, 0.05], [1, 1], [], null, undefined, [0, 0, NaN, Infinity], [0, 0, 1, 0]]) {
    resetLook(s)
    for (let i = 0; i < 10; i++) padLook(axes, axes && axes.length === 4 && axes[2] === 1 ? NaN : 1 / 60, s)
    assert.deepEqual([s.yaw, s.pitch], [0, 0], `still for ${JSON.stringify(axes)}`)
  }
  assert.equal(LOOK_AXES.x, 2)
  assert.equal(LOOK_AXES.y, 3)
  // The main pad's own axes (0, 1) do not move a spare head.
  for (let i = 0; i < 10; i++) padLook([1, 1, 0, 0], 1 / 60, s)
  assert.deepEqual([s.yaw, s.pitch], [0, 0])
})

test('padLook: allocation-free, same identities over 1000 calls; resetLook stops the head', () => {
  const s = createLookState()
  const ids = [s, s.rates, s.stick, s.turn]
  const axes = new Float32Array([0, 0, 0.6, -0.4])
  for (let i = 0; i < 1000; i++) {
    axes[2] = Math.sin(i / 30)
    axes[3] = Math.cos(i / 47)
    const back = padLook(axes, 1 / 60, s)
    assert.equal(back, s)
  }
  assert.equal(s, ids[0])
  assert.equal(s.rates, ids[1])
  assert.equal(s.stick, ids[2])
  assert.equal(s.turn, ids[3])
  assert.ok(s.yaw !== 0 || s.pitch !== 0, 'the stick moved the head')
  assert.equal(resetLook(s), s)
  assert.deepEqual([s.yaw, s.pitch, s.rates.yawRate, s.rates.pitchRate, s.stick.x, s.turn.yaw], [0, 0, 0, 0, 0, 0])
})

test('PLAYERS_RANGE and clampPlayers: ?players clamps into [1, 4], junk is one player', () => {
  assert.deepEqual(PLAYERS_RANGE, [1, 4])
  assert.ok(Object.isFrozen(PLAYERS_RANGE))
  assert.equal(clampPlayers('3'), 3)
  assert.equal(clampPlayers(' 2 '), 2)
  assert.equal(clampPlayers('4.9'), 4)
  assert.equal(clampPlayers('0'), 1)
  assert.equal(clampPlayers('-3'), 1)
  assert.equal(clampPlayers('12'), 4)
  assert.equal(clampPlayers(2.5), 2)
  for (const junk of [null, undefined, '', ' ', 'four', 'NaN', NaN, Infinity, -Infinity, {}, [], true]) assert.equal(clampPlayers(junk), 1, `junk ${String(junk)}`)
})

test('air gap: the module imports only the hardware stage (no renderer, no DOM, no worker side)', () => {
  const src = readFileSync(new URL('./viewports.ts', import.meta.url), 'utf8')
  const specifiers = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.ok(specifiers.length > 0)
  for (const s of specifiers) assert.match(s, /^\.\.\/04_Connect_Hardware\/(gamepad|input)\.ts$/, `imports ${s}`)
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(code, /three|document|window|navigator|simProtocol|simClient|worker/i)
})
