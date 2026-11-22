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

interface Pkg { name: string; version: string; license: string | null; authors?: string[]; repository?: string | null; source: string | null; manifest_path: string; license_file?: string | null }
interface Rec { name: string; version: string; licence: string | null; authors: string[]; repository: string | null; files: { name: string; text: string }[] }

/** A registry that exists only here: each crate's folder with the files given, and cargo's answer naming them. */
function registry(crates: { name: string; version?: string; licence?: string | null; authors?: string[]; repository?: string | null; files?: Record<string, string>; source?: string | null; licenseFile?: string }[]) {
  const disk = new Map<string, Record<string, string>>()
  const packages: Pkg[] = crates.map((c) => {
    const version = c.version ?? '1.0.0'
    const dir = `/registry/${c.name}-${version}`
    disk.set(dir, { 'Cargo.toml': '[package]', 'README.md': 'read me', ...(c.files ?? {}) })
    return { name: c.name, version, license: c.licence === undefined ? 'MIT' : c.licence, authors: c.authors ?? [], repository: c.repository ?? null, source: c.source === undefined ? 'registry+https://github.com/rust-lang/crates.io-index' : c.source, manifest_path: `${dir}/Cargo.toml`, license_file: c.licenseFile ?? null }
  })
  const fs = {
    list: (dir: string) => Object.keys(disk.get(dir) ?? {}),
    read: (path: string) => { const at = path.lastIndexOf('/'); return disk.get(path.slice(0, at))![path.slice(at + 1)] },
  }
  return { metadata: { packages }, fs }
}
type Spec = Parameters<typeof registry>[0][number]
const records = (crates: Parameters<typeof registry>[0]): Rec[] => { const r = registry(crates); return n.crateRecords(r.metadata, r.fs) }
const mitOf = (who: string) => `MIT License\n\nCopyright (c) ${who}\n\n${MIT}\n`

// ---------------------------------------------------------------------------------------------------------------
// The committed file

test('the committed notices name every crate of the apps\' lockfile once, under the licence the inventory records', () => {
  assert.ok(COMMITTED.startsWith(`${n.TITLE}\n\n`), 'the title the audits look for is its first line')
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

  const last = COMMITTED.slice(COMMITTED.indexOf('\n4. CRATES WHOSE PACKAGES SHIP NO LICENCE TEXT'))
  const bare = [...last.matchAll(/^(\S+) (\S+)\n {2}declared: (.+)\n {2}taken: {4}(.+)\n/gm)]
  assert.match(last, new RegExp(`^4\\. CRATES WHOSE PACKAGES SHIP NO LICENCE TEXT \\(${bare.length}\\)$`, 'm'))
  for (const m of bare) {
    for (const id of m[4].split(' AND ')) assert.equal(g.permits(id, m[1], policy).ok, true, `${m[1]} is taken under ${id}, which the policy allows`)
    assert.deepEqual(n.taken(m[3]), m[4].split(' AND '), `${m[1]}: taken as the tool takes it`)
  }
  const mitTaken = bare.filter((m) => m[4] === 'MIT')
  assert.equal([...last.matchAll(/^ {2}notice: {3}Copyright \(c\) \S/gm)].length, mitTaken.length, 'each crate taken under MIT has its copyright notice beside it')
  assert.ok(last.trimEnd().endsWith(MIT), 'and the MIT License follows them, as LICENSES/MIT.txt has it from "Permission is hereby granted"')
  for (const m of bare.filter((b) => b[4] !== 'MIT')) {
    assert.match(last, new RegExp(`^${m[1]} ${m[2].replace(/[.+]/g, '\\$&')}\\n(?: {2}.*\\n)*? {2}text: {5}${m[4].replace(/[.+]/g, '\\$&')}, as \\S+ \\S+ ships it above \\(`, 'm'), `${m[1]}: the text another crate of ${m[4]} ships`)
  }
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
  assert.deepEqual([recs[0].licence, recs[0].files, recs[1].files], [null, [], []])
  for (const name of ['LICENSE', 'Licence', 'license.txt', 'LICENSE-APACHE-2.0_WITH_LLVM-exception', 'COPYING', 'COPYRIGHT-rust.txt', 'NOTICE', 'UNLICENSE', 'AUTHORS', 'PATENTS', 'LICENSE.spdx', 'LICENSE.BSD-3-Clause']) assert.match(name, n.NOTICE_FILE)
  for (const name of ['README.md', 'Cargo.toml', 'licenses', 'license.rs', 'LICENSE.json', 'LICENSE.png', 'notice_helper.py', 'unlicensed']) assert.doesNotMatch(name, n.NOTICE_FILE)
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
  assert.match(text, /^4\. CRATES WHOSE PACKAGES SHIP NO LICENCE TEXT \(0\)\n-{100}\n\nEvery crate ships a text\.\n$/m)
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
    { name: 'not-a-donor', licence: 'BSD-3-Clause OR MIT', files: { LICENSE: 'a choice is not that very licence' }, repository: 'https://example.invalid/alloc' },
  ]
  const text: string = n.notices(records(set), { mit: MIT })
  assert.match(text, /^4\. CRATES WHOSE PACKAGES SHIP NO LICENCE TEXT \(4\)$/m)
  assert.match(text, /^bare-mit 1\.0\.0\n {2}declared: Zlib OR Apache-2\.0 OR MIT\n {2}taken: {4}MIT\n {2}authors: {2}Ann <ann@example\.invalid>, Bo\n {2}project: {2}https:\/\/example\.invalid\/bare\n {2}notice: {3}Copyright \(c\) Ann <ann@example\.invalid>, Bo\n$/m)
  assert.match(text, /^bare-anon 1\.0\.0\n {2}declared: MIT\n {2}taken: {4}MIT\n {2}authors: {2}the authors of bare-anon\n {2}notice: {3}Copyright \(c\) the authors of bare-anon\n$/m)
  assert.match(text, /^bare-mpl 1\.0\.0\n {2}declared: MPL-2\.0\n {2}taken: {4}MPL-2\.0\n {2}authors: {2}The Project\n {2}project: {2}https:\/\/example\.invalid\/css\n {2}text: {5}MPL-2\.0, as donor-css 1\.0\.0 ships it above \(LICENSE\)\n$/m)
  assert.match(text, /^bare-bsd 1\.0\.0\n(?: {2}.*\n)* {2}text: {5}BSD-3-Clause, as donor-bsd-sibling 1\.0\.0 ships it above \(LICENSE\.txt\)\n$/m, 'the crate of its own repository, not the first by name')
  assert.equal(text.split('Permission is hereby granted').length - 1, 1, 'the MIT License once, after the list')
  assert.ok(text.trimEnd().endsWith(MIT))
  // The MPL crates, shipping a text or not, are in the source section.
  assert.match(text, /^bare-mpl 1\.0\.0\n {2}package: https:\/\/crates\.io\/api\/v1\/crates\/bare-mpl\/1\.0\.0\/download\n {2}page: {4}https:\/\/crates\.io\/crates\/bare-mpl\/1\.0\.0\n {2}project: https:\/\/example\.invalid\/css\ndonor-css 1\.0\.0\n {2}package: /m)
  // What has no answer is refused, not guessed.
  assert.throws(() => n.notices(records([{ name: 'lonely', licence: 'MPL-2.0' }]), { mit: MIT }), /lonely 1\.0\.0 ships no licence text and is taken under MPL-2\.0, and no crate whose only licence is MPL-2\.0 ships one to stand in/)
  assert.throws(() => n.notices(records([{ name: 'silent', licence: null }]), { mit: MIT }), /silent 1\.0\.0 declares no licence/)
  assert.throws(() => n.notices(records([{ name: 'closed', licence: 'GPL-3.0-only' }]), { mit: MIT }), /no licence it offers has a place/)
})

test('the MIT License is printed for other crates only while it is, word for word, the text crates themselves ship', () => {
  const ten = records(Array.from({ length: 10 }, (_, i) => ({ name: `m${i}`, files: { 'LICENSE-MIT': mitOf(`author ${i}`).replace(/\n/g, '\r\n').replace(/ of /g, '\n  of ') } })))
  assert.deepEqual(n.mitProblems(ten, MIT), [], 'ten copies, whatever their line breaks')
  assert.match(n.mitProblems(ten.slice(1), MIT)[0], /word for word in the texts of 9 crates; at least 10 were expected/)
  assert.match(n.mitProblems(ten, MIT.replace('free of charge', 'free of all charge'))[0], /in the texts of 0 crates/)
  assert.deepEqual(n.mitProblems(ten, MIT, 3), [])
})

// ---------------------------------------------------------------------------------------------------------------
// A built file

/** A zip archive of the entries given, each stored or deflated, as an .apk or an .ipa is laid out. */
function zip(entries: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let at = 0
  for (const e of entries) {
    const name = Buffer.from(e.name)
    const body = e.store ? e.data : deflateRawSync(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(e.store ? 0 : 8, 8)
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(e.data.length, 22); local.writeUInt16LE(name.length, 26)
    const head = Buffer.alloc(46)
    head.writeUInt32LE(0x02014b50, 0); head.writeUInt16LE(20, 4); head.writeUInt16LE(20, 6); head.writeUInt16LE(e.store ? 0 : 8, 10)
    head.writeUInt32LE(body.length, 20); head.writeUInt32LE(e.data.length, 24); head.writeUInt16LE(name.length, 28); head.writeUInt32LE(at, 42)
    locals.push(local, name, body)
    central.push(head, name)
    at += 30 + name.length + body.length
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(at, 16)
  return Buffer.concat([...locals, dir, end])
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
  // A stored entry's bytes are in the archive as they are; a deflated one is found by reading the archive.
  assert.deepEqual(n.carries(apk, text), [''])
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

test('the command line: --write writes what the registry gives, --check passes on it and names the first line that differs, cargo failing is neither', () => {
  const root = mkdtempSync(join(tmpdir(), 'crate-notices-'))
  try {
    const set: Spec[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ name: `mit-${i}`, files: { 'LICENSE-MIT': mitOf(`the authors of mit-${i}`) } })),
      { name: 'bare', licence: 'MIT OR Apache-2.0', authors: ['Cy'] },
    ]
    const { metadata, fs } = registry(set)
    const asked: string[][] = []
    const cargo = (cmd: string, args: string[]) => { asked.push([cmd, ...args]); return { status: 0, stdout: JSON.stringify(metadata), stderr: '' } }
    const run = (argv: string[], over: Record<string, unknown> = {}) => { const lines: string[] = []; const code = n.main(argv, { run: cargo, log: (l: string) => lines.push(l), fs, root, ...over }); return { code, lines } }

    const missing = run(['--check'])
    assert.equal(missing.code, 1)
    assert.match(missing.lines[0], /^crate-notices: src-tauri\/notices\/RUST-CRATES\.txt is missing: node tools\/license\/notices\.mjs --write$/)
    const wrote = run(['--write'])
    assert.equal(wrote.code, 0)
    assert.match(wrote.lines[0], /^crate-notices: 11 crates, \d+ bytes written to src-tauri\/notices\/RUST-CRATES\.txt$/)
    const file = join(root, n.NOTICES_FILE)
    const written = readFileSync(file, 'utf8')
    assert.equal(written, n.notices(n.crateRecords(metadata, fs), { mit: MIT }))
    assert.deepEqual(asked[0].slice(0, 6), ['cargo', 'metadata', '--locked', '--all-features', '--format-version', '1'], 'every feature on, so the crates are the lockfile\'s')
    assert.equal(asked[0][7], join(ROOT, n.WORKSPACE, 'Cargo.toml'))
    const same = run(['--check'])
    assert.equal(same.code, 0)
    assert.match(same.lines[0], /^crate-notices: 11 crates, \d+ bytes, as the registry gives them$/)

    writeFileSync(file, written.replace('Copyright (c) the authors of mit-3', 'Copyright (c) someone else'))
    const differs = run(['--check'])
    assert.equal(differs.code, 1)
    assert.match(differs.lines[0], /^crate-notices: src-tauri\/notices\/RUST-CRATES\.txt is not what the registry gives \(line \d+: the committed file has "Copyright \(c\) someone else", the registry gives "Copyright \(c\) the authors of mit-3"\): node tools\/license\/notices\.mjs --write, and read the diff$/)
    assert.equal(readFileSync(file, 'utf8').includes('someone else'), true, '--check writes nothing')

    const failed = run(['--check'], { run: () => ({ status: 101, stdout: '', stderr: 'error: failed to download\nCaused by: network' }) })
    assert.equal(failed.code, 2, 'cargo could not answer: not a pass, and not a finding')
    assert.match(failed.lines[0], /^crate-notices: cargo metadata for src-tauri failed: /)
    const few = run(['--write'], { fs: registry(set.slice(3)).fs, run: () => ({ status: 0, stdout: JSON.stringify(registry(set.slice(3)).metadata), stderr: '' }) })
    assert.equal(few.code, 1)
    assert.match(few.lines[0], /^crate-notices: the MIT License as LICENSES\/MIT\.txt has it is word for word in the texts of 7 crates/)

    // carried: the committed file of this root, looked for in each file named.
    writeFileSync(file, written)
    mkdirSync(join(root, 'out'))
    const exe = join(root, 'out', 'app.exe')
    writeFileSync(exe, Buffer.concat([Buffer.alloc(4000, 9), Buffer.from(written), Buffer.alloc(100, 8)]))
    const apk = join(root, 'out', 'app.apk')
    writeFileSync(apk, zip([{ name: 'lib/arm64-v8a/libapp.so', data: readFileSync(exe) }]))
    const empty = join(root, 'out', 'empty.bin')
    writeFileSync(empty, Buffer.alloc(5000, 7))
    const held = run(['carried', exe, apk, file])
    assert.equal(held.code, 0)
    assert.match(held.lines[0], /app\.exe holds the \d+ bytes of src-tauri\/notices\/RUST-CRATES\.txt$/)
    assert.match(held.lines[1], /app\.apk holds the \d+ bytes of src-tauri\/notices\/RUST-CRATES\.txt \(inside lib\/arm64-v8a\/libapp\.so\)$/)
    const not = run(['carried', exe, empty, join(root, 'out', 'gone.exe')])
    assert.equal(not.code, 1)
    assert.match(not.lines[1], /empty\.bin does not hold src-tauri\/notices\/RUST-CRATES\.txt whole$/)
    assert.match(not.lines[2], /gone\.exe could not be read \(ENOENT\)$/)

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

  const windows = read('.github/workflows/windows-app.yml')
  assert.match(windows, /\n {6}- name: The bare executable holds the notices of the Rust crates it is built with, whole\n(?: {8}#[^\n]*\n)+ {8}run: \|\n {10}\[ -f tools\/license\/notices\.mjs \] \|\| \{ echo "this commit predates the crates' notices: there is nothing to hold"; exit 0; \}\n {10}node tools\/license\/notices\.mjs carried out\/portable\/\*\.exe\n/)
  assert.ok(windows.indexOf('- name: The bare executable holds the notices') > windows.indexOf('- name: Collect the installers and the bare executable'))
})
