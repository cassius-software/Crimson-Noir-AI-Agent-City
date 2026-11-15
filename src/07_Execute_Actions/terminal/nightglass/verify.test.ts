// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the Lens checker: a hand-written module of each stage that uses most of the
 * form is accepted, and then each rule of the form is broken once, by one small change to a valid module, and the
 * refusal is asserted to be a Fault of code `lens` whose message names the place and the rule. It also feeds the
 * checker hostile input (cycles, shared blocks that stand for huge trees, objects that raise when read, junk in
 * every field) and requires that nothing but a lens Fault ever comes out, quickly.
 * What breaks if it is removed? A rule could stop being checked, or a refusal could start naming the wrong place,
 * and an ill-formed shader would reach the reference renderer and the GPU back end unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isFault } from './fault.ts'
import { IMAGE_DIMS, LENS_LIMITS, RESOURCE_KINDS, SAMPLE_KINDS, componentsOf, layoutBlock } from './lens.ts'
import type { LensModule, ValueType } from './lens.ts'
import { binaryType, makeRule, ternaryType, unaryType, verify } from './verify.ts'
import type { Refuse } from './verify.ts'

// Mutable plain data: each fixture is built fresh so a test may change it in place.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any

function vertex(): Loose {
  return {
    stage: 'vertex',
    group: [1, 1, 1],
    inputs: [{ slot: 0, type: 'f32x3' }, { slot: 1, type: 'u32' }],
    outputs: [{ slot: 0, type: 'f32x2' }, { slot: 1, type: 'u32', flat: true }],
    resources: [{ kind: 'uniform', set: 0, binding: 0, block: { fields: [{ name: 'xform', type: 'm4' }, { name: 'tint', type: 'f32x4' }] } }],
    body: [
      { op: 'in', id: 0, t: 'f32x3', slot: 0 },
      { op: 'lit', id: 1, t: 'f32', v: [1] },
      { op: 'make', id: 2, t: 'f32x4', args: [0, 1] },
      { op: 'read', id: 3, t: 'm4', res: 0, path: [0] },
      { op: 'binary', id: 4, t: 'f32x4', fn: 'mul', a: 3, b: 2 },
      { op: 'position', a: 4 },
      { op: 'in', id: 5, t: 'u32', slot: 1 },
      { op: 'out', slot: 1, a: 5 },
      { op: 'pick', id: 6, t: 'f32x2', a: 0, lanes: [0, 1] },
      { op: 'out', slot: 0, a: 6 },
    ],
    ids: 7,
  }
}

function fragment(): Loose {
  return {
    stage: 'fragment',
    group: [1, 1, 1],
    inputs: [{ slot: 0, type: 'f32x2' }, { slot: 1, type: 'u32', flat: true }],
    outputs: [{ slot: 0, type: 'f32x4' }],
    resources: [
      { kind: 'image', set: 0, binding: 0, sample: 'float', dims: '2d' },
      { kind: 'sampler', set: 0, binding: 1 },
      { kind: 'image', set: 0, binding: 2, sample: 'uint', dims: '2d-array' },
      { kind: 'constants', block: { fields: [{ name: 'scale', type: 'f32' }] } },
    ],
    body: [
      { op: 'in', id: 0, t: 'f32x2', slot: 0 },
      { op: 'sample', id: 1, t: 'f32x4', image: 0, sampler: 1, uv: 0 },
      { op: 'deriv', id: 2, t: 'f32x2', fn: 'dx', a: 0 },
      { op: 'read', id: 3, t: 'f32', res: 3, path: [0] },
      { op: 'var', id: 4, t: 'f32x4', init: 1 },
      { op: 'binary', id: 5, t: 'bool', fn: 'lt', a: 3, b: 3 },
      { op: 'if', c: 5, then: [{ op: 'discard' }], else: [] },
      { op: 'in', id: 6, t: 'u32', slot: 1 },
      { op: 'make', id: 7, t: 'u32x2', args: [6] },
      { op: 'texel', id: 8, t: 'u32x4', image: 2, at: 7, layer: 6, level: 6 },
      { op: 'cast', id: 9, t: 'f32x4', a: 8 },
      { op: 'get', id: 10, t: 'f32x4', v: 4 },
      { op: 'binary', id: 11, t: 'f32x4', fn: 'add', a: 10, b: 9 },
      { op: 'set', v: 4, a: 11 },
      { op: 'get', id: 12, t: 'f32x4', v: 4 },
      { op: 'out', slot: 0, a: 12 },
      { op: 'return' },
    ],
    ids: 13,
  }
}

function compute(): Loose {
  return {
    stage: 'compute',
    group: [8, 8, 1],
    inputs: [],
    outputs: [],
    resources: [
      {
        kind: 'storage', set: 0, binding: 0, writable: true,
        block: { fields: [{ name: 'count', type: 'u32' }, { name: 'items', type: { array: { struct: { fields: [{ name: 'pos', type: 'f32x3' }, { name: 'w', type: 'f32' }] } }, len: 0 } }] },
      },
      { kind: 'storage-image', set: 1, binding: 0, format: 'rgba8' },
      { kind: 'uniform', set: 0, binding: 1, block: { fields: [{ name: 'grid', type: 'm3' }, { name: 'list', type: { array: 'u32x4', len: 4 } }] } },
    ],
    body: [
      { op: 'builtin', id: 0, t: 'u32x3', name: 'global-id' },
      { op: 'pick', id: 1, t: 'u32', a: 0, lanes: [0] },
      { op: 'read', id: 2, t: 'f32x3', res: 0, path: [1, { at: 1 }, 0] },
      { op: 'read', id: 3, t: 'm3', res: 2, path: [0] },
      { op: 'column', id: 4, t: 'f32x3', a: 3, i: 2 },
      { op: 'binary', id: 5, t: 'f32x3', fn: 'add', a: 2, b: 4 },
      { op: 'write', res: 0, path: [1, { at: 1 }, 0], a: 5 },
      { op: 'var', id: 6, t: 'u32' },
      {
        op: 'loop', body: [
          { op: 'get', id: 7, t: 'u32', v: 6 },
          { op: 'lit', id: 8, t: 'u32', v: [4] },
          { op: 'binary', id: 9, t: 'bool', fn: 'ge', a: 7, b: 8 },
          { op: 'if', c: 9, then: [{ op: 'break' }], else: [] },
          { op: 'read', id: 10, t: 'u32x4', res: 2, path: [1, { at: 7 }] },
          { op: 'lane', id: 11, t: 'u32', a: 10, i: 7 },
          { op: 'lit', id: 12, t: 'u32', v: [1] },
          { op: 'binary', id: 13, t: 'u32', fn: 'add', a: 7, b: 12 },
          { op: 'set', v: 6, a: 13 },
          { op: 'continue' },
        ],
      },
      { op: 'pick', id: 14, t: 'u32x2', a: 0, lanes: [0, 1] },
      { op: 'extent', id: 15, t: 'u32x2', image: 1 },
      { op: 'bits', id: 16, t: 'f32', a: 1 },
      { op: 'make', id: 17, t: 'f32x4', args: [16] },
      { op: 'put', image: 1, at: 14, a: 17 },
    ],
    ids: 18,
  }
}

/** A compute module of one block-less body, for instruction-level cases. */
function bare(body: Loose[], ids = 64, resources: Loose[] = []): Loose {
  return { stage: 'compute', group: [1, 1, 1], inputs: [], outputs: [], resources, body, ids }
}

const NOT_DATA = 'not plain data'

/** Asserts the module is refused with a lens Fault whose message matches. */
function refused(m: unknown, re: RegExp): void {
  try {
    verify(m as LensModule)
  } catch (e) {
    assert.ok(isFault(e, 'lens'), `expected a lens Fault, got ${String(e)}`)
    assert.match(e.message, re)
    assert.match(e.message, /^lens: /)
    return
  }
  assert.fail(`the module was accepted; expected a refusal matching ${re}`)
}

/** A mutation of a fresh fixture, refused with a message matching re. */
function mutation(make: () => Loose, change: (m: Loose) => void, re: RegExp): void {
  const m = make()
  change(m)
  refused(m, re)
}

test('a valid module of each stage is accepted, and so is the smallest one', () => {
  verify(vertex())
  verify(fragment())
  verify(compute())
  verify(bare([], 0))
})

test('the module itself: an object with exactly its fields, a stage, and ids in range', () => {
  refused(null, /lens: module: a module is an object/)
  refused([], /a module is an object/)
  mutation(vertex, (m) => delete m.body, /lens: module: it needs a field body/)
  mutation(vertex, (m) => { m.extra = 1 }, /lens: module: it has no field "extra"/)
  mutation(vertex, (m) => { m.stage = 'geometry' }, /"geometry" is not a stage/)
  mutation(vertex, (m) => { m.ids = LENS_LIMITS.ids + 1 }, /ids is a whole number from 0 to 65536/)
  mutation(vertex, (m) => { m.ids = 7.5 }, /ids is a whole number/)
  mutation(vertex, (m) => { m.ids = 6 }, /lens: body\[8\] pick: the id 6 is not below the module's 6/)
})

test('the group: compute within LENS_LIMITS, every other stage exactly [1, 1, 1]', () => {
  mutation(vertex, (m) => { m.group = [2, 1, 1] }, /lens: group: a vertex stage has the group \[1, 1, 1\]/)
  mutation(fragment, (m) => { m.group = [1, 1] }, /lens: group: the group is a list of three sizes/)
  mutation(compute, (m) => { m.group = [0, 1, 1] }, /a group size is a whole number of at least 1, not 0/)
  mutation(compute, (m) => { m.group = [1.5, 1, 1] }, /a whole number of at least 1/)
  mutation(compute, (m) => { m.group = [257, 1, 1] }, /at most 256 along x and y/)
  mutation(compute, (m) => { m.group = [1, 1, 65] }, /at most 64 along z/)
  mutation(compute, (m) => { m.group = [16, 16, 2] }, /holds 512 invocations; the limit is 256/)
  verify({ ...compute(), group: [256, 1, 1] })
  verify({ ...compute(), group: [4, 4, 16] })
})

test('ports: slots below the limit and unique, number types, and flat exactly between stages', () => {
  mutation(vertex, (m) => { m.inputs = 'none' }, /lens: inputs: the inputs are a list/)
  mutation(vertex, (m) => { m.inputs = Array.from({ length: 17 }, (_, i) => ({ slot: i % 16, type: 'f32' })) }, /17 ports is more than the limit of 16/)
  mutation(vertex, (m) => { m.inputs[0].slot = 16 }, /lens: inputs\[0\] port: slot 16 is not a whole number below 16/)
  mutation(vertex, (m) => { m.inputs[1].slot = 0 }, /lens: inputs\[1\] port: slot 0 is declared twice/)
  mutation(vertex, (m) => { m.inputs[0].type = 'm4' }, /a port carries numbers or number vectors, not m4/)
  mutation(vertex, (m) => { m.outputs[0].type = 'boolx2' }, /a port carries numbers or number vectors, not boolx2/)
  mutation(vertex, (m) => { m.inputs[0].type = 'f64' }, /"f64" is not a value type/)
  mutation(vertex, (m) => { delete m.outputs[1].flat }, /lens: outputs\[1\] port: u32 values passed between stages are flat/)
  mutation(fragment, (m) => { m.inputs[1].flat = false }, /lens: inputs\[1\] port: u32 values passed between stages are flat/)
  mutation(vertex, (m) => { m.inputs[0].flat = true }, /a vertex input is not passed between stages, so it is not flat/)
  mutation(fragment, (m) => { m.outputs[0].flat = true }, /a fragment output is not passed between stages, so it is not flat/)
  mutation(compute, (m) => { m.inputs = [{ slot: 0, type: 'f32' }] }, /lens: inputs\[0\] port: a compute stage has no ports/)
  mutation(vertex, (m) => { m.outputs[0].flat = 'yes' }, /flat is true or false/)
  mutation(vertex, (m) => { m.outputs[0].smooth = true }, /it has no field "smooth"/)
  // A float passed between stages may be flat, and a non-flat port may say so.
  verify({ ...vertex(), outputs: [{ slot: 0, type: 'f32x2', flat: true }, { slot: 1, type: 'u32', flat: true }] })
  verify({ ...vertex(), inputs: [{ slot: 0, type: 'f32x3', flat: false }, { slot: 1, type: 'u32' }] })
})

test('resources: kinds, sets and bindings, at most one constants block, image kinds and storage formats', () => {
  mutation(vertex, (m) => { m.resources = {} }, /lens: resources: the resources are a list/)
  mutation(vertex, (m) => { m.resources = Array.from({ length: 65 }, (_, i) => ({ kind: 'sampler', set: i % 3, binding: i % 16 })) }, /65 resources is more than the limit of 64/)
  mutation(vertex, (m) => { m.resources[0].set = 3 }, /lens: resources\[0\] uniform: set 3 is not a whole number below 3/)
  mutation(vertex, (m) => { m.resources[0].binding = 16 }, /binding 16 is not a whole number below 16/)
  mutation(fragment, (m) => { m.resources[1].binding = 0 }, /lens: resources\[1\] sampler: set 0 binding 0 is declared twice/)
  mutation(fragment, (m) => { m.resources.push({ kind: 'constants', block: { fields: [{ name: 'b', type: 'u32' }] } }) }, /resources\[4\] constants: a module declares at most one constants resource/)
  mutation(fragment, (m) => { m.resources[3].block.fields = [{ name: 'many', type: { array: 'f32x4', len: 9 } }] }, /the constants block takes 144 bytes; the limit is 128/)
  mutation(fragment, (m) => { m.resources[3].set = 0 }, /lens: resources\[3\] constants: it has no field "set"/)
  mutation(compute, (m) => { delete m.resources[0].writable }, /lens: resources\[0\] storage: it needs a field writable/)
  mutation(compute, (m) => { m.resources[0].writable = 1 }, /writable is true or false/)
  mutation(fragment, (m) => { m.resources[0].sample = 'half' }, /"half" is not a sample kind/)
  mutation(fragment, (m) => { m.resources[0].dims = '3d' }, /"3d" is not an image shape/)
  mutation(compute, (m) => { m.resources[1].format = 'bgra8' }, /lens: resources\[1\] storage-image: "bgra8" is not a format a storage image may have/)
  mutation(compute, (m) => { m.resources[1].format = 'rgb9' }, /"rgb9" is not a format a storage image may have/)
  mutation(vertex, (m) => { m.resources[0].kind = 'texture' }, /lens: resources\[0\] resource: "texture" is not a kind of resource/)
  mutation(vertex, (m) => { m.resources[0] = 7 }, /a resource is an object/)
})

test('blocks: names, field counts, number types, nesting, lengths, the runtime array, and uniform strides', () => {
  const uniformField = (type: Loose) => (m: Loose) => { m.resources[0].block.fields.push({ name: 'extra', type }) }
  mutation(vertex, (m) => { m.resources[0].block.fields[1].name = '1x' }, /field 1: "1x" is not a field name/)
  mutation(vertex, (m) => { m.resources[0].block.fields[1].name = 'a'.repeat(33) }, /is not a field name/)
  mutation(vertex, (m) => { m.resources[0].block.fields[1].name = 'xform' }, /field 1: the name xform is used twice in its block/)
  mutation(vertex, uniformField('bool'), /field extra: "bool" is not a number type \(a block holds no bools\)/)
  mutation(vertex, uniformField('boolx4'), /a block holds no bools/)
  mutation(vertex, uniformField(5), /field extra: its type is a number type, an array or a nested block/)
  mutation(vertex, uniformField({ array: 'f32x4', len: 65_537 }), /an array holds 0 to 65536 elements, not 65537/)
  mutation(vertex, uniformField({ array: 'f32x4', len: 2, extra: 1 }), /field extra: it has no field "extra"/)
  mutation(vertex, uniformField({ array: 'f32', len: 4 }), /field extra: an array in a uniform block needs elements 16 bytes apart/)
  mutation(vertex, uniformField({ array: { array: 'f32', len: 4 }, len: 4 }), /field extra\[\]: an array in a uniform block needs elements 16 bytes apart/)
  mutation(vertex, uniformField({ array: 'f32x4', len: 0 }), /an array without a length is only the last field of a storage block/)
  mutation(vertex, (m) => { m.resources[0].block.fields = [] }, /the block holds 0 fields; a block holds 1 to 64/)
  mutation(vertex, (m) => { m.resources[0].block.fields = Array.from({ length: 65 }, (_, i) => ({ name: `f${i}`, type: 'f32' })) }, /holds 65 fields/)
  mutation(vertex, (m) => { m.resources[0].block = { fields: [{ name: 'a', type: 'f32' }], align: 16 } }, /the block: it has no field "align"/)
  mutation(compute, (m) => { m.resources[0].block.fields.reverse() }, /field items: an array without a length is only the last field of a storage block/)
  mutation(compute, (m) => { m.resources[0].block.fields[1].type = { struct: { fields: [{ name: 'tail', type: { array: 'f32', len: 0 } }] } } }, /field items.tail: an array without a length/)
  mutation(compute, (m) => { m.resources[0].block.fields[1].type = { array: { array: 'f32', len: 0 }, len: 0 } }, /field items\[\]: an array without a length/)
  // Eight levels of nesting are allowed; a ninth is refused.
  const nested = (levels: number): Loose => {
    let t: Loose = 'f32x4'
    for (let i = 0; i < levels; i++) t = { struct: { fields: [{ name: `n${i}`, type: t }] } }
    return t
  }
  verify({ ...bare([], 0), resources: [{ kind: 'storage', set: 0, binding: 0, writable: false, block: { fields: [{ name: 'deep', type: nested(8) }] } }] })
  refused({ ...bare([], 0), resources: [{ kind: 'storage', set: 0, binding: 0, writable: false, block: { fields: [{ name: 'deep', type: nested(9) }] } }] }, /blocks and arrays nest at most 8 deep/)
  // A uniform nested block of four bytes is laid out on 16-byte boundaries; storage packs it.
  verify({ ...bare([], 0), resources: [{ kind: 'uniform', set: 0, binding: 0, block: { fields: [{ name: 's', type: { struct: { fields: [{ name: 'x', type: 'f32' }] } } }, { name: 'y', type: 'f32' }] } }] })
})

test('instructions: objects with exactly their fields, ids defined once, used after, in scope, and of the right kind', () => {
  mutation(vertex, (m) => { m.body = 'x' }, /lens: body: a block is a list of instructions/)
  mutation(vertex, (m) => { m.body[2] = null }, /lens: body\[2\]: an instruction is an object, not null/)
  mutation(vertex, (m) => { m.body[2] = { op: 'jump' } }, /lens: body\[2\]: "jump" is not an instruction/)
  mutation(vertex, (m) => { delete m.body[4].b }, /lens: body\[4\] binary: it needs a field b/)
  mutation(vertex, (m) => { m.body[4].c = 2 }, /lens: body\[4\] binary: it has no field "c"/)
  mutation(fragment, (m) => { m.body[1].layer = undefined }, /lens: body\[1\] sample: its field layer is undefined \(leave an absent field out\)/)
  mutation(vertex, (m) => { m.body[1].t = 'f16' }, /lens: body\[1\] lit: "f16" is not a value type/)
  mutation(vertex, (m) => { m.body[1].id = 99 }, /lens: body\[1\] lit: the id 99 is not below the module's 7/)
  mutation(vertex, (m) => { m.body[1].id = 0 }, /lens: body\[1\] lit: %0 is defined twice/)
  mutation(vertex, (m) => { m.body[2].args = [0, 3] }, /lens: body\[2\] make: operand 1 %3 is used before it is defined/)
  mutation(vertex, (m) => { m.body[4].a = 4 }, /operand a %4 is used before it is defined/)
  mutation(vertex, (m) => { m.body[4].b = -1 }, /operand b -1 is not an id below the module's 7/)
  mutation(vertex, (m) => { m.body[4].b = '2' }, /operand b "2" is not an id/)
  mutation(fragment, (m) => { m.body[11] = { op: 'binary', id: 10, t: 'f32x4', fn: 'add', a: 4, b: 9 } }, /lens: body\[11\] binary: operand a %4 is a variable; read it with get/)
  mutation(fragment, (m) => { m.body[13].v = 9 }, /lens: body\[13\] set: %9 is a value, not a variable/)
  mutation(fragment, (m) => { m.body[11].v = 99 }, /the variable 99 is not an id below/)
  // A value made inside a block ends with it.
  mutation(compute, (m) => { m.body.push({ op: 'unary', id: 18, t: 'u32', fn: 'abs', a: 7 }); m.ids = 19 }, /lens: body\[14\] unary: the operand %7 is defined in a block that has ended/)
  mutation(compute, (m) => {
    m.body[8].body[3].then = [{ op: 'var', id: 18, t: 'u32' }, { op: 'break' }]
    m.body[8].body.splice(8, 1, { op: 'set', v: 18, a: 13 })
    m.ids = 19
  }, /lens: body\[8\].body\[8\] set: the variable %18 is defined in a block that has ended/)
})

test('literals: one component per scalar, f32 exact and finite, integers whole and in range and not -0, bools 0 or 1', () => {
  const lit = (t: string, v: unknown[]) => bare([{ op: 'lit', id: 0, t, v }])
  verify(lit('f32', [-0]))
  verify(lit('i32', [-0x80000000]))
  verify(lit('u32', [0xffffffff]))
  verify(lit('m2', [1, 2, 3, 4]))
  verify(lit('f32', [Math.fround(0.1)]))
  refused(lit('f32', [Number.NaN]), /lens: body\[0\] lit: component 0 \(NaN\) is not a finite number exact in f32/)
  refused(lit('f32', [Infinity]), /not a finite number exact in f32/)
  refused(lit('f32', [0.1]), /component 0 \(0.1\) is not a finite number exact in f32/)
  refused(lit('f32', [1e39]), /not a finite number exact in f32/)
  refused(lit('i32', [0x80000000]), /is outside the range of i32/)
  refused(lit('u32', [-1]), /is outside the range of u32/)
  refused(lit('bool', [2]), /is outside the range of bool/)
  refused(lit('i32', [1.5]), /is not a whole number \(and not -0\)/)
  refused(lit('u32', [-0]), /\(and not -0\)/)
  refused(lit('bool', [-0]), /is not a whole 0 or 1 \(and not -0\)/)
  refused(lit('f32x3', [1, 2]), /a f32x3 literal has 3 components, not 2/)
  refused(lit('f32', ['1']), /component 0 \("1"\) is not a number/)
  refused(bare([{ op: 'lit', id: 0, t: 'f32', v: 1 }]), /the components are a list/)
})

/** Builds a compute body that makes one value of each type in `types` (ids 0..) and then the instruction. */
function withValues(types: string[], inst: Loose): Loose {
  const lits = types.map((t, id) => ({ op: 'lit', id, t, v: new Array(componentsOf(t as ValueType)).fill(0) }))
  return bare([...lits, inst])
}

test('the typing table: unary, binary and ternary results are exact and misuse is refused with the rule', () => {
  verify(withValues(['f32x3'], { op: 'unary', id: 1, t: 'f32', fn: 'length', a: 0 }))
  refused(withValues(['i32'], { op: 'unary', id: 1, t: 'i32', fn: 'sqrt', a: 0 }), /lens: body\[1\] unary: sqrt takes an f32 scalar or vector, not i32/)
  refused(withValues(['f32x3'], { op: 'unary', id: 1, t: 'f32x3', fn: 'length', a: 0 }), /unary: the result is f32, not f32x3/)
  refused(withValues(['f32'], { op: 'unary', id: 1, t: 'f32', fn: 'cbrt', a: 0 }), /"cbrt" is not a unary function/)
  refused(withValues(['m2'], { op: 'unary', id: 1, t: 'm2', fn: 'neg', a: 0 }), /neg takes an f32 or i32 scalar or vector, not m2/)
  verify(withValues(['f32x3', 'f32'], { op: 'binary', id: 2, t: 'f32x3', fn: 'add', a: 0, b: 1 }))
  verify(withValues(['f32', 'f32x3'], { op: 'binary', id: 2, t: 'f32x3', fn: 'div', a: 0, b: 1 }))
  verify(withValues(['m4', 'f32x4'], { op: 'binary', id: 2, t: 'f32x4', fn: 'mul', a: 0, b: 1 }))
  verify(withValues(['f32x3', 'm3'], { op: 'binary', id: 2, t: 'f32x3', fn: 'mul', a: 0, b: 1 }))
  verify(withValues(['m2', 'f32'], { op: 'binary', id: 2, t: 'm2', fn: 'mul', a: 0, b: 1 }))
  verify(withValues(['i32x3', 'u32x3'], { op: 'binary', id: 2, t: 'i32x3', fn: 'shr', a: 0, b: 1 }))
  verify(withValues(['u32x2', 'u32x2'], { op: 'binary', id: 2, t: 'boolx2', fn: 'eq', a: 0, b: 1 }))
  verify(withValues(['i32x4', 'i32x4'], { op: 'binary', id: 2, t: 'i32', fn: 'dot', a: 0, b: 1 }))
  refused(withValues(['f32x3', 'i32'], { op: 'binary', id: 2, t: 'f32x3', fn: 'add', a: 0, b: 1 }), /binary: add takes two numbers of one type, a vector and a scalar of its kind, or two grids of one size, not f32x3 and i32/)
  refused(withValues(['f32', 'm4'], { op: 'binary', id: 2, t: 'm4', fn: 'mul', a: 0, b: 1 }), /mul takes .* a grid and then an f32, not f32 and m4/)
  refused(withValues(['m4', 'f32x3'], { op: 'binary', id: 2, t: 'f32x3', fn: 'mul', a: 0, b: 1 }), /mul takes/)
  refused(withValues(['m2', 'm2'], { op: 'binary', id: 2, t: 'm2', fn: 'div', a: 0, b: 1 }), /div takes two numbers of one type, or a vector and a scalar of its kind/)
  refused(withValues(['f32x3', 'f32'], { op: 'binary', id: 2, t: 'f32x3', fn: 'min', a: 0, b: 1 }), /min takes two numbers of one type, not f32x3 and f32/)
  refused(withValues(['i32', 'i32'], { op: 'binary', id: 2, t: 'i32', fn: 'shl', a: 0, b: 1 }), /shl takes an integer and then a u32 count of the same width/)
  refused(withValues(['u32x2', 'u32'], { op: 'binary', id: 2, t: 'u32x2', fn: 'shl', a: 0, b: 1 }), /u32 count of the same width/)
  refused(withValues(['m2', 'm2'], { op: 'binary', id: 2, t: 'bool', fn: 'eq', a: 0, b: 1 }), /eq takes two scalars or vectors of one type/)
  refused(withValues(['u32x2', 'u32x2'], { op: 'binary', id: 2, t: 'bool', fn: 'eq', a: 0, b: 1 }), /the result is boolx2, not bool/)
  refused(withValues(['bool', 'bool'], { op: 'binary', id: 2, t: 'bool', fn: 'lt', a: 0, b: 1 }), /lt takes two numbers of one type/)
  refused(withValues(['f32', 'f32'], { op: 'binary', id: 2, t: 'f32', fn: 'and', a: 0, b: 1 }), /and takes two integers or two bools of one type/)
  refused(withValues(['u32', 'u32'], { op: 'binary', id: 2, t: 'u32', fn: 'land', a: 0, b: 1 }), /land takes two bools of one type/)
  refused(withValues(['f32', 'f32'], { op: 'binary', id: 2, t: 'f32', fn: 'dot', a: 0, b: 1 }), /dot takes two number vectors of one type/)
  refused(withValues(['f32x4', 'f32x4'], { op: 'binary', id: 2, t: 'f32x4', fn: 'cross', a: 0, b: 1 }), /cross takes two f32x3/)
  refused(withValues(['i32x2', 'i32x2'], { op: 'binary', id: 2, t: 'f32', fn: 'distance', a: 0, b: 1 }), /distance takes two f32 values of one type/)
  refused(withValues(['f32', 'f32'], { op: 'binary', id: 2, t: 'f32', fn: 'reflect', a: 0, b: 1 }), /reflect takes two f32 vectors of one type/)
  refused(withValues(['i32', 'i32'], { op: 'binary', id: 2, t: 'i32', fn: 'pow', a: 0, b: 1 }), /pow takes two f32 values of one type/)
  verify(withValues(['f32x3', 'f32x3', 'f32'], { op: 'ternary', id: 3, t: 'f32x3', fn: 'mix', a: 0, b: 1, c: 2 }))
  verify(withValues(['boolx3', 'f32x3', 'f32x3'], { op: 'ternary', id: 3, t: 'f32x3', fn: 'choose', a: 0, b: 1, c: 2 }))
  verify(withValues(['bool', 'm2', 'm2'], { op: 'ternary', id: 3, t: 'm2', fn: 'choose', a: 0, b: 1, c: 2 }))
  refused(withValues(['boolx2', 'f32x3', 'f32x3'], { op: 'ternary', id: 3, t: 'f32x3', fn: 'choose', a: 0, b: 1, c: 2 }), /ternary: choose takes a bool \(or bools of the values' width\) and two values of one type/)
  refused(withValues(['boolx2', 'm2', 'm2'], { op: 'ternary', id: 3, t: 'm2', fn: 'choose', a: 0, b: 1, c: 2 }), /choose takes/)
  refused(withValues(['u32', 'f32', 'f32'], { op: 'ternary', id: 3, t: 'f32', fn: 'choose', a: 0, b: 1, c: 2 }), /choose takes/)
  refused(withValues(['f32x3', 'f32x3', 'f32x2'], { op: 'ternary', id: 3, t: 'f32x3', fn: 'mix', a: 0, b: 1, c: 2 }), /mix takes two f32 values of one type and a factor of that type or f32/)
  refused(withValues(['f32', 'f32', 'i32'], { op: 'ternary', id: 3, t: 'f32', fn: 'clamp', a: 0, b: 1, c: 2 }), /clamp takes three numbers of one type/)
  refused(withValues(['i32', 'i32', 'i32'], { op: 'ternary', id: 3, t: 'i32', fn: 'smoothstep', a: 0, b: 1, c: 2 }), /smoothstep takes three f32 values of one type/)
})

test('the exported typing functions refuse a function name outside their lists', () => {
  const no: Refuse = (rule) => { throw new Error(rule) }
  assert.throws(() => unaryType('cube' as never, 'f32', no), /"cube" is not a unary function/)
  assert.throws(() => binaryType('hypot' as never, 'f32', 'f32', no), /"hypot" is not a binary function/)
  assert.throws(() => ternaryType('lerp' as never, 'f32', 'f32', 'f32', no), /"lerp" is not a ternary function/)
  assert.throws(() => makeRule('f32', ['f32'], no), /make builds a vector or a grid, not f32/)
})

test('make, pick, lane, column, cast and bits', () => {
  verify(withValues(['f32x2', 'f32'], { op: 'make', id: 2, t: 'f32x3', args: [0, 1] }))
  verify(withValues(['f32'], { op: 'make', id: 1, t: 'f32x4', args: [0] }))
  verify(withValues(['f32x3', 'f32x3', 'f32x3'], { op: 'make', id: 3, t: 'm3', args: [0, 1, 2] }))
  verify(withValues(['f32', 'f32', 'f32', 'f32'], { op: 'make', id: 4, t: 'm2', args: [0, 1, 2, 3] }))
  refused(withValues(['f32x2', 'f32x2'], { op: 'make', id: 2, t: 'f32x3', args: [0, 1] }), /lens: body\[2\] make: the components of f32x2 f32x2 add up to 4, not the 3 of a f32x3/)
  refused(withValues(['f32x2', 'i32'], { op: 'make', id: 2, t: 'f32x3', args: [0, 1] }), /a f32x3 is made of f32 scalars and vectors, not f32x2 i32/)
  refused(withValues(['f32x2', 'f32x2'], { op: 'make', id: 2, t: 'm3', args: [0, 1] }), /a m3 is made of 3 f32x3 columns or 9 f32 scalars/)
  refused(withValues(['f32'], { op: 'make', id: 1, t: 'm2', args: [0] }), /a m2 is made of 2 f32x2 columns or 4 f32 scalars/)
  refused(withValues(['f32'], { op: 'make', id: 1, t: 'f32', args: [0] }), /make builds a vector or a grid, not f32/)
  refused(withValues(['f32'], { op: 'make', id: 1, t: 'f32x2', args: [] }), /add up to 0/)
  refused(withValues(['f32'], { op: 'make', id: 1, t: 'f32x2', args: new Array(17).fill(0) }), /the operands are a list of 1 to 16 values/)
  verify(withValues(['f32x4'], { op: 'pick', id: 1, t: 'f32x3', a: 0, lanes: [3, 3, 0] }))
  refused(withValues(['f32x2'], { op: 'pick', id: 1, t: 'f32', a: 0, lanes: [2] }), /lens: body\[1\] pick: 2 is not a lane of a f32x2/)
  refused(withValues(['f32x4'], { op: 'pick', id: 1, t: 'f32x4', a: 0, lanes: [0, 1, 2, 3, 0] }), /pick takes a list of 1 to 4 lanes/)
  refused(withValues(['f32'], { op: 'pick', id: 1, t: 'f32', a: 0, lanes: [0] }), /pick takes a vector, not f32/)
  refused(withValues(['f32x4'], { op: 'pick', id: 1, t: 'f32x3', a: 0, lanes: [0, 1] }), /the result is f32x2, not f32x3/)
  verify(withValues(['i32x3', 'i32'], { op: 'lane', id: 2, t: 'i32', a: 0, i: 1 }))
  refused(withValues(['i32x3', 'f32'], { op: 'lane', id: 2, t: 'i32', a: 0, i: 1 }), /lane: the lane index is an i32 or u32 scalar, not f32/)
  refused(withValues(['m2', 'u32'], { op: 'lane', id: 2, t: 'f32', a: 0, i: 1 }), /lane takes a vector, not m2/)
  verify(withValues(['m4'], { op: 'column', id: 1, t: 'f32x4', a: 0, i: 3 }))
  refused(withValues(['m3'], { op: 'column', id: 1, t: 'f32x3', a: 0, i: 3 }), /column: 3 is not a column of an m3/)
  refused(withValues(['m3'], { op: 'column', id: 1, t: 'f32x3', a: 0, i: '1' }), /"1" is not a column/)
  refused(withValues(['f32x3'], { op: 'column', id: 1, t: 'f32', a: 0, i: 0 }), /column takes a grid, not f32x3/)
  verify(withValues(['i32x3'], { op: 'cast', id: 1, t: 'boolx3', a: 0 }))
  refused(withValues(['f32x2'], { op: 'cast', id: 1, t: 'i32x3', a: 0 }), /cast: a cast keeps the width; f32x2 cannot become i32x3/)
  refused(withValues(['f32'], { op: 'cast', id: 1, t: 'f32', a: 0 }), /a cast changes the kind; f32 is already f32/)
  refused(withValues(['m2'], { op: 'cast', id: 1, t: 'i32', a: 0 }), /cast takes numbers and bools/)
  verify(withValues(['f32x2'], { op: 'bits', id: 1, t: 'i32x2', a: 0 }))
  refused(withValues(['bool'], { op: 'bits', id: 1, t: 'u32', a: 0 }), /bits: bits reinterprets f32, i32 and u32 values, not bool as u32/)
  refused(withValues(['u32'], { op: 'bits', id: 1, t: 'u32', a: 0 }), /bits changes the kind/)
  refused(withValues(['u32x2'], { op: 'bits', id: 1, t: 'f32', a: 0 }), /bits keeps the width/)
})

test('ports in the body, builtins and position', () => {
  mutation(vertex, (m) => { m.body[0].slot = 5 }, /lens: body\[0\] in: no input is declared at slot 5/)
  mutation(vertex, (m) => { m.body[0].t = 'f32x2' }, /lens: body\[0\] in: the result is f32x3, not f32x2/)
  mutation(vertex, (m) => { m.body[7].slot = 4 }, /lens: body\[7\] out: no output is declared at slot 4/)
  mutation(vertex, (m) => { m.body[9].a = 1 }, /lens: body\[9\] out: the output at slot 0 is f32x2, not f32/)
  mutation(compute, (m) => { m.body[0].name = 'vertex-index'; m.body[0].t = 'u32' }, /lens: body\[0\] builtin: vertex-index is a builtin of the vertex stage, not of the compute stage/)
  mutation(compute, (m) => { m.body[0].name = 'thread-id' }, /"thread-id" is not a builtin/)
  mutation(compute, (m) => { m.body[0].t = 'u32x2' }, /the result is u32x3, not u32x2/)
  mutation(fragment, (m) => { m.body.splice(1, 0, { op: 'position', a: 1 }) }, /lens: body\[1\] position: position is only in the vertex stage/)
  mutation(vertex, (m) => { m.body[5].a = 0 }, /lens: body\[5\] position: the position is f32x3, not f32x4/)
})

test('read and write: resource kinds, paths walked to a leaf of the right type, value-held indices', () => {
  mutation(vertex, (m) => { m.body[3].res = 1 }, /lens: body\[3\] read: resource 1 is not one of the module's 1 resources/)
  mutation(fragment, (m) => { m.body[3].res = 0 }, /lens: body\[3\] read: resource 0 is a image; read takes a uniform, storage or constants resource/)
  mutation(vertex, (m) => { m.body[3].path = [] }, /read: the path ends at a block or an array, not at a number type/)
  mutation(vertex, (m) => { m.body[3].path = [0, 0] }, /read: the path goes past the m4 it reached/)
  mutation(vertex, (m) => { m.body[3].path = [2] }, /read: the block has no field 2/)
  mutation(vertex, (m) => { m.body[3].path = 0 }, /read: the path is a list of steps/)
  mutation(vertex, (m) => { m.body[3].path = new Array(17).fill(0) }, /a path has at most 16 steps, not 17/)
  mutation(vertex, (m) => { m.body[3].path = [-1] }, /step 0 \(-1\) is not a constant index from 0 to 2147483647/)
  mutation(vertex, (m) => { m.body[3].t = 'f32x4' }, /read: the result is m4, not f32x4/)
  mutation(compute, (m) => { m.body[8].body[4].path = [1, 4] }, /lens: body\[8\].body\[4\] read: element 4 is outside the array/)
  mutation(compute, (m) => { m.body[2].path = [1, { at: 0 }, 0] }, /read: step 1 holds u32x3; an index held by a value is an i32 or u32 scalar/)
  mutation(compute, (m) => { m.body[2].path = [1, { at: 1, by: 2 }, 0] }, /step 1: it has no field "by"/)
  mutation(compute, (m) => { m.body[2].path = [1, 'x', 0] }, /step 1 is a constant index or an \{ at \} value/)
  mutation(compute, (m) => { m.body[2].path = [{ at: 1 }] }, /read: a block field is picked by a constant index/)
  mutation(compute, (m) => { m.body[2].path = [1, 0x80000000, 0] }, /step 1 \(2147483648\) is not a constant index/)
  verify({ ...compute(), body: [...compute().body.slice(0, 7)].map((i: Loose, k: number) => (k === 2 ? { ...i, path: [1, 0x7fffffff, 0] } : i)) })
  mutation(compute, (m) => { m.resources[0].writable = false }, /lens: body\[6\] write: resource 0 is not a writable storage block/)
  mutation(compute, (m) => { m.body[6].res = 2 }, /write: resource 2 is not a writable storage block/)
  mutation(compute, (m) => { m.body[6].a = 4; m.body[6].path = [0] }, /write: the value is f32x3, but the path leads to u32/)
  mutation(vertex, (m) => {
    m.resources.push({ kind: 'storage', set: 1, binding: 0, writable: true, block: { fields: [{ name: 'n', type: 'u32' }] } })
    m.body.push({ op: 'write', res: 1, path: [0], a: 5 })
  }, /lens: body\[10\] write: the vertex stage never writes a resource/)
})

test('sample, texel, put and extent: resource kinds, coordinates, layers, levels and stages', () => {
  mutation(fragment, (m) => { m.body[1].image = 2 }, /lens: body\[1\] sample: resource 2 is not a float image; sample reads a float image/)
  mutation(fragment, (m) => { m.body[1].sampler = 0 }, /sample: resource 0 is not a sampler/)
  mutation(fragment, (m) => { m.body.splice(1, 0, { op: 'lit', id: 13, t: 'f32', v: [0] }); m.body[2].uv = 13; m.ids = 14 }, /lens: body\[2\] sample: uv is f32, not f32x2/)
  mutation(fragment, (m) => { m.body[1].layer = 6; m.resources[0].dims = '2d-array' }, /sample: the layer %6 is used before it is defined/)
  mutation(fragment, (m) => { m.body[1].level = 3; m.body[1].layer = 3 }, /sample: a 2d image has no layers/)
  mutation(fragment, (m) => { m.body[1].level = 0 }, /sample: the level is f32x2, not f32/)
  mutation(fragment, (m) => { m.body[1].t = 'f32x3' }, /sample: the result is f32x4, not f32x3/)
  mutation(fragment, (m) => { m.resources[0].dims = '2d-array' }, /sample: a 2d-array image is read at a layer/)
  mutation(fragment, (m) => { delete m.body[9].layer }, /lens: body\[9\] texel: a 2d-array image is read at a layer/)
  mutation(fragment, (m) => { m.body[9].t = 'f32x4' }, /texel: the result is u32x4, not f32x4/)
  mutation(fragment, (m) => { m.body[9].at = 0 }, /texel: the position is f32x2, not i32x2 or u32x2/)
  mutation(fragment, (m) => { m.body[9].level = 3 }, /texel: the level is f32, not i32 or u32/)
  mutation(fragment, (m) => { m.body[9].image = 1 }, /texel: resource 1 is not an image; texel reads an image/)
  mutation(fragment, (m) => { m.resources[2].sample = 'depth' }, /texel: the result is f32, not u32x4/)
  mutation(fragment, (m) => { m.resources[2].sample = 'sint' }, /texel: the result is i32x4, not u32x4/)
  mutation(compute, (m) => { m.body[13].image = 0 }, /lens: body\[13\] put: resource 0 is not a storage image; put writes a storage image/)
  mutation(compute, (m) => { m.resources[1].format = 'r32u' }, /put: the value is f32x4, not u32x4/)
  mutation(compute, (m) => { m.resources[1].format = 'r32i' }, /put: the value is f32x4, not i32x4/)
  mutation(compute, (m) => { m.body[13].at = 1 }, /put: the position is u32, not i32x2 or u32x2/)
  mutation(compute, (m) => { m.body[10].image = 2 }, /lens: body\[10\] extent: resource 2 is not an image or a storage image/)
  mutation(compute, (m) => { m.body[10].level = 1 }, /extent: a storage image has one level; its extent takes no level/)
  mutation(fragment, (m) => { m.body.splice(2, 0, { op: 'extent', id: 13, t: 'u32x2', image: 0 }); m.ids = 14 }, /lens: body\[2\] extent: the extent of a sampled image is of a level/)
  verify({ ...fragment(), body: [...fragment().body.slice(0, 8), { op: 'extent', id: 13, t: 'u32x2', image: 2, level: 6 }], ids: 14 })
  mutation(vertex, (m) => {
    m.resources.push({ kind: 'storage-image', set: 1, binding: 0, format: 'rgba8' })
    m.body.push({ op: 'make', id: 7, t: 'u32x2', args: [5] }, { op: 'make', id: 8, t: 'f32x4', args: [1] }, { op: 'put', image: 1, at: 7, a: 8 })
    m.ids = 9
  }, /lens: body\[12\] put: put is only in the fragment and compute stages/)
})

test('implicit-level sampling and derivatives: fragment only, top level, before any instruction holding a return', () => {
  // Accepted where it is: after an if that holds no return.
  verify({ ...fragment(), body: [...fragment().body.slice(0, 7), { op: 'deriv', id: 13, t: 'f32x2', fn: 'width', a: 0 }, ...fragment().body.slice(7)], ids: 14 })
  mutation(fragment, (m) => {
    m.body[6].then = [{ op: 'return' }]
    m.body.splice(7, 0, { op: 'deriv', id: 13, t: 'f32x2', fn: 'dy', a: 0 })
    m.ids = 14
  }, /lens: body\[7\] deriv: deriv sits before any instruction that holds a return/)
  mutation(fragment, (m) => {
    m.body[6].then = [{ op: 'loop', body: [{ op: 'if', c: 5, then: [{ op: 'return' }], else: [] }, { op: 'break' }] }]
    m.body.splice(7, 0, { op: 'sample', id: 13, t: 'f32x4', image: 0, sampler: 1, uv: 0 })
    m.ids = 14
  }, /lens: body\[7\] sample: a sample without a level sits before any instruction that holds a return/)
  mutation(fragment, (m) => { m.body[6].then = [{ op: 'deriv', id: 13, t: 'f32x2', fn: 'dx', a: 0 }]; m.ids = 14 }, /lens: body\[6\].then\[0\] deriv: deriv sits at the top level of the body/)
  mutation(fragment, (m) => { m.body[6].else = [{ op: 'sample', id: 13, t: 'f32x4', image: 0, sampler: 1, uv: 0 }]; m.ids = 14 }, /lens: body\[6\].else\[0\] sample: a sample without a level sits at the top level/)
  // An explicit level may sit anywhere, in any stage.
  verify({ ...fragment(), body: fragment().body.map((i: Loose, k: number) => (k === 6 ? { ...i, else: [{ op: 'sample', id: 13, t: 'f32x4', image: 0, sampler: 1, uv: 0, level: 3 }] } : i)), ids: 14 })
  mutation(compute, (m) => { m.body.push({ op: 'deriv', id: 18, t: 'f32', fn: 'dx', a: 16 }); m.ids = 19 }, /lens: body\[14\] deriv: deriv is only in the fragment stage/)
  mutation(fragment, (m) => { m.body[2].a = 3; m.body[2].t = 'f32'; m.body[2].fn = 'dz' }, /deriv: "dz" is not a derivative \(dx, dy or width\)/)
  mutation(fragment, (m) => { m.body[2].a = 6 }, /deriv: the operand %6 is used before it is defined/)
  mutation(fragment, (m) => { m.body[2].t = 'f32' }, /deriv: the result is f32x2, not f32/)
  mutation(vertex, (m) => {
    m.resources.push({ kind: 'image', set: 1, binding: 0, sample: 'float', dims: '2d' }, { kind: 'sampler', set: 1, binding: 1 })
    m.body.push({ op: 'sample', id: 7, t: 'f32x4', image: 1, sampler: 2, uv: 6 })
    m.ids = 8
  }, /lens: body\[10\] sample: a sample without a level is only in the fragment stage/)
})

test('variables: var, get and set types', () => {
  mutation(fragment, (m) => { m.body[4].init = 0 }, /lens: body\[4\] var: the initial value is f32x2, not f32x4/)
  mutation(fragment, (m) => { m.body[11].t = 'f32' }, /lens: body\[11\] get: the result is f32x4, not f32/)
  mutation(fragment, (m) => { m.body[13].a = 3 }, /lens: body\[13\] set: the value is f32, not f32x4/)
  mutation(fragment, (m) => { m.body[11].v = 12 }, /get: the variable %12 is used before it is defined/)
})

test('control: if conditions, break and continue inside loops, block-ending ops last, discard in fragment, depth', () => {
  mutation(fragment, (m) => { m.body[6].c = 6 }, /lens: body\[6\] if: the condition %6 is used before it is defined/)
  mutation(fragment, (m) => { m.body[6].c = 3 }, /if: the condition is f32, not bool/)
  mutation(fragment, (m) => { delete m.body[6].else }, /if: it needs a field else/)
  mutation(fragment, (m) => { m.body[6].then = {} }, /lens: body\[6\].then: a block is a list of instructions/)
  mutation(fragment, (m) => { m.body[6].then = [{ op: 'break' }] }, /lens: body\[6\].then\[0\] break: break is only inside a loop/)
  mutation(fragment, (m) => { m.body[6].else = [{ op: 'continue' }] }, /lens: body\[6\].else\[0\] continue: continue is only inside a loop/)
  mutation(compute, (m) => { m.body[8].body[3].then.push({ op: 'discard' }) }, /lens: body\[8\].body\[3\].then\[0\] break: nothing may follow break in its block/)
  mutation(compute, (m) => { m.body[8].body.push({ op: 'lit', id: 18, t: 'f32', v: [0] }); m.ids = 19 }, /lens: body\[8\].body\[9\] continue: nothing may follow continue in its block/)
  mutation(fragment, (m) => { m.body.push({ op: 'discard' }) }, /lens: body\[16\] return: nothing may follow return in its block/)
  mutation(compute, (m) => { m.body.push({ op: 'discard' }) }, /lens: body\[14\] discard: discard is only in the fragment stage/)
  mutation(compute, (m) => { m.body[8].extra = [] }, /lens: body\[8\] loop: it has no field "extra"/)
  // Breaking out of a loop from inside an if is fine, and a return may sit anywhere at the end of a block.
  verify(bare([{ op: 'loop', body: [{ op: 'loop', body: [{ op: 'return' }] }, { op: 'break' }] }], 0))
  const deep = (levels: number): Loose => {
    let body: Loose[] = [{ op: 'break' }]
    for (let i = 0; i < levels - 1; i++) body = [{ op: 'loop', body }]
    return bare([{ op: 'loop', body }], 0)
  }
  verify(deep(32))
  refused(deep(33), /if and loop nest at most 32 deep/)
})

test('the instruction and id limits of LENS_LIMITS hold', () => {
  const many = (n: number): Loose => bare(Array.from({ length: n }, () => ({ op: 'discard' })), 0)
  refused({ ...many(LENS_LIMITS.instructions + 1), stage: 'fragment' }, /lens: body: the module holds more than 65536 instructions/)
  verify({ ...many(LENS_LIMITS.instructions), stage: 'fragment' })
  // Nested instructions count too.
  refused({ ...bare([{ op: 'loop', body: Array.from({ length: LENS_LIMITS.instructions }, () => ({ op: 'discard' })) }], 0), stage: 'fragment' }, /lens: body\[0\].body: the module holds more than 65536 instructions/)
  const lits = Array.from({ length: LENS_LIMITS.ids }, (_, id) => ({ op: 'lit', id, t: 'u32', v: [id] }))
  verify(bare(lits, LENS_LIMITS.ids))
})

test('hostile input: cycles, shared blocks, objects that raise when read, and junk anywhere only ever give a lens Fault', () => {
  // A body that contains itself is refused at the depth limit, not by a stack overflow.
  const body: Loose[] = []
  body.push({ op: 'loop', body })
  refused(bare(body, 0), /nest at most 32 deep/)
  // A block that contains itself is refused at the nesting limit.
  const selfish: Loose = { fields: [] }
  selfish.fields.push({ name: 'me', type: { struct: selfish } })
  refused(bare([], 0, [{ kind: 'storage', set: 0, binding: 0, writable: false, block: selfish }]), /nest at most 8 deep/)
  // One block object shared under many fields stands for a tree of 64^5 fields: refused at once, not walked.
  let shared: Loose = { fields: [{ name: 'x', type: 'f32' }] }
  for (let level = 0; level < 5; level++) shared = { fields: Array.from({ length: 64 }, (_, i) => ({ name: `f${i}`, type: { struct: shared } })) }
  refused(bare([], 0, [{ kind: 'storage', set: 0, binding: 0, writable: false, block: shared }]), /the module's blocks hold more than 1048576 fields in all/)
  // Objects whose fields raise when read.
  const raising = new Proxy({}, { get() { throw new TypeError('no') }, getOwnPropertyDescriptor() { throw new TypeError('no') }, ownKeys() { throw new RangeError('no') } })
  refused(raising, new RegExp(NOT_DATA))
  const getter = vertex()
  Object.defineProperty(getter.body[2], 'args', { get() { throw new Error('no') }, enumerable: true })
  refused(getter, new RegExp(NOT_DATA))
})

test('junk in any field of a valid module is refused with a lens Fault naming a rule, never a crash', () => {
  let seed = 12345
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 0x100000000
  }
  const junk: unknown[] = [null, undefined, -1, 0.5, 1e10, Number.NaN, '', 'x', [], {}, [0], { at: 0 }, true, 70_000, -0]
  // Every path to a leaf of the fixture.
  const leaves = (x: unknown, path: (string | number)[] = []): (string | number)[][] => {
    if (typeof x !== 'object' || x === null) return [path]
    const keys = Object.keys(x)
    return [path, ...keys.flatMap((k) => leaves((x as Loose)[k], [...path, Array.isArray(x) ? Number(k) : k]))]
  }
  let refusedCount = 0
  for (const make of [vertex, fragment, compute]) {
    for (const path of leaves(make())) {
      if (path.length === 0) continue
      for (let trial = 0; trial < 3; trial++) {
        const m = make()
        let at: Loose = m
        for (const k of path.slice(0, -1)) at = at[k]
        at[path[path.length - 1]] = junk[Math.floor(next() * junk.length)]
        try {
          verify(m)
        } catch (e) {
          assert.ok(isFault(e, 'lens'), `${path.join('.')}: ${String(e)}`)
          assert.ok(!e.message.includes(NOT_DATA), `${path.join('.')}: ${e.message}`)
          assert.match(e.message, /^lens: /)
          refusedCount++
        }
      }
    }
  }
  assert.ok(refusedCount > 500, String(refusedCount))
})

test('the fields that paths walk through are bounded, and a path walked before costs nothing again', () => {
  // A block of 266,304 fields held in three shared objects: each new path lays out the whole tree once.
  const leaf = { fields: Array.from({ length: 64 }, (_, i) => ({ name: `t${i}`, type: 'f32' })) }
  const mid = { fields: Array.from({ length: 64 }, (_, i) => ({ name: `s${i}`, type: { struct: leaf } })) }
  const top = { fields: Array.from({ length: 64 }, (_, i) => ({ name: `f${i}`, type: { struct: mid } })) }
  const reads = (n: number, distinct: number): Loose => bare(
    Array.from({ length: n }, (_, k) => ({ op: 'read', id: k, t: 'f32', res: 0, path: [k % distinct, ((k % distinct) * 7) % 64, ((k % distinct) * 13) % 64] })),
    n,
    [{ kind: 'storage', set: 0, binding: 0, writable: false, block: top }],
  )
  refused(reads(200, 64), /lens: body\[62\] read: the module's paths walk through more than 16777216 block fields/)
  verify(reads(4000, 40))
})

test('layoutBlock holds the uniform array rule at every depth, and lens.ts owns the kind lists and the field budget', () => {
  const nested = { fields: [{ name: 'a', type: { array: { array: 'f32', len: 4 }, len: 2 } }] } as const
  assert.throws(() => layoutBlock(nested, 'uniform'), (e: unknown) => isFault(e, 'lens') && /^field a\[\]: an array in a uniform block needs elements 16 bytes apart/.test(e.message))
  assert.deepEqual(layoutBlock(nested, 'storage'), { size: 32, align: 4, offsets: [0] })
  const wide = { fields: [{ name: 'b', type: { array: { array: 'f32x4', len: 2 }, len: 3 } }] } as const
  assert.deepEqual(layoutBlock(wide, 'uniform'), { size: 96, align: 16, offsets: [0] })
  assert.deepEqual(RESOURCE_KINDS, ['uniform', 'storage', 'constants', 'image', 'sampler', 'storage-image'])
  assert.deepEqual(SAMPLE_KINDS, ['float', 'uint', 'sint', 'depth'])
  assert.deepEqual(IMAGE_DIMS, ['2d', '2d-array'])
  assert.equal(LENS_LIMITS.blockFields, 1_048_576)
})
