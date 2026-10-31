// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It turns a line of NoirScript into tokens, each carrying its 1-based line and column
 * so every later error can point at its source. It knows the keywords, the type names, the two comment forms,
 * integer literals in decimal, hex and binary with `_` separators and the `u` suffix, float literals with an
 * exponent and the `f` suffix, and strings with four escapes. It refuses, by name and position, the characters
 * and literals the language has no meaning for; it never throws anything but a NoirError.
 * What breaks if it is removed? The parser has nothing to read, and no error could name a line and column.
 */

import { NoirError } from './ast.ts'

export const KEYWORDS: readonly string[] = Object.freeze(['fn', 'let', 'mut', 'if', 'else', 'while', 'for', 'in', 'loop', 'break', 'continue', 'return', 'true', 'false', 'as', 'query', 'where'])
export const TYPE_NAMES: readonly string[] = Object.freeze(['i32', 'u32', 'f32', 'bool', 'void', 'f32x4', 'i32x4', 'u32x4', 'u32x8', 'col'])

export type TokKind = 'int' | 'float' | 'str' | 'ident' | 'kw' | 'type' | 'op' | 'eof'

/** One token. `value` holds a number's value (an integer as a non-negative double, a float already rounded to f32)
 *  or a string's decoded text; `suffixed` marks a `u` integer. */
export interface Token {
  readonly kind: TokKind
  readonly text: string
  readonly value: number
  readonly str: string
  readonly suffixed: boolean
  readonly line: number
  readonly col: number
}

/** Longest operators first, so `<<=` wins over `<<` and `<`. */
const OPERATORS: readonly string[] = Object.freeze([
  '<<=', '>>=', '..=',
  '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<', '>>', '->', '..', '::',
  '+', '-', '*', '/', '%', '&', '|', '^', '~', '!', '<', '>', '=', '.', ',', ';', ':', '(', ')', '{', '}', '[', ']',
])

const isDigit = (c: string): boolean => c >= '0' && c <= '9'
const isIdentStart = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_'
const isIdentPart = (c: string): boolean => isIdentStart(c) || isDigit(c)
const isHex = (c: string): boolean => isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')

/** A positioned error: every message of the front end starts with `line:col:`. */
export const at = (line: number, col: number, message: string): NoirError => new NoirError(`${line}:${col}: ${message}`)

/** The token's text as an error names it. */
export function describe(t: Token): string {
  return t.kind === 'eof' ? 'end of input' : `'${t.text}'`
}

/** Tokenizes a whole source text; the last token is always `eof`. */
export function lex(src: string): Token[] {
  const out: Token[] = []
  let i = 0
  let line = 1
  let lineStart = 0
  const n = src.length
  const tok = (kind: TokKind, text: string, startLine: number, startCol: number, value = 0, str = '', suffixed = false): void => {
    out.push({ kind, text, value, str, suffixed, line: startLine, col: startCol })
  }
  /** A run of digits (by `isD`) with `_` separators, each between two digits; gives the digits without them. */
  const digitRun = (isD: (c: string) => boolean, what: string, start: number, startLine: number, startCol: number): string => {
    const from = i
    let digits = ''
    while (i < n && (isD(src[i]!) || src[i] === '_')) {
      if (src[i] === '_') {
        if (i === from || !isD(src[i - 1]!) || !isD(src[i + 1] ?? '')) throw at(startLine, startCol, `malformed ${what} literal '${src.slice(start, i + 1)}'`)
      } else digits += src[i]
      i++
    }
    return digits
  }
  while (i < n) {
    const c = src[i]!
    const col = i - lineStart + 1
    if (c === '\n') { i++; line++; lineStart = i; continue }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue }
    if (c === '/' && src[i + 1] === '/') {
      while (i < n && src[i] !== '\n') i++
      continue
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      if (end < 0) throw at(line, col, 'unterminated comment')
      for (let k = i; k < end; k++) if (src[k] === '\n') { line++; lineStart = k + 1 }
      i = end + 2
      continue
    }
    if (isDigit(c)) {
      const start = i
      const startLine = line
      if (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X' || src[i + 1] === 'b' || src[i + 1] === 'B')) {
        const hex = src[i + 1] === 'x' || src[i + 1] === 'X'
        i += 2
        const digits = digitRun(isHex, hex ? 'hex' : 'binary', start, startLine, col)
        if (digits.length === 0 || (!hex && /[^01]/.test(digits))) throw at(startLine, col, `malformed ${hex ? 'hex' : 'binary'} literal '${src.slice(start, i)}'`)
        let suffixed = false
        if (src[i] === 'u') { suffixed = true; i++ }
        const value = Number.parseInt(digits, hex ? 16 : 2)
        if (value > 0xffffffff) throw at(startLine, col, 'integer literal too large')
        tok('int', src.slice(start, i), startLine, col, value, '', suffixed)
        continue
      }
      let digits = digitRun(isDigit, 'integer', start, startLine, col)
      let isFloat = false
      // `2.` is a float; `0..10` is an integer followed by a range.
      if (src[i] === '.' && src[i + 1] !== '.') {
        isFloat = true
        digits += '.'
        i++
        digits += digitRun(isDigit, 'float', start, startLine, col)
      }
      if (src[i] === 'e' || src[i] === 'E') {
        isFloat = true
        digits += 'e'
        i++
        if (src[i] === '+' || src[i] === '-') { digits += src[i]; i++ }
        if (!isDigit(src[i] ?? '')) throw at(startLine, col, `malformed float literal '${src.slice(start, i)}'`)
        while (i < n && isDigit(src[i]!)) { digits += src[i]; i++ }
      }
      if (src[i] === 'f') { isFloat = true; i++ }
      if (isFloat) {
        tok('float', src.slice(start, i), startLine, col, Math.fround(Number(digits)))
        continue
      }
      let suffixed = false
      if (src[i] === 'u') { suffixed = true; i++ }
      const value = Number(digits)
      if (value > 0xffffffff) throw at(startLine, col, 'integer literal too large')
      tok('int', src.slice(start, i), startLine, col, value, '', suffixed)
      continue
    }
    if (isIdentStart(c)) {
      const start = i
      while (i < n && isIdentPart(src[i]!)) i++
      const text = src.slice(start, i)
      tok(KEYWORDS.includes(text) ? 'kw' : TYPE_NAMES.includes(text) ? 'type' : 'ident', text, line, col)
      continue
    }
    if (c === '"') {
      const startLine = line
      const start = i
      i++
      let s = ''
      for (;;) {
        if (i >= n) throw at(startLine, col, 'unterminated string')
        const d = src[i]!
        if (d === '"') { i++; break }
        if (d === '\n') throw at(startLine, col, 'unterminated string')
        if (d === '\\') {
          const e = src[i + 1]
          if (e === 'n') s += '\n'
          else if (e === 't') s += '\t'
          else if (e === '"') s += '"'
          else if (e === '\\') s += '\\'
          else throw at(line, i - lineStart + 1, `unknown escape '\\${e ?? ''}'`)
          i += 2
          continue
        }
        s += d
        i++
      }
      tok('str', src.slice(start, i), startLine, col, 0, s)
      continue
    }
    let matched: string | null = null
    for (const op of OPERATORS) {
      if (src.startsWith(op, i)) { matched = op; break }
    }
    if (matched === null) throw at(line, col, `unexpected character '${c}'`)
    tok('op', matched, line, col)
    i += matched.length
  }
  tok('eof', '', line, i - lineStart + 1)
  return out
}
