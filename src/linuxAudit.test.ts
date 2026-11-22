// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins tools/build/linuxAudit.mjs, the three checks the Linux jobs of the build matrix
 * run on the packages before anything is uploaded, and shows that each one can fail: the package check (the model at
 * the resource path at exactly the pin's size, its licence and notice beside it, llama.cpp's texts where the overlay
 * puts them in every package, each package bigger than nine tenths of the model, no tiny test model), the glibc gate
 * (the highest GLIBC_, GLIBCXX_ and CXXABI_ version each file's version-needs table requires, weak references
 * included, against Ubuntu 22.04's floor), and the symbol audit (the linker map's kept sections of llama.cpp's archive
 * against its download, HTTP and subprocess symbols; the binary's strings, network imports and needed libraries). The
 * fixtures are lines the real tools printed for the rehearsal build (dpkg-deb -c, rpm -qp, unsquashfs -lls, objdump
 * -T, -p and -t, lld's map), and GNU ld's map form. Then the three commands run end to end over a small .deb and ELF
 * files made here with dpkg-deb, as, ld and ar, each passing a good one and failing a bad one by name, so a command
 * that drops what its check found fails too.
 * What breaks if it is removed? A parser that stops matching would find nothing, and a check that finds nothing
 * passes: the gate would wave through a package without the model or a binary that needs a newer glibc.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A computed specifier: the script is tooling under tools/, outside the page's build, loaded as the test's own module.
const AUDIT: string = '../tools/build/linuxAudit.mjs'
const a = await import(AUDIT)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'tools', 'build', 'linuxAudit.mjs')

interface Entry { path: string; size: number; dir: boolean }
interface Sym { weak: boolean; section: string; version: string | null; name: string }
interface Need { version: string; symbols: string[] }
interface Ref { file: string; flags: number; version: string }

const FILE = 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'
const BYTES = 986048768
const DIR = `usr/lib/${a.PRODUCT}/models/`
/** Where a package holds the Rust crates' notices: the resource folder, under the path tauri.conf.json gives. */
const CRATES = `usr/lib/${a.PRODUCT}/${a.NOTICES.path}`

/** A package's entries as the real one lists them, with `change` applied. */
function entries(change: (e: Entry[]) => Entry[] = (e) => e): Entry[] {
  const base: Entry[] = [
    { path: 'usr', size: 0, dir: true },
    { path: 'usr/bin/crimson-noir-app', size: 15758464, dir: false },
    { path: `${DIR}${FILE}`, size: BYTES, dir: false },
    { path: `${DIR}LICENSE`, size: 11343, dir: false },
    { path: `${DIR}NOTICE`, size: 2200, dir: false },
    ...a.LINUX_FILES.map((p: string) => ({ path: p, size: 1078, dir: false })),
    { path: CRATES, size: a.NOTICES.bytes, dir: false },
  ]
  return change(base)
}
const problems = (e: Entry[], opts: Record<string, unknown> = {}): string[] =>
  a.packageProblems('pkg.deb', e, { file: FILE, bytes: BYTES, size: BYTES + 9_000_000, ...opts })

test('the listings: dpkg-deb -c, rpm -qp and unsquashfs -lls read as installed paths, sizes and folders', () => {
  const deb = [
    'drwxr-xr-x root/root         0 2026-11-13 19:46 ./',
    'drwxr-xr-x root/root         0 2026-11-13 19:46 ./usr/lib/Crimson Noir Agent City/models/',
    `-rw-r--r-- root/root ${BYTES} 2026-11-13 19:46 ./usr/lib/Crimson Noir Agent City/models/${FILE}`,
    '-rwxr-xr-x root/root  15758464 2026-11-13 19:46 ./usr/bin/crimson-noir-app',
    'not an entry',
  ].join('\n')
  assert.deepEqual(a.parseTarListing(deb), [
    { path: 'usr/lib/Crimson Noir Agent City/models/', size: 0, dir: true },
    { path: `usr/lib/Crimson Noir Agent City/models/${FILE}`, size: BYTES, dir: false },
    { path: 'usr/bin/crimson-noir-app', size: 15758464, dir: false },
  ], 'a path with spaces survives; the root folder and stray lines drop out')
  const squash = [
    'drwxr-xr-x root/root               199 2026-11-13 19:46 squashfs-root',
    'lrwxrwxrwx root/root                24 2026-11-13 19:46 squashfs-root/AppRun -> usr/bin/crimson-noir-app',
    '-rw-r--r-- root/root              1078 2026-11-13 19:46 squashfs-root/usr/share/doc/crimson-noir-agent-city/llama.cpp/LICENSE',
  ].join('\n')
  assert.deepEqual(a.parseTarListing(squash), [
    { path: 'AppRun', size: 24, dir: false },
    { path: 'usr/share/doc/crimson-noir-agent-city/llama.cpp/LICENSE', size: 1078, dir: false },
  ], 'squashfs-root/ goes, and a link keeps its own name, not its target')
  const rpm = [
    `${BYTES} -rw-r--r-- /usr/lib/Crimson Noir Agent City/models/${FILE}`,
    '0 drwxr-xr-x /usr/lib/Crimson Noir Agent City/models',
    '1078 -rw-r--r-- usr/no-leading-slash',
  ].join('\n')
  assert.deepEqual(a.parseRpmListing(rpm), [
    { path: `usr/lib/Crimson Noir Agent City/models/${FILE}`, size: BYTES, dir: false },
    { path: 'usr/lib/Crimson Noir Agent City/models', size: 0, dir: true },
  ])
  assert.deepEqual(a.parseTarListing(rpm), [], 'each parser reads its own tool and nothing else')
})

test('the AppImage offset is where its ELF runtime ends, read from the header; anything else is not an AppImage', () => {
  const elf64 = Buffer.alloc(64)
  elf64.writeUInt32BE(0x7f454c46, 0)
  elf64[4] = 2
  elf64[5] = 1
  elf64.writeBigUInt64LE(0x2e000n, 0x28)
  elf64.writeUInt16LE(64, 0x3a)
  elf64.writeUInt16LE(30, 0x3c)
  assert.equal(a.appImageOffset(elf64), 0x2e000 + 64 * 30)
  const elf32 = Buffer.alloc(64)
  elf32.writeUInt32BE(0x7f454c46, 0)
  elf32[4] = 1
  elf32[5] = 1
  elf32.writeUInt32LE(0x9000, 0x20)
  elf32.writeUInt16LE(40, 0x2e)
  elf32.writeUInt16LE(25, 0x30)
  assert.equal(a.appImageOffset(elf32), 0x9000 + 40 * 25)
  const bigEndian = Buffer.from(elf64)
  bigEndian[5] = 2
  assert.equal(a.appImageOffset(bigEndian), null)
  assert.equal(a.appImageOffset(Buffer.from('#!/bin/sh\n'.padEnd(64, ' '))), null)
  assert.equal(a.appImageOffset(elf64.subarray(0, 32)), null)
})

test('the package check: a whole package passes, and each missing, empty, wrong-sized or stray file is named', () => {
  assert.deepEqual(a.LINUX_FILES, [
    'usr/share/doc/crimson-noir-agent-city/llama.cpp/LICENSE',
    'usr/share/doc/crimson-noir-agent-city/llama.cpp/NOTICE',
  ], 'llama.cpp\'s texts, from the overlay')
  assert.equal(a.modelDir(), DIR)
  assert.deepEqual(problems(entries()), [])
  const one = (change: (e: Entry[]) => Entry[], pattern: RegExp, opts: Record<string, unknown> = {}): void => {
    const got = problems(entries(change), opts)
    assert.equal(got.length, 1, `one problem: ${got.join(' | ')}`)
    assert.match(got[0], pattern)
  }
  const drop = (p: string) => (e: Entry[]) => e.filter((x) => x.path !== p)
  const resize = (p: string, size: number) => (e: Entry[]) => e.map((x) => (x.path === p ? { ...x, size } : x))
  one(drop(`${DIR}${FILE}`), /^pkg\.deb: no usr\/lib\/.+\/models\/Qwen2\.5-1\.5B-Instruct-Q4_K_M\.gguf \(the runner looks/)
  one(resize(`${DIR}${FILE}`, BYTES - 1), /is 986048767 bytes; the pin says 986048768/)
  one(drop(`${DIR}LICENSE`), /no usr\/lib\/.+\/models\/LICENSE beside the model/)
  one(resize(`${DIR}NOTICE`, 0), /models\/NOTICE is empty/)
  one(drop(a.LINUX_FILES[0]), /no usr\/share\/doc\/crimson-noir-agent-city\/llama\.cpp\/LICENSE \(llama\.cpp, compiled into the app/)
  one(resize(a.LINUX_FILES[1], 0), /llama\.cpp\/NOTICE is empty/)
  one(drop(CRATES), /no usr\/lib\/.+\/licenses\/RUST-CRATES\.txt \(the Rust crates the app is built with travel with their notices\)/)
  one(resize(CRATES, a.NOTICES.bytes - 1), new RegExp(`licenses/RUST-CRATES\\.txt is ${a.NOTICES.bytes - 1} bytes; the committed notices are ${a.NOTICES.bytes}`))
  one(resize(CRATES, a.NOTICES.bytes + 1), new RegExp(`licenses/RUST-CRATES\\.txt is ${a.NOTICES.bytes + 1} bytes; the committed notices are ${a.NOTICES.bytes}`))
  one((e) => [...e, { path: `${DIR}tiny-a.gguf`, size: 600000, dir: false }], /holds the tiny test model/)
  one((e) => e, /is 887443891 bytes: it cannot carry the 986048768-byte model/, { size: Math.floor((BYTES / 10) * 9) })
  assert.deepEqual(problems(entries(), { size: Math.floor((BYTES / 10) * 9) + 1 }), [], 'one byte over nine tenths')
  // The rehearsal's build carries the tiny model on purpose.
  const tiny = entries((e) => e.map((x) => (x.path === `${DIR}${FILE}` ? { ...x, path: `${DIR}tiny-a.gguf`, size: 600000 } : x)))
  assert.deepEqual(a.packageProblems('pkg.deb', tiny, { file: 'tiny-a.gguf', bytes: 600000, size: 10_680_036 }), [])
  assert.equal(problems(tiny).length, 2, 'with the real pin, the tiny build fails twice: no model, and the tiny one')
  assert.equal(problems([], { size: 0 }).length, 7, 'an empty package: no model, no LICENSE, no NOTICE, no llama.cpp texts, no crates\' notices, too small')
  assert.deepEqual(a.NOTICES, { path: 'licenses/RUST-CRATES.txt', bytes: statSync(join(ROOT, 'src-tauri', 'notices', 'RUST-CRATES.txt')).size }, 'the resource tauri.conf.json names, at the committed file\'s size')
})

test('the model overlay puts llama.cpp\'s texts at one path in every Linux package, from third_party/llama.cpp/', () => {
  const linux = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.model.conf.json'), 'utf8')).bundle.linux
  for (const kind of ['deb', 'rpm', 'appimage']) {
    assert.deepEqual(Object.keys(linux[kind].files).map((p) => p.slice(1)).sort(), a.LINUX_FILES, kind)
    for (const src of Object.values(linux[kind].files) as string[]) {
      assert.match(src, /^\.\.\/third_party\/llama\.cpp\/(LICENSE|NOTICE)$/, `${kind}: relative to src-tauri`)
      assert.ok(readFileSync(join(ROOT, 'src-tauri', src)).length > 500, src)
    }
  }
})

test('the glibc gate: the highest need of each family, weak references included, against Ubuntu 22.04\'s floor', () => {
  assert.deepEqual({ ...a.FLOOR }, { GLIBC: '2.35', GLIBCXX: '3.4.30', CXXABI: '1.3.13' })
  assert.equal(a.compareVersions('2.35', '2.38'), -1)
  assert.equal(a.compareVersions('2.100', '2.38'), 1, 'numbers, not text')
  assert.equal(a.compareVersions('3.4.30', '3.4.3'), 1)
  assert.equal(a.compareVersions('1.3', '1.3.0'), 0)
  const dump = [
    'crimson-noir-app:     file format elf64-x86-64',
    '',
    'DYNAMIC SYMBOL TABLE:',
    '0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.38) __isoc23_strtol',
    '0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.38) __isoc23_sscanf',
    '0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.34) __libc_start_main',
    '0000000000000000  w   D  *UND*\t0000000000000000              __gmon_start__',
    '0000000000000000  w   DF *UND*\t0000000000000000 (GLIBC_2.39) pidfd_spawnp',
    '0000000000000000      DF *UND*\t0000000000000000 (GLIBCXX_3.4.29) _ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE10_M_replaceEmmPKcm',
    '0000000000000000      DF *UND*\t0000000000000000 (GLIBCXX_3.4) _ZSt19__throw_logic_errorPKc',
    '0000000000000000      DF *UND*\t0000000000000000 CXXABI_1.3.13 _ZSt28__throw_bad_array_new_lengthv',
    '0000000000000000      DF *UND*\t0000000000000000 (CXXABI_1.3.9) _ZdlPvm',
    '00000000004f2a10 g    DF .text\t0000000000000042 (GLIBC_2.40) defined_here',
  ].join('\n')
  const syms: Sym[] = a.parseDynamicSymbols(dump)
  assert.equal(syms.length, 10, 'every symbol line, nothing else')
  assert.deepEqual(syms[0], { weak: false, section: '*UND*', version: 'GLIBC_2.38', name: '__isoc23_strtol' })
  assert.deepEqual(syms[3], { weak: true, section: '*UND*', version: null, name: '__gmon_start__' })
  assert.equal(syms[4].weak, true)
  assert.equal(syms[7].version, 'CXXABI_1.3.13', 'a version without parentheses (a hidden one) reads too')
  // The linker records a weak reference's version in the version-needs table as a hard need (GNU ld and lld alike),
  // and the loader refuses to start a file whose table names a version the library lacks: a weak reference counts.
  const needs: Record<string, Need> = a.versionNeeds(syms)
  assert.deepEqual(needs, {
    GLIBC: { version: '2.39', symbols: ['weak pidfd_spawnp'] },
    GLIBCXX: { version: '3.4.29', symbols: ['_ZNSt7__cxx1112basic_stringIcSt11char_traitsIcESaIcEE10_M_replaceEmmPKcm'] },
    CXXABI: { version: '1.3.13', symbols: ['_ZSt28__throw_bad_array_new_lengthv'] },
  }, 'the weak GLIBC_2.39 reference counts; the defined GLIBC_2.40 symbol does not')
  assert.deepEqual(a.floorProblems('usr/bin/crimson-noir-app', needs), [
    'usr/bin/crimson-noir-app needs GLIBC_2.39 (weak pidfd_spawnp), above the floor GLIBC_2.35',
  ], 'a weak reference above the floor fails, named as weak')
  assert.deepEqual(a.floorProblems('x', needs, { GLIBC: '2.39', GLIBCXX: '3.4.33', CXXABI: '1.3.15' }), [], '24.04\'s own floor')
  assert.equal(a.floorProblems('x', needs, { GLIBC: '2.38', GLIBCXX: '3.4.28', CXXABI: '1.3.12' }).length, 3)
  const strong: Record<string, Need> = a.versionNeeds(syms.filter((s) => !s.weak))
  assert.deepEqual(a.floorProblems('usr/bin/crimson-noir-app', strong), [
    'usr/bin/crimson-noir-app needs GLIBC_2.38 (__isoc23_strtol, __isoc23_sscanf), above the floor GLIBC_2.35',
  ], 'the 24.04 build fails, naming the version and what needs it')
  // The table the loader reads (objdump -p): an entry counts unless it carries VER_FLG_WEAK (0x2), which no linker
  // in use sets; a version only the table names still counts, and a version only a symbol names counts too.
  const p = [
    'crimson-noir-app:     file format elf64-x86-64',
    '',
    'Dynamic Section:',
    '  NEEDED               libc.so.6',
    '',
    'Version definitions:',
    '1 0x01 0x0b3bd9a2 crimson-noir-app',
    '',
    'Version References:',
    '  required from libstdc++.so.6:',
    '    0x0297f86d 0x00 09 GLIBCXX_3.4.29',
    '  required from libc.so.6:',
    '    0x069691b8 0x00 08 GLIBC_2.38',
    '    0x069691b9 0x02 07 GLIBC_2.39',
    '    0x069691b4 0x00 103 GLIBC_2.34',
    '  required from libm.so.6:',
    '    0x069691b0 0x00 06 GLIBC_2.40',
    '',
  ].join('\n')
  const refs: Ref[] = a.parseVersionRefs(p)
  assert.equal(a.VER_FLG_WEAK, 2)
  assert.deepEqual(refs, [
    { file: 'libstdc++.so.6', flags: 0, version: 'GLIBCXX_3.4.29' },
    { file: 'libc.so.6', flags: 0, version: 'GLIBC_2.38' },
    { file: 'libc.so.6', flags: 2, version: 'GLIBC_2.39' },
    { file: 'libc.so.6', flags: 0, version: 'GLIBC_2.34' },
    { file: 'libm.so.6', flags: 0, version: 'GLIBC_2.40' },
  ], 'every entry with its file, its flags and its version; the definitions above are not needs')
  assert.deepEqual(a.parseVersionRefs('no table here\n'), [])
  const read: Record<string, Need> = a.versionNeeds(syms, refs)
  assert.deepEqual(read.GLIBC, { version: '2.40', symbols: [] }, 'GLIBC_2.40 is needed (0x00) though no undefined symbol names it')
  assert.deepEqual(a.floorProblems('x', read), ['x needs GLIBC_2.40 (in its version-needs table, named by no symbol), above the floor GLIBC_2.35'])
  const weakFlagged = a.versionNeeds(syms, refs.filter((r) => r.version !== 'GLIBC_2.40'))
  assert.deepEqual(weakFlagged.GLIBC, { version: '2.38', symbols: ['__isoc23_strtol', '__isoc23_sscanf'] },
    'the entry flagged weak (0x02) does not count, though a weak symbol names its version')
  assert.deepEqual(a.versionNeeds(syms, refs.filter((r) => r.version !== 'GLIBC_2.40' && r.version !== 'GLIBC_2.39')).GLIBC.version, '2.39',
    'a version a symbol names counts when the table does not list it, so a table that was not read still fails the file')
  assert.deepEqual(weakFlagged.CXXABI, { version: '1.3.13', symbols: ['_ZSt28__throw_bad_array_new_lengthv'] })
  // Main's `current` x86-64 .deb, built on Ubuntu 24.04 before the Linux jobs moved to 22.04 (no C++ at all): its
  // strong references need GLIBC_2.34, but Rust's weak pidfd_getpid and pidfd_spawnp put GLIBC_2.39 in its table
  // (readelf -V: Flags: none), so it needs glibc 2.39, which the old count of strong references alone missed.
  const mainT: Sym[] = a.parseDynamicSymbols([
    '0000000000000000      DF *UND*\t0000000000000000 (GLIBC_2.34) __libc_start_main',
    '0000000000000000  w   DF *UND*\t0000000000000000 (GLIBC_2.39) pidfd_getpid',
    '0000000000000000  w   DF *UND*\t0000000000000000 (GLIBC_2.39) pidfd_spawnp',
  ].join('\n'))
  const mainP = a.parseVersionRefs('\nVersion References:\n  required from libc.so.6:\n    0x069691b4 0x00 02 GLIBC_2.34\n    0x069691b9 0x00 18 GLIBC_2.39\n')
  const main = a.versionNeeds(mainT, mainP)
  assert.deepEqual(main, { GLIBC: { version: '2.39', symbols: ['weak pidfd_getpid', 'weak pidfd_spawnp'] } })
  assert.deepEqual(a.floorProblems('x', main), ['x needs GLIBC_2.39 (weak pidfd_getpid, weak pidfd_spawnp), above the floor GLIBC_2.35'])
  assert.deepEqual(a.versionNeeds(mainT.filter((s) => !s.weak)), { GLIBC: { version: '2.34', symbols: ['__libc_start_main'] } })
})

test('the symbol audit reads lld\'s and GNU ld\'s maps, the archive\'s symbols, and keeps only banned symbols the link kept', () => {
  const rlib = '/home/user/n4/src-tauri/target/release/deps/rustcd1gHT7/libllama_cpp_sys_2-491e59a2251c9b83.rlib'
  const lld = [
    '             VMA              LMA     Size Align Out     In      Symbol',
    `          7b7eb8           7b7eb8       18     4         ${rlib}(llama.cpp.o):(.rodata.llama_load_mode_name)`,
    `          7b7ed0           7b7ed0       ac     4         ${rlib}(ggml.c.o):(.rodata.ggml_quantize_chunk)`,
    '             2fc              2fc       20     4         /usr/lib/gcc/x86_64-linux-gnu/13/../../../x86_64-linux-gnu/Scrt1.o:(.note.ABI-tag)',
  ].join('\n')
  const keptLld: Set<string> = a.keptSections(lld)
  const rlibName = 'libllama_cpp_sys_2-491e59a2251c9b83.rlib'
  assert.deepEqual([...keptLld], [`${rlibName}(llama.cpp.o):.rodata.llama_load_mode_name`, `${rlibName}(ggml.c.o):.rodata.ggml_quantize_chunk`],
    'archive members only, by the archive\'s file name')
  assert.deepEqual(a.mapArchives(lld), [rlib])
  const gnu = [
    'Discarded input sections',
    '',
    ' .text.common_download_model',
    '                0x0000000000000000      0x120 /deps/libllama_cpp_sys_2-x.rlib(download.cpp.o)',
    '',
    'Linker script and memory map',
    '',
    ' .text.llama_decode',
    '                0x0000000000401000      0x200 /deps/libllama_cpp_sys_2-x.rlib(llama-context.cpp.o)',
    ' .rodata.ggml_names  0x0000000000402000       0x40 /deps/libllama_cpp_sys_2-x.rlib(ggml.c.o)',
    ' .text.main      0x0000000000403000       0x10 /tmp/main.o',
    ' .text.SSL_new   0x0000000000404000       0x10 /usr/lib/x86_64-linux-gnu/libssl.a(ssl_lib.o)',
  ].join('\n')
  const keptGnu: Set<string> = a.keptSections(gnu)
  assert.deepEqual([...keptGnu].sort(), [
    'libllama_cpp_sys_2-x.rlib(ggml.c.o):.rodata.ggml_names',
    'libllama_cpp_sys_2-x.rlib(llama-context.cpp.o):.text.llama_decode',
    'libssl.a(ssl_lib.o):.text.SSL_new',
  ], 'the section on its own line when long, and nothing from the discarded list')
  assert.deepEqual(a.mapArchives(gnu).sort(), ['/deps/libllama_cpp_sys_2-x.rlib', '/usr/lib/x86_64-linux-gnu/libssl.a'])
  const objdump = [
    'In archive libllama_cpp_sys_2-x.rlib:',
    '',
    'llama-context.cpp.o:     file format elf64-x86-64',
    '',
    'SYMBOL TABLE:',
    '0000000000000000 l    df *ABS*\t0000000000000000 llama-context.cpp',
    '0000000000000000 l    d  .text.llama_decode\t0000000000000000 .text.llama_decode',
    '0000000000000000 g     F .text.llama_decode\t0000000000000200 llama_decode',
    '0000000000000000         *UND*\t0000000000000000 common_http_get',
    '',
    'download.cpp.o:     file format elf64-x86-64',
    '',
    'SYMBOL TABLE:',
    '0000000000000000 g     F .text.common_download_model\t0000000000000120 common_download_model',
    '0000000000000000 g     F .text.llama_decode\t0000000000000010 _ZN7httplib6Client3GetEv',
  ].join('\n')
  const syms = a.archiveSymbols(objdump)
  assert.deepEqual(syms, [
    { member: 'llama-context.cpp.o', section: '.text.llama_decode', name: 'llama_decode' },
    { member: 'download.cpp.o', section: '.text.common_download_model', name: 'common_download_model' },
    { member: 'download.cpp.o', section: '.text.llama_decode', name: '_ZN7httplib6Client3GetEv' },
  ], 'defined symbols with their member; no file, section or undefined entries')
  assert.deepEqual(a.keptBanned('libllama_cpp_sys_2-x.rlib', syms, keptGnu), [],
    'download.cpp.o was discarded: its symbols are defined in the archive but not in the binary')
  const linked = new Set([...keptGnu, 'libllama_cpp_sys_2-x.rlib(download.cpp.o):.text.common_download_model'])
  assert.deepEqual(a.keptBanned('libllama_cpp_sys_2-x.rlib', syms, linked), ['download.cpp.o .text.common_download_model common_download_model'],
    'once its section is kept, it fails; a banned name in a section of another member stays apart')
  assert.deepEqual(a.keptBanned('other.rlib', syms, linked), [], 'by archive too')
})

test('the banned names, strings, imports and libraries: what each pattern takes and what it leaves', () => {
  for (const s of ['_ZN7httplib6Client3GetEv', 'subprocess_create', 'common_download_model', 'common_docker_resolve_model', 'common_http_get',
    'curl_easy_init', 'SSL_CTX_new', 'OPENSSL_init_ssl', '_Z17hf_cache_migratev', 'common_get_model_endpoint']) {
    assert.match(s, a.BANNED_SYMBOLS, s)
  }
  for (const s of ['llama_decode', 'llama_load_mode_name', 'ggml_quantize_chunk', 'gguf_init_from_file', 'ggml_print_backtrace', 'my_curl_x']) {
    assert.doesNotMatch(s, a.BANNED_SYMBOLS, s)
  }
  assert.deepEqual(a.bannedStrings(Buffer.from('\0llama_decode\0ggml\0')), [])
  assert.deepEqual(a.bannedStrings(Buffer.from('\0x\0cpp-httplib/0.20\0HF_TOKEN\0')), ['cpp-httplib/', 'HF_TOKEN'])
  for (const n of ['socket', 'connect', 'getaddrinfo', 'gethostbyname2_r', 'accept4', 'curl_easy_perform', 'SSL_read']) assert.match(n, a.NETWORK_IMPORTS, n)
  for (const n of ['socketpair', 'connectx', 'read', 'dlopen', 'execvp']) assert.doesNotMatch(n, a.NETWORK_IMPORTS, n)
  for (const n of ['fork', 'execlp', 'execvp', 'posix_spawnp', 'system', 'popen']) assert.match(n, a.PROCESS_IMPORTS, n)
  for (const l of ['libssl.so.3', 'libcrypto.so.3', 'libcurl.so.4', 'libgomp.so.1']) assert.match(l, a.BANNED_NEEDED, l)
  for (const l of ['libstdc++.so.6', 'libc.so.6', 'libwebkit2gtk-4.1.so.0', 'libsslx.so']) assert.doesNotMatch(l, a.BANNED_NEEDED, l)
})

test('the command line: a usage exit, and the commands refuse to pass without their inputs', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  const none = run()
  assert.equal(none.status, 2)
  assert.match(none.stderr, /^usage: node tools\/build\/linuxAudit\.mjs packages/)
  const bare = run('packages', '--dir', ROOT)
  assert.equal(bare.status, 1)
  assert.match(bare.stderr, /::error::packages: packages needs --dir, --file and --bytes/)
  assert.equal(run('symbols').status, 1)
  const dir = mkdtempSync(join(tmpdir(), 'linux-audit-test-'))
  try {
    const map = join(dir, 'app.map')
    writeFileSync(map, '             VMA              LMA     Size Align Out     In      Symbol\n')
    const empty = run('symbols', '--map', map, '--binary', process.execPath)
    assert.equal(empty.status, 1)
    assert.match(empty.stderr, /lists no kept section from any archive: not a linker map of the app/)
    const noPackages = run('packages', '--dir', dir, '--file', FILE, '--bytes', String(BYTES))
    assert.equal(noPackages.status, 1, 'a folder without packages fails')
    assert.match(noPackages.stderr, /expected one \.deb in .+, found 0/)
    assert.match(noPackages.stdout, /packages: 3 problems/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The three commands over a real (small) .deb and ELF files made here, so a command that drops what its check found
// cannot pass. x86-64 or arm64 Linux with dpkg-deb and binutils (the CI runner has both); skipped elsewhere.
const HAS = (cmd: string): boolean => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0
const CALL = process.arch === 'x64' ? 'call %s@PLT' : process.arch === 'arm64' ? 'bl %s' : null
const TOOLS = process.platform === 'linux' && CALL !== null && ['dpkg-deb', 'objdump', 'readelf', 'as', 'ld', 'ar'].every(HAS)
test('the three commands end to end: each passes a good .deb and fails, naming the problem, on a bad one', { skip: !TOOLS && 'needs Linux on x86-64 or arm64, dpkg-deb and binutils' }, () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  const ok = (cmd: string, ...args: string[]): void => {
    const r = spawnSync(cmd, args, { encoding: 'utf8' })
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`)
  }
  const dir = mkdtempSync(join(tmpdir(), 'linux-audit-e2e-'))
  try {
    const tree = join(dir, 'tree')
    const put = (rel: string, body: string | Buffer): void => { mkdirSync(join(tree, rel, '..'), { recursive: true }); writeFileSync(join(tree, rel), body) }
    put('DEBIAN/control', 'Package: crimson-noir-app\nVersion: 0.0.1\nArchitecture: all\nMaintainer: test <t@example.invalid>\nDescription: test\n')
    mkdirSync(join(tree, 'usr', 'bin'), { recursive: true })
    copyFileSync('/usr/bin/true', join(tree, 'usr', 'bin', 'crimson-noir-app'))
    put(`${DIR}x.gguf`, Buffer.alloc(1000, 1)); put(`${DIR}LICENSE`, 'licence'); put(`${DIR}NOTICE`, 'notice')
    for (const f of a.LINUX_FILES) put(f, 'llama.cpp')
    put(CRATES, readFileSync(join(ROOT, 'src-tauri', 'notices', 'RUST-CRATES.txt')))
    const out = join(dir, 'out'); mkdirSync(out)
    const deb = join(out, 't.deb')
    ok('dpkg-deb', '--build', '--root-owner-group', tree, deb)

    // packages: the model at its path and size, and no binary holding the tiny model's name.
    const good = run('packages', '--dir', out, '--kinds', 'deb', '--file', 'x.gguf', '--bytes', '1000')
    assert.equal(good.status, 0, good.stderr)
    const bad = run('packages', '--dir', out, '--kinds', 'deb', '--file', 'y.gguf', '--bytes', '1000')
    assert.equal(bad.status, 1)
    assert.match(bad.stderr, /::error::t\.deb: no usr\/lib\/.+\/models\/y\.gguf/)

    // glibc: the floor, over every ELF file the .deb installs.
    assert.equal(run('glibc', '--deb', deb).status, 0)
    const old = run('glibc', '--deb', deb, '--glibc', '2.2.5')
    assert.equal(old.status, 1)
    assert.match(old.stderr, /::error::usr\/bin\/crimson-noir-app needs GLIBC_2\.\d+ \(.+\), above the floor GLIBC_2\.2\.5/)

    // A library whose only need above the floor is a weak reference (strlcpy@GLIBC_2.99, against a stand-in libc.so.6
    // that defines it): the linker writes GLIBC_2.99 into its version-needs table with no weak flag, so the loader
    // will not start it on a glibc without that version. And one that imports connect from a stand-in libssl.so.3.
    const asm = (name: string, body: string): string => { const f = join(dir, `${name}.s`); writeFileSync(f, body); ok('as', '-o', join(dir, `${name}.o`), f); return join(dir, `${name}.o`) }
    const stub = (soname: string, sym: string, version: string | null): string => {
      const o = asm(`stub-${sym}`, `.text\n.globl ${sym}\n.type ${sym},@function\n${sym}:\nret\n`)
      const lib = join(dir, soname)
      if (version) { writeFileSync(join(dir, `${sym}.ver`), `${version} { global: ${sym}; local: *; };\n`); ok('ld', '-shared', '-soname', soname, '--version-script', join(dir, `${sym}.ver`), '-o', lib, o) }
      else ok('ld', '-shared', '-soname', soname, '-o', lib, o)
      return lib
    }
    const user = (name: string, sym: string, weak: boolean, lib: string): string => {
      const o = asm(name, `${weak ? `.weak ${sym}\n` : ''}.text\n.globl ${name}_f\n.type ${name}_f,@function\n${name}_f:\n${CALL!.replace('%s', sym)}\nret\n`)
      const so = join(dir, `${name}.so`)
      ok('ld', '-shared', '--no-as-needed', '-o', so, o, lib)
      return so
    }
    const weakSo = user('weakref', 'strlcpy', true, stub('libc.so.6', 'strlcpy', 'GLIBC_2.99'))
    const dump = spawnSync('objdump', ['-T', weakSo], { encoding: 'utf8' }).stdout
    assert.match(dump, /\bw\s+DF \*UND\*\s+0+\s+\(GLIBC_2\.99\)\s+strlcpy/, 'objdump -T lists it as weak')
    assert.match(spawnSync('objdump', ['-p', weakSo], { encoding: 'utf8' }).stdout, /required from libc\.so\.6:\n\s+0x[0-9a-f]+ 0x00 \d+ GLIBC_2\.99\n/,
      'and its version-needs entry carries no weak flag')
    const netSo = user('net', 'connect', false, stub('libssl.so.3', 'connect', null))
    copyFileSync(weakSo, join(tree, DIR, '..', 'weakref.so'))
    copyFileSync(netSo, join(tree, DIR, '..', 'net.so'))
    const badDeb = join(dir, 'bad.deb')
    ok('dpkg-deb', '--build', '--root-owner-group', tree, badDeb)
    const weak = run('glibc', '--deb', badDeb)
    assert.equal(weak.status, 1, weak.stdout)
    assert.match(weak.stderr, /::error::usr\/lib\/.+\/weakref\.so needs GLIBC_2\.99 \(weak strlcpy\), above the floor GLIBC_2\.35/,
      'a library outside usr/bin, failing on a weak reference')
    assert.doesNotMatch(weak.stderr, /crimson-noir-app needs/)
    // The same library with that entry flagged VER_FLG_WEAK (vna_flags, beside the hash objdump -p prints), which no
    // linker writes but the loader honours by starting without the version: the table, read, lets it pass, though
    // objdump -T still names strlcpy at GLIBC_2.99.
    const entry = /^\s+0x([0-9a-f]{8}) 0x00 \d+ GLIBC_2\.99$/m.exec(spawnSync('objdump', ['-p', weakSo], { encoding: 'utf8' }).stdout)
    assert.ok(entry, 'the entry and its hash')
    const bytes = readFileSync(weakSo)
    const at = Buffer.alloc(6)
    at.writeUInt32LE(parseInt(entry[1], 16), 0)
    assert.equal(bytes.indexOf(at), bytes.lastIndexOf(at), 'one vernaux entry with that hash and no flags')
    bytes.writeUInt16LE(a.VER_FLG_WEAK, bytes.indexOf(at) + 4)
    const flagged = join(dir, 'flagged')
    mkdirSync(join(flagged, 'DEBIAN'), { recursive: true }); mkdirSync(join(flagged, 'usr', 'lib'), { recursive: true })
    writeFileSync(join(flagged, 'DEBIAN', 'control'), 'Package: flagged\nVersion: 0.0.1\nArchitecture: all\nMaintainer: test <t@example.invalid>\nDescription: test\n')
    writeFileSync(join(flagged, 'usr', 'lib', 'flagged.so'), bytes)
    assert.match(spawnSync('readelf', ['-V', join(flagged, 'usr', 'lib', 'flagged.so')], { encoding: 'utf8' }).stdout, /Name: GLIBC_2\.99 {2}Flags: WEAK/)
    ok('dpkg-deb', '--build', '--root-owner-group', flagged, join(dir, 'flagged.deb'))
    const skipped = run('glibc', '--deb', join(dir, 'flagged.deb'))
    assert.equal(skipped.status, 0, skipped.stderr)
    assert.match(skipped.stdout, /usr\/lib\/flagged\.so: highest needs GLIBC_- GLIBCXX_- CXXABI_-, from 1 version-needs entry/)

    // symbols: the kept sections of the llama.cpp archive the map names, then the binary.
    writeFileSync(join(dir, 'd.s'), '.section .text.common_http_get,"ax",@progbits\n.globl common_http_get\ncommon_http_get:\nret\n')
    writeFileSync(join(dir, 'k.s'), '.section .text.llama_decode,"ax",@progbits\n.globl llama_decode\nllama_decode:\nret\n')
    for (const n of ['d', 'k']) ok('as', '-o', join(dir, `${n}.o`), join(dir, `${n}.s`))
    const rlib = join(dir, 'libllama_cpp_sys_2-test.rlib')
    ok('ar', 'rc', rlib, join(dir, 'd.o'), join(dir, 'k.o'))
    const map = (section: string, member: string): string => { const m = join(dir, `${member}.map`); writeFileSync(m, `     1000     1000       10     4         ${rlib}(${member}):(${section})\n`); return m }
    const clean = run('symbols', '--deb', deb, '--map', map('.text.llama_decode', 'k.o'))
    assert.equal(clean.status, 0, clean.stderr)
    const linked = run('symbols', '--deb', deb, '--map', map('.text.common_http_get', 'd.o'))
    assert.equal(linked.status, 1)
    assert.match(linked.stderr, /::error::kept in the binary: d\.o \.text\.common_http_get common_http_get/)
    const net = run('symbols', '--deb', badDeb, '--map', map('.text.llama_decode', 'k.o'))
    assert.equal(net.status, 1)
    assert.match(net.stderr, /::error::usr\/lib\/.+\/net\.so imports connect: a network call/)
    assert.match(net.stderr, /::error::usr\/lib\/.+\/net\.so needs libssl\.so\.3/)
    const planted = join(dir, 'planted')
    writeFileSync(planted, Buffer.concat([readFileSync('/usr/bin/true'), Buffer.from(`\0cpp-httplib/\0${a.TINY}\0`)]))
    const strings = run('symbols', '--binary', planted, '--map', map('.text.llama_decode', 'k.o'))
    assert.equal(strings.status, 1)
    assert.match(strings.stderr, /holds the string "cpp-httplib\/"/)
    const tiny = run('packages', '--dir', out, '--kinds', 'deb', '--file', 'x.gguf', '--bytes', '1000', '--binary', planted)
    assert.equal(tiny.status, 1)
    assert.match(tiny.stderr, /planted holds the name tiny-a\.gguf/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the workflow runs the gate at the default floor, and the three checks over the job\'s own build', () => {
  const flow = readFileSync(join(ROOT, '.github', 'workflows', 'build-matrix.yml'), 'utf8')
  const gate = flow.split('\n').filter((l) => l.includes('linuxAudit.mjs glibc'))
  assert.equal(gate.length, 1)
  assert.doesNotMatch(gate[0], /--glibc|--glibcxx|--cxxabi/, 'Ubuntu 22.04\'s floor, as the tool holds it')
  for (const cmd of ['packages', 'glibc', 'symbols']) assert.equal(flow.split(`linuxAudit.mjs ${cmd} `).length - 1, 1, cmd)
})
