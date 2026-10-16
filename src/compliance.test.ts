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
import { bundledPackageDirs, missingNotices, noticesComment, packageRoot, OPERATOR_NOTES, type PackageNotice } from '../vite.config.ts'
import { glyph, type ControlAction, type GlyphFamily } from './07_Execute_Actions/glyphs.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)

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
})

test('the real runtime dependencies all have a licence file the build can embed', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  for (const name of Object.keys(pkg.dependencies)) {
    const dir = join(ROOT, 'node_modules', name)
    assert.ok(readdirSync(dir).some((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f)), `${name} ships no licence file`)
  }
  const rapier = readFileSync(join(ROOT, 'node_modules/@dimforge/rapier3d-simd-compat/LICENSE'), 'utf8')
  assert.match(rapier, /Apache License/)
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
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx|wgsl|css|html|md)$/.test(name)) yield p
  }
}

test('no scrubbed brand name in the source, the tests, the build config, the HTML shell, the README or the shipped notice', () => {
  const shipped = readFileSync(join(ROOT, 'NOTICE.md'), 'utf8')
  const texts: [string, string][] = [
    ...[...files(join(ROOT, 'src'))].filter((f) => f !== SELF).map((f) => [relative(ROOT, f), readFileSync(f, 'utf8')] as [string, string]),
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
    const m = code(readFileSync(f, 'utf8')).match(REAL_PLACES)
    assert.equal(m, null, `${relative(ROOT, f)}: "${m?.[0]}"`)
  }
  assert.equal(code('const a = "x" // Toronto\n/* Ontario */ fetch("http://localhost") // Yonge').match(REAL_PLACES), null, 'comments are skipped, URLs kept')
  assert.ok(code("const label = 'Clear · Toronto'").match(REAL_PLACES), 'a string is caught')
})

test('every source file opens with why it exists and what breaks without it (the README\'s promise)', () => {
  const sources = [...files(join(ROOT, 'src'))].filter((f) => /\.(ts|tsx|css|wgsl)$/.test(f))
  assert.ok(sources.length > 100, `${sources.length} files read`)
  const missing = sources.filter((f) => {
    const head = readFileSync(f, 'utf8').split('\n').slice(0, 40).join('\n')
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

/** Licences that reach into the code that uses them (strong copyleft, or non-commercial): none may be anywhere in the tree. */
const STRONG_COPYLEFT = /\b(?:A?GPL|LGPL|SSPL|EUPL|OSL|CPAL|CC-BY-(?:NC|SA)[\w.-]*)\b/i
/** File-level copyleft: fine in a build tool that is never bundled, never in a runtime dependency. */
const WEAK_COPYLEFT = /\b(?:MPL|EPL|CDDL)\b/i

test('the npm tree: no GPL, AGPL, LGPL or non-commercial licence anywhere; file-level copyleft only in build tooling that is never bundled', () => {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')) as { packages: Record<string, { license?: string; dev?: boolean }> }
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
  const entries = Object.entries(lock.packages).filter(([path]) => path !== '')
  assert.ok(entries.length > 100, `${entries.length} packages in the lockfile`)
  const strong = entries.filter(([, v]) => STRONG_COPYLEFT.test(v.license ?? ''))
  assert.deepEqual(strong.map(([p, v]) => `${p}: ${v.license}`), [])
  const unlicensed = entries.filter(([, v]) => !v.license)
  assert.deepEqual(unlicensed.map(([p]) => p), [], 'every package names its licence in the lockfile')
  const weak = entries.filter(([, v]) => WEAK_COPYLEFT.test(v.license ?? ''))
  for (const [path, v] of weak) {
    assert.equal(v.dev, true, `${path} (${v.license}) is a runtime dependency`)
    assert.match(path, /lightningcss/, `${path}: a weak-copyleft package the audit (docs/ip-audit.md) does not know`)
  }
  assert.ok(weak.length > 0, 'lightningcss (MPL-2.0, Tailwind\'s CSS compiler, dev only) is in the tree: update the audit if it leaves')
  // The four runtime dependencies are permissive, and only they are bundled (the notice test above holds that).
  for (const name of Object.keys(pkg.dependencies)) {
    const lic = lock.packages[`node_modules/${name}`]?.license ?? ''
    assert.match(lic, /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC|0BSD|Unlicense)$/, `${name}: ${lic}`)
  }
})

/** Every file under a directory, whatever its kind (the walker above keeps to the page's own kinds), build output skipped. */
function* every(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'target' || name === 'node_modules' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* every(p)
    else yield p
  }
}

/** The engines and tools the upgrade plan feared were copied in: their names may appear in the audit alone. */
const FOREIGN_SOURCES = /\b(?:vk_?quake|vkquake3|ioquake|ioq3|quake3|id ?tech|makehuman|mpfb2?)\b/i

test('no code from a copyleft engine or character tool anywhere in the repository (the audit document is the one place their names appear)', () => {
  const dirs = ['src', 'native', 'crimson_noir_os', 'src-tauri', 'tools', 'world', 'brand', 'deploy', '.github', 'docs']
  const text = /\.(?:ts|tsx|mts|mjs|js|json|rs|toml|wgsl|glsl|html|css|md|txt|yml|yaml|sh|ps1|py|nix|lock)$/
  const scanned: string[] = []
  for (const d of dirs) {
    let found = false
    try { found = statSync(join(ROOT, d)).isDirectory() } catch { found = false }
    if (!found) continue
    for (const f of every(join(ROOT, d))) if (text.test(f)) scanned.push(f)
  }
  for (const f of ['README.md', 'MANUAL.md', 'NOTICE.md', 'LICENSE', 'index.html', 'vite.config.ts', 'package.json', 'Dockerfile']) scanned.push(join(ROOT, f))
  assert.ok(scanned.length > 300, `${scanned.length} files scanned`)
  const audit = join(ROOT, 'docs', 'ip-audit.md')
  for (const f of scanned) {
    if (f === SELF || f === audit) continue
    const m = readFileSync(f, 'utf8').match(FOREIGN_SOURCES)
    assert.equal(m, null, `${relative(ROOT, f)}: "${m?.[0]}"`)
  }
  assert.match(readFileSync(audit, 'utf8'), FOREIGN_SOURCES, 'the audit names them, so a reader knows they were looked for')
})
