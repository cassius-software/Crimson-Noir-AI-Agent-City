// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs the shipped compute shaders on the CPU: a compiler from the subset of WGSL
 * crowd.wgsl is written in (scalars, vectors, structs, fixed and runtime arrays, uniform and storage buffers,
 * atomics, a sampled texture, the maths builtins, if/for/switch) to plain JavaScript over typed arrays, with
 * f32 rounding on every float operation and wrapping u32/i32 arithmetic, so a Node test can dispatch the very
 * passes the GPU runs (spawn, clearGrid, binAgents, simulate) over the same byte layouts (packSimParams) and read
 * the same buffers back. The soak tests drive the whole realm (Rapier fleet, Sanctuary, Ring-0 audit) with this
 * crowd for thousands of ticks, which no test could do against a hand-written copy of the shader: a copy drifts,
 * this compiles the file that ships. Nothing here is imported by the page.
 * What breaks if it is removed? The crowd can only run on a GPU, so the agent-and-car soaks (crowdSoak.test.ts)
 * cannot run in CI, and a sticking pedestrian is found by a player before a test.
 */

// ---------------------------------------------------------------- types

type Scalar = 'f32' | 'i32' | 'u32' | 'bool' | 'aint' | 'afloat'
type Ty =
  | { k: 'scalar'; s: Scalar }
  | { k: 'vec'; n: number; s: Scalar }
  | { k: 'array'; e: Ty; n: number | null }
  | { k: 'struct'; name: string }
  | { k: 'atomic' }
  | { k: 'texture' }
  | { k: 'void' }

const S = (s: Scalar): Ty => ({ k: 'scalar', s })
const V = (n: number, s: Scalar): Ty => ({ k: 'vec', n, s })
const F32 = S('f32'), I32 = S('i32'), U32 = S('u32'), BOOL = S('bool'), VOID: Ty = { k: 'void' }
const isAbstract = (s: Scalar): boolean => s === 'aint' || s === 'afloat'

function tyStr(t: Ty): string {
  switch (t.k) {
    case 'scalar': return t.s
    case 'vec': return `vec${t.n}<${t.s}>`
    case 'array': return `array<${tyStr(t.e)}${t.n === null ? '' : `, ${t.n}`}>`
    case 'struct': return t.name
    case 'atomic': return 'atomic<u32>'
    case 'texture': return 'texture_2d<f32>'
    case 'void': return 'void'
  }
}
/** A name safe inside a JS identifier for a type (readers, writers, clones are generated per type). */
const tyKey = (t: Ty): string => tyStr(t).replace(/[<>, ]/g, (c) => (c === '<' ? '_' : c === '>' ? '' : c === ',' ? '_' : ''))

// ---------------------------------------------------------------- tokens

interface Tok { t: 'id' | 'num' | 'p'; v: string; at: number }

const PUNCT = ['>>=', '<<=', '->', '==', '!=', '<=', '>=', '&&', '||', '<<', '>>', '++', '--', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=']
const SINGLE = new Set('(){}[],;:.@+-*/%<>=!&|^~')
const NUM = /^(?:0[xX][0-9a-fA-F]+[iu]?|(?:\d+\.\d*|\.\d+)(?:[eE][+-]?\d+)?[fh]?|\d+[eE][+-]?\d+[fh]?|\d+[iufh]?)/
const ID = /^[A-Za-z_][A-Za-z0-9_]*/

function tokenize(src: string): Tok[] {
  const out: Tok[] = []
  let i = 0
  const n = src.length
  while (i < n) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue }
    if (c === '/' && src[i + 1] === '*') {
      let depth = 1
      i += 2
      while (i < n && depth > 0) {
        if (src[i] === '/' && src[i + 1] === '*') { depth++; i += 2 } else if (src[i] === '*' && src[i + 1] === '/') { depth--; i += 2 } else i++
      }
      continue
    }
    const rest = src.slice(i, i + 64)
    let m = ID.exec(rest)
    if (m) { out.push({ t: 'id', v: m[0], at: i }); i += m[0].length; continue }
    m = NUM.exec(rest)
    if (m) { out.push({ t: 'num', v: m[0], at: i }); i += m[0].length; continue }
    const p = PUNCT.find((q) => rest.startsWith(q))
    if (p) { out.push({ t: 'p', v: p, at: i }); i += p.length; continue }
    if (SINGLE.has(c)) { out.push({ t: 'p', v: c, at: i }); i++; continue }
    throw new SyntaxError(`wgsl: unexpected character ${JSON.stringify(c)} at ${i}`)
  }
  return out
}

// ---------------------------------------------------------------- syntax tree

type Expr =
  | { k: 'lit'; v: string; t: Scalar }
  | { k: 'bool'; v: boolean }
  | { k: 'id'; name: string }
  | { k: 'un'; op: string; e: Expr }
  | { k: 'bin'; op: string; l: Expr; r: Expr }
  | { k: 'call'; name: string; targs: Ty[]; args: Expr[] }
  | { k: 'member'; e: Expr; name: string }
  | { k: 'index'; e: Expr; i: Expr }

type Stmt =
  | { k: 'decl'; mut: boolean; name: string; ty: Ty | null; init: Expr | null }
  | { k: 'assign'; op: string; lhs: Expr; rhs: Expr }
  | { k: 'step'; op: '+' | '-'; lhs: Expr }
  | { k: 'if'; cond: Expr; then: Stmt[]; otherwise: Stmt[] | null }
  | { k: 'for'; init: Stmt | null; cond: Expr | null; update: Stmt | null; body: Stmt[] }
  | { k: 'switch'; e: Expr; cases: { values: Expr[] | null; body: Stmt[] }[] }
  | { k: 'return'; e: Expr | null }
  | { k: 'break' }
  | { k: 'continue' }
  | { k: 'expr'; e: Expr }
  | { k: 'block'; body: Stmt[] }

interface ConstDecl { name: string; ty: Ty | null; init: Expr }
interface StructDecl { name: string; members: { name: string; ty: Ty }[] }
interface GlobalDecl { name: string; ty: Ty; space: 'uniform' | 'storage' | 'handle' }
interface FnDecl { name: string; params: { name: string; ty: Ty }[]; ret: Ty; body: Stmt[]; workgroupSize: number | null }
interface Module { consts: ConstDecl[]; structs: StructDecl[]; globals: GlobalDecl[]; fns: FnDecl[] }

/** Identifiers that may be followed by a template list in an expression (`vec2<bool>(…)`, `array<vec2f, 4>(…)`, `bitcast<u32>(…)`). */
const TEMPLATED = new Set(['vec2', 'vec3', 'vec4', 'array', 'bitcast', 'atomic', 'ptr', 'texture_2d'])
const SHORT_VEC: Record<string, [number, Scalar]> = {
  vec2f: [2, 'f32'], vec3f: [3, 'f32'], vec4f: [4, 'f32'], vec2i: [2, 'i32'], vec3i: [3, 'i32'], vec4i: [4, 'i32'], vec2u: [2, 'u32'], vec3u: [3, 'u32'], vec4u: [4, 'u32'],
}

class Parser {
  #toks: Tok[]
  #i = 0
  readonly consts = new Map<string, ConstDecl>()

  constructor(src: string) {
    this.#toks = tokenize(src)
  }

  #peek(k = 0): Tok | undefined { return this.#toks[this.#i + k] }
  #next(): Tok {
    const t = this.#toks[this.#i++]
    if (!t) throw new SyntaxError('wgsl: unexpected end of source')
    return t
  }
  #is(v: string, k = 0): boolean { const t = this.#peek(k); return t !== undefined && t.v === v }
  #accept(v: string): boolean { if (this.#is(v)) { this.#i++; return true } return false }
  #expect(v: string): Tok {
    const t = this.#next()
    if (t.v !== v) throw new SyntaxError(`wgsl: expected ${JSON.stringify(v)} but found ${JSON.stringify(t.v)} at ${t.at}`)
    return t
  }
  #ident(): string {
    const t = this.#next()
    if (t.t !== 'id') throw new SyntaxError(`wgsl: expected a name but found ${JSON.stringify(t.v)} at ${t.at}`)
    return t.v
  }
  /** A `>` closing a template list, also when the tokenizer joined it with the next one. */
  #closeAngle(): void {
    const t = this.#peek()
    if (t && t.v === '>>') { t.v = '>'; return }
    if (t && t.v === '>=') { t.v = '='; return }
    this.#expect('>')
  }

  module(): Module {
    const m: Module = { consts: [], structs: [], globals: [], fns: [] }
    while (this.#peek()) {
      if (this.#accept('const')) {
        const name = this.#ident()
        const ty = this.#accept(':') ? this.type() : null
        this.#expect('=')
        const init = this.expr()
        this.#expect(';')
        const d = { name, ty, init }
        m.consts.push(d)
        this.consts.set(name, d)
        continue
      }
      if (this.#accept('struct')) {
        const name = this.#ident()
        this.#expect('{')
        const members: { name: string; ty: Ty }[] = []
        while (!this.#accept('}')) {
          const mn = this.#ident()
          this.#expect(':')
          members.push({ name: mn, ty: this.type() })
          if (!this.#accept(',')) { this.#expect('}'); break }
        }
        m.structs.push({ name, members })
        continue
      }
      // Attributes before a binding or a function.
      let workgroupSize: number | null = null
      while (this.#accept('@')) {
        const a = this.#ident()
        if (this.#accept('(')) {
          const args: Expr[] = []
          while (!this.#accept(')')) { args.push(this.expr()); this.#accept(',') }
          if (a === 'workgroup_size') workgroupSize = this.constValue(args[0])
        }
      }
      if (this.#accept('var')) {
        let space: GlobalDecl['space'] = 'handle'
        if (this.#accept('<')) {
          const s = this.#ident()
          space = s === 'uniform' ? 'uniform' : 'storage'
          if (this.#accept(',')) this.#ident()
          this.#closeAngle()
        }
        const name = this.#ident()
        this.#expect(':')
        const ty = this.type()
        this.#expect(';')
        m.globals.push({ name, ty, space })
        continue
      }
      if (this.#accept('fn')) {
        const name = this.#ident()
        this.#expect('(')
        const params: { name: string; ty: Ty }[] = []
        while (!this.#accept(')')) {
          while (this.#accept('@')) { this.#ident(); if (this.#accept('(')) { while (!this.#accept(')')) this.#next() } }
          const pn = this.#ident()
          this.#expect(':')
          params.push({ name: pn, ty: this.type() })
          this.#accept(',')
        }
        const ret = this.#accept('->') ? this.type() : VOID
        const body = this.block()
        m.fns.push({ name, params, ret, body, workgroupSize })
        continue
      }
      const t = this.#next()
      throw new SyntaxError(`wgsl: unexpected ${JSON.stringify(t.v)} at module scope (${t.at})`)
    }
    return m
  }

  /** A compile-time integer (array sizes, workgroup sizes): literals and module constants of them. */
  constValue(e: Expr): number {
    switch (e.k) {
      case 'lit': return Number(e.v.replace(/[iufh]$/, ''))
      case 'id': {
        const c = this.consts.get(e.name)
        if (!c) throw new SyntaxError(`wgsl: ${e.name} is not a constant`)
        return this.constValue(c.init)
      }
      case 'un': return e.op === '-' ? -this.constValue(e.e) : this.constValue(e.e)
      case 'bin': {
        const l = this.constValue(e.l), r = this.constValue(e.r)
        return e.op === '+' ? l + r : e.op === '-' ? l - r : e.op === '*' ? l * r : e.op === '/' ? Math.trunc(l / r) : e.op === '%' ? l % r : NaN
      }
      default: throw new SyntaxError('wgsl: not a constant expression')
    }
  }

  type(): Ty {
    const name = this.#ident()
    const short = SHORT_VEC[name]
    if (short) return V(short[0], short[1])
    switch (name) {
      case 'f32': return F32
      case 'i32': return I32
      case 'u32': return U32
      case 'bool': return BOOL
      case 'vec2': case 'vec3': case 'vec4': {
        this.#expect('<')
        const e = this.type()
        this.#closeAngle()
        if (e.k !== 'scalar') throw new SyntaxError('wgsl: a vector of a non-scalar')
        return V(Number(name[3]), e.s)
      }
      case 'array': {
        this.#expect('<')
        const e = this.type()
        let n: number | null = null
        if (this.#accept(',')) n = this.constValue(this.#sizeExpr())
        this.#closeAngle()
        return { k: 'array', e, n }
      }
      case 'atomic': { this.#expect('<'); this.type(); this.#closeAngle(); return { k: 'atomic' } }
      case 'texture_2d': { this.#expect('<'); this.type(); this.#closeAngle(); return { k: 'texture' } }
      default: return { k: 'struct', name }
    }
  }

  block(): Stmt[] {
    this.#expect('{')
    const out: Stmt[] = []
    while (!this.#accept('}')) out.push(this.stmt())
    return out
  }

  stmt(): Stmt {
    if (this.#is('{')) return { k: 'block', body: this.block() }
    if (this.#accept('let') || this.#is('var')) {
      const mut = this.#accept('var')
      const name = this.#ident()
      const ty = this.#accept(':') ? this.type() : null
      const init = this.#accept('=') ? this.expr() : null
      this.#expect(';')
      return { k: 'decl', mut, name, ty, init }
    }
    if (this.#accept('if')) return this.#ifRest()
    if (this.#accept('for')) {
      this.#expect('(')
      const init = this.#is(';') ? null : this.#simple(true)
      this.#expect(';')
      const cond = this.#is(';') ? null : this.expr()
      this.#expect(';')
      const update = this.#is(')') ? null : this.#simple(false)
      this.#expect(')')
      return { k: 'for', init, cond, update, body: this.block() }
    }
    if (this.#accept('switch')) {
      const e = this.expr()
      this.#expect('{')
      const cases: { values: Expr[] | null; body: Stmt[] }[] = []
      while (!this.#accept('}')) {
        if (this.#accept('default')) { this.#accept(':'); cases.push({ values: null, body: this.block() }); continue }
        this.#expect('case')
        const values: Expr[] = []
        do {
          if (this.#accept('default')) continue
          values.push(this.expr())
        } while (this.#accept(','))
        this.#accept(':')
        cases.push({ values, body: this.block() })
      }
      return { k: 'switch', e, cases }
    }
    if (this.#accept('return')) {
      const e = this.#is(';') ? null : this.expr()
      this.#expect(';')
      return { k: 'return', e }
    }
    if (this.#accept('break')) { this.#expect(';'); return { k: 'break' } }
    if (this.#accept('continue')) { this.#expect(';'); return { k: 'continue' } }
    const s = this.#simple(true)
    this.#expect(';')
    return s
  }

  #ifRest(): Stmt {
    const cond = this.expr()
    const then = this.block()
    let otherwise: Stmt[] | null = null
    if (this.#accept('else')) otherwise = this.#accept('if') ? [this.#ifRest()] : this.block()
    return { k: 'if', cond, then, otherwise }
  }

  /** An assignment, an increment, a declaration (a for's init) or a call, without its semicolon. */
  #simple(allowDecl: boolean): Stmt {
    if (allowDecl && (this.#is('var') || this.#is('let'))) {
      const mut = this.#next().v === 'var'
      const name = this.#ident()
      const ty = this.#accept(':') ? this.type() : null
      const init = this.#accept('=') ? this.expr() : null
      return { k: 'decl', mut, name, ty, init }
    }
    const lhs = this.expr()
    const t = this.#peek()
    if (t && t.t === 'p') {
      if (t.v === '++' || t.v === '--') { this.#i++; return { k: 'step', op: t.v === '++' ? '+' : '-', lhs } }
      if (t.v === '=' || (t.v.length >= 2 && t.v.endsWith('=') && !['==', '!=', '<=', '>='].includes(t.v))) {
        this.#i++
        return { k: 'assign', op: t.v, lhs, rhs: this.expr() }
      }
    }
    return { k: 'expr', e: lhs }
  }

  expr(): Expr { return this.#binary(0) }

  static readonly LEVELS: string[][] = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']]

  #binary(level: number): Expr {
    if (level >= Parser.LEVELS.length) return this.#unary()
    let l = this.#binary(level + 1)
    for (;;) {
      const t = this.#peek()
      if (!t || t.t !== 'p' || !Parser.LEVELS[level].includes(t.v)) return l
      this.#i++
      l = { k: 'bin', op: t.v, l, r: this.#binary(level + 1) }
    }
  }

  #unary(): Expr {
    const t = this.#peek()
    if (t && t.t === 'p' && (t.v === '-' || t.v === '!' || t.v === '~' || t.v === '&' || t.v === '*')) {
      this.#i++
      return { k: 'un', op: t.v, e: this.#unary() }
    }
    return this.#postfix(this.#primary())
  }

  #postfix(e: Expr): Expr {
    for (;;) {
      if (this.#accept('[')) { const i = this.expr(); this.#expect(']'); e = { k: 'index', e, i }; continue }
      if (this.#accept('.')) { e = { k: 'member', e, name: this.#ident() }; continue }
      return e
    }
  }

  #args(): Expr[] {
    this.#expect('(')
    const args: Expr[] = []
    while (!this.#accept(')')) { args.push(this.expr()); this.#accept(',') }
    return args
  }

  #primary(): Expr {
    const t = this.#next()
    if (t.t === 'num') {
      const v = t.v
      const suffix = /[iufh]$/.test(v) && !/^0[xX]/.test(v) ? v[v.length - 1] : /^0[xX].*[iu]$/.test(v) ? v[v.length - 1] : ''
      const body = suffix ? v.slice(0, -1) : v
      const isFloat = !/^0[xX]/.test(body) && /[.eE]/.test(body)
      const ty: Scalar = suffix === 'u' ? 'u32' : suffix === 'i' ? 'i32' : suffix === 'f' || suffix === 'h' ? 'f32' : isFloat ? 'afloat' : 'aint'
      return { k: 'lit', v: body, t: ty }
    }
    if (t.t === 'p') {
      if (t.v === '(') { const e = this.expr(); this.#expect(')'); return e }
      throw new SyntaxError(`wgsl: unexpected ${JSON.stringify(t.v)} at ${t.at}`)
    }
    if (t.v === 'true') return { k: 'bool', v: true }
    if (t.v === 'false') return { k: 'bool', v: false }
    let targs: Ty[] = []
    if (TEMPLATED.has(t.v) && this.#is('<')) {
      this.#expect('<')
      targs.push(this.type())
      while (this.#accept(',')) targs.push(this.#is('(') ? VOID : this.#sizeArg())
      this.#closeAngle()
    }
    if (this.#is('(')) return { k: 'call', name: t.v, targs, args: this.#args() }
    return { k: 'id', name: t.v }
  }

  /** An array constructor's element count as a type-shaped placeholder: `array<T, N>(…)` carries N in targs[1]. */
  #sizeArg(): Ty {
    const n = this.constValue(this.#sizeExpr())
    return { k: 'array', e: VOID, n }
  }

  /** An element count inside a template list: additive at most, so the closing `>` is never read as an operator. */
  #sizeExpr(): Expr { return this.#binary(Parser.LEVELS.indexOf(Parser.LEVELS.find((l) => l[0] === '+')!)) }
}

// ---------------------------------------------------------------- layout (WGSL's address-space rules; uniform-compatible)

interface Layout { size: number; align: number }

class Layouts {
  readonly structs = new Map<string, { members: { name: string; ty: Ty; offset: number }[]; size: number; align: number }>()

  constructor(decls: StructDecl[]) {
    for (const s of decls) {
      let offset = 0, align = 1
      const members = s.members.map((m) => {
        const l = this.of(m.ty)
        offset = roundUp(offset, l.align)
        const r = { name: m.name, ty: m.ty, offset }
        offset += l.size
        align = Math.max(align, l.align)
        return r
      })
      this.structs.set(s.name, { members, size: roundUp(offset, align), align })
    }
  }

  of(t: Ty): Layout {
    switch (t.k) {
      case 'scalar': case 'atomic': return { size: 4, align: 4 }
      case 'vec': return { size: 4 * t.n, align: t.n === 2 ? 8 : 16 }
      case 'array': {
        const e = this.of(t.e)
        const stride = roundUp(e.size, e.align)
        return { size: stride * (t.n ?? 0), align: e.align }
      }
      case 'struct': {
        const s = this.structs.get(t.name)
        if (!s) throw new Error(`wgsl: unknown struct ${t.name}`)
        return { size: s.size, align: s.align }
      }
      default: throw new Error(`wgsl: ${tyStr(t)} has no layout`)
    }
  }

  /** Array element stride in bytes. */
  stride(t: Ty): number {
    const e = this.of(t)
    return roundUp(e.size, e.align)
  }
}

const roundUp = (n: number, a: number): number => Math.ceil(n / a) * a

// ---------------------------------------------------------------- code generation

interface Val { c: string; t: Ty }

/** Where an expression lives: memory (a bound buffer, a word offset) or a JavaScript value. */
type Place =
  | { k: 'mem'; buf: string; word: string; t: Ty }
  | { k: 'local'; c: string; t: Ty; root: 'local' | 'const' }
  | { k: 'swizzle'; base: Place; comps: number[]; t: Ty }
  | { k: 'val'; c: string; t: Ty }

interface Binding { ty: Ty; js: string; root: 'local' | 'const' | 'global' }

class Scope {
  readonly vars = new Map<string, Binding>()
  readonly parent: Scope | null
  constructor(parent: Scope | null) { this.parent = parent }
  lookup(name: string): Binding | undefined { return this.vars.get(name) ?? this.parent?.lookup(name) }
}

const COMP: Record<string, number> = { x: 0, y: 1, z: 2, w: 3, r: 0, g: 1, b: 2, a: 3 }
const SCALAR_LETTER: Record<Scalar, string> = { f32: 'f', i32: 'i', u32: 'u', bool: 'b', aint: 'i', afloat: 'f' }
const VIEW: Record<string, string> = { f32: 'f', i32: 'i', u32: 'u', afloat: 'f', aint: 'i' }

class Codegen {
  readonly layouts: Layouts
  readonly fns = new Map<string, FnDecl>()
  readonly globals = new Map<string, GlobalDecl>()
  readonly helpers = new Map<string, string>()
  readonly module: Module
  #retTy: Ty = VOID

  constructor(module: Module) {
    this.module = module
    this.layouts = new Layouts(module.structs)
    for (const f of module.fns) this.fns.set(f.name, f)
    for (const g of module.globals) this.globals.set(g.name, g)
  }

  // ---- helpers (generated once each, by name)

  helper(name: string): string {
    if (!this.helpers.has(name)) {
      this.helpers.set(name, '') // reserve: a helper may need itself through another
      this.helpers.set(name, this.#helperSource(name))
    }
    return name
  }

  #helperSource(name: string): string {
    const m = /^(\w+?)_([fiub])(\d)(?:_(vv|vs|sv))?$/.exec(name)
    const fixed = this.#fixedHelper(name)
    if (fixed) return fixed
    if (!m) throw new Error(`wgsl: no helper ${name}`)
    const [, op, letter, nText, shape] = m
    const n = Number(nText)
    const s: Scalar = letter === 'f' ? 'f32' : letter === 'i' ? 'i32' : letter === 'u' ? 'u32' : 'bool'
    const comps = [...Array(n).keys()]
    const list = (f: (k: number) => string): string => `[${comps.map(f).join(', ')}]`
    const binop = (sym: string): string | null => {
      const a = (k: number) => (shape === 'sv' ? 'a' : `a[${k}]`), b = (k: number) => (shape === 'vs' ? 'b' : `b[${k}]`)
      return `function ${name}(a, b) { return ${list((k) => this.scalarBin(sym, s, a(k), b(k)))} }`
    }
    const SYMS: Record<string, string> = { add: '+', sub: '-', mul: '*', div: '/', mod: '%', lt: '<', le: '<=', gt: '>', ge: '>=', eq: '==', ne: '!=', and: '&', or: '|', xor: '^', shl: '<<', shr: '>>' }
    if (SYMS[op] && shape) return binop(SYMS[op])!
    const unary = (f: (x: string) => string): string => `function ${name}(a) { return ${list((k) => f(`a[${k}]`))} }`
    const fr = (x: string): string => (s === 'f32' ? `fr(${x})` : x)
    switch (op) {
      case 'neg': return unary((x) => this.scalarUnary('-', s, x))
      case 'not': return unary((x) => `!${x}`)
      case 'abs': return unary((x) => (s === 'i32' ? `(Math.abs(${x}) | 0)` : `Math.abs(${x})`))
      case 'floor': return unary((x) => `Math.floor(${x})`)
      case 'round': return unary((x) => `rnd(${x})`)
      case 'sign': return unary((x) => `Math.sign(${x})`)
      case 'sqrt': return unary((x) => fr(`Math.sqrt(${x})`))
      case 'min': return `function ${name}(a, b) { return ${list((k) => `Math.min(a[${k}], b[${k}])`)} }`
      case 'max': return `function ${name}(a, b) { return ${list((k) => `Math.max(a[${k}], b[${k}])`)} }`
      case 'clamp': return `function ${name}(a, lo, hi) { return ${list((k) => `Math.min(Math.max(a[${k}], lo[${k}]), hi[${k}])`)} }`
      case 'mix': return `function ${name}(a, b, t) { return ${list((k) => `fr(fr(a[${k}] * fr(1 - t)) + fr(b[${k}] * t))`)} }`
      case 'sel': return `function ${name}(f, t, c) { return ${list((k) => `(c[${k}] ? t[${k}] : f[${k}])`)} }`
      case 'dot': return `function ${name}(a, b) { return ${comps.reduce((acc, k) => (acc === '' ? `fr(a[${k}] * b[${k}])` : `fr(${acc} + fr(a[${k}] * b[${k}]))`), '')} }`
      case 'len': return `function ${name}(a) { return fr(Math.sqrt(${this.helper(`dot_f${n}`)}(a, a))) }`
      case 'dist': return `function ${name}(a, b) { return ${this.helper(`len_f${n}`)}(${this.helper(`sub_f${n}_vv`)}(a, b)) }`
      case 'norm': return `function ${name}(a) { const l = ${this.helper(`len_f${n}`)}(a); return ${list((k) => `fr(a[${k}] / l)`)} }`
      case 'any': return `function ${name}(a) { return ${comps.map((k) => `a[${k}]`).join(' || ')} }`
      case 'all': return `function ${name}(a) { return ${comps.map((k) => `a[${k}]`).join(' && ')} }`
      case 'splat': return `function ${name}(x) { return ${list(() => 'x')} }`
      case 'bits': return unary((x) => `bitsOf(${x})`)
      case 'rdv': return `function ${name}(B, w) { const a = B.${VIEW[s]}; return ${list((k) => `a[w + ${k}]`)} }`
      case 'wrv': return `function ${name}(B, w, v) { const a = B.${VIEW[s]}; ${comps.map((k) => `a[w + ${k}] = v[${k}]`).join('; ')} }`
      case 'swz': return `function ${name}(v, ${comps.map((k) => `i${k}`).join(', ')}) { return ${list((k) => `v[i${k}]`)} }`
      case 'cvtf': return unary((x) => this.convert('f32', s, x))
      case 'cvti': return unary((x) => this.convert('i32', s, x))
      case 'cvtu': return unary((x) => this.convert('u32', s, x))
      default: throw new Error(`wgsl: no helper ${name}`)
    }
  }

  #fixedHelper(name: string): string | null {
    const st = /^(rd|wr|cl|zero)_(.+)$/.exec(name)
    if (!st) return null
    const [, what, key] = st
    const ty = this.#typeByKey(key)
    if (!ty) return null
    return this.#memHelper(what, ty, name)
  }

  readonly #keyed = new Map<string, Ty>()
  #typeByKey(key: string): Ty | undefined { return this.#keyed.get(key) }
  #keyOf(ty: Ty): string { const k = tyKey(ty); this.#keyed.set(k, ty); return k }

  /** A reader `(B, word) => value`, writer `(B, word, value)`, clone or zero for a struct or array type. */
  #memHelper(what: string, ty: Ty, name: string): string {
    if (ty.k === 'struct') {
      const s = this.layouts.structs.get(ty.name)!
      if (what === 'rd') return `function ${name}(B, w) { return { ${s.members.map((m) => `${m.name}: ${this.readAt(m.ty, 'B', `w + ${m.offset / 4}`)}`).join(', ')} } }`
      if (what === 'wr') return `function ${name}(B, w, v) { ${s.members.map((m) => this.writeAt(m.ty, 'B', `w + ${m.offset / 4}`, `v.${m.name}`)).join('; ')} }`
      if (what === 'cl') return `function ${name}(v) { return { ${s.members.map((m) => `${m.name}: ${this.cloneOf(m.ty, `v.${m.name}`)}`).join(', ')} } }`
      return `function ${name}() { return { ${s.members.map((m) => `${m.name}: ${this.zeroOf(m.ty)}`).join(', ')} } }`
    }
    if (ty.k === 'array') {
      const stride = this.layouts.stride(ty.e) / 4
      const n = ty.n ?? 0
      if (what === 'rd') return `function ${name}(B, w) { const o = new Array(${n}); for (let k = 0; k < ${n}; k++) o[k] = ${this.readAt(ty.e, 'B', `w + k * ${stride}`)}; return o }`
      if (what === 'wr') return `function ${name}(B, w, v) { for (let k = 0; k < ${n}; k++) { ${this.writeAt(ty.e, 'B', `w + k * ${stride}`, 'v[k]')} } }`
      if (what === 'cl') return `function ${name}(v) { return v.map((e) => ${this.cloneOf(ty.e, 'e')}) }`
      return `function ${name}() { const o = new Array(${n}); for (let k = 0; k < ${n}; k++) o[k] = ${this.zeroOf(ty.e)}; return o }`
    }
    throw new Error(`wgsl: no ${what} for ${tyStr(ty)}`)
  }

  readAt(ty: Ty, buf: string, word: string): string {
    switch (ty.k) {
      case 'scalar': return `${buf}.${VIEW[ty.s]}[${word}]`
      case 'atomic': return `${buf}.u[${word}]`
      case 'vec': return `${this.helper(`rdv_${SCALAR_LETTER[ty.s]}${ty.n}`)}(${buf}, ${word})`
      case 'struct': case 'array': return `${this.helper(`rd_${this.#keyOf(ty)}`)}(${buf}, ${word})`
      default: throw new Error(`wgsl: cannot read a ${tyStr(ty)}`)
    }
  }

  writeAt(ty: Ty, buf: string, word: string, value: string): string {
    switch (ty.k) {
      case 'scalar': return `${buf}.${VIEW[ty.s]}[${word}] = ${value}`
      case 'atomic': return `${buf}.u[${word}] = ${value}`
      case 'vec': return `${this.helper(`wrv_${SCALAR_LETTER[ty.s]}${ty.n}`)}(${buf}, ${word}, ${value})`
      case 'struct': case 'array': return `${this.helper(`wr_${this.#keyOf(ty)}`)}(${buf}, ${word}, ${value})`
      default: throw new Error(`wgsl: cannot write a ${tyStr(ty)}`)
    }
  }

  cloneOf(ty: Ty, c: string): string {
    switch (ty.k) {
      case 'scalar': return c
      case 'vec': return `${c}.slice()`
      case 'struct': case 'array': return `${this.helper(`cl_${this.#keyOf(ty)}`)}(${c})`
      default: throw new Error(`wgsl: cannot copy a ${tyStr(ty)}`)
    }
  }

  zeroOf(ty: Ty): string {
    switch (ty.k) {
      case 'scalar': return ty.s === 'bool' ? 'false' : '0'
      case 'vec': return `[${Array(ty.n).fill(ty.s === 'bool' ? 'false' : '0').join(', ')}]`
      case 'struct': case 'array': return `${this.helper(`zero_${this.#keyOf(ty)}`)}()`
      default: throw new Error(`wgsl: no zero for ${tyStr(ty)}`)
    }
  }

  // ---- scalar arithmetic with WGSL's semantics

  scalarBin(op: string, s: Scalar, a: string, b: string): string {
    const int = s === 'i32' || s === 'u32'
    const wrap = (x: string): string => (s === 'u32' ? `((${x}) >>> 0)` : s === 'i32' ? `((${x}) | 0)` : s === 'f32' ? `fr(${x})` : `(${x})`)
    switch (op) {
      case '+': case '-': return wrap(`${a} ${op} ${b}`)
      case '*': return int ? wrap(`Math.imul(${a}, ${b})`) : wrap(`${a} * ${b}`)
      case '/': return int ? wrap(`${a} / ${b}`) : s === 'aint' ? `Math.trunc(${a} / ${b})` : wrap(`${a} / ${b}`)
      case '%': return wrap(`${a} % ${b}`)
      case '<<': return wrap(`${a} << ${b}`)
      case '>>': return s === 'u32' ? `(${a} >>> ${b})` : `(${a} >> ${b})`
      case '&': case '|': case '^': return wrap(`${a} ${op} ${b}`)
      case '==': return `(${a} === ${b})`
      case '!=': return `(${a} !== ${b})`
      case '<': case '<=': case '>': case '>=': return `(${a} ${op} ${b})`
      case '&&': case '||': return `(${a} ${op} ${b})`
      default: throw new Error(`wgsl: operator ${op}`)
    }
  }

  scalarUnary(op: string, s: Scalar, x: string): string {
    switch (op) {
      case '-': return s === 'u32' ? `((-${x}) >>> 0)` : s === 'i32' ? `((-${x}) | 0)` : `(-${x})`
      case '!': return `(!${x})`
      case '~': return s === 'u32' ? `((~${x}) >>> 0)` : `(~${x})`
      default: throw new Error(`wgsl: unary ${op}`)
    }
  }

  /** The value conversion builtins (`f32(x)`, `i32(x)`, `u32(x)`) on a scalar. */
  convert(to: Scalar, from: Scalar, x: string): string {
    if (to === from) return x
    switch (to) {
      case 'f32': return from === 'bool' ? `(${x} ? 1 : 0)` : `fr(${x})`
      case 'i32': return from === 'u32' ? `(${x} | 0)` : from === 'bool' ? `(${x} ? 1 : 0)` : from === 'aint' ? x : `i32f(${x})`
      case 'u32': return from === 'i32' ? `(${x} >>> 0)` : from === 'bool' ? `(${x} ? 1 : 0)` : from === 'aint' ? `(${x} >>> 0)` : `u32f(${x})`
      case 'bool': return `(${x} !== 0)`
      default: throw new Error(`wgsl: conversion to ${to}`)
    }
  }

  // ---- expressions

  /** `e` as a value of type `t` (abstract numbers made concrete, f32 literals rounded). */
  coerce(v: Val, t: Ty): string {
    if (v.t.k === 'scalar' && isAbstract(v.t.s)) {
      if (t.k === 'scalar' && t.s === 'f32') return /^-?[\d.e+-]+$/i.test(v.c) ? String(Math.fround(Number(v.c))) : `fr(${v.c})`
      if (t.k === 'vec' && t.s === 'f32') return `${this.helper(`splat_f${t.n}`)}(fr(${v.c}))`
      if (t.k === 'vec') return `${this.helper(`splat_${SCALAR_LETTER[t.s]}${t.n}`)}(${v.c})`
      return v.c
    }
    if (v.t.k === 'scalar' && t.k === 'vec') return `${this.helper(`splat_${SCALAR_LETTER[t.s]}${t.n}`)}(${v.c})`
    return v.c
  }

  /** The common type of two operands (one may be abstract, one may be a scalar broadcast into a vector). */
  unify(a: Ty, b: Ty): Ty {
    if (a.k === 'scalar' && b.k === 'scalar') {
      if (a.s === b.s) return a
      if (isAbstract(a.s) && !isAbstract(b.s)) return b
      if (isAbstract(b.s) && !isAbstract(a.s)) return a
      if (isAbstract(a.s) && isAbstract(b.s)) return S('afloat')
      throw new Error(`wgsl: ${a.s} with ${b.s}`)
    }
    if (a.k === 'vec' && b.k === 'vec') return V(a.n, (this.unify(S(a.s), S(b.s)) as { s: Scalar }).s)
    if (a.k === 'vec' && b.k === 'scalar') return V(a.n, (this.unify(S(a.s), b) as { s: Scalar }).s)
    if (a.k === 'scalar' && b.k === 'vec') return V(b.n, (this.unify(a, S(b.s)) as { s: Scalar }).s)
    throw new Error(`wgsl: cannot combine ${tyStr(a)} and ${tyStr(b)}`)
  }

  concrete(t: Ty): Ty {
    if (t.k === 'scalar' && t.s === 'aint') return I32
    if (t.k === 'scalar' && t.s === 'afloat') return F32
    return t
  }

  expr(e: Expr, sc: Scope): Val {
    switch (e.k) {
      case 'lit': return { c: e.t === 'f32' ? String(Math.fround(Number(e.v))) : String(Number(e.v)), t: S(e.t) }
      case 'bool': return { c: String(e.v), t: BOOL }
      case 'id': case 'member': case 'index': return this.load(this.place(e, sc))
      case 'un': {
        if (e.op === '&') throw new Error('wgsl: a pointer outside an atomic builtin')
        const v = this.expr(e.e, sc)
        if (v.t.k === 'vec') {
          const name = e.op === '-' ? `neg_${SCALAR_LETTER[v.t.s]}${v.t.n}` : `not_b${v.t.n}`
          return { c: `${this.helper(name)}(${v.c})`, t: v.t }
        }
        if (v.t.k !== 'scalar') throw new Error(`wgsl: unary ${e.op} on ${tyStr(v.t)}`)
        if (e.op === '-' && e.e.k === 'lit') return { c: `-${v.c}`, t: v.t }
        return { c: this.scalarUnary(e.op, v.t.s, v.c), t: v.t }
      }
      case 'bin': return this.binary(e, sc)
      case 'call': return this.call(e, sc)
    }
  }

  binary(e: Extract<Expr, { k: 'bin' }>, sc: Scope): Val {
    const l = this.expr(e.l, sc), r = this.expr(e.r, sc)
    const op = e.op
    if (op === '&&' || op === '||') return { c: `(${l.c} ${op} ${r.c})`, t: BOOL }
    const shift = op === '<<' || op === '>>'
    const t = shift ? (l.t.k === 'scalar' && isAbstract(l.t.s) ? this.concrete(l.t) : l.t) : this.unify(l.t, r.t)
    const cmp = ['<', '<=', '>', '>=', '==', '!='].includes(op)
    if (t.k === 'scalar') {
      const lc = this.coerce(l, t), rc = shift ? this.coerce(r, U32) : this.coerce(r, t)
      const s = cmp ? BOOL : this.concrete(t)
      return { c: this.scalarBin(op, t.s, lc, rc), t: cmp ? s : t.k === 'scalar' && isAbstract(t.s) ? t : s }
    }
    if (t.k !== 'vec') throw new Error(`wgsl: ${op} on ${tyStr(t)}`)
    const NAMES: Record<string, string> = { '+': 'add', '-': 'sub', '*': 'mul', '/': 'div', '%': 'mod', '<': 'lt', '<=': 'le', '>': 'gt', '>=': 'ge', '==': 'eq', '!=': 'ne', '&': 'and', '|': 'or', '^': 'xor', '<<': 'shl', '>>': 'shr' }
    const shape = l.t.k === 'vec' && r.t.k === 'vec' ? 'vv' : l.t.k === 'vec' ? 'vs' : 'sv'
    const el = S(t.s)
    const lc = l.t.k === 'vec' ? l.c : this.coerce(l, el), rc = r.t.k === 'vec' ? r.c : this.coerce(r, el)
    return { c: `${this.helper(`${NAMES[op]}_${SCALAR_LETTER[t.s]}${t.n}_${shape}`)}(${lc}, ${rc})`, t: cmp ? V(t.n, 'bool') : t }
  }

  /** The place an expression names (a variable, a buffer element, a member, a component), or a plain value. */
  place(e: Expr, sc: Scope): Place {
    switch (e.k) {
      case 'id': {
        const b = sc.lookup(e.name)
        if (!b) throw new Error(`wgsl: unknown name ${e.name}`)
        if (b.root === 'global') return { k: 'mem', buf: b.js, word: '0', t: b.ty }
        return { k: 'local', c: b.js, t: b.ty, root: b.root }
      }
      case 'index': {
        const base = this.place(e.e, sc)
        const idx = this.expr(e.i, sc)
        const ic = this.coerce(idx, idx.t.k === 'scalar' && isAbstract(idx.t.s) ? I32 : idx.t)
        const t = base.t
        if (t.k === 'array') {
          if (base.k === 'mem') return { k: 'mem', buf: base.buf, word: `${base.word} + (${ic}) * ${this.layouts.stride(t.e) / 4}`, t: t.e }
          return { k: 'val', c: `${this.load(base).c}[${ic}]`, t: t.e }
        }
        if (t.k === 'vec') {
          if (base.k === 'mem') return { k: 'mem', buf: base.buf, word: `${base.word} + (${ic})`, t: S(t.s) }
          return { k: 'val', c: `${this.load(base).c}[${ic}]`, t: S(t.s) }
        }
        throw new Error(`wgsl: indexing a ${tyStr(t)}`)
      }
      case 'member': {
        const base = this.place(e.e, sc)
        const t = base.t
        if (t.k === 'struct') {
          const s = this.layouts.structs.get(t.name)!
          const m = s.members.find((x) => x.name === e.name)
          if (!m) throw new Error(`wgsl: ${t.name} has no member ${e.name}`)
          if (base.k === 'mem') return { k: 'mem', buf: base.buf, word: `${base.word} + ${m.offset / 4}`, t: m.ty }
          if (base.k === 'local') return { k: 'local', c: `${base.c}.${m.name}`, t: m.ty, root: base.root }
          return { k: 'val', c: `${this.load(base).c}.${m.name}`, t: m.ty }
        }
        if (t.k === 'vec') {
          const comps = [...e.name].map((ch) => COMP[ch])
          if (comps.some((c) => c === undefined || c >= t.n)) throw new Error(`wgsl: swizzle ${e.name} on ${tyStr(t)}`)
          if (comps.length === 1) {
            if (base.k === 'mem') return { k: 'mem', buf: base.buf, word: `${base.word} + ${comps[0]}`, t: S(t.s) }
            if (base.k === 'local') return { k: 'local', c: `${base.c}[${comps[0]}]`, t: S(t.s), root: base.root }
            return { k: 'val', c: `${this.load(base).c}[${comps[0]}]`, t: S(t.s) }
          }
          return { k: 'swizzle', base, comps, t: V(comps.length, t.s) }
        }
        throw new Error(`wgsl: member ${e.name} of ${tyStr(t)}`)
      }
      default: return { k: 'val', c: this.expr(e, sc).c, t: this.expr(e, sc).t }
    }
  }

  load(p: Place): Val {
    switch (p.k) {
      case 'mem': return { c: this.readAt(p.t, p.buf, p.word), t: p.t }
      case 'local': case 'val': return { c: p.c, t: p.t }
      case 'swizzle': return { c: `${this.helper(`swz_${SCALAR_LETTER[(p.t as { s: Scalar }).s]}${p.comps.length}`)}(${this.load(p.base).c}, ${p.comps.join(', ')})`, t: p.t }
    }
  }

  /** A value to store in a fresh variable: a copy where the source is another variable's vector, struct or array. */
  copied(e: Expr, v: Val, sc: Scope): string {
    if (v.t.k === 'scalar' || v.t.k === 'void') return v.c
    const rooted = (x: Expr): boolean => (x.k === 'id' ? sc.lookup(x.name)?.root !== 'global' : x.k === 'member' || x.k === 'index' ? rooted(x.e) : false)
    if (rooted(e)) return this.cloneOf(v.t, v.c)
    return v.c
  }

  call(e: Extract<Expr, { k: 'call' }>, sc: Scope): Val {
    const name = e.name
    const args = (): Val[] => e.args.map((a) => this.expr(a, sc))
    // Constructors and conversions.
    const short = SHORT_VEC[name]
    if (short || name === 'vec2' || name === 'vec3' || name === 'vec4') {
      const n = short ? short[0] : Number(name[3])
      const s: Scalar = short ? short[1] : (e.targs[0] as { s: Scalar }).s
      return this.construct(n, s, args())
    }
    if (name === 'f32' || name === 'i32' || name === 'u32' || name === 'bool') {
      const [a] = args()
      if (a.t.k === 'vec') return { c: `${this.helper(`cvt${name[0]}_${SCALAR_LETTER[a.t.s]}${a.t.n}`)}(${a.c})`, t: V(a.t.n, name) }
      if (a.t.k !== 'scalar') throw new Error(`wgsl: ${name}(${tyStr(a.t)})`)
      if (isAbstract(a.t.s) && a.c.match(/^-?[\d.e+-]+$/i)) return { c: name === 'f32' ? String(Math.fround(Number(a.c))) : String(Math.trunc(Number(a.c))), t: S(name) }
      return { c: this.convert(name, a.t.s, a.c), t: S(name) }
    }
    if (name === 'bitcast') {
      const to = e.targs[0]
      const [a] = args()
      if (to.k === 'vec' && a.t.k === 'vec') {
        if (to.s === 'u32' && a.t.s === 'f32') return { c: `${this.helper(`bits_f${to.n}`)}(${a.c})`, t: to }
        if (to.s === 'u32' && a.t.s === 'i32') return { c: `${this.helper(`cvtu_i${to.n}`)}(${a.c})`, t: to }
        if (to.s === 'i32' && a.t.s === 'u32') return { c: `${this.helper(`cvti_u${to.n}`)}(${a.c})`, t: to }
      }
      if (to.k === 'scalar' && a.t.k === 'scalar') {
        if (to.s === 'u32' && a.t.s === 'f32') return { c: `bitsOf(${a.c})`, t: to }
        if (to.s === 'u32') return { c: `(${a.c} >>> 0)`, t: to }
        if (to.s === 'i32') return { c: `(${a.c} | 0)`, t: to }
      }
      throw new Error(`wgsl: bitcast<${tyStr(to)}>(${tyStr(a.t)})`)
    }
    if (name === 'array') {
      const et = e.targs[0]
      const vs = args()
      return { c: `[${vs.map((v) => this.coerce(v, et)).join(', ')}]`, t: { k: 'array', e: et, n: vs.length } }
    }
    // Atomics take a pointer to a storage word.
    if (name.startsWith('atomic')) {
      const ptr = e.args[0]
      if (ptr.k !== 'un' || ptr.op !== '&') throw new Error(`wgsl: ${name} needs &`)
      const p = this.place(ptr.e, sc)
      if (p.k !== 'mem') throw new Error(`wgsl: ${name} on a value`)
      const v = e.args[1] ? this.coerce(this.expr(e.args[1], sc), U32) : '0'
      const op = name === 'atomicAdd' ? 'aadd' : name === 'atomicMin' ? 'amin' : name === 'atomicMax' ? 'amax' : name === 'atomicOr' ? 'aor' : name === 'atomicAnd' ? 'aand' : name === 'atomicStore' ? 'astore' : name === 'atomicLoad' ? 'aload' : null
      if (!op) throw new Error(`wgsl: ${name}`)
      return { c: `${op}(${p.buf}, ${p.word}${name === 'atomicLoad' ? '' : `, ${v}`})`, t: name === 'atomicStore' ? VOID : U32 }
    }
    if (name === 'textureDimensions') {
      const p = this.place(e.args[0], sc)
      if (p.k !== 'mem') throw new Error('wgsl: textureDimensions of a value')
      return { c: `[${p.buf}.width, ${p.buf}.height]`, t: V(2, 'u32') }
    }
    if (name === 'textureLoad') {
      const p = this.place(e.args[0], sc)
      if (p.k !== 'mem') throw new Error('wgsl: textureLoad of a value')
      const c = this.expr(e.args[1], sc)
      return { c: `texLoad(${p.buf}, ${c.c})`, t: V(4, 'f32') }
    }
    const user = this.fns.get(name)
    if (user) {
      const vs = args()
      if (vs.length !== user.params.length) throw new Error(`wgsl: ${name} takes ${user.params.length} arguments`)
      return { c: `$${name}(${vs.map((v, k) => this.coerce(v, user.params[k].ty)).join(', ')})`, t: user.ret }
    }
    return this.builtin(name, args())
  }

  construct(n: number, s: Scalar, vs: Val[]): Val {
    const t = V(n, s)
    if (vs.length === 1 && vs[0].t.k === 'scalar') return { c: this.coerce(vs[0].t.k === 'scalar' && isAbstract(vs[0].t.s) ? vs[0] : { c: this.convert(s, vs[0].t.s, vs[0].c), t: S(s) }, t), t }
    if (vs.length === 1 && vs[0].t.k === 'vec') {
      const from = vs[0].t.s
      if (from === s) return { c: this.cloneOf(t, vs[0].c), t }
      return { c: `${this.helper(`cvt${SCALAR_LETTER[s]}_${SCALAR_LETTER[from]}${n}`)}(${vs[0].c})`, t }
    }
    // A list of scalars and vectors whose components add up to n.
    const parts: string[] = []
    for (const v of vs) {
      if (v.t.k === 'scalar') parts.push(this.coerce(isAbstract(v.t.s) ? v : { c: this.convert(s, v.t.s, v.c), t: S(s) }, S(s)))
      else if (v.t.k === 'vec') parts.push(`...${v.t.s === s ? v.c : `${this.helper(`cvt${SCALAR_LETTER[s]}_${SCALAR_LETTER[v.t.s]}${v.t.n}`)}(${v.c})`}`)
      else throw new Error(`wgsl: vec${n} of ${tyStr(v.t)}`)
    }
    return { c: `[${parts.join(', ')}]`, t }
  }

  builtin(name: string, vs: Val[]): Val {
    const vecOf = vs.find((v) => v.t.k === 'vec')
    const unifyAll = (): Ty => vs.reduce<Ty>((t, v) => this.unify(t, v.t), vs[0].t)
    const sv = (f: string): Val => {
      // A componentwise builtin: on a vector by helper, on a scalar inline.
      if (vecOf) {
        const t = unifyAll() as Extract<Ty, { k: 'vec' }>
        return { c: `${this.helper(`${f}_${SCALAR_LETTER[t.s]}${t.n}`)}(${vs.map((v) => this.coerce(v, t)).join(', ')})`, t }
      }
      const t = this.concrete(unifyAll())
      if (t.k !== 'scalar') throw new Error(`wgsl: ${f} on ${tyStr(t)}`)
      const cs = vs.map((v) => this.coerce(v, t))
      const s = t.s
      const fr = (x: string): string => (s === 'f32' ? `fr(${x})` : x)
      switch (f) {
        case 'abs': return { c: s === 'i32' ? `(Math.abs(${cs[0]}) | 0)` : `Math.abs(${cs[0]})`, t }
        case 'floor': return { c: `Math.floor(${cs[0]})`, t }
        case 'round': return { c: `rnd(${cs[0]})`, t }
        case 'sign': return { c: `Math.sign(${cs[0]})`, t }
        case 'sqrt': return { c: fr(`Math.sqrt(${cs[0]})`), t }
        case 'min': return { c: `Math.min(${cs[0]}, ${cs[1]})`, t }
        case 'max': return { c: `Math.max(${cs[0]}, ${cs[1]})`, t }
        case 'clamp': return { c: `Math.min(Math.max(${cs[0]}, ${cs[1]}), ${cs[2]})`, t }
        case 'mix': return { c: `fr(fr(${cs[0]} * fr(1 - ${cs[2]})) + fr(${cs[1]} * ${cs[2]}))`, t }
        default: throw new Error(`wgsl: builtin ${f}`)
      }
    }
    switch (name) {
      case 'abs': case 'floor': case 'round': case 'sign': case 'sqrt': case 'min': case 'max': case 'clamp': return sv(name)
      case 'mix': {
        if (vecOf) {
          const t = vecOf.t as Extract<Ty, { k: 'vec' }>
          return { c: `${this.helper(`mix_f${t.n}`)}(${this.coerce(vs[0], t)}, ${this.coerce(vs[1], t)}, ${this.coerce(vs[2], F32)})`, t }
        }
        return sv('mix')
      }
      case 'sin': case 'cos': case 'tan': case 'exp': case 'log': return { c: `fr(Math.${name}(${this.coerce(vs[0], F32)}))`, t: F32 }
      case 'atan2': return { c: `fr(Math.atan2(${this.coerce(vs[0], F32)}, ${this.coerce(vs[1], F32)}))`, t: F32 }
      case 'pow': return { c: `fr(Math.pow(${this.coerce(vs[0], F32)}, ${this.coerce(vs[1], F32)}))`, t: F32 }
      case 'select': {
        const t = this.unify(vs[0].t, vs[1].t)
        const c = vs[2]
        if (c.t.k === 'vec' && t.k === 'vec') return { c: `${this.helper(`sel_${SCALAR_LETTER[t.s]}${c.t.n}`)}(${this.coerce(vs[0], t)}, ${this.coerce(vs[1], t)}, ${c.c})`, t }
        return { c: `(${c.c} ? ${this.coerce(vs[1], t)} : ${this.coerce(vs[0], t)})`, t }
      }
      case 'dot': { const t = vecOf!.t as Extract<Ty, { k: 'vec' }>; return { c: `${this.helper(`dot_f${t.n}`)}(${vs[0].c}, ${vs[1].c})`, t: F32 } }
      case 'length': { const t = vecOf!.t as Extract<Ty, { k: 'vec' }>; return { c: `${this.helper(`len_f${t.n}`)}(${vs[0].c})`, t: F32 } }
      case 'distance': { const t = vecOf!.t as Extract<Ty, { k: 'vec' }>; return { c: `${this.helper(`dist_f${t.n}`)}(${vs[0].c}, ${vs[1].c})`, t: F32 } }
      case 'normalize': { const t = vecOf!.t as Extract<Ty, { k: 'vec' }>; return { c: `${this.helper(`norm_f${t.n}`)}(${vs[0].c})`, t } }
      case 'any': case 'all': { const t = vecOf!.t as Extract<Ty, { k: 'vec' }>; return { c: `${this.helper(`${name}_b${t.n}`)}(${vs[0].c})`, t: BOOL } }
      default: throw new Error(`wgsl: unknown function ${name}`)
    }
  }

  // ---- statements

  stmts(list: Stmt[], sc: Scope, indent: string): string {
    const inner = new Scope(sc)
    return list.map((s) => this.stmt(s, inner, indent)).join('\n')
  }

  /** A statement as JavaScript (no trailing newline); simple ones (assignments, steps, calls) without a semicolon. */
  simple(s: Stmt, sc: Scope): string {
    switch (s.k) {
      case 'decl': {
        const init = s.init ? this.expr(s.init, sc) : null
        let t: Ty = s.ty ?? (init ? this.concrete(init.t) : VOID)
        if (t.k === 'void') throw new Error(`wgsl: ${s.name} has no type`)
        if (init && init.t.k === 'scalar' && isAbstract(init.t.s) && s.ty) t = s.ty
        const js = `$${s.name}`
        const value = init ? (s.init && s.init.k !== 'lit' ? this.copied(s.init, { c: this.coerce(init, t), t }, sc) : this.coerce(init, t)) : this.zeroOf(t)
        sc.vars.set(s.name, { ty: t, js, root: 'local' })
        return `let ${js} = ${value}`
      }
      case 'assign': {
        const p = this.place(s.lhs, sc)
        const rhs = this.expr(s.rhs, sc)
        const op = s.op.slice(0, -1)
        let value: string
        if (op === '') value = this.copied(s.rhs, { c: this.coerce(rhs, p.t), t: p.t }, sc)
        else {
          const cur = this.load(p)
          value = this.binary({ k: 'bin', op, l: { k: 'id', name: '\u0000cur' }, r: s.rhs }, this.#with(sc, '\u0000cur', cur.c, p.t)).c
        }
        return this.store(p, value)
      }
      case 'step': {
        const p = this.place(s.lhs, sc)
        const cur = this.load(p)
        return this.store(p, this.scalarBin(s.op, (p.t as { s: Scalar }).s, cur.c, '1'))
      }
      case 'expr': return this.expr(s.e, sc).c
      default: throw new Error(`wgsl: ${s.k} is not a simple statement`)
    }
  }

  #with(sc: Scope, name: string, c: string, t: Ty): Scope {
    const inner = new Scope(sc)
    inner.vars.set(name, { ty: t, js: c, root: 'local' })
    return inner
  }

  store(p: Place, value: string): string {
    switch (p.k) {
      case 'mem': return this.writeAt(p.t, p.buf, p.word, value)
      case 'local': return `${p.c} = ${value}`
      default: throw new Error('wgsl: assignment to a value')
    }
  }

  stmt(s: Stmt, sc: Scope, indent: string): string {
    const I = indent, J = indent + '  '
    switch (s.k) {
      case 'decl': case 'assign': case 'step': case 'expr': return `${I}${this.simple(s, sc)};`
      case 'block': return `${I}{\n${this.stmts(s.body, sc, J)}\n${I}}`
      case 'if': {
        const c = this.expr(s.cond, sc)
        let out = `${I}if (${c.c}) {\n${this.stmts(s.then, sc, J)}\n${I}}`
        if (s.otherwise) out += ` else {\n${this.stmts(s.otherwise, sc, J)}\n${I}}`
        return out
      }
      case 'for': {
        const inner = new Scope(sc)
        const init = s.init ? this.simple(s.init, inner) : ''
        const cond = s.cond ? this.expr(s.cond, inner).c : ''
        const update = s.update ? this.simple(s.update, inner) : ''
        return `${I}for (${init}; ${cond}; ${update}) {\n${this.stmts(s.body, inner, J)}\n${I}}`
      }
      case 'switch': {
        const v = this.expr(s.e, sc)
        const cases = s.cases.map((c) => {
          const labels = c.values === null ? `${J}default:` : c.values.map((x) => `${J}case ${this.coerce(this.expr(x, sc), v.t)}:`).join('\n')
          return `${labels} {\n${this.stmts(c.body, sc, J + '  ')}\n${J}  break;\n${J}}`
        })
        return `${I}switch (${v.c}) {\n${cases.join('\n')}\n${I}}`
      }
      case 'return': {
        if (!s.e) return `${I}return;`
        const v = this.expr(s.e, sc)
        return `${I}return ${this.copied(s.e, { c: this.coerce(v, this.#retTy), t: this.#retTy }, sc)};`
      }
      case 'break': return `${I}break;`
      case 'continue': return `${I}continue;`
    }
  }

  // ---- the module

  generate(): string {
    const top = new Scope(null)
    const out: string[] = []
    for (const c of this.module.consts) {
      const v = this.expr(c.init, top)
      const t = c.ty ?? this.concrete(v.t)
      top.vars.set(c.name, { ty: t, js: `$${c.name}`, root: 'const' })
      out.push(`const $${c.name} = ${this.coerce(v, t)};`)
    }
    for (const g of this.module.globals) {
      top.vars.set(g.name, { ty: g.ty, js: `B_${g.name}`, root: 'global' })
      out.push(`let B_${g.name} = null;`)
    }
    for (const f of this.module.fns) {
      const sc = new Scope(top)
      for (const p of f.params) sc.vars.set(p.name, { ty: p.ty, js: `$${p.name}`, root: 'local' })
      this.#retTy = f.ret
      out.push(`function $${f.name}(${f.params.map((p) => `$${p.name}`).join(', ')}) {\n${this.stmts(f.body, sc, '  ')}\n}`)
    }
    const helpers = [...this.helpers.values()]
    const entries = this.module.fns.filter((f) => f.workgroupSize !== null)
    out.push(`return {
  fns: { ${this.module.fns.map((f) => `${f.name}: $${f.name}`).join(', ')} },
  sizes: { ${entries.map((f) => `${f.name}: ${f.workgroupSize}`).join(', ')} },
  bind(name, resource) { switch (name) { ${this.module.globals.map((g) => `case ${JSON.stringify(g.name)}: B_${g.name} = resource; break;`).join(' ')} default: throw new Error('wgsl: no binding ' + name) } },
}`)
    return `${RUNTIME}\n${helpers.join('\n')}\n${out.join('\n')}`
  }
}

/** The runtime every compiled module starts with: f32 rounding, conversions, atomics, the texture read. */
const RUNTIME = `'use strict';
const fr = Math.fround;
const bitsF = new Float32Array(1), bitsU = new Uint32Array(bitsF.buffer);
function bitsOf(x) { bitsF[0] = x; return bitsU[0] }
function rnd(x) { const r = Math.round(x); return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r }
function i32f(x) { return x !== x ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : Math.trunc(x) }
function u32f(x) { return x !== x ? 0 : x <= 0 ? 0 : x >= 4294967295 ? 4294967295 : Math.trunc(x) }
function aadd(B, w, v) { const o = B.u[w]; B.u[w] = (o + v) >>> 0; return o }
function amin(B, w, v) { const o = B.u[w]; if (v < o) B.u[w] = v; return o }
function amax(B, w, v) { const o = B.u[w]; if (v > o) B.u[w] = v; return o }
function aor(B, w, v) { const o = B.u[w]; B.u[w] = (o | v) >>> 0; return o }
function aand(B, w, v) { const o = B.u[w]; B.u[w] = (o & v) >>> 0; return o }
function astore(B, w, v) { B.u[w] = v }
function aload(B, w) { return B.u[w] }
function texLoad(T, c) { const i = (c[1] * T.width + c[0]) * T.channels; const d = T.data; return [d[i], T.channels > 1 ? d[i + 1] : 0, T.channels > 2 ? d[i + 2] : 0, T.channels > 3 ? d[i + 3] : 1] }
`

// ---------------------------------------------------------------- the public face

/** A buffer a compiled module binds: one byte store seen as floats, unsigned and signed words. */
export interface HostBuffer {
  readonly bytes: ArrayBuffer
  readonly f: Float32Array
  readonly u: Uint32Array
  readonly i: Int32Array
}

/** A 2D texture a compiled module samples with textureLoad: `channels` floats per texel, row-major. */
export interface HostTexture {
  readonly width: number
  readonly height: number
  readonly channels: number
  readonly data: Float32Array
}

export interface HostModule {
  /** Runs entry point `name` for every invocation of `groups` workgroups, in order (ids 0 … groups × size − 1). */
  dispatch(name: string, groups: number): void
  /** Binds a buffer or texture to a module-scope variable by its name (`pos`, `P`, `flowField` …). */
  bind(name: string, resource: HostBuffer | HostTexture): void
  /** Calls a (non-entry) function of the module directly: scalars as numbers, vectors as arrays, structs as records. */
  call(name: string, ...args: unknown[]): unknown
  /** The byte layout of a declared struct, as the module reads it. */
  layout(struct: string): { size: number; align: number; members: { name: string; offset: number; type: string }[] }
  /** The entry points and their workgroup sizes. */
  readonly entries: Readonly<Record<string, number>>
  /** The generated JavaScript (for a failing test to show). */
  readonly js: string
}

export function hostBuffer(bytes: number): HostBuffer {
  const b = new ArrayBuffer(bytes)
  return { bytes: b, f: new Float32Array(b), u: new Uint32Array(b), i: new Int32Array(b) }
}

/** Compiles a WGSL compute module (the subset crowd.wgsl uses) to JavaScript and instantiates it. */
export function compileWgsl(source: string): HostModule {
  const parser = new Parser(source)
  const module = parser.module()
  const gen = new Codegen(module)
  const js = gen.generate()
  // The generated code is a closure over the bound buffers; built once per compile, like a pipeline.
  const instance = new Function(js)() as {
    fns: Record<string, (...args: unknown[]) => unknown>
    sizes: Record<string, number>
    bind(name: string, resource: unknown): void
  }
  const host: HostModule = {
    entries: Object.freeze({ ...instance.sizes }),
    js,
    bind(name, resource) { instance.bind(name, resource) },
    call(name, ...args) {
      const f = instance.fns[name]
      if (!f) throw new Error(`wgsl: no function ${name}`)
      return f(...args)
    },
    dispatch(name, groups) {
      const f = instance.fns[name], size = instance.sizes[name]
      if (!f || size === undefined) throw new Error(`wgsl: no entry point ${name}`)
      // One id array for the whole dispatch: an entry point reads its components and never keeps the vector.
      const n = groups * size, gid = [0, 0, 0]
      for (let x = 0; x < n; x++) { gid[0] = x; f(gid) }
    },
    layout(struct) {
      const s = gen.layouts.structs.get(struct)
      if (!s) throw new Error(`wgsl: no struct ${struct}`)
      return { size: s.size, align: s.align, members: s.members.map((m) => ({ name: m.name, offset: m.offset, type: tyStr(m.ty) })) }
    },
  }
  return Object.freeze(host)
}
