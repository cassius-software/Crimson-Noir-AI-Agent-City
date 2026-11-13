#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It puts the site's model beside the web copy (dist-web/models/), the one model the page
 * gets by itself once the city is on screen (src/09_Cognition/siteAuto.ts) or a visitor gets in a tap on Sloane's card,
 * and the app's model into the Windows installer (src-tauri/models/, which src-tauri/tauri.model.conf.json bundles),
 * and never anywhere else: the page file (dist/), the bare .exe and the release builds carry no model. Each pin is the
 * page's own (src/09_Cognition/siteModel.ts SITE_MODEL and APP_MODEL: the file's name, size and SHA-256, and the
 * Hugging Face repository and revision it comes from), so the page and the folder can never disagree about which model
 * is served or carried.
 * Usage (`--pin app` picks the app's model; the site's is the default):
 *   node tools/web/siteModel.mjs pin [--pin app]           the pin as KEY=value lines (for $GITHUB_OUTPUT): key, file,
 *                                                           bytes, sha256, url (Hugging Face, at the pinned revision)
 *   node tools/web/siteModel.mjs check --from <dir> [--pin app]
 *                                                           <dir>/<file> has exactly the pinned size and SHA-256
 *   node tools/web/siteModel.mjs place --from <dir> --out dist-web
 *                                                           the same check while copying it into dist-web/models/,
 *                                                           then manifest.json, LICENSE and NOTICE beside it
 *   node tools/web/siteModel.mjs app --from <dir> [--out src-tauri]
 *                                                           the same check while copying the app's model into
 *                                                           src-tauri/models/, then its LICENSE and NOTICE beside it
 * The web workflow (.github/workflows/web.yml) runs pin, fetches the file whenever its cache (keyed by the whole pin)
 * does not hold it, and runs place after `npm run build:web`, on every publish (a cached file is checked again); the
 * Windows workflow (windows-app.yml) does the same with `--pin app` and app before it builds the installer; the
 * site-model workflow runs both checks on a pull request that changes a pin. Nothing is written unless every byte
 * matches: the copy goes to a .part file, renamed into place only once its hash is right.
 * What breaks if it is removed? The web copy serves no model, and Sloane's card offers none (it only offers what the
 * manifest names exactly); the Windows installer carries none.
 */
import { createHash } from 'node:crypto'
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APP_MODEL, SITE_DIR, SITE_MODEL, manifestText } from '../../src/09_Cognition/siteModel.ts'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
/** The site's model's licence and notice (third_party/qwen2.5-0.5b-instruct/), served beside it. */
export const LICENCE_DIR = join(ROOT, 'third_party', 'qwen2.5-0.5b-instruct')
/** The app's model's licence and notice (third_party/qwen2.5-1.5b-instruct/), carried beside it. */
export const APP_LICENCE_DIR = join(ROOT, 'third_party', 'qwen2.5-1.5b-instruct')
export const LICENCE_FILES = Object.freeze(['LICENSE', 'NOTICE'])
/** The desktop app's folder, whose models/ the installer config bundles (src-tauri/tauri.model.conf.json). */
export const APP_OUT = join(ROOT, 'src-tauri')

/** The two pins by the name `--pin` takes: each with its licence folder and its cache key's prefix. */
export const PINS = Object.freeze({
  site: Object.freeze({ pin: SITE_MODEL, licence: LICENCE_DIR, prefix: 'site-model' }),
  app: Object.freeze({ pin: APP_MODEL, licence: APP_LICENCE_DIR, prefix: 'app-model' }),
})

/**
 * The cache key for a pin: its hash, and a digest of everything else in it (the repository, the revision, the file's
 * name and size), so a pin that names another address or file misses the cache and is fetched, and checked, anew.
 */
export function cacheKey(pin = SITE_MODEL, prefix = 'site-model') {
  const where = createHash('sha256').update(`${pin.repo}\n${pin.revision}\n${pin.file}\n${pin.bytes}`).digest('hex').slice(0, 16)
  return `${prefix}-${pin.sha256}-${where}`
}

/** The pin as the workflow's outputs: the cache key (one per pin), the file, its size and hash, and where to fetch it. */
export function pinLines(pin = SITE_MODEL, prefix = 'site-model') {
  return [
    `key=${cacheKey(pin, prefix)}`,
    `file=${pin.file}`,
    `bytes=${pin.bytes}`,
    `sha256=${pin.sha256}`,
    `url=https://huggingface.co/${pin.repo}/resolve/${pin.revision}/${pin.file}`,
  ]
}

/** Reads `file` through SHA-256, writing each piece to `to` as well when given; resolves to its size and hash. */
async function hashFile(file, to) {
  const hash = createHash('sha256')
  const out = to ? createWriteStream(to) : null
  let bytes = 0
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk)
    bytes += chunk.length
    if (out && !out.write(chunk)) await once(out, 'drain')
  }
  if (out) {
    out.end()
    await once(out, 'finish')
  }
  return { bytes, sha256: hash.digest('hex') }
}

/** Why `got` is not the pinned model, or null. */
function mismatch(got, pin) {
  if (got.bytes !== pin.bytes) return `${pin.file} is ${got.bytes} bytes; the pin says ${pin.bytes}`
  if (got.sha256 !== pin.sha256) return `${pin.file} has SHA-256 ${got.sha256}; the pin says ${pin.sha256}`
  return null
}

/** Throws unless `<from>/<file>` is exactly the pinned model; resolves to its size and hash. */
export async function checkModel({ from, pin = SITE_MODEL }) {
  const file = join(from, pin.file)
  if (!existsSync(file)) throw new Error(`${file} is missing`)
  const got = await hashFile(file)
  const no = mismatch(got, pin)
  if (no) throw new Error(no)
  return got
}

/**
 * Copies the pinned model from `from` into `<out>/models/` while checking it, then writes the manifest and the
 * licence beside it. Refuses a folder that is not the web copy (its index.html names no manifest: dist/ never gets a
 * model), and leaves no model behind when the check fails. Resolves to the files written, relative to `out`.
 */
export async function placeModel({ from, out, pin = SITE_MODEL, licence = LICENCE_DIR }) {
  const page = join(out, 'index.html')
  if (!existsSync(page) || !readFileSync(page, 'utf8').includes('rel="manifest"')) {
    throw new Error(`${out} is not the web copy (tools/web/pwa.mjs writes it): the model goes beside that page only`)
  }
  const src = join(from, pin.file)
  if (!existsSync(src)) throw new Error(`${src} is missing`)
  const dir = join(out, SITE_DIR)
  mkdirSync(dir, { recursive: true })
  const part = join(dir, `${pin.file}.part`)
  let got
  try {
    got = await hashFile(src, part)
  } catch (e) {
    rmSync(part, { force: true })
    throw e
  }
  const no = mismatch(got, pin)
  if (no) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(no)
  }
  renameSync(part, join(dir, pin.file))
  writeFileSync(join(dir, 'manifest.json'), manifestText(pin))
  for (const f of LICENCE_FILES) copyFileSync(join(licence, f), join(dir, f))
  return [pin.file, 'manifest.json', ...LICENCE_FILES].map((f) => `${SITE_DIR}${f}`)
}

/**
 * Copies the app's pinned model from `from` into `<out>/models/` (src-tauri/models/ by default, which the installer
 * config bundles) while checking it, then its licence and notice beside it. No manifest: the shell itself says the
 * file is there (src-tauri/src/model.rs). Leaves no model behind when the check fails, and takes away any other file
 * an earlier run left in models/, so the installer carries exactly the pinned model and its licence. Resolves to the
 * files written, relative to `out`.
 */
export async function placeApp({ from, out = APP_OUT, pin = APP_MODEL, licence = APP_LICENCE_DIR }) {
  const src = join(from, pin.file)
  if (!existsSync(src)) throw new Error(`${src} is missing`)
  const dir = join(out, SITE_DIR)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const part = join(dir, `${pin.file}.part`)
  let got
  try {
    got = await hashFile(src, part)
  } catch (e) {
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
  const no = mismatch(got, pin)
  if (no) {
    rmSync(dir, { recursive: true, force: true })
    throw new Error(no)
  }
  renameSync(part, join(dir, pin.file))
  for (const f of LICENCE_FILES) copyFileSync(join(licence, f), join(dir, f))
  return [pin.file, ...LICENCE_FILES].map((f) => `${SITE_DIR}${f}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(`--${name}`)
    return i > 0 ? process.argv[i + 1] : undefined
  }
  const need = (name) => {
    const v = arg(name)
    if (!v) throw new Error(`--${name} <dir> is needed`)
    return resolve(v)
  }
  const command = process.argv[2]
  try {
    const which = arg('pin') ?? (command === 'app' ? 'app' : 'site')
    const chosen = Object.hasOwn(PINS, which) ? PINS[which] : null
    if (!chosen) throw new Error(`--pin takes site or app, not ${which}`)
    if (command === 'pin') {
      console.log(pinLines(chosen.pin, chosen.prefix).join('\n'))
    } else if (command === 'check') {
      const got = await checkModel({ from: need('from'), pin: chosen.pin })
      console.log(`${chosen.pin.file}  ${got.bytes} bytes  sha256 ${got.sha256}  matches the pin`)
    } else if (command === 'app') {
      if (which !== 'app') throw new Error('app places the app\'s model only')
      const out = arg('out') ? need('out') : APP_OUT
      const files = await placeApp({ from: need('from'), out })
      console.log(`app model  ${out}  (${APP_MODEL.file}, ${statSync(join(out, SITE_DIR, APP_MODEL.file)).size} bytes, checked)`)
      for (const f of files) console.log(`  ${f}`)
    } else if (command === 'place') {
      if (which !== 'site') throw new Error('place serves the site\'s model only (the app\'s goes in with app)')
      const out = need('out')
      const files = await placeModel({ from: need('from'), out })
      console.log(`site model  ${out}  (${SITE_MODEL.file}, ${statSync(join(out, SITE_DIR, SITE_MODEL.file)).size} bytes, checked)`)
      for (const f of files) console.log(`  ${f}`)
    } else {
      throw new Error('usage: node tools/web/siteModel.mjs pin [--pin app] | check --from <dir> [--pin app] | place --from <dir> --out <dist-web> | app --from <dir> [--out <src-tauri>]')
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e))
    process.exit(1)
  }
}
