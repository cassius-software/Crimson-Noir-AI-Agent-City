// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the text of the disassembler line for line. The small fragment shader in the
 * head comment of disasm.ts is built here and its listing compared with that comment, so the example a reader sees
 * is the real output. A larger fragment shader prints every resource kind with its layout, nested block paths, both
 * forms of sample, texel and extent, variables, and `if`/`else`/`loop` nesting; a vertex shader prints flat ports,
 * position and grid construction; a compute shader prints its group, value-held path steps and the shortest text of
 * awkward f32 values. An invalid module is refused, not printed.
 * What breaks if it is removed? The listing could change shape without anyone seeing it, and every test and review
 * that reads a listing as a diff would quietly read a different format.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { decode, encode } from './binary.ts'
import { arrayOf, lens } from './builder.ts'
import { disassemble } from './disasm.ts'
import { isFault } from './fault.ts'
import type { LensModule } from './lens.ts'

function refused(f: () => unknown, re: RegExp): void {
  assert.throws(f, (e: unknown) => {
    assert.ok(isFault(e, 'lens'), `expected a lens Fault, got ${String(e)}`)
    assert.match(e.message, re)
    return true
  })
}

const lines = (...xs: string[]): string => `${xs.join('\n')}\n`

/** The shader of the example in the head comment of disasm.ts: a uniform tint scaled by the first lane of uv. */
function tint(): LensModule {
  const b = lens('fragment')
  const uv = b.input(0, 'f32x2')
  const out = b.output(0, 'f32x4')
  const u = b.uniform(0, 0, { tint: 'f32x4' })
  const c = b.read(u, 'tint')
  b.out(out, b.mul(c, b.pick(uv, 'x')))
  return b.finish()
}

const TINT = lines(
  'lens fragment',
  'group 1 1 1',
  'ids 4',
  'input 0 f32x2',
  'output 0 f32x4',
  'resource 0 uniform set 0 binding 0 size 16 align 16',
  '  @0 tint f32x4',
  'body',
  '  %0 = in f32x2 0',
  '  %1 = read f32x4 r0.tint',
  '  %2 = pick f32 %0 x',
  '  %3 = binary.mul f32x4 %1 %2',
  '  out 0 %3',
)

test('the small example prints exactly, and is the one in the head comment of disasm.ts', () => {
  assert.equal(disassemble(tint()), TINT)
  const head = readFileSync(new URL('./disasm.ts', import.meta.url), 'utf8').split('\n')
  const from = head.indexOf(' *   lens fragment')
  assert.ok(from > 0)
  const shown = head.slice(from, from + 13).map((l) => l.slice(5))
  assert.equal(lines(...shown), TINT)
})

/** A fragment shader that uses every resource kind and most instructions. */
function scene(): LensModule {
  const b = lens('fragment')
  const uv = b.input(0, 'f32x2')
  const id = b.input(1, 'u32')
  const out = b.output(0, 'f32x4')
  const u = b.uniform(0, 0, { view: 'm4', lights: arrayOf({ color: 'f32x3', power: 'f32' }, 4) })
  const src = b.storage(0, 1, { count: 'u32', items: arrayOf('f32x4') })
  const hits = b.storage(0, 2, { hits: arrayOf('u32') }, { writable: true })
  const k = b.constants({ scale: 'f32', tint: 'f32x3' })
  const img = b.image(1, 0, { dims: '2d-array' })
  const smp = b.sampler(1, 1)
  const counts = b.image(1, 2, { sample: 'uint' })
  const dst = b.storageImage(2, 0, 'rgba8')
  const fine = b.dx(uv)
  const layer = b.u32(1)
  const soft = b.sample(img, smp, uv, { layer })
  const sharp = b.sample(img, smp, b.add(uv, fine), { layer, level: b.f32(2) })
  const at = b.make('u32x2', id, id)
  const n = b.texel(counts, at)
  const lit = b.texel(img, at, { layer })
  b.extent(img)
  b.extent(dst)
  b.column(b.read(u, 'view'), 2)
  b.lane(b.read(u, 'lights', id, 'color'), b.read(src, 'count'))
  const item = b.read(src, 'items', 7)
  const f = b.cast(b.bits(id, 'i32'), 'f32')
  const total = b.var('f32')
  b.set(total, f)
  b.if(b.gt(f, 0), () => b.write(hits, ['hits', id], b.pick(n, 'x')), () => b.discard())
  b.loop(() => {
    b.if(b.ge(b.get(total), 10), () => b.break())
    b.set(total, b.add(b.get(total), 0.1))
  })
  b.put(dst, at, b.choose(b.builtin('front-facing'), soft, lit))
  b.out(out, b.mul(b.add(sharp, item), b.read(k, 'scale')))
  b.if(b.bool(true), () => b.return())
  return b.finish()
}

test('a larger fragment shader prints every resource, layout and block form', () => {
  assert.equal(disassemble(scene()), lines(
    'lens fragment',
    'group 1 1 1',
    'ids 40',
    'input 0 f32x2',
    'input 1 u32 flat',
    'output 0 f32x4',
    'resource 0 uniform set 0 binding 0 size 128 align 16',
    '  @0 view m4',
    '  @64 lights [4]struct stride 16',
    '    @0 color f32x3',
    '    @12 power f32',
    'resource 1 storage set 0 binding 1 read-only size 32 align 16',
    '  @0 count u32',
    '  @16 items []f32x4 stride 16',
    'resource 2 storage set 0 binding 2 writable size 4 align 4',
    '  @0 hits []u32 stride 4',
    'resource 3 constants size 32 align 16',
    '  @0 scale f32',
    '  @16 tint f32x3',
    'resource 4 image set 1 binding 0 float 2d-array',
    'resource 5 sampler set 1 binding 1',
    'resource 6 image set 1 binding 2 uint 2d',
    'resource 7 storage-image set 2 binding 0 rgba8',
    'body',
    '  %0 = in f32x2 0',
    '  %1 = in u32 1',
    '  %2 = deriv.dx f32x2 %0',
    '  %3 = lit u32 1',
    '  %4 = sample f32x4 r4 r5 %0 layer %3',
    '  %5 = binary.add f32x2 %0 %2',
    '  %6 = lit f32 2',
    '  %7 = sample f32x4 r4 r5 %5 layer %3 level %6',
    '  %8 = make u32x2 %1 %1',
    '  %9 = lit u32 0',
    '  %10 = texel u32x4 r6 %8 level %9',
    '  %11 = lit u32 0',
    '  %12 = texel f32x4 r4 %8 layer %3 level %11',
    '  %13 = lit u32 0',
    '  %14 = extent u32x2 r4 level %13',
    '  %15 = extent u32x2 r7',
    '  %16 = read m4 r0.view',
    '  %17 = column f32x4 %16 2',
    '  %18 = read f32x3 r0.lights[%1].color',
    '  %19 = read u32 r1.count',
    '  %20 = lane f32 %18 %19',
    '  %21 = read f32x4 r1.items[7]',
    '  %22 = bits i32 %1',
    '  %23 = cast f32 %22',
    '  %24 = var f32',
    '  set %24 %23',
    '  %25 = lit f32 0',
    '  %26 = binary.gt bool %23 %25',
    '  if %26',
    '    %27 = pick u32 %10 x',
    '    write r2.hits[%1] %27',
    '  else',
    '    discard',
    '  end',
    '  loop',
    '    %28 = get f32 %24',
    '    %29 = lit f32 10',
    '    %30 = binary.ge bool %28 %29',
    '    if %30',
    '      break',
    '    end',
    '    %31 = get f32 %24',
    '    %32 = lit f32 0.1',
    '    %33 = binary.add f32 %31 %32',
    '    set %24 %33',
    '  end',
    '  %34 = builtin bool front-facing',
    '  %35 = ternary.choose f32x4 %34 %4 %12',
    '  put r7 %8 %35',
    '  %36 = binary.add f32x4 %7 %21',
    '  %37 = read f32 r3.scale',
    '  %38 = binary.mul f32x4 %36 %37',
    '  out 0 %38',
    '  %39 = lit bool true',
    '  if %39',
    '    return',
    '  end',
  ))
})

test('a vertex shader prints flat ports, position, grids, variables with a start value and unary ops', () => {
  const b = lens('vertex')
  const p = b.input(0, 'f32x3')
  b.input(1, 'i32')
  const uv = b.output(0, 'f32x2')
  const tag = b.output(1, 'u32')
  const fade = b.output(2, 'f32', { flat: true })
  const spin = b.make('m2', 1, 0, 0, 1)
  b.position(b.make('f32x4', p, 1))
  const keep = b.var('f32', b.sqrt(b.dot(p, p)))
  b.out(fade, b.mix(b.get(keep), b.f32(-0), 0.5))
  b.out(uv, b.mul(spin, b.pick(p, 'zy')))
  b.out(tag, b.builtin('vertex-index'))
  assert.equal(disassemble(b.finish()), lines(
    'lens vertex',
    'group 1 1 1',
    'ids 19',
    'input 0 f32x3',
    'input 1 i32',
    'output 0 f32x2',
    'output 1 u32 flat',
    'output 2 f32 flat',
    'body',
    '  %0 = in f32x3 0',
    '  %1 = in i32 1',
    '  %2 = lit f32 1',
    '  %3 = lit f32 0',
    '  %4 = lit f32 0',
    '  %5 = lit f32 1',
    '  %6 = make m2 %2 %3 %4 %5',
    '  %7 = lit f32 1',
    '  %8 = make f32x4 %0 %7',
    '  position %8',
    '  %9 = binary.dot f32 %0 %0',
    '  %10 = unary.sqrt f32 %9',
    '  %11 = var f32 %10',
    '  %12 = get f32 %11',
    '  %13 = lit f32 -0',
    '  %14 = lit f32 0.5',
    '  %15 = ternary.mix f32 %12 %13 %14',
    '  out 2 %15',
    '  %16 = pick f32x2 %0 zy',
    '  %17 = binary.mul f32x2 %6 %16',
    '  out 0 %17',
    '  %18 = builtin u32 vertex-index',
    '  out 1 %18',
  ))
})

test('a compute shader prints its group, value-held steps, and the shortest text of each literal', () => {
  const b = lens('compute', { group: [64, 2, 1] })
  const buf = b.storage(0, 0, { rows: arrayOf({ v: 'f32x4', n: 'i32' }, 8) }, { writable: true })
  const x = b.lane(b.builtin('global-id'), 0)
  b.write(buf, ['rows', x, 'n'], b.i32(-2147483648))
  b.write(buf, ['rows', 3, 'v'], b.lit('f32x4', 0.1, 1 / 3, 16777216, 2 ** -149))
  b.write(buf, ['rows', 4, 'v'], b.lit('f32x4', -0, 3.4028234663852886e38, 1e-7, -65504.5))
  b.var('boolx2', b.boolx2(false, true))
  b.u32(4294967295)
  const m = b.finish()
  const text = lines(
    'lens compute',
    'group 64 2 1',
    'ids 9',
    'resource 0 storage set 0 binding 0 writable size 256 align 16',
    '  @0 rows [8]struct stride 32',
    '    @0 v f32x4',
    '    @16 n i32',
    'body',
    '  %0 = builtin u32x3 global-id',
    '  %1 = lit u32 0',
    '  %2 = lane u32 %0 %1',
    '  %3 = lit i32 -2147483648',
    '  write r0.rows[%2].n %3',
    '  %4 = lit f32x4 0.1 0.33333334 16777216 1e-45',
    '  write r0.rows[3].v %4',
    '  %5 = lit f32x4 -0 3.4028235e+38 1e-7 -65504.5',
    '  write r0.rows[4].v %5',
    '  %6 = lit boolx2 false true',
    '  %7 = var boolx2 %6',
    '  %8 = lit u32 4294967295',
  )
  assert.equal(disassemble(m), text)
  // Each printed f32 reads back as the very value stored.
  const printed = text.split('\n').filter((l) => l.includes('lit f32x4')).flatMap((l) => l.trim().split(' ').slice(4))
  const stored = m.body.flatMap((i) => (i.op === 'lit' && i.t === 'f32x4' ? i.v : []))
  assert.deepEqual(printed.map((s) => Math.fround(Number(s))), stored)
  // The listing depends only on the module: the same after a trip through the binary form.
  assert.equal(disassemble(decode(encode(m))), text)
})

test('an invalid module is refused with a lens Fault, not printed', () => {
  const m = tint()
  refused(() => disassemble({ ...m, ids: 3 }), /^lens: body\[3\] binary: /)
  refused(() => disassemble({ ...m, body: [...m.body, { op: 'out', slot: 5, a: 3 }] }), /^lens: body\[5\] out: /)
  refused(() => disassemble({ ...m, resources: [] }), /^lens: body\[1\] read: /)
  refused(() => disassemble(null as never), /^lens: module: /)
})

test('the listing is of a private copy read once: a module that changes as it is read is listed as read, or refused', () => {
  const m = tint()
  const text = disassemble(m)
  const outcome = (x: unknown): string => {
    try {
      return disassemble(x as LensModule)
    } catch (e) {
      assert.ok(isFault(e, 'lens'), `expected a lens Fault, got ${String(e)}`)
      return 'refused'
    }
  }
  // An operand that reads right some number of times and then not at all: never a listing with %undefined in it.
  for (let good = 0; good <= 8; good++) {
    let reads = 0
    const mul = { ...m.body[3] }
    Object.defineProperty(mul, 'a', { enumerable: true, get: () => (reads++ < good ? 1 : undefined) })
    const got = outcome({ ...m, body: [...m.body.slice(0, 3), mul, m.body[4]] })
    assert.ok(got === text || got === 'refused', got)
  }
  // Resources that read as a list some number of times and then as null: never a TypeError.
  for (let good = 0; good <= 8; good++) {
    let reads = 0
    const shifty = { ...m }
    Object.defineProperty(shifty, 'resources', { enumerable: true, get: () => (reads++ < good ? m.resources : null) })
    const got = outcome(shifty)
    assert.ok(got === text || got === 'refused', got)
  }
  // Anything at all gives a listing or a lens Fault.
  for (const junk of [undefined, 7, 'lens', [], new Uint32Array(4), new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('no') } })]) {
    assert.equal(outcome(junk), 'refused')
  }
})
