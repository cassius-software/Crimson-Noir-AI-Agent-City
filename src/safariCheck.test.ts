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

test('iphone.yml: both Macs, GitHub\'s own actions only, read-only, and the tool run without a way to pass unseen', () => {
  assert.match(FLOW, /\nname: iphone\n/)
  assert.match(FLOW, /\npermissions:\n {2}contents: read\n/)
  assert.match(FLOW, /runner: \[macos-26, macos-15\]/)
  const uses = [...FLOW.matchAll(/uses: (\S+)/g)].map((m) => m[1])
  assert.ok(uses.length >= 3)
  for (const u of uses) assert.match(u, /^actions\/[a-z-]+@v\d+$/, u)
  assert.match(FLOW, /persist-credentials: false/)
  assert.match(FLOW, /npm run build:web/)
  assert.match(FLOW, /sudo safaridriver --enable/)
  assert.match(FLOW, /node tools\/browser\/safari\.mjs --web dist-web --target mac /)
  assert.match(FLOW, /node tools\/browser\/safari\.mjs --web dist-web --target iphone /)
  assert.doesNotMatch(FLOW, /--observe|continue-on-error|\|\| true\n\s+node tools/, 'the check is not allowed to fail quietly')
  assert.match(FLOW, /defaults write -g WebKitAllowWebGPUOnVMs -bool YES/, 'WebKit\'s own switch for a virtual Mac')
  assert.match(FLOW, /on:\n {2}pull_request:\n {2}push:\n {4}branches: \[main\]\n {2}workflow_dispatch:\n/)
})
