#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the one command that builds every shipped form of Crimson Noir: Agent City from this
 * checkout, on the machine that can build it: `npm run build:matrix [-- --targets <ids>|all|host] [--out <dir>]
 * [--dry-run] [--list] [--skip-page]`. Nine targets (TARGETS below): the desktop app for Windows x64 and arm64 (the
 * NSIS installer, the .msi and the bare .exe), Linux x64 and arm64 (.deb, .rpm and .AppImage), macOS (one universal
 * .app and .dmg), the Android .apk, the iOS .ipa, and Crimson Noir OS's UEFI application for x86-64 and for aarch64
 * (and their bootable media where the media tools are installed). The page (dist/index.html) is built once, for the
 * targets that carry it (the UEFI application does not), and every app is a Tauri 2 shell around it (src-tauri). The
 * version 1.0.0-stable-beta carries a pre-release tag, which WiX and rpm refuse in a version: the .msi takes the
 * numbers alone (1.0.0) and the .rpm the numbers as its Version with the tag in its Release (0.stable.beta), while
 * the app inside each says its full version (installerVersion, rpmRelease). Nothing here is signed: the Windows and Linux
 * files run as they are; the macOS app is unsigned (open it with right-click › Open the first time), the .apk is
 * signed with the Android debug key unless CRIMSON_ANDROID_KEYSTORE names a keystore, and the .ipa is unsigned (a
 * free Apple ID and a sideloading tool re-sign it; the App Store needs a paid account). Which browser engine the
 * shell gets, and whether it has WebGPU, is the platform's: WebView2 on Windows, WebKitGTK on Linux, WKWebView on
 * macOS and iOS, the Android System WebView; only Windows has been run so far (MANUAL.md, The build matrix).
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
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
 * after its patch), so the installer's version can be the numbers alone while the app inside says its own.
 */
function rpmStep(version) {
  return tauri('bundle', '--bundles', 'rpm', '--config', JSON.stringify({ version: installerVersion(version), bundle: { linux: { rpm: { release: rpmRelease(version) } } } }))
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
 * The nine targets, in the order the plan names them. `hosts`: the operating systems that build it (process.platform);
 * `arch`: the host architecture it needs (process.arch), absent where the host's architecture does not matter (a
 * cross-compiled or interpreted target); `tools`: the programs that must be on PATH; `env`: the variables that must be
 * set; `plan(ctx)`: the steps, each a program and its argument vector; `collect(ctx)`: the files it leaves, as
 * [source path, published name]; `page`: false for a target that does not carry the page; `unsupported`: the reason no
 * machine builds it yet (none today).
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
    id: 'linux-x64', artifact: 'Linux x64: .deb, .rpm and .AppImage', hosts: ['linux'], arch: 'x64',
    tools: ['cargo', 'rustup', 'pkg-config'],
    plan: ({ version }) => [tauri('build', '--config', NO_PAGE_BUILD, '--bundles', 'deb,appimage'), rpmStep(version)],
    collect: () => linuxFiles(),
    note: 'needs WebKitGTK 4.1 and GTK 3 development packages (build-matrix.yml installs them); the .rpm is Version 1.0.0, Release 0.stable.beta (rpm takes no hyphen in a version); WebGPU in WebKitGTK is not verified',
  },
  {
    id: 'linux-arm64', artifact: 'Linux arm64: .deb, .rpm and .AppImage, built on an arm64 machine', hosts: ['linux'], arch: 'arm64',
    tools: ['cargo', 'rustup', 'pkg-config'],
    plan: ({ version }) => [tauri('build', '--config', NO_PAGE_BUILD, '--bundles', 'deb,appimage'), rpmStep(version)],
    collect: () => linuxFiles(),
    note: 'no cross-compilation (WebKitGTK must be the target\'s own): build-matrix.yml runs it on ubuntu-24.04-arm',
  },
  {
    id: 'macos-universal', artifact: 'macOS universal (Apple silicon and Intel in one): .app (zipped) and .dmg, unsigned', hosts: ['darwin'],
    tools: ['cargo', 'rustup', 'xcodebuild'],
    plan: () => [rustupTarget(TRIPLES.macArm64, TRIPLES.macX64), tauri('build', '--config', NO_PAGE_BUILD, '--target', TRIPLES.macUniversal, '--bundles', 'app,dmg')],
    collect: ({ out }) => [
      ...globs(join(ROOT, `src-tauri/target/${TRIPLES.macUniversal}/release/bundle/dmg`), (n) => n.endsWith('.dmg')),
      ...globs(join(ROOT, `src-tauri/target/${TRIPLES.macUniversal}/release/bundle/macos`), (n) => n.endsWith('.app')).map(([p, n]) => [zipDir(p, join(out, 'macos-universal'), `${n}.zip`), `${n}.zip`]),
    ],
    note: 'unsigned and not notarized (no Apple Developer account): Gatekeeper asks once; open it with right-click > Open, or `xattr -d com.apple.quarantine`; not run on a Mac yet',
  },
  {
    id: 'android-apk', artifact: 'Android (arm64-v8a): .apk, signed with the debug key unless CRIMSON_ANDROID_KEYSTORE names one', hosts: ['linux', 'darwin', 'win32'],
    tools: ['cargo', 'rustup'], env: ['ANDROID_HOME', 'NDK_HOME', 'JAVA_HOME'],
    plan: () => [
      rustupTarget(TRIPLES.android),
      tauriInit('android'),
      tauri('android', 'build', '--ci', '--config', NO_PAGE_BUILD, '--apk', '--target', 'aarch64'),
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
    plan: () => [rustupTarget(TRIPLES.ios), tauriInit('ios'), tauri('ios', 'build', '--ci', '--no-sign', '--config', NO_PAGE_BUILD, '--target', 'aarch64')],
    collect: ({ version }) => globs(join(ROOT, 'src-tauri/gen/apple/build/arm64'), (n) => n.endsWith('.ipa')).slice(0, 1).map(([p]) => [p, `crimson-noir-agent-city_${version}_ios-arm64-unsigned.ipa`]),
    note: 'cannot be installed as it is: a device needs it re-signed (a free Apple ID with a sideloading tool, seven days at a time; a paid account for TestFlight or the App Store); the iPhone home-screen web copy (MANUAL.md, On an iPhone) needs none of that; not run on a Mac yet',
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
function rustupTarget(...triples) { return step('rustup', ['target', 'add', ...triples]) }

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

/** The macOS .app (a directory) as one zip, with ditto (keeps the bundle's resource forks and permissions). */
function zipDir(dir, outDir, name) {
  mkdirSync(outDir, { recursive: true })
  const zip = join(outDir, name)
  rmSync(zip, { force: true })
  const r = run('ditto', ['-c', '-k', '--keepParent', dir, zip])
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
 * `--summary <dir>`: the nine targets as a Markdown table from the reports the workflow's jobs left (<dir>/<artifact>/matrix.json,
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
          if (dryRun) continue
          const r = run(s.cmd, s.argv, { cwd: s.cwd ?? ROOT, env: { ...process.env, ...(s.env ?? {}) } })
          if (!r.ok) throw new Error(`${show(s.cmd, s.argv, s.cwd)} failed`)
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
          if (resolve(from) !== resolve(to)) cpSync(from, to, { recursive: true })
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
