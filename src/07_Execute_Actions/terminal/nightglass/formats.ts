// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the table of the image formats Nightglass knows and what each may be used for, and
 * the exact arithmetic that turns a texel's bytes into numbers and back (unsigned normalised rounding, half floats,
 * the sRGB curve). The core checks every image and pipeline against the table, and the reference renderer stores and
 * reads every texel through these functions, so both back ends agree on what a byte means.
 * What breaks if it is removed? Formats would be checked in one place and stored in another, and the reference
 * renderer would round a colour differently from a GPU.
 */

/** How a format's channels are stored and read. */
export type FormatKind = 'unorm' | 'float' | 'uint' | 'sint' | 'depth'

export interface FormatInfo {
  /** Bytes one texel takes. */
  readonly bytes: number
  /** Channels stored (a depth format has one). */
  readonly channels: 1 | 2 | 3 | 4
  /** Bytes one channel takes. */
  readonly channelBytes: 1 | 2 | 4
  readonly kind: FormatKind
  /** Stored on the sRGB curve: written through encodeSrgb, read through decodeSrgb. */
  readonly srgb: boolean
  /** Byte order of the colour channels in memory (`bgra` swaps the first and third). */
  readonly order: 'rgba' | 'bgra'
  /** May be a colour attachment of a pass. */
  readonly color: boolean
  /** May be a depth attachment of a pass. */
  readonly depth: boolean
  /** May be blended into as a colour attachment. */
  readonly blend: boolean
  /** May be read through a linear filter. */
  readonly filter: boolean
  /** May be bound as a storage image (written by a shader). */
  readonly storage: boolean
  /** May be a four-sample attachment (and, for a colour format, resolved): never a 32-bit float or integer format. */
  readonly multisample: boolean
}

const color = (bytes: number, channels: 1 | 2 | 3 | 4, channelBytes: 1 | 2 | 4, kind: FormatKind, o: Partial<FormatInfo> = {}): FormatInfo =>
  Object.freeze({ bytes, channels, channelBytes, kind, srgb: false, order: 'rgba', color: true, depth: false, blend: kind === 'unorm' || kind === 'float', filter: kind === 'unorm' || kind === 'float', storage: false, multisample: channelBytes < 4 && (kind === 'unorm' || kind === 'float'), ...o })

/**
 * The formats. Names are Nightglass's own: channels, then bits per channel, then a suffix for what the bits mean
 * (none: unsigned normalised; `f`: float; `u`: unsigned integer; `i`: signed integer; `-srgb`: on the sRGB curve).
 */
export const FORMATS = Object.freeze({
  r8: color(1, 1, 1, 'unorm'),
  rg8: color(2, 2, 1, 'unorm'),
  rgba8: color(4, 4, 1, 'unorm', { storage: true }),
  'rgba8-srgb': color(4, 4, 1, 'unorm', { srgb: true }),
  bgra8: color(4, 4, 1, 'unorm', { order: 'bgra' }),
  'bgra8-srgb': color(4, 4, 1, 'unorm', { order: 'bgra', srgb: true }),
  r16f: color(2, 1, 2, 'float'),
  rg16f: color(4, 2, 2, 'float'),
  rgba16f: color(8, 4, 2, 'float', { storage: true }),
  r32f: color(4, 1, 4, 'float', { blend: false, filter: false, storage: true }),
  rg32f: color(8, 2, 4, 'float', { blend: false, filter: false, storage: true }),
  rgba32f: color(16, 4, 4, 'float', { blend: false, filter: false, storage: true }),
  r32u: color(4, 1, 4, 'uint', { storage: true }),
  r32i: color(4, 1, 4, 'sint', { storage: true }),
  depth16: Object.freeze({ bytes: 2, channels: 1, channelBytes: 2, kind: 'depth', srgb: false, order: 'rgba', color: false, depth: true, blend: false, filter: false, storage: false, multisample: true }),
  depth32f: Object.freeze({ bytes: 4, channels: 1, channelBytes: 4, kind: 'depth', srgb: false, order: 'rgba', color: false, depth: true, blend: false, filter: false, storage: false, multisample: true }),
} satisfies Record<string, FormatInfo>)

export type Format = keyof typeof FORMATS

/** Every format name, in the table's order. */
export const FORMAT_NAMES: readonly Format[] = Object.freeze(Object.keys(FORMATS) as Format[])

/** True when the string names a format. */
export function isFormat(name: unknown): name is Format {
  return typeof name === 'string' && Object.hasOwn(FORMATS, name)
}

/** What a sampled image of this format hands a shader: floats, unsigned or signed integers, or depth. */
export function sampleKind(format: Format): 'float' | 'uint' | 'sint' | 'depth' {
  const k = FORMATS[format].kind
  return k === 'unorm' ? 'float' : k
}

// ---------------------------------------------------------------------------------------------------
// The arithmetic of a texel

/** f32 rounding, used by every float path. */
const f32 = Math.fround

/** Clamps to [0, 1]; NaN becomes 0. */
export function saturate(x: number): number {
  return x > 0 ? (x < 1 ? x : 1) : 0
}

/** A float in [0, 1] as an unsigned normalised integer of `bits` bits, rounded to nearest (ties away from zero). */
export function toUnorm(x: number, bits: 8 | 16): number {
  const max = bits === 8 ? 255 : 65535
  return Math.floor(saturate(x) * max + 0.5)
}

/** An unsigned normalised integer back to its float. */
export function fromUnorm(v: number, bits: 8 | 16): number {
  return f32(v / (bits === 8 ? 255 : 65535))
}

/** Linear light to the sRGB curve (both in [0, 1]). */
export function encodeSrgb(x: number): number {
  const c = saturate(x)
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055
}

/** The sRGB curve to linear light. */
export function decodeSrgb(x: number): number {
  const c = saturate(x)
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
}

const scratch = new DataView(new ArrayBuffer(4))

/**
 * The bits of the IEEE half float nearest an f32: a double that is not an f32 is first rounded to one, then to half,
 * ties to even (the two roundings can move a near tie); overflow becomes infinity, NaN stays NaN.
 */
export function toHalf(value: number): number {
  scratch.setFloat32(0, value, true)
  const x = scratch.getUint32(0, true)
  const sign = (x >>> 16) & 0x8000
  const exp = (x >>> 23) & 0xff
  const mant = x & 0x7fffff
  if (exp === 0xff) return sign | 0x7c00 | (mant !== 0 ? 0x200 : 0)
  const e = exp - 127 + 15
  if (e >= 0x1f) return sign | 0x7c00
  if (e <= 0) {
    // Subnormal half (or zero): shift the full mantissa, with its implicit one, into place and round to nearest even.
    if (e < -10) return sign
    const m = mant | 0x800000
    const shift = 14 - e
    const half = m >>> shift
    const rest = m & ((1 << shift) - 1)
    const mid = 1 << (shift - 1)
    return sign | (rest > mid || (rest === mid && (half & 1) === 1) ? half + 1 : half)
  }
  const half = (e << 10) | (mant >>> 13)
  const rest = mant & 0x1fff
  // A carry out of the mantissa rounds up into the exponent, which is the correct next half (or infinity).
  return sign | (rest > 0x1000 || (rest === 0x1000 && (half & 1) === 1) ? half + 1 : half)
}

/** The bits of an IEEE half float as a number. */
export function fromHalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1
  const exp = (bits >>> 10) & 0x1f
  const mant = bits & 0x3ff
  if (exp === 0) return sign * mant * 2 ** -24
  if (exp === 0x1f) return mant === 0 ? sign * Infinity : NaN
  return sign * (1 + mant / 1024) * 2 ** (exp - 15)
}

/**
 * Writes one texel. `value` holds four channels (r, g, b, a; a depth format reads only the first) as the shader saw
 * them: linear floats for unorm and float formats, integers for uint and sint. Channels the format lacks are ignored.
 */
export function encodeTexel(format: Format, value: ArrayLike<number>, out: Uint8Array, offset: number): void {
  const f = FORMATS[format]
  const view = new DataView(out.buffer, out.byteOffset + offset, f.bytes)
  for (let c = 0; c < f.channels; c++) {
    const src = f.order === 'bgra' && c < 3 ? 2 - c : c
    let v = value[src] ?? 0
    if (f.srgb && c < 3) v = encodeSrgb(v)
    const at = c * f.channelBytes
    switch (f.kind) {
      case 'unorm':
        if (f.channelBytes === 1) view.setUint8(at, toUnorm(v, 8))
        else view.setUint16(at, toUnorm(v, 16), true)
        break
      case 'depth':
        if (f.channelBytes === 2) view.setUint16(at, toUnorm(v, 16), true)
        else view.setFloat32(at, saturate(v), true)
        break
      case 'float':
        if (f.channelBytes === 2) view.setUint16(at, toHalf(v), true)
        else view.setFloat32(at, v, true)
        break
      case 'uint':
        view.setUint32(at, v >>> 0, true)
        break
      case 'sint':
        view.setInt32(at, v | 0, true)
        break
    }
  }
}

/**
 * Reads one texel into `out` (r, g, b, a). Missing colour channels read as 0 and a missing alpha as 1, as a shader
 * sees them; a depth format fills only `out[0]`.
 */
export function decodeTexel(format: Format, bytes: Uint8Array, offset: number, out: number[]): void {
  const f = FORMATS[format]
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, f.bytes)
  out[0] = 0
  out[1] = 0
  out[2] = 0
  out[3] = 1
  for (let c = 0; c < f.channels; c++) {
    const at = c * f.channelBytes
    let v: number
    switch (f.kind) {
      case 'unorm':
        v = f.channelBytes === 1 ? fromUnorm(view.getUint8(at), 8) : fromUnorm(view.getUint16(at, true), 16)
        break
      case 'depth':
        v = f.channelBytes === 2 ? fromUnorm(view.getUint16(at, true), 16) : view.getFloat32(at, true)
        break
      case 'float':
        v = f.channelBytes === 2 ? f32(fromHalf(view.getUint16(at, true))) : view.getFloat32(at, true)
        break
      case 'uint':
        v = view.getUint32(at, true)
        break
      case 'sint':
        v = view.getInt32(at, true)
        break
    }
    if (f.srgb && c < 3) v = f32(decodeSrgb(v))
    const dst = f.order === 'bgra' && c < 3 ? 2 - c : c
    out[dst] = v
  }
}
