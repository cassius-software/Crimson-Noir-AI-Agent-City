// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is Stage 2 of the two-stage tutorial: the console's optional lessons in Crimson Noir
 * Script, as pure data and a small state machine (commands.ts `tutorial` and its watch over each line). Stage 1, the
 * first walk, ends at the console; from there `tutorial` lists ten lessons and `tutorial <n>` starts one. Each lesson
 * opens with the five W's (who, what, when, where, why), every answer in words a five-year-old follows, then asks for a
 * few lines to type, one at a time. The console runs each line as it always does, and when the line is the lesson's
 * (spaces aside) and what it printed is what the lesson said it would print, the lesson says what just happened and
 * offers the next line; a `noir` line that stops with an error, or the lesson's own line printing something else, gets a
 * pointer back to the line. `tutorial hint` says the
 * line again with a tip, `tutorial next` skips it, `tutorial stop` ends the lesson, and a finished lesson is marked in
 * the list (kept by the host through the bridge's `lessons` store, so the marks outlive a reload where it keeps them;
 * the console merges its marks with the store's on every read and write, so two tabs never wipe each other's).
 * Nothing here is taught that the language does not do: every line a lesson asks for, and the output it says that line
 * gives, is run through the real console in lessons.test.ts, alone and after every lesson before it. A lesson never
 * asks for the ~ or ^ characters, since on some keyboards those keys open and close the console itself.
 * What breaks if it is removed? `tutorial <n>` has nothing to teach, and the console's language has no way in for a
 * newcomer but its reference page.
 */
import type { Line } from './commands.ts'

/** The five W's of a lesson, answered in that order: who, what, when, where, why. */
export type FiveWs = readonly [who: string, what: string, when: string, where: string, why: string]
const W_WORDS = ['Who?', 'What?', 'When?', 'Where?', 'Why?'] as const

/** One line a lesson asks for, what the console must print for it, and what the lesson says about it. */
export interface Try {
  /** The whole line to type, as it is typed at the prompt. */
  readonly type: string
  /** The out lines the line prints, in order (the first ones; a check the line earned may follow them). */
  readonly out?: readonly string[]
  /** Where the numbers depend on the city (or on what was typed before): what the out lines, joined, must match. */
  readonly like?: RegExp
  /** Where the lesson is about a stop: what the line's error must say (after `out`, when that is given). */
  readonly err?: RegExp
  /** What the lesson says once the line has done what it should, in a five-year-old's words. */
  readonly then: string
  /** What `tutorial hint` adds under the line. */
  readonly hint: string
}

export interface Lesson {
  readonly title: string
  readonly ws: FiveWs
  readonly tries: readonly Try[]
}

/** The host's store for the finished marks (App.tsx: the page's local storage under LESSONS_KEY). */
export interface LessonStore { load(): string | null; save(value: string): void }
export const LESSONS_KEY = 'civic-simulation:lessons:v1'

const TYPE_IT = 'Type the whole line, from noir to the end, and press Enter.'

export const LESSONS: readonly Lesson[] = Object.freeze([
  {
    title: 'your first line',
    ws: [
      'You type, and the console answers.',
      'A line of Crimson Noir Script: words that a small computer inside the city understands.',
      'Whenever the console is open.',
      'On the console’s line, after the word noir.',
      'So the console’s small computer does exactly what you write: no more, and no less.',
    ],
    tries: [
      { type: 'noir print("hello");', out: ['hello'], then: 'print shows what you give it. Words go in quotes, and the semicolon marks the end.', hint: `${TYPE_IT} The quotes and the semicolon count.` },
      { type: 'noir print(2 + 3);', out: ['5'], then: 'Numbers need no quotes: the console works the sum out first, then prints it.', hint: TYPE_IT },
      { type: 'noir print(2 + 3 * 4, (2 + 3) * 4);', out: ['14 20'], then: 'Times comes before plus, like at school, and brackets come first of all. A comma prints two things on one line.', hint: `${TYPE_IT} The star * means times.` },
    ],
  },
  {
    title: 'names that remember',
    ws: [
      'You choose the names, and the console keeps them.',
      'A name for a value, made with let.',
      'From the line you make it until a new let of that name, noir reset, or a page reload.',
      'In the console’s memory, which every noir line you type shares.',
      'So you can build something one line at a time.',
    ],
    tries: [
      { type: 'noir let apples = 3; print(apples);', out: ['3'], then: 'let gives a value a name, and the console remembers it.', hint: TYPE_IT },
      { type: 'noir print(apples + 2);', out: ['5'], then: 'A new line, and apples is still 3: names last from line to line.', hint: `${TYPE_IT} It needs the line before it, which made apples.` },
      { type: 'noir apples = 4;', err: /cannot assign to immutable 'apples'/, then: 'A let name cannot be changed with =, so the console said no: nothing changes it behind your back. (A new let would make a new apples.)', hint: `${TYPE_IT} It needs the first line, which made apples. This one is meant to stop with an error.` },
      { type: 'noir let mut count = 0; print(count);', out: ['0'], then: 'let mut makes a name that is allowed to change.', hint: TYPE_IT },
      { type: 'noir count += 1; print(count);', out: ['1'], then: 'The += adds to it. Type the same line again and it counts 2, then 3.', hint: `${TYPE_IT} It needs the line before it, which made count.` },
    ],
  },
  {
    title: 'kinds of numbers',
    ws: [
      'The console, checking the kind of every value.',
      'Whole numbers (i32), whole numbers that are never below zero (u32), numbers with a point (f32), and true or false (bool).',
      'Before a line runs: a line whose kinds do not fit together never starts.',
      'In every let and every sum.',
      'So a name that holds a whole number is never mixed with a point number by accident.',
    ],
    tries: [
      { type: 'noir print(7 / 2, 7.0 / 2.0);', out: ['3 3.5'], then: 'Whole numbers give a whole answer, so 7 / 2 is 3. Numbers with a point keep the half: 3.5.', hint: TYPE_IT },
      { type: 'noir let cats = 3; let cake = 1.5; print(cats + cake);', err: /type mismatch: i32 \+ f32 \(use 'as f32' or 'as i32'\)/, then: 'cats holds a whole number and cake a point number, and the console will not add them by itself, so the line never ran. It even says how to fix it.', hint: `${TYPE_IT} This one is meant to stop with an error.` },
      { type: 'noir let cats = 3; let cake = 1.5; print(cats as f32 + cake);', out: ['4.5'], then: 'as f32 turns cats into a point number first, so the sum works: 4.5. (A bare 3 typed next to 1.5 is taken as 3.0 by itself.)', hint: TYPE_IT },
      { type: 'noir print(0u - 1u);', out: ['4294967295'], then: 'A u32 is never below zero: take 1 from 0 and it wraps round to the biggest u32 there is, 4294967295.', hint: `${TYPE_IT} The u after a number makes it a u32.` },
      { type: 'noir print(3 > 2, 2 > 3);', out: ['true false'], then: 'A comparison gives a bool, true or false. The next lesson chooses with it.', hint: TYPE_IT },
    ],
  },
  {
    title: 'choosing and repeating',
    ws: [
      'The console, following your rules.',
      'if chooses one way or the other; for and while do something again and again.',
      'Each time the line runs, from the top.',
      'Inside the curly brackets { } after if, else, for or while.',
      'So one short line can do a lot of work.',
    ],
    tries: [
      { type: 'noir for i in 0..3 { print(i); }', out: ['0', '1', '2'], then: '0..3 counts 0, 1 and 2, and stops before 3. Write 0..=3 to count the 3 too.', hint: TYPE_IT },
      { type: 'noir let n = 7; if n % 2 == 0 { print("even"); } else { print("odd"); }', out: ['odd'], then: 'The % gives what is left over: 7 shared out by 2 leaves 1, so 7 is odd. Two equals signs ask whether two things are the same.', hint: TYPE_IT },
      { type: 'noir let mut total = 0; for i in 1..=10 { total += i; } print(total);', out: ['55'], then: 'The loop added 1, 2, 3 and so on up to 10, one at a time: 55.', hint: TYPE_IT },
      { type: 'noir let mut k = 1; while k < 100 { k *= 2; } print(k);', out: ['128'], then: 'while goes round as long as its question is true: 1, 2, 4 and so on, doubling until it passed 100 at 128.', hint: TYPE_IT },
    ],
  },
  {
    title: 'your own words',
    ws: [
      'You: a fn is a word you teach the console.',
      'fn, a name, what it takes in brackets, and after -> the kind of thing it gives back.',
      'Once taught, on every later line, until you teach it again or type noir reset.',
      'Anywhere on a noir line, but never inside { }.',
      'So you write a thing once and use it again and again.',
    ],
    tries: [
      { type: 'noir fn sq(x: i32) -> i32 { x * x } print(sq(4));', out: ['16'], then: 'sq is your own word now: it takes a whole number x and gives back x times x. The last thing in a fn, with no semicolon after it, is what it gives back.', hint: TYPE_IT },
      { type: 'noir print(sq(sq(3)));', out: ['81'], then: 'A word you teach stays taught: sq of sq of 3 is sq of 9, which is 81.', hint: `${TYPE_IT} It needs the line before it, which taught sq.` },
      { type: 'noir fn sign(x: i32) -> i32 { if x > 0 { 1 } else if x < 0 { -1 } else { 0 } } print(sign(-5), sign(0), sign(9));', out: ['-1 0 1'], then: 'An if with an else can be the answer too: sign gives -1, 0 or 1.', hint: TYPE_IT },
      { type: 'noir words', like: /^(?=[^\n]*\bsq\b)(?=[^\n]*\bsign\b)/, then: 'noir words lists the language’s own words, then yours at the end.', hint: 'Type noir words and press Enter. It needs the lines that taught sq and sign.' },
    ],
  },
  {
    title: 'reading the city',
    ws: [
      'The city: its people, its cars, its rule keeper (the kernel) and its pictures (frames).',
      'Four tables, lists of numbers you can read: crowd, cars, kernel and frame.',
      'Each line reads a fresh copy, taken as the line starts.',
      'In the city’s console. In the console on its own, with no city running, the tables are empty and their numbers read 0.',
      'So your lines can see what the city is doing, without changing it by mistake.',
    ],
    tries: [
      { type: 'noir print(crowd.n, cars.n);', like: /^\d+ \d+$/, then: 'crowd.n is how many people the city has, and cars.n how many cars. In the console on its own both are 0.', hint: TYPE_IT },
      { type: 'noir print(query cars where mode == 2);', like: /^\d+$/, then: 'query counts the cars where your question is true. A car in mode 2 is parked.', hint: TYPE_IT },
      { type: 'noir print(frame.fps, kernel.law1);', like: /^\S+ \d+$/, then: 'frame.fps is how fast the city is drawing, in pictures a second, and kernel.law1 counts the times the First Law stepped in.', hint: TYPE_IT },
      { type: 'noir crowd = 1;', err: /'crowd' is a table and cannot be assigned/, then: 'The tables are copies, only for reading, so changing one is refused.', hint: `${TYPE_IT} This one is meant to stop with an error.` },
    ],
  },
  {
    title: 'the walls',
    ws: [
      'The console’s small computer, keeping the city safe from a line that goes wrong.',
      'Walls round every line: at most a million steps (more in the unlocked elite tier), a fixed amount of memory, and lists that check their edges.',
      'Every time a line runs. A line that hits a wall stops right there.',
      'Around every noir line, in the city and in the console on its own.',
      'So no line can hold the city up for long: at worst it pauses a moment, then stops.',
    ],
    tries: [
      { type: 'noir loop { }', err: /step budget exhausted \(\d+\)/, then: 'loop goes round for ever, so the console stopped it when its steps ran out, a moment later.', hint: `${TYPE_IT} This one is meant to stop.` },
      { type: 'noir let a = [1, 2, 3]; print(a[3]);', err: /index 3 out of bounds \(len 3\)/, then: 'A list of three counts 0, 1 and 2. Asking for number 3 stops the line, instead of reading something that is not there.', hint: `${TYPE_IT} This one is meant to stop with an error.` },
      { type: 'noir print(1); print(10 / 0); print(2);', out: ['1'], err: /division by zero/, then: '1 printed, then the line stopped at the division by zero, so 2 never printed. What printed before a stop stays printed.', hint: `${TYPE_IT} This one is meant to stop with an error.` },
      { type: 'noir fn down(n: i32) -> i32 { down(n + 1) } print(down(0));', err: /stack overflow \(depth \d+\)/, then: 'A fn that calls itself for ever runs out of room, so the line stops when the calls are too deep.', hint: `${TYPE_IT} This one is meant to stop with an error.` },
    ],
  },
  {
    title: 'switches inside numbers',
    ws: [
      'The tiny switches inside every whole number.',
      'Each whole number is 32 switches, each one on (1) or off (0); & and | combine them, << and >> slide them.',
      'Whenever many yes-or-no answers should fit in one number.',
      'In whole numbers (i32 and u32), never in numbers with a point.',
      'Because computers think in switches, and switches are quick.',
    ],
    tries: [
      { type: 'noir print(0b0110 & 0b0011, 0b0110 | 0b0011);', out: ['2 7'], then: '0b writes a number as its switches. & keeps a switch on where both are on (0010 is 2); | keeps it on where either is (0111 is 7).', hint: TYPE_IT },
      { type: 'noir print(1 << 3, 40 >> 2);', out: ['8 10'], then: '<< slides the switches left, which doubles a number at each place; >> slides them right, which halves it.', hint: TYPE_IT },
      { type: 'noir print(popcount(0b1011u));', out: ['3'], then: 'popcount counts the switches that are on: 1011 has three.', hint: TYPE_IT },
    ],
  },
  {
    title: 'four at once',
    ws: [
      'Vectors: four (or eight) numbers that travel together.',
      'An f32x4 holds four numbers with a point, each in its own place, called a lane, and one sum works on all four.',
      'When the same sum is needed on many numbers, like everyone’s place on the map.',
      'In the kinds f32x4, i32x4, u32x4 and u32x8.',
      'Because one order for four numbers is less work than four orders.',
    ],
    tries: [
      { type: 'noir print(f32x4(1, 2, 3, 4) + f32x4(10, 20, 30, 40));', out: ['f32x4(11, 22, 33, 44)'], then: 'Four sums in one order: each lane adds to the same lane of the other.', hint: TYPE_IT },
      { type: 'noir print(f32x4(1, 2, 3, 4) * splat_f32x4(2.0));', out: ['f32x4(2, 4, 6, 8)'], then: 'splat_f32x4 copies one number into all four lanes, so all four can be doubled at once.', hint: TYPE_IT },
      { type: 'noir print(hsum(f32x4(1, 2, 3, 4)));', out: ['10'], then: 'hsum adds the four lanes together into one number.', hint: TYPE_IT },
      { type: 'noir print(load_f32x4(crowd.x, 0));', like: /^f32x4\([^)]*\)$/, then: 'load_f32x4 reads four people’s x places in one go; past the end of the list it reads 0.', hint: TYPE_IT },
    ],
  },
  {
    title: 'under the hood',
    ws: [
      'The console’s small computer, which does one small order at a time.',
      'noir asm shows the orders a line turns into, without running it.',
      'Any time you want to see what a line turns into.',
      'After noir asm, on the same line.',
      'Because each order costs at least one step (one that moves a long list costs more), and steps are what the walls count.',
    ],
    tries: [
      { type: 'noir asm print(1 + 2);', like: /PUSH 1\n[^\n]*PUSH 2\n[^\n]*ADD_I32\n[^\n]*PRINT 1 i32\n[^\n]*RET 0$/, then: 'Push 1, push 2, add, print, return: five small orders, so this line costs five steps.', hint: 'Type noir asm, a space, then print(1 + 2); and press Enter.' },
      { type: 'noir asm print(1.5 + 2.5);', like: /ADD_F32/, then: 'A sum of numbers with a point is a different order, ADD_F32, and 1.5 goes in as its 32 switches. Kinds matter all the way down.', hint: 'Type noir asm, a space, then print(1.5 + 2.5); and press Enter.' },
      { type: 'noir asm for i in 0..3 { print(i); }', like: /\bJMP_IF_NOT \d{4}\n[\s\S]*\bJMP \d{4}\n/, then: 'A loop is a jump back to its question, which asks whether to go round again. That is how a short line can go round and round.', hint: 'Type noir asm, a space, then the loop, and press Enter.' },
    ],
  },
] satisfies Lesson[])

/** The console's lesson state: the lesson running and the line it waits for, and the lessons finished (this console's, merged with the store's whenever it is read; null until then). */
export interface LessonRun {
  active: { lesson: number; at: number } | null
  finished: Set<number> | null
}
export const newLessonRun = (): LessonRun => ({ active: null, finished: null })

const out = (text: string): Line => ({ kind: 'out', text })
const sys = (text: string): Line => ({ kind: 'sys', text })

const lessonOf = (n: number): Lesson => LESSONS[n - 1]!
/** A line as the lesson compares it: runs of spaces as one, and none beside a bracket or a sign (a semicolon still counts). */
const bare = (line: string): string => line.trim().replace(/\s+/g, ' ').replace(/ ?([^\w ]) ?/g, '$1')
/** Whether a line is the try's own line, spaces aside. */
const sameLine = (t: Try, line: string): boolean => bare(line) === bare(t.type)
/** The console command a line runs (noir, with asm, words and reset, is one), for the pointer back. */
const commandOf = (line: string): string => /^\S+/.exec(line.trim())?.[0] ?? ''

/**
 * Whether a line is the try's line (spaces aside) and printed what the try says it prints: the line itself counts, so a
 * yes never describes a line that was not typed.
 */
export function passes(t: Try, line: string, printed: readonly Line[]): boolean {
  if (!sameLine(t, line)) return false
  const outs = printed.filter((l) => l.kind === 'out').map((l) => l.text)
  const errs = printed.filter((l) => l.kind === 'err').map((l) => l.text)
  if (t.out && (outs.length < t.out.length || t.out.some((o, i) => outs[i] !== o))) return false
  if (t.like && (outs.length === 0 || !t.like.test(outs.join('\n')))) return false
  if (t.err) return errs.length === 1 && t.err.test(errs[0]!)
  return errs.length === 0
}

/** The line to type, on a row of its own under what it is (a narrow console wraps a long line, never the label into it). */
const tryLines = (l: Lesson, at: number): Line[] => [out(`try ${at + 1} of ${l.tries.length}, type this line:`), out(`  ${l.tries[at]!.type}`)]

/** A lesson's opening: its title, then the five W's (each its W, a space and the answer, so a narrow console wraps it plainly). */
function opening(n: number): Line[] {
  const l = lessonOf(n)
  return [out(`lesson ${n} of ${LESSONS.length}: ${l.title}`), ...l.ws.map((a, i) => sys(`${W_WORDS[i]!} ${a}`))]
}

/** `tutorial <n>` in a console that keeps a lesson running: the opening and the first line to type. */
export function lessonStart(run: LessonRun, n: number): Line[] {
  run.active = { lesson: n, at: 0 }
  return [...opening(n), ...tryLines(lessonOf(n), 0), sys('tutorial hint helps with it, tutorial next skips it, tutorial stop ends the lesson')]
}

/** `tutorial <n>` where no lesson can run (no console session): the whole lesson at once. */
export function lessonWhole(n: number): Line[] {
  const l = lessonOf(n)
  return [...opening(n), ...l.tries.map((t, i) => out(`  ${i + 1}. ${t.type}`))]
}

/** `tutorial` alone: the lessons, with the finished ones marked. */
export function lessonList(finished: ReadonlySet<number>): Line[] {
  const pad = String(LESSONS.length).length
  return [
    out(`console lessons in Crimson Noir Script, ${finished.size} of ${LESSONS.length} finished:`),
    ...LESSONS.map((l, i) => out(`  ${String(i + 1).padStart(pad)}  ${l.title}${finished.has(i + 1) ? '  (finished)' : ''}`)),
    sys('tutorial <n> starts one; tutorial hint, next and stop steer it; tutorial program prints the exit program'),
  ]
}

/** The lesson is at its end: it is finished, and the lesson says what comes next. */
function finish(run: LessonRun, n: number): Line[] {
  run.active = null
  const done = (run.finished ??= new Set()).add(n)
  const next = LESSONS.findIndex((_, i) => !done.has(i + 1))
  return [sys(next < 0
    ? `lesson ${n} finished: that is every lesson, ${done.size} of ${LESSONS.length}`
    : `lesson ${n} finished (${done.size} of ${LESSONS.length}); next: tutorial ${next + 1}, ${LESSONS[next]!.title}`)]
}

/** On to the next line of the running lesson, or to its end. */
function advance(run: LessonRun): { lines: Line[]; finished: number | null } {
  const a = run.active!
  const l = lessonOf(a.lesson)
  if (a.at + 1 < l.tries.length) {
    a.at++
    return { lines: tryLines(l, a.at), finished: null }
  }
  return { lines: finish(run, a.lesson), finished: a.lesson }
}

/**
 * The watch over every line the console runs while a lesson is running: the line the lesson waits for, done, is said
 * and the next one offered; the lesson's own line printing something else, or a line of the same command (any `noir`
 * line, for a `noir` lesson) that stopped with an error, gets a pointer back to the line, whether or not the line waited
 * for is one that stops; anything else is the visitor's own and passes without a word.
 */
export function lessonAfter(run: LessonRun, line: string, printed: readonly Line[]): { lines: Line[]; finished: number | null } {
  const a = run.active
  if (!a) return { lines: [], finished: null }
  const t = lessonOf(a.lesson).tries[a.at]!
  if (passes(t, line, printed)) {
    const next = advance(run)
    return { lines: [sys(`yes: ${t.then}`), ...next.lines], finished: next.finished }
  }
  if (sameLine(t, line)) {
    return { lines: [sys('not yet: that is the line, but it did not do what this lesson expects (tutorial hint says what it needs)')], finished: null }
  }
  if (commandOf(line) === commandOf(t.type) && printed.some((l) => l.kind === 'err')) {
    return { lines: [sys('not yet: the line to try is this one (tutorial hint helps, tutorial next skips it)'), out(`  ${t.type}`)], finished: null }
  }
  return { lines: [], finished: null }
}

/** `tutorial hint`: the line again, and its tip. */
export function lessonHint(run: LessonRun): Line[] {
  const a = run.active!
  const l = lessonOf(a.lesson)
  return [...tryLines(l, a.at), sys(`hint: ${l.tries[a.at]!.hint}`)]
}

/** `tutorial next`: the line skipped, and the next one (or the lesson's end). */
export function lessonNext(run: LessonRun): { lines: Line[]; finished: number | null } {
  const a = run.active!
  const skipped = sys(`skipped try ${a.at + 1} of ${lessonOf(a.lesson).tries.length}`)
  const next = advance(run)
  return { lines: [skipped, ...next.lines], finished: next.finished }
}

/** `tutorial stop`: the lesson ends where it was. */
export function lessonStop(run: LessonRun): Line[] {
  const a = run.active!
  run.active = null
  return [sys(`lesson ${a.lesson} stopped at try ${a.at + 1} of ${lessonOf(a.lesson).tries.length}; tutorial ${a.lesson} starts it again`)]
}

/** The finished marks as the store keeps them, and read back (anything odd reads as none). */
export function finishedText(finished: ReadonlySet<number>): string {
  return JSON.stringify({ v: 1, finished: [...finished].sort((x, y) => x - y) })
}
export function finishedFrom(text: string | null): Set<number> {
  const none = new Set<number>()
  if (typeof text !== 'string' || text.length > 512) return none
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object' || (v as { v?: unknown }).v !== 1) return none
    const list = (v as { finished?: unknown }).finished
    if (!Array.isArray(list)) return none
    return new Set(list.filter((n): n is number => Number.isInteger(n) && n >= 1 && n <= LESSONS.length))
  } catch {
    return none
  }
}
