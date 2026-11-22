// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the gathered tables (programs.ts) to what the system and `man` count on: no
 * program name is claimed by two files, every program has a manual page, and every page has the one shape `man`
 * reads (its summary from the NAME line), in plain ASCII that fits a narrow screen. It also checks that a booted
 * system's /bin and manual are exactly these tables.
 * What breaks if it is removed? Two files could ship a program of the same name and one would silently win, a
 * program could arrive without a page, and `man -k` could show a broken summary.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boot } from './kit.test.ts'
import { MANUAL, MANUAL_TABLES, PROGRAMS, PROGRAM_TABLES } from './programs.ts'

/** The pages that describe the system rather than one program. */
const TOPICS = ['files', 'intro', 'sh']

/** The sections a page may have, in the order they come. */
const SECTIONS = ['NAME', 'USAGE', 'WHAT IT DOES', 'OPTIONS', 'NOTES', 'STATUS', 'EXAMPLE', 'SEE ALSO']

test('no name is claimed by two files, for programs or for pages', () => {
  for (const tables of [PROGRAM_TABLES, MANUAL_TABLES]) {
    const owner = new Map<string, string>()
    for (const [file, table] of Object.entries(tables)) {
      for (const name of Object.keys(table)) {
        assert.equal(owner.get(name), undefined, `${name} is in both ${owner.get(name)} and ${file}`)
        owner.set(name, file)
      }
    }
  }
})

test('every program has a page, and every page names a program or a topic', () => {
  const programs = Object.keys(PROGRAMS).sort()
  const pages = Object.keys(MANUAL).sort()
  assert.deepEqual(programs.filter((name) => !Object.hasOwn(MANUAL, name)), [])
  assert.deepEqual(pages.filter((name) => !Object.hasOwn(PROGRAMS, name)), TOPICS)
  // `[` is test's other name; every other is a plain word.
  for (const name of programs) assert.ok(name === '[' || /^[a-z][a-z0-9]*$/.test(name), name)
})

test('every page has the shape man reads: NAME, a summary line, the sections in order, ASCII in 78 columns', () => {
  for (const [name, page] of Object.entries(MANUAL)) {
    const lines = page.split('\n')
    assert.equal(lines[0], 'NAME', name)
    assert.ok(lines[1].startsWith(`    ${name} - `) && lines[1].length > name.length + 7, `${name}: the summary line`)
    assert.ok(page.endsWith('\n') && !page.endsWith('\n\n'), `${name}: one line end at the end`)
    const headings = lines.filter((line) => /^[A-Z]/.test(line))
    // A topic page may add headings of its own; a program's page uses the fixed ones, in order.
    const known = headings.filter((h) => SECTIONS.includes(h))
    assert.deepEqual(known, SECTIONS.filter((s) => known.includes(s)), `${name}: sections out of order`)
    assert.ok(known.includes('USAGE') && known.includes('WHAT IT DOES'), `${name}: USAGE and WHAT IT DOES`)
    if (!TOPICS.includes(name)) {
      assert.deepEqual(headings, known, `${name}: a heading that is not one of ${SECTIONS.join(', ')}`)
      assert.ok(known.includes('STATUS'), `${name}: STATUS`)
    }
    for (const [i, line] of lines.entries()) {
      assert.ok(line.length <= 78, `${name}:${i + 1} is ${line.length} columns`)
      assert.match(line, /^[\x20-\x7e]*$/, `${name}:${i + 1} is not plain ASCII`)
      assert.ok(!line.endsWith(' '), `${name}:${i + 1} ends in a blank`)
    }
  }
})

test('a booted system holds exactly these programs in /bin and these pages in its manual', () => {
  const k = boot(PROGRAMS, { manual: MANUAL })
  const bin = k.sh('ls -1 /bin')
  assert.deepEqual(bin, [...Object.keys(PROGRAMS), 'sh'].sort())
  const pages = k.sh('ls -1 /usr/share/man')
  assert.deepEqual(pages, Object.keys(MANUAL).sort())
  // man finds a page by its name, and -k by a word of its summary.
  assert.deepEqual(k.sh('man ls | head -n 2'), ['NAME', MANUAL.ls.split('\n')[1]])
  assert.ok(k.sh('man -k directory').some((line) => line.startsWith('ls ')))
})
