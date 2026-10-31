// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is NoirScript's static checker: every expression gets exactly one type and every name
 * one declaration before anything compiles, so the VM never meets a value it did not expect. It owns the rules the
 * specification states: no implicit conversions except an unsuffixed integer literal adopting u32 or f32 from the
 * other operand, a declared type, a parameter or a return type; `as` only between the scalar numbers (and bool to
 * an integer, and lane-wise between the 4-lane vectors); immutability of `let`, parameters and loop variables;
 * shadowing only in inner blocks; declaration before use; functions at the top level with full signatures, checked
 * in two passes so they may recurse mutually; `query` scopes that put a table's columns in scope as the row's
 * scalars; a value left over at the end of a statement refused by name; and a non-void function that must return on
 * every path. Overloaded intrinsics resolve by argument type against the intrinsics table. Every refusal names a
 * line and column and both types when two are involved. The checker writes its findings onto the tree.
 * What breaks if it is removed? Ill-typed programs would reach the compiler and the VM would read cells as the
 * wrong type, or crash on a shape the bytecode has no instruction for.
 */
import type { ArrayLit, AssignStmt, Binary, BinOp, Block, Call, Cast, Decl, Expr, Field, FnDecl, FnSig, IfExpr, IfStmt, Index, IntLit, Method, Pos, Program, Query, Stmt, Ty, Unary } from './ast.ts'
import { T, arrayTy, isInteger, isNumeric, isVector, laneCount, laneTy, tyEq, tyName } from './ast.ts'
import type { Intrinsic } from './intrinsics.ts'
import { INTRINSICS } from './intrinsics.ts'
import { at } from './lexer.ts'
import { MAX_NESTING } from './parser.ts'
import { COLUMNS, SCALARS, TABLE_NAMES } from './vm.ts'

/** What a line is checked against: the session's globals and functions, and the index its first new fn will take. */
export interface Env {
  readonly globals: ReadonlyMap<string, Decl>
  readonly fns: ReadonlyMap<string, FnSig>
  readonly nextFnIndex: number
}

/** The annotated program, its new functions (in index order), its new globals (in declaration order) and the names it defined. */
export interface Checked {
  readonly program: Program
  readonly fns: readonly FnDecl[]
  readonly globals: readonly Decl[]
  readonly defined: readonly string[]
}

function fail(p: Pos, message: string): never { throw at(p.line, p.col, message) }

/** An unsuffixed integer literal, which may still adopt a type from its context. */
const adoptable = (e: Expr): e is IntLit => e.kind === 'int' && !e.suffixed

function fits(v: number, t: Ty): boolean {
  switch (t.kind) {
    case 'i32': return v >= -2147483648 && v <= 2147483647
    case 'u32': return v >= 0 && v <= 4294967295
    case 'f32': return true
    default: return false
  }
}

/** The type a literal would adopt from `t`: only u32 and f32 ever change a literal's type. */
const adoptionHint = (t: Ty): Ty | null => (t.kind === 'u32' || t.kind === 'f32' ? t : null)

const VECTOR_COMPARE: Readonly<Record<string, string>> = Object.freeze({ '<': 'vlt', '<=': 'vle', '>': 'vgt', '>=': 'vge', '==': 'veq', '!=': 'vne' })

const mkDecl = (kind: Decl['kind'], name: string, ty: Ty, mutable: boolean, colId = -1): Decl => ({ kind, name, ty, mutable, slot: -1, colId, rowSlot: -1 })

/** The fields a table offers, for the message when one is missing. */
function fieldsOf(table: number): string[] {
  const names = table < 2 ? ['n'] : []
  for (const c of COLUMNS) if (c.table === table) names.push(c.name)
  for (const s of SCALARS) if (s.table === table) names.push(s.name)
  return names
}

class Checker {
  /** Innermost scope last; the first is the session's globals, the second the line's top level. */
  private readonly scopes: Map<string, Decl>[]
  private readonly fnSigs: Map<string, FnSig>
  private fn: { readonly name: string; readonly ret: Ty } | null = null
  private readonly loops: { broke: boolean }[] = []
  private readonly newFns: FnDecl[] = []
  private readonly newGlobals: Decl[] = []
  private readonly defined: string[] = []
  private readonly env: Env
  /** Open expressions and blocks: the tree's depth, which the parser's own guard does not bound for a long
   *  left-leaning chain (`1 + 1 + 1 ...` is parsed in a loop), so the checker and the compiler never recurse past it. */
  private depth = 0

  constructor(env: Env) {
    this.env = env
    this.scopes = [new Map(env.globals), new Map()]
    this.fnSigs = new Map(env.fns)
  }

  check(program: Program): Checked {
    // Pass 1: every fn's signature, so bodies may call forward and recurse mutually.
    for (const item of program.items) {
      if (item.kind !== 'fn') continue
      this.reserved(item.name, item.namePos, 'redefined')
      // One namespace: a name is a fn or a variable, never both (pinned where the spec is silent).
      if (this.lookup(item.name) !== undefined) fail(item.namePos, `'${item.name}' is a variable and cannot be a fn`)
      if (this.newFns.some((f) => f.name === item.name)) fail(item.namePos, `fn '${item.name}' already declared on this line`)
      for (const p of item.params) {
        if (p.ty.kind === 'void') fail(p, `parameter '${p.name}' cannot be void`)
        if (item.params.some((q) => q !== p && q.name === p.name)) fail(p, `parameter '${p.name}' declared twice`)
        this.reserved(p.name, p, 'declared')
      }
      const sig: FnSig = { name: item.name, params: item.params.map((p) => p.ty), ret: item.ret, index: this.env.nextFnIndex + this.newFns.length }
      item.sig = sig
      this.fnSigs.set(item.name, sig)
      this.newFns.push(item)
    }
    // Pass 2: bodies and statements in order, so a fn sees the globals declared above it.
    for (const item of program.items) {
      if (item.kind === 'fn') this.fnBody(item)
      else this.stmt(item)
    }
    // The names the line defined, in the order they are written (a top-level let is always a global).
    for (const item of program.items) if (item.kind === 'fn' || item.kind === 'let') this.define(item.name)
    return { program, fns: this.newFns, globals: this.newGlobals, defined: this.defined }
  }

  private define(name: string): void {
    if (!this.defined.includes(name)) this.defined.push(name)
  }

  private reserved(name: string, p: Pos, verb: string): void {
    if (TABLE_NAMES.includes(name)) fail(p, `'${name}' is a table and cannot be ${verb}`)
    if (INTRINSICS.has(name)) fail(p, `'${name}' is an intrinsic and cannot be ${verb}`)
  }

  private lookup(name: string): Decl | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const d = this.scopes[i]!.get(name)
      if (d !== undefined) return d
    }
    return undefined
  }

  private bind(d: Decl, p: Pos): void {
    this.reserved(d.name, p, 'declared')
    if (this.fnSigs.has(d.name)) fail(p, `'${d.name}' is a fn and cannot be declared`)
    const scope = this.scopes[this.scopes.length - 1]!
    if (scope.has(d.name)) fail(p, `'${d.name}' already declared in this block`)
    scope.set(d.name, d)
  }

  private get atTopLevel(): boolean { return this.fn === null && this.scopes.length === 2 }

  // ---- functions and blocks ----

  private fnBody(f: FnDecl): void {
    this.fn = { name: f.name, ret: f.ret }
    f.paramDecls = f.params.map((p) => mkDecl('param', p.name, p.ty, false))
    // The body is the parameters' block: `fn f(a: i32) { let a = 2; }` redeclares `a`, and an inner block may shadow it.
    const t = this.blockValue(f.body, f.ret, () => {
      for (let i = 0; i < f.params.length; i++) this.bind(f.paramDecls![i]!, f.params[i]!)
    })
    this.fn = null
    if (t === null) return
    if (f.ret.kind === 'void') {
      if (t.kind !== 'void') fail(f.body.tail!, "value not used: end it with ';'")
      return
    }
    if (f.body.tail === null) fail(f.body.end, `missing return in fn '${f.name}' -> ${tyName(f.ret)}`)
    if (!tyEq(t, f.ret)) fail(f.body.tail, `fn '${f.name}' -> ${tyName(f.ret)} ends with a ${tyName(t)} value`)
  }

  /**
   * A block whose value is wanted (a fn body, an if-expression arm): its type, or null when it always returns.
   * Without a tail the value is void. The scope the block opens is popped before returning; `open` binds into it
   * first (a fn's parameters).
   */
  private blockValue(b: Block, hint: Ty | null, open?: () => void): Ty | null {
    this.enter(b)
    this.scopes.push(new Map())
    if (open !== undefined) open()
    let diverges = false
    for (const s of b.stmts) if (this.stmt(s)) diverges = true
    let t: Ty | null = T.void
    if (b.tail !== null) t = b.tail.kind === 'if' ? this.ifValue(b.tail, hint, false) : this.expr(b.tail, hint)
    this.scopes.pop()
    this.depth--
    return diverges ? null : t
  }

  private enter(p: Pos): void {
    if (++this.depth > MAX_NESTING) fail(p, `nesting deeper than ${MAX_NESTING} levels`)
  }

  /** A block in statement position: a value left at its end is an error. Returns whether it always returns. `open`
   *  binds into the block's scope first (a for loop's variable, whose block the body is). */
  private blockStmt(b: Block, open?: () => void): boolean {
    this.enter(b)
    this.scopes.push(new Map())
    if (open !== undefined) open()
    let diverges = false
    for (const s of b.stmts) if (this.stmt(s)) diverges = true
    if (b.tail !== null) {
      const t = b.tail.kind === 'if' ? this.ifValue(b.tail, null, true) : this.expr(b.tail, null)
      if (t === null) diverges = true
      else if (t.kind !== 'void') fail(b.tail, "value not used: end it with ';'")
    }
    this.scopes.pop()
    this.depth--
    return diverges
  }

  /** An if with an else on every path, used for its value. `statement` names the error when an arm leaves a value. */
  private ifValue(e: IfExpr, hint: Ty | null, statement: boolean): Ty | null {
    this.condition(e.cond)
    const elseArm = (): Ty | null => ('stmts' in e.else ? this.blockValue(e.else, hint) : this.ifValue(e.else, hint, statement))
    // The arm that is not a bare literal is checked first, so the literal arm can adopt its type.
    let thenT: Ty | null
    let elseT: Ty | null
    if (e.then.tail !== null && adoptable(e.then.tail) && !('stmts' in e.else && e.else.tail !== null && adoptable(e.else.tail))) {
      elseT = elseArm()
      thenT = this.blockValue(e.then, elseT !== null ? adoptionHint(elseT) ?? hint : hint)
    } else {
      thenT = this.blockValue(e.then, hint)
      // The checked arm's type reaches the literals of the other arm, through an else-if chain as well.
      const elseHint = thenT !== null ? adoptionHint(thenT) ?? hint : hint
      elseT = 'stmts' in e.else ? this.blockValue(e.else, elseHint) : this.ifValue(e.else, elseHint, statement)
    }
    let t: Ty | null
    if (thenT === null) t = elseT
    else if (elseT === null) t = thenT
    else if (tyEq(thenT, elseT)) t = thenT
    else if (statement) {
      const arm = thenT.kind !== 'void' ? e.then.tail! : ('stmts' in e.else ? e.else.tail! : e.else)
      fail(arm, "value not used: end it with ';'")
    } else fail(e, `if branches differ: ${tyName(thenT)} and ${tyName(elseT)}`)
    e.ty = t ?? T.void
    return t
  }

  private condition(c: Expr): void {
    const t = this.expr(c, null)
    if (t.kind !== 'bool') fail(c, `condition must be bool, got ${tyName(t)}`)
  }

  // ---- statements ----

  /** Checks one statement; true when it always returns (so what follows is unreachable). */
  private stmt(s: Stmt): boolean {
    switch (s.kind) {
      case 'let': {
        let t: Ty
        if (s.declared !== null) {
          t = this.expr(s.init, s.declared)
          if (!tyEq(t, s.declared)) fail(s.init, `cannot initialize ${tyName(s.declared)} '${s.name}' with ${tyName(t)}`)
        } else t = this.expr(s.init, null)
        if (t.kind === 'void') fail(s.init, `cannot bind '${s.name}' to void`)
        const top = this.atTopLevel
        const d = mkDecl(top ? 'global' : 'local', s.name, t, s.mutable)
        this.bind(d, s.namePos)
        s.decl = d
        if (top) this.newGlobals.push(d)
        return false
      }
      case 'assign': return this.assign(s)
      case 'if': return this.ifStmt(s)
      case 'while': {
        this.condition(s.cond)
        this.loops.push({ broke: false })
        this.blockStmt(s.body)
        this.loops.pop()
        return false
      }
      case 'loop': {
        const frame = { broke: false }
        this.loops.push(frame)
        const diverges = this.blockStmt(s.body)
        this.loops.pop()
        return diverges || !frame.broke
      }
      case 'for': {
        // The bound that is not a bare literal is checked first and named first, so `0..1.0` blames the `1.0`, not
        // the `0` that would have adopted its type; when both bounds are typed, the second is the one that differs.
        const bound = (e: Expr, hint: Ty | null): Ty => {
          const t = this.expr(e, hint)
          if (!isInteger(t)) fail(e, `for bounds must be i32 or u32, got ${tyName(t)}`)
          return t
        }
        let from: Ty
        let to: Ty
        if (adoptable(s.from) && !adoptable(s.to)) { to = bound(s.to, null); from = bound(s.from, adoptionHint(to)) }
        else { from = bound(s.from, null); to = bound(s.to, adoptionHint(from)) }
        if (!tyEq(from, to)) fail(s.to, `for bounds differ: ${tyName(from)}${s.inclusive ? '..=' : '..'}${tyName(to)}`)
        // The body is the loop variable's block, as a fn body is its parameters': `for i in 0..2 { let i = 1; }` redeclares.
        const d = mkDecl('for', s.name, from, false)
        s.decl = d
        this.loops.push({ broke: false })
        this.blockStmt(s.body, () => this.bind(d, s.namePos))
        this.loops.pop()
        return false
      }
      case 'break':
      case 'continue': {
        const loop = this.loops[this.loops.length - 1]
        if (loop === undefined) fail(s, `'${s.kind}' outside a loop`)
        if (s.kind === 'break') loop.broke = true
        return false
      }
      case 'return': {
        if (this.fn === null) fail(s, "'return' outside a fn")
        const ret = this.fn.ret
        if (s.value === null) {
          if (ret.kind !== 'void') fail(s, `fn '${this.fn.name}' -> ${tyName(ret)}: 'return' needs a value`)
          return true
        }
        if (ret.kind === 'void') fail(s.value, `fn '${this.fn.name}' returns nothing: 'return' takes no value`)
        const t = this.expr(s.value, ret)
        if (!tyEq(t, ret)) fail(s.value, `fn '${this.fn.name}' -> ${tyName(ret)}: cannot return ${tyName(t)}`)
        return true
      }
      case 'block': return this.blockStmt(s.block)
      case 'expr': {
        const t = this.expr(s.e, null)
        if (t.kind !== 'void' && s.e.kind !== 'call') fail(s, 'value not used')
        return false
      }
    }
  }

  private ifStmt(s: IfStmt): boolean {
    this.condition(s.cond)
    const thenD = this.blockStmt(s.then)
    if (s.else === null) return false
    const elseD = 'kind' in s.else && s.else.kind === 'if' ? this.ifStmt(s.else) : this.blockStmt(s.else as Block)
    return thenD && elseD
  }

  private assign(s: AssignStmt): boolean {
    const { name, index, op, value } = s
    const p: Pos = s
    const d = this.lookup(name)
    if (d === undefined) {
      if (TABLE_NAMES.includes(name)) fail(p, `'${name}' is a table and cannot be assigned`)
      fail(p, `unknown name '${name}'`)
    }
    if (!d.mutable) fail(p, `cannot assign to immutable '${name}'`)
    s.ref = d
    let lt = d.ty
    let what = `'${name}'`
    if (index !== null) {
      if (d.ty.kind === 'col') fail(p, `cannot assign to a column '${name}' (read-only)`)
      if (d.ty.kind !== 'array' && !isVector(d.ty)) fail(p, `cannot index ${tyName(d.ty)}`)
      this.indexType(index)
      lt = laneTy(d.ty)
      what = `'${name}[..]'`
    }
    if (op === '=') {
      const rt = this.expr(value, lt)
      if (!tyEq(rt, lt)) fail(value, `cannot assign ${tyName(rt)} to ${tyName(lt)} ${what}`)
      return false
    }
    const bin = op.slice(0, -1) as BinOp
    const rt = this.rightOperand(lt, bin, value)
    const res = this.binaryResult(bin, lt, rt, p)
    if (!tyEq(res, lt)) fail(p, `'${op}' would turn ${tyName(lt)} ${what} into ${tyName(res)}`)
    return false
  }

  // ---- expressions ----

  /** The type of `e`, with `hint` the type an unsuffixed literal may adopt here (or null). Writes `e.ty`. */
  private expr(e: Expr, hint: Ty | null): Ty {
    this.enter(e)
    const t = this.exprInner(e, hint)
    this.depth--
    e.ty = t
    return t
  }

  private exprInner(e: Expr, hint: Ty | null): Ty {
    switch (e.kind) {
      case 'int': return this.literal(e, hint)
      case 'float': return T.f32
      case 'bool': return T.bool
      case 'str': {
        if (hint !== null && hint.kind === 'str') return T.str
        return fail(e, 'a string can only be an argument of print, println, tune or steer')
      }
      case 'ident': {
        const d = this.lookup(e.name)
        if (d === undefined) {
          if (TABLE_NAMES.includes(e.name)) fail(e, `'${e.name}' is a table: use its fields (${fieldsOf(TABLE_NAMES.indexOf(e.name)).map((f) => `${e.name}.${f}`).join(', ')})`)
          if (INTRINSICS.has(e.name) || this.fnSigs.has(e.name)) fail(e, `'${e.name}' is a fn: call it`)
          fail(e, `unknown name '${e.name}'`)
        }
        e.ref = d
        return d.ty
      }
      case 'unary': return this.unary(e)
      case 'binary': return this.binary(e)
      case 'cast': return this.cast(e)
      case 'call': return this.call(e)
      case 'index': return this.index(e)
      case 'field': return this.field(e)
      case 'method': return this.method(e)
      case 'fill': {
        const elemHint = hint !== null && hint.kind === 'array' ? hint.elem : null
        const t = this.expr(e.value, elemHint)
        this.elementType(t, e.value)
        return arrayTy(t, e.n)
      }
      case 'array': return this.arrayLit(e, hint)
      case 'query': return this.query(e)
      case 'if': return this.ifValue(e, hint, false) ?? T.void
    }
  }

  private literal(e: IntLit, hint: Ty | null): Ty {
    const t = e.suffixed ? T.u32 : hint !== null && (hint.kind === 'u32' || hint.kind === 'f32') ? hint : T.i32
    if (!fits(e.value, t)) fail(e, `literal ${e.value} does not fit ${tyName(t)}`)
    return t
  }

  private elementType(t: Ty, p: Pos): void {
    if (t.kind === 'void' || t.kind === 'str' || t.kind === 'col') fail(p, `an array cannot hold ${tyName(t)}`)
  }

  private arrayLit(e: ArrayLit, hint: Ty | null): Ty {
    let elem: Ty | null = hint !== null && hint.kind === 'array' ? hint.elem : null
    if (elem === null) {
      // The first element that is not a bare literal sets the element type the literals adopt.
      const lead = e.elems.find((x) => !adoptable(x))
      if (lead !== undefined) elem = this.expr(lead, null)
    }
    let first: Ty | null = null
    for (const x of e.elems) {
      const t = x.ty !== undefined && !adoptable(x) ? x.ty : this.expr(x, elem !== null ? adoptionHint(elem) ?? elem : null)
      if (first === null) { first = t; this.elementType(t, x) }
      else if (!tyEq(t, first)) fail(x, `array elements differ: ${tyName(first)} and ${tyName(t)}`)
    }
    return arrayTy(first!, e.elems.length)
  }

  private unary(e: Unary): Ty {
    const t = this.expr(e.e, null)
    switch (e.op) {
      case '-':
        if (t.kind === 'i32' || t.kind === 'f32' || t.kind === 'i32x4' || t.kind === 'f32x4') return t
        return fail(e, `unary '-' needs i32, f32, i32x4 or f32x4, got ${tyName(t)}`)
      case '!':
        if (t.kind === 'bool') return t
        return fail(e, `'!' needs bool, got ${tyName(t)}`)
      case '~':
        if (isInteger(t) || t.kind === 'i32x4' || t.kind === 'u32x4' || t.kind === 'u32x8') return t
        return fail(e, `'~' needs an integer type, got ${tyName(t)}`)
    }
  }

  /** The right operand of a binary op whose left type is known: a literal adopts u32/f32, or splats over a vector shift. */
  private rightOperand(lt: Ty, op: BinOp, r: Expr): Ty {
    if (adoptable(r)) {
      if (isVector(lt) && lt.kind !== 'f32x4' && (op === '<<' || op === '>>')) {
        this.expr(r, laneTy(lt))
        r.splat = laneCount(lt)
        r.ty = lt
        return lt
      }
      return this.expr(r, adoptionHint(lt))
    }
    return this.expr(r, null)
  }

  private binary(e: Binary): Ty {
    if (e.op === '&&' || e.op === '||') {
      const lt = this.expr(e.l, null)
      if (lt.kind !== 'bool') fail(e.l, `'${e.op}' needs bool, got ${tyName(lt)}`)
      const rt = this.expr(e.r, null)
      if (rt.kind !== 'bool') fail(e.r, `'${e.op}' needs bool, got ${tyName(rt)}`)
      return T.bool
    }
    let lt: Ty
    let rt: Ty
    if (adoptable(e.l) && !adoptable(e.r)) {
      rt = this.expr(e.r, null)
      lt = this.expr(e.l, adoptionHint(rt))
    } else {
      lt = this.expr(e.l, null)
      rt = this.rightOperand(lt, e.op, e.r)
    }
    return this.binaryResult(e.op, lt, rt, e)
  }

  /** The result type of `lt op rt`, or the error that names both types. */
  private binaryResult(op: BinOp, lt: Ty, rt: Ty, p: Pos): Ty {
    if (!tyEq(lt, rt)) {
      const cast = isNumeric(lt) && isNumeric(rt) ? ` (use 'as ${tyName(rt)}' or 'as ${tyName(lt)}')` : ''
      fail(p, `type mismatch: ${tyName(lt)} ${op} ${tyName(rt)}${cast}`)
    }
    const vector = isVector(lt)
    switch (op) {
      case '+': case '-': case '*': case '/': case '%':
        if (isNumeric(lt) || vector) return lt
        break
      case '&': case '|': case '^': case '<<': case '>>':
        if (isInteger(lt) || (vector && lt.kind !== 'f32x4')) return lt
        break
      case '==': case '!=':
        if (isNumeric(lt) || lt.kind === 'bool') return T.bool
        if (vector) fail(p, `'${op}' is not defined on ${tyName(lt)} (use ${VECTOR_COMPARE[op]})`)
        break
      case '<': case '<=': case '>': case '>=':
        if (isNumeric(lt)) return T.bool
        if (vector) fail(p, `'${op}' is not defined on ${tyName(lt)} (use ${VECTOR_COMPARE[op]})`)
        break
      default: break
    }
    return fail(p, `'${op}' is not defined on ${tyName(lt)}`)
  }

  private cast(e: Cast): Ty {
    const s = this.expr(e.e, null)
    const d = e.to
    const ok = tyEq(s, d)
      || (isNumeric(s) && isNumeric(d))
      || (s.kind === 'bool' && isInteger(d))
      || (isVector(s) && isVector(d) && laneCount(s) === laneCount(d))
    if (!ok) fail(e, `cannot cast ${tyName(s)} as ${tyName(d)}`)
    return d
  }

  private call(e: Call): Ty {
    const intr = INTRINSICS.get(e.callee)
    if (intr !== undefined) return this.intrinsicCall(e, intr)
    const sig = this.fnSigs.get(e.callee)
    if (sig === undefined) {
      if (this.lookup(e.callee) !== undefined) fail(e, `'${e.callee}' is a variable, not a fn`)
      fail(e, `unknown fn '${e.callee}'`)
    }
    if (e.args.length !== sig.params.length) fail(e, `fn '${e.callee}' takes ${sig.params.length} argument${sig.params.length === 1 ? '' : 's'}, got ${e.args.length}`)
    for (let i = 0; i < e.args.length; i++) {
      const p = sig.params[i]!
      const t = this.expr(e.args[i]!, p)
      if (!tyEq(t, p)) fail(e.args[i]!, `fn '${e.callee}': argument ${i + 1} is ${tyName(t)}, expected ${tyName(p)}`)
    }
    e.ref = { kind: 'fn', sig }
    return sig.ret
  }

  private intrinsicCall(e: Call, intr: Intrinsic): Ty {
    if (intr.variadic) {
      for (let i = 0; i < e.args.length; i++) {
        const a = e.args[i]!
        const t = this.expr(a, a.kind === 'str' ? T.str : null)
        if (t.kind === 'void') fail(a, `${intr.name}: argument ${i + 1} is void`)
      }
      e.ref = { kind: 'print' }
      return T.void
    }
    // Literals are left open (null) until a form is chosen, so they can adopt that form's parameter type.
    const provisional: (Ty | null)[] = e.args.map((a) => (adoptable(a) ? null : this.expr(a, a.kind === 'str' ? T.str : null)))
    for (const f of intr.forms) {
      if (f.params.length !== e.args.length) continue
      let ok = true
      for (let i = 0; i < f.params.length && ok; i++) {
        const p = f.params[i]!
        const t = provisional[i]
        ok = t === null ? isNumeric(p) && fits((e.args[i] as IntLit).value, p) : tyEq(t, p)
      }
      if (!ok) continue
      for (let i = 0; i < f.params.length; i++) if (provisional[i] === null) this.expr(e.args[i]!, f.params[i]!)
      e.ref = { kind: 'intrinsic', code: f.code, ret: f.ret }
      return f.ret
    }
    const shown = provisional.map((t, i) => (t === null ? (fits((e.args[i] as IntLit).value, T.i32) ? 'i32' : `literal ${(e.args[i] as IntLit).value}`) : tyName(t)))
    return fail(e, `${intr.name}: no form takes (${shown.join(', ')})`)
  }

  private indexType(i: Expr): void {
    const t = this.expr(i, null)
    if (!isInteger(t)) fail(i, `index must be i32 or u32, got ${tyName(t)}`)
  }

  private index(e: Index): Ty {
    const t = this.expr(e.e, null)
    if (t.kind !== 'array' && t.kind !== 'col' && !isVector(t)) fail(e, `cannot index ${tyName(t)}`)
    this.indexType(e.index)
    return laneTy(t)
  }

  private field(e: Field): Ty {
    if (e.e.kind === 'ident' && TABLE_NAMES.includes(e.e.name) && this.lookup(e.e.name) === undefined) {
      const table = TABLE_NAMES.indexOf(e.e.name)
      e.e.ty = T.void
      if (e.name === 'n' && table < 2) { e.ref = { kind: 'n', table }; return T.i32 }
      const col = COLUMNS.find((c) => c.table === table && c.name === e.name)
      if (col !== undefined) { e.ref = { kind: 'col', colId: col.id }; return { kind: 'col', elem: col.elem } }
      const sc = SCALARS.find((s) => s.table === table && s.name === e.name)
      if (sc !== undefined) { e.ref = { kind: 'scalar', scalarId: sc.id }; return T[sc.ty] }
      return fail(e.namePos, `no field '${e.name}' on ${e.e.name} (${fieldsOf(table).join(', ')})`)
    }
    const t = this.expr(e.e, null)
    const lane = ['x', 'y', 'z', 'w'].indexOf(e.name)
    if (lane >= 0 && isVector(t) && laneCount(t) === 4) { e.ref = { kind: 'lane', lane }; return laneTy(t) }
    if (t.kind === 'u32x8') fail(e.namePos, `no field '${e.name}' on u32x8 (index it)`)
    return fail(e.namePos, `no field '${e.name}' on ${tyName(t)}`)
  }

  // An error about a field or method name points at the name; one about the value points at the expression's start.
  private method(e: Method): Ty {
    const t = this.expr(e.e, null)
    if (e.name !== 'len') fail(e.namePos, `no method '${e.name}' on ${tyName(t)}`)
    if (t.kind !== 'array' && t.kind !== 'col' && !isVector(t)) fail(e.namePos, `no method 'len' on ${tyName(t)}`)
    if (e.args.length !== 0) fail(e.namePos, 'len takes no arguments')
    return T.i32
  }

  private query(e: Query): Ty {
    const table = TABLE_NAMES.indexOf(e.table)
    if (table < 0) fail(e, `unknown table '${e.table}'`)
    if (table >= 2) fail(e, `'${e.table}' has no rows to query`)
    e.tableId = table
    e.cols = COLUMNS.filter((c) => c.table === table).map((c) => mkDecl('qcol', c.name, T[c.elem], false, c.id))
    this.scopes.push(new Map(e.cols.map((d) => [d.name, d])))
    const t = this.expr(e.where, null)
    this.scopes.pop()
    if (t.kind !== 'bool') fail(e.where, `query needs a bool, got ${tyName(t)}`)
    return T.i32
  }
}

/** Checks a parsed line against the session; throws a NoirError with `line:col:` on the first problem. */
export function check(program: Program, env: Env): Checked {
  return new Checker(env).check(program)
}
