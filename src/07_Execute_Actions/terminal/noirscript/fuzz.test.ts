// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the seeded fuzz suite of NoirScript: thousands of random lines, half token soup
 * (every keyword, type, operator, literal and stray character the lexer knows, in any order) and half grammar-shaped
 * programs (functions, globals, loops, queries, vectors, casts, host writes, with faults sprinkled in), run against
 * random hosts whose tables and writes may be odd or throw. The properties: `run` and `asm` never throw (every
 * failure is `error` text and never an internal one), a run never takes more than `limits.steps` steps, the session
 * answers `print(1)` afterwards, and a twin session fed the same lines gives the same results. Every case is
 * reproducible from its seed and index; the generator is a copy of the repository's mulberry32, kept inside the
 * folder because nothing here may import from outside it.
 * What breaks if it is removed? A crash, a hang or a runaway line in the console could hide behind the hand-written
 * tests until a player found it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { NoirHost, NoirLimits, NoirResult, NoirTables } from './index.ts'
import { EMPTY_TABLES, INTRINSIC_NAMES, KEYWORDS, NoirSession, TYPE_NAMES } from './index.ts'

/** Small limits keep a runaway case to a fraction of a millisecond; the properties hold for any limits. */
const FUZZ_LIMITS: NoirLimits = Object.freeze({ steps: 20_000, out: 4_096, cells: 65_536, depth: 64 })

// ---------------------------------------------------------------------------------------------------
// The seeded source

interface Gen {
  next(): number
  int(lo: number, hi: number): number
  pick<T>(xs: readonly T[]): T
  bool(p?: number): boolean
}

/** Mulberry32, as 02_Define_The_Rules/property.ts has it: the same cases on every machine. */
function gen(seed: number): Gen {
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  return {
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (xs) => xs[Math.floor(next() * xs.length)]!,
    bool: (p = 0.5) => next() < p,
  }
}

// ---------------------------------------------------------------------------------------------------
// Token soup

const OPS: readonly string[] = ['+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<<', '>>', '==', '!=', '<', '<=', '>', '>=', '&&', '||', '=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '->', '..', '..=', '.', ',', ';', ':', '::', '(', ')', '{', '}', '[', ']']
const WORDS: readonly string[] = ['x', 'y', 'f', 'g', 'i', 'n', 's', 'v', 'crowd', 'cars', 'kernel', 'frame', 'speed', 'mode', 'len', 'x4', '_', 'If', 'letx', ...INTRINSIC_NAMES]
const LITS: readonly string[] = ['0', '1', '2', '42', '7u', '0xFFu', '0b101', '1_000', '1.5', '2.', '1e3', '2.5e-2', '1.0f', '4294967295', '4294967296', '2147483648', '-2147483648', '99999999999', '"s"', '"a\\nb"', '"open', '"\\q"', '0x', '1e', '0b102']
const JUNK: readonly string[] = ['@', '#', '$', '`', '\\', "'", '.5', '\n', '// c\n', '/* c */', '/* open', '\r\n', '\t', 'é', '\u0000']

function soup(g: Gen): string {
  const n = g.int(1, 60)
  const parts: string[] = []
  for (let i = 0; i < n; i++) {
    const roll = g.next()
    parts.push(roll < 0.2 ? g.pick(KEYWORDS) : roll < 0.3 ? g.pick(TYPE_NAMES) : roll < 0.6 ? g.pick(OPS) : roll < 0.75 ? g.pick(WORDS) : roll < 0.95 ? g.pick(LITS) : g.pick(JUNK))
  }
  return parts.join(g.bool(0.8) ? ' ' : '')
}

// ---------------------------------------------------------------------------------------------------
// Grammar-shaped programs

type Ty = 'i32' | 'u32' | 'f32' | 'bool' | 'f32x4' | 'i32x4' | 'u32x4' | 'u32x8' | '[i32; 4]' | 'col<f32>'
const SCALARS: readonly Ty[] = ['i32', 'u32', 'f32', 'bool']
const VECTORS: readonly Ty[] = ['f32x4', 'i32x4', 'u32x4', 'u32x8']
const TYPES: readonly Ty[] = [...SCALARS, ...VECTORS, '[i32; 4]', 'col<f32>']
const isVector = (t: Ty): boolean => VECTORS.includes(t)
const laneOf = (t: Ty): Ty => (t === 'f32x4' ? 'f32' : t === 'i32x4' ? 'i32' : 'u32')
const INT_VECTORS: readonly Ty[] = ['i32x4', 'u32x4', 'u32x8']

interface Var { readonly name: string; readonly ty: Ty; readonly mut: boolean }
interface Fn { readonly name: string; readonly params: readonly Ty[]; readonly ret: Ty | 'void' }
interface Ctx {
  readonly vars: Var[]
  readonly fns: Fn[]
  readonly loop: boolean
  readonly ret: Ty | 'void' | null
  /** The one counter of fresh names for the whole program. */
  readonly names: { n: number }
}

const child = (ctx: Ctx, extra: Partial<Pick<Ctx, 'loop' | 'ret'>> = {}): Ctx => ({ vars: [...ctx.vars], fns: ctx.fns, loop: ctx.loop, ret: ctx.ret, names: ctx.names, ...extra })

function leaf(g: Gen, ctx: Ctx, ty: Ty): string {
  const vars = ctx.vars.filter((v) => v.ty === ty)
  if (vars.length > 0 && g.bool(0.5)) return g.pick(vars).name
  switch (ty) {
    case 'i32': return String(g.pick([0, 1, -1, 2, 3, 7, 42, 255, 65536, 2147483647, -2147483648, g.int(-1000, 1000)]))
    case 'u32': return `${g.pick([0, 1, 2, 7, 255, 4294967295, 2147483648, g.int(0, 100000)])}u`
    case 'f32': return g.pick(['0.0', '1.0', '-1.5', '0.1', '1e3', '2.5e-2', '3.4028235e38', '1e-45', '2.', '4.0f', `${g.int(-100, 100)}.${g.int(0, 99)}`])
    case 'bool': return g.pick(['true', 'false'])
    case 'f32x4': case 'i32x4': case 'u32x4': return g.bool() ? `splat_${ty}(${leaf(g, ctx, laneOf(ty))})` : `${ty}(${[0, 1, 2, 3].map(() => leaf(g, ctx, laneOf(ty))).join(', ')})`
    case 'u32x8': return g.bool() ? `splat_u32x8(${leaf(g, ctx, 'u32')})` : `u32x8(${[0, 1, 2, 3, 4, 5, 6, 7].map(() => leaf(g, ctx, 'u32')).join(', ')})`
    case '[i32; 4]': return g.bool() ? `[${leaf(g, ctx, 'i32')}; 4]` : `[${[0, 1, 2, 3].map(() => leaf(g, ctx, 'i32')).join(', ')}]`
    case 'col<f32>': return g.pick(['crowd.x', 'crowd.z', 'cars.speed', 'cars.x', 'cars.z', 'cars.heading'])
  }
}

function call(g: Gen, ctx: Ctx, ret: Ty | 'void', d: number): string | null {
  const fns = ctx.fns.filter((f) => f.ret === ret)
  if (fns.length === 0) return null
  const f = g.pick(fns)
  return `${f.name}(${f.params.map((p) => expr(g, ctx, p, d - 1)).join(', ')})`
}

/** The columns a `query` puts in scope as the row's scalars. */
const QUERY_COLS: Readonly<Record<'crowd' | 'cars', readonly Var[]>> = {
  crowd: [{ name: 'x', ty: 'f32', mut: false }, { name: 'z', ty: 'f32', mut: false }],
  cars: [{ name: 'x', ty: 'f32', mut: false }, { name: 'z', ty: 'f32', mut: false }, { name: 'speed', ty: 'f32', mut: false }, { name: 'heading', ty: 'f32', mut: false }, { name: 'mode', ty: 'i32', mut: false }],
}

function query(g: Gen, ctx: Ctx, d: number): string {
  const table = g.pick(['crowd', 'cars'] as const)
  const inner: Ctx = { ...child(ctx), vars: [...ctx.vars, ...QUERY_COLS[table]] }
  return `query ${table} where ${expr(g, inner, 'bool', d - 1)}`
}

/** An expression of type `ty`, mostly well typed; a few percent carry a fault so the checker is exercised too. */
function expr(g: Gen, ctx: Ctx, ty: Ty, d: number): string {
  if (g.bool(0.04)) return g.bool() ? expr(g, ctx, g.pick(TYPES), 0) : g.pick(['nothing', 'crowd', 'min', 'print', '"str"', 'ty', 'x4'])
  if (d <= 0 || g.bool(0.3)) return leaf(g, ctx, ty)
  const sub = (t: Ty): string => expr(g, ctx, t, d - 1)
  const roll = g.next()
  const maybeCall = roll > 0.92 ? call(g, ctx, ty, d) : null
  if (maybeCall !== null) return maybeCall
  if (roll > 0.88) return `if ${sub('bool')} { ${sub(ty)} } else { ${sub(ty)} }`
  switch (ty) {
    case 'i32':
      switch (g.int(0, 11)) {
        case 0: return `(${sub('i32')} ${g.pick(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])} ${sub('i32')})`
        case 1: return `-(${sub('i32')})`
        case 2: return `(${sub(g.pick(['u32', 'f32', 'bool']))}) as i32`
        case 3: return `${g.pick(['min', 'max'])}(${sub('i32')}, ${sub('i32')})`
        case 4: return g.bool() ? `abs(${sub('i32')})` : `clamp(${sub('i32')}, ${sub('i32')}, ${sub('i32')})`
        case 5: return `select(mask(${sub('bool')}), ${sub('i32')}, ${sub('i32')})`
        case 6: return `${sub('[i32; 4]')}[${sub('i32')}]`
        case 7: return `hsum(${sub('i32x4')})`
        case 8: return g.pick(['crowd.n', 'cars.n', 'kernel.law1', 'kernel.law2', 'kernel.law3', 'kernel.flips', 'cars.mode[0]', `cars.mode[${sub('i32')}]`])
        case 9: return query(g, ctx, d)
        case 10: return `${sub(g.pick(['[i32; 4]', 'f32x4', 'u32x8', 'col<f32>']))}.len()`
        default: return `(popcount(${sub('u32')}) as i32)`
      }
    case 'u32':
      switch (g.int(0, 8)) {
        case 0: return `(${sub('u32')} ${g.pick(['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])} ${sub('u32')})`
        case 1: return `(${sub(g.pick(['i32', 'f32', 'bool']))}) as u32`
        case 2: return `${g.pick(['popcount', 'clz', 'ctz', 'demorton2x', 'demorton2y'])}(${sub('u32')})`
        case 3: return `${g.pick(['rotl', 'rotr', 'morton2', 'min', 'max'])}(${sub('u32')}, ${sub('u32')})`
        case 4: return `mask(${sub('bool')})`
        case 5: return `hsum(${sub(g.pick(['u32x4', 'u32x8']))})`
        case 6: return `select(mask(${sub('bool')}), ${sub('u32')}, ${sub('u32')})`
        case 7: return `${sub(g.pick(['u32x4', 'u32x8']))}[${sub('i32')}]`
        default: return `clamp(${sub('u32')}, ${sub('u32')}, ${sub('u32')})`
      }
    case 'f32':
      switch (g.int(0, 9)) {
        case 0: return `(${sub('f32')} ${g.pick(['+', '-', '*', '/', '%'])} ${sub('f32')})`
        case 1: return `-(${sub('f32')})`
        case 2: return `(${sub(g.pick(['i32', 'u32']))}) as f32`
        case 3: return `${g.pick(['sqrt', 'floor', 'ceil', 'trunc', 'abs'])}(${sub('f32')})`
        case 4: return g.bool() ? `${g.pick(['min', 'max'])}(${sub('f32')}, ${sub('f32')})` : `clamp(${sub('f32')}, ${sub('f32')}, ${sub('f32')})`
        case 5: return `hsum(${sub('f32x4')})`
        case 6: return `${sub('f32x4')}${g.pick(['.x', '.y', '.z', '.w', `[${sub('i32')}]`])}`
        case 7: return g.pick(['frame.fps', 'frame.ms', 'frame.p95', `crowd.x[${sub('i32')}]`, `cars.speed[${sub('i32')}]`, `${sub('col<f32>')}[${sub('i32')}]`])
        case 8: return `select(mask(${sub('bool')}), ${sub('f32')}, ${sub('f32')})`
        default: return g.pick(['tune', 'steer']) === 'tune' ? `tune("k${g.int(0, 3)}", ${sub('f32')})` : g.bool() ? `cull(${sub('f32')})` : `steer("f${g.int(0, 3)}", ${sub('f32')})`
      }
    case 'bool':
      switch (g.int(0, 6)) {
        case 0: { const t = g.pick(['i32', 'u32', 'f32'] as const); return `(${sub(t)} ${g.pick(['<', '<=', '>', '>=', '==', '!='])} ${sub(t)})` }
        case 1: return `(${sub('bool')} ${g.pick(['&&', '||', '==', '!='])} ${sub('bool')})`
        case 2: return `!${sub('bool')}`
        case 3: { const v = g.pick(VECTORS); return `${g.pick(['any', 'all'])}(${g.pick(['vlt', 'vle', 'vgt', 'vge', 'veq', 'vne'])}(${sub(v)}, ${sub(v)}))` }
        case 4: return 'kernel.shielded'
        case 5: return `intent(${sub('i32')}, ${sub('f32')}, ${sub('f32')}, ${sub('f32')})`
        default: return `(${sub('bool')} == ${sub('bool')})`
      }
    case 'f32x4': case 'i32x4': case 'u32x4': case 'u32x8': {
      const lane = laneOf(ty)
      switch (g.int(0, 8)) {
        case 0: return `(${sub(ty)} ${g.pick(ty === 'f32x4' ? ['+', '-', '*', '/', '%'] : ['+', '-', '*', '/', '%', '&', '|', '^', '<<', '>>'])} ${sub(ty)})`
        case 1: return ty === 'u32x4' || ty === 'u32x8' ? `~${sub(ty)}` : `-${sub(ty)}`
        case 2: return `${g.pick(['min', 'max'])}(${sub(ty)}, ${sub(ty)})`
        case 3: return ty === 'f32x4' ? `${g.pick(['sqrt', 'abs'])}(${sub(ty)})` : ty === 'i32x4' ? `abs(${sub(ty)})` : `${sub(ty)} ${g.pick(['<<', '>>'])} ${g.int(0, 40)}`
        case 4: { const m = ty === 'u32x8' ? 'u32x8' : g.pick(['f32x4', 'i32x4', 'u32x4']) as Ty; return `select(${g.pick(['vlt', 'vle', 'vgt', 'vge', 'veq', 'vne'])}(${sub(m)}, ${sub(m)}), ${sub(ty)}, ${sub(ty)})` }
        case 5: return ty === 'u32x8' ? `(${sub('u32x8')}) as u32x8` : `(${sub(g.pick(['f32x4', 'i32x4', 'u32x4']))}) as ${ty}`
        case 6: return ty === 'f32x4' ? `load_f32x4(${sub('col<f32>')}, ${sub('i32')})` : ty === 'i32x4' ? `load_i32x4(cars.mode, ${sub('i32')})` : `splat_${ty}(${sub(lane)})`
        case 7: return INT_VECTORS.includes(ty) ? `(${sub(ty)} ${g.pick(['&', '|', '^'])} splat_${ty}(${sub(lane)}))` : `splat_f32x4(${sub('f32')})`
        default: return leaf(g, ctx, ty)
      }
    }
    case '[i32; 4]': return g.bool() ? `[${sub('i32')}, ${sub('i32')}, ${sub('i32')}, ${sub('i32')}]` : `[${sub('i32')}; 4]`
    case 'col<f32>': return leaf(g, ctx, ty)
  }
}

function block(g: Gen, ctx: Ctx, d: number, extra: Partial<Pick<Ctx, 'loop' | 'ret'>> = {}, lead = ''): string {
  const inner = child(ctx, extra)
  const n = g.int(0, d > 0 ? 4 : 2)
  const lines: string[] = lead === '' ? [] : [lead]
  for (let i = 0; i < n; i++) lines.push(stmt(g, inner, d - 1))
  return `{ ${lines.join(' ')} }`
}

const fresh = (ctx: Ctx): string => `v${ctx.names.n++}`

function stmt(g: Gen, ctx: Ctx, d: number): string {
  const roll = g.next()
  if (roll < 0.25) {
    const ty = g.bool(0.6) ? g.pick(SCALARS) : g.pick(TYPES)
    const name = fresh(ctx)
    const mut = g.bool(0.6)
    const src = `let ${mut ? 'mut ' : ''}${name}${g.bool(0.3) ? `: ${ty}` : ''} = ${expr(g, ctx, ty, d)};`
    ctx.vars.push({ name, ty, mut })
    return src
  }
  if (roll < 0.4) {
    const muts = ctx.vars.filter((v) => v.mut)
    const v = muts.length > 0 ? g.pick(muts) : g.pick(ctx.vars.length > 0 ? ctx.vars : [{ name: 'ghost', ty: 'i32', mut: false } as Var])
    if (v.ty === '[i32; 4]' && g.bool(0.7)) return `${v.name}[${expr(g, ctx, 'i32', 1)}] ${g.pick(['=', '+=', '-=', '*=', '<<='])} ${expr(g, ctx, 'i32', d)};`
    if (isVector(v.ty) && g.bool(0.5)) return `${v.name}[${expr(g, ctx, 'i32', 1)}] = ${expr(g, ctx, laneOf(v.ty), d)};`
    const ops = v.ty === 'bool' || v.ty === '[i32; 4]' || v.ty === 'col<f32>' ? ['='] : v.ty === 'f32' || v.ty === 'f32x4' ? ['=', '+=', '-=', '*=', '/=', '%='] : ['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']
    return `${v.name} ${g.pick(ops)} ${expr(g, ctx, v.ty, d)};`
  }
  if (roll < 0.5) {
    const chain = g.bool(0.3) ? ` else if ${expr(g, ctx, 'bool', d)} ${block(g, ctx, d)}` : ''
    return `if ${expr(g, ctx, 'bool', d)} ${block(g, ctx, d)}${chain}${g.bool(0.5) ? ` else ${block(g, ctx, d)}` : ''}`
  }
  if (roll < 0.58) {
    const c = fresh(ctx)
    ctx.vars.push({ name: c, ty: 'i32', mut: true })
    return `let mut ${c} = 0; while ${c} < ${g.int(0, 50)} ${block(g, ctx, d, { loop: true }, `${c} += 1;`)}`
  }
  if (roll < 0.64) {
    const i = fresh(ctx)
    const inner = child(ctx, { loop: true })
    inner.vars.push({ name: i, ty: 'i32', mut: false })
    return `for ${i} in ${expr(g, ctx, 'i32', 1)}${g.bool(0.3) ? '..=' : '..'}${expr(g, ctx, 'i32', 1)} ${block(g, inner, d)}`
  }
  if (roll < 0.68) return `loop ${block(g, ctx, d, { loop: true }, g.bool(0.8) ? `if ${expr(g, ctx, 'bool', 1)} { break; }` : '')}`
  if (roll < 0.73) return ctx.loop || g.bool(0.1) ? g.pick(['break;', 'continue;']) : `print(${expr(g, ctx, 'i32', d)});`
  if (roll < 0.78) {
    if (ctx.ret === null) return g.bool(0.1) ? 'return;' : `print(${expr(g, ctx, 'bool', d)});`
    return ctx.ret === 'void' ? 'return;' : `return ${expr(g, ctx, ctx.ret, d)};`
  }
  if (roll < 0.9) {
    const n = g.int(0, 3)
    const args: string[] = []
    for (let i = 0; i < n; i++) args.push(g.bool(0.15) ? g.pick(['"text"', '"tab\\tnl\\n"', '"q\\"q"']) : expr(g, ctx, g.pick(TYPES), d))
    return `${g.pick(['print', 'println'])}(${args.join(', ')});`
  }
  if (roll < 0.95) {
    const c = call(g, ctx, g.pick(['void', ...TYPES] as const), d)
    return c === null ? `${expr(g, ctx, g.pick(SCALARS), d)};` : `${c};`
  }
  return block(g, ctx, d)
}

function fnDecl(g: Gen, ctx: Ctx, i: number): string {
  const params: Var[] = []
  for (let k = g.int(0, 2); k > 0; k--) params.push({ name: `p${params.length}`, ty: g.pick(TYPES), mut: false })
  const ret: Ty | 'void' = g.bool(0.75) ? g.pick(TYPES) : 'void'
  ctx.fns.push({ name: `f${i}`, params: params.map((p) => p.ty), ret })
  const inner: Ctx = { vars: [...params], fns: ctx.fns, loop: false, ret, names: ctx.names }
  const body: string[] = []
  for (let k = g.int(0, 3); k > 0; k--) body.push(stmt(g, inner, 1))
  const tail = ret === 'void' ? (g.bool(0.3) ? 'print(0)' : '') : expr(g, inner, ret, 2)
  return `fn f${i}(${params.map((p) => `${p.name}: ${p.ty}`).join(', ')})${ret === 'void' ? '' : ` -> ${ret}`} { ${body.join(' ')} ${tail} }`
}

/** One grammar-shaped program; one in twenty is then mangled a little so the parser meets near misses too. */
function program(g: Gen): string {
  const ctx: Ctx = { vars: [], fns: [], loop: false, ret: null, names: { n: 0 } }
  const parts: string[] = []
  for (let i = g.int(0, 2); i > 0; i--) parts.push(fnDecl(g, ctx, parts.length))
  for (let i = g.int(1, 6); i > 0; i--) parts.push(stmt(g, ctx, 2))
  let src = parts.join(g.bool(0.3) ? '\n' : ' ')
  if (g.bool(0.05) && src.length > 2) {
    const at = g.int(0, src.length - 1)
    src = g.bool() ? src.slice(0, at) + src.slice(at + 1) : src.slice(0, at) + g.pick([...OPS, ...JUNK, ...KEYWORDS]) + src.slice(at)
  }
  return src
}

// ---------------------------------------------------------------------------------------------------
// Random hosts

/** The data of a random host; two hosts built from it behave identically, so a twin session can be compared. */
interface HostData {
  readonly kind: 'none' | 'undefined' | 'throwing' | 'tables'
  readonly tables: NoirTables
  readonly write: boolean
  readonly writeThrows: boolean
  readonly locked: string | undefined
  readonly answer: number
}

function hostData(g: Gen): HostData {
  const roll = g.next()
  const kind: HostData['kind'] = roll < 0.15 ? 'none' : roll < 0.25 ? 'undefined' : roll < 0.33 ? 'throwing' : 'tables'
  const odd = (): number => (g.bool(0.1) ? g.pick([Number.NaN, Infinity, -Infinity, 1e38, -0]) : g.next() * 200 - 100)
  const column = (n: number): Float32Array => Float32Array.from({ length: n }, odd)
  const len = (): number => g.pick([0, 1, 4, 10])
  const n = (): number => g.pick([0, 1, 4, 10, -1, Number.NaN, 2.5, 100])
  const ca = len()
  const tables: NoirTables = {
    crowd: { n: n(), x: column(len()), z: column(len()) },
    cars: { n: n(), x: column(ca), z: column(ca), heading: column(ca), speed: column(ca), mode: Int32Array.from({ length: ca }, () => g.int(0, 2)) },
    kernel: { law1: g.int(-5, 5), law2: g.int(0, 3), law3: g.int(0, 3), flips: g.int(0, 1000), shielded: g.bool() },
    frame: { fps: odd(), ms: odd(), p95: odd() },
  }
  return { kind, tables, write: g.bool(0.5), writeThrows: g.bool(0.2), locked: g.bool(0.3) ? g.pick(['no writes here', '']) : undefined, answer: g.next() * 10 - 5 }
}

function host(d: HostData): NoirHost | null | undefined {
  if (d.kind === 'none') return null
  if (d.kind === 'undefined') return undefined
  if (d.kind === 'throwing') return { tables: () => { throw new Error('tables unavailable') } }
  const h: { tables(): NoirTables; write?: NoirHost['write']; locked?: string } = { tables: () => d.tables }
  if (d.locked !== undefined) h.locked = d.locked
  if (d.write) {
    const answer = (): number => { if (d.writeThrows) throw new Error('write refused'); return d.answer }
    h.write = { tune: answer, intent: () => answer() > 0, cull: answer, steer: answer }
  }
  return h
}

// ---------------------------------------------------------------------------------------------------
// The properties

function runNever(s: NoirSession, src: string, h: NoirHost | null | undefined): NoirResult {
  try {
    return s.run(src, h, FUZZ_LIMITS)
  } catch (e) {
    return assert.fail(`run threw ${e instanceof Error ? e.message : String(e)} on ${JSON.stringify(src)}`)
  }
}

function wellFormed(r: NoirResult, src: string): void {
  const why = JSON.stringify(src)
  assert.ok(Array.isArray(r.out), why)
  for (const line of r.out) assert.equal(typeof line, 'string', why)
  assert.ok(Number.isInteger(r.steps) && r.steps >= 0 && r.steps <= FUZZ_LIMITS.steps, `${r.steps} steps on ${why}`)
  assert.ok(Array.isArray(r.defined), why)
  if (r.error !== undefined) {
    assert.equal(typeof r.error, 'string', why)
    assert.ok(!r.error.startsWith('internal error'), `${r.error} on ${why}`)
  }
}

function usable(s: NoirSession, src: string): void {
  const u = s.run('print(1);', null, FUZZ_LIMITS)
  assert.deepEqual([u.out, u.error], [['1'], undefined], `the session is not usable after ${JSON.stringify(src)}`)
}

/** Runs `cases` sources from `make` on a session and its twin (renewed every 50 cases), checking every property. */
function property(name: string, seed: number, cases: number, make: (g: Gen) => string): { ran: number; failed: number; printed: number } {
  const g = gen(seed)
  let s = new NoirSession(FUZZ_LIMITS)
  let twin = new NoirSession(FUZZ_LIMITS)
  let failed = 0
  let printed = 0
  for (let i = 0; i < cases; i++) {
    if (i % 50 === 0) { s = new NoirSession(FUZZ_LIMITS); twin = new NoirSession(FUZZ_LIMITS) }
    const src = make(g)
    const data = hostData(g)
    let r: NoirResult
    let r2: NoirResult
    try {
      r = runNever(s, src, host(data))
      r2 = runNever(twin, src, host(data))
      wellFormed(r, src)
      assert.deepEqual(r2, r, `the twin session disagrees on ${JSON.stringify(src)}`)
      const listing = s.asm(src)
      assert.ok(Array.isArray(listing.out) && (listing.error === undefined ? listing.out.length > 0 : listing.out.length === 0), `asm on ${JSON.stringify(src)}`)
      usable(s, src)
    } catch (e) {
      throw new Error(`property '${name}' failed on case ${i} of seed ${seed}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
    }
    if (r.error !== undefined) failed++
    printed += r.out.length
  }
  return { ran: cases, failed, printed }
}

test('token soup: 1200 seeded lines never throw out of run or asm, never pass the step budget, and leave the session usable', () => {
  const r = property('soup', 0xc0ffee, 1200, soup)
  assert.equal(r.ran, 1200)
  assert.ok(r.failed > 1000, `${r.failed} of the soups failed to compile, as soup should`)
})

test('grammar-shaped programs: 1200 seeded programs never throw, never pass the step budget, agree with a twin session, and leave the session usable', () => {
  const r = property('grammar', 0x110, 1200, program)
  assert.equal(r.ran, 1200)
  assert.ok(r.failed < 1100, `${r.failed} of 1200 failed: the generator should mostly produce programs that compile`)
  assert.ok(r.failed > 100, `${r.failed} of 1200 failed: the faults should reach the checker and the VM`)
  assert.ok(r.printed > 500, `${r.printed} lines printed: the programs should run`)
})

test('adversarial shapes: deep nesting, long lines, odd characters and runaway programs are all error text or output, never a throw', () => {
  const s = new NoirSession(FUZZ_LIMITS)
  const cases = [
    `print(${'('.repeat(5000)}1${')'.repeat(5000)});`,
    `print(${'-'.repeat(20000)}1);`,
    '{'.repeat(5000) + '}'.repeat(5000),
    `let q = ${'['.repeat(3000)}1${']'.repeat(3000)};`,
    `print(${'abs('.repeat(3000)}1${')'.repeat(3000)});`,
    `let t: ${'['.repeat(400)}i32${'; 1]'.repeat(400)} = 1;`,
    `if true ${'{ if true '.repeat(300)}{ }${' }'.repeat(300)}`,
    `print(${Array(3000).fill('1').join(' + ')});`,
    `print(${Array(2000).fill('1').join(', ')});`,
    ' '.repeat(100_000),
    'x'.repeat(100_000),
    `print(${'"a'.repeat(50)});`,
    '"\u0000ÿ\ud800"',
    'let é = 1;',
    'print(1);\r\nprint(2);\r\n',
    '/*'.repeat(100),
    'fn f() -> i32 { f() } print(f());',
    'loop { let a = [0; 1000]; }',
    'let mut i = 0u; loop { i += 1u; if i == 0u { break; } }',
    'for i in -2147483648..2147483647 { }',
    'fn f(a: [i32; 1048576]) { } f([0; 1048576]);',
    'let a = [[0; 1024]; 1024]; print(a[0][0]);',
    'print([0; 1048576].len(), [[0; 1048576]; 1048576].len());',
    `fn f(${Array.from({ length: 200 }, (_, i) => `p${i}: i32`).join(', ')}) -> i32 { p0 } print(f(${Array(200).fill('1').join(', ')}));`,
    `print(${Array.from({ length: 300 }, (_, i) => `(${i} as f32)`).join(' + ')});`,
    `if true { } ${'else if true { } '.repeat(5000)}`,
    `let x = if true { 1 } ${'else if true { 1 } '.repeat(3000)}else { 2 };`,
    `let mut q = 0; ${'q = q + 1; '.repeat(3000)}print(q);`,
  ]
  for (const src of cases) {
    const r = runNever(s, src, null)
    wellFormed(r, src)
    usable(s, src)
    assert.deepEqual(runNever(new NoirSession(FUZZ_LIMITS), src, null), r, 'deterministic')
  }
  assert.equal(s.run(cases[0]!, null, FUZZ_LIMITS).error, '1:262: nesting deeper than 256 levels')
  assert.equal(s.run(cases[16]!, null, FUZZ_LIMITS).error, 'stack overflow (depth 64)')
  assert.equal(s.run(cases[18]!, null, FUZZ_LIMITS).error, 'step budget exhausted (20000)')
  assert.equal(s.run(cases[20]!, null, FUZZ_LIMITS).error, 'memory exhausted')
  assert.match(s.run(cases[7]!, null, FUZZ_LIMITS).error ?? '', /^1:\d+: nesting deeper than 256 levels$/, 'a long left-leaning chain is as deep as a nest')
  assert.deepEqual(s.run(`print(${Array(200).fill('1').join(' + ')});`, null, FUZZ_LIMITS).out, ['200'], 'two hundred terms are fine')
  assert.match(s.run(cases[25]!, null, FUZZ_LIMITS).error ?? '', /nesting deeper than 256 levels$/)
  assert.deepEqual(s.run(cases[27]!, null, FUZZ_LIMITS).out, ['3000'], 'three thousand statements in a row are not nesting')
})

test('random hosts: tables with odd counts, lengths and values, writes that throw, and no host at all never throw out of run', () => {
  const g = gen(99)
  const s = new NoirSession(FUZZ_LIMITS)
  const probes = [
    'print(crowd.n, cars.n, kernel.law1, kernel.shielded, frame.fps, frame.ms, frame.p95, crowd.x, cars.mode);',
    'let mut t = 0.0; for i in 0..crowd.n { t += crowd.x[i] + crowd.z[i]; } print(t, query crowd where x > z);',
    'let mut acc = splat_f32x4(0.0); let mut i = 0; while i < cars.n { acc = acc + load_f32x4(cars.speed, i); i += 4; } print(acc, load_i32x4(cars.mode, 1), query cars where mode == 1 && speed > 0.0);',
    'print(tune("k", 1.0), intent(0, 0.5, 0.0, 0.0), cull(0.5), steer("s", -1.0));',
    'print(cars.speed[cars.n - 1], crowd.x[0]);',
  ]
  for (let i = 0; i < 400; i++) {
    const data = hostData(g)
    const src = g.pick(probes)
    const r = runNever(s, src, host(data))
    wellFormed(r, src)
    assert.deepEqual(runNever(new NoirSession(FUZZ_LIMITS), src, host(data)), r)
    if (data.kind === 'throwing') assert.equal(r.error, 'tables unavailable')
    if (data.kind === 'none' && src === probes[0]) assert.deepEqual(r.out, ['0 0 0 false 0 0 0 col<f32>[0] col<i32>[0]'])
  }
  usable(s, 'random hosts')
  assert.deepEqual(s.run(probes[0]!, { tables: () => EMPTY_TABLES }, FUZZ_LIMITS).out, ['0 0 0 false 0 0 0 col<f32>[0] col<i32>[0]'])
})
