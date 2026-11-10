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
 * undertone, and the words beside it (`crowd.figure`: the figure word, the face word and the wardrobe word) the eight
 * body sliders, the seven face sliders and the hair style, and the wardrobe's outer layer (a jacket, shirt sleeves or
 * a coat), its trim and its scarf, in place of the hash (the body itself is chosen from the look word in the cull,
 * crowd.wgsl), so the player and a recruit can wear what they chose; the genome's later words (look.ts LOOK_WORDS,
 * after the three in the same record) reach the fragment stage as one flat varying of four, the skin word among them:
 * a Monk tone, vitiligo's paler patches and freckles, drawn on the skin from the rest position. The jacket's lines are the fragment stage's: the
 * shirt's V, the lapels beside it, the collar band and the cuffs are cut from the rest position (humanoid.ts GARMENT),
 * so the trim's dye needs no vertices of its own. The face (the brow, the nose, the eyes, the lips, the ears) is drawn
 * by the eye pass of the near body alone: the shadow pass and the far body leave it out.
 * What breaks if it is removed? No pedestrian is drawn, and the worker's frames have nowhere to land.
 */
import {
  BufferGeometry, Color, DoubleSide, Float32BufferAttribute, IndirectStorageBufferAttribute, InstancedMesh, MeshStandardNodeMaterial,
  StorageBufferAttribute, Uint32BufferAttribute, Vector4, type Node, type NodeBuilder, type UniformNode,
} from 'three/webgpu'
import {
  Fn, If, atan, attribute, cameraPosition, dot, float, fwidth, hash, instanceIndex, mix, normalLocal, positionGeometry, positionLocal, positionPrevious,
  select, smoothstep, step, storage, time, uint, uniform, uniformArray, varying, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl'
import { CODE_DISSOLVE, applyCodeDissolve } from '../01_Initialize_World/codeDissolve.ts'
import { applyMatrixMode } from '../01_Initialize_World/matrixMode.ts'
import { bodyVertex } from './crowdBody.ts'
import { PLAYER_INDEX, VARIANTS, agentQuota } from './crowdCompute.ts'
import { BODY_NAMES, BONE, FACE, GARMENT, HEIGHT_BASE, JACKET_HEM, LANDMARK, LOWER_PAINT, PIECE, RIG_REST, RIG_WEAR, SLOT, humanoidMesh, type HumanoidMesh } from './humanoid.ts'
import {
  FACIAL_HAIR, HAIR_PIECE_STYLES, HAIR_TEXTURE, HAIR_TEXTURE_BITS, HAIR_TEXTURE_STYLES, HEADWEAR, HEARING, LAYER, LOOK_HASHED_HEARING, PROSTHETIC, LOOK_FIELD, LOOK_FIELD_HIGH, LOOK_HASHED_COLOUR,
  LOOK_HASHED_FACE, LOOK_HASHED_HAIR_SPLIT, LOOK_HASHED_HEADWEAR, LOOK_HASHED_LAYER, LOOK_HASHED_SCARF,
  LOOK_HASHED_SLIDER, LOOK_ODDS, LOOK_PIECE_BIT, LOOK_SLIDER_MIDDLE, LOOK_STATURE, LOOK_WORDS, VITILIGO, WARDROBE, WEAVE, WEAVE_STREET_PACKED, CUT, CUT_STREET_PACKED, TIELESS_CUTS, BOTTOM_CUT_STREET_PACKED, SKIRT_CUT, TROUSER_CUT,
  type LookFaceSlider, type LookSlider, type LookSlot, type PaletteName,
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
  monk: hex([0xf6ede4, 0xf3e7db, 0xf7ead0, 0xeadaba, 0xd7bd96, 0xa07e56, 0x825c43, 0x604134, 0x3a312a, 0x292420]),
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
  coats: hex([0x2b2b2e, 0x1f2a44, 0x4a3b2e, 0xb59a72, 0x5a5e5c, 0x3a2a24, 0x8a6a48]),
  trims: hex([0x141414, 0xe8e2d6, 0x5e2530, 0x1c2c4c, 0xb59a72, 0x6e7278, 0x3f5e5a]),
  scarves: hex([0x6a1e2a, 0x1c2c4c, 0xd9c7a8, 0x2a2a2d, 0x8a6a48, 0x3a5f9a, 0x9c9a96]),
  headwear: hex([0x1c1c22, 0xe9e4da, 0x1f2a44, 0x6a1e2a, 0x3f5e5a, 0xb59a72, 0x5a5e66, 0xc77d4a]),
}
/**
 * Every palette end to end, as the material's one uniform array holds them, and where each begins in it. WebGPU
 * promises a stage twelve uniform buffers (maxUniformBuffersPerShaderStage) and three's own groups take some: a buffer
 * per palette reached thirteen in the fragment stage with the coats, the trims and the scarves, and no body's pipeline
 * built (shadowShaders.test.ts counts a stage's bindings against the promise).
 */
const PALETTE_TABLE: Color[] = Object.values(PALETTE).flat()
const PALETTE_OFFSET: ReadonlyMap<Color[], number> = new Map(
  Object.values(PALETTE).map((list, i, lists) => [list, lists.slice(0, i).reduce((n, l) => n + l.length, 0)]),
)

/**
 * The quads of crowd.figure per agent: the figure, face and wardrobe words with the rig slot word (the first), then
 * the genome's words 4 to 15 (look.ts LOOK_WORDS; the look word itself is crowd.look). Sixty-four bytes a person.
 */
export const FIGURE_QUADS = 1 + (LOOK_WORDS - 4) / 4

/** Vitiligo's pale, linear RGB: a milky cream with a little pink (on a deep tone the patch shows clearly, on a light one softly, as it does). */
const VITILIGO_PALE = new Color(0xf2e0d6)
/** How much of the skin each vitiligo pattern pales (look.ts VITILIGO), as the share of the noise's range above its edge. */
const VITILIGO_COVER = Object.freeze({ scattered: 0.2, widespread: 0.58, zoned: 0.42 })
/** The share of freckle cells holding a freckle at each density (look.ts WARDROBE.freckles: light, medium, dense) where they gather most. */
const FRECKLE_DENSITY = Object.freeze([0, 0.16, 0.3, 0.48])
/** Where freckles gather most on the face: the band of the cheeks and the nose's bridge, m of the rest body (humanoid.ts FACE: the lips' line to the nose's root). */
const FRECKLE_BAND = Object.freeze({ from: FACE.lips.lineY, to: FACE.nose.rootY + 0.004 })

/** Three's hash of an integer cell, salted: the lattice the skin's noise and freckles are drawn from. */
const lattice = (c: V3, salt: number): F1 => hash(dot(c, vec3(1, 57, 113)).add(salt))

/** Smooth value noise in 0..1 at `p` (the lattice's eight corners, trilinear with smoothstep weights). */
function valueNoise(p: V3, salt: number): F1 {
  const c = p.floor()
  const f = p.fract()
  const u = f.mul(f).mul(f.mul(-2).add(3))
  const at = (x: number, y: number, z: number): F1 => lattice(c.add(vec3(x, y, z)), salt)
  const near = mix(mix(at(0, 0, 0), at(1, 0, 0), u.x), mix(at(0, 1, 0), at(1, 1, 0), u.x), u.y)
  const far = mix(mix(at(0, 0, 1), at(1, 0, 1), u.x), mix(at(0, 1, 1), at(1, 1, 1), u.x), u.y)
  return mix(near, far, u.z)
}

/**
 * The skin with its marks: vitiligo's paler patches (look.ts VITILIGO: on the hands and wrists, the face, both,
 * scattered or widespread anywhere the skin shows, or on one side of the body), two octaves of value noise over the
 * rest position past an edge the pattern's cover sets, and freckles (FRECKLE_DENSITY), one dot at most in each 1.6 cm
 * cell, thickest over the cheeks and the nose, fewer on the rest of the face, the hands and the neck, never on a
 * paled patch (it has no pigment to freckle). `offset` (0..1 each, the person's own) moves both patterns, so two people
 * of one look are not marked alike. Only the skin, the lips and bare legs read the result, and a person with neither
 * pays for neither (each is computed under its own branch). The far body keeps the patches, not the freckles.
 */
function skinMarks(skinIn: V3, vitiligoIn: U1, frecklesIn: U1, rigIn: V3, offsetIn: V3, slotIn: F1, near: boolean): V3 {
  // A function of its inputs (not a closure over them), so the call node holds them and the colour graph reaches through it.
  const marks = Fn(([skin, vitiligo, freckles, rig, offset, slot]: [V3, U1, U1, V3, V3, F1]) => {
    const rest = positionGeometry
    const bone = rig.x
    const on = (b: number) => bone.greaterThan(b - 0.5).and(bone.lessThan(b + 0.5))
    const bare = slot.greaterThan(SLOT.SKIN - 0.5).and(slot.lessThan(SLOT.SKIN + 0.5))
      .or(slot.greaterThan(SLOT.LIP - 0.5).and(slot.lessThan(SLOT.LIP + 0.5)))
      .or(slot.greaterThan(SLOT.LEGWEAR - 0.5).and(slot.lessThan(SLOT.LEGWEAR + 0.5)))
    const face = on(BONE.HEAD).and(rest.z.greaterThan(0))
    const hands = on(BONE.HAND_L).or(on(BONE.HAND_R)).or(on(BONE.FOREARM_L).or(on(BONE.FOREARM_R)).and(rest.y.lessThan(LANDMARK.wrist + 0.08)))
    const flag = (b: typeof face): F1 => select(b, float(1), float(0))
    const is = (v: number) => vitiligo.equal(uint(v))
    const out = vec3(skin).toVar()
    const patch = float(0).toVar()
    If(bare.and(vitiligo.notEqual(uint(0))), () => {
      const zone = select(is(VITILIGO.hands), flag(hands), select(is(VITILIGO.face), flag(face), select(is(VITILIGO.handsAndFace), flag(hands.or(face)),
        select(is(VITILIGO.oneSide), flag(rest.x.greaterThan(0)), float(1)))))
      const cover = select(is(VITILIGO.scattered), float(VITILIGO_COVER.scattered), select(is(VITILIGO.widespread), float(VITILIGO_COVER.widespread), float(VITILIGO_COVER.zoned)))
      const p = rest.add(vec3(1, 0, 1)).add(offset.mul(40))
      const n = valueNoise(p.mul(11), 3.1).mul(0.68).add(valueNoise(p.mul(29), 5.7).mul(0.32))
      const edge = float(1).sub(cover)
      patch.assign(zone.mul(smoothstep(edge.sub(0.035), edge.add(0.035), n)))
      out.assign(mix(skin, vec3(VITILIGO_PALE.r, VITILIGO_PALE.g, VITILIGO_PALE.b), patch.mul(0.9)))
    })
    if (near) {
      If(bare.and(freckles.notEqual(uint(0))), () => {
        const density = select(freckles.equal(uint(1)), float(FRECKLE_DENSITY[1]), select(freckles.equal(uint(2)), float(FRECKLE_DENSITY[2]), float(FRECKLE_DENSITY[3])))
        const cheeks = flag(rest.y.greaterThan(FRECKLE_BAND.from).and(rest.y.lessThan(FRECKLE_BAND.to)))
        const where = select(face, mix(float(0.45), float(1), cheeks), select(hands, float(0.4), float(0.3)))
        const q = rest.add(vec3(1, 0, 1)).mul(62).add(offset.mul(97))
        const cell = q.floor()
        const centre = vec3(lattice(cell, 11.3), lattice(cell, 13.7), lattice(cell, 17.9)).mul(0.4).add(0.3)
        const present = step(float(1).sub(density.mul(where)), lattice(cell, 19.1))
        const spot = present.mul(float(1).sub(smoothstep(0.17, 0.3, q.fract().sub(centre).length()))).mul(float(1).sub(patch))
        out.assign(mix(out, out.mul(vec3(0.72, 0.56, 0.46)), spot))
      })
    }
    return out
  }) as unknown as (...inputs: Node[]) => V3
  return marks(skinIn, vitiligoIn, frecklesIn, rigIn, offsetIn, slotIn)
}

/**
 * The hair painted over its pieces (look.ts HAIR_TEXTURE, WARDROBE.curl): cropped close (the skin through it), faded
 * to the skin from the crown down, an undercut's or a strip's shaved sides, a side part, cornrows' partings, braids'
 * plaits, locs' cords, twists, waves round the crown, all from the rest position so they keep their place as the head
 * turns; then the curl pattern's own texture over whatever is left (straight streaks, waves, curls, coils, finer and
 * deeper down the scale). The far body keeps the cuts that change the head's colour (close, faded, shaved) and leaves
 * the fine paints. Only the hair's slot reads the result (not the brows: their piece is the face's).
 */
function hairPaint(hairIn: V3, skinIn: V3, textureIn: U1, curlIn: U1, rigIn: V3, slotIn: F1, near: boolean): V3 {
  const paint = Fn(([hair, skin, texture, curl, rig, slot]: [V3, V3, U1, U1, V3, F1]) => {
    const rest = positionGeometry
    const piece = rig.z
    const is = (p: number) => piece.greaterThan(p - 0.5).and(piece.lessThan(p + 0.5))
    const onCap = is(PIECE.HAIR_CAP)
    const ofHair = is(PIECE.FACE).not()
    const t = (k: number) => texture.equal(uint(k))
    const out = vec3(hair).toVar()
    const x = rest.x, y = rest.y
    // A variable, assigned before the cuts: two of them read it, and an expression first built inside one cut's branch
    // was left unassigned in the other's (the centre strip's sides read black).
    const shaved = skin.mul(0.86).add(hair.mul(0.14)).toVar()
    // The hair's slot alone: every other fragment keeps the colour as it came (this runs before the slots' branches).
    If(slot.greaterThan(SLOT.HAIR - 0.5).and(slot.lessThan(SLOT.HAIR + 0.5)), () => {
      If(onCap, () => {
        If(t(HAIR_TEXTURE.close), () => { out.assign(mix(hair, skin, 0.5)) })
        If(t(HAIR_TEXTURE.fade), () => { out.assign(mix(hair, shaved, smoothstep(1.715, 1.645, y))) })
        If(t(HAIR_TEXTURE.undercut), () => { out.assign(select(x.abs().greaterThan(0.056).and(y.lessThan(1.735)), shaved, hair)) })
        If(t(HAIR_TEXTURE.strip), () => { out.assign(select(x.abs().greaterThan(0.03), shaved, hair)) })
      })
      if (near) {
        const groove = (v: F1, width: number): F1 => smoothstep(0.5 - width, 0.5, v.fract().sub(0.5).abs())
        const lengths = is(PIECE.LONG_HAIR).or(is(PIECE.PONYTAIL)).or(is(PIECE.BOB)).or(is(PIECE.BUN)).or(is(PIECE.TOP_BUN))
        If(onCap.and(t(HAIR_TEXTURE.part)), () => { out.assign(select(x.sub(0.035).abs().lessThan(0.004).and(y.greaterThan(1.7)), mix(hair, skin, 0.6), hair)) })
        If(onCap.and(t(HAIR_TEXTURE.rows).or(t(HAIR_TEXTURE.braids))), () => {
          // Partings between the rows, front to back (cornrows), or a grid of them (braids' sections).
          const rows = groove(x.mul(select(t(HAIR_TEXTURE.rows), float(55), float(30))), 0.09)
          const sections = select(t(HAIR_TEXTURE.braids), groove(y.mul(30).add(rest.z.mul(30)), 0.08), float(0))
          out.assign(mix(hair, skin.mul(0.8), rows.max(sections).mul(0.75)))
        })
        If(lengths.and(t(HAIR_TEXTURE.braids).or(t(HAIR_TEXTURE.rows))), () => {
          out.assign(hair.mul(float(0.78).add(groove(y.mul(90).add(x.abs().mul(60)), 0.25).oneMinus().mul(0.3))))
        })
        If(ofHair.and(t(HAIR_TEXTURE.locs)), () => {
          const cords = groove(x.mul(45).add(rest.z.mul(45)), 0.18).oneMinus()
          out.assign(hair.mul(float(0.74).add(cords.mul(0.3)).add(valueNoise(rest.mul(vec3(40, 12, 40)), 2.3).mul(0.08))))
        })
        If(ofHair.and(t(HAIR_TEXTURE.twists)), () => {
          const a = groove(y.mul(70).add(x.mul(50)), 0.2), c = groove(y.mul(70).sub(x.mul(50)), 0.2)
          out.assign(hair.mul(float(1.04).sub(a.max(c).mul(0.24))))
        })
        If(onCap.and(t(HAIR_TEXTURE.waves)), () => {
          const r = vec3(x, 0, rest.z.add(0.015)).length()
          out.assign(mix(hair, skin, 0.35).mul(float(0.84).add(groove(r.mul(85).add(y.mul(20)), 0.3).oneMinus().mul(0.22))))
        })
        // The curl pattern's own texture (1A to 4C: four families of three): straight streaks, waves, curls, coils.
        If(ofHair.and(curl.greaterThan(uint(0))).and(t(HAIR_TEXTURE.close).not()).and(t(HAIR_TEXTURE.waves).not()), () => {
          const family = curl.sub(uint(1)).div(uint(3))
          const grade = float(curl.sub(uint(1)).mod(uint(3))).div(2)
          const streak = x.add(rest.z).mul(300).sin().mul(0.05)
          const wave = y.mul(float(110).add(grade.mul(40))).add(x.mul(40).sin().mul(2)).sin().mul(0.08)
          const curls = valueNoise(rest.mul(float(140).add(grade.mul(60))), 4.1).sub(0.5).mul(0.24)
          const coils = valueNoise(rest.mul(float(260).add(grade.mul(80))), 6.7).sub(0.5).mul(0.28).sub(0.06)
          const shade = select(family.equal(uint(0)), streak, select(family.equal(uint(1)), wave, select(family.equal(uint(2)), curls, coils)))
          out.assign(out.mul(shade.add(1)))
        })
      }
    })
    return out
  }) as unknown as (...inputs: Node[]) => V3
  return paint(hairIn, skinIn, textureIn, curlIn, rigIn, slotIn)
}

/**
 * Facial hair painted on the face's skin in the hair's colour (look.ts FACIAL_HAIR), from the rest position: stubble
 * a light shadow over the jaw and the upper lip, a moustache over the lip, a goatee the moustache and the chin, a
 * short beard the jaw to the cheek's lower line, a full beard (and under the long beard's piece) up to the cheeks,
 * each broken by fine noise so it reads as hair. Not on the nose or the ears (the features' piece), nor the lips
 * (their own slot). The far body has no features: it keeps the beards' colour over the jaw, not the fine lines.
 */
function facialPaint(skinIn: V3, hairIn: V3, styleIn: U1, rigIn: V3, slotIn: F1, near: boolean): V3 {
  const paint = Fn(([skin, hair, style, rig, slot]: [V3, V3, U1, V3, F1]) => {
    const rest = positionGeometry
    const out = vec3(skin).toVar()
    const onHead = rig.x.greaterThan(BONE.HEAD - 0.5).and(rig.x.lessThan(BONE.HEAD + 0.5))
    const feature = rig.z.greaterThan(PIECE.FACE - 0.5).and(rig.z.lessThan(PIECE.FACE + 0.5))
    const bare = slot.greaterThan(SLOT.SKIN - 0.5).and(slot.lessThan(SLOT.SKIN + 0.5))
    If(bare.and(onHead).and(feature.not()).and(style.notEqual(uint(FACIAL_HAIR.none))), () => {
      const x = rest.x.abs(), y = rest.y, z = rest.z
      const is = (k: number) => style.equal(uint(k))
      const grain = near ? valueNoise(rest.mul(180), 8.3).mul(0.3).add(0.7) : float(0.85)
      const full = is(FACIAL_HAIR.fullBeard).or(is(FACIAL_HAIR.longBeard))
      const jawTop = select(full, float(1.642), float(1.628))
      // Down to the chin's own ring (1.572 to 1.575), or a little under it for a full beard: the neck below is bare (the
      // trunk's last two rings are the head's bone and the skin's slot, so nothing else keeps the paint off the throat).
      const below = select(full, float(1.548), float(1.571))
      const jaw = y.greaterThan(below).and(y.lessThan(jawTop)).and(z.greaterThan(-0.03))
      const lip = x.lessThan(0.028).and(y.greaterThan(1.612)).and(y.lessThan(1.626)).and(z.greaterThan(0.04))
      const chin = x.lessThan(0.03).and(y.greaterThan(1.571)).and(y.lessThan(1.602)).and(z.greaterThan(0.02))
      const beard = is(FACIAL_HAIR.shortBeard).or(is(FACIAL_HAIR.fullBeard)).or(is(FACIAL_HAIR.longBeard))
      const cover = select(is(FACIAL_HAIR.stubble), select(jaw.or(lip), float(0.32), float(0)),
        select(lip.and(is(FACIAL_HAIR.moustache).or(is(FACIAL_HAIR.goatee)).or(beard)), float(0.95),
          select(chin.and(is(FACIAL_HAIR.goatee)), float(0.92),
            select(jaw.and(beard), select(is(FACIAL_HAIR.shortBeard), float(0.8), float(0.94)), float(0)))))
      out.assign(mix(skin, hair, cover.mul(grain)))
    })
    return out
  }) as unknown as (...inputs: Node[]) => V3
  return paint(skinIn, hairIn, styleIn, rigIn, slotIn)
}

/** A pale thread on the cloth (pinstripes, chalk stripes, windowpanes), a batik's resist and a strip weave's gold bars, linear RGB. */
const THREAD = Object.freeze({ chalk: vec3(0.86, 0.85, 0.82), resist: vec3(0.86, 0.7, 0.42), gold: vec3(0.6, 0.42, 0.09) })
/** The cloths with a sheen of their own (look.ts WEAVE): silk smooth, merino fine, linen, tweed and cashmere dry. */
const WEAVE_SHEEN: readonly (readonly [weave: number, roughness: number])[] = Object.freeze([
  [WEAVE.silk, 0.35], [WEAVE.merino, 0.74], [WEAVE.linen, 0.9], [WEAVE.tweed, 0.9], [WEAVE.cashmere, 0.92],
])

/**
 * The cloth's weave (look.ts WEAVE) over the top's or the bottom's cloth, from the rest position: round each part (the
 * trunk, a leg, an arm) by the angle about its own axis at its mean radius, so stripes run down the body and the
 * sleeves and meet in a seam at the back, and up it by the height. `footprint` is a pixel's width on the rest body (m), read at the top of the
 * stage, outside every branch (a derivative is defined only there): threads finer than it fade to the weave's own mean
 * colour, so a far suit's pinstripes become a slightly lighter cloth, not a moiré. The far body skips the noise the
 * tweed and the cashmere are flecked with. A cloth with weave 0 (plain, and every slot but the top and the bottom)
 * comes back as it went in.
 */
function weavePaint(clothIn: V3, weaveIn: U1, rigIn: V3, slotIn: F1, footprintIn: F1, near: boolean, skirt: boolean): V3 {
  const paint = Fn(([cloth, weave, rig, slot, footprint]: [V3, U1, V3, F1, F1]) => {
    const out = vec3(cloth).toVar()
    If(weave.notEqual(uint(WEAVE.plain)), () => {
      const rest = positionGeometry
      const bone = rig.x
      const onArm = bone.greaterThan(BONE.ARM_L - 0.5)
      // The legs, and the trousers' seat on the trunk with them (each half about its own leg, so the seat's stripes run
      // on down the thighs and meet at the centre seam); a skirt is one tube round both legs, about the trunk's axis.
      const seat = skirt ? slot.lessThan(-1) : slot.greaterThan(SLOT.BOTTOM - 0.5).and(slot.lessThan(SLOT.BOTTOM + 0.5))
      const onLeg = bone.greaterThan(BONE.THIGH_L - 0.5).and(bone.lessThan(BONE.SHIN_R + 0.5)).or(seat)
      // The sleeves hang round x = ±1.06 of the shoulder (humanoid.ts armTubes), the legs round the hips' x.
      const axis = select(onArm, float(LANDMARK.shoulderX * 1.06), select(onLeg, float(LANDMARK.hipX), float(0))).mul(rest.x.sign())
      const dx = rest.x.sub(axis)
      // Read by every weave's branch: variables, assigned before them (an expression first built inside one branch is
      // unassigned in the others).
      // The angle about the part's axis at the part's mean radius (the trunk's, a leg's, an arm's): a stripe keeps to its
      // meridian down the body however the girth changes (the true arc's length bent them where the back curves).
      const u = atan(dx, rest.z).mul(select(onArm, float(0.05), select(onLeg, float(0.07), float(0.15)))).toVar()
      const v = rest.y.toVar()
      const fw = footprint
      const light = mix(cloth, THREAD.chalk, 0.55).toVar()
      const accent = mix(vec3(0.36, 0.035, 0.03), vec3(cloth.z, cloth.x, cloth.y).mul(2), 0.35).toVar()
      const second = mix(vec3(0.02, 0.12, 0.06), vec3(cloth.y, cloth.z, cloth.x).mul(1.6), 0.35).toVar()
      // Lines `width` wide every `period` along t (m), smoothed over the pixel, and their mean (width / period) once a
      // pixel spans half a period; a ripple's depth, gone as its period nears the pixel.
      const lines = (t: F1, period: number, width: number): F1 => {
        const d = t.div(period).add(0.5).fract().sub(0.5).abs().mul(period)
        return mix(float(width / 2).sub(d).div(fw).add(0.5).clamp(0, 1), float(width / period), smoothstep(0.25, 0.5, fw.div(period)))
      }
      const fine = (period: number): F1 => float(1).sub(smoothstep(0.2, 0.45, fw.div(period)))
      const ripple = (t: F1, period: number, depth: number): F1 => t.mul((2 * Math.PI) / period).sin().mul(depth).mul(fine(period)).add(1)
      const is = (k: number) => weave.equal(uint(k))
      const between = (a: number, b: number) => weave.greaterThanEqual(uint(a)).and(weave.lessThanEqual(uint(b)))
      If(is(WEAVE.twill), () => { out.assign(cloth.mul(ripple(u.add(v), 0.0035, 0.07))) })
      If(is(WEAVE.merino), () => { out.assign(cloth.mul(ripple(u.add(v), 0.002, 0.035))) })
      If(is(WEAVE.herringbone), () => {
        // Twill lines that turn every centimetre round the body: the bone of the fish.
        const turn = u.div(0.01).floor().mod(2).mul(2).sub(1)
        out.assign(cloth.mul(ripple(v.add(u.mul(turn)), 0.0045, 0.1)))
      })
      If(is(WEAVE.pinstripe), () => { out.assign(mix(cloth, light, lines(u, 0.012, 0.0008).mul(0.85))) })
      If(is(WEAVE.chalkStripe), () => { out.assign(mix(cloth, light, lines(u, 0.026, 0.0026).mul(0.45))) })
      If(is(WEAVE.windowpane), () => { out.assign(mix(cloth, light, lines(u, 0.07, 0.0016).max(lines(v, 0.07, 0.0016)).mul(0.75))) })
      If(between(WEAVE.houndstooth, WEAVE.glenCheck), () => {
        // Two shades in a check of 12 mm (houndstooth: the dark quarter, the light quarter and two of teeth), or the glen
        // check's blocks of a small check, bars and stripes, under an overcheck of a bluer line.
        const hl = mix(cloth, vec3(0.8, 0.79, 0.76), 0.35), hd = cloth.mul(0.5)
        const q = vec2(u, v).div(0.012).fract()
        const a = step(0.5, q.x), b = step(0.5, q.y)
        // The teeth are stripes of 4.2 mm: they fade to their mean on their own period, before the check's 12 mm does.
        const teeth = mix(float(0.5), step(0.5, q.x.add(q.y).mul(2).fract()), fine(0.0042))
        const tooth = float(1).sub(a).mul(float(1).sub(b)).add(a.add(b).sub(a.mul(b).mul(2)).mul(teeth))
        const ra = step(0.5, u.div(0.048).fract()), rb = step(0.5, v.div(0.048).fract())
        const check = step(0.5, u.div(0.005).fract()).sub(step(0.5, v.div(0.005).fract())).abs()
        const both = ra.mul(rb), none = float(1).sub(ra).mul(float(1).sub(rb))
        const glen = both.mul(check).add(none.mul(step(0.5, v.div(0.004).fract()))).add(float(1).sub(both).sub(none).mul(step(0.5, u.div(0.004).fract())))
        const shade = select(is(WEAVE.houndstooth), mix(float(0.5), tooth, fine(0.012)), mix(float(0.5), glen, fine(0.004)))
        const over = select(is(WEAVE.glenCheck), lines(u, 0.096, 0.0012).max(lines(v, 0.096, 0.0012)), float(0))
        out.assign(mix(mix(hl, hd, shade), cloth.mul(vec3(0.7, 0.85, 1.5)).add(vec3(0.02, 0.03, 0.08)), over.mul(0.8)))
      })
      If(is(WEAVE.tartan), () => {
        // A generic check: two dark bands crossing (darker where they cross), a wide stripe of the second colour and a
        // fine one of the first, both ways, every 9 cm.
        const bands = cloth.mul(float(1).sub(lines(u, 0.09, 0.045).add(lines(v, 0.09, 0.045)).mul(0.25)))
        const wide = lines(u.sub(0.0675), 0.09, 0.006).max(lines(v.sub(0.0675), 0.09, 0.006))
        const thin = lines(u.sub(0.0225), 0.09, 0.002).max(lines(v.sub(0.0225), 0.09, 0.002))
        out.assign(mix(mix(bands, second, wide.mul(0.8)), accent, thin.mul(0.9)))
      })
      If(is(WEAVE.tweed), () => {
        // Flecks of a pale and a coloured thread in a mottled cloth (the noise on the near body alone).
        // Past the pixel the flecks fade to their mean: one cell in twelve and a half, half pale and half coloured.
        const mottle = near ? valueNoise(rest.mul(700), 9.1).sub(0.5).mul(0.35).mul(fine(0.0014)) : float(0)
        const cell = rest.mul(520).floor()
        const sharp = near ? fine(0.002) : float(0)
        const fleck = mix(float(0.08), near ? step(0.92, lattice(cell, 12.7)) : float(0.08), sharp)
        const thread = mix(mix(light, accent, 0.5), near ? select(lattice(cell, 14.3).greaterThan(0.5), light, accent) : light, sharp)
        out.assign(mix(cloth.mul(mottle.add(1)), thread, fleck.mul(0.6)))
      })
      If(is(WEAVE.linen), () => {
        // Slubs: each fine row and column of threads a little lighter or darker than its neighbours.
        const rows = lattice(vec3(0, v.div(0.0012).floor(), u.div(0.02).floor()), 21.1)
        const cols = lattice(vec3(u.div(0.0012).floor(), 0, v.div(0.02).floor()), 23.3)
        out.assign(cloth.mul(rows.add(cols).sub(1).mul(0.12).mul(fine(0.0012)).add(1.04)))
      })
      If(is(WEAVE.silk), () => { out.assign(cloth.mul(1.04)) })
      If(is(WEAVE.cashmere), () => {
        const soft = mix(cloth, vec3(dot(cloth, vec3(0.2126, 0.7152, 0.0722))), 0.08).mul(1.03)
        out.assign(near ? soft.mul(valueNoise(rest.mul(400), 15.9).sub(0.5).mul(0.06).mul(fine(0.0025)).add(1)) : soft)
      })
      If(is(WEAVE.batik), () => {
        // A dye resisted in dots and rings, every 3.6 cm, each row half a step along from the last.
        const row = v.div(0.036).floor()
        const c = vec2(u.div(0.036).add(row.mod(2).mul(0.5)), v.div(0.036)).fract().sub(0.5)
        const r = c.length().mul(0.036)
        const dot3 = float(0.0035).sub(r).div(fw).add(0.5).clamp(0, 1)
        const ring = float(0.0012).sub(r.sub(0.011).abs()).div(fw).add(0.5).clamp(0, 1)
        const mark = mix(dot3.max(ring), float(0.16), smoothstep(0.25, 0.5, fw.div(0.005)))
        out.assign(mix(cloth, mix(cloth, THREAD.resist, 0.6), mark))
      })
      If(is(WEAVE.stripWeave), () => {
        // Strips 7.5 cm wide sewn side by side: blocks of gold bars and of a centre stripe in the second colour, staggered
        // strip to strip, each strip's edge a dark seam.
        const strip = u.div(0.075).floor()
        const block = v.div(0.06).add(strip.mul(0.5)).floor().add(strip).mod(2)
        const bars = mix(cloth, THREAD.gold, lines(v, 0.008, 0.004).mul(0.85))
        const centre = mix(cloth, second, lines(u.sub(0.0375), 0.075, 0.01).mul(0.85))
        out.assign(mix(select(block.lessThan(0.5), bars, centre), cloth.mul(0.4), lines(u, 0.075, 0.0015)))
      })
    })
    return out
  }) as unknown as (...inputs: Node[]) => V3
  return paint(clothIn, weaveIn, rigIn, slotIn, footprintIn)
}

function agentBuffers(view: CrowdView, agentCount: number, listLength: number) {
  return {
    pos: storage(view.pos, 'vec4', agentCount).toReadOnly(),
    vel: storage(view.vel, 'vec4', agentCount).toReadOnly(),
    pose: storage(view.pose, 'vec4', agentCount).toReadOnly(),
    dissolve: storage(view.dissolve, 'float', agentCount).toReadOnly(),
    look: storage(view.look, 'uint', agentCount).toReadOnly(),
    figure: storage(view.figure, 'uvec4', agentCount * FIGURE_QUADS).toReadOnly(),
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
   * The figure word, the face word and the wardrobe word per agent (look.ts packFigure: the eight body sliders' steps;
   * packFace: the seven face sliders' steps and the hair style; packWardrobe: the layer, the trim and the scarf; read
   * only where the look word says a look is worn), then the rig slot word, then the genome's words 4 to 15 (look.ts
   * packGenome: the skin word, the cloth word, and spare words that stay zero): FIGURE_QUADS quads, sixteen u32 per agent, written
   * beside the look word. Page-only like it: the worker's passes never bind it, the cull never reads it, no pedestrian
   * moves for it. One buffer for all of them: the vertex stage binds seven storage buffers already, of the eight
   * WebGPU promises every device.
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
  /**
   * The operator's eye in the world (x, y, z) and 1 in w while someone is afoot to look at (0 from a car): the vertex
   * stage turns the heads and chests near it (crowdBody.ts bodyGaze), one uniform for both passes so the shadow
   * looks where the body does. The engine writes it every frame.
   */
  readonly gazeTarget: UniformNode<'vec4', Vector4> = uniform(new Vector4(0, 0, 0, 0))
  /**
   * The rigs of the fallen pedestrians (humanoid.ts RIG_WEAR): per rig slot, per shape in stream order, the shape's
   * world centre (x, y, z, 1) then its rotation (a quaternion), as `rigs` writes them from the realm's stream; an
   * empty slot's shapes sit at the origin, unturned. A body whose rig slot word (crowd.figure's fourth word, slot + 1)
   * is set hangs from these in the vertex stage (crowdBody.ts bodyRig) instead of walking; both passes read them.
   */
  readonly rigPoses = uniformArray(Array.from({ length: RIG_WEAR.slots * RIG_WEAR.shapes * 2 }, (_, i) => new Vector4(0, 0, 0, i % 2)), 'vec4')
  /** The rig shape each bone hangs from (humanoid.ts RIG_REST), by bone, as the vertex stage reads it. */
  readonly rigShape = uniformArray(RIG_REST.map(([shape]) => shape), 'float')

  /**
   * Writes one step's rig stream (simProtocol.ts RIG_POSE: a slice per slot of agent, state, then thirteen poses of
   * x, y, z, qx, qy, qz, qw; null, or a buffer of the wrong length, empties every slot) into `rigPoses`. Which agents
   * wear which slot is the engine's to write into crowd.figure's fourth word.
   */
  rigs(stream: Float32Array | null): void {
    const { slots, shapes } = RIG_WEAR
    const stride = 2 + shapes * 7
    const valid = stream instanceof Float32Array && stream.length >= slots * stride
    const arr = this.rigPoses.array as Vector4[]
    for (let s = 0; s < slots; s++) {
      const o = s * stride
      const live = valid && stream[o] >= 0
      for (let j = 0; j < shapes; j++) {
        const k = (s * shapes + j) * 2
        const b = o + 2 + j * 7
        if (live) { arr[k].set(stream[b], stream[b + 1], stream[b + 2], 1); arr[k + 1].set(stream[b + 3], stream[b + 4], stream[b + 5], stream[b + 6]) }
        else { arr[k].set(0, 0, 0, 0); arr[k + 1].set(0, 0, 0, 1) }
      }
    }
  }

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
    this.figure = new StorageBufferAttribute(new Uint32Array(agentCount * FIGURE_QUADS * 4), 4)
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
    // The wardrobe word worn (the look's or the hash's, resolved once here so the pieces and their dyes agree), eight
    // bits in a float.
    const vWardrobe = varyingProperty('float', 'vAgentWardrobe')
    const woman = variant >= 2
    const m = new MeshStandardNodeMaterial()
    // The shadow map takes both faces. The skirt and the coat are open shells, and three's shadow pass draws a front-sided
    // material's back faces alone (Renderer: _shadowSide), so a shell's wall nearer the sun stayed out of the map and
    // its shadow had a gap. The lit faces of the closed tubes are drawn too; the cascades' depth and normal bias keep
    // them from shadowing themselves.
    m.shadowSide = DoubleSide
    // One pose, built twice: for the eye (which folds away the body it looks out of) and for the shadow map.
    const posed = (eye: boolean) => Fn((builder: NodeBuilder) => {
      const agentIndex = b.lists.element(instanceIndex.add(uint(listBase)))
      const agent = b.pos.element(agentIndex)
      const motion = b.vel.element(agentIndex)
      const pose = b.pose.element(agentIndex)
      const dissolve = b.dissolve.element(agentIndex)
      const word = b.look.element(agentIndex)
      const quad = b.figure.element(agentIndex.mul(uint(FIGURE_QUADS)))
      const figure = quad.x
      const faceWord = quad.y
      const wardrobeWord = quad.z
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
      // The crown's pieces (the cap, a bun) and the length below it (long hair, a bob), apart: a crown cover hides the first.
      const hashedCrown = woman
        ? float(64).add(notShort.mul(past(LOOK_ODDS.bun)).mul(256))
        : past(LOOK_ODDS.bald).oneMinus().mul(64)
      const hashedLength = woman
        ? notShort.mul(past(LOOK_ODDS.bob).oneMinus()).mul(16).add(notShort.mul(past(LOOK_ODDS.bob)).mul(past(LOOK_ODDS.bun).oneMinus()).mul(128))
        : past(LOOK_ODDS.bald).oneMinus().mul(notShort.mul(16))
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
      // The style's five bits (the face word's three, the skin word's two above them: look.ts LOOK_FIELD_HIGH) and the
      // headwear (the skin word's, or the hash's: LOOK_HASHED_HEADWEAR splits it as lookFromSeed does). Each hair piece
      // is worn when the style's bit is set in that piece's set (look.ts HAIR_PIECE_STYLES) and the headwear leaves it
      // showing (look.ts hairBits: all the hair under a hijab, a turban or a head wrap is covered, the crown's under a
      // durag, a beanie or a flat cap); the headwear adds its own pieces on the near body, and on the far body, which
      // has none of them, keeps the hair's cap for the fragment stage to paint in the headwear's cloth.
      const genomeQuad = b.figure.element(agentIndex.mul(uint(FIGURE_QUADS)).add(uint(1)))
      const skinWord = genomeQuad.x
      const style = faceWord.shiftRight(uint(LOOK_FIELD.hairStyle[1])).bitAnd(uint(7))
        .bitOr(skinWord.shiftRight(uint(LOOK_FIELD_HIGH.hairStyle![1])).bitAnd(uint(3)).shiftLeft(uint(3)))
      const wear = h(LOOK_HASHED_HEADWEAR)
      const odds = (edge: number) => wear.greaterThanEqual(edge)
      const hashedHeadwear = woman
        ? select(odds(LOOK_ODDS.hijab), uint(HEADWEAR.hijab), select(odds(LOOK_ODDS.headWrap), uint(HEADWEAR.headWrap), uint(HEADWEAR.none)))
        : select(odds(LOOK_ODDS.turban), uint(HEADWEAR.turban), select(odds(LOOK_ODDS.kippah), uint(HEADWEAR.kippah), select(odds(LOOK_ODDS.flatCap), uint(HEADWEAR.flatCap), uint(HEADWEAR.none))))
      const headwear = select(custom, skinWord.shiftRight(uint(LOOK_FIELD.headwear[1])).bitAnd(uint(7)), hashedHeadwear)
      const coversAll = headwear.equal(uint(HEADWEAR.hijab)).or(headwear.equal(uint(HEADWEAR.turban))).or(headwear.equal(uint(HEADWEAR.headWrap)))
      const coversCrown = headwear.equal(uint(HEADWEAR.durag)).or(headwear.equal(uint(HEADWEAR.beanie))).or(headwear.equal(uint(HEADWEAR.flatCap)))
      const covered = coversAll.or(coversCrown)
      const wears = (piece: keyof typeof HAIR_PIECE_STYLES) => uint(HAIR_PIECE_STYLES[piece]).shiftRight(style).bitAnd(uint(1)).equal(uint(1))
      const groom = (piece: keyof typeof HAIR_PIECE_STYLES, belowCrown: boolean) =>
        select(wears(piece).and(coversAll.not()).and(belowCrown ? coversAll.not() : coversCrown.not()), float(1 << LOOK_PIECE_BIT[piece]), float(0))
      const ownHair = groom('hairCap', false).add(groom('longHair', true)).add(groom('bob', true)).add(groom('bun', false))
        .add(groom('volume', false)).add(groom('topBun', false)).add(groom('ponytail', true))
      const headwearBits = near
        ? select(headwear.equal(uint(HEADWEAR.hijab)), float(1 << LOOK_PIECE_BIT.wrap), float(0))
          .add(select(headwear.equal(uint(HEADWEAR.turban)).or(headwear.equal(uint(HEADWEAR.headWrap))), float(1 << LOOK_PIECE_BIT.turban), float(0)))
          .add(select(coversCrown, float(1 << LOOK_PIECE_BIT.hat), float(0)))
          .add(select(headwear.equal(uint(HEADWEAR.flatCap)), float(1 << LOOK_PIECE_BIT.brim), float(0)))
        : select(covered, float(1 << LOOK_PIECE_BIT.hairCap), float(0))
      // The hashed hair is the five older styles' pieces alone, covered as a chosen look's is.
      const hashedHair = select(coversAll, float(0), select(coversCrown, hashedLength, hashedCrown.add(hashedLength)))
      // The skin word's own pieces (look.ts genomeBits): the long beard, and on the near body the hearing devices (a
      // chosen look's, or the hash's: hearing aids for a few, an implant on the right for fewer).
      const hearingLink = h(LOOK_HASHED_HEARING)
      const hashedHearing = select(hearingLink.greaterThanEqual(LOOK_ODDS.implant), uint(HEARING.implant), select(hearingLink.greaterThanEqual(LOOK_ODDS.aids), uint(HEARING.aids), uint(HEARING.none)))
      const hearing = select(custom, skinWord.shiftRight(uint(LOOK_FIELD.hearing[1])).bitAnd(uint(7)), hashedHearing)
      const hears = (...kinds: number[]) => kinds.reduce((on: ReturnType<typeof hearing.equal>, k) => on.or(hearing.equal(uint(k))), hearing.equal(uint(255)))
      const longBeard = custom.and(skinWord.shiftRight(uint(LOOK_FIELD.facialHair[1])).bitAnd(uint(7)).equal(uint(FACIAL_HAIR.longBeard)))
      const genomePieces = select(longBeard, float(1 << LOOK_PIECE_BIT.beard), float(0)).add(near
        ? select(hears(HEARING.aids, HEARING.implantAndAid), float(1 << LOOK_PIECE_BIT.aidL), float(0))
          .add(select(hears(HEARING.aids), float(1 << LOOK_PIECE_BIT.aidR), float(0)))
          .add(select(hears(HEARING.implants), float(1 << LOOK_PIECE_BIT.coilL), float(0)))
          .add(select(hears(HEARING.implant, HEARING.implants, HEARING.implantAndAid), float(1 << LOOK_PIECE_BIT.coilR), float(0)))
        : float(0))
      const ownGrooms = ownHair.add(headwearBits).add(genomePieces)
      const hashedHead = hashedHair.add(headwearBits).add(genomePieces)
      // The eye pass alone draws the face's features (their piece bit): the shadow map does without them.
      const features = eye ? 1 << LOOK_PIECE_BIT.face : 0
      // The wardrobe the hash gives (look.ts lookFromSeed draws it from the same links the same way), as a wardrobe
      // word: the layer from its link of this chain (shirt sleeves under one odds, a coat from another, else the
      // jacket), a scarf on another link with its cloth from the colours' chain, the trim's contrast and its cloth from
      // the colours' chain too. A chosen look's wardrobe word replaces it whole; the fragment stage reads the result.
      const hc = (k: number) => hash(seed.add(k * 7.919))
      const layerLink = h(LOOK_HASHED_LAYER)
      const hashedLayer = select(layerLink.lessThan(LOOK_ODDS.shirtSleeves), uint(LAYER.shirt), select(layerLink.greaterThanEqual(LOOK_ODDS.coat), uint(LAYER.coat), uint(LAYER.jacket)))
      const clothAt = (link: F1, n: number) => uint(link.mul(n - 0.001)).add(uint(1))
      const hashedTrim = select(hc(LOOK_HASHED_COLOUR.trim).greaterThanEqual(LOOK_ODDS.trim), clothAt(hc(LOOK_HASHED_COLOUR.trimCloth), PALETTE.trims.length), uint(0))
      const hashedScarf = select(h(LOOK_HASHED_SCARF).greaterThanEqual(LOOK_ODDS.scarf), clothAt(hc(LOOK_HASHED_COLOUR.scarfCloth), PALETTE.scarves.length), uint(0))
      const hashedWardrobe = hashedLayer.bitOr(hashedTrim.shiftLeft(uint(LOOK_FIELD.trim[1]))).bitOr(hashedScarf.shiftLeft(uint(LOOK_FIELD.scarf[1])))
      const wardrobe = select(custom, wardrobeWord, hashedWardrobe)
      const layer = wardrobe.shiftRight(uint(LOOK_FIELD.layer[1])).bitAnd(uint((1 << LOOK_FIELD.layer[2]) - 1))
      const scarfAt = wardrobe.shiftRight(uint(LOOK_FIELD.scarf[1])).bitAnd(uint((1 << LOOK_FIELD.scarf[2]) - 1))
      // The wardrobe's pieces (look.ts wardrobeBits): the coat under a coat layer, the scarf when one is worn.
      const wardrobePieces = select(layer.equal(uint(LAYER.coat)), float(1 << LOOK_PIECE_BIT.coat), float(0))
        .add(select(scarfAt.equal(uint(0)), float(0), float(1 << LOOK_PIECE_BIT.scarf)))
      // The cut (look.ts lookMask, TIELESS_CUTS): no tie under a turtleneck or a jacket closed to the neck. The look's
      // cut from the cloth word, or the hash's from the colours' chain as the fragment stage draws it.
      const hashedCut = select(hc(LOOK_HASHED_COLOUR.cut).greaterThanEqual(LOOK_ODDS.cut),
        uint(CUT_STREET_PACKED[variant]).shiftRight(uint(hc(LOOK_HASHED_COLOUR.cutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15)), uint(0))
      const cutNow = select(custom, genomeQuad.y.shiftRight(uint(LOOK_FIELD.cut[1])).bitAnd(uint(15)), hashedCut)
      // The lower cut (look.ts bottomCut): the look's from the cloth word, or the hash's from the colours' chain as the
      // fragment stage draws it. crowdBody.ts bodyGarment reshapes the trousers' legs or the skirt by it (morphB.w: the
      // cut, 16 more under a coat, where no skirt widens).
      const hashedBottomCut = select(hc(LOOK_HASHED_COLOUR.bottomCut).greaterThanEqual(LOOK_ODDS.bottomCut),
        uint(BOTTOM_CUT_STREET_PACKED[variant]).shiftRight(uint(hc(LOOK_HASHED_COLOUR.bottomCutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15)), uint(0))
      const bottomCutNow = select(custom, genomeQuad.y.shiftRight(uint(LOOK_FIELD.bottomCut[1])).bitAnd(uint(15)), hashedBottomCut)
      const lowerCode = float(bottomCutNow).add(select(layer.equal(uint(LAYER.coat)), float(16), float(0)))
      const tieless = TIELESS_CUTS.reduce((on: ReturnType<typeof cutNow.equal>, k) => on.or(cutNow.equal(uint(k))), cutNow.equal(uint(255))).and(layer.notEqual(uint(LAYER.shirt)))
      const tieWorn = select(custom, float(word.shiftRight(uint(2 + LOOK_PIECE_BIT.tie)).bitAnd(uint(1))), step(0.3, h(1))).mul(1 << LOOK_PIECE_BIT.tie)
      const mask = select(custom, float(word.shiftRight(uint(2)).bitAnd(uint(46))).add(ownGrooms), hashedMask.add(hashedHead)).add(features).add(wardrobePieces)
        .sub(select(tieless, tieWorn, float(0)))
      const slider = (slot: Exclude<LookSlider, 'height'>) => {
        const n = (slot === 'head' ? WARDROBE.headSteps : WARDROBE.sliderSteps) - 1
        return select(custom, stepOf(slot), hashedStep(LOOK_HASHED_SLIDER[slot], n)).div(n)
      }
      const height = select(custom, stepOf('height'), hashedHeight).mul(STATURE_STEP).add(WARDROBE.stature.min).div(HEIGHT_BASE)
      const stance = vec4(height, mask, h(8), float(quad.w))
      const morphA = vec4(slider('mass'), slider('muscle'), slider('shoulders'), slider('hips'))
      const morphB = vec4(slider('legs'), slider('posture'), slider('head'), lowerCode)
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
      // The rig shapes the vertex's two bones hang from, should this person be wearing a rig (the slot word in quad.w).
      const rigBase = select(quad.w.greaterThan(uint(0)), quad.w.sub(uint(1)), uint(0)).mul(uint(RIG_WEAR.shapes * 2))
      const rigAt = (bone: typeof rig.x) => uint((this.rigShape.element(uint(bone.add(0.5))) as unknown as typeof rig.x).add(0.5)).mul(uint(2)).add(rigBase)
      const rigA = rigAt(rig.x), rigB = rigAt(skin.x)
      const skinned = (bodyVertex(positionLocal, normalLocal, rig, skin, face, agent, motion, pose, stance, morphA, morphB, faceA, faceB, time, this.gazeTarget, this.rigPoses.element(rigA), this.rigPoses.element(rigA.add(uint(1))), this.rigPoses.element(rigB), this.rigPoses.element(rigB.add(uint(1)))) as unknown as Mat3).toVar()
      normalLocal.assign(skinned.element(uint(1)))
      vSeed.assign(seed)
      vLookLo.assign(float(word.bitAnd(uint(0xffff))))
      vLookHi.assign(float(word.shiftRight(uint(16))))
      // The wardrobe word's eight bits, then the hair's paint (look.ts HAIR_TEXTURE_STYLES: four bits, the hashed
      // styles' are all plain) and the headwear worn (three bits), so the fragment stage paints what the pieces show.
      const texture = HAIR_TEXTURE_STYLES.reduce((t: U1, set, bit) => t.bitOr(uint(set).shiftRight(style).bitAnd(uint(1)).shiftLeft(uint(bit))), uint(0))
      vWardrobe.assign(float(wardrobe.bitAnd(uint(0xff)).bitOr(select(custom, texture, uint(0)).shiftLeft(uint(8))).bitOr(headwear.shiftLeft(uint(8 + HAIR_TEXTURE_BITS)))))
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
      // Only a pass with a velocity target asks for the previous frame (the shadow map and ?cinema=0 never do). A body
      // wearing a rig is where the rig's shapes are, not where its walking twin's velocity would carry it: it writes
      // no motion of its own (sharp, like a still surface) rather than the twin's smear.
      if (needsPrevious(builder)) positionPrevious.assign(select(quad.w.greaterThan(uint(0)), placed, placed.sub(vec3(motion.x, 0, motion.y).mul(this.frameSeconds))))
      return placed
    })()
    m.positionNode = posed(true)
    m.castShadowPositionNode = posed(false)

    const rig = attribute('rig', 'vec3')
    // The slot, flat: each triangle takes its first vertex's, which the loft (humanoid.ts) makes the lower ring's, so a
    // band between two rings is one slot. Interpolated, rig.y would paint the slots numbered between the two as
    // stripes across the band (a jacket's hem over the trousers showed the shirt, the skin and the hair).
    const slot = varying(rig.y, 'vAgentSlot').setInterpolation('flat')
    // A pixel's width on the rest body (m), for the weaves' fading (weavePaint): a derivative, so it is read first, at
    // the top of the stage before any branch (shared, below), where every fragment of a quad still runs together.
    const footprint = fwidth(positionGeometry).length().max(0.00001).toVar() as unknown as F1
    // One node per link (built once, at the top of the stage: see shared below), however many paints read it.
    const links = new Map<number, F1>()
    const h = (k: number): F1 => {
      let link = links.get(k)
      if (link === undefined) links.set(k, (link = hash(vSeed.add(k * 7.919)).toVar() as unknown as F1))
      return link
    }
    // The colour lists on the GPU: one uniform array of every palette, a palette read at its offset (PALETTE_TABLE).
    const table = uniformArray(PALETTE_TABLE, 'color')
    const colour = (list: Color[], i: U1): V3 => table.element(i.add(uint(PALETTE_OFFSET.get(list)!))) as unknown as V3
    const pick = (list: Color[], hk: F1): V3 => colour(list, uint(hk.mul(list.length - 0.001)))
    // The hashed crowd wears the Monk scale's ten tones evenly (look.ts lookFromSeed: the same link, the same palette).
    const skin = pick(PALETTE.monk, h(1))
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
    // The genome's words 4 to 7 (look.ts LOOK_FIELD: the skin word, then the cloth word), the person's second quad of crowd.figure,
    // flat: one person's four integers in every fragment (an integer varying is never interpolated). Read only where
    // the look word says a look is worn: the hash's people leave them zero.
    const genome = varying(b.figure.element(b.lists.element(instanceIndex.add(uint(listBase))).mul(uint(FIGURE_QUADS)).add(uint(1))), 'vAgentGenome').setInterpolation('flat')
    const genomeWord = (w: number): U1 => (w === 4 ? genome.x : w === 5 ? genome.y : w === 6 ? genome.z : genome.w) as unknown as U1
    const gene = ([w, shift, width]: readonly [number, number, number]): U1 => genomeWord(w).shiftRight(uint(shift)).bitAnd(uint((1 << width) - 1))
    const at = (list: Color[], i: U1): V3 => {
      const last = uint(list.length - 1)
      return colour(list, select(i.lessThan(last), i, last))
    }
    const outfit = WARDROBE.outfits[variant]
    const cloth = (name: PaletteName): Color[] => PALETTE[name]
    const grey = vec3(0.6, 0.6, 0.58)
    const hairAt = field('hairColour')
    // The skin's options run on past the eight older tones into the Monk scale's ten (look.ts lookOptions: the skin
    // word holds the index's high bits), and the table holds the two palettes end to end (PALETTE: monk follows skin),
    // so one index from the older palette's offset reads either, bounded to the deepest tone.
    const skinAt = field('skin').bitOr(gene(LOOK_FIELD_HIGH.skin!).shiftLeft(uint(LOOK_FIELD.skin[2])))
    const lastSkin = uint(PALETTE.skin.length + PALETTE.monk.length - 1)
    const ownSkin = colour(PALETTE.skin, select(skinAt.lessThan(lastSkin), skinAt, lastSkin))
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
    // Vitiligo and freckles (look.ts WARDROBE.vitiligo, WARDROBE.freckles: the skin word's, or the fragment chain's as
    // lookFromSeed draws them), painted over the skin from the rest position so they keep their place as the body
    // moves; where they fall on a person is the person's own (an offset from their seed, like the iris).
    const vitiligo = select(custom, gene(LOOK_FIELD.vitiligo), select(h(LOOK_HASHED_COLOUR.vitiligo).greaterThanEqual(LOOK_ODDS.vitiligo), uint(h(LOOK_HASHED_COLOUR.vitiligoPattern).mul(WARDROBE.vitiligo.length - 1 - 0.001)).add(uint(1)), uint(0)))
    const freckles = select(custom, gene(LOOK_FIELD.freckles), select(h(LOOK_HASHED_COLOUR.freckles).greaterThanEqual(LOOK_ODDS.freckles), uint(h(LOOK_HASHED_COLOUR.frecklesDensity).mul(WARDROBE.freckles.length - 1 - 0.001)).add(uint(1)), uint(0)))
    const marked = skinMarks(toned, vitiligo, freckles, rig, vec3(h(LOOK_HASHED_COLOUR.marks), h(LOOK_HASHED_COLOUR.marks + 1), h(LOOK_HASHED_COLOUR.marks + 2)), slot, near)
    const wornSkin = mix(marked, vec3(dot(marked, vec3(0.2126, 0.7152, 0.0722))), age.mul(0.25)).toVar() as unknown as V3
    const greyed = mix(pickedHair, grey, smoothstep(0.5, 1, age)).toVar() as unknown as V3
    top = select(custom, ownTop, top)
    bottom = select(custom, ownBottom, bottom)
    shirt = select(custom, ownShirt, shirt)
    shoes = select(custom, ownShoes, shoes)
    // The wardrobe word the vertex stage resolved (look.ts LOOK_FIELD's word 3): the layer owns the top's dye (the
    // look's top index, or the hash's top link over this body's palette length, read from the coats under a coat: as
    // look.ts lookOptions offers them), the trim is matching (the top's cloth) or one of the trim cloths, the scarf one
    // of the scarf cloths (0 is none, and the piece is not drawn).
    const wardrobe = uint(vWardrobe.add(0.5))
    // The hair's paint and the headwear the vertex stage resolved (the look's, or the hash's), above the wardrobe's bits.
    const hairTexture = wardrobe.shiftRight(uint(8)).bitAnd(uint((1 << HAIR_TEXTURE_BITS) - 1))
    const headwear = wardrobe.shiftRight(uint(8 + HAIR_TEXTURE_BITS)).bitAnd(uint(7))
    const curl = select(custom, gene(LOOK_FIELD.curl), uint(h(LOOK_HASHED_COLOUR.curl).mul(WARDROBE.curl.length - 1 - 0.001)).add(uint(1)))
    const wornHair = hairPaint(greyed, wornSkin, hairTexture, curl, rig, slot, near).toVar() as unknown as V3
    // The headwear's cloth (the look's, or the colours' chain's), a head wrap's print in two shades of it, a beanie's
    // ribs; a kippah painted on the crown over the hair or the scalp; on the far body, which has no headwear pieces,
    // the hair's cap under any cover in the cloth.
    const headCloth = at(PALETTE.headwear, select(custom, gene(LOOK_FIELD.headwearColour), uint(h(LOOK_HASHED_COLOUR.headwearCloth).mul(PALETTE.headwear.length - 0.001))))
    const hw = (k: number) => headwear.equal(uint(k))
    const print = step(0.5, positionGeometry.y.mul(48).add(positionGeometry.x.mul(30)).add(positionGeometry.z.mul(30)).fract())
    const ribs = positionGeometry.x.mul(160).add(positionGeometry.z.mul(160)).sin().mul(0.05).add(1)
    const fabric = select(hw(HEADWEAR.headWrap), mix(headCloth, headCloth.mul(1.35).min(vec3(1)), print.mul(0.6)), select(hw(HEADWEAR.beanie), headCloth.mul(ribs), headCloth))
    const pieceIs = (p: number) => rig.z.greaterThan(p - 0.5).and(rig.z.lessThan(p + 0.5))
    const onHead = rig.x.greaterThan(BONE.HEAD - 0.5).and(rig.x.lessThan(BONE.HEAD + 0.5))
    const crownDisc = vec3(positionGeometry.x, 0, positionGeometry.z.add(0.015)).length().lessThan(0.058).and(positionGeometry.y.greaterThan(1.735))
    const kippah = hw(HEADWEAR.kippah).and(onHead).and(crownDisc).and(pieceIs(PIECE.TOP_BUN).not()).and(pieceIs(PIECE.FACE).not())
    const covered = headwear.notEqual(uint(HEADWEAR.none)).and(hw(HEADWEAR.kippah).not())
    const farCover = near ? float(0) : select(covered.and(pieceIs(PIECE.HAIR_CAP)), float(1), float(0))
    const hairShown = mix(select(kippah, headCloth, wornHair), fabric, farCover)
    // Facial hair (the look's, or a man's from the colours' chain: stubble to a full beard) in the hair's colour.
    const facialHair = select(custom, gene(LOOK_FIELD.facialHair), woman ? uint(0)
      : select(h(LOOK_HASHED_COLOUR.facialHair).greaterThanEqual(LOOK_ODDS.facialHair), uint(h(LOOK_HASHED_COLOUR.facialHairStyle).mul(FACIAL_HAIR.fullBeard - 0.001)).add(uint(1)), uint(0)))
    const skinShown = select(kippah, headCloth, facialPaint(wornSkin, greyed, facialHair, rig, slot, near)).toVar() as unknown as V3
    // A prosthetic limb (the look's, or one in a hundred from the colours' chain): the hand below the sleeve for an
    // arm, the shin below the knee for a leg where it is bare (the skirt suit's, or below cropped trousers and
    // culottes), in its finish, with the socket's line.
    const hashedLimb = h(LOOK_HASHED_COLOUR.prosthetic).greaterThanEqual(LOOK_ODDS.prosthetic)
    const prosthetic = select(custom, gene(LOOK_FIELD.prosthetic), select(hashedLimb, uint(h(LOOK_HASHED_COLOUR.prostheticLimb).mul(4 - 0.001)).add(uint(1)), uint(0)))
    const finish = select(custom, gene(LOOK_FIELD.prostheticFinish), select(hashedLimb, uint(h(LOOK_HASHED_COLOUR.prostheticFinish).mul(WARDROBE.prostheticFinish.length - 0.001)), uint(0)))
    const limb = (...kinds: number[]) => kinds.reduce((on: ReturnType<typeof prosthetic.equal>, k) => on.or(prosthetic.equal(uint(k))), prosthetic.equal(uint(255)))
    const boneIs = (k: number) => rig.x.greaterThan(k - 0.5).and(rig.x.lessThan(k + 0.5))
    const slotIs = (k: number) => slot.greaterThan(k - 0.5).and(slot.lessThan(k + 0.5))
    // The person's own left is +x, the bones' _R side (humanoid.ts: the _L bones are the side a viewer facing them sees on
    // their left), so a left arm or leg is the _R hand or shin.
    // The lower cut (look.ts bottomCut: the look's, or about one pair of trousers or skirt in three of the hash's, from
    // the body's eight): its lines are painted below; cropped trousers and culottes end above the ankle, bare or in a
    // sock as the skirt suit's hose is (the same link), where a prosthetic leg shows too (humanoid.ts LOWER_PAINT).
    const streetBottomCut = uint(BOTTOM_CUT_STREET_PACKED[variant]).shiftRight(uint(h(LOOK_HASHED_COLOUR.bottomCutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15))
    const bottomCut = select(custom, gene(LOOK_FIELD.bottomCut), select(h(LOOK_HASHED_COLOUR.bottomCut).greaterThanEqual(LOOK_ODDS.bottomCut), streetBottomCut, uint(0))).toVar() as unknown as U1
    const lowIs = (k: number) => bottomCut.equal(uint(k))
    const onLegBone = rig.x.greaterThan(BONE.THIGH_L - 0.5).and(rig.x.lessThan(BONE.FOOT_R + 0.5))
    const hemAt = variant === 3 ? float(-1) : select(lowIs(TROUSER_CUT.cropped), float(LOWER_PAINT.croppedHem), select(lowIs(TROUSER_CUT.culottes), float(LOWER_PAINT.culottesHem), float(-1)))
    const ankle = slotIs(SLOT.BOTTOM).and(onLegBone).and(positionGeometry.y.lessThan(hemAt))
    const armHere = slotIs(SLOT.SKIN).and(boneIs(BONE.HAND_R).and(limb(PROSTHETIC.leftArm, PROSTHETIC.bothArms)).or(boneIs(BONE.HAND_L).and(limb(PROSTHETIC.rightArm, PROSTHETIC.bothArms))))
    const legHere = slotIs(SLOT.LEGWEAR).and(positionGeometry.y.lessThan(0.46)).or(ankle)
      .and(boneIs(BONE.SHIN_R).and(limb(PROSTHETIC.leftLeg, PROSTHETIC.bothLegs)).or(boneIs(BONE.SHIN_L).and(limb(PROSTHETIC.rightLeg, PROSTHETIC.bothLegs))))
    const limbHere = armHere.or(legHere)
    const weave = step(0.5, positionGeometry.x.add(positionGeometry.z).mul(140).fract()).add(step(0.5, positionGeometry.y.mul(140).fract())).mod(2)
    const fin = (k: number) => finish.equal(uint(k))
    const finishColour = select(fin(0), vec3(0.23, 0.24, 0.26), select(fin(1), mix(vec3(0.07, 0.075, 0.08), vec3(0.14, 0.145, 0.15), weave), select(fin(2), vec3(0.72, 0.74, 0.77), wornSkin.mul(0.96))))
    const socketY = select(armHere, float(0.905), float(0.446))
    const limbColour = finishColour.mul(select(positionGeometry.y.sub(socketY).abs().lessThan(0.006), float(0.5), float(1)))
    const wfield = (s: 'layer' | 'trim' | 'scarf'): U1 => wardrobe.shiftRight(uint(LOOK_FIELD[s][1])).bitAnd(uint((1 << LOOK_FIELD[s][2]) - 1))
    const layer = wfield('layer')
    const trimAt = wfield('trim')
    const scarfAt = wfield('scarf')
    const coat = at(PALETTE.coats, select(custom, field('top'), uint(h(3).mul(cloth(outfit.top).length - 0.001))))
    const topCloth = select(layer.equal(uint(LAYER.coat)), coat, top)
    const trimCloth = select(trimAt.equal(uint(0)), topCloth, at(PALETTE.trims, trimAt.sub(uint(1))))
    const scarf = at(PALETTE.scarves, select(scarfAt.equal(uint(0)), uint(0), scarfAt.sub(uint(1))))
    // The jacket's lines, cut from the rest position (humanoid.ts GARMENT) over the top's slot: on the trunk's front the
    // shirt's V widens from where it closes to where the jacket opens, the lapels run beside it, above the opening the
    // shirt's collar stands, the collar band is the trunk's cloth above the collar line, the cuffs the arms' below the
    // cuff line; the coat's V closes higher. Under shirt sleeves the whole slot is the shirt's cloth: the jacket is off.
    // The cut (look.ts CUT: the look's, or three outer layers in ten of the hash's, from the body's eight) moves those
    // lines (where the V closes, where its centre runs, how wide the lapels are) and adds its own marks below; the notch
    // lapel (0) moves nothing, so a look without a cut is drawn as it always was.
    const rest = positionGeometry
    const onArm = rig.x.greaterThan(BONE.ARM_L - 0.5)
    const onTrunk = rig.x.lessThan(BONE.HEAD - 0.5)
    const isCoat = rig.z.greaterThan(PIECE.COAT - 0.5).and(rig.z.lessThan(PIECE.COAT + 0.5))
    const streetCut = uint(CUT_STREET_PACKED[variant]).shiftRight(uint(h(LOOK_HASHED_COLOUR.cutPick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15))
    const cut = select(custom, gene(LOOK_FIELD.cut), select(h(LOOK_HASHED_COLOUR.cut).greaterThanEqual(LOOK_ODDS.cut), streetCut, uint(0))).toVar() as unknown as U1
    const cutIs = (k: number) => cut.equal(uint(k))
    // Closed to the neck (a band collar, a zip, a side closure, the quilted jacket's): no V and no lapels.
    const closed = cutIs(CUT.band).or(cutIs(CUT.zip)).or(cutIs(CUT.side)).or(cutIs(CUT.quilted))
    const vest = cutIs(CUT.waistcoat)
    const knit = cutIs(CUT.cardigan)
    const tailored = select(isCoat, float(GARMENT.coatCloses), float(GARMENT.closes[variant]))
    // Double-breasted closes higher, the shawl lower, the waistcoat and the cardigan lowest (their V is deep).
    const closes = select(cutIs(CUT.doubleBreasted), tailored.add(0.05), select(cutIs(CUT.shawl), tailored.sub(0.02), select(vest, float(1.1), select(knit, float(1.14), tailored))))
    const half = float(GARMENT.halfAtCollar[variant]).mul(rest.y.sub(closes)).div(float(GARMENT.opens).sub(closes))
    // How far up the V a point is (0 where it closes, 1 at the opening): the peak lapels widen with it, and the wrap
    // front's V leans to the wearer's right toward where it closes; double-breasted closes off the centre.
    const upV = rest.y.sub(closes).div(float(GARMENT.opens).sub(closes)).clamp(0, 1)
    const centre = select(cutIs(CUT.doubleBreasted), float(0.02), select(cutIs(CUT.wrap), float(1).sub(upV).mul(-0.06), float(0)))
    const side = rest.x.sub(centre).abs()
    const front = onTrunk.and(rest.z.greaterThan(float(0))).and(rest.y.lessThan(float(GARMENT.opens)))
    // The front open to the hem: a strip of the shirt (of the trousers below the waist, under a coat) the whole way down.
    const openStrip = cutIs(CUT.open).and(front).and(side.lessThan(half.max(0.022)))
    const inV = front.and(rest.y.greaterThan(closes)).and(side.lessThan(half)).and(closed.not()).or(openStrip)
    const shirtCollar = onTrunk.and(rest.y.greaterThan(float(GARMENT.opens))).and(closed.not())
    const lapelWidth = select(cutIs(CUT.peak).or(cutIs(CUT.doubleBreasted)), upV.mul(upV).mul(1.4).add(1).mul(GARMENT.lapel),
      select(cutIs(CUT.shawl), float(GARMENT.lapel * 1.25), select(vest, float(0.008), select(knit, float(0.012), select(closed, float(0), float(GARMENT.lapel))))))
    const lapel = front.and(side.lessThan(half.add(lapelWidth))).and(closed.not())
    // A waistcoat's and a cardigan's neck is the shirt's collar; a closed cut's collar band stands from lower down.
    const collar = onTrunk.and(rest.y.greaterThan(select(closed, float(1.44), float(GARMENT.collar)))).and(vest.or(knit).not())
    const cuff = onArm.and(rest.y.lessThan(float(GARMENT.cuff)))
    // The weaves (look.ts WEAVE): the top's (the look's, or four tops in ten of the hash's from the body's eight) on the
    // outer layer's cloth, and the bottom's: the look's, or under `matching` (0) the top's where the trousers are the
    // jacket's cloth (a matching outfit's bottom 0, or the hash's matching trousers) and plain elsewhere. One paint for
    // the slot at hand, the top's cloth or the bottom's, declared with the shared values (below).
    const street = uint(WEAVE_STREET_PACKED[variant]).shiftRight(uint(h(LOOK_HASHED_COLOUR.weavePick).mul(8 - 0.001)).mul(uint(4))).bitAnd(uint(15))
    const topWeave = select(custom, gene(LOOK_FIELD.topWeave), select(h(LOOK_HASHED_COLOUR.weave).greaterThanEqual(LOOK_ODDS.weave), street, uint(0)))
    const matches = variant === 0 ? select(custom, bottomAt.equal(uint(0)), uint(1).equal(uint(1)))
      : variant === 2 ? select(custom, bottomAt.equal(uint(0)), h(10).lessThan(0.6)) : uint(0).equal(uint(1))
    const ownBottomWeave = gene(LOOK_FIELD.bottomWeave)
    const bottomWeave = select(custom.and(ownBottomWeave.notEqual(uint(0))), ownBottomWeave, select(matches, topWeave, uint(0)))
    // A high-waisted pair of trousers (look.ts bottomCut) where the waist shows, in shirt sleeves or under a cropped
    // jacket: the trousers' cloth, and its weave, up the trunk to 1.04.
    const waistShown = layer.equal(uint(LAYER.shirt)).or(cutIs(CUT.cropped).and(layer.equal(uint(LAYER.jacket))))
    const raisedWaist = variant === 3 ? uint(0).equal(uint(1))
      : lowIs(TROUSER_CUT.highWaisted).and(slotIs(SLOT.TOP)).and(onTrunk).and(isCoat.not()).and(rest.y.lessThan(1.04)).and(waistShown)
    const onBottom = slotIs(SLOT.BOTTOM).or(raisedWaist)
    const woven = weavePaint(select(onBottom, bottom, topCloth), select(onBottom, bottomWeave, select(slotIs(SLOT.TOP), topWeave, uint(0))), rig, select(raisedWaist, float(SLOT.BOTTOM), slot), footprint, near, variant === 3).toVar() as unknown as V3
    // The turtleneck's knit and the shirt in the V: a fine rib round the neck (the rib's mean past the pixel).
    const knitShirt = near ? shirt.mul(atan(rest.x, rest.z).mul(0.06 * 2 * Math.PI / 0.003).sin().mul(0.06).mul(float(1).sub(smoothstep(0.2, 0.45, footprint.div(0.003)))).add(1)) : shirt
    const neckline = select(cutIs(CUT.turtleneck), knitShirt, select(openStrip.and(rest.y.lessThan(0.95)), bottom, shirt))
    const faced = select(lapel.or(collar).or(cuff), select(trimAt.equal(uint(0)), woven, trimCloth), woven)
    const tailoredJacket = select(inV.or(shirtCollar), neckline, faced)
    // The cut's own marks over the cloth: the waistcoat's sleeves the shirt's and its back a dark lining; the cropped
    // jacket's shirt below the waist; a belt at the waist with its buckle; a column or two of buttons; the zip, the
    // side closure's line, the quilting's diamonds, the cardigan's rib, the patch pockets' stitching (the near body's).
    const vestArm = vest.and(onArm)
    const lining = vest.and(onTrunk).and(rest.z.lessThan(float(0)))
    const cropped = cutIs(CUT.cropped).and(onTrunk).and(isCoat.not()).and(rest.y.lessThan(1.06))
    const waist = rest.y.sub(1.04).abs()
    const belt = cutIs(CUT.belted).and(onTrunk).and(waist.lessThan(0.02))
    const buckle = belt.and(front).and(rest.x.abs().lessThan(0.02)).and(rest.x.abs().lessThan(0.011).and(waist.lessThan(0.011)).not())
    const beltCloth = select(trimAt.equal(uint(0)), topCloth.mul(0.7), trimCloth)
    // A column of `count` buttons at x = cx from y = top down, `step` apart: the nearest one's disc.
    const column = (cx: F1, top: F1, step: number, count: number) => {
      const n = top.sub(rest.y).div(step).add(0.5).floor().clamp(0, count - 1)
      return vec2(rest.x.sub(cx), rest.y.sub(top.sub(n.mul(step)))).length().lessThan(0.0085)
    }
    const sideLine = float(0.11).mul(float(1.47).sub(rest.y).div(0.08).clamp(0, 1))
    const buttons = front.and(select(cutIs(CUT.doubleBreasted), column(centre.add(0.055), closes.sub(0.02), 0.07, 3).or(column(centre.sub(0.055), closes.sub(0.02), 0.07, 3)),
      select(vest.or(knit), column(float(0), closes.sub(0.025), 0.052, 4),
        select(cutIs(CUT.band), column(float(0), float(1.42), 0.08, 5), select(cutIs(CUT.side), column(float(0.11), float(1.33), 0.1, 3), uint(0).equal(uint(1)))))))
    // Thin lines, smoothed over the pixel: the zip, the side closure's edge, the quilting, the pockets' stitches.
    const thin = (d: F1, width: number): F1 => float(width / 2).sub(d).div(footprint).add(0.5).clamp(0, 1)
    const zip = cutIs(CUT.zip).and(front)
    const closure = cutIs(CUT.side).and(front).and(rest.y.lessThan(1.47))
    const armAxis = float(LANDMARK.shoulderX * 1.06).mul(rest.x.sign())
    const around = atan(rest.x.sub(select(onArm, armAxis, float(0))), rest.z).mul(select(onArm, float(0.05), float(0.15)))
    const diamond = (t: F1): F1 => t.div(0.06).add(0.5).fract().sub(0.5).abs().mul(0.06)
    const quilting = near ? select(cutIs(CUT.quilted), thin(diamond(around.add(rest.y)).min(diamond(around.sub(rest.y))), 0.002), float(0)) : float(0)
    const rib = near ? select(knit, around.mul(2 * Math.PI / 0.004).sin().mul(0.05).mul(float(1).sub(smoothstep(0.2, 0.45, footprint.div(0.004)))), float(0)) : float(0)
    // The pockets: a flap at each hip and a welt on the wearer's left breast, outlined in a stitch.
    const outline = (x0: number, x1: number, y0: number, y1: number, x: F1): F1 => {
      const inside = x.greaterThan(x0).and(x.lessThan(x1)).and(rest.y.greaterThan(y0)).and(rest.y.lessThan(y1))
      const d = x.sub(x0).min(float(x1).sub(x)).min(rest.y.sub(y0)).min(float(y1).sub(rest.y))
      return select(inside, thin(d, 0.004), float(0))
    }
    const pockets = near ? select(cutIs(CUT.pockets).and(front), outline(0.045, 0.135, 1.0, 1.11, rest.x.abs()).max(outline(0.055, 0.115, 1.3, 1.355, rest.x)), float(0)) : float(0)
    // The peak, shawl, double-breasted and wrap lapels' outer edge, a fine line however the trim matches (the notch
    // lapel, as before, has none).
    const edged = cutIs(CUT.peak).or(cutIs(CUT.shawl)).or(cutIs(CUT.doubleBreasted)).or(cutIs(CUT.wrap))
    const lapelEdge = near ? select(edged.and(front).and(inV.not()), thin(side.sub(half.add(lapelWidth)).abs(), 0.004), float(0)) : float(0)
    // A closed cut's collar seam, where its band stands from.
    const seam = near ? select(closed.and(onTrunk), thin(rest.y.sub(1.44).abs(), 0.003), float(0)) : float(0)
    const stitched = mix(tailoredJacket.mul(float(1).add(rib)), tailoredJacket.mul(0.45),
      quilting.max(pockets).max(lapelEdge).max(seam).max(select(zip, thin(rest.x.abs(), 0.007), float(0))).max(select(closure, thin(rest.x.sub(sideLine).abs(), 0.006), float(0))))
    const jacket = select(vestArm.or(cropped), shirt, select(lining, topCloth.mul(0.55), select(buckle, vec3(0.62, 0.6, 0.55), select(belt, beltCloth,
      select(buttons, topCloth.mul(0.35).add(0.02), select(zip.and(rest.x.abs().lessThan(0.0035)), vec3(0.52, 0.52, 0.54), stitched))))))
    // The lower cut's lines, from the rest position as the jacket's are (its shapes are the vertex stage's: crowdBody.ts
    // bodyGarment). The trousers, each half about its own leg's axis: a pressed crease down the front and the back,
    // pleats from the waist, turn-ups at the hem, a satin side stripe or a piped seam down the outside, the cropped
    // hem and the culottes' above the ankle, a belt where the waist shows. The skirt, round the trunk's axis: pleats,
    // box pleats or panels, the wrap's edge, a back vent, a button front, the tulip's petals, a belt over the waist,
    // the high waist's seam, the flared skirt's folds. The fine lines are the near body's.
    const leather = vec3(0.09, 0.07, 0.06)
    const metal = vec3(0.62, 0.6, 0.55)
    let bottomShown: V3
    let lowMarks: ReturnType<typeof onTrunk.and>
    let stripe: ReturnType<typeof onTrunk.and>
    if (variant === 3) {
      const phi = atan(rest.x, rest.z)
      // The distance round the skirt (at a 20 cm radius) to the nearest of n seams.
      const seams = (n: number): F1 => phi.mul(n / (2 * Math.PI)).add(0.5).fract().sub(0.5).abs().mul((2 * Math.PI * 0.2) / n)
      const below = float(1).sub(smoothstep(0.9, 0.96, rest.y))
      const pleats = select(lowIs(SKIRT_CUT.pleated), thin(seams(28), 0.0025), select(lowIs(SKIRT_CUT.boxPleat), thin(seams(10).sub(0.012).abs(), 0.0025),
        select(lowIs(SKIRT_CUT.panelled), thin(seams(6), 0.0025), float(0)))).mul(below)
      const wrapEdge = select(lowIs(SKIRT_CUT.wrap).and(rest.z.greaterThan(0)).and(rest.y.lessThan(0.98)), thin(rest.x.sub(float(0.07).sub(float(0.98).sub(rest.y).mul(0.32))).abs(), 0.003), float(0))
      const vent = select(lowIs(SKIRT_CUT.backVent).and(rest.z.lessThan(0)).and(rest.y.lessThan(0.68)), thin(rest.x.abs(), 0.006), float(0))
      const petals = select(lowIs(SKIRT_CUT.tulip).and(rest.z.greaterThan(0)).and(rest.y.lessThan(0.8)), thin(rest.x.abs().sub(float(0.8).sub(rest.y).pow(2).mul(0.9).add(0.015)).abs(), 0.003), float(0))
      const waistSeam = select(lowIs(SKIRT_CUT.highWaisted), thin(rest.y.sub(1.0).abs(), 0.003), float(0))
      const folds = select(lowIs(SKIRT_CUT.flared), phi.mul(14).cos().mul(0.1).mul(float(1).sub(smoothstep(0.62, 0.92, rest.y))), float(0))
      const lines = near ? pleats.max(wrapEdge).max(vent).max(petals).max(waistSeam) : float(0)
      const cloth = mix(woven.mul(near ? folds.add(1) : float(1)), woven.mul(0.5), lines)
      const skirtButtons = lowIs(SKIRT_CUT.buttonFront).and(front).and(rest.y.lessThan(0.98)).and(column(float(0), float(0.95), 0.07, 6))
      const belt = lowIs(SKIRT_CUT.belted).and(onTrunk).and(rest.y.greaterThan(0.985))
      const buckle = belt.and(rest.z.greaterThan(0)).and(rest.x.abs().lessThan(0.018))
      bottomShown = select(buckle, metal, select(belt, leather, select(skirtButtons, bottom.mul(0.35).add(0.02), cloth)))
      lowMarks = belt.or(skirtButtons)
      stripe = uint(0).equal(uint(1))
    } else {
      const legX = rest.x.sub(float(LANDMARK.hipX).mul(rest.x.sign()))
      const outside = legX.mul(rest.x.sign()).greaterThan(0)
      const trousers = slotIs(SLOT.BOTTOM).and(onLegBone.or(onTrunk))
      const pleated = lowIs(TROUSER_CUT.pleated).or(lowIs(TROUSER_CUT.pleatedTurnUps))
      const creased = lowIs(TROUSER_CUT.crease).or(pleated)
      const crease = select(creased.and(onLegBone).and(rest.y.lessThan(0.86)).and(rest.z.abs().greaterThan(0.02)), thin(legX.abs(), 0.003), float(0))
      const pleatLines = select(pleated.and(trousers).and(rest.z.greaterThan(0)).and(rest.y.greaterThan(0.7)), thin(legX.abs().sub(0.028).abs(), 0.003).mul(smoothstep(0.7, 0.8, rest.y)), float(0))
      const turned = lowIs(TROUSER_CUT.turnUps).or(lowIs(TROUSER_CUT.pleatedTurnUps)).and(onLegBone).and(rest.y.lessThan(0.15))
      const turnLine = select(turned, thin(rest.y.sub(0.145).abs(), 0.003), float(0))
      const hemLine = select(onLegBone.and(hemAt.greaterThan(0)), thin(rest.y.sub(hemAt).abs(), 0.003), float(0))
      const piping = near ? select(lowIs(TROUSER_CUT.piped).and(trousers).and(outside), thin(rest.z.abs(), 0.0025), float(0)) : float(0)
      const lines = near ? pleatLines.max(turnLine).max(hemLine) : float(0)
      const lit = woven.mul(near ? crease.mul(0.35).add(1) : float(1))
      const cloth = mix(mix(lit, lit.mul(0.5), lines), bottom.mul(1.5).add(0.06).min(vec3(1)), piping)
      const turnedCloth = select(turned.and(rest.y.lessThan(0.143)), cloth.mul(0.88), cloth)
      stripe = lowIs(TROUSER_CUT.sideStripe).and(trousers).and(outside).and(rest.z.abs().lessThan(0.007))
      // The belt on the seat, and on the thighs' tops where they stand out of it at the hips (the suit's sits that low).
      const belt = lowIs(TROUSER_CUT.belted).and(waistShown).and(onTrunk.or(onLegBone)).and(rest.y.sub(JACKET_HEM[variant] - 0.018).abs().lessThan(0.016))
      const buckle = belt.and(rest.z.greaterThan(0)).and(rest.x.abs().lessThan(0.018))
      const ankleCloth = mix(wornSkin, vec3(0.08, 0.07, 0.07), step(0.55, h(11)))
      // Below the culottes' hem the leg narrows back to the calf: the hem's shadowed inside, then the leg.
      const inside = ankle.and(lowIs(TROUSER_CUT.culottes)).and(rest.y.greaterThan(LOWER_PAINT.culottesInside))
      bottomShown = select(ankle, select(inside, woven.mul(0.3), select(legHere, limbColour, ankleCloth)), select(buckle, metal, select(belt, leather, select(stripe, bottom.mul(0.7), turnedCloth))))
      lowMarks = ankle.or(belt)
    }
    // The high waist's top seam, over the trousers' cloth up the trunk.
    const waistBand = near ? mix(woven, woven.mul(0.5), thin(rest.y.sub(1.035).abs(), 0.003)) : woven
    const worn = select(raisedWaist, waistBand, select(layer.equal(uint(LAYER.shirt)), shirt, jacket))
    // Where the woven cloth shows (the jacket or the coat itself, a matching trim, the trousers or the skirt), the cloths
    // with a sheen of their own set it (WEAVE_SHEEN), and the rest keep the slot's; a shawl collar's facing and a
    // waistcoat's lining are satin.
    const outer = slotIs(SLOT.TOP).and(layer.notEqual(uint(LAYER.shirt)))
    const cutMarks = vestArm.or(cropped).or(belt).or(buttons).or(zip.and(rest.x.abs().lessThan(0.0035)))
    const shownWeave = select(onBottom, select(lowMarks, uint(255), bottomWeave), select(outer.and(inV.or(shirtCollar).not())
      .and(lapel.or(collar).or(cuff).and(trimAt.notEqual(uint(0))).not()).and(cutMarks.not()).and(lining.not()), topWeave, uint(0)))
    const satin = outer.and(lining.or(cutIs(CUT.shawl).and(lapel.or(collar)).and(inV.or(shirtCollar).not()))).or(stripe)
    const sheen = select(satin, float(0.45), WEAVE_SHEEN.reduce((r: F1, [k, value]) => select(shownWeave.equal(uint(k)), float(value), r), float(-1))).toVar() as unknown as F1
    // The suit's tie keeps the hash's cloth; the other bodies' accent is the shirt. The skirt suit's hose is the hash's.
    const accent = variant === 0 ? pick(PALETTE.ties, h(5)) : shirt
    const legwear = variant === 3 ? mix(wornSkin, vec3(0.08, 0.07, 0.07), step(0.55, h(11))) : bottom
    const device = vec3(0.17, 0.175, 0.18)
    const prop = select(rig.z.greaterThan(PIECE.CUP - 0.5), vec3(0.93, 0.92, 0.9), pick(PALETTE.bags, h(12)))
    const frame = vec3(0.05, 0.05, 0.055)
    // The eyes: their whites, an iris the hash picks (the words have no room for it), and the lips a shade of the skin.
    const white = vec3(0.88, 0.86, 0.84)
    const iris = pick(PALETTE.iris, h(LOOK_HASHED_COLOUR.iris))
    const lip = wornSkin.mul(vec3(0.82, 0.55, 0.55))
    // The turtleneck's knit up the neck (the trunk's skin), under a jacket or a coat.
    const turtleNeck = cutIs(CUT.turtleneck).and(layer.notEqual(uint(LAYER.shirt))).and(onTrunk)
    const slots: V3[] = [worn, shirt, select(turtleNeck, knitShirt, select(armHere, limbColour, skinShown)), hairShown, bottomShown, shoes, accent, prop, select(legHere, limbColour, legwear), frame, white, iris, lip, scarf, fabric, device]
    const rough = [0.82, 0.7, 0.55, 0.6, 0.8, 0.35, 0.6, 0.45, 0.6, 0.3, 0.25, 0.3, 0.5, 0.78, 0.8, 0.4]
    let color: V3 = slots[slots.length - 1]
    let roughness: F1 = float(rough[rough.length - 1])
    for (let s = slots.length - 2; s >= 0; s--) {
      color = select(slot.lessThan(s + 0.5), slots[s], color)
      roughness = select(slot.lessThan(s + 0.5), float(rough[s]), roughness)
    }
    // three writes each branch of a select out on its own (ConditionalNode isolates them), so a value two slots read,
    // first reached inside one branch, was written again in every other branch that read it, and the rain-mode and
    // dissolve wraps read the colour a second time: the fragment stage grew past its budget (shadowShaders.test.ts).
    // Declared once at the top of the stage instead, before any branch, every later read is the variable: the links,
    // the skin and the hair as painted, the colour. Each paint still pays for its marks under its own branches.
    // (The variables are the call's inputs, so the colour graph is still walked from colorNode: lookWiring.test.ts.)
    const shared = [footprint, ...links.values(), cut, bottomCut, wornSkin, greyed, wornHair, skinShown, woven, sheen, color.toVar()] as unknown as Node[]
    const declared = Fn((nodes: Node[]) => {
      for (const n of nodes) (n as unknown as { toStack(): unknown }).toStack()
      return nodes[nodes.length - 1]
    }) as unknown as (...inputs: Node[]) => V3
    m.colorNode = declared(...shared)
    // A prosthetic's finish has its own sheen: chrome is a metal, carbon a satin, matte and a cover the skin's.
    const chrome = limbHere.and(fin(2))
    m.roughnessNode = select(chrome, float(0.22), select(limbHere.and(fin(1)), float(0.4), select(sheen.greaterThanEqual(0), sheen, roughness)))
    m.metalnessNode = select(chrome, float(0.85), float(0))
    // Matrix mode (matrixMode.ts), over the body's own colour; the dissolve below reads the dimmed colour as its base.
    if (this.matrixMode) applyMatrixMode(m, this.matrixMode)
    // The code dissolve, over everything above, with the body's feet as its origin (fresh reads: nothing of posed()'s
    // graph is shared across the fold's branches).
    const feet = b.pos.element(b.lists.element(instanceIndex.add(uint(listBase)))).xyz
    applyCodeDissolve(m, vDissolve, feet, PEOPLE_DISSOLVE_INK)
    // The shadow pass multiplies its alpha by the colour's (three's Renderer._getShadowNodes reads colorNode.a), which
    // wrote the whole paint, every weave and cut, into the shadow map's fragment stage, run for every texel a body
    // covers, for an alpha that is always 1: the crowd is opaque. The colour answers `.a` with 1 itself (an own value
    // over the swizzle three puts on every node's prototype, whose setter would assign instead), so the shadow pass
    // draws the pose and the dissolve's shadow mask alone (shadowShaders.test.ts pins its size).
    Object.defineProperty(m.colorNode, 'a', { value: float(1) })
    return m
  }
}
