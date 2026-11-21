// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is `test` (also written `[ ... ]`): the question an `if` or a `while` in the shell
 * asks. Is there such a file, is it a directory, may I read it, is this text empty, are these two texts the same,
 * is this number less than that one; joined by `!`, `-a`, `-o` and brackets. It answers with a status: 0 for yes,
 * 1 for no, 2 when the question itself is malformed (and says why on the error output).
 * What breaks if it is removed? `if` and `while` could only ask whether a whole command succeeded.
 */
import type { Sys } from './kernel.ts'
import type { Task } from './task.ts'

const UNARY = new Set(['-e', '-f', '-d', '-r', '-w', '-x', '-s', '-z', '-n', '-t'])
const BINARY = new Set(['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot'])

class Bad extends Error {}

class Reader {
  private readonly sys: Sys
  private readonly a: readonly string[]
  private i = 0
  private depth = 0

  constructor(sys: Sys, args: readonly string[]) {
    this.sys = sys
    this.a = args
  }

  get done(): boolean { return this.i >= this.a.length }

  *or(): Task<boolean> {
    if (++this.depth > 64) throw new Bad('nested too deep')
    let v = yield* this.and()
    while (this.a[this.i] === '-o') {
      this.i++
      const r = yield* this.and()
      v = v || r
    }
    this.depth--
    return v
  }

  private *and(): Task<boolean> {
    let v = yield* this.not()
    while (this.a[this.i] === '-a') {
      this.i++
      const r = yield* this.not()
      v = v && r
    }
    return v
  }

  /** Whether the word at `j` joins two questions or two texts (`=`, `-eq`, `-a` ...) and has a word after it. */
  private joins(j: number): boolean {
    const w = this.a[j]
    return w !== undefined && (BINARY.has(w) || w === '-a' || w === '-o') && j + 1 < this.a.length
  }

  private *not(): Task<boolean> {
    // A run of `!` is counted, not recursed into: a line can hold thousands of them. A `!` with a two-sided operator
    // and its right side after it is that question's left side, a text like any other (`[ "$a" = x ]` with a set to `!`).
    let flips = 0
    while (this.a[this.i] === '!' && this.i + 1 < this.a.length && !this.joins(this.i + 1)) {
      this.i++
      flips++
    }
    const v = yield* this.primary()
    return flips % 2 === 1 ? !v : v
  }

  /**
   * A whole number, exactly. Past 2^53 a number cannot be held exactly, and two long numbers would round equal, so
   * such a number is refused, as the shell's own sums refuse it.
   */
  private number(text: string): number {
    if (!/^[ \t]*[+-]?[0-9]+[ \t]*$/.test(text)) throw new Bad(`'${text}' is not a whole number`)
    const n = Number(text)
    if (!Number.isSafeInteger(n)) throw new Bad(`'${text.trim()}' is too large to be exact`)
    return n
  }

  private *primary(): Task<boolean> {
    const a = this.a
    if (this.i >= a.length) throw new Bad('an argument is missing')
    const first = a[this.i]
    const next = a[this.i + 1]
    // A two-sided question wins when the second word is its operator: `-f = -f` compares two texts.
    if (next !== undefined && BINARY.has(next) && this.i + 2 < a.length) {
      const right = a[this.i + 2]
      this.i += 3
      switch (next) {
        case '=': case '==': return first === right
        case '!=': return first !== right
        case '-eq': return this.number(first) === this.number(right)
        case '-ne': return this.number(first) !== this.number(right)
        case '-lt': return this.number(first) < this.number(right)
        case '-le': return this.number(first) <= this.number(right)
        case '-gt': return this.number(first) > this.number(right)
        case '-ge': return this.number(first) >= this.number(right)
        default: {
          const x = yield* this.mtime(first)
          const y = yield* this.mtime(right)
          if (next === '-nt') return x !== null && (y === null || x > y)
          return y !== null && (x === null || x < y)
        }
      }
    }
    // A `(` with nothing after it is a word: `[ "$x" ]` asks only whether the text is empty, whatever it says.
    if (first === '(' && next !== undefined) {
      this.i++
      const v = yield* this.or()
      if (a[this.i] !== ')') throw new Bad("'(' needs ')'")
      this.i++
      return v
    }
    if (UNARY.has(first) && next !== undefined) {
      this.i += 2
      switch (first) {
        case '-z': return next === ''
        case '-n': return next !== ''
        case '-t': return /^[0-9]+$/.test(next) && this.sys.isatty(Number(next))
        case '-e': return yield* this.sys.access(next, 0)
        case '-r': return yield* this.sys.access(next, 4)
        case '-w': return yield* this.sys.access(next, 2)
        case '-x': return yield* this.sys.access(next, 1)
        default: {
          let kind: string
          let size: number
          try {
            const st = yield* this.sys.stat(next)
            kind = st.kind
            size = st.size
          } catch {
            return false
          }
          if (first === '-f') return kind === 'file'
          if (first === '-d') return kind === 'dir'
          return size > 0
        }
      }
    }
    this.i++
    return first !== ''
  }

  private *mtime(path: string): Task<number | null> {
    try {
      return (yield* this.sys.stat(path)).mtime
    } catch {
      return null
    }
  }
}

/** The status of `test args...`: 0 yes, 1 no, 2 malformed (said on the error output as `name: why`). */
export function* evaluate(sys: Sys, name: string, args: readonly string[]): Task<number> {
  if (args.length === 0) return 1
  const r = new Reader(sys, args)
  try {
    const v = yield* r.or()
    if (!r.done) throw new Bad('too many arguments')
    return v ? 0 : 1
  } catch (e) {
    if (!(e instanceof Bad)) throw e
    yield* sys.eprint(`${name}: ${e.message}\n`)
    return 2
  }
}
