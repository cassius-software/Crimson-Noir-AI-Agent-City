// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It reads a line (or a script) of the console's shell and turns it into a tree: lists of
 * commands joined by `;`, `&`, `&&` and `||`, pipelines joined by `|`, simple commands with their words and
 * redirections, and the compound forms `if`, `while`, `until`, `for` and `{ }`. A word is kept as its pieces
 * (literal text, a quoted stretch, `$name`, `${name:-word}`, `$(command)`, `$((sum))`, a leading `~`) so that the
 * shell can expand it when the command runs, not when it is read. It only reads: nothing here opens a file or
 * runs anything. The city's own commands keep their own reading: when the first word of a command is one of them,
 * the rest of that command is split exactly as the console always split it (quotes removed, nothing expanded), and
 * it ends only at a line end or at an operator that stands alone between blanks, so an argument such as `~/#` or a
 * web address with `&` in it reaches the command as typed.
 * What breaks if it is removed? The shell has no grammar: no pipes, no redirection, no variables, no `if`.
 */

/** One piece of a word. `q` marks a quoted piece: it is never split into fields and never read as a pattern. */
export type Seg =
  | { readonly t: 'lit'; readonly s: string; readonly q: boolean }
  /**
   * `$name` or `${name<op>word}`. `op` is '' for the plain value, 'len' for `${#name}`, or one of
   * `:-  -  :=  =  :+  +  :?  ?  %  %%  #  ##`.
   */
  | { readonly t: 'var'; readonly name: string; readonly op: string; readonly arg: Word | null; readonly q: boolean }
  | { readonly t: 'cmd'; readonly body: List; readonly q: boolean }
  | { readonly t: 'sum'; readonly text: Word; readonly q: boolean }
  /** A leading `~` or `~name`. */
  | { readonly t: 'home'; readonly user: string }

export type Word = readonly Seg[]

/** `fd` is the descriptor it changes; `op` is how. `<<` carries its text in `here`. */
export interface Redirect {
  readonly fd: number
  readonly op: '<' | '>' | '>>' | '<<' | '>&' | '<&'
  readonly word: Word
  /** A heredoc's lines, as a word to expand (or one quoted literal when its marker was quoted). */
  here: Word | null
}

export interface Simple {
  readonly t: 'simple'
  readonly assigns: readonly { readonly name: string; readonly value: Word }[]
  readonly words: readonly Word[]
  readonly redirects: readonly Redirect[]
}

/** One of the city's own commands, with its arguments as the console has always read them. */
export interface City {
  readonly t: 'city'
  readonly name: string
  readonly args: readonly string[]
  /** The command as typed, for the handler that wants the whole line. */
  readonly line: string
  readonly redirects: readonly Redirect[]
}

export interface If {
  readonly t: 'if'
  readonly clauses: readonly { readonly cond: List; readonly then: List }[]
  readonly otherwise: List | null
  readonly redirects: readonly Redirect[]
}

export interface Loop {
  readonly t: 'loop'
  /** `until` runs while the condition fails. */
  readonly until: boolean
  readonly cond: List
  readonly body: List
  readonly redirects: readonly Redirect[]
}

export interface For {
  readonly t: 'for'
  readonly name: string
  /** The words after `in`; null for the positional parameters. */
  readonly words: readonly Word[] | null
  readonly body: List
  readonly redirects: readonly Redirect[]
}

export interface Group {
  readonly t: 'group'
  readonly body: List
  readonly redirects: readonly Redirect[]
}

export type Command = Simple | City | If | Loop | For | Group

export interface Pipeline {
  readonly negate: boolean
  readonly cmds: readonly Command[]
}

export interface AndOr {
  readonly first: Pipeline
  readonly rest: readonly { readonly op: '&&' | '||'; readonly cmd: Pipeline }[]
}

export interface List {
  readonly items: readonly { readonly cmd: AndOr; readonly bg: boolean; readonly text: string }[]
}

/** The city's commands, as the parser needs to know them. */
export interface CityNames {
  /** Whether `name` is one of the city's commands. */
  has(name: string): boolean
  /** Whether it takes the rest of its line in one piece, untouched. */
  whole(name: string): boolean
}

/** No city commands at all: a plain shell. */
export const NO_CITY: CityNames = Object.freeze({ has: () => false, whole: () => false })

/** What the parser refuses. `incomplete` means more lines could finish it (an open quote, an `if` without `fi`). */
export class ShellSyntax extends Error {
  readonly incomplete: boolean
  constructor(message: string, incomplete: boolean) {
    super(message)
    this.name = 'ShellSyntax'
    this.incomplete = incomplete
  }
}

/** Nesting of `$( )` and compound commands the parser follows before it refuses. */
const DEPTH_MAX = 64

const RESERVED = new Set(['if', 'then', 'elif', 'else', 'fi', 'while', 'until', 'do', 'done', 'for', 'in', '{', '}', '!'])

const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const SPECIAL = '?$!#@*-0123456789'

function isMeta(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '|' || c === '&' || c === ';' || c === '(' || c === ')' || c === '<' || c === '>'
}

/** A raw piece of one of the city's command lines, as the console's own splitting gives it. */
interface Chunk { readonly text: string; readonly plain: boolean; readonly start: number; readonly end: number }

/** The operators that end a city command when they stand alone. */
const CITY_ENDS = new Set(['|', '||', '&&', ';', '&'])
const CITY_REDIRECT = /^(?:[0-9]?(?:>>|>|<)|[0-9]?>&[0-9])$/

/**
 * Reads one blank-delimited piece at `at` the way the console has always split a line: '...' is literal, "..."
 * honours \" and \\, a backslash outside quotes takes the next character. Null when a quote is left open. With
 * `paren`, a `)` outside quotes also ends the piece: inside `$( )` it closes the substitution.
 */
function chunkAt(src: string, at: number, paren = false): Chunk | null {
  let i = at
  let text = ''
  let plain = true
  let quote = ''
  for (; i < src.length; i++) {
    const c = src[i]
    if (quote === "'") {
      if (c === "'") quote = ''
      else text += c
    } else if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && (src[i + 1] === '"' || src[i + 1] === '\\')) text += src[++i]
      else text += c
    } else if (c === "'" || c === '"') {
      quote = c
      plain = false
    } else if (c === '\\' && i + 1 < src.length) {
      text += src[++i]
      plain = false
    } else if (c === ' ' || c === '\t' || c === '\n' || (paren && c === ')')) {
      break
    } else {
      text += c
    }
  }
  if (quote !== '') return null
  return { text, plain, start: at, end: i }
}

/**
 * Whether a typed line needs the shell. It does when any blank-delimited piece after the first is an operator standing
 * alone (`|`, `||`, `&&`, `;`, `&`, a redirection), or ends in a `;`, or comes after a line end (the shell ends the
 * command there, so what follows is another command). A line with an open quote does not (the console reports it as
 * it always has). The console asks this only of a line whose first word is one of the city's commands.
 */
export function hasOperator(line: string): boolean {
  let i = 0
  let first = true
  for (;;) {
    let newline = false
    while (i < line.length && (line[i] === ' ' || line[i] === '\t' || line[i] === '\n')) {
      if (line[i] === '\n') newline = true
      i++
    }
    if (i >= line.length) return false
    if (newline && !first) return true
    const chunk = chunkAt(line, i)
    if (chunk === null) return false
    i = chunk.end
    if (first) { first = false; continue }
    if (!chunk.plain) continue
    if (CITY_ENDS.has(chunk.text) || CITY_REDIRECT.test(chunk.text)) return true
    if (chunk.text.length > 1 && chunk.text.endsWith(';')) return true
  }
}

class Parser {
  private readonly src: string
  private readonly city: CityNames
  private i = 0
  private depth = 0
  /** How many `$(` are open around the position: a city command inside one ends at the `)` that closes it. */
  private open = 0
  /** Here-documents whose text starts after the next line end. */
  private waiting: { redirect: Redirect; marker: string; quoted: boolean; strip: boolean }[] = []

  constructor(src: string, city: CityNames, at = 0) {
    this.src = src
    this.city = city
    this.i = at
  }

  get at(): number { return this.i }

  private fail(message: string, incomplete = false): never {
    throw new ShellSyntax(message, incomplete)
  }

  private deeper(): void {
    if (++this.depth > DEPTH_MAX) this.fail('nested too deep')
  }

  /** Skips blanks, a backslash at a line end, and a comment. A backslash that ends the text asks for the next line. */
  private blanks(): void {
    const s = this.src
    for (;;) {
      const c = s[this.i]
      if (c === ' ' || c === '\t') this.i++
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2
      else if (c === '\\' && this.i + 1 === s.length) this.fail('a line ends in a backslash', true)
      else if (c === '#') { while (this.i < s.length && s[this.i] !== '\n') this.i++ }
      else return
    }
  }

  /** Takes a line end, then the text of every heredoc that was waiting for it. */
  private lineEnd(): void {
    this.i++
    for (const w of this.waiting) {
      const lines: string[] = []
      let closed = false
      while (this.i < this.src.length) {
        let end = this.src.indexOf('\n', this.i)
        if (end < 0) end = this.src.length
        let line = this.src.slice(this.i, end)
        this.i = Math.min(end + 1, this.src.length)
        if (w.strip) line = line.replace(/^\t+/, '')
        if (line === w.marker) { closed = true; break }
        lines.push(line)
      }
      if (!closed) this.fail(`heredoc '${w.marker}' has no end`, true)
      const text = lines.length === 0 ? '' : `${lines.join('\n')}\n`
      if (w.quoted) { w.redirect.here = [{ t: 'lit', s: text, q: true }]; continue }
      // The text is read as deep as the heredoc stands, and once its marker is found no later line can finish it.
      const inner = new Parser(text, this.city)
      inner.depth = this.depth
      try {
        w.redirect.here = inner.hereText()
      } catch (e) {
        if (e instanceof ShellSyntax) this.fail(e.message)
        throw e
      }
    }
    this.waiting = []
  }

  /** Skips blanks, comments and line ends. */
  private gaps(): void {
    for (;;) {
      this.blanks()
      if (this.src[this.i] === '\n') this.lineEnd()
      else return
    }
  }

  /** A heredoc's text as a word: `$` expands, a backslash before `$` or a backslash is dropped, the rest is literal. */
  hereText(): Word {
    const segs: Seg[] = []
    let lit = ''
    const s = this.src
    while (this.i < s.length) {
      const c = s[this.i]
      if (c === '\\' && (s[this.i + 1] === '$' || s[this.i + 1] === '\\')) { lit += s[this.i + 1]; this.i += 2 }
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2
      else if (c === '$') {
        const seg = this.dollar(true)
        if (seg === null) { lit += '$'; continue }
        if (lit !== '') { segs.push({ t: 'lit', s: lit, q: true }); lit = '' }
        segs.push(seg)
      } else { lit += c; this.i++ }
    }
    if (lit !== '') segs.push({ t: 'lit', s: lit, q: true })
    return segs
  }

  /** Reads what follows a `$` (the position is on it). Null when the `$` stands for itself; the position then is past it. */
  private dollar(q: boolean): Seg | null {
    const s = this.src
    const c = s[this.i + 1]
    if (c === '(' && s[this.i + 2] === '(') {
      // $(( sum )): the text up to the matching )).
      this.i += 3
      this.deeper()
      const text = this.sumText()
      this.depth--
      return { t: 'sum', text, q }
    }
    if (c === '(') {
      this.i += 2
      this.deeper()
      this.open++
      let body: List
      try {
        body = this.list(')')
      } finally {
        this.open--
      }
      if (s[this.i] !== ')') this.fail("'$(' has no ')'", true)
      this.i++
      this.depth--
      return { t: 'cmd', body, q }
    }
    if (c === '{') {
      this.i += 2
      this.deeper()
      const seg = this.braced(q)
      this.depth--
      return seg
    }
    if (c !== undefined && NAME_START.test(c)) {
      let end = this.i + 2
      while (end < s.length && NAME_CHAR.test(s[end])) end++
      const name = s.slice(this.i + 1, end)
      this.i = end
      return { t: 'var', name, op: '', arg: null, q }
    }
    if (c !== undefined && SPECIAL.includes(c)) {
      this.i += 2
      return { t: 'var', name: c, op: '', arg: null, q }
    }
    this.i++
    return null
  }

  /** The inside of `$(( ))` as a word (it may hold `$name`), up to and past the closing `))`. */
  private sumText(): Word {
    const s = this.src
    const segs: Seg[] = []
    let lit = ''
    let open = 0
    for (;;) {
      if (this.i >= s.length) this.fail("'$((' has no '))'", true)
      const c = s[this.i]
      if (c === ')' && open === 0) {
        if (s[this.i + 1] !== ')') this.fail("'$((' has no '))'")
        this.i += 2
        break
      }
      if (c === '(') open++
      else if (c === ')') open--
      if (c === '$') {
        const seg = this.dollar(true)
        if (seg === null) { lit += '$'; continue }
        if (lit !== '') { segs.push({ t: 'lit', s: lit, q: true }); lit = '' }
        segs.push(seg)
        continue
      }
      lit += c
      this.i++
    }
    if (lit !== '') segs.push({ t: 'lit', s: lit, q: true })
    return segs
  }

  /** A name, or one special parameter, at the position (moved past it); '' when neither is there. */
  private paramName(): string {
    const s = this.src
    const start = this.i
    if (this.i < s.length && NAME_START.test(s[this.i])) { while (this.i < s.length && NAME_CHAR.test(s[this.i])) this.i++ }
    else if (this.i < s.length && SPECIAL.includes(s[this.i])) this.i++
    return s.slice(start, this.i)
  }

  /**
   * `${...}`: the position is just past the `{`. A refusal here is never incomplete: the name and the operator must
   * stand on the line the `${` opened, so no later line can finish them.
   */
  private braced(q: boolean): Seg {
    const s = this.src
    if (s[this.i] === '#' && s[this.i + 1] !== '}') {
      this.i++
      const name = this.paramName()
      if (s[this.i] !== '}' || name === '') this.fail('bad substitution')
      this.i++
      return { t: 'var', name, op: 'len', arg: null, q }
    }
    const name = this.paramName()
    if (name === '') this.fail('bad substitution')
    if (s[this.i] === '}') { this.i++; return { t: 'var', name, op: '', arg: null, q } }
    let op = ''
    for (const candidate of [':-', ':=', ':+', ':?', '%%', '##', '-', '=', '+', '?', '%', '#']) {
      if (s.startsWith(candidate, this.i)) { op = candidate; break }
    }
    if (op === '') this.fail('bad substitution')
    this.i += op.length
    const arg = this.wordUntilBrace(q)
    return { t: 'var', name, op, arg, q }
  }

  /** The word inside `${name<op> ... }`, up to and past the closing brace. */
  private wordUntilBrace(q: boolean): Word {
    const s = this.src
    const segs: Seg[] = []
    let lit = ''
    const flush = (quoted: boolean) => { if (lit !== '') { segs.push({ t: 'lit', s: lit, q: quoted }); lit = '' } }
    for (;;) {
      if (this.i >= s.length) this.fail("'${' has no '}'", true)
      const c = s[this.i]
      if (c === '}') { this.i++; break }
      if (c === '\\' && this.i + 1 < s.length) {
        flush(q)
        segs.push({ t: 'lit', s: s[this.i + 1], q: true })
        this.i += 2
      } else if (c === "'" && !q) {
        flush(q)
        const end = s.indexOf("'", this.i + 1)
        if (end < 0) this.fail('a quote is left open', true)
        segs.push({ t: 'lit', s: s.slice(this.i + 1, end), q: true })
        this.i = end + 1
      } else if (c === '"') {
        flush(q)
        this.i++
        this.double(segs)
      } else if (c === '$') {
        const seg = this.dollar(q)
        if (seg === null) { lit += '$'; continue }
        flush(q)
        segs.push(seg)
      } else { lit += c; this.i++ }
    }
    flush(q)
    return segs
  }

  /** The inside of "...": the position is just past the opening quote; leaves it past the closing one. */
  private double(segs: Seg[]): void {
    const s = this.src
    let lit = ''
    let any = false
    for (;;) {
      if (this.i >= s.length) this.fail('a quote is left open', true)
      const c = s[this.i]
      if (c === '"') { this.i++; break }
      if (c === '\\' && (s[this.i + 1] === '$' || s[this.i + 1] === '"' || s[this.i + 1] === '\\')) { lit += s[this.i + 1]; this.i += 2 }
      else if (c === '\\' && s[this.i + 1] === '\n') this.i += 2
      else if (c === '$') {
        const seg = this.dollar(true)
        if (seg === null) { lit += '$'; continue }
        if (lit !== '') { segs.push({ t: 'lit', s: lit, q: true }); lit = '' }
        segs.push(seg)
        any = true
      } else { lit += c; this.i++ }
    }
    // An empty "" is still a word: keep an empty quoted piece.
    if (lit !== '' || !any) segs.push({ t: 'lit', s: lit, q: true })
  }

  /** A word at the position, or null when an operator, a blank or the end is there. */
  private word(): Seg[] | null {
    const s = this.src
    const segs: Seg[] = []
    let lit = ''
    const start = this.i
    const flush = () => { if (lit !== '') { segs.push({ t: 'lit', s: lit, q: false }); lit = '' } }
    while (this.i < s.length) {
      const c = s[this.i]
      if (isMeta(c)) break
      if (c === '\\') {
        if (s[this.i + 1] === '\n') { this.i += 2; continue }
        if (this.i + 1 >= s.length) this.fail('a line ends in a backslash', true)
        flush()
        segs.push({ t: 'lit', s: s[this.i + 1], q: true })
        this.i += 2
      } else if (c === "'") {
        flush()
        const end = s.indexOf("'", this.i + 1)
        if (end < 0) this.fail('a quote is left open', true)
        segs.push({ t: 'lit', s: s.slice(this.i + 1, end), q: true })
        this.i = end + 1
      } else if (c === '"') {
        flush()
        this.i++
        this.double(segs)
      } else if (c === '$') {
        const seg = this.dollar(false)
        if (seg === null) { lit += '$'; continue }
        flush()
        segs.push(seg)
      } else if (c === '~' && this.i === start) {
        let end = this.i + 1
        while (end < s.length && NAME_CHAR.test(s[end])) end++
        const after = s[end]
        if (after === undefined || after === '/' || isMeta(after)) {
          segs.push({ t: 'home', user: s.slice(this.i + 1, end) })
          this.i = end
        } else { lit += c; this.i++ }
      } else { lit += c; this.i++ }
    }
    flush()
    return this.i === start ? null : segs
  }

  /** The reserved word at the position, if a word that is exactly one stands there (the position does not move). */
  private reserved(): string | null {
    const s = this.src
    let end = this.i
    while (end < s.length && !isMeta(s[end])) end++
    const text = s.slice(this.i, end)
    return RESERVED.has(text) ? text : null
  }

  private expect(word: string, opened: string): void {
    this.gaps()
    if (this.reserved() !== word) this.fail(`'${opened}' needs '${word}'`, this.i >= this.src.length)
    this.i += word.length
  }

  /** A redirection at the position, or null. */
  private redirect(): Redirect | null {
    const s = this.src
    let j = this.i
    let fd = -1
    if (s[j] >= '0' && s[j] <= '9' && (s[j + 1] === '<' || s[j + 1] === '>')) { fd = s.charCodeAt(j) - 48; j++ }
    const c = s[j]
    if (c !== '<' && c !== '>') return null
    let op: Redirect['op']
    let strip = false
    if (c === '>') {
      if (s[j + 1] === '>') { op = '>>'; j += 2 }
      else if (s[j + 1] === '&') { op = '>&'; j += 2 }
      else { op = '>'; j++ }
    } else if (s[j + 1] === '<') {
      op = '<<'
      j += 2
      if (s[j] === '-') { strip = true; j++ }
    } else if (s[j + 1] === '&') { op = '<&'; j += 2 }
    else { op = '<'; j++ }
    this.i = j
    this.blanks()
    const word = this.word()
    // The name must be on the same line (a line end ends the command), so a missing one is never incomplete.
    if (word === null) this.fail(`'${op}' needs a name after it`)
    const redirect: Redirect = { fd: fd >= 0 ? fd : c === '<' ? 0 : 1, op, word, here: null }
    if (op === '<<') {
      // The marker is taken as typed with its quotes removed; any quoting means the text is not expanded.
      let marker = ''
      let quoted = false
      for (const seg of word) {
        if (seg.t !== 'lit') this.fail('a heredoc marker must be plain text')
        marker += seg.s
        if (seg.q) quoted = true
      }
      this.waiting.push({ redirect, marker, quoted, strip })
    }
    return redirect
  }

  private redirects(): Redirect[] {
    const out: Redirect[] = []
    for (;;) {
      this.blanks()
      const r = this.redirect()
      if (r === null) return out
      out.push(r)
    }
  }

  /** A list of commands up to the end, or to a closing `)` or one of the `stop` words. */
  list(...stop: string[]): List {
    const items: { cmd: AndOr; bg: boolean; text: string }[] = []
    const s = this.src
    for (;;) {
      this.gaps()
      if (this.i >= s.length) break
      if (s[this.i] === ')') {
        if (stop.includes(')')) break
        this.fail("unexpected ')'")
      }
      const word = this.reserved()
      if (word !== null && stop.includes(word)) break
      const from = this.i
      const cmd = this.andOr()
      const text = s.slice(from, this.i).trim()
      this.blanks()
      let bg = false
      const c = s[this.i]
      if (c === '&' && s[this.i + 1] !== '&') { bg = true; this.i++ }
      else if (c === ';') this.i++
      else if (c === '\n') this.lineEnd()
      else if (this.i < s.length && c !== ')') {
        const next = this.reserved()
        if (next === null || !stop.includes(next)) this.fail(`unexpected '${c === '|' || c === '&' ? s.slice(this.i, this.i + 2).trim() : c}'`)
      }
      items.push({ cmd, bg, text })
    }
    if (this.waiting.length > 0 && this.i >= s.length) this.fail(`heredoc '${this.waiting[0].marker}' has no text`, true)
    return { items }
  }

  private andOr(): AndOr {
    const first = this.pipeline()
    const rest: { op: '&&' | '||'; cmd: Pipeline }[] = []
    for (;;) {
      this.blanks()
      const two = this.src.slice(this.i, this.i + 2)
      if (two !== '&&' && two !== '||') break
      this.i += 2
      this.gaps()
      if (this.i >= this.src.length) this.fail(`'${two}' needs a command after it`, true)
      rest.push({ op: two, cmd: this.pipeline() })
    }
    return { first, rest }
  }

  private pipeline(): Pipeline {
    this.blanks()
    let negate = false
    if (this.reserved() === '!') {
      negate = true
      this.i++
      this.blanks()
    }
    const cmds: Command[] = [this.command()]
    for (;;) {
      this.blanks()
      if (this.src[this.i] !== '|' || this.src[this.i + 1] === '|') break
      this.i++
      this.gaps()
      if (this.i >= this.src.length) this.fail("'|' needs a command after it", true)
      cmds.push(this.command())
    }
    return { negate, cmds }
  }

  private command(): Command {
    this.blanks()
    const word = this.reserved()
    if (word === 'if') {
      this.i += 2
      this.deeper()
      const clauses: { cond: List; then: List }[] = []
      let otherwise: List | null = null
      for (;;) {
        const cond = this.list('then')
        this.expect('then', 'if')
        const then = this.list('elif', 'else', 'fi')
        clauses.push({ cond, then })
        if (cond.items.length === 0) this.fail("'if' needs a command before 'then'")
        const next = this.reserved()
        if (next === 'elif') { this.i += 4; continue }
        if (next === 'else') {
          this.i += 4
          otherwise = this.list('fi')
        }
        break
      }
      this.expect('fi', 'if')
      this.depth--
      return { t: 'if', clauses, otherwise, redirects: this.redirects() }
    }
    if (word === 'while' || word === 'until') {
      this.i += 5
      this.deeper()
      const cond = this.list('do')
      if (cond.items.length === 0) this.fail(`'${word}' needs a command before 'do'`, this.i >= this.src.length)
      this.expect('do', word)
      const body = this.list('done')
      this.expect('done', word)
      this.depth--
      return { t: 'loop', until: word === 'until', cond, body, redirects: this.redirects() }
    }
    if (word === 'for') {
      this.i += 3
      this.deeper()
      this.blanks()
      const start = this.i
      while (this.i < this.src.length && NAME_CHAR.test(this.src[this.i])) this.i++
      const name = this.src.slice(start, this.i)
      // The name must follow `for` on its line: a missing one is never incomplete.
      if (name === '' || !NAME_START.test(name[0])) this.fail("'for' needs a variable name")
      this.gaps()
      let words: Word[] | null = null
      if (this.reserved() === 'in') {
        this.i += 2
        words = []
        for (;;) {
          this.blanks()
          const w = this.word()
          if (w === null) break
          words.push(w)
        }
        this.blanks()
        if (this.src[this.i] === ';') this.i++
      } else if (this.src[this.i] === ';') this.i++
      this.expect('do', 'for')
      const body = this.list('done')
      this.expect('done', 'for')
      this.depth--
      return { t: 'for', name, words, body, redirects: this.redirects() }
    }
    if (word === '{') {
      this.i++
      this.deeper()
      const body = this.list('}')
      this.expect('}', '{')
      this.depth--
      return { t: 'group', body, redirects: this.redirects() }
    }
    if (word !== null && word !== '!') this.fail(`unexpected '${word}'`)
    return this.simple()
  }

  private simple(): Simple | City {
    const s = this.src
    const assigns: { name: string; value: Word }[] = []
    const words: Word[] = []
    const redirects: Redirect[] = []
    for (;;) {
      this.blanks()
      const r = this.redirect()
      if (r !== null) { redirects.push(r); continue }
      if (this.i >= s.length || isMeta(s[this.i])) break
      if (words.length === 0) {
        // NAME=value before the command's name.
        let j = this.i
        if (NAME_START.test(s[j])) {
          while (j < s.length && NAME_CHAR.test(s[j])) j++
          if (s[j] === '=') {
            const name = s.slice(this.i, j)
            this.i = j + 1
            assigns.push({ name, value: this.assigned() })
            continue
          }
        }
      }
      const from = this.i
      const w = this.word()
      if (w === null) break
      if (words.length === 0 && assigns.length === 0 && w.length === 1 && w[0].t === 'lit' && !w[0].q && this.city.has(w[0].s)) {
        return this.cityCommand(w[0].s, from, redirects)
      }
      words.push(w)
    }
    if (words.length === 0 && assigns.length === 0 && redirects.length === 0) {
      // Only a `!` leaves a command missing at the end, and its command must follow on the same line.
      const c = s[this.i]
      this.fail(this.i >= s.length ? 'a command is missing' : `unexpected '${c === '\n' ? 'line end' : c}'`)
    }
    return { t: 'simple', assigns, words, redirects }
  }

  /** The value of an assignment: a word in which `~` is also read after the `=`. */
  private assigned(): Word {
    return this.word() ?? []
  }

  /** The rest of one of the city's commands, read the console's own way. The position is just past its name. */
  private cityCommand(name: string, from: number, redirects: Redirect[]): City {
    const s = this.src
    const args: string[] = []
    if (this.city.whole(name)) {
      let end = this.open > 0 ? this.closing(this.i) : s.indexOf('\n', this.i)
      if (end < 0) end = s.length
      const rest = s.slice(this.i, end).trim()
      this.i = end
      return { t: 'city', name, args: rest === '' ? [] : [rest], line: s.slice(from, end).trim(), redirects }
    }
    let end = this.i
    const paren = this.open > 0
    for (;;) {
      while (this.i < s.length && (s[this.i] === ' ' || s[this.i] === '\t')) this.i++
      if (this.i >= s.length || s[this.i] === '\n' || (paren && s[this.i] === ')')) break
      const chunk = chunkAt(s, this.i, paren)
      if (chunk === null) this.fail('a quote is left open', true)
      if (chunk.plain && CITY_ENDS.has(chunk.text)) break
      if (chunk.plain && CITY_REDIRECT.test(chunk.text)) {
        const r = this.redirect()
        if (r === null) this.fail(`unexpected '${chunk.text}'`)
        redirects.push(r)
        continue
      }
      if (chunk.plain && chunk.text.length > 1 && chunk.text.endsWith(';')) {
        args.push(chunk.text.slice(0, -1))
        this.i = chunk.end - 1
        end = this.i
        break
      }
      args.push(chunk.text)
      this.i = chunk.end
      end = this.i
    }
    return { t: 'city', name, args, line: s.slice(from, end).trim(), redirects }
  }

  /**
   * Where a command that takes the rest of its line whole ends inside `$( )`: at the line end, or at the first `)`
   * outside quotes that no `(` of its own opened (`$(noir print(1))` hands noir `print(1)`). -1 at the end of the text.
   */
  private closing(at: number): number {
    const s = this.src
    let depth = 0
    let quote = ''
    for (let i = at; i < s.length; i++) {
      const c = s[i]
      if (quote !== '') {
        if (c === '\\' && quote === '"') i++
        else if (c === quote) quote = ''
      } else if (c === "'" || c === '"') {
        quote = c
      } else if (c === '\\') {
        i++
      } else if (c === '(') {
        depth++
      } else if (c === ')') {
        if (depth === 0) return i
        depth--
      } else if (c === '\n') {
        return i
      }
    }
    return -1
  }
}

/** Reads a whole script. Throws ShellSyntax when it is not one. */
export function parse(src: string, city: CityNames = NO_CITY): List {
  const p = new Parser(src, city)
  const list = p.list()
  if (p.at < src.length) throw new ShellSyntax(`unexpected '${src[p.at]}'`, false)
  return list
}
