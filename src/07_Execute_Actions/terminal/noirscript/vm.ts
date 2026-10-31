// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is NoirScript's bytecode VM: the opcode set, the arena the programs run in, and the
 * interpreter loop that runs one compiled line against the session's functions and globals and a snapshot of the
 * city's columns. There is no JIT and no dynamic code: the VM is a switch over an Int32Array, bounded in steps,
 * output, memory and call depth, and it never throws out of `execute`.
 * What breaks if it is removed? Compiled NoirScript has nothing to run on.
 *
 * BYTECODE. A program is an Int32Array of instructions: an opcode, then its inline operands (OPERANDS says how
 * many). Arithmetic opcodes are typed (ADD_I32, ADD_U32, ADD_F32, LT_U32, SELECT ...) and carry a lane count as
 * their first operand (1 for a scalar, 4 or 8 for a vector), so one instruction is one step whatever its width and
 * the disassembler reads ADD_F32 with lanes 4 as ADD_F32X4. Constants: an integer, bool or f32 (as its bit pattern)
 * is inline in PUSH; strings live in the function's string pool and travel as pool indices; the types `print`
 * formats live in the function's type pool. Each function, and the line's top-level code ("<main>"), is a
 * CompiledFn with its own code, pools, parameter cells, frame size, operand-stack ceiling and return width. CALL
 * names the callee by its index in the session's function table, which only grows, so a function compiled on an
 * earlier line keeps calling the functions it was compiled against.
 *
 * ARENA. One ArrayBuffer of limits.cells 32-bit cells (the session's; a line run with larger limits grows it and
 * it never shrinks, so every run has the whole of it) with Int32Array, Uint32Array and Float32Array views over the
 * SAME bytes: an f32 is exact binary32 (every result is stored through the Float32Array, which rounds like
 * Math.fround), i32 and u32 are the same bits read two ways, and `select` on f32 is a bit operation. Layout, in
 * cells, growing up:
 *   [0, globalTop)            the session's globals: scalars and vectors, arrays 64-byte (16-cell) aligned
 *   [tableBase, tableTop)     this run's snapshot of the host's columns, each 16-cell aligned (structure of arrays)
 *   [stackBase, cells)        frames and the operand stack
 * A frame is [params][locals][operand stack ...]: the caller's arguments become the callee's first cells (CALL sets
 * fp = sp - paramCells), the locals follow, and the operand stack grows above them; RET copies the return value to
 * fp and sets sp just past it, so the value replaces the arguments on the caller's operand stack. The return
 * addresses live in a side array of (fn, pc, fp) records bounded by limits.depth. A value on the operand stack is
 * 1 cell (i32, u32, f32, bool, a str index, or a col: the column's id plus one, 0 naming no column, which the VM
 * resolves to this run's base and length through the register file, so a col bound on an earlier line reads the
 * current snapshot), 4 or 8 cells (a vector) or n*width cells (an array, by value). Memory is checked once per
 * call (the frame plus the function's operand ceiling must fit under the run's bound: the arena, and at most
 * limits.cells above the tables, so a line run with the default limits stays within them in an arena an elite line
 * grew) and once per table copy; the compiler computes the ceiling, so no push checks anything.
 *
 * TABLES. The host's columns are copied once at the start of a run (the run is a consistent snapshot and the host's
 * arrays are never written) and described by a small register file: each column's base and length, each table's
 * row count, and the kernel and frame scalars. A `query` compiles to a loop of QNEXT / QCOL ... / QACC, so one row
 * costs a few steps and a run over a million rows meets the step budget by name.
 *
 * BOUNDS. Every executed instruction is one step, and one that moves w cells (an array load, store, fill, copy or
 * return) costs w / 16 more, so the budget bounds the work and not only the instruction count; the step budget,
 * the output cap, the depth cap and the arena bound end a runaway program with a named error; every index into an
 * array, vector or column is checked; integer division by zero is an error; i32 wraps (| 0, Math.imul), u32 wraps
 * (>>> 0), f32 rounds after every operation. Limits reach `execute` sane (saneLimits): finite, non-negative, capped.
 */
import type { Ty } from './ast.ts'
import { NoirError, tyWidth } from './ast.ts'
import { formatCells } from './format.ts'

// ----------------------------------------------------------------------------------------------------
// The host surface

export interface NoirColumns { readonly n: number }
export interface NoirTables {
  readonly crowd: { readonly n: number; readonly x: Float32Array; readonly z: Float32Array }
  readonly cars: { readonly n: number; readonly x: Float32Array; readonly z: Float32Array; readonly heading: Float32Array; readonly speed: Float32Array; readonly mode: Int32Array }
  readonly kernel: { readonly law1: number; readonly law2: number; readonly law3: number; readonly flips: number; readonly shielded: boolean }
  readonly frame: { readonly fps: number; readonly ms: number; readonly p95: number }
}

const NONE_F32 = new Float32Array(0)
const NONE_I32 = new Int32Array(0)

/** Every n 0, every array empty, every scalar 0 or false. */
export const EMPTY_TABLES: NoirTables = Object.freeze({
  crowd: Object.freeze({ n: 0, x: NONE_F32, z: NONE_F32 }),
  cars: Object.freeze({ n: 0, x: NONE_F32, z: NONE_F32, heading: NONE_F32, speed: NONE_F32, mode: NONE_I32 }),
  kernel: Object.freeze({ law1: 0, law2: 0, law3: 0, flips: 0, shielded: false }),
  frame: Object.freeze({ fps: 0, ms: 0, p95: 0 }),
})

/** Writes the elite tier allows (absent: every write intrinsic fails with the host's reason). Each may throw: the message becomes the run's error. */
export interface NoirWrites {
  tune(key: string, value: number): number
  intent(car: number, throttle: number, brake: number, steer: number): boolean
  cull(density: number): number
  steer(feature: string, value: number): number
}

/** `locked`: the message a write intrinsic fails with when `write` is absent (default "elite tier locked"). */
export interface NoirHost { tables(): NoirTables; readonly write?: NoirWrites; readonly locked?: string }

export interface NoirLimits { readonly steps: number; readonly out: number; readonly cells: number; readonly depth: number }

export const LIMITS: NoirLimits = Object.freeze({ steps: 1_000_000, out: 16_384, cells: 262_144, depth: 1_024 })
export const ELITE_LIMITS: NoirLimits = Object.freeze({ steps: 50_000_000, out: 65_536, cells: 4_194_304, depth: 4_096 })

export const DEFAULT_LOCKED = 'elite tier locked'

/** The most cells any limits may ask for: 64 MiB, four times the elite tier's. */
export const MAX_CELLS = 16_777_216
/** The most frames any limits may ask for. */
export const MAX_DEPTH = 1_048_576

/**
 * `limits` made safe to run with: each field a non-negative integer, cells and depth within their caps, and a field
 * that is missing or not a finite number replaced by `base`'s. `base` itself is returned untouched.
 */
export function saneLimits(limits: Partial<NoirLimits> | null | undefined, base: NoirLimits): NoirLimits {
  if (limits === base) return base
  const field = (v: unknown, fallback: number, cap: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(Math.max(Math.floor(v), 0), cap) : fallback)
  return Object.freeze({
    steps: field(limits?.steps, base.steps, Number.MAX_SAFE_INTEGER),
    out: field(limits?.out, base.out, Number.MAX_SAFE_INTEGER),
    cells: field(limits?.cells, base.cells, MAX_CELLS),
    depth: field(limits?.depth, base.depth, MAX_DEPTH),
  })
}

/** The built-in tables by id; `crowd` and `cars` have rows, `kernel` and `frame` only scalars. */
export const TABLE_NAMES: readonly string[] = Object.freeze(['crowd', 'cars', 'kernel', 'frame'])

export interface ColumnInfo { readonly id: number; readonly table: number; readonly name: string; readonly elem: 'f32' | 'i32' }
/** The host columns, in the order they are copied into the arena. */
export const COLUMNS: readonly ColumnInfo[] = Object.freeze([
  { id: 0, table: 0, name: 'x', elem: 'f32' },
  { id: 1, table: 0, name: 'z', elem: 'f32' },
  { id: 2, table: 1, name: 'x', elem: 'f32' },
  { id: 3, table: 1, name: 'z', elem: 'f32' },
  { id: 4, table: 1, name: 'heading', elem: 'f32' },
  { id: 5, table: 1, name: 'speed', elem: 'f32' },
  { id: 6, table: 1, name: 'mode', elem: 'i32' },
])

export interface ScalarInfo { readonly id: number; readonly table: number; readonly name: string; readonly ty: 'i32' | 'bool' | 'f32' }
/** The host scalars (kernel and frame). */
export const SCALARS: readonly ScalarInfo[] = Object.freeze([
  { id: 0, table: 2, name: 'law1', ty: 'i32' },
  { id: 1, table: 2, name: 'law2', ty: 'i32' },
  { id: 2, table: 2, name: 'law3', ty: 'i32' },
  { id: 3, table: 2, name: 'flips', ty: 'i32' },
  { id: 4, table: 2, name: 'shielded', ty: 'bool' },
  { id: 5, table: 3, name: 'fps', ty: 'f32' },
  { id: 6, table: 3, name: 'ms', ty: 'f32' },
  { id: 7, table: 3, name: 'p95', ty: 'f32' },
])

/**
 * The register file: table row counts at 0..3, column (base, len) pairs from 4 (pair k is column k - 1; pair 0 stays
 * (0, 0), the column a zeroed col cell names), scalars from 20.
 */
const REG_N = 0
const REG_COL = 4
const REG_SCALAR = 20
const REG_COUNT = 32
/** A col cell's value, masked to the register file's eight pairs (a cell only ever holds what TABLE_COL put there, or 0). */
const COL_MASK = 7

// ----------------------------------------------------------------------------------------------------
// The opcodes

/** Every opcode. The comment gives the inline operands and the stack effect (`L` is the lane count operand). */
export const Op = Object.freeze({
  PUSH: 0, //              k            → k
  LOAD_LOCAL: 1, //        off w        → w cells of fp+off
  STORE_LOCAL: 2, //       off w        w cells → (into fp+off)
  LOAD_GLOBAL: 3, //       addr w
  STORE_GLOBAL: 4, //      addr w
  LOAD_LOCAL_ELEM: 5, //   off w n u    idx → elem (w cells); bounds checked against n; u = 1 names the index unsigned in the error
  STORE_LOCAL_ELEM: 6, //  off w n u    idx value →
  LOAD_GLOBAL_ELEM: 7, //  addr w n u
  STORE_GLOBAL_ELEM: 8, // addr w n u
  INDEX: 9, //             w n u        array(n*w) idx → elem
  FILL: 10, //             w n          value → n copies of it
  FILL_LOCAL: 11, //       off w n      value → (fills the local array)
  FILL_GLOBAL: 12, //      addr w n
  DUP: 13, //              w
  DROP: 14, //             w
  TABLE_COL: 15, //        id           → col (the id plus one)
  TABLE_N: 16, //          id           → n
  TABLE_SCALAR: 17, //     id           → bits
  COL_ELEM: 18, //         u            col idx → cell
  COL_LEN: 19, //                       col → len
  COL_LOAD: 20, //         L            col idx → L cells, zero past the end
  QNEXT: 21, //            row table end    jump to end when local[row] >= n(table)
  QCOL: 22, //             id row       → the column's cell at the row
  QACC: 23, //             count row    bool → ; count += bool, row += 1
  JMP: 24, //              a
  JMP_IF_NOT: 25, //       a            bool →
  JMP_IF: 26, //           a            bool →
  CALL: 27, //             fn           args → result
  RET: 28, //              w
  ADD_I32: 29, SUB_I32: 30, MUL_I32: 31, DIV_I32: 32, REM_I32: 33, NEG_I32: 34, //   L
  ADD_U32: 35, SUB_U32: 36, MUL_U32: 37, DIV_U32: 38, REM_U32: 39, //               L
  ADD_F32: 40, SUB_F32: 41, MUL_F32: 42, DIV_F32: 43, REM_F32: 44, NEG_F32: 45, //   L
  AND_32: 46, OR_32: 47, XOR_32: 48, NOT_32: 49, SHL_32: 50, SHR_I32: 51, SHR_U32: 52, // L
  NOT_BOOL: 53,
  EQ_32: 54, NE_32: 55, LT_I32: 56, LE_I32: 57, GT_I32: 58, GE_I32: 59, //            L (1: bool, else mask)
  LT_U32: 60, LE_U32: 61, GT_U32: 62, GE_U32: 63,
  EQ_F32: 64, NE_F32: 65, LT_F32: 66, LE_F32: 67, GT_F32: 68, GE_F32: 69,
  I32_TO_F32: 70, U32_TO_F32: 71, F32_TO_I32: 72, F32_TO_U32: 73, //                  L
  MIN_I32: 74, MAX_I32: 75, MIN_U32: 76, MAX_U32: 77, MIN_F32: 78, MAX_F32: 79, //    L
  ABS_I32: 80, ABS_F32: 81, //                                                        L
  CLAMP_I32: 82, CLAMP_U32: 83, CLAMP_F32: 84, //                                     L
  SQRT_F32: 85, FLOOR_F32: 86, CEIL_F32: 87, TRUNC_F32: 88, //                        L
  SELECT: 89, //           L            mask a b → b ^ ((a ^ b) & mask)
  MASK: 90, //                          bool → 0 or 0xFFFFFFFF
  POPCNT: 91, CLZ: 92, CTZ: 93, ROTL: 94, ROTR: 95, MORTON2: 96, DEMORTON2X: 97, DEMORTON2Y: 98,
  HSUM_F32: 99, HSUM_32: 100, HMIN_I32: 101, HMIN_U32: 102, HMIN_F32: 103, HMAX_I32: 104, HMAX_U32: 105, HMAX_F32: 106, // L
  ANY: 107, ALL: 108, //   L
  TUNE: 109, INTENT: 110, CULL: 111, STEER: 112,
  PRINT: 113, //           n t1..tn     the n values → ; one output line
} as const)

export type Opcode = (typeof Op)[keyof typeof Op]

/** Opcode names by number, for the disassembler. */
export const OP_NAMES: readonly string[] = Object.freeze((() => {
  const names: string[] = []
  for (const [name, code] of Object.entries(Op)) names[code] = name
  return names
})())

/** Inline operand count per opcode; -1 means the first operand is a count of further operands (PRINT). */
export const OPERANDS: Int8Array = (() => {
  const counts = new Int8Array(OP_NAMES.length).fill(1)
  const zero: Opcode[] = [Op.COL_LEN, Op.NOT_BOOL, Op.MASK, Op.POPCNT, Op.CLZ, Op.CTZ, Op.ROTL, Op.ROTR, Op.MORTON2, Op.DEMORTON2X, Op.DEMORTON2Y, Op.TUNE, Op.INTENT, Op.CULL, Op.STEER]
  const two: Opcode[] = [Op.LOAD_LOCAL, Op.STORE_LOCAL, Op.LOAD_GLOBAL, Op.STORE_GLOBAL, Op.FILL, Op.QCOL, Op.QACC]
  const three: Opcode[] = [Op.INDEX, Op.FILL_LOCAL, Op.FILL_GLOBAL, Op.QNEXT]
  const four: Opcode[] = [Op.LOAD_LOCAL_ELEM, Op.STORE_LOCAL_ELEM, Op.LOAD_GLOBAL_ELEM, Op.STORE_GLOBAL_ELEM]
  for (const o of zero) counts[o] = 0
  for (const o of two) counts[o] = 2
  for (const o of three) counts[o] = 3
  for (const o of four) counts[o] = 4
  counts[Op.PRINT] = -1
  return counts
})()

/** Opcodes whose first operand is a lane count (shown as an X4/X8 suffix by the disassembler). */
export const LANED: ReadonlySet<number> = new Set<number>((() => {
  const laned: number[] = [Op.COL_LOAD, Op.SELECT, Op.ANY, Op.ALL]
  for (let o = Op.ADD_I32; o <= Op.SHR_U32; o++) laned.push(o)
  for (let o = Op.EQ_32; o <= Op.HMAX_F32; o++) laned.push(o)
  return laned
})())

// ----------------------------------------------------------------------------------------------------
// Compiled code and the arena

/** One function's bytecode and what the VM needs to run it. The line's top-level code is one too, named <main>. */
export interface CompiledFn {
  readonly name: string
  readonly params: readonly Ty[]
  readonly ret: Ty
  readonly code: Int32Array
  readonly strs: readonly string[]
  readonly types: readonly Ty[]
  readonly paramCells: number
  /** Params and locals, in cells. */
  readonly frameSize: number
  /** The most cells the operand stack holds at once, from the compiler's depth tracking. */
  readonly maxStack: number
  readonly retCells: number
}

export interface Arena { readonly cells: number; readonly i32: Int32Array; readonly u32: Uint32Array; readonly f32: Float32Array }

export function makeArena(cells: number): Arena {
  const buf = new ArrayBuffer(cells * 4)
  return { cells, i32: new Int32Array(buf), u32: new Uint32Array(buf), f32: new Float32Array(buf) }
}

/** Rounds up to a 16-cell (64-byte) boundary. */
export const align16 = (cells: number): number => (cells + 15) & ~15

export interface RunInput {
  readonly arena: Arena
  readonly fns: readonly CompiledFn[]
  readonly main: CompiledFn
  readonly globalTop: number
  readonly tables: NoirTables
  readonly write: NoirWrites | undefined
  readonly locked: string
  readonly limits: NoirLimits
}

export interface RunOutput { readonly out: string[]; readonly error?: string; readonly steps: number }

function fail(message: string): never { throw new NoirError(message) }

/** A table's row count as the host states it: NaN and anything below one give 0; Infinity is as many as the columns hold. */
const rowsOf = (n: unknown): number => (typeof n === 'number' && n > 0 ? Math.floor(n) : 0)

/** Copies the tables into the arena above the globals and fills the register file; returns the first free cell. */
function snapshot(t: NoirTables, arena: Arena, globalTop: number, cells: number, regs: Int32Array, regsF32: Float32Array): number {
  const sources: ArrayLike<number>[] = [t.crowd.x, t.crowd.z, t.cars.x, t.cars.z, t.cars.heading, t.cars.speed, t.cars.mode]
  // A table has as many rows as its shortest column, so no column is ever read past its end.
  const rows = [rowsOf(t.crowd.n), rowsOf(t.cars.n), 0, 0]
  for (const c of COLUMNS) rows[c.table] = Math.min(rows[c.table]!, sources[c.id]?.length ?? 0)
  for (let i = 0; i < 4; i++) regs[REG_N + i] = rows[i]!
  let cur = align16(globalTop)
  for (const c of COLUMNS) {
    const n = rows[c.table]!
    if (cur + n > cells) fail('memory exhausted')
    const src = sources[c.id]!
    const view = c.elem === 'f32' ? arena.f32 : arena.i32
    if (ArrayBuffer.isView(src)) view.set((src as Float32Array).subarray(0, n), cur)
    else for (let i = 0; i < n; i++) view[cur + i] = Number(src[i])
    regs[REG_COL + 2 * (c.id + 1)] = cur
    regs[REG_COL + 2 * (c.id + 1) + 1] = n
    cur = align16(cur + n)
  }
  const k = t.kernel
  const f = t.frame
  const int = (x: unknown): number => (typeof x === 'number' ? x | 0 : 0)
  const flt = (x: unknown): number => (typeof x === 'number' ? x : 0)
  regs[REG_SCALAR + 0] = int(k.law1)
  regs[REG_SCALAR + 1] = int(k.law2)
  regs[REG_SCALAR + 2] = int(k.law3)
  regs[REG_SCALAR + 3] = int(k.flips)
  regs[REG_SCALAR + 4] = k.shielded ? 1 : 0
  regsF32[REG_SCALAR + 5] = flt(f.fps)
  regsF32[REG_SCALAR + 6] = flt(f.ms)
  regsF32[REG_SCALAR + 7] = flt(f.p95)
  return cur
}

/** `u` set names the index as the u32 it was (the same 32 bits read unsigned). */
const outOfBounds = (idx: number, len: number, u: number): never => fail(`index ${u !== 0 ? idx >>> 0 : idx} out of bounds (len ${len})`)

/** The low 16 bits of v spread to the even bit positions. */
function spread(v: number): number {
  v &= 0xffff
  v = (v | (v << 8)) & 0x00ff00ff
  v = (v | (v << 4)) & 0x0f0f0f0f
  v = (v | (v << 2)) & 0x33333333
  v = (v | (v << 1)) & 0x55555555
  return v
}

/** The even bits of v gathered into the low 16 bits. */
function gather(v: number): number {
  v &= 0x55555555
  v = (v | (v >>> 1)) & 0x33333333
  v = (v | (v >>> 2)) & 0x0f0f0f0f
  v = (v | (v >>> 4)) & 0x00ff00ff
  v = (v | (v >>> 8)) & 0x0000ffff
  return v
}

function popcount(v: number): number {
  v = v - ((v >>> 1) & 0x55555555)
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333)
  return (Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24)
}

const saturateI32 = (x: number): number => (x !== x ? 0 : x >= 2147483647 ? 2147483647 : x <= -2147483648 ? -2147483648 : Math.trunc(x))
const saturateU32 = (x: number): number => (x !== x ? 0 : x >= 4294967295 ? 4294967295 : x <= 0 ? 0 : Math.trunc(x))

/**
 * Runs `main` to its final RET. Never throws: a NoirError ends the run with its message; anything else (which the
 * compiler's invariants rule out, or an allocation the machine refuses) is reported as an internal error rather
 * than escaping.
 */
export function execute(input: RunInput): RunOutput {
  const { arena, fns, main, limits, write } = input
  const { i32, u32, f32 } = arena
  // The tables may use the whole arena (the session grew it to the largest `cells` it was asked for and keeps it);
  // the frames get at most this run's limits.cells above them, so a default line in a grown arena stays a default line.
  const cells = arena.cells
  let bound = cells
  const out: string[] = []
  let printed = 0
  let steps = 0
  const regBuf = new ArrayBuffer(REG_COUNT * 4)
  const regs = new Int32Array(regBuf)
  const regsF32 = new Float32Array(regBuf)
  const frameFn: CompiledFn[] = []
  let framePc = NONE_I32
  let frameFp = NONE_I32
  let depth = 0
  let fn = main
  let code = main.code
  let strs = main.strs
  let pc = 0
  let fp = 0
  let sp = 0
  const hostCall = <R>(call: () => R): R => {
    if (write === undefined) fail(input.locked)
    try {
      return call()
    } catch (e) {
      return fail(e instanceof Error ? e.message : String(e))
    }
  }
  const colLen = (cell: number): number => regs[REG_COL + 2 * (cell & COL_MASK) + 1]!
  /** The cost of moving `w` cells, taken before the move: a move the budget cannot cover is refused by name. */
  const charge = (w: number): void => {
    steps += w >> 4
    if (steps >= limits.steps) { steps = limits.steps; fail(`step budget exhausted (${limits.steps})`) }
  }
  try {
    framePc = new Int32Array(limits.depth)
    frameFp = new Int32Array(limits.depth)
    const tableTop = snapshot(input.tables, arena, input.globalTop, cells, regs, regsF32)
    fp = align16(tableTop)
    bound = Math.min(cells, fp + limits.cells)
    sp = fp + main.frameSize
    if (sp + main.maxStack > bound) fail('memory exhausted')
    for (;;) {
      if (steps >= limits.steps) fail(`step budget exhausted (${limits.steps})`)
      steps++
      const op = code[pc++]!
      switch (op) {
        case Op.PUSH: i32[sp++] = code[pc++]!; break
        // Moving w cells costs w >> 4 steps beyond the instruction's own (charge), so the budget bounds the copying too.
        case Op.LOAD_LOCAL: {
          const src = fp + code[pc++]!
          const w = code[pc++]!
          if (w > 15) charge(w)
          for (let k = 0; k < w; k++) i32[sp + k] = i32[src + k]!
          sp += w
          break
        }
        case Op.STORE_LOCAL: {
          const dst = fp + code[pc++]!
          const w = code[pc++]!
          if (w > 15) charge(w)
          sp -= w
          for (let k = 0; k < w; k++) i32[dst + k] = i32[sp + k]!
          break
        }
        case Op.LOAD_GLOBAL: {
          const src = code[pc++]!
          const w = code[pc++]!
          if (w > 15) charge(w)
          for (let k = 0; k < w; k++) i32[sp + k] = i32[src + k]!
          sp += w
          break
        }
        case Op.STORE_GLOBAL: {
          const dst = code[pc++]!
          const w = code[pc++]!
          if (w > 15) charge(w)
          sp -= w
          for (let k = 0; k < w; k++) i32[dst + k] = i32[sp + k]!
          break
        }
        case Op.LOAD_LOCAL_ELEM:
        case Op.LOAD_GLOBAL_ELEM: {
          const base = (op === Op.LOAD_LOCAL_ELEM ? fp : 0) + code[pc++]!
          const w = code[pc++]!
          const n = code[pc++]!
          const u = code[pc++]!
          const idx = i32[--sp]!
          if (idx < 0 || idx >= n) outOfBounds(idx, n, u)
          if (w > 15) charge(w)
          const src = base + idx * w
          for (let k = 0; k < w; k++) i32[sp + k] = i32[src + k]!
          sp += w
          break
        }
        case Op.STORE_LOCAL_ELEM:
        case Op.STORE_GLOBAL_ELEM: {
          const base = (op === Op.STORE_LOCAL_ELEM ? fp : 0) + code[pc++]!
          const w = code[pc++]!
          const n = code[pc++]!
          const u = code[pc++]!
          sp -= w
          const idx = i32[sp - 1]!
          if (idx < 0 || idx >= n) outOfBounds(idx, n, u)
          if (w > 15) charge(w)
          const dst = base + idx * w
          for (let k = 0; k < w; k++) i32[dst + k] = i32[sp + k]!
          sp--
          break
        }
        case Op.INDEX: {
          const w = code[pc++]!
          const n = code[pc++]!
          const u = code[pc++]!
          const idx = i32[--sp]!
          if (idx < 0 || idx >= n) outOfBounds(idx, n, u)
          if (w > 15) charge(w)
          const dst = sp - n * w
          const src = dst + idx * w
          for (let k = 0; k < w; k++) i32[dst + k] = i32[src + k]!
          sp = dst + w
          break
        }
        case Op.FILL: {
          const w = code[pc++]!
          const n = code[pc++]!
          charge(n * w)
          const src = sp - w
          for (let c = 1; c < n; c++) for (let k = 0; k < w; k++) i32[src + c * w + k] = i32[src + k]!
          sp = src + n * w
          break
        }
        case Op.FILL_LOCAL:
        case Op.FILL_GLOBAL: {
          const base = (op === Op.FILL_LOCAL ? fp : 0) + code[pc++]!
          const w = code[pc++]!
          const n = code[pc++]!
          charge(n * w)
          sp -= w
          for (let c = 0; c < n; c++) for (let k = 0; k < w; k++) i32[base + c * w + k] = i32[sp + k]!
          break
        }
        case Op.DUP: {
          const w = code[pc++]!
          if (w > 15) charge(w)
          for (let k = 0; k < w; k++) i32[sp + k] = i32[sp - w + k]!
          sp += w
          break
        }
        case Op.DROP: sp -= code[pc++]!; break
        case Op.TABLE_COL: i32[sp++] = code[pc++]! + 1; break
        case Op.TABLE_N: i32[sp++] = regs[REG_N + code[pc++]!]!; break
        case Op.TABLE_SCALAR: i32[sp++] = regs[REG_SCALAR + code[pc++]!]!; break
        case Op.COL_ELEM: {
          const u = code[pc++]!
          const idx = i32[--sp]!
          const reg = REG_COL + 2 * (i32[sp - 1]! & COL_MASK)
          const len = regs[reg + 1]!
          if (idx < 0 || idx >= len) outOfBounds(idx, len, u)
          i32[sp - 1] = i32[regs[reg]! + idx]!
          break
        }
        case Op.COL_LEN: i32[sp - 1] = colLen(i32[sp - 1]!); break
        case Op.COL_LOAD: {
          const L = code[pc++]!
          const idx = i32[--sp]!
          const reg = REG_COL + 2 * (i32[--sp]! & COL_MASK)
          const base = regs[reg]!
          const len = regs[reg + 1]!
          for (let k = 0; k < L; k++) {
            const j = idx + k
            i32[sp + k] = j >= 0 && j < len ? i32[base + j]! : 0
          }
          sp += L
          break
        }
        case Op.QNEXT: {
          const row = i32[fp + code[pc++]!]!
          const n = regs[REG_N + code[pc++]!]!
          const end = code[pc++]!
          if (row >= n) pc = end
          break
        }
        case Op.QCOL: {
          const base = regs[REG_COL + 2 * (code[pc++]! + 1)]!
          const row = i32[fp + code[pc++]!]!
          i32[sp++] = i32[base + row]!
          break
        }
        case Op.QACC: {
          const count = fp + code[pc++]!
          const row = fp + code[pc++]!
          i32[count] = (i32[count]! + i32[--sp]!) | 0
          i32[row] = (i32[row]! + 1) | 0
          break
        }
        case Op.JMP: pc = code[pc]!; break
        case Op.JMP_IF_NOT: {
          const a = code[pc++]!
          if (i32[--sp] === 0) pc = a
          break
        }
        case Op.JMP_IF: {
          const a = code[pc++]!
          if (i32[--sp] !== 0) pc = a
          break
        }
        case Op.CALL: {
          const callee = fns[code[pc++]!]!
          if (depth >= limits.depth) fail(`stack overflow (depth ${limits.depth})`)
          const newFp = sp - callee.paramCells
          const newSp = newFp + callee.frameSize
          if (newSp + callee.maxStack > bound) fail('memory exhausted')
          frameFn[depth] = fn
          framePc[depth] = pc
          frameFp[depth] = fp
          depth++
          fn = callee
          code = callee.code
          strs = callee.strs
          pc = 0
          fp = newFp
          sp = newSp
          break
        }
        case Op.RET: {
          const w = code[pc]!
          if (w > 15) charge(w)
          const src = sp - w
          for (let k = 0; k < w; k++) i32[fp + k] = i32[src + k]!
          sp = fp + w
          if (depth === 0) return { out, steps }
          depth--
          fn = frameFn[depth]!
          code = fn.code
          strs = fn.strs
          pc = framePc[depth]!
          fp = frameFp[depth]!
          break
        }
        // Arithmetic: a binary op reads a (lower) and b (upper), writes a, drops b.
        case Op.ADD_I32: case Op.ADD_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = (i32[a + k]! + i32[b + k]!) | 0; sp = b; break }
        case Op.SUB_I32: case Op.SUB_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = (i32[a + k]! - i32[b + k]!) | 0; sp = b; break }
        case Op.MUL_I32: case Op.MUL_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = Math.imul(i32[a + k]!, i32[b + k]!); sp = b; break }
        case Op.DIV_I32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) { const d = i32[b + k]!; if (d === 0) fail('division by zero'); i32[a + k] = (i32[a + k]! / d) | 0 } sp = b; break }
        case Op.REM_I32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) { const d = i32[b + k]!; if (d === 0) fail('division by zero'); i32[a + k] = (i32[a + k]! % d) | 0 } sp = b; break }
        case Op.DIV_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) { const d = u32[b + k]!; if (d === 0) fail('division by zero'); u32[a + k] = (u32[a + k]! / d) >>> 0 } sp = b; break }
        case Op.REM_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) { const d = u32[b + k]!; if (d === 0) fail('division by zero'); u32[a + k] = u32[a + k]! % d } sp = b; break }
        case Op.NEG_I32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) i32[a + k] = -i32[a + k]! | 0; break }
        case Op.ADD_F32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) f32[a + k] = f32[a + k]! + f32[b + k]!; sp = b; break }
        case Op.SUB_F32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) f32[a + k] = f32[a + k]! - f32[b + k]!; sp = b; break }
        case Op.MUL_F32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) f32[a + k] = f32[a + k]! * f32[b + k]!; sp = b; break }
        case Op.DIV_F32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) f32[a + k] = f32[a + k]! / f32[b + k]!; sp = b; break }
        case Op.REM_F32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) f32[a + k] = f32[a + k]! % f32[b + k]!; sp = b; break }
        case Op.NEG_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = -f32[a + k]!; break }
        case Op.AND_32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! & i32[b + k]!; sp = b; break }
        case Op.OR_32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! | i32[b + k]!; sp = b; break }
        case Op.XOR_32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! ^ i32[b + k]!; sp = b; break }
        case Op.NOT_32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) i32[a + k] = ~i32[a + k]!; break }
        case Op.SHL_32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! << (i32[b + k]! & 31); sp = b; break }
        case Op.SHR_I32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! >> (i32[b + k]! & 31); sp = b; break }
        case Op.SHR_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) u32[a + k] = u32[a + k]! >>> (u32[b + k]! & 31); sp = b; break }
        case Op.NOT_BOOL: i32[sp - 1] = i32[sp - 1]! ^ 1; break
        // Comparisons: a scalar gives 0/1 (bool); a vector gives a lane mask of 0 / 0xFFFFFFFF.
        case Op.EQ_32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k] === i32[b + k] ? t : 0; sp = b; break }
        case Op.NE_32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k] !== i32[b + k] ? t : 0; sp = b; break }
        case Op.LT_I32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! < i32[b + k]! ? t : 0; sp = b; break }
        case Op.LE_I32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! <= i32[b + k]! ? t : 0; sp = b; break }
        case Op.GT_I32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! > i32[b + k]! ? t : 0; sp = b; break }
        case Op.GE_I32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = i32[a + k]! >= i32[b + k]! ? t : 0; sp = b; break }
        case Op.LT_U32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = u32[a + k]! < u32[b + k]! ? t : 0; sp = b; break }
        case Op.LE_U32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = u32[a + k]! <= u32[b + k]! ? t : 0; sp = b; break }
        case Op.GT_U32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = u32[a + k]! > u32[b + k]! ? t : 0; sp = b; break }
        case Op.GE_U32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = u32[a + k]! >= u32[b + k]! ? t : 0; sp = b; break }
        case Op.EQ_F32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = f32[a + k] === f32[b + k] ? t : 0; sp = b; break }
        case Op.NE_F32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = f32[a + k] !== f32[b + k] ? t : 0; sp = b; break }
        case Op.LT_F32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = f32[a + k]! < f32[b + k]! ? t : 0; sp = b; break }
        case Op.LE_F32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = f32[a + k]! <= f32[b + k]! ? t : 0; sp = b; break }
        case Op.GT_F32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = f32[a + k]! > f32[b + k]! ? t : 0; sp = b; break }
        case Op.GE_F32: { const L = code[pc++]!; const b = sp - L, a = b - L, t = L === 1 ? 1 : -1; for (let k = 0; k < L; k++) i32[a + k] = f32[a + k]! >= f32[b + k]! ? t : 0; sp = b; break }
        // Casts, lane-wise in place.
        case Op.I32_TO_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = i32[a + k]!; break }
        case Op.U32_TO_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = u32[a + k]!; break }
        case Op.F32_TO_I32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) i32[a + k] = saturateI32(f32[a + k]!); break }
        case Op.F32_TO_U32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) u32[a + k] = saturateU32(f32[a + k]!); break }
        // Intrinsics.
        case Op.MIN_I32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) if (i32[b + k]! < i32[a + k]!) i32[a + k] = i32[b + k]!; sp = b; break }
        case Op.MAX_I32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) if (i32[b + k]! > i32[a + k]!) i32[a + k] = i32[b + k]!; sp = b; break }
        case Op.MIN_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) if (u32[b + k]! < u32[a + k]!) u32[a + k] = u32[b + k]!; sp = b; break }
        case Op.MAX_U32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) if (u32[b + k]! > u32[a + k]!) u32[a + k] = u32[b + k]!; sp = b; break }
        case Op.MIN_F32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) f32[a + k] = Math.min(f32[a + k]!, f32[b + k]!); sp = b; break }
        case Op.MAX_F32: { const L = code[pc++]!; const b = sp - L, a = b - L; for (let k = 0; k < L; k++) f32[a + k] = Math.max(f32[a + k]!, f32[b + k]!); sp = b; break }
        case Op.ABS_I32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) { const x = i32[a + k]!; i32[a + k] = (x < 0 ? -x : x) | 0 } break }
        case Op.ABS_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = Math.abs(f32[a + k]!); break }
        case Op.CLAMP_I32: { const L = code[pc++]!; const hi = sp - L, lo = hi - L, x = lo - L; for (let k = 0; k < L; k++) { let v = i32[x + k]!; if (v < i32[lo + k]!) v = i32[lo + k]!; if (v > i32[hi + k]!) v = i32[hi + k]!; i32[x + k] = v } sp = lo; break }
        case Op.CLAMP_U32: { const L = code[pc++]!; const hi = sp - L, lo = hi - L, x = lo - L; for (let k = 0; k < L; k++) { let v = u32[x + k]!; if (v < u32[lo + k]!) v = u32[lo + k]!; if (v > u32[hi + k]!) v = u32[hi + k]!; u32[x + k] = v } sp = lo; break }
        case Op.CLAMP_F32: { const L = code[pc++]!; const hi = sp - L, lo = hi - L, x = lo - L; for (let k = 0; k < L; k++) f32[x + k] = Math.min(Math.max(f32[x + k]!, f32[lo + k]!), f32[hi + k]!); sp = lo; break }
        case Op.SQRT_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = Math.sqrt(f32[a + k]!); break }
        case Op.FLOOR_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = Math.floor(f32[a + k]!); break }
        case Op.CEIL_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = Math.ceil(f32[a + k]!); break }
        case Op.TRUNC_F32: { const L = code[pc++]!; const a = sp - L; for (let k = 0; k < L; k++) f32[a + k] = Math.trunc(f32[a + k]!); break }
        case Op.SELECT: {
          // Branchless on the bit patterns: b ^ ((a ^ b) & mask), whatever the lane type.
          const L = code[pc++]!
          const b = sp - L, a = b - L, m = a - L
          for (let k = 0; k < L; k++) i32[m + k] = i32[b + k]! ^ ((i32[a + k]! ^ i32[b + k]!) & i32[m + k]!)
          sp = a
          break
        }
        case Op.MASK: i32[sp - 1] = -i32[sp - 1]!; break
        case Op.POPCNT: i32[sp - 1] = popcount(i32[sp - 1]!); break
        case Op.CLZ: i32[sp - 1] = Math.clz32(i32[sp - 1]!); break
        case Op.CTZ: { const x = i32[sp - 1]!; i32[sp - 1] = x === 0 ? 32 : 31 - Math.clz32(x & -x); break }
        case Op.ROTL: { const n = i32[--sp]! & 31; const x = i32[sp - 1]!; i32[sp - 1] = (x << n) | (x >>> ((32 - n) & 31)); break }
        case Op.ROTR: { const n = i32[--sp]! & 31; const x = i32[sp - 1]!; i32[sp - 1] = (x >>> n) | (x << ((32 - n) & 31)); break }
        case Op.MORTON2: { const y = i32[--sp]!; i32[sp - 1] = spread(i32[sp - 1]!) | (spread(y) << 1); break }
        case Op.DEMORTON2X: i32[sp - 1] = gather(i32[sp - 1]!); break
        case Op.DEMORTON2Y: i32[sp - 1] = gather(i32[sp - 1]! >>> 1); break
        case Op.HSUM_F32: { const L = code[pc++]!; const a = sp - L; let s = f32[a]!; for (let k = 1; k < L; k++) s = Math.fround(s + f32[a + k]!); f32[a] = s; sp = a + 1; break }
        case Op.HSUM_32: { const L = code[pc++]!; const a = sp - L; let s = 0; for (let k = 0; k < L; k++) s = (s + i32[a + k]!) | 0; i32[a] = s; sp = a + 1; break }
        case Op.HMIN_I32: { const L = code[pc++]!; const a = sp - L; let s = i32[a]!; for (let k = 1; k < L; k++) if (i32[a + k]! < s) s = i32[a + k]!; i32[a] = s; sp = a + 1; break }
        case Op.HMAX_I32: { const L = code[pc++]!; const a = sp - L; let s = i32[a]!; for (let k = 1; k < L; k++) if (i32[a + k]! > s) s = i32[a + k]!; i32[a] = s; sp = a + 1; break }
        case Op.HMIN_U32: { const L = code[pc++]!; const a = sp - L; let s = u32[a]!; for (let k = 1; k < L; k++) if (u32[a + k]! < s) s = u32[a + k]!; u32[a] = s; sp = a + 1; break }
        case Op.HMAX_U32: { const L = code[pc++]!; const a = sp - L; let s = u32[a]!; for (let k = 1; k < L; k++) if (u32[a + k]! > s) s = u32[a + k]!; u32[a] = s; sp = a + 1; break }
        case Op.HMIN_F32: { const L = code[pc++]!; const a = sp - L; let s = f32[a]!; for (let k = 1; k < L; k++) s = Math.min(s, f32[a + k]!); f32[a] = s; sp = a + 1; break }
        case Op.HMAX_F32: { const L = code[pc++]!; const a = sp - L; let s = f32[a]!; for (let k = 1; k < L; k++) s = Math.max(s, f32[a + k]!); f32[a] = s; sp = a + 1; break }
        case Op.ANY: { const L = code[pc++]!; const a = sp - L; let r = 0; for (let k = 0; k < L; k++) if (i32[a + k] !== 0) r = 1; i32[a] = r; sp = a + 1; break }
        case Op.ALL: { const L = code[pc++]!; const a = sp - L; let r = 1; for (let k = 0; k < L; k++) if (i32[a + k] === 0) r = 0; i32[a] = r; sp = a + 1; break }
        case Op.TUNE: {
          const key = strs[i32[sp - 2]!] ?? ''
          const v = f32[sp - 1]!
          const r = hostCall(() => write!.tune(key, v))
          f32[sp - 2] = Number(r)
          sp--
          break
        }
        case Op.INTENT: {
          const car = i32[sp - 4]!
          const r = hostCall(() => write!.intent(car, f32[sp - 3]!, f32[sp - 2]!, f32[sp - 1]!))
          i32[sp - 4] = r ? 1 : 0
          sp -= 3
          break
        }
        case Op.CULL: {
          const d = f32[sp - 1]!
          const r = hostCall(() => write!.cull(d))
          f32[sp - 1] = Number(r)
          break
        }
        case Op.STEER: {
          const feature = strs[i32[sp - 2]!] ?? ''
          const v = f32[sp - 1]!
          const r = hostCall(() => write!.steer(feature, v))
          f32[sp - 2] = Number(r)
          sp--
          break
        }
        case Op.PRINT: {
          const n = code[pc++]!
          const types = fn.types
          let total = 0
          for (let k = 0; k < n; k++) total += tyWidth(types[code[pc + k]!]!)
          let at = sp - total
          const parts: string[] = []
          for (let k = 0; k < n; k++) {
            const t = types[code[pc++]!]!
            parts.push(formatCells(t, at, arena, strs, colLen))
            at += tyWidth(t)
          }
          sp -= total
          const line = parts.join(' ')
          printed += line.length + 1
          if (printed > limits.out) fail(`output limit exhausted (${limits.out})`)
          out.push(line)
          break
        }
        default: fail(`internal error: bad opcode ${op}`)
      }
    }
  } catch (e) {
    const error = e instanceof NoirError ? e.message : `internal error: ${e instanceof Error ? e.message : String(e)}`
    return { out, error, steps }
  }
}
