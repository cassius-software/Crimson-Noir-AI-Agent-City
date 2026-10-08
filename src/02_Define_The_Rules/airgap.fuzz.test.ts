// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the property-based fuzzing of the loopback gate (airgap.ts) and of the content
 * security policy index.html ships, seeded and replayable (property.ts), written as an attacker spells addresses:
 * every loopback spelling the WHATWG parser reduces (127.1, 0177.0.0.1, 0x7f.1, 2130706433, [0:0:0:0:0:0:0:1], a
 * trailing dot, fullwidth letters, a tab inside the host), every look-alike off this machine (localhost.evil.com,
 * 127.0.0.1.nip.io, sub.localhost, an IPv4-mapped [::ffff:127.0.0.1], 0.0.0.0, [::]), credentials in every position
 * (evil.com@localhost, localhost@evil.com, user:pw@), ports at and over the edge, paths, queries and fragments that
 * carry an @, javascript:, data:, file: and blob: schemes, whitespace and control characters around and inside, and
 * plain junk. The oracle is independent of the gate's own regex: the parsed host must be `localhost`, `[::1]` or a
 * dotted quad whose first octet is 127, read numerically. The properties: loopbackOnly admits exactly http(s)/ws(s)
 * to this machine without credentials (its result is that URL's origin, a fixed point of the gate) and never throws;
 * loopbackServer and netServer are that verdict narrowed by scheme, and netServer's hosts are exactly the socket
 * sources of the page's connect-src, read from index.html, in both directions; the policy itself admits nothing
 * off this machine in any directive, keeps 'unsafe-inline' and 'unsafe-eval' where the comment in index.html
 * explains them, closes frames, objects, forms and base, and is the same meta in dist/index.html when a build is
 * present; installAirgap, on a fake global with any of four page origins (preview, a file, a host off this machine,
 * no location at all), hands every primitive exactly the URLs the gate admits resolved against the page, plus the
 * page's own origin and page-made blob: and data: URLs, and refuses the rest with the one sentence; and a socket URL
 * the gate admits with a fragment (which the browser's WebSocket refuses) comes back from the room client as a
 * refusal in words, never a throw.
 * What breaks if it is removed? A spelling of an address nobody tried could pass the gate off this machine, or the
 * policy and the gate could part, and nothing would say so until a prompt or a token had left.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createNetClient } from '../10_Network/netClient.ts'
import { installAirgap, isLoopbackHost, loopbackFetch, loopbackOnly, loopbackServer, loopbackUrl, netServer, refusal, ROOM_HOSTS } from './airgap.ts'
import { anyValue, forAll, type Gen } from './property.ts'

// ---------------------------------------------------------------- the oracle

/** The schemes the page may speak at all (airgap.ts PROTOCOLS, restated). */
const WEB: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/**
 * This machine, read off a hostname the WHATWG parser produced, with no regex shared with the gate: `localhost`
 * (the parser lowercases ASCII hosts and maps fullwidth letters), the canonical `[::1]`, or a dotted quad (the
 * parser serialises every IPv4 spelling to one) whose first octet is 127, each octet a plain decimal of 0..255.
 */
function thisMachine(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const q = hostname.split('.')
  return q.length === 4 && q[0] === '127' && q.every((o) => /^(?:0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)
}

/** The URL as the gate parses it (trimmed, absolute), or null. */
function parsed(s: string): URL | null {
  try {
    return new URL(s.trim())
  } catch {
    return null
  }
}

/** The gate's contract, stated independently: the origin of a web URL to this machine with no credentials, else null. */
function expected(s: string): string | null {
  const u = parsed(s)
  return u !== null && WEB.has(u.protocol) && u.username === '' && u.password === '' && thisMachine(u.hostname) ? u.origin : null
}

// ---------------------------------------------------------------- the policy

const INDEX = fileURLToPath(new URL('../../index.html', import.meta.url))
const DIST = fileURLToPath(new URL('../../dist/index.html', import.meta.url))

const metaOf = (html: string): string => {
  const m = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/)
  assert.ok(m, 'the page carries one Content-Security-Policy meta')
  return m[1]
}

/** The policy as directives: name to its source list. */
function directives(content: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const d of content.split(';')) {
    const [name, ...sources] = d.trim().split(/\s+/)
    if (name) out.set(name, sources)
  }
  return out
}

const POLICY = directives(metaOf(readFileSync(INDEX, 'utf8')))
const CONNECT = POLICY.get('connect-src') ?? []

/**
 * Whether a directive's sources admit `u` for a page whose origin is `self` (null for a page opened from a file, whose
 * origin is opaque). Scheme and host are matched exactly: the policy names http and https, ws and wss each by name,
 * so the browser's "http also matches https" rule changes nothing here. A source shape this cannot read fails the test.
 */
function admits(sources: readonly string[], u: URL, self: string | null): boolean {
  return sources.some((src) => {
    if (src === "'none'") return false
    if (src === "'self'") return self !== null && u.origin === self
    if (/^[a-z][a-z0-9+.-]*:$/i.test(src)) return u.protocol === src.toLowerCase()
    const m = src.match(/^([a-z][a-z0-9+.-]*):\/\/([^/:*]+)(?::(\*|\d+))?$/i)
    if (m) return u.protocol === `${m[1].toLowerCase()}:` && u.hostname === m[2].toLowerCase() && (m[3] === undefined ? u.port === '' : m[3] === '*' || u.port === m[3])
    return assert.fail(`a source this test cannot read: ${src}`)
  })
}

// ---------------------------------------------------------------- the spellings

/** Spellings of this machine, ASCII: each is a loopback address once the parser is done with it. */
const LOOPBACK_ASCII: readonly string[] = [
  '127.0.0.1', '127.1', '127.0.1', '127.65793', '0177.0.0.1', '0x7f.0.0.1', '0x7f.1', '0x7f000001', '0x7F.0x0.0x0.0x1', '2130706433', '2130706432',
  '2147483647', '127.255.255.255', '127.0.0.2', '127.0.0.1.', '127.00.0.01', '[::1]', '[0:0:0:0:0:0:0:1]', '[0000:0000:0000:0000:0000:0000:0000:0001]',
  'localhost', 'LOCALHOST', 'LoCaLhOsT', 'local\thost', 'local\nhost',
]
/** Spellings of this machine the parser maps through IDNA (fullwidth, an ideographic full stop, a zero-width space). */
const LOOPBACK_UNICODE: readonly string[] = ['ｌｏｃａｌｈｏｓｔ', 'locaｌhost', '127.0.0.1。', '１２７.0.0.1', '127.0.0.1​', 'localhost​']
/** Spellings that are not this machine, whatever a human reads into them. */
const OFF: readonly string[] = [
  'evil.com', 'localhost.evil.com', 'localhost.evil.com.', '127.0.0.1.nip.io', '127.0.0.1.evil.com', '127.0.0.1-evil.com', 'sub.localhost', 'localhost.',
  'localhost..', 'localhost.localdomain', 'localhost.localhost', 'xn--lcalhost-9za', 'lócalhost', 'localhost%2eevil.com', 'localhost%E3%80%82evil.com',
  '[::2]', '[::]', '[::ffff:0.0.0.0]', '0.0.0.0', '0', '10.0.0.1', '192.168.1.2', '128.0.0.1', '126.255.255.255', '2130706431', '2130706434.1', '[fe80::1]',
  '[::1].evil.com', '[localhost]', '[127.0.0.1]', '', 'a'.repeat(300), 'a'.repeat(300) + '.localhost',
]
/**
 * Loopback too, but refused by the gate on purpose: an IPv4-mapped IPv6 literal (the parser keeps it as [::ffff:7f00:1],
 * which the policy could not name either) and a bare ::1 (not a URL host without brackets).
 */
const REFUSED_LOOPBACK: readonly string[] = ['[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '::1', '[::1%25lo]', '[::1%lo]']

const SCHEMES = ['http', 'https', 'ws', 'wss', 'http', 'ws', 'HTTP', 'Ws', 'wSS', 'javascript', 'data', 'file', 'blob', 'ftp', 'mailto', 'about', 'http ', ' http', '']
const SEPARATORS = ['://', '://', '://', ':/', ':', ':///', '://\\', ':\\\\', '//']
const USERINFO = ['', '', '', '', 'user:pw@', 'user@', 'localhost@', '127.0.0.1@', 'evil.com@', '@', ':@', 'a%40b@', 'localhost:8787@', 'evil.com:443@']
const PORTS = ['', '', '', ':8787', ':11434', ':443', ':0', ':65535', ':65536', ':99999', ':-1', ':abc', ':', ':0080', ':8080:8081', ':80abc']
const PATHS = ['', '', '/', '/room', '/api/generate', '/@evil.com', '/x/@localhost', '\\evil.com', '/%2e%2e/evil', '/\u0000', ' /room']
const QUERIES = ['', '', '?t=1', '?@evil.com', '?u=http://evil.com', '?x=\u0000']
const FRAGMENTS = ['', '', '', '#x', '#@evil.com', '#//evil.com/']
const WRAPPERS = ['', '', '', ' ', '\t', '\n', '\r\n', '\u0000', ' ', '​', '﻿', ' ', '  \t ']
/** Characters for a host nobody meant: ASCII, controls, a lone surrogate, an emoji, CJK. */
const JUNK_CHARS = [...'abcxyz019.:/@[]%-_~!$&\'()*+,;= #?\\', '\t', '\n', '\u0000', '\u007f', '\ud800', '😀', '日', 'é']

const junkHost = (g: Gen): string => Array.from({ length: g.int(0, 40) }, () => g.pick(JUNK_CHARS)).join('')
const junkString = (g: Gen): string => Array.from({ length: g.bool(0.05) ? g.int(0, 5000) : g.int(0, 60) }, () => g.pick(JUNK_CHARS)).join('')

/** One host: this machine (half the time), a look-alike off it, one the gate refuses by choice, or junk. */
function host(g: Gen): string {
  const roll = g.next()
  if (roll < 0.4) return g.pick(LOOPBACK_ASCII)
  if (roll < 0.5) return g.pick(LOOPBACK_UNICODE)
  if (roll < 0.85) return g.pick(OFF)
  if (roll < 0.92) return g.pick(REFUSED_LOOPBACK)
  return junkHost(g)
}

/**
 * One URL as an attacker spells it, or (one in twelve) a string that is not one. Each part is plain more often than
 * odd, so that a fair share of the cases (about a fifth) reach the gate's admitted side and every property there runs.
 */
function spelled(g: Gen): string {
  if (g.bool(1 / 12)) return junkString(g)
  const plain = <T>(p: number, usual: T, odd: () => T): T => (g.bool(p) ? usual : odd())
  const wrap = (): string => plain(0.7, '', () => g.pick(WRAPPERS))
  const scheme = plain(0.6, g.pick(['http', 'https', 'ws', 'wss']), () => g.pick(SCHEMES))
  const sep = plain(0.7, '://', () => g.pick(SEPARATORS))
  const user = plain(0.7, '', () => g.pick(USERINFO))
  return `${wrap()}${scheme}${sep}${user}${host(g)}${g.pick(PORTS)}${g.pick(PATHS)}${g.pick(QUERIES)}${g.pick(FRAGMENTS)}${wrap()}`
}

// ---------------------------------------------------------------- the gate

test('loopbackOnly admits exactly http(s)/ws(s) to this machine with no credentials, for every spelling, as that URL\'s origin, a fixed point', () => {
  let admitted = 0
  let refused = 0
  forAll('gate', { seed: 0xa19a, runs: 40_000 }, spelled, (s) => {
    const want = expected(s)
    const got = loopbackOnly(s)
    assert.equal(got, want)
    if (got === null) {
      refused++
      assert.equal(loopbackUrl(s), null)
      return
    }
    admitted++
    const u = loopbackUrl(s)
    assert.ok(u !== null && u.origin === got && u.href === parsed(s)?.href, 'loopbackUrl is the same parse')
    // What came out names this machine, read independently, and goes back in unchanged: the origin is a fixed point.
    assert.ok(thisMachine(new URL(got).hostname), `admitted an address off this machine: ${got}`)
    assert.ok(!got.includes('@'), 'no credentials survive')
    assert.equal(loopbackOnly(got), got)
    assert.equal(loopbackOnly(u.href), got)
    assert.equal(isLoopbackHost(u.hostname), true)
  })
  assert.ok(admitted > 4000 && refused > 4000, `both sides exercised: ${admitted} admitted, ${refused} refused`)
})

test('the spelling tables, pinned in words: every ASCII loopback spelling is admitted, every look-alike refused, the two by-choice refusals refused', () => {
  for (const h of LOOPBACK_ASCII) {
    const o = loopbackOnly(`http://${h}:11434/api/generate`)
    assert.ok(o !== null && thisMachine(new URL(o).hostname), `${JSON.stringify(h)} is this machine; the gate says ${o}`)
    assert.ok(expected(`ws://${h}:8787`) !== null)
  }
  for (const h of OFF) {
    assert.equal(loopbackOnly(`http://${h}:11434`), null, `${JSON.stringify(h)} is not this machine`)
    assert.equal(loopbackOnly(`wss://${h}`), null, JSON.stringify(h))
    assert.equal(expected(`http://${h}:11434`), null, `the oracle agrees about ${JSON.stringify(h)}`)
  }
  for (const h of REFUSED_LOOPBACK) assert.equal(loopbackOnly(`http://${h}:11434`), null, `${JSON.stringify(h)} is refused by choice`)
  // The parser, not a human, decides what a host says: credentials in front of a loopback host are credentials, a
  // loopback host in front of an @ is a user name, and an @ after the path is just a character.
  assert.equal(loopbackOnly('http://evil.com@localhost'), null)
  assert.equal(loopbackOnly('http://localhost@evil.com'), null)
  assert.equal(loopbackOnly('http://localhost:8787@evil.com'), null)
  assert.equal(loopbackOnly('ws://localhost:8787/@evil.com'), 'ws://localhost:8787')
  assert.equal(loopbackOnly('ws://localhost:8787/?@evil.com'), 'ws://localhost:8787')
  assert.equal(loopbackOnly('ws://localhost:8787/#@evil.com'), 'ws://localhost:8787')
  assert.equal(loopbackOnly('http://localhost\\@evil.com'), 'http://localhost', 'a backslash is a slash in a special scheme')
  assert.equal(loopbackOnly('http:///'), null, 'the empty host')
  assert.equal(loopbackOnly('http://localhost:65536'), null, 'a port over the edge is not a URL')
  assert.equal(loopbackOnly('http://localhost:65535'), 'http://localhost:65535')
  assert.equal(loopbackOnly('http://localhost:0'), 'http://localhost:0', 'port 0 parses; the browser cannot connect to it')
})

test('the gate never throws and admits no non-string: junk of every shape is refused in silence', () => {
  forAll('junk', { seed: 0xb22b, runs: 20_000 }, (g) => (g.bool(0.3) ? anyValue(g) : junkString(g)), (v) => {
    for (const f of [loopbackOnly, loopbackServer, netServer]) {
      const r = f(v)
      assert.ok(r === null || typeof r === 'string')
      if (typeof v !== 'string') assert.equal(r, null, 'only a string is an address')
    }
    const u = loopbackUrl(v)
    assert.ok(u === null || u instanceof URL)
    if (typeof v === 'string') assert.equal(typeof isLoopbackHost(v), 'boolean')
  })
})

// ---------------------------------------------------------------- the aliases and the policy

test('loopbackServer is the gate narrowed to http(s) as an origin; netServer to ws(s) at a policy host with its path, and it equals connect-src in both directions', () => {
  const sockets = CONNECT.filter((s) => /^wss?:\/\//.test(s))
  assert.deepEqual([...sockets].sort(), ROOM_HOSTS.flatMap((h) => ['ws', 'wss'].map((p) => `${p}://${h}:*`)).sort())
  forAll('aliases', { seed: 0xc33c, runs: 40_000 }, spelled, (s) => {
    const gate = loopbackOnly(s)
    const u = parsed(s)
    const server = loopbackServer(s)
    const room = netServer(s)
    if (gate === null || u === null) {
      assert.equal(server, null)
      assert.equal(room, null)
      return
    }
    assert.equal(server, u.protocol === 'http:' || u.protocol === 'https:' ? gate : null)
    // The room: what the browser's policy lets a socket reach, and nothing the policy would refuse (another loopback
    // address passes the gate but is refused here, with the reason, rather than by the browser without one).
    const policy = (u.protocol === 'ws:' || u.protocol === 'wss:') && admits(CONNECT, u, null)
    assert.equal(room, policy ? u.href : null, `netServer(${JSON.stringify(s)}) and connect-src disagree`)
    if (room !== null) assert.ok(ROOM_HOSTS.includes(new URL(room).hostname))
  })
})

test('the policy admits nothing off this machine in any directive, and everything a socket may reach the gate admits too', () => {
  for (const name of ['default-src', 'frame-src', 'object-src', 'form-action', 'base-uri']) assert.deepEqual(POLICY.get(name), ["'none'"], name)
  for (const [name, sources] of POLICY) {
    for (const src of sources) {
      assert.notEqual(src, '*', `${name} has a wildcard`)
      assert.doesNotMatch(src, /^(?:https?|wss?):$/, `${name}: a bare web scheme reaches every host`)
      const m = src.match(/^[a-z][a-z0-9+.-]*:\/\/([^/:*]+)/i)
      if (m) assert.ok(thisMachine(m[1].toLowerCase()) && loopbackOnly(src.replace(/:\*$/, '')) !== null, `${name} names ${src}, which is off this machine`)
    }
    if (sources.includes("'unsafe-inline'")) assert.ok(name === 'script-src' || name === 'style-src', `${name} is inline`)
    if (sources.includes("'unsafe-eval'") || sources.includes("'wasm-unsafe-eval'")) assert.equal(name, 'script-src')
    if (sources.includes('data:')) assert.ok(!['script-src', 'worker-src', 'object-src', 'frame-src', 'style-src'].includes(name), `${name} runs data:`)
  }
  // Only connect-src reaches a host at all: an element (img, media, font, style, script, worker) loads nothing off the page.
  for (const [name, sources] of POLICY) if (name !== 'connect-src') assert.ok(!sources.some((s) => s.includes('://')), `${name} names a host`)
  // A build, when present, carries the same policy byte for byte.
  if (existsSync(DIST)) assert.equal(metaOf(readFileSync(DIST, 'utf8')), metaOf(readFileSync(INDEX, 'utf8')), 'dist/index.html carries the same meta')
  forAll('policy', { seed: 0xd44d, runs: 30_000 }, spelled, (s) => {
    const u = parsed(s)
    if (u === null || !admits(CONNECT, u, null)) return
    if (u.protocol === 'data:' || u.protocol === 'blob:') return
    assert.ok(thisMachine(u.hostname), `the policy admits ${u.href}, which is off this machine`)
    if (u.username === '' && u.password === '') assert.notEqual(loopbackOnly(u.href), null, `the policy admits ${u.href} and the gate refuses it`)
  })
})

// ---------------------------------------------------------------- installAirgap

/** A page's global, every primitive a recorder, under one of the origins a page can have. */
function fakeGlobal(location: { origin: string; href: string } | null) {
  const sent: string[] = []
  class Request {
    #url: string
    constructor(url: string) { this.#url = url }
    get url(): string { return this.#url }
  }
  class WebSocket {
    constructor(url: string) { sent.push(`ws ${url}`) }
  }
  class EventSource {
    constructor(url: string) { sent.push(`es ${url}`) }
  }
  class XMLHttpRequest {
    open(_method: string, url: string): void { sent.push(`xhr ${url}`) }
  }
  const g = {
    fetch: async (input: unknown) => { sent.push(`fetch ${input instanceof Request ? input.url : String(input)}`); return new Response('ok') },
    WebSocket, EventSource, XMLHttpRequest, Request,
    importScripts: (...urls: string[]) => { sent.push(`import ${urls.join(' ')}`) },
    location,
  }
  installAirgap(g)
  return { g, sent, Request }
}

const PAGES: readonly ({ origin: string; href: string } | null)[] = [
  { origin: 'http://localhost:4173', href: 'http://localhost:4173/' },
  { origin: 'null', href: 'file:///home/op/dist/index.html' },
  // Not the shipped way: a page served from a host off this machine admits that host as its own origin (documented).
  { origin: 'https://game.example.com', href: 'https://game.example.com/play/index.html' },
  null,
]
const RELATIVE = ['/x', 'x', '?q', '#f', './x', '../x', '//evil.com/x', '//localhost:11434/x', '\\\\evil.com', '\\evil.com', 'data:text/plain,hi', 'blob:http://localhost:4173/0000', 'blob:https://evil.com/0000', 'javascript:alert(1)', 'about:blank']

test('installAirgap hands every primitive exactly what the gate admits resolved against the page, the page\'s own origin and page-made blob: or data:, and refuses the rest with the one sentence', async () => {
  const pages = PAGES.map((location) => ({ location, ...fakeGlobal(location) }))
  const cases: { s: string; page: number }[] = []
  forAll('resolve', { seed: 0xe55e, runs: 6000 }, (g) => ({ s: g.bool(0.25) ? g.pick(RELATIVE) : spelled(g), page: g.int(0, PAGES.length - 1) }), (c) => { cases.push(c) })
  let reached = 0
  for (const [i, { s, page }] of cases.entries()) {
    const { location, g, sent, Request } = pages[page]
    const own = location !== null && location.origin !== 'null' ? location.origin : null
    let r: URL | null
    try {
      r = new URL(s, location?.href)
    } catch {
      r = null
    }
    const ok = r !== null && (r.protocol === 'blob:' || r.protocol === 'data:' || loopbackOnly(r.href) !== null || (own !== null && r.origin === own && WEB.has(r.protocol)))
    const why = `case ${i} on page ${page}: ${JSON.stringify(s)}`
    const off = (e: unknown): boolean => e instanceof TypeError && e.message === refusal(s)
    sent.length = 0
    if (ok && r !== null) {
      reached++
      await g.fetch(s)
      await g.fetch(new Request(s))
      new g.WebSocket(s)
      new g.EventSource(s)
      new g.XMLHttpRequest().open('GET', s)
      g.importScripts('data:text/javascript,1', s)
      assert.deepEqual(sent, [`fetch ${r.href}`, `fetch ${s}`, `ws ${r.href}`, `es ${r.href}`, `xhr ${r.href}`, `import data:text/javascript,1 ${r.href}`], why)
      // Whatever reached a primitive is this machine, the page's own origin, or carries nothing out.
      const reachedUrl = new URL(r.href)
      assert.ok(reachedUrl.protocol === 'blob:' || reachedUrl.protocol === 'data:' || thisMachine(reachedUrl.hostname) || reachedUrl.origin === own, why)
    } else {
      await assert.rejects(g.fetch(s), off, why)
      await assert.rejects(g.fetch(new Request(s)), off, why)
      assert.throws(() => new g.WebSocket(s), off, why)
      assert.throws(() => new g.EventSource(s), off, why)
      assert.throws(() => new g.XMLHttpRequest().open('GET', s), off, why)
      assert.throws(() => g.importScripts('data:text/javascript,1', s), off, why)
      assert.deepEqual(sent, [], `${why}: nothing reached a primitive`)
    }
  }
  assert.ok(reached > 500, `${reached} of ${cases.length} cases reached a primitive`)
  // Off this machine, the page's own origin is the one exception, and only for the page served from it.
  await pages[2].g.fetch('/assets/x.json')
  await assert.rejects(pages[0].g.fetch('https://game.example.com/x'), TypeError)
  await assert.rejects(pages[1].g.fetch('/assets/x.json'), TypeError, 'a page opened from a file has no origin to admit')
  await assert.rejects(pages[3].g.fetch('/assets/x.json'), TypeError, 'a global with no location resolves nothing relative')
})

test('loopbackFetch rejects, never throws, for any spelling, and calls the inner fetch only with what the gate admits', async () => {
  const calls: string[] = []
  const f = loopbackFetch(async (url: string) => { calls.push(url); return new Response('ok') })
  const inputs: string[] = []
  forAll('fetch', { seed: 0xf66f, runs: 3000 }, spelled, (s) => { inputs.push(s) })
  for (const s of inputs) {
    const want = expected(s)
    if (want === null) await assert.rejects(f(s), (e: unknown) => e instanceof TypeError && e.message === refusal(s))
    else await f(s)
  }
  assert.ok(calls.length > inputs.length / 10, `${calls.length} of ${inputs.length} reached the inner fetch`)
  // The inner fetch is given the string as it came (the clients give it `${origin}${path}`, an origin the gate made).
  for (const url of calls) assert.ok(thisMachine(new URL(url.trim()).hostname), url)
})

// ---------------------------------------------------------------- the room client at the gate's edge

test('a socket URL the gate admits but the browser\'s WebSocket refuses (a fragment) comes back from connect as a refusal in words, never a throw, and nothing is sent', () => {
  const opened: string[] = []
  // The browser's constructor: a fragment is a SyntaxError before any connection (RFC 6455 §3; Node's own WebSocket says "Got fragment").
  const open = (url: string): never => {
    opened.push(url)
    if (new URL(url).hash !== '') throw new SyntaxError('The URL contains a fragment identifier')
    throw new Error('no socket is opened in this test')
  }
  forAll('fragment', { seed: 0x1771, runs: 2000 }, (g) => `${g.pick(['ws', 'wss'])}://${g.pick(ROOM_HOSTS)}${g.pick(PORTS.filter((p) => /^:\d{1,4}$/.test(p) || p === ''))}${g.pick(PATHS.filter((p) => !p.includes('\u0000') && !p.startsWith(' ')))}${g.pick(['#x', '#@evil.com', '#'])}`, (url) => {
    const c = createNetClient({ open })
    const why = c.connect(url, 'token-1', 'ada', 'city/1337/36')
    assert.equal(typeof why, 'string', `connect(${url}) must answer in words`)
    assert.equal(c.status, 'idle')
    if (netServer(url) !== null) assert.match(why as string, /^cannot open: /, 'the browser\'s refusal, carried back')
    for (const u of opened) assert.ok(ROOM_HOSTS.includes(new URL(u).hostname), 'only ever a policy host')
  })
})
