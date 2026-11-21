// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the checker every Lens module passes before a back end sees it. A module built by
 * the builder, decoded from words, or written by hand is held to every rule of the form: the structure of its ids
 * (each defined once, used only after, inside its block or a nested one; variables only through var, get and set),
 * the type of every instruction by the specification's table, the rules of its stage, its resources and their byte
 * layouts, its ports, its control flow, and the bounds of LENS_LIMITS (but for the words of the binary form, which
 * encode holds, and so createLens and the builder's finish()). It refuses -0 wherever it reads a whole number (an
 * id, an index, a set or binding, a slot, a path step, a lane, a column, a length), so the binary form, which cannot
 * tell -0 from 0 in a word, keeps every module it accepts exactly. A module it accepts can be run by the reference
 * renderer and lowered to WGSL with neither of them checking again. A module it refuses is refused with a Fault of
 * code `lens` whose message names the place (`lens: body[3].then[0] binary: ...`) and the rule. The typing rules are
 * exported, so the builder infers result types and refuses a mistake by the very same table.
 * What breaks if it is removed? A malformed or ill-typed shader would reach the back ends: the reference renderer
 * would run something the form never defined, and the GPU back end would hand the browser WGSL that it refuses.
 *
 * One bound is the checker's own rather than the form's: the fields of a module's blocks, counted every time they are
 * reached. Plain data may share one block object under many fields, which could stand for a tree far larger than any
 * memory; the bound keeps a hostile module from making a check run for minutes. No shader a person or the builder
 * writes comes near it. Within one check each block object is laid out once in each space (one LayoutCache per
 * space, shared by the resources and every path of `read` and `write`), so a path costs its steps, not the size of
 * the blocks it passes through, however many distinct paths a module holds.
 */
import { fail, isFault } from './fault.ts'
import { FORMATS, isFormat, sampleKind } from './formats.ts'
import type { Format } from './formats.ts'
import {
  BINARY, BUILTINS, DERIVATIVES, IMAGE_DIMS, LENS_LIMITS, RESOURCE_KINDS, SAMPLE_KINDS, STAGES, TERNARY, UNARY,
  boolOf, columnOf, componentsOf, isGrid, isScalar, isValueType, isVector, layoutBlock, scalarOf, strideOf, vectorOf, walk, widthOf,
} from './lens.ts'
import type {
  BinaryFn, Block, BlockLayout, DataType, ImageDims, LayoutCache, LensModule, Op, Port, Resource, ResourceKind, SampleKind, Space,
  Stage, Step, TernaryFn, UnaryFn, ValueType, Width,
} from './lens.ts'

/** Raises the refusal of one rule. The caller has already said where: the message reads `lens: <place> <op>: <rule>`. */
export type Refuse = (rule: string) => never

/** The largest constant index a path may hold: the binary form keeps the top bit of a step to mark a value-held one. */
export const MAX_INDEX = 0x7fffffff
/** The most operands a `make` takes: the sixteen scalars of an m4. */
export const MAX_OPERANDS = 16
/** A block field's name: a letter or `_`, then up to 31 letters, digits or `_`. */
export const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/


/** The fields of a module; every one is required. */
export const MODULE_FIELDS: readonly string[] = Object.freeze(['stage', 'group', 'inputs', 'outputs', 'resources', 'body', 'ids'])

/** The fields of each kind of resource; every one is required. */
export const RESOURCE_FIELDS: { readonly [K in ResourceKind]: readonly string[] } = Object.freeze({
  uniform: ['kind', 'set', 'binding', 'block'],
  storage: ['kind', 'set', 'binding', 'block', 'writable'],
  constants: ['kind', 'block'],
  image: ['kind', 'set', 'binding', 'sample', 'dims'],
  sampler: ['kind', 'set', 'binding'],
  'storage-image': ['kind', 'set', 'binding', 'format'],
})

/** The fields of each instruction: those it must have, then those it may have. Nothing else may sit on one. */
export const INST_FIELDS: { readonly [K in Op]: readonly [readonly string[], readonly string[]] } = Object.freeze({
  lit: [['op', 'id', 't', 'v'], []],
  unary: [['op', 'id', 't', 'fn', 'a'], []],
  binary: [['op', 'id', 't', 'fn', 'a', 'b'], []],
  ternary: [['op', 'id', 't', 'fn', 'a', 'b', 'c'], []],
  make: [['op', 'id', 't', 'args'], []],
  pick: [['op', 'id', 't', 'a', 'lanes'], []],
  lane: [['op', 'id', 't', 'a', 'i'], []],
  column: [['op', 'id', 't', 'a', 'i'], []],
  cast: [['op', 'id', 't', 'a'], []],
  bits: [['op', 'id', 't', 'a'], []],
  in: [['op', 'id', 't', 'slot'], []],
  builtin: [['op', 'id', 't', 'name'], []],
  out: [['op', 'slot', 'a'], []],
  position: [['op', 'a'], []],
  read: [['op', 'id', 't', 'res', 'path'], []],
  write: [['op', 'res', 'path', 'a'], []],
  sample: [['op', 'id', 't', 'image', 'sampler', 'uv'], ['layer', 'level']],
  texel: [['op', 'id', 't', 'image', 'at', 'level'], ['layer']],
  put: [['op', 'image', 'at', 'a'], []],
  extent: [['op', 'id', 't', 'image'], ['level']],
  deriv: [['op', 'id', 't', 'fn', 'a'], []],
  var: [['op', 'id', 't'], ['init']],
  get: [['op', 'id', 't', 'v'], []],
  set: [['op', 'v', 'a'], []],
  if: [['op', 'c', 'then', 'else'], []],
  loop: [['op', 'body'], []],
  break: [['op'], []],
  continue: [['op'], []],
  discard: [['op'], []],
  return: [['op'], []],
})

/** The checker's own bound (see the head of the file). */
const FIELD_BUDGET = LENS_LIMITS.blockFields

/** The block layouts one check has made, one cache per space (see LayoutCache). */
export type Layouts = { readonly [S in Space]: LayoutCache }

type Obj = { readonly [key: string]: unknown }
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const isIndex = (x: unknown, below: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < below && !Object.is(x, -0)
const isOneOf = <T>(list: readonly T[], x: unknown): x is T => (list as readonly unknown[]).includes(x)

/** A value as it reads in a message: short, and safe to print whatever a caller passed. */
export function say(x: unknown): string {
  if (typeof x === 'string') return JSON.stringify(x.length > 40 ? `${x.slice(0, 40)}...` : x)
  if (typeof x === 'number') return Object.is(x, -0) ? '-0' : String(x)
  if (typeof x === 'boolean' || x === null || x === undefined) return String(x)
  if (Array.isArray(x)) return 'a list'
  return typeof x === 'object' ? 'an object' : `a ${typeof x}`
}

/** Refuses an object that lacks a required field, holds one it may not have, or holds an optional one as undefined. */
export function shapeRule(o: object, required: readonly string[], optional: readonly string[], no: Refuse): void {
  const rec = o as Obj
  for (const k of required) if (!Object.hasOwn(rec, k) || rec[k] === undefined) no(`it needs a field ${k}`)
  for (const k of Object.keys(rec)) {
    if (required.includes(k)) continue
    if (!optional.includes(k)) no(`it has no field ${say(k)}`)
    if (rec[k] === undefined) no(`its field ${k} is undefined (leave an absent field out)`)
  }
}

// ---------------------------------------------------------------------------------------------------
// The typing table

const numeric = (t: ValueType): boolean => !isGrid(t) && scalarOf(t) !== 'bool'
const floaty = (t: ValueType): boolean => !isGrid(t) && scalarOf(t) === 'f32'
const integer = (t: ValueType): boolean => !isGrid(t) && (scalarOf(t) === 'i32' || scalarOf(t) === 'u32')
const signed = (t: ValueType): boolean => !isGrid(t) && (scalarOf(t) === 'f32' || scalarOf(t) === 'i32')
const boolish = (t: ValueType): boolean => scalarOf(t) === 'bool'

/**
 * Refuses a literal whose components do not fit its type: one component per scalar of the type, each a number; f32
 * components finite and exact in binary32; i32 and u32 components whole and in range; bools 0 or 1. Integer and bool
 * components are never -0, so the binary form, which cannot tell -0 from 0 in an integer word, keeps them exactly.
 */
export function literalRule(t: ValueType, v: readonly unknown[], no: Refuse): void {
  const n = componentsOf(t)
  if (v.length !== n) no(`a ${t} literal has ${n} component${n === 1 ? '' : 's'}, not ${v.length}`)
  const k = scalarOf(t)
  for (let i = 0; i < n; i++) {
    const x = v[i]
    const bad = (why: string): never => no(`component ${i} (${say(x)}) ${why}`)
    if (typeof x !== 'number') return bad('is not a number')
    if (k === 'f32') {
      if (!Number.isFinite(x) || Math.fround(x) !== x) bad('is not a finite number exact in f32')
    } else if (Object.is(x, -0) || !Number.isInteger(x)) {
      bad(`is not a whole ${k === 'bool' ? '0 or 1' : 'number'} (and not -0)`)
    } else if (k === 'bool' ? x !== 0 && x !== 1 : k === 'i32' ? x < -0x80000000 || x > 0x7fffffff : x < 0 || x > 0xffffffff) {
      bad(`is outside the range of ${k}`)
    }
  }
}

/** The result type of a unary function, or a refusal naming what the function takes. */
export function unaryType(fn: UnaryFn, a: ValueType, no: Refuse): ValueType {
  const needs = (ok: boolean, takes: string): void => {
    if (!ok) no(`${fn} takes ${takes}, not ${a}`)
  }
  switch (fn) {
    case 'neg': case 'sign': needs(signed(a), 'an f32 or i32 scalar or vector'); return a
    case 'not': needs(boolish(a), 'a bool or bool vector'); return a
    case 'bitnot': needs(integer(a), 'an i32 or u32 scalar or vector'); return a
    case 'abs': needs(numeric(a), 'an f32, i32 or u32 scalar or vector'); return a
    case 'length': needs(floaty(a), 'an f32 scalar or vector'); return 'f32'
    case 'normalize': needs(floaty(a) && isVector(a), 'an f32 vector'); return a
    case 'any': case 'all': needs(boolish(a), 'a bool or bool vector'); return 'bool'
    case 'transpose': needs(isGrid(a), 'a grid (m2, m3 or m4)'); return a
    case 'floor': case 'ceil': case 'round': case 'trunc': case 'fract': case 'sqrt': case 'rsqrt': case 'exp': case 'exp2': case 'log':
    case 'log2': case 'sin': case 'cos': case 'tan': case 'asin': case 'acos': case 'atan': case 'saturate':
      needs(floaty(a), 'an f32 scalar or vector'); return a
    default: return no(`${say(fn)} is not a unary function`)
  }
}

const ARITHMETIC_TAKES: { readonly [fn: string]: string } = {
  add: 'two numbers of one type, a vector and a scalar of its kind, or two grids of one size',
  sub: 'two numbers of one type, a vector and a scalar of its kind, or two grids of one size',
  mul: 'two numbers of one type, a vector and a scalar of its kind, two grids of one size, a grid and its column vector, a row vector and a grid, or a grid and then an f32',
  div: 'two numbers of one type, or a vector and a scalar of its kind',
  rem: 'two numbers of one type, or a vector and a scalar of its kind',
}

/** The result type of a binary function, or a refusal naming what the function takes. */
export function binaryType(fn: BinaryFn, a: ValueType, b: ValueType, no: Refuse): ValueType {
  const same = a === b
  const needs = (ok: boolean, takes: string): void => {
    if (!ok) no(`${fn} takes ${takes}, not ${a} and ${b}`)
  }
  switch (fn) {
    case 'add': case 'sub': case 'mul': case 'div': case 'rem': {
      if (numeric(a) && numeric(b) && scalarOf(a) === scalarOf(b)) {
        if (same || (isVector(a) && isScalar(b))) return a
        if (isScalar(a) && isVector(b)) return b
      }
      if ((fn === 'add' || fn === 'sub') && isGrid(a) && same) return a
      if (fn === 'mul' && isGrid(a) && (same || b === 'f32')) return a
      if (fn === 'mul' && isGrid(a) && b === columnOf(a)) return b
      if (fn === 'mul' && isGrid(b) && a === columnOf(b)) return a
      return no(`${fn} takes ${ARITHMETIC_TAKES[fn]}, not ${a} and ${b}`)
    }
    case 'min': case 'max': needs(numeric(a) && same, 'two numbers of one type'); return a
    case 'pow': case 'atan2': case 'step': needs(floaty(a) && same, 'two f32 values of one type'); return a
    case 'and': case 'or': case 'xor': needs((integer(a) || (boolish(a) && !isGrid(a))) && same, 'two integers or two bools of one type'); return a
    case 'shl': case 'shr': needs(integer(a) && b === vectorOf('u32', widthOf(a)), 'an integer and then a u32 count of the same width'); return a
    case 'eq': case 'ne': needs(!isGrid(a) && same, 'two scalars or vectors of one type'); return boolOf(a)
    case 'lt': case 'le': case 'gt': case 'ge': needs(numeric(a) && same, 'two numbers of one type'); return boolOf(a)
    case 'land': case 'lor': needs(boolish(a) && same, 'two bools of one type'); return a
    case 'dot': needs(numeric(a) && isVector(a) && same, 'two number vectors of one type'); return scalarOf(a)
    case 'cross': needs(a === 'f32x3' && same, 'two f32x3'); return a
    case 'distance': needs(floaty(a) && same, 'two f32 values of one type'); return 'f32'
    case 'reflect': needs(floaty(a) && isVector(a) && same, 'two f32 vectors of one type'); return a
    default: return no(`${say(fn)} is not a binary function`)
  }
}

/** The result type of a ternary function, or a refusal naming what the function takes. */
export function ternaryType(fn: TernaryFn, a: ValueType, b: ValueType, c: ValueType, no: Refuse): ValueType {
  const needs = (ok: boolean, takes: string): void => {
    if (!ok) no(`${fn} takes ${takes}, not ${a}, ${b} and ${c}`)
  }
  switch (fn) {
    case 'mix': needs(floaty(a) && b === a && (c === a || c === 'f32'), 'two f32 values of one type and a factor of that type or f32'); return a
    case 'clamp': needs(numeric(a) && b === a && c === a, 'three numbers of one type'); return a
    case 'smoothstep': case 'fma': needs(floaty(a) && b === a && c === a, 'three f32 values of one type'); return a
    case 'choose': needs(b === c && (a === 'bool' || (isVector(b) && a === boolOf(b))), 'a bool (or bools of the values\' width) and two values of one type'); return b
    default: return no(`${say(fn)} is not a ternary function`)
  }
}

/** Refuses a `make` whose operands do not build its type. */
export function makeRule(t: ValueType, args: readonly ValueType[], no: Refuse): void {
  const got = args.length === 0 ? 'nothing' : args.join(' ')
  if (isGrid(t)) {
    const n = widthOf(t)
    const col = columnOf(t)
    if (args.length === n && args.every((x) => x === col)) return
    if (args.length === n * n && args.every((x) => x === 'f32')) return
    no(`a ${t} is made of ${n} ${col} columns or ${n * n} f32 scalars, not ${got}`)
  }
  if (!isVector(t)) no(`make builds a vector or a grid, not ${t}`)
  const k = scalarOf(t)
  for (const x of args) if (isGrid(x) || scalarOf(x) !== k) no(`a ${t} is made of ${k} scalars and vectors, not ${got}`)
  if (args.length === 1 && isScalar(args[0])) return
  const sum = args.reduce((s, x) => s + widthOf(x), 0)
  if (sum !== widthOf(t)) no(`the components of ${got} add up to ${sum}, not the ${widthOf(t)} of a ${t} (or give one scalar to repeat)`)
}

/** The type `pick` gives: the scalar or vector of the lanes it names. */
export function pickType(a: ValueType, lanes: unknown, no: Refuse): ValueType {
  if (!isVector(a)) no(`pick takes a vector, not ${a}`)
  if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 4) no('pick takes a list of 1 to 4 lanes')
  for (const l of lanes as unknown[]) if (!isIndex(l, widthOf(a))) no(`${say(l)} is not a lane of a ${a}`)
  return vectorOf(scalarOf(a), (lanes as unknown[]).length as 1 | Width)
}

/** The type `lane` gives: one lane of a vector, picked by an i32 or u32 value. */
export function laneType(a: ValueType, i: ValueType, no: Refuse): ValueType {
  if (!isVector(a)) no(`lane takes a vector, not ${a}`)
  if (i !== 'i32' && i !== 'u32') no(`the lane index is an i32 or u32 scalar, not ${i}`)
  return scalarOf(a)
}

/** The type `column` gives: a grid's column, picked by a constant index. */
export function columnType(a: ValueType, i: unknown, no: Refuse): ValueType {
  if (!isGrid(a)) no(`column takes a grid, not ${a}`)
  if (!isIndex(i, widthOf(a))) no(`${say(i)} is not a column of an ${a}`)
  return columnOf(a)
}

/** Refuses a `cast` that is not to the same width of another kind. */
export function castRule(a: ValueType, t: ValueType, no: Refuse): void {
  if (isGrid(a) || isGrid(t)) no(`cast takes numbers and bools, or vectors of them, not ${a} to ${t}`)
  if (widthOf(a) !== widthOf(t)) no(`a cast keeps the width; ${a} cannot become ${t}`)
  if (scalarOf(a) === scalarOf(t)) no(`a cast changes the kind; ${a} is already ${t}`)
}

/** Refuses a `bits` that is not the same width of another of f32, i32 and u32. */
export function bitsRule(a: ValueType, t: ValueType, no: Refuse): void {
  if (!numeric(a) || !numeric(t)) no(`bits reinterprets f32, i32 and u32 values, not ${a} as ${t}`)
  if (widthOf(a) !== widthOf(t)) no(`bits keeps the width; ${a} cannot become ${t}`)
  if (scalarOf(a) === scalarOf(t)) no(`bits changes the kind; ${a} is already ${t}`)
}

/** The type of a builtin, refused outside its stage. */
export function builtinType(stage: Stage, name: unknown, no: Refuse): ValueType {
  if (typeof name !== 'string' || !Object.hasOwn(BUILTINS, name)) no(`${say(name)} is not a builtin`)
  const b = BUILTINS[name as keyof typeof BUILTINS]
  if (b.stage !== stage) no(`${name} is a builtin of the ${b.stage} stage, not of the ${stage} stage`)
  return b.type
}

/** What `texel` gives for an image of a sample kind. */
export function texelType(sample: SampleKind): ValueType {
  return sample === 'depth' ? 'f32' : sample === 'uint' ? 'u32x4' : sample === 'sint' ? 'i32x4' : 'f32x4'
}

/** The value `put` writes into a storage image of a format: its kind's x4. */
export function putType(format: Format): ValueType {
  const k = sampleKind(format)
  return k === 'uint' ? 'u32x4' : k === 'sint' ? 'i32x4' : 'f32x4'
}

// ---------------------------------------------------------------------------------------------------
// The module's interface: group, ports and resources

/** Refuses a workgroup size: a compute stage's within LENS_LIMITS, any other stage's exactly [1, 1, 1]. */
export function groupRule(stage: Stage, group: unknown, no: Refuse): void {
  if (!Array.isArray(group) || group.length !== 3) no('the group is a list of three sizes')
  const [x, y, z] = group as unknown[]
  if (stage !== 'compute') {
    if (x !== 1 || y !== 1 || z !== 1) no(`a ${stage} stage has the group [1, 1, 1]`)
    return
  }
  for (const n of [x, y, z]) if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) no(`a group size is a whole number of at least 1, not ${say(n)}`)
  const [gx, gy, gz] = group as number[]
  if (gx > LENS_LIMITS.groupXY || gy > LENS_LIMITS.groupXY) no(`the group is at most ${LENS_LIMITS.groupXY} along x and y`)
  if (gz > LENS_LIMITS.groupZ) no(`the group is at most ${LENS_LIMITS.groupZ} along z`)
  if (gx * gy * gz > LENS_LIMITS.invocations) no(`the group holds ${gx * gy * gz} invocations; the limit is ${LENS_LIMITS.invocations}`)
}

/**
 * Refuses one port: a slot below LENS_LIMITS.slots, a number type (no grid, no bool), and `flat` exactly where it
 * means something. Integers passed from the vertex stage to the fragment stage must be flat (they are never
 * interpolated); a vertex input and a fragment output are not passed between stages, so they are never flat.
 */
export function portRule(stage: Stage, side: 'inputs' | 'outputs', p: unknown, no: Refuse): asserts p is Port {
  if (stage === 'compute') no('a compute stage has no ports')
  if (!isObj(p)) no('a port is an object')
  shapeRule(p, ['slot', 'type'], ['flat'], no)
  const { slot, type, flat } = p
  if (!isIndex(slot, LENS_LIMITS.slots)) no(`slot ${say(slot)} is not a whole number below ${LENS_LIMITS.slots}`)
  if (!isValueType(type)) no(`${say(type)} is not a value type`)
  if (isGrid(type) || boolish(type)) no(`a port carries numbers or number vectors, not ${type}`)
  if (flat !== undefined && typeof flat !== 'boolean') no('flat is true or false')
  const between = (stage === 'vertex' && side === 'outputs') || (stage === 'fragment' && side === 'inputs')
  if (between && integer(type) && flat !== true) no(`${type} values passed between stages are flat (integers are never interpolated)`)
  if (!between && flat === true) no(`a ${stage} ${side === 'inputs' ? 'input' : 'output'} is not passed between stages, so it is not flat`)
}

/** Refuses the structure of one block: 1 to LENS_LIMITS.fields fields, each named once, each of a block type. */
function blockRule(b: unknown, space: Space, storageTop: boolean, where: string, level: number, budget: { left: number }, cache: LayoutCache, no: Refuse): void {
  const name = where === '' ? 'the block' : `field ${where}`
  if (!isObj(b)) no(`${name} is not a block`)
  shapeRule(b, ['fields'], [], (rule) => no(`${name}: ${rule}`))
  const fields = b.fields
  if (!Array.isArray(fields)) no(`${name}: the fields are a list`)
  if (fields.length < 1 || fields.length > LENS_LIMITS.fields) no(`${name} holds ${fields.length} fields; a block holds 1 to ${LENS_LIMITS.fields}`)
  budget.left -= fields.length
  if (budget.left < 0) no(`the module's blocks hold more than ${FIELD_BUDGET} fields in all`)
  const names = new Set<string>()
  for (let i = 0; i < fields.length; i++) {
    const f: unknown = fields[i]
    const at = where === '' ? `${i}` : `${where}.${i}`
    if (!isObj(f)) no(`field ${at} is not an object`)
    shapeRule(f, ['name', 'type'], [], (rule) => no(`field ${at}: ${rule}`))
    const fname = f.name
    if (typeof fname !== 'string' || !FIELD_NAME.test(fname)) no(`field ${at}: ${say(fname)} is not a field name (a letter or _, then up to 31 letters, digits or _)`)
    if (names.has(fname)) no(`field ${at}: the name ${fname} is used twice in its block`)
    names.add(fname)
    typeRule(f.type, space, storageTop && i === fields.length - 1, where === '' ? fname : `${where}.${fname}`, level, budget, cache, no)
  }
}

/**
 * Refuses one field's type. A field of the top block sits at level 0; each array or nested block puts what it holds
 * one level deeper, and nothing sits deeper than LENS_LIMITS.nesting. Arrays in the uniform space need a stride
 * that is a multiple of 16 at every depth (layoutBlock holds the same rule; this says where the array sits).
 */
function typeRule(t: unknown, space: Space, runtimeOk: boolean, where: string, level: number, budget: { left: number }, cache: LayoutCache, no: Refuse): void {
  if (typeof t === 'string') {
    if (!isValueType(t) || boolish(t)) no(`field ${where}: ${say(t)} is not a number type (a block holds no bools)`)
    return
  }
  if (!isObj(t) || (!Object.hasOwn(t, 'array') && !Object.hasOwn(t, 'struct'))) no(`field ${where}: its type is a number type, an array or a nested block`)
  if (level >= LENS_LIMITS.nesting) no(`field ${where}: blocks and arrays nest at most ${LENS_LIMITS.nesting} deep`)
  if (Object.hasOwn(t, 'struct')) {
    shapeRule(t, ['struct'], [], (rule) => no(`field ${where}: ${rule}`))
    blockRule(t.struct, space, false, where, level + 1, budget, cache, no)
    return
  }
  shapeRule(t, ['array', 'len'], [], (rule) => no(`field ${where}: ${rule}`))
  const len = t.len
  if (typeof len !== 'number' || !Number.isInteger(len) || len < 0 || len > LENS_LIMITS.elements || Object.is(len, -0)) no(`field ${where}: an array holds 0 to ${LENS_LIMITS.elements} elements, not ${say(len)}`)
  if (len === 0 && !runtimeOk) no(`field ${where}: an array without a length is only the last field of a storage block`)
  typeRule(t.array, space, false, `${where}[]`, level + 1, budget, cache, no)
  if (space === 'uniform' && laidOut(() => strideOf(t.array as DataType, space, cache), no) % 16 !== 0) no(`field ${where}: an array in a uniform block needs elements 16 bytes apart (use f32x4, i32x4 or u32x4 elements)`)
}

/** Runs a layout function of lens.ts, carrying its refusal under the caller's place. */
function laidOut<T>(f: () => T, no: Refuse): T {
  try {
    return f()
  } catch (e) {
    if (isFault(e)) no(e.message)
    throw e
  }
}

/**
 * Refuses one resource on its own (the module checks that set and binding pairs are unique and that there is at
 * most one constants block): its fields, its set and binding, its block's structure and layout in its space (uniform
 * for uniform blocks and constants, storage for storage blocks), the size of constants, and its image kind or format.
 * `budget` counts block fields across a module, and `layouts` keeps the block layouts made, by space.
 */
export function resourceRule(r: unknown, no: Refuse, budget: { left: number } = { left: FIELD_BUDGET }, layouts: Layouts = { uniform: new WeakMap(), storage: new WeakMap() }): asserts r is Resource {
  if (!isObj(r)) no('a resource is an object')
  const kind = r.kind
  if (!isOneOf(RESOURCE_KINDS, kind)) no(`${say(kind)} is not a kind of resource`)
  shapeRule(r, RESOURCE_FIELDS[kind], [], no)
  if (kind !== 'constants') {
    if (!isIndex(r.set, LENS_LIMITS.sets)) no(`set ${say(r.set)} is not a whole number below ${LENS_LIMITS.sets}`)
    if (!isIndex(r.binding, LENS_LIMITS.bindings)) no(`binding ${say(r.binding)} is not a whole number below ${LENS_LIMITS.bindings}`)
  }
  if (kind === 'uniform' || kind === 'storage' || kind === 'constants') {
    const space: Space = kind === 'storage' ? 'storage' : 'uniform'
    blockRule(r.block, space, kind === 'storage', '', 0, budget, layouts[space], no)
    const layout: BlockLayout = laidOut(() => layoutBlock(r.block as Block, space, layouts[space]), no)
    if (kind === 'constants' && layout.size > LENS_LIMITS.constants) no(`the constants block takes ${layout.size} bytes; the limit is ${LENS_LIMITS.constants}`)
  }
  if (kind === 'storage' && typeof r.writable !== 'boolean') no('writable is true or false')
  if (kind === 'image') {
    if (!isOneOf(SAMPLE_KINDS, r.sample)) no(`${say(r.sample)} is not a sample kind (float, uint, sint or depth)`)
    if (!isOneOf(IMAGE_DIMS, r.dims)) no(`${say(r.dims)} is not an image shape (2d or 2d-array)`)
  }
  if (kind === 'storage-image' && !(isFormat(r.format) && FORMATS[r.format].storage)) no(`${say(r.format)} is not a format a storage image may have`)
}

// ---------------------------------------------------------------------------------------------------
// The checker

/** Per id: never defined, a value or a variable in scope, or a value or a variable whose block has ended. */
const UNDEFINED = 0
const VALUE = 1
const VARIABLE = 2
/** Added to an id's state when its block ends. */
const ENDED = 2

const same = (t: ValueType, r: ValueType, no: Refuse): void => {
  if (t !== r) no(`the result is ${r}, not ${t}`)
}

class Checker {
  private stage: Stage = 'vertex'
  private ids = 0
  private state = new Uint8Array(0)
  private readonly types: ValueType[] = []
  private resources: readonly Resource[] = []
  private readonly inputs = new Map<number, ValueType>()
  private readonly outputs = new Map<number, ValueType>()
  private count = 0
  private returned = false
  private readonly budget = { left: FIELD_BUDGET }
  private readonly layouts: Layouts = { uniform: new WeakMap(), storage: new WeakMap() }
  private readonly leaves = new Map<string, ValueType>()

  check(m: unknown): void {
    const no: Refuse = (rule) => fail('lens', `lens: module: ${rule}`)
    if (!isObj(m)) no(`a module is an object, not ${say(m)}`)
    shapeRule(m, MODULE_FIELDS, [], no)
    const { stage, ids } = m
    if (!isOneOf(STAGES, stage)) no(`${say(stage)} is not a stage`)
    if (!isIndex(ids, LENS_LIMITS.ids + 1)) no(`ids is a whole number from 0 to ${LENS_LIMITS.ids}, not ${say(ids)}`)
    this.stage = stage
    this.ids = ids
    this.state = new Uint8Array(ids)
    groupRule(stage, m.group, (rule) => fail('lens', `lens: group: ${rule}`))
    this.ports(m.inputs, 'inputs', this.inputs)
    this.ports(m.outputs, 'outputs', this.outputs)
    this.resourceList(m.resources)
    this.list(m.body, 'body', 0, false)
  }

  private ports(list: unknown, side: 'inputs' | 'outputs', into: Map<number, ValueType>): void {
    if (!Array.isArray(list)) fail('lens', `lens: ${side}: the ${side} are a list`)
    if (list.length > LENS_LIMITS.ports) fail('lens', `lens: ${side}: ${list.length} ports is more than the limit of ${LENS_LIMITS.ports}`)
    for (let i = 0; i < list.length; i++) {
      const p: unknown = list[i]
      const no: Refuse = (rule) => fail('lens', `lens: ${side}[${i}] port: ${rule}`)
      portRule(this.stage, side, p, no)
      if (into.has(p.slot)) no(`slot ${p.slot} is declared twice`)
      into.set(p.slot, p.type)
    }
  }

  private resourceList(list: unknown): void {
    if (!Array.isArray(list)) fail('lens', 'lens: resources: the resources are a list')
    if (list.length > LENS_LIMITS.resources) fail('lens', `lens: resources: ${list.length} resources is more than the limit of ${LENS_LIMITS.resources}`)
    const taken = new Set<number>()
    let constants = false
    for (let i = 0; i < list.length; i++) {
      const r: unknown = list[i]
      const kind = isObj(r) && isOneOf(RESOURCE_KINDS, r.kind) ? r.kind : 'resource'
      const no: Refuse = (rule) => fail('lens', `lens: resources[${i}] ${kind}: ${rule}`)
      resourceRule(r, no, this.budget, this.layouts)
      if (r.kind === 'constants') {
        if (constants) no('a module declares at most one constants resource')
        constants = true
      } else {
        const key = r.set * LENS_LIMITS.bindings + r.binding
        if (taken.has(key)) no(`set ${r.set} binding ${r.binding} is declared twice`)
        taken.add(key)
      }
    }
    this.resources = list as Resource[]
  }

  private list(insts: unknown, path: string, depth: number, loop: boolean): void {
    if (!Array.isArray(insts)) fail('lens', `lens: ${path}: a block is a list of instructions`)
    if (insts.length > LENS_LIMITS.instructions - this.count) fail('lens', `lens: ${path}: the module holds more than ${LENS_LIMITS.instructions} instructions`)
    this.count += insts.length
    const defined: number[] = []
    for (let i = 0; i < insts.length; i++) this.inst(insts[i], `${path}[${i}]`, depth, loop, i === insts.length - 1, defined)
    for (const id of defined) this.state[id] += ENDED
  }

  private inst(x: unknown, where: string, depth: number, loop: boolean, last: boolean, defined: number[]): void {
    if (!isObj(x)) fail('lens', `lens: ${where}: an instruction is an object, not ${say(x)}`)
    const op = x.op
    if (typeof op !== 'string' || !Object.hasOwn(INST_FIELDS, op)) fail('lens', `lens: ${where}: ${say(op)} is not an instruction`)
    const no: Refuse = (rule) => fail('lens', `lens: ${where} ${op}: ${rule}`)
    const [required, optional] = INST_FIELDS[op as Op]
    shapeRule(x, required, optional, no)
    const t = x.t as ValueType
    if (required.includes('t') && !isValueType(t)) no(`${say(t)} is not a value type`)
    switch (op as Op) {
      case 'lit':
        if (!Array.isArray(x.v)) no('the components are a list')
        literalRule(t, x.v as unknown[], no)
        break
      case 'unary':
        if (!isOneOf(UNARY, x.fn)) no(`${say(x.fn)} is not a unary function`)
        same(t, unaryType(x.fn, this.value(x.a, 'the operand', no), no), no)
        break
      case 'binary':
        if (!isOneOf(BINARY, x.fn)) no(`${say(x.fn)} is not a binary function`)
        same(t, binaryType(x.fn, this.value(x.a, 'operand a', no), this.value(x.b, 'operand b', no), no), no)
        break
      case 'ternary':
        if (!isOneOf(TERNARY, x.fn)) no(`${say(x.fn)} is not a ternary function`)
        same(t, ternaryType(x.fn, this.value(x.a, 'operand a', no), this.value(x.b, 'operand b', no), this.value(x.c, 'operand c', no), no), no)
        break
      case 'make': {
        const args = x.args
        if (!Array.isArray(args) || args.length > MAX_OPERANDS) no(`the operands are a list of 1 to ${MAX_OPERANDS} values`)
        makeRule(t, (args as unknown[]).map((a, k) => this.value(a, `operand ${k}`, no)), no)
        break
      }
      case 'pick': same(t, pickType(this.value(x.a, 'the vector', no), x.lanes, no), no); break
      case 'lane': same(t, laneType(this.value(x.a, 'the vector', no), this.value(x.i, 'the index', no), no), no); break
      case 'column': same(t, columnType(this.value(x.a, 'the grid', no), x.i, no), no); break
      case 'cast': castRule(this.value(x.a, 'the operand', no), t, no); break
      case 'bits': bitsRule(this.value(x.a, 'the operand', no), t, no); break
      case 'in': same(t, this.port(this.inputs, 'input', x.slot, no), no); break
      case 'builtin': same(t, builtinType(this.stage, x.name, no), no); break
      case 'out': {
        const port = this.port(this.outputs, 'output', x.slot, no)
        const a = this.value(x.a, 'the value', no)
        if (a !== port) no(`the output at slot ${x.slot} is ${port}, not ${a}`)
        break
      }
      case 'position':
        if (this.stage !== 'vertex') no('position is only in the vertex stage')
        this.typed(x.a, 'the position', ['f32x4'], no)
        break
      case 'read': {
        const r = this.resource(x.res, no)
        if (r.kind !== 'uniform' && r.kind !== 'storage' && r.kind !== 'constants') no(`resource ${x.res} is a ${r.kind}; read takes a uniform, storage or constants resource`)
        same(t, this.leaf(x.res as number, r.block, r.kind === 'storage' ? 'storage' : 'uniform', x.path, no), no)
        break
      }
      case 'write': {
        if (this.stage === 'vertex') no('the vertex stage never writes a resource')
        const r = this.resource(x.res, no)
        if (r.kind !== 'storage' || !r.writable) no(`resource ${x.res} is not a writable storage block`)
        const leaf = this.leaf(x.res as number, r.block, 'storage', x.path, no)
        const a = this.value(x.a, 'the value', no)
        if (a !== leaf) no(`the value is ${a}, but the path leads to ${leaf}`)
        break
      }
      case 'sample': {
        if (x.level === undefined) this.rate(depth, 'a sample without a level', no)
        const img = this.resource(x.image, no)
        if (img.kind !== 'image' || img.sample !== 'float') no(`resource ${x.image} is not a float image; sample reads a float image`)
        if (this.resource(x.sampler, no).kind !== 'sampler') no(`resource ${x.sampler} is not a sampler`)
        this.typed(x.uv, 'uv', ['f32x2'], no)
        this.layer(img.dims, x.layer, no)
        if (x.level !== undefined) this.typed(x.level, 'the level', ['f32'], no)
        same(t, 'f32x4', no)
        break
      }
      case 'texel': {
        const img = this.resource(x.image, no)
        if (img.kind !== 'image') no(`resource ${x.image} is not an image; texel reads an image`)
        this.typed(x.at, 'the position', ['i32x2', 'u32x2'], no)
        this.layer(img.dims, x.layer, no)
        this.typed(x.level, 'the level', ['i32', 'u32'], no)
        same(t, texelType(img.sample), no)
        break
      }
      case 'put': {
        if (this.stage === 'vertex') no('put is only in the fragment and compute stages')
        const img = this.resource(x.image, no)
        if (img.kind !== 'storage-image') no(`resource ${x.image} is not a storage image; put writes a storage image`)
        this.typed(x.at, 'the position', ['i32x2', 'u32x2'], no)
        this.typed(x.a, 'the value', [putType(img.format)], no)
        break
      }
      case 'extent': {
        const img = this.resource(x.image, no)
        if (img.kind === 'image') {
          if (x.level === undefined) no('the extent of a sampled image is of a level')
          this.typed(x.level, 'the level', ['i32', 'u32'], no)
        } else if (img.kind === 'storage-image') {
          if (x.level !== undefined) no('a storage image has one level; its extent takes no level')
        } else no(`resource ${x.image} is not an image or a storage image`)
        same(t, 'u32x2', no)
        break
      }
      case 'deriv':
        this.rate(depth, 'deriv', no)
        if (!isOneOf(DERIVATIVES, x.fn)) no(`${say(x.fn)} is not a derivative (dx, dy or width)`)
        same(t, this.typed(x.a, 'the operand', ['f32', 'f32x2', 'f32x3', 'f32x4'], no), no)
        break
      case 'var':
        if (x.init !== undefined) this.typed(x.init, 'the initial value', [t], no)
        break
      case 'get': same(t, this.variable(x.v, no), no); break
      case 'set': this.typed(x.a, 'the value', [this.variable(x.v, no)], no); break
      case 'if':
        this.typed(x.c, 'the condition', ['bool'], no)
        this.deeper(depth, no)
        this.list(x.then, `${where}.then`, depth + 1, loop)
        this.list(x.else, `${where}.else`, depth + 1, loop)
        break
      case 'loop':
        this.deeper(depth, no)
        this.list(x.body, `${where}.body`, depth + 1, true)
        break
      case 'break': case 'continue':
        if (!loop) no(`${op} is only inside a loop`)
        if (!last) no(`nothing may follow ${op} in its block`)
        break
      case 'return':
        if (!last) no('nothing may follow return in its block')
        this.returned = true
        break
      case 'discard':
        if (this.stage !== 'fragment') no('discard is only in the fragment stage')
        break
    }
    if (required.includes('id')) this.define(x.id, t, op === 'var', no, defined)
  }

  /** The type of a value operand: an id below `ids`, defined before, in scope, and not a variable. */
  private value(x: unknown, name: string, no: Refuse): ValueType {
    if (!isIndex(x, this.ids)) no(`${name} ${say(x)} is not an id below the module's ${this.ids}`)
    switch (this.state[x]) {
      case VALUE: return this.types[x]
      case UNDEFINED: return no(`${name} %${x} is used before it is defined`)
      case VARIABLE: case VARIABLE + ENDED: return no(`${name} %${x} is a variable; read it with get`)
      default: return no(`${name} %${x} is defined in a block that has ended`)
    }
  }

  /** A value operand of one of the allowed types. */
  private typed(x: unknown, name: string, allowed: readonly ValueType[], no: Refuse): ValueType {
    const t = this.value(x, name, no)
    if (!allowed.includes(t)) no(`${name} is ${t}, not ${allowed.join(' or ')}`)
    return t
  }

  /** The type of a variable operand of get or set. */
  private variable(x: unknown, no: Refuse): ValueType {
    if (!isIndex(x, this.ids)) no(`the variable ${say(x)} is not an id below the module's ${this.ids}`)
    switch (this.state[x]) {
      case VARIABLE: return this.types[x]
      case UNDEFINED: return no(`the variable %${x} is used before it is defined`)
      case VALUE: case VALUE + ENDED: return no(`%${x} is a value, not a variable`)
      default: return no(`the variable %${x} is defined in a block that has ended`)
    }
  }

  private define(x: unknown, t: ValueType, variable: boolean, no: Refuse, defined: number[]): void {
    if (!isIndex(x, this.ids)) no(`the id ${say(x)} is not below the module's ${this.ids}`)
    if (this.state[x] !== UNDEFINED) no(`%${x} is defined twice`)
    this.state[x] = variable ? VARIABLE : VALUE
    this.types[x] = t
    defined.push(x)
  }

  private port(ports: Map<number, ValueType>, side: string, slot: unknown, no: Refuse): ValueType {
    const t = typeof slot === 'number' && !Object.is(slot, -0) ? ports.get(slot) : undefined
    if (t === undefined) no(`no ${side} is declared at slot ${say(slot)}`)
    return t
  }

  private resource(x: unknown, no: Refuse): Resource {
    if (!isIndex(x, this.resources.length)) no(`resource ${say(x)} is not one of the module's ${this.resources.length} resources`)
    return this.resources[x]
  }

  private layer(dims: ImageDims, layer: unknown, no: Refuse): void {
    if (dims === '2d-array' && layer === undefined) no('a 2d-array image is read at a layer')
    if (dims === '2d' && layer !== undefined) no('a 2d image has no layers')
    if (layer !== undefined) this.typed(layer, 'the layer', ['i32', 'u32'], no)
  }

  /** Implicit-level sampling and derivatives: fragment only, at the top level, before any instruction holding a return. */
  private rate(depth: number, what: string, no: Refuse): void {
    if (this.stage !== 'fragment') no(`${what} is only in the fragment stage`)
    if (depth !== 0) no(`${what} sits at the top level of the body, where neighbouring pixels all reach it`)
    if (this.returned) no(`${what} sits before any instruction that holds a return, where neighbouring pixels all reach it`)
  }

  private deeper(depth: number, no: Refuse): void {
    if (depth >= LENS_LIMITS.depth) no(`if and loop nest at most ${LENS_LIMITS.depth} deep`)
  }

  /**
   * The type at the end of a path into a block, through walk(), with value-held steps checked. Each distinct path is
   * walked once, through the check's layouts, so no path lays out a block again.
   */
  private leaf(res: number, block: Block, space: Space, path: unknown, no: Refuse): ValueType {
    if (!Array.isArray(path)) no('the path is a list of steps')
    if (path.length > LENS_LIMITS.path) no(`a path has at most ${LENS_LIMITS.path} steps, not ${path.length}`)
    let key = `${res}`
    const steps: Step[] = []
    for (let s = 0; s < path.length; s++) {
      const step: unknown = path[s]
      if (typeof step === 'number') {
        if (!Number.isInteger(step) || step < 0 || step > MAX_INDEX || Object.is(step, -0)) no(`step ${s} (${say(step)}) is not a constant index from 0 to ${MAX_INDEX}`)
        key += `,${step}`
      } else {
        if (!isObj(step)) no(`step ${s} is a constant index or an { at } value`)
        shapeRule(step, ['at'], [], (rule) => no(`step ${s}: ${rule}`))
        const t = this.value(step.at, `step ${s}`, no)
        if (t !== 'i32' && t !== 'u32') no(`step ${s} holds ${t}; an index held by a value is an i32 or u32 scalar`)
        key += ',v'
      }
      steps.push(step as Step)
    }
    const known = this.leaves.get(key)
    if (known !== undefined) return known
    const leaf = laidOut(() => walk(block, space, steps, this.layouts[space]), no).type
    this.leaves.set(key, leaf)
    return leaf
  }
}

/**
 * Checks a module against every rule of Lens and returns, or refuses it with a Fault of code `lens` whose message
 * reads `lens: <place> <op>: <rule>` (the place is a path such as `body[3].then[0]`, `resources[1]` or `inputs[0]`).
 * Any input is safe: whatever it is, the only thing raised is a Fault.
 */
export function verify(m: LensModule): void {
  try {
    new Checker().check(m)
  } catch (e) {
    if (isFault(e)) throw e
    fail('lens', 'lens: module: the module is not plain data (reading it raised an error)')
  }
}
