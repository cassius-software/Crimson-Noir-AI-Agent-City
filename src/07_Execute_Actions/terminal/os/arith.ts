// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It works out the sums the shell writes as `$(( ... ))`: whole numbers, the names of
 * variables (an unset or empty one counts as 0), `+ - * / %`, comparisons, `!`, `&&`, `||`, `? :` (each works out only
 * the side it takes), brackets, and `name = sum` to store a result. It is a small recursive-descent reader over the
 * text, with every result checked: a division by zero, a number too large to be exact, or text that is no sum is
 * refused by name instead of giving a wrong answer. A loop counter (`i=$((i+1))`) is the reason it exists.
 * What breaks if it is removed? The shell cannot count: a `while` loop has no way to end after a number of turns.
 */

/** What a sum reads and writes: the shell's variables. */
export interface Names {
  get(name: string): string | undefined
  set(name: string, value: string): void
}

/** A sum that cannot be worked out: the message says why. */
export class SumError extends Error {}

const DEPTH_MAX = 64
/** How many variables a sum follows, each naming the next, before it gives up. */
const HOPS_MAX = 8

class Reader {
  private readonly s: string
  private readonly names: Names
  private i = 0
  private depth = 0
  /** How many variables were followed to reach this text. */
  private hops = 0
  /** Above 0 inside a side of `&&`, `||` or `? :` that is not taken: it is read, not worked out (no refusal, nothing stored). */
  private skip = 0

  constructor(text: string, names: Names) {
    this.s = text
    this.names = names
  }

  private blanks(): void {
    while (this.i < this.s.length && (this.s[this.i] === ' ' || this.s[this.i] === '\t' || this.s[this.i] === '\n')) this.i++
  }

  private take(op: string): boolean {
    this.blanks()
    if (!this.s.startsWith(op, this.i)) return false
    // `<` must not take the first half of `<=`, nor `=` the first half of `==`, nor `!` of `!=`, nor `&`/`|` alone.
    const next = this.s[this.i + op.length]
    if ((op === '<' || op === '>' || op === '=' || op === '!') && next === '=') return false
    this.i += op.length
    return true
  }

  private whole(n: number): number {
    if (Number.isSafeInteger(n)) return n
    if (this.skip > 0) return 0
    throw new SumError('a number too large to be exact')
  }

  private valueOf(name: string): number {
    if (this.skip > 0) return 0
    const text = (this.names.get(name) ?? '').trim()
    if (text === '') return 0
    if (/^[+-]?[0-9]+$/.test(text)) return this.whole(Number(text))
    // A variable may name another, or hold a sum: follow it a few steps, never in a ring.
    if (this.hops >= HOPS_MAX) throw new SumError(`'${name}' never comes to a number`)
    const inner = new Reader(text, this.names)
    inner.depth = this.depth + 1
    inner.hops = this.hops + 1
    return inner.all()
  }

  /** One side of `&&`, `||` or `? :`: worked out when it is `taken`, otherwise only read (and counted as 0). */
  private side(taken: boolean, read: () => number): number {
    if (taken) return read()
    this.skip++
    read()
    this.skip--
    return 0
  }

  all(): number {
    const v = this.ternary()
    this.blanks()
    if (this.i < this.s.length) throw new SumError(`'${this.s.slice(this.i).trim()}' is not part of a sum`)
    return v
  }

  private ternary(): number {
    if (++this.depth > DEPTH_MAX) throw new SumError('a sum nested too deep')
    // name = sum
    this.blanks()
    const m = /^([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(?!=)/.exec(this.s.slice(this.i))
    if (m !== null) {
      this.i += m[0].length
      const v = this.ternary()
      if (this.skip === 0) this.names.set(m[1], String(v))
      this.depth--
      return v
    }
    const cond = this.or()
    if (this.take('?')) {
      const a = this.side(cond !== 0, () => this.ternary())
      if (!this.take(':')) throw new SumError("'?' needs ':'")
      const b = this.side(cond === 0, () => this.ternary())
      this.depth--
      return cond !== 0 ? a : b
    }
    this.depth--
    return cond
  }

  private or(): number {
    let v = this.and()
    while (this.take('||')) { const r = this.side(v === 0, () => this.and()); v = v !== 0 || r !== 0 ? 1 : 0 }
    return v
  }

  private and(): number {
    let v = this.equal()
    while (this.take('&&')) { const r = this.side(v !== 0, () => this.equal()); v = v !== 0 && r !== 0 ? 1 : 0 }
    return v
  }

  private equal(): number {
    let v = this.compare()
    for (;;) {
      if (this.take('==')) v = v === this.compare() ? 1 : 0
      else if (this.take('!=')) v = v !== this.compare() ? 1 : 0
      else return v
    }
  }

  private compare(): number {
    let v = this.sum()
    for (;;) {
      if (this.take('<=')) v = v <= this.sum() ? 1 : 0
      else if (this.take('>=')) v = v >= this.sum() ? 1 : 0
      else if (this.take('<')) v = v < this.sum() ? 1 : 0
      else if (this.take('>')) v = v > this.sum() ? 1 : 0
      else return v
    }
  }

  private sum(): number {
    let v = this.product()
    for (;;) {
      if (this.take('+')) v = this.whole(v + this.product())
      else if (this.take('-')) v = this.whole(v - this.product())
      else return v
    }
  }

  private product(): number {
    let v = this.unary()
    for (;;) {
      if (this.take('*')) v = this.whole(v * this.unary())
      else if (this.take('/')) {
        const d = this.unary()
        if (d === 0 && this.skip === 0) throw new SumError('division by zero')
        v = d === 0 ? 0 : Math.trunc(v / d)
      } else if (this.take('%')) {
        const d = this.unary()
        if (d === 0 && this.skip === 0) throw new SumError('division by zero')
        v = d === 0 ? 0 : v % d
      } else return v
    }
  }

  private unary(): number {
    if (++this.depth > DEPTH_MAX) throw new SumError('a sum nested too deep')
    let v: number
    if (this.take('-')) v = this.whole(-this.unary())
    else if (this.take('+')) v = this.unary()
    else if (this.take('!')) v = this.unary() === 0 ? 1 : 0
    else v = this.atom()
    this.depth--
    return v
  }

  private atom(): number {
    this.blanks()
    if (this.take('(')) {
      const v = this.ternary()
      if (!this.take(')')) throw new SumError("'(' needs ')'")
      return v
    }
    const rest = this.s.slice(this.i)
    const num = /^(?:0[xX][0-9a-fA-F]+|[0-9]+)/.exec(rest)
    if (num !== null) {
      this.i += num[0].length
      return this.whole(Number(num[0]))
    }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(rest)
    if (name !== null) {
      this.i += name[0].length
      return this.valueOf(name[0])
    }
    throw new SumError(rest.trim() === '' ? 'a sum ends too soon' : `'${rest.trim()}' is not part of a sum`)
  }
}

/** The value of a sum. Throws SumError when it has none. */
export function sum(text: string, names: Names): number {
  if (text.trim() === '') return 0
  return new Reader(text, names).all()
}
