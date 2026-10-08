#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the end-to-end check of the Crimson Noir OS bridge (`npm run smoke:bridge`): the
 * real host as a process of its own (`node src/10_Network/replication.node.ts`, a secret made for this run, its ledger
 * door pinned to crimson_noir_os/containment.lock) and the real hosted runtime (`crimson_noir_os bridge`) over a
 * loopback WebSocket. The runtime records the self-test's run, the host verifies the ledger under the containment
 * rules, and a fresh runtime adopts the verified weights bit for bit. Then what must be refused is: the runtime without
 * a token, with a forged one, or aimed off this machine; and, over the wire, a sentry that learns, a swapped reward
 * sealed as the honest weights, an entry edited in place, and a reward no clock gives (the runtime's ignored live test,
 * which also proves the host still shares only the honest weights). One row per check; exit 1 if any fails.
 * Nothing leaves this machine: the host listens on 127.0.0.1, and the runtime refuses any address that is not it.
 * What breaks if it is removed? Nothing at runtime; the bridge loses its one check against both sides as they ship.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const OS = join(ROOT, 'crimson_noir_os')
const BIN = join(OS, 'target', 'debug', process.platform === 'win32' ? 'crimson_noir_os.exe' : 'crimson_noir_os')

let failed = 0
const check = (ok, what) => {
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`)
}

/** The host's environment for this run: its own secret and printed token, whatever the operator's shell carries. */
const hostEnv = (own) => {
  const env = { ...process.env, ...own }
  delete env.NET_SECRET_FILE
  delete env.NET_PRINT_TOKEN
  return env
}
const built = spawnSync('cargo', ['build', '--quiet'], { cwd: OS, stdio: ['ignore', 'inherit', 'inherit'] })
if (built.status !== 0) throw new Error('cargo build failed')

const server = spawn(process.execPath, [join(ROOT, 'src/10_Network/replication.node.ts')], {
  cwd: ROOT, env: hostEnv({ NET_SECRET: randomBytes(32).toString('hex'), NET_PORT: '0', NET_TICK_HZ: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
const started = await new Promise((resolve, reject) => {
  const fail = (e) => { server.kill('SIGKILL'); reject(e) }
  const timer = setTimeout(() => fail(new Error(`the host did not start:\n${log}`)), 30_000)
  server.stdout.on('data', (b) => {
    log += b
    const url = /listening on (ws:\/\/[\d.]+:\d+)/.exec(log)?.[1]
    const token = /a token for 'operator', good for [\d.]+ h: (\S+)/.exec(log)?.[1]
    if (url && token) { clearTimeout(timer); resolve({ url, token }) }
  })
  server.stderr.on('data', (b) => { log += b })
  server.once('exit', (code) => reject(new Error(`the host exited (${code}):\n${log}`)))
})
check(/the ledger door \(crimson\.1\) checks ledgers against 96c3d1d3a733cf6d/.test(log), `host ${started.url}: the ledger door is pinned to containment.lock`)

/** The runtime's bridge command, its environment given and nothing else of ours. */
const bridge = (url, token) => {
  const env = { ...process.env }
  delete env.CRIMSON_TOKEN
  if (token !== undefined) env.CRIMSON_TOKEN = token
  const r = spawnSync(BIN, ['bridge', url], { cwd: OS, env, encoding: 'utf8', timeout: 120_000 })
  return { code: r.status, out: `${r.stdout}${r.stderr}` }
}

const good = bridge(started.url, started.token)
console.log(good.out.trimEnd().replace(/^/gm, '      '))
check(good.code === 0 && /verified by the host: .*and the host keeps it for the fleet/.test(good.out), 'the recorded ledger is verified by the host and kept for the fleet (the pinned run)')
check(good.code === 0 && /fleet sync: a fresh runtime adopted \d+ weights, bit-exact/.test(good.out), 'a fresh runtime adopts the verified weights, bit-exact')

// A forgery changes the signature's first character: every bit of it counts (the last one's low bits do not).
const mac = started.token.split('.')[2]
const forged = started.token.slice(0, -mac.length) + (mac[0] === 'A' ? 'B' : 'A') + mac.slice(1)
const refusals = [
  ['no token', bridge(started.url, undefined), /CRIMSON_TOKEN/],
  ['a forged token', bridge(started.url, forged), /refused the upgrade: 401/],
  ['an address off this machine', bridge('ws://192.0.2.7:8787', started.token), /not this machine/],
  ['a name to look up', bridge('ws://example.invalid:8787', started.token), /looks up no names/],
]
for (const [what, r, why] of refusals) check(r.code !== 0 && why.test(r.out), `the runtime refuses ${what}: ${r.out.trim().split('\n').pop()}`)

const live = spawnSync('cargo', ['test', '--quiet', '--bin', 'crimson_noir_os', '--', '--ignored', 'a_tampered_ledger', '--nocapture'], {
  cwd: OS, env: { ...process.env, CRIMSON_URL: started.url, CRIMSON_TOKEN: started.token }, encoding: 'utf8', timeout: 300_000,
})
for (const line of `${live.stdout}`.split('\n').filter((l) => /refused, as it must be|still shares/.test(l))) console.log(`      ${line}`)
check(live.status === 0 && (live.stdout.match(/refused, as it must be/g) ?? []).length === 4, 'four tampered ledgers are refused over the wire')
check(live.status === 0 && /the host still shares the honest run's weights/.test(live.stdout), 'nothing tampered became what the host shares')

server.kill('SIGINT')
console.log(failed === 0 ? 'bridge smoke: every check held' : `bridge smoke: ${failed} check(s) failed`)
process.exit(failed === 0 ? 0 : 1)
