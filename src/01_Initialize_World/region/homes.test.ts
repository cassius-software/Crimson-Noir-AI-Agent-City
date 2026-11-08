// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Lakefront Metro's seven homes are chosen from its pack (region/homes.ts) on a street window
 * that has dropped streets, dead ends and water, after its workplaces and its shops. These tests hold the choice to its
 * promises on the real generated map (two seeds, the five zones each): at most seven lots of the window, never a
 * workplace's, a shop's, the landmark's or one under water, each doorway on a front the candidates allow, the grander
 * homes on lots at least as well built as the plainer ones', the same lots every time and the pack untouched. And they
 * hold the hollowing with homes (regionWorld.ts hollowLots): the workplaces and the shops exactly as they were without
 * homes, each home built as properties.ts builds it with its slab in the podium's height and finish, the tower carried,
 * the floor and forecourt paved, and a home refused on a shop's lot.
 * What breaks if it is removed? A home could open onto a missing street or the lake, take a shop's lot, or move a shop's
 * boxes in the map a returning visitor lands in, and only a GPU would show it.
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
import { PROPERTY_KINDS, homesAt, type HomeLot } from '../properties.ts'
import type { ShopLot } from '../storefronts.ts'
import { regionHomeLots } from './homes.ts'
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
interface Window {
  seed: number; zone: string; pack: RegionPack; before: string; layout: ReturnType<typeof layoutOf>; start: { x: number; z: number }; g: StreetGrid
  lots: WorkplaceLot[]; shops: ShopLot[]; homes: HomeLot[]
}
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
    const shops = regionShopLots(pack, layout, g, start, seed, lots)
    return { seed, zone, pack, before, layout, start, g, lots, shops, homes: regionHomeLots(pack, layout, g, start, seed, [...lots, ...shops]) }
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

test('at most seven lots of the window after the workplaces and the shops, never one of theirs, the landmark\'s or the lake; each doorway on a front the candidates allow; the same every time; the pack untouched', () => {
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const { homes, g } = w
    assert.equal(homes.length, PROPERTY_KINDS.length, `${at}: ${homes.length} homes (the window has room for all seven)`)
    assert.deepEqual(homes.map((x) => x.home), [0, 1, 2, 3, 4, 5, 6], `${at}: the properties in order`)
    assert.equal(new Set(homes.map(key)).size, homes.length, `${at}: every lot once`)
    const taken = new Set([...w.lots, ...w.shops].map(key))
    const reach = cornerComponent(g, cornerNear(g, w.start))
    const tallest = tallestBuilding(w.pack)!
    const K0 = g.originX / P, M0 = g.originZ / P
    const candidates = new Map(lotCandidates(w.pack, w.layout, g, w.start).map((c) => [`${K0 + c.i},${M0 + c.j}`, c]))
    for (const x of homes) {
      const name = PROPERTY_KINDS[x.home]
      assert.ok(!taken.has(key(x)), `${at}: the ${name} is not on a workplace's or a shop's lot`)
      const { i, j } = local(w, x)
      assert.ok(Number.isInteger(i) && Number.isInteger(j) && i >= 0 && j >= 0 && i < g.blocks && j < g.blocks, `${at}: the ${name} is in the window`)
      const c = candidates.get(key(x))
      assert.ok(c, `${at}: the ${name} is on a candidate lot`)
      assert.ok(c.sides.includes(x.side), `${at}: the ${name}'s doorway is on a front the candidates allow`)
      assert.equal(frontOf(g, i, j, x.side), SEG.walk | SEG.drive, `${at}: the ${name}'s doorway is on a two-way street with a sidewalk`)
      assert.ok(reach.has(cornerKey(targetCorner({ k: i, m: j, side: x.side }))), `${at}: the ${name}'s doorway is reachable from the start`)
      assert.ok(!(Math.floor((tallest.x + w.layout.offset.x) / P) === x.k && Math.floor((tallest.z + w.layout.offset.z) / P) === x.m), `${at}: not the landmark's lot`)
      const cx = (x.k + 0.5) * P - w.layout.offset.x, cz = (x.m + 0.5) * P - w.layout.offset.z
      for (let p = 0; p < polygonCount(w.pack.water); p++) assert.ok(!polygonAt(w.pack.water, p).some((r) => pointIn(cx, cz, r)), `${at}: the ${name} is on dry land`)
    }
    assert.equal(JSON.stringify(w.pack), w.before, `${at}: the pack is only read (the snapshot was taken before any picker ran)`)
    assert.deepEqual(regionHomeLots(w.pack, w.layout, g, w.start, w.seed, [...w.lots, ...w.shops]), homes, `${at}: the same lots again`)
    // From a fresh pack of the same map, the same lots: nothing the first run left behind chose them.
    const fresh = packOf(generateLakefront(w.seed, 64), ZONE[w.zone as keyof typeof ZONE])
    const lots = regionWorkplaceLots(fresh, w.layout, g, w.start, w.seed)
    assert.deepEqual(regionHomeLots(fresh, w.layout, g, w.start, w.seed, [...lots, ...regionShopLots(fresh, w.layout, g, w.start, w.seed, lots)]), homes, `${at}: the same lots from a fresh pack`)
  }
  assert.notDeepEqual(WINDOWS[0].homes, WINDOWS[5].homes, 'another seed, other homes')
})

test('the homes stand where a visitor finds them, and the grander homes on lots at least as well built as the plainer ones\'', () => {
  let tierDecided = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const taken = new Set([...w.lots, ...w.shops].map(key))
    const K0 = w.g.originX / P, M0 = w.g.originZ / P
    const all = lotCandidates(w.pack, w.layout, w.g, w.start).filter((c) => !taken.has(`${K0 + c.i},${M0 + c.j}`))
    const rank = new Map(all.map((c) => [`${K0 + c.i},${M0 + c.j}`, c]))
    const chosen = new Set(w.homes.map(key))
    const left = all.filter((c) => !chosen.has(`${K0 + c.i},${M0 + c.j}`))
    // No lot left out comes before a chosen one by (ring, tier): ties on both are the dice's.
    for (const x of w.homes) {
      const c = rank.get(key(x))!
      for (const o of left) assert.ok(c.ring < o.ring || (c.ring === o.ring && c.tier <= o.tier), `${at}: home ${x.home} (ring ${c.ring}, tier ${c.tier}) after a lot left out (ring ${o.ring}, tier ${o.tier})`)
    }
    // A grander home never on a worse built lot than a plainer one; on the same tier, never farther out.
    const picks = w.homes.map((x) => rank.get(key(x))!)
    for (let a = 0; a < picks.length; a++) for (let b = a + 1; b < picks.length; b++) {
      assert.ok(picks[b].tier <= picks[a].tier, `${at}: ${PROPERTY_KINDS[b]} (tier ${picks[b].tier}) on a worse lot than ${PROPERTY_KINDS[a]} (tier ${picks[a].tier})`)
      if (picks[b].tier === picks[a].tier) assert.ok(picks[b].ring <= picks[a].ring, `${at}: ${PROPERTY_KINDS[b]} farther out than ${PROPERTY_KINDS[a]} on the same tier`)
      if (picks[b].tier < picks[a].tier) tierDecided++
    }
    assert.ok(Math.max(...picks.map((c) => c.ring)) <= 4, `${at}: every home within four lots of the start`)
  }
  assert.ok(tierDecided > 0, 'somewhere a grander home took a better built lot')
})

test('fewer candidates than seven: the cheapest homes stand, on the plainest of the lots there are', () => {
  const w = WINDOWS[0]
  const K0 = w.g.originX / P, M0 = w.g.originZ / P
  const all = lotCandidates(w.pack, w.layout, w.g, w.start).map((c) => ({ k: K0 + c.i, m: M0 + c.j }))
  // Take every candidate but three: the window has three lots left for homes.
  const three = regionHomeLots(w.pack, w.layout, w.g, w.start, w.seed, all.slice(3))
  assert.deepEqual(three.map((x) => x.home), [0, 1, 2])
  assert.deepEqual(regionHomeLots(w.pack, w.layout, w.g, w.start, w.seed, all), [], 'no lot left, no home')
})

test('hollowing with the homes: the workplaces and the shops exactly as they were, a home on each lot in its podium\'s height and finish, the tower carried, the floors paved', () => {
  let carried = 0
  for (const w of WINDOWS) {
    const at = `seed ${w.seed} ${w.zone}`
    const plain = hollowLots(w.pack, w.layout, w.lots, w.shops)
    const h = hollowLots(w.pack, w.layout, w.lots, w.shops, w.homes)
    assert.deepEqual(plain.homes, [], `${at}: no home lots, no homes`)
    assert.deepEqual(h.rooms, plain.rooms, `${at}: the workplaces as they were`)
    assert.deepEqual(h.shops, plain.shops, `${at}: the shops as they were`)
    assert.deepEqual(h.plan.slice(0, plain.plan.length), plain.plan, `${at}: the rooms' and the shops' boxes first, as they were`)
    assert.deepEqual(h.floors.slice(0, plain.floors.length), plain.floors, `${at}: the rooms' and the shops' floors first, as they were`)
    // Every building on a home's lot, a shop's or a room's is hidden, and no other.
    const chosen = new Set([...w.lots, ...w.shops, ...w.homes].map(key))
    for (let i = 0; i < w.pack.buildings.height.length; i++) {
      const on = buildingLot(w.pack, w.layout.offset, i)
      assert.equal(h.pack.buildings.height[i], on && chosen.has(`${on.K},${on.M}`) ? 0 : w.pack.buildings.height[i], `${at}: building ${i}`)
    }
    // Each home is the one homesAt builds on its lot, with the podium's height and finish for its slab.
    const on = windowLotBuildings(w.pack, w.layout.offset, w.g)
    const want = homesAt(w.homes, (k, m) => {
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
