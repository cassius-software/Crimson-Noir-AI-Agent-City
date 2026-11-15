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
import { CITY } from '../city.ts'
import { doorDir } from '../interiors.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { polygonAt, polygonCount, type RegionPack } from './pack.ts'
import { regionPlacement, type RegionPlacement } from './placement.ts'
import { quarterAt } from './quarters.ts'
import { SEG, SIDEWALK, hSeg, mapStreetGrid, vSeg, type StreetGrid } from './streets.ts'

// Vite's `?raw` import, for Node: regionWorld.ts imports a module that takes WGSL that way (workplaces.test.ts's hook).
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { RegionPlaces, layoutOf, regionStart } = await import('./regionWorld.ts')

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

test('on a sidewalk: beside a street with one, half a sidewalk past the kerb, clear of buildings and water, by the hint', () => {
  for (const s of STARTS) {
    const beside = streetBeside(s.g, s.at)
    assert.ok(beside.flags & SEG.walk, `${name(s)}: the street beside the start has a sidewalk`)
    assert.ok(Math.abs(beside.d - (s.g.roadHalf + SIDEWALK / 2)) < 1e-6, `${name(s)}: the sidewalk's middle (${beside.d.toFixed(2)} m from the street's line)`)
    assert.ok(!s.places.inBuilding(s.at.x, s.at.z, 1), `${name(s)}: a metre clear by the places' own rule`)
    assert.ok(clearance(s, s.at) >= 1, `${name(s)}: ${clearance(s, s.at).toFixed(2)} m from the nearest wall`)
    assert.ok(!s.places.inWater(s.at.x, s.at.z), `${name(s)}: dry`)
    const hint = s.placed.starts.find((h) => h.quarter === s.id)!
    assert.ok(Math.hypot(hint.x - s.at.x, hint.z - s.at.z) <= 12 + 1e-9, `${name(s)}: within twelve metres of the placement's hint`)
  }
})

test('facing along the street, the way that looks toward the region\'s heart', () => {
  for (const s of STARTS) {
    const ux = Math.sin(s.at.heading), uz = Math.cos(s.at.heading)
    const beside = streetBeside(s.g, s.at)
    // Along the street beside it: the grid's streets run along x or along z.
    assert.ok(Math.abs(beside.along === 'x' ? Math.abs(ux) - 1 : Math.abs(uz) - 1) < 1e-9, `${name(s)}: along the street (${ux.toFixed(2)}, ${uz.toFixed(2)})`)
    const heart = s.placed.anchors.find((a) => a.quarter === s.id)!
    const toward = ((heart.k + 0.5) * P - s.at.x) * ux + ((heart.m + 0.5) * P - s.at.z) * uz
    // A heart square across the street is neither ahead nor behind (seed 1337's ravine: the cosine's last bit).
    assert.ok(toward > -1e-6, `${name(s)}: the heart is ahead, not behind (${toward.toFixed(0)} m along the view)`)
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
  // Without a heart to look toward, the heading is the street's own, the way that points south or east.
  const hint = s.placed.starts.find((h) => h.quarter === s.id)!
  const plain = s.places.spawnAt(hint)
  assert.ok(Math.sin(plain.heading) + Math.cos(plain.heading) > 0)
  assert.deepEqual({ x: plain.x, z: plain.z }, { x: s.at.x, z: s.at.z }, 'the same point either way: only the facing differs')
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
