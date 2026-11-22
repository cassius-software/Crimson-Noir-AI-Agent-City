// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs the licence gate (tools/license/gate.mjs) on the repository as it stands, in the
 * same `npm test` every change goes through, and pins how the gate decides: how a licence expression is read (of
 * `A OR B` one side is enough, of `A AND B` both are needed, an exception must be a listed one), that a crate in a
 * lockfile and not in the inventory fails and so does one in the inventory alone, that file-level copyleft passes for
 * the crates named and for no other, that a listed name is caught in prose and in a comment while the older tests'
 * own patterns are not, that a picture nobody listed fails, and that a third-party directory must carry the licence
 * text the policy states. It also pins what the policy may not quietly become: no share-alike licence among the
 * allowed, and the open questions it reports are exactly the ones written down. The registry half (the inventory
 * against each crate's own manifest) needs cargo and a network, so it is CI's `crate-licences` check, pinned here by
 * its place in the workflow.
 * What breaks if it is removed? The gate could wave through a licence it misread, or stop being run at all, and a
 * dependency, a name or a picture the owner cannot sell reaches main unseen.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A computed specifier: the gate is tooling under tools/, outside the page's build, loaded as the test's own module.
const GATE: string = '../tools/license/gate.mjs'
const g = await import(GATE)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

interface Policy {
  workspaces: string[]
  licences: { allowed: string[]; exceptions: string[]; byCrate: Record<string, { crates: string[]; why: string }> }
  marks: { listed: { pattern: string; why: string; say?: string }[]; notOurs: string; until: Record<string, { marker: string; why: string }>; exempt: Record<string, string> }
  assets: { files: { path: string; origin: string; rights: string; open?: string }[]; thirdParty: Record<string, { licence: string; text: string; carries?: string[] }> }
}
const POLICY: Policy = g.loadPolicy()
const INVENTORY: { crates: Record<string, string | null> } = g.loadInventory()
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v))

// ---------------------------------------------------------------------------------------------------------------
// The repository as it stands

test('the repository passes the gate: every crate, every name, every picture and third-party directory', () => {
  const r = g.gate()
  assert.deepEqual(r.problems, { crates: [], names: [], assets: [] })
  // The whole tree was read, not a corner of it.
  assert.ok(r.counts.crates > 500 && r.counts.lockfiles === 6 && r.counts.texts > 800 && r.counts.assets > 30 && r.counts.thirdParty === 6, JSON.stringify(r.counts))
  // The open questions are the ones written down, each naming its file: one today, the cover picture's origin.
  assert.equal(r.open.length, 1)
  assert.match(r.open[0], /^docs\/cover\.jpg: which tool and which plan made it has not been recorded/)
})

test('the command line: the three checks print their count and exit 0; an unknown command prints the usage and exits 1', () => {
  const lines: string[] = []
  assert.equal(g.main([], { log: (l: string) => lines.push(l) }), 0)
  assert.match(lines.at(-1)!, /^licence-gate: \d+ crates of 6 lockfiles, \d+ text files, \d+ pictures and packed files, 6 third-party directories: 0 wrong, 1 open$/)
  assert.ok(lines.some((l) => l.startsWith('licence-gate: open: docs/cover.jpg: ')))
  const usage: string[] = []
  assert.equal(g.main(['everything'], { log: (l: string) => usage.push(l) }), 1)
  assert.match(usage[0], /^usage: node tools\/license\/gate\.mjs/)
  assert.equal(g.main(['crates'], { log: () => {} }), 1, 'crates alone names neither --check nor --write')
  assert.equal(g.main(['crates', '--check', '--write'], { log: () => {} }), 1)
})

// ---------------------------------------------------------------------------------------------------------------
// Licence expressions

test('a licence expression is read as SPDX writes it: WITH, then AND, then OR, brackets, any case, and the older slash', () => {
  assert.deepEqual(g.parseSpdx('MIT'), { id: 'MIT' })
  assert.deepEqual(g.parseSpdx('MIT OR Apache-2.0'), { or: [{ id: 'MIT' }, { id: 'Apache-2.0' }] })
  assert.deepEqual(g.parseSpdx('MIT/Apache-2.0'), { or: [{ id: 'MIT' }, { id: 'Apache-2.0' }] })
  assert.deepEqual(g.parseSpdx('Apache-2.0 / MIT'), { or: [{ id: 'Apache-2.0' }, { id: 'MIT' }] })
  assert.deepEqual(g.parseSpdx('mit or apache-2.0'), { or: [{ id: 'mit' }, { id: 'apache-2.0' }] })
  assert.deepEqual(g.parseSpdx('(MIT OR Apache-2.0) AND Unicode-3.0'), { and: [{ or: [{ id: 'MIT' }, { id: 'Apache-2.0' }] }, { id: 'Unicode-3.0' }] })
  // AND binds tighter than OR: A OR (B AND C).
  assert.deepEqual(g.parseSpdx('MIT OR GPL-3.0-only AND Apache-2.0'), { or: [{ id: 'MIT' }, { and: [{ id: 'GPL-3.0-only' }, { id: 'Apache-2.0' }] }] })
  assert.deepEqual(g.parseSpdx('Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT'), { or: [{ id: 'Apache-2.0', with: 'LLVM-exception' }, { id: 'Apache-2.0' }, { id: 'MIT' }] })
  for (const bad of ['', '   ', 'MIT OR', 'OR MIT', '(MIT', 'MIT)', 'MIT Apache-2.0', 'MIT WITH', 'MIT WITH OR', 'MIT AND AND ISC', 'see LICENSE file!', null, undefined]) {
    assert.throws(() => g.parseSpdx(bad), /not a licence expression/, JSON.stringify(bad))
  }
})

test('a licence passes when one side of an OR is allowed and every side of an AND is', () => {
  const ok = (e: string, crate = 'some-crate') => g.permits(e, crate, POLICY)
  for (const e of ['MIT', 'Apache-2.0', 'MIT OR Apache-2.0', 'Unlicense OR MIT', 'Zlib OR Apache-2.0 OR MIT', 'BSD-3-Clause AND MIT', '(MIT OR Apache-2.0) AND Unicode-3.0', 'Apache-2.0 WITH LLVM-exception', '0BSD OR MIT OR Apache-2.0', 'CC0-1.0 OR MIT-0 OR Apache-2.0']) {
    assert.equal(ok(e).ok, true, e)
  }
  // The copyleft side of a choice is simply not taken.
  assert.deepEqual(ok('MIT OR Apache-2.0 OR LGPL-2.1-or-later'), { ok: true, by: ['MIT'] })
  assert.deepEqual(ok('GPL-3.0-only OR MIT'), { ok: true, by: ['MIT'] })
  // Alone, or as one side of an AND, it fails, and the answer names it.
  for (const e of ['GPL-3.0-only', 'LGPL-2.1-or-later', 'AGPL-3.0-only', 'MPL-2.0', 'EPL-2.0', 'CDDL-1.0', 'SSPL-1.0', 'CC-BY-SA-4.0', 'CC-BY-NC-4.0', 'MIT AND GPL-2.0-only', 'GPL-2.0-only AND MIT', '(MIT OR Apache-2.0) AND LGPL-3.0-only', 'BUSL-1.1', 'LicenseRef-Something']) {
    const r = ok(e)
    assert.equal(r.ok, false, e)
    assert.match(r.why, /is not a licence the policy allows|is allowed only for/, e)
  }
  // An exception has to be a listed one; an unreadable expression is never a pass.
  assert.equal(ok('GPL-2.0-only WITH Classpath-exception-2.0').ok, false)
  assert.match(ok('Apache-2.0 WITH Some-exception').why, /the exception is not one the policy lists/)
  assert.match(ok('see the LICENSE file!').why, /not a licence expression/)
  assert.match(ok('').why, /not a licence expression/)
})

test('file-level copyleft passes for the crates the policy names and for no other', () => {
  assert.deepEqual(Object.keys(POLICY.licences.byCrate), ['MPL-2.0'])
  assert.deepEqual(POLICY.licences.byCrate['MPL-2.0'].crates, ['cssparser', 'cssparser-macros', 'dtoa-short', 'option-ext', 'selectors'])
  for (const name of POLICY.licences.byCrate['MPL-2.0'].crates) assert.equal(g.permits('MPL-2.0', name, POLICY).ok, true, name)
  const other = g.permits('MPL-2.0', 'webrender', POLICY)
  assert.equal(other.ok, false)
  assert.match(other.why, /^MPL-2\.0 is allowed only for cssparser, cssparser-macros, dtoa-short, option-ext, selectors$/)
  // Each of the five is really in a lockfile under that licence: the list is not a standing permission for nothing.
  for (const name of POLICY.licences.byCrate['MPL-2.0'].crates) {
    const held = Object.entries(INVENTORY.crates).filter(([k]) => k.startsWith(`${name} `))
    assert.ok(held.length >= 1 && held.every(([, l]) => l === 'MPL-2.0'), `${name}: ${JSON.stringify(held)}`)
  }
})

test('the policy allows no share-alike licence, and says why each exception to the plain list is there', () => {
  const { allowed, exceptions, byCrate } = POLICY.licences
  for (const id of allowed) assert.doesNotMatch(id, /GPL|MPL|EPL|CDDL|SSPL|OSL|EUPL|BUSL|CC-BY|NC|ShareAlike|LicenseRef/i, id)
  assert.deepEqual(exceptions, ['LLVM-exception'])
  for (const [id, rule] of Object.entries(byCrate)) assert.ok(rule.why.length > 100 && rule.crates.length > 0, id)
  assert.deepEqual(POLICY.workspaces, ['crimson_noir_os', 'native/kv-pager', 'native/kv-pager-wasm', 'native/llm', 'native/routing', 'src-tauri'])
})

// ---------------------------------------------------------------------------------------------------------------
// Crates

const LOCK = `# This file is automatically @generated by Cargo.
version = 4

[[package]]
name = "own-crate"
version = "0.1.0"
dependencies = [
 "alpha",
 "beta 2.0.0",
]

[[package]]
name = "alpha"
version = "1.2.3"
source = "registry+https://github.com/rust-lang/crates.io-index"
checksum = "00"

[[package]]
name = "beta"
version = "2.0.0"
source = "git+https://example.invalid/beta#abcdef"
`

test('a lockfile gives the crates taken from outside the repository, and leaves the repository\'s own out', () => {
  assert.deepEqual(g.lockCrates(LOCK), [
    { name: 'alpha', version: '1.2.3', source: 'registry+https://github.com/rust-lang/crates.io-index' },
    { name: 'beta', version: '2.0.0', source: 'git+https://example.invalid/beta#abcdef' },
  ])
  assert.deepEqual(g.lockCrates('version = 4\n'), [])
  assert.throws(() => g.lockCrates('[[package]]\nversion = "1.0.0"\n'), /without a name and a version/)
  // The real ones: every lockfile the policy lists is there, and the two with no dependencies say so.
  const count = (ws: string) => g.lockCrates(read(`${ws}/Cargo.lock`)).length
  assert.equal(count('native/routing'), 0)
  assert.equal(count('native/kv-pager-wasm'), 0)
  assert.ok(count('src-tauri') > 400 && count('crimson_noir_os') > 100 && count('native/kv-pager') > 100 && count('native/llm') > 50)
})

test('the lockfiles, the inventory and the policy must agree, crate by crate', () => {
  const policy = { ...clone(POLICY), workspaces: ['a'] }
  policy.licences.byCrate = {}
  const run = (crates: Record<string, string | null>, locks: Record<string, string> = { a: LOCK }, p = policy) => g.crateFindings({ locks, inventory: { crates }, policy: p })
  assert.deepEqual(run({ 'alpha 1.2.3': 'MIT OR Apache-2.0', 'beta 2.0.0': 'ISC' }), [])
  // A crate added to a lockfile and not to the inventory; the same crate at another version is another crate.
  assert.match(run({ 'alpha 1.2.3': 'MIT' })[0], /^beta 2\.0\.0 \(a\) is in a lockfile and not in the inventory: run `node tools\/license\/gate\.mjs crates --write`/)
  const moved = run({ 'alpha 1.2.2': 'MIT', 'beta 2.0.0': 'ISC' })
  assert.equal(moved.length, 2)
  assert.match(moved[0], /^alpha 1\.2\.3 \(a\) is in a lockfile and not in the inventory/)
  assert.match(moved[1], /^alpha 1\.2\.2 is in the inventory and in no lockfile/)
  // A licence the policy does not allow, one the manifest does not state, one nobody can read.
  assert.deepEqual(run({ 'alpha 1.2.3': 'GPL-3.0-only', 'beta 2.0.0': 'ISC' }), ['alpha 1.2.3 (a) is under "GPL-3.0-only": GPL-3.0-only is not a licence the policy allows'])
  assert.match(run({ 'alpha 1.2.3': null, 'beta 2.0.0': 'ISC' })[0], /^alpha 1\.2\.3 \(a\) states no licence in its manifest/)
  assert.match(run({ 'alpha 1.2.3': 'ask the author', 'beta 2.0.0': 'ISC' })[0], /not a licence expression/)
  // A lockfile the policy does not list, and a listed one that was not read.
  assert.match(run({ 'alpha 1.2.3': 'MIT', 'beta 2.0.0': 'ISC' }, { a: LOCK, 'native/new': 'version = 4\n' })[0], /^native\/new\/Cargo\.lock is not a workspace the policy lists/)
  assert.match(run({}, {})[0], /^a\/Cargo\.lock is listed in the policy and was not read$/)
  // A crate named for file-level copyleft that no lockfile holds any more is taken off the list, not left standing.
  const named = clone(policy)
  named.licences.byCrate = { 'MPL-2.0': { crates: ['alpha', 'gone'], why: 'x' } }
  assert.deepEqual(run({ 'alpha 1.2.3': 'MPL-2.0', 'beta 2.0.0': 'ISC' }, { a: LOCK }, named), ['the policy allows MPL-2.0 for gone, which no lockfile holds any more: take it off the list'])
})

test('the registry\'s answer is held against the committed inventory, both ways and licence by licence', () => {
  const meta = { packages: [{ name: 'own', version: '0.1.0', source: null, license: null }, { name: 'alpha', version: '1.2.3', source: 'registry+x', license: 'MIT' }, { name: 'beta', version: '2.0.0', source: 'registry+x' }] }
  const fresh = g.metadataCrates(meta)
  assert.deepEqual(fresh, { 'alpha 1.2.3': 'MIT', 'beta 2.0.0': null })
  assert.deepEqual(g.registryFindings(fresh, { crates: { 'alpha 1.2.3': 'MIT', 'beta 2.0.0': null } }), [])
  assert.deepEqual(g.registryFindings(fresh, { crates: { 'alpha 1.2.3': 'Apache-2.0', 'gamma 3.0.0': 'MIT' } }), [
    'alpha 1.2.3: the registry says "MIT", tools/license/crates.json says "Apache-2.0"',
    'beta 2.0.0 is in a lockfile and not in tools/license/crates.json',
    'gamma 3.0.0 is in tools/license/crates.json and in no lockfile',
  ])
})

test('the inventory is written one crate a line, sorted, and the committed file is exactly that', () => {
  const text = g.inventoryText({ 'b 1.0.0': 'MIT', 'a 2.0.0': null })
  assert.match(text, /"crates": \{\n {4}"a 2\.0\.0": null,\n {4}"b 1\.0\.0": "MIT"\n {2}\}\n\}\n$/)
  assert.deepEqual(JSON.parse(text).crates, { 'a 2.0.0': null, 'b 1.0.0': 'MIT' })
  assert.equal(read('tools/license/crates.json'), g.inventoryText(INVENTORY.crates), 'crates.json is as `crates --write` leaves it')
})

test('crates --check asks cargo for every workspace with every feature on, and fails when cargo does or the registry differs', () => {
  const asked: string[][] = []
  const byWorkspace = (args: string[]) => {
    const ws = POLICY.workspaces.find((w) => args.includes(join(ROOT, w, 'Cargo.toml')))!
    const keys = g.lockCrates(read(`${ws}/Cargo.lock`)).map((c: { name: string; version: string }) => `${c.name} ${c.version}`)
    return { packages: keys.map((k: string) => { const [name, version] = k.split(' '); return { name, version, source: 'registry+x', license: INVENTORY.crates[k] } }) }
  }
  const cargo = (answer: (args: string[]) => unknown) => (cmd: string, args: string[]) => { asked.push([cmd, ...args]); return { status: 0, stdout: JSON.stringify(answer(args)), stderr: '' } }
  const lines: string[] = []
  assert.equal(g.main(['crates', '--check'], { run: cargo(byWorkspace), log: (l: string) => lines.push(l) }), 0)
  assert.match(lines.at(-1)!, /^crate-licences: \d+ crates of 6 workspaces read from the registry, 0 wrong$/)
  assert.equal(asked.length, 6)
  for (const a of asked) assert.deepEqual(a.slice(0, 6), ['cargo', 'metadata', '--locked', '--all-features', '--format-version', '1'])
  // The registry now says something else about one crate.
  const changed = (args: string[]) => { const m = byWorkspace(args); for (const p of m.packages) if (p.name === 'font8x8') p.license = 'GPL-3.0-only'; return m }
  const out: string[] = []
  assert.equal(g.main(['crates', '--check'], { run: cargo(changed), log: (l: string) => out.push(l) }), 1)
  assert.ok(out.some((l) => /^crate-licences: font8x8 [\d.]+: the registry says "GPL-3\.0-only", tools\/license\/crates\.json says "MIT"$/.test(l)), out.join('\n'))
  // cargo itself failed: not a pass, and not a finding either.
  const failed: string[] = []
  assert.equal(g.main(['crates', '--check'], { run: () => ({ status: 101, stdout: '', stderr: 'error: failed to get `x` as a dependency\nCaused by: network' }), log: (l: string) => failed.push(l) }), 2)
  assert.match(failed[0], /^crate-licences: cargo metadata for crimson_noir_os failed: /)
})

// ---------------------------------------------------------------------------------------------------------------
// Names

test('a listed name is caught in prose, in a comment and in any case, with its line and what to say instead', () => {
  const scan = (text: string, path = 'docs/some.md') => g.markFindings([[path, text]], POLICY)
  // Spelled in halves, so this file stays readable by the page's older scan as well.
  const film = ['Mat', 'rix mode'].join('')
  const rain = ['digi', 'tal rain'].join('')
  const lord = ['Si', 'th Lord Terminal'].join('')
  assert.deepEqual(scan(`# Title\n\n## ${film}\n`), [`docs/some.md:3: "${film}" (a film franchise's name for falling code; say rain mode)`])
  assert.equal(scan(`// the ${film.toLowerCase()} shader`).length, 1)
  assert.equal(scan(`a ${rain} effect`).length, 1)
  assert.match(scan(`the ${lord}`)[0], /say the Crimson Terminal\)$/)
  for (const word of [['x', 'box'], ['Nin', 'tendo'], ['Joy-', 'Con'], ['Nemo', 'Claw'], ['Save the', ' Cat'], ['Star', ' Wars'], ['light', 'sabers'], ['Grand Theft', ' Auto'], ['Mine', 'craft'], ['Sim', 'City'], ['Poké', 'mon'], ['Crimson', 'Script']]) {
    assert.equal(scan(`It is like ${word.join('')}, they said.`).length, 1, word.join(''))
  }
  // What is not one: the linear algebra, the build matrix, rain mode itself, the language's full name.
  for (const fine of ['the post chain\'s last matrix over the finished frame', 'the build matrix\'s tenth target', 'matrix.mjs --targets all', 'M toggles rain mode', 'Crimson Noir Script', 'a marvellous day', 'legos', 'the city simulation', 'a jedinstvo of things']) {
    assert.deepEqual(scan(fine), [], fine)
  }
  // The older tests keep their own patterns as regular expressions; written that way they are not prose.
  assert.deepEqual(scan(String.raw`const FORBIDDEN = /\bthe matrix\b|\bmatrix[- ](?:style|like|rain|code|effect)\b|\bdigital rain\b|\bxbox\b|\bnintendo\b|\bjoy-?cons?\b/i`), [])
})

test('the name scan passes over what is not the repository\'s own text, and reads the notice only as far as it ships', () => {
  const lord = ['Si', 'th'].join('')
  const hit = (path: string, text = `the ${lord} one`) => g.markFindings([[path, text]], POLICY).length
  assert.equal(hit('MANUAL.md'), 1)
  assert.equal(hit('src/01_Initialize_World/world.ts'), 1)
  assert.equal(hit('crimson_noir_os/README.md'), 1)
  assert.equal(hit('.github/workflows/ci.yml'), 1)
  for (const path of ['third_party/wllama/3.8.1/NOTICE', 'package-lock.json', 'src-tauri/Cargo.lock', 'flake.lock', 'docs/autoscaler/phone.csv']) assert.equal(hit(path), 0, path)
  for (const path of Object.keys(POLICY.marks.exempt)) assert.equal(hit(path), 0, path)
  // Four exemptions, each a file that has to name what it guards against, and each with its reason.
  assert.deepEqual(Object.keys(POLICY.marks.exempt).sort(), ['docs/ip-audit.md', 'src/compliance.test.ts', 'src/licenceGate.test.ts', 'tools/license/policy.json'])
  for (const why of Object.values(POLICY.marks.exempt)) assert.ok(why.length > 10)
  // NOTICE.md: the shipped part is read, the notes for counsel below the marker are not.
  assert.deepEqual(Object.keys(POLICY.marks.until), ['NOTICE.md'])
  const marker = POLICY.marks.until['NOTICE.md'].marker
  assert.ok(read('NOTICE.md').includes(marker), 'the marker is a heading the notice really has')
  assert.equal(hit('NOTICE.md', `shipped ${lord}${marker}\nresearch`), 1)
  assert.equal(hit('NOTICE.md', `shipped${marker}\nresearch on ${lord}`), 0)
  // Every pattern compiles and says why it is listed.
  for (const m of POLICY.marks.listed) { assert.doesNotThrow(() => new RegExp(m.pattern, 'i')); assert.ok(m.why.length > 10, m.pattern) }
})

// ---------------------------------------------------------------------------------------------------------------
// Pictures, packed files and third-party directories

test('a picture or packed file nobody listed fails, and so does a listing with no file behind it', () => {
  const policy = clone(POLICY)
  policy.assets.files = [
    { path: 'brand/marks/', origin: 'drawn here', rights: 'the owner\'s' },
    { path: 'docs/cover.jpg', origin: 'supplied', rights: 'the owner\'s', open: 'which tool made it' },
  ]
  const run = (paths: string[], p = policy) => g.assetFindings(paths, p)
  const tree = ['README.md', 'brand/marks/a.svg', 'brand/marks/b.svg', 'docs/cover.jpg', 'src/main.tsx', 'third_party/wllama/3.8.1/wllama.wasm.gz']
  assert.deepEqual(run(tree), { problems: [], open: ['docs/cover.jpg: which tool made it'] })
  for (const added of ['docs/new-art.png', 'src/01_Initialize_World/assets/skyline.webp', 'brand/font/Display.woff2', 'world/music/theme.ogg', 'src-tauri/models/x.gguf', 'docs/deck.pdf', 'world/tower.glb', 'brand/LOGO.PNG']) {
    assert.deepEqual(run([...tree, added]).problems, [`${added} is not listed in tools/license/policy.json (assets.files): say where it came from and whose it is`], added)
  }
  assert.deepEqual(run(tree.filter((p) => p !== 'docs/cover.jpg')).problems, ['docs/cover.jpg is listed in tools/license/policy.json (assets.files) and no such file is in the repository'])
  const twice = clone(policy)
  twice.assets.files.push({ path: 'brand/marks/a.svg', origin: 'x', rights: 'y' })
  assert.deepEqual(run(tree, twice).problems, ['brand/marks/a.svg is listed 2 times in tools/license/policy.json (assets.files)'])
  const bare = clone(policy)
  bare.assets.files[0].origin = ''
  assert.deepEqual(run(tree, bare).problems, ['brand/marks/ is listed without an origin'])
})

test('every listed picture says where it came from and whose it is, and the cover is the one with a question open', () => {
  for (const e of POLICY.assets.files) assert.ok(e.origin.length > 30 && e.rights.length > 10, e.path)
  assert.deepEqual(POLICY.assets.files.filter((e) => e.open).map((e) => e.path), ['docs/cover.jpg'])
  // What the listing says of the cover is what the file itself says: it carries Content Credentials signed by Google.
  const cover = readFileSync(join(ROOT, 'docs/cover.jpg')).toString('latin1')
  assert.ok(cover.includes('c2pa.signature') && cover.includes('Google C2PA'), 'the cover carries Content Credentials from Google')
})

test('a third-party directory is listed with an allowed licence and carries that licence\'s text', () => {
  const files: Record<string, string> = {
    'third_party/kit/LICENSE': 'MIT License\n\nPermission is hereby granted, free of charge, to any person',
    'third_party/kit/NOTICE': 'notes',
    'third_party/model/LICENSE': '                                 Apache License\n                           Version 2.0, January 2004',
  }
  const reader = (held: Record<string, string>) => (p: string) => held[p] ?? null
  const policy = clone(POLICY)
  policy.assets.thirdParty = { kit: { licence: 'MIT', text: 'LICENSE', carries: ['NOTICE'] }, model: { licence: 'Apache-2.0', text: 'LICENSE' } }
  const run = (held = files, p = policy) => g.thirdPartyFindings(Object.keys(held), p, reader(held))
  assert.deepEqual(run(), [])
  assert.deepEqual(run({ ...files, 'third_party/new/code.js': 'x' }), ['third_party/new is not listed in tools/license/policy.json (assets.thirdParty): state its licence and the texts it carries'])
  const { 'third_party/kit/NOTICE': _notice, ...noNotice } = files
  assert.deepEqual(run(noNotice), ['third_party/kit/NOTICE is missing'])
  assert.deepEqual(run({ ...files, 'third_party/kit/LICENSE': 'GNU GENERAL PUBLIC LICENSE\nVersion 3' }), ['third_party/kit/LICENSE does not read as MIT'])
  const { 'third_party/model/LICENSE': _text, ...noModel } = files
  assert.deepEqual(run(noModel), ['third_party/model is listed in tools/license/policy.json and is not in the repository'])
  const copyleft = clone(policy)
  copyleft.assets.thirdParty.kit.licence = 'GPL-3.0-only'
  const found: string[] = run(files, copyleft)
  assert.ok(found.some((f) => f === 'third_party/kit is under GPL-3.0-only: GPL-3.0-only is not a licence the policy allows'), found.join('\n'))
  // The real ones: six directories, MIT or Apache-2.0 each.
  assert.deepEqual(Object.entries(POLICY.assets.thirdParty).map(([name, d]) => `${name}: ${d.licence}`), [
    'llama.cpp: MIT', 'moonshine-tiny-en: MIT', 'onnxruntime-web: MIT', 'qwen2.5-0.5b-instruct: Apache-2.0', 'qwen2.5-1.5b-instruct: Apache-2.0', 'wllama: MIT',
  ])
})

test('the tree walk leaves out what other programs write, and nothing else', () => {
  const paths: string[] = g.tree()
  for (const p of paths) assert.doesNotMatch(p, /(?:^|\/)(?:node_modules|target|dist|dist-web|\.git)\//, p)
  for (const must of ['README.md', 'docs/cover.jpg', 'src/main.tsx', 'crimson_noir_os/Cargo.lock', 'src-tauri/icons/icon.png', 'third_party/llama.cpp/LICENSE', '.github/workflows/ci.yml', 'tools/license/policy.json']) {
    assert.ok(paths.includes(must), must)
  }
})

// ---------------------------------------------------------------------------------------------------------------
// Where it runs

test('the registry half runs in CI where cargo is, as a named check, before the Rust tests', () => {
  const checks = read('tools/selfheal/checks.sh')
  assert.match(checks, /^ {4}crate-licences\) node tools\/license\/gate\.mjs crates --check ;;$/m)
  // Not in ALL: the self-healing agent's sandbox has no network to ask the registry with.
  assert.doesNotMatch(checks.match(/^ALL="([^"]*)"$/m)![1], /crate-licences/)
  const ci = read('.github/workflows/ci.yml')
  assert.match(ci, /^ {8}run: sh tools\/selfheal\/checks\.sh crate-licences rust-test rust-clippy native-test fvps-wasm$/m)
  // The file half is this test, which page-test runs with every other test under src/.
  assert.match(checks, /^ {4}page-test\) +node --test "src\/\*\*\/\*\.test\.ts" ;;$/m)
})
