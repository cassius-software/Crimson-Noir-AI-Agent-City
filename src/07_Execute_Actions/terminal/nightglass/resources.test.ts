// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins every rule of making buffers, images, views and samplers: sizes and limits,
 * known names and use lists, what each format allows an image to be used for, the four-sample image, a view's range
 * and shape, a sampler's defaults and level range, and the order in which an image and its views are destroyed.
 * Each rule has a call it refuses and a call it accepts.
 * What breaks if it is removed? A malformed buffer, image, view or sampler could reach a back end, and no test would
 * notice a rule of the specification going missing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ImageInfo } from './api.ts'
import { FORMAT_NAMES, FORMATS } from './formats.ts'
import { KIND, image, refuses, rig } from './harness.test.ts'
import { levelChain } from './resources.ts'

test('createBuffer: a positive multiple of 4 within the limit, and a use list of known names, each once', () => {
  const r = rig()
  const d = r.device
  refuses(() => d.createBuffer({ size: 0, use: ['vertex'] }), 'invalid', /the size 0 is not a whole number of at least 1/)
  refuses(() => d.createBuffer({ size: 6, use: ['vertex'] }), 'invalid', /the size 6 is not a multiple of 4/)
  refuses(() => d.createBuffer({ size: 4.5, use: ['vertex'] }), 'invalid', /the size 4.5/)
  refuses(() => d.createBuffer({ size: 2 ** 28 + 4, use: ['vertex'] }), 'limit', /largest buffer, 268435456 bytes/)
  refuses(() => d.createBuffer({ size: 4, use: [] }), 'invalid', /the use is empty/)
  refuses(() => d.createBuffer({ size: 4, use: ['vertex', 'vertex'] }), 'invalid', /names vertex twice/)
  refuses(() => d.createBuffer({ size: 4, use: ['texture'] as never }), 'invalid', /the use entry "texture" is not one of vertex, index, uniform, storage, indirect, copy-src, copy-dst/)
  refuses(() => d.createBuffer({ size: 4, use: 'vertex' as never }), 'invalid', /the use is a list/)
  refuses(() => d.createBuffer({ size: 4, use: ['vertex'], usage: [] } as never), 'invalid', /has no field "usage"/)
  const b = d.createBuffer({ size: 2 ** 28, use: ['vertex', 'copy-dst'], label: 'big' })
  assert.equal(b.size, 2 ** 28)
  assert.deepEqual(b.use, ['vertex', 'copy-dst'])
  assert.ok(Object.isFrozen(b.use))
  assert.equal(b.memory, null)
  assert.equal(b.offset, 0)
  assert.equal(b.destroyed, false)
  // Nothing reaches the back end until the buffer is bound.
  assert.equal(r.fake.named('createBuffer').length, 0)
})

test('createImage: format, size, layers, levels, samples and use, each checked', () => {
  const r = rig()
  const d = r.device
  const ok: ImageInfo = { format: 'rgba8', width: 16, height: 8, use: ['sampled'] }
  refuses(() => d.createImage({ ...ok, format: 'rgb8' as never }), 'invalid', /the format "rgb8" is not one of/)
  refuses(() => d.createImage({ ...ok, width: 0 }), 'invalid', /the width 0/)
  refuses(() => d.createImage({ ...ok, height: 2.5 }), 'invalid', /the height 2.5/)
  refuses(() => d.createImage({ ...ok, width: 8193 }), 'limit', /8193 x 8 is larger than the device's largest image, 8192 x 8192/)
  refuses(() => d.createImage({ ...ok, layers: 0 }), 'invalid', /the layer count 0/)
  refuses(() => d.createImage({ ...ok, layers: 257 }), 'limit', /257 layers is more than the device allows, 256/)
  refuses(() => d.createImage({ ...ok, levels: 0 }), 'invalid', /the level count 0/)
  refuses(() => d.createImage({ ...ok, levels: 6 }), 'invalid', /6 levels is more than a 16 x 8 image has, 5/)
  refuses(() => d.createImage({ ...ok, samples: 2 as never }), 'invalid', /the sample count 2 is not 1 or 4/)
  refuses(() => d.createImage({ ...ok, use: [] }), 'invalid', /the use is empty/)
  refuses(() => d.createImage({ ...ok, use: ['vertex'] as never }), 'invalid', /the use entry "vertex"/)
  const img = d.createImage({ ...ok, levels: 5, layers: 3 })
  assert.deepEqual([img.format, img.width, img.height, img.layers, img.levels, img.samples], ['rgba8', 16, 8, 3, 5, 1])
  const plain = d.createImage(ok)
  assert.deepEqual([plain.layers, plain.levels, plain.samples], [1, 1, 1])
  assert.equal(d.createImage({ ...ok, width: 8192, height: 8192, levels: 14 }).levels, 14)
})

test('the level chain of an image runs down to 1 x 1', () => {
  assert.equal(levelChain(1, 1), 1)
  assert.equal(levelChain(2, 1), 2)
  assert.equal(levelChain(3, 1), 2)
  assert.equal(levelChain(16, 8), 5)
  assert.equal(levelChain(17, 3), 5)
  assert.equal(levelChain(8192, 1), 14)
})

test('an image use asks the format for the matching ability; every format may be sampled and copied', () => {
  const d = rig().device
  for (const format of FORMAT_NAMES) {
    const f = FORMATS[format]
    const make = (use: ImageInfo['use']): unknown => d.createImage({ format, width: 4, height: 4, use })
    make(['sampled', 'copy-src', 'copy-dst'])
    if (f.color) make(['color'])
    else refuses(() => make(['color']), 'invalid', new RegExp(`${format} cannot be a colour attachment`))
    if (f.depth) make(['depth'])
    else refuses(() => make(['depth']), 'invalid', new RegExp(`${format} is not a depth format`))
    if (f.storage) make(['storage'])
    else refuses(() => make(['storage']), 'invalid', new RegExp(`${format} cannot be a storage image`))
  }
})

test('a four-sample image is only an attachment, of one level and one layer', () => {
  const d = rig().device
  const ms: ImageInfo = { format: 'rgba8', width: 8, height: 8, samples: 4, use: ['color'] }
  assert.equal(d.createImage(ms).samples, 4)
  d.createImage({ ...ms, format: 'depth32f', use: ['depth'] })
  for (const extra of ['sampled', 'storage', 'copy-src', 'copy-dst'] as const) {
    refuses(() => d.createImage({ ...ms, use: ['color', extra] }), 'invalid', new RegExp(`only an attachment; its use cannot hold ${extra}`))
  }
  refuses(() => d.createImage({ ...ms, levels: 2 }), 'invalid', /one level and one layer, not 2 and 1/)
  refuses(() => d.createImage({ ...ms, layers: 2 }), 'invalid', /one level and one layer, not 1 and 2/)
  d.createImage({ ...ms, format: 'rgba16f' })
  for (const format of ['r32f', 'rg32f', 'rgba32f', 'r32u', 'r32i'] as const) {
    refuses(() => d.createImage({ ...ms, format }), 'invalid', new RegExp(`${format} cannot take four samples`))
  }
})

test('createView: the image bound, ranges inside it, the shape fitting the layers', () => {
  const r = rig()
  const d = r.device
  const unbound = d.createImage({ format: 'rgba8', width: 8, height: 8, use: ['sampled'], label: 'loose' })
  refuses(() => d.createView(unbound), 'state', /image "loose" is not bound to memory yet/)
  refuses(() => d.createView({} as never), 'invalid', /the image is not an Image, but an object/)
  const img = image(r, { format: 'rgba8', width: 8, height: 8, levels: 4, layers: 6, use: ['sampled'] })
  refuses(() => d.createView(img, { levels: { base: 3, count: 2 } }), 'invalid', /the levels 3 to 4 run past the 4 there are/)
  refuses(() => d.createView(img, { layers: { base: 0, count: 0 } }), 'invalid', /the layers count 0/)
  refuses(() => d.createView(img, { layers: { base: -1, count: 1 } }), 'invalid', /the layers base -1/)
  refuses(() => d.createView(img, { layers: { base: 0 } } as never), 'invalid', /the layers count undefined/)
  refuses(() => d.createView(img, { dims: '2d' }), 'invalid', /a 2d view has one layer, not 6/)
  refuses(() => d.createView(img, { dims: 'cube' as never }), 'invalid', /the shape "cube" is not one of 2d, 2d-array/)
  refuses(() => d.createView(img, { mips: 1 } as never), 'invalid', /has no field "mips"/)
  const all = d.createView(img)
  assert.equal(all.dims, '2d-array')
  assert.deepEqual([all.levels, all.layers], [{ base: 0, count: 4 }, { base: 0, count: 6 }])
  const one = d.createView(img, { levels: { base: 2, count: 1 }, layers: { base: 5, count: 1 }, label: 'corner' })
  assert.equal(one.dims, '2d')
  assert.equal(one.image, img)
  assert.equal(one.label, 'corner')
  const arr = d.createView(img, { dims: '2d-array', layers: { base: 1, count: 1 } })
  assert.equal(arr.dims, '2d-array')
  const call = r.fake.last('createView').args
  assert.deepEqual(call.slice(1), ['2d-array', { base: 0, count: 4 }, { base: 1, count: 1 }])
})

test('an image is destroyed only after its views', () => {
  const r = rig()
  const img = image(r, { format: 'rgba8', width: 4, height: 4, use: ['sampled'], label: 'tex' })
  const v = r.device.createView(img, { label: 'whole' })
  refuses(() => img.destroy(), 'lifetime', /view "whole" of it is still alive; destroy an image's views first/)
  v.destroy()
  img.destroy()
  refuses(() => r.device.createView(img), 'lifetime', /image "tex" is destroyed/)
  refuses(() => v.destroy(), 'lifetime')
})

test('createSampler: defaults, wrap modes, filters and the level range', () => {
  const r = rig()
  const d = r.device
  const s = d.createSampler()
  assert.deepEqual([s.mag, s.min, s.mip, s.wrap, s.lodMin, s.lodMax], ['nearest', 'nearest', 'nearest', ['clamp', 'clamp', 'clamp'], 0, 32])
  const t = d.createSampler({ mag: 'linear', min: 'linear', mip: 'linear', wrap: 'repeat', lodMin: 1, lodMax: 4, label: 'lin' })
  assert.deepEqual(t.wrap, ['repeat', 'repeat', 'repeat'])
  assert.deepEqual(d.createSampler({ wrap: ['clamp', 'mirror', 'repeat'] }).wrap, ['clamp', 'mirror', 'repeat'])
  assert.deepEqual(r.fake.named('createSampler')[1].args[0], { mag: 'linear', min: 'linear', mip: 'linear', wrap: ['repeat', 'repeat', 'repeat'], lodMin: 1, lodMax: 4, label: 'lin' })
  refuses(() => d.createSampler({ mag: 'cubic' as never }), 'invalid', /the mag filter "cubic" is not one of nearest, linear/)
  refuses(() => d.createSampler({ wrap: 'border' as never }), 'invalid', /the wrap mode "border"/)
  refuses(() => d.createSampler({ wrap: ['clamp', 'clamp'] as never }), 'invalid', /one mode or a list of three/)
  refuses(() => d.createSampler({ wrap: ['clamp', 'clamp', 'edge'] as never }), 'invalid', /wrap mode 2 "edge"/)
  refuses(() => d.createSampler({ lodMin: -1 }), 'invalid', /0 <= lodMin <= lodMax <= 32/)
  refuses(() => d.createSampler({ lodMin: 5, lodMax: 4 }), 'invalid', /5 to 4/)
  refuses(() => d.createSampler({ lodMax: 33 }), 'invalid', /0 to 33/)
  refuses(() => d.createSampler({ lodMax: Number.NaN }), 'invalid', /lodMax NaN is not a finite number/)
  refuses(() => d.createSampler({ anisotropy: 4 } as never), 'invalid', /has no field "anisotropy"/)
  d.createSampler({ lodMin: 32, lodMax: 32 })
})

test('resources of a destroyed device, or of another device, are refused', () => {
  const r = rig()
  const other = rig()
  const img = image(other, { format: 'rgba8', width: 4, height: 4, use: ['sampled'] })
  refuses(() => r.device.createView(img), 'mismatch', /belongs to another device/)
  const mem = r.device.allocate({ size: 256, kind: KIND.images })
  const mine = r.device.createImage({ format: 'r8', width: 2, height: 2, use: ['sampled'] })
  r.device.bind(mine, mem, 0)
  assert.equal(r.device.createView(mine).image, mine)
})

test('a view of a four-sample image is 2d: a 2d-array view of one is refused', () => {
  const r = rig()
  const ms = image(r, { format: 'rgba8', width: 4, height: 4, samples: 4, use: ['color'], label: 'ms' })
  refuses(() => r.device.createView(ms, { dims: '2d-array' }), 'invalid', /^device 1 createView: a view of a four-sample image is 2d, not 2d-array$/)
  assert.equal(r.device.createView(ms).dims, '2d')
  assert.equal(r.device.createView(ms, { dims: '2d' }).dims, '2d')
  assert.deepEqual(r.fake.named('createView').map((c) => c.args[1]), ['2d', '2d'])
})

test('createView runs as one call: a getter of its info cannot destroy the image or its memory', () => {
  const r = rig()
  const img = r.device.createImage({ format: 'rgba8', width: 4, height: 4, use: ['color', 'copy-src'], label: 'img' })
  const mem = r.device.allocate({ size: r.device.needs(img).size, kind: KIND.images })
  r.device.bind(img, mem, 0)
  const views = r.fake.named('createView').length
  const info = {
    get levels() {
      img.destroy()
      mem.destroy()
      return undefined
    },
  }
  refuses(() => r.device.createView(img, info), 'state', /^image "img" destroy: called from inside another Nightglass call \(device 1 createView\)/)
  assert.deepEqual([img.destroyed, mem.destroyed], [false, false])
  assert.equal(r.fake.named('createView').length, views)
  // No view was made, so the image goes as soon as it is asked to.
  img.destroy()
  mem.destroy()
})

test('createSampler reads the wrap once: the checked modes are the ones kept', () => {
  const r = rig()
  let reads = 0
  const info = {
    get wrap() {
      reads++
      return reads < 5 ? ['clamp', 'mirror', 'repeat'] : ['clamp']
    },
  }
  const s = r.device.createSampler(info as never)
  assert.equal(reads, 1)
  assert.deepEqual(s.wrap, ['clamp', 'mirror', 'repeat'])
  assert.deepEqual((r.fake.last('createSampler').args[0] as { readonly wrap: unknown }).wrap, ['clamp', 'mirror', 'repeat'])
})
