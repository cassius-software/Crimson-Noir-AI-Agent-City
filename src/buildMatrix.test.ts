// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the cross-platform build matrix (tools/build/matrix.mjs, `npm run build:matrix`,
 * .github/workflows/build-matrix.yml): the ten targets in the plan's order, each a program and an argument vector
 * (never a shell line, so cmd.exe and sh run the same thing), the page built once and never again by a Tauri step
 * (and not at all for the UEFI application alone), the installers' own version beside the app's pre-release one (the
 * .msi's WiX version, the .rpm's Version and Release, packaged from the built binary), what blocks a target on a
 * machine that cannot build it, the UEFI aarch64 port the uefi-arm64 target builds (its machine layer, its media,
 * its QEMU boot), what `host` and `all` select, the command line's exits, the workflow that runs every buildable
 * target on its own runner with GitHub's own actions alone, the Linux and macOS jobs that carry the model and check
 * what they built before any upload, the Windows app's .msi, the release dispatch, the package script and the
 * manual's section.
 * What breaks if it is removed? A target can silently become a shell string, drop out of the workflow, or build the
 * page twice, and the docs can name a command that no longer exists.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// A computed specifier: the script is tooling under tools/, outside the page's build, loaded as the test's own module.
const MATRIX: string = '../tools/build/matrix.mjs'
const m = await import(MATRIX)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'tools', 'build', 'matrix.mjs')
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'build-matrix.yml'), 'utf8')

interface Step { kind: string; cmd?: string; argv?: string[]; cwd?: string; path?: string; paths?: string[]; hint?: string; again?: number; when?: (at: { began: number }) => boolean; why?: string; mend?: (say: (line: string) => void) => void; louder?: string[] }
interface Target { id: string; artifact: string; hosts: string[]; arch?: string; tools?: string[]; env?: string[]; unsupported?: string; note?: string; plan?: (ctx: object) => Step[]; collect?: (ctx: object) => [string, string][] }
interface Host { platform: string; arch: string; env: Record<string, string>; has: (cmd: string) => boolean }

const TARGETS: readonly Target[] = m.TARGETS
const IDS: readonly string[] = m.IDS
const host = (platform: string, arch: string, env: Record<string, string> = {}): Host => ({ platform, arch, env, has: () => true })
const LINUX = host('linux', 'x64')
const CTX = { out: '/tmp/out', version: '1.0.0-stable-beta', media: true, dryRun: true }
/** The targets that carry the app's model and run it themselves. */
const CARRIERS = ['linux-x64', 'linux-arm64', 'macos-universal']

test('the ten targets, in the order the plan names them, each saying what it makes', () => {
  assert.deepEqual(IDS, ['windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64', 'macos-universal', 'android-apk', 'ios-ipa', 'uefi-x64', 'uefi-arm64', 'uefi-riscv64'])
  for (const t of TARGETS) {
    assert.match(t.artifact, /\S/, t.id)
    if (t.unsupported) assert.deepEqual(t.hosts, [], `${t.id} builds nowhere`)
    else assert.ok(t.hosts.length > 0 && typeof t.plan === 'function', t.id)
  }
  assert.ok(Object.isFrozen(TARGETS))
})

test('a step that downloads is run again before it fails its target: rustup\'s targets and the two mobile builds; so is the macOS bundle step, and nothing else', () => {
  const again: string[] = []
  for (const t of TARGETS) {
    if (!t.plan) continue
    for (const s of t.plan(CTX)) {
      if (s.kind !== 'run') continue
      const downloads = s.cmd === 'rustup' || ((t.id === 'android-apk' || t.id === 'ios-ipa') && s.argv?.[2] === 'build')
      const image = t.id === 'macos-universal' && s.argv?.[1] === 'build'
      assert.equal(s.again, downloads ? (s.cmd === 'rustup' ? 2 : 1) : image ? 2 : undefined, `${t.id}: ${s.cmd} ${s.argv?.slice(1, 4).join(' ')}`)
      if (downloads) again.push(`${t.id}: ${s.cmd === 'rustup' ? 'rustup' : s.argv![1]}`)
      // Only the macOS step is tried again on a condition, mended first and louder after: a download just runs again.
      assert.equal(typeof s.when, image ? 'function' : 'undefined', t.id)
      assert.equal(typeof s.mend, image ? 'function' : 'undefined', t.id)
      assert.deepEqual(s.louder, image ? ['--verbose'] : undefined, t.id)
      assert.equal(s.why, image ? m.DMG_WHY : undefined, t.id)
      if (image) {
        assert.equal(s.when, m.dmgAlone)
        assert.ok(s.argv!.includes('app,dmg'), 'the step that makes the .dmg')
      }
    }
  }
  // A package host that answered 429 once failed the Android build: both mobile builds, and every target rustup adds.
  assert.deepEqual(again.filter((a) => !a.endsWith('rustup')), ['android-apk: android', 'ios-ipa: ios'])
  assert.ok(again.includes('android-apk: rustup') && again.includes('ios-ipa: rustup') && again.includes('uefi-x64: rustup'))
  const source = readFileSync(SCRIPT, 'utf8')
  assert.equal(m.AGAIN_MS, 60_000)
  // The run loop hands every step to tried, and a failure that stays is still the target's.
  assert.match(source, /const r = tried\(s, \(argv\) => run\(s\.cmd, argv, \{ cwd: s\.cwd \?\? ROOT, env: \{ \.\.\.process\.env, \.\.\.\(s\.env \?\? \{\}\) \} \}\), \{ id: t\.id \}\)\n\s+if \(!r\.ok\) throw new Error\(`\$\{show\(s\.cmd, s\.argv, s\.cwd\)\} failed`\)/)
})

test('tried: a failing step is run again only as often as it may be, after a pause, and what the last try answered stands', () => {
  const say: string[] = []
  const pauses: number[] = []
  const opts = { id: 'android-apk', pause: (ms: number) => { pauses.push(ms) }, say: (line: string) => { say.push(line) }, now: () => 5000 }
  const step = (extra: object = {}): Step => ({ kind: 'run', cmd: '/usr/bin/node', argv: ['tauri.js', 'android', 'build'], ...extra })
  const runs = (answers: boolean[]) => { const seen: string[][] = []; return { seen, once: (argv: string[]) => { seen.push(argv); return { ok: answers[seen.length - 1] } } } }

  // A step that passes runs once; one with no `again` fails at once.
  let r = runs([true])
  assert.deepEqual(m.tried(step({ again: 2 }), r.once, opts), { ok: true })
  assert.equal(r.seen.length, 1)
  r = runs([false, true])
  assert.deepEqual(m.tried(step(), r.once, opts), { ok: false })
  assert.equal(r.seen.length, 1)
  assert.deepEqual([say, pauses], [[], []])

  // A download: run again after the pause, with the same arguments, and the warning says why and how many are left.
  r = runs([false, false, true])
  assert.deepEqual(m.tried(step({ again: 2 }), r.once, opts), { ok: true })
  assert.deepEqual(r.seen, [['tauri.js', 'android', 'build'], ['tauri.js', 'android', 'build'], ['tauri.js', 'android', 'build']])
  assert.deepEqual(pauses, [m.AGAIN_MS, m.AGAIN_MS])
  assert.deepEqual(say, [
    '::warning::android-apk: node tauri.js android build failed; it downloads as it runs, so it is run again in 60 s (2 more tries)',
    '::warning::android-apk: node tauri.js android build failed; it downloads as it runs, so it is run again in 60 s (1 more try)',
  ])

  // A failure that stays is the step's: `again` more tries and no more.
  r = runs([false, false, false, true])
  assert.deepEqual(m.tried(step({ again: 2 }), r.once, opts), { ok: false })
  assert.equal(r.seen.length, 3)

  // A condition: asked after each failure with the time the step began, and a "no" ends the tries there.
  say.length = 0; pauses.length = 0
  const asked: number[] = []
  const answers = [true, false]
  r = runs([false, false, false])
  assert.deepEqual(m.tried(step({ again: 2, when: ({ began }: { began: number }) => { asked.push(began); return answers.shift()! } }), r.once, opts), { ok: false })
  assert.deepEqual([r.seen.length, asked, pauses.length], [2, [5000, 5000], 1])
  r = runs([false, true])
  assert.deepEqual(m.tried(step({ again: 2, when: () => false }), r.once, opts), { ok: false })
  assert.equal(r.seen.length, 1, 'a failure of another kind is not tried again')

  // Mended before each new try, in the order warning, mend, pause, try; the new tries are louder and the first is not.
  say.length = 0; pauses.length = 0
  const order: string[] = []
  r = runs([false, false, true])
  const loud = m.tried(
    step({ again: 2, why: 'the image is busy', louder: ['--verbose'], mend: (tell: (line: string) => void) => { order.push('mend'); tell('    mended') } }),
    (argv: string[]) => { order.push(`run ${argv.length}`); return r.once(argv) },
    { ...opts, id: 'macos-universal', pause: () => { order.push('pause') } },
  )
  assert.deepEqual(loud, { ok: true })
  assert.deepEqual(order, ['run 3', 'mend', 'pause', 'run 4', 'mend', 'pause', 'run 4'])
  assert.deepEqual(r.seen[0], ['tauri.js', 'android', 'build'])
  assert.deepEqual(r.seen[1], ['tauri.js', 'android', 'build', '--verbose'])
  assert.deepEqual(r.seen[2], ['tauri.js', 'android', 'build', '--verbose'])
  assert.deepEqual(say, [
    '::warning::macos-universal: node tauri.js android build failed; the image is busy, so it is run again in 60 s (2 more tries)',
    '    mended',
    '::warning::macos-universal: node tauri.js android build failed; the image is busy, so it is run again in 60 s (1 more try)',
    '    mended',
  ])
})

test('the macOS bundle step is tried again only when the .app is new and the .dmg is missing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cn-dmg-'))
  try {
    const apps = join(dir, 'macos')
    const dmgs = join(dir, 'dmg')
    const at = (began: number) => m.dmgAlone({ began, apps, dmgs })
    // Nothing bundled (a failed compile): not this failure.
    assert.equal(at(0), false)
    mkdirSync(dmgs)
    assert.equal(at(0), false)
    // The .app made, the working image left beside it, the dmg folder holding only Tauri's script: this failure.
    mkdirSync(join(apps, 'Crimson Noir Agent City.app'), { recursive: true })
    writeFileSync(join(apps, 'rw.7001.Crimson Noir Agent City_1.0.0-stable-beta_universal.dmg'), 'x')
    writeFileSync(join(dmgs, 'bundle_dmg.sh'), '#!/bin/sh\n')
    const made = statSync(join(apps, 'Crimson Noir Agent City.app')).mtimeMs
    assert.equal(at(0), true)
    assert.equal(at(made), true)
    assert.equal(at(made + 1500), true, 'a folder time kept to the second is still this try\'s')
    // An .app older than the step (a stale one, with the compile failing now): not this failure.
    assert.equal(at(made + 60_000), false)
    // A whole .dmg in the dmg folder: the image was made, so whatever failed was not it.
    writeFileSync(join(dmgs, 'Crimson Noir Agent City_1.0.0-stable-beta_universal.dmg'), 'x')
    assert.equal(at(0), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  assert.equal(m.dmgAlone({ apps: join(dir, 'gone'), dmgs: join(dir, 'gone') }), false)
  assert.match(m.DMG_WHY, /^the \.app is made and the \.dmg is not/)

  assert.equal(m.isWorkingImage('rw.7001.Crimson Noir Agent City_1.0.0-stable-beta_universal.dmg'), true)
  for (const n of ['Crimson Noir Agent City_1.0.0-stable-beta_universal.dmg', 'rw.dmg', 'rw.x.y.dmg', 'rw.12.name.dmg.txt', 'Crimson Noir Agent City.app']) assert.equal(m.isWorkingImage(n), false, n)
})

test('leftImages reads what hdiutil info lists as attached, and keeps only the images under the bundle folder', () => {
  const bundle = '/Users/runner/work/City/City/src-tauri/target/universal-apple-darwin/release/bundle'
  const INFO = [
    'framework       : 692.40.2',
    'driver          : 15.7.2',
    '================================================',
    `image-path      : ${bundle}/macos/rw.7120.Crimson Noir Agent City_1.0.0-stable-beta_universal.dmg`,
    'image-alias     : /Users/runner/work/City/City/src-tauri/target/universal-apple-darwin/release/bundle/macos/rw.7120.Crimson Noir Agent City_1.0.0-stable-beta_universal.dmg',
    'shadow-path     : <none>',
    'icon-path       : /System/Library/PrivateFrameworks/DiskImages.framework/Resources/CDiskImage.icns',
    'image-type      : read/write',
    'system-image    : false',
    'blockcount      : 2134016',
    'blocksize       : 512',
    'writeable       : TRUE',
    'autodiskmount   : TRUE',
    'removable       : TRUE',
    'image-encrypted : false',
    'mounting user   : runner',
    'mounting mode   : <unknown> (no BSD-level information)',
    'process ID      : 7120',
    '/dev/disk4\tApple_partition_scheme\t',
    '/dev/disk4s1\tApple_partition_map\t',
    '/dev/disk4s2\tApple_HFS\t/Volumes/dmg.Xy12Ab',
    '================================================',
    'image-path      : /Library/Developer/CoreSimulator/Volumes/iOS_23F77/sim.dmg',
    'image-type      : read-only',
    '/dev/disk6\tGUID_partition_scheme\t',
    '/dev/disk6s1\tApple_APFS\t',
    '================================================',
    `image-path      : ${bundle}/dmg/orphan with no device.dmg`,
    'image-type      : read/write',
    '',
  ].join('\n')
  assert.deepEqual(m.leftImages(INFO, [bundle]), [{ image: `${bundle}/macos/rw.7120.Crimson Noir Agent City_1.0.0-stable-beta_universal.dmg`, dev: '/dev/disk4' }])
  // A folder named with or without its slash; a neighbour whose name only begins the same is not under it.
  assert.equal(m.leftImages(INFO, [`${bundle}/`]).length, 1)
  assert.deepEqual(m.leftImages(INFO, [bundle.slice(0, -3)]), [])
  assert.deepEqual(m.leftImages(INFO, ['/somewhere/else', '/Library/Developer/CoreSimulator']), [{ image: '/Library/Developer/CoreSimulator/Volumes/iOS_23F77/sim.dmg', dev: '/dev/disk6' }])
  // Nothing attached, or words that are not hdiutil's: nothing to detach.
  assert.deepEqual(m.leftImages('framework       : 692.40.2\ndriver          : 15.7.2\n', [bundle]), [])
  assert.deepEqual(m.leftImages('', [bundle]), [])

  // The mending is the Mac's alone, reads hdiutil's own list, detaches by device and removes only working images.
  const source = readFileSync(SCRIPT, 'utf8')
  const mend = source.slice(source.indexOf('function detachLeft('), source.indexOf('function macPlan('))
  assert.match(mend, /if \(process\.platform !== 'darwin'\) return\n/)
  assert.match(mend, /run\('hdiutil', \['info'\], \{ capture: true \}\)/)
  assert.match(mend, /run\('hdiutil', \['detach', dev, '-force'\], \{ capture: true \}\)/)
  assert.match(mend, /readdirSync\(apps\)\.filter\(isWorkingImage\)/)
})

test('every plan is programs with argument vectors, never a shell line; every Tauri step says the page is already built; the page is built under this Node', () => {
  const sdk = { ANDROID_HOME: 'x', NDK_HOME: 'y', JAVA_HOME: 'z' }
  const hosts: Record<string, Host[]> = { win32: [host('win32', 'x64', sdk)], linux: [host('linux', 'x64', sdk), host('linux', 'arm64', sdk)], darwin: [host('darwin', 'arm64', sdk)] }
  for (const t of TARGETS) {
    if (!t.plan) continue
    const steps = t.plan(CTX)
    assert.ok(steps.length > 0, t.id)
    for (const s of steps) {
      // Besides programs: the APK's signing, and on Linux and macOS a file the build needs (the model) and folders it tidies.
      if (s.kind !== 'run') { assert.ok(s.kind === 'sign-apk' || (CARRIERS.includes(t.id) && (s.kind === 'need' || s.kind === 'tidy')), `${t.id}: ${s.kind}`); continue }
      assert.ok(typeof s.cmd === 'string' && Array.isArray(s.argv), `${t.id}: ${JSON.stringify(s)}`)
      // No shell: the one `sh` is the repository's own media script, run by path with its arguments.
      if (s.cmd === 'sh') assert.deepEqual(s.argv!.slice(0, 1), ['tools/build-image.sh'], t.id)
      // npm and npx are .cmd files on Windows, which Node will not spawn without a shell: npm runs as its own script under this Node.
      assert.ok(!['bash', 'cmd', 'cmd.exe', 'powershell', 'pwsh', 'npm', 'npx', 'npm.cmd', 'npx.cmd'].includes(s.cmd!), `${t.id}: ${s.cmd}`)
      for (const a of s.argv!) assert.ok(!/&&|\|\||[;|><`$]/.test(a) || a.startsWith('{'), `${t.id}: shell syntax in an argument: ${a}`)
      const viaNpm = s.argv![0]?.endsWith('npm-cli.js')
      if (s.argv![0]?.endsWith('tauri.js') || viaNpm) {
        assert.equal(s.cmd, process.execPath, `${t.id}: the Tauri CLI, and npm, run under this Node`)
        let a = s.argv!.slice(1)
        if (viaNpm) { assert.deepEqual(a.slice(0, 3), ['run', '--', 'tauri'], `${t.id}: npm runs the tauri script and nothing else`); a = a.slice(3) }
        const mobile = a[0] === 'android' || a[0] === 'ios'
        const verb = mobile ? a[1] : a[0]
        if (verb === 'build') {
          const i = s.argv!.indexOf('--config')
          assert.ok(i > 0, `${t.id}: a build without --config would build the page again`)
          const config = JSON.parse(s.argv![i + 1])
          assert.equal(config.build?.beforeBuildCommand, '', t.id)
          // The app is compiled with its own version: a build step never overrides it (only `tauri bundle` may, for the .rpm).
          assert.equal(config.version, undefined, `${t.id}: a build that set the version would compile it into the app`)
        }
        if (verb === 'bundle') {
          // `tauri bundle` packages the binary the build step left, without compiling: the .rpm, and only after a build.
          assert.ok(steps.indexOf(s) > 0 && steps.slice(0, steps.indexOf(s)).some((p) => p.argv?.[1] === 'build'), `${t.id}: a bundle step follows a build`)
          assert.deepEqual(a.slice(0, 3), ['bundle', '--bundles', 'rpm'], t.id)
        }
        // A mobile project records the command `init` ran through and calls it back from Gradle or Xcode: `npm run -- tauri`
        // exists everywhere (package.json's tauri script); the bare `node tauri` a plain `node tauri.js` leaves does not.
        if (mobile && verb === 'init') assert.ok(viaNpm && a.includes('--ci'), `${t.id}: ${a.join(' ')} must run through npm, non-interactive`)
      }
    }
    if (t.id.startsWith('windows-')) {
      // The .msi beside the NSIS installer, with the version's numbers as WiX's own (WiX takes no pre-release tag).
      const b = steps.find((s) => s.argv?.[1] === 'build')!
      assert.equal(b.argv![b.argv!.indexOf('--bundles') + 1], 'nsis,msi', t.id)
      assert.equal(JSON.parse(b.argv![b.argv!.indexOf('--config') + 1]).bundle.windows.wix.version, '1.0.0', t.id)
    }
    if (t.id.startsWith('linux-')) {
      // The .rpm's Version is the numbers, its Release the pre-release tag after a 0 (rpm takes no hyphen in a version).
      const b = steps.find((s) => s.argv?.[1] === 'bundle')!
      const config = JSON.parse(b.argv![b.argv!.indexOf('--config') + 1])
      assert.deepEqual(config, { version: '1.0.0', bundle: { linux: { rpm: { release: '0.stable.beta' } } } }, t.id)
      assert.equal(steps.find((s) => s.argv?.[1] === 'build')!.argv![steps.find((s) => s.argv?.[1] === 'build')!.argv!.indexOf('--bundles') + 1], 'deb,appimage', t.id)
      // The native runner and the model overlay, in the build and in the .rpm's bundle step alike.
      const build = steps.find((s) => s.argv?.[1] === 'build')!.argv!
      assert.equal(build[build.indexOf('--features') + 1], 'native-runner', t.id)
      for (const step of [build, b.argv!]) assert.ok(step.includes(m.MODEL_CONFIG), `${t.id}: ${step.join(' ')}`)
      // The model, its licence and its notice must be in place before the build, and nothing else is fetched here.
      const needs = steps.filter((s) => s.kind === 'need').map((s) => relative(ROOT, s.path!).replace(/\\/g, '/'))
      assert.deepEqual(needs, m.modelResources().map((r: string) => `src-tauri/${r}`), t.id)
      assert.ok(steps.findIndex((s) => s.kind === 'need') < steps.findIndex((s) => s.argv?.[1] === 'build'), t.id)
      // The bundler's staging copies (each a copy of the model) go before the .rpm is packaged.
      const tidy = steps.findIndex((s) => s.kind === 'tidy')
      assert.ok(tidy > steps.findIndex((s) => s.argv?.[1] === 'build') && tidy < steps.indexOf(b), t.id)
      assert.equal((t as Target & { move?: boolean }).move, true, `${t.id}: its files are moved into out/, not copied`)
      assert.ok(t.tools!.includes('cmake'), t.id)
    } else if (t.id === 'macos-universal') {
      // Both slices with the runner and the model overlay, on the build step alone, with the per-slice settings.
      const b = steps.find((s) => s.argv?.[1] === 'build')!
      const a = b.argv!
      assert.equal(a[a.indexOf('--features') + 1], 'native-runner', t.id)
      assert.ok(a.includes(m.MODEL_CONFIG), t.id)
      assert.equal(a[a.indexOf('--target') + 1], 'universal-apple-darwin', t.id)
      assert.equal(a[a.indexOf('--bundles') + 1], 'app,dmg', t.id)
      for (const st of steps.filter((x) => x !== b)) assert.ok(!st.argv?.includes('native-runner') && !st.argv?.includes(m.MODEL_CONFIG), `${t.id}: only the build step: ${st.argv?.join(' ')}`)
      // The per-slice settings, as literals: the build step's environment, which reaches both slices' cargo builds alike.
      const env = (b as Step & { env?: Record<string, string> }).env!
      assert.deepEqual(Object.keys(env).sort(), ['CMAKE_DISABLE_FIND_PACKAGE_OpenSSL', 'CMAKE_PROJECT_ggml_INCLUDE', 'GGML_SLICES_SHA256', 'MACOSX_DEPLOYMENT_TARGET'], 'the build step carries the per-slice settings')
      const slices = join(ROOT, 'tools', 'build', 'macos-slices.cmake')
      assert.equal(m.MAC_SLICES, 'tools/build/macos-slices.cmake')
      assert.equal(env.CMAKE_PROJECT_ggml_INCLUDE, slices)
      // Only GGML_* variables rerun llama-cpp-sys-2's build script, so the include's hash must ride in one.
      assert.equal(env.GGML_SLICES_SHA256, createHash('sha256').update(readFileSync(slices)).digest('hex'))
      assert.equal(env.MACOSX_DEPLOYMENT_TARGET, '11.0')
      assert.equal(env.CMAKE_DISABLE_FIND_PACKAGE_OpenSSL, 'ON')
      assert.deepEqual(m.macEnv(), env, 'the step is given macEnv itself')
      const rustup = steps.find((s) => s.cmd === 'rustup')!
      assert.deepEqual(rustup.argv!.slice(-2), ['aarch64-apple-darwin', 'x86_64-apple-darwin'])
      const needs = steps.filter((s) => s.kind === 'need').map((s) => relative(ROOT, s.path!).replace(/\\/g, '/'))
      assert.deepEqual(needs, m.modelResources().map((r: string) => `src-tauri/${r}`), t.id)
      assert.ok(steps.findIndex((s) => s.kind === 'need') < steps.indexOf(b), t.id)
      // The copies of the model Tauri's build step leaves beside each slice's binary go once the .app and .dmg are made.
      const tidy = steps.find((s) => s.kind === 'tidy')! as Step & { paths: () => string[] }
      assert.ok(steps.indexOf(tidy) > steps.indexOf(b), t.id)
      assert.deepEqual(tidy.paths().map((p) => relative(ROOT, p).replace(/\\/g, '/')), ['src-tauri/target/aarch64-apple-darwin/release/models', 'src-tauri/target/x86_64-apple-darwin/release/models'])
      assert.equal((t as Target & { move?: boolean }).move, true, `${t.id}: the .dmg is moved into out/, not copied`)
      assert.ok(t.tools!.includes('cmake'), t.id)
    } else {
      // Every other target builds exactly as before: no runner, no model, no overlay.
      for (const st of steps) assert.ok(!st.argv?.includes('native-runner') && !st.argv?.includes(m.MODEL_CONFIG), `${t.id}: ${st.argv?.join(' ')}`)
      assert.ok(!steps.some((st) => st.kind === 'need' || st.kind === 'tidy'), t.id)
    }
    if (t.id.startsWith('uefi-')) {
      // The UEFI application carries no page, and its media come from the repository's own script, given the target.
      assert.equal((t as Target & { page?: boolean }).page, false, t.id)
      // riscv64 has no UEFI target in Rust: its triple is the bare-metal one (arch/riscv64.rs carries the PE header).
      const triple = { 'uefi-x64': 'x86_64-unknown-uefi', 'uefi-arm64': 'aarch64-unknown-uefi', 'uefi-riscv64': 'riscv64gc-unknown-none-elf' }[t.id]!
      assert.ok(steps.some((s) => s.cmd === 'cargo' && s.argv!.includes(triple)), t.id)
      assert.deepEqual(steps.find((s) => s.cmd === 'rustup')!.argv, ['target', 'add', triple], `${t.id}: the target is added first`)
      const media = steps.find((s) => s.cmd === 'sh')!
      if (t.id !== 'uefi-x64') assert.equal(media.argv![2], triple, `${t.id}: build-image.sh is told the target`)
      // Each architecture's media in a folder of its own, so one checkout holds all three.
      assert.equal(media.argv![1], join('target', { 'uefi-x64': 'image', 'uefi-arm64': 'image-aarch64', 'uefi-riscv64': 'image-riscv64' }[t.id]!), t.id)
      // What is collected: the application under the name the firmware looks for, and the media under the architecture's.
      const [efi, ...rest] = t.collect!(CTX).map(([from, name]: [string, string]) => [relative(ROOT, from).replace(/\\/g, '/'), name])
      assert.deepEqual(efi, {
        'uefi-x64': ['crimson_noir_os/target/x86_64-unknown-uefi/release/crimson_boot.efi', 'BOOTX64.EFI'],
        'uefi-arm64': ['crimson_noir_os/target/aarch64-unknown-uefi/release/crimson_boot.efi', 'BOOTAA64.EFI'],
        // The linker writes the riscv64 application itself, under the name a bare-metal program gets.
        'uefi-riscv64': ['crimson_noir_os/target/riscv64gc-unknown-none-elf/release/crimson_boot', 'BOOTRISCV64.EFI'],
      }[t.id], t.id)
      const stem = { 'uefi-x64': 'crimson_noir_os', 'uefi-arm64': 'crimson_noir_os-aarch64', 'uefi-riscv64': 'crimson_noir_os-riscv64' }[t.id]!
      assert.deepEqual(rest.map(([, name]: string[]) => name), [`${stem}.img`, `${stem}.iso`], t.id)
    }
    if (t.id === 'ios-ipa') {
      // Xcode's "Build Rust Code" phase asks the running Tauri CLI for its options, so only `tauri ios build` drives
      // xcodebuild, and without an Apple account it must be told to skip signing.
      assert.ok(!steps.some((s) => s.cmd === 'xcodebuild'), 'no xcodebuild step of its own')
      const b = steps.find((s) => s.argv?.[1] === 'ios' && s.argv?.[2] === 'build')
      assert.ok(b?.argv?.includes('--no-sign') && b?.argv?.includes('--ci'), 'tauri ios build --ci --no-sign')
    }
    // The target builds on at least one machine of the kinds the table knows (both Linux architectures among them).
    const machines = t.hosts.flatMap((h) => hosts[h])
    assert.ok(machines.some((h) => m.blocker(t, h) === null), `${t.id}: ${machines.map((h) => m.blocker(t, h)).join('; ')}`)
  }
})

test('macos-slices.cmake: Metal off and the guard\'s six instruction sets on, FORCE, for the x86_64 slice alone; a line of its own for each slice', () => {
  const c = readFileSync(join(ROOT, 'tools', 'build', 'macos-slices.cmake'), 'utf8')
  assert.match(c, /^if\(APPLE AND CMAKE_OSX_ARCHITECTURES STREQUAL "x86_64"\)$/m)
  assert.match(c, /^\s+set\(GGML_METAL OFF CACHE BOOL "[^"]*" FORCE\)$/m)
  assert.match(c, /foreach\(option GGML_SSE42 GGML_AVX GGML_AVX2 GGML_FMA GGML_F16C GGML_BMI2\)\s*\n\s+set\(\$\{option\} ON CACHE BOOL "[^"]*" FORCE\)/)
  // The status lines macAudit.mjs `slices` reads from each slice's build output (parseSliceBuild's `slices`).
  assert.match(c, /message\(STATUS "crimson-noir macos-slices: x86_64: Metal off; SSE4\.2, AVX, AVX2, FMA, F16C and BMI2 on"\)/)
  assert.match(c, /^elseif\(APPLE\)\n\s+message\(STATUS "crimson-noir macos-slices: \$\{CMAKE_OSX_ARCHITECTURES\}: ggml's own defaults \(Metal on\)"\)\nendif\(\)$/m)
  // Nothing else is set: no other option, and nothing outside the two branches.
  assert.equal(c.match(/^\s*set\(/gm)?.length, 2)
  assert.deepEqual(c.split('\n').filter((l) => l && !l.startsWith('#')).length, 9)
})

test('the installers\' own version: the numbers alone for WiX and rpm\'s Version, the pre-release tag in the .rpm\'s Release', () => {
  assert.equal(m.installerVersion('1.0.0-stable-beta'), '1.0.0')
  assert.equal(m.installerVersion('1.1.0'), '1.1.0')
  assert.equal(m.installerVersion('2.3.4+build.5'), '2.3.4')
  assert.throws(() => m.installerVersion('beta'), /not a semantic version/)
  assert.equal(m.rpmRelease('1.0.0-stable-beta'), '0.stable.beta')
  assert.equal(m.rpmRelease('1.1.0-rc.2'), '0.rc.2')
  assert.equal(m.rpmRelease('1.1.0'), '1', 'a plain release is Release 1, after every 0.<tag> pre-release')
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  // rpm's Release takes letters, digits, dots and underscores; no hyphen anywhere in what the .rpm is given.
  assert.match(m.rpmRelease(pkg.version), /^[0-9A-Za-z._]+$/)
  assert.match(m.installerVersion(pkg.version), /^\d{1,3}\.\d{1,3}\.\d{1,5}$/, 'WiX: major and minor up to 255, patch up to 65535')
})

test('what blocks a target on this or that machine: the operating system, the architecture, a variable, a program; UEFI aarch64 and riscv64 build wherever cargo is, each from its own machine layer', () => {
  assert.equal(m.blocker(TARGETS[2], LINUX), null, 'linux-x64 on Linux x64')
  assert.match(m.blocker(TARGETS[3], LINUX), /needs a arm64 machine/)
  assert.equal(m.blocker(TARGETS[3], host('linux', 'arm64')), null)
  assert.match(m.blocker(TARGETS[0], LINUX), /builds on Windows, not on Linux/)
  assert.match(m.blocker(TARGETS[1], host('darwin', 'arm64')), /builds on Windows, not on macOS/)
  assert.match(m.blocker(TARGETS[4], LINUX), /builds on macOS/)
  assert.match(m.blocker(TARGETS[5], LINUX), /needs the ANDROID_HOME environment variable/)
  assert.match(m.blocker(TARGETS[5], host('linux', 'x64', { ANDROID_HOME: 'x' })), /needs the NDK_HOME environment variable/)
  assert.equal(m.blocker(TARGETS[5], host('win32', 'x64', { ANDROID_HOME: 'x', NDK_HOME: 'y', JAVA_HOME: 'z' })), null, 'the Android shell builds from Windows too')
  assert.match(m.blocker(TARGETS[6], host('win32', 'x64')), /builds on macOS, not on Windows/)
  assert.equal(m.blocker(TARGETS[7], host('win32', 'x64')), null, 'the UEFI application builds anywhere cargo is')
  assert.match(m.blocker(TARGETS[7], { ...LINUX, has: (c: string) => c !== 'rustup' }), /needs rustup on PATH/)
  for (const h of [host('linux', 'x64'), host('linux', 'arm64'), host('win32', 'x64'), host('darwin', 'arm64')]) {
    assert.equal(m.blocker(TARGETS[8], h), null, `uefi-arm64 on ${h.platform} ${h.arch}`)
    assert.equal(m.blocker(TARGETS[9], h), null, `uefi-riscv64 on ${h.platform} ${h.arch}`)
  }
  assert.ok(TARGETS.every((t) => !t.unsupported), 'no target is unsupported')
  // The port is real: arch.rs picks one machine layer per architecture behind the same names, and the aarch64 one
  // speaks to an Arm machine (the generic timer, VBAR, the UART the ACPI SPCR table names) with no x86 in it.
  const boot = join(ROOT, 'crimson_noir_os', 'boot', 'src')
  const dispatch = readFileSync(join(boot, 'arch.rs'), 'utf8')
  assert.match(dispatch, /#\[cfg\(target_arch = "x86_64"\)\]\nmod x86_64;/)
  assert.match(dispatch, /#\[cfg\(target_arch = "aarch64"\)\]\nmod aarch64;/)
  assert.match(dispatch, /#\[cfg\(target_arch = "riscv64"\)\]\nmod riscv64;/)
  // The two machines whose keyboard is the serial console share one decoder.
  assert.match(dispatch, /#\[cfg\(any\(target_arch = "aarch64", target_arch = "riscv64"\)\)\]\nmod serial_keys;/)
  const x86 = readFileSync(join(boot, 'arch', 'x86_64.rs'), 'utf8')
  const arm64 = readFileSync(join(boot, 'arch', 'aarch64.rs'), 'utf8')
  const riscv = readFileSync(join(boot, 'arch', 'riscv64.rs'), 'utf8')
  const keys = readFileSync(join(boot, 'arch', 'serial_keys.rs'), 'utf8')
  assert.match(x86, /asm!\("out dx, al"/)
  for (const needle of ['cntvct_el0', 'msr vbar_el1', 'msr vbar_el2', 'b"SPCR"', '.balign 2048', 'esr_el1', 'far_el1']) assert.ok(arm64.includes(needle), `aarch64.rs: ${needle}`)
  assert.doesNotMatch(arm64, /\b(out dx|in al|rdtsc|lidt|lgdt)\b/, 'no x86 in the aarch64 layer')
  // The riscv64 one speaks to a RISC-V machine: the SBI console, the time CSR, its own trap vector.
  for (const needle of ['"ecall"', 'rdtime', 'csrw stvec', 'scause', 'sepc', 'stval', '0x4442_434e']) assert.ok(riscv.includes(needle), `riscv64.rs: ${needle}`)
  assert.doesNotMatch(riscv, /\b(out dx|in al|rdtsc|lidt|lgdt|cntvct_el0|vbar_el[12]|esr_el1)\b/, 'no x86 and no Arm in the riscv64 layer')
  // All three layers give image.rs the same names; the serial-console pair take Keyboard from the shared decoder.
  for (const name of ['pub fn serial_init(', 'pub struct Serial', 'pub fn ticks(', 'pub const CLOCK', 'pub const TAKEN', 'pub fn cli(', 'pub fn halt(', 'pub unsafe fn take_over(', 'pub fn poll_keys(', 'pub struct Fault', 'pub fn describe(']) {
    assert.ok(x86.includes(name) && arm64.includes(name) && riscv.includes(name), name)
  }
  assert.ok(x86.includes('pub struct Keyboard') && keys.includes('pub struct Keyboard'))
  for (const layer of [arm64, riscv]) {
    assert.ok(layer.includes('pub use super::serial_keys::Keyboard;'))
    assert.ok(layer.includes('super::serial_keys::poll(kb, keys, serial_read)'))
    assert.ok(!layer.includes('KEY_PAGE_UP'), 'one decoder, not a copy in each layer')
  }
  const image = readFileSync(join(boot, 'image.rs'), 'utf8')
  assert.doesNotMatch(image, /arch::(rdtsc|load_gdt|load_idt|ps2_byte|FaultFrame)\b/, 'image.rs calls only the shared names')
})

test('the aarch64 and riscv64 media and boot: BOOTAA64.EFI or BOOTRISCV64.EFI on the ESP, each its own identity, a reproducible link, and the boot test on QEMU\'s virt machines with edk2, typing over the serial line', () => {
  const os = join(ROOT, 'crimson_noir_os')
  const image = readFileSync(join(os, 'tools', 'build-image.sh'), 'utf8')
  assert.match(image, /target=\$\{2:-x86_64-unknown-uefi\}/)
  assert.match(image, /aarch64-unknown-uefi\) boot=BOOTAA64\.EFI; arch_id="aarch64:" ;;/)
  assert.match(image, /x86_64-unknown-uefi\) boot=BOOTX64\.EFI; arch_id="" ;;/, 'the x86-64 media keep the identity they had')
  assert.match(image, /riscv64gc-unknown-none-elf\) boot=BOOTRISCV64\.EFI; arch_id="riscv64:" ;;/)
  // The riscv64 application is the file the linker wrote (no .efi), and whatever was built must begin as a PE file does.
  assert.match(image, /if \[ "\$target" = riscv64gc-unknown-none-elf \]; then efi="\$here\/target\/\$target\/release\/crimson_boot"; fi/)
  assert.match(image, /\[ "\$\(head -c 2 "\$efi"\)" = MZ \] \|\| \{ echo "build-image\.sh: \$efi is not a UEFI application \(no PE header\)" >&2; exit 1; \}/)
  assert.match(image, /mcopy -m -i "\$esp" "\$stage\/\$boot" "::\/EFI\/BOOT\/\$boot"/)
  const cargo = readFileSync(join(os, '.cargo', 'config.toml'), 'utf8')
  for (const triple of ['x86_64-unknown-uefi', 'aarch64-unknown-uefi']) {
    assert.match(cargo, new RegExp(`\\[target\\.${triple}\\]\\nrustflags = \\["-C", "link-arg=/Brepro", "-C", "link-arg=/DEBUG:NONE"\\]`), triple)
  }
  // riscv64: no UEFI target in Rust, so the bare-metal one, linked position-independent behind the image's own PE
  // header and written out flat by the linker itself, with nothing in the file that varies between two builds.
  const flags = /\[target\.riscv64gc-unknown-none-elf\]\nrustflags = \[([^\]]*)\]/.exec(cargo)?.[1].split(', ').map((f) => JSON.parse(f)) ?? []
  assert.deepEqual(flags.filter((f) => f !== '-C'), ['relocation-model=pie', 'link-arg=-pie', 'link-arg=--no-dynamic-linker', 'link-arg=-znotext', 'link-arg=-znorelro', 'link-arg=--no-relax', 'link-arg=--build-id=none', 'link-arg=--oformat=binary'])
  // The script goes to the bare-metal image alone: a hosted riscv64 build (the workspace's tests on a RISC-V Linux
  // machine) is the note in main.rs, and the script names a symbol only the image defines.
  assert.match(readFileSync(join(os, 'boot', 'build.rs'), 'utf8'), /if env::var\("CARGO_CFG_TARGET_ARCH"\)\.as_deref\(\) == Ok\("riscv64"\) && env::var\("CARGO_CFG_TARGET_OS"\)\.as_deref\(\) == Ok\("none"\) \{\n\s+let script = Path::new\(env!\("CARGO_MANIFEST_DIR"\)\)\.join\("riscv64\.ld"\);\n\s+println!\("cargo:rerun-if-changed=\{\}", script\.display\(\)\);\n\s+println!\("cargo:rustc-link-arg-bins=-T\{\}", script\.display\(\)\);/)
  // The header: a PE32+ file for a 64-bit RISC-V machine, an EFI application, at address 0 with nothing to relocate
  // by the firmware; the entry applies the image's own relative relocations and refuses any other kind.
  const layer = readFileSync(join(os, 'boot', 'src', 'arch', 'riscv64.rs'), 'utf8')
  for (const needle of ['.ascii "MZ"', '.ascii "PE\\0\\0"', '.short 0x5064 ', '.short 0x020b ', '.short 10 ', '.zero 128 ', 'lla a0, ImageBase', 'li t1, 3 ', 'bne t0, t1, 4f', 'li a0, 0x8000000000000001', 'csrs sstatus, t0', 'call efi_main']) assert.ok(layer.includes(needle), `riscv64.rs: ${needle}`)
  const script = readFileSync(join(os, 'boot', 'riscv64.ld'), 'utf8')
  assert.match(script, /^ENTRY\(_entry\)$/m)
  assert.match(script, /\. = 0;\n {2}ImageBase = \.;\n {2}\.head : \{ KEEP\(\*\(\.head\)\) \}\n {2}\. = ALIGN\(0x1000\);/)
  assert.match(script, /\.rela\.dyn : \{ __rela_start = \.; \*\(\.rela \.rela\.\*\) __rela_end = \.; \}/)
  assert.match(script, /SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary/, 'the licence tool does not head a linker script: it carries its header by hand')
  // The image's root compiles as the image for a UEFI target or for this one bare-metal target, and nowhere else.
  const root = readFileSync(join(os, 'boot', 'src', 'main.rs'), 'utf8')
  assert.equal(root.match(/any\(target_os = "uefi", all\(target_arch = "riscv64", target_os = "none"\)\)/g)?.length, 9)
  assert.doesNotMatch(root.replace(/any\(target_os = "uefi", all\(target_arch = "riscv64", target_os = "none"\)\)/g, ''), /cfg[^\n]*target_(os|arch)/)
  const harness = readFileSync(join(os, 'tools', 'boot_test.py'), 'utf8')
  assert.match(harness, /p\.add_argument\("--arch", choices=\["x86_64", "aarch64", "riscv64"\], default="x86_64"/)
  for (const needle of ['qemu-system-aarch64', '"-machine", "virt"', 'AAVMF_CODE.fd', '"ramfb"', 'server=on,wait=on', 'virtio-blk-pci', 'scsi-cd']) assert.ok(harness.includes(needle), `boot_test.py: ${needle}`)
  for (const needle of ['qemu-system-riscv64', '/usr/share/qemu-efi-riscv64/RISCV_VIRT_CODE.fd', '/usr/share/qemu-efi-riscv64/RISCV_VIRT_VARS.fd', 'if=pflash,format=raw,unit=0,readonly=on,file={RISCV_CODE}', 'if=pflash,format=raw,unit=1,file={vars_fd}', 'virt = a.arch in ("aarch64", "riscv64")']) assert.ok(harness.includes(needle), `boot_test.py: ${needle}`)
  assert.doesNotMatch(harness, /qemu-system-riscv64[^\n]*"-bios"/, 'QEMU loads its own OpenSBI under edk2')
  // The boot steps build-release.yml runs on x86-64 run on both architectures in the build matrix's UEFI jobs.
  assert.match(WORKFLOW, /python3 -I tools\/boot_test\.py "\$media\.img" --arch "\$arch" --timeout 300 --wait "SELFTEST PASS"/)
  assert.match(WORKFLOW, /--step 'type:golden\\n' --step wait:MATCH --step 'type:halt\\n' --step 'wait:POWER OFF' --step exit/)
  assert.match(WORKFLOW, /python3 -I tools\/boot_test\.py "\$media\.iso" --arch "\$arch" --timeout 300 --wait "SELFTEST PASS"/)
  assert.match(WORKFLOW, /qemu-system-x86 ovmf qemu-system-arm qemu-efi-aarch64 qemu-system-misc qemu-efi-riscv64$/m)
  // Each UEFI job bakes and boots its own architecture's files.
  assert.match(WORKFLOW, /uefi-riscv64\) triple=riscv64gc-unknown-none-elf; media=\.\.\/out\/uefi-riscv64\/crimson_noir_os-riscv64; efi=\.\.\/out\/uefi-riscv64\/BOOTRISCV64\.EFI; built=crimson_boot ;;/)
  assert.match(WORKFLOW, /uefi-arm64\) triple=aarch64-unknown-uefi; media=\.\.\/out\/uefi-arm64\/crimson_noir_os-aarch64; efi=\.\.\/out\/uefi-arm64\/BOOTAA64\.EFI; built=crimson_boot\.efi ;;/)
  assert.match(WORKFLOW, /\*\) triple=x86_64-unknown-uefi; media=\.\.\/out\/uefi-x64\/crimson_noir_os; efi=\.\.\/out\/uefi-x64\/BOOTX64\.EFI; built=crimson_boot\.efi ;;/)
  assert.match(WORKFLOW, /cmp "\$efi" "target\/\$triple\/release\/\$built" \|\| \{ echo "::error::the UEFI application is not reproducible"; exit 1; \}/)
  assert.match(WORKFLOW, /uefi-arm64\) arch=aarch64; media=\.\.\/out\/uefi-arm64\/crimson_noir_os-aarch64 ;;\n\s+uefi-riscv64\) arch=riscv64; media=\.\.\/out\/uefi-riscv64\/crimson_noir_os-riscv64 ;;\n\s+\*\) arch=x86_64; media=\.\.\/out\/uefi-x64\/crimson_noir_os ;;/)
  // Baked twice from a clean build, as build-release.yml bakes the x86-64 media: the bytes must be the same.
  assert.match(WORKFLOW, /cargo clean -p crimson_boot --release --target "\$triple"\n {10}sh tools\/build-image\.sh "\$RUNNER_TEMP\/again" "\$triple"/)
  assert.ok(WORKFLOW.indexOf('Bake the UEFI media again') < WORKFLOW.indexOf('Boot the disk image in QEMU'))
})

test('select: all, host (this machine\'s desktop app and the UEFI application), a list of ids, and an unknown id named with the choices', () => {
  assert.equal(m.select('all').targets.length, 10)
  assert.equal(m.select('all').named, false)
  assert.deepEqual(m.select('host', { platform: 'win32', arch: 'x64' }).targets.map((t: Target) => t.id), ['windows-x64', 'uefi-x64'])
  assert.deepEqual(m.select(undefined, { platform: 'linux', arch: 'x64' }).targets.map((t: Target) => t.id), ['linux-x64', 'uefi-x64'])
  assert.deepEqual(m.select('host', { platform: 'linux', arch: 'arm64' }).targets.map((t: Target) => t.id), ['linux-arm64', 'uefi-x64'])
  assert.deepEqual(m.select('host', { platform: 'darwin', arch: 'arm64' }).targets.map((t: Target) => t.id), ['macos-universal', 'uefi-x64'])
  const picked = m.select('uefi-x64, linux-x64')
  assert.deepEqual(picked.targets.map((t: Target) => t.id), ['uefi-x64', 'linux-x64'])
  assert.equal(picked.named, true)
  assert.throws(() => m.select('nope,linux-x64'), /unknown target: nope \(one of windows-x64, .*uefi-arm64, uefi-riscv64, all, host\)/)
})

test('the command line: --list names the ten; a dry run of all exits 0, builds the page in the plan and writes nothing; the UEFI targets alone build no page; a named target this machine cannot build exits 1; an unknown one exits 1', () => {
  const node = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  const list = node('--list')
  assert.equal(list.status, 0, list.stderr)
  for (const id of IDS) assert.match(list.stdout, new RegExp(`^${id} `, 'm'))
  assert.doesNotMatch(list.stdout, /unsupported/)
  const out = mkdtempSync(join(tmpdir(), 'matrix-dry-'))
  try {
    const dry = node('--targets', 'all', '--dry-run', '--out', out)
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /\(dry run\)/)
    assert.match(dry.stdout, /^ {2}page: node .*tsc -b$/m)
    assert.match(dry.stdout, /^ {2}page: node .*vite\.js build$/m)
    assert.match(dry.stdout, /^planned {5}uefi-x64$/m, 'the UEFI application builds on any machine with cargo')
    assert.match(dry.stdout, /^planned {5}uefi-arm64$/m, 'and so does the aarch64 one')
    assert.match(dry.stdout, /^planned {5}uefi-riscv64$/m, 'and the riscv64 one')
    assert.ok(!existsSync(join(out, 'matrix.json')), 'a dry run writes no report')
    const uefi = node('--targets', 'uefi-x64,uefi-arm64,uefi-riscv64', '--dry-run', '--out', out)
    assert.equal(uefi.status, 0, uefi.stderr)
    assert.match(uefi.stdout, /^ {2}page: not needed/m)
    assert.doesNotMatch(uefi.stdout, /vite\.js build/)
    const foreign = process.platform === 'darwin' ? 'windows-arm64' : 'macos-universal'
    const named = node('--targets', foreign, '--dry-run', '--out', out)
    assert.equal(named.status, 1, 'a target named by hand that cannot be built fails the run')
    assert.match(named.stdout, new RegExp(`${foreign}: skipped: builds on`))
    const unknown = node('--targets', 'nope', '--dry-run')
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /unknown target: nope/)
    const summary = node('--summary', out)
    assert.equal(summary.status, 0, summary.stderr)
    assert.match(summary.stdout, /^\| `windows-x64` \| built elsewhere \| .* windows-app\.yml builds it/m)
    assert.match(summary.stdout, /^\| `uefi-arm64` \| no report \|/m, 'a job builds it now: no report in an empty folder')
    assert.match(summary.stdout, /^\| `uefi-riscv64` \| no report \|/m)
    assert.equal((summary.stdout.match(/^\| `/gm) ?? []).length, 10)
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('the workflow: every buildable target but Windows x64 on a runner of its own, the same command a person runs, GitHub\'s own actions alone, a pull-request trigger so it runs before it is merged, and the release upload on a v* tag', () => {
  const jobs = [['windows-arm64', 'windows-latest'], ['linux-x64', 'ubuntu-22.04'], ['linux-arm64', 'ubuntu-22.04-arm'], ['macos-universal', 'macos-15'], ['android-apk', 'ubuntu-24.04'], ['ios-ipa', 'macos-15'], ['uefi-x64', 'ubuntu-24.04'], ['uefi-arm64', 'ubuntu-24.04'], ['uefi-riscv64', 'ubuntu-24.04']]
  for (const [id, runner] of jobs) {
    assert.match(WORKFLOW, new RegExp(`^ {10}- target: ${id}\\n {12}runner: ${runner}$`, 'm'), id)
  }
  assert.deepEqual(jobs.map(([id]) => id), IDS.filter((id) => id !== 'windows-x64'))
  assert.match(WORKFLOW, /^ {12}bestEffort: true$/m, 'the iOS build is best effort')
  assert.match(WORKFLOW, /continue-on-error: \$\{\{ matrix\.bestEffort == true \}\}/)
  assert.match(WORKFLOW, /node tools\/build\/matrix\.mjs --targets "\$\{\{ matrix\.target \}\}" --out out/)
  assert.match(WORKFLOW, /node tools\/build\/matrix\.mjs --summary reports/)
  assert.match(WORKFLOW, /^on:\n {2}pull_request:\n {4}paths:\n(?: {6}- .*\n)* {6}- tools\/build\/\*\*$/m)
  assert.match(WORKFLOW, /^ {2}push:\n {4}tags: \['v\*'\]$/m)
  assert.match(WORKFLOW, /^ {2}workflow_dispatch:/m)
  for (const line of WORKFLOW.split('\n').filter((l) => /^\s*(- )?uses:/.test(l))) assert.match(line, /uses: actions\/[a-z-]+@v\d+$/, line)
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m)
  // Each file name whole: every Tauri bundle's name carries the product's, spaces and all.
  assert.match(WORKFLOW, /mapfile -t files < <\(find media -type f \| sort\)/)
  assert.match(WORKFLOW, /gh release upload "\$TAG" "\$\{files\[@\]\}" --clobber/)
  assert.match(WORKFLOW, /gh release create "\$TAG" "\$\{files\[@\]\}" --verify-tag/)
  assert.doesNotMatch(WORKFLOW, / \$files /)
  // The x86-64 media on a release are build-release.yml's (baked twice, compared); the build matrix's copies stay off.
  assert.match(WORKFLOW, /rm -rf media\/matrix-report-\* media\/matrix-uefi-x64$/m)
  for (const path of ['crimson_noir_os/boot/**', 'crimson_noir_os/crates/**', 'crimson_noir_os/tools/**', 'crimson_noir_os/.cargo/**', 'crimson_noir_os/containment.nix', 'crimson_noir_os/containment.lock', 'crimson_noir_os/NOTICE.txt']) assert.ok(WORKFLOW.includes(`      - ${path}\n`), path)
  assert.match(WORKFLOW, /rustup toolchain install "\$RUST_TOOLCHAIN"/)
  assert.match(WORKFLOW, /RUST_TOOLCHAIN: '1\.97\.0'/, 'the toolchain build-release.yml and windows-app.yml pin')
  // The release workflow asks for this build on a tag it made itself, as it asks for the Windows app.
  const release = readFileSync(join(ROOT, '.github', 'workflows', 'build-release.yml'), 'utf8')
  assert.match(release, /for wf in windows-app\.yml build-matrix\.yml; do/)
  assert.match(release, /gh workflow run "\$wf" --ref "\$\{GITHUB_REF_NAME\}" -f "tag=\$TAG"/)
})

/** One step of the build job: from its `- name:` (or `- id:`) line to the next step. */
function jobStep(flow: string, marker: string): string {
  const at = flow.indexOf(marker)
  assert.ok(at > 0, marker)
  const start = flow.lastIndexOf('\n      - ', at)
  const next = flow.indexOf('\n      - ', at)
  return flow.slice(start, next < 0 ? undefined : next)
}

test('the Linux jobs: Ubuntu 22.04, the model by its pin as the Windows app gets it, room on the disk, the package checks before any upload, and the installed app asked on x86-64', () => {
  const W = WORKFLOW
  // The libraries, with cmake and libclang for llama.cpp, the package checks' tools, WebKitWebDriver and Xvfb; each
  // checked present, and llama.cpp's HTTP library kept from finding OpenSSL.
  const apt = jobStep(W, "The Linux shell's libraries")
  for (const pkg of ['libwebkit2gtk-4.1-dev', 'libgtk-3-dev', 'cmake', 'libclang-dev', 'rpm', 'squashfs-tools', 'webkit2gtk-driver', 'xvfb', 'patchelf', 'file']) assert.match(apt, new RegExp(`[ \\n]${pkg.replace(/[.]/g, '\\.')}(?= |\\n|$)`), pkg)
  assert.match(apt, /command -v cmake rpm unsquashfs WebKitWebDriver xvfb-run/)
  assert.match(apt, /echo "CMAKE_DISABLE_FIND_PACKAGE_OpenSSL=ON" >> "\$GITHUB_ENV"/)
  // The model exactly as windows-app.yml gets it: the pin, a cache keyed by it, Hugging Face only on a miss, then the
  // check and the copy on every build.
  const app = readFileSync(join(ROOT, '.github', 'workflows', 'windows-app.yml'), 'utf8')
  for (const line of ['run: node tools/web/siteModel.mjs pin --pin app | tee -a "$GITHUB_OUTPUT"', 'path: ${{ runner.temp }}/app-model', 'key: ${{ steps.model.outputs.key }}',
    'curl --proto \'=https\' --tlsv1.2 -sSfL --retry 4 --retry-all-errors --retry-delay 5 "$URL" -o "$RUNNER_TEMP/app-model/$FILE"', 'node tools/web/siteModel.mjs app --from "$RUNNER_TEMP/app-model"']) {
    assert.ok(app.includes(line), `windows-app.yml: ${line}`)
    assert.ok(W.includes(line), `build-matrix.yml: ${line}`)
  }
  // The jobs marked model: the two Linux ones and the macOS one, nothing else.
  assert.match(jobStep(W, '- id: model\n'), /if: matrix\.model\n/)
  assert.match(jobStep(W, '- id: model-cache'), /if: matrix\.model\n/)
  assert.match(jobStep(W, 'from Hugging Face, at the pinned revision'), /if: matrix\.model && steps\.model-cache\.outputs\.cache-hit != 'true'\n/)
  assert.match(jobStep(W, 'Checked byte for byte'), /if: matrix\.model\n/)
  const marked = [...W.matchAll(/^ {10}- target: (\S+)\n {12}runner: \S+\n {12}model: true$/gm)].map((x) => x[1])
  assert.deepEqual(marked, CARRIERS)
  assert.equal((W.match(/model: true/g) ?? []).length, 3)
  // A Linux cache key names the runner's image, so objects built against another glibc's headers are never restored.
  assert.match(W, /key: build-matrix-\$\{\{ matrix\.target \}\}-\$\{\{ startsWith\(matrix\.target, 'linux-'\) && format\('\{0\}-', matrix\.runner\) \|\| '' \}\}\$\{\{ env\.RUST_TOOLCHAIN \}\}-/)
  // The key hashes what decides how llama.cpp is built: both lockfiles, the features both Cargo.toml files turn on, and
  // the macOS slices' CMake include (the file macEnv hashes into GGML_SLICES_SHA256). actions/cache saves nothing after
  // an exact hit, so a key these leave as it was would keep restoring an entry built without them, and every run would
  // build llama.cpp again and save none of it. The restore key is the key's own prefix, so a new key starts warm.
  const key = /^ {10}key: (build-matrix-.*-)\$\{\{ hashFiles\(([^)]*)\) \}\}\n {10}restore-keys: (.*)$/m.exec(W)
  assert.ok(key, 'one key, its hash last, the restore key after it')
  assert.deepEqual(key[2].split(', ').map((f) => f.replace(/^'(.*)'$/, '$1')), ['src-tauri/Cargo.lock', 'crimson_noir_os/Cargo.lock', 'src-tauri/Cargo.toml', 'native/llm/Cargo.toml', m.MAC_SLICES])
  assert.equal(key[3], key[1], 'the restore key is the key without its hash')
  assert.equal(W.match(/hashFiles\('src-tauri\/Cargo\.lock'/g)?.length, 1, 'one build cache')
  // The order: room, libraries, the model, the build, the three checks, then tauri-driver, the install and the run,
  // and only then the upload; the cache leaves the packages and the model's copies out.
  const order = ['Room on the disk for the model', "The Linux shell's libraries", '- id: model\n', 'siteModel.mjs app --from', 'node tools/build/matrix.mjs --targets "${{ matrix.target }}" --out out',
    'linuxAudit.mjs packages --dir "out/${{ matrix.target }}" --file "$MODEL_FILE" --bytes "$MODEL_BYTES" --binary src-tauri/target/release/crimson-noir-app',
    'linuxAudit.mjs glibc --deb out/${{ matrix.target }}/*.deb',
    'linuxAudit.mjs symbols --deb out/${{ matrix.target }}/*.deb --map src-tauri/target/release/crimson-noir-app.map --deps src-tauri/target/release/deps',
    'cargo install tauri-driver --version "$TAURI_DRIVER_VERSION" --locked', 'sudo apt-get install -y -q --no-install-recommends ./out/linux-x64/*.deb',
    'xvfb-run -a node tools/browser/nativeE2e.mjs --packaged --app /usr/bin/crimson-noir-app --file "$MODEL_FILE" --bytes "$MODEL_BYTES"',
    'name: matrix-${{ matrix.target }}', 'rm -rf src-tauri/target/release/bundle src-tauri/target/release/models'].map((x) => W.indexOf(x))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`)
  for (const name of ['The Linux packages carry the model', 'The glibc floor', 'No download, HTTP or subprocess code']) assert.match(jobStep(W, name), /if: startsWith\(matrix\.target, 'linux-'\)\n/, name)
  for (const name of ['tauri-driver ${{ env.TAURI_DRIVER_VERSION }}', 'The .deb installed on this runner']) assert.match(jobStep(W, name), /if: matrix\.target == 'linux-x64'\n/, name)
  assert.match(W, /TAURI_DRIVER_VERSION: '2\.1\.0'/)
  assert.equal(readFileSync(join(ROOT, '.github', 'workflows', 'native-e2e.yml'), 'utf8').match(/TAURI_DRIVER_VERSION: '([\d.]+)'/)?.[1], '2.1.0', 'the version native-e2e.yml installs')
  // The packaged run is told the pin's file and size, never a name written here.
  const run = jobStep(W, 'The .deb installed on this runner')
  assert.match(run, /MODEL_FILE: \$\{\{ steps\.model\.outputs\.file \}\}\n {10}MODEL_BYTES: \$\{\{ steps\.model\.outputs\.bytes \}\}/)
  assert.doesNotMatch(run, /Qwen|gguf/)
  // The disk: printed between the heavy steps, room made in each job that holds every target's files, and the Linux
  // packages (mostly the model, which does not compress) uploaded as they are.
  assert.ok((W.match(/df -h \//g) ?? []).length >= 8, 'df -h between the heavy steps')
  const room = 'sudo rm -rf /usr/local/lib/android /usr/share/dotnet /opt/ghc /usr/local/.ghcup /opt/hostedtoolcache/CodeQL'
  assert.equal(W.split(room).length - 1, 2, 'the Linux jobs and the release job make room')
  const release = W.slice(W.indexOf('\n  release:\n'))
  assert.ok(release.indexOf(room) > 0 && release.indexOf(room) < release.indexOf('actions/download-artifact'), 'the release job makes room before it downloads')
  assert.match(W, /compression-level: \$\{\{ matrix\.model && '0' \|\| '6' \}\}/)
  // The paths that change what the Linux jobs build or check.
  for (const path of ['native/llm/**', 'src/09_Cognition/siteModel.ts', 'tools/web/siteModel.mjs', 'third_party/qwen2.5-1.5b-instruct/**', 'third_party/llama.cpp/**', 'tools/browser/nativeE2e.mjs', 'tools/browser/tinyGguf.mjs']) assert.ok(W.includes(`      - ${path}\n`), path)
  // No other job turns the runner on or fetches the model: the model's steps name the marked jobs, the Linux checks the
  // Linux targets, the macOS checks the macOS one.
  const job = W.slice(W.indexOf('\n    steps:\n'), W.indexOf('\n  summary:\n'))
  for (const step of job.split('\n      - ').slice(1).filter((st) => /siteModel\.mjs|app-model/.test(st))) assert.match(step, /if: matrix\.model(?: &&|\n)/, step.slice(0, 120))
  for (const step of job.split('\n      - ').slice(1).filter((st) => /linuxAudit|nativeE2e/.test(st))) {
    assert.match(step, /if: (?:startsWith\(matrix\.target, 'linux-'\)|matrix\.target == 'linux-x64')/, step.slice(0, 120))
  }
  for (const step of job.split('\n      - ').slice(1).filter((st) => /macAudit/.test(st))) assert.match(step, /if: matrix\.target == 'macos-universal'\n/, step.slice(0, 120))
})

test('the macOS job: the model by its pin, room on the disk, both slices with the runner, and six checks before any upload, none of them skipped or allowed to fail', () => {
  const W = WORKFLOW
  const mac = "if: matrix.target == 'macos-universal'\n"
  // The job is not best effort: a failing check fails the run.
  assert.match(W, /^ {10}- target: macos-universal\n {12}runner: macos-15\n {12}model: true\n {10}- target: android-apk$/m)
  const job = W.slice(W.indexOf('\n    steps:\n'), W.indexOf('\n  summary:\n'))
  const steps = job.split('\n      - ').slice(1)
  const checks = steps.filter((st) => /macAudit\.mjs/.test(st))
  assert.deepEqual(checks.map((st) => /node tools\/build\/macAudit\.mjs (\w+)/.exec(st)?.[1]), ['package', 'archs', 'libraries', 'minos', 'symbols', 'slices'])
  for (const st of checks) {
    assert.ok(st.includes(mac), st.slice(0, 120))
    assert.doesNotMatch(st, /continue-on-error|always\(\)|\|\| true/, st.slice(0, 120))
  }
  assert.match(W, /^ {2}MAC_APP: src-tauri\/target\/universal-apple-darwin\/release\/bundle\/macos$/m, 'where Tauri leaves the universal .app')
  // The package check reads the pin's file and size, the .dmg and the zip the build left, one of each.
  const pkg = jobStep(W, 'node tools/build/macAudit.mjs package')
  assert.match(pkg, /MODEL_FILE: \$\{\{ steps\.model\.outputs\.file \}\}\n {10}MODEL_BYTES: \$\{\{ steps\.model\.outputs\.bytes \}\}/)
  assert.match(pkg, /node tools\/build\/macAudit\.mjs package --app "\$MAC_APP" --file "\$MODEL_FILE" --bytes "\$MODEL_BYTES" --dmg "\$\{dmg\[0\]\}" --zip "\$\{zip\[0\]\}"/)
  assert.match(pkg, /echo "::error::expected one \.dmg and one zipped \.app in out\/macos-universal"; exit 1/)
  assert.doesNotMatch(pkg, /Qwen|gguf/)
  // The symbols check reads the map build.rs has Apple's linker write beside each slice's binary.
  assert.match(jobStep(W, 'macAudit.mjs symbols'), /--map src-tauri\/target\/aarch64-apple-darwin\/release\/crimson-noir-app\.map --map src-tauri\/target\/x86_64-apple-darwin\/release\/crimson-noir-app\.map/)
  assert.match(readFileSync(join(ROOT, 'src-tauri', 'build.rs'), 'utf8'), /profile\.join\("crimson-noir-app\.map"\)[\s\S]*format!\("-Wl,-map,\{\}", map\.display\(\)\)/)
  assert.match(jobStep(W, 'macAudit.mjs slices'), /--target src-tauri\/target/)
  // The order: room, the model, the build, the six checks, the upload, the cache left without the app and the copies.
  const order = ["Room on the disk for the model's copies (the runner's Android SDK, CodeQL and .NET go", '- id: model\n', 'siteModel.mjs app --from',
    'node tools/build/matrix.mjs --targets "${{ matrix.target }}" --out out', 'macAudit.mjs package', 'macAudit.mjs archs', 'macAudit.mjs libraries',
    'macAudit.mjs minos', 'macAudit.mjs symbols', 'macAudit.mjs slices', 'name: matrix-${{ matrix.target }}',
    'rm -rf src-tauri/target/universal-apple-darwin/release/bundle src-tauri/target/*-apple-darwin/release/models src-tauri/target/*-apple-darwin/release/build/llama-cpp-sys-2-*/out/build'].map((x) => W.indexOf(x))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`)
  // Room: the Android SDK, CodeQL and .NET, each only when it is there, with the disk printed before and after.
  const room = jobStep(W, "Room on the disk for the model's copies (the runner's Android SDK, CodeQL and .NET go")
  assert.ok(room.includes(mac))
  assert.match(room, /df -h \/\n {10}for dir in "\$\{ANDROID_HOME:-\}" "\$\{RUNNER_TOOL_CACHE:-\}\/CodeQL" "\$HOME\/\.dotnet"; do\n {12}if \[ -n "\$dir" \] && \[ -d "\$dir" \]; then sudo rm -rf "\$dir"; fi\n {10}done\n {10}df -h \//)
  assert.match(jobStep(W, 'macAudit.mjs package'), /df -h \//)
  assert.match(jobStep(W, 'macAudit.mjs slices'), /df -h \//)
  assert.match(jobStep(W, 'The macOS app, the model\'s copies and llama.cpp\'s CMake folders stay out'), /if: always\(\) && matrix\.target == 'macos-universal'\n/)
  // The zip is stored, not deflated again: the model does not compress, and the upload stores it as it is.
  assert.deepEqual(m.zipArgs('a.app', 'a.zip'), ['-c', '-k', '--keepParent', '--zlibCompressionLevel', '0', 'a.app', 'a.zip'])
  // The release job: the model-carrying files of every job, room made before they come down.
  assert.match(W.slice(W.indexOf('\n  release:\n')), /eight of them about a gigabyte each, the Linux packages and the\n {6}# macOS \.dmg and zipped \.app/)
})

test('the Windows app\'s workflow packages an .msi from the same binary, with the numbers as WiX\'s version, and keeps it as an artifact and on a tag\'s release', () => {
  const app = readFileSync(join(ROOT, '.github', 'workflows', 'windows-app.yml'), 'utf8')
  assert.match(app, /numbers=\$\(node -p "require\('\.\/package\.json'\)\.version\.split\(\/\[-\+\]\/\)\[0\]"\)/)
  assert.match(app, /node node_modules\/@tauri-apps\/cli\/tauri\.js bundle --bundles msi --config/)
  assert.match(app, /cp src-tauri\/target\/release\/bundle\/msi\/\*"_\$\{version\}_"\*\.msi out\/msi\//)
  assert.match(app, /name: windows-msi-\$\{\{ steps\.version\.outputs\.version \}\}/)
  assert.match(app, /grep -E '\\\.\(exe\|msi\)\$' \| grep -vF "_\$\{VERSION\}_"/, 'an .msi of another version left on the release goes too, and this version\'s arm64 ones stay')
  assert.match(app, /VERSION: \$\{\{ needs\.build\.outputs\.version \}\}/)
  // The bundle step comes after the build that made the binary.
  assert.ok(app.indexOf('npm run app:build') < app.indexOf('bundle --bundles msi'))
})

test('the package script and the docs name the one command', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts['build:matrix'], 'node tools/build/matrix.mjs')
  const manual = readFileSync(join(ROOT, 'MANUAL.md'), 'utf8')
  assert.match(manual, /^## The build matrix$/m)
  assert.match(manual, /npm run build:matrix/)
  for (const id of IDS) assert.ok(manual.includes(`\`${id}\``), `MANUAL.md names ${id}`)
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  assert.match(readme, /npm run build:matrix/)
  assert.match(readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8'), /build:matrix/)
})
