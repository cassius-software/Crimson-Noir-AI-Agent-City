// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the craft renderer in Node, with no GPU: every body it draws lies inside the
 * envelope the track network proves clear for its kind (a train car within the set's width and height over the deck,
 * a drone within its half-metre, a plane within its length and height, a VTOL within its box, a pad within the roof
 * it is set on); a view over the city's network has one slot per craft of the realm's stream and refuses another
 * count; and a stream placed on it puts every train car on the deck along the loop, eight metres apart, every drone at
 * its corridor's altitude, every plane banked into the racetrack's turns, every VTOL where the stream has it, and the
 * pads on their roofs. The shaders themselves are built by shadowShaders.test.ts with the rest of the city's.
 * What breaks if it is removed? A body could grow past the envelope Ring-0 and INV-1 guarantee, or the stream's numbers
 * could land on the wrong bodies, and only a device would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { Matrix4, Quaternion, Vector3, type BufferGeometry } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { TRACKS, buildTrackNetwork, lapSeconds, pieceAt, poseAt, type TrackKind } from '../06_Make_Decisions/tracks.ts'
import { generateBuildings } from '../01_Initialize_World/city.ts'
import { TRACK_KINDS, TRACK_POSE } from './simProtocol.ts'
import { TrackFleet, trackPoseAt } from './trackFleet.ts'

// Vite's `?raw` import, for Node: rain mode's WGSL comes that way.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})
const { CraftView, droneGeometry, padGeometry, planeGeometry, trainCarGeometry, vtolGeometry } = await import('./craftView.ts')

const SEED = 1337
const boxes = generateBuildings(SEED).map((b) => b.box)
const network = buildTrackNetwork(SEED, boxes)
const fleet = new TrackFleet(network)
const night = uniform(0)
const S = TRACK_POSE.stride

/** The extent of a geometry's vertices: the largest |x|, |z|, horizontal radius, and the lowest and highest y. */
function extent(g: BufferGeometry): { x: number; z: number; r: number; low: number; high: number } {
  const p = g.getAttribute('position')
  let x = 0, z = 0, r = 0, low = Infinity, high = -Infinity
  for (let i = 0; i < p.count; i++) {
    x = Math.max(x, Math.abs(p.getX(i)))
    z = Math.max(z, Math.abs(p.getZ(i)))
    r = Math.max(r, Math.hypot(p.getX(i), p.getZ(i)))
    low = Math.min(low, p.getY(i))
    high = Math.max(high, p.getY(i))
  }
  return { x, z, r, low, high }
}

test('every body lies inside the envelope its kind is proved clear by', () => {
  const car = extent(trainCarGeometry())
  assert.ok(car.x <= 4 && car.z <= TRACKS.train.halfWidth + 1e-6 && car.low >= -1e-6 && car.high <= TRACKS.train.height, `train car ${JSON.stringify(car)}`)
  const drone = extent(droneGeometry())
  assert.ok(drone.x <= TRACKS.drone.halfSize && drone.z <= TRACKS.drone.halfSize && -drone.low <= TRACKS.drone.halfSize && drone.high <= TRACKS.drone.halfSize, `drone ${JSON.stringify(drone)}`)
  const plane = extent(planeGeometry())
  assert.ok(plane.r <= TRACKS.plane.halfLength && -plane.low <= TRACKS.plane.halfHeight && plane.high <= TRACKS.plane.halfHeight, `plane ${JSON.stringify(plane)}`)
  const vtol = extent(vtolGeometry())
  assert.ok(vtol.x <= TRACKS.vtol.halfSize && vtol.z <= TRACKS.vtol.halfSize && -vtol.low <= TRACKS.vtol.halfHeight && vtol.high <= TRACKS.vtol.halfHeight, `vtol ${JSON.stringify(vtol)}`)
  assert.ok(-vtol.low <= TRACKS.vtol.hover, 'a VTOL sat at its hover stands over the roof')
  const pad = extent(padGeometry())
  assert.ok(pad.r <= TRACKS.vtol.padHalf && pad.low >= -0.15 - 1e-6 && pad.high <= 0.16, `pad ${JSON.stringify(pad)}`)
  for (const g of [trainCarGeometry(), droneGeometry(), planeGeometry(), vtolGeometry(), padGeometry()]) {
    assert.ok(g.getAttribute('part') && g.getAttribute('normal') && g.index, 'a part per vertex, normals and an index')
    g.dispose()
  }
})

test('a view over the city network: a slot per craft of the stream, the structure of the loop, the pads on their roofs; another count is refused', () => {
  const view = new CraftView(network, fleet.count, night, null)
  assert.equal(view.count, fleet.count)
  const kinds = Array.from({ length: fleet.count }, (_, i) => fleet.craftAt(i).kind)
  const of = (k: TrackKind) => kinds.filter((c) => c === TRACK_KINDS.indexOf(k)).length
  assert.equal(view.trains.count, of('train') * 3)
  assert.equal(view.drones.count, of('drone'))
  assert.equal(view.planes.count, of('plane'))
  assert.equal(view.vtols.count, of('vtol'))
  assert.ok(view.vtols.count >= 2, 'the city has VTOLs')
  const routes = network.tracks.filter((t) => t.kind === 'vtol')
  assert.equal(view.pads.count, routes.length * TRACKS.vtol.pads)
  const m = new Matrix4(), p = new Vector3(), q = new Quaternion(), s = new Vector3()
  let i = 0
  for (const t of routes) t.stations.forEach((st, k) => {
    view.pads.getMatrixAt(i++, m)
    m.decompose(p, q, s)
    const at = poseAt(t, st)
    // Instance matrices are single precision: a hundredth of a millimetre at the city's scale.
    assert.ok(Math.abs(p.x - at.x) < 1e-3 && Math.abs(p.z - at.z) < 1e-3 && Math.abs(p.y - (t.pads[k] + 0.15)) < 1e-3, `pad ${i} on its roof`)
  })
  assert.ok(view.guideway && view.columns && view.beams)
  const train = network.tracks.find((t) => t.kind === 'train')!
  assert.ok(view.columns.count > 100 && view.beams.count === view.columns.count / 2)
  view.columns.getMatrixAt(0, m)
  m.decompose(p, q, s)
  assert.equal(p.y, 0, 'a column stands on the ground')
  const deck = extent(view.guideway.geometry as BufferGeometry)
  assert.ok(deck.low >= train.y - 0.6 - 1e-6 && deck.high <= train.y + 4.7, 'the deck lies under the rail top, the canopies over the envelope')
  assert.deepEqual(view.meshes.map((o) => o.name), ['Trains', 'Drones', 'Planes', 'VTOLs', 'VTOLPads', 'Guideway', 'GuidewayColumns', 'GuidewayBeams'])
  for (const mesh of view.meshes) assert.ok(mesh.castShadow === mesh.receiveShadow)
  assert.throws(() => new CraftView(network, fleet.count + 1, night, null), /craft/)
  view.dispose()
})

test('a stream placed on the view: train cars on the deck along the loop 8 m apart, drones at altitude, planes banked in the turns, VTOLs where the stream has them', () => {
  const view = new CraftView(network, fleet.count, night, null)
  const buf = new Float32Array(fleet.length)
  const m = new Matrix4(), p = new Vector3(), q = new Quaternion(), s = new Vector3(), fwd = new Vector3(), right = new Vector3()
  const planeTrack = network.tracks.find((t) => t.kind === 'plane')!
  let banked = 0, level = 0
  for (const t of [0, 37.5, 200, 1234.25]) {
    // Several syncs at one time let a plane's eased bank settle.
    for (let k = 0; k < 120; k++) view.sync(fleet.writePoses(t, buf))
    for (let i = 0; i < fleet.count; i++) {
      const c = fleet.craftAt(i), o = i * S
      const track = network.tracks[c.track]
      const kind = TRACK_KINDS[c.kind]
      if (kind === 'train') {
        for (let car = 0; car < 3; car++) {
          view.trains.getMatrixAt(view.slotOf[i] * 3 + car, m)
          m.decompose(p, q, s)
          const want = trackPoseAt(track, buf[o + TRACK_POSE.s] + (car - 1) * 8)
          assert.ok(Math.abs(p.x - want.x) < 1e-3 && Math.abs(p.z - want.z) < 1e-3 && Math.abs(p.y - TRACKS.train.deck) < 1e-6, `car ${car} of set ${c.index} on the loop at ${t} s`)
          fwd.set(1, 0, 0).applyQuaternion(q)
          assert.ok(Math.abs(fwd.x - Math.sin(want.heading)) < 1e-4 && Math.abs(fwd.z - Math.cos(want.heading)) < 1e-4 && Math.abs(fwd.y) < 1e-6, 'a car faces along the loop')
        }
      } else {
        const mesh = kind === 'drone' ? view.drones : kind === 'plane' ? view.planes : view.vtols
        mesh.getMatrixAt(view.slotOf[i], m)
        m.decompose(p, q, s)
        assert.ok(Math.abs(p.x - buf[o]) < 1e-3 && Math.abs(p.y - buf[o + 1]) < 1e-3 && Math.abs(p.z - buf[o + 2]) < 1e-3, `${kind} ${i} where the stream has it`)
        fwd.set(1, 0, 0).applyQuaternion(q)
        const h = buf[o + TRACK_POSE.heading]
        const flat = Math.hypot(fwd.x, fwd.z)
        assert.ok(Math.abs(fwd.x / flat - Math.sin(h)) < 1e-4 && Math.abs(fwd.z / flat - Math.cos(h)) < 1e-4, `${kind} ${i} faces its heading`)
        if (kind === 'drone') assert.ok(fwd.y < 0 && fwd.y > -0.2, 'a drone under way noses down a little')
        if (kind === 'vtol') assert.ok(fwd.y <= 1e-9 && fwd.y >= -0.2 && (buf[o + TRACK_POSE.speed] > 0 || Math.abs(fwd.y) < 1e-9), 'a VTOL noses down with its speed, upright on a pad')
        if (kind === 'plane') {
          // Rolled into a right turn (positive sweep) with the right wing (−z) down; level on the straights.
          right.set(0, 0, -1).applyQuaternion(q)
          const piece = pieceAt(planeTrack, buf[o + TRACK_POSE.s])
          if (piece.kind === 'arc') {
            const want = Math.atan((TRACKS.plane.speed ** 2) / (9.81 * piece.radius))
            assert.ok(Math.sign(piece.sweep) * -right.y > 0, 'the inner wing is down')
            assert.ok(Math.abs(Math.asin(-right.y * Math.sign(piece.sweep)) - want) < 0.02, `banked ${want.toFixed(2)} rad`)
            banked++
          } else { assert.ok(Math.abs(right.y) < 0.02, 'level on a straight'); level++ }
        }
      }
    }
  }
  assert.ok(banked > 0 && level > 0, `planes seen banked ${banked} and level ${level}`)
  assert.ok(lapSeconds(planeTrack) > 0)
  view.dispose()
})
