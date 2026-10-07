/**
 * Why does this file exist? It is the one proof of what "this machine" means to the page, and the guard that holds
 * the page to it. `loopbackOnly` is the gate every client in the product asks before it addresses anything: an
 * http(s) or ws(s) URL to localhost, 127.0.0.0/8 or [::1], with no user name or password, gives its origin; anything
 * else gives null. `loopbackServer` (the model and speech clients) and `netServer` (the room client) are thin
 * aliases of it, so there is exactly one definition to read and to test. `installAirgap` is the containment: it
 * replaces every outbound primitive of a global object (fetch, WebSocket, XMLHttpRequest, EventSource, importScripts)
 * with a version that refuses, in one plain sentence, any URL that is not loopback, the page's own origin, or a
 * blob: or data: URL the page itself made; removes RTCPeerConnection, WebTransport and navigator.sendBeacon
 * outright; and then freezes those properties, so a script injected into the page (an operator `run` script shares
 * the page's global object) cannot put the originals back. It is pure: no import, no I/O of its own, and it can be
 * installed on a fake global in a Node test. main.tsx installs it on the page's global before anything else runs,
 * and physics.worker.ts on the worker's own.
 * What breaks if it is removed? Three clients would each carry their own idea of "this machine", and nothing would
 * stop a script on the page from opening a connection off it.
 */

/** The protocols the page may speak at all. */
const PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/** A host that is this machine: localhost, 127.0.0.0/8 (any spelling the URL parser reduces to it) or [::1]. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  if (host === 'localhost' || host === '[::1]') return true
  const octets = host.split('.')
  return octets.length === 4 && octets[0] === '127' && octets.every((o) => /^(?:0|[1-9]\d{0,2})$/.test(o) && Number(o) <= 255)
}

/**
 * The URL parsed, if the page may address it: http, https, ws or wss, a loopback host, no user name or password.
 * Null for anything else. Every other function here is defined in terms of this one.
 */
export function loopbackUrl(url: unknown): URL | null {
  if (typeof url !== 'string') return null
  let u: URL
  try {
    u = new URL(url.trim())
  } catch {
    return null
  }
  if (!PROTOCOLS.has(u.protocol)) return null
  if (u.username || u.password) return null
  return isLoopbackHost(u.hostname) ? u : null
}

/**
 * The origin of a URL on this machine ("http://localhost:11434", "ws://127.0.0.1:8787"), or null: the gate every
 * client asks before anything is sent.
 */
export function loopbackOnly(url: unknown): string | null {
  return loopbackUrl(url)?.origin ?? null
}

/**
 * A model or speech server's address as an origin, if it is on this machine: http or https only. Paths are dropped:
 * the API's own paths are added to the origin.
 */
export function loopbackServer(url: unknown): string | null {
  const u = loopbackUrl(url)
  return u !== null && (u.protocol === 'http:' || u.protocol === 'https:') ? u.origin : null
}

/**
 * The hosts the page's content security policy lets a socket reach (index.html connect-src: `localhost` and
 * `127.0.0.1`, any port). A room is joined only at one of them: another loopback address passes the gate above but the
 * browser would refuse the socket with an error the player cannot read, so it is refused here, with the reason.
 */
export const ROOM_HOSTS: readonly string[] = Object.freeze(['localhost', '127.0.0.1'])

/** A room host's address, path included, if it is on this machine and the page's policy reaches it: ws or wss only. */
export function netServer(url: unknown): string | null {
  const u = loopbackUrl(url)
  return u !== null && (u.protocol === 'ws:' || u.protocol === 'wss:') && ROOM_HOSTS.includes(u.hostname) ? u.href : null
}

/** The one sentence every refusal is. */
export function refusal(url: string): string {
  return `${url} is not on this machine: the page addresses only localhost, 127.0.0.0/8 or [::1]`
}

/** The shape of the fetch the clients take (the page's own, or a stand-in in the tests). */
type FetchShape = (url: string, init?: RequestInit) => Promise<Response>

/**
 * A fetch that only ever reaches this machine: the URL goes through loopbackOnly first, and anything else rejects with
 * the refusal before `fetchFn` is called. The clients are built over this, so each prompt or line of speech is held
 * to loopback twice: by the client's own check and by this wrapper.
 */
export function loopbackFetch<F extends FetchShape>(fetchFn: F): F {
  const guarded = (url: string, init?: RequestInit): Promise<Response> =>
    loopbackOnly(url) === null ? Promise.reject(new TypeError(refusal(String(url)))) : fetchFn(url, init)
  return guarded as F
}

/** What `installAirgap` finds on a global object. Every member is optional: a worker has no RTCPeerConnection, a fake has what the test gives it. */
export interface AirgapGlobal {
  fetch?: unknown
  WebSocket?: unknown
  XMLHttpRequest?: unknown
  EventSource?: unknown
  RTCPeerConnection?: unknown
  webkitRTCPeerConnection?: unknown
  WebTransport?: unknown
  importScripts?: unknown
  Request?: unknown
  navigator?: object | null
  location?: { origin?: string; href?: string } | null
}

/** What `installAirgap` did: the origin it treats as the page's own, the primitives it guarded and those it removed. */
export interface AirgapReport {
  readonly own: string | null
  readonly guarded: readonly string[]
  readonly removed: readonly string[]
}

const installed = new WeakMap<object, AirgapReport>()

/** Defines `name` on `o` as a value that cannot be written, deleted or redefined, keeping its enumerability. */
function fix(o: object, name: string, value: unknown): void {
  const was = Object.getOwnPropertyDescriptor(o, name)
  Object.defineProperty(o, name, { value, writable: false, configurable: false, enumerable: was?.enumerable ?? false })
}

/** A constructor's own statics (WebSocket.OPEN and the like), not its prototype, length or name. */
function statics(from: object): PropertyDescriptorMap {
  const out: PropertyDescriptorMap = {}
  for (const key of Reflect.ownKeys(from)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue
    const d = Object.getOwnPropertyDescriptor(from, key)
    if (d) out[key as string] = d
  }
  return out
}

/**
 * Holds `g` to this machine. Returns what it did, and the same report again if it was already installed on `g`.
 * `g` is the page's global (window) or a worker's (self); a plain object with the same members works in a test.
 */
export function installAirgap(g: AirgapGlobal): AirgapReport {
  const done = installed.get(g)
  if (done) return done
  const guarded: string[] = []
  const removed: string[] = []
  const loc = g.location
  const base = typeof loc?.href === 'string' ? loc.href : undefined
  const own = typeof loc?.origin === 'string' && loc.origin !== 'null' && loc.origin !== '' ? loc.origin : null

  /** The URL as a string the primitive may be given, or a TypeError with the refusal. A page-made blob: or data: URL carries nothing out. */
  const admit = (url: unknown): string => {
    const s = typeof url === 'string' ? url : String(url)
    let u: URL
    try {
      u = new URL(s, base)
    } catch {
      throw new TypeError(refusal(s))
    }
    if (u.protocol === 'blob:' || u.protocol === 'data:') return u.href
    if (loopbackOnly(u.href) !== null) return u.href
    if (own !== null && u.origin === own && PROTOCOLS.has(u.protocol)) return u.href
    throw new TypeError(refusal(s))
  }

  // A Request's URL is read through the getter captured now, so a later change to Request.prototype cannot lie about it.
  const requestProto = typeof g.Request === 'function' ? (g.Request as { prototype?: object }).prototype : undefined
  const requestUrl = requestProto ? Object.getOwnPropertyDescriptor(requestProto, 'url')?.get : undefined
  const urlOfRequest = (input: unknown): string | null => {
    if (!requestUrl || typeof input !== 'object' || input === null) return null
    try {
      const u = requestUrl.call(input)
      return typeof u === 'string' ? u : null
    } catch {
      return null
    }
  }

  if (typeof g.fetch === 'function') {
    const real = g.fetch as (this: unknown, input: unknown, init?: unknown) => Promise<unknown>
    const fetch = function (this: unknown, input: unknown, init?: unknown): Promise<unknown> {
      try {
        const asRequest = urlOfRequest(input)
        if (asRequest !== null) {
          admit(asRequest)
          return real.call(g, input, init)
        }
        return real.call(g, admit(input), init)
      } catch (e) {
        return Promise.reject(e)
      }
    }
    fix(g, 'fetch', fetch)
    guarded.push('fetch')
  }

  const guardConstructor = (name: 'WebSocket' | 'EventSource'): void => {
    const Real = g[name]
    if (typeof Real !== 'function') return
    const proto = (Real as { prototype?: object }).prototype
    const Guarded = function (this: unknown, url: unknown, ...rest: unknown[]): object {
      if (new.target === undefined) throw new TypeError(`${name} must be called with new`)
      return Reflect.construct(Real as new (...a: unknown[]) => object, [admit(url), ...rest], new.target)
    }
    Object.defineProperties(Guarded, statics(Real))
    if (proto) {
      Object.defineProperty(Guarded, 'prototype', { value: proto, writable: false, configurable: false, enumerable: false })
      // The original is not reachable through the prototype either.
      if (Object.getOwnPropertyDescriptor(proto, 'constructor')?.configurable) fix(proto, 'constructor', Guarded)
    }
    fix(g, name, Guarded)
    guarded.push(name)
  }
  guardConstructor('WebSocket')
  guardConstructor('EventSource')

  if (typeof g.XMLHttpRequest === 'function') {
    const proto = (g.XMLHttpRequest as { prototype?: { open?: unknown } }).prototype
    const realOpen = proto?.open
    if (proto && typeof realOpen === 'function') {
      const open = function (this: unknown, method: unknown, url: unknown, ...rest: unknown[]): unknown {
        return (realOpen as (this: unknown, ...a: unknown[]) => unknown).call(this, method, admit(url), ...rest)
      }
      fix(proto, 'open', open)
    }
    fix(g, 'XMLHttpRequest', g.XMLHttpRequest)
    guarded.push('XMLHttpRequest')
  }

  if (typeof g.importScripts === 'function') {
    const real = g.importScripts as (this: unknown, ...urls: unknown[]) => unknown
    const importScripts = function (this: unknown, ...urls: unknown[]): unknown {
      return real.call(g, ...urls.map(admit))
    }
    fix(g, 'importScripts', importScripts)
    guarded.push('importScripts')
  }

  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport'] as const) {
    if (g[name] === undefined) continue
    try {
      delete g[name]
    } catch {
      // not deletable: it is overwritten below
    }
    fix(g, name, undefined)
    removed.push(name)
  }

  const nav = g.navigator
  if (nav && typeof nav === 'object' && 'sendBeacon' in nav) {
    // The method lives on the prototype (Navigator.prototype), not the instance: it is taken off wherever it is found.
    for (let o: object | null = nav; o !== null; o = Object.getPrototypeOf(o)) {
      if (Object.prototype.hasOwnProperty.call(o, 'sendBeacon')) {
        try {
          delete (o as { sendBeacon?: unknown }).sendBeacon
        } catch {
          // not deletable: the instance shadows it below
        }
      }
    }
    fix(nav, 'sendBeacon', undefined)
    removed.push('navigator.sendBeacon')
  }

  const report: AirgapReport = Object.freeze({ own, guarded: Object.freeze(guarded), removed: Object.freeze(removed) })
  installed.set(g, report)
  return report
}
