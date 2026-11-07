// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the cross-platform build matrix (tools/build/matrix.mjs, `npm run build:matrix`,
 * .github/workflows/build-matrix.yml): the nine targets in the plan's order, each a program and an argument vector
 * (never a shell line, so cmd.exe and sh run the same thing), the page built once and never again by a Tauri step,
 * what blocks a target on a machine that cannot build it (and why UEFI aarch64 has no build at all), what `host` and
 * `all` select, the command line's exits, the workflow that runs every buildable target on its own runner with
 * GitHub's own actions alone, the release dispatch, the package script and the manual's section.
 * What breaks if it is removed? A target can silently become a shell string, drop out of the workflow, or build the
 * page twice, and the docs can name a command that no longer exists.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A computed specifier: the script is tooling under tools/, outside the page's build, loaded as the test's own module.
const MATRIX: string = '../tools/build/matrix.mjs'
const m = await import(MATRIX)
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'tools', 'build', 'matrix.mjs')
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'build-matrix.yml'), 'utf8')

interface Step { kind: string; cmd?: string; argv?: string[]; cwd?: string }
interface Target { id: string; artifact: string; hosts: string[]; arch?: string; tools?: string[]; env?: string[]; unsupported?: string; note?: string; plan?: (ctx: object) => Step[] }
interface Host { platform: string; arch: string; env: Record<string, string>; has: (cmd: string) => boolean }

const TARGETS: readonly Target[] = m.TARGETS
const IDS: readonly string[] = m.IDS
const host = (platform: string, arch: string, env: Record<string, string> = {}): Host => ({ platform, arch, env, has: () => true })
const LINUX = host('linux', 'x64')
const CTX = { out: '/tmp/out', version: '1.0.0-stable-beta', media: true, dryRun: true }

test('the nine targets, in the order the plan names them, each saying what it makes', () => {
  assert.deepEqual(IDS, ['windows-x64', 'windows-arm64', 'linux-x64', 'linux-arm64', 'macos-universal', 'android-apk', 'ios-ipa', 'uefi-x64', 'uefi-arm64'])
  for (const t of TARGETS) {
    assert.match(t.artifact, /\S/, t.id)
    if (t.unsupported) assert.deepEqual(t.hosts, [], `${t.id} builds nowhere`)
    else assert.ok(t.hosts.length > 0 && typeof t.plan === 'function', t.id)
  }
  assert.ok(Object.isFrozen(TARGETS))
})

test('every plan is programs with argument vectors, never a shell line; every Tauri step says the page is already built; the page is built under this Node', () => {
  const sdk = { ANDROID_HOME: 'x', NDK_HOME: 'y', JAVA_HOME: 'z' }
  const hosts: Record<string, Host[]> = { win32: [host('win32', 'x64', sdk)], linux: [host('linux', 'x64', sdk), host('linux', 'arm64', sdk)], darwin: [host('darwin', 'arm64', sdk)] }
  for (const t of TARGETS) {
    if (!t.plan) continue
    const steps = t.plan(CTX)
    assert.ok(steps.length > 0, t.id)
    for (const s of steps) {
      if (s.kind !== 'run') { assert.ok(['sign-apk', 'xcode-ios'].includes(s.kind), `${t.id}: ${s.kind}`); continue }
      assert.ok(typeof s.cmd === 'string' && Array.isArray(s.argv), `${t.id}: ${JSON.stringify(s)}`)
      // No shell: the one `sh` is the repository's own media script, run by path with its arguments.
      if (s.cmd === 'sh') assert.deepEqual(s.argv!.slice(0, 1), ['tools/build-image.sh'], t.id)
      assert.ok(!['bash', 'cmd', 'cmd.exe', 'powershell', 'pwsh'].includes(s.cmd!), `${t.id}: ${s.cmd}`)
      for (const a of s.argv!) assert.ok(!/&&|\|\||[;|><`$]/.test(a) || a.startsWith('{'), `${t.id}: shell syntax in an argument: ${a}`)
      if (s.argv![0]?.endsWith('tauri.js')) {
        assert.equal(s.cmd, process.execPath, `${t.id}: the Tauri CLI runs under this Node`)
        const verb = s.argv![1] === 'android' || s.argv![1] === 'ios' ? s.argv![2] : s.argv![1]
        if (verb === 'build') {
          const i = s.argv!.indexOf('--config')
          assert.ok(i > 0, `${t.id}: a build without --config would build the page again`)
          assert.deepEqual(JSON.parse(s.argv![i + 1]), { build: { beforeBuildCommand: '' } }, t.id)
        }
      }
    }
    // The target builds on at least one machine of the kinds the table knows (both Linux architectures among them).
    const machines = t.hosts.flatMap((h) => hosts[h])
    assert.ok(machines.some((h) => m.blocker(t, h) === null), `${t.id}: ${machines.map((h) => m.blocker(t, h)).join('; ')}`)
  }
})

test('what blocks a target on this or that machine: the operating system, the architecture, a variable, a program; the UEFI aarch64 reason names the x86-64 code', () => {
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
  const arm = m.blocker(TARGETS[8], host('linux', 'arm64'))
  assert.match(arm, /^unsupported: crimson_noir_os\/boot\/src\/arch\.rs/)
  // The reason is true of the code: the boot crate's machine layer is x86-64 assembly.
  const archRs = readFileSync(join(ROOT, 'crimson_noir_os', 'boot', 'src', 'arch.rs'), 'utf8')
  assert.match(archRs, /asm!\("out dx, al"/)
  assert.match(archRs, /asm!\("in al, dx"/)
  assert.ok(!existsSync(join(ROOT, 'crimson_noir_os', 'boot', 'src', 'arch_aarch64.rs')), 'an aarch64 port would make the target supported: update the table')
})

test('select: all, host (this machine\'s desktop app and the UEFI application), a list of ids, and an unknown id named with the choices', () => {
  assert.equal(m.select('all').targets.length, 9)
  assert.equal(m.select('all').named, false)
  assert.deepEqual(m.select('host', { platform: 'win32', arch: 'x64' }).targets.map((t: Target) => t.id), ['windows-x64', 'uefi-x64'])
  assert.deepEqual(m.select(undefined, { platform: 'linux', arch: 'x64' }).targets.map((t: Target) => t.id), ['linux-x64', 'uefi-x64'])
  assert.deepEqual(m.select('host', { platform: 'linux', arch: 'arm64' }).targets.map((t: Target) => t.id), ['linux-arm64', 'uefi-x64'])
  assert.deepEqual(m.select('host', { platform: 'darwin', arch: 'arm64' }).targets.map((t: Target) => t.id), ['macos-universal', 'uefi-x64'])
  const picked = m.select('uefi-x64, linux-x64')
  assert.deepEqual(picked.targets.map((t: Target) => t.id), ['uefi-x64', 'linux-x64'])
  assert.equal(picked.named, true)
  assert.throws(() => m.select('nope,linux-x64'), /unknown target: nope \(one of windows-x64, .*uefi-arm64, all, host\)/)
})

test('the command line: --list names the nine; a dry run of all exits 0, builds the page in the plan and writes nothing; a named target this machine cannot build exits 1; an unknown one exits 1', () => {
  const node = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' })
  const list = node('--list')
  assert.equal(list.status, 0, list.stderr)
  for (const id of IDS) assert.match(list.stdout, new RegExp(`^${id} `, 'm'))
  assert.match(list.stdout, /^uefi-arm64 {7}unsupported/m)
  const out = mkdtempSync(join(tmpdir(), 'matrix-dry-'))
  try {
    const dry = node('--targets', 'all', '--dry-run', '--out', out)
    assert.equal(dry.status, 0, dry.stderr)
    assert.match(dry.stdout, /\(dry run\)/)
    assert.match(dry.stdout, /^ {2}page: node .*tsc -b$/m)
    assert.match(dry.stdout, /^ {2}page: node .*vite\.js build$/m)
    assert.match(dry.stdout, /^planned {5}uefi-x64$/m, 'the UEFI application builds on any machine with cargo')
    assert.match(dry.stdout, /^unsupported uefi-arm64/m)
    assert.ok(!existsSync(join(out, 'matrix.json')), 'a dry run writes no report')
    const named = node('--targets', 'uefi-arm64', '--dry-run', '--out', out)
    assert.equal(named.status, 1, 'a target named by hand that cannot be built fails the run')
    assert.match(named.stdout, /uefi-arm64: skipped: unsupported/)
    const unknown = node('--targets', 'nope', '--dry-run')
    assert.equal(unknown.status, 1)
    assert.match(unknown.stderr, /unknown target: nope/)
    const summary = node('--summary', out)
    assert.equal(summary.status, 0, summary.stderr)
    assert.match(summary.stdout, /^\| `windows-x64` \| built elsewhere \| .* windows-app\.yml builds it/m)
    assert.match(summary.stdout, /^\| `uefi-arm64` \| unsupported \|/m)
    assert.equal((summary.stdout.match(/^\| `/gm) ?? []).length, 9)
  } finally { rmSync(out, { recursive: true, force: true }) }
})

test('the workflow: every buildable target but Windows x64 on a runner of its own, the same command a person runs, GitHub\'s own actions alone, a pull-request trigger so it runs before it is merged, and the release upload on a v* tag', () => {
  const jobs = [['windows-arm64', 'windows-latest'], ['linux-x64', 'ubuntu-24.04'], ['linux-arm64', 'ubuntu-24.04-arm'], ['macos-universal', 'macos-15'], ['android-apk', 'ubuntu-24.04'], ['ios-ipa', 'macos-15'], ['uefi-x64', 'ubuntu-24.04']]
  for (const [id, runner] of jobs) {
    assert.match(WORKFLOW, new RegExp(`^ {10}- target: ${id}\\n {12}runner: ${runner}$`, 'm'), id)
  }
  assert.deepEqual(jobs.map(([id]) => id), IDS.filter((id) => id !== 'windows-x64' && id !== 'uefi-arm64'))
  assert.match(WORKFLOW, /^ {12}bestEffort: true$/m, 'the iOS build is best effort')
  assert.match(WORKFLOW, /continue-on-error: \$\{\{ matrix\.bestEffort == true \}\}/)
  assert.match(WORKFLOW, /node tools\/build\/matrix\.mjs --targets "\$\{\{ matrix\.target \}\}" --out out/)
  assert.match(WORKFLOW, /node tools\/build\/matrix\.mjs --summary reports/)
  assert.match(WORKFLOW, /^on:\n {2}pull_request:\n {4}paths:\n(?: {6}- .*\n)* {6}- tools\/build\/\*\*$/m)
  assert.match(WORKFLOW, /^ {2}push:\n {4}tags: \['v\*'\]$/m)
  assert.match(WORKFLOW, /^ {2}workflow_dispatch:/m)
  for (const line of WORKFLOW.split('\n').filter((l) => /^\s*(- )?uses:/.test(l))) assert.match(line, /uses: actions\/[a-z-]+@v\d+$/, line)
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m)
  assert.match(WORKFLOW, /gh release upload "\$TAG" \$files --clobber/)
  assert.match(WORKFLOW, /rustup toolchain install "\$RUST_TOOLCHAIN"/)
  assert.match(WORKFLOW, /RUST_TOOLCHAIN: '1\.97\.0'/, 'the toolchain build-release.yml and windows-app.yml pin')
  // The release workflow asks for this build on a tag it made itself, as it asks for the Windows app.
  const release = readFileSync(join(ROOT, '.github', 'workflows', 'build-release.yml'), 'utf8')
  assert.match(release, /for wf in windows-app\.yml build-matrix\.yml; do/)
  assert.match(release, /gh workflow run "\$wf" --ref "\$\{GITHUB_REF_NAME\}" -f "tag=\$TAG"/)
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
