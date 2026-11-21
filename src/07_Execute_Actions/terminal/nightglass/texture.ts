// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how the reference renderer keeps and reads images: the byte layout of an image's
 * levels, layers, rows and samples, the checked reads and writes of single texels through the format arithmetic of
 * formats.ts, and the fixed-function texture unit (nearest and linear filters, clamp, repeat and mirror wrapping, the
 * choice and blending of mip levels, the level of detail from screen-space rates of change, the texel load that reads
 * zero outside the image, and the storage write that drops anything outside it). Its rules are the pinned sampling
 * rules of docs/nightglass.md, and a GPU's samples are compared against these.
 * What breaks if it is removed? The reference renderer would have nowhere to keep an image and no way to read one
 * through a sampler, so no textured draw, copy or storage image could run on it.
 *
 * LAYOUT. One Uint8Array holds the image level by level; within a level layer by layer, within a layer row by row
 * from the top, within a row pixel by pixel, and within a pixel sample by sample. Level l is max(1, width >> l) by
 * max(1, height >> l) pixels. The bytes may be a store's own or a slice of the memory the image is bound to.
 *
 * SAMPLING. The level of detail is clamped to [lodMin, lodMax] (not a number reads as lodMin). At or below 0 the image
 * is magnified: the `mag` filter reads the view's first level. Above 0 the `min` filter reads the level the `mip`
 * filter picks: `nearest` takes level ceil(lod + 0.5) - 1, so the switch to the next level falls just past each
 * half; `linear` blends levels floor(lod) and floor(lod) + 1 by the fraction. Levels are counted from the view's
 * first and held to its last. In a level of W x H texels, `nearest` reads texel floor(u W), and `linear` blends the
 * four texels around (u W - 0.5, v H - 0.5) by its fractions; each texel index is wrapped into the level (`clamp` to
 * the edge, `repeat` with period W, `mirror` with period 2W, the second half reversed). The layer is rounded to the
 * nearest (halves up) and clamped into the view's layers; layers are never blended. Texels are decoded before they
 * are filtered, so sRGB images filter in linear light and depth images filter their depth (channel 0). Filtering runs
 * in double precision and the result rounds once to f32.
 */
import type { Filter, Range, Wrap } from './api.ts'
import { fail } from './fault.ts'
import { FORMATS, decodeTexel, encodeTexel, isFormat, sampleKind } from './formats.ts'
import type { Format } from './formats.ts'

/** The largest width or height a store holds, and the most layers: bounds that keep every byte offset exact. */
export const STORE_MAX_SIZE = 32768
export const STORE_MAX_LAYERS = 2048

/**
 * A coordinate's size is held to 2^24, where an f32 has no fraction left: every f32 beyond it is an even whole number,
 * so the clamp changes no texel any wrap mode picks, and keeps every texel-space product exact.
 */
const COORD_LIMIT = 2 ** 24

/** What an image is: the fields of a descriptor the store is built from. */
export interface ImageDesc {
  readonly format: Format
  readonly width: number
  readonly height: number
  readonly layers: number
  readonly levels: number
  readonly samples: 1 | 4
}

/** The width or height of mip level `level` of an image `size` texels across: halved and rounded down, at least 1. */
export function levelSize(size: number, level: number): number {
  return Math.max(1, Math.floor(size / 2 ** level))
}

/** The bytes an image takes in the store's layout. Refuses a descriptor the store cannot hold. */
export function imageSize(desc: ImageDesc): number {
  const starts = layoutOf(desc)
  return starts[starts.length - 1]
}

/** Checks a descriptor and returns the byte at which each level starts, and one past the end. */
function layoutOf(desc: ImageDesc): number[] {
  const bad = (rule: string): never => fail('invalid', `image store: ${rule}`)
  if (typeof desc !== 'object' || desc === null) bad('the descriptor must be an object')
  if (!isFormat(desc.format)) bad(`${String(desc.format)} is not a format`)
  const whole = (v: unknown, hi: number): boolean => Number.isInteger(v) && (v as number) >= 1 && (v as number) <= hi
  if (!whole(desc.width, STORE_MAX_SIZE) || !whole(desc.height, STORE_MAX_SIZE)) bad(`the size ${String(desc.width)} x ${String(desc.height)} is not whole texels from 1 to ${STORE_MAX_SIZE}`)
  if (!whole(desc.layers, STORE_MAX_LAYERS)) bad(`${String(desc.layers)} layers is not a whole number from 1 to ${STORE_MAX_LAYERS}`)
  const chain = Math.floor(Math.log2(Math.max(desc.width, desc.height))) + 1
  if (!whole(desc.levels, chain)) bad(`${String(desc.levels)} levels is not a whole number from 1 to ${chain}, the levels a ${desc.width} x ${desc.height} image has`)
  if (desc.samples !== 1 && desc.samples !== 4) bad(`${String(desc.samples)} is not a sample count (1 or 4)`)
  const starts = [0]
  for (let l = 0; l < desc.levels; l++) {
    starts.push(starts[l] + levelSize(desc.width, l) * levelSize(desc.height, l) * desc.layers * desc.samples * FORMATS[desc.format].bytes)
  }
  return starts
}

/** An image's bytes and its shape, with checked access to single texels. */
export class ImageStore implements ImageDesc {
  readonly format: Format
  readonly width: number
  readonly height: number
  readonly layers: number
  readonly levels: number
  readonly samples: 1 | 4
  /** Bytes of one texel (one sample of one pixel). */
  readonly texelBytes: number
  /** The byte at which each level starts, then one past the last byte. */
  readonly starts: readonly number[]
  readonly bytes: Uint8Array

  /**
   * A store for an image. With `bytes` (at least `imageSize(desc)` long, such as a slice of the memory it is bound to) the store
   * reads and writes those bytes; without, it allocates its own, zeroed.
   */
  constructor(desc: ImageDesc, bytes?: Uint8Array) {
    const starts = layoutOf(desc)
    const size = starts[starts.length - 1]
    this.format = desc.format
    this.width = desc.width
    this.height = desc.height
    this.layers = desc.layers
    this.levels = desc.levels
    this.samples = desc.samples
    this.texelBytes = FORMATS[desc.format].bytes
    this.starts = Object.freeze(starts)
    if (bytes === undefined) {
      try {
        this.bytes = new Uint8Array(size)
      } catch {
        fail('memory', `image store: ${size} bytes for a ${desc.width} x ${desc.height} ${desc.format} image could not be allocated`)
      }
    } else {
      if (!(bytes instanceof Uint8Array) || bytes.length < size) fail('invalid', `image store: the ${desc.format} image needs ${size} bytes and was given fewer`)
      this.bytes = bytes.subarray(0, size)
    }
  }

  levelWidth(level: number): number {
    return levelSize(this.width, level)
  }

  levelHeight(level: number): number {
    return levelSize(this.height, level)
  }

  /** The byte offset of one sample of one texel. Refuses a texel outside the image. */
  offset(level: number, layer: number, x: number, y: number, sample = 0): number {
    const inside = index(level, this.levels) && index(layer, this.layers) && index(x, this.levelWidth(level)) && index(y, this.levelHeight(level)) && index(sample, this.samples)
    if (!inside) {
      fail('invalid', `image store: texel (${String(x)}, ${String(y)}) of level ${String(level)}, layer ${String(layer)}, sample ${String(sample)} is outside the ${this.width} x ${this.height} ${this.format} image of ${this.levels} levels, ${this.layers} layers and ${this.samples} samples`)
    }
    return texelAt(this, level, layer, x, y, sample)
  }

  /** Decodes one texel into `out` (r, g, b, a) as formats.ts reads it. */
  read(level: number, layer: number, x: number, y: number, sample: number, out: number[]): void {
    decodeTexel(this.format, this.bytes, this.offset(level, layer, x, y, sample), out)
  }

  /** Encodes `value` (r, g, b, a) into one texel as formats.ts writes it. */
  write(level: number, layer: number, x: number, y: number, sample: number, value: ArrayLike<number>): void {
    encodeTexel(this.format, value, this.bytes, this.offset(level, layer, x, y, sample))
  }
}

/** True when `i` is a whole number in [0, n). */
function index(i: number, n: number): boolean {
  return Number.isInteger(i) && i >= 0 && i < n
}

/** The byte offset of a texel the caller has already placed inside the image. */
function texelAt(store: ImageStore, level: number, layer: number, x: number, y: number, sample: number): number {
  const w = levelSize(store.width, level)
  const h = levelSize(store.height, level)
  return store.starts[level] + (((layer * h + y) * w + x) * store.samples + sample) * store.texelBytes
}

// ---------------------------------------------------------------------------------------------------
// Views, samplers and the texture unit

/** The levels and layers of an image a view shows, as api.ts's View holds them. */
export interface ViewRange {
  readonly levels: Range
  readonly layers: Range
}

/** How a sampler filters and wraps, as api.ts's Sampler holds it. The third wrap mode is unused: images are 2D. */
export interface SamplerState {
  readonly mag: Filter
  readonly min: Filter
  readonly mip: Filter
  readonly wrap: readonly [Wrap, Wrap, Wrap]
  readonly lodMin: number
  readonly lodMax: number
}

function checkRange(r: Range, total: number, what: string): void {
  if (typeof r !== 'object' || r === null || !Number.isInteger(r.base) || !Number.isInteger(r.count) || r.base < 0 || r.count < 1 || r.base + r.count > total) {
    fail('invalid', `image view: its ${what} must be a range of at least one within the image's ${total} ${what}`)
  }
}

function checkView(store: ImageStore, view: ViewRange): void {
  if (!(store instanceof ImageStore)) fail('invalid', 'image view: the image must be an ImageStore')
  if (typeof view !== 'object' || view === null) fail('invalid', 'image view: the view must be an object')
  checkRange(view.levels, store.levels, 'levels')
  checkRange(view.layers, store.layers, 'layers')
}

function checkSampler(s: SamplerState): void {
  const filter = (f: unknown): boolean => f === 'nearest' || f === 'linear'
  const wrap = (w: unknown): boolean => w === 'clamp' || w === 'repeat' || w === 'mirror'
  const ok = typeof s === 'object' && s !== null && filter(s.mag) && filter(s.min) && filter(s.mip) && Array.isArray(s.wrap) && wrap(s.wrap[0]) && wrap(s.wrap[1]) && wrap(s.wrap[2])
  if (!ok || !(s.lodMin <= s.lodMax)) fail('invalid', 'sampler: it needs nearest or linear filters, clamp, repeat or mirror wrapping, and lodMin no greater than lodMax')
}

/**
 * Samples a view at (u, v) on a layer (counted from the view's first) with an explicit level of detail, writing the
 * filtered colour (r, g, b, a) to `out`. Integer images cannot be read through a sampler; `load` reads them.
 */
export function sample(store: ImageStore, view: ViewRange, sampler: SamplerState, u: number, v: number, layer: number, lod: number, out: number[]): void {
  checkView(store, view)
  checkSampler(sampler)
  const kind = sampleKind(store.format)
  if (kind === 'uint' || kind === 'sint') fail('invalid', `sample: a ${store.format} image holds integers and is read with a texel load, not through a sampler`)
  const cu = coordinate(u)
  const cv = coordinate(v)
  const rounded = Math.floor(layer + 0.5)
  const at = view.layers.base + (rounded >= view.layers.count ? view.layers.count - 1 : rounded > 0 ? rounded : 0)
  const l = lod >= sampler.lodMax ? sampler.lodMax : lod >= sampler.lodMin ? lod : sampler.lodMin
  const base = view.levels.base
  const last = view.levels.count - 1
  if (!(l > 0)) {
    filterLevel(store, base, at, sampler.mag, sampler, cu, cv, out)
  } else if (sampler.mip === 'nearest') {
    filterLevel(store, base + Math.min(Math.ceil(l + 0.5) - 1, last), at, sampler.min, sampler, cu, cv, out)
  } else {
    const lo = Math.floor(l)
    const f = l - lo
    filterLevel(store, base + Math.min(lo, last), at, sampler.min, sampler, cu, cv, out)
    if (lo < last && f > 0) {
      filterLevel(store, base + lo + 1, at, sampler.min, sampler, cu, cv, upper)
      for (let c = 0; c < 4; c++) out[c] = (1 - f) * out[c] + f * upper[c]
    }
  }
  for (let c = 0; c < 4; c++) out[c] = Math.fround(out[c])
}

/** Scratch texels for filtering: the four corners, and the second level of a linear mip blend. */
const t00 = [0, 0, 0, 1]
const t10 = [0, 0, 0, 1]
const t01 = [0, 0, 0, 1]
const t11 = [0, 0, 0, 1]
const upper = [0, 0, 0, 1]

/** A coordinate as the texture unit takes it: not a number reads as 0, and its size is held to COORD_LIMIT. */
function coordinate(u: number): number {
  if (Number.isNaN(u)) return 0
  return u >= COORD_LIMIT ? COORD_LIMIT : u <= -COORD_LIMIT ? -COORD_LIMIT : u
}

/** Reads one level (absolute) of one layer (absolute) through a filter. */
function filterLevel(store: ImageStore, level: number, layer: number, filter: Filter, sampler: SamplerState, u: number, v: number, out: number[]): void {
  const w = levelSize(store.width, level)
  const h = levelSize(store.height, level)
  const [wrapU, wrapV] = sampler.wrap
  if (filter === 'nearest') {
    const i = wrapIndex(Math.floor(u * w), w, wrapU)
    const j = wrapIndex(Math.floor(v * h), h, wrapV)
    decodeTexel(store.format, store.bytes, texelAt(store, level, layer, i, j, 0), out)
    return
  }
  const tx = u * w - 0.5
  const ty = v * h - 0.5
  const fx = Math.floor(tx)
  const fy = Math.floor(ty)
  const a = tx - fx
  const b = ty - fy
  const i0 = wrapIndex(fx, w, wrapU)
  const i1 = wrapIndex(fx + 1, w, wrapU)
  const j0 = wrapIndex(fy, h, wrapV)
  const j1 = wrapIndex(fy + 1, h, wrapV)
  decodeTexel(store.format, store.bytes, texelAt(store, level, layer, i0, j0, 0), t00)
  decodeTexel(store.format, store.bytes, texelAt(store, level, layer, i1, j0, 0), t10)
  decodeTexel(store.format, store.bytes, texelAt(store, level, layer, i0, j1, 0), t01)
  decodeTexel(store.format, store.bytes, texelAt(store, level, layer, i1, j1, 0), t11)
  for (let c = 0; c < 4; c++) out[c] = (1 - a) * (1 - b) * t00[c] + a * (1 - b) * t10[c] + (1 - a) * b * t01[c] + a * b * t11[c]
}

/** A texel index wrapped into [0, n). */
function wrapIndex(i: number, n: number, mode: Wrap): number {
  if (mode === 'clamp') return i >= n ? n - 1 : i > 0 ? i : 0
  const period = mode === 'repeat' ? n : 2 * n
  const r = i - period * Math.floor(i / period)
  return r < n ? r : period - 1 - r
}

/**
 * The level of detail of a sample whose coordinates change by (dudx, dvdx) from one pixel to the next along x and by
 * (dudy, dvdy) along y, on a view whose first level is `width` x `height`: log2 of the longer of the two steps
 * measured in texels, sqrt((dudx W)^2 + (dvdx H)^2) and sqrt((dudy W)^2 + (dvdy H)^2). No change at all gives
 * -Infinity, which `sample` clamps to lodMin.
 */
export function lodFromRates(dudx: number, dvdx: number, dudy: number, dvdy: number, width: number, height: number): number {
  const x = Math.sqrt((dudx * width) ** 2 + (dvdx * height) ** 2)
  const y = Math.sqrt((dudy * width) ** 2 + (dvdy * height) ** 2)
  return Math.log2(Math.max(x, y))
}

/**
 * The texel load: decodes the texel at (x, y) of a level and a layer (both counted from the view's first) into `out`.
 * Anything outside the view (a position, layer or level out of range, or not a whole number) reads as zero in all
 * four channels. A multisampled image reads its first sample.
 */
export function load(store: ImageStore, view: ViewRange, x: number, y: number, layer: number, level: number, out: number[]): void {
  checkView(store, view)
  if (index(level, view.levels.count) && index(layer, view.layers.count)) {
    const l = view.levels.base + level
    if (index(x, levelSize(store.width, l)) && index(y, levelSize(store.height, l))) {
      decodeTexel(store.format, store.bytes, texelAt(store, l, view.layers.base + layer, x, y, 0), out)
      return
    }
  }
  out[0] = 0
  out[1] = 0
  out[2] = 0
  out[3] = 0
}

/** The storage write: encodes `value` at (x, y) of the view's first level on a layer of the view. Anything outside is dropped. */
export function put(store: ImageStore, view: ViewRange, x: number, y: number, layer: number, value: ArrayLike<number>): void {
  checkView(store, view)
  const l = view.levels.base
  if (index(layer, view.layers.count) && index(x, levelSize(store.width, l)) && index(y, levelSize(store.height, l))) {
    encodeTexel(store.format, value, store.bytes, texelAt(store, l, view.layers.base + layer, x, y, 0))
  }
}
