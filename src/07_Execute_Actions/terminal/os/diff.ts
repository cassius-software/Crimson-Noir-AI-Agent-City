// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the programs that compare two files: diff (which lines changed, as few changes
 * as it can find, in the classic or the unified form), cmp (the first byte that differs, or every one) and comm (the
 * lines two sorted files share and the lines each has alone). diff finds its changes with a shortest-edit-script
 * search written here: the greedy walk along the diagonals of the edit graph, run from both ends of the files at
 * once so that it needs memory only in proportion to the files, and split at the meeting point until each piece is
 * plain. Its work is bounded by construction: each file may have at most LINES_MAX lines, and once the files differ
 * by more than EDITS_MAX lines (or the search has spent WORK_MAX steps) it stops looking and reports everything from
 * the first difference to the last as one change.
 * What breaks if it is removed? Nobody at the prompt can see what changed between two versions of a file, check
 * that a copy is exact, or find the lines two lists have in common.
 */
import { OsError, refuse } from './errno.ts'
import type { Program, Sys } from './kernel.ts'
import { READ_ALL_MAX } from './kernel.ts'
import { Lines, Out, complain, count, options, usage } from './lib.ts'
import type { Task } from './task.ts'
import { O_READ } from './vfs.ts'

/** Bytes asked for in one read. */
const PIECE = 65536
/** The most lines diff reads from each file: a longer file is refused. */
const LINES_MAX = 100000
/** The most lines added and removed in all that diff searches for: past this the middle is reported as one change. */
const EDITS_MAX = 20000
/** The most steps the search may take (diagonals tried plus equal lines walked) before it gives up the same way. */
const WORK_MAX = 100_000_000
/** A loop that asks nothing of the kernel gives the other tasks a turn once in 1024 of its own. */
const PACE = 1023
/** Characters that -b and -w treat as white space (a line end never reaches them: lines are split first). */
const BLANKS = /[ \t\r\f\v]+/g
/** The text that follows a last line that has no line end, in both forms of diff's output. */
const NO_END = '\\ No newline at end of file'
/** UTF-8 that refuses ill-formed bytes (so diff can tell text from other bytes) and keeps a byte order mark as text. */
const STRICT = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

// What the three programs share.

/** Reports a wrong command: what was wrong (when known), then the usage line; the status is 2. */
function* misuse(sys: Sys, name: string, why: string | null, text: string): Task<number> {
  if (why !== null) yield* complain(sys, name, null, why)
  return yield* usage(sys, text)
}

/** Why two operands are not the two a program wants, or null when they are. */
function operands(rest: readonly string[]): string | null {
  if (rest.length < 2) return rest.length === 0 ? 'two files are needed' : 'a second file is needed'
  if (rest.length > 2) return `one file too many: '${rest[2]}'`
  return null
}

/**
 * Opens a file to read, or gives the ordinary input for `-`. A refusal is reported as `name: path: why` and gives
 * null; `dir` is what is said of a directory.
 */
function* openInput(sys: Sys, name: string, path: string, dir: string): Task<number | null> {
  if (path === '-') return 0
  try {
    return yield* sys.open(path, O_READ)
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    yield* complain(sys, name, path, e.errno === 'EISDIR' ? dir : e)
    return null
  }
}

/** Closes what `openInput` opened (the ordinary input stays open). */
function shut(sys: Sys, fd: number | null): void {
  if (fd !== null && fd !== 0) sys.close(fd)
}

/**
 * Runs a program's output phase: a refused write to the ordinary output (other than a closed pipe, which ends the
 * program quietly) is reported once as `name: write error: why` and gives `status`.
 */
function* writing(sys: Sys, name: string, status: number, body: () => Task<number>): Task<number> {
  try {
    return yield* body()
  } catch (e) {
    if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
    yield* complain(sys, name, 'write error', e)
    return status
  }
}

// diff: reading the two files.

/** A file as diff compares it. */
interface Text {
  readonly lines: readonly string[]
  /** Whether the last line has no line end after it. */
  readonly open: boolean
}

/** Everything on a descriptor, refused (EFBIG) past LINES_MAX lines, a last line without its end included, or READ_ALL_MAX bytes. */
function* slurp(sys: Sys, fd: number): Task<Uint8Array> {
  const chunks: Uint8Array[] = []
  let total = 0
  let ends = 0
  const tooLong = `more than ${LINES_MAX} lines, too many to compare`
  for (;;) {
    const chunk = yield* sys.read(fd, PIECE)
    if (chunk.length === 0) break
    total += chunk.length
    if (total > READ_ALL_MAX) refuse('EFBIG', 'more than 64 MiB, too much to compare')
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, at + 1)) ends++
    if (ends > LINES_MAX) refuse('EFBIG', tooLong)
    chunks.push(chunk)
  }
  const last = chunks.length === 0 ? undefined : chunks[chunks.length - 1]
  if (last !== undefined && last[last.length - 1] !== 10 && ends + 1 > LINES_MAX) refuse('EFBIG', tooLong)
  if (chunks.length === 1) return chunks[0]
  const all = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { all.set(c, at); at += c.length }
  return all
}

/** A whole file for diff (the ordinary input for `-`); a directory is refused with a word on what diff does instead. */
function* load(sys: Sys, path: string): Task<Uint8Array> {
  if (path === '-') return yield* slurp(sys, 0)
  let fd: number
  try {
    fd = yield* sys.open(path, O_READ)
  } catch (e) {
    if (e instanceof OsError && e.errno === 'EISDIR') refuse('EISDIR', 'is a directory (diff compares two files; it has no recursive mode)')
    throw e
  }
  try {
    return yield* slurp(sys, fd)
  } finally {
    sys.close(fd)
  }
}

/** The lines of a file, or null when it is no text: it holds a zero byte or bytes that are not UTF-8. */
function textOf(bytes: Uint8Array): Text | null {
  if (bytes.indexOf(0) >= 0) return null
  let text: string
  try {
    text = STRICT.decode(bytes)
  } catch {
    return null
  }
  if (text === '') return { lines: [], open: false }
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') {
    lines.pop()
    return { lines, open: false }
  }
  return { lines, open: true }
}

/** Whether two runs of bytes are the same. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

/** How diff is to compare two lines: letter case folded or not, and white space kept (0), squeezed (1, -b) or ignored (2, -w). */
interface Likeness {
  readonly fold: boolean
  readonly space: 0 | 1 | 2
}

/**
 * Each line as a number, the same number for lines that compare equal (in both files: `table` is shared). A last
 * line with no line end gets a number of its own, so it never equals a line that has one.
 */
function* keysOf(sys: Sys, text: Text, like: Likeness, table: Map<string, number>): Task<Int32Array> {
  const n = text.lines.length
  const keys = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    let line = text.lines[i]
    if (like.space === 2) line = line.replace(BLANKS, '')
    else if (like.space === 1) {
      line = line.replace(BLANKS, ' ')
      if (line.endsWith(' ')) line = line.slice(0, -1)
    }
    if (like.fold) line = line.toLowerCase()
    // A line never holds a line end, so one added here makes a key no other line can have.
    if (i === n - 1 && text.open) line += '\n'
    let id = table.get(line)
    if (id === undefined) {
      id = table.size
      table.set(line, id)
    }
    keys[i] = id
    if ((i & PACE) === PACE) yield* sys.step()
  }
  return keys
}

// diff: the search.

/** A run of equal lines: a[x0..x1) is b[y0..y1). */
interface Snake { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number }

/** A box of the search: lines a[aLo..aHi) against b[bLo..bHi), with the two arrays of furthest points it uses. */
interface Box {
  readonly a: Int32Array
  readonly b: Int32Array
  readonly aLo: number
  readonly aHi: number
  readonly bLo: number
  readonly bHi: number
  readonly vf: Int32Array
  readonly vb: Int32Array
}

/** What the search may still spend, in steps (a diagonal tried, or a pair of equal lines walked). */
interface Budget { left: number }

/**
 * The forward search one edit further, to `d` edits: for each diagonal it may reach, the furthest point, from a move
 * right off the diagonal below or a move down off the one above, then along any equal lines. Gives the last run of
 * equal lines when it reaches past the backward search (which has made d - 1 edits) on some diagonal, else null.
 * A plain function, not a generator: it is the innermost loop of diff and runs as fast as the platform allows.
 */
function forward(box: Box, d: number, budget: Budget): Snake | null {
  const { a, b, aLo, aHi, bLo, bHi, vf, vb } = box
  const n = aHi - aLo
  const m = bHi - bLo
  const delta = n - m
  const odd = (delta & 1) !== 0
  const off = m + 1
  const lo = d <= m ? -d : -m + ((d - m) & 1)
  const hi = d <= n ? d : n - ((d - n) & 1)
  let spent = 0
  let found: Snake | null = null
  for (let k = lo; k <= hi; k += 2) {
    const i = k + off
    let x = d === 0 ? 0 : -1
    const left = vf[i - 1]
    if (left >= 0 && left < n) x = left + 1
    const above = vf[i + 1]
    if (above >= 0 && above - (k + 1) < m && above > x) x = above
    let x0 = x
    if (vf[i] >= x) {
      x = vf[i]
      x0 = x
    } else {
      while (x < n && x - k < m && a[aLo + x] === b[bLo + x - k]) x++
      vf[i] = x
    }
    spent += 1 + x - x0
    // The backward search has reached the diagonals -(d - 1) to d - 1 of its own; it knows nothing of the others yet.
    const kb = delta - k
    if (x < 0 || !odd || kb < 1 - d || kb > d - 1) continue
    const back = vb[kb + off]
    if (back >= 0 && x + back >= n) {
      found = { x0: aLo + x0, y0: bLo + x0 - k, x1: aLo + x, y1: bLo + x - k }
      break
    }
  }
  budget.left -= spent
  return found
}

/**
 * The backward search one edit further, to `d` edits: the same walk from the bottom right corner, where x counts
 * lines of `a` back from its end and y lines of `b` back from its end. Gives the last run of equal lines when it
 * reaches past the forward search (which has made d edits) on some diagonal, else null.
 */
function backward(box: Box, d: number, budget: Budget): Snake | null {
  const { a, b, aLo, aHi, bLo, bHi, vf, vb } = box
  const n = aHi - aLo
  const m = bHi - bLo
  const delta = n - m
  const odd = (delta & 1) !== 0
  const off = m + 1
  const lo = d <= m ? -d : -m + ((d - m) & 1)
  const hi = d <= n ? d : n - ((d - n) & 1)
  let spent = 0
  let found: Snake | null = null
  for (let k = lo; k <= hi; k += 2) {
    const i = k + off
    let x = d === 0 ? 0 : -1
    const left = vb[i - 1]
    if (left >= 0 && left < n) x = left + 1
    const above = vb[i + 1]
    if (above >= 0 && above - (k + 1) < m && above > x) x = above
    let x0 = x
    if (vb[i] >= x) {
      x = vb[i]
      x0 = x
    } else {
      while (x < n && x - k < m && a[aHi - 1 - x] === b[bHi - 1 - x + k]) x++
      vb[i] = x
    }
    spent += 1 + x - x0
    const kf = delta - k
    if (x < 0 || odd || kf < -d || kf > d) continue
    const ahead = vf[kf + off]
    if (ahead >= 0 && ahead + x >= n) {
      found = { x0: aHi - x, y0: bHi - x + k, x1: aHi - x0, y1: bHi - x0 + k }
      break
    }
  }
  budget.left -= spent
  return found
}

/**
 * In a box whose two sides are both non-empty, a run of equal lines (perhaps empty) that lies on a shortest path
 * through the box; null when that path is longer than EDITS_MAX edits or the budget runs out.
 *
 * A point (x, y) of the box stands for x lines of the box's part of `a` and y of `b` done; a step right deletes a
 * line, a step down adds one, and a step along the diagonal (free) keeps a line that both have. Diagonal k holds the
 * points with x - y = k. After d edits, `vf[k]` is the furthest x reached on diagonal k from the top left corner, and
 * `vb[k]` the furthest reached from the bottom right corner (counted backwards, on the backward diagonal k). The two
 * searches take turns, each one edit further; the first time one reaches past the other on some diagonal, its last
 * run of equal lines is on a shortest path. A move that would leave the box is never taken, and an entry keeps its
 * value from two edits before when no move improves it, so every value is a point inside the box. Each step costs
 * time in proportion to the diagonals reached so far, so a box costs nothing before its search begins.
 */
function* middle(sys: Sys, box: Box, budget: Budget): Task<Snake | null> {
  const { vf, vb } = box
  const n = box.aHi - box.aLo
  const m = box.bHi - box.bLo
  // Diagonals run from -m to n, at m + 1 onwards in the arrays; the one past each end is never reached and stays -1.
  const off = m + 1
  const last = n + m + 2
  /** Marks diagonal k as not reached yet, in both arrays (the arrays are shared by every box, so they hold old values). */
  const blank = (k: number): void => {
    const i = k + off
    if (i >= 0 && i <= last) { vf[i] = -1; vb[i] = -1 }
  }
  const most = Math.min(n + m, EDITS_MAX >> 1)
  let paced = budget.left
  for (let d = 0; d <= most; d++) {
    // Diagonals d and -d are first reached now, and the ones just outside them are read as neighbours.
    blank(-d - 1)
    blank(-d)
    blank(d)
    blank(d + 1)
    const found = forward(box, d, budget) ?? backward(box, d, budget)
    if (found !== null) return found
    if (budget.left < 0) return null
    // One turn of the kernel's for every 1024 steps taken.
    for (; paced - budget.left > PACE; paced -= PACE + 1) yield* sys.step()
  }
  return null
}

/** Which lines of each file are not part of what the two share: 1 for a line removed from `a` or added from `b`. */
interface Marks { readonly ca: Uint8Array; readonly cb: Uint8Array }

/**
 * The fewest lines to remove from `a` and add from `b` to turn one into the other, as marks; null when the search
 * gives up. Each box of lines is split at a middle run of equal lines, again and again, from a stack of boxes (no
 * recursion, so no depth to run out of), until each box is only removals or only additions. A shortest path needs
 * at least as many edits as the two sides differ in length, so a box that differs in length by more than EDITS_MAX
 * lines is given up at once.
 */
function* shortest(sys: Sys, a: Int32Array, b: Int32Array): Task<Marks | null> {
  const n = a.length
  const m = b.length
  if (Math.abs(n - m) > EDITS_MAX) return null
  const ca = new Uint8Array(n)
  const cb = new Uint8Array(m)
  const vf = new Int32Array(n + m + 3)
  const vb = new Int32Array(n + m + 3)
  const budget: Budget = { left: WORK_MAX }
  const stack: number[] = [0, n, 0, m]
  while (stack.length > 0) {
    const top = stack.length - 4
    let aLo = stack[top]
    let aHi = stack[top + 1]
    let bLo = stack[top + 2]
    let bHi = stack[top + 3]
    stack.length = top
    while (aLo < aHi && bLo < bHi && a[aLo] === b[bLo]) { aLo++; bLo++ }
    while (aLo < aHi && bLo < bHi && a[aHi - 1] === b[bHi - 1]) { aHi--; bHi-- }
    if (aLo === aHi) { cb.fill(1, bLo, bHi); continue }
    if (bLo === bHi) { ca.fill(1, aLo, aHi); continue }
    const s = yield* middle(sys, { a, b, aLo, aHi, bLo, bHi, vf, vb }, budget)
    if (s === null) return null
    // A split at a corner of the box would make no progress; the search never gives one, and gives up if it did.
    if ((s.x0 === aLo && s.y0 === bLo && s.x1 === aLo) || (s.x1 === aHi && s.y1 === bHi && s.x0 === aHi)) return null
    stack.push(s.x1, aHi, s.y1, bHi, aLo, s.x0, bLo, s.y0)
    yield* sys.step()
  }
  return { ca, cb }
}

/**
 * Which lines changed between `a` and `b` (line numbers; `kinds` is one more than the largest). The lines both start
 * with and end with are set aside first. Of the rest, a line whose like the other side does not hold at all can
 * match nothing, so it is a change for certain: it is marked at once and the search runs over the other lines only,
 * which keeps it short when the new lines are new (the usual case) and changes nothing about how few the changes
 * are. When the search gives up, everything between the shared start and the shared end is one change.
 */
function* search(sys: Sys, a: Int32Array, b: Int32Array, kinds: number): Task<Marks> {
  const n = a.length
  const m = b.length
  const ca = new Uint8Array(n)
  const cb = new Uint8Array(m)
  let head = 0
  while (head < n && head < m && a[head] === b[head]) {
    head++
    if ((head & PACE) === 0) yield* sys.step()
  }
  let tail = 0
  while (tail < n - head && tail < m - head && a[n - 1 - tail] === b[m - 1 - tail]) {
    tail++
    if ((tail & PACE) === 0) yield* sys.step()
  }
  const inA = new Uint8Array(kinds)
  const inB = new Uint8Array(kinds)
  for (let i = head; i < n - tail; i++) {
    inA[a[i]] = 1
    if ((i & PACE) === PACE) yield* sys.step()
  }
  for (let j = head; j < m - tail; j++) {
    inB[b[j]] = 1
    if ((j & PACE) === PACE) yield* sys.step()
  }
  const whereA: number[] = []
  const whereB: number[] = []
  for (let i = head; i < n - tail; i++) {
    if (inB[a[i]] === 1) whereA.push(i)
    else ca[i] = 1
    if ((i & PACE) === PACE) yield* sys.step()
  }
  for (let j = head; j < m - tail; j++) {
    if (inA[b[j]] === 1) whereB.push(j)
    else cb[j] = 1
    if ((j & PACE) === PACE) yield* sys.step()
  }
  const shareA = Int32Array.from(whereA, (i) => a[i])
  const shareB = Int32Array.from(whereB, (j) => b[j])
  const found = yield* shortest(sys, shareA, shareB)
  if (found === null) {
    ca.fill(1, head, n - tail)
    cb.fill(1, head, m - tail)
  } else {
    for (let i = 0; i < whereA.length; i++) ca[whereA[i]] = found.ca[i]
    for (let j = 0; j < whereB.length; j++) cb[whereB[j]] = found.cb[j]
  }
  return { ca, cb }
}

/** One change: lines a0..a1 of the first file (from 0, end not included) become lines b0..b1 of the second. */
interface Change { readonly a0: number; readonly a1: number; readonly b0: number; readonly b1: number }

/** The marks as a list of changes, in order. */
function* changesOf(sys: Sys, marks: Marks): Task<Change[]> {
  const { ca, cb } = marks
  const n = ca.length
  const m = cb.length
  const out: Change[] = []
  let i = 0
  let j = 0
  let turns = 0
  while (i < n || j < m) {
    if (i < n && j < m && ca[i] === 0 && cb[j] === 0) {
      i++
      j++
    } else {
      const a0 = i
      const b0 = j
      while (i < n && ca[i] === 1) i++
      while (j < m && cb[j] === 1) j++
      // The lines kept are as many on each side, so this never happens; if it did, the rest is one change.
      if (i === a0 && j === b0) { i = n; j = m }
      out.push({ a0, a1: i, b0, b1: j })
    }
    if ((++turns & PACE) === 0) yield* sys.step()
  }
  return out
}

// diff: the two forms of output.

/** Lines `from`..`to` (from 0, end not included) as the classic form numbers them: `3` or `3,5`. */
function span(from: number, to: number): string {
  return to - from === 1 ? String(to) : `${from + 1},${to}`
}

/** The classic form: `3c3`, `5a6,7`, `8,9d7`, each followed by the old lines (`< `) and the new (`> `). */
function* classic(sys: Sys, out: Out, one: Text, two: Text, changes: readonly Change[]): Task<void> {
  const n = one.lines.length
  const m = two.lines.length
  let turns = 0
  for (const c of changes) {
    if (c.a1 === c.a0) yield* out.line(`${c.a0}a${span(c.b0, c.b1)}`)
    else if (c.b1 === c.b0) yield* out.line(`${span(c.a0, c.a1)}d${c.b0}`)
    else yield* out.line(`${span(c.a0, c.a1)}c${span(c.b0, c.b1)}`)
    for (let i = c.a0; i < c.a1; i++) {
      yield* out.line(`< ${one.lines[i]}`)
      if (i === n - 1 && one.open) yield* out.line(NO_END)
    }
    if (c.a1 > c.a0 && c.b1 > c.b0) yield* out.line('---')
    for (let j = c.b0; j < c.b1; j++) {
      yield* out.line(`> ${two.lines[j]}`)
      if (j === m - 1 && two.open) yield* out.line(NO_END)
    }
    if ((++turns & PACE) === 0) yield* sys.step()
  }
}

/** Where a part of a file starts and how many lines it spans, as a unified hunk head writes it: `4`, `4,3`, or `3,0` for none after line 3. */
function reach(from: number, lines: number): string {
  if (lines === 1) return String(from + 1)
  return lines === 0 ? `${from},0` : `${from + 1},${lines}`
}

/**
 * The unified form: a `---` and a `+++` line naming the files, then each group of changes that lie within twice
 * `context` lines of each other as one hunk, headed `@@ -4,3 +4,5 @@`, its lines marked ` ` (kept), `-` and `+`.
 */
function* unified(sys: Sys, out: Out, one: Text, two: Text, changes: readonly Change[], context: number, names: readonly [string, string]): Task<void> {
  const n = one.lines.length
  const m = two.lines.length
  yield* out.line(`--- ${names[0]}`)
  yield* out.line(`+++ ${names[1]}`)
  const kept = function* (i: number): Task<void> {
    yield* out.line(` ${one.lines[i]}`)
    if (i === n - 1 && one.open) yield* out.line(NO_END)
  }
  let turns = 0
  let h = 0
  while (h < changes.length) {
    let e = h
    while (e + 1 < changes.length && changes[e + 1].a0 - changes[e].a1 <= 2 * context) e++
    const first = changes[h]
    const last = changes[e]
    const aStart = Math.max(0, first.a0 - context)
    const bStart = first.b0 - (first.a0 - aStart)
    const aEnd = Math.min(n, last.a1 + context)
    const bEnd = last.b1 + (aEnd - last.a1)
    yield* out.line(`@@ -${reach(aStart, aEnd - aStart)} +${reach(bStart, bEnd - bStart)} @@`)
    let at = aStart
    for (let c = h; c <= e; c++) {
      const ch = changes[c]
      for (; at < ch.a0; at++) yield* kept(at)
      for (let i = ch.a0; i < ch.a1; i++) {
        yield* out.line(`-${one.lines[i]}`)
        if (i === n - 1 && one.open) yield* out.line(NO_END)
      }
      for (let j = ch.b0; j < ch.b1; j++) {
        yield* out.line(`+${two.lines[j]}`)
        if (j === m - 1 && two.open) yield* out.line(NO_END)
      }
      at = ch.a1
      if ((++turns & PACE) === 0) yield* sys.step()
    }
    for (; at < aEnd; at++) yield* kept(at)
    h = e + 1
  }
}

// diff

const DIFF_USAGE = 'diff [-u] [-U N] [-q] [-i] [-b] [-w] file1 file2'

const diff: Program = function* (sys, argv) {
  const o = options(argv, 'uqibw', 'U')
  if (o.bad !== null) {
    const recursive = o.bad === "unknown option '-r'" || o.bad === "unknown option '-R'"
    return yield* misuse(sys, 'diff', recursive ? 'there is no recursive mode (-r): name two files' : o.bad, DIFF_USAGE)
  }
  let context = 3
  const given = o.values.get('U')
  if (given !== undefined) {
    const n = count(given)
    if (n === null) return yield* misuse(sys, 'diff', `option '-U' needs a whole number, not '${given}'`, DIFF_USAGE)
    // More context than a file can have lines changes nothing, and keeps the sums below small.
    context = Math.min(n, LINES_MAX + 1)
  }
  const wrong = operands(o.rest)
  if (wrong !== null) return yield* misuse(sys, 'diff', wrong, DIFF_USAGE)
  const names: readonly [string, string] = [o.rest[0], o.rest[1]]
  const raw: (Uint8Array | null)[] = []
  for (const [at, path] of names.entries()) {
    // The input named twice is read once: it is the same text both times.
    const again = at === 1 && path === '-' && names[0] === '-' ? raw[0] : undefined
    if (again !== undefined) { raw.push(again); continue }
    try {
      raw.push(yield* load(sys, path))
    } catch (e) {
      if (!(e instanceof OsError)) throw e
      yield* complain(sys, 'diff', path, e)
      raw.push(null)
    }
  }
  const [rawOne, rawTwo] = raw
  if (rawOne === null || rawTwo === null) return 2
  const out = new Out(sys)
  const differ = `Files ${names[0]} and ${names[1]} differ`
  return yield* writing(sys, 'diff', 2, function* () {
    const one = textOf(rawOne)
    const two = textOf(rawTwo)
    if (one === null || two === null) {
      if (sameBytes(rawOne, rawTwo)) return 0
      yield* out.line(differ)
      yield* out.flush()
      return 1
    }
    const like: Likeness = { fold: o.flags.has('i'), space: o.flags.has('w') ? 2 : o.flags.has('b') ? 1 : 0 }
    const table = new Map<string, number>()
    const a = yield* keysOf(sys, one, like, table)
    const b = yield* keysOf(sys, two, like, table)
    if (o.flags.has('q')) {
      let same = a.length === b.length
      for (let i = 0; same && i < a.length; i++) same = a[i] === b[i]
      if (same) return 0
      yield* out.line(differ)
      yield* out.flush()
      return 1
    }
    const changes = yield* changesOf(sys, yield* search(sys, a, b, table.size))
    if (changes.length === 0) return 0
    if (o.flags.has('u') || given !== undefined) yield* unified(sys, out, one, two, changes, context, names)
    else yield* classic(sys, out, one, two, changes)
    yield* out.flush()
    return 1
  })
}

// cmp

const CMP_USAGE = 'cmp [-s] [-l] file1 file2'

/** A descriptor read a piece at a time, with the place reached in the piece held. */
class Feed {
  piece: Uint8Array = new Uint8Array(0)
  at = 0
  ended = false
  readonly fd: number
  readonly path: string

  constructor(fd: number, path: string) {
    this.fd = fd
    this.path = path
  }

  /** Whether bytes are waiting, reading the next piece when the last one is used up (false at the end). */
  *ready(sys: Sys): Task<boolean> {
    while (this.at >= this.piece.length && !this.ended) {
      this.piece = yield* sys.read(this.fd, PIECE)
      this.at = 0
      if (this.piece.length === 0) this.ended = true
    }
    return this.at < this.piece.length
  }
}

const cmp: Program = function* (sys, argv) {
  const o = options(argv, 'sl')
  if (o.bad !== null) return yield* misuse(sys, 'cmp', o.bad, CMP_USAGE)
  const wrong = operands(o.rest)
  if (wrong !== null) return yield* misuse(sys, 'cmp', wrong, CMP_USAGE)
  const silent = o.flags.has('s')
  const list = o.flags.has('l')
  if (silent && list) return yield* misuse(sys, 'cmp', 'options -s and -l cannot be used together', CMP_USAGE)
  const [p1, p2] = [o.rest[0], o.rest[1]]
  // The input against itself: the same bytes, without reading any.
  if (p1 === '-' && p2 === '-') return 0
  const dir = 'is a directory (cmp compares two files)'
  const fd1 = yield* openInput(sys, 'cmp', p1, dir)
  const fd2 = yield* openInput(sys, 'cmp', p2, dir)
  try {
    if (fd1 === null || fd2 === null) return 2
    const one = new Feed(fd1, p1)
    const two = new Feed(fd2, p2)
    const out = new Out(sys)
    return yield* writing(sys, 'cmp', 2, function* () {
      let offset = 0
      let line = 1
      let differ = false
      for (;;) {
        let more1: boolean
        let more2: boolean
        try {
          more1 = yield* one.ready(sys)
        } catch (e) {
          if (!(e instanceof OsError)) throw e
          yield* out.flush()
          yield* complain(sys, 'cmp', p1, e)
          return 2
        }
        try {
          more2 = yield* two.ready(sys)
        } catch (e) {
          if (!(e instanceof OsError)) throw e
          yield* out.flush()
          yield* complain(sys, 'cmp', p2, e)
          return 2
        }
        if (!more1 || !more2) {
          yield* out.flush()
          if (more1 === more2) return differ ? 1 : 0
          if (!silent) yield* sys.eprint(`cmp: EOF on ${more1 ? p2 : p1}\n`)
          return 1
        }
        const n = Math.min(one.piece.length - one.at, two.piece.length - two.at)
        const x = one.piece
        const y = two.piece
        for (let i = 0; i < n; i++) {
          const c1 = x[one.at + i]
          const c2 = y[two.at + i]
          if (c1 === c2) {
            if (c1 === 10) line++
            continue
          }
          if (!list) {
            if (!silent) {
              yield* out.line(`${p1} ${p2} differ: byte ${offset + i + 1}, line ${line}`)
              yield* out.flush()
            }
            return 1
          }
          differ = true
          yield* out.line(`${offset + i + 1} ${c1.toString(8)} ${c2.toString(8)}`)
        }
        offset += n
        one.at += n
        two.at += n
      }
    })
  } finally {
    shut(sys, fd1)
    shut(sys, fd2)
  }
}

// comm

const COMM_USAGE = 'comm [-1] [-2] [-3] file1 file2'

const comm: Program = function* (sys, argv) {
  const o = options(argv, '123')
  if (o.bad !== null) return yield* misuse(sys, 'comm', o.bad, COMM_USAGE)
  const wrong = operands(o.rest)
  if (wrong !== null) return yield* misuse(sys, 'comm', wrong, COMM_USAGE)
  const [p1, p2] = [o.rest[0], o.rest[1]]
  if (p1 === '-' && p2 === '-') return yield* misuse(sys, 'comm', 'only one of the two files can be the input (-)', COMM_USAGE)
  const show1 = !o.flags.has('1')
  const show2 = !o.flags.has('2')
  const show3 = !o.flags.has('3')
  const lead2 = show1 ? '\t' : ''
  const lead3 = lead2 + (show2 ? '\t' : '')
  const dir = 'is a directory (comm compares two files)'
  const fd1 = yield* openInput(sys, 'comm', p1, dir)
  const fd2 = yield* openInput(sys, 'comm', p2, dir)
  try {
    if (fd1 === null || fd2 === null) return 1
    const files = [{ lines: new Lines(sys, fd1), path: p1, last: null as string | null, told: false }, { lines: new Lines(sys, fd2), path: p2, last: null as string | null, told: false }]
    const out = new Out(sys)
    let status = 0
    /** The next line of one file (null at its end); one that sorts before the line ahead of it is reported, once a file. */
    const next = function* (which: 0 | 1): Task<string | null> {
      const f = files[which]
      let line: string | null
      try {
        line = yield* f.lines.next()
      } catch (e) {
        if (!(e instanceof OsError) || e.errno === 'EPIPE') throw e
        yield* out.flush()
        yield* complain(sys, 'comm', f.path, e)
        status = 1
        line = null
      }
      if (line !== null && f.last !== null && line < f.last && !f.told) {
        f.told = true
        status = 1
        yield* out.flush()
        yield* complain(sys, 'comm', f.path, 'not in sorted order')
      }
      if (line !== null) f.last = line
      return line
    }
    return yield* writing(sys, 'comm', 1, function* () {
      let one = yield* next(0)
      let two = yield* next(1)
      while (one !== null || two !== null) {
        if (two === null || (one !== null && one < two)) {
          if (show1) yield* out.line(one ?? '')
          one = yield* next(0)
        } else if (one === null || two < one) {
          if (show2) yield* out.line(lead2 + two)
          two = yield* next(1)
        } else {
          if (show3) yield* out.line(lead3 + one)
          one = yield* next(0)
          two = yield* next(1)
        }
      }
      yield* out.flush()
      return status
    })
  } finally {
    shut(sys, fd1)
    shut(sys, fd2)
  }
}

/** name -> program */
export const DIFF_PROGRAMS: Readonly<Record<string, Program>> = Object.freeze({ diff, cmp, comm })

/** name -> manual page text */
export const DIFF_MANUAL: Readonly<Record<string, string>> = Object.freeze({
  diff: `NAME
    diff - show the lines that differ between two text files

USAGE
    ${DIFF_USAGE}

WHAT IT DOES
    Compares two files line by line and prints the changes that turn
    the first into the second, as few as it can find. Without options
    each change starts with a line such as 3c3 (line 3 of the first
    file changed into line 3 of the second), 5a6,7 (lines 6 and 7 of
    the second added after line 5 of the first) or 8,9d7 (lines 8 and
    9 of the first deleted; they would have come after line 7 of the
    second). The old lines follow, marked <, then the new lines,
    marked >, with a line --- between them. The name - stands for the
    input.

OPTIONS
    -u      the unified form: a line --- names the first file and a
            line +++ the second; then each group of nearby changes is
            headed by a line like @@ -4,3 +4,5 @@ (it covers 3 lines
            from line 4 of the first file and 5 from line 4 of the
            second) and shows removed lines marked -, added lines
            marked +, and 3 unchanged lines around them marked with a
            space
    -U N    the unified form with N unchanged lines around each change
    -q      only say "Files a and b differ" when they do
    -i      take capital and small letters as the same
    -b      take any run of white space (spaces and tabs) as one space,
            and ignore white space at the end of a line
    -w      ignore white space altogether

NOTES
    A last line that has no line end is followed by the line
    "\\ No newline at end of file", and it counts as different from
    the same line with one. Both files are read whole, and each may
    have at most 100000 lines. When the two differ in more than 20000
    lines in all, or the search for the fewest changes runs too long,
    everything from the first difference to the last is shown as one
    change instead. A file that holds a zero byte, or bytes that are
    not UTF-8 text, is compared byte for byte and reported only as
    "Files a and b differ". A directory is refused: there is no
    recursive mode. There is no context form (-c), no side-by-side
    form, and no time after the names in the --- and +++ lines.

STATUS
    0 when the files are the same, 1 when they differ, 2 when a file
    could not be read or the command was wrong.

EXAMPLE
    diff -u notes.old notes.txt
`,
  cmp: `NAME
    cmp - compare two files byte by byte

USAGE
    ${CMP_USAGE}

WHAT IT DOES
    Reads the two files side by side and stops at the first byte that
    differs, printing where it is, like "a b differ: byte 12, line 2"
    (both count from 1). It works on any file, text or not, and reads
    both a piece at a time, so the files may be of any size. When one
    file is the start of the other, it says "cmp: EOF on" and the name
    of the shorter one (EOF: the end of the file). The name - stands
    for the input.

OPTIONS
    -s      print nothing: only the status tells
    -l      list every byte that differs, one line each: its place
            (from 1) and its value in each file, in octal (base 8);
            -s and -l cannot be used together

STATUS
    0 when the files are the same, 1 when they differ, 2 when a file
    could not be read or the command was wrong.

EXAMPLE
    cmp -l old.bin new.bin | head
`,
  comm: `NAME
    comm - show the lines two sorted files share and the lines they do not

USAGE
    ${COMM_USAGE}

WHAT IT DOES
    Reads two files whose lines are already in order (sort puts them
    so) and prints three columns: the lines only in the first file,
    then after one tab the lines only in the second, then after two
    tabs the lines in both. A column that is left out takes its tab
    with it. The name - stands for the input, for one of the files.

OPTIONS
    -1      leave out the lines only in the first file
    -2      leave out the lines only in the second file
    -3      leave out the lines in both (-12 shows only those)

NOTES
    Lines are compared by the code of each character, the order sort
    uses without options. A file found out of order is reported once
    and the status is then 1; its columns are of little use.

STATUS
    0, or 1 when a file could not be read or was out of order; 2 when
    the command was wrong.

EXAMPLE
    comm -12 guests.txt replies.txt
`,
})
