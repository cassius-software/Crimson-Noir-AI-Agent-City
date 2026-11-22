// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The apps are built with some four hundred open-source Rust crates whose licences ask that
 * their notices travel with every copy. tools/license/notices.mjs writes those notices into one committed file
 * (src-tauri/notices/RUST-CRATES.txt), the shell compiles it in and ships it as a resource, and the build matrix
 * reads what it built for it. This holds each link without cargo: the committed file names every crate of the
 * lockfile once, under the licence the inventory records, with the source of each MPL-2.0 crate; how the file is
 * made is pinned on small sets (one copy of a text many crates share, a crate that ships no text, the licence taken
 * when one is offered, a stand-in text only from a crate of that very licence); the check of a built file reads a
 * plain binary and a zip archive alike; and the shell, its config, the audits and the workflows all name the same
 * file. The registry half (the committed file against the crates' own packages) needs cargo and a network, so it is
 * part of CI's `crate-licences` check, pinned here by its place in checks.sh.
 * What breaks if it is removed? A dependency added without its notice, or a package that stopped carrying the file,
 * reaches a release unseen.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRawSync } from 'node:zlib'

// Computed specifiers: both are tooling under tools/, outside the page's build, loaded as the test's own modules.
const NOTICES: string = '../tools/license/notices.mjs'
const GATE: string = '../tools/license/gate.mjs'
const n = await import(NOTICES)
const g = await import(GATE)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

const COMMITTED = read(n.NOTICES_FILE)
const MIT = n.mitBody()

interface Pkg { id: string; name: string; version: string; license: string | null; authors?: string[]; repository?: string | null; source: string | null; manifest_path: string; license_file?: string | null }
interface Nested { names: string[]; covers: string; built: boolean; why: string | null }
interface Rec { name: string; version: string; licence: string | null; authors: string[]; repository: string | null; features: string[]; targets: string[]; licenceFile: string | null; files: { name: string; text: string }[]; nested?: Nested[] }

/**
 * A registry that exists only here: each crate's folder with the files given (a name may hold folders), and cargo's
 * answer naming them, with the features each was resolved with and the platforms it is taken for (`null`: any).
 */
function registry(crates: { name: string; version?: string; licence?: string | null; authors?: string[]; repository?: string | null; files?: Record<string, string>; source?: string | null; licenseFile?: string; features?: string[]; targets?: (string | null)[] }[]) {
  const disk = new Map<string, Record<string, string>>()
  const packages: Pkg[] = crates.map((c) => {
    const version = c.version ?? '1.0.0'
    const dir = `/registry/${c.name}-${version}`
    disk.set(dir, { 'Cargo.toml': '[package]', 'README.md': 'read me', ...(c.files ?? {}) })
    return { id: `${c.name} ${version}`, name: c.name, version, license: c.licence === undefined ? 'MIT' : c.licence, authors: c.authors ?? [], repository: c.repository ?? null, source: c.source === undefined ? 'registry+https://github.com/rust-lang/crates.io-index' : c.source, manifest_path: `${dir}/Cargo.toml`, license_file: c.licenseFile ?? null }
  })
  const nodes = [
    { id: 'the app 0.0.0', features: [] as string[], deps: crates.map((c, i) => ({ pkg: packages[i].id, dep_kinds: (c.targets ?? [null]).map((target) => ({ kind: null, target })) })) },
    ...crates.map((c, i) => ({ id: packages[i].id, features: c.features ?? [], deps: [] })),
  ]
  const folder = (path: string) => [...disk.keys()].find((dir) => path.startsWith(`${dir}/`))!
  const fs = {
    list: (dir: string) => Object.keys(disk.get(dir) ?? {}),
    read: (path: string) => disk.get(folder(path))![path.slice(folder(path).length + 1)],
  }
  return { metadata: { packages, resolve: { nodes } }, fs }
}
type Spec = Parameters<typeof registry>[0][number]
const records = (crates: Parameters<typeof registry>[0]): Rec[] => { const r = registry(crates); return n.crateRecords(r.metadata, r.fs) }
const mitOf = (who: string) => `MIT License\n\nCopyright (c) ${who}\n\n${MIT}\n`

// ---------------------------------------------------------------------------------------------------------------
// The committed file

test('the committed notices name every crate of the apps\' lockfile once, under the licence the inventory records', () => {
  assert.ok(COMMITTED.startsWith(`${n.TITLE}\n\n`), 'the title the shell\'s own test looks for is its first line')
  assert.ok(COMMITTED.endsWith('\n') && !COMMITTED.endsWith('\n\n') && !COMMITTED.includes('\r'), 'one newline at its end, LF throughout')
  assert.doesNotMatch(COMMITTED, /[ \t]\n/, 'no trailing blanks')
  const listed = [...COMMITTED.matchAll(/^(\S+) (\S+) \| (.+) \| https:\/\/crates\.io\/crates\/(\S+)\/(\S+)$/gm)]
  for (const m of listed) assert.deepEqual([m[4], m[5]], [m[1], m[2]], `${m[1]}'s page is its own`)
  const lock: string[] = g.lockCrates(read(`${n.WORKSPACE}/Cargo.lock`)).map((c: { name: string; version: string }) => `${c.name} ${c.version}`).sort()
  assert.deepEqual(listed.map((m) => `${m[1]} ${m[2]}`).sort(), lock, 'the lockfile\'s registry crates, each once: after a change of dependencies run node tools/license/notices.mjs --write')
  assert.ok(lock.length > 400, 'the whole tree, not a sample')
  assert.match(COMMITTED, new RegExp(`^1\\. THE CRATES \\(${lock.length}\\)$`, 'm'))
  assert.match(COMMITTED, new RegExp(`${lock.length} crates, each used as its authors published it`))
  const inventory: Record<string, string | null> = g.loadInventory().crates
  for (const m of listed) assert.equal(m[3], inventory[`${m[1]} ${m[2]}`], `${m[1]} ${m[2]}: the licence tools/license/crates.json records`)
})

test('the committed notices say where the source of each MPL-2.0 crate is, number their texts without a gap, and give a text for every crate that ships none', () => {
  const policy = g.loadPolicy()
  const mpl: string[] = policy.licences.byCrate['MPL-2.0'].crates
  const section = COMMITTED.slice(COMMITTED.indexOf('\n2. SOURCE CODE OF THE CRATES UNDER THE MOZILLA PUBLIC LICENSE 2.0\n'), COMMITTED.indexOf('\n3. THE TEXTS THE CRATES SHIP'))
  for (const name of mpl) {
    assert.match(section, new RegExp(`^${name} \\S+\\n  package: https://crates\\.io/api/v1/crates/${name}/\\S+/download\\n  page:    https://crates\\.io/crates/${name}/\\S+$`, 'm'), `${name}: where its source is`)
  }
  assert.equal([...section.matchAll(/^ {2}package: /gm)].length, mpl.length, 'the crates the policy names, and no other')
  assert.match(COMMITTED, /Mozilla Public License Version 2\.0/, 'and the licence itself is among the texts')

  const numbers = [...COMMITTED.matchAll(/^Text (\d+) of (\d+)$/gm)]
  assert.ok(numbers.length > 100)
  numbers.forEach((m, i) => assert.deepEqual([Number(m[1]), Number(m[2])], [i + 1, numbers.length]))
  assert.match(COMMITTED, new RegExp(`^3\\. THE TEXTS THE CRATES SHIP \\(${numbers.length} distinct\\)$`, 'm'))

  const last = COMMITTED.slice(COMMITTED.indexOf('\n4. CRATES WITH NO LICENCE TEXT OF THEIR OWN'), COMMITTED.indexOf('\n5. FILES FROM INSIDE A PACKAGE'))
  const bare = [...last.matchAll(/^(\S+) (\S+)\n {2}declared: (.+)\n {2}taken: {4}(.+)\n/gm)]
  assert.match(last, new RegExp(`^4\\. CRATES WITH NO LICENCE TEXT OF THEIR OWN \\(${bare.length}\\)$`, 'm'))
  for (const m of bare) {
    for (const id of m[4].split(' AND ')) assert.equal(g.permits(id, m[1], policy).ok, true, `${m[1]} is taken under ${id}, which the policy allows`)
    assert.deepEqual(n.taken(m[3]), m[4].split(' AND '), `${m[1]}: taken as the tool takes it`)
  }
  const mitTaken = bare.filter((m) => m[4] === 'MIT')
  assert.equal([...last.matchAll(/^ {2}notice: {3}Copyright \(c\) \S/gm)].length, mitTaken.length, 'each crate taken under MIT has its copyright notice beside it')
  assert.ok(last.replace(/\n-{100}\s*$/, '').trimEnd().endsWith(MIT), 'and the MIT License follows them, as LICENSES/MIT.txt has it from "Permission is hereby granted"')
  for (const m of bare.filter((b) => b[4] !== 'MIT')) {
    assert.match(last, new RegExp(`^${m[1]} ${m[2].replace(/[.+]/g, '\\$&')}\\n(?: {2}.*\\n)*? {2}text: {5}${m[4].replace(/[.+]/g, '\\$&')}, as \\S+ \\S+ ships it above \\(`, 'm'), `${m[1]}: the text another crate of ${m[4]} ships`)
  }
})

test('the committed notices account for every file from inside a package by a rule of the policy, and leave a text out only with a reason', () => {
  const rules: { crate: string; under: string; covers: string; built?: boolean; why?: string; needs?: Record<string, unknown> }[] = g.loadPolicy().notices.nested
  const section = COMMITTED.slice(COMMITTED.indexOf('\n5. FILES FROM INSIDE A PACKAGE'), COMMITTED.indexOf('\n6. THE RUST STANDARD LIBRARY'))
  const texts = COMMITTED.slice(COMMITTED.indexOf('\n3. THE TEXTS THE CRATES SHIP'), COMMITTED.indexOf('\n4. CRATES WITH NO LICENCE TEXT OF THEIR OWN'))
  const groups = [...section.matchAll(/^((?: {2}\S.*\n)+) {4}covers: ([^]*?)\n {4}text: {3}(reproduced above|not reproduced, because no app is built with it\.[^]*?)\n(?= {2}\S|\n)/gm)]
  const files = groups.flatMap((m) => m[1].trim().split(/\n\s+/))
  assert.match(section, new RegExp(`^5\\. FILES FROM INSIDE A PACKAGE \\(${files.length}\\)$`, 'm'))
  assert.ok(files.length >= 10 && groups.length === rules.length, 'one group for each rule, and no rule that covers nothing')
  for (const m of groups) {
    const names = m[1].trim().split(/\n\s+/)
    const rule = rules.find((r) => names.every((name) => name === r.under || name.startsWith(`${r.under}/`)) && m[2].replace(/\s+/g, ' ') === r.covers)
    assert.ok(rule, `${names[0]}: what it covers is the policy's own sentence`)
    const kept = m[3] === 'reproduced above'
    assert.equal(kept, rule.built !== false, names[0])
    // A text that is reproduced has its file named over a text of section 3; one that is left out is named nowhere there.
    for (const name of names) assert.equal(new RegExp(`^${name.replace(/[.+]/g, '\\$&')} of \\S`, 'm').test(texts), kept, name)
    if (!kept) {
      assert.equal(m[3].replace(/\s+/g, ' '), `not reproduced, because no app is built with it. ${rule.why}`)
      assert.ok(rule.why && Object.keys(rule.needs ?? {}).length > 0, `${rule.under}: a reason, and what cargo is asked to make it so`)
    }
  }
  // The Unicode data licence of the tables compiled into every app is one of the texts, and no text of a licence the
  // gate refuses is in the file: a library an app is not built with does not put its terms into the app's program.
  assert.match(texts, /^src\/unicode_tables\/LICENSE-UNICODE of regex-syntax \S+$/m)
  assert.match(COMMITTED, /UNICODE, INC\. LICENSE AGREEMENT - DATA FILES AND SOFTWARE/)
  // (A crate may name such a licence as one it also offers, and the MPL names them as secondary licences: it is the
  // licence's own text that is looked for, by the sentence each of them opens with.)
  for (const opening of [/Everyone is permitted to copy and distribute verbatim copies\s+of this license document/i, /Server Side Public License\s+VERSION \d/i, /Creative Commons Attribution-(?:NonCommercial|ShareAlike)[^\n]*\n+[^\n]*Public License/i]) assert.doesNotMatch(COMMITTED, opening)
})

test('the committed notices end with the Rust standard library\'s own, of the rustc every workflow builds with', () => {
  const at = COMMITTED.indexOf('\n6. THE RUST STANDARD LIBRARY (rustc ')
  assert.ok(at > 0)
  const section = COMMITTED.slice(at)
  const version = /^6\. THE RUST STANDARD LIBRARY \(rustc (\d+\.\d+\.\d+)\)$/m.exec(section)![1]
  const pinned = ['ci.yml', 'build-matrix.yml', 'windows-app.yml', 'native-e2e.yml', 'build-release.yml'].map((name) => [name, /^ {2}RUST_TOOLCHAIN: '([^']+)'$/m.exec(read(`.github/workflows/${name}`))?.[1]])
  for (const [name, toolchain] of pinned) assert.equal(toolchain, version, `${name} builds with the rustc whose notices the file holds: after a change of toolchain run node tools/license/notices.mjs --write`)
  assert.match(section, new RegExp(`for rustc ${version.replace(/\./g, '\\.')}, the\\s+toolchain the apps are built with`))
  assert.match(section, /^COPYRIGHT NOTICES FOR THE RUST STANDARD LIBRARY$/m)
  assert.match(section, /^The Rust Standard Library is dual-licensed under Apache 2\.0 and MIT terms\.$/m)
  assert.match(section, /^IN-TREE FILES$/m)
  assert.match(section, /^OUT-OF-TREE DEPENDENCIES$/m)
  for (const name of ['hashbrown', 'libc', 'rustc-demangle', 'gimli', 'unwinding']) assert.match(section, new RegExp(`^${name}-\\d+\\.\\d+\\.\\d+$`, 'm'), `${name}, which the library is built from`)
  assert.ok(section.split('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION').length > 5, 'the licence texts themselves, not their names')
  assert.doesNotMatch(section, /<\/?(?:p|div|pre|details|summary|code|h[1-6]|ul|li|b)\b|&(?:#\d+|#x[0-9a-f]+|amp|lt|gt|quot);/i, 'plain text: no tag and no character reference is left')
  assert.match(COMMITTED, /^These notices are about the crates and the Rust standard library alone\./m)
})

// ---------------------------------------------------------------------------------------------------------------
// How the file is made

test('a text is compared without its byte-order mark, its line ends or its trailing blanks, and a licence\'s words whatever its line breaks', () => {
  assert.equal(n.clean('﻿MIT  \r\n\r\nline\t\rend \n\n'), 'MIT\n\nline\nend')
  assert.equal(n.words(' Permission  is\nhereby\r\n granted '), 'Permission is hereby granted')
  assert.match(MIT, /^Permission is hereby granted, free of charge/)
  assert.match(MIT, /OTHER DEALINGS IN THE\nSOFTWARE\.$/)
  assert.doesNotMatch(MIT, /Copyright \(c\)/, 'the body alone: the notice is each crate\'s own')
  assert.throws(() => n.mitBody('Apache License'), /does not hold the MIT License/)
})

test('the licence taken for a crate with no text: MIT where it is offered, every side of an AND, and nothing the order does not rank', () => {
  assert.deepEqual(n.taken('MIT'), ['MIT'])
  assert.deepEqual(n.taken('MIT OR Apache-2.0'), ['MIT'])
  assert.deepEqual(n.taken('Apache-2.0 OR MIT'), ['MIT'])
  assert.deepEqual(n.taken('MIT/Apache-2.0'), ['MIT'], 'the older slash is OR')
  assert.deepEqual(n.taken('Zlib OR Apache-2.0 OR MIT'), ['MIT'])
  assert.deepEqual(n.taken('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'), ['MIT'])
  assert.deepEqual(n.taken('Zlib OR Apache-2.0'), ['Zlib'])
  assert.deepEqual(n.taken('MPL-2.0'), ['MPL-2.0'])
  assert.deepEqual(n.taken('BSD-3-Clause'), ['BSD-3-Clause'])
  assert.deepEqual(n.taken('(MIT OR Apache-2.0) AND Unicode-3.0'), ['MIT', 'Unicode-3.0'])
  assert.deepEqual(n.taken('Zlib OR (MIT AND Apache-2.0)'), ['Zlib'], 'a set is ranked by its least preferred member: Zlib alone, before MIT with Apache-2.0')
  assert.deepEqual(n.taken('(MIT AND Apache-2.0) OR Zlib'), ['Zlib'])
  assert.deepEqual(n.taken('Apache-2.0 WITH LLVM-exception'), ['Apache-2.0 WITH LLVM-exception'])
  assert.deepEqual(n.taken('MIT OR GPL-3.0-only'), ['MIT'], 'a side the order does not rank is never the one taken')
  assert.throws(() => n.taken('GPL-3.0-only'), /no licence it offers has a place in the order of preference/)
  assert.throws(() => n.taken('MIT AND LGPL-2.1-or-later'), /no licence it offers has a place/)
  for (const id of g.loadPolicy().licences.allowed as string[]) assert.ok(n.PREFERENCE.includes(id), `${id}: every licence the policy allows has a place`)
  assert.equal(n.PREFERENCE[0], 'MIT')
})

test('a crate\'s record: registry crates alone, the files whose names say licence, copyright or notice, cleaned, in a fixed order', () => {
  const recs = records([
    { name: 'zeta', files: { 'LICENSE-MIT': 'mit\r\n', 'LICENSE-APACHE': 'apache', 'license.rs': 'fn main() {}', 'NOTICE': '  \n', 'COPYRIGHT': 'c', 'UNLICENSE': 'u', 'licenses': 'no', 'AUTHORS': 'a' }, authors: ['Z'], repository: 'https://example.invalid/zeta' },
    { name: 'alpha', version: '2.0.0', licence: 'Zlib', files: { 'docs.md': 'x' } },
    { name: 'alpha', version: '1.0.0', licence: null },
    { name: 'ours', source: null, files: { LICENSE: 'the workspace\'s own crate' } },
    { name: 'odd', files: { 'TERMS.txt': 'terms' }, licenseFile: 'TERMS.txt' },
  ])
  assert.deepEqual(recs.map((r) => `${r.name} ${r.version}`), ['alpha 1.0.0', 'alpha 2.0.0', 'odd 1.0.0', 'zeta 1.0.0'], 'by name, then version; a crate with no source is the repository\'s own')
  const zeta = recs.at(-1)!
  assert.deepEqual(zeta.files, [{ name: 'AUTHORS', text: 'a' }, { name: 'COPYRIGHT', text: 'c' }, { name: 'LICENSE-APACHE', text: 'apache' }, { name: 'LICENSE-MIT', text: 'mit' }, { name: 'UNLICENSE', text: 'u' }], 'no source file, no empty file, no file that only starts like one')
  assert.deepEqual([zeta.licence, zeta.authors, zeta.repository], ['MIT', ['Z'], 'https://example.invalid/zeta'])
  assert.deepEqual(recs[2].files, [{ name: 'TERMS.txt', text: 'terms' }], 'the file a manifest names as its licence, whatever it is called')
  assert.deepEqual([recs[2].licenceFile, zeta.licenceFile], ['TERMS.txt', null])
  assert.deepEqual([recs[0].licence, recs[0].files, recs[1].files], [null, [], []])
  for (const name of ['LICENSE', 'Licence', 'license.txt', 'LICENSE-APACHE-2.0_WITH_LLVM-exception', 'COPYING', 'COPYRIGHT-rust.txt', 'NOTICE', 'UNLICENSE', 'AUTHORS', 'PATENTS', 'LICENSE.spdx', 'LICENSE.BSD-3-Clause', 'LICENSE-UNICODE', 'LICENSE.md']) assert.match(name, n.NOTICE_FILE)
  for (const name of ['README.md', 'Cargo.toml', 'licenses', 'license.rs', 'LICENSE.json', 'LICENSE.png', 'notice_helper.py', 'unlicensed', 'license.cmake', 'license.h', 'LICENSE.html', 'copyright.go', 'notice.in']) assert.doesNotMatch(name, n.NOTICE_FILE)
  for (const name of ['LICENSE', 'license-mit.txt', 'LICENCE', 'COPYING', 'UNLICENSE', 'LICENSE.BSD-3-Clause']) assert.match(name, n.LICENCE_TEXT)
  for (const name of ['AUTHORS', 'COPYRIGHT', 'COPYRIGHT-RUST.txt', 'NOTICE', 'PATENTS', 'LICENSE.spdx']) assert.doesNotMatch(name, n.LICENCE_TEXT, `${name} is reproduced, and is not a licence's text`)
})

test('a crate\'s record reaches into its package: files in its folders by their paths, after those at its top; what cargo resolved it with; crates.io alone', () => {
  const [deep] = records([{ name: 'deep', features: ['std', 'alloc'], targets: ['cfg(windows)'], files: { 'vendor/lib/COPYING': 'the library\'s terms', LICENSE: 'the crate\'s', 'vendor/lib/src/license.c': 'code', 'a/b/c/NOTICE.txt': 'deep notice', 'vendor/lib/README': 'no', AUTHORS: 'who' } }])
  assert.deepEqual(deep.files.map((f) => f.name), ['AUTHORS', 'LICENSE', 'a/b/c/NOTICE.txt', 'vendor/lib/COPYING'], 'the name without its folders decides; the top of the package first')
  assert.deepEqual([deep.features, deep.targets], [['alloc', 'std'], ['cfg(windows)']])
  const [any, both] = records([{ name: 'any' }, { name: 'both', targets: [null, 'cfg(unix)'] }])
  assert.deepEqual([any.targets, both.targets], [['*'], ['*', 'cfg(unix)']], 'a dependency with no condition is for every platform')
  // A fork or another registry is not where the printed addresses point: refused, not listed.
  assert.throws(() => records([{ name: 'forked', source: 'git+https://example.invalid/fork?rev=abc#abc' }]), /forked 1\.0\.0 comes from git\+https:\/\/example\.invalid\/fork\?rev=abc#abc, not from crates\.io/)
  assert.throws(() => records([{ name: 'inhouse', source: 'registry+https://crates.example.invalid/index' }]), /inhouse 1\.0\.0 comes from registry\+https:\/\/crates\.example\.invalid\/index, not from crates\.io/)
  assert.equal(n.CRATES_IO, 'registry+https://github.com/rust-lang/crates.io-index')

  // The real reader: every folder of the package is walked, and a file that is not UTF-8 stops the run.
  const root = mkdtempSync(join(tmpdir(), 'crate-package-'))
  try {
    const dir = join(root, 'real-1.0.0')
    mkdirSync(join(dir, 'src', 'tables'), { recursive: true })
    writeFileSync(join(dir, 'Cargo.toml'), '[package]')
    writeFileSync(join(dir, 'LICENSE-MIT'), '﻿mit, with a byte-order mark\r\n')
    writeFileSync(join(dir, 'src', 'tables', 'LICENSE-DATA'), 'Copyright © the data\'s owners\n')
    writeFileSync(join(dir, 'src', 'tables', 'license.rs'), '// code')
    const metadata = { packages: [{ id: 'real 1.0.0', name: 'real', version: '1.0.0', license: 'MIT', source: n.CRATES_IO, manifest_path: join(dir, 'Cargo.toml') }] }
    assert.deepEqual(n.crateRecords(metadata)[0].files, [{ name: 'LICENSE-MIT', text: 'mit, with a byte-order mark' }, { name: 'src/tables/LICENSE-DATA', text: 'Copyright © the data\'s owners' }])
    writeFileSync(join(dir, 'COPYING'), Buffer.from([0x43, 0x6f, 0x70, 0x79, 0x72, 0x69, 0x67, 0x68, 0x74, 0x20, 0xa9, 0x20, 0x4a, 0x6f, 0x73, 0xe9]))
    assert.throws(() => n.crateRecords(metadata), /COPYING is not UTF-8: how it is read has to be decided before it is reproduced/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('files from inside a package go in only under a rule: what they cover, and whether an app is built with it, which cargo\'s answer must bear out', () => {
  const set: Spec[] = [
    { name: 'tables', files: { LICENSE: 'the crate\'s', 'src/data/LICENSE-DATA': 'the data\'s terms' } },
    { name: 'binding', features: ['native'], targets: ['cfg(windows)'], files: { 'LICENSE.txt': 'the binding\'s', 'etc/lib/LICENSE.txt': 'three licences', 'etc/lib/LICENSE-gpl3.txt': 'a licence the gate refuses', 'etc/libfoo/NOTICE': 'another library' } },
    { name: 'plain', files: { LICENSE: 'plain' } },
  ]
  const rules = [
    { crate: 'tables', under: 'src/data/LICENSE-DATA', covers: 'the tables' },
    { crate: 'binding', under: 'etc/lib', covers: 'the library in C', built: false, why: 'It is compiled only without native.', needs: { features: ['native'], target: 'cfg(windows)' } },
    { crate: 'binding', under: 'etc/libfoo/', covers: 'another library' },
  ]
  const done: Rec[] = n.account(records(set), rules)
  const [binding, plain, tables] = done
  assert.deepEqual(binding.files.map((f) => f.name), ['LICENSE.txt', 'etc/libfoo/NOTICE'], 'what no app is built with is not reproduced; a folder\'s rule does not reach a folder that only starts like it')
  assert.deepEqual(binding.nested, [
    { names: ['etc/lib/LICENSE-gpl3.txt', 'etc/lib/LICENSE.txt'], covers: 'the library in C', built: false, why: 'It is compiled only without native.' },
    { names: ['etc/libfoo/NOTICE'], covers: 'another library', built: true, why: null },
  ])
  assert.deepEqual([plain.nested, plain.files.length, tables.files.map((f) => f.name)], [[], 1, ['LICENSE', 'src/data/LICENSE-DATA']])
  assert.deepEqual(tables.nested, [{ names: ['src/data/LICENSE-DATA'], covers: 'the tables', built: true, why: null }])

  const text: string = n.notices(done, { mit: MIT })
  assert.match(text, /^5\. FILES FROM INSIDE A PACKAGE \(4\)$/m)
  assert.match(text, /^binding 1\.0\.0\n {2}etc\/lib\/LICENSE-gpl3\.txt\n {2}etc\/lib\/LICENSE\.txt\n {4}covers: the library in C\n {4}text: {3}not reproduced, because no app is built with it\. It is compiled only without native\.\n {2}etc\/libfoo\/NOTICE\n {4}covers: another library\n {4}text: {3}reproduced above\n\ntables 1\.0\.0\n {2}src\/data\/LICENSE-DATA\n {4}covers: the tables\n {4}text: {3}reproduced above\n$/m)
  assert.match(text, /^src\/data\/LICENSE-DATA of tables 1\.0\.0\n-{100}\n\nthe data's terms$/m)
  assert.equal(text.includes('a licence the gate refuses'), false)
  assert.equal(text.includes('three licences'), false)
  assert.ok(n.words(text).includes('A text is left out only where it covers a part of a package that no app is built with, and section 5 names each such file and says why.'))
  assert.match(text, /^4\. CRATES WITH NO LICENCE TEXT OF THEIR OWN \(0\)$/m, 'each of the three has a licence file of its own at its top')
  assert.match(n.notices(records([{ name: 'plain', files: { LICENSE: 'plain' } }]), { mit: MIT }), /^5\. FILES FROM INSIDE A PACKAGE \(0\)\n-{100}\n\nNo crate ships a licence, copyright or notice file below the top of its package\.\n$/m)

  // Everything wrong is named at once, and nothing is written.
  const fails = (crates: Spec[], with_: unknown[], ...patterns: RegExp[]) => assert.throws(() => n.account(records(crates), with_), (e: Error) => { for (const p of patterns) assert.match(e.message, p); return true })
  fails(set, rules.slice(1), /^tables 1\.0\.0 ships src\/data\/LICENSE-DATA, which no rule of tools\/license\/policy\.json \(notices\.nested\) accounts for: read it, then record what it covers and whether the apps are built with it$/m)
  fails(set, [...rules, { crate: 'gone', under: 'vendor', covers: 'a crate no longer in the lockfile' }], /^the rule for gone vendor covers no file of the lockfile's crates: take it out of tools\/license\/policy\.json$/m)
  fails(set, [rules[0], { ...rules[1], needs: {} }, rules[2]], /^the rule for binding etc\/lib says the apps are not built with it, so it must say why and name what makes it so \(needs\)$/m)
  fails(set, [rules[0], { crate: 'binding', under: 'etc/lib', covers: 'the library in C', built: false, needs: { features: ['native'] } }, rules[2]], /must say why/)
  fails(set, [{ crate: 'tables', under: 'src/data/LICENSE-DATA' }, rules[1], rules[2]], /^the rule for tables src\/data\/LICENSE-DATA must name a crate, a file or folder under it, and what that covers$/m)
  // The conditions are read from cargo's answer: a feature switched off, a feature switched on, another platform.
  const moved = (over: Partial<Spec>) => set.map((c) => (c.name === 'binding' ? { ...c, ...over } : c))
  fails(moved({ features: [] }), rules, /^binding 1\.0\.0: the rule for etc\/lib says the apps are not built with it, but its feature native is off$/m)
  fails(moved({ targets: [null] }), rules, /^binding 1\.0\.0: the rule for etc\/lib says the apps are not built with it, but it is taken for \*, not for cfg\(windows\) alone$/m)
  fails(moved({ targets: ['cfg(windows)', 'cfg(unix)'] }), rules, /but it is taken for cfg\(unix\) and cfg\(windows\), not for cfg\(windows\) alone$/m)
  const lacks = [rules[0], { crate: 'binding', under: 'etc/lib', covers: 'the library in C', built: false, why: 'vendored is off.', needs: { lacks: ['vendored'] } }, rules[2]]
  assert.equal(n.account(records(set), lacks)[0].nested![0].built, false)
  fails(moved({ features: ['native', 'vendored'] }), lacks, /but its feature vendored is on$/m)
  // The file is never written from records nobody accounted for.
  assert.throws(() => n.notices(records(set), { mit: MIT }), /binding 1\.0\.0 ships files from inside its package that no rule has accounted for: pass the crates through account\(\) first/)

  // The policy's own rules are whole.
  const policy = g.loadPolicy().notices
  assert.ok(policy.why.length > 100 && Array.isArray(policy.combined))
  for (const r of policy.nested) {
    assert.ok(r.crate && r.under && r.covers, JSON.stringify(r))
    if (r.built === false) assert.ok(r.why && Object.keys(r.needs).length > 0, `${r.crate} ${r.under}`)
  }
})

test('the file: one copy of a text many crates share, under each name it is shipped as; the same file whatever order cargo answers in', () => {
  const shared = mitOf('The Shared Authors')
  const set: Spec[] = [
    { name: 'b', files: { 'LICENSE-MIT': shared, 'LICENSE-APACHE': 'Apache text' }, licence: 'MIT OR Apache-2.0' },
    { name: 'a', files: { LICENSE: shared } },
    { name: 'c', files: { 'LICENSE-MIT': `${shared}\r\n` }, licence: 'MIT OR Apache-2.0' },
  ]
  const text: string = n.notices(records(set), { mit: MIT })
  assert.equal(text, n.notices(records([...set].reverse()), { mit: MIT }), 'the same records, the same file')
  assert.ok(text.startsWith(`${n.TITLE}\n\n`) && text.endsWith('\n') && !text.endsWith('\n\n'))
  assert.match(text, /^1\. THE CRATES \(3\)$/m)
  assert.match(text, /^a 1\.0\.0 \| MIT \| https:\/\/crates\.io\/crates\/a\/1\.0\.0\nb 1\.0\.0 \| MIT OR Apache-2\.0 \| https:\/\/crates\.io\/crates\/b\/1\.0\.0\nc 1\.0\.0 \| /m)
  assert.match(text, /^3\. THE TEXTS THE CRATES SHIP \(2 distinct\)$/m)
  assert.equal(text.split('The Shared Authors').length - 1, 1, 'three crates, one copy')
  assert.match(text, /^Text 1 of 2\nLICENSE of a 1\.0\.0\nLICENSE-MIT of b 1\.0\.0, c 1\.0\.0\n-{100}\n\nMIT License\n\nCopyright \(c\) The Shared Authors\n/m)
  assert.match(text, /^Text 2 of 2\nLICENSE-APACHE of b 1\.0\.0\n-{100}\n\nApache text$/m)
  assert.match(text, /^None of the crates is under the Mozilla Public License\.$/m)
  assert.match(text, /^4\. CRATES WITH NO LICENCE TEXT OF THEIR OWN \(0\)\n-{100}\n\nEvery crate ships a text\.\n$/m)
  for (const line of text.split('\n').filter((l) => !/^https?:|\| https:/.test(l) && !l.includes('The Shared Authors'))) assert.ok(line.length <= 100, `no line of the tool's own is wider than 100: ${line}`)
  // Many crates under one text: the list folds, each later line indented.
  const many = Array.from({ length: 30 }, (_, i) => ({ name: `shared-crate-${String(i).padStart(2, '0')}`, files: { LICENSE: shared } }))
  const folded: string = n.notices(records(many), { mit: MIT })
  const head = folded.slice(folded.indexOf('Text 1 of 1\n'), folded.indexOf('\n\nMIT License'))
  assert.ok(head.split('\n').length > 5 && head.split('\n').slice(1, -1).every((l) => l.length <= 100))
  assert.match(head, /^LICENSE of shared-crate-00 1\.0\.0, .+,\n {2}shared-crate-\d\d 1\.0\.0,/m)
})

test('a crate that ships no text is listed with its authors and the licence taken; MIT is printed once, any other is the text a crate of that very licence ships, of its own repository first', () => {
  const mpl = 'Mozilla Public License Version 2.0\n==================================\n...'
  const set: Spec[] = [
    { name: 'bare-mit', licence: 'Zlib OR Apache-2.0 OR MIT', authors: ['Ann <ann@example.invalid>', 'Bo'], repository: 'https://example.invalid/bare' },
    { name: 'bare-anon', licence: 'MIT' },
    { name: 'bare-mpl', licence: 'MPL-2.0', authors: ['The Project'], repository: 'https://example.invalid/css' },
    { name: 'bare-bsd', licence: 'BSD-3-Clause', repository: 'https://example.invalid/alloc' },
    { name: 'donor-css', licence: 'MPL-2.0', files: { LICENSE: mpl }, repository: 'https://example.invalid/other' },
    { name: 'donor-bsd-elsewhere', licence: 'BSD-3-Clause', files: { LICENSE: 'BSD of someone else' }, repository: 'https://example.invalid/elsewhere' },
    { name: 'donor-bsd-sibling', licence: 'BSD-3-Clause', files: { 'LICENSE.txt': 'BSD of the same project' }, repository: 'https://example.invalid/alloc' },
    // Of the same repository and first by name, so it would stand in if a crate that offers a choice could.
    { name: 'a-choice-crate', licence: 'BSD-3-Clause OR MIT', files: { LICENSE: 'a choice is not that very licence' }, repository: 'https://example.invalid/alloc' },
    // Files that are reproduced and are not a licence's text: the crate is still without one of its own.
    { name: 'bare-authors', licence: 'BSD-3-Clause', authors: ['Di'], files: { AUTHORS: 'Di and friends', 'COPYRIGHT-OTHER.txt': 'see the licence files', 'LICENSE.spdx': 'SPDXVersion: SPDX-2.1' }, repository: 'https://example.invalid/none' },
    { name: 'bare-inside', licence: 'MIT', files: { 'vendor/c/LICENSE': 'the terms of what it carries' } },
  ]
  const accounted: Rec[] = n.account(records(set), [{ crate: 'bare-inside', under: 'vendor/c', covers: 'a library in C' }])
  const text: string = n.notices(accounted, { mit: MIT })
  assert.match(text, /^4\. CRATES WITH NO LICENCE TEXT OF THEIR OWN \(6\)$/m)
  assert.match(text, /^bare-authors 1\.0\.0\n {2}declared: BSD-3-Clause\n {2}taken: {4}BSD-3-Clause\n {2}authors: {2}Di\n {2}project: {2}https:\/\/example\.invalid\/none\n {2}text: {5}BSD-3-Clause, as donor-bsd-elsewhere 1\.0\.0 ships it above \(LICENSE\)\n$/m, 'a list of authors, a copyright file and an SPDX record are not the licence')
  assert.match(text, /^AUTHORS of bare-authors 1\.0\.0\n-{100}\n\nDi and friends$/m, 'and what it does ship is still reproduced')
  assert.match(text, /^bare-inside 1\.0\.0\n {2}declared: MIT\n {2}taken: {4}MIT\n/m, 'the terms of something a package carries are not the crate\'s own')
  assert.match(text, /^bare-mit 1\.0\.0\n {2}declared: Zlib OR Apache-2\.0 OR MIT\n {2}taken: {4}MIT\n {2}authors: {2}Ann <ann@example\.invalid>, Bo\n {2}project: {2}https:\/\/example\.invalid\/bare\n {2}notice: {3}Copyright \(c\) Ann <ann@example\.invalid>, Bo\n$/m)
  assert.match(text, /^bare-anon 1\.0\.0\n {2}declared: MIT\n {2}taken: {4}MIT\n {2}authors: {2}the authors of bare-anon\n {2}notice: {3}Copyright \(c\) the authors of bare-anon\n$/m)
  assert.match(text, /^bare-mpl 1\.0\.0\n {2}declared: MPL-2\.0\n {2}taken: {4}MPL-2\.0\n {2}authors: {2}The Project\n {2}project: {2}https:\/\/example\.invalid\/css\n {2}text: {5}MPL-2\.0, as donor-css 1\.0\.0 ships it above \(LICENSE\)\n$/m)
  assert.match(text, /^bare-bsd 1\.0\.0\n(?: {2}.*\n)* {2}text: {5}BSD-3-Clause, as donor-bsd-sibling 1\.0\.0 ships it above \(LICENSE\.txt\)\n$/m, 'the crate of its own repository, not the first by name')
  assert.equal(text.split('Permission is hereby granted').length - 1, 1, 'the MIT License once, after the list')
  assert.ok(text.slice(0, text.indexOf('\n5. FILES FROM INSIDE A PACKAGE')).replace(/\n-{100}\s*$/, '').trimEnd().endsWith(MIT), 'and it closes the section')
  // The MPL crates, shipping a text or not, are in the source section.
  assert.match(text, /^bare-mpl 1\.0\.0\n {2}package: https:\/\/crates\.io\/api\/v1\/crates\/bare-mpl\/1\.0\.0\/download\n {2}page: {4}https:\/\/crates\.io\/crates\/bare-mpl\/1\.0\.0\n {2}project: https:\/\/example\.invalid\/css\ndonor-css 1\.0\.0\n {2}package: /m)
  // What has no answer is refused, not guessed.
  assert.throws(() => n.notices(records([{ name: 'lonely', licence: 'MPL-2.0' }]), { mit: MIT }), /lonely 1\.0\.0 ships no licence text and is taken under MPL-2\.0, and no crate whose only licence is MPL-2\.0 ships one to stand in/)
  assert.throws(() => n.notices(records([{ name: 'silent', licence: null }]), { mit: MIT }), /silent 1\.0\.0 declares no licence/)
  assert.throws(() => n.notices(records([{ name: 'closed', licence: 'GPL-3.0-only' }]), { mit: MIT }), /no licence it offers has a place/)
  // The file a manifest names is the crate's own text, whatever it is called.
  assert.match(n.notices(records([{ name: 'odd', files: { 'TERMS.txt': 'terms' }, licenseFile: 'TERMS.txt' }]), { mit: MIT }), /^4\. CRATES WITH NO LICENCE TEXT OF THEIR OWN \(0\)$/m)
  // Under several licences at once with fewer licence files than licences: looked at, not passed over.
  const two = { name: 'two', licence: 'MIT AND BSD-3-Clause', files: { 'LICENSE-MIT': mitOf('Two') } }
  assert.throws(() => n.notices(records([two]), { mit: MIT }), /two 1\.0\.0 is under MIT AND BSD-3-Clause, 2 licences at once, and ships 1 licence file: if that one file holds every text, name the crate in tools\/license\/policy\.json \(notices\.combined\); if not, a text is missing/)
  assert.match(n.notices(records([two]), { mit: MIT, combined: ['two'] }), /^two 1\.0\.0 \| MIT AND BSD-3-Clause \| /m)
  assert.match(n.notices(records([{ ...two, files: { 'LICENSE-MIT': mitOf('Two'), 'LICENSE-BSD': 'bsd' } }]), { mit: MIT }), /^3\. THE TEXTS THE CRATES SHIP \(2 distinct\)$/m)
  assert.match(n.notices(records([{ name: 'choice', licence: '(MIT OR Apache-2.0) AND Unicode-3.0', files: { 'LICENSE-MIT': mitOf('C'), 'LICENSE-UNICODE': 'unicode' } }]), { mit: MIT }), /^1\. THE CRATES \(1\)$/m, 'one text for each licence of the smallest set it may be taken under')
})

test('the MIT License is printed for other crates only while it is, word for word, the text crates themselves ship', () => {
  const ten = records(Array.from({ length: 10 }, (_, i) => ({ name: `m${i}`, files: { 'LICENSE-MIT': mitOf(`author ${i}`).replace(/\n/g, '\r\n').replace(/ of /g, '\n  of ') } })))
  assert.deepEqual(n.mitProblems(ten, MIT), [], 'ten copies, whatever their line breaks')
  assert.match(n.mitProblems(ten.slice(1), MIT)[0], /word for word in the texts of 9 crates; at least 10 were expected/)
  assert.match(n.mitProblems(ten, MIT.replace('free of charge', 'free of all charge'))[0], /in the texts of 0 crates/)
  assert.deepEqual(n.mitProblems(ten, MIT, 3), [])
})

// ---------------------------------------------------------------------------------------------------------------
// The standard library

/** A page laid out as the toolchain's COPYRIGHT-library.html is, with `texts` licence texts in it. */
const stdHtml = (texts = 12, more = '') => `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Copyright notices for The Rust Standard Library</title></head>
<body>
<h1>Copyright notices for The Rust Standard Library</h1>
<p>This file describes the copyright and licensing information for the Rust
Standard Library, including its dependencies. See <a href="https://example.invalid/rust">the project</a> &amp; <a href="#in-tree-files">what follows</a>.</p>
<h2>Table of Contents</h2>
<ul>
    <li><a href="#in-tree-files">In-tree files</a></li>
    <li><a href="#out-of-tree-dependencies">Out-of-tree dependencies</a></li>
</ul>
<h2 id="in-tree-files">In-tree files</h2>
<p>The following licenses cover the in-tree source files that were used in this release:</p>
<h3>\u{1F4C1} <code>library/core</code></h3>
<p><strong>File/Directory:</strong> <code>library/core</code></p>
<p><strong>License:</strong> Apache-2.0 OR MIT</p>
<p><strong>Copyright:</strong> The Rust Project Developers &copy; 2010 &#169; &#xA9; &lt;see AUTHORS&gt;</p>
<h2 id="out-of-tree-dependencies">Out-of-tree dependencies</h2>
${Array.from({ length: texts }, (_, i) => `<h3>\u{1F4E6} dep${i}-1.0.${i}</h3>
<p><b>URL:</b> <a href="https://crates.io/crates/dep${i}/1.0.${i}">https://crates.io/crates/dep${i}/1.0.${i}</a></p>
<p><b>Authors:</b> Someone &lt;someone@example.invalid&gt;</p>
<details><summary><code>LICENSE-APACHE</code></summary>
<pre>

                              Apache License   \t
   a line that is kept as it stands, however wide it is: ${'wide '.repeat(30)}&lt;end&gt;
        indented, for dep${i}

</pre>
</details>`).join('\n')}
${more}
</body>
</html>
`

test('the standard library\'s notices are the toolchain\'s own page as plain text: its words whole, each licence text as it stands, links written out', () => {
  const text: string = n.stdText(stdHtml())
  const lines = text.split('\n')
  assert.equal(lines[0], 'COPYRIGHT NOTICES FOR THE RUST STANDARD LIBRARY', 'the page\'s heading; its <title> is no part of the text')
  assert.match(text, /^This file describes the copyright and licensing information for the Rust Standard Library, including\nits dependencies\. See the project \(https:\/\/example\.invalid\/rust\) & what follows\.$/m, 'a paragraph folded at 100; a link out is written with its address, a link into the page is its words')
  assert.doesNotMatch(text, /Table of Contents|^- /im, 'the table of contents is the one thing left out')
  assert.match(text, /^IN-TREE FILES\n\nThe following licenses cover the in-tree source files that were used in this release:\n\nlibrary\/core\n\nFile\/Directory: library\/core\n\nLicense: Apache-2\.0 OR MIT\n\nCopyright: The Rust Project Developers © 2010 © © <see AUTHORS>\n\nOUT-OF-TREE DEPENDENCIES\n\ndep0-1\.0\.0\n\nURL: https:\/\/crates\.io\/crates\/dep0\/1\.0\.0\n\nAuthors: Someone <someone@example\.invalid>\n\nLICENSE-APACHE:\n\n {30}Apache License\n {3}a line that is kept as it stands, however wide it is: (?:wide ){30}<end>\n {8}indented, for dep0\n\ndep1-1\.0\.1\n/m)
  assert.equal([...text.matchAll(/^ {30}Apache License$/gm)].length, 12, 'every licence text')
  assert.ok(lines.filter((l) => !l.includes('wide wide')).every((l) => l.length <= 100) && !/[ \t]$/m.test(text) && !text.includes('\r') && !/\n{3}/.test(text))
  assert.doesNotMatch(text, /<\/?(?:p|pre|details|summary|code|b|strong|h[1-6]|a|ul|li|body|html)\b|&(?:amp|lt|gt|copy|#\d+|#x[0-9a-f]+);/i, 'no tag and no character reference is left; what a reference stood for is')
  assert.equal(n.stdText(stdHtml().replace(/\n/g, '\r\n')), text, 'whatever the page\'s line ends')
  // Another file in its place, a page cut short, or a reference this does not read, is not printed as the notices.
  assert.throws(() => n.stdText(stdHtml(9)), /share\/doc\/rust\/COPYRIGHT-library\.html does not read as the Rust standard library's copyright notices \(9 licence texts in it\)/)
  assert.throws(() => n.stdText('<html><body><h1>Copyright notices for The Rust Compiler</h1></body></html>'), /does not read as the Rust standard library's copyright notices \(0 licence texts in it\)/)
  assert.throws(() => n.stdText(stdHtml().replace(/Rust\s+Standard Library/g, 'Rust Compiler')), /does not read as/)
  assert.throws(() => n.stdText(stdHtml(12, '<p>Jos&eacute;</p>')), /the standard library's notices use the character reference &eacute;, which this does not read/)
  assert.throws(() => n.stdText(stdHtml(12, '<p></p>')), /holds the character this tool marks a licence text's place with/)

  // The toolchain is asked which rustc it is and where it lives, and the page is read from below that.
  const asked: string[][] = []
  const rustc = (answers: Record<string, { status: number; stdout?: string; stderr?: string }>) => (cmd: string, args: string[]) => { asked.push([cmd, ...args]); return { stdout: '', stderr: '', ...answers[args.join(' ')] } }
  const good = { '--version': { status: 0, stdout: 'rustc 1.97.0 (0123456789 2026-08-06)\n' }, '--print sysroot': { status: 0, stdout: '/toolchains/1.97.0-host\n' } }
  const read_: string[] = []
  const fs = { list: () => [], read: (path: string) => { read_.push(path); return stdHtml() } }
  assert.deepEqual(n.stdNotices(rustc(good), fs), { version: '1.97.0', text })
  assert.deepEqual(asked, [['rustc', '--version'], ['rustc', '--print', 'sysroot']])
  assert.deepEqual(read_, [join('/toolchains/1.97.0-host', n.STD_FILE)])
  assert.equal(n.STD_FILE, 'share/doc/rust/COPYRIGHT-library.html')
  assert.throws(() => n.stdNotices(rustc({ ...good, '--version': { status: 1, stderr: 'no default toolchain\n' } }), fs), /rustc --version failed: no default toolchain/)
  assert.throws(() => n.stdNotices(rustc({ ...good, '--version': { status: 0, stdout: 'cargo 1.97.0' } }), fs), /rustc --version did not name a version/)
  assert.throws(() => n.stdNotices(rustc({ ...good, '--print sysroot': { status: 1, stderr: 'broken' } }), fs), /rustc --print sysroot failed: broken/)
  const gone = { list: () => [], read: () => { throw Object.assign(new Error('no such file'), { code: 'ENOENT' }) } }
  assert.throws(() => n.stdNotices(rustc(good), gone), /the Rust toolchain's share\/doc\/rust\/COPYRIGHT-library\.html could not be read \(ENOENT\): rustc 1\.97\.0 should ship it with its rustc component/)

  // In the file it is the last section, under the rustc it came with.
  const withStd: string = n.notices(records([{ name: 'plain', files: { LICENSE: 'plain' } }]), { mit: MIT, std: { version: '1.97.0', text } })
  assert.ok(withStd.endsWith(`${text}\n`))
  assert.match(withStd, /^-{100}\n6\. THE RUST STANDARD LIBRARY \(rustc 1\.97\.0\)\n-{100}\n\nEvery app is also built with the Rust standard library and the crates that library is itself built/m)
  assert.match(withStd, /^These notices are about the crates and the Rust standard library alone\./m)
  const without: string = n.notices(records([{ name: 'plain', files: { LICENSE: 'plain' } }]), { mit: MIT })
  assert.doesNotMatch(without, /THE RUST STANDARD LIBRARY/)
  assert.match(without, /^These notices are about the crates alone\./m)
})

// ---------------------------------------------------------------------------------------------------------------
// A built file

/**
 * A zip archive of the entries given, each stored or deflated, as an .apk or an .ipa is laid out. An entry may carry
 * an extra field in its local header (`extra`, as zipalign pads an .apk) and another in the directory
 * (`centralExtra`), or leave its sizes to a record after its bytes (`descriptor`, as a streamed archive does); the
 * archive may end with a comment.
 */
function zip(entries: { name: string; data: Buffer; store?: boolean; extra?: Buffer; centralExtra?: Buffer; descriptor?: boolean }[], comment = ''): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let at = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const body = e.store ? e.data : deflateRawSync(e.data)
    const extra = e.extra ?? Buffer.alloc(0)
    const centralExtra = e.centralExtra ?? Buffer.alloc(0)
    const flags = e.descriptor ? 8 : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(flags, 6); local.writeUInt16LE(e.store ? 0 : 8, 8)
    if (!e.descriptor) { local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.data.length, 22) }
    local.writeUInt16LE(name.length, 26); local.writeUInt16LE(extra.length, 28)
    const after = Buffer.alloc(e.descriptor ? 16 : 0)
    if (e.descriptor) { after.writeUInt32LE(0x08074b50, 0); after.writeUInt32LE(body.length, 8); after.writeUInt32LE(e.data.length, 12) }
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(flags, 8); head.writeUInt16LE(e.store ? 0 : 8, 10)
    head.writeUInt32LE(body.length, 20); head.writeUInt32LE(e.data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt16LE(centralExtra.length, 30); head.writeUInt32LE(at, 42)
    locals.push(local, name, extra, body, after)
    central.push(head, name, centralExtra)
    at += 30 + name.length + extra.length + body.length + after.length
  }
  const dir = Buffer.concat(central)
  const note = Buffer.from(comment)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(at, 16); end.writeUInt16LE(note.length, 20)
  return Buffer.concat([...locals, dir, end, note])
}

test('a built file holds the notices when they are inside it whole: a text file, a binary, or an entry of a zip archive, stored or deflated', () => {
  const text = 'THE NOTICES\nline two\n'.repeat(200)
  const noise = (len: number, seed: number) => Buffer.from(Array.from({ length: len }, (_, i) => (i * 31 + seed) % 251))
  const binary = Buffer.concat([noise(5000, 1), Buffer.from(text), noise(700, 2)])
  assert.deepEqual(n.carries(Buffer.from(text), text), [''])
  assert.deepEqual(n.carries(binary, text), [''], 'a program with the text compiled in')
  assert.deepEqual(n.carries(noise(9000, 3), text), [])
  assert.deepEqual(n.carries(Buffer.from(text.slice(0, -1)), text), [], 'all but its last byte is not the notices')
  const apk = zip([
    { name: 'classes.dex', data: noise(300, 4) },
    { name: 'lib/arm64-v8a/libcrimson_noir_app_lib.so', data: binary },
    { name: 'assets/licenses/RUST-CRATES.txt', data: Buffer.from(text), store: true },
    { name: 'assets/other.txt', data: Buffer.from(text.replace('line two', 'line 2')) },
  ])
  assert.deepEqual(n.zipEntries(apk).map((e: { name: string; method: number; size: number }) => [e.name, e.method, e.size]), [['classes.dex', 8, 300], ['lib/arm64-v8a/libcrimson_noir_app_lib.so', 8, binary.length], ['assets/licenses/RUST-CRATES.txt', 0, text.length], ['assets/other.txt', 8, text.length - 2]])
  // An archive names the entries that hold the notices, stored or deflated, and never passes as a plain file.
  assert.deepEqual(n.carries(apk, text), ['lib/arm64-v8a/libcrimson_noir_app_lib.so', 'assets/licenses/RUST-CRATES.txt'])
  assert.deepEqual(n.zipRead(apk, n.zipEntries(apk)[2]), Buffer.from(text), 'a stored entry is read as it stands')
  assert.deepEqual(n.zipRead(apk, n.zipEntries(apk)[1]), binary)
  // As real packages are laid out: padding in a local header, a field in the directory, sizes after the bytes, and a
  // comment at the archive's end.
  const laid = zip([
    { name: 'padded.so', data: binary, store: true, extra: Buffer.alloc(37, 0) },
    { name: 'stream.txt', data: Buffer.from(text), descriptor: true, centralExtra: Buffer.from([0x55, 0x54, 5, 0, 1, 0, 0, 0, 0]) },
    { name: 'other.bin', data: noise(4000, 8), centralExtra: Buffer.alloc(12, 1), extra: Buffer.alloc(4, 2) },
  ], 'signed by nobody')
  assert.deepEqual(n.zipEntries(laid).map((e: { name: string }) => e.name), ['padded.so', 'stream.txt', 'other.bin'])
  assert.deepEqual(n.zipRead(laid, n.zipEntries(laid)[0]), binary)
  assert.deepEqual(n.zipRead(laid, n.zipEntries(laid)[1]), Buffer.from(text), 'its sizes are the directory\'s, not the zeroes of its local header')
  assert.deepEqual(n.carries(laid, text), ['padded.so', 'stream.txt'])
  // A directory that points at bytes which are not an entry: not read.
  const lost = Buffer.from(laid)
  lost.writeUInt32LE(0, n.zipEntries(laid)[1].header)
  assert.equal(n.zipRead(lost, n.zipEntries(lost)[1]), null, 'no local header where the directory says')
  assert.deepEqual(n.carries(lost, text), ['padded.so'])
  const deflated = zip([{ name: 'classes.dex', data: noise(300, 4) }, { name: 'Payload/App.app/App', data: binary }, { name: 'Payload/App.app/licenses/RUST-CRATES.txt', data: Buffer.from(text) }])
  assert.deepEqual(n.carries(deflated, text), ['Payload/App.app/App', 'Payload/App.app/licenses/RUST-CRATES.txt'], 'each entry that holds them is named')
  assert.deepEqual(n.carries(zip([{ name: 'a', data: noise(9000, 5) }, { name: 'b', data: Buffer.from(text.slice(0, 100)) }]), text), [])
  // Bytes that are not a zip this reads, or a damaged one, hold nothing; nothing throws.
  assert.equal(n.zipEntries(noise(100, 6)), null)
  assert.equal(n.zipEntries(deflated.subarray(0, deflated.length - 30)), null, 'no end record')
  // Damage that takes the first entry's bytes and the second's own header: neither is read, neither is named, the
  // third still is.
  const broken = Buffer.from(deflated)
  broken.fill(0xff, 60, 400)
  assert.equal(n.zipRead(broken, n.zipEntries(broken)[0]), null, 'bytes that do not inflate')
  assert.equal(n.zipRead(broken, n.zipEntries(broken)[1]), null, 'no local header where the directory says')
  assert.deepEqual(n.carries(broken, text), ['Payload/App.app/licenses/RUST-CRATES.txt'])
  const only = zip([{ name: 'licenses/RUST-CRATES.txt', data: Buffer.from(text) }])
  only.fill(0xff, 30 + 'licenses/RUST-CRATES.txt'.length, 30 + 'licenses/RUST-CRATES.txt'.length + 8)
  assert.deepEqual(n.carries(only, text), [], 'an entry that does not inflate is not a pass')
  // A method this does not read (anything but stored and deflated) is not a pass either.
  const odd = zip([{ name: 'a', data: Buffer.from(text) }])
  odd.writeUInt16LE(93, odd.length - 22 - 47 + 10)
  assert.equal(n.zipEntries(odd)[0].method, 93)
  assert.deepEqual(n.carries(odd, text), [])
})

// ---------------------------------------------------------------------------------------------------------------
// The command line

test('the command line: --write writes what the registry and the toolchain give, --check passes on it, names the first line that differs and refuses another rustc; cargo failing is neither', () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-notices-'))
  try {
    const set: Spec[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ name: `mit-${i}`, files: { 'LICENSE-MIT': mitOf(`the authors of mit-${i}`) } })),
      { name: 'bare', licence: 'MIT OR Apache-2.0', authors: ['Cy'] },
      { name: 'carrier', features: ['system'], files: { LICENSE: mitOf('the authors of carrier'), 'vendor/c/COPYING': 'the terms of a library in C' } },
    ]
    const policy = { nested: [{ crate: 'carrier', under: 'vendor/c', covers: 'a library in C', built: false, why: 'The system\'s copy is linked.', needs: { features: ['system'] } }], combined: [] }
    // The tool's world: cargo's answer, a rustc with its page below its sysroot, and the registry's folders.
    const world = (crates: Spec[], rustc = '1.97.0') => {
      const { metadata, fs } = registry(crates)
      const asked: string[][] = []
      const run = (cmd: string, args: string[]) => {
        asked.push([cmd, ...args])
        if (cmd === 'cargo') return { status: 0, stdout: JSON.stringify(metadata), stderr: '' }
        return { status: 0, stdout: args[0] === '--version' ? `rustc ${rustc} (0123456789 2026-08-06)\n` : '/sysroot\n', stderr: '' }
      }
      const std = join('/sysroot', n.STD_FILE)
      return { metadata, asked, run, fs: { list: fs.list, read: (path: string) => (path === std ? stdHtml() : fs.read(path)) } }
    }
    const w = world(set)
    const run = (argv: string[], over: Record<string, unknown> = {}) => { const lines: string[] = []; const code = n.main(argv, { run: w.run, log: (l: string) => lines.push(l), fs: w.fs, root, policy, ...over }); return { code, lines } }

    const missing = run(['--check'])
    assert.equal(missing.code, 1)
    assert.match(missing.lines[0], /^crate-notices: src-tauri\/notices\/RUST-CRATES\.txt is missing: node tools\/license\/notices\.mjs --write$/)
    const wrote = run(['--write'])
    assert.equal(wrote.code, 0)
    assert.match(wrote.lines[0], /^crate-notices: 12 crates and the standard library of rustc 1\.97\.0, \d+ bytes written to src-tauri\/notices\/RUST-CRATES\.txt$/)
    const file = join(root, n.NOTICES_FILE)
    const written = readFileSync(file, 'utf8')
    assert.equal(written, n.notices(n.account(n.crateRecords(w.metadata, w.fs), policy.nested), { mit: MIT, std: { version: '1.97.0', text: n.stdText(stdHtml()) } }))
    assert.equal(wrote.lines[0], `crate-notices: 12 crates and the standard library of rustc 1.97.0, ${Buffer.byteLength(written)} bytes written to src-tauri/notices/RUST-CRATES.txt`)
    assert.match(written, /^carrier 1\.0\.0\n {2}vendor\/c\/COPYING\n {4}covers: a library in C\n {4}text: {3}not reproduced, because no app is built with it\. The system's copy is linked\.\n$/m, 'the policy\'s rules are applied')
    assert.equal(written.includes('the terms of a library in C'), false)
    assert.match(written, /^6\. THE RUST STANDARD LIBRARY \(rustc 1\.97\.0\)$/m)
    const cargo = w.asked.find((a) => a[0] === 'cargo')!
    assert.deepEqual(cargo.slice(0, 6), ['cargo', 'metadata', '--locked', '--all-features', '--format-version', '1'], 'every feature on, so the crates are the lockfile\'s')
    assert.equal(cargo[7], join(ROOT, n.WORKSPACE, 'Cargo.toml'))
    const same = run(['--check'])
    assert.equal(same.code, 0)
    assert.equal(same.lines[0], `crate-notices: 12 crates and the standard library of rustc 1.97.0, ${Buffer.byteLength(written)} bytes, as the registry and the toolchain give them`)

    writeFileSync(file, written.replace('Copyright (c) the authors of mit-3', 'Copyright (c) someone else'))
    const differs = run(['--check'])
    assert.equal(differs.code, 1)
    assert.match(differs.lines[0], /^crate-notices: src-tauri\/notices\/RUST-CRATES\.txt is not what the registry and the toolchain give \(line \d+: the committed file has "Copyright \(c\) someone else", a fresh one has "Copyright \(c\) the authors of mit-3"\): node tools\/license\/notices\.mjs --write, and read the diff$/)
    assert.equal(readFileSync(file, 'utf8').includes('someone else'), true, '--check writes nothing')
    writeFileSync(file, written)

    // Another rustc on this machine: its standard library's notices are not the ones the apps are built with, so
    // the answer is the toolchain, not a rewrite; and nothing is compared line by line.
    const newer = world(set, '1.98.0')
    const other = run(['--check'], { run: newer.run, fs: newer.fs })
    assert.equal(other.code, 1)
    assert.deepEqual(other.lines, ['crate-notices: src-tauri/notices/RUST-CRATES.txt holds the standard library\'s notices of rustc 1.97.0, and this machine\'s rustc is 1.98.0: check it with the toolchain the apps are built with (RUST_TOOLCHAIN in the workflows), and write it again only when they are built with 1.98.0'])
    assert.equal(readFileSync(file, 'utf8'), written)

    const failed = run(['--check'], { run: () => ({ status: 101, stdout: '', stderr: 'error: failed to download\nCaused by: network' }) })
    assert.equal(failed.code, 2, 'cargo could not answer: not a pass, and not a finding')
    assert.match(failed.lines[0], /^crate-notices: cargo metadata for src-tauri failed: /)
    const noRustc = run(['--check'], { run: (cmd: string, args: string[]) => (cmd === 'rustc' ? { status: 1, stdout: '', stderr: 'no toolchain' } : w.run(cmd, args)) })
    assert.deepEqual([noRustc.code, noRustc.lines], [1, ['crate-notices: rustc --version failed: no toolchain']])
    const few = world(set.slice(3))
    const tooFew = run(['--write'], { run: few.run, fs: few.fs })
    assert.equal(tooFew.code, 1)
    assert.match(tooFew.lines[0], /^crate-notices: the MIT License as LICENSES\/MIT\.txt has it is word for word in the texts of 8 crates/)
    // What the policy does not account for is named, every line of it, and nothing is written.
    const unruled = run(['--write'], { policy: { nested: [{ crate: 'gone', under: 'x', covers: 'nothing now' }] } })
    assert.equal(unruled.code, 1)
    assert.deepEqual(unruled.lines, [
      'crate-notices: carrier 1.0.0 ships vendor/c/COPYING, which no rule of tools/license/policy.json (notices.nested) accounts for: read it, then record what it covers and whether the apps are built with it',
      'crate-notices: the rule for gone x covers no file of the lockfile\'s crates: take it out of tools/license/policy.json',
    ])
    assert.equal(readFileSync(file, 'utf8'), written)
    // With no policy given, the repository's own is read.
    const own: string[] = []
    assert.equal(n.main(['--check'], { run: w.run, log: (l: string) => own.push(l), fs: w.fs, root }), 1)
    assert.match(own.join('\n'), /^crate-notices: carrier 1\.0\.0 ships vendor\/c\/COPYING, which no rule/m)
    assert.match(own.join('\n'), /^crate-notices: the rule for regex-syntax src\/unicode_tables\/LICENSE-UNICODE covers no file of the lockfile's crates/m)

    // carried: the committed file of this root, looked for in each file named.
    mkdirSync(join(root, 'out'))
    const exe = join(root, 'out', 'app.exe')
    writeFileSync(exe, Buffer.concat([Buffer.alloc(4000, 9), Buffer.from(written), Buffer.alloc(100, 8)]))
    const apk = join(root, 'out', 'app.apk')
    writeFileSync(apk, zip([{ name: 'lib/arm64-v8a/libapp.so', data: readFileSync(exe) }, { name: 'assets/licenses/RUST-CRATES.txt', data: Buffer.from(written), store: true }]))
    const empty = join(root, 'out', 'empty.bin')
    writeFileSync(empty, Buffer.alloc(5000, 7))
    const cut = join(root, 'out', 'cut.exe')
    writeFileSync(cut, Buffer.concat([Buffer.alloc(4000, 9), Buffer.from(written).subarray(0, -1)]))
    const held = run(['carried', exe, apk, file])
    assert.equal(held.code, 0)
    assert.equal(held.lines[0], `crate-notices: ${exe} holds the ${Buffer.byteLength(written)} bytes of src-tauri/notices/RUST-CRATES.txt`)
    assert.equal(held.lines[1], `crate-notices: ${apk} holds the ${Buffer.byteLength(written)} bytes of src-tauri/notices/RUST-CRATES.txt (inside lib/arm64-v8a/libapp.so, assets/licenses/RUST-CRATES.txt)`)
    assert.equal(held.lines.length, 3)
    // Each way of failing by itself: a file without them, a file with all but their last byte, a file that is not there.
    assert.deepEqual(run(['carried', empty]), { code: 1, lines: [`crate-notices: ${empty} does not hold src-tauri/notices/RUST-CRATES.txt whole`] })
    assert.deepEqual(run(['carried', cut]), { code: 1, lines: [`crate-notices: ${cut} does not hold src-tauri/notices/RUST-CRATES.txt whole`] })
    const gone = join(root, 'out', 'gone.exe')
    assert.deepEqual(run(['carried', gone]), { code: 1, lines: [`crate-notices: ${gone} could not be read (ENOENT)`] })
    // One bad file among good ones fails the run, and the good ones are still named.
    const mixed = run(['carried', exe, empty, apk])
    assert.equal(mixed.code, 1)
    assert.deepEqual(mixed.lines.map((l) => / holds the \d+ bytes /.test(l)), [true, false, true])

    for (const argv of [[], ['carried'], ['--check', 'x'], ['--frobnicate']]) {
      const usage = run(argv)
      assert.equal(usage.code, 1)
      assert.match(usage.lines[0], /^usage: node tools\/license\/notices\.mjs --write/)
    }
    assert.equal(run(['--help']).code, 0)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// ---------------------------------------------------------------------------------------------------------------
// Where the file travels

test('the shell compiles the notices in and lends them to the page, every package ships them as a resource, and the name scan leaves other people\'s texts alone', () => {
  const rs = read('src-tauri/src/notices.rs')
  assert.match(rs, /^pub const RUST_CRATES: &str = include_str!\("\.\.\/notices\/RUST-CRATES\.txt"\);$/m)
  assert.match(rs, /^#\[tauri::command\]\npub fn third_party_notices\(\) -> &'static str \{\n {4}RUST_CRATES\n\}$/m)
  assert.ok(rs.includes(`const TITLE: &str = "${n.TITLE}\\n";`), 'its own test looks for the title the tool writes')
  const lib = read('src-tauri/src/lib.rs')
  assert.match(lib, /^mod notices;$/m)
  assert.match(lib, /generate_handler!\[[^\]]*\bnotices::third_party_notices\]/)
  assert.equal(n.NOTICES_FILE, 'src-tauri/notices/RUST-CRATES.txt')
  // What is built is compared with this file byte for byte on every runner, so git converts no line end in it.
  assert.match(read('.gitattributes'), /^src-tauri\/notices\/RUST-CRATES\.txt -text$/m)
  assert.equal(read(n.NOTICES_FILE).includes('\r'), false)

  const conf = JSON.parse(read('src-tauri/tauri.conf.json'))
  assert.deepEqual(conf.bundle.resources, { 'notices/RUST-CRATES.txt': 'licenses/RUST-CRATES.txt' }, 'the base config, so every target\'s package has it')
  // The model overlay adds its own resources as a map too: a config given with --config is merged key by key, so
  // both maps survive; a list there would replace this one.
  const overlay = JSON.parse(read('src-tauri/tauri.model.conf.json'))
  assert.equal(Array.isArray(overlay.bundle.resources), false)
  assert.equal('notices/RUST-CRATES.txt' in overlay.bundle.resources, false)
  for (const name of ['tauri.tiny.conf.json']) assert.equal(Array.isArray(JSON.parse(read(`src-tauri/${name}`)).bundle?.resources ?? {}), false, name)
  assert.match(JSON.parse(read('src-tauri/capabilities/default.json')).description, /src\/notices\.rs, the notices of the crates the app is built with, one fixed text, read only/)

  const policy = g.loadPolicy()
  assert.match(n.NOTICES_FILE, new RegExp(policy.marks.notOurs), 'other people\'s licence texts are not searched for names')
  assert.deepEqual(g.gate().problems, { crates: [], names: [], assets: [] })
})

test('CI reads the registry for the notices, and the build matrix and the Windows workflow read what they built for them', () => {
  const checks = read('tools/selfheal/checks.sh')
  assert.match(checks, /^ {4}crate-licences\) node tools\/license\/gate\.mjs crates --check && node tools\/license\/notices\.mjs --check ;;$/m)
  const matrix = read('.github/workflows/build-matrix.yml')
  const step = /\n {6}- name: What was built holds the notices of the Rust crates it is built with, whole[^\n]*\n {8}if: \$\{\{ !startsWith\(matrix\.target, 'uefi-'\) \}\}\n(?: {8}#[^\n]*\n)+ {8}run: \|\n((?: {10}[^\n]*\n)+)/.exec(matrix)
  assert.ok(step, 'one step for every app target')
  const body = step[1]
  assert.match(body, /^ {10}\[ -f tools\/license\/notices\.mjs \] \|\| \{ echo "this commit predates the crates' notices: there is nothing to hold"; exit 0; \}$/m, 'a commit from before the notices, built by hand, has none')
  assert.match(body, /^ {12}windows-arm64\) files=\(out\/windows-arm64\/crimson-noir-app_\*\.exe\) ;;$/m, 'the bare executable, as published')
  assert.match(body, /^ {12}linux-\*\) files=\(src-tauri\/target\/release\/crimson-noir-app\) ;;$/m)
  assert.match(body, /^ {12}macos-universal\) files=\("\$MAC_APP"\/\*\.app\/Contents\/MacOS\/\* "\$MAC_APP"\/\*\.app\/Contents\/Resources\/licenses\/RUST-CRATES\.txt\) ;;$/m)
  assert.match(body, /^ {12}android-apk\) files=\(out\/android-apk\/\*\.apk\) ;;$/m, 'the package itself, read as an archive')
  assert.match(body, /^ {12}ios-ipa\) files=\(out\/ios-ipa\/\*\.ipa\) ;;$/m)
  assert.match(body, /^ {12}\*\) echo "::error::no file is named for \$\{\{ matrix\.target \}\}"; exit 1 ;;$/m, 'a new target cannot slip past unnamed')
  assert.match(body, /^ {10}node tools\/license\/notices\.mjs carried "\$\{files\[@\]\}"$/m)
  assert.ok(matrix.indexOf('- name: What was built holds the notices') > matrix.indexOf('- name: Build the target'), 'after the build')
  // Every app target the build matrix names has a line; the UEFI ones carry NOTICE.txt on their media instead.
  const targets = [...matrix.matchAll(/^ {10}- target: (\S+)$/gm)].map((m) => m[1]).filter((t) => !t.startsWith('uefi-'))
  assert.deepEqual(targets, ['windows-arm64', 'linux-x64', 'linux-arm64', 'macos-universal', 'android-apk', 'ios-ipa'])
  for (const t of targets) assert.ok(new RegExp(`^ {12}${t.startsWith('linux-') ? 'linux-\\*' : t}\\) files=`, 'm').test(body), t)
  // The step runs notices.mjs, which loads gate.mjs, which loads held.mjs: a pull request that changes only one of
  // them still builds every target with it. (`carried` does not read the policy, so the policy is not a path.)
  const paths = /\n {2}pull_request:\n {4}paths:\n((?: {6}- [^\n]+\n)+)/.exec(matrix)
  assert.ok(paths)
  for (const tool of ['tools/license/notices.mjs', 'tools/license/gate.mjs', 'tools/test/held.mjs']) assert.match(paths[1], new RegExp(`^ {6}- ${tool.replace(/[.]/g, '\\.')}$`, 'm'), `${tool} is one of the paths that start the build matrix on a pull request`)

  const windows = read('.github/workflows/windows-app.yml')
  assert.match(windows, /\n {6}- name: The bare executable holds the notices of the Rust crates it is built with, whole\n(?: {8}#[^\n]*\n)+ {8}run: \|\n {10}\[ -f tools\/license\/notices\.mjs \] \|\| \{ echo "this commit predates the crates' notices: there is nothing to hold"; exit 0; \}\n {10}node tools\/license\/notices\.mjs carried out\/portable\/\*\.exe\n/)
  assert.ok(windows.indexOf('- name: The bare executable holds the notices') > windows.indexOf('- name: Collect the installers and the bare executable'))
})
