#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the one command that builds every shipped form of Crimson Noir: Agent City from this
 * checkout, on the machine that can build it: `npm run build:matrix [-- --targets <ids>|all|host] [--out <dir>]
 * [--dry-run] [--list] [--skip-page]`. Ten targets (TARGETS below): the desktop app for Windows x64 and arm64 (the
 * NSIS installer, the .msi and the bare .exe), Linux x64 and arm64 (.deb, .rpm and .AppImage), macOS (one universal
 * .app and .dmg), the Android .apk, the iOS .ipa, and Crimson Noir OS's UEFI application for x86-64, for aarch64 and
 * for riscv64 (and their bootable media where the media tools are installed). The page (dist/index.html) is built once, for the
 * targets that carry it (the UEFI application does not), and every app is a Tauri 2 shell around it (src-tauri). The
 * version 1.0.0-stable-beta carries a pre-release tag, which WiX and rpm refuse in a version: the .msi takes the
 * numbers alone (1.0.0) and the .rpm the numbers as its Version with the tag in its Release (0.stable.beta), while
 * the app inside each says its full version (installerVersion, rpmRelease). Nothing here is signed: the Windows and Linux
 * files run as they are; the macOS app is unsigned (Gatekeeper refuses it at first: `xattr -dr
 * com.apple.quarantine` on the .app, or Privacy & Security › Open Anyway on macOS 15 and later, right-click › Open up
 * to macOS 14; not tried on a Mac), the .apk is signed with the Android debug key unless CRIMSON_ANDROID_KEYSTORE
 * names a keystore, and the .ipa is unsigned (a free Apple ID and a sideloading tool re-sign it; the App Store needs
 * a paid account). Which browser engine the shell gets, and whether it has WebGPU, is the platform's: WebView2 on
 * Windows, WebKitGTK on Linux, WKWebView on macOS and iOS, the Android System WebView; only Windows has been run so far
 * (MANUAL.md, The build matrix).
 * The script is plain Node, like tools/verify/fvps.mjs: it runs programs with argument vectors (never a shell), so it
 * works the same from cmd.exe, PowerShell and a POSIX shell; .github/workflows/build-matrix.yml runs it on GitHub's
 * runners, one job per target, and publishes the files as workflow artifacts (and onto a tag's release).
 * - `--targets`: a comma-separated list of ids, `all` (every target this machine can build; the others are skipped
 *   with a note), or `host` (the default: this machine's own desktop app and the UEFI application).
 * - `--dry-run`: prints what would run, builds nothing, and writes no file.
 * - `--out <dir>` (default out/matrix): each target's files land in <dir>/<id>/, and <dir>/matrix.json says what was
 *   built, skipped or failed, and why (the workflow's summary reads it).
 * - A target named by hand that this machine cannot build, or that fails, exits 1; under `all` and `host` only a
 *   failed build does.
 * What breaks if it is removed? Each platform's build is a page of instructions again, and the release carries only
 * the Windows app and the OS media.
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WINDOWS = process.platform === 'win32'

/** The Rust targets the apps are built for (rustup's names); the host's own is never passed to tauri. */
export const TRIPLES = Object.freeze({
  windowsArm64: 'aarch64-pc-windows-msvc',
  macUniversal: 'universal-apple-darwin',
  macArm64: 'aarch64-apple-darwin',
  macX64: 'x86_64-apple-darwin',
  android: 'aarch64-linux-android',
  ios: 'aarch64-apple-ios',
  uefiX64: 'x86_64-unknown-uefi',
  uefiArm64: 'aarch64-unknown-uefi',
  // Rust has no riscv64 UEFI target: the image is the bare-metal build behind a PE header of its own (arch/riscv64.rs).
  uefiRiscv64: 'riscv64gc-unknown-none-elf',
})

/**
 * The installers' own version for an app version: its three numbers alone. WiX takes major.minor.patch (an optional
 * fourth number) and nothing else, and rpm refuses a hyphen in its Version tag, so 1.0.0-stable-beta is 1.0.0 to
 * both; the app inside keeps its full version (the Tauri build is never given this one).
 */
export function installerVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (!m) throw new Error(`not a semantic version: ${version}`)
  return `${m[1]}.${m[2]}.${m[3]}`
}

/**
 * The .rpm's Release for an app version: `1` for a plain release; for a pre-release, `0.` and its tag with dots
 * (1.0.0-stable-beta: Version 1.0.0, Release 0.stable.beta), so the final 1.0.0 (Release 1) sorts after it, as
 * Fedora's packaging guidelines number pre-releases.
 */
export function rpmRelease(version) {
  const pre = /^\d+\.\d+\.\d+-([0-9A-Za-z.-]+)/.exec(version)?.[1]
  return pre ? `0.${pre.replace(/-/g, '.')}` : '1'
}

/**
 * The bare Windows executable's published name: its own name with the version and the architecture
 * (crimson-noir-app_1.0.0-stable-beta_x64.exe), as the installers carry them, so the x64 and arm64 builds never share a
 * name on a release that carries both (one would replace the other there).
 */
export function portableName(exe, version, arch) {
  return `${exe.replace(/\.exe$/i, '')}_${version}_${arch}.exe`
}

/** A desktop build's --config: the page is not built again, and the .msi gets the numbers WiX takes. */
function desktopConfig(version) {
  return JSON.stringify({ build: { beforeBuildCommand: '' }, bundle: { windows: { wix: { version: installerVersion(version) } } } })
}

/**
 * The .rpm from the binary the build just made: `tauri bundle` packages it without compiling (and restores the binary
 * after its patch), so the installer's version can be the numbers alone while the app inside says its own. It carries
 * the model as the build's .deb and .AppImage do (MODEL_CONFIG; stored, not compressed: see that file).
 */
function rpmStep(version) {
  return tauri('bundle', '--bundles', 'rpm', '--config', JSON.stringify({ version: installerVersion(version), bundle: { linux: { rpm: { release: rpmRelease(version) } } } }), '--config', MODEL_CONFIG)
}

/**
 * The overlay that bundles the app's model (Qwen2.5 1.5B Instruct, src/09_Cognition/siteModel.ts APP_MODEL) with its
 * LICENSE and NOTICE as resources under models/, from src-tauri/models/ (tools/web/siteModel.mjs app puts them there,
 * checked byte for byte); windows-app.yml passes the same file to the Windows installer. Never tauri.linux.conf.json:
 * Tauri merges that name into every Linux build by itself, the end-to-end test's tiny build among them.
 */
export const MODEL_CONFIG = 'src-tauri/tauri.model.conf.json'

/** The files the model overlay bundles (its resource sources, relative to src-tauri/), which must be there to build. */
export function modelResources() {
  return Object.keys(JSON.parse(readFileSync(join(ROOT, MODEL_CONFIG), 'utf8')).bundle.resources)
}

/** The model, its LICENSE and its NOTICE must be in src-tauri/models/ before a model-carrying build starts. */
function modelNeeds() {
  return modelResources().map((r) => ({ kind: 'need', path: join(ROOT, 'src-tauri', r), hint: 'node tools/web/siteModel.mjs app --from <the folder holding the app\'s model> puts it there, checked' }))
}

/**
 * A Linux desktop build: the runner compiled in (cargo feature native-runner: llama.cpp in the app's own process,
 * src-tauri/src/runner.rs), the model and its licence checked present, the .deb and the .AppImage with the model, the
 * staging copies of the model removed before the .rpm is packaged (the .deb's folder, the AppDir, the copy beside the
 * binary), then the .rpm.
 */
function linuxPlan(version) {
  const release = join(ROOT, 'src-tauri', 'target', 'release')
  return [
    ...modelNeeds(),
    tauri('build', '--config', NO_PAGE_BUILD, '--config', MODEL_CONFIG, '--features', 'native-runner', '--bundles', 'deb,appimage'),
    { kind: 'tidy', paths: () => [...dirsIn(join(release, 'bundle', 'deb')), ...dirsIn(join(release, 'bundle', 'appimage')), join(release, 'models')], what: 'the staging copies of the model (the .deb\'s folder, the AppDir, the copy beside the binary)' },
    rpmStep(version),
  ]
}

/**
 * The macOS app's lowest macOS (src-tauri/tauri.conf.json bundle.macOS.minimumSystemVersion): llama.cpp needs 10.15.
 * Read when asked, not when this file loads: current.yml loads it (through current.mjs) from a checkout of tools/
 * alone, where src-tauri/ is not.
 */
export function macMinimum() {
  return JSON.parse(readFileSync(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8')).bundle.macOS.minimumSystemVersion
}

/** The CMake file that sets llama.cpp's options for the Intel slice alone (its header says why and how). */
export const MAC_SLICES = 'tools/build/macos-slices.cmake'

/**
 * The environment of the macOS build, which reaches both slices' cargo builds alike (Tauri runs one per slice):
 * - CMAKE_PROJECT_ggml_INCLUDE: MAC_SLICES, which llama-cpp-sys-2 hands to CMake (it passes every CMAKE_* variable)
 *   and which acts on the x86_64 slice alone;
 * - GGML_SLICES_SHA256: that file's hash. llama-cpp-sys-2 rebuilds llama.cpp when a GGML_* variable changes, not a
 *   CMAKE_* one, so an edited MAC_SLICES rebuilds both slices instead of keeping a cached build of the old one (CMake
 *   reports the variable as unused);
 * - MACOSX_DEPLOYMENT_TARGET: macMinimum(), the value Tauri itself exports from minimumSystemVersion for the build, so
 *   rustc, cc and CMake (which reads it for CMAKE_OSX_DEPLOYMENT_TARGET) target the same macOS: ggml's
 *   std::filesystem needs 10.15, and the Intel slice's default would be 10.12;
 * - CMAKE_DISABLE_FIND_PACKAGE_OpenSSL: llama.cpp's HTTP library must not find a Homebrew OpenSSL (as on Linux).
 */
export function macEnv() {
  const slices = join(ROOT, MAC_SLICES)
  return {
    CMAKE_PROJECT_ggml_INCLUDE: slices,
    GGML_SLICES_SHA256: createHash('sha256').update(readFileSync(slices)).digest('hex'),
    MACOSX_DEPLOYMENT_TARGET: macMinimum(),
    CMAKE_DISABLE_FIND_PACKAGE_OpenSSL: 'ON',
  }
}

/** Where Tauri leaves the macOS bundles: `macos/<name>.app` and, moved there once it is whole, `dmg/<name>.dmg`. */
const macBundle = (...parts) => join(ROOT, 'src-tauri', 'target', TRIPLES.macUniversal, 'release', 'bundle', ...parts)

/**
 * Whether the macOS bundle step stopped at its disk image: an .app made since `began` (ms) and no .dmg in the dmg
 * folder. Tauri bundles the .app first and the .dmg last, with a script (bundle_dmg.sh, run in the .app's folder)
 * that copies the .app into a writable image `rw.<pid>.<name>.dmg`, mounts it, unmounts it (three tries, about six
 * seconds of patience) and compresses it; only a whole .dmg is moved into the dmg folder, which Tauri empties before
 * each try. A failed compile leaves no new .app, so it is not this, and is not tried again.
 */
export function dmgAlone({ began = 0, apps = macBundle('macos'), dmgs = macBundle('dmg') } = {}) {
  const names = (dir) => (existsSync(dir) ? readdirSync(dir) : [])
  // Two seconds of grace: a file system may keep a folder's time to the second.
  const fresh = names(apps).some((n) => n.endsWith('.app') && statSync(join(apps, n)).mtimeMs >= began - 2000)
  return fresh && !names(dmgs).some((n) => n.endsWith('.dmg'))
}

/**
 * Why the macOS bundle step is run again (the warning's words). Seen once on a hosted Mac (run 44983349249): the
 * script failed eleven seconds in, before its long compression, and left an image attached, while the same commit's
 * other macOS build passed. Tauri prints nothing of the script unless it is verbose, so the later tries are.
 */
export const DMG_WHY = 'the .app is made and the .dmg is not, as a hosted Mac does now and then to a disk image it has only just made'

/**
 * The disk images `hdiutil info` lists as attached whose file lies under one of `under` (folders), each with its
 * device: what a failed .dmg step can leave behind. hdiutil prints one block per image between lines of `=`, with
 * `image-path : <file>` and then the image's devices, one a line, `/dev/diskN` first. Pure, so that reading is pinned.
 */
export function leftImages(info, under) {
  const roots = under.map((u) => (u.endsWith('/') ? u : `${u}/`))
  const out = []
  for (const block of String(info).split(/^=+[ \t]*$/m)) {
    const image = /^image-path\s*:\s*(.+?)\s*$/m.exec(block)?.[1]
    const dev = /^(\/dev\/disk\d+)(?=\s|$)/m.exec(block)?.[1]
    if (image && dev && roots.some((r) => image.startsWith(r))) out.push({ image, dev })
  }
  return out
}

/** The working images a failed .dmg step leaves beside the .app: `rw.<pid>.<name>.dmg`. */
export const isWorkingImage = (name) => /^rw\.\d+\..+\.dmg$/.test(name)

/**
 * Before the macOS bundle step is run again: an image the failed try left attached is named and detached, and its
 * working file beside the .app (as large as the app) is removed, so the next try starts with nothing of the last one
 * mounted or kept. On another system it does nothing; with nothing left it says so.
 */
function detachLeft(say = console.log) {
  if (process.platform !== 'darwin') return
  const bundle = macBundle()
  const info = run('hdiutil', ['info'], { capture: true })
  if (!info.ok) say(`    hdiutil info did not run (${(info.err || info.out).trim() || 'no reason given'}): nothing is detached`)
  const left = info.ok ? leftImages(info.out, [bundle, join('/private', bundle)]) : []
  if (info.ok && left.length === 0) say('    no disk image of the failed try is still attached')
  for (const { image, dev } of left) {
    const r = run('hdiutil', ['detach', dev, '-force'], { capture: true })
    say(r.ok ? `    the failed try left ${basename(image)} attached at ${dev}: detached` : `    the failed try left ${basename(image)} attached at ${dev}, and it would not detach: ${(r.err || r.out).trim()}`)
  }
  const apps = macBundle('macos')
  for (const n of existsSync(apps) ? readdirSync(apps).filter(isWorkingImage) : []) {
    rmSync(join(apps, n), { force: true })
    say(`    removed the working image ${n}`)
  }
}

/**
 * The macOS build: the runner compiled into both slices of the universal binary (Metal on Apple silicon, the processor
 * alone on Intel: macEnv), the model and its licence checked present, the .app and the .dmg with the model, then the
 * copies of the model Tauri's build step leaves beside each slice's binary removed.
 */
function macPlan() {
  const release = (triple) => join(ROOT, 'src-tauri', 'target', triple, 'release')
  return [
    ...modelNeeds(),
    rustupTarget(TRIPLES.macArm64, TRIPLES.macX64),
    {
      ...tauri('build', '--config', NO_PAGE_BUILD, '--config', MODEL_CONFIG, '--features', 'native-runner', '--target', TRIPLES.macUniversal, '--bundles', 'app,dmg'),
      env: macEnv(), again: 2, when: dmgAlone, why: DMG_WHY, mend: detachLeft, louder: ['--verbose'],
    },
    { kind: 'tidy', paths: () => [join(release(TRIPLES.macArm64), 'models'), join(release(TRIPLES.macX64), 'models')], what: 'the copies of the model beside each slice\'s binary' },
  ]
}

/** The folders directly inside `dir` (none when it is missing). */
function dirsIn(dir) {
  return existsSync(dir) ? readdirSync(dir).map((n) => join(dir, n)).filter((p) => statSync(p).isDirectory()) : []
}

/** The Tauri CLI, run under this Node (no npm, no npx, no shell: the same on cmd.exe and sh). */
const TAURI = join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js')
/**
 * npm's own command-line script, run under this Node for the two mobile `init` steps and nothing else. The Android
 * and Xcode projects Tauri generates call the CLI back when Gradle or Xcode builds the Rust library, with the command
 * `init` was run through: under npm that is `npm run -- tauri <platform> <script>` (package.json's `tauri` script),
 * while a bare `node tauri.js` is recorded as `node tauri`, which is no file, and the build dies inside Gradle or
 * Xcode. The script is the one `npm run build:matrix` came from, else the npm installed beside this Node.
 */
function npmCli() {
  const bin = dirname(process.execPath)
  const candidates = [process.env.npm_execpath, join(bin, 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(bin, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]
  const found = candidates.find((c) => c && basename(c) === 'npm-cli.js' && existsSync(c))
  if (!found) throw new Error('npm-cli.js not found beside this Node: run `npm run build:matrix`')
  return found
}
/** The page is built once per run, so every later tauri step is told not to build it again. */
const NO_PAGE_BUILD = JSON.stringify({ build: { beforeBuildCommand: '' } })

/**
 * The ten targets, in the order the plan names them. `hosts`: the operating systems that build it (process.platform);
 * `arch`: the host architecture it needs (process.arch), absent where the host's architecture does not matter (a
 * cross-compiled or interpreted target); `tools`: the programs that must be on PATH; `env`: the variables that must be
 * set; `plan(ctx)`: the steps, each a program and its argument vector; `collect(ctx)`: the files it leaves, as
 * [source path, published name]; `move`: those files are moved into the output folder, not copied (the Linux packages
 * and the macOS .dmg, each carrying the model); `page`: false for a target that does not carry the page;
 * `unsupported`: the reason no machine builds it yet (none today). A program step may carry `env`, variables set for
 * that program alone (the macOS build's: macEnv). Besides programs, a plan's steps are `need` (a file that must be
 * there, with how to put it there) and `tidy` (folders removed once used).
 */
export const TARGETS = Object.freeze([
  {
    id: 'windows-x64', artifact: 'Windows x64: NSIS installer (.exe), .msi and the bare .exe', hosts: ['win32'], arch: 'x64',
    tools: ['cargo', 'rustup'],
    plan: ({ version }) => [tauri('build', '--config', desktopConfig(version), '--bundles', 'nsis,msi')],
    collect: ({ version }) => [
      ...globs(join(ROOT, 'src-tauri/target/release/bundle/nsis'), (n) => n.includes(`_${version}_`) && n.endsWith('-setup.exe')),
      ...globs(join(ROOT, 'src-tauri/target/release/bundle/msi'), (n) => n.includes(`_${version}_`) && n.endsWith('.msi')),
      ...globs(join(ROOT, 'src-tauri/target/release'), (n) => n.endsWith('.exe')).map(([p, n]) => [p, portableName(n, version, 'x64')]),
    ],
    note: 'the .msi\'s own version is the numbers alone (WiX takes no pre-release tag); windows-app.yml builds this target, its .msi included, on every pull request and push to main',
  },
  {
    id: 'windows-arm64', artifact: 'Windows arm64: NSIS installer (.exe), .msi and the bare .exe, cross-compiled on Windows x64', hosts: ['win32'],
    tools: ['cargo', 'rustup'],
    plan: ({ version }) => [rustupTarget(TRIPLES.windowsArm64), tauri('build', '--config', desktopConfig(version), '--target', TRIPLES.windowsArm64, '--bundles', 'nsis,msi')],
    collect: ({ version }) => [
      ...globs(join(ROOT, `src-tauri/target/${TRIPLES.windowsArm64}/release/bundle/nsis`), (n) => n.includes(`_${version}_`) && n.endsWith('-setup.exe')),
      ...globs(join(ROOT, `src-tauri/target/${TRIPLES.windowsArm64}/release/bundle/msi`), (n) => n.includes(`_${version}_`) && n.endsWith('.msi')),
      ...globs(join(ROOT, `src-tauri/target/${TRIPLES.windowsArm64}/release`), (n) => n.endsWith('.exe')).map(([p, n]) => [p, portableName(n, version, 'arm64')]),
    ],
    note: 'the .msi\'s own version is the numbers alone (WiX takes no pre-release tag); not run on a Windows on Arm machine yet',
  },
  {
    id: 'linux-x64', artifact: 'Linux x64: .deb, .rpm and .AppImage, each carrying the app\'s model and running it in the app', hosts: ['linux'], arch: 'x64',
    tools: ['cargo', 'rustup', 'pkg-config', 'cmake'],
    plan: ({ version }) => linuxPlan(version),
    collect: () => linuxFiles(),
    move: true,
    note: 'needs WebKitGTK 4.1 and GTK 3 development packages, cmake and libclang (build-matrix.yml installs them, on Ubuntu 22.04 for glibc 2.35), and the model in src-tauri/models/ (tools/web/siteModel.mjs app); the .rpm is Version 1.0.0, Release 0.stable.beta (rpm takes no hyphen in a version); WebGPU in WebKitGTK is not verified',
  },
  {
    id: 'linux-arm64', artifact: 'Linux arm64: .deb, .rpm and .AppImage, built on an arm64 machine, each carrying the app\'s model', hosts: ['linux'], arch: 'arm64',
    tools: ['cargo', 'rustup', 'pkg-config', 'cmake'],
    plan: ({ version }) => linuxPlan(version),
    collect: () => linuxFiles(),
    move: true,
    note: 'no cross-compilation (WebKitGTK must be the target\'s own): build-matrix.yml runs it on ubuntu-22.04-arm; llama.cpp is built for the base armv8-a there, so it runs on every 64-bit Arm board but more slowly (not measured)',
  },
  {
    id: 'macos-universal', artifact: 'macOS universal (Apple silicon and Intel in one): .app (zipped) and .dmg, unsigned, each carrying the app\'s model and running it in the app', hosts: ['darwin'],
    tools: ['cargo', 'rustup', 'xcodebuild', 'cmake'],
    plan: () => macPlan(),
    collect: ({ out }) => [
      ...globs(join(ROOT, `src-tauri/target/${TRIPLES.macUniversal}/release/bundle/dmg`), (n) => n.endsWith('.dmg')),
      ...globs(join(ROOT, `src-tauri/target/${TRIPLES.macUniversal}/release/bundle/macos`), (n) => n.endsWith('.app')).map(([p, n]) => [zipDir(p, join(out, 'macos-universal'), `${n}.zip`), `${n}.zip`]),
    ],
    move: true,
    note: 'unsigned and not notarized (no Apple Developer account): Gatekeeper refuses it at first: run `xattr -dr com.apple.quarantine` on the .app, or use Privacy & Security > Open Anyway (macOS 15 on; right-click > Open up to macOS 14); not tried on a Mac; macOS 11 or later; the plan puts the model on Metal on Apple silicon and on the processor alone on an Intel Mac with AVX2; not run on a Mac yet',
  },
  {
    id: 'android-apk', artifact: 'Android (arm64-v8a): .apk, signed with the debug key unless CRIMSON_ANDROID_KEYSTORE names one', hosts: ['linux', 'darwin', 'win32'],
    tools: ['cargo', 'rustup'], env: ['ANDROID_HOME', 'NDK_HOME', 'JAVA_HOME'],
    plan: () => [
      rustupTarget(TRIPLES.android),
      tauriInit('android'),
      fetches(tauri('android', 'build', '--ci', '--config', NO_PAGE_BUILD, '--apk', '--target', 'aarch64')),
      { kind: 'sign-apk' },
    ],
    collect: ({ out }) => globs(join(out, 'android-apk'), (n) => n.endsWith('.apk')),
    note: 'WebGPU in the Android System WebView needs Android 12 or later and a current WebView; not run on a phone yet',
  },
  {
    id: 'ios-ipa', artifact: 'iOS (arm64): .ipa, unsigned (Xcode\'s archive with code signing off)', hosts: ['darwin'],
    tools: ['cargo', 'rustup', 'xcodebuild'],
    // Tauri drives xcodebuild itself: the project's "Build Rust Code" phase asks the running `tauri ios build` for its
    // options over a local socket, so xcodebuild run by hand fails at once; `--no-sign` archives with code signing off
    // and zips Payload/<app>.app into gen/apple/build/arm64/<product name>.ipa.
    plan: () => [rustupTarget(TRIPLES.ios), tauriInit('ios'), fetches(tauri('ios', 'build', '--ci', '--no-sign', '--config', NO_PAGE_BUILD, '--target', 'aarch64'))],
    collect: ({ version }) => globs(join(ROOT, 'src-tauri/gen/apple/build/arm64'), (n) => n.endsWith('.ipa')).slice(0, 1).map(([p]) => [p, `crimson-noir-agent-city_${version}_ios-arm64-unsigned.ipa`]),
    note: 'cannot be installed as it is: a device needs it re-signed (a free Apple ID with a sideloading tool, seven days at a time; a paid account for TestFlight or the App Store); the iPhone home-screen web copy (MANUAL.md, On an iPhone) needs none of that; built on a macOS runner by the workflow, not run on a device',
  },
  {
    id: 'uefi-x64', artifact: 'Crimson Noir OS, UEFI x86-64: BOOTX64.EFI, and the .img and .iso media where sh, mtools, sgdisk and xorriso are installed', hosts: ['linux', 'darwin', 'win32'],
    tools: ['cargo', 'rustup'], page: false,
    plan: ({ media }) => [
      rustupTarget(TRIPLES.uefiX64),
      step('cargo', ['build', '--locked', '-p', 'crimson_boot', '--target', TRIPLES.uefiX64, '--release'], { cwd: join(ROOT, 'crimson_noir_os') }),
      ...(media ? [step('sh', ['tools/build-image.sh', join('target', 'image')], { cwd: join(ROOT, 'crimson_noir_os') })] : []),
    ],
    collect: ({ media }) => [
      [join(ROOT, `crimson_noir_os/target/${TRIPLES.uefiX64}/release/crimson_boot.efi`), 'BOOTX64.EFI'],
      ...(media ? [[join(ROOT, 'crimson_noir_os/target/image/crimson_noir_os.img'), 'crimson_noir_os.img'], [join(ROOT, 'crimson_noir_os/target/image/crimson_noir_os.iso'), 'crimson_noir_os.iso']] : []),
    ],
    note: 'the release media come from build-release.yml, which bakes twice, compares the bytes and boots the image in QEMU; build-matrix.yml boots this build in QEMU too',
  },
  {
    id: 'uefi-arm64', artifact: 'Crimson Noir OS, UEFI aarch64: BOOTAA64.EFI, and the .img and .iso media where sh, mtools, sgdisk and xorriso are installed', hosts: ['linux', 'darwin', 'win32'],
    tools: ['cargo', 'rustup'], page: false,
    plan: ({ media }) => [
      rustupTarget(TRIPLES.uefiArm64),
      step('cargo', ['build', '--locked', '-p', 'crimson_boot', '--target', TRIPLES.uefiArm64, '--release'], { cwd: join(ROOT, 'crimson_noir_os') }),
      ...(media ? [step('sh', ['tools/build-image.sh', join('target', 'image-aarch64'), TRIPLES.uefiArm64], { cwd: join(ROOT, 'crimson_noir_os') })] : []),
    ],
    collect: ({ media }) => [
      [join(ROOT, `crimson_noir_os/target/${TRIPLES.uefiArm64}/release/crimson_boot.efi`), 'BOOTAA64.EFI'],
      ...(media ? [[join(ROOT, 'crimson_noir_os/target/image-aarch64/crimson_noir_os.img'), 'crimson_noir_os-aarch64.img'], [join(ROOT, 'crimson_noir_os/target/image-aarch64/crimson_noir_os.iso'), 'crimson_noir_os-aarch64.iso']] : []),
    ],
    note: 'the same system as x86-64 (crimson_noir_os/boot/src/arch/aarch64.rs is the machine layer: the UART the firmware\'s ACPI SPCR table names, the generic timer, the image\'s own exception vectors); the keyboard is the serial console (an Arm machine has no PS/2 controller and the image has no USB stack); build-matrix.yml boots it on QEMU\'s Arm virt machine with edk2; not run on Arm hardware yet',
  },
  {
    id: 'uefi-riscv64', artifact: 'Crimson Noir OS, UEFI riscv64: BOOTRISCV64.EFI, and the .img and .iso media where sh, mtools, sgdisk and xorriso are installed', hosts: ['linux', 'darwin', 'win32'],
    tools: ['cargo', 'rustup'], page: false,
    plan: ({ media }) => [
      rustupTarget(TRIPLES.uefiRiscv64),
      step('cargo', ['build', '--locked', '-p', 'crimson_boot', '--target', TRIPLES.uefiRiscv64, '--release'], { cwd: join(ROOT, 'crimson_noir_os') }),
      ...(media ? [step('sh', ['tools/build-image.sh', join('target', 'image-riscv64'), TRIPLES.uefiRiscv64], { cwd: join(ROOT, 'crimson_noir_os') })] : []),
    ],
    // The linker writes the finished UEFI application itself, under the name a bare-metal program gets (no .efi).
    collect: ({ media }) => [
      [join(ROOT, `crimson_noir_os/target/${TRIPLES.uefiRiscv64}/release/crimson_boot`), 'BOOTRISCV64.EFI'],
      ...(media ? [[join(ROOT, 'crimson_noir_os/target/image-riscv64/crimson_noir_os.img'), 'crimson_noir_os-riscv64.img'], [join(ROOT, 'crimson_noir_os/target/image-riscv64/crimson_noir_os.iso'), 'crimson_noir_os-riscv64.iso']] : []),
    ],
    note: 'the same system as x86-64 (crimson_noir_os/boot/src/arch/riscv64.rs is the machine layer and carries the PE header, since Rust has no riscv64 UEFI target: the SBI console, the time CSR, the image\'s own trap vector); the keyboard is the serial console; the firmware must offer a framebuffer (GOP), which many RISC-V boards do not; build-matrix.yml bakes the media twice, compares the bytes and boots them on QEMU\'s RISC-V virt machine with edk2; not run on a RISC-V machine',
  },
])

/** A Linux build's files: the .deb, the .rpm and the .AppImage. */
function linuxFiles() {
  const b = join(ROOT, 'src-tauri/target/release/bundle')
  return [...globs(join(b, 'deb'), (n) => n.endsWith('.deb')), ...globs(join(b, 'rpm'), (n) => n.endsWith('.rpm')), ...globs(join(b, 'appimage'), (n) => n.endsWith('.AppImage'))]
}

export const IDS = Object.freeze(TARGETS.map((t) => t.id))

function step(cmd, argv, extra = {}) { return { kind: 'run', cmd, argv, ...extra } }
function tauri(...argv) { return step(process.execPath, [TAURI, ...argv]) }
/** `tauri <android|ios> init` through npm (npmCli above says why), non-interactive, the Rust targets added by rustupTarget. */
function tauriInit(platform) { return step(process.execPath, [npmCli(), 'run', '--', 'tauri', platform, 'init', '--ci', '--skip-targets-install']) }
/**
 * A step that downloads as it runs (rustup's targets; Gradle's packages inside an Android build, the Swift and Rust
 * ones inside an iOS build): when it fails it is run again, `again` more times, a minute apart. A package host that
 * answers 429 or drops a connection is not the build's failure, and without this one busy minute at such a host
 * leaves that target's download a commit behind. A build that is really broken fails each time, and so still fails.
 */
function fetches(s, again = 1) { return { ...s, again } }
/** How long a step waits before it is run again, ms. */
export const AGAIN_MS = 60_000
/** Why a step that downloads is run again (the warning's words). */
const FETCH_WHY = 'it downloads as it runs'

/**
 * Runs a step, and runs it again while it fails and may be: `again` more times at most, a pause before each, and
 * only while `when` (if the step has one; it is told when the step began) says the failure is the kind another try
 * can mend. Before each new try the step's `mend` clears what the last one left, and the try takes the step's
 * `louder` arguments as well, so a failure that stays says more about itself than the first did. `once(argv)` runs
 * the step and answers `{ ok }`; what the last try answered is returned, so a failure that stays is still the
 * target's.
 */
export function tried(s, once, { id = '', pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), say = console.log, now = Date.now } = {}) {
  const began = now()
  let r = once(s.argv)
  for (let left = s.again ?? 0; !r.ok && left > 0 && (s.when?.({ began }) ?? true); left--) {
    say(`::warning::${id}: ${show(s.cmd, s.argv, s.cwd)} failed; ${s.why ?? FETCH_WHY}, so it is run again in ${AGAIN_MS / 1000} s (${left} more ${left === 1 ? 'try' : 'tries'})`)
    s.mend?.(say)
    pause(AGAIN_MS)
    r = once(s.louder ? [...s.argv, ...s.louder] : s.argv)
  }
  return r
}
function rustupTarget(...triples) { return fetches(step('rustup', ['target', 'add', ...triples]), 2) }

/** Moves a file, by renaming it where both paths are on one file system and by copying and deleting it elsewhere. */
function moveFile(from, to) {
  rmSync(to, { recursive: true, force: true })
  try {
    renameSync(from, to)
  } catch (e) {
    if (e?.code !== 'EXDEV') throw e
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/** Files in `dir` whose names pass `keep`, as [path, name]; none when the directory is missing. */
function globs(dir, keep) {
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(keep).map((n) => [join(dir, n), n])
}

/** Whether `cmd` is on PATH (`where` on Windows, `command -v` elsewhere, both without a shell for the program itself). */
export function onPath(cmd) {
  const r = WINDOWS ? spawnSync('where', [cmd], { encoding: 'utf8' }) : spawnSync('sh', ['-c', 'command -v -- "$1"', 'sh', cmd], { encoding: 'utf8' })
  return !r.error && r.status === 0
}

/**
 * Why this machine cannot build a target, or null when it can: the operating system, the architecture, a missing
 * program, an unset variable. `host` lets a test ask about another machine.
 */
export function blocker(t, host = { platform: process.platform, arch: process.arch, env: process.env, has: onPath }) {
  if (t.unsupported) return `unsupported: ${t.unsupported}`
  if (!t.hosts.includes(host.platform)) return `builds on ${t.hosts.map(osName).join(' or ')}, not on ${osName(host.platform)}`
  if (t.arch && t.arch !== host.arch) return `needs a ${t.arch} machine (this one is ${host.arch})`
  for (const v of t.env ?? []) if (!host.env[v]) return `needs the ${v} environment variable`
  for (const c of t.tools ?? []) if (!host.has(c)) return `needs ${c} on PATH`
  return null
}

function osName(p) { return { win32: 'Windows', linux: 'Linux', darwin: 'macOS' }[p] ?? p }

/** Runs a program with an argument vector (never a shell); inherits the terminal unless `capture`. */
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit', ...opts })
  if (r.error) return { ok: false, out: '', err: r.error.message }
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '' }
}

const show = (cmd, argv, cwd) => `${cwd && cwd !== ROOT ? `(in ${relative(ROOT, cwd)}) ` : ''}${basename(cmd)} ${argv.map((a) => (/[\s"{}]/.test(a) ? JSON.stringify(a) : a)).join(' ')}`

/**
 * The ditto arguments that zip the macOS .app: its resource forks and permissions kept, and stored, not deflated
 * (--zlibCompressionLevel 0): the app is mostly the model, which does not compress, and the upload stores it as it is.
 */
export function zipArgs(dir, zip) {
  return ['-c', '-k', '--keepParent', '--zlibCompressionLevel', '0', dir, zip]
}

/** The macOS .app (a directory) as one zip, with ditto (zipArgs). */
function zipDir(dir, outDir, name) {
  mkdirSync(outDir, { recursive: true })
  const zip = join(outDir, name)
  rmSync(zip, { force: true })
  const r = run('ditto', zipArgs(dir, zip))
  if (!r.ok) throw new Error(`ditto could not zip ${dir}: ${r.err || r.out}`)
  return zip
}

/** The newest build-tools folder of the Android SDK (apksigner and zipalign live there). */
function buildTools(sdk) {
  const dir = join(sdk, 'build-tools')
  if (!existsSync(dir)) return null
  const versions = readdirSync(dir).filter((n) => /^\d+\.\d+\.\d+/.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
  return versions.length ? join(dir, versions[0]) : null
}

/**
 * The release .apk Gradle left unsigned, aligned and signed: with the keystore CRIMSON_ANDROID_KEYSTORE names (its
 * password in CRIMSON_ANDROID_KEYSTORE_PASSWORD, its alias in CRIMSON_ANDROID_KEY_ALIAS, the key's password in
 * CRIMSON_ANDROID_KEY_PASSWORD or the keystore's), or with the Android debug key (~/.android/debug.keystore, made
 * with keytool when missing, as Android Studio makes it), which a phone with "install unknown apps" accepts.
 */
function signApk(ctx) {
  const apkDir = join(ROOT, 'src-tauri/gen/android/app/build/outputs/apk')
  const unsigned = walk(apkDir).filter((p) => p.endsWith('.apk') && /release/.test(p))
  if (unsigned.length === 0) throw new Error(`no release .apk under ${relative(ROOT, apkDir)}`)
  const tools = buildTools(process.env.ANDROID_HOME)
  if (!tools) throw new Error(`no build-tools under ${process.env.ANDROID_HOME}: sdkmanager "build-tools;35.0.0"`)
  const ext = WINDOWS ? '.bat' : ''
  const keytool = join(process.env.JAVA_HOME, 'bin', WINDOWS ? 'keytool.exe' : 'keytool')
  let ks = process.env.CRIMSON_ANDROID_KEYSTORE, ksPass = process.env.CRIMSON_ANDROID_KEYSTORE_PASSWORD, alias = process.env.CRIMSON_ANDROID_KEY_ALIAS, keyPass = process.env.CRIMSON_ANDROID_KEY_PASSWORD ?? ksPass
  let suffix = ''
  if (!ks) {
    ks = join(homedir(), '.android', 'debug.keystore'); ksPass = 'android'; alias = 'androiddebugkey'; keyPass = 'android'; suffix = '-debugsigned'
    if (!existsSync(ks)) {
      mkdirSync(dirname(ks), { recursive: true })
      const r = run(keytool, ['-genkeypair', '-keystore', ks, '-storepass', ksPass, '-alias', alias, '-keypass', keyPass, '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-dname', 'CN=Android Debug,O=Android,C=US'])
      if (!r.ok) throw new Error('keytool could not make the debug keystore')
    }
  } else if (!ksPass || !alias) throw new Error('CRIMSON_ANDROID_KEYSTORE needs CRIMSON_ANDROID_KEYSTORE_PASSWORD and CRIMSON_ANDROID_KEY_ALIAS beside it')
  const outDir = join(ctx.out, 'android-apk')
  mkdirSync(outDir, { recursive: true })
  for (const apk of unsigned) {
    const aligned = join(tmpdir(), `${basename(apk, '.apk')}-aligned.apk`)
    rmSync(aligned, { force: true })
    const z = run(join(tools, `zipalign${WINDOWS ? '.exe' : ''}`), ['-f', '-p', '4', apk, aligned])
    if (!z.ok) throw new Error(`zipalign failed on ${basename(apk)}`)
    const name = `crimson-noir-agent-city_${ctx.version}_arm64-v8a${suffix}.apk`
    const s = run(join(tools, `apksigner${ext}`), ['sign', '--ks', ks, '--ks-pass', `pass:${ksPass}`, '--ks-key-alias', alias, '--key-pass', `pass:${keyPass}`, '--out', join(outDir, name), aligned])
    if (!s.ok) throw new Error(`apksigner failed on ${basename(apk)}`)
    rmSync(aligned, { force: true })
  }
}

function walk(dir) {
  if (!existsSync(dir)) return []
  const out = []
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    out.push(p)
    if (statSync(p).isDirectory()) out.push(...walk(p))
  }
  return out
}

/** The page: tsc -b, then vite build, as `npm run build` runs them, under this Node. */
function buildPage(dryRun) {
  const steps = [step(process.execPath, [join(ROOT, 'node_modules/typescript/bin/tsc'), '-b']), step(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'])]
  for (const s of steps) {
    console.log(`  page: ${show(s.cmd, s.argv)}`)
    if (dryRun) continue
    const r = run(s.cmd, s.argv)
    if (!r.ok) throw new Error('the page did not build')
  }
}

/** The targets `--targets` names: ids, `all` (every target), or `host` (this machine's desktop app and the UEFI application). */
export function select(spec, host = { platform: process.platform, arch: process.arch }) {
  if (spec === 'all') return { targets: [...TARGETS], named: false }
  if (spec === 'host' || spec === undefined) {
    const desktop = { win32: 'windows-x64', linux: host.arch === 'arm64' ? 'linux-arm64' : 'linux-x64', darwin: 'macos-universal' }[host.platform]
    return { targets: TARGETS.filter((t) => t.id === desktop || t.id === 'uefi-x64'), named: false }
  }
  const ids = spec.split(',').map((s) => s.trim()).filter(Boolean)
  const unknown = ids.filter((id) => !IDS.includes(id))
  if (unknown.length) throw new Error(`unknown target${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')} (one of ${IDS.join(', ')}, all, host)`)
  return { targets: ids.map((id) => TARGETS.find((t) => t.id === id)), named: true }
}

/** `--list`: every target, what it makes, where it builds, and whether this machine can. */
export function listLines(host) {
  return TARGETS.map((t) => {
    const why = blocker(t, host)
    const where = t.unsupported ? 'nowhere yet' : t.hosts.map(osName).join(', ') + (t.arch ? ` (${t.arch})` : '')
    return `${t.id.padEnd(16)} ${why ? (t.unsupported ? 'unsupported' : 'not here   ') : 'ready      '}  ${where.padEnd(24)} ${t.artifact}${why ? `\n${''.padEnd(17)}${why}` : ''}`
  })
}

/**
 * `--summary <dir>`: the ten targets as a Markdown table from the reports the workflow's jobs left (<dir>/<artifact>/matrix.json,
 * one folder per downloaded artifact), for the run's summary: built (with the files), failed or skipped (with the
 * reason), unsupported, the one target another workflow builds, and a job that left no report.
 */
export function summaryLines(dir) {
  const reports = new Map()
  for (const f of walk(dir).filter((p) => basename(p) === 'matrix.json')) {
    for (const r of JSON.parse(readFileSync(f, 'utf8')).results ?? []) reports.set(r.id, r)
  }
  const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ')
  const rows = TARGETS.map((t) => {
    const r = reports.get(t.id)
    const [state, detail] = t.unsupported ? ['unsupported', t.unsupported]
      : r?.status === 'built' ? ['built', r.files.join(', ')]
      : r?.status === 'failed' ? ['failed', r.reason]
      : r?.status === 'skipped' ? ['skipped', r.reason]
      : t.id === 'windows-x64' ? ['built elsewhere', 'windows-app.yml builds it on every pull request and push to main (artifacts windows-installer-*, windows-msi-*, windows-portable-*)']
      : ['no report', 'the job did not finish, or left no report']
    return `| \`${t.id}\` | ${state} | ${cell(t.artifact)} | ${cell(detail)} |`
  })
  return ['## Build matrix', '', '| Target | State | Makes | Detail |', '| :--- | :--- | :--- | :--- |', ...rows, '', 'Nothing here is signed: tools/build/matrix.mjs and MANUAL.md (The build matrix) say what each file needs to run.']
}

export function main(argv) {
  const arg = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }
  const flag = (name) => argv.includes(`--${name}`)
  if (flag('help') || argv.includes('-h')) {
    console.log('usage: node tools/build/matrix.mjs [--list] [--targets <id,...>|all|host] [--out <dir>] [--dry-run] [--skip-page] [--summary <reports dir>]')
    return 0
  }
  if (flag('list')) { for (const l of listLines()) console.log(l); return 0 }
  if (arg('summary')) { for (const l of summaryLines(resolve(arg('summary')))) console.log(l); return 0 }
  const dryRun = flag('dry-run')
  const out = resolve(arg('out') ?? join(ROOT, 'out', 'matrix'))
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version
  let selected
  try { selected = select(arg('targets')) } catch (e) { console.error(e.message); return 1 }
  const media = !WINDOWS && ['sh', 'mformat', 'sgdisk', 'xorriso'].every(onPath)
  const ctx = { out, version, media, dryRun }
  const results = []
  let failed = false
  const todo = []
  for (const t of selected.targets) {
    const why = blocker(t)
    if (why) {
      console.log(`${t.id}: skipped: ${why}`)
      results.push({ id: t.id, status: t.unsupported ? 'unsupported' : 'skipped', reason: why, files: [] })
      if (selected.named) failed = true
    } else todo.push(t)
  }
  if (todo.length) {
    console.log(`version ${version}; targets: ${todo.map((t) => t.id).join(', ')}; out: ${relative(ROOT, out) || '.'}${dryRun ? ' (dry run)' : ''}`)
    try {
      if (flag('skip-page')) console.log('  page: kept (--skip-page)')
      else if (todo.every((t) => t.page === false)) console.log('  page: not needed (no target here carries it)')
      else buildPage(dryRun)
    } catch (e) {
      console.error(`::error::${e.message}`)
      return 1
    }
  }
  for (const t of todo) {
    console.log(`${t.id}:`)
    const files = []
    try {
      for (const s of t.plan(ctx)) {
        if (s.kind === 'run') {
          console.log(`  ${show(s.cmd, s.argv, s.cwd)}`)
          for (const [k, v] of Object.entries(s.env ?? {})) console.log(`    with ${k}=${v}`)
          if (dryRun) continue
          // A step that downloads, and the macOS bundle step, are run again before they fail the target (tried).
          const r = tried(s, (argv) => run(s.cmd, argv, { cwd: s.cwd ?? ROOT, env: { ...process.env, ...(s.env ?? {}) } }), { id: t.id })
          if (!r.ok) throw new Error(`${show(s.cmd, s.argv, s.cwd)} failed`)
        } else if (s.kind === 'need') {
          console.log(`  need ${relative(ROOT, s.path)}`)
          if (!dryRun && !existsSync(s.path)) throw new Error(`${relative(ROOT, s.path)} is missing: ${s.hint}`)
        } else if (s.kind === 'tidy') {
          console.log(`  remove ${s.what}`)
          if (!dryRun) for (const p of s.paths()) { rmSync(p, { recursive: true, force: true }); console.log(`    removed ${relative(ROOT, p)}`) }
        } else if (s.kind === 'sign-apk') {
          console.log('  sign the .apk (zipalign, apksigner)')
          if (!dryRun) signApk(ctx)
        }
      }
      if (!dryRun) {
        const dir = join(out, t.id)
        mkdirSync(dir, { recursive: true })
        for (const [from, name] of t.collect(ctx)) {
          if (!existsSync(from)) throw new Error(`expected ${relative(ROOT, from)} after the build`)
          const to = join(dir, name)
          // A model-carrying package is moved, not copied (a second gigabyte on the runner's disk for nothing).
          if (resolve(from) !== resolve(to)) (t.move ? moveFile : (a, b) => cpSync(a, b, { recursive: true }))(from, to)
          files.push(name)
          console.log(`  -> ${relative(ROOT, to)} (${(statSync(to).size / 2 ** 20).toFixed(1)} MiB)`)
        }
        if (files.length === 0) throw new Error('the build left no file to collect')
      }
      results.push({ id: t.id, status: dryRun ? 'planned' : 'built', files, ...(t.note && { note: t.note }) })
    } catch (e) {
      console.error(`::error::${t.id}: ${e.message}`)
      results.push({ id: t.id, status: 'failed', reason: e.message, files })
      failed = true
    }
  }
  if (!dryRun && results.length) {
    mkdirSync(out, { recursive: true })
    writeFileSync(join(out, 'matrix.json'), `${JSON.stringify({ version, host: `${process.platform}-${process.arch}`, results }, null, 2)}\n`)
  }
  for (const r of results) console.log(`${r.status.padEnd(11)} ${r.id}${r.files.length ? `  ${r.files.join(', ')}` : ''}${r.reason ? `  (${r.reason})` : ''}`)
  return failed ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)))
