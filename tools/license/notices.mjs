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
 *   node tools/license/notices.mjs --write           write the file from the registry (needs cargo)
 *   node tools/license/notices.mjs --check           write nothing; fail when the committed file differs from what
 *                                                    the registry gives (CI's `crate-licences` check runs it)
 *   node tools/license/notices.mjs carried <file>... each file holds the committed notices whole: a text file that
 *                                                    is them, a binary with them inside (the app's executable),
 *                                                    or a zip archive with such a file in it (an .apk, an .ipa:
 *                                                    read here, nothing is unpacked to disk). The build matrix
 *                                                    runs it on what it has just built.
 * The app carries the file twice: inside its binary (src-tauri/src/notices.rs includes it, so the bare .exe and the
 * phones' packages have it), and as a file among its resources (src-tauri/tauri.conf.json), where a person can open
 * it. The file is committed, so its diff shows what a change of dependencies brought in, and src/licenceNotices.test.ts
 * holds it to the lockfile without cargo.
 * What goes in. Every crate of the lockfile from the registry, each with its declared licence and where it comes
 * from; every file in a crate's package whose name says licence, copying, copyright, notice, unlicense, authors or
 * patents, each distinct text once, under the crates that ship it; and, for a crate whose package ships no such file,
 * its declared licence with its authors and the licence's text: the MIT License where it is offered (a choice among
 * the licences a crate offers is the user's to make), else the text another crate of the same licence ships (of the
 * same repository first). A crate that offers a choice has every text it ships reproduced, so no choice is forced.
 * It is every crate of the lockfile, not one platform's: a file that lists a crate the platform did not link is
 * harmless, one that misses a crate is not.
 * It is not a legal opinion: it reproduces what the crates ship. docs/ip-audit.md says what is left for counsel.
 * What breaks if it is removed? The apps go out without the notices their own dependencies' licences ask for.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'
import { cargoMetadata, parseSpdx } from './gate.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The workspace whose lockfile the apps are built from (native/llm comes in through it). */
export const WORKSPACE = 'src-tauri'
/** The committed file, which src-tauri/src/notices.rs includes and src-tauri/tauri.conf.json ships as a resource. */
export const NOTICES_FILE = 'src-tauri/notices/RUST-CRATES.txt'
/** The file's first line; the audits of the built packages look for it. */
export const TITLE = 'THIRD-PARTY NOTICES: THE RUST CRATES THIS APP IS BUILT WITH'
/** A file of a crate's package that is reproduced: its name says what it is, and it is not source code or a picture. */
export const NOTICE_FILE = /^(?!.*\.(?:rs|toml|json|lock|py|sh|ya?ml|js|ts|c|h|cpp|html|pdf|png|svg)$)(?:licen[sc]e|copying|copyright|notice|unlicense|authors|patents)(?:[-_.].*)?$/i
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

/**
 * The crates of `cargo metadata`'s answer that come from a registry, each with what its manifest says and the
 * notice files of its package. `fs` reads the registry: `list(dir)` the plain files' names, `read(path)` a text.
 */
export function crateRecords(metadata, fs = DISK) {
  const out = []
  for (const p of metadata.packages) {
    if (!p.source) continue
    const dir = dirname(p.manifest_path)
    const names = fs.list(dir).filter((n) => NOTICE_FILE.test(n))
    if (p.license_file && !names.includes(p.license_file)) names.push(p.license_file)
    names.sort((a, b) => order(a.toLowerCase(), b.toLowerCase()) || order(a, b))
    const files = names.map((name) => ({ name, text: clean(fs.read(join(dir, name))) })).filter((f) => f.text !== '')
    out.push({ name: p.name, version: p.version, licence: p.license ?? null, authors: p.authors ?? [], repository: p.repository ?? p.homepage ?? null, files })
  }
  return out.sort((a, b) => order(a.name, b.name) || order(a.version, b.version))
}

const DISK = {
  list: (dir) => readdirSync(dir).filter((n) => statSync(join(dir, n)).isFile()),
  read: (path) => readFileSync(path, 'utf8'),
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
 * The file's text, from the crates' records (crateRecords) and the body of the MIT License (`mit`: its words from
 * "Permission is hereby granted" on, with no copyright line). Pure, and the same text for the same records.
 * Throws when a crate has no declared licence, or ships no text and none can be given for the licence taken.
 */
export function notices(crates, { mit }) {
  const out = []
  const say = (...lines) => out.push(...lines)
  const bare = crates.filter((c) => c.files.length === 0)
  for (const c of crates) if (!c.licence) throw new Error(`${key(c)} declares no licence: it cannot be listed`)

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

  // For a crate with no text: the licences taken, and for each but MIT the crate whose text stands in.
  const donors = (c, id) => crates
    .filter((d) => d.files.length > 0 && d.licence === id)
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

  say(TITLE, '')
  say(...para(`Crimson Noir Agent City's apps for Windows, Linux, macOS, Android and iOS are built with the open-source Rust crates listed here: ${crates.length} crates, each used as its authors published it, under the licence they give it. Not every crate is in every platform's app. This file reproduces the licence, copyright and notice files those crates ship in their own packages. Where a crate offers a choice of licences, every text it ships is here, so the choice stays the reader's. It is written by tools/license/notices.mjs from src-tauri/Cargo.lock and the crates' packages, not by hand.`))
  say('', ...para('These notices are about the crates alone. The app itself is proprietary; the page inside it carries its own notices for what it is built with, and the model an app carries has its licence and notice beside it.'), '')

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

  say('', RULE, `4. CRATES WHOSE PACKAGES SHIP NO LICENCE TEXT (${bare.length})`, RULE, '')
  if (bare.length === 0) say('Every crate ships a text.')
  else {
    say(...para('The packages of these crates carry no licence file, so each is listed with the licence its manifest declares, the licence taken here where it offers a choice, its authors as its manifest names them, and where its text is: the MIT License follows this list, and any other is the text another crate ships above.'), '')
    for (const { c, ids, from } of stand) {
      say(`${key(c)}`, `  declared: ${c.licence}`, `  taken:    ${ids.join(' AND ')}`)
      say(...list('  authors: ', c.authors.length ? c.authors : [`the authors of ${c.name}`], '            '))
      if (c.repository) say(`  project:  ${c.repository}`)
      if (ids.includes('MIT')) say(`  notice:   Copyright (c) ${c.authors.length ? c.authors.join(', ') : `the authors of ${c.name}`}`)
      for (const { id, donor } of from) {
        const names = donor.files.map((f) => f.name).join(', ')
        say(`  text:     ${id}, as ${key(donor)} ships it above (${names})`)
      }
      say('')
    }
    if (stand.some((s) => s.ids.includes('MIT'))) say(RULE, 'The MIT License, for each crate above taken under it, with the copyright notice given beside the crate', RULE, '', clean(mit))
  }
  return `${out.join('\n').replace(/\n+$/, '')}\n`
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
    if (x[i] !== y[i]) return `line ${i + 1}: the committed file has ${JSON.stringify(x[i] ?? '(nothing)')}, the registry gives ${JSON.stringify(y[i] ?? '(nothing)')}`
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
 * Where `bytes` hold `text` whole: `['']` for a file that holds it itself (a text file that is it, a binary with it
 * inside), the names of the entries that hold it for a zip archive (an .apk's library, an .ipa's program), and none
 * when it is nowhere. Entries smaller than the text are not opened.
 */
export function carries(bytes, text) {
  const needle = Buffer.from(text, 'utf8')
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (buf.includes(needle)) return ['']
  const entries = zipEntries(buf)
  if (!entries) return []
  return entries.filter((e) => e.size >= needle.length && zipRead(buf, e)?.includes(needle)).map((e) => e.name)
}

const USAGE = 'usage: node tools/license/notices.mjs --write            write the notices from the registry (needs cargo)\n       node tools/license/notices.mjs --check            the committed notices against the registry (needs cargo)\n       node tools/license/notices.mjs carried <file>...  each file holds the committed notices whole'

/** The command line. Returns the exit code: 0, 1 when something is wrong, 2 when cargo could not answer. */
export function main(argv, { run = spawnSync, log = console.log, fs = DISK, root = ROOT } = {}) {
  const [cmd, ...rest] = argv
  const path = join(root, NOTICES_FILE)
  if ((cmd === '--write' || cmd === '--check') && rest.length === 0) {
    let fresh
    try {
      const crates = crateRecords(cargoMetadata(WORKSPACE, run), fs)
      const mit = mitBody()
      const problems = mitProblems(crates, mit)
      if (problems.length) { for (const p of problems) log(`crate-notices: ${p}`); return 1 }
      fresh = { text: notices(crates, { mit }), crates: crates.length }
    } catch (e) { log(`crate-notices: ${e.message}`); return /cargo metadata/.test(e.message) ? 2 : 1 }
    if (cmd === '--write') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, fresh.text)
      log(`crate-notices: ${fresh.crates} crates, ${Buffer.byteLength(fresh.text)} bytes written to ${NOTICES_FILE}`)
      return 0
    }
    let committed
    try { committed = readFileSync(path, 'utf8') } catch { log(`crate-notices: ${NOTICES_FILE} is missing: node tools/license/notices.mjs --write`); return 1 }
    const differs = firstDifference(committed, fresh.text)
    if (differs) { log(`crate-notices: ${NOTICES_FILE} is not what the registry gives (${differs}): node tools/license/notices.mjs --write, and read the diff`); return 1 }
    log(`crate-notices: ${fresh.crates} crates, ${Buffer.byteLength(fresh.text)} bytes, as the registry gives them`)
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
