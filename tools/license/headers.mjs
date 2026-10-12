#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the one place the repository's licence headers are defined and enforced: which
 * directories are the proprietary core and which are open-source auxiliary tooling (LICENSE says the same in prose),
 * the header each kind of file carries, and the tool that writes or checks them. `node tools/license/headers.mjs
 * check` lists every source file whose header is missing or wrong and exits 1 (CI runs it: tools/selfheal/checks.sh
 * license-headers); `node tools/license/headers.mjs apply` writes the missing headers in place and leaves correct
 * ones alone. A header goes at the top of the file, after any line that must stay first (a shebang, a Dockerfile
 * `# syntax=` directive, a PowerShell `#Requires`). Files whose text is hashed or sealed (containment.*), data,
 * lockfiles, JSON and prose are not headed.
 * What breaks if it is removed? A new file ships without saying who owns it and under which licence, and nothing
 * notices.
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, basename, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export const HOLDER = 'Julian Cassius Subban'
export const YEAR = '2026'

/** The two headers, as lines without comment syntax. */
export const HEADERS = {
  proprietary: [
    `Copyright (c) ${YEAR} ${HOLDER}. All Rights Reserved.`,
    'SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary',
    'Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.',
  ],
  mit: [
    `Copyright (c) ${YEAR} ${HOLDER}`,
    'SPDX-License-Identifier: MIT',
    'Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).',
  ],
}

/**
 * The licence a path falls under, by its first directory (or its name at the root). The proprietary core is the
 * OS, the native cores, the page's runtime (agents, rules, cognition, network), the page's build and the desktop
 * shell (src-tauri); the auxiliary
 * tooling is everything that builds, checks, heals, deploys or publishes it. LICENSE lists the same split.
 */
export const PROPRIETARY_DIRS = ['src', 'crimson_noir_os', 'native', 'world', 'brand', 'src-tauri']
export const MIT_DIRS = ['tools', 'deploy', '.github', 'docs']
const ROOT_FILES = {
  'index.html': 'proprietary',
  'vite.config.ts': 'proprietary',
  Dockerfile: 'mit',
  'publish.ps1': 'mit',
}

export function licenseOf(rel) {
  const [head] = rel.split('/')
  if (rel in ROOT_FILES) return ROOT_FILES[rel]
  if (PROPRIETARY_DIRS.includes(head)) return 'proprietary'
  if (MIT_DIRS.includes(head)) return 'mit'
  return null
}

/** Comment syntax by file name: [line prefix] or [block open, line prefix, block close]. */
export function commentStyle(name) {
  const ext = extname(name).toLowerCase()
  if (['.ts', '.tsx', '.mts', '.mjs', '.js', '.rs', '.wgsl'].includes(ext)) return { line: '// ' }
  if (ext === '.css') return { open: '/*', line: ' * ', close: ' */' }
  if (ext === '.html' || ext === '.svg') return { open: '<!--', line: '  ', close: '-->' }
  if (['.py', '.sh', '.yml', '.yaml', '.toml', '.ps1', '.nix', '.conf'].includes(ext)) return { line: '# ' }
  if (/^Dockerfile(\..*)?$/.test(name) && !name.endsWith('.dockerignore')) return { line: '# ' }
  return null
}

/** Files never headed, whatever their directory: hashed or sealed configuration, generated and binary data. */
const SKIP = /(^|\/)(containment\.(nix|canonical|lock|seal)|Cargo\.lock|package-lock\.json)$/

/** The number of leading lines that must stay first: a shebang, Dockerfile directives, PowerShell #Requires. */
export function preamble(lines, name) {
  let n = 0
  if (lines[0]?.startsWith('#!')) n = 1
  if (/^Dockerfile(\..*)?$/.test(name)) while (lines[n]?.startsWith('# syntax=') || lines[n]?.startsWith('# check=')) n++
  if (name.endsWith('.ps1')) while (lines[n]?.startsWith('#Requires')) n++
  return n
}

export function renderHeader(kind, style) {
  const body = HEADERS[kind]
  if (style.open) return [style.open, ...body.map((l) => style.line + l), style.close]
  return body.map((l) => style.line + l)
}

export function hasHeader(text, kind, style, name) {
  const lines = text.split('\n')
  const n = preamble(lines, name)
  const want = renderHeader(kind, style)
  return want.every((l, i) => lines[n + i] === l)
}

export function withHeader(text, kind, style, name) {
  const lines = text.split('\n')
  const n = preamble(lines, name)
  const header = renderHeader(kind, style)
  return [...lines.slice(0, n), ...header, ...lines.slice(n)].join('\n')
}

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules' || name === 'target' || name === 'dist') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else yield p
  }
}

/** Every headed file under the root: its path, licence and comment style. */
export function* sources(root = ROOT) {
  for (const p of files(root)) {
    const rel = relative(root, p).replaceAll('\\', '/')
    if (SKIP.test(rel)) continue
    const kind = licenseOf(rel)
    const style = commentStyle(basename(p))
    if (kind && style) yield { path: p, rel, kind, style }
  }
}

function main(mode) {
  const wrong = []
  let count = 0
  for (const { path, rel, kind, style } of sources()) {
    count++
    const text = readFileSync(path, 'utf8')
    if (hasHeader(text, kind, style, basename(path))) continue
    if (mode === 'apply') writeFileSync(path, withHeader(text, kind, style, basename(path)))
    wrong.push(`${rel} (${kind})`)
  }
  if (mode === 'apply') {
    console.log(`license-headers: ${wrong.length} of ${count} files headed`)
    return 0
  }
  for (const w of wrong) console.log(`license-headers: missing header: ${w}`)
  console.log(`license-headers: ${count} files checked, ${wrong.length} without their header`)
  return wrong.length ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const mode = process.argv[2] ?? 'check'
  if (!['check', 'apply'].includes(mode)) { console.error('usage: headers.mjs [check|apply]'); process.exit(2) }
  process.exit(main(mode))
}
