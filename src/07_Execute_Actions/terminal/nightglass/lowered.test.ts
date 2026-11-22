// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The GPU back end lowers Lens to WGSL (wgsl.ts), and Node has no GPU to run that WGSL on.
 * This file holds, inside the test itself (a test in the folder may import only the folder's files and node's test
 * modules), a parser and an evaluator for exactly the subset of WGSL the lowering prints, so that a lowered module can
 * be run in Node and its results held against interp.ts. The evaluator has two modes. `exact` is WGSL as specified,
 * with every freedom WGSL leaves taken the way interp.ts takes it. `adversarial` takes every freedom the wrong way, so
 * a lowered module that leans on something WGSL leaves open gives a different answer there. The unit tests below pin
 * the parser and the evaluator on hand-written WGSL, tricky cases included.
 * What breaks if it is removed? Nothing would check, without a browser, that the WGSL the back end prints means what
 * the Lens it came from means, or that its emulations (NaN rules, saturating casts, clamped indices, zero reads
 * outside resources, the loop cap, helper lanes) hold whatever a conforming GPU does with WGSL's freedoms.
 *
 * THE SUBSET. Directives: `diagnostic(severity, rule)` only (`enable`, `requires` refused). Declarations: `struct`
 * (members with @align, @size and the stage attributes), `alias`, `const`, module `var` in the private, workgroup,
 * uniform, storage (read or read_write) and handle spaces, and `fn` with @compute @workgroup_size, @vertex and
 * @fragment. Types: bool, i32, u32, f32, vecN, matCxR of f32, array<E, N>, array<E> (last in a storage block),
 * structs, texture_2d<T>, texture_2d_array<T>, texture_depth_2d(_array), texture_storage_2d<format, write> and
 * sampler. Statements: let, var, const, assignment (plain and compound, `_ =`), ++ and --, calls, if/else, switch,
 * loop (with continuing and `break if`), for, while, break, continue, return and discard. Expressions follow WGSL's
 * grammar exactly, so a mix of operators WGSL wants parenthesised (`a & b | c`, `a < b < c`, `a && b || c`,
 * `a << b + c`) is refused. Types are checked as WGSL checks them (abstract literals convert only where WGSL lets
 * them; i32 and u32 never mix; shift counts are u32; `^` takes no bool), const-expressions are evaluated and refused
 * where WGSL refuses them (overflow, NaN or infinity, a zero divisor, a shift of 32 or more, `2147483648i`), the
 * statement behaviours are computed (a function that can fall off its end, `break` outside a loop, a `continue` in
 * `continuing`, an empty loop behaviour and unreachable code are all refused), and buffer layouts are worked out from
 * the printed @align and @size and held to the uniform and storage layout rules. Anything else, or any WGSL feature
 * the parser does not know, fails loudly with a WgslError: it never guesses.
 *
 * THE EVALUATOR. Values are numbers (f32 held as doubles rounded by Math.fround after every operation, i32 and u32
 * wrapped, bool 0 or 1) and arrays of values for vectors, grid columns, arrays and structs. A run is a wave of lanes in
 * lock step under a mask, as interp.ts runs its batches: a fragment wave is a 2 x 2 quad (lane i is pixel
 * (x + (i & 1), y + (i >> 1))), a compute wave is four consecutive local indices, or the whole workgroup when the module
 * uses workgroup memory or a barrier, and a vertex wave is up to four vertices. Uniform and storage buffers are byte
 * arrays read and written little-endian at the layout's offsets; images go through texture.ts.
 *
 * THE FREEDOMS (named by Freedom below; `adversarial` takes all of them unless told otherwise):
 * - minmax-nan: native min, max and clamp of a NaN give the NaN operand (exact: the other operand, as interp.ts).
 * - clamp-median: float clamp with lo > hi takes the median of three (exact: min(max(x, lo), hi)).
 * - compare-nan: every float comparison with a NaN operand is true, as a finite-math compiler might fold it.
 * - finite: a float operation with a NaN or infinite operand, or whose exact result is NaN, infinite or overflows,
 *   gives poison (WGSL's finite math assumption; bit casts, loads, stores and select move bits and are not touched).
 * - zero-sign: every zero a float operation produces has the other sign (WGSL may ignore the sign of a zero).
 * - rounding: every inexact add, subtract, multiply and integer-to-float conversion takes the neighbour that
 *   round-to-nearest-even does not (WGSL names no rounding mode).
 * - flush: subnormal operands and results of float operations, and of bit casts, flush to zero.
 * - contract: a product feeding an add or subtract (also across `let` names) is fused into one rounding, and `fma`
 *   rounds twice.
 * - reassociate: dot, the grid products, length and the like sum their terms in reverse order, fused.
 * - convert: f32 to i32 or u32 of NaN or of a value out of range gives poison 0x5a5a5a5a (exact: WGSL's own clamped
 *   result, and 0 for NaN as interp.ts).
 * - division: f32 division is 2 ULP off (within WGSL's 2.5), and poison for divisors outside [2^-126, 2^126].
 * - library: sqrt, inverseSqrt, exp, exp2, log, log2, sin, cos, tan, asin, acos, atan, atan2, pow, sinh, cosh, tanh
 *   and through them length, normalize and distance are as far off as WGSL's accuracy table allows, and poison
 *   outside the range it bounds; determinant is poison (WGSL bounds it by nothing).
 * - fract: fract is held below 1. sign-nan: sign of a NaN is 1.
 * - oob: a read outside a vector, grid, array or texture gives poison; a store outside lands at the start of the
 *   array; a textureStore outside writes poison at texel (0, 0); textureDimensions of a level outside gives poison
 *   (exact: clamped indices and zero reads outside, as interp.ts and texture.ts).
 * - helper-stores: stores from lanes demoted by discard take place (WGSL says a helper stores nothing; a platform may
 *   still let a demoted invocation's stores through, which the lowering's ng_gone guards against). A lane that starts
 *   as a helper (it covers no sample) stores nothing in either mode: the lowering cannot tell it, and WGSL defines it.
 * - sample-nan: textureSample, textureSampleLevel and textureSampleGrad with a NaN coordinate or level, or a rate given
 *   to textureSampleGrad that is not finite, give poison.
 * - derivatives: the fine and plain derivatives are coarse, the coarse ones fine.
 * Poison is 0x5a5a5a5a in every scalar kind (as an f32, about 1.5e16), and true for a bool.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { arrayOf, lens } from './builder.ts'
import type { BlockRes, LensBuilder, PathStep, Val as LensVal, Var as LensVar } from './builder.ts'
import { sampleKind } from './formats.ts'
import type { Format } from './formats.ts'
import { LANES, compile as compileLens, dispatch as dispatchLens } from './interp.ts'
import type { Bindings as LensBindings, Program as LensProgram } from './interp.ts'
import { columnOf, isGrid, layoutBlock, strideOf as lensStrideOf, widthOf as lensWidthOf } from './lens.ts'
import type { Block, DataType, Inst, LensModule, Port, Scalar as LensScalar, ValueType } from './lens.ts'
import { ImageStore, load, lodFromRates, put, sample } from './texture.ts'
import type { SamplerState, ViewRange } from './texture.ts'
import { WGSL_HIDDEN, positionSure, toWgsl } from './wgsl.ts'

// ---------------------------------------------------------------------------------------------------
// Errors

/** A module outside the subset, or one WGSL itself refuses. Always thrown; the parser never guesses past one. */
class WgslError extends Error {}
/** A run that cannot go on: a missing resource, a spent budget, or (in exact mode) a derivative a quad cannot take. */
class RunError extends Error {}

function refuse(at: { readonly line: number; readonly col: number }, message: string): never {
  throw new WgslError(`wgsl ${at.line}:${at.col}: ${message}`)
}

// ---------------------------------------------------------------------------------------------------
// Tokens

interface Tok {
  readonly k: 'id' | 'num' | 'op' | 'end'
  v: string
  readonly line: number
  col: number
}

const OPS = ['<<=', '>>=', '->', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '++', '--']
const OPS1 = '+-*/%&|^~!<>=(){}[],;:.@'
const HEX_FLOAT = /0[xX](?:[0-9a-fA-F]*\.[0-9a-fA-F]*|[0-9a-fA-F]+[pP])/y
const HEX_INT = /0[xX][0-9a-fA-F]+[iu]?/y
const DEC_FLOAT = /(?:[0-9]*\.[0-9]+|[0-9]+\.[0-9]*)(?:[eE][+-]?[0-9]+)?[fh]?|[0-9]+[eE][+-]?[0-9]+[fh]?|(?:0|[1-9][0-9]*)[fh]/y
const DEC_INT = /(?:0|[1-9][0-9]*)[iu]?/y
const IDENT = /[A-Za-z_][A-Za-z0-9_]*/y

function lex(src: string): Tok[] {
  // Comments too: the printer writes ASCII only, so anything else is not its output.
  const odd = /[^\t\n\r\x20-\x7e]/.exec(src)
  if (odd !== null) {
    const before = src.slice(0, odd.index).split('\n')
    refuse({ line: before.length, col: before[before.length - 1].length + 1 }, `character code ${src.charCodeAt(odd.index)} is outside the subset (printable ASCII, spaces, tabs and line breaks)`)
  }
  const toks: Tok[] = []
  let i = 0
  let line = 1
  let start = 0
  const at = (): { line: number; col: number } => ({ line, col: i - start + 1 })
  const sticky = (re: RegExp): string | null => {
    re.lastIndex = i
    const m = re.exec(src)
    return m === null ? null : m[0]
  }
  while (i < src.length) {
    const c = src.charCodeAt(i)
    if (c === 10) {
      line++
      i++
      start = i
      continue
    }
    if (c === 32 || c === 9 || c === 13) {
      i++
      continue
    }
    if (src.startsWith('//', i)) {
      while (i < src.length && src.charCodeAt(i) !== 10) i++
      continue
    }
    if (src.startsWith('/*', i)) {
      const open = at()
      let depth = 0
      do {
        if (i >= src.length) refuse(open, 'a block comment is never closed')
        if (src.startsWith('/*', i)) {
          depth++
          i += 2
        } else if (src.startsWith('*/', i)) {
          depth--
          i += 2
        } else {
          if (src.charCodeAt(i) === 10) {
            line++
            start = i + 1
          }
          i++
        }
      } while (depth > 0)
      continue
    }
    const pos = at()
    const isDigit = (k: number): boolean => k >= 48 && k <= 57
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
      if (sticky(HEX_FLOAT) !== null) refuse(pos, 'hexadecimal floating point literals are outside the subset')
      const num = sticky(HEX_INT) ?? sticky(DEC_FLOAT) ?? sticky(DEC_INT)
      if (num === null) refuse(pos, 'malformed number')
      i += num.length
      if (/[A-Za-z0-9_.]/.test(src[i] ?? '')) refuse(pos, `malformed number ${num}${src[i]}`)
      if (num.endsWith('h') && !/^0[xX]/.test(num)) refuse(pos, `${num}: f16 is outside the subset`)
      toks.push({ k: 'num', v: num, line: pos.line, col: pos.col })
      continue
    }
    const id = sticky(IDENT)
    if (id !== null) {
      if (id.startsWith('__')) refuse(pos, `${id}: identifiers may not start with two underscores`)
      i += id.length
      toks.push({ k: 'id', v: id, line: pos.line, col: pos.col })
      continue
    }
    const op = OPS.find((o) => src.startsWith(o, i)) ?? (OPS1.includes(src[i]) ? src[i] : null)
    if (op === null) refuse(pos, `unexpected character ${src[i]}`)
    i += op.length
    toks.push({ k: 'op', v: op, line: pos.line, col: pos.col })
  }
  toks.push({ k: 'end', v: '<end>', line, col: i - start + 1 })
  return toks
}

// ---------------------------------------------------------------------------------------------------
// The syntax tree: what the text says, before any checking. The next stage compares it with wgsl.ts's own tree.

interface Pos {
  readonly line: number
  readonly col: number
}
interface TypeExpr extends Pos {
  readonly k: 'type'
  readonly name: string
  /** The template list (`vec4<f32>`, `array<u32, 4>`, `texture_storage_2d<rgba8unorm, write>`), or null. */
  readonly args: readonly (TypeExpr | Expr)[] | null
}
type Expr =
  | (Pos & { readonly k: 'lit'; readonly text: string })
  | (Pos & { readonly k: 'ident'; readonly name: string })
  /** A call of a function, a builtin, a constructor (`vec4<f32>(...)`, `S(...)`, `f32(x)`) or `bitcast<T>(x)`. */
  | (Pos & { readonly k: 'call'; readonly name: string; readonly tmpl: readonly (TypeExpr | Expr)[] | null; readonly args: readonly Expr[] })
  | (Pos & { readonly k: 'unary'; readonly op: '-' | '!' | '~' | '&' | '*'; readonly a: Expr })
  | (Pos & { readonly k: 'binary'; readonly op: string; readonly a: Expr; readonly b: Expr })
  | (Pos & { readonly k: 'member'; readonly a: Expr; readonly name: string })
  | (Pos & { readonly k: 'index'; readonly a: Expr; readonly i: Expr })
  | (Pos & { readonly k: 'paren'; readonly a: Expr })

interface Attr extends Pos {
  readonly name: string
  readonly args: readonly Expr[]
}

type Stmt =
  | (Pos & { readonly k: 'let' | 'const'; readonly name: string; readonly type: TypeExpr | null; readonly init: Expr })
  | (Pos & { readonly k: 'var'; readonly name: string; readonly type: TypeExpr | null; readonly init: Expr | null })
  /** `lhs op rhs`; lhs null is the phony `_ = rhs`. */
  | (Pos & { readonly k: 'assign'; readonly lhs: Expr | null; readonly op: string; readonly rhs: Expr })
  | (Pos & { readonly k: 'incr'; readonly lhs: Expr; readonly op: '++' | '--' })
  | (Pos & { readonly k: 'call'; readonly call: Expr })
  | (Pos & { readonly k: 'if'; readonly cond: Expr; readonly then: readonly Stmt[]; readonly else: readonly Stmt[] | null })
  | (Pos & { readonly k: 'switch'; readonly sel: Expr; readonly clauses: readonly { readonly sels: readonly (Expr | null)[]; readonly body: readonly Stmt[]; readonly line: number; readonly col: number }[] })
  | (Pos & { readonly k: 'loop'; readonly body: readonly Stmt[]; readonly continuing: readonly Stmt[] | null; readonly breakIf: Expr | null })
  | (Pos & { readonly k: 'for'; readonly init: Stmt | null; readonly cond: Expr | null; readonly update: Stmt | null; readonly body: readonly Stmt[] })
  | (Pos & { readonly k: 'while'; readonly cond: Expr; readonly body: readonly Stmt[] })
  | (Pos & { readonly k: 'break' | 'continue' | 'discard' })
  | (Pos & { readonly k: 'return'; readonly value: Expr | null })
  | (Pos & { readonly k: 'block'; readonly body: readonly Stmt[] })

interface Param extends Pos {
  readonly name: string
  readonly type: TypeExpr
  readonly attrs: readonly Attr[]
}
type Decl =
  | (Pos & { readonly k: 'struct'; readonly name: string; readonly members: readonly Param[] })
  | (Pos & { readonly k: 'alias'; readonly name: string; readonly type: TypeExpr })
  | (Pos & { readonly k: 'const'; readonly name: string; readonly type: TypeExpr | null; readonly init: Expr })
  | (Pos & {
      readonly k: 'var'; readonly name: string; readonly attrs: readonly Attr[]
      /** The address space and access mode as written (`var<storage, read_write>`), or empty. */
      readonly tmpl: readonly string[]; readonly type: TypeExpr | null; readonly init: Expr | null
    })
  | (Pos & {
      readonly k: 'fn'; readonly name: string; readonly attrs: readonly Attr[]; readonly params: readonly Param[]
      readonly ret: TypeExpr | null; readonly retAttrs: readonly Attr[]; readonly body: readonly Stmt[]
    })

interface ModuleAst {
  readonly directives: readonly { readonly severity: string; readonly rule: string }[]
  readonly decls: readonly Decl[]
}

// ---------------------------------------------------------------------------------------------------
// The parser

/** Identifiers that take a template list. Every other identifier followed by `<` is a less-than. */
const TEMPLATED = new Set(['vec2', 'vec3', 'vec4', 'array', 'ptr', 'atomic', 'bitcast', 'texture_1d', 'texture_2d', 'texture_2d_array', 'texture_3d', 'texture_cube',
  'texture_cube_array', 'texture_multisampled_2d', 'texture_storage_1d', 'texture_storage_2d', 'texture_storage_2d_array', 'texture_storage_3d',
  ...[2, 3, 4].flatMap((c) => [2, 3, 4].map((r) => `mat${c}x${r}`))])
const KEYWORDS = new Set(['alias', 'break', 'case', 'const', 'const_assert', 'continue', 'continuing', 'default', 'diagnostic', 'discard', 'else', 'enable', 'false', 'fn', 'for',
  'if', 'let', 'loop', 'override', 'requires', 'return', 'struct', 'switch', 'true', 'var', 'while'])
const BINARY_OPS = new Set(['&', '|', '^', '&&', '||', '<', '>', '<=', '>=', '==', '!=', '<<', '>>', '+', '-', '*', '/', '%'])
const RELATIONAL = new Set(['<', '>', '<=', '>=', '==', '!='])

class Parser {
  readonly toks: Tok[]
  p = 0

  constructor(src: string) {
    this.toks = lex(src)
  }

  peek(o = 0): Tok {
    return this.toks[Math.min(this.p + o, this.toks.length - 1)]
  }
  is(v: string, o = 0): boolean {
    const t = this.peek(o)
    return t.k !== 'num' && t.k !== 'end' && t.v === v
  }
  next(): Tok {
    const t = this.peek()
    if (t.k !== 'end') this.p++
    return t
  }
  eat(v: string): boolean {
    if (!this.is(v)) return false
    this.p++
    return true
  }
  expect(v: string, what = ''): Tok {
    const t = this.peek()
    if (!this.is(v)) refuse(t, `expected ${v}${what === '' ? '' : ` ${what}`}, found ${t.v}`)
    this.p++
    return t
  }
  ident(what: string): Tok {
    const t = this.peek()
    if (t.k !== 'id' || KEYWORDS.has(t.v)) refuse(t, `expected ${what}, found ${t.v}`)
    this.p++
    return t
  }
  /** Consumes one `>` closing a template list, splitting `>>`, `>=` and `>>=` as WGSL's template rules do. */
  closeAngle(): void {
    const t = this.peek()
    if (t.k === 'op' && t.v === '>') {
      this.p++
      return
    }
    if (t.k === 'op' && (t.v === '>>' || t.v === '>=' || t.v === '>>=')) {
      t.v = t.v.slice(1)
      t.col++
      return
    }
    refuse(t, `expected > to close a template list, found ${t.v}`)
  }

  module(): ModuleAst {
    const directives: { severity: string; rule: string }[] = []
    const decls: Decl[] = []
    for (;;) {
      const t = this.peek()
      if (this.is('diagnostic')) {
        this.next()
        this.expect('(')
        const severity = this.ident('a severity').v
        this.expect(',')
        const rule = this.ident('a diagnostic rule').v
        this.eat(',')
        this.expect(')')
        this.expect(';')
        if (!['off', 'info', 'warning', 'error'].includes(severity)) refuse(t, `${severity} is not a diagnostic severity`)
        if (rule !== 'derivative_uniformity') refuse(t, `diagnostic rule ${rule} is outside the subset`)
        directives.push({ severity, rule })
        continue
      }
      if (this.is('enable') || this.is('requires')) refuse(t, `${t.v} directives are outside the subset`)
      break
    }
    while (this.peek().k !== 'end') {
      if (this.eat(';')) continue
      decls.push(this.decl())
    }
    return { directives, decls }
  }

  attrs(): Attr[] {
    const list: Attr[] = []
    while (this.is('@')) {
      const at = this.next()
      const name = this.ident('an attribute name').v
      const args: Expr[] = []
      if (this.eat('(')) {
        while (!this.is(')')) {
          args.push(this.expression())
          if (!this.eat(',')) break
        }
        this.expect(')')
      }
      if (list.some((a) => a.name === name)) refuse(at, `@${name} is given twice`)
      list.push({ name, args, line: at.line, col: at.col })
    }
    return list
  }

  decl(): Decl {
    const attrs = this.attrs()
    const t = this.peek()
    const only = (allowed: readonly string[]): void => {
      for (const a of attrs) if (!allowed.includes(a.name)) refuse(a, `@${a.name} is outside the subset here`)
    }
    switch (t.v) {
      case 'struct': {
        only([])
        this.next()
        const name = this.ident('a struct name').v
        this.expect('{')
        const members: Param[] = []
        while (!this.is('}')) {
          const ma = this.attrs()
          const mt = this.ident('a member name')
          this.expect(':')
          members.push({ name: mt.v, type: this.type(), attrs: ma, line: mt.line, col: mt.col })
          if (!this.eat(',')) break
        }
        this.expect('}')
        this.eat(';')
        return { k: 'struct', name, members, line: t.line, col: t.col }
      }
      case 'alias': {
        only([])
        this.next()
        const name = this.ident('an alias name').v
        this.expect('=')
        const type = this.type()
        this.expect(';')
        return { k: 'alias', name, type, line: t.line, col: t.col }
      }
      case 'const': {
        only([])
        this.next()
        const name = this.ident('a name').v
        const type = this.eat(':') ? this.type() : null
        this.expect('=')
        const init = this.expression()
        this.expect(';')
        return { k: 'const', name, type, init, line: t.line, col: t.col }
      }
      case 'var': {
        only(['group', 'binding'])
        this.next()
        const tmpl = this.varTemplate()
        const name = this.ident('a variable name').v
        const type = this.eat(':') ? this.type() : null
        const init = this.eat('=') ? this.expression() : null
        this.expect(';')
        return { k: 'var', name, attrs, tmpl, type, init, line: t.line, col: t.col }
      }
      case 'fn': {
        only(['vertex', 'fragment', 'compute', 'workgroup_size', 'must_use'])
        this.next()
        const name = this.ident('a function name').v
        this.expect('(')
        const params: Param[] = []
        while (!this.is(')')) {
          const pa = this.attrs()
          const pt = this.ident('a parameter name')
          this.expect(':')
          params.push({ name: pt.v, type: this.type(), attrs: pa, line: pt.line, col: pt.col })
          if (!this.eat(',')) break
        }
        this.expect(')')
        let ret: TypeExpr | null = null
        let retAttrs: Attr[] = []
        if (this.eat('->')) {
          retAttrs = this.attrs()
          ret = this.type()
        }
        const body = this.compound()
        return { k: 'fn', name, attrs, params, ret, retAttrs, body, line: t.line, col: t.col }
      }
      default:
        return refuse(t, `${t.v} does not begin a declaration in the subset (override and const_assert are outside it)`)
    }
  }

  varTemplate(): string[] {
    const list: string[] = []
    if (this.eat('<')) {
      while (!this.is('>')) {
        list.push(this.ident('an address space or access mode').v)
        if (!this.eat(',')) break
      }
      this.closeAngle()
    }
    return list
  }

  type(): TypeExpr {
    const t = this.ident('a type')
    let args: (TypeExpr | Expr)[] | null = null
    if (TEMPLATED.has(t.v) && this.is('<')) args = this.templateList()
    return { k: 'type', name: t.v, args, line: t.line, col: t.col }
  }

  /** A template list. An argument led by an identifier that names no value is a type; others are expressions. */
  templateList(): (TypeExpr | Expr)[] {
    this.expect('<')
    const args: (TypeExpr | Expr)[] = []
    while (!this.is('>') && !this.is('>>') && !this.is('>=') && !this.is('>>=')) {
      const t = this.peek()
      // Inside a template list `>` closes it, so an expression argument stops at the additive level.
      if (t.k === 'id' && !KEYWORDS.has(t.v) && !this.is('(', 1)) args.push(this.type())
      else args.push(this.additiveFrom(this.unary()))
      if (!this.eat(',')) break
    }
    this.closeAngle()
    return args
  }

  compound(): Stmt[] {
    this.expect('{')
    const body: Stmt[] = []
    while (!this.is('}')) {
      if (this.peek().k === 'end') refuse(this.peek(), 'a block is never closed')
      if (this.eat(';')) continue
      body.push(this.statement())
    }
    this.expect('}')
    return body
  }

  statement(): Stmt {
    const t = this.peek()
    const pos = { line: t.line, col: t.col }
    if (this.is('@')) refuse(t, 'attributes on statements are outside the subset')
    if (this.is('{')) return { k: 'block', body: this.compound(), ...pos }
    switch (t.k === 'id' ? t.v : '') {
      case 'return': {
        this.next()
        const value = this.is(';') ? null : this.expression()
        this.expect(';')
        return { k: 'return', value, ...pos }
      }
      case 'if': return this.ifStatement()
      case 'switch': {
        this.next()
        const sel = this.expression()
        this.expect('{')
        const clauses: { sels: (Expr | null)[]; body: Stmt[]; line: number; col: number }[] = []
        while (!this.is('}')) {
          const c = this.peek()
          const sels: (Expr | null)[] = []
          if (this.eat('default')) sels.push(null)
          else {
            this.expect('case', 'or default')
            while (!this.is(':') && !this.is('{')) {
              sels.push(this.eat('default') ? null : this.expression())
              if (!this.eat(',')) break
            }
          }
          this.eat(':')
          clauses.push({ sels, body: this.compound(), line: c.line, col: c.col })
        }
        this.expect('}')
        return { k: 'switch', sel, clauses, ...pos }
      }
      case 'loop': {
        this.next()
        this.expect('{')
        const body: Stmt[] = []
        let continuing: Stmt[] | null = null
        let breakIf: Expr | null = null
        while (!this.is('}')) {
          if (this.eat(';')) continue
          if (this.is('continuing')) {
            this.next()
            this.expect('{')
            continuing = []
            while (!this.is('}')) {
              if (this.eat(';')) continue
              if (this.is('break') && this.is('if', 1)) {
                this.next()
                this.next()
                breakIf = this.expression()
                this.expect(';')
                if (!this.is('}')) refuse(this.peek(), '`break if` must be the last statement of a continuing block')
                break
              }
              continuing.push(this.statement())
            }
            this.expect('}')
            if (!this.is('}')) refuse(this.peek(), 'the continuing block must be the last thing in a loop')
            break
          }
          body.push(this.statement())
        }
        this.expect('}')
        return { k: 'loop', body, continuing, breakIf, ...pos }
      }
      case 'for': {
        this.next()
        this.expect('(')
        const init = this.is(';') ? null : this.simple(true)
        this.expect(';')
        const cond = this.is(';') ? null : this.expression()
        this.expect(';')
        const update = this.is(')') ? null : this.simple(false)
        this.expect(')')
        return { k: 'for', init, cond, update, body: this.compound(), ...pos }
      }
      case 'while': {
        this.next()
        const cond = this.expression()
        return { k: 'while', cond, body: this.compound(), ...pos }
      }
      case 'break':
        this.next()
        if (this.is('if')) refuse(t, '`break if` belongs only at the end of a continuing block')
        this.expect(';')
        return { k: 'break', ...pos }
      case 'continue':
      case 'discard':
        this.next()
        this.expect(';')
        return { k: t.v as 'continue' | 'discard', ...pos }
      default: {
        const s = this.simple(true)
        this.expect(';')
        return s
      }
    }
  }

  ifStatement(): Stmt {
    const t = this.expect('if')
    const cond = this.expression()
    const then = this.compound()
    let other: Stmt[] | null = null
    if (this.eat('else')) other = this.is('if') ? [this.ifStatement()] : this.compound()
    return { k: 'if', cond, then, else: other, line: t.line, col: t.col }
  }

  /** A declaration, assignment, increment or call: the statements a `for` header may hold too. */
  simple(declarations: boolean): Stmt {
    const t = this.peek()
    const pos = { line: t.line, col: t.col }
    if (this.is('let') || this.is('const') || this.is('var')) {
      if (!declarations) refuse(t, `a ${t.v} declaration cannot be a for loop's update`)
      this.next()
      if (t.v === 'var') {
        const tmpl = this.varTemplate()
        if (tmpl.length > 0 && !(tmpl.length === 1 && tmpl[0] === 'function')) refuse(t, `var<${tmpl.join(', ')}> inside a function is not WGSL`)
        const name = this.ident('a variable name').v
        const type = this.eat(':') ? this.type() : null
        const init = this.eat('=') ? this.expression() : null
        return { k: 'var', name, type, init, ...pos }
      }
      const name = this.ident('a name').v
      const type = this.eat(':') ? this.type() : null
      this.expect('=', `to give ${t.v} ${name} its value`)
      return { k: t.v as 'let' | 'const', name, type, init: this.expression(), ...pos }
    }
    if (this.is('_')) {
      this.next()
      this.expect('=')
      return { k: 'assign', lhs: null, op: '=', rhs: this.expression(), ...pos }
    }
    const lhs = this.unary()
    const op = this.peek()
    if (op.k === 'op' && ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>='].includes(op.v)) {
      this.next()
      return { k: 'assign', lhs, op: op.v, rhs: this.expression(), ...pos }
    }
    if (op.k === 'op' && (op.v === '++' || op.v === '--')) {
      this.next()
      return { k: 'incr', lhs, op: op.v, ...pos }
    }
    if (lhs.k !== 'call') refuse(t, 'expected a statement')
    return { k: 'call', call: lhs, ...pos }
  }

  // Expressions, by WGSL's grammar: the operands of & | ^ and of << >> are unary expressions, relations do not chain,
  // and && and || do not mix with each other or with the bitwise operators.

  expression(): Expr {
    const u = this.unary()
    const t = this.peek()
    if (t.k === 'op' && (t.v === '&' || t.v === '|' || t.v === '^')) {
      let e = u
      while (this.is(t.v)) {
        const o = this.next()
        e = { k: 'binary', op: t.v, a: e, b: this.unary(), line: o.line, col: o.col }
      }
      this.noMore()
      return e
    }
    let r = this.relationalFrom(u)
    const l = this.peek()
    if (l.k === 'op' && (l.v === '&&' || l.v === '||')) {
      while (this.is(l.v)) {
        const o = this.next()
        r = { k: 'binary', op: l.v, a: r, b: this.relationalFrom(this.unary()), line: o.line, col: o.col }
      }
    }
    this.noMore()
    return r
  }
  noMore(): void {
    const t = this.peek()
    if (t.k === 'op' && BINARY_OPS.has(t.v)) refuse(t, `${t.v} cannot follow here: WGSL wants parentheses to mix these operators`)
  }
  relationalFrom(u: Expr): Expr {
    const s = this.shiftFrom(u)
    const t = this.peek()
    if (t.k === 'op' && RELATIONAL.has(t.v)) {
      this.next()
      return { k: 'binary', op: t.v, a: s, b: this.shiftFrom(this.unary()), line: t.line, col: t.col }
    }
    return s
  }
  shiftFrom(u: Expr): Expr {
    const t = this.peek()
    if (t.k === 'op' && (t.v === '<<' || t.v === '>>')) {
      this.next()
      return { k: 'binary', op: t.v, a: u, b: this.unary(), line: t.line, col: t.col }
    }
    return this.additiveFrom(u)
  }
  additiveFrom(u: Expr): Expr {
    let e = this.multiplicativeFrom(u)
    for (;;) {
      const t = this.peek()
      if (t.k !== 'op' || (t.v !== '+' && t.v !== '-')) return e
      this.next()
      e = { k: 'binary', op: t.v, a: e, b: this.multiplicativeFrom(this.unary()), line: t.line, col: t.col }
    }
  }
  multiplicativeFrom(u: Expr): Expr {
    let e = u
    for (;;) {
      const t = this.peek()
      if (t.k !== 'op' || (t.v !== '*' && t.v !== '/' && t.v !== '%')) return e
      this.next()
      e = { k: 'binary', op: t.v, a: e, b: this.unary(), line: t.line, col: t.col }
    }
  }
  unary(): Expr {
    const t = this.peek()
    if (t.k === 'op' && (t.v === '-' || t.v === '!' || t.v === '~' || t.v === '&' || t.v === '*')) {
      this.next()
      return { k: 'unary', op: t.v, a: this.unary(), line: t.line, col: t.col }
    }
    if (t.k === 'op' && (t.v === '--' || t.v === '&&')) refuse(t, `${t.v} here is two unary operators; WGSL wants a space or parentheses`)
    return this.singular()
  }
  singular(): Expr {
    let e = this.primary()
    for (;;) {
      const t = this.peek()
      if (this.eat('.')) {
        const m = this.ident('a member or swizzle')
        e = { k: 'member', a: e, name: m.v, line: m.line, col: m.col }
      } else if (this.eat('[')) {
        const i = this.expression()
        this.expect(']')
        e = { k: 'index', a: e, i, line: t.line, col: t.col }
      } else return e
    }
  }
  primary(): Expr {
    const t = this.peek()
    const pos = { line: t.line, col: t.col }
    if (t.k === 'num') {
      this.next()
      return { k: 'lit', text: t.v, ...pos }
    }
    if (this.eat('(')) {
      const a = this.expression()
      this.expect(')')
      return { k: 'paren', a, ...pos }
    }
    if (t.k === 'id' && (t.v === 'true' || t.v === 'false')) {
      this.next()
      return { k: 'lit', text: t.v, ...pos }
    }
    const id = this.ident('an expression')
    let tmpl: (TypeExpr | Expr)[] | null = null
    if (TEMPLATED.has(id.v) && this.is('<')) {
      tmpl = this.templateList()
      if (!this.is('(')) refuse(id, `${id.v}<...> must be called here`)
    }
    if (this.eat('(')) {
      const args: Expr[] = []
      while (!this.is(')')) {
        args.push(this.expression())
        if (!this.eat(',')) break
      }
      this.expect(')')
      return { k: 'call', name: id.v, tmpl, args, ...pos }
    }
    return { k: 'ident', name: id.v, ...pos }
  }
}

/** Parses WGSL text in the subset into its syntax tree. Throws a WgslError on anything outside the subset. */
function parse(src: string): ModuleAst {
  return new Parser(src).module()
}

// ---------------------------------------------------------------------------------------------------
// Types and layouts

/** Scalar kinds; `ai` and `af` are WGSL's abstract int and abstract float, the types of literals before conversion. */
type Scalar = 'bool' | 'i32' | 'u32' | 'f32' | 'ai' | 'af'
interface Member {
  readonly name: string
  readonly ty: Ty
  readonly offset: number
  readonly size: number
  readonly align: number
  /** The stage attributes of an entry point's input or output member. */
  readonly io: Io | null
}
interface StructTy {
  readonly k: 'struct'
  readonly name: string
  readonly members: readonly Member[]
  readonly size: number
  readonly align: number
}
type TexSample = 'f32' | 'i32' | 'u32' | 'depth'
type Ty =
  | { readonly k: 'scalar'; readonly s: Scalar }
  | { readonly k: 'vec'; readonly n: number; readonly s: Scalar }
  | { readonly k: 'mat'; readonly c: number; readonly r: number; readonly s: 'f32' | 'af' }
  /** n is the element count, or 0 for an array sized by its binding. */
  | { readonly k: 'array'; readonly e: Ty; readonly n: number }
  | StructTy
  | { readonly k: 'tex'; readonly dim: '2d' | '2d_array'; readonly sample: TexSample }
  | { readonly k: 'storage-tex'; readonly format: Format; readonly s: 'f32' | 'i32' | 'u32' }
  | { readonly k: 'sampler' }
  | { readonly k: 'ptr'; readonly space: Space; readonly to: Ty; readonly access: Access }
  | { readonly k: 'void' }
type Space = 'function' | 'private' | 'workgroup' | 'uniform' | 'storage' | 'handle'
type Access = 'read' | 'read_write'
/** A stage input or output: a builtin by name, or a location (with flat interpolation or not). */
type Io = { readonly builtin: string } | { readonly location: number; readonly flat: boolean }

const SCALARS: { readonly [S in Scalar]: Ty } = {
  bool: { k: 'scalar', s: 'bool' }, i32: { k: 'scalar', s: 'i32' }, u32: { k: 'scalar', s: 'u32' },
  f32: { k: 'scalar', s: 'f32' }, ai: { k: 'scalar', s: 'ai' }, af: { k: 'scalar', s: 'af' },
}
const VOID: Ty = { k: 'void' }
const vecTy = (n: number, s: Scalar): Ty => (n === 1 ? SCALARS[s] : { k: 'vec', n, s })
const matTy = (c: number, r: number, s: 'f32' | 'af' = 'f32'): Ty => ({ k: 'mat', c, r, s })

/** WGSL's storage texel formats in the subset, and the format each names. */
const STORAGE_FORMATS: { readonly [name: string]: { readonly format: Format; readonly s: 'f32' | 'i32' | 'u32' } } = {
  rgba8unorm: { format: 'rgba8', s: 'f32' }, rgba16float: { format: 'rgba16f', s: 'f32' }, r32float: { format: 'r32f', s: 'f32' },
  rg32float: { format: 'rg32f', s: 'f32' }, rgba32float: { format: 'rgba32f', s: 'f32' }, r32uint: { format: 'r32u', s: 'u32' }, r32sint: { format: 'r32i', s: 'i32' },
}

function typeName(t: Ty): string {
  switch (t.k) {
    case 'scalar': return t.s === 'ai' ? 'abstract-int' : t.s === 'af' ? 'abstract-float' : t.s
    case 'vec': return `vec${t.n}<${typeName(SCALARS[t.s])}>`
    case 'mat': return `mat${t.c}x${t.r}<${typeName(SCALARS[t.s])}>`
    case 'array': return t.n === 0 ? `array<${typeName(t.e)}>` : `array<${typeName(t.e)}, ${t.n}>`
    case 'struct': return t.name
    case 'tex': return t.sample === 'depth' ? `texture_depth_${t.dim}` : `texture_${t.dim}<${t.sample}>`
    case 'storage-tex': return `texture_storage_2d<${Object.keys(STORAGE_FORMATS).find((n) => STORAGE_FORMATS[n].format === t.format)}, write>`
    case 'sampler': return 'sampler'
    case 'ptr': return `ptr<${t.space}, ${typeName(t.to)}, ${t.access}>`
    case 'void': return 'nothing'
  }
}

function same(a: Ty, b: Ty): boolean {
  if (a === b) return true
  if (a.k !== b.k) return false
  switch (a.k) {
    case 'scalar': return a.s === (b as typeof a).s
    case 'vec': return a.n === (b as typeof a).n && a.s === (b as typeof a).s
    case 'mat': return a.c === (b as typeof a).c && a.r === (b as typeof a).r && a.s === (b as typeof a).s
    case 'array': return a.n === (b as typeof a).n && same(a.e, (b as typeof a).e)
    case 'tex': return a.dim === (b as typeof a).dim && a.sample === (b as typeof a).sample
    case 'storage-tex': return a.format === (b as typeof a).format
    case 'ptr': return a.space === (b as typeof a).space && a.access === (b as typeof a).access && same(a.to, (b as typeof a).to)
    default: return false
  }
}

/** The scalar a scalar, vector or grid is made of, or null. */
const scalarOf = (t: Ty): Scalar | null => (t.k === 'scalar' || t.k === 'vec' || t.k === 'mat' ? t.s : null)
/** Components across: 1 for a scalar, n for a vector, 0 for anything else. */
const widthOf = (t: Ty): number => (t.k === 'scalar' ? 1 : t.k === 'vec' ? t.n : 0)
const isFloat = (s: Scalar | null): boolean => s === 'f32' || s === 'af'
const isInt = (s: Scalar | null): boolean => s === 'i32' || s === 'u32' || s === 'ai'
const isNum = (s: Scalar | null): boolean => s !== null && s !== 'bool'
const isAbstract = (t: Ty): boolean => {
  if (t.k === 'array') return isAbstract(t.e)
  const s = scalarOf(t)
  return s === 'ai' || s === 'af'
}
/** The concrete type an abstract one becomes when nothing else decides: abstract int is i32, abstract float f32. */
function concrete(t: Ty): Ty {
  switch (t.k) {
    case 'scalar': return t.s === 'ai' ? SCALARS.i32 : t.s === 'af' ? SCALARS.f32 : t
    case 'vec': return t.s === 'ai' || t.s === 'af' ? vecTy(t.n, t.s === 'ai' ? 'i32' : 'f32') : t
    case 'mat': return t.s === 'af' ? matTy(t.c, t.r) : t
    case 'array': return isAbstract(t.e) ? { k: 'array', e: concrete(t.e), n: t.n } : t
    default: return t
  }
}
/** Whether WGSL converts a value of type `from` to `to` automatically: only abstract values convert, by shape. */
function converts(from: Ty, to: Ty): boolean {
  if (same(from, to)) return true
  const ok = (a: Scalar, b: Scalar): boolean => a === b || (a === 'ai' && (b === 'i32' || b === 'u32' || b === 'f32' || b === 'af')) || (a === 'af' && b === 'f32')
  if (from.k === 'scalar' && to.k === 'scalar') return ok(from.s, to.s)
  if (from.k === 'vec' && to.k === 'vec') return from.n === to.n && ok(from.s, to.s)
  if (from.k === 'mat' && to.k === 'mat') return from.c === to.c && from.r === to.r && ok(from.s, to.s)
  if (from.k === 'array' && to.k === 'array') return from.n === to.n && converts(from.e, to.e)
  return false
}
/** The one type both of two types convert to (abstract ones giving way), or null. */
function unify(a: Ty, b: Ty): Ty | null {
  if (converts(a, b)) return b
  if (converts(b, a)) return a
  return null
}

const roundUp = (k: number, n: number): number => Math.ceil(n / k) * k

/** WGSL's AlignOf. */
function alignOf(t: Ty): number {
  switch (t.k) {
    case 'scalar': return 4
    case 'vec': return t.n === 2 ? 8 : 16
    case 'mat': return t.r === 2 ? 8 : 16
    case 'array': return alignOf(t.e)
    case 'struct': return t.align
    default: return 4
  }
}
/** WGSL's SizeOf (an array sized by its binding counts one element: the size WebGPU's minimum binding size uses). */
function sizeOf(t: Ty): number {
  switch (t.k) {
    case 'scalar': return 4
    case 'vec': return t.n === 3 ? 12 : t.n * 4
    case 'mat': return t.c * roundUp(alignOf(vecTy(t.r, 'f32')), sizeOf(vecTy(t.r, 'f32')))
    case 'array': return Math.max(1, t.n) * strideOf(t)
    case 'struct': return t.size
    default: return 4
  }
}
const strideOf = (t: Extract<Ty, { k: 'array' }>): number => roundUp(alignOf(t.e), sizeOf(t.e))

// ---------------------------------------------------------------------------------------------------
// Values

/** A value: a number for a scalar (bool 0 or 1), an array for a vector, a grid (its columns), an array or a struct. */
type Val = number | Val[]
/** A value per lane of a wave; lanes that are not running hold whatever was there. */
type Lanes = Val[]
/** The lanes of a wave that run a statement: 1 for running. */
type Mask = Uint8Array

const copy = (v: Val): Val => (typeof v === 'number' ? v : v.map(copy))

/** The zero value of a constructible type. */
function zeroOf(t: Ty): Val {
  switch (t.k) {
    case 'scalar': return 0
    case 'vec': return new Array<number>(t.n).fill(0)
    case 'mat': return Array.from({ length: t.c }, () => new Array<number>(t.r).fill(0))
    case 'array': return Array.from({ length: t.n }, () => zeroOf(t.e))
    case 'struct': return t.members.map((m) => zeroOf(m.ty))
    default: return 0
  }
}

const POISON_BITS = 0x5a5a5a5a
const F32_MAX = 3.4028234663852886e38
const F32_MIN_NORMAL = 2 ** -126
const I32_MIN = -0x80000000
const I32_MAX = 0x7fffffff
const U32_MAX = 0xffffffff
const f32 = Math.fround
const bitsView = new DataView(new ArrayBuffer(8))
const f32Bits = (x: number): number => {
  bitsView.setFloat32(0, x, true)
  return bitsView.getUint32(0, true)
}
const bitsF32 = (u: number): number => {
  bitsView.setUint32(0, u >>> 0, true)
  return bitsView.getFloat32(0, true)
}
const POISON_F32 = bitsF32(POISON_BITS)

/** A value of type `t` with every component poison. */
function poisonOf(t: Ty): Val {
  switch (t.k) {
    case 'scalar': return t.s === 'f32' || t.s === 'af' ? POISON_F32 : t.s === 'bool' ? 1 : POISON_BITS
    case 'vec': return new Array<number>(t.n).fill(poisonOf(SCALARS[t.s]) as number)
    case 'mat': return Array.from({ length: t.c }, () => new Array<number>(t.r).fill(POISON_F32))
    case 'array': return Array.from({ length: t.n }, () => poisonOf(t.e))
    case 'struct': return t.members.map((m) => poisonOf(m.ty))
    default: return 0
  }
}

/** The next f32 after x in the direction of `dir` (+1 up, -1 down). */
function stepF32(x: number, dir: number): number {
  if (Number.isNaN(x) || (x === Infinity && dir > 0) || (x === -Infinity && dir < 0)) return x
  if (x === 0) return dir > 0 ? bitsF32(1) : bitsF32(0x80000001)
  const b = f32Bits(x)
  return bitsF32((x > 0) === (dir > 0) ? b + 1 : b - 1)
}
/** Steps x by n f32 steps toward zero (never through it): the safe way to sit n ULP off a result. */
function towardZero(x: number, n: number): number {
  let r = x
  for (let i = 0; i < n && r !== 0 && Number.isFinite(r); i++) r = stepF32(r, r > 0 ? -1 : 1)
  return r
}
const isSubnormal = (x: number): boolean => x !== 0 && Math.abs(x) < F32_MIN_NORMAL

/**
 * a b + c rounded once to f32 (the same rounding to odd as interp.ts's fusedF32): the product of two f32 values is
 * exact in a double, the sum's error is recovered exactly, and a sticky last bit keeps the final rounding single.
 */
function fused(a: number, b: number, c: number): number {
  const p = a * b
  const s = p + c
  if (!Number.isFinite(s)) return f32(s)
  const v = s - p
  const err = (p - (s - v)) + (c - v)
  if (err === 0) return f32(s)
  bitsView.setFloat64(0, s, true)
  const lo = bitsView.getUint32(0, true)
  if ((lo & 1) === 0) {
    if (err > 0 === s > 0) bitsView.setUint32(0, lo + 1, true)
    else if (lo === 0) {
      bitsView.setUint32(0, 0xffffffff, true)
      bitsView.setUint32(4, bitsView.getUint32(4, true) - 1, true)
    } else bitsView.setUint32(0, lo - 1, true)
  }
  return f32(bitsView.getFloat64(0, true))
}

/** Rounds half to even, as WGSL's round. */
function roundEven(x: number): number {
  const f = Math.floor(x)
  return x - f === 0.5 && f % 2 === 0 ? f : Math.round(x)
}

// ---------------------------------------------------------------------------------------------------
// Freedoms: what WGSL leaves open, each of which the adversarial mode takes the wrong way

const FREEDOMS = ['minmax-nan', 'clamp-median', 'compare-nan', 'finite', 'zero-sign', 'rounding', 'flush', 'contract', 'reassociate', 'convert', 'division', 'library',
  'fract', 'sign-nan', 'oob', 'helper-stores', 'sample-nan', 'derivatives'] as const
type Freedom = (typeof FREEDOMS)[number]
type Mode = 'exact' | 'adversarial'
interface RunOptions {
  readonly mode: Mode
  /** Adversarial freedoms to leave alone (taken as exact mode takes them). */
  readonly except?: readonly Freedom[]
  /** Steps a run may take (statements and loop iterations, per wave) before it stops with a RunError. */
  readonly budget?: number
}

/**
 * The numbers of one mode: every float operation goes through here, so each freedom lives in one place. The names
 * follow the WGSL operation; `x`, `y`, `z` are f32 operands already rounded.
 */
class Numbers {
  readonly on: ReadonlySet<Freedom>
  readonly minmaxNan: boolean
  readonly clampMedian: boolean
  readonly compareNan: boolean
  readonly finite: boolean
  readonly zeroSign: boolean
  readonly rounding: boolean
  readonly flush: boolean
  readonly contract: boolean
  readonly reassociate: boolean
  readonly convert: boolean
  readonly division: boolean
  readonly library: boolean
  readonly fractBelow: boolean
  readonly signNan: boolean
  readonly oob: boolean
  readonly helperStores: boolean
  readonly sampleNan: boolean
  readonly derivatives: boolean

  constructor(options: RunOptions) {
    const on = new Set<Freedom>(options.mode === 'adversarial' ? FREEDOMS : [])
    for (const f of options.except ?? []) on.delete(f)
    this.on = on
    this.minmaxNan = on.has('minmax-nan')
    this.clampMedian = on.has('clamp-median')
    this.compareNan = on.has('compare-nan')
    this.finite = on.has('finite')
    this.zeroSign = on.has('zero-sign')
    this.rounding = on.has('rounding')
    this.flush = on.has('flush')
    this.contract = on.has('contract')
    this.reassociate = on.has('reassociate')
    this.convert = on.has('convert')
    this.division = on.has('division')
    this.library = on.has('library')
    this.fractBelow = on.has('fract')
    this.signNan = on.has('sign-nan')
    this.oob = on.has('oob')
    this.helperStores = on.has('helper-stores')
    this.sampleNan = on.has('sample-nan')
    this.derivatives = on.has('derivatives')
  }

  /** An operand as a float operation takes it: flushed when subnormal, under `flush`. */
  in(x: number): number {
    return this.flush && isSubnormal(x) ? (x < 0 ? -0 : 0) : x
  }
  /** Whether `finite` makes an operation with these operands poison. */
  bad(...xs: number[]): boolean {
    if (!this.finite) return false
    for (const x of xs) if (!Number.isFinite(x)) return true
    return false
  }
  /** A float operation's rounded result, as the mode delivers it: poison past the finite range, flushed, re-signed. */
  out(r: number): number {
    if (this.finite && (!Number.isFinite(r) || Math.abs(r) > F32_MAX)) return POISON_F32
    let v = r
    if (this.flush && isSubnormal(v)) v = v < 0 ? -0 : 0
    if (this.zeroSign && v === 0) v = Object.is(v, -0) ? 0 : -0
    return v
  }
  /** The f32 of an exact double `x` (with `err` the part of the exact value a double could not hold). */
  round(x: number, err = 0): number {
    const r = f32(x)
    if (!this.rounding || !Number.isFinite(x)) return r
    const dir = x !== r ? (x > r ? 1 : -1) : err !== 0 ? (err > 0 ? 1 : -1) : 0
    return dir === 0 ? r : stepF32(r, dir)
  }
  add(a: number, b: number): number {
    const x = this.in(a)
    const y = this.in(b)
    if (this.bad(x, y)) return POISON_F32
    const s = x + y
    const v = s - x
    return this.out(this.round(s, (x - (s - v)) + (y - v)))
  }
  sub(a: number, b: number): number {
    return this.add(a, -b)
  }
  mul(a: number, b: number): number {
    const x = this.in(a)
    const y = this.in(b)
    if (this.bad(x, y)) return POISON_F32
    return this.out(this.round(x * y))
  }
  div(a: number, b: number): number {
    const x = this.in(a)
    const y = this.in(b)
    if (this.bad(x, y)) return POISON_F32
    const q = x / y
    if (!this.division) {
      if (!this.rounding || !Number.isFinite(q) || y === 0) return this.out(f32(q))
      const r = f32(q)
      const side = Math.sign((x - r * y) * Math.sign(y))
      return this.out(side === 0 ? r : stepF32(r, side))
    }
    const m = Math.abs(y)
    if (!(m >= 2 ** -126 && m <= 2 ** 126)) return POISON_F32
    // Two steps toward zero from the rounded quotient: within WGSL's 2.5 ULP, since a step toward zero is never
    // larger than the ULP of the exact quotient.
    return this.out(towardZero(f32(q), 2))
  }
  neg(a: number): number {
    const x = this.in(a)
    return this.bad(x) ? POISON_F32 : this.out(-x)
  }
  /** a b + c: fused when `contract` (or when asked to fuse), else two roundings. */
  muladd(a: number, b: number, c: number, fuse: boolean): number {
    if (!fuse) return this.add(this.mul(a, b), c)
    const x = this.in(a)
    const y = this.in(b)
    const z = this.in(c)
    if (this.bad(x, y, z) || this.bad(x * y)) return POISON_F32
    return this.out(fused(x, y, z))
  }
  /** fma: one rounding in exact mode (interp.ts's choice), two under `contract`. */
  fma(a: number, b: number, c: number): number {
    return this.muladd(a, b, c, !this.contract)
  }
  /** A float comparison; `op` returns its IEEE answer. */
  compare(a: number, b: number, op: (x: number, y: number) => boolean): number {
    const x = this.in(a)
    const y = this.in(b)
    if (this.compareNan && (Number.isNaN(x) || Number.isNaN(y))) return 1
    return op(x, y) ? 1 : 0
  }
  /** Applies a correctly rounded one-operand function `f` (already rounding to f32). */
  exact1(a: number, f: (x: number) => number): number {
    const x = this.in(a)
    return this.bad(x) ? POISON_F32 : this.out(f(x))
  }
  min(a: number, b: number): number {
    const x = this.in(a)
    const y = this.in(b)
    if (this.minmaxNan && (Number.isNaN(x) || Number.isNaN(y))) return Number.isNaN(x) ? x : y
    if (this.bad(x, y)) return POISON_F32
    return this.out(Number.isNaN(x) || y < x ? y : x)
  }
  max(a: number, b: number): number {
    const x = this.in(a)
    const y = this.in(b)
    if (this.minmaxNan && (Number.isNaN(x) || Number.isNaN(y))) return Number.isNaN(x) ? x : y
    if (this.bad(x, y)) return POISON_F32
    return this.out(Number.isNaN(x) || y > x ? y : x)
  }
  clamp(e: number, lo: number, hi: number): number {
    const x = this.in(e)
    const l = this.in(lo)
    const h = this.in(hi)
    if (this.minmaxNan && (Number.isNaN(x) || Number.isNaN(l) || Number.isNaN(h))) return Number.isNaN(x) ? x : Number.isNaN(l) ? l : h
    if (this.bad(x, l, h)) return POISON_F32
    if (this.clampMedian && l > h) return this.out(Math.max(Math.min(x, l), Math.min(Math.max(x, l), h)))
    const m = Number.isNaN(x) || l > x ? l : x
    return this.out(Number.isNaN(m) || h < m ? h : m)
  }
  fract(a: number): number {
    const x = this.in(a)
    if (this.bad(x)) return POISON_F32
    const r = this.sub(x, Math.floor(x))
    return this.fractBelow && r >= 1 ? bitsF32(0x3f7fffff) : r
  }
  sign(a: number): number {
    const x = this.in(a)
    if (Number.isNaN(x)) return this.signNan ? 1 : 0
    if (this.bad(x)) return POISON_F32
    return this.out(x > 0 ? 1 : x < 0 ? -1 : 0)
  }
  /** f32 to i32 or u32: WGSL clamps to the nearest value the f32 can hold and truncates; NaN is left open. */
  toInt(a: number, s: 'i32' | 'u32'): number {
    const x = a
    if (Number.isNaN(x)) return this.convert ? (s === 'i32' ? POISON_BITS | 0 : POISON_BITS) : 0
    const t = Math.trunc(x)
    const lo = s === 'i32' ? I32_MIN : 0
    const hi = s === 'i32' ? I32_MAX : U32_MAX
    if (t < lo || t > hi) {
      if (this.convert) return s === 'i32' ? POISON_BITS | 0 : POISON_BITS
      return t < lo ? lo : s === 'i32' ? 2147483520 : 4294967040
    }
    return s === 'i32' ? t | 0 : t >>> 0
  }
  /** i32 or u32 to f32: WGSL lets either neighbour be taken when the integer is not exact. */
  toFloat(i: number): number {
    const r = f32(i)
    if (!(this.convert || this.rounding) || r === i) return r
    return stepF32(r, i > r ? 1 : -1)
  }
  /** A bit cast to f32: subnormal patterns flush under `flush`. */
  fromBits(u: number): number {
    const x = bitsF32(u)
    return this.flush && isSubnormal(x) ? (x < 0 ? -0 : 0) : x
  }
  /** A bit cast from f32. */
  toBits(x: number): number {
    return f32Bits(this.flush && isSubnormal(x) ? (x < 0 ? -0 : 0) : x)
  }

  // The library functions. Exact mode computes in double and rounds once (interp.ts); adversarial sits as far from
  // that as WGSL's accuracy table allows, and gives poison where the table bounds nothing.

  /** `exact` off by `ulps` ULP of WGSL's bound (toward zero), when `library`. */
  private ulps(x: number, bound: number): number {
    const r = f32(x)
    return this.library ? towardZero(r, Math.floor(bound - 0.5)) : r
  }
  /** `exact` off by just under an absolute bound, when `library`. */
  private absolute(x: number, bound: number): number {
    if (!this.library) return f32(x)
    const want = x - bound * 0.99 * Math.sign(x || 1)
    let r = f32(want)
    if (Math.abs(r - x) > bound) r = stepF32(r, x > r ? 1 : -1)
    return r
  }
  /** One-operand library function: NaN and infinite operands are `finite`'s, the rest by `body`. */
  lib1(a: number, body: (x: number) => number): number {
    const x = this.in(a)
    if (this.bad(x)) return POISON_F32
    const r = body(x)
    if (this.finite && Number.isNaN(r)) return POISON_F32
    return this.out(r)
  }
  inverseSqrt(a: number): number {
    return this.lib1(a, (x) => (this.library && !(x > 0) ? POISON_F32 : this.ulps(1 / Math.sqrt(x), 2)))
  }
  sqrt(a: number): number {
    // Inherited from 1.0 / inverseSqrt(x): WGSL's 2 ULP, then a division's 2.5, each as far off as it may be. (4.5 ULP
    // of the root itself is not the same set: it can lie outside what that expression may give.)
    if (!this.library) return this.lib1(a, (x) => f32(Math.sqrt(x)))
    return this.lib1(a, (x) => (x > 0 ? this.div(1, this.inverseSqrt(x)) : POISON_F32))
  }
  exp(a: number, base2: boolean): number {
    return this.lib1(a, (x) => this.ulps(base2 ? 2 ** x : Math.exp(x), 3 + 2 * Math.abs(x)))
  }
  log(a: number, base2: boolean): number {
    return this.lib1(a, (x) => {
      const r = base2 ? Math.log2(x) : Math.log(x)
      if (this.library && !(x > 0)) return POISON_F32
      return x >= 0.5 && x <= 2 ? this.absolute(r, 2 ** -21) : this.ulps(r, 3)
    })
  }
  trig(a: number, fn: 'sin' | 'cos' | 'tan'): number {
    return this.lib1(a, (x) => {
      if (!this.library) return f32(Math[fn](x))
      if (!(Math.abs(x) <= Math.PI)) return POISON_F32
      if (fn !== 'tan') return this.absolute(Math[fn](x), 2 ** -11)
      // Inherited from sin(x) / cos(x).
      return this.div(this.absolute(Math.sin(x), 2 ** -11), this.absolute(Math.cos(x), 2 ** -11))
    })
  }
  arc(a: number, fn: 'asin' | 'acos' | 'atan'): number {
    return this.lib1(a, (x) => {
      const r = Math[fn](x)
      if (!this.library) return f32(r)
      if (Number.isNaN(r)) return POISON_F32
      return fn === 'atan' ? this.ulps(r, 4096) : this.absolute(r, fn === 'asin' ? 6.81e-5 : 6.77e-5)
    })
  }
  hyper(a: number, fn: 'sinh' | 'cosh' | 'tanh'): number {
    return this.lib1(a, (x) => {
      if (!this.library) return f32(Math[fn](x))
      // Inherited from (exp(x) -/+ exp(-x)) * 0.5, and tanh from their quotient or 1e-5 absolute.
      const e = this.exp(x, false)
      const n = this.exp(-x, false)
      if (fn === 'tanh') return this.absolute(Math.tanh(x), 1e-5)
      return this.mul(fn === 'sinh' ? this.sub(e, n) : this.add(e, n), 0.5)
    })
  }
  atan2(b: number, a: number): number {
    const y = this.in(b)
    const x = this.in(a)
    if (this.bad(y, x)) return POISON_F32
    const r = Math.atan2(y, x)
    if (!this.library) return this.out(f32(r))
    const m = Math.abs(x)
    if (!(m >= 2 ** -126 && m <= 2 ** 126) || !(Math.abs(y) >= 2 ** -126)) return POISON_F32
    return this.out(this.ulps(r, 4096))
  }
  pow(a: number, b: number): number {
    const x = this.in(a)
    const y = this.in(b)
    if (this.bad(x, y)) return POISON_F32
    if (!this.library) {
      const r = f32(Math.pow(x, y))
      return this.finite && Number.isNaN(r) ? POISON_F32 : this.out(r)
    }
    // Inherited from exp2(y * log2(x)): outside log2's domain WGSL bounds nothing.
    if (!(x > 0)) return POISON_F32
    return this.exp(this.mul(y, this.log(x, true)), true)
  }
}

// ---------------------------------------------------------------------------------------------------
// Memory and the wave

/** A variable's value as it is kept: a holder whose value nested stores change in place. */
interface Holder {
  v: Val
}
/** An image as bound: its store and the view's levels and layers. */
interface ImageBinding {
  readonly store: ImageStore
  readonly view: ViewRange
}
/** Where a reference points, for one lane. */
interface Ref {
  /** A variable's holder and the path of indices into its value; null for a buffer. */
  readonly h: Holder | null
  readonly path: number[]
  /** A buffer's bytes and the byte offset; null for a variable. */
  readonly buf: DataView | null
  off: number
  /** 0: in range. DEAD: there is nothing there (reads zero, stores do nothing). WILD: outside, under `oob`. */
  flag: number
}
const DEAD = 1
const WILD = 2

/** The state of the wave being run, shared by every closure of one compiled module. */
class Wave {
  /** Lanes in the wave. */
  L = 1
  frame: unknown[] = []
  /** The innermost loop's or switch's lanes that broke, the innermost loop's that continued, the function's returns. */
  brk: Mask = new Uint8Array(1)
  cont: Mask = new Uint8Array(1)
  ret: Mask = new Uint8Array(1)
  retv: Lanes = []
  /** Lanes that are helpers (they started as one, or ran discard), and those that ran discard. */
  helper: Mask = new Uint8Array(1)
  discarded: Mask = new Uint8Array(1)
  /** Per module variable (by its index): private holders per lane, the workgroup's holder, buffers, images, samplers. */
  priv: Holder[][] = []
  wg: Holder[] = []
  bufs: (DataView | null)[] = []
  images: (ImageBinding | null)[] = []
  samplers: (SamplerState | null)[] = []
  /** True while a fragment quad runs: derivatives may be taken. */
  quad = false
  steps = 0
  budget = 0
  /** Accesses outside a vector, grid, array, buffer or image, and texture levels out of range, so far. */
  oob = 0
}

const anyOn = (m: Mask): boolean => {
  for (let l = 0; l < m.length; l++) if (m[l] !== 0) return true
  return false
}
const allOn = (m: Mask): boolean => {
  for (let l = 0; l < m.length; l++) if (m[l] === 0) return false
  return true
}
function maskOf(m: Mask, v: Lanes, want: boolean): Mask {
  const out = new Uint8Array(m.length)
  for (let l = 0; l < m.length; l++) if (m[l] !== 0 && (v[l] !== 0) === want) out[l] = 1
  return out
}
function orInto(a: Mask, b: Mask): void {
  for (let l = 0; l < a.length; l++) if (b[l] !== 0) a[l] = 1
}

/** Reads a value of type `t` from little-endian bytes. */
function decode(t: Ty, d: DataView, at: number): Val {
  switch (t.k) {
    case 'scalar': return t.s === 'f32' ? d.getFloat32(at, true) : t.s === 'i32' ? d.getInt32(at, true) : d.getUint32(at, true)
    case 'vec': return Array.from({ length: t.n }, (_, i) => decode(SCALARS[t.s], d, at + 4 * i))
    case 'mat': {
      const col = vecTy(t.r, 'f32')
      const stride = roundUp(alignOf(col), sizeOf(col))
      return Array.from({ length: t.c }, (_, j) => decode(col, d, at + j * stride))
    }
    case 'array': return Array.from({ length: t.n }, (_, i) => decode(t.e, d, at + i * strideOf(t)))
    case 'struct': return t.members.map((m) => decode(m.ty, d, at + m.offset))
    default: throw new RunError(`a ${typeName(t)} is not kept in a buffer`)
  }
}
function encode(t: Ty, d: DataView, at: number, v: Val): void {
  switch (t.k) {
    case 'scalar':
      if (t.s === 'f32') d.setFloat32(at, v as number, true)
      else if (t.s === 'i32') d.setInt32(at, v as number, true)
      else d.setUint32(at, v as number, true)
      return
    case 'vec': for (let i = 0; i < t.n; i++) encode(SCALARS[t.s], d, at + 4 * i, (v as Val[])[i]); return
    case 'mat': {
      const col = vecTy(t.r, 'f32')
      const stride = roundUp(alignOf(col), sizeOf(col))
      for (let j = 0; j < t.c; j++) encode(col, d, at + j * stride, (v as Val[])[j])
      return
    }
    case 'array': for (let i = 0; i < t.n; i++) encode(t.e, d, at + i * strideOf(t), (v as Val[])[i]); return
    case 'struct': t.members.forEach((m, i) => encode(m.ty, d, at + m.offset, (v as Val[])[i])); return
    default: throw new RunError(`a ${typeName(t)} is not kept in a buffer`)
  }
}

function loadRef(r: Ref, t: Ty): Val {
  if (r.flag === DEAD) return zeroOf(t)
  if (r.flag === WILD) return poisonOf(t)
  if (r.buf !== null) return decode(t, r.buf, r.off)
  let v = (r.h as Holder).v
  for (const i of r.path) v = (v as Val[])[i]
  return copy(v)
}
function storeRef(r: Ref, t: Ty, value: Val): void {
  if (r.flag === DEAD) return
  if (r.buf !== null) {
    if (r.off >= 0 && r.off + sizeOf(t) <= r.buf.byteLength) encode(t, r.buf, r.off, value)
    return
  }
  const h = r.h as Holder
  if (r.path.length === 0) {
    h.v = copy(value)
    return
  }
  let v = h.v
  for (let i = 0; i < r.path.length - 1; i++) v = (v as Val[])[r.path[i]]
  ;(v as Val[])[r.path[r.path.length - 1]] = copy(value)
}

// ---------------------------------------------------------------------------------------------------
// The checker, which compiles as it checks: every expression becomes a closure from a mask to a value per lane

/** A checked expression. */
interface Ex {
  readonly ty: Ty
  readonly pos: Pos
  /** The value of a const-expression. */
  readonly cv: Val | undefined
  /** The value per running lane (memory is loaded). */
  readonly ev: (m: Mask) => Lanes
  /** For an expression that names memory: the reference per running lane, its address space and access. */
  readonly pl: ((m: Mask) => Ref[]) | null
  readonly space: Space | null
  readonly access: Access | null
  /** Evaluating it again gives the same value and does nothing else (literals, constants, let names and pure arithmetic over them). */
  readonly pure: boolean
  /** An f32 product over pure operands, or a let name bound to one: what `contract` may fuse into a later add. */
  readonly mul: { readonly a: Ex; readonly b: Ex } | null
  /** A texture or sampler variable's index, or -1. */
  readonly handle: number
}

const NEXT = 1
const RETURN = 2
const BREAK = 4
const CONTINUE = 8
type Run = (m: Mask) => Mask
interface Compiled {
  readonly run: Run
  readonly beh: number
}

interface GVar {
  readonly name: string
  readonly index: number
  readonly space: Space
  readonly access: Access
  readonly ty: Ty
  readonly group: number
  readonly binding: number
  readonly init: Val | null
}
interface Local {
  readonly k: 'let' | 'var' | 'const' | 'param'
  readonly ty: Ty
  readonly slot: number
  readonly cv: Val | undefined
  readonly mul: { readonly a: Ex; readonly b: Ex } | null
}
interface IoSlot {
  readonly io: Io
  readonly ty: Ty
  /** The parameter index and the member index (or -1) the value goes to or comes from. */
  readonly param: number
  readonly member: number
}
interface FnInfo {
  readonly name: string
  readonly decl: Extract<Decl, { k: 'fn' }>
  readonly stage: 'compute' | 'vertex' | 'fragment' | null
  readonly params: readonly Ty[]
  readonly ret: Ty
  group: readonly [number, number, number]
  inputs: readonly IoSlot[]
  outputs: readonly IoSlot[]
  body: Run
  slots: number
  paramSlots: readonly number[]
  state: 'checking' | 'done'
  /** What it, or anything it calls, uses that only one stage allows. */
  readonly uses: Set<'discard' | 'derivative' | 'barrier' | 'workgroup'>
}

const EXACT = new Numbers({ mode: 'exact' })
const SWIZZLE = ['xyzw', 'rgba']
const BUILTIN_IO: { readonly [name: string]: { readonly ty: Ty; readonly stage: 'compute' | 'vertex' | 'fragment'; readonly dir: 'in' | 'out' } } = {
  vertex_index: { ty: SCALARS.u32, stage: 'vertex', dir: 'in' },
  instance_index: { ty: SCALARS.u32, stage: 'vertex', dir: 'in' },
  front_facing: { ty: SCALARS.bool, stage: 'fragment', dir: 'in' },
  frag_depth: { ty: SCALARS.f32, stage: 'fragment', dir: 'out' },
  local_invocation_id: { ty: vecTy(3, 'u32'), stage: 'compute', dir: 'in' },
  local_invocation_index: { ty: SCALARS.u32, stage: 'compute', dir: 'in' },
  global_invocation_id: { ty: vecTy(3, 'u32'), stage: 'compute', dir: 'in' },
  workgroup_id: { ty: vecTy(3, 'u32'), stage: 'compute', dir: 'in' },
  num_workgroups: { ty: vecTy(3, 'u32'), stage: 'compute', dir: 'in' },
}
const SHORTHAND: { readonly [name: string]: Ty } = Object.fromEntries([
  ...[2, 3, 4].flatMap((n) => [['i', 'i32'], ['u', 'u32'], ['f', 'f32']].map(([c, s]) => [`vec${n}${c}`, vecTy(n, s as Scalar)])),
  ...[2, 3, 4].flatMap((c) => [2, 3, 4].map((r) => [`mat${c}x${r}f`, matTy(c, r)])),
])

/** Fills the running lanes with one value. */
function fill(m: Mask, v: Val): Lanes {
  const out: Lanes = new Array<Val>(m.length)
  for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = v
  return out
}

/** Applies `f` component by component, a scalar operand standing for every component. */
function zip(vals: readonly Val[], f: (...xs: number[]) => number): Val {
  const arr = vals.find((v) => typeof v !== 'number') as Val[] | undefined
  if (arr === undefined) return f(...(vals as number[]))
  return arr.map((_, i) => zip(vals.map((v) => (typeof v === 'number' ? v : v[i])), f))
}

function checkConstValue(v: Val, t: Ty, pos: Pos): void {
  const s = scalarOf(t)
  const bad = (x: Val): boolean => (typeof x === 'number' ? !Number.isFinite(x) : x.some(bad))
  if ((s === 'f32' || s === 'af') && bad(v)) refuse(pos, 'a const-expression evaluates to NaN or infinity, which WGSL refuses')
}

/** Converts a const value of an abstract type to the concrete type `to`, refusing what WGSL refuses. */
function convertConst(v: Val, from: Ty, to: Ty, pos: Pos): Val {
  if (typeof v !== 'number') {
    const elem = (t: Ty): Ty => (t.k === 'vec' ? SCALARS[t.s] : t.k === 'mat' ? vecTy(t.r, t.s) : t.k === 'array' ? t.e : t)
    return v.map((x) => convertConst(x, elem(from), elem(to), pos))
  }
  const fs = scalarOf(from)
  const ts = scalarOf(to)
  if (fs === ts) return v
  if (ts === 'i32') {
    if (v < I32_MIN || v > I32_MAX || !Number.isInteger(v)) refuse(pos, `${v} is not an i32`)
    return v
  }
  if (ts === 'u32') {
    if (v < 0 || v > U32_MAX || !Number.isInteger(v)) refuse(pos, `${v} is not a u32`)
    return v
  }
  if (ts === 'f32') {
    if (Math.abs(v) > F32_MAX) refuse(pos, `${v} is outside the finite range of f32`)
    return f32(v)
  }
  return v
}

function literal(text: string, pos: Pos): { ty: Ty; v: number } {
  if (text === 'true' || text === 'false') return { ty: SCALARS.bool, v: text === 'true' ? 1 : 0 }
  const isHex = /^0[xX]/.test(text)
  const suffix = /[iuf]$/.test(text) && !(isHex && text.endsWith('f')) ? text[text.length - 1] : ''
  const body = suffix === '' ? text : text.slice(0, -1)
  if (suffix === 'f' || (!isHex && /[.eE]/.test(body))) {
    const v = Number(body)
    if (suffix === 'f') {
      const r = f32(v)
      if (!Number.isFinite(r) || Math.abs(v) > F32_MAX) refuse(pos, `${text} is outside the finite range of f32`)
      return { ty: SCALARS.f32, v: r }
    }
    if (!Number.isFinite(v)) refuse(pos, `${text} is outside the finite range of an abstract float`)
    return { ty: SCALARS.af, v }
  }
  const v = isHex ? parseInt(body.slice(2), 16) : Number(body)
  if (suffix === 'i') {
    if (v > I32_MAX) refuse(pos, `${text} is not an i32 (the most negative i32 is written as a bit cast or an expression)`)
    return { ty: SCALARS.i32, v }
  }
  if (suffix === 'u') {
    if (v > U32_MAX) refuse(pos, `${text} is not a u32`)
    return { ty: SCALARS.u32, v }
  }
  if (!Number.isSafeInteger(v)) refuse(pos, `${text}: abstract integers past 2^53 are outside the subset`)
  return { ty: SCALARS.ai, v }
}

const RELATIONS: { readonly [op: string]: (x: number, y: number) => boolean } = {
  '==': (x, y) => x === y, '!=': (x, y) => x !== y, '<': (x, y) => x < y, '<=': (x, y) => x <= y, '>': (x, y) => x > y, '>=': (x, y) => x >= y,
}

class Compiler {
  readonly ast: ModuleAst
  readonly n: Numbers
  readonly st = new Wave()
  readonly structs = new Map<string, StructTy | null>()
  readonly aliases = new Map<string, Ty | null>()
  readonly decls = new Map<string, Decl>()
  readonly gconsts = new Map<string, Ex | null>()
  readonly gvars = new Map<string, GVar>()
  readonly gvarList: GVar[] = []
  readonly fns = new Map<string, FnInfo>()
  scopes: Map<string, Local>[] = []
  fn: FnInfo | null = null
  slots = 0
  /** Where a break or continue may go: loops and switches, innermost last; true for a loop. */
  flow: ('loop' | 'switch' | 'continuing')[] = []

  constructor(ast: ModuleAst, n: Numbers) {
    this.ast = ast
    this.n = n
  }

  compileAll(): void {
    for (const d of this.ast.decls) {
      if (this.decls.has(d.name)) refuse(d, `${d.name} is declared twice`)
      if (this.reserved(d.name)) refuse(d, `${d.name} shadows a WGSL type or builtin, which the subset does not allow`)
      this.decls.set(d.name, d)
    }
    for (const d of this.ast.decls) {
      if (d.k === 'struct') this.struct(d.name, d)
      else if (d.k === 'alias') this.alias(d.name, d)
      else if (d.k === 'const') this.gconst(d.name, d)
      else if (d.k === 'var') this.gvar(d)
    }
    for (const d of this.ast.decls) if (d.k === 'fn') this.function(d)
    for (const f of this.fns.values()) if (f.stage !== null) this.entry(f)
  }

  reserved(name: string): boolean {
    return name in SCALARS || name in SHORTHAND || TEMPLATED.has(name) || BUILTIN_NAMES.has(name) || name === 'sampler' || name.startsWith('texture_')
  }

  // Types ------------------------------------------------------------------------------------------

  struct(name: string, d: Extract<Decl, { k: 'struct' }>): StructTy {
    const known = this.structs.get(name)
    if (known === null) refuse(d, `struct ${name} contains itself`)
    if (known !== undefined) return known
    this.structs.set(name, null)
    if (d.members.length === 0) refuse(d, `struct ${name} has no members`)
    const members: Member[] = []
    let offset = 0
    let align = 1
    d.members.forEach((m, i) => {
      if (members.some((o) => o.name === m.name)) refuse(m, `member ${m.name} is declared twice`)
      const ty = this.type(m.type)
      if (ty.k === 'array' && ty.n === 0 && i !== d.members.length - 1) refuse(m, 'an array sized by its binding must be the last member')
      if (!this.storable(ty)) refuse(m, `a struct cannot hold a ${typeName(ty)}`)
      let a = alignOf(ty)
      let size = sizeOf(ty)
      for (const at of m.attrs) {
        if (at.name === 'align' || at.name === 'size') {
          const k = this.attrInt(at)
          if (at.name === 'align') {
            if (k < 1 || (k & (k - 1)) !== 0) refuse(at, `@align(${k}) is not a power of two`)
            a = k
          } else {
            if (ty.k === 'array' && ty.n === 0) refuse(at, '@size cannot apply to an array sized by its binding')
            if (k < sizeOf(ty)) refuse(at, `@size(${k}) is smaller than the ${sizeOf(ty)} bytes of ${typeName(ty)}`)
            size = k
          }
        } else if (!['location', 'builtin', 'interpolate', 'invariant'].includes(at.name)) refuse(at, `@${at.name} is outside the subset on a member`)
      }
      offset = roundUp(a, offset)
      members.push({ name: m.name, ty, offset, size, align: a, io: this.io(m.attrs, ty, m) })
      offset += size
      align = Math.max(align, a)
    })
    const s: StructTy = { k: 'struct', name, members, size: roundUp(align, offset), align }
    this.structs.set(name, s)
    return s
  }

  alias(name: string, d: Extract<Decl, { k: 'alias' }>): Ty {
    const known = this.aliases.get(name)
    if (known === null) refuse(d, `alias ${name} refers to itself`)
    if (known !== undefined) return known
    this.aliases.set(name, null)
    const t = this.type(d.type)
    this.aliases.set(name, t)
    return t
  }

  storable(t: Ty): boolean {
    return t.k === 'scalar' || t.k === 'vec' || t.k === 'mat' || t.k === 'array' || t.k === 'struct'
  }

  attrInt(at: Attr, i = 0): number {
    const a = at.args[i]
    if (a === undefined) return refuse(at, `@${at.name} needs an argument`)
    const e = this.expr(a)
    if (e.cv === undefined || typeof e.cv !== 'number' || !isInt(scalarOf(e.ty))) refuse(at, `@${at.name} takes a const integer`)
    return e.cv
  }
  attrIdent(at: Attr, i = 0): string {
    const a = at.args[i]
    if (a === undefined || a.k !== 'ident') return refuse(at, `@${at.name} takes a name`)
    return a.name
  }

  /** The stage attributes of a parameter, member or return value. */
  io(attrs: readonly Attr[], ty: Ty, pos: Pos): Io | null {
    const loc = attrs.find((a) => a.name === 'location')
    const bi = attrs.find((a) => a.name === 'builtin')
    const interp = attrs.find((a) => a.name === 'interpolate')
    const inv = attrs.find((a) => a.name === 'invariant')
    if (loc !== undefined && bi !== undefined) refuse(pos, '@location and @builtin together')
    if (bi !== undefined) {
      const name = this.attrIdent(bi)
      const want = name === 'position' ? vecTy(4, 'f32') : BUILTIN_IO[name]?.ty
      if (want === undefined) refuse(bi, `@builtin(${name}) is outside the subset`)
      if (!same(want, ty)) refuse(bi, `@builtin(${name}) is a ${typeName(want)}, not a ${typeName(ty)}`)
      if (interp !== undefined) refuse(interp, '@interpolate applies to locations only')
      if (inv !== undefined && name !== 'position') refuse(inv, '@invariant applies to the position only')
      return { builtin: name }
    }
    if (loc !== undefined) {
      const location = this.attrInt(loc)
      if (location < 0) refuse(loc, 'a location is not negative')
      const s = scalarOf(ty)
      if (s === null || s === 'bool' || ty.k === 'mat') refuse(loc, `a location cannot carry a ${typeName(ty)}`)
      let flat = false
      if (interp !== undefined) {
        const kind = this.attrIdent(interp)
        if (!['flat', 'perspective', 'linear'].includes(kind)) refuse(interp, `@interpolate(${kind}) is not WGSL`)
        if (interp.args.length > 1) {
          const sampling = this.attrIdent(interp, 1)
          const fits = kind === 'flat' ? ['first', 'either'] : ['center', 'centroid', 'sample']
          if (!fits.includes(sampling)) refuse(interp, `${sampling} is not a sampling for @interpolate(${kind})`)
        }
        flat = kind === 'flat'
      }
      if (inv !== undefined) refuse(inv, '@invariant applies to the position only')
      return { location, flat }
    }
    if (interp !== undefined || inv !== undefined) refuse(pos, '@interpolate and @invariant apply to stage values only')
    return null
  }

  type(t: TypeExpr): Ty {
    const args = t.args ?? []
    const tyArg = (i: number): Ty => {
      const a = args[i]
      if (a === undefined || a.k !== 'type') return refuse(t, `${t.name} needs a type as template argument ${i + 1}`)
      return this.type(a)
    }
    const word = (i: number): string => {
      const a = args[i]
      if (a === undefined || a.k !== 'type' || a.args !== null) return refuse(t, `${t.name} needs a name as template argument ${i + 1}`)
      return a.name
    }
    const count = (n: number): void => {
      if (args.length !== n) refuse(t, `${t.name} takes ${n} template argument${n === 1 ? '' : 's'}`)
    }
    const m = /^(vec([234])|mat([234])x([234]))$/.exec(t.name)
    if (m !== null) {
      count(1)
      const e = tyArg(0)
      if (e.k !== 'scalar' || e.s === 'ai' || e.s === 'af') refuse(t, `${t.name} takes a scalar type`)
      if (m[2] !== undefined) return vecTy(Number(m[2]), e.s)
      if (e.s !== 'f32') refuse(t, `${t.name} holds f32 in the subset`)
      return matTy(Number(m[3]), Number(m[4]))
    }
    if (t.args === null) {
      if (t.name in SCALARS && t.name !== 'ai' && t.name !== 'af') return SCALARS[t.name as Scalar]
      if (t.name in SHORTHAND) return SHORTHAND[t.name]
      if (t.name === 'sampler') return { k: 'sampler' }
      if (t.name === 'texture_depth_2d' || t.name === 'texture_depth_2d_array') return { k: 'tex', dim: t.name === 'texture_depth_2d' ? '2d' : '2d_array', sample: 'depth' }
      const d = this.decls.get(t.name)
      if (d?.k === 'struct') return this.struct(t.name, d)
      if (d?.k === 'alias') return this.alias(t.name, d)
      return refuse(t, `${t.name} is not a type in the subset`)
    }
    switch (t.name) {
      case 'array': {
        if (args.length !== 1 && args.length !== 2) refuse(t, 'array takes an element type and maybe a count')
        const e = tyArg(0)
        if (!this.storable(e) || (e.k === 'array' && e.n === 0)) refuse(t, `an array cannot hold a ${typeName(e)}`)
        if (args.length === 1) return { k: 'array', e, n: 0 }
        const ce = args[1]
        const c = this.expr(ce.k === 'type' ? { k: 'ident', name: ce.name, line: ce.line, col: ce.col } : ce)
        if (c.cv === undefined || typeof c.cv !== 'number' || !isInt(scalarOf(c.ty))) refuse(t, 'an array count is a const integer (override counts are outside the subset)')
        if (c.cv < 1) refuse(t, `an array of ${c.cv} elements`)
        return { k: 'array', e, n: c.cv }
      }
      case 'texture_2d':
      case 'texture_2d_array': {
        count(1)
        const s = tyArg(0)
        if (s.k !== 'scalar' || (s.s !== 'f32' && s.s !== 'i32' && s.s !== 'u32')) refuse(t, `${t.name} samples f32, i32 or u32`)
        return { k: 'tex', dim: t.name === 'texture_2d' ? '2d' : '2d_array', sample: s.s as TexSample }
      }
      case 'texture_storage_2d': {
        count(2)
        const f = STORAGE_FORMATS[word(0)]
        if (f === undefined) refuse(t, `${word(0)} is not a storage format in the subset`)
        if (word(1) !== 'write') refuse(t, `${word(1)} storage textures are outside the subset (write only)`)
        return { k: 'storage-tex', format: f.format, s: f.s }
      }
      default:
        return refuse(t, `${t.name}<...> is outside the subset`)
    }
  }

  // Module scope -------------------------------------------------------------------------------------

  gconst(name: string, d: Extract<Decl, { k: 'const' }>): Ex {
    const known = this.gconsts.get(name)
    if (known === null) refuse(d, `const ${name} refers to itself`)
    if (known !== undefined) return known
    this.gconsts.set(name, null)
    const ex = this.constInit(d.type, d.init, d)
    this.gconsts.set(name, ex)
    return ex
  }

  constInit(type: TypeExpr | null, init: Expr, pos: Pos): Ex {
    let ex = this.expr(init)
    if (ex.cv === undefined) refuse(pos, 'a const takes a const-expression')
    if (type !== null) ex = this.conv(ex, this.type(type))
    return ex
  }

  gvar(d: Extract<Decl, { k: 'var' }>): void {
    const [spaceWord, accessWord] = d.tmpl
    if (d.tmpl.length > 2) refuse(d, 'var<...> takes an address space and an access mode')
    let ty = d.type === null ? null : this.type(d.type)
    const isHandle = ty !== null && (ty.k === 'tex' || ty.k === 'storage-tex' || ty.k === 'sampler')
    const space: Space = isHandle ? 'handle' : (spaceWord as Space | undefined) ?? refuse(d, 'a module variable needs an address space')
    if (isHandle && d.tmpl.length > 0) refuse(d, 'a texture or sampler takes no address space')
    if (!['private', 'workgroup', 'uniform', 'storage', 'handle'].includes(space)) refuse(d, `var<${space}> is outside the subset at module scope`)
    let access: Access = space === 'storage' || space === 'uniform' || space === 'handle' ? 'read' : 'read_write'
    if (accessWord !== undefined) {
      if (space !== 'storage') refuse(d, `only storage takes an access mode, not ${space}`)
      if (accessWord !== 'read' && accessWord !== 'read_write') refuse(d, `${accessWord} is not an access mode in the subset`)
      access = accessWord
    }
    const bound = space === 'uniform' || space === 'storage' || space === 'handle'
    const group = d.attrs.find((a) => a.name === 'group')
    const binding = d.attrs.find((a) => a.name === 'binding')
    if (bound !== (group !== undefined && binding !== undefined) || (!bound && (group !== undefined || binding !== undefined))) {
      refuse(d, bound ? 'a resource needs @group and @binding' : `a ${space} variable takes no @group or @binding`)
    }
    let init: Val | null = null
    if (d.init !== null) {
      if (space !== 'private') refuse(d, `a ${space} variable cannot have an initializer`)
      let ex = this.expr(d.init)
      if (ex.cv === undefined) refuse(d, 'a private variable is initialised by a const-expression')
      ex = this.conv(ex, ty ?? concrete(ex.ty))
      ty = ex.ty
      init = ex.cv as Val
    }
    if (ty === null) return refuse(d, 'a variable needs a type')
    if (space === 'uniform' || space === 'storage') this.layout(ty, space, d)
    if ((space === 'private' || space === 'workgroup') && (!this.storable(ty) || (ty.k === 'array' && ty.n === 0))) refuse(d, `a ${space} variable cannot hold a ${typeName(ty)}`)
    const g: GVar = { name: d.name, index: this.gvarList.length, space, access, ty, group: bound ? this.attrInt(group as Attr) : -1, binding: bound ? this.attrInt(binding as Attr) : -1, init }
    if (bound && this.gvarList.some((o) => o.group === g.group && o.binding === g.binding)) refuse(d, `@group(${g.group}) @binding(${g.binding}) is used twice`)
    this.gvars.set(d.name, g)
    this.gvarList.push(g)
  }

  /** Holds a buffer's store type to WGSL's layout rules for its address space (uniform without the standard-layout extension). */
  layout(t: Ty, space: 'uniform' | 'storage', pos: Pos, top = true): void {
    const required = (u: Ty): number => (space === 'uniform' && (u.k === 'array' || u.k === 'struct') ? roundUp(16, alignOf(u)) : alignOf(u))
    switch (t.k) {
      case 'scalar':
      case 'vec':
        if (t.s === 'bool') refuse(pos, `a ${space} buffer cannot hold bool`)
        return
      case 'mat': return
      case 'array':
        if (t.n === 0 && (space === 'uniform' || !top)) {
          if (space === 'uniform') refuse(pos, 'a uniform buffer cannot hold an array sized by its binding')
        }
        if (strideOf(t) % required(t.e) !== 0) refuse(pos, `the stride ${strideOf(t)} of ${typeName(t)} is not a multiple of ${required(t.e)}`)
        if (space === 'uniform' && strideOf(t) % 16 !== 0) refuse(pos, `a uniform array steps a multiple of 16 bytes, and ${typeName(t)} steps ${strideOf(t)}`)
        this.layout(t.e, space, pos, false)
        return
      case 'struct':
        t.members.forEach((m, i) => {
          const r = required(m.ty)
          if (m.offset % r !== 0) refuse(pos, `member ${m.name} of ${t.name} is at offset ${m.offset}, not a multiple of ${r} as ${space} requires`)
          // WGSL holds @align to RequiredAlignOf in every space but uniform, where only the offset counts.
          if (space === 'storage' && m.align % r !== 0) refuse(pos, `@align(${m.align}) on ${t.name}.${m.name} is not a multiple of ${r} as ${space} requires`)
          if (m.ty.k === 'array' && m.ty.n === 0 && (i !== t.members.length - 1 || !top || space === 'uniform')) refuse(pos, `${t.name}.${m.name} is sized by its binding, which only the last member of a storage buffer may be`)
          if (space === 'uniform' && m.ty.k === 'struct' && i + 1 < t.members.length && t.members[i + 1].offset - m.offset < roundUp(16, m.ty.size)) {
            refuse(pos, `in a uniform buffer the member after ${t.name}.${m.name} starts at least ${roundUp(16, m.ty.size)} bytes after it`)
          }
          if (m.io !== null) refuse(pos, `a buffer's struct carries no stage attributes (${t.name}.${m.name})`)
          this.layout(m.ty, space, pos, false)
        })
        return
      default:
        refuse(pos, `a ${space} buffer cannot hold a ${typeName(t)}`)
    }
  }

  // Functions ----------------------------------------------------------------------------------------

  function(d: Extract<Decl, { k: 'fn' }>): FnInfo {
    const known = this.fns.get(d.name)
    if (known !== undefined) {
      if (known.state === 'checking') refuse(d, `${d.name} calls itself, directly or not: WGSL has no recursion`)
      return known
    }
    const stages = d.attrs.filter((a) => a.name === 'vertex' || a.name === 'fragment' || a.name === 'compute')
    if (stages.length > 1) refuse(d, `${d.name} is given two stages`)
    const stage = stages.length === 1 ? (stages[0].name as 'vertex' | 'fragment' | 'compute') : null
    const wgs = d.attrs.find((a) => a.name === 'workgroup_size')
    if ((stage === 'compute') !== (wgs !== undefined)) refuse(d, stage === 'compute' ? 'a compute entry point needs @workgroup_size' : '@workgroup_size belongs on a compute entry point')
    const params = d.params.map((p) => this.type(p.type))
    params.forEach((t, i) => {
      if (t.k === 'ptr' || t.k === 'void' || t.k === 'tex' || t.k === 'storage-tex' || t.k === 'sampler') refuse(d.params[i], `a ${typeName(t)} parameter is outside the subset`)
      if (d.params.findIndex((p) => p.name === d.params[i].name) !== i) refuse(d.params[i], `parameter ${d.params[i].name} is declared twice`)
    })
    const ret = d.ret === null ? VOID : this.type(d.ret)
    const info: FnInfo = {
      name: d.name, decl: d, stage, params, ret, group: [1, 1, 1], inputs: [], outputs: [], body: (m) => m, slots: 0, paramSlots: [], state: 'checking', uses: new Set(),
    }
    this.fns.set(d.name, info)
    if (wgs !== undefined) {
      const g = [0, 1, 2].map((i) => (wgs.args[i] === undefined ? 1 : this.attrInt(wgs, i)))
      if (wgs.args.length === 0 || wgs.args.length > 3 || g.some((x) => x < 1) || g[0] * g[1] * g[2] > 256) refuse(wgs, '@workgroup_size takes one to three positive counts, at most 256 invocations in all')
      info.group = [g[0], g[1], g[2]]
    }
    // Check the body with this function's own scopes, then put the caller's back.
    const saved = { scopes: this.scopes, fn: this.fn, slots: this.slots, flow: this.flow }
    this.scopes = [new Map()]
    this.fn = info
    this.slots = 0
    this.flow = []
    info.paramSlots = d.params.map((p, i) => {
      const slot = this.slots++
      this.scopes[0].set(p.name, { k: 'param', ty: params[i], slot, cv: undefined, mul: null })
      return slot
    })
    const body = this.block(d.body, false)
    if (ret.k === 'void' ? (body.beh & ~(NEXT | RETURN)) !== 0 : body.beh !== RETURN) {
      refuse(d, ret.k === 'void' ? `${d.name}'s body leaves by break or continue` : `${d.name} can reach its end without returning a ${typeName(ret)}`)
    }
    info.body = body.run
    info.slots = this.slots
    info.state = 'done'
    this.scopes = saved.scopes
    this.fn = saved.fn
    this.slots = saved.slots
    this.flow = saved.flow
    return info
  }

  /** Works out an entry point's stage inputs and outputs, and holds it to its stage's rules. */
  entry(f: FnInfo): void {
    const d = f.decl
    const stage = f.stage as 'compute' | 'vertex' | 'fragment'
    const slots = (ty: Ty, io: Io | null, param: number, dir: 'in' | 'out', pos: Pos): IoSlot[] => {
      if (io !== null) return [{ io, ty, param, member: -1 }]
      if (ty.k !== 'struct') return refuse(pos, `an entry point's ${dir === 'in' ? 'parameter' : 'result'} needs @location or @builtin`)
      return ty.members.map((m, i) => {
        if (m.io === null) return refuse(pos, `member ${m.name} of ${ty.name} needs @location or @builtin`)
        return { io: m.io, ty: m.ty, param, member: i }
      })
    }
    const inputs = d.params.flatMap((p, i) => slots(f.params[i], this.io(p.attrs, f.params[i], p), i, 'in', p))
    const outputs = f.ret.k === 'void' ? [] : slots(f.ret, this.io(d.retAttrs, f.ret, d), -1, 'out', d)
    for (const [list, dir] of [[inputs, 'in'], [outputs, 'out']] as const) {
      const seen = new Set<string>()
      for (const s of list) {
        const key = 'builtin' in s.io ? s.io.builtin : `location ${s.io.location}`
        if (seen.has(key)) refuse(d, `${d.name} has ${key} twice among its ${dir}puts`)
        seen.add(key)
        if ('builtin' in s.io) {
          const name = s.io.builtin
          const okPosition = name === 'position' && ((stage === 'vertex' && dir === 'out') || (stage === 'fragment' && dir === 'in'))
          const b = BUILTIN_IO[name]
          if (!okPosition && (b === undefined || b.stage !== stage || b.dir !== dir)) refuse(d, `@builtin(${name}) is not a ${stage} ${dir}put`)
        } else {
          if (stage === 'compute') refuse(d, 'a compute entry point has no locations')
          const between = (stage === 'vertex' && dir === 'out') || (stage === 'fragment' && dir === 'in')
          const sc = scalarOf(s.ty)
          if (between && (sc === 'i32' || sc === 'u32') && !s.io.flat) refuse(d, `${d.name}: an integer location ${s.io.location} between stages must be @interpolate(flat)`)
        }
      }
    }
    if (stage === 'vertex' && !outputs.some((s) => 'builtin' in s.io && s.io.builtin === 'position')) refuse(d, 'a vertex entry point must output @builtin(position)')
    if (stage !== 'vertex' && d.retAttrs.some((a) => a.name === 'invariant')) refuse(d, '@invariant belongs to a vertex position')
    f.inputs = inputs
    f.outputs = outputs
    for (const u of f.uses) {
      const ok = u === 'discard' || u === 'derivative' ? stage === 'fragment' : stage === 'compute'
      if (!ok) refuse(d, `${d.name} is a ${stage} entry point and uses ${u === 'workgroup' ? 'workgroup memory' : u === 'barrier' ? 'a barrier' : u === 'discard' ? 'discard' : 'derivatives or implicit-level sampling'}`)
    }
  }

  // Scopes -------------------------------------------------------------------------------------------

  declare(name: string, local: Local, pos: Pos): void {
    const top = this.scopes[this.scopes.length - 1]
    if (top.has(name)) refuse(pos, `${name} is declared twice in one scope`)
    if (this.reserved(name)) refuse(pos, `${name} shadows a WGSL type or builtin, which the subset does not allow`)
    top.set(name, local)
  }
  lookup(name: string): Local | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const l = this.scopes[i].get(name)
      if (l !== undefined) return l
    }
    return undefined
  }

  // Statements ---------------------------------------------------------------------------------------

  block(stmts: readonly Stmt[], scope = true): Compiled {
    if (scope) this.scopes.push(new Map())
    const runs: Run[] = []
    let beh = NEXT
    for (const s of stmts) {
      if ((beh & NEXT) === 0) refuse(s, 'unreachable code (the compiler would warn, and the lowering prints none)')
      const c = this.stmt(s)
      runs.push(c.run)
      beh = (beh & ~NEXT) | c.beh
    }
    if (scope) this.scopes.pop()
    const st = this.st
    return {
      beh,
      run: (m) => {
        let live = m
        for (let i = 0; i < runs.length; i++) {
          if (!anyOn(live)) return live
          if (++st.steps > st.budget) throw new RunError(`the run passed its budget of ${st.budget} steps`)
          live = runs[i](live)
        }
        return live
      },
    }
  }

  stmt(s: Stmt): Compiled {
    const st = this.st
    const f = this.fn as FnInfo
    switch (s.k) {
      case 'block': return this.block(s.body)
      case 'let':
      case 'const': {
        if (s.k === 'const') {
          const ex = this.constInit(s.type, s.init, s)
          this.declare(s.name, { k: 'const', ty: ex.ty, slot: -1, cv: ex.cv, mul: null }, s)
          return { beh: NEXT, run: (m) => m }
        }
        let ex = this.expr(s.init)
        ex = this.conv(ex, s.type === null ? concrete(ex.ty) : this.type(s.type))
        if (!this.storable(ex.ty) || (ex.ty.k === 'array' && ex.ty.n === 0)) refuse(s, `let ${s.name} cannot hold a ${typeName(ex.ty)} (pointers and handles are outside the subset)`)
        const slot = this.slots++
        this.declare(s.name, { k: 'let', ty: ex.ty, slot, cv: undefined, mul: ex.mul }, s)
        const ev = ex.ev
        return { beh: NEXT, run: (m) => { st.frame[slot] = ev(m); return m } }
      }
      case 'var': {
        let ex = s.init === null ? null : this.expr(s.init)
        const ty = s.type === null ? (ex === null ? refuse(s, `var ${s.name} needs a type or a value`) : concrete(ex.ty)) : this.type(s.type)
        if (ex !== null) ex = this.conv(ex, ty)
        if (!this.storable(ty) || (ty.k === 'array' && ty.n === 0)) refuse(s, `var ${s.name} cannot hold a ${typeName(ty)}`)
        const slot = this.slots++
        this.declare(s.name, { k: 'var', ty, slot, cv: undefined, mul: null }, s)
        const ev = ex?.ev ?? null
        const zero = zeroOf(ty)
        return {
          beh: NEXT,
          run: (m) => {
            const vals = ev === null ? null : ev(m)
            const hs = (st.frame[slot] as Holder[] | undefined) ?? new Array<Holder>(m.length)
            st.frame[slot] = hs
            for (let l = 0; l < m.length; l++) if (m[l] !== 0) hs[l] = { v: copy(vals === null ? zero : vals[l]) }
            return m
          },
        }
      }
      case 'assign': {
        if (s.lhs === null) {
          const ex = this.expr(s.rhs)
          if (ex.ty.k === 'void') refuse(s, '_ = takes a value')
          const ev = ex.ev
          return { beh: NEXT, run: (m) => { ev(m); return m } }
        }
        const lhs = this.writable(s.lhs)
        let rhs = this.expr(s.rhs)
        if (s.op !== '=') rhs = this.binaryOf(s.op.slice(0, -1), this.loaded(lhs), rhs, s)
        rhs = this.conv(rhs, lhs.ty)
        return { beh: NEXT, run: this.storeRun(lhs, rhs.ev) }
      }
      case 'incr': {
        const lhs = this.writable(s.lhs)
        if (lhs.ty.k !== 'scalar' || (lhs.ty.s !== 'i32' && lhs.ty.s !== 'u32')) refuse(s, `${s.op} takes an i32 or u32, not a ${typeName(lhs.ty)}`)
        const one = this.constEx(lhs.ty, 1, s)
        const rhs = this.binaryOf(s.op === '++' ? '+' : '-', this.loaded(lhs), one, s)
        return { beh: NEXT, run: this.storeRun(lhs, rhs.ev) }
      }
      case 'call': {
        const c = s.call
        if (c.k !== 'call') return refuse(s, 'expected a call')
        const ex = this.call(c, true)
        const ev = ex.ev
        return { beh: NEXT, run: (m) => { ev(m); return m } }
      }
      case 'if': {
        const cond = this.boolCond(s.cond)
        const then = this.block(s.then)
        const other = s.else === null ? null : this.block(s.else)
        const ev = cond.ev
        return {
          beh: then.beh | (other === null ? NEXT : other.beh),
          run: (m) => {
            const c = ev(m)
            const t = maskOf(m, c, true)
            const e = maskOf(m, c, false)
            const out = anyOn(t) ? then.run(t) : t
            const rest = anyOn(e) && other !== null ? other.run(e) : e
            orInto(out, rest)
            return out
          },
        }
      }
      case 'switch': return this.switchStmt(s)
      case 'loop': return this.loop(s.body, s.continuing, s.breakIf, null, s)
      case 'for': {
        this.scopes.push(new Map())
        const init = s.init === null ? null : this.stmt(s.init)
        const loop = this.loop(s.body, s.update === null ? null : [s.update], null, s.cond, s)
        this.scopes.pop()
        if (init === null) return loop
        return { beh: loop.beh, run: (m) => loop.run(init.run(m)) }
      }
      case 'while': return this.loop(s.body, null, null, s.cond, s)
      case 'break': {
        const where = this.flow[this.flow.length - 1]
        if (where === undefined) refuse(s, 'break outside a loop or switch')
        if (where === 'continuing') refuse(s, 'break cannot leave a continuing block (only `break if` ends one)')
        return { beh: BREAK, run: (m) => { orInto(st.brk, m); return new Uint8Array(m.length) } }
      }
      case 'continue': {
        let ok = false
        for (let i = this.flow.length - 1; i >= 0; i--) {
          if (this.flow[i] === 'continuing') refuse(s, 'continue inside a continuing block')
          if (this.flow[i] === 'loop') {
            ok = true
            break
          }
        }
        if (!ok) refuse(s, 'continue outside a loop')
        return { beh: CONTINUE, run: (m) => { orInto(st.cont, m); return new Uint8Array(m.length) } }
      }
      case 'discard': {
        f.uses.add('discard')
        return {
          beh: NEXT,
          run: (m) => {
            for (let l = 0; l < m.length; l++) if (m[l] !== 0) st.helper[l] = st.discarded[l] = 1
            return m
          },
        }
      }
      case 'return': {
        if (this.flow.includes('continuing')) refuse(s, 'return inside a continuing block')
        let ex: Ex | null = null
        if (s.value !== null) {
          if (f.ret.k === 'void') refuse(s, `${f.name} returns nothing`)
          ex = this.conv(this.expr(s.value), f.ret)
        } else if (f.ret.k !== 'void') refuse(s, `${f.name} returns a ${typeName(f.ret)}`)
        const ev = ex?.ev ?? null
        return {
          beh: RETURN,
          run: (m) => {
            const v = ev === null ? null : ev(m)
            for (let l = 0; l < m.length; l++) {
              if (m[l] === 0) continue
              st.ret[l] = 1
              if (v !== null) st.retv[l] = v[l]
            }
            return new Uint8Array(m.length)
          },
        }
      }
    }
  }

  boolCond(e: Expr): Ex {
    const c = this.expr(e)
    if (c.ty.k !== 'scalar' || c.ty.s !== 'bool') refuse(e, `a condition is a bool, not a ${typeName(c.ty)}`)
    return c
  }

  /**
   * A loop, also the for and while forms: `cond` (for, while) is tested at the top of each iteration as WGSL's
   * desugaring `if !cond { break; }` does, and `update` runs as the continuing block.
   */
  loop(body: readonly Stmt[], continuing: readonly Stmt[] | null, breakIf: Expr | null, cond: Expr | null, pos: Pos): Compiled {
    const st = this.st
    this.scopes.push(new Map())
    const test = cond === null ? null : this.boolCond(cond)
    this.flow.push('loop')
    const b = this.block(body, false)
    this.flow.pop()
    let c: Compiled | null = null
    let brkIf: Ex | null = null
    if (continuing !== null) {
      this.flow.push('continuing')
      c = this.block(continuing, false)
      if (breakIf !== null) brkIf = this.boolCond(breakIf)
      this.flow.pop()
    }
    this.scopes.pop()
    // WGSL's behaviour rules for loop {s1 continuing {s2}}, with the for and while test counted in s1.
    const b1 = test === null ? b.beh : BREAK | b.beh
    const b2 = (c === null ? NEXT : c.beh) | (brkIf !== null ? BREAK | NEXT : 0)
    if ((b2 & (CONTINUE | RETURN)) !== 0) refuse(pos, 'a continuing block may not continue or return')
    let beh: number
    if (b1 === RETURN) beh = RETURN
    else if (((b1 | b2) & BREAK) === 0) beh = (b1 | b2) & ~(CONTINUE | NEXT)
    else beh = ((b1 | b2) | NEXT) & ~(BREAK | CONTINUE)
    if (beh === 0) refuse(pos, 'this loop can never end (its behaviour is empty, which WGSL refuses)')
    const testEv = test?.ev ?? null
    const ifEv = brkIf?.ev ?? null
    return {
      beh,
      run: (m) => {
        const outerBrk = st.brk
        const outerCont = st.cont
        const left = new Uint8Array(m.length)
        let active = m
        while (anyOn(active)) {
          if (++st.steps > st.budget) throw new RunError(`the run passed its budget of ${st.budget} steps`)
          if (testEv !== null) {
            const t = testEv(active)
            orInto(left, maskOf(active, t, false))
            active = maskOf(active, t, true)
            if (!anyOn(active)) break
          }
          st.brk = new Uint8Array(m.length)
          st.cont = new Uint8Array(m.length)
          const after = b.run(active)
          orInto(after, st.cont)
          orInto(left, st.brk)
          active = after
          if (c !== null && anyOn(active)) {
            st.brk = new Uint8Array(m.length)
            active = c.run(active)
            if (ifEv !== null && anyOn(active)) {
              const v = ifEv(active)
              orInto(left, maskOf(active, v, true))
              active = maskOf(active, v, false)
            }
          }
        }
        st.brk = outerBrk
        st.cont = outerCont
        return left
      },
    }
  }

  switchStmt(s: Extract<Stmt, { k: 'switch' }>): Compiled {
    const st = this.st
    let sel = this.expr(s.sel)
    const sels = s.clauses.map((c) => c.sels.map((e) => (e === null ? null : this.expr(e))))
    let ty = sel.ty
    for (const list of sels) for (const e of list) if (e !== null) ty = unify(ty, e.ty) ?? refuse(e.pos, `a case of type ${typeName(e.ty)} against a selector of type ${typeName(ty)}`)
    ty = concrete(ty)
    if (ty.k !== 'scalar' || (ty.s !== 'i32' && ty.s !== 'u32')) refuse(s, `a switch selects on i32 or u32, not ${typeName(ty)}`)
    sel = this.conv(sel, ty)
    const values: (number | null)[][] = sels.map((list) => list.map((e) => {
      if (e === null) return null
      const c = this.conv(e, ty)
      if (c.cv === undefined) refuse(e.pos, 'a case selector is a const-expression')
      return c.cv as number
    }))
    const flat = values.flat()
    if (flat.filter((v) => v === null).length !== 1) refuse(s, 'a switch has exactly one default')
    const nums = flat.filter((v): v is number => v !== null)
    if (new Set(nums).size !== nums.length) refuse(s, 'a case value appears twice')
    this.flow.push('switch')
    const bodies = s.clauses.map((c) => this.block(c.body))
    this.flow.pop()
    let beh = bodies.reduce((a, b) => a | b.beh, 0)
    if ((beh & BREAK) !== 0) beh = (beh | NEXT) & ~BREAK
    const def = values.findIndex((list) => list.includes(null))
    const ev = sel.ev
    return {
      beh,
      run: (m) => {
        const v = ev(m)
        const outerBrk = st.brk
        const out = new Uint8Array(m.length)
        bodies.forEach((b, i) => {
          const sub = new Uint8Array(m.length)
          for (let l = 0; l < m.length; l++) {
            if (m[l] === 0) continue
            const k = values.findIndex((list) => list.includes(v[l] as number))
            if ((k < 0 ? def : k) === i) sub[l] = 1
          }
          if (!anyOn(sub)) return
          st.brk = new Uint8Array(m.length)
          orInto(out, b.run(sub))
          orInto(out, st.brk)
        })
        st.brk = outerBrk
        return out
      },
    }
  }

  /** The left side of an assignment: memory a store may change. */
  writable(e: Expr): Ex {
    const lhs = this.expr(e)
    if (lhs.pl === null) refuse(e, 'only a variable, or part of one, can be assigned (a let or a parameter cannot)')
    if (lhs.access !== 'read_write') refuse(e, `a ${lhs.space} ${lhs.space === 'storage' ? 'read ' : ''}variable cannot be written`)
    return lhs
  }

  /**
   * Stores per running lane; a helper lane's stores to storage are dropped, except a demoted lane's under
   * `helper-stores`.
   */
  storeRun(lhs: Ex, ev: (m: Mask) => Lanes): Run {
    const st = this.st
    const pl = lhs.pl as (m: Mask) => Ref[]
    const ty = lhs.ty
    const guarded = lhs.space === 'storage'
    const demoted = this.n.helperStores
    return (m) => {
      const refs = pl(m)
      const vals = ev(m)
      for (let l = 0; l < m.length; l++) {
        if (m[l] === 0 || (guarded && st.helper[l] !== 0 && !(demoted && st.discarded[l] !== 0))) continue
        storeRef(refs[l], ty, vals[l])
      }
      return m
    }
  }

  // Expressions --------------------------------------------------------------------------------------

  constEx(ty: Ty, v: Val, pos: Pos): Ex {
    return { ty, pos, cv: v, ev: (m) => fill(m, v), pl: null, space: null, access: null, pure: true, mul: null, handle: -1 }
  }
  valueEx(ty: Ty, pos: Pos, ev: (m: Mask) => Lanes, pure: boolean, mul: Ex['mul'] = null): Ex {
    return { ty, pos, cv: undefined, ev, pl: null, space: null, access: null, pure, mul, handle: -1 }
  }
  /** An expression as a value: memory loaded, no longer a reference. */
  loaded(e: Ex): Ex {
    return e.pl === null ? e : this.valueEx(e.ty, e.pos, e.ev, false)
  }

  /** Converts an abstract expression to a concrete type; refuses any other mismatch. */
  conv(e: Ex, to: Ty): Ex {
    if (same(e.ty, to)) return e
    if (!converts(e.ty, to) || e.cv === undefined) return refuse(e.pos, `a ${typeName(e.ty)} where a ${typeName(to)} is wanted`)
    const v = convertConst(e.cv, e.ty, to, e.pos)
    checkConstValue(v, to, e.pos)
    return this.constEx(to, v, e.pos)
  }

  expr(e: Expr): Ex {
    const st = this.st
    switch (e.k) {
      case 'lit': {
        const { ty, v } = literal(e.text, e)
        return this.constEx(ty, v, e)
      }
      case 'paren': return this.expr(e.a)
      case 'ident': return this.ident(e)
      case 'unary': return this.unary(e)
      case 'binary': return this.binary(e)
      case 'call': return this.call(e, false)
      case 'member': {
        const a = this.expr(e.a)
        if (a.ty.k === 'struct') {
          const i = a.ty.members.findIndex((m) => m.name === e.name)
          if (i < 0) refuse(e, `${a.ty.name} has no member ${e.name}`)
          const m = a.ty.members[i]
          if (a.cv !== undefined) return this.constEx(m.ty, (a.cv as Val[])[i], e)
          return this.step(a, m.ty, e, () => i, (r) => (r.buf !== null ? { ...r, off: r.off + m.offset } : { ...r, path: [...r.path, i] }), false)
        }
        if (a.ty.k !== 'vec') return refuse(e, `a ${typeName(a.ty)} has no member ${e.name}`)
        const set = SWIZZLE.find((w) => [...e.name].every((ch) => w.includes(ch)))
        const idx = set === undefined ? [] : [...e.name].map((ch) => set.indexOf(ch))
        if (idx.length === 0 || idx.length > 4 || idx.some((i) => i >= (a.ty as { n: number }).n)) refuse(e, `.${e.name} is not a swizzle of a ${typeName(a.ty)}`)
        const s = a.ty.s
        if (idx.length === 1) {
          if (a.cv !== undefined) return this.constEx(SCALARS[s], (a.cv as Val[])[idx[0]], e)
          return this.step(a, SCALARS[s], e, () => idx[0], (r) => (r.buf !== null ? { ...r, off: r.off + 4 * idx[0] } : { ...r, path: [...r.path, idx[0]] }), false)
        }
        const ty = vecTy(idx.length, s)
        if (a.cv !== undefined) return this.constEx(ty, idx.map((i) => (a.cv as Val[])[i]), e)
        const ev = a.ev
        return this.valueEx(ty, e, (m) => {
          const v = ev(m)
          const out: Lanes = new Array<Val>(m.length)
          for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = idx.map((i) => (v[l] as Val[])[i])
          return out
        }, a.pure)
      }
      case 'index': {
        const a = this.expr(e.a)
        let i = this.expr(e.i)
        if (i.ty.k !== 'scalar' || !isInt(i.ty.s)) refuse(e, `an index is an i32 or u32, not a ${typeName(i.ty)}`)
        if (i.ty.s === 'ai') i = this.conv(i, SCALARS.i32)
        const t = a.ty
        const elem = t.k === 'vec' ? SCALARS[t.s] : t.k === 'mat' ? vecTy(t.r, 'f32') : t.k === 'array' ? t.e : refuse(e, `a ${typeName(t)} cannot be indexed`)
        const n = t.k === 'vec' ? t.n : t.k === 'mat' ? t.c : t.k === 'array' ? t.n : 0
        if (i.cv !== undefined) {
          const k = i.cv as number
          if (k < 0 || (n > 0 && k >= n)) refuse(e, `index ${k} is outside the ${typeName(t)}`)
          if (a.cv !== undefined) return this.constEx(elem, (a.cv as Val[])[k], e)
        }
        if (t.k === 'array' && t.n === 0 && a.pl === null) refuse(e, 'an array sized by its binding is indexed only in memory')
        const iev = i.ev
        const stride = t.k === 'array' ? strideOf(t) : t.k === 'mat' ? roundUp(alignOf(elem), sizeOf(elem)) : 4
        let idx: Lanes = []
        const oob = this.n.oob
        return this.step(a, elem, e, (l) => idx[l] as number, (r, l) => {
          let k = idx[l] as number
          let count = n
          if (count === 0) {
            // An array sized by its binding: the elements the binding holds.
            count = r.buf === null ? 0 : Math.max(0, Math.floor((r.buf.byteLength - r.off) / stride))
          }
          const out = r.buf !== null ? { ...r } : { ...r, path: [...r.path] }
          if (k < 0 || k >= count) {
            st.oob++
            if (count === 0) {
              out.flag = DEAD
              return out
            }
            if (oob) {
              out.flag = WILD
              k = 0
            } else k = k < 0 ? 0 : count - 1
          }
          if (out.buf !== null) out.off += k * stride
          else out.path.push(k)
          return out
        }, i.pure, (m) => { idx = iev(m) }, n)
      }
    }
  }

  /**
   * One step into a value or into memory: a member, a component or an element. `pick(l)` is the index for a value;
   * `move(ref, l)` steps a reference; `before(m)` evaluates the index first, if there is one. A value index out of
   * range is clamped in exact mode and poison under `oob`.
   */
  step(a: Ex, ty: Ty, pos: Pos, pick: (l: number) => number, move: (r: Ref, l: number) => Ref, indexPure: boolean, before: ((m: Mask) => void) | null = null, n = 0): Ex {
    const st = this.st
    const oob = this.n.oob
    if (a.pl !== null) {
      const apl = a.pl
      const pl = (m: Mask): Ref[] => {
        const refs = apl(m)
        if (before !== null) before(m)
        const out = new Array<Ref>(m.length)
        for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = refs[l].flag === 0 ? move(refs[l], l) : refs[l]
        return out
      }
      return {
        ty, pos, cv: undefined, pl, space: a.space, access: a.access, pure: false, mul: null, handle: -1,
        ev: (m) => {
          const refs = pl(m)
          const out: Lanes = new Array<Val>(m.length)
          for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = loadRef(refs[l], ty)
          return out
        },
      }
    }
    const aev = a.ev
    return this.valueEx(ty, pos, (m) => {
      const v = aev(m)
      if (before !== null) before(m)
      const out: Lanes = new Array<Val>(m.length)
      for (let l = 0; l < m.length; l++) {
        if (m[l] === 0) continue
        let k = pick(l)
        if (n > 0 && (k < 0 || k >= n)) {
          st.oob++
          if (oob) {
            out[l] = poisonOf(ty)
            continue
          }
          k = k < 0 ? 0 : n - 1
        }
        out[l] = (v[l] as Val[])[k]
      }
      return out
    }, a.pure && indexPure)
  }

  ident(e: Extract<Expr, { k: 'ident' }>): Ex {
    const st = this.st
    const local = this.lookup(e.name)
    if (local !== undefined) {
      const slot = local.slot
      if (local.k === 'const') return this.constEx(local.ty, local.cv as Val, e)
      if (local.k === 'let' || local.k === 'param') return this.valueEx(local.ty, e, () => st.frame[slot] as Lanes, true, local.mul)
      const ty = local.ty
      const pl = (m: Mask): Ref[] => {
        const hs = st.frame[slot] as Holder[]
        const out = new Array<Ref>(m.length)
        for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = { h: hs[l], path: [], buf: null, off: 0, flag: 0 }
        return out
      }
      return this.memEx(ty, e, pl, 'function', 'read_write')
    }
    const d = this.decls.get(e.name)
    if (d?.k === 'const') return { ...this.gconst(e.name, d), pos: e }
    const g = this.gvars.get(e.name)
    if (g === undefined) return refuse(e, d === undefined ? `${e.name} is not declared` : `${e.name} is not a value`)
    const fn = this.fn
    if (g.space === 'handle') return { ty: g.ty, pos: e, cv: undefined, ev: () => refuse(e, `${e.name} is a handle, used only by the texture builtins`), pl: null, space: 'handle', access: 'read', pure: false, mul: null, handle: g.index }
    if (g.space === 'workgroup' && fn !== null) fn.uses.add('workgroup')
    const i = g.index
    let pl: (m: Mask) => Ref[]
    if (g.space === 'private') {
      pl = (m) => {
        const hs = st.priv[i]
        const out = new Array<Ref>(m.length)
        for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = { h: hs[l], path: [], buf: null, off: 0, flag: 0 }
        return out
      }
    } else if (g.space === 'workgroup') {
      pl = (m) => {
        const out = new Array<Ref>(m.length)
        for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = { h: st.wg[i], path: [], buf: null, off: 0, flag: 0 }
        return out
      }
    } else {
      pl = (m) => {
        const buf = st.bufs[i]
        if (buf === null || buf === undefined) throw new RunError(`nothing is bound to ${g.name} (@group(${g.group}) @binding(${g.binding}))`)
        const out = new Array<Ref>(m.length)
        for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = { h: null, path: [], buf, off: 0, flag: 0 }
        return out
      }
    }
    return this.memEx(g.ty, e, pl, g.space, g.access)
  }

  memEx(ty: Ty, pos: Pos, pl: (m: Mask) => Ref[], space: Space, access: Access): Ex {
    return {
      ty, pos, cv: undefined, pl, space, access, pure: false, mul: null, handle: -1,
      ev: (m) => {
        if (ty.k === 'array' && ty.n === 0) throw new RunError('an array sized by its binding cannot be loaded whole')
        const refs = pl(m)
        const out: Lanes = new Array<Val>(m.length)
        for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = loadRef(refs[l], ty)
        return out
      },
    }
  }

  unary(e: Extract<Expr, { k: 'unary' }>): Ex {
    if (e.op === '*') return refuse(e, 'pointer indirection is outside the subset')
    const a = this.expr(e.a)
    if (e.op === '&') {
      if (a.pl === null) refuse(e, '& takes a variable, or part of one')
      return {
        ty: { k: 'ptr', space: a.space as Space, to: a.ty, access: a.access as Access }, pos: e, cv: undefined,
        ev: () => refuse(e, 'a pointer is not a value in the subset'), pl: a.pl, space: a.space, access: a.access, pure: false, mul: null, handle: -1,
      }
    }
    const s = scalarOf(a.ty)
    if (a.ty.k === 'mat' || a.ty.k === 'array' || s === null) refuse(e, `${e.op} does not take a ${typeName(a.ty)}`)
    let f: (x: number, n: Numbers) => number
    if (e.op === '-') {
      if (s === 'bool' || s === 'u32') refuse(e, `- does not take a ${typeName(a.ty)}`)
      f = s === 'f32' ? (x, n) => n.neg(x) : s === 'i32' ? (x) => -x | 0 : (x) => -x
    } else if (e.op === '!') {
      if (s !== 'bool') refuse(e, `! takes a bool, not a ${typeName(a.ty)}`)
      f = (x) => 1 - x
    } else {
      if (!isInt(s)) refuse(e, `~ takes an integer, not a ${typeName(a.ty)}`)
      f = s === 'i32' ? (x) => ~x : s === 'u32' ? (x) => ~x >>> 0 : (x) => -x - 1
    }
    return this.apply([a], a.ty, (vs, n) => zip(vs, (x) => f(x, n)), e, true)
  }

  /**
   * A builtin or operator applied lane by lane: `impl` takes the operand values and the mode's numbers. With every
   * operand const (and `fold`), the result is a const-expression, evaluated now and checked as WGSL checks one.
   */
  apply(args: readonly Ex[], ty: Ty, impl: (vals: Val[], n: Numbers) => Val, pos: Pos, fold: boolean, mul: Ex['mul'] = null): Ex {
    if (fold && args.every((a) => a.cv !== undefined)) {
      const v = impl(args.map((a) => a.cv as Val), EXACT)
      checkConstValue(v, ty, pos)
      return this.constEx(ty, v, pos)
    }
    const evs = args.map((a) => a.ev)
    const n = this.n
    return this.valueEx(ty, pos, (m) => {
      const vs = evs.map((f) => f(m))
      const out: Lanes = new Array<Val>(m.length)
      for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = impl(vs.map((v) => v[l]), n)
      return out
    }, args.every((a) => a.pure), mul)
  }

  binary(e: Extract<Expr, { k: 'binary' }>): Ex {
    return this.binaryOf(e.op, this.expr(e.a), this.expr(e.b), e)
  }

  /** The operands of a component-wise operator, converted to one scalar type; `mix` lets a scalar meet a vector. */
  operands(a: Ex, b: Ex, mix: boolean, op: string, pos: Pos): [Ex, Ex, Ty] {
    const sa = a.ty.k === 'scalar' || a.ty.k === 'vec' ? a.ty.s : null
    const sb = b.ty.k === 'scalar' || b.ty.k === 'vec' ? b.ty.s : null
    if (sa === null || sb === null) return refuse(pos, `${op} does not take a ${typeName(a.ty)} and a ${typeName(b.ty)}`)
    const s = scalarOf(unify(SCALARS[sa], SCALARS[sb]) ?? refuse(pos, `${op} does not take a ${typeName(a.ty)} and a ${typeName(b.ty)}`)) as Scalar
    const wa = widthOf(a.ty)
    const wb = widthOf(b.ty)
    if (wa !== wb && !(mix && (wa === 1 || wb === 1))) refuse(pos, `${op} does not take a ${typeName(a.ty)} and a ${typeName(b.ty)}`)
    return [this.conv(a, vecTy(wa, s)), this.conv(b, vecTy(wb, s)), vecTy(Math.max(wa, wb), s)]
  }

  binaryOf(op: string, a0: Ex, b0: Ex, pos: Pos): Ex {
    if (op === '&&' || op === '||') {
      if (!same(a0.ty, SCALARS.bool) || !same(b0.ty, SCALARS.bool)) refuse(pos, `${op} takes two bools`)
      if (a0.cv !== undefined && b0.cv !== undefined) return this.constEx(SCALARS.bool, op === '&&' ? (a0.cv as number) & (b0.cv as number) : (a0.cv as number) | (b0.cv as number), pos)
      const aev = a0.ev
      const bev = b0.ev
      const and = op === '&&'
      // Short-circuit: the right side runs only for the lanes whose left side leaves the answer open.
      return this.valueEx(SCALARS.bool, pos, (m) => {
        const x = aev(m)
        const rest = maskOf(m, x, and)
        const y = anyOn(rest) ? bev(rest) : []
        const out: Lanes = new Array<Val>(m.length)
        for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = rest[l] !== 0 ? y[l] : x[l]
        return out
      }, a0.pure && b0.pure)
    }
    if (op === '<<' || op === '>>') {
      const sa = scalarOf(a0.ty)
      if ((a0.ty.k !== 'scalar' && a0.ty.k !== 'vec') || !isInt(sa)) refuse(pos, `${op} shifts an integer, not a ${typeName(a0.ty)}`)
      const a = sa === 'ai' && b0.cv === undefined ? this.conv(a0, concrete(a0.ty)) : a0
      const s = scalarOf(a.ty) as Scalar
      const b = this.conv(b0, vecTy(widthOf(a.ty), 'u32'))
      const left = op === '<<'
      if (b.cv !== undefined && s !== 'ai') {
        const counts = typeof b.cv === 'number' ? [b.cv] : (b.cv as number[])
        if (counts.some((k) => k >= 32)) refuse(pos, `a shift by a const count of 32 or more (${counts.join(', ')}), which WGSL refuses`)
        if (a.cv !== undefined && left) {
          zip([a.cv, b.cv], (x, k) => {
            const lost = s === 'i32' ? (x >> (31 - k)) !== 0 && (x >> (31 - k)) !== -1 : k > 0 && (x >>> (32 - k)) !== 0
            if (lost) refuse(pos, `the const shift ${x} << ${k} overflows`)
            return 0
          })
        }
      }
      const f = s === 'i32' ? (left ? (x: number, k: number) => x << (k & 31) : (x: number, k: number) => x >> (k & 31))
        : s === 'u32' ? (left ? (x: number, k: number) => (x << (k & 31)) >>> 0 : (x: number, k: number) => x >>> (k & 31))
          : (x: number, k: number) => (left ? x * 2 ** k : Math.floor(x / 2 ** k))
      return this.apply([a, b], a.ty, (vs) => zip(vs, f), pos, true)
    }
    if (RELATIONAL.has(op)) {
      const [a, b, t] = this.operands(a0, b0, false, op, pos)
      const s = scalarOf(t) as Scalar
      if (s === 'bool' && op !== '==' && op !== '!=') refuse(pos, `${op} does not order bools`)
      const cmp = RELATIONS[op]
      const f = s === 'f32' ? (x: number, y: number, n: Numbers) => n.compare(x, y, cmp) : (x: number, y: number) => (cmp(x, y) ? 1 : 0)
      return this.apply([a, b], vecTy(widthOf(t), 'bool'), (vs, n) => zip(vs, (x, y) => f(x, y, n)), pos, true)
    }
    if (op === '&' || op === '|' || op === '^') {
      const [a, b, t] = this.operands(a0, b0, false, op, pos)
      const s = scalarOf(t) as Scalar
      if (s === 'bool' ? op === '^' : !isInt(s)) refuse(pos, `${op} does not take ${typeName(t)}${op === '^' && s === 'bool' ? ' (use != for a bool exclusive or)' : ''}`)
      const raw = op === '&' ? (x: number, y: number) => x & y : op === '|' ? (x: number, y: number) => x | y : (x: number, y: number) => x ^ y
      const f = s === 'u32' ? (x: number, y: number) => raw(x, y) >>> 0 : raw
      return this.apply([a, b], t, (vs) => zip(vs, f), pos, true)
    }
    // + - * / %
    if (a0.ty.k === 'mat' || b0.ty.k === 'mat') return this.gridArith(op, a0, b0, pos)
    const [a, b, t] = this.operands(a0, b0, true, op, pos)
    const s = scalarOf(t) as Scalar
    if (!isNum(s)) refuse(pos, `${op} does not take ${typeName(t)}`)
    const hasZero = (v: Val): boolean => (typeof v === 'number' ? v === 0 : v.some(hasZero))
    if ((op === '/' || op === '%') && isInt(s) && b.cv !== undefined && hasZero(b.cv)) refuse(pos, `${op} by a const zero, which WGSL refuses`)
    if (a.cv !== undefined && b.cv !== undefined) return this.constEx(t, this.foldArith(op, s, a.cv, b.cv, pos), pos)
    if (s === 'f32' && (op === '+' || op === '-')) {
      // A product feeding this add may be fused into one rounding (across let names too): `contract`.
      const fusable = (x: Ex): boolean => x.mul !== null && this.n.contract
      if (fusable(a) || fusable(b)) {
        const p = fusable(a) ? a : b
        const c = p === a ? b : a
        const pm = p.mul as { a: Ex; b: Ex }
        const negProduct = op === '-' && p === b
        const negOther = op === '-' && p === a
        return this.apply([pm.a, pm.b, c], t, (vs, n) => zip(vs, (x, y, z) => n.muladd(negProduct ? -x : x, y, negOther ? -z : z, true)), pos, false)
      }
    }
    const f = this.arith(op, s)
    const mul = s === 'f32' && op === '*' && a.pure && b.pure ? { a, b } : null
    return this.apply([a, b], t, (vs, n) => zip(vs, (x, y) => f(x, y, n)), pos, false, mul)
  }

  /** The scalar arithmetic of a runtime operator. */
  arith(op: string, s: Scalar): (x: number, y: number, n: Numbers) => number {
    if (s === 'f32') {
      switch (op) {
        case '+': return (x, y, n) => n.add(x, y)
        case '-': return (x, y, n) => n.sub(x, y)
        case '*': return (x, y, n) => n.mul(x, y)
        case '/': return (x, y, n) => n.div(x, y)
        default: return (x, y, n) => {
          // Inherited from x - y * trunc(x / y), as interp.ts computes it.
          const t = n.exact1(n.div(x, y), Math.trunc)
          return n.contract ? n.muladd(-y, t, x, true) : n.sub(x, n.mul(y, t))
        }
      }
    }
    const u = s === 'u32'
    switch (op) {
      case '+': return u ? (x, y) => (x + y) >>> 0 : (x, y) => (x + y) | 0
      case '-': return u ? (x, y) => (x - y) >>> 0 : (x, y) => (x - y) | 0
      case '*': return u ? (x, y) => Math.imul(x, y) >>> 0 : (x, y) => Math.imul(x, y)
      case '/': return u ? (x, y) => (y === 0 ? x : Math.trunc(x / y)) : (x, y) => (y === 0 ? x : x === I32_MIN && y === -1 ? x : Math.trunc(x / y) | 0)
      default: return u ? (x, y) => (y === 0 ? 0 : x % y) : (x, y) => (y === 0 ? 0 : (x % y) | 0)
    }
  }

  /** A const-expression of + - * / %: exact arithmetic, refused where WGSL refuses (overflow, NaN, infinity). */
  foldArith(op: string, s: Scalar, a: Val, b: Val, pos: Pos): Val {
    return zip([a, b], (x, y) => {
      let r: number
      if (isFloat(s)) {
        r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? x / y : x - y * Math.trunc(x / y)
        if (s === 'f32') r = f32(r)
        if (!Number.isFinite(r) || (s === 'f32' && Math.abs(r) > F32_MAX)) refuse(pos, `the const-expression ${x} ${op} ${y} overflows or is not a number`)
        return r
      }
      if (s === 'i32' && op === '%' && x === I32_MIN && y === -1) refuse(pos, 'the const-expression -2147483648 % -1, which WGSL refuses')
      r = op === '+' ? x + y : op === '-' ? x - y : op === '*' ? x * y : op === '/' ? Math.trunc(x / y) : x % y
      if (op === '%') r = r === 0 ? 0 : r
      const lo = s === 'i32' ? I32_MIN : s === 'u32' ? 0 : -(2 ** 53)
      const hi = s === 'i32' ? I32_MAX : s === 'u32' ? U32_MAX : 2 ** 53
      if (r < lo || r > hi) refuse(pos, `the const-expression ${x} ${op} ${y} overflows ${typeName(SCALARS[s])}`)
      return r
    })
  }

  /** + - * with a grid on either side. */
  gridArith(op: string, a0: Ex, b0: Ex, pos: Pos): Ex {
    const fix = (e: Ex): Ex => (isAbstract(e.ty) ? this.conv(e, concrete(e.ty)) : e)
    const a = fix(a0)
    const b = fix(b0)
    const A = a.ty
    const B = b.ty
    const bad = (): never => refuse(pos, `${op} does not take a ${typeName(A)} and a ${typeName(B)}`)
    if (op === '+' || op === '-') {
      if (!same(A, B)) bad()
      return this.apply([a, b], A, (vs, n) => zip(vs, op === '+' ? (x, y) => n.add(x, y) : (x, y) => n.sub(x, y)), pos, true)
    }
    if (op !== '*') return bad()
    if (A.k === 'mat' && same(B, SCALARS.f32)) return this.apply([a, b], A, (vs, n) => zip(vs, (x, y) => n.mul(x, y)), pos, true)
    if (B.k === 'mat' && same(A, SCALARS.f32)) return this.apply([a, b], B, (vs, n) => zip(vs, (x, y) => n.mul(x, y)), pos, true)
    if (A.k === 'mat' && B.k === 'vec' && B.s === 'f32' && B.n === A.c) {
      return this.apply([a, b], vecTy(A.r, 'f32'), ([m, v], n) => Array.from({ length: A.r }, (_, i) => sumProducts(n, Array.from({ length: A.c }, (_, k) => [(m as number[][])[k][i], (v as number[])[k]]))), pos, true)
    }
    if (B.k === 'mat' && A.k === 'vec' && A.s === 'f32' && A.n === B.r) {
      return this.apply([a, b], vecTy(B.c, 'f32'), ([v, m], n) => Array.from({ length: B.c }, (_, j) => sumProducts(n, Array.from({ length: B.r }, (_, k) => [(v as number[])[k], (m as number[][])[j][k]]))), pos, true)
    }
    if (A.k === 'mat' && B.k === 'mat' && B.r === A.c) {
      return this.apply([a, b], matTy(B.c, A.r), ([x, y], n) => Array.from({ length: B.c }, (_, j) => Array.from({ length: A.r }, (_, i) =>
        sumProducts(n, Array.from({ length: A.c }, (_, k) => [(x as number[][])[k][i], (y as number[][])[j][k]])))), pos, true)
    }
    return bad()
  }

  // Calls --------------------------------------------------------------------------------------------

  call(e: Extract<Expr, { k: 'call' }>, statement: boolean): Ex {
    const name = e.name
    const ctor = e.tmpl !== null && name !== 'bitcast' ? this.type({ k: 'type', name, args: e.tmpl, line: e.line, col: e.col })
      : name in SHORTHAND ? SHORTHAND[name] : (name === 'bool' || name === 'i32' || name === 'u32' || name === 'f32') ? SCALARS[name] : null
    const d = this.decls.get(name)
    const inferred = e.tmpl === null && (/^(vec[234]|mat[234]x[234]|array)$/.test(name))
    if (ctor !== null || inferred || d?.k === 'struct' || d?.k === 'alias') {
      if (statement) refuse(e, `the value ${name}(...) makes must be used`)
      const ty = ctor ?? (d?.k === 'struct' ? this.struct(name, d) : d?.k === 'alias' ? this.alias(name, d) : null)
      return this.construct(ty, name, e.args.map((a) => this.expr(a)), e)
    }
    if (name === 'bitcast') {
      if (statement) refuse(e, 'the value of bitcast must be used')
      return this.bitcast(e)
    }
    if (d?.k === 'fn') {
      const info = this.function(d)
      if (info.stage !== null) refuse(e, `${name} is an entry point and cannot be called`)
      if (!statement && info.ret.k === 'void') refuse(e, `${name} returns nothing, so its call is a statement`)
      if (statement && info.ret.k !== 'void' && d.attrs.some((a) => a.name === 'must_use')) refuse(e, `the value ${name} returns must be used`)
      if (e.args.length !== info.params.length) refuse(e, `${name} takes ${info.params.length} arguments, not ${e.args.length}`)
      const args = e.args.map((a, i) => this.conv(this.loaded(this.expr(a)), info.params[i]))
      for (const u of info.uses) this.fn?.uses.add(u)
      return this.valueEx(info.ret, e, this.userCall(info, args), false)
    }
    if (d !== undefined) refuse(e, `${name} is not a function`)
    if (!BUILTIN_NAMES.has(name)) refuse(e, `${name} is not a function in the subset`)
    const ex = this.builtin(name, e.args.map((a) => this.expr(a)), e)
    if (statement && ex.ty.k !== 'void') refuse(e, `the value of ${name} must be used`)
    if (!statement && ex.ty.k === 'void') refuse(e, `${name} returns nothing, so its call is a statement`)
    return ex
  }

  userCall(info: FnInfo, args: readonly Ex[]): (m: Mask) => Lanes {
    const st = this.st
    const evs = args.map((a) => a.ev)
    return (m) => {
      const vals = evs.map((f) => f(m))
      const saved = { frame: st.frame, ret: st.ret, retv: st.retv, brk: st.brk, cont: st.cont }
      st.frame = new Array<unknown>(info.slots)
      info.paramSlots.forEach((slot, i) => { st.frame[slot] = vals[i] })
      st.ret = new Uint8Array(m.length)
      st.retv = new Array<Val>(m.length)
      info.body(m)
      const out = st.retv
      st.frame = saved.frame
      st.ret = saved.ret
      st.retv = saved.retv
      st.brk = saved.brk
      st.cont = saved.cont
      return out
    }
  }

  /** A value constructor or conversion: `T(...)` for a typed T, or the inferred `vec3(...)`, `mat2x2(...)`, `array(...)`. */
  construct(ty0: Ty | null, name: string, args0: readonly Ex[], pos: Pos): Ex {
    const args = args0.map((a) => this.loaded(a))
    let ty = ty0
    if (ty === null) {
      // Inferred: the element type the arguments agree on.
      if (args.length === 0) refuse(pos, `${name}() needs its type written out`)
      let elem: Ty | null = null
      for (const a of args) {
        const t = name === 'array' ? a.ty : a.ty.k === 'vec' || a.ty.k === 'scalar' ? SCALARS[a.ty.s] : a.ty.k === 'mat' ? SCALARS[a.ty.s] : a.ty
        elem = elem === null ? t : unify(elem, t) ?? refuse(a.pos, `${name}(...) of a ${typeName(elem)} and a ${typeName(t)}`)
      }
      const e = elem as Ty
      const m = /^(?:vec([234])|mat([234])x([234]))$/.exec(name)
      if (name === 'array') ty = { k: 'array', e, n: args.length }
      else if (m?.[1] !== undefined) ty = vecTy(Number(m[1]), scalarOf(e) ?? refuse(pos, `${name} of a ${typeName(e)}`))
      else if (m !== null) {
        const s = scalarOf(e)
        ty = matTy(Number(m[2]), Number(m[3]), s === 'af' || s === 'ai' ? 'af' : 'f32')
      }
    }
    const t = ty as Ty
    if (args.length === 0) {
      if (!this.storable(t) || (t.k === 'array' && t.n === 0)) refuse(pos, `${typeName(t)} has no zero value`)
      return this.constEx(t, zeroOf(t), pos)
    }
    switch (t.k) {
      case 'scalar': {
        if (args.length !== 1) refuse(pos, `${typeName(t)}(...) takes one value`)
        return this.convertTo(args[0], t, pos)
      }
      case 'vec': {
        if (args.length === 1 && args[0].ty.k === 'vec') {
          if (args[0].ty.n !== t.n) refuse(pos, `${typeName(t)}(...) of a ${typeName(args[0].ty)}`)
          return this.convertTo(args[0], t, pos)
        }
        const parts = args.map((a) => {
          const w = widthOf(a.ty)
          if (w === 0) refuse(a.pos, `${typeName(t)}(...) of a ${typeName(a.ty)}`)
          return this.conv(a, vecTy(w, t.s))
        })
        const total = parts.reduce((k, a) => k + widthOf(a.ty), 0)
        if (!(total === t.n || (parts.length === 1 && total === 1))) refuse(pos, `${typeName(t)}(...) given ${total} components`)
        if (parts.length === 1) return this.apply(parts, t, ([v]) => new Array<number>(t.n).fill(v as number), pos, true)
        return this.apply(parts, t, (vs) => vs.flatMap((v) => (typeof v === 'number' ? [v] : v)), pos, true)
      }
      case 'mat': {
        const col = vecTy(t.r, t.s)
        if (args.length === 1 && args[0].ty.k === 'mat') {
          if (args[0].ty.c !== t.c || args[0].ty.r !== t.r) refuse(pos, `${typeName(t)}(...) of a ${typeName(args[0].ty)}`)
          return this.conv(args[0], t)
        }
        if (args.length === t.c) {
          const cols = args.map((a) => this.conv(a, col))
          return this.apply(cols, t, (vs) => vs.map(copy), pos, true)
        }
        if (args.length === t.c * t.r) {
          const xs = args.map((a) => this.conv(a, SCALARS[t.s]))
          return this.apply(xs, t, (vs) => Array.from({ length: t.c }, (_, j) => vs.slice(j * t.r, (j + 1) * t.r)), pos, true)
        }
        return refuse(pos, `${typeName(t)}(...) takes ${t.c} columns or ${t.c * t.r} numbers`)
      }
      case 'array': {
        if (t.n === 0) refuse(pos, 'an array sized by its binding has no constructor')
        if (args.length !== t.n) refuse(pos, `${typeName(t)}(...) takes ${t.n} elements`)
        const xs = args.map((a) => this.conv(a, t.e))
        return this.apply(xs, t, (vs) => vs.map(copy), pos, true)
      }
      case 'struct': {
        if (args.length !== t.members.length) refuse(pos, `${t.name}(...) takes ${t.members.length} members`)
        const xs = args.map((a, i) => this.conv(a, t.members[i].ty))
        return this.apply(xs, t, (vs) => vs.map(copy), pos, true)
      }
      default:
        return refuse(pos, `${typeName(t)} has no constructor`)
    }
  }

  /** A scalar or vector value conversion `T(e)`, component by component, with WGSL's conversion rules. */
  convertTo(a: Ex, t: Ty, pos: Pos): Ex {
    if (converts(a.ty, t)) return this.conv(a, t)
    const from = scalarOf(a.ty)
    const to = scalarOf(t) as Scalar
    if (from === null || widthOf(a.ty) !== widthOf(t) || widthOf(t) === 0) return refuse(pos, `no conversion from ${typeName(a.ty)} to ${typeName(t)}`)
    const src = isAbstract(a.ty) ? this.conv(a, concrete(a.ty)) : a
    const s = scalarOf(src.ty) as Scalar
    let f: (x: number, n: Numbers) => number
    if (to === 'bool') f = (x) => (x !== 0 ? 1 : 0)
    else if (s === 'bool') f = (x) => x
    else if (to === 'f32') f = s === 'f32' ? (x) => x : (x, n) => n.toFloat(x)
    else if (s === 'f32') f = (x, n) => n.toInt(x, to as 'i32' | 'u32')
    else f = to === 'i32' ? (x) => x | 0 : (x) => x >>> 0
    return this.apply([src], t, ([v], n) => zip([v], (x) => f(x, n)), pos, true)
  }

  bitcast(e: Extract<Expr, { k: 'call' }>): Ex {
    const tmpl = e.tmpl ?? []
    if (tmpl.length !== 1 || tmpl[0].k !== 'type') refuse(e, 'bitcast takes one type')
    const t = this.type(tmpl[0] as TypeExpr)
    if (e.args.length !== 1) refuse(e, 'bitcast takes one value')
    let a = this.loaded(this.expr(e.args[0]))
    const ts = scalarOf(t)
    if ((t.k !== 'scalar' && t.k !== 'vec') || (ts !== 'f32' && ts !== 'i32' && ts !== 'u32')) refuse(e, `bitcast to ${typeName(t)} is outside the subset`)
    if (widthOf(a.ty) !== widthOf(t)) refuse(e, `bitcast from ${typeName(a.ty)} to ${typeName(t)} changes the component count`)
    const as = scalarOf(a.ty)
    if (as === 'ai') a = this.conv(a, vecTy(widthOf(t), ts === 'u32' ? 'u32' : 'i32'))
    else if (as === 'af') a = this.conv(a, vecTy(widthOf(t), 'f32'))
    const s = scalarOf(a.ty)
    if (s !== 'f32' && s !== 'i32' && s !== 'u32') refuse(e, `bitcast from ${typeName(a.ty)} is outside the subset`)
    const f = (x: number, n: Numbers): number => {
      if (s === ts) return x
      const bits = s === 'f32' ? n.toBits(x) : x >>> 0
      return ts === 'f32' ? n.fromBits(bits) : ts === 'i32' ? bits | 0 : bits
    }
    return this.apply([a], t, ([v], n) => zip([v], (x) => f(x, n)), e, true)
  }

  /** The arguments of a builtin converted to one scalar or vector type whose scalar `ok` takes. */
  common(args: readonly Ex[], ok: (s: Scalar) => boolean, name: string, pos: Pos): { args: Ex[]; ty: Ty } {
    let t: Ty | null = null
    for (const a of args) {
      if (a.ty.k !== 'scalar' && a.ty.k !== 'vec') refuse(a.pos, `${name} does not take a ${typeName(a.ty)}`)
      t = t === null ? a.ty : unify(t, a.ty) ?? refuse(a.pos, `${name} does not take a ${typeName(t)} and a ${typeName(a.ty)} together`)
    }
    let ty = t as Ty
    if (scalarOf(ty) === 'ai' && !ok('i32')) ty = vecTy(widthOf(ty), 'af')
    ty = concrete(ty)
    if (!ok(scalarOf(ty) as Scalar)) refuse(pos, `${name} does not take ${typeName(ty)}`)
    return { args: args.map((a) => this.conv(this.loaded(a), ty)), ty }
  }

  handleArg(a: Ex | undefined, kinds: readonly string[], name: string, pos: Pos): number {
    if (a === undefined || a.handle < 0 || !kinds.includes(a.ty.k)) return refuse(pos, `${name} needs a ${kinds.join(' or ')} variable here`)
    return a.handle
  }

  intArg(a: Ex | undefined, name: string, pos: Pos, width = 1): Ex {
    if (a === undefined) return refuse(pos, `${name} is missing an argument`)
    const t = isAbstract(a.ty) ? concrete(a.ty) : a.ty
    const s = scalarOf(t)
    if ((s !== 'i32' && s !== 'u32') || widthOf(t) !== width) refuse(a.pos, `${name} takes ${width === 1 ? 'an i32 or u32' : `a vec${width} of i32 or u32`} here, not a ${typeName(a.ty)}`)
    return this.conv(this.loaded(a), t)
  }

  /** The four lanes of a quad when they are all running; otherwise a RunError (exact) or null (poison, adversarial). */
  quadLanes(m: Mask, what: string): boolean {
    if (this.st.quad && m.length === 4 && allOn(m)) return true
    if (this.n.derivatives || this.n.oob) return false
    throw new RunError(`${what} was reached with only some lanes of the quad running (WGSL leaves the result indeterminate)`)
  }

  builtin(name: string, raw: readonly Ex[], pos: Pos): Ex {
    const fn = this.fn as FnInfo
    const count = (lo: number, hi = lo): void => {
      if (raw.length < lo || raw.length > hi) refuse(pos, `${name} takes ${lo === hi ? lo : `${lo} to ${hi}`} arguments, not ${raw.length}`)
    }
    const float1 = FLOAT1[name]
    if (float1 !== undefined) {
      count(1)
      const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
      return this.apply(args, ty, ([v], n) => zip([v], (x) => float1(x, n)), pos, true)
    }
    const int1 = INT1[name]
    if (int1 !== undefined) {
      count(1)
      const { args, ty } = this.common(raw, (s) => s === 'i32' || s === 'u32', name, pos)
      const signed = scalarOf(ty) === 'i32'
      return this.apply(args, ty, ([v]) => zip([v], (x) => (signed ? int1(x, true) | 0 : int1(x, false) >>> 0)), pos, true)
    }
    switch (name) {
      case 'abs':
      case 'sign': {
        count(1)
        const { args, ty } = this.common(raw, name === 'abs' ? isNum : (s) => s === 'f32' || s === 'i32', name, pos)
        const s = scalarOf(ty)
        const f = name === 'sign' ? (s === 'f32' ? (x: number, n: Numbers) => n.sign(x) : (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0))
          : s === 'f32' ? (x: number, n: Numbers) => n.exact1(x, Math.abs) : s === 'i32' ? (x: number) => (x < 0 ? -x | 0 : x) : (x: number) => x
        return this.apply(args, ty, ([v], n) => zip([v], (x) => f(x, n)), pos, true)
      }
      case 'atan2':
      case 'pow':
      case 'step': {
        count(2)
        const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
        const f = name === 'atan2' ? (y: number, x: number, n: Numbers) => n.atan2(y, x) : name === 'pow' ? (x: number, y: number, n: Numbers) => n.pow(x, y)
          : (e: number, x: number, n: Numbers) => n.compare(e, x, (p, q) => p <= q)
        return this.apply(args, ty, (vs, n) => zip(vs, (x, y) => f(x, y, n)), pos, true)
      }
      case 'min':
      case 'max': {
        count(2)
        const { args, ty } = this.common(raw, isNum, name, pos)
        const fl = scalarOf(ty) === 'f32'
        const min = name === 'min'
        return this.apply(args, ty, (vs, n) => zip(vs, (x, y) => (fl ? (min ? n.min(x, y) : n.max(x, y)) : min ? Math.min(x, y) : Math.max(x, y))), pos, true)
      }
      case 'clamp': {
        count(3)
        const { args, ty } = this.common(raw, isNum, name, pos)
        if (args[1].cv !== undefined && args[2].cv !== undefined) zip([args[1].cv, args[2].cv], (lo, hi) => (lo > hi ? refuse(pos, `clamp with const low ${lo} above high ${hi}, which WGSL refuses`) : 0))
        const fl = scalarOf(ty) === 'f32'
        return this.apply(args, ty, (vs, n) => zip(vs, (x, lo, hi) => (fl ? n.clamp(x, lo, hi) : Math.min(Math.max(x, lo), hi))), pos, true)
      }
      case 'fma': {
        count(3)
        const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
        return this.apply(args, ty, (vs, n) => zip(vs, (a, b, c) => n.fma(a, b, c)), pos, true)
      }
      case 'mix': {
        count(3)
        const xy = this.common(raw.slice(0, 2), (s) => s === 'f32', name, pos)
        const t = this.common([raw[2]], (s) => s === 'f32', name, pos).args[0]
        if (widthOf(t.ty) !== 1 && !same(t.ty, xy.ty)) refuse(pos, `mix's third argument is a ${typeName(xy.ty)} or an f32`)
        return this.apply([...xy.args, t], xy.ty, (vs, n) => zip(vs, (x, y, a) => {
          const keep = n.mul(x, n.sub(1, a))
          return n.contract ? n.muladd(y, a, keep, true) : n.add(keep, n.mul(y, a))
        }), pos, true)
      }
      case 'smoothstep': {
        count(3)
        const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
        return this.apply(args, ty, (vs, n) => zip(vs, (lo, hi, x) => {
          const t = n.clamp(n.div(n.sub(x, lo), n.sub(hi, lo)), 0, 1)
          return n.mul(n.mul(t, t), n.sub(3, n.mul(2, t)))
        }), pos, true)
      }
      case 'select': {
        count(3)
        const { args, ty } = this.common(raw.slice(0, 2), () => true, name, pos)
        const c = this.loaded(raw[2])
        if (!(same(c.ty, SCALARS.bool) || (c.ty.k === 'vec' && c.ty.s === 'bool' && c.ty.n === widthOf(ty)))) refuse(pos, `select's condition is a bool or a vec${widthOf(ty)}<bool>, not a ${typeName(c.ty)}`)
        return this.apply([...args, c], ty, ([f, t, k]) => (typeof k === 'number' ? (k !== 0 ? t : f) : (f as number[]).map((x, i) => ((k as number[])[i] !== 0 ? (t as number[])[i] : x))), pos, true)
      }
      case 'any':
      case 'all': {
        count(1)
        const a = this.loaded(raw[0])
        if (scalarOf(a.ty) !== 'bool' || a.ty.k === 'mat') refuse(pos, `${name} takes bools, not a ${typeName(a.ty)}`)
        const every = name === 'all'
        return this.apply([a], SCALARS.bool, ([v]) => (typeof v === 'number' ? v : (v as number[]).reduce((r, x) => (every ? r & x : r | x), every ? 1 : 0)), pos, true)
      }
      case 'dot': {
        count(2)
        const { args, ty } = this.common(raw, isNum, name, pos)
        if (ty.k !== 'vec') refuse(pos, 'dot takes vectors')
        const s = scalarOf(ty) as Scalar
        const res = SCALARS[s]
        return this.apply(args, res, ([a, b], n) => {
          const xs = a as number[]
          const ys = b as number[]
          if (s === 'f32') return sumProducts(n, xs.map((x, i) => [x, ys[i]] as const))
          let acc = 0
          for (let i = 0; i < xs.length; i++) acc = s === 'u32' ? (acc + Math.imul(xs[i], ys[i])) >>> 0 : (acc + Math.imul(xs[i], ys[i])) | 0
          return acc
        }, pos, true)
      }
      case 'cross': {
        count(2)
        const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
        if (!same(ty, vecTy(3, 'f32'))) refuse(pos, 'cross takes two vec3<f32>')
        return this.apply(args, ty, ([a, b], n) => {
          const x = a as number[]
          const y = b as number[]
          const term = (i: number, j: number): number => (n.contract ? n.muladd(x[i], y[j], -n.mul(x[j], y[i]), true) : n.sub(n.mul(x[i], y[j]), n.mul(x[j], y[i])))
          return [term(1, 2), term(2, 0), term(0, 1)]
        }, pos, true)
      }
      case 'length':
      case 'normalize':
      case 'distance': {
        count(name === 'distance' ? 2 : 1)
        const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
        if (name === 'normalize' && ty.k !== 'vec') refuse(pos, 'normalize takes a vector')
        return this.apply(args, name === 'normalize' ? ty : SCALARS.f32, (vs, n) => geometric(name, vs, n), pos, true)
      }
      case 'reflect': {
        count(2)
        const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
        if (ty.k !== 'vec') refuse(pos, 'reflect takes vectors')
        return this.apply(args, ty, ([a, b], n) => {
          const x = a as number[]
          const y = b as number[]
          const k = n.mul(2, sumProducts(n, x.map((v, i) => [v, y[i]] as const)))
          return x.map((v, i) => (n.contract ? n.muladd(-k, y[i], v, true) : n.sub(v, n.mul(k, y[i]))))
        }, pos, true)
      }
      case 'determinant':
      case 'transpose': {
        count(1)
        let a = this.loaded(raw[0])
        if (a.ty.k !== 'mat') refuse(pos, `${name} takes a grid (mat), not a ${typeName(a.ty)}`)
        if (isAbstract(a.ty)) a = this.conv(a, concrete(a.ty))
        const t = a.ty as Extract<Ty, { k: 'mat' }>
        if (name === 'transpose') return this.apply([a], matTy(t.r, t.c), ([v]) => Array.from({ length: t.r }, (_, j) => Array.from({ length: t.c }, (_, i) => (v as number[][])[i][j])), pos, true)
        if (t.c !== t.r) refuse(pos, 'determinant takes a square grid')
        return this.apply([a], SCALARS.f32, ([v], n) => (n.library ? POISON_F32 : determinant(v as number[][], n)), pos, true)
      }
      case 'extractBits':
      case 'insertBits': {
        const extract = name === 'extractBits'
        count(extract ? 3 : 4)
        const { args, ty } = this.common(raw.slice(0, extract ? 1 : 2), (s) => s === 'i32' || s === 'u32', name, pos)
        const off = this.conv(this.loaded(raw[extract ? 1 : 2]), SCALARS.u32)
        const cnt = this.conv(this.loaded(raw[extract ? 2 : 3]), SCALARS.u32)
        if (off.cv !== undefined && cnt.cv !== undefined && (off.cv as number) + (cnt.cv as number) > 32) refuse(pos, `${name} with const offset and count past 32 bits, which WGSL refuses`)
        const signed = scalarOf(ty) === 'i32'
        return this.apply([...args, off, cnt], ty, (vs) => {
          const o = Math.min(vs[vs.length - 2] as number, 32)
          const c = Math.min(vs[vs.length - 1] as number, 32 - o)
          const mask = c === 32 ? 0xffffffff : ((1 << c) - 1) >>> 0
          const fix = (x: number): number => (signed ? x | 0 : x >>> 0)
          if (extract) {
            return zip([vs[0]], (x) => {
              if (c === 0) return 0
              const bits = ((x >>> o) & mask) >>> 0
              return fix(signed && c < 32 ? (bits << (32 - c)) >> (32 - c) : bits)
            })
          }
          return zip([vs[0], vs[1]], (x, y) => (c === 0 ? x : fix(((x & ~(mask << o)) | ((y << o) & (mask << o))) >>> 0)))
        }, pos, true)
      }
      case 'arrayLength': {
        count(1)
        const p = raw[0]
        if (p.ty.k !== 'ptr' || p.ty.space !== 'storage' || p.ty.to.k !== 'array' || p.ty.to.n !== 0 || p.pl === null) return refuse(pos, 'arrayLength takes &, a pointer to a storage array sized by its binding')
        const stride = strideOf(p.ty.to)
        const pl = p.pl
        return this.valueEx(SCALARS.u32, pos, (m) => {
          const refs = pl(m)
          const out: Lanes = new Array<Val>(m.length)
          for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = Math.max(0, Math.floor(((refs[l].buf as DataView).byteLength - refs[l].off) / stride))
          return out
        }, false)
      }
      case 'workgroupBarrier':
      case 'storageBarrier': {
        count(0)
        fn.uses.add('barrier')
        return this.valueEx(VOID, pos, (m) => {
          if (!allOn(m)) throw new RunError(`${name} reached with only some invocations of the workgroup running (WGSL refuses a barrier in non-uniform control flow)`)
          return []
        }, false)
      }
      case 'textureDimensions': return this.textureDimensions(raw, pos)
      case 'textureNumLevels':
      case 'textureNumLayers': {
        count(1)
        const h = this.handleArg(raw[0], ['tex'], name, pos)
        const t = raw[0].ty as Extract<Ty, { k: 'tex' }>
        if (name === 'textureNumLayers' && t.dim !== '2d_array') refuse(pos, 'textureNumLayers takes an arrayed texture')
        const layers = name === 'textureNumLayers'
        return this.valueEx(SCALARS.u32, pos, (m) => {
          const img = this.image(h)
          return fill(m, layers ? img.view.layers.count : img.view.levels.count)
        }, false)
      }
      case 'textureLoad': return this.textureLoad(raw, pos)
      case 'textureStore': return this.textureStore(raw, pos)
      case 'textureSample': return this.textureSample('implicit', raw, pos)
      case 'textureSampleLevel': return this.textureSample('level', raw, pos)
      case 'textureSampleGrad': return this.textureSample('grad', raw, pos)
      default: {
        const deriv = /^(dpdx|dpdy|fwidth)(Fine|Coarse)?$/.exec(name)
        if (deriv === null) return refuse(pos, `${name} is not a function in the subset`)
        count(1)
        fn.uses.add('derivative')
        const { args, ty } = this.common(raw, (s) => s === 'f32', name, pos)
        const axis = deriv[1]
        const fine = deriv[2] !== 'Coarse'
        const xev = args[0].ev
        return this.valueEx(ty, pos, (m) => {
          const ok = this.quadLanes(m, name)
          const out: Lanes = new Array<Val>(m.length)
          if (!ok) {
            for (let l = 0; l < m.length; l++) if (m[l] !== 0) out[l] = poisonOf(ty)
            return out
          }
          const v = xev(m)
          const useFine = this.n.derivatives ? !fine : fine
          for (let l = 0; l < 4; l++) out[l] = quadDerivative(v, l, axis, useFine)
          return out
        }, false)
      }
    }
  }

  image(h: number): ImageBinding {
    const img = this.st.images[h]
    if (img === null || img === undefined) throw new RunError(`nothing is bound to ${this.gvarList[h].name}`)
    return img
  }

  textureDimensions(raw: readonly Ex[], pos: Pos): Ex {
    const st = this.st
    if (raw.length < 1 || raw.length > 2) refuse(pos, 'textureDimensions takes a texture and maybe a level')
    const h = this.handleArg(raw[0], ['tex', 'storage-tex'], 'textureDimensions', pos)
    const storage = raw[0].ty.k === 'storage-tex'
    if (storage && raw.length === 2) refuse(pos, 'a storage texture has one level: textureDimensions takes no level for it')
    const level = raw.length === 2 ? this.intArg(raw[1], 'textureDimensions', pos) : null
    const lev = level?.ev ?? null
    const ty = vecTy(2, 'u32')
    const oob = this.n.oob
    return this.valueEx(ty, pos, (m) => {
      const img = this.image(h)
      const lv = lev === null ? null : lev(m)
      const out: Lanes = new Array<Val>(m.length)
      for (let l = 0; l < m.length; l++) {
        if (m[l] === 0) continue
        let q = lv === null ? 0 : (lv[l] as number)
        const last = img.view.levels.count - 1
        if (q < 0 || q > last) {
          st.oob++
          if (oob) {
            out[l] = poisonOf(ty)
            continue
          }
          q = q < 0 ? 0 : last
        }
        const at = img.view.levels.base + q
        out[l] = [img.store.levelWidth(at), img.store.levelHeight(at)]
      }
      return out
    }, false)
  }

  textureLoad(raw: readonly Ex[], pos: Pos): Ex {
    const st = this.st
    const h = this.handleArg(raw[0], ['tex'], 'textureLoad', pos)
    const t = raw[0].ty as Extract<Ty, { k: 'tex' }>
    const arrayed = t.dim === '2d_array'
    if (raw.length !== (arrayed ? 4 : 3)) refuse(pos, `textureLoad of a ${typeName(t)} takes ${arrayed ? 'coordinates, a layer and a level' : 'coordinates and a level'}`)
    const at = this.intArg(raw[1], 'textureLoad', pos, 2).ev
    const layer = arrayed ? this.intArg(raw[2], 'textureLoad', pos).ev : null
    const level = this.intArg(raw[arrayed ? 3 : 2], 'textureLoad', pos).ev
    const ty = t.sample === 'depth' ? SCALARS.f32 : vecTy(4, t.sample)
    const coerce = t.sample === 'i32' ? (x: number) => x | 0 : t.sample === 'u32' ? (x: number) => x >>> 0 : f32
    const oob = this.n.oob
    return this.valueEx(ty, pos, (m) => {
      const img = this.image(h)
      const xy = at(m)
      const ly = layer === null ? null : layer(m)
      const lv = level(m)
      const rgba = [0, 0, 0, 0]
      const out: Lanes = new Array<Val>(m.length)
      for (let l = 0; l < m.length; l++) {
        if (m[l] === 0) continue
        const [x, y] = xy[l] as number[]
        const k = ly === null ? 0 : (ly[l] as number)
        const q = lv[l] as number
        const inside = q >= 0 && q < img.view.levels.count && k >= 0 && k < img.view.layers.count
          && x >= 0 && y >= 0 && x < img.store.levelWidth(img.view.levels.base + q) && y < img.store.levelHeight(img.view.levels.base + q)
        if (!inside) {
          st.oob++
          if (oob) {
            out[l] = poisonOf(ty)
            continue
          }
        }
        load(img.store, img.view, x, y, k, q, rgba)
        out[l] = t.sample === 'depth' ? f32(rgba[0]) : rgba.map(coerce)
      }
      return out
    }, false)
  }

  textureStore(raw: readonly Ex[], pos: Pos): Ex {
    const st = this.st
    if (raw.length !== 3) refuse(pos, 'textureStore takes a storage texture, coordinates and a value (arrayed storage textures are outside the subset)')
    const h = this.handleArg(raw[0], ['storage-tex'], 'textureStore', pos)
    const t = raw[0].ty as Extract<Ty, { k: 'storage-tex' }>
    const at = this.intArg(raw[1], 'textureStore', pos, 2).ev
    const value = this.conv(this.loaded(raw[2]), vecTy(4, t.s)).ev
    const oob = this.n.oob
    const demoted = this.n.helperStores
    return this.valueEx(VOID, pos, (m) => {
      const img = this.image(h)
      const xy = at(m)
      const vs = value(m)
      const base = img.view.levels.base
      for (let l = 0; l < m.length; l++) {
        if (m[l] === 0 || (st.helper[l] !== 0 && !(demoted && st.discarded[l] !== 0))) continue
        const [x, y] = xy[l] as number[]
        if (x >= 0 && y >= 0 && x < img.store.levelWidth(base) && y < img.store.levelHeight(base)) put(img.store, img.view, x, y, 0, vs[l] as number[])
        else {
          st.oob++
          if (oob) put(img.store, img.view, 0, 0, 0, poisonOf(vecTy(4, t.s)) as number[])
        }
      }
      return []
    }, false)
  }

  /**
   * textureSample (the level from the quad's fine differences of the coordinate), textureSampleLevel (the level given)
   * and textureSampleGrad (the level from the rates given, as the GPU's own level arithmetic takes them): each through
   * texture.ts's sample. Under sample-nan a NaN coordinate or level, or a rate that is not finite, gives poison.
   */
  textureSample(how: 'implicit' | 'level' | 'grad', raw: readonly Ex[], pos: Pos): Ex {
    const name = how === 'level' ? 'textureSampleLevel' : how === 'grad' ? 'textureSampleGrad' : 'textureSample'
    const h = this.handleArg(raw[0], ['tex'], name, pos)
    const t = raw[0].ty as Extract<Ty, { k: 'tex' }>
    if (t.sample !== 'f32') refuse(pos, `${name} reads a texture_2d<f32> or texture_2d_array<f32> in the subset, not a ${typeName(t)}`)
    const s = this.handleArg(raw[1], ['sampler'], name, pos)
    const arrayed = t.dim === '2d_array'
    const after = 3 + (arrayed ? 1 : 0)
    if (raw.length !== after + (how === 'level' ? 1 : how === 'grad' ? 2 : 0)) refuse(pos, `${name} of a ${typeName(t)} takes the wrong number of arguments`)
    const uv = this.conv(this.loaded(raw[2]), vecTy(2, 'f32')).ev
    const layer = arrayed ? this.intArg(raw[3], name, pos).ev : null
    const level = how === 'level' ? this.conv(this.loaded(raw[after]), SCALARS.f32).ev : null
    const gx = how === 'grad' ? this.conv(this.loaded(raw[after]), vecTy(2, 'f32')).ev : null
    const gy = how === 'grad' ? this.conv(this.loaded(raw[after + 1]), vecTy(2, 'f32')).ev : null
    if (how === 'implicit') (this.fn as FnInfo).uses.add('derivative')
    const ty = vecTy(4, 'f32')
    return this.valueEx(ty, pos, (m) => {
      const img = this.image(h)
      const smp = this.st.samplers[s]
      if (smp === null || smp === undefined) throw new RunError(`nothing is bound to ${this.gvarList[s].name}`)
      const c = uv(m)
      const ly = layer === null ? null : layer(m)
      const out: Lanes = new Array<Val>(m.length)
      const w = img.store.levelWidth(img.view.levels.base)
      const hgt = img.store.levelHeight(img.view.levels.base)
      let lods: number[] | null = null
      let rates: Lanes | null = null
      if (level !== null) lods = (level(m) as number[]).slice()
      else if (gx !== null && gy !== null) {
        const ax = gx(m)
        const ay = gy(m)
        rates = ax.map((r, l) => (m[l] === 0 ? r : [...(r as number[]), ...(ay[l] as number[])]))
        lods = rates.map((r, l) => (m[l] === 0 ? 0 : lodFromRates(...(r as [number, number, number, number]), w, hgt)))
      } else if (this.quadLanes(m, name)) {
        const fine = !this.n.derivatives
        const us = c.map((v) => (v as number[])[0])
        const vs = c.map((v) => (v as number[])[1])
        lods = [0, 1, 2, 3].map((l) => lodFromRates(quadDerivative(us, l, 'dpdx', fine) as number, quadDerivative(vs, l, 'dpdx', fine) as number,
          quadDerivative(us, l, 'dpdy', fine) as number, quadDerivative(vs, l, 'dpdy', fine) as number, w, hgt))
      }
      for (let l = 0; l < m.length; l++) {
        if (m[l] === 0) continue
        const [u, v] = c[l] as number[]
        const wild = rates !== null && (rates[l] as number[]).some((x) => !Number.isFinite(x))
        if (lods === null || (this.n.sampleNan && (Number.isNaN(u) || Number.isNaN(v) || Number.isNaN(lods[l]) || wild))) {
          out[l] = poisonOf(ty)
          continue
        }
        const rgba = [0, 0, 0, 0]
        sample(img.store, img.view, smp, u, v, ly === null ? 0 : (ly[l] as number), lods[l], rgba)
        out[l] = rgba
      }
      return out
    }, false)
  }
}

/**
 * A sum of products of f32 values, as dot and the grid products compute it: each product and each sum rounded, left to
 * right (interp.ts), or under `reassociate` right to left with each step fused.
 */
function sumProducts(n: Numbers, pairs: readonly (readonly [number, number])[]): number {
  if (!n.reassociate) {
    let acc = n.mul(pairs[0][0], pairs[0][1])
    for (let k = 1; k < pairs.length; k++) acc = n.add(acc, n.mul(pairs[k][0], pairs[k][1]))
    return acc
  }
  const last = pairs.length - 1
  let acc = n.mul(pairs[last][0], pairs[last][1])
  for (let k = last - 1; k >= 0; k--) acc = n.muladd(pairs[k][0], pairs[k][1], acc, true)
  return acc
}

/** The geometric functions: interp.ts's double-precision forms, or WGSL's inherited forms under `library`. */
function geometric(name: string, vs: readonly Val[], n: Numbers): Val {
  const comps = (v: Val): number[] => (typeof v === 'number' ? [v] : (v as number[]))
  const a = comps(vs[0])
  const b = name === 'distance' ? comps(vs[1]) : null
  if (n.bad(...a, ...(b ?? []))) return name === 'normalize' ? a.map(() => POISON_F32) : POISON_F32
  if (n.library) {
    const d = b === null ? a : a.map((x, i) => n.sub(x, b[i]))
    const len = n.sqrt(sumProducts(n, d.map((x) => [x, x] as const)))
    return name === 'normalize' ? d.map((x) => n.div(x, len)) : len
  }
  const d = b === null ? a : a.map((x, i) => f32(x - b[i]))
  const root = Math.sqrt(d.reduce((s, x) => s + x * x, 0))
  return name === 'normalize' ? d.map((x) => n.out(f32(x / root))) : n.out(f32(root))
}

/** A square grid's determinant by expansion along its first column, every product and sum rounded. */
function determinant(m: readonly (readonly number[])[], n: Numbers): number {
  if (m.length === 1) return m[0][0]
  let acc = 0
  for (let i = 0; i < m.length; i++) {
    const minor = m.slice(1).map((col) => col.filter((_, r) => r !== i))
    const term = n.mul(m[0][i], determinant(minor, n))
    acc = i === 0 ? term : i % 2 === 0 ? n.add(acc, term) : n.sub(acc, term)
  }
  return acc
}

/**
 * A derivative for lane l of a quad from the four lanes' values: fine along x within the row (lane 1 minus lane 0, or
 * 3 minus 2) and along y within the column (lane 2 minus lane 0, or 3 minus 1); coarse uses lanes 0, 1 and 2 for all
 * four. fwidth is |dx| + |dy|. Every difference rounds to f32, as interp.ts's do.
 */
function quadDerivative(v: Lanes, l: number, axis: string, fine: boolean): Val {
  const at = (k: number, c: number): number => (c < 0 ? (v[k] as number) : (v[k] as number[])[c])
  const one = (c: number): number => {
    const dx = fine ? f32(at((l & 2) + 1, c) - at(l & 2, c)) : f32(at(1, c) - at(0, c))
    const dy = fine ? f32(at((l & 1) + 2, c) - at(l & 1, c)) : f32(at(2, c) - at(0, c))
    return axis === 'dpdx' ? dx : axis === 'dpdy' ? dy : f32(Math.abs(dx) + Math.abs(dy))
  }
  return typeof v[l] === 'number' ? one(-1) : (v[l] as number[]).map((_, c) => one(c))
}

const FLOAT1: { readonly [name: string]: (x: number, n: Numbers) => number } = {
  acos: (x, n) => n.arc(x, 'acos'), asin: (x, n) => n.arc(x, 'asin'), atan: (x, n) => n.arc(x, 'atan'),
  ceil: (x, n) => n.exact1(x, Math.ceil), floor: (x, n) => n.exact1(x, Math.floor), trunc: (x, n) => n.exact1(x, Math.trunc), round: (x, n) => n.exact1(x, roundEven),
  cos: (x, n) => n.trig(x, 'cos'), sin: (x, n) => n.trig(x, 'sin'), tan: (x, n) => n.trig(x, 'tan'),
  cosh: (x, n) => n.hyper(x, 'cosh'), sinh: (x, n) => n.hyper(x, 'sinh'), tanh: (x, n) => n.hyper(x, 'tanh'),
  exp: (x, n) => n.exp(x, false), exp2: (x, n) => n.exp(x, true), log: (x, n) => n.log(x, false), log2: (x, n) => n.log(x, true),
  fract: (x, n) => n.fract(x), inverseSqrt: (x, n) => n.inverseSqrt(x), sqrt: (x, n) => n.sqrt(x), saturate: (x, n) => n.clamp(x, 0, 1),
}
const trailing = (x: number): number => (x === 0 ? 32 : 31 - Math.clz32(x & -x))
/** The integer bit functions on the bits of x (the caller wraps the result to i32 or u32). */
const INT1: { readonly [name: string]: (x: number, signed: boolean) => number } = {
  countOneBits: (x) => {
    let v = x | 0
    let c = 0
    while (v !== 0) {
      v &= v - 1
      c++
    }
    return c
  },
  reverseBits: (x) => {
    let v = x | 0
    let r = 0
    for (let i = 0; i < 32; i++) {
      r = (r << 1) | (v & 1)
      v >>>= 1
    }
    return r
  },
  firstLeadingBit: (x, signed) => (signed ? (x === 0 || x === -1 ? -1 : 31 - Math.clz32(x < 0 ? ~x : x)) : x === 0 ? -1 : 31 - Math.clz32(x)),
  firstTrailingBit: (x) => (x === 0 ? -1 : trailing(x)),
  countLeadingZeros: (x) => Math.clz32(x),
  countTrailingZeros: (x) => trailing(x),
}
const BUILTIN_NAMES = new Set([...Object.keys(FLOAT1), ...Object.keys(INT1), 'abs', 'sign', 'atan2', 'pow', 'step', 'min', 'max', 'clamp', 'fma', 'mix', 'smoothstep',
  'select', 'any', 'all', 'dot', 'cross', 'length', 'normalize', 'distance', 'reflect', 'determinant', 'transpose', 'extractBits', 'insertBits', 'arrayLength',
  'workgroupBarrier', 'storageBarrier', 'textureDimensions', 'textureNumLevels', 'textureNumLayers', 'textureLoad', 'textureStore', 'textureSample',
  'textureSampleLevel', 'textureSampleGrad', 'dpdx', 'dpdy', 'fwidth', 'dpdxFine', 'dpdyFine', 'fwidthFine', 'dpdxCoarse', 'dpdyCoarse', 'fwidthCoarse'])

// ---------------------------------------------------------------------------------------------------
// Running a module: resources, waves and the three stages

/** A resource as bound, by `${group}:${binding}`: a buffer's bytes (exactly the bound range), an image, or a sampler. */
type Resource = { readonly bytes: Uint8Array } | ImageBinding | { readonly sampler: SamplerState }
type Resources = { readonly [key: string]: Resource }
/** One vertex: its builtins and its location inputs (a number or the components). */
interface VertexIn {
  readonly vertex_index?: number
  readonly instance_index?: number
  readonly locations?: { readonly [location: number]: number | readonly number[] }
}
/** One lane of a fragment quad: the position (pixel centre, depth, 1/w), facing, locations, and whether it starts as a helper. */
interface FragmentIn {
  readonly position: readonly number[]
  readonly front_facing?: boolean
  readonly locations?: { readonly [location: number]: number | readonly number[] }
  readonly helper?: boolean
}
/** What a vertex or fragment lane hands on. A discarded or helper lane's outputs are not used downstream. */
interface StageOut {
  readonly builtins: { readonly [name: string]: Val }
  readonly locations: { readonly [location: number]: Val }
  readonly discarded: boolean
  readonly helper: boolean
}

const KINDS: { readonly [S in TexSample]: string } = { f32: 'float', i32: 'sint', u32: 'uint', depth: 'depth' }

/** A number from the caller as a component of type t. */
function coerce(t: Ty, v: number | readonly number[]): Val {
  const one = (s: Scalar | null, x: number): number => (s === 'f32' ? f32(x) : s === 'i32' ? x | 0 : s === 'u32' ? x >>> 0 : x ? 1 : 0)
  if (t.k === 'vec') {
    if (typeof v === 'number' || v.length !== t.n) throw new RunError(`a ${typeName(t)} input needs ${t.n} components`)
    return v.map((x) => one(t.s, x))
  }
  if (typeof v !== 'number') throw new RunError(`a ${typeName(t)} input is one number`)
  return one(scalarOf(t), v)
}

/** A module parsed, checked and compiled for one mode, ready to run any number of times. */
class Program {
  readonly ast: ModuleAst
  readonly c: Compiler
  readonly budget: number

  constructor(src: string, options: RunOptions) {
    this.ast = parse(src)
    this.c = new Compiler(this.ast, new Numbers(options))
    this.c.compileAll()
    this.budget = options.budget ?? 1e7
  }

  /** Accesses outside a vector, grid, array, buffer or image (and texture levels out of range) in all runs so far. */
  get oob(): number {
    return this.c.st.oob
  }

  entry(stage: 'compute' | 'vertex' | 'fragment', name?: string): FnInfo {
    const list = [...this.c.fns.values()].filter((f) => f.stage === stage && (name === undefined || f.name === name))
    if (list.length !== 1) throw new RunError(`the module has ${list.length} ${stage} entry points${name === undefined ? '' : ` named ${name}`}; give one name`)
    return list[0]
  }

  /** Binds resources to the module's variables, refusing what WebGPU would refuse at a draw or dispatch. */
  bind(resources: Resources): void {
    const st = this.c.st
    const n = this.c.gvarList.length
    st.bufs = new Array<DataView | null>(n).fill(null)
    st.images = new Array<ImageBinding | null>(n).fill(null)
    st.samplers = new Array<SamplerState | null>(n).fill(null)
    for (const g of this.c.gvarList) {
      if (g.group < 0) continue
      const r = resources[`${g.group}:${g.binding}`] as Partial<{ bytes: Uint8Array; store: ImageStore; view: ViewRange; sampler: SamplerState }> | undefined
      if (r === undefined) continue
      const what = `${g.name} (@group(${g.group}) @binding(${g.binding}))`
      const t = g.ty
      if (g.space === 'uniform' || g.space === 'storage') {
        if (!(r.bytes instanceof Uint8Array)) throw new RunError(`${what} is a buffer`)
        if (r.bytes.length < sizeOf(t) || r.bytes.length % 4 !== 0) throw new RunError(`${what} binds ${r.bytes.length} bytes, and the shader's minimum binding size is ${sizeOf(t)} (a multiple of 4)`)
        st.bufs[g.index] = new DataView(r.bytes.buffer, r.bytes.byteOffset, r.bytes.length)
      } else if (t.k === 'sampler') {
        if (r.sampler === undefined) throw new RunError(`${what} is a sampler`)
        st.samplers[g.index] = r.sampler
      } else if (t.k === 'tex' || t.k === 'storage-tex') {
        if (!(r.store instanceof ImageStore) || r.view === undefined) throw new RunError(`${what} is an image`)
        if (r.store.samples !== 1) throw new RunError(`${what} reads one-sample images`)
        if (t.k === 'tex') {
          if (sampleKind(r.store.format) !== KINDS[t.sample]) throw new RunError(`${what} is a ${typeName(t)}, and a ${r.store.format} image holds ${sampleKind(r.store.format)} values`)
          if (t.dim === '2d' && r.view.layers.count !== 1) throw new RunError(`${what} is a 2d texture, a view of one layer`)
        } else if (r.store.format !== t.format) throw new RunError(`${what} is declared ${t.format}, and the image is ${r.store.format}`)
        st.images[g.index] = { store: r.store, view: r.view }
      }
    }
  }

  /** Runs one wave of an entry point. `input(slot, lane)` gives each stage input; returns each lane's result. */
  private wave(f: FnInfo, lanes: number, input: (s: IoSlot, lane: number) => Val, helpers: Mask): Lanes {
    const st = this.c.st
    st.L = lanes
    st.helper = helpers.slice()
    st.discarded = new Uint8Array(lanes)
    st.quad = f.stage === 'fragment'
    st.priv = this.c.gvarList.map((g) => (g.space === 'private' ? Array.from({ length: lanes }, () => ({ v: copy(g.init ?? zeroOf(g.ty)) })) : []))
    st.frame = new Array<unknown>(f.slots)
    f.params.forEach((t, i) => {
      const vals: Lanes = new Array<Val>(lanes)
      for (let l = 0; l < lanes; l++) {
        if (t.k === 'struct') vals[l] = t.members.map((_, k) => input(f.inputs.find((s) => s.param === i && s.member === k) as IoSlot, l))
        else vals[l] = input(f.inputs.find((s) => s.param === i) as IoSlot, l)
      }
      st.frame[f.paramSlots[i]] = vals
    })
    st.ret = new Uint8Array(lanes)
    st.retv = new Array<Val>(lanes)
    st.brk = new Uint8Array(lanes)
    st.cont = new Uint8Array(lanes)
    f.body(new Uint8Array(lanes).fill(1))
    return st.retv
  }

  private outputs(f: FnInfo, retv: Lanes, lane: number): StageOut {
    const st = this.c.st
    const builtins: { [name: string]: Val } = {}
    const locations: { [location: number]: Val } = {}
    for (const s of f.outputs) {
      const v = s.member < 0 ? retv[lane] : (retv[lane] as Val[])[s.member]
      if ('builtin' in s.io) builtins[s.io.builtin] = v
      else locations[s.io.location] = v
    }
    return { builtins, locations, discarded: st.discarded[lane] !== 0, helper: st.helper[lane] !== 0 }
  }

  /**
   * Runs a compute dispatch: workgroups x fastest, then y, then z. A workgroup runs as one wave when the module uses
   * workgroup memory or a barrier, and otherwise four consecutive local indices at a time, as interp.ts's dispatch().
   */
  dispatch(groups: readonly [number, number, number], resources: Resources, name?: string): void {
    const f = this.entry('compute', name)
    const st = this.c.st
    this.bind(resources)
    st.steps = 0
    st.budget = this.budget
    const [sx, sy, sz] = f.group
    const per = sx * sy * sz
    const whole = f.uses.has('barrier') || f.uses.has('workgroup')
    const size = whole ? per : 4
    for (let z = 0; z < groups[2]; z++) {
      for (let y = 0; y < groups[1]; y++) {
        for (let x = 0; x < groups[0]; x++) {
          st.wg = this.c.gvarList.map((g) => ({ v: g.space === 'workgroup' ? zeroOf(g.ty) : 0 }))
          for (let first = 0; first < per; first += size) {
            const lanes = Math.min(size, per - first)
            this.wave(f, lanes, (s, l) => {
              const i = first + l
              const local = [i % sx, Math.floor(i / sx) % sy, Math.floor(i / (sx * sy))]
              const name = (s.io as { builtin: string }).builtin
              switch (name) {
                case 'local_invocation_id': return local
                case 'local_invocation_index': return i
                case 'global_invocation_id': return [x * sx + local[0], y * sy + local[1], z * sz + local[2]]
                case 'workgroup_id': return [x, y, z]
                default: return [groups[0], groups[1], groups[2]]
              }
            }, new Uint8Array(lanes))
          }
        }
      }
    }
  }

  /** Runs vertices four at a time; returns each one's outputs. */
  vertex(vertices: readonly VertexIn[], resources: Resources, name?: string): StageOut[] {
    const f = this.entry('vertex', name)
    const st = this.c.st
    this.bind(resources)
    st.steps = 0
    st.budget = this.budget
    const out: StageOut[] = []
    for (let first = 0; first < vertices.length; first += 4) {
      const lanes = Math.min(4, vertices.length - first)
      const retv = this.wave(f, lanes, (s, l) => {
        const v = vertices[first + l]
        if ('builtin' in s.io) return coerce(s.ty, (s.io.builtin === 'vertex_index' ? v.vertex_index : v.instance_index) ?? 0)
        const given = v.locations?.[s.io.location]
        if (given === undefined) throw new RunError(`vertex ${first + l} gives no location ${s.io.location}`)
        return coerce(s.ty, given)
      }, new Uint8Array(lanes))
      for (let l = 0; l < lanes; l++) out.push(this.outputs(f, retv, l))
    }
    return out
  }

  /** Runs one 2 x 2 quad of fragments in lock step; returns each lane's outputs. */
  fragment(quad: readonly FragmentIn[], resources: Resources, name?: string): StageOut[] {
    if (quad.length !== 4) throw new RunError('a fragment quad has four lanes')
    const f = this.entry('fragment', name)
    const st = this.c.st
    this.bind(resources)
    st.steps = 0
    st.budget = this.budget
    const helpers = Uint8Array.from(quad.map((q) => (q.helper === true ? 1 : 0)))
    const retv = this.wave(f, 4, (s, l) => {
      const q = quad[l]
      if ('builtin' in s.io) return s.io.builtin === 'position' ? coerce(s.ty, q.position) : q.front_facing === false ? 0 : 1
      const given = q.locations?.[s.io.location]
      if (given === undefined) throw new RunError(`lane ${l} gives no location ${s.io.location}`)
      return coerce(s.ty, given)
    }, helpers)
    return [0, 1, 2, 3].map((l) => this.outputs(f, retv, l))
  }
}

// ===================================================================================================
// The tests

const EXACT_RUN: RunOptions = { mode: 'exact' }
const ADVERSARIAL: RunOptions = { mode: 'adversarial' }

/** The bits of an f32, and the f32 of some bits. */
const fb = (x: number): number => f32Bits(x)
const bf = (u: number): number => bitsF32(u)
const NAN_BITS = 0x7fc00000
const INF_BITS = 0x7f800000
const NEG_ZERO_BITS = 0x80000000

/** Little-endian bytes of 32-bit words, and back. */
function wordsOf(xs: readonly number[]): Uint8Array {
  const out = new Uint8Array(Math.max(1, xs.length) * 4)
  const d = new DataView(out.buffer)
  xs.forEach((x, i) => d.setUint32(4 * i, x >>> 0, true))
  return out
}
function wordsIn(bytes: Uint8Array): number[] {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.length)
  return Array.from({ length: bytes.length >> 2 }, (_, i) => d.getUint32(4 * i, true))
}

/**
 * Every run-based test shares this prelude: `a` holds the inputs as words, F, I and U read one as f32, i32 or u32
 * (F by a bit cast, so NaN, infinities, -0 and subnormals arrive exactly), and the put functions write words of `o`.
 */
const PRELUDE = `
@group(0) @binding(0) var<storage, read> a: array<u32>;
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
fn F(i: u32) -> f32 { return bitcast<f32>(a[i]); }
fn I(i: u32) -> i32 { return bitcast<i32>(a[i]); }
fn U(i: u32) -> u32 { return a[i]; }
fn putF(i: u32, x: f32) { o[i] = bitcast<u32>(x); }
fn putI(i: u32, x: i32) { o[i] = bitcast<u32>(x); }
fn putU(i: u32, x: u32) { o[i] = x; }
fn putB(i: u32, x: bool) { o[i] = select(0u, 1u, x); }
`
const kernel = (body: string, decls = ''): string => `${PRELUDE}${decls}\n@compute @workgroup_size(1) fn main() {\n${body}\n}\n`

/** Runs `body` as a one-invocation compute entry point with `inputs` as the words of `a`; returns the 16 words of `o`. */
function run(body: string, inputs: readonly number[] = [], options: RunOptions = EXACT_RUN, decls = ''): number[] {
  const p = new Program(kernel(body, decls), options)
  const out = new Uint8Array(64)
  p.dispatch([1, 1, 1], { '0:0': { bytes: wordsOf(inputs) }, '0:1': { bytes: out } })
  return wordsIn(out)
}
/** The same, reading the words of `o` as f32. */
const runF = (body: string, inputs: readonly number[] = [], options: RunOptions = EXACT_RUN, decls = ''): number[] => run(body, inputs, options, decls).map(bf)

/** Holds that a module is refused with a WgslError whose message matches. */
function refused(src: string, pattern: RegExp): void {
  assert.throws(() => new Program(src, EXACT_RUN), (e: unknown) => {
    assert.ok(e instanceof WgslError, `expected a WgslError, got ${String(e)}`)
    assert.match(e.message, pattern)
    return true
  })
}
const refusedBody = (body: string, pattern: RegExp, decls = ''): void => refused(kernel(body, decls), pattern)
const accepted = (src: string): Program => new Program(src, EXACT_RUN)
const acceptedBody = (body: string, decls = ''): Program => accepted(kernel(body, decls))

/** Holds f32 results bit for bit (so -0 and +0 differ), except that any NaN equals any NaN: payloads are not pinned. */
function sameF32(got: readonly number[], want: readonly number[], what = ''): void {
  const key = (x: number): number => (Number.isNaN(x) ? NAN_BITS : fb(x))
  assert.deepEqual(got.map(key), want.map(key), what)
}

// ---------------------------------------------------------------------------------------------------
// The parser and the checker

/** A fragment module in the shape section 11 of the design gives: directive, typed and hidden blocks, helpers, entry. */
const DESIGN_FRAGMENT = `
diagnostic(off, derivative_uniformity);           // only in fragment modules with deriv or implicit-level sample

struct B0 { @align(16) @size(16) f0: vec4<f32>, @align(4) @size(16) f1: f32 }
struct B1 { @align(16) @size(16) f0: vec4<u32> }
struct NgHidden {
  @size(128) c: B1,
  lim: array<vec4<u32>, 4>,
  none: u32, checked: u32, base: i32, zero: u32,
}
@group(3) @binding(0) var<uniform> ng_h: NgHidden;
@group(0) @binding(0) var<uniform> r0: B0;
@group(0) @binding(1) var<storage, read_write> r1: array<u32>;   /* a raw block /* nested */ comment */
@group(1) @binding(0) var r2: texture_2d<f32>;
@group(1) @binding(1) var r3: sampler;

var<private> ng_i0: vec4<f32>;
var<private> ng_o0: vec4<f32>;
var<private> ng_fc: vec4<f32>;
var<private> ng_gone: bool;

fn ng_nan(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u; }
fn ng_nan2(x: vec2<f32>) -> vec2<bool> { return (bitcast<vec2<u32>>(x) & vec2<u32>(0x7fffffffu)) > vec2<u32>(0x7f800000u); }
fn ng_min(a: f32, b: f32) -> f32 { return select(a, b, ng_nan(a) | (!ng_nan(b) & (b < a))); }
fn ng_max(a: f32, b: f32) -> f32 { return select(a, b, ng_nan(a) | (!ng_nan(b) & (b > a))); }
fn ng_uv(u: vec2<f32>) -> vec2<f32> {
  let z = select(u, vec2<f32>(0.0), ng_nan2(u));
  return clamp(z, vec2<f32>(-16777216.0), vec2<f32>(16777216.0));
}

fn ng_body() {
  var ng_c0: u32;
  let v1 = ng_i0;
  let v2 = dpdxFine(v1.x);
  let v3 = textureSample(r2, r3, ng_uv(v1.xy));
  let k4 = 0x7fc00000u;
  let v4 = bitcast<f32>(k4);
  let v5 = ng_max(v4, r0.f1);
  ng_c0 = 0u;
  loop {
    if (ng_c0 >= 65536u) { break; }
    ng_c0 = ng_c0 + 1u;
    if (ng_c0 == 3u) { continue; }
    if (ng_c0 >= 5u) { break; }
  }
  if ((bitcast<u32>(v1.w) & 0x7fffffffu) != 0u) { ng_gone = true; discard; }
  let ng_n7 = select(0u, (arrayLength(&r1) * 4u - 8u) / 4u, arrayLength(&r1) * 4u >= 8u);
  let ng_j7 = min(u32(ng_fc.x), max(ng_n7, 1u) - 1u);
  let ng_w7 = min((8u + ng_j7 * 4u) / 4u, arrayLength(&r1) - 1u);
  if (ng_n7 != 0u && !ng_gone) { r1[ng_w7] = bitcast<u32>(v2); }
  ng_o0 = vec4<f32>(v2, v5, v3.x, f32(ng_c0));
}

struct NgFIn { @builtin(position) fc: vec4<f32>, @builtin(front_facing) ff: bool, @location(0) i0: vec4<f32> }
struct NgFOut { @location(0) c0: vec4<f32>, @location(2) c2: vec4<u32> }
@fragment fn ng_fragment(a: NgFIn) -> NgFOut {
  ng_fc = a.fc; ng_i0 = a.i0;
  ng_body();
  var o: NgFOut;
  o.c0 = vec4<f32>(ng_o0.xy, ng_o0.z, ng_o0.w);
  o.c2 = vec4<u32>(select(0u, 1u, a.ff), ng_h.lim[1][2], bitcast<u32>(ng_h.base), ng_h.c.f0.w);
  return o;
}
`

/** A 2 x 2 image of one level whose texel (x, y) holds `f(x, y)` in every channel it has. */
function imageOf(format: Format, w: number, h: number, f: (x: number, y: number, layer: number, level: number) => number, layers = 1, levels = 1): ImageStore {
  const store = new ImageStore({ format, width: w, height: h, layers, levels, samples: 1 })
  for (let q = 0; q < levels; q++) {
    for (let k = 0; k < layers; k++) {
      for (let y = 0; y < store.levelHeight(q); y++) {
        for (let x = 0; x < store.levelWidth(q); x++) {
          const v = f(x, y, k, q)
          store.write(q, k, x, y, 0, [v, v, v, v])
        }
      }
    }
  }
  return store
}
const NEAREST: SamplerState = { mag: 'nearest', min: 'nearest', mip: 'nearest', wrap: ['clamp', 'clamp', 'clamp'], lodMin: 0, lodMax: 32 }
const LINEAR: SamplerState = { mag: 'linear', min: 'linear', mip: 'linear', wrap: ['clamp', 'clamp', 'clamp'], lodMin: 0, lodMax: 32 }
const viewOf = (store: ImageStore): ViewRange => ({ levels: { base: 0, count: store.levels }, layers: { base: 0, count: store.layers } })

/** The four lanes of the quad whose top-left pixel is (x, y), with each lane's location 0 from `loc(lane)`. */
function quadAt(x: number, y: number, loc: (lane: number) => number[], helper: (lane: number) => boolean = () => false): FragmentIn[] {
  return [0, 1, 2, 3].map((l) => ({ position: [x + (l & 1) + 0.5, y + (l >> 1) + 0.5, 0.5, 1], front_facing: true, locations: { 0: loc(l) }, helper: helper(l) }))
}

test('the parser and checker take a fragment module in the shape the lowering prints, and it runs on a quad', () => {
  const p = accepted(DESIGN_FRAGMENT)
  assert.deepEqual(p.ast.directives, [{ severity: 'off', rule: 'derivative_uniformity' }])
  assert.deepEqual(p.ast.decls.map((d) => d.name).slice(0, 4), ['B0', 'B1', 'NgHidden', 'ng_h'])
  const hidden = p.c.structs.get('NgHidden') as StructTy
  assert.deepEqual(hidden.members.map((m) => m.offset), [0, 128, 192, 196, 200, 204])
  assert.equal(hidden.size, 208)
  const b0 = p.c.structs.get('B0') as StructTy
  assert.deepEqual([b0.members[1].offset, b0.size], [16, 32])

  const h = new Uint8Array(208)
  const hv = new DataView(h.buffer)
  hv.setUint32(12, 77, true)
  hv.setUint32(128 + 16 + 8, 42, true)
  hv.setInt32(200, -3, true)
  const r0 = new Uint8Array(32)
  new DataView(r0.buffer).setFloat32(16, 2.5, true)
  const r1 = new Uint8Array(16)
  const store = imageOf('r32f', 4, 4, (x, y) => x + 10 * y)
  const resources = { '3:0': { bytes: h }, '0:0': { bytes: r0 }, '0:1': { bytes: r1 }, '1:0': { store, view: viewOf(store) }, '1:1': { sampler: NEAREST } }
  // Location 0 is (u, v, -, w): u steps 0.25 a pixel to the right; the last lane's w is NaN, so it is discarded.
  const out = p.fragment(quadAt(0, 0, (l) => [0.125 + 0.25 * (l & 1), 0.125 + 0.25 * (l >> 1), 0, l === 3 ? NaN : 0]), resources)
  for (let l = 0; l < 4; l++) {
    const c0 = out[l].locations[0] as number[]
    assert.equal(c0[0], 0.25, 'dpdxFine of u')
    assert.equal(c0[1], 2.5, 'ng_max of NaN and 2.5')
    assert.equal(c0[2], (l & 1) + 10 * (l >> 1), 'textureSample, nearest')
    assert.equal(c0[3], 5, 'the loop ran to its break')
    assert.deepEqual(out[l].locations[2], [1, 42, 0xfffffffd, 77])
    assert.equal(out[l].discarded, l === 3)
  }
  // Lanes 0 to 2 wrote word 2 + floor(x); the discarded lane wrote nothing (it would have written word 3 again).
  assert.deepEqual(wordsIn(r1), [0, 0, fb(0.25), fb(0.25)])
  assert.equal(p.oob, 0)
})

test('the parser reads WGSL syntax the printer may use: templates, >> closing two lists, literals, comments, attributes', () => {
  const p = acceptedBody(`
    // A line comment, and /* a block /* nested */ comment */ on one line.
    let x: array<array<f32, 2>, 3> = array<array<f32, 2>, 3>(array<f32, 2>(1.0, 2.0), array(3.0, 4.0), array<f32, 2>());
    let y = vec2<u32>(U(0) >> 1u, U(0)>>2u);
    let z = mat2x2<f32>(vec2<f32>(1.0, 2.0), vec2f(3.0, 4.0));
    let w = vec4(1.0, 2, 3.5e0, .5) * vec4<f32>(0x1, 1., 1e0, 1.0f);
    let q = select(1i, -2147483647i - 1i, U(0) > 0u);
    putF(0u, x[1][1]); putU(1u, y.x + y.y); putF(2u, z[1].y); putF(3u, w.w); putI(4u, q);
    _ = x;
  `)
  assert.equal(p.c.fns.get('main')?.stage, 'compute')
  const got = run(`
    let x = array<array<f32, 2>, 3>(array<f32, 2>(1.0, 2.0), array(3.0, 4.0), array<f32, 2>());
    let y = vec2<u32>(U(0) >> 1u, U(0)>>2u);
    let z = mat2x2<f32>(vec2<f32>(1.0, 2.0), vec2f(3.0, 4.0));
    let w = vec4(1.0, 2, 3.5e0, .5) * vec4<f32>(0x1, 1., 1e0, 1.0f);
    putF(0u, x[1][1]); putU(1u, y.x + y.y); putF(2u, z[1].y); putF(3u, w.w); putF(4u, x[2][0]);
  `, [8])
  assert.deepEqual(got.slice(0, 5), [fb(4), 6, fb(4), fb(0.5), fb(0)])
  // A comparison that only looks like a template is still a comparison, in parentheses.
  assert.deepEqual(run('let a1 = 1i; let b1 = 2i; putB(0u, (a1 < b1) == (b1 > a1));').slice(0, 1), [1])
})

test('the parser refuses what is outside the subset, saying where', () => {
  refused('fn f() -> i32 {\n  return 1i +;\n}', /^wgsl 2:\d+: /)
  refused('enable f16;\n', /enable directives are outside the subset/)
  refused('requires readonly_and_readwrite_storage_textures;\n', /requires directives/)
  refused('diagnostic(off, subgroup_uniformity);\n', /diagnostic rule/)
  refused('override k: u32 = 4u;\n', /override and const_assert are outside/)
  refused('const_assert 1 < 2;\n', /override and const_assert are outside/)
  refusedBody('let x = 0x1p3;', /hexadecimal floating point/)
  refusedBody('let x = 1.5h;', /f16 is outside/)
  refusedBody('let x = 08;', /malformed number/)
  refusedBody('let x = 1u2;', /malformed number/)
  refusedBody('let __x = 1;', /two underscores/)
  refusedBody('let x = 1; // caf\u00e9', /character code 233 is outside the subset/)
  refused('fn f() {}\nfn g\u00e9() {}', /^wgsl 2:5: character code 233/)
  refusedBody('/* never closed', /never closed/)
  refusedBody('@diagnostic(off, derivative_uniformity) { }', /attributes on statements/)
  refusedBody('let x = U(0) $ 2u;', /unexpected character/)
  refused('@group(0) @binding(0) @group(1) var<uniform> u: vec4<f32>;', /given twice/)
})

test('expressions follow WGSL\'s grammar: the operator mixes WGSL wants parenthesised are refused', () => {
  const t = 'let a1 = U(0); let b1 = U(1); let c1 = U(2); let p1 = a1 > 0u; let q1 = b1 > 0u; let r1 = c1 > 0u;'
  refusedBody(`${t} let x = a1 & b1 | c1;`, /parentheses to mix/)
  refusedBody(`${t} let x = a1 | b1 ^ c1;`, /parentheses to mix/)
  refusedBody(`${t} let x = a1 < b1 < c1;`, /parentheses to mix/)
  refusedBody(`${t} let x = a1 == b1 == c1;`, /parentheses to mix/)
  refusedBody(`${t} let x = a1 < b1 == p1;`, /parentheses to mix/)
  refusedBody(`${t} let x = p1 && q1 || r1;`, /parentheses to mix/)
  refusedBody(`${t} let x = p1 & q1 && r1;`, /parentheses to mix/)
  refusedBody(`${t} let x = a1 << b1 + c1;`, /parentheses to mix|shift/)
  refusedBody(`${t} let x = a1 + b1 << c1;`, /parentheses to mix|shift/)
  refusedBody(`${t} let x = a1 << b1 << c1;`, /parentheses to mix|shift/)
  refusedBody(`${t} let x = a1 & b1 + c1;`, /parentheses to mix/)
  refusedBody('let x = --1i;', /two unary operators/)
  // The forms WGSL allows.
  const got = run(`${t}
    putU(0u, (a1 & b1) | c1); putU(1u, a1 & b1 & c1); putU(2u, a1 + b1 * c1 - a1 / b1 % c1);
    putB(3u, (a1 < b1) == p1); putB(4u, p1 && q1 && r1); putB(5u, (p1 && q1) || r1); putB(6u, p1 & q1 & !r1);
    putU(7u, (a1 << 2u) + (b1 >> 1u)); putU(8u, ~a1); putB(9u, p1 | q1 | r1); putI(10u, - -I(1)); putI(11u, -(-I(1)));
  `, [6, 3, 0])
  // c1 is 0, so a1 / b1 % c1 is 2 % 0, which is 0 at run time.
  assert.deepEqual(got.slice(0, 12), [2, 0, 6, 0, 0, 1, 1, 25, 0xfffffff9, 1, 3, 3])
  refusedBody('let x = -U(0);', /- does not take a u32/)
})

test('types are checked as WGSL checks them: abstract literals convert only where WGSL lets them', () => {
  refusedBody('let x = I(0) + U(1);', /\+ does not take a i32 and a u32/)
  refusedBody('let x: u32 = -1;', /-1 is not a u32/)
  refusedBody('let x: i32 = 1.0;', /where a i32 is wanted/)
  refusedBody('let x = 1.0 + 1i;', /does not take/)
  refusedBody('let x = I(0) >> I(1);', /where a u32 is wanted/)
  refusedBody('let x = true ^ false;', /use != for a bool/)
  refusedBody('let x = F(0) & F(1);', /& does not take f32/)
  refusedBody('let x = U(0) == 1.0;', /does not take/)
  refusedBody('let x = vec2<f32>(1.0, 2.0, 3.0);', /given 3 components/)
  refusedBody('let x = frexp(1.0);', /frexp is not a function in the subset/)
  refusedBody('let x = textureSampleCompare(1.0);', /not a function in the subset/)
  refusedBody('min(F(0), 2.0);', /must be used/)
  refusedBody('let x = F(0); if (x) { }', /a condition is a bool/)
  refusedBody('let x = vec2<bool>(true, false) & vec2<bool>(true, true); let y = all(x) < any(x);', /does not order bools/)
  refusedBody('let x: vec3<f32> = vec2<f32>(1.0, 2.0);', /where a vec3<f32> is wanted/)
  // What WGSL allows: an abstract literal meets a concrete operand, a let without a type takes the concrete type.
  assert.deepEqual(run('let x = 1 + U(0); let y: f32 = 1; let z = 1 + 2.5; let w = min(1, U(0)); putU(0u, x); putF(1u, y + z); putU(2u, w); putU(3u, 1u << 31u);', [7]).slice(0, 4), [8, fb(4.5), 1, 0x80000000])
})

test('const-expressions are evaluated, and refused where WGSL refuses them', () => {
  refusedBody('let x = 2147483648i;', /not an i32/)
  refusedBody('let x = 4294967296u;', /not a u32/)
  refusedBody('let x = -2147483648i;', /not an i32/)
  refusedBody('let x = 2147483647i + 1i;', /overflows i32/)
  refusedBody('let x = 0u - 1u;', /overflows u32/)
  refusedBody('const m = -2147483647i - 1i; let q = m / -1i;', /overflows i32/)
  refusedBody('const m = -2147483647i - 1i; let q = m % -1i;', /WGSL refuses/)
  refusedBody('let x = U(0) / 0u;', /by a const zero/)
  refusedBody('let x = I(0) % 0i;', /by a const zero/)
  refusedBody('let x = U(0) / vec2<u32>(1u, 0u).y;', /by a const zero/)
  refusedBody('let x = U(0) << 32u;', /shift by a const count of 32/)
  refusedBody('let x = vec2<u32>(U(0)) >> vec2<u32>(1u, 40u);', /shift by a const count of 32/)
  refusedBody('const k = 1i << 31u;', /overflows/)
  refusedBody('let x = bitcast<f32>(0x7fc00000u);', /NaN or infinity/)
  refusedBody('let x = bitcast<f32>(0xff800000u);', /NaN or infinity/)
  refusedBody('let x = 1e39f;', /outside the finite range of f32/)
  refusedBody('let x: f32 = 1e39;', /outside the finite range of f32/)
  refusedBody('let x = 1.0 / 0.0;', /overflows or is not a number/)
  refusedBody('let x = 3e38f * 2.0;', /overflows or is not a number/)
  refusedBody('let x = clamp(U(0), 5u, 1u);', /clamp with const low 5 above high 1/)
  refusedBody('let x = extractBits(U(0), 30u, 4u);', /past 32 bits/)
  refusedBody('let x = sqrt(-1.0);', /NaN or infinity/)
  refusedBody('const c = vec3<f32>(1.0, 2.0, 3.0); let y = c[3];', /index 3 is outside/)
  refused('const c = d;\nconst d = c;', /refers to itself/)
  refusedBody('const c = d; const d = 1;', /d is not declared/)
  // A const-expression is evaluated now, exactly: here in abstract precision before it becomes an f32.
  const got = run('const big = 16777217; let x = f32(big - 1); const t = 0.1 + 0.2; let y: f32 = t; putF(0u, x); putF(1u, y); putI(2u, -2147483647i - 1i); putU(3u, 0xffffffffu);')
  assert.deepEqual(got.slice(0, 4), [fb(16777216), fb(0.1 + 0.2), 0x80000000, 0xffffffff])
})

test('statement behaviours are computed: falling off the end, unreachable code and stray break and continue are refused', () => {
  refused('fn f(x: i32) -> i32 { if (x > 0i) { return 1i; } }', /can reach its end without returning/)
  accepted('fn f(x: i32) -> i32 { if (x > 0i) { return 1i; } else { return 2i; } }')
  accepted('fn f(x: i32) -> i32 { loop { if (x > 0i) { return 1i; } } }')
  refused('fn f(x: i32) -> i32 { loop { if (x > 0i) { break; } } }', /can reach its end/)
  refusedBody('return; putU(0u, 1u);', /unreachable code/)
  refusedBody('if (U(0) > 0u) { return; } else { return; } putU(0u, 1u);', /unreachable code/)
  refusedBody('loop { break; putU(0u, 1u); }', /unreachable code/)
  refusedBody('loop { }', /can never end/)
  refusedBody('loop { continue; }', /can never end/)
  refusedBody('break;', /break outside a loop or switch/)
  refusedBody('continue;', /continue outside a loop/)
  refusedBody('switch U(0) { default: { continue; } }', /continue outside a loop/)
  refusedBody('loop { if (U(0) > 0u) { break; } continuing { continue; } }', /continue inside a continuing block/)
  refusedBody('loop { if (U(0) > 0u) { break; } continuing { break; } }', /break cannot leave a continuing block/)
  refusedBody('loop { if (U(0) > 0u) { break; } continuing { return; } }', /return inside a continuing block/)
  refusedBody('loop { continuing { break if true; putU(0u, 1u); } }', /must be the last statement/)
  refusedBody('if (U(0) > 0u) { break if true; }', /belongs only at the end of a continuing block/)
  refusedBody('switch U(0) { case 1u: { } }', /exactly one default/)
  refusedBody('switch U(0) { case 1u, 1u: { } default: { } }', /appears twice/)
  refusedBody('switch U(0) { case 1i: { } default: { } }', /case of type i32/)
  refusedBody('switch F(0) { default: { } }', /selects on i32 or u32/)
  refused('fn f() { f(); }', /no recursion/)
  refused('fn f() { g(); }\nfn g() { f(); }', /no recursion/)
  refused('@compute @workgroup_size(1) fn main() { }\nfn g() { main(); }', /entry point and cannot be called/)
  accepted('fn f() { loop { continuing { break if true; } } }')
  accepted('fn f(x: u32) -> u32 { switch x { case 0u, 1u: { return 1u; } default: { return 2u; } } }')
  accepted('fn f(x: u32) { for (var i = 0u; i < x; i++) { if (i == 2u) { continue; } } while (x > 0u) { break; } }')
})

test('memory is checked: only variables are written, buffers by their access, and indices by their bounds', () => {
  refusedBody('let x = 1u; x = 2u;', /only a variable/)
  refusedBody('u.x = 1.0;', /a uniform variable cannot be written/, '@group(1) @binding(0) var<uniform> u: vec4<f32>;')
  refusedBody('a[0] = 1u;', /a storage read variable cannot be written/)
  refusedBody('var v = vec4<f32>(); v.xy = vec2<f32>(1.0);', /only a variable/)
  refusedBody('var v: array<f32, 3>; v[3] = 1.0;', /index 3 is outside/)
  refusedBody('let v = vec3<f32>(); let y = v[3];', /index 3 is outside/)
  refusedBody('let v = mat2x2<f32>(); let y = v[2];', /index 2 is outside/)
  refusedBody('var v = vec3<f32>(); let y = v.xw;', /not a swizzle/)
  refusedBody('var v = vec3<f32>(); let y = v.xg;', /not a swizzle/)
  refusedBody('_ = g();', /returns nothing/, 'fn g() { }')
  refusedBody('var x;', /needs a type or a value/)
  refusedBody('let min = 1;', /shadows a WGSL type or builtin/)
  refusedBody('let x = 1; let x = 2;', /declared twice in one scope/)
  refusedBody('var v = 1u; let p = &v;', /cannot hold a ptr/)
  refusedBody('let x = *a;', /pointer indirection is outside the subset/)
  refusedBody('let n = arrayLength(&o2);', /arrayLength takes &/, 'var<private> o2: array<u32, 4>;')
  refused('var<private> p: array<u32>;', /cannot hold a array<u32>/)
  refused('var<function> p: u32;', /outside the subset at module scope/)
  refused('var<uniform> u: vec4<f32>;', /needs @group and @binding/)
  refused('@group(0) @binding(0) var<private> u: vec4<f32>;', /takes no @group or @binding/)
  refused('@group(0) @binding(0) var<uniform> u: vec4<f32>;\n@group(0) @binding(0) var<uniform> w: vec4<f32>;', /used twice/)
  // A single component may be written, and a block scope may shadow an outer name.
  assert.deepEqual(run('var v = vec4<f32>(1.0, 2.0, 3.0, 4.0); v.y = 7.0; v[2] = 8.0; let x = 1u; { let x = 2u; putU(1u, x); } putF(0u, v.y + v[2]); putU(2u, x);').slice(0, 3), [fb(15), 2, 1])
})

test('buffer layouts follow the printed @align and @size and WGSL\'s rules for each address space', () => {
  const src = `
    struct SB { a: vec3<f32>, b: f32, c: vec2<f32>, d: mat3x3<f32>, e: array<vec3<f32>, 2>, f: array<u32> }
    struct UB { a: f32, b: array<vec4<f32>, 2>, @align(16) c: f32, @size(20) d: vec2<u32>, e: mat2x2<f32> }
    @group(1) @binding(0) var<storage, read_write> s: SB;
    @group(1) @binding(1) var<uniform> u: UB;`
  const p = acceptedBody(`
    s.e[1].z = 5.0; s.d[2] = vec3<f32>(1.0, 2.0, 3.0); s.f[1] = 9u; s.b = u.e[1].x + u.c;
    putU(0u, arrayLength(&s.f)); putU(1u, u.d.y); putF(2u, u.b[1].w);
  `, src)
  const S = p.c.structs.get('SB') as StructTy
  assert.deepEqual(S.members.map((m) => m.offset), [0, 12, 16, 32, 80, 112])
  // With the final array counted as one element, as WebGPU's minimum binding size counts it.
  assert.equal(sizeOf(S), 128)
  const U = p.c.structs.get('UB') as StructTy
  assert.deepEqual(U.members.map((m) => m.offset), [0, 16, 48, 56, 80])
  assert.equal(sizeOf(U), 96)
  const sb = new Uint8Array(128)
  const ub = new Uint8Array(96)
  const uv = new DataView(ub.buffer)
  uv.setFloat32(48, 0.5, true)
  uv.setUint32(60, 33, true)
  uv.setFloat32(16 + 16 + 12, 6.25, true)
  uv.setFloat32(80 + 8, 1.5, true)
  const out = new Uint8Array(16)
  p.dispatch([1, 1, 1], { '0:0': { bytes: wordsOf([0]) }, '0:1': { bytes: out }, '1:0': { bytes: sb }, '1:1': { bytes: ub } })
  const sv = new DataView(sb.buffer)
  assert.equal(sv.getFloat32(80 + 16 + 8, true), 5)
  assert.deepEqual([sv.getFloat32(32 + 32, true), sv.getFloat32(32 + 36, true), sv.getFloat32(32 + 40, true)], [1, 2, 3])
  assert.equal(sv.getUint32(112 + 4, true), 9)
  assert.equal(sv.getFloat32(12, true), 2)
  assert.deepEqual(wordsIn(out), [4, 33, fb(6.25), 0])
  // A binding smaller than the shader's minimum binding size is refused, as WebGPU refuses the dispatch.
  assert.throws(() => p.dispatch([1, 1, 1], { '0:0': { bytes: wordsOf([0]) }, '0:1': { bytes: out }, '1:0': { bytes: new Uint8Array(124) }, '1:1': { bytes: new Uint8Array(96) } }), /minimum binding size is 128/)
  assert.throws(() => p.dispatch([1, 1, 1], { '0:0': { bytes: wordsOf([0]) }, '0:1': { bytes: out }, '1:0': { bytes: new Uint8Array(128) } }), /nothing is bound to u/)

  refused('struct S { @size(2) x: f32 }', /@size\(2\) is smaller than the 4 bytes/)
  refused('struct S { @align(3) x: f32 }', /@align\(3\) is not a power of two/)
  refused('struct S { x: array<u32>, y: u32 }', /must be the last member/)
  refused('struct S { }', /has no members/)
  refused('struct S { x: S }', /contains itself/)
  refused('@group(0) @binding(0) var<uniform> u: array<vec4<f32>>;', /uniform buffer cannot hold an array sized by its binding/)
  refused('@group(0) @binding(0) var<uniform> u: array<f32, 4>;', /uniform array steps a multiple of 16 bytes/)
  refused('struct In { x: f32 }\nstruct S { b: f32, a: In }\n@group(0) @binding(0) var<uniform> u: S;', /member a of S is at offset 4, not a multiple of 16 as uniform requires/)
  refused('struct S { @align(4) v: vec4<f32> }\n@group(0) @binding(0) var<storage> u: S;', /@align\(4\) on S.v is not a multiple of 16 as storage requires/)
  // The spec's own examples: a struct member of alignment 4 at offset 0 is fine in uniform, and @align(16) spaces the next.
  accepted('struct In { x: f32 }\nstruct S { a: In, @align(16) b: f32 }\n@group(0) @binding(0) var<uniform> u: S;')
  accepted('struct B0 { @align(8) @size(8) f0: vec2<f32> }\nstruct H { @size(128) c: B0, lim: array<vec4<u32>, 4>, none: u32 }\n@group(3) @binding(0) var<uniform> ng_h: H;')
  refused('struct In { x: f32 }\nstruct S { @align(16) a: In, b: f32 }\n@group(0) @binding(0) var<uniform> u: S;', /starts at least 16 bytes after it/)
  refused('@group(0) @binding(0) var<storage> b: array<bool, 4>;', /cannot hold bool/)
  refused('struct S { x: u32, y: array<u32> }\n@group(0) @binding(0) var<storage> b: array<S, 2>;', /an array cannot hold|sized by its binding/)
  accepted('struct In { x: f32 }\nstruct S { a: In, b: f32 }\n@group(0) @binding(0) var<storage> u: S;')
  accepted('struct S { @align(16) @size(16) f0: vec4<f32>, @align(4) @size(12) f1: f32 }\n@group(0) @binding(0) var<uniform> u: S;')
})

test('entry points are held to their stage\'s rules', () => {
  refused('@vertex fn v() -> @location(0) vec4<f32> { return vec4<f32>(); }', /must output @builtin\(position\)/)
  refused('@vertex fn v(@builtin(position) p: vec4<f32>) -> @builtin(position) vec4<f32> { return p; }', /not a vertex input/)
  refused('@compute @workgroup_size(1) fn c(@builtin(local_invocation_id) l: vec3<i32>) { }', /is a vec3<u32>, not a vec3<i32>/)
  refused('@compute @workgroup_size(16, 16, 2) fn c() { }', /at most 256 invocations/)
  refused('@compute fn c() { }', /needs @workgroup_size/)
  refused('@compute @workgroup_size(1) fn c() { discard; }', /uses discard/)
  refused('@compute @workgroup_size(1) fn c() { let x = dpdx(1.0); }', /uses derivatives/)
  refused('fn h() -> f32 { return dpdx(1.0); }\n@vertex fn v() -> @builtin(position) vec4<f32> { return vec4<f32>(h()); }', /uses derivatives/)
  refused('@fragment fn f() { workgroupBarrier(); }', /uses a barrier/)
  refused('var<workgroup> w: u32;\n@fragment fn f() { w = 1u; }', /uses workgroup memory/)
  refused('@fragment fn f(@location(0) x: u32) { }', /must be @interpolate\(flat\)/)
  refused('@vertex fn v() -> @location(0) i32 { return 1i; }', /must output @builtin\(position\)|must be @interpolate\(flat\)/)
  refused('struct O { @builtin(position) p: vec4<f32>, @location(0) k: u32 }\n@vertex fn v() -> O { return O(vec4<f32>(), 1u); }', /must be @interpolate\(flat\)/)
  refused('@fragment fn f(@location(0) @interpolate(flat, center) x: u32) { }', /center is not a sampling for @interpolate\(flat\)/)
  refused('@fragment fn f(@location(0) x: f32, @location(0) y: f32) { }', /location 0 twice/)
  refused('@fragment fn f(x: f32) { }', /needs @location or @builtin/)
  refused('@vertex @fragment fn f() { }', /two stages/)
  accepted('@fragment fn f(@location(0) @interpolate(flat) x: u32) -> @location(0) vec4<u32> { return vec4<u32>(x); }')
  accepted('struct O { @builtin(position) @invariant p: vec4<f32>, @location(1) @interpolate(flat) k: u32, @location(2) @interpolate(linear, centroid) q: f32 }\n@vertex fn v() -> O { return O(vec4<f32>(), 1u, 0.5); }')
})

// ---------------------------------------------------------------------------------------------------
// Exact mode: WGSL as specified, its freedoms taken as interp.ts takes them

test('exact: runtime integer arithmetic wraps, and division, remainder and shifts follow WGSL\'s definitions', () => {
  const got = run(`
    let x = I(0); let y = I(1); let m = I(2); let z = I(3); let w = I(9);
    putI(0u, x + y); putI(1u, m / -1i * y); putI(2u, x / z); putI(3u, x % z); putI(4u, m % (-y)); putI(5u, -m);
    putI(6u, abs(m)); putI(7u, x * x); putU(8u, U(4) + U(4)); putU(9u, U(4) * U(4)); putU(10u, U(5) << U(6));
    putI(11u, m >> U(7)); putU(12u, U(4) >> U(8)); putI(13u, w / 2i); putI(14u, w % 2i); putU(15u, U(4) / U(3));
  `, [0x7fffffff, 1, 0x80000000, 0, 0xffffffff, 1, 33, 31, 35, -7 >>> 0])
  assert.deepEqual(got, [0x80000000, 0x80000000, 0x7fffffff, 0, 0, 0x80000000, 0x80000000, 1, 0xfffffffe, 1, 2, 0xffffffff, 0x1fffffff, -3 >>> 0, -1 >>> 0, 0xffffffff])
  const more = run(`
    let x = I(0); let u = U(1);
    putI(0u, x << 31u); putI(1u, (x << 31u) >> 31u); putU(2u, u % 0x10u); putU(3u, ~u); putI(4u, ~x); putU(5u, u - 0x8u);
    putI(6u, sign(I(2))); putI(7u, sign(x - x)); putI(8u, max(I(2), x)); putU(9u, min(u, 3u)); putI(10u, clamp(I(3), I(4), I(5)));
    putU(11u, dot(vec3<u32>(u, u, 1u), vec3<u32>(u, 2u, 3u))); putI(12u, dot(vec2<i32>(0x7fffffffi, x), vec2<i32>(2i, 1i)));
    var c = x; c++; c--; c += 5i; c *= 2i; c <<= 1u; c ^= 3i; putI(13u, c);
  `, [1, 0x87654321, -5 >>> 0, 5, 3, 1])
  assert.deepEqual(more.slice(0, 14).map((u) => u | 0), [
    -0x80000000, -1, 1, ~0x87654321, -2, (0x87654321 - 8) | 0, -1, 0, 1, 3, 1,
    (Math.imul(0x87654321, 0x87654321) + Math.imul(0x87654321, 2) + 3) | 0, (Math.imul(0x7fffffff, 2) + 1) | 0, (((1 + 5) * 2) << 1) ^ 3,
  ])
})

test('exact: f32 operations round once each to nearest even, keep subnormals, and give IEEE infinities and NaN', () => {
  const ins = [1, 2 ** -24, 3 * 2 ** -24, f32(1.1), 3, f32(0.1), bf(1), 2 ** -126, 1e30, Infinity, 0, -0, f32(1 / 3)].map(fb)
  const got = runF(`
    putF(0u, F(0) + F(1)); putF(1u, F(0) + F(2)); putF(2u, F(3) * F(3)); putF(3u, F(0) / F(4)); putF(4u, F(5) * 3.0 + F(5));
    putF(5u, F(6) * 1.0); putF(6u, F(7) / 2.0); putF(7u, F(6) - F(6)); putF(8u, F(6) * 0.5); putF(9u, F(8) * F(8));
    putF(10u, F(8) * -F(8)); putF(11u, F(9) - F(9)); putF(12u, 0.0 * F(9)); putF(13u, F(4) / 0.0); putF(14u, F(11) * F(0));
    putF(15u, (F(3) - F(0)) * F(12) % F(5));
  `, ins)
  const tenth = f32(0.1)
  const q = f32(f32(f32(1.1) - 1) * f32(1 / 3))
  sameF32(got, [
    1, f32(1 + 3 * 2 ** -24), f32(f32(1.1) * f32(1.1)), f32(1 / 3), f32(f32(tenth * 3) + tenth),
    bf(1), 2 ** -127, 0, 0, Infinity, -Infinity, NaN, NaN, Infinity, -0,
    f32(q - f32(tenth * Math.trunc(f32(q / tenth)))),
  ])
  assert.equal(fb(got[6]), 0x00400000, 'a subnormal result is kept')
})

test('exact: rounding builtins, fract written as x - floor(x), and the f32 to integer conversions WGSL defines', () => {
  const ins = [2.5, -2.5, 3.5, 0.5, -0.5, 1.5, -1e-10, 1.25, -1.75, -0].map((x) => fb(f32(x)))
  const r = runF(`
    putF(0u, round(F(0))); putF(1u, round(F(1))); putF(2u, round(F(2))); putF(3u, round(F(3))); putF(4u, round(F(4))); putF(5u, round(F(5)));
    putF(6u, fract(F(6))); putF(7u, fract(F(7))); putF(8u, fract(F(8))); putF(9u, floor(F(8))); putF(10u, ceil(F(8))); putF(11u, trunc(F(8)));
    putF(12u, ceil(F(4))); putF(13u, sign(F(9))); putF(14u, abs(F(9))); putF(15u, -F(9));
  `, ins)
  sameF32(r, [2, -2, 4, 0, -0, 2, 1, 0.25, 0.25, -2, -1, -1, -0, 0, 0, 0])
  const convIns = [3e9, -3e9, -1, 5e9, NaN, -1.5, 2147483648, 4294967040, -0.5].map((x) => fb(f32(x)))
  const c = run(`
    putI(0u, i32(F(0))); putI(1u, i32(F(1))); putU(2u, u32(F(2))); putU(3u, u32(F(3))); putI(4u, i32(F(4))); putU(5u, u32(F(4)));
    putI(6u, i32(F(5))); putI(7u, i32(F(6))); putU(8u, u32(F(7))); putU(9u, u32(F(8))); putB(10u, bool(F(4))); putB(11u, bool(-F(8) * 0.0));
    putF(12u, f32(I(9))); putF(13u, f32(I(10))); putF(14u, f32(U(11))); putI(15u, i32(U(11)));
  `, [...convIns, 16777217, 16777219, 0xffffffff])
  assert.deepEqual(c.map((u, i) => (i === 12 || i === 13 || i === 14 ? bf(u) : u)), [
    2147483520, 0x80000000, 0, 4294967040, 0, 0, -1 >>> 0, 2147483520, 4294967040, 0, 1, 0, 16777216, 16777220, 4294967296, 0xffffffff,
  ])
})

test('exact: min, max, clamp, step and comparisons with NaN and signed zeros, as interp.ts pins them', () => {
  const ins = [NaN, 1, -0, 0, 5, 3, 0.5].map(fb)
  const r = run(`
    putF(0u, min(F(0), F(1))); putF(1u, min(F(1), F(0))); putF(2u, max(F(0), F(1))); putF(3u, max(F(1), F(0)));
    putF(4u, min(F(2), F(3))); putF(5u, min(F(3), F(2))); putF(6u, max(F(2), F(3))); putF(7u, clamp(F(0), 0.0, 1.0));
    putF(8u, clamp(F(4), F(5), F(1))); putF(9u, saturate(F(2))); putF(10u, saturate(F(0))); putF(11u, step(F(1), F(0)));
    putF(12u, step(F(1), F(1))); putF(13u, clamp(F(6), F(0), F(1)));
    putU(14u, select(0u, 1u, F(0) < F(1)) | select(0u, 2u, F(0) == F(0)) | select(0u, 4u, F(0) != F(0)) | select(0u, 8u, F(2) == F(3)) | select(0u, 16u, F(2) < F(3)) | select(0u, 32u, F(0) >= F(0)));
    putU(15u, select(0u, 1u, all(vec2<f32>(F(0), F(1)) != vec2<f32>(F(0), F(1)))) | select(0u, 2u, any(vec2<f32>(F(0), F(1)) == vec2<f32>(F(0), F(1)))));
  `, ins)
  sameF32(r.slice(0, 14).map(bf), [1, 1, 1, 1, -0, 0, -0, 0, 1, -0, 0, 0, 1, 0.5])
  assert.equal(r[14], 4 | 8)
  assert.equal(r[15], 2)
  // Integer clamp with low above high is min(max(x, low), high) at run time.
  assert.deepEqual(run('putI(0u, clamp(I(0), I(1), I(2))); putU(1u, clamp(U(0), U(1), U(2))); putI(2u, select(I(1), I(2), vec2<bool>(true, false).x));', [5, 3, 1]).slice(0, 3), [1, 1, 1])
})

test('exact: the integer bit functions', () => {
  const r = run(`
    putU(0u, countOneBits(U(0))); putU(1u, reverseBits(U(1))); putU(2u, firstLeadingBit(U(2))); putI(3u, firstLeadingBit(I(3)));
    putI(4u, firstLeadingBit(I(4))); putI(5u, firstLeadingBit(I(5))); putU(6u, firstTrailingBit(U(2))); putU(7u, firstTrailingBit(U(6)));
    putI(8u, extractBits(I(7), 4u, 4u)); putU(9u, extractBits(U(7), 4u, 4u)); putU(10u, extractBits(U(0), U(8), U(9)));
    putU(11u, insertBits(U(2), U(10), 4u, 4u)); putU(12u, insertBits(U(10), 0u, U(8), U(9))); putI(13u, extractBits(I(3), 0u, 32u));
    putU(14u, countLeadingZeros(U(6)) + countTrailingZeros(U(6)) * 100u); putU(15u, extractBits(U(0), 3u, 0u));
  `, [0xf0f0, 1, 0, -1 >>> 0, -2 >>> 0, 0x10, 8, 0xf0, 30, 4, 0xffffffff])
  assert.deepEqual(r, [8, 0x80000000, 0xffffffff, 0xffffffff, 0, 4, 0xffffffff, 3, 0xffffffff, 15, 0xf0f0 >>> 30, 0xf0, 0x3fffffff, 0xffffffff, 28 + 300, 0])
})

test('exact: fma rounds once, a product and an add round twice (no contraction), even across let names', () => {
  const a = 1 + 2 ** -12
  const r = runF('let x = F(0); let p = x * x; putF(0u, fma(x, x, -1.0)); putF(1u, x * x - 1.0); putF(2u, p - 1.0); putF(3u, mix(F(1), F(2), F(3)));', [a, 1, 3, 0.25].map(fb))
  sameF32(r.slice(0, 4), [2 ** -11 + 2 ** -24, 2 ** -11, 2 ** -11, f32(f32(1 * f32(1 - 0.25)) + f32(3 * 0.25))])
})

test('exact: dot, cross, length, normalize, distance, determinant, transpose and the grid products', () => {
  const v = [1, 1e8, -1e8, 3, 4, 5, 6, 1e20, 2, 7].map((x) => fb(f32(x)))
  const r = runF(`
    putF(0u, dot(vec3<f32>(F(0), F(1), F(2)), vec3<f32>(1.0)));
    let c = cross(vec3<f32>(F(0), F(8), F(3)), vec3<f32>(F(4), F(5), F(6)));
    putF(1u, c.x); putF(2u, c.y); putF(3u, c.z);
    putF(4u, length(vec2<f32>(F(3), F(4)))); putF(5u, length(vec2<f32>(F(7), F(7))));
    let n = normalize(vec2<f32>(F(3), F(4))); putF(6u, n.x); putF(7u, n.y);
    putF(8u, normalize(vec2<f32>(F(0) - F(0))).x); putF(9u, distance(vec2<f32>(F(0), F(8)), vec2<f32>(F(4), F(6))));
    let m = mat2x2<f32>(F(0), F(8), F(3), F(4));
    putF(10u, determinant(m)); putF(11u, determinant(mat3x3<f32>(F(8), 0.0, 0.0, 0.0, F(3), 0.0, 0.0, 0.0, F(4))));
    let mv = m * vec2<f32>(F(5), F(6)); let vm = vec2<f32>(F(5), F(6)) * m; let mm = m * m;
    putF(12u, mv.x * 100.0 + mv.y); putF(13u, vm.x * 100.0 + vm.y); putF(14u, mm[0].x * 100.0 + mm[1].y);
    let t = transpose(mat2x3<f32>(F(0), F(8), F(3), F(4), F(5), F(6))); putF(15u, t[2].x * 10.0 + t[2].y + (m + m * 2.0)[1].x);
  `, v)
  const e20 = f32(1e20)
  sameF32(r, [
    0, -3, 6, -3, 5, f32(Math.sqrt(2 * e20 * e20)), f32(3 / 5), f32(4 / 5), NaN, 5,
    -2, 24, 23 * 100 + 34, 17 * 100 + 39, 7 * 100 + 22, 3 * 10 + 6 + 9,
  ])
})

test('exact: control flow, switch, loops with continuing, user functions and per-invocation private variables', () => {
  const decls = `
    var<private> seen: u32 = 7u;
    fn firstAbove(x: u32) -> u32 {
      for (var i = 0u; i < 100u; i++) { if (i * i > x) { return i; } }
      return 100u;
    }
    fn bump() -> u32 { seen += 1u; return seen; }
    fn classify(x: i32) -> i32 {
      switch x {
        case 0i: { return 10i; }
        case 1i, 2i, default: { if (x > 50i) { break; } return 20i; }
        case 3i: { return 30i; }
      }
      return 40i;
    }`
  const r = run(`
    var total = 0u;
    var i = 0u;
    loop {
      i++;
      if (i % 2u == 0u) { continue; }
      total += i;
      continuing { break if i >= 9u; }
    }
    putU(0u, total);
    var w = 0u;
    while (w < 5u) { w += 2u; }
    putU(1u, w);
    var nested = 0u;
    for (var a1 = 0u; a1 < 4u; a1++) {
      for (var b1 = 0u; b1 < 4u; b1++) {
        if (b1 > a1) { break; }
        var fresh = 1u;
        fresh += b1;
        nested += fresh;
      }
    }
    putU(2u, nested);
    putU(3u, firstAbove(U(0)));
    putU(4u, bump() + bump());
    putI(5u, classify(0i) + classify(2i) * 10i + classify(3i) * 100i + classify(99i) * 1000i + classify(-4i) * 10000i);
    var k = 0u;
    loop { if (k >= U(1)) { break; } k += 1u; }
    putU(6u, k);
    putB(7u, (U(0) > 3u) && (100u / U(2) > 1u));
    var arr: array<vec2<u32>, 3>;
    arr[1].y = 5u; arr[2] = arr[1] + vec2<u32>(1u); putU(8u, arr[2].x * 10u + arr[2].y);
    var s = SS(1u, vec3<f32>(1.0, 2.0, 3.0)); s.v.z = 9.0; let s2 = s; s.v.z = 1.0; putF(9u, s2.v.z);
  `, [10, 6, 0], EXACT_RUN, `${decls}\nstruct SS { k: u32, v: vec3<f32> }`)
  // 1 + 3 + 5 + 7 + 9; w ends at 6; nested sums b1 + 1 over b1 <= a1; 4 * 4 > 10; seen is 7 per invocation;
  // 100u / 0u is 100u at run time.
  assert.deepEqual(r.slice(0, 10), [25, 6, 1 + (1 + 2) + (1 + 2 + 3) + (1 + 2 + 3 + 4), 4, 8 + 9, 10 + 200 + 3000 + 40000 + 200000, 6, 1, 16, fb(9)])
  // The right side of && and || runs only where the left leaves the answer open.
  const sc = run('let t = (U(0) > 3u) || (bump() > 0u); let f = (U(0) > 30u) && (bump() > 0u); putU(0u, seen); putB(1u, t); putB(2u, f);', [10], EXACT_RUN, decls)
  assert.deepEqual(sc.slice(0, 3), [7, 1, 0])
})

test('exact: reads outside an array, vector or buffer are clamped, as interp.ts clamps them, and counted', () => {
  const src = `
    var arr = array<u32, 4>(10u, 11u, 12u, 13u);
    let v = vec3<u32>(20u, 21u, 22u);
    putU(0u, arr[U(0)]); putU(1u, arr[I(1)]); putU(2u, v[U(0)]); putU(3u, a[U(2)]); putU(4u, v[I(1)]);
    arr[U(0)] = 99u; putU(5u, arr[3]); o[U(2)] = 77u;
  `
  const p = new Program(kernel(src), EXACT_RUN)
  const out = new Uint8Array(64)
  p.dispatch([1, 1, 1], { '0:0': { bytes: wordsOf([7, -1 >>> 0, 1000]) }, '0:1': { bytes: out } })
  assert.deepEqual(wordsIn(out).slice(0, 6), [13, 10, 22, 1000, 20, 99])
  assert.equal(wordsIn(out)[15], 77, 'a store past the end lands on the last element')
  assert.equal(p.oob, 7)
})

test('exact: compute builtins, workgroup memory and barriers; a non-uniform barrier and a spent budget stop the run', () => {
  const src = `
    @group(0) @binding(1) var<storage, read_write> o: array<u32>;
    var<workgroup> w: array<u32, 8>;
    @compute @workgroup_size(4, 2, 1)
    fn main(@builtin(local_invocation_index) li: u32, @builtin(global_invocation_id) g: vec3<u32>, @builtin(workgroup_id) wg: vec3<u32>,
            @builtin(num_workgroups) nw: vec3<u32>, @builtin(local_invocation_id) l: vec3<u32>) {
      w[li] = li * li + wg.x * 100u;
      workgroupBarrier();
      let at = (g.y * 8u + g.x) * 2u;
      o[at] = w[7u - li];
      o[at + 1u] = l.x + l.y * 10u + nw.x * 100u + wg.x * 1000u;
    }`
  const p = new Program(src, EXACT_RUN)
  const out = new Uint8Array(4 * 32)
  p.dispatch([2, 1, 1], { '0:1': { bytes: out } })
  const got = wordsIn(out)
  for (let gx = 0; gx < 8; gx++) {
    for (let gy = 0; gy < 2; gy++) {
      const wg = gx >> 2
      const li = (gx & 3) + 4 * gy
      const at = (gy * 8 + gx) * 2
      assert.equal(got[at], (7 - li) * (7 - li) + wg * 100, `invocation (${gx}, ${gy})`)
      assert.equal(got[at + 1], (gx & 3) + gy * 10 + 200 + wg * 1000)
    }
  }
  const bad = new Program(src.replace('workgroupBarrier();', 'if (li < 2u) { workgroupBarrier(); }'), EXACT_RUN)
  assert.throws(() => bad.dispatch([1, 1, 1], { '0:1': { bytes: out } }), /only some invocations/)
  const spin = new Program(kernel('loop { if (U(0) == 7u) { break; } }'), { mode: 'exact', budget: 1000 })
  assert.throws(() => spin.dispatch([1, 1, 1], { '0:0': { bytes: wordsOf([0]) }, '0:1': { bytes: out } }), /budget of 1000 steps/)
  // Waves of four without workgroup memory: every invocation of a 3 x 3 group still runs once.
  const all = new Program('@group(0) @binding(1) var<storage, read_write> o: array<u32>;\n@compute @workgroup_size(3, 3) fn main(@builtin(local_invocation_index) li: u32) { o[li] = li + 1u; }', EXACT_RUN)
  const nine = new Uint8Array(40)
  all.dispatch([1, 1, 1], { '0:1': { bytes: nine } })
  assert.deepEqual(wordsIn(nine), [1, 2, 3, 4, 5, 6, 7, 8, 9, 0])
})

// ---------------------------------------------------------------------------------------------------
// Adversarial mode: every freedom WGSL leaves, taken the wrong way

/** Adversarial with only the freedom `f` taken. */
const only = (f: Freedom): RunOptions => ({ mode: 'adversarial', except: FREEDOMS.filter((g) => g !== f) })
const P = POISON_F32
const PB = POISON_BITS

/** A compute kernel compiled once and run on many inputs; returns the 16 words of `o` for each run. */
function compiled(body: string, options: RunOptions, decls = ''): (inputs: readonly number[]) => number[] {
  const p = new Program(kernel(body, decls), options)
  return (inputs) => {
    const out = new Uint8Array(64)
    p.dispatch([1, 1, 1], { '0:0': { bytes: wordsOf(inputs) }, '0:1': { bytes: out } })
    return wordsIn(out)
  }
}

/** Per freedom a kernel, its inputs, the words exact mode gives, and the words that freedom alone gives (f32 unless `words`). */
interface FreedomCase {
  readonly f: Freedom
  readonly body: string
  readonly ins: readonly number[]
  readonly exact: readonly number[]
  readonly alone: readonly number[]
  readonly words?: boolean
}
const a12 = 1 + 2 ** -12
const FREEDOM_CASES: readonly FreedomCase[] = [
  {
    f: 'minmax-nan', body: 'putF(0u, min(F(0), F(1))); putF(1u, max(F(1), F(0))); putF(2u, clamp(F(0), 0.0, 1.0));',
    ins: [NAN_BITS, fb(1)], exact: [1, 1, 0], alone: [NaN, NaN, NaN],
  },
  { f: 'clamp-median', body: 'putF(0u, clamp(F(0), F(1), F(2)));', ins: [5, 3, 1].map(fb), exact: [1], alone: [3] },
  {
    f: 'compare-nan', body: 'putF(0u, select(0.0, 1.0, F(0) < F(1))); putF(1u, select(0.0, 1.0, F(0) == F(0))); putF(2u, step(F(1), F(0)));',
    ins: [NAN_BITS, fb(1)], exact: [0, 0, 0], alone: [1, 1, 1],
  },
  {
    f: 'finite', body: 'putF(0u, F(0) + 1.0); putF(1u, F(1) * F(1)); putF(2u, F(0) - F(0)); putF(3u, sqrt(F(2)));',
    ins: [INF_BITS, fb(1e30), fb(-1)], exact: [Infinity, Infinity, NaN, NaN], alone: [P, P, P, P],
  },
  {
    f: 'zero-sign', body: 'putF(0u, F(0) - F(0)); putF(1u, F(1) * F(0)); putF(2u, -F(1));',
    ins: [fb(1), NEG_ZERO_BITS], exact: [0, -0, 0], alone: [-0, 0, -0],
  },
  {
    f: 'rounding', body: 'putF(0u, F(0) + F(1)); putF(1u, f32(I(2))); putF(2u, F(3) * F(3)); putF(3u, F(0) / F(4));',
    ins: [fb(1), fb(2 ** -24), 16777217, fb(a12), fb(3)],
    exact: [1, 16777216, 1 + 2 ** -11, f32(1 / 3)],
    alone: [1 + 2 ** -23, 16777218, 1 + 2 ** -11 + 2 ** -23, stepF32(f32(1 / 3), -1)],
  },
  {
    f: 'flush', body: 'putF(0u, F(0) * 1.0); putU(1u, bitcast<u32>(F(0))); putF(2u, F(1) / 4.0);',
    ins: [1, fb(2 ** -125)], exact: [bf(1), bf(1), 2 ** -127], alone: [0, 0, 0],
  },
  {
    f: 'contract',
    body: 'let x = F(0); let p = x * x; putF(0u, x * x - 1.0); putF(1u, p - 1.0); putF(2u, fma(x, x, -1.0)); putF(3u, mix(F(1), F(2), F(3)));',
    ins: [fb(a12), fb(1), fb(3), fb(f32(0.1))],
    exact: [2 ** -11, 2 ** -11, 2 ** -11 + 2 ** -24, f32(f32(f32(1 - f32(0.1))) + f32(3 * f32(0.1)))],
    alone: [2 ** -11 + 2 ** -24, 2 ** -11 + 2 ** -24, 2 ** -11, fused(3, f32(0.1), f32(1 - f32(0.1)))],
  },
  {
    f: 'reassociate',
    body: 'putF(0u, dot(vec3<f32>(F(0), F(1), F(2)), vec3<f32>(1.0))); putF(1u, (mat2x2<f32>(F(3), 0.0, -1.0, 0.0) * vec2<f32>(F(3), 1.0)).x);',
    ins: [1, 1e8, -1e8, a12].map(fb), exact: [0, 2 ** -11], alone: [1, 2 ** -11 + 2 ** -24],
  },
  {
    f: 'convert', body: 'putI(0u, i32(F(0))); putI(1u, i32(F(1))); putU(2u, u32(F(2))); putF(3u, f32(I(3)));',
    ins: [fb(3e9), NAN_BITS, fb(-1), 16777219], exact: [2147483520, 0, 0, fb(16777220)], alone: [PB, PB, PB, fb(16777218)], words: true,
  },
  {
    f: 'division', body: 'putF(0u, F(0) / F(1)); putF(1u, F(0) / F(2));',
    ins: [fb(1), fb(3), fb(2 ** 127)], exact: [f32(1 / 3), 2 ** -127], alone: [towardZero(f32(1 / 3), 2), P],
  },
  {
    f: 'library', body: 'putF(0u, sqrt(F(0))); putF(1u, sqrt(F(1))); putF(2u, determinant(mat2x2<f32>(F(0), 0.0, 0.0, F(0)))); putF(3u, log(F(1)));',
    // sqrt is 1.0 / inverseSqrt(x), inverseSqrt a step off (within its 2 ULP), the division exact here.
    ins: [fb(4), fb(-1)], exact: [2, NaN, 16, NaN], alone: [f32(1 / towardZero(0.5, 1)), P, P, P],
  },
  { f: 'fract', body: 'putF(0u, fract(F(0))); putF(1u, fract(F(1)));', ins: [fb(-1e-10), fb(1.25)], exact: [1, 0.25], alone: [bf(0x3f7fffff), 0.25] },
  { f: 'sign-nan', body: 'putF(0u, sign(F(0))); putF(1u, sign(F(1)));', ins: [NAN_BITS, fb(-2)], exact: [0, -1], alone: [1, -1] },
  {
    f: 'oob',
    body: 'var arr = array<u32, 4>(10u, 11u, 12u, 13u); putU(0u, arr[U(0)]); let v = vec2<u32>(1u, 2u); putU(1u, v[U(0)]); arr[U(0)] = 5u; '
      + 'putU(2u, arr[0]); putU(3u, a[U(0)]);',
    ins: [9], exact: [13, 2, 10, 9], alone: [PB, PB, 5, PB], words: true,
  },
]

test('adversarial: each freedom, taken alone, changes a result exact mode pins, and `except` turns it back', () => {
  const seen = new Set<Freedom>()
  for (const c of FREEDOM_CASES) {
    seen.add(c.f)
    const n = c.exact.length
    const check = (got: number[], want: readonly number[], what: string): void => {
      if (c.words === true) assert.deepEqual(got.slice(0, n), want, `${c.f}: ${what}`)
      else sameF32(got.slice(0, n).map(bf), want, `${c.f}: ${what}`)
    }
    check(run(c.body, c.ins, EXACT_RUN), c.exact, 'exact')
    check(run(c.body, c.ins, only(c.f)), c.alone, 'alone')
    check(run(c.body, c.ins, { mode: 'adversarial', except: FREEDOMS }), c.exact, 'every freedom excepted')
    assert.notDeepEqual(run(c.body, c.ins, ADVERSARIAL).slice(0, n), run(c.body, c.ins, EXACT_RUN).slice(0, n), `${c.f}: adversarial`)
  }
  // helper-stores, sample-nan and derivatives need a quad or an image: their tests are below.
  assert.deepEqual(FREEDOMS.filter((f) => !seen.has(f)), ['helper-stores', 'sample-nan', 'derivatives'])
})

/**
 * The emulation helpers as the design's section 11.6 writes them. wgsl.ts prints bit-tested forms instead, which lean on
 * no freedom (the differential at the end of this file pins them); these tests show where the design's text leans.
 */
const HELPERS = `
fn ng_nan(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) > 0x7f800000u; }
fn ng_min(a: f32, b: f32) -> f32 { return select(a, b, ng_nan(a) | (!ng_nan(b) & (b < a))); }
fn ng_max(a: f32, b: f32) -> f32 { return select(a, b, ng_nan(a) | (!ng_nan(b) & (b > a))); }
fn ng_saturate(x: f32) -> f32 {
  let m = select(0.0, x, (x >= 0.0) & !ng_nan(x));
  return select(1.0, m, m <= 1.0);
}
fn ng_step(e: f32, x: f32) -> f32 { return select(0.0, 1.0, (e <= x) & !ng_nan(e) & !ng_nan(x)); }
fn ng_sign(x: f32) -> f32 { return select(select(select(0.0, -1.0, x < 0.0), 1.0, x > 0.0), 0.0, ng_nan(x)); }
fn ng_truth(x: f32) -> bool { return (bitcast<u32>(x) & 0x7fffffffu) != 0u; }
fn ng_f2i(x: f32) -> i32 {
  let t = i32(clamp(x, -2147483648.0, 2147483520.0));
  return select(select(t, 2147483647i, x >= 2147483648.0), 0i, ng_nan(x));
}
fn ng_f2u(x: f32) -> u32 {
  let t = u32(clamp(x, 0.0, 4294967040.0));
  return select(select(t, 4294967295u, x >= 4294967296.0), 0u, ng_nan(x));
}
fn ng_i2f(i: i32) -> f32 { let lo = i & 255i; return f32(i - lo) + f32(lo); }
fn ng_u2f(u: u32) -> f32 { let lo = u & 255u; return f32(u - lo) + f32(lo); }
`
const HELPER_BODY = `
  let x = F(0); let y = F(1);
  putB(0u, ng_nan(x)); putF(1u, ng_min(x, y)); putF(2u, ng_max(x, y)); putF(3u, ng_min(ng_max(x, y), F(2)));
  putF(4u, ng_saturate(x)); putF(5u, ng_step(x, y)); putF(6u, ng_sign(x)); putB(7u, ng_truth(x));
  putI(8u, ng_f2i(x)); putU(9u, ng_f2u(x)); putF(10u, ng_i2f(I(3))); putF(11u, ng_u2f(U(3)));
`
const SPECIAL_F32 = [NAN_BITS, 0xffc00001, 0x7f800001, INF_BITS, 0xff800000, 0, NEG_ZERO_BITS, fb(1), fb(-1), fb(0.5), fb(1.5), fb(-0.25),
  fb(2147483520), fb(2147483648), fb(-2147483648), fb(-2147483904), fb(4294967040), fb(4294967296), fb(3e9), fb(-3e9), fb(1e30), fb(-1e30), fb(3.4028234663852886e38)]
const SUBNORMAL_F32 = [1, 0x80000001, 0x007fffff, 0x807fffff]

test('the design\'s helpers give the same bits in both modes over special inputs, except where they lean on a freedom', () => {
  const exact = compiled(HELPER_BODY, EXACT_RUN, HELPERS)
  const adversarial = compiled(HELPER_BODY, ADVERSARIAL, HELPERS)
  const noFlush = compiled(HELPER_BODY, { mode: 'adversarial', except: ['flush'] }, HELPERS)
  // Words 0 to 9 are the f32 helpers; 10 and 11 are ng_i2f and ng_u2f, kept apart below.
  const lean: string[] = []
  for (const x of SPECIAL_F32) {
    for (const y of [NAN_BITS, 0, NEG_ZERO_BITS, fb(1), fb(-1), INF_BITS]) {
      const ins = [x, y, fb(1), 7]
      const e = exact(ins).slice(0, 10)
      const v = adversarial(ins).slice(0, 10)
      e.forEach((w, i) => {
        if (v[i] !== w) lean.push(`${i}:${bf(x)}`)
      })
    }
  }
  // ng_f2i and ng_f2u of -inf clamp an infinity natively, which WGSL's finite math assumption leaves indeterminate.
  assert.deepEqual([...new Set(lean)].sort(), ['8:-Infinity', '9:-Infinity'])
  // Subnormal inputs agree once bit casts may not flush (WGSL lets a bit cast flush, so ng_nan and ng_truth may see 0).
  for (const x of SUBNORMAL_F32) {
    const ins = [x, fb(1), fb(1), 7]
    assert.deepEqual(noFlush(ins).slice(0, 10), exact(ins).slice(0, 10), `subnormal ${x}`)
  }
  assert.notDeepEqual(adversarial([1, fb(1), fb(1), 7]).slice(7, 8), exact([1, fb(1), fb(1), 7]).slice(7, 8), 'ng_truth of a flushed subnormal')
})

test('ng_i2f and ng_u2f round to nearest even only if the GPU\'s add does: WGSL names no rounding mode', () => {
  const ints = [0, 1, -1, 255, 256, 16777217, 16777219, 0x7fffffff, 0x80000000, 0x7fffff81, 0xffffff7f, 123456789]
  const exact = compiled(HELPER_BODY, EXACT_RUN, HELPERS)
  const adversarial = compiled(HELPER_BODY, ADVERSARIAL, HELPERS)
  const steady = compiled(HELPER_BODY, { mode: 'adversarial', except: ['rounding', 'zero-sign'] }, HELPERS)
  let rounded = 0
  for (const i of ints) {
    const ins = [fb(1), fb(1), fb(1), i >>> 0]
    const e = exact(ins)
    assert.equal(bf(e[10]), f32(i | 0), `ng_i2f(${i | 0}) is the nearest-even f32`)
    assert.equal(bf(e[11]), f32(i >>> 0), `ng_u2f(${i >>> 0}) is the nearest-even f32`)
    assert.deepEqual(steady(ins).slice(10, 12), e.slice(10, 12), `${i}: with a nearest-even add and signed zeros kept`)
    if (adversarial(ins)[10] !== e[10]) rounded++
  }
  // Inexact sums take the other neighbour, and 0 + 0 may come out as -0.
  assert.ok(rounded >= 5, `${rounded} of ${ints.length} differ under adversarial rounding`)
  assert.equal(adversarial([fb(1), fb(1), fb(1), 0])[10], NEG_ZERO_BITS)
})

test('adversarial library results stay within WGSL\'s accuracy table of the correctly rounded ones', () => {
  const body = `
    putF(0u, sqrt(F(0))); putF(1u, inverseSqrt(F(0))); putF(2u, exp(F(1))); putF(3u, exp2(F(1))); putF(4u, log(F(2))); putF(5u, log2(F(0)));
    putF(6u, sin(F(1))); putF(7u, cos(F(1))); putF(8u, atan2(F(1), F(0))); putF(9u, pow(F(0), F(1))); putF(10u, F(1) / F(0));
    putF(11u, length(vec2<f32>(F(0), F(1)))); putF(12u, tan(F(1))); putF(13u, asin(F(3))); putF(14u, atan(F(0))); putF(15u, tanh(F(1)));`
  const ins = [2, 0.75, 1.5, 0.5].map((x) => fb(f32(x)))
  const e = run(body, ins, EXACT_RUN).map(bf)
  const v = run(body, ins, only('library')).map(bf)
  const ulp = (x: number): number => Math.abs(stepF32(f32(x), 1) - f32(x))
  const within = (i: number, bound: number, what: string): void => assert.ok(Math.abs(v[i] - e[i]) <= bound, `${what}: ${v[i]} against ${e[i]}, bound ${bound}`)
  within(0, 4.5 * ulp(e[0]), 'sqrt')
  within(1, 2 * ulp(e[1]), 'inverseSqrt')
  within(2, (3 + 2 * 0.75) * ulp(e[2]), 'exp')
  within(3, (3 + 2 * 0.75) * ulp(e[3]), 'exp2')
  within(4, 2 ** -21, 'log near 1')
  within(5, 2 ** -21, 'log2 near 1')
  within(6, 2 ** -11, 'sin')
  within(7, 2 ** -11, 'cos')
  within(8, 4096 * ulp(e[8]), 'atan2')
  within(13, 6.81e-5, 'asin')
  within(14, 4096 * ulp(e[14]), 'atan')
  within(15, 1e-5, 'tanh')
  for (let i = 0; i < 16; i++) assert.ok(Number.isFinite(v[i]), `result ${i} is finite`)
  assert.notDeepEqual(v.map(fb), e.map(fb))
})

// ---------------------------------------------------------------------------------------------------
// Images: textures, samplers and storage textures through texture.ts

const IMAGE_DECLS = `
@group(1) @binding(0) var t: texture_2d<f32>;
@group(1) @binding(1) var ta: texture_2d_array<f32>;
@group(1) @binding(2) var tu: texture_2d<u32>;
@group(1) @binding(3) var ti: texture_2d<i32>;
@group(1) @binding(4) var td: texture_depth_2d;
@group(1) @binding(5) var ts: texture_storage_2d<r32float, write>;
@group(1) @binding(6) var s: sampler;
@group(1) @binding(7) var tsc: texture_storage_2d<rgba8unorm, write>;
`
/** The images IMAGE_DECLS binds: each texel's value says where it is. */
function imageSet(): { [key: string]: Resource } {
  const t = imageOf('rgba8', 4, 2, (x, y, _k, q) => (x + 4 * y + 16 * q) / 255, 1, 2)
  const ta = imageOf('rgba8', 2, 1, (x, _y, k) => (10 * k + x) / 255, 3)
  const tu = imageOf('r32u', 4, 2, (x, y) => 1000 + x + 10 * y)
  const ti = imageOf('r32i', 4, 2, (x, y) => -(x + 10 * y) - 1)
  const td = imageOf('depth32f', 4, 2, (x) => x / 4)
  const ts = new ImageStore({ format: 'r32f', width: 2, height: 2, layers: 1, levels: 1, samples: 1 })
  const tsc = new ImageStore({ format: 'rgba8', width: 2, height: 2, layers: 1, levels: 1, samples: 1 })
  const bind = (store: ImageStore): ImageBinding => ({ store, view: viewOf(store) })
  return { '1:0': bind(t), '1:1': bind(ta), '1:2': bind(tu), '1:3': bind(ti), '1:4': bind(td), '1:5': bind(ts), '1:6': { sampler: LINEAR }, '1:7': bind(tsc) }
}
/** What texture.ts's load gives, as f32 (the reference the shader's textureLoad must match). */
function loaded(r: Resource, x: number, y: number, layer: number, level: number): number[] {
  const { store, view } = r as ImageBinding
  const out = [0, 0, 0, 0]
  load(store, view, x, y, layer, level, out)
  return out.map(f32)
}
/** Runs `body` (with IMAGE_DECLS) on `res`; returns o's words and the program. */
function runImages(body: string, inputs: readonly number[], options: RunOptions, res: { [key: string]: Resource }): { words: number[]; p: Program } {
  const p = new Program(kernel(body, IMAGE_DECLS), options)
  const out = new Uint8Array(64)
  p.dispatch([1, 1, 1], { ...res, '0:0': { bytes: wordsOf(inputs) }, '0:1': { bytes: out } })
  return { words: wordsIn(out), p }
}

const LOADS = `
  let p = vec2<i32>(I(0), I(1));
  let c = textureLoad(t, p, I(2)); putF(0u, c.x); putF(1u, c.w);
  let d = textureDimensions(t, U(3)); putU(2u, d.x * 100u + d.y);
  putU(3u, textureNumLevels(t) * 10u + textureNumLayers(ta));
  putF(4u, textureLoad(ta, vec2<u32>(U(4), 0u), I(5), 0i).x);
  let q = textureLoad(tu, p, 0i); putU(5u, q.x); putU(6u, q.w);
  putI(7u, textureLoad(ti, p, 0u).x);
  putF(8u, textureLoad(td, p, 0i));
  let d0 = textureDimensions(t); putU(9u, d0.x * 100u + d0.y);
  let dl = textureDimensions(t, I(2)); putU(10u, dl.x * 100u + dl.y);
`

test('images: textureLoad, textureDimensions, textureNumLevels and textureNumLayers read through texture.ts', () => {
  const res = imageSet()
  const inside = runImages(LOADS, [1, 1, 0, 1, 1, 2], EXACT_RUN, res)
  const w = inside.words
  assert.deepEqual([bf(w[0]), bf(w[1])], [loaded(res['1:0'], 1, 1, 0, 0)[0], loaded(res['1:0'], 1, 1, 0, 0)[3]])
  assert.equal(bf(w[0]), f32(5 / 255))
  assert.equal(w[2], 201, 'level 1 of a 4 x 2 image is 2 x 1')
  assert.equal(w[3], 23)
  assert.equal(bf(w[4]), f32(21 / 255))
  assert.deepEqual([w[5], w[6]], [1011, loaded(res['1:2'], 1, 1, 0, 0)[3]])
  assert.equal(w[7] | 0, -12)
  assert.equal(bf(w[8]), 0.25)
  assert.deepEqual([w[9], w[10]], [402, 402])
  assert.equal(inside.p.oob, 0)
  // Level 1 of t: texel (1, 0) holds 1 + 16.
  assert.equal(bf(runImages(LOADS, [1, 0, 1, 0, 0, 0], EXACT_RUN, res).words[0]), f32(17 / 255))

  // Outside: a position, a level and a layer out of range read zero (texture.ts), and the level of
  // textureDimensions is clamped; under `oob` they give poison instead.
  const outside = [4, 0, 0, 5, 1, 7]
  const e = runImages(LOADS, outside, EXACT_RUN, res)
  assert.deepEqual([e.words[0], e.words[1], e.words[2], e.words[4], e.words[5], e.words[6], e.words[7], e.words[8]], [0, 0, 201, 0, 0, 0, 0, 0])
  assert.equal(e.p.oob, 6)
  const v = runImages(LOADS, outside, only('oob'), res)
  assert.deepEqual([v.words[0], v.words[1], v.words[4], v.words[5], v.words[7], v.words[8]], [PB, PB, PB, PB, PB, PB])
  assert.equal(v.words[2], (Math.imul(PB, 100) + PB) >>> 0)
  assert.equal(runImages(LOADS, [0, 0, 2, 0, 0, 0], EXACT_RUN, res).words[0], 0, 'a level past the view reads zero')
})

test('images: textureStore writes through texture.ts; a store outside is dropped, or under `oob` writes poison at (0, 0)', () => {
  const body = `
    textureStore(ts, vec2<i32>(I(0), I(1)), vec4<f32>(F(2), 0.0, 0.0, 1.0));
    textureStore(ts, vec2<u32>(U(3), 0u), vec4<f32>(F(2) * 2.0));
    textureStore(tsc, vec2<i32>(0i, 1i), vec4<f32>(0.5, 1.5, -1.0, F(2) / 10.0));
    let d = textureDimensions(ts); putU(0u, d.x * 100u + d.y);
  `
  const ins = [1, 1, fb(2.5), 9]
  const read = (r: Resource, x: number, y: number): number[] => {
    const out = [0, 0, 0, 0]
    ;(r as ImageBinding).store.read(0, 0, x, y, 0, out)
    return out
  }
  const res = imageSet()
  const e = runImages(body, ins, EXACT_RUN, res)
  assert.equal(e.words[0], 202)
  assert.equal(read(res['1:5'], 1, 1)[0], 2.5)
  assert.equal(read(res['1:5'], 0, 0)[0], 0)
  // The rgba8 texel is converted as texture.ts's put converts it.
  const ref = new ImageStore({ format: 'rgba8', width: 2, height: 2, layers: 1, levels: 1, samples: 1 })
  put(ref, viewOf(ref), 0, 1, 0, [0.5, 1.5, -1, f32(0.25)])
  assert.deepEqual((res['1:7'] as ImageBinding).store.bytes, ref.bytes)
  assert.equal(e.p.oob, 1)
  const res2 = imageSet()
  runImages(body, ins, only('oob'), res2)
  assert.equal(read(res2['1:5'], 0, 0)[0], P)
  assert.equal(read(res2['1:5'], 1, 1)[0], 2.5)
})

test('images: textureSampleLevel is texture.ts\'s sample; a NaN coordinate or level is texture.ts\'s, or poison under sample-nan', () => {
  const t = imageOf('rgba8', 4, 4, (x, y, _k, q) => ((x * 37 + y * 11 + q * 50) % 256) / 255, 1, 3)
  const ta = imageOf('rgba8', 2, 2, (x, y, k) => (40 * k + 3 * x + y) / 255, 3)
  const res = { ...imageSet(), '1:0': { store: t, view: viewOf(t) }, '1:1': { store: ta, view: viewOf(ta) } }
  const body = `
    let c = textureSampleLevel(t, s, vec2<f32>(F(0), F(1)), F(2)); putF(0u, c.x); putF(1u, c.y); putF(2u, c.w);
    putF(3u, textureSampleLevel(ta, s, vec2<f32>(F(0), F(1)), I(3), F(2)).x);
  `
  const want = (u: number, v: number, lod: number, layer: number, store: ImageStore): number[] => {
    const out = [0, 0, 0, 0]
    sample(store, viewOf(store), LINEAR, u, v, layer, lod, out)
    return out
  }
  for (const [u, v, lod, layer] of [[0.3, 0.6, 0.5, 5], [0.9, 0.1, 1.75, -2], [-0.2, 1.4, 40, 1], [0.5, 0.5, -3, 0]]) {
    const uu = f32(u)
    const vv = f32(v)
    const ll = f32(lod)
    const got = runImages(body, [fb(uu), fb(vv), fb(ll), layer >>> 0], EXACT_RUN, res).words.map(bf)
    const c = want(uu, vv, ll, 0, t)
    assert.deepEqual(got.slice(0, 4), [c[0], c[1], c[3], want(uu, vv, ll, layer, ta)[0]], `(${u}, ${v}) at level ${lod}, layer ${layer}`)
  }
  const nanIns = [NAN_BITS, fb(0.6), NAN_BITS, 0]
  const e = runImages(body, nanIns, EXACT_RUN, res).words.map(bf)
  assert.deepEqual(e.slice(0, 2), want(NaN, f32(0.6), NaN, 0, t).slice(0, 2))
  assert.ok(e.slice(0, 4).every(Number.isFinite))
  const v = runImages(body, nanIns, only('sample-nan'), res).words
  assert.deepEqual(v.slice(0, 4), [PB, PB, PB, PB])
  // A NaN level alone, the coordinate finite: texture.ts's in exact mode, poison under sample-nan.
  const lvlIns = [fb(f32(0.3)), fb(f32(0.6)), NAN_BITS, 0]
  const el = runImages(body, lvlIns, EXACT_RUN, res).words.map(bf)
  assert.deepEqual(el.slice(0, 2), want(f32(0.3), f32(0.6), NaN, 0, t).slice(0, 2))
  assert.ok(el.slice(0, 4).every(Number.isFinite))
  assert.deepEqual(runImages(body, lvlIns, only('sample-nan'), res).words.slice(0, 4), [PB, PB, PB, PB])
})

test('images: bindings are checked as WebGPU checks them, and image builtins outside the subset are refused', () => {
  const p = new Program(kernel('putU(0u, textureNumLevels(t));', IMAGE_DECLS), EXACT_RUN)
  const base = { ...imageSet(), '0:0': { bytes: wordsOf([0]) }, '0:1': { bytes: new Uint8Array(64) } }
  const u32img = imageOf('r32u', 2, 2, () => 1)
  const layered = imageOf('rgba8', 2, 2, () => 0, 2)
  const float4 = imageOf('rgba32f', 2, 2, () => 0)
  assert.throws(() => p.dispatch([1, 1, 1], { ...base, '1:0': { store: u32img, view: viewOf(u32img) } }), /a r32u image holds uint values/)
  assert.throws(() => p.dispatch([1, 1, 1], { ...base, '1:0': { store: layered, view: viewOf(layered) } }), /a view of one layer/)
  assert.throws(() => p.dispatch([1, 1, 1], { ...base, '1:5': { store: float4, view: viewOf(float4) } }), /declared r32f, and the image is rgba32f/)
  assert.throws(() => p.dispatch([1, 1, 1], { ...base, '1:6': { bytes: new Uint8Array(4) } }), /is a sampler/)
  assert.throws(() => p.dispatch([1, 1, 1], { ...base, '0:1': { sampler: LINEAR } }), /is a buffer/)
  p.dispatch([1, 1, 1], base)

  refusedBody('let n = textureNumLayers(t);', /takes an arrayed texture/, IMAGE_DECLS)
  refusedBody('let c = textureSampleLevel(tu, s, vec2<f32>(0.5), 0.0);', /reads a texture_2d<f32>/, IMAGE_DECLS)
  refusedBody('textureStore(ts, vec2<i32>(0i), 0i, vec4<f32>());', /arrayed storage textures are outside/, IMAGE_DECLS)
  refusedBody('let c = textureLoad(ts, vec2<i32>(0i), 0i);', /needs a tex variable/, IMAGE_DECLS)
  refusedBody('let d = textureDimensions(ts, 0i);', /takes no level/, IMAGE_DECLS)
  refusedBody('let c = textureLoad(t, vec2<f32>(0.0), 0i);', /takes a vec2 of i32 or u32/, IMAGE_DECLS)
  refusedBody('let c = textureLoad(t, vec2<i32>(0i));', /takes coordinates and a level/, IMAGE_DECLS)
  refusedBody('let x = t;', /handles are outside the subset/, IMAGE_DECLS)
  refused('@group(0) @binding(0) var w: texture_storage_2d<r32float, read_write>;', /storage textures are outside the subset \(write only\)/)
  refused('@group(0) @binding(0) var w: texture_storage_2d<bgra8unorm, write>;', /not a storage format in the subset/)
  refused('@group(0) @binding(0) var w: texture_3d<f32>;', /outside the subset/)
  refused('@group(0) @binding(0) var w: texture_2d<bool>;', /samples f32, i32 or u32/)
  refused('var<private> w: sampler;', /takes no address space|cannot hold/)
  refused('fn f(x: texture_2d<f32>) { }', /parameter is outside the subset/)
})

// ---------------------------------------------------------------------------------------------------
// Quads, helper lanes and the vertex stage

const DERIVATIVES = `
struct Out { @location(0) a: vec4<f32>, @location(1) b: vec4<f32> }
@fragment fn f(@builtin(position) pos: vec4<f32>, @location(0) v: vec4<f32>) -> Out {
  let x = v.x;
  return Out(vec4<f32>(dpdx(x), dpdy(x), dpdxCoarse(x), dpdyCoarse(x)), vec4<f32>(fwidth(x), fwidthCoarse(x), dpdxFine(pos.x), dpdyFine(vec2<f32>(pos.y, x)).x));
}`

test('quads: fine and coarse differences and fwidth over a 2 x 2 quad, and the derivatives freedom swapping them', () => {
  const quad = quadAt(6, 2, (l) => [l * l, 0, 0, 0])
  const lanes = (p: Program): number[][] => p.fragment(quad, {}).map((o) => [...(o.locations[0] as number[]), ...(o.locations[1] as number[])])
  // Lane values 0, 1, 4, 9 at (0, 0), (1, 0), (0, 1), (1, 1).
  assert.deepEqual(lanes(new Program(DERIVATIVES, EXACT_RUN)), [
    [1, 4, 1, 4, 5, 5, 1, 1],
    [1, 8, 1, 4, 9, 5, 1, 1],
    [5, 4, 1, 4, 9, 5, 1, 1],
    [5, 8, 1, 4, 13, 5, 1, 1],
  ])
  assert.deepEqual(lanes(new Program(DERIVATIVES, only('derivatives'))), [
    [1, 4, 1, 4, 5, 5, 1, 1],
    [1, 4, 1, 8, 5, 9, 1, 1],
    [1, 4, 5, 4, 5, 9, 1, 1],
    [1, 4, 5, 8, 5, 13, 1, 1],
  ])
})

const DEMOTE = `
@group(0) @binding(1) var<storage, read_write> o: array<u32>;
@fragment fn f(@builtin(position) pos: vec4<f32>, @location(0) v: vec4<f32>) -> @location(0) vec4<f32> {
  let lane = u32(pos.x - 0.5) % 2u + 2u * (u32(pos.y - 0.5) % 2u);
  if (v.x > 0.5 && v.x < 1.5) { discard; }
  let d = dpdx(v.x * 2.0);
  o[lane] = bitcast<u32>(d);
  o[4u + lane] = 1u;
  return vec4<f32>(d, 0.0, 0.0, 1.0);
}`

test('quads: discard demotes a lane that runs on for its neighbours\' differences; helpers store nothing, demoted ones under helper-stores', () => {
  const quad = quadAt(0, 0, (l) => [l * l, 0, 0, 0], (l) => l === 3)
  const go = (options: RunOptions): { words: number[]; out: StageOut[] } => {
    const bytes = new Uint8Array(32)
    const out = new Program(DEMOTE, options).fragment(quad, { '0:1': { bytes } })
    return { words: wordsIn(bytes), out }
  }
  const e = go(EXACT_RUN)
  // Lane 1 (value 1) discards and lane 3 starts as a helper: both still compute, so lanes 0 and 2 see dx = 2 and 10.
  assert.deepEqual(e.out.map((o) => (o.locations[0] as number[])[0]), [2, 2, 10, 10])
  assert.deepEqual(e.out.map((o) => o.discarded), [false, true, false, false])
  assert.deepEqual(e.out.map((o) => o.helper), [false, true, false, true])
  assert.deepEqual(e.words, [fb(2), 0, fb(10), 0, 1, 0, 1, 0])
  // Under helper-stores the demoted lane 1 stores; lane 3, a helper from the start, never does.
  const v = go(only('helper-stores'))
  assert.deepEqual(v.words, [fb(2), fb(2), fb(10), 0, 1, 1, 1, 0])
})

test('quads: a texture store follows the same rule: helpers store nothing, a demoted lane stores only under helper-stores', () => {
  const src = `
    @group(1) @binding(5) var ts: texture_storage_2d<r32float, write>;
    @fragment fn f(@builtin(position) pos: vec4<f32>, @location(0) v: vec4<f32>) -> @location(0) vec4<f32> {
      let x = u32(pos.x - 0.5) % 2u;
      let y = u32(pos.y - 0.5) % 2u;
      if (v.x > 0.5 && v.x < 1.5) { discard; }
      textureStore(ts, vec2<u32>(x, y), vec4<f32>(v.x + 10.0, 0.0, 0.0, 1.0));
      return vec4<f32>(v.x);
    }`
  const quad = quadAt(0, 0, (l) => [l * l, 0, 0, 0], (l) => l === 3)
  const texels = (options: RunOptions): number[] => {
    const store = new ImageStore({ format: 'r32f', width: 2, height: 2, layers: 1, levels: 1, samples: 1 })
    new Program(src, options).fragment(quad, { '1:5': { store, view: viewOf(store) } })
    return [0, 1, 2, 3].map((l) => {
      const out = [0, 0, 0, 0]
      store.read(0, 0, l & 1, l >> 1, 0, out)
      return out[0]
    })
  }
  // Lane 1 (value 1) discards, lane 3 is a helper: neither stores in exact mode.
  assert.deepEqual(texels(EXACT_RUN), [10, 0, 14, 0])
  assert.deepEqual(texels(only('helper-stores')), [10, 11, 14, 0])
})

test('quads: a difference or implicit-level sample reached by only some lanes is a RunError (exact) or poison (derivatives)', () => {
  const src = `
    diagnostic(off, derivative_uniformity);
    @fragment fn f(@location(0) v: vec4<f32>) -> @location(0) vec4<f32> {
      var d = -1.0;
      if (v.x < 2.0) { d = dpdx(v.x); }
      return vec4<f32>(d);
    }`
  const quad = quadAt(0, 0, (l) => [l, 0, 0, 0])
  assert.throws(() => new Program(src, EXACT_RUN).fragment(quad, {}), /only some lanes of the quad/)
  const got = new Program(src, only('derivatives')).fragment(quad, {}).map((o) => (o.locations[0] as number[])[0])
  assert.deepEqual(got, [P, P, -1, -1])
  // In a called function too: the check follows the lanes that reach it.
  const called = `
    diagnostic(off, derivative_uniformity);
    fn slope(x: f32) -> f32 { return dpdy(x); }
    @fragment fn f(@location(0) v: vec4<f32>) -> @location(0) vec4<f32> {
      var d = slope(v.x);
      if (v.x > 2.5) { d = slope(v.x); }
      return vec4<f32>(d);
    }`
  assert.throws(() => new Program(called, EXACT_RUN).fragment(quad, {}), /only some lanes/)
})

test('quads: implicit-level textureSample takes its level from the quad\'s fine differences, as lodFromRates computes it', () => {
  const store = imageOf('rgba8', 8, 8, (x, y, _k, q) => ((x * 29 + y * 7 + q * 90) % 256) / 255, 1, 4)
  const src = `
    @group(1) @binding(0) var t: texture_2d<f32>;
    @group(1) @binding(6) var s: sampler;
    @fragment fn f(@location(0) uv: vec4<f32>) -> @location(0) vec4<f32> { return textureSample(t, s, uv.xy); }`
  const k = f32(0.3)
  const uvs = [0, 1, 2, 3].map((l) => [f32(0.1 + k * (l & 1)), f32(0.2 + f32(0.45) * (l >> 1))])
  const out = new Program(src, EXACT_RUN).fragment(quadAt(0, 0, (l) => [uvs[l][0], uvs[l][1], 0, 0]), { '1:0': { store, view: viewOf(store) }, '1:6': { sampler: LINEAR } })
  for (let l = 0; l < 4; l++) {
    const dudx = f32(uvs[(l & 2) + 1][0] - uvs[l & 2][0])
    const dvdx = f32(uvs[(l & 2) + 1][1] - uvs[l & 2][1])
    const dudy = f32(uvs[(l & 1) + 2][0] - uvs[l & 1][0])
    const dvdy = f32(uvs[(l & 1) + 2][1] - uvs[l & 1][1])
    const want = [0, 0, 0, 0]
    sample(store, viewOf(store), LINEAR, uvs[l][0], uvs[l][1], 0, lodFromRates(dudx, dvdx, dudy, dvdy, 8, 8), want)
    assert.deepEqual(out[l].locations[0], want, `lane ${l}`)
  }
  const lod = lodFromRates(k, 0, 0, f32(0.45), 8, 8)
  assert.ok(lod > 1 && lod < 2, 'the quad reads between levels 1 and 2')
  // Under the derivatives freedom the level comes from the coarse differences: with the bottom row's u spread wider
  // than the top row's, the bottom lanes then read another level than their fine differences give.
  const wide = uvs.map(([u, v], l) => [l === 3 ? f32(u + f32(0.9)) : u, v])
  const us = wide.map((c) => c[0])
  const vs = wide.map((c) => c[1])
  const quadWide = quadAt(0, 0, (l) => [wide[l][0], wide[l][1], 0, 0])
  const res = { '1:0': { store, view: viewOf(store) }, '1:6': { sampler: LINEAR } }
  const at = (l: number, fine: boolean): number[] => {
    const r = (v: Lanes, axis: string): number => quadDerivative(v, l, axis, fine) as number
    const want = [0, 0, 0, 0]
    sample(store, viewOf(store), LINEAR, wide[l][0], wide[l][1], 0, lodFromRates(r(us, 'dpdx'), r(vs, 'dpdx'), r(us, 'dpdy'), r(vs, 'dpdy'), 8, 8), want)
    return want
  }
  const exact = new Program(src, EXACT_RUN).fragment(quadWide, res).map((o) => o.locations[0])
  const coarse = new Program(src, only('derivatives')).fragment(quadWide, res).map((o) => o.locations[0])
  for (let l = 0; l < 4; l++) {
    assert.deepEqual(exact[l], at(l, true), `fine, lane ${l}`)
    assert.deepEqual(coarse[l], at(l, false), `coarse, lane ${l}`)
  }
  assert.notDeepEqual(exact[2], coarse[2], 'the bottom row reads another level under the freedom')
})

test('quads: textureSampleGrad takes its level from the rates it is given, as lodFromRates computes it; a rate not finite is poison under sample-nan', () => {
  const store = imageOf('rgba8', 8, 8, (x, y, _k, q) => ((x * 29 + y * 7 + q * 90) % 256) / 255, 1, 4)
  const src = `
    @group(1) @binding(0) var t: texture_2d<f32>;
    @group(1) @binding(6) var s: sampler;
    @fragment fn f(@location(0) v: vec4<f32>) -> @location(0) vec4<f32> {
      if (v.x > 0.5) { return textureSampleGrad(t, s, vec2<f32>(0.3, 0.6), vec2<f32>(v.y, 0.0), vec2<f32>(0.0, v.z)); }
      return vec4<f32>(-1.0);
    }`
  const res = { '1:0': { store, view: viewOf(store) }, '1:6': { sampler: LINEAR } }
  // Rates per lane: lane 3 takes none (it stays out of the branch, which needs no uniformity), lane 2 an infinity.
  const rates = [[0.3, 0.05], [0.01, 0.2], [Infinity, 0.1], [0.5, 0.5]]
  const quad = quadAt(0, 0, (l) => [l === 3 ? 0 : 1, rates[l][0], rates[l][1], 0])
  const want = (l: number): number[] => {
    const out = [0, 0, 0, 0]
    sample(store, viewOf(store), LINEAR, f32(0.3), f32(0.6), 0, lodFromRates(f32(rates[l][0]), 0, 0, f32(rates[l][1]), 8, 8), out)
    return out
  }
  const got = new Program(src, EXACT_RUN).fragment(quad, res).map((o) => o.locations[0])
  assert.deepEqual(got, [want(0), want(1), want(2), [-1, -1, -1, -1]])
  const odd = new Program(src, only('sample-nan')).fragment(quad, res).map((o) => o.locations[0])
  assert.deepEqual(odd, [want(0), want(1), [P, P, P, P], [-1, -1, -1, -1]])
})

test('vertex and fragment stage values: builtins, locations, structs, frag_depth, front_facing, and entry points by name', () => {
  const src = `
    struct VIn { @builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32, @location(0) p: vec2<f32>, @location(1) @interpolate(flat) k: u32 }
    struct VOut { @builtin(position) @invariant pos: vec4<f32>, @location(0) c: vec4<f32>, @location(1) @interpolate(flat) id: u32 }
    @vertex fn v(a: VIn) -> VOut {
      var o: VOut;
      o.pos = vec4<f32>(a.p, 0.0, 1.0);
      o.c = vec4<f32>(f32(a.vi), f32(a.ii), f32(a.k), 1.0);
      o.id = a.vi * 10u + a.k;
      return o;
    }
    @fragment fn depth(@builtin(front_facing) ff: bool, @builtin(position) p: vec4<f32>) -> @builtin(frag_depth) f32 { return select(p.z, 1.0 - p.z, ff); }
    @fragment fn colour(@location(0) c: vec4<f32>) -> @location(0) vec4<f32> { return c * 2.0; }`
  const p = new Program(src, EXACT_RUN)
  const vertices = Array.from({ length: 6 }, (_, i) => ({ vertex_index: i, instance_index: 3, locations: { 0: [i * 0.5, -i], 1: i * i } }))
  const out = p.vertex(vertices, {})
  assert.equal(out.length, 6)
  out.forEach((o, i) => {
    assert.deepEqual(o.builtins.position, [i * 0.5, -i, 0, 1])
    assert.deepEqual(o.locations[0], [i, 3, i * i, 1])
    assert.equal(o.locations[1], i * 10 + i * i)
  })
  const quad = [0, 1, 2, 3].map((l) => ({ position: [l + 0.5, 0.5, 0.25, 1], front_facing: l !== 2, locations: { 0: [l, 1, 2, 3] } }))
  assert.deepEqual(p.fragment(quad, {}, 'depth').map((o) => o.builtins.frag_depth), [0.75, 0.75, 0.25, 0.75])
  assert.deepEqual(p.fragment(quad, {}, 'colour').map((o) => o.locations[0]), [[0, 2, 4, 6], [2, 2, 4, 6], [4, 2, 4, 6], [6, 2, 4, 6]])
  assert.throws(() => p.fragment(quad, {}), /2 fragment entry points/)
  assert.throws(() => p.vertex([{ vertex_index: 0 }], {}), /gives no location 0/)
})

// ---------------------------------------------------------------------------------------------------
// More of the subset: the library in exact mode, 4 x 4 grids, bool vectors and template lists

test('exact: the library functions are Math\'s, rounded once to f32 (interp.ts), edges included', () => {
  const ins = [2, 0.75, -0, 0, NaN, Infinity, -Infinity, -1, 0.5, 1.5, 3, -8].map(fb)
  const r = runF(`
    putF(0u, sqrt(F(0))); putF(1u, inverseSqrt(F(0))); putF(2u, exp(F(1))); putF(3u, exp2(F(1))); putF(4u, log(F(9))); putF(5u, log2(F(10)));
    putF(6u, sin(F(1))); putF(7u, cos(F(1))); putF(8u, tan(F(1))); putF(9u, asin(F(8))); putF(10u, acos(F(8))); putF(11u, atan(F(0)));
    putF(12u, atan2(F(1), F(7))); putF(13u, sinh(F(1))); putF(14u, cosh(F(1))); putF(15u, tanh(F(1)));
  `, ins)
  sameF32(r, [Math.sqrt(2), 1 / Math.sqrt(2), Math.exp(0.75), 2 ** 0.75, Math.log(1.5), Math.log2(3), Math.sin(0.75), Math.cos(0.75), Math.tan(0.75),
    Math.asin(0.5), Math.acos(0.5), Math.atan(2), Math.atan2(0.75, -1), Math.sinh(0.75), Math.cosh(0.75), Math.tanh(0.75)].map(f32))
  const edges = runF(`
    putF(0u, sqrt(F(2))); putF(1u, sqrt(F(7))); putF(2u, inverseSqrt(F(3))); putF(3u, inverseSqrt(F(2))); putF(4u, log(F(3))); putF(5u, log2(F(2)));
    putF(6u, exp(F(6))); putF(7u, exp2(F(5))); putF(8u, sin(F(5))); putF(9u, asin(F(9))); putF(10u, atan(F(5))); putF(11u, atan2(F(3), F(2)));
    putF(12u, atan2(F(2), F(2))); putF(13u, pow(F(4), F(3))); putF(14u, pow(F(11), F(10))); putF(15u, pow(F(2), F(7)));
  `, ins)
  sameF32(edges, [-0, NaN, Infinity, -Infinity, -Infinity, -Infinity, 0, Infinity, NaN, NaN, f32(Math.PI / 2), f32(Math.PI), -f32(Math.PI), 1, -512, -Infinity])
  const shaped = runF(`
    putF(0u, smoothstep(F(0), F(1), F(2))); let rf = reflect(vec2<f32>(F(3), -F(3)), vec2<f32>(0.0, F(3))); putF(1u, rf.x); putF(2u, rf.y);
    putF(3u, smoothstep(F(0), F(0), F(2))); putF(4u, step(F(2), F(1)));`, [0, 2, 0.5, 1].map(fb))
  // smoothstep with low equal to high divides 0.5 by 0: +inf, clamped to 1.
  sameF32(shaped.slice(0, 5), [0.15625, 1, 1, 1, 1])
})

test('exact: 4 x 4 grids: products, determinant, transpose, and grid arithmetic', () => {
  const g = [2, 0, 0, 1, 0, 3, 0, 0, 0, 0, 4, 0, 1, 0, 0, 5]
  const v = [1, 2, 3, 4]
  const r = runF(`
    let m = mat4x4<f32>(F(0), F(1), F(2), F(3), F(4), F(5), F(6), F(7), F(8), F(9), F(10), F(11), F(12), F(13), F(14), F(15));
    let v = vec4<f32>(1.0, 2.0, 3.0, 4.0);
    let mv = m * v; let vm = v * m; let mm = m * m; let t = transpose(m);
    putF(0u, determinant(m)); putF(1u, mv.x); putF(2u, mv.w); putF(3u, vm.x); putF(4u, vm.w); putF(5u, mm[0].x); putF(6u, mm[3].x); putF(7u, mm[0].w);
    putF(8u, t[0].w); putF(9u, t[3].x); putF(10u, (m - m)[2].z); putF(11u, (2.0 * m)[3].w); putF(12u, mat2x4<f32>(v, v)[1].z);
    let m34 = mat3x4<f32>(v, v, v); let m43 = mat4x3<f32>(v.xyz, v.xyz, v.xyz, v.xyz); let p = m34 * m43; putF(13u, p[0].x); putF(14u, p[3].w);
  `, g.map(fb))
  // Columns: m[j][i] = g[4 j + i].
  const at = (j: number, i: number): number => g[4 * j + i]
  const mv = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].reduce((s, k) => s + at(k, i) * v[k], 0))
  const vm = [0, 1, 2, 3].map((j) => [0, 1, 2, 3].reduce((s, k) => s + v[k] * at(j, k), 0))
  const mm = (j: number, i: number): number => [0, 1, 2, 3].reduce((s, k) => s + at(k, i) * at(j, k), 0)
  sameF32(r.slice(0, 15), [108, mv[0], mv[3], vm[0], vm[3], mm(0, 0), mm(3, 0), mm(0, 3), at(3, 0), at(0, 3), 0, 2 * at(3, 3), 3, 1 * (1 + 2 + 3), 4 * (1 + 2 + 3)])
})

test('bool vectors take & | and !, select takes a vector condition, and any and all reduce them', () => {
  const r = run(`
    let p = vec3<bool>(U(0) > 0u, U(1) > 0u, true);
    let q = vec3<bool>(true, false, U(1) > 0u);
    let a1 = p & q; let o1 = p | q; let n1 = !p;
    putU(0u, select(0u, 1u, a1.x) + select(0u, 2u, a1.y) + select(0u, 4u, a1.z));
    putU(1u, select(0u, 1u, o1.x) + select(0u, 2u, o1.y) + select(0u, 4u, o1.z));
    putU(2u, select(0u, 1u, n1.x) + select(0u, 2u, n1.y) + select(0u, 4u, n1.z));
    let s = select(vec3<u32>(10u, 20u, 30u), vec3<u32>(1u, 2u, 3u), p);
    putU(3u, s.x + s.y + s.z); putB(4u, any(a1)); putB(5u, all(o1)); putB(6u, all(p == !n1)); putB(7u, any(p != p));
  `, [1, 0])
  assert.deepEqual(r.slice(0, 8), [1, 5, 2, 1 + 20 + 3, 1, 0, 1, 0])
})

test('template lists are found as WGSL finds them: only after a name that takes one, spaces allowed', () => {
  const r = run(`
    let a1 = I(0); let b1 = I(1);
    let c1 = a1<b1;
    let d1 = select(0i, 1i, a1 < b1 && b1 > a1);
    let k = array<i32, 2>(5i, 6i)[1];
    let w = vec2 < f32 > (1.5).y;
    let e1 = (a1 < b1) != (b1 > (a1));
    let m = array<vec2<u32>, 2>(vec2<u32>(1u, 2u), vec2<u32>(3u, 4u))[U(2)].y;
    putB(0u, c1); putI(1u, d1); putI(2u, k); putF(3u, w); putB(4u, e1); putU(5u, m);
  `, [1, 2, 1])
  assert.deepEqual(r.slice(0, 6), [1, 1, 6, fb(1.5), 0, 4])
  refusedBody('let a1 = I(0); let x = a1 < 1i > (2i);', /parentheses to mix/)
  refusedBody('let x = vec2<f32(1.0);', /expected > to close a template list|expected/)
  // A name that takes no template list reads < as less-than, so this is a < b > (c), which WGSL refuses.
  refusedBody('let x = foo<i32>(1i);', /parentheses to mix/)
})

// ---------------------------------------------------------------------------------------------------
// The differential (design 15.1), for what wgsl.ts lowers today: compute modules without images
//
// Each module is built with builder.ts, run by interp.ts (the reference), lowered by toWgsl and run by the evaluator
// above in both modes, and every word it writes is held against the reference's. The modules are hand-written
// families, and modules a seeded xorshift generator builds (the seed is in every message).
//
// HOW A WORD IS COMPARED. In exact mode every word is the reference's, bit for bit (an f32 NaN equals any NaN: NaN
// payloads are not pinned, design 12.3). In adversarial mode each written value has a class, worked out from the
// module:
// - E: made only by operations the ledger (design 12.1) calls exact, written under control that depends on E values
//   only. Bit for bit, as in exact mode: this is what shows the emulations lean on no freedom WGSL leaves.
// - A: one approximated operation (design 12.2) over E values, recorded beside its operands. Within that operation's
//   A-class, named in the message. The bound is WGSL's own accuracy rule for the operation as the lowering prints it:
//   correctly rounded either way, division within 2.5 ULP, the accuracy table, and inherited expressions composed by
//   interval arithmetic (a sum of products within the bound that any order of evaluation and any fusion keeps).
//   Where WGSL bounds nothing (an operation on a NaN or an infinity, or one that overflows, under its finite math;
//   sin beyond pi; a divisor outside [2^-126, 2^126]) a component is not compared, as A12 says of the library. An
//   edge the lowering emulates is compared bit for bit. A comparison (A14) is compared bit for bit unless an operand
//   is NaN. A bit cast of a NaN to an integer is any NaN pattern (payloads are not pinned).
// - W: made from an A value, or written or set under control that depends on one. A chain of approximations, or a
//   branch one flips, is bounded by no A-class, so such a value is compared in exact mode only.
// Subnormals (A13): the adversarial run takes every freedom but `flush`; a third run takes every freedom, and each E
// word must then be the reference's, or the word of the reference run with its subnormal inputs and literals flushed
// to zero (a subnormal output flushed too), as A13 states its tolerance. A bit cast to f32 may flush in WGSL, so that
// run counts one as approximated.

/** A value's class (see above), and the rule an approximated value is held to. */
type Cls = 'E' | 'A' | 'W'
type Tag = 'A9' | 'A10' | 'A11' | 'A12' | 'A14' | 'payload'

/** The value types one invocation's output struct holds, in field order. */
const OUT_TYPES: readonly ValueType[] = ['f32', 'f32x2', 'f32x3', 'f32x4', 'i32', 'i32x2', 'i32x3', 'i32x4', 'u32', 'u32x2', 'u32x3', 'u32x4', 'm2', 'm3', 'm4']
/** How many of each a generated module may write. */
const GEN_CAPS: readonly number[] = [48, 8, 8, 8, 16, 4, 4, 4, 40, 6, 6, 6, 3, 3, 3]
/** Input words of one invocation: f32, i32 and u32. */
const IN_F = 12
const IN_I = 6
const IN_U = 6
/** The word every output starts as, so that a record its invocation never reached can be told apart. */
const CANARY = 0xa5a5a5a5

const kindOf = (t: ValueType): LensScalar => (isGrid(t) ? 'f32' : (t.split('x')[0] as LensScalar))
const typeOfWidth = (s: LensScalar, n: number): ValueType => (n === 1 ? s : (`${s}x${n}` as ValueType))
const asU32 = (t: ValueType): ValueType => typeOfWidth('u32', lensWidthOf(t))
const wordsIn32 = (t: ValueType): number => (isGrid(t) ? lensWidthOf(t) ** 2 : lensWidthOf(t))

/** xorshift32: every choice the generator makes comes from here (the air gap bans the host's own source). */
function xorshift32(seed: number): (n: number) => number {
  let s = (Math.imul(seed, 0x9e3779b1) + 0x7f4a7c15) >>> 0 || 1
  return (n: number): number => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s % n
  }
}

/** f32 words: zeros, small whole numbers and halves, fract's edge below zero, the ends of the casts, large and small, and the specials. */
const F_SPECIAL: readonly number[] = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, -1.5, 2, -2.5, 3, 0.25, -0.25, -1e-10, 1e-10, -0.75, 7.5, -7.75, 100, 0.1, Math.PI, -Math.PI / 2, 0.75, -3,
  16777216, 8388607.5, 2147483520, 2147483648, -2147483648, -2147483904, 4294967040, 4294967296, 3e9, -3e9, 1e30, -1e-30, 3.4e38, 1e-38, 200, -200,
].map((x) => fb(f32(x))).concat([INF_BITS, 0xff800000, NAN_BITS, 0xffc00000, 0x7f800001, 1, 0x80000001, 0x007fffff, 0x807fffff, 0x00800000, 0x7f7fffff, 0xff7fffff])
const I_SPECIAL: readonly number[] = [0, 1, -1, 2, -2, 3, 7, -7, 31, 32, 33, 255, 256, -256, 16777217, -16777217, 0x7fffffff, -0x80000000, -0x7fffffff, 0x40000000, 100, -100]
const U_SPECIAL: readonly number[] = [0, 1, 2, 3, 5, 31, 32, 33, 40, 255, 256, 0x7fffffff, 0x80000000, 0xffffffff, 0xfffffffe, 16777217, 16777219, 0xffffff80, 0xffffff7f, 0x7fffff81, 1000]

/** An input word of a kind: often a special value, else a moderate f32 (now and then any word), or a small or any integer. */
function wordOf(r: (n: number) => number, k: LensScalar): number {
  if (k === 'f32') {
    if (r(3) === 0) return F_SPECIAL[r(F_SPECIAL.length)]
    if (r(8) === 0) return ((r(0x10000) << 16) | r(0x10000)) >>> 0
    return ((r(2) << 31) | ((115 + r(25)) << 23) | (r(0x800) << 12) | r(0x1000)) >>> 0
  }
  if (r(2) === 0) return (k === 'i32' ? I_SPECIAL[r(I_SPECIAL.length)] : U_SPECIAL[r(U_SPECIAL.length)]) >>> 0
  return r(3) === 0 ? r(64) : ((r(0x10000) << 16) | r(0x10000)) >>> 0
}

/** Calls `leaf(kind, byte offset)` for every scalar word of a block as layoutBlock lays it out (grid columns padded). */
function eachWord(block: Block, space: 'uniform' | 'storage', base: number, leaf: (k: LensScalar, at: number) => void): void {
  const lay = layoutBlock(block, space)
  const walkType = (t: DataType, at: number): void => {
    if (typeof t === 'string') {
      const k = kindOf(t)
      if (isGrid(t)) {
        const n = lensWidthOf(t)
        const col = lensStrideOf(columnOf(t) as DataType, space)
        for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) leaf(k, at + j * col + 4 * i)
      } else {
        for (let c = 0; c < lensWidthOf(t); c++) leaf(k, at + 4 * c)
      }
    } else if ('array' in t) {
      const stride = lensStrideOf(t.array, space)
      for (let e = 0; e < t.len; e++) walkType(t.array, at + e * stride)
    } else {
      eachWord(t.struct, space, at, leaf)
    }
  }
  block.fields.forEach((f, i) => walkType(f.type, base + lay.offsets[i]))
}

const isSubnormalBits = (u: number): boolean => (u & 0x7f800000) === 0 && (u & 0x7fffff) !== 0
const flushBits = (u: number): number => (isSubnormalBits(u) ? u & 0x80000000 : u) >>> 0
const isNanBits = (u: number): boolean => (u & 0x7fffffff) > 0x7f800000

/** Where a record lands: the output field of its type and the element in it. */
interface Slot {
  readonly t: ValueType
  readonly field: number
  readonly index: number
}

/** A value written to a slot, with what decides how it is compared in adversarial mode. */
interface Rec {
  readonly slot: Slot
  /** The value written (a bool is written cast to u32, and takes the bool's class). */
  readonly id: number
  readonly ctl: readonly number[]
  readonly loops: readonly number[]
  readonly seq: number
  /** For an approximated value: the rule, the operation, and its operands' records and types. */
  readonly approx: { readonly tag: Tag; readonly fn: string; readonly ops: readonly number[]; readonly types: readonly ValueType[] } | null
}

/** How a value was made: by an exact operation, an approximated one, or a bit cast to f32 ('B'); or by reading a variable. */
interface ValInfo {
  readonly own: 'E' | 'A' | 'B'
  readonly deps: readonly number[]
  readonly v: number | null
}

/** The resources every module of the differential declares. */
interface Res4 {
  readonly inp: BlockRes
  readonly uni: BlockRes
  readonly con: BlockRes
  readonly out: BlockRes
}

/**
 * A module under construction, with what the comparison needs: how each value was made, each variable set, each
 * record written, each loop's escapes and each return, with the conditions around them.
 */
class Gen {
  readonly b: LensBuilder
  readonly r: (n: number) => number
  readonly res: Res4
  readonly caps: readonly number[]
  /** Literals as they are flushed in the A13 run's reference module. */
  readonly flushLits: boolean
  readonly vals = new Map<number, ValInfo>()
  readonly sets: { readonly v: number; readonly id: number; readonly ctl: readonly number[]; readonly loops: readonly number[] }[] = []
  readonly recs: Rec[] = []
  readonly loops: { readonly escapes: (readonly number[])[] }[] = []
  readonly returns: { readonly ctl: readonly number[]; readonly seq: number }[] = []
  readonly used: number[]
  readonly inv: LensVal
  ctl: number[] = []
  stack: { readonly id: number; readonly depth: number }[] = []
  pools = new Map<ValueType, LensVal[]>()
  vars: LensVar[] = []
  seq = 0

  constructor(b: LensBuilder, r: (n: number) => number, res: Res4, caps: readonly number[], flushLits: boolean) {
    this.b = b
    this.r = r
    this.res = res
    this.caps = caps
    this.flushLits = flushLits
    this.used = caps.map(() => 0)
    this.inv = this.e(b.pick(b.builtin('global-id'), 'x'), [], false)
  }

  /** Registers a value made by an exact operation from `deps`, and pools it. */
  e(v: LensVal, deps: readonly LensVal[], pool = true): LensVal {
    this.vals.set(v.id, { own: 'E', deps: deps.map((d) => d.id), v: null })
    if (pool) this.keep(v)
    return v
  }

  /** Registers a value made by an approximated operation, or ('B') a bit cast to f32. */
  a(v: LensVal, deps: readonly LensVal[], pool: boolean, own: 'A' | 'B' = 'A'): LensVal {
    this.vals.set(v.id, { own, deps: deps.map((d) => d.id), v: null })
    if (pool) this.keep(v)
    return v
  }

  keep(v: LensVal): void {
    const list = this.pools.get(v.t)
    if (list === undefined) this.pools.set(v.t, [v])
    else list.push(v)
  }

  has(t: ValueType): boolean {
    return (this.pools.get(t)?.length ?? 0) > 0
  }

  /** A pooled value of type t, recent ones more often. */
  any(t: ValueType): LensVal {
    const list = this.pools.get(t) as LensVal[]
    const n = list.length
    return list[this.r(2) === 0 ? n - 1 - this.r(Math.min(n, 4)) : this.r(n)]
  }

  /** An f32 literal component from a word, flushed when this is the A13 run's reference module. */
  fnum(u: number): number {
    return bf(this.flushLits ? flushBits(u) : u)
  }

  lit(t: ValueType, comps: readonly (number | boolean)[]): LensVal {
    return this.e(this.b.lit(t, ...comps), [])
  }

  /** A variable, offered to later sets and gets unless `own` (a loop's counter). */
  newVar(t: ValueType, init: LensVal, own = false): LensVar {
    const x = this.b.var(t, init)
    this.sets.push({ v: x.id, id: init.id, ctl: [...this.ctl], loops: this.stack.map((s) => s.id) })
    if (!own) this.vars.push(x)
    return x
  }

  get(x: LensVar): LensVal {
    const v = this.b.get(x)
    this.vals.set(v.id, { own: 'E', deps: [], v: x.id })
    this.keep(v)
    return v
  }

  set(x: LensVar, v: LensVal): void {
    this.b.set(x, v)
    this.sets.push({ v: x.id, id: v.id, ctl: [...this.ctl], loops: this.stack.map((s) => s.id) })
  }

  private field(t: ValueType): number {
    return OUT_TYPES.indexOf(kindOf(t) === 'bool' ? asU32(t) : t)
  }

  /** Whether the output struct has room for values of these types. */
  room(types: readonly ValueType[]): boolean {
    const need = new Map<number, number>()
    for (const t of types) need.set(this.field(t), (need.get(this.field(t)) ?? 0) + 1)
    return [...need].every(([f, n]) => this.used[f] + n <= this.caps[f])
  }

  /** Writes a value to the next slot of its type (a bool cast to u32); returns the record's index, or -1 when full. */
  record(v: LensVal, approx: Rec['approx'] = null): number {
    const field = this.field(v.t)
    if (this.used[field] >= this.caps[field]) return -1
    const slot = { t: OUT_TYPES[field], field, index: this.used[field]++ }
    const w = kindOf(v.t) === 'bool' ? this.b.cast(v, asU32(v.t)) : v
    this.b.write(this.res.out, ['inv', this.inv, `o${field}`, slot.index], w)
    this.recs.push({ slot, id: v.id, ctl: [...this.ctl], loops: this.stack.map((s) => s.id), seq: this.seq++, approx })
    return this.recs.length - 1
  }

  /** Records an approximated value with its operands beside it, when there is room for all of them. */
  approx(v: LensVal, tag: Tag, fn: string, ops: readonly LensVal[]): void {
    if (!this.room([v.t, ...ops.map((o) => o.t)])) return
    const refs = ops.map((o) => this.record(o))
    this.record(v, { tag, fn, ops: refs, types: ops.map((o) => o.t) })
  }

  /** Runs `body` with the pools and variables as they are, and drops what it made when it ends. */
  private scoped(body: () => void): () => void {
    return (): void => {
      const pools = this.pools
      const vars = this.vars
      this.pools = new Map([...pools].map(([t, l]) => [t, [...l]]))
      this.vars = [...vars]
      body()
      this.pools = pools
      this.vars = vars
    }
  }

  iff(c: LensVal, then: () => void, otherwise?: () => void): void {
    const arm = (body: () => void): (() => void) => this.scoped(() => {
      this.ctl.push(c.id)
      body()
      this.ctl.pop()
    })
    if (otherwise === undefined) this.b.if(c, arm(then))
    else this.b.if(c, arm(then), arm(otherwise))
  }

  /** A loop that leaves after `cap` passes (a u32 counter checked and counted first), or at the cap of 65,536 when cap is null. */
  loop(cap: number | null, body: () => void): void {
    const counter = cap === null ? null : this.newVar('u32', this.e(this.b.u32(0), [], false), true)
    const id = this.loops.length
    this.loops.push({ escapes: [] })
    this.b.loop(this.scoped(() => {
      this.stack.push({ id, depth: this.ctl.length })
      if (counter !== null) {
        const n = this.get(counter)
        const stop = this.e(this.b.ge(n, this.b.u32(cap as number)), [n], false)
        this.iff(stop, () => this.escape('break'))
        this.set(counter, this.e(this.b.add(n, this.b.u32(1)), [n], false))
      }
      body()
      this.stack.pop()
    }))
  }

  /** break, continue or return, noting the conditions it sits under for every loop it leaves. */
  escape(kind: 'break' | 'continue' | 'return'): void {
    if (kind === 'return') {
      this.returns.push({ ctl: [...this.ctl], seq: this.seq++ })
      for (const s of this.stack) this.loops[s.id].escapes.push(this.ctl.slice(s.depth))
      this.b.return()
      return
    }
    const top = this.stack[this.stack.length - 1]
    this.loops[top.id].escapes.push(this.ctl.slice(top.depth))
    if (kind === 'break') this.b.break()
    else this.b.continue()
  }

  /** Each record's class, by a fixed point over values, variables and control; `flushRun` counts bit casts to f32 as approximated. */
  classify(flushRun: boolean): Cls[] {
    const cls = new Map<number, Cls>()
    const of = (id: number): Cls => cls.get(id) ?? 'E'
    const ctlE = (conds: readonly number[]): boolean => conds.every((c) => of(c) === 'E')
    const wild = (l: number): boolean => this.loops[l].escapes.some((conds) => !ctlE(conds))
    const ids = [...this.vals.keys()].sort((x, y) => x - y)
    for (let changed = true; changed;) {
      changed = false
      for (const s of this.sets) {
        const ok = of(s.id) === 'E' && ctlE(s.ctl) && !s.loops.some(wild)
        if (!ok && of(s.v) !== 'W') {
          cls.set(s.v, 'W')
          changed = true
        }
      }
      for (const id of ids) {
        const info = this.vals.get(id) as ValInfo
        const from = info.v !== null ? of(info.v) : info.deps.every((d) => of(d) === 'E') ? 'E' : 'W'
        const own: Cls = info.own === 'A' || (info.own === 'B' && flushRun) ? 'A' : 'E'
        const c: Cls = from !== 'E' ? 'W' : own
        if (c !== of(id)) {
          cls.set(id, c)
          changed = true
        }
      }
    }
    return this.recs.map((rec) => {
      if (!ctlE(rec.ctl) || rec.loops.some(wild) || this.returns.some((x) => x.seq < rec.seq && !ctlE(x.ctl))) return 'W'
      const c = of(rec.id)
      return c === 'A' && rec.approx === null ? 'W' : c
    })
  }
}

// ---------------------------------------------------------------------------------------------------
// What an approximated value may be: WGSL's accuracy rules, by interval arithmetic

/** One component of an approximated value: the reference's word exactly, any f32 in [lo, hi], any NaN, or anything. */
type Allow = { readonly k: 'exact' } | { readonly k: 'in'; readonly lo: number; readonly hi: number } | { readonly k: 'nan' } | { readonly k: 'any' }
const ALLOW_EXACT: Allow = { k: 'exact' }
const ALLOW_ANY: Allow = { k: 'any' }
const ALLOW_NAN: Allow = { k: 'nan' }

/** An interval of f32 values, or null where WGSL bounds nothing. */
type Iv = readonly [number, number] | null

/** Relative slack for the double the exact value is held in (2^-50, far below an f32 step). */
const SLACK = 2 ** -50
const U23 = 2 ** -23
const TINY = 2 ** -149

/** The f32 at or below, and at or above, a real held exactly in a double. */
const down32 = (x: number): number => {
  const r = f32(x)
  return r <= x ? r : stepF32(r, -1)
}
const up32 = (x: number): number => {
  const r = f32(x)
  return r >= x ? r : stepF32(r, 1)
}

/** The f32 neighbours of the exact sum a + b, from its double and the part the double lost. */
function sumParts(a: number, b: number): readonly [number, number] {
  const s = a + b
  const v = s - a
  return [s, (a - (s - v)) + (b - v)]
}
function downAdd(a: number, b: number): number {
  const [s, e] = sumParts(a, b)
  if (!Number.isFinite(s)) return s
  const r = f32(s)
  if (r < s) return r
  if (r > s) return stepF32(r, -1)
  return e < 0 ? stepF32(r, -1) : r
}
function upAdd(a: number, b: number): number {
  const [s, e] = sumParts(a, b)
  if (!Number.isFinite(s)) return s
  const r = f32(s)
  if (r > s) return r
  if (r < s) return stepF32(r, 1)
  return e > 0 ? stepF32(r, 1) : r
}

const finiteF32 = (x: number): boolean => Number.isFinite(x) && Math.abs(x) <= F32_MAX
/** An interval, or null when an end left the finite range (an overflow, which WGSL's finite math leaves open). */
const iv = (lo: number, hi: number): Iv => (finiteF32(lo) && finiteF32(hi) ? [lo, hi] : null)
const point = (x: number): Iv => [x, x]

/** WGSL's ULP of a real x: the gap of the two f32 values around it, or for an f32 the smaller gap beside it. */
function ulpOf(x: number): number {
  const a = Math.abs(x)
  if (a >= F32_MAX) return 2 ** 104
  const lo = down32(a)
  const hi = up32(a)
  if (lo !== hi) return hi - lo
  if (a === 0) return TINY
  return Math.min(a - stepF32(a, -1), stepF32(a, 1) - a)
}
const ulpNear = (x: number): number => Math.max(ulpOf(x * (1 - SLACK)), ulpOf(x * (1 + SLACK)))

/** The f32 values within `err` of a real in [cLo, cHi]; null when that reaches past the finite range. */
function near(cLo: number, cHi: number, err: number): Iv {
  const lo = cLo - Math.abs(cLo) * SLACK - err
  const hi = cHi + Math.abs(cHi) * SLACK + err
  if (!(lo >= -F32_MAX && hi <= F32_MAX)) return null
  return [up32(lo), down32(hi)]
}
/** Within k ULP of a real in [cLo, cHi]. */
const ulps = (cLo: number, cHi: number, k: number): Iv => near(cLo, cHi, k * Math.max(ulpNear(cLo), ulpNear(cHi)))

/** Correctly rounded (either neighbour, since WGSL names no rounding mode) arithmetic over intervals with f32 ends. */
function addIv(A: Iv, B: Iv): Iv {
  return A === null || B === null ? null : iv(downAdd(A[0], B[0]), upAdd(A[1], B[1]))
}
const negIv = (A: Iv): Iv => (A === null ? null : [-A[1], -A[0]])
function mulIv(A: Iv, B: Iv): Iv {
  if (A === null || B === null) return null
  // A product of two f32 values is exact in a double.
  const p = [A[0] * B[0], A[0] * B[1], A[1] * B[0], A[1] * B[1]]
  return iv(down32(Math.min(...p)), up32(Math.max(...p)))
}
/** Division: 2.5 ULP for divisors in [2^-126, 2^126], nothing elsewhere. */
function divIv(A: Iv, B: Iv): Iv {
  if (A === null || B === null) return null
  const m = Math.min(Math.abs(B[0]), Math.abs(B[1]))
  const M = Math.max(Math.abs(B[0]), Math.abs(B[1]))
  if ((B[0] <= 0 && B[1] >= 0) || m < 2 ** -126 || M > 2 ** 126) return null
  const q = [A[0] / B[0], A[0] / B[1], A[1] / B[0], A[1] / B[1]]
  return ulps(Math.min(...q), Math.max(...q), 2.5)
}
/**
 * A sum of n products whose exact values lie in the given intervals, evaluated in any order and with any fusion
 * (WGSL lets an implementation reassociate and fuse): each term passes at most n roundings of relative size below
 * 2^-23, so the error is within n 2^-23 / (1 - n 2^-23) of the sum of the terms' sizes, plus 2^-149 for each of the
 * 2n - 1 operations that may round in the subnormal range.
 */
function sumIv(terms: readonly (readonly [number, number])[]): Iv {
  const n = terms.length
  let lo = 0
  let hi = 0
  let size = 0
  for (const [a, b] of terms) {
    lo += a
    hi += b
    size += Math.max(Math.abs(a), Math.abs(b))
  }
  if (!(size * (1 + n * 2 ** -22) <= F32_MAX)) return null
  return near(lo, hi, n * U23 * (1 + 2 ** -18) * size + 2 * n * TINY + n * size * SLACK)
}
const sq = (A: readonly [number, number]): readonly [number, number] =>
  A[0] <= 0 && A[1] >= 0 ? [0, Math.max(A[0] * A[0], A[1] * A[1])] : [Math.min(A[0] * A[0], A[1] * A[1]), Math.max(A[0] * A[0], A[1] * A[1])]

/** inverseSqrt: 2 ULP. */
function rsqrtIv(X: Iv): Iv {
  return X === null || !(X[0] > 0) ? null : ulps(1 / Math.sqrt(X[1]), 1 / Math.sqrt(X[0]), 2)
}
/** sqrt: inherited from 1.0 / inverseSqrt(x). */
const sqrtIv = (X: Iv): Iv => divIv(point(1), rsqrtIv(X))
/** exp2 over an interval: 3 + 2 |x| ULP. */
function exp2Iv(M: Iv): Iv {
  return M === null ? null : ulps(2 ** M[0], 2 ** M[1], 3 + 2 * Math.max(Math.abs(M[0]), Math.abs(M[1])))
}
/** log or log2 of a positive finite x: absolute 2^-21 in [0.5, 2], else 3 ULP. */
function logIv(x: number, base2: boolean): Iv {
  const c = base2 ? Math.log2(x) : Math.log(x)
  return x >= 0.5 && x <= 2 ? near(c, c, 2 ** -21) : ulps(c, c, 3)
}
/** atan2(y, x): 4096 ULP when every |x| is in [2^-126, 2^126] and every y finite and normal (monotone in each operand there). */
function atan2Iv(Y: Iv, X: Iv): Iv {
  if (Y === null || X === null) return null
  const normal = (lo: number, hi: number, top: number): boolean => (lo > 0 || hi < 0) && Math.min(Math.abs(lo), Math.abs(hi)) >= 2 ** -126 && Math.max(Math.abs(lo), Math.abs(hi)) <= top
  if (!normal(X[0], X[1], 2 ** 126) || !normal(Y[0], Y[1], F32_MAX)) return null
  const c = [Math.atan2(Y[0], X[0]), Math.atan2(Y[0], X[1]), Math.atan2(Y[1], X[0]), Math.atan2(Y[1], X[1])]
  return ulps(Math.min(...c), Math.max(...c), 4096)
}
const hull = (A: Iv, B: Iv): Iv => (A === null || B === null ? null : [Math.min(A[0], B[0]), Math.max(A[1], B[1])])
const allowIn = (A: Iv): Allow => (A === null ? ALLOW_ANY : { k: 'in', lo: A[0], hi: A[1] })

const isZero = (x: number): boolean => x === 0
const isInf = (x: number): boolean => x === Infinity || x === -Infinity

/** A sum of the products of a grid product's result component, from operands laid out column by column. */
function productTerms(ta: ValueType, tb: ValueType, a: readonly number[], b: readonly number[]): (readonly (readonly [number, number])[])[] {
  const terms = (pairs: (readonly [number, number])[]): (readonly [number, number])[] => pairs.map(([x, y]) => [x * y, x * y] as const)
  if (isGrid(ta) && isGrid(tb)) {
    const n = lensWidthOf(ta)
    return Array.from({ length: n * n }, (_, at) => terms(Array.from({ length: n }, (_, k) => [a[k * n + (at % n)], b[Math.floor(at / n) * n + k]] as const)))
  }
  if (isGrid(ta)) {
    const n = lensWidthOf(ta)
    return Array.from({ length: n }, (_, i) => terms(Array.from({ length: n }, (_, k) => [a[k * n + i], b[k]] as const)))
  }
  const n = lensWidthOf(tb)
  return Array.from({ length: n }, (_, j) => terms(Array.from({ length: n }, (_, k) => [a[k], b[j * n + k]] as const)))
}

/** length's inherited bound, sqrt(dot(v, v)), over components in intervals; nothing when the sum may be 0. */
function lengthIv(comps: readonly (readonly [number, number])[]): Iv {
  const S = sumIv(comps.map(sq))
  return S === null || !(S[0] > 0) ? null : sqrtIv(S)
}

/**
 * What each component of an approximated value may be, given its operands' components (f32 values as numbers) and
 * types, for the operation as wgsl.ts prints it.
 */
function allowed(tag: Tag, fn: string, ops: readonly (readonly number[])[], types: readonly ValueType[], width: number): Allow[] {
  const comp = (o: number, i: number): number => (ops[o].length === 1 ? ops[o][0] : ops[o][i])
  const each = (f: (i: number) => Allow): Allow[] => Array.from({ length: width }, (_, i) => f(i))
  const finiteAll = (...os: number[]): boolean => os.every((o) => ops[o].every(Number.isFinite))
  if (tag === 'A14') return each((i) => (Number.isNaN(comp(0, i)) || Number.isNaN(comp(1, i)) ? ALLOW_ANY : ALLOW_EXACT))
  if (tag === 'payload') return each((i) => (Number.isNaN(comp(0, i)) ? ALLOW_NAN : ALLOW_EXACT))
  switch (fn) {
    case 'add': case 'sub': case 'mul': {
      const [ta, tb] = types
      if (!finiteAll(0, 1)) return each(() => ALLOW_ANY)
      if (fn === 'mul' && (isGrid(ta) || isGrid(tb)) && tb !== 'f32') return productTerms(ta, tb, ops[0], ops[1]).map((t) => allowIn(sumIv(t)))
      return each((i) => {
        const x = comp(0, i)
        const y = comp(1, i)
        return allowIn(fn === 'mul' ? mulIv(point(x), point(y)) : addIv(point(x), point(fn === 'sub' ? -y : y)))
      })
    }
    case 'dot':
      return [finiteAll(0, 1) ? allowIn(sumIv(ops[0].map((x, i) => [x * ops[1][i], x * ops[1][i]] as const))) : ALLOW_ANY]
    case 'cross': {
      if (!finiteAll(0, 1)) return each(() => ALLOW_ANY)
      const [x, y] = ops
      const at = [[1, 2], [2, 0], [0, 1]]
      return each((i) => allowIn(addIv(mulIv(point(x[at[i][0]]), point(y[at[i][1]])), negIv(mulIv(point(x[at[i][1]]), point(y[at[i][0]]))))))
    }
    case 'reflect': {
      // x - 2.0 * dot(x, y) * y.
      if (!finiteAll(0, 1)) return each(() => ALLOW_ANY)
      const D = sumIv(ops[0].map((x, i) => [x * ops[1][i], x * ops[1][i]] as const))
      const K = D === null ? null : iv(2 * D[0], 2 * D[1])
      return each((i) => allowIn(addIv(point(ops[0][i]), negIv(mulIv(K, point(ops[1][i]))))))
    }
    case 'mix': {
      // a * (1.0 - t) + b * t, each step its own statement.
      if (!finiteAll(0, 1, 2)) return each(() => ALLOW_ANY)
      return each((i) => {
        const t = comp(2, i)
        const s = addIv(point(1), point(-t))
        return allowIn(addIv(mulIv(point(comp(0, i)), s), mulIv(point(comp(1, i)), point(t))))
      })
    }
    case 'smoothstep': {
      // t t (3 - 2 t), t = saturate((x - lo) / (hi - lo)). An unbounded step leaves t somewhere in [0, 1], which the
      // exact saturate guarantees, so the result is bounded even then.
      return each((i) => {
        const lo = comp(0, i)
        const hi = comp(1, i)
        const x = comp(2, i)
        const ok = [lo, hi, x].every(Number.isFinite)
        const q = ok ? divIv(addIv(point(x), point(-lo)), addIv(point(hi), point(-lo))) : null
        const s: Iv = q === null ? [0, 1] : [Math.min(1, Math.max(0, q[0])), Math.min(1, Math.max(0, q[1]))]
        const th = addIv(point(3), negIv(iv(2 * s[0], 2 * s[1])))
        return allowIn(mulIv(mulIv(s, s), th))
      })
    }
    case 'distance': {
      if (types[0] === 'f32') {
        // abs(a - b): the difference rounded, its size exact.
        if (!finiteAll(0, 1)) return [ALLOW_ANY]
        const d = addIv(point(ops[0][0]), point(-ops[1][0]))
        return [allowIn(d === null ? null : d[0] <= 0 && d[1] >= 0 ? [0, Math.max(-d[0], d[1])] : [Math.min(Math.abs(d[0]), Math.abs(d[1])), Math.max(Math.abs(d[0]), Math.abs(d[1]))])]
      }
      // length(a - b), the difference a statement of its own.
      if (!finiteAll(0, 1)) return [ALLOW_ANY]
      if (ops[0].every((x, i) => x === ops[1][i])) return [ALLOW_EXACT]
      const d = ops[0].map((x, i) => addIv(point(x), point(-ops[1][i])))
      return [d.some((x) => x === null) ? ALLOW_ANY : allowIn(lengthIv(d as [number, number][]))]
    }
    case 'div':
      return each((i) => (Number.isFinite(comp(0, i)) && Number.isFinite(comp(1, i)) ? allowIn(divIv(point(comp(0, i)), point(comp(1, i)))) : ALLOW_ANY))
    case 'rem':
      // a - b * trunc(a / b), each step its own statement.
      return each((i) => {
        const a = comp(0, i)
        const b = comp(1, i)
        if (!Number.isFinite(a) || !Number.isFinite(b)) return ALLOW_ANY
        const q = divIv(point(a), point(b))
        const t = q === null ? null : iv(Math.trunc(q[0]), Math.trunc(q[1]))
        return allowIn(addIv(point(a), negIv(mulIv(point(b), t))))
      })
    case 'fma':
      // Inherited from a * b + c.
      return each((i) => (finiteAll(0, 1, 2) ? allowIn(addIv(mulIv(point(comp(0, i)), point(comp(1, i))), point(comp(2, i)))) : ALLOW_ANY))
    case 'sqrt': case 'rsqrt':
      return each((i) => {
        const x = comp(0, i)
        if (isZero(x) || x === Infinity || !(x > 0)) return ALLOW_EXACT
        return allowIn(fn === 'sqrt' ? sqrtIv(point(x)) : rsqrtIv(point(x)))
      })
    case 'exp': case 'exp2':
      return each((i) => {
        const x = comp(0, i)
        if (!Number.isFinite(x)) return ALLOW_EXACT
        const c = fn === 'exp' ? Math.exp(x) : 2 ** x
        return allowIn(ulps(c, c, 3 + 2 * Math.abs(x)))
      })
    case 'log': case 'log2':
      return each((i) => {
        const x = comp(0, i)
        if (isZero(x) || x === Infinity || !(x > 0)) return ALLOW_EXACT
        return allowIn(logIv(x, fn === 'log2'))
      })
    case 'sin': case 'cos': case 'tan':
      return each((i) => {
        const x = comp(0, i)
        if (!Number.isFinite(x)) return ALLOW_EXACT
        if (!(Math.abs(x) <= Math.PI)) return ALLOW_ANY
        const s = near(Math.sin(x), Math.sin(x), 2 ** -11)
        const c = near(Math.cos(x), Math.cos(x), 2 ** -11)
        // tan is inherited from sin(x) / cos(x).
        return allowIn(fn === 'sin' ? s : fn === 'cos' ? c : divIv(s, c))
      })
    case 'asin': case 'acos':
      // The worse of an absolute bound and the inherited atan2 form.
      return each((i) => {
        const x = comp(0, i)
        if (!(Math.abs(x) <= 1)) return ALLOW_EXACT
        const c = fn === 'asin' ? Math.asin(x) : Math.acos(x)
        const abs = near(c, c, fn === 'asin' ? 6.81e-5 : 6.77e-5)
        const root = sqrtIv(addIv(point(1), negIv(mulIv(point(x), point(x)))))
        const inherited = fn === 'asin' ? atan2Iv(point(x), root) : atan2Iv(root, point(x))
        return allowIn(hull(abs, inherited))
      })
    case 'atan':
      return each((i) => {
        const x = comp(0, i)
        return Number.isFinite(x) ? allowIn(ulps(Math.atan(x), Math.atan(x), 4096)) : ALLOW_EXACT
      })
    case 'atan2':
      return each((i) => {
        const y = comp(0, i)
        const x = comp(1, i)
        if (Number.isNaN(y) || Number.isNaN(x) || isZero(x) || isZero(y)) return ALLOW_EXACT
        return allowIn(atan2Iv(point(y), point(x)))
      })
    case 'pow':
      // The emulated edges, else inherited from exp2(b * log2(a)) on abs(a), negated for a negative base and an odd exponent.
      return each((i) => {
        const a = comp(0, i)
        const b = comp(1, i)
        const whole = Math.trunc(b) === b
        if (Number.isNaN(a) || Number.isNaN(b) || isZero(b) || isInf(b) || isZero(a) || isInf(a) || (a < 0 && !whole)) return ALLOW_EXACT
        const r = exp2Iv(mulIv(point(b), logIv(Math.abs(a), true)))
        const odd = Math.abs(b) < 2 ** 24 && Math.abs(b) % 2 === 1
        return allowIn(a < 0 && odd ? negIv(r) : r)
      })
    case 'length': {
      const v = ops[0]
      if (v.some(Number.isNaN) || v.some(isInf) || v.every(isZero)) return [ALLOW_EXACT]
      return [allowIn(lengthIv(v.map((x) => [x, x] as const)))]
    }
    case 'normalize': {
      // x / length(x).
      const v = ops[0]
      if (v.some(Number.isNaN) || v.some(isInf) || v.every(isZero)) return each(() => ALLOW_EXACT)
      const L = lengthIv(v.map((x) => [x, x] as const))
      return each((i) => allowIn(divIv(point(v[i]), L)))
    }
  }
  throw new Error(`no accuracy rule for ${fn}`)
}

// ---------------------------------------------------------------------------------------------------
// The generator: well-typed compute modules from a seed

const F_TYPES: readonly ValueType[] = ['f32', 'f32', 'f32x2', 'f32x3', 'f32x4']
const I_TYPES: readonly ValueType[] = ['i32', 'i32', 'i32x2', 'i32x3', 'i32x4']
const U_TYPES: readonly ValueType[] = ['u32', 'u32', 'u32x2', 'u32x3', 'u32x4']
const B_TYPES: readonly ValueType[] = ['bool', 'bool', 'boolx2', 'boolx3', 'boolx4']
const GRIDS: readonly ValueType[] = ['m2', 'm3', 'm4']
const F_EXACT1 = ['neg', 'abs', 'sign', 'floor', 'ceil', 'round', 'trunc', 'fract', 'saturate'] as const
const LIBRARY1 = ['sqrt', 'rsqrt', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan'] as const
const COMPARE = ['eq', 'ne', 'lt', 'le', 'gt', 'ge'] as const
const INT2 = ['add', 'sub', 'mul', 'div', 'rem', 'min', 'max', 'and', 'or', 'xor'] as const

const choice = <T>(g: Gen, xs: readonly T[]): T => xs[g.r(xs.length)]
const boolsOf = (t: ValueType): ValueType => typeOfWidth('bool', lensWidthOf(t))

/** A literal of type t: special values often, f32 components finite (and flushed in the A13 run's reference module). */
function literalOf(g: Gen, t: ValueType): LensVal {
  const k = kindOf(t)
  const comps = Array.from({ length: wordsIn32(t) }, () => {
    if (k === 'bool') return g.r(2) === 0
    if (k !== 'f32') return k === 'i32' ? wordOf(g.r, 'i32') | 0 : wordOf(g.r, 'u32')
    let u = wordOf(g.r, 'f32')
    while ((u & 0x7f800000) === 0x7f800000) u = wordOf(g.r, 'f32')
    return g.fnum(u)
  })
  return g.lit(t, comps)
}

/** A value of type t: a pooled one mostly, else built from parts, a lane of a wider vector, or a literal. */
function want(g: Gen, t: ValueType): LensVal {
  if (g.has(t) && g.r(6) !== 0) return g.any(t)
  return build(g, t)
}

function build(g: Gen, t: ValueType): LensVal {
  const b = g.b
  if (isGrid(t)) {
    const n = lensWidthOf(t)
    const parts = g.r(2) === 0 ? Array.from({ length: n }, () => want(g, columnOf(t))) : Array.from({ length: n * n }, () => want(g, 'f32'))
    return g.e(b.make(t, ...parts), parts)
  }
  const k = kindOf(t)
  const n = lensWidthOf(t)
  if (n === 1) {
    const wide = [2, 3, 4].map((w) => typeOfWidth(k, w)).filter((u) => g.has(u))
    if (wide.length > 0 && g.r(2) === 0) {
      const v = g.any(choice(g, wide))
      return g.e(b.pick(v, [g.r(lensWidthOf(v.t))]), [v])
    }
    return literalOf(g, t)
  }
  const how = g.r(4)
  if (how === 0) return literalOf(g, t)
  if (how === 1) {
    const s = want(g, k)
    return g.e(b.make(t, s), [s])
  }
  const parts: LensVal[] = []
  for (let left = n; left > 0;) {
    const w = 1 + g.r(left)
    parts.push(want(g, typeOfWidth(k, w)))
    left -= w
  }
  return g.e(b.make(t, ...parts), parts)
}

/** Records an exact value now and then (three times in four). */
function note(g: Gen, v: LensVal): LensVal {
  if (g.r(4) !== 0) g.record(v)
  return v
}

/** An approximated value, recorded with its operands, and pooled now and then so that chains of them occur. */
function approxOp(g: Gen, v: LensVal, tag: Tag, fn: string, ops: readonly LensVal[]): void {
  // A bit cast's NaN payload is pinned by nothing, in either mode, so nothing is made from one.
  g.a(v, ops, tag !== 'payload' && g.r(4) === 0)
  g.approx(v, tag, fn, ops)
}

/** One operation, of any kind the lowering takes. */
function opStep(g: Gen): void {
  const b = g.b
  const r = g.r(100)
  if (r < 18) {
    // f32 operations the ledger calls exact.
    const t = choice(g, F_TYPES)
    const s = g.r(10)
    if (s < 5) {
      const x = want(g, t)
      note(g, g.e(b.unary(choice(g, F_EXACT1), x), [x]))
    } else if (s < 6) {
      const x = want(g, 'f32')
      note(g, g.e(b.length(x), [x]))
    } else if (s < 8) {
      const x = want(g, t)
      const y = want(g, t)
      note(g, g.e(b.binary(choice(g, ['min', 'max', 'step'] as const), x, y), [x, y]))
    } else if (s < 9) {
      const x = want(g, t)
      const lo = want(g, t)
      const hi = want(g, t)
      note(g, g.e(b.clamp(x, lo, hi), [x, lo, hi]))
    } else {
      const c = want(g, lensWidthOf(t) === 1 || g.r(2) === 0 ? 'bool' : boolsOf(t))
      const x = want(g, t)
      const y = want(g, t)
      note(g, g.e(b.choose(c, x, y), [c, x, y]))
    }
  } else if (r < 33) {
    // Integers.
    const t = choice(g, g.r(2) === 0 ? I_TYPES : U_TYPES)
    const k = kindOf(t)
    const n = lensWidthOf(t)
    const s = g.r(12)
    const x = want(g, t)
    if (s < 5) {
      const fn = choice(g, INT2)
      const mixed = n > 1 && g.r(4) === 0 && ['add', 'sub', 'mul', 'div', 'rem'].includes(fn)
      const y = want(g, mixed ? k : t)
      note(g, g.e(g.r(2) === 0 || !mixed ? b.binary(fn, x, y) : b.binary(fn, y, x), [x, y]))
    } else if (s < 6) {
      const c = want(g, asU32(t))
      note(g, g.e(b.binary(g.r(2) === 0 ? 'shl' : 'shr', x, c), [x, c]))
    } else if (s < 7) {
      const fn = choice(g, k === 'i32' ? (['abs', 'bitnot', 'neg', 'sign'] as const) : (['abs', 'bitnot'] as const))
      note(g, g.e(b.unary(fn, x), [x]))
    } else if (s < 8) {
      const lo = want(g, t)
      const hi = want(g, t)
      note(g, g.e(b.clamp(x, lo, hi), [x, lo, hi]))
    } else if (s < 9 && n > 1) {
      const y = want(g, t)
      note(g, g.e(b.dot(x, y), [x, y]))
    } else if (s < 11) {
      const y = want(g, t)
      note(g, g.e(b.binary(choice(g, COMPARE), x, y), [x, y]))
    } else {
      const c = want(g, n === 1 || g.r(2) === 0 ? 'bool' : boolsOf(t))
      const y = want(g, t)
      note(g, g.e(b.choose(c, x, y), [c, x, y]))
    }
  } else if (r < 41) {
    // Casts: saturating f32 to integers, integers to f32 to nearest even, between integers, to and from bool.
    const pairs: readonly (readonly [LensScalar, LensScalar])[] = [['f32', 'i32'], ['f32', 'u32'], ['i32', 'f32'], ['u32', 'f32'], ['i32', 'u32'], ['u32', 'i32'],
      ['f32', 'bool'], ['i32', 'bool'], ['u32', 'bool'], ['bool', 'f32'], ['bool', 'i32'], ['bool', 'u32']]
    const [from, to] = choice(g, pairs)
    const w = 1 + g.r(4)
    const x = want(g, typeOfWidth(from, w))
    note(g, g.e(b.cast(x, typeOfWidth(to, w)), [x]))
  } else if (r < 45) {
    // Bit casts. One of an f32 to an integer carries a NaN's payload, which nothing pins; one to an f32 may flush (A13).
    const kinds: readonly LensScalar[] = ['f32', 'i32', 'u32']
    const from = choice(g, kinds)
    const to = choice(g, kinds.filter((k) => k !== from))
    const w = 1 + g.r(4)
    const x = want(g, typeOfWidth(from, w))
    const v = b.bits(x, typeOfWidth(to, w))
    if (from === 'f32') approxOp(g, v, 'payload', 'bits', [x])
    else if (to === 'f32') g.record(g.a(v, [x], true, 'B'))
    else note(g, g.e(v, [x]))
  } else if (r < 53) {
    // Vectors and grids: make, pick, lane (clamped), column, transpose.
    const s = g.r(6)
    if (s === 0) {
      note(g, build(g, choice(g, [...F_TYPES, ...I_TYPES, ...U_TYPES, ...B_TYPES].filter((t) => lensWidthOf(t) > 1))))
    } else if (s === 1) {
      const v = want(g, choice(g, [...F_TYPES, ...I_TYPES, ...U_TYPES, ...B_TYPES].filter((t) => lensWidthOf(t) > 1)))
      const lanes = Array.from({ length: 1 + g.r(4) }, () => g.r(lensWidthOf(v.t)))
      note(g, g.e(b.pick(v, lanes), [v]))
    } else if (s === 2) {
      const v = want(g, choice(g, [...F_TYPES, ...I_TYPES, ...U_TYPES, ...B_TYPES].filter((t) => lensWidthOf(t) > 1)))
      const i = want(g, g.r(2) === 0 ? 'i32' : 'u32')
      note(g, g.e(b.lane(v, i), [v, i]))
    } else if (s === 3) {
      const m = want(g, choice(g, GRIDS))
      note(g, g.e(b.column(m, g.r(lensWidthOf(m.t))), [m]))
    } else if (s === 4) {
      const m = want(g, choice(g, GRIDS))
      note(g, g.e(b.transpose(m), [m]))
    } else {
      note(g, build(g, choice(g, GRIDS)))
    }
  } else if (r < 58) {
    // Bools.
    const t = choice(g, B_TYPES)
    const x = want(g, t)
    const s = g.r(5)
    if (s === 0) note(g, g.e(b.not(x), [x]))
    else if (s === 1 && lensWidthOf(t) > 1) note(g, g.e(b.unary(g.r(2) === 0 ? 'any' : 'all', x), [x]))
    else {
      const y = want(g, t)
      note(g, g.e(b.binary(choice(g, ['land', 'lor', 'and', 'or', 'xor', 'eq', 'ne'] as const), x, y), [x, y]))
    }
  } else if (r < 63) {
    // f32 comparisons (A14).
    const t = choice(g, F_TYPES)
    const x = want(g, t)
    const y = want(g, t)
    const fn = choice(g, COMPARE)
    approxOp(g, b.binary(fn, x, y), 'A14', fn, [x, y])
  } else if (r < 75) {
    // Chains of products and sums (A9).
    const s = g.r(12)
    const t = choice(g, F_TYPES)
    const n = lensWidthOf(t)
    const vt = n === 1 ? choice(g, F_TYPES.filter((u) => u !== 'f32')) : t
    if (s < 5) {
      const fn = choice(g, ['add', 'sub', 'mul'] as const)
      const x = want(g, t)
      const y = want(g, n > 1 && g.r(4) === 0 ? 'f32' : t)
      const [p, q] = g.r(2) === 0 ? [x, y] : [y, x]
      approxOp(g, b.binary(fn, p, q), 'A9', fn, [p, q])
    } else if (s === 5) {
      const x = want(g, vt)
      const y = want(g, vt)
      approxOp(g, b.dot(x, y), 'A9', 'dot', [x, y])
    } else if (s === 6) {
      const x = want(g, 'f32x3')
      const y = want(g, 'f32x3')
      approxOp(g, b.cross(x, y), 'A9', 'cross', [x, y])
    } else if (s === 7) {
      const x = want(g, vt)
      const y = want(g, vt)
      approxOp(g, b.reflect(x, y), 'A9', 'reflect', [x, y])
    } else if (s === 8) {
      const x = want(g, t)
      const y = want(g, t)
      const f = want(g, g.r(2) === 0 ? t : 'f32')
      approxOp(g, b.mix(x, y, f), 'A9', 'mix', [x, y, f])
    } else if (s === 9) {
      const x = want(g, 'f32')
      const y = want(g, 'f32')
      approxOp(g, b.distance(x, y), 'A9', 'distance', [x, y])
    } else {
      const m = choice(g, GRIDS)
      const col = columnOf(m as Parameters<typeof columnOf>[0])
      const shape = g.r(5)
      const [p, q] = shape === 0 ? [want(g, m), want(g, m)] : shape === 1 ? [want(g, m), want(g, col)] : shape === 2 ? [want(g, col), want(g, m)] : shape === 3 ? [want(g, m), want(g, 'f32')] : [want(g, m), want(g, m)]
      const fn = shape === 4 ? (g.r(2) === 0 ? 'add' : 'sub') : 'mul'
      approxOp(g, b.binary(fn, p, q), 'A9', fn, [p, q])
    }
  } else if (r < 81) {
    // Division and what goes through it (A10).
    const t = choice(g, F_TYPES)
    const s = g.r(4)
    const x = want(g, t)
    if (s < 2) {
      const y = want(g, lensWidthOf(t) > 1 && g.r(4) === 0 ? 'f32' : t)
      approxOp(g, b.div(x, y), 'A10', 'div', [x, y])
    } else if (s === 2) {
      const y = want(g, t)
      approxOp(g, b.rem(x, y), 'A10', 'rem', [x, y])
    } else {
      const lo = want(g, t)
      const hi = want(g, t)
      approxOp(g, b.smoothstep(lo, hi, x), 'A10', 'smoothstep', [lo, hi, x])
    }
  } else if (r < 84) {
    // fma (A11).
    const t = choice(g, F_TYPES)
    const x = want(g, t)
    const y = want(g, t)
    const z = want(g, t)
    approxOp(g, b.fma(x, y, z), 'A11', 'fma', [x, y, z])
  } else if (r < 94) {
    // The library (A12), sometimes on literals, where the lowering leaves out what no literal can reach.
    const t = choice(g, F_TYPES)
    const s = g.r(10)
    if (s < 6) {
      const fn = choice(g, LIBRARY1)
      const x = g.r(5) === 0 ? literalOf(g, t) : want(g, t)
      approxOp(g, b.unary(fn, x), 'A12', fn, [x])
    } else if (s === 6) {
      const y = want(g, t)
      const x = want(g, t)
      approxOp(g, b.atan2(y, x), 'A12', 'atan2', [y, x])
    } else if (s === 7) {
      // A positive literal base and an exponent literal with no zero are the native call alone; a zero of either sign
      // in either (pow's edges: exactly 1, or a zero or an infinity) keeps the helper.
      const plain = g.r(3) === 0
      const base = plain ? g.lit(t, Array.from({ length: lensWidthOf(t) }, () => g.fnum(choice(g, [0.5, 2, 3, 10, 0.1, 1.5, 7, 0, -0].map((x) => fb(f32(x))))))) : want(g, t)
      const ex = plain ? g.lit(t, Array.from({ length: lensWidthOf(t) }, () => g.fnum(choice(g, [0.5, 2, -1, 3, -2.5, 1.5, 10, 0, -0].map((x) => fb(f32(x))))))) : want(g, t)
      approxOp(g, b.pow(base, ex), 'A12', 'pow', [base, ex])
    } else {
      const vt = choice(g, F_TYPES.filter((u) => u !== 'f32'))
      const x = want(g, vt)
      const fn = g.r(2) === 0 ? 'length' : 'normalize'
      if (s === 8) approxOp(g, b.unary(fn, x), 'A12', fn, [x])
      else {
        const y = want(g, vt)
        approxOp(g, b.distance(x, y), 'A12', 'distance', [x, y])
      }
    }
  } else if (r < 97) {
    // Reads again: indices held in values (clamped), another invocation's inputs, the constants.
    const { inp, uni, con } = g.res
    const s = g.r(6)
    const i = want(g, g.r(2) === 0 ? 'i32' : 'u32')
    const v = s === 0 ? b.read(uni, 'arr', i) : s === 1 ? b.read(uni, 'iv', i) : s === 2 ? b.read(con, 'ca', i) : s === 3 ? b.read(inp, 'lanes', g.inv, 'f', i) : s === 4 ? b.read(inp, 'lanes', i, 'u', g.r(IN_U)) : b.read(inp, 'lanes', i, 'i', i)
    note(g, g.e(v, [i]))
  } else {
    note(g, literalOf(g, choice(g, [...F_TYPES, ...I_TYPES, ...U_TYPES])))
  }
}

/** A condition: mostly exact (an integer comparison, a pooled bool, a truth cast), sometimes an f32 comparison (A14). */
function condition(g: Gen): LensVal {
  const b = g.b
  const s = g.r(20)
  if (s < 11) {
    const t = choice(g, ['i32', 'u32'] as const)
    const x = want(g, t)
    const y = want(g, t)
    return g.e(b.binary(choice(g, COMPARE), x, y), [x, y], false)
  }
  if (s < 14 && g.has('bool')) return g.any('bool')
  if (s < 17) {
    const x = want(g, 'f32')
    const y = want(g, 'f32')
    const fn = choice(g, COMPARE)
    const c = b.binary(fn, x, y)
    approxOp(g, c, 'A14', fn, [x, y])
    return c
  }
  const x = want(g, choice(g, ['f32', 'i32', 'u32'] as const))
  return g.e(b.cast(x, 'bool'), [x], false)
}

/** n statements: operations, ifs (whose arms may end in an escape), loops, and variables. */
function statements(g: Gen, n: number, depth: number, inLoop: boolean): void {
  for (let s = 0; s < n; s++) {
    const r = g.r(100)
    if (r < 8 && depth < 3) {
      const c = condition(g)
      const arm = (): void => {
        statements(g, 1 + g.r(4), depth + 1, inLoop)
        const e = g.r(14)
        if (inLoop && e === 0) g.escape('break')
        else if (inLoop && e === 1) g.escape('continue')
        else if (e === 2 && g.returns.length === 0) g.escape('return')
      }
      if (g.r(2) === 0) g.iff(c, arm)
      else g.iff(c, arm, arm)
    } else if (r < 12 && depth < 2 && g.loops.length < 4) {
      g.loop(1 + g.r(4), () => statements(g, 2 + g.r(4), depth + 1, true))
    } else if (r < 15) {
      const t = choice(g, [...F_TYPES, ...I_TYPES, ...U_TYPES, 'bool' as ValueType])
      g.newVar(t, want(g, t))
    } else if (r < 19 && g.vars.length > 0) {
      const x = choice(g, g.vars)
      if (g.r(2) === 0) g.set(x, want(g, x.t))
      else note(g, g.get(x))
    } else {
      opStep(g)
    }
  }
}

/** The blocks every module of the differential declares; `inv` invocations, `caps` records of each output type. */
function declare(b: LensBuilder, inv: number, caps: readonly number[]): Res4 {
  const inp = b.storage(0, 0, { lanes: arrayOf({ f: arrayOf('f32', IN_F), i: arrayOf('i32', IN_I), u: arrayOf('u32', IN_U) }, inv) })
  const uni = b.uniform(0, 1, { s: 'f32', v: 'f32x3', w: 'u32x2', arr: arrayOf('f32x4', 3), iv: arrayOf('i32x4', 2), g: 'm3', h: 'm2', inner: { a: 'f32', n: 'u32x2' } })
  const con = b.constants({ c: 'f32', n: 'u32', cv: 'f32x4', ca: arrayOf('u32x4', 2) })
  const out = b.storage(1, 0, { inv: arrayOf(Object.fromEntries(OUT_TYPES.map((t, i) => [`o${i}`, arrayOf(t as DataType, caps[i])])), inv) }, { writable: true })
  return { inp, uni, con, out }
}

/** Reads the invocation's inputs and some uniform and constant fields into the pools. */
function readInputs(g: Gen, some: boolean): void {
  const b = g.b
  const { inp, uni, con } = g.res
  const take = (): boolean => !some || g.r(3) !== 0
  for (let j = 0; j < IN_F; j++) if (take()) note(g, g.e(b.read(inp, 'lanes', g.inv, 'f', j), []))
  for (let j = 0; j < IN_I; j++) if (take()) note(g, g.e(b.read(inp, 'lanes', g.inv, 'i', j), []))
  for (let j = 0; j < IN_U; j++) if (take()) note(g, g.e(b.read(inp, 'lanes', g.inv, 'u', j), []))
  const fields: readonly (readonly [BlockRes, readonly (string | number)[]])[] = [[uni, ['s']], [uni, ['v']], [uni, ['w']], [uni, ['arr', 1]], [uni, ['iv', 0]], [uni, ['g']], [uni, ['h']],
    [uni, ['inner', 'a']], [uni, ['inner', 'n']], [con, ['c']], [con, ['n']], [con, ['cv']], [con, ['ca', 1]]]
  for (const [res, path] of fields) if (take()) note(g, g.e(b.read(res, ...path), []))
}

/** A generated module: the same seed gives the same module (with flushLits, its literals flushed). */
interface Built {
  readonly m: LensModule
  readonly g: Gen
  readonly inv: number
}

function generate(seed: number, flushLits: boolean): Built {
  const r = xorshift32(seed)
  const b = lens('compute', { group: [4, 1, 1] })
  const g = new Gen(b, r, declare(b, 8, GEN_CAPS), GEN_CAPS, flushLits)
  readInputs(g, true)
  statements(g, 24 + r(24), 0, false)
  return { m: b.finish(), g, inv: 8 }
}

// ---------------------------------------------------------------------------------------------------
// Running a module both ways

/** The bytes a module runs on: the inputs, the uniform block and the constants, and which words of them are f32. */
interface Inputs {
  readonly inp: Uint8Array
  readonly uni: Uint8Array
  readonly con: Uint8Array
}

type WordSource = (k: LensScalar, inv: number, at: number) => number

function inputsOf(res: Res4, word: WordSource): Inputs {
  const fill = (block: Block, space: 'uniform' | 'storage', invStride: number): Uint8Array => {
    const bytes = new Uint8Array(layoutBlock(block, space).size)
    const view = new DataView(bytes.buffer)
    eachWord(block, space, 0, (k, at) => view.setUint32(at, word(k, invStride === 0 ? -1 : Math.floor(at / invStride), at), true))
    return bytes
  }
  const lanes = res.inp.block.fields[0].type as { array: DataType }
  return { inp: fill(res.inp.block, 'storage', lensStrideOf(lanes.array, 'storage')), uni: fill(res.uni.block, 'uniform', 0), con: fill(res.con.block, 'uniform', 0) }
}

/** The same inputs with every subnormal f32 word flushed to a zero of its sign. */
function flushedInputs(res: Res4, ins: Inputs): Inputs {
  const flush = (block: Block, space: 'uniform' | 'storage', src: Uint8Array): Uint8Array => {
    const bytes = new Uint8Array(src)
    const view = new DataView(bytes.buffer)
    eachWord(block, space, 0, (k, at) => {
      if (k === 'f32') view.setUint32(at, flushBits(view.getUint32(at, true)), true)
    })
    return bytes
  }
  return { inp: flush(res.inp.block, 'storage', ins.inp), uni: flush(res.uni.block, 'uniform', ins.uni), con: flush(res.con.block, 'uniform', ins.con) }
}

function freshOut(res: Res4): Uint8Array {
  const bytes = new Uint8Array(layoutBlock(res.out.block, 'storage').size)
  new DataView(bytes.buffer).setUint32(0, CANARY, true)
  for (let at = 4; at < bytes.length; at += 4) bytes.copyWithin(at, 0, 4)
  return bytes
}

/** Runs a module through interp.ts; returns the output bytes. */
function runReference(m: LensModule, res: Res4, ins: Inputs, inv: number): Uint8Array {
  const out = freshOut(res)
  const bytes = new Map<number, Uint8Array>([[res.inp.res, ins.inp], [res.uni.res, ins.uni], [res.con.res, ins.con], [res.out.res, out]])
  const program = compileLens(m)
  const bindings = program.bind({
    block: (i) => {
      const x = bytes.get(i)
      return x === undefined ? null : { bytes: x, offset: 0, size: x.length }
    },
    image: () => null,
    sampler: () => null,
    storageImage: () => null,
  })
  dispatchLens(program, bindings, [inv / 4, 1, 1], 1e8)
  return out
}

/** The WGSL options for a module of the differential (storage access from each resource's writability). */
const lowerOptions = (m: LensModule): Parameters<typeof toWgsl>[1] => ({
  storage: m.resources.map((r) => (r.kind === 'storage' ? (r.writable ? 'read_write' : 'read') : null)),
  outputs: [],
  vertexRate: 0,
  live: null,
  arithmetic: 'native',
})

/** Runs lowered WGSL through the evaluator; returns the output bytes. */
function runLowered(code: string, res: Res4, ins: Inputs, inv: number, options: RunOptions): Uint8Array {
  const out = freshOut(res)
  const hidden = new Uint8Array(WGSL_HIDDEN.size)
  hidden.set(ins.con.subarray(0, Math.min(ins.con.length, WGSL_HIDDEN.lim)), WGSL_HIDDEN.constants)
  const p = new Program(code, { budget: 1e8, ...options })
  p.dispatch([inv / 4, 1, 1], { '0:0': { bytes: ins.inp }, '0:1': { bytes: ins.uni }, [`${WGSL_HIDDEN.group}:${WGSL_HIDDEN.binding}`]: { bytes: hidden }, '1:0': { bytes: out } })
  return out
}

// ---------------------------------------------------------------------------------------------------
// Comparing

/** Byte offsets of the words of each record of one invocation. */
function recordWords(res: Res4, recs: readonly Rec[], inv: number): number[][] {
  const outer = res.out.block
  const arr = outer.fields[0].type as { array: { struct: Block } }
  const inner = arr.array.struct
  const lay = layoutBlock(inner, 'storage')
  const base = inv * lensStrideOf(arr.array, 'storage')
  return recs.map((rec) => {
    const t = rec.slot.t
    const at = base + lay.offsets[rec.slot.field] + rec.slot.index * lensStrideOf(t as DataType, 'storage')
    if (isGrid(t)) {
      const n = lensWidthOf(t)
      const col = lensStrideOf(columnOf(t) as DataType, 'storage')
      return Array.from({ length: n * n }, (_, k) => at + Math.floor(k / n) * col + 4 * (k % n))
    }
    return Array.from({ length: lensWidthOf(t) }, (_, c) => at + 4 * c)
  })
}

/** What a comparison saw: words held bit for bit, components held to a bound, and those WGSL leaves open. */
interface Tally {
  exact: number
  bounded: number
  open: number
  wild: number
  readonly tags: Map<string, number>
}
const newTally = (): Tally => ({ exact: 0, bounded: 0, open: 0, wild: 0, tags: new Map() })

const sameWord = (a: number, b: number, isFloat: boolean): boolean => a === b || (isFloat && isNanBits(a) && isNanBits(b))
const hex = (u: number): string => `0x${(u >>> 0).toString(16).padStart(8, '0')}`
const asNum = (u: number, k: LensScalar): number => (k === 'f32' ? bf(u) : k === 'i32' ? u | 0 : u >>> 0)

/**
 * Compares one run's output with the reference's, record by record. `mode` 'exact' holds every word; 'adversarial'
 * holds each by its class; 'flush' holds E words to the reference or to `flushed` (the A13 run).
 */
function compareRuns(label: string, built: { readonly g: Gen; readonly inv: number }, ref: Uint8Array, got: Uint8Array, mode: 'exact' | 'adversarial' | 'flush', flushed: Uint8Array | null, tally: Tally, failures: string[]): void {
  const { g, inv } = built
  const R = new DataView(ref.buffer, ref.byteOffset, ref.length)
  const G = new DataView(got.buffer, got.byteOffset, got.length)
  const F = flushed === null ? null : new DataView(flushed.buffer, flushed.byteOffset, flushed.length)
  const classes = mode === 'exact' ? null : g.classify(mode === 'flush')
  const fail = (msg: string): void => {
    if (failures.length < 12) failures.push(`${label}: ${msg}`)
  }
  for (let k = 0; k < inv; k++) {
    const words = recordWords(g.res, g.recs, k)
    g.recs.forEach((rec, ri) => {
      const t = rec.slot.t
      const isFloat = kindOf(t) === 'f32'
      const at = words[ri]
      const rw = at.map((o) => R.getUint32(o, true))
      const gw = at.map((o) => G.getUint32(o, true))
      // A bit cast of a NaN to an integer carries its payload, which nothing pins: held to the payload rule in both modes.
      const cls = classes === null ? (rec.approx?.tag === 'payload' ? 'A' : 'E') : classes[ri]
      const what = `invocation ${k}, record ${ri} (${t}, ${cls}${rec.approx === null ? '' : ` ${rec.approx.fn}`})`
      if (cls === 'W' || (cls === 'A' && mode === 'flush')) {
        tally.wild++
        return
      }
      if (cls === 'E') {
        const fw = F === null ? null : at.map((o) => flushBits(F.getUint32(o, true)))
        rw.forEach((w, c) => {
          // A13's other result: the flushed reference, its subnormal outputs flushed; a subnormal written as it is
          // (a move, which never flushes) is held as the zero it flushes to.
          const ok = sameWord(gw[c], w, isFloat) || (fw !== null && sameWord(isFloat ? flushBits(gw[c]) : gw[c], isFloat ? fw[c] : (F as DataView).getUint32(at[c], true), isFloat))
          if (!ok) fail(`${what} word ${c}: got ${hex(gw[c])}, the reference ${hex(w)}${fw === null ? '' : ` (flushed ${hex(fw[c])})`}`)
          tally.exact++
        })
        return
      }
      // An approximated value (adversarial mode only): unreached in the reference means unreached here too.
      const a = rec.approx as NonNullable<Rec['approx']>
      if (rw.every((w) => w === CANARY)) {
        if (!gw.every((w) => w === CANARY)) fail(`${what}: written, and the reference never reached it`)
        return
      }
      const ops = a.ops.map((oi, o) => words[oi].map((off) => asNum(R.getUint32(off, true), kindOf(a.types[o]))))
      const allow = allowed(a.tag, a.fn, ops, a.types, rw.length)
      tally.tags.set(a.tag, (tally.tags.get(a.tag) ?? 0) + 1)
      allow.forEach((al, c) => {
        const gx = asNum(gw[c], kindOf(t))
        const rx = asNum(rw[c], kindOf(t))
        if (al.k === 'any') {
          tally.open++
        } else if (al.k === 'exact') {
          if (!sameWord(gw[c], rw[c], isFloat)) fail(`${what} word ${c} (${a.tag}, an emulated edge) of ${JSON.stringify(ops)}: got ${hex(gw[c])}, the reference ${hex(rw[c])}`)
          tally.exact++
        } else if (al.k === 'nan') {
          if (!isNanBits(gw[c])) fail(`${what} word ${c}: got ${hex(gw[c])}, not a NaN pattern`)
          tally.exact++
        } else {
          if (!(rx >= al.lo && rx <= al.hi)) fail(`${what} word ${c} (${a.tag}) of ${JSON.stringify(ops)}: the bound [${al.lo}, ${al.hi}] leaves out the reference ${rx}`)
          if (!(gx >= al.lo && gx <= al.hi)) fail(`${what} word ${c} (${a.tag}) of ${JSON.stringify(ops)}: got ${gx}, outside [${al.lo}, ${al.hi}] (the reference ${rx})`)
          tally.bounded++
        }
      })
    })
  }
}

/** Runs a module both ways in every mode and compares; `flushedRef` gives the A13 run's reference output, or null to skip that run. */
function differential(label: string, built: Built, ins: Inputs, flushedRef: (() => Uint8Array) | null, tally: Tally, failures: string[]): void {
  const res = built.g.res
  const code = toWgsl(built.m, lowerOptions(built.m)).code
  const ref = runReference(built.m, res, ins, built.inv)
  compareRuns(`${label} exact`, built, ref, runLowered(code, res, ins, built.inv, { mode: 'exact' }), 'exact', null, tally, failures)
  compareRuns(`${label} adversarial`, built, ref, runLowered(code, res, ins, built.inv, { mode: 'adversarial', except: ['flush'] }), 'adversarial', null, tally, failures)
  if (flushedRef !== null) {
    compareRuns(`${label} flush`, built, ref, runLowered(code, res, ins, built.inv, { mode: 'adversarial' }), 'flush', flushedRef(), tally, failures)
  }
}

/** The inputs a seed gives: words of each kind, as the generator draws them. */
function seededInputs(res: Res4, seed: number): Inputs {
  const r = xorshift32(seed ^ 0x5bd1e995)
  return inputsOf(res, (k) => wordOf(r, k))
}

test('differential: seeded modules give the reference\'s words in exact mode, and in adversarial mode by class (E bit for bit, A within its class)', (t) => {
  const tally = newTally()
  const failures: string[] = []
  const SEEDS = 400
  for (let seed = 1; seed <= SEEDS; seed++) {
    const built = generate(seed, false)
    const ins = seededInputs(built.g.res, seed)
    const flushedRef = (): Uint8Array => {
      const fl = generate(seed, true)
      const out = runReference(fl.m, fl.g.res, flushedInputs(fl.g.res, ins), fl.inv)
      return out
    }
    differential(`seed ${seed}`, built, ins, flushedRef, tally, failures)
  }
  t.diagnostic(`${SEEDS} modules: ${tally.exact} words bit for bit, ${tally.bounded} components within their class, ${tally.open} left open by WGSL, ${tally.wild} records downstream of an approximation; ${[...tally.tags].map(([k, v]) => `${k} ${v}`).join(', ')}`)
  assert.deepEqual(failures, [])
  for (const tag of ['A9', 'A10', 'A11', 'A12', 'A14', 'payload']) assert.ok((tally.tags.get(tag) ?? 0) > 100, `${tag}: ${tally.tags.get(tag) ?? 0} records`)
})

// ---------------------------------------------------------------------------------------------------
// The hand-written families

/** Input words by kind, invocation and index within that kind (uniform and constant words have invocation -1). */
function perLane(word: (k: LensScalar, inv: number, j: number) => number): WordSource {
  const seen = new Map<string, number>()
  return (k, inv) => {
    const key = `${inv}:${k}`
    const j = seen.get(key) ?? 0
    seen.set(key, j + 1)
    return word(k, inv, j) >>> 0
  }
}

/** A family: a body over the invocation's inputs, run on `inv` invocations with the given inputs. */
interface Family {
  readonly name: string
  readonly inv: number
  readonly word: (k: LensScalar, inv: number, j: number) => number
  readonly body: (g: Gen, f: readonly LensVal[], i: readonly LensVal[], u: readonly LensVal[]) => void
}

/** Builds a family twice: once to count the records of each type, then with an output struct just large enough. */
function buildFamily(fam: Family, flushLits: boolean): Built {
  const once = (caps: readonly number[]): Built => {
    const b = lens('compute', { group: [4, 1, 1] })
    const g = new Gen(b, xorshift32(7), declare(b, fam.inv, caps), caps, flushLits)
    const { inp } = g.res
    const read = (k: 'f' | 'i' | 'u', n: number): LensVal[] => Array.from({ length: n }, (_, j) => g.e(b.read(inp, 'lanes', g.inv, k, j), []))
    fam.body(g, read('f', IN_F), read('i', IN_I), read('u', IN_U))
    return { m: b.finish(), g, inv: fam.inv }
  }
  return once(once(OUT_TYPES.map(() => 1024)).g.used.map((n) => Math.max(n, 1)))
}

/** Every pair of the list, `per` pairs to an invocation: pair P is (list[P mod n], list[P / n mod n]). */
const pairs = (list: readonly number[], per: number): number => Math.ceil((list.length * list.length) / per / 4) * 4
function pairWord(list: readonly number[], per: number, inv: number, j: number): number {
  const P = inv * per + (j % per)
  return j < per ? list[P % list.length] : list[Math.floor(P / list.length) % list.length]
}

/** Records exact values. */
const all = (g: Gen, ...vs: readonly LensVal[]): void => {
  for (const v of vs) g.record(v)
}
/** An approximated value, recorded with its operands. */
const approxAll = (g: Gen, v: LensVal, tag: Tag, fn: string, ops: readonly LensVal[]): void => {
  g.a(v, ops, false)
  g.approx(v, tag, fn, ops)
}
const iWords = (list: readonly number[], inv: number, j: number): number => list[(inv * 7 + j * 3) % list.length]

const FAMILIES: readonly Family[] = [
  {
    // Every pair of special f32 values through each operation the ledger calls exact, and the comparisons (A14).
    name: 'exact f32 operations over every pair of special values',
    inv: pairs(F_SPECIAL, 6),
    word: (k, inv, j) => (k === 'f32' && inv >= 0 ? pairWord(F_SPECIAL, 6, inv, j) : k === 'f32' ? F_SPECIAL[j % F_SPECIAL.length] : iWords(k === 'i32' ? I_SPECIAL : U_SPECIAL, Math.max(inv, 0), j)),
    body: (g, f) => {
      const b = g.b
      for (const x of f) {
        for (const fn of F_EXACT1) all(g, g.e(b.unary(fn, x), [x]))
        all(g, g.e(b.length(x), [x]), g.e(b.cast(x, 'i32'), [x]), g.e(b.cast(x, 'u32'), [x]), g.e(b.cast(x, 'bool'), [x]))
        approxAll(g, b.bits(x, 'u32'), 'payload', 'bits', [x])
      }
      for (let j = 0; j < 6; j++) {
        const [x, y, z] = [f[j], f[j + 6], f[(j + 3) % 12]]
        for (const fn of ['min', 'max', 'step'] as const) all(g, g.e(b.binary(fn, x, y), [x, y]))
        const c = g.e(b.cast(x, 'bool'), [x])
        all(g, g.e(b.clamp(x, y, z), [x, y, z]), g.e(b.choose(c, y, x), [c, x, y]))
        for (const fn of COMPARE) approxAll(g, b.binary(fn, x, y), 'A14', fn, [x, y])
      }
      // The vector forms of the helpers.
      const v = [0, 4, 8].map((s) => g.e(b.make('f32x4', f[s], f[s + 1], f[s + 2], f[s + 3]), [f[s], f[s + 1], f[s + 2], f[s + 3]]))
      for (const x of v) for (const fn of F_EXACT1) all(g, g.e(b.unary(fn, x), [x]))
      all(g, g.e(b.min(v[0], v[1]), v), g.e(b.max(v[1], v[2]), v), g.e(b.clamp(v[0], v[1], v[2]), v), g.e(b.step(v[2], v[0]), v), g.e(b.cast(v[0], 'i32x4'), v), g.e(b.cast(v[1], 'u32x4'), v))
    },
  },
  {
    // Every pair of special integers: wrapping, division by zero and MIN / -1, shifts modulo 32, abs(MIN), the casts.
    name: 'integers over every pair of special values',
    inv: Math.max(pairs(I_SPECIAL, 3), pairs(U_SPECIAL, 3)),
    word: (k, inv, j) => (inv < 0 ? 0 : k === 'i32' ? pairWord(I_SPECIAL, 3, inv, j) : k === 'u32' ? pairWord(U_SPECIAL, 3, inv, j) : F_SPECIAL[(inv + j) % F_SPECIAL.length]),
    body: (g, _f, i, u) => {
      const b = g.b
      for (const [xs, k] of [[i, 'i32'], [u, 'u32']] as const) {
        for (let j = 0; j < 3; j++) {
          const [x, y, z] = [xs[j], xs[j + 3], xs[(j + 1) % 3]]
          const count = u[(j + 3) % 6]
          for (const fn of INT2) all(g, g.e(b.binary(fn, x, y), [x, y]))
          all(g, g.e(b.shl(x, count), [x, count]), g.e(b.shr(x, count), [x, count]), g.e(b.clamp(x, y, z), [x, y, z]))
          for (const fn of COMPARE) all(g, g.e(b.binary(fn, x, y), [x, y]))
          all(g, g.e(b.abs(x), [x]), g.e(b.bitnot(x), [x]), g.e(b.cast(x, 'f32'), [x]), g.e(b.cast(x, k === 'i32' ? 'u32' : 'i32'), [x]), g.e(b.cast(x, 'bool'), [x]))
          if (k === 'i32') all(g, g.e(b.neg(x), [x]), g.e(b.sign(x), [x]))
        }
        const t = typeOfWidth(k, 3)
        const v = g.e(b.make(t, xs[0], xs[1], xs[2]), xs)
        const w = g.e(b.make(t, xs[3], xs[4], xs[5]), xs)
        all(g, g.e(b.dot(v, w), [v, w]), g.e(b.div(v, w), [v, w]), g.e(b.rem(v, xs[3]), [v]), g.e(b.cast(v, 'f32x3'), [v]), g.e(b.mul(v, w), [v, w]))
      }
    },
  },
  {
    // The library and the geometry at their edges: every special value, and vectors of them.
    name: 'the library and the geometry over special values',
    inv: Math.ceil(F_SPECIAL.length / IN_F / 4) * 4 * 2,
    word: (k, inv, j) => (k === 'f32' ? F_SPECIAL[(Math.max(inv, 0) * IN_F + j * 5 + (inv >= F_SPECIAL.length / IN_F ? 3 : 0)) % F_SPECIAL.length] : iWords(k === 'i32' ? I_SPECIAL : U_SPECIAL, Math.max(inv, 0), j)),
    body: (g, f) => {
      const b = g.b
      for (const x of f) for (const fn of LIBRARY1) approxAll(g, b.unary(fn, x), 'A12', fn, [x])
      const v3 = [0, 3, 6, 9].map((s) => g.e(b.make('f32x3', f[s], f[s + 1], f[s + 2]), [f[s], f[s + 1], f[s + 2]]))
      const v2 = [0, 2, 4].map((s) => g.e(b.make('f32x2', f[s], f[s + 1]), [f[s], f[s + 1]]))
      for (const v of [...v3, ...v2]) {
        approxAll(g, b.length(v), 'A12', 'length', [v])
        approxAll(g, b.normalize(v), 'A12', 'normalize', [v])
      }
      approxAll(g, b.distance(v3[0], v3[1]), 'A12', 'distance', [v3[0], v3[1]])
      approxAll(g, b.distance(v3[2], v3[2]), 'A12', 'distance', [v3[2], v3[2]])
      approxAll(g, b.dot(v3[1], v3[2]), 'A9', 'dot', [v3[1], v3[2]])
      approxAll(g, b.cross(v3[0], v3[3]), 'A9', 'cross', [v3[0], v3[3]])
      approxAll(g, b.reflect(v2[0], v2[1]), 'A9', 'reflect', [v2[0], v2[1]])
      // Literal operands, where the lowering leaves out what a literal cannot reach.
      for (const x of [0.5, 1, 2, -0.25]) {
        const l = g.lit('f32', [x])
        for (const fn of LIBRARY1) approxAll(g, b.unary(fn, l), 'A12', fn, [l])
      }
      const base = g.lit('f32', [2])
      const ex = g.lit('f32', [1.5])
      approxAll(g, b.pow(base, ex), 'A12', 'pow', [base, ex])
      // A literal base and an exponent known finite that may be zero: pow's edge of exactly 1 still applies.
      for (const x of f) {
        for (const e of [g.e(b.sign(x), [x]), g.e(b.saturate(x), [x])]) approxAll(g, b.pow(base, e), 'A12', 'pow', [base, e])
      }
    },
  },
  {
    // pow, atan2 and the arithmetic over every pair of special values.
    name: 'pow, atan2 and the arithmetic over every pair of special values',
    inv: pairs(F_SPECIAL, 6),
    word: (k, inv, j) => (k === 'f32' && inv >= 0 ? pairWord(F_SPECIAL, 6, inv, j) : k === 'f32' ? F_SPECIAL[j % F_SPECIAL.length] : iWords(k === 'i32' ? I_SPECIAL : U_SPECIAL, Math.max(inv, 0), j)),
    body: (g, f) => {
      const b = g.b
      for (let j = 0; j < 6; j++) {
        const [x, y, z] = [f[j], f[j + 6], f[(j + 1) % 6]]
        approxAll(g, b.pow(x, y), 'A12', 'pow', [x, y])
        approxAll(g, b.atan2(x, y), 'A12', 'atan2', [x, y])
        for (const fn of ['add', 'sub', 'mul'] as const) approxAll(g, b.binary(fn, x, y), 'A9', fn, [x, y])
        approxAll(g, b.div(x, y), 'A10', 'div', [x, y])
        approxAll(g, b.rem(x, y), 'A10', 'rem', [x, y])
        approxAll(g, b.fma(x, y, z), 'A11', 'fma', [x, y, z])
        approxAll(g, b.mix(x, y, z), 'A9', 'mix', [x, y, z])
        approxAll(g, b.smoothstep(z, y, x), 'A10', 'smoothstep', [z, y, x])
        approxAll(g, b.distance(x, y), 'A9', 'distance', [x, y])
      }
    },
  },
  {
    // The loop cap: a loop with no break runs 65,536 times on each entry; one whose break never comes, as many.
    name: 'the loop cap',
    inv: 4,
    word: (k, inv, j) => (k === 'u32' ? [7, 3, 7, 0][Math.max(inv, 0)] + j : 0),
    body: (g, _f, _i, u) => {
      const b = g.b
      const n = g.newVar('u32', g.lit('u32', [0]))
      g.loop(null, () => {
        const x = g.get(n)
        g.set(n, g.e(b.add(x, b.u32(1)), [x]))
      })
      all(g, g.get(n))
      const m = g.newVar('u32', g.lit('u32', [5]))
      const seven = g.lit('u32', [7])
      g.loop(null, () => {
        const stop = g.e(b.eq(u[0], seven), [u[0]], false)
        g.iff(stop, () => g.escape('break'))
        const x = g.get(m)
        g.set(m, g.e(b.add(x, b.u32(3)), [x]))
      })
      all(g, g.get(m))
    },
  },
  {
    // Indices held in values, outside their range: lanes, fixed arrays in uniform, constant and storage blocks.
    name: 'indices outside their range are clamped',
    inv: 12,
    word: (k, inv, j) => {
      if (k === 'i32') return [-1, 0, 1, 2, 3, 4, 5, 0x7fffffff, -0x80000000, 12, -12, 7][(Math.max(inv, 0) + j) % 12]
      if (k === 'u32') return [0, 1, 2, 3, 4, 7, 8, 0xffffffff, 0x80000000, 11, 12, 13][(Math.max(inv, 0) * 5 + j) % 12]
      return fb(f32(inv * 100 + j + 0.5))
    },
    body: (g, f, i, u) => {
      const b = g.b
      const { inp, uni, con } = g.res
      const v4 = g.e(b.make('f32x4', f[0], f[1], f[2], f[3]), f)
      const v2 = g.e(b.make('u32x2', u[4], u[5]), u)
      for (const x of [...i, ...u]) {
        all(g, g.e(b.lane(v4, x), [v4, x]), g.e(b.lane(v2, x), [v2, x]), g.e(b.read(uni, 'arr', x), [x]), g.e(b.read(uni, 'iv', x), [x]), g.e(b.read(con, 'ca', x), [x]))
        all(g, g.e(b.read(inp, 'lanes', x, 'f', x), [x]), g.e(b.read(inp, 'lanes', g.inv, 'u', x), [x]))
      }
    },
  },
  {
    // Control: an early return, nested loops with break and continue under conditions, variables set in branches.
    name: 'control: returns, nested breaks and continues, variables set in branches',
    inv: 16,
    word: (k, inv, j) => (k === 'i32' ? I_SPECIAL[(Math.max(inv, 0) * 3 + j) % I_SPECIAL.length] : k === 'u32' ? [0, 1, 2, 3, 5][(Math.max(inv, 0) + j) % 5] : F_SPECIAL[(Math.max(inv, 0) * 5 + j) % F_SPECIAL.length]),
    body: (g, f, i, u) => {
      const b = g.b
      const acc = g.newVar('i32', g.lit('i32', [0]))
      const best = g.newVar('f32', f[0])
      g.loop(4, () => {
        const a = g.get(acc)
        const skip = g.e(b.lt(i[0], a), [i[0], a], false)
        g.iff(skip, () => {
          const a2 = g.get(acc)
          g.set(acc, g.e(b.add(a2, b.i32(2)), [a2]))
          g.escape('continue')
        })
        g.loop(3, () => {
          const a3 = g.get(acc)
          g.set(acc, g.e(b.add(a3, i[1]), [a3]))
          const a4 = g.get(acc)
          const out = g.e(b.gt(a4, i[2]), [a4, i[2]], false)
          g.iff(out, () => g.escape('break'))
          const m = g.get(best)
          g.set(best, g.e(b.max(m, f[1]), [m]))
        })
        const done = g.e(b.eq(u[0], b.u32(3)), [u[0]], false)
        g.iff(done, () => g.escape('break'))
      })
      all(g, g.get(acc), g.get(best))
      const pick = g.newVar('u32', u[1])
      const which = g.e(b.gt(i[3], b.i32(0)), [i[3]], false)
      g.iff(which, () => g.set(pick, u[2]), () => g.set(pick, g.e(b.add(u[2], u[3]), [u[2], u[3]])))
      all(g, g.get(pick))
      const leave = g.e(b.eq(u[4], b.u32(2)), [u[4]], false)
      g.iff(leave, () => {
        all(g, g.lit('u32', [111]))
        g.escape('return')
      })
      all(g, g.lit('u32', [222]), g.get(pick))
    },
  },
  {
    // Grids: made from scalars and columns, columns and transposes (exact), sums and products (A9).
    name: 'grids',
    inv: 8,
    word: (k, inv, j) => (k === 'f32' ? (inv < 0 ? F_SPECIAL[j % F_SPECIAL.length] : fb(f32((inv - 3) * 0.75 + j * 1.25 - (j % 3) * 0.1))) : 1),
    body: (g, f) => {
      const b = g.b
      const { uni } = g.res
      const m2 = g.e(b.make('m2', f[0], f[1], f[2], f[3]), f)
      const c3 = [0, 3, 6].map((s) => g.e(b.make('f32x3', f[s], f[s + 1], f[s + 2]), f))
      const m3 = g.e(b.make('m3', ...c3), c3)
      const m4 = g.e(b.make('m4', ...f.slice(0, 12), f[0], f[1], f[2], f[3]), f)
      const u3 = g.e(b.read(uni, 'g'), [])
      const u2 = g.e(b.read(uni, 'h'), [])
      for (const m of [m2, m3, m4, u3, u2]) all(g, m, g.e(b.transpose(m), [m]), g.e(b.column(m, 1), [m]))
      // A grid chosen whole, column by column, between two different grids: the first where the condition holds.
      const c = g.e(b.gt(g.inv, g.lit('u32', [3])), [g.inv])
      const t4 = g.e(b.transpose(m4), [m4])
      for (const [p, q] of [[m2, u2], [m3, u3], [m4, t4]] as const) all(g, g.e(b.choose(c, p, q), [c, p, q]), g.e(b.choose(c, q, p), [c, p, q]))
      for (const [p, q] of [[m2, u2], [m3, u3], [m4, m4]] as const) {
        approxAll(g, b.mul(p, q), 'A9', 'mul', [p, q])
        approxAll(g, b.add(p, q), 'A9', 'add', [p, q])
        approxAll(g, b.sub(p, q), 'A9', 'sub', [p, q])
        approxAll(g, b.mul(p, f[5]), 'A9', 'mul', [p, f[5]])
        const col = g.e(b.column(q, 0), [q])
        approxAll(g, b.mul(p, col), 'A9', 'mul', [p, col])
        approxAll(g, b.mul(col, p), 'A9', 'mul', [col, p])
      }
    },
  },
  {
    // What the lowering knows of a value decides which NaN tests it leaves out. A value known never to be NaN that may
    // be infinite (min or max beside a literal) is taken through fract and the roundings (fract of an infinity is NaN)
    // into min, max and clamp, and into the library functions whose native call is left bare only for a finite operand;
    // and pow of literals at its zero edges, which a native call leaves to the accuracy rules.
    name: 'values known never NaN but maybe infinite, through fract, the roundings and the library; pow of literal zeros',
    // Two lanes of each invocation take every special value between them (x), beside two others (y and z).
    inv: Math.ceil(F_SPECIAL.length / 2 / 4) * 4,
    word: (k, inv, j) => (k === 'f32' ? F_SPECIAL[(Math.max(inv, 0) * 2 + (j % 2) + [0, 17, 31][Math.floor(j / 2) % 3]) % F_SPECIAL.length] : iWords(k === 'i32' ? I_SPECIAL : U_SPECIAL, Math.max(inv, 0), j)),
    body: (g, f) => {
      const b = g.b
      // pow first, so its records come before the output's room runs out.
      for (const [a, e] of [[2, 0], [2, -0], [0.5, 0], [0, 2], [-0, 3], [0, -2], [-0, -3], [0, 0], [-0, 0.5]]) {
        const la = g.lit('f32', [a])
        const le = g.lit('f32', [e])
        approxAll(g, b.pow(la, le), 'A12', 'pow', [la, le])
      }
      const va = g.lit('f32x2', [2, 0])
      const ve = g.lit('f32x2', [0, 3])
      approxAll(g, b.pow(va, ve), 'A12', 'pow', [va, ve])
      const hi = g.lit('f32', [1])
      const lo = g.lit('f32', [-1.5])
      for (let j = 0; j < 2; j++) {
        const [x, y, z] = [f[j], f[j + 2], f[j + 4]]
        for (const sure of [g.e(b.max(x, hi), [x]), g.e(b.min(lo, x), [x])]) {
          const chain: LensVal[] = [sure]
          for (const fn of ['floor', 'ceil', 'trunc', 'round'] as const) chain.push(g.e(b.unary(fn, sure), [sure]))
          for (const v of [...chain]) chain.push(g.e(b.unary('fract', v), [v]))
          for (const v of chain) {
            all(g, v, g.e(b.min(v, y), [v, y]), g.e(b.max(v, y), [v, y]), g.e(b.min(y, v), [v, y]), g.e(b.clamp(v, y, z), [v, y, z]), g.e(b.clamp(y, v, z), [v, y, z]))
            for (const fn of ['exp', 'exp2', 'sin', 'cos', 'tan', 'atan'] as const) approxAll(g, b.unary(fn, v), 'A12', fn, [v])
          }
        }
      }
      // Every record found room in the output: under the 1024 of each type buildFamily's first build allows.
      assert.ok(g.used.every((n) => n < 1024), `the family's records fit the output: ${g.used.join(', ')}`)
    },
  },
]

test('differential: hand-written families (special values, integers, the library, the loop cap, clamped indices, control, grids)', (t) => {
  for (const fam of FAMILIES) {
    const tally = newTally()
    const failures: string[] = []
    const built = buildFamily(fam, false)
    const ins = inputsOf(built.g.res, perLane(fam.word))
    const flushedRef = (): Uint8Array => {
      const fl = buildFamily(fam, true)
      return runReference(fl.m, fl.g.res, flushedInputs(fl.g.res, ins), fl.inv)
    }
    differential(fam.name, built, ins, flushedRef, tally, failures)
    t.diagnostic(`${fam.name}: ${tally.exact} words bit for bit, ${tally.bounded} components within their class, ${tally.open} left open; ${[...tally.tags].map(([k, v]) => `${k} ${v}`).join(', ')}`)
    assert.deepEqual(failures, [], fam.name)
  }
})

test('differential: the families pin what they are for (the loop cap, clamped reads, the early return)', () => {
  const words = (fam: Family): { ref: Uint8Array; built: Built } => {
    const built = buildFamily(fam, false)
    return { ref: runReference(built.m, built.g.res, inputsOf(built.g.res, perLane(fam.word)), built.inv), built }
  }
  const read = (x: { ref: Uint8Array; built: Built }, inv: number, rec: number): number => new DataView(x.ref.buffer).getUint32(recordWords(x.built.g.res, x.built.g.recs, inv)[rec][0], true)
  const cap = words(FAMILIES[4])
  assert.deepEqual([0, 1, 2, 3].map((k) => [read(cap, k, 0), read(cap, k, 1)]), [[65_536, 5], [65_536, 5 + 3 * 65_536], [65_536, 5], [65_536, 5 + 3 * 65_536]])
  const ctl = words(FAMILIES[6])
  const n = ctl.built.g.recs.length
  for (let k = 0; k < 16; k++) {
    const returned = [0, 1, 2, 3, 5][(k + 4) % 5] === 2
    assert.equal(read(ctl, k, n - 3), returned ? 111 : CANARY, `invocation ${k}`)
    assert.equal(read(ctl, k, n - 2), returned ? CANARY : 222, `invocation ${k}`)
  }
})

// ===================================================================================================
// The differential, for the stages and images
//
// The differential above runs compute modules of arithmetic. This part runs what images, raw words and the other two
// stages add. Each module is built with builder.ts, run by interp.ts as the reference renderer (soft.ts) runs it,
// lowered by toWgsl, and run by the evaluator in exact mode and in adversarial mode (every freedom but `flush`; the
// modules make no subnormal of their own):
// - IMAGES AND RAW WORDS, in compute modules: texel, extent, explicit-level sample and raw reads at positions, levels,
//   layers and indices in range and out of it, through views that start past level and layer 0, written to raw
//   words at indices in range and out of it; put at positions in range and out of it. Every word written and every
//   byte of the storage image is compared bit for bit (all E: design 12.1; the evaluator samples through texture.ts,
//   so filtering, A7, is the browser check's to bound).
// - VERTEX MODULES, per vertex: draws indexed and not, base vertices that wrap the element past 2^32 or below 0,
//   attributes whose bytes lie past the buffer's end, stride-0 attributes, instance-rate inputs. The reference is
//   handed each attribute by soft.ts's rule (element index + base, zero below element 0 or past the buffer); the
//   lowered module what the GPU's attribute read hands it (element vertex_index, wrapped; past the buffer zero in exact
//   mode and poison in adversarial mode, as WebGPU's robustness allows), with the hidden block design 7.4 asks of the
//   planner. Outputs and the position bit for bit; a vertex the reference leaves unpositioned gives a NaN position
//   and the live value 1, a positioned one the live value 0.
// - FRAGMENT MODULES, per 2 x 2 quad: helper lanes from the start, discard, derivatives, samples, writes and puts after
//   discard, colour outputs shaped to their attachments, the live test. E values bit for bit; a derivative is A16
//   (the fine difference, or in adversarial mode the coarse one) and an implicit-level sample A8 (the sample at the
//   fine level of detail, or in adversarial mode the coarse one), coordinates not finite or past 2^24 included, since
//   the lowering takes the rates from the raw coordinate, as the reference does. A quad whose live
//   value is not exactly zero lies in a triangle the reference never draws: all four lanes are discarded and nothing
//   changes.

/** Interp's program, bound to a module's resources by index. */
function bindReference(m: LensModule, blocks: ReadonlyMap<number, Uint8Array>, images: ReadonlyMap<number, ImageBinding>, samplers: ReadonlyMap<number, SamplerState>): { program: LensProgram; bindings: LensBindings } {
  const program = compileLens(m)
  const bindings = program.bind({
    block: (i) => {
      const x = blocks.get(i)
      return x === undefined ? null : { bytes: x, offset: 0, size: x.length }
    },
    image: (i) => images.get(i) ?? null,
    sampler: (i) => samplers.get(i) ?? null,
    storageImage: (i) => images.get(i) ?? null,
  })
  return { program, bindings }
}

/** The evaluator's resources for the same bindings: by `${set}:${binding}`, the hidden block beside them. */
function evaluatorResources(m: LensModule, blocks: ReadonlyMap<number, Uint8Array>, images: ReadonlyMap<number, ImageBinding>, samplers: ReadonlyMap<number, SamplerState>, hidden: Uint8Array): Resources {
  const out: { [key: string]: Resource } = { [`${WGSL_HIDDEN.group}:${WGSL_HIDDEN.binding}`]: { bytes: hidden } }
  m.resources.forEach((r, i) => {
    if (r.kind === 'constants') return
    const key = `${r.set}:${r.binding}`
    const bytes = blocks.get(i)
    const image = images.get(i)
    const sampler = samplers.get(i)
    if (bytes !== undefined) out[key] = { bytes }
    else if (image !== undefined) out[key] = image
    else if (sampler !== undefined) out[key] = { sampler }
  })
  return out
}

/** The options a module of this part is lowered with: storage access by writability, and the stage's own. */
const stageOptions = (m: LensModule, over: Partial<Parameters<typeof toWgsl>[1]> = {}): Parameters<typeof toWgsl>[1] => ({ ...lowerOptions(m), ...over })

const STAGE_ADVERSARIAL: RunOptions = { mode: 'adversarial', except: ['flush'] }

/** A float image's formats, an integer or depth image's, and a storage image's. */
const FLOAT_FORMATS: readonly Format[] = ['rgba8', 'rgba16f', 'r32f', 'rgba32f']
const STORAGE_FORMATS_ALL: readonly Format[] = ['rgba8', 'rgba16f', 'r32f', 'rg32f', 'rgba32f', 'r32u', 'r32i']

/** A seeded sampler: any filters and wraps, a level range within [0, 32]. */
function samplerOf(r: (n: number) => number): SamplerState {
  const filter = (): 'nearest' | 'linear' => (r(2) === 0 ? 'nearest' : 'linear')
  const wrap = (): 'clamp' | 'repeat' | 'mirror' => (['clamp', 'repeat', 'mirror'] as const)[r(3)]
  const lo = [0, 0, 0, 0.5, 1, 2][r(6)]
  const hi = Math.max(lo, [0, 1, 2, 3, 32, 32][r(6)])
  return { mag: filter(), min: filter(), mip: filter(), wrap: [wrap(), wrap(), 'clamp'], lodMin: lo, lodMax: hi }
}

/**
 * A seeded image and a view of it (a 2d view shows one layer), each texel filled with words of its kind; `big` makes
 * it 4 to 8 texels a side, so it has levels a sample's level of detail reaches.
 */
function seededImage(r: (n: number) => number, format: Format, arrayed: boolean, storage: boolean, big = false): ImageBinding {
  const width = big ? 4 + r(5) : 1 + r(5)
  const height = big ? 4 + r(5) : 1 + r(4)
  const most = 1 + Math.floor(Math.log2(Math.max(width, height)))
  const levels = storage ? 1 + r(2) : big ? 2 + r(2) : 1 + r(Math.min(3, most))
  const layers = 1 + r(3)
  const store = new ImageStore({ format, width: Math.max(width, levels > 1 ? 2 : 1), height: Math.max(height, levels > 1 ? 2 : 1), layers, levels, samples: 1 })
  const kind = sampleKind(format)
  for (let q = 0; q < levels; q++) {
    for (let k = 0; k < layers; k++) {
      for (let y = 0; y < store.levelHeight(q); y++) {
        for (let x = 0; x < store.levelWidth(q); x++) {
          const one = (): number => (kind === 'uint' ? wordOf(r, 'u32') : kind === 'sint' ? wordOf(r, 'i32') | 0 : kind === 'depth' ? r(1000) / 1000 : r(8) === 0 ? bf(wordOf(r, 'f32')) : (r(512) - 256) / 64)
          store.write(q, k, x, y, 0, [one(), one(), one(), one()])
        }
      }
    }
  }
  const lb = big ? r(2) === 0 ? 0 : 1 : r(levels)
  const kb = r(layers)
  const view: ViewRange = {
    levels: { base: lb, count: storage ? 1 : big ? levels - lb : 1 + r(levels - lb) },
    layers: { base: kb, count: storage || !arrayed ? 1 : 1 + r(layers - kb) },
  }
  return { store, view }
}

/** A copy of an image binding with its own bytes, for a run that writes it. */
const copyImage = (b: ImageBinding): ImageBinding => ({ store: new ImageStore(b.store, new Uint8Array(b.store.bytes)), view: b.view })

/** Words of a byte array (a multiple of 4 long). */
const words32 = (bytes: Uint8Array): number[] => wordsIn(bytes)

// ---------------------------------------------------------------------------------------------------
// Images and raw words in compute

/** Input words per invocation, records per invocation, and invocations. */
const IMG_WORDS = 24
const IMG_RECS = 10
const IMG_INV = 8

/**
 * The layouts a raw source block takes: a fixed part (or none) and a final array of a value or a struct, with arrays of
 * fixed length in the fixed part and inside the final array's element (of one word, of two, and of grids).
 */
const RAW_SOURCES: readonly Parameters<LensBuilder['storage']>[2][] = [
  { n: 'u32', xs: arrayOf('f32x3') },
  { head: 'm2', items: arrayOf({ a: 'i32', v: 'f32x2', g: 'm3' }) },
  { xs: arrayOf('u32') },
  { pad: 'f32x2', k: 'i32', ws: arrayOf({ w: 'u32x2' }) },
  { pair: arrayOf('f32x2', 3), xs: arrayOf({ q: arrayOf('i32', 2), w: 'u32' }) },
  { n: 'u32', gs: arrayOf('m2', 2), ys: arrayOf({ k: arrayOf('u32x2', 3), g: arrayOf('m3', 2) }) },
]

/** The record fields of the raw output block's final array. */
const DST_ELEMENT = { f: 'f32x4', u: 'u32x4', i: 'i32x4', s: 'f32', e: 'u32x2', g: 'm2', v: 'f32x3', w: 'u32', a: 'i32', h: 'f32x2', g3: 'm3', w2: 'u32x2' } as const
/** The field a leaf of a raw source block is written to. */
const DST_FIELD: { readonly [t: string]: keyof typeof DST_ELEMENT } = { f32x3: 'v', i32: 'a', f32x2: 'h', m3: 'g3', u32: 'w', m2: 'g', u32x2: 'w2' }

interface ImageBuilt {
  readonly m: LensModule
  readonly src: number
  readonly dst: number
}

/** A seeded compute module of images and raw words (see the head of this part). */
function imageModule(seed: number): ImageBuilt {
  const r = xorshift32(seed)
  const b = lens('compute', { group: [4, 1, 1] })
  const inp = b.storage(0, 0, { w: arrayOf('u32') })
  const srcSpec = RAW_SOURCES[r(RAW_SOURCES.length)]
  const src = b.storage(0, 1, srcSpec)
  const dst = b.storage(1, 0, { head: 'u32', ys: arrayOf({ ...DST_ELEMENT }) }, { writable: true })
  const img = b.image(0, 2, { dims: r(2) === 0 ? '2d' : '2d-array' })
  const other = b.image(0, 3, [{ sample: 'uint', dims: '2d' }, { sample: 'sint', dims: '2d-array' }, { sample: 'depth', dims: '2d' }, { sample: 'depth', dims: '2d-array' }][r(4)] as { sample: 'uint' | 'sint' | 'depth'; dims: '2d' | '2d-array' })
  const smp = b.sampler(0, 4)
  const st = b.storageImage(1, 1, STORAGE_FORMATS_ALL[r(STORAGE_FORMATS_ALL.length)])
  const inv = b.pick(b.builtin('global-id'), 'x')
  const base = b.mul(inv, b.u32(IMG_WORDS))
  let next = 0
  const word = (): LensVal => b.read(inp, 'w', b.add(base, b.u32(next++ % IMG_WORDS)))
  const int = (): LensVal => (r(2) === 0 ? word() : b.bits(word(), 'i32'))
  const pos = (): LensVal => (r(2) === 0 ? b.make('u32x2', word(), word()) : b.make('i32x2', b.bits(word(), 'i32'), b.bits(word(), 'i32')))
  const layerOf = (dims: string): { layer?: LensVal } => (dims === '2d-array' ? { layer: int() } : {})
  let k = 0
  const rec = (field: keyof typeof DST_ELEMENT, v: LensVal): void => {
    // A record's own element, or now and then one an input word names (anywhere: clamped into the elements held).
    const at = r(6) === 0 ? int() : b.add(b.mul(inv, b.u32(IMG_RECS)), b.u32(k))
    k++
    b.write(dst, ['ys', at, field], v)
  }
  // The leaves of the raw source block: paths with each index into the final array from an input word, or a constant.
  const leaves: { path: () => PathStep[]; t: ValueType }[] = []
  const walk = (blk: Block, prefix: () => PathStep[]): void => {
    for (const f of blk.fields) {
      const t = f.type
      if (typeof t === 'string') leaves.push({ path: () => [...prefix(), f.name], t })
      else if ('struct' in t) walk(t.struct, () => [...prefix(), f.name])
      else {
        const e = t.array
        // A constant index into an array of fixed length lies inside it (the verifier refuses one outside).
        const len = t.len
        const at = (): PathStep[] => [...prefix(), f.name, r(4) === 0 ? r(len === 0 ? 3 : len) : int()]
        if (typeof e === 'string') leaves.push({ path: at, t: e })
        else if ('struct' in e) walk(e.struct, at)
      }
    }
  }
  walk(src.block, () => [])
  for (let n = 0; n < IMG_RECS; n++) {
    switch (r(8)) {
      case 0:
        rec('f', b.texel(img, pos(), { level: int(), ...layerOf(img.dims) }))
        break
      case 1:
        rec(other.sample === 'uint' ? 'u' : other.sample === 'sint' ? 'i' : 's', b.texel(other, pos(), { level: int(), ...layerOf(other.dims) }))
        break
      case 2: rec('e', b.extent(r(2) === 0 ? img : other, int())); break
      case 3: rec('e', b.extent(st)); break
      case 4:
        rec('f', b.sample(img, smp, b.make('f32x2', b.bits(word(), 'f32'), b.bits(word(), 'f32')), { level: b.bits(word(), 'f32'), ...layerOf(img.dims) }))
        break
      case 5: case 6: {
        const leaf = leaves[r(leaves.length)]
        rec(DST_FIELD[leaf.t], b.read(src, ...leaf.path()))
        break
      }
      default: {
        const kind = sampleKind(st.format)
        const v = kind === 'uint' ? b.make('u32x4', word(), word(), word(), word()) : kind === 'sint' ? b.bits(b.make('u32x4', word(), word(), word(), word()), 'i32x4')
          : r(2) === 0 ? b.texel(img, pos(), { level: int(), ...layerOf(img.dims) }) : b.bits(b.make('u32x4', word(), word(), word(), word()), 'f32x4')
        b.put(st, pos(), v)
      }
    }
  }
  return { m: b.finish(), src: src.res, dst: dst.res }
}

/** The bytes and images one seed's module runs on (the same seed gives the same ones). */
interface ImageInputs {
  readonly blocks: Map<number, Uint8Array>
  readonly images: Map<number, ImageBinding>
  readonly samplers: Map<number, SamplerState>
}

function imageInputs(built: ImageBuilt, seed: number): ImageInputs {
  const r = xorshift32(seed ^ 0x2545f491)
  const m = built.m
  const blocks = new Map<number, Uint8Array>()
  const images = new Map<number, ImageBinding>()
  const samplers = new Map<number, SamplerState>()
  // Input words: positions, levels, layers and indices near the edges, and f32 coordinates and levels of every kind.
  const edge = (): number => [0, 1, 2, 3, 4, 5, 7, 0xffffffff, 0xfffffffe, 0x80000000, 0x7fffffff, 33, 40][r(13)]
  blocks.set(0, wordsOf(Array.from({ length: IMG_INV * IMG_WORDS }, () => (r(3) === 0 ? wordOf(r, 'f32') : r(2) === 0 ? edge() : r(4) === 0 ? fb((r(64) - 16) / 8) : r(6)))))
  // The source holds its fixed part, then 0 to 5 whole elements and maybe part of another.
  const srcBlock = (m.resources[built.src] as { block: Block }).block
  const lay = layoutBlock(srcBlock, 'storage')
  const start = lay.offsets[lay.offsets.length - 1]
  const last = srcBlock.fields[srcBlock.fields.length - 1].type as { array: DataType }
  const stride = lensStrideOf(last.array, 'storage')
  const srcBytes = start + [0, 1, 2, 5][r(4)] * stride + (r(3) === 0 ? 4 * r(stride / 4) : 0)
  blocks.set(built.src, wordsOf(Array.from({ length: Math.max(1, srcBytes / 4) }, () => wordOf(r, ['f32', 'u32', 'i32'][r(3)] as LensScalar))).subarray(0, Math.max(4, srcBytes)))
  // The output: canaries, room for every record, or for fewer (some writes dropped), or for none.
  const dstBlock = (m.resources[built.dst] as { block: Block }).block
  const dlay = layoutBlock(dstBlock, 'storage')
  const dstart = dlay.offsets[dlay.offsets.length - 1]
  const dstride = lensStrideOf((dstBlock.fields[1].type as { array: DataType }).array, 'storage')
  const held = [IMG_INV * IMG_RECS, IMG_INV * IMG_RECS - 3, 5, 0][r(4)]
  const dst = new Uint8Array(dstart + held * dstride)
  new DataView(dst.buffer).setUint32(0, CANARY, true)
  for (let at = 4; at < dst.length; at += 4) dst.copyWithin(at, 0, 4)
  blocks.set(built.dst, dst)
  m.resources.forEach((res, i) => {
    if (res.kind === 'image') {
      const format: Format = res.sample === 'float' ? FLOAT_FORMATS[r(FLOAT_FORMATS.length)] : res.sample === 'uint' ? 'r32u' : res.sample === 'sint' ? 'r32i' : r(2) === 0 ? 'depth32f' : 'depth16'
      images.set(i, seededImage(r, format, res.dims === '2d-array', false))
    } else if (res.kind === 'storage-image') images.set(i, seededImage(r, res.format, false, true))
    else if (res.kind === 'sampler') samplers.set(i, samplerOf(r))
  })
  return { blocks, images, samplers }
}

/** The f32 words of the raw output block (a NaN there equals any NaN: payloads are not pinned). */
function floatWords(block: Block, bytes: number): Set<number> {
  const lay = layoutBlock(block, 'storage')
  const start = lay.offsets[lay.offsets.length - 1]
  const elem = (block.fields[block.fields.length - 1].type as { array: { struct: Block } }).array.struct
  const stride = lensStrideOf({ struct: elem }, 'storage')
  const out = new Set<number>()
  for (let e = 0; start + (e + 1) * stride <= bytes; e++) eachWord(elem, 'storage', start + e * stride, (k, at) => {
    if (k === 'f32') out.add(at)
  })
  return out
}

/** Runs one seed's module both ways in one mode; returns the messages of what differs. */
function imageRun(seed: number, mode: RunOptions, count: { words: number; texels: number }): string[] {
  const built = imageModule(seed)
  const ins = imageInputs(built, seed)
  const m = built.m
  const copies = (): { blocks: Map<number, Uint8Array>; images: Map<number, ImageBinding> } => ({
    blocks: new Map([...ins.blocks].map(([i, x]) => [i, new Uint8Array(x)])),
    images: new Map([...ins.images].map(([i, x]) => [i, m.resources[i].kind === 'storage-image' ? copyImage(x) : x])),
  })
  const ref = copies()
  const { program, bindings } = bindReference(m, ref.blocks, ref.images, ins.samplers)
  dispatchLens(program, bindings, [IMG_INV / 4, 1, 1], 1e8)
  const got = copies()
  const code = toWgsl(m, stageOptions(m)).code
  new Program(code, { budget: 1e8, ...mode }).dispatch([IMG_INV / 4, 1, 1], evaluatorResources(m, got.blocks, got.images, ins.samplers, new Uint8Array(WGSL_HIDDEN.size)))
  const bad: string[] = []
  const rw = words32(ref.blocks.get(built.dst) as Uint8Array)
  const gw = words32(got.blocks.get(built.dst) as Uint8Array)
  const floats = floatWords((m.resources[built.dst] as { block: Block }).block, rw.length * 4)
  rw.forEach((w, i) => {
    count.words++
    if (!sameWord(gw[i], w, floats.has(4 * i))) bad.push(`image seed ${seed} ${mode.mode}: output word ${i}: got ${hex(gw[i])}, the reference ${hex(w)}`)
  })
  m.resources.forEach((res, i) => {
    if (res.kind !== 'storage-image') return
    const a = (ref.images.get(i) as ImageBinding).store.bytes
    const g = (got.images.get(i) as ImageBinding).store.bytes
    count.texels += a.length
    const at = a.findIndex((x, j) => x !== g[j])
    if (at >= 0) bad.push(`image seed ${seed} ${mode.mode}: storage image byte ${at}: got ${g[at]}, the reference ${a[at]}`)
  })
  return bad
}

test('differential: images and raw words in compute modules, every word and texel bit for bit in both modes', (t) => {
  const SEEDS = 120
  const failures: string[] = []
  const count = { words: 0, texels: 0 }
  const ops = new Map<string, number>()
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const mode of [EXACT_RUN, STAGE_ADVERSARIAL]) failures.push(...imageRun(seed, mode, count))
    const tally = (insts: readonly Inst[]): void => {
      for (const i of insts) ops.set(i.op, (ops.get(i.op) ?? 0) + 1)
    }
    tally(imageModule(seed).m.body)
  }
  t.diagnostic(`${SEEDS} modules, two modes: ${count.words} output words and ${count.texels} storage image bytes compared; ${['texel', 'extent', 'sample', 'put', 'read', 'write'].map((o) => `${o} ${ops.get(o) ?? 0}`).join(', ')}`)
  assert.deepEqual(failures.slice(0, 12), [])
  for (const o of ['texel', 'extent', 'sample', 'put']) assert.ok((ops.get(o) ?? 0) > 100, `${o}: ${ops.get(o) ?? 0}`)
})

// ---------------------------------------------------------------------------------------------------
// Vertex modules, per vertex

/** The input types a vertex module's ports take. */
const VERTEX_INPUTS: readonly ValueType[] = ['f32', 'f32x2', 'f32x3', 'f32x4', 'u32', 'u32x2', 'u32x4', 'i32', 'i32x3', 'i32x4']

/** A seeded order of the 16 slots. */
function slotOrder(r: (n: number) => number): number[] {
  const s = Array.from({ length: 16 }, (_, i) => i)
  for (let i = 15; i > 0; i--) {
    const j = r(i + 1)
    ;[s[i], s[j]] = [s[j], s[i]]
  }
  return s
}

/** Pools of values by type, for the E operations the stage generators use. */
class Pools {
  readonly b: LensBuilder
  readonly r: (n: number) => number
  readonly by = new Map<ValueType, LensVal[]>()

  constructor(b: LensBuilder, r: (n: number) => number) {
    this.b = b
    this.r = r
  }

  keep(v: LensVal): LensVal {
    const list = this.by.get(v.t)
    if (list === undefined) this.by.set(v.t, [v])
    else list.push(v)
    return v
  }

  has(t: ValueType): boolean {
    return (this.by.get(t)?.length ?? 0) > 0
  }

  any(t: ValueType): LensVal {
    const list = this.by.get(t) as LensVal[]
    return list[this.r(list.length)]
  }

  /** A value of type t: pooled, or built from pooled scalars (literals where none is pooled). */
  want(t: ValueType): LensVal {
    if (this.has(t) && this.r(4) !== 0) return this.any(t)
    const k = kindOf(t)
    const n = lensWidthOf(t)
    const one = (): LensVal => (this.has(k) && this.r(3) !== 0 ? this.any(k) : this.b.lit(k, k === 'f32' ? (this.r(64) - 32) / 4 : k === 'i32' ? this.r(64) - 32 : this.r(64)))
    return this.keep(n === 1 ? one() : this.b.make(t, ...Array.from({ length: n }, one)))
  }

  /** `body` with the pools as they are, dropping what it pools when it ends (a value made in a branch stays in it). */
  scoped(body: () => void): () => void {
    return (): void => {
      const saved = new Map([...this.by].map(([t, l]) => [t, [...l]]))
      body()
      this.by.clear()
      for (const [t, l] of saved) this.by.set(t, l)
    }
  }

  /** One exact operation (design 12.1) over pooled values. */
  step(): void {
    const b = this.b
    const r = this.r
    switch (r(9)) {
      case 0: { const t = (['u32', 'i32'] as const)[r(2)]; this.keep(b.binary((['add', 'xor', 'min', 'max', 'mul', 'and'] as const)[r(6)], this.want(t), this.want(t))); break }
      case 1: { const v = this.want((['f32x4', 'u32x2', 'i32x3', 'f32x2'] as const)[r(4)]); this.keep(b.pick(v, 'xyzw'[r(lensWidthOf(v.t))])); break }
      case 2: this.keep(b.make('f32x4', this.want('f32'), this.want('f32'), this.want('f32'), this.want('f32'))); break
      case 3: this.keep(b.cast(this.want('f32'), r(2) === 0 ? 'i32' : 'u32')); break
      case 4: this.keep(b.cast(this.want(r(2) === 0 ? 'i32' : 'u32'), 'f32')); break
      case 5: this.keep(b.bits(this.want('u32'), 'i32')); this.keep(b.bits(this.want('i32'), 'u32')); break
      case 6: { const t = (['f32', 'f32x4'] as const)[r(2)]; this.keep(b.unary(r(2) === 0 ? 'neg' : 'abs', this.want(t))); break }
      case 7: { const t = (['f32', 'u32', 'f32x2', 'i32'] as const)[r(4)]; this.keep(b.choose(b.lt(this.want('u32'), this.want('u32')), this.want(t), this.want(t))); break }
      default: this.keep(b.bits(this.want('u32'), 'f32'))
    }
  }
}

interface VertexBuilt {
  readonly m: LensModule
  /** The uniform block's resource, or -1. */
  readonly uni: number
}

/** A seeded vertex module: inputs, builtins, a uniform block, E operations, outputs, and the position written or not. */
function vertexModule(seed: number): VertexBuilt {
  const r = xorshift32(seed)
  const b = lens('vertex')
  const p = new Pools(b, r)
  const order = slotOrder(r)
  const nIn = 1 + r(5)
  const ins = Array.from({ length: nIn }, (_, i) => ({ slot: order[i], type: VERTEX_INPUTS[r(VERTEX_INPUTS.length)] }))
  for (const port of ins) p.keep(b.input(port.slot, port.type))
  if (r(3) !== 0) p.keep(b.builtin('vertex-index'))
  if (r(2) === 0) p.keep(b.builtin('instance-index'))
  let uni = -1
  if (r(2) === 0) {
    const u = b.uniform(0, 0, { s: 'f32', n: 'u32', v: 'f32x4' })
    uni = u.res
    p.keep(b.read(u, 's'))
    p.keep(b.read(u, 'n'))
    p.keep(b.read(u, 'v'))
  }
  const steps = (n: number): void => {
    for (let i = 0; i < n; i++) p.step()
  }
  steps(4 + r(8))
  const outSlots = slotOrder(r)
  const outs = outSlots.slice(0, 1 + r(4)).map((slot) => {
    const t = (['f32', 'f32x2', 'f32x4', 'u32', 'i32x2', 'u32x4'] as const)[r(6)]
    return b.output(slot, t, { flat: t.startsWith('f32') ? r(4) === 0 : true })
  })
  // Most inputs are handed on whole as well, so what the limit selects give them reaches an output.
  const direct = ins.filter(() => r(5) !== 0).map((port, i) => ({ v: b.in(port.slot), o: b.output(outSlots[outs.length + i], port.type, { flat: !port.type.startsWith('f32') }) }))
  for (const d of direct) b.out(d.o, d.v)
  const write = (): void => {
    for (const o of outs) if (r(3) !== 0) b.out(o, p.want(o.t))
  }
  const pos = p.scoped(() => b.position(p.want('f32x4')))
  const c = (): LensVal => b.gt(p.want('u32'), p.want('u32'))
  write()
  // The position written at the top level, in both branches, in one, after a return (directly in a branch, in a loop
  // in a branch, or in the else branch of a nested if), only in a loop, or never.
  switch (r(8)) {
    case 0: pos(); break
    case 1: b.if(c(), pos, pos); break
    case 2: b.if(c(), pos); break
    case 3: b.if(c(), () => b.return()); pos(); break
    case 4: b.loop(() => { pos(); b.break() }); break
    case 5: b.if(c(), () => b.loop(() => b.return())); pos(); break
    case 6: b.if(c(), p.scoped(() => b.if(c(), p.scoped(write), () => b.return()))); pos(); break
    default: break
  }
  steps(r(4))
  write()
  return { m: b.finish(), uni }
}

/** One attribute as a draw binds it: its offset in an element, the stride, the bytes from the binding's start. */
interface VertexAttr {
  readonly o: number
  readonly stride: number
  readonly bytes: Uint8Array
}

/** The value of `n` words of a kind read at byte `at` of an attribute's bytes. */
function attrRead(a: VertexAttr, at: number, t: ValueType): number[] {
  const d = new DataView(a.bytes.buffer, a.bytes.byteOffset, a.bytes.length)
  const k = kindOf(t)
  return Array.from({ length: lensWidthOf(t) }, (_, c) => (k === 'f32' ? d.getFloat32(at + 4 * c, true) : k === 'i32' ? d.getInt32(at + 4 * c, true) : d.getUint32(at + 4 * c, true)))
}

/** One draw: indexed or not, its base vertex, its elements, its instance, and each input's attribute. */
interface Draw {
  readonly indexed: boolean
  readonly base: number
  /** Indexed: the indices; otherwise the elements firstVertex + i. */
  readonly at: readonly number[]
  readonly instance: number
  readonly attrs: ReadonlyMap<number, VertexAttr>
}

function drawOf(r: (n: number) => number, m: LensModule, rate: number): Draw {
  const indexed = r(3) !== 0
  const base = indexed ? [0, 0, 2, -1, -3, 5, 0x7fffffff, -0x80000000, -0x7ffffffe, 1000][r(10)] : 0
  const count = 1 + r(9)
  const first = r(4)
  const special = [0xffffffff, 0xfffffffe, 0x80000000, 0x7fffffff, 0x80000001]
  // Indices: small ones, ones near 2^32 (with a base above 0 the element passes 2^32 and vertex_index wraps to a small
  // one), ones that with the base land on an element near the edge or a small one, and the special values.
  const index = (): number => {
    switch (r(6)) {
      case 0: case 1: return r(8)
      case 2: return 0xffffffff - r(4)
      case 3: return special[r(special.length)]
      case 4: return (r(6) - base) >>> 0
      default: return (special[r(special.length)] - base) >>> 0
    }
  }
  const at = Array.from({ length: count }, (_, i) => (indexed ? index() : first + i))
  const instance = r(3)
  const attrs = new Map<number, VertexAttr>()
  for (const p of m.inputs) {
    const n = 4 * lensWidthOf(p.type)
    const o = 4 * r(3)
    const stride = [0, n, n + 4, 32, 4][r(5)]
    const perVertex = ((rate >>> p.slot) & 1) === 1
    // Bytes from the binding's start: past every element the core checks (instance-rate inputs, draws that are not
    // indexed), or, for an indexed draw, any size: none whole, a few elements, many.
    const reach = (e: number): number => o + e * stride + n
    const need = perVertex && !indexed ? reach(first + count - 1) : !perVertex ? reach(instance) : 0
    const size = need > 0 ? need + 4 * r(3) : [o + n - 4, reach(r(4)), reach(8) + 4 * r(4), 0][r(4)]
    const bytes = wordsOf(Array.from({ length: Math.max(1, Math.ceil(Math.max(0, size) / 4)) }, () => wordOf(r, kindOf(p.type)))).subarray(0, Math.max(0, size))
    attrs.set(p.slot, { o, stride, bytes })
  }
  return { indexed, base, at, instance, attrs }
}

/** The hidden block of a draw, as design 7.4 asks the planner to write it. */
function hiddenOf(m: LensModule, d: Draw, rate: number): Uint8Array {
  const out = new Uint8Array(WGSL_HIDDEN.size)
  const v = new DataView(out.buffer)
  if (!d.indexed) return out
  let none = 0
  let checked = 0
  for (const p of m.inputs) {
    if (((rate >>> p.slot) & 1) === 0) continue
    const a = d.attrs.get(p.slot) as VertexAttr
    const n = 4 * lensWidthOf(p.type)
    const bit = 1 << p.slot
    if (a.bytes.length < a.o + n) none |= bit
    else v.setUint32(WGSL_HIDDEN.lim + 4 * p.slot, a.stride === 0 ? 0xffffffff : Math.floor((a.bytes.length - a.o - n) / a.stride), true)
    checked |= bit
  }
  v.setUint32(WGSL_HIDDEN.none, none >>> 0, true)
  v.setUint32(WGSL_HIDDEN.checked, checked >>> 0, true)
  v.setInt32(WGSL_HIDDEN.base, d.base, true)
  return out
}

/** The bits of a component of a kind, for comparing (an f32 NaN as one pattern). */
const bitsOf = (x: number, k: LensScalar): number => (k === 'f32' ? (Number.isNaN(x) ? NAN_BITS : fb(x)) : x >>> 0)

/**
 * A seed's vertex module and the options it is lowered with: inputs fed per vertex or per instance, and a free
 * location for the live value when the module may leave its position unwritten; with the generator its draws go on
 * from.
 */
function vertexCase(seed: number): { built: VertexBuilt; rate: number; live: number | null; options: Parameters<typeof toWgsl>[1]; r: (n: number) => number } {
  const built = vertexModule(seed)
  const m = built.m
  const r = xorshift32(seed ^ 0x68e31da4)
  const rate = m.inputs.reduce((acc, p) => acc | (r(4) !== 0 ? 1 << p.slot : 0), 0)
  const used = new Set(m.outputs.map((p) => p.slot))
  const free = Array.from({ length: 16 }, (_, s) => s).filter((s) => !used.has(s))
  const live = !positionSure(m) && r(3) !== 0 ? free[r(free.length)] : null
  return { built, rate, live, options: stageOptions(m, { vertexRate: rate, live }), r }
}

/**
 * Holds that the locations a lowered entry hands on (vertex) or takes (fragment) are flat exactly where their ports
 * are, f32 ports included, and that the live value is interpolated. Neither run interpolates (each lane is handed its
 * location values), so the interface is checked as printed: an f32 port without @interpolate(flat) would be
 * interpolated across the triangle where the reference takes the first vertex's value.
 */
function interpolation(p: Program, stage: 'vertex' | 'fragment', ports: readonly Port[], live: number | null, what: string): string[] {
  const f = p.entry(stage)
  const bad: string[] = []
  const seen = new Set<number>()
  for (const s of stage === 'vertex' ? f.outputs : f.inputs) {
    if (!('location' in s.io)) continue
    const at = s.io.location
    seen.add(at)
    const port = ports.find((q) => q.slot === at)
    if (port === undefined && at !== live) bad.push(`${what}: location ${at} is neither a port nor the live value`)
    const flat = port !== undefined && port.flat === true
    if (s.io.flat !== flat) bad.push(`${what}: location ${at} is ${s.io.flat ? '' : 'not '}flat, and its ${port === undefined ? 'live value is interpolated' : `port is ${flat ? '' : 'not '}flat`}`)
  }
  for (const q of ports) if (!seen.has(q.slot)) bad.push(`${what}: port ${q.slot} has no location`)
  if (live !== null && !seen.has(live)) bad.push(`${what}: the live value at ${live} has no location`)
  return bad
}

/** Runs one seed's vertex module over its draws both ways in one mode; returns the messages of what differs. */
function vertexRun(seed: number, mode: RunOptions, count: { vertices: number; words: number; unpositioned: number; zeroed: number; flat: number }): string[] {
  const { built, rate, live, options, r } = vertexCase(seed)
  const m = built.m
  const code = toWgsl(m, options).code
  const lowered = new Program(code, { budget: 1e8, ...mode })
  const uni = new Map<number, Uint8Array>()
  if (built.uni >= 0) uni.set(built.uni, wordsOf(Array.from({ length: 8 }, (_, i) => wordOf(r, i === 1 ? 'u32' : 'f32'))))
  const { program, bindings } = bindReference(m, uni, new Map(), new Map())
  const bad: string[] = interpolation(lowered, 'vertex', m.outputs, live, `vertex seed ${seed} ${mode.mode}`)
  count.flat += m.outputs.filter((q) => q.flat === true && kindOf(q.type) === 'f32').length
  for (let k = 0; k < 4; k++) {
    const d = drawOf(r, m, rate)
    const hidden = hiddenOf(m, d, rate)
    // The reference: soft.ts's attribute rule at element index + base.
    const elements = d.at.map((x) => (d.indexed ? x + d.base : x))
    const refOut: { pos: number[]; positioned: boolean; outs: Map<number, number[]> }[] = []
    for (let first = 0; first < elements.length; first += LANES) {
      const lanes = Math.min(LANES, elements.length - first)
      const inputs = new Float64Array(lanes * program.inputWidth)
      const vi = new Float64Array(lanes)
      const ii = new Float64Array(lanes)
      for (let l = 0; l < lanes; l++) {
        const element = elements[first + l]
        vi[l] = element >>> 0
        ii[l] = d.instance
        for (const p of program.inputs) {
          const a = d.attrs.get(p.slot) as VertexAttr
          const e = ((rate >>> p.slot) & 1) === 1 ? element : d.instance
          const at = a.o + e * a.stride
          const inside = e >= 0 && at + 4 * p.size <= a.bytes.length
          const vals = inside ? attrRead(a, at, p.type) : new Array<number>(p.size).fill(0)
          if (!inside) count.zeroed++
          vals.forEach((x, c) => { inputs[l * program.inputWidth + p.offset + c] = x })
        }
      }
      const res = program.run({ lanes, inputs, builtins: { 'vertex-index': vi, 'instance-index': ii } }, bindings, 1e8)
      for (let l = 0; l < lanes; l++) {
        const outs = new Map<number, number[]>()
        for (const p of program.outputs) outs.set(p.slot, Array.from({ length: p.size }, (_, c) => res.outputs[l * program.outputWidth + p.offset + c]))
        refOut.push({ pos: Array.from({ length: 4 }, (_, c) => res.position[l * 4 + c]), positioned: ((res.positioned >> l) & 1) === 1, outs })
      }
    }
    // The lowered module: what the GPU's attribute read hands it at the wrapped vertex_index.
    const vertices: VertexIn[] = d.at.map((x) => {
      const vi = d.indexed ? (x + d.base) >>> 0 : x
      const locations: { [slot: number]: number | readonly number[] } = {}
      for (const p of m.inputs) {
        const a = d.attrs.get(p.slot) as VertexAttr
        const e = ((rate >>> p.slot) & 1) === 1 ? vi : d.instance
        const at = a.o + e * a.stride
        const n = lensWidthOf(p.type)
        const v = at + 4 * n <= a.bytes.length ? attrRead(a, at, p.type) : new Array<number>(n).fill(mode.mode === 'exact' ? 0 : asNum(POISON_BITS, kindOf(p.type)))
        locations[p.slot] = n === 1 ? v[0] : v
      }
      return { vertex_index: vi, instance_index: d.instance, locations }
    })
    const got = lowered.vertex(vertices, evaluatorResources(m, uni, new Map(), new Map(), hidden))
    got.forEach((g, l) => {
      const ref = refOut[l]
      const what = `vertex seed ${seed} ${mode.mode} draw ${k} vertex ${l}`
      count.vertices++
      for (const p of m.outputs) {
        const k2 = kindOf(p.type)
        const want = (ref.outs.get(p.slot) as number[]).map((x) => bitsOf(x, k2))
        const gv = g.locations[p.slot]
        const have = (typeof gv === 'number' ? [gv] : (gv as number[])).map((x) => bitsOf(x, k2))
        count.words += want.length
        if (want.some((w, c) => w !== have[c])) bad.push(`${what}: output ${p.slot}: got ${have.map(hex)}, the reference ${want.map(hex)}`)
      }
      const gp = (g.builtins.position as number[]).map((x) => bitsOf(x, 'f32'))
      if (ref.positioned) {
        const want = ref.pos.map((x) => bitsOf(x, 'f32'))
        if (want.some((w, c) => w !== gp[c])) bad.push(`${what}: position ${gp.map(hex)}, the reference ${want.map(hex)}`)
      } else {
        count.unpositioned++
        if (!gp.every(isNanBits)) bad.push(`${what}: unpositioned, and the position is ${gp.map(hex)}, not NaN`)
      }
      if (live !== null) {
        const lv = bitsOf(g.locations[live] as number, 'f32')
        if (lv !== (ref.positioned ? 0 : fb(1))) bad.push(`${what}: live ${hex(lv)} for a vertex ${ref.positioned ? '' : 'not '}positioned`)
      }
    })
  }
  return bad
}

test('differential: vertex modules per vertex, the limit selects against soft.ts\'s attribute rule, positions and the live value', (t) => {
  const SEEDS = 120
  const failures: string[] = []
  const count = { vertices: 0, words: 0, unpositioned: 0, zeroed: 0, flat: 0 }
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const mode of [EXACT_RUN, STAGE_ADVERSARIAL]) failures.push(...vertexRun(seed, mode, count))
  }
  t.diagnostic(`${SEEDS} modules, two modes: ${count.vertices} vertices, ${count.words} output words bit for bit, ${count.unpositioned} unpositioned, ${count.zeroed} attributes the reference reads as zero, ${count.flat} flat f32 outputs`)
  assert.deepEqual(failures.slice(0, 12), [])
  assert.ok(count.unpositioned > 200 && count.zeroed > 500 && count.flat > 20, `${count.unpositioned} unpositioned, ${count.zeroed} zeroed, ${count.flat} flat f32 outputs`)
})

// ---------------------------------------------------------------------------------------------------
// Fragment modules, per quad

/** Words a fragment lane writes, quads per module. */
const FRAG_WORDS = 6
const FRAG_QUADS = 8

/** How a value a fragment module hands on is compared: exactly, as a derivative (A16), or as an implicit-level sample (A8). */
type FragCls = { readonly k: 'E' } | { readonly k: 'A16'; readonly fn: 'dx' | 'dy' | 'width'; readonly slot: number; readonly lanes: string } | { readonly k: 'A8'; readonly slot: number; readonly layer: number | null }

interface FragBuilt {
  readonly m: LensModule
  readonly out: number
  readonly img: number
  readonly smp: number
  /**
   * The class of each word a lane writes (by j), with the component it takes and the scalar kind of the value written
   * (an f32's NaN equals any NaN; an integer's word is held bit for bit), and the class of each output port (by slot).
   */
  readonly writes: readonly (FragCls & { readonly c: number; readonly kind: LensScalar })[]
  readonly outs: ReadonlyMap<number, FragCls>
  /** The f32 input ports a derivative or a sample may read: slot and type. */
  readonly smooth: readonly Port[]
}

/** A seeded fragment module (see the head of this part). Slot 0 is the quad's number, flat. */
function fragmentModule(seed: number): FragBuilt {
  const r = xorshift32(seed)
  const b = lens('fragment')
  const p = new Pools(b, r)
  const id = b.input(0, 'u32', { flat: true })
  const smooth: Port[] = []
  const vals: LensVal[] = []
  for (const [slot, t] of [[1, 'f32x2'], [2 + r(3), (['f32', 'f32x4', 'f32x3'] as const)[r(3)]]] as const) {
    const v = b.input(slot, t)
    smooth.push({ slot, type: t })
    vals.push(p.keep(v))
  }
  const extra = r(4)
  if (extra < 2) p.keep(b.input(6, 'i32x2', { flat: true }))
  else if (extra === 2) p.keep(b.input(6, (['f32', 'f32x3'] as const)[r(2)], { flat: true }))
  const uv = vals[0]
  const fc = b.builtin('frag-coord')
  const facing = r(2) === 0 ? b.builtin('front-facing') : null
  const arrayed = r(2) === 0
  const img = b.image(0, 0, { dims: arrayed ? '2d-array' : '2d' })
  const smp = b.sampler(0, 1)
  const out = b.storage(0, 2, { n: 'u32', xs: arrayOf('u32') }, { writable: true })
  const st = b.storageImage(0, 3, (['r32f', 'rgba8', 'r32u', 'rgba32f'] as const)[r(4)])
  const px = b.cast(b.pick(fc, 'x'), 'u32')
  const py = b.cast(b.pick(fc, 'y'), 'u32')
  p.keep(px)
  p.keep(py)
  const lane = b.add(b.and(px, b.u32(1)), b.mul(b.and(py, b.u32(1)), b.u32(2)))
  const at = (j: number): LensVal => b.add(b.mul(b.add(b.mul(id, b.u32(4)), lane), b.u32(FRAG_WORDS)), b.u32(j))
  const writes: (FragCls & { c: number; kind: LensScalar })[] = []
  const outs = new Map<number, FragCls>()
  const special: { v: LensVal; cls: FragCls }[] = []
  // Derivatives and implicit samples at the top level, before anything that holds a return.
  const nd = 1 + r(3)
  for (let i = 0; i < nd; i++) {
    const src = r(2) === 0 ? 0 : 1
    const v = vals[src]
    const n = lensWidthOf(v.t)
    const lanes = r(2) === 0 || n === 1 ? 'xyzw'.slice(0, n) : 'xyzw'[r(n)]
    const fn = (['dx', 'dy', 'width'] as const)[r(3)]
    special.push({ v: b.deriv(fn, lanes.length === n ? v : b.pick(v, lanes)), cls: { k: 'A16', fn, slot: smooth[src].slot, lanes } })
  }
  if (r(4) !== 0) {
    const layer = arrayed ? [0, 1, 2, -1, 7][r(5)] : null
    special.push({ v: b.sample(img, smp, uv, layer === null ? {} : { layer: b.i32(layer) }), cls: { k: 'A8', slot: 1, layer } })
  }
  const steps = (n: number): void => {
    for (let i = 0; i < n; i++) p.step()
  }
  steps(2 + r(4))
  // E values from images: an explicit-level sample, a texel at the lane's pixel.
  p.keep(b.sample(img, smp, uv, { level: p.want('f32'), ...(arrayed ? { layer: p.want('u32') } : {}) }))
  p.keep(b.texel(img, b.make('u32x2', px, py), { level: p.want('u32'), ...(arrayed ? { layer: b.i32(r(3)) } : {}) }))
  const discard = (): void => {
    // E conditions only: a float comparison with a NaN is A14, so the coordinate is compared as the i32 it casts to.
    const c = facing !== null && r(3) === 0 ? b.not(facing) : r(2) === 0 ? b.eq(lane, b.u32(r(4))) : b.lt(b.cast(b.pick(uv, 'x'), 'i32'), b.i32(r(6) - 2))
    // In the branch of an if, in its else branch, or in a loop: wherever it sits, the module declares ng_gone.
    const where = r(4)
    if (where === 0) b.if(b.not(c), () => undefined, () => b.discard())
    else if (where === 1) b.loop(() => { b.if(c, () => b.discard()); b.break() })
    else b.if(c, () => b.discard())
  }
  if (r(3) !== 0) discard()
  // Writes: E values, or a component of a derivative or a sample, each word of the lane's own.
  for (let j = 0; j < FRAG_WORDS; j++) {
    // A word left unwritten keeps its canary, compared as a u32.
    writes.push({ k: 'E', c: 0, kind: 'u32' })
    if (r(5) === 0) continue
    if (special.length > 0 && r(3) === 0) {
      const s = special[r(special.length)]
      const c = r(lensWidthOf(s.v.t))
      writes[j] = { ...s.cls, c, kind: 'f32' }
      b.write(out, ['xs', at(j)], b.bits(lensWidthOf(s.v.t) === 1 ? s.v : b.pick(s.v, 'xyzw'[c]), 'u32'))
    } else {
      const t = (['u32', 'f32', 'i32'] as const)[r(3)]
      const v = p.want(t)
      writes[j] = { k: 'E', c: 0, kind: t }
      b.write(out, ['xs', at(j)], t === 'u32' ? v : b.bits(v, 'u32'))
    }
    if (r(4) === 0) discard()
  }
  // Puts at the lane's pixel, or past it, of E values.
  if (r(3) !== 0) {
    const kind = sampleKind(st.format)
    const v = kind === 'uint' ? p.want('u32x4') : p.want('f32x4')
    b.put(st, b.make('u32x2', b.add(px, b.u32(r(3) === 0 ? 3 : 0)), py), v)
  }
  // Outputs: E values, or a derivative or a sample whole, at colour slots 0 to 7.
  const outSlots = slotOrder(r).filter((s) => s < 8).slice(0, 1 + r(3))
  const late: (() => void)[] = []
  for (const slot of outSlots) {
    const s = special.length > 0 && r(2) === 0 ? special[r(special.length)] : null
    const t = s !== null ? s.v.t : (['f32', 'f32x2', 'f32x4', 'u32', 'i32x2', 'u32x4', 'f32x3'] as const)[r(7)]
    const o = b.output(slot, t)
    outs.set(slot, s !== null ? s.cls : { k: 'E' })
    const v = s !== null ? s.v : p.want(t)
    late.push(() => b.out(o, v))
  }
  // An early return under a lane's condition, then the outputs.
  if (r(4) === 0) b.if(b.eq(lane, b.u32(r(4))), () => b.return())
  for (const f of late) f()
  return { m: b.finish(), out: out.res, img: img.res, smp: smp.res, writes, outs, smooth }
}

/** One quad's inputs: per lane the location values (f32-exact), and the quad's facing, origin, helpers and live value. */
interface QuadIn {
  readonly x: number
  readonly y: number
  readonly facing: boolean
  readonly helpers: number
  readonly locations: readonly (ReadonlyMap<number, readonly number[]>)[]
  readonly depth: readonly number[]
  /** All lanes' live value: exactly 0 (or -0), or a value the live test discards. */
  readonly live: number
}

function quadOf(r: (n: number) => number, built: FragBuilt, q: number): QuadIn {
  const m = built.m
  const odd = r(5) === 0
  // Smooth values: a quad's start, steps along x and y that take an image of 4 to 8 texels a side through its levels,
  // and a jitter per lane, so the fine and coarse differences part; now and then a value not finite, or huge.
  const start = [0, 1, 2, 3].map(() => (r(256) - 64) / 32)
  const step = [0, 1, 2, 3].map(() => [[0, 0.0625, 0.125, 0.25, 0.375][r(5)], [0, 0.0625, 0.125, 0.25, 0.375][r(5)]])
  const value = (l: number, c: number): number => {
    if (odd && r(3) === 0) return [NaN, Infinity, -Infinity, 1e30, -3e7, 2 ** 24 + 2][r(6)]
    return Math.fround(start[c] + (l & 1) * step[c][0] + (l >> 1) * step[c][1] + r(8) / 128)
  }
  const flat = new Map<number, number[]>()
  for (const p of m.inputs) if (p.flat === true) flat.set(p.slot, p.slot === 0 ? [q] : Array.from({ length: lensWidthOf(p.type) }, () => r(9) - 4))
  const locations = [0, 1, 2, 3].map((l) => new Map(m.inputs.map((p) => [p.slot, p.flat === true ? (flat.get(p.slot) as number[]) : Array.from({ length: lensWidthOf(p.type) }, (_, c) => value(l, c))] as const)))
  return {
    x: 2 * (q % 4),
    y: 2 * Math.floor(q / 4),
    facing: r(2) === 0,
    helpers: [0, 0, 0, 1, 2, 4, 8, 9, 6, 14, 7][r(11)],
    locations,
    depth: [0, 1, 2, 3].map(() => Math.fround(r(100) / 100)),
    live: r(6) === 0 ? [NaN, 0.5, 1, 2 ** -149][r(4)] : r(8) === 0 ? -0 : 0,
  }
}

/** What a lane's location numbers are, for the reference: ports in slot order, packed. */
function packInputs(program: LensProgram, quad: QuadIn): Float64Array {
  const inputs = new Float64Array(4 * program.inputWidth)
  for (let l = 0; l < 4; l++) for (const p of program.inputs) (quad.locations[l].get(p.slot) as readonly number[]).forEach((x, c) => { inputs[l * program.inputWidth + p.offset + c] = x })
  return inputs
}

/**
 * The values an approximated value may take in lane l: the reference's (fine), and in adversarial mode the coarse
 * difference or the sample at the coarse level of detail. A coordinate not finite or past 2^24 is compared too: the
 * lowering takes the rates from the raw coordinate, as the reference does, so a NaN rate reads lodMin and an infinite
 * one lodMax there as well.
 */
function fragAlternatives(cls: FragCls, quad: QuadIn, l: number, img: ImageBinding, smp: SamplerState, adversarial: boolean): number[][] {
  if (cls.k === 'E') return []
  const comps = (slot: number, lanes: string): number[][] => [0, 1, 2, 3].map((k) => lanes.split('').map((ch) => (quad.locations[k].get(slot) as readonly number[])['xyzw'.indexOf(ch)]))
  if (cls.k === 'A16') {
    const v = comps(cls.slot, cls.lanes)
    const coarse = v[0].map((_, c) => {
      const dx = f32(v[1][c] - v[0][c])
      const dy = f32(v[2][c] - v[0][c])
      return cls.fn === 'dx' ? dx : cls.fn === 'dy' ? dy : f32(Math.abs(dx) + Math.abs(dy))
    })
    return adversarial ? [coarse] : []
  }
  const uv = comps(cls.slot, 'xy')
  if (!adversarial) return []
  const w = img.store.levelWidth(img.view.levels.base)
  const h = img.store.levelHeight(img.view.levels.base)
  const lod = lodFromRates(f32(uv[1][0] - uv[0][0]), f32(uv[1][1] - uv[0][1]), f32(uv[2][0] - uv[0][0]), f32(uv[2][1] - uv[0][1]), w, h)
  const rgba = [0, 0, 0, 0]
  sample(img.store, img.view, smp, uv[l][0], uv[l][1], cls.layer ?? 0, lod, rgba)
  return [rgba.map(f32)]
}

/** Whether an implicit-level sample's quad holds a coordinate that is not finite or is past 2^24. */
function wildCoordinate(cls: FragCls, quad: QuadIn): boolean {
  return cls.k === 'A8' && quad.locations.some((loc) => (loc.get(cls.slot) as readonly number[]).slice(0, 2).some((x) => !(Math.abs(x) <= 2 ** 24)))
}

/** Whether a component is the reference's ('ref'), one of the alternatives ('alt'), or neither (null). */
function fragMatch(got: number, want: number, alts: readonly number[][], c: number, k: LensScalar): 'ref' | 'alt' | null {
  if (bitsOf(got, k) === bitsOf(want, k)) return 'ref'
  return alts.some((a) => bitsOf(got, k) === bitsOf(a[c], k)) ? 'alt' : null
}

/**
 * A seed's fragment module and the options it is lowered with: per colour slot an attachment of the output's kind,
 * none, or one of another kind (the core allows it with write mask 0), and now and then a free location for the live
 * value; with the generator its quads go on from.
 */
function fragmentCase(seed: number): { built: FragBuilt; outputs: readonly ('f32' | 'i32' | 'u32' | null)[]; live: number | null; options: Parameters<typeof toWgsl>[1]; r: (n: number) => number } {
  const built = fragmentModule(seed)
  const m = built.m
  const r = xorshift32(seed ^ 0x1b873593)
  const outputs: ('f32' | 'i32' | 'u32' | null)[] = Array.from({ length: 8 }, () => null)
  for (const p of m.outputs) outputs[p.slot] = r(6) === 0 ? null : r(8) === 0 ? (kindOf(p.type) === 'f32' ? 'u32' : 'f32') : (kindOf(p.type) as 'f32' | 'i32' | 'u32')
  const taken = new Set(m.inputs.map((p) => p.slot))
  const free = Array.from({ length: 16 }, (_, s) => s).filter((s) => !taken.has(s))
  const live = r(3) === 0 ? free[r(free.length)] : null
  return { built, outputs, live, options: stageOptions(m, { outputs, live }), r }
}

type FragCount = { lanes: number; words: number; dead: number; helpers: number; discarded: number; wild: number; flat: number; A16: number; A8: number }

/**
 * Runs one seed's fragment module over its quads both ways in one mode; returns the messages of what differs. `edit`
 * changes the lowered text before it runs, for the test that checks the comparison itself catches a lowering that slips.
 */
function fragmentRun(seed: number, mode: RunOptions, count: FragCount, edit: (code: string) => string = (c) => c): string[] {
  const { built, outputs, live, options, r } = fragmentCase(seed)
  const m = built.m
  const adversarial = mode.mode !== 'exact'
  const code = edit(toWgsl(m, options).code)
  const lowered = new Program(code, { budget: 1e8, ...mode })
  const imgBinding = seededImage(r, FLOAT_FORMATS[r(FLOAT_FORMATS.length)], (m.resources[built.img] as { dims: string }).dims === '2d-array', false, true)
  const smp = samplerOf(r)
  const stIndex = m.resources.findIndex((x) => x.kind === 'storage-image')
  const st = seededImage(r, (m.resources[stIndex] as { format: Format }).format, false, true)
  const outBytes = (): Uint8Array => {
    const bytes = new Uint8Array(4 + FRAG_QUADS * 4 * FRAG_WORDS * 4)
    new DataView(bytes.buffer).setUint32(0, CANARY, true)
    for (let at = 4; at < bytes.length; at += 4) bytes.copyWithin(at, 0, 4)
    return bytes
  }
  const refBlocks = new Map([[built.out, outBytes()]])
  const gotBlocks = new Map([[built.out, outBytes()]])
  const refImages = new Map([[built.img, imgBinding], [stIndex, copyImage(st)]])
  const gotImages = new Map([[built.img, imgBinding], [stIndex, copyImage(st)]])
  const samplers = new Map([[built.smp, smp]])
  const { program, bindings } = bindReference(m, refBlocks, refImages, samplers)
  const resources = evaluatorResources(m, gotBlocks, gotImages, samplers, new Uint8Array(WGSL_HIDDEN.size))
  const bad: string[] = interpolation(lowered, 'fragment', m.inputs, live, `fragment seed ${seed} ${mode.mode}`)
  count.flat += m.inputs.filter((q) => q.flat === true && kindOf(q.type) === 'f32').length
  const quads = Array.from({ length: FRAG_QUADS }, (_, q) => quadOf(r, built, q))
  for (let q = 0; q < FRAG_QUADS; q++) {
    const quad = quads[q]
    const dead = live !== null && (bitsOf(quad.live, 'f32') & 0x7fffffff) !== 0
    const pos = [0, 1, 2, 3].map((l) => [quad.x + (l & 1) + 0.5, quad.y + (l >> 1) + 0.5, quad.depth[l], 1])
    const what = `fragment seed ${seed} ${mode.mode} quad ${q}`
    const lanesIn: FragmentIn[] = [0, 1, 2, 3].map((l) => {
      const locations: { [slot: number]: readonly number[] | number } = {}
      for (const [slot, v] of quad.locations[l]) locations[slot] = v.length === 1 ? v[0] : v
      if (live !== null) locations[live] = quad.live
      return { position: pos[l], front_facing: quad.facing, locations, helper: ((quad.helpers >> l) & 1) === 1 }
    })
    const before = new Uint8Array(gotBlocks.get(built.out) as Uint8Array)
    const beforeImage = new Uint8Array((gotImages.get(stIndex) as ImageBinding).store.bytes)
    const got = lowered.fragment(lanesIn, resources)
    if (dead) {
      // A triangle the reference never draws: every lane discarded, nothing written, nothing put.
      count.dead++
      if (!got.every((g) => g.discarded || g.helper)) bad.push(`${what}: dead, and a lane was not discarded`)
      if (!sameBytes(before, gotBlocks.get(built.out) as Uint8Array) || !sameBytes(beforeImage, (gotImages.get(stIndex) as ImageBinding).store.bytes)) bad.push(`${what}: dead, and something was written`)
      continue
    }
    const res = program.run({ lanes: 4, helpers: quad.helpers, inputs: packInputs(program, quad), builtins: { 'frag-coord': pos.flat(), 'front-facing': [quad.facing ? 1 : 0, quad.facing ? 1 : 0, quad.facing ? 1 : 0, quad.facing ? 1 : 0] } }, bindings, 1e8)
    for (let l = 0; l < 4; l++) {
      const helper = ((quad.helpers >> l) & 1) === 1
      const discarded = ((res.discarded >> l) & 1) === 1
      if (helper) {
        count.helpers++
        continue
      }
      if (got[l].discarded !== discarded) bad.push(`${what} lane ${l}: discarded ${got[l].discarded}, the reference ${discarded}`)
      if (discarded) {
        count.discarded++
        continue
      }
      count.lanes++
      // Colour outputs: shaped as soft.ts shapes them (missing components 0, a missing alpha 1), where attached.
      for (const p of program.outputs) {
        const k = kindOf(p.type)
        const gv = got[l].locations[p.slot]
        if (outputs[p.slot] !== k) {
          if (gv !== undefined) bad.push(`${what} lane ${l}: output ${p.slot} handed on with no attachment of its kind`)
          continue
        }
        const want = [0, 1, 2, 3].map((c) => (c < p.size ? res.outputs[l * program.outputWidth + p.offset + c] : c === 3 ? 1 : 0))
        const cls = built.outs.get(p.slot) as FragCls
        const alts = fragAlternatives(cls, quad, l, imgBinding, smp, adversarial)
        const have = gv as number[]
        count.words += 4
        if (wildCoordinate(cls, quad)) count.wild += p.size
        const ok = want.every((w, c) => {
          if (c >= p.size) return bitsOf(have[c], k) === bitsOf(w, k)
          const how = fragMatch(have[c], w, alts, c, k)
          if (how === 'alt' && cls.k !== 'E') count[cls.k]++
          return how !== null
        })
        if (!ok) bad.push(`${what} lane ${l}: output ${p.slot} got ${have.map((x) => hex(bitsOf(x, k)))}, the reference ${want.map((x) => hex(bitsOf(x, k)))}`)
      }
    }
  }
  // The words written: E bit for bit (an f32's NaN as any NaN, an integer's word exactly), a derivative's or a sample's
  // component by its class.
  const rw = words32(refBlocks.get(built.out) as Uint8Array)
  const gw = words32(gotBlocks.get(built.out) as Uint8Array)
  for (let i = 1; i < rw.length; i++) {
    const j = (i - 1) % FRAG_WORDS
    const l = Math.floor((i - 1) / FRAG_WORDS) % 4
    const q = Math.floor((i - 1) / (4 * FRAG_WORDS))
    const cls = built.writes[j]
    count.words++
    if (sameWord(gw[i], rw[i], cls.kind === 'f32')) continue
    const alts = rw[i] === CANARY ? [] : fragAlternatives(cls, quads[q], l, imgBinding, smp, adversarial)
    if (rw[i] !== CANARY && wildCoordinate(cls, quads[q])) count.wild++
    if (alts.some((a) => bitsOf(bf(gw[i]), 'f32') === bitsOf(a[cls.c], 'f32'))) {
      if (cls.k !== 'E') count[cls.k]++
    } else bad.push(`fragment seed ${seed} ${mode.mode}: quad ${q} lane ${l} word ${j} (${cls.k} ${cls.kind}): got ${hex(gw[i])}, the reference ${hex(rw[i])}`)
  }
  const a = (refImages.get(stIndex) as ImageBinding).store.bytes
  const g = (gotImages.get(stIndex) as ImageBinding).store.bytes
  const at = a.findIndex((x, j) => x !== g[j])
  if (at >= 0) bad.push(`fragment seed ${seed} ${mode.mode}: storage image byte ${at}: got ${g[at]}, the reference ${a[at]}`)
  return bad
}

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

test('differential: fragment modules per quad: helpers, discard, derivatives (A16), samples (A8), writes, puts, outputs, the live test', (t) => {
  const SEEDS = 120
  const failures: string[] = []
  const count: FragCount = { lanes: 0, words: 0, dead: 0, helpers: 0, discarded: 0, wild: 0, flat: 0, A16: 0, A8: 0 }
  for (let seed = 1; seed <= SEEDS; seed++) {
    for (const mode of [EXACT_RUN, STAGE_ADVERSARIAL]) failures.push(...fragmentRun(seed, mode, count))
  }
  t.diagnostic(`${SEEDS} modules, two modes: ${count.lanes} lanes shaded, ${count.words} words compared, ${count.A16} components the coarse difference (A16) and ${count.A8} the coarse level of detail (A8) gave, ${count.wild} components of a sample whose quad holds a coordinate not finite or past 2^24, ${count.flat} flat f32 inputs, ${count.helpers} helper lanes, ${count.discarded} discarded, ${count.dead} quads the live test drops`)
  assert.deepEqual(failures.slice(0, 12), [])
  assert.ok(count.dead > 20 && count.discarded > 100 && count.helpers > 200 && count.A16 > 100 && count.A8 > 20 && count.wild > 20 && count.flat > 20, JSON.stringify(count))
})

test('the fragment differential holds an integer word bit for bit: an i32 whose bits are a NaN as an f32 is not any NaN', () => {
  // Each negative i32 literal of the lowered text is printed one lower, as a lowering that slipped would print it. The
  // literals are small, so each word that carries one as an integer is a NaN pattern as an f32 on both sides: a
  // comparison of every word as an f32 (any NaN equal to any NaN) would pass them all.
  const lower = (code: string): string => code.replace(/(?<![\w.)\]])-(\d+)i\b/g, (_, n: string) => `-${Number(n) + 1}i`)
  const count: FragCount = { lanes: 0, words: 0, dead: 0, helpers: 0, discarded: 0, wild: 0, flat: 0, A16: 0, A8: 0 }
  let edited = 0
  const caught: string[] = []
  for (let seed = 1; seed <= 40; seed++) {
    const { built, options } = fragmentCase(seed)
    const code = toWgsl(built.m, options).code
    if (lower(code) === code) continue
    edited++
    for (const f of fragmentRun(seed, EXACT_RUN, count, lower)) {
      const w = /\(E (u32|i32)\): got (0x[0-9a-f]{8}), the reference (0x[0-9a-f]{8})$/.exec(f)
      if (w !== null && isNanBits(Number(w[2])) && isNanBits(Number(w[3]))) caught.push(f)
    }
  }
  assert.ok(edited > 20, `${edited} modules hold a negative i32 literal`)
  assert.ok(caught.length > 20, `${caught.length} integer words caught whose bits are NaN patterns as f32 on both sides`)
})

test('an implicit-level sample takes its level from the raw coordinate\'s fine rates: a NaN one reads lodMin, an infinite one lodMax, as the reference', () => {
  // Each texel's channels hold its level index (plus 8 on layer 1), so the level each lane read comes back. The quad's
  // coordinate moves one texel of the first level per pixel; then one lane's component is made NaN, infinite, huge, or
  // 0 (the value ng_uv hands the sampler for a NaN, which the rates must not see).
  const W = 64
  const store = imageOf('rgba16f', W, W, (_x, _y, k, q) => q + 8 * k, 2, 7)
  const samplers: SamplerState[] = [
    { mag: 'nearest', min: 'nearest', mip: 'nearest', wrap: ['repeat', 'repeat', 'clamp'], lodMin: 0, lodMax: 32 },
    { mag: 'linear', min: 'nearest', mip: 'linear', wrap: ['clamp', 'mirror', 'clamp'], lodMin: 1.25, lodMax: 4.5 },
  ]
  const base = (l: number): number[] => [f32(0.1 + (l & 1) / W), f32(0.1 + (l >> 1) / W)]
  const cases: [string, number, number, number][] = [
    ['finite', 0, 0, 0.1], ['NaN u in lane 0', 0, 0, NaN], ['NaN v in lane 3', 3, 1, NaN], ['NaN u in lane 1', 1, 0, NaN],
    ['0 u in lane 0', 0, 0, 0], ['+inf u in lane 1', 1, 0, Infinity], ['-inf v in lane 2', 2, 1, -Infinity], ['1e30 u in lane 0', 0, 0, 1e30],
    ['2^24 + 2 v in lane 3', 3, 1, 2 ** 24 + 2], ['-3e7 u in lane 2', 2, 0, -3e7],
  ]
  const levels: { [what: string]: number[] } = {}
  for (const arrayed of [false, true]) {
    const b = lens('fragment')
    const uv = b.input(0, 'f32x2')
    const img = b.image(0, 0, { dims: arrayed ? '2d-array' : '2d' })
    const smp = b.sampler(0, 1)
    b.out(b.output(0, 'f32x4'), b.sample(img, smp, uv, arrayed ? { layer: b.i32(1) } : {}))
    const m = b.finish()
    const view: ViewRange = { levels: { base: 0, count: 7 }, layers: { base: 0, count: arrayed ? 2 : 1 } }
    const code = toWgsl(m, stageOptions(m, { outputs: ['f32'] })).code
    // Every freedom but the coarse derivatives (A16, compared by the differential): the lowering hands the sampler no
    // NaN or infinity, so none of them may change a bit.
    const runs = [new Program(code, EXACT_RUN), new Program(code, { mode: 'adversarial', except: ['derivatives'] })]
    for (const [si, smpState] of samplers.entries()) {
      const { program, bindings } = bindReference(m, new Map(), new Map([[img.res, { store, view }]]), new Map([[smp.res, smpState]]))
      const resources = evaluatorResources(m, new Map(), new Map([[img.res, { store, view }]]), new Map([[smp.res, smpState]]), new Uint8Array(WGSL_HIDDEN.size))
      for (const [what, lane, c, x] of cases) {
        const uvs = [0, 1, 2, 3].map((l) => (l === lane ? base(l).map((y, k) => (k === c ? f32(x) : y)) : base(l)))
        const inputs = new Float64Array(uvs.flat())
        const pos = [0, 1, 2, 3].map((l) => [(l & 1) + 0.5, (l >> 1) + 0.5, 0.5, 1])
        const res = program.run({ lanes: 4, inputs, builtins: { 'frag-coord': pos.flat() } }, bindings, 1e6)
        const want = [0, 1, 2, 3].map((l) => Array.from(res.outputs.slice(4 * l, 4 * l + 4)))
        if (!arrayed && si === 0) levels[what] = want.map((v) => v[0])
        for (const [k, p] of runs.entries()) {
          const got = p.fragment([0, 1, 2, 3].map((l) => ({ position: pos[l], front_facing: true, locations: { 0: uvs[l] } })), resources).map((o) => o.locations[0] as number[])
          assert.deepEqual(got.map((v) => v.map((y) => hex(fb(y)))), want.map((v) => v.map((y) => hex(fb(y)))), `${arrayed ? '2d-array' : '2d'}, sampler ${si}, ${what}, ${k === 0 ? 'exact' : 'adversarial'}`)
        }
      }
    }
  }
  // What the cases are for: a NaN rate reads lodMin (level 0) in every lane it reaches; the coordinate 0 ng_uv makes of
  // a NaN would have read about three levels up; an infinite rate reads lodMax (the last level).
  assert.deepEqual(levels['finite'], [0, 0, 0, 0])
  assert.deepEqual(levels['NaN u in lane 0'], [0, 0, 0, 0])
  assert.deepEqual(levels['0 u in lane 0'], [3, 3, 3, 0])
  assert.deepEqual(levels['+inf u in lane 1'], [6, 6, 0, 6])
})

test('the comparator is as tight as the ledger: each class refuses a value just past its bound, an E word one bit off, a fragment alternative that differs', () => {
  const inside = (a: Allow, x: number): boolean => a.k === 'any' || (a.k === 'in' && x >= a.lo && x <= a.hi)
  const one = (tag: Tag, fn: string, ops: readonly (readonly number[])[], types: readonly ValueType[]): Allow => {
    const a = allowed(tag, fn, ops, types, 1)
    assert.equal(a.length, 1)
    return a[0]
  }
  // A14 over numbers and a payload of a number are held exactly; only a NaN operand leaves them open.
  assert.deepEqual(one('A14', 'add', [[1.5], [2]], ['f32', 'f32']), ALLOW_EXACT)
  assert.deepEqual(one('A14', 'add', [[NaN], [2]], ['f32', 'f32']), ALLOW_ANY)
  assert.deepEqual(one('payload', 'add', [[1.5], [2]], ['f32', 'f32']), ALLOW_EXACT)
  // A9: an add is correctly rounded, so one of the two neighbours of the exact sum and nothing past them.
  const add = one('A9', 'add', [[1], [2 ** -24]], ['f32', 'f32'])
  assert.ok(inside(add, 1) && inside(add, 1 + 2 ** -23) && !inside(add, 1 + 2 ** -22) && !inside(add, f32(1 - 2 ** -24)))
  // Division: 2.5 ULP of the exact quotient (2^-25 apart near 1/3).
  const q = f32(1 / 3)
  const div = one('A10', 'div', [[1], [3]], ['f32', 'f32'])
  assert.ok(inside(div, q + 2 * 2 ** -25) && !inside(div, q + 3 * 2 ** -25) && !inside(div, q - 3 * 2 ** -25))
  // A sum of n products: n roundings of the sum of the terms' sizes (32 here, 2^-18 apart).
  const dot = one('A9', 'dot', [[1, 2, 3], [4, 5, 6]], ['f32x3', 'f32x3'])
  assert.ok(inside(dot, 32 + 2 * 2 ** -18) && !inside(dot, 32 + 12 * 2 ** -18) && !inside(dot, 32 - 12 * 2 ** -18))
  // pow inherits exp2(b * log2(a)): near the root of 2, far from anything else; its edges are exact.
  const pow = one('A12', 'pow', [[2], [0.5]], ['f32', 'f32'])
  assert.ok(inside(pow, f32(Math.SQRT2)) && !inside(pow, 1.5) && !inside(pow, f32(Math.SQRT2) + 2 ** -15))
  assert.deepEqual(one('A12', 'pow', [[2], [0]], ['f32', 'f32']), ALLOW_EXACT)

  // compareRuns on a family's own reference output: clean, then one bit off in an E word or in an A record's exact
  // edge, each refused in adversarial mode.
  const fam = FAMILIES.find((f) => f.name.startsWith('values known never NaN')) as Family
  const built = buildFamily(fam, false)
  const ins = inputsOf(built.g.res, perLane(fam.word))
  const ref = runReference(built.m, built.g.res, ins, built.inv)
  const R = new DataView(ref.buffer, ref.byteOffset, ref.length)
  const classes = built.g.classify(false)
  const words = recordWords(built.g.res, built.g.recs, 0)
  const check = (at: number | null): string[] => {
    const got = new Uint8Array(ref)
    if (at !== null) new DataView(got.buffer).setUint32(at, R.getUint32(at, true) ^ 1, true)
    const failures: string[] = []
    compareRuns('canary', built, ref, got, 'adversarial', null, newTally(), failures)
    return failures
  }
  assert.deepEqual(check(null), [])
  const eWord = built.g.recs.flatMap((_, ri) => (classes[ri] === 'E' ? words[ri] : [])).find((o) => !isNanBits(R.getUint32(o, true)))
  assert.ok(eWord !== undefined, 'an E word that is not a NaN')
  assert.equal(check(eWord).length, 1)
  const edge = built.g.recs.flatMap((rec, ri) => {
    if (classes[ri] !== 'A' || rec.approx === null || words[ri].every((o) => R.getUint32(o, true) === CANARY)) return []
    const a = rec.approx
    const ops = a.ops.map((oi, o) => words[oi].map((off) => asNum(R.getUint32(off, true), kindOf(a.types[o]))))
    const allow = allowed(a.tag, a.fn, ops, a.types, words[ri].length)
    return words[ri].filter((o, c) => allow[c].k === 'exact' && !isNanBits(R.getUint32(o, true)))
  })
  assert.ok(edge.length > 0, 'an approximated record held exactly at an edge')
  assert.equal(check(edge[0]).length, 1)

  // A fragment word matches the reference or one of the alternatives exactly, never merely because some exist.
  assert.equal(fragMatch(0.25, 0.25, [[0.75]], 0, 'f32'), 'ref')
  assert.equal(fragMatch(0.75, 0.25, [[0.75]], 0, 'f32'), 'alt')
  assert.equal(fragMatch(0.5, 0.25, [[0.75]], 0, 'f32'), null)
})
