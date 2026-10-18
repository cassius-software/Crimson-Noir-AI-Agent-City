#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the check of what `npm run build` leaves behind (tools/selfheal/checks.sh page-build
 * runs it after the build): `node tools/verify/page_dist.mjs [DIR]` (DIR defaults to dist) exits 1 unless
 *   - DIR holds exactly index.html: the product is one self-contained file, and nothing else may ship beside it (a
 *     chunk split out of the bundle, an asset Vite copied, a model);
 *   - no .gguf file is anywhere in DIR: a model is the operator's own file, kept in their browser, never shipped;
 *   - index.html is at most MAX_BYTES (the size measured with the in-page model runtime embedded, plus 3%), so a page
 *     that grows on a phone's connection does so on purpose, with this number raised in review;
 *   - the http(s) hosts the page names are exactly the reviewed list below (loopback aside): a new address anywhere in
 *     the page (code, a string, a licence text) is read and added here, or removed, before it ships. The page reaches
 *     none of them by itself (index.html's policy allows no host but this machine); these are links, licence texts and
 *     the dead download paths of wllama, which the adapter never calls;
 *   - when the page carries the pinned in-page runtime (third_party/wllama/<version>/wllama.wasm.gz, as base64 byte
 *     for byte), it also carries that directory's NOTICE in full, and names the hosts that come with it.
 * What breaks if it is removed? A second file, a model or an unreviewed address could reach dist/ and ship unnoticed,
 * and the page could grow by megabytes without anyone deciding it should.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/** The page with the in-page runtime embedded measured 13,956,193 bytes (18 October 2026); this is that plus 3%. */
export const MAX_BYTES = 14_375_000

/** The hosts the page names without the in-page runtime, all from bundled packages and notices: React's error links,
 *  Tailwind's banner, three.js's removal note and a shader's credit, the SVG and MathML namespaces, and the Apache
 *  licence text in Rapier's notice. */
export const PAGE_HOSTS = ['github.com', 'react.dev', 'tailwindcss.com', 'www.apache.org', 'www.shadertoy.com', 'www.w3.org']
/** The hosts that come with the in-page runtime: wllama's Hugging Face and CDN paths (never called: setCompat(null), no
 *  download is ever asked for), and the LLVM and miniaudio licence texts in the runtime's NOTICE. */
export const RUNTIME_HOSTS = ['cdn.jsdelivr.net', 'huggingface.co', 'llvm.org', 'unlicense.org']

/** The pinned runtime the page may carry. */
export const RUNTIME_PIN = 'third_party/wllama/3.8.1'

/** This machine: never an off-machine address, whatever the page says about it. */
export const loopback = (host) => host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '[::1]'

/** Every host an http:// or https:// address in the text names, lowercased (a sentence's full stop is not part of it). */
export function hostsIn(text) {
  const hosts = new Set()
  for (const m of text.matchAll(/\bhttps?:\/\/(\[[0-9a-f:.]+\]|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)/gi)) hosts.add(m[1].toLowerCase())
  return hosts
}

/** Every file under a directory, relative to it, with forward slashes. */
function files(dir, base = dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p, base))
    else out.push(relative(base, p).replaceAll('\\', '/'))
  }
  return out.sort()
}

/** What is wrong with a built page directory: an empty list when nothing is. */
export function checkDist(dir, root = ROOT) {
  if (!existsSync(dir)) return [`${dir} does not exist: run npm run build first`]
  const problems = []
  const all = files(dir)
  const models = all.filter((f) => /\.gguf$/i.test(f))
  if (models.length) problems.push(`a model file is in the build: ${models.join(', ')}`)
  if (all.length !== 1 || all[0] !== 'index.html') problems.push(`the build must be exactly index.html; it holds ${all.length ? all.join(', ') : 'nothing'}`)
  if (!all.includes('index.html')) return problems
  const page = readFileSync(join(dir, 'index.html'))
  if (page.length > MAX_BYTES) problems.push(`index.html is ${page.length} bytes, over the budget of ${MAX_BYTES}: raise MAX_BYTES in tools/verify/page_dist.mjs only if the growth was meant`)
  const text = page.toString('utf8')
  const gz = readFileSync(join(root, RUNTIME_PIN, 'wllama.wasm.gz')).toString('base64')
  const runtime = text.includes(gz)
  if (runtime && !text.includes(readFileSync(join(root, RUNTIME_PIN, 'NOTICE'), 'utf8').trim())) {
    problems.push(`the page carries the in-page runtime but not ${RUNTIME_PIN}/NOTICE (the licences of what is compiled into it)`)
  }
  const want = new Set([...PAGE_HOSTS, ...(runtime ? RUNTIME_HOSTS : [])])
  const named = [...hostsIn(text)].filter((h) => !loopback(h))
  const unreviewed = named.filter((h) => !want.has(h)).sort()
  const gone = [...want].filter((h) => !named.includes(h)).sort()
  if (unreviewed.length) problems.push(`index.html names hosts nobody reviewed: ${unreviewed.join(', ')} (read where each comes from, then add it to tools/verify/page_dist.mjs or remove it)`)
  if (gone.length) problems.push(`index.html no longer names ${gone.join(', ')}: take ${gone.length === 1 ? 'it' : 'them'} off the reviewed list in tools/verify/page_dist.mjs`)
  console.log(`page_dist: ${relative(root, dir) || dir}/index.html ${page.length} bytes (budget ${MAX_BYTES}), ${runtime ? 'with' : 'without'} the in-page runtime, hosts ${named.sort().join(' ')}`)
  return problems
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = resolve(process.argv[2] ?? 'dist')
  const problems = checkDist(dir)
  for (const p of problems) console.log(`::error::page_dist: ${p}`)
  process.exit(problems.length ? 1 : 0)
}
