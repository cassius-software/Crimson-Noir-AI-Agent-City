// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is sed, the stream editor: a program that reads text a line at a time, runs a short
 * script of one-letter commands on each line (substitute, delete, print, insert, append, change, transliterate, keep
 * a line aside and bring it back) and writes what comes out, to the screen or, with -i, back into each file. The
 * script is read in full and every pattern in it is made ready before a single byte of input is read, so a mistake
 * in it is reported at once and nothing is half done. Patterns are matched by the layer's own engine (regex.ts),
 * which keeps every way through a pattern alive at once, so no pattern can stall the console; the host's own
 * matcher never sees one.
 * What breaks if it is removed? `sed 's/old/new/g'`, the usual way to rewrite text in a pipeline or a file, stops
 * working, and so does every script that edits a file in place with `sed -i`.
 *
 * How it is bounded: the pattern space and the hold space are capped at 8 MiB of text each (counted in characters)
 * and a longer line is refused, the text an edited file gets back is capped at the kernel's whole-file limit, and
 * nothing in a script can loop for ever: there are no branches, and D restarts the cycle without reading only while
 * each restart leaves a shorter pattern space than the one before, which a script cannot keep up for long.
 * Long loops that ask nothing of the kernel give the other tasks a turn every 1024 rounds, and pattern searches do
 * after every so much matching work (counted in the engine's own steps), however few searches that took.
 */
import { EMPTY, encode } from './bytes.ts'
import { OsError } from './errno.ts'
import type { Program, Sys } from './kernel.ts'
import { READ_ALL_MAX } from './kernel.ts'
import { Out, complain, usage } from './lib.ts'
import { RegexError, compile } from './regex.ts'
import type { Match, Regex } from './regex.ts'
import type { Task } from './task.ts'
import { O_READ, O_WRITE } from './vfs.ts'

/** The most characters the pattern space or the hold space may hold: 8 MiB of text. */
const SPACE_MAX = 8 << 20
/** How the cap is named in a message. */
const SPACE_TEXT = `8 MiB (${SPACE_MAX} characters)`
/** The most characters the new text of a file edited in place may hold before it is written back. */
const RESULT_MAX = READ_ALL_MAX
/** A loop that asks nothing of the kernel gives the other tasks a turn when its count has none of these bits. */
const PACE = 1023
/** How much matching work (steps of the engine, or characters searched or copied) a run does between two turns of the others. */
const PACE_WORK = 1 << 20
const USAGE = 'sed [-n] [-E] [-i] [-e script]... [script] [file ...]'

// What can go wrong, each as its own kind so that one is never taken for another.

/** A script that cannot be run: reported before any input is read, with status 2. */
class ScriptError {
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

/** A limit reached while running: sed says why and stops, with status 1. */
class Halt {
  readonly message: string
  constructor(message: string) {
    this.message = message
  }
}

/** A write to the ordinary output refused for a reason other than a closed pipe (a full disk, say). */
class WriteFailed {
  readonly why: OsError
  constructor(why: OsError) {
    this.why = why
  }
}

/** A closed pipe goes on up as it is (the kernel ends the program quietly); any other refused write as WriteFailed. */
const spilt = (e: unknown): unknown => (e instanceof OsError && e.errno !== 'EPIPE' ? new WriteFailed(e) : e)

// The script, as it is read.

/** A pattern as a command holds it: its own, or none (written `//`), which stands for the last pattern used. */
interface Pat {
  readonly own: Regex | null
  /** What `//` stands for while no pattern has been used yet: the last one written before it in the script. */
  readonly fallback: Regex
}

/** Which lines a command applies to: a line number, the last line, the lines a pattern is found in, or (second only) +N. */
type Addr =
  | { readonly kind: 'line'; readonly n: number }
  | { readonly kind: 'last' }
  | { readonly kind: 'match'; readonly pat: Pat }
  | { readonly kind: 'plus'; readonly n: number }

/** What `s` replaces and how. `parts` is the replacement: plain text, or the number of a group (0 the whole match). */
interface Subst {
  readonly pat: Pat
  readonly parts: readonly (string | number)[]
  readonly global: boolean
  /** Which match is the first to replace, from 1. */
  readonly nth: number
  readonly print: boolean
}

/** One command of the script, with its addresses and whatever it carries. */
class Cmd {
  readonly name: string
  readonly a1: Addr | null
  readonly a2: Addr | null
  readonly negate: boolean
  /** a, i, c: the text, without a line end of its own. */
  text = ''
  /** q: the exit status asked for, or -1 when none was. */
  status = -1
  /** {: the place of the command after its matching }. */
  end = 0
  sub: Subst | null = null
  /** y: each character and the one it becomes. */
  map: ReadonlyMap<string, string> | null = null

  constructor(name: string, a1: Addr | null, a2: Addr | null, negate: boolean) {
    this.name = name
    this.a1 = a1
    this.a2 = a2
    this.negate = negate
  }
}

const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9'
const isLetter = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'))

/**
 * Reads a script into a flat list of commands; a `{` knows where its block ends, so running the list needs no
 * recursion. Every pattern is compiled here, so a bad one is refused before any input is read.
 */
class Parser {
  private readonly src: string
  private i = 0
  private readonly cmds: Cmd[] = []
  /** The places of the `{` still open. */
  private readonly open: number[] = []
  /** The last pattern written so far, for an empty pattern to fall back on. */
  private written: Regex | null = null

  constructor(src: string) {
    this.src = src
  }

  private fail(message: string): never {
    throw new ScriptError(message)
  }

  private blanks(): void {
    while (this.src[this.i] === ' ' || this.src[this.i] === '\t') this.i++
  }

  parse(): Cmd[] {
    const src = this.src
    for (;;) {
      while (this.i < src.length && (src[this.i] === ' ' || src[this.i] === '\t' || src[this.i] === '\n' || src[this.i] === ';')) this.i++
      if (this.i >= src.length) break
      if (src[this.i] === '#') {
        this.comment()
        continue
      }
      const a1 = this.address()
      let a2: Addr | null = null
      if (a1 !== null) {
        this.blanks()
        if (src[this.i] === ',') {
          this.i++
          this.blanks()
          a2 = this.second()
        }
      }
      this.blanks()
      let negate = false
      while (src[this.i] === '!') {
        if (negate) this.fail('more than one ! in a row')
        negate = true
        this.i++
        this.blanks()
      }
      const cp = src.codePointAt(this.i)
      if (cp === undefined || cp === 10 || cp === 59) this.fail('missing command')
      const name = String.fromCodePoint(cp)
      this.i += name.length
      this.command(name, a1, a2, negate)
    }
    if (this.open.length > 0) this.fail('unmatched {')
    return this.cmds
  }

  private comment(): void {
    while (this.i < this.src.length && this.src[this.i] !== '\n') this.i++
  }

  /** After a command: blanks, then the end of the script, a line end or `;` (taken), or a `}` or `#` (left for the loop). */
  private finish(): void {
    this.blanks()
    const c = this.src[this.i]
    if (c === undefined || c === '}' || c === '#') return
    if (c === ';' || c === '\n') {
      this.i++
      return
    }
    this.fail('extra characters after command')
  }

  private push(name: string, a1: Addr | null, a2: Addr | null, negate: boolean): Cmd {
    const cmd = new Cmd(name, a1, a2, negate)
    this.cmds.push(cmd)
    return cmd
  }

  private command(name: string, a1: Addr | null, a2: Addr | null, negate: boolean): void {
    switch (name) {
      case '{':
        this.push(name, a1, a2, negate)
        this.open.push(this.cmds.length - 1)
        return
      case '}': {
        if (a1 !== null || negate) this.fail('} takes no address')
        const at = this.open.pop()
        if (at === undefined) this.fail('unexpected }')
        this.push(name, null, null, false)
        this.cmds[at].end = this.cmds.length
        this.finish()
        return
      }
      case '=': case 'd': case 'D': case 'g': case 'G': case 'h': case 'H': case 'n': case 'N': case 'p': case 'P': case 'x':
        this.push(name, a1, a2, negate)
        this.finish()
        return
      case 'q': {
        if (a2 !== null) this.fail('q takes one address at most')
        this.blanks()
        let status = -1
        if (isDigit(this.src[this.i])) {
          status = this.number('q: the exit status is too large')
          if (status > 255) this.fail('q: the exit status must be from 0 to 255')
        }
        this.push(name, a1, a2, negate).status = status
        this.finish()
        return
      }
      case 'a': case 'i': case 'c':
        this.push(name, a1, a2, negate).text = this.text(name)
        return
      case 's':
        this.substitution(this.push(name, a1, a2, negate))
        return
      case 'y':
        this.push(name, a1, a2, negate).map = this.transliteration()
        this.finish()
        return
      case 'b': case 't': case 'T': case ':':
        return this.fail('branches are not supported')
      case 'r': case 'R':
        return this.fail(`${name} is not supported: a script cannot read other files`)
      case 'w': case 'W':
        return this.fail(`${name} is not supported: a script cannot write files`)
      case '#':
        return this.fail('a comment takes no address')
      default:
        return this.fail(`unknown command: '${name}'`)
    }
  }

  /** A run of digits at the cursor, as a number; `tooLarge` is the refusal for one past the safe integers. */
  private number(tooLarge: string): number {
    const from = this.i
    while (isDigit(this.src[this.i])) this.i++
    const n = Number(this.src.slice(from, this.i))
    if (!Number.isSafeInteger(n)) this.fail(tooLarge)
    return n
  }

  /** A first address at the cursor, or null when there is none. */
  private address(): Addr | null {
    const c = this.src[this.i]
    if (isDigit(c)) {
      const n = this.number('line number too large')
      if (n === 0) this.fail('line numbers start at 1')
      return { kind: 'line', n }
    }
    if (c === '$') {
      this.i++
      return { kind: 'last' }
    }
    if (c === '/' || c === '\\') {
      if (c === '\\') this.i++
      const d = this.delimiter('a \\ address needs a character to close its pattern with')
      return { kind: 'match', pat: this.pattern(this.regexText(d, `unterminated address pattern: no closing ${d}`), false) }
    }
    return null
  }

  /** The address after a comma: +N, or any first address. */
  private second(): Addr {
    if (this.src[this.i] === '+') {
      this.i++
      if (!isDigit(this.src[this.i])) this.fail('+ needs a number after it')
      return { kind: 'plus', n: this.number('line count too large') }
    }
    const a = this.address()
    if (a === null) this.fail('a range needs a second address after the comma')
    return a
  }

  /** The character at the cursor as a delimiter (a whole character, never a backslash or a line end), taken. */
  private delimiter(refusal: string): string {
    const cp = this.src.codePointAt(this.i)
    if (cp === undefined || cp === 10 || cp === 92) this.fail(refusal)
    const d = String.fromCodePoint(cp)
    this.i += d.length
    return d
  }

  /**
   * A pattern's text, up to the delimiter `d` (taken), as the engine is to read it. A backslash before the delimiter
   * makes it an ordinary character; inside a bracket set the delimiter is an ordinary character as it is; a
   * backslash before a line end stands for a line feed. `what` is the refusal when the delimiter never comes.
   */
  private regexText(d: string, what: string): string {
    const src = this.src
    let out = ''
    for (;;) {
      const c = src[this.i]
      if (c === undefined || c === '\n') this.fail(what)
      if (c === '\\') {
        const e = src[this.i + 1]
        if (e === undefined) this.fail(what)
        if (src.startsWith(d, this.i + 1)) {
          // A letter or digit stands for itself without its backslash; any other character keeps it, which makes it plain.
          out += isLetter(d) || isDigit(d) ? d : `\\${d}`
          this.i += 1 + d.length
        } else {
          out += e === '\n' ? '\\n' : `\\${e}`
          this.i += 2
        }
        continue
      }
      if (src.startsWith(d, this.i)) {
        this.i += d.length
        return out
      }
      if (c === '[') {
        out += this.set(what)
        continue
      }
      out += c
      this.i++
    }
  }

  /** A bracket set at the cursor, copied as it is up to its closing `]`, by the rules the engine reads it by. */
  private set(what: string): string {
    const src = this.src
    let out = '['
    this.i++
    if (src[this.i] === '^') {
      out += '^'
      this.i++
    }
    for (let first = true; ; first = false) {
      const c = src[this.i]
      if (c === undefined || c === '\n') this.fail(what)
      if (c === ']' && !first) {
        this.i++
        return `${out}]`
      }
      if (c === '\\') {
        const e = src[this.i + 1]
        if (e === undefined || e === '\n') this.fail(what)
        out += c + e
        this.i += 2
        continue
      }
      if (c === '[' && src[this.i + 1] === ':') {
        // A class name is letters and then `:]`; only the letters are looked at, never the rest of the script, so a
        // script full of `[:` costs no more than its length.
        let close = this.i + 2
        while (isLetter(src[close])) close++
        if (close > this.i + 2 && src.startsWith(':]', close)) {
          out += src.slice(this.i, close + 2)
          this.i = close + 2
          continue
        }
      }
      out += c
      this.i++
    }
  }

  /** A pattern made ready; an empty one stands for the last pattern used. */
  private pattern(text: string, fold: boolean): Pat {
    if (text === '') {
      if (this.written === null) this.fail('an empty pattern stands for the one before it, and there is none before it')
      if (fold) this.fail('an empty pattern cannot take the i flag')
      return { own: null, fallback: this.written }
    }
    let re: Regex
    try {
      re = compile(text, { ignoreCase: fold })
    } catch (e) {
      if (e instanceof RegexError) this.fail(e.message)
      throw e
    }
    this.written = re
    return { own: re, fallback: re }
  }

  /** The rest of `s/re/text/flags` after the `s`. */
  private substitution(cmd: Cmd): void {
    const src = this.src
    const d = this.delimiter('unterminated s command')
    const text = this.regexText(d, 'unterminated s command')
    const parts = this.replacement(d)
    let global = false
    let print = false
    let fold = false
    let nth = 0
    for (;;) {
      const c = src[this.i]
      if (c === 'g' || c === 'p' || c === 'i' || c === 'I') {
        const given = c === 'g' ? global : c === 'p' ? print : fold
        if (given) this.fail(`s: the ${c} flag is given twice`)
        if (c === 'g') global = true
        else if (c === 'p') print = true
        else fold = true
        this.i++
      } else if (isDigit(c)) {
        if (nth !== 0) this.fail('s: more than one number')
        nth = this.number('s: the number is too large')
        if (nth === 0) this.fail('s: matches are counted from 1, so the number cannot be 0')
      } else if (c === 'w') this.fail('the w flag of s is not supported: a script cannot write files')
      else if (c === undefined || c === ' ' || c === '\t' || c === ';' || c === '\n' || c === '}' || c === '#') break
      else this.fail(`unknown flag of s: '${c}'`)
    }
    const pat = this.pattern(text, fold)
    if (pat.own !== null) {
      const groups = pat.own.groupCount
      for (const p of parts) {
        if (typeof p === 'number' && p > groups) this.fail(`the replacement names group ${p}, but the pattern has ${groups === 0 ? 'no groups' : `only ${groups}`}`)
      }
    }
    cmd.sub = { pat, parts, global, nth: nth === 0 ? 1 : nth, print }
    this.finish()
  }

  /** The replacement of `s`, up to the delimiter (taken), as plain text and group numbers. */
  private replacement(d: string): (string | number)[] {
    const src = this.src
    const parts: (string | number)[] = []
    let lit = ''
    const group = (n: number): void => {
      if (lit !== '') parts.push(lit)
      lit = ''
      parts.push(n)
    }
    for (;;) {
      const c = src[this.i]
      if (c === undefined || c === '\n') this.fail('unterminated s command')
      if (c === '\\') {
        const e = src[this.i + 1]
        if (e === undefined) this.fail('unterminated s command')
        if (src.startsWith(d, this.i + 1)) {
          lit += d
          this.i += 1 + d.length
          continue
        }
        this.i += 2
        if (isDigit(e)) group(Number(e))
        else if (e === 'n' || e === '\n') lit += '\n'
        else if (e === 't') lit += '\t'
        else if (isLetter(e)) this.fail(`unknown escape \\${e} in the replacement`)
        else lit += e
        continue
      }
      if (src.startsWith(d, this.i)) {
        this.i += d.length
        break
      }
      if (c === '&') group(0)
      else lit += c
      this.i++
    }
    if (lit !== '') parts.push(lit)
    return parts
  }

  /** The rest of `y/abc/xyz/` after the `y`, as a map from each character to the one it becomes. */
  private transliteration(): Map<string, string> {
    const d = this.delimiter('unterminated y command')
    const from = this.characters(d)
    const to = this.characters(d)
    if (from.length !== to.length) this.fail('y: the two lists of characters differ in length')
    const map = new Map<string, string>()
    for (let k = 0; k < from.length; k++) {
      if (map.has(from[k])) this.fail(`y: '${from[k]}' is listed twice`)
      map.set(from[k], to[k])
    }
    return map
  }

  /** One list of `y`, up to the delimiter (taken), character by character. */
  private characters(d: string): string[] {
    const src = this.src
    const out: string[] = []
    for (;;) {
      const cp = src.codePointAt(this.i)
      if (cp === undefined || cp === 10) this.fail('unterminated y command')
      if (cp === 92) {
        const e = src[this.i + 1]
        if (src.startsWith(d, this.i + 1)) {
          out.push(d)
          this.i += 1 + d.length
          continue
        }
        if (e === '\\') out.push('\\')
        else if (e === 'n') out.push('\n')
        else if (e === undefined || e === '\n') this.fail('unterminated y command')
        else this.fail(`y: unknown escape \\${e}`)
        this.i += 2
        continue
      }
      const c = String.fromCodePoint(cp)
      this.i += c.length
      if (c === d) return out
      out.push(c)
    }
  }

  /**
   * The text of a, i or c: the rest of the line (blanks before it skipped), or, after `a\` and a line end, the next
   * line, blanks kept. A backslash before a line end carries the text on to the next line; a backslash before any
   * other character is dropped and the character kept.
   */
  private text(name: string): string {
    const src = this.src
    this.blanks()
    let marked = false
    if (src[this.i] === '\\') {
      this.i++
      if (src[this.i] === '\n') this.i++
      marked = true
    }
    if (this.i >= src.length || (!marked && src[this.i] === '\n')) this.fail(`${name} needs text`)
    let out = ''
    while (this.i < src.length) {
      const c = src[this.i]
      if (c === '\n') {
        this.i++
        break
      }
      if (c === '\\') {
        const e = src[this.i + 1]
        this.i += 2
        if (e !== undefined) out += e
        continue
      }
      out += c
      this.i++
    }
    return out
  }
}

// The output.

/**
 * Where what sed prints goes: the ordinary output through a buffer, or (for -i) a list kept in memory until the
 * file is done. When the input's last line had no line end, the pattern space printed for it has none either; if
 * anything is printed after it, the line end is put back first, so lines never run together.
 */
class Sink {
  private readonly out: Out | null
  private readonly kept: string[] = []
  private size = 0
  /** Whether the last thing printed was a pattern space that went without its line end. */
  private missing = false

  constructor(sys: Sys, memory: boolean) {
    this.out = memory ? null : new Out(sys)
  }

  /** Text exactly as given. */
  *text(text: string): Task<void> {
    if (this.missing) {
      this.missing = false
      yield* this.put('\n')
    }
    yield* this.put(text)
  }

  /** The pattern space (or a part of it) and its line end, unless `bare`: it is the input's last line, which had none. */
  *space(text: string, bare: boolean): Task<void> {
    yield* this.text(bare ? text : `${text}\n`)
    this.missing = bare
  }

  private *put(text: string): Task<void> {
    if (this.out === null) {
      this.size += text.length
      if (this.size > RESULT_MAX) throw new Halt(`the edited text would be larger than ${RESULT_MAX >> 20} MiB`)
      this.kept.push(text)
      return
    }
    try {
      yield* this.out.put(text)
    } catch (e) {
      throw spilt(e)
    }
  }

  *flush(): Task<void> {
    if (this.out === null) return
    try {
      yield* this.out.flush()
    } catch (e) {
      throw spilt(e)
    }
  }

  /** What was kept in memory, as one text. */
  result(): string {
    return this.kept.join('')
  }
}

// The input.

/** One line as the feed hands it out: its text, and whether a line end follows it. */
interface Got {
  readonly text: string
  readonly eol: boolean
}

/**
 * The input: the named files one after another as one long text ('-' is the ordinary input), a line at a time,
 * read in pieces and decoded as UTF-8. A file that cannot be opened or read is reported and passed over. It looks
 * one line ahead only when asked whether a line is the last (or when a file ends without a line end, to learn
 * whether anything follows), so sed answers each typed line as soon as it is typed. Before it waits for more input
 * it writes out what sed has printed so far.
 */
class Feed {
  private readonly sys: Sys
  private readonly sink: Sink
  private readonly paths: readonly string[]
  private index = 0
  private fd = -1
  private own = false
  private name: string | null = null
  private decoder = Feed.decoder()
  /** The piece read last, from `at` on not yet handed out. */
  private buffer = ''
  private at = 0
  /** The start of a line that runs on past the pieces read so far (each piece is searched for a line end once). */
  private parts: string[] = []
  private partsSize = 0
  private ended = false
  private ahead: Got | null = null
  /** Whether some file could not be opened or read. */
  failed = false

  constructor(sys: Sys, sink: Sink, paths: readonly string[]) {
    this.sys = sys
    this.sink = sink
    this.paths = paths
  }

  /** A UTF-8 decoder for one file; a byte order mark at its start is kept as a character, so -i never drops it. */
  private static decoder(): TextDecoder {
    return new TextDecoder('utf-8', { ignoreBOM: true })
  }

  /** The next line, or null when the input is over. */
  *take(): Task<Got | null> {
    let got = this.ahead
    this.ahead = null
    if (got === null) got = yield* this.pull()
    if (got === null || got.eol) return got
    // A file that ended without a line end: its last line is the input's last only when nothing follows it.
    const more = yield* this.pull()
    if (more === null) return got
    this.ahead = more
    return { text: got.text, eol: true }
  }

  /** Whether no line follows the one taken last. */
  *last(): Task<boolean> {
    if (this.ahead === null) this.ahead = yield* this.pull()
    return this.ahead === null
  }

  /** Lets go of the file being read, if any. */
  close(): void {
    if (this.fd >= 0 && this.own) this.sys.close(this.fd)
    this.fd = -1
    this.own = false
    this.buffer = ''
    this.at = 0
    this.parts = []
    this.partsSize = 0
  }

  /** The line begun in earlier pieces, with `tail` after it; the pieces are let go. */
  private gather(tail: string): string {
    if (this.parts.length === 0) return tail
    this.parts.push(tail)
    const text = this.parts.join('')
    this.parts = []
    this.partsSize = 0
    return text
  }

  /** The next line of the files as they are, with no looking ahead; null when every file is over. */
  private *pull(): Task<Got | null> {
    for (;;) {
      if (this.fd < 0) {
        if (this.index >= this.paths.length) return null
        yield* this.openNext()
        continue
      }
      const end = this.buffer.indexOf('\n', this.at)
      if (end >= 0) {
        if (this.partsSize + end - this.at > SPACE_MAX) throw new Halt(`a line of the input is longer than ${SPACE_TEXT}`)
        const text = this.gather(this.buffer.slice(this.at, end))
        this.at = end + 1
        return { text, eol: true }
      }
      // No line end in what is left of this piece: it is the start of a line that goes on in the next.
      if (this.at < this.buffer.length) {
        this.parts.push(this.at === 0 ? this.buffer : this.buffer.slice(this.at))
        this.partsSize += this.buffer.length - this.at
      }
      this.buffer = ''
      this.at = 0
      if (this.partsSize > SPACE_MAX) throw new Halt(`a line of the input is longer than ${SPACE_TEXT}`)
      if (this.ended) {
        const text = this.gather('')
        this.close()
        if (text !== '') return { text, eol: false }
        continue
      }
      yield* this.sink.flush()
      let chunk: Uint8Array
      try {
        chunk = yield* this.sys.read(this.fd)
      } catch (e) {
        if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
        // What was read before the refusal stays; the file is over here.
        yield* this.complain(this.name, e)
        chunk = EMPTY
      }
      if (chunk.length === 0) {
        this.ended = true
        this.buffer = this.decoder.decode()
      } else this.buffer = this.decoder.decode(chunk, { stream: true })
    }
  }

  private *openNext(): Task<void> {
    const path = this.paths[this.index++]
    this.decoder = Feed.decoder()
    this.buffer = ''
    this.at = 0
    this.parts = []
    this.partsSize = 0
    this.ended = false
    if (path === '-') {
      this.name = null
      this.fd = 0
      this.own = false
      return
    }
    this.name = path
    try {
      this.fd = yield* this.sys.open(path, O_READ)
      this.own = true
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* this.complain(path, e)
    }
  }

  private *complain(what: string | null, e: OsError): Task<void> {
    this.failed = true
    yield* this.sink.flush()
    yield* complain(this.sys, 'sed', what, e)
  }
}

// Running a script.

/** How a cycle ended: on to the next line, without printing, again on what is left (D), or with sed's end. */
const NEXT = 0
const DELETE = 1
const RESTART = 2
const QUIT = 3
const QUIT_SILENT = 4

/** The place after the character at `at` (a surrogate pair counts as one character). */
function after(text: string, at: number): number {
  const c = text.charCodeAt(at)
  if (c >= 0xd800 && c <= 0xdbff && at + 1 < text.length) {
    const d = text.charCodeAt(at + 1)
    if (d >= 0xdc00 && d <= 0xdfff) return at + 2
  }
  return at + 1
}

/**
 * What the search `re` just made cost: the engine's own count of the steps it took, which it keeps on the pattern it
 * hands out (regex.ts names it `steps`, though its interface does not), or, for a plain-text pattern it finds without
 * stepping, the `chars` it could have looked at. One search over a long text can cost far more than its characters
 * (a pattern that has to look ahead to the end of the text, every time `s///g` searches again), so counting
 * searches alone would let one line hold the console for seconds.
 */
function cost(re: Regex, chars: number): number {
  const steps = 'steps' in re && typeof re.steps === 'number' ? re.steps : 0
  return steps > 0 ? steps : chars
}

/** One run of a script over one input. */
class Editor {
  private readonly sys: Sys
  private readonly cmds: readonly Cmd[]
  private readonly feed: Feed
  private readonly sink: Sink
  private readonly quiet: boolean
  private pattern = ''
  private hold = ''
  private line = 0
  /** Whether the pattern space ends with the input's last line, and that line had no line end. */
  private bare = false
  /** What a and the like asked to be printed at the end of the cycle. */
  private appends: string[] = []
  /** The last pattern used, for `//`. */
  private used: Regex | null = null
  /** The length of the pattern space at the last D restart since a line was read (none: Infinity). */
  private shrink = Number.POSITIVE_INFINITY
  /** For each command with two addresses: whether its range is open, and the line it ends on when that is known. */
  private readonly active: boolean[]
  private readonly until: number[]
  /** Set while a command runs whose range ended on this line (or was only this line): `c` prints then. */
  private closed = false
  /** Matching work done since the other tasks last had a turn. */
  private work = 0
  /** Whether q ended the run, and the status it asked for (null: none). */
  quitted = false
  status: number | null = null

  constructor(sys: Sys, cmds: readonly Cmd[], feed: Feed, sink: Sink, quiet: boolean) {
    this.sys = sys
    this.cmds = cmds
    this.feed = feed
    this.sink = sink
    this.quiet = quiet
    this.active = cmds.map(() => false)
    this.until = cmds.map(() => 0)
  }

  *run(): Task<void> {
    let again = false
    for (;;) {
      yield* this.sys.step()
      if (!again && !(yield* this.next(false))) return
      again = false
      const end = yield* this.cycle()
      if (end === RESTART) {
        yield* this.flushAppends()
        again = true
        continue
      }
      if ((end === NEXT || end === QUIT) && !this.quiet) yield* this.sink.space(this.pattern, this.bare)
      yield* this.flushAppends()
      if (end === QUIT || end === QUIT_SILENT) return
    }
  }

  /** Reads the next line into the pattern space, or onto its end; false when the input is over. */
  private *next(append: boolean): Task<boolean> {
    const got = yield* this.feed.take()
    if (got === null) return false
    this.line++
    this.bare = !got.eol
    this.shrink = Number.POSITIVE_INFINITY
    this.pattern = append ? this.joined(this.pattern, got.text, 'pattern') : got.text
    return true
  }

  /** `a`, a line feed and `b`, within the cap of the space it is for. */
  private joined(a: string, b: string, which: string): string {
    if (a.length + 1 + b.length > SPACE_MAX) throw new Halt(`the ${which} space would hold more than ${SPACE_TEXT}`)
    return `${a}\n${b}`
  }

  private *flushAppends(): Task<void> {
    if (this.appends.length === 0) return
    const list = this.appends
    this.appends = []
    for (const text of list) yield* this.sink.text(text)
  }

  /** The script, once, over the pattern space. */
  private *cycle(): Task<number> {
    const cmds = this.cmds
    let pc = 0
    while (pc < cmds.length) {
      const c = cmds[pc]
      if (!(yield* this.selects(c, pc))) {
        pc = c.name === '{' ? c.end : pc + 1
        continue
      }
      pc++
      switch (c.name) {
        case '=':
          yield* this.sink.text(`${this.line}\n`)
          break
        case 'a':
          this.appends.push(`${c.text}\n`)
          break
        case 'i':
          yield* this.sink.text(`${c.text}\n`)
          break
        case 'c':
          // With a range, the text stands for the whole of it and is printed once, where the range ends.
          if (c.a2 === null || c.negate || this.closed) yield* this.sink.text(`${c.text}\n`)
          return DELETE
        case 'd':
          return DELETE
        case 'D': {
          const nl = this.pattern.indexOf('\n')
          if (nl < 0) return DELETE
          const rest = this.pattern.slice(nl + 1)
          if (rest.length >= this.shrink) throw new Halt('D did not make the pattern space shorter, so the cycle could repeat without end')
          this.shrink = rest.length
          this.pattern = rest
          return RESTART
        }
        case 'p':
          yield* this.sink.space(this.pattern, this.bare)
          break
        case 'P': {
          const nl = this.pattern.indexOf('\n')
          if (nl < 0) yield* this.sink.space(this.pattern, this.bare)
          else yield* this.sink.text(this.pattern.slice(0, nl + 1))
          break
        }
        case 'n':
          if (yield* this.feed.last()) return QUIT
          if (!this.quiet) yield* this.sink.space(this.pattern, this.bare)
          yield* this.flushAppends()
          yield* this.next(false)
          break
        case 'N':
          if (yield* this.feed.last()) return QUIT_SILENT
          yield* this.flushAppends()
          yield* this.next(true)
          break
        case 'q':
          this.quitted = true
          if (c.status >= 0) this.status = c.status
          return QUIT
        case 'h':
          this.hold = this.pattern
          break
        case 'H':
          this.hold = this.joined(this.hold, this.pattern, 'hold')
          break
        case 'g':
          this.pattern = this.hold
          break
        case 'G':
          this.pattern = this.joined(this.pattern, this.hold, 'pattern')
          break
        case 'x': {
          const held = this.hold
          this.hold = this.pattern
          this.pattern = held
          break
        }
        case 's':
          if (c.sub !== null) yield* this.substitute(c.sub)
          break
        case 'y':
          if (c.map !== null) yield* this.transliterate(c.map)
          break
        default:
          // { and } do nothing of their own.
          break
      }
    }
    return NEXT
  }

  /** Whether command `c` (at place `k`) applies to this line; it moves the command's range on as it asks. */
  private *selects(c: Cmd, k: number): Task<boolean> {
    this.closed = false
    if (c.a1 === null) return !c.negate
    const a2 = c.a2
    let hit: boolean
    if (a2 === null) hit = yield* this.at(c.a1)
    else {
      const counted = a2.kind === 'line' || a2.kind === 'plus'
      // A range that ends on a line number this command never saw (it was skipped) is over.
      if (this.active[k] && counted && this.line > this.until[k]) this.active[k] = false
      if (this.active[k]) {
        hit = true
        const over = counted ? this.line >= this.until[k] : a2.kind === 'last' ? yield* this.feed.last() : yield* this.test(a2.pat)
        if (over) {
          this.active[k] = false
          this.closed = true
        }
      } else {
        hit = yield* this.at(c.a1)
        if (hit) {
          if (counted) {
            const until = a2.kind === 'line' ? a2.n : this.line + a2.n
            if (until > this.line) {
              this.active[k] = true
              this.until[k] = until
            } else this.closed = true
          } else if (a2.kind === 'last' && (yield* this.feed.last())) this.closed = true
          else this.active[k] = true
        }
      }
    }
    return hit !== c.negate
  }

  private *at(a: Addr): Task<boolean> {
    if (a.kind === 'line') return this.line === a.n
    if (a.kind === 'last') return yield* this.feed.last()
    if (a.kind === 'match') return yield* this.test(a.pat)
    return false
  }

  private resolve(p: Pat): Regex {
    const re = p.own ?? this.used ?? p.fallback
    this.used = re
    return re
  }

  private *test(p: Pat): Task<boolean> {
    const re = this.resolve(p)
    const hit = re.test(this.pattern)
    yield* this.charge(cost(re, this.pattern.length))
    return hit
  }

  /** Counts matching work, and gives the other tasks a turn when there has been a lot of it. */
  private *charge(amount: number): Task<void> {
    this.work += amount + 32
    if (this.work >= PACE_WORK) {
      this.work = 0
      yield* this.sys.breathe()
    }
  }

  /**
   * `s`: the matches are found left to right, each search starting where the last match ended. A match of no
   * characters right where a match just ended is not one of its own (so replacing every run of a's, empty runs
   * included, by x turns `baaac` into `xbxcx`); after a match of no characters the search steps on by one character,
   * which is copied as it is.
   */
  private *substitute(sub: Subst): Task<void> {
    const re = this.resolve(sub.pat)
    const text = this.pattern
    const pieces: string[] = []
    let size = 0
    const keep = (piece: string): void => {
      size += piece.length
      if (size > SPACE_MAX) throw new Halt(`the pattern space would hold more than ${SPACE_TEXT}`)
      pieces.push(piece)
    }
    let pos = 0
    let copied = 0
    let seen = 0
    let ended = -1
    let changed = false
    while (pos <= text.length) {
      const m: Match | null = re.exec(text, pos)
      yield* this.charge(cost(re, (m === null ? text.length : m.end) - pos))
      if (m === null) break
      const empty = m.start === m.end
      if (!(empty && m.start === ended)) {
        seen++
        if (seen === sub.nth || (sub.global && seen > sub.nth)) {
          keep(text.slice(copied, m.start))
          for (const part of sub.parts) {
            if (typeof part === 'string') keep(part)
            else {
              const g = m.groups[part]
              if (g !== null && g !== undefined) keep(text.slice(g[0], g[1]))
            }
          }
          copied = m.end
          changed = true
          if (!sub.global) break
        }
        ended = m.end
      }
      if (!empty) pos = m.end
      else if (m.start >= text.length) break
      else pos = after(text, m.start)
    }
    if (!changed) return
    keep(text.slice(copied))
    this.pattern = pieces.join('')
    yield* this.charge(size)
    if (sub.print) yield* this.sink.space(this.pattern, this.bare)
  }

  private *transliterate(map: ReadonlyMap<string, string>): Task<void> {
    let out = ''
    let turns = 0
    for (const ch of this.pattern) {
      out += map.get(ch) ?? ch
      if ((++turns & PACE) === 0) yield* this.sys.step()
    }
    // A character may become one that takes two units (y/a/X/ with X past the first 65536), so the space can grow.
    if (out.length > SPACE_MAX) throw new Halt(`the pattern space would hold more than ${SPACE_TEXT}`)
    this.pattern = out
  }
}

// The program.

function* misuse(sys: Sys, bad: string): Task<number> {
  yield* complain(sys, 'sed', null, bad)
  return yield* usage(sys, USAGE)
}

/**
 * Puts a file's new text in place of its old: written over the old bytes from the start, then whatever is left past
 * the end cut off. A write refused for want of room changes nothing, so the file is then left as it was (cutting it
 * first and writing after would leave it empty).
 */
function* writeBack(sys: Sys, path: string, data: Uint8Array): Task<void> {
  const fd = yield* sys.open(path, O_WRITE)
  try {
    yield* sys.write(fd, data)
    const st = yield* sys.fstat(fd)
    if (st !== null && st.kind === 'file' && st.size > data.length) yield* sys.ftruncate(fd, data.length)
  } finally {
    sys.close(fd)
  }
}

/** What sed says when a run ended early on a limit or a refused write: the status. Anything else goes on up. */
function* stopped(sys: Sys, sink: Sink, e: unknown): Task<number> {
  if (e instanceof Halt) {
    try {
      yield* sink.flush()
    } catch (f) {
      if (!(f instanceof WriteFailed)) throw f
    }
    yield* sys.eprint(`sed: ${e.message}; stopped\n`)
    return 1
  }
  if (e instanceof WriteFailed) {
    yield* complain(sys, 'sed', 'write error', e.why)
    return 1
  }
  throw e
}

const sed: Program = function* (sys, argv) {
  const scripts: string[] = []
  let quiet = false
  let inPlace = false
  let i = 1
  for (; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      i++
      break
    }
    if (a.length < 2 || a[0] !== '-') break
    if (a.startsWith('--')) return yield* misuse(sys, `unknown option '${a}'`)
    for (let j = 1; j < a.length; j++) {
      const c = a[j]
      if (c === 'n') quiet = true
      else if (c === 'i') inPlace = true
      else if (c === 'E') {
        // Patterns are always the extended kind; -E is taken so that scripts written with it run.
      } else if (c === 'e') {
        const value = j + 1 < a.length ? a.slice(j + 1) : argv[++i]
        if (value === undefined) return yield* misuse(sys, "option '-e' needs a script")
        scripts.push(value)
        break
      } else return yield* misuse(sys, `unknown option '-${c}'`)
    }
  }
  const rest = argv.slice(i)
  let files = rest
  if (scripts.length === 0) {
    if (rest.length === 0) return yield* usage(sys, USAGE)
    scripts.push(rest[0])
    files = rest.slice(1)
  }
  const script = scripts.join('\n')
  if (script.startsWith('#n') && (script.length === 2 || script[2] === '\n')) quiet = true
  let cmds: Cmd[]
  try {
    cmds = new Parser(script).parse()
  } catch (e) {
    if (!(e instanceof ScriptError)) throw e
    yield* sys.eprint(`sed: ${e.message}\n`)
    return 2
  }

  if (!inPlace) {
    const sink = new Sink(sys, false)
    const feed = new Feed(sys, sink, files.length === 0 ? ['-'] : files)
    const editor = new Editor(sys, cmds, feed, sink, quiet)
    try {
      yield* editor.run()
      yield* sink.flush()
    } catch (e) {
      return yield* stopped(sys, sink, e)
    } finally {
      feed.close()
    }
    return editor.status ?? (feed.failed ? 1 : 0)
  }

  if (files.length === 0) {
    yield* sys.eprint('sed: -i needs a file to edit\n')
    return 2
  }
  if (files.includes('-')) {
    yield* sys.eprint('sed: -i cannot edit the standard input (-)\n')
    return 2
  }
  // Each file is edited on its own, as if sed were run on it alone, and written back only once it was read to its
  // end without trouble.
  let failed = false
  for (const path of files) {
    const sink = new Sink(sys, true)
    const feed = new Feed(sys, sink, [path])
    const editor = new Editor(sys, cmds, feed, sink, quiet)
    try {
      yield* editor.run()
    } catch (e) {
      if (!(e instanceof Halt)) throw e
      yield* sys.eprint(`sed: ${path}: ${e.message}; stopped, and the file is left as it was\n`)
      return 1
    } finally {
      feed.close()
    }
    if (feed.failed) failed = true
    else {
      try {
        yield* writeBack(sys, path, encode(sink.result()))
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        yield* complain(sys, 'sed', path, e)
        failed = true
      }
    }
    if (editor.quitted) return editor.status ?? (failed ? 1 : 0)
  }
  return failed ? 1 : 0
}

const SED = `NAME
    sed - edit text as it flows past: replace, delete or add lines

USAGE
    sed [-n] [-E] [-i] [-e script]... [script] [file ...]

WHAT IT DOES
    sed reads text one line at a time, runs a short script of commands
    on each line, and prints what comes out. It reads the named files
    one after another as if they were one long text (lines are counted
    across all of them, and $ is the last line of the last file), or
    what is typed or piped in when no file is named. The script is read
    and checked in full before any input is: a mistake in it is reported
    at once and nothing is printed or changed.

    The line being worked on is the "pattern space". A second store, the
    "hold space", keeps text from one line to the next; it starts empty.
    After the script has run on a line, the pattern space is printed
    (unless -n was given) and the next line is read: this is one cycle.

    The script is a list of commands, separated by line ends or by ";".
    Several -e options are joined with line ends between them. A # starts
    a comment that runs to the end of the line; a script whose first line
    is exactly #n works as if -n had been given.

    Addresses. A command may start with an address that says which lines
    it works on; with none it works on every line.
      N           line number N (counted from 1)
      $           the last line
      /re/        the lines the pattern re is found in; \\cREc does the
                  same with another character c in place of the /
      A,B         from a line A selects through the next line B selects;
                  B is looked for from the line after A, and when B is a
                  line number not after A, only line A is selected
      A,+N        a line A selects and the N lines after it
      A!  A,B!    every line the address does not select

    Patterns are always the extended kind: . is any character, * + ?
    and {m,n} repeat what is before them, ( ) groups, | separates
    choices, [abc] [a-z] [^a-z] are sets, ^ and $ are the start and the
    end of the pattern space, \\n is a line feed, \\t a tab, \\w a letter,
    digit or _, \\d a digit, \\s white space, and a backslash before any
    other sign makes it plain (\\. is a dot, \\/ a slash). An empty
    pattern // stands for the last pattern used; until one has been
    used, for the last one written before it in the script.

    Commands (each may follow an address unless said otherwise):
      s/re/text/flags  replace what re matches with text (see below)
      d           delete the pattern space; start the next cycle
      p           print the pattern space
      =           print the line number, on a line of its own
      q [N]       print the pattern space (unless -n) and stop sed, with
                  exit status N when given (one address at most)
      y/abc/xyz/  change each a to x, each b to y, each c to z
      a TEXT      print TEXT at the end of the cycle
      i TEXT      print TEXT now
      c TEXT      delete the pattern space and print TEXT instead; over
                  a range, TEXT is printed once, where the range ends
      n           print the pattern space (unless -n) and read the next
                  line in its place; on the last line, end as q does
      N           add a line feed and the next line to the pattern space
      D           delete up to the first line feed and run the script
                  again on what is left, without reading; with no line
                  feed, the same as d
      P           print up to the first line feed
      h  H        copy the pattern space to the hold space (H adds it to
                  the end, after a line feed)
      g  G        copy the hold space to the pattern space (G adds it)
      x           swap the pattern space and the hold space
      { ... }     run the commands inside on the lines the address
                  selects
    TEXT is the rest of the line, blanks at its start skipped. The form
    a\\ with TEXT on the next line is taken too, and keeps the blanks; a
    backslash at the end of a line of TEXT carries it on to the next,
    and any other backslash in TEXT is dropped.

    In s, the text may use & for the whole match, \\1 to \\9 for what the
    groups matched (\\0 is the whole match too), \\n for a line feed and
    \\t for a tab; a backslash before &, before the delimiter or before
    a backslash makes it plain. Any character but a backslash or a line
    end may stand in for the /, and inside a set such as [^/] it is a
    plain character. The flags are g (every match, not only the first),
    a number N (only the Nth match; with g, the Nth and all after it),
    p (print the pattern space if a replacement was made) and i or I
    (letters match in either case). A match of no characters right after
    another match does not count, so s/x*/-/g turns abc into -a-b-c-.

OPTIONS
    -n          print only what p, P, =, a, i, c and the like ask for
    -e SCRIPT   a piece of the script (may be given several times); then
                every operand is a file
    -E          accepted, and changes nothing: patterns are always the
                extended kind
    -i          edit each named file in place instead of printing: the
                file gets back what sed would have printed. Each file is
                edited on its own, as if sed were run on it alone (line
                numbers start again at 1 and $ is its last line), and is
                written only once it was read to its end without error;
                when the new text does not fit on the disk, the file is
                left as it was. No backup copy is kept.

NOTES
    There are no labels or branches: b, t and :label are refused with
    "sed: branches are not supported". Also not supported: the r, w and
    l commands, the w flag of s, scripts read from a file (-f; use -e
    instead), back-references such as \\1 inside a pattern, and the
    escapes \\L \\U in a replacement.

    N on the last line ends sed without printing the pattern space; write
    $!N to keep that line. When the input's last line has no line end,
    the pattern space printed for it has none either. Text is read as
    UTF-8: bytes that are not come out as the replacement character.
    In y, a backslash may only come before n, a backslash or the
    delimiter, and a character listed twice is refused. q with -i leaves
    the file holding only what was printed before q, and later files
    are not touched.

    Limits: the pattern space and the hold space hold at most 8 MiB of
    text each (8388608 characters), and a longer line is refused; a file
    edited in place gets back at most 64 MiB. Past a limit sed says so
    and stops. D runs the script again without reading only while that
    leaves a shorter pattern space each time; when it would not (as in
    G;D), sed says so and stops instead of going round for ever.

STATUS
    0; 1 when a file could not be read or written or sed stopped at a
    limit; 2 for a wrong option or a mistake in the script (reported as
    "sed: what is wrong", before any input is read). q N ends with N.

EXAMPLE
    sed 's/cat/dog/g' notes       every "cat" becomes "dog"
    sed -n '2,4p' notes           only lines 2 to 4
    sed '/^#/d' list              without the lines that start with #
    sed -i '$a the end' notes     add a last line to the file itself
    sed '1!G;h;$!d' notes         the lines in the opposite order
`

/** name -> program */
export const SED_PROGRAMS: Readonly<Record<string, Program>> = Object.freeze({ sed })

/** name -> manual page text */
export const SED_MANUAL: Readonly<Record<string, string>> = Object.freeze({ sed: SED })
