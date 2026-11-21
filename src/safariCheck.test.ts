// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? tools/browser/safari.mjs opens the web copy in a real Safari on GitHub's Macs and in the
 * iOS Simulator (iphone.yml), the only check that runs the page in WebKit at all. Its browser work needs a Mac; the
 * parts that decide what is served, which iPhone is driven, and whether a run counts as the city running or as the
 * right card are plain functions, and this pins them without a browser: the static host never leaves its folder, the
 * newest iPhone is the one picked, a start only counts as running once frames are drawn and the crowd advances, and the
 * verdict follows what the browser was given (a GPU: the city must run; no GPU: the card for exactly that, in words
 * that send an iPhone to no other browser). It pins iphone.yml too: the runners, GitHub's own actions only, and no
 * run that only observes.
 * What breaks if it is removed? The Safari check could pass on a card that sends an iPhone to Chrome, or on a runner
 * that never drew the city, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { test } from 'node:test'

// tools/ is plain JavaScript with no types; a computed specifier keeps the page's typecheck off it.
const SAFARI: string = '../tools/browser/safari.mjs'
interface Verdict { ok: boolean; what: string; detail: string }
const safari = (await import(SAFARI)) as {
  VISITOR: string
  fileFor(root: string, pathname: string): string | null
  serve(root: string): Promise<{ server: { close(): void; closeAllConnections?: () => void }; origin: string }>
  isRunning(state: unknown, crowdFrom?: number): boolean
  pickIphone(listing: unknown, named?: string): { name: string; udid: string; ios: string } | null
  expected(target: string, probe: unknown): { outcome: 'running' | 'card'; kind: string | null; why: string }
  judge(target: string, probe: unknown, page: unknown): Verdict[]
  PROBE: string
  STATE: string
  RECORDER: string
  TRACE: string
  LADDER: string
  withRecorder(html: string, trace?: boolean): string
}

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const TOOL = read('../tools/browser/safari.mjs')
const FLOW = read('../.github/workflows/iphone.yml')

test('fileFor: a request never leaves the folder it serves; a folder is its index.html', () => {
  const root = resolve('/srv/site')
  assert.equal(safari.fileFor(root, '/'), join(root, 'index.html'))
  assert.equal(safari.fileFor(root, '/sw.js'), join(root, 'sw.js'))
  assert.equal(safari.fileFor(root, '/models/'), join(root, 'models', 'index.html'))
  assert.equal(safari.fileFor(root, '/a%20b.png'), join(root, 'a b.png'))
  for (const path of ['/../secret', '/..%2f..%2fetc/passwd', '/a/../../b', '/%00', '/%E0%A4%A', '/..']) {
    const file = safari.fileFor(root, path)
    assert.ok(file === null || file === join(root, 'index.html') || file.startsWith(root + sep), `${path} stays inside: ${file}`)
    assert.ok(file === null || !file.includes('secret') && !file.includes('passwd'), `${path}: ${file}`)
  }
  assert.equal(safari.fileFor(root, '/%00'), null)
  assert.equal(safari.fileFor(root, '/%E0%A4%A'), null, 'a path that does not decode names nothing')
})

test('serve: a static host on this machine only, with no isolation headers, and nothing outside its folder', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'safari-check-'))
  try {
    mkdirSync(join(dir, 'web'))
    writeFileSync(join(dir, 'web', 'index.html'), '<!doctype html><title>x</title>')
    writeFileSync(join(dir, 'secret.txt'), 'no')
    const host = await safari.serve(join(dir, 'web'))
    try {
      assert.match(host.origin, /^http:\/\/127\.0\.0\.1:\d+$/)
      const page = await fetch(`${host.origin}/?debug`)
      assert.equal(page.status, 200)
      assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8')
      assert.equal(page.headers.get('cross-origin-opener-policy'), null, 'as a static host serves it: the page isolates itself or not at all')
      assert.equal(page.headers.get('cross-origin-embedder-policy'), null)
      assert.equal(page.headers.get('cache-control'), 'no-store')
      assert.equal(await page.text(), '<!doctype html><title>x</title>')
      assert.equal((await fetch(`${host.origin}/__probe`)).status, 200, 'the probe has a page of its own')
      assert.equal((await fetch(`${host.origin}/missing.js`)).status, 404)
      // fetch normalises dot segments, so the escape is asked for encoded, the way a hostile path would arrive.
      assert.equal((await fetch(`${host.origin}/..%2fsecret.txt`)).status, 404)
    } finally {
      host.server.close()
      host.server.closeAllConnections?.()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pickIphone: the newest iOS, the highest model, a Pro before a plain one; a name asked for wins; none is null', () => {
  const listing = {
    devices: {
      'com.apple.CoreSimulator.SimRuntime.iOS-18-6': [{ name: 'iPhone 16 Pro', udid: 'A', isAvailable: true, state: 'Shutdown' }],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-5': [
        { name: 'iPhone 17', udid: 'B', isAvailable: true },
        { name: 'iPhone 17 Pro', udid: 'C', isAvailable: true },
        { name: 'iPhone 17 Pro Max', udid: 'D', isAvailable: true },
        { name: 'iPhone 16e', udid: 'E', isAvailable: true },
        { name: 'iPad Pro 13-inch (M5)', udid: 'F', isAvailable: true },
        { name: 'iPhone 18 Pro', udid: 'G', isAvailable: false },
      ],
      'com.apple.CoreSimulator.SimRuntime.iOS-26-2': [{ name: 'iPhone 17 Pro', udid: 'H', isAvailable: true }],
      'com.apple.CoreSimulator.SimRuntime.watchOS-26-2': [{ name: 'iPhone 99 Pro', udid: 'I', isAvailable: true }],
    },
  }
  assert.deepEqual(safari.pickIphone(listing), { name: 'iPhone 17 Pro', udid: 'C', state: '', version: [26, 5, 0], ios: '26.5' })
  assert.equal(safari.pickIphone(listing, 'iPhone 16e')?.udid, 'E')
  assert.equal(safari.pickIphone(listing, 'iPhone 17 Pro')?.udid, 'C', 'the name on the newest iOS that has it')
  assert.equal(safari.pickIphone(listing, 'iPhone 4'), null)
  assert.equal(safari.pickIphone({ devices: {} }), null)
  assert.equal(safari.pickIphone(null), null)
})

test('isRunning: frames drawn and the crowd past where it stood, nothing less', () => {
  const state = (fps: unknown, crowdFrames: unknown) => ({ running: { fps, crowdFrames } })
  assert.equal(safari.isRunning(state(30, 12), 9), true)
  assert.equal(safari.isRunning(state(30, 9), 9), false, 'the crowd has not advanced')
  assert.equal(safari.isRunning(state(0, 40), 9), false, 'no frame drawn')
  assert.equal(safari.isRunning(state(null, 40)), false)
  assert.equal(safari.isRunning({ running: null }), false)
  assert.equal(safari.isRunning(null), false)
})

/** What the probe reports, shaped as PROBE fills it. */
const probe = (o: { gpu?: boolean; adapter?: boolean; worker?: boolean; computed?: boolean } = {}) => ({
  secure: true,
  gpu: o.gpu === false ? 'undefined' : 'object',
  adapter: o.gpu === false ? undefined : o.adapter === false ? null : { info: { vendor: 'apple' }, computed: o.computed !== false, features: [], limits: {}, lost: [] },
  worker: o.gpu === false ? { gpu: 'undefined' } : { gpu: 'object', adapter: o.adapter !== false, device: o.adapter !== false && o.worker !== false },
})
const IPHONE_LINE = 'Crimson Noir: Agent City needs WebGPU, which an iPhone has from iOS 26 on. Chrome and the other browsers on an iPhone are built on Safari’s engine, so another browser does not add it. The crowd simulation runs as WGSL compute and has no WebGL path.'
const card = (kind: string, text: string) => ({ outcome: 'card', query: safari.VISITOR, ms: 4000, end: { card: { kind, text }, running: null, veil: null, bootDone: true, pageErrors: [] } })
const running = (errors: string[] = []) => ({ outcome: 'running', query: safari.VISITOR, ms: 60000, end: { card: null, veil: null, bootDone: true, pageErrors: [], running: { fps: 30, crowdFrames: 99, pedestrians: 8000, vehicles: 36, device: 'touch', gpu: {}, quality: {}, errors } } })
const failures = (v: Verdict[]) => v.filter((c) => !c.ok).map((c) => c.what)

test('expected: what the browser was given decides what the page owes', () => {
  assert.deepEqual([safari.expected('iphone', probe()).outcome, safari.expected('iphone', probe()).kind], ['running', null])
  assert.deepEqual([safari.expected('iphone', probe({ adapter: false })).outcome, safari.expected('iphone', probe({ adapter: false })).kind], ['card', 'no-adapter'])
  assert.deepEqual([safari.expected('mac', probe({ gpu: false })).outcome, safari.expected('mac', probe({ gpu: false })).kind], ['card', 'no-api'])
  assert.deepEqual([safari.expected('mac', probe({ worker: false })).outcome, safari.expected('mac', probe({ worker: false })).kind], ['card', 'worker-gpu'], 'WebGPU on the page and none in a worker is the worker card')
  assert.match(safari.expected('iphone', probe({ adapter: false })).why, /no adapter/)
})

test('judge: with a GPU the city must run, with no engine error and no page error', () => {
  assert.deepEqual(failures(safari.judge('iphone', probe(), running())), [])
  assert.equal(failures(safari.judge('iphone', probe(), running(['Sensing Failure: x']))).length, 1, 'an engine error fails it')
  const oops = running()
  ;(oops.end.pageErrors as string[]).push('TypeError: undefined is not an object')
  assert.equal(failures(safari.judge('iphone', probe(), oops)).length, 1, 'a script error on the page fails it')
  const cardWithGpu = failures(safari.judge('iphone', probe(), card('shader', 'The browser couldn’t build the city’s graphics')))
  assert.equal(cardWithGpu.length >= 1, true, 'a card where the browser has a working GPU is a failure, whatever the card')
  assert.equal(failures(safari.judge('mac', probe(), { outcome: 'timeout', query: 'x', ms: 420000, end: { card: null, running: null, veil: 'Starting', bootDone: false, pageErrors: [] } })).length >= 1, true)
})

test('judge: with no GPU the card must be the one for exactly that, and an iPhone is sent to no other browser', () => {
  const right = card('no-adapter', `No graphics adapter for WebGPU Safari has WebGPU but gave this page no GPU, which happens after a graphics reset or when memory is short. Close the tab, or close Safari in the App Switcher, and open the page again. If it keeps happening, restart the iPhone. ${IPHONE_LINE}`)
  assert.deepEqual(failures(safari.judge('iphone', probe({ adapter: false }), right)), [])
  // The card this check found on the live page before it was fixed: it opened its last line with Chrome.
  const old = card('no-adapter', 'No graphics adapter for WebGPU Safari has WebGPU but gave this page no GPU. Crimson Noir: Agent City needs WebGPU: a current Chrome, Edge or Brave on desktop or Android, or Safari 26 on iPhone, iPad and Mac.')
  assert.equal(failures(safari.judge('iphone', probe({ adapter: false }), old)).length >= 1, true, 'an iPhone told to use Chrome fails the check')
  assert.equal(failures(safari.judge('iphone', probe({ adapter: false }), card('other', `x ${IPHONE_LINE}`))).length >= 1, true, 'another card than the one the browser calls for')
  assert.equal(failures(safari.judge('iphone', probe({ adapter: false }), running())).length >= 1, true, 'a city that runs where the probe found no GPU means the probe is wrong: say so')
  // A Mac with no WebGPU at all (Safari on macOS 15): told what brings it, never that it is "turned off".
  const mac = card('no-api', 'Safari has no WebGPU on this Mac Safari turns WebGPU on from macOS 26; on an older macOS, Safari 26 and newer still come without it. Crimson Noir: Agent City needs WebGPU: on a Mac, Safari on macOS 26 or newer, or a current Chrome, Edge or Brave.')
  assert.deepEqual(failures(safari.judge('mac', probe({ gpu: false }), mac)), [])
  assert.equal(failures(safari.judge('mac', probe({ gpu: false }), card('no-api', 'WebGPU is turned off in Safari Safari 26 has WebGPU on unless something turned it off.'))).length >= 1, true)
  // The page's script must have run to the end either way: the watchdog's card is never the right one.
  const dead = card('no-adapter', right.end.card.text)
  ;(dead.end as { bootDone: boolean }).bootDone = false
  assert.equal(failures(safari.judge('iphone', probe({ adapter: false }), dead)).length >= 1, true)
})

test('withRecorder: the recorder is the first script of the page, the tracer comes after it only when asked, and both are scripts that parse', () => {
  const page = '<!doctype html><html lang="en"><head data-x="1"><meta charset="utf-8"><script>window.first = 1</script></head><body></body></html>'
  const plain = safari.withRecorder(page)
  assert.equal(plain, page.replace('<head data-x="1">', `<head data-x="1">${safari.RECORDER}`))
  assert.ok(!plain.includes('__safari_gpu_trace__'), 'no tracer unless asked')
  const traced = safari.withRecorder(page, true)
  assert.equal(traced, page.replace('<head data-x="1">', `<head data-x="1">${safari.RECORDER}${safari.TRACE}`))
  assert.ok(traced.indexOf('__SAFARI__') < traced.indexOf('window.first = 1'), 'ahead of the page\'s own scripts')
  assert.equal(safari.withRecorder('<p>no head</p>', true), `${safari.RECORDER}${safari.TRACE}<p>no head</p>`)
  // Each is one <script> whose body is JavaScript: a stray newline inside a quoted string once made the tracer a
  // syntax error, and a script that does not parse records nothing and says nothing.
  for (const [name, script] of [['recorder', safari.RECORDER], ['tracer', safari.TRACE]] as const) {
    const body = /^<script>([\s\S]*)<\/script>$/.exec(script)
    assert.ok(body, `${name} is one script element`)
    assert.ok(!body[1]!.includes('</script'), `${name} does not end its own element early`)
    assert.doesNotThrow(() => new Function(body[1]!), `${name} parses`)
  }
})

test('the tracer: in a page with a device, it notes the calls, an error caught in a scope, a shader the compiler refused, and the loss', async () => {
  // A stand-in for the WebGPU classes the tracer wraps, enough to run it without a browser.
  const lostResolve: Array<(l: { reason: string; message: string }) => void> = []
  class GPUDevice extends EventTarget {
    label = 'page'
    lost = new Promise<{ reason: string; message: string }>((r) => lostResolve.push(r))
    createShaderModule(_d: unknown) { return { getCompilationInfo: () => Promise.resolve({ messages: [{ type: 'error', lineNum: 7, message: 'unresolved value' }, { type: 'warning', lineNum: 1, message: 'w' }] }) } }
    createBuffer(_d: unknown) { return {} }
    pushErrorScope(_f: string) {}
    popErrorScope() { return Promise.resolve({ message: 'a pipeline was refused' }) }
  }
  class GPUAdapter { requestDevice(_d?: unknown) { return Promise.resolve(new GPUDevice()) } }
  class GPURenderPassEncoder { label = ''; draw(..._a: number[]) {} }
  class GPUQueue { label = ''; submit(_l: unknown[]) {}; writeBuffer(..._a: unknown[]) {} }
  const body = /^<script>([\s\S]*)<\/script>$/.exec(safari.TRACE)![1]!
  const window: Record<string, unknown> = { GPUDevice, GPUAdapter, GPURenderPassEncoder, GPUQueue, Worker: class {} }
  class Channel { onmessage: unknown = null; postMessage() {} }
  // The tracer keeps a timer running to know when its thread was last free: here it gets one that never fires, so
  // the test's process is free to end.
  const timers: number[] = []
  new Function('window', 'globalThis', 'self', 'BroadcastChannel', 'URL', 'Blob', 'Map', 'setInterval', body)(window, window, window, Channel, { createObjectURL: () => 'blob:x' }, Blob, Map, (_f: () => void, ms: number) => { timers.push(ms); return 0 })
  assert.deepEqual(timers, [20], 'one timer, the one that marks the thread free')
  const gpu = (window.__SAFARI__ as { gpu: { calls: string[]; key: string[]; lost: string[]; errors: string[]; total: number; frozen: boolean } }).gpu
  const device = await new GPUAdapter().requestDevice({ label: 'page' })
  device.createShaderModule({ label: 'fragment', code: 'x'.repeat(90) })
  device.createBuffer({ size: 64, usage: 8 })
  device.pushErrorScope('validation')
  await device.popErrorScope()
  new GPUQueue().writeBuffer({}, 0, new Uint8Array(4))
  new GPURenderPassEncoder().draw(3, 2_000_000_000)
  new GPUQueue().submit([{}])
  await new Promise((r) => setTimeout(r, 0))
  const calls = gpu.calls.map((c) => c.replace(/^\d+ /, ''))
  assert.deepEqual(calls.filter((c) => /^RenderPassEncoder\.draw|^Queue\.submit|^Device\.createBuffer/.test(c)), ['Device.createBuffer[page] {"size":64,"usage":8}', 'RenderPassEncoder.draw [3,2000000000]', 'Queue.submit 1'])
  assert.ok(calls.some((c) => c.startsWith('Device.createShaderModule[page] {"label":"fragment","chars":90}')), calls.join(' | '))
  assert.ok(calls.some((c) => c.startsWith('Queue.writeBuffer')), 'every call is in the short list')
  assert.ok(!gpu.key.some((c) => /Queue\.writeBuffer|pushErrorScope|popErrorScope/.test(c)), 'the long list keeps only what can end a device')
  assert.ok(gpu.key.some((c) => /RenderPassEncoder\.draw \[3,2000000000\]/.test(c)))
  assert.ok(gpu.errors.some((e) => /device page, caught in a scope: a pipeline was refused/.test(e)), gpu.errors.join(' | '))
  assert.ok(gpu.errors.some((e) => /shader fragment \(90 chars\), line 7: unresolved value/.test(e)), gpu.errors.join(' | '))
  assert.equal(gpu.errors.some((e) => /: w$/.test(e)), false, 'a warning is not an error')
  const before = gpu.calls.length
  lostResolve[0]!({ reason: 'unknown', message: '' })
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(gpu.lost.length, 1)
  assert.match(gpu.lost[0]!, /^\d+ device page lost: reason unknown, message "" \(heard now; this thread was last free at \d+\)$/)
  new GPUQueue().submit([{}])
  assert.equal(gpu.calls.length, before, 'the list is frozen at the loss: it ends with what came before')
  assert.equal(gpu.frozen, true)
})

test('the probe: its drawing ladder parses, runs inside the probe, and tries each kind of work the renderer asks for', () => {
  assert.doesNotThrow(() => new Function(`return ${safari.LADDER}`), 'the ladder is a function expression')
  assert.doesNotThrow(() => new Function(`return ${safari.PROBE}`), 'the probe is an expression with the ladder in it')
  assert.ok(safari.PROBE.includes(safari.LADDER), 'the probe runs the ladder')
  const stages = /const STAGES = \{([\s\S]*?)\n {2}\}\n/.exec(safari.LADDER)
  assert.ok(stages, 'the stages')
  assert.deepEqual([...stages[1]!.matchAll(/^ {4}(\w+): /gm)].map((m) => m[1]), ['clear', 'draw', 'bundle', 'mips', 'mipsDirect', 'npot', 'fourMips', 'power', 'features', 'cityStart', 'idle', 'besideWorker', 'indirect', 'msaa', 'canvas'])
  // Each stage has a device of its own: a browser that drops the device on one kind of work still answers for the rest.
  assert.match(safari.LADDER, /for \(const name of Object\.keys\(STAGES\)\) \{[\s\S]*?requestAdapter\(how\.adapter\)[\s\S]*?requestDevice\(\{ label: how\.label \|\| 'probe: ' \+ name, /)
  assert.match(safari.LADDER, /r\.ok = r\.lost === null && r\.errors\.length === 0 && got !== null && got\.right === true/)
})

test('the tool: Safari through safaridriver on this machine only, the two targets, and a verdict that can fail', () => {
  assert.match(TOOL, /spawn\('safaridriver', \['--port', String\(port\)\]/)
  assert.match(TOOL, /'safari:useSimulator': true, 'safari:deviceUDID': phone\.udid/)
  assert.match(TOOL, /server\.listen\(0, '127\.0\.0\.1', r\)/)
  assert.doesNotMatch(TOOL, /--observe|observe \?/, 'no mode that only watches: every run is a verdict')
  assert.doesNotMatch(TOOL, /https?:\/\/(?!127\.0\.0\.1|x\b)[a-z]/i, 'no address but this machine')
  assert.match(safari.PROBE, /requestAdapter\(\)/)
  assert.match(safari.STATE, /\[data-failure\]/)
  assert.equal(safari.VISITOR, 'debug&onboarding=0&audio=0')
})

test('iphone.yml: Safari on both Macs and in the Simulator, GitHub\'s own actions only, read-only, and no way to pass unseen', () => {
  assert.match(FLOW, /\nname: iphone\n/)
  assert.match(FLOW, /\npermissions:\n {2}contents: read\n/)
  assert.match(FLOW, /on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/)
  // Two jobs: Safari on the Mac (where WebKit has a GPU on macOS 26, and must then run the city), and Safari in the
  // iOS Simulator on the newest runner.
  const mac = FLOW.slice(FLOW.indexOf('\n  mac:\n'), FLOW.indexOf('\n  iphone:\n'))
  const phone = FLOW.slice(FLOW.indexOf('\n  iphone:\n'))
  assert.ok(mac.length > 0 && phone.length > 0, 'the mac job and the iphone job')
  assert.match(mac, /runner: \[macos-26, macos-15\]/)
  assert.match(mac, /fail-fast: false/)
  assert.match(mac, /defaults write -g WebKitAllowWebGPUOnVMs -bool YES/, 'WebKit\'s own switch for a virtual Mac, before Safari starts')
  assert.ok(mac.indexOf('WebKitAllowWebGPUOnVMs -bool YES') < mac.indexOf('safari.mjs --web dist-web --target mac'), 'the switch is set before Safari starts')
  assert.match(mac, /node tools\/browser\/safari\.mjs --web dist-web --target mac .*\$\{\{ matrix\.runner == 'macos-26' && '--needs-gpu' \|\| '' \}\}/, 'on macOS 26 a Safari without a GPU fails the check')
  assert.match(mac, /safari\.mjs --web dist-web --target mac --trace /, 'a start WebKit ends says which WebGPU calls came before')
  assert.match(phone, /runs-on: macos-26\n/)
  assert.match(phone, /node tools\/browser\/safari\.mjs --web dist-web --target iphone /)
  for (const job of [mac, phone]) {
    assert.match(job, /persist-credentials: false/)
    assert.match(job, /node-version: '22'/)
    assert.match(job, /npm ci --no-audit --no-fund/)
    assert.match(job, /npm run build:web/)
    assert.match(job, /sudo safaridriver --enable/)
    assert.match(job, /timeout-minutes: \d+/)
    assert.match(job, /uses: actions\/upload-artifact@v4\n {8}if: always\(\)/, 'the report and screenshots are kept either way')
  }
  const uses = [...FLOW.matchAll(/uses: (\S+)/g)].map((m) => m[1])
  assert.equal(uses.length, 6)
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@v\d+$/, u)
  assert.doesNotMatch(FLOW, /--observe|continue-on-error/, 'the check is not allowed to fail quietly')
  for (const line of FLOW.split('\n').filter((l) => l.includes('safari.mjs --web'))) assert.doesNotMatch(line, /\|\| true/, line)
})
