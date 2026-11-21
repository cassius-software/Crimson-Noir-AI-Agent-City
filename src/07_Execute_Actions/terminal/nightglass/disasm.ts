// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It prints a Lens module as text a person can read: the stage and workgroup, the ports,
 * every resource with its block laid out (each field's byte offset, each array's stride), then the body one
 * instruction to a line, `%7 = binary.mul f32x4 %3 %6`, with `if` and `loop` blocks indented and paths into blocks
 * spelled with their field names (`r0.lights[%4].color`). The text is stable, so tests pin it and a change to a
 * shader shows up as a readable diff. The module is first carried through the binary form into a private, frozen
 * copy (binary.ts's checkedCopy), which verify() checks and which alone is listed, so the listing is always of a
 * valid module, read once, and every name and layout in it is real; whatever it is handed, it raises nothing but a
 * lens Fault.
 * What breaks if it is removed? A shader could be inspected only as nested objects or raw words, and a failing
 * shader test could say only that two modules differ, not where.
 *
 * The listing of a small fragment shader:
 *
 *   lens fragment
 *   group 1 1 1
 *   ids 4
 *   input 0 f32x2
 *   output 0 f32x4
 *   resource 0 uniform set 0 binding 0 size 16 align 16
 *     @0 tint f32x4
 *   body
 *     %0 = in f32x2 0
 *     %1 = read f32x4 r0.tint
 *     %2 = pick f32 %0 x
 *     %3 = binary.mul f32x4 %1 %2
 *     out 0 %3
 */
import { checkedCopy } from './binary.ts'
import { fail, isFault } from './fault.ts'
import { layoutBlock, scalarOf, strideOf } from './lens.ts'
import type { Block, DataType, Field, Inst, LensModule, Resource, Space, Step } from './lens.ts'

const LANES = 'xyzw'

/** The shortest decimal that rounds back to the same f32 (and -0 as itself). */
function f32Text(x: number): string {
  if (Object.is(x, -0)) return '-0'
  for (let p = 1; p < 10; p++) {
    const s = String(Number(x.toPrecision(p)))
    if (Math.fround(Number(s)) === x) return s
  }
  return String(x)
}

/** A block type as text: a number type, `[4]f32x4` (an array of four), `[]f32` (no length), or `struct`. */
function typeText(t: DataType): string {
  if (typeof t === 'string') return t
  if ('array' in t) return `[${t.len === 0 ? '' : t.len}]${typeText(t.array)}`
  return 'struct'
}

/** The block an array or nested block finally holds, if any. */
function innerBlock(t: DataType): Block | undefined {
  while (typeof t !== 'string' && 'array' in t) t = t.array
  return typeof t === 'string' ? undefined : t.struct
}

/** A block's fields, one to a line, each at its byte offset within the block; nested blocks indent below. */
function fieldLines(out: string[], b: Block, space: Space, indent: string): void {
  const offsets = layoutBlock(b, space).offsets
  b.fields.forEach((f, i) => {
    const stride = typeof f.type !== 'string' && 'array' in f.type ? ` stride ${strideOf(f.type.array, space)}` : ''
    out.push(`${indent}@${offsets[i]} ${f.name} ${typeText(f.type)}${stride}`)
    const inner = innerBlock(f.type)
    if (inner !== undefined) fieldLines(out, inner, space, `${indent}  `)
  })
}

function resourceLines(out: string[], r: Resource, i: number): void {
  const at = r.kind === 'constants' ? '' : ` set ${r.set} binding ${r.binding}`
  switch (r.kind) {
    case 'uniform': case 'storage': case 'constants': {
      const space: Space = r.kind === 'storage' ? 'storage' : 'uniform'
      const layout = layoutBlock(r.block, space)
      const access = r.kind === 'storage' ? (r.writable ? ' writable' : ' read-only') : ''
      out.push(`resource ${i} ${r.kind}${at}${access} size ${layout.size} align ${layout.align}`)
      fieldLines(out, r.block, space, '  ')
      break
    }
    case 'image': out.push(`resource ${i} image${at} ${r.sample} ${r.dims}`); break
    case 'sampler': out.push(`resource ${i} sampler${at}`); break
    case 'storage-image': out.push(`resource ${i} storage-image${at} ${r.format}`); break
  }
}

/** A path into a resource's block with its field names: `r1.items[%3].pos`. */
function pathText(m: LensModule, res: number, path: readonly Step[]): string {
  const r = m.resources[res]
  let t: DataType = { struct: (r as { readonly block: Block }).block }
  let s = `r${res}`
  for (const step of path) {
    if (typeof t === 'string') break
    if ('struct' in t) {
      const f: Field = t.struct.fields[step as number]
      s += `.${f.name}`
      t = f.type
    } else {
      s += typeof step === 'number' ? `[${step}]` : `[%${step.at}]`
      t = t.array
    }
  }
  return s
}

/** One instruction's line (if and loop: their opening line). */
function instText(m: LensModule, i: Inst): string {
  const v = (id: number): string => `%${id}`
  switch (i.op) {
    case 'lit': {
      const k = scalarOf(i.t)
      const parts = i.v.map((x) => (k === 'f32' ? f32Text(x) : k === 'bool' ? (x === 1 ? 'true' : 'false') : String(x)))
      return `%${i.id} = lit ${i.t} ${parts.join(' ')}`
    }
    case 'unary': return `%${i.id} = unary.${i.fn} ${i.t} ${v(i.a)}`
    case 'binary': return `%${i.id} = binary.${i.fn} ${i.t} ${v(i.a)} ${v(i.b)}`
    case 'ternary': return `%${i.id} = ternary.${i.fn} ${i.t} ${v(i.a)} ${v(i.b)} ${v(i.c)}`
    case 'make': return `%${i.id} = make ${i.t} ${i.args.map(v).join(' ')}`
    case 'pick': return `%${i.id} = pick ${i.t} ${v(i.a)} ${i.lanes.map((l) => LANES[l]).join('')}`
    case 'lane': return `%${i.id} = lane ${i.t} ${v(i.a)} ${v(i.i)}`
    case 'column': return `%${i.id} = column ${i.t} ${v(i.a)} ${i.i}`
    case 'cast': return `%${i.id} = cast ${i.t} ${v(i.a)}`
    case 'bits': return `%${i.id} = bits ${i.t} ${v(i.a)}`
    case 'in': return `%${i.id} = in ${i.t} ${i.slot}`
    case 'builtin': return `%${i.id} = builtin ${i.t} ${i.name}`
    case 'out': return `out ${i.slot} ${v(i.a)}`
    case 'position': return `position ${v(i.a)}`
    case 'read': return `%${i.id} = read ${i.t} ${pathText(m, i.res, i.path)}`
    case 'write': return `write ${pathText(m, i.res, i.path)} ${v(i.a)}`
    case 'sample': {
      const layer = i.layer === undefined ? '' : ` layer ${v(i.layer)}`
      const level = i.level === undefined ? '' : ` level ${v(i.level)}`
      return `%${i.id} = sample ${i.t} r${i.image} r${i.sampler} ${v(i.uv)}${layer}${level}`
    }
    case 'texel': {
      const layer = i.layer === undefined ? '' : ` layer ${v(i.layer)}`
      return `%${i.id} = texel ${i.t} r${i.image} ${v(i.at)}${layer} level ${v(i.level)}`
    }
    case 'put': return `put r${i.image} ${v(i.at)} ${v(i.a)}`
    case 'extent': return `%${i.id} = extent ${i.t} r${i.image}${i.level === undefined ? '' : ` level ${v(i.level)}`}`
    case 'deriv': return `%${i.id} = deriv.${i.fn} ${i.t} ${v(i.a)}`
    case 'var': return `%${i.id} = var ${i.t}${i.init === undefined ? '' : ` ${v(i.init)}`}`
    case 'get': return `%${i.id} = get ${i.t} ${v(i.v)}`
    case 'set': return `set ${v(i.v)} ${v(i.a)}`
    case 'if': return `if ${v(i.c)}`
    case 'loop': case 'break': case 'continue': case 'discard': case 'return': return i.op
  }
}

function bodyLines(out: string[], m: LensModule, insts: readonly Inst[], indent: string): void {
  for (const i of insts) {
    out.push(`${indent}${instText(m, i)}`)
    if (i.op === 'if') {
      bodyLines(out, m, i.then, `${indent}  `)
      if (i.else.length > 0) {
        out.push(`${indent}else`)
        bodyLines(out, m, i.else, `${indent}  `)
      }
      out.push(`${indent}end`)
    } else if (i.op === 'loop') {
      bodyLines(out, m, i.body, `${indent}  `)
      out.push(`${indent}end`)
    }
  }
}

/** The listing of a module, one line per entry, each ending in a newline. Refuses (Fault `lens`) an invalid module. */
export function disassemble(module: LensModule): string {
  const m = checkedCopy(module)
  try {
    const out: string[] = [`lens ${m.stage}`, `group ${m.group.join(' ')}`, `ids ${m.ids}`]
    for (const p of m.inputs) out.push(`input ${p.slot} ${p.type}${p.flat === true ? ' flat' : ''}`)
    for (const p of m.outputs) out.push(`output ${p.slot} ${p.type}${p.flat === true ? ' flat' : ''}`)
    m.resources.forEach((r, i) => resourceLines(out, r, i))
    out.push('body')
    bodyLines(out, m, m.body, '  ')
    return `${out.join('\n')}\n`
  } catch (e) {
    if (isFault(e)) throw e
    return fail('lens', 'lens: module: the module could not be listed (listing it raised an error)')
  }
}
