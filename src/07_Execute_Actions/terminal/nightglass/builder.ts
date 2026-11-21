// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how a person (and the console's app kit) writes a Lens shader: a builder whose
 * methods emit instructions and hand back typed values, so a shader reads like the arithmetic it does instead of a
 * list of ids. It infers every result type from the verifier's own typing table and refuses a mistake the moment it
 * is made, with a Fault of code `lens` whose message names the place the instruction would take
 * (`lens: body[4].then[1] binary: add takes ...`), and `finish()` deep-freezes the module and checks it whole,
 * binary form included, so every module it hands back can become a lens.
 * What breaks if it is removed? Every shader in the product would be written as raw instruction objects with ids
 * counted by hand, and a type mistake would surface only when the whole module is checked, far from its cause.
 *
 * A fragment shader that tints a texture:
 *
 *   const b = lens('fragment')
 *   const uv = b.input(0, 'f32x2')
 *   const color = b.output(0, 'f32x4')
 *   const params = b.uniform(0, 0, { tint: 'f32x4', fade: 'f32' })
 *   const tex = b.image(0, 1)
 *   const smp = b.sampler(0, 2)
 *   const texel = b.sample(tex, smp, uv)
 *   const tinted = b.mul(texel, b.read(params, 'tint'))
 *   b.out(color, b.mix(tinted, texel, b.read(params, 'fade')))
 *   const module = b.finish()
 *
 * A compute shader that doubles each element of a buffer twice over, counting the rounds in a variable:
 *
 *   const b = lens('compute', { group: [64, 1, 1] })
 *   const data = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
 *   const i = b.pick(b.builtin('global-id'), 'x')
 *   const n = b.var('u32', 0)
 *   b.loop(() => {
 *     b.if(b.ge(b.get(n), 2), () => b.break())
 *     b.write(data, ['items', i], b.mul(b.read(data, 'items', i), 2))
 *     b.set(n, b.add(b.get(n), 1))
 *   })
 *   const module = b.finish()
 *
 * Where a value is expected a plain number or boolean may stand in: it becomes a literal of the type the place
 * needs (`b.mul(v, 2)` multiplies by an f32 2 when v holds f32 values, `b.add(i, 1)` adds a u32 1 to a u32). With
 * nothing to take a type from, a number is an f32. A path into a block names fields by name or index and elements
 * by a number or by an i32 or u32 value. Values made inside an `if` or `loop` callback end with it; carry a result
 * out through a variable.
 */
import { encode } from './binary.ts'
import { fail, isFault } from './fault.ts'
import type { Format } from './formats.ts'
import {
  BINARY, DERIVATIVES, LENS_LIMITS, STAGES, TERNARY, UNARY, componentsOf, isGrid, isScalar, isValueType, isVector, scalarOf,
  vectorOf, walk, widthOf,
} from './lens.ts'
import type {
  ArrayType, BinaryFn, Block, Builtin, DataType, DerivativeFn, ImageDims, Inst, LensModule, Port, Resource, SampleKind, Scalar,
  Stage, Step, TernaryFn, UnaryFn, ValueType,
} from './lens.ts'
import {
  MAX_INDEX, MAX_OPERANDS, binaryType, bitsRule, builtinType, castRule, columnType, groupRule, laneType, makeRule, pickType,
  portRule, putType, resourceRule, say, ternaryType, texelType, unaryType, verify,
} from './verify.ts'
import type { Layouts, Refuse } from './verify.ts'

/** A value the builder made: its id in the module and its type. */
export interface Val {
  readonly id: number
  readonly t: ValueType
}
/** A variable: read it with `get`, write it with `set`. */
export interface Var {
  readonly id: number
  readonly t: ValueType
  readonly variable: true
}
/** An output port, written with `out`. */
export interface Out {
  readonly slot: number
  readonly t: ValueType
}
/** A declared resource: its index in the module's resources and what it is. */
export interface BlockRes {
  readonly res: number
  readonly kind: 'uniform' | 'storage' | 'constants'
  readonly block: Block
  readonly writable: boolean
}
export interface ImageRes {
  readonly res: number
  readonly kind: 'image'
  readonly sample: SampleKind
  readonly dims: ImageDims
}
export interface SamplerRes {
  readonly res: number
  readonly kind: 'sampler'
}
export interface StorageImageRes {
  readonly res: number
  readonly kind: 'storage-image'
  readonly format: Format
}
export type Res = BlockRes | ImageRes | SamplerRes | StorageImageRes

/** Where a value is expected, a number or a boolean may stand in for a literal of the type the place needs. */
export type Operand = Val | number | boolean
/** A step of a path into a block: a field by name or index, or an element by constant index or by an i32/u32 value. */
export type PathStep = string | number | Val
/** A field of a block written compactly: a number type, an array (see arrayOf), a Block, or a nested spec. */
export type FieldSpec = DataType | Block | BlockSpec
/** A block written as an object whose keys, in order, are its field names. */
export interface BlockSpec {
  readonly [name: string]: FieldSpec
}

type Obj = { readonly [key: string]: unknown }
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)

/**
 * A whole number a module holds (a set, binding, slot, path step, lane, column or array length) with -0 made 0, as
 * verify() asks.
 */
const plain = <T>(x: T): T => (typeof x === 'number' ? ((x + 0) as T) : x)

/** The fields a copy may still make: one spec or Block object shared under many fields is copied once for each. */
interface Budget {
  left: number
}

/** Converts a field spec to a block type. Anything it does not recognise passes through for resourceRule to refuse. */
function toType(spec: unknown, depth: number, budget: Budget): unknown {
  if (!isObj(spec) || depth > LENS_LIMITS.nesting) return spec
  if (Object.hasOwn(spec, 'array') && typeof spec.len === 'number') return { array: toType(spec.array, depth + 1, budget), len: plain(spec.len) }
  if (Object.hasOwn(spec, 'struct') && isObj(spec.struct) && Array.isArray(spec.struct.fields)) return { struct: toBlock(spec.struct, depth + 1, budget) }
  return { struct: toBlock(spec, depth + 1, budget) }
}

function toBlock(spec: unknown, depth: number, budget: Budget): unknown {
  if (!isObj(spec) || depth > LENS_LIMITS.nesting + 1) return spec
  const fields: unknown = spec.fields
  const names = Array.isArray(fields) ? [] : Object.keys(spec)
  // Counted before the copy is made, so a small spec that shares itself into a vast tree is refused, not copied.
  budget.left -= Array.isArray(fields) ? fields.length : names.length
  if (budget.left < 0) fail('lens', `lens: block: the block holds more than ${LENS_LIMITS.blockFields} fields in all`)
  if (Array.isArray(fields)) {
    return { fields: (fields as unknown[]).map((f) => (isObj(f) ? { name: f.name, type: toType(f.type, depth, budget) } : f)) }
  }
  return { fields: names.map((name) => ({ name, type: toType(spec[name], depth, budget) })) }
}

/**
 * A fresh Block from a spec (`{ tint: 'f32x4', lights: arrayOf({ pos: 'f32x3', power: 'f32' }, 4) }`) or a copy of
 * a Block. A spec's keys are its field names in order; a value is a number type, `arrayOf(...)`, a nested spec, or a
 * Block. The result is checked when a resource declares it. A spec or Block object reached under several fields is
 * copied for each, and a copy of more than LENS_LIMITS.blockFields fields in all is refused (Fault `lens`) before it
 * is made, as verify() refuses such a module.
 */
export function block(spec: BlockSpec | Block): Block {
  return toBlock(spec, 0, { left: LENS_LIMITS.blockFields }) as Block
}

/** An array type for a block spec: `len` elements, or (0, the default; -0 is 0) as many as the bound buffer holds. */
export function arrayOf(element: FieldSpec, len = 0): ArrayType {
  return { array: toType(element, 1, { left: LENS_LIMITS.blockFields }) as DataType, len: plain(len) }
}

/** Freezes an object and everything in it. */
function deepFreeze<T>(x: T): T {
  if (typeof x === 'object' && x !== null) {
    Object.freeze(x)
    for (const v of Object.values(x)) deepFreeze(v)
  }
  return x
}

/** A block of instructions being written: an `if` branch, a loop body, or the body itself. */
interface Frame {
  readonly insts: Inst[]
  readonly path: string
  readonly loop: boolean
  readonly defined: number[]
  /** The op that ended the block (break, continue or return), or '' while instructions may still follow. */
  ended: string
}

/** The type a number or boolean takes when nothing else gives one. */
const guess = (x: unknown): ValueType => (typeof x === 'boolean' ? 'bool' : 'f32')
/** The type a number takes as an index: u32, or i32 when it is negative. */
const indexType = (x: unknown): Scalar => (typeof x === 'number' && x < 0 ? 'i32' : 'u32')
const LANE_NAMES = 'xyzwrgba'

/** Writes one Lens module. Made by `lens(stage, opts)`; see the head of the file. */
export class LensBuilder {
  readonly stage: Stage
  readonly group: readonly [number, number, number]
  private readonly inputs: Port[] = []
  private readonly outputs: Port[] = []
  private readonly outs: Out[] = []
  private readonly resources: Resource[] = []
  private readonly handles: Res[] = []
  private readonly body: Inst[] = []
  private readonly frames: Frame[]
  private readonly values: (Val | Var)[] = []
  private readonly live: boolean[] = []
  private readonly budget = { left: LENS_LIMITS.blockFields }
  /** The layouts of the blocks the builder declared (its own copies, frozen once declared), laid out once each. */
  private readonly layouts: Layouts = { uniform: new WeakMap(), storage: new WeakMap() }
  private count = 0
  private returned = false
  private done = false

  constructor(stage: Stage, group: readonly [number, number, number] = [1, 1, 1]) {
    if (!STAGES.includes(stage)) fail('lens', `lens: module: ${say(stage)} is not a stage`)
    groupRule(stage, group, (rule) => fail('lens', `lens: group: ${rule}`))
    this.stage = stage
    this.group = Object.freeze([group[0], group[1], group[2]] as const)
    this.frames = [{ insts: this.body, path: 'body', loop: false, defined: [], ended: '' }]
  }

  /** Values and variables made so far: the module's `ids` when it finishes. */
  get ids(): number {
    return this.values.length
  }

  // -------------------------------------------------------------------------------------------------
  // The machinery every method shares

  private top(): Frame {
    return this.frames[this.frames.length - 1]
  }

  /** The place the next instruction takes, as the verifier names it. */
  private place(): string {
    const f = this.top()
    return `${f.path}[${f.insts.length}]`
  }

  /** Starts an instruction: refuses it after `finish` or after the op that ended its block, and names its place. */
  private begin(op: string): Refuse {
    const no: Refuse = (rule) => fail('lens', `lens: ${this.place()} ${op}: ${rule}`)
    if (this.done) no('the builder has finished its module')
    const ended = this.top().ended
    if (ended !== '') no(`nothing may follow ${ended} in its block`)
    return no
  }

  private push(inst: Inst, no: Refuse): void {
    if (this.count >= LENS_LIMITS.instructions) no(`a module holds at most ${LENS_LIMITS.instructions} instructions`)
    this.count++
    this.top().insts.push(inst)
  }

  /** The id the next value or variable takes. */
  private next(no: Refuse): number {
    if (this.values.length >= LENS_LIMITS.ids) no(`a module holds at most ${LENS_LIMITS.ids} values and variables`)
    return this.values.length
  }

  /** Emits an instruction that defines a value and returns the value. */
  private def(inst: Inst & { readonly id: number; readonly t: ValueType }, no: Refuse): Val {
    this.push(inst, no)
    return this.keep(Object.freeze({ id: inst.id, t: inst.t }))
  }

  private keep<H extends Val | Var>(handle: H): H {
    this.values.push(handle)
    this.live.push(true)
    this.top().defined.push(handle.id)
    return handle
  }

  /** A value of this builder that is still in scope. */
  private val(x: unknown, name: string, no: Refuse): Val {
    const id = isObj(x) ? x.id : undefined
    const known = typeof id === 'number' ? this.values[id] : undefined
    if (known === undefined || known !== x) no(`${name} is not a value of this builder (${say(x)})`)
    if ('variable' in known) no(`${name} is a variable; read it with get`)
    if (!this.live[known.id]) no(`${name} (%${known.id}) was made inside a block that has ended; carry it out through a variable`)
    return known
  }

  /** The type of an operand that is a value; undefined for a number or boolean, whose type the place decides. */
  private known(x: unknown, name: string, no: Refuse): ValueType | undefined {
    return typeof x === 'number' || typeof x === 'boolean' ? undefined : this.val(x, name, no).t
  }

  /** An operand as a value: a value of this builder, or a number or boolean made a literal of type `hint`. */
  private take(x: unknown, hint: ValueType, name: string, no: Refuse): Val {
    if (typeof x === 'number' || typeof x === 'boolean') return this.literal(hint, [this.component(scalarOf(hint), x, no)], no)
    return this.val(x, name, no)
  }

  /** An operand that must be of one of the allowed types. */
  private need(x: unknown, hint: ValueType, name: string, allowed: readonly ValueType[], no: Refuse): Val {
    const v = this.take(x, hint, name, no)
    if (!allowed.includes(v.t)) no(`${name} is ${v.t}, not ${allowed.join(' or ')}`)
    return v
  }

  /** One literal component of a scalar kind: f32 rounded to binary32, integers whole and in range, bools from booleans. */
  private component(k: Scalar, x: unknown, no: Refuse): number {
    if (k === 'bool') {
      if (typeof x !== 'boolean') no(`bool values are written true or false, not ${say(x)}`)
      return x ? 1 : 0
    }
    if (typeof x !== 'number') no(`${k} values are written as numbers, not ${say(x)}`)
    if (k === 'f32') {
      const r = Math.fround(x)
      if (!Number.isFinite(r)) no(`f32 values are finite numbers within the range of f32, not ${x}`)
      return r
    }
    const [lo, hi] = k === 'i32' ? [-0x80000000, 0x7fffffff] : [0, 0xffffffff]
    if (!Number.isInteger(x) || x < lo || x > hi) no(`${k} values are whole numbers from ${lo} to ${hi}, not ${x}`)
    return x + 0
  }

  /** Emits a literal of type t from one component (repeated) or all of them. */
  private literal(t: ValueType, v: readonly number[], no: Refuse): Val {
    const n = componentsOf(t)
    return this.def({ op: 'lit', id: this.next(no), t, v: v.length === n ? v : new Array<number>(n).fill(v[0]) }, no)
  }

  /** A resource handle of this builder, of one of the kinds the instruction takes. */
  private handle<H extends Res>(x: unknown, kinds: readonly H['kind'][], name: string, no: Refuse): H {
    const res = isObj(x) ? x.res : undefined
    const h = typeof res === 'number' ? this.handles[res] : undefined
    if (h === undefined || h !== x) no(`${name} is not a resource of this builder (${say(x)})`)
    if (!(kinds as readonly string[]).includes(h.kind)) no(`resource ${h.res} is a ${h.kind}, not ${kinds.join(' or ')}`)
    return h as H
  }

  /** Runs a callback that writes one block, then ends the values it made. */
  private nest(insts: Inst[], path: string, loop: boolean, write: () => void): void {
    this.frames.push({ insts, path, loop, defined: [], ended: '' })
    try {
      write()
    } finally {
      const f = this.frames.pop()
      if (f !== undefined) for (const id of f.defined) this.live[id] = false
    }
  }

  /** Implicit-level sampling and derivatives: fragment only, at the top level, before any instruction holding a return. */
  private rate(what: string, no: Refuse): void {
    if (this.stage !== 'fragment') no(`${what} is only in the fragment stage`)
    if (this.frames.length !== 1) no(`${what} sits at the top level of the body, where neighbouring pixels all reach it`)
    if (this.returned) no(`${what} sits before any instruction that holds a return, where neighbouring pixels all reach it`)
  }

  // -------------------------------------------------------------------------------------------------
  // Literals

  /** A literal of any value type: one component per scalar of the type, or one to repeat. */
  lit(t: ValueType, ...v: readonly (number | boolean)[]): Val {
    const no: Refuse = this.begin('lit')
    if (!isValueType(t)) no(`${say(t)} is not a value type`)
    const n = componentsOf(t)
    if (v.length !== n && v.length !== 1) no(`a ${t} literal takes ${n} components (or one to repeat), not ${v.length}`)
    return this.literal(t, v.map((x) => this.component(scalarOf(t), x, no)), no)
  }

  f32(x: number): Val {
    return this.lit('f32', x)
  }

  i32(x: number): Val {
    return this.lit('i32', x)
  }

  u32(x: number): Val {
    return this.lit('u32', x)
  }

  bool(x: boolean): Val {
    return this.lit('bool', x)
  }

  // -------------------------------------------------------------------------------------------------
  // Functions of values

  unary(fn: UnaryFn, a: Operand): Val {
    const no: Refuse = this.begin('unary')
    if (!UNARY.includes(fn)) no(`${say(fn)} is not a unary function`)
    const A = this.take(a, guess(a), 'the operand', no)
    const t = unaryType(fn, A.t, no)
    return this.def({ op: 'unary', id: this.next(no), t, fn, a: A.id }, no)
  }

  binary(fn: BinaryFn, a: Operand, b: Operand): Val {
    const no: Refuse = this.begin('binary')
    if (!BINARY.includes(fn)) no(`${say(fn)} is not a binary function`)
    const ta = this.known(a, 'operand a', no)
    const tb = this.known(b, 'operand b', no)
    const A = this.take(a, ta ?? (tb === undefined ? guess(a) : hintFor(fn, tb)), 'operand a', no)
    const B = this.take(b, tb ?? hintFor(fn, A.t), 'operand b', no)
    const t = binaryType(fn, A.t, B.t, no)
    return this.def({ op: 'binary', id: this.next(no), t, fn, a: A.id, b: B.id }, no)
  }

  ternary(fn: TernaryFn, a: Operand, b: Operand, c: Operand): Val {
    const no: Refuse = this.begin('ternary')
    if (!TERNARY.includes(fn)) no(`${say(fn)} is not a ternary function`)
    const ta = this.known(a, 'operand a', no)
    const tb = this.known(b, 'operand b', no)
    const tc = this.known(c, 'operand c', no)
    let A: Val
    let B: Val
    let C: Val
    if (fn === 'choose') {
      A = this.take(a, 'bool', 'the condition', no)
      B = this.take(b, tb ?? tc ?? guess(b), 'operand b', no)
      C = this.take(c, tc ?? B.t, 'operand c', no)
    } else if (fn === 'mix') {
      A = this.take(a, ta ?? tb ?? guess(a), 'operand a', no)
      B = this.take(b, tb ?? A.t, 'operand b', no)
      C = this.take(c, 'f32', 'operand c', no)
    } else {
      A = this.take(a, ta ?? tb ?? tc ?? guess(a), 'operand a', no)
      B = this.take(b, tb ?? A.t, 'operand b', no)
      C = this.take(c, tc ?? A.t, 'operand c', no)
    }
    const t = ternaryType(fn, A.t, B.t, C.t, no)
    return this.def({ op: 'ternary', id: this.next(no), t, fn, a: A.id, b: B.id, c: C.id }, no)
  }

  neg(a: Operand): Val { return this.unary('neg', a) }
  not(a: Operand): Val { return this.unary('not', a) }
  bitnot(a: Operand): Val { return this.unary('bitnot', a) }
  abs(a: Operand): Val { return this.unary('abs', a) }
  sign(a: Operand): Val { return this.unary('sign', a) }
  floor(a: Operand): Val { return this.unary('floor', a) }
  ceil(a: Operand): Val { return this.unary('ceil', a) }
  round(a: Operand): Val { return this.unary('round', a) }
  trunc(a: Operand): Val { return this.unary('trunc', a) }
  fract(a: Operand): Val { return this.unary('fract', a) }
  sqrt(a: Operand): Val { return this.unary('sqrt', a) }
  rsqrt(a: Operand): Val { return this.unary('rsqrt', a) }
  exp(a: Operand): Val { return this.unary('exp', a) }
  exp2(a: Operand): Val { return this.unary('exp2', a) }
  log(a: Operand): Val { return this.unary('log', a) }
  log2(a: Operand): Val { return this.unary('log2', a) }
  sin(a: Operand): Val { return this.unary('sin', a) }
  cos(a: Operand): Val { return this.unary('cos', a) }
  tan(a: Operand): Val { return this.unary('tan', a) }
  asin(a: Operand): Val { return this.unary('asin', a) }
  acos(a: Operand): Val { return this.unary('acos', a) }
  atan(a: Operand): Val { return this.unary('atan', a) }
  saturate(a: Operand): Val { return this.unary('saturate', a) }
  length(a: Operand): Val { return this.unary('length', a) }
  normalize(a: Operand): Val { return this.unary('normalize', a) }
  any(a: Operand): Val { return this.unary('any', a) }
  all(a: Operand): Val { return this.unary('all', a) }
  transpose(a: Operand): Val { return this.unary('transpose', a) }

  add(a: Operand, b: Operand): Val { return this.binary('add', a, b) }
  sub(a: Operand, b: Operand): Val { return this.binary('sub', a, b) }
  mul(a: Operand, b: Operand): Val { return this.binary('mul', a, b) }
  div(a: Operand, b: Operand): Val { return this.binary('div', a, b) }
  rem(a: Operand, b: Operand): Val { return this.binary('rem', a, b) }
  min(a: Operand, b: Operand): Val { return this.binary('min', a, b) }
  max(a: Operand, b: Operand): Val { return this.binary('max', a, b) }
  pow(a: Operand, b: Operand): Val { return this.binary('pow', a, b) }
  atan2(a: Operand, b: Operand): Val { return this.binary('atan2', a, b) }
  /** 0 where x < edge, else 1. */
  step(edge: Operand, x: Operand): Val { return this.binary('step', edge, x) }
  and(a: Operand, b: Operand): Val { return this.binary('and', a, b) }
  or(a: Operand, b: Operand): Val { return this.binary('or', a, b) }
  xor(a: Operand, b: Operand): Val { return this.binary('xor', a, b) }
  shl(a: Operand, count: Operand): Val { return this.binary('shl', a, count) }
  shr(a: Operand, count: Operand): Val { return this.binary('shr', a, count) }
  eq(a: Operand, b: Operand): Val { return this.binary('eq', a, b) }
  ne(a: Operand, b: Operand): Val { return this.binary('ne', a, b) }
  lt(a: Operand, b: Operand): Val { return this.binary('lt', a, b) }
  le(a: Operand, b: Operand): Val { return this.binary('le', a, b) }
  gt(a: Operand, b: Operand): Val { return this.binary('gt', a, b) }
  ge(a: Operand, b: Operand): Val { return this.binary('ge', a, b) }
  land(a: Operand, b: Operand): Val { return this.binary('land', a, b) }
  lor(a: Operand, b: Operand): Val { return this.binary('lor', a, b) }
  dot(a: Operand, b: Operand): Val { return this.binary('dot', a, b) }
  cross(a: Operand, b: Operand): Val { return this.binary('cross', a, b) }
  distance(a: Operand, b: Operand): Val { return this.binary('distance', a, b) }
  reflect(a: Operand, b: Operand): Val { return this.binary('reflect', a, b) }

  /** a (1 - t) + b t, each step rounded to f32, with t of the values' type or an f32. */
  mix(a: Operand, b: Operand, t: Operand): Val { return this.ternary('mix', a, b, t) }
  clamp(x: Operand, lo: Operand, hi: Operand): Val { return this.ternary('clamp', x, lo, hi) }
  smoothstep(lo: Operand, hi: Operand, x: Operand): Val { return this.ternary('smoothstep', lo, hi, x) }
  fma(a: Operand, b: Operand, c: Operand): Val { return this.ternary('fma', a, b, c) }
  /** `yes` where the condition holds, else `no`; a bool vector condition chooses lane by lane. */
  choose(cond: Operand, yes: Operand, no: Operand): Val { return this.ternary('choose', cond, yes, no) }

  // -------------------------------------------------------------------------------------------------
  // Vectors and grids

  /** A vector from scalars and vectors of its kind (or one scalar, repeated), or a grid from its columns or n x n scalars. */
  make(t: ValueType, ...parts: readonly Operand[]): Val {
    const no: Refuse = this.begin('make')
    if (!isValueType(t)) no(`${say(t)} is not a value type`)
    if (parts.length < 1 || parts.length > MAX_OPERANDS) no(`make takes 1 to ${MAX_OPERANDS} operands, not ${parts.length}`)
    const args = parts.map((p, i) => this.take(p, isGrid(t) ? 'f32' : scalarOf(t), `operand ${i}`, no))
    makeRule(t, args.map((v) => v.t), no)
    return this.def({ op: 'make', id: this.next(no), t, args: args.map((v) => v.id) }, no)
  }

  /** Numbers alone make one literal; anything else makes a `make`. */
  private vector(t: ValueType, parts: readonly Operand[]): Val {
    const plain = parts.every((p) => typeof p === 'number' || typeof p === 'boolean')
    const n = componentsOf(t)
    if (plain && (parts.length === n || (parts.length === 1 && isVector(t)))) return this.lit(t, ...(parts as (number | boolean)[]))
    return this.make(t, ...parts)
  }

  f32x2(...parts: readonly Operand[]): Val { return this.vector('f32x2', parts) }
  f32x3(...parts: readonly Operand[]): Val { return this.vector('f32x3', parts) }
  f32x4(...parts: readonly Operand[]): Val { return this.vector('f32x4', parts) }
  i32x2(...parts: readonly Operand[]): Val { return this.vector('i32x2', parts) }
  i32x3(...parts: readonly Operand[]): Val { return this.vector('i32x3', parts) }
  i32x4(...parts: readonly Operand[]): Val { return this.vector('i32x4', parts) }
  u32x2(...parts: readonly Operand[]): Val { return this.vector('u32x2', parts) }
  u32x3(...parts: readonly Operand[]): Val { return this.vector('u32x3', parts) }
  u32x4(...parts: readonly Operand[]): Val { return this.vector('u32x4', parts) }
  boolx2(...parts: readonly Operand[]): Val { return this.vector('boolx2', parts) }
  boolx3(...parts: readonly Operand[]): Val { return this.vector('boolx3', parts) }
  boolx4(...parts: readonly Operand[]): Val { return this.vector('boolx4', parts) }
  /** A grid from its columns, or from its scalars column by column. */
  m2(...parts: readonly Operand[]): Val { return this.vector('m2', parts) }
  m3(...parts: readonly Operand[]): Val { return this.vector('m3', parts) }
  m4(...parts: readonly Operand[]): Val { return this.vector('m4', parts) }

  /** Lanes of a vector, named by a string of x y z w (or r g b a) or listed by number: `b.pick(v, 'xy')`. */
  pick(v: Operand, lanes: string | readonly number[]): Val {
    const no: Refuse = this.begin('pick')
    const V = this.take(v, guess(v), 'the vector', no)
    const list: unknown[] = typeof lanes === 'string' ? [...lanes].map((ch) => {
      const at = LANE_NAMES.indexOf(ch)
      return at < 0 ? no(`${say(ch)} is not a lane name (x y z w, or r g b a)`) : at % 4
    }) : Array.isArray(lanes) ? (lanes as unknown[]).map(plain) : no('the lanes are a string such as "xyz" or a list of lane numbers')
    const t = pickType(V.t, list, no)
    return this.def({ op: 'pick', id: this.next(no), t, a: V.id, lanes: list as number[] }, no)
  }

  /** One lane of a vector, chosen by an i32 or u32 value (clamped into the vector). */
  lane(v: Operand, i: Operand): Val {
    const no: Refuse = this.begin('lane')
    const V = this.take(v, guess(v), 'the vector', no)
    const I = this.take(i, indexType(i), 'the index', no)
    const t = laneType(V.t, I.t, no)
    return this.def({ op: 'lane', id: this.next(no), t, a: V.id, i: I.id }, no)
  }

  /** A column of a grid, by a constant index. */
  column(g: Operand, i: number): Val {
    const no: Refuse = this.begin('column')
    const G = this.take(g, guess(g), 'the grid', no)
    const t = columnType(G.t, plain(i), no)
    return this.def({ op: 'column', id: this.next(no), t, a: G.id, i: plain(i) }, no)
  }

  /**
   * The value as another kind of the same width; `to` may name the kind alone (`b.cast(v, 'f32')`). A cast to the
   * type the value already has gives the value back and emits nothing.
   */
  cast(v: Operand, to: ValueType): Val {
    return this.convert('cast', v, to)
  }

  /** The same bits as another of f32, i32 and u32, of the same width. Like cast, the value's own type gives it back. */
  bits(v: Operand, to: ValueType): Val {
    return this.convert('bits', v, to)
  }

  private convert(op: 'cast' | 'bits', v: Operand, to: ValueType): Val {
    const no: Refuse = this.begin(op)
    if (!isValueType(to)) no(`${say(to)} is not a value type`)
    const V = this.take(v, guess(v), 'the operand', no)
    const t = isScalar(to) && isVector(V.t) ? vectorOf(to, widthOf(V.t)) : to
    if (t === V.t) return V
    if (op === 'cast') castRule(V.t, t, no)
    else bitsRule(V.t, t, no)
    return this.def({ op, id: this.next(no), t, a: V.id }, no)
  }

  // -------------------------------------------------------------------------------------------------
  // The stage interface

  private port(side: 'inputs' | 'outputs', slot: number, t: ValueType, opts: { readonly flat?: boolean } | undefined, no: Refuse): Port {
    const list = side === 'inputs' ? this.inputs : this.outputs
    const flat: unknown = (opts ?? {}).flat
    const between = (this.stage === 'vertex' && side === 'outputs') || (this.stage === 'fragment' && side === 'inputs')
    const integer = isValueType(t) && !isGrid(t) && (scalarOf(t) === 'i32' || scalarOf(t) === 'u32')
    const at = plain(slot)
    const port = flat !== undefined ? { slot: at, type: t, flat } : between && integer ? { slot: at, type: t, flat: true } : { slot: at, type: t }
    portRule(this.stage, side, port, no)
    if (list.some((p) => p.slot === at)) no(`slot ${at} is declared twice`)
    if (list.length >= LENS_LIMITS.ports) no(`a stage has at most ${LENS_LIMITS.ports} ${side}`)
    return Object.freeze(port)
  }

  /**
   * Declares an input port and reads it here. An integer passed from the vertex stage is flat without being asked;
   * pass `flat: true` to pass an f32 value without interpolation.
   */
  input(slot: number, t: ValueType, opts?: { readonly flat?: boolean }): Val {
    const no: Refuse = this.begin('in')
    const port = this.port('inputs', slot, t, opts, no)
    const v = this.def({ op: 'in', id: this.next(no), t: port.type, slot: port.slot }, no)
    this.inputs.push(port)
    return v
  }

  /** Reads a declared input again (where the value `input` gave has gone out of scope). */
  in(slot: number): Val {
    const no: Refuse = this.begin('in')
    const port = this.inputs.find((p) => p.slot === slot)
    if (port === undefined) no(`no input is declared at slot ${say(slot)}`)
    return this.def({ op: 'in', id: this.next(no), t: port.type, slot: port.slot }, no)
  }

  /** Declares an output port; write it with `out`. An integer passed to the fragment stage is flat without being asked. */
  output(slot: number, t: ValueType, opts?: { readonly flat?: boolean }): Out {
    const no: Refuse = (rule) => fail('lens', `lens: outputs[${this.outputs.length}] port: ${rule}`)
    if (this.done) no('the builder has finished its module')
    const port = this.port('outputs', slot, t, opts, no)
    this.outputs.push(port)
    const out: Out = Object.freeze({ slot: port.slot, t: port.type })
    this.outs.push(out)
    return out
  }

  out(port: Out, value: Operand): void {
    const no: Refuse = this.begin('out')
    if (!this.outs.includes(port)) no(`the port is not an output of this builder (${say(port)})`)
    const v = this.need(value, port.t, 'the value', [port.t], no)
    this.push({ op: 'out', slot: port.slot, a: v.id }, no)
  }

  /** The clip-space position of a vertex (vertex stage only). */
  position(value: Operand): void {
    const no: Refuse = this.begin('position')
    if (this.stage !== 'vertex') no('position is only in the vertex stage')
    const v = this.need(value, 'f32x4', 'the position', ['f32x4'], no)
    this.push({ op: 'position', a: v.id }, no)
  }

  builtin(name: Builtin): Val {
    const no: Refuse = this.begin('builtin')
    const t = builtinType(this.stage, name, no)
    return this.def({ op: 'builtin', id: this.next(no), t, name }, no)
  }

  // -------------------------------------------------------------------------------------------------
  // Resources

  private addResource<R extends Res>(r: Resource, handle: (res: number) => R): R {
    const index = this.resources.length
    const no: Refuse = (rule) => fail('lens', `lens: resources[${index}] ${r.kind}: ${rule}`)
    if (this.done) no('the builder has finished its module')
    if (index >= LENS_LIMITS.resources) no(`a module declares at most ${LENS_LIMITS.resources} resources`)
    resourceRule(r, no, this.budget, this.layouts)
    if (r.kind === 'constants') {
      if (this.resources.some((x) => x.kind === 'constants')) no('a module declares at most one constants resource')
    } else if (this.resources.some((x) => x.kind !== 'constants' && x.set === r.set && x.binding === r.binding)) {
      no(`set ${r.set} binding ${r.binding} is declared twice`)
    }
    this.resources.push(deepFreeze(r))
    const h = handle(index)
    Object.freeze(h)
    this.handles.push(h)
    return h
  }

  /** A uniform block at a set and binding. */
  uniform(set: number, binding: number, spec: BlockSpec | Block): BlockRes {
    const b = block(spec)
    return this.addResource({ kind: 'uniform', set: plain(set), binding: plain(binding), block: b }, (res) => ({ res, kind: 'uniform', block: b, writable: false }))
  }

  /** A storage block at a set and binding; read-only unless `writable`. Its last field may be `arrayOf(t)` (no length). */
  storage(set: number, binding: number, spec: BlockSpec | Block, opts?: { readonly writable?: boolean }): BlockRes {
    const b = block(spec)
    const writable = (opts ?? {}).writable ?? false
    return this.addResource({ kind: 'storage', set: plain(set), binding: plain(binding), block: b, writable }, (res) => ({ res, kind: 'storage', block: b, writable }))
  }

  /** The inline constants (at most one block, of at most LENS_LIMITS.constants bytes). */
  constants(spec: BlockSpec | Block): BlockRes {
    const b = block(spec)
    return this.addResource({ kind: 'constants', block: b }, (res) => ({ res, kind: 'constants', block: b, writable: false }))
  }

  /** A sampled image (default: float samples, 2d). */
  image(set: number, binding: number, opts?: { readonly sample?: SampleKind; readonly dims?: ImageDims }): ImageRes {
    const sample = (opts ?? {}).sample ?? 'float'
    const dims = (opts ?? {}).dims ?? '2d'
    return this.addResource({ kind: 'image', set: plain(set), binding: plain(binding), sample, dims }, (res) => ({ res, kind: 'image', sample, dims }))
  }

  sampler(set: number, binding: number): SamplerRes {
    return this.addResource({ kind: 'sampler', set: plain(set), binding: plain(binding) }, (res) => ({ res, kind: 'sampler' }))
  }

  storageImage(set: number, binding: number, format: Format): StorageImageRes {
    return this.addResource({ kind: 'storage-image', set: plain(set), binding: plain(binding), format }, (res) => ({ res, kind: 'storage-image', format }))
  }

  /**
   * Resolves a path: field names to indices, values to `{ at }` steps; walk() then finds the leaf, through the
   * builder's layouts, so a read or write does not lay its block out again.
   */
  private path(r: BlockRes, path: readonly unknown[], no: Refuse): { readonly steps: Step[]; readonly t: ValueType } {
    if (path.length > LENS_LIMITS.path) no(`a path has at most ${LENS_LIMITS.path} steps, not ${path.length}`)
    let at: DataType | undefined = { struct: r.block }
    const steps = path.map((s, n): Step => {
      let step: Step
      if (typeof s === 'string') {
        const fields = at !== undefined && typeof at !== 'string' && 'struct' in at ? at.struct.fields : no(`step ${n} names the field ${say(s)} where the path is not at a block`)
        const index = fields.findIndex((f) => f.name === s)
        if (index < 0) no(`step ${n}: the block has no field named ${say(s)}`)
        step = index
      } else if (typeof s === 'number') {
        if (!Number.isInteger(s) || s < 0 || s > MAX_INDEX) no(`step ${n} (${s}) is not a constant index from 0 to ${MAX_INDEX}`)
        step = s + 0
      } else {
        const v = this.need(s, 'u32', `step ${n}`, ['i32', 'u32'], no)
        step = Object.freeze({ at: v.id })
      }
      at = at === undefined || typeof at === 'string' ? undefined : 'array' in at ? at.array : typeof step === 'number' ? at.struct.fields[step]?.type : undefined
      return step
    })
    try {
      const space = r.kind === 'storage' ? 'storage' : 'uniform'
      return { steps, t: walk(r.block, space, steps, this.layouts[space]).type }
    } catch (e) {
      if (isFault(e)) no(e.message)
      throw e
    }
  }

  /** Reads a number type out of a uniform, storage or constants block: `b.read(lights, 'list', i, 'color')`. */
  read(res: BlockRes, ...path: readonly PathStep[]): Val {
    const no: Refuse = this.begin('read')
    const r = this.handle<BlockRes>(res, ['uniform', 'storage', 'constants'], 'the resource', no)
    const { steps, t } = this.path(r, path, no)
    return this.def({ op: 'read', id: this.next(no), t, res: r.res, path: steps }, no)
  }

  /** Writes a value into a writable storage block (fragment and compute): `b.write(buf, ['items', i], v)`. */
  write(res: BlockRes, path: PathStep | readonly PathStep[], value: Operand): void {
    const no: Refuse = this.begin('write')
    if (this.stage === 'vertex') no('the vertex stage never writes a resource')
    const r = this.handle<BlockRes>(res, ['storage'], 'the resource', no)
    if (!r.writable) no(`resource ${r.res} is not a writable storage block`)
    const { steps, t } = this.path(r, Array.isArray(path) ? path : [path], no)
    const v = this.need(value, t, 'the value', [t], no)
    this.push({ op: 'write', res: r.res, path: steps, a: v.id }, no)
  }

  private layer(img: ImageRes, layer: unknown, no: Refuse): { layer?: number } {
    if (img.dims === '2d-array' && layer === undefined) no('a 2d-array image is read at a layer')
    if (img.dims === '2d' && layer !== undefined) no('a 2d image has no layers')
    return layer === undefined ? {} : { layer: this.need(layer, indexType(layer), 'the layer', ['i32', 'u32'], no).id }
  }

  /**
   * Samples a float image through a sampler at uv. Without a level (fragment stage only, at the top level of the
   * body) the level comes from the screen-space rate of change of uv; `level` names it as an f32.
   */
  sample(image: ImageRes, sampler: SamplerRes, uv: Operand, opts?: { readonly layer?: Operand; readonly level?: Operand }): Val {
    const no: Refuse = this.begin('sample')
    const o = opts ?? {}
    if (o.level === undefined) this.rate('a sample without a level', no)
    const img = this.handle<ImageRes>(image, ['image'], 'the image', no)
    if (img.sample !== 'float') no(`resource ${img.res} is a ${img.sample} image; sample reads a float image`)
    const smp = this.handle<SamplerRes>(sampler, ['sampler'], 'the sampler', no)
    const UV = this.need(uv, 'f32x2', 'uv', ['f32x2'], no)
    const layer = this.layer(img, o.layer, no)
    const level = o.level === undefined ? {} : { level: this.need(o.level, 'f32', 'the level', ['f32'], no).id }
    return this.def({ op: 'sample', id: this.next(no), t: 'f32x4', image: img.res, sampler: smp.res, uv: UV.id, ...layer, ...level }, no)
  }

  /** One texel of an image at an integer position (level 0 unless given); zero outside the image. */
  texel(image: ImageRes, at: Operand, opts?: { readonly layer?: Operand; readonly level?: Operand }): Val {
    const no: Refuse = this.begin('texel')
    const o = opts ?? {}
    const img = this.handle<ImageRes>(image, ['image'], 'the image', no)
    const AT = this.need(at, vectorOf(indexType(at), 2), 'the position', ['i32x2', 'u32x2'], no)
    const layer = this.layer(img, o.layer, no)
    const level = this.need(o.level ?? 0, indexType(o.level), 'the level', ['i32', 'u32'], no)
    return this.def({ op: 'texel', id: this.next(no), t: texelType(img.sample), image: img.res, at: AT.id, ...layer, level: level.id }, no)
  }

  /** Writes a storage image at an integer position (fragment and compute); nothing outside the image. */
  put(image: StorageImageRes, at: Operand, value: Operand): void {
    const no: Refuse = this.begin('put')
    if (this.stage === 'vertex') no('put is only in the fragment and compute stages')
    const img = this.handle<StorageImageRes>(image, ['storage-image'], 'the image', no)
    const AT = this.need(at, vectorOf(indexType(at), 2), 'the position', ['i32x2', 'u32x2'], no)
    const want = putType(img.format)
    const v = this.need(value, want, 'the value', [want], no)
    this.push({ op: 'put', image: img.res, at: AT.id, a: v.id }, no)
  }

  /** The width and height of an image (of a level, 0 unless given) or of a storage image (which takes no level). */
  extent(image: ImageRes | StorageImageRes, level?: Operand): Val {
    const no: Refuse = this.begin('extent')
    const img = this.handle<ImageRes | StorageImageRes>(image, ['image', 'storage-image'], 'the image', no)
    if (img.kind === 'storage-image') {
      if (level !== undefined) no('a storage image has one level; its extent takes no level')
      return this.def({ op: 'extent', id: this.next(no), t: 'u32x2', image: img.res }, no)
    }
    const L = this.need(level ?? 0, indexType(level), 'the level', ['i32', 'u32'], no)
    return this.def({ op: 'extent', id: this.next(no), t: 'u32x2', image: img.res, level: L.id }, no)
  }

  /** The screen-space rate of change of an f32 value (fragment stage only, at the top level of the body). */
  deriv(fn: DerivativeFn, a: Operand): Val {
    const no: Refuse = this.begin('deriv')
    this.rate('deriv', no)
    if (!DERIVATIVES.includes(fn)) no(`${say(fn)} is not a derivative (dx, dy or width)`)
    const A = this.need(a, 'f32', 'the operand', ['f32', 'f32x2', 'f32x3', 'f32x4'], no)
    return this.def({ op: 'deriv', id: this.next(no), t: A.t, fn, a: A.id }, no)
  }

  dx(a: Operand): Val { return this.deriv('dx', a) }
  dy(a: Operand): Val { return this.deriv('dy', a) }

  // -------------------------------------------------------------------------------------------------
  // Variables and control

  /** A variable of a value type, zero unless given an initial value. */
  var(t: ValueType, init?: Operand): Var {
    const no: Refuse = this.begin('var')
    if (!isValueType(t)) no(`${say(t)} is not a value type`)
    const I = init === undefined ? undefined : this.need(init, t, 'the initial value', [t], no)
    const id = this.next(no)
    this.push(I === undefined ? { op: 'var', id, t } : { op: 'var', id, t, init: I.id }, no)
    return this.keep(Object.freeze({ id, t, variable: true as const }))
  }

  private variable(x: unknown, no: Refuse): Var {
    const id = isObj(x) ? x.id : undefined
    const known = typeof id === 'number' ? this.values[id] : undefined
    if (known === undefined || known !== x || !('variable' in known)) no(`the variable is not a variable of this builder (${say(x)})`)
    if (!this.live[known.id]) no(`the variable %${known.id} was made inside a block that has ended`)
    return known as Var
  }

  get(v: Var): Val {
    const no: Refuse = this.begin('get')
    const V = this.variable(v, no)
    return this.def({ op: 'get', id: this.next(no), t: V.t, v: V.id }, no)
  }

  set(v: Var, value: Operand): void {
    const no: Refuse = this.begin('set')
    const V = this.variable(v, no)
    const a = this.need(value, V.t, 'the value', [V.t], no)
    this.push({ op: 'set', v: V.id, a: a.id }, no)
  }

  private deeper(no: Refuse): void {
    if (this.frames.length > LENS_LIMITS.depth) no(`if and loop nest at most ${LENS_LIMITS.depth} deep`)
  }

  /** Runs `then` when the condition holds, else `otherwise`; each callback writes its branch. */
  if(cond: Operand, then: () => void, otherwise?: () => void): void {
    const no: Refuse = this.begin('if')
    if (typeof then !== 'function' || (otherwise !== undefined && typeof otherwise !== 'function')) no('each branch is a function that writes its instructions')
    const c = this.need(cond, 'bool', 'the condition', ['bool'], no)
    this.deeper(no)
    const where = this.place()
    const yes: Inst[] = []
    const els: Inst[] = []
    const loop = this.top().loop
    this.push({ op: 'if', c: c.id, then: yes, else: els }, no)
    this.nest(yes, `${where}.then`, loop, then)
    if (otherwise !== undefined) this.nest(els, `${where}.else`, loop, otherwise)
  }

  /** Runs the body until a break (or 65,536 iterations); the callback writes the body. */
  loop(body: () => void): void {
    const no: Refuse = this.begin('loop')
    if (typeof body !== 'function') no('the body is a function that writes its instructions')
    this.deeper(no)
    const where = this.place()
    const insts: Inst[] = []
    this.push({ op: 'loop', body: insts }, no)
    this.nest(insts, `${where}.body`, true, body)
  }

  break(): void {
    this.leave('break')
  }

  continue(): void {
    this.leave('continue')
  }

  private leave(op: 'break' | 'continue'): void {
    const no: Refuse = this.begin(op)
    if (!this.top().loop) no(`${op} is only inside a loop`)
    this.push({ op }, no)
    this.top().ended = op
  }

  /** Makes the invocation a helper that writes nothing (fragment stage only). */
  discard(): void {
    const no: Refuse = this.begin('discard')
    if (this.stage !== 'fragment') no('discard is only in the fragment stage')
    this.push({ op: 'discard' }, no)
  }

  /** Ends the invocation. */
  return(): void {
    const no: Refuse = this.begin('return')
    this.push({ op: 'return' }, no)
    this.top().ended = 'return'
    this.returned = true
  }

  /**
   * The finished module, deep-frozen and checked by verify(), and refused (Fault `lens`) when its binary form would
   * take more than LENS_LIMITS.words words, as createLens would refuse it. A builder makes one module.
   */
  finish(): LensModule {
    const no: Refuse = (rule) => fail('lens', `lens: finish: ${rule}`)
    if (this.done) no('the builder has already finished its module')
    if (this.frames.length !== 1) no('finish is called outside every if and loop')
    this.done = true
    const m: LensModule = deepFreeze({
      stage: this.stage,
      group: this.group,
      inputs: this.inputs,
      outputs: this.outputs,
      resources: this.resources,
      body: this.body,
      ids: this.values.length,
    })
    verify(m)
    try {
      encode(m)
    } catch (e) {
      if (isFault(e, 'lens')) no(`the binary form cannot carry the module (${e.message})`)
      throw e
    }
    return m
  }
}

/**
 * The type a number standing in for a binary operand takes, from the other operand's type: the scalar of its kind
 * for arithmetic (which broadcasts), a u32 count of its width for shifts, and its own type for everything else.
 */
function hintFor(fn: BinaryFn, other: ValueType): ValueType {
  switch (fn) {
    case 'add': case 'sub': case 'mul': case 'div': case 'rem': return isGrid(other) ? 'f32' : scalarOf(other)
    case 'shl': case 'shr': return vectorOf('u32', widthOf(other))
    default: return other
  }
}

/** A builder for one module of a stage; a compute stage gives its workgroup size (default [1, 1, 1]). */
export function lens(stage: Stage, opts?: { readonly group?: readonly [number, number, number] }): LensBuilder {
  return new LensBuilder(stage, (opts ?? {}).group ?? [1, 1, 1])
}
