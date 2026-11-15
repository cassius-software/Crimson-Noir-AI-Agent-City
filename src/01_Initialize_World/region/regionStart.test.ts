// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Where a visitor of Lakefront Metro first stands decides everything they see: the street
 * window (the people, the cars, the lamps) is the sixteen blocks round that point. The start used to be the midpoint
 * of the arterial nearest the chosen region's centre, which put the metropolis's visitor 742 m away in another region
 * and gave two regions one start. Now it is read from the placement (placement.ts starts) and snapped to a sidewalk
 * (regionWorld.ts regionStart, RegionPlaces.spawnAt). These tests hold that on the real generated map, three seeds by
 * five regions:
 * - the start stands in the region the visitor chose, and the HUD's lead (RegionPlaces.quarter) says that region;
 * - on a sidewalk: beside a street that has one, half a sidewalk past the kerb, a metre clear of every building and
 *   out of the water, within a few metres of the placement's hint;
 * - facing along that street, the way that looks toward the region's heart;
 * - five starts per map, no two within 300 m, each across the street from its region's shop;
 * - in its own region where the shop stands on the region's edge (the seeds that once started elsewhere) and, on a
 *   made-up map, where no front of the shop faces its own region at all (another of its places gives the start);
 * - the fallbacks: no placement (a surveyed region) answers the old rule, a placement without the chosen region's
 *   start answers its first, and a hint with no street near answers the old rule from the hint;
 * - quarter() names the region under a point, null over the lake, off the map and in a pack without the layer.
 * What breaks if it is removed? The start could slide back into another region, into a wall or the lake, or face a
 * blank wall, and the HUD could name the wrong region, and only a walk through all five would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CITY, POLES } from '../city.ts'
import { doorDir } from '../interiors.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { REGION_FORMAT, ROAD_CLASS, polygonAt, polygonCount, polygons, pushPolygon, type RegionPack } from './pack.ts'
import { regionPlacement, type RegionPlacement } from './placement.ts'
import { quarterAt } from './quarters.ts'
import { SEG, SIDEWALK, hSeg, mapStreetGrid, streetGridOf, vSeg, windowFurniture, type StreetGrid } from './streets.ts'
import { PERSON } from '../../07_Execute_Actions/simProtocol.ts'

// Vite's `?raw` import, for Node: regionWorld.ts imports a module that takes WGSL that way (workplaces.test.ts's hook).
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { RegionPlaces, START_LEAD, layoutOf, regionStart } = await import('./regionWorld.ts')

const P = CITY.pitch
const ZONES = ['metropolis', 'westSprawl', 'eastBluffs', 'northRidge', 'grandRavine'] as const
interface Start {
  seed: number; zone: (typeof ZONES)[number]; id: number; pack: RegionPack; layout: ReturnType<typeof layoutOf>
  places: InstanceType<typeof RegionPlaces>; placed: RegionPlacement; g: StreetGrid; at: { x: number; z: number; heading: number }
}
const STARTS: Start[] = [1337, 7, 42].flatMap((seed) => {
  const map = generateLakefront(seed, 64)
  return ZONES.map((zone): Start => {
    const pack = packOf(map, ZONE[zone])
    const layout = layoutOf(pack)
    const places = new RegionPlaces(pack, layout)
    const placed = regionPlacement(pack, layout, seed)!
    return { seed, zone, id: ZONE[zone], pack, layout, places, placed, g: mapStreetGrid(pack, layout.offset)!, at: regionStart(pack, layout, places, placed) }
  })
})
const name = (s: Start) => `seed ${s.seed} ${s.zone}`

/** The nearest street line of the map's grid to a point, the street's flags there, and how far the point is from it. */
function streetBeside(g: StreetGrid, p: { x: number; z: number }): { flags: number; d: number; along: 'x' | 'z' } {
  const fx = (p.x - g.originX) / P, fz = (p.z - g.originZ) / P
  const dx = Math.abs(fx - Math.round(fx)) * P, dz = Math.abs(fz - Math.round(fz)) * P
  // Nearer a north-south line (constant x): a v segment of column round(fx), row floor(fz); else an h segment.
  return dx < dz
    ? { flags: vSeg(g, Math.round(fx), Math.floor(fz)), d: dx, along: 'z' }
    : { flags: hSeg(g, Math.floor(fx), Math.round(fz)), d: dz, along: 'x' }
}

/** The distance from a point to the nearest edge of any building of the pack, m (engine metres). */
function clearance(s: Start, p: { x: number; z: number }): number {
  let best = Infinity
  const off = s.layout.offset
  for (let i = 0; i < polygonCount(s.pack.buildings); i++) {
    if (s.pack.buildings.height[i] <= 0) continue
    const ring = polygonAt(s.pack.buildings, i)[0]
    for (let k = 0; k < ring.length; k++) {
      const a = ring[k], b = ring[(k + 1) % ring.length]
      const ax = a[0] + off.x, az = a[1] + off.z, bx = b[0] + off.x, bz = b[1] + off.z
      const len2 = (bx - ax) ** 2 + (bz - az) ** 2
      const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * (bx - ax) + (p.z - az) * (bz - az)) / len2)) : 0
      best = Math.min(best, Math.hypot(p.x - ax - t * (bx - ax), p.z - az - t * (bz - az)))
    }
  }
  return best
}

test('the start stands in the region the visitor chose, and the HUD\'s lead names it', () => {
  for (const s of STARTS) {
    assert.equal(s.pack.quarters!.home, s.id, `${name(s)}: the pack starts in the chosen region`)
    assert.equal(quarterAt(s.pack, s.layout, s.at.x, s.at.z), s.id, `${name(s)}: the start is in its own region`)
    assert.equal(s.places.quarter(s.at.x, s.at.z), s.pack.quarters!.names[s.id], `${name(s)}: the lead is the region's name`)
  }
  // The five names are the map's own (lakefront.ts ZONES), one per region.
  const names = new Set(STARTS.filter((s) => s.seed === 1337).map((s) => s.places.quarter(s.at.x, s.at.z)))
  assert.equal(names.size, 5)
})

test('in its own region on seeds whose shop stands on a region\'s edge, its nearest front facing the next region', () => {
  // Each of these once started the visitor across the street in another region: the shop's front nearest the heart
  // faced a street whose far sidewalk is the next region's (seed 35's Grand Ravine design house, lot 36,26, faced
  // north into The East Bluffs). The first starter's doorway now faces a street whose far side is its own region's
  // (placement.ts attempt), and the start is read from the first place of the region that allows it (finish). These
  // are the five a one-off sweep found starting elsewhere before the change (seeds 0 to 400 and 1000 to 1100 and eight
  // large ones, all five regions: 2,550 starts); after it the same sweep found none.
  for (const [seed, zone] of [[35, 'grandRavine'], [232, 'grandRavine'], [315, 'grandRavine'], [387, 'grandRavine'], [1046, 'grandRavine']] as const) {
    const pack = packOf(generateLakefront(seed, 64), ZONE[zone])
    const layout = layoutOf(pack)
    const places = new RegionPlaces(pack, layout)
    const placed = regionPlacement(pack, layout, seed)!
    const at = regionStart(pack, layout, places, placed)
    assert.equal(quarterAt(pack, layout, at.x, at.z), ZONE[zone], `seed ${seed} ${zone}: starts in ${places.label(at.x, at.z)}`)
    assert.ok(places.label(at.x, at.z).startsWith(`${pack.quarters!.names[ZONE[zone]]} · `))
    assert.ok(!places.inBuilding(at.x, at.z, 1) && !places.inWater(at.x, at.z), `seed ${seed} ${zone}: clear and dry`)
  }
})

/**
 * A made-up map: a grid of `n` blocks, every street a two-lane local one, a 20 m square building of `heightOf` metres on
 * every lot, and the quarters layer from `quarterOf` (five names, flat ground).
 */
function gridPack(n: number, quarterOf: (k: number, m: number) => number, heightOf: (k: number, m: number) => number): RegionPack {
  const size = n * P
  const roads: RegionPack['roads'] = { cls: [], lanes: [], flow: [], name: [], start: [0], xz: [] }
  for (let line = 0; line <= n; line++) {
    for (const [x0, z0, x1, z1] of [[0, line * P, size, line * P], [line * P, 0, line * P, size]]) {
      roads.cls.push(ROAD_CLASS.local); roads.lanes.push(2); roads.flow.push(0); roads.name.push(1)
      roads.xz.push(x0 * 10, z0 * 10, x1 * 10, z1 * 10)
      roads.start.push(roads.xz.length / 2)
    }
  }
  const buildings: RegionPack['buildings'] = { ...polygons(), height: [], kind: [] }
  const id: number[] = [], terrain: number[] = []
  for (let m = 0; m < n; m++) {
    for (let k = 0; k < n; k++) {
      const cx = (k + 0.5) * P, cz = (m + 0.5) * P
      pushPolygon(buildings, [[[cx - 10, cz - 10], [cx + 10, cz - 10], [cx + 10, cz + 10], [cx - 10, cz + 10]]])
      buildings.height.push(heightOf(k, m) * 10); buildings.kind.push(0)
      id.push(quarterOf(k, m)); terrain.push(2)
    }
  }
  return {
    format: REGION_FORMAT, name: 'Testmere', grid: { lon0: 0, lat0: 0, k0: 1 }, bounds: { x0: 0, z0: 0, x1: size, z1: size }, attribution: ['a test'],
    names: ['', 'Grid Street'], roads, water: { ...polygons(), kind: [], name: [] }, buildings,
    quarters: { blocks: n, pitch: P, names: ['A', 'B', 'C', 'D', 'E'], id, terrain, home: 0 },
  }
}

test('a region whose shop faces only the next region across every street starts across from another of its places, inside it', () => {
  // Region A is one block with a tower (its heart, so its shop stands there, every front of it facing region B) and a
  // strip of blocks a column wide well off it, where its other places go; region B is the rest, with the map's tallest
  // building. Across from the shop is region B whichever way its doorway faces, so the start is taken from the first
  // of A's places whose far sidewalk is A's (placement.ts finish), and the visitor stands in A.
  const inA = (k: number, m: number) => (k === 10 && m === 10) || (k === 20 && m >= 16 && m <= 26)
  const pack = gridPack(30, (k, m) => (inA(k, m) ? 0 : 1), (k, m) => (k === 10 && m === 10 ? 200 : k === 3 && m === 3 ? 300 : 12))
  const layout = layoutOf(pack)
  const g = mapStreetGrid(pack, layout.offset)!
  const placed = regionPlacement(pack, layout, 5)!
  assert.ok(placed, 'the made-up map has its places')
  const K0 = Math.round(g.originX / P), M0 = Math.round(g.originZ / P)
  const tailor = placed.shops.find((s) => s.kind === 'tailor')!
  assert.deepEqual([tailor.k - K0, tailor.m - M0], [10, 10], 'region A\'s shop on its one block by the heart')
  // Every front of the shop faces region B across its street.
  const across = (p: { k: number; m: number; side: number }) => {
    const d = doorDir(p.side as 0 | 1 | 2 | 3), reach = g.roadHalf + SIDEWALK / 2
    return { x: (p.k + 0.5) * P + d.x * (P / 2 + reach), z: (p.m + 0.5) * P + d.z * (P / 2 + reach) }
  }
  for (const side of [0, 1, 2, 3]) { const at = across({ ...tailor, side }); assert.equal(quarterAt(pack, layout, at.x, at.z), 1, `the shop's side ${side} faces region B`) }
  const start = placed.starts.find((s) => s.quarter === 0)!
  assert.equal(quarterAt(pack, layout, start.x, start.z), 0, 'region A\'s start is in region A')
  // Across the street from one of region A's other places.
  const mine = [...placed.homes, ...placed.workplaces].filter((p) => inA(p.k - K0, p.m - M0))
  assert.ok(mine.some((p) => { const at = across(p); return Math.abs(at.x - start.x) < 1e-9 && Math.abs(at.z - start.z) < 1e-9 }), 'across from one of its places')
  // And the visitor stands there: on the sidewalk, in region A.
  const at = regionStart(pack, layout, new RegionPlaces(pack, layout), placed)
  assert.equal(quarterAt(pack, layout, at.x, at.z), 0)
  assert.ok(Math.hypot(at.x - start.x, at.z - start.z) <= START_LEAD + 12)
})

test('on a sidewalk: beside a street with one, half a sidewalk past the kerb, clear of buildings and water, by the hint', () => {
  for (const s of STARTS) {
    const beside = streetBeside(s.g, s.at)
    assert.ok(beside.flags & SEG.walk, `${name(s)}: the street beside the start has a sidewalk`)
    assert.ok(Math.abs(beside.d - (s.g.roadHalf + SIDEWALK / 2)) < 1e-6, `${name(s)}: the sidewalk's middle (${beside.d.toFixed(2)} m from the street's line)`)
    assert.ok(!s.places.inBuilding(s.at.x, s.at.z, 1), `${name(s)}: a metre clear by the places' own rule`)
    assert.ok(clearance(s, s.at) >= 1, `${name(s)}: ${clearance(s, s.at).toFixed(2)} m from the nearest wall`)
    assert.ok(!s.places.inWater(s.at.x, s.at.z), `${name(s)}: dry`)
    const hint = s.placed.starts.find((h) => h.quarter === s.id)!
    const off = Math.hypot(hint.x - s.at.x, hint.z - s.at.z)
    assert.ok(off <= START_LEAD + 12 + 1e-9, `${name(s)}: ${off.toFixed(1)} m from the placement's hint`)
  }
})

test('clear of the street\'s poles: every lamp, tree and signal of the start\'s window stands a metre past the visitor\'s reach', () => {
  // The hint is a block's middle, where the street's tree stands half a metre off the sidewalk's middle
  // (streets.ts windowFurniture); START_LEAD moves the visitor an eighth of a block on, five metres from every pole.
  assert.equal(START_LEAD, 5)
  for (const s of STARTS) {
    const g = streetGridOf(s.pack, s.layout.offset, s.at)!
    const f = windowFurniture(g, s.seed)
    let nearest = Infinity
    for (const [list, r] of [[f.lamps, POLES.lamp.radius], [f.trees, POLES.tree.radius], [f.signals, POLES.signal.radius]] as const) {
      for (const p of list) nearest = Math.min(nearest, Math.hypot(p[0] - s.at.x, p[1] - s.at.z) - r - PERSON.radius)
    }
    assert.ok(nearest >= 1, `${name(s)}: a pole ${nearest.toFixed(2)} m past the visitor's body`)
  }
})

test('facing along the street, the way that looks toward the region\'s heart', () => {
  for (const s of STARTS) {
    const ux = Math.sin(s.at.heading), uz = Math.cos(s.at.heading)
    const beside = streetBeside(s.g, s.at)
    // Along the street beside it: the grid's streets run along x or along z.
    assert.ok(Math.abs(beside.along === 'x' ? Math.abs(ux) - 1 : Math.abs(uz) - 1) < 1e-9, `${name(s)}: along the street (${ux.toFixed(2)}, ${uz.toFixed(2)})`)
    const heart = s.placed.anchors.find((a) => a.quarter === s.id)!
    // Seen from the hint, where the facing is chosen (the start is START_LEAD on from it, so a heart level with the
    // hint is that much behind the start: seed 1337's west sprawl). A heart square across the street is neither ahead
    // nor behind (seed 1337's ravine: the cosine's last bit).
    const hint = s.placed.starts.find((h) => h.quarter === s.id)!
    const toward = ((heart.k + 0.5) * P - hint.x) * ux + ((heart.m + 0.5) * P - hint.z) * uz
    assert.ok(toward > -1e-6, `${name(s)}: the heart is ahead of the hint, not behind (${toward.toFixed(0)} m along the view)`)
    assert.ok(Math.abs((s.at.x - hint.x) * ux + (s.at.z - hint.z) * uz) <= START_LEAD + 12 + 1e-9, `${name(s)}: the start is along the view from the hint`)
  }
})

test('five starts a map, no two within 300 m, each across the street from its region\'s shop', () => {
  for (const seed of [1337, 7, 42]) {
    const five = STARTS.filter((s) => s.seed === seed)
    for (let a = 0; a < 5; a++) for (let b = a + 1; b < 5; b++) {
      const d = Math.hypot(five[a].at.x - five[b].at.x, five[a].at.z - five[b].at.z)
      assert.ok(d > 300, `seed ${seed}: ${five[a].zone} and ${five[b].zone} start ${d.toFixed(0)} m apart`)
    }
    for (const s of five) {
      // The shop of the region: the one whose doorway's far sidewalk is the hint (placement.ts acrossFrom).
      const near = s.placed.shops.map((shop) => {
        const d = doorDir(shop.side)
        return Math.hypot((shop.k + 0.5) * P + d.x * P / 2 - s.at.x, (shop.m + 0.5) * P + d.z * P / 2 - s.at.z)
      })
      assert.ok(Math.min(...near) < 20, `${name(s)}: a shop's doorway ${Math.min(...near).toFixed(1)} m away, across the street`)
    }
  }
})

test('the same start from a fresh pack and a fresh placement; the placement and the pack only read', () => {
  const s = STARTS[0]
  const before = JSON.stringify(s.placed)
  const pack = packOf(generateLakefront(s.seed, 64), ZONE[s.zone])
  const layout = layoutOf(pack)
  assert.deepEqual(regionStart(pack, layout, new RegionPlaces(pack, layout), regionPlacement(pack, layout, s.seed)), s.at)
  assert.deepEqual(regionStart(s.pack, s.layout, s.places, s.placed), s.at)
  assert.equal(JSON.stringify(s.placed), before)
})

test('the fallbacks: no placement, a placement without the chosen region\'s start, a hint with no street near', () => {
  const s = STARTS.find((x) => x.seed === 1337 && x.zone === 'eastBluffs')!
  const old = s.places.spawn({ x: s.layout.offset.x, z: s.layout.offset.z })
  // A surveyed region has no placement: the old rule, a sidewalk of the arterial nearest the region's origin.
  assert.deepEqual(regionStart(s.pack, s.layout, s.places, null), old)
  assert.deepEqual(regionStart(s.pack, s.layout, s.places, { ...s.placed, starts: [] }), old)
  // No start for the chosen region (a map too small to give every region a place): the first start there is.
  const others = { ...s.placed, starts: s.placed.starts.filter((h) => h.quarter !== s.id) }
  const first = regionStart(s.pack, s.layout, s.places, others)
  assert.equal(quarterAt(s.pack, s.layout, first.x, first.z), others.starts[0].quarter)
  assert.ok(!s.places.inBuilding(first.x, first.z, 1) && !s.places.inWater(first.x, first.z))
  // A pack without the layer reads the first region's start.
  const bare: RegionPack = { ...s.pack, quarters: undefined }
  assert.deepEqual(regionStart(bare, s.layout, new RegionPlaces(bare, s.layout), s.placed), STARTS.find((x) => x.seed === 1337 && x.zone === 'metropolis')!.at)
  // A hint with no street within a block (far out on the lake): the old rule, from the hint.
  const lake = { x: s.layout.offset.x + s.pack.bounds.x1 - 20, z: s.layout.offset.z + s.pack.bounds.z1 - 20 }
  assert.ok(s.places.inWater(lake.x, lake.z), 'the map\'s south-east corner is the lake')
  assert.deepEqual(s.places.spawnAt(lake), s.places.spawn(lake))
  // Without a heart to look toward, the heading is the street's own, the way that points south or east; with no lead
  // the visitor stands on the hint itself (it is clear here), on the same sidewalk as the start, START_LEAD behind it.
  const hint = s.placed.starts.find((h) => h.quarter === s.id)!
  const plain = s.places.spawnAt(hint)
  assert.ok(Math.sin(plain.heading) + Math.cos(plain.heading) > 0)
  assert.deepEqual({ x: plain.x, z: plain.z }, { x: hint.x, z: hint.z })
  assert.ok(Math.abs(Math.hypot(plain.x - s.at.x, plain.z - s.at.z) - START_LEAD) < 1e-9)
  assert.equal(streetBeside(s.g, plain).d, streetBeside(s.g, s.at).d)
})

test('label(): the HUD\'s line leads with the region the point stands in, the map\'s name where it stands in none', () => {
  for (const s of STARTS) {
    const region = s.pack.quarters!.names[s.id], street = s.places.place(s.at.x, s.at.z)
    assert.notEqual(street, s.pack.name, `${name(s)}: the start is on a named street`)
    assert.ok(street.includes(' & '), `${name(s)}: a street and its cross street (${street})`)
    assert.equal(s.places.label(s.at.x, s.at.z), `${region} · ${street}`, name(s))
  }
  const s = STARTS[0]
  const off = s.layout.offset, b = s.pack.bounds
  // Out on the lake, away from every street: no region and no street, so the map's own name alone. Over water beside
  // a street (a bridge, the shore road): the map's name leads the street's.
  let open = 0, bridged = 0
  for (let z = off.z + b.z0 + 20; z < off.z + b.z1; z += 40) {
    for (let x = off.x + b.x0 + 20; x < off.x + b.x1; x += 40) {
      if (s.places.quarter(x, z) !== null) continue
      const street = s.places.place(x, z)
      if (street === s.pack.name) { open++; assert.equal(s.places.label(x, z), s.pack.name) }
      else { bridged++; assert.equal(s.places.label(x, z), `${s.pack.name} · ${street}`) }
    }
  }
  assert.ok(open > 100, `${open} blocks of open water read the map's name alone`)
  assert.ok(bridged > 0, `${bridged} blocks of water beside a street`)
  // A pack without the layer (a surveyed region) reads as it always did: the map's name, then the street.
  const bare: RegionPack = { ...s.pack, quarters: undefined }
  assert.equal(new RegionPlaces(bare, s.layout).label(s.at.x, s.at.z), `${s.pack.name} · ${s.places.place(s.at.x, s.at.z)}`)
  // Walking from one region into the next changes the lead: every region's heart leads with its own name.
  const leads = s.placed.anchors.map((a) => s.places.label((a.k + 0.5) * P, (a.m + 0.5) * P).split(' · ')[0])
  assert.deepEqual(leads, s.placed.anchors.map((a) => s.pack.quarters!.names[a.quarter]))
  // The engine's HUD line is this one (the district chip and the street line both read it).
  const engine = readFileSync(new URL('../../07_Execute_Actions/engine.ts', import.meta.url), 'utf8')
  assert.ok(engine.includes("return this.places?.label(x, z) ?? this.regionName ?? ''"))
  assert.ok(engine.includes('district: this.places ? this.regionPlace(x, z) :'))
})

test('quarter(): the region under a point; null over the lake, off the map and in a pack without the layer', () => {
  const s = STARTS[0]
  const off = s.layout.offset, b = s.pack.bounds
  assert.equal(s.places.quarter(off.x + b.x1 - 20, off.z + b.z1 - 20), null, 'open water')
  assert.equal(s.places.quarter(off.x + b.x0 - 50, off.z + b.z0 - 50), null, 'off the map')
  const bare: RegionPack = { ...s.pack, quarters: undefined }
  assert.equal(new RegionPlaces(bare, s.layout).quarter(s.at.x, s.at.z), null, 'no layer')
  // Every region's heart reads its own name.
  for (const a of s.placed.anchors) {
    assert.equal(s.places.quarter((a.k + 0.5) * P, (a.m + 0.5) * P), s.pack.quarters!.names[a.quarter])
  }
})
