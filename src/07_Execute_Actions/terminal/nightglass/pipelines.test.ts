// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins every rule of making shaders and pipelines: a Lens from words or from a module
 * (decoded, checked, and kept as a frozen copy), and a render or compute pipeline checked whole: vertex buffers and
 * attributes against the vertex lens, the values passed between stages, colour outputs against formats and the
 * fragment lens, blend, depth and raster state, the workgroup size, and every resource of every lens against the
 * pipeline layout.
 * What breaks if it is removed? A pipeline whose shader reads a binding its layout lacks, or an attribute no buffer
 * feeds, could reach a back end, with no test to say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BindingEntry, BindingLayout, ColorOutput, Lens, PipelineLayout, RenderPipelineInfo, VertexBufferLayout } from './api.ts'
import { encode } from './binary.ts'
import { arrayOf, lens } from './builder.ts'
import type { Format } from './formats.ts'
import type { LensModule } from './lens.ts'
import { ComputePipelineImpl, RenderPipelineImpl } from './pipelines.ts'
import { computeLens, fragmentLens, refuses, rig, texturedLens, vertexLens } from './harness.test.ts'
import type { Rig } from './harness.test.ts'

const BUFFERS: readonly VertexBufferLayout[] = [{ stride: 24, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }, { slot: 1, format: 'f32x4', offset: 8 }] }]

/** A device with a plain vertex and fragment lens and an empty pipeline layout. */
function setup(o: Parameters<typeof rig>[0] = {}): { readonly r: Rig; readonly vertex: Lens; readonly fragment: Lens; readonly layout: PipelineLayout; readonly base: RenderPipelineInfo } {
  const r = rig(o)
  const vertex = r.device.createLens(vertexLens(), 'v')
  const fragment = r.device.createLens(fragmentLens(), 'f')
  const layout = r.device.createPipelineLayout({ sets: [] })
  return { r, vertex, fragment, layout, base: { layout, vertex: { lens: vertex, buffers: BUFFERS }, fragment: { lens: fragment, outputs: [{ format: 'rgba8' }] } } }
}

const entries = (r: Rig, list: readonly BindingEntry[]): BindingLayout => r.device.createBindingLayout({ entries: list })

test('createLens from a module keeps a frozen copy the caller cannot change; from words it decodes', () => {
  const r = rig()
  const m = vertexLens()
  const copy = JSON.parse(JSON.stringify(m)) as { inputs: { slot: number }[] }
  const l = r.device.createLens(copy as unknown as LensModule, 'mine')
  copy.inputs[0].slot = 9
  assert.equal(l.module.inputs[0].slot, 0)
  assert.ok(Object.isFrozen(l.module) && Object.isFrozen(l.module.body))
  assert.deepEqual(l.module, m)
  assert.equal(l.stage, 'vertex')
  assert.equal(l.label, 'mine')
  assert.equal(r.fake.last('createLens').args[0], l.module)
  const fromWords = r.device.createLens(encode(computeLens()))
  assert.equal(fromWords.stage, 'compute')
  assert.deepEqual(fromWords.module, computeLens())
})

test('createLens refuses a malformed binary or an ill-formed module with code lens, naming the call', () => {
  const r = rig()
  const words = encode(fragmentLens())
  const cut = words.slice(0, words.length - 1)
  refuses(() => r.device.createLens(cut), 'lens', /^device 1 createLens: lens: decode: word \d+/)
  const bad = { ...fragmentLens(), ids: 0 }
  refuses(() => r.device.createLens(bad), 'lens', /^device 1 createLens: lens: /)
  refuses(() => r.device.createLens(null as never), 'lens', /a module is an object/)
  refuses(() => r.device.createLens(fragmentLens(), 3 as never), 'invalid', /the label is a string/)
  assert.equal(r.fake.named('createLens').length, 0)
})

test('a render pipeline fills in every default and hands the back end its handles', () => {
  const { r, base, layout, vertex, fragment } = setup()
  const p = r.device.createRenderPipeline({ ...base, label: 'tri' })
  assert.ok(p instanceof RenderPipelineImpl)
  assert.equal(p.layout, layout)
  assert.equal(p.label, 'tri')
  assert.deepEqual(p.info, {
    layout,
    vertex: { lens: vertex, buffers: [{ stride: 24, rate: 'vertex', attributes: [{ slot: 0, format: 'f32x2', offset: 0 }, { slot: 1, format: 'f32x4', offset: 8 }] }] },
    fragment: { lens: fragment, outputs: [{ format: 'rgba8', mask: 15 }] },
    topology: 'triangles',
    cull: 'none',
    front: 'ccw',
    samples: 1,
    label: 'tri',
  })
  assert.ok(Object.isFrozen(p.info))
  assert.deepEqual(p.colors, ['rgba8'])
  assert.equal(p.depth, null)
  assert.deepEqual(p.buffers.map((b) => b.reach), [24])
  const call = r.fake.last('createRenderPipeline').args
  assert.equal(call[0], p.info)
  assert.deepEqual([(call[1] as { kind: string }).kind, (call[2] as { kind: string }).kind, (call[3] as { kind: string }).kind], ['pipeline layout', 'lens', 'lens'])
  // A depth-only pipeline has no fragment stage.
  const depthOnly = r.device.createRenderPipeline({ layout, vertex: base.vertex, depth: { format: 'depth32f', write: true, compare: 'less' } })
  assert.equal(r.fake.last('createRenderPipeline').args[3], null)
  assert.deepEqual((depthOnly as RenderPipelineImpl).colors, [])
  assert.equal((depthOnly as RenderPipelineImpl).depth, 'depth32f')
  assert.deepEqual(depthOnly.info.depth, { format: 'depth32f', write: true, compare: 'less', unclipped: false })
})

test('the stages\' lenses: right stage, alive, of this device', () => {
  const { r, base, vertex, fragment } = setup()
  refuses(() => r.device.createRenderPipeline({ ...base, layout: {} as never }), 'invalid', /the layout is not a PipelineLayout/)
  refuses(() => r.device.createRenderPipeline({ ...base, vertex: { lens: fragment, buffers: BUFFERS } }), 'mismatch', /lens "f" is a fragment lens, not a vertex one/)
  refuses(() => r.device.createRenderPipeline({ ...base, fragment: { lens: vertex, outputs: [] } }), 'mismatch', /lens "v" is a vertex lens, not a fragment one/)
  refuses(() => r.device.createRenderPipeline({ ...base, vertex: undefined } as never), 'invalid', /the vertex stage is an object/)
  refuses(() => r.device.createRenderPipeline({ ...base, vertex: { lens: vertex, buffers: BUFFERS, step: 1 } } as never), 'invalid', /the vertex stage has no field "step"/)
  const other = rig().device.createLens(vertexLens())
  refuses(() => r.device.createRenderPipeline({ ...base, vertex: { lens: other, buffers: BUFFERS } }), 'mismatch', /belongs to another device/)
  fragment.destroy()
  refuses(() => r.device.createRenderPipeline(base), 'lifetime', /lens "f" is destroyed/)
})

test('vertex buffers and attributes: limits, strides, slots, formats and offsets', () => {
  const { r, base, vertex } = setup()
  const withBuffers = (buffers: readonly VertexBufferLayout[]): unknown => r.device.createRenderPipeline({ ...base, vertex: { lens: vertex, buffers } })
  const pos = { slot: 0, format: 'f32x2', offset: 0 } as const
  const col = { slot: 1, format: 'f32x4', offset: 8 } as const
  refuses(() => withBuffers(Array.from({ length: 9 }, () => ({ stride: 4, attributes: [] }))), 'limit', /9 vertex buffers is more than the device allows, 8/)
  refuses(() => withBuffers([{ stride: 26, attributes: [pos, col] }]), 'invalid', /vertex buffer 0: the stride 26 is not a multiple of 4/)
  refuses(() => withBuffers([{ stride: 2052, attributes: [pos, col] }]), 'limit', /the stride 2052 is more than the device allows, 2048/)
  refuses(() => withBuffers([{ stride: 24, rate: 'primitive' as never, attributes: [pos, col] }]), 'invalid', /the rate "primitive"/)
  refuses(() => withBuffers([{ stride: 24, attributes: [pos, { ...col, slot: 16 }] }]), 'limit', /attribute 1: slot 16 is past the device's highest, 15/)
  refuses(() => withBuffers([{ stride: 24, attributes: [pos, { ...col, slot: 0 }] }]), 'invalid', /slot 0 is fed by two attributes/)
  refuses(() => withBuffers([{ stride: 8, attributes: [pos] }, { stride: 16, attributes: [{ ...col, slot: 0, offset: 0 }] }]), 'invalid', /vertex buffer 1 attribute 0: slot 0 is fed by two attributes/)
  refuses(() => withBuffers([{ stride: 24, attributes: [pos, { ...col, format: 'f16x4' as never }] }]), 'invalid', /the format "f16x4"/)
  refuses(() => withBuffers([{ stride: 24, attributes: [pos, { ...col, offset: 6 }] }]), 'invalid', /offset 6 is not a multiple of 4/)
  refuses(() => withBuffers([{ stride: 20, attributes: [pos, col] }]), 'invalid', /a f32x4 at offset 8 ends at byte 24, past the 20 bytes of the stride/)
  refuses(() => withBuffers([{ stride: 0, attributes: [pos, { ...col, offset: 2040 }] }]), 'invalid', /ends at byte 2056, past the 2048 bytes of the largest stride/)
  refuses(() => withBuffers([{ stride: 24, attributes: [pos] }]), 'mismatch', /lens "v" reads input slot 1, which no attribute feeds/)
  refuses(() => withBuffers([{ stride: 24, attributes: [pos, { ...col, format: 'u32x4' }] }]), 'mismatch', /input slot 1 of lens "v" is f32x4, but its attribute is u32x4, which gives u32x4/)
  refuses(() => withBuffers([{ stride: 24, attributes: [{ ...pos, format: 'f32x3' }, col] }]), 'mismatch', /is f32x2, but its attribute is f32x3/)
  // unorm8x4 feeds an f32x4; extra attributes no input reads are fine; stride 0 repeats one element.
  withBuffers([{ stride: 12, attributes: [pos, { slot: 1, format: 'unorm8x4', offset: 8 }] }])
  withBuffers([{ stride: 0, attributes: [pos, { ...col, offset: 2032 }, { slot: 5, format: 'i32', offset: 16 }] }])
  const p = withBuffers([{ stride: 8, attributes: [pos] }, { stride: 32, rate: 'instance', attributes: [{ ...col, offset: 16 }] }]) as RenderPipelineImpl
  assert.deepEqual(p.buffers.map((b) => [b.rate, b.reach]), [['vertex', 8], ['instance', 32]])
})

test('values passed between the stages match by slot, type and flatness, within the device\'s limit', () => {
  const { r, base, vertex } = setup({ limits: { interStage: 2 } })
  const frag = (build: (b: ReturnType<typeof lens>) => void): Lens => {
    const b = lens('fragment')
    build(b)
    return r.device.createLens(b.finish())
  }
  const missing = frag((b) => b.out(b.output(0, 'f32x4'), b.input(3, 'f32x4')))
  refuses(() => r.device.createRenderPipeline({ ...base, fragment: { lens: missing, outputs: [{ format: 'rgba8' }] } }), 'mismatch', /reads slot 3, which lens "v" does not write/)
  const narrow = frag((b) => b.out(b.output(0, 'f32x4'), b.make('f32x4', b.input(0, 'f32x2'), 0, 1)))
  refuses(() => r.device.createRenderPipeline({ ...base, fragment: { lens: narrow, outputs: [{ format: 'rgba8' }] } }), 'mismatch', /slot 0 is f32x4 from lens "v" but f32x2 in lens \d+/)
  const flat = frag((b) => b.out(b.output(0, 'f32x4'), b.input(0, 'f32x4', { flat: true })))
  refuses(() => r.device.createRenderPipeline({ ...base, fragment: { lens: flat, outputs: [{ format: 'rgba8' }] } }), 'mismatch', /slot 0 is f32x4 from lens "v" but f32x4 flat in lens/)
  const vb = lens('vertex')
  vb.position(vb.make('f32x4', vb.input(0, 'f32x2'), 0, 1))
  for (let s = 0; s < 3; s++) vb.out(vb.output(s, 'f32'), 1)
  const wide = r.device.createLens(vb.finish())
  refuses(() => r.device.createRenderPipeline({ ...base, vertex: { lens: wide, buffers: [{ stride: 8, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }] }] } }), 'limit', /passes 3 values to the fragment stage; the device allows 2/)
  // The same vertex lens is fine without a fragment stage.
  r.device.createRenderPipeline({ layout: base.layout, vertex: { lens: wide, buffers: [{ stride: 8, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }] }] }, depth: { format: 'depth16' } })
  assert.ok(vertex.module.outputs.length === 1)
})

test('colour outputs: count, format, mask, blend, and the fragment lens output each needs', () => {
  const { r, base, fragment } = setup()
  const outputs = (list: readonly (ColorOutput | null)[], lensUsed: Lens = fragment): unknown => r.device.createRenderPipeline({ ...base, fragment: { lens: lensUsed, outputs: list } })
  refuses(() => outputs(Array.from({ length: 9 }, () => null)), 'limit', /9 colour outputs is more than the device allows, 8/)
  refuses(() => outputs([{ format: 'rgb8' as never }]), 'invalid', /output 0: the format "rgb8"/)
  refuses(() => outputs([{ format: 'depth16' }]), 'invalid', /depth16 cannot be a colour attachment/)
  refuses(() => outputs([{ format: 'rgba8', mask: 16 }]), 'invalid', /the write mask 16 has bits past the four channels/)
  refuses(() => outputs([{ format: 'rgba8', mask: 1.5 }]), 'invalid', /the write mask 1.5/)
  refuses(() => outputs([null, { format: 'rgba8' }]), 'mismatch', /output 1: the output writes rgba8, but lens "f" has no output at slot 1/)
  refuses(() => outputs([{ format: 'r32u' }]), 'mismatch', /r32u takes u32 values of at least 1 channel, and lens "f" writes f32x4 at slot 0/)
  const b = lens('fragment')
  b.out(b.output(0, 'f32x2'), b.pick(b.input(0, 'f32x4'), 'xy'))
  const two = r.device.createLens(b.finish())
  refuses(() => outputs([{ format: 'rgba8' }], two), 'mismatch', /rgba8 takes f32 values of at least 4 channels, and lens \d+ writes f32x2/)
  outputs([{ format: 'rg8' }], two)
  outputs([{ format: 'r16f' }], two)
  // A mask of 0 writes nothing, so it needs no lens output; a null slot is empty.
  outputs([{ format: 'rgba8' }, { format: 'r32u', mask: 0 }, null])
  refuses(() => outputs([{ format: 'rgba32f', blend: { color: { src: 'one', dst: 'zero' }, alpha: { src: 'one', dst: 'zero' } } }]), 'invalid', /rgba32f cannot be blended into/)
  refuses(() => outputs([{ format: 'rgba8', blend: { color: { src: 'two', dst: 'zero' }, alpha: { src: 'one', dst: 'zero' } } as never }]), 'invalid', /the colour blend source factor "two"/)
  refuses(() => outputs([{ format: 'rgba8', blend: { color: { src: 'one', dst: 'zero', op: 'xor' }, alpha: { src: 'one', dst: 'zero' } } as never }]), 'invalid', /the colour blend operation "xor"/)
  refuses(() => outputs([{ format: 'rgba8', blend: { color: { src: 'one', dst: 'zero' } } as never }]), 'invalid', /alpha blend is an object/)
  refuses(() => outputs([{ format: 'rgba8', blend: { color: { src: 'src-alpha', dst: 'one', op: 'max' }, alpha: { src: 'one', dst: 'one' } } }]), 'invalid', /a max colour blend takes the factor one on both sides, not src-alpha and one/)
  const p = outputs([{ format: 'rgba8', mask: 7, blend: { color: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, alpha: { src: 'one', dst: 'one', op: 'min' } } }]) as RenderPipelineImpl
  assert.deepEqual(p.info.fragment?.outputs[0], { format: 'rgba8', mask: 7, blend: { color: { src: 'src-alpha', dst: 'one-minus-src-alpha', op: 'add' }, alpha: { src: 'one', dst: 'one', op: 'min' } } })
})

test('colour outputs take at most limits.colorBytes bytes per sample, counted slot by slot as WebGPU counts them, whatever their masks', () => {
  const { r, base, fragment } = setup()
  const outputs = (list: readonly (ColorOutput | null)[]): unknown => r.device.createRenderPipeline({ ...base, fragment: { lens: fragment, outputs: list } })
  // A slot that writes nothing still holds an attachment, so it counts.
  const quiet = (format: Format): ColorOutput => ({ format, mask: 0 })
  const many = (n: number, format: Format): ColorOutput[] => Array.from({ length: n }, () => quiet(format))
  refuses(() => outputs([{ format: 'rgba32f' }, ...many(2, 'rgba32f')]), 'limit', /^device \d+ createRenderPipeline: the colour outputs take 48 bytes per sample, more than the device allows, 32$/)
  refuses(() => outputs([{ format: 'rgba8' }, ...many(4, 'rgba8')]), 'limit', /the colour outputs take 40 bytes per sample/)
  refuses(() => outputs([{ format: 'bgra8' }, ...many(7, 'bgra8-srgb')]), 'limit', /the colour outputs take 64 bytes per sample/)
  refuses(() => outputs([{ format: 'rgba16f' }, ...many(4, 'rgba16f')]), 'limit', /the colour outputs take 40 bytes per sample/)
  refuses(() => outputs([{ format: 'r8' }, ...many(2, 'rgba32f')]), 'limit', /the colour outputs take 36 bytes per sample/)
  refuses(() => outputs([{ format: 'rgba32f' }, quiet('rgba32f'), quiet('r8')]), 'limit', /the colour outputs take 33 bytes per sample/)
  outputs([{ format: 'rgba32f' }, null, quiet('rgba32f')])
  outputs([{ format: 'rgba8' }, quiet('rgba8-srgb'), quiet('bgra8'), quiet('bgra8-srgb')])
  // 1, then 2 + 2, 4 + 4, 8 + 8, 16 + 4, 20 + 8, 28 + 2: thirty bytes.
  outputs([{ format: 'r8' }, quiet('r16f'), quiet('rg16f'), quiet('rgba16f'), quiet('r32f'), quiet('rg32f'), quiet('rg8')])
  const low = setup({ limits: { colorBytes: 16 } })
  const lowOutputs = (list: readonly (ColorOutput | null)[]): unknown => low.r.device.createRenderPipeline({ ...low.base, fragment: { lens: low.fragment, outputs: list } })
  refuses(() => lowOutputs([{ format: 'rgba8' }, quiet('rgba8'), quiet('r8')]), 'limit', /take 17 bytes per sample, more than the device allows, 16/)
  lowOutputs([{ format: 'rgba8' }, quiet('rgba8')])
})

test('raster and depth state: known values, a depth format, and unclipped only with its feature', () => {
  const { r, base } = setup({ features: [] })
  refuses(() => r.device.createRenderPipeline({ ...base, topology: 'lines' as never }), 'invalid', /the topology "lines" is not one of triangles, triangle-strip/)
  refuses(() => r.device.createRenderPipeline({ ...base, cull: 'both' as never }), 'invalid', /the cull mode "both"/)
  refuses(() => r.device.createRenderPipeline({ ...base, front: 'left' as never }), 'invalid', /the front winding "left"/)
  refuses(() => r.device.createRenderPipeline({ ...base, samples: 8 as never }), 'invalid', /the sample count 8 is not 1 or 4/)
  refuses(() => r.device.createRenderPipeline({ ...base, depth: { format: 'rgba8' } }), 'invalid', /rgba8 is not a depth format/)
  refuses(() => r.device.createRenderPipeline({ ...base, depth: { format: 'depth16', compare: 'lt' as never } }), 'invalid', /the depth compare "lt"/)
  refuses(() => r.device.createRenderPipeline({ ...base, depth: { format: 'depth16', write: 'yes' as never } }), 'invalid', /depth write is true or false/)
  refuses(() => r.device.createRenderPipeline({ ...base, depth: { format: 'depth16', unclipped: true } }), 'feature', /unclipped depth needs the depth-unclipped feature/)
  refuses(() => r.device.createRenderPipeline({ ...base, stencil: {} } as never), 'invalid', /has no field "stencil"/)
  const p = r.device.createRenderPipeline({ ...base, topology: 'triangle-strip', cull: 'back', front: 'cw', samples: 4, depth: { format: 'depth16' } })
  assert.deepEqual([p.info.topology, p.info.cull, p.info.front, p.info.samples], ['triangle-strip', 'back', 'cw', 4])
  assert.deepEqual(p.info.depth, { format: 'depth16', write: false, compare: 'always', unclipped: false })
  const withFeature = setup({ features: ['depth-unclipped'] })
  withFeature.r.device.createRenderPipeline({ ...withFeature.base, depth: { format: 'depth32f', unclipped: true } })
})

test('lens resources against the pipeline layout: set, binding, stage and kind', () => {
  const r = rig()
  const vertex = r.device.createLens(vertexLens())
  const tex = r.device.createLens(texturedLens())
  const good: BindingEntry[] = [
    { binding: 0, kind: 'uniform', stages: ['fragment'] },
    { binding: 1, kind: 'image', stages: ['fragment'] },
    { binding: 2, kind: 'sampler', stages: ['fragment'] },
  ]
  const make = (list: readonly BindingEntry[] | null): unknown => r.device.createRenderPipeline({
    layout: r.device.createPipelineLayout({ sets: list === null ? [] : [entries(r, list)] }),
    vertex: { lens: vertex, buffers: BUFFERS },
    fragment: { lens: tex, outputs: [{ format: 'rgba8' }] },
  })
  const p = make(good) as RenderPipelineImpl
  assert.deepEqual(p.sets, [0])
  assert.deepEqual(p.uses, [{ set: 0, binding: 0, minSize: 16 }, { set: 0, binding: 1, minSize: 0 }, { set: 0, binding: 2, minSize: 0 }])
  refuses(() => make(null), 'mismatch', /resource 0 of lens \d+ \(uniform at set 0 binding 0\): pipeline layout \d+ has 0 sets/)
  refuses(() => make(good.slice(1)), 'mismatch', /binding layout \d+ has no binding 0/)
  refuses(() => make([{ ...good[0], stages: ['vertex'] }, good[1], good[2]]), 'mismatch', /the entry does not list the fragment stage/)
  refuses(() => make([{ binding: 0, kind: 'storage-read', stages: ['fragment'] }, good[1], good[2]]), 'mismatch', /the lens wants a uniform entry, and the entry is storage-read/)
  refuses(() => make([good[0], { ...good[1], sample: 'depth' }, good[2]]), 'mismatch', /the lens wants an image entry \(float, 2d\), and the entry is image \(depth, 2d\)/)
  refuses(() => make([good[0], { ...good[1], dims: '2d-array' }, good[2]]), 'mismatch', /\(float, 2d-array\)/)
  refuses(() => make([good[0], good[1], { binding: 2, kind: 'image', stages: ['fragment'] }]), 'mismatch', /the lens wants a sampler entry, and the entry is image/)
  // An unfiltered image read by a sample instruction needs a sampler entry that never filters.
  refuses(() => make([good[0], { ...good[1], unfiltered: true }, good[2]]), 'mismatch', /samples resource 1, an unfiltered image, through resource 2, whose entry may filter/)
  make([good[0], { ...good[1], unfiltered: true }, { ...good[2], filtering: false }])
  make([good[0], good[1], { ...good[2], filtering: false }])
})

test('storage, storage images and constants against the layout', () => {
  const r = rig()
  const comp = r.device.createLens(computeLens())
  const pipe = (list: readonly BindingEntry[], lensUsed: Lens = comp, constants?: { readonly size: number; readonly stages: readonly ('vertex' | 'fragment' | 'compute')[] }): unknown =>
    r.device.createComputePipeline({ layout: r.device.createPipelineLayout({ sets: [entries(r, list)], constants }), lens: lensUsed })
  refuses(() => pipe([{ binding: 0, kind: 'storage-read', stages: ['compute'] }]), 'mismatch', /the lens wants a storage entry \(it writes\), and the entry is storage-read/)
  const p = pipe([{ binding: 0, kind: 'storage', stages: ['compute'] }]) as ComputePipelineImpl
  assert.deepEqual(p.uses, [{ set: 0, binding: 0, minSize: 0 }])
  // A read-only storage block binds to storage or storage-read; its fixed part is what a binding must hold.
  const b = lens('compute', { group: [1, 1, 1] })
  const ro = b.storage(0, 0, { count: 'u32', pad: 'u32', items: arrayOf('f32x4') })
  const out = b.storageImage(0, 1, 'rgba8')
  b.put(out, b.u32x2(0, 0), b.make('f32x4', b.read(ro, 'items', 0)))
  const k = b.constants({ scale: 'f32' })
  b.read(k, 'scale')
  const reader = r.device.createLens(b.finish())
  const set: BindingEntry[] = [{ binding: 0, kind: 'storage-read', stages: ['compute'] }, { binding: 1, kind: 'storage-image', stages: ['compute'], format: 'rgba8' }]
  const q = pipe(set, reader, { size: 16, stages: ['compute'] }) as ComputePipelineImpl
  assert.deepEqual(q.uses, [{ set: 0, binding: 0, minSize: 16 }, { set: 0, binding: 1, minSize: 0 }])
  pipe([{ ...set[0], kind: 'storage' }, set[1]], reader, { size: 4, stages: ['compute'] })
  refuses(() => pipe([set[0], { ...set[1], format: 'r32f' }], reader, { size: 16, stages: ['compute'] }), 'mismatch', /the lens wants a storage-image entry \(rgba8\), and the entry is storage-image \(r32f\)/)
  refuses(() => pipe(set, reader), 'mismatch', /\(constants\): pipeline layout \d+ has no inline constants/)
  refuses(() => pipe(set, reader, { size: 4, stages: ['vertex'] }), 'mismatch', /the constants of pipeline layout \d+ are not read by the compute stage/)
  const big = lens('compute', { group: [1, 1, 1] })
  big.read(big.constants({ a: 'f32x4', b: 'f32x4' }), 'b')
  refuses(() => pipe([], r.device.createLens(big.finish()), { size: 16, stages: ['compute'] }), 'mismatch', /the block takes 32 bytes, and pipeline layout \d+ has 16 bytes of constants/)
})

test('a block larger than its binding kind\'s range is refused', () => {
  const r = rig({ limits: { uniformRange: 256, storageRange: 1024 } })
  const b = lens('fragment')
  b.out(b.output(0, 'f32x4'), b.read(b.uniform(0, 0, { rows: arrayOf('f32x4', 17) }), 'rows', 0))
  const fat = r.device.createLens(b.finish())
  const v = r.device.createLens(vertexLens())
  const layout = r.device.createPipelineLayout({ sets: [entries(r, [{ binding: 0, kind: 'uniform', stages: ['fragment'] }])] })
  refuses(() => r.device.createRenderPipeline({ layout, vertex: { lens: v, buffers: BUFFERS }, fragment: { lens: fat, outputs: [{ format: 'rgba8' }] } }), 'limit', /the block takes 272 bytes, more than a uniform binding may cover, 256/)
  const c = lens('compute', { group: [1, 1, 1] })
  const s = c.storage(0, 0, { rows: arrayOf('f32x4', 65), tail: arrayOf('f32') }, { writable: true })
  c.write(s, ['tail', 0], 1)
  const slayout = r.device.createPipelineLayout({ sets: [entries(r, [{ binding: 0, kind: 'storage', stages: ['compute'] }])] })
  refuses(() => r.device.createComputePipeline({ layout: slayout, lens: r.device.createLens(c.finish()) }), 'limit', /the block takes 1040 bytes, more than a storage binding may cover, 1024/)
})

test('a compute pipeline: a compute lens whose workgroup fits the device', () => {
  const r = rig({ limits: { groupSize: [32, 256, 64], groupInvocations: 128 } })
  const layout = r.device.createPipelineLayout({ sets: [entries(r, [{ binding: 0, kind: 'storage', stages: ['compute'] }])] })
  refuses(() => r.device.createComputePipeline({ layout, lens: r.device.createLens(computeLens([64, 1, 1])) }), 'limit', /has a workgroup 64 wide along x; the device allows 32/)
  refuses(() => r.device.createComputePipeline({ layout, lens: r.device.createLens(computeLens([16, 16, 1])) }), 'limit', /has 256 invocations per workgroup; the device allows 128/)
  refuses(() => r.device.createComputePipeline({ layout, lens: r.device.createLens(vertexLens()) }), 'mismatch', /is a vertex lens, not a compute one/)
  refuses(() => r.device.createComputePipeline({ layout, lens: r.device.createLens(computeLens([8, 8, 1])), group: 1 } as never), 'invalid', /has no field "group"/)
  const lensUsed = r.device.createLens(computeLens([8, 8, 2]))
  const p = r.device.createComputePipeline({ layout, lens: lensUsed, label: 'double' })
  assert.ok(p instanceof ComputePipelineImpl)
  assert.equal(p.lens, lensUsed)
  assert.equal(p.layout, layout)
  assert.equal(p.label, 'double')
  assert.deepEqual(p.sets, [0])
  const call = r.fake.last('createComputePipeline').args
  assert.deepEqual(call.map((h) => (h as { kind: string }).kind), ['pipeline layout', 'lens'])
  // A destroyed lens or layout leaves the pipelines made from them working.
  lensUsed.destroy()
  layout.destroy()
  assert.equal(p.destroyed, false)
})
