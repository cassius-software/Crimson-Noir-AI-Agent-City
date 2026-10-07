/**
 * Why does this file exist? The host's container image carries only the files tools/net/closure.mjs lists, so that list
 * must be exactly what Node loads. This test starts the real host with a resolve hook (node:module registerHooks) that
 * records every module Node actually loads, then holds closure.mjs's list equal to that record. The image's own build
 * check (tools/net/image-check.mjs) catches a missing file too, but only at docker build time; this catches it in
 * `npm test`.
 * What breaks if it is removed? A new import the closure misses would surface only when the image is built.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const HOOK = `import { registerHooks } from 'node:module'
import { appendFileSync } from 'node:fs'
registerHooks({ resolve(specifier, context, next) { const r = next(specifier, context); appendFileSync(process.env.TRACE_OUT, r.url + '\\n'); return r } })
`

test('the image carries exactly the modules the host loads', { timeout: 120_000 }, async () => {
  const listed = spawnSync(process.execPath, ['--no-warnings', 'tools/net/closure.mjs', 'src/10_Network/replication.node.ts'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(listed.status, 0, listed.stderr)
  const modules = listed.stdout.split('\n').filter((f) => f !== '' && !/(^|\/)(package\.json|LICEN[CS]E.*|NOTICE.*)$/i.test(f)).sort()

  const dir = mkdtempSync(join(tmpdir(), 'closure-'))
  const hook = join(dir, 'hook.mjs')
  const trace = join(dir, 'loaded.txt')
  writeFileSync(hook, HOOK)
  writeFileSync(trace, '')
  const env: NodeJS.ProcessEnv = { ...process.env, TRACE_OUT: trace, NET_PORT: '0', NET_SECRET: 'closure-test-secret-0123456789', NET_PRINT_TOKEN: '0' }
  delete env.NET_SECRET_FILE
  const host = spawn(process.execPath, ['--import', hook, 'src/10_Network/replication.node.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the host did not start:\n${out}`)), 60_000)
    host.stdout.on('data', (b: Buffer) => {
      out += b.toString()
      if (/listening on ws:\/\//.test(out)) { clearTimeout(timer); resolve() }
    })
    host.stderr.on('data', (b: Buffer) => { out += b.toString() })
    host.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the host exited (${code}):\n${out}`)) })
  })
  host.removeAllListeners('exit')
  const stopped = new Promise((resolve) => host.once('exit', resolve))
  host.kill('SIGINT')
  await stopped

  const loaded = [...new Set(readFileSync(trace, 'utf8').split('\n').filter((u) => u.startsWith('file:')))]
    .map((u) => relative(ROOT, fileURLToPath(u)).split('\\').join('/'))
    .sort()
  assert.ok(loaded.length > 10, `the trace recorded ${loaded.length} modules`)
  assert.deepEqual(modules, loaded)
})
