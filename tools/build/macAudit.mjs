#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It checks the macOS app before it is published: the universal .app, its .dmg and its zip
 * that the build matrix makes (tools/build/matrix.mjs macos-universal), carrying Sloane's model with its licence and
 * notice, and the binary inside, which runs that model in the app's own process (src-tauri/src/runner.rs over
 * native/llm: llama.cpp, statically linked into both slices). It is linuxAudit.mjs's twin for Mach-O, and takes that
 * file's lists of what must not be inside (download, Hugging Face cache, HTTP and subprocess code of llama.cpp's common
 * library, cpp-httplib, OpenSSL, curl, network calls), so the two platforms are held to the same list. Six commands,
 * each exiting 1 with every problem named; `--app` takes the .app or the folder that holds it, and the binary is the
 * one its Info.plist names (CFBundleExecutable), or `--binary`:
 *   package --app <app> --file <model file> --bytes <n> [--dmg <file>] [--zip <file>]
 *     The .app holds Contents/Resources/models/<file> (where the runner looks: Tauri's resource folder) at exactly <n>
 *     bytes, with LICENSE and NOTICE beside it, and llama.cpp's LICENSE and NOTICE where src-tauri/tauri.model.conf.json
 *     puts them (bundle.macOS.files); no file is the tiny test model (tiny-a.gguf) and the binary does not hold its
 *     name, unless <file> is that model. The .dmg is attached read-only (hdiutil attach -readonly -nobrowse) and its
 *     .app checked the same way, then detached; the zip is listed (unzip -l) and checked the same way. The .dmg and the
 *     zip are each larger than nine tenths of the model and under 2 GiB, GitHub's limit for one release asset.
 *   archs --app <app>
 *     lipo -archs lists both slices, arm64 and x86_64.
 *   libraries --app <app>
 *     otool -L, slice by slice: every library the binary loads is macOS's own (/System/Library/, /usr/lib/), or one
 *     an @rpath, @executable_path or @loader_path name finds inside the .app; none is OpenSSL, curl or OpenMP. So no
 *     Homebrew library (/opt/homebrew, /usr/local) is needed on the person's Mac.
 *   minos --app <app> [--max 11.0]
 *     otool -l, slice by slice: the LC_BUILD_VERSION minos (or an older LC_VERSION_MIN_MACOSX) is at most the macOS the
 *     app promises (src-tauri/tauri.conf.json bundle.macOS.minimumSystemVersion).
 *   symbols --app <app> --map <arm64 map> --map <x86_64 map>
 *     The binary is stripped, so Apple's linker writes a map per slice (src-tauri/build.rs, -map): the objects it
 *     linked and the symbols it kept, apart from those it dead-stripped. The run fails when a kept symbol from
 *     llama.cpp's archive is one of linuxAudit.mjs BANNED_SYMBOLS, when a map is missing or names no llama.cpp archive,
 *     or when the two maps do not cover both slices. Then the binary itself: none of BANNED_STRINGS in its bytes, and
 *     no network call among either slice's imports (nm -u -m); process calls are printed, not refused (ggml's crash
 *     handler, switched off by GGML_NO_BACKTRACE in main.rs).
 *   slices --app <app> --target <src-tauri/target>
 *     The settings each slice was built with (tools/build/macos-slices.cmake): in llama.cpp's build output for each
 *     slice (cargo's output file of llama-cpp-sys-2's build script), the arm64 build includes Metal and uses no x86
 *     flag, and the x86_64 build includes no Metal and compiles ggml's CPU code with SSE4.2, AVX, AVX2, FMA, F16C and
 *     BMI2; in the binary (lipo -thin), the arm64 slice carries Metal's embedded shader library and the x86_64 slice
 *     carries none of it.
 * The tools are macOS's own (otool, lipo, nm, hdiutil, unzip), run with argument vectors, never a shell; OTOOL, LIPO and
 * NM name others (LLVM's llvm-otool, llvm-lipo and llvm-nm print as Apple's do), which src/macAudit.test.ts uses on
 * Linux. The map is read in both of Apple's forms of an archive member: classic ld64's `lib.rlib(member.o)`, which
 * ld64.lld also writes, and ld-prime's `lib.rlib[N](member.o)` (Xcode 15 on, the linker of the CI runner), which
 * only a fixture and ld64.lld's maps rewritten to it show here: no real ld-prime map has been read.
 * .github/workflows/build-matrix.yml runs every command in the macOS job after the build, before any upload.
 * What breaks if it is removed? A macOS app without the model, its licence or its notice, with one slice missing, a
 * Homebrew library, a newer macOS than promised, Metal in the Intel slice, or the download, HTTP or subprocess code of
 * llama.cpp's common library inside, would reach the release unseen.
 */
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BANNED_STRINGS, BANNED_SYMBOLS, NETWORK_IMPORTS, PROCESS_IMPORTS, TINY, bannedStrings, compareVersions } from './linuxAudit.mjs'
import { ASSET_LIMIT } from '../verify/site_budget.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const conf = (name) => JSON.parse(readFileSync(join(ROOT, 'src-tauri', name), 'utf8'))

/** The two slices of the universal binary, as lipo names them, and the Rust target each is built for. */
export const ARCHS = Object.freeze(['arm64', 'x86_64'])
export const TRIPLES = Object.freeze({ arm64: 'aarch64-apple-darwin', x86_64: 'x86_64-apple-darwin' })
/** Where the runner looks for the carried model in the .app: `models/` in Tauri's resource folder. */
export const MODEL_DIR = 'Contents/Resources/models/'
/** llama.cpp's LICENSE and NOTICE in the .app, where the model overlay puts them (bundle.macOS.files, under Contents/). */
export const MAC_FILES = Object.freeze(Object.keys(conf('tauri.model.conf.json').bundle.macOS.files).map((p) => `Contents/${p.replace(/^\//, '')}`).sort())
/** The macOS the app promises (bundle.macOS.minimumSystemVersion): no slice may need a newer one. */
export const MINIMUM = conf('tauri.conf.json').bundle.macOS.minimumSystemVersion
/** GitHub refuses a release asset of 2 GiB or more: the number is tools/verify/site_budget.mjs's, which every release
 * workflow runs on the files it uploads. */
export { ASSET_LIMIT }
/** Where macOS keeps its own libraries, which every Mac has. */
export const SYSTEM_PREFIXES = Object.freeze(['/System/Library/', '/usr/lib/'])
/** Libraries the binary must not load, wherever they are. */
export const BANNED_LIBRARIES = /\/lib(?:ssl|crypto|curl|gomp|omp)\b[^/]*$/
/** Strings only Metal's backend holds: its log line for the embedded library, and a kernel of its shader source. */
export const METAL_MARKERS = Object.freeze(['using embedded metal library', 'kernel_mul_mv_q4_K_f32'])
/** The flags tools/build/macos-slices.cmake turns on for ggml's CPU code in the Intel slice, as CMake prints them. */
export const X86_FLAGS = Object.freeze(['-msse4.2', '-mf16c', '-mfma', '-mbmi2', '-mavx', '-mavx2'])

// ---- Pure: listings and package checks ----------------------------------------------------------------------------

/**
 * Pure. The entries of `unzip -l` (Info-ZIP: size, date in either order, time, path): each with its size and whether
 * it is a folder (a path ending in /). Lines that are not entries are skipped.
 */
export function parseZipListing(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\s*(\d+)\s+(?:\d\d-\d\d-\d{4}|\d{4}-\d\d-\d\d)\s+\d\d:\d\d\s+(.+)$/.exec(line)
    if (m) out.push({ path: m[2].replace(/\/$/, ''), size: Number(m[1]), dir: m[2].endsWith('/') })
  }
  return out
}

/** Pure. The entries below one .app (`<name>.app/...`), as paths inside it; everything else is left out. */
export function insideApp(entries, app) {
  const prefix = `${app}/`
  return entries.filter((e) => e.path.startsWith(prefix)).map((e) => ({ ...e, path: e.path.slice(prefix.length) }))
}

/**
 * Pure. What is wrong with one .app, given its entries (paths inside it): the model at MODEL_DIR<file> at exactly
 * `bytes`, LICENSE and NOTICE beside it (not empty), llama.cpp's texts (`files`) where the overlay puts them (not
 * empty), and no tiny test model in it unless `file` is that model.
 */
export function appProblems(name, entries, { file, bytes, files = MAC_FILES }) {
  const problems = []
  const at = new Map(entries.filter((e) => !e.dir).map((e) => [e.path, e]))
  const model = at.get(`${MODEL_DIR}${file}`)
  if (!model) problems.push(`${name}: no ${MODEL_DIR}${file} (the runner looks for the model there)`)
  else if (model.size !== bytes) problems.push(`${name}: ${MODEL_DIR}${file} is ${model.size} bytes; the pin says ${bytes}`)
  for (const f of ['LICENSE', 'NOTICE']) {
    const e = at.get(`${MODEL_DIR}${f}`)
    if (!e) problems.push(`${name}: no ${MODEL_DIR}${f} beside the model`)
    else if (e.size === 0) problems.push(`${name}: ${MODEL_DIR}${f} is empty`)
  }
  for (const f of files) {
    const e = at.get(f)
    if (!e) problems.push(`${name}: no ${f} (llama.cpp, compiled into the app, travels with its licence)`)
    else if (e.size === 0) problems.push(`${name}: ${f} is empty`)
  }
  if (file !== TINY) {
    for (const e of entries) if (basename(e.path) === TINY) problems.push(`${name}: holds the tiny test model (${e.path}), which only the end-to-end test's build carries`)
  }
  return problems
}

/** Pure. A file to publish (the .dmg, the zip): big enough to hold the model, and under GitHub's limit for one asset. */
export function assetProblems(name, size, bytes) {
  const problems = []
  if (!(size > Math.floor((bytes / 10) * 9))) problems.push(`${name} is ${size} bytes: it cannot carry the ${bytes}-byte model`)
  if (size >= ASSET_LIMIT) problems.push(`${name} is ${size} bytes: GitHub takes no release asset of 2 GiB (${ASSET_LIMIT} bytes) or more`)
  return problems
}

/** Pure. The executable an Info.plist names (CFBundleExecutable), or null. */
export function bundleExecutable(plist) {
  return /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1] ?? null
}

// ---- Pure: the binary ---------------------------------------------------------------------------------------------

/** Pure. The architectures `lipo -archs` prints. */
export function parseLipoArchs(text) {
  return text.trim().split(/\s+/).filter(Boolean)
}

/** Pure. Each slice the universal binary must have and does not. */
export function archProblems(name, archs) {
  return ARCHS.filter((a) => !archs.includes(a)).map((a) => `${name} has no ${a} slice (lipo -archs: ${archs.join(' ') || 'none'})`)
}

/** Pure. The libraries `otool -L` lists for one slice (each indented line's path; the first line names the file). */
export function parseOtoolLibraries(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^\s+(.+?) \(compatibility version [^,]+, current version [^)]+\)\s*$/.exec(line)
    if (m) out.push(m[1])
  }
  return out
}

/**
 * Pure. What is wrong with the libraries one slice loads: anything outside SYSTEM_PREFIXES that is not found inside
 * the .app (`inApp`, asked for an @rpath, @executable_path or @loader_path name), and any of BANNED_LIBRARIES.
 */
export function libraryProblems(name, arch, libs, inApp = () => false) {
  const problems = []
  if (libs.length === 0) problems.push(`${name} (${arch}): otool -L lists no library: not a macOS executable`)
  for (const lib of libs) {
    if (BANNED_LIBRARIES.test(lib)) problems.push(`${name} (${arch}) loads ${lib}`)
    else if (/^@(rpath|executable_path|loader_path)\//.test(lib)) {
      if (!inApp(lib)) problems.push(`${name} (${arch}) loads ${lib}, which is not inside the app`)
    } else if (!SYSTEM_PREFIXES.some((p) => lib.startsWith(p))) problems.push(`${name} (${arch}) loads ${lib}, which is not part of macOS (a Mac without it cannot start the app)`)
  }
  return problems
}

/**
 * Pure. The lowest macOS each version load command of `otool -l` names: LC_BUILD_VERSION's minos, or the older
 * LC_VERSION_MIN_MACOSX's version.
 */
export function parseMinimums(text) {
  const out = []
  for (const block of text.split(/\nLoad command \d+\n/).slice(1)) {
    const cmd = /^\s*cmd (\S+)/m.exec(block)?.[1]
    if (cmd === 'LC_BUILD_VERSION') {
      const v = /^\s*minos (\S+)/m.exec(block)?.[1]
      if (v) out.push({ cmd, version: v })
    } else if (cmd === 'LC_VERSION_MIN_MACOSX') {
      const v = /^\s*version (\S+)/m.exec(block)?.[1]
      if (v) out.push({ cmd, version: v })
    }
  }
  return out
}

/** Pure. A slice that names no lowest macOS, or one newer than `max`. */
export function minimumProblems(name, arch, found, max = MINIMUM) {
  if (found.length === 0) return [`${name} (${arch}) names no lowest macOS (no LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX)`]
  return found.filter((f) => compareVersions(f.version, max) > 0).map((f) => `${name} (${arch}) needs macOS ${f.version} (${f.cmd}), newer than the ${max} the app promises`)
}

/** Pure. A Mach-O symbol's name as C or the linker of another system writes it: one leading underscore fewer. */
export function machoName(sym) {
  return sym.startsWith('_') ? sym.slice(1) : sym
}

/**
 * Pure. An Apple linker map (`-map`: classic ld64, ld-prime and ld64.lld): its architecture, its object files by index
 * (`[  2] /path/lib.rlib(member.o)` from classic ld64 and ld64.lld, `[  2] /path/lib.rlib[12](member.o)` from ld-prime,
 * Xcode 15 on), the symbols it kept (`0xaddr 0xsize [  2] _name`) and how many it dead-stripped (listed after
 * `# Dead Stripped Symbols:`, which are left out).
 */
export function parseLinkerMap(text) {
  const objects = new Map()
  const kept = []
  let arch = null
  let section = null
  let dead = 0
  for (const line of text.split('\n')) {
    const a = /^# Arch: (\S+)/.exec(line)
    if (a) { arch = a[1]; continue }
    if (/^# Object files:/.test(line)) { section = 'objects'; continue }
    if (/^# Sections:/.test(line)) { section = 'sections'; continue }
    if (/^# Symbols:/.test(line)) { section = 'symbols'; continue }
    if (/^# Dead Stripped Symbols:/.test(line)) { section = 'dead'; continue }
    if (section === 'objects') {
      const m = /^\[\s*(\d+)\]\s+(.+)$/.exec(line)
      if (m) objects.set(Number(m[1]), m[2])
    } else if (section === 'symbols') {
      const m = /^0x[0-9A-Fa-f]+\s+0x[0-9A-Fa-f]+\s+\[\s*(\d+)\]\s+(.+)$/.exec(line)
      if (m) kept.push({ file: Number(m[1]), name: m[2] })
    } else if (section === 'dead' && /^<<dead>>/.test(line)) dead++
  }
  return { arch, objects, kept, dead }
}

/**
 * Pure. The archive an object file of a map comes from, or null: `/path/libx.rlib(member.o)` (classic ld64, ld64.lld)
 * and `/path/libx.rlib[12](member.o)` (ld-prime: the member's index, after a fat archive's slice, `libx.a[arm64][2]`)
 * both give libx.rlib.
 */
export function archiveOf(object) {
  const m = /^(.*\.(?:a|rlib))(?:\[[^[\]()]+\])*\(([^()]+)\)$/.exec(object)
  return m ? { archive: basename(m[1]), member: m[2] } : null
}

/** Pure. llama.cpp's archives among a map's objects (the llama-cpp-sys-2 rlib, or a libllama or libggml archive). */
export function llamaArchives(map) {
  return [...new Set([...map.objects.values()].map(archiveOf).filter((o) => o && /llama|ggml|httplib/.test(o.archive)).map((o) => o.archive))]
}

/**
 * Pure. The banned symbols a map says the link kept from llama.cpp's archives, as `<archive>(<member>) <symbol>`.
 * The map also lists kept string literals (`literal string: ...`); those are not symbols, and the strings scan of the
 * binary covers them, as linuxAudit.mjs does.
 */
export function keptBannedInMap(map) {
  const out = []
  for (const s of map.kept) {
    if (s.name.startsWith('literal string: ')) continue
    const o = archiveOf(map.objects.get(s.file) ?? '')
    if (o && /llama|ggml|httplib/.test(o.archive) && BANNED_SYMBOLS.test(machoName(s.name))) out.push(`${o.archive}(${o.member}) ${s.name}`)
  }
  return out
}

/** Pure. The undefined symbols `nm -u -m` (or plain `nm -u`) lists, without their leading underscore. */
export function parseUndefined(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /\(undefined\) (?:weak )?external (\S+)/.exec(line) ?? /^\s*(_\S+)\s*$/.exec(line)
    if (m) out.push(machoName(m[1]))
  }
  return out
}

/**
 * Pure. What llama.cpp's build printed for one slice (the build script's output): the CPU variant's flags
 * ("Adding CPU backend variant ggml-cpu: <flags> <definitions>"), whether Metal was included ("Including METAL
 * backend"), and macos-slices.cmake's own line.
 */
export function parseSliceBuild(text) {
  const variant = /^-- Adding CPU backend variant ggml-cpu:(.*)$/m.exec(text)
  const flags = variant ? variant[1].trim().split(/[\s;]+/).filter((f) => f.startsWith('-m')) : null
  return { flags, metal: /^-- Including METAL backend$/m.test(text), slices: /^-- crimson-noir macos-slices: (.*)$/m.exec(text)?.[1] ?? null }
}

/** Pure. A slice built otherwise than macos-slices.cmake says: Metal and no x86 flag in arm64, the reverse in x86_64. */
export function sliceBuildProblems(arch, build) {
  const problems = []
  if (build.flags === null) return [`${arch}: llama.cpp's build output has no CPU backend line (not the output of its CMake build)`]
  if (!build.slices) problems.push(`${arch}: llama.cpp was built without tools/build/macos-slices.cmake (no line of its own in the build output)`)
  const x86 = build.flags.filter((f) => X86_FLAGS.includes(f))
  if (arch === 'arm64') {
    if (!build.metal) problems.push('arm64: llama.cpp was built without Metal, which the plan uses on Apple silicon')
    if (x86.length) problems.push(`arm64: ggml's CPU code was built with x86 flags (${x86.join(' ')})`)
  } else {
    if (build.metal) problems.push('x86_64: llama.cpp was built with Metal, which the Intel slice must not start')
    const missing = X86_FLAGS.filter((f) => !build.flags.includes(f))
    if (missing.length) problems.push(`x86_64: ggml's CPU code was built without ${missing.join(' ')} (baseline code on an Intel Mac)`)
  }
  return problems
}

/** Pure. A slice's bytes against Metal's markers: all of them in arm64, none in x86_64. */
export function sliceBinaryProblems(arch, bytes) {
  const held = METAL_MARKERS.filter((s) => bytes.includes(Buffer.from(s)))
  if (arch === 'arm64' && held.length !== METAL_MARKERS.length) return [`arm64 slice: no Metal shader library inside (holds ${held.length} of ${METAL_MARKERS.length} of its strings)`]
  if (arch === 'x86_64' && held.length) return [`x86_64 slice: holds Metal (${held.map((s) => JSON.stringify(s)).join(', ')})`]
  return []
}

/**
 * Pure. hdiutil's arguments to attach the .dmg where the check reads it: read-only (nothing is written to the file
 * that is then uploaded), not shown in the Finder, not opened, at a folder of the check's own; and to detach it.
 */
export function attachArgs(dmg, mount) {
  return ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, dmg]
}
export function detachArgs(mount) {
  return ['detach', mount, '-force']
}

// ---- Running the tools --------------------------------------------------------------------------------------------

const TOOL = { otool: process.env.OTOOL || 'otool', lipo: process.env.LIPO || 'lipo', nm: process.env.NM || 'nm' }

function run(cmd, argv) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  if (r.error) throw new Error(`${cmd} could not run (${r.error.message})`)
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}`)
  return r.stdout
}

/** The .app a path names: itself, or the one .app directly inside it. */
export function findApp(path) {
  const p = resolve(path)
  if (p.endsWith('.app') && statSync(p).isDirectory()) return p
  const apps = readdirSync(p).filter((n) => n.endsWith('.app') && statSync(join(p, n)).isDirectory())
  if (apps.length !== 1) throw new Error(`expected one .app in ${p}, found ${apps.length}`)
  return join(p, apps[0])
}

/** Every entry below `dir` (links not followed), as paths inside it. */
function entriesOf(dir, rel = '') {
  const out = []
  for (const n of readdirSync(join(dir, rel))) {
    const path = rel ? `${rel}/${n}` : n
    const st = lstatSync(join(dir, path))
    out.push({ path, size: st.isFile() ? st.size : 0, dir: st.isDirectory() })
    if (st.isDirectory()) out.push(...entriesOf(dir, path))
  }
  return out
}

/** The binary to check: --binary, or the executable the --app's Info.plist names. */
function binaryOf(args) {
  if (args.one('binary')) return resolve(args.one('binary'))
  if (!args.one('app')) throw new Error('give --app (or --binary)')
  const app = findApp(args.one('app'))
  const exe = bundleExecutable(readFileSync(join(app, 'Contents', 'Info.plist'), 'utf8'))
  if (!exe) throw new Error(`${join(app, 'Contents', 'Info.plist')} names no CFBundleExecutable`)
  return join(app, 'Contents', 'MacOS', exe)
}

function packageOne(label, app, { file, bytes }) {
  const entries = entriesOf(app)
  const model = entries.find((e) => e.path === `${MODEL_DIR}${file}`)
  console.log(`${label}: ${entries.length} entries; ${MODEL_DIR}${file} ${model ? `${model.size} bytes` : 'missing'}`)
  return appProblems(label, entries, { file, bytes })
}

async function packageCmd(args) {
  const file = args.one('file')
  const bytes = Number(args.one('bytes'))
  if (!args.one('app') || !file || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('package needs --app, --file and --bytes')
  const app = findApp(args.one('app'))
  const problems = packageOne(basename(app), app, { file, bytes })
  if (file !== TINY) {
    const bin = binaryOf(args)
    const holds = readFileSync(bin).includes(Buffer.from(TINY))
    console.log(`binary ${bin}: ${holds ? 'holds' : 'does not hold'} the name ${TINY}`)
    if (holds) problems.push(`${bin} holds the name ${TINY}: a binary of the end-to-end test's build`)
  }
  for (const zip of args.get('zip')) {
    const size = statSync(zip).size
    const entries = insideApp(parseZipListing(run('unzip', ['-l', zip])), basename(app))
    console.log(`zip ${basename(zip)}: ${size} bytes, ${entries.length} entries in ${basename(app)}`)
    problems.push(...appProblems(basename(zip), entries, { file, bytes }), ...assetProblems(basename(zip), size, bytes))
  }
  for (const dmg of args.get('dmg')) {
    const size = statSync(dmg).size
    problems.push(...assetProblems(basename(dmg), size, bytes))
    const mount = mkdtempSync(join(tmpdir(), 'mac-audit-dmg-'))
    run('hdiutil', attachArgs(dmg, mount))
    try {
      console.log(`dmg ${basename(dmg)}: ${size} bytes, attached at ${mount}`)
      problems.push(...packageOne(`${basename(dmg)}: ${basename(app)}`, join(mount, basename(app)), { file, bytes }))
    } finally {
      spawnSync('hdiutil', detachArgs(mount), { encoding: 'utf8' })
      rmSync(mount, { recursive: true, force: true })
    }
  }
  return problems
}

async function archsCmd(args) {
  const bin = binaryOf(args)
  const archs = parseLipoArchs(run(TOOL.lipo, ['-archs', bin]))
  console.log(`${basename(bin)}: slices ${archs.join(' ')}`)
  return archProblems(basename(bin), archs)
}

async function librariesCmd(args) {
  const bin = binaryOf(args)
  // @executable_path is Contents/MacOS; an @rpath name is looked for in the app's Frameworks folder.
  const contents = dirname(dirname(bin))
  const inApp = (lib) => {
    const rest = lib.replace(/^@(rpath|executable_path|loader_path)\//, '')
    const where = lib.startsWith('@rpath/') ? join(contents, 'Frameworks', rest) : join(dirname(bin), rest)
    return resolve(where).startsWith(`${contents}/`) && statSync(where, { throwIfNoEntry: false })?.isFile() === true
  }
  const problems = []
  for (const arch of ARCHS) {
    const libs = parseOtoolLibraries(run(TOOL.otool, ['-arch', arch, '-L', bin]))
    console.log(`${basename(bin)} (${arch}) loads ${libs.join(', ')}`)
    problems.push(...libraryProblems(basename(bin), arch, libs, inApp))
  }
  return problems
}

async function minosCmd(args) {
  const bin = binaryOf(args)
  const max = args.one('max') ?? MINIMUM
  const problems = []
  for (const arch of ARCHS) {
    const found = parseMinimums(run(TOOL.otool, ['-arch', arch, '-l', bin]))
    console.log(`${basename(bin)} (${arch}): lowest macOS ${found.map((f) => `${f.version} (${f.cmd})`).join(', ') || 'none named'}; the app promises ${max}`)
    problems.push(...minimumProblems(basename(bin), arch, found, max))
  }
  return problems
}

async function symbolsCmd(args) {
  const bin = binaryOf(args)
  const maps = args.get('map')
  if (maps.length === 0) throw new Error('symbols needs a --map for each slice')
  const problems = []
  const covered = new Set()
  for (const file of maps) {
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) { problems.push(`${file}: no linker map there (src-tauri/build.rs writes one where the runner is compiled)`); continue }
    const map = parseLinkerMap(readFileSync(file, 'utf8'))
    if (map.arch) covered.add(map.arch)
    const llama = llamaArchives(map)
    const hits = keptBannedInMap(map)
    console.log(`${basename(file)} (${map.arch ?? 'no arch'}): ${map.objects.size} objects, ${map.kept.length} symbols kept, ${map.dead} dead-stripped; llama.cpp archives ${llama.join(', ') || 'none'}; ${hits.length} download, HTTP or subprocess symbols of theirs kept`)
    if (!map.arch) problems.push(`${file} names no architecture: not an Apple linker map`)
    if (llama.length === 0) problems.push(`${file} names no llama.cpp archive: this slice was linked without the runner`)
    for (const h of hits.slice(0, 20)) problems.push(`kept in the ${map.arch} slice: ${h}`)
    if (hits.length > 20) problems.push(`and ${hits.length - 20} more kept banned symbols in the ${map.arch} slice`)
  }
  for (const arch of ARCHS) if (!covered.has(arch)) problems.push(`no linker map for the ${arch} slice among ${maps.join(', ')}`)
  const strings = bannedStrings(readFileSync(bin))
  console.log(`${basename(bin)}: ${strings.length} of ${BANNED_STRINGS.length} banned strings`)
  for (const s of strings) problems.push(`${basename(bin)} holds the string ${JSON.stringify(s)} of llama.cpp's download or HTTP code`)
  for (const arch of ARCHS) {
    const und = parseUndefined(run(TOOL.nm, ['-u', '-m', '-arch', arch, bin]))
    const net = [...new Set(und.filter((n) => NETWORK_IMPORTS.test(n)))]
    const proc = [...new Set(und.filter((n) => PROCESS_IMPORTS.test(n)))].sort()
    console.log(`${basename(bin)} (${arch}): ${und.length} imports; network imports: ${net.join(', ') || 'none'}; process imports (printed only): ${proc.join(', ') || 'none'}`)
    for (const n of net) problems.push(`${basename(bin)} (${arch}) imports ${n}: a network call`)
  }
  return problems
}

/** The newest output file of llama-cpp-sys-2's build script for one Rust target under `target`. */
function sliceOutput(target, triple) {
  const dir = join(target, triple, 'release', 'build')
  const outs = (statSync(dir, { throwIfNoEntry: false })?.isDirectory() ? readdirSync(dir) : [])
    .filter((n) => n.startsWith('llama-cpp-sys-2-'))
    .map((n) => join(dir, n, 'output'))
    .filter((p) => statSync(p, { throwIfNoEntry: false })?.isFile())
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  return outs[0] ?? null
}

async function slicesCmd(args) {
  const bin = binaryOf(args)
  if (!args.one('target')) throw new Error('slices needs --target (src-tauri/target)')
  const target = resolve(args.one('target'))
  const problems = []
  const tmp = mkdtempSync(join(tmpdir(), 'mac-audit-slice-'))
  args.cleanup.push(tmp)
  for (const arch of ARCHS) {
    const output = sliceOutput(target, TRIPLES[arch])
    if (!output) { problems.push(`${arch}: no build output of llama-cpp-sys-2 under ${join(target, TRIPLES[arch])}`); continue }
    const build = parseSliceBuild(readFileSync(output, 'utf8'))
    console.log(`${arch} build (${output}): ${build.slices ?? 'no macos-slices line'}; Metal ${build.metal ? 'included' : 'not included'}; CPU flags ${build.flags?.join(' ') || 'none'}`)
    problems.push(...sliceBuildProblems(arch, build))
    const thin = join(tmp, arch)
    run(TOOL.lipo, [bin, '-thin', arch, '-output', thin])
    const bytes = readFileSync(thin)
    console.log(`${arch} slice: ${bytes.length} bytes; Metal's strings: ${METAL_MARKERS.filter((s) => bytes.includes(Buffer.from(s))).length} of ${METAL_MARKERS.length}`)
    problems.push(...sliceBinaryProblems(arch, bytes))
  }
  return problems
}

/** The command line: repeated flags kept in order. */
function parseArgs(argv) {
  const flags = new Map()
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue
    const k = argv[i].slice(2)
    flags.set(k, [...(flags.get(k) ?? []), argv[i + 1]])
    i++
  }
  return { get: (k) => flags.get(k) ?? [], one: (k) => flags.get(k)?.[0], cleanup: [] }
}

export const USAGE = 'usage: node tools/build/macAudit.mjs package --app <app> --file <model> --bytes <n> [--dmg <file>] [--zip <file>] | archs --app <app> | libraries --app <app> | minos --app <app> [--max 11.0] | symbols --app <app> --map <file> --map <file> | slices --app <app> --target <dir>'

export async function main(argv) {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  const commands = { package: packageCmd, archs: archsCmd, libraries: librariesCmd, minos: minosCmd, symbols: symbolsCmd, slices: slicesCmd }
  if (!Object.hasOwn(commands, command)) {
    console.error(USAGE)
    return 2
  }
  try {
    const problems = await commands[command](args)
    for (const p of problems) console.error(`::error::${p}`)
    console.log(problems.length === 0 ? `${command}: every check passed` : `${command}: ${problems.length} problem${problems.length === 1 ? '' : 's'}`)
    return problems.length === 0 ? 0 : 1
  } catch (e) {
    console.error(`::error::${command}: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  } finally {
    for (const d of args.cleanup) rmSync(d, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main(process.argv.slice(2))
