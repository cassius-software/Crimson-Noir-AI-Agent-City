// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the reference renderer's output merger: the depth test's comparison and the depth a
 * depth format really holds, blending by WebGPU's factors and operations with the clamping unorm attachments need,
 * the write mask, and the average a four-sample attachment resolves to. These are the last fixed-function steps
 * before a fragment's colour lands in an image, and docs/nightglass.md pins them for both back ends.
 * What breaks if it is removed? The reference renderer could not test depth, blend or resolve, so every draw would
 * overwrite what was there, and its pictures would differ from a GPU's wherever transparency or depth is involved.
 *
 * Blending follows WebGPU: result = src * srcFactor (op) dst * dstFactor, for the colour channels with the `color`
 * part and for alpha with the `alpha` part; `min` and `max` take the smaller or larger of src and dst and ignore the
 * factors; `src-alpha-saturated` is min(src alpha, 1 - dst alpha) for colour and 1 for alpha. Into a unorm format the
 * source and the constant are clamped to [0, 1] first, and so is the result. The arithmetic runs in double precision
 * and the stored colour rounds once to f32 before the format encodes it (an integer format's values pass unrounded).
 */
import type { BlendFactor, BlendOp, BlendPart, ColorOutput, Compare } from './api.ts'
import { fail } from './fault.ts'
import { FORMATS, fromUnorm, isFormat, saturate, toUnorm } from './formats.ts'
import type { Format } from './formats.ts'
import { ImageStore } from './texture.ts'

/** A colour output's blending: one part for the colour channels and one for alpha. */
export type BlendState = NonNullable<ColorOutput['blend']>

/** The depth test: true when `compare` holds of the fragment's depth and the stored one (fragment on the left). */
export function passes(compare: Compare, fragment: number, stored: number): boolean {
  switch (compare) {
    case 'never': return false
    case 'less': return fragment < stored
    case 'equal': return fragment === stored
    case 'less-equal': return fragment <= stored
    case 'greater': return fragment > stored
    case 'not-equal': return fragment !== stored
    case 'greater-equal': return fragment >= stored
    case 'always': return true
    default: return fail('invalid', `depth test: ${String(compare)} is not a comparison`)
  }
}

/**
 * The depth a depth format holds for a fragment's depth: clamped to [0, 1], then rounded to 16-bit unorm or to f32,
 * exactly what writing it and reading it back gives. The test compares this, not the unrounded depth, so a surface
 * drawn twice meets itself with `equal` and a depth just past a stored one is not taken as nearer.
 */
export function depthOf(format: Format, depth: number): number {
  if (format === 'depth16') return fromUnorm(toUnorm(depth, 16), 16)
  if (format === 'depth32f') return Math.fround(saturate(depth))
  return fail('invalid', `depth test: ${String(format)} is not a depth format`)
}

/** Scratch: the source, destination and constant after clamping, and the blended colour. */
const s4 = [0, 0, 0, 0]
const d4 = [0, 0, 0, 0]
const k4 = [0, 0, 0, 0]
const r4 = [0, 0, 0, 0]

/**
 * The colour to store for one sample: `src` (the fragment's output) blended with `dst` (the colour stored now) by
 * `state` (null: no blending, the source is stored), with `constant` the pass's blend constant, then the write mask
 * applied (bit 1 red, 2 green, 4 blue, 8 alpha): a channel left out of the mask keeps `dst`'s value. Writes r, g, b, a
 * to `out`.
 */
export function blend(format: Format, state: BlendState | null, mask: number, src: ArrayLike<number>, dst: ArrayLike<number>, constant: ArrayLike<number>, out: number[]): void {
  if (!isFormat(format)) fail('invalid', `blending: ${String(format)} is not a format`)
  const info = FORMATS[format]
  if (!info.color) fail('invalid', `blending: ${format} is not a colour format`)
  if (!Number.isInteger(mask) || mask < 0 || mask > 15) fail('invalid', `blending: the write mask ${String(mask)} is not a whole number from 0 to 15`)
  if (state !== null && !info.blend) fail('invalid', `blending: a ${format} attachment cannot be blended into`)
  const unorm = info.kind === 'unorm'
  for (let c = 0; c < 4; c++) {
    s4[c] = unorm ? saturate(src[c]) : src[c]
    k4[c] = unorm ? saturate(constant[c]) : constant[c]
    d4[c] = dst[c]
  }
  if (state === null) {
    for (let c = 0; c < 4; c++) r4[c] = s4[c]
  } else {
    for (let c = 0; c < 3; c++) r4[c] = combine(state.color, c)
    r4[3] = combine(state.alpha, 3)
  }
  const integer = info.kind === 'uint' || info.kind === 'sint'
  for (let c = 0; c < 4; c++) {
    if ((mask >> c) & 1) out[c] = integer ? r4[c] : Math.fround(unorm ? saturate(r4[c]) : r4[c])
    else out[c] = dst[c]
  }
}

/** One channel blended by one part, from the clamped scratch colours. */
function combine(part: BlendPart, c: number): number {
  const src = s4[c] * factor(part.src, c)
  const dst = d4[c] * factor(part.dst, c)
  const op: BlendOp = part.op ?? 'add'
  switch (op) {
    case 'add': return src + dst
    case 'subtract': return src - dst
    case 'reverse-subtract': return dst - src
    case 'min': return Math.min(s4[c], d4[c])
    case 'max': return Math.max(s4[c], d4[c])
    default: return fail('invalid', `blending: ${String(op)} is not a blend operation`)
  }
}

/** A blend factor for channel c (3 is alpha). */
function factor(f: BlendFactor, c: number): number {
  switch (f) {
    case 'zero': return 0
    case 'one': return 1
    case 'src': return s4[c]
    case 'one-minus-src': return 1 - s4[c]
    case 'src-alpha': return s4[3]
    case 'one-minus-src-alpha': return 1 - s4[3]
    case 'dst': return d4[c]
    case 'one-minus-dst': return 1 - d4[c]
    case 'dst-alpha': return d4[3]
    case 'one-minus-dst-alpha': return 1 - d4[3]
    case 'src-alpha-saturated': return c === 3 ? 1 : Math.min(s4[3], 1 - d4[3])
    case 'constant': return k4[c]
    case 'one-minus-constant': return 1 - k4[c]
    default: return fail('invalid', `blending: ${String(f)} is not a blend factor`)
  }
}

/**
 * Resolves a four-sample image into one level and layer of a one-sample image of the same format and size: each
 * pixel becomes the average of its four samples, decoded (so sRGB averages in linear light), summed in sample order,
 * divided by four, rounded to f32 and encoded. Only unorm and float formats resolve.
 */
export function resolveInto(src: ImageStore, dst: ImageStore, level: number, layer: number): void {
  if (!(src instanceof ImageStore) || !(dst instanceof ImageStore)) fail('invalid', 'resolve: both images must be ImageStores')
  if (src.samples !== 4 || src.levels !== 1 || src.layers !== 1) fail('invalid', 'resolve: the source must have four samples, one level and one layer')
  if (dst.samples !== 1) fail('invalid', 'resolve: the destination must have one sample')
  if (src.format !== dst.format) fail('mismatch', `resolve: a ${src.format} image cannot resolve into a ${dst.format} one`)
  const kind = FORMATS[src.format].kind
  if (kind !== 'unorm' && kind !== 'float') fail('invalid', `resolve: a ${src.format} image cannot be averaged; only unorm and float formats resolve`)
  if (!Number.isInteger(level) || level < 0 || level >= dst.levels || !Number.isInteger(layer) || layer < 0 || layer >= dst.layers) {
    fail('invalid', `resolve: level ${String(level)}, layer ${String(layer)} is not in the destination`)
  }
  if (dst.levelWidth(level) !== src.width || dst.levelHeight(level) !== src.height) {
    fail('mismatch', `resolve: the ${src.width} x ${src.height} source does not match the destination's ${dst.levelWidth(level)} x ${dst.levelHeight(level)} level`)
  }
  const texel = [0, 0, 0, 0]
  const sum = [0, 0, 0, 0]
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      sum.fill(0)
      for (let s = 0; s < 4; s++) {
        src.read(0, 0, x, y, s, texel)
        for (let c = 0; c < 4; c++) sum[c] += texel[c]
      }
      for (let c = 0; c < 4; c++) sum[c] = Math.fround(sum[c] / 4)
      dst.write(level, layer, x, y, 0, sum)
    }
  }
}
