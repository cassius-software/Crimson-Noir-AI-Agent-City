// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? crowd.wgsl and the two halves of the crowd must agree byte for byte (uniform
 * layout, bindings, readback offsets, the render frame), and the WGSL mirrors of the civic rules must agree
 * with the CPU rules; TypeScript sees none of that. These tests assemble the real shader module, lay out its
 * structs by the WGSL rules, trace which bindings each entry point statically uses, drive CrowdSim (the
 * physics worker's crowd and First-Law sensing) and CrowdCull (the page's drawing) against a recording WebGPU
 * mock that validates like the real API (the operator's summons included: packed, read back and obeyed in the
 * order the safety reflexes require), and execute the scalar WGSL functions
 * (degreeOf, walkElapsed, walkDelay, corridorGap) transpiled to JavaScript: the First-Law corridor is
 * checked against its geometric definition and against the avatar corridor Fleet measures on the CPU,
 * then computed in f32 the way the GPU does, down to the loosest built-ins WGSL allows.
 * What breaks if it is removed? A layout or binding slip would only show in the browser, as a blank
 * street or a car that cannot see the person in front of it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { KERNEL, SIGNAL, TRAFFIC, WALK_START, signalFor, walkAllowed } from '../02_Define_The_Rules/civic.ts'
import { createRng, degreeOf } from '../02_Define_The_Rules/degrees.ts'
import { stoppingDistance } from '../02_Define_The_Rules/laws.ts'
import { CITY } from '../01_Initialize_World/city.ts'
// Erased at runtime; the module itself is imported below, once the `?raw` hook is in place.
import type { CarState, CullInput, CullSettings, SharedBuffers } from './crowdCompute.ts'
import type { CrowdStepInput } from './crowdSensor.ts'
import { ACTIVITY, INTERVIEW_DISTANCE, onRoad, RECRUIT_SLOTS, sidewalkPath, SUMMON_ACCEPT, TETHER_PACE } from './skills.ts'

// Vite's `?raw` import, for Node: the file as a default-exported string.
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})

const USAGE = { MAP_READ: 1, MAP_WRITE: 2, COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32, UNIFORM: 64, STORAGE: 128, INDIRECT: 256, QUERY_RESOLVE: 512 } as const
const TEXTURE_USAGE = { COPY_SRC: 1, COPY_DST: 2, TEXTURE_BINDING: 4, STORAGE_BINDING: 8, RENDER_ATTACHMENT: 16 } as const
Object.assign(globalThis, { GPUBufferUsage: USAGE, GPUMapMode: { READ: 1, WRITE: 2 }, GPUTextureUsage: TEXTURE_USAGE })

const { ROOM, ROOM_FLOATS } = await import('../01_Initialize_World/interiors.ts')
const { CULL_EASE, CULL_PASSES, FLAG_NON_FINITE, MAX_CARS, PARAMS_ROOMS, PARAMS_SIZE, PARAMS_STREETS, PASS_BINDINGS, RENDER_FLOATS, SIM_PASSES, VARIANTS, agentQuota, corridorReach, crowdShader, geometryOf, packFrustumPlanes, packSimParams, simReadbackSize } = await import('./crowdCompute.ts')
const { STREET_VEC4S, cityStreetGrid, packStreets } = await import('../01_Initialize_World/region/streets.ts')
const { CROWD_SUBSTEP, CrowdSim } = await import('./crowdSim.ts')
const { CrowdCull, MAX_HIDDEN } = await import('./crowdCull.ts')
const { MAX_CARS: SENSOR_MAX_CARS, PEDESTRIAN_MAX_SPEED } = await import('./crowdSensor.ts')

const SOURCE = readFileSync(new URL('./crowd.wgsl', import.meta.url), 'utf8')
const AGENTS = 1000
const MODULE = crowdShader(AGENTS)

// ---------------------------------------------------------------- WGSL reading

const uncomment = (s: string) => s.replace(/\/\/.*$/gm, '')

/** Module-scope `const NAME: type = <number>;` declarations. */
function constants(code: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const m of uncomment(code).matchAll(/^const\s+(\w+)\s*:\s*\w+\s*=\s*(-?(?:0x[0-9a-fA-F]+|[0-9.]+(?:e-?\d+)?))[uif]?\s*;/gm)) {
    assert.ok(!out.has(m[1]), `${m[1]} declared twice`)
    out.set(m[1], Number(m[2]))
  }
  return out
}

interface WgslFunction { name: string; params: string[]; body: string; compute: boolean }

/** Every `fn`, with its parameter names and body (braces matched). */
function functions(code: string): Map<string, WgslFunction> {
  const src = uncomment(code)
  const out = new Map<string, WgslFunction>()
  for (const m of src.matchAll(/(@compute[^\n]*\n\s*)?\bfn\s+(\w+)\s*\(/g)) {
    let i = m.index + m[0].length
    for (let depth = 1; depth > 0; i++) depth += src[i] === '(' ? 1 : src[i] === ')' ? -1 : 0
    const params = src.slice(m.index + m[0].length, i - 1).split(',').map((p) => p.replace(/@\w+\([^)]*\)/g, '').split(':')[0].trim()).filter(Boolean)
    const open = src.indexOf('{', i)
    let j = open + 1
    for (let depth = 1; depth > 0; j++) depth += src[j] === '{' ? 1 : src[j] === '}' ? -1 : 0
    out.set(m[2], { name: m[2], params, body: src.slice(open, j), compute: m[1] !== undefined })
  }
  return out
}

/** A function body with its whitespace collapsed, for pinning exact statements. */
const flat = (name: string) => functions(MODULE).get(name)!.body.replace(/\s+/g, ' ')

interface Binding { binding: number; space: string; type: string }

function bindings(code: string): Map<string, Binding> {
  const out = new Map<string, Binding>()
  for (const m of uncomment(code).matchAll(/@group\(0\)\s*@binding\((\d+)\)\s*var<([^>]*)>\s*(\w+)\s*:\s*([^;]+);/g)) {
    out.set(m[3], { binding: Number(m[1]), space: m[2].split(',')[0].trim(), type: m[4].trim() })
  }
  // A texture binding has no address space: `var name: texture_2d<f32>;`.
  for (const m of uncomment(code).matchAll(/@group\(0\)\s*@binding\((\d+)\)\s*var\s+(\w+)\s*:\s*(texture[^;]+);/g)) {
    out.set(m[2], { binding: Number(m[1]), space: 'texture', type: m[3].trim() })
  }
  return out
}

/** Bindings an entry point statically uses: referenced in it or in any function it calls. */
function staticUse(code: string, entry: string): number[] {
  const fns = functions(code)
  const vars = bindings(code)
  const seen = new Set<string>()
  const used = new Set<number>()
  const visit = (name: string) => {
    if (seen.has(name)) return
    seen.add(name)
    for (const id of fns.get(name)!.body.match(/\b[A-Za-z_]\w*\b/g) ?? []) {
      if (fns.has(id)) visit(id)
      const v = vars.get(id)
      if (v) used.add(v.binding)
    }
  }
  visit(entry)
  return [...used].sort((a, b) => a - b)
}

interface Layout { size: number; align: number; stride?: number; members?: Map<string, { offset: number; type: string }> }

function structs(code: string): Map<string, [string, string][]> {
  const out = new Map<string, [string, string][]>()
  for (const m of uncomment(code).matchAll(/struct\s+(\w+)\s*\{([^}]*)\}/g)) {
    const members: [string, string][] = []
    let depth = 0, start = 0
    const body = m[2]
    for (let i = 0; i <= body.length; i++) {
      const c = body[i]
      if (c === '<') depth++
      else if (c === '>') depth--
      else if ((c === ',' && depth === 0) || i === body.length) {
        const part = body.slice(start, i).trim()
        if (part) {
          const k = part.indexOf(':')
          members.push([part.slice(0, k).trim(), part.slice(k + 1).trim()])
        }
        start = i + 1
      }
    }
    out.set(m[1], members)
  }
  return out
}

const roundUp = (k: number, n: number) => Math.ceil(n / k) * k

/** WGSL host-shareable layout (the storage rules; uniform extras are asserted separately). */
function layoutOf(type: string, code: string): Layout {
  const scalar: Record<string, [number, number]> = {
    f32: [4, 4], i32: [4, 4], u32: [4, 4], vec2f: [8, 8], vec3f: [12, 16], vec4f: [16, 16], vec2u: [8, 8], vec3u: [12, 16], vec4u: [16, 16], vec2i: [8, 8], vec4i: [16, 16], 'atomic<u32>': [4, 4],
  }
  if (scalar[type]) return { size: scalar[type][0], align: scalar[type][1] }
  const arr = /^array<(.+),\s*(\w+)>$/.exec(type)
  if (arr) {
    const el = layoutOf(arr[1].trim(), code)
    const n = /^\d+$/.test(arr[2]) ? Number(arr[2]) : constants(code).get(arr[2])
    assert.ok(n !== undefined, `array count ${arr[2]}`)
    const stride = roundUp(el.align, el.size)
    return { size: n * stride, align: el.align, stride }
  }
  const members = structs(code).get(type)
  assert.ok(members, `unknown type ${type}`)
  let offset = 0, align = 0
  const out = new Map<string, { offset: number; type: string }>()
  for (const [name, t] of members) {
    const l = layoutOf(t, code)
    offset = roundUp(l.align, offset)
    out.set(name, { offset, type: t })
    offset += l.size
    align = Math.max(align, l.align)
  }
  return { size: roundUp(align, offset), align, members: out }
}

// ---------------------------------------------------------------- WGSL scalar functions as JS

/** Module-scope constant types, `const NAME: type = …;`. */
function constantTypes(code: string): Map<string, string> {
  return new Map([...uncomment(code).matchAll(/^const\s+(\w+)\s*:\s*(\w+)\s*=/gm)].map((m) => [m[1], m[2]]))
}

const WGSL_TOKEN = /\s*(?:(0x[0-9a-fA-F]+[iu]?|(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?[iuf]?)|([A-Za-z_]\w*)|(<=|>=|==|!=|&&|\|\||[-+*/]=|[-+*/%<>=!(){},;:]))/y
const KEYWORDS = new Set(['let', 'var', 'const', 'if', 'else', 'for', 'return', 'break', 'continue'])

/**
 * Compiles one WGSL function body in the scalar subset these helpers use (let/var, assignment, if/else,
 * for, return; numbers, names, calls, arithmetic, comparisons, logic) to JavaScript by parsing it, so
 * every arithmetic result and float literal can be passed through R() (f32 rounding, or identity).
 * Anything outside the subset (member access, indexing, pointers, bit operators, ++) is refused.
 */
function compileBody(body: string, name: string): string {
  const toks: string[] = []
  const src = body.trim()
  WGSL_TOKEN.lastIndex = 0
  while (WGSL_TOKEN.lastIndex < src.length) {
    const at = WGSL_TOKEN.lastIndex
    const m = WGSL_TOKEN.exec(src)
    assert.ok(m, `${name}: cannot transpile the WGSL at "${src.slice(at, at + 24)}"`)
    toks.push(m[1] ?? m[2] ?? m[3])
  }
  let i = 0
  const peek = (): string | undefined => toks[i]
  const take = (want?: string): string => {
    const t = toks[i++]
    assert.ok(t !== undefined && (want === undefined || t === want), `${name}: expected ${want ?? 'more'} at token ${i - 1}, found ${t}`)
    return t
  }
  const ident = (): string => {
    const t = take()
    assert.ok(/^[A-Za-z_]\w*$/.test(t) && !KEYWORDS.has(t), `${name}: expected a name, found ${t}`)
    return t
  }
  const arith = (a: string, op: string, b: string) => `R(${a} ${op} ${b})`
  const plain = (a: string, op: string, b: string) => `(${a} ${op === '==' ? '===' : op === '!=' ? '!==' : op} ${b})`
  const binary = (ops: readonly string[], next: () => string, emit: typeof arith) => (): string => {
    let a = next()
    while (ops.includes(peek() ?? '')) {
      const op = take()
      a = emit(a, op, next())
    }
    return a
  }
  const primary = (): string => {
    const t = take()
    if (t === '(') {
      const e = expr()
      take(')')
      return `(${e})`
    }
    if (/^[0-9.]/.test(t)) {
      const hex = t.startsWith('0x')
      const v = Number(t.replace(hex ? /[iu]$/ : /[iuf]$/, ''))
      assert.ok(Number.isFinite(v), `${name}: literal ${t}`)
      return !hex && /[.eEf]/.test(t) ? `R(${v})` : `${v}`
    }
    if (t === 'true' || t === 'false') return t
    i--
    const callee = ident()
    if (peek() !== '(') return callee
    take('(')
    const args: string[] = []
    while (peek() !== ')') {
      args.push(expr())
      if (peek() !== ')') take(',')
    }
    take(')')
    return `${callee}(${args.join(', ')})`
  }
  const unary = (): string => {
    if (peek() === '-') { take(); return `(-${unary()})` }
    if (peek() === '!') { take(); return `(!${unary()})` }
    return primary()
  }
  const mul = binary(['*', '/', '%'], unary, arith)
  const add = binary(['+', '-'], mul, arith)
  const rel = binary(['<', '>', '<=', '>='], add, plain)
  const eq = binary(['==', '!='], rel, plain)
  const and = binary(['&&'], eq, plain)
  const expr: () => string = binary(['||'], and, plain)
  // A declaration or an assignment, without its ';'.
  const simple = (): string => {
    if (peek() === 'let' || peek() === 'var' || peek() === 'const') {
      take()
      const v = ident()
      if (peek() === ':') { take(); ident() }
      take('=')
      return `let ${v} = ${expr()}`
    }
    const v = ident()
    const op = take()
    assert.ok(['=', '+=', '-=', '*=', '/='].includes(op), `${name}: unexpected ${op} after ${v}`)
    return op === '=' ? `${v} = ${expr()}` : `${v} = R(${v} ${op[0]} (${expr()}))`
  }
  const block = (): string => {
    take('{')
    const out: string[] = []
    while (peek() !== '}') out.push(statement())
    take('}')
    return `{ ${out.join(' ')} }`
  }
  const statement = (): string => {
    const t = peek()
    if (t === '{') return block()
    if (t === 'if') {
      take()
      let s = `if (${expr()}) ${block()}`
      if (peek() === 'else') {
        take()
        s += ` else ${peek() === 'if' ? statement() : block()}`
      }
      return s
    }
    if (t === 'for') {
      take()
      take('(')
      const init = simple()
      take(';')
      const cond = expr()
      take(';')
      const step = simple()
      take(')')
      return `for (${init}; ${cond}; ${step}) ${block()}`
    }
    if (t === 'return') {
      take()
      const e = peek() === ';' ? '' : ` ${expr()}`
      take(';')
      return `return${e};`
    }
    if (t === 'break' || t === 'continue') {
      take()
      take(';')
      return `${t};`
    }
    const s = simple()
    take(';')
    return `${s};`
  }
  const out = block()
  assert.equal(i, toks.length, `${name}: tokens left after the body`)
  return out
}

/** How transpiled WGSL computes. */
interface Arithmetic {
  /** Round every float literal, arithmetic result and built-in result to f32, as the GPU does (else f64: the maths alone). */
  f32?: boolean
  /**
   * With f32: built-ins as loose as the WGSL accuracy table lets a GPU be. atan2 is off by up to its 4096
   * ULP (deterministic jitter), asin by the absolute error allowed it (≤ 6.77e-5 rad; the classic
   * polynomial of Abramowitz & Stegun 4.4.45, within 5e-5, the kind of expansion shader compilers emit).
   */
  loosest?: boolean
}

/**
 * Transpiles scalar-only WGSL functions (plus every numeric module constant) to JavaScript, so the
 * shipped shader logic itself is tested rather than a hand-written copy. Anything beyond scalars
 * (vectors, arrays, bindings, pointers, bit casts) is refused instead of being guessed at. By default
 * arithmetic runs in f64, which checks the maths; `{ f32: true }` checks what the GPU computes.
 */
function transpile(names: string[], arithmetic: Arithmetic = {}): Record<string, (...args: (number | boolean)[]) => number> {
  const fns = functions(MODULE)
  const types = constantTypes(MODULE)
  const lines = [...constants(MODULE)].map(([k, v]) => `const ${k} = ${types.get(k) === 'f32' ? `R(${v})` : v};`)
  for (const name of names) {
    const f = fns.get(name)
    assert.ok(f, `fn ${name} not found`)
    assert.doesNotMatch(f.body, /vec|mat\d|array|bitcast|atomic|(?<!&)&(?!&)|\[|\bP\./, `${name} is not scalar-only`)
    lines.push(`function ${name}(${f.params.join(', ')}) ${compileBody(f.body, name)}`)
  }
  lines.push(`({ ${names.join(', ')} })`)
  const R = arithmetic.f32 ? Math.fround : (x: number) => x
  const loose = arithmetic.f32 === true && arithmetic.loosest === true
  let seed = 0x2545f491
  const jitter = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 31 - 1 } // [-1, 1)
  const ulp = (v: number) => (v === 0 ? 0 : 2 ** (Math.floor(Math.log2(Math.abs(v))) - 23))
  const polyAsin = (x: number) => {
    const a = Math.abs(x)
    const r = Math.PI / 2 - Math.sqrt(1 - a) * (1.5707288 + a * (-0.2121144 + a * (0.074261 - 0.0187293 * a)))
    return x < 0 ? -r : r
  }
  const sandbox = {
    R,
    abs: Math.abs, max: Math.max, min: Math.min, floor: Math.floor,
    sqrt: (x: number) => R(Math.sqrt(x)),
    atan2: (y: number, x: number) => {
      const v = Math.atan2(y, x)
      return R(loose ? v + jitter() * 4096 * ulp(v) : v)
    },
    asin: (x: number) => R(loose ? polyAsin(x) : Math.asin(x)),
    clamp: (x: number, lo: number, hi: number) => Math.min(Math.max(x, lo), hi),
    select: (f: unknown, t: unknown, c: boolean) => (c ? t : f),
    i32: (x: number) => Math.trunc(x) | 0, u32: (x: number) => Math.trunc(x) >>> 0, f32: (x: number) => R(x),
  }
  return vm.runInNewContext(lines.join('\n'), sandbox)
}

// ---------------------------------------------------------------- a WebGPU mock that validates like the API

interface MapRequest { buffer: MockBuffer; resolve: () => void }

class MockBuffer {
  readonly label: string
  readonly size: number
  readonly usage: number
  readonly bytes: Uint8Array
  readonly device: MockDevice
  mapped = false
  pending = false
  #range: ArrayBuffer | null = null
  constructor(device: MockDevice, label: string, size: number, usage: number) {
    assert.equal(size % 4, 0, `${label}: size must be a multiple of 4`)
    this.device = device
    this.label = label
    this.size = size
    this.usage = usage
    this.bytes = new Uint8Array(size)
  }
  mapAsync(mode: number): Promise<void> {
    assert.equal(mode, 1)
    assert.ok(this.usage & USAGE.MAP_READ, `${this.label} is not mappable`)
    assert.ok(!this.mapped && !this.pending, `${this.label} mapped twice`)
    this.pending = true
    return new Promise((resolve) => this.device.maps.push({ buffer: this, resolve: () => { this.pending = false; this.mapped = true; resolve() } }))
  }
  getMappedRange(): ArrayBuffer {
    assert.ok(this.mapped, `${this.label} read while unmapped`)
    assert.equal(this.#range, null, `${this.label}: getMappedRange twice`)
    this.#range = this.bytes.slice().buffer
    return this.#range
  }
  unmap(): void {
    // WebGPU detaches the mapped range: any view of it reads as empty (and a new view throws) from here on.
    if (this.#range) structuredClone(this.#range, { transfer: [this.#range] })
    this.#range = null
    this.mapped = false
  }
  u32(): Uint32Array { return new Uint32Array(this.bytes.buffer) }
  f32(): Float32Array { return new Float32Array(this.bytes.buffer) }
}

interface Pipeline { entryPoint: string; getBindGroupLayout(i: number): { entryPoint: string } }
interface Group { label: string; entryPoint: string; entries: { binding: number; buffer: MockBuffer | undefined; texture?: MockTexture }[] }

class MockTexture {
  readonly label: string
  readonly width: number
  readonly height: number
  readonly format: string
  readonly usage: number
  readonly bytes: Uint8Array
  constructor(d: { label?: string; size: { width: number; height: number }; format: string; usage: number }) {
    this.label = d.label ?? ''
    this.width = d.size.width
    this.height = d.size.height
    this.format = d.format
    this.usage = d.usage
    assert.equal(d.format, 'rg32float')
    this.bytes = new Uint8Array(this.width * this.height * 8)
  }
  createView(): { texture: MockTexture } { return { texture: this } }
  f32(): Float32Array { return new Float32Array(this.bytes.buffer) }
}
interface Commands { ops: (() => void)[] }

class MockDevice {
  readonly buffers: MockBuffer[] = []
  readonly textures: MockTexture[] = []
  readonly groups: Group[] = []
  readonly maps: MapRequest[] = []
  readonly log: string[] = []
  readonly features = new Set<string>()
  shader = ''
  onDispatch: (entryPoint: string) => void = () => {}
  #loseDevice: (info: { reason: string; message: string }) => void = () => {}
  readonly lost = new Promise<{ reason: string; message: string }>((resolve) => { this.#loseDevice = resolve })
  lose(reason: string, message: string): void { this.#loseDevice({ reason, message }) }
  readonly queue = {
    writeTexture: (dst: { texture: MockTexture }, data: ArrayBufferView, layout: { bytesPerRow: number }, size: { width: number; height: number }) => {
      const t = dst.texture
      assert.ok(t.usage & TEXTURE_USAGE.COPY_DST, `${t.label}: not COPY_DST`)
      assert.equal(size.width, t.width)
      assert.equal(size.height, t.height)
      assert.equal(layout.bytesPerRow, t.width * 8)
      t.bytes.set(new Uint8Array(data.buffer, data.byteOffset, t.bytes.length))
      this.log.push(`writeTexture ${t.label}`)
    },
    writeBuffer: (b: MockBuffer, offset: number, data: ArrayBuffer | ArrayBufferView, dataOffset = 0, size?: number) => {
      const unit = data instanceof ArrayBuffer ? 1 : (data as unknown as { BYTES_PER_ELEMENT?: number }).BYTES_PER_ELEMENT ?? 1
      const whole = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      const src = whole.subarray(dataOffset * unit, size === undefined ? undefined : (dataOffset + size) * unit)
      assert.ok(offset % 4 === 0 && src.byteLength % 4 === 0, `${b.label}: unaligned write`)
      assert.ok(offset + src.byteLength <= b.size, `${b.label}: write out of bounds`)
      assert.ok(b.usage & USAGE.COPY_DST, `${b.label}: not COPY_DST`)
      b.bytes.set(src, offset)
      this.log.push(`write ${b.label} @${offset}+${src.byteLength}`)
    },
    submit: (cmds: Commands[]) => {
      this.log.push('submit')
      for (const c of cmds) for (const op of c.ops) op()
    },
  }
  createBuffer(d: { label?: string; size: number; usage: number }): MockBuffer {
    const b = new MockBuffer(this, d.label ?? '', d.size, d.usage)
    this.buffers.push(b)
    return b
  }
  buffer(label: string): MockBuffer {
    const b = this.buffers.find((x) => x.label === label)
    assert.ok(b, label)
    return b
  }
  createShaderModule(d: { code: string }): object {
    this.shader = d.code
    return {}
  }
  createComputePipeline(d: { layout: string; compute: { entryPoint: string } }): Pipeline {
    assert.equal(d.layout, 'auto')
    const entryPoint = d.compute.entryPoint
    return { entryPoint, getBindGroupLayout: (i: number) => { assert.equal(i, 0); return { entryPoint } } }
  }
  createTexture(d: { label?: string; size: { width: number; height: number }; format: string; usage: number }): MockTexture {
    const t = new MockTexture(d)
    this.textures.push(t)
    return t
  }
  createBindGroup(d: { label: string; layout: { entryPoint: string }; entries: { binding: number; resource: { buffer?: MockBuffer; texture?: MockTexture } }[] }): Group {
    const g = { label: d.label, entryPoint: d.layout.entryPoint, entries: d.entries.map((e) => ({ binding: e.binding, buffer: e.resource.buffer, texture: e.resource.texture })) }
    this.groups.push(g)
    return g
  }
  createCommandEncoder(): object {
    const ops: (() => void)[] = []
    return {
      beginComputePass: () => {
        let current: Pipeline | null = null
        return {
          setPipeline: (p: Pipeline) => { current = p },
          setBindGroup: (i: number, g: Group) => { assert.equal(i, 0); assert.equal(g.entryPoint, current?.entryPoint) },
          dispatchWorkgroups: (n: number) => {
            const ep = current!.entryPoint
            assert.ok(n > 0 && n <= 65535, `${ep}: ${n} workgroups`)
            ops.push(() => { this.log.push(`dispatch ${ep}`); this.onDispatch(ep) })
          },
          end: () => {},
        }
      },
      copyBufferToBuffer: (src: MockBuffer, so: number, dst: MockBuffer, dof: number, size: number) => {
        assert.ok(so % 4 === 0 && dof % 4 === 0 && size % 4 === 0, 'unaligned copy')
        assert.ok(so + size <= src.size && dof + size <= dst.size, `copy ${src.label} -> ${dst.label} out of bounds`)
        assert.ok(src.usage & USAGE.COPY_SRC, `${src.label}: not COPY_SRC`)
        assert.ok(dst.usage & USAGE.COPY_DST, `${dst.label}: not COPY_DST`)
        assert.ok(!dst.mapped && !dst.pending, `${dst.label}: copy into a mapped buffer`)
        ops.push(() => {
          dst.bytes.set(src.bytes.subarray(so, so + size), dof)
          this.log.push(`copy ${src.label}@${so} -> ${dst.label}@${dof}+${size}`)
        })
      },
      finish: (): Commands => ({ ops }),
    }
  }
  pushErrorScope(): void {}
  popErrorScope(): Promise<null> { return Promise.resolve(null) }
  /** Resolves pending mapAsync calls (oldest first by default) and lets their callbacks run. */
  async flush(order: 'fifo' | 'lifo' = 'fifo'): Promise<void> {
    while (this.maps.length) (order === 'fifo' ? this.maps.shift()! : this.maps.pop()!).resolve()
    await new Promise((r) => setImmediate(r))
  }
}

const planes = new Float32Array(24).map((_, i) => i + 0.5)

/** The physics worker's crowd on a mock device of its own. */
async function simRig() {
  const device = new MockDevice()
  const crowd = await CrowdSim.create(device as unknown as GPUDevice, AGENTS)
  return { device, crowd }
}

/** The page's cull over three-style render buffers on another mock device. */
async function cullRig(settings: CullSettings = { lodDistance: 30, nearRadius: 22, density: 0.6, maxDistance: 180 }) {
  const device = new MockDevice()
  const S = USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC
  const shared = {
    pos: device.createBuffer({ label: 'pos', size: AGENTS * 16, usage: S | USAGE.VERTEX }),
    vel: device.createBuffer({ label: 'vel', size: AGENTS * 16, usage: S | USAGE.VERTEX }),
    pose: device.createBuffer({ label: 'pose', size: AGENTS * 16, usage: S | USAGE.VERTEX }),
    drawArgs: device.createBuffer({ label: 'drawArgs', size: VARIANTS * 2 * 20, usage: S | USAGE.INDIRECT }),
    drawLists: device.createBuffer({ label: 'drawLists', size: agentQuota(AGENTS) * VARIANTS * 2 * 4, usage: S }),
    look: device.createBuffer({ label: 'look', size: AGENTS * 4, usage: S }),
  }
  const template = new Uint32Array(VARIANTS * 2 * 5)
  const crowd = await CrowdCull.create(device as unknown as GPUDevice, shared as unknown as SharedBuffers, template, AGENTS, settings)
  return { device, crowd }
}

const car = (x: number, curvature: number): CarState => ({ x, z: 7, heading: 0.3, speed: 9, halfWidth: 0.92, halfLength: 2.3, curvature })
const simInput = (over: Partial<CrowdStepInput> = {}): CrowdStepInput => ({
  seq: 1, dt: 1 / 60, time: 12.5, player: { x: 101, z: 102, heading: 1.5, speed: 1.3, visible: true },
  cars: [car(10, 0.05), car(20, -0.1)], summons: [], ...over,
})
const cullInput: CullInput = { camera: { x: 3, y: 4, z: 5 }, planes }

/** The Params bytes last written to `label`, read through the WGSL struct layout. */
function params(device: MockDevice, label: string) {
  const bytes = device.buffer(label)
  const f = bytes.f32(), u = bytes.u32()
  const L = layoutOf('Params', MODULE).members!
  const at = (name: string) => L.get(name)!.offset / 4
  const carLayout = layoutOf('Car', MODULE)
  const carsAt = at('cars'), stride = layoutOf('array<Car, MAX_CARS>', MODULE).stride! / 4
  const carField = (j: number, field: 'a' | 'b') => [...f.subarray(carsAt + j * stride + carLayout.members!.get(field)!.offset / 4).slice(0, 4)]
  return { f, u, at, carField }
}

// ---------------------------------------------------------------- the First-Law corridor, three ways

const BODY_PAD = constants(SOURCE).get('BODY_PAD')!
/** The rear axle's distance behind the chassis centre (half the wheelbase). */
const AXLE = constants(MODULE).get('CAR_AXLE')!
const { corridorGap } = transpile(['clockwise', 'corridorGap'])
/** Full lock: tan(CAR.maxSteer) / CAR.wheelbase from vehicles.ts (checked against it below). */
const FULL_LOCK = Math.tan(0.6) / 2.8
const SEDAN = { halfWidth: 0.92, halfLength: 2.3 }

/**
 * clockwise(): travel (m) within which a contact rounding puts just behind reads as now. Past a crossing
 * of the footprint's edge by less than this, the footprint has only just left the person, so 0 is right.
 */
const HAIR = Number(/let hair = ([\d.e-]+) \* k;/.exec(functions(MODULE).get('clockwise')!.body.replace(/\s+/g, ' '))![1])

/** corridorGap in the travel frame of a car driving on (axle behind the centre), grown by `grow` metres all round. */
const gapOn = (u: number, left: number, k: number, grow = 0) => corridorGap(u, left, SEDAN.halfWidth + grow, SEDAN.halfLength + grow, k, -AXLE)

/**
 * simulate's car loop for one person (the statements are pinned to the source by a test below): the
 * car's frame, the corridor-reach pre-check (unless `raw`), then corridorGap driving on and, with lz
 * negated and the axle ahead, reversing. [ahead, behind], Infinity = none. `grow` enlarges the
 * footprint, to tell grazing contacts apart.
 */
function shaderGaps(px: number, pz: number, c: CarState, grow = 0, raw = false): [number, number] {
  const car = { ...c, halfWidth: c.halfWidth + grow, halfLength: c.halfLength + grow }
  const fx = Math.sin(c.heading), fz = Math.cos(c.heading) // f = (sin heading, cos heading)
  const rx = -fz, rz = fx // r = (-f.y, f.x): the car's right
  const dx = px - c.x, dz = pz - c.z
  if (!raw && dx * dx + dz * dz > corridorReach(car) ** 2) return [Infinity, Infinity]
  const lz = dx * fx + dz * fz, lx = dx * rx + dz * rz
  const g = (u: number, axle: number) => {
    const v = corridorGap(u, -lx, car.halfWidth, car.halfLength, car.curvature, axle)
    return v < 0 ? Infinity : v
  }
  return [g(lz, -AXLE), g(-lz, AXLE)]
}

/** True when a hair more or less footprint (±1 mm) changes the answer: a contact that only grazes a corner or an edge. */
function grazing(px: number, pz: number, c: CarState, dir: 1 | -1): boolean {
  const i = dir > 0 ? 0 : 1
  const small = shaderGaps(px, pz, c, -1e-3)[i], big = shaderGaps(px, pz, c, 1e-3)[i]
  return small === Infinity ? big !== Infinity : Math.abs(small - big) > 0.05
}

/** The car's pose after its rear axle has travelled `t` metres in `dir` on the kinematic bicycle model. */
function poseAfter(c: CarState, dir: 1 | -1, t: number): { x: number; z: number; heading: number } {
  const h0 = c.heading, k = c.curvature
  const ax0 = c.x - Math.sin(h0) * AXLE, az0 = c.z - Math.cos(h0) * AXLE
  if (k === 0) return { x: c.x + dir * t * Math.sin(h0), z: c.z + dir * t * Math.cos(h0), heading: h0 }
  // The turn centre is 1/k to the rear axle's left, (cos h, -sin h); the axle circles it as the heading turns.
  const wx = ax0 + Math.cos(h0) / k, wz = az0 - Math.sin(h0) / k
  const h = h0 + dir * k * t
  const ax = wx - Math.cos(h) / k, az = wz + Math.sin(h) / k
  return { x: ax + Math.sin(h) * AXLE, z: az + Math.cos(h) * AXLE, heading: h }
}

/**
 * Independent reference, straight from the definition: drives the kinematic bicycle model in world space
 * in `ds` steps and returns the first rear-axle travel at which the footprint, widened by KERNEL.corridor,
 * holds the person; Infinity if it does not within `range`.
 */
function sweep(px: number, pz: number, c: CarState, dir: 1 | -1, ds = 0.002, range: number = KERNEL.range): number {
  const half = c.halfWidth + KERNEL.corridor
  for (let t = 0; t <= range; t += ds) {
    const p = poseAfter(c, dir, t)
    const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
    const rx = px - p.x, rz = pz - p.z
    if (Math.abs(rx * fx + rz * fz) <= c.halfLength && Math.abs(rx * fz - rz * fx) <= half) return t
  }
  return Infinity
}

/**
 * True when the footprint has only just left the person, which clockwise() reads as contact now: by the
 * brute-force drive, going the other way reaches them within HAIR.
 */
function justLeft(px: number, pz: number, c: CarState, dir: 1 | -1): boolean {
  return sweep(px, pz, c, dir > 0 ? -1 : 1, 0.0005, HAIR + 0.001) <= HAIR + 0.001
}

/** A person near where the car will be: a point around its widened footprint after `t` metres of travel. */
function nearSwept(c: CarState, dir: 1 | -1, rng: () => number): [number, number] {
  const p = poseAfter(c, dir, rng() * (KERNEL.range + 4))
  const u = (rng() * 2 - 1) * (c.halfLength + 1), l = (rng() * 2 - 1) * (c.halfWidth + KERNEL.corridor + 1)
  const fx = Math.sin(p.heading), fz = Math.cos(p.heading)
  return [p.x + fx * u + fz * l, p.z + fz * u - fx * l]
}

// ---------------------------------------------------------------- tests

test('the assembled module defines every constant crowd.wgsl uses, exactly once, mirrored from the CPU', () => {
  const defined = constants(MODULE)
  const used = new Set(uncomment(SOURCE).match(/\b[A-Z][A-Z0-9_]*[A-Z0-9]\b/g))
  for (const name of used) assert.ok(defined.has(name), `${name} is used but never defined`)
  assert.equal(defined.get('MAX_CARS'), MAX_CARS)
  assert.equal(defined.get('HAZARD_SLOTS'), 2 * MAX_CARS)
  assert.equal(defined.get('WALK_MOD'), WALK_START.modifier)
  assert.equal(defined.get('WALK_DC'), WALK_START.dc)
  WALK_START.delay.forEach((d, k) => assert.equal(defined.get(`WALK_DELAY_${k}`), d))
  assert.equal(defined.get('KERNEL_CORRIDOR'), KERNEL.corridor)
  assert.equal(defined.get('KERNEL_RANGE'), KERNEL.range)
  assert.equal(defined.get('SIGNAL_CYCLE'), SIGNAL.cycle)
  assert.equal(defined.get('SIGNAL_EW_AMBER'), SIGNAL.ewAmber)
  assert.equal(defined.get('SIGNAL_WALK'), SIGNAL.walkSeconds)
  assert.equal(defined.get('FLAG_NON_FINITE'), FLAG_NON_FINITE)
  assert.equal(defined.get('EXP_MASK'), 0x7f800000)
})

test('PASS_BINDINGS lists exactly the bindings each entry point statically uses (layout: auto)', () => {
  const entries = [...functions(MODULE).values()].filter((f) => f.compute).map((f) => f.name).sort()
  assert.deepEqual(Object.keys(PASS_BINDINGS).sort(), entries)
  for (const name of entries) assert.deepEqual([...PASS_BINDINGS[name as keyof typeof PASS_BINDINGS]].sort((a, b) => a - b), staticUse(MODULE, name), name)
  assert.ok(staticUse(MODULE, 'simulate').includes(12), 'simulate writes the hazard slots')
  for (const name of entries) if (name !== 'simulate') assert.ok(!staticUse(MODULE, name).includes(12), `${name} must not list the hazard slots`)
})

test('no pass needs more than the default 8 storage buffers per stage', () => {
  const vars = [...bindings(MODULE).values()]
  for (const [name, list] of Object.entries(PASS_BINDINGS)) {
    const storage = list.filter((b) => vars.find((v) => v.binding === b)!.space === 'storage').length
    assert.ok(storage <= 8, `${name} uses ${storage} storage buffers`)
  }
})

test('struct layouts obey the uniform address-space rules and match the CPU sizes', () => {
  const p = layoutOf('Params', MODULE)
  const m = p.members!
  // The street window's bit field rides after the summons (STREET_VEC4S rows of vec4u), the indoor workplaces last
  // (ROOM.slots × struct Room: a, b, ROOM.furniture boxes, ROOM.stations stations, every one a vec4f).
  assert.equal(p.size, 1856 + STREET_VEC4S * 16 + ROOM.slots * (32 + 16 * (ROOM.furniture + ROOM.stations)))
  assert.equal(p.size, PARAMS_SIZE)
  assert.equal(m.get('streets')!.offset, 192 + MAX_CARS * 32 + RECRUIT_SLOTS * 16)
  assert.equal(m.get('streets')!.offset, PARAMS_STREETS)
  assert.equal(m.get('rooms')!.offset, PARAMS_STREETS + STREET_VEC4S * 16)
  assert.equal(m.get('rooms')!.offset, PARAMS_ROOMS)
  assert.equal(layoutOf('Room', MODULE).size, ROOM_FLOATS * 4)
  assert.deepEqual([...layoutOf('Room', MODULE).members!].map(([k, v]) => [k, v.offset]), [['a', 0], ['b', 16], ['furniture', 32], ['stations', 32 + ROOM.furniture * 16]])
  assert.equal(m.get('player')!.offset, 32)
  assert.equal(m.get('aux')!.offset, 48)
  assert.equal(m.get('camera')!.offset, 64)
  assert.equal(m.get('global')!.offset, 80)
  assert.equal(m.get('planes')!.offset, 96)
  assert.equal(m.get('cars')!.offset, 192)
  // The operator's summons ride after the cars: RECRUIT_SLOTS × (at.xy, agent, flags).
  assert.equal(m.get('summons')!.offset, 192 + MAX_CARS * 32)
  assert.equal(layoutOf('array<Summon, SUMMON_SLOTS>', MODULE).size, RECRUIT_SLOTS * 16)
  const sm = layoutOf('Summon', MODULE)
  assert.equal(sm.size, 16)
  assert.deepEqual([...sm.members!].map(([k, v]) => [k, v.offset]), [['at', 0], ['agent', 8], ['flags', 12]])
  // Uniform buffers: array strides and struct/array member offsets are multiples of 16.
  for (const [name, { offset, type }] of m) {
    if (type.startsWith('array') || structs(MODULE).has(type)) assert.equal(offset % 16, 0, name)
    if (type.startsWith('array')) assert.equal(layoutOf(type, MODULE).stride! % 16, 0, name)
  }
  const c = layoutOf('Car', MODULE)
  assert.equal(c.size, 32)
  assert.equal(c.members!.get('b')!.offset, 16)
  assert.equal(layoutOf('Brain', MODULE).size, 64)
  assert.equal(layoutOf(bindings(MODULE).get('hazards')!.type, MODULE).size, 2 * MAX_CARS * 4)
  // Four counters, the Ring-0 flags word and three spare: 32 bytes, 16-byte aligned.
  assert.equal(layoutOf(bindings(MODULE).get('stats')!.type, MODULE).size, 32)
})

test('the worker builds only the simulation passes and the page only the cull, each bind group backed by buffers big and flagged enough', async () => {
  assert.deepEqual([...SIM_PASSES, ...CULL_PASSES].sort(), Object.keys(PASS_BINDINGS).sort(), 'every entry point belongs to exactly one side')
  const vars = [...bindings(MODULE).values()]
  const check = (device: MockDevice, passes: readonly string[]) => {
    assert.equal(device.shader, MODULE)
    assert.deepEqual(device.groups.map((g) => g.entryPoint).sort(), [...passes].sort())
    for (const g of device.groups) {
      assert.deepEqual(g.entries.map((e) => e.binding), [...PASS_BINDINGS[g.entryPoint as keyof typeof PASS_BINDINGS]])
      for (const { binding, buffer, texture } of g.entries) {
        const v = vars.find((x) => x.binding === binding)!
        if (v.space === 'texture') {
          assert.ok(texture && !buffer, `${g.entryPoint} binding ${binding}: a texture view`)
          assert.ok(texture!.usage & TEXTURE_USAGE.TEXTURE_BINDING, `${g.entryPoint} binding ${binding}: sampled`)
          continue
        }
        assert.ok(buffer, `${g.entryPoint} binding ${binding}: a buffer`)
        const runtime = /^array<[^,]+>$/.test(v.type)
        const min = runtime ? layoutOf(v.type.slice(6, -1), MODULE).size : layoutOf(v.type, MODULE).size
        assert.ok(buffer.size >= min, `${g.entryPoint} binding ${binding}: ${buffer.size} < ${min}`)
        assert.ok(buffer.usage & (v.space === 'uniform' ? USAGE.UNIFORM : USAGE.STORAGE), `${g.entryPoint} binding ${binding} usage`)
      }
    }
  }
  const sim = await simRig()
  check(sim.device, SIM_PASSES)
  assert.equal(sim.device.buffer('crowd.params').size, layoutOf('Params', MODULE).size, 'the uniform is exactly struct Params')
  const hazards = sim.device.buffer('crowd.hazards')
  assert.equal(hazards.size, 2 * MAX_CARS * 4)
  assert.ok(hazards.u32().every((v) => v === 0xffffffff), 'hazard slots start as "nobody", not 0 m')
  // The worker's pedestrian state is its own: copyable out for the readback, never a page buffer.
  for (const name of ['crowd.pos', 'crowd.vel', 'crowd.pose']) {
    const b = sim.device.buffer(name)
    assert.equal(b.size, AGENTS * 16, name)
    assert.ok(b.usage & USAGE.STORAGE && b.usage & USAGE.COPY_SRC, `${name} usage`)
  }
  assert.ok(sim.device.log.includes('dispatch spawn'), 'the worker places every pedestrian at boot')
  const cull = await cullRig()
  check(cull.device, CULL_PASSES)
  assert.equal(cull.device.buffer('crowd.cullParams').size, layoutOf('Params', MODULE).size)
  assert.ok(!cull.device.buffers.some((b) => b.label === 'crowd.hazards' || b.label === 'crowd.brain' || b.label === 'crowd.stats'), 'the page has no sensing buffers at all')
})

test('Params: every field each side writes lands where the WGSL struct reads it, and the other side\'s fields stay zero', async () => {
  const { device, crowd } = await simRig()
  const input = simInput()
  crowd.step(input)
  const { f, u, at, carField } = params(device, 'crowd.params')
  const f32 = (x: number) => Math.fround(x)
  assert.equal(f[at('dt')], f32(input.dt))
  assert.equal(f[at('time')], f32(input.time))
  assert.equal(u[at('frame')], 1)
  assert.equal(u[at('agentCount')], AGENTS)
  assert.equal(u[at('carCount')], 2)
  assert.equal(f[at('signalTime')], f32(input.time), 'the crowd obeys the same clock as the cars: the realm\'s')
  assert.deepEqual([...f.subarray(at('player'), at('player') + 4)], [101, 102, 1.5, 1.3].map(f32))
  assert.equal(f[at('aux')], 1, 'the player\'s own body is visible on foot')
  assert.deepEqual(carField(0, 'a'), [10, 7, 0.3, 9].map(f32))
  assert.deepEqual(carField(0, 'b'), [0.92, 2.3, 0.05, corridorReach(input.cars[0])].map(f32))
  assert.deepEqual(carField(1, 'b'), [0.92, 2.3, -0.1, corridorReach(input.cars[1])].map(f32))
  // The worker draws nothing: no camera, frustum, distances or density reach its uniform.
  assert.deepEqual([f[at('lodDistance')], f[at('nearRadius')], f[at('aux') + 1], f[at('aux') + 2]], [0, 0, 0, 0])
  assert.ok([...f.subarray(at('camera'), at('camera') + 4)].every((x) => x === 0))
  assert.ok([...f.subarray(at('planes'), at('planes') + 24)].every((x) => x === 0))
  // The global word (globalState.ts): the step's clock and the mode (off here); the floating origin is the page's
  // alone, so the worker packs zero for it.
  assert.deepEqual([...f.subarray(at('global'), at('global') + 4)], [f32(input.time), 0, 0, 0])
  crowd.step(simInput({ matrixMode: true }))
  assert.deepEqual([...params(device, 'crowd.params').f.subarray(at('global'), at('global') + 4)], [f32(input.time), 1, 0, 0])
  // The shader reads them by these names: Car.b = (half width, half length, curvature, corridor reach), aux =
  // (avatar visible, density beyond nearRadius, max draw distance, -).
  assert.match(flat('simulate'), /corridorGap\(lz, -lx, car\.b\.x, car\.b\.y, car\.b\.z, -CAR_AXLE\)/)
  assert.ok(flat('simulate').includes('let vis = P.aux.x > 0.5;'))

  const page = await cullRig()
  page.crowd.upload(new Float32Array(AGENTS * 12))
  page.crowd.step(cullInput)
  const c = params(page.device, 'crowd.cullParams')
  assert.equal(c.u[c.at('agentCount')], AGENTS)
  assert.equal(c.u[c.at('frame')], 1)
  assert.equal(c.f[c.at('lodDistance')], 30)
  assert.equal(c.f[c.at('nearRadius')], 22)
  assert.deepEqual([...c.f.subarray(c.at('aux'), c.at('aux') + 4)], [0, 0.6, 180, 0].map(f32))
  assert.deepEqual([...c.f.subarray(c.at('camera'), c.at('camera') + 4)], [3, 4, 5, 0])
  assert.deepEqual([...c.f.subarray(c.at('planes'), c.at('planes') + 24)], [...planes])
  // The global word is the page's state, packed where the worker packs its own (the same offset, the same packer).
  assert.deepEqual([...c.f.subarray(c.at('global'), c.at('global') + 4)], [0, 0, 0, 0], 'absent: all zero')
  page.crowd.step({ ...cullInput, global: { time: 7.25, on: true, originX: -3, originZ: 512 } })
  assert.deepEqual([...params(page.device, 'crowd.cullParams').f.subarray(c.at('global'), c.at('global') + 4)], [7.25, 1, -3, 512])
  // The page simulates nothing: no step, no cars, no player, no clock in its uniform.
  assert.deepEqual([c.f[c.at('dt')], c.f[c.at('time')], c.u[c.at('carCount')], c.f[c.at('signalTime')]], [0, 0, 0, 0])
  assert.ok([...c.f.subarray(c.at('player'), c.at('player') + 4)].every((x) => x === 0))
  const cull = flat('cull')
  for (const line of [
    'if (d >= P.aux.z) { return; }',
    'var visible = d < P.nearRadius;',
    'if (i != PLAYER_INDEX && rand(i, DENSITY_SALT) >= densityCut(d, P.nearRadius, P.aux.y)) { return; }',
    'let lod = select(1u, 0u, d < lodCut(P.lodDistance, rand(i, LOD_SALT)));',
  ]) assert.ok(cull.includes(line), line)
  assert.ok(cull.indexOf('rand(i, DENSITY_SALT)') > cull.indexOf('if (!visible) {'), 'the lottery only thins people beyond nearRadius')
})

test('curvature: a missing, NaN or infinite value senses a straight path; extra cars are clamped to MAX_CARS', async () => {
  const { device, crowd } = await simRig()
  const missing: Partial<CarState> = car(30, 0)
  delete missing.curvature
  const many = Array.from({ length: MAX_CARS + 5 }, (_, j) => car(j, 0.01))
  many[0] = car(1, NaN)
  many[1] = missing as CarState
  many[3] = car(3, Infinity)
  many[4] = car(4, -Infinity)
  crowd.step(simInput({ cars: many }))
  const { u, at, carField } = params(device, 'crowd.params')
  assert.equal(u[at('carCount')], MAX_CARS)
  for (const j of [0, 1, 3, 4]) assert.equal(carField(j, 'b')[2], 0, `car ${j}`)
  assert.equal(carField(2, 'b')[2], Math.fround(0.01))
})

test('a long worker step is simulated in substeps of at most 0.05 s, each with its own uniform, then read back once', async () => {
  assert.equal(CROWD_SUBSTEP, 0.05)
  // The stagger springs diverge above ~0.096 s with semi-implicit Euler: K_TILT 120, C_TILT 15 in the shader.
  const k = constants(SOURCE)
  const unstable = (K: number, C: number, dt: number) => Math.abs(2 - C * dt - K * dt * dt) >= 2 - C * dt
  assert.ok(!unstable(k.get('K_TILT')!, k.get('C_TILT')!, CROWD_SUBSTEP) && !unstable(k.get('K_BEND')!, k.get('C_BEND')!, CROWD_SUBSTEP))
  assert.ok(unstable(k.get('K_TILT')!, k.get('C_TILT')!, 0.1), 'a 0.1 s step would diverge: substeps are required')
  const { device, crowd } = await simRig()
  const seen: { dt: number; time: number; frame: number }[] = []
  device.onDispatch = (ep) => {
    if (ep !== 'simulate') return
    const p = params(device, 'crowd.params')
    seen.push({ dt: p.f[p.at('dt')], time: p.f[p.at('time')], frame: p.u[p.at('frame')] })
  }
  device.log.length = 0
  crowd.step(simInput({ dt: 0.08, time: 10 }))
  assert.deepEqual(seen, [{ dt: Math.fround(0.04), time: Math.fround(9.96), frame: 1 }, { dt: Math.fround(0.04), time: 10, frame: 2 }])
  assert.equal(device.log.filter((l) => l === 'submit').length, 2, 'one submit per substep: each sees its own uniform')
  assert.equal(device.maps.length, 1, 'one readback, of the last substep')
  assert.ok(device.log.lastIndexOf('dispatch simulate') < device.log.findIndex((l) => l.startsWith('copy crowd.hazards')), 'copied after the last simulate')
  await device.flush()
  assert.equal(crowd.readout!.time, 10 - 0.04, 'stamped with the start of the last substep: where simulate sensed each pedestrian')
  seen.length = 0
  crowd.step(simInput({ dt: 0.05, time: 10.05 }))
  assert.equal(seen.length, 1)
  crowd.step(simInput({ dt: 0, time: 10.05 }))
  assert.equal(seen.length, 2, 'a zero step still runs once (the boot prime)')
})

test('hazard slots: reset before every step, read back with the counters and the render frame, decoded to metres', async () => {
  const { device, crowd } = await simRig()
  assert.equal(crowd.readout, null, 'no reading before the first readback')
  const hazards = device.buffer('crowd.hazards')
  const pos = device.buffer('crowd.pos'), vel = device.buffer('crowd.vel'), pose = device.buffer('crowd.pose')
  device.onDispatch = (ep) => {
    if (ep !== 'simulate') return
    const u = hazards.u32()
    assert.ok(u.every((v) => v === 0xffffffff), 'simulate starts from a cleared hazard buffer')
    u[0] = 1234 // car 0: 12.34 m ahead
    u[5] = 0 // car 5: at the bumper
    u[MAX_CARS - 1] = 2999
    u[MAX_CARS + 3] = 750 // car 3: 7.5 m behind
    pos.f32()[0] = 11; pos.f32()[4 * AGENTS - 1] = 12
    vel.f32()[0] = 21; vel.f32()[4 * AGENTS - 1] = 22
    pose.f32()[0] = 31; pose.f32()[4 * AGENTS - 1] = 32
  }
  device.log.length = 0
  crowd.step(simInput({ time: 42, seq: 7 }))
  const log = device.log.join('\n')
  assert.ok(log.indexOf(`write crowd.hazards @0+${2 * MAX_CARS * 4}`) < log.indexOf('submit'), 'cleared on the queue before the step is submitted')
  const copies = device.log.filter((l) => l.startsWith('copy ')).map((l) => /^copy (\S+)@\d+ -> (\S+)@(\d+)\+(\d+)$/.exec(l)!)
  assert.equal(new Set(copies.map((c) => c[2])).size, 1, 'one staging buffer per step')
  const staging = copies.map((c) => [Number(c[3]), Number(c[4])]).sort((a, b) => a[0] - b[0])
  let end = 0
  for (const [offset, size] of staging) {
    assert.equal(offset, end, 'readback regions are contiguous and non-overlapping')
    end = offset + size
  }
  assert.equal(end, simReadbackSize(AGENTS), 'the staging buffer is exactly the readback')
  assert.equal(end, device.buffer(copies[0][2]).size)
  assert.deepEqual(copies.map((c) => c[1]), ['crowd.stats', 'crowd.hazards', 'crowd.pos', 'crowd.vel', 'crowd.pose'])
  assert.ok(log.indexOf('dispatch simulate') < log.indexOf('copy crowd.hazards'), 'read back after simulate wrote them')
  assert.equal(crowd.takeFrame(), null, 'nothing before the readback resolves')
  await device.flush()
  const r = crowd.readout!
  assert.equal(r.seq, 7, 'a reading names the step it measured')
  assert.equal(r.time, 42 - 1 / 60, 'a reading carries the realm time of the positions it measured (the substep\'s start)')
  assert.equal(r.hazardsAhead[0], Math.fround(12.34))
  assert.equal(r.hazardsAhead[5], 0)
  assert.equal(r.hazardsAhead[MAX_CARS - 1], Math.fround(29.99))
  assert.equal(r.hazardsBehind[3], 7.5)
  assert.equal([...r.hazardsAhead, ...r.hazardsBehind].filter((v) => v !== Infinity).length, 4)
  // The render frame: every pos, then every vel, then every pose, 12 floats per agent, a copy the page can own.
  const frame = crowd.takeFrame()!
  assert.equal(frame.length, AGENTS * RENDER_FLOATS)
  assert.deepEqual([frame[0], frame[4 * AGENTS - 1], frame[4 * AGENTS], frame[8 * AGENTS - 1], frame[8 * AGENTS], frame[12 * AGENTS - 1]], [11, 12, 21, 22, 31, 32])
  assert.equal(crowd.takeFrame(), null, 'taken once')
  // The next step sees nobody: every slot returns to Infinity. A handed-back buffer is reused for its frame.
  crowd.recycle(frame.buffer as ArrayBuffer)
  crowd.recycle(new ArrayBuffer(8)) // the wrong size is ignored
  device.onDispatch = () => {}
  crowd.step(simInput())
  await device.flush()
  assert.ok([...crowd.readout!.hazardsAhead, ...crowd.readout!.hazardsBehind].every((v) => v === Infinity))
  assert.equal(crowd.takeFrame()!.buffer, frame.buffer, 'the returned buffer carries the next frame')
})

test('Ring-0 crowd flag: raised in simulate before containment, latched in the worker until the audit takes it, cleared on the GPU once read', async () => {
  // The shader tests the exponent bits of the unclamped position, the velocity, the heading and the walk
  // phase; clampCity would launder an infinity or a NaN into a corner of the city first.
  const sim = flat('simulate')
  for (const line of [
    'let next = me + nv * dt;',
    'let held = contain(me, next, 0.35, mayEnter || asked);',
    'me = clampCity(held);',
    'if (nonFinite(next) || nonFinite(nv) || nonFinite(vec2f(p.w, phase))) { atomicOr(&stats[4], FLAG_NON_FINITE); }',
  ]) assert.ok(sim.includes(line), line)
  assert.ok(sim.indexOf('let next = me + nv * dt;') < sim.indexOf('me = clampCity(held);'))
  assert.ok(sim.indexOf('atomicOr(&stats[4]') < sim.indexOf('pos[i] = vec4f(me.x, 0.0, me.y, p.w);'), 'flagged before the state is stored')
  assert.ok(flat('nonFinite').includes('any((bitcast<vec2u>(v) & vec2u(EXP_MASK)) == vec2u(EXP_MASK))'))
  // The mask picks out exactly the infinities and NaN of binary32: a huge finite, a denormal and zero pass.
  const mask = constants(MODULE).get('EXP_MASK')!
  const bits = new Uint32Array(new Float32Array([NaN, Infinity, -Infinity, 3.4e38, 1e-45, 0, -0, 3.5, -1e30]).buffer)
  assert.deepEqual([...bits].map((b) => (b & mask) === mask), [true, true, true, false, false, false, false, false, false])
  assert.equal(FLAG_NON_FINITE, 1)
  // The word survives the per-step reset (which only zeroes the counters) until a readback reports it.
  const { device, crowd } = await simRig()
  const stats = device.buffer('crowd.stats')
  assert.equal(stats.size, 32)
  assert.equal(crowd.takeFlags(), 0)
  let raise = true
  device.onDispatch = (ep) => { if (ep === 'simulate' && raise) { stats.u32()[4] |= FLAG_NON_FINITE; raise = false } }
  device.log.length = 0
  crowd.step(simInput()) // raised this step
  crowd.step(simInput()) // the reset of the counters must leave it standing
  assert.equal(stats.u32()[4], FLAG_NON_FINITE, 'sticky across the per-step reset')
  assert.ok(device.log.filter((l) => l.startsWith('write crowd.stats')).every((l) => l === 'write crowd.stats @4+12' || l === 'write crowd.stats @20+4'), 'the per-step reset only touches the counters (and the working count past the flags)')
  assert.equal(crowd.takeFlags(), 0, 'nothing is reported before a readback resolves')
  await device.flush()
  assert.equal(stats.u32()[4], 0, 'cleared on the GPU once reported')
  assert.ok(device.log.includes('write crowd.stats @16+4'), 'the clear writes the flags word alone')
  // Latched: a clean readback resolving after it (before the audit ran) cannot hide it. Taken once.
  crowd.step(simInput())
  await device.flush()
  assert.equal(crowd.takeFlags(), FLAG_NON_FINITE, 'the flag outlives the clean readback that followed it')
  assert.equal(crowd.takeFlags(), 0, 'and is consumed by the audit that took it')
  assert.equal(crowd.readout!.stats.nudges, 0)
})

test('a readback that resolves late never overwrites a newer one, and staging slots are recycled', async () => {
  const { device, crowd } = await simRig()
  const hazards = device.buffer('crowd.hazards')
  const stats = device.buffer('crowd.stats')
  let n = 0
  device.onDispatch = (ep) => {
    if (ep !== 'simulate') return
    n++
    hazards.u32()[0] = n * 100
    stats.u32()[1] = n // waiting
  }
  crowd.step(simInput())
  crowd.step(simInput())
  crowd.step(simInput())
  assert.equal(device.maps.length, 3)
  crowd.step(simInput()) // all three staging buffers busy: this step is not read back
  assert.equal(device.maps.length, 3)
  await device.flush('lifo') // step 3 resolves first, then 2, then 1
  assert.equal(crowd.readout!.hazardsAhead[0], 3)
  assert.equal(crowd.readout!.stats.waiting, 3)
  crowd.step(simInput())
  assert.equal(device.maps.length, 1, 'slots are free again after unmap')
  await device.flush()
  assert.equal(crowd.readout!.hazardsAhead[0], 5)
  assert.equal(crowd.readout!.stats.waiting, 5)
})

test('a lost worker device is reported and the crowd stops stepping', async () => {
  const { device, crowd } = await simRig()
  assert.equal(crowd.lost, null)
  device.lose('unknown', 'driver reset')
  await new Promise((r) => setImmediate(r))
  assert.match(crowd.lost ?? '', /GPU device lost \(unknown\): driver reset/)
  device.log.length = 0
  crowd.step(simInput())
  assert.equal(device.log.length, 0, 'nothing is dispatched on a lost device')
})

test('the page: frames are uploaded into its render buffers in order; nothing is culled before the first; draw counts read back', async () => {
  const { device, crowd } = await cullRig()
  device.log.length = 0
  crowd.step(cullInput)
  assert.ok(!device.log.includes('dispatch cull'), 'no cull over the zeros before the first frame (everyone would be drawn at the origin)')
  assert.ok(device.log.includes('write drawArgs @0+160'), 'the indirect draws are still reset to zero instances')
  assert.equal(crowd.upload(new Float32Array(5)), false, 'a frame of the wrong length is refused')
  const frame = new Float32Array(AGENTS * 12).map((_, i) => i)
  device.log.length = 0
  assert.equal(crowd.upload(frame), true)
  assert.deepEqual(device.log, [`write pos @0+${AGENTS * 16}`, `write vel @0+${AGENTS * 16}`, `write pose @0+${AGENTS * 16}`])
  assert.deepEqual([device.buffer('pos').f32()[0], device.buffer('vel').f32()[0], device.buffer('pose').f32()[0]], [0, 4 * AGENTS, 8 * AGENTS])
  assert.equal(device.buffer('pose').f32()[4 * AGENTS - 1], 12 * AGENTS - 1)
  const drawArgs = device.buffer('drawArgs')
  device.onDispatch = (ep) => { if (ep === 'cull') { drawArgs.u32()[1] = 7; drawArgs.u32()[(VARIANTS + 2) * 5 + 1] = 3 } }
  device.log.length = 0
  crowd.step(cullInput)
  assert.ok(device.log.includes('dispatch cull'))
  const copies = device.log.filter((l) => l.startsWith('copy '))
  assert.deepEqual(copies.map((l) => l.split(' ')[1].split('@')[0]), ['drawArgs'], 'the page reads back only what it drew')
  await device.flush()
  assert.deepEqual(crowd.stats, { drawnNear: 7, drawnFar: 3 })
})

test('the page: the hide mask sinks the listed figures below the cull\'s floor in the render copy, after every upload, and nothing else', async () => {
  const { device, crowd } = await cullRig()
  // Before the first upload nothing is written: the buffers hold zeros and nobody is culled in anyway.
  device.log.length = 0
  crowd.hide([3])
  assert.deepEqual(device.log, [])
  assert.deepEqual([...crowd.hidden], [3])
  const frame = new Float32Array(AGENTS * 12).map((_, i) => i)
  crowd.upload(frame)
  assert.equal(device.log.at(-1), 'write pos @48+16', 'the upload re-applies the mask')
  const y = (agent: number) => device.buffer('pos').f32()[agent * 4 + 1]
  assert.equal(y(3), -100)
  assert.equal(y(2), 2 * 4 + 1, 'nobody else is touched')
  // The player's own figure (0), a duplicate, an index past the crowd and a non-index are ignored; a newly hidden
  // figure is sunk at once, one already hidden is not written again.
  device.log.length = 0
  crowd.hide([3, 0, 5, 3, AGENTS, 1.5, -1])
  assert.deepEqual([...crowd.hidden], [3, 5])
  assert.deepEqual(device.log, ['write pos @80+16'])
  assert.equal(y(5), -100)
  assert.equal(y(0), 1)
  // Shown again: nothing is written now (the copy is stale either way); the next frame brings the figure back.
  device.log.length = 0
  crowd.hide([5])
  assert.deepEqual(device.log, [])
  crowd.upload(frame)
  assert.equal(y(3), 3 * 4 + 1)
  assert.equal(y(5), -100)
  // At most MAX_HIDDEN, in the order given.
  crowd.hide([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  assert.deepEqual([...crowd.hidden], [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(MAX_HIDDEN, 8)
  crowd.hide([])
  assert.equal(crowd.hidden.length, 0)
})

test('setCull: the first setting is drawn from the next step; a later one glides there over CULL_EASE.glide steps; copied and sanitised', async () => {
  const settings = { lodDistance: 30, nearRadius: 22, density: 0.6, maxDistance: 180 }
  const { device, crowd } = await cullRig(settings)
  settings.density = 0.1 // the caller's object is not retained
  crowd.step(cullInput)
  let p = params(device, 'crowd.cullParams')
  const sent = () => {
    p = params(device, 'crowd.cullParams')
    return [p.f[p.at('lodDistance')], p.f[p.at('nearRadius')], p.f[p.at('aux') + 1], p.f[p.at('aux') + 2]]
  }
  assert.deepEqual(sent(), [30, 22, Math.fround(0.6), 180])
  const next = { lodDistance: 18, nearRadius: 9, density: 0.25, maxDistance: 70 }
  crowd.setCull(next)
  assert.equal(params(device, 'crowd.cullParams').f[p.at('aux') + 1], Math.fround(0.6), 'nothing is written before the next step')
  // A tier change: every knob moves a 1/glide of the way per step, monotonically, and lands exactly.
  let last = [30, 22, 0.6, 180]
  for (let k = 1; k <= CULL_EASE.glide; k++) {
    crowd.step(cullInput)
    const now = sent()
    const t = k / CULL_EASE.glide
    const want = [30 + (18 - 30) * t, 22 + (9 - 22) * t, 0.6 + (0.25 - 0.6) * t, 180 + (70 - 180) * t]
    for (let j = 0; j < 4; j++) {
      assert.ok(Math.abs(now[j] - want[j]) < 1e-4, `step ${k} knob ${j}: ${now[j]} vs ${want[j]}`)
      assert.ok(now[j] <= last[j] + 1e-6, `step ${k} knob ${j} moves one way`)
      assert.ok(Math.abs(now[j] - last[j]) <= Math.abs(want[j] - (j === 0 ? 30 : j === 1 ? 22 : j === 2 ? 0.6 : 180)) / k + 1e-4, 'no jump')
    }
    last = now
  }
  assert.deepEqual(sent(), [18, 9, 0.25, 70])
  crowd.step(cullInput)
  assert.deepEqual(sent(), [18, 9, 0.25, 70], 'and stays')
  // A change mid-glide starts from what is drawn, not from where the last glide began.
  crowd.setCull({ lodDistance: 48, nearRadius: 9, density: 0.25, maxDistance: 70 })
  crowd.step(cullInput)
  const mid = sent()[0]
  crowd.setCull({ lodDistance: 18, nearRadius: 9, density: 0.25, maxDistance: 70 })
  crowd.step(cullInput)
  assert.ok(Math.abs(sent()[0] - mid) <= 30 / CULL_EASE.glide + 1e-4, 'reversing mid-glide does not jump')
  // A draw distance of 0 (a region: nobody of the crowd drawn) is taken at once.
  crowd.setCull({ lodDistance: 18, nearRadius: 9, density: 0.25, maxDistance: 0 })
  crowd.step(cullInput)
  assert.equal(sent()[3], 0)
  const cases: [number, number, number, number, number, number][] = [
    // lod/near, density, maxDistance → sent lod/near, density, maxDistance
    [12, 1.7, Infinity, 12, 1, 1e6], [-3, -0.2, -5, 0, 0, 0], [NaN, NaN, NaN, 0, 1, 1e6], [Infinity, 0, 0, 1e6, 0, 0], [40, 1, 250, 40, 1, 250],
  ]
  for (const [dist, density, maxDistance, sd, d, m] of cases) {
    crowd.setCull({ lodDistance: dist, nearRadius: dist, density, maxDistance })
    for (let k = 0; k < CULL_EASE.glide; k++) {
      crowd.step(cullInput)
      assert.ok(sent().every(Number.isFinite), 'WGSL never sees Infinity or NaN, gliding or not')
    }
    assert.deepEqual(sent(), [sd, sd, d, m], `distance ${dist}, density ${density}, maxDistance ${maxDistance}`)
  }
})

test('the cull eases its rings: the density cut falls from everyone at nearRadius to density over DENSITY_FADE, and the LOD ring is spread per person', () => {
  const { densityCut, lodCut } = transpile(['densityCut', 'lodCut'], { f32: true })
  for (const density of [0, 0.25, 0.6, 1]) {
    assert.equal(densityCut(9.99, 10, density), 1, 'inside the near radius everyone')
    assert.equal(densityCut(10, 10, density), 1, 'at the near radius everyone: no wall')
    assert.ok(Math.abs(densityCut(10 + CULL_EASE.fade, 10, density) - density) < 1e-6, 'the full fade later, the density')
    assert.ok(Math.abs(densityCut(500, 10, density) - density) < 1e-6)
    let prev = 1
    for (let d = 10; d <= 10 + CULL_EASE.fade; d += 0.25) {
      const cut = densityCut(d, 10, density)
      assert.ok(cut <= prev + 1e-7 && prev - cut <= ((1 - density) * 0.25) / CULL_EASE.fade + 1e-6, `d ${d}: the cut falls steadily`)
      prev = cut
    }
  }
  assert.equal(lodCut(0, 0.99), 0, 'no detailed bodies stays none')
  assert.ok(Math.abs(lodCut(30, 0) - 30 * (1 - CULL_EASE.lodSpread / 2)) < 1e-4 && Math.abs(lodCut(30, 0.5) - 30) < 1e-6)
  // People cross the ring a few at a time: of 4,096 fixed draws, no 1 cm band holds more than a handful.
  const cuts = Array.from({ length: 4096 }, (_, i) => lodCut(30, ((Math.imul(i + 1, 2654435761) >>> 8) / 16777216)))
  const bands = new Map<number, number>()
  for (const c of cuts) bands.set(Math.floor(c * 100), (bands.get(Math.floor(c * 100)) ?? 0) + 1)
  assert.ok(Math.max(...bands.values()) <= 16, `${Math.max(...bands.values())} cross together`)
  assert.ok(MODULE.includes('rand(i, DENSITY_SALT) >= densityCut(d, P.nearRadius, P.aux.y)') && MODULE.includes('d < lodCut(P.lodDistance, rand(i, LOD_SALT))'), 'the cull uses both')
})

test('the draw lists hold every agent per (LOD, body): a worn look can put the whole crowd on one body', () => {
  for (const n of [0, 1, 7, 4096, 14_000]) assert.equal(agentQuota(n), n)
  const consts = constants(crowdShader(14_000))
  assert.equal(Number(consts.get('AGENT_QUOTA')), 14_000)
  assert.equal(Number(consts.get('LIST_LOD_STRIDE')), 14_000 * VARIANTS)
})

test('the crowd sensing constants the worker relies on match the shader', () => {
  // Stale readings are shortened by how far a pedestrian can have walked: the shader's velocity cap.
  assert.ok(flat('simulate').includes('if (sp > 3.0) { nv *= 3.0 / sp; }'))
  assert.equal(PEDESTRIAN_MAX_SPEED, 3.0)
  assert.equal(SENSOR_MAX_CARS, MAX_CARS, 'the fleet cap is the hazard slot count')
  assert.equal(constants(MODULE).get('HAZARD_SLOTS'), 2 * SENSOR_MAX_CARS)
})

test('WGSL degreeOf mirrors degrees.ts for every face, modifier and DC', () => {
  const wgsl = transpile(['degreeOf'])
  for (let dc = 0; dc <= 40; dc++) {
    for (let mod = -10; mod <= 25; mod++) {
      for (let n = 1; n <= 20; n++) assert.equal(wgsl.degreeOf(n, n + mod, dc), degreeOf(n, n + mod, dc), `n=${n} mod=${mod} dc=${dc}`)
    }
  }
})

test('walk start: the WGSL walk window is civic walkAllowed, and nobody steps off before their delay or outside the window', () => {
  const { walkElapsed, walkDelay } = transpile(['walkElapsed', 'walkDelay'])
  const step = 0.01
  for (let t = -SIGNAL.cycle; t < SIGNAL.cycle * 3; t += step) {
    for (const [alongX, axis] of [[true, 'ew'], [false, 'ns']] as const) {
      const e = walkElapsed(alongX, t)
      assert.equal(e >= 0, walkAllowed(axis, t), `t=${t} ${axis}`)
      for (let deg = 0; deg < 4; deg++) {
        if (!(e >= 0 && e >= walkDelay(deg))) continue
        // Stepping off: only alongside green traffic, only after the degree's delay, only inside the walk.
        assert.equal(signalFor(axis, t), 'green')
        const p = ((t % SIGNAL.cycle) + SIGNAL.cycle) % SIGNAL.cycle
        const start = axis === 'ew' ? 0 : SIGNAL.ewAmber
        assert.ok(p >= start + WALK_START.delay[deg] - 1e-6 && p < start + SIGNAL.walkSeconds, `t=${t} deg=${deg}`)
      }
    }
  }
  // Someone arriving mid-phase with the delay already run goes at once; before it, they wait.
  for (let deg = 0; deg < 4; deg++) {
    const d = WALK_START.delay[deg]
    for (const [alongX, start] of [[true, 0], [false, SIGNAL.ewAmber]] as const) {
      assert.ok(walkElapsed(alongX, SIGNAL.cycle * 5 + start + d + 0.05) >= walkDelay(deg), `deg ${deg} goes once its delay has run`)
      assert.ok(walkElapsed(alongX, SIGNAL.cycle * 5 + start + SIGNAL.walkSeconds - 0.05) >= walkDelay(deg), `deg ${deg} arriving late still goes`)
      if (d > 0.05) assert.ok(walkElapsed(alongX, SIGNAL.cycle * 5 + start + d - 0.05) < walkDelay(deg), `deg ${deg} waits for its delay`)
    }
  }
})

test('walk start: one Perception check per agent per signal cycle picks the delay from the WALK_START table', () => {
  const { walkDelay } = transpile(['walkDelay'])
  WALK_START.delay.forEach((d, k) => assert.equal(walkDelay(k), d, `degree ${k}`))
  // A better degree never steps off later, and even the worst leaves most of the walk to cross in.
  for (let k = 1; k < 4; k++) assert.ok(WALK_START.delay[k] <= WALK_START.delay[k - 1])
  assert.ok(WALK_START.delay[0] < SIGNAL.walkSeconds / 2)
  // The roll hashes only the agent and the cycle number, so it holds for the whole cycle (no state to
  // reset) and is re-rolled every cycle; it gates the only CROSS_WAIT → CROSS_WALK transition.
  const sim = flat('simulate')
  for (const line of [
    'let cycle = bitcast<u32>(i32(floor(P.signalTime / SIGNAL_CYCLE)));',
    'let nat = d20(i, hash2(cycle, WALK_SALT));',
    'let delay = walkDelay(degreeOf(nat, nat + WALK_MOD, WALK_DC));',
    'let walked = walkElapsed(abs(d.x) > abs(d.y), P.signalTime);',
    'if (walked >= 0.0 && walked >= delay) { crossing = CROSS_WALK; }',
  ]) assert.ok(sim.includes(line), line)
  assert.equal(sim.split('crossing = CROSS_WALK').length, 2, 'no other path starts a crossing')
  assert.ok(!sim.includes('walkAllowed'), 'the old ungated walk test is gone')
})

test('ghost mode: the avatar is never binned, so no pedestrian separates from, aligns with or flocks to the user', () => {
  const bin = flat('binAgents')
  // The first statement returns for the avatar, before the grid is touched.
  const guard = bin.indexOf('if (i >= P.agentCount || i == PLAYER_INDEX) { return; }')
  assert.ok(guard >= 0, 'binAgents skips PLAYER_INDEX')
  assert.ok(guard < bin.indexOf('atomicAdd(&gridCountW'), 'before the slot is taken')
  // The grid is the simulate pass's only view of neighbours: separation, alignment and cohesion all read it.
  const sim = flat('simulate')
  assert.ok(sim.includes('let q = gridSlotsR[ci * GRID_CAP + s];'))
  assert.ok(!/\bpos\[\s*PLAYER_INDEX\s*\]|\bvel\[\s*PLAYER_INDEX\s*\]/.test(sim), 'simulate never reads the avatar directly')
})

test('simulate senses every car in its own frame, driving on and reversing, and never for the avatar', () => {
  const sim = flat('simulate')
  for (const line of [
    'let f = vec2f(sin(car.a.z), cos(car.a.z));',
    'let r = vec2f(-f.y, f.x);',
    'let rel = me - car.a.xy;',
    'var lz = dot(rel, f);',
    'var lx = dot(rel, r);',
    'if (dot(rel, rel) <= car.b.w * car.b.w) { let ahead',
    'let ahead = corridorGap(lz, -lx, car.b.x, car.b.y, car.b.z, -CAR_AXLE);',
    'if (ahead >= 0.0) { atomicMin(&hazards[j], u32(ahead * 100.0)); }',
    'let behind = corridorGap(-lz, -lx, car.b.x, car.b.y, car.b.z, CAR_AXLE);',
    'if (behind >= 0.0) { atomicMin(&hazards[MAX_CARS + j], u32(behind * 100.0)); }',
  ]) assert.ok(sim.includes(line), line)
  // The avatar's branch returns before the car loop: Fleet measures the avatar on the CPU.
  const avatar = sim.indexOf('if (i == PLAYER_INDEX) {'), after = sim.indexOf('var p = pos[i];')
  assert.ok(avatar >= 0 && avatar < after && after < sim.indexOf('for (var j = 0u; j < P.carCount; j++)'))
  assert.ok(sim.slice(avatar, after).trimEnd().endsWith('return; }'), 'the avatar branch ends in return')
  // Sign conventions in world space: a car facing east (+x) has its left at -z (north). On a left lock its
  // nose swings north at once, so someone just north of the straight corridor a metre ahead is reached
  // within 1.5 m while their mirror image to the south never is; reversing on the same lock swings the nose
  // south, into someone beside the front-right corner, whom driving on only meets again most of a circle
  // later.
  const c: CarState = { x: 100, z: 100, heading: Math.PI / 2, speed: 0, ...SEDAN, curvature: FULL_LOCK }
  const [ux, uz] = [100 + SEDAN.halfLength + 1, 100 - 1.9]
  assert.equal(shaderGaps(ux, uz, { ...c, curvature: 0 })[0], Infinity)
  const north = shaderGaps(ux, uz, c)[0]
  assert.ok(north >= 0 && north < 1.5, `${north}`)
  assert.equal(shaderGaps(ux, 200 - uz, c)[0], Infinity)
  const [south, again] = [shaderGaps(100 + 1.5, 100 + 1.6, c)[1], shaderGaps(100 + 1.5, 100 + 1.6, c)[0]]
  assert.ok(south >= 0 && south < 0.5, `${south}`)
  assert.ok(again > (3 / 2) * Math.PI / FULL_LOCK, `${again}`)
})

test('First-Law corridor: straight, it is the bumper distance across the widened width, out to the range', () => {
  const hw = SEDAN.halfWidth, hl = SEDAN.halfLength, half = hw + KERNEL.corridor
  for (let s = 0; s <= KERNEL.range; s += 0.37) {
    for (const left of [-half, -0.5, 0, 0.7, half]) {
      assert.ok(Math.abs(gapOn(hl + s, left, 0) - s) < 1e-12, `left=${left} s=${s}`)
      assert.ok(Math.abs(corridorGap(hl + s, left, hw, hl, 0, AXLE) - s) < 1e-12, `reversing: left=${left} s=${s}`)
    }
    assert.equal(gapOn(hl + s, half + 1e-3, 0), -1)
    assert.equal(gapOn(hl + s, -half - 1e-3, 0), -1)
  }
  assert.equal(gapOn(hl + KERNEL.range + 0.01, 0, 0), -1, 'beyond range')
  assert.equal(gapOn(-hl - 5, 0, 0), -1, 'behind is not ahead')
  // Against the car, inside the widened footprint: 0 m whichever way it moves, straight or turning.
  for (const [u, left] of [[0, 0], [1, 1.2], [-2.2, -1.3], [hl, half], [-hl, -half], [hl, 0]]) {
    for (const k of [0, 0.1, -FULL_LOCK]) {
      assert.equal(gapOn(u, left, k), 0, `(${u}, ${left}) k=${k}`)
      assert.equal(corridorGap(-u, left, hw, hl, k, AXLE), 0, `reversing (${u}, ${left}) k=${k}`)
    }
  }
  assert.equal(gapOn(1, half + 0.1, 0), -1, 'beside the car beyond the margin is not in its way')
  // Straight is the limit of a gentle curve, with no jump at the 1e-6 1/m switch.
  for (const k of [1e-7, 0.99e-6, 1.01e-6, -1e-5, 1e-4]) assert.ok(Math.abs(gapOn(hl + 20, 0.4, k) - 20) < 2e-3, `k=${k}: ${gapOn(hl + 20, 0.4, k)}`)
})

test('First-Law corridor: in a turn the widened footprint is swept about the rear-axle turn centre', () => {
  const hw = SEDAN.halfWidth, hl = SEDAN.halfLength, R = 1 / FULL_LOCK
  const within = (g: number, lo: number, hi: number) => g >= lo && g <= hi
  // At full lock left the nose swings left at once: someone ahead-left, off the straight corridor, is
  // reached within 1.5 m, and so is someone beside the front-left door.
  assert.equal(gapOn(hl + 1, 1.9, 0), -1)
  assert.ok(within(gapOn(hl + 1, 1.9, FULL_LOCK), 0, 1.5))
  assert.ok(within(gapOn(1, 1.6, FULL_LOCK), 0, 0.5))
  // Nearer the turn centre than the inner side ever comes: never reached.
  assert.equal(gapOn(-2, 1.6, FULL_LOCK), -1)
  // The rear axle's quarter-turn point is swept by the body well before the axle gets there.
  assert.ok(within(gapOn(-AXLE + R, R, FULL_LOCK), 0, (Math.PI / 2) * R - 1))
  assert.equal(gapOn(hl + 20, 0, FULL_LOCK), -1, 'straight ahead is off a tight path')
  // Gentle curvature: the bumper leads the rear axle, so the path's offset is k·s²/2 plus
  // (halfLength + wheelbase/2)·k·s; the parabola alone is not the path. The distance is the rear axle's
  // travel, a little more than s for someone that far to the side.
  const k = 0.05, s = 12, bend = (k * s * s) / 2, lead = (hl + AXLE) * k * s
  assert.equal(gapOn(hl + s, bend, k), -1)
  const g = gapOn(hl + s, bend + lead, k)
  // Car at the origin facing +z: its left is +x, so (u, left) is world (left, u).
  const want = sweep(bend + lead, hl + s, { x: 0, z: 0, heading: 0, speed: 0, ...SEDAN, curvature: k }, 1)
  assert.ok(g <= want && g > want - 0.0021 && g > s, `${g} vs ${want}`)
  assert.equal(gapOn(hl + s, -(bend + lead), -k), g, 'a right turn mirrors it')
  // Reversing on a left lock swings the nose right, into someone beside the front-right corner.
  assert.ok(within(corridorGap(-1.5, -1.6, hw, hl, FULL_LOCK, AXLE), 0, 0.5))
  // A person the car only reaches after most of a full circle at full lock is still inside the range.
  const around = gapOn(-hl - 0.6, 0, FULL_LOCK)
  assert.ok(within(around, Math.PI * R, KERNEL.range), `${around}`)
  // 0.1 mm beyond the orbit of the footprint's farthest corner (front, outer side): never reached, even
  // though a whole circle fits in the range at this lock.
  const half = hw + KERNEL.corridor, reach = hl + AXLE, grow = 1 + 1e-4 / Math.hypot(reach, R + half)
  const [cu, cl] = [-AXLE + reach * grow, R - (R + half) * grow]
  assert.equal(gapOn(cu, cl, FULL_LOCK), -1)
  assert.equal(sweep(cl, cu, { x: 0, z: 0, heading: 0, speed: 0, ...SEDAN, curvature: FULL_LOCK }, 1), Infinity)
  // Far beyond any real lock the turn centre lies inside the widened footprint, and the maths still
  // holds: someone behind the car on the far side of the centre is met through the back edge there,
  // 0.3 rad of turn before reaching it at (-halfLength, 1.2 m left).
  const kk = 1.5, rr = 1 / kk, psiC = Math.atan2(-hl + AXLE, rr - 1.2), rho = Math.hypot(-hl + AXLE, rr - 1.2)
  const pu = -AXLE + rho * Math.sin(psiC + 0.3), pl = rr - rho * Math.cos(psiC + 0.3)
  const tight = gapOn(pu, pl, kk)
  assert.ok(pu < -hl && Math.abs(tight - 0.3 / kk) < 1e-9, `${tight}`)
  const swept = sweep(pl, pu, { x: 0, z: 0, heading: 0, speed: 0, ...SEDAN, curvature: kk }, 1)
  assert.ok(tight <= swept + 1e-9 && tight > swept - 0.0021, `${tight} vs ${swept}`)
})

test('corridorGap matches a brute-force drive of the bicycle model, for random cars and people, both ways', () => {
  const rng = createRng(20260926)
  // Beyond full lock too: a turn centre inside the widened footprint (k > 1/half) is still exact.
  const ks = [0, 1e-6, -3e-6, 1e-4, -1e-3, 0.02, -0.05, 0.1, -0.15, FULL_LOCK, -FULL_LOCK, 0.9, -1.6]
  let hits = 0, misses = 0, skipped = 0
  for (let n = 0; n < 800; n++) {
    const c: CarState = {
      x: rng() * 480, z: rng() * 480, heading: (rng() * 2 - 1) * Math.PI, speed: 0,
      halfWidth: rng() < 0.5 ? 0.92 : 1.05, halfLength: rng() < 0.5 ? 2.3 : 2.6,
      curvature: n % 2 ? ks[(n >> 1) % ks.length] : (rng() * 2 - 1) * FULL_LOCK,
    }
    const dir = rng() < 0.5 ? 1 : -1
    const [px, pz] = n % 4 === 3 ? [c.x + (rng() * 2 - 1) * 36, c.z + (rng() * 2 - 1) * 36] : nearSwept(c, dir, rng)
    const got = shaderGaps(px, pz, c)[dir > 0 ? 0 : 1], want = sweep(px, pz, c, dir)
    const where = `car ${JSON.stringify(c)} person (${px}, ${pz}) dir ${dir}: ${got} vs ${want}`
    // Contacts that only graze the footprint, or land on the range, may legitimately go either way; so may
    // someone the footprint has only just left (the shader reads 0: they are against it).
    if (grazing(px, pz, c, dir) || Math.abs(Math.min(got, want) - KERNEL.range) < 0.01 || (got === 0 && want > 0 && justLeft(px, pz, c, dir))) {
      skipped++
      continue
    }
    if (want === Infinity) {
      assert.equal(got, Infinity, where)
      misses++
      continue
    }
    hits++
    // The drive steps 2 mm at a time, so it stops up to 2 mm past the true first contact.
    assert.ok(got <= want + 1e-9 && got > want - 0.0021, where)
  }
  assert.ok(hits > 250 && misses > 100 && skipped < 25, `${hits} contacts, ${misses} clear, ${skipped} skipped`)
})

test('the corridor reach the shader checks first never cuts off a contact, and is tight', () => {
  const rng = createRng(77)
  const ks = [0, 1e-6, 1e-4, 0.01, 1 / 15, 0.15, FULL_LOCK, 0.9, 1.6]
  let contacts = 0
  for (let n = 0; n < 6000; n++) {
    const c: CarState = {
      x: rng() * 480, z: rng() * 480, heading: (rng() * 2 - 1) * Math.PI, speed: 0,
      halfWidth: rng() < 0.5 ? 0.92 : 1.05, halfLength: rng() < 0.5 ? 2.3 : 2.6, curvature: (n % 3 ? 1 : -1) * ks[n % ks.length],
    }
    const dir = rng() < 0.5 ? 1 : -1
    const [px, pz] = nearSwept(c, dir, rng)
    if (shaderGaps(px, pz, c, 0, true)[dir > 0 ? 0 : 1] === Infinity) continue
    contacts++
    assert.ok(Math.hypot(px - c.x, pz - c.z) <= corridorReach(c) - 0.01 + 1e-9, `car ${JSON.stringify(c)} person (${px}, ${pz}) dir ${dir}`)
  }
  assert.ok(contacts > 2500, `${contacts}`)
  // Straight it is the range plus the car; a full lock stays within about half of that.
  const straight = { ...car(0, 0), ...SEDAN }
  assert.ok(Math.abs(corridorReach(straight) - Math.hypot(SEDAN.halfLength + KERNEL.range, SEDAN.halfWidth + KERNEL.corridor) - 0.01) < 1e-9)
  assert.ok(corridorReach({ ...straight, curvature: FULL_LOCK }) < 17)
  assert.equal(corridorReach({ ...straight, curvature: NaN }), corridorReach(straight))
})

test('the GPU corridor is the avatar corridor Fleet measures on the CPU (vehicles.ts corridorDistance)', async () => {
  const { corridorDistance, CAR } = await import('../07_Execute_Actions/vehicles.ts')
  assert.equal(Math.tan(CAR.maxSteer) / CAR.wheelbase, FULL_LOCK)
  assert.equal(CAR.wheelbase / 2, AXLE)
  assert.deepEqual({ halfWidth: CAR.halfWidth, halfLength: CAR.halfLength }, SEDAN)
  const rng = createRng(4242)
  let inside = 0, agreed = 0, skipped = 0, left = 0
  for (let n = 0; n < 40000; n++) {
    const kind = rng()
    const c: CarState = {
      x: rng() * 480, z: rng() * 480, heading: (rng() * 2 - 1) * Math.PI, speed: 0, ...SEDAN,
      curvature: kind < 0.1 ? 0 : kind < 0.3 ? (rng() - 0.5) * 2e-3 : kind < 0.4 ? (rng() - 0.5) * 2e-5 : (rng() * 2 - 1) * FULL_LOCK,
    }
    const dir = n % 2 ? -1 : 1
    const [px, pz] = n % 3 === 0 ? [c.x + (rng() * 2 - 1) * 36, c.z + (rng() * 2 - 1) * 36] : nearSwept(c, dir, rng)
    const cpu = corridorDistance(px, pz, c.x, c.z, c.heading, c.curvature, dir)
    const gpu = shaderGaps(px, pz, c)[dir > 0 ? 0 : 1]
    if (cpu === gpu || Math.abs(cpu - gpu) < 1e-6) {
      agreed++
      if (cpu !== Infinity) inside++
      continue
    }
    // The one intended difference: the shader rounds a contact its f32 angles may put just behind now
    // to now, so for someone the footprint has only just left it reads 0 where the CPU reads the next
    // contact. Driving the other way, the CPU itself must reach them within HAIR.
    if (gpu === 0 && corridorDistance(px, pz, c.x, c.z, c.heading, c.curvature, dir > 0 ? -1 : 1) <= HAIR + 1e-9) {
      left++
      continue
    }
    const where = `car ${JSON.stringify(c)} person (${px}, ${pz}) dir ${dir}: cpu ${cpu} gpu ${gpu}`
    assert.ok(grazing(px, pz, c, dir) || Math.abs(Math.min(cpu, gpu) - KERNEL.range) < 1e-6, where)
    skipped++
  }
  assert.ok(inside > 15000 && skipped < 10 && left < 40, `${inside} contacts of ${agreed} agreed, ${skipped} grazing, ${left} just left`)
})

test('in f32, a contact a hair behind is now, even where TAU - hair rounds to TAU', () => {
  // Wide enough for WGSL's loosest atan2 (the loose built-ins test fails at 1 mm), and at most a
  // centimetre: a wider hair would hold a car for someone it has already left behind.
  assert.ok(HAIR > 0 && HAIR <= 0.01, `${HAIR}`)
  const F = Math.fround
  const { clockwise } = transpile(['clockwise'], { f32: true })
  for (const k of [1.01e-6, 1e-5, 1e-4, 1e-3, 0.05, FULL_LOCK].map(F)) {
    for (const a1 of [F(3.7 * k), F(-0.4), F(2.9)]) {
      for (const behind of [1e-6, 1e-4, 0.4 * HAIR]) {
        const a0 = F(a1 - F(behind * k))
        if (a0 === a1) continue // below f32 resolution at this angle: already equal
        assert.equal(clockwise(a0, a1, k), 0, `k=${k} a1=${a1}: ${behind} m behind`)
      }
      // Ahead by a little is that little; behind by more than the hair is most of a turn away.
      const ahead = F(a1 + F(0.05 * k)), behind = F(a1 - F(3 * HAIR * k))
      assert.ok(Math.abs(clockwise(ahead, a1, k) - (ahead - a1)) <= 1e-6 * Math.abs(a1) + 1e-12, `k=${k} a1=${a1}: ahead`)
      if (behind !== a1) assert.ok(clockwise(behind, a1, k) > 3, `k=${k} a1=${a1}: well behind`)
    }
  }
})

/**
 * Checks corridorGap computed by `gap` (f32, perhaps with loose built-ins) against the exact maths (f64
 * transpile) to within `tolerance` metres: people 0.1 µm to 1 mm outside the widened footprint's front,
 * back, sides and corners, and anywhere within 36 m, on locks from nearly straight (where an angle of
 * k·(a few metres) is divided back by k) to full lock, driving on and reversing. Either answer is right
 * only where a millimetre more or less footprint, the range, or the just-left rounding decides.
 */
function checkF32(gap: (...args: number[]) => number, tolerance: number, seed: number) {
  const F = Math.fround
  const hw = F(SEDAN.halfWidth), hl = F(SEDAN.halfLength), half = hw + KERNEL.corridor
  const rng = createRng(seed)
  const ks = [1.01e-6, 3e-6, 1e-5, 3e-5, 1e-4, 3e-4, 1e-3, 3e-3, 0.02, 0.1, FULL_LOCK]
  let edge = 0, anywhere = 0, skipped = 0, worst = 0
  for (const k of ks.flatMap((x) => [F(x), F(-x)])) {
    for (const axle of [F(-AXLE), F(AXLE)]) {
      for (let n = 0; n < 480; n++) {
        const out = 10 ** (-7 + 4 * rng()), along = rng() * 2 - 1, end = rng() < 0.5 ? 1 : -1, side = rng() < 0.5 ? 1 : -1
        const kind = n % 2 ? 3 : (n >> 1) % 3
        const [u, left] = kind === 0 ? [end * (hl + out), along * half] // front or back
          : kind === 1 ? [along * hl, side * (half + out)] // a side
            : kind === 2 ? [end * (hl + out), side * (half + out)] // a corner
              : [(rng() * 2 - 1) * 36, (rng() * 2 - 1) * 36]
        const pu = F(u), pl = F(left)
        const want = corridorGap(pu, pl, hw, hl, k, axle), got = gap(pu, pl, hw, hl, k, axle)
        if (want < 0 ? got < 0 : got >= 0 && Math.abs(got - want) <= tolerance) {
          if (want >= 0) {
            if (kind < 3) edge++
            else anywhere++
            worst = Math.max(worst, Math.abs(got - want))
          }
          continue
        }
        const grown = (g: number) => corridorGap(pu, pl, hw + g, hl + g, k, axle)
        const small = grown(-1e-3), big = grown(1e-3)
        const back = corridorGap(-pu, pl, hw, hl, k, -axle) // driving the other way
        const either = (small < 0 ? big >= 0 : Math.abs(small - big) > 0.05) ||
          Math.abs(Math.max(got, want) - KERNEL.range) < 0.01 ||
          (back >= HAIR / 4 && back <= 2 * HAIR)
        assert.ok(either, `k=${k} axle=${axle} person (${pu}, ${pl}): f32 ${got} vs exact ${want}`)
        skipped++
      }
    }
  }
  return { edge, anywhere, skipped, worst }
}

test('computed in f32 as the GPU does, corridorGap still meets everyone at the bumpers and corners, and anyone near', () => {
  const r = checkF32(transpile(['clockwise', 'corridorGap'], { f32: true }).corridorGap, 2e-3, 3232)
  assert.ok(r.edge > 2500 && r.anywhere > 150 && r.skipped < 300, JSON.stringify(r))
})

test('with built-ins as loose as WGSL allows (atan2 4096 ULP, asin 6.77e-5 rad), the corridor is still right to 5 cm', () => {
  // An angle is k·(distance), so an error of δ rad is δ/k metres: asin's absolute allowance would be
  // metres to tens of metres on a nearly straight car, atan2's 4096 ULP (relative) at most about
  // 2·2⁻¹¹·35 m ≈ 3.4 cm. KERNEL.standoff (1.5 m) absorbs that.
  const r = checkF32(transpile(['clockwise', 'corridorGap'], { f32: true, loosest: true }).corridorGap, 0.05, 6464)
  assert.ok(r.edge > 2500 && r.anywhere > 150 && r.skipped < 300, JSON.stringify(r))
})

test('a car turning right round a corner does not sense the people waiting on it', () => {
  // traffic.ts turns right on a Bézier from ENTRY = 7.5 m before the intersection centre in the lane
  // TRAFFIC.laneOffset right of the centreline: close to a quarter circle of radius 7.5 − laneOffset for
  // the rear axle. Intersection centre at the origin; the car drives +z (its right is -x), turning to -x.
  const R = 7.5 - TRAFFIC.laneOffset
  const start: CarState = { x: -TRAFFIC.laneOffset, z: -7.5 + AXLE, heading: 0, speed: TRAFFIC.turnSpeed, ...SEDAN, curvature: -1 / R }
  const corner = -CITY.lane // where people wait to cross, on the corner being turned round
  for (let t = 0; t <= (Math.PI / 2) * R; t += 0.25) {
    const c = { ...start, ...poseAfter(start, 1, t) }
    for (let dx = -1; dx <= 1; dx += 0.25) {
      for (let dz = -1; dz <= 1; dz += 0.25) {
        if (Math.hypot(dx, dz) <= 1) assert.equal(shaderGaps(corner + dx, corner + dz, c)[0], Infinity, `${t} m in: (${corner + dx}, ${corner + dz})`)
      }
    }
  }
  // Nor the far sidewalk of the street it turns into, where a parabola k·s²/2 from the bumper lands
  // about 10 m ahead; someone standing in the exit lane is sensed.
  for (let x = -20; x <= -8; x += 0.5) {
    for (let z = CITY.roadHalf + 0.8; z <= CITY.pitch / 2 - CITY.lotHalf; z += 0.5) assert.equal(shaderGaps(x, z, start)[0], Infinity, `(${x}, ${z})`)
  }
  const exit = shaderGaps(-12, -TRAFFIC.laneOffset, start)[0]
  assert.ok(exit > 5 && exit < (Math.PI / 2) * R + 2, `${exit}`)
})

test('the corridor covers the whole First-Law envelope a car can need', () => {
  // Anyone the safety nudge would push from beside the car is already inside the widened footprint.
  assert.ok(KERNEL.corridor >= BODY_PAD)
  // A car at the city speed limit (with margin) can stop, with standoff, inside the sensing range.
  const vMax = TRAFFIC.speedLimit * 1.25
  assert.ok(stoppingDistance(vMax) + KERNEL.standoff < KERNEL.range)
  // A lane-centred car on a straight road does not sense people on either sidewalk (right-hand traffic:
  // the near sidewalk is on its right).
  const near = CITY.roadHalf + 0.3 - TRAFFIC.laneOffset, far = CITY.roadHalf + 0.3 + TRAFFIC.laneOffset
  for (const u of [0, 5, 10, 25]) {
    assert.equal(gapOn(u, -near, 0), -1)
    assert.equal(gapOn(u, far, 0), -1)
  }
})

// ---------------------------------------------------------------- the operator's summons

/** Summon slot `k` as the shader reads it: (at.x, at.z, agent, flags). */
function summonSlot(device: MockDevice, k: number): [number, number, number, number] {
  const { f, u, at } = params(device, 'crowd.params')
  const o = at('summons') + k * 4
  return [f[o], f[o + 1], u[o + 2], u[o + 3]]
}

test('summons: the shader constants are the recruiter\'s, and the uniform carries one slot per possible recruit', () => {
  const k = constants(MODULE)
  assert.equal(k.get('SUMMON_SLOTS'), RECRUIT_SLOTS)
  assert.equal(k.get('SUMMON_STOP'), INTERVIEW_DISTANCE)
  assert.equal(k.get('SUMMON_ACCEPT'), SUMMON_ACCEPT)
  assert.equal(k.get('TETHER_PACE'), TETHER_PACE)
  assert.ok(TETHER_PACE < PEDESTRIAN_MAX_SPEED, 'never faster than the First Law sensing assumes')
  assert.equal(k.get('ACT_ROUTINE'), ACTIVITY.routine)
  assert.equal(k.get('ACT_WAITING'), ACTIVITY.waiting)
  assert.equal(k.get('ACT_CROSSING'), ACTIVITY.crossing)
  assert.equal(k.get('ACT_STEPPING_BACK'), ACTIVITY.steppingBack)
  assert.equal(k.get('ACT_COMING'), ACTIVITY.coming)
  assert.equal(k.get('ACT_INTERVIEWING'), ACTIVITY.interviewing)
})

test('summons: only a real pedestrian at a spot the GPU can hold takes a slot, each once, at most RECRUIT_SLOTS; the rest stay empty', async () => {
  const { device, crowd } = await simRig()
  crowd.step(simInput())
  for (let k = 0; k < RECRUIT_SLOTS; k++) assert.deepEqual(summonSlot(device, k), [0, 0, 0, 0], 'no summons: every slot empty')
  crowd.step(simInput({
    summons: [
      { agent: 5, x: 101.5, z: 102.25 },
      { agent: 0, x: 1, z: 1 }, // the player's own body
      { agent: AGENTS, x: 1, z: 1 }, // out of range
      { agent: 2.5, x: 1, z: 1 },
      { agent: 7, x: NaN, z: 1 },
      { agent: 8, x: 1, z: Infinity },
      { agent: 9, x: 1e39, z: 1 }, // finite here, Infinity in f32
      { agent: 5, x: 3, z: 3 }, // asked twice: the first stands
      { agent: AGENTS - 1, x: -4, z: 6, tethered: true },
    ],
  }))
  assert.deepEqual(summonSlot(device, 0), [101.5, 102.25, 5, 1])
  assert.deepEqual(summonSlot(device, 1), [-4, 6, AGENTS - 1, 3], 'tethered (Active): bit 1 set')
  for (let k = 2; k < RECRUIT_SLOTS; k++) assert.deepEqual(summonSlot(device, k), [0, 0, 0, 0], `slot ${k}`)
  // More than the slots: the first RECRUIT_SLOTS valid ones.
  crowd.step(simInput({ summons: Array.from({ length: RECRUIT_SLOTS + 3 }, (_, j) => ({ agent: 10 + j, x: j, z: -j })) }))
  for (let k = 0; k < RECRUIT_SLOTS; k++) assert.deepEqual(summonSlot(device, k), [k, -k, 10 + k, 1].map(Math.fround))
  // Never a word past struct Params, however many are asked for (packed into a larger buffer, the tail stays zero).
  const big = new ArrayBuffer(PARAMS_SIZE + 256)
  packSimParams(new Float32Array(big), new Uint32Array(big), 1, AGENTS, simInput({ summons: Array.from({ length: RECRUIT_SLOTS + 8 }, (_, j) => ({ agent: 10 + j, x: 1 + j, z: 1 })) }))
  assert.ok(new Uint32Array(big, PARAMS_SIZE).every((w) => w === 0), 'nothing written beyond the uniform')
  // And gone the step after they are released.
  crowd.step(simInput({ summons: [] }))
  for (let k = 0; k < RECRUIT_SLOTS; k++) assert.deepEqual(summonSlot(device, k), [0, 0, 0, 0])
})

test('the readback keeps the worker\'s own copy of where everyone stands and what they are doing', async () => {
  const { device, crowd } = await simRig()
  const pos = device.buffer('crowd.pos'), pose = device.buffer('crowd.pose')
  device.onDispatch = (ep) => {
    if (ep !== 'simulate') return
    const p = pos.f32(), q = pose.f32()
    p[4 * 3] = 12.5; p[4 * 3 + 2] = -7.25
    p[4 * (AGENTS - 1)] = 400; p[4 * (AGENTS - 1) + 2] = 401
    q[4 * 3 + 3] = ACTIVITY.coming
    q[4 * (AGENTS - 1) + 3] = ACTIVITY.interviewing
  }
  crowd.step(simInput())
  await device.flush()
  const r = crowd.readout!
  assert.equal(r.xz.length, 2 * AGENTS)
  assert.deepEqual([r.xz[6], r.xz[7], r.xz[2 * (AGENTS - 1)], r.xz[2 * (AGENTS - 1) + 1]], [12.5, -7.25, 400, 401])
  assert.equal(r.activity.length, AGENTS)
  assert.equal(r.activity[3], ACTIVITY.coming)
  assert.equal(r.activity[AGENTS - 1], ACTIVITY.interviewing)
  assert.equal(r.activity[4], ACTIVITY.routine)
  // The page's frame is a separate copy: taking it (and the page writing into it) cannot move the worker's.
  const frame = crowd.takeFrame()!
  frame.fill(NaN)
  assert.equal(r.xz[6], 12.5)
})

test('simulate: a summons comes after the safety reflexes, is taken only on the sidewalk within reach, and never sends anyone into the road', () => {
  const sim = flat('simulate')
  const at = (line: string) => {
    const k = sim.indexOf(line)
    assert.ok(k >= 0, line)
    return k
  }
  // The slot lookup: agent 0 (the player's body, who returned long before) marks an empty slot.
  for (const line of [
    'for (var s = 0u; s < SUMMON_SLOTS; s++) { let q = P.summons[s]; if (q.agent == i && q.flags != 0u) { summoned = true; tethered = (q.flags & 2u) != 0u; at = q.at; } }',
    'summoned = summoned && !nonFinite(at);',
    // Taken only from someone on the sidewalk, not mid-crossing, within reach.
    'if (!road && crossing != CROSS_WALK && distance(me, at) <= SUMMON_ACCEPT) { b.b.w = 1.0; crossing = CROSS_NONE; b.d = vec4f(0.0); } else { summoned = false; }',
    // Released: back to their day from their own block's corner, never mid-street.
    'if (!summoned && b.b.w > 0.0) { b.b.w = 0.0; b.a = vec4f(cornerOf(me), b.a.z, b.a.w); crossing = CROSS_NONE; }',
    // Coming over, slowing near; stopping at SUMMON_STOP; following if the operator walks off.
    'if (b.b.w < 1.5 && dist <= SUMMON_STOP) { b.b.w = 2.0; } else if (b.b.w > 1.5 && dist > SUMMON_STOP * 1.5) { b.b.w = 1.0; }',
    // Talking: a conversational distance held against the crowd's jostling, with a dead band; facing the operator;
    // stepping back as fast as the operator walks towards them.
    'if (b.b.w > 1.5) { let gap = dist - SUMMON_STOP; desired = dirTo(me, at) * select(0.0, clamp(gap * 4.0, -2.4, 0.6), abs(gap) > 0.2); faceDir = d; activity = ACT_INTERVIEWING; }',
    // The standoff binds the step actually taken: inside SUMMON_STOP, nothing of it carries them towards the operator.
    'if (asked) { let to = at - me; let dd = length(to); if (dd > 1e-4 && dd < SUMMON_STOP) { let u = to / dd; let inward = dot(nv, u); if (inward > 0.0) { nv -= u * inward; } } }',
    // Tethered and fallen behind: hurrying, never past TETHER_PACE; someone walking over keeps their own pace.
    // The way to walk: the flow field's direction under their feet (round the buildings) when it has one and the operator
    // is beyond the last stretch; the straight line otherwise, so they arrive and stop as before.
    'let pace = select(b.a.z, max(b.a.z, TETHER_PACE * clamp((dist - SUMMON_STOP) / 2.0, 0.0, 1.0)), tethered); let flow = flowAt(me); let way = select(dirTo(me, at), flow, dot(flow, flow) > 0.5 && dist > 4.0 * SUMMON_STOP); desired = way * pace * clamp(dist - SUMMON_STOP, 0.25, 1.0); activity = ACT_COMING; }',
    // The kerb, coming or talking: someone on the road heads back to it; a step that would leave it is not taken.
    'if (road) { desired = curbwards(me) * b.a.z; } else { if (onRoad(me + vec2f(desired.x, 0.0) * 0.5)) { desired.x = 0.0; } if (onRoad(me + vec2f(0.0, desired.y) * 0.5)) { desired.y = 0.0; } } } else {',
    'ps.w = activity; pose[i] = ps;',
    // The kerb binds the step actually taken (after separation and the cap), not only the step asked for; a recruit is
    // not carried along by passing flows.
    'if (cnt > 0.0 && dot(desired, desired) > 0.01 && !asked && !working) {',
    'if (asked && !road) { if (onRoad(me + vec2f(nv.x * dt, 0.0))) { nv.x = 0.0; } if (onRoad(me + vec2f(0.0, nv.y * dt))) { nv.y = 0.0; } } let next = me + nv * dt;',
  ]) at(line)
  assert.ok(at('} else if (summoned) { asked = true;') > 0, 'only the summons arm binds the step to the kerb (never the step back from a car)')
  assert.ok(at('if (sp > 3.0) { nv *= 3.0 / sp; }') < at('if (asked && !road) {'), 'after the cap: the step actually taken')
  assert.ok(at('if (sp > 3.0) { nv *= 3.0 / sp; }') < at('if (asked) { let to = at - me;'), 'the standoff clip binds the capped step')
  assert.ok(at('if (asked) { let to = at - me;') < at('if (asked && !road) {'), 'the kerb clip comes last: it has the final word')  // Order: the car loop (sensing, the nudge, the Reflex save) first; then freeze and step back, which outrank a summons;
  // then the summons; then the ordinary day. The summons is an arm of that chain, never an early return.
  const cars = at('for (var j = 0u; j < P.carCount; j++)')
  const freeze = at('if (b.c.w > 0.0) { b.c.w -= dt; activity = ACT_STEPPING_BACK; }')
  const retreat = at('} else if (b.c.z > 0.0) { b.c.z -= dt; desired = b.c.xy * b.a.w;')
  const summon = at('} else if (summoned) {')
  const routine = at('let goal = b.a.xy;')
  assert.ok(cars < freeze && freeze < retreat && retreat < summon && summon < routine)
  const arm = sim.slice(summon, routine)
  assert.ok(!/\breturn\b/.test(arm), 'no early return: the stagger, the velocity cap, containment and the Ring-0 check still run')
  assert.ok(!/\bme\s*=|\bnv\s*=|\bb\.c\s*=|pos\[i\]\s*=/.test(arm), 'the arm only asks for a velocity; it never places anyone or touches the reflexes')
  // The velocity it asks for is capped like everyone's, and the move is contained like everyone's.
  assert.ok(sim.indexOf('if (sp > 3.0) { nv *= 3.0 / sp; }') > summon)
  assert.ok(sim.indexOf('me = clampCity(held);') > summon)
  // Never a new way to start a crossing.
  assert.equal(sim.split('crossing = CROSS_WALK').length, 2)
})

test('a released recruit resumes from their own block\'s corner, reachable along the sidewalk from anywhere on it', () => {
  assert.equal(
    functions(MODULE).get('cornerOf')!.body.replace(/\s+/g, ' '),
    '{ let km = nearestLines(p); let o = streetOffsets(p); return cornerPos(km.x, km.y, select(-1.0, 1.0, o.x >= 0.0), select(-1.0, 1.0, o.y >= 0.0)); }',
  )
  // The same arithmetic on the CPU (WGSL round() is half-to-even; no sidewalk point sits on a half).
  const cornerOf = (x: number, z: number): [number, number] => {
    const k = Math.round(x / CITY.pitch), m = Math.round(z / CITY.pitch)
    const ox = x - k * CITY.pitch, oz = z - m * CITY.pitch
    return [k * CITY.pitch + (ox >= 0 ? 1 : -1) * CITY.lane, m * CITY.pitch + (oz >= 0 ? 1 : -1) * CITY.lane]
  }
  const rng = createRng(77)
  let checked = 0
  for (let n = 0; n < 4000; n++) {
    // Anywhere on a sidewalk: between the kerb and the lot edge on one axis, anywhere along the block on the other.
    const across = (CITY.roadHalf + 0.01 + rng() * (CITY.pitch / 2 - CITY.roadHalf - 0.02 - (CITY.pitch / 2 - 7))) * (rng() < 0.5 ? -1 : 1)
    const along = (rng() * 2 - 1) * (CITY.pitch / 2 - 0.01)
    const k = 1 + Math.floor(rng() * 5), m = 1 + Math.floor(rng() * 5)
    const [x, z] = rng() < 0.5 ? [k * CITY.pitch + across, m * CITY.pitch + along] : [k * CITY.pitch + along, m * CITY.pitch + across]
    if (onRoad(x, z)) continue
    const [cx, cz] = cornerOf(x, z)
    assert.ok(!onRoad(cx, cz), 'the corner is on the sidewalk')
    assert.ok(sidewalkPath(x, z, cx, cz), `(${x.toFixed(2)}, ${z.toFixed(2)}) → (${cx}, ${cz}) crosses a street`)
    checked++
  }
  assert.ok(checked > 3000)
})

test('a street window: the shader is compiled for its corner and widths, and its segments ride in Params.streets every step', async () => {
  const window = cityStreetGrid()
  window.originX = 2960; window.originZ = 2560; window.roadHalf = 3.3; window.lane = 4.9
  window.h.fill(0, 0, 3); window.h[3] = 1; window.v[5] = 1
  const g = geometryOf(window)
  assert.deepEqual(g, { originX: 2960, originZ: 2560, roadHalf: 3.3, lane: 4.9, spawnK: 3, spawnM: 0 })
  const code = crowdShader(AGENTS, undefined, g)
  const c = constants(code)
  assert.deepEqual([c.get('CITY_ORIGIN_X'), c.get('CITY_ORIGIN_Z'), c.get('CITY_ROAD_HALF'), c.get('CITY_LANE'), c.get('SPAWN_K'), c.get('SPAWN_M')], [2960, 2560, 3.3, 4.9, 3, 0])
  assert.deepEqual([c.get('GRID_ORIGIN_X'), c.get('GRID_ORIGIN_Z')], [2960 - 8, 2560 - 8], 'the hash grid moves with the window')
  assert.equal(c.get('CITY_BLOCKS'), CITY.blocks, 'the window is the city\'s size')
  assert.equal(c.get('STREET_VEC4S'), STREET_VEC4S)
  // The city's own module: at the origin, with the city's widths.
  const city = constants(MODULE)
  assert.deepEqual([city.get('CITY_ORIGIN_X'), city.get('CITY_ORIGIN_Z'), city.get('CITY_ROAD_HALF'), city.get('CITY_LANE'), city.get('GRID_ORIGIN_X')], [0, 0, CITY.roadHalf, CITY.lane, -8])
  // The worker's crowd over the window: the module is the window's, and the words land after the summons, every substep.
  const device = new MockDevice()
  const crowd = await CrowdSim.create(device as unknown as GPUDevice, AGENTS, null, window)
  assert.equal(device.shader, code)
  const words = packStreets(window)
  const read = () => [...params(device, 'crowd.params').u.subarray(PARAMS_STREETS / 4, PARAMS_STREETS / 4 + STREET_VEC4S * 4)]
  assert.deepEqual(read(), [...words], 'the spawn pass sees the window')
  crowd.step(simInput())
  assert.deepEqual(read(), [...words])
  assert.equal(words[0] & 3, 0, 'segment h(0, 0) dropped'); assert.equal((words[0] >>> 6) & 3, 1, 'segment h(3, 0) walked, not driven')
  // The city's rig packs every segment.
  const { device: cityDevice, crowd: cityCrowd } = await simRig()
  cityCrowd.step(simInput())
  const cityWords = [...params(cityDevice, 'crowd.params').u.subarray(PARAMS_STREETS / 4, PARAMS_STREETS / 4 + STREET_VEC4S * 4)]
  assert.deepEqual(cityWords, [...packStreets(cityStreetGrid())])
  assert.ok(cityWords.slice(0, 34).every((w) => w === 0xffffffff), 'every bit of every segment')
  assert.throws(() => packSimParams(new Float32Array(PARAMS_SIZE / 4), new Uint32Array(PARAMS_SIZE / 4), 1, AGENTS, simInput(), new Uint32Array(3)), RangeError)
  // The shader gates its corner graph on the field: no block edge without its segment, no crosswalk without its corner.
  const next = functions(MODULE).get('nextCorner')!.body.replace(/\s+/g, ' ')
  assert.ok(next.includes('let alongX = walkable(hSeg(min(k, nk), m));') && next.includes('let acrossX = cornerExists(k, m, -sx, sz);'))
  assert.ok(next.includes('if (r < 0.38 && alongX)') && next.includes('if (r < 0.76 && alongZ)') && next.includes('if (r < 0.88 && acrossX)'), 'the same dice as before')
  assert.ok(functions(MODULE).get('isCrossing')!.body.includes('roadV(km.x, km.y)'), 'a crosswalk waits only over a street cars run on')
  assert.ok(functions(MODULE).get('onRoad')!.body.includes('roadV(km.x, km.y)'), 'a line without cars is no carriageway')
})

test('packFrustumPlanes: six planes into the cull layout, in order; anything else refused', () => {
  const planes = Array.from({ length: 6 }, (_, i) => ({ normal: { x: i + 0.1, y: i + 0.2, z: i + 0.3 }, constant: -i }))
  const out = packFrustumPlanes(planes, new Float32Array(24))
  for (let i = 0; i < 6; i++) {
    assert.deepEqual([...out.subarray(i * 4, i * 4 + 4)], [Math.fround(i + 0.1), Math.fround(i + 0.2), Math.fround(i + 0.3), -i])
  }
  assert.throws(() => packFrustumPlanes(planes.slice(1), new Float32Array(24)))
  assert.throws(() => packFrustumPlanes(planes, new Float32Array(23)))
})
