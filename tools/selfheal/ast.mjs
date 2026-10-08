// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the map from a failure's file and line to the syntax tree: the smallest
 * declaration that contains the line (a function, method, class, variable statement or interface in TypeScript and
 * JavaScript, read with the TypeScript compiler's parser; a `fn`, `impl`, `struct`, `enum`, `const` or `mod` item
 * in Rust, found by brace matching) with its exact character span. A patch from the planner replaces a locus whole,
 * so every edit is structural: a declaration is swapped for a declaration, never a line spliced into the middle of
 * one, and the file still parses or the edit is refused. Pure over the text it is given.
 * What breaks if it is removed? The planner would patch lines, and a patch could land inside a declaration.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** A locus: a declaration's kind and name, its [start, end) character span and its text. */
export function locus(kind, name, start, end, text) {
  return { kind, name, start, end, text: text.slice(start, end) }
}

function tsModule() {
  try {
    return require('typescript')
  } catch {
    return null
  }
}

/** The line (1-based) a character offset is on. */
export function lineOf(text, offset) {
  let n = 1
  for (let i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

/** The character offset where `line` (1-based) starts. */
export function offsetOfLine(text, line) {
  let n = 1, i = 0
  while (n < line && i < text.length) {
    if (text.charCodeAt(i) === 10) n++
    i++
  }
  return i
}

/** The innermost declaration of a TypeScript/JavaScript file containing `line`, or null. */
export function tsLocus(text, line, fileName = 'x.ts') {
  const ts = tsModule()
  if (!ts) return null
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined)
  let best = null
  const consider = (node, kind, name) => {
    const start = node.getStart(sf), end = node.getEnd()
    // Containment by line: a declaration holds the line when the line lies between its first and last lines.
    if (lineOf(text, start) <= line && line <= lineOf(text, Math.max(start, end - 1)) && (best === null || end - start < best.end - best.start)) best = locus(kind, name, start, end, text)
  }
  const visit = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name) consider(node, 'function', node.name.text)
    else if (ts.isMethodDeclaration(node) && node.name) consider(node, 'method', node.name.getText(sf))
    else if (ts.isClassDeclaration(node) && node.name) consider(node, 'class', node.name.text)
    else if (ts.isInterfaceDeclaration(node)) consider(node, 'interface', node.name.text)
    else if (ts.isTypeAliasDeclaration(node)) consider(node, 'type', node.name.text)
    else if (ts.isEnumDeclaration(node)) consider(node, 'enum', node.name.text)
    else if (ts.isVariableStatement(node)) consider(node, 'variable', node.declarationList.declarations.map((d) => d.name.getText(sf)).join(','))
    else if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.parent === sf) {
      // A top-level `test('name', ...)` / `describe(...)` call is a locus of its own.
      const callee = node.expression.expression.getText(sf)
      const first = node.expression.arguments[0]
      if (first && ts.isStringLiteral(first)) consider(node, callee, first.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return best
}

/** True when the TypeScript/JavaScript text parses without a syntax error. */
export function tsParses(text, fileName = 'x.ts') {
  const ts = tsModule()
  if (!ts) return true
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined)
  return sf.parseDiagnostics.length === 0
}

/** The end offset of the item starting at `start`: the matching close brace, or the first `;` at depth 0. */
function rustItemEnd(text, start) {
  let depth = 0, i = start, inStr = false, inChar = false, lineComment = false, blockComment = 0
  for (; i < text.length; i++) {
    const c = text[i], n = text[i + 1]
    if (lineComment) { if (c === '\n') lineComment = false; continue }
    if (blockComment) { if (c === '*' && n === '/') { blockComment--; i++ } else if (c === '/' && n === '*') { blockComment++; i++ } continue }
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue }
    if (inChar) { if (c === '\\') i++; else if (c === "'") inChar = false; continue }
    if (c === '/' && n === '/') { lineComment = true; i++; continue }
    if (c === '/' && n === '*') { blockComment = 1; i++; continue }
    if (c === '"') { inStr = true; continue }
    if (c === "'" && /[^\\]'|\\./.test(text.slice(i + 1, i + 4)) && !/[A-Za-z0-9_]/.test(text[i - 1] ?? '')) {
      // A char literal, not a lifetime: 'a' or '\n'
      const m = /^'(?:\\.|[^\\'])'/.exec(text.slice(i))
      if (m) { i += m[0].length - 1; continue }
    }
    if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i + 1 }
    else if (c === ';' && depth === 0) return i + 1
  }
  return i
}

/** The innermost Rust item containing `line`, or null. */
export function rustLocus(text, line) {
  const at = offsetOfLine(text, line)
  const lines = text.split('\n')
  let best = null
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    const m = /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:unsafe|const|async|extern\s+"[^"]*")\s+)*(fn|impl|struct|enum|trait|mod|const|static|type)\b/.exec(l)
    if (m) {
      // Attributes and doc comments directly above belong to the item.
      let start = offset
      let k = i - 1, back = offset
      while (k >= 0 && /^\s*(#\[|\/\/\/)/.test(lines[k])) { back -= lines[k].length + 1; start = back; k-- }
      const end = rustItemEnd(text, offset + m[1].length)
      if (start <= at && at < end && (best === null || end - start < best.end - best.start)) {
        const name = m[2] === 'impl'
          ? [null, l.slice(l.indexOf('impl') + 4).replace(/\{.*$/, '').replace(/<[^>]*>/g, '').trim()]
          : new RegExp(`\\b${m[2]}\\s+([A-Za-z_][A-Za-z0-9_]*)`).exec(l)
        best = locus(m[2], name && name[1] ? name[1] : m[2], start, end, text)
      }
    }
    offset += l.length + 1
  }
  return best
}

/** The locus for a repository file and line, by its language. */
export function locusOf(file, line, text = null) {
  const src = text ?? readFileSync(file, 'utf8')
  if (/\.rs$/.test(file)) return rustLocus(src, line)
  if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(file)) return tsLocus(src, line, file)
  return null
}

/**
 * The text with `replacement` in place of the locus named `name` (and of `kind`, when given). Refuses, with a
 * reason, a locus that does not exist, is ambiguous, or a result that no longer parses (TypeScript/JavaScript).
 */
export function replaceLocus(file, text, name, replacement, kind = null) {
  const found = allLoci(file, text).filter((l) => l.name === name && (kind === null || l.kind === kind))
  if (found.length === 0) return { ok: false, reason: `${file}: no declaration named ${name}` }
  if (found.length > 1) return { ok: false, reason: `${file}: ${found.length} declarations named ${name}; name the kind` }
  const l = found[0]
  const next = text.slice(0, l.start) + replacement + text.slice(l.end)
  if (/\.(?:ts|tsx|mts|cts|js|mjs|cjs|jsx)$/.test(file) && !tsParses(next, file)) return { ok: false, reason: `${file}: the replacement for ${name} does not parse` }
  return { ok: true, text: next, locus: l }
}

/** Every locus of a file (top-level and nested), for naming and for replacement. */
export function allLoci(file, text) {
  const out = []
  if (/\.rs$/.test(file)) {
    const lines = text.split('\n')
    let offset = 0
    for (const l of lines) {
      if (/^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:unsafe|const|async|extern\s+"[^"]*")\s+)*(fn|impl|struct|enum|trait|mod|const|static|type)\b/.test(l)) {
        const loc = rustLocus(text, lineOf(text, offset))
        if (loc && !out.some((o) => o.start === loc.start && o.end === loc.end)) out.push(loc)
      }
      offset += l.length + 1
    }
    return out
  }
  const ts = tsModule()
  if (!ts) return out
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : undefined)
  const visit = (node) => {
    const line = lineOf(text, node.getStart(sf))
    const l = tsLocus(text, line, file)
    if (l && l.start === node.getStart(sf) && !out.some((o) => o.start === l.start && o.end === l.end)) out.push(l)
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
