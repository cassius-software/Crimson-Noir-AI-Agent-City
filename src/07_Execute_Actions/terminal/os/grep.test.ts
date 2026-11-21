// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests grep (grep.ts) the way a person meets it: typed at the real shell of a system
 * held in memory, with what it prints, the bytes it writes and the status it ends with all checked. Every option is
 * used, alone and with the ones it changes, and so are the ways a search is refused or cut short: a pattern that is
 * not well formed, a file that is not there among files that are, a directory without -r, a file that is binary,
 * input with no line end at its end, no input at all, lines longer than one read and longer than the longest line,
 * patterns that would stall a matcher that tries one path at a time, searches so long they must be cut into turns of
 * the kernel and stopped by Ctrl+C, an output that takes nothing, and a reader that takes one line of a large answer
 * and leaves.
 * What breaks if it is removed? A change to grep could alter what a script depends on (which lines are selected,
 * the text of a count or a file name, an exit status, the words of a refusal) and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode } from './bytes.ts'
import { ROOT_CRED } from './fs.ts'
import { GREP_MANUAL, GREP_PROGRAMS } from './grep.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'
import { compile } from './regex.ts'
import { now } from './task.ts'

const FRUIT = 'apple\nbanana\ncherry\napricot\n'
const NUMBERS = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n'
const WORDS = 'foo\nfoobar\nbarfoo\nfoo_x\nfoo-bar\nsay foo.\nfo\n'

/** A system with grep, its shell working in /tmp, holding a few files to search; `tmpBytes` sizes /tmp. */
function fresh(tmpBytes?: number): Kit {
  const k = boot(GREP_PROGRAMS, tmpBytes === undefined ? {} : { tmpBytes })
  assert.deepEqual(k.sh('cd /tmp'), [])
  k.write('/tmp/f', FRUIT)
  k.write('/tmp/n', NUMBERS)
  k.write('/tmp/w', WORDS)
  k.write('/tmp/none', 'nothing here\n')
  k.write('/tmp/empty', '')
  return k
}

/** Makes a directory straight in the file system (mkdir is not grep's to test with). */
function mkdir(k: Kit, path: string): void {
  now(k.system.kernel.vfs.mkdir(path, '/', ROOT_CRED, 0o755))
}

/**
 * What a command printed, without the remark the shell itself adds when a program of a pipeline was ended by a
 * reader that left (`<shell>: <program>: broken pipe`): that line is the shell's, not grep's.
 */
const own = (lines: readonly string[]): string[] => lines.filter((l) => !/^![^ :]+: [^ :]+: broken pipe$/.test(l))

/** The bytes a command wrote to its ordinary output, through a file; nothing else may have been printed. */
function bytesOf(k: Kit, command: string): Uint8Array {
  assert.deepEqual(k.sh(`${command} > /tmp/.out`), [], command)
  return k.bytes('/tmp/.out')
}

const textOf = (k: Kit, command: string): string => decode(bytesOf(k, command))

/** The two usage lines of the manual page, as a wrong call prints them. */
function usageLines(): string[] {
  const lines = GREP_MANUAL.grep.split('\n')
  const at = lines.indexOf('USAGE')
  return [`!usage: ${lines[at + 1].trim()}`, `!       ${lines[at + 2].trim()}`]
}

// The manual

test('manual: one page, in the one shape, plain and narrow, saying what the syntax treats as special', () => {
  assert.deepEqual(Object.keys(GREP_PROGRAMS), ['grep'])
  assert.deepEqual(Object.keys(GREP_MANUAL), ['grep'])
  assert.ok(Object.isFrozen(GREP_PROGRAMS) && Object.isFrozen(GREP_MANUAL))
  const page = GREP_MANUAL.grep
  assert.ok(page.endsWith('\n') && !page.endsWith('\n\n') && !page.startsWith('\n'))
  const lines = page.split('\n')
  assert.equal(lines[0], 'NAME')
  assert.match(lines[1], /^ {4}grep - [a-z][^.]*$/)
  assert.equal(lines[2], '')
  assert.equal(lines[3], 'USAGE')
  assert.ok(lines[4].startsWith('    grep ') && lines[5].startsWith('    grep '))
  assert.equal(lines[6], '')
  const order = ['NAME', 'USAGE', 'WHAT IT DOES', 'OPTIONS', 'NOTES', 'STATUS', 'EXAMPLE']
  const heads: string[] = []
  for (const [i, line] of lines.entries()) {
    assert.ok(line.length <= 78, `${i + 1}: ${line.length} columns`)
    assert.match(line, /^[\x20-\x7e]*$/, `${i + 1}`)
    assert.ok(!line.endsWith(' '), `${i + 1}: a blank at the end`)
    if (line === '' || line.startsWith('    ')) continue
    assert.ok(order.includes(line), `${i + 1}: ${line}`)
    assert.equal(lines[i - 1] ?? '', '', `${i + 1}: a heading follows an empty line`)
    heads.push(line)
  }
  assert.deepEqual(heads, order)
  assert.ok(lines[lines.indexOf('EXAMPLE') + 1].includes('grep'))
  assert.doesNotMatch(page, /https?:|www\./)
  assert.ok(page.includes('( ) { } + ? | are special without a backslash'))
  const options = ['-e P', '-E ', '-F ', '-i ', '-w ', '-x ', '-v ', '-c ', '-l ', '-L ', '-q ', '-m N', '-o ', '-n ', '-H ', '-h ', '-r ', '-s ']
  options.push('-A N', '-B N', '-C N')
  for (const option of options) assert.ok(page.includes(`\n    ${option}`), option)
})

test('manual: the usage a wrong call prints is the one in the page, and the status is 2', () => {
  const k = fresh()
  const usage = usageLines()
  assert.deepEqual(k.sh('grep -z apple f; echo $?'), ["!grep: unknown option '-z'", ...usage, '2'])
  assert.deepEqual(k.sh('grep --color apple f; echo $?'), ["!grep: unknown option '--color'", ...usage, '2'])
  assert.deepEqual(k.sh('grep; echo $?'), [...usage, '2'])
  assert.deepEqual(k.sh('grep -e; echo $?'), ["!grep: option '-e' needs a value", ...usage, '2'])
  assert.deepEqual(k.sh('grep apple f -C; echo $?'), ['f:apple', '!grep: -C: no such file or directory', '2'])
  assert.deepEqual(k.sh('grep -n -C; echo $?'), ["!grep: option '-C' needs a value", ...usage, '2'])
  assert.deepEqual(k.sh('grep -m x apple f; echo $?'), ["!grep: option '-m' needs a whole number, not 'x'", ...usage, '2'])
  assert.deepEqual(k.sh('grep -A -1 apple f; echo $?'), ["!grep: option '-A' needs a whole number, not '-1'", ...usage, '2'])
  assert.deepEqual(k.sh('grep -B1.5 apple f; echo $?'), ["!grep: option '-B' needs a whole number, not '1.5'", ...usage, '2'])
  assert.deepEqual(k.sh(`grep -C ${'9'.repeat(50)}x apple f; echo $?`), [`!grep: option '-C' needs a whole number, not '${'9'.repeat(40)}...'`, ...usage, '2'])
})

test('grep -m, -A, -B, -C: a whole number too large to hold is no limit, not a wrong call', () => {
  const k = fresh()
  const huge = '9'.repeat(50)
  assert.deepEqual(k.sh(`grep -m ${huge} ap f; echo $?`), ['apple', 'apricot', '0'])
  assert.deepEqual(k.sh(`grep -A ${huge} cherry f; grep -B ${huge} banana f; grep -c -C ${huge} an f`), ['cherry', 'apricot', 'apple', 'banana', '1'])
})

// Selecting lines

test('grep: the lines a pattern is found in, the status saying whether there were any', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep an f; echo $?'), ['banana', '0'])
  assert.deepEqual(k.sh('grep ap f'), ['apple', 'apricot'])
  assert.deepEqual(k.sh('grep zz f; echo $?'), ['1'])
  assert.deepEqual(k.sh('grep x empty; echo $?'), ['1'])
  // An empty pattern is found in every line, the empty one too.
  assert.deepEqual(k.sh("grep '' f"), ['apple', 'banana', 'cherry', 'apricot'])
  k.write('/tmp/blank', 'a\n\nb\n')
  assert.equal(textOf(k, "grep '' blank"), 'a\n\nb\n')
  assert.deepEqual(k.sh("grep -c '' blank; grep -c '^$' blank"), ['3', '1'])
  // With no file, or for -, the input is read; the name it goes by is (standard input).
  assert.deepEqual(k.sh('grep an < f; grep an - < f'), ['banana', 'banana'])
  assert.deepEqual(k.sh('echo -e "x\\nyes\\nz" | grep y'), ['yes'])
  assert.deepEqual(k.sh('grep -H an < f; grep an f - < f'), ['(standard input):banana', 'f:banana', '(standard input):banana'])
  // Options end at the first word that is no option, or at --; -e takes a pattern that begins with a dash.
  k.write('/tmp/dash', 'a-v\nb\n')
  assert.deepEqual(k.sh('grep -e -v dash; grep -- -v dash; grep -e-v dash'), ['a-v', 'a-v', 'a-v'])
  assert.deepEqual(k.sh('grep b dash -v; echo $?'), ['dash:b', '!grep: -v: no such file or directory', '2'])
})

test('grep: the last line needs no line end, and is printed with one', () => {
  const k = fresh()
  k.write('/tmp/nofinal', 'a\nb')
  assert.equal(textOf(k, 'grep b nofinal'), 'b\n')
  assert.equal(textOf(k, 'grep -v x nofinal'), 'a\nb\n')
  assert.deepEqual(k.sh("grep -c '' nofinal"), ['2'])
  // A carriage return before a line end is part of the line, and goes out as it came.
  k.write('/tmp/crlf', 'one\r\ntwo\r\n')
  assert.equal(textOf(k, 'grep two crlf'), 'two\r\n')
  assert.deepEqual(k.sh("grep -c 'one$' crlf"), ['0'])
  // \r in a pattern is a carriage return, so such a line can be matched to its end; with -F it is two characters.
  k.write('/tmp/mixed', 'one\r\ntwo\nthr\ree\n')
  assert.deepEqual(k.sh("grep -c 'one\\r$' mixed; grep -c '\\r' mixed; grep -c -v '\\r' mixed"), ['1', '2', '1'])
  assert.equal(textOf(k, "grep -n '\\r$' mixed"), '1:one\r\n')
  assert.equal(textOf(k, "grep -o 'r\\re' mixed"), 'r\re\n')
  assert.deepEqual(k.sh("grep -c '[\\r]e' mixed; grep -c -F '\\r' mixed; grep -c -x 'two\\r?' mixed; grep -c -w 'one\\r' mixed"), ['1', '0', '1', '1'])
})

test('grep: patterns are the extended kind; -E changes nothing', () => {
  const k = fresh()
  assert.deepEqual(k.sh("grep 'ch|ban' f; grep -E 'ch|ban' f"), ['banana', 'cherry', 'banana', 'cherry'])
  assert.deepEqual(k.sh("grep 'b(an)+a$' f; grep 'p{2}' f; grep -E 'p{2}' f"), ['banana', 'apple', 'apple'])
  assert.deepEqual(k.sh("grep '^a' f; grep 'y$' f; grep 'p+l' f; grep 'x?ch' f"), ['apple', 'apricot', 'cherry', 'apple', 'cherry'])
  assert.deepEqual(k.sh("grep '\\<ban' f; grep 'ana\\>' f; grep '\\<an' f; echo $?"), ['banana', 'banana', '1'])
  assert.deepEqual(k.sh("grep '[[:digit:]]' n; grep 'e[nv]' n"), ['seven', 'ten'])
  k.write('/tmp/dots', 'a.p\naxp\na{\n(x\n')
  assert.deepEqual(k.sh("grep 'a.p' dots; grep 'a\\.p' dots"), ['a.p', 'axp', 'a.p'])
  // A brace that begins no count is itself; a backslash makes a special character plain.
  assert.deepEqual(k.sh("grep 'a{' dots; grep '\\(x' dots; grep '\\{' dots"), ['a{', '(x', 'a{'])
})

test('grep: a pattern that is not well formed is refused with the reason, status 2, before any file is read', () => {
  const k = fresh()
  assert.deepEqual(k.sh("grep '(' f; echo $?"), ['!grep: unmatched ( in pattern', '2'])
  assert.deepEqual(k.sh("grep 'a)' f; echo $?"), ['!grep: unmatched ) in pattern', '2'])
  assert.deepEqual(k.sh("grep '*a' f; echo $?"), ['!grep: nothing to repeat before *', '2'])
  assert.deepEqual(k.sh("grep '(a)\\1' f; echo $?"), ['!grep: back-references are not supported', '2'])
  assert.deepEqual(k.sh("grep '[z-a]' f; echo $?"), ['!grep: range out of order: z-a', '2'])
  assert.deepEqual(k.sh("grep -e apple -e '[' f; echo $?"), ['!grep: unmatched [ in pattern', '2'])
  // -s quiets only what is said about files; the file named is never opened.
  assert.deepEqual(k.sh("grep -s '(' nosuch; echo $?"), ['!grep: unmatched ( in pattern', '2'])
  // With -w and -x the pattern is judged on its own first, so a pattern that is not well formed cannot pass for one
  // by closing the group it is set in.
  assert.deepEqual(k.sh("grep -x 'a)|(b' f; echo $?"), ['!grep: unmatched ) in pattern', '2'])
  assert.deepEqual(k.sh("grep -w 'x)(' f; echo $?"), ['!grep: unmatched ) in pattern', '2'])
  assert.deepEqual(k.sh(`grep ${'a'.repeat(4097)} f; echo $?`), ['!grep: pattern too long: more than 4096 characters', '2'])
})

test('grep: several patterns, by -e or by line feeds, select a line when any one is found', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -e cherry -e apple f'), ['apple', 'cherry'])
  assert.deepEqual(k.sh('p=$(echo -e "cherry\\nbanana"); grep "$p" f'), ['banana', 'cherry'])
  assert.deepEqual(k.sh('p=$(echo -e "cherry\\nbanana"); grep -c -e "$p" -e apple f'), ['3'])
  // With -e every word after the options is a file.
  assert.deepEqual(k.sh('grep -e apple f f'), ['f:apple', 'f:apple'])
  assert.deepEqual(k.sh("grep -c -e '' f; grep -e zz -e yy f; echo $?"), ['4', '1'])
  assert.deepEqual(k.sh('p=$(echo -e "a.p\\nrr"); grep -F "$p" f'), ['cherry'])
})

test('grep -i, -v, -n, -c: either case, the other lines, line numbers, counts', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -i APPLE f; grep -i "[A-C]H" f'), ['apple', 'cherry'])
  assert.deepEqual(k.sh('grep -v a f; grep -v -i A f; echo $?'), ['cherry', 'cherry', '0'])
  assert.deepEqual(k.sh("grep -v '' f; echo $?"), ['1'])
  assert.deepEqual(k.sh('grep -n an f; grep -n -v e n'), ['2:banana', '2:two', '4:four', '6:six'])
  assert.deepEqual(k.sh('grep -c a f; grep -c -v a f; grep -c zz f; echo $?'), ['3', '1', '0', '1'])
  assert.deepEqual(k.sh('grep -c a f none; grep -c -h a f none'), ['f:3', 'none:0', '3', '0'])
  assert.deepEqual(k.sh('grep -c x empty; grep -c an - < f'), ['0', '1'])
  // -c wins over -n and -o.
  assert.deepEqual(k.sh('grep -c -n -o a f'), ['3'])
})

test('grep -l, -L: the names of files with a selected line, or without one; the last given counts', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -l an f none n; echo $?'), ['f', '0'])
  assert.deepEqual(k.sh('grep -L an f none n; echo $?'), ['none', 'n', '0'])
  assert.deepEqual(k.sh('grep -l zz f none; echo $?'), ['1'])
  // The status still says whether any line was selected.
  assert.deepEqual(k.sh('grep -L zz f; echo $?'), ['f', '1'])
  assert.deepEqual(k.sh('grep -l -L an f none; grep -L -l an f none'), ['none', 'f'])
  assert.deepEqual(k.sh('grep -l an - < f; grep -L x empty'), ['(standard input)', 'empty'])
  // -l wins over -c and -n; -v selects the lines that do not match.
  assert.deepEqual(k.sh('grep -l -c -n an f none; grep -l -v apple f; grep -L -v xyz f none'), ['f', 'f'])
  // A file is read only as far as its first selected line: an endless one ends.
  assert.deepEqual(k.sh('grep -l "" /dev/zero'), ['/dev/zero'])
})

test('grep -q: nothing printed; it stops at the first selected line, and that is success even after a failed file', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -q an f; echo $?; grep -q zz f; echo $?'), ['0', '1'])
  assert.deepEqual(k.sh('grep -q an f nosuch; echo $?'), ['0'])
  assert.deepEqual(k.sh('grep -q an nosuch f; echo $?'), ['!grep: nosuch: no such file or directory', '0'])
  assert.deepEqual(k.sh('grep -q zz f nosuch; echo $?'), ['!grep: nosuch: no such file or directory', '2'])
  assert.deepEqual(k.sh('grep -q -s zz nosuch; echo $?'), ['2'])
  // -q wins over -l, -c and -o; and an endless input ends at its first line.
  assert.deepEqual(k.sh('grep -q -l -c -o an f; echo $?; grep -q "" /dev/zero; echo $?'), ['0', '0'])
  assert.deepEqual(k.sh('if grep -q cherry f; then echo yes; fi'), ['yes'])
})

test('grep -m: stop after N selected lines', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -m 1 a f; grep -m 2 -c a f; grep -m 1 -v a f'), ['apple', '2', 'cherry'])
  assert.deepEqual(k.sh('grep -m 0 a f; echo $?; grep -m 0 -c a f'), ['1', '0'])
  assert.deepEqual(k.sh('grep -m1 a f f'), ['f:apple', 'f:apple'])
  assert.deepEqual(k.sh('grep -m 5 -n a f'), ['1:apple', '2:banana', '4:apricot'])
  // The lines after the last selected one are still printed as its context, even one that matches.
  assert.deepEqual(k.sh('grep -m 1 -n -A 2 -e two -e three n'), ['2:two', '3-three', '4-four'])
  assert.deepEqual(k.sh('grep -m 1 -A 5 nine n'), ['nine', 'ten'])
  // An endless input ends once enough lines were selected.
  assert.deepEqual(k.sh('grep -m 2 -c "" /dev/zero'), ['2'])
})

test('grep -o: only the matching parts, each on a line of its own; empty ones are left out', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -o an f'), ['an', 'an'])
  assert.deepEqual(k.sh("grep -o -n 'a.' f"), ['1:ap', '2:an', '2:an', '4:ap'])
  assert.deepEqual(k.sh('grep -o -H -n an f'), ['f:2:an', 'f:2:an'])
  assert.deepEqual(k.sh('grep -o -i AN f; grep -o -F -i AN f'), ['an', 'an', 'an', 'an'])
  k.write('/tmp/bs', 'abbcb\nxyz\n')
  assert.deepEqual(k.sh("grep -o 'b*' bs; echo $?; grep -c 'b*' bs"), ['bb', 'b', '0', '2'])
  // With -v nothing is printed (no part of a line that does not match matches); the status still counts.
  assert.deepEqual(k.sh('grep -o -v an f; echo $?'), ['0'])
  // Of several patterns found at the same place, the longest; the search goes on after it.
  assert.deepEqual(k.sh('grep -o -e an -e ana f; grep -o -e a -e pp f'), ['ana', 'a', 'pp', 'a', 'a', 'a', 'a'])
  // Characters outside the first plane are one character each, and a part with none never splits one.
  k.write('/tmp/wide', '\u{1F600}x\u{1F600}\ncafé\n')
  assert.equal(textOf(k, "grep -o 'x*' wide"), 'x\n')
  assert.equal(textOf(k, "grep -o '.' wide"), '\u{1F600}\nx\n\u{1F600}\nc\na\nf\né\n')
  assert.equal(textOf(k, "grep -o 'f.$' wide"), 'fé\n')
  // Context does nothing with -o.
  assert.deepEqual(k.sh('grep -o -C 1 five n'), ['five'])
})

test('grep -w, -x: whole words, whole lines', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -w foo w'), ['foo', 'foo-bar', 'say foo.'])
  assert.deepEqual(k.sh("grep -w -o 'fo*' w"), ['foo', 'foo', 'foo', 'fo'])
  // A match that ends inside a word gives way to a shorter one from the same place that does not.
  k.write('/tmp/short', 'xa bc1\nfoox fo\n')
  assert.deepEqual(k.sh("grep -o -w 'x[a-z ]*' short; grep -o -w 'fo*' short"), ['xa', 'fo'])
  assert.deepEqual(k.sh("grep -w 'foo.' w; grep -c -w '[a-z]+' w"), ['say foo.', '6'])
  assert.deepEqual(k.sh('grep -w zoo w; echo $?'), ['1'])
  assert.deepEqual(k.sh('grep -x foo w; grep -x "fo|foo" w; grep -x "f.*" w'), ['foo', 'foo', 'fo', 'foo', 'foobar', 'foo_x', 'foo-bar', 'fo'])
  assert.deepEqual(k.sh('grep -x -o "s.*" w; grep -n -x "fo" w'), ['say foo.', '7:fo'])
  // -x wins over -w: foo-bar has foo as a word, but is not foo.
  assert.deepEqual(k.sh('grep -x -w foo w'), ['foo'])
  // Words know the letters and digits of ASCII only: an accented letter is no part of one.
  k.write('/tmp/accent', 'café\n')
  assert.deepEqual(k.sh('grep -c -w caf accent'), ['1'])
  assert.deepEqual(k.sh('grep -i -w FOO w'), ['foo', 'foo-bar', 'say foo.'])
  // With -i the three letters that fold into ASCII are letters of a word, with -F as without it.
  k.write('/tmp/folds', 'fooſ\nfooK\nfooı\nfoo\n')
  assert.deepEqual(k.sh('grep -c -w -i foo folds; grep -c -F -w -i foo folds; grep -c -w foo folds; grep -c -F -w foo folds'), ['1', '1', '4', '4'])
})

test('grep -F: the pattern is plain text', () => {
  const k = fresh()
  k.write('/tmp/dots', 'a.p\naxp\n(x\n[y]\n')
  assert.deepEqual(k.sh("grep -F 'a.p' dots; grep -F '(' dots; grep -F '[y]' dots"), ['a.p', '(x', '[y]'])
  assert.deepEqual(k.sh("grep -F '' dots | grep -c ''"), ['4'])
  assert.deepEqual(k.sh('grep -F -w foo w'), ['foo', 'foo-bar', 'say foo.'])
  assert.deepEqual(k.sh("grep -F -w 'foo.' w; grep -F -w -i SAY w"), ['say foo.', 'say foo.'])
  // A place that is no whole word gives way to a later one on the same line.
  k.write('/tmp/twice', 'xfoo foo\nfoox\n')
  assert.deepEqual(k.sh('grep -F -w -o foo twice; grep -F -w -c foo twice'), ['foo', '1'])
  assert.deepEqual(k.sh("grep -F -x 'say foo.' w; grep -F -x 'say foo' w; echo $?"), ['say foo.', '1'])
  assert.deepEqual(k.sh("grep -F -x -i 'SAY FOO.' w; grep -F -x -o fo w"), ['say foo.', 'fo'])
  // With -i, letters past ASCII fold as the engine folds them (the Kelvin sign is a k), and offsets stay right.
  k.write('/tmp/fold', 'ÉCOLE-école écoles\nthe King\n')
  assert.deepEqual(k.sh("grep -F -w -i -o 'école' fold; grep -F -w -i -n king fold; grep -F -i -o KING fold"), ['ÉCOLE', 'école', '2:the King', 'King'])
  k.write('/tmp/nul', '\n\nx\n')
  assert.deepEqual(k.sh("grep -F -x -c '' nul; grep -x -c '' nul"), ['2', '2'])
  // A long line is folded a piece at a time, and a character of two units on the border of two pieces stays whole.
  k.write('/tmp/border', `${'x'.repeat(16382)} \u{10400} \u{10400}\u{10400}x \u{10400}\n`)
  assert.equal(textOf(k, "grep -F -w -i -o '\u{10428}' border"), '\u{10400}\n'.repeat(3))
  assert.equal(textOf(k, "grep -F -i -o '\u{10428}' border"), '\u{10400}\n'.repeat(4))
})

test('grep -H, -h: file names before lines; the default is names for more than one file or -r', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -H apple f; grep -h apple f f'), ['f:apple', 'apple', 'apple'])
  assert.deepEqual(k.sh('grep -H -h apple f; grep -h -H apple f'), ['apple', 'f:apple'])
  assert.deepEqual(k.sh('grep apple f none'), ['f:apple'])
})

// Context

test('grep -A, -B, -C: lines around the selected ones, with - for context and -- between groups', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -A 1 -e four -e eight n'), ['four', 'five', '--', 'eight', 'nine'])
  assert.deepEqual(k.sh('grep -B 2 six n; grep -B 3 two n'), ['four', 'five', 'six', 'one', 'two'])
  // Groups that touch or overlap are one group.
  assert.deepEqual(k.sh('grep -C 1 -e three -e five n'), ['two', 'three', 'four', 'five', 'six'])
  assert.deepEqual(k.sh('grep -A 1 -e three -e four n'), ['three', 'four', 'five'])
  assert.deepEqual(k.sh('grep -n -C 1 -e two -e nine n'), ['1-one', '2:two', '3-three', '--', '8-eight', '9:nine', '10-ten'])
  assert.deepEqual(k.sh('grep -H -n -B 1 two n'), ['n-1-one', 'n:2:two'])
  // Each file's groups are set apart from the last file's.
  assert.deepEqual(k.sh('grep -A 1 one n n'), ['n:one', 'n-two', '--', 'n:one', 'n-two'])
  // -A and -B win over -C, whichever comes first.
  assert.deepEqual(k.sh('grep -C 2 -A 0 five n; grep -B 0 -C 1 five n'), ['three', 'four', 'five', 'five', 'six'])
  assert.deepEqual(k.sh('grep -A 5 nine n; grep -B 1000000 two n'), ['nine', 'ten', 'one', 'two'])
  assert.deepEqual(k.sh('grep -C 0 -e two -e four n'), ['two', 'four'])
  // With -v the selected lines are the ones that do not match, and the context is the ones that do.
  assert.deepEqual(k.sh('grep -v -n -A 1 e n'), ['2:two', '3-three', '4:four', '5-five', '6:six', '7-seven'])
  // Context does nothing for -c, -l and -q.
  assert.deepEqual(k.sh('grep -c -C 2 five n; grep -l -C 2 five n'), ['1', 'n'])
})

// Binary files and bytes that are no text

test('grep: a file with a NUL among its first 8192 bytes is reported as binary instead of printed', () => {
  const k = fresh()
  k.write('/tmp/bin', Uint8Array.of(97, 0, 98, 10, 99, 10, 99, 10))
  assert.deepEqual(k.sh('grep c bin; echo $?'), ['Binary file bin matches', '0'])
  assert.deepEqual(k.sh('grep -n -H -o c bin; grep -C 1 c bin'), ['Binary file bin matches', 'Binary file bin matches'])
  assert.deepEqual(k.sh('grep -c c bin; grep -l c bin; grep z bin; echo $?'), ['2', 'bin', '1'])
  assert.deepEqual(k.sh('grep c - < bin; grep c bin f; grep -q c bin; echo $?'),
    ['Binary file (standard input) matches', 'Binary file bin matches', 'f:cherry', 'f:apricot', '0'])
  assert.deepEqual(k.sh('grep -v zz bin f | grep -c ""'), ['5'])
  // The 8192nd byte is the last one looked at.
  k.write('/tmp/edge1', `${'a'.repeat(8191)}\0\nmatch\n`)
  k.write('/tmp/edge2', `${'a'.repeat(8192)}\0\nmatch\n`)
  assert.deepEqual(k.sh('grep match edge1 edge2'), ['Binary file edge1 matches', 'edge2:match'])
  // A NUL further on is a byte like any other; it goes out as it came.
  k.write('/tmp/late', `match\n${'y'.repeat(8200)}\n\0z\n`)
  assert.deepEqual(k.sh('grep match late'), ['match'])
  assert.deepEqual([...bytesOf(k, 'grep z late')], [0, 122, 10])
})

test('grep: bytes that are not UTF-8 pass through unchanged', () => {
  const k = fresh()
  k.write('/tmp/raw', Uint8Array.of(0xff, 0xfe, 0x41, 10, 0x63, 0x61, 0x66, 0xe9, 10, 0x7a, 10))
  assert.deepEqual([...bytesOf(k, 'grep A raw')], [0xff, 0xfe, 0x41, 10])
  assert.deepEqual([...bytesOf(k, 'grep caf raw')], [0x63, 0x61, 0x66, 0xe9, 10])
  assert.deepEqual([...bytesOf(k, 'grep -v z raw')], [0xff, 0xfe, 0x41, 10, 0x63, 0x61, 0x66, 0xe9, 10])
  k.write('/tmp/utf', 'naïve 日本\n')
  assert.equal(textOf(k, 'grep -o "日." utf'), '日本\n')
  assert.equal(textOf(k, 'grep -i "NAÏVE" utf'), 'naïve 日本\n')
})

// Long lines and large inputs

test('grep: a line longer than one read is one line; a line past 1 MiB is taken in pieces', () => {
  const k = fresh(16 << 20)
  const long = `${'x'.repeat(300000)}needle${'y'.repeat(300000)}`
  k.write('/tmp/long', `${long}\nshort\n`)
  assert.equal(textOf(k, 'grep needle long'), `${long}\n`)
  assert.deepEqual(k.sh("grep -c '' long; grep -o needle long; grep -n short long"), ['2', 'needle', '2:short'])
  const piece = 1 << 20
  k.write('/tmp/exact', `${'q'.repeat(piece)}\nq\n`)
  assert.deepEqual(k.sh('grep -c q exact'), ['2'])
  k.write('/tmp/huge', 'z'.repeat(2 * piece + 10))
  assert.deepEqual(k.sh("grep -c z huge; grep -c '^z{10}$' huge"), ['3', '1'])
  assert.equal(bytesOf(k, 'grep z huge').length, 2 * piece + 10 + 3)
})

test('grep: a reader that leaves ends it quickly; the system is at rest afterwards', () => {
  const k = fresh()
  let text = ''
  for (let i = 1; i <= 100000; i++) text += `line ${String(i).padStart(6, '0')}\n`
  k.write('/tmp/many', text)
  assert.deepEqual(own(k.sh('grep line many | grep -m 1 line')), ['line 000001'])
  assert.deepEqual(own(k.sh('grep -v nothing many | grep -q 99; echo $?')), ['0'])
  assert.deepEqual(own(k.sh('grep -c line many; grep -n "e 050000$" many')), ['100000', '50000:line 050000'])
  // The lines kept back for -B are let go as they fall out of reach, over many more lines than are kept.
  assert.deepEqual(k.sh('grep -n -B 2 "e 100000$" many'), ['99998-line 099998', '99999-line 099999', '100000:line 100000'])
  assert.deepEqual(k.sh('grep -c -B 5000 "e 100000$" many; grep -B 3000 "e 100000$" many | grep -c ""'), ['1', '3001'])
  assert.deepEqual(own(k.sh('grep "" /dev/zero | grep -m 1 -c ""')), ['1'])
  assert.deepEqual(k.system.kernel.ps().map((p) => p.name), ['init', '-sh'])
})

test('grep -r: a reader that leaves ends it quietly (141), not as trouble with the directory', () => {
  const k = fresh()
  mkdir(k, '/tmp/t')
  k.write('/tmp/t/a', 'apple\n'.repeat(20000))
  assert.deepEqual(k.sh('{ grep -r a t t; echo "status $?" >&2; } | grep -m 1 a'), ['t/a:apple', '!status 141'])
  assert.deepEqual(k.system.kernel.ps().map((p) => p.name), ['init', '-sh'])
})

test('grep: from a pipe each line is answered as it comes, without waiting for 8192 bytes or the end', () => {
  const k = fresh()
  assert.deepEqual(k.sh('while read l; do echo $l; done | grep -n a'), [])
  assert.deepEqual(k.sh('apple'), ['1:apple'])
  assert.deepEqual(k.sh('plum'), [])
  assert.deepEqual(k.sh('pear'), ['3:pear'])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['0'])
  // A NUL that comes in the writer's first piece still marks the input as binary before any line is printed.
  assert.deepEqual(k.sh('echo -e "a\\0b\\nc" | grep c'), ['Binary file (standard input) matches'])
})

test('grep: a long line that comes a few bytes at a time is put together whole', () => {
  const k = fresh()
  let want = ''
  for (let i = 0; i < 3000; i++) {
    want += `a${i}`
    if (i % 500 === 499) want += '\n'
  }
  const writer = 'i=0; while [ $i -lt 3000 ]; do echo -n "a$i"; if [ $((i % 500)) = 499 ]; then echo; fi; i=$((i+1)); done'
  assert.equal(textOf(k, `{ ${writer}; } | grep ''`), want)
  assert.deepEqual(k.sh(`{ ${writer}; echo -n tail; } | grep -c -e 2999 -e tail`), ['2'])
  assert.equal(textOf(k, '{ i=0; while [ $i -lt 20000 ]; do echo -n x; i=$((i+1)); done; } | grep x'), `${'x'.repeat(20000)}\n`)
})

test('grep: patterns that would stall a matcher trying one path at a time finish at once', () => {
  const k = fresh()
  k.write('/tmp/aaa', `${'a'.repeat(30000)}\n${'a'.repeat(40)}c\n`)
  assert.deepEqual(k.sh("grep -c '(a*)*b' aaa; grep -c '(a|aa)+$' aaa; grep -c '(x+x+)+y' aaa"), ['0', '1', '0'])
  assert.deepEqual(k.sh("grep -c -w '(a|a)*c' aaa; grep -c -x '(a*)*' aaa"), ['1', '1'])
  assert.deepEqual(k.sh("grep -o '(a+)+c' aaa | grep -c ''"), ['1'])
  // -F -w -i on a long run of one letter: every place is a candidate that is turned down, and a fresh folding
  // search from each would cost the square of the pattern's length there (hours here, with nothing else let run).
  k.write('/tmp/run', `${'a'.repeat(200000)} ${'A'.repeat(300)} x\n`)
  assert.deepEqual(k.sh(`grep -c -F -w -i ${'a'.repeat(300)} run; grep -o -F -w -i ${'a'.repeat(300)} run`), ['1', 'A'.repeat(300)])
})

// Long searches

/** Types a command line and runs the system a turn at a time until nothing can move: how many turns that took. */
function turns(k: Kit, line: string): number {
  k.system.type(`${line}\n`)
  let n = 0
  while (!k.system.idle) {
    k.system.run(1, Number.POSITIVE_INFINITY)
    n++
  }
  return n
}

/**
 * The most work of the engine a turn of grep may do with a pattern of `size` instructions: one slice of 131072 steps,
 * and what the last place of the text looked at can add past it (three steps for each instruction). At the slowest a
 * step goes (about 150 nanoseconds, folding letters past ASCII) that is some twenty milliseconds, and mostly a few.
 * A grep that let two slices go by between turns would take half the turns these tests ask for.
 */
const turnSteps = (size: number): number => (1 << 17) + 3 * size

test('grep: one long search is cut into turns, none with more than a slice of the engine\'s work', () => {
  const k = fresh()
  // Every instruction of this pattern stays alive along a run of a's: millions of steps for one line.
  const pattern = '[ab]{1000}c'
  const line = 'a'.repeat(4000)
  k.write('/tmp/run', `${line}\n`)
  const re = compile(pattern)
  assert.equal(re.test(line), false)
  const steps = re.steps
  assert.ok(steps > 4_000_000, `${steps} steps`)
  assert.ok(turns(k, `grep -c '${pattern}' run > /tmp/.out`) >= Math.floor(steps / turnSteps(re.size)))
  assert.equal(k.read('/tmp/.out'), '0\n')
  // -o looks again from where each part ended: here every search runs on to the end of the line, the square of its
  // length in all, over a few thousand searches that each take a slice or less.
  const half = line.slice(2000)
  k.write('/tmp/half', `${half}\n`)
  const parts = compile('a*b|a')
  let all = 0
  parts.test(half)
  all += parts.steps
  for (let from = 0; from < half.length; from++) {
    parts.exec(half, from)
    all += parts.steps
  }
  assert.ok(all > 6_000_000, `${all} steps`)
  assert.ok(turns(k, "grep -o 'a*b|a' half | grep -c a > /tmp/.out") >= Math.floor(all / turnSteps(parts.size)))
  assert.equal(k.read('/tmp/.out'), '2000\n')
})

test('grep: Ctrl+C stops a search of a pattern near the size cap over a line of a mebibyte, and a long -o', () => {
  const k = fresh(16 << 20)
  k.write('/tmp/huge', `${'a'.repeat(1 << 20)}\n`)
  // Near the 20000 instructions a pattern may have, every one alive at every place: done in one go, any of these
  // searches would take hours.
  const big = '[ab]{19980}c'
  assert.ok(compile(big).size > 19980)
  assert.ok(compile(`(^|\\W)(${big})(\\W|$)`, { ignoreCase: true }).size > 19990)
  for (const command of [`grep -c '${big}' huge`, `grep -w -i -n '${big}' huge`, "grep -o 'a*b|a' huge", `grep -v -e x -e '${big}' huge`]) {
    k.system.type(`${command}; echo not here\n`)
    for (let n = 0; n < 40; n++) k.system.run(1, Number.POSITIVE_INFINITY)
    // Forty turns on, grep is still searching, and the shell and the kernel have had every turn back.
    assert.deepEqual(k.system.kernel.ps().map((p) => p.name), ['init', '-sh', 'grep'], command)
    assert.equal(k.system.interrupt(), true, command)
    assert.deepEqual(k.settle(), [], command)
    assert.deepEqual(k.sh('echo $?'), ['130'], command)
    assert.deepEqual(k.system.kernel.ps().map((p) => p.name), ['init', '-sh'], command)
  }
})

test('grep: many large patterns are made ready a few at a time, Ctrl+C is heard meanwhile, and all together are bounded', () => {
  const k = fresh()
  const big = '[ab]{19980}c'
  const one = compile(big).size
  const outer = compile(`(^|\\W)(${big})(\\W|$)`).size
  const many = (n: number, flags = ''): string => `grep -c${flags}${` -e '${big}'`.repeat(n)}`
  // As many patterns of near the largest size as all of them together may lay out: made ready in one go they held
  // the kernel for a tenth of a second, and as many as the arguments can carry (thousands) for seconds.
  const most = Math.floor((1 << 20) / one)
  assert.ok(most >= 50)
  assert.ok(turns(k, `${many(most)} f > /tmp/.out`) >= most / 3)
  assert.equal(k.read('/tmp/.out'), '0\n')
  // Ctrl+C is heard while they are being made ready.
  k.system.type(`${many(most)} f; echo not here\n`)
  for (let n = 0; n < 10; n++) k.system.run(1, Number.POSITIVE_INFINITY)
  assert.deepEqual(k.system.kernel.ps().map((p) => p.name), ['init', '-sh', 'grep'])
  assert.equal(k.system.interrupt(), true)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['130'])
  // One more is too many, refused before any file is opened. -w lays each one out twice (on its own, and inside a
  // larger pattern), so half as many reach the bound.
  const refusal = '!grep: patterns too large in all: more than 1048576 instructions'
  assert.deepEqual(k.sh(`${many(most + 1)} nosuch; echo $?`), [refusal, '2'])
  const wordy = Math.floor((1 << 20) / (one + outer))
  assert.deepEqual(k.sh(`${many(wordy, ' -w')} f; echo $?`), ['0', '1'])
  assert.deepEqual(k.sh(`${many(wordy + 1, ' -w')} nosuch; echo $?`), [refusal, '2'])
  // Thousands of small patterns are no trouble.
  assert.deepEqual(k.sh(`grep -c -F${' -e zz'.repeat(5000)} -e an f`), ['1'])
})

// Files that are not there, directories, devices

test('grep: a missing file among good ones is reported, the others still searched, status 2; -s quiets it', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep an f nosuch f; echo $?'), ['f:banana', '!grep: nosuch: no such file or directory', 'f:banana', '2'])
  assert.deepEqual(k.sh('grep zz nosuch; echo $?'), ['!grep: nosuch: no such file or directory', '2'])
  assert.deepEqual(k.sh('grep -s an f nosuch f; echo $?'), ['f:banana', 'f:banana', '2'])
  assert.deepEqual(k.sh('grep -c an nosuch f'), ['!grep: nosuch: no such file or directory', 'f:1'])
  assert.deepEqual(k.sh('grep -L an nosuch none'), ['!grep: nosuch: no such file or directory', 'none'])
})

test('grep: a directory without -r is reported and counts as trouble', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep apple /tmp; echo $?'), ['!grep: /tmp: is a directory', '2'])
  assert.deepEqual(k.sh('grep apple /tmp f; echo $?'), ['!grep: /tmp: is a directory', 'f:apple', '2'])
  assert.deepEqual(k.sh('grep -s apple /tmp f; echo $?'), ['f:apple', '2'])
})

test('grep -r: every file below a directory, in name order, shown by its path', () => {
  const k = fresh()
  mkdir(k, '/tmp/t')
  mkdir(k, '/tmp/t/sub')
  mkdir(k, '/tmp/t/sub/deeper')
  k.write('/tmp/t/b.txt', 'needle b\n')
  k.write('/tmp/t/a.txt', 'needle a\nhay\n')
  k.write('/tmp/t/sub/c.txt', 'hay\nneedle c\n')
  k.write('/tmp/t/sub/deeper/d.txt', 'needle d\n')
  k.write('/tmp/t/z.txt', 'hay\n')
  assert.deepEqual(k.sh('grep -r needle t; echo $?'), ['t/a.txt:needle a', 't/b.txt:needle b', 't/sub/c.txt:needle c', 't/sub/deeper/d.txt:needle d', '0'])
  assert.deepEqual(k.sh('grep -r needle t/'), ['t/a.txt:needle a', 't/b.txt:needle b', 't/sub/c.txt:needle c', 't/sub/deeper/d.txt:needle d'])
  assert.deepEqual(k.sh('grep -r -h -n needle t/sub'), ['2:needle c', '1:needle d'])
  assert.deepEqual(k.sh('grep -r -c hay t'), ['t/a.txt:1', 't/b.txt:0', 't/sub/c.txt:1', 't/sub/deeper/d.txt:0', 't/z.txt:1'])
  assert.deepEqual(k.sh('grep -r -l hay t; grep -r -L hay t'), ['t/a.txt', 't/sub/c.txt', 't/z.txt', 't/b.txt', 't/sub/deeper/d.txt'])
  // A file named with -r is searched as itself, its name shown.
  assert.deepEqual(k.sh('grep -r needle t/a.txt; grep -r needle - < t/b.txt'), ['t/a.txt:needle a', '(standard input):needle b'])
  // With no file named, the working directory, its files shown by their paths from it.
  assert.deepEqual(k.sh('cd t; grep -r needle; grep -r "needle a" .; cd /tmp'),
    ['a.txt:needle a', 'b.txt:needle b', 'sub/c.txt:needle c', 'sub/deeper/d.txt:needle d', './a.txt:needle a'])
  assert.deepEqual(k.sh('grep -r -q needle t nosuch; echo $?'), ['0'])
  assert.deepEqual(k.sh('grep -r needle nosuch t/b.txt; echo $?'), ['!grep: nosuch: no such file or directory', 't/b.txt:needle b', '2'])
  assert.deepEqual(k.sh('grep -r zz t; echo $?'), ['1'])
  // Devices found below a directory are passed over: /dev/zero would never end.
  assert.deepEqual(k.sh('grep -r x /dev; echo $?'), ['1'])
  assert.deepEqual(k.sh('grep -r -c "" /dev/null'), ['/dev/null:0'])
})

// The output

test('grep: an output that takes nothing is reported, status 2', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep a f > /dev/full; echo $?'), ['!grep: write error: no space left on device', '2'])
  assert.deepEqual(k.sh('grep -c a f > /dev/full; echo $?'), ['!grep: write error: no space left on device', '2'])
  assert.deepEqual(k.sh('grep -q a f > /dev/full; echo $?'), ['0'])
})

test('grep: on the terminal each typed line is answered as soon as it is typed', () => {
  const k = fresh()
  assert.deepEqual(k.sh('grep -n a'), [])
  assert.deepEqual(k.sh('xyz'), [])
  assert.deepEqual(k.sh('abc'), ['2:abc'])
  assert.deepEqual(k.sh('banana'), ['3:banana'])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['0'])
})
