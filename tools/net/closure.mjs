#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It lists, and with `--into DIR` copies, exactly the files the authoritative host needs at
 * run time, so its container image (Dockerfile) carries those and nothing else: no page code, no tests, no dev tools.
 * - Every entry's imports are followed the way Node follows them. Node strips the TypeScript types before it reads a
 *   module (`module.stripTypeScriptTypes`, the same stripper it runs itself), so an `import type` is never followed
 *   and `import { type A, b }` still is.
 * - A package (`@dimforge/rapier3d-simd-compat`) is followed into its own ESM entry; its package.json and licence go
 *   with it, so the image keeps the notice the licence asks for.
 * - Anything the closure cannot account for (an import it cannot resolve, a dynamic import of a computed name) stops
 *   it with an error rather than leaving the image a file short. The image's build then starts the host from the copy
 *   alone, so a closure that misses a file never ships.
 * Usage: node tools/net/closure.mjs ENTRY... [--into DIR]
 * What breaks if it is removed? The Dockerfile has no way to build a minimal image of the host.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const args = process.argv.slice(2)
const at = args.indexOf('--into')
const into = at === -1 ? null : resolve(args[at + 1] ?? '')
const entries = (at === -1 ? args : args.slice(0, at).concat(args.slice(at + 2))).map((e) => resolve(ROOT, e))
if (entries.length === 0) throw new Error('usage: node tools/net/closure.mjs ENTRY... [--into DIR]')

// Static imports and re-exports (any number of lines, no quotes or semicolons before `from`), bare imports, and
// dynamic imports of a string literal, each at the start of a line or after a semicolon. Comments are blanked first.
// A dynamic import of anything else is refused below. Should a pattern still miss an import, the image's build
// starts the host from the copy (tools/net/image-check.mjs) and fails, and closure.node.test.ts holds this list equal
// to what Node loads.
const STATIC = /(?:^|;)[ \t]*(?:import|export)\b((?:(?!\n[ \t]*(?:import|export)\b)[^;'"`])*?)\bfrom\s*['"]([^'"]+)['"]/gm
const BARE = /(?:^|;)[ \t]*import\s*['"]([^'"]+)['"]/gm
const DYNAMIC = /\bimport\s*\(\s*([^)]*?)\s*\)/g

/**
 * The source with its comments turned to spaces (line breaks kept), strings and template literals left as they are.
 * A quote inside a regular expression literal is taken for a string's start; a string ends at the line's end anyway.
 */
function uncommented(src) {
  let out = ''
  let state = 'code'
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    const next = src[i + 1]
    if (state === 'code') {
      if (c === '/' && next === '/') state = 'line'
      else if (c === '/' && next === '*') state = 'block'
      else if (c === "'" || c === '"' || c === '`') state = c
      out += state === 'line' || state === 'block' ? ' ' : c
    } else if (state === 'line') {
      if (c === '\n') state = 'code'
      out += c === '\n' ? c : ' '
    } else if (state === 'block') {
      if (c === '*' && next === '/') {
        out += '  '
        i++
        state = 'code'
      } else out += c === '\n' ? c : ' '
    } else {
      out += c
      if (c === '\\') {
        out += next ?? ''
        i++
      } else if (c === state || (c === '\n' && state !== '`')) state = 'code'
    }
  }
  return out
}

const files = new Set()
const packages = new Map()

/** The source as Node runs it: types stripped (whitespace in their place) for TypeScript, as is for JavaScript. */
function runnable(file) {
  const text = readFileSync(file, 'utf8')
  return /\.[cm]?ts$/.test(file) ? stripTypeScriptTypes(text, { mode: 'strip' }) : text
}

/** A package's directory, found the way Node finds it: node_modules folders from the importer upward. */
function packageDir(name, from) {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    if (dirname(dir) === dir) throw new Error(`${relative(ROOT, from)}: cannot find the package '${name}'`)
  }
}

/** The file a package's ESM import resolves to: exports["."] (import, then default), then module, then main. */
function packageEntry(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const dot = typeof pkg.exports === 'string' ? pkg.exports : pkg.exports?.['.']
  const pick = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? pick(v.import ?? v.default) : undefined)
  const entry = pick(dot) ?? pkg.module ?? pkg.main
  if (typeof entry !== 'string') throw new Error(`${dir}: no ESM entry`)
  return { entry: join(dir, entry), dependencies: Object.keys(pkg.dependencies ?? {}) }
}

function walk(file) {
  if (files.has(file)) return
  // statSync, not existsSync: existsSync answers false to every error, so a file the machine would not let us open
  // (an on-access scanner holding it, EPERM on Windows) read as "missing"; the real error names the real cause.
  try { statSync(file) } catch (e) { throw new Error(e.code === 'ENOENT' ? `missing module ${relative(ROOT, file)}` : `cannot read ${relative(ROOT, file)}: ${e.message}`) }
  files.add(file)
  const src = uncommented(runnable(file))
  const specs = [...src.matchAll(STATIC)].map((m) => m[2]).concat([...src.matchAll(BARE)].map((m) => m[1]))
  for (const m of src.matchAll(DYNAMIC)) {
    const literal = /^(['"])([^'"]+)\1$/.exec(m[1])
    if (!literal) throw new Error(`${relative(ROOT, file)}: a dynamic import of a computed name (${m[1]}) cannot be followed`)
    specs.push(literal[2])
  }
  for (const spec of specs) {
    if (spec.startsWith('node:')) continue
    if (spec.startsWith('.') || spec.startsWith('/')) {
      walk(resolve(dirname(file), spec))
      continue
    }
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]
    if (spec !== name) throw new Error(`${relative(ROOT, file)}: a deep import '${spec}' is not followed`)
    if (packages.has(name)) continue
    const dir = packageDir(name, file)
    const { entry, dependencies } = packageEntry(dir)
    packages.set(name, dir)
    walk(entry)
    for (const d of dependencies) walk(packageEntry(packageDir(d, entry)).entry)
  }
}

for (const e of entries) walk(e)
// Each package's manifest (Node reads it to resolve the import) and its licence and notice files.
for (const dir of packages.values()) {
  for (const f of readdirSync(dir)) if (f === 'package.json' || /^(licen[cs]e|notice|copying)/i.test(f)) files.add(join(dir, f))
}

// The list is printed with forward slashes on every platform: the image is built on Linux, and closure.node.test.ts
// compares it with the URLs Node loaded, which are always forward-slashed; the copy below joins with the host's own.
const list = [...files].map((f) => relative(ROOT, f)).sort()
for (const f of list) if (f.startsWith('..') || f.split(sep).includes('..')) throw new Error(`outside the repository: ${f}`)
if (into) {
  for (const f of list) {
    mkdirSync(dirname(join(into, f)), { recursive: true })
    copyFileSync(join(ROOT, f), join(into, f))
  }
}
console.log(list.map((f) => f.split(sep).join('/')).join('\n'))
