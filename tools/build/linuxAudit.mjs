#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It checks the Linux app's packages before they are published: the .deb, the .rpm and the
 * .AppImage the build matrix makes (tools/build/matrix.mjs), each carrying Sloane's model with its licence and notice,
 * and the binary inside them, which runs that model in the app's own process (src-tauri/src/runner.rs over native/llm:
 * llama.cpp, statically linked). Three checks, each a command that exits 1 with every problem named:
 *   node tools/build/linuxAudit.mjs packages --dir <folder> --file <model file> --bytes <n> [--kinds deb,rpm,appimage]
 *                                            [--binary <file>]...
 *     Each package holds usr/lib/<product>/models/<file> (the resource folder the runner looks in: tauri.conf.json's
 *     productName) at exactly <n> bytes, with LICENSE and NOTICE beside it, and llama.cpp's LICENSE and NOTICE where
 *     src-tauri/tauri.model.conf.json puts them for every Linux package (usr/share/doc/...), and the notices of the
 *     Rust crates the app is built with (usr/lib/<product>/licenses/RUST-CRATES.txt, at the committed file's size);
 *     each is larger than nine tenths of the model;
 *     no package lists the tiny test model (tiny-a.gguf) and no binary (the one inside the .deb, and each --binary)
 *     holds its name, unless <file> is that model (the end-to-end rehearsal's build). The .deb is listed with
 *     dpkg-deb -c, the .rpm with rpm -qp, and the AppImage's squashfs with unsquashfs -lls at the offset its ELF
 *     runtime ends (read from the ELF header here, so nothing in the AppImage is run).
 *   node tools/build/linuxAudit.mjs glibc --deb <file> [--glibc 2.35] [--glibcxx 3.4.30] [--cxxabi 1.3.13]
 *     Every ELF file the .deb installs: the highest GLIBC_, GLIBCXX_ and CXXABI_ version its version-needs table
 *     requires (objdump -p; that table is what the loader checks, and objdump -T names the symbols behind each
 *     version), weak references included: the linker records a weak reference's version there as a hard need (GNU ld
 *     and lld alike), and the loader will not start a file that needs a version its library lacks. Only an entry
 *     flagged weak (VER_FLG_WEAK, which neither linker sets) is left out. A failure above the floor given, by default
 *     Ubuntu 22.04's (glibc 2.35, libstdc++ of GCC 12), so the app starts on Ubuntu 22.04 and Debian 12 and later.
 *   node tools/build/linuxAudit.mjs symbols --deb <file> --map <link map> [--deps <dir>] [--binary <file>]...
 *     The shipped binary is stripped, so the linker's map (src-tauri/build.rs writes it beside the executable) says which
 *     sections of llama.cpp's static libraries it kept, and objdump -t on those libraries (the llama-cpp-sys-2 rlib
 *     the map names, found in --deps) says which symbols each section holds: the run fails when a kept section holds
 *     a symbol of llama.cpp's common library's download, Hugging Face cache, Docker, HTTP or subprocess code, or of
 *     cpp-httplib, OpenSSL or curl. Then the binary itself: none of those parts' distinctive strings (read with the
 *     crates' notices set aside: the binary holds them whole, and they name those parts' licence files), no import of
 *     a network call (socket, connect, getaddrinfo...), and no OpenSSL, curl or OpenMP library among those it needs.
 *     The process calls it imports (fork, exec, posix_spawn) are printed, not refused: ggml's crash handler forks a
 *     debugger unless GGML_NO_BACKTRACE is set, which src-tauri/src/main.rs sets before anything else runs.
 * .github/workflows/build-matrix.yml runs all three in the Linux jobs after the build. Programs run with argument
 * vectors, never a shell; the .deb is unpacked without its .gguf files, so no copy of the model is made.
 * What breaks if it is removed? A package without the model, its licence or its notice, a binary that needs a newer
 * glibc than the distributions it is published for, or one that carries the download, HTTP or subprocess code of
 * llama.cpp's common library, would reach the release unseen.
 */
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The app's product name (src-tauri/tauri.conf.json): Tauri installs the resources under usr/lib/<it>/. */
export const PRODUCT = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).productName
/** The tiny test model (tools/browser/tinyGguf.mjs), which only the end-to-end test's build carries. */
export const TINY = 'tiny-a.gguf'
/** The package kinds the Linux jobs make, and the file name each ends with. */
export const KINDS = Object.freeze({ deb: '.deb', rpm: '.rpm', appimage: '.AppImage' })
/** Ubuntu 22.04's: glibc 2.35, and the libstdc++ of GCC 12 (its libstdc++6). */
export const FLOOR = Object.freeze({ GLIBC: '2.35', GLIBCXX: '3.4.30', CXXABI: '1.3.13' })

/**
 * The files the model overlay (src-tauri/tauri.model.conf.json) adds to each Linux package beside its resources:
 * llama.cpp's LICENSE and NOTICE (third_party/llama.cpp/), at one path in the .deb, the .rpm and the AppImage. Each as
 * the installed path below the root.
 */
export const LINUX_FILES = Object.freeze(Object.keys(JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.model.conf.json'), 'utf8')).bundle.linux.deb.files)
  .map((p) => p.replace(/^\//, '')).sort())

/**
 * The notices of the Rust crates the app is built with (tools/license/notices.mjs writes them), which every package
 * carries among its resources: the path inside the resource folder (src-tauri/tauri.conf.json bundle.resources) and
 * the committed file's size, which the packaged copy must have.
 */
export const NOTICES = Object.freeze((() => {
  const resources = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).bundle.resources ?? {}
  const found = Object.entries(resources).find(([from]) => from.startsWith('notices/'))
  if (!found) throw new Error('src-tauri/tauri.conf.json names no notices/ file among bundle.resources')
  return { path: found[1], bytes: statSync(join(ROOT, 'src-tauri', found[0])).size }
})())

/** Where the runner looks for the carried model: `models/` in the resource folder, usr/lib/<product>/ once installed. */
export function modelDir(product = PRODUCT) {
  return `usr/lib/${product}/models/`
}

/** A listed path without its leading ./ or / or squashfs-root/, as the installed file's path below the root. */
function relPath(p) {
  return p.replace(/^squashfs-root\/?/, '').replace(/^\.?\//, '')
}

/**
 * Pure. The entries of a tar-style listing (dpkg-deb -c; unsquashfs -lls): mode, owner, size, date, time, path (a
 * path may hold spaces; a link's ` -> target` is dropped). Lines that are not entries are skipped.
 */
export function parseTarListing(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^([-dlcbps][-rwxsStT]{9})\s+\S+\s+(\d+)\s+\d{4}-\d\d-\d\d\s+\d\d:\d\d(?::\d\d)?\s+(.+)$/.exec(line)
    if (!m) continue
    const path = relPath(m[1].startsWith('l') ? m[3].replace(/ -> .*$/, '') : m[3])
    if (path) out.push({ path, size: Number(m[2]), dir: m[1].startsWith('d') })
  }
  return out
}

/** Pure. The entries of `rpm -qp --queryformat '[%{FILESIZES} %{FILEMODES:perms} %{FILENAMES}\n]'`. */
export function parseRpmListing(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^(\d+)\s+([-dlcbps][-rwxsStT]{9})\s+(\/.+)$/.exec(line)
    if (m) out.push({ path: relPath(m[3]), size: Number(m[1]), dir: m[2].startsWith('d') })
  }
  return out
}

/**
 * Pure. Where an AppImage's squashfs starts: the end of its ELF runtime, which is the end of the runtime's section
 * header table (e_shoff + e_shnum * e_shentsize), as the AppImage runtime itself computes it. Null for a file that is
 * not a little-endian ELF.
 */
export function appImageOffset(head) {
  if (head.length < 64 || head.readUInt32BE(0) !== 0x7f454c46 || head[5] !== 1) return null
  if (head[4] === 2) return Number(head.readBigUInt64LE(0x28)) + head.readUInt16LE(0x3a) * head.readUInt16LE(0x3c)
  if (head[4] === 1) return head.readUInt32LE(0x20) + head.readUInt16LE(0x2e) * head.readUInt16LE(0x30)
  return null
}

/**
 * Pure. What is wrong with one package, given its entries and its size: the model at `models/<file>` in the resource
 * folder at exactly `bytes`, LICENSE and NOTICE beside it (not empty), llama.cpp's texts (`files`) where the overlay
 * puts them (not empty), the Rust crates' notices (`notices`) in the resource folder at exactly the committed file's
 * size, the package larger than nine tenths of the model, and no tiny test model in it unless `file` is that model.
 */
export function packageProblems(name, entries, { file, bytes, size, product = PRODUCT, files = LINUX_FILES, notices = NOTICES }) {
  const problems = []
  const dir = modelDir(product)
  const at = new Map(entries.filter((e) => !e.dir).map((e) => [e.path, e]))
  const model = at.get(`${dir}${file}`)
  if (!model) problems.push(`${name}: no ${dir}${file} (the runner looks for the model there)`)
  else if (model.size !== bytes) problems.push(`${name}: ${dir}${file} is ${model.size} bytes; the pin says ${bytes}`)
  for (const f of ['LICENSE', 'NOTICE']) {
    const e = at.get(`${dir}${f}`)
    if (!e) problems.push(`${name}: no ${dir}${f} beside the model`)
    else if (e.size === 0) problems.push(`${name}: ${dir}${f} is empty`)
  }
  for (const f of files) {
    const e = at.get(f)
    if (!e) problems.push(`${name}: no ${f} (llama.cpp, compiled into the app, travels with its licence)`)
    else if (e.size === 0) problems.push(`${name}: ${f} is empty`)
  }
  const crates = `usr/lib/${product}/${notices.path}`
  const held = at.get(crates)
  if (!held) problems.push(`${name}: no ${crates} (the Rust crates the app is built with travel with their notices)`)
  else if (held.size !== notices.bytes) problems.push(`${name}: ${crates} is ${held.size} bytes; the committed notices are ${notices.bytes}`)
  if (!(size > Math.floor((bytes / 10) * 9))) problems.push(`${name} is ${size} bytes: it cannot carry the ${bytes}-byte model`)
  if (file !== TINY) {
    for (const e of entries) if (basename(e.path) === TINY) problems.push(`${name}: holds the tiny test model (${e.path}), which only the end-to-end test's build carries`)
  }
  return problems
}

/** Pure. Compares two dotted versions numerically (2.35 < 2.38 < 2.100). */
export function compareVersions(a, b) {
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d < 0 ? -1 : 1
  }
  return 0
}

/**
 * Pure. The dynamic symbols `objdump -T` lists: each with whether it is weak (the second flag column), its section
 * (*UND* for one the file needs), its version (GLIBC_2.38, with or without objdump's parentheses) and its name.
 */
export function parseDynamicSymbols(text) {
  const out = []
  for (const line of text.split('\n')) {
    const m = /^[0-9a-f]+ (.{7}) (\S+)\s+[0-9a-f]+\s+(?:\(?([A-Za-z][\w.]*?)\)?\s+)?(\S+)$/.exec(line)
    if (!m) continue
    out.push({ weak: m[1][1] === 'w', section: m[2], version: m[3] ?? null, name: m[4] })
  }
  return out
}

/** The flag of a version-needs entry the loader may do without (elf.h's VER_FLG_WEAK). GNU ld and lld never set it. */
export const VER_FLG_WEAK = 0x2

/**
 * Pure. The version-needs table (.gnu.version_r) as `objdump -p` prints it under "Version References": each entry
 * with the file that must define it, its flags and its version. The loader checks this table, not the symbols: an
 * entry whose version the file's library lacks stops the program from starting, unless it is flagged VER_FLG_WEAK.
 */
export function parseVersionRefs(text) {
  const out = []
  const start = text.indexOf('\nVersion References:')
  if (start < 0) return out
  let file = null
  for (const line of text.slice(start + 1).split('\n').slice(1)) {
    const from = /^\s+required from (.+):$/.exec(line)
    if (from) { file = from[1]; continue }
    const m = /^\s+0x[0-9a-f]+ 0x([0-9a-f]+) \d+ (\S+)$/.exec(line)
    if (m && file) { out.push({ file, flags: parseInt(m[1], 16), version: m[2] }); continue }
    if (line.trim() !== '') break
  }
  return out
}

/**
 * Pure. The highest GLIBC_, GLIBCXX_ and CXXABI_ version a file needs, each with the symbols that name it (the *UND*
 * ones, a weak one as `weak <name>`). The versions are those of the version-needs table (`refs`, parseVersionRefs),
 * which is what the loader checks: a weak reference's version counts, since the linker records it there as a hard
 * need, and only an entry flagged VER_FLG_WEAK is left out. A version a symbol names counts as well unless the table
 * flags it weak, so a table that could not be read still leaves the symbols' versions. A family the file never names
 * is absent.
 */
export function versionNeeds(symbols, refs = []) {
  const hard = new Set(refs.filter((r) => (r.flags & VER_FLG_WEAK) === 0).map((r) => r.version))
  const weak = new Set(refs.filter((r) => (r.flags & VER_FLG_WEAK) !== 0).map((r) => r.version))
  const named = new Map()
  for (const s of symbols) {
    if (s.section !== '*UND*' || !s.version) continue
    named.set(s.version, [...(named.get(s.version) ?? []), s.weak ? `weak ${s.name}` : s.name])
  }
  const top = {}
  for (const version of new Set([...hard, ...named.keys()])) {
    if (!hard.has(version) && weak.has(version)) continue
    const m = /^(GLIBC|GLIBCXX|CXXABI)_(\d+(?:\.\d+)+)$/.exec(version)
    if (!m) continue
    const [, family, v] = m
    const names = named.get(version) ?? []
    const t = top[family]
    if (!t || compareVersions(v, t.version) > 0) top[family] = { version: v, symbols: [...names] }
    else if (compareVersions(v, t.version) === 0) t.symbols.push(...names)
  }
  return top
}

/** Pure. Each family above its floor, as a sentence naming the version and the symbols that need it. */
export function floorProblems(name, needs, floor = FLOOR) {
  const problems = []
  for (const family of Object.keys(FLOOR)) {
    const t = needs[family]
    if (t && compareVersions(t.version, floor[family]) > 0) {
      const names = [...new Set(t.symbols)].slice(0, 6).join(', ') || 'in its version-needs table, named by no symbol'
      problems.push(`${name} needs ${family}_${t.version} (${names}), above the floor ${family}_${floor[family]}`)
    }
  }
  return problems
}

/**
 * The symbols of llama.cpp's common library and its vendored parts that must not be in the shipped binary: its model
 * download (from Hugging Face or a Docker registry), its Hugging Face cache, its HTTP client and cpp-httplib, its
 * subprocess support (sheredom/subprocess.h), and OpenSSL or curl should either ever be linked. Matched against the
 * raw (mangled) names, which hold each identifier as written.
 */
export const BANNED_SYMBOLS = /httplib|subprocess_|common_subproc|common_download|common_docker|common_http|common_pull_file|common_remote_get_content|common_list_cached_models|common_get_model_endpoint|hf_cache|\bcurl_|\bSSL_|\bOPENSSL_/
/** Strings only those parts hold (read from their objects in llama-cpp-sys-2 0.1.161's build). */
export const BANNED_STRINGS = Object.freeze([
  'cpp-httplib/', '--cpp-httplib-multipart-data-', 'https://huggingface.co/', 'HUGGINGFACE_HUB_CACHE', 'HF_TOKEN',
  'downloading from %s to %s', 'using cached file', 'failed to remove repo cache', 'Docker Model',
  'LLAMA_OPENSSL=ON', 'libcurl',
])
/** Network calls a binary must not import: the app reaches no address. */
export const NETWORK_IMPORTS = /^(socket|connect|getaddrinfo|getnameinfo|gethostbyname2?(_r)?|gethostbyaddr(_r)?|bind|listen|accept4?|curl_\w+|SSL_\w+)$/
/** Process calls, printed: ggml's crash handler (fork, execlp) and Rust's std::process (posix_spawnp, execvp). */
export const PROCESS_IMPORTS = /^(fork|vfork|execl|execlp|execle|execv|execvp|execvpe|execve|posix_spawnp?|system|popen)$/
/** Libraries the binary must not need. */
export const BANNED_NEEDED = /^lib(ssl|crypto|curl|gomp)\b/

/**
 * Pure. The input sections a linker map says it kept, as `<archive file name>(<member>):<section>`: lld's map
 * (`addr addr size align  /path/lib.rlib(member.o):(.text.name)`) and GNU ld's memory map (` .text.name  0x.. 0x..
 * /path/lib.a(member.o)`, the section on its own line when its name is long). GNU ld lists its discarded sections
 * first, under their own heading, and those are left out.
 */
export function keptSections(map) {
  const kept = new Set()
  const lld = /^\s*[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]+\s+\d+\s+(\S.*?)\(([^()]+)\):\((\S+)\)\s*$/
  const start = map.indexOf('Linker script and memory map')
  const gnu = start >= 0
  const lines = (gnu ? map.slice(start) : map).split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!gnu) {
      const m = lld.exec(line)
      if (m) kept.add(`${basename(m[1])}(${m[2]}):${m[3]}`)
      continue
    }
    let m = /^ (\.\S+)\s+0x[0-9a-f]+\s+0x[0-9a-f]+\s+(\S.*?)\(([^()]+)\)\s*$/.exec(line)
    if (!m && /^ \.\S+$/.test(line) && i + 1 < lines.length) {
      const next = /^\s+0x[0-9a-f]+\s+0x[0-9a-f]+\s+(\S.*?)\(([^()]+)\)\s*$/.exec(lines[i + 1])
      if (next) m = [null, line.trim(), next[1], next[2]]
    }
    if (m) kept.add(`${basename(m[2])}(${m[3]}):${m[1]}`)
  }
  return kept
}

/** Pure. The archives a map names (their file names), to find on disk. */
export function mapArchives(map) {
  return [...new Set([...map.matchAll(/(\/[^\s()]+\.(?:a|rlib))\(/g)].map((m) => m[1]))]
}

/**
 * Pure. The defined symbols `objdump -t <archive>` lists, each with its member and its section (`<member>:  file
 * format ...` heads each member's table).
 */
export function archiveSymbols(text) {
  const out = []
  let member = null
  for (const line of text.split('\n')) {
    const head = /^(\S+):\s+file format /.exec(line)
    if (head) { member = head[1]; continue }
    const m = /^[0-9a-f]+ .{7} (\S+)\s+[0-9a-f]+\s+(.+)$/.exec(line)
    // A section's own symbol (named as the section) says nothing more than the section.
    if (m && member && m[1] !== '*UND*' && m[1] !== '*ABS*' && m[2].trim() !== m[1]) out.push({ member, section: m[1], name: m[2].trim() })
  }
  return out
}

/**
 * Pure. The banned symbols the link kept: those defined in a section of a member the map says it kept, from the
 * named archive. Each as `<member> <section> <symbol>`.
 */
export function keptBanned(archive, symbols, kept) {
  return symbols.filter((s) => BANNED_SYMBOLS.test(s.name) && kept.has(`${archive}(${s.member}):${s.section}`)).map((s) => `${s.member} ${s.section} ${s.name}`)
}

/**
 * Pure. `bytes` with every whole copy of `text` cut out and one zero byte in its place, so nothing reads across the
 * cut. A copy that is not whole stays where it is.
 */
export function withoutCopies(bytes, text) {
  const needle = Buffer.isBuffer(text) ? text : Buffer.from(text)
  if (needle.length === 0) return bytes
  const parts = []
  let from = 0
  for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, from)) {
    parts.push(bytes.subarray(from, at), Buffer.alloc(1))
    from = at + needle.length
  }
  return from === 0 ? bytes : Buffer.concat([...parts, bytes.subarray(from)])
}

/**
 * Pure. Which of BANNED_STRINGS a binary's bytes hold. `notices`, when given, is the text the program is built to
 * hold whole (the crates' notices, src-tauri/src/notices.rs): each whole copy is set aside first. That text names
 * the licence files of the very parts this looks for (llama.cpp/vendor/cpp-httplib/LICENSE) and is no code of
 * theirs; ci holds it to the registry word for word, so nothing else can be put there. Anything outside a whole
 * copy is still read, a damaged copy included.
 */
export function bannedStrings(bytes, notices = null) {
  const read = notices ? withoutCopies(bytes, notices) : bytes
  return BANNED_STRINGS.filter((s) => read.includes(Buffer.from(s)))
}

/** The committed notices, as the program built from this commit holds them (tools/license/notices.mjs writes them). */
export const noticesBytes = () => readFileSync(join(ROOT, 'src-tauri', 'notices', 'RUST-CRATES.txt'))

// ---- Running the tools --------------------------------------------------------------------------------------------

function run(cmd, argv, { maxBuffer = 512 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, argv, { encoding: 'utf8', maxBuffer })
  if (r.error) throw new Error(`${cmd} could not run (${r.error.message})`)
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(0, 600)}`)
  return r.stdout
}

/** Unpacks a .deb's files into a new temporary folder, without its .gguf files (the model is never copied). */
async function unpackDeb(deb) {
  const dir = mkdtempSync(join(tmpdir(), 'linux-audit-'))
  const dpkg = spawn('dpkg-deb', ['--fsys-tarfile', deb], { stdio: ['ignore', 'pipe', 'inherit'] })
  const tar = spawn('tar', ['-x', '-C', dir, '--exclude=*.gguf', '-f', '-'], { stdio: ['pipe', 'inherit', 'inherit'] })
  dpkg.stdout.pipe(tar.stdin)
  const exit = (p) => new Promise((ok, no) => { p.on('error', no); p.on('close', ok) })
  const [a, b] = await Promise.all([exit(dpkg), exit(tar)])
  if (a !== 0 || b !== 0) throw new Error(`could not unpack ${deb} (dpkg-deb ${a}, tar ${b})`)
  return dir
}

/** The ELF files under `dir` (by their first four bytes). */
function elfFiles(dir) {
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    const st = statSync(p, { throwIfNoEntry: false })
    if (!st) continue
    if (st.isDirectory()) out.push(...elfFiles(p))
    else if (st.isFile() && st.size >= 4) {
      const fd = openSync(p, 'r')
      const head = Buffer.alloc(4)
      try { readSync(fd, head, 0, 4, 0) } finally { closeSync(fd) }
      if (head.readUInt32BE(0) === 0x7f454c46) out.push(p)
    }
  }
  return out
}

function listing(kind, file) {
  if (kind === 'deb') return parseTarListing(run('dpkg-deb', ['-c', file]))
  if (kind === 'rpm') return parseRpmListing(run('rpm', ['-qp', '--queryformat', '[%{FILESIZES} %{FILEMODES:perms} %{FILENAMES}\n]', file]))
  const fd = openSync(file, 'r')
  const head = Buffer.alloc(64)
  try { readSync(fd, head, 0, 64, 0) } finally { closeSync(fd) }
  const offset = appImageOffset(head)
  if (offset === null) throw new Error(`${basename(file)} is not an ELF AppImage`)
  const magic = Buffer.alloc(4)
  const fd2 = openSync(file, 'r')
  try { readSync(fd2, magic, 0, 4, offset) } finally { closeSync(fd2) }
  if (magic.toString('latin1') !== 'hsqs') throw new Error(`${basename(file)} has no squashfs at ${offset}, where its runtime ends`)
  return parseTarListing(run('unsquashfs', ['-o', String(offset), '-lls', file]))
}

async function packages(args) {
  const dir = resolve(args.one('dir'))
  const file = args.one('file')
  const bytes = Number(args.one('bytes'))
  if (!file || !Number.isSafeInteger(bytes) || bytes <= 0) throw new Error('packages needs --dir, --file and --bytes')
  const kinds = (args.get('kinds')[0] ?? 'deb,rpm,appimage').split(',').map((k) => k.trim()).filter(Boolean)
  const problems = []
  const names = readdirSync(dir)
  const binaries = args.get('binary').map((b) => resolve(b))
  for (const kind of kinds) {
    if (!KINDS[kind]) throw new Error(`--kinds takes ${Object.keys(KINDS).join(', ')}, not ${kind}`)
    const found = names.filter((n) => n.endsWith(KINDS[kind]))
    if (found.length !== 1) { problems.push(`expected one ${KINDS[kind]} in ${dir}, found ${found.length}`); continue }
    const path = join(dir, found[0])
    const entries = listing(kind, path)
    const size = statSync(path).size
    const model = entries.find((e) => e.path === `${modelDir()}${file}`)
    console.log(`${kind.padEnd(8)} ${found[0]}: ${size} bytes, ${entries.length} entries; ${modelDir()}${file} ${model ? `${model.size} bytes` : 'missing'}`)
    problems.push(...packageProblems(found[0], entries, { file, bytes, size }))
    if (kind === 'deb') {
      const unpacked = await unpackDeb(path)
      try { for (const elf of elfFiles(unpacked)) binaries.push(elf) } catch (e) { rmSync(unpacked, { recursive: true, force: true }); throw e }
      args.cleanup.push(unpacked)
    }
  }
  if (file !== TINY) {
    for (const b of binaries) {
      const holds = readFileSync(b).includes(Buffer.from(TINY))
      console.log(`binary   ${b}: ${holds ? 'holds' : 'does not hold'} the name ${TINY}`)
      if (holds) problems.push(`${b} holds the name ${TINY}: a binary of the end-to-end test's build`)
    }
  }
  return problems
}

async function glibc(args) {
  const deb = resolve(args.one('deb'))
  const floor = { GLIBC: args.one('glibc') ?? FLOOR.GLIBC, GLIBCXX: args.one('glibcxx') ?? FLOOR.GLIBCXX, CXXABI: args.one('cxxabi') ?? FLOOR.CXXABI }
  const dir = await unpackDeb(deb)
  args.cleanup.push(dir)
  const elves = elfFiles(dir)
  if (elves.length === 0) return [`${basename(deb)} installs no ELF file`]
  const problems = []
  for (const elf of elves) {
    const name = elf.slice(dir.length + 1)
    // The table the loader checks (objdump -p), and the symbols that name each version (objdump -T).
    const refs = parseVersionRefs(run('objdump', ['-p', elf]))
    const needs = versionNeeds(parseDynamicSymbols(run('objdump', ['-T', elf])), refs)
    const line = Object.keys(FLOOR).map((f) => `${f}_${needs[f]?.version ?? '-'}`).join(' ')
    console.log(`${name}: highest needs ${line}, from ${refs.length} version-needs entr${refs.length === 1 ? 'y' : 'ies'} (floor ${Object.keys(FLOOR).map((f) => `${f}_${floor[f]}`).join(' ')})`)
    problems.push(...floorProblems(name, needs, floor))
  }
  return problems
}

async function symbols(args) {
  if (!args.one('map') || (!args.one('deb') && args.get('binary').length === 0)) throw new Error('symbols needs --map and --deb (or --binary)')
  const mapFile = resolve(args.one('map'))
  const deps = args.one('deps') ? resolve(args.one('deps')) : join(dirname(mapFile), 'deps')
  const problems = []
  const map = readFileSync(mapFile, 'utf8')
  const kept = keptSections(map)
  if (kept.size === 0) return [`${mapFile} lists no kept section from any archive: not a linker map of the app`]
  const llama = mapArchives(map).filter((a) => /llama|ggml|httplib/.test(basename(a)))
  if (llama.length === 0) problems.push(`${mapFile} names no llama.cpp library: this binary was linked without the runner`)
  for (const a of [...new Set(llama.map((p) => basename(p)))]) {
    const onDisk = [llama.find((p) => basename(p) === a), join(deps, a)].find((p) => p && statSync(p, { throwIfNoEntry: false })?.isFile())
    if (!onDisk) { problems.push(`${a}, which the map names, is neither where the map says nor in ${deps}`); continue }
    const syms = archiveSymbols(run('objdump', ['-t', onDisk]))
    const members = new Set([...kept].filter((k) => k.startsWith(`${a}(`)).map((k) => k.slice(a.length + 1, k.indexOf('):'))))
    const hits = keptBanned(a, syms, kept)
    console.log(`${a}: ${members.size} members linked, ${[...kept].filter((k) => k.startsWith(`${a}(`)).length} sections kept; ${syms.filter((s) => BANNED_SYMBOLS.test(s.name)).length} download, HTTP or subprocess symbols defined in it, ${hits.length} of them kept`)
    for (const h of hits.slice(0, 20)) problems.push(`kept in the binary: ${h}`)
    if (hits.length > 20) problems.push(`and ${hits.length - 20} more kept banned symbols`)
  }
  // The binaries the .deb installs (the shipped ones), and any named by hand.
  const elves = args.get('binary').map((b) => ({ path: resolve(b), name: b }))
  if (args.one('deb')) {
    const deb = resolve(args.one('deb'))
    const dir = await unpackDeb(deb)
    args.cleanup.push(dir)
    const found = elfFiles(dir)
    if (found.length === 0) problems.push(`${basename(deb)} installs no ELF file`)
    elves.push(...found.map((p) => ({ path: p, name: p.slice(dir.length + 1) })))
  }
  const notices = noticesBytes()
  for (const { path: elf, name } of elves) {
    const strings = bannedStrings(readFileSync(elf), notices)
    const und = parseDynamicSymbols(run('objdump', ['-T', elf])).filter((s) => s.section === '*UND*').map((s) => s.name.replace(/@.*$/, ''))
    const net = [...new Set(und.filter((n) => NETWORK_IMPORTS.test(n)))]
    const proc = [...new Set(und.filter((n) => PROCESS_IMPORTS.test(n)))].sort()
    const needed = [...run('readelf', ['-d', elf]).matchAll(/\(NEEDED\)\s+Shared library: \[([^\]]+)\]/g)].map((m) => m[1])
    console.log(`${name}: ${strings.length} of ${BANNED_STRINGS.length} banned strings; network imports: ${net.join(', ') || 'none'}; process imports (printed only): ${proc.join(', ') || 'none'}; needs ${needed.join(' ')}`)
    for (const s of strings) problems.push(`${name} holds the string ${JSON.stringify(s)} of llama.cpp's download or HTTP code`)
    for (const n of net) problems.push(`${name} imports ${n}: a network call`)
    for (const n of needed.filter((l) => BANNED_NEEDED.test(l))) problems.push(`${name} needs ${n}`)
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

export async function main(argv) {
  const [command, ...rest] = argv
  const args = parseArgs(rest)
  const commands = { packages, glibc, symbols }
  if (!Object.hasOwn(commands, command)) {
    console.error('usage: node tools/build/linuxAudit.mjs packages --dir <dir> --file <model> --bytes <n> [--kinds deb,rpm,appimage] [--binary <file>]... | glibc --deb <file> [--glibc 2.35] [--glibcxx 3.4.30] [--cxxabi 1.3.13] | symbols --deb <file> --map <map> [--deps <dir>] [--binary <file>]...')
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
