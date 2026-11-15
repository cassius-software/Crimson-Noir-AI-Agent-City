// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the binary form of Lens. A small module's words are written out by hand from the
 * layout in binary.ts and compared word for word, and every opcode and code table is pinned. A seeded generator
 * writes random valid modules through the builder, using every op, every resource kind and every port rule; each
 * must decode to a module deep-equal to itself and encode back to the same words. Then thousands of truncations,
 * bit flips, replaced, inserted and deleted words and random arrays are decoded: each must be refused with a Fault
 * of code `lens`, or decode to a module that encodes back to exactly those words (and that verify() and the
 * disassembler handle without anything but a lens Fault). Every structural refusal of decode and encode has its case.
 * What breaks if it is removed? The stored form of every shader could drift from the live one, a malformed binary
 * from an app or an agent could crash the device or be misread, and nothing would notice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode, looksLikeLens } from './binary.ts'
import { LensBuilder, arrayOf, lens } from './builder.ts'
import type { BlockRes, ImageRes, Out, PathStep, SamplerRes, StorageImageRes, Val, Var } from './builder.ts'
import { disassemble } from './disasm.ts'
import { isFault } from './fault.ts'
import { FORMATS, FORMAT_NAMES } from './formats.ts'
import type { Format } from './formats.ts'
import {
  BINARY, BUILTINS, DERIVATIVES, LENS_LIMITS, LENS_MAGIC, LENS_VERSION, TERNARY, UNARY, VALUE_TYPES, boolOf, columnOf, componentsOf,
  isGrid, isVector, scalarOf, vectorOf, widthOf,
} from './lens.ts'
import type { BinaryFn, Inst, LensModule, Op, Scalar, Stage, TernaryFn, UnaryFn, ValueType, Width } from './lens.ts'
import { putType, verify } from './verify.ts'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

/** A seeded generator of numbers in [0, 1): the same seed gives the same run on every machine. */
function lcg(seed: number): () => number {
  // The seed is mixed first, so that nearby seeds do not start on nearby numbers.
  let s = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b) >>> 0
  s = Math.imul(s ^ (s >>> 16), 0x45d9f3b) >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

function refused(f: () => unknown, re: RegExp): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(isFault(e, 'lens'), `expected a lens Fault, got ${String(e)}`)
    assert.match(e.message, re)
    return true
  })
}

// ---------------------------------------------------------------------------------------------------
// A generator of random valid modules

const NUMERIC = VALUE_TYPES.filter((t) => !isGrid(t) && scalarOf(t) !== 'bool')
const FLOATS: readonly ValueType[] = ['f32', 'f32x2', 'f32x3', 'f32x4']
const FLOAT_VECTORS: readonly ValueType[] = ['f32x2', 'f32x3', 'f32x4']
const INTEGERS = NUMERIC.filter((t) => scalarOf(t) !== 'f32')
const SIGNED = NUMERIC.filter((t) => scalarOf(t) !== 'u32')
const BOOLS: readonly ValueType[] = ['bool', 'boolx2', 'boolx3', 'boolx4']
const VECTORS = VALUE_TYPES.filter(isVector)
const GRIDS: readonly ValueType[] = ['m2', 'm3', 'm4']
const PLAIN = VALUE_TYPES.filter((t) => !isGrid(t))
const KINDS: readonly Scalar[] = ['f32', 'i32', 'u32', 'bool']
const STORAGE_FORMATS = FORMAT_NAMES.filter((f) => FORMATS[f].storage)

class Gen {
  readonly r: () => number
  readonly stage: Stage
  readonly b: LensBuilder
  private readonly scopes: Val[][] = [[]]
  private readonly vars: Var[][] = [[]]
  private depth = 0
  private inLoop = false
  private returned = false
  private readonly inputs: number[] = []
  private readonly outs: Out[] = []
  private readonly u: BlockRes
  private readonly sb: BlockRes
  private readonly k: BlockRes
  private readonly img: ImageRes
  private readonly fimg: ImageRes
  private readonly smp: SamplerRes
  private readonly si: StorageImageRes

  constructor(seed: number) {
    this.r = lcg(seed)
    this.stage = (['vertex', 'fragment', 'compute'] as const)[seed % 3]
    this.b = lens(this.stage, this.stage === 'compute' ? { group: [1 + this.int(16), 1 + this.int(8), 1 + this.int(2)] } : undefined)
    const b = this.b
    this.u = b.uniform(0, 0, { a: 'f32x4', g: 'm4', list: arrayOf('i32x4', 3), s: { p: 'f32x2', q: 'u32' } })
    this.sb = b.storage(0, 1, { n: 'u32', items: arrayOf({ v: 'f32x3', k: 'i32' }) }, { writable: this.stage !== 'vertex' })
    this.k = b.constants({ scale: 'f32', off: 'f32x2' })
    this.img = b.image(1, 0, { sample: this.one(['float', 'uint', 'sint', 'depth'] as const), dims: this.one(['2d', '2d-array'] as const) })
    this.fimg = b.image(1, 1, { dims: this.one(['2d', '2d-array'] as const) })
    this.smp = b.sampler(1, 2)
    this.si = b.storageImage(2, 0, this.one(STORAGE_FORMATS))
    if (this.stage !== 'compute') {
      this.ports('inputs')
      this.ports('outputs')
    }
  }

  int(n: number): number {
    return Math.floor(this.r() * n)
  }

  one<T>(xs: readonly T[]): T {
    return xs[this.int(xs.length)]
  }

  private ports(side: 'inputs' | 'outputs'): void {
    const slots = Array.from({ length: 16 }, (_, i) => i)
    const n = this.int(4)
    for (let i = 0; i < n; i++) {
      const slot = slots.splice(this.int(slots.length), 1)[0]
      const t = this.one(NUMERIC)
      const between = (this.stage === 'vertex' && side === 'outputs') || (this.stage === 'fragment' && side === 'inputs')
      const float = scalarOf(t) === 'f32'
      const opts = between ? (float ? this.one([undefined, { flat: true }, { flat: false }]) : this.one([undefined, { flat: true }])) : this.one([undefined, { flat: false }])
      if (side === 'inputs') {
        this.keep(this.b.input(slot, t, opts))
        this.inputs.push(slot)
      } else this.outs.push(this.b.output(slot, t, opts))
    }
  }

  private keep(v: Val): Val {
    this.scopes[this.scopes.length - 1].push(v)
    return v
  }

  /** A value of type t: one in scope, or a new literal. */
  of(t: ValueType): Val {
    if (this.r() < 0.6) {
      const known = this.scopes.flat().filter((v) => v.t === t)
      if (known.length > 0) return this.one(known)
    }
    return this.literal(t)
  }

  private literal(t: ValueType): Val {
    const k = scalarOf(t)
    const comps = Array.from({ length: componentsOf(t) }, () => {
      if (k === 'bool') return this.r() < 0.5
      if (k === 'f32') return this.one([0, 1, -1, 0.5, -0, 3.25, 1e-30, 65504, 2 ** -149, this.r() * 1000 - 500])
      if (k === 'i32') return this.one([0, 1, -1, 0x7fffffff, -0x80000000, this.int(2000) - 1000])
      return this.one([0, 1, 0xffffffff, this.int(5000)])
    })
    return this.keep(this.b.lit(t, ...comps))
  }

  private index(len: number): PathStep {
    return this.r() < 0.5 ? this.int(len) : this.of(this.one(['i32', 'u32'] as const))
  }

  private binaryArgs(fn: BinaryFn): [ValueType, ValueType] {
    switch (fn) {
      case 'add': case 'sub': case 'mul': case 'div': case 'rem': {
        const roll = this.int(fn === 'mul' ? 8 : fn === 'add' || fn === 'sub' ? 5 : 4)
        const t = this.one(NUMERIC)
        if (roll === 1 && isVector(t)) return [t, scalarOf(t)]
        if (roll === 2 && isVector(t)) return [scalarOf(t), t]
        if (roll < 4) return [t, t]
        const m = this.one(GRIDS)
        if (roll === 4) return [m, m]
        if (roll === 5) return [m, columnOf(m as 'm2')]
        if (roll === 6) return [columnOf(m as 'm2'), m]
        return [m, 'f32']
      }
      case 'min': case 'max': case 'lt': case 'le': case 'gt': case 'ge': { const t = this.one(NUMERIC); return [t, t] }
      case 'pow': case 'atan2': case 'step': case 'distance': { const t = this.one(FLOATS); return [t, t] }
      case 'and': case 'or': case 'xor': { const t = this.one([...INTEGERS, ...BOOLS]); return [t, t] }
      case 'shl': case 'shr': { const t = this.one(INTEGERS); return [t, vectorOf('u32', widthOf(t))] }
      case 'eq': case 'ne': { const t = this.one(PLAIN); return [t, t] }
      case 'land': case 'lor': { const t = this.one(BOOLS); return [t, t] }
      case 'dot': { const t = this.one(VECTORS.filter((v) => scalarOf(v) !== 'bool')); return [t, t] }
      case 'cross': return ['f32x3', 'f32x3']
      case 'reflect': { const t = this.one(FLOAT_VECTORS); return [t, t] }
    }
  }

  private unaryArg(fn: UnaryFn): ValueType {
    switch (fn) {
      case 'neg': case 'sign': return this.one(SIGNED)
      case 'not': case 'any': case 'all': return this.one(BOOLS)
      case 'bitnot': return this.one(INTEGERS)
      case 'abs': return this.one(NUMERIC)
      case 'normalize': return this.one(FLOAT_VECTORS)
      case 'transpose': return this.one(GRIDS)
      default: return this.one(FLOATS)
    }
  }

  private ternaryArgs(fn: TernaryFn): [ValueType, ValueType, ValueType] {
    switch (fn) {
      case 'mix': { const t = this.one(FLOATS); return [t, t, this.r() < 0.5 ? t : 'f32'] }
      case 'clamp': { const t = this.one(NUMERIC); return [t, t, t] }
      case 'smoothstep': case 'fma': { const t = this.one(FLOATS); return [t, t, t] }
      case 'choose': { const t = this.one(VALUE_TYPES); return [isVector(t) && this.r() < 0.5 ? boolOf(t) : 'bool', t, t] }
    }
  }

  /** The ops that may be emitted here, each with how to emit it. */
  private moves(): (() => void)[] {
    const b = this.b
    const rate = this.stage === 'fragment' && this.depth === 0 && !this.returned
    const vars = this.vars.flat()
    const moves: (() => void)[] = [
      () => this.literal(this.one(VALUE_TYPES)),
      () => { const fn = this.one(UNARY); this.keep(b.unary(fn, this.of(this.unaryArg(fn)))) },
      () => { const fn = this.one(BINARY); const [x, y] = this.binaryArgs(fn); this.keep(b.binary(fn, this.of(x), this.of(y))) },
      () => { const fn = this.one(TERNARY); const [x, y, z] = this.ternaryArgs(fn); this.keep(b.ternary(fn, this.of(x), this.of(y), this.of(z))) },
      () => this.make(),
      () => { const v = this.of(this.one(VECTORS)); this.keep(b.pick(v, Array.from({ length: 1 + this.int(4) }, () => this.int(widthOf(v.t))))) },
      () => this.keep(b.lane(this.of(this.one(VECTORS)), this.of(this.one(['i32', 'u32'] as const)))),
      () => { const g = this.of(this.one(GRIDS)); this.keep(b.column(g, this.int(widthOf(g.t)))) },
      () => { const v = this.of(this.one(PLAIN)); this.keep(b.cast(v, vectorOf(this.one(KINDS.filter((k) => k !== scalarOf(v.t))), widthOf(v.t)))) },
      () => { const v = this.of(this.one(NUMERIC)); this.keep(b.bits(v, vectorOf(this.one(KINDS.filter((k) => k !== scalarOf(v.t) && k !== 'bool')), widthOf(v.t)))) },
      () => this.keep(b.builtin(this.one(Object.keys(BUILTINS).filter((n) => BUILTINS[n as keyof typeof BUILTINS].stage === this.stage)) as never)),
      () => this.read(),
      () => {
        const layer = this.img.dims === '2d-array' ? { layer: this.of(this.one(['i32', 'u32'] as const)) } : {}
        this.keep(b.texel(this.img, this.of(this.one(['i32x2', 'u32x2'] as const)), this.r() < 0.5 ? layer : { ...layer, level: this.of(this.one(['i32', 'u32'] as const)) }))
      },
      () => {
        const layer = this.fimg.dims === '2d-array' ? { layer: this.of(this.one(['i32', 'u32'] as const)) } : {}
        this.keep(b.sample(this.fimg, this.smp, this.of('f32x2'), rate && this.r() < 0.5 ? layer : { ...layer, level: this.of('f32') }))
      },
      () => this.keep(this.r() < 0.5 ? b.extent(this.si) : b.extent(this.img, this.r() < 0.5 ? undefined : this.of(this.one(['i32', 'u32'] as const)))),
      () => { const t = this.one(VALUE_TYPES); this.vars[this.vars.length - 1].push(b.var(t, this.r() < 0.5 ? this.of(t) : undefined)) },
    ]
    if (this.inputs.length > 0) moves.push(() => this.keep(b.in(this.one(this.inputs))))
    if (this.outs.length > 0) moves.push(() => { const o = this.one(this.outs); b.out(o, this.of(o.t)) })
    if (this.stage === 'vertex') moves.push(() => b.position(this.of('f32x4')))
    if (this.stage !== 'vertex') {
      moves.push(() => this.write(), () => b.put(this.si, this.of(this.one(['i32x2', 'u32x2'] as const)), this.of(putType(this.si.format))))
    }
    if (this.stage === 'fragment') moves.push(() => b.discard())
    if (rate) moves.push(() => this.keep(b.deriv(this.one(DERIVATIVES), this.of(this.one(FLOATS)))))
    if (vars.length > 0) moves.push(() => this.keep(b.get(this.one(vars))), () => { const v = this.one(vars); b.set(v, this.of(v.t)) })
    if (this.depth < 3) {
      moves.push(
        () => b.if(this.of('bool'), () => this.block(false, this.int(5)), this.r() < 0.5 ? () => this.block(false, this.int(4)) : undefined),
        () => b.loop(() => this.block(true, this.int(6))),
      )
    }
    return moves
  }

  private make(): void {
    const t = this.one([...VECTORS, ...GRIDS])
    let args: Val[]
    if (isGrid(t)) {
      const n = widthOf(t)
      args = this.r() < 0.5 ? Array.from({ length: n }, () => this.of(columnOf(t))) : Array.from({ length: n * n }, () => this.of('f32'))
    } else if (this.r() < 0.25) {
      args = [this.of(scalarOf(t))]
    } else {
      args = []
      for (let left = widthOf(t); left > 0;) {
        const n = 1 + this.int(left)
        args.push(this.of(vectorOf(scalarOf(t), n as 1 | Width)))
        left -= n
      }
    }
    this.keep(this.b.make(t, ...args))
  }

  private read(): void {
    const b = this.b
    const reads: (() => Val)[] = [
      () => b.read(this.u, 'a'), () => b.read(this.u, 'g'), () => b.read(this.u, 'list', this.index(3)), () => b.read(this.u, 's', 'p'),
      () => b.read(this.u, 3, 1), () => b.read(this.sb, 'n'), () => b.read(this.sb, 'items', this.index(100), 'v'),
      () => b.read(this.sb, 'items', this.index(100), 'k'), () => b.read(this.k, 'scale'), () => b.read(this.k, 'off'),
    ]
    this.keep(this.one(reads)())
  }

  private write(): void {
    const w = this.int(3)
    if (w === 0) this.b.write(this.sb, 'n', this.of('u32'))
    else if (w === 1) this.b.write(this.sb, ['items', this.index(100), 'v'], this.of('f32x3'))
    else this.b.write(this.sb, ['items', this.index(100), 'k'], this.of('i32'))
  }

  step(): void {
    this.one(this.moves())()
  }

  private block(loop: boolean, n: number): void {
    this.scopes.push([])
    this.vars.push([])
    this.depth++
    const outer = this.inLoop
    this.inLoop = outer || loop
    for (let i = 0; i < n; i++) this.step()
    const end = this.r()
    if (this.inLoop && end < 0.3) this.b.break()
    else if (this.inLoop && end < 0.45) this.b.continue()
    else if (end < 0.55) {
      this.b.return()
      this.returned = true
    }
    this.inLoop = outer
    this.depth--
    this.scopes.pop()
    this.vars.pop()
  }

  module(steps: number): LensModule {
    for (let i = 0; i < steps; i++) this.step()
    if (this.r() < 0.2) this.b.return()
    return this.b.finish()
  }
}

const randomModule = (seed: number): LensModule => new Gen(seed).module(25 + (seed % 20))
const MODULES: readonly LensModule[] = Array.from({ length: 150 }, (_, i) => randomModule(1000 + i))

function opsOf(insts: readonly Inst[], into: Set<Op>): Set<Op> {
  for (const i of insts) {
    into.add(i.op)
    if (i.op === 'if') {
      opsOf(i.then, into)
      opsOf(i.else, into)
    } else if (i.op === 'loop') opsOf(i.body, into)
  }
  return into
}

// ---------------------------------------------------------------------------------------------------
// The tests

/** A fragment shader of four instructions, whose words follow by hand from the layout. */
function small(): LensModule {
  const b = lens('fragment')
  const uv = b.input(0, 'f32x2')
  const out = b.output(0, 'f32x4')
  const one = b.f32(1)
  b.out(out, b.make('f32x4', uv, one, one))
  return b.finish()
}

const SMALL_WORDS: readonly number[] = [
  LENS_MAGIC, LENS_VERSION, 1, 1, 1, 1, 3,
  1, 0x400,
  1, 0x600,
  0,
  4,
  0x4000b, 0, 4, 0,
  0x40001, 1, 0, 0x3f800000,
  0x60005, 2, 6, 0, 1, 1,
  0x3000d, 0, 2,
]

test('a small module encodes to the words the layout gives, word for word, and decodes back', () => {
  const m = small()
  const w = encode(m)
  assert.deepEqual([...w], SMALL_WORDS)
  assert.equal(LENS_MAGIC, 0x534e454c)
  assert.deepEqual(decode(w), m)
  assert.ok(looksLikeLens(w))
})

test('opcodes, word counts and code tables are pinned', () => {
  const op = (inst: Loose): number[] => {
    const w = encode({ stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [], resources: [], body: [inst], ids: 0 } as never)
    return [w[11] & 0xffff, w[11] >>> 16, ...w.slice(12)]
  }
  assert.deepEqual(op({ op: 'lit', id: 5, t: 'i32x2', v: [-1, 2] }), [1, 5, 5, 7, 0xffffffff, 2])
  assert.deepEqual(op({ op: 'unary', id: 0, t: 'f32', fn: 'sqrt', a: 9 }), [2, 5, 0, 0, UNARY.indexOf('sqrt'), 9])
  assert.equal(UNARY.indexOf('sqrt'), 10)
  assert.deepEqual(op({ op: 'binary', id: 0, t: 'f32', fn: 'dot', a: 1, b: 2 }), [3, 6, 0, 0, 23, 1, 2])
  assert.deepEqual(op({ op: 'ternary', id: 0, t: 'f32', fn: 'choose', a: 1, b: 2, c: 3 }), [4, 7, 0, 0, 4, 1, 2, 3])
  assert.deepEqual(op({ op: 'make', id: 0, t: 'f32x2', args: [1, 2] }), [5, 5, 0, 4, 1, 2])
  assert.deepEqual(op({ op: 'pick', id: 0, t: 'f32x3', a: 1, lanes: [3, 0, 2] }), [6, 5, 0, 5, 1, 3 | (3 << 8) | (0 << 10) | (2 << 12)])
  assert.deepEqual(op({ op: 'lane', id: 0, t: 'f32', a: 1, i: 2 }), [7, 5, 0, 0, 1, 2])
  assert.deepEqual(op({ op: 'column', id: 0, t: 'f32x4', a: 1, i: 3 }), [8, 5, 0, 6, 1, 3])
  assert.deepEqual(op({ op: 'cast', id: 0, t: 'u32', a: 1 }), [9, 4, 0, 2, 1])
  assert.deepEqual(op({ op: 'bits', id: 0, t: 'u32', a: 1 }), [10, 4, 0, 2, 1])
  assert.deepEqual(op({ op: 'in', id: 0, t: 'f32', slot: 3 }), [11, 4, 0, 0, 3])
  assert.deepEqual(op({ op: 'builtin', id: 0, t: 'u32x3', name: 'global-id' }), [12, 4, 0, 11, 4])
  assert.deepEqual(op({ op: 'out', slot: 2, a: 1 }), [13, 3, 2, 1])
  assert.deepEqual(op({ op: 'position', a: 1 }), [14, 2, 1])
  assert.deepEqual(op({ op: 'read', id: 0, t: 'f32', res: 1, path: [2, { at: 5 }] }), [15, 6, 0, 0, 1, 2, 0x80000005])
  assert.deepEqual(op({ op: 'write', res: 1, path: [0x7fffffff], a: 4 }), [16, 4, 1, 4, 0x7fffffff])
  assert.deepEqual(op({ op: 'sample', id: 0, t: 'f32x4', image: 1, sampler: 2, uv: 3, level: 4 }), [17, 8, 0, 6, 1, 2, 3, 2, 4])
  assert.deepEqual(op({ op: 'sample', id: 0, t: 'f32x4', image: 1, sampler: 2, uv: 3, layer: 5, level: 4 }), [17, 9, 0, 6, 1, 2, 3, 3, 5, 4])
  assert.deepEqual(op({ op: 'texel', id: 0, t: 'f32x4', image: 1, at: 2, level: 3, layer: 4 }), [18, 8, 0, 6, 1, 2, 3, 1, 4])
  assert.deepEqual(op({ op: 'put', image: 1, at: 2, a: 3 }), [19, 4, 1, 2, 3])
  assert.deepEqual(op({ op: 'extent', id: 0, t: 'u32x2', image: 1 }), [20, 5, 0, 10, 1, 0])
  assert.deepEqual(op({ op: 'deriv', id: 0, t: 'f32', fn: 'width', a: 1 }), [21, 5, 0, 0, 2, 1])
  assert.deepEqual(op({ op: 'var', id: 0, t: 'm4', init: 1 }), [22, 5, 0, 18, 1, 1])
  assert.deepEqual(op({ op: 'get', id: 0, t: 'bool', v: 1 }), [23, 4, 0, 3, 1])
  assert.deepEqual(op({ op: 'set', v: 1, a: 2 }), [24, 3, 1, 2])
  assert.deepEqual(op({ op: 'if', c: 1, then: [{ op: 'break' }], else: [] }), [25, 2, 1, 1, 0x1001b, 0])
  assert.deepEqual(op({ op: 'loop', body: [{ op: 'continue' }, { op: 'discard' }, { op: 'return' }] }), [26, 1, 3, 0x1001c, 0x1001d, 0x1001e])
  assert.deepEqual([...VALUE_TYPES], ['f32', 'i32', 'u32', 'bool', 'f32x2', 'f32x3', 'f32x4', 'i32x2', 'i32x3', 'i32x4', 'u32x2', 'u32x3', 'u32x4', 'boolx2', 'boolx3', 'boolx4', 'm2', 'm3', 'm4'])
  assert.deepEqual(Object.keys(BUILTINS), ['vertex-index', 'instance-index', 'frag-coord', 'front-facing', 'global-id', 'local-id', 'group-id', 'local-index', 'group-count'])
  assert.deepEqual([UNARY.length, BINARY.length, TERNARY.length, DERIVATIVES.length, FORMAT_NAMES.length], [28, 27, 5, 3, 16])
  // Resources: the head word of each kind, and a block's names packed four bytes to a word.
  const res = (r: Loose): number[] => [...encode({ stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [], resources: [r], body: [], ids: 0 } as never).slice(10, -1)]
  assert.deepEqual(res({ kind: 'image', set: 1, binding: 2, sample: 'uint', dims: '2d-array' }), [3 | (1 << 8) | (2 << 16) | (1 << 24) | (1 << 26)])
  assert.deepEqual(res({ kind: 'sampler', set: 2, binding: 15 }), [4 | (2 << 8) | (15 << 16)])
  assert.deepEqual(res({ kind: 'storage-image', set: 0, binding: 1, format: 'rgba8' }), [5 | (1 << 16) | (FORMAT_NAMES.indexOf('rgba8') << 24)])
  assert.equal(FORMAT_NAMES.indexOf('rgba8'), 2)
  assert.deepEqual(res({ kind: 'storage', set: 0, binding: 0, writable: true, block: { fields: [{ name: 'tint', type: 'f32x4' }, { name: 'items', type: { array: { struct: { fields: [{ name: 'xyzwv', type: 'u32' }] } }, len: 0 } }] } }),
    [1 | (1 << 24), 2, 4, 0x746e6974, 1 | (6 << 8), 5, 0x6d657469, 0x73, 2, 0, 3, 1, 5, 0x777a7978, 0x76, 1 | (2 << 8)])
  assert.deepEqual(res({ kind: 'constants', block: { fields: [{ name: 'k', type: 'f32' }] } }), [2, 1, 1, 0x6b, 1])
})

test('every module the generator writes uses only valid instructions, and together they use every op', () => {
  const seen = new Set<Op>()
  for (const m of MODULES) {
    verify(m)
    opsOf(m.body, seen)
  }
  const all: Op[] = ['lit', 'unary', 'binary', 'ternary', 'make', 'pick', 'lane', 'column', 'cast', 'bits', 'in', 'builtin', 'out', 'position', 'read', 'write', 'sample', 'texel', 'put', 'extent', 'deriv', 'var', 'get', 'set', 'if', 'loop', 'break', 'continue', 'discard', 'return']
  assert.deepEqual([...seen].sort(), [...all].sort())
  assert.deepEqual(new Set(MODULES.map((m) => m.stage)), new Set(['vertex', 'fragment', 'compute']))
  // The generator is deterministic.
  assert.deepEqual(randomModule(1007), MODULES[7])
})

test('decode(encode(m)) deep-equals m, and encode(decode(w)) equals w, for every generated module', () => {
  for (const m of [...MODULES, small()]) {
    const w = encode(m)
    const d = decode(w)
    assert.deepEqual(d, m)
    assert.deepEqual(encode(d), w)
    const frozen = (x: unknown): void => {
      if (typeof x !== 'object' || x === null) return
      assert.ok(Object.isFrozen(x))
      for (const v of Object.values(x)) frozen(v)
    }
    frozen(d)
  }
})

test('the form keeps what a module says exactly: -0 and subnormal f32, flat false, optional fields, ill-typed modules', () => {
  const m: Loose = {
    stage: 'fragment', group: [1, 1, 1],
    inputs: [{ slot: 15, type: 'f32x4', flat: false }, { slot: 2, type: 'u32x3', flat: true }],
    outputs: [{ slot: 7, type: 'i32' }],
    resources: [],
    body: [
      { op: 'lit', id: 0, t: 'f32x4', v: [-0, 2 ** -149, -3.4028234663852886e38, 1] },
      { op: 'binary', id: 1, t: 'f32', fn: 'add', a: 0, b: 99 },
      { op: 'if', c: 7, then: [], else: [{ op: 'loop', body: [] }] },
    ],
    ids: 2,
  }
  const d = decode(encode(m))
  assert.deepEqual(d, m)
  assert.ok(d.body[0].op === 'lit' && Object.is(d.body[0].v[0], -0))
  // decode does not type-check: the module above is refused by verify, not by the codec.
  refused(() => verify(d), /^lens: /)
})

/** Every word array a fuzz case may produce: refused with a lens Fault, or decoded to a module that encodes back to it. */
function survives(words: Uint32Array): boolean {
  let m: LensModule
  try {
    m = decode(words)
  } catch (e) {
    assert.ok(isFault(e, 'lens'), String(e))
    assert.match(e.message, /^lens: decode: word \d+: /)
    return false
  }
  assert.deepEqual(encode(m), words)
  try {
    verify(m)
    assert.equal(typeof disassemble(m), 'string')
  } catch (e) {
    assert.ok(isFault(e, 'lens'), String(e))
    assert.ok(!e.message.includes('not plain data'), e.message)
  }
  return true
}

const CORPUS: readonly Uint32Array[] = [encode(small()), ...MODULES.slice(0, 16).map(encode)]

test('every truncation of a valid binary is refused', () => {
  let cases = 0
  for (const w of CORPUS) {
    for (let n = 0; n < w.length; n++) {
      assert.equal(survives(w.slice(0, n)), false, `a prefix of ${n} words decoded`)
      cases++
    }
  }
  assert.ok(cases > 2000, String(cases))
})

test('bit flips, replaced, inserted and deleted words, and random arrays only ever give a lens Fault or an exact module', () => {
  const r = lcg(77)
  const int = (n: number): number => Math.floor(r() * n)
  const SPECIAL = [0, 1, 2, 3, 15, 16, 17, 31, 64, 255, 0xffff, 0x10000, 0x7fffffff, 0x80000000, 0xffffffff, LENS_MAGIC]
  let decoded = 0
  let total = 0
  const run = (w: Uint32Array): void => {
    total++
    if (survives(w)) decoded++
  }
  for (let i = 0; i < 4000; i++) {
    const w = CORPUS[int(CORPUS.length)].slice()
    const at = int(w.length)
    w[at] = (w[at] ^ (1 << int(32))) >>> 0
    run(w)
  }
  for (let i = 0; i < 3000; i++) {
    const w = CORPUS[int(CORPUS.length)].slice()
    w[int(w.length)] = r() < 0.5 ? SPECIAL[int(SPECIAL.length)] : int(0x100000000)
    run(w)
  }
  for (let i = 0; i < 2000; i++) {
    const src = [...CORPUS[int(CORPUS.length)]]
    const at = int(src.length)
    if (r() < 0.5) src.splice(at, 1)
    else src.splice(at, 0, r() < 0.5 ? SPECIAL[int(SPECIAL.length)] : int(64))
    run(Uint32Array.from(src))
  }
  for (let i = 0; i < 2000; i++) {
    const words = [LENS_MAGIC, LENS_VERSION, int(4), 1, 1, 1, int(8)]
    const n = int(40)
    for (let k = 0; k < n; k++) words.push(r() < 0.7 ? int(8) : SPECIAL[int(SPECIAL.length)])
    run(Uint32Array.from(words))
  }
  // Fully random arrays, magic or not.
  for (let i = 0; i < 1000; i++) run(Uint32Array.from({ length: int(24) }, () => int(0x100000000)))
  assert.equal(total, 12_000)
  // Some mutations land on another valid encoding (a changed id, a flipped flat bit): those decode and round-trip.
  assert.ok(decoded > 100, String(decoded))
})

test('decode refuses each structural fault, naming the word', () => {
  const words = (change: (w: number[]) => void): Uint32Array => {
    const w = [...SMALL_WORDS]
    change(w)
    return Uint32Array.from(w)
  }
  refused(() => decode([] as never), /lens: decode: a Lens binary is a Uint32Array, not a list/)
  refused(() => decode(new Uint8Array(12) as never), /a Lens binary is a Uint32Array, not an object/)
  refused(() => decode(new Uint32Array(LENS_LIMITS.words + 1)), /lens: decode: word 0: the binary holds 1048577 words; the limit is 1048576/)
  refused(() => decode(new Uint32Array(0)), /lens: decode: word 0: the words end inside the header/)
  refused(() => decode(words((w) => { w[0] = 0x4c454e53 })), /word 0: the first word is not LENS_MAGIC/)
  refused(() => decode(words((w) => { w[1] = 2 })), /word 1: version 2 is not the version this code reads \(1\)/)
  refused(() => decode(words((w) => { w[2] = 3 })), /word 2: 3 is not a stage/)
  refused(() => decode(words((w) => { w[6] = 65_537 })), /word 6: 65537 ids is more than the limit of 65536/)
  refused(() => decode(words((w) => { w[7] = 17 })), /word 7: 17 inputs is more than the limit of 16/)
  refused(() => decode(words((w) => { w[7] = 16 })), /word 7: 16 inputs cannot fit in the \d+ words left|word \d+: /)
  refused(() => decode(words((w) => { w[8] |= 1 << 18 })), /word 8: a port word has reserved bits set/)
  refused(() => decode(words((w) => { w[8] |= 1 << 17 })), /word 8: a port word has reserved bits set/)
  refused(() => decode(words((w) => { w[8] = 19 << 8 })), /word 8: 19 is not a value type/)
  refused(() => decode(words((w) => { w[11] = 65 })), /word 11: 65 resources is more than the limit of 64/)
  refused(() => decode(words((w) => { w[12] = 65_537 })), /word 12: 65537 instructions is more than the limit of 65536/)
  refused(() => decode(words((w) => { w[12] = 30 })), /word 12: 30 instructions cannot fit in the 17 words left/)
  refused(() => decode(words((w) => { w[13] = 0x40000 })), /word 13: 0 is not an opcode/)
  refused(() => decode(words((w) => { w[13] = 0x4001f })), /word 13: 31 is not an opcode/)
  refused(() => decode(words((w) => { w[13] = 0xb })), /word 13: the instruction's word count of 0 runs past the words left/)
  refused(() => decode(words((w) => { w[13] = 0x5000b })), /word 13: in takes 4 words, not 5/)
  refused(() => decode(words((w) => { w[15] = 19 })), /word 15: 19 is not a value type/)
  refused(() => decode(words((w) => { w[17] = 0x50001 })), /word 17: this lit takes 4 words, not 5/)
  refused(() => decode(words((w) => { w[20] = 0x7fc00000 })), /word 20: an f32 literal component is not finite/)
  refused(() => decode(words((w) => { w[20] = 0x7f800000 })), /an f32 literal component is not finite/)
  refused(() => decode(words((w) => { w[19] = 3; w[20] = 2 })), /word 20: a bool literal component is 2, not 0 or 1/)
  refused(() => decode(words((w) => { w[21] = 0x30005 })), /word 21: a make takes 1 to 16 operands, not 0/)
  refused(() => decode(words((w) => { w[27] = 0x4000d })), /word 27: the instruction's word count of 4 runs past the words left/)
  refused(() => decode(words((w) => { w[27] = 0x4000d; w.push(0) })), /word 27: out takes 3 words, not 4/)
  refused(() => decode(words((w) => { w.push(0) })), /word 30: 1 words trail the body/)
  refused(() => decode(words((w) => { w.splice(29, 1) })), /the words end inside|runs past/)
  const one = (body: number[], resources: number[] = [0]): Uint32Array => Uint32Array.from([LENS_MAGIC, LENS_VERSION, 2, 1, 1, 1, 8, 0, 0, ...resources, body.length === 0 ? 0 : 1, ...body])
  refused(() => decode(one([0x50006, 0, 4, 1, 0x105])), /word 15: the lanes word is not 1 to 4 lanes with every other bit zero/)
  refused(() => decode(one([0x50006, 0, 4, 1, 0x100])), /the lanes word is not 1 to 4 lanes/)
  refused(() => decode(one([0x50006, 0, 4, 1, 0x10002])), /the lanes word is not 1 to 4 lanes/)
  refused(() => decode(one([0x50006, 0, 4, 1, 0x1402])), /the lanes word is not 1 to 4 lanes/)
  refused(() => decode(one([0x80011, 0, 6, 1, 2, 3, 4, 5])), /word 17: the flags have reserved bits set/)
  refused(() => decode(one([0x70011, 0, 6, 1, 2, 3, 1])), /word 11: this sample takes 8 words, not 7/)
  refused(() => decode(one([0x80012, 0, 6, 1, 2, 3, 2, 0])), /word 17: the flags have reserved bits set/)
  refused(() => decode(one([0x50016, 0, 2, 2, 0])), /the flags have reserved bits set/)
  refused(() => decode(one([0x50014, 0, 10, 1, 1])), /word 11: this extent takes 6 words, not 5/)
  refused(() => decode(one([0x15000f, 0, 0, 0, ...new Array(17).fill(0)])), /word 11: a path of 17 steps is more than the limit of 16/)
  refused(() => decode(one([0x20010, 0])), /word 13: the words end inside the value/)
  refused(() => decode(one([0x50002, 0, 0, 28, 0])), /word 14: 28 is not a unary function/)
  refused(() => decode(one([0x6000c, 0, 0, 9, 0, 0])), /word 11: builtin takes 4 words, not 6/)
  refused(() => decode(one([0x4000c, 0, 0, 9])), /word 14: 9 is not a builtin/)
  refused(() => decode(one([0x50015, 0, 0, 3, 0])), /word 14: 3 is not a derivative/)
  // Nesting: 32 loops deep decode; a 33rd is refused.
  const loops = (n: number): number[] => {
    const w: number[] = []
    for (let i = 0; i < n; i++) w.push(0x1001a, 1)
    w[w.length - 1] = 0
    return w
  }
  assert.equal(decode(one(loops(32))).body.length, 1)
  refused(() => decode(one(loops(33))), /if and loop nest more than 32 deep/)
  // Resources.
  const field = (name: string): number[] => [name.length, ...Array.from({ length: Math.ceil(name.length / 4) }, (_, i) => [...name.slice(i * 4, i * 4 + 4)].reduce((w, c, j) => w | (c.charCodeAt(0) << (8 * j)), 0))]
  const block = (fields: number[][]): number[] => [fields.length, ...fields.flat()]
  const withRes = (res: number[]): Uint32Array => one([], [1, ...res])
  assert.deepEqual(decode(withRes([0, ...block([[...field('a'), 1 | (6 << 8)]])])).resources, [{ kind: 'uniform', set: 0, binding: 0, block: { fields: [{ name: 'a', type: 'f32x4' }] } }])
  refused(() => decode(withRes([6])), /word 10: 6 is not a kind of resource/)
  refused(() => decode(withRes([2 | (1 << 8), 0])), /word 10: a constants resource word has reserved bits set/)
  refused(() => decode(withRes([1 | (2 << 24), 0])), /word 10: a storage resource word has reserved bits set/)
  refused(() => decode(withRes([3 | (8 << 24)])), /a image resource word has reserved bits set/)
  refused(() => decode(withRes([4 | (1 << 24)])), /a sampler resource word has reserved bits set/)
  refused(() => decode(withRes([0 | (1 << 24), 0])), /a uniform resource word has reserved bits set/)
  refused(() => decode(withRes([5 | (16 << 24)])), /word 10: 16 is not a format/)
  refused(() => decode(withRes([0, 65])), /word 11: 65 fields is more than the limit of 64/)
  refused(() => decode(withRes([0, 3, ...field('a'), 1])), /word 11: 3 fields cannot fit/)
  refused(() => decode(withRes([0, 1, 0, 0, 1])), /word 12: a name is 1 to 32 characters, not 0/)
  refused(() => decode(withRes([0, 1, 33, ...new Array(9).fill(0x61616161), 1])), /a name is 1 to 32 characters, not 33/)
  refused(() => decode(withRes([0, 1, 1, 0x80, 1])), /word 13: a name holds the byte 128, which is not printable ASCII/)
  refused(() => decode(withRes([0, 1, 1, 0x1f, 1])), /a name holds the byte 31/)
  refused(() => decode(withRes([0, 1, 1, 0x6161, 1])), /word 13: a name's padding is not zero/)
  refused(() => decode(withRes([0, ...block([[...field('a'), 4]])])), /word 14: 4 is not a type word/)
  refused(() => decode(withRes([0, ...block([[...field('a'), 1 | (19 << 8)]])])), /is not a number type word/)
  refused(() => decode(withRes([0, ...block([[...field('a'), 1 | (1 << 16)]])])), /is not a number type word/)
  refused(() => decode(withRes([0, ...block([[...field('a'), 2 | (1 << 8)]])])), /is not a type word/)
  refused(() => decode(withRes([0, ...block([[...field('a'), 2, 65_537, 1]])])), /word 15: an array of 65537 elements is more than the limit of 65536/)
  const nested = (levels: number): number[] => [0, ...block([[...field('a'), ...new Array(levels).fill([3, 1, 1, 0x62]).flat(), 1]])]
  assert.equal(decode(withRes(nested(8))).resources.length, 1)
  refused(() => decode(withRes(nested(9))), /blocks and arrays nest more than 8 deep/)
})

test('encode refuses what the form cannot carry, naming the place', () => {
  const base = (): Loose => ({ stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [], resources: [], body: [], ids: 0 })
  const bad = (change: (m: Loose) => void, re: RegExp): void => {
    const m = base()
    change(m)
    refused(() => encode(m), re)
  }
  refused(() => encode(null as never), /lens: encode: module: a module is an object, not null/)
  bad((m) => { m.extra = 1 }, /lens: encode: module: it has no field "extra"/)
  bad((m) => { m.stage = 'geometry' }, /"geometry" is not a stage/)
  bad((m) => { m.group = [1, 1] }, /the group is a list of three sizes/)
  bad((m) => { m.group = [1, -1, 1] }, /a group size is a whole number from 0 to 4294967295, not -1/)
  bad((m) => { m.ids = 65_537 }, /ids is a whole number from 0 to 65536/)
  bad((m) => { m.inputs = [{ slot: 256, type: 'f32' }] }, /lens: encode: inputs\[0\] port: the slot is a whole number from 0 to 255 in the binary form, not 256/)
  bad((m) => { m.outputs = [{ slot: 0, type: 'f32', smooth: true }] }, /outputs\[0\] port: it has no field "smooth"/)
  bad((m) => { m.outputs = [{ slot: 0, type: 'f32', flat: 1 }] }, /flat is true or false/)
  bad((m) => { m.outputs = new Array(17).fill({ slot: 0, type: 'f32' }) }, /the outputs are a list of at most 16 ports/)
  bad((m) => { m.resources = [{ kind: 'sampler', set: 256, binding: 0 }] }, /lens: encode: resources\[0\] sampler: the set is a whole number from 0 to 255/)
  bad((m) => { m.resources = [{ kind: 'texture' }] }, /lens: encode: resources\[0\] resource: "texture" is not a resource/)
  bad((m) => { m.resources = [{ kind: 'storage', set: 0, binding: 0, block: { fields: [] } }] }, /it needs a field writable/)
  bad((m) => { m.resources = [{ kind: 'image', set: 0, binding: 0, sample: 'half', dims: '2d' }] }, /"half" is not a sample kind/)
  bad((m) => { m.resources = [{ kind: 'storage-image', set: 0, binding: 0, format: 'r9' }] }, /"r9" is not a format/)
  const uniform = (fields: Loose[]): Loose => [{ kind: 'uniform', set: 0, binding: 0, block: { fields } }]
  bad((m) => { m.resources = uniform(new Array(65).fill({ name: 'a', type: 'f32' })) }, /the block: the fields are a list of at most 64/)
  bad((m) => { m.resources = uniform([{ name: '', type: 'f32' }]) }, /field 0: "" is not a name of 1 to 32 printable ASCII characters/)
  bad((m) => { m.resources = uniform([{ name: 'a'.repeat(33), type: 'f32' }]) }, /is not a name of 1 to 32/)
  bad((m) => { m.resources = uniform([{ name: 'café', type: 'f32' }]) }, /is not a name of 1 to 32 printable ASCII characters/)
  bad((m) => { m.resources = uniform([{ name: 'a\n', type: 'f32' }]) }, /printable ASCII/)
  bad((m) => { m.resources = uniform([{ name: 'a', type: 'f64' }]) }, /field 0: "f64" is not a value type/)
  bad((m) => { m.resources = uniform([{ name: 'a', type: { array: 'f32', len: 65_537 } }]) }, /an array holds 0 to 65536 elements/)
  let deep: Loose = 'f32'
  for (let i = 0; i < 9; i++) deep = { struct: { fields: [{ name: 'n', type: deep }] } }
  bad((m) => { m.resources = uniform([{ name: 'a', type: deep }]) }, /blocks and arrays nest at most 8 deep/)
  const inst = (i: Loose): ((m: Loose) => void) => (m) => { m.body = [i] }
  bad(inst({ op: 'jump' }), /lens: encode: body\[0\]: "jump" is not an instruction/)
  bad(inst({ op: 'out', slot: 0, a: 0, b: 1 }), /lens: encode: body\[0\] out: it has no field "b"/)
  bad(inst({ op: 'var', id: 0, t: 'f32', init: undefined }), /its field init is undefined/)
  bad(inst({ op: 'lit', id: 0, t: 'f32', v: [Number.NaN] }), /body\[0\] lit: component 0 \(NaN\) is not a finite number exact in f32/)
  bad(inst({ op: 'lit', id: 0, t: 'f32', v: [0.1] }), /exact in f32/)
  bad(inst({ op: 'lit', id: 0, t: 'i32', v: [-0] }), /\(and not -0\)/)
  bad(inst({ op: 'lit', id: 0, t: 'f32x2', v: [1] }), /a f32x2 literal has 2 components, not 1/)
  bad(inst({ op: 'make', id: 0, t: 'f32x2', args: [] }), /the operands are a list of 1 to 16 ids/)
  bad(inst({ op: 'make', id: 0, t: 'm4', args: new Array(17).fill(0) }), /the operands are a list of 1 to 16 ids/)
  bad(inst({ op: 'pick', id: 0, t: 'f32', a: 0, lanes: [4] }), /4 is not a lane from 0 to 3/)
  bad(inst({ op: 'pick', id: 0, t: 'f32', a: 0, lanes: [0, 0, 0, 0, 0] }), /pick takes a list of 1 to 4 lanes/)
  bad(inst({ op: 'cast', id: -1, t: 'f32', a: 0 }), /the id is a whole number from 0 to 4294967295, not -1/)
  bad(inst({ op: 'cast', id: 0, t: 'f32', a: 1.5 }), /the operand is a whole number from 0 to 4294967295, not 1.5/)
  bad(inst({ op: 'cast', id: 0, t: 'f32', a: 2 ** 32 }), /not 4294967296/)
  bad(inst({ op: 'unary', id: 0, t: 'f32', fn: 'cube', a: 0 }), /"cube" is not a unary function/)
  bad(inst({ op: 'builtin', id: 0, t: 'u32', name: 'thread' }), /"thread" is not a builtin/)
  bad(inst({ op: 'read', id: 0, t: 'f32', res: 0, path: new Array(17).fill(0) }), /the path is a list of at most 16 steps/)
  bad(inst({ op: 'read', id: 0, t: 'f32', res: 0, path: [-1] }), /step 0 \(-1\) is not a constant index from 0 to 2147483647/)
  bad(inst({ op: 'read', id: 0, t: 'f32', res: 0, path: [{ at: 2 ** 31 }] }), /step 0: the id 2147483648 does not fit the binary form/)
  bad(inst({ op: 'read', id: 0, t: 'f32', res: 0, path: ['x'] }), /step 0 is a constant index or an \{ at \} value/)
  bad(inst({ op: 'write', res: 0, path: [{ at: 1, by: 2 }], a: 0 }), /step 0: it has no field "by"/)
  let body: Loose[] = [{ op: 'break' }]
  for (let i = 0; i < 33; i++) body = [{ op: 'loop', body }]
  bad((m) => { m.body = body }, /body\[0\](\.body\[0\]){32} loop: if and loop nest at most 32 deep/)
  bad((m) => { m.body = new Array(LENS_LIMITS.instructions + 1).fill({ op: 'discard' }) }, /lens: encode: body: the module holds more than 65536 instructions/)
  bad((m) => { m.body = new Array(LENS_LIMITS.instructions).fill({ op: 'lit', id: 0, t: 'm4', v: new Array(16).fill(0) }) }, /lens: encode: module: the module takes more than 1048576 words/)
  const raising = new Proxy({}, { getOwnPropertyDescriptor() { throw new TypeError('no') } })
  refused(() => encode(raising as never), /lens: encode: module: the module is not plain data/)
})

test('looksLikeLens tells a Lens binary by its magic word and length', () => {
  assert.equal(looksLikeLens(encode(small())), true)
  assert.equal(looksLikeLens(Uint32Array.from([LENS_MAGIC, LENS_VERSION + 1, 0, 1, 1, 1, 0, 0, 0, 0, 0])), true)
  assert.equal(looksLikeLens(Uint32Array.from([LENS_MAGIC, 1, 0, 1, 1, 1, 0, 0, 0, 0])), false)
  assert.equal(looksLikeLens(new Uint32Array(11)), false)
  assert.equal(looksLikeLens([LENS_MAGIC] as never), false)
  assert.equal(looksLikeLens(null as never), false)
})

test('a random module round-trips through the disassembler deterministically', () => {
  for (const m of MODULES.slice(0, 30)) {
    const text = disassemble(m)
    assert.equal(disassemble(decode(encode(m))), text)
    assert.ok(text.startsWith(`lens ${m.stage}\n`))
  }
  // The generator draws storage images of many formats, each one a storage image may have.
  const formats: Format[] = MODULES.flatMap((m) => m.resources.flatMap((r) => (r.kind === 'storage-image' ? [r.format] : [])))
  assert.ok(new Set(formats).size > 3)
  assert.ok(formats.every((f) => FORMATS[f].storage))
})
