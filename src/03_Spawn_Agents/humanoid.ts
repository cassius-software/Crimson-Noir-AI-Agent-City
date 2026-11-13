// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the person the crowd is made of: one smooth humanoid, lofted from rings (the
 * trunk, the neck and head with its face, each arm with its hand, each leg with its shoe, and the four outfits'
 * garments, a hem, a skirt, a coat, a tie, a scarf, the hair in its styles, glasses, a bag, a cup; the shirt's V,
 * the lapels, the collar and the cuffs are lines the fragment stage draws on the cloth, GARMENT) over a skeleton of
 * fifteen bones, every vertex tied to two of them, the body sliders that reshape it (height, mass, muscle, shoulders,
 * hips, leg length, posture, head) and the face sliders that reshape the head's features (brow, jaw, chin, cheek,
 * nose, eyes, lips), the walk (each leg solved from where its foot is, so a planted foot keeps its spot of ground;
 * the arms swinging against them) and the gaze (the head and the chest turned toward the operator near by, or the
 * way the person goes), as arithmetic the crowd's vertex stage (crowd.ts) runs on the GPU and this module runs on the
 * CPU, so the card's silhouette, the tests and the shader agree to the number. Everything here is written by hand for
 * this product: no imported mesh, skeleton, morph target or motion capture. Pure: no three, no DOM, no GPU, no clock,
 * no randomness.
 * What breaks if it is removed? The crowd has no body to draw, and the sliders have nothing to move.
 *
 * Frame: metres, feet on y = 0, the person faces +z. "Left" in this file (the _L bones, the cup's hand) is −x, the
 * side a viewer facing them sees on their left, which is the person's own right in three's right-handed frame; the
 * hearing devices' pieces (AID_L, COIL_L) are named for the person's own side. The base person is HEIGHT_BASE tall;
 * the sliders move away from them. Bones (BONE): the trunk bends about the hip; the chest twists about the spine;
 * the head nods about the neck; each leg is thigh, shin and foot about the hip, knee and ankle; each arm is upper
 * arm, forearm and hand about the shoulder, elbow and wrist. A vertex carries its slot (the colour the fragment stage
 * paints it, crowd.ts), its optional piece (drawn only when the person's mask has the bit), its two bones with a
 * weight, and on the head its face region with a weight, in three attributes the geometry carries: `rig` = (bone,
 * slot, piece), `skin` = (second bone, weight of the first), `face` = (region, weight; zero off the head).
 */

/** The base person's height, m: a slider's height of 1.75 m draws the rings exactly as written here. */
export const HEIGHT_BASE = 1.75

/** The bones, in the order the vertex stage's chain walks them. */
export const BONE = Object.freeze({
  TRUNK: 0, CHEST: 1, HEAD: 2,
  THIGH_L: 3, SHIN_L: 4, FOOT_L: 5, THIGH_R: 6, SHIN_R: 7, FOOT_R: 8,
  ARM_L: 9, FOREARM_L: 10, HAND_L: 11, ARM_R: 12, FOREARM_R: 13, HAND_R: 14,
})
export const BONES = 15

/** The colour slots the fragment stage paints (crowd.ts: the top, the shirt, the skin, ..., the eye's white, the iris, the lips). */
export const SLOT = Object.freeze({ TOP: 0, SHIRT: 1, SKIN: 2, HAIR: 3, BOTTOM: 4, SHOES: 5, ACCENT: 6, PROP: 7, LEGWEAR: 8, FRAME: 9, EYE: 10, IRIS: 11, LIP: 12, SCARF: 13, HEADWEAR: 14, DEVICE: 15 })
export const SLOTS = 16
/**
 * The optional pieces, one bit each in a person's piece mask (look.ts LOOK_PIECE_BIT; 0 is "always drawn"). The hair
 * is pieces too: the cap (every style but bald), long hair, a bob, a bun. FACE is the features (eyes, brows, nose,
 * lips, ears): the eye pass sets its bit, the shadow pass leaves it clear. COAT is the outer layer over the jacket
 * (look.ts LAYER.coat), SCARF the wrap and tail round the neck. The later hair pieces: VOLUME a full rounded shell
 * (an afro, big curls), TOP_BUN a puff or knot on the crown, PONYTAIL a tail from the back of the head. The headwear
 * (look.ts HEADWEAR, cloth slot HEADWEAR): WRAP a head scarf over the head, the ears and the neck with the face open,
 * TURBAN a wound crown above the brow (a turban, a head wrap), HAT a snug crown (a beanie, a durag, a flat cap's) and
 * BRIM a flat cap's peak; the near body alone has them: the far body keeps the hair's cap under them in the
 * headwear's cloth (crowd.ts). A kippah is painted on the crown (crowd.ts), not a piece. BEARD is a long beard below
 * the chin (shorter facial hair is painted); AID_L and AID_R a hearing aid behind each ear, COIL_L and COIL_R a
 * cochlear implant's processor behind the ear with its coil on the side of the head (look.ts HEARING; device slot
 * DEVICE), each named for the person's own left (+x) or right (−x). From 24 the pieces are past the mask's bits (a
 * float holds bits 1 to 24 exactly) and are worn by a code instead (look.ts LOOK_CODED_PIECE, crowdBody.ts bodyVertex):
 * the umbrella in the cup's hand, furled short (UMBRELLA_FOLDING), furled long (UMBRELLA_WALKING) or open over the head
 * (UMBRELLA_OPEN, on the chest, the arm held up to its shaft); and the headphones on the head, over-ear (HEADPHONES),
 * on-ear (ON_EAR) or in the ears (EARBUDS), in the device slot; and a heel under each shoe, a block (HEEL_BLOCK), a
 * mid heel (HEEL_MID) or a high one (HEEL_HIGH), in the shoe's slot. Every one is the near body's alone.
 */
export const PIECE = Object.freeze({
  NONE: 0, TIE: 1, BAG: 2, CUP: 3, LONG_HAIR: 4, GLASSES: 5, HAIR_CAP: 6, BOB: 7, BUN: 8, FACE: 9, COAT: 10, SCARF: 11,
  VOLUME: 12, TOP_BUN: 13, PONYTAIL: 14, WRAP: 15, TURBAN: 16, HAT: 17, BRIM: 18,
  BEARD: 19, AID_L: 20, AID_R: 21, COIL_L: 22, COIL_R: 23,
  UMBRELLA_FOLDING: 24, UMBRELLA_WALKING: 25, UMBRELLA_OPEN: 26, HEADPHONES: 27, ON_EAR: 28, EARBUDS: 29,
  HEEL_BLOCK: 30, HEEL_MID: 31, HEEL_HIGH: 32,
})

/**
 * The parts of a garment the fragment stage paints on the cloth (slot TOP) from a vertex's rest position and bone
 * (crowd.ts), so their lines are exact however coarse the loft and the far body gets them for free: the collar band
 * above `collar`; the shirt's V on the front within a lateral half-width that grows from nothing where the jacket
 * closes (`closes`, per body) to `halfAtCollar` at `opens`; the lapels within `lapel` beside the V; the cuffs on the
 * arms (bones ARM_L and up) below `cuff`. A coat shell (piece COAT) carries the same cloth and the same parts. The
 * card's silhouette paints by ring and shows none of them.
 */
export const GARMENT = Object.freeze({
  collar: 1.475,
  opens: 1.5,
  closes: Object.freeze([1.2, 1.28, 1.24, 1.24]),
  coatCloses: 1.38,
  halfAtCollar: Object.freeze([0.065, 0.075, 0.065, 0.07]),
  lapel: 0.03,
  cuff: 0.965,
})

/**
 * Where the base person's joints are, m (y up the body, x out to the side). The vertex stage takes them as
 * constants (crowd.ts writes them into its WGSL from here), so the skeleton the shader turns is the one the rings
 * were lofted round.
 */
export const LANDMARK = Object.freeze({
  ankle: 0.08, knee: 0.5, hip: 0.92, hipX: 0.095,
  chestPivot: 1.2, shoulder: 1.45, shoulderX: 0.2, elbow: 1.17, wrist: 0.92, neck: 1.52,
})

/**
 * The lower garment's cuts: one list for the three trouser bodies, one for the skirt suit's (look.ts
 * WARDROBE.trouserCut, WARDROBE.skirtCut name them in this order). Cut 0 is the straight leg or the straight skirt
 * every body already wore, so a look without a cut is drawn as it always was. Some cuts reshape the cloth
 * (TROUSER_SHAPE, SKIRT_SHAPE: garmentPoint and its GPU twin, crowdBody.ts bodyGarment); the fragment stage paints
 * the rest on it (crowd.ts).
 */
export const TROUSER_CUT = Object.freeze({
  straight: 0, crease: 1, pleated: 2, turnUps: 3, sideStripe: 4, wideLeg: 5, tapered: 6, flared: 7,
  cropped: 8, culottes: 9, highWaisted: 10, belted: 11, piped: 12, slim: 13, pleatedTurnUps: 14, palazzo: 15,
})
export const SKIRT_CUT = Object.freeze({
  straight: 0, pencil: 1, aLine: 2, pleated: 3, boxPleat: 4, wrap: 5, midi: 6, midiPencil: 7,
  midiALine: 8, backVent: 9, buttonFront: 10, tulip: 11, panelled: 12, highWaisted: 13, belted: 14, flared: 15,
})

/**
 * Heights the lower cuts are shaped by, m on the base body: the skirt's waist ring (above it the high waist raises
 * the skirt, below it a midi lengthens it) and hem; where a slim leg starts and finishes narrowing; where a taper
 * takes hold below the knee and the ankle its slope counts from; the tulip's bulge over the hips; where the skirt
 * starts to follow the legs (followFrom, just under its top ring) and from where it follows them as fully as its cut
 * says (followTo, a short skirt's mid-thigh ring and a midi's knee), how far either side of x = 0 its sides reach
 * (|z| under followSide), how much of the knee's bend a shin passes on to a midi's hem (followKnee: all of it lifts
 * the hem's back over the ring above it as the calf kicks up), over how many metres of the two legs' reach the front
 * and the back hand over from one leg to the other (followEase), how much of the legs' carry a coat's panels below
 * the waist take, and every skirt under a coat (coatFollow), and from where they start to (coatFrom: between the hip
 * and the coat's waist ring; hung from the waist ring, a panel at a desk lean pressed 0.6 cm into a slumped back, and
 * hung from the hip its band above followTo tilted half again as far as the thigh), as skirtFollow, skirtLeft and
 * coatFollow read them.
 */
export const LOWER = Object.freeze({
  waist: 0.92, hem: 0.56, top: 1.02,
  slimFrom: 0.85, slimTo: 0.5, taperFrom: 0.62, taperTo: 0.5, ankle: 0.095,
  bulgeAt: 0.84, bulgeHalf: 0.14, pencilFrom: 0.85, followFrom: 1, followTo: 0.7, followSide: 0.02,
  followKnee: 0.6, followEase: 0.1, coatFollow: 0.9, coatFrom: 0.98,
})

/**
 * Where the fragment stage ends the shorter trousers (crowd.ts), m: the cropped pair above the ankle, the culottes at
 * the leg's 0.34 ring, the last one TROUSER_SHAPE widens (the band below it narrows back to the calf, painted as the
 * hem's shadowed inside down to culottesInside, the leg below that).
 */
export const LOWER_PAINT = Object.freeze({ croppedHem: 0.19, culottesHem: 0.34, culottesInside: 0.27 })

/**
 * How each trouser cut reshapes a leg about its own axis (x = ±LANDMARK.hipX, z = 0), as
 * [slim, wide, flare, wideAbove, wideTop, wideFull, taper, taperSlope]: a ring's radius r becomes r·(1 − slim·t),
 * t rising from LOWER.slimFrom down to LOWER.slimTo; is raised toward wide + flare·(knee − y) (the flare grows below
 * the knee only) as y falls from wideTop to wideFull, at or above wideAbove alone (the culottes' hem); and is lowered
 * toward taper + taperSlope·(y − LOWER.ankle) as y falls from LOWER.taperFrom to LOWER.taperTo. Zeros reshape
 * nothing: the painted cuts.
 */
export const TROUSER_SHAPE: readonly (readonly number[])[] = Object.freeze([
  [0, 0, 0, 0, 0, 0, 0, 0], // straight
  [0, 0, 0, 0, 0, 0, 0, 0], // pressed crease
  [0, 0, 0, 0, 0, 0, 0, 0], // pleated
  [0, 0, 0, 0, 0, 0, 0, 0], // turn-ups
  [0, 0, 0, 0, 0, 0, 0, 0], // side stripe
  [0, 0.08, 0, 0, 0.82, 0.6, 0, 0], // wide-leg: about 8 cm round from the thigh down
  [0, 0, 0, 0, 0, 0, 0.036, 0.05], // tapered: 3.6 cm at the ankle
  [0, 0.058, 0.09, 0, 0.56, 0.48, 0, 0], // flared: from the knee, 9.4 cm round at the hem
  [0, 0, 0, 0, 0, 0, 0, 0], // cropped
  [0, 0.085, 0, 0.29, 0.82, 0.6, 0, 0], // culottes: wide down to the calf
  [0, 0, 0, 0, 0, 0, 0, 0], // high-waisted
  [0, 0, 0, 0, 0, 0, 0, 0], // belted
  [0, 0, 0, 0, 0, 0, 0, 0], // piped seam
  [0.1, 0, 0, 0, 0, 0, 0, 0], // slim: a tenth narrower from the hip down
  [0, 0, 0, 0, 0, 0, 0, 0], // pleated turn-ups
  [0, 0.095, 0, 0, 0.86, 0.66, 0, 0], // palazzo: wider, from higher up
].map((row) => Object.freeze(row)))

/**
 * How each skirt cut reshapes the skirt about the trunk's axis, as
 * [flare, flareTop, pencil, length, bulge, raise, narrowTop, follow]: every radius scales by 1 + flare·t(flareTop
 * down to LOWER.hem) + bulge·hat(LOWER.bulgeAt, LOWER.bulgeHalf) − pencil·t(LOWER.pencilFrom down to LOWER.hem) −
 * narrowTop·t(LOWER.waist up to LOWER.top); below LOWER.waist the skirt stretches down by `length` (1.556 takes the
 * hem from 0.56 to a midi's 0.36), above it rises by `raise` per metre (0.8 takes the top from 1.02 to 1.1). Under a
 * coat no skirt widens (the coat hems where the skirt does). `follow` is how much of the skirt a leg carries from
 * LOWER.followTo down (skirtFollow, skirtLeft, skirtPose; crowdBody.ts bodyVertex): hung from the trunk alone, a
 * skirt lets the swung thigh through its front mid-stride (6 to 18 cm on the CPU at a brisk walk). The front follows
 * the leg that carries it furthest forward, the back the one that carries it furthest back and the sides the leg on
 * their own side; a midi's hem below the knee hangs from the shin, so it swings over the shin instead of standing out
 * on the thigh's lever. Each value is about the least that keeps the legs inside at a walk (the midi pencil's narrow
 * hem still lets a bent knee show a centimetre or two at the far end of a stride) without tilting the hem's front
 * further than the thigh. Under a coat every skirt, the straight one too, follows as the coat does (coatFollow),
 * so it stays inside the coat as both swing. Zeros, and length 1, reshape nothing.
 */
export const SKIRT_SHAPE: readonly (readonly number[])[] = Object.freeze([
  [0, 0.92, 0, 1, 0, 0, 0, 0], // straight
  [0, 0.92, 0.22, 1, 0, 0, 0, 0.9], // pencil
  [0.24, 0.95, 0, 1, 0, 0, 0, 0.6], // A-line
  [0.08, 0.92, 0, 1, 0, 0, 0, 0.7], // pleated
  [0.1, 0.92, 0, 1, 0, 0, 0, 0.7], // box pleat
  [0.05, 0.92, 0, 1, 0, 0, 0, 0.7], // wrap
  [0, 0.92, 0, 1.556, 0, 0, 0, 0.9], // midi
  [0, 0.92, 0.2, 1.556, 0, 0, 0, 0.9], // midi pencil
  [0.3, 0.95, 0, 1.556, 0, 0, 0, 0.8], // midi A-line
  [0, 0.92, 0, 1, 0, 0, 0, 0.8], // back vent
  [0, 0.92, 0, 1, 0, 0, 0, 0.8], // button front
  [0, 0.92, 0.16, 1, 0.06, 0, 0, 0.9], // tulip
  [0.12, 0.92, 0, 1, 0, 0, 0, 0.7], // panelled
  [0, 0.92, 0, 1, 0, 0.8, 0.1, 0.8], // high-waisted
  [0, 0.92, 0, 1, 0, 0, 0, 0.8], // belted
  [0.42, 0.98, 0, 1, 0, 0, 0, 0.5], // flared
].map((row) => Object.freeze(row)))

/** The body sliders, each 0..1 but the height in metres. */
export interface BodyShape {
  readonly height: number
  readonly mass: number
  readonly muscle: number
  readonly shoulders: number
  readonly hips: number
  readonly legs: number
  readonly posture: number
  readonly head: number
}

/** The base person: every slider halfway, HEIGHT_BASE tall. */
export const SHAPE_NEUTRAL: BodyShape = Object.freeze({ height: HEIGHT_BASE, mass: 0.5, muscle: 0.5, shoulders: 0.5, hips: 0.5, legs: 0.5, posture: 0.5, head: 0.5 })

/**
 * What a slider's 0..1 becomes: a factor base + t × range (the girths, the widths, the lengths), the posture's lean
 * in radians ((0.5 − t) × slouch: forward when slumped, a little back when upright) and the gait's swing factor. The
 * shader takes these as constants from here.
 */
export const MORPH = Object.freeze({
  legs: Object.freeze({ base: 0.92, range: 0.16 }),
  shoulders: Object.freeze({ base: 0.86, range: 0.28 }),
  hips: Object.freeze({ base: 0.86, range: 0.28 }),
  mass: Object.freeze({ base: 0.78, range: 0.44 }),
  muscle: Object.freeze({ base: 0.86, range: 0.28 }),
  head: Object.freeze({ base: 0.92, range: 0.16 }),
  slouch: 0.16,
  gait: Object.freeze({ base: 0.75, range: 0.5 }),
})

/**
 * Where on the trunk each slider acts: a hat of this half-width about this height (1 at the centre, 0 at the
 * edges), so a wider shoulder line leaves the waist alone. The shoulder and hip hats peak where the arms and legs
 * hang, so the trunk's widening there is exactly the limbs' sideways shift (one stretch, no step).
 */
export const REGION = Object.freeze({
  shoulder: Object.freeze({ at: 1.44, half: 0.16 }),
  hip: Object.freeze({ at: 0.92, half: 0.14 }),
  waist: Object.freeze({ at: 1.03, half: 0.22 }),
  chest: Object.freeze({ at: 1.36, half: 0.18 }),
  belly: Object.freeze({ at: 1.0, half: 0.16 }),
})

/** How much of the mass and muscle each limb takes (the trunk takes the hats above). */
export const LIMB_GIRTH = Object.freeze({
  thigh: Object.freeze({ mass: 0.45, muscle: 0.35 }),
  shin: Object.freeze({ mass: 0.25, muscle: 0.3 }),
  arm: Object.freeze({ mass: 0.4, muscle: 0.5 }),
  forearm: Object.freeze({ mass: 0.2, muscle: 0.35 }),
  head: Object.freeze({ mass: 0.12, muscle: 0 }),
})

/** The walk: the amplitudes the phase drives (crowd.wgsl's vel.z is the phase, vel.w the speed). */
export const WALK = Object.freeze({
  /** m/s at which the arms' swing reaches its full amplitude, and the most it may exceed it. */
  fullSpeed: 1.4, maxSwing: 1.3,
  /**
   * The legs are solved from the feet (footAt, legSolve). Metres one cycle of the walk covers: crowd.wgsl advances
   * the phase by a turn per this distance, so a planted foot's spot of ground is a function of the phase alone. The
   * speed under which the stride, the lift and the roll shrink toward standing. The swing foot's rise, m. The
   * ankle's rise at either end of the stance as the foot rolls onto its heel or its toes, m. The knee's bend
   * standing, rad: the leg never locks.
   */
  cycle: 1.45, strideSpeed: 0.5, lift: 0.07, roll: 0.03, kneeRest: 0.06,
  shoulder: 0.38, elbow: 0.3, elbowRest: 0.25, twist: 0.06,
  /**
   * Holding a cup: the left arm raised with the forearm up; carrying a bag: the right arm swings little. A furled
   * umbrella in the left hand stills it as a bag does; an open one holds the cup's raise without its swing.
   */
  cupShoulder: -0.35, cupElbow: -1.6, cupSwing: 0.2, bagSwing: 0.35,
  /** The head counters the trunk's lean, in part. */
  headCounter: 0.7,
})

/** The umbrella's option that is open (look.ts UMBRELLA.open): walkAngles and the vertex stage hold the arm up for it. */
export const UMBRELLA_OPEN = 3

/** The shoe's sole about the ankle, m: the heel this far behind it, the toes this far ahead (legTubes' lowest ring). */
export const SOLE = Object.freeze({ heel: 0.085, toe: 0.145 })

/** One heel's shape, m in the base body (HEEL_SHAPES). */
export interface HeelShape {
  /** How tall it stands at its centre. */
  readonly height: number
  /** Its centre, behind the ankle (its back at the shoe's back). */
  readonly z: number
  /** Its cross-section's radii (across, along the foot) under the sole and where it meets the ground. */
  readonly top: readonly [number, number]
  readonly ground: readonly [number, number]
  readonly segments: number
}

/**
 * The heels (look.ts HEEL), by option: none (0, the shoe flat on the ground as before), a block heel, a mid heel that
 * tapers, and a high heel that tapers to a point. A heel lifts the back of the shoe while the toes keep the ground, so
 * the foot pitches toes down and the body stands higher (heelPose); the heel stands upright under it (heelTubes).
 */
export const HEEL_SHAPES: readonly (HeelShape | null)[] = Object.freeze([
  null,
  Object.freeze({ height: 0.04, z: -0.058, top: Object.freeze([0.03, 0.027] as const), ground: Object.freeze([0.027, 0.024] as const), segments: 6 }),
  Object.freeze({ height: 0.06, z: -0.062, top: Object.freeze([0.024, 0.022] as const), ground: Object.freeze([0.013, 0.012] as const), segments: 6 }),
  Object.freeze({ height: 0.08, z: -0.068, top: Object.freeze([0.02, 0.017] as const), ground: Object.freeze([0.0055, 0.0055] as const), segments: 4 }),
])

/**
 * The tangent of the pitch each heel gives the base body's foot (toes down): the heel's height over the distance
 * from its centre to the toes' tip, as a sine. The vertex stage takes these as constants (crowdBody.ts bodyHeel).
 */
export const HEEL_TAN: readonly number[] = Object.freeze(HEEL_SHAPES.map((s) => (s ? Math.tan(Math.asin(s.height / (SOLE.toe - s.z))) : 0)))

/**
 * The foot's pitch on a heel (rad, toes down) and how much higher the body stands for it (m, the base body's), for a
 * shape's legs factor. The pitch sets the toes' tip and the heel's foot on one level: on the base legs that is
 * HEEL_TAN's, and the sliders stretch the heel with the leg (heightMap), so it is atan(legs × that). The rise keeps the
 * toes' tip on the ground once the foot turns about the ankle's pivot. Heel 0 is neither. crowdBody.ts bodyHeel is the
 * GPU twin.
 */
export function heelPose(heel: number, legs: number): { readonly tilt: number; readonly rise: number } {
  const k = HEEL_TAN[heel] ?? 0
  if (k === 0) return { tilt: 0, rise: 0 }
  const tilt = Math.atan(legs * k)
  return { tilt, rise: LANDMARK.ankle * legs * (Math.cos(tilt) - 1) + SOLE.toe * Math.sin(tilt) }
}

/**
 * Where the head turns (gazeAt). Metres from the neck: the operator's eye holds the gaze whole within `near`, not
 * at all past `reach`, never within `own` (a person's own eye stands at their own neck). Radians: the cone off the
 * body's front past which the operator is behind; the head's yaw and pitch at most; the chest's share of the yaw and
 * its most; the yaw toward the way they go at most (the head leads a turn), whole from `travelSpeed` m/s.
 */
export const GAZE = Object.freeze({
  near: 2.5, reach: 4.5, own: 0.5,
  cone: 1.75, headYaw: 1.1, headPitch: 0.5, chestShare: 0.3, chestYaw: 0.45,
  travelYaw: 0.6, travelSpeed: 0.3,
})

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x)
const clampTo = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x)
const TAU = Math.PI * 2
/** An angle brought within half a turn of zero. */
const wrapAngle = (a: number): number => a - TAU * Math.round(a / TAU)
/** 0 at or under `lo`, 1 at or over `hi`, a smooth step between (WGSL smoothstep). */
const smoothTo = (lo: number, hi: number, x: number): number => { const t = clamp01((x - lo) / (hi - lo)); return t * t * (3 - 2 * t) }
const hat = (y: number, at: number, half: number): number => clamp01(1 - Math.abs(y - at) / half)
const factor = (t: number, f: { readonly base: number; readonly range: number }): number => f.base + clamp01(t) * f.range

/** The bone's group: 0 the trunk (trunk, chest, head), 1 a leg, 2 an arm. */
export const boneGroup = (bone: number): number => (bone < 3 ? 0 : bone < 9 ? 1 : 2)
/** The bone's side: −1 left, +1 right, 0 on the axis. */
export const boneSide = (bone: number): number => (bone < 3 ? 0 : (bone >= 6 && bone <= 8) || bone >= 12 ? 1 : -1)

/** The factors a shape gives, as the shader computes them from the slider values. */
export interface ShapeFactors {
  readonly legs: number
  readonly trunk: number
  readonly shoulders: number
  readonly hips: number
  readonly mass: number
  readonly muscle: number
  readonly head: number
  readonly slouch: number
  readonly gait: number
  readonly height: number
}

export function shapeFactors(s: BodyShape): ShapeFactors {
  const legs = factor(s.legs, MORPH.legs)
  // The legs take their share of the same height: the trunk gives it back, so the neck stays where it was.
  const trunk = (LANDMARK.neck - LANDMARK.hip * legs) / (LANDMARK.neck - LANDMARK.hip)
  return {
    legs, trunk,
    shoulders: factor(s.shoulders, MORPH.shoulders),
    hips: factor(s.hips, MORPH.hips),
    mass: factor(s.mass, MORPH.mass),
    muscle: factor(s.muscle, MORPH.muscle),
    head: factor(s.head, MORPH.head),
    slouch: (0.5 - clamp01(s.posture)) * MORPH.slouch,
    gait: factor(s.posture, MORPH.gait),
    height: (Number.isFinite(s.height) && s.height > 0 ? s.height : HEIGHT_BASE) / HEIGHT_BASE,
  }
}

/** The height map: the legs' share scaled by `legs`, the trunk above by `trunk`, the head unmoved. */
export function heightMap(y: number, f: ShapeFactors): number {
  if (y <= LANDMARK.hip) return y * f.legs
  if (y <= LANDMARK.neck) return LANDMARK.hip * f.legs + (y - LANDMARK.hip) * f.trunk
  return y
}

/** The joints after the shape: [x, y] of each pivot on the right side (mirror x for the left). */
export interface Pivots {
  readonly hipX: number
  readonly hip: number
  readonly knee: number
  readonly ankle: number
  readonly shoulderX: number
  readonly shoulder: number
  readonly elbow: number
  readonly wrist: number
  readonly chest: number
  readonly neck: number
}

export function pivotsOf(f: ShapeFactors): Pivots {
  const shoulder = heightMap(LANDMARK.shoulder, f)
  return {
    hipX: LANDMARK.hipX * f.hips,
    hip: LANDMARK.hip * f.legs,
    knee: LANDMARK.knee * f.legs,
    ankle: LANDMARK.ankle * f.legs,
    shoulderX: LANDMARK.shoulderX * f.shoulders,
    shoulder,
    elbow: shoulder - (LANDMARK.shoulder - LANDMARK.elbow),
    wrist: shoulder - (LANDMARK.shoulder - LANDMARK.wrist),
    chest: heightMap(LANDMARK.chestPivot, f),
    neck: LANDMARK.neck,
  }
}

/** The height map's slope at rest height y: what a vertical length there is multiplied by. */
const heightSlope = (y: number, f: ShapeFactors): number => (y <= LANDMARK.hip ? f.legs : y <= LANDMARK.neck ? f.trunk : 1)

/** What the sliders do to a rest point of a bone at height y: a scale per axis about the bone's own axis, and a shift. */
interface MorphAt {
  readonly gx: number
  readonly gy: number
  readonly gz: number
  /** The axis the x scale is about (the limb's centre line; 0 on the trunk). */
  readonly ax: number
  readonly shiftX: number
  readonly shiftZ: number
}

/**
 * The sliders at one rest point, by its bone: the girths (mass and muscle, about the trunk's axis or the limb's
 * own), the widths (the shoulder and hip hats on the trunk; a whole limb shifted with its joint), the head about the
 * neck, the belly's push, and the height map's slope. A position takes the scales and the shifts (morphPoint); a
 * normal takes the scales' reciprocals (morphNormal).
 */
function morphAt(y: number, z: number, bone: number, f: ShapeFactors): MorphAt {
  const group = boneGroup(bone)
  const side = boneSide(bone)
  const dm = f.mass - 1, du = f.muscle - 1
  if (group === 0) {
    if (bone === BONE.HEAD) {
      const g = (1 + dm * LIMB_GIRTH.head.mass) * f.head
      return { gx: g, gy: f.head, gz: g, ax: 0, shiftX: 0, shiftZ: 0 }
    }
    const g = 1 + dm * (0.5 + 0.5 * hat(y, REGION.waist.at, REGION.waist.half)) + du * 0.6 * hat(y, REGION.chest.at, REGION.chest.half)
    const hip = hat(y, REGION.hip.at, REGION.hip.half)
    const wx = 1 + (f.shoulders - 1) * hat(y, REGION.shoulder.at, REGION.shoulder.half) + (f.hips - 1) * hip
    const wz = 1 + (f.hips - 1) * 0.5 * hip
    const push = z > 0 && dm > 0 ? dm * 0.1 * hat(y, REGION.belly.at, REGION.belly.half) : 0
    return { gx: g * wx, gy: heightSlope(y, f), gz: g * wz, ax: 0, shiftX: 0, shiftZ: push * wz }
  }
  if (group === 1) {
    const limb = bone === BONE.THIGH_L || bone === BONE.THIGH_R ? LIMB_GIRTH.thigh : bone === BONE.SHIN_L || bone === BONE.SHIN_R ? LIMB_GIRTH.shin : null
    const g = limb ? 1 + dm * limb.mass + du * limb.muscle : 1
    return { gx: g, gy: heightSlope(y, f), gz: g, ax: side * LANDMARK.hipX, shiftX: side * LANDMARK.hipX * (f.hips - 1), shiftZ: 0 }
  }
  const limb = bone === BONE.ARM_L || bone === BONE.ARM_R ? LIMB_GIRTH.arm : bone === BONE.FOREARM_L || bone === BONE.FOREARM_R ? LIMB_GIRTH.forearm : null
  const g = limb ? 1 + dm * limb.mass + du * limb.muscle : 1
  return { gx: g, gy: 1, gz: g, ax: side * LANDMARK.shoulderX, shiftX: side * LANDMARK.shoulderX * (f.shoulders - 1), shiftZ: 0 }
}

/**
 * One rest-pose point reshaped by the sliders (morphAt), then the height map: the trunk and the legs by their
 * height, the head about the neck, an arm keeping its length under wherever its shoulder went. The stature's scale
 * is not here: the shader applies it with the rest of the per-agent scales, after the pose (scaleOf). Writes x, y, z
 * into `out` and returns it.
 */
export function morphPoint(x: number, y: number, z: number, bone: number, f: ShapeFactors, out: number[] = [0, 0, 0]): number[] {
  const m = morphAt(y, z, bone, f)
  const group = boneGroup(bone)
  out[0] = m.ax + (x - m.ax) * m.gx + m.shiftX
  out[2] = z * m.gz + m.shiftZ
  if (group === 2) out[1] = heightMap(LANDMARK.shoulder, f) - (LANDMARK.shoulder - y)
  else if (bone === BONE.HEAD) out[1] = LANDMARK.neck + (y - LANDMARK.neck) * f.head
  else out[1] = heightMap(y, f)
  return out
}

/**
 * A rest-pose normal under the same sliders: each component over its axis's scale (the shifts move nothing), then
 * normalised, so a widened torso is still lit as the round thing it is. Writes into `out` and returns it.
 */
export function morphNormal(nx: number, ny: number, nz: number, y: number, z: number, bone: number, f: ShapeFactors, out: number[] = [0, 0, 0]): number[] {
  const m = morphAt(y, z, bone, f)
  const x = nx / m.gx, yy = ny / m.gy, zz = nz / m.gz
  const l = Math.hypot(x, yy, zz) || 1
  out[0] = x / l; out[1] = yy / l; out[2] = zz / l
  return out
}

/**
 * A lower garment's cut at one point of its tube (TROUSER_SHAPE about a leg's axis, SKIRT_SHAPE about the trunk's):
 * the radius `r` at height `y` reshaped, and the height stretched (a skirt's length and high waist). Writes
 * [radius, height] into `out` and returns it. crowdBody.ts bodyLowerShape is the GPU twin.
 */
export function lowerShape(r: number, y: number, skirt: boolean, cut: number, coat: boolean, out: number[] = [0, 0]): number[] {
  if (skirt) {
    const [flare, flareTop, pencil, length, bulge, raise, narrowTop] = SKIRT_SHAPE[cut]
    let s = 1 + flare * smoothTo(flareTop, LOWER.hem, y) + bulge * hat(y, LOWER.bulgeAt, LOWER.bulgeHalf)
      - pencil * smoothTo(LOWER.pencilFrom, LOWER.hem, y) - narrowTop * smoothTo(LOWER.waist, LOWER.top, y)
    if (coat) s = Math.min(s, 1)
    out[0] = r * s
    out[1] = y < LOWER.waist ? LOWER.waist - (LOWER.waist - y) * length : y + (y - LOWER.waist) * raise
    return out
  }
  const [slim, wide, flare, wideAbove, wideTop, wideFull, taper, taperSlope] = TROUSER_SHAPE[cut]
  let q = r * (1 - slim * smoothTo(LOWER.slimFrom, LOWER.slimTo, y))
  const w = wide + flare * Math.max(0, LANDMARK.knee - y)
  if (w > 0 && y >= wideAbove) q += smoothTo(wideTop, wideFull, y) * Math.max(0, w - q)
  if (taper > 0) q -= smoothTo(LOWER.taperFrom, LOWER.taperTo, y) * Math.max(0, q - (taper + taperSlope * (y - LOWER.ankle)))
  out[0] = q
  out[1] = y
  return out
}

/**
 * A rest-pose vertex of the lower garment as its cut reshapes it, before the sliders (crowdBody.ts bodyGarment is
 * the GPU twin): a trouser leg (slot BOTTOM on a leg bone) about the leg's axis, the skirt (slot BOTTOM hung from the
 * trunk alone: the trunk's own seat rings take the chest for a second bone) about the trunk's. The normal follows: in
 * the tube's cylinder (radius, angle, height), with the radius taken to F(r, y) and the height to Y(y), a normal's
 * radial, angular and height parts become (n_r·Y', n_θ·r·F_r·Y'/F, n_y·F_r − n_r·F_y), the derivatives by central
 * differences, so an unchanged point keeps its normal and a flare is lit as one. Cut 0, and every other vertex, comes
 * back as it went in. Writes [x, y, z, nx, ny, nz] into `out` and returns it.
 */
export function garmentPoint(
  x: number, y: number, z: number, nx: number, ny: number, nz: number,
  slot: number, bone0: number, bone1: number, cut: number, coat: boolean, out: number[] = [0, 0, 0, 0, 0, 0],
): number[] {
  out[0] = x; out[1] = y; out[2] = z; out[3] = nx; out[4] = ny; out[5] = nz
  const leg = bone0 >= BONE.THIGH_L && bone0 <= BONE.FOOT_R
  const skirt = bone0 === BONE.TRUNK && bone1 === BONE.TRUNK
  if (cut === 0 || slot !== SLOT.BOTTOM || !(leg || skirt)) return out
  const ax = leg ? Math.sign(x) * LANDMARK.hipX : 0
  const dx = x - ax
  const r = Math.max(Math.hypot(dx, z), 1e-6)
  const [F, Y] = lowerShape(r, y, skirt, cut, coat)
  const fr = (lowerShape(r + GARMENT_STEP.r, y, skirt, cut, coat)[0] - lowerShape(r - GARMENT_STEP.r, y, skirt, cut, coat)[0]) / (2 * GARMENT_STEP.r)
  const up = lowerShape(r, y + GARMENT_STEP.y, skirt, cut, coat), dn = lowerShape(r, y - GARMENT_STEP.y, skirt, cut, coat)
  const fy = (up[0] - dn[0]) / (2 * GARMENT_STEP.y), yy = (up[1] - dn[1]) / (2 * GARMENT_STEP.y)
  const c = dx / r, s = z / r, k = F / r
  out[0] = ax + dx * k; out[1] = Y; out[2] = z * k
  const nr = nx * c + nz * s, nt = nz * c - nx * s
  const mr = nr * yy, mt = nt * fr * yy / k, my = ny * fr - nr * fy
  const ox = mr * c - mt * s, oz = mr * s + mt * c
  const l = Math.hypot(ox, my, oz) || 1
  out[3] = ox / l; out[4] = my / l; out[5] = oz / l
  return out
}

/** The central differences' steps garmentPoint and bodyGarment take, m. */
export const GARMENT_STEP = Object.freeze({ r: 0.001, y: 0.002 })

/**
 * How the legs carry a skirt's rest point at height `y`, for a cut, under a coat or not: crowdBody.ts bodyGarment is
 * the GPU twin. Without a coat the share is SKIRT_SHAPE's follow, rising from LOWER.followFrom to the whole of it at
 * LOWER.followTo (cut 0 carries nothing), and the legs carry the point itself. Under a coat every cut follows as the
 * coat does (coatFollow, by its reshaped height), so the coat, which follows the legs too, stays over it: a skirt hung
 * from the trunk alone under a following coat came 6 to 9 cm out through the coat's back at a desk lean, and one that
 * stopped following where the coat covered it let the knee through skirt and coat at a walk. The part is 0 for the
 * thigh, 1 for the shin where a lengthened skirt reaches below the knee (a rest height under LOWER.waist −
 * (LOWER.waist − LANDMARK.knee) / length). Writes [share, part, panel] into `out` and returns it: panel is 1 under a
 * coat, where above LOWER.followTo the legs' carry is taken at the point straight below at followTo (skirtPose); the
 * trunk carries the rest, and skirtLeft says which leg.
 */
export function skirtFollow(y: number, cut: number, coat: boolean, out: number[] = [0, 0, 0]): number[] {
  const length = SKIRT_SHAPE[cut][3]
  out[0] = coat ? coatFollow(lowerShape(1, y, true, cut, coat)[1]) : SKIRT_SHAPE[cut][7] * smoothTo(LOWER.followFrom, LOWER.followTo, y)
  out[1] = y < LOWER.waist - (LOWER.waist - LANDMARK.knee) / length ? 1 : 0
  out[2] = coat ? 1 : 0
  return out
}

/**
 * How much of the legs' carry a coat's rest point at height `y` takes, and a skirt's under a coat at its reshaped
 * height (skirtFollow): crowdBody.ts bodyGarment and bodyVertex are the GPU twins. The coat's panels below the waist
 * (the rings the trunk alone turns) follow the legs by the thigh, the front and the back handed between them by
 * skirtLeft, as panels hung from the waist: from nothing at LOWER.coatFrom the carry grows in step with the depth
 * below it to LOWER.coatFollow at LOWER.followTo, and above followTo it is the carry of the point straight below at
 * followTo (coatPose), so each panel turns about the waist with the thigh and hangs straight; from followTo down the
 * point itself is carried. Hung from the trunk alone, the coat let a stepping thigh 12 to 18 cm out through its front
 * at a brisk walk; with each point carried by itself and the share eased in, its band between the 0.86 and the 0.7
 * rings stood out in a ledge, tilted nearly twice as far as the thigh. The rings the chest turns too stay with the
 * trunk and the chest.
 */
export function coatFollow(y: number): number {
  return LOWER.coatFollow * clamp01((LOWER.coatFrom - y) / (LOWER.coatFrom - LOWER.followTo))
}

/**
 * How much of the legs' carry of a skirt's rest point (x, z) the left leg takes, from where each leg would carry the
 * point (zL, zR: its z under the left and the right leg's part, before the body's tilt): crowdBody.ts bodyVertex is
 * the GPU twin. The front (z at or past LOWER.followSide) goes with the leg that carries it furthest forward, the back
 * with the one that carries it furthest back, each handed over across LOWER.followEase of the difference, so the hem
 * never jumps from one shin to the other as the stride crosses over; the sides between go with the leg on their own
 * side (x ≥ 0 is the right).
 */
export function skirtLeft(x: number, z: number, zL: number, zR: number): number {
  if (z >= LOWER.followSide) return smoothTo(-LOWER.followEase, LOWER.followEase, zL - zR)
  if (z <= -LOWER.followSide) return smoothTo(LOWER.followEase, -LOWER.followEase, zL - zR)
  return x >= 0 ? 0 : 1
}

/**
 * A skirt's rest point (x, y, z) posed as the shader poses it (crowdBody.ts bodyGarment, bodyVertex): through its cut
 * and the sliders (garmentPoint, morphPoint); the trunk's pose, plus skirtFollow's share of how much further the legs
 * carry it, each leg's part bending its knee by LOWER.followKnee of the leg's own and skirtLeft sharing the carry
 * between them (under a coat, above LOWER.followTo, the carry of the point straight below at followTo); then the
 * body's tilt. Writes the point into `out` and returns it.
 */
export function skirtPose(
  x: number, y: number, z: number, cut: number, coat: boolean, a: WalkAngles, pose: BodyPose, f: ShapeFactors, piv: Pivots,
  out: number[] = [0, 0, 0],
): number[] {
  const g = garmentPoint(x, y, z, 0, 1, 0, SLOT.BOTTOM, BONE.TRUNK, BONE.TRUNK, cut, coat, CARRY_GARMENT)
  const [share, part, panel] = skirtFollow(y, cut, coat, SKIRT_CARRY)
  const p = morphPoint(g[0], g[1], g[2], BONE.TRUNK, f, CARRY_REST)
  const at = panel && g[1] > LOWER.followTo ? morphPoint(g[0], LOWER.followTo, g[2], BONE.TRUNK, f, CARRY_AT) : p
  return legCarry(x, z, p, at, share, part, a, pose, piv, out)
}
const SKIRT_CARRY = [0, 0, 0]
const CARRY_GARMENT = [0, 0, 0, 0, 0, 0]
const CARRY_REST = [0, 0, 0]
const CARRY_AT = [0, 0, 0]

/**
 * A coat's rest point (x, y, z) on a ring the trunk alone turns, posed as the shader poses it (crowdBody.ts
 * bodyVertex): through the sliders (morphPoint); the trunk's pose, plus coatFollow's share of how much further the
 * thighs carry it (above LOWER.followTo, the point straight below at followTo), skirtLeft sharing the carry between
 * them; then the body's tilt. Writes the point into `out` and returns it.
 */
export function coatPose(
  x: number, y: number, z: number, a: WalkAngles, pose: BodyPose, f: ShapeFactors, piv: Pivots, out: number[] = [0, 0, 0],
): number[] {
  const p = morphPoint(x, y, z, BONE.TRUNK, f, CARRY_REST)
  const at = y > LOWER.followTo ? morphPoint(x, LOWER.followTo, z, BONE.TRUNK, f, CARRY_AT) : p
  return legCarry(x, z, p, at, coatFollow(y), 0, a, pose, piv, out)
}

/**
 * skirtPose's and coatPose's carry: the trunk's pose of the slid rest point `p`, plus `share` of how much further the
 * legs' `part` carry the slid point `at` (p itself, or the point straight below it at LOWER.followTo) than the trunk
 * does; then the tilt.
 */
function legCarry(
  x: number, z: number, p: readonly number[], at: readonly number[], share: number, part: number, a: WalkAngles, pose: BodyPose,
  piv: Pivots, out: number[],
): number[] {
  const upright: BodyPose = { tilt: 0, bend: pose.bend, fall: pose.fall }
  const own = at === p
  const ax = at[0], ay = at[1], az = at[2]
  out[0] = p[0]; out[1] = p[1]; out[2] = p[2]
  boneTransform(BONE.TRUNK, out, 1, a, upright, piv)
  if (share > 0) {
    const still = own ? [out[0], out[1], out[2]] : boneTransform(BONE.TRUNK, [ax, ay, az], 1, a, upright, piv)
    const bent: WalkAngles = { ...a, kneeL: a.kneeL * LOWER.followKnee, kneeR: a.kneeR * LOWER.followKnee }
    const l = boneTransform(BONE.THIGH_L + part, [ax, ay, az], 1, bent, upright, piv)
    const r = boneTransform(BONE.THIGH_R + part, [ax, ay, az], 1, bent, upright, piv)
    const w = skirtLeft(x, z, l[2], r[2])
    for (let k = 0; k < 3; k++) out[k] += (l[k] * w + r[k] * (1 - w) - still[k]) * share
  }
  rotAxisAbout(out, 0, Math.cos(pose.fall), -Math.sin(pose.fall), pose.tilt, 1)
  return out
}

/** The per-agent scales the shader applies after the pose: the stature up the body, and its square root across. */
export function scaleOf(f: ShapeFactors): { readonly y: number; readonly xz: number } {
  return { y: f.height, xz: Math.sqrt(f.height) }
}

/** The base person's eye, m above the feet (the glasses sit on it). */
export const EYE_LEVEL = 1.68

/**
 * Where a shape's eye is, m above its feet: the base eye about the neck by the head slider, then the stature's
 * scale (the legs slider moves the hip, never the neck; the posture's lean is a few millimetres and left out). The
 * first-person camera stands here (07_Execute_Actions/head.ts).
 */
export function eyeHeightOf(shape: BodyShape): number {
  const f = shapeFactors(shape)
  return (LANDMARK.neck + (EYE_LEVEL - LANDMARK.neck) * f.head) * f.height
}

// --- The walk ---------------------------------------------------------------------------------------------------

/** The joint angles of one moment of the walk, rad: about x (a positive leg angle swings it back, a positive knee bends the heel up). */
export interface WalkAngles {
  readonly hipL: number; readonly kneeL: number; readonly ankleL: number
  readonly hipR: number; readonly kneeR: number; readonly ankleR: number
  readonly shoulderL: number; readonly elbowL: number
  readonly shoulderR: number; readonly elbowR: number
  /** The chest's yaw about the spine (counter to the swing, with the chest's share of the gaze), and the head's nod. */
  readonly twist: number
  readonly head: number
  /** The head's own yaw about the neck, toward the gaze (to the right positive). */
  readonly headYaw: number
  /** The trunk's lean from the posture (about the hip, forward positive). */
  readonly slouch: number
  /**
   * The pelvis' rise, m (world): at or below zero, what the planted leg cannot span at the ends of the stance; on a
   * heel, the heel's rise above that (heelPose).
   */
  readonly rise: number
}

/** The swing's amplitude for a walking speed, m/s: full at WALK.fullSpeed, at most WALK.maxSwing. */
export const swingOf = (speed: number): number => Math.min(WALK.maxSwing, Math.max(0, speed / WALK.fullSpeed))

/** One foot at a moment of the walk, in the base body's metres: ahead of the hip's drop line, above the ankle's rest, its sole's angle (toes down positive), planted or swinging. */
export interface FootAt { readonly z: number; readonly y: number; readonly sole: number; readonly planted: boolean }

/**
 * Where a foot is at `phase` (rad; this leg's cycle), with the stride, the swing's lift and the roll's rise in the
 * base body's metres. The stance runs from a quarter turn before the phase's zero to a quarter after (the leg
 * vertical at zero): the foot is planted, carried from half a stride ahead to half a stride behind linearly in the
 * phase, so where the phase grows with the distance walked (crowd.wgsl: a turn per WALK.cycle metres) the foot's spot
 * of ground never moves; it rolls onto its heel ahead of the hip and onto its toes behind, the ankle up by the roll's
 * rise at either end. The swing brings it forward along a smooth step, the lift's arc over the roll's rise, the sole
 * turning from the toe-off's toes-down to the strike's toes-up.
 */
export function footAt(phase: number, stride: number, lift: number, roll: number): FootAt {
  const half = stride / 2
  const s = ((phase + Math.PI / 2) / TAU - Math.floor((phase + Math.PI / 2) / TAU)) * 2
  if (s < 1) {
    const u = 1 - 2 * s
    const y = roll * u * u
    return { z: half * u, y, sole: u < 0 ? Math.asin(Math.min(y / SOLE.toe, 1)) : -Math.asin(Math.min(y / SOLE.heel, 1)), planted: true }
  }
  const w = s - 1
  const ease = w * w * (3 - 2 * w)
  return { z: half * (2 * ease - 1), y: roll + lift * Math.sin(Math.PI * w), sole: Math.asin(Math.min(roll / SOLE.toe, 1)) * (1 - w) - Math.asin(Math.min(roll / SOLE.heel, 1)) * w, planted: false }
}

/** A leg's angles (rad, as WalkAngles holds them: a positive hip or knee swings the part back). */
export interface LegAngles { readonly hip: number; readonly knee: number; readonly ankle: number }

/** How far a thigh and a shin reach with the knee at its standing bend, m. */
export const legReach = (thigh: number, shin: number): number => Math.sqrt(thigh * thigh + shin * shin + 2 * thigh * shin * Math.cos(WALK.kneeRest))

/**
 * The leg solved from its foot: the hip and knee angles that put the ankle `dy` from the hip (below: negative) and
 * `dz` ahead of it, the knee forward of the line between them (the two-bone solve, the distance held to legReach so
 * the knee never locks), and the ankle that turns the sole to `sole` (toes down positive) whatever the leg does.
 */
export function legSolve(dy: number, dz: number, thigh: number, shin: number, sole: number): LegAngles {
  const r = Math.max(Math.min(Math.hypot(dy, dz), legReach(thigh, shin)), 1e-3)
  // A foot straight below the hip (standing) on the line's zero, whichever zero dz is (crowdBody.ts bodyLeg: the
  // software adapter's atan2 gives pi for a negative zero over a positive x).
  const line = dz === 0 ? 0 : Math.atan2(-dz, -dy)
  const open = Math.acos(clampTo((thigh * thigh + r * r - shin * shin) / (2 * thigh * r), -1, 1))
  const hip = line - open
  const knee = Math.PI - Math.acos(clampTo((thigh * thigh + shin * shin - r * r) / (2 * thigh * shin), -1, 1))
  return { hip, knee, ankle: sole - hip - knee }
}

/**
 * How far the pelvis sits below standing, m (base body), with the planted foot `dz` from under the hip and its ankle
 * `rise` above its rest: what the leg's reach cannot span; nothing at mid-stance, the most at either end.
 */
export function pelvisDrop(dz: number, rise: number, piv: Pivots): number {
  const reach = legReach(piv.hip - piv.knee, piv.knee - piv.ankle)
  return Math.max(0, piv.hip - piv.ankle - rise - Math.sqrt(Math.max(reach * reach - dz * dz, 0)))
}

/** Where the head turns: the chest's yaw, the head's own yaw and its pitch (rad; to the right and up positive). */
export interface Gaze { readonly chest: number; readonly head: number; readonly pitch: number }
export const GAZE_AHEAD: Gaze = Object.freeze({ chest: 0, head: 0, pitch: 0 })

/**
 * The gaze of a person whose neck is at `neck` (world), facing `heading` (forward (sin, cos)), moving at (vx, vz),
 * with the operator's eye at `target` (world; null: nobody afoot). The way they go first: the velocity's bearing off
 * the heading, held to GAZE.travelYaw, whole from GAZE.travelSpeed, so the head leads a turn. Then the eye, in front
 * and within reach: its bearing and its elevation, held to the head's limits with the chest's, fading out from
 * GAZE.near to GAZE.reach; the chest takes its share of the yaw and the head the rest. Exactly what the vertex stage
 * computes (crowdBody.ts bodyGaze).
 */
export function gazeAt(neck: readonly [number, number, number], heading: number, vx: number, vz: number, target: readonly [number, number, number] | null): Gaze {
  const speed = Math.hypot(vx, vz)
  let yaw = speed > 1e-4 ? clampTo(wrapAngle(Math.atan2(vx, vz) - heading), -GAZE.travelYaw, GAZE.travelYaw) * Math.min(1, speed / GAZE.travelSpeed) : 0
  let pitch = 0
  if (target) {
    const sh = Math.sin(heading), ch = Math.cos(heading)
    const dx = target[0] - neck[0], dy = target[1] - neck[1], dz = target[2] - neck[2]
    const flat = Math.hypot(dx, dz)
    const bearing = Math.atan2(dx * ch - dz * sh, dx * sh + dz * ch)
    const hold = flat < GAZE.own || Math.abs(bearing) > GAZE.cone ? 0 : 1 - smoothTo(GAZE.near, GAZE.reach, flat)
    yaw += (clampTo(bearing, -(GAZE.headYaw + GAZE.chestYaw), GAZE.headYaw + GAZE.chestYaw) - yaw) * hold
    pitch = clampTo(Math.atan2(dy, flat), -GAZE.headPitch, GAZE.headPitch) * hold
  }
  const chest = clampTo(yaw * GAZE.chestShare, -GAZE.chestYaw, GAZE.chestYaw)
  return { chest, head: clampTo(yaw - chest, -GAZE.headYaw, GAZE.headYaw), pitch }
}

/**
 * The walk at `phase` (rad; the left leg's cycle, the right half a turn behind) at `speed` (m/s), for a shape's
 * factors, holding a cup (the left arm up) or carrying a bag (the right arm still), looking `gaze`'s way, with an
 * umbrella (look.ts UMBRELLA) in the left hand: a furled one stills the arm as a bag does, an open one holds it up to
 * the shaft at the cup's raise, without a swing (it takes the cup's hand: look.ts lookMask), on a heel (look.ts
 * HEEL): both feet pitched toes down by its tilt and the body raised by its rise (heelPose). Each leg
 * is solved from its foot (footAt, legSolve) in the base body's metres, the stride, the lift and the roll shrinking
 * to standing under WALK.strideSpeed; the pelvis drops what the planted leg cannot span; the arms swing with the
 * speed against the legs. Exactly what the vertex stage computes, in the same order.
 */
export function walkAngles(phase: number, speed: number, f: ShapeFactors, cup = false, bag = false, gaze: Gaze = GAZE_AHEAD, umbrella = 0, heel = 0): WalkAngles {
  const swing = swingOf(speed)
  const scale = scaleOf(f)
  const piv = pivotsOf(f)
  const on = clamp01(speed / WALK.strideSpeed)
  const stride = WALK.cycle * 0.5 * on / scale.xz
  const lift = WALK.lift * on / scale.y
  const roll = WALK.roll * on / scale.y
  const footL = footAt(phase, stride, lift, roll)
  const footR = footAt(phase + Math.PI, stride, lift, roll)
  const planted = footL.planted ? footL : footR
  const drop = pelvisDrop(planted.z, planted.y, piv)
  const thigh = piv.hip - piv.knee, shin = piv.knee - piv.ankle
  const onHeel = heelPose(heel, f.legs)
  const tilted = (sole: number) => (onHeel.tilt === 0 ? sole : sole + onHeel.tilt)
  const legL = legSolve(piv.ankle + footL.y + drop - piv.hip, footL.z, thigh, shin, tilted(footL.sole))
  const legR = legSolve(piv.ankle + footR.y + drop - piv.hip, footR.z, thigh, shin, tilted(footR.sole))
  const arm = (p: number) => {
    const s = Math.sin(p)
    const shoulder = -s * WALK.shoulder * swing * f.gait
    const elbow = -(WALK.elbowRest + WALK.elbow * swing * Math.max(0, s))
    return [shoulder, elbow] as const
  }
  let [shoulderL, elbowL] = arm(phase)
  let [shoulderR, elbowR] = arm(phase + Math.PI)
  if (cup) { shoulderL = WALK.cupShoulder + shoulderL * WALK.cupSwing; elbowL = WALK.cupElbow }
  if (bag) { shoulderR *= WALK.bagSwing; elbowR = -WALK.elbowRest }
  if (umbrella === UMBRELLA_OPEN) { shoulderL = WALK.cupShoulder; elbowL = WALK.cupElbow } else if (umbrella !== 0) { shoulderL *= WALK.bagSwing; elbowL = -WALK.elbowRest }
  return {
    hipL: legL.hip, kneeL: legL.knee, ankleL: legL.ankle, hipR: legR.hip, kneeR: legR.knee, ankleR: legR.ankle,
    shoulderL, elbowL, shoulderR, elbowR,
    twist: Math.sin(phase) * WALK.twist * swing * f.gait + gaze.chest,
    head: -f.slouch * WALK.headCounter - gaze.pitch,
    headYaw: gaze.head,
    slouch: f.slouch,
    rise: onHeel.rise === 0 ? -drop * scale.y : (onHeel.rise - drop) * scale.y,
  }
}

const rotXAbout = (p: number[], px: number, py: number, pz: number, a: number, w: number): void => {
  const c = Math.cos(a), s = Math.sin(a)
  const y = p[1] - py * w, z = p[2] - pz * w
  p[1] = y * c - z * s + py * w
  p[2] = y * s + z * c + pz * w
  p[0] = p[0] - px * w + px * w
}
const rotYAbout = (p: number[], py: number, a: number, w: number): void => {
  const c = Math.cos(a), s = Math.sin(a)
  const x = p[0], z = p[2]
  p[0] = x * c + z * s
  p[2] = -x * s + z * c
  p[1] = p[1] - py * w + py * w
}
const rotAxisAbout = (p: number[], py: number, kx: number, kz: number, a: number, w: number): void => {
  const c = Math.cos(a), s = Math.sin(a)
  const x = p[0], y = p[1] - py * w, z = p[2]
  const d = kx * x + kz * z
  // Rodrigues about the horizontal unit axis (kx, 0, kz).
  const cx = -kz * y, cy = kz * x - kx * z, cz = kx * y
  p[0] = x * c + cx * s + kx * d * (1 - c)
  p[1] = y * c + cy * s + py * w
  p[2] = z * c + cz * s + kz * d * (1 - c)
}

/** The spring-damper pose and the lean, as the crowd's pose buffer carries them (crowd.wgsl pose: tilt, bend, push angle). */
export interface BodyPose {
  /** rad about the feet, along the push's axis. */
  readonly tilt: number
  /** rad about the hip, the trunk's, along the same axis. */
  readonly bend: number
  /** The push's direction in the body's frame: the axis is (cos fall, 0, −sin fall). */
  readonly fall: number
}

/**
 * One bone's transform of a rest point (after morphPoint): the chain from the bone to the root, pivots scaled by
 * `w` (1 for a position, 0 for a normal, as the shader does it). Returns `p` moved.
 */
export function boneTransform(bone: number, p: number[], w: number, a: WalkAngles, pose: BodyPose, piv: Pivots): number[] {
  const side = boneSide(bone)
  const kx = Math.cos(pose.fall), kz = -Math.sin(pose.fall)
  if (bone >= BONE.THIGH_L && bone <= BONE.FOOT_R) {
    const left = side < 0
    const part = (bone - BONE.THIGH_L) % 3
    const x = side * piv.hipX
    if (part === 2) rotXAbout(p, x, piv.ankle, 0, left ? a.ankleL : a.ankleR, w)
    if (part >= 1) rotXAbout(p, x, piv.knee, 0, left ? a.kneeL : a.kneeR, w)
    rotXAbout(p, x, piv.hip, 0, left ? a.hipL : a.hipR, w)
  } else {
    if (bone >= BONE.ARM_L) {
      const left = side < 0
      const part = (bone - BONE.ARM_L) % 3
      const x = side * piv.shoulderX
      if (part >= 1) rotXAbout(p, x, piv.elbow, 0, left ? a.elbowL : a.elbowR, w)
      rotXAbout(p, x, piv.shoulder, 0, left ? a.shoulderL : a.shoulderR, w)
      rotYAbout(p, piv.chest, a.twist, w)
    } else {
      if (bone === BONE.HEAD) { rotXAbout(p, 0, piv.neck, 0, a.head, w); rotYAbout(p, piv.neck, a.headYaw, w) }
      if (bone >= BONE.CHEST) rotYAbout(p, piv.chest, a.twist, w)
    }
    // The trunk, and everything hanging from it, leans with the posture and bends with the push.
    rotXAbout(p, 0, piv.hip, 0, a.slouch, w)
    rotAxisAbout(p, piv.hip, kx, kz, pose.bend, w)
  }
  rotAxisAbout(p, 0, kx, kz, pose.tilt, w)
  return p
}

/**
 * The rig a fallen pedestrian wears. The realm promotes a pedestrian who is shoved, trips or slips to a physical body
 * of thirteen capsule shapes (ragdollRig.ts; the eleven segments and two flat feet) and streams each shape's pose to
 * the page in that order (simProtocol.ts RIG_POSE, RIG_SEGMENTS; `slots` rigs at most, pinned equal to the realm's
 * by test). The body wears it: each of the fifteen bones hangs from one shape, by the shape's index in the stream and
 * its centre standing, in the base body's metres (ragdollRig.ts SEGMENTS and FOOT: a 1.75 m adult facing +z, feet on
 * the ground). The rig names its sides from the person's own view (its left at +x) and this body names them from
 * the viewer's (its left at −x), so a bone takes the shape on its own side of the body, by x.
 */
export const RIG_WEAR = Object.freeze({ slots: 8, shapes: 13 })
export const RIG_REST: readonly (readonly [shape: number, x: number, y: number, z: number])[] = Object.freeze([
  [0, 0, 0.97, 0], [1, 0, 1.3, 0], [2, 0, 1.66, 0],
  [5, -0.1, 0.7, 0], [6, -0.1, 0.28, 0], [12, -0.1, 0.03, 0.05],
  [3, 0.1, 0.7, 0], [4, 0.1, 0.28, 0], [11, 0.1, 0.03, 0.05],
  [9, -0.24, 1.38, 0], [10, -0.24, 1.1, 0], [10, -0.24, 1.1, 0],
  [7, 0.24, 1.38, 0], [8, 0.24, 1.1, 0], [8, 0.24, 1.1, 0],
])

/** One rig shape's pose: its centre in the world and its rotation as a quaternion (x, y, z, w). */
export interface RigPose { readonly at: readonly [number, number, number]; readonly q: readonly [number, number, number, number] }

/** `v` turned by the unit quaternion `q`, in place (v + 2 q.xyz × (q.xyz × v + q.w v)). */
export function rotateByQuat(v: number[], q: readonly [number, number, number, number]): number[] {
  const [qx, qy, qz, qw] = q
  const [x, y, z] = v
  // t = q.xyz × v + q.w v
  const tx = qy * z - qz * y + qw * x, ty = qz * x - qx * z + qw * y, tz = qx * y - qy * x + qw * z
  v[0] = x + 2 * (qy * tz - qz * ty)
  v[1] = y + 2 * (qz * tx - qx * tz)
  v[2] = z + 2 * (qx * ty - qy * tx)
  return v
}

/**
 * A vertex of a body wearing the rig: the point (after the sliders, in the base body's metres) scaled by the stature,
 * then hung from its two bones' shapes (RIG_REST: the offset from the shape's standing centre, turned by the shape's
 * rotation, at the shape's centre in the world) and blended by the weight, exactly the shader's order (crowdBody.ts
 * bodyRig). `poses` are the thirteen shapes of the rig worn, in stream order. `w` 1 for a position, 0 for a normal
 * (turned, never moved, the scales' reciprocals; the caller normalises). No heading and no place of the agent's own:
 * the rig's poses are the world's.
 */
export function rigPoint(
  x: number, y: number, z: number, bone0: number, bone1: number, weight: number, w: number,
  poses: readonly RigPose[], scale: { readonly y: number; readonly xz: number }, out: number[] = [0, 0, 0],
): number[] {
  const one = (bone: number, o: number[]): number[] => {
    const [shape, cx, cy, cz] = RIG_REST[bone] ?? RIG_REST[0]
    const pose = poses[shape]
    if (w > 0.5) { o[0] = (x - cx) * scale.xz; o[1] = (y - cy) * scale.y; o[2] = (z - cz) * scale.xz } else { o[0] = x / scale.xz; o[1] = y / scale.y; o[2] = z / scale.xz }
    rotateByQuat(o, pose.q)
    if (w > 0.5) { o[0] += pose.at[0]; o[1] += pose.at[1]; o[2] += pose.at[2] }
    return o
  }
  const a = one(bone0, [0, 0, 0])
  const b = bone1 === bone0 || weight >= 1 ? a : one(bone1, [0, 0, 0])
  out[0] = a[0] * weight + b[0] * (1 - weight)
  out[1] = a[1] * weight + b[1] * (1 - weight)
  out[2] = a[2] * weight + b[2] * (1 - weight)
  return out
}

/**
 * A vertex posed: its two bones' transforms blended by the weight (linear blend skinning), then the stature's
 * scales and the pelvis' rise, the heading and the position, exactly the shader's order. `w` 1 for a position (the
 * answer is in world metres), 0 for a normal (the answer wants normalising).
 */
export function skinPoint(
  x: number, y: number, z: number, bone0: number, bone1: number, weight: number, w: number,
  a: WalkAngles, pose: BodyPose, piv: Pivots, scale: { readonly y: number; readonly xz: number }, heading: number, at: readonly [number, number, number],
  out: number[] = [0, 0, 0],
): number[] {
  const p0 = boneTransform(bone0, [x, y, z], w, a, pose, piv)
  const p1 = bone1 === bone0 || weight >= 1 ? p0 : boneTransform(bone1, [x, y, z], w, a, pose, piv)
  let qx = p0[0] * weight + p1[0] * (1 - weight)
  let qy = p0[1] * weight + p1[1] * (1 - weight)
  let qz = p0[2] * weight + p1[2] * (1 - weight)
  if (w > 0.5) {
    qx *= scale.xz; qy = qy * scale.y + a.rise; qz *= scale.xz
  } else {
    // A normal takes the scales' reciprocals (the caller normalises).
    qx /= scale.xz; qy /= scale.y; qz /= scale.xz
  }
  const ch = Math.cos(heading), sh = Math.sin(heading)
  out[0] = qx * ch + qz * sh
  out[1] = qy
  out[2] = -qx * sh + qz * ch
  if (w > 0.5) { out[0] += at[0]; out[1] += at[1]; out[2] += at[2] }
  return out
}

// --- The rings --------------------------------------------------------------------------------------------------

/** One ring of a loft: an ellipse at height y about (x, z), its radii (the back may differ from the front), its colour slot, its bones. */
interface Ring {
  readonly y: number
  readonly x?: number
  readonly z?: number
  readonly rx: number
  readonly rz?: number
  readonly back?: number
  readonly slot: number
  readonly bone: number
  readonly bone1?: number
  readonly w?: number
  /** Kept in the distant body too. */
  readonly far?: boolean
  /** The face region (FACE_REGION) of the ring's vertices, with its weight (1 unless said). */
  readonly region?: number
  readonly rw?: number
  /** The region's weight scaled by how far forward the vertex is (max(0, sin θ)) or how far to the side (cos² θ). */
  readonly frontWeight?: boolean
  readonly sideWeight?: boolean
  /** Laid on the skull: every vertex's z takes the skull's own lofted chord at its height and x (skullFront), plus the ring's. */
  readonly wrap?: boolean
  /** The ring's plane rises this much per metre ahead of its centre (a heel's foot, level once the foot is pitched). */
  readonly tilt?: number
}

interface Tube {
  readonly rings: readonly Ring[]
  readonly segments: number
  readonly farSegments: number
  readonly capTop?: number
  readonly capBottom?: number
  readonly piece?: number
  /** Left out of the distant body altogether. */
  readonly nearOnly?: boolean
  /** One of the head's tubes (the card's face view draws these alone). */
  readonly head?: boolean
  /**
   * The card's paint depth, back to front: 0 hair behind the skull, 1 the skull and the body (the default), 2 the
   * ears, 3 hair over the skull, 4 the features and the rims. A cap or bob ring under HAIRLINE.y is 0 from the front
   * and 3 from the side (ringEdges).
   */
  readonly depth?: number
}

/** The trunk's profile for a body: [y, rx, rz front, rz back, slot], from the seat up to the neck. */
type Profile = readonly (readonly [number, number, number, number, number])[]

const T = SLOT.TOP, B = SLOT.BOTTOM, K = SLOT.SKIN

/** A man's trunk (the suit and the smart casual): the jacket's hem at `hem`, the seat below it. */
function manTrunk(hem: number): Profile {
  const seat = (y: number) => (y < hem ? B : T)
  return [
    [0.8, 0.15, 0.11, 0.11, B], [0.86, 0.165, 0.12, 0.12, seat(0.86)], [hem, 0.168, 0.12, 0.12, T],
    [0.98, 0.165, 0.115, 0.115, seat(0.98)], [1.06, 0.158, 0.11, 0.11, T], [1.16, 0.165, 0.118, 0.115, T], [1.26, 0.18, 0.128, 0.12, T],
    [1.34, 0.195, 0.135, 0.125, T], [1.4, 0.21, 0.13, 0.12, T], [1.46, 0.2, 0.11, 0.105, T], [1.5, 0.12, 0.085, 0.085, T],
    [1.53, 0.062, 0.062, 0.062, K], [1.58, 0.056, 0.056, 0.056, K],
  ]
}
/** A woman's trunk (the pantsuit and the skirt suit): the bust, a narrower waist, the hem at `hem`. */
function womanTrunk(hem: number): Profile {
  const seat = (y: number) => (y < hem ? B : T)
  return [
    [0.8, 0.15, 0.105, 0.105, B], [0.86, 0.165, 0.115, 0.115, seat(0.86)], [0.92, 0.168, 0.118, 0.118, seat(0.92)],
    [hem, 0.16, 0.11, 0.11, T], [1.06, 0.142, 0.1, 0.1, seat(1.06)], [1.16, 0.15, 0.115, 0.105, T], [1.26, 0.168, 0.145, 0.112, T],
    [1.34, 0.18, 0.138, 0.118, T], [1.4, 0.19, 0.122, 0.112, T], [1.46, 0.182, 0.105, 0.1, T], [1.5, 0.11, 0.08, 0.08, T],
    [1.53, 0.056, 0.056, 0.056, K], [1.58, 0.05, 0.05, 0.05, K],
  ]
}

/** The front z of the trunk at height y (linear between its rings), to hang a tie or a hem just outside it. */
function frontOf(profile: Profile, y: number): number {
  for (let i = 1; i < profile.length; i++) {
    const [y0, , z0] = profile[i - 1], [y1, , z1] = profile[i]
    if (y <= y1) return z0 + ((y - y0) / (y1 - y0)) * (z1 - z0)
  }
  return profile[profile.length - 1][2]
}

const trunkRings = (profile: Profile, chestFrom: number): Ring[] =>
  profile.map(([y, rx, rz, back, slot], i) => ({
    y, rx, rz, back, slot,
    bone: y >= chestFrom ? BONE.CHEST : BONE.TRUNK,
    bone1: y >= chestFrom ? BONE.TRUNK : BONE.CHEST,
    w: y >= chestFrom + 0.1 ? 1 : y >= chestFrom ? 0.6 : y >= chestFrom - 0.1 ? 0.7 : 1,
    far: i % 2 === 0 || i === profile.length - 1,
  })).map((r, i, all) => (i >= all.length - 2 ? { ...r, bone: BONE.HEAD, bone1: BONE.CHEST, w: i === all.length - 1 ? 0.8 : 0.4 } : r))

// --- The head and the face --------------------------------------------------------------------------------------

/** The face regions a head vertex may belong to (the `face` attribute's first value; 0 is none). */
export const FACE_REGION = Object.freeze({ NONE: 0, BROW: 1, JAW: 2, CHIN: 3, CHEEK: 4, NOSE: 5, EYES: 6, LIPS: 7 })
const { BROW, JAW, CHIN, CHEEK, NOSE, EYES, LIPS } = FACE_REGION

/** The skull's rings: the chin, the jaw, the cheeks, the eyes' height, the brow, the crown (12 segments; 8 in the distant body). */
const SKULL_SEGMENTS = 12
const SKULL: readonly Ring[] = [
  { y: 1.575, rx: 0.056, rz: 0.056, slot: K, bone: BONE.HEAD, far: true, region: CHIN, frontWeight: true },
  { y: 1.6, rx: 0.075, rz: 0.082, back: 0.078, z: 0.004, slot: K, bone: BONE.HEAD, region: JAW, rw: 0.6 },
  { y: 1.64, rx: 0.092, rz: 0.1, back: 0.096, z: 0.004, slot: K, bone: BONE.HEAD, far: true, region: CHEEK, sideWeight: true },
  { y: 1.68, rx: 0.098, rz: 0.106, back: 0.104, slot: K, bone: BONE.HEAD, region: CHEEK, rw: 0.5, sideWeight: true },
  { y: 1.71, rx: 0.095, rz: 0.1, back: 0.1, slot: K, bone: BONE.HEAD, far: true },
  { y: 1.735, rx: 0.08, rz: 0.086, back: 0.088, slot: K, bone: BONE.HEAD },
  { y: 1.75, rx: 0.046, rz: 0.05, back: 0.055, slot: K, bone: BONE.HEAD, far: true },
]

/**
 * The z of the skull's lofted front at height y and lateral x: the chord between the two nearest vertices of the
 * ring's front half (the loft draws facets, not the ellipse: at 12 segments the chord is up to 3.6 mm inside it), the
 * two rings about y blended. Beyond the ring's half-width it is the ring's centre (the side). A feature laid on the
 * face sits this far forward plus FACE.clear, so it neither floats off the facet nor sinks into it.
 */
export function skullFront(y: number, x: number): number {
  const chord = (r: Ring): number => {
    const cz = r.z ?? 0, rz = r.rz ?? r.rx
    const ax = Math.min(r.rx, Math.abs(x))
    // The front half's vertices run from θ = 0 (x = rx, z = cz) to θ = π (x = −rx), SKULL_SEGMENTS / 2 facets.
    const facets = SKULL_SEGMENTS / 2
    for (let j = 0; j < facets / 2; j++) {
      const t0 = (j / SKULL_SEGMENTS) * Math.PI * 2, t1 = ((j + 1) / SKULL_SEGMENTS) * Math.PI * 2
      const x0 = r.rx * Math.cos(t0), x1 = r.rx * Math.cos(t1)
      if (ax <= x0 + 1e-12 && ax >= x1 - 1e-12) {
        const s = x0 === x1 ? 0 : (x0 - ax) / (x0 - x1)
        return cz + rz * (Math.sin(t0) + (Math.sin(t1) - Math.sin(t0)) * s)
      }
    }
    return cz + rz
  }
  if (y <= SKULL[0].y) return chord(SKULL[0])
  for (let i = 1; i < SKULL.length; i++) {
    const a = SKULL[i - 1], b = SKULL[i]
    if (y <= b.y) {
      const t = (y - a.y) / (b.y - a.y)
      return chord(a) + (chord(b) - chord(a)) * t
    }
  }
  return chord(SKULL[SKULL.length - 1])
}

/** The face sliders, each −1..1 (0 is the base face). */
export interface FaceShape {
  readonly brow: number
  readonly jaw: number
  readonly chin: number
  readonly cheek: number
  readonly nose: number
  readonly eyes: number
  readonly lips: number
}
export const FACE_NEUTRAL: FaceShape = Object.freeze({ brow: 0, jaw: 0, chin: 0, cheek: 0, nose: 0, eyes: 0, lips: 0 })

/**
 * What each face slider does at full scale (×1 of its −1..1), by region, in metres or as a factor: the brow lifts and
 * pushes forward; the jaw widens about the centre line (the CHIN region at full weight, the JAW region at its ring's);
 * the chin pushes forward by how far forward the vertex is; the cheek lifts and widens by how far to the side; the nose
 * scales about its root (x and z); the eyes move apart along the skull's chord (z follows x at `slope`); the lips
 * thicken about the lip line. `clear` is the gap between a feature's back and the skull's facet. The shader takes
 * these numbers from here (crowdBody.ts bodyFace).
 */
export const FACE = Object.freeze({
  brow: Object.freeze({ lift: 0.005, push: 0.002 }),
  jaw: Object.freeze({ width: 0.12 }),
  chin: Object.freeze({ push: 0.006 }),
  cheek: Object.freeze({ lift: 0.006, width: 0.003 }),
  nose: Object.freeze({ size: 0.2, rootY: 1.672, rootZ: skullFront(1.672, 0) }),
  eyes: Object.freeze({ spread: 0.006, slope: 0.29 }),
  lips: Object.freeze({ fullness: 0.4, lineY: 1.608 }),
  clear: 0.0015,
})

/**
 * Where the hair cap leaves the skull, for the card's face view: above `y` the cap's front is outside the skull's
 * front (the hairline, between the cap's third and fourth rings); at the eyes' height its shell is outside the skull's
 * side only behind `temple` (the temple line, where the two rings' half-widths meet). Under the hairline the cap, and
 * the bob, sit behind the face from the front and cover the side of the head back from the temple from the side;
 * humanoid.test pins both numbers against the rings.
 */
export const HAIRLINE = Object.freeze({ y: 1.737, temple: 0.03 })

const clampS = (x: number): number => (x < -1 ? -1 : x > 1 ? 1 : x)
const sign = (x: number): number => (x > 0 ? 1 : x < 0 ? -1 : 0)

/**
 * One rest point of the head reshaped by the face sliders (before morphPoint: the body sliders then scale the whole
 * head about the neck), by its region and weight. Any other region, or a point off the head, is unmoved. Writes into
 * `out` and returns it.
 */
export function facePoint(x: number, y: number, z: number, region: number, w: number, f: FaceShape, out: number[] = [0, 0, 0]): number[] {
  out[0] = x; out[1] = y; out[2] = z
  switch (region) {
    case BROW: { const v = clampS(f.brow); out[1] = y + v * FACE.brow.lift; out[2] = z + v * FACE.brow.push; break }
    case JAW: out[0] = x * (1 + clampS(f.jaw) * FACE.jaw.width * w); break
    case CHIN: out[0] = x * (1 + clampS(f.jaw) * FACE.jaw.width); out[2] = z + clampS(f.chin) * FACE.chin.push * w; break
    case CHEEK: { const v = clampS(f.cheek); out[0] = x + sign(x) * v * FACE.cheek.width * w; out[1] = y + v * FACE.cheek.lift * w; break }
    case NOSE: { const s = 1 + clampS(f.nose) * FACE.nose.size; out[0] = x * s; out[2] = FACE.nose.rootZ + (z - FACE.nose.rootZ) * s; break }
    case EYES: { const d = clampS(f.eyes) * FACE.eyes.spread; out[0] = x + sign(x) * d; out[2] = z - d * FACE.eyes.slope; break }
    case LIPS: out[1] = FACE.lips.lineY + (y - FACE.lips.lineY) * (1 + clampS(f.lips) * FACE.lips.fullness); break
    default: break
  }
  return out
}

/** A rest normal under the same face sliders: the scales' reciprocals (the shifts move nothing), normalised. Writes into `out` and returns it. */
export function faceNormal(nx: number, ny: number, nz: number, region: number, w: number, f: FaceShape, out: number[] = [0, 0, 0]): number[] {
  let x = nx, y = ny, z = nz
  switch (region) {
    case JAW: x /= 1 + clampS(f.jaw) * FACE.jaw.width * w; break
    case CHIN: x /= 1 + clampS(f.jaw) * FACE.jaw.width; break
    case NOSE: { const s = 1 + clampS(f.nose) * FACE.nose.size; x /= s; z /= s; break }
    case LIPS: y /= 1 + clampS(f.lips) * FACE.lips.fullness; break
    default: break
  }
  const l = Math.hypot(x, y, z) || 1
  out[0] = x / l; out[1] = y / l; out[2] = z / l
  return out
}

/**
 * The head: the skull from the chin to the crown; the features laid on its front (piece FACE, near body only): two
 * eyes, each a pillow of white with an iris in front, two brows, a nose, the lips, two ears; the hair as pieces: the
 * cap over the top and back (every style but bald), long hair down the back, a bob round the sides to the jaw, a bun
 * at the back; and two thin rims of glasses, above and below the eyes. Every feature pillow is horizontal rings
 * closed by caps, laid on the skull's own chord (`wrap`), FACE.clear in front of it.
 */
function headTubes(): Tube[] {
  const H = BONE.HEAD
  const hair: Ring[] = [
    { y: 1.62, rx: 0.088, rz: 0.1, z: -0.03, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.68, rx: 0.104, rz: 0.108, z: -0.016, slot: SLOT.HAIR, bone: H },
    { y: 1.73, rx: 0.1, rz: 0.1, z: -0.015, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.75, rx: 0.082, rz: 0.084, z: -0.01, slot: SLOT.HAIR, bone: H },
    { y: 1.766, rx: 0.042, rz: 0.044, z: -0.01, slot: SLOT.HAIR, bone: H, far: true },
  ]
  const long: Ring[] = [
    { y: 1.66, rx: 0.1, rz: 0.05, z: -0.075, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.56, rx: 0.11, rz: 0.05, z: -0.1, slot: SLOT.HAIR, bone: H },
    { y: 1.44, rx: 0.12, rz: 0.045, z: -0.15, slot: SLOT.HAIR, bone: H, bone1: BONE.CHEST, w: 0.5, far: true },
    { y: 1.33, rx: 0.115, rz: 0.04, z: -0.158, slot: SLOT.HAIR, bone: BONE.CHEST, far: true },
  ]
  // The bob: a shell whose front half is inside the skull, so the sides and the back show, hemmed at the jaw line.
  const bob: Ring[] = [
    { y: 1.71, rx: 0.104, rz: 0.1, back: 0.106, z: -0.012, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.65, rx: 0.108, rz: 0.09, back: 0.11, z: -0.03, slot: SLOT.HAIR, bone: H },
    { y: 1.6, rx: 0.106, rz: 0.08, back: 0.1, z: -0.04, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.58, rx: 0.098, rz: 0.065, back: 0.085, z: -0.05, slot: SLOT.HAIR, bone: H, far: true },
  ]
  const bun: Ring[] = [
    { y: 1.675, rx: 0.018, rz: 0.018, z: -0.112, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.705, rx: 0.034, rz: 0.034, z: -0.122, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.735, rx: 0.018, rz: 0.018, z: -0.112, slot: SLOT.HAIR, bone: H, far: true },
  ]
  // A full rounded shell (an afro, big curls): wide at the sides past the ears, its front inside the face below the
  // brow (the front edge crosses the forehead above the brows), round over the crown.
  const volume: Ring[] = [
    { y: 1.6, rx: 0.12, rz: 0.05, back: 0.13, z: -0.02, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.66, rx: 0.15, rz: 0.06, back: 0.15, z: -0.01, slot: SLOT.HAIR, bone: H },
    { y: 1.7, rx: 0.158, rz: 0.07, back: 0.158, slot: SLOT.HAIR, bone: H },
    { y: 1.74, rx: 0.155, rz: 0.15, back: 0.16, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.8, rx: 0.13, rz: 0.13, back: 0.135, slot: SLOT.HAIR, bone: H },
    { y: 1.845, rx: 0.07, rz: 0.07, back: 0.075, slot: SLOT.HAIR, bone: H, far: true },
  ]
  // A puff or a knot on the crown.
  const topBun: Ring[] = [
    { y: 1.758, rx: 0.03, rz: 0.03, z: -0.02, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.795, rx: 0.05, rz: 0.05, z: -0.02, slot: SLOT.HAIR, bone: H },
    { y: 1.83, rx: 0.03, rz: 0.03, z: -0.02, slot: SLOT.HAIR, bone: H, far: true },
  ]
  // A tail gathered at the back of the head, hanging behind the neck.
  const ponytail: Ring[] = [
    { y: 1.7, rx: 0.026, rz: 0.026, z: -0.108, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.62, rx: 0.032, rz: 0.03, z: -0.13, slot: SLOT.HAIR, bone: H },
    { y: 1.52, rx: 0.028, rz: 0.026, z: -0.135, slot: SLOT.HAIR, bone: H, bone1: BONE.CHEST, w: 0.5 },
    { y: 1.42, rx: 0.016, rz: 0.016, z: -0.15, slot: SLOT.HAIR, bone: BONE.CHEST, far: true },
  ]
  // A head scarf: draped on the shoulders, round the neck and under the chin, over the sides of the face past the
  // ears with its front inside the face (the face stays open, as the bob's front does), over the forehead and crown.
  const W = SLOT.HEADWEAR
  const wrapRings: Ring[] = [
    { y: 1.43, rx: 0.17, rz: 0.11, back: 0.11, z: -0.01, slot: W, bone: BONE.CHEST, far: true },
    { y: 1.5, rx: 0.095, rz: 0.08, back: 0.085, slot: W, bone: H, bone1: BONE.CHEST, w: 0.5 },
    { y: 1.56, rx: 0.088, rz: 0.075, back: 0.098, slot: W, bone: H },
    { y: 1.6, rx: 0.108, rz: 0.04, back: 0.114, z: -0.005, slot: W, bone: H, far: true },
    { y: 1.665, rx: 0.12, rz: 0.04, back: 0.12, slot: W, bone: H },
    { y: 1.725, rx: 0.11, rz: 0.104, back: 0.114, slot: W, bone: H, far: true },
    { y: 1.758, rx: 0.084, rz: 0.088, back: 0.094, slot: W, bone: H },
  ]
  // A wound crown above the brow, taller than the skull (a turban; a head wrap wears it too, in another fabric).
  const turban: Ring[] = [
    { y: 1.705, rx: 0.108, rz: 0.112, back: 0.112, slot: W, bone: H, far: true },
    { y: 1.75, rx: 0.116, rz: 0.12, back: 0.118, slot: W, bone: H },
    { y: 1.8, rx: 0.11, rz: 0.11, back: 0.11, z: 0.005, slot: W, bone: H },
    { y: 1.83, rx: 0.084, rz: 0.084, back: 0.084, z: 0.01, slot: W, bone: H, far: true },
  ]
  // A snug crown from the brow up (a beanie, a durag, a flat cap's), and the flat cap's peak.
  const hat: Ring[] = [
    { y: 1.705, rx: 0.103, rz: 0.108, back: 0.108, slot: W, bone: H, far: true },
    { y: 1.74, rx: 0.099, rz: 0.1, back: 0.104, slot: W, bone: H },
    { y: 1.772, rx: 0.074, rz: 0.078, back: 0.08, slot: W, bone: H, far: true },
  ]
  const brim: Ring[] = [
    { y: 1.701, rx: 0.08, rz: 0.04, z: 0.118, slot: W, bone: H, far: true },
    { y: 1.709, rx: 0.08, rz: 0.04, z: 0.118, slot: W, bone: H, far: true },
  ]
  // A long beard: from the jaw's front (inside the face above the chin) down over the throat to the chest.
  const beard: Ring[] = [
    { y: 1.625, rx: 0.074, rz: 0.03, z: 0.058, slot: SLOT.HAIR, bone: H, far: true },
    { y: 1.585, rx: 0.068, rz: 0.042, z: 0.066, slot: SLOT.HAIR, bone: H },
    { y: 1.545, rx: 0.052, rz: 0.036, z: 0.08, slot: SLOT.HAIR, bone: H, bone1: BONE.CHEST, w: 0.3, far: true },
    { y: 1.5, rx: 0.034, rz: 0.026, z: 0.094, slot: SLOT.HAIR, bone: H, bone1: BONE.CHEST, w: 0.6 },
    { y: 1.465, rx: 0.016, rz: 0.014, z: 0.104, slot: SLOT.HAIR, bone: BONE.CHEST, far: true },
  ]
  // A hearing aid: a small pod behind the ear's top.
  const aid = (side: number): Ring[] => [
    { y: 1.655, x: side * 0.109, z: -0.024, rx: 0.005, rz: 0.008, slot: SLOT.DEVICE, bone: H },
    { y: 1.692, x: side * 0.11, z: -0.02, rx: 0.006, rz: 0.01, slot: SLOT.DEVICE, bone: H },
  ]
  // A cochlear implant: a larger processor behind the ear and the coil, a disc on the side of the head above and
  // behind it (rings stacked up its face, thin across the head), outside the hair's cap.
  const processor = (side: number): Ring[] => [
    { y: 1.648, x: side * 0.11, z: -0.026, rx: 0.006, rz: 0.01, slot: SLOT.DEVICE, bone: H },
    { y: 1.694, x: side * 0.111, z: -0.022, rx: 0.007, rz: 0.012, slot: SLOT.DEVICE, bone: H },
  ]
  const coil = (side: number): Ring[] => [
    { y: 1.698, x: side * 0.108, z: -0.05, rx: 0.003, rz: 0.008, slot: SLOT.DEVICE, bone: H },
    { y: 1.712, x: side * 0.109, z: -0.05, rx: 0.004, rz: 0.016, slot: SLOT.DEVICE, bone: H },
    { y: 1.726, x: side * 0.108, z: -0.05, rx: 0.003, rz: 0.008, slot: SLOT.DEVICE, bone: H },
  ]
  const rim = (y0: number, y1: number): Ring[] => [
    { y: y0, rx: 0.095, rz: 0.014, z: 0.1, slot: SLOT.FRAME, bone: H },
    { y: y1, rx: 0.095, rz: 0.014, z: 0.1, slot: SLOT.FRAME, bone: H },
  ]
  // A feature pillow: rings laid on the skull about x (the wrap adds the chord at each vertex), FACE.clear in front, in its region.
  const laid = (x: number, slot: number, region: number, rz: number, ahead: number, rows: readonly (readonly [number, number])[]): Ring[] =>
    rows.map(([y, rx]) => ({ y, x, z: FACE.clear + ahead + rz, rx, rz, slot, bone: H, region, wrap: true }))
  const eye = (side: number): Tube[] => {
    const x = side * 0.0315
    return [
      { rings: laid(x, SLOT.EYE, EYES, 0.003, 0, [[1.676, 0.005], [1.679, 0.013], [1.683, 0.013], [1.686, 0.005]]), segments: 8, farSegments: 6, capTop: 1.6865, capBottom: 1.6755, piece: PIECE.FACE, nearOnly: true, head: true, depth: 4 },
      { rings: laid(x, SLOT.IRIS, EYES, 0.0015, 0.0075, [[1.677, 0.003], [1.681, 0.006], [1.685, 0.003]]), segments: 6, farSegments: 6, capTop: 1.6855, capBottom: 1.6765, piece: PIECE.FACE, nearOnly: true, head: true, depth: 4 },
    ]
  }
  const brow = (side: number): Tube =>
    ({ rings: laid(side * 0.033, SLOT.HAIR, BROW, 0.003, 0, [[1.698, 0.018], [1.705, 0.018]]), segments: 6, farSegments: 6, capTop: 1.7055, capBottom: 1.6975, piece: PIECE.FACE, nearOnly: true, head: true, depth: 4 })
  // The nose stands off the face front: each ring's back 2 mm inside the skull, its front 2 × rz out of it.
  const noseRing = (y: number, rx: number, rz: number): Ring => ({ y, rx, rz, z: skullFront(y, 0) + rz - 0.002, slot: K, bone: H, region: NOSE })
  const nose: Ring[] = [noseRing(1.624, 0.009, 0.004), noseRing(1.63, 0.012, 0.012), noseRing(1.64, 0.011, 0.013), noseRing(1.655, 0.008, 0.008), noseRing(FACE.nose.rootY, 0.007, 0.004)]
  const lips: Ring[] = laid(0, SLOT.LIP, LIPS, 0.003, 0, [[1.604, 0.022], [1.612, 0.022]])
  const ear = (side: number): Tube => ({
    rings: [
      { y: 1.655, x: side * 0.106, z: -0.005, rx: 0.008, rz: 0.012, slot: K, bone: H },
      { y: 1.685, x: side * 0.106, z: -0.005, rx: 0.008, rz: 0.012, slot: K, bone: H },
    ],
    segments: 5, farSegments: 5, capTop: 1.686, capBottom: 1.654, piece: PIECE.FACE, nearOnly: true, head: true, depth: 2,
  })
  return [
    { rings: SKULL, segments: SKULL_SEGMENTS, farSegments: 8, capTop: 1.762, capBottom: 1.572, head: true },
    { rings: hair, segments: 12, farSegments: 8, capTop: 1.776, piece: PIECE.HAIR_CAP, head: true, depth: 3 },
    { rings: long, segments: 10, farSegments: 6, capBottom: 1.31, piece: PIECE.LONG_HAIR, head: true, depth: 0 },
    { rings: bob, segments: 12, farSegments: 8, capBottom: 1.57, piece: PIECE.BOB, head: true, depth: 3 },
    { rings: bun, segments: 8, farSegments: 6, capTop: 1.75, capBottom: 1.66, piece: PIECE.BUN, head: true, depth: 0 },
    { rings: volume, segments: 10, farSegments: 6, capTop: 1.858, capBottom: 1.592, piece: PIECE.VOLUME, head: true, depth: 3 },
    { rings: topBun, segments: 6, farSegments: 4, capTop: 1.84, capBottom: 1.752, piece: PIECE.TOP_BUN, head: true, depth: 3 },
    { rings: ponytail, segments: 6, farSegments: 4, capTop: 1.705, capBottom: 1.41, piece: PIECE.PONYTAIL, nearOnly: true, head: true, depth: 0 },
    { rings: wrapRings, segments: 10, farSegments: 6, capTop: 1.772, piece: PIECE.WRAP, nearOnly: true, head: true, depth: 3 },
    { rings: turban, segments: 10, farSegments: 6, capTop: 1.842, piece: PIECE.TURBAN, nearOnly: true, head: true, depth: 3 },
    { rings: hat, segments: 10, farSegments: 6, capTop: 1.785, piece: PIECE.HAT, nearOnly: true, head: true, depth: 3 },
    { rings: brim, segments: 8, farSegments: 6, capTop: 1.709, capBottom: 1.701, piece: PIECE.BRIM, nearOnly: true, head: true, depth: 4 },
    { rings: beard, segments: 8, farSegments: 6, capBottom: 1.458, piece: PIECE.BEARD, head: true, depth: 4 },
    { rings: aid(1), segments: 5, farSegments: 5, capTop: 1.696, capBottom: 1.651, piece: PIECE.AID_L, nearOnly: true, head: true, depth: 2 },
    { rings: aid(-1), segments: 5, farSegments: 5, capTop: 1.696, capBottom: 1.651, piece: PIECE.AID_R, nearOnly: true, head: true, depth: 2 },
    { rings: processor(1), segments: 5, farSegments: 5, capTop: 1.699, capBottom: 1.644, piece: PIECE.COIL_L, nearOnly: true, head: true, depth: 2 },
    { rings: coil(1), segments: 6, farSegments: 6, capTop: 1.729, capBottom: 1.695, piece: PIECE.COIL_L, nearOnly: true, head: true, depth: 2 },
    { rings: processor(-1), segments: 5, farSegments: 5, capTop: 1.699, capBottom: 1.644, piece: PIECE.COIL_R, nearOnly: true, head: true, depth: 2 },
    { rings: coil(-1), segments: 6, farSegments: 6, capTop: 1.729, capBottom: 1.695, piece: PIECE.COIL_R, nearOnly: true, head: true, depth: 2 },
    { rings: nose, segments: 6, farSegments: 6, capBottom: 1.622, piece: PIECE.FACE, nearOnly: true, head: true, depth: 4 },
    ...eye(-1), ...eye(1), brow(-1), brow(1),
    { rings: lips, segments: 8, farSegments: 8, capTop: 1.6125, capBottom: 1.6035, piece: PIECE.FACE, nearOnly: true, head: true, depth: 4 },
    ear(-1), ear(1),
    { rings: rim(1.6705, 1.6735), segments: 12, farSegments: 6, piece: PIECE.GLASSES, nearOnly: true, head: true, depth: 4 },
    { rings: rim(1.6885, 1.6915), segments: 12, farSegments: 6, piece: PIECE.GLASSES, nearOnly: true, head: true, depth: 4 },
    ...headphoneTubes(),
  ]
}

/**
 * The headphones (pieces HEADPHONES, ON_EAR, EARBUDS; slot DEVICE), on the head: each cup a pill whose rings are stacked
 * up its face, thin across the head (the coil's way), centred on the ear; the band over the crown a thin wall lofted
 * up from the cups, each ring a long ellipse whose ends are the band's two sides and whose middle is inside the head,
 * so all that shows is the band a few millimetres over the hair's cap (or the skull). The earbuds a bud in the front of
 * each ear with a short stem.
 */
function headphoneTubes(): Tube[] {
  const H = BONE.HEAD, D = SLOT.DEVICE
  const cup = (side: number, x: number, rows: readonly (readonly [number, number, number])[]): Ring[] =>
    rows.map(([y, rx, rz]) => ({ y, x: side * x, z: -0.005, rx, rz, slot: D, bone: H }))
  const band = (rz: number, rows: readonly (readonly [number, number])[]): Ring[] =>
    rows.map(([y, rx]) => ({ y, z: -0.005, rx, rz, slot: D, bone: H }))
  const over = (side: number) => cup(side, 0.122, [[1.636, 0.012, 0.016], [1.655, 0.015, 0.032], [1.685, 0.015, 0.032], [1.704, 0.012, 0.016]])
  const on = (side: number) => cup(side, 0.119, [[1.647, 0.008, 0.012], [1.659, 0.011, 0.025], [1.681, 0.011, 0.025], [1.693, 0.008, 0.012]])
  const bud = (side: number): Ring[] => [
    { y: 1.664, x: side * 0.112, z: 0.006, rx: 0.006, rz: 0.006, slot: D, bone: H },
    { y: 1.676, x: side * 0.112, z: 0.006, rx: 0.007, rz: 0.007, slot: D, bone: H },
  ]
  const stem = (side: number): Ring[] => [
    { y: 1.642, x: side * 0.113, z: 0.01, rx: 0.0025, rz: 0.0025, slot: D, bone: H },
    { y: 1.663, x: side * 0.113, z: 0.01, rx: 0.0025, rz: 0.0025, slot: D, bone: H },
  ]
  const piece = (p: number, rings: Ring[], segments: number, capTop: number, capBottom?: number): Tube =>
    ({ rings, segments, farSegments: segments, capTop, capBottom, piece: p, nearOnly: true, head: true, depth: 4 })
  return [
    piece(PIECE.HEADPHONES, over(1), 8, 1.708, 1.632),
    piece(PIECE.HEADPHONES, over(-1), 8, 1.708, 1.632),
    piece(PIECE.HEADPHONES, band(0.0105, [[1.702, 0.113], [1.738, 0.106], [1.758, 0.083], [1.771, 0.055], [1.779, 0.027]]), 6, 1.783),
    piece(PIECE.ON_EAR, on(1), 6, 1.695, 1.645),
    piece(PIECE.ON_EAR, on(-1), 6, 1.695, 1.645),
    piece(PIECE.ON_EAR, band(0.007, [[1.69, 0.113], [1.735, 0.105], [1.757, 0.082], [1.77, 0.055], [1.778, 0.028]]), 6, 1.782),
    piece(PIECE.EARBUDS, bud(1), 6, 1.679, 1.661),
    piece(PIECE.EARBUDS, bud(-1), 6, 1.679, 1.661),
    piece(PIECE.EARBUDS, stem(1), 4, 1.663, 1.641),
    piece(PIECE.EARBUDS, stem(-1), 4, 1.663, 1.641),
  ]
}

/**
 * One arm: the sleeve from inside the shoulder to the cuff (the top's cloth), then the hand. The hand's first ring is
 * inside the sleeve, above its open end, and moved by the forearm alone as the sleeve's last ring is (weight 0 on the
 * hand, whose bone it still names, so the watch and a prosthetic hand are painted on it as before), so the two never
 * part and nothing shows between the cuff, or a rolled sleeve's bare forearm, and the wrist (the hand began 1.5 cm
 * below the sleeve once, and the background showed through as a grey line); the wrist bends between it and the palm.
 */
function armTubes(side: number, woman: boolean): Tube[] {
  const [arm, fore, hand] = side < 0 ? [BONE.ARM_L, BONE.FOREARM_L, BONE.HAND_L] : [BONE.ARM_R, BONE.FOREARM_R, BONE.HAND_R]
  const x = side * LANDMARK.shoulderX
  const r = woman ? 0.9 : 1
  const sleeve: Ring[] = [
    { y: 1.47, x: x * 1.02, rx: 0.052 * r, rz: 0.056 * r, slot: T, bone: arm, bone1: BONE.CHEST, w: 0.55, far: true },
    { y: 1.4, x: x * 1.06, rx: 0.05 * r, rz: 0.052 * r, slot: T, bone: arm, bone1: BONE.CHEST, w: 0.85 },
    { y: 1.3, x: x * 1.06, rx: 0.046 * r, slot: T, bone: arm, far: true },
    { y: 1.2, x: x * 1.06, rx: 0.042 * r, slot: T, bone: arm, bone1: fore, w: 0.5, far: true },
    { y: 1.1, x: x * 1.06, rx: 0.04 * r, slot: T, bone: fore },
    { y: 1.0, x: x * 1.06, rx: 0.036 * r, slot: T, bone: fore, far: true },
    { y: 0.935, x: x * 1.06, rx: 0.034 * r, slot: T, bone: fore, far: true },
  ]
  const palm: Ring[] = [
    { y: 0.94, x: x * 1.06, rx: 0.031 * r, rz: 0.02, slot: K, bone: hand, bone1: fore, w: 0, far: true },
    { y: 0.86, x: x * 1.06, rx: 0.04 * r, rz: 0.018, slot: K, bone: hand },
    { y: 0.78, x: x * 1.06, rx: 0.036 * r, rz: 0.016, slot: K, bone: hand, far: true },
    { y: 0.75, x: x * 1.06, rx: 0.02 * r, rz: 0.012, slot: K, bone: hand },
  ]
  return [
    { rings: sleeve, segments: 10, farSegments: 6 },
    { rings: palm, segments: 8, farSegments: 6, capBottom: 0.74 },
  ]
}

/**
 * One leg: the trouser leg (or the hose under a skirt) from inside the seat to the ankle, then the shoe. The leg's last
 * ring is inside the shoe, below its open top, and both are half the shin's and half the foot's, so they move together
 * and nothing shows between a hem, a boot's shaft or a bare leg and the shoe (it ended 1 cm above the shoe once, and
 * the floor showed through as a pale ring).
 */
function legTubes(side: number, legSlot: number, woman: boolean): Tube[] {
  const [thigh, shin, foot] = side < 0 ? [BONE.THIGH_L, BONE.SHIN_L, BONE.FOOT_L] : [BONE.THIGH_R, BONE.SHIN_R, BONE.FOOT_R]
  const x = side * LANDMARK.hipX
  const r = woman ? 0.92 : 1
  const leg: Ring[] = [
    { y: 0.88, x, rx: 0.085 * r, rz: 0.09 * r, slot: legSlot, bone: thigh, bone1: BONE.TRUNK, w: 0.6, far: true },
    { y: 0.8, x, rx: 0.082 * r, rz: 0.088 * r, slot: legSlot, bone: thigh, bone1: BONE.TRUNK, w: 0.9 },
    { y: 0.7, x, rx: 0.078 * r, rz: 0.082 * r, slot: legSlot, bone: thigh, far: true },
    { y: 0.6, x, rx: 0.07 * r, rz: 0.074 * r, slot: legSlot, bone: thigh },
    { y: 0.52, x, rx: 0.062 * r, rz: 0.066 * r, slot: legSlot, bone: thigh, bone1: shin, w: 0.5, far: true },
    { y: 0.44, x, rx: 0.06 * r, rz: 0.064 * r, slot: legSlot, bone: shin },
    { y: 0.34, x, rx: 0.06 * r, rz: 0.064 * r, slot: legSlot, bone: shin, far: true },
    { y: 0.24, x, rx: 0.052 * r, rz: 0.056 * r, slot: legSlot, bone: shin },
    { y: 0.14, x, rx: 0.045 * r, rz: 0.048 * r, slot: legSlot, bone: shin, far: true },
    { y: 0.08, x, rx: 0.04 * r, rz: 0.043 * r, slot: legSlot, bone: shin, bone1: foot, w: 0.5 },
  ]
  const shoe: Ring[] = [
    { y: 0.085, x, rx: 0.042 * r, rz: 0.05, slot: SLOT.SHOES, bone: foot, bone1: shin, w: 0.5, far: true },
    { y: 0.045, x, rx: 0.048 * r, rz: 0.1, z: 0.025, slot: SLOT.SHOES, bone: foot },
    { y: 0.012, x, rx: 0.05 * r, rz: 0.12, z: 0.03, slot: SLOT.SHOES, bone: foot, far: true },
    { y: 0, x, rx: 0.046 * r, rz: 0.115, z: 0.03, slot: SLOT.SHOES, bone: foot, far: true },
  ]
  return [
    { rings: leg, segments: 10, farSegments: 6 },
    { rings: shoe, segments: 8, farSegments: 6, capBottom: 0 },
  ]
}

/** The tie, a flat strip hanging just outside the shirt front (the suit alone). */
function tieTube(profile: Profile): Tube {
  const z = (y: number) => frontOf(profile, y) + 0.008
  const rings: Ring[] = [
    { y: 1.5, rx: 0.016, rz: 0.006, z: z(1.5), slot: SLOT.ACCENT, bone: BONE.CHEST },
    { y: 1.4, rx: 0.02, rz: 0.006, z: z(1.4), slot: SLOT.ACCENT, bone: BONE.CHEST },
    { y: 1.3, rx: 0.024, rz: 0.006, z: z(1.3), slot: SLOT.ACCENT, bone: BONE.CHEST },
    { y: 1.2, rx: 0.024, rz: 0.006, z: z(1.2), slot: SLOT.ACCENT, bone: BONE.CHEST, bone1: BONE.TRUNK, w: 0.6 },
    { y: 1.12, rx: 0.02, rz: 0.006, z: z(1.12), slot: SLOT.ACCENT, bone: BONE.TRUNK },
  ]
  return { rings, segments: 6, farSegments: 4, capBottom: 1.1, piece: PIECE.TIE, nearOnly: true }
}

/**
 * The coat (piece COAT, slot TOP: the fragment stage paints it in the coat's cloth with the same collar, lapels and V
 * as a jacket): a shell from the collar to above the knee, clear of the trunk, the bust and the skirt by a centimetre
 * or two, turned with the chest above the waist and the trunk below, open at the bottom like the skirt.
 */
function coatTube(woman: boolean): Tube {
  const r = woman ? 0.96 : 1
  const rings: Ring[] = [
    { y: 0.56, rx: 0.24, rz: 0.185, back: 0.175, slot: T, bone: BONE.TRUNK, far: true },
    { y: 0.7, rx: 0.225, rz: 0.17, back: 0.16, slot: T, bone: BONE.TRUNK },
    { y: 0.86, rx: 0.2, rz: 0.15, back: 0.14, slot: T, bone: BONE.TRUNK, far: true },
    { y: 1.0, rx: 0.19 * r, rz: 0.14, back: 0.13, slot: T, bone: BONE.TRUNK },
    { y: 1.12, rx: 0.19 * r, rz: 0.14, back: 0.13, slot: T, bone: BONE.TRUNK, bone1: BONE.CHEST, w: 0.6, far: true },
    { y: 1.26, rx: 0.2 * r, rz: 0.16, back: 0.135, slot: T, bone: BONE.CHEST, bone1: BONE.TRUNK, w: 0.7 },
    { y: 1.4, rx: 0.23 * r, rz: 0.15, back: 0.14, slot: T, bone: BONE.CHEST, far: true },
    { y: 1.46, rx: 0.215 * r, rz: 0.13, back: 0.12, slot: T, bone: BONE.CHEST },
    { y: 1.5, rx: 0.135 * r, rz: 0.105, back: 0.1, slot: T, bone: BONE.CHEST, far: true },
  ]
  return { rings, segments: 16, farSegments: 8, piece: PIECE.COAT }
}

/**
 * The scarf (piece SCARF, slot SCARF): a wrap round the neck sitting on the shoulders, closed on top under the chin,
 * turned with the chest and a little with the head; and a tail down the right of the chest, hanging just outside
 * the jacket (inside a coat's shell, which hides it). The tail is the near body's alone.
 */
function scarfTubes(profile: Profile): Tube[] {
  const wrap: Ring[] = [
    { y: 1.49, rx: 0.1, rz: 0.09, back: 0.085, slot: SLOT.SCARF, bone: BONE.CHEST, far: true },
    { y: 1.53, rx: 0.088, rz: 0.08, back: 0.075, slot: SLOT.SCARF, bone: BONE.CHEST, bone1: BONE.HEAD, w: 0.7 },
    { y: 1.555, rx: 0.078, rz: 0.072, back: 0.068, slot: SLOT.SCARF, bone: BONE.HEAD, bone1: BONE.CHEST, w: 0.6, far: true },
  ]
  const z = (y: number) => frontOf(profile, y) + 0.014
  const tail: Ring[] = [
    { y: 1.15, x: 0.03, rx: 0.04, rz: 0.008, z: z(1.15), slot: SLOT.SCARF, bone: BONE.TRUNK, far: true },
    { y: 1.3, x: 0.035, rx: 0.04, rz: 0.008, z: z(1.3), slot: SLOT.SCARF, bone: BONE.CHEST, bone1: BONE.TRUNK, w: 0.6 },
    { y: 1.48, x: 0.04, rx: 0.045, rz: 0.01, z: z(1.48), slot: SLOT.SCARF, bone: BONE.CHEST, far: true },
  ]
  return [
    { rings: wrap, segments: 12, farSegments: 8, capTop: 1.565, piece: PIECE.SCARF },
    { rings: tail, segments: 6, farSegments: 4, capBottom: 1.13, piece: PIECE.SCARF, nearOnly: true },
  ]
}

/** A cup in the left hand (the pose brings it up to the chest). */
function cupTube(): Tube {
  const x = -LANDMARK.shoulderX * 1.06
  const rings: Ring[] = [
    { y: 0.745, x, rx: 0.028, z: 0.048, slot: SLOT.PROP, bone: BONE.HAND_L },
    { y: 0.855, x, rx: 0.034, z: 0.048, slot: SLOT.PROP, bone: BONE.HAND_L },
  ]
  return { rings, segments: 8, farSegments: 6, capTop: 0.855, capBottom: 0.745, piece: PIECE.CUP, nearOnly: true }
}

/** A bag hanging from the right hand. */
function bagTube(woman: boolean): Tube {
  const x = LANDMARK.shoulderX * 1.06 + 0.03
  const d = woman ? 0.16 : 0.19
  const rings: Ring[] = [
    { y: 0.8, x, rx: 0.012, rz: 0.06, slot: SLOT.PROP, bone: BONE.HAND_R, far: true },
    { y: 0.76, x, rx: 0.045, rz: d, slot: SLOT.PROP, bone: BONE.HAND_R, far: true },
    { y: 0.6, x, rx: 0.045, rz: d, slot: SLOT.PROP, bone: BONE.HAND_R },
    { y: 0.56, x, rx: 0.04, rz: d - 0.01, slot: SLOT.PROP, bone: BONE.HAND_R, far: true },
  ]
  return { rings, segments: 8, farSegments: 4, capTop: 0.8, capBottom: 0.56, piece: PIECE.BAG }
}

/**
 * Where the open umbrella is held, m in the rest frame: the cup's hand raised (WALK.cupShoulder, cupElbow) closes
 * round its shaft here; and the canopy's centre under the canopy, over the head and a little forward of it.
 */
export const UMBRELLA_GRIP: readonly [number, number, number] = Object.freeze([-0.212, 1.31, 0.41] as [number, number, number])
export const UMBRELLA_CANOPY: readonly [number, number, number] = Object.freeze([-0.1, 1.955, 0.15] as [number, number, number])

/**
 * The umbrella (pieces UMBRELLA_FOLDING, UMBRELLA_WALKING, UMBRELLA_OPEN; slot DEVICE, painted near black by crowd.ts),
 * in the cup's hand. A furled one hangs from the hand along the arm, its handle in the fist: the folding umbrella short,
 * the walking umbrella to below the knee (the arm hardly swings with either, as with a bag: WALK.bagSwing). The open one is on
 * the chest, so it stays over the head however the arm moves: its shaft rises from where the hand holds it (the cup's
 * raise, held still: crowdBody.ts bodyVertex) leaning in toward the head, and its canopy is a closed lens of eight
 * panels, the underside rising from the rim to the shaft.
 */
function umbrellaTubes(): Tube[] {
  const x = -LANDMARK.shoulderX * 1.06
  const D = SLOT.DEVICE
  const furled = (rows: readonly (readonly [number, number])[]): Ring[] => rows.map(([y, rx]) => ({ y, x, rx, slot: D, bone: BONE.HAND_L }))
  // The open umbrella's shaft, on the line from the held hand (UMBRELLA_GRIP) to the canopy's centre (UMBRELLA_CANOPY).
  const [gx, gy, gz] = UMBRELLA_GRIP, [cx, cy, cz] = UMBRELLA_CANOPY
  const along = (y: number, rx: number): Ring => {
    const t = (y - gy) / (cy - gy)
    return { y, x: gx + (cx - gx) * t, z: gz + (cz - gz) * t, rx, slot: D, bone: BONE.CHEST }
  }
  const canopy = (rows: readonly (readonly [number, number])[]): Ring[] => rows.map(([y, r]) => ({ y, x: cx, z: cz, rx: r, slot: D, bone: BONE.CHEST }))
  return [
    { rings: furled([[0.47, 0.006], [0.51, 0.024], [0.7, 0.026], [0.73, 0.011], [0.86, 0.011]]), segments: 6, farSegments: 6, capTop: 0.862, capBottom: 0.465, piece: PIECE.UMBRELLA_FOLDING, nearOnly: true },
    { rings: furled([[0.1, 0.003], [0.16, 0.012], [0.55, 0.028], [0.67, 0.014], [0.69, 0.007], [0.72, 0.013], [0.88, 0.013]]), segments: 6, farSegments: 6, capTop: 0.885, capBottom: 0.097, piece: PIECE.UMBRELLA_WALKING, nearOnly: true },
    { rings: [along(1.2, 0.016), along(1.4, 0.016), along(1.405, 0.006), along(cy + 0.005, 0.006)], segments: 6, farSegments: 6, capTop: cy + 0.007, capBottom: 1.195, piece: PIECE.UMBRELLA_OPEN, nearOnly: true },
    // From the underside's centre out to the rim, then over the top back to the tip: one closed surface, its faces out.
    { rings: canopy([[cy, 0.014], [1.905, 0.26], [1.845, 0.45], [1.825, 0.505], [1.86, 0.47], [1.95, 0.33], [2.025, 0.16], [2.05, 0.04]]), segments: 8, farSegments: 8, capTop: 2.075, piece: PIECE.UMBRELLA_OPEN, nearOnly: true },
  ]
}

/**
 * A heel under each shoe (pieces HEEL_BLOCK, HEEL_MID, HEEL_HIGH, by HEEL_SHAPES; the shoe's slot, on the foot's bone),
 * from just inside the sole down to the ground. The foot stands pitched on it (heelPose), so in the rest frame it leans
 * toward the toes by the pitch and its foot's ring is tilted the other way: once the foot is turned, the heel stands
 * upright and its foot is level, on the ground (the sliders stretch it with the leg and the pitch follows: heelPose).
 */
function heelTubes(side: number, woman: boolean): Tube[] {
  const foot = side < 0 ? BONE.FOOT_L : BONE.FOOT_R
  const x = side * LANDMARK.hipX
  const r = woman ? 0.92 : 1
  return HEEL_SHAPES.flatMap((s, heel): Tube[] => {
    if (!s) return []
    const k = HEEL_TAN[heel], c = 1 / Math.hypot(1, k)
    const groundY = -s.height * c, groundZ = s.z + s.height * k * c
    return [{
      rings: [
        { y: groundY, x, z: groundZ, rx: s.ground[0] * r, rz: s.ground[1], tilt: k, slot: SLOT.SHOES, bone: foot },
        { y: 0.003, x, z: s.z, rx: s.top[0] * r, rz: s.top[1], slot: SLOT.SHOES, bone: foot },
      ],
      segments: s.segments, farSegments: s.segments, capBottom: groundY, piece: PIECE.HEEL_BLOCK + heel - 1, nearOnly: true,
    }]
  })
}

/** The skirt: a shell from the waist to above the knee, turned with the trunk. */
function skirtTube(): Tube {
  const rings: Ring[] = [
    { y: 1.02, rx: 0.17, rz: 0.12, slot: B, bone: BONE.TRUNK, far: true },
    { y: 0.92, rx: 0.185, rz: 0.135, slot: B, bone: BONE.TRUNK },
    { y: 0.8, rx: 0.2, rz: 0.15, slot: B, bone: BONE.TRUNK, far: true },
    { y: 0.66, rx: 0.215, rz: 0.16, slot: B, bone: BONE.TRUNK },
    { y: 0.56, rx: 0.225, rz: 0.17, slot: B, bone: BONE.TRUNK, far: true },
  ]
  return { rings, segments: 16, farSegments: 8 }
}

/** Where each body's jacket hems over the trousers' seat (or the skirt), m: the trunk's slot turns from BOTTOM to TOP there. */
export const JACKET_HEM = Object.freeze([0.9, 0.94, 0.92, 0.98])

/** The four bodies' names, in draw-list order (crowd.ts VARIANT_NAMES, look.ts LOOK_BODIES). */
export const BODY_NAMES = ['suit', 'smart casual', 'pantsuit', 'skirt suit'] as const

/** Every tube of one body: the four outfits over the same person. */
export function bodyTubes(variant: number): Tube[] {
  const v = Number.isFinite(variant) ? Math.min(3, Math.max(0, Math.floor(variant))) : 0
  const woman = v >= 2
  const skirt = v === 3
  const hem = JACKET_HEM[v]
  const profile = woman ? womanTrunk(hem) : manTrunk(hem)
  // The shirt's V, the lapels, the collar and the cuffs are painted on the cloth by the fragment stage (GARMENT).
  const tubes: Tube[] = [
    { rings: trunkRings(profile, 1.12), segments: 16, farSegments: 8, capBottom: 0.78 },
    ...headTubes(),
    ...armTubes(-1, woman), ...armTubes(1, woman),
    ...legTubes(-1, skirt ? SLOT.LEGWEAR : B, woman), ...legTubes(1, skirt ? SLOT.LEGWEAR : B, woman),
    bagTube(woman), cupTube(),
  ]
  if (skirt) tubes.push(skirtTube())
  if (v === 0) tubes.push(tieTube(profile))
  tubes.push(coatTube(woman), ...scarfTubes(profile), ...umbrellaTubes(), ...heelTubes(-1, woman), ...heelTubes(1, woman))
  return tubes
}

// --- The loft ---------------------------------------------------------------------------------------------------

/** The geometry of one body, as flat arrays the renderer wraps: three floats of position and normal, `rig`, `skin` and `face` per vertex. */
export interface HumanoidMesh {
  readonly position: Float32Array
  readonly normal: Float32Array
  /** (bone, slot, piece) per vertex. */
  readonly rig: Float32Array
  /** (second bone, weight of the first) per vertex. */
  readonly skin: Float32Array
  /** (face region, its weight) per vertex; (0, 0) off the head's features and everywhere in the distant body. */
  readonly face: Float32Array
  readonly index: Uint32Array
  readonly vertexCount: number
}

/** A ring vertex's face weight: the ring's, scaled by how far forward (frontWeight) or how far to the side (sideWeight) it is. */
const faceWeight = (r: Ring, th: number): number => {
  if (r.region === undefined || r.region === FACE_REGION.NONE) return 0
  let w = r.rw ?? 1
  if (r.frontWeight) w *= Math.max(0, Math.sin(th))
  if (r.sideWeight) w *= Math.cos(th) * Math.cos(th)
  return w
}

class Loft {
  readonly position: number[] = []
  readonly rig: number[] = []
  readonly skin: number[] = []
  readonly face: number[] = []
  readonly index: number[] = []

  vertex(x: number, y: number, z: number, bone: number, slot: number, piece: number, bone1: number, w: number, region = 0, rw = 0): number {
    const i = this.position.length / 3
    this.position.push(x, y, z)
    this.rig.push(bone, slot, piece)
    this.skin.push(bone1, w)
    this.face.push(region, rw)
    return i
  }

  tube(t: Tube, far: boolean): void {
    if (far && t.nearOnly) return
    // Laid from the lowest ring up whichever way the tube lists them: the quads' winding (counter-clockwise from
    // outside, the face three draws) and the smooth normals face out only that way, and the caps meet the rings they
    // name. A tube listed from the top down was drawn inside out, its outer face culled (the skirt showed the legs).
    const listed = t.rings[t.rings.length - 1].y < t.rings[0].y ? [...t.rings].reverse() : t.rings
    const rings = far ? listed.filter((r, i) => r.far || i === 0 || i === listed.length - 1) : listed
    if (rings.length < 2) return
    const n = far ? t.farSegments : t.segments
    const piece = t.piece ?? PIECE.NONE
    const first: number[] = []
    const top = rings[rings.length - 1], bottom = rings[0]
    // The distant body has no face: its regions are left off, so its vertices never enter the face morph.
    const region = (r: Ring) => (far ? 0 : r.region ?? 0)
    const laid = (r: Ring, y: number, x: number) => (r.wrap ? skullFront(y, x) : 0)
    for (const r of rings) {
      const cx = r.x ?? 0, cz = r.z ?? 0, rz = r.rz ?? r.rx, back = r.back ?? rz
      const bone1 = r.bone1 ?? r.bone, w = r.w ?? 1
      const base = this.position.length / 3
      first.push(base)
      for (let j = 0; j < n; j++) {
        const th = (j / n) * Math.PI * 2
        const s = Math.sin(th)
        const x = cx + r.rx * Math.cos(th)
        const ahead = (s >= 0 ? rz : back) * s
        const z = cz + ahead + laid(r, r.y, x)
        this.vertex(x, r.y + ahead * (r.tilt ?? 0), z, r.bone, r.slot, piece, bone1, w, region(r), far ? 0 : faceWeight(r, th))
      }
    }
    for (let k = 1; k < rings.length; k++) {
      const a = first[k - 1], b = first[k]
      for (let j = 0; j < n; j++) {
        const j1 = (j + 1) % n
        this.index.push(a + j, b + j, b + j1, a + j, b + j1, a + j1)
      }
    }
    if (t.capTop !== undefined) {
      const cx = top.x ?? 0
      const c = this.vertex(cx, t.capTop, (top.z ?? 0) + laid(top, t.capTop, cx), top.bone, top.slot, piece, top.bone1 ?? top.bone, top.w ?? 1, region(top), far ? 0 : faceWeight(top, Math.PI / 2))
      const a = first[rings.length - 1]
      for (let j = 0; j < n; j++) this.index.push(a + ((j + 1) % n), a + j, c)
    }
    if (t.capBottom !== undefined) {
      const cx = bottom.x ?? 0
      const c = this.vertex(cx, t.capBottom, (bottom.z ?? 0) + laid(bottom, t.capBottom, cx), bottom.bone, bottom.slot, piece, bottom.bone1 ?? bottom.bone, bottom.w ?? 1, region(bottom), far ? 0 : faceWeight(bottom, Math.PI / 2))
      const a = first[0]
      for (let j = 0; j < n; j++) this.index.push(a + j, a + ((j + 1) % n), c)
    }
  }

  /** Smooth normals: every face's normal summed into its vertices, then normalised (a vertex with none points up). */
  normals(): Float32Array {
    const p = this.position
    const out = new Float32Array(p.length)
    for (let i = 0; i < this.index.length; i += 3) {
      const a = this.index[i] * 3, b = this.index[i + 1] * 3, c = this.index[i + 2] * 3
      const abx = p[b] - p[a], aby = p[b + 1] - p[a + 1], abz = p[b + 2] - p[a + 2]
      const acx = p[c] - p[a], acy = p[c + 1] - p[a + 1], acz = p[c + 2] - p[a + 2]
      const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx
      for (const v of [a, b, c]) { out[v] += nx; out[v + 1] += ny; out[v + 2] += nz }
    }
    for (let v = 0; v < out.length; v += 3) {
      const l = Math.hypot(out[v], out[v + 1], out[v + 2])
      if (l > 1e-12) { out[v] /= l; out[v + 1] /= l; out[v + 2] /= l } else { out[v] = 0; out[v + 1] = 1; out[v + 2] = 0 }
    }
    return out
  }

  mesh(): HumanoidMesh {
    return {
      position: new Float32Array(this.position),
      normal: this.normals(),
      rig: new Float32Array(this.rig),
      skin: new Float32Array(this.skin),
      face: new Float32Array(this.face),
      index: new Uint32Array(this.index),
      vertexCount: this.position.length / 3,
    }
  }
}

/**
 * The body of `variant` (BODY_NAMES order, clamped) in its rest pose: detailed, or the distant one (fewer rings
 * round fewer segments, the small pieces left out). Deterministic: the same arrays every call.
 */
export function humanoidMesh(variant: number, detailed = true): HumanoidMesh {
  const loft = new Loft()
  for (const t of bodyTubes(variant)) loft.tube(t, !detailed)
  return loft.mesh()
}

// --- The silhouette (the card's preview) ------------------------------------------------------------------------

/**
 * One ring of a body's silhouette after the sliders: its height and its two edges (from the front: the left and the
 * right; from the side: the back and the front), m, and what paints it.
 */
export interface SilhouetteRing {
  readonly y: number
  readonly left: number
  readonly right: number
  readonly slot: number
  readonly piece: number
  /** The tube the ring belongs to (consecutive rings of one tube join into one band). */
  readonly tube: number
  /** The card's paint depth (Tube.depth), back to front; a band takes its upper ring's. */
  readonly depth: number
}

/** The standing pose the silhouette is drawn in: no step, no push. */
const STILL: BodyPose = Object.freeze({ tilt: 0, bend: 0, fall: 0 })

/**
 * The rings of `tubes`, standing, with the sliders applied (every ring's two edge points through facePoint on the
 * head, morphPoint, the standing pose's bones and the stature's scales, as the shader would place them) seen from the
 * front (`side` false: x edges) or from the person's left (`side` true: z edges). The legs' and arms' rings are
 * weighted to their own bone alone here (their blend to the trunk is a few millimetres at rest); a cut skirt's rings
 * are posed as the shader poses them (skirtPose: the trunk and the legs blended), which moves a midi's hem a few
 * centimetres in the side view at a slumped or an upright posture, and so are the coat's rings below the waist
 * (coatPose). On a heel the feet are pitched and the body raised as the shader stands it (heelPose).
 */
function ringEdges(tubes: readonly Tube[], shape: BodyShape, face: FaceShape, side: boolean, lowerCut = 0, coat = false, heel = 0): SilhouetteRing[] {
  const f = shapeFactors(shape)
  const scale = scaleOf(f)
  const piv = pivotsOf(f)
  const a = walkAngles(0, 0, f, false, false, GAZE_AHEAD, 0, heel)
  const lift = heelPose(heel, f.legs).rise * scale.y
  const out: SilhouetteRing[] = []
  const p = [0, 0, 0]
  const g = [0, 0, 0, 0, 0, 0]
  let coatTube = false
  const edge = (x: number, y: number, z: number, r: Ring, th: number): number[] => {
    const skirt = (lowerCut !== 0 || coat) && r.slot === SLOT.BOTTOM && r.bone === BONE.TRUNK && (r.bone1 ?? r.bone) === BONE.TRUNK
    if (skirt) skirtPose(x, y, z, lowerCut, coat, a, STILL, f, piv, p)
    else if (coatTube && r.bone === BONE.TRUNK && r.bone1 === undefined) coatPose(x, y, z, a, STILL, f, piv, p)
    else {
      if (r.region !== undefined && r.bone === BONE.HEAD) facePoint(x, y, z, r.region, faceWeight(r, th), face, p)
      else if (lowerCut !== 0) {
        garmentPoint(x, y, z, 0, 1, 0, r.slot, r.bone, r.bone1 ?? r.bone, lowerCut, coat, g)
        p[0] = g[0]; p[1] = g[1]; p[2] = g[2]
      } else { p[0] = x; p[1] = y; p[2] = z }
      morphPoint(p[0], p[1], p[2], r.bone, f, p)
      boneTransform(r.bone, p, 1, a, STILL, piv)
    }
    p[0] *= scale.xz; p[1] *= scale.y; p[2] *= scale.xz
    if (lift !== 0) p[1] += lift
    return p
  }
  tubes.forEach((t, tube) => {
    coatTube = t.piece === PIECE.COAT
    for (const r of t.rings) {
      const cx = r.x ?? 0, cz = r.z ?? 0, rz = r.rz ?? r.rx, back = r.back ?? rz
      // Hair under the hairline: behind the face from the front; over the side of the head, back from the temple, from the side.
      const under = (t.piece === PIECE.HAIR_CAP || t.piece === PIECE.BOB) && r.y < HAIRLINE.y
      const depth = under ? (side ? 3 : 0) : t.depth ?? 1
      let y: number, left: number, right: number
      if (side) {
        const laid = r.wrap ? skullFront(r.y, cx) : 0
        const tilt = r.tilt ?? 0
        const b = edge(cx, r.y - back * tilt, cz - back + laid, r, Math.PI * 1.5)
        left = b[2]; y = b[1]
        right = edge(cx, r.y + rz * tilt, cz + rz + laid, r, Math.PI / 2)[2]
        if (under) right = Math.min(right, edge(cx, r.y, HAIRLINE.temple, r, Math.PI / 2)[2])
      } else {
        const l = edge(cx - r.rx, r.y, cz + (r.wrap ? skullFront(r.y, cx - r.rx) : 0), r, Math.PI)
        left = l[0]; y = l[1]
        right = edge(cx + r.rx, r.y, cz + (r.wrap ? skullFront(r.y, cx + r.rx) : 0), r, 0)[0]
      }
      out.push({ y, left, right, slot: r.slot, piece: t.piece ?? PIECE.NONE, tube, depth })
    }
  })
  return out
}

/**
 * The body's rings, standing, with the body sliders applied, seen from the front (`side` false: x edges) or from the
 * person's left (`side` true: z edges, so the posture's lean and the knees' and elbows' rest show), for a picture of
 * the look without a GPU. Optional pieces are included with their piece bit; the caller leaves out the ones the look
 * does not wear (the features, piece FACE, belong to faceRings). The face is the base one here. `lowerCut` reshapes the
 * trousers or the skirt as the shader does (garmentPoint; `coat`: under a coat, where no skirt widens); the painted
 * cuts are not shown. `heel` (look.ts HEEL) stands the body on its heels, as the shader does.
 */
export function silhouetteRings(variant: number, shape: BodyShape, side = false, lowerCut = 0, coat = false, heel = 0): SilhouetteRing[] {
  return ringEdges(bodyTubes(variant), shape, FACE_NEUTRAL, side, lowerCut, coat, heel)
}

/**
 * The head's rings alone (the skull, the hair pieces, the features, the rims), standing, with the body sliders and the
 * face sliders applied, from the front or from the person's left: the card's face view, at a larger scale. Tube
 * numbers count the head's tubes only.
 */
export function faceRings(variant: number, shape: BodyShape, face: FaceShape, side = false): SilhouetteRing[] {
  return ringEdges(bodyTubes(variant).filter((t) => t.head), shape, face, side)
}
