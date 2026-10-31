// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one table of NoirScript's intrinsics: for each name, its overloads (the
 * parameter types, the result type, and the instruction the compiler emits), in the order the checker tries them,
 * so integer forms win for bare literals. The checker resolves a call against it, the compiler copies its code
 * into the program, and the VM's typed opcodes do the work; INTRINSIC_NAMES is the same table as `words()` lists
 * it. `print` and `println` are here too, as the two variadic names the checker handles itself.
 * What breaks if it is removed? The checker, the compiler and the VM would each keep their own list of built-ins,
 * and the three would drift.
 */
import type { Ty } from './ast.ts'
import { T, colTy } from './ast.ts'
import { Op } from './vm.ts'

/** One overload: `code` is the full instruction (opcode and operands); empty for a constructor whose arguments
 *  already lie in lane order on the stack. */
export interface IntrinsicForm { readonly params: readonly Ty[]; readonly ret: Ty; readonly code: readonly number[] }
export interface Intrinsic { readonly name: string; readonly forms: readonly IntrinsicForm[]; readonly variadic: boolean }

const form = (params: readonly Ty[], ret: Ty, code: readonly number[]): IntrinsicForm => Object.freeze({ params: Object.freeze([...params]), ret, code: Object.freeze([...code]) })

const { i32, u32, f32, bool, f32x4, i32x4, u32x4, u32x8 } = T
const colF32 = colTy('f32')
const colI32 = colTy('i32')
const colU32 = colTy('u32')

/** The scalar and vector forms of a lane-wise binary op given its i32/u32/f32 opcodes (u32x8 uses the u32 one). */
function laneBinary(opI: number, opU: number, opF: number, vectors: boolean): IntrinsicForm[] {
  const forms = [form([i32, i32], i32, [opI, 1]), form([u32, u32], u32, [opU, 1]), form([f32, f32], f32, [opF, 1])]
  if (vectors) forms.push(form([f32x4, f32x4], f32x4, [opF, 4]), form([i32x4, i32x4], i32x4, [opI, 4]), form([u32x4, u32x4], u32x4, [opU, 4]), form([u32x8, u32x8], u32x8, [opU, 8]))
  return forms
}

/** A vector comparison: f32x4, i32x4 and u32x4 give a u32x4 mask, u32x8 a u32x8 one. */
function compare(opI: number, opU: number, opF: number): IntrinsicForm[] {
  return [form([f32x4, f32x4], u32x4, [opF, 4]), form([i32x4, i32x4], u32x4, [opI, 4]), form([u32x4, u32x4], u32x4, [opU, 4]), form([u32x8, u32x8], u32x8, [opU, 8])]
}

function horizontal(opI: number, opU: number, opF: number): IntrinsicForm[] {
  return [form([f32x4], f32, [opF, 4]), form([i32x4], i32, [opI, 4]), form([u32x4], u32, [opU, 4]), form([u32x8], u32, [opU, 8])]
}

function load(col: Ty, ret: Ty, lanes: number): IntrinsicForm[] {
  return [form([col, i32], ret, [Op.COL_LOAD, lanes]), form([col, u32], ret, [Op.COL_LOAD, lanes])]
}

const TABLE: readonly (readonly [string, readonly IntrinsicForm[]])[] = [
  ['min', laneBinary(Op.MIN_I32, Op.MIN_U32, Op.MIN_F32, true)],
  ['max', laneBinary(Op.MAX_I32, Op.MAX_U32, Op.MAX_F32, true)],
  ['abs', [form([i32], i32, [Op.ABS_I32, 1]), form([f32], f32, [Op.ABS_F32, 1]), form([f32x4], f32x4, [Op.ABS_F32, 4]), form([i32x4], i32x4, [Op.ABS_I32, 4])]],
  ['clamp', [form([i32, i32, i32], i32, [Op.CLAMP_I32, 1]), form([u32, u32, u32], u32, [Op.CLAMP_U32, 1]), form([f32, f32, f32], f32, [Op.CLAMP_F32, 1])]],
  ['sqrt', [form([f32], f32, [Op.SQRT_F32, 1]), form([f32x4], f32x4, [Op.SQRT_F32, 4])]],
  ['floor', [form([f32], f32, [Op.FLOOR_F32, 1])]],
  ['ceil', [form([f32], f32, [Op.CEIL_F32, 1])]],
  ['trunc', [form([f32], f32, [Op.TRUNC_F32, 1])]],
  ['select', [
    form([u32, i32, i32], i32, [Op.SELECT, 1]), form([u32, u32, u32], u32, [Op.SELECT, 1]), form([u32, f32, f32], f32, [Op.SELECT, 1]),
    form([u32x4, f32x4, f32x4], f32x4, [Op.SELECT, 4]), form([u32x4, i32x4, i32x4], i32x4, [Op.SELECT, 4]), form([u32x4, u32x4, u32x4], u32x4, [Op.SELECT, 4]),
    form([u32x8, u32x8, u32x8], u32x8, [Op.SELECT, 8]),
  ]],
  ['mask', [form([bool], u32, [Op.MASK])]],
  ['popcount', [form([u32], u32, [Op.POPCNT])]],
  ['clz', [form([u32], u32, [Op.CLZ])]],
  ['ctz', [form([u32], u32, [Op.CTZ])]],
  ['rotl', [form([u32, u32], u32, [Op.ROTL])]],
  ['rotr', [form([u32, u32], u32, [Op.ROTR])]],
  ['morton2', [form([u32, u32], u32, [Op.MORTON2])]],
  ['demorton2x', [form([u32], u32, [Op.DEMORTON2X])]],
  ['demorton2y', [form([u32], u32, [Op.DEMORTON2Y])]],
  ['f32x4', [form([f32, f32, f32, f32], f32x4, [])]],
  ['i32x4', [form([i32, i32, i32, i32], i32x4, [])]],
  ['u32x4', [form([u32, u32, u32, u32], u32x4, [])]],
  ['u32x8', [form([u32, u32, u32, u32, u32, u32, u32, u32], u32x8, [])]],
  ['splat_f32x4', [form([f32], f32x4, [Op.FILL, 1, 4])]],
  ['splat_i32x4', [form([i32], i32x4, [Op.FILL, 1, 4])]],
  ['splat_u32x4', [form([u32], u32x4, [Op.FILL, 1, 4])]],
  ['splat_u32x8', [form([u32], u32x8, [Op.FILL, 1, 8])]],
  ['vlt', compare(Op.LT_I32, Op.LT_U32, Op.LT_F32)],
  ['vle', compare(Op.LE_I32, Op.LE_U32, Op.LE_F32)],
  ['vgt', compare(Op.GT_I32, Op.GT_U32, Op.GT_F32)],
  ['vge', compare(Op.GE_I32, Op.GE_U32, Op.GE_F32)],
  ['veq', compare(Op.EQ_32, Op.EQ_32, Op.EQ_F32)],
  ['vne', compare(Op.NE_32, Op.NE_32, Op.NE_F32)],
  ['hsum', horizontal(Op.HSUM_32, Op.HSUM_32, Op.HSUM_F32)],
  ['hmin', horizontal(Op.HMIN_I32, Op.HMIN_U32, Op.HMIN_F32)],
  ['hmax', horizontal(Op.HMAX_I32, Op.HMAX_U32, Op.HMAX_F32)],
  ['any', [form([u32x4], bool, [Op.ANY, 4]), form([u32x8], bool, [Op.ANY, 8])]],
  ['all', [form([u32x4], bool, [Op.ALL, 4]), form([u32x8], bool, [Op.ALL, 8])]],
  ['load_f32x4', load(colF32, f32x4, 4)],
  ['load_i32x4', load(colI32, i32x4, 4)],
  ['load_u32x4', load(colU32, u32x4, 4)],
  ['load_u32x8', load(colU32, u32x8, 8)],
  ['tune', [form([T.str, f32], f32, [Op.TUNE])]],
  ['intent', [form([i32, f32, f32, f32], bool, [Op.INTENT])]],
  ['cull', [form([f32], f32, [Op.CULL])]],
  ['steer', [form([T.str, f32], f32, [Op.STEER])]],
  ['print', []],
  ['println', []],
]

/** Every intrinsic by name. */
export const INTRINSICS: ReadonlyMap<string, Intrinsic> = new Map(TABLE.map(([name, forms]) => [name, Object.freeze({ name, forms: Object.freeze([...forms]), variadic: forms.length === 0 })]))

/** The intrinsic names in table order (what `words()` lists). */
export const INTRINSIC_NAMES: readonly string[] = Object.freeze(TABLE.map(([name]) => name))
