// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence that the console lessons (lessons.ts, Stage 2 of the two-stage tutorial)
 * teach nothing the language does not do: every line a lesson asks for is run through the real console (commands.ts
 * run, the real Crimson Noir Script session), in a console with no city and in one with a small city, lesson by lesson
 * in a fresh console and all ten in one console after each other, and what it prints is what the lesson says. It also
 * pins how a lesson runs (the five W's first, one line at a time, hint, next, stop, the finished marks kept through the
 * host's store, merged with it on every read and write), what a line that is not the lesson's gets (nothing, or a
 * pointer back after an error, on every kind of try), that a yes is only ever for the line the lesson asked for, that a
 * try that needs an earlier line says so in its hint, that a check the line earned still follows, the facts the
 * lessons state about the language (step counts, the orders a line turns into, the rules for names and fn), and the
 * words: the language's whole name, five plain W's, no combat words, no third-party names, and no ~, ^ or ` to type
 * (on some keyboards those keys open and close the console).
 * What breaks if it is removed? A lesson could promise an output the console no longer prints, and a newcomer would be
 * stuck on a line that can never pass.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { screen } from '../../02_Define_The_Rules/conduct.ts'
import { BRAND } from '../../brand.ts'
import { offlineBridge, type TerminalBridge } from './bridge.ts'
import { replSession, run, type Line } from './commands.ts'
import { consoleBridge } from './consoleBridge.ts'
import { LESSONS, LESSONS_KEY, finishedFrom, finishedText, lessonAfter, newLessonRun, passes, type Try } from './lessons.ts'
import { NoirSession, type NoirTables } from './noirscript/index.ts'

/** A store like the page's local storage, counting what it was asked. */
function memoryStore(start: string | null = null) {
  const s = { kept: start, loads: 0, saves: 0, load: () => { s.loads++; return s.kept }, save: (v: string) => { s.saves++; s.kept = v } }
  return s
}
/** A small city: twelve people, three cars (one parked), a law that stepped in twice, a frame rate. */
const CITY: NoirTables = Object.freeze({
  crowd: { n: 12, x: Float32Array.from({ length: 12 }, (_, i) => i * 1.5), z: new Float32Array(12) },
  cars: { n: 3, x: new Float32Array([1, 2, 3]), z: new Float32Array(3), heading: new Float32Array(3), speed: new Float32Array([0, 8, 12]), mode: new Int32Array([2, 0, 0]) },
  kernel: { law1: 2, law2: 0, law3: 1, flips: 3, shielded: true },
  frame: { fps: 59.9, ms: 16.7, p95: 18.2 },
})
const consoleAlone = (): TerminalBridge => offlineBridge(BRAND)
const inTheCity = (): TerminalBridge => ({ ...offlineBridge(BRAND), soa: { tables: () => CITY } })
const outs = (lines: readonly Line[]) => lines.filter((l) => l.kind === 'out').map((l) => l.text)
const said = (lines: readonly Line[]) => lines.filter((l) => l.kind === 'sys').map((l) => l.text)
const texts = (lines: readonly Line[]) => lines.map((l) => l.text)
const NOT_YET = 'not yet: the line to try is this one (tutorial hint helps, tutorial next skips it)'
const THE_LINE = 'not yet: that is the line, but it did not do what this lesson expects (tutorial hint says what it needs)'

/** Every try of a lesson, run on the real console: what it printed meets the try, and an exact `out` is the line's own first lines. */
function checkLesson(b: TerminalBridge, session: ReturnType<typeof replSession>, n: number, where: string): void {
  LESSONS[n - 1]!.tries.forEach((t, i) => {
    const printed = run(t.type, b, [], { machine: session.machine, noir: session.noir }).lines
    assert.ok(passes(t, t.type, printed), `${where}, lesson ${n} try ${i + 1}: ${t.type}\n${printed.map((l) => `[${l.kind}] ${l.text}`).join('\n')}`)
    if (t.out) assert.deepEqual(outs(printed).slice(0, t.out.length), [...t.out], `${where}, lesson ${n} try ${i + 1}`)
    if (t.err) assert.equal(printed.filter((l) => l.kind === 'err').length, 1, `${where}, lesson ${n} try ${i + 1}: one error`)
  })
}

test('every line a lesson asks for prints what the lesson says, alone and after every lesson before it, with and without a city', () => {
  for (const [where, bridge] of [['the console alone', consoleAlone], ['the city', inTheCity]] as const) {
    LESSONS.forEach((_, i) => checkLesson(bridge(), replSession(), i + 1, `${where}, a fresh console`))
    const shared = replSession()
    const b = bridge()
    LESSONS.forEach((_, i) => checkLesson(b, shared, i + 1, `${where}, one console`))
  }
  // The numbers the city lessons read are the city's own: in a city they are its counts, alone they are 0.
  const city = inTheCity(), alone = consoleAlone()
  const reading = LESSONS[5]!.tries
  assert.deepEqual(outs(run(reading[0]!.type, city, []).lines), ['12 3'])
  assert.deepEqual(outs(run(reading[0]!.type, alone, []).lines), ['0 0'])
  assert.deepEqual(outs(run(reading[1]!.type, city, []).lines), ['1'], 'one car parked')
  assert.deepEqual(outs(run(reading[2]!.type, city, []).lines), ['59.9 2'])
  assert.deepEqual(outs(run(LESSONS[8]!.tries[3]!.type, city, []).lines), ['f32x4(0, 1.5, 3, 4.5)'])
  assert.deepEqual(outs(run(LESSONS[8]!.tries[3]!.type, alone, []).lines), ['f32x4(0, 0, 0, 0)'])
})

test('a lesson runs on the console: the five W\'s, one line at a time, a yes for each, and the finished mark kept and read back', () => {
  const store = memoryStore()
  const b: TerminalBridge = { ...consoleAlone(), lessons: store }
  const s = replSession()
  const start = run('tutorial 1', b, [], s).lines
  assert.deepEqual(start.map((l) => l.kind), ['out', 'sys', 'sys', 'sys', 'sys', 'sys', 'out', 'out', 'sys'])
  assert.equal(start[0]!.text, `lesson 1 of ${LESSONS.length}: your first line`)
  // Each W, one space, its answer: no column padding for a narrow console to wrap into.
  assert.deepEqual(start.slice(1, 6).map((l) => /^(\w+\?) \S/.exec(l.text)?.[1]), ['Who?', 'What?', 'When?', 'Where?', 'Why?'])
  assert.match(start[2]!.text, /Crimson Noir Script/)
  assert.deepEqual(texts(start.slice(6, 8)), ['try 1 of 3, type this line:', '  noir print("hello");'], 'the line to type on a row of its own')
  // The visitor's own line passes without a word, even one that prints what the lesson's line prints; a line that stops
  // with an error gets a pointer back, the line on its own row.
  assert.deepEqual(said(run('noir print("hi");', b, [], s).lines), [])
  assert.deepEqual(texts(run('noir print("hello"); print(1);', b, [], s).lines), ['hello', '1'], 'a yes is only for the line asked for')
  assert.deepEqual(texts(run('noir print(1 +);', b, [], s).lines).slice(1), [NOT_YET, '  noir print("hello");'])
  assert.deepEqual(texts(run('noir print("hello")', b, [], s).lines).slice(1), [NOT_YET, '  noir print("hello");'], 'the semicolon counts')
  assert.deepEqual(run('help', b, [], s).lines, run('help', b, []).lines, 'another command is the visitor\'s own')
  assert.deepEqual(texts(run('tutorial hint', b, [], s).lines), ['try 1 of 3, type this line:', '  noir print("hello");', 'hint: Type the whole line, from noir to the end, and press Enter. The quotes and the semicolon count.'])
  const [one, two, three] = LESSONS[0]!.tries.map((t, i) => run(i === 0 ? 'noir  print( "hello" ) ;' : t.type, b, [], s).lines)
  assert.deepEqual(outs(one!), ['hello', 'try 2 of 3, type this line:', '  noir print(2 + 3);'], 'spaces aside')
  assert.match(said(one!)[0]!, /^yes: print shows what you give it\./)
  assert.deepEqual(outs(two!), ['5', 'try 3 of 3, type this line:', '  noir print(2 + 3 * 4, (2 + 3) * 4);'])
  assert.deepEqual(said(three!).at(-1), `lesson 1 finished (1 of ${LESSONS.length}); next: tutorial 2, names that remember`)
  assert.equal(store.saves, 1)
  assert.deepEqual(JSON.parse(store.kept!), { v: 1, finished: [1] })
  // The lesson is over: lines pass without a word, and hint, next and stop say there is none.
  assert.deepEqual(said(run('noir print(1 +);', b, [], s).lines), [])
  for (const w of ['hint', 'next', 'stop']) assert.deepEqual(run(`tutorial ${w}`, b, [], s).lines, [{ kind: 'err', text: 'tutorial: no lesson is running; tutorial lists them, tutorial <n> starts one' }], w)
  // The list marks it, here and in a new console reading the same store.
  assert.match(run('tutorial', b, [], s).lines[2]!.text, /^ {2} 1 {2}your first line {2}\(finished\)$/)
  const again = replSession()
  const list = run('tutorial', b, [], again).lines.map((l) => l.text)
  assert.equal(list[1], `console lessons in Crimson Noir Script, 1 of ${LESSONS.length} finished:`)
  assert.doesNotMatch(list[3]!, /finished/)
})

test('the finished marks are merged with the store on every read and write: a console opened before the city, and two tabs, lose nothing', () => {
  // A console that listed the lessons before the city's bridge (and its store) was there still sees the marks after.
  const store = memoryStore(finishedText(new Set([2, 3, 4])))
  const city: TerminalBridge = { ...consoleAlone(), lessons: store }
  const s = replSession()
  assert.match(texts(run('tutorial', consoleAlone(), [], s).lines)[1]!, /, 0 of 10 finished:$/)
  assert.match(texts(run('tutorial', city, [], s).lines)[1]!, /, 3 of 10 finished:$/)
  void run('tutorial 1', city, [], s)
  const last = LESSONS[0]!.tries.map((t) => run(t.type, city, [], s).lines).at(-1)!
  assert.equal(said(last).at(-1), `lesson 1 finished (4 of ${LESSONS.length}); next: tutorial 5, your own words`)
  assert.deepEqual(JSON.parse(store.kept!), { v: 1, finished: [1, 2, 3, 4] })
  // Two tabs on one store: what one finishes, the other keeps when it finishes its own, and counts.
  const shared = memoryStore()
  const tab = (): TerminalBridge => ({ ...consoleAlone(), lessons: shared })
  const a = replSession(), b = replSession()
  void run('tutorial', tab(), [], a)
  void run('tutorial 1', tab(), [], b)
  for (const t of LESSONS[0]!.tries) void run(t.type, tab(), [], b)
  void run('tutorial 8', tab(), [], a)
  const end = LESSONS[7]!.tries.map((t) => run(t.type, tab(), [], a).lines).at(-1)!
  assert.equal(said(end).at(-1), `lesson 8 finished (2 of ${LESSONS.length}); next: tutorial 2, names that remember`)
  assert.deepEqual(JSON.parse(shared.kept!), { v: 1, finished: [1, 8] })
  assert.match(texts(run('tutorial', tab(), [], b).lines)[1]!, /, 2 of 10 finished:$/)
  // `tutorial next` that finishes a lesson merges too.
  const other = memoryStore(finishedText(new Set([5])))
  const c = replSession()
  void run('tutorial 9', { ...consoleAlone() }, [], c)
  for (let i = 0; i < 3; i++) void run('tutorial next', { ...consoleAlone(), lessons: other }, [], c)
  assert.equal(said(run('tutorial next', { ...consoleAlone(), lessons: other }, [], c).lines).at(-1), `lesson 9 finished (2 of ${LESSONS.length}); next: tutorial 1, your first line`)
  assert.deepEqual(JSON.parse(other.kept!), { v: 1, finished: [5, 9] })
})

test('next skips a line and can finish a lesson; stop ends it where it was; a new lesson replaces the running one; there is no lesson 0 or 11', () => {
  const store = memoryStore()
  const b: TerminalBridge = { ...consoleAlone(), lessons: store }
  const s = replSession()
  void run('tutorial 8', b, [], s)
  assert.deepEqual(texts(run('tutorial next', b, [], s).lines), ['skipped try 1 of 3', 'try 2 of 3, type this line:', '  noir print(1 << 3, 40 >> 2);'])
  assert.deepEqual(texts(run('tutorial stop', b, [], s).lines), ['lesson 8 stopped at try 2 of 3; tutorial 8 starts it again'])
  assert.equal(store.saves, 0)
  assert.deepEqual(texts(run('tutorial 8', b, [], s).lines).slice(6, 8), ['try 1 of 3, type this line:', '  noir print(0b0110 & 0b0011, 0b0110 | 0b0011);'], 'a stopped lesson starts again at its first line')
  void run('tutorial next', b, [], s)
  assert.deepEqual(texts(run('tutorial 8', b, [], s).lines).slice(6, 7), ['try 1 of 3, type this line:'], 'and so does one part-way through')
  assert.match(run('tutorial 10', b, [], s).lines[0]!.text, /^lesson 10 of 10: under the hood$/)
  for (let i = 0; i < 2; i++) void run('tutorial next', b, [], s)
  assert.deepEqual(said(run('tutorial next', b, [], s).lines), ['skipped try 3 of 3', `lesson 10 finished (1 of ${LESSONS.length}); next: tutorial 1, your first line`])
  assert.deepEqual(JSON.parse(store.kept!), { v: 1, finished: [10] })
  for (const n of ['0', '11', '99']) assert.deepEqual(run(`tutorial ${n}`, b, [], s).lines, [{ kind: 'err', text: `tutorial: there is no lesson ${n}; there are ${LESSONS.length} (tutorial lists them)` }])
  assert.deepEqual(run('tutorial x', b, [], s).lines, [{ kind: 'err', text: 'usage: tutorial [<n>|hint|next|stop|status|program]' }])
  // Every lesson finished: the last one says so.
  const all = memoryStore(finishedText(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9])))
  const done = { ...consoleAlone(), lessons: all }
  const t = replSession()
  void run('tutorial 10', done, [], t)
  for (let i = 0; i < 2; i++) void run('tutorial next', done, [], t)
  assert.deepEqual(said(run('tutorial next', done, [], t).lines).at(-1), `lesson 10 finished: that is every lesson, ${LESSONS.length} of ${LESSONS.length}`)
})

test('without a console session a lesson prints whole; without a store the marks last as long as the console; a store that throws costs nothing', () => {
  const whole = run('tutorial 3', consoleAlone(), []).lines
  assert.equal(whole.length, 6 + LESSONS[2]!.tries.length)
  assert.deepEqual(whole.slice(6).map((l) => l.text), LESSONS[2]!.tries.map((t, i) => `  ${i + 1}. ${t.type}`))
  const b = consoleAlone()
  const s = replSession()
  void run('tutorial 1', b, [], s)
  for (const t of LESSONS[0]!.tries) void run(t.type, b, [], s)
  assert.match(run('tutorial', b, [], s).lines[1]!.text, /, 1 of 10 finished:$/)
  const broken: TerminalBridge = { ...consoleAlone(), lessons: { load: () => { throw new Error('storage refused') }, save: () => { throw new Error('storage refused') } } }
  const u = replSession()
  assert.match(run('tutorial', broken, [], u).lines[1]!.text, /, 0 of 10 finished:$/)
  void run('tutorial 1', broken, [], u)
  for (const t of LESSONS[0]!.tries) assert.ok(run(t.type, broken, [], u).lines.every((l) => l.kind !== 'err'), t.type)
  assert.match(run('tutorial', broken, [], u).lines[1]!.text, /, 1 of 10 finished:$/, 'kept for this visit')
  // A session made before lessons existed (no lesson field) gets one on first use.
  const old = { machine: replSession().machine, noir: replSession().noir }
  assert.deepEqual(texts(run('tutorial 2', consoleAlone(), [], old).lines).slice(-3, -1), ['try 1 of 5, type this line:', '  noir let apples = 3; print(apples);'])
})

test('a check the line earned follows the lesson\'s words, and does not stop the line from passing', () => {
  const b: TerminalBridge = { ...consoleAlone(), progress: { command: (name: string) => (name === 'noir' ? ['Computers: 14 vs DC 13, success'] : []) } as unknown as TerminalBridge['progress'] }
  const s = replSession()
  void run('tutorial 1', b, [], s)
  const lines = run('noir print("hello");', b, [], s).lines
  assert.deepEqual(lines.map((l) => l.kind), ['out', 'sys', 'out', 'out', 'out'])
  assert.equal(lines[0]!.text, 'hello')
  assert.match(lines[1]!.text, /^yes: /)
  assert.match(lines[2]!.text, /^try 2 of 3/)
  assert.equal(lines[4]!.text, 'Computers: 14 vs DC 13, success')
})

test('passes: the line asked for (spaces aside), the right lines, the right stop, and nothing else', () => {
  const t = (over: Partial<Try>): Try => ({ type: 'noir print(2 + 3);', then: 'x', hint: 'y', ...over })
  const o = (...text: string[]): Line[] => text.map((x) => ({ kind: 'out', text: x }))
  const e = (x: string): Line => ({ kind: 'err', text: x })
  assert.equal(passes(t({ out: ['5'] }), 'noir print(2 + 3);', o('5')), true)
  assert.equal(passes(t({ out: ['5'] }), '  noir  print( 2+3 ) ; ', o('5')), true, 'spaces aside')
  assert.equal(passes(t({ out: ['5'] }), 'noir print(5);', o('5')), false, 'the same output from another line is not the lesson\'s line')
  assert.equal(passes(t({ out: ['5'] }), 'noir print(2 + 3)', o('5')), false, 'the semicolon counts')
  assert.equal(passes(t({ out: ['5'] }), 'noir print(2 + 3);', o('5', '-- 9 steps --')), true, 'the first lines are the try\'s')
  assert.equal(passes(t({ out: ['5'] }), 'noir print(2 + 3);', o('6')), false)
  assert.equal(passes(t({ out: ['5'] }), 'noir print(2 + 3);', [...o('5'), e('noir: division by zero')]), false, 'an error the try did not ask for')
  assert.equal(passes(t({ out: ['5'] }), 'noir asm print(2 + 3);', o('5')), false, 'noir asm is another line')
  assert.equal(passes(t({ type: 'noir words', like: /\bsq\b/ }), 'noir words', o('fn let sq')), true)
  assert.equal(passes(t({ type: 'noir words', like: /\bsq\b/ }), 'noir words', o('fn let sqrt')), false)
  assert.equal(passes(t({ type: 'noir words', like: /\bsq\b/ }), 'noir words', []), false)
  assert.equal(passes(t({ type: 'noir print(1 / 0);', err: /division by zero/ }), 'noir print(1 / 0);', [e('noir: division by zero')]), true)
  assert.equal(passes(t({ type: 'noir print(1 / 0);', err: /division by zero/ }), 'noir print(1 / 0);', o('1')), false, 'a stop was asked for')
  assert.equal(passes(t({ type: 'noir print(1); print(1 / 0);', out: ['1'], err: /division by zero/ }), 'noir print(1); print(1 / 0);', [...o('1'), e('noir: division by zero')]), true)
  assert.equal(passes(t({ type: 'noir print(1); print(1 / 0);', out: ['1'], err: /division by zero/ }), 'noir print(1); print(1 / 0);', [e('noir: division by zero')]), false)
  // The watch with no lesson running says nothing.
  assert.deepEqual(lessonAfter(newLessonRun(), 'noir print(1 +);', [e('noir: 1:10: expected expression')]), { lines: [], finished: null })
})

test('a try that stops gets the pointer back too: a different stop, the lesson\'s line doing something else, or noir asm in a noir lesson', () => {
  const b = consoleAlone()
  const s = replSession()
  void run('tutorial 2', b, [], s)
  for (const t of LESSONS[1]!.tries.slice(0, 2)) void run(t.type, b, [], s)
  // Lesson 2's third line is meant to stop; a typo stops elsewhere and says so.
  assert.deepEqual(texts(run('noir apples = 4', b, [], s).lines).slice(1), [NOT_YET, '  noir apples = 4;'])
  assert.deepEqual(texts(run('noir apples == 4;', b, [], s).lines).slice(1), [NOT_YET, '  noir apples = 4;'])
  // After noir reset the lesson's own line stops for another reason, and its hint says what it needs.
  void run('noir reset', b, [], s)
  assert.deepEqual(said(run('noir apples = 4;', b, [], s).lines), [THE_LINE])
  assert.match(texts(run('tutorial hint', b, [], s).lines).at(-1)!, /It needs the first line, which made apples\./)
  void run(LESSONS[1]!.tries[0]!.type, b, [], s)
  assert.match(said(run('noir apples = 4;', b, [], s).lines)[0]!, /^yes: A let name cannot be changed with =/)
  // Lesson 7's third line needs the 1 printed first; a line that only divides gets the pointer.
  void run('tutorial 7', b, [], s)
  void run('tutorial next', b, [], s); void run('tutorial next', b, [], s)
  assert.deepEqual(texts(run('noir print(10 / 0);', b, [], s).lines).slice(1), [NOT_YET, '  noir print(1); print(10 / 0); print(2);'])
  // Any noir line that stops points back in a noir lesson, noir asm included, and the other way round.
  void run('tutorial 1', b, [], s)
  assert.deepEqual(said(run('noir asm print(1 +);', b, [], s).lines), [NOT_YET])
  void run('tutorial 10', b, [], s)
  assert.deepEqual(said(run('noir print(1 +);', b, [], s).lines), [NOT_YET])
  // A line of another command that stops is the visitor's own.
  assert.deepEqual(said(run('r0 nope', b, [], s).lines), said(run('r0 nope', b, []).lines))
})

test('a yes only for the line asked for: nearby lines that print the same shape get nothing', () => {
  const b = inTheCity()
  const s = replSession()
  void run('tutorial 6', b, [], s)
  void run(LESSONS[5]!.tries[0]!.type, b, [], s)
  assert.deepEqual(said(run('noir print(cars.n);', b, [], s).lines), [], 'one number, but no query ran')
  assert.deepEqual(said(run('noir print(42);', b, [], s).lines), [])
  void run(LESSONS[5]!.tries[1]!.type, b, [], s)
  assert.deepEqual(said(run('noir print(cars.n, crowd.n);', b, [], s).lines), [], 'two numbers, but not the fps and the law')
  void run('tutorial 9', b, [], s)
  for (let i = 0; i < 3; i++) void run('tutorial next', b, [], s)
  assert.deepEqual(said(run('noir print(f32x4(1, 2, 3, 4));', b, [], s).lines), [], 'an f32x4, but no load')
  assert.match(said(run(LESSONS[8]!.tries[3]!.type, b, [], s).lines)[0]!, /^yes: load_f32x4/)
})

test('lesson 5 finishes whatever order its words were first taught in; every try that needs an earlier line says so', () => {
  const b = consoleAlone()
  const s = replSession()
  void run('noir fn sign(x: i32) -> i32 { x }', b, [], s)
  void run('tutorial 5', b, [], s)
  const lines = LESSONS[4]!.tries.map((t) => run(t.type, b, [], s).lines)
  assert.match(outs(lines[3]!)[0]!, /\bsign sq$/, 'sign was taught first')
  assert.equal(said(lines[3]!).at(-1), `lesson 5 finished (1 of ${LESSONS.length}); next: tutorial 1, your first line`)
  // A try that cannot pass in a fresh console on its own needs an earlier line, and its hint says so.
  for (const [i, l] of LESSONS.entries()) {
    l.tries.forEach((t, j) => {
      const alone = run(t.type, consoleAlone(), [], replSession()).lines
      if (!passes(t, t.type, alone)) assert.match(t.hint, /It needs the (line before it|first line|lines that)/, `lesson ${i + 1} try ${j + 1}: ${t.type}`)
      else assert.doesNotMatch(t.hint, /It needs/, `lesson ${i + 1} try ${j + 1} stands alone`)
    })
  }
})

test('what the lessons say about the language is what it does', () => {
  const noir = (src: string) => new NoirSession().run(src)
  const alone = consoleAlone()
  // Lesson 2: = never changes a let; a new let makes a new one.
  const s = replSession()
  for (const l of ['noir let apples = 3;', 'noir apples = 4;']) void run(l, alone, [], s)
  assert.deepEqual(outs(run('noir let apples = 4; print(apples);', alone, [], s).lines), ['4'])
  // Lesson 3: names of two kinds never mix (the line never starts, so nothing before the mix prints); a bare 3 beside 1.5 is taken as 3.0.
  assert.deepEqual(noir('print(1); let cats = 3; let cake = 1.5; print(cats + cake);').out, [])
  assert.deepEqual(noir('print(3 + 1.5);').out, ['4.5'])
  // Lesson 5: a fn anywhere on a line, never inside { }; taught again, it is the new one.
  assert.deepEqual(noir('print(1); fn late() -> i32 { 7 } print(late());').out, ['1', '7'])
  assert.match(noir('if true { fn inner() -> i32 { 1 } }').error ?? '', /'fn' is only allowed at the top level/)
  const t = new NoirSession()
  t.run('fn sq(x: i32) -> i32 { x * x }'); t.run('fn sq(x: i32) -> i32 { x + x }')
  assert.deepEqual(t.run('print(sq(4));').out, ['8'])
  // Lesson 6: with no city the tables are empty and their numbers read 0.
  assert.deepEqual(outs(run('noir print(crowd.n, cars.n, kernel.law1, frame.fps);', alone, []).lines), ['0 0 0 0'])
  // Lesson 7: a million steps, then the stop.
  assert.equal(noir('loop { }').error, 'step budget exhausted (1000000)')
  // Lesson 9: one f32x4 sum is one order.
  const vec = outs(run('noir asm print(f32x4(1, 2, 3, 4) + f32x4(10, 20, 30, 40));', alone, []).lines)
  assert.equal(vec.filter((l) => /\bADD_/.test(l)).length, 1)
  assert.match(vec.join('\n'), /\bADD_F32X4\n/)
  // Lesson 10: print(1 + 2) is five orders and costs five steps; 1.5 goes in as its 32 switches; the loop jumps back to its question.
  assert.deepEqual(outs(run('noir asm print(1 + 2);', alone, []).lines).slice(1), ['0000  PUSH 1', '0002  PUSH 2', '0004  ADD_I32', '0006  PRINT 1 i32', '0009  RET 0'])
  assert.equal(noir('print(1 + 2);').steps, 5)
  assert.match(outs(run('noir asm print(1.5 + 2.5);', alone, []).lines)[1]!, new RegExp(`PUSH ${new Uint32Array(Float32Array.of(1.5).buffer)[0]}$`))
  const loop = outs(run('noir asm for i in 0..3 { print(i); }', alone, []).lines)
  const back = loop.map((l) => /^(\d{4}) {2}JMP (\d{4})$/.exec(l)).find(Boolean)!
  assert.ok(Number(back[2]) < Number(back[1]), 'the jump goes back')
  assert.match(loop.find((l) => l.startsWith(`${back[2]}  `))!, /LOAD_LOCAL/, 'to the loop\'s question')
  assert.match(loop.find((l) => /JMP_IF_NOT/.test(l))!, /JMP_IF_NOT/)
  // A list copy costs more than its orders: the walls count steps, not orders.
  assert.ok(noir('let a = [0; 1024]; let c = a;').steps > 5)
})

test('the finished marks as the store keeps them: anything odd reads as none', () => {
  assert.equal(finishedText(new Set([3, 1])), '{"v":1,"finished":[1,3]}')
  assert.deepEqual([...finishedFrom('{"v":1,"finished":[1,3]}')], [1, 3])
  for (const bad of [null, '', 'nope', '{}', '[]', '{"v":2,"finished":[1]}', '{"v":1,"finished":"1"}', `{"v":1,"finished":[${'1,'.repeat(300)}1]}`]) assert.equal(finishedFrom(bad).size, 0, String(bad))
  assert.deepEqual([...finishedFrom('{"v":1,"finished":[0,1,1.5,11,-2,"2",10]}')], [1, 10])
  assert.equal(LESSONS_KEY, 'civic-simulation:lessons:v1')
})

test('the words: ten lessons of three to five lines, five plain W\'s each, the language\'s whole name, nothing banned, nothing that closes the console', () => {
  assert.equal(LESSONS.length, 10)
  const all: string[] = []
  for (const [i, l] of LESSONS.entries()) {
    assert.match(l.title, /^[a-z][a-z ]+$/, `lesson ${i + 1}: a plain lower-case title`)
    assert.equal(l.ws.length, 5)
    for (const w of l.ws) assert.ok(w.length > 10 && w.length <= 150, `lesson ${i + 1}: a short W (${w.length}): ${w}`)
    assert.match(l.ws[4], /^(So|Because) /, `lesson ${i + 1}: why is answered with so or because`)
    assert.ok(l.tries.length >= 3 && l.tries.length <= 5, `lesson ${i + 1}: ${l.tries.length} lines`)
    for (const t of l.tries) {
      assert.ok(t.out || t.like || t.err, `${t.type}: says what it prints`)
      assert.doesNotMatch(t.type, /[~^`]/, `${t.type}: no key that opens or closes the console`)
      assert.ok(t.type.length <= 120, `${t.type}: short enough to type`)
      assert.ok(t.then.length <= 200 && t.hint.length <= 200, t.type)
      all.push(t.type, t.then, t.hint)
    }
    all.push(l.title, ...l.ws)
  }
  const text = all.join('\n')
  assert.match(text, /Crimson Noir Script/)
  // (The licence gate, tools/license/gate.mjs, holds every file to the one shortening policy.json lists; these are the others.)
  assert.doesNotMatch(text, /NoirScript|(?<!Crimson )Noir Script|Crimson Script|CN Script/, 'the language by its whole name only')
  assert.doesNotMatch(text, /[!]|\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage)\b/i)
  // (compliance.test.ts scrubs the brand names it bans from every file; these are the ebook's other ones.)
  assert.doesNotMatch(text, /\b(clang|llvm|python|java|avx2|arm64)\b/i, 'no third-party names')
  assert.doesNotMatch(text, /five whys|why five times/i, 'the five W\'s, not five whys')
  for (const line of all) assert.equal(screen(line).admissible, true, line)
})

test('the host keeps the marks: the city\'s bridge and the console alone each hand the page\'s store over, and the console bridge passes it on', () => {
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  assert.match(app, /^import \{ LESSONS_KEY \} from '\.\/07_Execute_Actions\/terminal\/lessons\.ts'$/m)
  assert.equal(app.match(/lessons: pageStore\(LESSONS_KEY\),/g)?.length, 2, 'the city and the console alone')
  assert.match(app, /return consoleBridge\(\{ \.\.\.BRAND, track: 'tty' \}, \{\n\s+contained: \(\) => airgapInstalled\(globalThis\),\n\s+lessons: pageStore\(LESSONS_KEY\),/)
  const store = memoryStore()
  const deps = { mind: () => Promise.reject(new Error('no mind')), contained: () => true }
  assert.equal(consoleBridge(BRAND, { ...deps, lessons: store }).lessons, store)
  assert.equal(consoleBridge(BRAND, deps).lessons, undefined)
  assert.equal(offlineBridge(BRAND).lessons, undefined)
})
