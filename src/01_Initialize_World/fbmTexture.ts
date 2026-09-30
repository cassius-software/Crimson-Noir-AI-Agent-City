/**
 * Why does this file exist? Evaluating many octaves of 3D noise per pixel cost ~15 ms/frame on an
 * integrated GPU. This bakes fractional Brownian motion once at startup into a tileable RGBA texture
 * (still procedural, still zero external assets) that the city materials sample instead, and derives
 * from that one bake every lower resolution the quality autoscaler steps down to.
 * The swap is hitch-free by construction (three r186, read from source): every material samples through
 * one base TextureNode, and each draw's NodeSampledTexture binding compares `textureNode.value` with its
 * texture every frame. Assigning a different, already uploaded texture makes Bindings rebuild (or reuse
 * its cached) bind group; the material cache key ignores node values and the bind group layout depends
 * only on the texture's format and dimension, so no pipeline is rebuilt. Resizing one DataTexture in
 * place would not work: WebGPUTextureUtils.updateTexture copies the new image into the GPUTexture
 * created at the old size.
 * What breaks if it is removed? materials.ts has no noise source (the city renders flat), and the
 * autoscaler cannot lower the procedural texture resolution.
 */
import {
  DataTexture, LinearMipmapLinearFilter, LinearFilter, RepeatWrapping, RGBAFormat, UnsignedByteType,
  type Node, type Texture, type TextureNode,
} from 'three/webgpu'
import { texture } from 'three/tsl'
import { createRng } from '../02_Define_The_Rules/degrees.ts'

/** Every resolution the quality tiers use (texels per edge), all resident from startup. */
export const FBM_SIZES: readonly number[] = Object.freeze([64, 128, 192, 256])

/** Tileable value-noise FBM: every octave's lattice wraps at the texture edge, so the result tiles. */
function fbmChannel(size: number, basePeriod: number, octaves: number, gain: number, seed: number, ridged: boolean): Float32Array {
  const rng = createRng(seed)
  const out = new Float32Array(size * size)
  let amplitude = 1
  let total = 0
  for (let o = 0; o < octaves; o++) {
    const period = basePeriod << o
    const lattice = new Float32Array(period * period)
    for (let i = 0; i < lattice.length; i++) lattice[i] = rng()
    const scale = period / size
    for (let y = 0; y < size; y++) {
      const fy = y * scale
      const y0 = Math.floor(fy)
      const ty = fy - y0
      const sy = ty * ty * (3 - 2 * ty)
      const r0 = (y0 % period) * period
      const r1 = ((y0 + 1) % period) * period
      for (let x = 0; x < size; x++) {
        const fx = x * scale
        const x0 = Math.floor(fx)
        const tx = fx - x0
        const sx = tx * tx * (3 - 2 * tx)
        const c0 = x0 % period
        const c1 = (x0 + 1) % period
        const top = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * sx
        const bottom = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * sx
        let v = top + (bottom - top) * sy
        if (ridged) v = 1 - Math.abs(v * 2 - 1)
        out[y * size + x] += v * amplitude
      }
    }
    total += amplitude
    amplitude *= gain
  }
  for (let i = 0; i < out.length; i++) out[i] /= total
  return out
}

/** RGBA8, size² texels. R: broad mottling · G: medium detail · B: ridged streak noise · A: fine grit.
 *  Each channel is stretched to the full byte range so the materials get real contrast. */
export function bakeFbm(size: number, seed: number): Uint8Array<ArrayBuffer> {
  const channels = [
    fbmChannel(size, 4, 6, 0.5, seed, false),
    fbmChannel(size, 8, 5, 0.55, seed + 1, false),
    fbmChannel(size, 4, 5, 0.5, seed + 2, true),
    fbmChannel(size, 32, 3, 0.6, seed + 3, false),
  ]
  const data = new Uint8Array(size * size * 4)
  for (let c = 0; c < 4; c++) {
    const ch = channels[c]
    let lo = Infinity, hi = -Infinity
    for (const v of ch) { if (v < lo) lo = v; if (v > hi) hi = v }
    const k = 255 / Math.max(hi - lo, 1e-6)
    for (let i = 0; i < ch.length; i++) data[i * 4 + c] = (ch[i] - lo) * k
  }
  return data
}

/** Source texels covering each output texel along one axis, with their area weights (rows sum to 1). */
function coverage(from: number, to: number): { first: Int32Array; weights: Float32Array[] } {
  const r = from / to
  const first = new Int32Array(to)
  const weights: Float32Array[] = []
  for (let i = 0; i < to; i++) {
    const a = i * r, b = (i + 1) * r
    const s0 = Math.floor(a), s1 = Math.min(from, Math.ceil(b))
    const w = new Float32Array(s1 - s0)
    for (let s = s0; s < s1; s++) w[s - s0] = (Math.min(b, s + 1) - Math.max(a, s)) / r
    first[i] = s0
    weights.push(w)
  }
  return { first, weights }
}

/** Area-weighted downsample of a square RGBA8 image (`to` ≤ `from`). The output texels tile the source
 *  exactly, so a tileable source stays tileable; a 2:1 step is the plain 2×2 box (the GPU's next mip).
 *  Contrast is not re-stretched, so the average tone is unchanged and a swap reads as a slight softening. */
export function downsampleRgba(src: Uint8Array, from: number, to: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(from) || !Number.isInteger(to) || to < 1 || to > from) throw new RangeError(`cannot downsample ${from}² to ${to}²`)
  if (src.length !== from * from * 4) throw new RangeError(`expected ${from * from * 4} bytes, got ${src.length}`)
  const cov = coverage(from, to)
  // Horizontal pass into floats (to × from), then vertical into bytes (to × to).
  const mid = new Float32Array(to * from * 4)
  for (let y = 0; y < from; y++) {
    for (let x = 0; x < to; x++) {
      const w = cov.weights[x], s0 = cov.first[x], o = (y * to + x) * 4
      for (let k = 0; k < w.length; k++) {
        const i = (y * from + s0 + k) * 4
        mid[o] += src[i] * w[k]; mid[o + 1] += src[i + 1] * w[k]; mid[o + 2] += src[i + 2] * w[k]; mid[o + 3] += src[i + 3] * w[k]
      }
    }
  }
  const out = new Uint8Array(to * to * 4)
  for (let y = 0; y < to; y++) {
    const w = cov.weights[y], s0 = cov.first[y]
    for (let x = 0; x < to; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let k = 0; k < w.length; k++) {
        const i = ((s0 + k) * to + x) * 4
        r += mid[i] * w[k]; g += mid[i + 1] * w[k]; b += mid[i + 2] * w[k]; a += mid[i + 3] * w[k]
      }
      const o = (y * to + x) * 4
      out[o] = Math.round(r); out[o + 1] = Math.round(g); out[o + 2] = Math.round(b); out[o + 3] = Math.round(a)
    }
  }
  return out
}

/** A repeating, mipmapped, anisotropically filtered DataTexture over RGBA8 FBM data. */
export function fbmTexture(data: Uint8Array<ArrayBuffer>, size: number): DataTexture {
  const tex = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType)
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.magFilter = LinearFilter
  tex.minFilter = LinearMipmapLinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  tex.name = `fbm${size}`
  return tex
}

/**
 * One FBM bake at the largest size plus its downsampled resolutions, sampled through a single base
 * TextureNode. `setSize` swaps what every material sees in one assignment (see the file comment).
 */
export class FbmSet {
  /** Base node; materials never sample it directly, only through `sample()` (clones that follow it). */
  readonly node: TextureNode
  /** Baked sizes, ascending. */
  readonly sizes: readonly number[]
  private readonly textures = new Map<number, DataTexture>()
  private current: number

  constructor(seed: number, sizes: readonly number[] = FBM_SIZES) {
    const sorted = [...new Set(sizes)].filter((s) => Number.isInteger(s) && s >= 1).sort((a, b) => a - b)
    if (sorted.length === 0) throw new RangeError('FbmSet needs at least one texture size')
    this.sizes = Object.freeze(sorted)
    const top = sorted[sorted.length - 1]
    const full = bakeFbm(top, seed)
    for (const s of sorted) this.textures.set(s, fbmTexture(s === top ? full : downsampleRgba(full, top, s), s))
    this.node = texture(this.textures.get(top) as DataTexture)
    this.current = top
  }

  /** Edge of the texture currently sampled, texels. */
  get size(): number { return this.current }

  /** The baked texture of exactly this size, if any. */
  textureOf(size: number): DataTexture | undefined { return this.textures.get(size) }

  /** The largest baked size not above `size`, or the smallest when every size is above it. */
  fit(size: number): number {
    let best = this.sizes[0]
    for (const s of this.sizes) if (s <= size) best = s
    return best
  }

  /** Samples the current texture at a world-space uv (no texture matrix: the materials tile in metres). */
  sample(uv: Node<'vec2'>): TextureNode {
    const n = texture(this.node, uv)
    n.updateMatrix = false
    return n
  }

  /** Uploads every size (and its mip chain) now, so a later swap never uploads mid-drive. Call once the
   *  renderer is initialised, before the first frame. */
  upload(renderer: { initTexture(t: Texture): void }): void {
    for (const s of this.sizes) renderer.initTexture(this.textures.get(s) as DataTexture)
  }

  /** Swaps to the best baked size for `size` (see fit). Returns whether the sampled texture changed. */
  setSize(size: number): boolean {
    if (Number.isNaN(size)) return false
    const s = this.fit(size)
    if (s === this.current) return false
    this.node.value = this.textures.get(s) as DataTexture
    this.current = s
    return true
  }
}
