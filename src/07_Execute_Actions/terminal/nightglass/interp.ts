// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs Lens shaders for the reference renderer. compile() checks a module and translates
 * it once into a tree of closures over a register file (no code is generated, only closures), and the Program it
 * returns runs batches of up to four invocations together by the pinned semantics of docs/nightglass.md. Every
 * vertex, pixel and compute invocation the reference renderer runs is run here, and the GPU back end's pictures are
 * compared against what it computes, so it computes each value exactly as the specification says, not closely.
 * What breaks if it is removed? The reference renderer could shade nothing and dispatch nothing, the tests could draw
 * no picture, and the GPU back end would have no reference to be checked against.
 *
 * BATCHES. A batch is one to four invocations run in lock step, instruction by instruction, under a mask of the lanes
 * still running (bit i is lane i). A fragment batch is always a 2 x 2 quad: lane i is pixel (x + (i & 1), y + (i >> 1)),
 * and a lane that covers no sample runs as a helper. Vertex and compute lanes are independent of one another. The
 * caller packs each lane's inputs and builtins and reads back each lane's outputs: see Batch and RunResult.
 *
 * REGISTERS. Each value and variable has LANES registers per component, component by component: component c of lane
 * l of id i sits at off[i] + c * LANES + l. An instruction that only computes a value computes it for all four lanes;
 * a lane that is not running then holds a value nobody reads, because a value is used only after its definition and
 * within its block, where the running lanes are always some of those that defined it. Instructions with an effect
 * (out, position, write, put, var, set) and those that read a resource (read, sample, texel, extent) touch only the
 * running lanes. Literals are written into their registers once, when the module is compiled.
 *
 * CONTROL. Each instruction is a closure from the mask of running lanes to the mask that goes on to the next
 * instruction of its block. `if` runs `then` for the lanes whose condition holds and `else` for the rest, skipping a
 * branch no lane takes. `break`, `continue` and `return` take their lanes out of the block. A loop gathers the lanes
 * that broke, which leave together when the loop ends, and the lanes that continued, which begin the next iteration
 * beside those that reached the end of the body. One entry into a loop runs at most LOOP_ITERATIONS iterations; then
 * every lane still in it leaves as if by break. `return` ends a lane's run, and the outputs it wrote stand. `discard`
 * makes a lane a helper: it runs on, so its neighbours' rates of change stay right, but from then on its out, write
 * and put do nothing, and the caller is told (RunResult.discarded). A `var` sets its variable each time it runs, so a
 * variable declared in a loop body starts afresh every iteration.
 *
 * DERIVATIVES. deriv and an implicit-level sample take fine differences across the quad: along x within the row (lane
 * 1 minus lane 0 for lanes 0 and 1, lane 3 minus lane 2 for lanes 2 and 3) and along y within the column (lane 2 minus
 * lane 0 for lanes 0 and 2, lane 3 minus lane 1 for lanes 1 and 3), each rounded to f32; width is |dx| + |dy|. An
 * implicit-level sample hands texture.ts's lodFromRates those differences of u and v and the size of the view's first
 * level. The verifier keeps both at the top level of the body before any return, where all four lanes are running.
 *
 * NUMBERS (pinned by interp.test.ts). f32 values round to binary32 (Math.fround) after every operation; i32 values wrap
 * (| 0, Math.imul) and so do u32 values (>>> 0); bools are 0 and 1. The library functions sqrt, rsqrt, exp, exp2, log,
 * log2, sin, cos, tan, asin, acos, atan, pow and atan2, and length and normalize, are computed in double precision and
 * rounded once. Everything else is built from f32 operations that each round, left to right: dot and the grid
 * products (sums of products), cross, reflect as e1 - (2 dot(e2, e1)) e2, distance as the length of the rounded
 * difference, mix as a (1 - t) + b t, smoothstep as t t (3 - 2 t) where t = clamp((x - lo) / (hi - lo), 0, 1), float
 * rem as a - b trunc(a / b), and fract as x - floor(x), which rounds up to 1 just below a whole number. fma is the
 * exact a b + c rounded once (fusedF32). min and max follow WGSL: min(a, b) is b when b < a and a otherwise, max likewise, so a NaN
 * operand gives way to the other; clamp is min(max(x, lo), hi) and saturate is clamp(x, 0, 1). step(edge, x) is 1
 * when edge <= x, else 0. sign is 1, -1 or 0, and 0 for NaN. round takes halves to even. An integer divided by zero
 * gives the dividend and remainder 0, and the most negative i32 divided by -1 gives itself, remainder 0. Shift counts
 * are taken modulo 32. A cast from f32 truncates toward zero and saturates (to [-2^31, 2^31 - 1] for i32 and to
 * [0, 2^32 - 1] for u32), NaN giving 0; i32 and u32 keep their bits; a number is true when it is not zero (NaN too).
 * bits reinterprets the IEEE bits (a NaN's payload is not promised). A lane index is clamped into the vector.
 *
 * RESOURCES. bind() resolves every resource a module declares through the caller's Resources, once (per draw or per
 * dispatch, say), checks each and keeps it; runs then read through it. A block (uniform, storage or constants) is a
 * byte range: values are read and written little-endian at the offsets of lens.ts's layoutBlock, grids by padded
 * columns. A value-held index into a fixed array is clamped into it. An index into a storage block's final array,
 * constant or value-held, is clamped into the elements the binding holds, floor((size - start) / stride); with none,
 * a read gives zero and a write does nothing. A value that would reach past the binding's bytes also reads as zero
 * and is not written. Images go through texture.ts: sample through the view and the sampler, texel as its load (zero
 * outside the view), put as its put (nothing outside; a storage image is written at the first level and the first
 * layer of its view), and extent gives the size of the view's first level, or of the level given counted from there
 * and clamped into the view.
 *
 * BUDGET. A run counts steps: one for each lane it starts, one for each instruction each running lane executes, and
 * one for each loop iteration each lane begins. A run that would pass the budget it is given stops with a Fault of
 * code `bound`, and effects made before it stand. dispatch() shares one budget across a whole dispatch, as the
 * reference renderer shares one across a draw.
 */
import type { Filter, Range, Wrap } from './api.ts'
import { fail, isFault } from './fault.ts'
import { sampleKind } from './formats.ts'
import { BUILTINS, columnOf, componentsOf, isGrid, isScalar, layoutBlock, scalarOf, strideOf, widthOf } from './lens.ts'
import type {
  BinaryFn, Builtin, DataType, DerivativeFn, Inst, LensModule, Port, Resource, Scalar, Space, Stage, Step, TernaryFn, UnaryFn,
  ValueType,
} from './lens.ts'
import { ImageStore, load, lodFromRates, put, sample } from './texture.ts'
import type { SamplerState, ViewRange } from './texture.ts'
import { say, verify } from './verify.ts'

/** Invocations a batch runs together: the four pixels of a 2 x 2 quad, or up to four vertices or compute invocations. */
export const LANES = 4
/** Iterations of one entry into a loop, after which every lane still in it leaves as if by break. */
export const LOOP_ITERATIONS = 65_536
/**
 * The step budget dispatch() uses when it is given none: about a billion lane-instructions, far beyond any shader
 * the tests run, yet small enough that a shader caught in nested loops is stopped in seconds, not hours.
 */
export const DEFAULT_BUDGET = 2 ** 30
/** The most workgroups along one axis of a dispatch: the limit every Nightglass device reports. */
const MAX_GROUPS = 65_535

// ---------------------------------------------------------------------------------------------------
// What the caller hands a program, and what a run hands back

/** A uniform, storage or constants resource as bound: a byte range of some bytes. */
export interface BlockBinding {
  /** The bytes the binding lies in: a slice of bound memory, or the inline constants. */
  readonly bytes: Uint8Array
  /** Where the binding starts in `bytes`, and how many bytes it covers. */
  readonly offset: number
  readonly size: number
}

/** A sampled image or a storage image as bound: its store, and the levels and layers its view shows. */
export interface ImageBinding {
  readonly store: ImageStore
  readonly view: ViewRange
}

/**
 * How a program finds the resources its module declares, by their index in `module.resources`. The reference
 * renderer implements it over the sets bound at a draw or a dispatch. A method returns null when nothing is bound,
 * which bind() refuses.
 */
export interface Resources {
  /** A uniform, storage or constants resource: its bytes. A shader's storage writes go into them. */
  block(res: number): BlockBinding | null
  /** A sampled image. */
  image(res: number): ImageBinding | null
  sampler(res: number): SamplerState | null
  /** A storage image, written at its view's first level and first layer. */
  storageImage(res: number): ImageBinding | null
}

/** A program's resources resolved by its bind(), ready for any number of runs. */
export interface Bindings {
  readonly program: Program
}

/** Where one port's numbers sit among a lane's numbers: ports in slot order, packed one after another. */
export interface PortLayout {
  readonly slot: number
  readonly type: ValueType
  readonly flat: boolean
  /** The position of the port's first component among the lane's numbers. */
  readonly offset: number
  /** Its components (1 to 4). */
  readonly size: number
}

/** The invocations of one run. */
export interface Batch {
  /** Lanes to run: 1 to LANES; a fragment batch is a whole quad of LANES. */
  readonly lanes: number
  /** Fragment only: a mask of the lanes that start as helpers (they cover no sample). Default none. */
  readonly helpers?: number
  /**
   * The input ports, lane by lane: component c of the port laid out at `p` (program.inputs) of lane l is
   * `inputs[l * program.inputWidth + p.offset + c]`. A fragment program takes the rasteriser's interpolated values as
   * they are; they round to f32 (integers to their kind) as they are read.
   */
  readonly inputs?: ArrayLike<number>
  /** Each builtin the program reads (program.builtins), lane by lane: component c of lane l at `[l * n + c]`. */
  readonly builtins?: { readonly [K in Builtin]?: ArrayLike<number> }
}

/**
 * What a run leaves. The object and its arrays belong to the program and are overwritten by its next run, so a
 * caller copies what it keeps.
 */
export interface RunResult {
  /** The output ports lane by lane, laid out as program.outputs says; zero where a lane never wrote one. */
  readonly outputs: Float64Array
  /** Vertex stage: each lane's clip position (x, y, z, w) at `[l * 4 + c]`; zero where never written. */
  readonly position: Float64Array
  /** The lanes that wrote a position. A vertex that never wrote one draws nothing. */
  readonly positioned: number
  /** The lanes that ran discard: the caller drops their outputs. */
  readonly discarded: number
  /** The lanes that ended as helpers (started as one or discarded): none of their effects took place. */
  readonly helpers: number
  /** The steps the run took (see the head of the file). */
  readonly steps: number
}

/** A compiled shader. Made by compile(); runs one batch at a time and is not shared between runs in flight. */
export interface Program {
  readonly module: LensModule
  readonly stage: Stage
  readonly group: readonly [number, number, number]
  /** The input ports in slot order, and the numbers each lane's inputs take in all. */
  readonly inputs: readonly PortLayout[]
  readonly inputWidth: number
  /** The output ports in slot order, and the numbers each lane's outputs take in all. */
  readonly outputs: readonly PortLayout[]
  readonly outputWidth: number
  /** The builtins the module reads, which every batch must give. */
  readonly builtins: readonly Builtin[]
  /** Resolves and checks every resource the module declares; runs then read through the result. */
  bind(resources: Resources): Bindings
  /** Runs one batch. Refuses a batch or bindings that do not fit, and stops with a `bound` Fault past the budget. */
  run(batch: Batch, bindings: Bindings, budget: number): RunResult
}

// ---------------------------------------------------------------------------------------------------
// The arithmetic of one component

type Fn1 = (x: number) => number
type Fn2 = (x: number, y: number) => number
type Fn3 = (x: number, y: number, z: number) => number

const f32 = Math.fround
const I32_MIN = -0x80000000
const I32_MAX = 0x7fffffff
const U32_MAX = 0xffffffff

/** WGSL's min and max: b when it is below (above) a, else a, so a NaN gives way to the other operand. */
const minOf: Fn2 = (a, b) => (Number.isNaN(a) || b < a ? b : a)
const maxOf: Fn2 = (a, b) => (Number.isNaN(a) || b > a ? b : a)
const clampOf: Fn3 = (x, lo, hi) => minOf(maxOf(x, lo), hi)

/** Rounds half to even. Math.round takes halves up, which is right except at a half above an even whole number. */
function roundEven(x: number): number {
  const f = Math.floor(x)
  return x - f === 0.5 && f % 2 === 0 ? f : Math.round(x)
}

/**
 * Integer division truncates. A zero divisor gives the dividend (remainder 0); the most negative i32 over -1 is 2^31,
 * which wraps back to itself, and its remainder -0 becomes 0. A double holds every quotient of two 32-bit integers
 * far enough from the next whole number that truncating it is exact.
 */
const divI: Fn2 = (a, b) => (b === 0 ? a : Math.trunc(a / b) | 0)
const remI: Fn2 = (a, b) => (b === 0 ? 0 : (a % b) | 0)
const divU: Fn2 = (a, b) => (b === 0 ? a : Math.trunc(a / b))
const remU: Fn2 = (a, b) => (b === 0 ? 0 : a % b)
const remF: Fn2 = (a, b) => f32(a - f32(b * Math.trunc(f32(a / b))))

const toI32: Fn1 = (x) => (Number.isNaN(x) ? 0 : x >= I32_MAX ? I32_MAX : x <= I32_MIN ? I32_MIN : Math.trunc(x) | 0)
const toU32: Fn1 = (x) => (Number.isNaN(x) ? 0 : x >= U32_MAX ? U32_MAX : x <= 0 ? 0 : Math.trunc(x))

/** A number of any source as a component of a scalar kind, so every register holds a value of its own type. */
function coerceOf(k: Scalar): Fn1 {
  return k === 'f32' ? f32 : k === 'i32' ? (x) => x | 0 : k === 'u32' ? (x) => x >>> 0 : (x) => (x !== 0 ? 1 : 0)
}

type Reduction = 'length' | 'normalize' | 'any' | 'all' | 'transpose'

function unaryOf(fn: Exclude<UnaryFn, Reduction>, k: Scalar): Fn1 {
  switch (fn) {
    case 'neg': return k === 'f32' ? (x) => -x : (x) => -x | 0
    case 'not': return (x) => 1 - x
    case 'bitnot': return k === 'i32' ? (x) => ~x : (x) => ~x >>> 0
    case 'abs': return k === 'f32' ? Math.abs : k === 'i32' ? (x) => (x < 0 ? -x | 0 : x) : (x) => x
    case 'sign': return (x) => (x > 0 ? 1 : x < 0 ? -1 : 0)
    case 'floor': return Math.floor
    case 'ceil': return Math.ceil
    case 'round': return roundEven
    case 'trunc': return Math.trunc
    case 'fract': return (x) => f32(x - Math.floor(x))
    case 'sqrt': return (x) => f32(Math.sqrt(x))
    case 'rsqrt': return (x) => f32(1 / Math.sqrt(x))
    case 'exp': return (x) => f32(Math.exp(x))
    case 'exp2': return (x) => f32(2 ** x)
    case 'log': return (x) => f32(Math.log(x))
    case 'log2': return (x) => f32(Math.log2(x))
    case 'sin': return (x) => f32(Math.sin(x))
    case 'cos': return (x) => f32(Math.cos(x))
    case 'tan': return (x) => f32(Math.tan(x))
    case 'asin': return (x) => f32(Math.asin(x))
    case 'acos': return (x) => f32(Math.acos(x))
    case 'atan': return (x) => f32(Math.atan(x))
    case 'saturate': return (x) => clampOf(x, 0, 1)
  }
}

type Geometric = 'dot' | 'cross' | 'distance' | 'reflect'

function binaryOf(fn: Exclude<BinaryFn, Geometric>, k: Scalar): Fn2 {
  const u = k === 'u32'
  switch (fn) {
    case 'add': return k === 'f32' ? (a, b) => f32(a + b) : u ? (a, b) => (a + b) >>> 0 : (a, b) => (a + b) | 0
    case 'sub': return k === 'f32' ? (a, b) => f32(a - b) : u ? (a, b) => (a - b) >>> 0 : (a, b) => (a - b) | 0
    case 'mul': return k === 'f32' ? (a, b) => f32(a * b) : u ? (a, b) => Math.imul(a, b) >>> 0 : Math.imul
    case 'div': return k === 'f32' ? (a, b) => f32(a / b) : u ? divU : divI
    case 'rem': return k === 'f32' ? remF : u ? remU : remI
    case 'min': return minOf
    case 'max': return maxOf
    case 'pow': return (a, b) => f32(Math.pow(a, b))
    case 'atan2': return (a, b) => f32(Math.atan2(a, b))
    case 'step': return (edge, x) => (edge <= x ? 1 : 0)
    case 'and': return u ? (a, b) => (a & b) >>> 0 : (a, b) => a & b
    case 'or': return u ? (a, b) => (a | b) >>> 0 : (a, b) => a | b
    case 'xor': return u ? (a, b) => (a ^ b) >>> 0 : (a, b) => a ^ b
    case 'shl': return u ? (a, b) => (a << b) >>> 0 : (a, b) => a << b
    case 'shr': return u ? (a, b) => a >>> b : (a, b) => a >> b
    case 'eq': return (a, b) => (a === b ? 1 : 0)
    case 'ne': return (a, b) => (a !== b ? 1 : 0)
    case 'lt': return (a, b) => (a < b ? 1 : 0)
    case 'le': return (a, b) => (a <= b ? 1 : 0)
    case 'gt': return (a, b) => (a > b ? 1 : 0)
    case 'ge': return (a, b) => (a >= b ? 1 : 0)
    case 'land': return (a, b) => a & b
    case 'lor': return (a, b) => a | b
  }
}

/** The double fusedF32 rounds to odd, read and written little-endian whatever the host's byte order. */
const odd = new DataView(new ArrayBuffer(8))

/**
 * a b + c rounded once to f32. The product of two f32 values is exact in a double; the sum's rounding error is
 * recovered exactly (two-sum), and when it is not zero the double is rounded to odd (its last bit set, toward the
 * true value) before the one rounding to f32. A double carries more than 24 + 2 bits, so that rounding cannot land
 * on a false tie and the result is the correctly rounded f32 of the exact a b + c. The double's words go through a
 * DataView with the byte order given, so the result is the same on every host.
 */
function fusedF32(a: number, b: number, c: number): number {
  const p = a * b
  const s = p + c
  if (!Number.isFinite(s)) return f32(s)
  const v = s - p
  const err = (p - (s - v)) + (c - v)
  if (err === 0) return f32(s)
  odd.setFloat64(0, s, true)
  const lo = odd.getUint32(0, true)
  if ((lo & 1) === 0) {
    // One step of the last bit toward the true value s + err: away from zero when err has s's sign, else toward it.
    // The low word is at byte 0 and the high word at byte 4; a step down from a low word of 0 borrows from the high.
    if (err > 0 === s > 0) odd.setUint32(0, lo + 1, true)
    else if (lo === 0) {
      odd.setUint32(0, 0xffffffff, true)
      odd.setUint32(4, odd.getUint32(4, true) - 1, true)
    } else odd.setUint32(0, lo - 1, true)
  }
  return f32(odd.getFloat64(0, true))
}

function ternaryOf(fn: TernaryFn): Fn3 {
  switch (fn) {
    case 'mix': return (a, b, t) => f32(f32(a * f32(1 - t)) + f32(b * t))
    case 'clamp': return clampOf
    case 'smoothstep': return (lo, hi, x) => {
      const t = clampOf(f32(f32(x - lo) / f32(hi - lo)), 0, 1)
      return f32(f32(t * t) * f32(3 - f32(2 * t)))
    }
    case 'fma': return fusedF32
    case 'choose': return (c, yes, no) => (c !== 0 ? yes : no)
  }
}

function castOf(from: Scalar, to: Scalar): Fn1 {
  if (to === 'bool') return (x) => (x !== 0 ? 1 : 0)
  if (from === 'bool') return (x) => x
  if (to === 'f32') return f32
  if (from === 'f32') return to === 'i32' ? toI32 : toU32
  return coerceOf(to)
}

const scratch = new DataView(new ArrayBuffer(4))

function bitsOf(from: Scalar, to: Scalar): Fn1 {
  if (from === 'f32') {
    return to === 'i32'
      ? (x) => { scratch.setFloat32(0, x, true); return scratch.getInt32(0, true) }
      : (x) => { scratch.setFloat32(0, x, true); return scratch.getUint32(0, true) }
  }
  if (to === 'f32') return (x) => { scratch.setUint32(0, x >>> 0, true); return scratch.getFloat32(0, true) }
  return coerceOf(to)
}

// ---------------------------------------------------------------------------------------------------
// The compiler

/** One instruction or block: from the lanes running into it to the lanes that go on past it. */
type Exec = (mask: number) => number
const pass: Exec = (mask) => mask

/** Lanes in each 4-bit mask. */
const POP: readonly number[] = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4]

type Obj = { readonly [key: string]: unknown }
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const isWhole = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0

/** What a program's runs read their resources through, resolved by its bind(). Indexed by resource. */
interface Bound {
  readonly program: Program
  readonly blocks: readonly (DataView | null)[]
  readonly images: readonly (ImageBinding | null)[]
  readonly samplers: readonly (SamplerState | null)[]
}

/** The state of the run in progress, shared by every closure of one program. */
interface State {
  steps: number
  budget: number
  /** Lanes that are helpers: their out, write and put do nothing. */
  helper: number
  discarded: number
  positioned: number
  /** The innermost loop's lanes that broke, and those that continued, this iteration. */
  brk: number
  cont: number
  blocks: readonly (DataView | null)[]
  images: readonly (ImageBinding | null)[]
  samplers: readonly (SamplerState | null)[]
}

/** A stage input or builtin copied into the registers of the instruction that reads it, at the start of a run. */
interface Copy {
  readonly reg: number
  /** The position of the first component among a lane's numbers in the caller's list, and the components. */
  readonly at: number
  readonly n: number
  readonly coerce: Fn1
}

/** How a read or write finds its value: a constant offset, then the value-held and runtime-array steps. */
interface Plan {
  readonly base: number
  readonly dynamic: readonly { readonly reg: number; readonly stride: number; readonly last: number }[]
  /** The storage block's final array, when the path enters it: where it starts, its stride and the index. */
  readonly runtime: { readonly start: number; readonly stride: number; readonly reg: number; readonly index: number } | null
  /** The byte offset of each component within the value, and the bytes from its first byte to its last. */
  readonly parts: readonly number[]
  readonly extent: number
  readonly kind: Scalar
}

const BOUND = new WeakMap<Bindings, Bound>()
const PROGRAMS = new WeakSet<Program>()

type InstOf<K extends Inst['op']> = Extract<Inst, { readonly op: K }>

/** Reads caller data, so an error its reading raises (a getter, a proxy) comes out as a Fault. */
function guarded<T>(what: string, read: () => T): T {
  try {
    return read()
  } catch (e) {
    if (isFault(e)) throw e
    return fail('invalid', `${what} could not be read (reading it raised an error)`)
  }
}

/** A resource as a message names it. */
function describe(r: Resource): string {
  if (r.kind === 'constants') return 'the inline constants'
  const what = r.kind === 'storage-image' ? 'storage image' : r.kind === 'uniform' || r.kind === 'storage' ? `${r.kind} block` : r.kind
  return `the ${what} at set ${r.set} binding ${r.binding}`
}

function portLayout(ports: readonly Port[]): { readonly list: readonly PortLayout[]; readonly width: number } {
  let width = 0
  const list = [...ports].sort((a, b) => a.slot - b.slot).map((p) => {
    const entry: PortLayout = Object.freeze({ slot: p.slot, type: p.type, flat: p.flat === true, offset: width, size: componentsOf(p.type) })
    width += entry.size
    return entry
  })
  return { list: Object.freeze(list), width }
}

/** Turns one checked module into closures. Every method returns the closure of one instruction or block. */
class Compiler {
  readonly m: LensModule
  readonly types: (ValueType | undefined)[]
  readonly off: Int32Array
  readonly reg: Float64Array
  readonly st: State = { steps: 0, budget: 0, helper: 0, discarded: 0, positioned: 0, brk: 0, cont: 0, blocks: [], images: [], samplers: [] }
  readonly inputs: { readonly list: readonly PortLayout[]; readonly width: number }
  readonly outputs: { readonly list: readonly PortLayout[]; readonly width: number }
  readonly outbuf: Float64Array
  readonly posbuf = new Float64Array(LANES * 4)
  readonly inCopies: Copy[] = []
  readonly builtinCopies = new Map<Builtin, Copy[]>()
  /** A texel's four channels, for the image instructions. */
  readonly rgba = [0, 0, 0, 0]

  constructor(m: LensModule) {
    this.m = m
    this.types = new Array<ValueType | undefined>(m.ids).fill(undefined)
    this.typeAll(m.body)
    this.off = new Int32Array(m.ids)
    let total = 0
    for (let id = 0; id < m.ids; id++) {
      this.off[id] = total
      const t = this.types[id]
      total += t === undefined ? 0 : componentsOf(t) * LANES
    }
    try {
      this.reg = new Float64Array(total)
    } catch {
      fail('memory', `lens: module: the ${total} registers of the module could not be allocated`)
    }
    this.inputs = portLayout(m.inputs)
    this.outputs = portLayout(m.outputs)
    this.outbuf = new Float64Array(LANES * this.outputs.width)
  }

  private typeAll(insts: readonly Inst[]): void {
    for (const x of insts) {
      if ('id' in x) this.types[x.id] = x.t
      if (x.op === 'if') {
        this.typeAll(x.then)
        this.typeAll(x.else)
      } else if (x.op === 'loop') this.typeAll(x.body)
    }
  }

  private typeOf(id: number): ValueType {
    return this.types[id] as ValueType
  }

  /** Register base of component c of an id. */
  private at(id: number, c = 0): number {
    return this.off[id] + c * LANES
  }

  private comps(id: number): number {
    return componentsOf(this.typeOf(id))
  }

  /** Steps the register index of an operand by component: 0 for a scalar, which repeats across a vector, else 1. */
  private spread(id: number): number {
    return isScalar(this.typeOf(id)) ? LANES - 1 : -1
  }

  private readonly over = (): never =>
    fail('bound', `run: the ${this.m.stage} program ran past its budget of ${this.st.budget} steps (a step is one instruction, or one loop iteration, of one invocation)`)

  // -------------------------------------------------------------------------------------------------
  // Blocks and control

  block(insts: readonly Inst[]): Exec {
    const execs = insts.map((x) => this.inst(x))
    const st = this.st
    const over = this.over
    return (mask) => {
      let live = mask
      for (let i = 0; i < execs.length; i++) {
        st.steps += POP[live]
        if (st.steps > st.budget) over()
        live = execs[i](live)
        if (live === 0) return 0
      }
      return live
    }
  }

  private inst(x: Inst): Exec {
    const st = this.st
    switch (x.op) {
      case 'lit': return this.lit(x)
      case 'unary': return this.unary(x)
      case 'binary': return this.binary(x)
      case 'ternary': return this.map3(x.id, x.a, x.b, x.c, ternaryOf(x.fn))
      case 'make': return this.gather(x.id, this.made(x))
      case 'pick': return this.gather(x.id, x.lanes.map((k) => this.at(x.a, k)))
      case 'lane': return this.lane(x)
      case 'column': {
        const n = widthOf(this.typeOf(x.a))
        return this.gather(x.id, Array.from({ length: n }, (_, r) => this.at(x.a, x.i * n + r)))
      }
      case 'cast': return this.map1(x.id, x.a, castOf(scalarOf(this.typeOf(x.a)), scalarOf(x.t)))
      case 'bits': return this.map1(x.id, x.a, bitsOf(scalarOf(this.typeOf(x.a)), scalarOf(x.t)))
      case 'in': return this.input(x)
      case 'builtin': return this.builtin(x)
      case 'out': return this.out(x)
      case 'position': return this.position(x)
      case 'read': return this.read(x)
      case 'write': return this.write(x)
      case 'sample': return this.sample(x)
      case 'texel': return this.texel(x)
      case 'put': return this.put(x)
      case 'extent': return this.extent(x)
      case 'deriv': return this.deriv(x)
      case 'var': return this.variable(x)
      case 'get': return this.gather(x.id, Array.from({ length: this.comps(x.v) }, (_, c) => this.at(x.v, c)))
      case 'set': return this.set(x)
      case 'if': return this.branch(x)
      case 'loop': return this.loop(x)
      case 'break': return (mask) => { st.brk |= mask; return 0 }
      case 'continue': return (mask) => { st.cont |= mask; return 0 }
      case 'return': return () => 0
      case 'discard': return (mask) => {
        st.helper |= mask
        st.discarded |= mask
        return mask
      }
    }
  }

  private branch(x: InstOf<'if'>): Exec {
    const reg = this.reg
    const c = this.at(x.c)
    const yes = this.block(x.then)
    const no = this.block(x.else)
    return (mask) => {
      let holds = 0
      for (let l = 0; l < LANES; l++) if (reg[c + l] !== 0) holds |= 1 << l
      const t = mask & holds
      const e = mask & ~holds
      return (t !== 0 ? yes(t) : 0) | (e !== 0 ? no(e) : 0)
    }
  }

  private loop(x: InstOf<'loop'>): Exec {
    const st = this.st
    const over = this.over
    const body = this.block(x.body)
    return (mask) => {
      const outerBrk = st.brk
      const outerCont = st.cont
      st.brk = 0
      let active = mask
      for (let n = 0; active !== 0 && n < LOOP_ITERATIONS; n++) {
        st.steps += POP[active]
        if (st.steps > st.budget) over()
        st.cont = 0
        active = body(active) | st.cont
      }
      // Lanes still running after the last iteration leave with those that broke.
      const out = st.brk | active
      st.brk = outerBrk
      st.cont = outerCont
      return out
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Values

  private lit(x: InstOf<'lit'>): Exec {
    for (let c = 0; c < x.v.length; c++) this.reg.fill(x.v[c], this.at(x.id, c), this.at(x.id, c + 1))
    return pass
  }

  private map1(d: number, a: number, f: Fn1): Exec {
    const reg = this.reg
    const D = this.at(d)
    const A = this.at(a)
    const len = this.comps(d) * LANES
    return (mask) => {
      for (let i = 0; i < len; i++) reg[D + i] = f(reg[A + i])
      return mask
    }
  }

  private map2(d: number, a: number, b: number, f: Fn2): Exec {
    const reg = this.reg
    const D = this.at(d)
    const A = this.at(a)
    const B = this.at(b)
    const sa = this.spread(a)
    const sb = this.spread(b)
    const len = this.comps(d) * LANES
    return (mask) => {
      for (let i = 0; i < len; i++) reg[D + i] = f(reg[A + (i & sa)], reg[B + (i & sb)])
      return mask
    }
  }

  private map3(d: number, a: number, b: number, c: number, f: Fn3): Exec {
    const reg = this.reg
    const D = this.at(d)
    const A = this.at(a)
    const B = this.at(b)
    const C = this.at(c)
    const sa = this.spread(a)
    const sb = this.spread(b)
    const sc = this.spread(c)
    const len = this.comps(d) * LANES
    return (mask) => {
      for (let i = 0; i < len; i++) reg[D + i] = f(reg[A + (i & sa)], reg[B + (i & sb)], reg[C + (i & sc)])
      return mask
    }
  }

  /** Copies registers: component k of the result from the component whose register base is srcs[k]. */
  private gather(d: number, srcs: readonly number[]): Exec {
    const reg = this.reg
    const D = this.at(d)
    return (mask) => {
      for (let k = 0; k < srcs.length; k++) {
        const s = srcs[k]
        for (let l = 0; l < LANES; l++) reg[D + k * LANES + l] = reg[s + l]
      }
      return mask
    }
  }

  /** The components a make concatenates: one scalar repeated, or its operands' components in order. */
  private made(x: InstOf<'make'>): number[] {
    if (x.args.length === 1 && isScalar(this.typeOf(x.args[0]))) return new Array<number>(componentsOf(x.t)).fill(this.at(x.args[0]))
    return x.args.flatMap((a) => Array.from({ length: this.comps(a) }, (_, c) => this.at(a, c)))
  }

  private unary(x: InstOf<'unary'>): Exec {
    const n = this.comps(x.a)
    switch (x.fn) {
      case 'length': return this.norm(x.a, x.id, false)
      case 'normalize': return this.norm(x.a, x.id, true)
      case 'any': return this.reduce(x.a, x.id, false)
      case 'all': return this.reduce(x.a, x.id, true)
      case 'transpose': {
        // Component k of the result is column floor(k / w), row k % w; it is the operand's column k % w, row floor(k / w).
        const w = widthOf(this.typeOf(x.a))
        return this.gather(x.id, Array.from({ length: n }, (_, k) => this.at(x.a, (k % w) * w + Math.floor(k / w))))
      }
      default: return this.map1(x.id, x.a, unaryOf(x.fn, scalarOf(this.typeOf(x.a))))
    }
  }

  /** length (the root of the sum of squares, in double, rounded once), or normalize (each component over it). */
  private norm(a: number, d: number, divide: boolean): Exec {
    const reg = this.reg
    const A = this.at(a)
    const D = this.at(d)
    const n = this.comps(a)
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        let s = 0
        for (let c = 0; c < n; c++) s += reg[A + c * LANES + l] ** 2
        const root = Math.sqrt(s)
        if (divide) for (let c = 0; c < n; c++) reg[D + c * LANES + l] = f32(reg[A + c * LANES + l] / root)
        else reg[D + l] = f32(root)
      }
      return mask
    }
  }

  private reduce(a: number, d: number, every: boolean): Exec {
    const reg = this.reg
    const A = this.at(a)
    const D = this.at(d)
    const n = this.comps(a)
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        let r = every ? 1 : 0
        for (let c = 0; c < n; c++) r = every ? r & reg[A + c * LANES + l] : r | reg[A + c * LANES + l]
        reg[D + l] = r
      }
      return mask
    }
  }

  private binary(x: InstOf<'binary'>): Exec {
    const ta = this.typeOf(x.a)
    const tb = this.typeOf(x.b)
    switch (x.fn) {
      case 'dot': return this.sums(x.id, scalarOf(ta), [this.terms(this.comps(x.a), (k) => [this.at(x.a, k), this.at(x.b, k)])])
      case 'cross': return this.cross(x)
      case 'distance': return this.distance(x)
      case 'reflect': return this.reflect(x)
      case 'mul': {
        const n = widthOf(isGrid(ta) ? ta : tb)
        // Grids are column-major: entry (column j, row i) is component j * n + i.
        if (isGrid(ta) && isGrid(tb)) {
          return this.sums(x.id, 'f32', Array.from({ length: n * n }, (_, ji) => this.terms(n, (k) => [this.at(x.a, k * n + (ji % n)), this.at(x.b, Math.floor(ji / n) * n + k)])))
        }
        if (isGrid(ta) && tb !== 'f32') return this.sums(x.id, 'f32', Array.from({ length: n }, (_, i) => this.terms(n, (k) => [this.at(x.a, k * n + i), this.at(x.b, k)])))
        if (isGrid(tb)) return this.sums(x.id, 'f32', Array.from({ length: n }, (_, j) => this.terms(n, (k) => [this.at(x.a, k), this.at(x.b, j * n + k)])))
        return this.map2(x.id, x.a, x.b, binaryOf('mul', scalarOf(ta)))
      }
      default: return this.map2(x.id, x.a, x.b, binaryOf(x.fn, scalarOf(ta)))
    }
  }

  /** The register bases of n products, as a flat list of pairs. */
  private terms(n: number, pair: (k: number) => readonly [number, number]): number[] {
    return Array.from({ length: n }, (_, k) => pair(k)).flat()
  }

  /**
   * Each result component is a sum of products added left to right: terms[r] lists the register bases of its
   * factors in pairs. Every product and every sum rounds (f32) or wraps (i32, u32).
   */
  private sums(d: number, k: Scalar, terms: readonly (readonly number[])[]): Exec {
    const reg = this.reg
    const D = this.at(d)
    const mul = binaryOf('mul', k)
    const add = binaryOf('add', k)
    return (mask) => {
      for (let r = 0; r < terms.length; r++) {
        const t = terms[r]
        for (let l = 0; l < LANES; l++) {
          let acc = mul(reg[t[0] + l], reg[t[1] + l])
          for (let j = 2; j < t.length; j += 2) acc = add(acc, mul(reg[t[j] + l], reg[t[j + 1] + l]))
          reg[D + r * LANES + l] = acc
        }
      }
      return mask
    }
  }

  private cross(x: InstOf<'binary'>): Exec {
    const reg = this.reg
    const A = this.at(x.a)
    const B = this.at(x.b)
    const D = this.at(x.id)
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        const a0 = reg[A + l]
        const a1 = reg[A + LANES + l]
        const a2 = reg[A + 2 * LANES + l]
        const b0 = reg[B + l]
        const b1 = reg[B + LANES + l]
        const b2 = reg[B + 2 * LANES + l]
        reg[D + l] = f32(f32(a1 * b2) - f32(a2 * b1))
        reg[D + LANES + l] = f32(f32(a2 * b0) - f32(a0 * b2))
        reg[D + 2 * LANES + l] = f32(f32(a0 * b1) - f32(a1 * b0))
      }
      return mask
    }
  }

  /** The length of the f32 difference. For a scalar the root of the square is its size exactly. */
  private distance(x: InstOf<'binary'>): Exec {
    const reg = this.reg
    const A = this.at(x.a)
    const B = this.at(x.b)
    const D = this.at(x.id)
    const n = this.comps(x.a)
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        let s = 0
        for (let c = 0; c < n; c++) s += f32(reg[A + c * LANES + l] - reg[B + c * LANES + l]) ** 2
        reg[D + l] = f32(Math.sqrt(s))
      }
      return mask
    }
  }

  /** reflect(e1, e2) = e1 - (2 dot(e2, e1)) e2, every step rounded. */
  private reflect(x: InstOf<'binary'>): Exec {
    const reg = this.reg
    const A = this.at(x.a)
    const B = this.at(x.b)
    const D = this.at(x.id)
    const n = this.comps(x.a)
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        let dot = f32(reg[B + l] * reg[A + l])
        for (let c = 1; c < n; c++) dot = f32(dot + f32(reg[B + c * LANES + l] * reg[A + c * LANES + l]))
        const k = f32(2 * dot)
        for (let c = 0; c < n; c++) reg[D + c * LANES + l] = f32(reg[A + c * LANES + l] - f32(k * reg[B + c * LANES + l]))
      }
      return mask
    }
  }

  private lane(x: InstOf<'lane'>): Exec {
    const reg = this.reg
    const A = this.at(x.a)
    const I = this.at(x.i)
    const D = this.at(x.id)
    const last = widthOf(this.typeOf(x.a)) - 1
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        const i = reg[I + l]
        reg[D + l] = reg[A + (i <= 0 ? 0 : i >= last ? last : i) * LANES + l]
      }
      return mask
    }
  }

  private deriv(x: InstOf<'deriv'>): Exec {
    const reg = this.reg
    const A = this.at(x.a)
    const D = this.at(x.id)
    const len = this.comps(x.a) * LANES
    const fn: DerivativeFn = x.fn
    return (mask) => {
      for (let i = 0; i < len; i++) {
        const dx = fineX(reg, A + (i & ~3), i & 3)
        const dy = fineY(reg, A + (i & ~3), i & 3)
        reg[D + i] = fn === 'dx' ? dx : fn === 'dy' ? dy : f32(Math.abs(dx) + Math.abs(dy))
      }
      return mask
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Variables

  private variable(x: InstOf<'var'>): Exec {
    const reg = this.reg
    const V = this.at(x.id)
    const I = x.init === undefined ? -1 : this.at(x.init)
    const n = this.comps(x.id)
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        if (((mask >> l) & 1) === 0) continue
        for (let c = 0; c < n; c++) reg[V + c * LANES + l] = I < 0 ? 0 : reg[I + c * LANES + l]
      }
      return mask
    }
  }

  private set(x: InstOf<'set'>): Exec {
    const reg = this.reg
    const V = this.at(x.v)
    const A = this.at(x.a)
    const n = this.comps(x.v)
    return (mask) => {
      for (let l = 0; l < LANES; l++) {
        if (((mask >> l) & 1) === 0) continue
        for (let c = 0; c < n; c++) reg[V + c * LANES + l] = reg[A + c * LANES + l]
      }
      return mask
    }
  }

  // -------------------------------------------------------------------------------------------------
  // The stage interface

  private input(x: InstOf<'in'>): Exec {
    const port = this.inputs.list.find((p) => p.slot === x.slot) as PortLayout
    this.inCopies.push({ reg: this.at(x.id), at: port.offset, n: port.size, coerce: coerceOf(scalarOf(port.type)) })
    return pass
  }

  private builtin(x: InstOf<'builtin'>): Exec {
    const t: ValueType = BUILTINS[x.name].type
    const list = this.builtinCopies.get(x.name) ?? []
    list.push({ reg: this.at(x.id), at: 0, n: componentsOf(t), coerce: coerceOf(scalarOf(t)) })
    this.builtinCopies.set(x.name, list)
    return pass
  }

  private out(x: InstOf<'out'>): Exec {
    const reg = this.reg
    const st = this.st
    const buf = this.outbuf
    const width = this.outputs.width
    const port = this.outputs.list.find((p) => p.slot === x.slot) as PortLayout
    const A = this.at(x.a)
    return (mask) => {
      const live = mask & ~st.helper
      for (let l = 0; l < LANES; l++) {
        if (((live >> l) & 1) === 0) continue
        for (let c = 0; c < port.size; c++) buf[l * width + port.offset + c] = reg[A + c * LANES + l]
      }
      return mask
    }
  }

  private position(x: InstOf<'position'>): Exec {
    const reg = this.reg
    const st = this.st
    const buf = this.posbuf
    const A = this.at(x.a)
    return (mask) => {
      const live = mask & ~st.helper
      for (let l = 0; l < LANES; l++) {
        if (((live >> l) & 1) === 0) continue
        for (let c = 0; c < 4; c++) buf[l * 4 + c] = reg[A + c * LANES + l]
      }
      st.positioned |= live
      return mask
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Blocks in memory

  /** Follows a checked path through a block's layout, keeping the steps a run must take lane by lane. */
  private plan(res: number, path: readonly Step[]): Plan {
    const r = this.m.resources[res] as Extract<Resource, { readonly block: unknown }>
    const space: Space = r.kind === 'storage' ? 'storage' : 'uniform'
    let t: DataType = { struct: r.block }
    let base = 0
    const dynamic: { reg: number; stride: number; last: number }[] = []
    let runtime: Plan['runtime'] = null
    for (const step of path) {
      if (typeof t === 'string') break
      if ('struct' in t) {
        const i = step as number
        base += layoutBlock(t.struct, space).offsets[i]
        t = t.struct.fields[i].type
        continue
      }
      const stride = strideOf(t.array, space)
      const reg = typeof step === 'number' ? -1 : this.at(step.at)
      if (t.len === 0) runtime = { start: base, stride, reg, index: typeof step === 'number' ? step : 0 }
      else if (typeof step === 'number') base += step * stride
      else dynamic.push({ reg, stride, last: t.len - 1 })
      t = t.array
    }
    const leaf = t as ValueType
    const n = widthOf(leaf)
    const parts: number[] = []
    if (isGrid(leaf)) {
      const column = strideOf(columnOf(leaf) as DataType, space)
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) parts.push(j * column + i * 4)
    } else {
      for (let c = 0; c < n; c++) parts.push(c * 4)
    }
    return { base, dynamic, runtime, parts, extent: parts[parts.length - 1] + 4, kind: scalarOf(leaf) }
  }

  /** The byte at which lane l's value starts in the binding, or -1 when there is none to read or write. */
  private address(p: Plan, view: DataView, l: number): number {
    const reg = this.reg
    let at = p.base
    for (const s of p.dynamic) {
      const i = reg[s.reg + l]
      at += (i <= 0 ? 0 : i >= s.last ? s.last : i) * s.stride
    }
    const rt = p.runtime
    if (rt !== null) {
      const held = Math.floor((view.byteLength - rt.start) / rt.stride)
      if (held <= 0) return -1
      const i = rt.reg < 0 ? rt.index : reg[rt.reg + l]
      at += (i <= 0 ? 0 : i >= held - 1 ? held - 1 : i) * rt.stride
    }
    return at + p.extent <= view.byteLength ? at : -1
  }

  private read(x: InstOf<'read'>): Exec {
    const reg = this.reg
    const st = this.st
    const p = this.plan(x.res, x.path)
    const D = this.at(x.id)
    const res = x.res
    const get = p.kind === 'f32' ? (v: DataView, at: number) => v.getFloat32(at, true)
      : p.kind === 'i32' ? (v: DataView, at: number) => v.getInt32(at, true) : (v: DataView, at: number) => v.getUint32(at, true)
    return (mask) => {
      const view = st.blocks[res] as DataView
      for (let l = 0; l < LANES; l++) {
        if (((mask >> l) & 1) === 0) continue
        const at = this.address(p, view, l)
        for (let c = 0; c < p.parts.length; c++) reg[D + c * LANES + l] = at < 0 ? 0 : get(view, at + p.parts[c])
      }
      return mask
    }
  }

  private write(x: InstOf<'write'>): Exec {
    const reg = this.reg
    const st = this.st
    const p = this.plan(x.res, x.path)
    const A = this.at(x.a)
    const res = x.res
    const set = p.kind === 'f32' ? (v: DataView, at: number, n: number) => v.setFloat32(at, n, true)
      : p.kind === 'i32' ? (v: DataView, at: number, n: number) => v.setInt32(at, n, true) : (v: DataView, at: number, n: number) => v.setUint32(at, n, true)
    return (mask) => {
      const view = st.blocks[res] as DataView
      const live = mask & ~st.helper
      for (let l = 0; l < LANES; l++) {
        if (((live >> l) & 1) === 0) continue
        const at = this.address(p, view, l)
        if (at >= 0) for (let c = 0; c < p.parts.length; c++) set(view, at + p.parts[c], reg[A + c * LANES + l])
      }
      return mask
    }
  }

  // -------------------------------------------------------------------------------------------------
  // Images

  private sample(x: InstOf<'sample'>): Exec {
    const reg = this.reg
    const st = this.st
    const rgba = this.rgba
    const U = this.at(x.uv)
    const V = this.at(x.uv, 1)
    const L = x.layer === undefined ? -1 : this.at(x.layer)
    const Q = x.level === undefined ? -1 : this.at(x.level)
    const D = this.at(x.id)
    const { image, sampler } = x
    return (mask) => {
      const img = st.images[image] as ImageBinding
      const smp = st.samplers[sampler] as SamplerState
      const base = img.view.levels.base
      const w = img.store.levelWidth(base)
      const h = img.store.levelHeight(base)
      for (let l = 0; l < LANES; l++) {
        if (((mask >> l) & 1) === 0) continue
        const lod = Q >= 0 ? reg[Q + l] : lodFromRates(fineX(reg, U, l), fineX(reg, V, l), fineY(reg, U, l), fineY(reg, V, l), w, h)
        sample(img.store, img.view, smp, reg[U + l], reg[V + l], L < 0 ? 0 : reg[L + l], lod, rgba)
        for (let c = 0; c < 4; c++) reg[D + c * LANES + l] = rgba[c]
      }
      return mask
    }
  }

  private texel(x: InstOf<'texel'>): Exec {
    const reg = this.reg
    const st = this.st
    const rgba = this.rgba
    const X = this.at(x.at)
    const Y = this.at(x.at, 1)
    const L = x.layer === undefined ? -1 : this.at(x.layer)
    const Q = this.at(x.level)
    const D = this.at(x.id)
    const n = this.comps(x.id)
    const coerce = coerceOf(scalarOf(x.t))
    const image = x.image
    return (mask) => {
      const img = st.images[image] as ImageBinding
      for (let l = 0; l < LANES; l++) {
        if (((mask >> l) & 1) === 0) continue
        load(img.store, img.view, reg[X + l], reg[Y + l], L < 0 ? 0 : reg[L + l], reg[Q + l], rgba)
        // A depth image gives its depth alone, the first channel.
        for (let c = 0; c < n; c++) reg[D + c * LANES + l] = coerce(rgba[c])
      }
      return mask
    }
  }

  private put(x: InstOf<'put'>): Exec {
    const reg = this.reg
    const st = this.st
    const rgba = this.rgba
    const X = this.at(x.at)
    const Y = this.at(x.at, 1)
    const A = this.at(x.a)
    const image = x.image
    return (mask) => {
      const img = st.images[image] as ImageBinding
      const live = mask & ~st.helper
      for (let l = 0; l < LANES; l++) {
        if (((live >> l) & 1) === 0) continue
        for (let c = 0; c < 4; c++) rgba[c] = reg[A + c * LANES + l]
        put(img.store, img.view, reg[X + l], reg[Y + l], 0, rgba)
      }
      return mask
    }
  }

  private extent(x: InstOf<'extent'>): Exec {
    const reg = this.reg
    const st = this.st
    const Q = x.level === undefined ? -1 : this.at(x.level)
    const D = this.at(x.id)
    const image = x.image
    return (mask) => {
      const img = st.images[image] as ImageBinding
      const last = img.view.levels.count - 1
      for (let l = 0; l < LANES; l++) {
        if (((mask >> l) & 1) === 0) continue
        const q = Q < 0 ? 0 : reg[Q + l]
        const level = img.view.levels.base + (q <= 0 ? 0 : q >= last ? last : q)
        reg[D + l] = img.store.levelWidth(level)
        reg[D + LANES + l] = img.store.levelHeight(level)
      }
      return mask
    }
  }

  // -------------------------------------------------------------------------------------------------
  // The program

  program(): Program {
    const m = this.m
    const st = this.st
    const body = this.block(m.body)
    const over = this.over
    const result = { outputs: this.outbuf, position: this.posbuf, positioned: 0, discarded: 0, helpers: 0, steps: 0 }
    const builtins: readonly Builtin[] = Object.freeze((Object.keys(BUILTINS) as Builtin[]).filter((b) => this.builtinCopies.has(b)))
    const program: Program = Object.freeze({
      module: m,
      stage: m.stage,
      group: Object.freeze([m.group[0], m.group[1], m.group[2]] as const),
      inputs: this.inputs.list,
      inputWidth: this.inputs.width,
      outputs: this.outputs.list,
      outputWidth: this.outputs.width,
      builtins,
      bind: (resources: Resources): Bindings => {
        const bound = guarded('bind: the resources', () => this.resolve(resources, program))
        const bindings: Bindings = Object.freeze({ program })
        BOUND.set(bindings, bound)
        return bindings
      },
      run: (batch: Batch, bindings: Bindings, budget: number): RunResult => {
        const bound = BOUND.get(bindings)
        if (bound === undefined) fail('invalid', `run: the bindings are not ones a program's bind() made (${say(bindings)})`)
        if (bound.program !== program) fail('mismatch', 'run: the bindings were made by the bind() of another program')
        if (typeof budget !== 'number' || !(budget >= 0)) fail('invalid', `run: the budget is a number of steps, at least 0, not ${say(budget)}`)
        const lanes = guarded('run: the batch', () => this.take(batch, builtins))
        st.blocks = bound.blocks
        st.images = bound.images
        st.samplers = bound.samplers
        st.budget = budget
        st.discarded = 0
        st.positioned = 0
        st.brk = 0
        st.cont = 0
        this.outbuf.fill(0)
        this.posbuf.fill(0)
        const live = (1 << lanes) - 1
        st.steps = POP[live]
        if (st.steps > budget) over()
        body(live)
        result.positioned = st.positioned
        result.discarded = st.discarded
        result.helpers = st.helper
        result.steps = st.steps
        return result
      },
    })
    PROGRAMS.add(program)
    return program
  }

  /** Checks a batch, copies its inputs and builtins into the registers that read them, and returns its lanes. */
  private take(batch: unknown, builtins: readonly Builtin[]): number {
    const stage = this.m.stage
    if (!isObj(batch)) fail('invalid', `run: the batch is an object, not ${say(batch)}`)
    const lanes = batch.lanes
    if (!Number.isInteger(lanes) || (lanes as number) < 1 || (lanes as number) > LANES) fail('invalid', `run: a batch runs 1 to ${LANES} lanes, not ${say(lanes)}`)
    const n = lanes as number
    if (stage === 'fragment' && n !== LANES) fail('invalid', `run: a fragment batch is a 2 x 2 quad of ${LANES} lanes, not ${n}`)
    const helpers = batch.helpers ?? 0
    if (!isWhole(helpers) || helpers >= 1 << n) fail('invalid', `run: the helpers are a mask of the batch's ${n} lanes, not ${say(helpers)}`)
    if (helpers !== 0 && stage !== 'fragment') fail('invalid', `run: only a fragment batch has helper lanes, not a ${stage} batch`)
    if (this.inCopies.length > 0) this.rows(batch.inputs, this.inputs.width, n, 'the inputs', this.inCopies)
    if (builtins.length > 0) {
      const given = batch.builtins
      if (!isObj(given)) fail('invalid', `run: the batch gives no builtins, and the program reads ${builtins.join(', ')}`)
      for (const name of builtins) {
        const copies = this.builtinCopies.get(name) as Copy[]
        this.rows(given[name], copies[0].n, n, `builtin ${name}`, copies)
      }
    }
    this.st.helper = helpers
    return n
  }

  /** Copies lane-by-lane numbers into registers, each rounded or wrapped to its kind. */
  private rows(src: unknown, stride: number, lanes: number, what: string, copies: readonly Copy[]): void {
    if (typeof src !== 'object' || src === null || typeof (src as { readonly length?: unknown }).length !== 'number') {
      fail('invalid', `run: ${what} are a list of numbers, lane by lane, not ${say(src)}`)
    }
    const list = src as ArrayLike<unknown>
    if (list.length < lanes * stride) fail('invalid', `run: ${what} hold ${list.length} numbers, and ${lanes} lanes of ${stride} need ${lanes * stride}`)
    for (const copy of copies) {
      for (let l = 0; l < lanes; l++) {
        for (let c = 0; c < copy.n; c++) {
          const v = list[l * stride + copy.at + c]
          if (typeof v !== 'number') fail('invalid', `run: ${what} hold ${say(v)} at ${l * stride + copy.at + c}, which is not a number`)
          this.reg[copy.reg + c * LANES + l] = copy.coerce(v)
        }
      }
    }
  }

  /** Asks the caller for every resource the module declares, checks each, and keeps what runs need. */
  private resolve(resources: Resources, program: Program): Bound {
    if (!isObj(resources)) fail('invalid', `bind: the resources are an object with block, image, sampler and storageImage methods, not ${say(resources)}`)
    const n = this.m.resources.length
    const blocks = new Array<DataView | null>(n).fill(null)
    const images = new Array<ImageBinding | null>(n).fill(null)
    const samplers = new Array<SamplerState | null>(n).fill(null)
    this.m.resources.forEach((r, i) => {
      const name = `bind: resource ${i}, ${describe(r)}`
      switch (r.kind) {
        case 'uniform': case 'storage': case 'constants':
          blocks[i] = blockView(ask(resources, 'block', i, name), name)
          break
        case 'image': case 'storage-image':
          images[i] = imageOf(ask(resources, r.kind === 'image' ? 'image' : 'storageImage', i, name), r, name)
          break
        case 'sampler':
          samplers[i] = samplerOf(ask(resources, 'sampler', i, name), name)
          break
      }
    })
    return Object.freeze({ program, blocks: Object.freeze(blocks), images: Object.freeze(images), samplers: Object.freeze(samplers) })
  }
}

/** The fine difference along x for lane l of the quad whose four lanes start at register r: within its row. */
function fineX(reg: Float64Array, r: number, l: number): number {
  const row = r + (l & 2)
  return f32(reg[row + 1] - reg[row])
}

/** The fine difference along y for lane l: within its column. */
function fineY(reg: Float64Array, r: number, l: number): number {
  const column = r + (l & 1)
  return f32(reg[column + 2] - reg[column])
}

/** Calls one of the caller's Resources methods for a resource, refusing an answer of nothing. */
function ask(resources: Resources, method: keyof Resources, res: number, name: string): unknown {
  const f: unknown = resources[method]
  if (typeof f !== 'function') fail('invalid', `${name}: the resources have no ${method}() to give it`)
  const got: unknown = (f as (this: Resources, res: number) => unknown).call(resources, res)
  if (got === null || got === undefined) fail('invalid', `${name}: nothing is bound to it`)
  return got
}

function blockView(got: unknown, name: string): DataView {
  if (!isObj(got) || !(got.bytes instanceof Uint8Array) || !isWhole(got.offset) || !isWhole(got.size) || got.offset + got.size > got.bytes.length) {
    fail('invalid', `${name}: a block binding is { bytes, offset, size }, a Uint8Array and a whole-number range within it`)
  }
  return new DataView(got.bytes.buffer, got.bytes.byteOffset + got.offset, got.size)
}

function rangeOf(x: unknown, total: number, what: string, name: string): Range {
  if (!isObj(x) || !isWhole(x.base) || !isWhole(x.count) || x.count < 1 || x.base + x.count > total) {
    fail('invalid', `${name}: the view's ${what} must be a range of at least one within the image's ${total} ${what}`)
  }
  return Object.freeze({ base: x.base, count: x.count })
}

function imageOf(got: unknown, r: Extract<Resource, { readonly kind: 'image' | 'storage-image' }>, name: string): ImageBinding {
  if (!isObj(got) || !(got.store instanceof ImageStore) || !isObj(got.view)) fail('invalid', `${name}: an image binding is { store, view }, an ImageStore and the levels and layers it shows`)
  const store = got.store
  const view: ViewRange = Object.freeze({ levels: rangeOf(got.view.levels, store.levels, 'levels', name), layers: rangeOf(got.view.layers, store.layers, 'layers', name) })
  if (store.samples !== 1) fail('mismatch', `${name}: a shader reads one-sample images, not a ${store.samples}-sample one (resolve it first)`)
  if (r.kind === 'storage-image') {
    if (store.format !== r.format) fail('mismatch', `${name}: it is declared ${r.format}, and the bound image is ${store.format}`)
  } else {
    if (sampleKind(store.format) !== r.sample) fail('mismatch', `${name}: it reads ${r.sample} values, and a ${store.format} image holds ${sampleKind(store.format)} values`)
    if (r.dims === '2d' && view.layers.count !== 1) fail('mismatch', `${name}: a 2d image is a view of one layer, not of ${view.layers.count}`)
  }
  return Object.freeze({ store, view })
}

function samplerOf(got: unknown, name: string): SamplerState {
  const filter = (f: unknown): f is Filter => f === 'nearest' || f === 'linear'
  const wrap = (w: unknown): w is Wrap => w === 'clamp' || w === 'repeat' || w === 'mirror'
  if (!isObj(got)) fail('invalid', `${name}: a sampler is an object, not ${say(got)}`)
  const { mag, min, mip, wrap: w, lodMin, lodMax } = got
  const ok = filter(mag) && filter(min) && filter(mip) && Array.isArray(w) && w.length === 3 && wrap(w[0]) && wrap(w[1]) && wrap(w[2])
  if (!ok || typeof lodMin !== 'number' || typeof lodMax !== 'number' || !(lodMin <= lodMax)) {
    fail('invalid', `${name}: a sampler has nearest or linear filters, clamp, repeat or mirror wrapping on three axes, and lodMin no greater than lodMax`)
  }
  return Object.freeze({ mag, min, mip, wrap: Object.freeze([w[0], w[1], w[2]] as const), lodMin, lodMax })
}

// ---------------------------------------------------------------------------------------------------
// Entry points

/**
 * Checks a module with verify() (refusing it with a Fault of code `lens`) and compiles it into a Program. A module
 * that changes or cannot be read while it is compiled is refused the same way.
 */
export function compile(m: LensModule): Program {
  verify(m)
  try {
    return new Compiler(m).program()
  } catch (e) {
    if (isFault(e)) throw e
    return fail('lens', 'lens: module: the module could not be read as it was compiled (it changed, or reading it raised an error)')
  }
}

/**
 * Runs every invocation of a compute dispatch of `groups` workgroups, group by group (x fastest, then y, then z) and
 * within a group in batches of LANES consecutive local indices, giving each lane its global-id, local-id, group-id,
 * local-index and group-count. The whole dispatch shares one budget; returns the steps it took.
 */
export function dispatch(program: Program, bindings: Bindings, groups: readonly [number, number, number], budget: number = DEFAULT_BUDGET): number {
  if (!PROGRAMS.has(program)) fail('invalid', `dispatch: the program is not one compile() made (${say(program)})`)
  if (program.stage !== 'compute') fail('invalid', `dispatch: a ${program.stage} program is not dispatched; only a compute program is`)
  const [gx, gy, gz] = guarded('dispatch: the groups', () => {
    const ok = Array.isArray(groups) && groups.length === 3 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= MAX_GROUPS)
    if (!ok) fail('invalid', `dispatch: the groups are three whole numbers from 0 to ${MAX_GROUPS}, not ${say(groups)}`)
    return [groups[0], groups[1], groups[2]]
  })
  if (typeof budget !== 'number' || !(budget >= 0)) fail('invalid', `dispatch: the budget is a number of steps, at least 0, not ${say(budget)}`)
  const [sx, sy, sz] = program.group
  const per = sx * sy * sz
  const globalId = new Float64Array(LANES * 3)
  const localId = new Float64Array(LANES * 3)
  const groupId = new Float64Array(LANES * 3)
  const localIndex = new Float64Array(LANES)
  const groupCount = new Float64Array(LANES * 3)
  for (let l = 0; l < LANES; l++) groupCount.set([gx, gy, gz], l * 3)
  const batch = { lanes: LANES, builtins: { 'global-id': globalId, 'local-id': localId, 'group-id': groupId, 'local-index': localIndex, 'group-count': groupCount } }
  let used = 0
  for (let z = 0; z < gz; z++) {
    for (let y = 0; y < gy; y++) {
      for (let x = 0; x < gx; x++) {
        for (let first = 0; first < per; first += LANES) {
          batch.lanes = Math.min(LANES, per - first)
          for (let l = 0; l < batch.lanes; l++) {
            const i = first + l
            const local = [i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy))]
            localId.set(local, l * 3)
            groupId.set([x, y, z], l * 3)
            globalId.set([x * sx + local[0], y * sy + local[1], z * sz + local[2]], l * 3)
            localIndex[l] = i
          }
          used += program.run(batch, bindings, budget - used).steps
        }
      }
    }
  }
  return used
}
