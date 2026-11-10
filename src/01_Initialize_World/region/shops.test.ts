// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Lakefront Metro's five storefronts are chosen from its pack (region/shops.ts) on a street
 * window that has dropped streets, dead ends and water, after its workplaces. These tests hold the choice to its
 * promises on the real generated map (two seeds, the five zones each): five lots of the window, never a workplace's,
 * the landmark's or one under water, each with its doorway on a two-way street with a sidewalk whose corner the visitor
 * can walk to, the kinds in order, the nearest lots first, the same lots every time and the pack untouched. And they
 * hold the hollowing with shops (regionWorld.ts hollowLots): the shop lots' buildings put out of sight, a shop on each
 * built as storefronts.ts builds it with its slab in the podium's height and finish, the tower carried, the floor and
 * forecourt paved, the workplaces exactly as they were without shops, and a shop refused on a workplace's lot.
 * What breaks if it is removed? A shop could open onto a missing street or the lake, take a workplace's lot, or stand
 * inside a building still drawn round it in the map a returning visitor lands in, and only a GPU would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { CITY, STYLE, type Building } from '../city.ts'
import { ROOM, targetCorner, toWorld, type WorkplaceLot } from '../interiors.ts'
import { ZONE, generateLakefront } from '../lakefront.ts'
import { packOf } from '../lakefrontPack.ts'
import { SHOP_KINDS, shopsAt, type ShopLot } from '../storefronts.ts'
import { polygonAt, polygonCount, tallestBuilding, type RegionPack } from './pack.ts'
import { regionShopLots } from './shops.ts'
import { SEG, streetGridOf, type StreetGrid } from './streets.ts'
import { buildingLot, cornerComponent, cornerKey, cornerNear, frontOf, lotCandidates, regionWorkplaceLots, slabPodium, windowLotBuildings } from './workplaces.ts'

// Vite's `?raw` import, for Node: regionWorld.ts imports a module that takes WGSL that way (workplaces.test.ts's hook).
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { RegionPlaces, buildingStyle, hollowLots, layoutOf } = await import('./regionWorld.ts')

const P = CITY.pitch
interface Window { seed: number; zone: string; pack: RegionPack; before: string; layout: ReturnType<typeof layoutOf>; start: { x: number; z: number }; g: StreetGrid; lots: WorkplaceLot[]; shops: ShopLot[] }
const WINDOWS: Window[] = [1337, 7].flatMap((seed) => {
  const map = generateLakefront(seed, 64)
  return Object.entries(ZONE).filter(([name]) => name !== 'lake').map(([zone, z]) => {
    const pack = packOf(map, z)
    // The pack as it came, before anything reads it: a picker that wrote to it would show here, whatever it returned.
    const before = JSON.stringify(pack)
    const layout = layoutOf(pack)
    const start = new RegionPlaces(pack, layout).spawn({ x: layout.offset.x, z: layout.offset.z })
    const g = streetGridOf(pack, layout.offset, start)!
    const lots = regionWorkplaceLots(pack, layout, g, start, seed)
    return { seed, zone, pack, before, layout, start, g, lots, shops: regionShopLots(pack, layout, g, start, seed, lots) }
  })
})
const local = (w: Window, l: { k: number; m: number }) => ({ i: l.k - w.g.originX / P, j: l.m - w.g.originZ / P })
const key = (l: { k: number; m: number }) => `${l.k},${l.m}`
const overLot = (lot: { cx: number; cz: number }, { box: [x0, , z0, x1, , z1] }: Building) =>
  Math.abs((x0 + x1) / 2 - lot.cx) <= CITY.lotHalf && Math.abs((z0 + z1) / 2 - lot.cz) <= CITY.lotHalf
const byBox = (a: Building, b: Building) => a.box.join() < b.box.join() ? -1 : a.box.join() > b.box.join() ? 1 : 0
const pointIn = (x: number, z: number, ring: readonly (readonly [number, number])[]): boolean => {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j]
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) c = !c
  }
  return c
}

test('five lots of the window after the workplaces, never one of theirs, the landmark\'s or the lake; each doorway on a two-way street the visitor can walk to; the kinds in order; the same every time; the pack untouched', () => {
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const { shops, g } = w
    assert.equal(shops.length, SHOP_KINDS.length, `${at}: ${shops.length} shops`)
    assert.deepEqual(shops.map((s) => s.kind), [...SHOP_KINDS], `${at}: the kinds in order`)
    const taken = new Set(w.lots.map(key))
    assert.equal(new Set(shops.map(key)).size, shops.length, `${at}: every lot once`)
    const reach = cornerComponent(g, cornerNear(g, w.start))
    const tallest = tallestBuilding(w.pack)!
    for (const s of shops) {
      assert.ok(!taken.has(key(s)), `${at}: the ${s.kind} is not on a workplace's lot`)
      const { i, j } = local(w, s)
      assert.ok(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < g.blocks && j < g.blocks, `${at}: the ${s.kind} is in the window`)
      assert.equal(frontOf(g, i, j, s.side), SEG.walk | SEG.drive, `${at}: the ${s.kind}'s doorway is on a two-way street with a sidewalk`)
      const t = targetCorner({ k: i, m: j, side: s.side })
      assert.ok(reach.has(cornerKey(t)), `${at}: the ${s.kind}'s doorway is reachable from the start`)
      assert.ok(!(Math.floor((tallest.x + w.layout.offset.x) / P) === s.k && Math.floor((tallest.z + w.layout.offset.z) / P) === s.m), `${at}: not the landmark's lot`)
      const cx = (s.k + 0.5) * P - w.layout.offset.x, cz = (s.m + 0.5) * P - w.layout.offset.z
      for (let p = 0; p < polygonCount(w.pack.water); p++) assert.ok(!polygonAt(w.pack.water, p).some((r) => pointIn(cx, cz, r)), `${at}: the ${s.kind} is on dry land`)
    }
    assert.equal(JSON.stringify(w.pack), w.before, `${at}: the pack is only read (the snapshot was taken before any picker ran)`)
    assert.deepEqual(regionShopLots(w.pack, w.layout, g, w.start, w.seed, w.lots), shops, `${at}: the same lots again`)
    // From a fresh pack of the same map, the same lots: nothing the first run left behind chose them.
    const fresh = packOf(generateLakefront(w.seed, 64), ZONE[w.zone as keyof typeof ZONE])
    assert.deepEqual(regionShopLots(fresh, w.layout, g, w.start, w.seed, regionWorkplaceLots(fresh, w.layout, g, w.start, w.seed)), shops, `${at}: the same lots from a fresh pack`)
  }
  assert.notDeepEqual(WINDOWS[0].shops, WINDOWS[5].shops, 'another seed, other shops')
})

test('the shops stand where a visitor finds them: the nearest lots first, then the better built, the kinds in that order', () => {
  let tierDecided = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const taken = new Set(w.lots.map(key))
    const K0 = w.g.originX / P, M0 = w.g.originZ / P
    const all = lotCandidates(w.pack, w.layout, w.g, w.start).filter((c) => !taken.has(`${K0 + c.i},${M0 + c.j}`))
    const rank = new Map(all.map((c) => [`${K0 + c.i},${M0 + c.j}`, c]))
    const chosen = new Set(w.shops.map(key))
    const left = all.filter((c) => !chosen.has(`${K0 + c.i},${M0 + c.j}`))
    // No lot left out comes before a chosen one by (ring, tier): ties on both are the dice's.
    for (const s of w.shops) {
      const c = rank.get(key(s))!
      for (const o of left) {
        assert.ok(c.ring < o.ring || (c.ring === o.ring && c.tier <= o.tier), `${at}: the ${s.kind} (ring ${c.ring}, tier ${c.tier}) after a lot left out (ring ${o.ring}, tier ${o.tier})`)
        if (c.ring === o.ring && c.tier < o.tier) tierDecided++
      }
    }
    // The kinds go to the lots in rank order.
    const pairs = w.shops.map((s) => rank.get(key(s))!)
    for (let n = 1; n < pairs.length; n++) {
      const a = pairs[n - 1], b = pairs[n]
      assert.ok(a.ring < b.ring || (a.ring === b.ring && a.tier <= b.tier), `${at}: ${w.shops[n - 1].kind} before ${w.shops[n].kind}`)
    }
    assert.ok(Math.max(...pairs.map((c) => c.ring)) <= 3, `${at}: every shop within three lots of the start`)
  }
  assert.ok(tierDecided > 0, 'somewhere the tier, not the ring, decided between a shop and a lot left out')
})

test('hollowing with the shops: their buildings hidden, a shop on each in its podium\'s height and finish, the tower carried, the floors paved; the workplaces as they were', () => {
  let carried = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const on = windowLotBuildings(w.pack, w.layout.offset, w.g)
    // The sixteen workplaces take the hubs and the tall lots first, and in none of these windows does anything stand a
    // floor above the slab of a shop of its own. So the carrying is held on one shop more, hollowed with the window's
    // own: the first candidate lot that is no workplace's or shop's with something that high on it, where there is one.
    const taken = new Set([...w.lots, ...w.shops].map(key))
    const tall = lotCandidates(w.pack, w.layout, w.g, w.start).find((c) => {
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
