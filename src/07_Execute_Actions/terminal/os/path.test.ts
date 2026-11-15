// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the console's path arithmetic (path.ts) to its promises: every spelling of a
 * path made one canonical list of names against the working directory, each limit (NAME_MAX, PATH_MAX, DEPTH_MAX)
 * refused by name at exactly its edge, the last name and the directory of a path as typed, and the shell patterns
 * matched as described, hidden names kept out of `*`, in time linear in the name times the pattern.
 * What breaks if it is removed? A change could let a path grow past its limit until no command can name the
 * directory the shell stands in, or let a pattern take time that grows without end, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OsError } from './errno.ts'
import { FILE_PROGRAMS } from './fileutils.ts'
import { boot } from './kit.test.ts'
import { DEPTH_MAX, NAME_MAX, PATH_MAX, basename, dirname, fromParts, hasPattern, join, matches, normalize, parts, validName } from './path.ts'

/** The errno and message a call refuses with, or null when it does not refuse. */
function refusal(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (e) {
    if (e instanceof OsError) return `${e.errno}: ${e.message}`
    throw e
  }
}

/** A name of `n` copies of `c`. */
const name = (n: number, c = 'a'): string => c.repeat(n)

test('the limits are the ones the file system documents', () => {
  assert.deepEqual([NAME_MAX, PATH_MAX, DEPTH_MAX], [255, 4096, 64])
})

test('validName: not empty, not . or .., no slash or NUL, at most NAME_MAX', () => {
  const oks = ['a', ' ', '...', '.a', 'a.', 'a b', '-', '*', 'é', '\u{1F600}', name(255), '\n', '\\']
  for (const ok of oks) assert.equal(validName(ok), true, JSON.stringify(ok))
  const bads = ['', '.', '..', 'a/b', '/', 'a\0', '\0', name(256), name(128, '\u{1F600}')]
  for (const bad of bads) assert.equal(validName(bad), false, JSON.stringify(bad).slice(0, 20))
})

test('parts and normalize: one canonical list of names, whatever the spelling', () => {
  const cases: [string, string, string[]][] = [
    ['/', '/', []], ['/a/b', '/', ['a', 'b']], ['a', '/x/y', ['x', 'y', 'a']], ['../a', '/x/y', ['x', 'a']], ['/..', '/', []], ['/../../a', '/x', ['a']],
    ['a/../..', '/x', []], ['//a///b//', '/', ['a', 'b']], ['./a/./b/.', '/', ['a', 'b']], ['.', '/x', ['x']], ['/a', '/ignored', ['a']],
    ['/...', '/', ['...']],
    ['a b/ c', '/', ['a b', ' c']], ['..', '/', []], ['x/..', '/', []], ['.hidden', '/h', ['h', '.hidden']], ['é/\u{1F600}', '/', ['é', '\u{1F600}']],
  ]
  for (const [path, cwd, want] of cases) {
    assert.deepEqual(parts(path, cwd), want, `${path} in ${cwd}`)
    assert.equal(normalize(path, cwd), `/${want.join('/')}`, `${path} in ${cwd}`)
  }
  assert.deepEqual(parts('a'), ['a'])
  assert.equal(normalize('a//b/../c/', '/home'), '/home/a/c')
  assert.equal(fromParts([]), '/')
  assert.equal(fromParts(['a', 'b']), '/a/b')
})

test('parts refuses by name: an empty path, a NUL, an over-long name, path or depth', () => {
  assert.equal(refusal(() => parts('')), 'ENOENT: no such file or directory')
  assert.equal(refusal(() => parts('a\0b')), 'EINVAL: a path cannot hold a NUL')
  assert.equal(refusal(() => parts('/\0')), 'EINVAL: a path cannot hold a NUL')
  // NAME_MAX, in UTF-16 units: 255 is fine, 256 is not, and a name a later .. would remove is still read first.
  assert.deepEqual(parts(`/${name(255)}`), [name(255)])
  assert.deepEqual(parts(`/${name(255, 'é')}`), [name(255, 'é')])
  const paths = [`/${name(256)}`, `/${name(256)}/..`, `${name(256)}`, `/${name(128, '\u{1F600}')}`]
  for (const path of paths) assert.equal(refusal(() => parts(path)), 'ENAMETOOLONG: name too long')
  // PATH_MAX: a path of exactly 4096 units is fine, one more is not, slashes included.
  const longest = `/${Array(16).fill(name(255)).join('/')}`
  assert.equal(longest.length, PATH_MAX)
  assert.equal(parts(longest).length, 16)
  assert.equal(refusal(() => parts(`${longest}/`)), 'ENAMETOOLONG: name too long')
  assert.deepEqual(parts('/'.repeat(PATH_MAX)), [])
  assert.equal(refusal(() => parts('/'.repeat(PATH_MAX + 1))), 'ENAMETOOLONG: name too long')
  assert.equal(refusal(() => parts('/', `/${'a/'.repeat(2049)}`)), 'ENAMETOOLONG: name too long')
  // DEPTH_MAX: 64 names deep is fine, 65 is not, counted once . and .. are resolved.
  assert.equal(parts('/a'.repeat(64)).length, 64)
  assert.equal(refusal(() => parts('/a'.repeat(65))), 'ENAMETOOLONG: a path is at most 64 names deep')
  assert.equal(parts(`${'/a'.repeat(65)}/..`).length, 64)
  assert.equal(refusal(() => parts('b', '/a'.repeat(64))), 'ENAMETOOLONG: a path is at most 64 names deep')
})

test('parts refuses a canonical path past PATH_MAX, however short the path typed', () => {
  // A working directory of 3840 units: a relative name of 255 makes exactly 4096, anything longer is refused, so every
  // canonical path that comes back can be typed back (and a shell standing in it can still be given one).
  const cwd = `/${Array(15).fill(name(255)).join('/')}`
  assert.equal(cwd.length, 3840)
  assert.equal(normalize(name(255, 'b'), cwd).length, PATH_MAX)
  assert.equal(normalize(`x/../${name(254, 'b')}`, cwd).length, PATH_MAX - 1)
  assert.equal(refusal(() => parts(`${name(255, 'b')}/c`, cwd)), 'ENAMETOOLONG: name too long')
  assert.equal(refusal(() => parts(`x/../${name(254, 'b')}/c`, cwd)), 'ENAMETOOLONG: name too long')
  assert.equal(parts('..', cwd).length, 14)
  assert.equal(parts('/', normalize(name(255, 'b'), cwd)).length, 0)
})

test('at the prompt: no directory can be made or entered past PATH_MAX, so the shell can always leave', () => {
  const k = boot(FILE_PROGRAMS)
  const deep = `/tmp/${Array(15).fill(name(255)).join('/')}`
  assert.deepEqual(k.sh(`mkdir -p ${deep}; cd ${deep}; mkdir ${name(251, 'b')}; echo $?`), ['0'])
  assert.deepEqual(k.sh(`mkdir ${name(252, 'c')}; echo $?`), [`!mkdir: ${name(252, 'c')}: name too long`, '1'])
  assert.deepEqual(k.sh(`cd ${name(251, 'b')}; echo $?`), ['0'])
  assert.equal(k.system.cwd, `${deep}/${name(251, 'b')}`)
  assert.equal(k.system.cwd.length, PATH_MAX)
  assert.deepEqual(k.sh('cd /; pwd'), ['/'])
})

test('basename and dirname: the last name and what comes before it, of a path as typed', () => {
  const base: [string, string][] = [['/a/b', 'b'], ['/a/b/', 'b'], ['/', '/'], ['//', '/'], ['', ''], ['a', 'a'], ['a/', 'a'], ['/a', 'a'], ['///a///', 'a'],
    ['a/b/c', 'c'], ['.', '.'], ['..', '..'], ['/a/.', '.'], ['a b/c d', 'c d']]
  for (const [path, want] of base) assert.equal(basename(path), want, JSON.stringify(path))
  const dir: [string, string][] = [['/a/b', '/a'], ['b', '.'], ['/b', '/'], ['/a/b/', '/a'], ['a//b', 'a'], ['//b', '/'], ['/', '/'], ['', '.'], ['a/', '.'],
    ['///', '/'], ['//a//b//', '//a'], ['a/b/c', 'a/b'], ['.', '.'], ['../x', '..'], ['/a//b', '/a']]
  for (const [path, want] of dir) assert.equal(dirname(path), want, JSON.stringify(path))
  const joined: [string, string, string][] = [['', 'a', 'a'], ['/', 'a', '/a'], ['/x', 'a', '/x/a'], ['/x/', 'a', '/x/a'], ['x', 'y', 'x/y']]
  for (const [d, n, want] of joined) assert.equal(join(d, n), want, `${d} + ${n}`)
})

test('hasPattern: a pattern character that no backslash escapes', () => {
  const cases: [string, boolean][] = [['*', true], ['a?b', true], ['[ab]', true], ['[', true], ['abc', false], ['\\*', false], ['a\\?b', false],
    ['\\[x]', false],
    ['\\\\*', true], ['', false], ['a]', false], ['a\\', false], ['\\', false], ['x\\\\\\*', false]]
  for (const [text, want] of cases) assert.equal(hasPattern(text), want, text)
})

test('matches: *, ?, sets, ranges, their complements and escapes, as described', () => {
  const cases: [string, string, boolean][] = [
    ['*', 'abc', true], ['*', '', true], ['', '', true], ['', 'a', false], ['a', '', false], ['a*', 'a', true], ['a*', 'abc', true], ['*c', 'abc', true],
    ['*b*', 'abc', true], ['*x*', 'abc', false], ['**', 'abc', true], ['*?', '', false], ['*?', 'a', true], ['?*?', 'a', false],
    ['a*a', 'a', false], ['a*a', 'aa', true],
    ['?', 'a', true], ['?', '', false], ['?', 'ab', false], ['??', 'ab', true], ['a?c', 'abc', true], ['a?c', 'ac', false], ['?', 'é', true],
    ['[abc]', 'b', true], ['[abc]', 'd', false], ['[a-c]', 'b', true], ['[a-c]', 'd', false], ['[!a-c]', 'd', true], ['[!a-c]', 'b', false],
    ['[^a-c]', 'd', true],
    ['[]a]', ']', true], ['[]a]', 'a', true], ['[!]a]', 'b', true], ['[!]]', ']', false], ['[a-]', '-', true], ['[-a]', '-', true], ['[a\\]]', ']', true],
    ['[\\!a]', '!', true], ['[\\a-\\c]', 'b', true], ['[a-c\\]', 'b', false], ['[à-ÿ]', 'é', true], ['[0-9][0-9]', '42', true], ['[0-9][0-9]', '4x', false],
    ['[ab', '[ab', true], ['[ab', 'a', false], ['a[', 'a[', true], ['[', '[', true], ['[]', '[]', true],
    ['\\*', '*', true], ['\\*', 'a', false], ['\\?', '?', true], ['a\\', 'a\\', true], ['\\\\', '\\', true], ['\\a', 'a', true],
    ['*.txt', 'notes.txt', true], ['*.txt', 'notes.txt.bak', false], ['*.*', 'a.b.c', true], ['a*b*c', 'aXbYc', true], ['a*b*c', 'aXbY', false],
    ['*a', 'bab', false], ['*a', 'baba', true], ['*ab', 'aab', true], ['*ab*ab', 'abxabyab', true], ['*[0-9]', 'file7', true], ['*[0-9]', 'file', false],
  ]
  for (const [pattern, text, want] of cases) assert.equal(matches(pattern, text), want, `${pattern} ~ ${text}`)
})

test('matches: a hidden name is matched only by a pattern that starts with a dot, unless the text is no file name', () => {
  const cases: [string, string, boolean, boolean][] = [
    ['*', '.hidden', false, true], ['?hidden', '.hidden', false, true], ['[.]hidden', '.hidden', false, true], ['[!a]hidden', '.hidden', false, true],
    ['.*', '.hidden', true, true], ['.*', '.', true, true], ['.h*', '.hidden', true, true], ['*n', '.hidden', false, true],
    ['*', 'a.b', true, true], ['a*', 'a.', true, true],
  ]
  for (const [pattern, text, plain, dots] of cases) {
    assert.equal(matches(pattern, text), plain, `${pattern} ~ ${text}`)
    assert.equal(matches(pattern, text, true), dots, `${pattern} ~ ${text} (dots)`)
  }
})

test('matches: patterns that would take time without end in a backtracking matcher answer at once', () => {
  // Sizes picked so that a matcher retrying more than one star would not finish within the run.
  const long = name(100000)
  assert.equal(matches('a*a*a*a*a*a*a*a*b', long), false)
  assert.equal(matches('*a*a*a*a*a*a*a*a', long), true)
  assert.equal(matches('?*?*?*?*?*?*?*?*b', long), false)
  assert.equal(matches(`${'*'.repeat(1000)}b`, name(10000)), false)
  assert.equal(matches(`${'*a'.repeat(500)}`, name(10000)), true)
  assert.equal(matches(`${'*a'.repeat(500)}b`, name(10000)), false)
  assert.equal(matches(`*[${'abcdefghijklmnopqrstuvwxy'.repeat(10)}]b`, name(20000)), false)
  assert.equal(matches('*[!a]*', long), false)
  assert.equal(matches(`${'[a]'.repeat(1000)}*`, long), true)
  assert.equal(matches(`*${'\\a'.repeat(100)}b`, name(20000)), false)
  assert.equal(matches(`[${'a'.repeat(100000)}`, '['), false)
})

test('at the prompt: patterns list matching names sorted, keep hidden ones out of *, and stand for themselves when nothing matches', () => {
  const k = boot(FILE_PROGRAMS)
  assert.deepEqual(k.sh('cd /tmp; touch a.txt b.txt c.log .h; echo *; echo .*; echo *.txt; echo [ab].txt; echo [!a]*; echo ?.txt'), [
    'a.txt b.txt c.log', '.h', 'a.txt b.txt', 'a.txt b.txt', 'b.txt c.log', 'a.txt b.txt',
  ])
  assert.deepEqual(k.sh('echo \\*; echo "*"; echo nomatch*; echo /tmp/*.log; echo /tm?/c*'), ['*', '*', 'nomatch*', '/tmp/c.log', '/tmp/c.log'])
  const trims = 'x=a.tar.gz; echo ${x%.*} ${x%%.*} ${x#*.} ${x##*.}; y=.profile; echo ${y#.} ${y%e} ${y#\\*}'
  assert.deepEqual(k.sh(trims), ['a.tar a tar.gz gz', 'profile .profil .profile'])
})
