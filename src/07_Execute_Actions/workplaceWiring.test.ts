// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of a generated region's indoor workplaces, which the engine
 * and the world carry and Node cannot run: the page picks the lots once from the pack as it came (where the visitor
 * starts, the street names, the landmark and the street window are all read from that pack), hollows a copy of it,
 * draws the copy with the rooms' boxes and floors, walls the copy in the worker and sends the worker the lots
 * themselves; the world draws a region's boxes when it has any; the minimap draws the rooms over the region's map;
 * and the HUD counts who is at work wherever the world has rooms. Source-level, as the other wiring tests are.
 * What breaks if it is removed? The page could wall the pack it drew round a room, send the worker rooms other than
 * the ones it drew, or drop the rooms from the map or the count, and only a browser on the region would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const flat = (s: string) => s.replace(/\s+/g, ' ')
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}

test('the engine: the lots from the pack as it came, a hollowed copy drawn and walled, the lots themselves sent to the worker', () => {
  const src = flat(read('./engine.ts'))
  // Where the visitor starts, the names, the landmark and the window: the pack as it came (the landmark's line is pinned
  // by mentorWiring.test.ts too).
  for (const line of [
    'const places = pack && layout ? new RegionPlaces(pack, layout) : null',
    'const landmark = pack && layout ? landmarkOf(pack, layout.offset) : null',
    'const streets = pack && layout ? streetGridOf(pack, layout.offset, spawn) : null',
    'const lots = pack && layout && streets ? regionWorkplaceLots(pack, layout, streets, spawn, options.seed) : []',
    'const hollow = pack && layout ? hollowLots(pack, layout, lots) : null',
  ]) assert.ok(src.includes(line), line)
  before(src, 'const streets = pack && layout ? streetGridOf(', 'regionWorkplaceLots(pack, layout, streets, spawn, options.seed)', 'the window first, the lots in it')
  before(src, 'const hollow = pack && layout ? hollowLots(', 'const world = buildWorld(', 'hollowed before the world is built')
  // The page draws the hollowed copy, the rooms' boxes and their paved floors; the worker walls that same copy, takes
  // the world's boxes (the rooms' among them) as colliders, and builds its rooms from the lots.
  assert.ok(src.includes('const world = buildWorld(gpu.renderer, options.seed, pack && layout && hollow ? { pack: hollow.pack, layout: { ...layout, floors: hollow.floors }, streets, plan: hollow.plan } : null)'))
  assert.ok(src.includes('boxes: world.boxes,'), 'the rooms\' boxes reach the worker in the world\'s')
  assert.ok(src.includes('region: hollow && layout ? regionPhysics(hollow.pack, layout) : null, streets, tracks: options.tracks !== false,'))
  assert.ok(!src.includes('regionPhysics(pack, layout)'), 'never the pack drawn round a room')
  assert.ok(src.includes('...(lots.length > 0 && { workplaces: lots }),'), 'the worker builds the rooms the page drew')
  // The engine keeps the world's rooms: the minimap draws them over a region's map, and the HUD counts who is at work
  // wherever there are rooms (the city's, a generated region's), never in a surveyed region.
  assert.ok(src.includes('rooms: hollow ? hollow.rooms : workplaces(options.seed),'))
  assert.ok(src.includes('return p ? (ctx, x, z, radius, dark) => { p.drawMap(ctx, x, z, radius, dark); drawRooms(ctx, rooms, x, z, dark, radius) } : null'), 'the rooms over the region\'s map')
  assert.ok(src.includes('...(this.places && this.rooms.length === 0 ? {} : { working: s.working ?? 0 }),'), 'at work indoors wherever there are rooms')
  assert.ok(!src.includes('...(this.places ? {} : { working: s.working ?? 0 }),'))
})

test('the world: a region\'s boxes (its rooms\' shell, furniture and what the slabs carry) are drawn as the city\'s, and only when there are some', () => {
  const src = flat(read('../01_Initialize_World/world.ts'))
  assert.match(src, /region: \{ pack: RegionPack; layout: RegionLayout; streets\?: StreetGrid \| null; plan\?: readonly Building\[\] \} \| null = null/)
  assert.ok(src.includes('const plan = region ? [...(region.plan ?? [])] : generateBuildings(seed)'))
  assert.ok(src.includes('if (!region || plan.length > 0) scene.add(buildings)'))
  // The city's instances are re-sorted towards the camera every frame; a region's few boxes once, at the build.
  assert.ok(src.includes('if (!region) sortBuildings(focusX, focusZ)') && src.includes('sortBuildings(CITY_CENTER, CITY_CENTER)'))
})
