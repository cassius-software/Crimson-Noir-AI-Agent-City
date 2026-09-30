/**
 * Why does this file exist? It is the macro city: the same street geometry as city.ts (40 m pitch, 8 m roads, 3 m
 * sidewalks, 26 m lots) laid out over a sector map of any size (256 × 256 blocks, 10.24 km, by default), generated
 * from the seed alone: a meandering river with bridges on the arterials, a lakeshore, arterials every 16 blocks, a local
 * grid thinned into superblocks without ever cutting the road network in two, pedestrian streets downtown, typed lots
 * (downtown, residential, industrial, park, plaza, civic) and building footprints per lot. It also answers the one
 * question every later stage asks of the ground: is this 2 m navigation cell walkable? And it serialises the whole map
 * to a small checksummed binary, and back.
 * What breaks if it is removed? The pre-computed navigation (06_Make_Decisions/navMesh.ts), the population
 * (03_Spawn_Agents/population.ts) and the endurance run have no ground. The live page does not use it: it still draws
 * the 16 × 16 city of city.ts.
 */
import { createRng } from '../02_Define_The_Rules/degrees.ts'
import { CITY } from './city.ts'

export const MACRO = Object.freeze({
  /** Blocks per axis of the default sector map. */
  blocks: 256,
  pitch: CITY.pitch,
  roadHalf: CITY.roadHalf,
  lotHalf: CITY.lotHalf,
  /** Street band half-width: road plus sidewalk (pitch / 2 − lotHalf). */
  bandHalf: CITY.pitch / 2 - CITY.lotHalf,
  /** A zebra crosses the road this far (from, to) along the street from the intersection centre, metres. */
  zebra: [7, 11] as const,
  /** Navigation cell edge, metres. */
  cell: 2,
  /** Arterial spacing, blocks. */
  arterialEvery: 16,
})

export const LOT = Object.freeze({ downtown: 0, residential: 1, industrial: 2, park: 3, plaza: 4, water: 5, civic: 6 })
export type LotKind = (typeof LOT)[keyof typeof LOT]
export const LOT_NAMES = ['downtown', 'residential', 'industrial', 'park', 'plaza', 'water', 'civic'] as const
export const STREET = Object.freeze({ none: 0, local: 1, arterial: 2, pedestrian: 3, bridge: 4 })

/** A footprint inside its lot, decimetres from the lot's corner (a lot is 260 dm square), and its floors. */
export interface Footprint { lot: number; x0: number; z0: number; x1: number; z1: number; floors: number }

export interface MacroCity {
  seed: number
  blocks: number
  /** Lot kind per block, index m · blocks + k (k along x, m along z). */
  lots: Uint8Array
  /** Street along x at z = m · pitch, between x = k and k + 1: index m · blocks + k, m ∈ [0, blocks]. */
  hStreets: Uint8Array
  /** Street along z at x = k · pitch, between z = m and m + 1: index k · blocks + m, k ∈ [0, blocks]. */
  vStreets: Uint8Array
  /** Footprints as [lot, x0, z0, x1, z1, floors] × n. */
  footprints: Uint32Array
}

const hash2 = (seed: number, a: number, b: number): number => {
  let h = (seed ^ Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1)) >>> 0
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise in [0, 1) at (x, z), lattice spacing `scale` blocks. */
function noise(seed: number, x: number, z: number, scale: number): number {
  const fx = x / scale, fz = z / scale
  const ix = Math.floor(fx), iz = Math.floor(fz)
  const tx = fx - ix, tz = fz - iz
  const sx = tx * tx * (3 - 2 * tx), sz = tz * tz * (3 - 2 * tz)
  const a = hash2(seed, ix, iz), b = hash2(seed, ix + 1, iz), c = hash2(seed, ix, iz + 1), d = hash2(seed, ix + 1, iz + 1)
  return a + (b - a) * sx + (c - a) * sz + (a - b - c + d) * sx * sz
}

/** The river's centre column (blocks, fractional) at row m, and its half-width in blocks. */
export function riverAt(seed: number, blocks: number, m: number): { centre: number; half: number } {
  const ph = hash2(seed, 7, 7) * Math.PI * 2
  const centre = blocks * (0.55 + 0.12 * Math.sin(m / (blocks / 7) + ph) + 0.05 * Math.sin(m / (blocks / 23) + 2 * ph))
  return { centre, half: Math.max(0.6, blocks / 170) }
}

/** Rows (from the south edge, blocks) the lake covers. */
export const lakeRows = (blocks: number): number => Math.max(1, Math.round(blocks / 24))

function lotKindAt(seed: number, blocks: number, k: number, m: number): LotKind {
  if (m >= blocks - lakeRows(blocks)) return LOT.water
  const r = riverAt(seed, blocks, m + 0.5)
  if (Math.abs(k + 0.5 - r.centre) < r.half) return LOT.water
  // Downtown: a few centres, one near the river.
  const cores = [[0.5, 0.5], [0.25 + 0.1 * hash2(seed, 1, 2), 0.3], [0.72, 0.2 + 0.2 * hash2(seed, 3, 4)], [0.3, 0.75]]
  let core = Infinity
  for (const [cx, cz] of cores) core = Math.min(core, Math.hypot(k / blocks - cx, m / blocks - cz))
  const n = noise(seed + 11, k, m, 9)
  if (noise(seed + 5, k, m, 6) > 0.8 || (k % 32 === 5 && m % 32 === 9)) return LOT.park
  if (core < 0.06 + 0.03 * n) return hash2(seed, k, m) < 0.05 ? LOT.plaza : hash2(seed + 1, k, m) < 0.03 ? LOT.civic : LOT.downtown
  const riverSide = Math.abs(k + 0.5 - r.centre) < r.half + 3
  const lakeSide = m >= blocks - lakeRows(blocks) - 3
  if ((riverSide || lakeSide) && n > 0.45) return LOT.industrial
  if (n > 0.78) return LOT.industrial
  if (hash2(seed + 2, k, m) < 0.01) return LOT.civic
  return LOT.residential
}

class UnionFind {
  private readonly p: Int32Array
  constructor(n: number) { this.p = new Int32Array(n).map((_, i) => i) }
  find(a: number): number {
    while (this.p[a] !== a) { this.p[a] = this.p[this.p[a]]; a = this.p[a] }
    return a
  }
  union(a: number, b: number): boolean {
    const x = this.find(a), y = this.find(b)
    if (x === y) return false
    this.p[x] = y
    return true
  }
}

/** Generates the macro city for `seed`, `blocks` × `blocks` (default 256). Deterministic. */
export function generateMacroCity(seed: number, blocks: number = MACRO.blocks): MacroCity {
  if (!Number.isInteger(blocks) || blocks < 8 || blocks > 1024) throw new RangeError('blocks must be an integer in 8…1024')
  const B = blocks
  const lots = new Uint8Array(B * B)
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) lots[m * B + k] = lotKindAt(seed, B, k, m)
  const lot = (k: number, m: number): number => (k < 0 || m < 0 || k >= B || m >= B ? LOT.water : lots[m * B + k])
  const water = (k: number, m: number) => lot(k, m) === LOT.water
  const every = Math.min(MACRO.arterialEvery, Math.max(4, B >> 2))

  const hStreets = new Uint8Array((B + 1) * B)
  const vStreets = new Uint8Array((B + 1) * B)
  // Segments, with the two lots each one runs between; intersections are (i, j), i, j ∈ [0, B].
  interface Seg { h: boolean; line: number; along: number; arterial: boolean; wet: boolean; dry: boolean }
  const segs: Seg[] = []
  for (let m = 0; m <= B; m++) for (let k = 0; k < B; k++) {
    const a = water(k, m - 1), b = water(k, m)
    segs.push({ h: true, line: m, along: k, arterial: m % every === 0, wet: a && b, dry: !a && !b })
  }
  for (let k = 0; k <= B; k++) for (let m = 0; m < B; m++) {
    const a = water(k - 1, m), b = water(k, m)
    segs.push({ h: false, line: k, along: m, arterial: k % every === 0, wet: a && b, dry: !a && !b })
  }
  const node = (i: number, j: number) => j * (B + 1) + i
  const ends = (s: Seg): [number, number] => (s.h ? [node(s.along, s.line), node(s.along + 1, s.line)] : [node(s.line, s.along), node(s.line, s.along + 1)])
  const set = (s: Seg, v: number) => { if (s.h) hStreets[s.line * B + s.along] = v; else vStreets[s.line * B + s.along] = v }
  const uf = new UnionFind((B + 1) * (B + 1))
  // Arterials first (bridges where they cross water), then the local grid in a seeded order: a local segment is kept
  // when it joins two parts of the car network (so the network stays whole), otherwise it may become a pedestrian
  // street (downtown) or be dropped (a superblock). Streets over open water are never built except as bridges.
  for (const s of segs) {
    if (!s.arterial) continue
    if (s.wet) { set(s, STREET.bridge); uf.union(...ends(s)); continue }
    set(s, STREET.arterial)
    uf.union(...ends(s))
  }
  const rng = createRng(seed ^ 0x51ed)
  const locals = segs.filter((s) => !s.arterial && !s.wet)
  for (let i = locals.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[locals[i], locals[j]] = [locals[j], locals[i]]
  }
  for (const s of locals) {
    const [a, b] = ends(s)
    const k = s.h ? s.along : s.line, m = s.h ? s.line : s.along
    const downtown = lot(k, m) === LOT.downtown || lot(s.h ? k : k - 1, s.h ? m - 1 : m) === LOT.downtown
    if (uf.union(a, b)) { set(s, STREET.local); continue }
    const r = rng()
    if (downtown && r < 0.18) set(s, STREET.pedestrian)
    else if (r < 0.9 || !s.dry) set(s, STREET.local)
    // else: dropped; the two lots form a superblock.
  }

  const fp: number[] = []
  const push = (li: number, x0: number, z0: number, x1: number, z1: number, floors: number) => fp.push(li, x0, z0, x1, z1, floors)
  for (let m = 0; m < B; m++) for (let k = 0; k < B; k++) {
    const kind = lots[m * B + k], li = m * B + k, r = createRng(seed ^ Math.imul(li + 1, 0x9e3779b1))
    if (kind === LOT.downtown) {
      if (r() < 0.45) push(li, 10, 10, 250, 250, 12 + Math.floor(r() * 40))
      else { push(li, 0, 0, 125, 260, 6 + Math.floor(r() * 20)); push(li, 135, 0, 260, 260, 6 + Math.floor(r() * 20)) }
    } else if (kind === LOT.residential) {
      const cols = 2 + Math.floor(r() * 3), rows = 2
      const w = Math.floor(260 / cols)
      for (let c = 0; c < cols; c++) for (let q = 0; q < rows; q++) push(li, c * w + 8, q * 130 + 20, (c + 1) * w - 8, q * 130 + 110, 2 + Math.floor(r() * 3))
    } else if (kind === LOT.industrial) {
      push(li, 20, 20, 240, 200 + Math.floor(r() * 40), 1 + Math.floor(r() * 2))
    } else if (kind === LOT.civic) {
      push(li, 40, 40, 220, 220, 3 + Math.floor(r() * 4))
    } else if (kind === LOT.park && r() < 0.2) {
      push(li, 110, 110, 150, 150, 1)
    }
  }
  return { seed, blocks: B, lots, hStreets, vStreets, footprints: Uint32Array.from(fp) }
}

/** The street segment kind on the vertical line k between rows m and m + 1 (none outside the map). */
const vAt = (c: MacroCity, k: number, m: number) => (k < 0 || k > c.blocks || m < 0 || m >= c.blocks ? STREET.none : c.vStreets[k * c.blocks + m])
const hAt = (c: MacroCity, k: number, m: number) => (m < 0 || m > c.blocks || k < 0 || k >= c.blocks ? STREET.none : c.hStreets[m * c.blocks + k])
const lotAt = (c: MacroCity, k: number, m: number) => (k < 0 || m < 0 || k >= c.blocks || m >= c.blocks ? LOT.water : c.lots[m * c.blocks + k])

/** Navigation cells per axis. */
export const navCells = (c: MacroCity): number => (c.blocks * MACRO.pitch) / MACRO.cell

/**
 * Whether the 2 m navigation cell (cx, cz) is walkable: sidewalks along every built street, zebras across the road
 * near each intersection, whole pedestrian streets, sidewalk corners, and the interiors of parks and plazas. Roads,
 * lots with buildings, and water are not (a bridge's sidewalks and zebras are).
 */
export function walkable(c: MacroCity, cx: number, cz: number): boolean {
  const n = navCells(c)
  if (cx < 0 || cz < 0 || cx >= n || cz >= n) return false
  const P = MACRO.pitch, band = MACRO.bandHalf, road = MACRO.roadHalf
  const x = (cx + 0.5) * MACRO.cell, z = (cz + 0.5) * MACRO.cell
  const sx = Math.round(x / P), sz = Math.round(z / P)
  const dx = Math.abs(x - sx * P), dz = Math.abs(z - sz * P)
  const k = Math.floor(x / P), m = Math.floor(z / P)
  const inV = dx < band, inH = dz < band
  const open = (kind: number) => kind === LOT.park || kind === LOT.plaza
  if (inV && inH) {
    const around = [vAt(c, sx, sz - 1), vAt(c, sx, sz), hAt(c, sx - 1, sz), hAt(c, sx, sz)].filter((s) => s !== STREET.none)
    if (around.length === 0) return open(lotAt(c, k, m))
    if (dx >= road && dz >= road) return true
    return around.every((s) => s === STREET.pedestrian)
  }
  if (inV || inH) {
    const seg = inV ? vAt(c, sx, m) : hAt(c, k, sz)
    if (seg === STREET.none) return open(lotAt(c, k, m))
    if (seg === STREET.pedestrian) return true
    const across = inV ? dx : dz
    if (across >= road) return true
    const along = inV ? Math.abs(z - Math.round(z / P) * P) : Math.abs(x - Math.round(x / P) * P)
    return along >= MACRO.zebra[0] && along < MACRO.zebra[1]
  }
  return open(lotAt(c, k, m))
}

/** The cell's lot kind (the lot it lies in, or water outside the map). */
export function lotOfCell(c: MacroCity, cx: number, cz: number): LotKind {
  const P = MACRO.pitch
  return lotAt(c, Math.floor(((cx + 0.5) * MACRO.cell) / P), Math.floor(((cz + 0.5) * MACRO.cell) / P)) as LotKind
}

// ─── Binary form ────────────────────────────────────────────────────────────────────────────────────────────────────
// "ACMAP\0\1\0" | u32 seed | u32 blocks | u32 footprint count | u32 FNV-1a of the payload | lots | hStreets | vStreets |
// footprints (u32 × 6 each), little-endian.

const MAGIC = [0x41, 0x43, 0x4d, 0x41, 0x50, 0x00, 0x01, 0x00]
const HEADER = 8 + 16

export function fnv1a(bytes: Uint8Array, h = 0x811c9dc5): number {
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i], 0x01000193)
  return h >>> 0
}

export function serializeMacroCity(c: MacroCity): Uint8Array {
  const n = c.footprints.length / 6
  const payload = c.lots.length + c.hStreets.length + c.vStreets.length + c.footprints.byteLength
  const out = new Uint8Array(HEADER + payload)
  out.set(MAGIC, 0)
  let o = HEADER
  for (const part of [c.lots, c.hStreets, c.vStreets, new Uint8Array(c.footprints.buffer, c.footprints.byteOffset, c.footprints.byteLength)]) {
    out.set(part, o)
    o += part.length
  }
  const v = new DataView(out.buffer)
  v.setUint32(8, c.seed >>> 0, true)
  v.setUint32(12, c.blocks, true)
  v.setUint32(16, n, true)
  v.setUint32(20, fnv1a(out.subarray(HEADER)), true)
  return out
}

export function deserializeMacroCity(bytes: Uint8Array): MacroCity {
  if (bytes.length < HEADER || MAGIC.some((b, i) => bytes[i] !== b)) throw new Error('not an ACMAP v1 file')
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const seed = v.getUint32(8, true), blocks = v.getUint32(12, true), n = v.getUint32(16, true)
  const B = blocks
  if (bytes.length !== HEADER + B * B + 2 * (B + 1) * B + n * 24) throw new Error('ACMAP length does not match its header')
  if (fnv1a(bytes.subarray(HEADER)) !== v.getUint32(20, true)) throw new Error('ACMAP checksum mismatch')
  let o = bytes.byteOffset + HEADER
  const take = (len: number) => { const s = new Uint8Array(bytes.buffer.slice(o, o + len)); o += len; return s }
  const lots = take(B * B), hStreets = take((B + 1) * B), vStreets = take((B + 1) * B)
  const footprints = new Uint32Array(take(n * 24).buffer)
  return { seed, blocks, lots, hStreets, vStreets, footprints }
}
