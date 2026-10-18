// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the two parts of tools/browser/cdp.mjs that the browser smoke test's no-leak
 * audit stands on (smoke.mjs `inpage`), without a browser: loopbackOnly() gives Chrome one resolver switch, the
 * scenario's own rules first and every other name unresolvable, no proxy switch and no proxy variable; and
 * watchTargets() sends Target.setAutoAttach on the page and again on every worker as it attaches (a worker's own
 * workers are attached only so), enables Network and Log on each, counts a worker the browser created but this watch
 * never attached as missing, and judges every request, socket and security message from any of them.
 * What breaks if it is removed? A change to the helper could drop a scenario's own host mapping, leave a proxy in the
 * way of the rules, or stop attaching the runtime's threads, and the audit would pass over requests it never saw.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

type Sent = { method: string; params: Record<string, unknown>; sid: string }
type Audit = {
  requests: number
  fromWorkers: number
  offOrigin: { type: string; url: string }[]
  sockets: { type: string; kind: string; url: string }[]
  security: { type: string; text: string }[]
  discovered: number
  attached: number
  missing: { type: string; url: string }[]
  workers: Record<string, number>
  nested: number
  errors: number
}
type Watch = { audit(allowed: (url: string) => boolean): Audit; failed: { url: string; error: string; blocked: string | null }[] }

// tools/ is plain JavaScript with no types; a computed specifier keeps the page's typecheck off it.
const CDP: string = '../tools/browser/cdp.mjs'
const cdp = (await import(CDP)) as {
  LOOPBACK_RULES: string
  loopbackOnly(args?: string[], env?: Record<string, string | undefined>): { args: string[]; env: Record<string, string | undefined> }
  watchTargets(browser: FakeBrowser, opts?: { wait?: boolean }): Promise<Watch>
}

/** The browser as watchTargets() uses it: commands recorded in the order sent, events emitted by the test. */
class FakeBrowser {
  sessionId = 'page'
  sent: Sent[] = []
  /** Sessions whose target is gone: their commands fail. */
  gone = new Set<string>()
  #on = new Map<string, ((params: unknown, sid?: string) => void)[]>()
  on(method: string, fn: (params: unknown, sid?: string) => void): void {
    this.#on.set(method, [...(this.#on.get(method) ?? []), fn])
  }
  send(method: string, params: Record<string, unknown> = {}, sid: string = this.sessionId): Promise<unknown> {
    this.sent.push({ method, params, sid })
    return this.gone.has(sid) ? Promise.reject(new Error('No session with given id')) : Promise.resolve({})
  }
  emit(method: string, params: unknown, sid?: string): void {
    for (const fn of this.#on.get(method) ?? []) fn(params, sid)
  }
  /** The browser creating a worker target (seen through Target.setDiscoverTargets, on the browser's own session). */
  created(targetId: string, type = 'worker', url = `blob:http://127.0.0.1:1/${targetId}`): void {
    this.emit('Target.targetCreated', { targetInfo: { targetId, type, url } })
  }
  /** That worker attached from session `parent`, under session `sid`. */
  attach(targetId: string, sid: string, parent: string, type = 'worker', waitingForDebugger = false): void {
    this.emit('Target.attachedToTarget', { sessionId: sid, targetInfo: { targetId, type, url: `blob:http://127.0.0.1:1/${targetId}` }, waitingForDebugger }, parent)
  }
  of(sid: string): string[] {
    return this.sent.filter((s) => s.sid === sid).map((s) => s.method)
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
const ORIGIN = 'http://127.0.0.1:1'
const allowed = (u: string): boolean => u === ORIGIN || u.startsWith(`${ORIGIN}/`) || u.startsWith('blob:') || u.startsWith('data:')
const AUTO = { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }

test('loopbackOnly: one resolver switch that leaves no name but 127.0.0.1, and no proxy switch or variable', () => {
  const env = { PATH: '/bin', http_proxy: 'http://p:1', HTTPS_PROXY: 'http://p:2', no_proxy: 'x', All_Proxy: 'socks://p:3', HOME: '/h' }
  const args = ['--use-angle=swiftshader', '--window-size=960,540']
  const out = cdp.loopbackOnly(args, env)
  assert.equal(cdp.LOOPBACK_RULES, 'MAP * ~NOTFOUND, EXCLUDE 127.0.0.1')
  assert.deepEqual(out.args, ['--use-angle=swiftshader', '--window-size=960,540', `--host-resolver-rules=${cdp.LOOPBACK_RULES}`, '--no-proxy-server'])
  assert.deepEqual(out.env, { PATH: '/bin', HOME: '/h' })
  // Nothing given is changed.
  assert.deepEqual(args, ['--use-angle=swiftshader', '--window-size=960,540'])
  assert.equal(env.http_proxy, 'http://p:1')
})

test('loopbackOnly: a scenario\'s own rules, quoted or not, are merged into the one switch ahead of the loopback rules', () => {
  const out = cdp.loopbackOnly(['--a', '--host-resolver-rules="MAP lan.test 127.0.0.1"', '--no-proxy-server', '--host-resolver-rules=MAP b.test 127.0.0.1', '--z'], {})
  const rules = out.args.filter((a) => a.startsWith('--host-resolver-rules='))
  assert.deepEqual(rules, [`--host-resolver-rules=MAP lan.test 127.0.0.1, MAP b.test 127.0.0.1, ${cdp.LOOPBACK_RULES}`])
  assert.deepEqual(out.args.filter((a) => a === '--no-proxy-server'), ['--no-proxy-server'])
  assert.deepEqual(out.args.slice(0, 2), ['--a', '--z'])
})

test('watchTargets: discovery on the browser, then Network, Log and auto-attach (flattened, not paused) on the page', async () => {
  const b = new FakeBrowser()
  await cdp.watchTargets(b)
  assert.deepEqual(b.sent[0], { method: 'Target.setDiscoverTargets', params: { discover: true }, sid: '' })
  assert.deepEqual(b.of('page').sort(), ['Log.enable', 'Network.enable', 'Target.setAutoAttach'])
  assert.deepEqual(b.sent.find((s) => s.sid === 'page' && s.method === 'Target.setAutoAttach')?.params, AUTO)
})

test('watchTargets: auto-attach is sent again on every worker as it attaches, so a worker\'s own workers are attached and counted nested', async () => {
  const b = new FakeBrowser()
  const w = await cdp.watchTargets(b)
  b.created('w1')
  b.attach('w1', 's1', 'page')
  await settle()
  assert.deepEqual(b.of('s1').sort(), ['Log.enable', 'Network.enable', 'Target.setAutoAttach'])
  assert.deepEqual(b.sent.find((s) => s.sid === 's1' && s.method === 'Target.setAutoAttach')?.params, AUTO)
  // Its pthread workers, attached through its session.
  b.created('t1')
  b.created('t2')
  b.attach('t1', 's2', 's1')
  b.attach('t2', 's3', 's1')
  await settle()
  for (const s of ['s2', 's3']) assert.ok(b.of(s).includes('Target.setAutoAttach'), `${s} is set up to attach its own workers`)
  const a = w.audit(allowed)
  assert.equal(a.discovered, 3)
  assert.equal(a.attached, 3)
  assert.deepEqual(a.missing, [])
  assert.equal(a.nested, 2)
  assert.deepEqual(a.workers, { worker: 3 })
})

test('watchTargets: a worker the browser created that was never attached is missing', async () => {
  const b = new FakeBrowser()
  const w = await cdp.watchTargets(b)
  b.created('w1')
  b.attach('w1', 's1', 'page')
  b.created('t1', 'worker', 'blob:http://127.0.0.1:1/thread')
  await settle()
  const a = w.audit(allowed)
  assert.equal(a.discovered, 2)
  assert.equal(a.attached, 1)
  assert.deepEqual(a.missing, [{ type: 'worker', url: 'blob:http://127.0.0.1:1/thread' }])
  assert.equal(a.nested, 0)
})

test('watchTargets: requests off the origin from the page or any worker, every socket and every security message are reported', async () => {
  const b = new FakeBrowser()
  const w = await cdp.watchTargets(b)
  b.created('w1')
  b.attach('w1', 's1', 'page')
  await settle()
  const req = (requestId: string, url: string, sid: string): void => b.emit('Network.requestWillBeSent', { requestId, request: { url } }, sid)
  req('1', `${ORIGIN}/`, 'page')
  req('2', 'data:application/wasm;base64,AA', 's1')
  req('3', 'blob:http://127.0.0.1:1/x', 's1')
  req('4', 'http://localhost:1/model', 's1')
  req('5', 'http://127.0.0.1:2/', 'page')
  b.emit('Network.loadingFailed', { requestId: '4', errorText: 'net::ERR_BLOCKED_BY_CLIENT', blockedReason: 'csp' }, 's1')
  b.emit('Network.webSocketCreated', { url: 'ws://127.0.0.1:1/' }, 's1')
  b.emit('Network.webTransportCreated', { url: 'https://127.0.0.1:1/' }, 'page')
  b.emit('Log.entryAdded', { entry: { source: 'security', text: 'Refused to connect' } }, 's1')
  b.emit('Log.entryAdded', { entry: { source: 'javascript', text: 'not security' } }, 's1')
  const a = w.audit(allowed)
  assert.equal(a.requests, 5)
  assert.equal(a.fromWorkers, 3)
  assert.deepEqual(a.offOrigin, [{ type: 'worker', url: 'http://localhost:1/model' }, { type: 'page', url: 'http://127.0.0.1:2/' }])
  assert.deepEqual(a.sockets, [{ type: 'worker', kind: 'WebSocket', url: 'ws://127.0.0.1:1/' }, { type: 'page', kind: 'WebTransport', url: 'https://127.0.0.1:1/' }])
  assert.equal(a.security.length, 1)
  assert.equal(a.security[0].type, 'worker')
  assert.deepEqual(w.failed, [{ type: 'worker', url: 'http://localhost:1/model', error: 'net::ERR_BLOCKED_BY_CLIENT', blocked: 'csp' }])
})

test('watchTargets: a command a worker gone too soon did not take is counted, not thrown', async () => {
  const b = new FakeBrowser()
  const w = await cdp.watchTargets(b)
  b.gone.add('s1')
  b.attach('w1', 's1', 'page')
  await settle()
  assert.equal(w.audit(allowed).errors, 3)
})

test('watchTargets with wait: a paused worker is set up, then run; a paused service worker is run first', async () => {
  const b = new FakeBrowser()
  await cdp.watchTargets(b, { wait: true })
  assert.equal(b.sent.find((s) => s.sid === 'page' && s.method === 'Target.setAutoAttach')?.params.waitForDebuggerOnStart, true)
  b.attach('w1', 's1', 'page', 'worker', true)
  b.attach('sw', 's2', 'page', 'service_worker', true)
  await settle()
  await settle()
  assert.equal(b.of('s1').at(-1), 'Runtime.runIfWaitingForDebugger')
  assert.equal(b.of('s1').length, 4)
  assert.equal(b.of('s2')[0], 'Runtime.runIfWaitingForDebugger')
  assert.equal(b.of('s2').length, 4)
})
