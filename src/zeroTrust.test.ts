// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the repository's attack surface to what the product is, so nothing stray can come
 * back unnoticed (a shell-command HTTP server once sat at the root, unauthenticated, on every interface; a developer's
 * assistant permission list with their own paths was once committed):
 * - no developer's local AI tooling is tracked, and .gitignore, both image build contexts, the self-heal sandbox's
 *   tree and the Nix page's source keep every name of it out (tools/selfheal/sandbox.mjs AI_TOOLING);
 * - nothing runs a command through a shell: no `exec`/`execSync` from child_process and no `shell: true` anywhere;
 *   the tooling that spawns (build, smoke, sandbox, self-heal) names its program and passes an argument vector;
 * - exactly one module serves the network, the room host (src/10_Network/replication.node.ts: token-authenticated,
 *   loopback unless NET_HOST says otherwise, throttled per address); a test's server binds 127.0.0.1 and port 0; the
 *   desktop launcher (tools/web/launch.mjs, what `nix run` starts) serves the built page to this machine alone, on
 *   127.0.0.1 and a fixed port, because the page keeps its settings per address;
 * - the page ships no server framework, and the dev server keeps Vite's loopback default.
 * What breaks if it is removed? A shell-executing endpoint, an unauthenticated listener on every interface or an
 * assistant's local config could land in a commit, an image or the sandbox, and only a reader would notice.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
// The sandbox module is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const SANDBOX: string = '../tools/selfheal/sandbox.mjs'
const { AI_TOOLING, EXCLUDE } = (await import(SANDBOX)) as { AI_TOOLING: readonly string[]; EXCLUDE: readonly string[] }
const SKIP = new Set(['.git', 'node_modules', 'target', 'dist', 'dist-ssr', 'dist-pilot', ...AI_TOOLING])
const CODE = /\.(?:[cm]?[jt]sx?)$/

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, out)
    else if (e.isFile()) out.push(relative(ROOT, p).split('\\').join('/'))
  }
  return out
}

const FILES = walk(ROOT)
// Generated wasm modules are base64 bytes; nothing in them is source.
const SOURCES = FILES.filter((f) => CODE.test(f) && !f.endsWith('.wasm.ts')).map((f) => ({ f, text: readFileSync(join(ROOT, f), 'utf8') }))
/** The patterns below as written in this file; the scan skips it. */
const SELF = relative(ROOT, fileURLToPath(import.meta.url)).split('\\').join('/')

/** Tracked files, or null where the tree has no history (the self-heal sandbox streams the tree in without .git). */
function tracked(): string[] | null {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\0').filter(Boolean)
  } catch {
    return null
  }
}

const isTooling = (path: string) => path.split('/').some((part) => AI_TOOLING.includes(part))

test('no local AI tooling is tracked, and git, both image contexts, the sandbox tree and the Nix page\'s source all keep it out', (t) => {
  const files = tracked()
  if (files === null) t.diagnostic('no git history here: the tracked-file check is skipped, the ignore lists are still checked')
  else assert.deepEqual(files.filter(isTooling), [], 'tracked AI tooling')
  assert.ok(isTooling('.claude/settings.local.json') && isTooling('a/b/.mcp.json') && !isTooling('src/09_Cognition/router.ts'))

  const lines = (f: string) => readFileSync(join(ROOT, f), 'utf8').split('\n').map((l) => l.trim())
  const gitignore = lines('.gitignore')
  for (const name of AI_TOOLING) assert.ok(gitignore.includes(name) || gitignore.includes(`${name}/`), `.gitignore lacks ${name}`)
  for (const f of ['.dockerignore', 'tools/selfheal/Dockerfile.sandbox.dockerignore']) {
    const l = lines(f)
    for (const name of AI_TOOLING) assert.ok(l.includes(`**/${name}`), `${f} lacks **/${name}`)
    // A later `!` line would admit what the exclusion removed: the exclusions come last.
    const last = Math.max(...AI_TOOLING.map((n) => l.indexOf(`**/${n}`)))
    assert.ok(!l.slice(last + 1).some((x) => x.startsWith('!')), `${f}: an allowlist line after the AI-tooling exclusions`)
  }
  for (const name of AI_TOOLING) assert.ok(EXCLUDE.includes(name), `the sandbox tree keeps ${name}`)
  // The Nix page's source, where it is not git's own file list (an unpacked archive), drops the same names.
  const pageNix = readFileSync(join(ROOT, 'tools/nix/page.nix'), 'utf8')
  for (const name of AI_TOOLING) assert.ok(pageNix.includes(`"${name}"`), `tools/nix/page.nix keeps ${name} out of the store`)
})

test('nothing runs a command through a shell: no exec or execSync from child_process, no shell: true', () => {
  const found: string[] = []
  for (const { f, text } of SOURCES) {
    if (f === SELF) continue
    for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"](?:node:)?child_process['"]/g)) {
      for (const name of m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0])) if (name === 'exec' || name === 'execSync') found.push(`${f}: imports ${name}`)
    }
    if (/require\(\s*['"](?:node:)?child_process['"]\s*\)/.test(text)) found.push(`${f}: requires child_process`)
    if (/\bchild_process\s*\.\s*exec(?:Sync)?\s*\(/.test(text) || /\bcp\.\s*exec(?:Sync)?\s*\(/.test(text)) found.push(`${f}: calls a shell exec`)
    if (/\bshell\s*:\s*true\b/.test(text)) found.push(`${f}: shell: true`)
  }
  assert.deepEqual(found, [])
})

test('one module serves the network (the authenticated room host); every test server binds 127.0.0.1 on port 0; the launcher binds 127.0.0.1', () => {
  const HOST = 'src/10_Network/replication.node.ts'
  // The browser smoke test serves dist/index.html to its own headless browser for the length of a run: a test server
  // in a tool's file, held to the test servers' rule.
  const HARNESSES = ['tools/browser/smoke.mjs']
  // The desktop launcher serves the built page to this machine's own browser. Its port is fixed (4180) because the
  // page keeps its settings per address, and a page opened from a file instead loses the shared bridge and the local
  // model servers (MANUAL.md, On NixOS): it may name any port, but only on the loopback literal.
  const LAUNCHERS = ['tools/web/launch.mjs']
  const servers: string[] = []
  const loose: string[] = []
  for (const { f, text } of SOURCES) {
    if (f === SELF) continue
    if (!/\bcreateServer\s*\(|\bcreateSecureServer\s*\(|\b(?:Deno|Bun)\.serve\s*\(/.test(text)) continue
    if (/\.test\.[cm]?[jt]sx?$/.test(f) || HARNESSES.includes(f)) {
      for (const m of text.matchAll(/\.listen\(([^)]*)\)/g)) if (!/^\s*0\s*,\s*'127\.0\.0\.1'/.test(m[1])) loose.push(`${f}: listen(${m[1]})`)
    } else if (LAUNCHERS.includes(f)) {
      const listens = [...text.matchAll(/\.listen\(([^)]*)\)/g)]
      if (listens.length === 0) loose.push(`${f}: serves without a listen() this test can read`)
      for (const m of listens) if (!/^\s*[\w.]+\s*,\s*'127\.0\.0\.1'/.test(m[1])) loose.push(`${f}: listen(${m[1]})`)
    } else servers.push(f)
  }
  assert.deepEqual(servers, [HOST], 'modules that serve')
  assert.deepEqual(loose, [], 'a test server off loopback or on a fixed port, or the launcher off loopback')
  const host = readFileSync(join(ROOT, HOST), 'utf8')
  assert.match(host, /const bind = o\.host \?\? '127\.0\.0\.1'/, 'the host binds loopback unless told otherwise')
  assert.match(host, /process\.env\.NET_HOST \?\? '127\.0\.0\.1'/, 'the entry point binds loopback unless NET_HOST says otherwise')
})

test('the page ships no server framework, and the dev server keeps Vite\'s loopback default', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
  const frameworks = ['express', 'fastify', 'koa', '@hapi/hapi', 'connect', 'http-server', 'restify', 'polka', 'hono']
  assert.deepEqual(all.filter((d) => frameworks.includes(d)), [])
  const vite = readFileSync(join(ROOT, 'vite.config.ts'), 'utf8')
  assert.doesNotMatch(vite, /\bserver\s*:/, 'vite.config.ts configures the dev server (its host would leave loopback)')
  for (const [name, script] of Object.entries((JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts)) {
    assert.doesNotMatch(script, /--host\b/, `npm run ${name} exposes a server off loopback`)
  }
})
