#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? The apps (Windows, Linux, macOS, Android, iOS) are one Rust program around the page, and
 * that program is built with some four hundred open-source crates. Their licences let the product be sold closed
 * (tools/license/gate.mjs holds them to that), and nearly all of them ask one thing in return: that the copyright
 * notice and the licence text travel with every copy; the five under MPL-2.0 also ask that a recipient be told where
 * the source of those files is. This writes that one file, src-tauri/notices/RUST-CRATES.txt, from what cannot be
 * mistyped: the crates `cargo metadata` resolves for src-tauri's lockfile, and the licence, copyright and notice
 * files inside each crate's own package in cargo's registry.
 *   node tools/license/notices.mjs --write           write the file from the registry and the toolchain (needs
 *                                                    cargo, and the rustc the apps are built with)
 *   node tools/license/notices.mjs --check           write nothing; fail when the committed file differs from what
 *                                                    they give (CI's `crate-licences` check runs it)
 *   node tools/license/notices.mjs carried <file>... each file holds the committed notices whole: a text file that
 *                                                    is them, a binary with them inside (the app's executable),
 *                                                    or a zip archive with such a file in it (an .apk, an .ipa:
 *                                                    read here, nothing is unpacked to disk). The build matrix
 *                                                    runs it on what it has just built.
 * The app carries the file twice: inside its binary (src-tauri/src/notices.rs includes it, so the bare .exe and the
 * phones' packages have it), and as a file among its resources (src-tauri/tauri.conf.json), where a person can open
 * it. The file is committed, so its diff shows what a change of dependencies brought in, and src/licenceNotices.test.ts
 * holds it to the lockfile without cargo.
 * What goes in. Every crate of the lockfile, each from crates.io, with its declared licence and where it comes from;
 * every file in a crate's package, at any depth, whose name says licence, copying, copyright, notice, unlicense,
 * authors or patents, each distinct text once, under the crates that ship it; and, for a crate with no licence file
 * of its own at the top of its package, its declared licence with its authors and the licence's text: the MIT
 * License where it is offered (a choice among the licences a crate offers is the user's to make), else the text
 * another crate of the same licence ships (of the same repository first). A crate that offers a choice has every
 * text it ships reproduced, so no choice is forced. It is every crate of the lockfile, not one platform's: a file
 * that lists a crate the platform did not link is harmless, one that misses a crate is not.
 * A file below a package's top folder covers something the package carries inside it (a library in C, tables made
 * from someone's data), which may come under terms the crate's manifest does not declare, so none goes in unread:
 * each must fall under a rule of tools/license/policy.json (notices.nested) that says what it covers. A rule may say
 * the apps are not built with that part, and then its text stays out and the file says why; such a rule names the
 * features or the platform that make it so, and they are read from cargo's answer on every run.
 * Last, the Rust standard library, which every app links and no lockfile names: the Rust project's own statement of
 * its copyrights and licences, from the toolchain that builds the apps (share/doc/rust/COPYRIGHT-library.html),
 * reduced to plain text.
 * It is not a legal opinion: it reproduces what the crates ship. docs/ip-audit.md says what is left for counsel.
 * What breaks if it is removed? The apps go out without the notices their own dependencies' licences ask for.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { cargoMetadata, loadPolicy, parseSpdx } from './gate.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The workspace whose lockfile the apps are built from (native/llm comes in through it). */
export const WORKSPACE = 'src-tauri'
/** The committed file, which src-tauri/src/notices.rs includes and src-tauri/tauri.conf.json ships as a resource. */
export const NOTICES_FILE = 'src-tauri/notices/RUST-CRATES.txt'
/** The file's first line; the shell's own test (src-tauri/src/notices.rs) looks for it in the text it compiles in. */
export const TITLE = 'THIRD-PARTY NOTICES: THE RUST CRATES THIS APP IS BUILT WITH'
/**
 * A file of a crate's package that is reproduced, by its name without its folders: the name says what it is, and it
 * is not source code, a build script or a picture.
 */
export const NOTICE_FILE = /^(?!.*\.(?:rs|toml|json|lock|py|sh|ya?ml|js|ts|c|h|cc|cpp|hpp|cmake|in|go|java|kt|swift|m|mm|cs|rb|bat|ps1|css|xml|html|pdf|png|svg)$)(?:licen[sc]e|copying|copyright|notice|unlicense|authors|patents)(?:[-_.].*)?$/i
/** Of those, a file whose name says it is a licence's text, not a list of authors, a copyright line or a notice. */
export const LICENCE_TEXT = /^(?!.*\.spdx$)(?:licen[sc]e|copying|unlicense)/i
/** The one place a crate may come from: the addresses this file prints are crates.io's. */
export const CRATES_IO = 'registry+https://github.com/rust-lang/crates.io-index'
/** Where a Rust toolchain keeps its own statement of the standard library's copyrights, below its sysroot. */
export const STD_FILE = 'share/doc/rust/COPYRIGHT-library.html'
/** The licence taken for a crate that ships no text, in this order of preference among those it offers. */
export const PREFERENCE = Object.freeze(['MIT', 'MIT-0', '0BSD', 'ISC', 'Zlib', 'BSD-2-Clause', 'BSD-3-Clause', 'BSL-1.0', 'Unlicense', 'CC0-1.0', 'Unicode-3.0', 'Unicode-DFS-2016', 'Apache-2.0', 'MPL-2.0'])
const RULE = '-'.repeat(100)
const WIDTH = 100

/** A text as it is compared and printed: no byte-order mark, LF line ends, no trailing blanks, no blank lines around it. */
export function clean(text) {
  return String(text).replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '')
}

/** A text with every run of white space as one blank: how a licence's words are compared whatever its line breaks. */
export const words = (text) => String(text).replace(/\s+/g, ' ').trim()

const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const key = (c) => `${c.name} ${c.version}`
const base = (name) => name.slice(name.lastIndexOf('/') + 1)
const nestedName = (name) => name.includes('/')
/** A crate's own licence texts: files named for a licence at the top of its package, and the file its manifest names. */
const ownTexts = (c) => c.files.filter((f) => f.name === c.licenceFile || (!nestedName(f.name) && LICENCE_TEXT.test(f.name)))

/**
 * The crates of `cargo metadata`'s answer that come from the registry, each with what its manifest says, the features
 * and the platforms cargo resolved it for, and the notice files of its package at any depth (those at its top first).
 * `fs` reads the registry: `list(dir)` every plain file below a folder as a path with forward slashes, `read(path)` a
 * text. Throws for a crate that comes from anywhere but crates.io: every address this file prints is crates.io's.
 */
export function crateRecords(metadata, fs = DISK) {
  const nodes = new Map((metadata.resolve?.nodes ?? []).map((n) => [n.id, n]))
  const targets = new Map()
  for (const n of nodes.values()) {
    for (const d of n.deps ?? []) {
      if (!targets.has(d.pkg)) targets.set(d.pkg, new Set())
      for (const k of d.dep_kinds ?? []) targets.get(d.pkg).add(k.target ?? '*')
    }
  }
  const out = []
  for (const p of metadata.packages) {
    if (!p.source) continue
    if (p.source !== CRATES_IO) throw new Error(`${p.name} ${p.version} comes from ${p.source}, not from crates.io: where it is published and where its source is has to be decided before it is listed`)
    const dir = dirname(p.manifest_path)
    const names = fs.list(dir).filter((n) => NOTICE_FILE.test(base(n)))
    if (p.license_file && !names.includes(p.license_file)) names.push(p.license_file)
    names.sort((a, b) => order(nestedName(a) ? 1 : 0, nestedName(b) ? 1 : 0) || order(a.toLowerCase(), b.toLowerCase()) || order(a, b))
    const files = names.map((name) => ({ name, text: clean(fs.read(join(dir, name))) })).filter((f) => f.text !== '')
    out.push({
      name: p.name, version: p.version, licence: p.license ?? null, licenceFile: p.license_file ?? null, authors: p.authors ?? [], repository: p.repository ?? p.homepage ?? null,
      features: [...(nodes.get(p.id)?.features ?? [])].sort(), targets: [...(targets.get(p.id) ?? [])].sort(), files,
    })
  }
  return out.sort((a, b) => order(a.name, b.name) || order(a.version, b.version))
}

const DISK = {
  list: (dir) => {
    const walk = (rel) => readdirSync(join(dir, rel), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(`${rel}${e.name}/`) : e.isFile() ? [`${rel}${e.name}`] : []))
    return walk('')
  },
  // A file that is not UTF-8 would come out with its author's name damaged, and --check would agree with the damage.
  read: (path) => {
    const bytes = readFileSync(path)
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { throw new Error(`${path} is not UTF-8: how it is read has to be decided before it is reproduced`) }
  },
}

/** What a rule's conditions for "the apps are not built with this" find untrue of a crate as cargo resolved it. */
function unmet(c, needs = {}) {
  const out = []
  for (const f of needs.features ?? []) if (!c.features.includes(f)) out.push(`its feature ${f} is off`)
  for (const f of needs.lacks ?? []) if (c.features.includes(f)) out.push(`its feature ${f} is on`)
  if (needs.target && (c.targets.length !== 1 || c.targets[0] !== needs.target)) out.push(`it is taken for ${c.targets.length ? c.targets.join(' and ') : 'no platform cargo names'}, not for ${needs.target} alone`)
  return out
}

/**
 * The crates with every file below a package's top folder accounted for by a rule (tools/license/policy.json
 * notices.nested: `{ crate, under, covers, built?, why?, needs? }`, `under` a file or a folder of the package).
 * Each crate comes back with `files` holding what is reproduced and `nested` saying, rule by rule, which files it
 * covers, what they cover, and whether their text is reproduced. A rule with `built: false` keeps its files' texts
 * out, and must say why and name what makes it so (`needs`: `features` that are on, features the crate `lacks`, the
 * one `target` it is taken for); those are checked against cargo's answer here, so the claim cannot go stale.
 * Throws, naming everything at once, for a nested file no rule covers, a rule that covers nothing, a rule that is
 * not whole, and a condition that no longer holds.
 */
export function account(crates, rules = []) {
  const problems = []
  const used = new Set()
  for (const r of rules) {
    const what = `the rule for ${r.crate} ${r.under}`
    if (!r.crate || !r.under || !r.covers) problems.push(`${what} must name a crate, a file or folder under it, and what that covers`)
    if (r.built === false && (!r.why || Object.keys(r.needs ?? {}).length === 0)) problems.push(`${what} says the apps are not built with it, so it must say why and name what makes it so (needs)`)
  }
  const covers = (r, name) => name === r.under || name.startsWith(r.under.endsWith('/') ? r.under : `${r.under}/`)
  const out = crates.map((c) => {
    const files = []
    const groups = new Map()
    for (const f of c.files) {
      if (!nestedName(f.name) || f.name === c.licenceFile) { files.push(f); continue }
      const rule = rules.find((r) => r.crate === c.name && covers(r, f.name))
      if (!rule) { problems.push(`${key(c)} ships ${f.name}, which no rule of tools/license/policy.json (notices.nested) accounts for: read it, then record what it covers and whether the apps are built with it`); continue }
      used.add(rule)
      if (!groups.has(rule)) groups.set(rule, [])
      groups.get(rule).push(f.name)
      if (rule.built !== false) files.push(f)
    }
    const nested = [...groups].map(([rule, names]) => {
      if (rule.built === false) for (const no of unmet(c, rule.needs)) problems.push(`${key(c)}: the rule for ${rule.under} says the apps are not built with it, but ${no}`)
      return { names, covers: rule.covers, built: rule.built !== false, why: rule.why ?? null }
    })
    return { ...c, files, nested }
  })
  for (const r of rules) if (!used.has(r)) problems.push(`the rule for ${r.crate} ${r.under} covers no file of the lockfile's crates: take it out of tools/license/policy.json`)
  if (problems.length) throw new Error(problems.join('\n'))
  return out
}

/**
 * The licences taken for a crate that ships no text: of the sets its expression allows (one side of an OR, every
 * side of an AND), the one whose least preferred member is most preferred. An exception (`WITH`) stays with its id.
 * Throws for an expression with a licence PREFERENCE does not rank, so a new kind is a decision, not a default.
 */
export function taken(expression) {
  const rank = (id) => PREFERENCE.indexOf(id.split(' WITH ')[0])
  const sets = (n) => {
    if (n.id) return [[n.with ? `${n.id} WITH ${n.with}` : n.id]]
    const parts = (n.and ?? n.or).map(sets)
    if (n.or) return parts.flat()
    return parts.reduce((all, alts) => all.flatMap((a) => alts.map((b) => [...a, ...b])), [[]])
  }
  const known = sets(parseSpdx(expression)).filter((set) => set.every((id) => rank(id) >= 0))
  if (known.length === 0) throw new Error(`${expression}: no licence it offers has a place in the order of preference`)
  const worst = (set) => Math.max(...set.map(rank))
  return known.reduce((a, b) => (worst(b) < worst(a) ? b : a))
}

/** Lines of at most WIDTH columns: `lead`, then the pieces with one blank between, each later line indented. */
function fold(lead, pieces, indent = '') {
  const lines = []
  let line = lead
  for (const piece of pieces) {
    if (line.trim() === '') line = `${line}${piece}`
    else if (line.length + 1 + piece.length > WIDTH) { lines.push(line); line = `${indent}${piece}` }
    else line = `${line} ${piece}`
  }
  lines.push(line)
  return lines
}
/** A paragraph of prose, folded. */
const para = (text) => fold('', text.split(' '))
/** A list of names after a lead, comma between, folded with later lines indented. */
const list = (lead, items, indent = '  ') => fold(lead, items.map((item, i) => (i < items.length - 1 ? `${item},` : item)), indent)

const page = (c) => `https://crates.io/crates/${c.name}/${c.version}`
const mpl = (c) => /\bMPL-/.test(c.licence ?? '')

/**
 * The file's text, from the crates' records (crateRecords, then account) and the body of the MIT License (`mit`:
 * its words from "Permission is hereby granted" on, with no copyright line). `std`, when given, is the standard
 * library's own statement as plain text with the rustc it came with (`{ version, text }`), and becomes the last
 * section. `combined` names crates under several licences at once whose one file holds all of them. Pure, and the
 * same text for the same records.
 * Throws when a crate has no declared licence; when it ships no licence text of its own and none can be given for
 * the licence taken; and when it is under several licences at once and ships fewer licence files than licences, so
 * a text that may be missing is looked at by a person and not passed over.
 */
export function notices(crates, { mit, std = null, combined = [] }) {
  const out = []
  const say = (...lines) => out.push(...lines)
  for (const c of crates) if (!c.licence) throw new Error(`${key(c)} declares no licence: it cannot be listed`)
  for (const c of crates) if (!c.nested && c.files.some((f) => nestedName(f.name) && f.name !== c.licenceFile)) throw new Error(`${key(c)} ships files from inside its package that no rule has accounted for: pass the crates through account() first`)
  // A crate ships its own licence text when a file at the top of its package is named for one. A list of authors, a
  // copyright file or a file from inside the package (it covers what the package carries, not the crate) is not one.
  const bare = crates.filter((c) => ownTexts(c).length === 0)
  for (const c of crates) {
    const own = ownTexts(c).length
    if (own === 0 || combined.includes(c.name)) continue
    const least = taken(c.licence).length
    if (own < least) throw new Error(`${key(c)} is under ${c.licence}, ${least} licences at once, and ships ${own} licence file: if that one file holds every text, name the crate in tools/license/policy.json (notices.combined); if not, a text is missing`)
  }

  // Each distinct text once, under every crate and file name that ships it, in the order the first of them comes.
  const texts = new Map()
  for (const c of crates) {
    for (const f of c.files) {
      if (!texts.has(f.text)) texts.set(f.text, new Map())
      const by = texts.get(f.text)
      if (!by.has(f.name)) by.set(f.name, [])
      by.get(f.name).push(key(c))
    }
  }

  // For a crate with no text of its own: the licences taken, and for each but MIT the crate whose text stands in.
  const donors = (c, id) => crates
    .filter((d) => ownTexts(d).length > 0 && d.licence === id)
    .sort((a, b) => order(a.repository === c.repository ? 0 : 1, b.repository === c.repository ? 0 : 1) || order(key(a), key(b)))
  const stand = bare.map((c) => {
    const ids = taken(c.licence)
    const from = ids.filter((id) => id !== 'MIT').map((id) => {
      const donor = donors(c, id)[0]
      if (!donor) throw new Error(`${key(c)} ships no licence text and is taken under ${id}, and no crate whose only licence is ${id} ships one to stand in`)
      return { id, donor }
    })
    return { c, ids, from }
  })
  const inside = crates.filter((c) => (c.nested ?? []).length > 0)

  say(TITLE, '')
  say(...para(`Crimson Noir Agent City's apps for Windows, Linux, macOS, Android and iOS are built with the open-source Rust crates listed here: ${crates.length} crates, each used as its authors published it, under the licence they give it. Not every crate is in every platform's app. This file reproduces the licence, copyright and notice files those crates ship in their own packages, at the top of a package and inside it. Where a crate offers a choice of licences, every text it ships is here, so the choice stays the reader's. A text is left out only where it covers a part of a package that no app is built with, and section 5 names each such file and says why. It is written by tools/license/notices.mjs from src-tauri/Cargo.lock and the crates' packages, not by hand.`))
  say('', ...para(`These notices are about the crates${std ? ' and the Rust standard library' : ''} alone. The app itself is proprietary; the page inside it carries its own notices for what it is built with, and the model an app carries has its licence and notice beside it.`), '')

  say(RULE, `1. THE CRATES (${crates.length})`, RULE, '', 'name version | licence its manifest declares | where it is published', '')
  for (const c of crates) say(`${key(c)} | ${c.licence} | ${page(c)}`)

  const copyleft = crates.filter(mpl)
  say('', RULE, '2. SOURCE CODE OF THE CRATES UNDER THE MOZILLA PUBLIC LICENSE 2.0', RULE, '')
  if (copyleft.length === 0) say('None of the crates is under the Mozilla Public License.')
  else {
    say(...para('These crates are under the Mozilla Public License 2.0, whose text is among those below. They are compiled into the app unchanged. The source code of each, exactly as used, is the package its authors published, which anyone can download free of charge:'), '')
    for (const c of copyleft) {
      say(`${key(c)}`, `  package: https://crates.io/api/v1/crates/${c.name}/${c.version}/download`, `  page:    ${page(c)}`)
      if (c.repository) say(`  project: ${c.repository}`)
    }
  }

  say('', RULE, `3. THE TEXTS THE CRATES SHIP (${texts.size} distinct)`, RULE)
  let n = 0
  for (const [text, by] of texts) {
    n += 1
    say('', RULE, `Text ${n} of ${texts.size}`)
    for (const [name, users] of by) say(...list(`${name} of`, users))
    say(RULE, '', text)
  }

  say('', RULE, `4. CRATES WITH NO LICENCE TEXT OF THEIR OWN (${bare.length})`, RULE, '')
  if (bare.length === 0) say('Every crate ships a text.')
  else {
    say(...para('The packages of these crates have no file named for a licence at their top, so each is listed with the licence its manifest declares, the licence taken here where it offers a choice, its authors as its manifest names them, and where its text is: the MIT License follows this list, and any other is the text another crate ships above. What such a package does ship (a list of authors, a copyright file, the notices of something it carries inside) is among the texts above.'), '')
    for (const { c, ids, from } of stand) {
      say(`${key(c)}`, `  declared: ${c.licence}`, `  taken:    ${ids.join(' AND ')}`)
      say(...list('  authors: ', c.authors.length ? c.authors : [`the authors of ${c.name}`], '            '))
      if (c.repository) say(`  project:  ${c.repository}`)
      if (ids.includes('MIT')) say(`  notice:   Copyright (c) ${c.authors.length ? c.authors.join(', ') : `the authors of ${c.name}`}`)
      for (const { id, donor } of from) {
        const names = ownTexts(donor).map((f) => f.name).join(', ')
        say(`  text:     ${id}, as ${key(donor)} ships it above (${names})`)
      }
      say('')
    }
    if (stand.some((s) => s.ids.includes('MIT'))) say(RULE, 'The MIT License, for each crate above taken under it, with the copyright notice given beside the crate', RULE, '', clean(mit))
  }

  const files = inside.reduce((sum, c) => sum + c.nested.reduce((m, g) => m + g.names.length, 0), 0)
  say('', RULE, `5. FILES FROM INSIDE A PACKAGE (${files})`, RULE, '')
  if (inside.length === 0) say('No crate ships a licence, copyright or notice file below the top of its package.')
  else {
    say(...para('A file below the top of a package covers something the package carries inside it, such as a library written in another language or tables made from someone else\'s data, and not the crate as a whole. Each is listed here with what it covers. Its text is among those above unless no app is built with the part it covers; then the text is left out, and the reason is given. Every such reason rests on how cargo resolved the crate (its features, the platform it is taken for), which is read again each time this file is written.'), '')
    for (const c of inside) {
      say(key(c))
      for (const g of c.nested) {
        for (const name of g.names) say(`  ${name}`)
        say(...fold('    covers:', g.covers.split(' '), '            '))
        if (g.built) say('    text:   reproduced above')
        else say(...fold('    text:   not reproduced, because no app is built with it.', g.why.split(' '), '            '))
      }
      say('')
    }
  }

  if (std) {
    say(RULE, `6. THE RUST STANDARD LIBRARY (rustc ${std.version})`, RULE, '')
    say(...para(`Every app is also built with the Rust standard library and the crates that library is itself built from. They come with the Rust toolchain, not from the lockfile, so no line above names them. What follows is the Rust project's own statement of their copyrights and licences for rustc ${std.version}, the toolchain the apps are built with, reduced to plain text from the file the toolchain ships (${STD_FILE}). It names packages for every platform the library supports, which is more than any one app holds.`), '')
    say(std.text)
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
}

const MARK = '\uE000'
const PLACE = new RegExp(`^\\s*${MARK}(\\d+)${MARK}\\s*$`)
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' }
/** A text with its HTML character references read: numbered ones and the few named ones above; another name throws. */
function unescape(text) {
  return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (all, ref) => {
    if (ref[0] === '#') return String.fromCodePoint(/^#x/i.test(ref) ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10))
    const named = ENTITIES[ref.toLowerCase()]
    if (named === undefined) throw new Error(`the standard library's notices use the character reference ${all}, which this does not read`)
    return named
  })
}

/**
 * The toolchain's statement of the standard library's copyrights (COPYRIGHT-library.html) as plain text: headings
 * on lines of their own, each paragraph folded, each licence text (`<pre>`) as it stands, links written out. Nothing
 * of its wording is changed or left out but the table of contents. Throws when the file does not read as that
 * statement, so another file in its place is never printed as the library's notices.
 */
export function stdText(html) {
  const src = String(html).replace(/\r\n?/g, '\n')
  // Each licence text is set aside under a mark while the prose around it is folded: a private-use character, which
  // the page must not hold itself.
  if (src.includes(MARK)) throw new Error(`${STD_FILE} holds the character this tool marks a licence text's place with`)
  const body = /<body[^>]*>([^]*)<\/body>/i.exec(src)?.[1] ?? src
  const pres = []
  const text = body
    .replace(/<pre[^>]*>([^]*?)<\/pre>/gi, (all, inner) => { pres.push(clean(unescape(inner))); return `\n\n${MARK}${pres.length - 1}${MARK}\n\n` })
    .replace(/<h2[^>]*>\s*Table of Contents\s*<\/h2>\s*<ul[^>]*>[^]*?<\/ul>/i, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([^]*?)<\/a>/gi, (all, href, label) => (href.startsWith('#') || label.trim() === href ? label : `${label} (${href})`))
    .replace(/<h[12][^>]*>([^]*?)<\/h[12]>/gi, (all, t) => `\n\n${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().toUpperCase()}\n\n`)
    .replace(/<h3[^>]*>([^]*?)<\/h3>/gi, (all, t) => `\n\n${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().replace(/^[^A-Za-z0-9]+/, '')}\n\n`)
    .replace(/<summary[^>]*>([^]*?)<\/summary>/gi, (all, t) => `\n\n${t.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()}:\n\n`)
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/?(?:p|div|details|ul|li|br)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
  const lines = []
  for (const block of unescape(text).split(/\n{2,}/)) {
    const at = PLACE.exec(block)
    const piece = at ? pres[Number(at[1])] : para(block.replace(/\s+/g, ' ').trim()).join('\n')
    if (piece !== '') lines.push(piece, '')
  }
  const out = clean(lines.join('\n'))
  if (pres.length < 10 || !/Rust Standard Library/i.test(out) || !/Apache License/.test(out) || out.includes(MARK)) throw new Error(`${STD_FILE} does not read as the Rust standard library's copyright notices (${pres.length} licence texts in it)`)
  return out
}

/** The rustc this machine builds with and its statement of the standard library's copyrights, as plain text. */
export function stdNotices(run = spawnSync, fs = DISK) {
  const ask = (args) => {
    const r = run('rustc', args, { encoding: 'utf8' })
    if (r.error || r.status !== 0) throw new Error(`rustc ${args.join(' ')} failed: ${r.error?.message ?? String(r.stderr).trim()}`)
    return String(r.stdout).trim()
  }
  const version = /^rustc (\S+)/.exec(ask(['--version']))?.[1]
  if (!version) throw new Error('rustc --version did not name a version')
  const path = join(ask(['--print', 'sysroot']), STD_FILE)
  let html
  try { html = fs.read(path) } catch (e) { throw new Error(`the Rust toolchain's ${STD_FILE} could not be read (${e.code ?? e.message}): rustc ${version} should ship it with its rustc component`) }
  return { version, text: stdText(html) }
}

/** The body of the MIT License from the repository's own copy: its words from "Permission is hereby granted" on. */
export function mitBody(text = readFileSync(join(ROOT, 'LICENSES', 'MIT.txt'), 'utf8')) {
  const at = text.indexOf('Permission is hereby granted')
  if (at < 0) throw new Error('LICENSES/MIT.txt does not hold the MIT License')
  return clean(text.slice(at))
}

/**
 * What is wrong with the MIT body before it is printed for other people's crates: it must be, word for word, the
 * text that crates themselves ship. At least `least` of the crates' own texts must contain it.
 */
export function mitProblems(crates, mit, least = 10) {
  const body = words(mit)
  const seen = new Set()
  for (const c of crates) for (const f of c.files) if (words(f.text).includes(body)) seen.add(key(c))
  return seen.size >= least ? [] : [`the MIT License as LICENSES/MIT.txt has it is word for word in the texts of ${seen.size} crates; at least ${least} were expected, so it is not printed for crates that ship no text`]
}

/** Where two texts first differ, as one line for a person: the line's number and both lines. */
export function firstDifference(a, b) {
  const x = a.split('\n')
  const y = b.split('\n')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `line ${i + 1}: the committed file has ${JSON.stringify(x[i] ?? '(nothing)')}, a fresh one has ${JSON.stringify(y[i] ?? '(nothing)')}`
  }
  return null
}

/**
 * The entries of a zip archive (an .apk, an .ipa), read from its central directory: each with its name, its method
 * (0 stored, 8 deflated), its sizes and where its local header starts. Null for bytes that are not a zip this reads:
 * no end record, or one that points past 4 GiB (zip64), which neither package is.
 */
export function zipEntries(bytes) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) return null
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break }
  }
  if (end < 0) return null
  const count = bytes.readUInt16LE(end + 10)
  let at = bytes.readUInt32LE(end + 16)
  if (count === 0xffff || at === 0xffffffff) return null
  const out = []
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50) return null
    const nameLen = bytes.readUInt16LE(at + 28)
    out.push({
      name: bytes.toString('utf8', at + 46, at + 46 + nameLen),
      method: bytes.readUInt16LE(at + 10),
      packed: bytes.readUInt32LE(at + 20),
      size: bytes.readUInt32LE(at + 24),
      header: bytes.readUInt32LE(at + 42),
    })
    at += 46 + nameLen + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32)
  }
  return out
}

/** One zip entry's bytes, inflated when it is deflated; null for a method this does not read or a damaged entry. */
export function zipRead(bytes, entry) {
  const at = entry.header
  if (at + 30 > bytes.length || bytes.readUInt32LE(at) !== 0x04034b50) return null
  const start = at + 30 + bytes.readUInt16LE(at + 26) + bytes.readUInt16LE(at + 28)
  const packed = bytes.subarray(start, start + entry.packed)
  if (entry.method === 0) return packed
  if (entry.method !== 8) return null
  try { return inflateRawSync(packed, { maxOutputLength: Math.max(entry.size, 1) }) } catch { return null }
}

/**
 * Where `bytes` hold `text` whole: the names of the entries that hold it for a zip archive (an .apk's library, an
 * .ipa's program and its resource), stored or deflated; `['']` for any other file that holds it itself (a text file
 * that is it, a binary with it inside); and none when it is nowhere. Entries smaller than the text are not opened.
 */
export function carries(bytes, text) {
  const needle = Buffer.from(text, 'utf8')
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  const named = (zipEntries(buf) ?? []).filter((e) => e.size >= needle.length && zipRead(buf, e)?.includes(needle)).map((e) => e.name)
  if (named.length > 0) return named
  return buf.includes(needle) ? [''] : []
}

const USAGE = 'usage: node tools/license/notices.mjs --write            write the notices from the registry (needs cargo)\n       node tools/license/notices.mjs --check            the committed notices against the registry (needs cargo)\n       node tools/license/notices.mjs carried <file>...  each file holds the committed notices whole'

/** The command line. Returns the exit code: 0, 1 when something is wrong, 2 when cargo could not answer. */
export function main(argv, { run = spawnSync, log = console.log, fs = DISK, root = ROOT, policy = null } = {}) {
  const [cmd, ...rest] = argv
  const path = join(root, NOTICES_FILE)
  if ((cmd === '--write' || cmd === '--check') && rest.length === 0) {
    let fresh
    try {
      // The policy is read only here: `carried` runs on the build machines and needs the committed file alone.
      const rules = policy ?? loadPolicy().notices ?? {}
      const crates = account(crateRecords(cargoMetadata(WORKSPACE, run), fs), rules.nested ?? [])
      const mit = mitBody()
      const problems = mitProblems(crates, mit)
      if (problems.length) { for (const p of problems) log(`crate-notices: ${p}`); return 1 }
      const std = stdNotices(run, fs)
      fresh = { text: notices(crates, { mit, std, combined: rules.combined ?? [] }), crates: crates.length, rustc: std.version }
    } catch (e) { for (const line of e.message.split('\n')) log(`crate-notices: ${line}`); return /cargo metadata/.test(e.message) ? 2 : 1 }
    if (cmd === '--write') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, fresh.text)
      log(`crate-notices: ${fresh.crates} crates and the standard library of rustc ${fresh.rustc}, ${Buffer.byteLength(fresh.text)} bytes written to ${NOTICES_FILE}`)
      return 0
    }
    let committed
    try { committed = readFileSync(path, 'utf8') } catch { log(`crate-notices: ${NOTICES_FILE} is missing: node tools/license/notices.mjs --write`); return 1 }
    // The standard library's notices are those of one rustc: with another, every line of them may differ, and the
    // answer is not to write the file again but to check it with the toolchain the apps are built with.
    const held = /^6\. THE RUST STANDARD LIBRARY \(rustc (\S+)\)$/m.exec(committed)?.[1]
    if (held && held !== fresh.rustc) { log(`crate-notices: ${NOTICES_FILE} holds the standard library's notices of rustc ${held}, and this machine's rustc is ${fresh.rustc}: check it with the toolchain the apps are built with (RUST_TOOLCHAIN in the workflows), and write it again only when they are built with ${fresh.rustc}`); return 1 }
    const differs = firstDifference(committed, fresh.text)
    if (differs) { log(`crate-notices: ${NOTICES_FILE} is not what the registry and the toolchain give (${differs}): node tools/license/notices.mjs --write, and read the diff`); return 1 }
    log(`crate-notices: ${fresh.crates} crates and the standard library of rustc ${fresh.rustc}, ${Buffer.byteLength(fresh.text)} bytes, as the registry and the toolchain give them`)
    return 0
  }
  if (cmd === 'carried' && rest.length > 0) {
    const text = readFileSync(path, 'utf8')
    let wrong = 0
    for (const file of rest) {
      let bytes
      try { bytes = readFileSync(file) } catch (e) { log(`crate-notices: ${file} could not be read (${e.code ?? e.message})`); wrong += 1; continue }
      const where = carries(bytes, text)
      if (where.length === 0) { log(`crate-notices: ${file} does not hold ${NOTICES_FILE} whole`); wrong += 1 }
      else log(`crate-notices: ${file} holds the ${Buffer.byteLength(text)} bytes of ${NOTICES_FILE}${where[0] === '' ? '' : ` (inside ${where.join(', ')})`}`)
    }
    return wrong ? 1 : 0
  }
  log(USAGE)
  return cmd === '--help' ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
