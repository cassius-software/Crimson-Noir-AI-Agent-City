// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns a checked NoirScript line into bytecode for the VM: one CompiledFn per
 * function plus one for the line's top-level statements. It lays out frames (parameters first, then locals as
 * blocks open and close, so a slot is reused once its block ends), places the line's new globals in the arena
 * (arrays on 64-byte boundaries), picks the typed opcode for every operation from the types the checker wrote on
 * the tree, emits straight-line code for `select` and `mask` and branches only for `&&`, `||`, `if` and the
 * loops, and tracks the operand stack's depth as it goes so each function carries the ceiling the VM checks
 * once per call. A `query` becomes a QNEXT / QACC loop over hidden locals; a `for` keeps its bound in a hidden
 * local and never wraps on an inclusive range. Memory that could never fit is refused here, as "memory exhausted",
 * before anything is installed: globals may fill three quarters of the arena (the rest is kept for the tables and
 * the frames, so no line can leave the session without room to run), one line may add at most three quarters of
 * its own limits' cells (so a line run with the default limits stays within them in an arena an elite line grew),
 * and a function whose frame and operand stack alone exceed the arena is refused rather than compiled with
 * operands no instruction could carry.
 * What breaks if it is removed? The checked tree has no way to become instructions the VM can run.
 */
import type { AssignOp, BinOp, Block, Call, Decl, Expr, FnDecl, IfExpr, Stmt, Ty } from './ast.ts'
import { NoirError, T, isVector, laneCount, laneTy, tyEq, tyWidth } from './ast.ts'
import type { Checked } from './types.ts'
import type { CompiledFn } from './vm.ts'
import { Op, align16 } from './vm.ts'

/** What a compiled line adds to the session, and the code to run now. */
export interface CompiledLine {
  readonly main: CompiledFn
  readonly fns: readonly CompiledFn[]
  readonly globals: readonly Decl[]
  /** The fns and globals the line declared, in the order they are written. */
  readonly defined: readonly string[]
  readonly globalTop: number
}

/** Where the line's globals go: above the session's, in an arena of `cells`, adding at most what `lineCells` allows. */
export interface Layout { readonly globalTop: number; readonly cells: number; readonly lineCells: number }

const tyOf = (e: Expr): Ty => {
  if (e.ty === undefined) throw new NoirError('internal error: unchecked expression')
  return e.ty
}

/** An expression that cannot fail and does nothing: a name or a literal (an array literal of them included). */
const pure = (e: Expr): boolean => e.kind === 'ident' || e.kind === 'int' || e.kind === 'float' || e.kind === 'bool' || (e.kind === 'fill' && pure(e.value)) || (e.kind === 'array' && e.elems.every(pure))

/** The flag an indexing instruction carries so a bounds error names a u32 index unsigned. */
const unsignedIndex = (index: Expr): number => (tyOf(index).kind === 'u32' ? 1 : 0)

/** The bit pattern of an f32, as the i32 the program stores inline. */
const F32_BITS = new Float32Array(1)
const I32_BITS = new Int32Array(F32_BITS.buffer)
export function f32Bits(x: number): number {
  F32_BITS[0] = x
  return I32_BITS[0]!
}

/** The opcode of a lane-wise arithmetic or comparison operator for the lane type. */
function opFor(op: BinOp, lane: Ty): number {
  const k = lane.kind
  switch (op) {
    case '+': return k === 'f32' ? Op.ADD_F32 : k === 'u32' ? Op.ADD_U32 : Op.ADD_I32
    case '-': return k === 'f32' ? Op.SUB_F32 : k === 'u32' ? Op.SUB_U32 : Op.SUB_I32
    case '*': return k === 'f32' ? Op.MUL_F32 : k === 'u32' ? Op.MUL_U32 : Op.MUL_I32
    case '/': return k === 'f32' ? Op.DIV_F32 : k === 'u32' ? Op.DIV_U32 : Op.DIV_I32
    case '%': return k === 'f32' ? Op.REM_F32 : k === 'u32' ? Op.REM_U32 : Op.REM_I32
    case '&': return Op.AND_32
    case '|': return Op.OR_32
    case '^': return Op.XOR_32
    case '<<': return Op.SHL_32
    case '>>': return k === 'u32' ? Op.SHR_U32 : Op.SHR_I32
    case '==': return k === 'f32' ? Op.EQ_F32 : Op.EQ_32
    case '!=': return k === 'f32' ? Op.NE_F32 : Op.NE_32
    case '<': return k === 'f32' ? Op.LT_F32 : k === 'u32' ? Op.LT_U32 : Op.LT_I32
    case '<=': return k === 'f32' ? Op.LE_F32 : k === 'u32' ? Op.LE_U32 : Op.LE_I32
    case '>': return k === 'f32' ? Op.GT_F32 : k === 'u32' ? Op.GT_U32 : Op.GT_I32
    case '>=': return k === 'f32' ? Op.GE_F32 : k === 'u32' ? Op.GE_U32 : Op.GE_I32
    default: throw new NoirError(`internal error: no opcode for ${op}`)
  }
}

interface Loop { readonly breaks: number[]; readonly continues: number[]; readonly depth: number }

/** The code of one function (or the line's main) as it is built. */
class FnBuilder {
  readonly code: number[] = []
  readonly strs: string[] = []
  readonly types: Ty[] = []
  /** The next free frame offset, and the most the frame ever needed. */
  frameTop: number
  frameMax: number
  /** The operand stack's depth in cells now, and its ceiling. */
  depth = 0
  maxDepth = 0
  readonly loops: Loop[] = []

  constructor(paramCells: number) {
    this.frameTop = paramCells
    this.frameMax = paramCells
  }

  emit(...words: number[]): void { for (const w of words) this.code.push(w) }
  /** Emits an instruction whose last operand is a jump destination to patch later; returns the operand's index. */
  jump(op: number): number { this.code.push(op, -1); return this.code.length - 1 }
  patch(operandAt: number, to: number): void { this.code[operandAt] = to }
  here(): number { return this.code.length }

  push(cells: number): void { this.depth += cells; if (this.depth > this.maxDepth) this.maxDepth = this.depth }
  pop(cells: number): void { this.depth -= cells }

  alloc(cells: number): number {
    const slot = this.frameTop
    this.frameTop += cells
    if (this.frameTop > this.frameMax) this.frameMax = this.frameTop
    return slot
  }

  str(s: string): number {
    const i = this.strs.indexOf(s)
    if (i >= 0) return i
    this.strs.push(s)
    return this.strs.length - 1
  }

  type(t: Ty): number {
    const i = this.types.findIndex((u) => tyEq(u, t))
    if (i >= 0) return i
    this.types.push(t)
    return this.types.length - 1
  }

  finish(name: string, params: readonly Ty[], ret: Ty, paramCells: number): CompiledFn {
    return Object.freeze({
      name, params, ret, code: Int32Array.from(this.code), strs: Object.freeze([...this.strs]), types: Object.freeze([...this.types]),
      paramCells, frameSize: this.frameMax, maxStack: this.maxDepth, retCells: tyWidth(ret),
    })
  }
}

class Compiler {
  private b: FnBuilder = new FnBuilder(0)

  compileFn(f: FnDecl): CompiledFn {
    const sig = f.sig!
    let cells = 0
    for (const p of sig.params) cells += tyWidth(p)
    this.b = new FnBuilder(cells)
    // Parameters are the frame's first cells, in order.
    let off = 0
    for (const d of f.paramDecls!) { d.slot = off; off += tyWidth(d.ty) }
    this.block(f.body)
    this.b.emit(Op.RET, tyWidth(sig.ret))
    return this.b.finish(f.name, sig.params, sig.ret, cells)
  }

  compileMain(items: readonly (FnDecl | Stmt)[]): CompiledFn {
    this.b = new FnBuilder(0)
    for (const it of items) if (it.kind !== 'fn') this.stmt(it)
    this.b.emit(Op.RET, 0)
    return this.b.finish('<main>', [], T.void, 0)
  }

  // ---- statements ----

  private block(blk: Block): void {
    const mark = this.b.frameTop
    for (const s of blk.stmts) this.stmt(s)
    if (blk.tail !== null) this.expr(blk.tail)
    this.b.frameTop = mark
  }

  private stmt(s: Stmt): void {
    const base = this.b.depth
    switch (s.kind) {
      case 'let': {
        const d = s.decl!
        const w = tyWidth(d.ty)
        const global = d.kind === 'global'
        if (!global) d.slot = this.b.alloc(w)
        // An array filled with one value is filled in place, so the value never crosses the operand stack n times.
        if (s.init.kind === 'fill' && s.init.n > 1) {
          this.expr(s.init.value)
          const ew = tyWidth(tyOf(s.init.value))
          this.b.emit(global ? Op.FILL_GLOBAL : Op.FILL_LOCAL, d.slot, ew, s.init.n)
          this.b.pop(ew)
        } else {
          this.expr(s.init)
          this.b.emit(global ? Op.STORE_GLOBAL : Op.STORE_LOCAL, d.slot, w)
          this.b.pop(w)
        }
        break
      }
      case 'assign': this.assign(s.ref!, s.index, s.op, s.value); break
      case 'if': {
        this.expr(s.cond)
        const toElse = this.b.jump(Op.JMP_IF_NOT)
        this.b.pop(1)
        this.block(s.then)
        if (s.else === null) { this.b.patch(toElse, this.b.here()); break }
        const toEnd = this.b.jump(Op.JMP)
        this.b.patch(toElse, this.b.here())
        if ('kind' in s.else && s.else.kind === 'if') this.stmt(s.else)
        else this.block(s.else as Block)
        this.b.patch(toEnd, this.b.here())
        break
      }
      case 'while': {
        const top = this.b.here()
        this.expr(s.cond)
        const exit = this.b.jump(Op.JMP_IF_NOT)
        this.b.pop(1)
        const loop: Loop = { breaks: [], continues: [], depth: this.b.depth }
        this.b.loops.push(loop)
        this.block(s.body)
        this.b.loops.pop()
        this.b.emit(Op.JMP, top)
        this.closeLoop(loop, top, exit)
        break
      }
      case 'loop': {
        const top = this.b.here()
        const loop: Loop = { breaks: [], continues: [], depth: this.b.depth }
        this.b.loops.push(loop)
        this.block(s.body)
        this.b.loops.pop()
        this.b.emit(Op.JMP, top)
        this.closeLoop(loop, top, -1)
        break
      }
      case 'for': {
        const d = s.decl!
        const unsigned = d.ty.kind === 'u32'
        const mark = this.b.frameTop
        d.slot = this.b.alloc(1)
        const end = this.b.alloc(1)
        this.expr(s.from)
        this.b.emit(Op.STORE_LOCAL, d.slot, 1)
        this.b.pop(1)
        this.expr(s.to)
        this.b.emit(Op.STORE_LOCAL, end, 1)
        this.b.pop(1)
        const top = this.b.here()
        this.b.emit(Op.LOAD_LOCAL, d.slot, 1, Op.LOAD_LOCAL, end, 1)
        this.b.emit(s.inclusive ? (unsigned ? Op.LE_U32 : Op.LE_I32) : unsigned ? Op.LT_U32 : Op.LT_I32, 1)
        const exit = this.b.jump(Op.JMP_IF_NOT)
        const loop: Loop = { breaks: [], continues: [], depth: this.b.depth }
        this.b.loops.push(loop)
        this.block(s.body)
        this.b.loops.pop()
        const cont = this.b.here()
        if (s.inclusive) {
          // Stop when the variable has reached the bound, so a bound at the type's maximum never wraps.
          this.b.emit(Op.LOAD_LOCAL, d.slot, 1, Op.LOAD_LOCAL, end, 1, Op.EQ_32, 1)
          loop.breaks.push(this.b.jump(Op.JMP_IF))
        }
        this.b.emit(Op.LOAD_LOCAL, d.slot, 1, Op.PUSH, 1, Op.ADD_I32, 1, Op.STORE_LOCAL, d.slot, 1, Op.JMP, top)
        this.b.push(2)
        this.b.pop(2)
        this.closeLoop(loop, cont, exit)
        this.b.frameTop = mark
        break
      }
      case 'break':
      case 'continue': {
        const loop = this.b.loops[this.b.loops.length - 1]!
        // Anything an enclosing expression left on the operand stack goes, so the loop's depth stays exact.
        if (this.b.depth > loop.depth) this.b.emit(Op.DROP, this.b.depth - loop.depth)
        ;(s.kind === 'break' ? loop.breaks : loop.continues).push(this.b.jump(Op.JMP))
        break
      }
      case 'return': {
        if (s.value !== null) {
          this.expr(s.value)
          this.b.emit(Op.RET, tyWidth(tyOf(s.value)))
        } else this.b.emit(Op.RET, 0)
        break
      }
      case 'block': this.block(s.block); break
      case 'expr': {
        this.expr(s.e)
        const w = tyWidth(tyOf(s.e))
        if (w > 0) this.b.emit(Op.DROP, w)
        break
      }
    }
    this.b.depth = base
  }

  private closeLoop(loop: Loop, cont: number, exit: number): void {
    const end = this.b.here()
    if (exit >= 0) this.b.patch(exit, end)
    for (const p of loop.breaks) this.b.patch(p, end)
    for (const p of loop.continues) this.b.patch(p, cont)
  }

  private assign(d: Decl, index: Expr | null, op: AssignOp, value: Expr): void {
    const global = d.kind === 'global'
    if (index === null) {
      const w = tyWidth(d.ty)
      if (op !== '=') {
        this.b.emit(global ? Op.LOAD_GLOBAL : Op.LOAD_LOCAL, d.slot, w)
        this.b.push(w)
        this.expr(value)
        this.binaryOp(op.slice(0, -1) as BinOp, d.ty, tyOf(value))
      } else this.expr(value)
      this.b.emit(global ? Op.STORE_GLOBAL : Op.STORE_LOCAL, d.slot, w)
      this.b.pop(w)
      return
    }
    const elem = laneTy(d.ty)
    const ew = tyWidth(elem)
    const n = d.ty.kind === 'array' ? d.ty.n : laneCount(d.ty)
    this.expr(index)
    const u = unsignedIndex(index)
    if (op !== '=') {
      this.b.emit(Op.DUP, 1)
      this.b.push(1)
      this.b.emit(global ? Op.LOAD_GLOBAL_ELEM : Op.LOAD_LOCAL_ELEM, d.slot, ew, n, u)
      this.b.pop(1)
      this.b.push(ew)
      this.expr(value)
      this.binaryOp(op.slice(0, -1) as BinOp, elem, tyOf(value))
    } else this.expr(value)
    this.b.emit(global ? Op.STORE_GLOBAL_ELEM : Op.STORE_LOCAL_ELEM, d.slot, ew, n, u)
    this.b.pop(ew + 1)
  }

  // ---- expressions: each leaves exactly width(type) cells ----

  private expr(e: Expr): void {
    const t = tyOf(e)
    switch (e.kind) {
      case 'int': {
        const bits = t.kind === 'f32' || t.kind === 'f32x4' ? f32Bits(e.value) : e.value | 0
        this.b.emit(Op.PUSH, bits)
        this.b.push(1)
        if (e.splat > 1) {
          this.b.emit(Op.FILL, 1, e.splat)
          this.b.push(e.splat - 1)
        }
        return
      }
      case 'float': this.b.emit(Op.PUSH, f32Bits(e.value)); this.b.push(1); return
      case 'bool': this.b.emit(Op.PUSH, e.value ? 1 : 0); this.b.push(1); return
      case 'str': this.b.emit(Op.PUSH, this.b.str(e.value)); this.b.push(1); return
      case 'ident': {
        const d = e.ref!
        if (d.kind === 'qcol') { this.b.emit(Op.QCOL, d.colId, d.rowSlot); this.b.push(1); return }
        const w = tyWidth(d.ty)
        this.b.emit(d.kind === 'global' ? Op.LOAD_GLOBAL : Op.LOAD_LOCAL, d.slot, w)
        this.b.push(w)
        return
      }
      case 'unary': {
        this.expr(e.e)
        const lanes = laneCount(t)
        if (e.op === '!') this.b.emit(Op.NOT_BOOL)
        else if (e.op === '~') this.b.emit(Op.NOT_32, lanes)
        else this.b.emit(laneTy(t).kind === 'f32' ? Op.NEG_F32 : Op.NEG_I32, lanes)
        return
      }
      case 'binary': {
        if (e.op === '&&' || e.op === '||') {
          // Short circuit: keep the left value when it decides, else replace it with the right one. The DUP holds
          // two cells for a moment, so the ceiling counts it.
          this.expr(e.l)
          this.b.emit(Op.DUP, 1)
          this.b.push(1)
          const skip = this.b.jump(e.op === '&&' ? Op.JMP_IF_NOT : Op.JMP_IF)
          this.b.pop(1)
          this.b.emit(Op.DROP, 1)
          this.b.pop(1)
          this.expr(e.r)
          this.b.patch(skip, this.b.here())
          return
        }
        this.expr(e.l)
        this.expr(e.r)
        this.binaryOp(e.op, tyOf(e.l), tyOf(e.r))
        return
      }
      case 'cast': {
        this.expr(e.e)
        const s = laneTy(tyOf(e.e)).kind
        const d = laneTy(t).kind
        const lanes = laneCount(t)
        if (s === d || (s !== 'f32' && d !== 'f32')) return
        if (d === 'f32') this.b.emit(s === 'u32' ? Op.U32_TO_F32 : Op.I32_TO_F32, lanes)
        else this.b.emit(d === 'u32' ? Op.F32_TO_U32 : Op.F32_TO_I32, lanes)
        return
      }
      case 'call': this.call(e); return
      case 'index': {
        const a = tyOf(e.e)
        if (a.kind === 'col') {
          this.expr(e.e)
          this.expr(e.index)
          this.b.emit(Op.COL_ELEM, unsignedIndex(e.index))
          this.b.pop(1)
          return
        }
        const ew = tyWidth(laneTy(a))
        const n = a.kind === 'array' ? a.n : laneCount(a)
        this.element(e.e, e.index, ew, n)
        return
      }
      case 'field': {
        const r = e.ref!
        switch (r.kind) {
          case 'n': this.b.emit(Op.TABLE_N, r.table); this.b.push(1); return
          case 'col': this.b.emit(Op.TABLE_COL, r.colId); this.b.push(1); return
          case 'scalar': this.b.emit(Op.TABLE_SCALAR, r.scalarId); this.b.push(1); return
          case 'lane': {
            const lane: Expr = { kind: 'int', value: r.lane, suffixed: false, splat: 0, ty: T.i32, line: e.line, col: e.col }
            this.element(e.e, lane, 1, laneCount(tyOf(e.e)))
            return
          }
        }
        return
      }
      case 'method': {
        const a = tyOf(e.e)
        if (a.kind === 'col') { this.expr(e.e); this.b.emit(Op.COL_LEN); return }
        // The length is in the type, so a pure receiver is not built; any other still runs (its calls, its bounds checks).
        if (!pure(e.e)) {
          this.expr(e.e)
          const w = tyWidth(a)
          if (w > 0) this.b.emit(Op.DROP, w)
          this.b.pop(w)
        }
        this.b.emit(Op.PUSH, a.kind === 'array' ? a.n : laneCount(a))
        this.b.push(1)
        return
      }
      case 'fill': {
        this.expr(e.value)
        const ew = tyWidth(tyOf(e.value))
        if (e.n > 1) { this.b.emit(Op.FILL, ew, e.n); this.b.push(ew * (e.n - 1)) }
        return
      }
      case 'array': for (const x of e.elems) this.expr(x); return
      case 'query': this.query(e); return
      case 'if': this.ifExpr(e, tyWidth(t)); return
    }
  }

  /** `a[i]` for an array or vector: straight from the variable's cells when `a` is one, else from the value. */
  private element(a: Expr, index: Expr, ew: number, n: number): void {
    if (a.kind === 'ident' && a.ref !== undefined && a.ref.kind !== 'qcol') {
      const d = a.ref
      this.expr(index)
      this.b.emit(d.kind === 'global' ? Op.LOAD_GLOBAL_ELEM : Op.LOAD_LOCAL_ELEM, d.slot, ew, n, unsignedIndex(index))
      this.b.pop(1)
      this.b.push(ew)
      return
    }
    this.expr(a)
    this.expr(index)
    this.b.emit(Op.INDEX, ew, n, unsignedIndex(index))
    this.b.pop(1 + n * ew)
    this.b.push(ew)
  }

  /** The typed opcode of `l op r` with both operands on the stack (the checker made the types equal). */
  private binaryOp(op: BinOp, lt: Ty, rt: Ty): void {
    const lanes = laneCount(lt)
    this.b.emit(opFor(op, laneTy(lt)), lanes)
    this.b.pop(tyWidth(rt))
    const compare = op === '==' || op === '!=' || op === '<' || op === '<=' || op === '>' || op === '>='
    if (compare) { this.b.pop(tyWidth(lt)); this.b.push(1) }
  }

  private call(e: Call): void {
    const r = e.ref!
    let argCells = 0
    for (const a of e.args) { this.expr(a); argCells += tyWidth(tyOf(a)) }
    switch (r.kind) {
      case 'print': {
        this.b.emit(Op.PRINT, e.args.length)
        for (const a of e.args) this.b.emit(this.b.type(tyOf(a)))
        this.b.pop(argCells)
        return
      }
      case 'intrinsic': {
        if (r.code.length > 0) this.b.emit(...r.code)
        this.b.pop(argCells)
        this.b.push(tyWidth(r.ret))
        return
      }
      case 'fn': {
        this.b.emit(Op.CALL, r.sig.index)
        this.b.pop(argCells)
        this.b.push(tyWidth(r.sig.ret))
        return
      }
    }
  }

  private ifExpr(e: IfExpr, w: number): void {
    const base = this.b.depth
    this.expr(e.cond)
    const toElse = this.b.jump(Op.JMP_IF_NOT)
    this.b.pop(1)
    this.block(e.then)
    this.b.depth = base + w
    const toEnd = this.b.jump(Op.JMP)
    this.b.patch(toElse, this.b.here())
    this.b.depth = base
    if ('stmts' in e.else) this.block(e.else)
    else this.ifExpr(e.else, w)
    this.b.depth = base + w
    this.b.patch(toEnd, this.b.here())
  }

  /** `query T where p`: a loop over the table's rows counting the rows where p holds, in two hidden locals (the
   *  row and the count); a column in scope reads straight from the snapshot's register file by its id (QCOL). */
  private query(e: { tableId: number; cols: Decl[]; where: Expr }): void {
    const mark = this.b.frameTop
    const row = this.b.alloc(1)
    const count = this.b.alloc(1)
    this.b.emit(Op.PUSH, 0, Op.STORE_LOCAL, row, 1, Op.PUSH, 0, Op.STORE_LOCAL, count, 1)
    this.b.push(1)
    this.b.pop(1)
    for (const c of e.cols) c.rowSlot = row
    const top = this.b.here()
    this.b.emit(Op.QNEXT, row, e.tableId)
    const exit = this.b.here()
    this.b.emit(-1)
    this.expr(e.where)
    this.b.emit(Op.QACC, count, row, Op.JMP, top)
    this.b.pop(1)
    this.b.patch(exit, this.b.here())
    this.b.emit(Op.LOAD_LOCAL, count, 1)
    this.b.push(1)
    this.b.frameTop = mark
  }
}

/** The cells globals may fill: three quarters of the arena. The last quarter is for the tables and the frames. */
export const globalCeiling = (cells: number): number => cells - (cells >> 2)

/** A function that could never run in the arena, whatever else is in it, is refused at compile time. */
function fits(f: CompiledFn, cells: number): CompiledFn {
  if (f.frameSize + f.maxStack > cells) throw new NoirError('memory exhausted')
  return f
}

/** Places the line's new globals above the session's and compiles its functions and top-level code. */
export function compile(checked: Checked, layout: Layout): CompiledLine {
  let top = layout.globalTop
  // Three quarters of the arena in all, and one line adds at most three quarters of its own limits' cells.
  const ceiling = Math.min(globalCeiling(layout.cells), layout.globalTop + globalCeiling(layout.lineCells))
  for (const g of checked.globals) {
    const w = tyWidth(g.ty)
    if (g.ty.kind === 'array') top = align16(top)
    else if (isVector(g.ty)) top = (top + 3) & ~3
    g.slot = top
    top += w
    if (top > ceiling) throw new NoirError('memory exhausted')
  }
  const c = new Compiler()
  const fns = checked.fns.map((f) => fits(c.compileFn(f), layout.cells))
  const main = fits(c.compileMain(checked.program.items), layout.cells)
  return { main, fns, globals: checked.globals, defined: checked.defined, globalTop: top }
}
