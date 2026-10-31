// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the shared vocabulary of NoirScript's front end: the static types a value can
 * have (scalars, the 4- and 8-lane vectors, fixed arrays, host columns) with their names and their widths in
 * 32-bit cells, and the syntax tree the parser builds and the checker annotates. The checker writes the type of
 * every expression and the declaration every name refers to straight onto the nodes, so the compiler walks one
 * annotated tree and never guesses. Everything here is data: no behaviour, no imports, nothing of the host.
 * What breaks if it is removed? The lexer, parser, checker, compiler and printer have no common shape to agree on.
 */

/** Every failure of the front end and the VM is one of these; the session turns it into `error` text. */
export class NoirError extends Error {}

/** A static type. `str` is only the type of a string literal; `void` is the type of a call that gives nothing. */
export type Ty =
  | { readonly kind: 'i32' | 'u32' | 'f32' | 'bool' | 'void' | 'str' | 'f32x4' | 'i32x4' | 'u32x4' | 'u32x8' }
  | { readonly kind: 'array'; readonly elem: Ty; readonly n: number }
  | { readonly kind: 'col'; readonly elem: 'f32' | 'i32' | 'u32' }

/** The one instance of each simple type, so a type can usually be compared by identity. */
export const T = Object.freeze({
  i32: Object.freeze({ kind: 'i32' }) as Ty,
  u32: Object.freeze({ kind: 'u32' }) as Ty,
  f32: Object.freeze({ kind: 'f32' }) as Ty,
  bool: Object.freeze({ kind: 'bool' }) as Ty,
  void: Object.freeze({ kind: 'void' }) as Ty,
  str: Object.freeze({ kind: 'str' }) as Ty,
  f32x4: Object.freeze({ kind: 'f32x4' }) as Ty,
  i32x4: Object.freeze({ kind: 'i32x4' }) as Ty,
  u32x4: Object.freeze({ kind: 'u32x4' }) as Ty,
  u32x8: Object.freeze({ kind: 'u32x8' }) as Ty,
})

/** The largest array a type may declare, in elements. */
export const MAX_ARRAY = 1_048_576

export const arrayTy = (elem: Ty, n: number): Ty => Object.freeze({ kind: 'array', elem, n })
export const colTy = (elem: 'f32' | 'i32' | 'u32'): Ty => Object.freeze({ kind: 'col', elem })

/** The type as the language writes it: `i32`, `[f32; 4]`, `col<i32>`. */
export function tyName(t: Ty): string {
  if (t.kind === 'array') return `[${tyName(t.elem)}; ${t.n}]`
  if (t.kind === 'col') return `col<${t.elem}>`
  return t.kind
}

export function tyEq(a: Ty, b: Ty): boolean {
  if (a === b) return true
  if (a.kind !== b.kind) return false
  if (a.kind === 'array' && b.kind === 'array') return a.n === b.n && tyEq(a.elem, b.elem)
  if (a.kind === 'col' && b.kind === 'col') return a.elem === b.elem
  return true
}

/** The cells a value of the type takes on the operand stack and in a frame (a col is a base and a length). */
export function tyWidth(t: Ty): number {
  switch (t.kind) {
    case 'void': return 0
    case 'f32x4': case 'i32x4': case 'u32x4': return 4
    case 'u32x8': return 8
    case 'array': return t.n * tyWidth(t.elem)
    case 'col': return 1
    default: return 1
  }
}

export const isVector = (t: Ty): boolean => t.kind === 'f32x4' || t.kind === 'i32x4' || t.kind === 'u32x4' || t.kind === 'u32x8'
export const isNumeric = (t: Ty): boolean => t.kind === 'i32' || t.kind === 'u32' || t.kind === 'f32'
export const isInteger = (t: Ty): boolean => t.kind === 'i32' || t.kind === 'u32'

/** The number of lanes an arithmetic op runs over: 1 for a scalar, 4 or 8 for a vector. */
export function laneCount(t: Ty): number {
  return t.kind === 'u32x8' ? 8 : isVector(t) ? 4 : 1
}

/** The scalar type of one lane (a scalar is its own lane). */
export function laneTy(t: Ty): Ty {
  switch (t.kind) {
    case 'f32x4': return T.f32
    case 'i32x4': return T.i32
    case 'u32x4': case 'u32x8': return T.u32
    case 'col': return T[t.elem]
    case 'array': return t.elem
    default: return t
  }
}

/** The vector type with the given lane type and count, or null when there is none (an i32x8, say). */
export function vectorOf(lane: Ty, lanes: number): Ty | null {
  if (lanes === 4) return lane.kind === 'f32' ? T.f32x4 : lane.kind === 'i32' ? T.i32x4 : lane.kind === 'u32' ? T.u32x4 : null
  if (lanes === 8) return lane.kind === 'u32' ? T.u32x8 : null
  return null
}

/** Where a token or node sits in the source, 1-based. */
export interface Pos { readonly line: number; readonly col: number }

/**
 * A name's declaration, shared by the checker (which makes it and binds uses to it) and the compiler (which gives
 * it a place: a frame offset for locals and params, an arena address for globals). A query column names the host
 * column it reads (by id) and the hidden row counter the query loop advances.
 */
export interface Decl {
  readonly kind: 'local' | 'param' | 'for' | 'global' | 'qcol'
  readonly name: string
  readonly ty: Ty
  readonly mutable: boolean
  /** Frame offset, or arena address for a global; -1 until the compiler places it. */
  slot: number
  /** qcol only: the column's id in the host surface (vm.ts COLUMNS) and the row counter's frame offset. */
  colId: number
  rowSlot: number
}

/** A function's signature as the checker sees it; `index` is its place in the session's function table. */
export interface FnSig {
  readonly name: string
  readonly params: readonly Ty[]
  readonly ret: Ty
  readonly index: number
}

export type BinOp = '+' | '-' | '*' | '/' | '%' | '&' | '|' | '^' | '<<' | '>>' | '==' | '!=' | '<' | '<=' | '>' | '>=' | '&&' | '||'
export type UnOp = '-' | '!' | '~'
export type AssignOp = '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>='

/** What a field access resolved to: a table's row count, one of its columns, one of its scalars, or a vector lane. */
export type FieldRef =
  | { readonly kind: 'n'; readonly table: number }
  | { readonly kind: 'col'; readonly colId: number }
  | { readonly kind: 'scalar'; readonly scalarId: number }
  | { readonly kind: 'lane'; readonly lane: number }

/** What a call resolved to. A `form` is the chosen overload of an intrinsic; `print` formats any arguments. */
export type CallRef =
  | { readonly kind: 'fn'; readonly sig: FnSig }
  | { readonly kind: 'intrinsic'; readonly code: readonly number[]; readonly ret: Ty }
  | { readonly kind: 'print' }

interface Node extends Pos {
  /** The type the checker found; the compiler reads it. */
  ty?: Ty
}

export interface IntLit extends Node { readonly kind: 'int'; readonly value: number; readonly suffixed: boolean; /** lanes to splat an adopted vector shift count over */ splat: number }
export interface FloatLit extends Node { readonly kind: 'float'; readonly value: number }
export interface StrLit extends Node { readonly kind: 'str'; readonly value: string }
export interface BoolLit extends Node { readonly kind: 'bool'; readonly value: boolean }
export interface Ident extends Node { readonly kind: 'ident'; readonly name: string; ref?: Decl }
export interface Unary extends Node { readonly kind: 'unary'; readonly op: UnOp; readonly e: Expr }
export interface Binary extends Node { readonly kind: 'binary'; readonly op: BinOp; readonly l: Expr; readonly r: Expr }
export interface Cast extends Node { readonly kind: 'cast'; readonly e: Expr; readonly to: Ty }
export interface Call extends Node { readonly kind: 'call'; readonly callee: string; readonly args: readonly Expr[]; ref?: CallRef }
export interface Index extends Node { readonly kind: 'index'; readonly e: Expr; readonly index: Expr }
/** A field access sits at its object's start (the expression's position); `namePos` is where the field name is, for an error about the name. */
export interface Field extends Node { readonly kind: 'field'; readonly e: Expr; readonly name: string; readonly namePos: Pos; ref?: FieldRef }
export interface Method extends Node { readonly kind: 'method'; readonly e: Expr; readonly name: string; readonly namePos: Pos; readonly args: readonly Expr[] }
export interface Fill extends Node { readonly kind: 'fill'; readonly value: Expr; readonly n: number }
export interface ArrayLit extends Node { readonly kind: 'array'; readonly elems: readonly Expr[] }
export interface Query extends Node { readonly kind: 'query'; readonly table: string; readonly where: Expr; tableId: number; cols: Decl[] }
export interface IfExpr extends Node { readonly kind: 'if'; readonly cond: Expr; readonly then: Block; readonly else: Block | IfExpr }

export type Expr = IntLit | FloatLit | StrLit | BoolLit | Ident | Unary | Binary | Cast | Call | Index | Field | Method | Fill | ArrayLit | Query | IfExpr

/** A block: statements, then optionally a value expression written without `;`. */
export interface Block extends Pos { readonly stmts: Stmt[]; tail: Expr | null; readonly end: Pos }

export interface LetStmt extends Pos { readonly kind: 'let'; readonly name: string; readonly namePos: Pos; readonly mutable: boolean; readonly declared: Ty | null; readonly init: Expr; decl?: Decl }
export interface AssignStmt extends Pos { readonly kind: 'assign'; readonly name: string; readonly index: Expr | null; readonly op: AssignOp; readonly value: Expr; ref?: Decl }
export interface IfStmt extends Pos { readonly kind: 'if'; readonly cond: Expr; readonly then: Block; readonly else: Block | IfStmt | null }
export interface WhileStmt extends Pos { readonly kind: 'while'; readonly cond: Expr; readonly body: Block }
export interface LoopStmt extends Pos { readonly kind: 'loop'; readonly body: Block }
export interface ForStmt extends Pos { readonly kind: 'for'; readonly name: string; readonly namePos: Pos; readonly from: Expr; readonly to: Expr; readonly inclusive: boolean; readonly body: Block; decl?: Decl }
export interface BreakStmt extends Pos { readonly kind: 'break' }
export interface ContinueStmt extends Pos { readonly kind: 'continue' }
export interface ReturnStmt extends Pos { readonly kind: 'return'; readonly value: Expr | null }
export interface BlockStmt extends Pos { readonly kind: 'block'; readonly block: Block }
export interface ExprStmt extends Pos { readonly kind: 'expr'; readonly e: Expr }

export type Stmt = LetStmt | AssignStmt | IfStmt | WhileStmt | LoopStmt | ForStmt | BreakStmt | ContinueStmt | ReturnStmt | BlockStmt | ExprStmt

export interface Param extends Pos { readonly name: string; readonly ty: Ty }
export interface FnDecl extends Pos { readonly kind: 'fn'; readonly name: string; readonly namePos: Pos; readonly params: readonly Param[]; readonly ret: Ty; readonly body: Block; sig?: FnSig; paramDecls?: Decl[] }

export type Item = FnDecl | Stmt
export interface Program { readonly items: readonly Item[] }
