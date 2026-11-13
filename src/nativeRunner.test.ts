// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the native model runner's crate (native/llm: llama.cpp in the app's own process,
 * for the macOS, Linux, Android and iOS apps) and the workflow that tests it, from the page's side of the repository:
 * the binding at one exact version with its default features off (no OpenMP library at run time), the lockfile
 * holding exactly that version, sources that reach no network and start no process, the wire file (tests/wire.json)
 * naming every event, ending, error and status the page will read, and native-llm.yml running the crate's tests and
 * the real model's on x86-64 Linux, Arm Linux and Apple Silicon, with GitHub's own actions alone, outside ci.yml.
 * The crate's behaviour is tested by its own Rust tests (native/llm/tests); this file keeps the frame they run in.
 * What breaks if it is removed? A floating binding version, an OpenMP dependency, a network call in the runner, or a
 * workflow that silently skips the real model could all land unseen.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

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

test('the runner reaches no network and starts no process', () => {
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

test('the wire file names every event, ending, error and status the page will read', () => {
  const wire = JSON.parse(read(CRATE, 'tests', 'wire.json')) as {
    request: Record<string, unknown>
    events: { kind: string }[]
    done: { reason: string }[]
    errors: { code: string; message: string }[]
    statuses: { state: string }[]
  }
  assert.deepEqual(Object.keys(wire.request).sort(), ['id', 'maxTokens', 'messages', 'think'])
  assert.deepEqual(wire.events.map((e) => e.kind), ['waiting', 'preparing', 'loading', 'read', 'text'])
  assert.deepEqual(wire.done.map((d) => d.reason), ['eog', 'maxTokens', 'stopped', 'context'])
  assert.deepEqual(Object.keys(wire.done[0]).sort(), ['genMs', 'gpu', 'id', 'nBatch', 'nCtx', 'prefillMs', 'promptTokens', 'reason', 'reused', 'threads', 'tokens'])
  assert.deepEqual(wire.errors.map((e) => e.code), ['offline', 'refused', 'model'])
  assert.deepEqual(wire.statuses.map((s) => s.state), ['preparing', 'ready', 'loaded', 'failed'])
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
  // Not in ci.yml: it runs on every change and wakes the self-healing workflow, whose sandbox cannot build llama.cpp.
  assert.ok(!read(ROOT, '.github', 'workflows', 'ci.yml').includes('native/llm'))
  assert.ok(!read(ROOT, 'tools', 'selfheal', 'checks.sh').includes('native/llm'))
})
