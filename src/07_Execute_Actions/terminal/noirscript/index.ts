// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is NoirScript's public face and its session: the console's second language, beside
 * R0, is statically typed, compiled to bytecode and run on a bounded VM over one memory arena, with 128- and
 * 256-bit lane types, branchless intrinsics and read-only typed access to the city's structure-of-arrays columns.
 * A session keeps the functions and globals every line declares and the arena they live in; `run` lexes, parses,
 * checks and compiles one line against them, installs what the line declared only if the whole line compiled,
 * takes one snapshot of the host's tables, and runs; `asm` compiles and lists the bytecode; `reset` forgets
 * everything. A line run with larger limits (the elite tier's) grows the arena for good: limits never shrink it,
 * so a later line still reaches every global; but each line adds globals and uses frames only within its own
 * limits' cells, so the larger arena is not a larger allowance for the lines that follow. Limits are made sane
 * before use (vm.ts saneLimits): a missing, non-finite or negative field falls back to the session's, and cells and
 * depth have hard caps. Nothing here throws: every failure is the `error` text of a result, an allocation that
 * fails is "memory exhausted", and a host write that re-enters `run` on the same session gets "session busy"
 * instead of corrupting the run in progress. The directory imports nothing from outside itself (the air gap), and
 * nothing in it reaches a clock, a random source, the network or the DOM.
 * What breaks if it is removed? The console's `noir` command has no language behind it.
 */
import type { Decl, FnSig } from './ast.ts'
import { NoirError } from './ast.ts'
import { compile } from './compiler.ts'
import { disassemble } from './disasm.ts'
import { INTRINSIC_NAMES } from './intrinsics.ts'
import { KEYWORDS, TYPE_NAMES } from './lexer.ts'
import { parse } from './parser.ts'
import { check } from './types.ts'
import type { Arena, CompiledFn, NoirHost, NoirLimits, NoirTables } from './vm.ts'
import { DEFAULT_LOCKED, EMPTY_TABLES, LIMITS, TABLE_NAMES, execute, makeArena, saneLimits } from './vm.ts'

export type { NoirColumns, NoirTables, NoirWrites, NoirHost, NoirLimits } from './vm.ts'
export { EMPTY_TABLES, LIMITS, ELITE_LIMITS } from './vm.ts'
export { KEYWORDS, TYPE_NAMES } from './lexer.ts'
export { INTRINSIC_NAMES } from './intrinsics.ts'
export { f32Text } from './format.ts'

/** What one line gave: the lines printed, the first error if any, the instructions it took, and the names it declared. */
export interface NoirResult { readonly out: string[]; readonly error?: string; readonly steps: number; readonly defined: readonly string[] }

const message = (e: unknown): string => (e instanceof NoirError ? e.message : `internal error: ${e instanceof Error ? e.message : String(e)}`)

/**
 * A NoirScript session: the functions and globals its lines have declared, and the arena they live in. Deterministic
 * (the same lines in the same order always give the same output) and bounded by its limits, which a `run` may
 * override for one line (the elite tier's larger ones, say).
 */
export class NoirSession {
  private readonly limits: NoirLimits
  private arena: Arena
  private globalTop = 0
  private readonly globals = new Map<string, Decl>()
  private readonly fnSigs = new Map<string, FnSig>()
  /** The function table CALL indexes; it only grows, so earlier code keeps the callees it was compiled against. */
  private readonly fns: CompiledFn[] = []
  private readonly user: string[] = []
  /** Set while a line runs, so a host write that calls `run` again meets "session busy" rather than the arena in use. */
  private running = false

  constructor(limits: NoirLimits = LIMITS) {
    this.limits = saneLimits(limits, LIMITS)
    this.arena = makeArena(this.limits.cells)
  }

  /** Compiles and runs one line (it may hold several statements and newlines). Never throws. */
  run(source: string, host?: NoirHost | null, limits?: NoirLimits): NoirResult {
    if (this.running) return { out: [], error: 'session busy: a host write re-entered run()', steps: 0, defined: [] }
    this.running = true
    try {
      return this.runLine(source, host, limits === undefined ? this.limits : saneLimits(limits, this.limits))
    } finally {
      this.running = false
    }
  }

  private runLine(source: string, host: NoirHost | null | undefined, lim: NoirLimits): NoirResult {
    let line
    try {
      this.ensureArena(lim.cells)
      line = compile(check(parse(source), { globals: this.globals, fns: this.fnSigs, nextFnIndex: this.fns.length }), { globalTop: this.globalTop, cells: this.arena.cells, lineCells: lim.cells })
    } catch (e) {
      return { out: [], error: message(e), steps: 0, defined: [] }
    }
    // The whole line compiled: install what it declared (named in the order written), then run it.
    for (const f of line.fns) {
      this.fns.push(f)
      this.fnSigs.set(f.name, { name: f.name, params: f.params, ret: f.ret, index: this.fns.length - 1 })
    }
    for (const g of line.globals) this.globals.set(g.name, g)
    const defined: string[] = []
    for (const name of line.defined) this.remember(name, defined)
    // New globals start at zero whatever their cells held as stack or table space, so a line that fails before its
    // `let` runs leaves a 0 behind, not a leftover of an earlier run.
    this.arena.i32.fill(0, this.globalTop, line.globalTop)
    this.globalTop = line.globalTop
    let tables: NoirTables = EMPTY_TABLES
    if (host !== undefined && host !== null) {
      try {
        tables = host.tables() ?? EMPTY_TABLES
      } catch (e) {
        return { out: [], error: e instanceof Error ? e.message : String(e), steps: 0, defined }
      }
    }
    // A `write` that is not an object (null, say) is no write surface: the intrinsics fail with the locked message.
    const write = host?.write
    const r = execute({ arena: this.arena, fns: this.fns, main: line.main, globalTop: this.globalTop, tables, write: typeof write === 'object' && write !== null ? write : undefined, locked: host?.locked ?? DEFAULT_LOCKED, limits: lim })
    return r.error === undefined ? { out: r.out, steps: r.steps, defined } : { out: r.out, error: r.error, steps: r.steps, defined }
  }

  /** Compiles only and returns the bytecode listing (or the compile error as `error`). Installs nothing. */
  asm(source: string): NoirResult {
    try {
      const line = compile(check(parse(source), { globals: this.globals, fns: this.fnSigs, nextFnIndex: this.fns.length }), { globalTop: this.globalTop, cells: this.arena.cells, lineCells: this.limits.cells })
      const callee = (index: number): CompiledFn | undefined => this.fns[index] ?? line.fns[index - this.fns.length]
      const out: string[] = []
      for (const f of line.fns) out.push(...disassemble(f, callee))
      out.push(...disassemble(line.main, callee))
      return { out, steps: 0, defined: [] }
    } catch (e) {
      return { out: [], error: message(e), steps: 0, defined: [] }
    }
  }

  /** Forgets every function and global and zeroes memory. */
  reset(): void {
    this.globals.clear()
    this.fnSigs.clear()
    this.fns.length = 0
    this.user.length = 0
    this.globalTop = 0
    this.arena.i32.fill(0)
  }

  /** The language: keywords, types, tables, intrinsics, then user fns and globals in order of definition. */
  words(): string[] {
    return [...KEYWORDS, ...TYPE_NAMES, ...TABLE_NAMES, ...INTRINSIC_NAMES, ...this.user]
  }

  private remember(name: string, defined: string[]): void {
    if (!this.user.includes(name)) this.user.push(name)
    if (!defined.includes(name)) defined.push(name)
  }

  /** A run with more cells than the arena has gets a larger arena holding the same globals; one the machine cannot give is "memory exhausted". */
  private ensureArena(cells: number): void {
    if (cells <= this.arena.cells) return
    let bigger: Arena
    try {
      bigger = makeArena(cells)
    } catch {
      throw new NoirError('memory exhausted')
    }
    bigger.i32.set(this.arena.i32.subarray(0, Math.min(this.globalTop, this.arena.cells)))
    this.arena = bigger
  }
}
