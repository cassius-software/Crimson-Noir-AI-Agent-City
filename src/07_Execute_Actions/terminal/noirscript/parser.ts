// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It builds NoirScript's syntax tree: a Pratt parser for expressions (one binding power
 * per operator level, `as` and the postfix forms binding tightest) and recursive descent for statements, items and
 * types. A block's last `if … else …` chain becomes the block's value when the block has no other trailing
 * expression, which is how a fn body or an if-expression arm yields a value without a `return`; the checker
 * decides whether that value is wanted. A `-` directly before a number folds into the literal, so `-1` adopts
 * types as one literal and `-2147483648` fits i32. Every refusal is a NoirError that names a line and column.
 * What breaks if it is removed? Nothing turns tokens into the tree the checker and the compiler walk.
 */
import type { AssignOp, BinOp, Block, Expr, FnDecl, IfExpr, IfStmt, Item, Param, Pos, Program, Stmt, Ty, UnOp } from './ast.ts'
import { MAX_ARRAY, T, arrayTy, colTy } from './ast.ts'
import type { Token } from './lexer.ts'
import { at, describe, lex } from './lexer.ts'

/** Binding power of each binary operator; higher binds tighter. Prefix is 11, `as` 12, the postfix forms 13. */
const BINARY_BP: Readonly<Record<string, number>> = Object.freeze({
  '||': 1, '&&': 2, '==': 3, '!=': 3, '<': 4, '<=': 4, '>': 4, '>=': 4, '|': 5, '^': 6, '&': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
})
const PREFIX_BP = 11
const AS_BP = 12

/** How deep expressions, blocks and types may nest: past this the parser refuses by name instead of running the host out of stack. */
export const MAX_NESTING = 256

const ASSIGN_OPS: readonly string[] = Object.freeze(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='])

const SIMPLE_TYPES: Readonly<Record<string, Ty>> = Object.freeze({ i32: T.i32, u32: T.u32, f32: T.f32, bool: T.bool, void: T.void, f32x4: T.f32x4, i32x4: T.i32x4, u32x4: T.u32x4, u32x8: T.u32x8 })

class Parser {
  private readonly toks: Token[]
  private i = 0
  /** Open expressions, blocks and types, so nesting is bounded by MAX_NESTING rather than by the host's stack. */
  private nesting = 0

  constructor(src: string) {
    this.toks = lex(src)
  }

  private peek(ahead = 0): Token { return this.toks[Math.min(this.i + ahead, this.toks.length - 1)]! }
  private next(): Token { const t = this.peek(); if (t.kind !== 'eof') this.i++; return t }
  private is(kind: 'op' | 'kw', text: string, ahead = 0): boolean { const t = this.peek(ahead); return t.kind === kind && t.text === text }
  private pos(t: Token): Pos { return { line: t.line, col: t.col } }

  private fail(t: Token, message: string): never { throw at(t.line, t.col, message) }

  /** Enters one more level of nesting; the parser refuses the MAX_NESTING + 1st by name at the current token. */
  private enter(): void {
    if (++this.nesting > MAX_NESTING) this.fail(this.peek(), `nesting deeper than ${MAX_NESTING} levels`)
  }

  private leave(): void { this.nesting-- }

  private expect(kind: 'op' | 'kw', text: string, why?: string): Token {
    const t = this.peek()
    if (t.kind === kind && t.text === text) return this.next()
    return this.fail(t, `${why ?? `expected '${text}'`}, got ${describe(t)}`)
  }

  private expectIdent(what: string): Token {
    const t = this.peek()
    if (t.kind === 'ident') return this.next()
    if (t.kind === 'kw' || t.kind === 'type') return this.fail(t, `'${t.text}' is a reserved word and cannot name ${what}`)
    return this.fail(t, `expected ${what}, got ${describe(t)}`)
  }

  /** One expression that must use the whole input (the parser tests). */
  wholeExpr(): Expr {
    const e = this.expr(0)
    const rest = this.peek()
    if (rest.kind !== 'eof') this.fail(rest, `expected end of input, got ${describe(rest)}`)
    return e
  }

  program(): Program {
    const items: Item[] = []
    while (this.peek().kind !== 'eof') {
      if (this.is('op', ';')) { this.next(); continue }
      if (this.is('kw', 'fn')) { items.push(this.fnDecl()); continue }
      const r = this.statementOrTail()
      if (r.kind === 'tail') this.fail(this.peek(), `expected ';' after statement, got ${describe(this.peek())}`)
      items.push(r.stmt)
    }
    return { items }
  }

  private fnDecl(): FnDecl {
    const kw = this.expect('kw', 'fn')
    const name = this.expectIdent('a fn name')
    this.expect('op', '(')
    const params: Param[] = []
    if (!this.is('op', ')')) {
      for (;;) {
        const p = this.expectIdent('a parameter name')
        this.expect('op', ':', `expected ':' after parameter '${p.text}'`)
        params.push({ name: p.text, ty: this.type(), line: p.line, col: p.col })
        if (this.is('op', ',')) { this.next(); continue }
        break
      }
    }
    this.expect('op', ')')
    let ret: Ty = T.void
    if (this.is('op', '->')) { this.next(); ret = this.type() }
    const body = this.block()
    return { kind: 'fn', name: name.text, namePos: this.pos(name), params, ret, body, ...this.pos(kw) }
  }

  type(): Ty {
    this.enter()
    const t = this.typeInner()
    this.leave()
    return t
  }

  private typeInner(): Ty {
    const t = this.peek()
    if (t.kind === 'type') {
      this.next()
      if (t.text !== 'col') return SIMPLE_TYPES[t.text]!
      this.expect('op', '<', "expected '<' after col")
      const e = this.peek()
      if (e.kind !== 'type' || (e.text !== 'f32' && e.text !== 'i32' && e.text !== 'u32')) this.fail(e, `a col holds f32, i32 or u32, got ${describe(e)}`)
      this.next()
      this.expect('op', '>', "expected '>' after col element type")
      return colTy(e.text as 'f32' | 'i32' | 'u32')
    }
    if (t.kind === 'op' && t.text === '[') {
      this.next()
      const elem = this.type()
      if (elem.kind === 'col' || elem.kind === 'void') this.fail(t, `${elem.kind === 'col' ? `col<${elem.elem}>` : 'void'} cannot be an array element`)
      this.expect('op', ';', "expected ';' in array type")
      const n = this.peek()
      if (n.kind !== 'int') this.fail(n, `expected an array size, got ${describe(n)}`)
      this.next()
      if (n.value < 1 || n.value > MAX_ARRAY) this.fail(n, `array size must be 1 to ${MAX_ARRAY}`)
      this.expect('op', ']')
      return arrayTy(elem, n.value)
    }
    return this.fail(t, `expected a type, got ${describe(t)}`)
  }

  private block(): Block {
    this.enter()
    const b = this.blockInner()
    this.leave()
    return b
  }

  private blockInner(): Block {
    const open = this.expect('op', '{')
    const stmts: Stmt[] = []
    let tail: Expr | null = null
    for (;;) {
      const t = this.peek()
      if (t.kind === 'eof') this.fail(t, "expected '}', got end of input")
      if (t.kind === 'op' && t.text === '}') break
      if (t.kind === 'op' && t.text === ';') { this.next(); continue }
      const r = this.statementOrTail()
      if (r.kind === 'tail') {
        tail = r.expr
        if (!this.is('op', '}')) this.fail(this.peek(), `expected ';' after statement, got ${describe(this.peek())}`)
        break
      }
      stmts.push(r.stmt)
    }
    const close = this.next()
    if (tail === null && stmts.length > 0) {
      const last = stmts[stmts.length - 1]!
      if (last.kind === 'if' && complete(last)) {
        stmts.pop()
        tail = toIfExpr(last)
      }
    }
    return { stmts, tail, end: this.pos(close), ...this.pos(open) }
  }

  private statementOrTail(): { kind: 'stmt'; stmt: Stmt } | { kind: 'tail'; expr: Expr } {
    const t = this.peek()
    if (t.kind === 'kw') {
      switch (t.text) {
        case 'let': return { kind: 'stmt', stmt: this.letStmt() }
        case 'if': return { kind: 'stmt', stmt: this.ifStmt() }
        case 'while': {
          this.next()
          const cond = this.expr(0)
          return { kind: 'stmt', stmt: { kind: 'while', cond, body: this.block(), ...this.pos(t) } }
        }
        case 'loop': { this.next(); return { kind: 'stmt', stmt: { kind: 'loop', body: this.block(), ...this.pos(t) } } }
        case 'for': return { kind: 'stmt', stmt: this.forStmt() }
        case 'break': { this.next(); this.expect('op', ';', "expected ';' after statement"); return { kind: 'stmt', stmt: { kind: 'break', ...this.pos(t) } } }
        case 'continue': { this.next(); this.expect('op', ';', "expected ';' after statement"); return { kind: 'stmt', stmt: { kind: 'continue', ...this.pos(t) } } }
        case 'return': {
          this.next()
          const value = this.is('op', ';') ? null : this.expr(0)
          this.expect('op', ';', "expected ';' after statement")
          return { kind: 'stmt', stmt: { kind: 'return', value, ...this.pos(t) } }
        }
        case 'else': return this.fail(t, "unexpected 'else'")
        case 'fn': return this.fail(t, "'fn' is only allowed at the top level")
        default: break
      }
    }
    if (t.kind === 'op' && t.text === '{') return { kind: 'stmt', stmt: { kind: 'block', block: this.block(), ...this.pos(t) } }
    const e = this.expr(0)
    const after = this.peek()
    if (after.kind === 'op' && ASSIGN_OPS.includes(after.text)) {
      this.next()
      let name: string
      let index: Expr | null = null
      if (e.kind === 'ident') name = e.name
      else if (e.kind === 'index' && e.e.kind === 'ident') { name = e.e.name; index = e.index }
      else return this.fail(t, 'cannot assign to this expression (only a name or a name[index])')
      const value = this.expr(0)
      this.expect('op', ';', "expected ';' after statement")
      return { kind: 'stmt', stmt: { kind: 'assign', name, index, op: after.text as AssignOp, value, ...this.pos(t) } }
    }
    if (after.kind === 'op' && after.text === ';') { this.next(); return { kind: 'stmt', stmt: { kind: 'expr', e, ...this.pos(t) } } }
    if (after.kind === 'op' && after.text === '}') return { kind: 'tail', expr: e }
    return this.fail(after, `expected ';' after statement, got ${describe(after)}`)
  }

  private letStmt(): Stmt {
    const kw = this.expect('kw', 'let')
    let mutable = false
    if (this.is('kw', 'mut')) { this.next(); mutable = true }
    const name = this.expectIdent('a variable name')
    let declared: Ty | null = null
    if (this.is('op', ':')) { this.next(); declared = this.type() }
    this.expect('op', '=', `expected '=' after 'let ${name.text}'`)
    const init = this.expr(0)
    this.expect('op', ';', "expected ';' after statement")
    return { kind: 'let', name: name.text, namePos: this.pos(name), mutable, declared, init, ...this.pos(kw) }
  }

  /** An else-if chain recurses here, so it counts toward the nesting bound like any other nesting. */
  private ifStmt(): IfStmt {
    this.enter()
    const kw = this.expect('kw', 'if')
    const cond = this.expr(0)
    const then = this.block()
    let els: Block | IfStmt | null = null
    if (this.is('kw', 'else')) {
      this.next()
      els = this.is('kw', 'if') ? this.ifStmt() : this.block()
    }
    this.leave()
    return { kind: 'if', cond, then, else: els, ...this.pos(kw) }
  }

  private forStmt(): Stmt {
    const kw = this.expect('kw', 'for')
    const name = this.expectIdent('a loop variable')
    this.expect('kw', 'in', `expected 'in' after 'for ${name.text}'`)
    const from = this.expr(0)
    let inclusive: boolean
    if (this.is('op', '..')) inclusive = false
    else if (this.is('op', '..=')) inclusive = true
    else return this.fail(this.peek(), `expected '..' or '..=' in for range, got ${describe(this.peek())}`)
    this.next()
    const to = this.expr(0)
    const body = this.block()
    return { kind: 'for', name: name.text, namePos: this.pos(name), from, to, inclusive, body, ...this.pos(kw) }
  }

  /** Pratt: parses an expression whose operators all bind tighter than `minBp`. */
  expr(minBp: number): Expr {
    this.enter()
    const e = this.exprFrom(this.prefix(), minBp)
    this.leave()
    return e
  }

  /** The Pratt loop over an already-parsed left side: `as`, the postfix forms, then the binary operators. */
  private exprFrom(lhs: Expr, minBp: number): Expr {
    for (;;) {
      const t = this.peek()
      if (t.kind === 'kw' && t.text === 'as') {
        if (AS_BP <= minBp) break
        this.next()
        lhs = { kind: 'cast', e: lhs, to: this.type(), ...this.pos(t) }
        continue
      }
      if (t.kind !== 'op') break
      // An index, field or method expression starts where its object starts; the field name keeps its own position.
      if (t.text === '[') {
        this.next()
        const index = this.expr(0)
        this.expect('op', ']')
        lhs = { kind: 'index', e: lhs, index, line: lhs.line, col: lhs.col }
        continue
      }
      if (t.text === '.') {
        this.next()
        const name = this.expectIdent('a field name')
        if (this.is('op', '(')) {
          lhs = { kind: 'method', e: lhs, name: name.text, namePos: this.pos(name), args: this.args(), line: lhs.line, col: lhs.col }
        } else {
          lhs = { kind: 'field', e: lhs, name: name.text, namePos: this.pos(name), line: lhs.line, col: lhs.col }
        }
        continue
      }
      const bp = BINARY_BP[t.text]
      if (bp === undefined || bp <= minBp) break
      this.next()
      const rhs = this.expr(bp)
      lhs = { kind: 'binary', op: t.text as BinOp, l: lhs, r: rhs, ...this.pos(t) }
    }
    return lhs
  }

  private prefix(): Expr {
    const t = this.peek()
    if (t.kind === 'op' && (t.text === '-' || t.text === '!' || t.text === '~')) {
      this.next()
      const n = this.peek()
      // A `-` directly before a number is part of the literal; `as` and the postfix forms still apply to it.
      if (t.text === '-' && n.kind === 'int') {
        this.next()
        return this.exprFrom({ kind: 'int', value: -n.value, suffixed: n.suffixed, splat: 0, ...this.pos(t) }, PREFIX_BP)
      }
      if (t.text === '-' && n.kind === 'float') {
        this.next()
        return this.exprFrom({ kind: 'float', value: Math.fround(-n.value), ...this.pos(t) }, PREFIX_BP)
      }
      const e = this.expr(PREFIX_BP)
      return { kind: 'unary', op: t.text as UnOp, e, ...this.pos(t) }
    }
    return this.primary()
  }

  private primary(): Expr {
    const t = this.peek()
    switch (t.kind) {
      case 'int': this.next(); return { kind: 'int', value: t.value, suffixed: t.suffixed, splat: 0, ...this.pos(t) }
      case 'float': this.next(); return { kind: 'float', value: t.value, ...this.pos(t) }
      case 'str': this.next(); return { kind: 'str', value: t.str, ...this.pos(t) }
      case 'ident': {
        this.next()
        if (this.is('op', '(')) return { kind: 'call', callee: t.text, args: this.args(), ...this.pos(t) }
        return { kind: 'ident', name: t.text, ...this.pos(t) }
      }
      case 'type': {
        if (this.is('op', '(', 1)) { this.next(); return { kind: 'call', callee: t.text, args: this.args(), ...this.pos(t) } }
        return this.fail(t, `expected expression, got ${describe(t)}`)
      }
      case 'kw': {
        if (t.text === 'true' || t.text === 'false') { this.next(); return { kind: 'bool', value: t.text === 'true', ...this.pos(t) } }
        if (t.text === 'query') {
          this.next()
          const table = this.expectIdent('a table name')
          this.expect('kw', 'where', "expected 'where' after the table name")
          const where = this.expr(0)
          return { kind: 'query', table: table.text, where, tableId: -1, cols: [], ...this.pos(t) }
        }
        if (t.text === 'if') return this.ifExpr()
        return this.fail(t, `expected expression, got ${describe(t)}`)
      }
      case 'op': {
        if (t.text === '(') {
          this.next()
          const e = this.expr(0)
          this.expect('op', ')')
          return e
        }
        if (t.text === '[') {
          this.next()
          if (this.is('op', ']')) this.fail(this.peek(), 'expected expression, got \']\' (an array needs at least one element)')
          const first = this.expr(0)
          if (this.is('op', ';')) {
            this.next()
            const n = this.peek()
            if (n.kind !== 'int') this.fail(n, `expected an array size, got ${describe(n)}`)
            this.next()
            if (n.value < 1 || n.value > MAX_ARRAY) this.fail(n, `array size must be 1 to ${MAX_ARRAY}`)
            this.expect('op', ']')
            return { kind: 'fill', value: first, n: n.value, ...this.pos(t) }
          }
          const elems = [first]
          while (this.is('op', ',')) { this.next(); elems.push(this.expr(0)) }
          this.expect('op', ']')
          return { kind: 'array', elems, ...this.pos(t) }
        }
        return this.fail(t, `expected expression, got ${describe(t)}`)
      }
      default: return this.fail(t, `expected expression, got ${describe(t)}`)
    }
  }

  private ifExpr(): IfExpr {
    this.enter()
    const kw = this.expect('kw', 'if')
    const cond = this.expr(0)
    const then = this.block()
    if (!this.is('kw', 'else')) this.fail(this.peek(), `an if expression needs an else, got ${describe(this.peek())}`)
    this.next()
    const els: Block | IfExpr = this.is('kw', 'if') ? this.ifExpr() : this.block()
    this.leave()
    return { kind: 'if', cond, then, else: els, ...this.pos(kw) }
  }

  private args(): Expr[] {
    this.expect('op', '(')
    const args: Expr[] = []
    if (!this.is('op', ')')) {
      for (;;) {
        args.push(this.expr(0))
        if (this.is('op', ',')) { this.next(); continue }
        break
      }
    }
    this.expect('op', ')')
    return args
  }
}

/** Whether an if statement's else chain ends in a plain else (so it has a value on every path). */
function complete(s: IfStmt): boolean {
  if (s.else === null) return false
  if ('kind' in s.else && s.else.kind === 'if') return complete(s.else)
  return true
}

function toIfExpr(s: IfStmt): IfExpr {
  const els = s.else!
  const e: Block | IfExpr = 'kind' in els && els.kind === 'if' ? toIfExpr(els) : (els as Block)
  return { kind: 'if', cond: s.cond, then: s.then, else: e, line: s.line, col: s.col }
}

/** Parses a whole program; throws a NoirError with `line:col:` on the first problem. */
export function parse(src: string): Program {
  return new Parser(src).program()
}

/** Parses one expression (for tests); the whole input must be consumed. */
export function parseExpr(src: string): Expr {
  return new Parser(src).wholeExpr()
}
