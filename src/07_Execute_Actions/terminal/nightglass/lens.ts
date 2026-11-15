// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It defines Lens, Nightglass's own intermediate form for shaders: the value types, the
 * resources a shader reads and writes, its stage inputs and outputs, and its instructions, as plain data. Every other
 * part of the shader path works on this one model: the builder writes it, the verifier checks it, the binary codec
 * stores it as 32-bit words, the reference renderer runs it, and the GPU back end lowers it to the browser's shading
 * language. It also holds the byte layout of a resource block, which a shader and the code that fills its buffer
 * must agree on to the byte.
 * What breaks if it is removed? Each part would carry its own idea of a shader, and a buffer filled by an app would
 * no longer line up with the fields its shader reads.
 */
import { fail } from './fault.ts'
import type { Format } from './formats.ts'

/** The first word of every Lens binary: the bytes `L`, `E`, `N`, `S` read as one little-endian word. */
export const LENS_MAGIC = 0x534e454c
/** The version of the form this code writes and reads. */
export const LENS_VERSION = 1

export type Stage = 'vertex' | 'fragment' | 'compute'
export const STAGES: readonly Stage[] = Object.freeze(['vertex', 'fragment', 'compute'])

// ---------------------------------------------------------------------------------------------------
// Value types

export type Scalar = 'f32' | 'i32' | 'u32' | 'bool'
export type Width = 2 | 3 | 4
export type VectorType = `${Scalar}x${Width}`
/** A square grid of f32 numbers stored as columns: `m2` is two columns of f32x2, `m4` four columns of f32x4. */
export type GridType = 'm2' | 'm3' | 'm4'
/** The type of every value a shader computes. */
export type ValueType = Scalar | VectorType | GridType

export const SCALARS: readonly Scalar[] = Object.freeze(['f32', 'i32', 'u32', 'bool'])

/** Every value type, scalars first, then vectors by scalar and width, then grids. */
export const VALUE_TYPES: readonly ValueType[] = Object.freeze([
  ...SCALARS,
  ...SCALARS.flatMap((s) => ([2, 3, 4] as const).map((n) => `${s}x${n}` as VectorType)),
  'm2', 'm3', 'm4',
])

export function isValueType(t: unknown): t is ValueType {
  return typeof t === 'string' && (VALUE_TYPES as readonly string[]).includes(t)
}

export function isScalar(t: ValueType): t is Scalar {
  return t === 'f32' || t === 'i32' || t === 'u32' || t === 'bool'
}

export function isVector(t: ValueType): t is VectorType {
  return (t.length === 5 && t[3] === 'x') || (t.length === 6 && t[4] === 'x')
}

export function isGrid(t: ValueType): t is GridType {
  return t === 'm2' || t === 'm3' || t === 'm4'
}

/** The scalar a type is made of (`f32` for a grid). */
export function scalarOf(t: ValueType): Scalar {
  if (isGrid(t)) return 'f32'
  return (isVector(t) ? t.slice(0, t.indexOf('x')) : t) as Scalar
}

/** Components across a vector (1 for a scalar; a grid's column height). */
export function widthOf(t: ValueType): 1 | Width {
  if (isScalar(t)) return 1
  if (isGrid(t)) return Number(t[1]) as Width
  return Number(t[t.length - 1]) as Width
}

/** Every component a value holds: 1 for a scalar, n for a vector, n * n for a grid. */
export function componentsOf(t: ValueType): number {
  if (isGrid(t)) {
    const n = widthOf(t)
    return n * n
  }
  return widthOf(t)
}

/** The scalar or vector type of `n` components of `s` (`n` 1 gives the scalar). */
export function vectorOf(s: Scalar, n: 1 | Width): Scalar | VectorType {
  return n === 1 ? s : (`${s}x${n}` as VectorType)
}

/** A grid's column type. */
export function columnOf(t: GridType): VectorType {
  return `f32x${widthOf(t)}` as VectorType
}

/** The same shape with booleans in it (the result type of a comparison). */
export function boolOf(t: ValueType): Scalar | VectorType {
  return vectorOf('bool', isGrid(t) ? 1 : widthOf(t))
}

// ---------------------------------------------------------------------------------------------------
// Resource blocks and their byte layout

/** A type that may sit in a resource block: a number type that is not boolean, a fixed array, or a nested block. */
export type DataType = Exclude<ValueType, 'bool' | `boolx${Width}`> | ArrayType | StructType
export interface ArrayType {
  readonly array: DataType
  /** Elements; 0 is an array whose length is the bound buffer's (only as the last field of a storage block). */
  readonly len: number
}
export interface StructType {
  readonly struct: Block
}
export interface Field {
  readonly name: string
  readonly type: DataType
}
export interface Block {
  readonly fields: readonly Field[]
}

/**
 * The rules a block is laid out by. `uniform` also governs inline constants (the GPU back end carries them in a
 * uniform buffer): an array element and a nested block start on 16-byte boundaries there, and a block that would
 * need otherwise is refused. `storage` uses each type's natural alignment.
 */
export type Space = 'uniform' | 'storage'

export interface Placement {
  readonly size: number
  readonly align: number
}

function roundUp(align: number, n: number): number {
  return Math.ceil(n / align) * align
}

/** The size and alignment of a number type: 4-byte scalars, vectors of 8 or 16, grids stored as padded columns. */
export function placeValue(t: Exclude<DataType, ArrayType | StructType>): Placement {
  if (isGrid(t)) {
    const n = widthOf(t)
    const col = placeValue(columnOf(t) as Exclude<DataType, ArrayType | StructType>)
    return { size: n * roundUp(col.align, col.size), align: col.align }
  }
  const n = widthOf(t)
  if (n === 1) return { size: 4, align: 4 }
  if (n === 2) return { size: 8, align: 8 }
  return { size: n * 4, align: 16 }
}

/** The size and alignment of any block type in a space. A runtime-sized array reports the size of one element. */
export function place(t: DataType, space: Space): Placement {
  if (typeof t === 'string') return placeValue(t)
  if ('array' in t) {
    const e = place(t.array, space)
    const stride = roundUp(e.align, e.size)
    return { size: (t.len === 0 ? 1 : t.len) * stride, align: e.align }
  }
  const fields = layoutBlock(t.struct, space)
  return { size: fields.size, align: fields.align }
}

/** The stride between two elements of an array of `t`. */
export function strideOf(t: DataType, space: Space): number {
  const e = place(t, space)
  return roundUp(e.align, e.size)
}

export interface BlockLayout {
  /** Bytes the block takes (a runtime-sized last array counted as one element). */
  readonly size: number
  readonly align: number
  /** Each field's byte offset, in field order. */
  readonly offsets: readonly number[]
}

/** Lays out a block by the rules of a space. Refuses a block the space cannot hold (see Space). */
export function layoutBlock(block: Block, space: Space): BlockLayout {
  let end = 0
  let align = 1
  const offsets: number[] = []
  block.fields.forEach((f, i) => {
    const p = place(f.type, space)
    if (space === 'uniform' && typeof f.type !== 'string') {
      if ('array' in f.type && strideOf(f.type.array, space) % 16 !== 0) fail('lens', `field ${f.name}: an array in a uniform block needs elements 16 bytes apart (use f32x4, i32x4 or u32x4 elements)`)
      if ('array' in f.type && f.type.len === 0) fail('lens', `field ${f.name}: a uniform block cannot end in an array without a length`)
    }
    if (typeof f.type !== 'string' && 'array' in f.type && f.type.len === 0 && i !== block.fields.length - 1) fail('lens', `field ${f.name}: only the last field may be an array without a length`)
    const a = space === 'uniform' && typeof f.type !== 'string' && 'struct' in f.type ? roundUp(16, p.align) : p.align
    const offset = roundUp(a, end)
    offsets.push(offset)
    // A field after a nested block starts past the block's 16-byte-rounded end in a uniform block.
    end = offset + (space === 'uniform' && typeof f.type !== 'string' && 'struct' in f.type ? roundUp(16, p.size) : p.size)
    align = Math.max(align, a)
  })
  return { size: roundUp(align, end), align, offsets }
}

/** One step of a path into a block: a constant field or element index, or an element index held by a value. */
export type Step = number | { readonly at: number }

export interface Leaf {
  /** The value type found at the end of the path. */
  readonly type: Exclude<DataType, ArrayType | StructType>
  /** The byte offset of the leaf when every value-held index is 0. */
  readonly offset: number
  /** For each value-held step, in path order: the element stride it multiplies, and the array's length (0: runtime). */
  readonly dynamic: readonly { readonly stride: number; readonly len: number }[]
}

/**
 * Follows a path from the top of a block to a number type. Refuses a path that is too short (ends at a block or an
 * array), too long, or indexes out of a fixed array with a constant.
 */
export function walk(block: Block, space: Space, path: readonly Step[]): Leaf {
  let t: DataType = { struct: block }
  let offset = 0
  const dynamic: { stride: number; len: number }[] = []
  for (const step of path) {
    if (typeof t === 'string') fail('lens', `the path goes past the ${t} it reached`)
    if ('struct' in t) {
      if (typeof step !== 'number') fail('lens', 'a block field is picked by a constant index')
      const s: Block = t.struct
      if (!Number.isInteger(step) || step < 0 || step >= s.fields.length) fail('lens', `the block has no field ${step}`)
      offset += layoutBlock(s, space).offsets[step]
      t = s.fields[step].type
    } else {
      const stride = strideOf(t.array, space)
      if (typeof step === 'number') {
        if (!Number.isInteger(step) || step < 0 || (t.len !== 0 && step >= t.len)) fail('lens', `element ${step} is outside the array`)
        offset += step * stride
      } else {
        dynamic.push({ stride, len: t.len })
      }
      t = t.array
    }
  }
  if (typeof t !== 'string') fail('lens', 'the path ends at a block or an array, not at a number type')
  return { type: t, offset, dynamic }
}

// ---------------------------------------------------------------------------------------------------
// Stage interface and resources

/** A stage input or output: a vertex attribute or colour output by slot, or a value passed from vertex to fragment. */
export interface Port {
  readonly slot: number
  readonly type: ValueType
  /** Passed without interpolation (the first vertex's value). Integer values must be flat. */
  readonly flat?: boolean
}

/** The values a stage is handed by the device rather than by a buffer. */
export const BUILTINS = Object.freeze({
  'vertex-index': { stage: 'vertex', type: 'u32' },
  'instance-index': { stage: 'vertex', type: 'u32' },
  'frag-coord': { stage: 'fragment', type: 'f32x4' },
  'front-facing': { stage: 'fragment', type: 'bool' },
  'global-id': { stage: 'compute', type: 'u32x3' },
  'local-id': { stage: 'compute', type: 'u32x3' },
  'group-id': { stage: 'compute', type: 'u32x3' },
  'local-index': { stage: 'compute', type: 'u32' },
  'group-count': { stage: 'compute', type: 'u32x3' },
} as const satisfies Record<string, { stage: Stage; type: ValueType }>)
export type Builtin = keyof typeof BUILTINS

/** What a sampled image hands a shader. */
export type SampleKind = 'float' | 'uint' | 'sint' | 'depth'
/** The shapes of a sampled image view. */
export type ImageDims = '2d' | '2d-array'

/** A resource a shader declares, bound at a set and a binding (inline constants have neither). */
export type Resource =
  | { readonly kind: 'uniform'; readonly set: number; readonly binding: number; readonly block: Block }
  | { readonly kind: 'storage'; readonly set: number; readonly binding: number; readonly block: Block; readonly writable: boolean }
  | { readonly kind: 'constants'; readonly block: Block }
  | { readonly kind: 'image'; readonly set: number; readonly binding: number; readonly sample: SampleKind; readonly dims: ImageDims }
  | { readonly kind: 'sampler'; readonly set: number; readonly binding: number }
  | { readonly kind: 'storage-image'; readonly set: number; readonly binding: number; readonly format: Format }

export type ResourceKind = Resource['kind']

// ---------------------------------------------------------------------------------------------------
// Instructions

/** Per-component functions of one value, and the reductions of one value (length, normalize, any, all, transpose). */
export const UNARY = Object.freeze(['neg', 'not', 'bitnot', 'abs', 'sign', 'floor', 'ceil', 'round', 'trunc', 'fract', 'sqrt', 'rsqrt', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'saturate', 'length', 'normalize', 'any', 'all', 'transpose'] as const)
export type UnaryFn = (typeof UNARY)[number]

/** Functions of two values: arithmetic, comparisons, bit operations, and the geometric ones. */
export const BINARY = Object.freeze(['add', 'sub', 'mul', 'div', 'rem', 'min', 'max', 'pow', 'atan2', 'step', 'and', 'or', 'xor', 'shl', 'shr', 'eq', 'ne', 'lt', 'le', 'gt', 'ge', 'land', 'lor', 'dot', 'cross', 'distance', 'reflect'] as const)
export type BinaryFn = (typeof BINARY)[number]

/** Functions of three values. `choose` is (condition, value when true, value when false). */
export const TERNARY = Object.freeze(['mix', 'clamp', 'smoothstep', 'fma', 'choose'] as const)
export type TernaryFn = (typeof TERNARY)[number]

export const DERIVATIVES = Object.freeze(['dx', 'dy', 'width'] as const)
export type DerivativeFn = (typeof DERIVATIVES)[number]

/**
 * One instruction. `id` is the value (or variable) an instruction defines; every id is defined exactly once and used
 * only after its definition, inside the block that defines it or a block nested in that one. `t` is the type of the
 * value defined. Value operands (`a`, `b`, `c`, `args`, `uv`, ...) are ids.
 */
export type Inst =
  | { readonly op: 'lit'; readonly id: number; readonly t: ValueType; readonly v: readonly number[] }
  | { readonly op: 'unary'; readonly id: number; readonly t: ValueType; readonly fn: UnaryFn; readonly a: number }
  | { readonly op: 'binary'; readonly id: number; readonly t: ValueType; readonly fn: BinaryFn; readonly a: number; readonly b: number }
  | { readonly op: 'ternary'; readonly id: number; readonly t: ValueType; readonly fn: TernaryFn; readonly a: number; readonly b: number; readonly c: number }
  | { readonly op: 'make'; readonly id: number; readonly t: ValueType; readonly args: readonly number[] }
  | { readonly op: 'pick'; readonly id: number; readonly t: ValueType; readonly a: number; readonly lanes: readonly number[] }
  | { readonly op: 'lane'; readonly id: number; readonly t: ValueType; readonly a: number; readonly i: number }
  | { readonly op: 'column'; readonly id: number; readonly t: ValueType; readonly a: number; readonly i: number }
  | { readonly op: 'cast'; readonly id: number; readonly t: ValueType; readonly a: number }
  | { readonly op: 'bits'; readonly id: number; readonly t: ValueType; readonly a: number }
  | { readonly op: 'in'; readonly id: number; readonly t: ValueType; readonly slot: number }
  | { readonly op: 'builtin'; readonly id: number; readonly t: ValueType; readonly name: Builtin }
  | { readonly op: 'out'; readonly slot: number; readonly a: number }
  | { readonly op: 'position'; readonly a: number }
  | { readonly op: 'read'; readonly id: number; readonly t: ValueType; readonly res: number; readonly path: readonly Step[] }
  | { readonly op: 'write'; readonly res: number; readonly path: readonly Step[]; readonly a: number }
  | { readonly op: 'sample'; readonly id: number; readonly t: ValueType; readonly image: number; readonly sampler: number; readonly uv: number; readonly layer?: number; readonly level?: number }
  | { readonly op: 'texel'; readonly id: number; readonly t: ValueType; readonly image: number; readonly at: number; readonly layer?: number; readonly level: number }
  | { readonly op: 'put'; readonly image: number; readonly at: number; readonly a: number }
  | { readonly op: 'extent'; readonly id: number; readonly t: ValueType; readonly image: number; readonly level?: number }
  | { readonly op: 'deriv'; readonly id: number; readonly t: ValueType; readonly fn: DerivativeFn; readonly a: number }
  | { readonly op: 'var'; readonly id: number; readonly t: ValueType; readonly init?: number }
  | { readonly op: 'get'; readonly id: number; readonly t: ValueType; readonly v: number }
  | { readonly op: 'set'; readonly v: number; readonly a: number }
  | { readonly op: 'if'; readonly c: number; readonly then: readonly Inst[]; readonly else: readonly Inst[] }
  | { readonly op: 'loop'; readonly body: readonly Inst[] }
  | { readonly op: 'break' }
  | { readonly op: 'continue' }
  | { readonly op: 'discard' }
  | { readonly op: 'return' }

export type Op = Inst['op']

/** A whole shader: one stage, one entry, its interface, its resources and its body. */
export interface LensModule {
  readonly stage: Stage
  /** Invocations per workgroup along x, y and z (compute only; [1, 1, 1] for the other stages). */
  readonly group: readonly [number, number, number]
  readonly inputs: readonly Port[]
  readonly outputs: readonly Port[]
  readonly resources: readonly Resource[]
  readonly body: readonly Inst[]
  /** Ids run from 0 to ids - 1. */
  readonly ids: number
}

/** The bounds every Lens module stays within, so decoding, checking and running one are bounded too. */
export const LENS_LIMITS = Object.freeze({
  /** Values and variables in one module. */
  ids: 65_536,
  /** Instructions in one module, counting nested ones. */
  instructions: 65_536,
  /** How deep `if` and `loop` may nest. */
  depth: 32,
  /** Stage inputs, and stage outputs. */
  ports: 16,
  /** The highest slot number plus one. */
  slots: 16,
  /** Resources in one module. */
  resources: 64,
  /** Sets (0 to 2: the back end keeps a fourth for inline constants) and bindings per set. */
  sets: 3,
  bindings: 16,
  /** Fields of one block, and how deep blocks may nest. */
  fields: 64,
  nesting: 8,
  /** Elements of one fixed array. */
  elements: 65_536,
  /** Steps of one path into a block. */
  path: 16,
  /** Bytes of the inline-constant block. */
  constants: 128,
  /** Invocations of one workgroup in all, and along x and y, and along z. */
  invocations: 256,
  groupXY: 256,
  groupZ: 64,
  /** Words of one binary module. */
  words: 1_048_576,
})
