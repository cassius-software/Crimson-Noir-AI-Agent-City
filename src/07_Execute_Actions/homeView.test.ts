// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds what the homes draw and make solid (homeView.ts) to the furnishing plan: every
 * home shows its default floor and walls until its owner picks others, owned or not; an owned home shows the pieces of
 * its saved layout whose line is owned and that fit, and a home on sale its show home; a network room shows the
 * finishes only; the draft's ghost shows only where the piece fits, over a cursor marker lit or dark to match; seven
 * densely furnished homes and a draft stay inside the HomeFurniture mesh's 512 boxes, the capacity world.ts gives it;
 * each home's solids are its pieces' colliders turned into the city through the room frame, for every way a doorway can
 * face, and every one passes the realm's own check (properties.ts checkHomeBoxes); the draft camera stays in the room
 * under the slab, looks at the cursor, and is held inside the shallow micro-loft. It also builds the world under Node
 * (three's WGSL builder needs no device) and draws a home's boxes into its HomeFurniture mesh, checks that the city's
 * ground under the homes is cut in SURFACE_PIECE cells (as two triangles it won the depth test against the floor
 * finish over it on the software adapter), checks the two furnishing styles are named for the material and that no
 * region plan box uses them, and screens the taglines. The homes' workstations (homeSeats, what engine.ts lists for the
 * team runner) are listed in reading order only in owned homes and never in a network room, with rows that are a
 * TeamRoom, a doorstep that can be walked to, a standing point inside the lot facing the screen, and kinds no desk of
 * the dispatcher knows; and staffFigures draws only the agents who stand there now, in their dress.
 * What breaks if it is removed? A home could draw the street floor, a piece of a line not owned, a show home over the
 * owner's own layout, furniture in a network room that does not know it, more boxes than the mesh holds, or solids
 * the realm refuses, and only a browser would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { WebGPURenderer, type BufferGeometry, type InstancedMesh, type Mesh } from 'three/webgpu'
import { forbiddenWordIn } from '../01_Initialize_World/assets/cc0.ts'
import { CITY, CITY_CENTER, LAKE, STYLE, inLot, type Building } from '../01_Initialize_World/city.ts'
import { ROOM, doorFront, toLocal, toWorld, type Side } from '../01_Initialize_World/interiors.ts'
import { ZONE, generateLakefront } from '../01_Initialize_World/lakefront.ts'
import { packOf } from '../01_Initialize_World/lakefrontPack.ts'
import { PROPERTY_KINDS, checkHomeBoxes, cityHomes, homeAt, homeFrames, homesAt, type Home } from '../01_Initialize_World/properties.ts'
import { regionHomeLots } from '../01_Initialize_World/region/homes.ts'
import { regionShopLots } from '../01_Initialize_World/region/shops.ts'
import { streetGridOf } from '../01_Initialize_World/region/streets.ts'
import { regionWorkplaceLots } from '../01_Initialize_World/region/workplaces.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { CELL, DEPTH, GRID, GRID_HALF, HOME_PIECES, INSET, backEdge, cellCentre } from '../02_Define_The_Rules/homeGrid.ts'
import {
  DEFAULT_FINISH, FINISHES, FLOORS, GLASS, HOME_STAGING, OVERLAY, SHAPES, SHAPE_IDS, WALLS, canPlace, floorOverlay, footprint, renderBoxes,
  solidBox, wallPanels, type Piece, type RoomBox,
} from '../02_Define_The_Rules/homeLayout.ts'
import { freshHomes, layoutOf, withHome, type HomeRecord } from '../05_Observe_Environment/homeStore.ts'
import { onRoad } from '../03_Spawn_Agents/skills.ts'
import { deskAt } from '../06_Make_Decisions/dispatch.ts'
import type { TeamRoom } from '../08_Swarm/team.ts'
import { itemById } from './storeCatalog.ts'
import { REAL_PLACES } from '../../tools/world/real-places.mjs'
import {
  CITY_LINES, CURSOR, EYE, FINISH_STYLE, HOME_BOXES, furnishEye, homeInstances, homePlaced, homeSeats, homeSolids, staffFigures, worldBoxOf, type Draft,
  type HomeSeat, type StaffPost,
} from './homeView.ts'

// Vite's `?raw` import, for Node (shadowShaders.test.ts's hook): world.ts and regionWorld.ts reach WGSL that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { HOME_INSTANCES, buildWorld } = await import('../01_Initialize_World/world.ts')
const { RegionPlaces, SURFACE, SURFACE_PIECE, buildingStyle, hollowLots, layoutOf: regionLayoutOf } = await import('../01_Initialize_World/region/regionWorld.ts')

const SEED = 1337
const EPS = 1e-9
const ALL_DEEDS = (1 << PROPERTY_KINDS.length) - 1
const ALL_LINES = (1 << SHAPE_IDS.length) - 1
const SIDES: readonly Side[] = [0, 1, 2, 3]
const bit = (id: number) => 1 << (id - 160)

/** Home `home` on a plain downtown lot with its doorway on `side` (homesAt's default podium). */
const homeOn = (home: number, side: Side): Home => homesAt([{ home, k: 6, m: 6, side }])[0]

/** The room-frame box of a city box in home `h` (the test's own turn back, toLocal). */
const roomOf = (h: Home, b: readonly number[]): RoomBox => {
  const p = toLocal(h, b[0], b[2]), q = toLocal(h, b[3], b[5])
  return [Math.min(p.u, q.u), Math.min(p.v, q.v), Math.max(p.u, q.u), Math.max(p.v, q.v), b[1], b[4]]
}
const near = (a: readonly number[], b: readonly number[], what: string, eps = 1e-6) => {
  assert.equal(a.length, b.length, what)
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= eps, `${what}: [${a.join(', ')}] is not [${b.join(', ')}]`)
}

/**
 * A dense layout for home `home`, every line owned: the lines with the most boxes first, each placed wherever canPlace
 * says 'ok' (rows from the back, columns from the −v wall, every turn), up to HOME_PIECES pieces.
 */
function dense(home: number): Piece[] {
  const order = [...SHAPE_IDS].sort((a, b) => SHAPES[b].boxes.length - SHAPES[a].boxes.length || a - b)
  const placed: Piece[] = []
  for (const id of order) {
    for (let n = 0; n < SHAPES[id].cap && placed.length < HOME_PIECES; n++) {
      let put = false
      for (let r = GRID - DEPTH[home]; r < GRID && !put; r++) {
        for (let c = 0; c < GRID && !put; c++) {
          for (let rot = 0; rot < 4 && !put; rot++) {
            const p = { id, c, r, rot }
            if (canPlace(home, placed, p) === 'ok') { placed.push(p); put = true }
          }
        }
      }
      if (!put) break
    }
  }
  return placed
}
const DENSE: readonly Piece[][] = DEPTH.map((_d, i) => dense(i))

/** A record holding `layouts` (null for a home left as it was), the dense layouts by default. */
const recordOf = (layouts: readonly (readonly Piece[] | null)[], floor = 0, wall = 0): HomeRecord =>
  layouts.reduce<HomeRecord>((r, l, i) => (l ? withHome(r, i, layoutOf(floor, wall, l)) : r), freshHomes())

const CITY_HOMES = cityHomes(SEED)

test('the two furnishing styles are the material\'s 11 and 12, and every finish name maps to the style of that name', () => {
  assert.equal(STYLE.planted, 11)
  assert.equal(STYLE.lit, 12)
  assert.equal(new Set(Object.values(STYLE)).size, Object.keys(STYLE).length, 'no two styles share a number')
  assert.deepEqual(Object.keys(FINISH_STYLE).sort(), [...FINISHES].sort(), 'every finish, and nothing else')
  for (const f of FINISHES) assert.equal(FINISH_STYLE[f], STYLE[f], f)
  assert.ok(Object.isFrozen(FINISH_STYLE))
})

test('the boxes list fits the world\'s HomeFurniture mesh, whose transforms fit one uniform buffer', () => {
  assert.equal(HOME_BOXES, HOME_INSTANCES)
  assert.ok(HOME_INSTANCES <= 1024, 'past 1,024 three r186 reads the transforms as instanced attributes: another shader')
  assert.ok(HOME_INSTANCES * 64 <= 65536, 'WebGPU\'s default uniform binding size')
  // The most any home can draw: a floor, five panels and sixteen pieces of at most four boxes; then the draft.
  const most = Math.max(...SHAPE_IDS.map((id) => SHAPES[id].boxes.length))
  assert.ok(most <= 4)
  const panels = Math.max(...WALLS.map((_w, i) => wallPanels(0, i).length))
  assert.equal(panels, 5)
  assert.ok(PROPERTY_KINDS.length * (1 + panels + HOME_PIECES * most) + most + 1 <= HOME_BOXES, '7 × 70 + 5 = 495')
})

test('every home shows its default floor and walls until its owner picks others, owned or not, and in a network room', () => {
  const fresh = freshHomes()
  for (const [deeds, room] of [[0, false], [ALL_DEEDS, false], [0, true], [ALL_DEEDS, true]] as const) {
    const list = homeInstances(CITY_HOMES, fresh, deeds, ALL_LINES, { room, base: 0, draft: null })
    let at = 0
    for (const h of CITY_HOMES) {
      const d = DEFAULT_FINISH[h.home]
      const floor = list[at++]
      assert.deepEqual(floor.box, worldBoxOf(h, floorOverlay(h.home, 0)), `home ${h.home}: the overlay first`)
      assert.equal(floor.style, FINISH_STYLE[FLOORS[d.floor].style!], `home ${h.home}: its default floor`)
      const panels = wallPanels(h.home, d.wall)
      for (const p of panels) {
        const b = list[at++]
        assert.deepEqual(b.box, worldBoxOf(h, p))
        assert.equal(b.style, FINISH_STYLE[WALLS[d.wall].style!], `home ${h.home}: its default walls`)
      }
      if (!room) at += homePlaced(h.home, fresh, deeds, ALL_LINES).flatMap(renderBoxes).length
    }
    assert.equal(at, list.length, 'nothing else')
  }
  // The defaults: the brownstone oak and brick, the timber loft oak all round, the rest polished concrete and glass.
  const shown = (r: HomeRecord, home: number) => homeInstances([CITY_HOMES[home]], r, 0, 0, { room: true, base: 0, draft: null })
  assert.deepEqual(shown(fresh, 1).map((b) => b.style), [STYLE.deck, ...Array(5).fill(STYLE.masonry)])
  assert.deepEqual(shown(fresh, 2).map((b) => b.style), [STYLE.deck, ...Array(5).fill(STYLE.deck)])
  for (const i of [0, 3, 4, 5, 6]) assert.deepEqual(shown(fresh, i).map((b) => b.style), [STYLE.concrete], `home ${i}: concrete, and glass has no panels`)
  // An owner's own finishes replace them: limestone underfoot and blackened steel on the walls.
  const mine = withHome(fresh, 1, layoutOf(2, 5, []))
  assert.deepEqual(shown(mine, 1).map((b) => b.style), [STYLE.trim, ...Array(5).fill(STYLE.rail)])
  assert.deepEqual(shown(withHome(fresh, 1, layoutOf(0, 0, [])), 1).map((b) => b.style), [STYLE.concrete], 'glass walls: no panels')
})

test('the overlay lies a few millimetres over the floor: the street\'s ground in the city, the paved floor in a region', () => {
  for (const base of [0, SURFACE.sidewalk]) {
    const [overlay] = homeInstances([CITY_HOMES[0]], freshHomes(), 0, 0, { room: true, base, draft: null })
    assert.ok(Math.abs(overlay.box[1] - (base + OVERLAY.y0)) < EPS && Math.abs(overlay.box[4] - (base + OVERLAY.y1)) < EPS)
    // Wall to wall and from the back face (the fill block's, here) to the doorway wall's inner face.
    near(roomOf(CITY_HOMES[0], overlay.box), [backEdge(0) - INSET, -GLASS, GLASS, GLASS, base + OVERLAY.y0, base + OVERLAY.y1], 'the overlay')
  }
  assert.equal(SURFACE.sidewalk, 0.035, 'a region paves its rooms\' floors at the sidewalks\' height (regionWorld.ts hollowLots)')
})

test('pieces only for owned deeds and owned lines; a home on sale shows its show home; an owned home starts empty', () => {
  const sofa = { id: 163, c: 1, r: 23, rot: 3 }, bookcase = { id: 164, c: 4, r: 20, rot: 0 }
  assert.equal(canPlace(0, [], sofa), 'ok')
  assert.equal(canPlace(0, [sofa], bookcase), 'ok')
  const record = recordOf([[sofa, bookcase], [sofa, bookcase]])
  // Owned, both lines: both; one line: only that one (the other is kept in the record, not drawn or solid).
  assert.deepEqual(homePlaced(0, record, 0b1, bit(163) | bit(164)), [sofa, bookcase])
  assert.deepEqual(homePlaced(0, record, 0b1, bit(164)), [bookcase])
  assert.deepEqual(homePlaced(0, record, 0b1, 0), [])
  assert.deepEqual(homePlaced(2, record, 0b100, ALL_LINES), [], 'an owned home with nothing saved starts empty: the show home leaves')
  // On sale: the show home, whatever the record holds and whatever lines are owned.
  for (const lines of [0, ALL_LINES]) {
    assert.deepEqual(homePlaced(1, record, 0b1, lines), HOME_STAGING[1])
    for (let i = 0; i < PROPERTY_KINDS.length; i++) assert.deepEqual(homePlaced(i, freshHomes(), 0, lines), HOME_STAGING[i], `home ${i}`)
  }
  // A saved piece that does not fit is not drawn (the micro-loft has no row 3).
  assert.deepEqual(homePlaced(0, recordOf([[{ id: 164, c: 4, r: 3, rot: 0 }, bookcase]]), 0b1, ALL_LINES), [bookcase])
  // Drawn: home 0 owned with only the bookcase's line, home 1 on sale (in the finishes its record keeps, limestone and
  // brick here), home 2 on sale with no record (its defaults: oak all round).
  const kept = withHome(record, 1, layoutOf(2, 1, [sofa, bookcase]))
  const list = homeInstances(CITY_HOMES.slice(0, 3), kept, 0b1, bit(164), { room: false, base: 0, draft: null })
  const h0 = CITY_HOMES[0], h1 = CITY_HOMES[1], h2 = CITY_HOMES[2]
  const drawn = (h: Home, placed: readonly Piece[]) => placed.flatMap(renderBoxes).map((p) => ({ box: worldBoxOf(h, p.box), style: FINISH_STYLE[p.finish] }))
  const want: Building[] = [
    { box: worldBoxOf(h0, floorOverlay(0, 0)), style: STYLE.concrete },
    ...drawn(h0, [bookcase]),
    { box: worldBoxOf(h1, floorOverlay(1, 0)), style: STYLE.trim },
    ...wallPanels(1, 1).map((b) => ({ box: worldBoxOf(h1, b), style: STYLE.masonry })),
    ...drawn(h1, HOME_STAGING[1]),
    { box: worldBoxOf(h2, floorOverlay(2, 0)), style: STYLE.deck },
    ...wallPanels(2, 2).map((b) => ({ box: worldBoxOf(h2, b), style: STYLE.deck })),
    ...drawn(h2, HOME_STAGING[2]),
  ]
  assert.deepEqual(list, want)
})

test('in a network room only the finishes are drawn: no piece, no show home, no draft', () => {
  const record = recordOf(DENSE, 1, 3)
  const draft: Draft = { home: CITY_HOMES[0].home, cursor: { c: 14, r: 24 }, piece: { id: 164, c: 14, r: 24, rot: 0 }, ok: true, view: 0 }
  for (const deeds of [0, ALL_DEEDS, 0b101]) {
    const list = homeInstances(CITY_HOMES, record, deeds, ALL_LINES, { room: true, base: 0, draft })
    assert.equal(list.length, CITY_HOMES.length * 6, 'each home a floor and five panels')
    assert.ok(list.every((b) => b.style === STYLE.deck || b.style === STYLE.trim), 'oak floors, limestone walls')
  }
})

test('seven densely furnished homes and a draft stay within the mesh\'s 512 boxes; more homes than that are cut at 512', () => {
  for (const [i, l] of DENSE.entries()) {
    assert.equal(l.length, HOME_PIECES, `home ${i}: the dense layout holds the most a home holds`)
    assert.deepEqual(homePlaced(i, recordOf(DENSE), ALL_DEEDS, ALL_LINES), l, `home ${i}: all of it fits as saved`)
  }
  // The estate's first desk (four boxes) lifted and held where it stood: the ghost of a four-box piece that fits.
  const desk = DENSE[5].find((p) => p.id === 160)!
  const lifted = DENSE.map((l, i) => (i === 5 ? l.filter((p) => p !== desk) : l))
  assert.equal(canPlace(5, lifted[5], desk), 'ok')
  const record = recordOf(lifted, 1, 5)
  const draft: Draft = { home: 5, cursor: { c: desk.c, r: desk.r }, piece: desk, ok: true, view: 1 }
  const list = homeInstances(CITY_HOMES, record, ALL_DEEDS, ALL_LINES, { room: false, base: 0, draft })
  // (Lifting a piece can open a pocket a later piece of the saved order then closes: fitLayout keeps that one aside.)
  const pieces = lifted.reduce((n, _l, i) => n + homePlaced(i, record, ALL_DEEDS, ALL_LINES).flatMap(renderBoxes).length, 0)
  assert.equal(list.length, CITY_HOMES.length * 6 + pieces + SHAPES[160].boxes.length + 1)
  assert.ok(list.length <= HOME_BOXES, `${list.length} boxes`)
  // A list of homes past what any map holds is still cut to the mesh's capacity.
  const many = homeInstances([...CITY_HOMES, ...CITY_HOMES, ...CITY_HOMES], record, ALL_DEEDS, ALL_LINES, { room: false, base: 0, draft })
  assert.equal(many.length, HOME_BOXES)
})

test('the draft: the ghost of the piece in hand at the cursor only where it fits, over a marker lit when it fits and dark when not', () => {
  const h = CITY_HOMES[3]
  const fresh = freshHomes()
  const owned = 1 << h.home
  const base = homeInstances([h], fresh, owned, ALL_LINES, { room: false, base: 0, draft: null })
  assert.equal(base.length, 1, 'an owned home with nothing saved: its floor only')
  const sofa: Piece = { id: 163, c: 0, r: 0, rot: 1 }
  const at = { c: 6, r: 14 }
  const where = { ...sofa, ...at }
  assert.equal(canPlace(h.home, [], where), 'ok')
  const marker = (list: readonly Building[]) => list.at(-1)!
  const top = OVERLAY.y1
  // Fits: the ghost in its own finishes, then the lit marker over the footprint.
  const ok = homeInstances([h], fresh, owned, ALL_LINES, { room: false, base: 0, draft: { home: h.home, cursor: at, piece: sofa, ok: true, view: 0 } })
  const ghost = renderBoxes(where).map((p) => ({ box: worldBoxOf(h, p.box), style: FINISH_STYLE[p.finish] }))
  assert.deepEqual(ok.slice(1, -1), ghost, 'the ghost stands with its footprint\'s lowest cell on the cursor, in its own finishes')
  assert.equal(marker(ok).style, STYLE.lit)
  const f = footprint(where)!
  near(roomOf(h, marker(ok).box), [
    -GRID_HALF + f.r * CELL + CURSOR.inset, -GRID_HALF + f.c * CELL + CURSOR.inset,
    -GRID_HALF + (f.r + f.rows) * CELL - CURSOR.inset, -GRID_HALF + (f.c + f.cols) * CELL - CURSOR.inset, top + CURSOR.gap, top + CURSOR.rise,
  ], 'a footprint-sized marker, 1.5 cm over the overlay')
  // Refused: no ghost; the marker in dark steel.
  const no = homeInstances([h], fresh, owned, ALL_LINES, { room: false, base: 0, draft: { home: h.home, cursor: at, piece: sofa, ok: false, view: 0 } })
  assert.equal(no.length, 2)
  assert.equal(marker(no).style, STYLE.rail)
  // Nothing in hand: one cell. In a region, over the region's overlay.
  const bare = homeInstances([h], fresh, owned, ALL_LINES, { room: false, base: SURFACE.sidewalk, draft: { home: h.home, cursor: at, piece: null, ok: true, view: 2 } })
  assert.equal(bare.length, 2)
  near(roomOf(h, marker(bare).box), [
    cellCentre(at.c, at.r).u - CELL / 2 + CURSOR.inset, cellCentre(at.c, at.r).v - CELL / 2 + CURSOR.inset,
    cellCentre(at.c, at.r).u + CELL / 2 - CURSOR.inset, cellCentre(at.c, at.r).v + CELL / 2 - CURSOR.inset,
    SURFACE.sidewalk + top + CURSOR.gap, SURFACE.sidewalk + top + CURSOR.rise,
  ], 'one cell')
  // A footprint running off the floor plan is cut at its edge, never through the glass or the fill.
  const off = homeInstances([h], fresh, owned, ALL_LINES, { room: false, base: 0, draft: { home: h.home, cursor: { c: 30, r: GRID - DEPTH[h.home] - 1 }, piece: { ...sofa, rot: 0 }, ok: false, view: 0 } })
  const cut = roomOf(h, marker(off).box)
  assert.ok(cut[0] >= backEdge(h.home) && cut[2] <= GRID_HALF && cut[1] >= -GRID_HALF && cut[3] <= GRID_HALF, JSON.stringify(cut))
  // A draft for a home not in this map draws nothing.
  assert.equal(homeInstances([h], fresh, owned, ALL_LINES, { room: false, base: 0, draft: { home: (h.home + 1) % 7, cursor: at, piece: sofa, ok: true, view: 0 } }).length, 1)
})

test('the solids are each piece\'s collider turned into the city, for every way a doorway faces, and the realm takes every one', () => {
  for (const side of SIDES) {
    for (let i = 0; i < PROPERTY_KINDS.length; i++) {
      const h = homeOn(i, side)
      const [frame] = homeFrames([{ home: i, k: h.k, m: h.m, side }]).filter((f) => f !== null)
      for (const [what, placed] of [['show home', HOME_STAGING[i]], ['dense', DENSE[i]]] as const) {
        const flat = homeSolids(h, placed)
        assert.equal(flat.length, placed.length * 6, `home ${i} side ${side} ${what}: one box a piece`)
        placed.forEach((p, n) => {
          const b = solidBox(p)!
          const a = toWorld(h, b[0], b[1]), c = toWorld(h, b[2], b[3])
          assert.deepEqual(flat.slice(n * 6, n * 6 + 6), [Math.min(a.x, c.x), b[4], Math.min(a.z, c.z), Math.max(a.x, c.x), b[5], Math.max(a.z, c.z)], `home ${i} side ${side} ${what} piece ${n}`)
        })
        assert.equal(checkHomeBoxes(frame, flat).length, placed.length, `home ${i} side ${side} ${what}: the realm takes them`)
      }
    }
  }
  // The city's own homes, as the engine sends them, against the frames the realm builds from cityHomes.
  const frames = homeFrames(CITY_HOMES)
  for (const h of CITY_HOMES) {
    for (const deeds of [0, ALL_DEEDS]) {
      const flat = homeSolids(h, homePlaced(h.home, recordOf(DENSE), deeds, ALL_LINES))
      assert.ok(flat.length > 0)
      checkHomeBoxes(frames[h.home]!, flat)
    }
  }
  // Never more than the realm takes, and nothing for a piece that is not one.
  assert.equal(homeSolids(CITY_HOMES[5], [...DENSE[5], ...DENSE[5]]).length, HOME_PIECES * 6)
  assert.deepEqual(homeSolids(CITY_HOMES[5], [{ id: 999, c: 3, r: 3, rot: 0 }]), [])
})

test('the draft camera stays in the room under the slab, looks at the cursor from its side, and is held inside the shallow micro-loft', () => {
  for (const side of SIDES) {
    for (let i = 0; i < PROPERTY_KINDS.length; i++) {
      const h = homeOn(i, side)
      const back = backEdge(i) - INSET + EYE.margin, front = GLASS - EYE.margin
      for (let r = GRID - DEPTH[i]; r < GRID; r++) {
        for (let c = 0; c < GRID; c++) {
          const centre = cellCentre(c, r)
          for (const view of [0, 1, 2, 3] as const) {
            const { eye, at } = furnishEye(h, { c, r }, view)
            const e = toLocal(h, eye.x, eye.z), a = toLocal(h, at.x, at.z)
            const what = `home ${i} side ${side} cell ${c},${r} view ${view}`
            assert.ok(e.u >= back - EPS && e.u <= front + EPS && Math.abs(e.v) <= front + EPS, `${what}: inside the room (${e.u}, ${e.v})`)
            assert.ok(eye.y === EYE.height && eye.y < ROOM.height, `${what}: under the slab`)
            assert.ok(Math.abs(a.u - centre.u) < 1e-6 && Math.abs(a.v - centre.v) < 1e-6 && at.y === EYE.look, `${what}: looks at the cursor`)
            // From the view's side: the doorway, +v, the back, −v; the full distance unless a face is nearer.
            const du = e.u - centre.u, dv = e.v - centre.v
            const [wu, wv] = [[1, 0], [0, 1], [-1, 0], [0, -1]][view]
            assert.ok(Math.abs(du * wv) < 1e-6 && Math.abs(dv * wu) < 1e-6 && du * wu + dv * wv > 0, `${what}: from its side`)
            const want = wu > 0 ? Math.min(EYE.distance, front - centre.u) : wu < 0 ? Math.min(EYE.distance, centre.u - back) : wv > 0 ? Math.min(EYE.distance, front - centre.v) : Math.min(EYE.distance, centre.v + front)
            assert.ok(Math.abs(Math.hypot(du, dv) - want) < 1e-6, `${what}: ${Math.hypot(du, dv)} m off, not ${want}`)
          }
        }
      }
    }
  }
  // Looking toward the back from the micro-loft's middle row the eye stops at the fill block's face, as the estate's would not.
  const cell = { c: 16, r: 22 }
  const loft = furnishEye(CITY_HOMES[0], cell, 2), estate = furnishEye(CITY_HOMES[5], cell, 2)
  const lu = toLocal(CITY_HOMES[0], loft.eye.x, loft.eye.z).u, eu = toLocal(CITY_HOMES[5], estate.eye.x, estate.eye.z).u
  assert.ok(Math.abs(lu - (backEdge(0) - INSET + EYE.margin)) < 1e-6, `the micro-loft's eye at the fill face (${lu})`)
  assert.ok(Math.abs(eu - (cellCentre(cell.c, cell.r).u - EYE.distance)) < 1e-6, 'the estate\'s the full distance back')
  assert.ok(lu > backEdge(0), 'in front of the micro-loft\'s back row')
})

// (The banned word is the compliance scan's: compliance.test.ts reads every source file, these lines included.)
test('the seven taglines: one sentence a home, each passing the screen, unarmed, fictional and free of the asset gate\'s words', () => {
  const ARMED = /\b(?:guns?|gunfire|firearms?|rifles?|pistols?|handguns?|shotguns?|revolvers?|weapons?|weaponry|holsters?|ammo|ammunition|bullets?|knife|knives|blades?|swords?|katanas?|machetes?|daggers?|grenades?|bombs?|explosives?|muzzles?|snipers?|shoot(?:s|ing|ers?)?|shots?|melee|combat|armed|arsenal|turrets?|missiles?|rockets?|punch(?:es|ing|ed)?|fights?|fighting|attacks?|attacking)\b/i
  assert.equal(CITY_LINES.length, PROPERTY_KINDS.length)
  assert.equal(new Set(CITY_LINES).size, CITY_LINES.length)
  assert.ok(Object.isFrozen(CITY_LINES))
  for (const [i, line] of CITY_LINES.entries()) {
    assert.match(line, /^[A-Z].{20,110}\.$/, `home ${i}: one sentence`)
    assert.ok(screen(line).admissible, `home ${i}: ${line}`)
    assert.equal(line.match(ARMED), null, `home ${i}: ${line}`)
    assert.equal(forbiddenWordIn(line), null, `home ${i}: ${line}`)
    for (const place of REAL_PLACES) assert.ok(!new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(line), `home ${i} names ${place}`)
  }
})

test('no box of a region\'s plan uses the furnishing styles: they are the homes\' furniture\'s alone', () => {
  for (const seed of [SEED, 7]) {
    const map = generateLakefront(seed, 64)
    for (const [zone, z] of Object.entries(ZONE).filter(([name]) => name !== 'lake')) {
      const pack = packOf(map, z)
      const layout = regionLayoutOf(pack)
      const start = new RegionPlaces(pack, layout).spawn({ x: layout.offset.x, z: layout.offset.z })
      const g = streetGridOf(pack, layout.offset, start)!
      const lots = regionWorkplaceLots(pack, layout, g, start, seed)
      const shops = regionShopLots(pack, layout, g, start, seed, lots)
      const homes = regionHomeLots(pack, layout, g, start, seed, [...lots, ...shops])
      const hollow = hollowLots(pack, layout, lots, shops, homes)
      for (const { style } of hollow.plan) assert.ok(style !== STYLE.planted && style !== STYLE.lit, `seed ${seed} ${zone}: a plan box in style ${style}`)
      for (let i = 0; i < hollow.pack.buildings.height.length; i++) {
        const s = buildingStyle(hollow.pack, layout, i)
        assert.ok(s !== STYLE.planted && s !== STYLE.lit, `seed ${seed} ${zone}: building ${i} in style ${s}`)
      }
    }
  }
})

/** A WebGPURenderer never initialised (shadowShaders.test.ts's): enough to build the world's scene, no device asked for. */
function offlineRenderer(): WebGPURenderer {
  const canvas = { style: {}, width: 1, height: 1, addEventListener() {}, removeEventListener() {}, getContext: () => null }
  const renderer = new WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement, reversedDepthBuffer: true })
  Object.assign(renderer, { initTexture: () => {}, hasFeature: () => false })
  return renderer
}

test('the world: one HomeFurniture mesh in the buildings\' material, empty and visible from the start, and setHomes draws each box in its style', () => {
  const world = buildWorld(offlineRenderer(), SEED)
  const meshes = world.scene.children as Mesh[]
  const buildings = meshes.find((m) => m.name === 'Buildings') as InstancedMesh
  const homes = meshes.find((m) => m.name === 'HomeFurniture') as InstancedMesh
  assert.ok(buildings && homes, 'both in the scene, so compileAsync builds both')
  assert.ok(meshes.indexOf(homes) > meshes.indexOf(buildings))
  assert.equal(homes.isInstancedMesh, true)
  assert.equal(homes.material, buildings.material, 'the buildings\' material: no shader of its own')
  assert.equal(homes.count, 0, 'nothing drawn until the engine hands it boxes')
  assert.equal(homes.visible, true)
  assert.equal(homes.frustumCulled, false)
  assert.equal(homes.castShadow, false)
  assert.equal(homes.receiveShadow, true)
  const placement = homes.instanceMatrix
  assert.equal(placement.count, HOME_INSTANCES, 'its capacity, which picks three\'s instancing path')
  const styles = homes.geometry.getAttribute('style')
  assert.ok(styles !== buildings.geometry.getAttribute('style'), 'a style attribute of its own')
  assert.equal(styles.count, HOME_INSTANCES)
  assert.notEqual(homes.geometry, buildings.geometry)

  const list = homeInstances(CITY_HOMES, recordOf(DENSE, 1, 2), ALL_DEEDS, ALL_LINES, { room: false, base: 0, draft: null })
  world.setHomes(list)
  assert.equal(homes.count, list.length)
  // Each slot maps the unit box (x and z ±0.5, y 0 to 1) onto its box, column by column.
  const t = placement.array as Float32Array
  const apply = (o: number, x: number, y: number, z: number) => [
    t[o] * x + t[o + 4] * y + t[o + 8] * z + t[o + 12], t[o + 1] * x + t[o + 5] * y + t[o + 9] * z + t[o + 13], t[o + 2] * x + t[o + 6] * y + t[o + 10] * z + t[o + 14],
  ]
  list.forEach(({ box, style }, i) => {
    const lo = apply(i * 16, -0.5, 0, -0.5), hi = apply(i * 16, 0.5, 1, 0.5)
    near([lo[0], lo[1], lo[2], hi[0], hi[1], hi[2]], box, `slot ${i}`, 1e-3)
    assert.equal(styles.getX(i), style, `slot ${i}'s style`)
  })
  world.setHomes(list.slice(0, 3))
  assert.equal(homes.count, 3)
  world.setHomes([])
  assert.equal(homes.count, 0)
  assert.throws(() => world.setHomes(Array.from({ length: HOME_INSTANCES + 1 }, () => list[0])), /at most 512/)
})

test('the city\'s ground under the homes is cut into SURFACE_PIECE cells, as a region\'s is, so a floor finish millimetres over it keeps its depth', () => {
  // Two triangles 3.2 km by 2 km: the depth the software adapter interpolated across them came out centimetres high in
  // many views, and the street showed through a home's whole floor overlay (3 to 15 mm up) and the draft's cursor (30
  // mm). In 128 m cells, as regionWorld.ts draws a region's ground, none did (headless Chrome on SOFTWARE_WEBGPU).
  assert.ok(OVERLAY.y0 > 0 && OVERLAY.y1 <= 0.015 && OVERLAY.y1 + CURSOR.rise <= 0.03 + EPS, 'the overlay and the cursor lie this close over the street')
  const world = buildWorld(offlineRenderer(), SEED)
  const ground = (world.scene.children as Mesh[]).find((m) => m.name === 'Streets')
  assert.ok(ground, 'the city ground is drawn')
  const g = ground.geometry as BufferGeometry
  const pos = g.getAttribute('position'), index = g.getIndex()
  assert.ok(index && index.count >= 6)
  let longest = 0
  for (let i = 0; i < index.count; i += 3) {
    for (const [a, b] of [[0, 1], [1, 2], [2, 0]]) {
      const p = index.getX(i + a), q = index.getX(i + b)
      longest = Math.max(longest, Math.hypot(pos.getX(p) - pos.getX(q), pos.getY(p) - pos.getY(q), pos.getZ(p) - pos.getZ(q)))
    }
  }
  assert.ok(longest <= SURFACE_PIECE * Math.SQRT2 + 1e-3, `an edge of ${longest.toFixed(1)} m (limit ${(SURFACE_PIECE * Math.SQRT2).toFixed(1)})`)
  // Still the whole of it: 3.2 km east to west round the city's centre, from 1.6 km south to the seawall's back, flat at 0.
  g.computeBoundingBox()
  const bb = g.boundingBox!
  near([bb.min.x, bb.min.y, bb.min.z, bb.max.x, bb.max.y, bb.max.z], [CITY_CENTER - 1600, 0, CITY_CENTER - 1600, CITY_CENTER + 1600, 0, LAKE.shore + LAKE.wall.thickness], 'the ground\'s extent', 1e-3)
  // Every home stands on it.
  for (const h of CITY_HOMES) {
    const [x0, , z0, x1, , z1] = homeInstances([h], freshHomes(), 0, 0, { room: true, base: 0, draft: null })[0].box
    assert.ok(x0 > bb.min.x && x1 < bb.max.x && z0 > bb.min.z && z1 < bb.max.z, `home ${h.home} on the ground`)
  }
})

/** The city's homes as the engine knows them: each with its deed's name and its arrival on the sidewalk lane. */
const PAGE_HOMES = CITY_HOMES.map((h) => ({ ...h, name: itemById(224 + h.home)?.name ?? h.kind, arrival: doorFront(h, CITY.lane) }))
const P = (id: number, c: number, r: number, rot = 0): Piece => ({ id, c, r, rot })
const post = (name: string, home: number, c: number, r: number, present = true): StaffPost => ({ name, home, c, r, present, body: 2, ink: 0x7c3aed, scale: 1.05 })

test('homeSeats lists the workstations of owned homes in reading order, each row a TeamRoom with a doorstep, a standing point and who is posted', () => {
  const record = withHome(freshHomes(), 1, layoutOf(1, 1, [P(164, 2, 16), P(168, 10, 20), P(168, 4, 20)], []))
  const seats = homeSeats(PAGE_HOMES, record, 1 << 1, bit(164) | bit(168), [post('Mara', 1, 10, 20)], { room: false, base: 0 })
  assert.deepEqual(seats.map((s) => [s.seat, s.c, s.r, s.occupant, s.present]), [[1, 4, 20, null, false], [2, 10, 20, 'Mara', true]])
  const [a, b] = seats
  assert.equal(b.kind, 'homeSeat:1:10:20')
  assert.equal(b.name, `${PAGE_HOMES[1].name}, workstation 2`)
  assert.deepEqual(b.door, PAGE_HOMES[1].arrival, 'the home\'s arrival on the sidewalk')
  assert.equal(b.home, 1)
  // Where the agent stands: inside the lot of this home, on the floor overlay, facing the screen (probed: x 175.721, z 136.11).
  assert.ok(Math.abs(b.at.x - 175.721) < 1e-6 && Math.abs(b.at.z - 136.11) < 1e-6, JSON.stringify(b.at))
  assert.equal(b.at.y, OVERLAY.y1)
  assert.ok(inLot(b.at.x, b.at.z) && homeAt(PAGE_HOMES, b.at.x, b.at.z) === 1)
  const back = toWorld(PAGE_HOMES[1], -GRID_HALF + 20.5 * CELL, -GRID_HALF + 11 * CELL)
  assert.ok(Math.abs(Math.atan2(back.x - b.at.x, back.z - b.at.z) - b.at.yaw) < 1e-9, 'facing the desk row')
  assert.equal(a.at.x, b.at.x, 'the two stand in one row')
  // Read-only all the way down, and structurally the team runner's room.
  for (const x of [seats, a, b, b.door, b.at]) assert.ok(Object.isFrozen(x))
  const rooms: readonly TeamRoom[] = seats
  assert.equal(rooms.length, 2)
  // A region's floor lifts the standing point with the homes.
  assert.equal(homeSeats(PAGE_HOMES, record, 1 << 1, bit(164) | bit(168), [], { room: false, base: 0.12 })[0].at.y, 0.12 + OVERLAY.y1)
})

test('homeSeats is empty in a network room, skips homes not owned and lines not owned, and never lists a show home', () => {
  const record = withHome(freshHomes(), 1, layoutOf(1, 1, [P(168, 10, 20)], []))
  assert.deepEqual(homeSeats(PAGE_HOMES, record, 1 << 1, bit(168), [post('Mara', 1, 10, 20)], { room: true, base: 0 }), [], 'none in a network room')
  assert.deepEqual(homeSeats(PAGE_HOMES, record, 0, bit(168), [], { room: false, base: 0 }), [], 'not owned')
  assert.deepEqual(homeSeats(PAGE_HOMES, record, 1 << 1, 0, [], { room: false, base: 0 }), [], 'the line not owned: it does not stand')
  // The sky-mansion's show home has two workstations; unowned, it lists none.
  assert.equal(HOME_STAGING[6].filter((p) => p.id === 168).length, 2)
  assert.deepEqual(homeSeats(PAGE_HOMES, freshHomes(), 0, ALL_LINES, [], { room: false, base: 0 }), [])
  assert.equal(homeSeats(PAGE_HOMES, freshHomes(), 1 << 6, ALL_LINES, [], { room: false, base: 0 }).length, 0, 'owned, its own (empty) layout')
})

test('every seat\'s kind is unknown to the dispatcher, every doorstep can be walked to, and every standing point is inside its lot', () => {
  const layouts = PAGE_HOMES.map((h) => [P(168, 4, GRID - DEPTH[h.home]), P(168, 10, GRID - DEPTH[h.home] + 4, 2)])
  let record: HomeRecord = freshHomes()
  for (const h of PAGE_HOMES) record = withHome(record, h.home, layoutOf(0, 0, layouts[h.home], []))
  const seats: readonly HomeSeat[] = homeSeats(PAGE_HOMES, record, ALL_DEEDS, ALL_LINES, [], { room: false, base: 0 })
  assert.equal(seats.length, 14, 'two in each of the seven homes')
  for (const s of seats) {
    assert.equal(deskAt(s.kind), null, s.kind)
    assert.ok(!inLot(s.door.x, s.door.z) && !onRoad(s.door.x, s.door.z), `${s.name}: the doorstep is on the sidewalk`)
    assert.ok(inLot(s.at.x, s.at.z) && homeAt(PAGE_HOMES, s.at.x, s.at.z) === s.home, `${s.name}: standing inside its own lot`)
  }
})

test('staffFigures draws only the agents who stand at their workstation now, in their body, colour and height', () => {
  const record = withHome(freshHomes(), 1, layoutOf(1, 1, [P(168, 10, 20), P(168, 4, 20)], []))
  const posts = [post('Mara', 1, 10, 20), post('Theo', 1, 4, 20, false), post('Ines', 1, 16, 20)]
  const seats = homeSeats(PAGE_HOMES, record, 1 << 1, bit(168), posts, { room: false, base: 0 })
  const figures = staffFigures(seats, posts)
  assert.equal(figures.length, 1, 'Theo is out with the player, and nothing stands where Ines was posted')
  assert.deepEqual(figures[0], { ...seats[1].at, body: 2, ink: 0x7c3aed, scale: 1.05 })
  assert.deepEqual(staffFigures(homeSeats(PAGE_HOMES, record, 1 << 1, bit(168), posts, { room: true, base: 0 }), posts), [], 'none in a network room')
})
