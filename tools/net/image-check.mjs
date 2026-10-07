#!/usr/bin/env node
/**
 * Why does this file exist? It is the host image's proof that it runs, executed by the Dockerfile inside the image as
 * built (its Node, its /app, its user), before the image can be tagged:
 * - the host starts from /app alone, so tools/net/closure.mjs missed no file it needs;
 * - its ledger door opens on the digest crimson_noir_os/containment.lock pins, and keeps for the fleet only the run
 *   crimson_noir_os/containment.seal pins;
 * - a token minted with tools/net/mint-token.mjs from the same secret has the host's shape.
 * It writes /tmp/image-checked (the start-up lines), which the image's last stage copies, so no build reaches the final
 * image without passing through here. Nothing listens beyond the build's own loopback, and the host is stopped after.
 * What breaks if it is removed? An image a file short would build, and fail only where it is deployed.
 */
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'

const SECRET = 'image-check-secret-0123456789abcdef'
const env = { ...process.env, NET_PORT: '0', NET_SECRET: SECRET, NET_PRINT_TOKEN: '0' }
delete env.NET_SECRET_FILE
const pinned = /[0-9a-f]{64}/.exec(readFileSync('crimson_noir_os/containment.lock', 'utf8'))?.[0]
if (!pinned) throw new Error('crimson_noir_os/containment.lock pins no digest')

const host = spawn(process.execPath, ['src/10_Network/replication.node.ts'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let out = ''
let done = false
const finish = (why) => {
  if (done) return
  done = true
  host.kill('SIGINT')
  if (why) {
    console.error(`image check: ${why}\n${out}`)
    process.exit(1)
  }
  const minted = spawnSync(process.execPath, ['tools/net/mint-token.mjs', 'image-check', '1'], { env, encoding: 'utf8' })
  if (minted.status !== 0 || !/^[\w-]+\.\d+\.[\w-]{43}\n$/.test(minted.stdout)) {
    console.error(`image check: mint-token failed (${minted.status}): ${minted.stderr}`)
    process.exit(1)
  }
  writeFileSync('/tmp/image-checked', `${out}node ${process.version}; a token minted\n`)
  console.log(`image check: the host starts from /app alone (node ${process.version}), its ledger door is pinned, tokens mint`)
  process.exit(0)
}
const timer = setTimeout(() => finish('the host did not start within 90 s'), 90_000)
host.stdout.on('data', (b) => {
  out += b
  if (/listening on ws:\/\/127\.0\.0\.1:\d+/.test(out) && out.includes('no token printed') && out.includes('ledger door (crimson.1)') && out.includes('the ledger door keeps')) {
    clearTimeout(timer)
    if (!out.includes(`checks ledgers against ${pinned.slice(0, 16)}`)) finish('the ledger door is not pinned to containment.lock')
    else if (!out.includes('keeps for the fleet only the run sealed in')) finish('the ledger door pins no run (containment.seal)')
    else finish(null)
  }
})
host.stderr.on('data', (b) => { out += b })
host.once('close', (code) => finish(`the host exited (${code}) before it was ready`))
