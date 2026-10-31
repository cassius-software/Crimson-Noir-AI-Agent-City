// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the crowd's render side: four business-casual bodies (suit, smart casual,
 * pantsuit, skirt suit), each one smooth humanoid lofted by humanoid.ts over fifteen bones at two levels of detail,
 * eight InstancedMesh arrays fed by GPU-compacted indirect draws, per-person attire and accessories chosen from
 * hashed palettes, and the vertex stage (crowdBody.ts: the sliders' reshaping, the walk's joints, two-bone skinning)
 * that poses each body from GPU state — including the player's own body, which the first-person eye never sees from
 * inside but whose shadow still walks beside them. The state it poses them from arrives from the physics worker,
 * which alone simulates the pedestrians (crowdSim.ts); the page writes each frame into these buffers and culls it
 * (crowdCull.ts). A person's look is hashed from their index unless the page's per-agent look word (look.ts, one
 * u32 in `crowd.look`) names one: then its bits choose the pieces, every colour slot, the age and the skin's
 * undertone, and the pair of words beside it (`crowd.figure`: the figure word and the face word) the eight body
 * sliders, the seven face sliders and the hair style, in place of the hash (the body itself is chosen from the look
 * word in the cull, crowd.wgsl), so the player and a recruit can wear what they chose. The face (the brow, the nose,
 * the eyes, the lips, the ears) is drawn by the eye pass of the near body alone: the shadow pass and the far body
 * leave it out.
 * What breaks if it is removed? No pedestrian is drawn, and the worker's frames have nowhere to land.
 */
import {
  BufferGeometry, Color, Float32BufferAttribute, IndirectStorageBufferAttribute, InstancedMesh, MeshStandardNodeMaterial,
  StorageBufferAttribute, Uint32BufferAttribute, type Node, type NodeBuilder, type UniformNode, type Vector4,
} from 'three/webgpu'
import {
  Fn, If, attribute, cameraPosition, dot, float, hash, instanceIndex, mix, normalLocal, positionLocal, positionPrevious, select,
  smoothstep, step, storage, time, uint, uniform, uniformArray, varyingProperty, vec3, vec4,
} from 'three/tsl'
import { CODE_DISSOLVE, applyCodeDissolve } from '../01_Initialize_World/codeDissolve.ts'
import { applyMatrixMode } from '../01_Initialize_World/matrixMode.ts'
import { bodyVertex } from './crowdBody.ts'
import { PLAYER_INDEX, VARIANTS, agentQuota } from './crowdCompute.ts'
import { BODY_NAMES, BONE, HEIGHT_BASE, PIECE, humanoidMesh, type HumanoidMesh } from './humanoid.ts'
import {
  HAIR, LOOK_FIELD, LOOK_HASHED_COLOUR, LOOK_HASHED_FACE, LOOK_HASHED_HAIR_SPLIT, LOOK_HASHED_SLIDER, LOOK_ODDS, LOOK_PIECE_BIT,
  LOOK_SLIDER_MIDDLE, LOOK_STATURE, WARDROBE, type LookFaceSlider, type LookSlider, type LookSlot, type PaletteName,
} from './look.ts'

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
/** A 3×3 matrix node as crowdBody.ts returns one (a column per element), held in a variable so the call runs once. */
type Mat3 = { toVar(): Mat3; element(column: U1): V3 }

/** Whether the pass being built writes motion vectors (three's builder knows; its typings leave the method out). */
const needsPrevious = (b: NodeBuilder): boolean => (b as NodeBuilder & { needsPreviousData(): boolean }).needsPreviousData()

export const VARIANT_NAMES = BODY_NAMES

/**
 * The arrays of one humanoid (humanoid.ts) as the geometry the crowd draws: position, normal, `rig`, `skin`, `face`,
 * indexed. Every body carries `face` (zero off the head, and everywhere on the far body): a material that reads an
 * attribute a geometry lacks cannot build its pipeline.
 */
function geometryOf(mesh: HumanoidMesh): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new Float32BufferAttribute(mesh.position, 3))
  g.setAttribute('normal', new Float32BufferAttribute(mesh.normal, 3))
  g.setAttribute('rig', new Float32BufferAttribute(mesh.rig, 3))
  g.setAttribute('skin', new Float32BufferAttribute(mesh.skin, 2))
  g.setAttribute('face', new Float32BufferAttribute(mesh.face, 2))
  g.setIndex(new Uint32BufferAttribute(mesh.index, 1))
  return g
}

/**
 * One business-casual body of the same closed wardrobe as a plain geometry (its rig and skin attributes ride along,
 * unread by a plain material, so it stands in its rest pose: arms at its sides): the detailed body of `variant`
 * (VARIANT_NAMES order, clamped), or the distant one. For the page's own ghosts of a network session's other players
 * (07_Execute_Actions/netView.ts), which are poses drawn here and never bodies in the physics realm.
 */
export function bodyGeometry(variant: number, detailed = true): BufferGeometry {
  const v = Number.isFinite(variant) ? Math.min(VARIANTS - 1, Math.max(0, Math.floor(variant))) : 0
  return geometryOf(humanoidMesh(v, detailed))
}

/** Metres per step of the height slider (look.ts WARDROBE.stature). */
const STATURE_STEP = (WARDROBE.stature.max - WARDROBE.stature.min) / (WARDROBE.stature.steps - 1)

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
  iris: hex([0x3b2314, 0x5a3a22, 0x2a1a12, 0x4a6a4a, 0x5a7a9a, 0x7a5a3a]),
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
    figure: storage(view.figure, 'uvec2', agentCount).toReadOnly(),
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
  /**
   * The figure word and the face word per agent (look.ts packFigure: the eight body sliders' steps; packFace: the
   * seven face sliders' steps and the hair style; read only where the look word says a look is worn), one pair of u32
   * per agent, written beside the look word. Page-only like it: the worker's passes never bind it, the cull never
   * reads it, no pedestrian moves for it. One buffer for the pair: the vertex stage binds seven storage buffers
   * already, of the eight WebGPU promises every device.
   */
  readonly figure: StorageBufferAttribute
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

  /** The page's global-state uniform (01_Initialize_World/matrixMode.ts); null, the bodies have no matrix mode. */
  private readonly matrixMode: UniformNode<'vec4', Vector4> | null

  constructor(agentCount: number, matrixMode: UniformNode<'vec4', Vector4> | null = null) {
    this.matrixMode = matrixMode
    const quota = agentQuota(agentCount)
    this.pos = new StorageBufferAttribute(new Float32Array(agentCount * 4), 4)
    this.vel = new StorageBufferAttribute(new Float32Array(agentCount * 4), 4)
    this.pose = new StorageBufferAttribute(new Float32Array(agentCount * 4), 4)
    this.drawLists = new StorageBufferAttribute(new Uint32Array(quota * VARIANTS * 2), 1)
    this.dissolve = new StorageBufferAttribute(new Float32Array(agentCount), 1)
    this.look = new StorageBufferAttribute(new Uint32Array(agentCount), 1)
    this.figure = new StorageBufferAttribute(new Uint32Array(agentCount * 2), 2)
    this.drawTemplate = new Uint32Array(VARIANTS * 2 * 5)
    this.pos.name = 'crowd.pos'
    this.vel.name = 'crowd.vel'
    this.pose.name = 'crowd.pose'
    this.drawLists.name = 'crowd.drawLists'
    this.dissolve.name = 'crowd.dissolve'
    this.look.name = 'crowd.look'
    this.figure.name = 'crowd.figure'

    const geometries: BufferGeometry[] = []
    for (let lod = 0; lod < 2; lod++) {
      for (let v = 0; v < VARIANTS; v++) {
        const g = bodyGeometry(v, lod === 0)
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
      const mesh = new InstancedMesh(g, this.material(buffers, lod * quota * VARIANTS + v * quota, v, lod === 0), quota)
      // Instance matrices stay identity: placement comes from the storage buffers and culling is
      // done on the GPU, so the CPU-side bounds must be ignored. Every body can hold the whole crowd (agentQuota),
      // so the eight meshes share one identity matrix buffer rather than eight.
      if (this.meshes.length > 0) mesh.instanceMatrix = this.meshes[0].instanceMatrix
      mesh.frustumCulled = false
      mesh.castShadow = true
      mesh.receiveShadow = true
      mesh.name = `People.${VARIANT_NAMES[v]}.lod${lod}`
      this.meshes.push(mesh)
    })
  }

  /** The material of one body: `near` is the detailed body, the only one with a face to shape and to draw. */
  private material(b: AgentBuffers, listBase: number, variant: number, near: boolean): MeshStandardNodeMaterial {
    const vSeed = varyingProperty('float', 'vAgentSeed')
    const vDissolve = varyingProperty('float', 'vAgentDissolve')
    // The look word, to the fragment stage as two float varyings (its low and high 16 bits: an integer varying would
    // need flat interpolation, and 32 bits exceed a float's mantissa); every vertex of a body carries the same value.
    const vLookLo = varyingProperty('float', 'vAgentLookLo')
    const vLookHi = varyingProperty('float', 'vAgentLookHi')
    const woman = variant >= 2
    const m = new MeshStandardNodeMaterial()
    // One pose, built twice: for the eye (which folds away the body it looks out of) and for the shadow map.
    const posed = (eye: boolean) => Fn((builder: NodeBuilder) => {
      const agentIndex = b.lists.element(instanceIndex.add(uint(listBase)))
      const agent = b.pos.element(agentIndex)
      const motion = b.vel.element(agentIndex)
      const pose = b.pose.element(agentIndex)
      const dissolve = b.dissolve.element(agentIndex)
      const word = b.look.element(agentIndex)
      const pair = b.figure.element(agentIndex)
      const figure = pair.x
      const faceWord = pair.y
      const seed = float(agentIndex)
      const h = (k: number) => hash(seed.add(k * 13.37))
      // Per-person accessories (bit per optional piece), as the hash gives them.
      const tie = step(0.3, h(1)).mul(2)
      const bag = step(woman ? 0.62 : 0.7, h(2)).mul(4)
      const cup = step(0.82, h(3)).mul(8)
      const glasses = step(0.78, h(5)).mul(32)
      const hashedMask = tie.add(bag).add(cup).add(glasses)
      // The hair the hash gives (look.ts lookFromSeed splits it the same way): short under the long-hair odds on link
      // 4, under the cap every style wears; otherwise a woman's split link makes it long, a bob or a bun, and a man's
      // makes a few bald (no cap, no length), the rest long.
      const notShort = step(LOOK_ODDS.longHair, h(4))
      const split = h(LOOK_HASHED_HAIR_SPLIT)
      const past = (edge: number) => step(edge, split)
      const hashedGrooms = woman
        ? float(64).add(notShort.mul(past(LOOK_ODDS.bob).oneMinus()).mul(16)).add(notShort.mul(past(LOOK_ODDS.bob)).mul(past(LOOK_ODDS.bun).oneMinus()).mul(128)).add(notShort.mul(past(LOOK_ODDS.bun)).mul(256))
        : past(LOOK_ODDS.bald).oneMinus().mul(float(64).add(notShort.mul(16)))
      // The figure the hash gives, in the sliders' own steps (look.ts lookFromSeed rounds the same links the same way):
      // the stature from this body's range of the height slider, every other slider over its whole range.
      const stature = woman ? LOOK_STATURE.woman : LOOK_STATURE.man
      const hashedStep = (k: number, n: number) => h(k).mul(n).add(0.5).floor()
      const hashedHeight = hashedStep(6, stature.span).add(stature.from)
      // A chosen look (look.ts: bit 0 set) overrides them: its tie, bag, cup and glasses sit where bodyVertex tests them
      // ((word >> 2) & 46 is their part of the mask), its hair style (the face word's) gives the hair's pieces as
      // look.ts hairBits gives them, its figure word holds the eight body sliders' steps and its face word the seven
      // face sliders' (look.ts LOOK_FIELD names each one's word and bits).
      const custom = word.bitAnd(uint(1)).equal(uint(1))
      const stepOf = (slot: LookSlot) => {
        const [w, shift, width] = LOOK_FIELD[slot]
        return float((w === 0 ? word : w === 1 ? figure : faceWord).shiftRight(uint(shift)).bitAnd(uint((1 << width) - 1)))
      }
      const style = faceWord.shiftRight(uint(LOOK_FIELD.hairStyle[1])).bitAnd(uint(7))
      const styled = (s: number, bit: number) => select(style.equal(uint(s)), float(1 << bit), float(0))
      const ownGrooms = styled(HAIR.long, LOOK_PIECE_BIT.longHair)
        .add(select(style.equal(uint(HAIR.bald)), float(0), float(1 << LOOK_PIECE_BIT.hairCap)))
        .add(styled(HAIR.bob, LOOK_PIECE_BIT.bob))
        .add(styled(HAIR.bun, LOOK_PIECE_BIT.bun))
      // The eye pass alone draws the face's features (their piece bit): the shadow map does without them.
      const features = eye ? 1 << LOOK_PIECE_BIT.face : 0
      const mask = select(custom, float(word.shiftRight(uint(2)).bitAnd(uint(46))).add(ownGrooms), hashedMask.add(hashedGrooms)).add(features)
      const slider = (slot: Exclude<LookSlider, 'height'>) => {
        const n = (slot === 'head' ? WARDROBE.headSteps : WARDROBE.sliderSteps) - 1
        return select(custom, stepOf(slot), hashedStep(LOOK_HASHED_SLIDER[slot], n)).div(n)
      }
      const height = select(custom, stepOf('height'), hashedHeight).mul(STATURE_STEP).add(WARDROBE.stature.min).div(HEIGHT_BASE)
      const stance = vec4(height, mask, h(8), 0)
      const morphA = vec4(slider('mass'), slider('muscle'), slider('shoulders'), slider('hips'))
      const morphB = vec4(slider('legs'), slider('posture'), slider('head'), 0)
      const rig = attribute('rig', 'vec3')
      const skin = attribute('skin', 'vec2')
      const face = attribute('face', 'vec2')
      // The face sliders, -1..1 about the base face (step 8 of 16: look.ts faceValue), for the near body's head alone
      // (rig.x is the bone): the far body has no features to shape, and no other bone reads them.
      const faceStep = (slot: LookFaceSlider) =>
        select(custom, stepOf(slot), hashedStep(LOOK_HASHED_FACE[slot], WARDROBE.sliderSteps - 1)).sub(LOOK_SLIDER_MIDDLE.slider).div(LOOK_SLIDER_MIDDLE.slider)
      const faceA = vec4(0).toVar()
      const faceB = vec4(0).toVar()
      if (near) {
        If(rig.x.greaterThan(BONE.HEAD - 0.5).and(rig.x.lessThan(BONE.HEAD + 0.5)), () => {
          faceA.assign(vec4(faceStep('brow'), faceStep('jaw'), faceStep('chin'), faceStep('cheek')))
          faceB.assign(vec4(faceStep('nose'), faceStep('eyes'), faceStep('lips'), 0))
        })
      }
      // The skin (crowdBody.ts): one call gives the posed position (column 0) and its normal (column 1).
      const skinned = (bodyVertex(positionLocal, normalLocal, rig, skin, face, agent, motion, pose, stance, morphA, morphB, faceA, faceB, time) as unknown as Mat3).toVar()
      normalLocal.assign(skinned.element(uint(1)))
      vSeed.assign(seed)
      vLookLo.assign(float(word.bitAnd(uint(0xffff))))
      vLookHi.assign(float(word.shiftRight(uint(16))))
      // The fragment stage reads the code dissolve's amount from this varying (both passes: the shadow map drops the
      // same cells).
      vDissolve.assign(dissolve)
      const body = skinned.element(uint(0))
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
    const field = (s: LookSlot): U1 => word.shiftRight(uint(LOOK_FIELD[s][1])).bitAnd(uint((1 << LOOK_FIELD[s][2]) - 1))
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
    const pickedSkin = select(custom, ownSkin, skin)
    const pickedHair = select(custom, ownHair, hair)
    // The age (eight steps) and the skin's undertone (look.ts WARDROBE.undertone: neutral, warm, cool, olive), the look
    // word's or the fragment chain's (lookFromSeed draws them from the same links the same way): the undertone tints
    // the skin in linear RGB, the age fades it a little toward its own grey and greys the hair past the slider's middle.
    const age = select(custom, float(field('age')), h(LOOK_HASHED_COLOUR.age).mul(WARDROBE.ageSteps - 1).add(0.5).floor()).div(WARDROBE.ageSteps - 1)
    const tone = select(custom, field('undertone'), uint(h(LOOK_HASHED_COLOUR.undertone).mul(WARDROBE.undertone.length - 0.001)))
    const tint = select(tone.equal(uint(1)), vec3(1.04, 1.0, 0.94), select(tone.equal(uint(2)), vec3(0.97, 0.99, 1.05), select(tone.equal(uint(3)), vec3(0.98, 1.02, 0.92), vec3(1, 1, 1))))
    const toned = pickedSkin.mul(tint)
    const wornSkin = mix(toned, vec3(dot(toned, vec3(0.2126, 0.7152, 0.0722))), age.mul(0.25))
    const wornHair = mix(pickedHair, grey, smoothstep(0.5, 1, age))
    top = select(custom, ownTop, top)
    bottom = select(custom, ownBottom, bottom)
    shirt = select(custom, ownShirt, shirt)
    shoes = select(custom, ownShoes, shoes)
    // The suit's tie keeps the hash's cloth; the other bodies' accent is the shirt. The skirt suit's hose is the hash's.
    const accent = variant === 0 ? pick(PALETTE.ties, h(5)) : shirt
    const legwear = variant === 3 ? mix(wornSkin, vec3(0.08, 0.07, 0.07), step(0.55, h(11))) : bottom
    const prop = select(rig.z.greaterThan(PIECE.CUP - 0.5), vec3(0.93, 0.92, 0.9), pick(PALETTE.bags, h(12)))
    const frame = vec3(0.05, 0.05, 0.055)
    // The eyes: their whites, an iris the hash picks (the words have no room for it), and the lips a shade of the skin.
    const white = vec3(0.88, 0.86, 0.84)
    const iris = pick(PALETTE.iris, h(LOOK_HASHED_COLOUR.iris))
    const lip = wornSkin.mul(vec3(0.82, 0.55, 0.55))
    const slots: V3[] = [top, shirt, wornSkin, wornHair, bottom, shoes, accent, prop, legwear, frame, white, iris, lip]
    const rough = [0.82, 0.7, 0.55, 0.6, 0.8, 0.35, 0.6, 0.45, 0.6, 0.3, 0.25, 0.3, 0.5]
    let color: V3 = slots[slots.length - 1]
    let roughness: F1 = float(rough[rough.length - 1])
    for (let s = slots.length - 2; s >= 0; s--) {
      color = select(slot.lessThan(s + 0.5), slots[s], color)
      roughness = select(slot.lessThan(s + 0.5), float(rough[s]), roughness)
    }
    m.colorNode = color
    m.roughnessNode = roughness
    m.metalnessNode = float(0)
    // Matrix mode (matrixMode.ts), over the body's own colour; the dissolve below reads the dimmed colour as its base.
    if (this.matrixMode) applyMatrixMode(m, this.matrixMode)
    // The code dissolve, over everything above, with the body's feet as its origin (fresh reads: nothing of posed()'s
    // graph is shared across the fold's branches).
    const feet = b.pos.element(b.lists.element(instanceIndex.add(uint(listBase)))).xyz
    applyCodeDissolve(m, vDissolve, feet, PEOPLE_DISSOLVE_INK)
    return m
  }
}
