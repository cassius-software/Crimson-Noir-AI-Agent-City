// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It compiles every crowd kernel's compute passes under a real browser's WebGPU (a headless
 * Chrome or Chromium on the software adapter, cdp.mjs SOFTWARE_WEBGPU: Dawn's validation, Tint and SwiftShader's
 * compiler), the way the physics worker and the page do at boot (src/01_Initialize_World/gpuPipelines.ts compilePasses),
 * and fails when any pass is refused or the module has a compilation message. The browser smoke (smoke.mjs) boots the
 * city and so compiles the full kernel alone; the rungs below it (src/03_Spawn_Agents/crowdCompute.ts CROWD_KERNELS:
 * the same module at narrow workgroups, the light kernel of crowdWayLite.wgsl) are compiled only on a GPU whose own
 * compiler refused the full one, a phone's, which no CI runner has. This is the evidence that they still compile.
 *
 *   node tools/browser/kernels.mjs [--chrome /path/to/chrome] [--agents 8000]
 *
 * The kernels are assembled from the TypeScript source as the tests do (Node strips the types; the `?raw` import is
 * a hook), over the procedural city's geometry at `--agents` pedestrians (the phone default). The exit code is 1 when a
 * pass is refused (the browser's words and the pass are printed, with the reason: WebGPU's validation or the GPU's own
 * compiler), when a module has a compilation message, or when the device reports an uncaptured error meanwhile.
 * What breaks if it is removed? A change to crowd.wgsl or a way file that only the fallback kernels compile wrong is
 * found on a phone, by its recovery card, instead of here.
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { fileURLToPath } from 'node:url'
import { Browser, findChrome, loopbackOnly, SOFTWARE_WEBGPU } from './cdp.mjs'

// Vite's `?raw` import, for Node: the file as a default-exported string (as crowdCompute.test.ts does).
registerHooks({
  load(url, context, nextLoad) {
    if (!url.endsWith('.wgsl?raw')) return nextLoad(url, context)
    const text = readFileSync(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8')
    return { format: 'module', source: `export default ${JSON.stringify(text)}`, shortCircuit: true }
  },
})

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }

const { CROWD_KERNELS, CULL_PASSES, SIM_PASSES, crowdShader } = await import('../../src/03_Spawn_Agents/crowdCompute.ts')
const agents = Number(arg('agents') ?? 8000)
const modules = Object.fromEntries(CROWD_KERNELS.map((k) => [k, crowdShader(agents, undefined, undefined, k)]))
const passes = [...SIM_PASSES, ...CULL_PASSES]

// The page in the browser: compile every module's passes on one device and report each verdict in the browser's words.
const IN_PAGE = `(async ({ modules, passes }) => {
  const adapter = await navigator.gpu?.requestAdapter()
  if (!adapter) return { error: 'no WebGPU adapter in this browser' }
  const device = await adapter.requestDevice()
  const info = adapter.info ? [adapter.info.vendor, adapter.info.architecture, adapter.info.description].filter(Boolean).join(' / ') : 'adapter unknown'
  const uncaptured = []
  device.addEventListener('uncapturederror', (e) => uncaptured.push(e.error.message))
  const kernels = {}
  for (const [kernel, code] of Object.entries(modules)) {
    const module = device.createShaderModule({ label: kernel, code })
    const messages = (await module.getCompilationInfo()).messages.map((m) => m.type + ' at ' + m.lineNum + ':' + m.linePos + ': ' + m.message)
    const verdicts = {}
    for (const entryPoint of passes) {
      const t0 = performance.now()
      try {
        await device.createComputePipelineAsync({ label: kernel + '.' + entryPoint, layout: 'auto', compute: { module, entryPoint } })
        verdicts[entryPoint] = { ok: true, ms: Math.round(performance.now() - t0) }
      } catch (e) {
        verdicts[entryPoint] = { ok: false, reason: e.reason ?? 'unknown', message: e.message }
      }
    }
    kernels[kernel] = { messages, verdicts }
  }
  await device.queue.onSubmittedWorkDone()
  return { info, kernels, uncaptured }
})`

async function main() {
  const chrome = findChrome(arg('chrome'))
  if (!chrome) {
    console.error('kernels.mjs: no Chrome or Chromium found (set CHROME=/path/to/chrome)')
    return 1
  }
  // A page of its own on 127.0.0.1 (about:blank gets no adapter); the browser can reach nothing else.
  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end('<!doctype html><title>kernels</title><p>crowd kernels') })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const net = loopbackOnly([...SOFTWARE_WEBGPU])
  const b = await Browser.launch(chrome, net.args, { env: net.env })
  let failures = 0
  try {
    await b.send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` })
    await b.waitFor('document.readyState === "complete" && document.title === "kernels"', 15_000)
    const result = await b.eval(`${IN_PAGE}(${JSON.stringify({ modules, passes })})`)
    if (result.error) {
      console.error(`kernels.mjs: ${result.error}`)
      return 1
    }
    console.log(`kernels.mjs: ${result.info}; ${agents} pedestrians`)
    for (const [kernel, { messages, verdicts }] of Object.entries(result.kernels)) {
      const line = passes.map((p) => (verdicts[p].ok ? `${p} ok ${verdicts[p].ms} ms` : `${p} REFUSED`)).join(', ')
      console.log(`  ${kernel} (${modules[kernel].length} chars): ${line}`)
      for (const m of messages) { console.log(`    compilation message: ${m}`); failures++ }
      for (const p of passes) if (!verdicts[p].ok) { console.log(`    ${p}: refused (${verdicts[p].reason}): ${verdicts[p].message}`); failures++ }
    }
    for (const m of result.uncaptured) { console.log(`  uncaptured GPU error: ${m}`); failures++ }
  } finally {
    await b.close()
    server.close()
  }
  console.log(failures ? `kernels.mjs: ${failures} failure${failures === 1 ? '' : 's'}` : `kernels.mjs: every pass of every kernel compiled`)
  return failures ? 1 : 0
}

process.exitCode = await main()
