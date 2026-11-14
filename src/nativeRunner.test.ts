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
 * sources, one answer with its channel held back, then the console alone opened from the recovery card and an ask
 * typed into it), on the paths that can change them (every module those two and the page's router import among them,
 * and the console's own files), its steps in order, GitHub's own actions alone, outside ci.yml and the self-healing
 * checks. The crate's
 * behaviour is tested by its own Rust tests (native/llm/tests); this file keeps their frame.
 * What breaks if it is removed? A floating binding version, an OpenMP dependency, a network call in the runner, or a
 * workflow that silently skips the real model could all land unseen.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DRAIN_MS } from './07_Execute_Actions/desktopShell.ts'
import { CONSOLE_TALKS_LINE } from './07_Execute_Actions/bootFailure.ts'

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
    'node tools/web/siteModel.mjs pin | tee',
    'node tools/web/siteModel.mjs check --from',
    '--test real -- --ignored',
    // Then the desktop's model on the x86-64 job: its own pin, its own cache, checked, and the Linux plan's test.
    'node tools/web/siteModel.mjs pin --pin app | tee',
    'path: ${{ runner.temp }}/app-model\n          key: ${{ steps.app-model.outputs.key }}',
    '"$URL" -o "$RUNNER_TEMP/app-model/$FILE"',
    'node tools/web/siteModel.mjs check --pin app --from "$RUNNER_TEMP/app-model"',
    'APP_GGUF="$RUNNER_TEMP/app-model/$FILE" cargo test --manifest-path native/llm/Cargo.toml --release --locked --test desktop -- --ignored',
  ].map((s) => WORKFLOW.indexOf(s))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), `in order: ${order}`)
  // Nothing that must run is skipped or allowed to fail: the apt step (Linux only), the Hugging Face fetches (cache
  // miss only), the desktop's model (the x86-64 job alone: one gigabyte download is enough) and the cache trim
  // (always) are the only conditions, and no job or step may fail without failing the run.
  assert.doesNotMatch(WORKFLOW, /continue-on-error/, 'a failing step fails the job')
  const conditions = [...WORKFLOW.matchAll(/^[ \t]*(?:- )?if:\s*(.*)$/gm)].map((m) => m[1])
  const x86 = "matrix.runner == 'ubuntu-24.04'"
  assert.deepEqual(conditions, ["runner.os == 'Linux'", "steps.model-cache.outputs.cache-hit != 'true'", x86, x86, `${x86} && steps.app-model-cache.outputs.cache-hit != 'true'`, x86, x86, 'always()'])
  for (const path of ['third_party/qwen2.5-1.5b-instruct/**']) assert.equal(WORKFLOW.split(`- ${path}`).length - 1, 2, `${path} under both pull_request and push`)
  // The test reads a few greedy tokens of the desktop's model with the Linux app's own plan (src-tauri/src/runner.rs).
  const desktop = read(ROOT, 'native', 'llm', 'tests', 'desktop.rs')
  const runner = read(ROOT, 'src-tauri', 'src', 'runner.rs')
  const plan = /Plan \{ n_ctx: (\d+), n_batch: (\d+), threads: half_the_threads\((\d+)\), gpu: Gpu::Off, max_tokens: (\d+), sampling: Sampling::Greedy \}/.exec(desktop)
  assert.ok(plan, 'the Linux plan, greedy')
  assert.deepEqual(plan.slice(1).map(Number), ['N_CTX: u32', 'N_BATCH: u32', 'THREADS_CAP: i32', 'MAX_TOKENS: u32'].map((c) => Number(new RegExp(`pub const ${c.replace(/[()]/g, '\\$&')} = (\\d+);`).exec(runner)?.[1])))
  assert.match(desktop, /#\[ignore = "needs APP_GGUF/)
  const carried = /pub const FILE: &str = "([^"]+)";/.exec(read(ROOT, 'src-tauri', 'src', 'model_file.rs'))?.[1]
  assert.ok(carried && desktop.includes(`const APP_FILE: &str = "${carried}";`), 'the file the shell carries (model_file.rs FILE)')
  assert.match(desktop, /ask\(&engine, req\(1, messages, 8\)\)/, 'a few tokens')
  assert.match(desktop, /matches!\(done\.reason, Reason::Eog \| Reason::MaxTokens\)/)
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
  // The console alone's talk with Sloane is driven there too: the page's router (pageMind.ts, with every module it
  // imports), and the console's own files from the card's button to the answer's lines.
  const BUNDLED = closure(['src/07_Execute_Actions/desktopShell.ts', 'src/09_Cognition/nativeMind.ts', 'src/09_Cognition/pageMind.ts'])
  assert.ok(BUNDLED.includes('src/02_Define_The_Rules/airgap.ts') && BUNDLED.includes('src/09_Cognition/router.ts') && BUNDLED.length >= 10, BUNDLED.join(', '))
  const CONSOLE = ['src/App.tsx', 'src/07_Execute_Actions/RecoveryCard.tsx', 'src/07_Execute_Actions/bootFailure.ts', 'src/07_Execute_Actions/operator.ts',
    'src/07_Execute_Actions/terminal/Terminal.tsx', 'src/07_Execute_Actions/terminal/bridge.ts', 'src/07_Execute_Actions/terminal/commands.ts', 'src/07_Execute_Actions/terminal/consoleBridge.ts']
  assert.ok(CONSOLE.every((f) => !BUNDLED.includes(f)), 'listed once')
  const PATHS = ['src-tauri/**', 'native/llm/**', ...BUNDLED, ...CONSOLE, 'src/main.tsx', 'index.html', 'tools/browser/tinyGguf.mjs', 'tools/browser/nativeE2e.mjs', '.github/workflows/native-e2e.yml']
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

test('the installed Linux app is asked through nativeE2e.mjs --packaged: the carried file and size from its arguments, one answer of at most 16 tokens', () => {
  const script = read(ROOT, 'tools', 'browser', 'nativeE2e.mjs')
  assert.match(script, /^const PACKAGED = process\.argv\.includes\('--packaged'\)$/m)
  assert.match(script, /^const CARRIED = PACKAGED \? Object\.freeze\(\{ file: arg\('file'\), bytes: Number\(arg\('bytes'\)\) \}\) : null$/m)
  assert.match(script, /^const PACKAGED_TOKENS = 16$/m)
  assert.match(script, /await \(PACKAGED \? packaged\(\) : run\(\)\)/)
  const body = script.slice(script.indexOf('async function packaged()'), script.indexOf('\nasync function run()'))
  assert.ok(body.length > 500, 'packaged() is there')
  // The carried file and size are the arguments' (CI passes the pin's), never the tiny model's.
  assert.doesNotMatch(body, /TINY|tiny-a|156[_,]?992/)
  assert.match(body, /m\.file === CARRIED\.file && m\.bytes === CARRIED\.bytes && Object\.keys\(m\)\.sort\(\)\.join\(' '\) === 'bytes file status'/)
  assert.match(body, /m\.status\.state === 'ready'/)
  // A gigabyte's check takes longer than the tiny model's, and the in-page wait ends well before WebDriver's script
  // timeout, so a run whose model never settles still reports what native_model answered and the states it went
  // through, instead of an opaque script timeout; the script timeout stays below Node fetch's 300 s headers timeout.
  assert.match(body, /await page\(MODEL, PACKAGED_MODEL_MS\)/)
  const constant = (name: string): number => Number(new RegExp(`^const ${name} = ([\\d_]+)$`, 'm').exec(script)?.[1].replaceAll('_', '') ?? NaN)
  const wait = constant('PACKAGED_MODEL_MS')
  const scriptMs = constant('SCRIPT_MS')
  assert.ok(wait > 60_000 && wait <= scriptMs - 20_000, `the in-page wait (${wait} ms) ends at least 20 s before the script timeout (${scriptMs} ms)`)
  assert.ok(scriptMs < 300_000, 'below Node fetch\'s 300 s headers timeout')
  assert.match(script, /timeouts`, \{ script: SCRIPT_MS, pageLoad: SCRIPT_MS \}/)
  assert.doesNotMatch(script, /page\([A-Z_]+, (?:1[89]\d|[2-9]\d\d)_000\)/, 'no in-page wait as long as the script timeout')
  // One answer through the page's own mind, as text events, ending with a reason within the cap.
  assert.match(body, /await page\(ANSWER, PACKAGED_TOKENS\)/)
  assert.match(body, /texts\.length > 0 && textOf\(g\.events\)\.trim\(\) !== ''/)
  assert.match(body, /\(d\.reason === 'eog' \|\| d\.reason === 'maxTokens'\) && d\.tokens >= 1 && d\.tokens <= PACKAGED_TOKENS/)
  assert.match(body, /\^\(loading,\)\+\(read,\)\+\(text,\)\+\$/)
  // Without the file or its size it refuses to start (exit 2), before tauri-driver is started.
  for (const args of [['--packaged', '--app', '/nowhere'], ['--packaged', '--app', '/nowhere', '--file', 'x.gguf'], ['--packaged', '--app', '/nowhere', '--file', 'x.gguf', '--bytes', 'many']]) {
    const r = spawnSync(process.execPath, [join(ROOT, 'tools', 'browser', 'nativeE2e.mjs'), ...args, '--driver', '/nowhere/tauri-driver'], { cwd: ROOT, encoding: 'utf8' })
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stderr}`)
    assert.match(r.stderr, /--packaged --app <the installed app> --file <the carried model> --bytes <its size>/)
  }
  // build-matrix.yml's x86-64 job runs it against the installed binary with the pin's file and size.
  const matrix = read(ROOT, '.github', 'workflows', 'build-matrix.yml')
  assert.ok(matrix.includes('xvfb-run -a node tools/browser/nativeE2e.mjs --packaged --app /usr/bin/crimson-noir-app --file "$MODEL_FILE" --bytes "$MODEL_BYTES"'))
  assert.ok(read(ROOT, 'src-tauri', 'Cargo.toml').includes('name = "crimson-noir-app"'), 'the binary the .deb installs as /usr/bin/crimson-noir-app')
})

test('nativeE2e.mjs opens the console alone from the card and types an ask into it, in the tiny-model app and in the installed one', () => {
  const script = read(ROOT, 'tools', 'browser', 'nativeE2e.mjs')
  // The card's line, word for word as the page shows it (bootFailure.ts), waited for while the card asks the runner.
  const line = /^const CONSOLE_TALKS_LINE = ("[^"]+"|'[^']+')$/m.exec(script)?.[1]
  assert.ok(line, 'the script holds the card\'s line')
  assert.equal(JSON.parse(line.startsWith('"') ? line : `"${line.slice(1, -1)}"`), CONSOLE_TALKS_LINE)
  assert.match(script, /card\.querySelector\('\[data-console-sloane\]'\)/)
  // The card's own button, clicked through WebDriver; without a card (a web view with WebGPU) the address instead.
  assert.match(script, /element\('xpath', "\/\/button\[normalize-space\(\.\)='Open the console'\]"\)/)
  assert.match(script, /\/element\/\$\{button\}\/click`/)
  assert.match(script, /u\.searchParams\.set\('boot', 'tty'\)/)
  // The console alone is up and drew no city, then the lines are typed with WebDriver's keys into its real prompt.
  assert.match(script, /location\.search\.includes\('boot=tty'\) && window\.__bootDone === true && !!document\.querySelector\('\[aria-label\$="Ring-0 terminal"\]\[data-full\]'\)/)
  assert.match(script, /check\(up && up\.ok && up\.canvases === 0,/)
  assert.match(script, /element\('css selector', 'textarea\[aria-label="Ring-0 command line"\]'\)/)
  assert.match(script, /\/element\/\$\{id\}\/value`, \{ text \}/)
  assert.match(script, /await typeLine\(`operator unlock\$\{ENTER\}`\)/)
  assert.match(script, /await typeLine\(`ask hello\$\{ENTER\}`\)/)
  assert.match(script, /r\.lines\[0\] === 'ask: asking Sloane'/)
  assert.match(script, /check\(r\.finished,/)
  // The terminal's own hooks the script reads (Terminal.tsx).
  const terminal = read(ROOT, 'src', '07_Execute_Actions', 'terminal', 'Terminal.tsx')
  for (const hook of ['aria-label="Ring-0 command line"', 'aria-label="Ring-0 output"', 'aria-label={`${b.brand.name} Ring-0 terminal`}', 'data-streaming=""', 'r0-line r0-out', 'data-full={fullscreen || undefined}']) {
    assert.ok(terminal.includes(hook), hook)
  }
  // The tiny-model app: after the runner's own checks, the tiny model's "a"s through the router's auto order, and
  // `ask` alone naming the model this app carries.
  const run = script.slice(script.indexOf('\nasync function run()'), script.indexOf('\nconst driver = spawn('))
  assert.match(run, /const c = await consoleAlone\('the console'\)/)
  assert.match(run, /\/\^a\{1,600\}…\?\$\/\.test\(c\.lines\[1\]\)/)
  assert.match(run, /found\\s\+native: the model this app carries/)
  // The installed app: one short ask, stopped once its first words have streamed; any text will do, no words expected.
  const packaged = script.slice(script.indexOf('async function packaged()'), script.indexOf('\nasync function run()'))
  assert.match(packaged, /const c = await consoleAlone\('the installed app\\'s console', \{ stopEarly: true \}\)/)
  assert.match(packaged, /said\.length > 0 && said\.join\(' '\)\.trim\(\)\.length > 0/)
  assert.doesNotMatch(packaged.slice(packaged.indexOf("consoleAlone('the installed")), /a\{1,|hello there|Sloane:/, 'no words of the model\'s are expected')
  assert.match(script, /await typeLine\(`ask stop\$\{ENTER\}`\)/)
  // The stop, typed once the first words came, may follow an answer that ended first: its reply then comes last, so
  // the end is judged without the stop's own replies, and neither of them ends an answer by itself.
  const stopReply = /const end = c\.lines\.filter\(\(l\) => !\/(.+?)\/\.test\(l\)\)\.at\(-1\) \?\? ''/.exec(packaged)?.[1]
  assert.ok(stopReply, 'the packaged run judges the end without the stop\'s own replies')
  const endOf = (lines: string[]): string | undefined => lines.filter((l) => !new RegExp(stopReply).test(l)).at(-1)
  assert.equal(endOf(['ask: asking Sloane', 'Hello there.', '-- answered in 0.4 s --', 'ask: no answer is being generated']), '-- answered in 0.4 s --', 'ended first')
  assert.equal(endOf(['ask: asking Sloane', 'ask: stopping the answer', 'Hello', 'ask: stopped by the operator']), 'ask: stopped by the operator', 'stopped')
  const done = /^const done = \/(.+)\/$/m.exec(script)?.[1]
  assert.ok(done)
  for (const reply of ['ask: stopping the answer', 'ask: no answer is being generated']) assert.equal(new RegExp(done).test(reply), false, reply)
  for (const end of ['-- answered in 0.4 s --', 'ask: stopped by the operator', '-- no reply --', 'ask: no model is answering']) assert.equal(new RegExp(done).test(end), true, end)
  // Every console wait ends below WebDriver's script timeout.
  const consoleMs = Number(/^const CONSOLE_MS = ([\d_]+)$/m.exec(script)?.[1].replaceAll('_', ''))
  const scriptMs = Number(/^const SCRIPT_MS = ([\d_]+)$/m.exec(script)?.[1].replaceAll('_', ''))
  assert.ok(consoleMs > 0 && consoleMs <= scriptMs - 20_000, `${consoleMs} ms against ${scriptMs} ms`)
})

test('main sets GGML_NO_BACKTRACE first, where the runner is compiled, so llama.cpp never starts a debugger on the app', () => {
  const main = read(ROOT, 'src-tauri', 'src', 'main.rs')
  const body = main.slice(main.indexOf('fn main() {'))
  const code = body.split('\n').slice(1).map((l) => l.trim()).filter((l) => l && !l.startsWith('//'))
  assert.deepEqual(code.slice(0, 3), ['#[cfg(all(target_os = "linux", feature = "native-runner"))]', 'std::env::set_var("GGML_NO_BACKTRACE", "1");', 'crimson_noir_app_lib::run()'])
  assert.match(body, /\/\/ SAFETY: /)
  assert.match(read(ROOT, 'src-tauri', 'Cargo.toml'), /^edition = "2021"$/m, 'set_var is safe in edition 2021; an edition 2024 build needs an unsafe block here')
  // The Rust test beside the runner pins the same lines.
  assert.match(read(ROOT, 'src-tauri', 'src', 'runner.rs'), /fn main_turns_off_llama_cpp_debugger_backtrace_first_where_the_runner_is_compiled\(\)/)
  // ggml's crash handler (fork and execlp of a debugger) is linked, so wherever the docs or a step name say the binary
  // keeps no subprocess code of llama.cpp, they say it of llama.cpp's common library, which the symbol audit checks.
  const docs = [['MANUAL.md'], ['CHANGELOG.md'], ['NOTICE.md'], ['docs', 'ip-audit.md'], ['.github', 'workflows', 'build-matrix.yml'], ['tools', 'build', 'linuxAudit.mjs']]
  for (const path of docs) {
    const flat = read(ROOT, ...path).replace(/\s+/g, ' ')
    for (const m of flat.matchAll(/subprocess code of llama\.cpp('s common library)?/g)) {
      assert.ok(m[1], `${path.join('/')}: "${flat.slice(Math.max(0, m.index - 80), m.index + 60)}" says it of all of llama.cpp`)
    }
    assert.doesNotMatch(flat, /llama\.cpp's (?:download|process|[\w ,]* subprocess) (?:and process )?code/, `${path.join('/')}: the claim names llama.cpp as a whole`)
  }
  assert.match(read(ROOT, 'MANUAL.md').replace(/\s+/g, ' '), /ggml's crash handler, which can start a debugger, is linked, and `main` switches it off with `GGML_NO_BACKTRACE`/)
})
