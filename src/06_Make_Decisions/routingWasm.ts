/**
 * Why does this file exist? It is the routing core's host: it instantiates the WebAssembly module native/routing
 * compiles to (routing.wasm.ts, generated), lays car tracks of a TrackNetwork into the module's arena in the flat
 * f64 layout both sides define (LAYOUT here, layout.rs there, checked against each other at load), and exposes
 * poseAt, projectOnto, nextStop and speedLimitAt with the signatures tracks.ts has, as the RoutingCore tracks.ts
 * delegates to once useRoutingCore() installs it. The module loads synchronously (new WebAssembly.Module, valid in
 * a worker and in Node, where the physics realm and the tests live), allocates nothing after the arena the host
 * sizes here, and refuses a track that has a piece it cannot evaluate (an arc) or does not fit: that track stays
 * with the TypeScript reference. WebAssembly here is a compilation target for the fleet's hottest arithmetic, not
 * a hiding place: tracks.ts keeps the same functions in the open, and routingWasm.test.ts proves the two equal.
 * What breaks if it is removed? Nothing in the product's behaviour: tracks.ts answers every call itself. The
 * physics worker has no core to install.
 */
import { TRAFFIC, type Axis } from '../02_Define_The_Rules/civic.ts'
import { ROUTING_WASM_BASE64, ROUTING_WASM_BYTES } from './routing.wasm.ts'
import type { RoutingCore, Track, TrackPose } from './tracks.ts'

/**
 * The flat f64 layout of a track in the arena (native/routing/src/layout.rs, word for word). A track is T_HEADER
 * words, then PIECE_WORDS per piece, then STOP_WORDS per stop; kind 0 is a line, 1 a corner; axis 0 'ew', 1 'ns'.
 */
export const LAYOUT = Object.freeze({
  T_LENGTH: 0, T_Y: 1, T_SPEED_LIMIT: 2, T_CORNER_SPEED: 3, T_DECEL: 4, T_PIECES: 5, T_STOPS: 6, T_HEADER: 7,
  PIECE_WORDS: 42, P_KIND: 0, P_S0: 1, P_LENGTH: 2,
  P_X0: 3, P_Z0: 4, P_DX: 5, P_DZ: 6,
  P_EX: 3, P_EZ: 4, P_CX: 5, P_CZ: 6, P_XX: 7, P_XZ: 8, P_LUT: 9, LUT_SIZE: 33,
  STOP_WORDS: 2, S_S: 0, S_AXIS: 1,
})
/** routing_layout's table in the crate's order (layout.rs TABLE): the load-time check that both sides agree. */
const TABLE = [LAYOUT.T_HEADER, LAYOUT.PIECE_WORDS, LAYOUT.STOP_WORDS, LAYOUT.LUT_SIZE, LAYOUT.P_LUT, LAYOUT.P_X0, LAYOUT.P_EX, LAYOUT.T_PIECES, LAYOUT.T_STOPS, LAYOUT.T_DECEL, LAYOUT.S_AXIS, LAYOUT.P_S0]
const KIND_LINE = 0, KIND_CORNER = 1
const AXIS_EW = 0, AXIS_NS = 1
/** Words of the output block every call writes to. */
const OUT_WORDS = 8
const PAGE = 65536
/** Arena words unless the host says otherwise: 128 K words (1 MiB), room for every ring of the city with margin. */
export const DEFAULT_ARENA_WORDS = 131072

/** The module's C ABI (native/routing/src/lib.rs). Offsets and addresses are word and byte offsets in its memory. */
export interface RoutingExports {
  readonly memory: WebAssembly.Memory
  routing_arena(base: number, words: number): number
  routing_check(at: number): number
  routing_out(): number
  routing_pose_at(at: number, s: number): number
  routing_project_onto(at: number, x: number, z: number, hint: number): number
  routing_next_stop(at: number, s: number, behind: number): number
  routing_speed_limit_at(at: number, s: number): number
  routing_layout(index: number): number
}

export interface RoutingWasm extends RoutingCore {
  /** Lays a track into the arena: true (also when already laid), or false when a piece is not a line or a corner, or it does not fit. */
  lay(track: Track): boolean
  readonly arenaWords: number
  /** Arena words written so far. */
  readonly usedWords: number
  /** Tracks laid. */
  readonly laidCount: number
  /** The instance's exports, for a test to poke. */
  readonly exports: RoutingExports
}

/** The bytes of a base64 string (atob is a global in workers and in Node). */
export function decodeBase64(base64: string): Uint8Array<ArrayBuffer> {
  const text = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(text.length))
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i)
  return bytes
}

/** The routing module's bytes, checked against the length the generator recorded. */
export function routingWasmBytes(): Uint8Array<ArrayBuffer> {
  const bytes = decodeBase64(ROUTING_WASM_BASE64)
  if (bytes.length !== ROUTING_WASM_BYTES) throw new Error(`routing.wasm.ts: ${bytes.length} bytes decoded, ${ROUTING_WASM_BYTES} recorded`)
  return bytes
}

/** Words a track takes in the arena. */
export function trackWords(track: Track): number {
  return LAYOUT.T_HEADER + LAYOUT.PIECE_WORDS * track.pieces.length + LAYOUT.STOP_WORDS * track.stops.length
}

/**
 * Instantiates the core with an arena of `arenaWords` f64 words (grown onto the module's memory) and returns it;
 * every track is laid on first sight (laid / lay). Throws if the module, its layout or the arena is not as expected.
 */
export function createRoutingCore({ arenaWords = DEFAULT_ARENA_WORDS }: { arenaWords?: number } = {}): RoutingWasm {
  if (!Number.isInteger(arenaWords) || arenaWords <= 0) throw new RangeError(`the routing arena needs a positive whole number of words, not ${arenaWords}`)
  const instance = new WebAssembly.Instance(new WebAssembly.Module(routingWasmBytes()), {})
  const e = instance.exports as unknown as RoutingExports
  for (let i = 0; i < TABLE.length; i++) {
    if (e.routing_layout(i) !== TABLE[i]) throw new Error(`routing core: layout entry ${i} is ${e.routing_layout(i)} in the module and ${TABLE[i]} here`)
  }
  let before: number
  try {
    before = e.memory.grow(Math.ceil((arenaWords * 8) / PAGE))
  } catch (err) {
    throw new Error(`routing core: the memory refused ${arenaWords} words of arena (${err instanceof Error ? err.message : String(err)})`)
  }
  const base = before * PAGE
  if (e.routing_arena(base, arenaWords) !== 1) throw new Error('routing core: the module refused the arena')
  // Views after the grow: a grow detaches every earlier view of the memory. The module allocates nothing after this,
  // but the memory is exported, so the views are taken again whenever its buffer is another one (one compare a call).
  let buffer = e.memory.buffer
  let arena = new Float64Array(buffer, base, arenaWords)
  let out = new Float64Array(buffer, e.routing_out(), OUT_WORDS)
  const views = (): void => {
    if (e.memory.buffer === buffer) return
    buffer = e.memory.buffer
    arena = new Float64Array(buffer, base, arenaWords)
    out = new Float64Array(buffer, e.routing_out(), OUT_WORDS)
  }
  /** Word offset of each track laid, or -1 for one refused. */
  const offsets = new WeakMap<Track, number>()
  let used = 0
  let count = 0

  const layInto = (track: Track): number => {
    views()
    for (const p of track.pieces) if (p.kind !== 'line' && p.kind !== 'corner') return -1
    const words = trackWords(track)
    if (used + words > arenaWords) return -1
    const at = used
    const L = LAYOUT
    arena[at + L.T_LENGTH] = track.length
    arena[at + L.T_Y] = track.y
    arena[at + L.T_SPEED_LIMIT] = track.speedLimit
    arena[at + L.T_CORNER_SPEED] = track.cornerSpeed
    arena[at + L.T_DECEL] = TRAFFIC.comfortableDecel
    arena[at + L.T_PIECES] = track.pieces.length
    arena[at + L.T_STOPS] = track.stops.length
    let w = at + L.T_HEADER
    for (const p of track.pieces) {
      arena.fill(0, w, w + L.PIECE_WORDS)
      arena[w + L.P_S0] = p.s0
      arena[w + L.P_LENGTH] = p.length
      if (p.kind === 'line') {
        arena[w + L.P_KIND] = KIND_LINE
        arena[w + L.P_X0] = p.x0
        arena[w + L.P_Z0] = p.z0
        arena[w + L.P_DX] = p.dx
        arena[w + L.P_DZ] = p.dz
      } else if (p.kind === 'corner') {
        arena[w + L.P_KIND] = KIND_CORNER
        arena[w + L.P_EX] = p.e[0]
        arena[w + L.P_EZ] = p.e[1]
        arena[w + L.P_CX] = p.c[0]
        arena[w + L.P_CZ] = p.c[1]
        arena[w + L.P_XX] = p.x[0]
        arena[w + L.P_XZ] = p.x[1]
        if (p.lut.length !== L.LUT_SIZE) return -1
        for (let k = 0; k < L.LUT_SIZE; k++) arena[w + L.P_LUT + k] = p.lut[k]
      }
      w += L.PIECE_WORDS
    }
    for (const st of track.stops) {
      arena[w + L.S_S] = st.s
      arena[w + L.S_AXIS] = st.axis === 'ew' ? AXIS_EW : AXIS_NS
      w += L.STOP_WORDS
    }
    if (e.routing_check(at) !== 1) return -1
    used += words
    count++
    return at
  }
  const place = (track: Track): number => {
    let at = offsets.get(track)
    if (at === undefined) {
      at = layInto(track)
      offsets.set(track, at)
    }
    return at
  }
  const need = (track: Track): number => {
    const at = place(track)
    if (at < 0) throw new Error(`routing core: track ${track.id} is not laid in the arena`)
    return at
  }

  const core: RoutingWasm = {
    exports: e,
    arenaWords,
    get usedWords() {
      return used
    },
    get laidCount() {
      return count
    },
    lay: (track) => place(track) >= 0,
    laid: (track) => place(track) >= 0,
    poseAt(track: Track, s: number): TrackPose {
      views()
      if (e.routing_pose_at(need(track), s) !== 1) throw new Error(`routing core: no pose for track ${track.id}`)
      return { x: out[0], y: out[1], z: out[2], heading: out[3], tangentX: out[4], tangentZ: out[5] }
    },
    projectOnto(track: Track, x: number, z: number, sHint: number): { s: number; lateral: number } {
      views()
      if (e.routing_project_onto(need(track), x, z, sHint) !== 1) throw new Error(`routing core: no projection on track ${track.id}`)
      return { s: out[0], lateral: out[1] }
    },
    nextStop(track: Track, s: number, behind: number): { s: number; axis: Axis; distance: number } | null {
      views()
      const r = e.routing_next_stop(need(track), s, behind)
      if (r === 2) return null
      if (r !== 1) throw new Error(`routing core: no stop line on track ${track.id}`)
      return { s: out[0], axis: out[1] === AXIS_EW ? 'ew' : 'ns', distance: out[2] }
    },
    speedLimitAt(track: Track, s: number): number {
      views()
      const v = e.routing_speed_limit_at(need(track), s)
      if (Number.isNaN(v)) throw new Error(`routing core: no speed limit on track ${track.id}`)
      return v
    },
  }
  return Object.freeze(core)
}
