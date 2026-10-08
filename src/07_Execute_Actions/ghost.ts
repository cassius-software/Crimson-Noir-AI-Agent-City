// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Ghost view: the physics world as the physics engine sees it, drawn as falling code over
 * the finished frame.
 * - The collider proxies render into a mask of their own, with the same camera: every building's box, the lamp,
 *   tree and signal poles, every car's chassis box, every pedestrian's contact envelope, and the shapes of every
 *   promoted pedestrian's rig (rigView.ts; its instance matrices are shared, so they cost nothing more here).
 * - A screen-space pass fills each shape with columns of procedural glyphs, traces its outline, and dims the city
 *   behind it. The glyphs are original: strokes on a small lattice, chosen by a hash; no font and no borrowed
 *   character set.
 * - It composites after the shutter, the ND, the film curve and FXAA, so it is never smeared or graded: it is
 *   instrumentation, not scenery, and it stays out of the velocity buffer.
 * - View-only: nothing here reaches the physics worker. Every shape is rebuilt on the page from the numbers the
 *   worker built its colliders from (city.ts POLES, car.ts chassisBox, simProtocol.ts PERSON, the world's boxes,
 *   the pose buffer, the crowd's render buffers).
 * What breaks if it is removed? The G key and the console's `ghost` command show nothing.
 */
import {
  BoxGeometry, CapsuleGeometry, CylinderGeometry, InstancedMesh, Matrix4, MeshBasicNodeMaterial, Quaternion, Scene,
  StorageBufferAttribute, Vector3, type Node, type TextureNode, type UniformNode,
} from 'three/webgpu'
import {
  Fn, If, abs, cameraPosition, clamp, dot, exp, float, floor, fract, hash, instanceIndex, ivec2, length, max, mix,
  normalView, positionLocal, positionView, screenCoordinate, screenSize, select, smoothstep, step, storage, uint, uniform,
  vec2, vec3, vec4,
} from 'three/tsl'
import type { Box, Furniture } from '../01_Initialize_World/city.ts'
import { POLES } from '../01_Initialize_World/city.ts'
import { chassisBox } from './car.ts'
import { PERSON, POSE } from './simProtocol.ts'
import { clampPx } from './shutter.ts'

/** What each shape is, as the mask stores it (0 = nothing). */
export const GHOST_KIND = Object.freeze({ building: 1, pole: 2, vehicle: 3, person: 4 })

/** The look. */
export const GHOST = Object.freeze({
  /** Glyph rows on screen (cells are 0.64 as wide as tall, at least 10 px tall). */
  rows: 48,
  /** Falling speed of a column, rows/s, and the spread between columns. */
  speed: 4,
  speedSpread: 6,
  /** Rows of fading trail behind a column's head. */
  trail: 10,
  /** How far the city behind dims while the view is on (0..1). */
  dim: 0.8,
  /** A pedestrian further than this is not drawn (the envelopes of a whole city would be noise), m. */
  peopleRange: 160,
  /** Seconds to fade in or out. */
  fade: 0.25,
  /**
   * The contact wipe (contact.ts): the iris of code opens from the centre of the frame to past its corners at full
   * cover (radius in screen heights), behind a soft front this wide, dimming the city this much.
   */
  wipeRadius: 1.4,
  wipeSoft: 0.18,
  wipeDim: 0.85,
})

/** The colour of each kind (display-referred: composited after the output transform). Greens throughout. */
export const GHOST_COLOR: Readonly<Record<keyof typeof GHOST_KIND, readonly [number, number, number]>> = Object.freeze({
  building: [0.1, 0.8, 0.38],
  pole: [0.3, 0.95, 0.6],
  vehicle: [0.7, 1, 0.3],
  person: [0.85, 1, 0.85],
})

type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type F1 = Node<'float'>

/**
 * The mask: x = kind, y = distance along the view axis (m), z = how squarely the face looks at the camera. Unlit,
 * so the mask pass stores exactly these numbers.
 */
function maskMaterial(kind: number, positionNode?: Node): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial()
  m.colorNode = vec3(float(kind), positionView.z.negate(), normalView.z.abs())
  if (positionNode) m.positionNode = positionNode
  m.fog = false
  return m
}

/** Unit shapes the proxies are scaled from: a box of edge 1 and a cylinder of radius 1 and height 1, centred. */
const unitBox = () => new BoxGeometry(1, 1, 1)
const unitCylinder = () => new CylinderGeometry(1, 1, 1, 10, 1)

/** The inputs: the world's boxes and furniture, which cars are SUVs, and the crowd's position buffer. */
export interface GhostSource {
  boxes: readonly Box[]
  furniture: Furniture
  suv: readonly boolean[]
  crowdPos: StorageBufferAttribute
  agents: number
  /** The rig shapes the page draws (rigView.ts meshes): drawn here as person-kind proxies from the same matrices. */
  rigs?: readonly InstancedMesh[]
}

export interface GhostView {
  /** The collider proxies. Hidden (so its pass only clears) while the view is off. */
  readonly scene: Scene
  /** The composite's inputs: 0..1 how far the view is on (faded), and the rain's clock, s. */
  readonly strength: UniformNode<'float', number>
  readonly seconds: UniformNode<'float', number>
  /**
   * The contact wipe, independent of the view: 0..1 how far the iris of code has opened (contact.ts ContactPulse),
   * and the kind met (GHOST_KIND, for its colour). The page sets both every drawn frame.
   */
  readonly contact: UniformNode<'float', number>
  readonly contactKind: UniformNode<'float', number>
  /** Whether the operator asked for the view (the fade follows). */
  readonly on: boolean
  setOn(on: boolean): void
  /**
   * One presented frame: the cars' chassis boxes from the pose buffer, the fade, the clock. Cheap while off and
   * faded out (nothing is written).
   */
  update(poses: Float32Array, dtSeconds: number, nowSeconds: number): void
}

const m4 = new Matrix4()
const box = new Matrix4()
const q = new Quaternion()
const v = new Vector3()
const s = new Vector3()

/** The chassis box of a car in world space: the pose, then the collider's offset and size (car.ts chassisBox). */
export function chassisMatrix(poses: Float32Array, index: number, suv: boolean, out: Matrix4): Matrix4 {
  const o = index * POSE.stride
  const c = chassisBox(suv)
  q.set(poses[o + POSE.qx], poses[o + POSE.qy], poses[o + POSE.qz], poses[o + POSE.qw])
  out.compose(v.set(poses[o + POSE.x], poses[o + POSE.y], poses[o + POSE.z]), q, s.set(1, 1, 1))
  return out.multiply(box.makeScale(2 * c.hx, 2 * c.hy, 2 * c.hz).setPosition(0, c.y, 0))
}

export function createGhost(src: GhostSource): GhostView {
  const scene = new Scene()
  scene.visible = false
  scene.name = 'Ghost view'

  // Buildings: one box each, as the physics worker builds them (physics.ts).
  const buildings = new InstancedMesh(unitBox(), maskMaterial(GHOST_KIND.building), Math.max(1, src.boxes.length))
  src.boxes.forEach(([x0, y0, z0, x1, y1, z1], i) => {
    buildings.setMatrixAt(i, m4.makeScale(x1 - x0, y1 - y0, z1 - z0).setPosition((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2))
  })
  buildings.count = src.boxes.length
  buildings.frustumCulled = false

  // Poles: lamps, tree trunks and signal posts, the physics worker's cylinders.
  const poleList: [number, number, { height: number; radius: number }][] = [
    ...src.furniture.lamps.map(([x, z]) => [x, z, POLES.lamp] as [number, number, typeof POLES.lamp]),
    ...src.furniture.trees.map(([x, z]) => [x, z, POLES.tree] as [number, number, typeof POLES.tree]),
    ...src.furniture.signals.map(([x, z]) => [x, z, POLES.signal] as [number, number, typeof POLES.signal]),
  ]
  const poles = new InstancedMesh(unitCylinder(), maskMaterial(GHOST_KIND.pole), Math.max(1, poleList.length))
  poleList.forEach(([x, z, p], i) => poles.setMatrixAt(i, m4.makeScale(p.radius, p.height, p.radius).setPosition(x, p.height / 2, z)))
  poles.count = poleList.length
  poles.frustumCulled = false

  // Cars: the chassis box, posed every presented frame. Seen from inside (the driver's seat) its faces point away
  // and are culled, so the driven car never fills the view.
  const cars = new InstancedMesh(unitBox(), maskMaterial(GHOST_KIND.vehicle), Math.max(1, src.suv.length))
  cars.count = src.suv.length
  cars.frustumCulled = false

  // People: every pedestrian's contact envelope, placed on the GPU from the crowd's own buffer (the same one the
  // crowd is drawn from); beyond peopleRange folded to a point (no triangles), and the player's own body, whose
  // envelope holds the camera, culled like the driven car.
  const pos = storage(src.crowdPos, 'vec4', src.agents).toReadOnly()
  const envelope = Fn(() => {
    const agent = pos.element(instanceIndex)
    const feet = agent.xyz
    const placed = feet.add(positionLocal).add(vec3(0, PERSON.halfHeight + PERSON.radius, 0))
    return select(cameraPosition.distance(feet).greaterThan(GHOST.peopleRange), feet, placed)
  })()
  const people = new InstancedMesh(new CapsuleGeometry(PERSON.radius, 2 * PERSON.halfHeight, 2, 8), maskMaterial(GHOST_KIND.person, envelope), Math.max(1, src.agents))
  people.frustumCulled = false

  scene.add(buildings, poles, cars, people)
  // The rigs: one proxy per shape mesh, sharing its geometry and instance matrices (an empty slot is scaled to nothing).
  for (const mesh of src.rigs ?? []) {
    const proxy = new InstancedMesh(mesh.geometry, maskMaterial(GHOST_KIND.person), mesh.count)
    proxy.instanceMatrix = mesh.instanceMatrix
    proxy.frustumCulled = false
    scene.add(proxy)
  }
  const strength = uniform(0)
  const seconds = uniform(0)
  const contact = uniform(0)
  const contactKind = uniform(0)
  let on = false
  return {
    scene, strength, seconds, contact, contactKind,
    get on() { return on },
    setOn(next: boolean) { on = next },
    update(poses: Float32Array, dt: number, now: number) {
      const target = on ? 1 : 0
      const step = Number.isFinite(dt) && dt > 0 ? Math.min(1, dt / GHOST.fade) : 1
      strength.value = strength.value < target ? Math.min(target, strength.value + step) : Math.max(target, strength.value - step)
      scene.visible = strength.value > 0
      // The rain's clock runs whether or not the view shows: the contact wipe falls in the same columns.
      seconds.value = Number.isFinite(now) ? now : 0
      if (!scene.visible) return
      for (let i = 0; i < src.suv.length; i++) cars.setMatrixAt(i, chassisMatrix(poses, i, src.suv[i], m4))
      cars.instanceMatrix.needsUpdate = true
    },
  }
}

// ---------------------------------------------------------------------------------------------------
// The code

/**
 * The glyph lattice: 3 × 3 points on the glyph box (0, ½, 1 each way) and the 16 strokes a glyph picks from, one bit
 * each: the six half-width horizontals, the six half-height verticals and the four half-diagonals from the centre.
 * A glyph is a hash's handful of them (two random 16-bit masks ANDed, plus one stroke so none is blank): an
 * alphabet generated here, not drawn from any font or script.
 */
const L = [0, 0.5, 1]
export const STROKES: readonly (readonly [number, number, number, number])[] = Object.freeze([
  // horizontals (6)
  [0, 0, 1, 0], [1, 0, 2, 0], [0, 1, 1, 1], [1, 1, 2, 1], [0, 2, 1, 2], [1, 2, 2, 2],
  // verticals (6)
  [0, 0, 0, 1], [0, 1, 0, 2], [1, 0, 1, 1], [1, 1, 1, 2], [2, 0, 2, 1], [2, 1, 2, 2],
  // half-diagonals from the centre (4)
  [1, 1, 0, 0], [1, 1, 2, 0], [1, 1, 0, 2], [1, 1, 2, 2],
].map(([a, b, c, d]) => Object.freeze([L[a], L[b], L[c], L[d]] as const)))

/** Distance from p to the segment ab. */
const segment = (p: V2, a: V2, b: V2): F1 => {
  const pa = p.sub(a), ba = b.sub(a)
  const t = clamp(dot(pa, ba).div(dot(ba, ba)), 0, 1)
  return length(pa.sub(ba.mul(t)))
}

/**
 * Ink of the glyph `bits` (16 strokes, one bit each) at `local` (0..1 in its cell of `cellPx` pixels): strokes of
 * about 1.2 px, anti-aliased by a pixel, inside a margin.
 */
function glyphInk(bits: Node<'uint'>, local: V2, cellPx: V2): F1 {
  // The glyph box fills the cell but a margin (14 % each side, 12 % top and bottom); p is in pixels from its corner.
  const scale = cellPx.mul(vec2(0.72, 0.76))
  const p = local.sub(vec2(0.14, 0.12)).mul(cellPx)
  let ink: F1 = float(0)
  STROKES.forEach(([ax, ay, bx, by], k) => {
    const on = float(bits.shiftRight(uint(k)).bitAnd(uint(1)))
    const d = segment(p, vec2(ax, ay).mul(scale), vec2(bx, by).mul(scale))
    ink = max(ink, on.mul(float(1).sub(smoothstep(0.6, 1.6, d))))
  })
  return ink
}

/** The kind's colour. */
const kindColor = (kind: F1): V3 => {
  const c = (k: keyof typeof GHOST_COLOR) => vec3(...GHOST_COLOR[k])
  return select(kind.lessThan(1.5), c('building'), select(kind.lessThan(2.5), c('pole'), select(kind.lessThan(3.5), c('vehicle'), c('person'))))
}

/**
 * The finished frame with ghost view and the contact wipe composited over it (image: display-referred, after FXAA).
 * Both off (strength and contact 0) it is the image, untouched: the whole branch is skipped on two uniforms.
 */
export function ghostComposite(image: Node<'vec4'>, mask: TextureNode, g: Pick<GhostView, 'strength' | 'seconds' | 'contact' | 'contactKind'>): Node<'vec4'> {
  // Frame and mask are the call's inputs (not captured), so the graph shows both: the finished frame and the pass.
  const composite = Fn(([frame, shapes]: [Node<'vec4'>, TextureNode]) => {
    const out = vec4(frame).toVar()
    If(g.strength.greaterThan(0).or(g.contact.greaterThan(0)), () => {
      const px = screenCoordinate.xy
      const size = screenSize
      const last = ivec2(size.sub(1))
      const at = (dx: number, dy: number) => shapes.load(clampPx(ivec2(px).add(ivec2(dx, dy)), last))
      const m = at(0, 0), mr = at(1, 0), md = at(0, 1)
      const kind = floor(m.x.add(0.5))
      const inside = step(0.5, kind)
      // Outlines: where the kind changes, or the same kind jumps in depth (one building in front of another).
      const kindEdge = step(0.5, abs(floor(mr.x.add(0.5)).sub(kind)).add(abs(floor(md.x.add(0.5)).sub(kind))))
      const depthEdge = step(0.03, max(abs(mr.y.sub(m.y)), abs(md.y.sub(m.y))).div(max(m.y, 1))).mul(inside)
      const edge = max(kindEdge, depthEdge)
      // Falling columns of glyphs, one cell per glyph.
      const cellH = max(float(10), floor(size.y.div(GHOST.rows)))
      const cellPx = vec2(floor(cellH.mul(0.64)), cellH)
      const c = floor(px.div(cellPx))
      const local = fract(px.div(cellPx))
      const column = hash(c.x.mul(7.13).add(0.5))
      const rows = size.y.div(cellH)
      const span = rows.add(GHOST.trail * 2)
      const head = fract(g.seconds.mul(column.mul(GHOST.speedSpread).add(GHOST.speed)).div(span).add(column.mul(9.7))).mul(span).sub(GHOST.trail)
      const behind = head.sub(c.y)
      const trail = select(behind.greaterThanEqual(0), exp(behind.negate().div(GHOST.trail)), float(0))
      const roll = floor(g.seconds.mul(column.mul(4).add(1)).add(hash(c.x.add(c.y.mul(131)))))
      const id = hash(c.x.mul(17.1).add(c.y.mul(311.7)).add(roll.mul(0.37)))
      const r1 = uint(hash(id.add(0.13)).mul(65535)), r2 = uint(hash(id.add(0.71)).mul(65535)), r3 = uint(hash(id.add(0.37)).mul(15.99))
      const bits = r1.bitAnd(r2).bitOr(uint(1).shiftLeft(r3))
      const ink = glyphInk(bits, local, cellPx)
      const facing = mix(float(0.55), float(1), m.z)
      const glyph = ink.mul(float(0.18).add(trail.mul(0.82)))
      const code = glyph.mul(facing).mul(inside)
      // The contact wipe: an iris of the same code opening from the centre of the frame (the point of passage), its
      // front a brighter ring while it moves.
      const d = length(px.sub(size.mul(0.5)).div(size.y))
      const radius = g.contact.mul(GHOST.wipeRadius)
      const wipe = float(1).sub(smoothstep(radius.sub(GHOST.wipeSoft), radius, d)).mul(step(1e-4, g.contact))
      const front = smoothstep(radius.sub(GHOST.wipeSoft), radius.sub(GHOST.wipeSoft * 0.3), d).mul(wipe).mul(float(1).sub(step(0.999, g.contact)))
      // The city recedes into a dark green; the shapes light up.
      const base = out.rgb
      const lum = dot(base, vec3(0.2126, 0.7152, 0.0722))
      const recede = vec3(0.01, 0.035, 0.02).add(vec3(0.08, 0.2, 0.11).mul(lum))
      const k = g.strength
      const light = kindColor(kind).mul(code.add(edge.mul(0.9))).mul(k)
      const wash = kindColor(g.contactKind).mul(glyph.mul(1.1).add(front.mul(0.35))).mul(wipe)
      const dim = max(k.mul(GHOST.dim), wipe.mul(GHOST.wipeDim))
      out.assign(vec4(mix(base, recede, dim).add(light).add(wash), out.a))
    })
    return out
  })
  return (composite as unknown as (f: Node, m: Node) => Node<'vec4'>)(image, mask)
}
