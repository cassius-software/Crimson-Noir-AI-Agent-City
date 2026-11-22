#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? The product is meant to be sold, so every change has to keep three things true, and a
 * person reading a diff cannot hold all of them: nothing compiled into a build comes under a licence that forbids
 * selling it closed, no other owner's name is used as the product's own, and every picture and bundled model has a
 * known origin. This is the check of those three, over what tools/license/policy.json states:
 *   - crates: every crate in the six Cargo.lock files is in the committed inventory (tools/license/crates.json) at
 *     that version, and its licence there is one the policy allows (an SPDX expression is read properly: of
 *     `A OR B` one side is enough, of `A AND B` both are needed). The inventory is not typed by hand: `crates
 *     --write` reads each licence from the crate's own manifest in the registry, and `crates --check` (CI's
 *     `crate-licences` check, where cargo and the registry are at hand) reads them again and fails on a difference,
 *     so the committed list cannot say something the registry does not;
 *   - names: no listed third-party mark in the repository's text (src/compliance.test.ts holds the page's older,
 *     narrower list; this one reads the manuals, the OS, the tools and the workflows as well);
 *   - assets: every picture, icon and packed data file is listed with where it came from, and every directory under
 *     third_party/ with its licence and the texts it must carry. An unlisted file fails; a listed one whose origin
 *     the owner has not recorded yet is reported, every run, until it is.
 * `node tools/license/gate.mjs` runs the three from the files alone (src/licenceGate.test.ts runs them in `npm
 * test`); `node tools/license/gate.mjs crates --check|--write` asks cargo. It reads and reports; only `--write`
 * writes, and only the inventory.
 * It is a check of what can be checked by a machine, not a legal opinion: it cannot say that a name is free to use,
 * that a licence reads the way the policy assumes for this product, or that a picture is the owner's to sell.
 * docs/ip-audit.md says what was looked at by hand and what is left for counsel.
 * What breaks if it is removed? A new dependency under a licence nobody read, a pasted brand name or a picture of
 * unknown origin reaches main, and the first to notice is whoever objects to it.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readHeld } from '../test/held.mjs'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const HERE = 'tools/license'
export const POLICY_FILE = `${HERE}/policy.json`
export const INVENTORY_FILE = `${HERE}/crates.json`

const json = (path) => JSON.parse(readFileSync(join(ROOT, path), 'utf8'))
export const loadPolicy = () => json(POLICY_FILE)
export const loadInventory = () => json(INVENTORY_FILE)

// ---------------------------------------------------------------------------------------------------------------
// Licence expressions

/**
 * An SPDX licence expression as a tree: `{ id, with? }`, `{ and: [...] }` or `{ or: [...] }`. WITH binds tightest,
 * then AND, then OR; the operators are read in any case, and the `/` older manifests write (`MIT/Apache-2.0`) is OR.
 * Anything else that is not an expression throws, so a licence the gate cannot read is never taken as allowed.
 */
export function parseSpdx(text) {
  const src = String(text ?? '')
  const tokens = src.replace(/\//g, ' OR ').match(/\(|\)|[A-Za-z0-9.+:-]+|\S/g) ?? []
  const word = (t) => typeof t === 'string' && /^[A-Za-z0-9.+:-]+$/.test(t)
  const op = (t, name) => word(t) && t.toUpperCase() === name
  let i = 0
  const fail = (what) => { throw new Error(`not a licence expression (${what}): ${JSON.stringify(src)}`) }
  const atom = () => {
    const t = tokens[i]
    if (t === '(') { i++; const inner = either(); if (tokens[i] !== ')') fail('a bracket is not closed'); i++; return inner }
    if (!word(t) || op(t, 'OR') || op(t, 'AND') || op(t, 'WITH')) fail(t === undefined ? 'it ends early' : `unexpected ${t}`)
    i++
    if (!op(tokens[i], 'WITH')) return { id: t }
    const exception = tokens[i + 1]
    if (!word(exception) || op(exception, 'OR') || op(exception, 'AND') || op(exception, 'WITH')) fail('WITH names no exception')
    i += 2
    return { id: t, with: exception }
  }
  const chain = (next, name, key) => () => {
    const parts = [next()]
    while (op(tokens[i], name)) { i++; parts.push(next()) }
    return parts.length === 1 ? parts[0] : { [key]: parts }
  }
  const both = chain(atom, 'AND', 'and')
  const either = chain(both, 'OR', 'or')
  if (!tokens.length) fail('it is empty')
  const tree = either()
  if (i < tokens.length) fail(`unexpected ${tokens[i]}`)
  return tree
}

/**
 * Whether the policy allows a crate under this licence expression, and by which licences: `{ ok, by }` or `{ ok:
 * false, why }`. A licence is allowed outright (`licences.allowed`), with a listed exception (`licences.exceptions`),
 * or for the crates the policy names under it (`licences.byCrate`, the file-level copyleft a decision was taken on).
 */
export function permits(expression, crate, policy) {
  const { allowed, exceptions, byCrate } = policy.licences
  let tree
  try { tree = parseSpdx(expression) } catch (e) { return { ok: false, why: e.message } }
  const leaf = (n) => {
    if (n.with && !exceptions.includes(n.with)) return { ok: false, why: `${n.id} WITH ${n.with}: the exception is not one the policy lists` }
    if (allowed.includes(n.id)) return { ok: true, by: [n.with ? `${n.id} WITH ${n.with}` : n.id] }
    const named = byCrate[n.id]
    if (named?.crates.includes(crate)) return { ok: true, by: [`${n.id} (allowed for ${crate} by name)`] }
    return { ok: false, why: named ? `${n.id} is allowed only for ${named.crates.join(', ')}` : `${n.id} is not a licence the policy allows` }
  }
  const walk = (n) => {
    if (n.id) return leaf(n)
    const parts = (n.and ?? n.or).map(walk)
    if (n.and) {
      const bad = parts.find((p) => !p.ok)
      return bad ?? { ok: true, by: parts.flatMap((p) => p.by) }
    }
    return parts.find((p) => p.ok) ?? { ok: false, why: parts.map((p) => p.why).join('; ') }
  }
  return walk(tree)
}

// ---------------------------------------------------------------------------------------------------------------
// Crates

/** A crate as the inventory keys it. */
export const crateKey = (name, version) => `${name} ${version}`

/** The crates a Cargo.lock takes from outside the repository (those with a `source`): `[{ name, version, source }]`. */
export function lockCrates(text) {
  const out = []
  for (const block of String(text).split(/^\[\[package\]\]\s*$/m).slice(1)) {
    const field = (k) => block.match(new RegExp(`^${k} = "([^"]*)"\\s*$`, 'm'))?.[1]
    const [name, version, source] = [field('name'), field('version'), field('source')]
    if (!name || !version) throw new Error(`a [[package]] block without a name and a version:\n${block.trim().slice(0, 200)}`)
    if (source) out.push({ name, version, source })
  }
  return out
}

/**
 * What is wrong between the lockfiles, the inventory and the policy, as sentences (none: all three agree).
 * `locks` maps each workspace to its Cargo.lock's text; `inventory.crates` maps `name version` to a licence.
 */
export function crateFindings({ locks, inventory, policy }) {
  const problems = []
  const listed = policy.workspaces
  for (const ws of Object.keys(locks)) if (!listed.includes(ws)) problems.push(`${ws}/Cargo.lock is not a workspace the policy lists (${POLICY_FILE} workspaces)`)
  const used = new Map()
  for (const ws of listed) {
    if (locks[ws] === undefined) { problems.push(`${ws}/Cargo.lock is listed in the policy and was not read`); continue }
    for (const c of lockCrates(locks[ws])) {
      const key = crateKey(c.name, c.version)
      used.set(key, [...(used.get(key) ?? []), ws])
    }
  }
  const refresh = `run \`node tools/license/gate.mjs crates --write\` where cargo can reach the registry, and commit ${INVENTORY_FILE}`
  for (const [key, where] of used) {
    const licence = inventory.crates[key]
    const [name] = key.split(' ')
    if (licence === undefined) { problems.push(`${key} (${where.join(', ')}) is in a lockfile and not in the inventory: ${refresh}`); continue }
    if (licence === null) { problems.push(`${key} (${where.join(', ')}) states no licence in its manifest: read its licence file and decide`); continue }
    const verdict = permits(licence, name, policy)
    if (!verdict.ok) problems.push(`${key} (${where.join(', ')}) is under ${JSON.stringify(licence)}: ${verdict.why}`)
  }
  for (const key of Object.keys(inventory.crates)) if (!used.has(key)) problems.push(`${key} is in the inventory and in no lockfile: ${refresh}`)
  for (const [licence, { crates }] of Object.entries(policy.licences.byCrate)) {
    for (const name of crates) if (![...used.keys()].some((k) => k.startsWith(`${name} `))) problems.push(`the policy allows ${licence} for ${name}, which no lockfile holds any more: take it off the list`)
  }
  return problems
}

/** The licences `cargo metadata` reports for a workspace, as the inventory holds them: `{ 'name version': licence | null }`. */
export function metadataCrates(metadata) {
  const out = {}
  for (const p of metadata.packages) if (p.source) out[crateKey(p.name, p.version)] = p.license ?? null
  return out
}

/** The inventory as written to disk: one crate a line, sorted, so a change reads as a diff of crates. */
export function inventoryText(crates) {
  const keys = Object.keys(crates).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const lines = keys.map((k) => `    ${JSON.stringify(k)}: ${JSON.stringify(crates[k])}`)
  const about = 'Every crate the Cargo.lock files take from the registry, with the licence its own manifest states. Written by `node tools/license/gate.mjs crates --write`; never edited by hand (CI reads the registry again and compares).'
  return `{\n  "about": ${JSON.stringify(about)},\n  "crates": {\n${lines.join(',\n')}\n  }\n}\n`
}

/** What differs between what the registry says now (`fresh`) and the committed inventory, as sentences. */
export function registryFindings(fresh, inventory) {
  const problems = []
  for (const [key, licence] of Object.entries(fresh)) {
    if (!(key in inventory.crates)) problems.push(`${key} is in a lockfile and not in ${INVENTORY_FILE}`)
    else if (inventory.crates[key] !== licence) problems.push(`${key}: the registry says ${JSON.stringify(licence)}, ${INVENTORY_FILE} says ${JSON.stringify(inventory.crates[key])}`)
  }
  for (const key of Object.keys(inventory.crates)) if (!(key in fresh)) problems.push(`${key} is in ${INVENTORY_FILE} and in no lockfile`)
  return problems
}

/** Runs `cargo metadata` for one workspace, every feature on (an optional dependency is in the lockfile all the same). */
export function cargoMetadata(ws, run = spawnSync) {
  const r = run('cargo', ['metadata', '--locked', '--all-features', '--format-version', '1', '--manifest-path', join(ROOT, ws, 'Cargo.toml')], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error || r.status !== 0) throw new Error(`cargo metadata for ${ws} failed: ${r.error?.message ?? String(r.stderr).trim().split('\n').slice(-3).join(' | ')}`)
  return JSON.parse(r.stdout)
}

// ---------------------------------------------------------------------------------------------------------------
// The tree

/** Directories never read, at any depth: other programs' output and caches (.gitignore names the same). */
const SKIP_DIRS = new Set(['.git', 'node_modules', 'target', 'dist', 'dist-ssr', 'dist-pilot', 'dist-web', 'out', 'gen', 'logs', '__pycache__', '.direnv', '.claude', '.cursor', '.continue', '.codeium', '.windsurf', '.vscode', '.idea'])
const skipped = (name, rel) => SKIP_DIRS.has(name) || name === 'result' || name.startsWith('result-') || rel === 'src-tauri/models'

/** Every file of the checkout, as paths from the root with forward slashes, sorted. */
export function tree(root = ROOT) {
  const out = []
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const r = rel ? `${rel}/${name}` : name
      if (skipped(name, r)) continue
      const p = join(dir, name)
      if (statSync(p).isDirectory()) walk(p, r)
      else out.push(r)
    }
  }
  walk(root, '')
  return out
}

const TEXT = /\.(?:ts|tsx|mts|js|mjs|cjs|json|md|rs|toml|ya?ml|sh|py|nix|wgsl|css|html|txt|svg|ps1|ld|cmake|plist|xml|kts|gradle|properties|conf)$|(?:^|\/)(?:Dockerfile[^/]*|LICENSE|NOTICE)$/
const ASSET = /\.(?:png|jpe?g|gif|webp|avif|bmp|tiff?|ico|icns|svg|ttf|otf|ttc|woff2?|mp3|ogg|wav|flac|m4a|mp4|webm|mov|glb|gltf|fbx|obj|bin|gguf|onnx|wasm|gz|zip|pdf|psd|blend|hdr|exr|ktx2?)$/i

// ---------------------------------------------------------------------------------------------------------------
// Names

/** The part of a file the name scan reads: all of it, or what comes before the marker the policy gives for it. */
function scanned(path, text, policy) {
  const rule = policy.marks.until[path]
  if (!rule) return text
  const at = text.indexOf(rule.marker)
  return at < 0 ? text : text.slice(0, at)
}

/**
 * Every use of a listed mark, as `path:line: ...` sentences. `files` is `[path, text]` pairs; a path the policy
 * exempts (`marks.exempt`, each with its reason) or that is not the repository's own text (third_party/, lockfiles,
 * data) is passed over.
 */
export function markFindings(files, policy) {
  const { listed, exempt, notOurs } = policy.marks
  const passOver = new RegExp(notOurs)
  const rules = listed.map((m) => ({ ...m, re: new RegExp(m.pattern, 'i') }))
  const problems = []
  for (const [path, whole] of files) {
    if (path in exempt || passOver.test(path)) continue
    const lines = scanned(path, whole, policy).split('\n')
    lines.forEach((line, n) => {
      for (const rule of rules) {
        const m = line.match(rule.re)
        if (m) problems.push(`${path}:${n + 1}: "${m[0]}" (${rule.why}${rule.say ? `; say ${rule.say}` : ''})`)
      }
    })
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// Assets and third-party directories

/**
 * What is wrong with the pictures and packed files, and which listed ones still have an open question: `{ problems,
 * open }`. `paths` is the tree. An entry of `assets.files` names one file, or with a trailing slash a directory whose
 * files all share one origin.
 */
export function assetFindings(paths, policy) {
  const entries = policy.assets.files
  const problems = []
  const open = []
  const assets = paths.filter((p) => ASSET.test(p) && !p.startsWith('third_party/'))
  const covers = (e, p) => (e.path.endsWith('/') ? p.startsWith(e.path) : p === e.path)
  for (const p of assets) {
    const mine = entries.filter((e) => covers(e, p))
    if (mine.length === 0) problems.push(`${p} is not listed in ${POLICY_FILE} (assets.files): say where it came from and whose it is`)
    if (mine.length > 1) problems.push(`${p} is listed ${mine.length} times in ${POLICY_FILE} (assets.files)`)
  }
  for (const e of entries) {
    if (!e.origin || !e.rights) problems.push(`${e.path} is listed without ${!e.origin ? 'an origin' : 'whose it is (rights)'}`)
    if (!assets.some((p) => covers(e, p))) problems.push(`${e.path} is listed in ${POLICY_FILE} (assets.files) and no such file is in the repository`)
    if (e.open) open.push(`${e.path}: ${e.open}`)
  }
  return { problems, open }
}

/** How a licence text is known when it is read: what the file must contain to be the licence the policy states. */
const LICENCE_TEXTS = {
  MIT: /Permission is hereby granted, free of charge/,
  'Apache-2.0': /Apache License\s+Version 2\.0/,
}

/**
 * What is wrong under third_party/: a directory the policy does not list, a listed one that is gone, a licence the
 * policy does not allow, a text that is missing or is not that licence. `read(path)` returns a file's text or null.
 */
export function thirdPartyFindings(paths, policy, read) {
  const dirs = policy.assets.thirdParty
  const problems = []
  const present = new Set(paths.filter((p) => p.startsWith('third_party/')).map((p) => p.split('/')[1]))
  for (const name of present) if (!(name in dirs)) problems.push(`third_party/${name} is not listed in ${POLICY_FILE} (assets.thirdParty): state its licence and the texts it carries`)
  for (const [name, d] of Object.entries(dirs)) {
    if (!present.has(name)) { problems.push(`third_party/${name} is listed in ${POLICY_FILE} and is not in the repository`); continue }
    const verdict = permits(d.licence, name, policy)
    if (!verdict.ok) problems.push(`third_party/${name} is under ${d.licence}: ${verdict.why}`)
    const known = LICENCE_TEXTS[d.licence]
    if (!known) problems.push(`third_party/${name}: the gate does not know how to recognise the text of ${d.licence}`)
    const text = read(`third_party/${name}/${d.text}`)
    if (text === null) problems.push(`third_party/${name}/${d.text}, its licence text, is missing`)
    else if (known && !known.test(text)) problems.push(`third_party/${name}/${d.text} does not read as ${d.licence}`)
    for (const also of d.carries ?? []) if (read(`third_party/${name}/${also}`) === null) problems.push(`third_party/${name}/${also} is missing`)
  }
  return problems
}

// ---------------------------------------------------------------------------------------------------------------
// The whole gate

/** The three checks from the files alone: `{ problems: { crates, names, assets }, open, counts }`. */
export function gate(root = ROOT) {
  const policy = loadPolicy()
  const inventory = loadInventory()
  const paths = tree(root)
  const read = (p) => { try { return readHeld(join(root, p), 'utf8') } catch (e) { if (e?.code === 'ENOENT') return null; throw e } }
  const locks = Object.fromEntries(paths.filter((p) => /(?:^|\/)Cargo\.lock$/.test(p)).map((p) => [p.replace(/\/?Cargo\.lock$/, ''), read(p)]))
  const texts = paths.filter((p) => TEXT.test(p)).map((p) => [p, read(p)])
  const assets = assetFindings(paths, policy)
  return {
    problems: {
      crates: crateFindings({ locks, inventory, policy }),
      names: markFindings(texts, policy),
      assets: [...assets.problems, ...thirdPartyFindings(paths, policy, read)],
    },
    open: assets.open,
    counts: { crates: Object.keys(inventory.crates).length, lockfiles: Object.keys(locks).length, texts: texts.length, assets: paths.filter((p) => ASSET.test(p) && !p.startsWith('third_party/')).length, thirdParty: Object.keys(policy.assets.thirdParty).length },
  }
}

export function main(argv, { run = spawnSync, log = console.log } = {}) {
  const [cmd, ...rest] = argv
  if (cmd === 'crates' && (rest[0] === '--check' || rest[0] === '--write') && rest.length === 1) {
    const policy = loadPolicy()
    const fresh = {}
    try {
      for (const ws of policy.workspaces) Object.assign(fresh, metadataCrates(cargoMetadata(ws, run)))
    } catch (e) { log(`crate-licences: ${e.message}`); return 2 }
    if (rest[0] === '--write') {
      writeFileSync(join(ROOT, INVENTORY_FILE), inventoryText(fresh))
      log(`crate-licences: ${Object.keys(fresh).length} crates written to ${INVENTORY_FILE}`)
      return 0
    }
    const inventory = loadInventory()
    const locks = Object.fromEntries(policy.workspaces.map((ws) => [ws, readFileSync(join(ROOT, ws, 'Cargo.lock'), 'utf8')]))
    const problems = [...registryFindings(fresh, inventory), ...crateFindings({ locks, inventory, policy })]
    for (const p of problems) log(`crate-licences: ${p}`)
    log(`crate-licences: ${Object.keys(fresh).length} crates of ${policy.workspaces.length} workspaces read from the registry, ${problems.length} wrong`)
    return problems.length ? 1 : 0
  }
  if (cmd !== undefined) {
    log('usage: node tools/license/gate.mjs                    the three checks, from the files alone\n       node tools/license/gate.mjs crates --check     the inventory against the registry (needs cargo)\n       node tools/license/gate.mjs crates --write     write the inventory from the registry (needs cargo)')
    return cmd === '--help' ? 0 : 1
  }
  const g = gate()
  let wrong = 0
  for (const [part, problems] of Object.entries(g.problems)) {
    for (const p of problems) log(`licence-gate: ${part}: ${p}`)
    wrong += problems.length
  }
  for (const o of g.open) log(`licence-gate: open: ${o}`)
  log(`licence-gate: ${g.counts.crates} crates of ${g.counts.lockfiles} lockfiles, ${g.counts.texts} text files, ${g.counts.assets} pictures and packed files, ${g.counts.thirdParty} third-party directories: ${wrong} wrong, ${g.open.length} open`)
  return wrong ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
