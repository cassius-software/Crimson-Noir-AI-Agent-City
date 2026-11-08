// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It photographs the built page (dist/index.html) in a headless Chrome on the software WebGPU
 * adapter, the way the browser smoke (smoke.mjs) does, and nothing else: one boot, then any number of screenshots at
 * chosen clock hours, head angles and places, so a rendering change (the street lamps at night, a shadow's edge, an
 * anti-aliased pole) has a before and an after picture from the same spot without a GPU. The page is served from
 * 127.0.0.1 with the isolation headers the dev server sends; the browser can reach nothing else.
 *
 *   node tools/browser/shot.mjs --out shots --query "map=lakefront&quality=3" \
 *     --at "lakefront-night,22,0,0" --at "lakefront-dusk,18.5,1.57,-0.1"
 *
 * `--query` is appended to the page's URL (after ?debug&onboarding=0&audio=0, which every shot needs: the engine's
 * debug handle, no onboarding card, no sound). Each `--at` is "name,hour[,yaw,pitch[,x,z]]": the clock is set to `hour`,
 * the head turned to `yaw`/`pitch` (radians; yaw 0 looks along −z), the avatar put at (x, z) when given, and after
 * `--frames` animation frames (8 by default: the shadow map, the environment probe and the lamp lights settle) the
 * picture goes to <out>/<name>.png. `--width`/`--height` size the window (960×540 by default). Before the first picture
 * the concierge's name card is skipped (its Skip button) and the HUD hidden (the H key), so the frame is the city;
 * `--hud` keeps the HUD. The exit code is 1 when
 * the page threw, logged a WebGPU error or a shader three could not build (`[error] THREE.TSL:`), as smoke.mjs counts
 * them, so a picture never hides a broken frame.
 * What breaks if it is removed? Nothing at runtime; a rendering change loses its cheapest evidence.
 */
import { createServer } from 'node:http'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser, findChrome, loopbackOnly, SOFTWARE_WEBGPU } from './cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const DIST = join(ROOT, 'dist', 'index.html')

const args = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : fallback
}
const every = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []))

const OUT = arg('out', 'shots')
const QUERY = arg('query', '')
const WIDTH = Number(arg('width', 960)), HEIGHT = Number(arg('height', 540))
const FRAMES = Number(arg('frames', 8))
const BOOT_MS = Number(arg('boot-ms', 240_000))
const HUD = args.includes('--hud')
const AT = every('at').map((s) => {
  const [name, hour, yaw, pitch, x, z] = s.split(',').map((v, i) => (i === 0 ? v.trim() : Number(v)))
  return { name, hour, yaw: Number.isFinite(yaw) ? yaw : null, pitch: Number.isFinite(pitch) ? pitch : 0, x: Number.isFinite(x) ? x : null, z: Number.isFinite(z) ? z : null }
})
if (AT.length === 0) {
  console.error('shot.mjs: nothing to photograph; give at least one --at "name,hour[,yaw,pitch[,x,z]]"')
  process.exit(2)
}

const FRAME_COUNTER = `(() => { window.__shotFrames = 0; const tick = () => { window.__shotFrames++; requestAnimationFrame(tick) }; requestAnimationFrame(tick) })()`

/** dist/index.html on 127.0.0.1 with the dev server's isolation headers (SharedArrayBuffer needs them). */
async function serve() {
  const html = readFileSync(DIST)
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname
    if (path !== '/' && path !== '/index.html') { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cache-Control': 'no-store' })
    res.end(html)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { server, origin: `http://127.0.0.1:${server.address().port}` }
}

const chrome = findChrome()
if (!chrome) {
  console.error('shot.mjs: no Chrome or Chromium found (set CHROME=/path/to/chrome)')
  process.exit(2)
}
mkdirSync(OUT, { recursive: true })
const { server, origin } = await serve()
const net = loopbackOnly([...SOFTWARE_WEBGPU, `--window-size=${WIDTH},${HEIGHT}`])
const b = await Browser.launch(chrome, net.args, { env: net.env })
const errors = [], logs = []
b.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text))
b.on('Runtime.consoleAPICalled', (p) => logs.push(`[${p.type}] ${(p.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`))
let failed = false
try {
  await b.send('Page.addScriptToEvaluateOnNewDocument', { source: FRAME_COUNTER })
  await b.send('Emulation.setDeviceMetricsOverride', { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false })
  const url = `${origin}/?debug&onboarding=0&audio=0${QUERY ? `&${QUERY}` : ''}`
  console.log(`shot: ${url}`)
  const t0 = Date.now()
  await b.send('Page.navigate', { url })
  await b.waitFor('!!window.__SIM__ && window.__SIM__.snapshot().output.fps > 0', BOOT_MS)
  // The veil gone, not just fading: Sloane's card opens when the fade ends, so a Skip looked for sooner can miss it.
  await b.waitFor(`!document.querySelector('.boot-veil')`, 30_000)
  console.log(`shot: booted in ${((Date.now() - t0) / 1000).toFixed(0)} s (${await b.eval('window.__SIM__.snapshot().process.gpu')})`)
  // The concierge asks a first visitor's name over the frame: skipped, as a visitor who wants the city would. The HUD
  // (the clock, the counts, the minimap) goes with the H key, as it does for a player.
  const skipped = await b.eval(`(() => { const s = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Skip'); if (s) s.click(); return !!s })()`)
  if (!HUD) await b.eval(`document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyH', key: 'h', bubbles: true }))`)
  console.log(`shot: concierge ${skipped ? 'skipped' : 'not shown'}, HUD ${HUD ? 'kept' : 'hidden'}`)
  for (const at of AT) {
    await b.eval(`window.__SIM__.setHour(${at.hour})`)
    if (at.x !== null && at.z !== null) await b.eval(`window.__SIM__.teleport(${at.x}, ${at.z}, ${at.yaw ?? 0})`)
    if (at.yaw !== null) await b.eval(`window.__SIM__.look(${at.yaw}, ${at.pitch})`)
    const start = await b.eval('window.__shotFrames')
    await b.waitFor(`window.__shotFrames >= ${start + FRAMES}`, 120_000)
    const s = await b.eval(`(() => { const s = window.__SIM__.snapshot(), e = window.__SIM__.engine
      return { clock: s.customer.clock, tier: s.quality.label ?? s.quality.tier, fps: s.output.fps, aa: (e.quality.live.post ? e.sceneSamples : e.gpu.renderer.samples) || 1 } })()`)
    writeFileSync(join(OUT, `${at.name}.png`), await b.screenshot())
    console.log(`shot: ${at.name}.png at ${s.clock}, tier ${s.tier}, aa ${s.aa}x, ${Number(s.fps).toFixed(1)} fps`)
  }
} catch (e) {
  failed = true
  console.error(`shot: FAILED ${e instanceof Error ? e.message : String(e)}`)
} finally {
  const gpu = logs.filter((l) => /WebGPU|GPUValidationError|uncaptured|Device Lost|device lost/i.test(l) && !/experimental on this platform/.test(l) && !/no GPU adapter/.test(l))
  const tsl = logs.filter((l) => /^\[error\] THREE\.TSL:/.test(l))
  for (const line of [...errors, ...gpu, ...tsl].slice(0, 10)) console.log(`shot: page said: ${line.slice(0, 300)}`)
  if (errors.length || gpu.length || tsl.length) failed = true
  const envprobe = logs.filter((l) => /\[envprobe\]/.test(l)).length
  console.log(`shot: ${errors.length} exception(s), ${gpu.length} GPU error line(s), ${tsl.length} TSL error line(s), ${envprobe} probe bake(s)`)
  await b.close()
  server.closeAllConnections()
  server.close()
}
process.exit(failed ? 1 : 0)
