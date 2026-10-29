// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It draws the scheduled craft on the page: the train sets on the elevated loop (three rigid
 * cars a set, laid along the loop behind the set's head), the drones on their corridors, the planes on the racetrack
 * (banked through its turns by their own speed and the turn's radius) and the VTOLs between their rooftop pads
 * (nose down with their speed, upright over a pad), from the craft stream the physics worker sends every step
 * (simProtocol.ts TRACK_POSE), one InstancedMesh a kind; and the structure that stands still: the loop's deck,
 * guideway columns and beams, its four station platforms with their canopies, and a pad on every roof a VTOL calls
 * at. The page builds the network for them from the same seed and boxes as the realm (tracks.ts buildTrackNetwork),
 * so the deck lies under the trains and the pads under the VTOLs by construction. It holds no physics and no
 * timetable: numbers in, matrices out; the realm's Ring-0 audit has already read every number here.
 * What breaks if it is removed? The craft run in the worker but are never seen, and the sky and the loop stay empty.
 */
import {
  BoxGeometry, BufferGeometry, ConeGeometry, CylinderGeometry, Float32BufferAttribute, InstancedMesh, Matrix4, Mesh, MeshStandardNodeMaterial,
  Quaternion, RingGeometry, Vector3, type Object3D, type UniformNode, type Vector4,
} from 'three/webgpu'
import { abs, attribute, float, select, sin, time, vec3 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import { applyMatrixMode } from '../01_Initialize_World/matrixMode.ts'
import { TRACKS, guideway, pieceAt, poseAt, type Track, type TrackNetwork } from '../06_Make_Decisions/tracks.ts'
import { TRACK_KINDS, TRACK_POSE } from './simProtocol.ts'
import { TrackFleet, trackPoseAt } from './trackFleet.ts'

type Night = UniformNode<'float', number>
type Mode = UniformNode<'vec4', Vector4> | null

/** The parts of a body, as the `part` attribute names them for the materials. */
const PART = { shell: 0, glass: 1, lampPort: 2, lampStarboard: 3, strobe: 4, beacon: 5, rotor: 6, stripe: 7, concrete: 8, mark: 9 } as const

/** Length of one car of a train set and the spacing of the three along the loop, m (TRACKS.train.length is the set's 24). */
const CAR_LENGTH = 7.6
const CAR_PITCH = 8
/** Nose-down pitch, rad, of a drone under way and of a VTOL at its route speed. */
const DRONE_PITCH = 0.1
const VTOL_PITCH = 0.14
/** How much of the way to its target bank a plane rolls each sync (about 0.2 s at 60 a second). */
const BANK_EASE = 0.08
const G = 9.81
const KIND = { train: TRACK_KINDS.indexOf('train'), drone: TRACK_KINDS.indexOf('drone'), plane: TRACK_KINDS.indexOf('plane'), vtol: TRACK_KINDS.indexOf('vtol') }
/** The envelope the pads are drawn within: a pad's radius is under TRACKS.vtol.padHalf, so it lies on the roof it is set on. */
const PAD_RADIUS = 3.8

/** One geometry from parts, each tagged with its `part` number for the material. */
function assemble(parts: [BufferGeometry, number][]): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], id: number[] = [], idx: number[] = []
  for (const [g, part] of parts) {
    const base = pos.length / 3
    const count = g.getAttribute('position').count
    pos.push(...(g.getAttribute('position').array as Float32Array))
    nor.push(...(g.getAttribute('normal').array as Float32Array))
    for (let i = 0; i < count; i++) id.push(part)
    if (g.index) for (const i of g.index.array) idx.push(base + i)
    else for (let i = 0; i < count; i++) idx.push(base + i)
    g.dispose()
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  out.setAttribute('part', new Float32BufferAttribute(id, 1))
  out.setIndex(idx)
  return out
}

const box = (w: number, h: number, d: number, x = 0, y = 0, z = 0): BufferGeometry => new BoxGeometry(w, h, d).translate(x, y, z)

/**
 * One car of a train set: the body on the deck (its floor 0.3 m up, its roof at 3.5 m, within the 4 m envelope), a
 * window band, the crimson stripe and two bogies. Forward is +x; the origin is the car's centre on the deck.
 */
export function trainCarGeometry(): BufferGeometry {
  return assemble([
    [box(CAR_LENGTH, 3.2, 2.9, 0, 1.9), PART.shell],
    [box(CAR_LENGTH - 0.4, 1.0, 2.96, 0, 2.3), PART.glass],
    [box(CAR_LENGTH + 0.02, 0.25, 2.94, 0, 1.0), PART.stripe],
    [box(1.6, 0.4, 2.2, 2.4, 0.2), PART.shell],
    [box(1.6, 0.4, 2.2, -2.4, 0.2), PART.shell],
  ])
}

/** A drone: a body, four booms on the diagonals, four rotors, port and starboard lights; within TRACKS.drone.halfSize. */
export function droneGeometry(): BufferGeometry {
  const parts: [BufferGeometry, number][] = [[box(0.46, 0.1, 0.46), PART.shell]]
  for (const a of [Math.PI / 4, -Math.PI / 4]) parts.push([new BoxGeometry(0.76, 0.03, 0.05).rotateY(a).translate(0, 0.06, 0), PART.shell])
  for (const x of [-0.27, 0.27]) for (const z of [-0.27, 0.27]) parts.push([new CylinderGeometry(0.17, 0.17, 0.015, 10).translate(x, 0.09, z), PART.rotor])
  parts.push([box(0.06, 0.06, 0.06, 0.2, 0, 0.2), PART.lampPort], [box(0.06, 0.06, 0.06, 0.2, 0, -0.2), PART.lampStarboard])
  return assemble(parts)
}

/**
 * A plane: fuselage, nose and tail cones, wings, tailplane, fin, two engines, a window band, wingtip lights and a tail
 * strobe. Forward is +x, within TRACKS.plane.halfLength along and halfHeight up (the fin's top).
 */
export function planeGeometry(): BufferGeometry {
  return assemble([
    [new CylinderGeometry(1.6, 1.6, 32, 16).rotateZ(Math.PI / 2), PART.shell],
    [new ConeGeometry(1.6, 3.5, 16).rotateZ(-Math.PI / 2).translate(17.75, 0, 0), PART.shell],
    [new ConeGeometry(1.6, 3, 16).rotateZ(Math.PI / 2).translate(-17.5, 0, 0), PART.shell],
    [box(5, 0.4, 36, 1, -0.5), PART.shell],
    [box(2.6, 0.3, 12, -16, 0.4), PART.shell],
    [box(2.6, 4.0, 0.3, -16.5, 3.4), PART.shell],
    [new CylinderGeometry(0.8, 0.8, 3.4, 12).rotateZ(Math.PI / 2).translate(1.5, -1.3, 6), PART.shell],
    [new CylinderGeometry(0.8, 0.8, 3.4, 12).rotateZ(Math.PI / 2).translate(1.5, -1.3, -6), PART.shell],
    [box(24, 0.5, 3.24, 1, 0.5), PART.glass],
    [box(0.3, 0.3, 0.3, 1, -0.5, 18), PART.lampPort],
    [box(0.3, 0.3, 0.3, 1, -0.5, -18), PART.lampStarboard],
    [box(0.3, 0.3, 0.3, -17.6, 5.3, 0), PART.strobe],
  ])
}

/**
 * A VTOL: a cabin with a canopy and the crimson stripe, two booms carrying four ducted rotors, a beacon and two skids,
 * within TRACKS.vtol.halfSize about and halfHeight over and under its centre (the skids' bottom is a hair inside).
 */
export function vtolGeometry(): BufferGeometry {
  const parts: [BufferGeometry, number][] = [
    [box(3.6, 1.5, 1.8), PART.shell],
    [box(1.4, 0.9, 1.84, 0.9, 0.25), PART.glass],
    [box(3.64, 0.2, 1.84, 0, -0.3), PART.stripe],
    [box(0.3, 0.18, 4.6, 1.3, 0.55), PART.shell],
    [box(0.3, 0.18, 4.6, -1.3, 0.55), PART.shell],
    [box(0.2, 0.2, 0.2, 0, 0.85), PART.beacon],
    [box(2.2, 0.08, 0.1, 0, -1.45, 0.7), PART.shell],
    [box(2.2, 0.08, 0.1, 0, -1.45, -0.7), PART.shell],
  ]
  for (const x of [-0.8, 0.8]) for (const z of [-0.7, 0.7]) parts.push([box(0.08, 0.7, 0.08, x, -1.1, z), PART.shell])
  for (const x of [-1.3, 1.3]) for (const z of [-2.0, 2.0]) {
    parts.push([new CylinderGeometry(0.9, 0.9, 0.34, 16).translate(x, 0.72, z), PART.shell])
    parts.push([new CylinderGeometry(0.72, 0.72, 0.03, 16).translate(x, 0.9, z), PART.rotor])
  }
  return assemble(parts)
}

/** A rooftop pad: a concrete disc, its lit ring and the H. The origin is the disc's centre; it is set 0.15 m into the roof. */
export function padGeometry(): BufferGeometry {
  return assemble([
    [new CylinderGeometry(PAD_RADIUS, PAD_RADIUS, 0.3, 32), PART.concrete],
    [new RingGeometry(PAD_RADIUS - 0.5, PAD_RADIUS - 0.2, 32).rotateX(-Math.PI / 2).translate(0, 0.151, 0), PART.mark],
    [box(0.35, 0.01, 2.4, 1.0, 0.151), PART.mark],
    [box(0.35, 0.01, 2.4, -1.0, 0.151), PART.mark],
    [box(1.7, 0.01, 0.35, 0, 0.151), PART.mark],
  ])
}

/**
 * The elevated loop's deck (0.6 m under the rail top, 3.4 m wide, a slab a piece and a dozen along each curve), and at
 * each station a platform each side at the cars' floor, a canopy over the envelope and its four posts.
 */
export function guidewayGeometry(train: Track): BufferGeometry {
  const parts: [BufferGeometry, number][] = []
  const m = new Matrix4(), q = new Quaternion(), up = new Vector3(0, 1, 0), v = new Vector3(), one = new Vector3(1, 1, 1)
  const slab = (s0: number, s1: number) => {
    const a = poseAt(train, s0), b = poseAt(train, s1)
    const length = Math.hypot(b.x - a.x, b.z - a.z) + 0.05
    const heading = Math.atan2(b.x - a.x, b.z - a.z)
    m.compose(v.set((a.x + b.x) / 2, train.y - 0.3, (a.z + b.z) / 2), q.setFromAxisAngle(up, heading - Math.PI / 2), one)
    parts.push([new BoxGeometry(length, 0.6, 3.4).applyMatrix4(m), PART.concrete])
  }
  for (const p of train.pieces) {
    const n = p.kind === 'line' ? 1 : 12
    for (let i = 0; i < n; i++) slab(p.s0 + (i / n) * p.length, p.s0 + ((i + 1) / n) * p.length)
  }
  for (const s of train.stations) {
    const c = poseAt(train, s)
    m.compose(v.set(c.x, 0, c.z), q.setFromAxisAngle(up, c.heading - Math.PI / 2), one)
    const at = (g: BufferGeometry, part: number) => parts.push([g.applyMatrix4(m), part])
    for (const side of [-1, 1]) {
      at(box(30, 0.3, 2.0, 0, train.y + 0.15, side * 2.7), PART.concrete)
      for (const along of [-12, 12]) at(new CylinderGeometry(0.12, 0.12, 4.3, 8).translate(along, train.y + 2.45, side * 3.4), PART.shell)
    }
    at(box(30, 0.15, 7.6, 0, train.y + 4.6), PART.concrete)
  }
  return assemble(parts)
}

/** Whether the vertex is of `part`. */
const isPart = (part: Node<'float'>, k: number): Node<'bool'> => abs(part.sub(float(k))).lessThan(0.5)

/**
 * The one material shape every craft and structure here takes: the shell's own colour, glass, the crimson stripe,
 * rotors and concrete by part; at night the glass glows warm, the port light red and the starboard green (blinking
 * together), the strobe white, the beacon amber, the pad's ring and H crimson; then rain mode over all of it, once.
 */
function craftMaterial(shell: [number, number, number], night: Night, matrixMode: Mode, o: { metal: number; rough: number; glow?: number } = { metal: 0.5, rough: 0.4 }): MeshStandardNodeMaterial {
  const mat = new MeshStandardNodeMaterial()
  const part = attribute('part', 'float')
  const glass = isPart(part, PART.glass), stripe = isPart(part, PART.stripe), rotor = isPart(part, PART.rotor), concrete = isPart(part, PART.concrete)
  const port = isPart(part, PART.lampPort), starboard = isPart(part, PART.lampStarboard), strobe = isPart(part, PART.strobe), beacon = isPart(part, PART.beacon), mark = isPart(part, PART.mark)
  const body = vec3(...shell)
  mat.colorNode = select(glass, vec3(0.02, 0.025, 0.03), select(stripe, vec3(0.45, 0.03, 0.05), select(rotor, vec3(0.05, 0.05, 0.055), select(concrete, vec3(0.42, 0.42, 0.4), select(mark, vec3(0.85, 0.85, 0.85), body)))))
  mat.metalnessNode = select(glass, float(0.2), select(concrete.or(mark), float(0), float(o.metal)))
  mat.roughnessNode = select(glass, float(0.05), select(concrete.or(mark), float(0.9), select(rotor, float(0.3), float(o.rough))))
  const dark = night.mul(0.9).add(0.1)
  const blink = select(sin(time.mul(6)).greaterThan(0.6), float(1), float(0.15))
  const flash = select(sin(time.mul(12)).greaterThan(0.9), float(1), float(0))
  const pulse = sin(time.mul(12.57)).mul(0.5).add(0.5).mul(sin(time.mul(1.57)).mul(0.5).add(0.5))
  const cabin = vec3(1.0, 0.8, 0.55).mul(night.mul(o.glow ?? 0.5))
  let glow = select(glass, cabin, vec3(0))
  glow = select(port, vec3(1.0, 0.05, 0.03).mul(dark.mul(5)).mul(blink), glow)
  glow = select(starboard, vec3(0.1, 1.0, 0.35).mul(dark.mul(5)).mul(blink), glow)
  glow = select(strobe, vec3(1, 1, 1).mul(dark.mul(8)).mul(flash), glow)
  glow = select(beacon, vec3(1.0, 0.45, 0.05).mul(pulse.mul(5).add(0.5)), glow)
  glow = select(mark, vec3(0.9, 0.08, 0.12).mul(night.mul(3).add(0.4)), glow)
  mat.emissiveNode = glow
  if (matrixMode) applyMatrixMode(mat, matrixMode)
  return mat
}

export class CraftView {
  /** Everything to add to the scene: the four kinds' instanced meshes, the pads, the deck and its columns and beams. */
  readonly meshes: readonly Object3D[]
  /** Craft in every stream this view reads: the network's, which must be the realm's. */
  readonly count: number
  readonly trains: InstancedMesh
  readonly drones: InstancedMesh
  readonly planes: InstancedMesh
  readonly vtols: InstancedMesh
  readonly pads: InstancedMesh
  readonly guideway: Mesh | null
  readonly columns: InstancedMesh | null
  readonly beams: InstancedMesh | null
  /** Per craft: its kind code and its slot in that kind's mesh (a train set's slot is its first car's / 3). */
  readonly kindOf: Uint8Array
  readonly slotOf: Int32Array
  private readonly tracks: readonly Track[]
  /** Per plane slot, the bank it is drawn at, eased toward the turn's. */
  private readonly bank: Float32Array
  private readonly m = new Matrix4()
  private readonly q = new Quaternion()
  private readonly q2 = new Quaternion()
  private readonly v = new Vector3()
  private readonly one = new Vector3(1, 1, 1)
  private readonly X = new Vector3(1, 0, 0)
  private readonly Y = new Vector3(0, 1, 0)
  private readonly Z = new Vector3(0, 0, 1)

  /**
   * `network`: the realm's own (buildTrackNetwork with the same seed and boxes); `count`: the craft in the realm's stream
   * (SimMeta.craft), which must be the network's, or the page would place the stream's numbers on the wrong bodies.
   */
  constructor(network: TrackNetwork, count: number, night: Night, matrixMode: Mode = null) {
    const fleet = new TrackFleet(network)
    if (fleet.count !== count) throw new Error(`the page's track network has ${fleet.count} craft, the realm's stream ${count}`)
    this.count = count
    this.tracks = network.tracks
    this.kindOf = new Uint8Array(count)
    this.slotOf = new Int32Array(count)
    const per = [0, 0, 0, 0, 0]
    for (let i = 0; i < count; i++) {
      const c = fleet.craftAt(i)
      this.kindOf[i] = c.kind
      this.slotOf[i] = per[c.kind]++
    }
    const instanced = (geo: BufferGeometry, mat: MeshStandardNodeMaterial, n: number, name: string, shadows: boolean): InstancedMesh => {
      const mesh = new InstancedMesh(geo, mat, Math.max(1, n))
      mesh.count = n
      mesh.name = name
      mesh.frustumCulled = false
      mesh.castShadow = shadows
      mesh.receiveShadow = shadows
      return mesh
    }
    this.trains = instanced(trainCarGeometry(), craftMaterial([0.12, 0.125, 0.135], night, matrixMode, { metal: 0.6, rough: 0.35, glow: 0.7 }), per[KIND.train] * 3, 'Trains', true)
    this.drones = instanced(droneGeometry(), craftMaterial([0.16, 0.17, 0.18], night, matrixMode, { metal: 0.4, rough: 0.5 }), per[KIND.drone], 'Drones', false)
    this.planes = instanced(planeGeometry(), craftMaterial([0.82, 0.83, 0.85], night, matrixMode, { metal: 0.7, rough: 0.3, glow: 0.4 }), per[KIND.plane], 'Planes', false)
    this.vtols = instanced(vtolGeometry(), craftMaterial([0.14, 0.14, 0.15], night, matrixMode, { metal: 0.55, rough: 0.35, glow: 0.6 }), per[KIND.vtol], 'VTOLs', true)
    this.bank = new Float32Array(Math.max(1, per[KIND.plane]))
    // The pads: one on every roof a VTOL route calls at, set 0.15 m into it.
    const padsAt: { x: number; y: number; z: number }[] = []
    for (const t of network.tracks) if (t.kind === 'vtol') t.stations.forEach((s, i) => { const p = poseAt(t, s); padsAt.push({ x: p.x, y: t.pads[i], z: p.z }) })
    this.pads = instanced(padGeometry(), craftMaterial([0.42, 0.42, 0.4], night, matrixMode, { metal: 0, rough: 0.9 }), padsAt.length, 'VTOLPads', true)
    padsAt.forEach((p, i) => this.pads.setMatrixAt(i, this.m.compose(this.v.set(p.x, p.y + 0.15, p.z), this.q.identity(), this.one)))
    this.pads.frustumCulled = padsAt.length > 0
    if (padsAt.length > 0) this.pads.computeBoundingSphere()
    // The loop's structure.
    const train = network.tracks.find((t) => t.kind === 'train') ?? null
    const meshes: Object3D[] = [this.trains, this.drones, this.planes, this.vtols, this.pads]
    if (train) {
      const concrete = craftMaterial([0.42, 0.42, 0.4], night, matrixMode, { metal: 0, rough: 0.9 })
      this.guideway = new Mesh(guidewayGeometry(train), concrete)
      this.guideway.name = 'Guideway'
      this.guideway.castShadow = true
      this.guideway.receiveShadow = true
      const { columns, beams } = guideway(train)
      const height = train.y - 0.6
      const column = assemble([[new CylinderGeometry(TRACKS.train.columnRadius, TRACKS.train.columnRadius, height, 12).translate(0, height / 2, 0), PART.concrete]])
      this.columns = instanced(column, concrete, columns.length, 'GuidewayColumns', true)
      columns.forEach(([x, z], i) => this.columns!.setMatrixAt(i, this.m.compose(this.v.set(x, 0, z), this.q.identity(), this.one)))
      this.beams = instanced(assemble([[new BoxGeometry(1, 0.5, 0.5), PART.concrete]]), concrete, beams.length, 'GuidewayBeams', true)
      beams.forEach(([x0, z0, x1, z1], i) => {
        const length = Math.hypot(x1 - x0, z1 - z0) + 2 * TRACKS.train.columnRadius
        this.q.setFromAxisAngle(this.Y, Math.atan2(-(z1 - z0), x1 - x0))
        this.beams!.setMatrixAt(i, this.m.compose(this.v.set((x0 + x1) / 2, train.y - 0.85, (z0 + z1) / 2), this.q, this.v.clone().set(length, 1, 1)))
      })
      for (const mesh of [this.columns, this.beams]) { mesh.frustumCulled = true; mesh.computeBoundingSphere() }
      meshes.push(this.guideway, this.columns, this.beams)
    } else {
      this.guideway = null
      this.columns = null
      this.beams = null
    }
    this.meshes = Object.freeze(meshes)
  }

  /** Yaw for the realm's heading (forward (sin h, 0, cos h)) on a body whose forward is +x. */
  private yaw(heading: number): Quaternion {
    return this.q.setFromAxisAngle(this.Y, heading - Math.PI / 2)
  }

  /** Instance matrices from one step's craft stream (TRACK_POSE slices, in the realm's order). */
  sync(craft: Float32Array): void {
    const S = TRACK_POSE.stride
    const n = Math.min(this.count, Math.floor(craft.length / S))
    for (let i = 0; i < n; i++) {
      const o = i * S
      const x = craft[o + TRACK_POSE.x], y = craft[o + TRACK_POSE.y], z = craft[o + TRACK_POSE.z], heading = craft[o + TRACK_POSE.heading]
      const s = craft[o + TRACK_POSE.s], speed = craft[o + TRACK_POSE.speed]
      const kind = this.kindOf[i], slot = this.slotOf[i]
      const track = this.tracks[craft[o + TRACK_POSE.track]]
      if (kind === KIND.train) {
        // Three cars along the loop about the set's head: the stream's s is the set's centre.
        for (let c = 0; c < 3; c++) {
          const p = track ? trackPoseAt(track, s + (c - 1) * CAR_PITCH) : { x, y, z, heading }
          this.m.compose(this.v.set(p.x, p.y, p.z), this.yaw(p.heading), this.one)
          this.trains.setMatrixAt(slot * 3 + c, this.m)
        }
      } else if (kind === KIND.drone) {
        this.yaw(heading).multiply(this.q2.setFromAxisAngle(this.Z, -DRONE_PITCH))
        this.drones.setMatrixAt(slot, this.m.compose(this.v.set(x, y, z), this.q, this.one))
      } else if (kind === KIND.plane) {
        // Banked by the turn: tan(bank) = v² / (g R) on an arc, level on a straight; eased so a piece's end is not a snap.
        const piece = track ? pieceAt(track, s) : null
        const target = piece && piece.kind === 'arc' ? -Math.sign(piece.sweep) * Math.atan((speed * speed) / (G * piece.radius)) : 0
        this.bank[slot] += (target - this.bank[slot]) * BANK_EASE
        this.yaw(heading).multiply(this.q2.setFromAxisAngle(this.X, this.bank[slot]))
        this.planes.setMatrixAt(slot, this.m.compose(this.v.set(x, y, z), this.q, this.one))
      } else if (kind === KIND.vtol) {
        this.yaw(heading).multiply(this.q2.setFromAxisAngle(this.Z, -VTOL_PITCH * Math.min(1, speed / TRACKS.vtol.speed)))
        this.vtols.setMatrixAt(slot, this.m.compose(this.v.set(x, y, z), this.q, this.one))
      }
    }
    for (const mesh of [this.trains, this.drones, this.planes, this.vtols]) mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      const m = mesh as Mesh
      m.geometry.dispose()
      ;(m.material as MeshStandardNodeMaterial).dispose()
    }
  }
}
