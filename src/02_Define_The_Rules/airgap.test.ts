/**
 * Why does this file exist? It proves the gate (airgap.ts): loopbackOnly admits exactly http(s)/ws(s) to localhost,
 * 127.0.0.0/8 or [::1] with no credentials, and the two aliases narrow it by protocol; and installAirgap, on a fake
 * global, guards fetch (strings, URL objects, Request objects, relative URLs), WebSocket, EventSource, XMLHttpRequest
 * and importScripts, admits the page's own origin and page-made blob: and data: URLs, removes RTCPeerConnection,
 * WebTransport and navigator.sendBeacon outright, refuses in one plain sentence, cannot be undone by a later script
 * (the properties are frozen, the originals unreachable through prototypes), and installs once.
 * What breaks if it is removed? The containment could be loosened, or made restorable, without a test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { installAirgap, isLoopbackHost, loopbackFetch, loopbackOnly, loopbackServer, loopbackUrl, netServer, refusal, ROOM_HOSTS } from './airgap.ts'

test('loopbackOnly: http(s) and ws(s) to localhost, 127.0.0.0/8 or [::1], without credentials, give the origin; nothing else does', () => {
  const ok: [string, string][] = [
    ['http://localhost:11434', 'http://localhost:11434'],
    ['http://LOCALHOST:11434/api/generate', 'http://localhost:11434'],
    ['https://127.0.0.1:8443', 'https://127.0.0.1:8443'],
    ['http://127.1.2.3:1234/x?y', 'http://127.1.2.3:1234'],
    ['http://[::1]:11434', 'http://[::1]:11434'],
    ['ws://127.0.0.1:8787/room', 'ws://127.0.0.1:8787'],
    ['wss://localhost:8788', 'wss://localhost:8788'],
    ['  http://localhost:80  ', 'http://localhost'],
    ['http://2130706433:11434', 'http://127.0.0.1:11434'],
  ]
  for (const [url, origin] of ok) assert.equal(loopbackOnly(url), origin, url)
  const off = [
    'http://example.com', 'https://api.example.com/v1', 'wss://rooms.example.net', 'http://192.168.1.2:11434', 'http://10.0.0.1', 'http://0.0.0.0:11434',
    'http://localhost.evil.com', 'http://127.0.0.1.nip.io', 'http://user:pw@localhost:11434', 'http://user@localhost', 'ws://ada:secret@localhost',
    'file:///etc/hosts', 'ftp://localhost', 'blob:http://localhost/abc', 'data:text/plain,hi', 'localhost:11434', '', 'not a url', 'http://[::2]:11434',
    42, null, undefined, {}, ['http://localhost'],
  ]
  for (const bad of off) assert.equal(loopbackOnly(bad), null, String(bad))
  assert.ok(isLoopbackHost('LocalHost') && isLoopbackHost('127.255.255.255') && isLoopbackHost('[::1]'))
  assert.ok(!isLoopbackHost('127.0.0.1.evil') && !isLoopbackHost('::1') && !isLoopbackHost(''))
  assert.equal(loopbackUrl('http://localhost:1/a')?.pathname, '/a')
})

test('the aliases are the gate narrowed by protocol: loopbackServer gives an http(s) origin, netServer a ws(s) URL with its path', () => {
  assert.equal(loopbackServer('http://localhost:11434/api/tags'), 'http://localhost:11434')
  assert.equal(loopbackServer('https://[::1]:8443'), 'https://[::1]:8443')
  assert.equal(loopbackServer('ws://localhost:8787'), null, 'not a model server')
  assert.equal(loopbackServer('http://example.com'), null)
  assert.equal(netServer('ws://127.0.0.1:8787/room'), 'ws://127.0.0.1:8787/room')
  assert.equal(netServer(' wss://localhost:8788 '), 'wss://localhost:8788/')
  assert.equal(netServer('http://localhost:8787'), null, 'not a room')
  assert.equal(netServer('wss://rooms.example.net'), null)
  assert.equal(netServer('ws://ada:secret@localhost:8787'), null)
  // Every room host the gate admits is one the page's content security policy reaches, and no other loopback address.
  const csp = readFileSync(new URL('../../index.html', import.meta.url), 'utf8').match(/connect-src ([^;]+);/)?.[1] ?? ''
  for (const h of ROOM_HOSTS) for (const scheme of ['ws', 'wss']) assert.ok(csp.split(' ').includes(`${scheme}://${h}:*`), `${scheme}://${h}:* in connect-src`)
  for (const other of ['ws://[::1]:8787', 'ws://127.0.0.2:8787', 'wss://127.1.2.3:8788']) assert.equal(netServer(other), null, other)
  assert.equal(refusal('http://example.com'), 'http://example.com is not on this machine: the page addresses only localhost, 127.0.0.0/8 or [::1]')
})

test('loopbackFetch: a wrapped fetch rejects anything off this machine before the inner fetch is called', async () => {
  const calls: string[] = []
  const f = loopbackFetch(async (url: string) => { calls.push(url); return new Response('ok') })
  assert.equal(await (await f('http://localhost:11434/api/tags')).text(), 'ok')
  await assert.rejects(f('https://api.example.com/v1/messages'), (e: Error) => e instanceof TypeError && e.message === refusal('https://api.example.com/v1/messages'))
  await assert.rejects(f('/relative'), TypeError)
  assert.deepEqual(calls, ['http://localhost:11434/api/tags'])
})

/** A global as the page has it, with every primitive a recorder, so the test can see what the real one would have been given. */
function fakeGlobal(origin = 'http://localhost:4173') {
  const sent: string[] = []
  class Request {
    #url: string
    constructor(url: string) { this.#url = url }
    get url(): string { return this.#url }
  }
  class WebSocket {
    static readonly OPEN = 1
    readonly url: string
    constructor(url: string, protocols?: string) { this.url = `${url}${protocols ? ` [${protocols}]` : ''}`; sent.push(`ws ${url}`) }
  }
  class EventSource {
    readonly url: string
    constructor(url: string) { this.url = url; sent.push(`es ${url}`) }
  }
  class XMLHttpRequest {
    opened = ''
    open(method: string, url: string, async?: boolean): void { this.opened = `${method} ${url}${async === false ? ' sync' : ''}`; sent.push(`xhr ${url}`) }
  }
  class RTCPeerConnection {}
  class WebTransport {}
  class Navigator {
    sendBeacon(url: string): boolean { sent.push(`beacon ${url}`); return true }
  }
  const g = {
    fetch: async (input: unknown) => { sent.push(`fetch ${input instanceof Request ? input.url : String(input)}`); return new Response('ok') },
    WebSocket, EventSource, XMLHttpRequest, RTCPeerConnection, WebTransport, Request,
    importScripts: (...urls: string[]) => { sent.push(`import ${urls.join(' ')}`) },
    navigator: new Navigator(),
    location: { origin, href: `${origin}/` },
  }
  return { g, sent, Request, WebSocket, EventSource, XMLHttpRequest }
}

test('installAirgap: every primitive lets this machine, the page\'s own origin and page-made blob: or data: URLs through, and nothing else', async () => {
  const { g, sent, Request, WebSocket } = fakeGlobal()
  const r = installAirgap(g)
  assert.deepEqual(r, { own: 'http://localhost:4173', guarded: ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'importScripts'], removed: ['RTCPeerConnection', 'WebTransport', 'navigator.sendBeacon'] })
  const off = refusal('https://api.example.com/v1/messages')
  // fetch: a string, a URL object, a Request object, a relative URL (the page's own origin), blob: and data:.
  await g.fetch('http://localhost:11434/api/tags')
  await g.fetch(new URL('ws://127.0.0.1:8787/x'))
  await g.fetch(new Request('http://[::1]:8089/v1/messages'))
  await g.fetch('/assets/x.json')
  await g.fetch('blob:http://localhost:4173/0000')
  await g.fetch('data:text/plain,hi')
  await assert.rejects(g.fetch('https://api.example.com/v1/messages'), (e: Error) => e instanceof TypeError && e.message === off)
  await assert.rejects(g.fetch(new Request('https://api.example.com/v1/messages')), (e: Error) => e.message === off)
  await assert.rejects(g.fetch(new URL('wss://rooms.example.net')), TypeError)
  await assert.rejects(g.fetch('http://user:pw@localhost:11434'), TypeError)
  await assert.rejects(g.fetch('ftp://localhost/x'), TypeError)
  await assert.rejects(g.fetch({ toString: () => 'https://api.example.com/' }), TypeError, 'an object is read once, as the string the real fetch would see')
  // WebSocket and EventSource: constructed with the admitted string; statics and instanceof survive.
  const ws = new g.WebSocket('ws://localhost:8787/room', 'json')
  assert.ok(ws instanceof WebSocket)
  assert.equal(ws.url, 'ws://localhost:8787/room [json]')
  assert.equal(g.WebSocket.OPEN, 1)
  assert.throws(() => new g.WebSocket('wss://rooms.example.net'), (e: Error) => e instanceof TypeError && e.message === refusal('wss://rooms.example.net'))
  assert.throws(() => new g.WebSocket('ws://192.168.1.2:8787'), TypeError)
  assert.throws(() => (g.WebSocket as unknown as (u: string) => unknown)('ws://localhost:1'), /called with new/)
  assert.equal(new g.EventSource('http://127.0.0.1:1/events').url, 'http://127.0.0.1:1/events')
  assert.throws(() => new g.EventSource('https://example.com/events'), TypeError)
  // XMLHttpRequest: open is where the address is given.
  const x = new g.XMLHttpRequest()
  x.open('GET', 'http://localhost:8080/v1/models', false)
  assert.equal(x.opened, 'GET http://localhost:8080/v1/models sync')
  assert.throws(() => x.open('POST', 'https://example.com/'), TypeError)
  // importScripts: every URL is checked, and nothing is loaded if one fails.
  g.importScripts('http://localhost:1/a.js', 'blob:http://localhost:4173/b')
  assert.throws(() => g.importScripts('http://localhost:1/a.js', 'https://cdn.example.com/x.js'), TypeError)
  assert.deepEqual(sent, [
    'fetch http://localhost:11434/api/tags', 'fetch ws://127.0.0.1:8787/x', 'fetch http://[::1]:8089/v1/messages', 'fetch http://localhost:4173/assets/x.json',
    'fetch blob:http://localhost:4173/0000', 'fetch data:text/plain,hi',
    'ws ws://localhost:8787/room', 'es http://127.0.0.1:1/events', 'xhr http://localhost:8080/v1/models',
    'import http://localhost:1/a.js blob:http://localhost:4173/b',
  ])
})

test('installAirgap: RTCPeerConnection, WebTransport and sendBeacon are gone, on the instance and up the prototype chain', () => {
  const { g } = fakeGlobal()
  const navProto = Object.getPrototypeOf(g.navigator) as { sendBeacon?: unknown }
  assert.equal(typeof navProto.sendBeacon, 'function', 'the fake keeps it on the prototype, as the browser does')
  installAirgap(g)
  assert.equal(g.RTCPeerConnection, undefined)
  assert.equal(g.WebTransport, undefined)
  assert.equal('RTCPeerConnection' in g && typeof g.RTCPeerConnection, 'undefined')
  assert.equal(g.navigator.sendBeacon, undefined)
  assert.equal(navProto.sendBeacon, undefined)
  assert.equal(Object.getOwnPropertyDescriptor(g.navigator, 'sendBeacon')?.configurable, false)
})

test('installAirgap: a later script cannot restore a primitive, reach the original through a prototype, or install again', async () => {
  const { g, sent, WebSocket: RealSocket, EventSource: RealSource } = fakeGlobal()
  const realFetch = g.fetch
  const first = installAirgap(g)
  assert.equal(installAirgap(g), first, 'installed once: the same report again')
  const strict = (f: () => void): void => { assert.throws(f, TypeError) }
  for (const name of ['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest', 'importScripts', 'RTCPeerConnection', 'WebTransport'] as const) {
    const d = Object.getOwnPropertyDescriptor(g, name)
    assert.deepEqual([d?.writable, d?.configurable], [false, false], name)
    strict(() => { Object.defineProperty(g, name, { value: realFetch, configurable: true }) })
    strict(() => { delete (g as Record<string, unknown>)[name] })
  }
  strict(() => { (g as { fetch: unknown }).fetch = realFetch })
  // The originals are not reachable through the prototypes the guarded constructors share.
  assert.equal(RealSocket.prototype.constructor, g.WebSocket)
  assert.equal(RealSource.prototype.constructor, g.EventSource)
  assert.notEqual(g.WebSocket, RealSocket)
  assert.throws(() => new (g.WebSocket.prototype.constructor as typeof RealSocket)('wss://rooms.example.net'), TypeError)
  const open = Object.getOwnPropertyDescriptor(g.XMLHttpRequest.prototype, 'open')
  assert.deepEqual([open?.writable, open?.configurable], [false, false])
  // A Request whose url getter is replaced on the prototype still reads the URL it was made with.
  Object.defineProperty(Object.getPrototypeOf(new g.Request('http://localhost:1')), 'url', { get: () => 'http://localhost:1/', configurable: true })
  await assert.rejects(g.fetch(new g.Request('https://api.example.com/v1/messages')), TypeError)
  assert.equal(sent.length, 0, 'nothing reached a real primitive')
})

test('installAirgap: a page with no origin of its own (opened as a file) admits loopback only; a bare global installs nothing and reports so', async () => {
  const { g, sent } = fakeGlobal()
  g.location = { origin: 'null', href: 'file:///home/op/dist/index.html' }
  const r = installAirgap(g)
  assert.equal(r.own, null)
  await assert.rejects(g.fetch('/x'), TypeError, 'a relative URL resolves to the file, which is not an address')
  await assert.rejects(g.fetch('file:///etc/hosts'), TypeError)
  await g.fetch('http://localhost:11434/api/tags')
  assert.deepEqual(sent, ['fetch http://localhost:11434/api/tags'])
  assert.deepEqual(installAirgap({}), { own: null, guarded: [], removed: [] })
})
