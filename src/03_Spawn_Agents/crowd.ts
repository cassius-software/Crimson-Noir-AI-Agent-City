/**
 * Why does this file exist? It is the crowd's render side: four business-casual body variants
 * (suit, smart casual, pantsuit, skirt suit) at two levels of detail, eight InstancedMesh arrays fed by
 * GPU-compacted indirect draws, per-person attire and accessories chosen from hashed palettes, and
 * the WGSL vertex kinematics that pose each body from GPU state — including the player's own body, which
 * the first-person eye never sees from inside but whose shadow still walks beside them. The state it poses
 * them from arrives from the physics worker, which alone simulates the pedestrians (crowdSim.ts); the page
 * writes each frame into these buffers and culls it (crowdCull.ts). A person's look is hashed from their
 * index unless the page's per-agent look word (look.ts, one u32 in `crowd.look`) names one: then its bits
 * choose the pieces, the proportions and every colour slot in place of the hash (the body itself is chosen
 * from the same word in the cull, crowd.wgsl), so the player and a recruit can wear what they chose.
 * What breaks if it is removed? No pedestrian is drawn, and the worker's frames have nowhere to land.
 */
import {
  BoxGeometry, BufferGeometry, CapsuleGeometry, Color, CylinderGeometry, Float32BufferAttribute,
  IndirectStorageBufferAttribute, InstancedMesh, LatheGeometry, MeshStandardNodeMaterial, SphereGeometry,
  StorageBufferAttribute, Vector2, type Node, type NodeBuilder, type UniformNode,
} from 'three/webgpu'
import {
  Fn, attribute, cameraPosition, float, hash, instanceIndex, mix, normalLocal, positionLocal, positionPrevious, select, step,
  storage, time, uint, uniform, uniformArray, varyingProperty, vec3, vec4, wgslFn,
} from 'three/tsl'
import { CODE_DISSOLVE, applyCodeDissolve } from '../01_Initialize_World/codeDissolve.ts'
import { PLAYER_INDEX, VARIANTS, agentQuota } from './crowdCompute.ts'
import { LOOK_FIELD, LOOK_SCALE, WARDROBE, type LookSlot, type PaletteName } from './look.ts'

/**
 * The player's own body (agent PLAYER_INDEX) seen from inside its head would fill the view: it is folded to
 * a point for any camera within `radius` of its head (`height` above its feet). The shadow pass renders from
 * the sun through its own position node (castShadowPositionNode), which never folds, so looking down shows
 * one's own shadow walking.
 */
export const OWN_BODY = { height: 1.6, radius: 0.8 } as const

/**
 * The ink of a dissolving pedestrian: the ghost view's person green (ghost.ts GHOST_COLOR.person, linear RGB). Stage 03
 * cannot import stage 07, so the value is repeated here; dissolve.test.ts pins the two equal.
 */
export const PEOPLE_DISSOLVE_INK: readonly [number, number, number] = Object.freeze([0.85, 1, 0.85] as [number, number, number])

type V3 = Node<'vec3'>
type F1 = Node<'float'>
type U1 = Node<'uint'>

/** Whether the pass being built writes motion vectors (three's builder knows; its typings leave the method out). */
const needsPrevious = (b: NodeBuilder): boolean => (b as NodeBuilder & { needsPreviousData(): boolean }).needsPreviousData()

// Rig parts: 0/1 legs, 2 torso (+ skirt), 3 head, 4/5 arms (+ held props).
const PART = { L_LEG: 0, R_LEG: 1, TORSO: 2, HEAD: 3, L_ARM: 4, R_ARM: 5 } as const
// Material slots.
const S = { TOP: 0, SHIRT: 1, SKIN: 2, HAIR: 3, BOTTOM: 4, SHOES: 5, ACCENT: 6, PROP: 7, LEGWEAR: 8, FRAME: 9 } as const
// Optional pieces, one bit each in the per-person mask.
const O = { NONE: 0, TIE: 1, BAG: 2, CUP: 3, LONG_HAIR: 4, GLASSES: 5 } as const

export const VARIANT_NAMES = ['suit', 'smart casual', 'pantsuit', 'skirt suit'] as const

type Piece = [geo: BufferGeometry, part: number, slot: number, opt?: number]

function build(pieces: Piece[]): BufferGeometry {
  const pos: number[] = [], nor: number[] = [], rig: number[] = [], idx: number[] = []
  for (const [g, part, slot, opt = O.NONE] of pieces) {
    const base = pos.length / 3
    const count = g.getAttribute('position').count
    pos.push(...(g.getAttribute('position').array as Float32Array))
    nor.push(...(g.getAttribute('normal').array as Float32Array))
    for (let i = 0; i < count; i++) rig.push(part, slot, opt)
    if (g.index) for (const i of g.index.array) idx.push(base + i)
    else for (let i = 0; i < count; i++) idx.push(base + i)
    g.dispose()
  }
  const out = new BufferGeometry()
  out.setAttribute('position', new Float32BufferAttribute(pos, 3))
  out.setAttribute('normal', new Float32BufferAttribute(nor, 3))
  out.setAttribute('rig', new Float32BufferAttribute(rig, 3))
  out.setIndex(idx)
  return out
}

const box = (w: number, h: number, d: number, x: number, y: number, z: number) => new BoxGeometry(w, h, d).translate(x, y, z)
const cyl = (rt: number, rb: number, h: number, seg: number, x: number, y: number, z: number, open = false) =>
  new CylinderGeometry(rt, rb, h, seg, 1, open).translate(x, y, z)
const ball = (r: number, ws: number, hs: number, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1) =>
  new SphereGeometry(r, ws, hs).scale(sx, sy, sz).translate(x, y, z)
const capsule = (r: number, len: number, x: number, y: number, z: number) => new CapsuleGeometry(r, len, 3, 8).translate(x, y, z)
const lathe = (profile: [number, number][], depth: number) => new LatheGeometry(profile.map(([r, y]) => new Vector2(r, y)), 14).scale(1, 1, depth)
const hairCap = (r: number, y: number) => new SphereGeometry(r, 12, 6, 0, Math.PI * 2, 0, 1.3).scale(0.94, 1.1, 1.04).translate(0, y, -0.008)

// Torso silhouettes (radius, height), lathed then flattened front-to-back.
const MAN_TORSO: [number, number][] = [[0.001, 0.86], [0.16, 0.88], [0.165, 1.0], [0.158, 1.12], [0.172, 1.28], [0.205, 1.4], [0.19, 1.46], [0.1, 1.5], [0.06, 1.52], [0.001, 1.52]]
const WOMAN_TORSO: [number, number][] = [[0.001, 0.88], [0.158, 0.9], [0.145, 1.02], [0.128, 1.1], [0.152, 1.26], [0.175, 1.37], [0.165, 1.43], [0.09, 1.47], [0.052, 1.49], [0.001, 1.49]]

function detailedBody(variant: number): BufferGeometry {
  const woman = variant >= 2
  const skirt = variant === 3
  const p: Piece[] = []
  const legR = woman ? (skirt ? 0.06 : 0.068) : 0.074
  const legX = woman ? 0.088 : 0.095
  for (const [part, s] of [[PART.L_LEG, -1], [PART.R_LEG, 1]] as const) {
    p.push([cyl(legR, legR * 0.76, 0.84, 10, s * legX, 0.5, 0), part, skirt ? S.LEGWEAR : S.BOTTOM])
    p.push([woman ? box(0.085, 0.075, 0.23, s * legX, 0.038, 0.03) : box(0.105, 0.085, 0.27, s * legX, 0.043, 0.035), part, S.SHOES])
  }
  if (skirt) p.push([cyl(0.165, 0.228, 0.5, 16, 0, 0.66, 0, true), PART.TORSO, S.BOTTOM])
  p.push([lathe(woman ? WOMAN_TORSO : MAN_TORSO, woman ? 0.64 : 0.62), PART.TORSO, S.TOP])
  p.push([box(woman ? 0.11 : 0.12, woman ? 0.2 : 0.24, 0.012, 0, woman ? 1.36 : 1.37, woman ? 0.114 : 0.121), PART.TORSO, S.SHIRT])
  if (variant === 0) p.push([box(0.042, 0.3, 0.012, 0, 1.27, 0.128), PART.TORSO, S.ACCENT, O.TIE])

  const headY = woman ? 1.655 : 1.685
  p.push([cyl(woman ? 0.045 : 0.05, woman ? 0.05 : 0.056, 0.12, 8, 0, woman ? 1.53 : 1.55, 0), PART.HEAD, S.SKIN])
  p.push([ball(woman ? 0.095 : 0.1, 12, 9, 0, headY, 0.005, 0.92, 1.12, 1.0), PART.HEAD, S.SKIN])
  p.push([hairCap(woman ? 0.103 : 0.107, headY + 0.01), PART.HEAD, S.HAIR])
  if (woman) p.push([new CapsuleGeometry(0.085, 0.22, 3, 8).scale(1.15, 1, 0.55).translate(0, headY - 0.14, -0.055), PART.HEAD, S.HAIR, O.LONG_HAIR])
  p.push([box(0.17, 0.032, 0.012, 0, headY + 0.012, woman ? 0.094 : 0.1), PART.HEAD, S.FRAME, O.GLASSES])

  const armR = woman ? 0.041 : 0.047
  const armX = woman ? 0.212 : 0.228
  for (const [part, s] of [[PART.L_ARM, -1], [PART.R_ARM, 1]] as const) {
    p.push([capsule(armR, woman ? 0.44 : 0.46, s * armX, woman ? 1.18 : 1.19, 0), part, S.TOP])
    p.push([ball(woman ? 0.039 : 0.043, 8, 6, s * armX, woman ? 0.89 : 0.89, 0.01), part, S.SKIN])
  }
  p.push([woman ? box(0.1, 0.3, 0.34, 0.25, 0.8, 0) : box(0.085, 0.27, 0.38, 0.27, 0.73, 0), PART.R_ARM, S.PROP, O.BAG])
  p.push([cyl(0.034, 0.029, 0.11, 10, -armX, 0.85, 0.05), PART.L_ARM, S.PROP, O.CUP])
  return build(p)
}

function distantBody(variant: number): BufferGeometry {
  const woman = variant >= 2
  const skirt = variant === 3
  const p: Piece[] = []
  for (const [part, s] of [[PART.L_LEG, -1], [PART.R_LEG, 1]] as const) {
    p.push([box(0.13, 0.84, 0.16, s * 0.09, 0.5, 0), part, skirt ? S.LEGWEAR : S.BOTTOM])
    p.push([box(0.1, 0.08, 0.25, s * 0.09, 0.04, 0.03), part, S.SHOES])
  }
  if (skirt) p.push([box(0.36, 0.48, 0.28, 0, 0.66, 0), PART.TORSO, S.BOTTOM])
  p.push([box(woman ? 0.36 : 0.42, 0.62, 0.24, 0, 1.2, 0), PART.TORSO, S.TOP])
  p.push([box(0.12, 0.22, 0.01, 0, 1.37, 0.121), PART.TORSO, S.SHIRT])
  const headY = woman ? 1.655 : 1.685
  p.push([box(0.17, 0.23, 0.2, 0, headY, 0), PART.HEAD, S.SKIN])
  p.push([box(0.19, 0.07, 0.22, 0, headY + 0.12, -0.01), PART.HEAD, S.HAIR])
  if (woman) p.push([box(0.2, 0.3, 0.08, 0, headY - 0.1, -0.08), PART.HEAD, S.HAIR, O.LONG_HAIR])
  for (const [part, s] of [[PART.L_ARM, -1], [PART.R_ARM, 1]] as const) {
    p.push([box(0.09, 0.56, 0.1, s * (woman ? 0.21 : 0.23), 1.19, 0), part, S.TOP])
  }
  return build(p)
}

/**
 * One business-casual body of the same closed wardrobe as a plain geometry (its rig attribute rides along, unread by a
 * plain material): the detailed body of `variant` (VARIANT_NAMES order, clamped), or the distant one. For the page's
 * own ghosts of a network session's other players (07_Execute_Actions/netView.ts), which are poses drawn here and
 * never bodies in the physics realm.
 */
export function bodyGeometry(variant: number, detailed = true): BufferGeometry {
  const v = Number.isFinite(variant) ? Math.min(VARIANTS - 1, Math.max(0, Math.floor(variant))) : 0
  return detailed ? detailedBody(v) : distantBody(v)
}

// Shared by position (w = 1) and normal (w = 0) so both follow the same skeleton.
const rotX = wgslFn(`
fn agentRotX(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}`)
const rotAxis = wgslFn(`
fn agentRotAxis(v: vec3f, k: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return v * c + cross(k, v) * s + k * dot(k, v) * (1.0 - c);
}`)
const agentXform = wgslFn(`
fn agentXform(v: vec3f, w: f32, rig: vec3f, agent: vec4f, motion: vec4f, pose: vec4f, shape: vec4f, t: f32) -> vec3f {
  let part = i32(rig.x + 0.5);
  let opt = u32(rig.z + 0.5);
  let mask = u32(shape.z + 0.5);
  if (opt != 0u && ((mask >> opt) & 1u) == 0u) {
    return select(vec3f(0.0, 1.0, 0.0), agent.xyz, w > 0.5);
  }
  let swing = clamp(motion.w / 1.4, 0.0, 1.3);
  let phase = motion.z;
  let holdingCup = ((mask >> 3u) & 1u) == 1u;
  let carryingBag = ((mask >> 2u) & 1u) == 1u;
  var q = v;
  if (part == 0 || part == 1) {
    let side = select(-1.0, 1.0, part == 1);
    let piv = vec3f(side * 0.09, 0.92, 0.0) * w;
    q = agentRotX(q - piv, sin(phase + select(0.0, 3.14159, part == 1)) * 0.46 * swing) + piv;
  } else if (part == 4 || part == 5) {
    let side = select(-1.0, 1.0, part == 5);
    let piv = vec3f(side * 0.22, 1.44, 0.0) * w;
    var a = -sin(phase + select(0.0, 3.14159, part == 5)) * 0.38 * swing;
    if (part == 4 && holdingCup) { a = -0.95 + a * 0.2; }
    if (part == 5 && carryingBag) { a = a * 0.35; }
    q = agentRotX(q - piv, a) + piv;
  }
  // Idle weight shift while standing; staggers from the spring-damper pose on top.
  let idle = (1.0 - clamp(motion.w * 4.0, 0.0, 1.0)) * sin(t * 1.3 + shape.w * 6.28) * 0.03;
  let fall = pose.z - agent.w;
  let k = vec3f(cos(fall), 0.0, -sin(fall));
  if (part >= 2) {
    let hip = vec3f(0.0, 0.95, 0.0) * w;
    q = agentRotAxis(q - hip, k, pose.y + idle) + hip;
  }
  q = agentRotAxis(q, k, pose.x);
  if (w > 0.5) {
    q = vec3f(q.x * shape.y, q.y * shape.x, q.z * shape.y);
    q.y += abs(sin(phase)) * 0.03 * swing;
  }
  let ch = cos(agent.w);
  let sh = sin(agent.w);
  q = vec3f(q.x * ch + q.z * sh, q.y, -q.x * sh + q.z * ch);
  if (w < 0.5) { return q; }
  return q + agent.xyz;
}`, [rotX, rotAxis] as unknown as Parameters<typeof wgslFn>[1])
const xform = (...args: (Node | number)[]) => agentXform(...args) as unknown as V3

const hex = (list: number[]) => list.map((c) => new Color(c))
/**
 * three's TSL `hash` (nodes/math/Hash.js): PCG on the integer part of the seed, as the body material's h(k) runs it
 * on the GPU with seed = agent + k · 13.37 in f32. On the CPU it gives a promoted person's rig (07_Execute_Actions/
 * rigView.ts) the colour the crowd gives their figure.
 */
function tslHash(seed: number): number {
  const state = (Math.imul(Math.trunc(seed) >>> 0, 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0
  return (((word >>> 22) ^ word) >>> 0) / 2 ** 32
}
/** The body variant of an agent whose look is not worn (crowd.wgsl cull: the index's). */
export const variantOf = (agent: number): number => ((agent % VARIANTS) + VARIANTS) % VARIANTS
/**
 * The colour of the top (the suit, blazer or top) the crowd's material gives agent `agent`'s own body, linear RGB
 * 0..1, as the material picks it (h(3) of the variant's list; a worn look may differ: look.ts).
 */
export function attireColour(agent: number): [number, number, number] {
  const h = (k: number): number => tslHash(Math.fround(agent + Math.fround(k * 13.37)))
  const variant = variantOf(agent)
  const list = variant === 0 ? PALETTE.suits : variant === 1 ? PALETTE.blazers : variant === 2 ? PALETTE.womenBlazers : PALETTE.womenTops
  const c = list[Math.min(list.length - 1, Math.floor(Math.fround(h(3) * (list.length - 0.001))))]
  return [c.r, c.g, c.b]
}
const PALETTE = {
  skin: hex([0xf3d2b8, 0xe8b894, 0xd29f79, 0xb97f5a, 0x9a6444, 0x7a4a31, 0x5c3522, 0xe5c0a0]),
  hair: hex([0x1b1512, 0x2a1d14, 0x3b2618, 0x5e3c24, 0x7a3a1f, 0xb8935a, 0x8a6a48, 0x9c9a96]),
  suits: hex([0x1f2a44, 0x33363b, 0x5b6068, 0x1a1a1c, 0x4a3b2e, 0x2d4a73, 0x3d4550]),
  blazers: hex([0x9c7a54, 0x243352, 0x6e7278, 0x5a5e3f, 0x5e2530, 0xd8cfbf, 0x44464a]),
  chinos: hex([0xb09a74, 0x6a6d70, 0x2a3448, 0x222222, 0xcfc6b2, 0x6b5a45]),
  shirts: hex([0xf2f2ef, 0xc8d8ec, 0xecd4d8, 0xd6d0e6, 0xdadcde, 0xe9ecf2]),
  casualShirts: hex([0xf2f2ef, 0x9fb7d6, 0xd9c7a8, 0x2e3a4a, 0xb9c4b0, 0xe0e0e0]),
  ties: hex([0x1c2c4c, 0x6a1e2a, 0x234a36, 0x55585c, 0x3a5f9a, 0x2b2b2e]),
  womenBlazers: hex([0x1f2a44, 0x2a2a2d, 0x8a2f3a, 0xe8e2d6, 0x6b7a8f, 0xb58b63, 0x3f5e5a]),
  womenTops: hex([0xe8e2d6, 0x1f2a44, 0x7d4e57, 0x5f6f82, 0xc8a27a, 0x2a2a2d]),
  darkTrousers: hex([0x1c1c1e, 0x2a3040, 0x3a3c40]),
  blouses: hex([0xf5f2ea, 0xefe6d2, 0xd2e6dc, 0xe8a894, 0xc9d6ea, 0xe7c9d3]),
  skirts: hex([0x1f2a44, 0x33363b, 0x1a1a1c, 0x5e2530, 0x9c7a54, 0x6e7278]),
  menShoes: hex([0x141414, 0x3a2618, 0x2a1a12]),
  casualShoes: hex([0x3a2618, 0x7a5230, 0x5a4636, 0x1c1c1c]),
  womenShoes: hex([0x141414, 0x3e1a1c, 0x7a5230, 0x2a2a3a]),
  bags: hex([0x1c1712, 0x4a2e1c, 0x2a2a2a, 0x6a4a30]),
}

function agentBuffers(view: CrowdView, agentCount: number, listLength: number) {
  return {
    pos: storage(view.pos, 'vec4', agentCount).toReadOnly(),
    vel: storage(view.vel, 'vec4', agentCount).toReadOnly(),
    pose: storage(view.pose, 'vec4', agentCount).toReadOnly(),
    dissolve: storage(view.dissolve, 'float', agentCount).toReadOnly(),
    look: storage(view.look, 'uint', agentCount).toReadOnly(),
    lists: storage(view.drawLists, 'uint', listLength).toReadOnly(),
  }
}
type AgentBuffers = ReturnType<typeof agentBuffers>

export class CrowdView {
  readonly pos: StorageBufferAttribute
  readonly vel: StorageBufferAttribute
  readonly pose: StorageBufferAttribute
  readonly drawLists: StorageBufferAttribute
  /**
   * The code dissolve's amounts (codeDissolve.ts; 0 solid, 1 gone), one float per agent: the engine writes them (by
   * gpuBufferOf + queue.writeBuffer, the frame upload's path) when the user's body is inside a pedestrian. Page-only:
   * crowd.wgsl never binds it, no pedestrian moves for it.
   */
  readonly dissolve: StorageBufferAttribute
  /**
   * The look word per agent (look.ts packLook; LOOK_NONE = 0 dresses them as the hash does), one u32 per agent: the
   * engine writes it the way it writes the dissolve amounts (gpuBufferOf + queue.writeBuffer). Page-only: the worker's
   * passes never bind it, no pedestrian moves for it; the page's cull reads it for the body to draw.
   */
  readonly look: StorageBufferAttribute
  readonly drawArgs: IndirectStorageBufferAttribute
  /** Initial indirect args (index counts, zero instances); reset into the GPU buffer every frame. */
  readonly drawTemplate: Uint32Array<ArrayBuffer>
  readonly meshes: InstancedMesh[] = []
  /**
   * Seconds since the previous presented frame. A pass that writes motion vectors (the cinema camera's velocity
   * buffer) places each vertex's previous position that far back along the pedestrian's own velocity: the instance
   * matrices are identity, so three's matrix history would put everyone's previous position at the origin.
   */
  readonly frameSeconds: UniformNode<'float', number> = uniform(0)

  constructor(agentCount: number) {
    const quota = agentQuota(agentCount)
    this.pos = new StorageBufferAttribute(new Float32Array(agentCount * 4), 4)
    this.vel = new StorageBufferAttribute(new Float32Array(agentCount * 4), 4)
    this.pose = new StorageBufferAttribute(new Float32Array(agentCount * 4), 4)
    this.drawLists = new StorageBufferAttribute(new Uint32Array(quota * VARIANTS * 2), 1)
    this.dissolve = new StorageBufferAttribute(new Float32Array(agentCount), 1)
    this.look = new StorageBufferAttribute(new Uint32Array(agentCount), 1)
    this.drawTemplate = new Uint32Array(VARIANTS * 2 * 5)
    this.pos.name = 'crowd.pos'
    this.vel.name = 'crowd.vel'
    this.pose.name = 'crowd.pose'
    this.drawLists.name = 'crowd.drawLists'
    this.dissolve.name = 'crowd.dissolve'
    this.look.name = 'crowd.look'

    const geometries: BufferGeometry[] = []
    for (let lod = 0; lod < 2; lod++) {
      for (let v = 0; v < VARIANTS; v++) {
        const g = lod === 0 ? detailedBody(v) : distantBody(v)
        this.drawTemplate[(lod * VARIANTS + v) * 5] = g.index!.count
        geometries.push(g)
      }
    }
    this.drawArgs = new IndirectStorageBufferAttribute(this.drawTemplate.slice(), 1)
    this.drawArgs.name = 'crowd.drawArgs'

    const buffers = agentBuffers(this, agentCount, quota * VARIANTS * 2)
    geometries.forEach((g, d) => {
      const lod = Math.floor(d / VARIANTS)
      const v = d % VARIANTS
      g.setIndirect(this.drawArgs, d * 20)
      const mesh = new InstancedMesh(g, this.material(buffers, lod * quota * VARIANTS + v * quota, v), quota)
      // Instance matrices stay identity: placement comes from the storage buffers and culling is
      // done on the GPU, so the CPU-side bounds must be ignored.
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = `People.${VARIANT_NAMES[v]}.lod${lod}`
      this.meshes.push(mesh)
    })
  }

  private material(b: AgentBuffers, listBase: number, variant: number): MeshStandardNodeMaterial {
    const vSeed = varyingProperty('float', 'vAgentSeed')
    const vDissolve = varyingProperty('float', 'vAgentDissolve')
    // The look word, to the fragment stage as two float varyings (its low and high 16 bits: an integer varying would
    // need flat interpolation, and 32 bits exceed a float's mantissa); every vertex of a body carries the same value.
    const vLookLo = varyingProperty('float', 'vAgentLookLo')
    const vLookHi = varyingProperty('float', 'vAgentLookHi')
    const woman = variant >= 2
    const heightScale = woman ? LOOK_SCALE.heightWoman : LOOK_SCALE.heightMan
    const m = new MeshStandardNodeMaterial()
    // One pose, built twice: for the eye (which folds away the body it looks out of) and for the shadow map.
    const posed = (eye: boolean) => Fn((builder: NodeBuilder) => {
      const agentIndex = b.lists.element(instanceIndex.add(uint(listBase)))
      const agent = b.pos.element(agentIndex)
      const motion = b.vel.element(agentIndex)
      const pose = b.pose.element(agentIndex)
      const dissolve = b.dissolve.element(agentIndex)
      const word = b.look.element(agentIndex)
      const seed = float(agentIndex)
      const h = (k: number) => hash(seed.add(k * 13.37))
      // Per-person accessories (bit per optional piece) and proportions, as the hash gives them.
      const tie = step(0.3, h(1)).mul(2)
      const bag = step(woman ? 0.62 : 0.7, h(2)).mul(4)
      const cup = step(0.82, h(3)).mul(8)
      const longHair = step(0.35, h(4)).mul(16)
      const glasses = step(0.78, h(5)).mul(32)
      const hashedMask = tie.add(bag).add(cup).add(longHair).add(glasses)
      const hashedHeight = woman ? h(6).mul(0.1).add(0.92) : h(6).mul(0.14).add(0.94)
      const hashedWidth = h(7).mul(0.14).add(0.94)
      // A chosen look (look.ts: bit 0 set) overrides them: its pieces sit where agentXform tests them ((word >> 2) & 62 is
      // the mask), its height and build steps span the same range the hash does for this body.
      const custom = word.bitAnd(uint(1)).equal(uint(1))
      const stepOf = (slot: LookSlot) => float(word.shiftRight(uint(LOOK_FIELD[slot][0])).bitAnd(uint((1 << LOOK_FIELD[slot][1]) - 1))).div(WARDROBE.steps - 1)
      const mask = select(custom, float(word.shiftRight(uint(2)).bitAnd(uint(62))), hashedMask)
      const height = select(custom, stepOf('height').mul(heightScale.range).add(heightScale.base), hashedHeight)
      const width = select(custom, stepOf('build').mul(LOOK_SCALE.build.range).add(LOOK_SCALE.build.base), hashedWidth)
      const shape = vec4(height, width, mask, h(8))
      const rig = attribute('rig', 'vec3')
      normalLocal.assign(xform(normalLocal, float(0), rig, agent, motion, pose, shape, time).normalize())
      vSeed.assign(seed)
      vLookLo.assign(float(word.bitAnd(uint(0xffff))))
      vLookHi.assign(float(word.shiftRight(uint(16))))
      // The fragment stage reads the code dissolve's amount from this varying (both passes: the shadow map drops the
      // same cells).
      vDissolve.assign(dissolve)
      const body = xform(positionLocal, float(1), rig, agent, motion, pose, shape, time)
      if (!eye) return body
      // Every vertex on one point: zero-area triangles, nothing rasterised. A body gone to code folds the same way,
      // here where its amount is read (the fold applyCodeDissolve wraps over this reads the varying, which this stage
      // writes only here, so that one never fires for a pedestrian: this one is the fold that acts).
      const head = agent.xyz.add(vec3(0, OWN_BODY.height, 0))
      const inside = agentIndex.equal(uint(PLAYER_INDEX)).and(cameraPosition.distance(head).lessThan(OWN_BODY.radius))
      const gone = dissolve.greaterThanEqual(CODE_DISSOLVE.fold)
      const placed = select(inside.or(gone), agent.xyz, body)
      // Only a pass with a velocity target asks for the previous frame (the shadow map and ?cinema=0 never do).
      if (needsPrevious(builder)) positionPrevious.assign(placed.sub(vec3(motion.x, 0, motion.y).mul(this.frameSeconds)))
      return placed
    })()
    m.positionNode = posed(true)
    m.castShadowPositionNode = posed(false)

    const rig = attribute('rig', 'vec3')
    const slot = rig.y
    const h = (k: number): F1 => hash(vSeed.add(k * 7.919))
    // Colour lists on the GPU, one uniform array per palette however many slots read it.
    const arrays = new Map<Color[], ReturnType<typeof uniformArray>>()
    const colours = (list: Color[]) => arrays.get(list) ?? (arrays.set(list, uniformArray(list, 'color')), arrays.get(list)!)
    const pick = (list: Color[], hk: F1): V3 => colours(list).element(uint(hk.mul(list.length - 0.001))) as unknown as V3
    const skin = pick(PALETTE.skin, h(1))
    const hair = mix(pick(PALETTE.hair, h(2)), vec3(0.6, 0.6, 0.58), step(0.9, h(9)))
    let top: V3, bottom: V3, shirt: V3, shoes: V3
    if (variant === 0) {
      top = pick(PALETTE.suits, h(3)); bottom = top; shirt = pick(PALETTE.shirts, h(4)); shoes = pick(PALETTE.menShoes, h(6))
    } else if (variant === 1) {
      top = pick(PALETTE.blazers, h(3)); bottom = pick(PALETTE.chinos, h(4)); shirt = pick(PALETTE.casualShirts, h(5)); shoes = pick(PALETTE.casualShoes, h(6))
    } else if (variant === 2) {
      top = pick(PALETTE.womenBlazers, h(3)); bottom = mix(top, pick(PALETTE.darkTrousers, h(4)), step(0.6, h(10)))
      shirt = pick(PALETTE.blouses, h(5)); shoes = pick(PALETTE.womenShoes, h(6))
    } else {
      top = pick(PALETTE.womenTops, h(3)); bottom = pick(PALETTE.skirts, h(4)); shirt = pick(PALETTE.blouses, h(5)); shoes = pick(PALETTE.womenShoes, h(6))
    }
    // A chosen look (the word again, whole: both halves are exact in a float) replaces the hash's picks slot by slot
    // with its option out of the same palettes (look.ts WARDROBE: this body's cloths), each index bounded to its list.
    // The tie's cloth, the bag's leather and the skirt suit's hose stay the hash's: the word has no room for them.
    const word = uint(vLookHi.add(0.5)).shiftLeft(uint(16)).bitOr(uint(vLookLo.add(0.5)))
    const custom = word.bitAnd(uint(1)).equal(uint(1))
    const field = (s: LookSlot): U1 => word.shiftRight(uint(LOOK_FIELD[s][0])).bitAnd(uint((1 << LOOK_FIELD[s][1]) - 1))
    const at = (list: Color[], i: U1): V3 => {
      const last = uint(list.length - 1)
      return colours(list).element(select(i.lessThan(last), i, last)) as unknown as V3
    }
    const outfit = WARDROBE.outfits[variant]
    const cloth = (name: PaletteName): Color[] => PALETTE[name]
    const grey = vec3(0.6, 0.6, 0.58)
    const hairAt = field('hairColour')
    const ownSkin = at(PALETTE.skin, field('skin'))
    const ownHair = select(hairAt.greaterThanEqual(uint(PALETTE.hair.length)), grey, at(PALETTE.hair, hairAt))
    const ownTop = at(cloth(outfit.top), field('top'))
    // Trousers that may match the jacket (option 0 of a matching outfit): the cloth at i - 1 otherwise.
    const bottomAt = field('bottom')
    const ownBottom = outfit.matching
      ? select(bottomAt.equal(uint(0)), ownTop, at(cloth(outfit.bottom), select(bottomAt.equal(uint(0)), uint(0), bottomAt.sub(uint(1)))))
      : at(cloth(outfit.bottom), bottomAt)
    const ownShirt = at(cloth(outfit.shirt), field('shirt'))
    const ownShoes = at(cloth(outfit.shoes), field('shoes'))
    const wornSkin = select(custom, ownSkin, skin)
    const wornHair = select(custom, ownHair, hair)
    top = select(custom, ownTop, top)
    bottom = select(custom, ownBottom, bottom)
    shirt = select(custom, ownShirt, shirt)
    shoes = select(custom, ownShoes, shoes)
    // The suit's tie keeps the hash's cloth; the other bodies' accent is the shirt. The skirt suit's hose is the hash's.
    const accent = variant === 0 ? pick(PALETTE.ties, h(5)) : shirt
    const legwear = variant === 3 ? mix(wornSkin, vec3(0.08, 0.07, 0.07), step(0.55, h(11))) : bottom
    const prop = select(rig.z.greaterThan(2.5), vec3(0.93, 0.92, 0.9), pick(PALETTE.bags, h(12)))
    const frame = vec3(0.05, 0.05, 0.055)
    const slots: V3[] = [top, shirt, wornSkin, wornHair, bottom, shoes, accent, prop, legwear, frame]
    const rough = [0.82, 0.7, 0.55, 0.6, 0.8, 0.35, 0.6, 0.45, 0.6, 0.3]
    let color: V3 = slots[slots.length - 1]
    let roughness: F1 = float(rough[rough.length - 1])
    for (let s = slots.length - 2; s >= 0; s--) {
      color = select(slot.lessThan(s + 0.5), slots[s], color)
      roughness = select(slot.lessThan(s + 0.5), float(rough[s]), roughness)
    }
    m.colorNode = color
    m.roughnessNode = roughness
    m.metalnessNode = float(0)
    // The code dissolve, over everything above, with the body's feet as its origin (fresh reads: nothing of posed()'s
    // graph is shared across the fold's branches).
    const feet = b.pos.element(b.lists.element(instanceIndex.add(uint(listBase)))).xyz
    applyCodeDissolve(m, vDissolve, feet, PEOPLE_DISSOLVE_INK)
    return m
  }
}
