// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Lakefront Metro's sixteen workplaces, five shops and seven homes used to stand on the
 * nearest lots to the start, inside the one street window, so more than nine tenths of the map had none. region/placement.ts
 * shares them out over the whole map by quarter, and gives each quarter a start. These tests hold that choice to its
 * promises on the real generated map (three seeds):
 * - every place of the programme stands, in its own quarter, the lists in the order their readers index them by;
 * - each on a lot a room may take: dry, not a ravine's floor, not The Spire's, its doorway on a two-way street with a
 *   sidewalk that is not the street round the map's edge, on the part of the map everyone can walk to;
 * - no two on neighbouring lots, not even corner to corner;
 * - each quarter's starters by its heart: the shop within three lots of it, the others within two of the shop, the
 *   start across the street from the shop's doorway, in its own quarter, the five starts far apart, the metropolis's
 *   under 300 m from The Spire;
 * - the rest spread: places in every quarter, across most of the map's width and height, no street window's worth of
 *   lots holding more than a third of them, and the homes named for a place standing on it (the bluffs, the shore,
 *   a tower);
 * - the same lots from the same seed, from a fresh pack, and whichever quarter the pack starts in; the pack only read;
 * - on a map too small for all of them, fewer stand, always the first of each list; a map without the quarters layer
 *   is one quarter; a region with no street grid has no placement.
 * And a golden holds seed 1337's lots and starts, so a change to the rule is seen as one.
 * What breaks if it is removed? The places could bunch up again round one start, stand in the lake or on a ravine's
 * floor, crowd each other's doorways, or move when the visitor picks another quarter, and only a long walk would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY } from '../city.ts'
import { ROOM, WORKPLACE_KINDS, doorDir, targetCorner, type Side } from '../interiors.ts'
import { TERRAIN, ZONE, generateLakefront, type LakefrontMap } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { PROPERTY_KINDS } from '../properties.ts'
import { SHOP_KINDS } from '../storefronts.ts'
import { REGION_FORMAT, ROAD_CLASS, polygonAt, polygonCount, polygons, pushPolygon, tallestBuilding, type RegionPack } from './pack.ts'
import { PROGRAMME, SPACING, STARTER_REACH, STARTER_RING, regionPlacement, type RegionPlacement } from './placement.ts'
import { GROUND, quarterAt, terrainAt } from './quarters.ts'
import { SEG, SIDEWALK, WINDOW_BLOCKS, mapStreetGrid, type StreetGrid } from './streets.ts'
import { cornerKey, frontOf, largestCornerComponent, lotTier, windowLotBuildings } from './workplaces.ts'

const P = CITY.pitch
/** The engine's corner of a generated region (regionWorld.ts REGION_CORNER, layoutOf): the pack's bounds land on it. */
const layoutOf = (pack: RegionPack) => ({ offset: { x: Math.round(2000 - pack.bounds.x0), z: Math.round(2000 - pack.bounds.z0) } })
const SEEDS = [1337, 7, 42]
interface World { seed: number; map: LakefrontMap; pack: RegionPack; layout: ReturnType<typeof layoutOf>; g: StreetGrid; placed: RegionPlacement }
const WORLDS: World[] = SEEDS.map((seed) => {
  const map = generateLakefront(seed, 64)
  const pack = packOf(map, ZONE.metropolis)
  const layout = layoutOf(pack)
  return { seed, map, pack, layout, g: mapStreetGrid(pack, layout.offset)!, placed: regionPlacement(pack, layout, seed)! }
})
type Place = { what: string; k: number; m: number; side: Side; type: 'work' | 'shop' | 'home' }
const placesOf = (p: RegionPlacement): Place[] => [
  ...p.workplaces.map((w): Place => ({ what: w.kind, k: w.k, m: w.m, side: w.side, type: 'work' })),
  ...p.shops.map((s): Place => ({ what: s.kind, k: s.k, m: s.m, side: s.side, type: 'shop' })),
  ...p.homes.map((h): Place => ({ what: PROPERTY_KINDS[h.home], k: h.k, m: h.m, side: h.side, type: 'home' })),
]
const cheb = (a: { k: number; m: number }, b: { k: number; m: number }) => Math.max(Math.abs(a.k - b.k), Math.abs(a.m - b.m))
const centre = (l: { k: number; m: number }) => ({ x: (l.k + 0.5) * P, z: (l.m + 0.5) * P })
/** Where a place's doorway meets its street: the middle of its front, on the lot's edge. */
const doorOf = (l: { k: number; m: number; side: Side }) => { const c = centre(l), d = doorDir(l.side); return { x: c.x + d.x * P / 2, z: c.z + d.z * P / 2 } }
const pointIn = (x: number, z: number, ring: readonly (readonly [number, number])[]): boolean => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

test('the programme: sixteen workplaces, five shops and seven homes, each once; a shop, a workplace and three starters in every quarter', () => {
  const all = PROGRAMME.flat()
  assert.deepEqual(all.filter((p) => p.type === 'work').map((p) => p.kind).sort(), [...WORKPLACE_KINDS].sort())
  assert.deepEqual(all.filter((p) => p.type === 'shop').map((p) => p.kind).sort(), [...SHOP_KINDS].sort())
  assert.deepEqual(all.filter((p) => p.type === 'home').map((p) => p.kind).sort(), [...PROPERTY_KINDS].sort())
  assert.equal(PROGRAMME.length, 5, 'the lakefront\'s five quarters')
  for (const [q, list] of PROGRAMME.entries()) {
    assert.equal(list.filter((p) => p.type === 'shop').length, 1, `quarter ${q}: one shop`)
    assert.ok(list.some((p) => p.type === 'work'), `quarter ${q}: a workplace`)
    // The starters first: the shop leads (the start stands across from it), then two more, one a workplace.
    assert.deepEqual(list.map((p) => p.starter), list.map((_, n) => n < 3), `quarter ${q}: three starters, first`)
    assert.equal(list[0].type, 'shop', `quarter ${q}: the shop leads`)
    assert.ok(list.slice(0, 3).some((p) => p.type === 'work'), `quarter ${q}: a workplace by the heart`)
  }
})

test('every place stands, in its own quarter, the lists in the order their readers index them by', () => {
  for (const w of WORLDS) {
    const { placed } = w
    assert.deepEqual([placed.workplaces.length, placed.shops.length, placed.homes.length], [ROOM.slots, SHOP_KINDS.length, PROPERTY_KINDS.length], `seed ${w.seed}`)
    // interiors.ts packRooms slots a room by its place in the list, workplaceTable by its kind: the same number.
    assert.deepEqual(placed.workplaces.map((x) => x.kind), [...WORKPLACE_KINDS], `seed ${w.seed}: the workplaces in kind order`)
    assert.deepEqual(placed.shops.map((x) => x.kind), [...SHOP_KINDS], `seed ${w.seed}: the shops in kind order`)
    assert.deepEqual(placed.homes.map((x) => x.home), PROPERTY_KINDS.map((_, i) => i), `seed ${w.seed}: the homes by property index`)
    const where = new Map(placesOf(placed).map((p) => [p.what, p]))
    for (const [q, list] of PROGRAMME.entries()) {
      for (const p of list) {
        const at = where.get(p.kind)!
        const c = centre(at)
        assert.equal(quarterAt(w.pack, w.layout, c.x, c.z), q, `seed ${w.seed}: the ${p.kind} stands in quarter ${q}`)
      }
    }
  }
})

test('each on a lot a room may take: dry, off the ravine\'s floor, not The Spire\'s, its doorway on a two-way street with a sidewalk that everyone can walk to and that is not the street round the map\'s edge', () => {
  for (const w of WORLDS) {
    const { g, placed } = w
    const S = g.blocks, K0 = g.originX / P, M0 = g.originZ / P
    const reach = largestCornerComponent(g)
    const tallest = tallestBuilding(w.pack)!
    const spire = { k: Math.floor((tallest.x + w.layout.offset.x) / P), m: Math.floor((tallest.z + w.layout.offset.z) / P) }
    for (const p of placesOf(placed)) {
      const at = `seed ${w.seed}: the ${p.what} on lot ${p.k - K0},${p.m - M0}`
      const i = p.k - K0, j = p.m - M0
      assert.ok(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < S && j < S, `${at} is on the map`)
      assert.equal(frontOf(g, i, j, p.side), SEG.walk | SEG.drive, `${at}: its doorway is on a two-way street with a sidewalk`)
      assert.ok(reach.has(cornerKey(targetCorner({ k: i, m: j, side: p.side }))), `${at}: its doorway's corner can be walked to`)
      const edge = p.side === 0 ? j + 1 === S : p.side === 1 ? j === 0 : p.side === 2 ? i + 1 === S : i === 0
      assert.ok(!edge, `${at}: its doorway does not face the street round the map's edge`)
      assert.ok(!(p.k === spire.k && p.m === spire.m), `${at}: not The Spire's lot`)
      // Dry: the lot's middle and its four corners (a metre in) are in no water polygon; and the ground is no ravine's
      // floor and no lake.
      const c = centre(p)
      for (const [dx, dz] of [[0, 0], [-19, -19], [19, -19], [19, 19], [-19, 19]]) {
        const x = c.x + dx - w.layout.offset.x, z = c.z + dz - w.layout.offset.z
        for (let n = 0; n < polygonCount(w.pack.water); n++) assert.ok(!polygonAt(w.pack.water, n).some((r) => pointIn(x, z, r)), `${at} is dry land`)
      }
      const ground = terrainAt(w.pack, w.layout, c.x, c.z)
      assert.ok(ground !== GROUND.ravine && ground !== GROUND.lake && ground >= 0, `${at}: ground ${ground}`)
    }
  }
})

test('no two places stand on neighbouring lots, not even corner to corner', () => {
  for (const w of WORLDS) {
    const all = placesOf(w.placed)
    assert.equal(all.length, 28)
    let least = Infinity
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) least = Math.min(least, cheb(all[a], all[b]))
    assert.ok(least >= SPACING, `seed ${w.seed}: two places ${least} lots apart`)
  }
  assert.equal(SPACING, 2)
})

test('each quarter\'s starters stand by its heart, and its start across the street from its shop: a shop and a workplace in sight of every start', () => {
  for (const w of WORLDS) {
    const { placed } = w
    const where = new Map(placesOf(placed).map((p) => [p.what, p]))
    assert.deepEqual(placed.starts.map((s) => s.quarter), [0, 1, 2, 3, 4], `seed ${w.seed}: a start for every quarter`)
    assert.deepEqual(placed.anchors.map((a) => a.quarter), [0, 1, 2, 3, 4], `seed ${w.seed}: a heart for every quarter`)
    for (const [q, list] of PROGRAMME.entries()) {
      const at = `seed ${w.seed} quarter ${q}`
      const heart = placed.anchors[q], start = placed.starts[q]
      const hc = centre(heart)
      assert.equal(quarterAt(w.pack, w.layout, hc.x, hc.z), q, `${at}: its heart is its own`)
      const shop = where.get(list[0].kind)!
      assert.ok(cheb(shop, heart) <= STARTER_RING, `${at}: the shop is ${cheb(shop, heart)} lots from the heart`)
      for (const p of list.slice(1, 3)) assert.ok(cheb(where.get(p.kind)!, shop) <= STARTER_REACH, `${at}: the ${p.kind} is ${cheb(where.get(p.kind)!, shop)} lots from the shop`)
      // The start: the far sidewalk's middle, straight across from the shop's doorway, in the quarter itself.
      const door = doorOf(shop), d = doorDir(shop.side)
      const reach = w.g.roadHalf + SIDEWALK / 2
      assert.ok(Math.abs(start.x - (door.x + d.x * reach)) < 1e-9 && Math.abs(start.z - (door.z + d.z * reach)) < 1e-9, `${at}: the start is across from the shop's doorway`)
      assert.equal(quarterAt(w.pack, w.layout, start.x, start.z), q, `${at}: the start stands in its own quarter`)
      // What a visitor finds on foot from there: the shop across the street, a workplace within three blocks.
      const far = (p: Place) => { const o = doorOf(p); return Math.hypot(o.x - start.x, o.z - start.z) }
      assert.ok(far(shop) < 12, `${at}: the shop's doorway is ${far(shop).toFixed(1)} m away`)
      const works = list.filter((p) => p.type === 'work').map((p) => far(where.get(p.kind)!))
      assert.ok(Math.min(...works) < 140, `${at}: the nearest workplace is ${Math.min(...works).toFixed(0)} m away`)
    }
    // Five different places to begin, none within 300 m of another (North Ridge and The Grand Ravine shared one
    // start before): the quarters are places of their own.
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) {
      const d = Math.hypot(placed.starts[a].x - placed.starts[b].x, placed.starts[a].z - placed.starts[b].z)
      assert.ok(d > 300, `seed ${w.seed}: the starts of quarters ${a} and ${b} are ${d.toFixed(0)} m apart`)
    }
    // The metropolis starts by The Spire (it used to start 742 m from its own centre, in North Ridge).
    const tallest = tallestBuilding(w.pack)!
    const spire = Math.hypot(tallest.x + w.layout.offset.x - placed.starts[0].x, tallest.z + w.layout.offset.z - placed.starts[0].z)
    assert.ok(spire < 300, `seed ${w.seed}: the metropolis starts ${spire.toFixed(0)} m from The Spire`)
  }
})

test('the rest are spread: places across most of the map, in every quarter, never a street window\'s worth of lots holding more than a third of them', () => {
  for (const w of WORLDS) {
    const all = placesOf(w.placed)
    const S = w.g.blocks, K0 = w.g.originX / P, M0 = w.g.originZ / P
    const is = all.map((p) => p.k - K0), js = all.map((p) => p.m - M0)
    assert.ok(Math.max(...is) - Math.min(...is) >= 0.7 * S, `seed ${w.seed}: the places span ${Math.max(...is) - Math.min(...is)} lots west to east`)
    // North to south the map's last rows are the lake: the places span most of the land.
    assert.ok(Math.max(...js) - Math.min(...js) >= 0.55 * S, `seed ${w.seed}: the places span ${Math.max(...js) - Math.min(...js)} lots north to south`)
    // Any window of the street window's size (16 by 16 lots), anywhere on the map.
    let most = 0
    for (let j = 0; j + WINDOW_BLOCKS <= S; j++) for (let i = 0; i + WINDOW_BLOCKS <= S; i++) {
      most = Math.max(most, all.filter((p) => p.k - K0 >= i && p.k - K0 < i + WINDOW_BLOCKS && p.m - M0 >= j && p.m - M0 < j + WINDOW_BLOCKS).length)
    }
    assert.ok(most <= 9, `seed ${w.seed}: one window holds ${most} of the 28 places (all 28 stood in one before)`)
    // At least six places (eight or nine on these seeds) stand more than a window's half-width from every start.
    const farOnes = all.filter((p) => w.placed.starts.every((s) => { const c = centre(p); return Math.max(Math.abs(c.x - s.x), Math.abs(c.z - s.z)) > 320 }))
    assert.ok(farOnes.length >= 6, `seed ${w.seed}: ${farOnes.length} places beyond every start's window`)
  }
})

test('the homes named for a place stand on it, and the towers\' rooms on tower lots', () => {
  for (const w of WORLDS) {
    const { g, placed } = w
    const S = g.blocks, K0 = g.originX / P, M0 = g.originZ / P
    const on = windowLotBuildings(w.pack, w.layout.offset, g)
    const tierOf = (l: { k: number; m: number }) => lotTier(on[(l.m - M0) * S + l.k - K0])
    const groundOf = (l: { k: number; m: number }) => { const c = centre(l); return terrainAt(w.pack, w.layout, c.x, c.z) }
    const home = (kind: string) => placed.homes[PROPERTY_KINDS.indexOf(kind as (typeof PROPERTY_KINDS)[number])]
    const work = (kind: string) => placed.workplaces[WORKPLACE_KINDS.indexOf(kind as (typeof WORKPLACE_KINDS)[number])]
    // The villas over the lake: on a bluff or the shore (the east bluffs have both on every seed).
    for (const kind of ['glassVilla', 'estate']) assert.ok(([GROUND.bluff, GROUND.shore] as number[]).includes(groundOf(home(kind))), `seed ${w.seed}: the ${kind} stands on ground ${groundOf(home(kind))}`)
    assert.equal(groundOf(home('timberLoft')), GROUND.shore, `seed ${w.seed}: the timber loft is on the shore`)
    // Tiers (workplaces.ts LOT_TIERS): 0 a hub's podium under its tower, 1 a tall building.
    assert.ok(tierOf(home('penthouse')) <= 1, `seed ${w.seed}: the penthouse is under a tower (tier ${tierOf(home('penthouse'))})`)
    assert.ok(tierOf(home('skyMansion')) <= 1, `seed ${w.seed}: the sky-mansion is under a tower (tier ${tierOf(home('skyMansion'))})`)
    for (const kind of ['clearingFloor', 'serverVault', 'twinStudio', 'consoleDeck']) assert.ok(tierOf(work(kind)) <= 1, `seed ${w.seed}: the ${kind} is under a tower (tier ${tierOf(work(kind))})`)
  }
})

test('the same lots from the same seed, from a fresh pack and whichever quarter the pack starts in; the pack only read; another seed, other lots', () => {
  for (const w of WORLDS) {
    const before = JSON.stringify(w.pack)
    assert.equal(regionPlacement(w.pack, w.layout, w.seed), w.placed, `seed ${w.seed}: kept for the pack`)
    assert.equal(JSON.stringify(w.pack), before, `seed ${w.seed}: the pack is only read`)
    for (const zone of [ZONE.metropolis, ZONE.westSprawl, ZONE.eastBluffs, ZONE.northRidge, ZONE.grandRavine]) {
      const pack = packOf(w.map, zone)
      const snapshot = JSON.stringify(pack)
      const again = regionPlacement(pack, layoutOf(pack), w.seed)
      assert.deepEqual(again, w.placed, `seed ${w.seed}: the same places from the pack that starts in zone ${zone}`)
      assert.equal(JSON.stringify(pack), snapshot, `seed ${w.seed} zone ${zone}: the pack is only read`)
    }
  }
  assert.notDeepEqual(WORLDS[0].placed.workplaces, WORLDS[1].placed.workplaces, 'another seed, another map, other lots')
  // The dice are the seed's: the same map under another seed keeps the rule and moves some doorways.
  const w = WORLDS[0]
  const other = regionPlacement(w.pack, w.layout, w.seed + 1)!
  assert.deepEqual([other.workplaces.length, other.shops.length, other.homes.length], [16, 5, 7])
  assert.notDeepEqual(placesOf(other), placesOf(w.placed))
})

test('seed 1337: the lots, the doorways and the starts (map blocks)', () => {
  const w = WORLDS[0]
  const K0 = w.g.originX / P, M0 = w.g.originZ / P
  const row = (p: Place) => `${p.what} ${p.k - K0},${p.m - M0} ${p.side}`
  assert.deepEqual(placesOf(w.placed).map(row), [
    'roboticsLab 15,30 0', 'warehouse 10,12 3', 'serverVault 33,42 3', 'metroOps 41,10 2', 'controlTower 30,14 0', 'kitchen 49,28 0', 'microFab 12,34 2', 'twinStudio 31,41 3',
    'fleetBay 9,2 3', 'greenhouse 38,24 1', 'acousticsLab 49,32 1', 'responseCenter 33,24 0', 'clearingFloor 33,39 0', 'gaitLab 48,0 2', 'microgrid 17,18 0', 'consoleDeck 26,41 2',
    'tailor 27,43 1', 'inkStudio 48,30 0', 'prosthetics 14,32 2', 'horology 29,16 2', 'designHouse 38,22 0',
    'microLoft 25,44 2', 'brownstone 39,20 0', 'timberLoft 1,45 0', 'penthouse 27,39 1', 'glassVilla 56,43 2', 'estate 46,43 2', 'skyMansion 31,17 3',
  ])
  // The starts, in metres from the map's north-west corner: a lot's middle along the street, 4.4 m past the doorway's
  // street line across it (the lane's 3.3 m and half the sidewalk's 2.2 m).
  assert.deepEqual(w.placed.starts.map((s) => [s.quarter, s.x - w.g.originX, s.z - w.g.originZ].map((v) => Math.round(v * 10) / 10)), [
    [0, 1100, 1715.6], [1, 604.4, 1300], [2, 1940, 1244.4], [3, 1204.4, 660], [4, 1540, 924.4],
  ])
  assert.deepEqual(w.placed.anchors.map((a) => [a.quarter, a.k - K0, a.m - M0]), [[0, 29, 40], [1, 15, 32], [2, 49, 31], [3, 31, 15], [4, 38, 22]])
})

// ---------------------------------------------------------------- small maps, no layer, no grid

/** A grid pack by hand: `n` by `n` lots of 40 m with a two-lane street on every line, a 20 m square building on every lot. */
function gridPack(n: number): RegionPack {
  const size = n * P
  const roads: RegionPack['roads'] = { cls: [], lanes: [], flow: [], name: [], start: [0], xz: [] }
  for (let line = 0; line <= n; line++) {
    for (const pts of [[0, line * P, size, line * P], [line * P, 0, line * P, size]]) {
      roads.cls.push(ROAD_CLASS.local); roads.lanes.push(2); roads.flow.push(0); roads.name.push(1)
      for (const c of pts) roads.xz.push(c * 10)
      roads.start.push(roads.xz.length / 2)
    }
  }
  const buildings = { ...polygons(), height: [] as number[], kind: [] as number[] }
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const cx = (i + 0.5) * P, cz = (j + 0.5) * P
    pushPolygon(buildings, [[[cx - 10, cz - 10], [cx + 10, cz - 10], [cx + 10, cz + 10], [cx - 10, cz + 10]]])
    buildings.height.push(100 + 10 * ((i * 7 + j * 3) % 5)); buildings.kind.push(0)
  }
  return {
    format: REGION_FORMAT, name: 'Testmere', grid: { lon0: 0, lat0: 0, k0: 1 }, bounds: { x0: 0, z0: 0, x1: size, z1: size }, attribution: ['a test'], names: ['', 'Grid Street'],
    roads, water: { ...polygons(), kind: [], name: [] }, buildings,
  }
}

test('a map without the quarters layer is one quarter: every place on it, the first shop, home and workplace by the middle, one start', () => {
  const pack = gridPack(24)
  const layout = { offset: { x: 2000, z: 2000 } }
  const g = mapStreetGrid(pack, layout.offset)
  assert.ok(g, 'a grid pack has a street grid')
  const placed = regionPlacement(pack, layout, 5)!
  assert.deepEqual([placed.workplaces.length, placed.shops.length, placed.homes.length], [16, 5, 7])
  assert.deepEqual(placed.workplaces.map((x) => x.kind), [...WORKPLACE_KINDS])
  assert.deepEqual(placed.starts.map((s) => s.quarter), [0])
  assert.equal(placed.anchors.length, 1)
  const all = placesOf(placed)
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) assert.ok(cheb(all[a], all[b]) >= SPACING)
  // The heart is the lot at the pack's origin (the layout's offset), and the first of each list stands by it.
  const heart = placed.anchors[0]
  assert.deepEqual([heart.k, heart.m], [50, 50])
  for (const first of [placed.shops[0], placed.homes[0], placed.workplaces[0]]) assert.ok(cheb(first, heart) <= STARTER_RING + STARTER_REACH)
  assert.deepEqual(regionPlacement(gridPack(24), layout, 5), placed, 'the same from a fresh pack')
})

test('a map too small for all of them: fewer stand, always the first of each list, still a lot apart; a region with no street grid has no placement', () => {
  const layout = { offset: { x: 2000, z: 2000 } }
  // Seven lots a side: with a free lot between any two, at most sixteen fit (four a row, four rows), fewer with the
  // doorways kept off the edge street.
  const small = regionPlacement(gridPack(7), layout, 5)!
  const total = small.workplaces.length + small.shops.length + small.homes.length
  assert.ok(total > 0 && total < 28, `${total} places on a map of 49 lots`)
  assert.deepEqual(small.workplaces.map((x) => x.kind), WORKPLACE_KINDS.slice(0, small.workplaces.length), 'the first workplaces, no slot skipped')
  assert.deepEqual(small.shops.map((x) => x.kind), SHOP_KINDS.slice(0, small.shops.length), 'the first shops')
  assert.deepEqual(small.homes.map((x) => x.home), small.homes.map((_, i) => i), 'the first homes')
  // Shared round: a workplace fewer, then a home, then a shop, in turn, so no list is emptied for another.
  assert.ok(small.workplaces.length > 0 && small.shops.length > 0 && small.homes.length > 0, `${small.workplaces.length} workplaces, ${small.shops.length} shops, ${small.homes.length} homes`)
  const all = placesOf(small)
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) assert.ok(cheb(all[a], all[b]) >= SPACING)
  // One lot: its only fronts are the edge's, so nothing stands and nothing throws.
  const none = regionPlacement(gridPack(1), layout, 5)!
  assert.deepEqual([none.workplaces, none.shops, none.homes], [[], [], []])
  // A surveyed region: no road on the grid, no street grid, no placement.
  const surveyed: RegionPack = { ...gridPack(4), roads: { cls: [ROAD_CLASS.local], lanes: [2], flow: [0], name: [1], start: [0, 2], xz: [13, 17, 4011, 2903] } }
  assert.equal(mapStreetGrid(surveyed, layout.offset), null)
  assert.equal(regionPlacement(surveyed, layout, 5), null)
})

test('the ground codes the programme reads are the generator\'s own', () => {
  assert.deepEqual({ ...GROUND }, { lake: TERRAIN.lake, shore: TERRAIN.shore, flat: TERRAIN.flat, ravine: TERRAIN.ravine, bluff: TERRAIN.bluff, ridge: TERRAIN.ridge })
})
