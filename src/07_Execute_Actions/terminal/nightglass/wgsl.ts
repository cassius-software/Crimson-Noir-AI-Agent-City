// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It lowers a verified Lens module to WGSL text for the GPU back end: a pure, deterministic
 * translation that makes the browser's GPU compute what the reference interpreter (interp.ts) computes, exactly where
 * docs/nightglass.md pins a result and within a named tolerance where a GPU can only come close. It first builds a
 * typed tree of WGSL (module-scope declarations, functions, statements, and small expressions over `let` names) and
 * then prints it, so the text is regular enough for lowered.test.ts to parse back and run against the interpreter.
 * What breaks if it is removed? The GPU back end would have no shader to hand the browser, and nothing would make a
 * pinned rule (a NaN that gives way in min, a saturating cast, the loop cap, the integer division by zero) hold on a
 * GPU whose own builtins leave those cases open.
 *
 * WHAT IS LOWERED (slice 2, PR 2). Compute modules: the WGSL tree and its printer, every value type, literals as exact
 * bit patterns, arithmetic with the emulations below, casts, building and picking, variables, `if` and `loop` with
 * the 65,536-iteration cap and statement behaviours, typed blocks (uniform blocks, the inline constants in the hidden
 * block, storage blocks of fixed size) and the compute entry. Everything else (images, derivatives, discard, storage
 * blocks that end in an array without a length, the vertex and fragment entries, stepwise arithmetic) is refused
 * with a Fault of code `device` that names it as not yet lowered, never lowered wrong.
 *
 * NAMES. No text of the caller reaches the code: values are `v<id>` (the components of a literal `v<id>_<c>`, and
 * the u32 pattern behind an f32 literal `k<id>`), variables `x<id>`, resources `r<index>`, structs `B<n>` in order of
 * first reach, struct members `f<k>`, and the lowering's own names start with `ng_`. Helpers are emitted only when
 * used, in a fixed order, so the same module and options always give the same text.
 *
 * LITERALS. An f32 that is a whole number of magnitude below 2^24, and not -0, is written in decimal; any other f32,
 * and the most negative i32, goes through a u32 `let` and a `bitcast` of it, so no WGSL const-expression rule can
 * fire and every bit pattern is exact. Every operand of an operation is a `let` name: no operation has two literal
 * operands, and helpers use a literal only beside a run-time value.
 *
 * NUMBERS. Every rule whose pinned result depends on NaN tests the bits (`ng_nan`), which no fast-math compiler can
 * fold: min and max (with cheaper forms where an operand is known not to be NaN), clamp, saturate, step, sign,
 * number-to-bool, the saturating casts (their infinities chosen by the bits too). What WGSL leaves loose in other ways
 * is worked on bits as well: an f32 `neg` or `abs` flips or clears the sign bit and `floor`, `ceil`, `trunc` and
 * `round` take the operand's sign (WGSL may give a zero either sign, and its finite math leaves an operation on a NaN
 * or an infinity open); `fract` and integer to f32 round to nearest even in integer arithmetic (WGSL names no rounding
 * direction). Integer division, remainder and shifts are WGSL's own, which defines exactly the pinned results for
 * run-time operands. Float `rem`, `mix` and `smoothstep` are written out as the reference computes them, each step a
 * statement of its own. The library functions are native inside their domain and exact at its edges (NaN, the signs
 * of zero, infinities, negative roots and logarithms, `asin` and `acos` past 1, `atan2` at zeros, `pow` by
 * ECMAScript's cases and a zero exponent, `length` and `normalize` of NaN, infinite and zero vectors). A fresh NaN or
 * infinity is made at run time from the hidden block's zero word, never as a constant.
 */
import { fail, isFault } from './fault.ts'
import { columnOf, isGrid, isScalar, isVector, layoutBlock, scalarOf, widthOf } from './lens.ts'
import type { Block, Builtin, DataType, Inst, LensModule, Scalar, Space, Step, ValueType } from './lens.ts'
import { verify } from './verify.ts'

// ---------------------------------------------------------------------------------------------------
// The interface

/** Where the hidden block sits and how it is laid out: group 3, binding 0, 208 bytes in a slot of 256. */
export const WGSL_HIDDEN = Object.freeze({
  group: 3,
  binding: 0,
  /** 128 bytes: the inline constants, laid out by layoutBlock(block, 'uniform'). */
  constants: 0,
  /** array<vec4<u32>, 4>: per vertex input slot, the last whole element it may read. */
  lim: 128,
  /** u32 bit mask: input slots with no whole element this draw. */
  none: 192,
  /** u32 bit mask: input slots whose element must be checked this draw. */
  checked: 196,
  /** i32: the draw's base vertex. */
  base: 200,
  /** u32: always 0; the stepwise fence, and the source of run-time NaN and infinity patterns. */
  zero: 204,
  size: 208,
  slot: 256,
} as const)

export interface WgslOptions {
  /** Per resource index: the access a storage resource is declared with, from its layout entry's kind. */
  readonly storage: readonly ('read' | 'read_write' | null)[]
  /** Fragment: per colour slot, the scalar kind of the attachment's format, or null for no attachment. */
  readonly outputs: readonly ('f32' | 'i32' | 'u32' | null)[]
  /** Vertex: bit mask of input slots fed at the vertex rate. */
  readonly vertexRate: number
  /** Vertex and fragment: the location carrying the live value, or null. */
  readonly live: number | null
  /** 'native' (the default) or 'stepwise'. */
  readonly arithmetic: 'native' | 'stepwise'
}

export interface WgslOut {
  readonly code: string
  readonly entry: 'ng_vertex' | 'ng_fragment' | 'ng_compute'
  /** Resources lowered as raw words (none before raw blocks are lowered). */
  readonly raw: readonly number[]
  /** The module starts with the derivative-uniformity directive. */
  readonly directive: boolean
}

// ---------------------------------------------------------------------------------------------------
// The WGSL tree

/** An expression: a name, a literal token, a call (constructors and conversions included), an operator, an access. */
type Expr =
  | { readonly k: 'id'; readonly name: string }
  | { readonly k: 'lit'; readonly text: string }
  | { readonly k: 'call'; readonly fn: string; readonly args: readonly Expr[] }
  | { readonly k: 'unary'; readonly op: '-' | '!' | '~'; readonly a: Expr }
  | { readonly k: 'binary'; readonly op: string; readonly a: Expr; readonly b: Expr }
  | { readonly k: 'member'; readonly a: Expr; readonly name: string }
  | { readonly k: 'index'; readonly a: Expr; readonly i: Expr }

type Stmt =
  | { readonly k: 'let'; readonly name: string; readonly type: string; readonly e: Expr }
  | { readonly k: 'var'; readonly name: string; readonly type: string; readonly e: Expr | null }
  | { readonly k: 'assign'; readonly lhs: Expr; readonly e: Expr }
  | { readonly k: 'call'; readonly e: Expr }
  | { readonly k: 'if'; readonly c: Expr; readonly then: readonly Stmt[]; readonly else: readonly Stmt[] }
  | { readonly k: 'loop'; readonly body: readonly Stmt[] }
  | { readonly k: 'break' }
  | { readonly k: 'continue' }
  | { readonly k: 'return'; readonly e: Expr | null }

interface Member {
  readonly attrs: string
  readonly name: string
  readonly type: string
}

interface Param {
  readonly attrs: string
  readonly name: string
  readonly type: string
}

type Decl =
  | { readonly k: 'struct'; readonly name: string; readonly members: readonly Member[] }
  | { readonly k: 'var'; readonly attrs: string; readonly space: string; readonly name: string; readonly type: string }
  | { readonly k: 'fn'; readonly attrs: string; readonly name: string; readonly params: readonly Param[]; readonly ret: string | null; readonly body: readonly Stmt[] }

const id = (name: string): Expr => ({ k: 'id', name })
const lit = (text: string): Expr => ({ k: 'lit', text })
const call = (fn: string, ...args: readonly Expr[]): Expr => ({ k: 'call', fn, args })
const un = (op: '-' | '!' | '~', a: Expr): Expr => ({ k: 'unary', op, a })
const bin = (op: string, a: Expr, b: Expr): Expr => ({ k: 'binary', op, a, b })
const member = (a: Expr, name: string): Expr => ({ k: 'member', a, name })
const index = (a: Expr, i: Expr): Expr => ({ k: 'index', a, i })
/** WGSL's select(f, t, c): `t` where `c` holds, else `f`. */
const sel = (no: Expr, yes: Expr, c: Expr): Expr => call('select', no, yes, c)
const letS = (name: string, type: string, e: Expr): Stmt => ({ k: 'let', name, type, e })
const ret = (e: Expr): Stmt => ({ k: 'return', e })

// ---------------------------------------------------------------------------------------------------
// The printer

/**
 * An operand as printed inside another expression. A binary operator below any operator is always parenthesised, so
 * no WGSL precedence rule (nor its refusal to mix `&` with `|` or to chain comparisons) is ever leaned on. A unary
 * operator is parenthesised below a unary operator or an access, never below a binary one, where WGSL's grammar takes
 * it as it is (`!ng_nan(b) & (b < a)`); a space on each side of a binary operator keeps `- -p` from reading as `--`.
 */
function operand(e: Expr, inBinary = false): string {
  return e.k === 'binary' || (e.k === 'unary' && !inBinary) ? `(${expr(e)})` : expr(e)
}

function expr(e: Expr): string {
  switch (e.k) {
    case 'id': return e.name
    case 'lit': return e.text
    case 'call': return `${e.fn}(${e.args.map(expr).join(', ')})`
    case 'unary': return `${e.op}${operand(e.a)}`
    case 'binary': return `${operand(e.a, true)} ${e.op} ${operand(e.b, true)}`
    case 'member': return `${operand(e.a)}.${e.name}`
    case 'index': return `${operand(e.a)}[${expr(e.i)}]`
  }
}

function stmts(list: readonly Stmt[], pad: string, out: string[]): void {
  for (const s of list) {
    switch (s.k) {
      case 'let': out.push(`${pad}let ${s.name}: ${s.type} = ${expr(s.e)};`); break
      case 'var': out.push(s.e === null ? `${pad}var ${s.name}: ${s.type};` : `${pad}var ${s.name}: ${s.type} = ${expr(s.e)};`); break
      case 'assign': out.push(`${pad}${expr(s.lhs)} = ${expr(s.e)};`); break
      case 'call': out.push(`${pad}${expr(s.e)};`); break
      case 'if':
        out.push(`${pad}if (${expr(s.c)}) {`)
        stmts(s.then, `${pad}  `, out)
        if (s.else.length > 0) {
          out.push(`${pad}} else {`)
          stmts(s.else, `${pad}  `, out)
        }
        out.push(`${pad}}`)
        break
      case 'loop':
        out.push(`${pad}loop {`)
        stmts(s.body, `${pad}  `, out)
        out.push(`${pad}}`)
        break
      case 'break': out.push(`${pad}break;`); break
      case 'continue': out.push(`${pad}continue;`); break
      case 'return': out.push(s.e === null ? `${pad}return;` : `${pad}return ${expr(s.e)};`); break
    }
  }
}

/** The text of a tree: declarations in order, a blank line before each struct and function, one final line feed. */
function print(decls: readonly Decl[]): string {
  const out: string[] = []
  let last: Decl['k'] | null = null
  for (const d of decls) {
    if (last !== null && (d.k !== 'var' || last !== 'var')) out.push('')
    last = d.k
    switch (d.k) {
      case 'struct':
        out.push(`struct ${d.name} {`)
        for (const m of d.members) out.push(`  ${m.attrs === '' ? '' : `${m.attrs} `}${m.name}: ${m.type},`)
        out.push('}')
        break
      case 'var':
        out.push(`${d.attrs === '' ? '' : `${d.attrs} `}var${d.space} ${d.name}: ${d.type};`)
        break
      case 'fn': {
        const params = d.params.map((p) => `${p.attrs === '' ? '' : `${p.attrs} `}${p.name}: ${p.type}`).join(', ')
        out.push(`${d.attrs === '' ? '' : `${d.attrs} `}fn ${d.name}(${params})${d.ret === null ? '' : ` -> ${d.ret}`} {`)
        stmts(d.body, '  ', out)
        out.push('}')
        break
      }
    }
  }
  return `${out.join('\n')}\n`
}

// ---------------------------------------------------------------------------------------------------
// Types and literals

/** The WGSL type of a Lens value type. A grid's padded columns are laid out as WGSL lays out a `matNxN<f32>`. */
function wtype(t: ValueType): string {
  if (isGrid(t)) {
    const n = widthOf(t)
    return `mat${n}x${n}<f32>`
  }
  const s = scalarOf(t)
  return isVector(t) ? `vec${widthOf(t)}<${s}>` : s
}

/** The scalar or vector WGSL type of `n` components of `s`. */
function vtype(s: Scalar, n: number): string {
  return n === 1 ? s : `vec${n}<${s}>`
}

const bitsView = new DataView(new ArrayBuffer(4))

/** The binary32 bit pattern of an f32, as an unsigned number. */
function f32Bits(x: number): number {
  bitsView.setFloat32(0, x, true)
  return bitsView.getUint32(0, true)
}

const hex = (u: number): string => `0x${(u >>> 0).toString(16).padStart(8, '0')}u`

/** An f32 written in decimal: only whole numbers of magnitude below 2^24 other than -0, which WGSL reads exactly. */
function decimalF32(x: number): string | null {
  return Number.isInteger(x) && Math.abs(x) < 0x1000000 && !Object.is(x, -0) ? `${x}.0` : null
}

// ---------------------------------------------------------------------------------------------------
// Helpers: the emulations, generated per width with one body

/** What a value is known not to be: anything (0), never NaN (1), never NaN and never infinite (2). */
const UNKNOWN = 0
const SURE = 1
const FINITE = 2
type Known = typeof UNKNOWN | typeof SURE | typeof FINITE

/** The helper families, in the fixed order their functions are emitted (each at widths 1 to 4, in that order). */
const FAMILIES = [
  'nan', 'truth', 'min', 'max', 'saturate', 'step', 'sign', 'floor', 'ceil', 'trunc', 'round', 'fract', 'f2i', 'f2u', 'u2f', 'i2f',
  'sqrt', 'rsqrt', 'exp', 'exp2', 'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'pow',
  'length', 'normalize',
] as const
type Family = (typeof FAMILIES)[number]

/** Families that call another family's helper of the same width. */
const DEPENDS: { readonly [F in Family]?: readonly Family[] } = {
  min: ['nan'], max: ['nan'], saturate: ['nan'], step: ['nan'], sign: ['nan'], f2i: ['nan'], f2u: ['nan'], i2f: ['u2f'],
  exp: ['nan'], exp2: ['nan'], atan: ['nan'], atan2: ['nan'],
}

/** Families whose body makes a fresh NaN or infinity from the hidden block's zero word. */
const HIDDEN_FAMILIES: ReadonlySet<Family> = new Set<Family>(['sqrt', 'rsqrt', 'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan2', 'pow', 'length', 'normalize'])

/**
 * A helper's name: the family's for a scalar, with `x<n>` for a vector of n as Lens names its vectors (a bare width
 * would make `exp` of two lanes `ng_exp2`, the name of `exp2` of one).
 */
const helperName = (f: Family, n: number): string => `ng_${f}${n === 1 ? '' : `x${n}`}`

/** Types and splats at one width. */
class Width {
  readonly n: number
  readonly T: string
  readonly U: string
  readonly I: string
  readonly B: string

  constructor(n: number) {
    this.n = n
    this.T = vtype('f32', n)
    this.U = vtype('u32', n)
    this.I = vtype('i32', n)
    this.B = vtype('bool', n)
  }

  /** A literal token at this width: itself for a scalar, a splat for a vector. */
  s(text: string, scalar: Scalar): Expr {
    return this.n === 1 ? lit(text) : call(`vec${this.n}<${scalar}>`, lit(text))
  }

  f(text: string): Expr { return this.s(text, 'f32') }
  u(text: string): Expr { return this.s(text, 'u32') }

  /** A scalar expression spread over this width. */
  spread(e: Expr): Expr {
    return this.n === 1 ? e : call(this.T, e)
  }

  nan(e: Expr): Expr { return call(helperName('nan', this.n), e) }
  bits(e: Expr): Expr { return call(`bitcast<${this.U}>`, e) }
  float(e: Expr): Expr { return call(`bitcast<${this.T}>`, e) }
  any(e: Expr): Expr { return this.n === 1 ? e : call('any', e) }
  all(e: Expr): Expr { return this.n === 1 ? e : call('all', e) }
}

/** A fresh f32 pattern made at run time from the hidden block's zero word: `bitcast<f32>(ng_h.zero | k)`. */
const fresh = (k: number): Expr => call('bitcast<f32>', bin('|', member(id('ng_h'), 'zero'), lit(hex(k))))
const QNAN = 0x7fc00000
const PINF = 0x7f800000

const x = id('x')
const u = id('u')

/** The parameters and body of one helper at one width. */
function helperFn(f: Family, w: Width): Decl {
  const { T, U, I, B } = w
  const p1 = (type: string, name = 'x'): Param[] => [{ attrs: '', name, type }]
  const p2 = (type: string, a = 'a', b = 'b'): Param[] => [{ attrs: '', name: a, type }, { attrs: '', name: b, type }]
  const fn = (params: Param[], r: string, body: Stmt[]): Decl => ({ k: 'fn', attrs: '', name: helperName(f, w.n), params, ret: r, body })
  const a = id('a')
  const b = id('b')
  const q = (): Stmt => letS('q', T, w.spread(fresh(QNAN)))
  const uLet = (): Stmt => letS('u', U, w.bits(x))
  const mag = (e: Expr): Expr => bin('&', e, w.u('0x7fffffffu'))
  /** Negative and not -0: x < 0 (and -inf), or a NaN of either sign. */
  const below = (): Expr => bin('&', bin('>', u, w.u('0x7f800000u')), bin('!=', u, w.u('0x80000000u')))
  switch (f) {
    case 'nan': return fn(p1(T), B, [ret(bin('>', mag(w.bits(x)), w.u('0x7f800000u')))])
    case 'truth': return fn(p1(T), B, [ret(bin('!=', mag(w.bits(x)), w.u('0u')))])
    case 'min': case 'max':
      return fn(p2(T), T, [ret(sel(a, b, bin('|', w.nan(a), bin('&', un('!', w.nan(b)), bin(f === 'min' ? '<' : '>', b, a)))))])
    case 'saturate':
      return fn(p1(T), T, [
        letS('m', T, sel(w.f('0.0'), x, bin('&', bin('>=', x, w.f('0.0')), un('!', w.nan(x))))),
        ret(sel(w.f('1.0'), id('m'), bin('<=', id('m'), w.f('1.0')))),
      ])
    case 'step': {
      const e = id('e')
      return fn(p2(T, 'e', 'x'), T, [ret(sel(w.f('0.0'), w.f('1.0'), bin('&', bin('&', bin('<=', e, x), un('!', w.nan(e))), un('!', w.nan(x)))))])
    }
    case 'sign':
      return fn(p1(T), T, [ret(sel(sel(sel(w.f('0.0'), w.f('-1.0'), bin('<', x, w.f('0.0'))), w.f('1.0'), bin('>', x, w.f('0.0'))), w.f('0.0'), w.nan(x)))])
    case 'floor': case 'ceil': case 'trunc': case 'round':
      // The native function gives the whole number; its zero may carry either sign, and a NaN or an infinity is an
      // indeterminate value under WGSL's finite math. Each of the four keeps x's sign, so the result is the native
      // magnitude with x's sign bit, and x itself from 2^23 up (already whole), infinities and NaN included.
      return fn(p1(T), T, [
        uLet(),
        letS('r', U, w.bits(call(f, x))),
        ret(sel(x, w.float(bin('|', mag(id('r')), bin('&', u, w.u('0x80000000u')))), bin('<', mag(u), w.u('0x4b000000u')))),
      ])
    case 'fract': {
      // x - floor(x), rounded once to nearest even, without leaning on WGSL's rounding (it names no direction) or on
      // the sign of a zero. For x >= 0 and for x <= -0.5 the difference is exact, and a whole number gives +0. For
      // -0.5 < x < 0 it is 1 - |x|, worked out in integers: with s the shift that makes |x| * 2^24 the significand
      // `a` shifted right by s, n = |x| * 2^24 rounded half to even, and the result's bits are 0x3f800000 - n.
      const m = id('m')
      const e = id('e')
      const s = id('s')
      const qq = id('q')
      const rest = id('rest')
      const half = id('half')
      return fn(p1(T), T, [
        uLet(),
        letS('m', U, mag(u)),
        letS('d', T, bin('-', x, call('floor', x))),
        letS('r0', T, sel(id('d'), w.f('0.0'), bin('|', bin('==', mag(w.bits(id('d'))), w.u('0u')), bin('>=', m, w.u('0x4b000000u'))))),
        letS('e', U, bin('>>', m, w.u('23u'))),
        letS('a', U, sel(bin('&', m, w.u('0x7fffffu')), bin('|', bin('&', m, w.u('0x7fffffu')), w.u('0x800000u')), bin('!=', e, w.u('0u')))),
        letS('s', U, call('min', sel(w.u('125u'), bin('-', w.u('126u'), e), bin('!=', e, w.u('0u'))), w.u('31u'))),
        letS('q', U, bin('>>', id('a'), s)),
        letS('rest', U, bin('&', id('a'), bin('-', bin('<<', w.u('1u'), s), w.u('1u')))),
        letS('half', U, bin('<<', w.u('1u'), bin('-', s, w.u('1u')))),
        letS('n', U, bin('+', qq, sel(w.u('0u'), w.u('1u'), bin('|', bin('>', rest, half), bin('&', bin('==', rest, half), bin('==', bin('&', qq, w.u('1u')), w.u('1u'))))))),
        letS('r1', T, w.float(bin('-', w.u('0x3f800000u'), id('n')))),
        // -0.5 < x < 0: the sign set, not -0, and below 0.5. NaN and the infinities give a NaN made from x's own bits.
        letS('neg', B, bin('&', bin('>', u, w.u('0x80000000u')), bin('<', m, w.u('0x3f000000u')))),
        ret(sel(sel(id('r0'), id('r1'), id('neg')), w.float(bin('|', u, w.u('0x7fc00000u'))), bin('>=', m, w.u('0x7f800000u')))),
      ])
    }
    case 'f2i': {
      // 2147483520 is the largest f32 below 2^31: a finite x clamps into range and converts exactly. From 2^31 up in
      // size (bits 0x4f000000), infinities included, the result is the end of the range on x's side, chosen by its
      // bits, since WGSL leaves the conversion of an infinity (and the clamp of one) indeterminate. NaN gives 0.
      const big = bin('>=', mag(u), w.u('0x4f000000u'))
      return fn(p1(T), I, [
        uLet(),
        letS('t', I, call(I, call('clamp', x, w.f('-2147483648.0'), w.f('2147483520.0')))),
        letS('r', I, sel(id('t'), sel(w.s('2147483647i', 'i32'), w.s('bitcast<i32>(0x80000000u)', 'i32'), bin('>=', u, w.u('0x80000000u'))), big)),
        ret(sel(id('r'), w.s('0i', 'i32'), w.nan(x))),
      ])
    }
    case 'f2u':
      // 4294967040 is the largest f32 below 2^32. A negative x (-0 and -inf included) gives 0, as does NaN; from
      // 2^32 up (bits 0x4f800000, +inf included) the largest u32. Each case is chosen by x's bits.
      return fn(p1(T), U, [
        uLet(),
        letS('t', U, call(U, call('clamp', x, w.f('0.0'), w.f('4294967040.0')))),
        ret(sel(sel(id('t'), w.u('4294967295u'), bin('>=', u, w.u('0x4f800000u'))), w.u('0u'), bin('|', bin('>=', u, w.u('0x80000000u')), w.nan(x)))),
      ])
    case 'u2f': {
      // The nearest-even f32 built in integers, since WGSL names no rounding mode for a conversion or an add. n is
      // the leading bit; the significand q has it at bit 23, the bits shifted out decide the rounding (half to even),
      // and the leading bit carries into the exponent field, as does a significand rounded up to 2^24.
      const v = id('i')
      const n = id('n')
      const sr = id('sr')
      const qq = id('q')
      const rest = id('rest')
      const half = id('half')
      return fn(p1(U, 'i'), T, [
        letS('n', U, bin('-', w.u('31u'), call('countLeadingZeros', v))),
        letS('sr', U, sel(w.u('0u'), bin('-', n, w.u('23u')), bin('>', n, w.u('23u')))),
        letS('sl', U, sel(w.u('0u'), bin('-', w.u('23u'), n), bin('<', n, w.u('23u')))),
        letS('q', U, bin('<<', bin('>>', v, sr), id('sl'))),
        letS('rest', U, bin('&', v, bin('-', bin('<<', w.u('1u'), sr), w.u('1u')))),
        letS('half', U, bin('>>', bin('<<', w.u('1u'), sr), w.u('1u'))),
        letS('up', B, bin('|', bin('>', rest, half), bin('&', bin('&', bin('==', rest, half), bin('!=', sr, w.u('0u'))), bin('==', bin('&', qq, w.u('1u')), w.u('1u'))))),
        letS('b', U, bin('+', bin('+', bin('<<', bin('+', n, w.u('126u')), w.u('23u')), qq), sel(w.u('0u'), w.u('1u'), id('up')))),
        ret(sel(w.float(id('b')), w.f('0.0'), bin('==', v, w.u('0u')))),
      ])
    }
    case 'i2f': {
      // The magnitude (2^31 for the most negative i32) converted by ng_u2f, then the sign bit set.
      const v = id('i')
      return fn(p1(I, 'i'), T, [
        letS('u', U, w.bits(v)),
        letS('s', U, bin('&', u, w.u('0x80000000u'))),
        letS('m', U, sel(u, bin('-', w.u('0u'), u), bin('!=', id('s'), w.u('0u')))),
        ret(w.float(bin('|', w.bits(call(helperName('u2f', w.n), id('m'))), id('s')))),
      ])
    }
    case 'sqrt':
      return fn(p1(T), T, [
        uLet(), q(),
        letS('keep', B, bin('|', bin('==', mag(u), w.u('0u')), bin('==', u, w.u('0x7f800000u')))),
        ret(sel(sel(call('sqrt', x), x, id('keep')), id('q'), below())),
      ])
    case 'rsqrt':
      return fn(p1(T), T, [
        uLet(), q(),
        letS('z', B, bin('==', mag(u), w.u('0u'))),
        // +-0 give +-inf (the sign kept), +inf gives +0.
        ret(sel(sel(sel(call('inverseSqrt', x), w.f('0.0'), bin('==', u, w.u('0x7f800000u'))), w.float(bin('|', u, w.u('0x7f800000u'))), id('z')), id('q'), below())),
      ])
    case 'exp': case 'exp2':
      return fn(p1(T), T, [
        uLet(),
        ret(sel(sel(call(f, x), x, bin('|', w.nan(x), bin('==', u, w.u('0x7f800000u')))), w.f('0.0'), bin('==', u, w.u('0xff800000u')))),
      ])
    case 'log': case 'log2':
      return fn(p1(T), T, [
        uLet(), q(),
        letS('z', B, bin('==', mag(u), w.u('0u'))),
        // +-0 give -inf, +inf gives itself.
        ret(sel(sel(sel(call(f, x), x, bin('==', u, w.u('0x7f800000u'))), w.float(bin('|', u, w.u('0xff800000u'))), id('z')), id('q'), below())),
      ])
    case 'sin': case 'cos': case 'tan':
      return fn(p1(T), T, [q(), ret(sel(call(f, x), id('q'), bin('>=', mag(w.bits(x)), w.u('0x7f800000u'))))])
    case 'asin': case 'acos':
      return fn(p1(T), T, [q(), ret(sel(call(f, x), id('q'), bin('>', mag(w.bits(x)), w.u('0x3f800000u'))))])
    case 'atan':
      // +-inf give +-f32(pi / 2), 0x3fc90fdb.
      return fn(p1(T), T, [
        uLet(),
        ret(sel(sel(call('atan', x), w.float(bin('|', bin('&', u, w.u('0x80000000u')), w.u('0x3fc90fdbu'))), bin('==', mag(u), w.u('0x7f800000u'))), x, w.nan(x))),
      ])
    case 'atan2': {
      const y = id('y')
      const uy = id('uy')
      return fn(p2(T, 'y', 'x'), T, [
        letS('uy', U, w.bits(y)),
        letS('ux', U, w.bits(x)),
        q(),
        letS('sy', U, bin('&', uy, w.u('0x80000000u'))),
        // f32(pi) is 0x40490fdb and f32(pi / 2) 0x3fc90fdb, each with the sign of y.
        letS('pi', T, w.float(bin('|', id('sy'), w.u('0x40490fdbu')))),
        letS('hp', T, w.float(bin('|', id('sy'), w.u('0x3fc90fdbu')))),
        letS('r0', T, sel(call('atan2', y, x), id('hp'), bin('==', mag(id('ux')), w.u('0u')))),
        letS('r1', T, sel(id('r0'), sel(y, id('pi'), bin('>=', id('ux'), w.u('0x80000000u'))), bin('==', mag(uy), w.u('0u')))),
        ret(sel(id('r1'), id('q'), bin('|', w.nan(y), w.nan(x)))),
      ])
    }
    case 'pow': {
      const ma = id('ma')
      const mb = id('mb')
      const an = id('an')
      const bn = id('bn')
      const odd = id('odd')
      return fn(p2(T), T, [
        letS('ua', U, w.bits(a)),
        letS('ub', U, w.bits(b)),
        letS('ma', U, mag(id('ua'))),
        letS('mb', U, mag(id('ub'))),
        letS('an', B, bin('>=', id('ua'), w.u('0x80000000u'))),
        letS('bn', B, bin('>=', id('ub'), w.u('0x80000000u'))),
        q(),
        letS('whole', B, bin('==', call('trunc', b), b)),
        // An odd whole exponent: below 2^24 (0x4b800000), whole, and its lowest bit set.
        letS('odd', B, bin('&', bin('&', bin('<', mb, w.u('0x4b800000u')), id('whole')), bin('==', bin('&', call(U, call('abs', b)), w.u('1u')), w.u('1u')))),
        letS('p', T, call('pow', call('abs', a), b)),
        letS('r0', T, sel(id('p'), un('-', id('p')), bin('&', an, odd))),
        letS('r1', T, sel(id('r0'), id('q'), bin('&', an, un('!', id('whole'))))),
        // An infinite exponent: +inf or +0 by whether abs(a) > 1 agrees with the exponent's sign; abs(a) = 1 gives NaN.
        letS('big', U, sel(w.u('0u'), w.u('0x7f800000u'), bin('!=', bin('>', ma, w.u('0x3f800000u')), bn))),
        letS('r2', T, sel(id('r1'), sel(w.float(id('big')), id('q'), bin('==', ma, w.u('0x3f800000u'))), bin('==', mb, w.u('0x7f800000u')))),
        // A base of +-0 or +-inf: inf or 0 by whether its being infinite agrees with the exponent's sign, negative
        // when the base is negative and the exponent an odd whole number.
        letS('edge', U, bin('|', sel(w.u('0u'), w.u('0x80000000u'), bin('&', an, odd)), sel(w.u('0u'), w.u('0x7f800000u'), bin('!=', bin('==', ma, w.u('0x7f800000u')), bn)))),
        letS('r3', T, sel(id('r2'), w.float(id('edge')), bin('|', bin('==', ma, w.u('0x7f800000u')), bin('==', ma, w.u('0u'))))),
        letS('r4', T, sel(id('r3'), id('q'), bin('>', ma, w.u('0x7f800000u')))),
        letS('r5', T, sel(id('r4'), w.f('1.0'), bin('==', mb, w.u('0u')))),
        ret(sel(id('r5'), id('q'), bin('>', mb, w.u('0x7f800000u')))),
      ])
    }
    case 'length': {
      const v = id('v')
      return fn(p1(T, 'v'), 'f32', [
        letS('m', U, mag(w.bits(v))),
        letS('q', 'f32', fresh(QNAN)),
        letS('inf', 'f32', fresh(PINF)),
        // A zero vector has length +0 exactly (the native root of a zero is left loose by WGSL's accuracy rules).
        letS('r0', 'f32', sel(call('length', v), lit('0.0'), w.all(bin('==', id('m'), w.u('0u'))))),
        ret(sel(sel(id('r0'), id('inf'), w.any(bin('==', id('m'), w.u('0x7f800000u')))), id('q'), w.any(bin('>', id('m'), w.u('0x7f800000u'))))),
      ])
    }
    case 'normalize': {
      const v = id('v')
      return fn(p1(T, 'v'), T, [
        letS('u', U, w.bits(v)),
        letS('m', U, mag(u)),
        q(),
        letS('inf', B, bin('==', id('m'), w.u('0x7f800000u'))),
        // An infinite component makes the length infinite: it reads NaN, and every finite one a zero of its sign.
        letS('r0', T, sel(call('normalize', v), sel(w.float(bin('&', u, w.u('0x80000000u'))), id('q'), id('inf')), w.any(id('inf')))),
        ret(sel(id('r0'), id('q'), bin('|', w.any(bin('>', id('m'), w.u('0x7f800000u'))), w.all(bin('==', id('m'), w.u('0u')))))),
      ])
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Checking the options and the scope

/** Refuses options that do not match the module: an internal error of the caller, so code `lens`. */
function optionsRule(m: LensModule, options: unknown): asserts options is WgslOptions {
  const no = (rule: string): never => fail('lens', `wgsl: options: ${rule}`)
  if (typeof options !== 'object' || options === null) no('the options are an object')
  const o = options as { readonly [key: string]: unknown }
  const { storage, outputs, vertexRate, live, arithmetic } = o
  if (!Array.isArray(storage)) no('storage is a list, one entry per resource')
  if (!Array.isArray(outputs)) no('outputs is a list, one entry per colour slot')
  if (typeof vertexRate !== 'number' || !Number.isInteger(vertexRate) || vertexRate < 0 || vertexRate > 0xffff) no('vertexRate is a bit mask of the 16 input slots')
  if (live !== null && (typeof live !== 'number' || !Number.isInteger(live) || live < 0 || live > 15)) no('live is a location from 0 to 15, or null')
  if (arithmetic !== 'native' && arithmetic !== 'stepwise') no('arithmetic is native or stepwise')
  const list = storage as readonly unknown[]
  if (list.length > m.resources.length) no(`storage has ${list.length} entries, and the module ${m.resources.length} resources`)
  m.resources.forEach((r, i) => {
    const s = list[i] ?? null
    if (r.kind === 'storage') {
      if (s !== 'read' && s !== 'read_write') no(`resource ${i} is a storage block; its access is read or read_write, not ${String(s)}`)
      if (r.writable && s !== 'read_write') no(`resource ${i} is written, so its access is read_write`)
    } else if (s !== null) {
      no(`resource ${i} is a ${r.kind}, which takes no storage access`)
    }
  })
  for (const k of outputs as readonly unknown[]) if (k !== null && k !== 'f32' && k !== 'i32' && k !== 'u32') no('an output kind is f32, i32, u32 or null')
  if (m.stage === 'compute') {
    if ((outputs as readonly unknown[]).some((k) => k !== null)) no('a compute module has no colour outputs')
    if (vertexRate !== 0) no('a compute module has no vertex inputs')
    if (live !== null) no('a compute module carries no live value')
  }
}

/** Refuses what this slice does not lower yet, by name, rather than lowering it wrong. */
const notYet = (what: string): never => fail('device', `wgsl: ${what} not yet lowered`)

/** A storage block whose last field is an array without a length (raw words, lowered later). */
function endsInRuntimeArray(b: Block): boolean {
  const last = b.fields[b.fields.length - 1].type
  return typeof last !== 'string' && 'array' in last && last.len === 0
}

// ---------------------------------------------------------------------------------------------------
// The lowering

/** The WGSL builtin and the private variable behind each compute builtin. */
const COMPUTE_BUILTINS: { readonly [B in Builtin]?: { readonly wgsl: string; readonly name: string } } = {
  'global-id': { wgsl: 'global_invocation_id', name: 'ng_global' },
  'local-id': { wgsl: 'local_invocation_id', name: 'ng_local' },
  'group-id': { wgsl: 'workgroup_id', name: 'ng_group' },
  'local-index': { wgsl: 'local_invocation_index', name: 'ng_index' },
  'group-count': { wgsl: 'num_workgroups', name: 'ng_count' },
}

type InstOf<K extends Inst['op']> = Extract<Inst, { readonly op: K }>

/** The loop cap: iterations of one entry into a loop, as interp.ts's LOOP_ITERATIONS. */
const LOOP_CAP = 65_536

const SWIZZLE = 'xyzw'

class Lowerer {
  private readonly m: LensModule
  private readonly types: (ValueType | undefined)[]
  /** What each f32 value is known not to be (see Known). */
  private readonly known: Known[]
  /** The components of each literal, for the shortcuts that need a value. */
  private readonly literals = new Map<number, readonly number[]>()
  /** Struct names by block object, one map per space, and the structs in order of first reach. */
  private readonly structs: { readonly [S in Space]: Map<Block, string> } = { uniform: new Map(), storage: new Map() }
  private readonly order: { readonly name: string; readonly block: Block; readonly space: Space }[] = []
  private readonly helpers = new Set<string>()
  private readonly builtins = new Set<Builtin>()
  private readonly depths = new Set<number>()
  private hidden = false
  private temps = 0

  constructor(m: LensModule) {
    this.m = m
    this.types = new Array<ValueType | undefined>(m.ids).fill(undefined)
    this.known = new Array<Known>(m.ids).fill(UNKNOWN)
    this.typeAll(m.body)
  }

  private typeAll(insts: readonly Inst[]): void {
    for (const i of insts) {
      if ('id' in i) this.types[i.id] = i.t
      if (i.op === 'if') {
        this.typeAll(i.then)
        this.typeAll(i.else)
      } else if (i.op === 'loop') this.typeAll(i.body)
    }
  }

  private typeOf(v: number): ValueType {
    return this.types[v] as ValueType
  }

  private v(n: number): Expr {
    return id(`v${n}`)
  }

  private temp(prefix = 't'): string {
    return `ng_${prefix}${this.temps++}`
  }

  /** Marks a helper (and what it calls) as used and returns its name. */
  private helper(f: Family, n: number): string {
    for (const d of DEPENDS[f] ?? []) this.helper(d, n)
    if (HIDDEN_FAMILIES.has(f)) this.hidden = true
    const name = helperName(f, n)
    this.helpers.add(name)
    return name
  }

  // -------------------------------------------------------------------------------------------------
  // Blocks

  /** The struct for a block in a space, named on first reach; nested blocks are named as they are reached. */
  private struct(b: Block, space: Space): string {
    const known = this.structs[space].get(b)
    if (known !== undefined) return known
    const name = `B${this.order.length}`
    this.structs[space].set(b, name)
    this.order.push({ name, block: b, space })
    for (const f of b.fields) this.dataType(f.type, space)
    return name
  }

  /** The WGSL type of a field: a value type, an array of known length, or a nested block's struct. */
  private dataType(t: DataType, space: Space): string {
    if (typeof t === 'string') return wtype(t)
    if ('struct' in t) return this.struct(t.struct, space)
    return `array<${this.dataType(t.array, space)}, ${t.len}>`
  }

  /** A struct's members with their explicit alignment and size, so WGSL's layout is layoutBlock's to the byte. */
  private members(b: Block, space: Space): Member[] {
    const layout = layoutBlock(b, space)
    return b.fields.map((f, i) => {
      const t = f.type
      const natural = typeof t === 'string' ? placeAlign(t) : 'struct' in t ? layoutBlock(t.struct, space).align : elementAlign(t.array, space)
      const align = space === 'uniform' && typeof t !== 'string' ? Math.ceil(natural / 16) * 16 : natural
      const end = i + 1 < b.fields.length ? layout.offsets[i + 1] : layout.size
      return { attrs: `@align(${align}) @size(${end - layout.offsets[i]})`, name: `f${i}`, type: this.dataType(t, space) }
    })
  }

  // -------------------------------------------------------------------------------------------------
  // Statements

  /** Lowers a list of instructions at a depth; reports whether control can reach the end of the list. */
  private list(insts: readonly Inst[], depth: number, out: Stmt[]): boolean {
    for (const inst of insts) {
      // A statement that cannot reach the next one ends the list: what follows could never run, and is not emitted.
      if (!this.inst(inst, depth, out)) return false
    }
    return true
  }

  private inst(i: Inst, depth: number, out: Stmt[]): boolean {
    switch (i.op) {
      case 'lit': this.lit(i, out); return true
      case 'unary': this.unary(i, out); return true
      case 'binary': this.binary(i, out); return true
      case 'ternary': this.ternary(i, out); return true
      case 'make': {
        const parts = i.args.map((a) => this.v(a))
        this.def(i.id, call(wtype(i.t), ...parts), out, Math.min(...i.args.map((a) => this.known[a])) as Known)
        return true
      }
      case 'pick': {
        const lanes = i.lanes.map((l) => SWIZZLE[l]).join('')
        this.def(i.id, member(this.v(i.a), lanes), out, this.known[i.a])
        return true
      }
      case 'lane': {
        const n = widthOf(this.typeOf(i.a))
        this.def(i.id, index(this.v(i.a), this.clamped(i.i, n, out)), out, this.known[i.a])
        return true
      }
      case 'column': this.def(i.id, index(this.v(i.a), lit(`${i.i}u`)), out, this.known[i.a]); return true
      case 'cast': this.cast(i, out); return true
      case 'bits': this.def(i.id, call(`bitcast<${wtype(i.t)}>`, this.v(i.a)), out); return true
      case 'builtin': {
        const b = COMPUTE_BUILTINS[i.name]
        if (b === undefined) return notYet(`the ${i.name} builtin is`)
        this.builtins.add(i.name)
        this.def(i.id, id(b.name), out)
        return true
      }
      case 'read': {
        const r = this.m.resources[i.res]
        if (r.kind !== 'uniform' && r.kind !== 'storage' && r.kind !== 'constants') return fail('lens', `wgsl: read of resource ${i.res}, a ${r.kind}`)
        const base = r.kind === 'constants' ? member(id('ng_h'), 'c') : id(`r${i.res}`)
        if (r.kind === 'constants') this.hidden = true
        this.def(i.id, this.path(base, r.block, i.path, out), out)
        return true
      }
      case 'write': {
        const r = this.m.resources[i.res]
        if (r.kind !== 'storage') return fail('lens', `wgsl: write to resource ${i.res}, a ${r.kind}`)
        out.push({ k: 'assign', lhs: this.path(id(`r${i.res}`), r.block, i.path, out), e: this.v(i.a) })
        return true
      }
      case 'var':
        out.push({ k: 'var', name: `x${i.id}`, type: wtype(i.t), e: i.init === undefined ? call(wtype(i.t)) : this.v(i.init) })
        return true
      case 'get': this.def(i.id, id(`x${i.v}`), out); return true
      case 'set': out.push({ k: 'assign', lhs: id(`x${i.v}`), e: this.v(i.a) }); return true
      case 'if': {
        const then: Stmt[] = []
        const otherwise: Stmt[] = []
        const a = this.list(i.then, depth + 1, then)
        const b = this.list(i.else, depth + 1, otherwise)
        out.push({ k: 'if', c: this.v(i.c), then, else: otherwise })
        return a || b
      }
      case 'loop': {
        // One counter per nesting depth, reset on entry: at most 65,536 iterations of one entry, then every lane leaves
        // as if by break. `continue` reaches the count at the top of the next iteration.
        const c = id(`ng_c${depth}`)
        this.depths.add(depth)
        const body: Stmt[] = [
          { k: 'if', c: bin('>=', c, lit(`${LOOP_CAP}u`)), then: [{ k: 'break' }], else: [] },
          { k: 'assign', lhs: c, e: bin('+', c, lit('1u')) },
        ]
        this.list(i.body, depth + 1, body)
        out.push({ k: 'assign', lhs: c, e: lit('0u') }, { k: 'loop', body })
        // The cap's break always lets control past the loop.
        return true
      }
      case 'break': out.push({ k: 'break' }); return false
      case 'continue': out.push({ k: 'continue' }); return false
      case 'return': out.push({ k: 'return', e: null }); return false
      case 'sample': case 'texel': case 'put': case 'extent': return notYet(`images (${i.op}) are`)
      case 'deriv': return notYet('derivatives are')
      case 'discard': return notYet('discard is')
      case 'in': case 'out': case 'position': return notYet(`stage ports (${i.op}) are`)
    }
  }

  /** Defines a value: `let v<id>: T = e;`, and records what the value is known not to be. */
  private def(n: number, e: Expr, out: Stmt[], known: Known = UNKNOWN): void {
    out.push(letS(`v${n}`, wtype(this.typeOf(n)), e))
    this.known[n] = known
  }

  /** A let of a lowering temporary, returned as a name. */
  private let(type: string, e: Expr, out: Stmt[], prefix = 't'): Expr {
    const name = this.temp(prefix)
    out.push(letS(name, type, e))
    return id(name)
  }

  /** A value-held index clamped into `n` elements, as interp.ts clamps it: a u32 let. */
  private clamped(at: number, n: number, out: Stmt[]): Expr {
    const i = this.v(at)
    const last = lit(`${n - 1}u`)
    const e = this.typeOf(at) === 'u32' ? call('min', i, last) : sel(call('min', call('bitcast<u32>', i), last), lit('0u'), bin('<', i, lit('0i')))
    return this.let('u32', e, out, 'j')
  }

  /** The access expression of a path into a block: `.f<k>` for a field, `[k]` or a clamped index for an element. */
  private path(base: Expr, b: Block, path: readonly Step[], out: Stmt[]): Expr {
    let t: DataType = { struct: b }
    let e = base
    for (const step of path) {
      if (typeof t === 'string') break
      if ('struct' in t) {
        const k = step as number
        e = member(e, `f${k}`)
        t = t.struct.fields[k].type
      } else {
        e = index(e, typeof step === 'number' ? lit(`${step}u`) : this.clamped(step.at, t.len, out))
        t = t.array
      }
    }
    return e
  }

  // -------------------------------------------------------------------------------------------------
  // Values

  private lit(i: InstOf<'lit'>, out: Stmt[]): void {
    const k = scalarOf(i.t)
    this.literals.set(i.id, i.v)
    const one = (x: number, kname: string): Expr => {
      if (k === 'bool') return lit(x !== 0 ? 'true' : 'false')
      if (k === 'u32') return lit(`${x}u`)
      if (k === 'i32') {
        if (x !== -0x80000000) return lit(`${x}i`)
        out.push(letS(kname, 'u32', lit(hex(0x80000000))))
        return call('bitcast<i32>', id(kname))
      }
      const d = decimalF32(x)
      if (d !== null) return lit(d)
      out.push(letS(kname, 'u32', lit(hex(f32Bits(x)))))
      return call('bitcast<f32>', id(kname))
    }
    if (isScalar(i.t)) {
      this.def(i.id, one(i.v[0], `k${i.id}`), out, FINITE)
      return
    }
    const parts = i.v.map((x, c) => {
      out.push(letS(`v${i.id}_${c}`, k, one(x, `k${i.id}_${c}`)))
      return id(`v${i.id}_${c}`)
    })
    this.def(i.id, call(wtype(i.t), ...parts), out, FINITE)
  }

  private unary(i: InstOf<'unary'>, out: Stmt[]): void {
    const t = this.typeOf(i.a)
    const a = this.v(i.a)
    const n = widthOf(t)
    const k = scalarOf(t)
    const ka = this.known[i.a]
    const wrap = (f: Family, shortcut = false): void => this.def(i.id, call(shortcut ? f : this.helper(f, n), a), out)
    switch (i.fn) {
      // An f32 negation or size is its sign bit flipped or cleared: WGSL may give a zero either sign, and leaves an
      // operation on a NaN or an infinity indeterminate under its finite math.
      case 'neg': this.def(i.id, k === 'f32' ? signBit(a, '^', n) : un('-', a), out, ka); return
      case 'not': this.def(i.id, un('!', a), out); return
      case 'bitnot': this.def(i.id, un('~', a), out); return
      case 'abs': this.def(i.id, k === 'f32' ? signBit(a, '&', n) : call('abs', a), out, ka); return
      case 'sign': this.def(i.id, k === 'f32' ? call(this.helper('sign', n), a) : call('sign', a), out, FINITE); return
      case 'floor': case 'ceil': case 'trunc': case 'round': this.def(i.id, call(this.helper(i.fn, n), a), out, ka); return
      case 'fract': this.def(i.id, call(this.helper('fract', n), a), out, ka === FINITE ? FINITE : UNKNOWN); return
      case 'saturate': this.def(i.id, call(this.helper('saturate', n), a), out, FINITE); return
      case 'sqrt': case 'rsqrt': case 'log': case 'log2': case 'asin': case 'acos': wrap(i.fn); return
      // Only NaN and the infinities are emulated for these: a finite operand needs none.
      case 'exp': case 'exp2': case 'sin': case 'cos': case 'tan': case 'atan': wrap(i.fn, ka === FINITE); return
      case 'length':
        // The length of a scalar is its size exactly, as the reference's root of its square.
        this.def(i.id, n === 1 ? signBit(a, '&', 1) : call(this.helper('length', n), a), out)
        return
      case 'normalize': this.def(i.id, call(this.helper('normalize', n), a), out); return
      case 'any': case 'all': this.def(i.id, n === 1 ? a : call(i.fn, a), out); return
      case 'transpose': this.def(i.id, call('transpose', a), out, ka); return
    }
  }

  /** min or max of two f32 values: the bit-tested helper, or a cheaper form when an operand is known not to be NaN. */
  private minMax(fn: 'min' | 'max', A: Expr, ka: Known, B: Expr, kb: Known, n: number): Expr {
    const cmp = bin(fn === 'min' ? '<' : '>', B, A)
    if (ka < SURE && kb < SURE) return call(this.helper(fn, n), A, B)
    if (ka >= SURE && kb >= SURE) return sel(A, B, cmp)
    const nan = this.helper('nan', n)
    return kb >= SURE ? sel(A, B, bin('|', call(nan, A), cmp)) : sel(A, B, bin('&', un('!', call(nan, B)), cmp))
  }

  private binary(i: InstOf<'binary'>, out: Stmt[]): void {
    const ta = this.typeOf(i.a)
    const tb = this.typeOf(i.b)
    const A = this.v(i.a)
    const B = this.v(i.b)
    const k = scalarOf(ta)
    const n = widthOf(i.t)
    const op = (o: string): void => this.def(i.id, bin(o, A, B), out)
    switch (i.fn) {
      case 'add': op('+'); return
      case 'sub': op('-'); return
      case 'mul': op('*'); return
      case 'div': op('/'); return
      case 'rem': {
        if (k !== 'f32') { op('%'); return }
        // a - b * trunc(a / b), each step rounded, as the reference.
        const type = wtype(i.t)
        const q = this.let(type, bin('/', A, B), out)
        const t = this.let(type, call('trunc', q), out)
        const p = this.let(type, bin('*', B, t), out)
        this.def(i.id, bin('-', A, p), out)
        return
      }
      case 'min': case 'max': {
        if (k !== 'f32') { this.def(i.id, call(i.fn, A, B), out); return }
        this.def(i.id, this.minMax(i.fn, A, this.known[i.a], B, this.known[i.b], n), out, combine(this.known[i.a], this.known[i.b]))
        return
      }
      case 'pow': {
        const la = this.literals.get(i.a)
        const lb = this.literals.get(i.b)
        // A positive literal base and a literal exponent with no zero leave none of the domain's edges (a zero exponent
        // gives exactly 1, which the native call leaves to the accuracy rules): only the native call.
        const plain = la !== undefined && la.every((c) => c > 0) && lb !== undefined && lb.every((c) => c !== 0)
        this.def(i.id, call(plain ? 'pow' : this.helper('pow', n), A, B), out)
        return
      }
      case 'atan2': this.def(i.id, call(this.helper('atan2', n), A, B), out); return
      case 'step': this.def(i.id, call(this.helper('step', n), A, B), out, FINITE); return
      case 'and': op('&'); return
      case 'or': op('|'); return
      case 'xor': op(k === 'bool' ? '!=' : '^'); return
      case 'shl': op('<<'); return
      case 'shr': op('>>'); return
      case 'eq': op('=='); return
      case 'ne': op('!='); return
      case 'lt': op('<'); return
      case 'le': op('<='); return
      case 'gt': op('>'); return
      case 'ge': op('>='); return
      case 'land': op('&'); return
      case 'lor': op('|'); return
      case 'dot': this.def(i.id, call('dot', A, B), out); return
      case 'cross': this.def(i.id, call('cross', A, B), out); return
      case 'reflect': this.def(i.id, call('reflect', A, B), out); return
      case 'distance': {
        // The length of the rounded difference; for scalars its size exactly.
        const d = this.let(wtype(ta), bin('-', A, B), out)
        this.def(i.id, widthOf(tb) === 1 ? signBit(d, '&', 1) : call(this.helper('length', widthOf(ta)), d), out)
        return
      }
    }
  }

  private ternary(i: InstOf<'ternary'>, out: Stmt[]): void {
    const t = this.typeOf(i.b)
    const A = this.v(i.a)
    const B = this.v(i.b)
    const C = this.v(i.c)
    const type = wtype(i.t)
    const n = widthOf(i.t)
    switch (i.fn) {
      case 'fma': this.def(i.id, call('fma', A, B, C), out); return
      case 'mix': {
        // a (1 - t) + b t, each step rounded, as the reference.
        const s = this.let(wtype(this.typeOf(i.c)), bin('-', lit('1.0'), C), out)
        const p = this.let(type, bin('*', A, s), out)
        const r = this.let(type, bin('*', B, C), out)
        this.def(i.id, bin('+', p, r), out)
        return
      }
      case 'smoothstep': {
        // t t (3 - 2 t) where t = clamp((x - lo) / (hi - lo), 0, 1), each step rounded, the clamp exact.
        const d = this.let(type, bin('-', C, A), out)
        const w = this.let(type, bin('-', B, A), out)
        const q = this.let(type, bin('/', d, w), out)
        const s = this.let(type, call(this.helper('saturate', n), q), out)
        const s2 = this.let(type, bin('*', s, s), out)
        const tw = this.let(type, bin('*', lit('2.0'), s), out)
        const th = this.let(type, bin('-', lit('3.0'), tw), out)
        this.def(i.id, bin('*', s2, th), out, FINITE)
        return
      }
      case 'clamp': {
        if (scalarOf(i.t) !== 'f32') {
          // Written as min(max()), which WGSL's clamp need not be when lo > hi.
          this.def(i.id, call('min', call('max', A, B), C), out)
          return
        }
        // min(max(x, lo), hi), both exact, so lo > hi and NaN behave exactly as the reference's clampOf.
        const k1 = combine(this.known[i.a], this.known[i.b])
        const inner = this.let(type, this.minMax('max', A, this.known[i.a], B, this.known[i.b], n), out)
        this.def(i.id, this.minMax('min', inner, k1, C, this.known[i.c], n), out, combine(k1, this.known[i.c]))
        return
      }
      case 'choose': {
        const known = Math.min(this.known[i.b], this.known[i.c]) as Known
        if (!isGrid(t)) {
          this.def(i.id, sel(C, B, A), out, known)
          return
        }
        // select takes no grid: a grid is chosen column by column.
        const cols = Array.from({ length: widthOf(t) }, (_, j) => sel(index(C, lit(`${j}u`)), index(B, lit(`${j}u`)), A))
        this.def(i.id, call(type, ...cols), out, known)
        return
      }
    }
  }

  private cast(i: InstOf<'cast'>, out: Stmt[]): void {
    const from = scalarOf(this.typeOf(i.a))
    const to = scalarOf(i.t)
    const n = widthOf(i.t)
    const A = this.v(i.a)
    const w = new Width(n)
    if (to === 'bool') {
      const e = from === 'f32' ? call(this.helper('truth', n), A) : bin('!=', A, w.s(from === 'i32' ? '0i' : '0u', from))
      this.def(i.id, e, out)
      return
    }
    if (from === 'bool') {
      const zero = to === 'f32' ? '0.0' : to === 'i32' ? '0i' : '0u'
      const one = to === 'f32' ? '1.0' : to === 'i32' ? '1i' : '1u'
      this.def(i.id, sel(w.s(zero, to), w.s(one, to), A), out, FINITE)
      return
    }
    if (to === 'f32') {
      this.def(i.id, call(this.helper(from === 'i32' ? 'i2f' : 'u2f', n), A), out, FINITE)
      return
    }
    if (from === 'f32') {
      this.def(i.id, call(this.helper(to === 'i32' ? 'f2i' : 'f2u', n), A), out)
      return
    }
    // i32 and u32 keep their bits.
    this.def(i.id, call(`bitcast<${wtype(i.t)}>`, A), out)
  }

  // -------------------------------------------------------------------------------------------------
  // The module

  lower(options: WgslOptions): WgslOut {
    const m = this.m
    if (options.arithmetic === 'stepwise') notYet('stepwise arithmetic is')
    m.resources.forEach((r, i) => {
      if (r.kind === 'image' || r.kind === 'sampler' || r.kind === 'storage-image') notYet(`resources[${i}] ${r.kind}: images are`)
      if (r.kind === 'storage' && endsInRuntimeArray(r.block)) notYet(`resources[${i}] storage: a storage block that ends in an array without a length (raw words) is`)
    })
    // Structs are named in order of first reach: resources in order, each block before the blocks it holds.
    m.resources.forEach((r) => {
      if (r.kind === 'uniform' || r.kind === 'constants') this.struct(r.block, 'uniform')
      else if (r.kind === 'storage') this.struct(r.block, 'storage')
    })
    const constants = m.resources.find((r) => r.kind === 'constants')
    const body: Stmt[] = []
    this.list(m.body, 0, body)
    const counters: Stmt[] = [...this.depths].sort((a, b) => a - b).map((d) => ({ k: 'var', name: `ng_c${d}`, type: 'u32', e: null }))

    const decls: Decl[] = []
    for (const s of this.order) decls.push({ k: 'struct', name: s.name, members: this.members(s.block, s.space) })
    if (this.hidden || constants !== undefined) {
      const c = constants === undefined ? 'array<vec4<u32>, 8>' : (this.structs.uniform.get(constants.block) as string)
      decls.push({
        k: 'struct', name: 'NgHidden', members: [
          { attrs: '@size(128)', name: 'c', type: c },
          { attrs: '', name: 'lim', type: 'array<vec4<u32>, 4>' },
          { attrs: '', name: 'none', type: 'u32' },
          { attrs: '', name: 'checked', type: 'u32' },
          { attrs: '', name: 'base', type: 'i32' },
          { attrs: '', name: 'zero', type: 'u32' },
        ],
      })
      decls.push({ k: 'var', attrs: `@group(${WGSL_HIDDEN.group}) @binding(${WGSL_HIDDEN.binding})`, space: '<uniform>', name: 'ng_h', type: 'NgHidden' })
    }
    m.resources.forEach((r, i) => {
      if (r.kind !== 'uniform' && r.kind !== 'storage') return
      const space = r.kind === 'uniform' ? '<uniform>' : `<storage, ${options.storage[i]}>`
      decls.push({ k: 'var', attrs: `@group(${r.set}) @binding(${r.binding})`, space, name: `r${i}`, type: this.structs[r.kind].get(r.block) as string })
    })
    const builtins = (Object.keys(COMPUTE_BUILTINS) as Builtin[]).filter((b) => this.builtins.has(b))
    for (const b of builtins) decls.push({ k: 'var', attrs: '', space: '<private>', name: (COMPUTE_BUILTINS[b] as { name: string }).name, type: wtype(builtinType(b)) })
    for (const f of FAMILIES) {
      for (let n = 1; n <= 4; n++) if (this.helpers.has(helperName(f, n))) decls.push(helperFn(f, new Width(n)))
    }
    decls.push({ k: 'fn', attrs: '', name: 'ng_body', params: [], ret: null, body: [...counters, ...body] })
    const params: Param[] = builtins.map((b) => {
      const info = COMPUTE_BUILTINS[b] as { wgsl: string; name: string }
      return { attrs: `@builtin(${info.wgsl})`, name: `${info.name}_in`, type: wtype(builtinType(b)) }
    })
    const entry: Stmt[] = [
      ...params.map((p): Stmt => ({ k: 'assign', lhs: id(p.name.slice(0, -'_in'.length)), e: id(p.name) })),
      { k: 'call', e: call('ng_body') },
    ]
    const [gx, gy, gz] = m.group
    decls.push({ k: 'fn', attrs: `@compute @workgroup_size(${gx}, ${gy}, ${gz})`, name: 'ng_compute', params, ret: null, body: entry })
    return Object.freeze({ code: print(decls), entry: 'ng_compute', raw: Object.freeze([]), directive: false })
  }
}

/** The type of a compute builtin. */
function builtinType(b: Builtin): ValueType {
  return b === 'local-index' ? 'u32' : 'u32x3'
}

/** The natural alignment of a value type (layoutBlock's): 4 for a scalar, 8 or 16 for a vector, a column's for a grid. */
function placeAlign(t: ValueType): number {
  const n = isGrid(t) ? widthOf(columnOf(t)) : widthOf(t)
  return n === 1 ? 4 : n === 2 ? 8 : 16
}

/** The alignment of an array's element in a space (an array's own alignment is its element's). */
function elementAlign(t: DataType, space: Space): number {
  if (typeof t === 'string') return placeAlign(t)
  if ('struct' in t) return layoutBlock(t.struct, space).align
  return elementAlign(t.array, space)
}

/** An f32 value's sign bit flipped (`^`, negation) or cleared (`&`, size), on its bits: `bitcast<f32>(bitcast<u32>(a) ^ 0x80000000u)`. */
function signBit(a: Expr, op: '^' | '&', n: number): Expr {
  const w = new Width(n)
  return w.float(bin(op, w.bits(a), w.u(op === '^' ? '0x80000000u' : '0x7fffffffu')))
}

/** What min or max of two values is known not to be: finite when both are, never NaN when either is never NaN. */
function combine(a: Known, b: Known): Known {
  return a === FINITE && b === FINITE ? FINITE : a >= SURE || b >= SURE ? SURE : UNKNOWN
}

// ---------------------------------------------------------------------------------------------------
// The entry points

/**
 * True when every invocation of a vertex module writes its position: a top-level `position` before any instruction
 * that holds a `return`, or an `if` whose two branches both do so. A loop never counts, and a `return` reached first
 * makes the module unsure.
 */
export function positionSure(module: LensModule): boolean {
  const holdsReturn = (insts: readonly Inst[]): boolean =>
    insts.some((i) => i.op === 'return' || (i.op === 'if' && (holdsReturn(i.then) || holdsReturn(i.else))) || (i.op === 'loop' && holdsReturn(i.body)))
  const writes = (insts: readonly Inst[]): boolean => {
    for (const i of insts) {
      if (i.op === 'position') return true
      if (i.op === 'return') return false
      if (i.op === 'if') {
        if (writes(i.then) && writes(i.else)) return true
        if (holdsReturn(i.then) || holdsReturn(i.else)) return false
      } else if (i.op === 'loop' && holdsReturn(i.body)) return false
    }
    return false
  }
  return writes(module.body)
}

/**
 * Lowers a Lens module to WGSL. Refuses (code `lens`) a module verify() refuses, or options that do not match the
 * module; refuses (code `device`) what this slice does not lower yet, naming it. The same module and options always
 * give the same text.
 */
export function toWgsl(module: LensModule, options: WgslOptions): WgslOut {
  verify(module)
  if (module.stage !== 'compute') notYet(`the ${module.stage} entry is`)
  optionsRule(module, options)
  try {
    return new Lowerer(module).lower(options)
  } catch (e) {
    if (isFault(e)) throw e
    return fail('lens', `wgsl: the lowering raised an error (${e instanceof Error ? e.message : 'unknown'})`)
  }
}
