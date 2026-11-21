// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Lakefront Metro's five storefronts and seven homes stand on lots all over its map
 * (region/placement.ts chooses them with the workplaces; placement.test.ts holds the choice), and each is built by
 * hollowing its lot out of the pack (regionWorld.ts hollowLots). These tests hold that hollowing on the real generated
 * map (two seeds, two starts each: the lots are the same whichever quarter the pack starts in), with the placement's
 * own lots, near the start and a kilometre from it alike: the shop lots' and the home lots' buildings put out of
 * sight and no others, a shop on each built as storefronts.ts builds it and a home as properties.ts builds it, with
 * its slab in the podium's height and finish, the tower carried, the floor and forecourt paved; the workplaces exactly
 * as they were without shops, the workplaces and the shops exactly as they were without homes; and a shop refused on
 * a workplace's lot, a home on a shop's or a workplace's.
 * What breaks if it is removed? A shop or a home could stand inside a building still drawn round it, lose the tower
 * that stood on its lot, or move another place's boxes, in the map a returning visitor lands in, and only a GPU would
 * show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CITY, STYLE, type Building } from '../city.ts'
import { ROOM, toWorld, type WorkplaceLot } from '../interiors.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { PROPERTY_KINDS, homesAt, type HomeLot } from '../properties.ts'
import { SHOP_KINDS, shopsAt, type ShopLot } from '../storefronts.ts'
import { polygonAt, type RegionPack } from './pack.ts'
import { regionPlacement } from './placement.ts'
import { mapStreetGrid, type StreetGrid } from './streets.ts'
import { buildingLot, lotCandidates, slabPodium, windowLotBuildings } from './workplaces.ts'

// Vite's `?raw` import, for Node: regionWorld.ts imports a module that takes WGSL that way (workplaces.test.ts's hook).
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { buildingStyle, hollowLots, layoutOf } = await import('./regionWorld.ts')

const P = CITY.pitch
/** A map as one start sees it: `g` is the whole map's street grid (the places stand anywhere on it). */
interface Window {
  seed: number; zone: string; pack: RegionPack; layout: ReturnType<typeof layoutOf>; g: StreetGrid
  lots: WorkplaceLot[]; shops: ShopLot[]; homes: HomeLot[]
}
const WINDOWS: Window[] = [1337, 7].flatMap((seed) => {
  const map = generateLakefront(seed, 64)
  return (['metropolis', 'eastBluffs'] as const).map((zone) => {
    const pack = packOf(map, ZONE[zone])
    const layout = layoutOf(pack)
    const placed = regionPlacement(pack, layout, seed)!
    return { seed, zone, pack, layout, g: mapStreetGrid(pack, layout.offset)!, lots: placed.workplaces, shops: placed.shops, homes: placed.homes }
  })
})
const local = (w: Window, l: { k: number; m: number }) => ({ i: l.k - w.g.originX / P, j: l.m - w.g.originZ / P })
const key = (l: { k: number; m: number }) => `${l.k},${l.m}`
const overLot = (lot: { cx: number; cz: number }, { box: [x0, , z0, x1, , z1] }: Building) =>
  Math.abs((x0 + x1) / 2 - lot.cx) <= CITY.lotHalf && Math.abs((z0 + z1) / 2 - lot.cz) <= CITY.lotHalf
const byBox = (a: Building, b: Building) => a.box.join() < b.box.join() ? -1 : a.box.join() > b.box.join() ? 1 : 0

test('the fixture: every place of the programme stands, on a lot of its own', () => {
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    assert.deepEqual([w.lots.length, w.shops.length, w.homes.length], [ROOM.slots, SHOP_KINDS.length, PROPERTY_KINDS.length], at)
    assert.equal(new Set([...w.lots, ...w.shops, ...w.homes].map(key)).size, 28, `${at}: a lot each`)
  }
})

test('hollowing with the shops: their buildings hidden, a shop on each in its podium\'s height and finish, the tower carried, the floors paved; the workplaces as they were', () => {
  let carried = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const on = windowLotBuildings(w.pack, w.layout.offset, w.g)
    // A shop takes a mid-rise or a low building first, and whether anything stands a floor above its slab is the
    // map's. So the carrying is held on one shop more, hollowed with the map's own: the first candidate lot that is
    // no workplace's or shop's with something that high on it.
    const taken = new Set([...w.lots, ...w.shops].map(key))
    const tall = lotCandidates(w.pack, w.layout, w.g).find((c) => {
      const here = on[c.j * w.g.blocks + c.i], top = Math.max(slabPodium(here)?.height ?? 0, ROOM.height + 0.3)
      return !taken.has(`${w.g.originX / P + c.i},${w.g.originZ / P + c.j}`) && here.some((b) => b.height >= top + 3.3 - 1e-6)
    })
    const shops: ShopLot[] = tall ? [...w.shops, { kind: SHOP_KINDS[0], k: w.g.originX / P + tall.i, m: w.g.originZ / P + tall.j, side: tall.sides[0] }] : w.shops
    const plain = hollowLots(w.pack, w.layout, w.lots)
    const h = hollowLots(w.pack, w.layout, w.lots, shops)
    assert.deepEqual(plain.shops, [], `${at}: no shop lots, no shops`)
    assert.deepEqual(h.rooms, plain.rooms, `${at}: the workplaces as they were`)
    // Every building on a shop lot or a room's is hidden, and no other.
    const chosen = new Set([...w.lots, ...shops].map(key))
    for (let i = 0; i < w.pack.buildings.height.length; i++) {
      const on = buildingLot(w.pack, w.layout.offset, i)
      assert.equal(h.pack.buildings.height[i], on && chosen.has(`${on.K},${on.M}`) ? 0 : w.pack.buildings.height[i], `${at}: building ${i}`)
    }
    // Each shop is the storefront shopsAt builds on its lot, with the podium's height and finish for its slab.
    const want = shopsAt(shops, (k, m) => {
      const { i, j } = local(w, { k, m })
      const p = slabPodium(on[j * w.g.blocks + i])
      return p ? { top: Math.max(p.height, ROOM.height + 0.3), style: buildingStyle(w.pack, w.layout, p.i) } : { top: ROOM.height + 0.3, style: STYLE.mixed }
    })
    assert.deepEqual(h.shops, want, `${at}: the shops`)
    const inShop = new Set(h.shops.flatMap((s) => [...s.shell, ...s.furniture]))
    for (const b of inShop) assert.ok(h.plan.includes(b), `${at}: every shop box is drawn`)
    assert.deepEqual(h.plan.slice(0, plain.plan.length), plain.plan, `${at}: the rooms' boxes first, as they were`)
    // What the shops add beyond their own boxes is exactly what stood a floor or more above each slab, carried on it
    // from the slab's top as the box it was, in its own finish; nothing else.
    const lifted = h.plan.slice(plain.plan.length).filter((b) => !inShop.has(b))
    let above = 0
    for (const shop of h.shops) {
      const { i, j } = local(w, shop)
      const top = shop.shell[5].box[4]
      const want = on[j * w.g.blocks + i].filter((b) => b.height >= top + 3.3 - 1e-6)
        .map((b): Building => ({ box: [b.x0, top, b.z0, b.x1, b.height, b.z1], style: buildingStyle(w.pack, w.layout, b.i) }))
      assert.deepEqual(lifted.filter((b) => overLot(shop, b)).sort(byBox), want.sort(byBox), `${at} ${shop.kind}: carried above the slab`)
      for (const b of want) assert.ok(b.box[1] >= ROOM.height + 0.3 - 1e-9, `${at} ${shop.kind}: nothing carried reaches into the shop`)
      above += want.length
    }
    assert.equal(lifted.length, above, `${at}: nothing else is drawn`)
    carried += above
    // The floors: the rooms' as before, then each shop's lot and its forecourt.
    const rect = (a: { x: number; z: number }, b: { x: number; z: number }) => ({ x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) })
    const edge = CITY.pitch / 2 - 3.3 - 2.2
    assert.deepEqual(h.floors, [...plain.floors, ...h.shops.flatMap((s) => [
      rect(toWorld(s, -CITY.lotHalf, -CITY.lotHalf), toWorld(s, CITY.lotHalf, CITY.lotHalf)),
      rect(toWorld(s, CITY.lotHalf, -2.5), toWorld(s, edge, 2.5)),
    ])], `${at}: the floors`)
  }
  assert.ok(carried > 0, 'something stood above a shop\'s slab')
})

test('a shop is refused on a workplace\'s lot, and on another shop\'s', () => {
  const w = WINDOWS[0]
  assert.throws(() => hollowLots(w.pack, w.layout, w.lots, [{ ...w.shops[0], k: w.lots[0].k, m: w.lots[0].m }]), /one room or shop to a lot/)
  assert.throws(() => hollowLots(w.pack, w.layout, w.lots, [w.shops[0], { ...w.shops[1], k: w.shops[0].k, m: w.shops[0].m }]), /one room or shop to a lot/)
})

test('hollowing with the homes: the workplaces and the shops exactly as they were, a home on each lot in its podium\'s height and finish, the tower carried, the floors paved', () => {
  let carried = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const on = windowLotBuildings(w.pack, w.layout.offset, w.g)
    // The carrying is held on one home more than the map's own (which carry a tower where the penthouse or the
    // sky-mansion stands): on the first candidate lot no workplace, shop or home has, with something a floor above its
    // slab. With all seven indices used, the last home moves there, so the indices stay distinct.
    const taken = new Set([...w.lots, ...w.shops, ...w.homes].map(key))
    const tall = lotCandidates(w.pack, w.layout, w.g).find((c) => {
      const here = on[c.j * w.g.blocks + c.i], top = Math.max(slabPodium(here)?.height ?? 0, ROOM.height + 0.3)
      return !taken.has(`${w.g.originX / P + c.i},${w.g.originZ / P + c.j}`) && here.some((b) => b.height >= top + 3.3 - 1e-6)
    })
    const unused = PROPERTY_KINDS.findIndex((_, i) => !w.homes.some((x) => x.home === i))
    const extra = (home: number): HomeLot => ({ home, k: w.g.originX / P + tall!.i, m: w.g.originZ / P + tall!.j, side: tall!.sides[0] })
    const homes: HomeLot[] = !tall ? w.homes : unused >= 0 ? [...w.homes, extra(unused)] : [...w.homes.slice(0, -1), extra(w.homes[w.homes.length - 1].home)]
    const plain = hollowLots(w.pack, w.layout, w.lots, w.shops)
    const h = hollowLots(w.pack, w.layout, w.lots, w.shops, homes)
    assert.deepEqual(plain.homes, [], `${at}: no home lots, no homes`)
    assert.deepEqual(h.rooms, plain.rooms, `${at}: the workplaces as they were`)
    assert.deepEqual(h.shops, plain.shops, `${at}: the shops as they were`)
    assert.deepEqual(h.plan.slice(0, plain.plan.length), plain.plan, `${at}: the rooms' and the shops' boxes first, as they were`)
    assert.deepEqual(h.floors.slice(0, plain.floors.length), plain.floors, `${at}: the rooms' and the shops' floors first, as they were`)
    // Every building on a home's lot, a shop's or a room's is hidden, and no other.
    const chosen = new Set([...w.lots, ...w.shops, ...homes].map(key))
    for (let i = 0; i < w.pack.buildings.height.length; i++) {
      const on = buildingLot(w.pack, w.layout.offset, i)
      assert.equal(h.pack.buildings.height[i], on && chosen.has(`${on.K},${on.M}`) ? 0 : w.pack.buildings.height[i], `${at}: building ${i}`)
    }
    // Each home is the one homesAt builds on its lot, with the podium's height and finish for its slab.
    const want = homesAt(homes, (k, m) => {
      const { i, j } = local(w, { k, m })
      const p = slabPodium(on[j * w.g.blocks + i])
      return p ? { top: Math.max(p.height, ROOM.height + 0.3), style: buildingStyle(w.pack, w.layout, p.i) } : { top: ROOM.height + 0.3, style: STYLE.mixed }
    })
    assert.deepEqual(h.homes, want, `${at}: the homes`)
    const inHome = new Set(h.homes.flatMap((x) => [...x.shell, ...x.fixtures]))
    for (const b of inHome) assert.ok(h.plan.includes(b), `${at}: every home box is drawn`)
    // What the homes add beyond their own boxes is exactly what stood a floor or more above each slab, carried on it.
    const lifted = h.plan.slice(plain.plan.length).filter((b) => !inHome.has(b))
    let above = 0
    for (const home of h.homes) {
      const { i, j } = local(w, home)
      const top = home.shell[5].box[4]
      const carriedHere = on[j * w.g.blocks + i].filter((b) => b.height >= top + 3.3 - 1e-6 && polygonAt(w.pack.buildings, b.i).length === 1)
        .map((b): Building => ({ box: [b.x0, top, b.z0, b.x1, b.height, b.z1], style: buildingStyle(w.pack, w.layout, b.i) }))
      assert.deepEqual(lifted.filter((b) => overLot(home, b)).sort(byBox), carriedHere.sort(byBox), `${at} home ${home.home}: carried above the slab`)
      for (const b of carriedHere) assert.ok(b.box[1] >= ROOM.height + 0.3 - 1e-9, `${at} home ${home.home}: nothing carried reaches into the home`)
      above += carriedHere.length
    }
    assert.equal(lifted.length, above, `${at}: nothing else is drawn`)
    carried += above
    // The floors: the rooms' and the shops' as before, then each home's lot and its forecourt.
    const rect = (a: { x: number; z: number }, b: { x: number; z: number }) => ({ x0: Math.min(a.x, b.x), z0: Math.min(a.z, b.z), x1: Math.max(a.x, b.x), z1: Math.max(a.z, b.z) })
    const edge = CITY.pitch / 2 - 3.3 - 2.2
    assert.deepEqual(h.floors, [...plain.floors, ...h.homes.flatMap((x) => [
      rect(toWorld(x, -CITY.lotHalf, -CITY.lotHalf), toWorld(x, CITY.lotHalf, CITY.lotHalf)),
      rect(toWorld(x, CITY.lotHalf, -2.5), toWorld(x, edge, 2.5)),
    ])], `${at}: the floors`)
  }
  assert.ok(carried > 0, 'something stood above a home\'s slab')
})

test('a home is refused on a shop\'s lot, on a workplace\'s, and on another home\'s', () => {
  const w = WINDOWS[0]
  assert.throws(() => hollowLots(w.pack, w.layout, w.lots, w.shops, [{ ...w.homes[0], k: w.shops[0].k, m: w.shops[0].m }]), /one room or shop to a lot/)
  assert.throws(() => hollowLots(w.pack, w.layout, w.lots, w.shops, [{ ...w.homes[0], k: w.lots[0].k, m: w.lots[0].m }]), /one room or shop to a lot/)
  assert.throws(() => hollowLots(w.pack, w.layout, w.lots, w.shops, [w.homes[0], { ...w.homes[1], k: w.homes[0].k, m: w.homes[0].m }]), /one room or shop to a lot \(homes included\)/)
})
