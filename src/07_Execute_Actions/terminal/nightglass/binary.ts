// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the binary form of Lens: how a shader is stored, shipped and handed to
 * `device.createLens` as 32-bit words. `encode` writes a module and `decode` reads one back, exactly: every module
 * the builder makes decodes to a module deep-equal to it, and every word array that decodes encodes back to the
 * same words. `decode` is strict about structure and nothing else. It refuses, with a Fault of code `lens`, a wrong
 * magic word or version, an unknown opcode or code, a count past the words left or past LENS_LIMITS, nesting past
 * the limits, a reserved bit set, a name that is not printable ASCII, and trailing words; it never reads past the
 * array and its recursion is bounded by the nesting limits. It does not type-check: createLens runs verify() on what
 * it returns.
 * What breaks if it is removed? Shaders could exist only as live objects in one page: nothing could store one, send
 * one to another device, or load one an agent wrote.
 *
 * THE WORD LAYOUT (version 1). A word is a u32; arrays of words are little-endian when they become bytes.
 *
 * Header, seven words:
 *   0  LENS_MAGIC (0x534e454c, the bytes L E N S)
 *   1  LENS_VERSION
 *   2  stage: 0 vertex, 1 fragment, 2 compute
 *   3  group x;  4  group y;  5  group z
 *   6  ids
 *
 * Inputs, then outputs: a count word (at most LENS_LIMITS.ports), then one word per port:
 *   bits 0-7 slot, bits 8-15 value type, bit 16 set when the port says `flat`, bit 17 the value of `flat`.
 *
 * Resources: a count word (at most LENS_LIMITS.resources), then each resource as a head word, then its block for
 * the uniform, storage and constants kinds:
 *   bits 0-7 kind: 0 uniform, 1 storage, 2 constants, 3 image, 4 sampler, 5 storage-image
 *   bits 8-15 set; bits 16-23 binding (both zero for constants, which has neither)
 *   bits 24-31 by kind: storage: bit 24 writable; image: bits 24-25 sample kind (0 float, 1 uint, 2 sint,
 *     3 depth) and bit 26 shape (0 2d, 1 2d-array); storage-image: the format, by its place in FORMAT_NAMES.
 * A block: a field count word (at most LENS_LIMITS.fields), then each field as its name and its type.
 * A name: a length word (1 to 32), then the name's bytes four to a word, the first byte lowest; every byte is
 *   printable ASCII (0x20 to 0x7e) and the padding bytes of the last word are zero.
 * A type: a word whose bits 0-7 are a tag: 1 a number type (bits 8-15 the value type), 2 an array (followed by a
 *   length word, 0 to LENS_LIMITS.elements, then the element's type), 3 a nested block (followed by the block).
 *   A field of a top block is at level 0, and each array or nested block holds what it holds one level deeper, to
 *   at most LENS_LIMITS.nesting levels.
 *
 * Body: an instruction list: a count word, then the instructions. Each instruction starts with one word whose
 * bits 0-15 are its opcode and bits 16-31 the words the instruction takes, counting that word and its operands but
 * not the lists nested in it. An instruction that defines a value or a variable carries its id and then its type
 * right after the opcode word. The rest, in order:
 *
 *    1 lit       id t, then one word per component: f32 as its IEEE binary32 bits (finite only), i32 as two's
 *                complement, u32 as itself, bool as 0 or 1
 *    2 unary     id t fn a          3 binary  id t fn a b          4 ternary  id t fn a b c
 *    5 make      id t, then 1 to 16 operand ids (as many as the word count leaves)
 *    6 pick      id t a lanes, where lanes holds the lane count (1 to 4) in bits 0-2 and lane j in bits 8+2j to 9+2j
 *    7 lane      id t a i           8 column  id t a index         9 cast  id t a        10 bits  id t a
 *   11 in        id t slot         12 builtin id t name           13 out   slot a       14 position  a
 *   15 read      id t res, then the path's steps (0 to LENS_LIMITS.path, as many as the word count leaves)
 *   16 write     res a, then the path's steps
 *   17 sample    id t image sampler uv flags [layer] [level]      (flags: bit 0 layer, bit 1 level)
 *   18 texel     id t image at level flags [layer]                (flags: bit 0 layer)
 *   19 put       image at a
 *   20 extent    id t image flags [level]                         (flags: bit 0 level)
 *   21 deriv     id t fn a
 *   22 var       id t flags [init]                                (flags: bit 0 init)
 *   23 get       id t v            24 set     v a
 *   25 if        c, then the `then` list and the `else` list      26 loop  then the body list
 *   27 break     28 continue       29 discard                     30 return
 *
 * A path step is a constant index (bit 31 clear, 0 to 0x7fffffff) or an index held by a value (bit 31 set, bits
 * 0-30 the value's id). Functions, builtins and value types are numbered by their place in lens.ts's UNARY, BINARY,
 * TERNARY, DERIVATIVES, BUILTINS and VALUE_TYPES; those lists only ever grow at their ends. if and loop nest at most
 * LENS_LIMITS.depth deep, a module holds at most LENS_LIMITS.instructions instructions, and at most LENS_LIMITS.words
 * words in all. Every bit the layout does not name is zero.
 */
import { fail, isFault } from './fault.ts'
import { FORMAT_NAMES } from './formats.ts'
import {
  BINARY, BUILTINS, DERIVATIVES, IMAGE_DIMS, LENS_LIMITS, LENS_MAGIC, LENS_VERSION, RESOURCE_KINDS, SAMPLE_KINDS, STAGES, TERNARY,
  UNARY, VALUE_TYPES, componentsOf, scalarOf,
} from './lens.ts'
import type { Block, Builtin, DataType, Field, Inst, LensModule, Op, Port, Resource, Scalar, Step, ValueType } from './lens.ts'
import {
  INST_FIELDS, MAX_INDEX, MAX_OPERANDS, MODULE_FIELDS, RESOURCE_FIELDS, literalRule, say, shapeRule,
} from './verify.ts'
import type { Refuse } from './verify.ts'

/** Opcodes: an op's place here plus one. Zero is never an opcode, so a run of zero words never decodes. */
const OPS: readonly Op[] = Object.freeze([
  'lit', 'unary', 'binary', 'ternary', 'make', 'pick', 'lane', 'column', 'cast', 'bits', 'in', 'builtin', 'out', 'position',
  'read', 'write', 'sample', 'texel', 'put', 'extent', 'deriv', 'var', 'get', 'set', 'if', 'loop', 'break', 'continue',
  'discard', 'return',
])
const BUILTIN_NAMES = Object.freeze(Object.keys(BUILTINS)) as readonly Builtin[]

/** The words of the header, and the fewest words a module can take (a header and four empty counts). */
const HEADER_WORDS = 7
const MIN_WORDS = HEADER_WORDS + 4
const NAME_MAX = 32
const PORT_SAYS_FLAT = 1 << 16
const PORT_FLAT = 1 << 17
const TAG_VALUE = 1
const TAG_ARRAY = 2
const TAG_BLOCK = 3
const STEP_VALUE = 0x80000000

/** The words each fixed-size instruction takes; the others are checked as their operands are read. */
const FIXED_WORDS: { readonly [K in Op]?: number } = Object.freeze({
  unary: 5, binary: 6, ternary: 7, pick: 5, lane: 5, column: 5, cast: 4, bits: 4, in: 4, builtin: 4, out: 3, position: 2,
  put: 4, deriv: 5, get: 4, set: 3, if: 2, loop: 1, break: 1, continue: 1, discard: 1, return: 1,
})

const f32 = new Float32Array(1)
const f32Bits = new Uint32Array(f32.buffer)

type Obj = { readonly [key: string]: unknown }
const isObj = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x)
const isWhole = (x: unknown, lo: number, hi: number): x is number => typeof x === 'number' && Number.isInteger(x) && x >= lo && x <= hi

/** The lanes word of a pick. */
function packLanes(lanes: readonly number[]): number {
  return lanes.reduce((w, l, j) => w | (l << (8 + 2 * j)), lanes.length)
}

// ---------------------------------------------------------------------------------------------------
// Encoding

class Encoder {
  readonly out: number[] = []
  private count = 0

  private put(w: number): void {
    if (this.out.length >= LENS_LIMITS.words) fail('lens', `lens: encode: module: the module takes more than ${LENS_LIMITS.words} words`)
    this.out.push(w >>> 0)
  }

  /** A whole number that fits a word, and the word it is. */
  private word(x: unknown, what: string, no: Refuse): number {
    if (!isWhole(x, 0, 0xffffffff)) no(`${what} is a whole number from 0 to 4294967295, not ${say(x)}`)
    return x
  }

  private small(x: unknown, what: string, no: Refuse): number {
    if (!isWhole(x, 0, 255)) no(`${what} is a whole number from 0 to 255 in the binary form, not ${say(x)}`)
    return x
  }

  private code<T>(list: readonly T[], x: unknown, what: string, no: Refuse): number {
    const c = (list as readonly unknown[]).indexOf(x)
    if (c < 0) no(`${say(x)} is not ${what}`)
    return c
  }

  module(m: unknown): void {
    const no: Refuse = (rule) => fail('lens', `lens: encode: module: ${rule}`)
    if (!isObj(m)) no(`a module is an object, not ${say(m)}`)
    shapeRule(m, MODULE_FIELDS, [], no)
    this.put(LENS_MAGIC)
    this.put(LENS_VERSION)
    this.put(this.code(STAGES, m.stage, 'a stage', no))
    const group = m.group
    if (!Array.isArray(group) || group.length !== 3) no('the group is a list of three sizes')
    for (let i = 0; i < 3; i++) this.put(this.word(group[i], 'a group size', no))
    if (!isWhole(m.ids, 0, LENS_LIMITS.ids)) no(`ids is a whole number from 0 to ${LENS_LIMITS.ids}, not ${say(m.ids)}`)
    this.put(m.ids)
    this.ports(m.inputs, 'inputs')
    this.ports(m.outputs, 'outputs')
    this.resources(m.resources)
    this.list(m.body, 'body', 0)
  }

  private ports(list: unknown, side: string): void {
    if (!Array.isArray(list) || list.length > LENS_LIMITS.ports) fail('lens', `lens: encode: ${side}: the ${side} are a list of at most ${LENS_LIMITS.ports} ports`)
    this.put(list.length)
    for (let i = 0; i < list.length; i++) {
      const p: unknown = list[i]
      const no: Refuse = (rule) => fail('lens', `lens: encode: ${side}[${i}] port: ${rule}`)
      if (!isObj(p)) no('a port is an object')
      shapeRule(p, ['slot', 'type'], ['flat'], no)
      const slot = this.small(p.slot, 'the slot', no)
      const type = this.code(VALUE_TYPES, p.type, 'a value type', no)
      if (p.flat !== undefined && typeof p.flat !== 'boolean') no('flat is true or false')
      this.put(slot | (type << 8) | (p.flat === undefined ? 0 : PORT_SAYS_FLAT | (p.flat ? PORT_FLAT : 0)))
    }
  }

  private resources(list: unknown): void {
    if (!Array.isArray(list) || list.length > LENS_LIMITS.resources) fail('lens', `lens: encode: resources: the resources are a list of at most ${LENS_LIMITS.resources}`)
    this.put(list.length)
    for (let i = 0; i < list.length; i++) {
      const r: unknown = list[i]
      const where = `resources[${i}]`
      const kind = isObj(r) && (RESOURCE_KINDS as readonly unknown[]).includes(r.kind) ? (r.kind as Resource['kind']) : undefined
      const no: Refuse = (rule) => fail('lens', `lens: encode: ${where} ${kind ?? 'resource'}: ${rule}`)
      if (!isObj(r) || kind === undefined) return no(`${say(isObj(r) ? r.kind : r)} is not a resource`)
      shapeRule(r, RESOURCE_FIELDS[kind], [], no)
      let head = RESOURCE_KINDS.indexOf(kind)
      if (kind !== 'constants') head |= (this.small(r.set, 'the set', no) << 8) | (this.small(r.binding, 'the binding', no) << 16)
      if (kind === 'storage') {
        if (typeof r.writable !== 'boolean') no('writable is true or false')
        head |= r.writable ? 1 << 24 : 0
      }
      if (kind === 'image') head |= (this.code(SAMPLE_KINDS, r.sample, 'a sample kind', no) << 24) | (this.code(IMAGE_DIMS, r.dims, 'an image shape', no) << 26)
      if (kind === 'storage-image') head |= this.code(FORMAT_NAMES, r.format, 'a format', no) << 24
      this.put(head)
      if (kind === 'uniform' || kind === 'storage' || kind === 'constants') this.block(r.block, '', 0, no)
    }
  }

  private block(b: unknown, where: string, level: number, no: Refuse): void {
    const name = where === '' ? 'the block' : `field ${where}`
    if (!isObj(b)) no(`${name} is not a block`)
    shapeRule(b, ['fields'], [], (rule) => no(`${name}: ${rule}`))
    const fields = b.fields
    if (!Array.isArray(fields) || fields.length > LENS_LIMITS.fields) no(`${name}: the fields are a list of at most ${LENS_LIMITS.fields}`)
    this.put(fields.length)
    for (let i = 0; i < fields.length; i++) {
      const f: unknown = fields[i]
      const at = where === '' ? `${i}` : `${where}.${i}`
      if (!isObj(f)) no(`field ${at} is not an object`)
      shapeRule(f, ['name', 'type'], [], (rule) => no(`field ${at}: ${rule}`))
      this.name(f.name, at, no)
      this.type(f.type, at, level, no)
    }
  }

  private name(s: unknown, at: string, no: Refuse): void {
    const bad = (): never => no(`field ${at}: ${say(s)} is not a name of 1 to ${NAME_MAX} printable ASCII characters`)
    if (typeof s !== 'string' || s.length < 1 || s.length > NAME_MAX) return bad()
    this.put(s.length)
    for (let i = 0; i < s.length; i += 4) {
      let w = 0
      for (let j = 0; j < 4 && i + j < s.length; j++) {
        const c = s.charCodeAt(i + j)
        if (c < 0x20 || c > 0x7e) bad()
        w |= c << (8 * j)
      }
      this.put(w)
    }
  }

  private type(t: unknown, at: string, level: number, no: Refuse): void {
    if (typeof t === 'string') {
      this.put(TAG_VALUE | (this.code(VALUE_TYPES, t, 'a value type', (rule) => no(`field ${at}: ${rule}`)) << 8))
      return
    }
    if (!isObj(t) || (!Object.hasOwn(t, 'array') && !Object.hasOwn(t, 'struct'))) no(`field ${at}: its type is a number type, an array or a nested block`)
    if (level >= LENS_LIMITS.nesting) no(`field ${at}: blocks and arrays nest at most ${LENS_LIMITS.nesting} deep`)
    if (Object.hasOwn(t, 'struct')) {
      shapeRule(t, ['struct'], [], (rule) => no(`field ${at}: ${rule}`))
      this.put(TAG_BLOCK)
      this.block(t.struct, at, level + 1, no)
      return
    }
    shapeRule(t, ['array', 'len'], [], (rule) => no(`field ${at}: ${rule}`))
    if (!isWhole(t.len, 0, LENS_LIMITS.elements)) no(`field ${at}: an array holds 0 to ${LENS_LIMITS.elements} elements, not ${say(t.len)}`)
    this.put(TAG_ARRAY)
    this.put(t.len)
    this.type(t.array, `${at}[]`, level + 1, no)
  }

  private list(insts: unknown, where: string, depth: number): void {
    if (!Array.isArray(insts)) fail('lens', `lens: encode: ${where}: a block is a list of instructions`)
    if (insts.length > LENS_LIMITS.instructions - this.count) fail('lens', `lens: encode: ${where}: the module holds more than ${LENS_LIMITS.instructions} instructions`)
    this.count += insts.length
    this.put(insts.length)
    for (let i = 0; i < insts.length; i++) this.inst(insts[i], `${where}[${i}]`, depth)
  }

  private inst(x: unknown, where: string, depth: number): void {
    if (!isObj(x)) fail('lens', `lens: encode: ${where}: an instruction is an object, not ${say(x)}`)
    const op = x.op as Op
    const opcode = OPS.indexOf(op) + 1
    if (opcode === 0) fail('lens', `lens: encode: ${where}: ${say(op)} is not an instruction`)
    const no: Refuse = (rule) => fail('lens', `lens: encode: ${where} ${op}: ${rule}`)
    const [required, optional] = INST_FIELDS[op]
    shapeRule(x, required, optional, no)
    const start = this.out.length
    this.put(0)
    const id = (v: unknown, what: string): void => this.put(this.word(v, what, no))
    if (required.includes('id')) id(x.id, 'the id')
    if (required.includes('t')) this.put(this.code(VALUE_TYPES, x.t, 'a value type', no))
    switch (op) {
      case 'lit': {
        if (!Array.isArray(x.v)) no('the components are a list')
        const t = x.t as ValueType
        literalRule(t, x.v as unknown[], no)
        for (const c of x.v as number[]) this.put(scalarOf(t) === 'f32' ? bitsOf(c) : c)
        break
      }
      case 'unary': this.put(this.code(UNARY, x.fn, 'a unary function', no)); id(x.a, 'the operand'); break
      case 'binary': this.put(this.code(BINARY, x.fn, 'a binary function', no)); id(x.a, 'operand a'); id(x.b, 'operand b'); break
      case 'ternary': this.put(this.code(TERNARY, x.fn, 'a ternary function', no)); id(x.a, 'operand a'); id(x.b, 'operand b'); id(x.c, 'operand c'); break
      case 'make': {
        const args = x.args
        if (!Array.isArray(args) || args.length < 1 || args.length > MAX_OPERANDS) no(`the operands are a list of 1 to ${MAX_OPERANDS} ids`)
        for (const a of args as unknown[]) id(a, 'an operand')
        break
      }
      case 'pick': {
        id(x.a, 'the vector')
        const lanes = x.lanes
        if (!Array.isArray(lanes) || lanes.length < 1 || lanes.length > 4) no('pick takes a list of 1 to 4 lanes')
        for (const l of lanes as unknown[]) if (!isWhole(l, 0, 3)) no(`${say(l)} is not a lane from 0 to 3`)
        this.put(packLanes(lanes as number[]))
        break
      }
      case 'lane': id(x.a, 'the vector'); id(x.i, 'the index'); break
      case 'column': id(x.a, 'the grid'); id(x.i, 'the column'); break
      case 'cast': case 'bits': id(x.a, 'the operand'); break
      case 'in': id(x.slot, 'the slot'); break
      case 'builtin': this.put(this.code(BUILTIN_NAMES, x.name, 'a builtin', no)); break
      case 'out': id(x.slot, 'the slot'); id(x.a, 'the value'); break
      case 'position': id(x.a, 'the position'); break
      case 'read': id(x.res, 'the resource'); this.steps(x.path, no); break
      case 'write': id(x.res, 'the resource'); id(x.a, 'the value'); this.steps(x.path, no); break
      case 'sample':
        id(x.image, 'the image'); id(x.sampler, 'the sampler'); id(x.uv, 'uv')
        this.put((x.layer === undefined ? 0 : 1) | (x.level === undefined ? 0 : 2))
        if (x.layer !== undefined) id(x.layer, 'the layer')
        if (x.level !== undefined) id(x.level, 'the level')
        break
      case 'texel':
        id(x.image, 'the image'); id(x.at, 'the position'); id(x.level, 'the level')
        this.put(x.layer === undefined ? 0 : 1)
        if (x.layer !== undefined) id(x.layer, 'the layer')
        break
      case 'put': id(x.image, 'the image'); id(x.at, 'the position'); id(x.a, 'the value'); break
      case 'extent':
        id(x.image, 'the image')
        this.put(x.level === undefined ? 0 : 1)
        if (x.level !== undefined) id(x.level, 'the level')
        break
      case 'deriv': this.put(this.code(DERIVATIVES, x.fn, 'a derivative', no)); id(x.a, 'the operand'); break
      case 'var':
        this.put(x.init === undefined ? 0 : 1)
        if (x.init !== undefined) id(x.init, 'the initial value')
        break
      case 'get': id(x.v, 'the variable'); break
      case 'set': id(x.v, 'the variable'); id(x.a, 'the value'); break
      case 'if': id(x.c, 'the condition'); break
      case 'loop': case 'break': case 'continue': case 'discard': case 'return': break
    }
    this.out[start] = (opcode | ((this.out.length - start) << 16)) >>> 0
    if (op === 'if' || op === 'loop') {
      if (depth >= LENS_LIMITS.depth) no(`if and loop nest at most ${LENS_LIMITS.depth} deep`)
      if (op === 'if') {
        this.list(x.then, `${where}.then`, depth + 1)
        this.list(x.else, `${where}.else`, depth + 1)
      } else this.list(x.body, `${where}.body`, depth + 1)
    }
  }

  private steps(path: unknown, no: Refuse): void {
    if (!Array.isArray(path) || path.length > LENS_LIMITS.path) no(`the path is a list of at most ${LENS_LIMITS.path} steps`)
    for (let s = 0; s < path.length; s++) {
      const step: unknown = path[s]
      if (typeof step === 'number') {
        if (!isWhole(step, 0, MAX_INDEX)) no(`step ${s} (${say(step)}) is not a constant index from 0 to ${MAX_INDEX}`)
        this.put(step)
      } else {
        if (!isObj(step)) no(`step ${s} is a constant index or an { at } value`)
        shapeRule(step, ['at'], [], (rule) => no(`step ${s}: ${rule}`))
        if (!isWhole(step.at, 0, MAX_INDEX)) no(`step ${s}: the id ${say(step.at)} does not fit the binary form`)
        this.put(STEP_VALUE | step.at)
      }
    }
  }
}

function bitsOf(x: number): number {
  f32[0] = x
  return f32Bits[0]
}

/**
 * The words of a module. Refuses (Fault `lens`) a module the form cannot represent: one whose structure is not a
 * module's, or that holds an unknown name or code, a literal component that is not exactly its type's, a field that
 * is not a listed one or is present as undefined, a number past the width the layout gives it, or more of anything
 * than the limits allow. It does not type-check, so it also writes modules verify() would refuse.
 */
export function encode(m: LensModule): Uint32Array {
  const e = new Encoder()
  try {
    e.module(m)
  } catch (err) {
    if (isFault(err)) throw err
    fail('lens', 'lens: encode: module: the module is not plain data (reading it raised an error)')
  }
  return Uint32Array.from(e.out)
}

// ---------------------------------------------------------------------------------------------------
// Decoding

class Decoder {
  private readonly words: Uint32Array
  private pos = 0
  /** Reads stop here: the end of the words, or of the instruction whose operands are being read. */
  private end: number
  private count = 0

  constructor(words: Uint32Array) {
    this.words = words
    this.end = words.length
  }

  private no(rule: string, at = this.pos): never {
    return fail('lens', `lens: decode: word ${at}: ${rule}`)
  }

  private word(what: string): number {
    if (this.pos >= this.end) this.no(this.end === this.words.length ? `the words end inside ${what}` : `the instruction's word count leaves no room for ${what}`)
    return this.words[this.pos++]
  }

  private code<T>(list: readonly T[], what: string): T {
    const at = this.pos
    const c = this.word(what)
    const v = list[c]
    if (v === undefined) this.no(`${c} is not ${what}`, at)
    return v
  }

  /** A count word, refused past the limit or past what the words left could hold at `least` words each. */
  private counted(what: string, limit: number, least: number): number {
    const at = this.pos
    const n = this.word(`the count of ${what}`)
    if (n > limit) this.no(`${n} ${what} is more than the limit of ${limit}`, at)
    if (n * least > this.end - this.pos) this.no(`${n} ${what} cannot fit in the ${this.end - this.pos} words left`, at)
    return n
  }

  module(): LensModule {
    if (this.words.length > LENS_LIMITS.words) this.no(`the binary holds ${this.words.length} words; the limit is ${LENS_LIMITS.words}`, 0)
    if (this.word('the header') !== LENS_MAGIC) this.no('the first word is not LENS_MAGIC', 0)
    const version = this.word('the header')
    if (version !== LENS_VERSION) this.no(`version ${version} is not the version this code reads (${LENS_VERSION})`, 1)
    const stage = this.code(STAGES, 'a stage')
    const group = Object.freeze([this.word('the group'), this.word('the group'), this.word('the group')] as const)
    const ids = this.word('the header')
    if (ids > LENS_LIMITS.ids) this.no(`${ids} ids is more than the limit of ${LENS_LIMITS.ids}`, HEADER_WORDS - 1)
    const inputs = this.ports('inputs')
    const outputs = this.ports('outputs')
    const resources = this.resources()
    const body = this.list(0)
    if (this.pos !== this.words.length) this.no(`${this.words.length - this.pos} words trail the body`)
    return Object.freeze({ stage, group, inputs, outputs, resources, body, ids })
  }

  private ports(side: string): readonly Port[] {
    const n = this.counted(side, LENS_LIMITS.ports, 1)
    const ports: Port[] = []
    for (let i = 0; i < n; i++) {
      const at = this.pos
      const w = this.word('a port')
      if (w >>> 18 !== 0 || (w & (PORT_SAYS_FLAT | PORT_FLAT)) === PORT_FLAT) this.no('a port word has reserved bits set', at)
      const type = VALUE_TYPES[(w >>> 8) & 0xff]
      if (type === undefined) this.no(`${(w >>> 8) & 0xff} is not a value type`, at)
      const slot = w & 0xff
      ports.push(Object.freeze(w & PORT_SAYS_FLAT ? { slot, type, flat: (w & PORT_FLAT) !== 0 } : { slot, type }))
    }
    return Object.freeze(ports)
  }

  private resources(): readonly Resource[] {
    const n = this.counted('resources', LENS_LIMITS.resources, 1)
    const out: Resource[] = []
    for (let i = 0; i < n; i++) {
      const at = this.pos
      const head = this.word('a resource')
      const kind = RESOURCE_KINDS[head & 0xff]
      if (kind === undefined) this.no(`${head & 0xff} is not a kind of resource`, at)
      const set = (head >>> 8) & 0xff
      const binding = (head >>> 16) & 0xff
      const extra = head >>> 24
      const reserved = (allowed: number): void => {
        if ((extra & ~allowed) !== 0) this.no(`a ${kind} resource word has reserved bits set`, at)
      }
      switch (kind) {
        case 'uniform': reserved(0); out.push(Object.freeze({ kind, set, binding, block: this.block(0) })); break
        case 'storage': reserved(1); out.push(Object.freeze({ kind, set, binding, block: this.block(0), writable: extra === 1 })); break
        case 'constants':
          if ((head >>> 8) !== 0) this.no('a constants resource word has reserved bits set', at)
          out.push(Object.freeze({ kind, block: this.block(0) }))
          break
        case 'image': reserved(7); out.push(Object.freeze({ kind, set, binding, sample: SAMPLE_KINDS[extra & 3], dims: IMAGE_DIMS[extra >>> 2] })); break
        case 'sampler': reserved(0); out.push(Object.freeze({ kind, set, binding })); break
        case 'storage-image': {
          const format = FORMAT_NAMES[extra]
          if (format === undefined) this.no(`${extra} is not a format`, at)
          out.push(Object.freeze({ kind, set, binding, format }))
          break
        }
      }
    }
    return Object.freeze(out)
  }

  private block(level: number): Block {
    const n = this.counted('fields', LENS_LIMITS.fields, 3)
    const fields: Field[] = []
    for (let i = 0; i < n; i++) {
      const name = this.name()
      fields.push(Object.freeze({ name, type: this.type(level) }))
    }
    return Object.freeze({ fields: Object.freeze(fields) })
  }

  private name(): string {
    const at = this.pos
    const len = this.word('a name')
    if (len < 1 || len > NAME_MAX) this.no(`a name is 1 to ${NAME_MAX} characters, not ${len}`, at)
    const codes: number[] = []
    for (let i = 0; i < len; i += 4) {
      const wat = this.pos
      const w = this.word('a name')
      for (let j = 0; j < 4; j++) {
        const c = (w >>> (8 * j)) & 0xff
        if (i + j < len ? c < 0x20 || c > 0x7e : c !== 0) this.no(i + j < len ? `a name holds the byte ${c}, which is not printable ASCII` : 'a name\'s padding is not zero', wat)
        if (i + j < len) codes.push(c)
      }
    }
    return String.fromCharCode(...codes)
  }

  private type(level: number): DataType {
    const at = this.pos
    const w = this.word('a type')
    const tag = w & 0xff
    if (tag === TAG_VALUE) {
      const t = VALUE_TYPES[(w >>> 8) & 0xff]
      if (t === undefined || w >>> 16 !== 0) this.no(`${w} is not a number type word`, at)
      return t as DataType
    }
    if ((tag !== TAG_ARRAY && tag !== TAG_BLOCK) || w >>> 8 !== 0) this.no(`${w} is not a type word`, at)
    if (level >= LENS_LIMITS.nesting) this.no(`blocks and arrays nest more than ${LENS_LIMITS.nesting} deep`, at)
    if (tag === TAG_BLOCK) return Object.freeze({ struct: this.block(level + 1) })
    const lat = this.pos
    const len = this.word('an array length')
    if (len > LENS_LIMITS.elements) this.no(`an array of ${len} elements is more than the limit of ${LENS_LIMITS.elements}`, lat)
    return Object.freeze({ array: this.type(level + 1), len })
  }

  list(depth: number): readonly Inst[] {
    const n = this.counted('instructions', LENS_LIMITS.instructions, 1)
    const insts: Inst[] = []
    for (let i = 0; i < n; i++) insts.push(this.inst(depth))
    return Object.freeze(insts)
  }

  private inst(depth: number): Inst {
    const start = this.pos
    if (++this.count > LENS_LIMITS.instructions) this.no(`the module holds more than ${LENS_LIMITS.instructions} instructions`)
    const head = this.word('an instruction')
    const op = OPS[(head & 0xffff) - 1]
    if (op === undefined) this.no(`${head & 0xffff} is not an opcode`, start)
    const size = head >>> 16
    if (size < 1 || size > this.end - start) this.no(`the instruction's word count of ${size} runs past the words left`, start)
    const fixed = FIXED_WORDS[op]
    if (fixed !== undefined && size !== fixed) this.no(`${op} takes ${fixed} words, not ${size}`, start)
    const outer = this.end
    this.end = start + size
    if (op === 'if' || op === 'loop') {
      const c = op === 'if' ? this.word('the condition') : 0
      this.end = outer
      if (depth >= LENS_LIMITS.depth) this.no(`if and loop nest more than ${LENS_LIMITS.depth} deep`, start)
      if (op === 'loop') return Object.freeze({ op, body: this.list(depth + 1) })
      const then = this.list(depth + 1)
      return Object.freeze({ op, c, then, else: this.list(depth + 1) })
    }
    const inst = this.operands(op, size, start)
    if (this.pos !== this.end) this.no(`the instruction's word count of ${size} is more than its operands take`, start)
    this.end = outer
    return inst
  }

  private operands(op: Exclude<Op, 'if' | 'loop'>, size: number, start: number): Inst {
    const w = (what: string): number => this.word(what)
    const sized = (want: number): void => {
      if (size !== want) this.no(`this ${op} takes ${want} words, not ${size}`, start)
    }
    const flags = (allowed: number): number => {
      const at = this.pos
      const f = w('the flags')
      if ((f & ~allowed) !== 0) this.no('the flags have reserved bits set', at)
      return f
    }
    switch (op) {
      case 'break': case 'continue': case 'discard': case 'return': return Object.freeze({ op })
      case 'out': { const slot = w('the slot'); return Object.freeze({ op, slot, a: w('the value') }) }
      case 'position': return Object.freeze({ op, a: w('the position') })
      case 'write': {
        const res = w('the resource')
        const a = w('the value')
        return Object.freeze({ op, res, a, path: this.steps(size - 3, start) })
      }
      case 'put': { const image = w('the image'); const at = w('the position'); return Object.freeze({ op, image, at, a: w('the value') }) }
      case 'set': { const v = w('the variable'); return Object.freeze({ op, v, a: w('the value') }) }
      default: break
    }
    const id = w('the id')
    const t = this.code(VALUE_TYPES, 'a value type')
    switch (op) {
      case 'lit': {
        const n = componentsOf(t)
        sized(3 + n)
        const v: number[] = []
        for (let i = 0; i < n; i++) v.push(this.component(scalarOf(t)))
        return Object.freeze({ op, id, t, v: Object.freeze(v) })
      }
      case 'unary': { const fn = this.code(UNARY, 'a unary function'); return Object.freeze({ op, id, t, fn, a: w('the operand') }) }
      case 'binary': {
        const fn = this.code(BINARY, 'a binary function')
        const a = w('operand a')
        return Object.freeze({ op, id, t, fn, a, b: w('operand b') })
      }
      case 'ternary': {
        const fn = this.code(TERNARY, 'a ternary function')
        const a = w('operand a')
        const b = w('operand b')
        return Object.freeze({ op, id, t, fn, a, b, c: w('operand c') })
      }
      case 'make': {
        const n = size - 3
        if (n < 1 || n > MAX_OPERANDS) this.no(`a make takes 1 to ${MAX_OPERANDS} operands, not ${n}`, start)
        const args: number[] = []
        for (let i = 0; i < n; i++) args.push(w('an operand'))
        return Object.freeze({ op, id, t, args: Object.freeze(args) })
      }
      case 'pick': {
        const a = w('the vector')
        const at = this.pos
        const word = w('the lanes')
        const count = word & 7
        const lanes: number[] = []
        for (let j = 0; j < count && j < 4; j++) lanes.push((word >>> (8 + 2 * j)) & 3)
        if (count < 1 || count > 4 || packLanes(lanes) !== word) this.no('the lanes word is not 1 to 4 lanes with every other bit zero', at)
        return Object.freeze({ op, id, t, a, lanes: Object.freeze(lanes) })
      }
      case 'lane': { const a = w('the vector'); return Object.freeze({ op, id, t, a, i: w('the index') }) }
      case 'column': { const a = w('the grid'); return Object.freeze({ op, id, t, a, i: w('the column') }) }
      case 'cast': case 'bits': return Object.freeze({ op, id, t, a: w('the operand') })
      case 'in': return Object.freeze({ op, id, t, slot: w('the slot') })
      case 'builtin': return Object.freeze({ op, id, t, name: this.code(BUILTIN_NAMES, 'a builtin') })
      case 'read': {
        const res = w('the resource')
        return Object.freeze({ op, id, t, res, path: this.steps(size - 4, start) })
      }
      case 'sample': {
        const image = w('the image')
        const sampler = w('the sampler')
        const uv = w('uv')
        const f = flags(3)
        sized(7 + (f & 1) + (f >>> 1))
        const layer = f & 1 ? { layer: w('the layer') } : {}
        const level = f & 2 ? { level: w('the level') } : {}
        return Object.freeze({ op, id, t, image, sampler, uv, ...layer, ...level })
      }
      case 'texel': {
        const image = w('the image')
        const at = w('the position')
        const level = w('the level')
        const f = flags(1)
        sized(7 + f)
        return Object.freeze({ op, id, t, image, at, level, ...(f ? { layer: w('the layer') } : {}) })
      }
      case 'extent': {
        const image = w('the image')
        const f = flags(1)
        sized(5 + f)
        return Object.freeze({ op, id, t, image, ...(f ? { level: w('the level') } : {}) })
      }
      case 'deriv': { const fn = this.code(DERIVATIVES, 'a derivative'); return Object.freeze({ op, id, t, fn, a: w('the operand') }) }
      case 'var': {
        const f = flags(1)
        sized(4 + f)
        return Object.freeze(f ? { op, id, t, init: w('the initial value') } : { op, id, t })
      }
      case 'get': return Object.freeze({ op, id, t, v: w('the variable') })
    }
  }

  private steps(n: number, start: number): readonly Step[] {
    if (n > LENS_LIMITS.path) this.no(`a path of ${n} steps is more than the limit of ${LENS_LIMITS.path}`, start)
    const steps: Step[] = []
    for (let s = 0; s < n; s++) {
      const w = this.word('a step')
      steps.push(w >= STEP_VALUE ? Object.freeze({ at: w - STEP_VALUE }) : w)
    }
    return Object.freeze(steps)
  }

  private component(k: Scalar): number {
    const at = this.pos
    const w = this.word('a component')
    if (k === 'f32') {
      f32Bits[0] = w
      const x = f32[0]
      if (!Number.isFinite(x)) this.no('an f32 literal component is not finite', at)
      return x
    }
    if (k === 'bool' && w > 1) this.no(`a bool literal component is ${w}, not 0 or 1`, at)
    return k === 'i32' ? w | 0 : w
  }
}

/**
 * The module the words hold: plain frozen data, deep-equal to what `encode` was given. Refuses (Fault `lens`)
 * anything malformed, as the head of the file sets out, without reading past the words.
 */
export function decode(words: Uint32Array): LensModule {
  if (!(words instanceof Uint32Array)) fail('lens', `lens: decode: a Lens binary is a Uint32Array, not ${say(words)}`)
  return new Decoder(words).module()
}

/** True when the words begin as a Lens binary does: long enough for a header and its counts, and LENS_MAGIC first. */
export function looksLikeLens(words: Uint32Array): boolean {
  return words instanceof Uint32Array && words.length >= MIN_WORDS && words[0] === LENS_MAGIC
}
