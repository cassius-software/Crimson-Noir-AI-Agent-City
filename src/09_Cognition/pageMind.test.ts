// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the one place the page's cognition router and its providers are built
 * (pageMind.ts createPageMind), and that the city and the console alone both build it there: the router it makes looks
 * in the auto order (the servers on this machine before the model the app carries), hands the app's runner its
 * answer cap from the device, holds the host's tier while that model answers and lets it go after, forwards the phase
 * and why the app's model cannot start, and asks the shell's GPU reading once; the console's device is the browser's
 * own (no adapter, no shader-f16); the onboarding's voice is the script under auto and asks nothing. App.tsx calls
 * createPageMind twice (the city's engine effect and the console's bridge) and builds no router, runner mind or in-page
 * mind of its own; it reaches pageMind.ts by a dynamic import only, so the page's static module graph (what the
 * console alone evaluates as it starts) holds none of the router's modules.
 * What breaks if it is removed? The city and the console could drift to different providers or orders, or the router's
 * modules could creep back into the console's start, with no test going red.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { browserDevice, createPageMind, onboardingVoice, type PageDevice } from './pageMind.ts'
import { holdTier, placement } from './inPagePlan.ts'
import type { GenRequest, NativeHost } from './nativeMind.ts'
import type { InPageRuntime } from './inPage.ts'
import type { ModelStore } from './modelStore.ts'
import type { FetchLike } from './localCompute.ts'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}
/** The code without its comments (a line comment starts at // not preceded by a colon, as in URLs; JSX comments too). */
const code = (text: string): string => text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const PHONE: PageDevice = { mobile: true, lite: false, gpuClass: 'mobile', cores: 8, memoryGb: 6, isolated: false, f16: false }
const store: ModelStore = {
  keep: async () => { throw new Error('nothing kept') }, list: async () => [], open: async () => { throw new Error('nothing opened') },
  forget: async () => 0, usage: async () => null, storageLine: () => 'kept in this page',
}
const runtime: InPageRuntime = {
  caps: () => ({ jspi: true, mem64shared: true, simd: true, exceptions: true, isolated: true, opfs: true, webgpu: false, opaque: false }),
  load: async () => { throw new Error('no load') }, chat: async () => { throw new Error('no chat') }, unload: async () => {}, loaded: () => false, idle: async () => {}, log: () => [],
}
const memoryStore = () => {
  let json: string | null = null
  return { load: () => json, save: (v: string) => { json = v } }
}

function runner(status: unknown = { state: 'ready' }) {
  const sent: GenRequest[] = []
  const order: string[] = []
  const host: NativeHost = {
    model: async () => { order.push('runner'); return { file: 'm.gguf', bytes: 1, status } },
    generate: async (req, send) => {
      sent.push(req)
      send({ kind: 'text', text: 'native says hi' })
      return { id: req.id, reason: 'eog', tokens: 3, promptTokens: 9, reused: 0, prefillMs: 1, genMs: 1, threads: 1, nCtx: 4096, nBatch: 256, gpu: false }
    },
    stop: async () => true,
  }
  return { host, sent, order }
}

test('createPageMind: the auto order looks at the servers on this machine before the app\'s own model, which answers capped by the device and holds the tier meanwhile', async () => {
  const app = runner()
  const holds: (number | null)[] = []
  const phases: (string | null)[] = []
  let gpuAsks = 0
  const fetched: string[] = []
  const fetchFn: FetchLike = async (url) => {
    fetched.push(url)
    app.order.push('server')
    throw new TypeError('fetch failed')
  }
  const m = createPageMind({
    fetch: fetchFn, store: memoryStore(), runtime: () => runtime, models: () => store, device: () => PHONE,
    runner: app.host, gpuMemory: async () => { gpuAsks++; return null }, vram: null,
    hold: (t) => holds.push(t), onPhase: (p) => phases.push(p),
  })
  assert.equal(gpuAsks, 1, 'the shell\'s GPU reading is asked once, as the router is built')
  const text: string[] = []
  const answer = await m.router.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal, talk: true }, (p) => { if (p.kind === 'text') text.push(p.text) })
  assert.equal(answer.text, 'native says hi')
  assert.equal(text.join(''), 'native says hi')
  assert.ok(app.order.indexOf('server') >= 0 && app.order.indexOf('server') < app.order.lastIndexOf('runner'), `servers first (${app.order.join(', ')})`)
  for (const u of fetched) assert.match(u, /^http:\/\/(127\.0\.0\.1|localhost):\d+\//)
  assert.equal(m.router.settings().found, 'native')
  assert.equal(app.sent[0].maxTokens, placement({ ...PHONE, gpuMode: 'auto', gpuFailed: false }).maxTokens, 'capped as the model in this page would be on this device')
  assert.deepEqual(holds, [holdTier(PHONE, false), null], 'held while it answered, let go after')
  assert.equal(m.native.settings().server, 'this app', 'the mind handed back is the router\'s own')
  assert.equal(m.inPage.settings().model, null)
  void phases
})

test('createPageMind: why the app\'s model cannot start reaches the host; with no runner and no host hooks nothing is held or told', async () => {
  const told: (string | null)[] = []
  const failing = runner({ state: 'failed', reason: 'the model file would not load', refused: false })
  const m = createPageMind({
    fetch: async () => { throw new TypeError('fetch failed') }, store: memoryStore(), runtime: () => runtime, models: () => store, device: () => PHONE,
    runner: failing.host, gpuMemory: async () => null, vram: null, onAppFailed: (why) => told.push(why),
  })
  await m.router.installed().catch(() => [])
  assert.ok(told.some((w) => typeof w === 'string' && /would not load/.test(w)), JSON.stringify(told))
  // The console's call: no hold, no phase, no card, no runner (a browser).
  const bare = createPageMind({ fetch: async () => { throw new TypeError('fetch failed') }, store: memoryStore(), runtime: () => runtime, models: () => store, device: browserDevice, runner: null, gpuMemory: async () => null, vram: null })
  await assert.rejects(bare.router.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal, talk: true }, () => {}), /no model is answering on this machine/)
})

test('browserDevice: the browser\'s own hints, no adapter and no shader-f16, so the console never asks for a GPU', () => {
  const d = browserDevice()
  assert.equal(d.gpuClass, 'unknown')
  assert.equal(d.f16, false)
  assert.equal(typeof d.cores, 'number')
  assert.equal(d.isolated, false, 'Node is not a cross-origin isolated page')
  assert.equal(placement({ ...d, gpuMode: 'auto', gpuFailed: false }).gpu, false, 'the model kept in this page runs on the processor there')
})

test('onboardingVoice: under auto the script is the voice and nothing is asked', async () => {
  let asked = 0
  const v = onboardingVoice(async () => { asked++; throw new TypeError('fetch failed') }, memoryStore())
  assert.equal(await v.say('Pick morning, sunset or night.', new AbortController().signal), 'Pick morning, sunset or night.')
  assert.equal(asked, 0)
})

test('App: the city and the console alone both build the router with createPageMind, and App builds none of its own', () => {
  const app = read('App.tsx')
  const appCode = code(app)
  assert.equal(appCode.match(/\bcreatePageMind\(/g)?.length, 2)
  for (const own of ['createMindRouter', 'createNativeMind', 'createInPageMind', 'figureFromAdapters', 'holdTier']) {
    assert.doesNotMatch(appCode, new RegExp(`\\b${own}\\b`), `${own} is pageMind's`)
  }
  const city = between(app, "    loadMap(plan).then((region) => Engine.create(", '    return () => {\n      cancelled = true')
  assert.match(city, /const \{ router: local, inPage, native: appMind \} = minds\.createPageMind\(\{/, 'the city\'s call, once its engine is up')
  assert.match(app, /const minded = PAGE_MIND\(\)\n\s+minded\.catch\(noop\)\n\s+loadMap\(plan\)\.then\(\(region\) => Engine\.create\(canvas, \{ \.\.\.options, region \}, onStage\)\)\.then\(\(e\) => minded\.then\(\(m\) => \(\{ e, minds: m \}\), \(err: unknown\) => \{\n\s+e\.dispose\(\)\n\s+throw err\n\s+\}\)\)\.then\(/, 'loaded beside the engine; an engine whose router could not load is let go')
  const tty = between(app, 'function ttyBridge(vram: string | null): TerminalBridge {', '\n}\n')
  assert.match(tty, /mind: \(\) => PAGE_MIND\(\)\.then\(\(m\) => m\.createPageMind\(\{\n\s+fetch: pageFetch,\n\s+store: pageStore\(COGNITION_KEY\),\n\s+runtime: PAGE_RUNTIME,\n\s+models: PAGE_MODELS,\n\s+device: m\.browserDevice,\n\s+runner: shellRunner\(\),\n\s+gpuMemory: shellGpuMemory,\n\s+vram,\n\s+\}\)\)\.then\(\(\{ router, inPage, native \}\) => \{\n(?:\s*\/\/[^\n]*\n)*\s+const brain = createBrainReadout\(\{ router, native, page: inPage \}\)\n\s+bindBrain\(brain\)\n\s+const file = \{\n\s+load: \(\) => inPage\.load\(\),\n\s+unload: \(\) => inPage\.unload\(\),\n\s+forget: \(name\?: string\) => inPage\.forget\(name\)\.finally\(\(\) => brain\.refresh\(\)\),\n\s+log: \(\) => inPage\.log\(\),\n\s+\}\n\s+return \{ router, inPage: file \}\n\s+\}\),/, 'the console\'s call: the same fetch, store, runtime, models, runner and reading; the router and its in-page mind (ask file load|unload|forget|log, a forget told to the readout), and the brain readout over the router, the app\'s model and the in-page mind (ask\'s brain row)')
  // The same fetch, store, runtime, models and reading in the city's call.
  assert.match(city, /fetch: pageFetch,\n\s+store: pageStore\(COGNITION_KEY\),\n\s+runtime: PAGE_RUNTIME,\n\s+models: PAGE_MODELS,\n\s+device,\n/)
  assert.match(city, /runner: shellRunner\(\),/)
  assert.match(city, /gpuMemory: shellGpuMemory,/)
})

/** Every module `entry` imports for its values, statically and transitively (an `import type` is not loaded at run time). */
function staticGraph(entry: string): { modules: Set<string>; dynamic: Map<string, string> } {
  const modules = new Set<string>()
  const dynamic = new Map<string, string>()
  const resolveFrom = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const p = resolve(dirname(from), spec.replace(/\?.*$/, ''))
    for (const c of [p, `${p}.ts`, `${p}.tsx`]) if (existsSync(c) && /\.(ts|tsx|js|mjs)$/.test(c)) return c
    return null
  }
  const walk = (file: string): void => {
    if (modules.has(file)) return
    modules.add(file)
    const text = code(readFileSync(file, 'utf8'))
    for (const m of text.matchAll(/^\s*(?:import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) {
      if (m[1]) continue
      const r = resolveFrom(file, m[2])
      if (r) walk(r)
    }
    for (const m of text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
      const r = resolveFrom(file, m[1])
      if (r) dynamic.set(relative(SRC, r), relative(SRC, file))
    }
  }
  walk(join(SRC, entry))
  return { modules: new Set([...modules].map((f) => relative(SRC, f))), dynamic }
}

test('the console alone starts without the router: none of its modules is in the page\'s static graph, and pageMind.ts is reached only by App\'s dynamic import', () => {
  const g = staticGraph('main.tsx')
  assert.ok(g.modules.has('App.tsx') && g.modules.has('07_Execute_Actions/terminal/consoleBridge.ts'), 'the console\'s bridge itself is light and static')
  for (const lazy of ['09_Cognition/pageMind.ts', '09_Cognition/router.ts', '09_Cognition/nativeMind.ts', '09_Cognition/inPage.ts', '09_Cognition/claudeApi.ts', '09_Cognition/prefixCache.ts', '09_Cognition/modelFit.ts', '09_Cognition/kvPager.wasm.ts']) {
    assert.ok(!g.modules.has(lazy), `${lazy} waits for the first ask`)
  }
  assert.deepEqual([...g.dynamic.entries()], [['09_Cognition/pageMind.ts', 'App.tsx']], 'one dynamic import in the page, App\'s of pageMind.ts')
  const app = read('App.tsx')
  assert.match(app, /^const PAGE_MIND = \(\): Promise<PageMindModule> => \(pageMindLoad \?\?= import\('\.\/09_Cognition\/pageMind\.ts'\)\.catch\(\(e: unknown\) => \{\n\s+pageMindLoad = null\n\s+throw e\n\}\)\)$/m, 'loaded once, and tried again after a failed load')
  // Neither the console's bridge nor the commands name the router's modules: the router reaches them as a Mind.
  for (const f of ['07_Execute_Actions/terminal/consoleBridge.ts', '07_Execute_Actions/terminal/commands.ts']) assert.doesNotMatch(code(read(f)), /09_Cognition\/(router|pageMind|nativeMind|inPage)\.ts/, f)
  // The console shell builds no pageMind until its bridge's first ask: no call of PAGE_MIND outside the bridge's loader.
  const tty = between(app, 'function TtyShell({ vram }: { vram: string | null }) {', '\n}\n')
  assert.doesNotMatch(tty, /PAGE_MIND|createPageMind/)
  // Nor does the onboarding's voice, which App makes even for the console: it loads the module at its first line.
  assert.match(between(app, 'function onboardingVoice(): Voice {', '\n}\n'), /say: \(line, signal\) => \(voice \?\?= PAGE_MIND\(\)/)
})
