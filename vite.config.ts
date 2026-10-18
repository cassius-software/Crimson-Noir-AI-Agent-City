// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Vite's build configuration. The deployment constraint: `vite build` must
 * emit exactly one self-contained dist/index.html. viteSingleFile inlines every script, stylesheet and
 * asset; nothing may be served from public/, because Vite copies those as loose files. Two small
 * plugins make that one file carry the brand (title, favicon and the black boot splash with the
 * skyline mark, all from src/brand.ts) and its legal notices (NOTICE.md plus the license text of every
 * bundled npm package).
 * The pilot build (`vite build --mode pilot`, npm run build:pilot) is the same page with a surveyed region embedded
 * (world/pilot.region.json.gz, compiled by tools/world), written to dist-pilot/index.html: still one file, still offline.
 * The in-page model runtime (wllama's WebAssembly build of llama.cpp) rides in the same way: the committed, pinned
 * third_party/wllama/<version>/wllama.wasm.gz as base64, checked against its sums and against the npm package.
 * What breaks if it is removed? Both the dev server and the single-file build.
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'
import { BRAND, MONOLITH_SVG } from './src/brand.ts'

const ROOT = dirname(fileURLToPath(import.meta.url))

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** Tokens index.html may use. Text is HTML-escaped. Base64 keeps the favicon URI free of '%' (Vite's
 *  %ENV% syntax) and quotes. BRAND_MARK is the mark as inline SVG markup for the boot splash: inline,
 *  it is painted with the page's first frame (no image decode), exactly as BootVeil.tsx paints it. */
export const BRAND_TOKENS: Readonly<Record<string, string>> = {
  '%BRAND_NAME%': escapeHtml(BRAND.name),
  '%BRAND_TAGLINE%': escapeHtml(BRAND.tagline),
  '%BRAND_VERSION%': escapeHtml(BRAND.version),
  '%BRAND_ICON%': `data:image/svg+xml;base64,${Buffer.from(MONOLITH_SVG).toString('base64')}`,
  '%BRAND_MARK%': MONOLITH_SVG,
}

/** index.html text meant only for someone who opens the source file directly (no plugin runs then). */
const SOURCE_ONLY = /[ \t]*<!-- source-only[\s\S]*?<!-- \/source-only -->[ \t]*\r?\n?/g

/** Drops the source-only hint and replaces every %BRAND_*% token. An unknown token or an unclosed
 *  source-only marker is a typo and fails loudly rather than shipping. */
export function brandHtml(html: string): string {
  const page = html.replace(SOURCE_ONLY, '')
  if (page.includes('source-only')) throw new Error('index.html: unbalanced source-only marker')
  return page.replace(/%BRAND_[A-Z]+%/g, (token) => {
    const value = BRAND_TOKENS[token]
    if (value === undefined) throw new Error(`index.html: unknown brand token ${token}`)
    return value
  })
}

/** 'pre' so the favicon is already a data: URI (which Vite leaves alone) before Vite resolves asset URLs. */
function brand(): Plugin {
  return { name: 'brand-html', transformIndexHtml: { order: 'pre', handler: brandHtml } }
}

/** Everything in NOTICE.md from this heading on is for the operator and stays out of the build. */
export const OPERATOR_NOTES = '\n## Operator notes'
/**
 * Packages a build plugin writes into the page without them appearing as bundled modules: Tailwind's generated CSS,
 * and wllama, whose WebAssembly module wllamaRuntime embeds from the pinned copy of the package's own file (so no
 * module of the package accounts for it). wllama's notice is embedded whether or not the chunks reach the runtime yet.
 */
const GENERATED_INTO_PAGE = ['tailwindcss', '@wllama/wllama'] as const
/**
 * Package directories bundled into the page's inline workers. Vite builds each `?worker` import as a bundle of
 * its own (the physics worker carries Rapier), so its modules never appear in the page's chunks; the worker
 * build's own plugin (workerNotices) records them here before the page's HTML is transformed.
 */
const workerPackages = new Set<string>()
const LICENSE_FILE = /^(licen[cs]e|copying)(\.|$)/i
const NODE_MODULES = '/node_modules/'

export interface PackageNotice { name: string; version: string; license: string; text: string }

/** node_modules package directory a module id belongs to (scoped, nested and pnpm layouts), else null. */
export function packageRoot(id: string): string | null {
  if (id.startsWith('\0')) return null
  const path = id.split('?')[0].replaceAll('\\', '/')
  const at = path.lastIndexOf(NODE_MODULES)
  if (at < 0) return null
  const parts = path.slice(at + NODE_MODULES.length).split('/')
  const depth = parts[0].startsWith('@') ? 2 : 1
  if (parts.length <= depth || !parts[depth - 1]) return null
  return path.slice(0, at + NODE_MODULES.length) + parts.slice(0, depth).join('/')
}

export function readPackageNotice(dir: string): PackageNotice | null {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string; license?: unknown }
    const file = readdirSync(dir).find((f) => LICENSE_FILE.test(f))
    return {
      name: pkg.name ?? dir,
      version: pkg.version ?? '',
      license: typeof pkg.license === 'string' ? pkg.license : 'see package',
      text: file ? readFileSync(join(dir, file), 'utf8').trim() : '(no license file in the package; see its package.json)',
    }
  } catch {
    return null
  }
}

/** Nothing inside may close or reopen the comment it is embedded in. */
const commentSafe = (s: string) => s.replace(/<!--|--!?>/g, (m) => m.split('').join(' '))

/** The notice block embedded before </body>: NOTICE.md's shipped part, then each bundled package's license. */
export function noticesComment(noticeMd: string, packages: readonly PackageNotice[]): string {
  const cut = noticeMd.indexOf(OPERATOR_NOTES)
  const shipped = (cut < 0 ? noticeMd : noticeMd.slice(0, cut)).trim()
  const rule = '='.repeat(100)
  const blocks = [shipped, `${rule}\nThird-party software bundled in this file (each under its own license, not the ORC License)`]
  for (const p of packages) blocks.push(`${rule}\n${p.name} ${p.version} (${p.license})\n\n${p.text}`)
  return `<!--\n${commentSafe(blocks.join('\n\n'))}\n-->`
}

/** Runtime dependencies (package.json `dependencies`) with no embedded notice: each one is a licence the build would
 *  ship without. */
export function missingNotices(dependencies: Readonly<Record<string, string>>, packages: readonly PackageNotice[]): string[] {
  const embedded = new Set(packages.map((p) => p.name))
  return Object.keys(dependencies).filter((name) => !embedded.has(name)).sort()
}

/** The package directories a bundle's chunks were built from. */
export function bundledPackageDirs(bundle: Readonly<Record<string, { type: string; moduleIds?: readonly string[] }>>): string[] {
  const dirs = new Set<string>()
  for (const out of Object.values(bundle)) {
    if (out.type !== 'chunk') continue
    for (const id of out.moduleIds ?? []) {
      const dir = packageRoot(id)
      if (dir) dirs.add(dir)
    }
  }
  return [...dirs]
}

/** Whether a bundle's chunks were built from a module (a virtual module by its \0-prefixed id). */
export function bundleCarries(bundle: Readonly<Record<string, { type: string; moduleIds?: readonly string[] }>>, id: string): boolean {
  return Object.values(bundle).some((out) => out.type === 'chunk' && (out.moduleIds ?? []).includes(id))
}

export function embedNotices(html: string, comment: string): string {
  const at = html.lastIndexOf('</body>')
  return at < 0 ? `${html}\n${comment}\n` : `${html.slice(0, at)}${comment}\n${html.slice(at)}`
}

/** Build only, inside each worker's own bundle: records the packages that bundle was built from. */
function workerNotices(): Plugin {
  return {
    name: 'embedded-notices:worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      for (const dir of bundledPackageDirs(bundle)) workerPackages.add(dir)
    },
  }
}

/**
 * Build only. Runs as a 'post' HTML transform: the JS chunks (and their module ids) still exist then,
 * because viteSingleFile inlines and deletes them later, in generateBundle; the inline workers were built
 * (and recorded by workerNotices) when the page's chunks imported them. The notice goes at the end of the
 * body so <meta charset> stays inside the first 1024 bytes. A runtime dependency without a notice fails the
 * build: a licence must never ship silently missing again. A page that carries the in-page runtime also carries its
 * pinned NOTICE (the components compiled into the module, each licence in full: Dawn's asks for it in a binary).
 */
function notices(): Plugin {
  return {
    name: 'embedded-notices',
    apply: 'build',
    buildStart() {
      const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version?: string }
      if (pkg.version !== BRAND.version) {
        this.error(`package.json version ${pkg.version} differs from BRAND.version ${BRAND.version} (src/brand.ts); release them together`)
      }
    },
    transformIndexHtml: {
      order: 'post',
      handler(html, ctx) {
        if (!ctx.bundle) return html
        const dirs = new Set([...bundledPackageDirs(ctx.bundle), ...workerPackages])
        for (const name of GENERATED_INTO_PAGE) dirs.add(join(ROOT, 'node_modules', name))
        const byName = new Map<string, PackageNotice>()
        for (const dir of dirs) {
          const p = readPackageNotice(dir)
          if (p) byName.set(`${p.name}@${p.version}`, p)
        }
        const packages = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
        const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
        const missing = missingNotices(pkg.dependencies ?? {}, packages)
        if (missing.length) throw new Error(`no licence notice would be embedded for ${missing.join(', ')}: every runtime dependency must ship its licence`)
        if (bundleCarries(ctx.bundle, `\0${WLLAMA_MODULE}`)) packages.push(runtimeNotice())
        return embedNotices(html, noticesComment(readFileSync(join(ROOT, 'NOTICE.md'), 'utf8'), packages))
      },
    },
  }
}

/** The id App imports the embedded region from (src/region-pack.d.ts types it). */
export const REGION_MODULE = 'virtual:region-pack'
/** The surveyed region every build embeds (the pilot build opens on it). */
export const PILOT_PACK = 'world/pilot.region.json.gz'

/**
 * The embedded region module's source: the pack's gzipped bytes as base64 (the default export), and whether the page
 * opens on the region rather than the procedural city (`regionFirst`: the pilot build only). Every build carries the
 * pack, so the single file needs nothing from a network or a disk beside it to show the region.
 */
export function regionModule(mode: string, pack: Uint8Array): string {
  return `export const regionFirst = ${mode === 'pilot'}\nexport default ${JSON.stringify(Buffer.from(pack).toString('base64'))}`
}

/**
 * The embedded region: `virtual:region-pack` (src/region-pack.d.ts types it). Every build carries it, the default
 * dist/index.html too, so the one file plays the surveyed map with no network and nothing beside it; a missing pack
 * fails the build loudly.
 */
function regionPack(mode: string): Plugin {
  const resolved = `\0${REGION_MODULE}`
  return {
    name: 'region-pack',
    resolveId: (id) => (id === REGION_MODULE ? resolved : null),
    load(id) {
      if (id !== resolved) return null
      const file = join(ROOT, PILOT_PACK)
      if (!existsSync(file)) throw new Error(`the build embeds ${PILOT_PACK}: compile it with tools/world/compile.mjs`)
      return regionModule(mode, readFileSync(file))
    },
  }
}

/** The id the in-page runtime's adapter imports the pinned wllama module from (src/wllama-runtime.d.ts types it). */
export const WLLAMA_MODULE = 'virtual:wllama-runtime'
/** The pinned wllama version: package.json names it exactly, and the pinned directory carries it. */
export const WLLAMA_VERSION = '3.8.1'
/** The pinned module, its sums, its import list and its notices (tools/native/wllama-pack.mjs writes them from the
 *  package; tools/verify/wasm_airgap.py holds the module to its import list without npm). */
export const WLLAMA_PIN = `third_party/wllama/${WLLAMA_VERSION}`
/** The module as the npm package publishes it: the build holds the pinned copy to it byte for byte. */
const WLLAMA_PACKAGE_WASM = 'node_modules/@wllama/wllama/esm/wasm/wllama.wasm'

const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** The sha256 a SHA256SUMS text names for a file (sha256sum's `<hex>  <name>` lines), else null. */
export function sumFor(sums: string, name: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line)
    if (m && m[2] === name) return m[1]
  }
  return null
}

/**
 * The in-page runtime module's source: the pinned module's gzip as base64 (the default export: about 3.2 MB of the
 * page rather than 11.7 MB for the raw module; the adapter gunzips it itself), the raw module's sha256 (the adapter
 * checks what it gunzipped against it) and length, and the pinned version. A gz that is not the one SHA256SUMS names,
 * or that holds another module, throws: a damaged or hand-edited pin fails the build and never ships.
 */
export function wllamaModule(gz: Uint8Array, sums: string): string {
  if (sha256Hex(gz) !== sumFor(sums, 'wllama.wasm.gz')) throw new Error(`${WLLAMA_PIN}/wllama.wasm.gz does not hash to the sha256 its SHA256SUMS names`)
  const raw = gunzipSync(gz)
  const sha256 = sha256Hex(raw)
  if (sha256 !== sumFor(sums, 'wllama.wasm')) throw new Error(`${WLLAMA_PIN}/wllama.wasm.gz holds a module (sha256 ${sha256}) that is not the one its SHA256SUMS names`)
  return [
    `export const version = ${JSON.stringify(WLLAMA_VERSION)}`,
    `export const sha256 = ${JSON.stringify(sha256)}`,
    `export const bytes = ${raw.length}`,
    `export default ${JSON.stringify(Buffer.from(gz).toString('base64'))}`,
  ].join('\n')
}

/** The pinned runtime's own notice: the components compiled into the module and each one's licence in full. */
function runtimeNotice(): PackageNotice {
  return {
    name: 'wllama.wasm, the in-page model runtime',
    version: WLLAMA_VERSION,
    license: 'MIT, BSD-3-Clause, Apache-2.0 WITH LLVM-exception and the others listed below',
    text: readFileSync(join(ROOT, WLLAMA_PIN, 'NOTICE'), 'utf8').trim(),
  }
}

/**
 * The in-page model runtime: `virtual:wllama-runtime` (src/wllama-runtime.d.ts types it), imported dynamically by
 * the adapter alone; viteSingleFile inlines it into the one file like everything else, so the page never fetches it.
 * Shaped like regionPack: the committed gz, checked against SHA256SUMS and against the module the installed
 * @wllama/wllama publishes; any difference, or a missing file, fails the build loudly.
 */
function wllamaRuntime(): Plugin {
  const resolved = `\0${WLLAMA_MODULE}`
  return {
    name: 'wllama-runtime',
    resolveId: (id) => (id === WLLAMA_MODULE ? resolved : null),
    load(id) {
      if (id !== resolved) return null
      const gz = join(ROOT, WLLAMA_PIN, 'wllama.wasm.gz')
      const sums = join(ROOT, WLLAMA_PIN, 'SHA256SUMS')
      if (!existsSync(gz) || !existsSync(sums)) throw new Error(`the build embeds ${WLLAMA_PIN}/wllama.wasm.gz and its SHA256SUMS: write them with npm run native:wllama`)
      const text = readFileSync(sums, 'utf8')
      const source = wllamaModule(readFileSync(gz), text)
      const published = join(ROOT, WLLAMA_PACKAGE_WASM)
      if (!existsSync(published)) throw new Error(`${WLLAMA_PACKAGE_WASM} is missing: npm ci installs @wllama/wllama ${WLLAMA_VERSION}`)
      if (sha256Hex(readFileSync(published)) !== sumFor(text, 'wllama.wasm')) {
        throw new Error(`${WLLAMA_PIN} is not the module the installed @wllama/wllama publishes (${WLLAMA_PACKAGE_WASM}): npm ci, or npm run native:wllama after an upgrade`)
      }
      return source
    },
  }
}

/**
 * Cross-origin isolation for the dev and preview servers. With these two headers the page may share memory
 * with its physics worker (07_Execute_Actions/sharedBridge.ts over a SharedArrayBuffer; without them the bridge is a
 * plain buffer the page fills itself, and nothing else changes). The page loads nothing cross-origin (index.html's
 * policy allows no host but this machine), so `require-corp` costs it nothing. A deployment that serves dist/index.html
 * from its own server sends the same two headers to get the same (deploy/README.md).
 */
export const ISOLATION_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
})

/**
 * The isolation headers on every response of the dev and preview servers. A plugin's hook rather than a server
 * section of the config, so both servers keep Vite's own loopback host (zeroTrust.test.ts holds the config to that):
 * only the headers change, nothing about where the servers listen.
 */
function isolation(): Plugin {
  const add = (res: { setHeader(name: string, value: string): void }): void => {
    for (const [name, value] of Object.entries(ISOLATION_HEADERS)) res.setHeader(name, value)
  }
  return {
    name: 'cross-origin-isolation',
    configureServer: (dev) => { dev.middlewares.use((_req, res, next) => { add(res); next() }) },
    configurePreviewServer: (preview) => { preview.middlewares.use((_req, res, next) => { add(res); next() }) },
  }
}

/**
 * The page's module script, moved from <head> to the end of <body>. Vite puts the entry in <head>, and once
 * viteSingleFile has inlined it there it is about 14 MB of text before the body: a browser paints nothing of the body
 * until all of it has arrived, so a first visit on a phone over a slow connection is a blank page for as long as the
 * download takes (it read as a load that never ends). At the end of the body the splash is on screen while it
 * downloads, and the boot watchdog (in <head>) has long been running. Nothing else changes: an inline module script
 * runs when the document has been parsed wherever it stands. Pure, for the test (bootWatchdog.test.ts); a page without
 * exactly one module script is left as it is.
 */
export function moduleAfterBody(html: string): string {
  const open = html.indexOf('<script type="module"')
  if (open < 0 || html.indexOf('<script type="module"', open + 1) >= 0) return html
  const end = html.indexOf('</script>', open) + '</script>'.length
  const body = html.lastIndexOf('</body>')
  if (end < '</script>'.length || body < end) return html
  return html.slice(0, open) + html.slice(end, body) + html.slice(open, end) + '\n  ' + html.slice(body)
}

/** Build only, after viteSingleFile has inlined the scripts (its generateBundle runs first: same order, earlier). */
function moduleLast(): Plugin {
  return {
    name: 'module-after-body',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === 'asset' && file.fileName.endsWith('.html') && typeof file.source === 'string') file.source = moduleAfterBody(file.source)
      }
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), brand(), notices(), regionPack(mode), wllamaRuntime(), viteSingleFile(), moduleLast(), isolation()],
  worker: { plugins: () => [workerNotices()] },
  build: { outDir: mode === 'pilot' ? 'dist-pilot' : 'dist' },
}))
