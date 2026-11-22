// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins tools/build/macAudit.mjs, the six checks the macOS job of the build matrix runs
 * on the universal .app, its .dmg and its zip before anything is uploaded, and shows that each one can fail: the
 * package (the model where the runner looks at exactly the pin's size, its licence and notice beside it, llama.cpp's
 * texts where the overlay puts them, no tiny test model, each file to publish big enough for the model and under
 * GitHub's 2 GiB), the slices (lipo -archs), the libraries (otool -L: macOS's own, or inside the app), the lowest
 * macOS (otool -l), the symbols (Apple's linker map, the strings, nm -u -m) and the per-slice build (Metal on Apple
 * silicon alone, AVX2-class code for Intel). The fixtures are in the form Apple's tools print, the linker map in both
 * of its forms of an archive member (classic ld64's and ld-prime's, Xcode 15 on). Then the commands run end to end
 * over small universal Mach-O binaries made here with clang, ld64.lld and llvm-lipo, read with llvm-otool, llvm-lipo
 * and llvm-nm, which print as Apple's tools do; ld64.lld's map names archive members in classic ld64's form, so
 * ld-prime's `[N]` form is pinned from the fixture and from those maps rewritten to it (no real ld-prime map is read).
 * Each command passes a good input and fails a bad one by name.
 * No Mac is needed, and none is used: the .dmg (hdiutil) is the one input not made here.
 * What breaks if it is removed? A parser that stops matching would find nothing, and a check that finds nothing
 * passes: the macOS release could ship without the model, with one slice, or with a Homebrew library.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A computed specifier: the script is tooling under tools/, outside the page's build, loaded as the test's own module.
const AUDIT: string = '../tools/build/macAudit.mjs'
const MATRIX: string = '../tools/build/matrix.mjs'
const a = await import(AUDIT)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'tools', 'build', 'macAudit.mjs')

interface Entry { path: string; size: number; dir: boolean }

const FILE = 'Qwen2.5-1.5B-Instruct-Q4_K_M.gguf'
const BYTES = 986048768
const APP = 'Crimson Noir Agent City.app'

/** The .app's entries as the real one would hold them, with `change` applied. */
function entries(change: (e: Entry[]) => Entry[] = (e) => e): Entry[] {
  const base: Entry[] = [
    { path: 'Contents', size: 0, dir: true },
    { path: 'Contents/Info.plist', size: 1400, dir: false },
    { path: 'Contents/MacOS/crimson-noir-app', size: 31_000_000, dir: false },
    { path: `${a.MODEL_DIR}${FILE}`, size: BYTES, dir: false },
    { path: `${a.MODEL_DIR}LICENSE`, size: 11343, dir: false },
    { path: `${a.MODEL_DIR}NOTICE`, size: 2200, dir: false },
    ...a.MAC_FILES.map((p: string) => ({ path: p, size: 1078, dir: false })),
    { path: a.NOTICES.path, size: a.NOTICES.bytes, dir: false },
  ]
  return change(base)
}
const appProblems = (e: Entry[], opts: Record<string, unknown> = {}): string[] => a.appProblems('app', e, { file: FILE, bytes: BYTES, ...opts })

test('the settings it checks against are the app\'s own: llama.cpp\'s texts from the model overlay, macOS 11 from tauri.conf.json, the same minimum as the build', async () => {
  const overlay = JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.model.conf.json'), 'utf8'))
  assert.deepEqual(a.MAC_FILES, ['Contents/Resources/licenses/llama.cpp/LICENSE', 'Contents/Resources/licenses/llama.cpp/NOTICE'])
  for (const [to, from] of Object.entries(overlay.bundle.macOS.files) as [string, string][]) {
    assert.ok(a.MAC_FILES.includes(`Contents/${to}`), to)
    assert.ok(existsSync(join(ROOT, 'src-tauri', from)), `${from} is in the repository`)
  }
  assert.equal(a.MINIMUM, '11.0')
  const m = await import(MATRIX)
  assert.equal(m.macMinimum(), a.MINIMUM, 'the build targets the macOS the audit holds it to')
  assert.equal(m.macEnv().MACOSX_DEPLOYMENT_TARGET, a.MINIMUM)
  assert.equal(a.MODEL_DIR, 'Contents/Resources/models/', 'Tauri\'s resource folder in a .app, where model.rs looks')
  assert.deepEqual(a.ARCHS, ['arm64', 'x86_64'])
  assert.equal(a.ASSET_LIMIT, 2147483648)
})

test('the package: a whole .app passes, and each missing, empty, wrong-sized or stray file is named; the zip\'s listing reads in both date forms', () => {
  assert.deepEqual(appProblems(entries()), [])
  assert.match(appProblems(entries((e) => e.filter((x) => !x.path.endsWith(FILE)))).join('\n'), /app: no Contents\/Resources\/models\/Qwen2\.5-1\.5B-Instruct-Q4_K_M\.gguf/)
  assert.match(appProblems(entries((e) => e.map((x) => (x.path.endsWith(FILE) ? { ...x, size: BYTES - 1 } : x)))).join('\n'), /is 986048767 bytes; the pin says 986048768/)
  assert.match(appProblems(entries((e) => e.filter((x) => x.path !== `${a.MODEL_DIR}LICENSE`))).join('\n'), /no Contents\/Resources\/models\/LICENSE beside the model/)
  assert.match(appProblems(entries((e) => e.map((x) => (x.path === `${a.MODEL_DIR}NOTICE` ? { ...x, size: 0 } : x)))).join('\n'), /Contents\/Resources\/models\/NOTICE is empty/)
  assert.match(appProblems(entries((e) => e.filter((x) => !x.path.endsWith('llama.cpp/NOTICE')))).join('\n'), /no Contents\/Resources\/licenses\/llama\.cpp\/NOTICE \(llama\.cpp, compiled into the app, travels with its licence\)/)
  assert.equal(a.NOTICES.path, 'Contents/Resources/licenses/RUST-CRATES.txt', 'beside llama.cpp\'s texts, in Tauri\'s resource folder')
  assert.match(appProblems(entries((e) => e.filter((x) => x.path !== a.NOTICES.path))).join('\n'), /no Contents\/Resources\/licenses\/RUST-CRATES\.txt \(the Rust crates the app is built with travel with their notices\)/)
  assert.match(appProblems(entries((e) => e.map((x) => (x.path === a.NOTICES.path ? { ...x, size: 12 } : x)))).join('\n'), /RUST-CRATES\.txt is 12 bytes; the committed notices are \d+/)
  const stray = appProblems(entries((e) => [...e, { path: 'Contents/Resources/models/tiny-a.gguf', size: 9000, dir: false }]))
  assert.match(stray.join('\n'), /holds the tiny test model \(Contents\/Resources\/models\/tiny-a\.gguf\)/)
  // The end-to-end test's own build carries the tiny model on purpose.
  const tiny = entries((e) => e.map((x) => (x.path.endsWith(FILE) ? { ...x, path: `${a.MODEL_DIR}tiny-a.gguf`, size: 9000 } : x)))
  assert.deepEqual(a.appProblems('app', tiny, { file: 'tiny-a.gguf', bytes: 9000 }), [])
  // Each file to publish: more than nine tenths of the model, less than GitHub's limit for one asset.
  assert.deepEqual(a.assetProblems('x.dmg', BYTES + 5_000_000, BYTES), [])
  assert.match(a.assetProblems('x.dmg', 40_000_000, BYTES).join('\n'), /x\.dmg is 40000000 bytes: it cannot carry the 986048768-byte model/)
  assert.match(a.assetProblems('x.zip', 2 ** 31, BYTES).join('\n'), /GitHub takes no release asset of 2 GiB \(2147483648 bytes\) or more/)
  // unzip -l prints MM-DD-YYYY on macOS and YYYY-MM-DD on Linux; names keep their spaces; folders end in /.
  const mac = [
    'Archive:  out/macos-universal/Crimson Noir Agent City.app.zip',
    '  Length      Date    Time    Name',
    '---------  ---------- -----   ----',
    `        0  11-14-2026 16:28   ${APP}/`,
    `986048768  11-14-2026 16:28   ${APP}/Contents/Resources/models/${FILE}`,
    `    11343  11-14-2026 16:28   ${APP}/Contents/Resources/models/LICENSE`,
    '---------                     -------',
    '986060111                     3 files',
  ].join('\n')
  const linux = mac.replace(/11-14-2026/g, '2026-11-14')
  for (const listing of [mac, linux]) {
    const z = a.parseZipListing(listing)
    assert.deepEqual(z.map((e: Entry) => [e.path, e.size, e.dir]), [[APP, 0, true], [`${APP}/Contents/Resources/models/${FILE}`, BYTES, false], [`${APP}/Contents/Resources/models/LICENSE`, 11343, false]])
    assert.deepEqual(a.insideApp(z, APP).map((e: Entry) => e.path), [`Contents/Resources/models/${FILE}`, 'Contents/Resources/models/LICENSE'])
  }
  const plist = '<dict>\n\t<key>CFBundleExecutable</key>\n\t<string>crimson-noir-app</string>\n\t<key>LSMinimumSystemVersion</key>\n\t<string>11.0</string>\n</dict>'
  assert.equal(a.bundleExecutable(plist), 'crimson-noir-app')
  assert.equal(a.bundleExecutable('<dict></dict>'), null)
  // The .dmg is attached read-only, out of the Finder's sight, at the check's own folder.
  assert.deepEqual(a.attachArgs('x.dmg', '/tmp/m'), ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', '/tmp/m', 'x.dmg'])
  assert.deepEqual(a.detachArgs('/tmp/m'), ['detach', '/tmp/m', '-force'])
})

test('the slices, the libraries and the lowest macOS: lipo -archs, otool -L and otool -l as Apple\'s tools print them', () => {
  assert.deepEqual(a.parseLipoArchs('x86_64 arm64\n'), ['x86_64', 'arm64'])
  assert.deepEqual(a.archProblems('app', ['x86_64', 'arm64']), [])
  assert.deepEqual(a.archProblems('app', ['arm64']), ['app has no x86_64 slice (lipo -archs: arm64)'])
  const otool = [
    `/x/${APP}/Contents/MacOS/crimson-noir-app (architecture arm64):`,
    '\t/System/Library/Frameworks/WebKit.framework/Versions/A/WebKit (compatibility version 1.0.0, current version 620.1.16)',
    '\t/System/Library/Frameworks/Metal.framework/Versions/A/Metal (compatibility version 1.0.0, current version 368.12.0)',
    '\t/usr/lib/libc++.1.dylib (compatibility version 1.0.0, current version 1900.180.0)',
    '\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1351.0.0)',
  ].join('\n')
  const libs = a.parseOtoolLibraries(otool)
  assert.equal(libs.length, 4)
  assert.deepEqual(a.libraryProblems('app', 'arm64', libs), [])
  assert.deepEqual(a.libraryProblems('app', 'arm64', ['/opt/homebrew/opt/libomp/lib/libomp.dylib']), ['app (arm64) loads /opt/homebrew/opt/libomp/lib/libomp.dylib'])
  assert.deepEqual(a.libraryProblems('app', 'x86_64', ['/usr/local/lib/libfoo.dylib']), ['app (x86_64) loads /usr/local/lib/libfoo.dylib, which is not part of macOS (a Mac without it cannot start the app)'])
  // macOS has a libcurl of its own; the app must not load it, as on Linux.
  assert.deepEqual(a.libraryProblems('app', 'arm64', ['/usr/lib/libcurl.4.dylib']), ['app (arm64) loads /usr/lib/libcurl.4.dylib'])
  assert.deepEqual(a.libraryProblems('app', 'arm64', ['@rpath/libfoo.dylib']), ['app (arm64) loads @rpath/libfoo.dylib, which is not inside the app'])
  assert.deepEqual(a.libraryProblems('app', 'arm64', ['@rpath/libfoo.dylib'], () => true), [])
  assert.deepEqual(a.libraryProblems('app', 'arm64', []), ['app (arm64): otool -L lists no library: not a macOS executable'])
  const loads = [
    'crimson-noir-app (architecture x86_64):',
    'Load command 0', '      cmd LC_SEGMENT_64', '  cmdsize 72', '  segname __PAGEZERO',
    'Load command 9', '      cmd LC_BUILD_VERSION', '  cmdsize 32', ' platform 1', '    minos 11.0', '      sdk 15.2', '   ntools 1',
    'Load command 10', '      cmd LC_SOURCE_VERSION', '  cmdsize 16', '  version 0.0',
  ].join('\n')
  assert.deepEqual(a.parseMinimums(loads), [{ cmd: 'LC_BUILD_VERSION', version: '11.0' }])
  const old = ['x:', 'Load command 8', '      cmd LC_VERSION_MIN_MACOSX', '  cmdsize 16', '  version 10.13', '      sdk 15.2'].join('\n')
  assert.deepEqual(a.parseMinimums(old), [{ cmd: 'LC_VERSION_MIN_MACOSX', version: '10.13' }])
  assert.deepEqual(a.minimumProblems('app', 'x86_64', [{ cmd: 'LC_BUILD_VERSION', version: '11.0' }]), [])
  assert.deepEqual(a.minimumProblems('app', 'x86_64', [{ cmd: 'LC_VERSION_MIN_MACOSX', version: '10.13' }]), [])
  assert.deepEqual(a.minimumProblems('app', 'arm64', [{ cmd: 'LC_BUILD_VERSION', version: '15.0' }]), ['app (arm64) needs macOS 15.0 (LC_BUILD_VERSION), newer than the 11.0 the app promises'])
  assert.deepEqual(a.minimumProblems('app', 'arm64', [{ cmd: 'LC_BUILD_VERSION', version: '11.1' }], '11.0').length, 1)
  assert.deepEqual(a.minimumProblems('app', 'arm64', []), ['app (arm64) names no lowest macOS (no LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX)'])
})

test('the symbols: Apple\'s linker map read as objects and kept symbols (the dead-stripped left out), one underscore off each name, the imports nm -u -m lists', () => {
  const rlib = '/Users/runner/work/x/src-tauri/target/aarch64-apple-darwin/release/deps/libllama_cpp_sys_2-0f1e.rlib'
  const map = [
    '# Path: /Users/runner/work/x/src-tauri/target/aarch64-apple-darwin/release/deps/crimson_noir_app-1a2b',
    '# Arch: arm64',
    '# Object files:',
    '[  0] linker synthesized',
    '[  1] /Users/runner/work/x/src-tauri/target/aarch64-apple-darwin/release/deps/crimson_noir_app-1a2b.main.o',
    `[  2] ${rlib}(llama-context.cpp.o)`,
    `[  3] ${rlib}(download.cpp.o)`,
    '[  4] /Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk/usr/lib/libSystem.tbd',
    '# Sections:',
    '# Address\tSize    \tSegment\tSection',
    '0x100000548\t0x00000048\t__TEXT\t__text',
    '# Symbols:',
    '# Address\tSize    \tFile  Name',
    '0x100000548\t0x00000040\t[  1] _main',
    '0x100000588\t0x00000008\t[  2] _llama_decode',
    '0x100000590\t0x00000020\t[  2] __ZN13llama_context6decodeERK11llama_batch',
    '0x1000005B0\t0x00000010\t[  2] literal string: common_download_model is not here',
    '0x10000059C\t0x0000000C\t[  4] _connect',
    '# Dead Stripped Symbols:',
    '#        \tSize    \tFile  Name',
    '<<dead>> \t0x00000008\t[  3] _common_download_model',
    '<<dead>> \t0x00000040\t[  3] __ZN7httplib6Client3GetERKNSt3__112basic_stringIcEE',
  ].join('\n')
  const parsed = a.parseLinkerMap(map)
  assert.equal(parsed.arch, 'arm64')
  assert.equal(parsed.objects.size, 5)
  assert.equal(parsed.kept.length, 5)
  assert.equal(parsed.dead, 2)
  assert.deepEqual(a.llamaArchives(parsed), ['libllama_cpp_sys_2-0f1e.rlib'])
  assert.deepEqual(a.keptBannedInMap(parsed), [], 'the download and HTTP code was dead-stripped; a string literal is the strings scan\'s')
  const kept = a.parseLinkerMap(map.replace('<<dead>> \t0x00000040\t[  3] __ZN7httplib', '0x1000005C0\t0x00000040\t[  3] __ZN7httplib').replace('# Dead Stripped Symbols:', '0x1000005D0\t0x00000008\t[  3] _common_download_model\n# Dead Stripped Symbols:'))
  assert.deepEqual(a.keptBannedInMap(kept), ['libllama_cpp_sys_2-0f1e.rlib(download.cpp.o) _common_download_model'], 'kept before the httplib line, which the dead section still holds')
  const both = a.parseLinkerMap(map.replace(/^<<dead>> \t(0x[0-9A-F]+)\t/gm, '0x100000600\t$1\t').replace('# Dead Stripped Symbols:\n', ''))
  assert.deepEqual(a.keptBannedInMap(both), ['libllama_cpp_sys_2-0f1e.rlib(download.cpp.o) _common_download_model', 'libllama_cpp_sys_2-0f1e.rlib(download.cpp.o) __ZN7httplib6Client3GetERKNSt3__112basic_stringIcEE'])
  // One leading underscore is Mach-O's own: curl_ and SSL_ (anchored at a word's start) match only without it.
  assert.equal(a.machoName('_curl_easy_init'), 'curl_easy_init')
  assert.equal(a.machoName('__ZN7httplib'), '_ZN7httplib')
  assert.equal(a.archiveOf(`${rlib}(ggml.c.o)`)?.archive, 'libllama_cpp_sys_2-0f1e.rlib')
  assert.equal(a.archiveOf('/x/main.o'), null)
  assert.deepEqual(a.llamaArchives(a.parseLinkerMap('# Arch: x86_64\n# Object files:\n[  1] /x/main.o\n# Symbols:\n')), [])
  // Apple's current linker (ld-prime, Xcode 15 on, macos-15's) names an archive member with its index in the archive,
  // and a fat archive's slice too: `lib.rlib[12](member.o)`, `libx.a[arm64][2](y.o)`. ld64.lld, which the end-to-end
  // test links with, writes classic ld64's `lib.rlib(member.o)`, so this form is pinned from a fixture (and, end to end,
  // from ld64.lld's maps rewritten to it).
  const prime = map.replace('/usr/lib/libSystem.tbd\n', '/usr/lib/libSystem.tbd\n[  5] objc-file\n').replace(`${rlib}(llama-context.cpp.o)`, `${rlib}[12](llama-context.cpp.o)`).replace(`${rlib}(download.cpp.o)`, `${rlib}[40](download.cpp.o)`)
  assert.ok(prime.includes(`[  2] ${rlib}[12](llama-context.cpp.o)\n[  3] ${rlib}[40](download.cpp.o)\n`))
  const primed = a.parseLinkerMap(prime)
  assert.equal(primed.objects.size, 6)
  assert.deepEqual(a.llamaArchives(primed), ['libllama_cpp_sys_2-0f1e.rlib'])
  assert.deepEqual(a.keptBannedInMap(primed), [])
  const primeKept = a.parseLinkerMap(prime.replace(/^<<dead>> \t(0x[0-9A-F]+)\t/gm, '0x100000600\t$1\t').replace('# Dead Stripped Symbols:\n', ''))
  assert.deepEqual(a.keptBannedInMap(primeKept), ['libllama_cpp_sys_2-0f1e.rlib(download.cpp.o) _common_download_model', 'libllama_cpp_sys_2-0f1e.rlib(download.cpp.o) __ZN7httplib6Client3GetERKNSt3__112basic_stringIcEE'])
  assert.deepEqual(a.archiveOf(`${rlib}[12](llama-context.cpp.o)`), { archive: 'libllama_cpp_sys_2-0f1e.rlib', member: 'llama-context.cpp.o' })
  assert.equal(a.archiveOf('/p/libx.a[arm64][2](y.o)')?.archive, 'libx.a')
  assert.equal(a.archiveOf('/p/libx.a[2]'), null, 'no member, no archive object')
  const nm = [
    '                 (undefined) external _connect (from libSystem)',
    '                 (undefined) external _fork (from libSystem)',
    '                 (undefined) weak external __ZdlPv (from libc++)',
    '                 (undefined) external _objc_msgSend (from libobjc)',
  ].join('\n')
  assert.deepEqual(a.parseUndefined(nm), ['connect', 'fork', '_ZdlPv', 'objc_msgSend'])
  assert.deepEqual(a.parseUndefined('_connect\n_fork\n'), ['connect', 'fork'], 'plain nm -u')
})

test('the per-slice build: llama.cpp\'s CMake lines in each slice\'s build output, and Metal\'s strings in each slice\'s bytes', () => {
  const arm = '-- crimson-noir macos-slices: arm64: ggml\'s own defaults (Metal on)\n-- GGML_SYSTEM_ARCH: ARM\n-- Including CPU backend\n-- Adding CPU backend variant ggml-cpu:  \n-- Including METAL backend\n'
  const x86 = '-- crimson-noir macos-slices: x86_64: Metal off; SSE4.2, AVX, AVX2, FMA, F16C and BMI2 on\n-- GGML_SYSTEM_ARCH: x86\n-- Including CPU backend\n-- Adding CPU backend variant ggml-cpu: -msse4.2;-mf16c;-mfma;-mbmi2;-mavx;-mavx2 GGML_SSE42;GGML_F16C;GGML_FMA;GGML_BMI2;GGML_AVX;GGML_AVX2\n'
  assert.deepEqual(a.parseSliceBuild(arm), { flags: [], metal: true, slices: 'arm64: ggml\'s own defaults (Metal on)' })
  assert.deepEqual(a.parseSliceBuild(x86).flags, ['-msse4.2', '-mf16c', '-mfma', '-mbmi2', '-mavx', '-mavx2'])
  assert.deepEqual(a.sliceBuildProblems('arm64', a.parseSliceBuild(arm)), [])
  assert.deepEqual(a.sliceBuildProblems('x86_64', a.parseSliceBuild(x86)), [])
  assert.deepEqual(a.sliceBuildProblems('x86_64', a.parseSliceBuild(`${x86}-- Including METAL backend\n`)), ['x86_64: llama.cpp was built with Metal, which the Intel slice must not start'])
  // The Intel slice cross-compiled without the file: ggml turns its x86 options off (CMAKE_CROSSCOMPILING).
  const bare = '-- GGML_SYSTEM_ARCH: x86\n-- Adding CPU backend variant ggml-cpu:  \n-- Including METAL backend\n'
  assert.deepEqual(a.sliceBuildProblems('x86_64', a.parseSliceBuild(bare)), [
    'x86_64: llama.cpp was built without tools/build/macos-slices.cmake (no line of its own in the build output)',
    'x86_64: llama.cpp was built with Metal, which the Intel slice must not start',
    'x86_64: ggml\'s CPU code was built without -msse4.2 -mf16c -mfma -mbmi2 -mavx -mavx2 (baseline code on an Intel Mac)',
  ])
  assert.deepEqual(a.sliceBuildProblems('arm64', a.parseSliceBuild(arm.replace('-- Including METAL backend\n', ''))), ['arm64: llama.cpp was built without Metal, which the plan uses on Apple silicon'])
  assert.deepEqual(a.sliceBuildProblems('arm64', a.parseSliceBuild(arm.replace('ggml-cpu:  ', 'ggml-cpu: -mavx2 GGML_AVX2'))), ['arm64: ggml\'s CPU code was built with x86 flags (-mavx2)'])
  assert.deepEqual(a.sliceBuildProblems('arm64', a.parseSliceBuild('warning: something\n')), ['arm64: llama.cpp\'s build output has no CPU backend line (not the output of its CMake build)'])
  const metal = Buffer.from(`\0${a.METAL_MARKERS.join('\0')}\0`)
  assert.deepEqual(a.sliceBinaryProblems('arm64', metal), [])
  assert.deepEqual(a.sliceBinaryProblems('x86_64', Buffer.from('\0nothing\0')), [])
  assert.deepEqual(a.sliceBinaryProblems('arm64', Buffer.from('\0kernel_mul_mv_q4_K_f32\0')), ['arm64 slice: no Metal shader library inside (holds 1 of 2 of its strings)'])
  assert.deepEqual(a.sliceBinaryProblems('x86_64', metal), ['x86_64 slice: holds Metal ("using embedded metal library", "kernel_mul_mv_q4_K_f32")'])
})

test('the command line: a usage exit, and the commands refuse to pass without their inputs', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
  const none = run()
  assert.equal(none.status, 2)
  assert.match(none.stderr, /^usage: node tools\/build\/macAudit\.mjs package/)
  assert.equal(run('nope').status, 2)
  const pkg = run('package', '--app', ROOT)
  assert.equal(pkg.status, 1)
  assert.match(pkg.stderr, /::error::package: package needs --app, --file and --bytes/)
  const app = run('archs')
  assert.equal(app.status, 1)
  assert.match(app.stderr, /::error::archs: give --app \(or --binary\)/)
  const where = run('archs', '--app', ROOT)
  assert.equal(where.status, 1)
  assert.match(where.stderr, /::error::archs: expected one \.app in .*, found 0/)
  const maps = run('symbols', '--binary', SCRIPT)
  assert.equal(maps.status, 1)
  assert.match(maps.stderr, /::error::symbols: symbols needs a --map for each slice/)
})

// ---- End to end, over Mach-O files made here -----------------------------------------------------------------------
// clang compiles C for each macOS slice, ld64.lld links it as classic ld64 does (a map naming archive members
// `lib.a(member.o)`, dead stripping, a lowest macOS; ld-prime's `lib.a[N](member.o)` comes from rewriting that map)
// against stubs of macOS's libraries, llvm-lipo joins the slices, llvm-otool and llvm-nm read them as Apple's otool and
// nm do. LLVM's tools are found on PATH or in /usr/lib/llvm-*/bin; skipped where they are missing.

function llvmTool(name: string): string | null {
  const dirs = (process.env.PATH ?? '').split(':').filter(Boolean)
  try { dirs.push(...readdirSync('/usr/lib').filter((n) => /^llvm-\d+$/.test(n)).sort((x, y) => Number(y.slice(5)) - Number(x.slice(5))).map((n) => `/usr/lib/${n}/bin`)) } catch { /* not this system's layout */ }
  for (const d of dirs) if (existsSync(join(d, name))) return join(d, name)
  return null
}
const TOOLS = Object.fromEntries(['clang', 'ld64.lld', 'llvm-lipo', 'llvm-otool', 'llvm-nm', 'llvm-ar'].map((t) => [t, llvmTool(t)])) as Record<string, string | null>
const ZIP = spawnSync('zip', ['-v'], { encoding: 'utf8' }).status === 0 && spawnSync('unzip', ['-v'], { encoding: 'utf8' }).status === 0
const MISSING = Object.entries(TOOLS).filter(([, p]) => !p).map(([t]) => t)
const DARWIN_CLANG = MISSING.length === 0 && spawnSync(TOOLS.clang!, ['--target=arm64-apple-macos11', '-x', 'c', '-c', '-o', '/dev/null', '-'], { input: 'int x;', encoding: 'utf8' }).status === 0
const SKIP = MISSING.length ? `needs ${MISSING.join(', ')}` : !DARWIN_CLANG ? 'needs a clang that targets macOS' : !ZIP ? 'needs zip and unzip' : false

/** A stub of a macOS library, as the SDK ships them (TAPI .tbd), exporting `symbols` for both slices. */
function tbd(install: string, symbols: string[]): string {
  return `--- !tapi-tbd\ntbd-version:     4\ntargets:         [ x86_64-macos, arm64-macos ]\ninstall-name:    '${install}'\ncurrent-version: 1.0\nexports:\n  - targets:         [ x86_64-macos, arm64-macos ]\n    symbols:         [ ${symbols.join(', ')} ]\n...\n`
}

const LIB_C = 'int llama_decode(void) { return 1; }\nint common_download_model(void) { return 2; }\n'
const MAIN_C = [
  'int llama_decode(void);',
  'int fork(void);',
  '#ifdef BANNED',
  'int common_download_model(void);',
  '#endif',
  '#ifdef NET',
  'int connect(int, const void *, unsigned);',
  '#endif',
  '#ifdef SSL',
  'int SSL_new(void);',
  '#endif',
  '#ifdef RPATH',
  'int foo(void);',
  '#endif',
  '#ifdef METAL',
  '__attribute__((used)) const char *metal_strings[] = { "using embedded metal library", "kernel_mul_mv_q4_K_f32" };',
  '#endif',
  '#ifdef PLANT',
  '__attribute__((used)) const char *planted = PLANT;',
  '#endif',
  'int main(void) {',
  '  int r = llama_decode() + fork();',
  '#ifdef BANNED',
  '  r += common_download_model();',
  '#endif',
  '#ifdef NET',
  '  r += connect(0, 0, 0);',
  '#endif',
  '#ifdef SSL',
  '  r += SSL_new();',
  '#endif',
  '#ifdef RPATH',
  '  r += foo();',
  '#endif',
  '  return r;',
  '}',
].join('\n')

test('the commands end to end: each passes a good universal app and fails, naming the problem, on a bad one', { skip: SKIP }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'mac-audit-'))
  const env = { ...process.env, OTOOL: TOOLS['llvm-otool']!, LIPO: TOOLS['llvm-lipo']!, NM: TOOLS['llvm-nm']! }
  const audit = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env })
  const sh = (cmd: string, args: string[], cwd = dir) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', cwd })
    assert.equal(r.status, 0, `${cmd} ${args.join(' ')}: ${r.stderr}`)
    return r.stdout
  }
  try {
    writeFileSync(join(dir, 'main.c'), MAIN_C)
    writeFileSync(join(dir, 'lib.c'), LIB_C)
    writeFileSync(join(dir, 'libSystem.tbd'), tbd('/usr/lib/libSystem.B.dylib', ['_connect', '_fork', 'dyld_stub_binder']))
    writeFileSync(join(dir, 'libssl.tbd'), tbd('/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib', ['_SSL_new']))
    writeFileSync(join(dir, 'libfoo.tbd'), tbd('@rpath/libfoo.dylib', ['_foo']))
    const clangArch = { arm64: 'arm64', x86_64: 'x86_64' } as Record<string, string>
    for (const arch of a.ARCHS as string[]) {
      mkdirSync(join(dir, arch))
      sh(TOOLS.clang!, [`--target=${clangArch[arch]}-apple-macos11`, '-c', 'lib.c', '-o', join(arch, 'lib.o')])
      sh(TOOLS['llvm-ar']!, ['rcs', join(arch, 'libllama_cpp_sys_2-test.rlib'), join(arch, 'lib.o')])
    }
    /** One universal binary: each slice compiled with its defines, linked with a map, then joined. */
    const build = (name: string, opts: { defs?: Record<string, string[]>; minos?: string; libs?: string[]; archs?: string[] } = {}) => {
      const thin: string[] = []
      for (const arch of opts.archs ?? a.ARCHS) {
        const defs = (opts.defs?.[arch] ?? []).map((d: string) => `-D${d}`)
        const obj = join(arch, `${name}.o`)
        sh(TOOLS.clang!, [`--target=${clangArch[arch]}-apple-macos11`, ...defs, '-c', 'main.c', '-o', obj])
        const out = join(dir, arch, name)
        sh(TOOLS['ld64.lld']!, ['-arch', arch, '-platform_version', 'macos', opts.minos ?? '11.0', '14.0', '-dead_strip', '-map', `${out}.map`, '-o', out, obj, join(arch, 'libllama_cpp_sys_2-test.rlib'), 'libSystem.tbd', ...(opts.libs ?? [])])
        thin.push(out)
      }
      const fat = join(dir, `${name}.bin`)
      sh(TOOLS['llvm-lipo']!, ['-create', ...thin, '-output', fat])
      return { bin: fat, maps: (opts.archs ?? a.ARCHS).map((arch: string) => join(dir, arch, `${name}.map`)) }
    }
    /** A .app around a binary, with the model, its texts and llama.cpp's, as the bundle has them. */
    const MODEL = Buffer.alloc(65536, 7)
    const app = (name: string, bin: string, change: (root: string) => void = () => {}) => {
      const root = join(dir, name, APP)
      for (const d of ['Contents/MacOS', 'Contents/Resources/models', 'Contents/Resources/licenses/llama.cpp']) mkdirSync(join(root, d), { recursive: true })
      writeFileSync(join(root, 'Contents', 'Info.plist'), '<plist><dict>\n<key>CFBundleExecutable</key>\n<string>crimson-noir-app</string>\n</dict></plist>\n')
      writeFileSync(join(root, 'Contents', 'MacOS', 'crimson-noir-app'), readFileSync(bin))
      writeFileSync(join(root, a.MODEL_DIR, FILE), MODEL)
      for (const f of ['LICENSE', 'NOTICE']) writeFileSync(join(root, a.MODEL_DIR, f), `the model's ${f}\n`)
      for (const f of a.MAC_FILES as string[]) writeFileSync(join(root, f), `llama.cpp's ${f}\n`)
      writeFileSync(join(root, a.NOTICES.path), readFileSync(join(ROOT, 'src-tauri', 'notices', 'RUST-CRATES.txt')))
      change(root)
      return join(dir, name)
    }
    const good = build('good', { defs: { arm64: ['METAL'], x86_64: [] } })
    const goodApp = app('good', good.bin)

    // archs: both slices, then one.
    const archs = audit('archs', '--app', goodApp)
    assert.equal(archs.status, 0, archs.stderr)
    assert.match(archs.stdout, /crimson-noir-app: slices x86_64 arm64/)
    const one = build('one', { archs: ['arm64'] })
    const oneArch = audit('archs', '--app', app('one', one.bin))
    assert.equal(oneArch.status, 1)
    assert.match(oneArch.stderr, /::error::crimson-noir-app has no x86_64 slice \(lipo -archs: arm64\)/)

    // libraries: libSystem alone passes; a Homebrew OpenSSL and an @rpath library outside the app fail; inside, it passes.
    const libs = audit('libraries', '--app', goodApp)
    assert.equal(libs.status, 0, libs.stderr)
    assert.match(libs.stdout, /crimson-noir-app \(arm64\) loads \/usr\/lib\/libSystem\.B\.dylib/)
    const ssl = audit('libraries', '--app', app('ssl', build('ssl', { defs: { arm64: ['SSL'], x86_64: ['SSL'] }, libs: ['libssl.tbd'] }).bin))
    assert.equal(ssl.status, 1)
    assert.match(ssl.stderr, /::error::crimson-noir-app \(arm64\) loads \/opt\/homebrew\/opt\/openssl@3\/lib\/libssl\.3\.dylib/)
    assert.match(ssl.stderr, /::error::crimson-noir-app \(x86_64\) loads \/opt\/homebrew/)
    const rpath = build('rpath', { defs: { arm64: ['RPATH'], x86_64: ['RPATH'] }, libs: ['libfoo.tbd'] })
    const outside = audit('libraries', '--app', app('rpath', rpath.bin))
    assert.equal(outside.status, 1)
    assert.match(outside.stderr, /::error::crimson-noir-app \(arm64\) loads @rpath\/libfoo\.dylib, which is not inside the app/)
    const inside = audit('libraries', '--app', app('rpath-inside', rpath.bin, (root) => { mkdirSync(join(root, 'Contents', 'Frameworks')); writeFileSync(join(root, 'Contents', 'Frameworks', 'libfoo.dylib'), 'x') }))
    assert.equal(inside.status, 0, inside.stderr)

    // minos: 11.0 passes; a slice linked for macOS 12 fails.
    const minos = audit('minos', '--app', goodApp)
    assert.equal(minos.status, 0, minos.stderr)
    assert.match(minos.stdout, /\(x86_64\): lowest macOS 11\.0 \(LC_BUILD_VERSION\); the app promises 11\.0/)
    const newer = audit('minos', '--app', app('newer', build('newer', { minos: '12.0' }).bin))
    assert.equal(newer.status, 1)
    assert.match(newer.stderr, /::error::crimson-noir-app \(arm64\) needs macOS 12\.0 \(LC_BUILD_VERSION\), newer than the 11\.0 the app promises/)

    // symbols: the download code dead-stripped passes (fork printed); kept, imported over the network, or a planted
    // string fails; a map missing for one slice fails.
    const syms = audit('symbols', '--app', goodApp, '--map', good.maps[0], '--map', good.maps[1])
    assert.equal(syms.status, 0, syms.stderr)
    assert.match(syms.stdout, /good\.map \(arm64\): \d+ objects, \d+ symbols kept, [1-9]\d* dead-stripped; llama\.cpp archives libllama_cpp_sys_2-test\.rlib; 0 download/)
    assert.match(syms.stdout, /\(x86_64\): \d+ imports; network imports: none; process imports \(printed only\): fork/)
    const banned = build('banned', { defs: { arm64: ['BANNED'], x86_64: [] } })
    const kept = audit('symbols', '--app', app('banned', banned.bin), '--map', banned.maps[0], '--map', banned.maps[1])
    assert.equal(kept.status, 1)
    assert.match(kept.stderr, /::error::kept in the arm64 slice: libllama_cpp_sys_2-test\.rlib\(lib\.o\) _common_download_model/)
    assert.doesNotMatch(kept.stderr, /x86_64 slice: libllama/)
    const half = audit('symbols', '--app', goodApp, '--map', good.maps[0])
    assert.equal(half.status, 1)
    assert.match(half.stderr, /::error::no linker map for the x86_64 slice/)
    const net = build('net', { defs: { arm64: [], x86_64: ['NET'] } })
    const netRun = audit('symbols', '--app', app('net', net.bin), '--map', net.maps[0], '--map', net.maps[1])
    assert.equal(netRun.status, 1)
    assert.match(netRun.stderr, /::error::crimson-noir-app \(x86_64\) imports connect: a network call/)
    const plant = build('plant', { defs: { arm64: ['PLANT="https://huggingface.co/"'], x86_64: [] } })
    const planted = audit('symbols', '--app', app('plant', plant.bin), '--map', plant.maps[0], '--map', plant.maps[1])
    assert.equal(planted.status, 1)
    assert.match(planted.stderr, /::error::crimson-noir-app holds the string "https:\/\/huggingface\.co\/" of llama\.cpp's download or HTTP code/)
    writeFileSync(join(dir, 'nollama.map'), readFileSync(good.maps[1], 'utf8').replace(/libllama_cpp_sys_2-test\.rlib/g, 'libother.a'))
    const nollama = audit('symbols', '--app', goodApp, '--map', good.maps[0], '--map', join(dir, 'nollama.map'))
    assert.equal(nollama.status, 1)
    assert.match(nollama.stderr, /nollama\.map names no llama\.cpp archive: this slice was linked without the runner/)
    // The same maps with each archive member named as ld-prime (Xcode 15 on, the CI runner's linker) names it, with
    // its index in the archive: the good one passes, the kept download symbol still fails.
    const prime = (path: string) => {
      const text = readFileSync(path, 'utf8')
      assert.match(text, /libllama_cpp_sys_2-test\.rlib\(lib\.o\)/, 'ld64.lld writes classic ld64\'s form')
      const to = path.replace(/\.map$/, '.prime.map')
      writeFileSync(to, text.replace(/libllama_cpp_sys_2-test\.rlib\(/g, 'libllama_cpp_sys_2-test.rlib[1]('))
      return to
    }
    const primeGood = audit('symbols', '--app', goodApp, '--map', prime(good.maps[0]), '--map', prime(good.maps[1]))
    assert.equal(primeGood.status, 0, primeGood.stderr)
    assert.match(primeGood.stdout, /good\.prime\.map \(arm64\): .*; llama\.cpp archives libllama_cpp_sys_2-test\.rlib; 0 download/)
    const primeKept = audit('symbols', '--app', app('banned', banned.bin), '--map', prime(banned.maps[0]), '--map', prime(banned.maps[1]))
    assert.equal(primeKept.status, 1)
    assert.match(primeKept.stderr, /::error::kept in the arm64 slice: libllama_cpp_sys_2-test\.rlib\(lib\.o\) _common_download_model/)

    // slices: each slice's build output as macos-slices.cmake leaves it, and Metal in the arm64 slice alone.
    const target = (name: string, outputs: Record<string, string>) => {
      for (const [arch, text] of Object.entries(outputs)) {
        const d = join(dir, name, a.TRIPLES[arch], 'release', 'build', 'llama-cpp-sys-2-0123abcd')
        mkdirSync(d, { recursive: true })
        writeFileSync(join(d, 'output'), text)
      }
      return join(dir, name)
    }
    const armOut = '-- crimson-noir macos-slices: arm64: ggml\'s own defaults (Metal on)\n-- Adding CPU backend variant ggml-cpu:  \n-- Including METAL backend\n'
    const x86Out = '-- crimson-noir macos-slices: x86_64: Metal off; SSE4.2, AVX, AVX2, FMA, F16C and BMI2 on\n-- Adding CPU backend variant ggml-cpu: -msse4.2;-mf16c;-mfma;-mbmi2;-mavx;-mavx2 GGML_SSE42;GGML_F16C;GGML_FMA;GGML_BMI2;GGML_AVX;GGML_AVX2\n'
    const slices = audit('slices', '--app', goodApp, '--target', target('t-good', { arm64: armOut, x86_64: x86Out }))
    assert.equal(slices.status, 0, slices.stderr)
    assert.match(slices.stdout, /arm64 slice: \d+ bytes; Metal's strings: 2 of 2/)
    assert.match(slices.stdout, /x86_64 slice: \d+ bytes; Metal's strings: 0 of 2/)
    const metalBoth = build('metal-both', { defs: { arm64: ['METAL'], x86_64: ['METAL'] } })
    const leak = audit('slices', '--app', app('metal-both', metalBoth.bin), '--target', target('t-bad', { arm64: armOut, x86_64: `${x86Out}-- Including METAL backend\n` }))
    assert.equal(leak.status, 1)
    assert.match(leak.stderr, /::error::x86_64: llama\.cpp was built with Metal, which the Intel slice must not start/)
    assert.match(leak.stderr, /::error::x86_64 slice: holds Metal/)
    const missing = audit('slices', '--app', goodApp, '--target', target('t-half', { arm64: armOut }))
    assert.equal(missing.status, 1)
    assert.match(missing.stderr, /::error::x86_64: no build output of llama-cpp-sys-2 under/)

    // package: the .app and its zip pass; the model missing from the zip, the NOTICE missing from the .app, the tiny
    // model's name in the binary each fail.
    const zip = (name: string, from: string) => {
      const z = join(dir, `${name}.zip`)
      sh('zip', ['-q', '-0', '-r', z, APP], from)
      return z
    }
    const pkg = audit('package', '--app', goodApp, '--file', FILE, '--bytes', String(MODEL.length), '--zip', zip('good', goodApp))
    assert.equal(pkg.status, 0, pkg.stderr)
    assert.match(pkg.stdout, new RegExp(`${APP.replace(/\./g, '\\.')}: \\d+ entries; Contents/Resources/models/${FILE.replace(/\./g, '\\.')} 65536 bytes`))
    assert.match(pkg.stdout, /binary .*crimson-noir-app: does not hold the name tiny-a\.gguf/)
    assert.match(pkg.stdout, /zip good\.zip: \d+ bytes, \d+ entries in Crimson Noir Agent City\.app/)
    const noModelApp = app('nomodel', good.bin, (root) => rmSync(join(root, a.MODEL_DIR, FILE)))
    const nomodel = audit('package', '--app', goodApp, '--file', FILE, '--bytes', String(MODEL.length), '--zip', zip('nomodel', noModelApp))
    assert.equal(nomodel.status, 1)
    assert.match(nomodel.stderr, /::error::nomodel\.zip: no Contents\/Resources\/models\/Qwen2\.5-1\.5B-Instruct-Q4_K_M\.gguf/)
    const nonotice = audit('package', '--app', app('nonotice', good.bin, (root) => rmSync(join(root, a.MODEL_DIR, 'NOTICE'))), '--file', FILE, '--bytes', String(MODEL.length))
    assert.equal(nonotice.status, 1)
    assert.match(nonotice.stderr, /::error::Crimson Noir Agent City\.app: no Contents\/Resources\/models\/NOTICE beside the model/)
    const tinyBin = build('tiny', { defs: { arm64: ['PLANT="tiny-a.gguf"'], x86_64: [] } })
    const tiny = audit('package', '--app', app('tiny', tinyBin.bin), '--file', FILE, '--bytes', String(MODEL.length))
    assert.equal(tiny.status, 1)
    assert.match(tiny.stderr, /holds the name tiny-a\.gguf: a binary of the end-to-end test's build/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
