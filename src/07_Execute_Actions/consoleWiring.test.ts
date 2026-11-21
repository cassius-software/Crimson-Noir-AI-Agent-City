// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the terminal (terminal/Terminal.tsx) and the page (App.tsx) carry the console's
 * operating layer, which Node cannot render: a closed console holds what is printed instead of rendering it; Tab lists
 * a bounded row; only a result that draws live or clears ends a live view; a secret is dotted in the history however
 * the shell was handed it; Ctrl+D on a line with text deletes forward, a whole character; the disk is saved, and
 * answered, before the page goes (a boot, a map, 'Back to the city', waiting once), waits longer for a large disk or one
 * slow to image, and is sealed by the browser's own digest unless it does not answer.
 * Source-level, as the other wiring tests are; the layer's own side of each is held by terminal/oslayer.test.ts.
 * What breaks if it is removed? A job printing to a hidden console could slow the city again, a typed key could stay
 * in the history, or the last change before leaving the page could be lost without a word.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OPEN_MS } from './consoleDisk.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const TERM = read('./terminal/Terminal.tsx')
const APP = read('../App.tsx')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing ${from}`)
  const b = src.indexOf(to, a)
  assert.ok(b > a, `missing ${to} after ${from}`)
  return src.slice(a, b)
}
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}

test('a windowed console that is closed holds what is printed, newest MAX_ROWS, and shows it when it opens; clear empties what it holds', () => {
  assert.match(TERM, /const held = useRef<Shown\[\]>\(\[\]\)/)
  const append = between(TERM, 'const append = useCallback(', '}, [])')
  assert.match(append, /if \(!openRef\.current && !fullRef\.current\) \{[\s\S]*?held\.current = [\s\S]*?MAX_ROWS[\s\S]*?return\n/, 'held, not rendered')
  before(append, 'held.current = ', 'setRows(', 'held before anything is rendered')
  const opened = between(TERM, '// Open/close side effects', '}, [open, append])')
  before(opened, 'openRef.current = open', 'append(h)', 'shown once append no longer holds it back')
  assert.match(opened, /if \(open && held\.current\.length\) \{\s*const h = held\.current\s*held\.current = \[\]\s*append\(h\)\s*\}/)
  assert.match(between(TERM, 'const apply = (', 'const submit = ('), /if \(r\.clear\) \{\s*held\.current = \[\]\s*setRows\(\[\]\)/)
})

test('Tab lists at most TAB_LIST_MAX names in its row and counts the rest', () => {
  assert.match(TERM, /const TAB_LIST_MAX = 200\n/)
  const tab = between(TERM, "} else if (key === 'Tab') {", "} else if (key === 'PageUp'")
  assert.match(tab, /options\.slice\(0, TAB_LIST_MAX\)\.map\(\(o\) => o\.slice\(o\.lastIndexOf\(' '\) \+ 1\)\)/)
  assert.match(tab, /`\.\.\. and \$\{options\.length - TAB_LIST_MAX\} more`/)
})

test('only a result that draws live or clears ends a live view; the live frame is drawn below the rows, so other lines go above it', () => {
  assert.match(TERM, /if \(first\.length === 0 && \(r\.live \|\| r\.clear\)\) stopLive\(\)/)
  assert.doesNotMatch(TERM, /r\.lines\.length > 0 \|\| r\.live \|\| r\.clear/)
  before(TERM, '<Scrollback rows={rows} prompt={prompt} />', '{live && (', 'the frame in its own block after the scrollback')
})

test('the history dots a secret however the shell was handed it, and a line the console takes whole only at its start', () => {
  assert.match(TERM, /import \{[^}]*\brunsWhole\b[^}]*\bscrubSecrets\b[^}]*\} from '\.\/commands\.ts'/)
  const submit = between(TERM, 'const submit = (raw: string) => {', 'useEffect(() => {')
  assert.match(submit, /const kept = feeding \? '' : redactForHistory\(line, !capturing && runsWhole\(line\)\)/)
  before(submit, 'h.push(kept)', 'scrubHistory()', 'the line just kept is dotted too')
  const scrub = between(TERM, 'const scrubHistory = () => {', '\n  }\n')
  assert.match(scrub, /const secrets = session\.current\?\.os\?\.takeSecrets\(\) \?\? \[\]/)
  assert.match(scrub, /if \(secrets\.length\) scrubSecrets\(history\.current, secrets\)/)
  const follow = between(TERM, 'const follow = () => {', 'const turn = () => {')
  before(follow, 'applyRef.current(r)', 'scrubHistory()', 'after what the layer ran since')
})

test('Ctrl+D with the layer: the end of input on an empty line (not by a held key), the character after the caret (as it shows, a flag or a skin tone whole) or the selection on a line with text', () => {
  const ctrlD = between(TERM, "} else if (chord && (key === 'd' || key === 'D')) {", "} else if (chord && (key === 'l' || key === 'L')) {")
  assert.match(ctrlD, /if \(session\.current\?\.os\) \{\s*e\.preventDefault\(\)[\s\S]*?if \(el\.value === ''\) \{ if \(!e\.repeat\) endInput\(\) \}\s*else \{/)
  assert.match(ctrlD, /const a = el\.selectionStart \?\? 0, b = el\.selectionEnd \?\? a/)
  assert.match(ctrlD, /const pair = \/\^\[\\uD800-\\uDBFF\]\[\\uDC00-\\uDFFF\]\/\.test\(el\.value\.slice\(a, a \+ 2\)\)/)
  assert.match(ctrlD, /const shown = typeof Intl\.Segmenter === 'function' \? new Intl\.Segmenter\(undefined, \{ granularity: 'grapheme' \}\)\.segment\(el\.value\.slice\(a\)\)\.containing\(0\)\?\.segment\.length : undefined/)
  assert.match(ctrlD, /setLine\(el\.value\.slice\(0, a\) \+ el\.value\.slice\(b > a \? b : a \+ \(shown \?\? \(pair \? 2 : 1\)\)\), a\)/)
})

test('the disk is saved and answered before the page goes: a boot, a map, the handle\'s flush and every reload the page starts wait for it, LEAVE_MS at most', () => {
  const leaveMs = /const LEAVE_MS = (\d+)\n/.exec(TERM)
  assert.ok(leaveMs, 'LEAVE_MS')
  assert.equal(Number(leaveMs[1]), OPEN_MS, 'as long as the store itself waits on the browser (consoleDisk.ts OPEN_MS)')
  const leave = between(TERM, 'const leave = (): Promise<void> => {', '\n  }\n')
  assert.match(leave, /if \(saveTimer\.current !== null\) window\.clearTimeout\(saveTimer\.current\)\s*saveTimer\.current = null/)
  assert.match(leave, /saving = os\.save\(\{ now: true \}\)/)
  assert.match(leave, /const gone = window\.setTimeout\(\(\) => \{\s*unanswered\.current = saving\s*resolve\(\)\s*\}, LEAVE_MS\)/)
  // Armed before the save is asked, so it fires before the store's own bound (armed inside the save, with the same wait).
  before(leave, 'const gone = window.setTimeout(', 'saving = os.save({ now: true })', 'the wait is armed before the save')
  assert.match(leave, /saving\.then\(done, done\)/)
  // A boot waits once: its own reload (reboot, Terminal.flushAll) goes at once while the save it gave up on is unanswered.
  before(leave, 'if (unanswered.current !== null) return Promise.resolve()', 'return new Promise<void>((resolve) => {', 'checked before a second wait')
  assert.match(leave, /if \(unanswered\.current === saving\) unanswered\.current = null/)
  const apply = between(TERM, 'const apply = (', 'const submit = (')
  assert.match(apply, /if \(r\.boot \|\| r\.map\) \{[\s\S]*?void leave\(\)\.then\(\(\) => \{\s*if \(r\.boot\) onBoot\?\.\(r\.boot\)\s*if \(r\.map\) onMap\?\.\(r\.map\)\s*\}\)/)
  assert.doesNotMatch(apply, /^\s*if \(r\.map\) onMap\?\.\(r\.map\)\n\s*\}\n$/m, 'no navigation outside the wait')
  assert.match(TERM, /flush\(\): Promise<void>/)
  assert.match(TERM, /flush: \(\) => leaveRef\.current\(\),/)
  assert.match(TERM, /leaveRef\.current = leave\n/)
  assert.match(TERM, /const flush = \(\) => leaveRef\.current\(\)\s*leaving\.add\(flush\)\s*return \(\) => \{ leaving\.delete\(flush\) \}/)
  assert.match(TERM, /Terminal\.flushAll = \(\): Promise<void> => Promise\.all\(\[\.\.\.leaving\]\.map\(\(flush\) => flush\(\)\)\)\.then\(\(\) => \{\}\)/)
  // 'Back to the city' and the cards' way to the console call reboot straight from a click: it waits for the save too.
  const reboot = between(APP, 'function reboot(track: BootTrack): void {', '\n}\n')
  assert.match(reboot, /void Terminal\.flushAll\(\)\.then\(\(\) => window\.location\.assign\(url\.toString\(\)\)\)/)
  assert.equal(reboot.match(/window\.location\.assign/g)?.length, 1, 'never before the save')
  assert.match(between(APP, 'function TtyShell({ vram }: { vram: string | null }) {', 'function App() {'), /onClick=\{\(\) => reboot\('gui'\)\}/)
})

test('a save asked for as the page is hidden or goes is sealed at once; a timed one waits longer for a large disk; the seal comes from the browser\'s own digest', () => {
  const save = between(TERM, 'const saveDisk = (os: OsSession, soon: boolean) => {', 'const follow = () => {')
  before(save, 'if (!soon) { void os.save({ now: true }); return }', 'if (!os.unsavedChanges) return', 'a save waiting for its seal is taken over even with nothing new')
  assert.match(save, /const mib = os\.system\.diskUsed \/ MIB/)
  assert.match(save, /const bySize = mib < 1 \? SAVE_MS : Math\.min\(SAVE_MAX_MS, SAVE_MS \* mib\)/)
  // A disk of many small files: spaced by what its last image took to make, so saving takes a fiftieth of the page's time.
  assert.match(save, /\}, Math\.max\(bySize, Math\.min\(SAVE_MAX_MS, os\.saveCost \* SAVE_SPACING\)\)\)/)
  assert.match(TERM, /const SAVE_MS = 1500\n/)
  assert.match(TERM, /const SAVE_MAX_MS = 10_000\n/)
  assert.match(TERM, /const SAVE_SPACING = 50\n/)
  assert.match(TERM, /const MIB = 1024 \* 1024\n/)
  assert.match(TERM, /const flushRef = useRef\(\(\) => \{\s*const os = session\.current\?\.os\s*if \(os\) saveDisk\(os, false\)\s*\}\)/)
  // As the page starts to go (beforeunload), while it can still write, but only while something is unsaved or on its way.
  const follow = between(TERM, 'const follow = () => {', 'const turn = () => {')
  assert.match(follow, /if \(os\.unsavedChanges \|\| os\.saveOnItsWay\) window\.addEventListener\('beforeunload', flushRef\.current\)\s*else window\.removeEventListener\('beforeunload', flushRef\.current\)/)
  assert.match(TERM, /window\.removeEventListener\('beforeunload', flush\)/)
  assert.match(TERM, /const SUBTLE: SubtleCrypto \| undefined = globalThis\.crypto\?\.subtle/)
  const host = between(TERM, 'const sessionOf = (): ReplSession => (session.current ??= replSession({', '}))')
  assert.match(host, /\.\.\.\(SUBTLE \? \{ digest: \(bytes: Uint8Array\) => bounded\(SUBTLE\.digest\('SHA-256', bytes as Uint8Array<ArrayBuffer>\)\.then\(\(d\) => new Uint8Array\(d\)\), SEAL_MS\) \} : \{\}\),/)
  // A digest that never answers is given up on, and the layer seals the image itself.
  assert.match(TERM, /const SEAL_MS = (\d+)\n/)
  assert.equal(Number(/const SEAL_MS = (\d+)\n/.exec(TERM)?.[1]), OPEN_MS)
  const bound = between(TERM, 'function bounded<T>(p: Promise<T>, ms: number): Promise<T> {', '\n}\n')
  assert.match(bound, /const late = window\.setTimeout\(\(\) => reject\(new Error\('the browser did not answer'\)\), ms\)/)
  assert.match(bound, /p\.then\(\(value\) => \{ window\.clearTimeout\(late\); resolve\(value\) \}, \(e: unknown\) => \{ window\.clearTimeout\(late\); reject\(e\) \}\)/)
})

test('an answer the layer waited for gets a turn of its own (a task), never one inside the promise that brought it', () => {
  const follow = between(TERM, 'const follow = () => {', 'const turn = () => {')
  // Answers that come as promises already settled would otherwise chain turns with no end, and the page would never
  // draw or read Ctrl+C.
  assert.match(follow, /os\.wake \?\?= \(\) => \{\s*if \(osTimer\.current !== null\) window\.clearTimeout\(osTimer\.current\)\s*osTimer\.current = window\.setTimeout\(\(\) => \{\s*osTimer\.current = null\s*if \(mounted\.current\) turn\(\)\s*\}, 0\)\s*\}/)
  assert.doesNotMatch(follow, /os\.wake \?\?= \(\) => \{ if \(mounted\.current\) turn\(\) \}/)
})
