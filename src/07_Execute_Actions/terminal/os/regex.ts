// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A program that searches or rewrites text takes its pattern from whoever is typing, and
 * a matcher that tries one path at a time can be handed a pattern that outlasts the page. This is the layer's own
 * regular-expression engine, the only one its programs use on a typed pattern. The pattern is read into a tree, the
 * tree is laid out as a short list of instructions, and the list is run by keeping every path alive at once: all
 * the paths at one text position take their step together, and an instruction is visited at most once per position.
 * A match therefore costs at most 2 x (instructions) x (characters + 1) steps whatever the pattern and the text
 * are, nothing here recurses on the text, and the host's own matcher is never given a typed pattern.
 * The paths are kept in order of preference, and that order decides the answer: the match that starts leftmost,
 * and among those the one a path-at-a-time matcher would reach first, where a repetition prefers more rounds to
 * fewer (it is greedy) and of two alternatives the one written first wins a tie.
 * What breaks if it is removed? Every program that takes a pattern would need a matcher of its own, and the first
 * one to lean on the host's would let one typed line stall the whole console.
 *
 * The syntax is the extended kind, always. Ordinary characters stand for themselves; `.` is any one character, a
 * line feed included; `[abc]`, `[a-z]`, `[^a-z]` are sets (`]` first in a set is itself, `-` first or last is
 * itself, `[:alpha:]` and the other named classes go inside a set); `^` and `$` are the start and the end of the
 * whole text; `( )` groups and captures; `|` separates alternatives; `*`, `+`, `?`, `{m}`, `{m,}`, `{m,n}` repeat
 * the item before them. A backslash before a character that is no letter or digit makes it ordinary; `\t \n` are a
 * tab and a line feed; `\w \d \s` are a word character, a digit, white space, and `\W \D \S` anything else;
 * `\b \B` are a word edge and its absence; `\< \>` are the start and the end of a word.
 *
 * What was chosen where that list leaves a gap:
 * - The named classes, `\w \d \s` and the word edges know the ASCII letters and digits only.
 * - A backslash works inside a set as it does outside (`[\]\t\d]`), so a backslash in a set is written `\\`.
 * - A `{` that does not begin a well-formed count, and a lone `]` or `}`, stand for themselves.
 * - An alternative, a group or the whole pattern may be empty: it matches no characters, wherever it is tried.
 * - A repetition mark needs an item before it: at the start, after `(` or `|`, or after an anchor or a word edge
 *   it is refused. Marks may be stacked, each one repeating all that is before it, so `a*?` is `(a*)?`: there is
 *   no lazy repetition. An item repeated `{0}` times is left out, and a group in it never takes part.
 * - Past its least count a repetition never takes a round that matched no characters (which is why `(a*)*` ends),
 *   and a group inside a repetition reports its last round only: nothing, if that round went another way.
 * - Refused by name: a back-reference (`\1`: it cannot be matched in linear time), an unknown letter escape,
 *   `[=a=]` and `[.a.]`, a range written backwards, `[:alpha:]` outside a set, an unmatched bracket.
 * - ignoreCase: two characters are the same when they fold to the same one (the lower case of the upper case, each
 *   taken only when it is a single character). A range in a set matches when it holds the text's character, its
 *   lower case or its upper case.
 * Bounds: a pattern of at most 4096 characters; groups nested at most 100 deep, where each repetition mark after
 * an item's first counts as one level more; and at most 20000 instructions, counted on the tree before anything is
 * laid out, so `a{1000}{1000}` is refused without being expanded.
 */

/** How a pattern is read. */
export interface RegexOptions {
  /** Letters match in either case. */
  readonly ignoreCase?: boolean
  /** The pattern is plain text: no character in it is special. */
  readonly literal?: boolean
}

/**
 * One match. Every offset is a UTF-16 index into the text. `groups` always has ten entries: `groups[0]` is the whole
 * match and `groups[1]` to `groups[9]` are the first nine groups, null for a group that took no part or is not there.
 */
export interface Match {
  readonly start: number
  readonly end: number
  readonly groups: readonly (readonly [number, number] | null)[]
}

/** A pattern made ready. */
export interface Regex {
  /** The pattern as it was given. */
  readonly source: string
  /** How many groups the pattern has (only the first nine are reported). */
  readonly groupCount: number
  /**
   * The leftmost match that starts at or after `from` (0 when not given), or null. Anchors and word edges still
   * look at the whole text, and a match of no characters is a match. A `from` between the two halves of a surrogate
   * pair means the place after the pair, and one past the end of the text finds nothing.
   */
  exec(text: string, from?: number): Match | null
  /** Whether the pattern matches anywhere in the text. */
  test(text: string): boolean
}

/** A pattern that was refused; the message says why, in lower case and without a full stop. */
export class RegexError extends Error {}

/** The longest pattern, in UTF-16 units. */
const PATTERN_MAX = 4096
/** The most instructions a pattern may need. */
const PROGRAM_MAX = 20000
/** The deepest nesting: groups within groups, plus repetition marks stacked on one item. */
const NEST_MAX = 100
/** How many groups are reported. */
const REPORTED = 9
/** The last code point there is. */
const LAST = 0x10ffff

function fail(message: string): never {
  throw new RegexError(message)
}

// The characters the syntax gives a meaning to, as code points.
const DOLLAR = 36
const OPEN = 40
const CLOSE = 41
const STAR = 42
const PLUS = 43
const COMMA = 44
const DASH = 45
const DOT = 46
const COLON = 58
const EQUALS = 61
const QUERY = 63
const BRACKET = 91
const BACKSLASH = 92
const UNBRACKET = 93
const CARET = 94
const BRACE = 123
const BAR = 124
const UNBRACE = 125

// What an assertion checks: it matches no characters, only a place in the text.
const TEXT_START = 0
const TEXT_END = 1
const EDGE = 2
const NO_EDGE = 3
const WORD_START = 4
const WORD_END = 5

const DIGITS: readonly number[] = [48, 57]
const WORDS: readonly number[] = [48, 57, 65, 90, 95, 95, 97, 122]
const SPACES: readonly number[] = [9, 13, 32, 32]

/** The named classes, each as pairs of first and last code point. */
const CLASSES: ReadonlyMap<string, readonly number[]> = new Map<string, readonly number[]>([
  ['alpha', [65, 90, 97, 122]],
  ['digit', DIGITS],
  ['alnum', [48, 57, 65, 90, 97, 122]],
  ['upper', [65, 90]],
  ['lower', [97, 122]],
  ['space', SPACES],
  ['blank', [9, 9, 32, 32]],
  ['punct', [33, 47, 58, 64, 91, 96, 123, 126]],
  ['xdigit', [48, 57, 65, 70, 97, 102]],
  ['print', [32, 126]],
  ['graph', [33, 126]],
  ['cntrl', [0, 31, 127, 127]],
])

const isDigit = (c: number): boolean => c >= 48 && c <= 57
const isLetter = (c: number): boolean => (c >= 97 && c <= 122) || (c >= 65 && c <= 90)
const isWord = (c: number): boolean => isLetter(c) || isDigit(c) || c === 95
const isSurrogate = (c: number): boolean => c >= 0xd800 && c <= 0xdfff
const isHighHalf = (c: number): boolean => c >= 0xd800 && c <= 0xdbff
const isLowHalf = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff

/** A character as a message shows it: itself when it can be seen and is ASCII, its number (`u+00e9`) otherwise. */
function show(c: number): string {
  return c > 32 && c < 127 ? String.fromCharCode(c) : `u+${c.toString(16).padStart(4, '0')}`
}

/** The code points of a text; a surrogate pair is one, a surrogate on its own is itself. */
function points(text: string): number[] {
  const out: number[] = []
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const d = text.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) {
        c = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000
        i++
      }
    }
    out.push(c)
  }
  return out
}

/** `changed` as one code point, or `c` itself when the change gave more than one character. */
function single(changed: string, c: number): number {
  const p = changed.codePointAt(0)
  return p !== undefined && changed.length === (p > 0xffff ? 2 : 1) ? p : c
}

function lower(c: number): number {
  if (c < 128) return c >= 65 && c <= 90 ? c + 32 : c
  return single(String.fromCodePoint(c).toLowerCase(), c)
}

function upper(c: number): number {
  if (c < 128) return c >= 97 && c <= 122 ? c - 32 : c
  return single(String.fromCodePoint(c).toUpperCase(), c)
}

/** What a character is compared as when case is ignored. */
function folded(c: number): number {
  return lower(upper(c))
}

// ---------------------------------------------------------------------------------------------------------------
// Sets

/** A set of characters. */
interface CharSet {
  /** Pairs of first and last code point, in order, never touching. */
  readonly ranges: Int32Array
  readonly negate: boolean
  /** The answer for each code point below 128, with the negation and the case folding already in it. */
  readonly ascii: Uint8Array
}

/** Pairs put in order, with the ones that overlap or touch joined. */
function joined(pairs: readonly number[]): Int32Array {
  const order: number[] = []
  for (let i = 0; i < pairs.length; i += 2) order.push(i)
  order.sort((x, y) => pairs[x] - pairs[y])
  const out: number[] = []
  for (const i of order) {
    const last = out.length - 1
    if (last >= 0 && pairs[i] <= out[last] + 1) {
      if (pairs[i + 1] > out[last]) out[last] = pairs[i + 1]
    } else out.push(pairs[i], pairs[i + 1])
  }
  return Int32Array.from(out)
}

/** Every code point that is in none of the pairs. */
function others(pairs: readonly number[]): number[] {
  const ranges = joined(pairs)
  const out: number[] = []
  let next = 0
  for (let i = 0; i < ranges.length; i += 2) {
    if (ranges[i] > next) out.push(next, ranges[i] - 1)
    next = ranges[i + 1] + 1
  }
  if (next <= LAST) out.push(next, LAST)
  return out
}

function within(ranges: Int32Array, c: number): boolean {
  let lo = 0
  let hi = (ranges.length >> 1) - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (c < ranges[2 * mid]) hi = mid - 1
    else if (c > ranges[2 * mid + 1]) lo = mid + 1
    else return true
  }
  return false
}

function makeSet(pairs: readonly number[], negate: boolean, fold: boolean): CharSet {
  const ranges = joined(pairs)
  const ascii = new Uint8Array(128)
  for (let c = 0; c < 128; c++) {
    const inside = within(ranges, c) || (fold && (within(ranges, lower(c)) || within(ranges, upper(c))))
    ascii[c] = inside !== negate ? 1 : 0
  }
  return { ranges, negate, ascii }
}

// ---------------------------------------------------------------------------------------------------------------
// The tree

type Kind = 'empty' | 'char' | 'any' | 'set' | 'assert' | 'group' | 'cat' | 'alt' | 'repeat'

/** One node of a pattern's tree, with what the layout needs to know about it worked out as it is made. */
interface Node {
  readonly kind: Kind
  /** char: its code point. set: its index. assert: what it checks. group: its number. repeat: the least count. */
  readonly n: number
  /** repeat: the greatest count, or -1 when there is none. */
  readonly m: number
  readonly kids: readonly Node[]
  /** How many instructions it lays out as. */
  readonly size: number
  /** How many instructions its early copy lays out as: the ways into it, up to the first character taken. */
  readonly early: number
  /** How many of its instructions take a character (those of early copies inside it not counted). */
  readonly takers: number
  /** Whether it can match no characters at all. */
  readonly nullable: boolean
  /** The lowest and the highest group number inside it (`lo > hi` when it holds no group). */
  readonly lo: number
  readonly hi: number
  /** Groups within groups plus repetition marks stacked on one item, along its deepest path. */
  readonly nest: number
}

const NO_KIDS: readonly Node[] = Object.freeze([])
const EMPTY: Node = Object.freeze({ kind: 'empty', n: 0, m: 0, kids: NO_KIDS, size: 0, early: 0, takers: 0, nullable: true, lo: 1, hi: 0, nest: 0 })

/** One character (`char`, `any`, `set`). Its early copy is itself and a jump on into the item it is part of. */
function taker(kind: 'char' | 'any' | 'set', n: number): Node {
  return { kind, n, m: 0, kids: NO_KIDS, size: 1, early: 2, takers: 1, nullable: false, lo: 1, hi: 0, nest: 0 }
}

/** A place in the text: it matches no characters. */
function place(what: number): Node {
  return { kind: 'assert', n: what, m: 0, kids: NO_KIDS, size: 1, early: 1, takers: 0, nullable: true, lo: 1, hi: 0, nest: 0 }
}

/** A size that is allowed, or the refusal: this is what keeps a pattern from being laid out past the bound. */
function sized(size: number): number {
  if (size > PROGRAM_MAX) fail('pattern too large')
  return size
}

function nested(nest: number): number {
  if (nest > NEST_MAX) fail('pattern nested too deeply')
  return nest
}

/** Whether a node holds a group that is reported. */
function reports(node: Node): boolean {
  return node.lo <= node.hi && node.lo <= REPORTED
}

function many(kind: 'cat' | 'alt', kids: readonly Node[]): Node {
  let size = kind === 'alt' ? 2 * (kids.length - 1) : 0
  let early = size
  let takers = 0
  let nullable = kind === 'cat'
  let lo = 1
  let hi = 0
  let nest = 0
  for (const kid of kids) {
    size += kid.size
    // The early copy of items in a row stops after the first that must take a character: nothing gets past it.
    if (kind === 'alt' || nullable) early += kid.early
    takers += kid.takers
    nullable = kind === 'cat' ? nullable && kid.nullable : nullable || kid.nullable
    if (kid.lo <= kid.hi) {
      if (lo > hi) lo = kid.lo
      hi = kid.hi
    }
    if (kid.nest > nest) nest = kid.nest
  }
  return { kind, n: 0, m: 0, kids, size: sized(size), early, takers, nullable, lo, hi, nest }
}

/** Items one after another. */
function cat(kids: readonly Node[]): Node {
  return kids.length === 0 ? EMPTY : kids.length === 1 ? kids[0] : many('cat', kids)
}

/** Alternatives, the first written preferred. */
function alt(kids: readonly Node[]): Node {
  return kids.length === 1 ? kids[0] : many('alt', kids)
}

function group(index: number, kid: Node): Node {
  const saves = index <= REPORTED ? 2 : 0
  const nest = nested(kid.nest + 1)
  return {
    kind: 'group', n: index, m: 0, kids: [kid], size: sized(kid.size + saves), early: kid.early + saves, takers: kid.takers,
    nullable: kid.nullable, lo: index, hi: Math.max(index, kid.hi), nest,
  }
}

/**
 * `kid` repeated `min` to `max` times (`max` -1: no limit). The sizes are the layout's (see `Layout.repeat`),
 * counted here without laying anything out, which is what lets a pattern be refused for its size unexpanded.
 */
function repeat(kid: Node, min: number, max: number): Node {
  // An item repeated no times is nothing, and so is nothing repeated: no instruction is laid out for either, and a
  // group inside takes no part in any match. From here on the item has a size, which the counting below leans on.
  if (max === 0 || kid.size === 0) return EMPTY
  const nest = nested(kid.nest + (kid.kind === 'repeat' ? 1 : 0))
  const clear = reports(kid) ? 1 : 0
  // Copies in all, and how many of them are rounds past the least count.
  const copies = max === -1 ? min + 1 : max
  const more = copies - min
  const clears = clear * (max === -1 ? Math.max(min, 1) : Math.max(max - 1, 0))
  const size = copies * kid.size + clears + (max === -1 ? 2 : more) + (kid.nullable ? more * (kid.early + 1) : 0)
  // The early copy: the least count as far as a path can get without a character, then one try at one round more.
  const laid = kid.nullable ? min : Math.min(min, 1)
  const open = more > 0 && (kid.nullable || min === 0)
  const early = laid * kid.early + clear * Math.max(laid - 1, 0) + (open ? 2 + kid.early + (max === -1 || min > 0 ? clear : 0) : 0)
  return {
    kind: 'repeat', n: min, m: max, kids: [kid], size: sized(size), early, takers: copies * kid.takers,
    nullable: min === 0 || kid.nullable, lo: kid.lo, hi: kid.hi, nest,
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Reading a pattern

/** The ranges of `\w`, `\d` or `\s` for that letter in either case (the capital means all but these), or null. */
function shorthand(c: number): readonly number[] | null {
  const small = c | 32
  return small === 119 ? WORDS : small === 100 ? DIGITS : small === 115 ? SPACES : null
}

/** Reads a pattern into its tree. It recurses only where a group opens, and a group may open only so deep. */
class Reader {
  private readonly cps: readonly number[]
  private readonly fold: boolean
  private at = 0
  private depth = 0
  /** How many groups have opened so far. */
  groups = 0
  readonly sets: CharSet[] = []

  constructor(cps: readonly number[], fold: boolean) {
    this.cps = cps
    this.fold = fold
  }

  /** The code point at `i`, or -1 past the end. */
  private code(i: number): number {
    return i < this.cps.length ? this.cps[i] : -1
  }

  all(): Node {
    const node = this.alternatives()
    // Only a `)` stops the reading early, and here no group is open.
    if (this.at < this.cps.length) fail('unmatched ) in pattern')
    return node
  }

  private alternatives(): Node {
    const kids = [this.sequence()]
    while (this.code(this.at) === BAR) {
      this.at++
      kids.push(this.sequence())
    }
    return alt(kids)
  }

  private sequence(): Node {
    const kids: Node[] = []
    for (;;) {
      const c = this.code(this.at)
      if (c === -1 || c === BAR || c === CLOSE) return cat(kids)
      kids.push(this.piece())
    }
  }

  /** One item and the repetition marks after it. */
  private piece(): Node {
    const c = this.code(this.at)
    let item: Node
    if (c === OPEN) item = this.group()
    else if (c === BRACKET) item = this.set()
    else if (c === BACKSLASH) item = this.escape()
    else if (c === STAR || c === PLUS || c === QUERY || (c === BRACE && this.count() !== null)) fail(`nothing to repeat before ${show(c)}`)
    else {
      this.at++
      item = c === DOT ? taker('any', 0) : c === CARET ? place(TEXT_START) : c === DOLLAR ? place(TEXT_END) : taker('char', c)
    }
    const bare = item.kind === 'assert'
    for (;;) {
      const mark = this.code(this.at)
      let min = 0
      let max = -1
      if (mark === STAR || mark === PLUS || mark === QUERY) {
        this.at++
        if (mark === PLUS) min = 1
        if (mark === QUERY) max = 1
      } else if (mark === BRACE) {
        const counts = this.count()
        if (counts === null) return item
        min = counts[0]
        max = counts[1]
      } else return item
      if (bare) fail(`nothing to repeat before ${show(mark)}`)
      item = repeat(item, min, max)
    }
  }

  private group(): Node {
    this.at++
    if (++this.depth > NEST_MAX) fail('pattern nested too deeply')
    const index = ++this.groups
    const inner = this.alternatives()
    if (this.code(this.at) !== CLOSE) fail('unmatched ( in pattern')
    this.at++
    this.depth--
    return group(index, inner)
  }

  /**
   * Reads `{m}`, `{m,}` or `{m,n}` at the cursor and moves past it, giving the two counts (-1: no limit). Null, and
   * no move, when what is there is not a well-formed count: the `{` then stands for itself.
   */
  private count(): readonly [number, number] | null {
    let i = this.at + 1
    let min = 0
    const first = i
    for (; isDigit(this.code(i)); i++) min = Math.min(min * 10 + this.code(i) - 48, PROGRAM_MAX + 1)
    if (i === first) return null
    let max = min
    if (this.code(i) === COMMA) {
      i++
      const second = i
      max = 0
      for (; isDigit(this.code(i)); i++) max = Math.min(max * 10 + this.code(i) - 48, PROGRAM_MAX + 1)
      if (i === second) max = -1
    }
    if (this.code(i) !== UNBRACE) return null
    this.at = i + 1
    if (min > PROGRAM_MAX || max > PROGRAM_MAX) fail('pattern too large')
    if (max !== -1 && max < min) fail(`repetition counts out of order: {${min},${max}}`)
    return [min, max]
  }

  /** A backslash and what follows it, outside a set. */
  private escape(): Node {
    const c = this.code(this.at + 1)
    if (c === -1) fail('pattern ends with a backslash')
    this.at += 2
    const ranges = shorthand(c)
    if (ranges !== null) {
      this.sets.push(makeSet(ranges, c < 97, this.fold))
      return taker('set', this.sets.length - 1)
    }
    if (c === 98) return place(EDGE)
    if (c === 66) return place(NO_EDGE)
    if (c === 60) return place(WORD_START)
    if (c === 62) return place(WORD_END)
    return taker('char', this.plain(c))
  }

  /** The character a backslash before `c` stands for, when it stands for one. */
  private plain(c: number): number {
    if (c === 116) return 9
    if (c === 110) return 10
    if (c >= 49 && c <= 57) fail('back-references are not supported')
    if (isLetter(c) || isDigit(c)) fail(`unknown escape \\${show(c)}`)
    return c
  }

  /** A set, from its `[` to its `]`. */
  private set(): Node {
    this.at++
    let negate = false
    if (this.code(this.at) === CARET) {
      negate = true
      this.at++
    }
    this.lone(negate)
    const pairs: number[] = []
    for (let first = true; ; first = false) {
      const c = this.code(this.at)
      if (c === -1) fail('unmatched [ in pattern')
      if (c === UNBRACKET && !first) break
      const lo = this.member(pairs)
      const next = this.code(this.at + 1)
      if (this.code(this.at) !== DASH || next === UNBRACKET || next === -1) {
        if (lo >= 0) this.one(pairs, lo)
        continue
      }
      this.at++
      const hi = this.member(pairs)
      if (lo < 0 || hi < 0) fail('a class cannot be the end of a range')
      if (hi < lo) fail(`range out of order: ${show(lo)}-${show(hi)}`)
      pairs.push(lo, hi)
    }
    this.at++
    this.sets.push(makeSet(pairs, negate, this.fold))
    return taker('set', this.sets.length - 1)
  }

  /** A single character of a set; when case is ignored, what it folds to as well, so it matches as a lone one does. */
  private one(pairs: number[], c: number): void {
    pairs.push(c, c)
    if (!this.fold) return
    const f = folded(c)
    if (f !== c) pairs.push(f, f)
  }

  /**
   * One member of a set at the cursor: a character (its code point comes back), or a class (its ranges are added to
   * `pairs` and -1 comes back).
   */
  private member(pairs: number[]): number {
    const c = this.code(this.at)
    if (c === -1) fail('unmatched [ in pattern')
    if (c === BRACKET) {
      const next = this.code(this.at + 1)
      if (next === EQUALS || next === DOT) fail('[= =] and [. .] are not supported')
      const name = next === COLON ? this.name(this.at + 2) : ''
      if (name !== '') {
        const ranges = CLASSES.get(name)
        if (ranges === undefined) fail(`unknown class [:${name}:]`)
        this.at += name.length + 4
        pairs.push(...ranges)
        return -1
      }
    }
    if (c === BACKSLASH) {
      const e = this.code(this.at + 1)
      if (e === -1) fail('unmatched [ in pattern')
      this.at += 2
      const ranges = shorthand(e)
      if (ranges === null) return this.plain(e)
      pairs.push(...(e < 97 ? others(ranges) : ranges))
      return -1
    }
    this.at++
    return c
  }

  /** The letters at `i` when `:]` follows them (a class name as it is written in a set); '' otherwise. */
  private name(i: number): string {
    let j = i
    while (isLetter(this.code(j))) j++
    if (j === i || this.code(j) !== COLON || this.code(j + 1) !== UNBRACKET) return ''
    return String.fromCharCode(...this.cps.slice(i, j))
  }

  /**
   * Refuses `[:alpha:]` (or `[^:alpha:]`) written on its own: it would be a set of the letters of the name, which
   * nobody means.
   */
  private lone(negate: boolean): void {
    if (this.code(this.at) !== COLON) return
    const name = this.name(this.at + 1)
    const not = negate ? '^' : ''
    if (CLASSES.has(name)) fail(`a class goes inside a set: write [${not}[:${name}:]], not [${not}:${name}:]`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The instructions

// The first four are where a path waits for the next character (or, at MATCH, has arrived); the rest are followed
// at once, without taking a character.
const CHAR = 0   // a: the code point
const ANY = 1
const SET = 2    // a: the set's index
const MATCH = 3
const JUMP = 4   // a: where to go on
const SPLIT = 5  // a: where to go on first, b: where to go on otherwise
const SAVE = 6   // a: the slot that takes the position
const CLEAR = 7  // slots a up to (not including) b are emptied
const ASSERT = 8 // a: what must hold at this place
const FAIL = 9   // the path ends here

/** An early copy as it is being laid out. */
interface Early {
  /** How many character-taking instructions of the item's own layout come before the one about to be laid. */
  ord: number
  /** Pairs: a JUMP put after an early instruction that takes a character, and that instruction's `ord`. */
  readonly jumps: number[]
}

/**
 * Lays a tree out as instructions. It recurses on the tree, whose depth the reader has bounded, and each call on a
 * node of some size puts down at least one instruction, so the work is in step with the size already counted.
 */
class Layout {
  readonly op: number[] = []
  readonly a: number[] = []
  readonly b: number[] = []
  /** Where each instruction that takes a character was put, in the order laid (those of early copies left out). */
  private readonly taken: number[] = []
  private readonly fold: boolean

  constructor(fold: boolean) {
    this.fold = fold
  }

  private put(op: number, a = 0, b = 0): number {
    this.op.push(op)
    this.a.push(a)
    this.b.push(b)
    return this.op.length - 1
  }

  /** The whole pattern: its tree, then the instruction that says a match has arrived. */
  whole(tree: Node): void {
    this.lay(tree, null)
    if (this.op.length !== tree.size) throw new Error('regex: a pattern was laid out at a size other than the one counted')
    this.put(MATCH)
  }

  /**
   * Lays out `node`; with `early`, its early copy instead: only the ways into it before its first character, each
   * instruction that takes one followed by a jump (filled in later) to just after its twin in the node's own layout.
   */
  private lay(node: Node, early: Early | null): void {
    if (node.size === 0) return
    switch (node.kind) {
      case 'empty':
        return
      case 'char':
      case 'any':
      case 'set': {
        const pc = node.kind === 'char' ? this.put(CHAR, this.fold ? folded(node.n) : node.n) : node.kind === 'any' ? this.put(ANY) : this.put(SET, node.n)
        if (early === null) this.taken.push(pc)
        else early.jumps.push(this.put(JUMP), early.ord++)
        return
      }
      case 'assert':
        this.put(ASSERT, node.n)
        return
      case 'cat': {
        let open = true
        for (const kid of node.kids) {
          // Past an item that must take a character there is nothing early: only its twins are counted.
          if (early !== null && !open) early.ord += kid.takers
          else this.lay(kid, early)
          if (!kid.nullable) open = false
        }
        return
      }
      case 'group':
        // A group past the ninth is only brackets: nothing reads where it matched.
        if (node.n <= REPORTED) this.put(SAVE, 2 * node.n - 2)
        this.lay(node.kids[0], early)
        if (node.n <= REPORTED) this.put(SAVE, 2 * node.n - 1)
        return
      case 'alt': {
        const jumps: number[] = []
        for (let i = 0; i < node.kids.length; i++) {
          if (i === node.kids.length - 1) {
            this.lay(node.kids[i], early)
            break
          }
          const split = this.put(SPLIT)
          this.a[split] = split + 1
          this.lay(node.kids[i], early)
          jumps.push(this.put(JUMP))
          this.b[split] = this.op.length
        }
        for (const jump of jumps) this.a[jump] = this.op.length
        return
      }
      case 'repeat':
        if (early === null) this.repeat(node.kids[0], node.n, node.m)
        else this.repeatEarly(node.kids[0], node.n, node.m, early)
        return
    }
  }

  /**
   * A repetition: the least count as copies in a row; then, with no limit, one more copy in a loop, and with a limit
   * the remaining copies each behind a choice that can leave instead. A copy that can follow another one first
   * empties the groups inside it, so a group reports its last round only.
   */
  private repeat(kid: Node, min: number, max: number): void {
    const clear = reports(kid)
    const from = 2 * kid.lo - 2
    const to = 2 * Math.min(kid.hi, REPORTED)
    let copies = 0
    for (; copies < min; copies++) {
      if (clear && copies > 0) this.put(CLEAR, from, to)
      this.lay(kid, null)
    }
    if (max === -1) {
      const loop = this.put(SPLIT)
      this.a[loop] = loop + 1
      if (clear) this.put(CLEAR, from, to)
      this.round(kid)
      this.put(JUMP, loop)
      this.b[loop] = this.op.length
      return
    }
    const splits: number[] = []
    for (; copies < max; copies++) {
      const split = this.put(SPLIT)
      this.a[split] = split + 1
      splits.push(split)
      if (clear && copies > 0) this.put(CLEAR, from, to)
      this.round(kid)
    }
    for (const split of splits) this.b[split] = this.op.length
  }

  /**
   * One round past the least count, which must take at least one character. An item that always takes one is laid
   * as it is. An item that could match nothing is laid twice: first its early copy, ending in FAIL, then the item
   * itself, which a path can reach only from the early copy, at the moment it takes its first character. So no
   * path gets round a loop, or through an optional copy, without a character, and there is no way from any
   * instruction back to itself at one place in the text: what "visited already" cuts off is never more than a less
   * preferred copy of a path that is still running.
   */
  private round(kid: Node): void {
    if (!kid.nullable) {
      this.lay(kid, null)
      return
    }
    const early: Early = { ord: 0, jumps: [] }
    this.lay(kid, early)
    this.put(FAIL)
    const base = this.taken.length
    this.lay(kid, null)
    let sound = early.ord === kid.takers && this.taken.length - base === kid.takers
    for (let i = 0; sound && i < early.jumps.length; i += 2) {
      const jump = early.jumps[i]
      const twin = this.taken[base + early.jumps[i + 1]]
      sound = this.op[twin] === this.op[jump - 1] && this.a[twin] === this.a[jump - 1]
      this.a[jump] = twin + 1
    }
    if (!sound) throw new Error('regex: an early copy does not line up with the item it is a copy of')
  }

  /**
   * The early copy of a repetition: the copies of the least count for as long as a path can pass them without a
   * character, then (when more rounds may follow, and the path can get that far) one try at the first of them,
   * which must take a character or fail. Every copy not laid is still counted, so the twins keep their numbers.
   */
  private repeatEarly(kid: Node, min: number, max: number, early: Early): void {
    const clear = reports(kid)
    const from = 2 * kid.lo - 2
    const to = 2 * Math.min(kid.hi, REPORTED)
    const laid = kid.nullable ? min : Math.min(min, 1)
    for (let copies = 0; copies < laid; copies++) {
      if (clear && copies > 0) this.put(CLEAR, from, to)
      this.lay(kid, early)
    }
    early.ord += (min - laid) * kid.takers
    const more = max === -1 ? 1 : max - min
    if (more === 0) return
    if (kid.nullable || min === 0) {
      const split = this.put(SPLIT)
      this.a[split] = split + 1
      if (clear && (max === -1 || min > 0)) this.put(CLEAR, from, to)
      this.lay(kid, early)
      this.put(FAIL)
      this.b[split] = this.op.length
      early.ord += (more - 1) * kid.takers
    } else early.ord += more * kid.takers
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Running the instructions

/** The paths waiting at one text position, most preferred first: where each is, where its match began, its groups. */
interface Paths {
  readonly pc: Int32Array
  readonly start: Int32Array
  readonly slots: (readonly number[])[]
  count: number
}

function paths(size: number): Paths {
  return { pc: new Int32Array(size), start: new Int32Array(size), slots: [], count: 0 }
}

/** Whether an assertion holds at `pos`: it looks at the whole text, wherever the search began. */
function holds(what: number, text: string, pos: number): boolean {
  if (what === TEXT_START) return pos === 0
  if (what === TEXT_END) return pos === text.length
  const before = pos > 0 && isWord(text.charCodeAt(pos - 1))
  const after = pos < text.length && isWord(text.charCodeAt(pos))
  if (what === EDGE) return before !== after
  if (what === NO_EDGE) return before === after
  if (what === WORD_START) return !before && after
  return before && !after
}

/** `slots` with `from` up to `to` emptied; the same array when they already are. */
function emptied(slots: readonly number[], from: number, to: number): readonly number[] {
  let i = from
  while (i < to && slots[i] === -1) i++
  if (i === to) return slots
  const copy = slots.slice()
  for (; i < to; i++) copy[i] = -1
  return copy
}

/** A pattern laid out and the working space to run it; one run at a time, which is all a single thread can ask. */
class Machine implements Regex {
  readonly source: string
  readonly groupCount: number
  /** How many instructions the pattern was laid out as. */
  readonly size: number
  /** Instruction visits made by the last `exec` or `test`; the tests hold it against the bound. */
  steps = 0
  private readonly op: Int32Array
  private readonly a: Int32Array
  private readonly b: Int32Array
  private readonly sets: readonly CharSet[]
  private readonly fold: boolean
  /** When the whole pattern is plain characters and case matters: those characters, found by a plain search. */
  private readonly literal: string | null
  /** When every match must begin with one certain character: that character, so the search can skip to it. */
  private readonly lead: string
  /** Whether every match must begin at the start of the text. */
  private readonly tied: boolean
  /** The slots of a path that has passed no group yet. */
  private readonly blank: readonly number[]
  /** `seen[pc] === stamp` when instruction `pc` was visited at the place now being filled. */
  private readonly seen: Int32Array
  private stamp = 0
  private readonly listA: Paths
  private readonly listB: Paths
  private readonly stackPc: Int32Array
  private readonly stackSlots: (readonly number[])[] = []
  private foundStart = 0
  private foundEnd = 0
  private foundSlots: readonly number[]

  constructor(source: string, groupCount: number, tree: Node, sets: readonly CharSet[], fold: boolean) {
    const layout = new Layout(fold)
    layout.whole(tree)
    this.source = source
    this.groupCount = groupCount
    this.size = layout.op.length
    this.op = Int32Array.from(layout.op)
    this.a = Int32Array.from(layout.a)
    this.b = Int32Array.from(layout.b)
    this.sets = sets
    this.fold = fold
    const codes = tree.kind === 'cat' ? tree.kids : tree.kind === 'empty' ? NO_KIDS : [tree]
    const plain = !fold && codes.every((kid) => kid.kind === 'char' && !isSurrogate(kid.n))
    this.literal = plain ? String.fromCodePoint(...codes.map((kid) => kid.n)) : null
    const first = this.op[0]
    this.lead = first === CHAR && !fold && !isSurrogate(this.a[0]) ? String.fromCodePoint(this.a[0]) : ''
    this.tied = first === ASSERT && this.a[0] === TEXT_START
    this.blank = Object.freeze(new Array<number>(2 * Math.min(groupCount, REPORTED)).fill(-1))
    this.foundSlots = this.blank
    this.seen = new Int32Array(this.size)
    this.listA = paths(this.size)
    this.listB = paths(this.size)
    this.stackPc = new Int32Array(this.size + 1)
  }

  exec(text: string, from = 0): Match | null {
    let begin = from > 0 ? Math.floor(from) : 0
    if (!(begin <= text.length)) return null
    // Between the two halves of a surrogate pair no character starts: the search begins after the pair, so a caller
    // that steps on by one unit after a match of no characters never has a pair cut in two.
    if (begin > 0 && begin < text.length && isLowHalf(text.charCodeAt(begin)) && isHighHalf(text.charCodeAt(begin - 1))) begin++
    this.steps = 0
    if (this.literal !== null) {
      const at = text.indexOf(this.literal, begin)
      if (at < 0) return null
      this.foundStart = at
      this.foundEnd = at + this.literal.length
      this.foundSlots = this.blank
    } else if (!this.run(text, begin, true)) return null
    const slots = this.foundSlots
    this.foundSlots = this.blank
    const groups: (readonly [number, number] | null)[] = [[this.foundStart, this.foundEnd]]
    for (let g = 1; g <= REPORTED; g++) {
      const known = 2 * g <= slots.length
      const start = known ? slots[2 * g - 2] : -1
      const end = known ? slots[2 * g - 1] : -1
      groups.push(start >= 0 && end >= start ? [start, end] : null)
    }
    return { start: this.foundStart, end: this.foundEnd, groups }
  }

  test(text: string): boolean {
    this.steps = 0
    return this.literal !== null ? text.includes(this.literal) : this.run(text, 0, false)
  }

  /** A new stamp: the next place has seen nothing yet. */
  private fresh(): void {
    if (this.stamp >= 0x7ffffff0) {
      this.seen.fill(0)
      this.stamp = 0
    }
    this.stamp++
  }

  /**
   * Adds to `list` every instruction where the path at `pc0` comes to wait at `pos`: it follows the instructions
   * that take no character, most preferred branch first, and stops wherever another path has been at this place
   * already (that one is preferred, and from here on the two would do the same). The branches still to follow are
   * kept on a stack of its own, never the host's, so a long chain of choices costs memory in step with the pattern.
   */
  private add(list: Paths, pc0: number, start: number, slots0: readonly number[], pos: number, text: string, keep: boolean): void {
    const op = this.op
    const a = this.a
    const seen = this.seen
    const stamp = this.stamp
    const stackPc = this.stackPc
    const stackSlots = this.stackSlots
    let steps = 0
    let top = 1
    stackPc[0] = pc0
    stackSlots[0] = slots0
    while (top > 0) {
      top--
      let pc = stackPc[top]
      let slots = stackSlots[top]
      for (;;) {
        if (seen[pc] === stamp) break
        seen[pc] = stamp
        steps++
        const o = op[pc]
        if (o <= MATCH) {
          const k = list.count++
          list.pc[k] = pc
          list.start[k] = start
          list.slots[k] = slots
          break
        }
        if (o === JUMP) {
          pc = a[pc]
          continue
        }
        if (o === SPLIT) {
          stackPc[top] = this.b[pc]
          stackSlots[top] = slots
          top++
          pc = a[pc]
          continue
        }
        if (o === SAVE) {
          if (keep) {
            const copy = slots.slice()
            copy[a[pc]] = pos
            slots = copy
          }
        } else if (o === CLEAR) {
          if (keep) slots = emptied(slots, a[pc], this.b[pc])
        } else if (o !== ASSERT || !holds(a[pc], text, pos)) break
        pc++
      }
    }
    this.steps += steps
  }

  /**
   * The search. At each place, from `from` to the end of the text: a new path starts here as the least preferred
   * one (unless a match is already in hand), then every waiting path takes the character at this place and those it
   * suits go on to wait at the next. A path that has arrived is the match so far and ends every path less preferred
   * than it; the ones more preferred run on and may replace it. With `keep` off nothing is recorded but the answer.
   */
  private run(text: string, from: number, keep: boolean): boolean {
    const n = text.length
    const op = this.op
    const a = this.a
    const fold = this.fold
    let now = this.listA
    let next = this.listB
    now.count = 0
    let found = false
    let pos = from
    let steps = 0
    this.fresh()
    for (;;) {
      if (!found) {
        if (now.count === 0) {
          // Nothing is under way, so a match can only begin where the pattern allows one to.
          if (this.tied && pos > 0) break
          if (this.lead !== '') {
            const at = text.indexOf(this.lead, pos)
            if (at < 0) break
            if (at !== pos) {
              pos = at
              this.fresh()
            }
          }
        }
        this.add(now, 0, pos, this.blank, pos, text, keep)
      } else if (now.count === 0) break
      // The character at this place: one code point, a surrogate pair counting as one; -1 at the end of the text.
      let c = -1
      let width = 0
      if (pos < n) {
        c = text.charCodeAt(pos)
        width = 1
        if (c >= 0xd800 && c <= 0xdbff && pos + 1 < n) {
          const d = text.charCodeAt(pos + 1)
          if (d >= 0xdc00 && d <= 0xdfff) {
            c = ((c - 0xd800) << 10) + (d - 0xdc00) + 0x10000
            width = 2
          }
        }
      }
      let low = c
      let up = c
      let same = c
      if (fold && c >= 0) {
        low = lower(c)
        up = upper(c)
        same = lower(up)
      }
      this.fresh()
      next.count = 0
      for (let i = 0; i < now.count; i++) {
        const pc = now.pc[i]
        const o = op[pc]
        steps++
        let suits: boolean
        if (o === CHAR) suits = a[pc] === same
        else if (o === ANY) suits = c >= 0
        else if (o === SET) {
          const set = this.sets[a[pc]]
          if (c < 0) suits = false
          else if (c < 128) suits = set.ascii[c] === 1
          else {
            const inside = within(set.ranges, c) || (fold && (within(set.ranges, low) || within(set.ranges, up) || within(set.ranges, same)))
            suits = inside !== set.negate
          }
        } else {
          found = true
          this.foundStart = now.start[i]
          this.foundEnd = pos
          this.foundSlots = now.slots[i]
          if (!keep) {
            this.steps += steps
            return true
          }
          break
        }
        if (suits) this.add(next, pc + 1, now.start[i], now.slots[i], pos + width, text, keep)
      }
      if (pos >= n) break
      pos += width
      const swap = now
      now = next
      next = swap
    }
    this.steps += steps
    // Let go of the groups of paths that came to nothing.
    this.listA.slots.length = 0
    this.listB.slots.length = 0
    this.stackSlots.length = 0
    return found
  }
}

/**
 * Makes a pattern ready, or refuses it with a `RegexError` that says what is wrong with it. The cost of every
 * later `exec` and `test` is bounded by the pattern's size times the length of the text.
 */
export function compile(pattern: string, options: RegexOptions = {}): Regex {
  if (pattern.length > PATTERN_MAX) fail(`pattern too long: more than ${PATTERN_MAX} characters`)
  const fold = options.ignoreCase === true
  const cps = points(pattern)
  if (options.literal === true) return new Machine(pattern, 0, cat(cps.map((c) => taker('char', c))), [], fold)
  const reader = new Reader(cps, fold)
  const tree = reader.all()
  // One more instruction says the match has arrived.
  sized(tree.size + 1)
  return new Machine(pattern, reader.groups, tree, reader.sets, fold)
}
