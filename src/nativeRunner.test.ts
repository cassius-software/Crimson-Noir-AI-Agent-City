// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the native model runner's crate (native/llm: llama.cpp in the app's own process,
 * for the macOS, Linux, Android and iOS apps) and the workflow that tests it, from the page's side of the repository:
 * the binding at one exact version with its default features off (no OpenMP library at run time), the lockfile
 * holding exactly that version and the build crates (cc, cmake, bindgen) at the app lockfile's versions, Rust sources
 * that reach no network and start no process, the wire file (tests/wire.json) with every key of every event, ending,
 * error, status and carried model the page will read, and native-llm.yml running the crate's tests and the real
 * model's on x86-64 Linux, Arm Linux and Apple Silicon, with GitHub's own actions alone, outside ci.yml, with no step
 * it must run skipped or allowed to fail. It pins native-e2e.yml too: the shell's own Rust tests and clippy, with the
 * runner and with the feature off, then the shell's commands driven in WebKitGTK on ubuntu-24.04 with the tiny model
 * (tools/browser/nativeE2e.mjs, which asks through the page's own shellRunner and createNativeMind, bundled from their
 * sources, one answer with its channel held back), on the paths that can change them (every module those two import
 * among them), its steps in order, GitHub's own actions alone, outside ci.yml and the self-healing checks. The crate's
 * behaviour is tested by its own Rust tests (native/llm/tests); this file keeps their frame.
 * What breaks if it is removed? A floating binding version, an OpenMP dependency, a network call in the runner, or a
 * workflow that silently skips the real model could all land unseen.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DRAIN_MS } from './07_Execute_Actions/desktopShell.ts'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CRATE = join(ROOT, 'native', 'llm')
const read = (...p: string[]): string => readFileSync(join(...p), 'utf8')
const MANIFEST = read(CRATE, 'Cargo.toml')
const WORKFLOW = read(ROOT, '.github', 'workflows', 'native-llm.yml')

test('the binding is pinned to one version, its default features off, and the lockfile holds exactly it', () => {
  assert.match(MANIFEST, /^llama-cpp-2 = \{ version = "=0\.1\.161", default-features = false \}$/m)
  assert.match(MANIFEST, /^llama-cpp-sys-2 = \{ version = "=0\.1\.161", default-features = false \}$/m)
  assert.ok(!/features = \[[^\]]*openmp/.test(MANIFEST), 'no OpenMP')
  assert.match(MANIFEST, /^license-file = "\.\.\/\.\.\/LICENSE"$/m)
  // The app's own release profile, so a timing measured in its tests means what it means in the app.
  const tauri = read(ROOT, 'src-tauri', 'Cargo.toml')
  const profile = (t: string): string => t.slice(t.indexOf('[profile.release]')).split('\n').slice(1, 6).sort().join('\n')
  assert.equal(profile(MANIFEST), profile(tauri))
  const lock = read(CRATE, 'Cargo.lock')
  for (const name of ['llama-cpp-2', 'llama-cpp-sys-2']) {
    const versions = [...lock.matchAll(new RegExp(`\\nname = "${name}"\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1])
    assert.deepEqual(versions, ['0.1.161'], `${name} in the lockfile`)
  }
})

test('the build crates match the app\'s lockfile, so CI builds llama.cpp as the app will', () => {
  const versions = (lock: string, name: string): string[] =>
    [...lock.matchAll(new RegExp(`\\nname = "${name}"\\nversion = "([^"]+)"`, 'g'))].map((m) => m[1])
  const crate = read(CRATE, 'Cargo.lock')
  const app = read(ROOT, 'src-tauri', 'Cargo.lock')
  for (const name of ['cc', 'cmake', 'bindgen']) {
    const ours = versions(crate, name)
    assert.equal(ours.length, 1, `${name} in native/llm/Cargo.lock`)
    // cmake and bindgen come into src-tauri/Cargo.lock with the runner; from then on they must match too.
    const theirs = versions(app, name)
    if (theirs.length > 0) assert.deepEqual(theirs, ours, `${name} in native/llm/Cargo.lock and src-tauri/Cargo.lock`)
  }
})

test('the runner\'s Rust sources reach no network and start no process', () => {
  const dir = join(CRATE, 'src')
  const sources = readdirSync(dir).filter((f) => f.endsWith('.rs'))
  assert.ok(sources.length >= 8, sources.join(', '))
  for (const f of sources) {
    const text = read(dir, f)
    for (const banned of [/std::net\b/, /std::process\b/, /\bCommand::new\b/, /TcpStream|UdpSocket|reqwest|ureq|hyper/]) {
      assert.ok(!banned.test(text), `${f}: ${banned}`)
    }
  }
})

test('the wire file names every event, ending, error, status and carried model the page will read', () => {
  const wire = JSON.parse(read(CRATE, 'tests', 'wire.json')) as {
    request: { messages: { role: string }[] } & Record<string, unknown>
    events: { kind: string }[]
    done: { reason: string }[]
    errors: { code: string }[]
    statuses: { state: string }[]
    models: ({ status: { state: string } } & Record<string, unknown>)[]
  }
  // Every key of every entry, so a renamed payload field (fraction, text, content, refused...) fails here too.
  const keys = (o: object): string => Object.keys(o).sort().join(' ')
  assert.equal(keys(wire), 'done errors events models request statuses')
  assert.equal(keys(wire.request), 'id maxTokens messages think')
  assert.deepEqual(wire.request.messages.map((m) => [m.role, keys(m)]), [
    ['system', 'content role'], ['user', 'content role'], ['assistant', 'content role'],
  ])
  assert.deepEqual(wire.events.map((e) => [e.kind, keys(e)]), [
    ['waiting', 'kind'], ['preparing', 'done kind total'], ['loading', 'fraction kind'], ['read', 'done kind total'],
    ['text', 'kind text'],
  ])
  const DONE = 'genMs gpu id nBatch nCtx prefillMs promptTokens reason reused threads tokens'
  const reasons = ['eog', 'maxTokens', 'stopped', 'context']
  assert.deepEqual(wire.done.map((d) => [d.reason, keys(d)]), reasons.map((r) => [r, DONE]))
  const codes = ['offline', 'refused', 'model']
  assert.deepEqual(wire.errors.map((e) => [e.code, keys(e)]), codes.map((c) => [c, 'code message']))
  assert.deepEqual(wire.statuses.map((s) => [s.state, keys(s)]), [
    ['preparing', 'done state total'], ['ready', 'state'], ['loaded', 'state'], ['failed', 'reason refused state'],
  ])
  // What native_model answers, once in each status, the status exactly as the statuses above.
  assert.deepEqual(wire.models.map((m) => [m.status.state, keys(m)]), wire.statuses.map((s) => [s.state, 'bytes file status']))
  assert.deepEqual(wire.models.map((m) => m.status), wire.statuses)
})

test('native-llm.yml tests the crate and the real model on Linux, Arm Linux and Apple Silicon, with GitHub\'s own actions alone', () => {
  assert.match(WORKFLOW, /^name: native-llm$/m)
  assert.match(WORKFLOW, /runner: \[ubuntu-24\.04, ubuntu-24\.04-arm, macos-15\]/)
  assert.match(WORKFLOW, /^permissions:\n {2}contents: read$/m)
  for (const uses of WORKFLOW.matchAll(/uses: ([^\s@]+)@/g)) assert.ok(uses[1].startsWith('actions/'), uses[1])
  assert.match(WORKFLOW, /persist-credentials: false/)
  for (const path of ['native/llm/**', 'tools/browser/tinyGguf.mjs', 'src/09_Cognition/siteModel.ts', '.github/workflows/native-llm.yml']) {
    assert.equal(WORKFLOW.split(`- ${path}`).length - 1, 2, `${path} under both pull_request and push`)
  }
  // Every tiny model form, the tests, clippy, then the pinned model checked before the real tests.
  assert.ok(WORKFLOW.includes('for form in "" --split --plain; do node tools/browser/tinyGguf.mjs'))
  const order = [
    'cargo clippy --manifest-path native/llm/Cargo.toml --release --locked --all-targets -- -D warnings',
    'cargo test --manifest-path native/llm/Cargo.toml --release --locked\n',
    'node tools/web/siteModel.mjs pin',
    'node tools/web/siteModel.mjs check --from',
    '--test real -- --ignored',
  ].map((s) => WORKFLOW.indexOf(s))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`)
  // Nothing that must run is skipped or allowed to fail: the apt step (Linux only), the Hugging Face fetch (cache miss
  // only) and the cache trim (always) are the only conditions, and no job or step may fail without failing the run.
  assert.doesNotMatch(WORKFLOW, /continue-on-error/, 'a failing step fails the job')
  const conditions = [...WORKFLOW.matchAll(/^[ \t]*(?:- )?if:\s*(.*)$/gm)].map((m) => m[1])
  assert.deepEqual(conditions, ["runner.os == 'Linux'", "steps.model-cache.outputs.cache-hit != 'true'", 'always()'])
  // Not in ci.yml: it runs on every change and wakes the self-healing workflow, whose sandbox cannot build llama.cpp.
  assert.ok(!read(ROOT, '.github', 'workflows', 'ci.yml').includes('native/llm'))
  assert.ok(!read(ROOT, 'tools', 'selfheal', 'checks.sh').includes('native/llm'))
})

/**
 * The page modules `entries` draw in, as repository paths: every relative import and re-export that is not
 * type-only, followed to the end (a superset of what a bundler keeps).
 */
function closure(entries: string[]): string[] {
  const seen = new Set<string>()
  const walk = (file: string): void => {
    const rel = relative(ROOT, file)
    if (seen.has(rel)) return
    seen.add(rel)
    const text = readFileSync(file, 'utf8')
    for (const m of text.matchAll(/^(?:import|export)\s+(?!type\b)[^'";]*?from\s+'(\.[^']+)'/gm)) walk(join(dirname(file), m[1]))
    for (const m of text.matchAll(/^import\s+'(\.[^']+)'/gm)) walk(join(dirname(file), m[1]))
  }
  for (const e of entries) walk(join(ROOT, e))
  return [...seen].sort()
}

test('native-e2e.yml drives the shell\'s commands in WebKitGTK with the tiny model, on the paths that change them, outside ci.yml', () => {
  const flow = read(ROOT, '.github', 'workflows', 'native-e2e.yml')
  assert.match(flow, /^# Copyright \(c\) 2026 Julian Cassius Subban\n# SPDX-License-Identifier: MIT\n/)
  assert.match(flow, /^name: native-e2e$/m)
  assert.match(flow, /^ {4}runs-on: ubuntu-24\.04$/m)
  assert.equal([...flow.matchAll(/runs-on:/g)].length, 1, 'one job, on one runner')
  assert.match(flow, /^permissions:\n {2}contents: read$/m)
  for (const uses of flow.matchAll(/uses: ([^\s@]+)@/g)) assert.ok(uses[1].startsWith('actions/'), uses[1])
  assert.match(flow, /- uses: actions\/checkout@v4\n {8}with:\n {10}persist-credentials: false/)
  assert.match(flow, /RUST_TOOLCHAIN: '1\.97\.0'/)
  assert.match(flow, /TAURI_DRIVER_VERSION: '\d+\.\d+\.\d+'/, 'tauri-driver at an exact version')
  // The triggers: a pull request and a push to main on exactly these paths, and by hand: the shell and the runner, the
  // page modules the script bundles with every module they import, the page's boot and policy, and the tools.
  const BUNDLED = closure(['src/07_Execute_Actions/desktopShell.ts', 'src/09_Cognition/nativeMind.ts'])
  assert.ok(BUNDLED.includes('src/02_Define_The_Rules/airgap.ts') && BUNDLED.length >= 10, BUNDLED.join(', '))
  const PATHS = ['src-tauri/**', 'native/llm/**', ...BUNDLED, 'src/main.tsx', 'index.html', 'tools/browser/tinyGguf.mjs', 'tools/browser/nativeE2e.mjs', '.github/workflows/native-e2e.yml']
  const on = flow.slice(flow.indexOf('\non:\n'), flow.indexOf('\npermissions:'))
  const listed = (block: string): string[] => [...block.matchAll(/^ {6}- (.+)$/gm)].map((m) => m[1])
  assert.deepEqual(listed(on.slice(on.indexOf('pull_request:'), on.indexOf('push:'))), PATHS)
  assert.deepEqual(listed(on.slice(on.indexOf('push:'), on.indexOf('workflow_dispatch:'))), PATHS)
  assert.match(on, /push:\n {4}branches: \[main\]/)
  assert.match(on, /\n {2}workflow_dispatch:\n?$/)
  // The steps in order: Rust with clippy, the libraries (with WebKitWebDriver, Xvfb, cmake and libclang), the page, the
  // tiny model where the overlay takes it from, the app with the feature and that overlay, the shell's Rust tests and
  // clippy with the runner and the tiny model then with the feature off (the stub every shipped build runs),
  // tauri-driver, then the run under Xvfb.
  const order = [
    'rustup toolchain install "$RUST_TOOLCHAIN" --profile minimal --component clippy',
    'libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libssl-dev webkit2gtk-driver xvfb cmake libclang-dev',
    'npm ci --no-audit --no-fund',
    'run: npm run build',
    'node tools/browser/tinyGguf.mjs src-tauri/models',
    'TAURI_CONFIG="$(cat src-tauri/tauri.tiny.conf.json)" cargo build --manifest-path src-tauri/Cargo.toml --locked --features tiny-model,tauri/custom-protocol\n',
    'test -f src-tauri/target/debug/models/tiny-a.gguf',
    'TAURI_CONFIG="$(cat src-tauri/tauri.tiny.conf.json)" cargo test --manifest-path src-tauri/Cargo.toml --locked --features tiny-model,tauri/custom-protocol\n',
    'TAURI_CONFIG="$(cat src-tauri/tauri.tiny.conf.json)" cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets --features tiny-model,tauri/custom-protocol -- -D warnings\n',
    'cargo test --manifest-path src-tauri/Cargo.toml --locked\n',
    'cargo clippy --manifest-path src-tauri/Cargo.toml --locked --all-targets -- -D warnings\n',
    'cargo install tauri-driver --version "$TAURI_DRIVER_VERSION" --locked',
    'xvfb-run -a node tools/browser/nativeE2e.mjs --app src-tauri/target/debug/crimson-noir-app',
  ].map((s) => flow.indexOf(s))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`)
  // Nothing that must run is skipped or allowed to fail: only the report's upload and the cache trim run always.
  assert.doesNotMatch(flow, /continue-on-error/)
  assert.deepEqual([...flow.matchAll(/^[ \t]*(?:- )?if:\s*(.*)$/gm)].map((m) => m[1]), ['always()', 'always()'])
  // Not in ci.yml (every change, and its failures wake the self-healing workflow) nor in the self-healing checks.
  for (const other of [read(ROOT, '.github', 'workflows', 'ci.yml'), read(ROOT, 'tools', 'selfheal', 'checks.sh')]) {
    assert.ok(!other.includes('native-e2e') && !other.includes('nativeE2e') && !other.includes('tiny-model'))
  }
  // The script speaks WebDriver with fetch alone, starts tauri-driver and nothing else, and adds no dependency: vite
  // (already the page's build tool) and Node's own modules.
  const script = read(ROOT, 'tools', 'browser', 'nativeE2e.mjs')
  assert.match(script, /^#!\/usr\/bin\/env node\n\/\/ Copyright \(c\) 2026 Julian Cassius Subban\n\/\/ SPDX-License-Identifier: MIT\n/)
  const imports = [...script.matchAll(/^import .* from '([^']+)'$/gm)].map((m) => m[1]).sort()
  assert.ok(imports.includes('vite') && imports.every((i) => i === 'vite' || i === './tinyGguf.mjs' || i.startsWith('node:')), imports.join(', '))
  const pkg = JSON.parse(read(ROOT, 'package.json')) as { devDependencies?: Record<string, string> }
  assert.ok(pkg.devDependencies?.vite, 'vite is already a devDependency')
  assert.equal([...script.matchAll(/\bspawn\(/g)].length, 1, 'one process: tauri-driver')
  assert.match(script, /executeAsync|execute\/async/)
  // The page's own shellRunner and createNativeMind, bundled from their sources (an entry in a temporary folder, an
  // IIFE kept in memory), injected after the page's module ran and again after the reload, and asked through.
  assert.match(script, /const SHELL = 'src\/07_Execute_Actions\/desktopShell\.ts'/)
  assert.match(script, /const MIND = 'src\/09_Cognition\/nativeMind\.ts'/)
  assert.match(script, /`import \{ shellRunner \} from \$\{from\(SHELL\)\}`/)
  assert.match(script, /`import \{ createNativeMind, LOADING_APP \} from \$\{from\(MIND\)\}`/)
  assert.match(script, /mkdtempSync\(join\(tmpdir\(\), 'native-e2e-'\)\)/, 'the entry is written to a temporary folder')
  assert.match(script, /write: false, minify: false, target: 'es2022', lib: \{ entry, formats: \['iife'\]/)
  assert.match(script, /execute\/sync`, \{ script: `\$\{report\.bundle\.code\}/)
  assert.match(script, /await inject\('the first page'\)/)
  assert.match(script, /await wd\('POST', `\/session\/\$\{sid\}\/refresh`, \{\}\)\n {2}await inject\('after the reload'\)/)
  assert.match(script, /const host = own\.shellRunner\(\)/)
  assert.ok(script.split('own.createNativeMind({ host: w.host').length - 1 >= 5, 'the answers, the Stop, the wait and the new page asked through the mind')
  assert.doesNotMatch(script, /core\.invoke\(/, 'every command goes through the page\'s own shellRunner')
  // One answer's channel held back, each message and then its end, well within the wait for the end, so that answer
  // comes whole only through a shellRunner that waits for the end before it hands back the reply.
  const hold = Number(/^const HOLD_MS = (\d+)$/m.exec(script)?.[1])
  assert.ok(hold >= 100 && hold <= DRAIN_MS / 2, `HOLD_MS ${hold}`)
  assert.match(script, /const held = await page\(ANSWER, 64, HOLD_MS\)\n {2}answered\(.*, held, 64, \{ holdMs: HOLD_MS \}\)/)
  assert.match(script, /window\.__nativeE2eHold = holdMs\nlet r\ntry \{ r = await ask\(mind\) \} finally \{ window\.__nativeE2eHold = 0 \}/)
})
