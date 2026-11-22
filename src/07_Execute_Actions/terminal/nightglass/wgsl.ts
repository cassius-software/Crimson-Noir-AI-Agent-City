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
 * WHAT IS LOWERED (slice 2, PRs 2 and 3). Every stage: the WGSL tree and its printer, every value type, literals as
 * exact bit patterns, arithmetic with the emulations below, casts, building and picking, variables, `if` and `loop`
 * with the 65,536-iteration cap and statement behaviours, typed blocks (uniform blocks, the inline constants in the
 * hidden block, storage blocks of fixed size), raw words, images, derivatives, `discard`, and the compute, vertex and
 * fragment entries. Only stepwise arithmetic is refused, with a Fault of code `device` that names it as not yet
 * lowered, never lowered wrong.
 *
 * RAW WORDS. A storage block whose last field is an array without a length is an `array<u32>`: WebGPU's minimum
 * binding size would otherwise count one element of the final array, which the core lets a binding lack. Each read and
 * write is emitted inline at its words: the index clamped into the elements the binding holds, every word clamped
 * into the binding, zero read and nothing written when no element is held.
 *
 * IMAGES. `texel` tests its level, layer and position in u32 against the view and loads at clamped ones, so it reads
 * zero outside and never reaches outside; `put` writes nothing outside; `extent` clamps its level into the view;
 * `sample` hands the hardware a coordinate whose NaN reads 0 and whose size is held to 2^24, a layer clamped into the
 * view, and an explicit level whose NaN reads 0 and which is held to [-1, 33], so the sampler's own clamp gives the
 * pinned level. An implicit level takes the fine rates of the raw coordinate, as the reference does, never of the one
 * the sampler is handed: where a rate is NaN the level is -1 (so lodMin), elsewhere the rates go to textureSampleGrad,
 * each held to 2^40 (past which the level is lodMax anyway). Filtering and the GPU's level arithmetic from those rates
 * are the GPU's (named in the ledger).
 *
 * STAGES. The vertex entry replaces each vertex-rate input by zero where the reference's attribute rule reads none,
 * from the limits in the hidden block (a wrapped element, a negative one, past the buffer); starts the position as NaN
 * and the live value as 1 when the module may leave its position unwritten; and hands on the position (invariant),
 * the outputs and the live value. The fragment entry discards where the live value is not exactly zero, runs the body,
 * and hands on each output that meets an attachment of its kind, shaped to four components (missing ones 0, a missing
 * alpha 1). `discard` demotes the invocation to a helper that runs on for its neighbours' derivatives, and `ng_gone`
 * keeps every later write and put from taking place. Derivatives are the fine ones; a fragment module with a
 * derivative or an implicit-level sample starts with the directive that turns off WGSL's conservative uniformity
 * refusal, since the verifier already keeps both where every lane of a quad reaches them.
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
import type { Format } from './formats.ts'
import { BUILTINS, columnOf, isGrid, isScalar, isVector, layoutBlock, scalarOf, strideOf, widthOf } from './lens.ts'
import type { Block, Builtin, DataType, Inst, LensModule, Port, Resource, Scalar, Space, Step, ValueType } from './lens.ts'
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
  /** Resources lowered as raw words: storage blocks that end in an array without a length. */
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
  | { readonly k: 'unary'; readonly op: '-' | '!' | '~' | '&'; readonly a: Expr }
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
  | { readonly k: 'discard' }
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
  | { readonly k: 'directive'; readonly text: string }
  | { readonly k: 'struct'; readonly name: string; readonly members: readonly Member[] }
  | { readonly k: 'var'; readonly attrs: string; readonly space: string; readonly name: string; readonly type: string }
  | { readonly k: 'fn'; readonly attrs: string; readonly name: string; readonly params: readonly Param[]; readonly ret: string | null; readonly body: readonly Stmt[] }

const id = (name: string): Expr => ({ k: 'id', name })
const lit = (text: string): Expr => ({ k: 'lit', text })
const call = (fn: string, ...args: readonly Expr[]): Expr => ({ k: 'call', fn, args })
const un = (op: '-' | '!' | '~' | '&', a: Expr): Expr => ({ k: 'unary', op, a })
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
      case 'discard': out.push(`${pad}discard;`); break
      case 'return': out.push(s.e === null ? `${pad}return;` : `${pad}return ${expr(s.e)};`); break
    }
  }
}

/**
 * The text of a tree: declarations in order (a directive first), a blank line before each struct and function and
 * after the directive, one final line feed.
 */
function print(decls: readonly Decl[]): string {
  const out: string[] = []
  let last: Decl['k'] | null = null
  for (const d of decls) {
    if (last !== null && (d.k !== 'var' || last !== 'var')) out.push('')
    last = d.k
    switch (d.k) {
      case 'directive':
        out.push(d.text)
        break
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
  'length', 'normalize', 'uv', 'lvl', 'rate',
] as const
type Family = (typeof FAMILIES)[number]

/** Families that call another family's helper of the same width. */
const DEPENDS: { readonly [F in Family]?: readonly Family[] } = {
  min: ['nan'], max: ['nan'], saturate: ['nan'], step: ['nan'], sign: ['nan'], f2i: ['nan'], f2u: ['nan'], i2f: ['u2f'],
  exp: ['nan'], exp2: ['nan'], atan: ['nan'], atan2: ['nan'],
}

/** Families whose body makes a fresh NaN or infinity from the hidden block's zero word. */
const HIDDEN_FAMILIES: ReadonlySet<Family> = new Set<Family>(['sqrt', 'rsqrt', 'log', 'log2', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan2', 'pow', 'length', 'normalize'])

/** Families used at one width only (a coordinate pair, a level), whose helper's name carries no width. */
const ONE_WIDTH: { readonly [F in Family]?: number } = { uv: 2, lvl: 1, rate: 2 }

/**
 * A helper's name: the family's for a scalar, with `x<n>` for a vector of n as Lens names its vectors (a bare width
 * would make `exp` of two lanes `ng_exp2`, the name of `exp2` of one). `uv`, `lvl` and `rate` have one width and no
 * suffix.
 */
const helperName = (f: Family, n: number): string => `ng_${f}${n === 1 || ONE_WIDTH[f] !== undefined ? '' : `x${n}`}`

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
    case 'uv':
      // texture.ts's coordinate(): NaN reads 0, and a size past 2^24 (infinities too) is held to 2^24 of its sign.
      // Worked on the bits, so neither a NaN nor an infinity meets a float operation finite math leaves open.
      return fn(p1(T), T, [
        uLet(),
        letS('m', U, mag(u)),
        letS('big', T, w.float(bin('|', bin('&', u, w.u('0x80000000u')), w.u('0x4b800000u')))),
        ret(sel(sel(x, id('big'), bin('>', id('m'), w.u('0x4b800000u'))), w.f('0.0'), bin('>', id('m'), w.u('0x7f800000u')))),
      ])
    case 'lvl':
      // A level for the sampler's own clamp to [lodMin, lodMax] (0 <= lodMin <= lodMax <= 32): NaN reads 0 (so
      // lodMin), past 33 reads 33 and below -1 reads -1 (so the ends), infinities included, all on the bits.
      return fn(p1(T), T, [
        uLet(),
        letS('m', U, mag(u)),
        letS('hi', B, bin('&', bin('<', u, w.u('0x80000000u')), bin('>', id('m'), w.u('0x42040000u')))),
        letS('lo', B, bin('&', bin('>=', u, w.u('0x80000000u')), bin('>', id('m'), w.u('0x3f800000u')))),
        ret(sel(sel(sel(x, w.f('33.0'), id('hi')), w.f('-1.0'), id('lo')), w.f('0.0'), bin('>', id('m'), w.u('0x7f800000u')))),
      ])
    case 'rate':
      // A rate of change for textureSampleGrad, its size held to 2^40 (0x53800000) with its sign kept, on the bits. From
      // 2^40 up the reference's level is past 40 (log2 of at least the rate times a size of 1 or more), so lodMax
      // whatever the rate (lodMax <= 32), and a rate held at 2^40 keeps it there; the GPU then squares rates of at most
      // 2^40 times the first level's size (at most 2^15 texels), which stays within f32. An infinity is held too, so
      // no rate the GPU is handed is one its finite math leaves open. The caller hands it no NaN.
      return fn(p1(T), T, [
        uLet(),
        letS('big', T, w.float(bin('|', bin('&', u, w.u('0x80000000u')), w.u('0x53800000u')))),
        ret(sel(x, id('big'), bin('>', mag(u), w.u('0x53800000u')))),
      ])
  }
}

// ---------------------------------------------------------------------------------------------------
// Checking the options and the scope

/** Colour slots a pipeline has at most, and values passed between its stages (front-facing counted). */
const COLOUR_SLOTS = 8
const INTER_STAGE = 16

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
  if ((outputs as readonly unknown[]).length > COLOUR_SLOTS) no(`outputs has ${(outputs as readonly unknown[]).length} colour slots, and a pipeline has at most ${COLOUR_SLOTS}`)
  if (m.stage !== 'fragment' && (outputs as readonly unknown[]).some((k) => k !== null)) no(`a ${m.stage} module has no colour outputs`)
  if (m.stage !== 'vertex' && vertexRate !== 0) no(`a ${m.stage} module has no vertex inputs`)
  if (m.stage === 'compute' && live !== null) no('a compute module carries no live value')
  // A storage entry never lists the vertex stage (it writes nothing), so a vertex module's storage blocks are read only.
  if (m.stage === 'vertex') {
    list.forEach((s, i) => {
      if (s === 'read_write') no(`resource ${i} is read by a vertex module, which binds storage read only`)
    })
  }
  if (m.stage === 'vertex' && live !== null) {
    if (positionSure(m)) no('a vertex module that always writes its position carries no live value')
    if (m.outputs.some((p) => p.slot === live)) no(`location ${String(live)} carries an output port, so it cannot carry the live value`)
  }
  if (m.stage === 'fragment' && live !== null) {
    if (m.inputs.some((p) => p.slot === live)) no(`location ${String(live)} carries an input port, so it cannot carry the live value`)
    // The live value is one more value passed between the stages, and front-facing counts as one too.
    const facing = readsBuiltin(m.body, 'front-facing')
    const n = m.inputs.length + 1 + (facing ? 1 : 0)
    if (n > INTER_STAGE) no(`the live value would make ${n} values passed between the stages (${m.inputs.length} inputs${facing ? ', front-facing' : ''} and the live value), and a pipeline passes at most ${INTER_STAGE}`)
  }
}

/** True when a list of instructions reads a builtin, nested ones included. */
function readsBuiltin(insts: readonly Inst[], name: Builtin): boolean {
  return insts.some((i) => (i.op === 'builtin' && i.name === name) || (i.op === 'if' && (readsBuiltin(i.then, name) || readsBuiltin(i.else, name))) || (i.op === 'loop' && readsBuiltin(i.body, name)))
}

/** Refuses what this slice does not lower yet, by name, rather than lowering it wrong. */
const notYet = (what: string): never => fail('device', `wgsl: ${what} not yet lowered`)

/** A storage block whose last field is an array without a length: lowered as raw words. */
function endsInRuntimeArray(b: Block): boolean {
  const last = b.fields[b.fields.length - 1].type
  return typeof last !== 'string' && 'array' in last && last.len === 0
}

// ---------------------------------------------------------------------------------------------------
// The lowering

/** The WGSL builtin, the private variable and the entry's parameter or member behind each builtin. */
const BUILTIN_VARS: { readonly [B in Builtin]: { readonly wgsl: string; readonly name: string; readonly member: string } } = {
  'vertex-index': { wgsl: 'vertex_index', name: 'ng_vi', member: 'vi' },
  'instance-index': { wgsl: 'instance_index', name: 'ng_ii', member: 'ii' },
  'frag-coord': { wgsl: 'position', name: 'ng_fc', member: 'fc' },
  'front-facing': { wgsl: 'front_facing', name: 'ng_ff', member: 'ff' },
  'global-id': { wgsl: 'global_invocation_id', name: 'ng_global', member: 'ng_global_in' },
  'local-id': { wgsl: 'local_invocation_id', name: 'ng_local', member: 'ng_local_in' },
  'group-id': { wgsl: 'workgroup_id', name: 'ng_group', member: 'ng_group_in' },
  'local-index': { wgsl: 'local_invocation_index', name: 'ng_index', member: 'ng_index_in' },
  'group-count': { wgsl: 'num_workgroups', name: 'ng_count', member: 'ng_count_in' },
}

/** The WGSL storage texel format of each format a storage image may have. */
const STORAGE_TEXEL: { readonly [F in Format]?: string } = {
  rgba8: 'rgba8unorm', rgba16f: 'rgba16float', r32f: 'r32float', rg32f: 'rg32float', rgba32f: 'rgba32float', r32u: 'r32uint', r32i: 'r32sint',
}

/** The WGSL type of an image or sampler resource. */
function handleType(r: Resource): string {
  switch (r.kind) {
    case 'image': {
      const arrayed = r.dims === '2d-array' ? '_array' : ''
      if (r.sample === 'depth') return `texture_depth_2d${arrayed}`
      return `texture_2d${arrayed}<${r.sample === 'float' ? 'f32' : r.sample === 'uint' ? 'u32' : 'i32'}>`
    }
    case 'storage-image': {
      const f = STORAGE_TEXEL[r.format]
      return f === undefined ? fail('lens', `wgsl: ${r.format} is not a storage image format`) : `texture_storage_2d<${f}, write>`
    }
    case 'sampler': return 'sampler'
    default: return fail('lens', `wgsl: a ${r.kind} is not a handle`)
  }
}

/** The fine derivatives, as pinned (a driver may give coarse ones: A16). */
const DERIV = { dx: 'dpdxFine', dy: 'dpdyFine', width: 'fwidthFine' } as const

/** True when a list of instructions holds a `discard`, nested ones included. */
function holdsDiscard(insts: readonly Inst[]): boolean {
  return insts.some((i) => i.op === 'discard' || (i.op === 'if' && (holdsDiscard(i.then) || holdsDiscard(i.else))) || (i.op === 'loop' && holdsDiscard(i.body)))
}

/** Ports in slot order. */
const bySlot = (ports: readonly Port[]): Port[] => [...ports].sort((a, b) => a.slot - b.slot)

/** A port's stage attributes: its location, and flat interpolation (first vertex) where it is flat. */
const portAttrs = (p: Port): string => `@location(${p.slot})${p.flat === true ? ' @interpolate(flat)' : ''}`

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
  /** Storage resources lowered as raw words (their block ends in an array without a length). */
  private readonly raw = new Set<number>()
  private hidden = false
  private temps = 0
  /** A derivative or an implicit-level sample was lowered: the module needs the uniformity directive. */
  private derivs = false
  /** Fragment: an implicit-level sample was lowered, through the private `ng_sampled` its two branches assign. */
  private sampled = false
  /** Fragment: writes and puts are guarded by `!ng_gone` (the module holds a discard, or tests a live value). */
  private gone = false
  /** Vertex: `position` also clears `ng_live` (the module may leave its position unwritten, and live is carried). */
  private liveOut = false

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
      case 'builtin':
        this.builtins.add(i.name)
        this.def(i.id, id(BUILTIN_VARS[i.name].name), out)
        return true
      case 'in': this.def(i.id, id(`ng_i${i.slot}`), out); return true
      case 'out': out.push({ k: 'assign', lhs: id(`ng_o${i.slot}`), e: this.v(i.a) }); return true
      case 'position':
        out.push({ k: 'assign', lhs: id('ng_pos'), e: this.v(i.a) })
        if (this.liveOut) out.push({ k: 'assign', lhs: id('ng_live'), e: lit('0.0') })
        return true
      case 'read': {
        const r = this.m.resources[i.res]
        if (r.kind !== 'uniform' && r.kind !== 'storage' && r.kind !== 'constants') return fail('lens', `wgsl: read of resource ${i.res}, a ${r.kind}`)
        if (this.raw.has(i.res)) {
          this.rawRead(i, r.block, out)
          return true
        }
        const base = r.kind === 'constants' ? member(id('ng_h'), 'c') : id(`r${i.res}`)
        if (r.kind === 'constants') this.hidden = true
        this.def(i.id, this.path(base, r.block, i.path, out), out)
        return true
      }
      case 'write': {
        const r = this.m.resources[i.res]
        if (r.kind !== 'storage') return fail('lens', `wgsl: write to resource ${i.res}, a ${r.kind}`)
        if (this.raw.has(i.res)) {
          this.rawWrite(i, r.block, out)
          return true
        }
        const lhs = this.path(id(`r${i.res}`), r.block, i.path, out)
        this.guarded(null, [{ k: 'assign', lhs, e: this.v(i.a) }], out)
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
      case 'sample': this.sample(i, out); return true
      case 'texel': this.texel(i, out); return true
      case 'put': this.put(i, out); return true
      case 'extent': this.extent(i, out); return true
      case 'deriv':
        this.derivs = true
        this.def(i.id, call(DERIV[i.fn], this.v(i.a)), out)
        return true
      case 'discard':
        // WGSL's discard demotes the invocation to a helper and lets it run on, as the pinned rule does; ng_gone
        // keeps every later write and put from taking place, whatever a platform does with a helper's stores.
        out.push({ k: 'assign', lhs: id('ng_gone'), e: lit('true') }, { k: 'discard' })
        return true
    }
  }

  /** Statements that take place only where `c` holds (when given) and, in a module with ng_gone, not after discard. */
  private guarded(c: Expr | null, body: Stmt[], out: Stmt[]): void {
    const g = this.gone ? un('!', id('ng_gone')) : null
    const cond = c === null ? g : g === null ? c : bin('&', c, g)
    if (cond === null) out.push(...body)
    else out.push({ k: 'if', c: cond, then: body, else: [] })
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
  // Raw words

  /**
   * Where a value in a raw block lies, as interp.ts's plan() and address() find it: the word of each component, and
   * the elements the binding holds when the path enters the final array (null when it stays in the fixed part, which
   * the core guarantees the binding holds). An index into the final array is clamped into the elements held, and every
   * word into the binding, so no access leaves it; with none held the caller reads zero and writes nothing.
   */
  private rawPlace(res: number, b: Block, path: readonly Step[], out: Stmt[]): { readonly words: Expr[]; readonly held: Expr | null; readonly leaf: ValueType } {
    const r = id(`r${res}`)
    let t: DataType = { struct: b }
    let base = 0
    const terms: Expr[] = []
    let held: Expr | null = null
    let len: Expr | null = null
    const scaled = (j: Expr, words: number): Expr => (words === 1 ? j : bin('*', j, lit(`${words}u`)))
    for (const step of path) {
      if (typeof t === 'string') break
      if ('struct' in t) {
        const k = step as number
        base += layoutBlock(t.struct, 'storage').offsets[k]
        t = t.struct.fields[k].type
        continue
      }
      const words = strideOf(t.array, 'storage') / 4
      if (t.len === 0) {
        // Elements held: floor((size - start) / stride), in words since both are whole words, or 0 when the
        // binding ends before the array starts.
        const n = this.let('u32', call('arrayLength', un('&', r)), out, 'len')
        len = n
        const s4 = base / 4
        const rest = s4 === 0 ? n : bin('-', n, lit(`${s4}u`))
        const count = words === 1 ? rest : bin('/', rest, lit(`${words}u`))
        held = this.let('u32', s4 === 0 ? count : sel(lit('0u'), count, bin('>=', n, lit(`${s4}u`))), out, 'n')
        const last = bin('-', call('max', held, lit('1u')), lit('1u'))
        if (typeof step !== 'number') {
          const v = this.v(step.at)
          const i = this.typeOf(step.at) === 'u32' ? v : sel(call('bitcast<u32>', v), lit('0u'), bin('<', v, lit('0i')))
          terms.push(scaled(this.let('u32', call('min', i, last), out, 'j'), words))
        } else if (step !== 0) {
          terms.push(scaled(this.let('u32', call('min', lit(`${step}u`), last), out, 'j'), words))
        }
      } else if (typeof step === 'number') {
        base += step * words * 4
      } else {
        terms.push(scaled(this.clamped(step.at, t.len, out), words))
      }
      t = t.array
    }
    const leaf = t as ValueType
    const n = widthOf(leaf)
    const parts: number[] = []
    if (isGrid(leaf)) {
      const column = strideOf(columnOf(leaf) as DataType, 'storage') / 4
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) parts.push(j * column + i)
    } else {
      for (let c = 0; c < n; c++) parts.push(c)
    }
    const b4 = base / 4
    if (terms.length === 0 && len === null) return { words: parts.map((p) => lit(`${b4 + p}u`)), held, leaf }
    let w: Expr = terms.length === 0 ? lit(`${b4}u`) : terms.reduce((acc, e) => bin('+', acc, e))
    if (terms.length > 0 && b4 !== 0) w = bin('+', w, lit(`${b4}u`))
    const end = len === null ? null : bin('-', len, lit('1u'))
    if (end !== null) w = call('min', w, end)
    const word = this.let('u32', w, out, 'w')
    const words = parts.map((p) => {
      if (p === 0) return word
      const at = bin('+', word, lit(`${p}u`))
      return end === null ? at : call('min', at, end)
    })
    return { words, held, leaf }
  }

  /** A read of a raw block: each component's word, bit cast; zero when the final array holds no element. */
  private rawRead(i: InstOf<'read'>, b: Block, out: Stmt[]): void {
    const { words, held, leaf } = this.rawPlace(i.res, b, i.path, out)
    const k = scalarOf(leaf)
    const T = wtype(leaf)
    const r = id(`r${i.res}`)
    const comps = words.map((w) => (k === 'u32' ? index(r, w) : call(`bitcast<${k}>`, index(r, w))))
    const value = comps.length === 1 ? comps[0] : call(T, ...comps)
    if (held === null) {
      this.def(i.id, value, out)
      return
    }
    const t = this.let(T, value, out)
    const some = bin('!=', held, lit('0u'))
    if (!isGrid(leaf)) {
      this.def(i.id, sel(call(T), t, some), out)
      return
    }
    // select takes no grid: a grid is chosen column by column.
    const col = wtype(columnOf(leaf))
    this.def(i.id, call(T, ...Array.from({ length: widthOf(leaf) }, (_, j) => sel(call(col), index(t, lit(`${j}u`)), some))), out)
  }

  /** A write to a raw block: each component's bits to its word, only when the final array holds an element. */
  private rawWrite(i: InstOf<'write'>, b: Block, out: Stmt[]): void {
    const { words, held, leaf } = this.rawPlace(i.res, b, i.path, out)
    const k = scalarOf(leaf)
    const n = widthOf(leaf)
    const a = this.v(i.a)
    const r = id(`r${i.res}`)
    const comp = (c: number): Expr => (isGrid(leaf) ? index(index(a, lit(`${Math.floor(c / n)}u`)), lit(`${c % n}u`)) : isScalar(leaf) ? a : member(a, SWIZZLE[c]))
    const body = words.map((w, c): Stmt => ({ k: 'assign', lhs: index(r, w), e: k === 'u32' ? comp(c) : call('bitcast<u32>', comp(c)) }))
    this.guarded(held === null ? null : bin('!=', held, lit('0u')), body, out)
  }

  // -------------------------------------------------------------------------------------------------
  // Images

  /** An integer value as u32: itself, or an i32's bits (a negative one is then past every size it is compared with). */
  private unsigned(v: number, out: Stmt[]): Expr {
    const t = this.typeOf(v)
    if (scalarOf(t) === 'u32') return this.v(v)
    const U = vtype('u32', widthOf(t))
    return this.let(U, call(`bitcast<${U}>`, this.v(v)), out)
  }

  /** An integer value as u32 with a negative i32 taken to 0, as texture.ts clamps a level or a layer. */
  private atLeastZero(v: number, out: Stmt[]): Expr {
    const a = this.v(v)
    return this.typeOf(v) === 'u32' ? a : this.let('u32', sel(call('bitcast<u32>', a), lit('0u'), bin('<', a, lit('0i'))), out)
  }

  /**
   * texel: level, layer and position tested in u32 against the view's levels, layers and the level's size; the load
   * uses clamped values, so no access is ever out of range, and the result is zero (alpha included) outside.
   */
  private texel(i: InstOf<'texel'>, out: Stmt[]): void {
    const r = id(`r${i.image}`)
    const q = this.unsigned(i.level, out)
    const nl = this.let('u32', call('textureNumLevels', r), out)
    const lq = this.let('u32', call('min', q, bin('-', nl, lit('1u'))), out)
    const d = this.let('vec2<u32>', call('textureDimensions', r, lq), out)
    const p = this.unsigned(i.at, out)
    const pc = this.let('vec2<u32>', call('min', p, bin('-', d, call('vec2<u32>', lit('1u')))), out)
    let inside = bin('&', bin('<', q, nl), call('all', bin('<', p, d)))
    const args: Expr[] = [r, pc]
    if (i.layer !== undefined) {
      const k = this.unsigned(i.layer, out)
      const nk = this.let('u32', call('textureNumLayers', r), out)
      args.push(this.let('u32', call('min', k, bin('-', nk, lit('1u'))), out))
      inside = bin('&', inside, bin('<', k, nk))
    }
    args.push(lq)
    const ok = this.let('bool', inside, out)
    const T = wtype(i.t)
    const t = this.let(T, call('textureLoad', ...args), out)
    this.def(i.id, sel(call(T), t, ok), out)
  }

  /** put: nothing written outside the image's first level, nor after discard; the conversion is the format's (A6). */
  private put(i: InstOf<'put'>, out: Stmt[]): void {
    const r = id(`r${i.image}`)
    const p = this.unsigned(i.at, out)
    const ok = this.let('bool', call('all', bin('<', p, call('textureDimensions', r))), out)
    this.guarded(ok, [{ k: 'call', e: call('textureStore', r, this.v(i.at), this.v(i.a)) }], out)
  }

  /** extent: the size of a sampled image's level clamped into the view's levels, or of a storage image's one level. */
  private extent(i: InstOf<'extent'>, out: Stmt[]): void {
    const r = id(`r${i.image}`)
    if (i.level === undefined) {
      this.def(i.id, call('textureDimensions', r), out)
      return
    }
    const l = this.atLeastZero(i.level, out)
    const nl = this.let('u32', call('textureNumLevels', r), out)
    this.def(i.id, call('textureDimensions', r, call('min', l, bin('-', nl, lit('1u')))), out)
  }

  /**
   * sample: the coordinate through ng_uv (texture.ts's NaN and size rules), the layer clamped into the view's layers
   * here rather than left to the platform, and an explicit level through ng_lvl for the sampler's own clamp to its
   * level range. An implicit level takes its rates from the raw coordinate, as interp.ts's lodFromRates does, not from
   * the one ng_uv makes (which turns a NaN into 0, a finite rate the reference never sees): where a rate is NaN the
   * reference's level is NaN, so lodMin, which textureSampleLevel at level -1 gives through the sampler's clamp;
   * elsewhere textureSampleGrad takes the fine rates, each held to 2^40 by ng_rate. Neither call needs uniform control,
   * so the branch may part the lanes of a quad. Filtering and the level arithmetic are the GPU's (A7, A8).
   */
  private sample(i: InstOf<'sample'>, out: Stmt[]): void {
    const r = id(`r${i.image}`)
    const args: Expr[] = [r, id(`r${i.sampler}`), call(this.helper('uv', 2), this.v(i.uv))]
    if (i.level === undefined) {
      this.derivs = true
      this.sampled = true
      const uv = this.v(i.uv)
      const gx = this.let('vec2<f32>', call(DERIV.dx, uv), out)
      const gy = this.let('vec2<f32>', call(DERIV.dy, uv), out)
      const nan = this.helper('nan', 2)
      const wild = this.let('bool', call('any', bin('|', call(nan, gx), call(nan, gy))), out)
      args[2] = this.let('vec2<f32>', args[2], out)
      if (i.layer !== undefined) args.push(this.layer(r, i.layer, out))
      const rate = this.helper('rate', 2)
      const to = (e: Expr): Stmt[] => [{ k: 'assign', lhs: id('ng_sampled'), e }]
      out.push({ k: 'if', c: wild, then: to(call('textureSampleLevel', ...args, lit('-1.0'))), else: to(call('textureSampleGrad', ...args, call(rate, gx), call(rate, gy))) })
      this.def(i.id, id('ng_sampled'), out)
      return
    }
    if (i.layer !== undefined) args.push(this.layer(r, i.layer, out))
    args.push(call(this.helper('lvl', 1), this.v(i.level)))
    this.def(i.id, call('textureSampleLevel', ...args), out)
  }

  /** A sample's layer: a negative i32 taken to 0, then clamped into the view's layers. */
  private layer(r: Expr, layer: number, out: Stmt[]): Expr {
    const k = this.atLeastZero(layer, out)
    const nk = this.let('u32', call('textureNumLayers', r), out)
    return this.let('u32', call('min', k, bin('-', nk, lit('1u'))), out)
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
      if (r.kind === 'storage' && endsInRuntimeArray(r.block)) this.raw.add(i)
    })
    this.gone = m.stage === 'fragment' && (holdsDiscard(m.body) || options.live !== null)
    this.liveOut = m.stage === 'vertex' && options.live !== null
    // Structs are named in order of first reach: resources in order, each block before the blocks it holds.
    m.resources.forEach((r, i) => {
      if (r.kind === 'uniform' || r.kind === 'constants') this.struct(r.block, 'uniform')
      else if (r.kind === 'storage' && !this.raw.has(i)) this.struct(r.block, 'storage')
    })
    const constants = m.resources.find((r) => r.kind === 'constants')
    const body: Stmt[] = []
    this.list(m.body, 0, body)
    const counters: Stmt[] = [...this.depths].sort((a, b) => a - b).map((d) => ({ k: 'var', name: `ng_c${d}`, type: 'u32', e: null }))
    // The entry is built before the declarations: the vertex limit selects read the hidden block.
    const entry = m.stage === 'vertex' ? this.vertexEntry(options) : m.stage === 'fragment' ? this.fragmentEntry(options) : this.computeEntry()

    const decls: Decl[] = []
    if (this.derivs) decls.push({ k: 'directive', text: 'diagnostic(off, derivative_uniformity);' })
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
      if (r.kind === 'constants') return
      const attrs = `@group(${r.set}) @binding(${r.binding})`
      if (r.kind === 'uniform') decls.push({ k: 'var', attrs, space: '<uniform>', name: `r${i}`, type: this.structs.uniform.get(r.block) as string })
      else if (r.kind === 'storage') {
        const type = this.raw.has(i) ? 'array<u32>' : (this.structs.storage.get(r.block) as string)
        decls.push({ k: 'var', attrs, space: `<storage, ${options.storage[i]}>`, name: `r${i}`, type })
      } else decls.push({ k: 'var', attrs, space: '', name: `r${i}`, type: handleType(r) })
    })
    const priv = (name: string, type: string): void => {
      decls.push({ k: 'var', attrs: '', space: '<private>', name, type })
    }
    for (const b of this.usedBuiltins()) priv(BUILTIN_VARS[b].name, wtype(BUILTINS[b].type))
    for (const p of bySlot(m.inputs)) priv(`ng_i${p.slot}`, wtype(p.type))
    for (const p of bySlot(m.outputs)) priv(`ng_o${p.slot}`, wtype(p.type))
    if (m.stage === 'vertex') priv('ng_pos', 'vec4<f32>')
    if (this.liveOut) priv('ng_live', 'f32')
    if (this.gone) priv('ng_gone', 'bool')
    if (this.sampled) priv('ng_sampled', 'vec4<f32>')
    for (const f of FAMILIES) {
      for (let n = 1; n <= 4; n++) if ((ONE_WIDTH[f] ?? n) === n && this.helpers.has(helperName(f, n))) decls.push(helperFn(f, new Width(n)))
    }
    decls.push({ k: 'fn', attrs: '', name: 'ng_body', params: [], ret: null, body: [...counters, ...body] })
    decls.push(...entry)
    const name = m.stage === 'vertex' ? 'ng_vertex' : m.stage === 'fragment' ? 'ng_fragment' : 'ng_compute'
    return Object.freeze({ code: print(decls), entry: name, raw: Object.freeze([...this.raw]), directive: this.derivs })
  }

  /** The builtins the body reads, in BUILTINS order. */
  private usedBuiltins(): Builtin[] {
    return (Object.keys(BUILTINS) as Builtin[]).filter((b) => this.builtins.has(b))
  }

  /** The compute entry: each builtin used copied into its private variable, then the body. */
  private computeEntry(): Decl[] {
    const builtins = this.usedBuiltins()
    const params: Param[] = builtins.map((b) => ({ attrs: `@builtin(${BUILTIN_VARS[b].wgsl})`, name: BUILTIN_VARS[b].member, type: wtype(BUILTINS[b].type) }))
    const body: Stmt[] = [
      ...builtins.map((b): Stmt => ({ k: 'assign', lhs: id(BUILTIN_VARS[b].name), e: id(BUILTIN_VARS[b].member) })),
      { k: 'call', e: call('ng_body') },
    ]
    const [gx, gy, gz] = this.m.group
    return [{ k: 'fn', attrs: `@compute @workgroup_size(${gx}, ${gy}, ${gz})`, name: 'ng_compute', params, ret: null, body }]
  }

  /**
   * The vertex entry: builtins and inputs copied in, each vertex-rate input replaced by zero where the reference's
   * attribute rule reads none (the limit selects, from the hidden block), the position started as NaN when the module
   * may leave it unwritten, then the body, and every output, the position (invariant) and the live value handed on.
   */
  private vertexEntry(options: WgslOptions): Decl[] {
    const m = this.m
    const a = id('a')
    const h = id('ng_h')
    const inputs = bySlot(m.inputs)
    const rate = inputs.filter((p) => ((options.vertexRate >>> p.slot) & 1) === 1)
    const vin: Member[] = []
    if (this.builtins.has('vertex-index') || rate.length > 0) vin.push({ attrs: '@builtin(vertex_index)', name: 'vi', type: 'u32' })
    if (this.builtins.has('instance-index')) vin.push({ attrs: '@builtin(instance_index)', name: 'ii', type: 'u32' })
    for (const p of inputs) vin.push({ attrs: `@location(${p.slot})`, name: `a${p.slot}`, type: wtype(p.type) })
    const vout: Member[] = [{ attrs: '@builtin(position) @invariant', name: 'pos', type: 'vec4<f32>' }]
    for (const p of bySlot(m.outputs)) vout.push({ attrs: portAttrs(p), name: `o${p.slot}`, type: wtype(p.type) })
    if (this.liveOut) vout.push({ attrs: `@location(${options.live as number})`, name: 'live', type: 'f32' })

    const body: Stmt[] = []
    for (const b of this.usedBuiltins()) body.push({ k: 'assign', lhs: id(BUILTIN_VARS[b].name), e: member(a, BUILTIN_VARS[b].member) })
    if (rate.length > 0) {
      // With base < 0 the true element index + base is negative exactly when the wrapped vertex_index >= u32(base);
      // with base > 0 it reaches 2^32 exactly when vertex_index < base. Otherwise the element is vertex_index.
      this.hidden = true
      const vi = member(a, 'vi')
      const base = member(h, 'base')
      body.push(
        letS('ng_b', 'u32', call('bitcast<u32>', base)),
        letS('ng_neg', 'bool', bin('&', bin('<', base, lit('0i')), bin('>=', vi, id('ng_b')))),
        letS('ng_over', 'bool', bin('&', bin('>', base, lit('0i')), bin('<', vi, id('ng_b')))),
      )
      for (const p of rate) {
        const s = p.slot
        const bit = lit(`${1 << s}u`)
        const l = id(`ng_l${s}`)
        const unchecked = bin('==', bin('&', member(h, 'checked'), bit), lit('0u'))
        const some = bin('==', bin('&', member(h, 'none'), bit), lit('0u'))
        // lim 0xFFFFFFFF marks a stride-0 attribute, whose bytes do not depend on the element.
        const within = bin('|', bin('==', l, lit('0xffffffffu')), bin('&', un('!', id('ng_over')), bin('<=', vi, l)))
        body.push(
          letS(`ng_l${s}`, 'u32', member(index(member(h, 'lim'), lit(`${s >> 2}u`)), SWIZZLE[s & 3])),
          letS(`ng_ok${s}`, 'bool', bin('|', unchecked, bin('&', bin('&', some, un('!', id('ng_neg'))), within))),
          { k: 'assign', lhs: id(`ng_i${s}`), e: sel(call(wtype(p.type)), member(a, `a${s}`), id(`ng_ok${s}`)) },
        )
      }
    }
    for (const p of inputs) if (!rate.includes(p)) body.push({ k: 'assign', lhs: id(`ng_i${p.slot}`), e: member(a, `a${p.slot}`) })
    if (!positionSure(m)) {
      body.push(letS('ng_k', 'u32', lit(hex(QNAN))), { k: 'assign', lhs: id('ng_pos'), e: call('vec4<f32>', call('bitcast<f32>', id('ng_k'))) })
      if (this.liveOut) body.push({ k: 'assign', lhs: id('ng_live'), e: lit('1.0') })
    }
    body.push({ k: 'call', e: call('ng_body') }, { k: 'var', name: 'o', type: 'NgVOut', e: null }, { k: 'assign', lhs: member(id('o'), 'pos'), e: id('ng_pos') })
    for (const p of bySlot(m.outputs)) body.push({ k: 'assign', lhs: member(id('o'), `o${p.slot}`), e: id(`ng_o${p.slot}`) })
    if (this.liveOut) body.push({ k: 'assign', lhs: member(id('o'), 'live'), e: id('ng_live') })
    body.push({ k: 'return', e: id('o') })
    const out: Decl[] = []
    if (vin.length > 0) out.push({ k: 'struct', name: 'NgVIn', members: vin })
    out.push({ k: 'struct', name: 'NgVOut', members: vout })
    out.push({ k: 'fn', attrs: '@vertex', name: 'ng_vertex', params: vin.length > 0 ? [{ attrs: '', name: 'a', type: 'NgVIn' }] : [], ret: 'NgVOut', body })
    return out
  }

  /**
   * The fragment entry: builtins and inputs copied in, a fragment whose live value is not exactly 0 discarded, then
   * the body, and each output with an attachment of its kind shaped to four components (missing ones 0, alpha 1).
   */
  private fragmentEntry(options: WgslOptions): Decl[] {
    const m = this.m
    const a = id('a')
    const fin: Member[] = []
    for (const b of this.usedBuiltins()) fin.push({ attrs: `@builtin(${BUILTIN_VARS[b].wgsl})`, name: BUILTIN_VARS[b].member, type: wtype(BUILTINS[b].type) })
    for (const p of bySlot(m.inputs)) fin.push({ attrs: portAttrs(p), name: `i${p.slot}`, type: wtype(p.type) })
    if (options.live !== null) fin.push({ attrs: `@location(${options.live})`, name: 'live', type: 'f32' })
    const shaped = bySlot(m.outputs).filter((p) => options.outputs[p.slot] === scalarOf(p.type))
    const fout: Member[] = shaped.map((p) => ({ attrs: `@location(${p.slot})`, name: `c${p.slot}`, type: vtype(scalarOf(p.type), 4) }))

    const body: Stmt[] = []
    for (const b of this.usedBuiltins()) body.push({ k: 'assign', lhs: id(BUILTIN_VARS[b].name), e: member(a, BUILTIN_VARS[b].member) })
    for (const p of bySlot(m.inputs)) body.push({ k: 'assign', lhs: id(`ng_i${p.slot}`), e: member(a, `i${p.slot}`) })
    if (options.live !== null) {
      // A triangle whose vertices all wrote a position interpolates live as exactly 0; any other value, NaN
      // included, is told by its bits, not by an IEEE comparison.
      const dead = bin('!=', bin('&', call('bitcast<u32>', member(a, 'live')), lit('0x7fffffffu')), lit('0u'))
      body.push({ k: 'if', c: dead, then: [{ k: 'assign', lhs: id('ng_gone'), e: lit('true') }, { k: 'discard' }], else: [] })
    }
    body.push({ k: 'call', e: call('ng_body') })
    if (fout.length > 0) {
      body.push({ k: 'var', name: 'o', type: 'NgFOut', e: null })
      for (const p of shaped) {
        const k = scalarOf(p.type)
        const n = widthOf(p.type)
        const o = id(`ng_o${p.slot}`)
        const pad = (c: number): Expr => lit(k === 'f32' ? (c === 3 ? '1.0' : '0.0') : `${c === 3 ? 1 : 0}${k === 'u32' ? 'u' : 'i'}`)
        const e = n === 4 ? o : call(vtype(k, 4), o, ...Array.from({ length: 4 - n }, (_, c) => pad(n + c)))
        body.push({ k: 'assign', lhs: member(id('o'), `c${p.slot}`), e })
      }
      body.push({ k: 'return', e: id('o') })
    }
    const out: Decl[] = []
    if (fin.length > 0) out.push({ k: 'struct', name: 'NgFIn', members: fin })
    if (fout.length > 0) out.push({ k: 'struct', name: 'NgFOut', members: fout })
    out.push({ k: 'fn', attrs: '@fragment', name: 'ng_fragment', params: fin.length > 0 ? [{ attrs: '', name: 'a', type: 'NgFIn' }] : [], ret: fout.length > 0 ? 'NgFOut' : null, body })
    return out
  }
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
  optionsRule(module, options)
  try {
    return new Lowerer(module).lower(options)
  } catch (e) {
    if (isFault(e)) throw e
    return fail('lens', `wgsl: the lowering raised an error (${e instanceof Error ? e.message : 'unknown'})`)
  }
}
