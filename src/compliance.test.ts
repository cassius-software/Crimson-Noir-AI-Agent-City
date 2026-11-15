// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It keeps the commercial build legally clean.
 * - Every runtime dependency ships its licence text: the build fails otherwise. That includes Rapier, which rides
 *   in the physics worker's own bundle, so the page's chunks never showed it.
 * - The product, its tests, its build and its README name no third-party game platform, film or console brand
 *   that the operator asked scrubbed.
 * - The controller hints use no console maker's button symbols.
 * What breaks if it is removed? A licence could silently drop out of dist/index.html again, or a brand name or
 * trademarked button symbol could creep back into the UI, the code or the README.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledPackageDirs, missingNotices, noticesComment, packageRoot, readPackageNotice, NO_LICENCE_TEXT, OPERATOR_NOTES, RECORDED_LICENCES, type PackageNotice } from '../vite.config.ts'
import { glyph, type ControlAction, type GlyphFamily } from './07_Execute_Actions/glyphs.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
// The scanner defence is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const HELD: string = '../tools/test/held.mjs'
/** readFileSync that waits out a file a Windows on-access scanner holds (tools/test/held.mjs): the walks in this file read hundreds. */
const { readHeld } = (await import(HELD)) as { readHeld(path: string, encoding: 'utf8'): string }

/** What Nix leaves in a checkout, at any depth (tools/license/headers.mjs nixLeftover): `nix build`'s result links
 *  into the store (dangling once it is collected) and direnv's cache of the dev shell, which holds the whole of
 *  nixpkgs. Neither is the repository's text, and the store's copy of the page is not the source. */
const nixLeftover = (name: string) => name === '.direnv' || name === 'result' || name.startsWith('result-')

// ---------------------------------------------------------------------------------------------------
// Licences

test('packageRoot: the node_modules package a module id belongs to (scoped, nested, Windows paths, queries)', () => {
  assert.equal(packageRoot('/app/node_modules/three/build/three.module.js'), '/app/node_modules/three')
  assert.equal(packageRoot('/app/node_modules/@dimforge/rapier3d-simd-compat/rapier.mjs?worker'), '/app/node_modules/@dimforge/rapier3d-simd-compat')
  assert.equal(packageRoot('C:\\app\\node_modules\\react-dom\\cjs\\x.js'), 'C:/app/node_modules/react-dom')
  assert.equal(packageRoot('/app/node_modules/a/node_modules/b/i.js'), '/app/node_modules/a/node_modules/b', 'the innermost package')
  assert.equal(packageRoot('/app/src/engine.ts'), null)
  assert.equal(packageRoot('\0vite/preload-helper'), null)
})

test('bundledPackageDirs: every chunk\'s packages once, assets and virtual modules ignored', () => {
  const dirs = bundledPackageDirs({
    main: { type: 'chunk', moduleIds: ['/app/node_modules/three/a.js', '/app/node_modules/three/b.js', '/app/src/x.ts'] },
    worker: { type: 'chunk', moduleIds: ['/app/node_modules/@dimforge/rapier3d-simd-compat/r.js', '\0rolldown/runtime'] },
    css: { type: 'asset' },
  })
  assert.deepEqual(dirs.sort(), ['/app/node_modules/@dimforge/rapier3d-simd-compat', '/app/node_modules/three'])
})

test('missingNotices: every runtime dependency must have its notice (the build throws on any it lists)', () => {
  const notice = (name: string): PackageNotice => ({ name, version: '1.0.0', license: 'MIT', text: 'MIT License' })
  const deps = { '@dimforge/rapier3d-simd-compat': '^0.21.0', react: '^19', 'react-dom': '^19', three: '^0.186' }
  assert.deepEqual(missingNotices(deps, ['react', 'react-dom', 'three', 'scheduler'].map(notice)), ['@dimforge/rapier3d-simd-compat'],
    'the page\'s chunks alone miss the worker\'s Rapier')
  assert.deepEqual(missingNotices(deps, ['@dimforge/rapier3d-simd-compat', 'react', 'react-dom', 'three'].map(notice)), [])
  assert.deepEqual(missingNotices({}, []), [])
  // A notice with no licence text is no notice: a package that ships none, and has none recorded, fails the build.
  assert.deepEqual(missingNotices({ three: '^0.186' }, [{ ...notice('three'), text: NO_LICENCE_TEXT }]), ['three'])
})

test('the real runtime dependencies all have a licence file the build can embed', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  for (const name of Object.keys(pkg.dependencies)) {
    const dir = join(ROOT, 'node_modules', name)
    const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version
    // In the package itself, or recorded in third_party/ for exactly the installed version (vite.config.ts RECORDED_LICENCES).
    const shipped = readdirSync(dir).some((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f))
    assert.ok(shipped || `${name}@${version}` in RECORDED_LICENCES, `${name} ${version} ships no licence file and none is recorded for that version`)
    const notice = readPackageNotice(dir)
    assert.ok(notice && notice.text !== NO_LICENCE_TEXT && notice.text.length > 500, `${name}: the build would embed no licence text`)
  }
  const rapier = readFileSync(join(ROOT, 'node_modules/@dimforge/rapier3d-simd-compat/LICENSE'), 'utf8')
  assert.match(rapier, /Apache License/)
  // The one recorded licence: the speech runtime's package says MIT and ships no text. The record is the project's
  // own LICENSE at that tag, then the licence of the Emscripten support code its script carries; nothing is recorded
  // for a package that does ship its own (the package's text always wins).
  assert.deepEqual(Object.keys(RECORDED_LICENCES), ['onnxruntime-web@1.31.1'])
  for (const [id, file] of Object.entries(RECORDED_LICENCES)) {
    const name = id.slice(0, id.lastIndexOf('@'))
    assert.ok(!readdirSync(join(ROOT, 'node_modules', name)).some((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)), `${name} ships its own licence file now: drop the record`)
    assert.ok(statSync(join(ROOT, file)).isFile(), `${file} is there`)
  }
  const ort = readPackageNotice(join(ROOT, 'node_modules/onnxruntime-web'))
  assert.deepEqual([ort?.name, ort?.version, ort?.license], ['onnxruntime-web', '1.31.1', 'MIT'])
  const recorded = readFileSync(join(ROOT, 'third_party/onnxruntime-web/1.31.1/SCRIPT-LICENCE'), 'utf8')
  assert.equal(ort?.text, recorded.trim())
  assert.ok(recorded.startsWith(readFileSync(join(ROOT, 'third_party/onnxruntime-web/1.31.1/LICENSE'), 'utf8').trimEnd()), 'it opens with the project\'s own LICENSE, unchanged')
  assert.match(recorded, /^MIT License\n\nCopyright \(c\) Microsoft Corporation\n/)
  // Emscripten offers two licences (MIT, and the University of Illinois/NCSA one that opens "All rights reserved"): both texts.
  assert.ok(/Copyright \(c\) 2010-2014 Emscripten authors, see AUTHORS file\.\n\nPermission is hereby granted, free of charge[\s\S]*Copyright \(c\) 2010-2014 Emscripten authors, see AUTHORS file\.\nAll rights reserved\.\n/.test(recorded), 'and carries Emscripten\'s, both of the licences it offers')
})

test('noticesComment: the shipped part of NOTICE.md and each package\'s full text, nothing of the operator notes', () => {
  const md = `# Notices\n\nShipped.\n${OPERATOR_NOTES}\n\nFor counsel only.`
  const c = noticesComment(md, [{ name: '@dimforge/rapier3d-simd-compat', version: '0.21.0', license: 'Apache-2.0', text: 'Apache License\nVersion 2.0' }])
  assert.match(c, /Shipped\./)
  assert.doesNotMatch(c, /For counsel only/)
  assert.match(c, /@dimforge\/rapier3d-simd-compat 0\.21\.0 \(Apache-2\.0\)\n\nApache License\nVersion 2\.0/)
})

// ---------------------------------------------------------------------------------------------------
// Names

/** Brand names the operator had scrubbed from the product: console makers and their pads, and a film franchise.
 *  (The linear-algebra "matrix" is not a brand: only film-style uses are caught.) */
const SCRUBBED: readonly RegExp[] = [/\bxbox\b/i, /\bnintendo\b/i, /\bjoy-?cons?\b/i, /\bthe matrix\b/i, /\bmatrix[- ](?:style|like|rain|code|effect)\b/i, /\bdigital rain\b/i]

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (nixLeftover(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx|wgsl|css|html|md)$/.test(name)) yield p
  }
}

test('no scrubbed brand name in the source, the tests, the build config, the HTML shell, the README or the shipped notice', () => {
  const shipped = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8')
  const texts: [string, string][] = [
    ...[...files(join(ROOT, 'src'))].filter((f) => f !== SELF).map((f) => [relative(ROOT, f), readHeld(f, 'utf8')] as [string, string]),
    ['vite.config.ts', readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')],
    ['index.html', readFileSync(join(ROOT, 'index.html'), 'utf8')],
    ['README.md', readFileSync(join(ROOT, 'README.md'), 'utf8')],
    // Only the notice that ships: the operator notes below it are legal research for counsel.
    ['NOTICE.md (shipped part)', shipped.slice(0, shipped.indexOf(OPERATOR_NOTES))],
  ]
  assert.ok(texts.length > 100, `${texts.length} files read`)
  for (const [name, text] of texts) {
    for (const re of SCRUBBED) {
      const m = text.match(re)
      assert.equal(m, null, `${name}: "${m?.[0]}"`)
    }
  }
})

/**
 * Real places of the region the city borrows its character from, and its landmarks and streets. The operator's rule:
 * fictional names only in anything the product shows (comments and docs may name the real region they describe).
 */
const REAL_PLACES = /\b(?:Toronto|Ontario|Mississauga|Brampton|Scarborough|Etobicoke|Markham|Oakville|Burlington|Oshawa|Pickering|Vaughan|Richmond Hill|Hamilton|Niagara|Cambridge|Galt|Hespeler|Harbourfront|Queens? Quay|Yonge|Gardiner|Don Valley|Humber|CN Tower|Rogers Centre|Scotiabank)\b/

/** The code of a source file without its comments (a line comment starts at // not preceded by a colon, as in URLs). */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

test('no real place name in anything the product shows: every string in the shipped source is fictional', () => {
  const shipped = [...files(join(ROOT, 'src'))].filter((f) => f !== SELF && !/\.test\.tsx?$/.test(f) && !/\.(md|css)$/.test(f))
  assert.ok(shipped.length > 50, `${shipped.length} files read`)
  for (const f of shipped) {
    const m = code(readHeld(f, 'utf8')).match(REAL_PLACES)
    assert.equal(m, null, `${relative(ROOT, f)}: "${m?.[0]}"`)
  }
  assert.equal(code('const a = "x" // Toronto\n/* Ontario */ fetch("http://localhost") // Yonge').match(REAL_PLACES), null, 'comments are skipped, URLs kept')
  assert.ok(code("const label = 'Clear · Toronto'").match(REAL_PLACES), 'a string is caught')
})

test('every source file opens with why it exists and what breaks without it (the README\'s promise)', () => {
  const sources = [...files(join(ROOT, 'src'))].filter((f) => /\.(ts|tsx|css|wgsl)$/.test(f))
  assert.ok(sources.length > 100, `${sources.length} files read`)
  const missing = sources.filter((f) => {
    const head = readHeld(f, 'utf8').split('\n').slice(0, 40).join('\n')
    return !head.includes('Why does this file exist?') || !head.includes('What breaks if it is removed?')
  })
  assert.deepEqual(missing.map((f) => relative(ROOT, f)), [])
})

test('controller hints carry no console maker\'s button symbols, in any family, for any action', () => {
  const families: GlyphFamily[] = ['keyboard', 'abxy', 'bayx', 'numbered', 'generic', 'touch']
  const actions: ControlAction[] = ['move', 'look', 'run', 'interact', 'handbrake', 'reset', 'throttle', 'brake', 'clock', 'console', 'hud', 'ghost', 'ping']
  for (const f of families) for (const a of actions) assert.doesNotMatch(glyph(a, f), /[✕×○◯△□▢⨯]/u, `${f}.${a}`)
  // The glyph table itself holds none either (not even unused).
  assert.doesNotMatch(readFileSync(join(ROOT, 'src/07_Execute_Actions/glyphs.ts'), 'utf8'), /[✕○△□]/u)
})

// ---------------------------------------------------------------------------------------------------
// The dependency tree and the third-party sources the upgrade plan worried about

/**
 * The licences any package in the tree may carry, exactly as the lockfile spells them. An allow-list, not a list of
 * what to refuse: a GPL, AGPL, LGPL, SSPL, non-commercial or source-available licence (BUSL-1.1, Elastic-2.0,
 * PolyForm, Commons Clause), `UNLICENSED` or `SEE LICENSE IN …` is refused because it is not here.
 */
const PERMISSIVE = new Set(['MIT', 'Apache-2.0', 'Apache-2.0 OR MIT', 'MIT OR Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'Unlicense'])
/** File-level copyleft: fine in a build tool that is never bundled, never in a runtime dependency. */
const WEAK_COPYLEFT = new Set(['MPL-2.0'])

test('the npm tree: every licence on a permissive allow-list (so no GPL, AGPL, LGPL, non-commercial or source-available one); file-level copyleft only in build tooling that is never bundled', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { license?: string; dev?: boolean }> }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const entries = Object.entries(lock.packages).filter(([path]) => path !== '')
  assert.ok(entries.length > 100, `${entries.length} packages in the lockfile`)
  const unlicensed = entries.filter(([, v]) => !v.license)
  assert.deepEqual(unlicensed.map(([p]) => p), [], 'every package names its licence in the lockfile')
  const other = entries.filter(([, v]) => !PERMISSIVE.has(v.license ?? '') && !WEAK_COPYLEFT.has(v.license ?? ''))
  assert.deepEqual(other.map(([p, v]) => `${p}: ${v.license}`), [], 'a licence off the allow-list: read it, then add it to the audit (docs/ip-audit.md) and here, or drop the package')
  const weak = entries.filter(([, v]) => WEAK_COPYLEFT.has(v.license ?? ''))
  for (const [path, v] of weak) {
    assert.equal(v.dev, true, `${path} (${v.license}) is a runtime dependency`)
    assert.match(path, /lightningcss/, `${path}: a weak-copyleft package the audit (docs/ip-audit.md) does not know`)
  }
  assert.ok(weak.length > 0, 'lightningcss (MPL-2.0, Tailwind\'s CSS compiler, dev only) is in the tree: update the audit if it leaves')
  // The six runtime dependencies are permissive, and only they are bundled (the notice test above holds that):
  // Rapier (Apache-2.0), React, three.js, wllama (MIT; its pinned WebAssembly module's own components are listed
  // in third_party/wllama/<version>/NOTICE and in the audit) and ONNX Runtime Web (MIT; the speech recogniser's
  // runtime: its script is bundled, its WebAssembly module is served beside the web copy, and what that module is
  // built from is in third_party/onnxruntime-web/<version>/ and in the audit). A seventh is a decision for the audit,
  // not a default.
  assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['@dimforge/rapier3d-simd-compat', '@wllama/wllama', 'onnxruntime-web', 'react', 'react-dom', 'three'])
  assert.equal(lock.packages['node_modules/@wllama/wllama']?.license, 'MIT')
  assert.equal(lock.packages['node_modules/onnxruntime-web']?.license, 'MIT')
  // The speech runtime's script is one self-contained file: it imports none of the packages its package.json lists
  // (they serve builds of the runtime this page does not use), so none of them is bundled or needs a notice here.
  const ortScript = readFileSync(join(ROOT, 'node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs'), 'utf8')
  assert.ok(!/\bimport\s*(?:[\w*{}\s,$]+\s*from\s*)?["'][^"']+["']|\bexport\s*(?:\*|\{[^}]*\})\s*from\s*["']|\brequire\(\s*["']/.test(ortScript), 'the script imports another module')
  assert.ok(!/flatbuffers|protobuf|guid-typescript/i.test(ortScript), 'the script carries one of the packages its package.json lists')
  for (const name of Object.keys(pkg.dependencies)) {
    const lic = lock.packages[`node_modules/${name}`]?.license ?? ''
    assert.ok(PERMISSIVE.has(lic), `${name}: ${lic}`)
  }
  // The allow-list does refuse what the audit says it refuses.
  for (const lic of ['GPL-3.0-only', 'AGPL-3.0-or-later', 'LGPL-2.1', 'SSPL-1.0', 'CC-BY-NC-4.0', 'BUSL-1.1', 'Elastic-2.0', 'PolyForm-Noncommercial-1.0.0', 'MIT AND Commons-Clause', 'UNLICENSED', 'SEE LICENSE IN LICENSE', 'MIT OR GPL-3.0']) {
    assert.ok(!PERMISSIVE.has(lic) && !WEAK_COPYLEFT.has(lic), lic)
  }
})

/** Every file under a directory, whatever its kind (the walker above keeps to the page's own kinds), build output skipped. */
function* every(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'target' || name === 'node_modules' || name === 'dist' || name === '.git' || nixLeftover(name)) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* every(p)
    else yield p
  }
}

/**
 * The engines and tools the upgrade plan feared were copied in, and the marks their sources carry (a Quake III file
 * says "Id Software" and "Quake III Arena"): their names may appear in the audit alone. A suffix is allowed
 * (`ioquake3`, `idTech3`, `vkQuake3`, `mpfb2`), so a versioned name is caught too.
 */
const FOREIGN_SOURCES = /\b(?:vk_?quake\w*|ioquake\w*|ioq3\w*|quake ?(?:3|iii)\b|id ?tech(?:\s?\d|\b)|id software\b|makehuman\w*|mpfb\w*)/i

test('no code from a copyleft engine or character tool in any text file of the repository (the audit document is the one place their names appear)', () => {
  // Every text file, wherever it is (the root's own files and extensionless ones such as LICENSE included), and the
  // C family the feared engines are written in; build output, dependencies and git's own store skipped.
  const text = /\.(?:ts|tsx|mts|cts|mjs|cjs|js|jsx|json|rs|toml|wgsl|glsl|frag|vert|html|css|md|txt|yml|yaml|sh|ps1|py|nix|lock|c|h|cc|cpp|cxx|hpp|hh|inc|s|asm|cmake|in|cfg|ini|xml|svg)$/i
  const scanned = [...every(ROOT)].filter((f) => text.test(f) || !/\.[^/\\]+$/.test(relative(ROOT, f).split(/[/\\]/).pop() ?? ''))
  assert.ok(scanned.length > 300, `${scanned.length} files scanned`)
  for (const f of ['README.md', 'MANUAL.md', 'CHANGELOG.md', 'NOTICE.md', 'LICENSE', 'context engineered system prompt', 'index.html', 'package.json', 'Dockerfile']) assert.ok(scanned.includes(join(ROOT, f)), `${f} is scanned`)
  for (const [name, hit] of [['ioquake3', true], ['idTech3', true], ['Quake III Arena', true], ['Copyright (C) 1999-2005 Id Software, Inc.', true], ['vkQuake3', true], ['MPFB2', true], ['earthquake 3', false], ['an id technique', false]] as const) {
    assert.equal(FOREIGN_SOURCES.test(name), hit, name)
  }
  const audit = join(ROOT, 'docs', 'ip-audit.md')
  for (const f of scanned) {
    if (f === SELF || f === audit) continue
    const m = readHeld(f, 'utf8').match(FOREIGN_SOURCES)
    assert.equal(m, null, `${relative(ROOT, f)}: "${m?.[0]}"`)
  }
  assert.match(readHeld(audit, 'utf8'), FOREIGN_SOURCES, 'the audit names them, so a reader knows they were looked for')
})
