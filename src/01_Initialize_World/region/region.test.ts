/**
 * Why does this file exist? It proves the world compiler's pure core.
 * - The projection is the ellipsoidal transverse Mercator: forward and inverse agree to micrometres across the whole
 *   region, the central meridian is true to scale (checked against the meridian arc), east is +x and north is −z.
 * - Fictional names are stable, injective and never real: not a denied name, not containing a denied word, and a
 *   street keeps only its type and direction.
 * - Clipping keeps exactly what lies in the box (areas and runs checked), simplification drops only what it may, holes
 *   join the polygon they pierce.
 * - A compiled pack has the shape the engine reads, no real name survives in it, and the leak check finds one planted.
 * What breaks if it is removed? A region could shift, shear, lose its islands or carry a real street name, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clipLine, clipRing, clipSegment, signedArea2, simplifyLine, simplifyRing, type Pt, type Rect } from './clip.ts'
import { compileRegion, groupRings, ordinaryWords, realNamesIn, regionRect, type RoadFeature } from './compile.ts'
import { REGION_GRID } from './grid.ts'
import { NAME_HEADS, NAME_SPACE, NAME_TAILS, NameBook, hash32, normal, streetName } from './names.ts'
import { DM, ROAD_CLASS, WATER_KIND, polygonAt, polygonCount, regionWanted, roadAt, validatePack } from './pack.ts'
import { fromGrid, scaleAt, toGrid } from './projection.ts'

const G = REGION_GRID
const near = (a: number, b: number, eps: number) => Math.abs(a - b) <= eps
let seed = 11
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32)

// ---------------------------------------------------------------- projection

test('projection: forward and inverse agree to a fraction of a millimetre across a region 200 km wide', () => {
  let worst = 0
  for (let k = 0; k < 5000; k++) {
    const lon = G.lon0 - 1.2 + 2.4 * rnd(), lat = G.lat0 - 0.8 + 1.6 * rnd()
    const p = toGrid(G, lon, lat), q = fromGrid(G, p.x, p.z), r = toGrid(G, q.lon, q.lat)
    worst = Math.max(worst, Math.hypot(r.x - p.x, r.z - p.z))
  }
  assert.ok(worst < 5e-4, `worst round trip ${worst} m`)
  const o = toGrid(G, G.lon0, G.lat0)
  assert.ok(near(o.x, 0, 1e-9) && near(o.z, 0, 1e-9), 'the origin is (0, 0)')
})

test('projection: east is +x, north is −z; the central meridian is true to scale (the meridian arc)', () => {
  const e = toGrid(G, G.lon0 + 0.01, G.lat0), n = toGrid(G, G.lon0, G.lat0 + 0.01)
  assert.ok(e.x > 700 && Math.abs(e.z) < 1, `east: ${JSON.stringify(e)}`)
  assert.ok(n.z < -1000 && Math.abs(n.x) < 1e-9, `north: ${JSON.stringify(n)}`)
  // Along the central meridian the grid distance is the meridian arc: numerically integrated M(φ) = ∫ ρ dφ.
  const a = 6378137, f = 1 / 298.257222101, e2 = f * (2 - f)
  const rho = (phi: number) => (a * (1 - e2)) / (1 - e2 * Math.sin(phi) ** 2) ** 1.5
  const p0 = (G.lat0 * Math.PI) / 180, p1 = ((G.lat0 + 0.5) * Math.PI) / 180
  let arc = 0
  const steps = 20000
  for (let i = 0; i < steps; i++) arc += rho(p0 + ((i + 0.5) * (p1 - p0)) / steps) * ((p1 - p0) / steps)
  assert.ok(near(-toGrid(G, G.lon0, G.lat0 + 0.5).z, arc, 1e-4), `${-toGrid(G, G.lon0, G.lat0 + 0.5).z} vs ${arc}`)
  assert.equal(scaleAt(G, G.lon0, G.lat0), 1)
  // 75 km off the meridian the scale is about 1 + x²/2R² (7 parts in 100,000).
  const s = scaleAt(G, G.lon0 + 0.93, G.lat0)
  assert.ok(s > 1.00006 && s < 1.00008, `${s}`)
  // And the grid agrees with it: a 10 m step east there measures 10·s.
  const p = toGrid(G, G.lon0 + 0.93, G.lat0), q = toGrid(G, G.lon0 + 0.93 + 10 / (111320 * Math.cos((G.lat0 * Math.PI) / 180)), G.lat0)
  assert.ok(Math.abs((q.x - p.x) / 10 - 1) < 0.004, 'a short step east is about 10 m')
})

// ---------------------------------------------------------------- names

test('names: the space is a permutation (the stride shares no factor with its size), lists unique and original', () => {
  const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a)
  assert.equal(gcd(7919, NAME_SPACE), 1)
  assert.equal(new Set(NAME_HEADS).size, NAME_HEADS.length)
  assert.equal(new Set(NAME_TAILS).size, NAME_TAILS.length)
  assert.ok(NAME_SPACE >= 6000, `${NAME_SPACE}`)
  assert.equal(hash32('a'), hash32('a'))
  assert.notEqual(hash32('a'), hash32('b'))
})

test('names: stable, injective, never a denied name nor containing a denied word; types and directions kept', () => {
  const deny = ['Ashbrook', 'Copper Lane', 'Meadowvale', 'Birchdale Street']
  const book = new NameBook(deny)
  const real = Array.from({ length: 4000 }, (_, i) => `STREET NUMBER ${i}`)
  const got = real.map((r) => book.name(r))
  assert.equal(new Set(got).size, got.length, 'injective')
  assert.deepEqual(real.slice(0, 50).map((r) => book.name(r)), got.slice(0, 50), 'stable within a book')
  assert.deepEqual(real.slice(0, 50).map((r) => new NameBook(deny).name(r)), got.slice(0, 50), 'stable across books')
  assert.notDeepEqual(real.slice(0, 50).map((r) => new NameBook(deny, 'other').name(r)), got.slice(0, 50), 'a salt changes them')
  for (const g of got) {
    assert.ok(!['ASHBROOK', 'MEADOWVALE', 'BIRCHDALE'].includes(normal(g)), g)
    assert.ok(!/\bCOPPER\b|\bLANE\b/i.test(g), `${g} contains a denied word`)
    assert.match(g, /^[A-Z][a-z]+$/, 'a single capitalized compound')
  }
  // A real name asked for is denied from then on: it can never be another street's fictional name.
  const b2 = new NameBook([])
  const first = b2.name('Oakridge')
  assert.ok(!b2.allowed('Oakridge'))
  assert.notEqual(first.toUpperCase(), 'OAKRIDGE')
  assert.equal(streetName(b2, 'KING', 'STREET', 'WEST'), `${b2.name('KING')} Street West`)
  assert.equal(streetName(b2, '1ST', 'AVENUE'), `${b2.name('1ST')} Avenue`, 'numbered streets are renamed too')
  assert.equal(streetName(b2, '', 'STREET'), '')
  assert.equal(streetName(b2, null), '')
})

// ---------------------------------------------------------------- clipping and simplifying

const R: Rect = { x0: 0, z0: 0, x1: 10, z1: 10 }
const area = (r: readonly Pt[]) => Math.abs(signedArea2(r)) / 2

test('clip: rings keep exactly the part inside; lines keep their inside runs; segments by Liang–Barsky', () => {
  const inside: Pt[] = [[1, 1], [4, 1], [4, 4], [1, 4]]
  assert.deepEqual(clipRing(inside, R), inside)
  assert.equal(area(clipRing([[-5, 2], [5, 2], [5, 6], [-5, 6]], R)), 20, 'half of a 10 × 4 rectangle')
  assert.equal(area(clipRing([[-5, -5], [15, -5], [15, 15], [-5, 15]], R)), 100, 'the box itself')
  assert.deepEqual(clipRing([[20, 20], [30, 20], [30, 30]], R), [], 'outside: nothing')
  // A triangle with one corner outside: its inside area by the shoelace, against the exact value.
  const t = clipRing([[2, 2], [14, 2], [2, 8]], R)
  assert.ok(near(area(t), 36 - 0.5 * 4 * 2, 1e-9), `${area(t)}`)
  // A line that leaves and comes back is two runs.
  const runs = clipLine([[-2, 5], [5, 5], [5, 15], [8, 15], [8, 5], [12, 5]], R)
  assert.equal(runs.length, 2)
  assert.deepEqual(runs[0], [[0, 5], [5, 5], [5, 10]])
  assert.deepEqual(runs[1], [[8, 10], [8, 5], [10, 5]])
  assert.equal(clipSegment([-1, -1], [-2, 5], R), null)
  assert.deepEqual(clipSegment([-5, 5], [15, 5], R), [[0, 5], [10, 5]])
  assert.deepEqual(clipLine([[20, 20], [30, 30]], R), [])
})

test('simplify: collinear and repeated points go, corners stay, a ring keeps at least three points', () => {
  const ring: Pt[] = [[0, 0], [5, 0], [5, 0], [10, 0], [10, 0.01], [10, 10], [5, 10.02], [0, 10], [0, 5], [0, 0]]
  const s = simplifyRing(ring, 0.05)
  assert.equal(s.length, 4, JSON.stringify(s))
  assert.ok(near(area(s), 100, 0.5))
  assert.deepEqual(simplifyLine([[0, 0], [1, 0.001], [2, 0], [2, 5]], 0.01), [[0, 0], [2, 0], [2, 5]])
  assert.equal(simplifyRing([[0, 0], [1, 0], [0, 1]], 5).length, 3)
})

test('groupRings: holes join the polygon they pierce; separate outers stay apart; orientation for the triangulator', () => {
  const outer: Pt[] = [[0, 0], [10, 0], [10, 10], [0, 10]]
  const hole: Pt[] = [[3, 3], [3, 6], [6, 6], [6, 3]]
  const other: Pt[] = [[20, 0], [30, 0], [30, 10], [20, 10]]
  // As given, the hole winds against the outer ring; the same ring wound the other way is an outer ring of its own.
  const withHole = groupRings([outer, hole, other])
  const polys = groupRings([outer, hole.slice().reverse(), other])
  assert.equal(withHole.length, 2)
  assert.equal(withHole.find((p) => p.length === 2)?.[1].length, 4, 'the hole is inside the first square')
  // Outer rings counter-clockwise on the map (x east, north up): negative signedArea2 in the engine's z-south frame.
  for (const p of withHole) {
    assert.ok(signedArea2(p[0]) < 0, 'outer counter-clockwise on the map')
    for (const h of p.slice(1)) assert.ok(signedArea2(h) > 0, 'hole clockwise')
  }
  assert.equal(polys.length, 3, 'wound like an outer ring, it is one')
})

// ---------------------------------------------------------------- the compiler

/** A tiny region: two streets, a lake with an island, two buildings, around the grid's origin. */
function sources() {
  const d = (dx: number, dz: number): number[] => {
    const q = fromGrid(G, dx, dz)
    return [q.lon, q.lat]
  }
  const roads: RoadFeature[] = [
    { attributes: { ROAD_CLASS: 'Arterial', ROAD_ELEMENT_TYPE: 'ROAD ELEMENT', DIRECTION_OF_TRAFFIC_FLOW: 'Both', NUMBER_OF_LANES: '4', FULL_STREET_NAME: 'KING STREET WEST', STREET_NAME_BODY: 'KING', STREET_TYPE_SUFFIX: 'STREET' }, geometry: { paths: [[d(-600, 0), d(600, 0)]] } },
    { attributes: { ROAD_CLASS: 'Local / Street', ROAD_ELEMENT_TYPE: 'ROAD ELEMENT', DIRECTION_OF_TRAFFIC_FLOW: 'Positive', NUMBER_OF_LANES: null, FULL_STREET_NAME: 'AVENUE ROAD', STREET_NAME_BODY: 'AVENUE', STREET_TYPE_SUFFIX: 'ROAD' }, geometry: { paths: [[d(0, -100), d(0, 100)]] } },
    { attributes: { ROAD_CLASS: '', ROAD_ELEMENT_TYPE: 'VIRTUAL ROAD', FULL_STREET_NAME: 'NOWHERE', STREET_NAME_BODY: 'NOWHERE' }, geometry: { paths: [[d(1, 1), d(2, 2)]] } },
  ]
  const water = [{ attributes: { WATERBODY_TYPE: 'Lake', OFFICIAL_NAME_LABEL: 'Lake Example' }, geometry: { rings: [
    [d(-500, 200), d(500, 200), d(500, 700), d(-500, 700), d(-500, 200)].reverse(),
    [d(-50, 250), d(-50, 300), d(50, 300), d(50, 250), d(-50, 250)].reverse(),
  ] } }]
  const buildings = [
    { rings: [[d(10, 10), d(30, 10), d(30, 40), d(10, 40), d(10, 10)]], height: '45.5', floors: '12', type: '..' },
    { rings: [[d(-30, -30), d(-10, -30), d(-10, -10), d(-30, -10)]], height: null, floors: '4', type: 'Place of Worship' },
    { rings: [[d(5000, 5000), d(5010, 5000), d(5010, 5010)]], height: '9', floors: '2', type: '..' },
  ]
  return { roads, water, buildings }
}
const bboxAround = (): [number, number, number, number] => {
  const sw = fromGrid(G, -400, 400), ne = fromGrid(G, 400, -400)
  return [sw.lon, sw.lat, ne.lon, ne.lat]
}

test('compile: the pack the engine reads: classes, lanes, flow, clipped runs, the lake with its island, buildings', () => {
  const s = sources()
  const pack = compileRegion({ name: 'Harrowmere', grid: G, bbox: bboxAround(), ...s, deny: ['Harbourtown'], attribution: ['test data'] })
  validatePack(JSON.parse(JSON.stringify(pack)))
  const rect = regionRect(G, bboxAround())
  assert.ok(near(rect.x0, -400, 1) && near(rect.x1, 400, 1) && near(rect.z0, -400, 1) && near(rect.z1, 400, 1), JSON.stringify(rect))
  assert.equal(pack.roads.cls.length, 2, 'the virtual road is dropped')
  assert.deepEqual([pack.roads.cls[0], pack.roads.lanes[0], pack.roads.flow[0]], [ROAD_CLASS.arterial, 4, 0])
  assert.deepEqual([pack.roads.cls[1], pack.roads.lanes[1], pack.roads.flow[1]], [ROAD_CLASS.local, 2, 1], 'default lanes; one way with the points')
  const king = roadAt(pack, 0)
  assert.ok(near(king[0][0], rect.x0, 0.2) && near(king[king.length - 1][0], rect.x1, 0.2), 'clipped at the region edge')
  assert.match(pack.names[pack.roads.name[0]], /^[A-Z][a-z]+ Street West$/)
  assert.match(pack.names[pack.roads.name[1]], /^[A-Z][a-z]+ Road$/)
  // The lake: one polygon, its island a hole, cut at the region's south edge.
  assert.equal(polygonCount(pack.water), 1)
  const lake = polygonAt(pack.water, 0)
  assert.equal(lake.length, 2, 'the island is a hole')
  assert.equal(pack.water.kind[0], WATER_KIND.lake)
  assert.ok(Math.max(...lake[0].map((p) => p[1])) <= rect.z1 + 0.1)
  assert.match(pack.names[pack.water.name[0]], /^[A-Z][a-z]+ Lake$/)
  // Buildings: the two inside, heights in decimetres (a missing height from its storeys), worship kept.
  assert.equal(polygonCount(pack.buildings), 2)
  assert.deepEqual(pack.buildings.height, [455, 140])
  assert.deepEqual(pack.buildings.kind, [0, 1])
  assert.ok(pack.buildings.xz.every((v) => Number.isInteger(v)) && DM === 10)
  // Nothing real: not the streets, not the lake, not the denied place.
  const deny = ['KING', 'KING STREET WEST', 'AVENUE', 'AVENUE ROAD', 'Lake Example', 'Harbourtown']
  assert.deepEqual(realNamesIn(pack, deny, ordinaryWords(s.roads)), [])
  assert.ok(!JSON.stringify(pack).includes('KING') && !/Example/.test(JSON.stringify(pack)))
})

test('compile: the leak check finds a real name planted in a pack, and a real region name is refused', () => {
  const s = sources()
  const pack = compileRegion({ name: 'Harrowmere', grid: G, bbox: bboxAround(), ...s, deny: [], attribution: ['x'] })
  pack.names.push('King Street West')
  const found = realNamesIn(pack, ['KING STREET WEST', 'KING'], ordinaryWords(s.roads))
  assert.ok(found.some((f) => /KING STREET WEST/.test(f)) && found.some((f) => /⊃ KING$/.test(f)), found.join(' | '))
  assert.throws(() => compileRegion({ name: 'King', grid: G, bbox: bboxAround(), ...s, deny: [], attribution: ['x'] }), /real name/)
})

test('validatePack: a malformed pack is refused with the first problem named', () => {
  const s = sources()
  const good = JSON.parse(JSON.stringify(compileRegion({ name: 'Harrowmere', grid: G, bbox: bboxAround(), ...s, deny: [], attribution: ['x'] })))
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- a pack being broken on purpose
  const bad = (f: (p: any) => void, re: RegExp) => {
    const p = structuredClone(good)
    f(p)
    assert.throws(() => validatePack(p), re)
  }
  bad((p) => { p.format = 'region/0' }, /format/)
  bad((p) => { p.names[0] = 'x' }, /empty name/)
  bad((p) => { p.roads.start[1] = 99999 }, /goes backwards|does not run/)
  bad((p) => { p.roads.xz[0] = 1.5 }, /whole numbers/)
  bad((p) => { p.roads.name[0] = 999 }, /missing name/)
  bad((p) => { p.buildings.height.pop() }, /wrong length/)
  bad((p) => { p.attribution = [] }, /attribution/)
  assert.throws(() => validatePack(null), /not an object/)
})

test('regionWanted: ?region=on walks the region in any build, ?region=off never; otherwise the build decides', () => {
  for (const first of [false, true]) {
    assert.equal(regionWanted('on', first), true)
    assert.equal(regionWanted('off', first), false)
    assert.equal(regionWanted(null, first), first)
    assert.equal(regionWanted('maybe', first), first)
  }
})
