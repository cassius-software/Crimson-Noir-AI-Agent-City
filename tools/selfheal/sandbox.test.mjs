/**
 * Why does this file exist? It holds the sandbox's containment where no docker is needed: the `docker run`
 * arguments the agent uses carry every flag CONTAINMENT names and no mount of a host path; the environment the
 * container is given comes from an allowlist and a credential-shaped name is refused, whatever the caller; the
 * tree the container receives has no history, no installed modules and no build output at any depth; the entry
 * script puts the build output on the one mount with exec; and the probe script, run on this unconfined host, is
 * a live control: it finds escapes and exits 1 (tools/sandbox/verify.mjs runs it contained, where it must find
 * none). What breaks if it is removed? A flag could be dropped from the containment and nothing would say so.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

import { CONTAINMENT, CREDENTIAL_NAME, ENTRY, ENV_ALLOWED, EXCLUDE, IMAGE, copyTree, dockerArgs, envArgs, tarTree } from './sandbox.mjs'
import { MUST_FLIP, controlArgs, parseProbes } from '../sandbox/verify.mjs'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

test('the docker run arguments carry the whole containment, in order, and mount nothing of the host', () => {
  const args = dockerArgs(['page-test'], { NOIR_REQUIRE_GPU: '1' })
  const joined = args.join(' ')
  for (const part of Object.values(CONTAINMENT)) assert.ok(joined.includes(part.join(' ')), `carries ${part.join(' ')}`)
  assert.ok(joined.includes('--network none'), 'the air gap')
  assert.ok(joined.includes('--user sandbox'), 'not root')
  assert.ok(joined.includes('--cap-drop ALL'), 'no capability')
  assert.ok(joined.includes('--security-opt no-new-privileges:true'), 'no privilege gain')
  assert.ok(joined.includes('--read-only'), 'a read-only root')
  assert.ok(args.includes('--rm'), 'ephemeral')
  assert.ok(args.includes('-i'), 'the tree arrives on stdin')
  for (const dir of ['/work', '/tmp']) {
    const tmpfs = args[args.indexOf('--tmpfs', args.findIndex((a) => a.startsWith(`${dir}:`)) - 1) + 1]
    assert.ok(tmpfs.startsWith(`${dir}:`), `${dir} is a tmpfs`)
    for (const flag of ['noexec', 'nosuid', 'nodev']) assert.ok(tmpfs.split(':')[1].split(',').includes(flag), `${dir} is ${flag}`)
  }
  assert.ok(!args.includes('-v') && !args.includes('--volume'), 'no -v')
  for (const a of args) assert.ok(!/type=bind/.test(a), `no bind mount: ${a}`)
  const mounts = args.filter((a, i) => args[i - 1] === '--mount')
  assert.deepEqual(mounts, ['type=volume,dst=/build'], 'the build volume is the only mount, and it is not a host path')
  assert.ok(!joined.includes('--privileged') && !joined.includes('--pid host') && !joined.includes('--network host'))
  assert.equal(args[args.indexOf(IMAGE) + 1], 'sh')
  assert.deepEqual(args.slice(-2), ['checks', 'page-test'])
})

test('the environment the container is given is an allowlist; a credential-shaped name is refused, allowlisted or not', () => {
  const args = envArgs({ NOIR_REQUIRE_GPU: '1' })
  assert.ok(args.includes('NOIR_REQUIRE_GPU=1'))
  for (const p of ['HTTP_PROXY=', 'HTTPS_PROXY=', 'ALL_PROXY=', 'NO_PROXY=', 'http_proxy=', 'https_proxy=']) assert.ok(args.includes(p), `${p} is emptied`)
  for (const name of ['ANTHROPIC_API_KEY', 'GH_TOKEN', 'GITHUB_TOKEN', 'NPM_AUTH_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'DOCKER_PASSWORD', 'SSH_AUTH_SOCK', 'CARGO_REGISTRY_TOKEN']) {
    assert.throws(() => envArgs({ [name]: 'x' }), /credential-shaped/, `${name} is refused`)
    assert.ok(CREDENTIAL_NAME.test(name))
  }
  assert.throws(() => envArgs({ PATH: '/evil' }), /not an environment variable the container may be given/)
  assert.throws(() => envArgs({ LD_PRELOAD: '/evil.so' }), /not an environment variable/)
  for (const name of ENV_ALLOWED) assert.ok(!CREDENTIAL_NAME.test(name), `${name} is not credential-shaped`)
  // The agent's own environment is never the container's: only the explicit `env` reaches envArgs.
  const withSecret = { ...process.env, ANTHROPIC_API_KEY: 'sk-test' }
  const docker = dockerArgs(['page-test'], {}).join(' ')
  assert.ok(!docker.includes('sk-test') && !docker.includes('ANTHROPIC'), 'nothing of the process environment is passed')
  assert.ok(withSecret.ANTHROPIC_API_KEY)
})

test('the tree the container receives has no history, installed modules or build output at any depth', () => {
  const tree = mkdtempSync(join(tmpdir(), 'sandbox-tar-'))
  for (const d of ['.git', 'node_modules/x', 'crimson_noir_os/target/debug', 'native/routing/target', 'src/a', 'dist', 'tools/selfheal']) mkdirSync(join(tree, d), { recursive: true })
  writeFileSync(join(tree, '.git/config'), '[credential] helper = store\n')
  writeFileSync(join(tree, 'node_modules/x/index.js'), '')
  writeFileSync(join(tree, 'crimson_noir_os/target/debug/noir'), '')
  writeFileSync(join(tree, 'crimson_noir_os/Cargo.toml'), '')
  writeFileSync(join(tree, 'src/a/x.ts'), 'export const x = 1\n')
  writeFileSync(join(tree, 'dist/index.html'), '')
  writeFileSync(join(tree, 'tools/selfheal/checks.sh'), '')
  const listing = spawnSync('tar', ['-tf', '-'], { input: tarTree(tree), encoding: 'utf8' }).stdout.split('\n').filter(Boolean)
  assert.ok(!listing.includes('./') && !listing.includes('.'), 'the tree itself is not an entry')
  assert.ok(listing.includes('src/a/x.ts') && listing.includes('crimson_noir_os/Cargo.toml') && listing.includes('tools/selfheal/checks.sh'))
  for (const entry of listing) for (const e of EXCLUDE) assert.ok(!entry.split('/').includes(e), `${entry} is excluded`)
  const copy = copyTree(tree)
  assert.ok(existsSync(join(copy, 'src/a/x.ts')))
  assert.ok(!existsSync(join(copy, '.git')) && !existsSync(join(copy, 'crimson_noir_os/target')) && !existsSync(join(copy, 'native/routing/target')), 'the host copy excludes at any depth too')
  rmSync(copy, { recursive: true, force: true })
  rmSync(tree, { recursive: true, force: true })
})

test('the entry script unpacks into /work, links the modules in one by one, and puts every crate\'s build output on /build', () => {
  assert.match(ENTRY, /^set -e\n/)
  assert.ok(ENTRY.includes('tar -xf - --no-same-owner -C /work'))
  assert.ok(ENTRY.includes('mkdir /work/node_modules') && ENTRY.includes('ln -s "$e" /work/node_modules/'), 'a directory of links, so node_modules/.tmp is writable')
  for (const crate of ['crimson_noir_os', 'native/routing', 'native/kv-pager', 'native/kv-pager-wasm']) assert.ok(ENTRY.includes(crate), `${crate}'s target is linked`)
  assert.ok(ENTRY.includes('ln -s "/build/$d" "/work/$d/target"'))
  assert.ok(ENTRY.endsWith('exec sh tools/selfheal/checks.sh "$@"'))
  // Every crate the checks build is in the list, so none builds on the noexec tmpfs.
  const crates = readdirSync(join(REPO, 'native')).filter((n) => existsSync(join(REPO, 'native', n, 'Cargo.toml'))).map((n) => `native/${n}`)
  for (const c of crates) assert.ok(ENTRY.includes(c), `${c} is linked`)
})

test('the control takes the containment away and nothing else', () => {
  const args = controlArgs('/tmp/fake')
  const joined = args.join(' ')
  assert.ok(joined.includes('--user root') && joined.includes('--pid host') && joined.includes('/tmp/fake:/root/.ssh:ro') && joined.includes('GITHUB_TOKEN='))
  assert.ok(!joined.includes('--network none') && !joined.includes('--cap-drop') && !joined.includes('--read-only'))
  assert.equal(args[args.indexOf(IMAGE) + 2], '-c')
  assert.equal(args[args.indexOf(IMAGE) + 3], ENTRY, 'the same entry')
  assert.deepEqual(args.slice(-2), ['checks', 'sandbox-probe'])
})

test('the probe script is well formed and, on this unconfined host, is a live control: it finds escapes and exits 1', { skip: process.platform !== 'linux' ? 'the probes are Linux probes' : false }, () => {
  assert.equal(spawnSync('sh', ['-n', join(REPO, 'tools/sandbox/probe.sh')]).status, 0, 'sh -n')
  const r = spawnSync('sh', [join(REPO, 'tools/sandbox/probe.sh')], { cwd: REPO, encoding: 'utf8', timeout: 120000 })
  assert.equal(r.status, 1, `exits 1 on a host:\n${r.stdout}\n${r.stderr}`)
  const { probes, summary } = parseProbes(r.stdout)
  assert.ok(summary && summary.total >= 30 && summary.escaped > 0 && summary.denied + summary.escaped === summary.total, `summary ${JSON.stringify(summary)}`)
  assert.equal(probes.length, summary.total, 'one line per probe')
  for (const p of probes) {
    assert.equal(p.expect, 'denied')
    assert.ok(p.observed === 'denied' || p.observed === 'escaped', p.probe)
    assert.equal(typeof p.detail, 'string')
  }
  const names = new Set(probes.map((p) => p.probe))
  for (const m of MUST_FLIP) assert.ok(names.has(m), `${m} runs`)
})
