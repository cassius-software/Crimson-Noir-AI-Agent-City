// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It draws whole scenes the way an app would, through index.ts and nothing else: a small
 * app that opens the reference renderer, sub-allocates its memory by what each resource needs, stages its data
 * through upload memory, writes its shaders with the Lens builder, records a frame once and submits it again and
 * again, runs a compute pass ahead of a render pass, names every barrier, and reads its pictures back through
 * readback memory. Each picture is compared byte for byte with a model worked out here from the rules of
 * docs/nightglass.md (f32 rounding after every shader operation, fine differences across 2 x 2 quads, the top-left
 * rule, unorm rounding, WebGPU blending in double precision rounded once to f32), and the frame is also pinned by its
 * checksum. It also pins the public face itself: exactly which values index.ts exports.
 * What breaks if it is removed? Each part of Nightglass is tested on its own, but nothing would show that they fit
 * together as an app meets them: that a list recorded once can be submitted again, that the barriers an app writes
 * are the ones the checker asks for, that a shader can travel as words, and that index.ts exports what an app needs
 * and nothing it must not lean on.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import * as nightglass from './index.ts'
import {
  LENS_MAGIC, LENS_VERSION, block, createInstance, decode, disassemble, encode, isFault, layoutBlock, lens, looksLikeLens, softBackend, verify,
} from './index.ts'
import type {
  BindingEntry, BindingSet, Buffer, ColorOutput, CommandArena, CommandList, ComputePipeline, Device, Fault, FaultCode, Fence, Image, ImageInfo,
  LensModule, Memory, MemoryKindName, PipelineLayout, Queue, RenderPipeline, Scope, Val, VertexBufferLayout,
} from './index.ts'

// ---------------------------------------------------------------------------------------------------
// The arithmetic the model is built from, as docs/nightglass.md states it

const f32 = Math.fround
type Rgba = readonly [number, number, number, number]

/** WGSL's min and max, which the spec's shaders use: the second operand when it is below (above) the first. */
const minOf = (a: number, b: number): number => (b < a ? b : a)
const maxOf = (a: number, b: number): number => (b > a ? b : a)
const saturate = (x: number): number => (x > 0 ? (x < 1 ? x : 1) : 0)
/** The byte a unorm8 channel stores: clamped to 0..1, then rounded to nearest. */
const unorm8 = (x: number): number => Math.floor(saturate(x) * 255 + 0.5)
/** What a unorm8 byte reads as: the nearest f32 to its fraction of 255. */
const fromUnorm8 = (b: number): number => f32(b / 255)
/** mix(a, b, t) = a (1 - t) + b t, each operation rounded to f32. */
const mix = (a: number, b: number, t: number): number => f32(f32(a * f32(1 - t)) + f32(b * t))

/** A seeded linear congruential generator: the same numbers on every run. */
function lcg(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** FNV-1a over bytes: the checksum a frame is pinned by. */
function checksum(bytes: Uint8Array): number {
  let h = 0x811c9dc5
  for (const b of bytes) h = Math.imul(h ^ b, 0x01000193) >>> 0
  return h
}

/** Blends a colour over one rgba8 pixel by src-alpha / one-minus-src-alpha (one / one-minus-src-alpha for alpha). */
function over(pixels: Uint8Array, at: number, src: Rgba): void {
  const s = src.map(saturate)
  const a = s[3]
  for (let c = 0; c < 4; c++) {
    const d = fromUnorm8(pixels[at + c])
    // In double precision, the source term first, rounded once to f32 when stored.
    const r = (c < 3 ? s[c] * a : a * 1) + d * (1 - a)
    pixels[at + c] = unorm8(f32(saturate(r)))
  }
}

/** The texels of a picture read back with `rowBytes` bytes from row to row, packed row after row. */
function packed(bytes: Uint8Array, width: number, height: number, rowBytes: number): Uint8Array {
  const out = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) out.set(bytes.subarray(y * rowBytes, y * rowBytes + width * 4), y * width * 4)
  return out
}

/** Asserts two pictures are the same bytes, naming the first pixel that differs. */
function samePicture(actual: Uint8Array, expected: Uint8Array, width: number, what: string): void {
  assert.equal(actual.length, expected.length, `${what}: size`)
  for (let i = 0; i < actual.length; i += 4) {
    const a = Array.from(actual.subarray(i, i + 4))
    const e = Array.from(expected.subarray(i, i + 4))
    if (a.some((v, c) => v !== e[c])) assert.fail(`${what}: pixel (${(i / 4) % width}, ${Math.floor(i / 4 / width)}) is ${a}, the model says ${e}`)
  }
}

function refuses(f: () => unknown, code: FaultCode, pattern?: RegExp): Fault {
  let caught: unknown = null
  try {
    f()
  } catch (e) {
    caught = e
  }
  assert.ok(isFault(caught), `expected a Fault of code ${code}, got ${caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught)}`)
  assert.equal(caught.code, code, caught.message)
  if (pattern !== undefined) assert.match(caught.message, pattern)
  return caught
}

// ---------------------------------------------------------------------------------------------------
// The app: an instance on the reference renderer, memory handed out by need, staging and readback

const NOTHING: Scope = { stages: ['top'] }
const COPY_WRITE: Scope = { stages: ['copy'], access: ['copy-write'] }
const COPY_READ: Scope = { stages: ['copy'], access: ['copy-read'] }
const HOST_READ: Scope = { stages: ['host'], access: ['host-read'] }

/** One allocation of a memory kind, handing out its bytes in order at the alignment each resource needs. */
class Slab {
  readonly memory: Memory
  private readonly device: Device
  private readonly kind: number
  private at = 0

  constructor(device: Device, kind: MemoryKindName, size: number) {
    this.device = device
    const found = device.adapter.kinds.find((k) => k.name === kind)
    assert.ok(found !== undefined, kind)
    this.kind = found.index
    this.memory = device.allocate({ size, kind: this.kind, label: kind })
  }

  place<T extends Buffer | Image>(resource: T): T {
    const needs = this.device.needs(resource)
    assert.ok(needs.kinds.includes(this.kind), `${resource.label} may not live in ${this.memory.kind.name} memory`)
    this.at = Math.ceil(this.at / needs.align) * needs.align
    this.device.bind(resource, this.memory, this.at)
    this.at += needs.size
    return resource
  }
}

class App {
  readonly device: Device
  readonly queue: Queue
  readonly arena: CommandArena
  private readonly slabs: { readonly [K in MemoryKindName]: Slab }

  constructor(checks = true) {
    const instance = createInstance({ app: 'scene', backends: [softBackend()], checks })
    const adapter = instance.adapters()[0]
    assert.equal(adapter.kind, 'reference')
    this.device = instance.open(adapter, { label: 'scene' })
    this.queue = this.device.queue(0, 0)
    this.arena = this.device.createCommandArena({ label: 'scene' })
    const slab = (kind: MemoryKindName): Slab => new Slab(this.device, kind, 1 << 20)
    this.slabs = { device: slab('device'), images: slab('images'), upload: slab('upload'), readback: slab('readback') }
  }

  buffer(size: number, use: Buffer['use'], kind: MemoryKindName = 'device', label?: string): Buffer {
    return this.slabs[kind].place(this.device.createBuffer({ size, use, label }))
  }

  image(info: ImageInfo): Image {
    return this.slabs.images.place(this.device.createImage(info))
  }

  /** An upload buffer holding `bytes`, written through map() and flushed, for a copy to take from. */
  staging(bytes: Uint8Array): Buffer {
    const b = this.buffer(Math.ceil(bytes.length / 4) * 4, ['copy-src'], 'upload', 'staging')
    const memory = b.memory as Memory
    memory.map().set(bytes, b.offset)
    memory.flush(b.offset, b.size)
    return b
  }

  /** Records a list that runs once, submits it with a fence, and checks the fence signalled. */
  run(label: string, record: (l: CommandList) => void): void {
    const l = this.arena.allocate(label)
    l.begin({ once: true })
    record(l)
    l.end()
    const fence = this.device.createFence({ label })
    this.queue.submit([{ lists: [l] }], fence)
    assert.ok(fence.signalled, label)
  }

  /** A readback buffer's bytes, taken into the host's view once the work that wrote them is done. */
  take(b: Buffer): Uint8Array {
    const memory = b.memory as Memory
    memory.invalidate(b.offset, b.size)
    return memory.map().slice(b.offset, b.offset + b.size)
  }
}

// ---------------------------------------------------------------------------------------------------
// The frame: a gradient panel with rounded, antialiased corners and a glyph over it, on a cleared background

const W = 64
const H = 48
const BACKGROUND: Rgba = [0.0625, 0.125, 0.1875, 1]
/** The panel: pixels [8, 56) x [8, 40), corners of radius 6, from orange at the top to azure at the bottom. */
const PANEL = Object.freeze({ x0: 8, y0: 8, x1: 56, y1: 40, radius: 6, top: [1, 0.5, 0, 0.875] as Rgba, bottom: [0, 0.5, 1, 0.875] as Rgba })
/** The glyph's square: 8 x 8 texels drawn 2 x 2 pixels each at [36, 52) x [16, 32). */
const GLYPH_AT = Object.freeze({ x: 36, y: 16, size: 16 })
/** An N: `#` full coverage, `+` half (128 of 255), `.` none. */
const GLYPH = ['#......#', '##.....#', '#+#....#', '#.+#...#', '#..+#..#', '#...+#.#', '#....+##', '#......#']
const glyphLevel = (ch: string): number => (ch === '#' ? 255 : ch === '+' ? 128 : 0)
const WHITE: Rgba = [1, 1, 1, 1]

/** The block both fragment shaders read, and the block of inline constants the vertex shader reads. */
const FRAME_BLOCK = block({ rect: 'f32x4', top: 'f32x4', bottom: 'f32x4', tint: 'f32x4', radius: 'f32' })
const SCREEN_BLOCK = block({ size: 'f32x2' })

/** The frame block's bytes, laid out by layoutBlock as the shader reads it. */
function frameBytes(tint: Rgba): Uint8Array {
  const { size, offsets } = layoutBlock(FRAME_BLOCK, 'uniform')
  const values: { readonly [name: string]: readonly number[] } = {
    rect: [PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1], top: PANEL.top, bottom: PANEL.bottom, tint, radius: [PANEL.radius],
  }
  const out = new Float32Array(size / 4)
  FRAME_BLOCK.fields.forEach((field, i) => out.set(values[field.name], offsets[i] / 4))
  return new Uint8Array(out.buffer)
}

/** Two triangles over pixels [x0, x1) x [y0, y1): pixel position, then uv, per vertex. */
function quad(x0: number, y0: number, x1: number, y1: number): number[] {
  const v = (x: number, y: number, u: number, w: number): number[] => [x, y, u, w]
  return [...v(x0, y0, 0, 0), ...v(x1, y0, 1, 0), ...v(x0, y1, 0, 1), ...v(x0, y1, 0, 1), ...v(x1, y0, 1, 0), ...v(x1, y1, 1, 1)]
}
const SPRITES = new Float32Array([...quad(PANEL.x0, PANEL.y0, PANEL.x1, PANEL.y1), ...quad(GLYPH_AT.x, GLYPH_AT.y, GLYPH_AT.x + GLYPH_AT.size, GLYPH_AT.y + GLYPH_AT.size)])
const SPRITE_BUFFERS: readonly VertexBufferLayout[] = [{ stride: 16, attributes: [{ slot: 0, format: 'f32x2', offset: 0 }, { slot: 1, format: 'f32x2', offset: 8 }] }]
const OVER: ColorOutput = { format: 'rgba8', blend: { color: { src: 'src-alpha', dst: 'one-minus-src-alpha' }, alpha: { src: 'one', dst: 'one-minus-src-alpha' } } }

/** Pixel positions (slot 0) and uv (slot 1) in; the clip position from the screen size, and uv passed on at slot 0. */
function spriteVertex(): LensModule {
  const b = lens('vertex')
  const screen = b.constants(SCREEN_BLOCK)
  const ndc = b.sub(b.mul(b.div(b.input(0, 'f32x2'), b.read(screen, 'size')), 2), 1)
  b.position(b.make('f32x4', b.mul(ndc, b.f32x2(1, -1)), 0, 1))
  b.out(b.output(0, 'f32x2'), b.input(1, 'f32x2'))
  return b.finish()
}

/**
 * The panel: a vertical gradient whose alpha is scaled by the coverage of a rounded rectangle. The signed distance d
 * to the rectangle is negative inside; its width (|dx| + |dy| across the quad) is how far it moves in one pixel, so
 * 0.5 - d / width ramps from 0 to 1 across the one pixel the edge passes through.
 */
function panelFragment(): LensModule {
  const b = lens('fragment')
  const frame = b.uniform(0, 0, FRAME_BLOCK)
  const rect = b.read(frame, 'rect')
  const lo = b.pick(rect, 'xy')
  const hi = b.pick(rect, 'zw')
  const radius = b.read(frame, 'radius')
  const centre = b.mul(b.add(lo, hi), 0.5)
  const half = b.mul(b.sub(hi, lo), 0.5)
  const at = b.pick(b.builtin('frag-coord'), 'xy')
  const q = b.sub(b.abs(b.sub(at, centre)), b.sub(half, radius))
  const d = b.sub(b.add(b.length(b.max(q, 0)), b.min(b.max(b.pick(q, 'x'), b.pick(q, 'y')), 0)), radius)
  const cover = b.saturate(b.sub(0.5, b.div(d, b.deriv('width', d))))
  const t = b.div(b.sub(b.pick(at, 'y'), b.pick(lo, 'y')), b.sub(b.pick(hi, 'y'), b.pick(lo, 'y')))
  const color = b.mix(b.read(frame, 'top'), b.read(frame, 'bottom'), t)
  b.out(b.output(0, 'f32x4'), b.make('f32x4', b.pick(color, 'xyz'), b.mul(b.pick(color, 'w'), cover)))
  return b.finish()
}

/** The glyph: the tint, its alpha scaled by the coverage the glyph texture holds in its red channel. */
function glyphFragment(): LensModule {
  const b = lens('fragment')
  const frame = b.uniform(0, 0, FRAME_BLOCK)
  const coverage = b.pick(b.sample(b.image(0, 1), b.sampler(0, 2), b.input(0, 'f32x2')), 'x')
  const tint = b.read(frame, 'tint')
  b.out(b.output(0, 'f32x4'), b.make('f32x4', b.pick(tint, 'xyz'), b.mul(b.pick(tint, 'w'), coverage)))
  return b.finish()
}

/** The panel's signed distance at a pixel centre, each operation rounded to f32 as the shader does it. */
function panelDistance(fx: number, fy: number): number {
  const { x0, y0, x1, y1, radius } = PANEL
  const cx = f32(f32(x0 + x1) * 0.5)
  const cy = f32(f32(y0 + y1) * 0.5)
  const qx = f32(Math.abs(f32(fx - cx)) - f32(f32(f32(x1 - x0) * 0.5) - radius))
  const qy = f32(Math.abs(f32(fy - cy)) - f32(f32(f32(y1 - y0) * 0.5) - radius))
  // length() runs in double precision and rounds once.
  const outside = f32(Math.sqrt(maxOf(qx, 0) ** 2 + maxOf(qy, 0) ** 2))
  return f32(f32(outside + minOf(maxOf(qx, qy), 0)) - radius)
}

/** The panel's colour and coverage at pixel (x, y), with the width of d taken across the pixel's 2 x 2 quad. */
function panelColor(x: number, y: number): Rgba {
  const qx = x & ~1
  const qy = y & ~1
  const d = [panelDistance(qx + 0.5, qy + 0.5), panelDistance(qx + 1.5, qy + 0.5), panelDistance(qx + 0.5, qy + 1.5), panelDistance(qx + 1.5, qy + 1.5)]
  const lane = (x & 1) + 2 * (y & 1)
  // Fine differences: along x within the row, along y within the column.
  const dx = f32(lane < 2 ? d[1] - d[0] : d[3] - d[2])
  const dy = f32((lane & 1) === 0 ? d[2] - d[0] : d[3] - d[1])
  const cover = saturate(f32(0.5 - f32(d[lane] / f32(Math.abs(dx) + Math.abs(dy)))))
  const t = f32(f32(y + 0.5 - PANEL.y0) / f32(PANEL.y1 - PANEL.y0))
  const c = PANEL.top.map((a, i) => mix(a, PANEL.bottom[i], t))
  return [c[0], c[1], c[2], f32(c[3] * cover)]
}

/** The frame the model says the app draws with this tint on the glyph. */
function frameModel(tint: Rgba): Uint8Array {
  const pixels = new Uint8Array(W * H * 4)
  const bg = BACKGROUND.map(unorm8)
  for (let i = 0; i < W * H; i++) pixels.set(bg, i * 4)
  // Every pixel centre of the panel's rectangle is inside exactly one of its two triangles (the top-left rule).
  for (let y = PANEL.y0; y < PANEL.y1; y++) for (let x = PANEL.x0; x < PANEL.x1; x++) over(pixels, (y * W + x) * 4, panelColor(x, y))
  for (let j = 0; j < GLYPH_AT.size; j++) {
    for (let i = 0; i < GLYPH_AT.size; i++) {
      // Nearest filtering at twice the size: pixel i's centre is at texel i / 2 + 0.25, so it reads texel i >> 1.
      const coverage = fromUnorm8(glyphLevel(GLYPH[j >> 1][i >> 1]))
      over(pixels, ((GLYPH_AT.y + j) * W + GLYPH_AT.x + i) * 4, [tint[0], tint[1], tint[2], f32(tint[3] * coverage)])
    }
  }
  return pixels
}

/**
 * The app's frame: its resources staged once, and one command list recorded once that clears the picture, draws the
 * panel and the glyph, and copies the picture into readback memory. `shader` is what each Lens module is handed to
 * createLens as (the module itself, or its words).
 */
class Frame {
  readonly app: App
  readonly picture: Image
  readonly readback: Buffer
  readonly uniforms: Buffer
  readonly list: CommandList

  constructor(app: App, shader: (m: LensModule) => Uint32Array | LensModule = (m) => m) {
    this.app = app
    const { device } = app
    this.picture = app.image({ format: 'rgba8', width: W, height: H, use: ['color', 'copy-src'], label: 'frame' })
    const glyph = app.image({ format: 'r8', width: 8, height: 8, use: ['sampled', 'copy-dst'], label: 'glyph' })
    const vertices = app.buffer(SPRITES.byteLength, ['vertex', 'copy-dst'], 'device', 'sprites')
    this.uniforms = app.buffer(256, ['uniform', 'copy-dst'], 'device', 'frame block')
    this.readback = app.buffer(W * 4 * H, ['copy-dst'], 'readback', 'frame readback')

    // One staging buffer: the glyph's rows 256 bytes apart (the copy row alignment), then the sprites, then the block.
    const staged = new Uint8Array(2560)
    GLYPH.forEach((row, y) => [...row].forEach((ch, x) => (staged[y * 256 + x] = glyphLevel(ch))))
    staged.set(new Uint8Array(SPRITES.buffer), 2048)
    staged.set(frameBytes(WHITE), 2304)
    const staging = app.staging(staged)
    app.run('setup', (l) => {
      l.barrier({ images: [{ image: glyph, from: 'blank', to: 'copy-dst', before: NOTHING, after: COPY_WRITE }] })
      l.copyBufferToImage(staging, glyph, [{ offset: 0, rowBytes: 256, region: { width: 8, height: 8 } }])
      l.copyBuffer(staging, vertices, [{ from: 2048, to: 0, size: SPRITES.byteLength }])
      l.copyBuffer(staging, this.uniforms, [{ from: 2304, to: 0, size: 80 }])
      l.barrier({
        images: [{ image: glyph, from: 'copy-dst', to: 'shader-read', before: COPY_WRITE, after: { stages: ['fragment'], access: ['shader-read'] } }],
        buffers: [
          { buffer: vertices, before: COPY_WRITE, after: { stages: ['vertex-input'], access: ['vertex-read'] } },
          { buffer: this.uniforms, before: COPY_WRITE, after: { stages: ['fragment'], access: ['uniform-read'] } },
        ],
      })
    })

    const entries: BindingEntry[] = [
      { binding: 0, kind: 'uniform', stages: ['fragment'] },
      { binding: 1, kind: 'image', stages: ['fragment'] },
      { binding: 2, kind: 'sampler', stages: ['fragment'] },
    ]
    const setLayout = device.createBindingLayout({ entries, label: 'frame' })
    const layout: PipelineLayout = device.createPipelineLayout({ sets: [setLayout], constants: { size: 8, stages: ['vertex'] }, label: 'frame' })
    const set = device.createBindingPool({ sets: 1, label: 'frame' }).allocate(setLayout, 'frame')
    set.write([
      { binding: 0, buffer: this.uniforms },
      { binding: 1, view: device.createView(glyph) },
      { binding: 2, sampler: device.createSampler({ mag: 'nearest', min: 'nearest', wrap: 'clamp' }) },
    ])
    const vertex = { lens: device.createLens(shader(spriteVertex()), 'sprite'), buffers: SPRITE_BUFFERS }
    const pipeline = (fragment: LensModule, label: string): RenderPipeline =>
      device.createRenderPipeline({ layout, vertex, fragment: { lens: device.createLens(shader(fragment), label), outputs: [OVER] }, label })
    const panel = pipeline(panelFragment(), 'panel')
    const glyphs = pipeline(glyphFragment(), 'glyph')

    const l = app.arena.allocate('frame')
    this.list = l
    l.begin()
    // The list runs again and again. Its last run read the picture by copy and wrote the readback buffer by copy, so
    // the picture's move out of whatever it holds waits for that copy, and the next copy's write waits for the last.
    l.barrier({
      images: [{ image: this.picture, from: 'blank', to: 'color', before: { stages: ['copy'] }, after: { stages: ['color'], access: ['color-write'] } }],
      buffers: [{ buffer: this.readback, before: COPY_WRITE, after: COPY_WRITE }],
    })
    l.beginPass({ colors: [{ view: device.createView(this.picture), load: 'clear', store: 'keep', clear: BACKGROUND }], label: 'frame' })
    l.beginGroup('interface')
    l.setConstants(layout, 0, new Float32Array([W, H]))
    l.bindSets(layout, 0, [set])
    l.bindVertices(0, [{ buffer: vertices }])
    l.bindPipeline(panel)
    l.draw(6)
    l.bindPipeline(glyphs)
    l.draw(6, 1, 6)
    l.endGroup()
    l.endPass()
    l.barrier({ images: [{ image: this.picture, from: 'color', to: 'copy-src', before: { stages: ['color'], access: ['color-write'] }, after: COPY_READ }] })
    l.copyImageToBuffer(this.picture, this.readback, [{ offset: 0, rowBytes: W * 4, region: { width: W, height: H } }])
    l.barrier({ buffers: [{ buffer: this.readback, before: COPY_WRITE, after: HOST_READ }] })
    l.end()
  }

  /**
   * Writes the glyph's tint into the frame block (a small list of its own, recorded for this submit) and submits it
   * with the recorded frame; returns the pixels, taken when the fence signals.
   */
  draw(fence: Fence, tint: Rgba): Uint8Array {
    const { app } = this
    const offset = layoutBlock(FRAME_BLOCK, 'uniform').offsets[FRAME_BLOCK.fields.findIndex((field) => field.name === 'tint')]
    const animate = app.arena.allocate('tint')
    animate.begin({ once: true })
    // The write lands on the block the last frame read (at fragment) and the last tint wrote (by copy).
    animate.barrier({ buffers: [{ buffer: this.uniforms, before: { stages: ['copy', 'fragment'], access: ['copy-write'] }, after: COPY_WRITE }] })
    animate.updateBuffer(this.uniforms, offset, new Float32Array(tint))
    animate.barrier({ buffers: [{ buffer: this.uniforms, before: COPY_WRITE, after: { stages: ['fragment'], access: ['uniform-read'] } }] })
    animate.end()
    let pixels: Uint8Array | null = null
    fence.onSignal(() => (pixels = app.take(this.readback)))
    app.queue.submit([{ lists: [animate, this.list] }], fence)
    assert.ok(fence.signalled && pixels !== null, 'the reference renderer signals the fence before submit returns')
    return pixels
  }
}

const pixelAt = (bytes: Uint8Array, x: number, y: number, width = W): number[] => Array.from(bytes.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))

// ---------------------------------------------------------------------------------------------------
// Scenes

/** The frame with a white glyph, pinned by its checksum: a change here is a change to what every app draws. */
const FRAME_CHECKSUM = 0xf9a74689

test('an app draws a 64 x 48 frame: a cleared background, a gradient panel with antialiased round corners, a blended glyph', () => {
  const frame = new Frame(new App())
  const pixels = frame.draw(frame.app.device.createFence({ label: 'frame' }), WHITE)
  const model = frameModel(WHITE)
  samePicture(pixels, model, W, 'the frame')
  assert.equal(checksum(pixels), checksum(model))
  assert.equal(checksum(pixels), FRAME_CHECKSUM, `checksum 0x${checksum(pixels).toString(16)}`)

  // Pixels worked out by hand. The clear colour: 0.0625, 0.125 and 0.1875 of 255 round to 16, 32 and 48.
  assert.deepEqual(pixelAt(pixels, 0, 0), [16, 32, 48, 255])
  assert.deepEqual(pixelAt(pixels, 63, 47), [16, 32, 48, 255])
  // The panel's outer corner pixel lies 1.78 pixels outside the rounded corner: no coverage, background only.
  assert.deepEqual(pixelAt(pixels, PANEL.x0, PANEL.y0), [16, 32, 48, 255])
  // On row 23 the gradient is at t = 15.5 / 32 = 0.484375: (0.515625, 0.5, 0.484375) at alpha 0.875, over the
  // background: 0.515625 x 0.875 + (16 / 255) x 0.125 = 0.45902 of 255 is 117.05, and so on; alpha 0.875 + 0.125 = 1.
  assert.deepEqual(pixelAt(pixels, 12, 23), [117, 116, 114, 255])
  // The pixel diagonally in from the corner is cut by the arc: partly covered, so between background and panel.
  const cut = pixelAt(pixels, PANEL.x0 + 1, PANEL.y0 + 1)
  const inside = pixelAt(pixels, PANEL.x0 + 6, PANEL.y0 + 1)
  const bg = BACKGROUND.map(unorm8)
  for (let c = 0; c < 3; c++) assert.ok((cut[c] - bg[c]) * (inside[c] - cut[c]) > 0, `channel ${c}: ${cut} lies between the background ${bg} and ${inside}`)
  // The glyph: a full texel is the white tint; an empty one leaves the panel as it is on the same row.
  assert.deepEqual(pixelAt(pixels, GLYPH_AT.x, GLYPH_AT.y), [255, 255, 255, 255])
  assert.deepEqual(pixelAt(pixels, GLYPH_AT.x + 2, GLYPH_AT.y), pixelAt(pixels, 12, GLYPH_AT.y))
  // A half-covered texel (128 of 255) is the white tint blended about half over the panel.
  const half = pixelAt(pixels, GLYPH_AT.x + 2, GLYPH_AT.y + 4)
  const under = pixelAt(pixels, 12, GLYPH_AT.y + 4)
  for (let c = 0; c < 3; c++) assert.ok(Math.abs(half[c] - (255 + under[c]) / 2) <= 1, `channel ${c}: ${half} is half way from ${under} to white`)
})

test('one recorded frame is submitted three times with a fence each time; only the tint it reads changes between them', () => {
  const app = new App()
  const frame = new Frame(app)
  const fence = app.device.createFence({ label: 'frame' })
  const tints: readonly Rgba[] = [WHITE, [1, 0.25, 0.25, 1], [0.25, 0.75, 1, 0.5]]
  const signals: number[] = []
  const frames = tints.map((tint, k) => {
    if (k > 0) {
      assert.ok(fence.signalled)
      fence.reset()
    }
    assert.equal(fence.signalled, false)
    assert.equal(frame.list.state, 'ready', 'recorded once, the list is ready again after each run')
    fence.onSignal(() => signals.push(k))
    const pixels = frame.draw(fence, tint)
    samePicture(pixels, frameModel(tint), W, `frame ${k}`)
    return pixels
  })
  assert.deepEqual(signals, [0, 1, 2], 'each fence callback ran once, when its submit finished')
  assert.equal(frame.list.state, 'ready')
  // Outside the glyph's square the three frames are the same bytes; inside it they differ, so three checksums.
  const inGlyph = (x: number, y: number): boolean => x >= GLYPH_AT.x && x < GLYPH_AT.x + GLYPH_AT.size && y >= GLYPH_AT.y && y < GLYPH_AT.y + GLYPH_AT.size
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inGlyph(x, y)) for (const other of frames.slice(1)) assert.deepEqual(pixelAt(other, x, y), pixelAt(frames[0], x, y), `(${x}, ${y})`)
    }
  }
  assert.equal(new Set(frames.map(checksum)).size, 3)
  assert.equal(checksum(frames[0]), FRAME_CHECKSUM)
})

// ---------------------------------------------------------------------------------------------------
// Compute, then render

const BLUR_SIZE = 16
const SHOW_SIZE = 32

/** A 3 x 3 box blur: the mean of the nine texels around each one, coordinates held to the image's edge. */
function blurCompute(): LensModule {
  const b = lens('compute', { group: [8, 8, 1] })
  const source = b.image(0, 0)
  const blurred = b.storageImage(0, 1, 'rgba8')
  const id = b.cast(b.pick(b.builtin('global-id'), 'xy'), 'i32x2')
  const last = b.sub(b.cast(b.extent(source), 'i32x2'), 1)
  let sum: Val | null = null
  for (const dy of [-1, 0, 1]) {
    for (const dx of [-1, 0, 1]) {
      const texel = b.texel(source, b.clamp(b.add(id, b.i32x2(dx, dy)), 0, last))
      sum = sum === null ? texel : b.add(sum, texel)
    }
  }
  b.put(blurred, id, b.div(sum as Val, 9))
  return b.finish()
}

/** A clip-space position (slot 0) and uv (slot 1) in; uv out. */
function fullscreenVertex(): LensModule {
  const b = lens('vertex')
  b.position(b.make('f32x4', b.input(0, 'f32x2'), 0, 1))
  b.out(b.output(0, 'f32x2'), b.input(1, 'f32x2'))
  return b.finish()
}

function showFragment(): LensModule {
  const b = lens('fragment')
  b.out(b.output(0, 'f32x4'), b.sample(b.image(0, 0), b.sampler(0, 1), b.input(0, 'f32x2')))
  return b.finish()
}

const FULLSCREEN = new Float32Array([-1, 1, 0, 0, 1, 1, 1, 0, -1, -1, 0, 1, -1, -1, 0, 1, 1, 1, 1, 0, 1, -1, 1, 1])

/** The blur the model says the compute pass writes: f32 sums in the shader's order, the mean rounded to a byte. */
function blurModel(texels: Uint8Array): Uint8Array {
  const n = BLUR_SIZE
  const out = new Uint8Array(n * n * 4)
  const clampAxis = (v: number): number => Math.min(n - 1, Math.max(0, v))
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (let c = 0; c < 4; c++) {
        let sum = Number.NaN
        for (const dy of [-1, 0, 1]) {
          for (const dx of [-1, 0, 1]) {
            const v = fromUnorm8(texels[(clampAxis(y + dy) * n + clampAxis(x + dx)) * 4 + c])
            sum = Number.isNaN(sum) ? v : f32(sum + v)
          }
        }
        out[(y * n + x) * 4 + c] = unorm8(f32(sum / 9))
      }
    }
  }
  return out
}

/** The blur scene's resources and pipelines, and the commands of its work, with or without the barrier between. */
class BlurScene {
  readonly app: App
  readonly texels: Uint8Array
  readonly blurred: Image
  readonly shown: Image
  readonly shownBack: Buffer
  readonly blurredBack: Buffer
  private readonly quad: Buffer
  private readonly blur: { readonly pipeline: ComputePipeline; readonly layout: PipelineLayout; readonly set: BindingSet }
  private readonly show: { readonly pipeline: RenderPipeline; readonly layout: PipelineLayout; readonly set: BindingSet }

  constructor(app: App) {
    this.app = app
    const { device } = app
    const n = BLUR_SIZE
    const rand = lcg(2026)
    this.texels = Uint8Array.from({ length: n * n * 4 }, () => Math.floor(rand() * 256))
    const source = app.image({ format: 'rgba8', width: n, height: n, use: ['sampled', 'copy-dst'], label: 'source' })
    this.blurred = app.image({ format: 'rgba8', width: n, height: n, use: ['storage', 'sampled', 'copy-src'], label: 'blurred' })
    this.shown = app.image({ format: 'rgba8', width: SHOW_SIZE, height: SHOW_SIZE, use: ['color', 'copy-src'], label: 'shown' })
    this.quad = app.buffer(FULLSCREEN.byteLength, ['vertex', 'copy-dst'], 'device', 'fullscreen')
    this.shownBack = app.buffer(256 * SHOW_SIZE, ['copy-dst'], 'readback', 'shown readback')
    this.blurredBack = app.buffer(256 * n, ['copy-dst'], 'readback', 'blurred readback')

    const staged = new Uint8Array(256 * n)
    for (let y = 0; y < n; y++) staged.set(this.texels.subarray(y * n * 4, (y + 1) * n * 4), y * 256)
    const staging = app.staging(staged)
    app.run('upload', (l) => {
      l.barrier({ images: [{ image: source, from: 'blank', to: 'copy-dst', before: NOTHING, after: COPY_WRITE }] })
      l.copyBufferToImage(staging, source, [{ offset: 0, rowBytes: 256, region: { width: n, height: n } }])
      l.updateBuffer(this.quad, 0, FULLSCREEN)
      l.barrier({
        images: [{ image: source, from: 'copy-dst', to: 'shader-read', before: COPY_WRITE, after: { stages: ['compute'], access: ['shader-read'] } }],
        buffers: [{ buffer: this.quad, before: COPY_WRITE, after: { stages: ['vertex-input'], access: ['vertex-read'] } }],
      })
    })

    const blurredView = device.createView(this.blurred)
    const blurLayout = device.createBindingLayout({ entries: [{ binding: 0, kind: 'image', stages: ['compute'] }, { binding: 1, kind: 'storage-image', stages: ['compute'], format: 'rgba8' }] })
    const blurPipelineLayout = device.createPipelineLayout({ sets: [blurLayout] })
    const blurSet = device.createBindingPool({ sets: 1 }).allocate(blurLayout, 'blur')
    blurSet.write([{ binding: 0, view: device.createView(source) }, { binding: 1, view: blurredView }])
    this.blur = { pipeline: device.createComputePipeline({ layout: blurPipelineLayout, lens: device.createLens(blurCompute(), 'blur'), label: 'blur' }), layout: blurPipelineLayout, set: blurSet }

    const showLayout = device.createBindingLayout({ entries: [{ binding: 0, kind: 'image', stages: ['fragment'] }, { binding: 1, kind: 'sampler', stages: ['fragment'] }] })
    const showPipelineLayout = device.createPipelineLayout({ sets: [showLayout] })
    const showSet = device.createBindingPool({ sets: 1 }).allocate(showLayout, 'show')
    showSet.write([{ binding: 0, view: blurredView }, { binding: 1, sampler: device.createSampler({ mag: 'nearest', min: 'nearest' }) }])
    const pipeline = device.createRenderPipeline({
      layout: showPipelineLayout,
      vertex: { lens: device.createLens(fullscreenVertex(), 'fullscreen'), buffers: SPRITE_BUFFERS },
      fragment: { lens: device.createLens(showFragment(), 'show'), outputs: [{ format: 'rgba8' }] },
      label: 'show',
    })
    this.show = { pipeline, layout: showPipelineLayout, set: showSet }
  }

  /** The blur dispatch, then the pass that shows the blurred image, with or without the barrier between them. */
  record(l: CommandList, ordered: boolean): void {
    l.barrier({
      images: [
        { image: this.blurred, from: 'blank', to: 'general', before: NOTHING, after: { stages: ['compute'], access: ['shader-write'] } },
        { image: this.shown, from: 'blank', to: 'color', before: NOTHING, after: { stages: ['color'], access: ['color-write'] } },
      ],
    })
    l.bindPipeline(this.blur.pipeline)
    l.bindSets(this.blur.layout, 0, [this.blur.set])
    l.dispatch(BLUR_SIZE / 8, BLUR_SIZE / 8)
    // The storage image's writes, made visible to the fragment stage's reads, and the image moved to be sampled.
    if (ordered) l.barrier({ images: [{ image: this.blurred, from: 'general', to: 'shader-read', before: { stages: ['compute'], access: ['shader-write'] }, after: { stages: ['fragment'], access: ['shader-read'] } }] })
    l.beginPass({ colors: [{ view: this.app.device.createView(this.shown), load: 'clear', store: 'keep' }] })
    l.bindPipeline(this.show.pipeline)
    l.bindSets(this.show.layout, 0, [this.show.set])
    l.bindVertices(0, [{ buffer: this.quad }])
    l.draw(6)
    l.endPass()
  }

  /** Both pictures copied into readback memory, made visible to the host. */
  readBack(l: CommandList): void {
    l.barrier({
      images: [
        { image: this.shown, from: 'color', to: 'copy-src', before: { stages: ['color'], access: ['color-write'] }, after: COPY_READ },
        // The blurred image's last write was its move to shader-read, made at the fragment stage, and the pass has
        // read it there since: naming the fragment stage covers both.
        { image: this.blurred, from: 'shader-read', to: 'copy-src', before: { stages: ['fragment'] }, after: COPY_READ },
      ],
    })
    l.copyImageToBuffer(this.shown, this.shownBack, [{ offset: 0, rowBytes: 256, region: { width: SHOW_SIZE, height: SHOW_SIZE } }])
    l.copyImageToBuffer(this.blurred, this.blurredBack, [{ offset: 0, rowBytes: 256, region: { width: BLUR_SIZE, height: BLUR_SIZE } }])
    l.barrier({ buffers: [{ buffer: this.shownBack, before: COPY_WRITE, after: HOST_READ }, { buffer: this.blurredBack, before: COPY_WRITE, after: HOST_READ }] })
  }
}

test('a compute pass blurs an image into a storage image and a render pass samples it, with every barrier named', () => {
  const scene = new BlurScene(new App())
  const { app } = scene
  const l = app.arena.allocate('blur and show')
  l.begin({ once: true })
  scene.record(l, true)
  scene.readBack(l)
  l.end()
  const fence = app.device.createFence()
  let taken: { shown: Uint8Array; blurred: Uint8Array } | null = null
  fence.onSignal(() => (taken = { shown: app.take(scene.shownBack), blurred: app.take(scene.blurredBack) }))
  app.queue.submit([{ lists: [l] }], fence)
  assert.ok(taken !== null)
  const { shown, blurred } = taken as { shown: Uint8Array; blurred: Uint8Array }
  const model = blurModel(scene.texels)
  samePicture(packed(blurred, BLUR_SIZE, BLUR_SIZE, 256), model, BLUR_SIZE, 'the blurred image')
  // The pass shows it at twice the size through a nearest filter: pixel (x, y) is texel (x >> 1, y >> 1), and a byte
  // read as a float and written back as a byte is the same byte.
  const expected = new Uint8Array(SHOW_SIZE * SHOW_SIZE * 4)
  for (let y = 0; y < SHOW_SIZE; y++) for (let x = 0; x < SHOW_SIZE; x++) expected.set(model.subarray(((y >> 1) * BLUR_SIZE + (x >> 1)) * 4, ((y >> 1) * BLUR_SIZE + (x >> 1)) * 4 + 4), (y * SHOW_SIZE + x) * 4)
  samePicture(packed(shown, SHOW_SIZE, SHOW_SIZE, 256), expected, SHOW_SIZE, 'the shown picture')
  // A corner texel by hand: its nine reads are itself four times, its two edge neighbours twice each, and the one
  // diagonal in once.
  const t = (x: number, y: number, c: number): number => scene.texels[(y * BLUR_SIZE + x) * 4 + c]
  for (let c = 0; c < 4; c++) {
    const mean = (4 * t(0, 0, c) + 2 * t(1, 0, c) + 2 * t(0, 1, c) + t(1, 1, c)) / 9
    assert.ok(Math.abs(model[c] - mean) <= 0.5 + 1e-6, `channel ${c}: ${model[c]} is the mean ${mean} rounded`)
  }
})

// ---------------------------------------------------------------------------------------------------
// Refusals

test('a missing barrier is refused at submit with its code: hazard for an unordered read, layout for a wrong layout', () => {
  const scene = new BlurScene(new App())
  const { app } = scene
  // No barrier between the dispatch's writes and the pass's reads. The image stays in `general`, a layout a sampled
  // read may use, so the layout is right and the order is what is missing.
  const careless = app.arena.allocate('careless')
  careless.begin({ once: true })
  scene.record(careless, false)
  careless.end()
  const fence = app.device.createFence()
  refuses(() => app.queue.submit([{ lists: [careless] }], fence), 'hazard', /command list "careless" command 8 \(draw\): level 0 layer 0 of image "blurred" is read as binding 0 of set 0 at fragment \(shader-read\), and its last write, at compute \(shader-write\) by command list "careless" command 3 \(dispatch\), was not made visible to it/)
  assert.equal(fence.signalled, false, 'a refused submit runs nothing and signals nothing')
  assert.equal(careless.state, 'ready', 'and leaves the list as it was')

  // The same work with the barrier in its place is accepted afterwards: the refusal changed no state.
  const careful = app.arena.allocate('careful')
  careful.begin({ once: true })
  scene.record(careful, true)
  scene.readBack(careful)
  careful.end()
  app.queue.submit([{ lists: [careful] }], fence)
  assert.ok(fence.signalled)
  samePicture(packed(app.take(scene.blurredBack), BLUR_SIZE, BLUR_SIZE, 256), blurModel(scene.texels), BLUR_SIZE, 'the blurred image')

  // A picture drawn into before it was ever moved out of `blank`.
  const fresh = app.image({ format: 'rgba8', width: 4, height: 4, use: ['color'], label: 'fresh' })
  const unmoved = app.arena.allocate('unmoved')
  unmoved.begin({ once: true })
  unmoved.beginPass({ colors: [{ view: app.device.createView(fresh), load: 'clear', store: 'keep' }] })
  unmoved.endPass()
  unmoved.end()
  refuses(() => app.queue.submit([{ lists: [unmoved] }]), 'layout', /command list "unmoved" command 0 \(pass\): level 0 layer 0 of image "fresh" is in layout blank, and colour attachment 0 needs color/)
})

test('readback without a barrier to the host is refused at invalidate with code hazard; with checks off nothing is checked', () => {
  const app = new App()
  const src = app.staging(Uint8Array.from({ length: 64 }, (_, i) => i))
  const back = app.buffer(64, ['copy-dst'], 'readback', 'unseen')
  app.run('copy', (l) => l.copyBuffer(src, back, [{ from: 0, to: 0, size: 64 }]))
  refuses(() => app.take(back), 'hazard', /the last write to buffer "unseen", at copy \(copy-write\) by command list "copy" command 0 \(copy-buffer\), was not made visible to host \(host-read\)/)
  app.run('show the host', (l) => l.barrier({ buffers: [{ buffer: back, before: COPY_WRITE, after: HOST_READ }] }))
  assert.deepEqual(Array.from(app.take(back)), Array.from({ length: 64 }, (_, i) => i))

  // An instance that does not check takes the careless list and draws what the renderer happens to draw.
  const unchecked = new BlurScene(new App(false))
  const l = unchecked.app.arena.allocate('careless')
  l.begin({ once: true })
  unchecked.record(l, false)
  l.end()
  const fence = unchecked.app.device.createFence()
  unchecked.app.queue.submit([{ lists: [l] }], fence)
  assert.ok(fence.signalled)
})

// ---------------------------------------------------------------------------------------------------
// Lens as words

test('a Lens shader goes from the builder to words and back, a device takes the words, and they draw the same frame', () => {
  const module = glyphFragment()
  verify(module)
  const words = encode(module)
  assert.ok(words instanceof Uint32Array)
  assert.equal(words[0], LENS_MAGIC)
  assert.equal(words[1], LENS_VERSION)
  assert.ok(looksLikeLens(words))
  const back = decode(words)
  assert.deepEqual(back, module)
  assert.ok(Object.isFrozen(back))
  assert.deepEqual(encode(back), words)
  assert.equal(disassemble(back), disassemble(module))
  assert.match(disassemble(module), /^lens fragment\n/)

  const app = new App()
  const shader = app.device.createLens(words, 'glyph')
  assert.equal(shader.stage, 'fragment')
  assert.equal(shader.label, 'glyph')
  assert.deepEqual(shader.module, module)

  // Every shader of the frame handed over as words draws the frame the model says, the same as modules do.
  const frame = new Frame(new App(), encode)
  const pixels = frame.draw(frame.app.device.createFence(), WHITE)
  samePicture(pixels, frameModel(WHITE), W, 'the frame drawn from words')
  assert.equal(checksum(pixels), FRAME_CHECKSUM)

  // Words that are cut short, or carry the wrong magic, and a module the checker refuses, are refused as code lens.
  refuses(() => app.device.createLens(words.subarray(0, words.length - 1)), 'lens', /createLens: lens: decode: word \d+/)
  const wrong = words.slice()
  wrong[0] ^= 1
  assert.equal(looksLikeLens(wrong), false)
  refuses(() => app.device.createLens(wrong), 'lens', /createLens: lens: decode: word 0/)
  const broken: LensModule = { ...module, ids: module.ids - 1 }
  refuses(() => verify(broken), 'lens')
  refuses(() => app.device.createLens(broken), 'lens', /createLens: lens:/)
})

// ---------------------------------------------------------------------------------------------------
// The public face

test('index.ts is the whole public face: exactly these values and no internals, and this file draws through it alone', () => {
  assert.deepEqual(Object.keys(nightglass).sort(), [
    'BINARY', 'BUILTINS', 'DERIVATIVES', 'FAULT_CODES', 'FEATURES', 'FORMATS', 'FORMAT_NAMES', 'Fault', 'LENS_LIMITS', 'LENS_MAGIC', 'LENS_VERSION',
    'SCALARS', 'SOFT_HEAP', 'SOFT_LIMITS', 'SOFT_STEPS', 'STAGES', 'TERNARY', 'UNARY', 'VALUE_TYPES', 'arrayOf', 'block', 'boolOf', 'columnOf',
    'componentsOf', 'createInstance', 'decode', 'decodeTexel', 'disassemble', 'encode', 'encodeTexel', 'fail', 'isFault', 'isFormat', 'isGrid',
    'isScalar', 'isValueType', 'isVector', 'layoutBlock', 'lens', 'looksLikeLens', 'place', 'placeValue', 'sampleKind', 'scalarOf', 'softBackend',
    'strideOf', 'vectorOf', 'verify', 'walk', 'widthOf',
  ])
  const surface: { readonly [name: string]: unknown } = nightglass
  for (const internal of ['compile', 'dispatch', 'Raster', 'assemble', 'ImageStore', 'blend', 'resolveInto', 'checkOrder', 'hostRead', 'Core', 'DeviceImpl', 'LensBuilder', 'say']) {
    assert.equal(surface[internal], undefined, `${internal} stays inside the folder`)
  }
  assert.ok(nightglass.FAULT_CODES.includes('hazard') && nightglass.FAULT_CODES.includes('layout'))
  // The one Fault class: what a device raises is a Fault of index.ts's own.
  const app = new App()
  const raised = refuses(() => app.device.createBuffer({ size: 0, use: ['vertex'] }), 'invalid')
  assert.ok(raised instanceof nightglass.Fault)

  const src = readFileSync(new URL('./scene.test.ts', import.meta.url), 'utf8')
  const siblings = [...src.matchAll(/^import\b[^'\n]*?from '(\.\/[^']*)'/gm)].map((m) => m[1])
  assert.deepEqual([...new Set(siblings)], ['./index.ts'])
})
