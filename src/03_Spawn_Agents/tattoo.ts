// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the tattoo catalogue as plain tables, kept apart from the shader so the card, the
 * console's wardrobe (look.ts) and the tests can read it without loading three. It names the eight zones a design
 * can sit on and the frame each zone maps its square through, the sixty-four designs in eight families of eight (ids
 * 1 to 12 are the ink studio's twelve forearm lines in catalogue order, so a studio line's `tattooForearm: i + 1`
 * names its design by construction), the polyline points of the eight pictures and of the heartbeat's one period, the
 * eight inks with their linear albedo and their swatch, the zone sets the street draws from, and inkLine, the CPU
 * mirror of the shader's contrast rule: the line is the skin taken nine tenths of the way to the ink, and where it
 * would stand out from that skin by less than 3:1, a halo of the skin taken toward a warm white or a brown-black just
 * far enough that it does. Every design is a plain drawing (a flower, a sprig, a spiral, a shape, a band, a picture),
 * named for what it shows and never for a people, a faith or a clan. Pure: no DOM, no GPU, no clock, no randomness.
 * What breaks if it is removed? The wardrobe has no tattoo names to offer or store, the street's draw and the card's
 * zones lose their agreed numbers, and the shader's tables have nothing to be checked against.
 */
import { BONE } from './humanoid.ts'

/** A colour as linear RGB, each 0..1 (the shader's albedo). */
export type TattooRgb = readonly [number, number, number]

/**
 * A zone a design can sit on: the look slot that holds its design (a motif id, 0 for none), the card's label (the
 * person's own side: humanoid.ts's `_R` bones are on the person's left), the bone whose skin it is drawn on, and the
 * slice that brings its slot (1: the hands, the neck and the nape; 2: the forearms, under rolled sleeves; 3: the calf
 * and the ankle, on bare legs). A zone whose slot the wardrobe does not have yet is still drawn by the street.
 */
export interface TattooZone {
  readonly slot: string
  readonly label: string
  readonly bone: number
  readonly slice: 1 | 2 | 3
}

/** The eight zones, in the shader's zone order (z = index): the first four live in genome word 7, the last four in word 8. */
export const TATTOO_ZONES: readonly TattooZone[] = Object.freeze(([
  ['tattooHand', 'Left hand', BONE.HAND_R, 1],
  ['tattooHandR', 'Right hand', BONE.HAND_L, 1],
  ['tattooNeck', 'Neck', BONE.HEAD, 1],
  ['tattooNape', 'Nape', BONE.HEAD, 1],
  ['tattooForearm', 'Left forearm', BONE.FOREARM_R, 2],
  ['tattooForearmR', 'Right forearm', BONE.FOREARM_L, 2],
  ['tattooCalf', 'Left calf', BONE.SHIN_R, 3],
  ['tattooAnkleR', 'Right ankle', BONE.SHIN_L, 3],
] as const).map(([slot, label, bone, slice]) => Object.freeze({ slot, label, bone, slice })))

/**
 * Where a zone's square sits on the body, in rest space (metres), so the ink follows every pose and morph. A planar
 * frame (radius 0, the hands) maps the hand's front face straight: q = (rest.xy - (axisX, centreY)) / half. A
 * cylindrical frame wraps round an axis parallel to y through x = axisX: the arc from the centre angle (measured as
 * atan2(x - axisX, z), so 0 faces front and pi the back) times the radius, and the height from centreY, both over the
 * half size. A design that wraps round the limb repeats `reps` times round it, centred on wrapY (the wrist for the
 * hands, the zone's centre elsewhere). The angles are the shader's own literals (a half turn 3.1415927, a quarter turn
 * 1.5707963), so a table written out from these reads back as the same f32 the shader holds.
 */
export interface TattooFrame {
  readonly axisX: number
  readonly centreY: number
  readonly angle: number
  readonly half: number
  readonly radius: number
  readonly reps: number
  readonly wrapY: number
}

/**
 * The frames, in zone order. The hands' square (0.031 each way of x ±0.212, y 0.835) fits the palm's 0.86 ring and
 * stays below the watch band; the neck's tops out at 1.573 under the chin ring (1.575); the nape's runs 1.548 to
 * 1.608; the forearms' sit between the 0.935 cuff and the 1.10 roll line; the calf's spans the 0.24 to 0.36 rings and
 * the ankle's stays above the shoe (0.085).
 */
export const TATTOO_FRAMES: readonly TattooFrame[] = Object.freeze(([
  [0.212, 0.835, 0, 0.031, 0, 6, 0.895],
  [-0.212, 0.835, 0, 0.031, 0, 6, 0.895],
  [0, 1.552, 1.2, 0.021, 0.059, 9, 1.552],
  [0, 1.578, 3.1415927, 0.03, 0.058, 9, 1.578],
  [0.212, 1.03, 0, 0.045, 0.037, 4, 1.03],
  [-0.212, 1.03, 0, 0.045, 0.037, 4, 1.03],
  [0.095, 0.3, 1.5707963, 0.06, 0.056, 5, 0.3],
  [-0.095, 0.125, -1.5707963, 0.03, 0.043, 5, 0.125],
] as const).map(([axisX, centreY, angle, half, radius, reps, wrapY]) => Object.freeze({ axisX, centreY, angle, half, radius, reps, wrapY })))

/**
 * Rolled sleeves (look.ts SLEEVES): the height a rolled sleeve ends at (the forearm's top ring, humanoid.ts, above the
 * forearms' squares), the turned cloth's band above it, and the zones (bit z for zone z) whose designs a street person
 * rolls their sleeves for (look.ts lookFromSeed; the shader reads crowdTattoo.ts tatZones against the same bits).
 */
export const TATTOO_SLEEVE = Object.freeze({
  roll: 1.1,
  fold: 0.02,
  zones: TATTOO_ZONES.reduce((bits, z, i) => (z.slot === 'tattooForearm' || z.slot === 'tattooForearmR' ? bits | (1 << i) : bits), 0),
})

/**
 * The legs' zones (the left calf's and the right ankle's bits in a zone set, crowdTattoo.ts tatZones): a passer-by of
 * the skirt suit's whose drawn designs reach them goes bare-legged (crowd.ts's leg rule, look.ts lookFromSeed), so the
 * designs show; the trouser bodies keep the hash's legs.
 */
export const TATTOO_LEG_ZONES = TATTOO_ZONES.reduce((bits, z, i) => (z.slot === 'tattooCalf' || z.slot === 'tattooAnkleR' ? bits | (1 << i) : bits), 0)

/**
 * How the head's skin splits between the neck and the nape: below `top` only; at or behind `napeZ` it is the nape,
 * otherwise below `neckTop` (the chin ring) the neck, and above that neither, so a nape design never reaches the chin.
 */
export const TATTOO_HEAD_SPLIT = Object.freeze({ top: 1.62, napeZ: -0.035, neckTop: 1.575 })

/** The eight families, eight designs each, as the card groups them. */
export const TATTOO_FAMILIES = Object.freeze(['flowers', 'stars and rays', 'circles and orbits', 'shapes', 'bands', 'spirals', 'sprigs', 'pictures'] as const)

/** How a design fills its zone: one drawing, two or three stacked up the zone (staggered), or a band round the limb. */
export const TATTOO_TILE = Object.freeze({ one: 0, two: 1, three: 2, wrap: 3 })

/**
 * A design: its id (the zone slot's value, 1 to 64), its name (the wardrobe's option), its family and its variant in
 * that family (the shader's switch and its parameter rows), how it fills the zone, and the byte the shader's table
 * holds for it, family << 5 | variant << 2 | tile.
 */
export interface TattooMotif {
  readonly id: number
  readonly name: string
  readonly family: number
  readonly variant: number
  readonly tile: number
  readonly entry: number
}

const { one, three, wrap } = TATTOO_TILE

/**
 * The sixty-four designs, by id. Ids 1 to 12 are the ink studio's forearm lines in catalogue order (storeCatalog.ts:
 * the shop's names for three of them are its own, a braided rope band, a scalloped arc band and a compass rose, and
 * its Euler line is the unit circle's half turn); the street draws from ids 13 to 64 alone. Within a family the
 * variants are told apart by their parameters, not by their code: five-petal flowers by petal shape and notch, the
 * spirals by growth, arms and turns.
 */
export const TATTOO_MOTIFS: readonly TattooMotif[] = Object.freeze(([
  ['olive branch', 6, 0, one], ['fibonacci spiral', 5, 0, one], ['braided rope band', 4, 0, wrap], ['circuit trace', 4, 4, wrap],
  ['star chart', 4, 5, wrap], ['scalloped arc band', 4, 1, wrap], ['origami cranes', 7, 0, three], ['soundwave band', 4, 2, wrap],
  ['compass rose', 1, 0, one], ['botanical vine', 6, 1, wrap], ['euler identity', 2, 0, one], ['ocean wave band', 4, 3, wrap],
  ['daisy', 0, 0, one], ['anemone', 0, 1, one], ['apple blossom', 0, 2, one], ['sunflower', 0, 3, one],
  ['forget-me-not', 0, 4, one], ['dogwood', 0, 5, one], ['cherry blossom', 0, 6, one], ['hibiscus', 0, 7, one],
  ['four-point star', 1, 1, one], ['comet', 1, 2, one], ['sunburst', 1, 3, one], ['snowflake', 1, 4, one],
  ['sparkles', 1, 5, one], ['dandelion clock', 1, 6, one], ['sea star', 1, 7, one],
  ['atom', 2, 1, one], ['ringed planet', 2, 2, one], ['orbits', 2, 3, one], ['moon phases', 2, 4, one],
  ['eclipse', 2, 5, one], ['water ripples', 2, 6, one], ['waxing crescent', 2, 7, one],
  ['triangle', 3, 0, one], ['nested triangles', 3, 1, one], ['diamond', 3, 2, one], ['nested diamonds', 3, 3, one],
  ['pentagon', 3, 4, one], ['hexagon', 3, 5, one], ['isometric cube', 3, 6, one], ['honeycomb', 3, 7, one],
  ['heartbeat line', 4, 6, wrap], ['double helix', 4, 7, wrap],
  ['nautilus shell', 5, 1, one], ['spiral galaxy', 5, 2, one], ['archimedean spiral', 5, 3, one], ['ammonite', 5, 4, one],
  ['storm spiral', 5, 5, one], ['snail shell', 5, 6, one], ['rope coil', 5, 7, one],
  ['laurel sprig', 6, 2, one], ['fern leaf', 6, 3, one], ['eucalyptus sprig', 6, 4, one], ['wheat ear', 6, 5, one],
  ['pine twig', 6, 6, one], ['lavender sprig', 6, 7, one],
  ['paper plane', 7, 1, one], ['mountain range', 7, 2, one], ['sailboat', 7, 3, one], ['anchor', 7, 4, one],
  ['lighthouse', 7, 5, one], ['hot air balloon', 7, 6, one], ['gulls in flight', 7, 7, one],
] as const).map(([name, family, variant, tile], i) => Object.freeze({ id: i + 1, name, family, variant, tile, entry: (family << 5) | (variant << 2) | tile })))

/** The studio's lines are ids 1 to TATTOO_STUDIO_LINES; the street wears the designs after them. */
export const TATTOO_STUDIO_LINES = 12

/** Each family's eight design ids in variant order (the card's design row: ids are not contiguous by family). */
export const TATTOO_BY_FAMILY: readonly (readonly number[])[] = Object.freeze(TATTOO_FAMILIES.map((_, family) =>
  Object.freeze(Array.from({ length: 8 }, (_, variant) => TATTOO_MOTIFS.find((m) => m.family === family && m.variant === variant)!.id))))

/** The designs' entry bytes, four to a u32 (id 1 in the low byte of the first), as the shader's table holds them. */
export const TATTOO_MOTIF_PACKED: readonly number[] = Object.freeze(Array.from({ length: TATTOO_MOTIFS.length / 4 }, (_, w) =>
  TATTOO_MOTIFS.slice(4 * w, 4 * w + 4).reduce((word, m, k) => (word | (m.entry << (8 * k))) >>> 0, 0)))

/** A point of a picture on its 15 by 15 grid (0..14 each way, 7 the centre, y up); PEN lifts the pen between strokes. */
export type TattooPoint = readonly [number, number]
export const TATTOO_PEN: TattooPoint = Object.freeze([15, 15] as const)
const PEN = TATTOO_PEN

/**
 * The eight pictures (the pictures family's variants, in order), one polyline each: an origami crane (tail, body,
 * neck and head, the wing, the fold), a paper plane, a mountain range with a snow line, a sailboat (hull, mainsail on
 * the mast, jib), an anchor (ring, shank, stock, arms with flukes), a lighthouse (tower, gallery, lamp room, roof,
 * beams), a hot air balloon (envelope, ropes, basket) and gulls in flight.
 */
export const TATTOO_PICTURES: readonly (readonly TattooPoint[])[] = Object.freeze(([
  [[0, 9], [5, 6], [7, 4], [9, 6], [12, 11], [14, 10], PEN, [5, 6], [8, 14], [9, 6], PEN, [7, 4], [8, 14]],
  [[1, 6], [14, 11], [4, 3], [1, 6], PEN, [14, 11], [5, 6], [4, 3]],
  [[0, 3], [4, 10], [6, 7], [9, 12], [14, 3], [0, 3], PEN, [8, 10], [9, 9], [10, 10]],
  [[2, 4], [12, 4], [10, 2], [4, 2], [2, 4], PEN, [7, 5], [7, 14], [12, 5], [7, 5], PEN, [6, 13], [2, 5], [6, 5]],
  [[7, 14], [8, 13], [8, 12], [7, 11], [6, 12], [6, 13], [7, 14], PEN, [7, 11], [7, 1], PEN, [4, 10], [10, 10], PEN, [1, 5], [3, 3], [5, 2], [7, 1], [9, 2], [11, 3], [13, 5], PEN, [1, 5], [1, 7], PEN, [13, 5], [13, 7]],
  [[4, 0], [6, 10], [8, 10], [10, 0], [4, 0], PEN, [5, 10], [9, 10], PEN, [6, 10], [6, 12], [8, 12], [8, 10], PEN, [5, 12], [7, 14], [9, 12], PEN, [9, 11], [14, 13], PEN, [9, 11], [14, 9], PEN, [5, 4], [9, 4]],
  [[7, 14], [10, 13], [12, 10], [11, 7], [8, 4], [6, 4], [3, 7], [2, 10], [4, 13], [7, 14], PEN, [6, 4], [6, 2], PEN, [8, 4], [8, 2], PEN, [5, 2], [9, 2], [9, 0], [5, 0], [5, 2]],
  [[0, 9], [2, 11], [4, 11], [6, 9], [8, 11], [10, 11], [12, 9], PEN, [7, 4], [8, 5], [9, 5], [10, 4], [11, 5], [12, 5], [13, 4]],
] as TattooPoint[][]).map((line) => Object.freeze(line.map((p) => Object.freeze([p[0], p[1]] as const)))))

/** The heartbeat line's one period (the bands family's variant 6), on the same grid; it rides the table after the pictures. */
export const TATTOO_HEARTBEAT: readonly TattooPoint[] = Object.freeze(([[0, 7], [5, 7], [6, 11], [7, 2], [8, 9], [9, 7], [14, 7]] as TattooPoint[]).map((p) => Object.freeze([p[0], p[1]] as const)))

/** Every polyline the shader's point table holds: the eight pictures, then the heartbeat. */
const POLYLINES: readonly (readonly TattooPoint[])[] = [...TATTOO_PICTURES, TATTOO_HEARTBEAT]

/**
 * Where each polyline starts in the point table, and one past the last (ten numbers: the pictures' starts, the
 * heartbeat's, the end).
 */
export const TATTOO_POINT_STARTS: readonly number[] = Object.freeze(POLYLINES.reduce<number[]>((starts, line) => [...starts, starts[starts.length - 1] + line.length], [0]))

/**
 * The point table as the shader holds it: each point a byte (x << 4 | y, so the pen is 255), four to a u32, the last
 * word padded with the pen.
 */
export const TATTOO_POINTS_PACKED: readonly number[] = Object.freeze((() => {
  const points = POLYLINES.flat()
  while (points.length % 4 !== 0) points.push(PEN)
  return Array.from({ length: points.length / 4 }, (_, w) => points.slice(4 * w, 4 * w + 4).reduce((word, [x, y], k) => (word | (((x << 4) | y) << (8 * k))) >>> 0, 0))
})())

/** The starts as the shader holds them: two 16-bit indices to a u32 (picture v's start and end are entries v and v + 1). */
export const TATTOO_POINT_STARTS_PACKED: readonly number[] = Object.freeze(Array.from({ length: TATTOO_POINT_STARTS.length / 2 }, (_, w) =>
  (TATTOO_POINT_STARTS[2 * w] | (TATTOO_POINT_STARTS[2 * w + 1] << 16)) >>> 0))

/** An ink: its name (the wardrobe's option), its linear albedo (what the shader mixes) and its swatch (sRGB, for the card). */
export interface TattooInk {
  readonly name: string
  readonly rgb: TattooRgb
  readonly hex: number
}

/**
 * The eight inks, by value: black (as every tattoo was inked before there was a choice), indigo, white, gold leaf and
 * luminescent (the ink studio's two lines, never drawn by the street; gold leaf has a metal's sheen and luminescent a
 * faint glow in the shader), brick red, forest green, grey wash. One ink colours every zone of a look.
 */
export const TATTOO_INKS: readonly TattooInk[] = Object.freeze(([
  ['black', [0.012, 0.012, 0.014], 0x1d1d1f],
  ['indigo', [0.03, 0.04, 0.12], 0x303861],
  ['white', [0.8, 0.78, 0.74], 0xe7e5df],
  ['gold leaf', [0.6, 0.47, 0.22], 0xcbb681],
  ['luminescent', [0.55, 0.95, 0.8], 0xc4f9e7],
  ['brick red', [0.36, 0.06, 0.05], 0xa2453f],
  ['forest green', [0.04, 0.2, 0.09], 0x387c55],
  ['grey wash', [0.16, 0.16, 0.17], 0x6f6f73],
] as const).map(([name, rgb, hex]) => Object.freeze({ name, rgb: Object.freeze([...rgb] as const), hex })))

/** The inks' values, by name (TATTOO_INKS' order). */
export const TATTOO_INK = Object.freeze({ black: 0, indigo: 1, white: 2, goldLeaf: 3, luminescent: 4, brickRed: 5, forestGreen: 6, greyWash: 7 })

/** The inks the street never wears: the studio's gold leaf and luminescent, earned there. */
export const TATTOO_SHOP_INKS: readonly number[] = Object.freeze([TATTOO_INK.goldLeaf, TATTOO_INK.luminescent])

/**
 * The zone sets the street draws a carrier's from (bit z for zone z): one hand, the other hand, the neck, the nape,
 * one forearm, the other forearm, both forearms, or the calf with the ankle. Two zones take the first design link for
 * the lower zone and the second link for the higher.
 */
export const TATTOO_STREET_SETS: readonly number[] = Object.freeze([1, 2, 4, 8, 16, 32, 48, 192])

/** The street's sets, a byte each, four to a u32, as the shader holds them. */
export const TATTOO_STREET_SETS_PACKED: readonly number[] = Object.freeze([0, 1].map((w) =>
  TATTOO_STREET_SETS.slice(4 * w, 4 * w + 4).reduce((word, set, k) => (word | (set << (8 * k))) >>> 0, 0)))

/**
 * The contrast rule's constants: the line is the skin mixed `mix` of the way to the ink; WCAG's relative luminance
 * weights; the 3:1 target (WCAG 1.4.11, for graphics); the two poles a halo moves toward (a warm white for a dark
 * line, a brown-black for a light one, each past every skin tone so the target is always reachable); the line
 * luminance past which the pole is the dark one (where white and black contrast with the line alike); and the halo's
 * width outside the line, in motif units (a motif's square is 2 units across).
 */
export const TATTOO_HALO = Object.freeze({
  mix: 0.9,
  luminance: Object.freeze([0.2126, 0.7152, 0.0722] as const),
  contrast: 3,
  white: Object.freeze([1, 0.97, 0.92] as const),
  black: Object.freeze([0.012, 0.011, 0.01] as const),
  split: 0.179,
  width: 0.075,
})

/** WCAG relative luminance of a linear colour. */
export const tattooLuminance = (c: TattooRgb): number => TATTOO_HALO.luminance[0] * c[0] + TATTOO_HALO.luminance[1] * c[1] + TATTOO_HALO.luminance[2] * c[2]

/** The WCAG contrast ratio of two relative luminances (at least 1). */
export const tattooContrast = (a: number, b: number): number => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)

const mix3 = (a: TattooRgb, b: TattooRgb, t: number): TattooRgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]

/** What an ink looks like on a skin: the line's colour, the halo's (the skin under a full halo) and how far it moved, 0..1. */
export interface InkLine {
  readonly line: TattooRgb
  readonly halo: TattooRgb
  readonly t: number
}

/**
 * The CPU mirror of the shader's ink on a skin (linear RGB), for ink value `ink` (an out-of-range value is black).
 * The line is mix(skin, ink, 0.9). When it already stands out from the skin by 3:1, t is 0 and the halo is the skin.
 * Otherwise the halo moves the skin toward the pole (the warm white for a line at or below 0.179 luminance, the
 * brown-black above) by t = (need - Ls) / (Lpole - Ls), where need is the luminance at exactly 3:1 from the line on
 * the pole's side (3 Lline + 0.1 toward white, (Lline + 0.05) / 3 - 0.05 toward black). Luminance is linear in linear
 * colour, so the halo lands on 3:1 exactly.
 */
export function inkLine(skin: TattooRgb, ink: number): InkLine {
  const inkRgb = (TATTOO_INKS[ink] ?? TATTOO_INKS[0]).rgb
  const line = mix3(skin, inkRgb, TATTOO_HALO.mix)
  const li = tattooLuminance(line)
  const ls = tattooLuminance(skin)
  if (tattooContrast(li, ls) >= TATTOO_HALO.contrast) return Object.freeze({ line: Object.freeze(line), halo: Object.freeze([...skin] as const), t: 0 })
  const lite = li > TATTOO_HALO.split
  const pole = lite ? TATTOO_HALO.black : TATTOO_HALO.white
  const need = lite ? (li + 0.05) / TATTOO_HALO.contrast - 0.05 : TATTOO_HALO.contrast * li + 0.1
  const t = Math.min(1, Math.max(0, (need - ls) / (tattooLuminance(pole) - ls)))
  return Object.freeze({ line: Object.freeze(line), halo: Object.freeze(mix3(skin, pole, t)), t })
}
