// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how NoirScript values become console text: integers in decimal, booleans as
 * words, f32 as the shortest decimal that rounds back to the same binary32 (so `0.1` prints as `0.1`, not as the
 * double it is not; written the way JS writes a number, so magnitudes below 1e-6 and from 1e21 take exponent form,
 * `1e-7` and `3.4028235e+38`, which is the pinned decision where the spec asks for a plain decimal), vectors as
 * `f32x4(1, 2.5, 0, -1)`, arrays as `[1, 2, 3]` with a cap of 64 shown elements, columns as `col<f32>[n]` with the
 * column's length in this run's snapshot (a col cell holds the column's id, which the VM resolves), and strings as
 * written. Values are read straight out of the arena's cell views, so a u32 is read unsigned and an f32 exact,
 * without the VM copying anything first.
 * What breaks if it is removed? `print` has nothing to say, and f32 would print as a 17-digit double.
 */
import type { Ty } from './ast.ts'
import { tyWidth } from './ast.ts'

/** How many elements of an array are printed before `, ... (N more)`. */
export const SHOWN_ELEMENTS = 64

/**
 * The shortest decimal (1 to 9 significant digits) whose f32 rounding is `x`, written as JS writes a number (a plain
 * decimal from 1e-6 below 1e21, exponent form outside); `NaN`, `inf` and `-inf` for the specials. Signed zero prints as `0`.
 */
export function f32Text(x: number): string {
  if (x !== x) return 'NaN'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  if (x === 0) return '0'
  const v = Math.fround(x)
  for (let p = 1; p <= 9; p++) {
    const text = v.toPrecision(p)
    const back = Number(text)
    if (Math.fround(back) === v) return String(back)
  }
  return String(v)
}

/** The cell views of the arena the values live in; the string pool resolves `str` cells. */
export interface CellViews {
  readonly i32: Int32Array
  readonly u32: Uint32Array
  readonly f32: Float32Array
}

/** Formats the value of type `t` whose first cell is `at`; `colLen` gives a column's length from the cell a col holds. */
export function formatCells(t: Ty, at: number, m: CellViews, strs: readonly string[], colLen: (cell: number) => number): string {
  switch (t.kind) {
    case 'i32': return String(m.i32[at]!)
    case 'u32': return String(m.u32[at]!)
    case 'f32': return f32Text(m.f32[at]!)
    case 'bool': return m.i32[at] !== 0 ? 'true' : 'false'
    case 'void': return ''
    case 'str': return strs[m.i32[at]!] ?? ''
    case 'f32x4': return `f32x4(${lanes(at, 4, (k) => f32Text(m.f32[k]!))})`
    case 'i32x4': return `i32x4(${lanes(at, 4, (k) => String(m.i32[k]!))})`
    case 'u32x4': return `u32x4(${lanes(at, 4, (k) => String(m.u32[k]!))})`
    case 'u32x8': return `u32x8(${lanes(at, 8, (k) => String(m.u32[k]!))})`
    case 'col': return `col<${t.elem}>[${colLen(m.i32[at]!)}]`
    case 'array': {
      const w = tyWidth(t.elem)
      const shown = Math.min(t.n, SHOWN_ELEMENTS)
      const parts: string[] = []
      for (let i = 0; i < shown; i++) parts.push(formatCells(t.elem, at + i * w, m, strs, colLen))
      const more = t.n - shown
      return `[${parts.join(', ')}${more > 0 ? `, ... (${more} more)` : ''}]`
    }
  }
}

function lanes(at: number, n: number, one: (cell: number) => string): string {
  const parts: string[] = []
  for (let k = 0; k < n; k++) parts.push(one(at + k))
  return parts.join(', ')
}
