// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the ordering checker: for every rule of the spec's Ordering section, a smallest
 * submit that breaks it and is refused with the right code and a sentence naming the command, the resource and what
 * is missing, beside the same submit with the right barrier, layout or semaphore, accepted. It pins what each command
 * touches, how stages and accesses are covered, that a refused submit (by the checker or by the back end) changes
 * nothing, that the state carries over from submit to submit and queue to queue, the host's rule for invalidate(),
 * and a seeded run of random copies and barriers against a small model of the rules. It pins the checker's costs at a
 * scale where a state per level and layer, or a memory barrier or wait applied to every unit, would take minutes. It
 * ends with three frames of a real renderer's work, every barrier in place.
 * What breaks if it is removed? A checker that let a missing barrier through, or refused a correct frame, would go
 * unnoticed, and an app would draw right on the reference renderer and wrong on a GPU; one whose costs grew with
 * every unit it tracks could stall a submit or run the host out of memory.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  Access, BarrierInfo, Buffer, CommandList, Image, ImageBarrier, ImageLayout, MemoryBarrier, PipeStage, Range, RenderPipeline, Scope, View,
  VertexBufferLayout,
} from './api.ts'
import { arrayOf, lens } from './builder.ts'
import { ACCESSES, PIPE_STAGES } from './commands.ts'
import type { LensModule } from './lens.ts'
import type { MemoryImpl } from './memory.ts'
import { ORDER_STAGES, READ_ACCESSES, WRITE_ACCESSES, hostRead } from './order.ts'
import { HEAP_HOST, KIND, buffer, fragmentLens, image, imageView, refuses, rig, texturedLens, vertexLens } from './harness.test.ts'
import type { Rig } from './harness.test.ts'

// ---------------------------------------------------------------------------------------------------
// Helpers

const POS = { slot: 0, format: 'f32x2', offset: 0 } as const
const COLOR = { slot: 1, format: 'f32x4', offset: 8 } as const
const BUFFERS: readonly VertexBufferLayout[] = [{ stride: 24, attributes: [POS, COLOR] }]

const at = (stages: readonly PipeStage[], access: readonly Access[] = []): Scope => ({ stages, access })
const edge = (before: Scope, after: Scope): MemoryBarrier => ({ before, after })
const FULL = edge(at(['all'], ['any-write']), at(['all'], ['any-read', 'any-write']))
const COPIED = at(['copy'], ['copy-write'])
const NOTHING = at(['top'])

function move(image: Image, from: ImageLayout, to: ImageLayout, before: Scope, after: Scope, o: { readonly levels?: Range; readonly layers?: Range } = {}): ImageBarrier {
  return { image, from, to, before, after, ...o }
}

/** A ready list labelled `label`, from a new arena of the group. */
function recorded(r: Rig, label: string, body: (l: CommandList) => void, group = 0): CommandList {
  const l = r.device.createCommandArena({ group }).allocate(label)
  l.begin()
  body(l)
  l.end()
  return l
}

/** Submits the lists as one submission on queue 0.0. */
const go = (r: Rig, ...lists: CommandList[]): void => r.device.queue(0, 0).submit([{ lists }])

/** The opening words of a refusal at command n of list "frame" in submission s. */
const cmd = (n: number, c: string, label = 'frame', s = 0, j = 0): string => `^queue 0\\.0 submit: submissions\\[${s}\\] lists\\[${j}\\]: command list "${label}" command ${n} \\(${c}\\): `
const re = (head: string, rest: string): RegExp => new RegExp(head + rest.replace(/[()[\].?]/g, (m) => `\\${m}`))

/** A device with an upload buffer, a vertex buffer, an 8 x 8 canvas and a plain pipeline that draws into it. */
function scene(o: { readonly checks?: boolean } = {}) {
  const r = rig(o)
  const staging = buffer(r, 4096, ['copy-src'], KIND.upload, 'staging')
  const vertices = buffer(r, 72, ['vertex', 'copy-dst'], KIND.device, 'vertices')
  const canvas = imageView(r, { format: 'rgba8', width: 8, height: 8, use: ['color', 'copy-src', 'sampled'], label: 'canvas' })
  const empty = r.device.createPipelineLayout({ sets: [] })
  const plain = r.device.createRenderPipeline({
    layout: empty,
    vertex: { lens: r.device.createLens(vertexLens()), buffers: BUFFERS },
    fragment: { lens: r.device.createLens(fragmentLens()), outputs: [{ format: 'rgba8' }] },
    label: 'plain',
  })
  return { r, staging, vertices, canvas, empty, plain }
}
type Scene = ReturnType<typeof scene>

/** Moves the canvas out of blank, begins a pass that clears it and binds the pipeline and the vertex buffer. */
function openPass(s: Scene, l: CommandList, pipeline: RenderPipeline = s.plain): void {
  l.barrier({ images: [move(s.canvas.image, 'blank', 'color', NOTHING, at(['color'], ['color-write']))] })
  l.beginPass({ colors: [{ view: s.canvas, load: 'clear', store: 'keep' }] })
  l.bindPipeline(pipeline)
  l.bindVertices(0, [{ buffer: s.vertices }])
}

const upload = (s: Scene, l: CommandList, dst: Buffer = s.vertices, size = 72): void => l.copyBuffer(s.staging, dst, [{ from: 0, to: 0, size }])

/** A compute lens that writes red into a storage image at set 0 binding 0. */
function painterLens(): LensModule {
  const b = lens('compute', { group: [8, 8, 1] })
  const img = b.storageImage(0, 0, 'rgba8')
  b.put(img, b.pick(b.builtin('global-id'), 'xy'), b.f32x4(1, 0, 0, 1))
  return b.finish()
}

/** A fragment lens that adds one to item 0 of a writable storage block at set 0 binding 0. */
function tallyLens(): LensModule {
  const b = lens('fragment')
  const color = b.input(0, 'f32x4')
  const counts = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
  b.write(counts, ['items', 0], b.add(b.read(counts, 'items', 0), 1))
  b.out(b.output(0, 'f32x4'), color)
  return b.finish()
}

/** A compute lens that copies a read-only storage block (set 0 binding 0) into a writable one (binding 1). */
function readerLens(): LensModule {
  const b = lens('compute', { group: [64, 1, 1] })
  const table = b.storage(0, 0, { items: arrayOf('f32') })
  const out = b.storage(0, 1, { items: arrayOf('f32') }, { writable: true })
  const i = b.pick(b.builtin('global-id'), 'x')
  b.write(out, ['items', i], b.read(table, 'items', i))
  return b.finish()
}

/** A compute lens that writes item i of a writable storage block at set 0 binding 0, reading nothing. */
function readerLensFree(): LensModule {
  const b = lens('compute', { group: [64, 1, 1] })
  const data = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
  b.write(data, ['items', b.pick(b.builtin('global-id'), 'x')], 1)
  return b.finish()
}

/** A seeded linear congruential generator: the same numbers on every run. */
function lcg(seed: number): (n: number) => number {
  let x = seed >>> 0
  return (n: number): number => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x % n
  }
}

// ---------------------------------------------------------------------------------------------------
// Coverage

test('the reads and the writes split the accesses; the checker\'s stages are the named ones without top, bottom and all', () => {
  assert.deepEqual([...READ_ACCESSES, ...WRITE_ACCESSES].sort(), ACCESSES.filter((a) => a !== 'any-read' && a !== 'any-write').sort())
  assert.ok(READ_ACCESSES.every((a) => a.endsWith('-read')) && WRITE_ACCESSES.every((a) => a.endsWith('-write')))
  assert.deepEqual([...ORDER_STAGES].sort(), PIPE_STAGES.filter((s) => s !== 'top' && s !== 'bottom' && s !== 'all').sort())
  assert.ok(Object.isFrozen(READ_ACCESSES) && Object.isFrozen(WRITE_ACCESSES) && Object.isFrozen(ORDER_STAGES))
})

test('copy then vertex read: refused without a barrier, and every scope that covers both sides is accepted', () => {
  const frame = (s: Scene, between?: BarrierInfo): CommandList => recorded(s.r, 'frame', (l) => {
    upload(s, l)
    if (between !== undefined) l.barrier(between)
    openPass(s, l)
    l.draw(3)
    l.endPass()
  })
  const s0 = scene()
  refuses(() => go(s0.r, frame(s0)), 'hazard', re(cmd(5, 'draw'), 'buffer "vertices" is read as vertex buffer 0 at vertex-input (vertex-read), and its last write, at copy (copy-write) by command list "frame" command 0 (copy-buffer), was not made visible to it; a barrier between them needs a before covering copy and copy-write and an after covering vertex-input and vertex-read$'))
  const missed: readonly [(s: Scene) => BarrierInfo, string][] = [
    [() => ({ memory: [edge(at(['copy']), at(['vertex-input'], ['vertex-read']))] }), 'a before with no access'],
    [() => ({ memory: [edge(at(['copy'], ['copy-read']), at(['vertex-input'], ['vertex-read']))] }), 'a before with a read access'],
    [() => ({ memory: [edge(at(['copy'], ['any-read']), at(['vertex-input'], ['vertex-read']))] }), 'any-read before'],
    [() => ({ memory: [edge(at(['compute'], ['copy-write']), at(['vertex-input'], ['vertex-read']))] }), 'a before at another stage'],
    [() => ({ memory: [edge(at(['top', 'bottom'], ['any-write']), at(['vertex-input'], ['vertex-read']))] }), 'top and bottom before'],
    [() => ({ memory: [edge(COPIED, at(['vertex-input'], ['index-read']))] }), 'an after with another access'],
    [() => ({ memory: [edge(COPIED, at(['vertex'], ['vertex-read']))] }), 'an after at another stage'],
    [() => ({ memory: [edge(COPIED, at(['vertex-input']))] }), 'an after with no access'],
    [() => ({ memory: [edge(COPIED, at(['top', 'bottom'], ['any-read']))] }), 'top and bottom after'],
    [() => ({ memory: [edge(COPIED, at(['vertex-input'], ['any-write']))] }), 'any-write after'],
    [(s) => ({ buffers: [{ ...edge(COPIED, at(['vertex-input'], ['vertex-read'])), buffer: s.staging }] }), 'a barrier on another buffer'],
  ]
  for (const [between, why] of missed) {
    const s = scene()
    refuses(() => go(s.r, frame(s, between(s))), 'hazard', re(cmd(6, 'draw'), 'buffer "vertices" is read as vertex buffer 0'))
    assert.ok(why.length > 0)
  }
  const covered: readonly BarrierInfo[] = [
    { memory: [edge(COPIED, at(['vertex-input'], ['vertex-read']))] },
    { memory: [edge(at(['all'], ['copy-write']), at(['vertex-input'], ['vertex-read']))] },
    { memory: [edge(at(['copy'], ['any-write']), at(['vertex-input'], ['vertex-read']))] },
    { memory: [edge(COPIED, at(['all'], ['vertex-read']))] },
    { memory: [edge(COPIED, at(['vertex-input'], ['any-read']))] },
    { memory: [FULL] },
    { memory: [edge(at(['top', 'copy', 'bottom'], ['copy-read', 'copy-write']), at(['fragment', 'vertex-input'], ['vertex-read', 'shader-read']))] },
    // A buffer is tracked whole, so a barrier on any of its bytes covers all of them.
    { buffers: [{ ...edge(COPIED, at(['vertex-input'], ['vertex-read'])), buffer: s0.vertices, offset: 64, size: 4 }] },
    { memory: [edge(COPIED, at(['vertex'], ['vertex-read']))], buffers: [{ ...edge(COPIED, at(['vertex-input'], ['vertex-read'])), buffer: s0.vertices }] },
  ]
  for (const between of covered) {
    const s = scene()
    const remap = between.buffers === undefined ? between : { ...between, buffers: between.buffers.map((b) => ({ ...b, buffer: s.vertices })) }
    go(s.r, frame(s, remap))
  }
  // The same scene with checks off is never looked at.
  const off = scene({ checks: false })
  go(off.r, frame(off))
})

test('what each command touches: the stage and access each consumer reads at, each refused unordered and accepted after its barrier', () => {
  interface Case {
    readonly name: string
    /** The words of the refusal after the resource. */
    readonly read: string
    readonly stage: PipeStage
    readonly access: Access
    /** The stages a barrier must reach, when the binding lists more than the one refused first. */
    readonly reach?: readonly PipeStage[]
    /** Writes `subject` with a copy, then (after `between`) reads it the way the case is about. */
    readonly run: (s: Scene, between: (l: CommandList) => void) => CommandList
  }
  const empty = { binding: 0, stages: ['fragment'] } as const
  const viaSet = (s: Scene, entries: Parameters<Rig['device']['createBindingLayout']>[0]['entries'], subject: Buffer, between: (l: CommandList) => void): CommandList => {
    const setLayout = s.r.device.createBindingLayout({ entries })
    const layout = s.r.device.createPipelineLayout({ sets: [setLayout] })
    const pipeline = s.r.device.createRenderPipeline({ ...s.plain.info, layout })
    const set = s.r.device.createBindingPool({ sets: 1 }).allocate(setLayout)
    set.write([{ binding: 0, buffer: subject }])
    return recorded(s.r, 'frame', (l) => {
      upload(s, l, subject, 256)
      between(l)
      openPass(s, l, pipeline)
      l.bindSets(layout, 0, [set])
      l.draw(3)
      l.endPass()
    })
  }
  const cases: readonly Case[] = [
    {
      name: 'index buffer', read: 'is read as the index buffer at vertex-input (index-read)', stage: 'vertex-input', access: 'index-read',
      run: (s, between) => {
        const indices = buffer(s.r, 256, ['index', 'copy-dst'], KIND.device, 'subject')
        return recorded(s.r, 'frame', (l) => {
          upload(s, l, indices, 256)
          between(l)
          openPass(s, l)
          l.bindIndices(indices, 0, 'u32')
          l.drawIndexed(3)
          l.endPass()
        })
      },
    },
    {
      name: 'indirect draw', read: 'is read as the indirect buffer at indirect (indirect-read)', stage: 'indirect', access: 'indirect-read',
      run: (s, between) => {
        const args = buffer(s.r, 256, ['indirect', 'copy-dst'], KIND.device, 'subject')
        return recorded(s.r, 'frame', (l) => {
          upload(s, l, args, 256)
          between(l)
          openPass(s, l)
          l.drawIndirect(args, 0)
          l.endPass()
        })
      },
    },
    {
      name: 'indirect dispatch', read: 'is read as the indirect buffer at indirect (indirect-read)', stage: 'indirect', access: 'indirect-read',
      run: (s, between) => {
        const args = buffer(s.r, 256, ['indirect', 'copy-dst'], KIND.device, 'subject')
        const setLayout = s.r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage-read', stages: ['compute'] }, { binding: 1, kind: 'storage', stages: ['compute'] }] })
        const layout = s.r.device.createPipelineLayout({ sets: [setLayout] })
        const pipeline = s.r.device.createComputePipeline({ layout, lens: s.r.device.createLens(readerLens()) })
        const set = s.r.device.createBindingPool({ sets: 1 }).allocate(setLayout)
        set.write([{ binding: 0, buffer: buffer(s.r, 256, ['storage']) }, { binding: 1, buffer: buffer(s.r, 256, ['storage']) }])
        return recorded(s.r, 'frame', (l) => {
          upload(s, l, args, 256)
          between(l)
          l.bindPipeline(pipeline)
          l.bindSets(layout, 0, [set])
          l.dispatchIndirect(args, 0)
        })
      },
    },
    {
      name: 'uniform at vertex and fragment', read: 'is read as binding 0 of set 0 at vertex (uniform-read)', stage: 'vertex', access: 'uniform-read', reach: ['vertex', 'fragment'],
      run: (s, between) => viaSet(s, [{ ...empty, kind: 'uniform', stages: ['vertex', 'fragment'] }], buffer(s.r, 256, ['uniform', 'copy-dst'], KIND.device, 'subject'), between),
    },
    {
      name: 'uniform at fragment', read: 'is read as binding 0 of set 0 at fragment (uniform-read)', stage: 'fragment', access: 'uniform-read',
      run: (s, between) => viaSet(s, [{ ...empty, kind: 'uniform' }], buffer(s.r, 256, ['uniform', 'copy-dst'], KIND.device, 'subject'), between),
    },
    {
      name: 'read-only storage at fragment', read: 'is read as binding 0 of set 0 at fragment (shader-read)', stage: 'fragment', access: 'shader-read',
      run: (s, between) => viaSet(s, [{ ...empty, kind: 'storage-read' }], buffer(s.r, 256, ['storage', 'copy-dst'], KIND.device, 'subject'), between),
    },
    {
      name: 'storage read at compute', read: 'is read as binding 0 of set 0 at compute (shader-read)', stage: 'compute', access: 'shader-read',
      run: (s, between) => {
        const table = buffer(s.r, 256, ['storage', 'copy-dst'], KIND.device, 'subject')
        const setLayout = s.r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage-read', stages: ['compute'] }, { binding: 1, kind: 'storage', stages: ['compute'] }] })
        const layout = s.r.device.createPipelineLayout({ sets: [setLayout] })
        const pipeline = s.r.device.createComputePipeline({ layout, lens: s.r.device.createLens(readerLens()) })
        const set = s.r.device.createBindingPool({ sets: 1 }).allocate(setLayout)
        set.write([{ binding: 0, buffer: table }, { binding: 1, buffer: buffer(s.r, 256, ['storage']) }])
        return recorded(s.r, 'frame', (l) => {
          upload(s, l, table, 256)
          between(l)
          l.bindPipeline(pipeline)
          l.bindSets(layout, 0, [set])
          l.dispatch(1)
        })
      },
    },
    {
      name: 'copy source', read: 'is read as the source at copy (copy-read)', stage: 'copy', access: 'copy-read',
      run: (s, between) => {
        const middle = buffer(s.r, 256, ['copy-src', 'copy-dst'], KIND.device, 'subject')
        return recorded(s.r, 'frame', (l) => {
          upload(s, l, middle, 256)
          between(l)
          l.copyBuffer(middle, s.vertices, [{ from: 0, to: 0, size: 72 }])
        })
      },
    },
  ]
  for (const c of cases) {
    const s = scene()
    refuses(() => go(s.r, c.run(s, () => {})), 'hazard', re(': ', `buffer "subject" ${c.read}, and its last write, at copy (copy-write)`))
    const wrong = scene()
    const elsewhere: PipeStage = c.stage === 'copy' ? 'compute' : 'copy'
    refuses(() => go(wrong.r, c.run(wrong, (l) => l.barrier({ memory: [edge(COPIED, at([elsewhere], [c.access]))] }))), 'hazard', re(': ', `buffer "subject" ${c.read}`))
    const ok = scene()
    go(ok.r, c.run(ok, (l) => l.barrier({ memory: [edge(COPIED, at(c.reach ?? [c.stage], [c.access]))] })))
    if (c.reach !== undefined) {
      // A binding is touched at each stage its entry lists: reaching the first alone leaves the next unordered.
      const part = scene()
      refuses(() => go(part.r, c.run(part, (l) => l.barrier({ memory: [edge(COPIED, at([c.stage], [c.access]))] }))), 'hazard', re(': ', `buffer "subject" is read as binding 0 of set 0 at ${c.reach[1]} (${c.access})`))
    }
    assert.ok(c.name.length > 0)
  }
  // A draw touches a binding only at its own stages: a compute stage the entry also lists is not one.
  const both = scene()
  go(both.r, viaSet(both, [{ ...empty, kind: 'uniform', stages: ['fragment', 'compute'] }], buffer(both.r, 256, ['uniform', 'copy-dst'], KIND.device, 'subject'), (l) => l.barrier({ memory: [edge(COPIED, at(['fragment'], ['uniform-read']))] })))
  // A storage binding is read and written at its stage: the read is checked first, then the write.
  const writes = (between: (l: CommandList) => void): void => {
    const s = scene()
    go(s.r, viaSet(s, [{ ...empty, kind: 'storage' }], buffer(s.r, 256, ['storage', 'copy-dst'], KIND.device, 'subject'), between))
  }
  refuses(() => writes((l) => l.barrier({ memory: [edge(COPIED, at(['fragment'], ['shader-read']))] })), 'hazard', /buffer "subject" is written as binding 0 of set 0 at fragment \(shader-write\), and its last write, at copy \(copy-write\)/)
  writes((l) => l.barrier({ memory: [edge(COPIED, at(['fragment'], ['shader-read', 'shader-write']))] }))
})

// ---------------------------------------------------------------------------------------------------
// Images: layouts and moves

/** A compute scene that paints a storage image, and a textured pipeline that samples it. */
function paintScene() {
  const s = scene()
  const { r } = s
  const field = image(r, { format: 'rgba8', width: 8, height: 8, use: ['storage', 'sampled'], label: 'field' })
  const paintLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage-image', stages: ['compute'], format: 'rgba8' }] })
  const paintPipe = r.device.createPipelineLayout({ sets: [paintLayout] })
  const painter = r.device.createComputePipeline({ layout: paintPipe, lens: r.device.createLens(painterLens()), label: 'painter' })
  const paintSet = r.device.createBindingPool({ sets: 1 }).allocate(paintLayout)
  paintSet.write([{ binding: 0, view: r.device.createView(field) }])
  const drawLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'uniform', stages: ['fragment'] }, { binding: 1, kind: 'image', stages: ['fragment'] }, { binding: 2, kind: 'sampler', stages: ['fragment'] }] })
  const drawPipe = r.device.createPipelineLayout({ sets: [drawLayout] })
  const textured = r.device.createRenderPipeline({ ...s.plain.info, layout: drawPipe, fragment: { lens: r.device.createLens(texturedLens()), outputs: [{ format: 'rgba8' }] } })
  const drawSet = r.device.createBindingPool({ sets: 1 }).allocate(drawLayout)
  drawSet.write([{ binding: 0, buffer: buffer(r, 256, ['uniform']) }, { binding: 1, view: r.device.createView(field) }, { binding: 2, sampler: r.device.createSampler() }])
  const toGeneral = move(field, 'blank', 'general', NOTHING, at(['compute'], ['shader-write']))
  const frame = (first: readonly ImageBarrier[], between: readonly ImageBarrier[]): CommandList => recorded(r, 'frame', (l) => {
    if (first.length > 0) l.barrier({ images: first })
    l.bindPipeline(painter)
    l.bindSets(paintPipe, 0, [paintSet])
    l.dispatch(1)
    if (between.length > 0) l.barrier({ images: between })
    openPass(s, l, textured)
    l.bindSets(drawPipe, 0, [drawSet])
    l.draw(3)
    l.endPass()
  })
  /** A list of one barrier, then (when asked) the dispatch that paints the field again. */
  const after = (b: ImageBarrier, paint: boolean): CommandList => recorded(r, 'next', (l) => {
    l.barrier({ images: [b] })
    if (!paint) return
    l.bindPipeline(painter)
    l.bindSets(paintPipe, 0, [paintSet])
    l.dispatch(1)
  })
  return { ...s, field, toGeneral, frame, after }
}

test('a compute storage write then a fragment sampled read of an image', () => {
  const painted = at(['compute'], ['shader-write'])
  const sampled = at(['fragment'], ['shader-read'])
  // A storage image is written in general, and the move out of blank comes first.
  const p0 = paintScene()
  refuses(() => go(p0.r, p0.frame([], [])), 'layout', re(cmd(2, 'dispatch'), 'level 0 layer 0 of image "field" is in layout blank, and binding 0 of set 0 needs general; move it there with an image barrier first$'))
  // General may be sampled, so without a barrier the fault is the hazard.
  const p1 = paintScene()
  refuses(() => go(p1.r, p1.frame([p1.toGeneral], [])), 'hazard', re(cmd(9, 'draw'), 'level 0 layer 0 of image "field" is read as binding 1 of set 0 at fragment (shader-read), and its last write, at compute (shader-write) by command list "frame" command 3 (dispatch), was not made visible to it; a barrier between them needs a before covering compute and shader-write and an after covering fragment and shader-read$'))
  // A barrier that keeps the layout makes the write visible.
  const p2 = paintScene()
  go(p2.r, p2.frame([p2.toGeneral], [move(p2.field, 'general', 'general', painted, sampled)]))
  // It moves nothing, so it does not wait for the draw's read: the next dispatch is the one refused for it.
  refuses(() => go(p2.r, p2.after(move(p2.field, 'general', 'general', painted, painted), true)), 'hazard', re(cmd(3, 'dispatch', 'next'), 'level 0 layer 0 of image "field" is written as binding 0 of set 0 at compute (shader-write), and the read at fragment (shader-read) by command list "frame" command 10 (draw) is not ordered before it; a barrier between them needs a before covering fragment and an after covering compute$'))
  go(p2.r, p2.after(move(p2.field, 'general', 'general', at(['compute', 'fragment'], ['shader-write']), painted), true))
  // A move to shader-read does too, and is itself the write the draw then reads.
  const p3 = paintScene()
  go(p3.r, p3.frame([p3.toGeneral], [move(p3.field, 'general', 'shader-read', painted, sampled)]))
  // A move is visible only at the stages of its after.
  const p7 = paintScene()
  refuses(() => go(p7.r, p7.frame([p7.toGeneral], [move(p7.field, 'general', 'shader-read', painted, at(['vertex', 'compute'], ['shader-read']))])), 'hazard', /command 10 \(draw\): level 0 layer 0 of image "field" is read as binding 1 of set 0 at fragment \(shader-read\), and its last write, the move from general to shader-read/)
  // A later move must wait for the reads since the last one, through its own before, as well as for that move.
  const p8 = paintScene()
  go(p8.r, p8.frame([p8.toGeneral], [move(p8.field, 'general', 'shader-read', painted, at(['compute', 'fragment'], ['shader-read']))]))
  refuses(() => go(p8.r, p8.after(move(p8.field, 'shader-read', 'general', at(['compute']), painted), false)), 'hazard', re(cmd(0, 'barrier', 'next'), 'images[0]: moving level 0 layer 0 of image "field" from shader-read to general does not wait for the read at fragment (shader-read) by command list "frame" command 10 (draw); the barrier\'s before must cover fragment$'))
  go(p8.r, p8.after(move(p8.field, 'shader-read', 'general', at(['fragment']), painted), true))
  const p4 = paintScene()
  refuses(() => go(p4.r, p4.frame([p4.toGeneral], [move(p4.field, 'general', 'shader-read', painted, at(['fragment']))])), 'hazard', re(cmd(10, 'draw'), 'level 0 layer 0 of image "field" is read as binding 1 of set 0 at fragment (shader-read), and its last write, the move from general to shader-read by command list "frame" command 4 (barrier), was not made visible to it; a barrier between them needs a before covering fragment and an after covering fragment and shader-read$'))
  // A move waits for the last write through its own before: stage and access.
  const p5 = paintScene()
  refuses(() => go(p5.r, p5.frame([p5.toGeneral], [move(p5.field, 'general', 'shader-read', at(['compute']), sampled)])), 'hazard', re(cmd(4, 'barrier'), 'images[0]: moving level 0 layer 0 of image "field" from general to shader-read does not wait for its last write, at compute (shader-write) by command list "frame" command 3 (dispatch); the barrier\'s before must cover compute and shader-write$'))
  // Sampling in a layout no read takes is a layout fault.
  const p6 = paintScene()
  refuses(() => go(p6.r, p6.frame([p6.toGeneral], [move(p6.field, 'general', 'copy-src', painted, sampled)])), 'layout', /command 10 \(draw\): level 0 layer 0 of image "field" is in layout copy-src, and binding 1 of set 0 needs shader-read or general/)
})

test('a layout transition from blank: every use needs the layout, per level and per layer', () => {
  const s = scene()
  const { r } = s
  const tex = image(r, { format: 'rgba8', width: 4, height: 4, levels: 2, layers: 2, use: ['sampled', 'copy-dst', 'copy-src'], label: 'tex' })
  const into = (level: number, layer: number) => ({ offset: 0, rowBytes: 256, region: { level, layer, width: 2, height: 2 } })
  const fill = (barriers: readonly ImageBarrier[], level = 0, layer = 0): CommandList => recorded(r, 'frame', (l) => {
    if (barriers.length > 0) l.barrier({ images: barriers })
    l.copyBufferToImage(s.staging, tex, [into(level, layer)])
  })
  refuses(() => go(r, fill([])), 'layout', re(cmd(0, 'copy-buffer-image'), 'level 0 layer 0 of image "tex" is in layout blank, and the destination needs copy-dst or general; move it there with an image barrier first$'))
  const one = { levels: { base: 0, count: 1 }, layers: { base: 0, count: 1 } }
  refuses(() => go(r, fill([move(tex, 'blank', 'copy-dst', NOTHING, COPIED, one)], 1, 0)), 'layout', /level 1 layer 0 of image "tex" is in layout blank/)
  refuses(() => go(r, fill([move(tex, 'blank', 'copy-dst', NOTHING, COPIED, one)], 0, 1)), 'layout', /level 0 layer 1 of image "tex" is in layout blank/)
  // A move made visible to nothing leaves the copy unordered after it; only `all` covers a move whose after is top.
  refuses(() => go(r, fill([move(tex, 'blank', 'copy-dst', NOTHING, NOTHING)])), 'hazard', /its last write, the move from blank to copy-dst by command list "frame" command 0 \(barrier\), was not made visible to it; a barrier between them needs a before covering all and an after covering copy and copy-write$/)
  // Nothing has been written yet, so a move from blank waits for nothing.
  go(r, fill([move(tex, 'blank', 'copy-dst', NOTHING, COPIED, one)]))
  // Another level and layer of the same image, moved on its own; general takes a copy too.
  go(r, fill([move(tex, 'blank', 'general', NOTHING, COPIED, { levels: { base: 1, count: 1 }, layers: { base: 1, count: 1 } })], 1, 1))
  // A copy between levels of one image reads one level and writes another, each in its own layout.
  const mips = image(r, { format: 'rgba8', width: 4, height: 4, levels: 2, use: ['copy-src', 'copy-dst'], label: 'mips' })
  const level = (n: number): { readonly levels: Range } => ({ levels: { base: n, count: 1 } })
  const down = (lower: ImageLayout): CommandList => recorded(r, 'frame', (l) => {
    l.barrier({ images: [move(mips, 'blank', 'copy-src', NOTHING, at(['copy'], ['copy-read']), level(0)), move(mips, 'blank', lower, NOTHING, COPIED, level(1))] })
    l.copyImage(mips, mips, [{ from: { level: 0, width: 2, height: 2 }, to: { level: 1 } }])
  })
  refuses(() => go(r, down('copy-src')), 'layout', re(cmd(1, 'copy-image'), 'level 1 layer 0 of image "mips" is in layout copy-src, and the destination needs copy-dst or general; move it there with an image barrier first$'))
  go(r, down('copy-dst'))
  // A resolve view and an attachment need the color layout as well.
  const s2 = scene()
  const blankPass = recorded(s2.r, 'frame', (l) => {
    l.beginPass({ colors: [{ view: s2.canvas, load: 'clear', store: 'keep' }] })
    l.endPass()
  })
  refuses(() => go(s2.r, blankPass), 'layout', re(cmd(0, 'pass'), 'level 0 layer 0 of image "canvas" is in layout blank, and colour attachment 0 needs color'))
  const many = imageView(s2.r, { format: 'rgba8', width: 8, height: 8, samples: 4, use: ['color'], label: 'many' })
  const resolved = recorded(s2.r, 'frame', (l) => {
    l.barrier({ images: [move(many.image, 'blank', 'color', NOTHING, at(['color'], ['color-write']))] })
    l.beginPass({ colors: [{ view: many, load: 'clear', store: 'any', resolve: s2.canvas }] })
    l.endPass()
  })
  refuses(() => go(s2.r, resolved), 'layout', re(cmd(1, 'pass'), 'level 0 layer 0 of image "canvas" is in layout blank, and the resolve view of colour attachment 0 needs color'))
})

test('a barrier from the wrong layout is refused; from blank throws the contents away but still waits for the last write', () => {
  const s = scene()
  const { r } = s
  const tex = image(r, { format: 'rgba8', width: 4, height: 4, use: ['sampled', 'copy-dst'], label: 'tex' })
  const fill = recorded(r, 'fill', (l) => {
    l.barrier({ images: [move(tex, 'blank', 'copy-dst', NOTHING, COPIED)] })
    l.copyBufferToImage(s.staging, tex, [{ offset: 0, rowBytes: 256, region: { width: 4, height: 4 } }])
  })
  go(r, fill)
  const later = (b: ImageBarrier): CommandList => recorded(r, 'frame', (l) => l.barrier({ images: [b] }))
  const ready = at(['fragment'], ['shader-read'])
  refuses(() => go(r, later(move(tex, 'shader-read', 'copy-dst', COPIED, ready))), 'layout', re(cmd(0, 'barrier'), 'images[0]: the barrier takes level 0 layer 0 of image "tex" from layout shader-read, and it is in layout copy-dst$'))
  refuses(() => go(r, later(move(tex, 'shader-read', 'shader-read', COPIED, ready))), 'layout', /the barrier takes level 0 layer 0 of image "tex" from layout shader-read, and it is in layout copy-dst/)
  refuses(() => go(r, later(move(tex, 'blank', 'shader-read', NOTHING, ready))), 'hazard', re(cmd(0, 'barrier'), 'images[0]: moving level 0 layer 0 of image "tex" from blank to shader-read does not wait for its last write, at copy (copy-write) by command list "fill" command 1 (copy-buffer-image); the barrier\'s before must cover copy and copy-write$'))
  go(r, later(move(tex, 'blank', 'shader-read', COPIED, ready)))
  // The state carried over: the image is in shader-read now, so a move from copy-dst is refused and one from shader-read taken.
  refuses(() => go(r, later(move(tex, 'copy-dst', 'shader-read', COPIED, ready))), 'layout', /from layout copy-dst, and it is in layout shader-read/)
  // The last write is now that move, made visible at fragment; a later move is covered by a before at fragment.
  refuses(() => go(r, later(move(tex, 'shader-read', 'copy-dst', at(['copy'], ['copy-write']), COPIED))), 'hazard', /does not wait for its last write, the move from blank to shader-read by command list "frame" command 0 \(barrier\); the barrier's before must cover fragment$/)
  go(r, later(move(tex, 'shader-read', 'copy-dst', at(['fragment']), COPIED)))
})

test('a move whose after is only bottom (as a surface\'s move to present) is covered only by all', () => {
  const s = scene()
  const { r } = s
  const draw = (l: CommandList): void => {
    l.beginPass({ colors: [{ view: s.canvas, load: 'clear', store: 'keep' }] })
    l.endPass()
  }
  go(r, recorded(r, 'first', (l) => {
    l.barrier({ images: [move(s.canvas.image, 'blank', 'color', NOTHING, at(['color'], ['color-write']))] })
    draw(l)
    l.barrier({ images: [move(s.canvas.image, 'color', 'present', at(['color'], ['color-write']), at(['bottom']))] })
  }))
  const next = (before: Scope): CommandList => recorded(r, 'frame', (l) => {
    l.barrier({ images: [move(s.canvas.image, 'present', 'color', before, at(['color'], ['color-write']))] })
    draw(l)
  })
  refuses(() => go(r, next(at(['color'], ['any-write']))), 'hazard', /does not wait for its last write, the move from color to present by command list "first" command 3 \(barrier\); the barrier's before must cover all$/)
  refuses(() => go(r, next(at(['bottom']))), 'hazard', /the barrier's before must cover all$/)
  go(r, next(at(['all'])))
})

test('a barrier covers a write only through its own stage and access: there is no chain through an earlier barrier', () => {
  const run = (barriers: readonly MemoryBarrier[]): void => {
    const s = scene()
    go(s.r, recorded(s.r, 'frame', (l) => {
      upload(s, l)
      for (const b of barriers) l.barrier({ memory: [b] })
      openPass(s, l)
      l.draw(3)
      l.endPass()
    }))
  }
  refuses(() => run([edge(COPIED, at(['fragment'], ['shader-read'])), edge(at(['fragment'], ['shader-read']), at(['vertex-input'], ['vertex-read']))]), 'hazard', /a barrier between them needs a before covering copy and copy-write/)
  run([edge(COPIED, at(['fragment'], ['shader-read'])), edge(COPIED, at(['vertex-input'], ['vertex-read']))])
})

test('read-only depth: the attachment is in depth-read; read-only passes need no barrier between them, and a write after them does', () => {
  const s = scene()
  const { r } = s
  const depth = imageView(r, { format: 'depth32f', width: 8, height: 8, use: ['depth', 'sampled'], label: 'depth' })
  const writer = r.device.createRenderPipeline({ layout: s.empty, vertex: s.plain.info.vertex, depth: { format: 'depth32f', write: true, compare: 'less' } })
  const tester = r.device.createRenderPipeline({ layout: s.empty, vertex: s.plain.info.vertex, depth: { format: 'depth32f', compare: 'less' } })
  const depthPass = (l: CommandList, readOnly: boolean): void => {
    l.beginPass({ colors: [], depth: readOnly ? { view: depth, load: 'keep', store: 'keep', readOnly } : { view: depth, load: 'clear', store: 'keep' } })
    l.bindPipeline(readOnly ? tester : writer)
    l.bindVertices(0, [{ buffer: s.vertices }])
    l.draw(3)
    l.endPass()
  }
  const written = at(['depth'], ['depth-write'])
  const tested = at(['depth'], ['depth-read'])
  go(r, recorded(r, 'prepass', (l) => {
    l.barrier({ images: [move(depth.image, 'blank', 'depth', NOTHING, at(['depth'], ['depth-read', 'depth-write']))] })
    depthPass(l, false)
  }))
  refuses(() => go(r, recorded(r, 'frame', (l) => depthPass(l, true))), 'layout', re(cmd(0, 'pass'), 'level 0 layer 0 of image "depth" is in layout depth, and the depth attachment needs depth-read; move it there with an image barrier first$'))
  refuses(() => go(r, recorded(r, 'frame', (l) => {
    l.barrier({ images: [move(depth.image, 'depth', 'depth-read', written, at(['depth']))] })
    depthPass(l, true)
  })), 'hazard', re(cmd(1, 'pass'), 'level 0 layer 0 of image "depth" is read as the depth attachment at depth (depth-read), and its last write, the move from depth to depth-read'))
  go(r, recorded(r, 'frame', (l) => {
    l.barrier({ images: [move(depth.image, 'depth', 'depth-read', written, tested)] })
    depthPass(l, true)
    depthPass(l, true)
  }))
  go(r, recorded(r, 'again', (l) => depthPass(l, true)))
  // Writing again: the move back must wait for the reads of the read-only passes.
  const back = (before: Scope): CommandList => recorded(r, 'frame', (l) => {
    l.barrier({ images: [move(depth.image, 'depth-read', 'depth', before, at(['depth'], ['depth-read', 'depth-write']))] })
    depthPass(l, false)
  })
  refuses(() => go(r, back(NOTHING)), 'hazard', /moving level 0 layer 0 of image "depth" from depth-read to depth does not wait for its last write, the move from depth to depth-read by command list "frame" command 0 \(barrier\); the barrier's before must cover depth$/)
  go(r, back(at(['depth'])))
  // A sampled depth image may be read in depth-read; a colour image may not.
  const s2 = scene()
  const t2 = s2.r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'uniform', stages: ['fragment'] }, { binding: 1, kind: 'image', stages: ['fragment'] }, { binding: 2, kind: 'sampler', stages: ['fragment'] }] })
  const p2 = s2.r.device.createPipelineLayout({ sets: [t2] })
  const pipe2 = s2.r.device.createRenderPipeline({ ...s2.plain.info, layout: p2, fragment: { lens: s2.r.device.createLens(texturedLens()), outputs: [{ format: 'rgba8' }] } })
  const tex = image(s2.r, { format: 'rgba8', width: 4, height: 4, use: ['sampled'], label: 'tex' })
  const set2 = s2.r.device.createBindingPool({ sets: 1 }).allocate(t2)
  set2.write([{ binding: 0, buffer: buffer(s2.r, 256, ['uniform']) }, { binding: 1, view: s2.r.device.createView(tex) }, { binding: 2, sampler: s2.r.device.createSampler() }])
  refuses(() => go(s2.r, recorded(s2.r, 'frame', (l) => {
    l.barrier({ images: [move(tex, 'blank', 'depth-read', NOTHING, at(['fragment'], ['shader-read']))] })
    openPass(s2, l, pipe2)
    l.bindSets(p2, 0, [set2])
    l.draw(3)
    l.endPass()
  })), 'layout', /level 0 layer 0 of image "tex" is in layout depth-read, and binding 1 of set 0 needs shader-read or general;/)
})

test('an image may not be an attachment and be bound for reading in the same pass: per level and layer, read-only depth included (refused as it is recorded)', () => {
  const s = scene()
  const { r } = s
  const pic = image(r, { format: 'rgba8', width: 8, height: 8, levels: 2, use: ['color', 'sampled'], label: 'pic' })
  const small = r.device.createView(pic, { levels: { base: 1, count: 1 } })
  const setLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'uniform', stages: ['fragment'] }, { binding: 1, kind: 'image', stages: ['fragment'] }, { binding: 2, kind: 'sampler', stages: ['fragment'] }] })
  const layout = r.device.createPipelineLayout({ sets: [setLayout] })
  const pipe = r.device.createRenderPipeline({ ...s.plain.info, layout, fragment: { lens: r.device.createLens(texturedLens()), outputs: [{ format: 'rgba8' }] } })
  const pool = r.device.createBindingPool({ sets: 4 })
  const tint = buffer(r, 256, ['uniform'])
  const sampler = r.device.createSampler()
  const setOf = (view: View) => {
    const set = pool.allocate(setLayout)
    set.write([{ binding: 0, buffer: tint }, { binding: 1, view }, { binding: 2, sampler }])
    return set
  }
  const mip = (view: View): CommandList => recorded(r, 'frame', (l) => {
    l.barrier({
      images: [
        move(pic, 'blank', 'shader-read', NOTHING, at(['fragment'], ['shader-read']), { levels: { base: 0, count: 1 } }),
        move(pic, 'blank', 'color', NOTHING, at(['color'], ['color-write']), { levels: { base: 1, count: 1 } }),
      ],
    })
    l.beginPass({ colors: [{ view: small, load: 'clear', store: 'keep' }] })
    l.bindPipeline(r.device.createRenderPipeline({ ...pipe.info }))
    l.bindVertices(0, [{ buffer: s.vertices }])
    l.bindSets(layout, 0, [setOf(view)])
    l.draw(3)
    l.endPass()
  })
  // Refused when the draw is recorded, before any submit: the usage scope (commands.ts) sees the conflict.
  refuses(() => mip(r.device.createView(pic)), 'invalid', /draw: level 1 layer 0 of image "pic" is drawn into as an attachment and sampled through binding 1 of set 0 in one pass/)
  go(r, mip(r.device.createView(pic, { levels: { base: 0, count: 1 } })))
  // A read-only depth attachment is an attachment too.
  const s2 = scene()
  const depth = imageView(s2.r, { format: 'depth32f', width: 8, height: 8, use: ['depth', 'sampled'], label: 'depth' })
  const dl = s2.r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'uniform', stages: ['fragment'] }, { binding: 1, kind: 'image', stages: ['fragment'], sample: 'depth' }, { binding: 2, kind: 'sampler', stages: ['fragment'] }] })
  const dp = s2.r.device.createPipelineLayout({ sets: [dl] })
  const dpipe = s2.r.device.createRenderPipeline({ ...s2.plain.info, layout: dp, fragment: { lens: s2.r.device.createLens(texturedLens({ sample: 'depth' })), outputs: [{ format: 'rgba8' }] }, depth: { format: 'depth32f', compare: 'less' } })
  const dset = s2.r.device.createBindingPool({ sets: 1 }).allocate(dl)
  dset.write([{ binding: 0, buffer: buffer(s2.r, 256, ['uniform']) }, { binding: 1, view: depth }, { binding: 2, sampler: s2.r.device.createSampler() }])
  refuses(() => recorded(s2.r, 'frame', (l) => {
    l.barrier({ images: [move(s2.canvas.image, 'blank', 'color', NOTHING, at(['color'], ['color-write'])), move(depth.image, 'blank', 'depth-read', NOTHING, at(['depth', 'fragment'], ['depth-read', 'shader-read']))] })
    l.beginPass({ colors: [{ view: s2.canvas, load: 'clear', store: 'keep' }], depth: { view: depth, load: 'keep', store: 'keep', readOnly: true } })
    l.bindPipeline(dpipe)
    l.bindVertices(0, [{ buffer: s2.vertices }])
    l.bindSets(dp, 0, [dset])
    l.draw(3)
    l.endPass()
  }), 'invalid', /level 0 layer 0 of image "depth" is attached as read-only depth and sampled through binding 1 of set 0 in one pass/)
})

test('a resource written by one draw and read by a later draw of the same pass is a hazard; split the pass with a barrier', () => {
  const s = scene()
  const { r } = s
  const counts = buffer(r, 256, ['storage', 'copy-src'], KIND.device, 'counts')
  const setLayout = r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['fragment'] }] })
  const layout = r.device.createPipelineLayout({ sets: [setLayout] })
  const tally = r.device.createRenderPipeline({ ...s.plain.info, layout, fragment: { lens: r.device.createLens(tallyLens()), outputs: [{ format: 'rgba8' }] } })
  const set = r.device.createBindingPool({ sets: 1 }).allocate(setLayout)
  set.write([{ binding: 0, buffer: counts }])
  refuses(() => go(r, recorded(r, 'frame', (l) => {
    openPass(s, l, tally)
    l.bindSets(layout, 0, [set])
    l.draw(3)
    l.draw(3)
    l.endPass()
  })), 'hazard', re(cmd(6, 'draw'), 'buffer "counts" is read as binding 0 of set 0 at fragment (shader-read), and its last write, at fragment (shader-write) by command list "frame" command 5 (draw), was not made visible to it; command list "frame" command 5 (draw) wrote it in the same pass, and a barrier cannot sit in a pass: split the pass there$'))
  // After the pass, the same write needs an ordinary barrier: the pass is over.
  refuses(() => go(r, recorded(r, 'frame', (l) => {
    openPass(s, l, tally)
    l.bindSets(layout, 0, [set])
    l.draw(3)
    l.endPass()
    l.copyBuffer(counts, s.vertices, [{ from: 0, to: 0, size: 72 }])
  })), 'hazard', re(cmd(7, 'copy-buffer'), 'buffer "counts" is read as the source at copy (copy-read), and its last write, at fragment (shader-write) by command list "frame" command 5 (draw), was not made visible to it; a barrier between them needs a before covering fragment and shader-write and an after covering copy and copy-read$'))
  // Reads alone may repeat across draws: the vertex buffer is read by both.
  const second = (between: BarrierInfo): CommandList => recorded(r, 'frame', (l) => {
    openPass(s, l, tally)
    l.bindSets(layout, 0, [set])
    l.draw(3)
    l.endPass()
    l.barrier(between)
    l.beginPass({ colors: [{ view: s.canvas, load: 'keep', store: 'keep' }] })
    l.bindPipeline(tally)
    l.bindVertices(0, [{ buffer: s.vertices }])
    l.bindSets(layout, 0, [set])
    l.draw(3)
    l.endPass()
  })
  const keepCanvas = move(s.canvas.image, 'color', 'color', at(['color'], ['color-write']), at(['color'], ['color-read', 'color-write']))
  refuses(() => go(r, second({ images: [keepCanvas] })), 'hazard', /command 12 \(draw\): buffer "counts" is read as binding 0 of set 0 at fragment \(shader-read\), and its last write, at fragment \(shader-write\) by command list "frame" command 5 \(draw\), was not made visible to it; a barrier between them needs a before covering fragment and shader-write/)
  refuses(() => go(r, second({ memory: [edge(at(['fragment'], ['shader-write']), at(['fragment'], ['shader-read', 'shader-write']))] })), 'hazard', /command 8 \(pass\): level 0 layer 0 of image "canvas" is read as colour attachment 0 at color \(color-read\)/)
  go(r, second({ memory: [edge(at(['fragment'], ['shader-write']), at(['fragment'], ['shader-read', 'shader-write']))], images: [keepCanvas] }))
})

test('a write after a read needs the read ordered before it: within a list, across submits, and in a pass', () => {
  const setup = () => {
    const s = scene()
    const table = buffer(s.r, 256, ['storage', 'copy-dst'], KIND.device, 'table')
    const setLayout = s.r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage-read', stages: ['compute'] }, { binding: 1, kind: 'storage', stages: ['compute'] }] })
    const layout = s.r.device.createPipelineLayout({ sets: [setLayout] })
    const pipeline = s.r.device.createComputePipeline({ layout, lens: s.r.device.createLens(readerLens()) })
    const set = s.r.device.createBindingPool({ sets: 1 }).allocate(setLayout)
    set.write([{ binding: 0, buffer: table }, { binding: 1, buffer: buffer(s.r, 256, ['storage']) }])
    const read = (l: CommandList): void => {
      l.bindPipeline(pipeline)
      l.bindSets(layout, 0, [set])
      l.dispatch(1)
    }
    const write = (l: CommandList): void => upload(s, l, table, 256)
    const scribeLayout = s.r.device.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'] }] })
    const scribeLayoutAll = s.r.device.createPipelineLayout({ sets: [scribeLayout] })
    const scribe = s.r.device.createComputePipeline({ layout: scribeLayoutAll, lens: s.r.device.createLens(readerLensFree()) })
    const scribeSet = s.r.device.createBindingPool({ sets: 1 }).allocate(scribeLayout)
    scribeSet.write([{ binding: 0, buffer: table }])
    /** A dispatch that writes the table at compute. */
    const overwrite = (l: CommandList): void => {
      l.bindPipeline(scribe)
      l.bindSets(scribeLayoutAll, 0, [scribeSet])
      l.dispatch(1)
    }
    return { ...s, table, read, write, overwrite }
  }
  const s0 = setup()
  refuses(() => go(s0.r, recorded(s0.r, 'frame', (l) => {
    s0.read(l)
    s0.write(l)
  })), 'hazard', re(cmd(3, 'copy-buffer'), 'buffer "table" is written as the destination at copy (copy-write), and the read at compute (shader-read) by command list "frame" command 2 (dispatch) is not ordered before it; a barrier between them needs a before covering compute and an after covering copy$'))
  const between = (b: MemoryBarrier): void => {
    const s = setup()
    go(s.r, recorded(s.r, 'frame', (l) => {
      s.read(l)
      l.barrier({ memory: [b] })
      s.write(l)
    }))
  }
  // An execution dependency is enough for a read: no access on either side.
  between(edge(at(['compute']), at(['copy'])))
  between(edge(at(['all']), at(['all'])))
  refuses(() => between(edge(at(['copy']), at(['copy']))), 'hazard', /the read at compute \(shader-read\) by command list "frame" command 2 \(dispatch\) is not ordered before it/)
  refuses(() => between(edge(at(['compute']), at(['fragment']))), 'hazard', /is not ordered before it/)
  refuses(() => between(edge(at(['top']), at(['copy']))), 'hazard', /is not ordered before it/)
  // A write supersedes the reads before it: once the copy is made visible to compute, a compute write needs nothing more.
  const s2 = setup()
  go(s2.r, recorded(s2.r, 'frame', (l) => {
    s2.read(l)
    l.barrier({ memory: [edge(at(['compute']), at(['copy']))] })
    s2.write(l)
    l.barrier({ memory: [edge(COPIED, at(['compute'], ['shader-read', 'shader-write']))] })
    s2.overwrite(l)
  }))
  // Across submits the read is remembered; work being done orders nothing.
  const s1 = setup()
  go(s1.r, recorded(s1.r, 'first', s1.read))
  refuses(() => go(s1.r, recorded(s1.r, 'frame', s1.write)), 'hazard', re(cmd(0, 'copy-buffer'), 'buffer "table" is written as the destination at copy (copy-write), and the read at compute (shader-read) by command list "first" command 2 (dispatch) is not ordered before it'))
  go(s1.r, recorded(s1.r, 'frame', (l) => {
    l.barrier({ buffers: [{ ...edge(at(['compute']), at(['copy'])), buffer: s1.table }] })
    s1.write(l)
  }))
})

test('a semaphore wait makes the writes up to its signal visible to its stages, and orders the reads up to it, across queues', () => {
  const s = scene()
  const { r } = s
  const sem = r.device.createSemaphore({ label: 's' })
  const copy = (): CommandList => recorded(r, 'copy', (l) => upload(s, l))
  const draw = (): CommandList => recorded(r, 'frame', (l) => {
    openPass(s, l)
    l.draw(3)
    l.endPass()
  })
  const q = r.device.queue(0, 0)
  // Without a wait the earlier submission's write is not visible.
  refuses(() => q.submit([{ lists: [copy()] }, { lists: [draw()] }]), 'hazard', re(cmd(4, 'draw', 'frame', 1), 'buffer "vertices" is read as vertex buffer 0 at vertex-input (vertex-read), and its last write, at copy (copy-write) by command list "copy" command 0 (copy-buffer), was not made visible to it'))
  refuses(() => q.submit([{ lists: [copy()], signal: [sem] }, { lists: [draw()], wait: [{ semaphore: sem, stages: ['fragment'] }] }]), 'hazard', /buffer "vertices" is read as vertex buffer 0/)
  refuses(() => q.submit([{ lists: [copy()], signal: [sem] }, { lists: [draw()], wait: [{ semaphore: sem, stages: ['top', 'bottom'] }] }]), 'hazard', /buffer "vertices" is read as vertex buffer 0/)
  q.submit([{ lists: [copy()], signal: [sem] }, { lists: [draw()], wait: [{ semaphore: sem, stages: ['vertex-input'] }] }])
  // The wait makes the writes visible to every access of its stages, writes included.
  refuses(() => q.submit([{ lists: [copy()] }]), 'hazard', /buffer "vertices" is written as the destination at copy \(copy-write\), and its last write, at copy \(copy-write\) by command list "copy" command 0 \(copy-buffer\), was not made visible to it/)
  // A signal with no lists covers every earlier write; the wait at copy also orders the draw's read before the copy.
  q.submit([{ lists: [], signal: [sem] }, { lists: [copy()], wait: [{ semaphore: sem, stages: ['copy'] }] }])
  // A signal taken in a later submit, on another queue of the device.
  const s2 = scene()
  const sem2 = s2.r.device.createSemaphore({ label: 's2' })
  s2.r.device.queue(0, 0).submit([{ lists: [recorded(s2.r, 'copy', (l) => upload(s2, l))], signal: [sem2] }])
  const frame2 = recorded(s2.r, 'frame', (l) => {
    openPass(s2, l)
    l.draw(3)
    l.endPass()
  })
  refuses(() => s2.r.device.queue(0, 1).submit([{ lists: [frame2] }]), 'hazard', /^queue 0\.1 submit: submissions\[0\] lists\[0\]: command list "frame" command 4 \(draw\): buffer "vertices" is read/)
  s2.r.device.queue(0, 1).submit([{ lists: [frame2], wait: [{ semaphore: sem2, stages: ['all'] }] }])
  // A write made after the signal is not covered by the wait.
  const s3 = scene()
  const sem3 = s3.r.device.createSemaphore()
  const rewrite = recorded(s3.r, 'rewrite', (l) => {
    l.barrier({ memory: [edge(COPIED, COPIED)] })
    upload(s3, l)
  })
  const frame3 = recorded(s3.r, 'frame', (l) => {
    openPass(s3, l)
    l.draw(3)
    l.endPass()
  })
  const first3 = recorded(s3.r, 'copy', (l) => upload(s3, l))
  refuses(() => s3.r.device.queue(0, 0).submit([{ lists: [first3], signal: [sem3] }, { lists: [rewrite] }, { lists: [frame3], wait: [{ semaphore: sem3, stages: ['vertex-input'] }] }]), 'hazard', /its last write, at copy \(copy-write\) by command list "rewrite" command 1 \(copy-buffer\), was not made visible to it/)
  // A wait orders the reads before its stages, so a later write after a read is ordered by it.
  const s4 = scene()
  const sem4 = s4.r.device.createSemaphore()
  const source = buffer(s4.r, 256, ['copy-src', 'copy-dst'], KIND.device, 'source')
  const readFirst = recorded(s4.r, 'read', (l) => l.copyBuffer(source, buffer(s4.r, 256, ['copy-dst']), [{ from: 0, to: 0, size: 72 }]))
  const writeAfter = (): CommandList => recorded(s4.r, 'write', (l) => upload(s4, l, source, 256))
  s4.r.device.queue(0, 0).submit([{ lists: [readFirst], signal: [sem4] }])
  refuses(() => s4.r.device.queue(0, 0).submit([{ lists: [writeAfter()] }]), 'hazard', /buffer "source" is written as the destination at copy \(copy-write\), and the read at copy \(copy-read\) by command list "read" command 0 \(copy-buffer\) is not ordered before it/)
  s4.r.device.queue(0, 0).submit([{ lists: [writeAfter()], wait: [{ semaphore: sem4, stages: ['copy'] }] }])
})

test('readback: invalidate() needs the writing work done and its last write made visible to host and host-read', () => {
  const run = (hostBarrier: boolean, hostAccess: Access = 'host-read') => {
    const s = scene()
    const { r } = s
    const memory = r.device.allocate({ size: 4096, kind: KIND.readback, label: 'readback' }) as MemoryImpl
    const result = r.device.createBuffer({ size: 1024, use: ['copy-dst'], label: 'result' })
    const spare = r.device.createBuffer({ size: 1024, use: ['copy-dst'], label: 'spare' })
    r.device.bind(result, memory, 0)
    r.device.bind(spare, memory, 1024)
    const list = recorded(r, 'frame', (l) => {
      l.barrier({ images: [move(s.canvas.image, 'blank', 'color', NOTHING, at(['color'], ['color-write']))] })
      l.beginPass({ colors: [{ view: s.canvas, load: 'clear', store: 'keep' }] })
      l.endPass()
      l.barrier({ images: [move(s.canvas.image, 'color', 'copy-src', at(['color'], ['color-write']), at(['copy'], ['copy-read']))] })
      l.copyImageToBuffer(s.canvas.image, result, [{ offset: 0, rowBytes: 256, region: { width: 8, height: 4 } }])
      if (hostBarrier) l.barrier({ buffers: [{ ...edge(COPIED, at(['host'], [hostAccess])), buffer: result }] })
    })
    // Nothing has been submitted yet: nothing to wait for.
    hostRead(memory, 0, 4096, 'memory "readback" invalidate')
    r.fake.auto = false
    r.device.queue(0, 0).submit([{ lists: [list] }])
    return { r, memory }
  }
  const where = 'memory "readback" invalidate'
  const a = run(true)
  refuses(() => hostRead(a.memory, 0, 4096, where), 'hazard', /^memory "readback" invalidate: submitted work that writes buffer "result" is not done; invalidate once its fence is signalled$/)
  // Only the buffers in the range count.
  hostRead(a.memory, 1024, 1024, where)
  a.r.fake.finish()
  hostRead(a.memory, 0, 4096, where)
  const b = run(false)
  b.r.fake.finish()
  refuses(() => hostRead(b.memory, 0, 4096, where), 'hazard', /^memory "readback" invalidate: the last write to buffer "result", at copy \(copy-write\) by command list "frame" command 4 \(copy-image-buffer\), was not made visible to host \(host-read\); a barrier after it needs a before covering copy and copy-write and an after covering host and host-read$/)
  refuses(() => hostRead(b.memory, 1023, 1, where), 'hazard', /buffer "result"/)
  hostRead(b.memory, 1024, 3072, where)
  const c = run(true, 'host-write')
  c.r.fake.finish()
  refuses(() => hostRead(c.memory, 0, 4096, where), 'hazard', /was not made visible to host \(host-read\)/)
  // With checks off the rule is not applied.
  const off = scene({ checks: false })
  const offMemory = off.r.device.allocate({ size: 4096, kind: KIND.readback }) as MemoryImpl
  const offResult = off.r.device.createBuffer({ size: 1024, use: ['copy-dst'] })
  off.r.device.bind(offResult, offMemory, 0)
  off.r.fake.auto = false
  go(off.r, recorded(off.r, 'frame', (l) => l.zeroBuffer(offResult, 0, 1024)))
  hostRead(offMemory, 0, 4096, where)
})

test('readback: invalidate() waits only for work that writes a buffer bound in its range, not for work elsewhere in the memory', () => {
  const r = rig()
  const memory = r.device.allocate({ size: 4096, kind: KIND.readback, label: 'readback' })
  const a = r.device.createBuffer({ size: 1024, use: ['copy-dst'], label: 'a' })
  const b = r.device.createBuffer({ size: 1024, use: ['copy-dst'], label: 'b' })
  r.device.bind(a, memory, 0)
  r.device.bind(b, memory, 1024)
  const fill = (into: Buffer, label: string): CommandList => recorded(r, label, (l) => {
    l.zeroBuffer(into, 0, 1024)
    l.barrier({ buffers: [{ ...edge(COPIED, at(['host'], ['host-read'])), buffer: into }] })
  })
  go(r, fill(a, 'first'))
  r.fake.auto = false
  go(r, fill(b, 'second'))
  // The work in flight writes b alone: a's bytes, and the bytes after b, which hold no buffer, may be taken back.
  memory.invalidate(0, 1024)
  memory.invalidate(2048)
  assert.deepEqual(r.fake.named('invalidate').map((c) => c.args.slice(1)), [[0, 1024], [2048, 2048]])
  // A range that reaches any of b's bytes waits for it.
  const busy = /^memory "readback" invalidate: submitted work that writes buffer "b" is not done; invalidate once its fence is signalled$/
  refuses(() => memory.invalidate(1023, 2), 'hazard', busy)
  refuses(() => memory.invalidate(2044, 4), 'hazard', busy)
  refuses(() => memory.invalidate(), 'hazard', busy)
  r.fake.finish()
  memory.invalidate()
  assert.equal(r.fake.named('invalidate').length, 3)
})

test('a refused submit leaves the state as it was, whether the checker or the back end refuses it', () => {
  const s = scene()
  const { r } = s
  const tex = image(r, { format: 'rgba8', width: 4, height: 4, use: ['sampled', 'copy-dst'], label: 'tex' })
  const region = [{ offset: 0, rowBytes: 256, region: { width: 4, height: 4 } }]
  const fill = recorded(r, 'fill', (l) => {
    l.barrier({ images: [move(tex, 'blank', 'copy-dst', NOTHING, COPIED)] })
    l.copyBufferToImage(s.staging, tex, region)
    upload(s, l)
  })
  const unordered = recorded(r, 'frame', (l) => {
    openPass(s, l)
    l.draw(3)
    l.endPass()
  })
  const refill = recorded(r, 'refill', (l) => {
    l.barrier({ images: [move(tex, 'copy-dst', 'copy-dst', COPIED, COPIED)] })
    l.copyBufferToImage(s.staging, tex, region)
  })
  const sem = r.device.createSemaphore()
  refuses(() => r.device.queue(0, 0).submit([{ lists: [fill], signal: [sem] }, { lists: [unordered] }]), 'hazard', re(cmd(4, 'draw', 'frame', 1), 'buffer "vertices" is read'))
  // The fill's move was not kept: the image is still blank.
  refuses(() => go(r, refill), 'layout', /from layout copy-dst, and it is in layout blank/)
  // A back end that refuses the submit gets the simulated state put back too.
  r.fake.raise = { name: 'submit', error: new Error('gpu gone') }
  refuses(() => go(r, fill), 'device', /the back end raised Error: gpu gone/)
  refuses(() => go(r, refill), 'layout', /from layout copy-dst, and it is in layout blank/)
  // Accepted, the state is kept, and the refill is now right.
  go(r, fill)
  go(r, refill)
  refuses(() => go(r, fill), 'hazard', /command list "fill" command 0 \(barrier\): images\[0\]: moving level 0 layer 0 of image "tex" from blank to copy-dst does not wait for its last write, at copy \(copy-write\) by command list "refill" command 1 \(copy-buffer-image\)/)
})

test('a refused submit puts back what its memory barriers and semaphore waits did, whether the checker or the back end refuses it', () => {
  const setup = () => {
    const s = scene()
    const { r } = s
    const draw = (): CommandList => recorded(r, 'frame', (l) => {
      openPass(s, l)
      l.draw(3)
      l.endPass()
    })
    const again = (): CommandList => recorded(r, 'again', (l) => upload(s, l))
    const sem = r.device.createSemaphore({ label: 's' })
    r.device.queue(0, 0).submit([{ lists: [recorded(r, 'copy', (l) => upload(s, l))], signal: [sem] }])
    return { r, q: r.device.queue(0, 0), draw, again, sem }
  }
  const unordered = re(cmd(4, 'draw'), 'buffer "vertices" is read as vertex buffer 0 at vertex-input (vertex-read), and its last write, at copy (copy-write) by command list "copy" command 0 (copy-buffer), was not made visible to it')
  const raise = (r: Rig): void => {
    r.fake.raise = { name: 'submit', error: new Error('gpu gone') }
  }
  // A memory barrier, in a submit the checker refuses at a later list, then in one the back end refuses.
  const b = setup()
  const covering = (): CommandList => recorded(b.r, 'covering', (l) => l.barrier({ memory: [edge(COPIED, at(['vertex-input'], ['vertex-read']))] }))
  refuses(() => go(b.r, covering(), b.again()), 'hazard', /lists\[1\]: command list "again" command 0 \(copy-buffer\): buffer "vertices" is written/)
  refuses(() => go(b.r, b.draw()), 'hazard', unordered)
  raise(b.r)
  refuses(() => go(b.r, covering()), 'device', /the back end raised Error: gpu gone/)
  refuses(() => go(b.r, b.draw()), 'hazard', unordered)
  go(b.r, covering())
  go(b.r, b.draw())
  // A wait, the same way; the semaphore stays armed for the next.
  const w = setup()
  const waits = [{ semaphore: w.sem, stages: ['vertex-input', 'copy'] as PipeStage[] }]
  refuses(() => w.q.submit([{ lists: [], wait: waits }, { lists: [w.draw(), w.again()] }]), 'hazard', /command list "again" command 0 \(copy-buffer\): buffer "vertices" is written as the destination at copy \(copy-write\), and the read at vertex-input/)
  refuses(() => go(w.r, w.draw()), 'hazard', unordered)
  raise(w.r)
  refuses(() => w.q.submit([{ lists: [], wait: waits }]), 'device', /the back end raised Error: gpu gone/)
  refuses(() => go(w.r, w.draw()), 'hazard', unordered)
  w.q.submit([{ lists: [], wait: waits }])
  go(w.r, w.draw())
})

test('a seeded run of random copies, updates, zeros and barriers agrees with a small model of the rules', () => {
  const r = rig()
  const N = 6
  const bufs = Array.from({ length: N }, (_, i) => buffer(r, 256, ['copy-src', 'copy-dst'], KIND.device, `b${i}`))
  /** Per buffer: written, and read, since the last barrier that covers it. */
  const model = { wrote: new Array<boolean>(N).fill(false), read: new Array<boolean>(N).fill(false) }
  const next = lcg(20261115)
  let refused = 0
  let accepted = 0
  for (let round = 0; round < 300; round++) {
    const saved = { wrote: model.wrote.slice(), read: model.read.slice() }
    const subs: { lists: CommandList[] }[] = []
    let expect: RegExp | null = null
    let serial = 0
    for (let si = 0; si < 1 + next(2); si++) {
      const lists: CommandList[] = []
      for (let li = 0; li < 1 + next(2); li++) {
        const label = `L${serial++}`
        const ops: (() => void)[] = []
        const list = recorded(r, label, (l) => {
          const count = 1 + next(4)
          for (let k = 0; k < count; k++) {
            const kind = next(10)
            const index = k
            const conflict = (msg: string): void => {
              if (expect === null) expect = new RegExp(`submissions\\[${si}\\] lists\\[${li}\\]: command list "${label}" command ${index} \\(${msg}\\): `)
            }
            if (kind < 3) {
              const src = next(N)
              const dst = next(N)
              l.copyBuffer(bufs[src], bufs[dst], [{ from: 0, to: 128, size: 64 }])
              ops.push(() => {
                if (model.wrote[src] || model.wrote[dst] || model.read[dst]) conflict('copy-buffer')
                if (src !== dst) model.read[src] = true
                model.wrote[dst] = true
                model.read[dst] = false
              })
            } else if (kind < 5) {
              const dst = next(N)
              const zero = kind === 4
              if (zero) l.zeroBuffer(bufs[dst], 0, 64)
              else l.updateBuffer(bufs[dst], 0, new Uint32Array([round, k]))
              ops.push(() => {
                if (model.wrote[dst] || model.read[dst]) conflict(zero ? 'zero' : 'update')
                model.wrote[dst] = true
                model.read[dst] = false
              })
            } else if (kind < 7) {
              l.barrier({ memory: [FULL] })
              ops.push(() => {
                model.wrote.fill(false)
                model.read.fill(false)
              })
            } else if (kind < 9) {
              const b = next(N)
              l.barrier({ buffers: [{ ...FULL, buffer: bufs[b] }] })
              ops.push(() => {
                model.wrote[b] = false
                model.read[b] = false
              })
            } else {
              // A barrier that covers nothing: before top.
              l.barrier({ memory: [edge(NOTHING, at(['all'], ['any-read', 'any-write']))] })
            }
          }
        })
        for (const op of ops) op()
        lists.push(list)
      }
      subs.push({ lists })
    }
    if (expect === null) {
      r.device.queue(0, 0).submit(subs)
      accepted++
    } else {
      refuses(() => r.device.queue(0, 0).submit(subs), 'hazard', expect)
      model.wrote = saved.wrote
      model.read = saved.read
      refused++
    }
  }
  assert.ok(refused > 50 && accepted > 50, `${refused} refused, ${accepted} accepted`)
})

// ---------------------------------------------------------------------------------------------------
// Costs: each of these would take the checker minutes to hours, or more memory than a machine has, if it kept a
// state for every level and layer it has seen or applied a memory barrier or a wait to every one of them.

/** A device whose image heap holds a gigabyte. */
const bigRig = (): Rig => rig({ report: { heaps: [{ index: 0, size: 1 << 30, local: true }, { index: 1, size: HEAP_HOST, local: false }] } })

/** `count` bound images of the info, a hundred to a memory. */
function manyImages(r: Rig, info: Parameters<Rig['device']['createImage']>[0], count: number): Image[] {
  const out: Image[] = []
  const need = r.device.needs(r.device.createImage(info)).size
  for (let at = 0; at < count; at += 100) {
    const memory = r.device.allocate({ size: 100 * need, kind: KIND.images })
    for (let i = 0; i < 100 && at + i < count; i++) {
      const img = r.device.createImage({ ...info, label: `i${at + i}` })
      r.device.bind(img, memory, i * need)
      out.push(img)
    }
  }
  return out
}

test('units changed together share one state: ten million levels and layers, moved whole and copied into, cost a state or two per image', () => {
  const r = bigRig()
  const staging = buffer(r, 4096, ['copy-src'], KIND.upload, 'staging')
  // 5600 images of 64 x 1, 7 levels and 256 layers: 1792 units each, 10,035,200 in all, in 182 MB of image memory.
  const all = manyImages(r, { format: 'r8', width: 64, height: 1, levels: 7, layers: 256, use: ['sampled', 'copy-dst'] }, 5600)
  const each = (label: string, body: (l: CommandList, img: Image) => void): CommandList => recorded(r, label, (l) => {
    for (const img of all) body(l, img)
  })
  go(r, each('first', (l, img) => l.barrier({ images: [move(img, 'blank', 'shader-read', NOTHING, at(['fragment'], ['shader-read']))] })))
  go(r, each('second', (l, img) => l.barrier({ images: [move(img, 'shader-read', 'copy-dst', at(['fragment']), COPIED)] })))
  // One level and layer of each is written by a copy, so its state parts from the rest of the image's.
  go(r, each('fill', (l, img) => l.copyBufferToImage(staging, img, [{ offset: 0, rowBytes: 256, region: { width: 64, height: 1 } }])))
  const back = (before: Scope): CommandList => each('back', (l, img) => l.barrier({ images: [move(img, 'copy-dst', 'shader-read', before, at(['fragment'], ['shader-read']))] }))
  refuses(() => go(r, back(at(['copy']))), 'hazard', re(cmd(0, 'barrier', 'back'), 'images[0]: moving level 0 layer 0 of image "i0" from copy-dst to shader-read does not wait for its last write, at copy (copy-write) by command list "fill" command 0 (copy-buffer-image); the barrier\'s before must cover copy and copy-write$'))
  go(r, back(COPIED))
  // Every unit is in shader-read again; one that was not moved (level 6 layer 255 of the last image) says so.
  refuses(() => go(r, recorded(r, 'late', (l) => l.barrier({ images: [move(all[5599], 'copy-dst', 'shader-read', COPIED, NOTHING, { levels: { base: 6, count: 1 }, layers: { base: 255, count: 1 } })] }))), 'layout', /the barrier takes level 6 layer 255 of image "i5599" from layout copy-dst, and it is in layout shader-read$/)
})

test('a memory barrier and a semaphore wait cost the same however many units the device has state for', () => {
  const r = bigRig()
  const q = r.device.queue(0, 0)
  // 400 images of 8 x 8, 4 levels and 256 layers: 409,600 units, each with a state.
  const all = manyImages(r, { format: 'rgba8', width: 8, height: 8, levels: 4, layers: 256, use: ['sampled', 'copy-dst'] }, 400)
  go(r, recorded(r, 'setup', (l) => {
    for (const img of all) l.barrier({ images: [move(img, 'blank', 'shader-read', NOTHING, at(['fragment'], ['shader-read']))] })
  }))
  const tally = buffer(r, 256, ['copy-dst'], KIND.device, 'tally')
  // Ten thousand memory barriers in one command, of 81 pairs of stages.
  const memory = Array.from({ length: 10_000 }, (_, k) => edge(at([ORDER_STAGES[k % 9]], ['any-write']), at([ORDER_STAGES[Math.floor(k / 9) % 9]], ['any-read', 'any-write'])))
  go(r, recorded(r, 'many', (l) => l.barrier({ memory })))
  // Two thousand full ones, each followed by a write that the next must cover.
  go(r, recorded(r, 'chain', (l) => {
    for (let k = 0; k < 2000; k++) {
      l.barrier({ memory: [FULL] })
      l.zeroBuffer(tally, 0, 256)
    }
  }))
  const careless = (): CommandList => recorded(r, 'careless', (l) => l.zeroBuffer(tally, 0, 256))
  refuses(() => go(r, careless()), 'hazard', /command list "careless" command 0 \(zero\): buffer "tally" is written as the destination at copy \(copy-write\), and its last write, at copy \(copy-write\) by command list "chain" command 3999 \(zero\), was not made visible to it/)
  // A thousand empty submissions, each waiting on the one before: the last write is then visible everywhere.
  const sems = Array.from({ length: 1000 }, () => r.device.createSemaphore())
  q.submit([{ lists: [], signal: [sems[0]] }, ...sems.slice(1).map((s, i) => ({ lists: [], wait: [{ semaphore: sems[i], stages: ['all'] as PipeStage[] }], signal: [s] }))])
  go(r, careless())
})

// ---------------------------------------------------------------------------------------------------
// The whole frame

test('three frames of a renderer: an upload on the copy queue, compute, a multisampled depth-tested pass, a resolve and a readback', () => {
  const r = rig()
  const d = r.device
  // Memory and resources.
  const staging = buffer(r, 4096, ['copy-src'], KIND.upload, 'staging')
  const vertices = buffer(r, 72, ['vertex', 'copy-dst'], KIND.device, 'vertices')
  const uniforms = buffer(r, 256, ['uniform', 'copy-dst'], KIND.device, 'uniforms')
  const particles = buffer(r, 1536, ['storage', 'vertex'], KIND.device, 'particles')
  const texture = image(r, { format: 'rgba8', width: 4, height: 4, use: ['sampled', 'copy-dst'], label: 'texture' })
  const color = imageView(r, { format: 'rgba8', width: 16, height: 16, samples: 4, use: ['color'], label: 'color' })
  const depth = imageView(r, { format: 'depth32f', width: 16, height: 16, samples: 4, use: ['depth'], label: 'depth' })
  const resolved = imageView(r, { format: 'rgba8', width: 16, height: 16, use: ['color', 'copy-src'], label: 'resolved' })
  const readback = d.allocate({ size: 4096, kind: KIND.readback, label: 'readback' }) as MemoryImpl
  const result = d.createBuffer({ size: 4096, use: ['copy-dst'], label: 'result' })
  d.bind(result, readback, 0)
  // Pipelines and sets.
  const simLayout = d.createBindingLayout({ entries: [{ binding: 0, kind: 'storage', stages: ['compute'] }] })
  const simPipe = d.createPipelineLayout({ sets: [simLayout] })
  const simulate = d.createComputePipeline({ layout: simPipe, lens: d.createLens((() => {
    const b = lens('compute', { group: [64, 1, 1] })
    const data = b.storage(0, 0, { items: arrayOf('f32') }, { writable: true })
    const i = b.pick(b.builtin('global-id'), 'x')
    b.write(data, ['items', i], b.add(b.read(data, 'items', i), 0.5))
    return b.finish()
  })()), label: 'simulate' })
  const simSet = d.createBindingPool({ sets: 1 }).allocate(simLayout, 'sim')
  simSet.write([{ binding: 0, buffer: particles }])
  const drawLayout = d.createBindingLayout({ entries: [{ binding: 0, kind: 'uniform', stages: ['fragment'] }, { binding: 1, kind: 'image', stages: ['fragment'] }, { binding: 2, kind: 'sampler', stages: ['fragment'] }] })
  const drawPipe = d.createPipelineLayout({ sets: [drawLayout] })
  const shade = d.createRenderPipeline({
    layout: drawPipe,
    vertex: { lens: d.createLens(vertexLens()), buffers: BUFFERS },
    fragment: { lens: d.createLens(texturedLens()), outputs: [{ format: 'rgba8' }] },
    depth: { format: 'depth32f', write: true, compare: 'less' },
    samples: 4,
    label: 'shade',
  })
  const material = d.createBindingPool({ sets: 1 }).allocate(drawLayout, 'material')
  material.write([{ binding: 0, buffer: uniforms, size: 16 }, { binding: 1, view: d.createView(texture) }, { binding: 2, sampler: d.createSampler({ mag: 'linear', min: 'linear' }) }])
  // The upload, on the copy-only queue, signals the first frame.
  const uploaded = d.createSemaphore({ label: 'uploaded' })
  const uploadList = recorded(r, 'upload', (l) => {
    l.barrier({ images: [move(texture, 'blank', 'copy-dst', NOTHING, COPIED)] })
    l.copyBuffer(staging, vertices, [{ from: 0, to: 0, size: 72 }])
    l.copyBufferToImage(staging, texture, [{ offset: 256, rowBytes: 256, region: { width: 4, height: 4 } }])
  }, 1)
  d.queue(1, 0).submit([{ lists: [uploadList], signal: [uploaded] }])
  const frame = (n: number): CommandList => recorded(r, `frame ${n}`, (l) => {
    if (n === 0) l.barrier({ images: [move(texture, 'copy-dst', 'shader-read', COPIED, at(['fragment'], ['shader-read']))] })
    // What the last frame read and wrote, ordered before this frame writes it again.
    l.barrier({
      buffers: [
        { ...edge(at(['compute', 'vertex-input'], ['shader-write']), at(['compute'], ['shader-read', 'shader-write'])), buffer: particles },
        { ...edge(at(['copy', 'fragment'], ['copy-write']), COPIED), buffer: uniforms },
        { ...edge(COPIED, COPIED), buffer: result },
      ],
      images: [
        move(color.image, 'blank', 'color', at(['color'], ['color-write']), at(['color'], ['color-write'])),
        move(depth.image, 'blank', 'depth', at(['depth'], ['depth-write']), at(['depth'], ['depth-read', 'depth-write'])),
        move(resolved.image, 'blank', 'color', at(['copy']), at(['color'], ['color-write'])),
      ],
    })
    l.updateBuffer(uniforms, 0, new Float32Array([1, 1, 1, n]))
    l.bindPipeline(simulate)
    l.bindSets(simPipe, 0, [simSet])
    l.dispatch(1)
    l.barrier({
      buffers: [
        { ...edge(at(['compute'], ['shader-write']), at(['vertex-input'], ['vertex-read'])), buffer: particles },
        { ...edge(COPIED, at(['fragment'], ['uniform-read'])), buffer: uniforms },
      ],
    })
    l.beginPass({ colors: [{ view: color, load: 'clear', store: 'any', resolve: resolved }], depth: { view: depth, load: 'clear', store: 'any' } })
    l.bindPipeline(shade)
    l.bindSets(drawPipe, 0, [material])
    l.bindVertices(0, [{ buffer: vertices }])
    l.draw(3)
    l.bindVertices(0, [{ buffer: particles }])
    l.draw(64)
    l.endPass()
    l.barrier({ images: [move(resolved.image, 'color', 'copy-src', at(['color'], ['color-write']), at(['copy'], ['copy-read']))] })
    l.copyImageToBuffer(resolved.image, result, [{ offset: 0, rowBytes: 256, region: { width: 16, height: 16 } }])
    l.barrier({ buffers: [{ ...edge(COPIED, at(['host'], ['host-read'])), buffer: result }] })
  })
  for (let n = 0; n < 3; n++) {
    const fence = d.createFence({ label: `frame ${n}` })
    const wait = n === 0 ? [{ semaphore: uploaded, stages: ['copy', 'vertex-input', 'fragment'] as PipeStage[] }] : []
    d.queue(0, 0).submit([{ lists: [frame(n)], wait }], fence)
    assert.equal(fence.signalled, true)
    hostRead(readback, 0, 4096, 'memory "readback" invalidate')
    readback.invalidate()
  }
  assert.equal(r.fake.named('submit').length, 4)
  assert.deepEqual(r.faults, [])
  // A fourth frame without its opening barrier is refused at the first command that needs it.
  const careless = recorded(r, 'careless', (l) => {
    l.updateBuffer(uniforms, 0, new Float32Array([0, 0, 0, 0]))
  })
  refuses(() => d.queue(0, 0).submit([{ lists: [careless] }]), 'hazard', /command list "careless" command 0 \(update\): buffer "uniforms" is written as the destination at copy \(copy-write\), and its last write, at copy \(copy-write\) by command list "frame 2" command 1 \(update\), was not made visible to it/)
})
