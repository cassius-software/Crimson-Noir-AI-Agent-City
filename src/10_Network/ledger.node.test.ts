/**
 * Why does this file exist? It proves the ledger door (ledger.node.ts) over real loopback sockets, with Node's own
 * WebSocket as the client:
 * - A runtime's ledger verifies, and another runtime of the same configuration fetches the verified weights, sealed.
 * - The door needs a token exactly as the room does, is shut when the host has no pinned digest, and leaves the room's
 *   own protocol going to the room.
 * - A forged seal, a replayed envelope, a binary frame and a broken ledger each end the session with 4008. Nothing they
 *   sent is ever kept.
 * - A session ends with its token.
 * - Thousands of malformed and mutated messages never bring the host down, and a good ledger still verifies after them.
 * What breaks if it is removed? The door could stop refusing what the ledger check refuses, or keep what it should not.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../02_Define_The_Rules/integrity.ts'
import { LEARN, LEDGER_GENESIS, LEDGER_SUBPROTOCOL, link, WIPE, type EntryBody } from './ledger.ts'
import { planeAuthority } from './plane.node.ts'
import { AUTH_PREFIX, SUBPROTOCOL } from './replication.ts'
import { startHost, type Host, type HostOptions } from './replication.node.ts'

const OS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crimson_noir_os')
const CANONICAL = readFileSync(join(OS, 'containment.canonical'), 'utf8')
const PINNED = sha256(CANONICAL)
const SECRET = 'ledger-test-secret-sixteen+'
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** lowbias32, as crimson_noir_os's hash.rs: a deterministic stream of test data. */
function mix32(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0
  x = Math.imul(x, 0x7feb352d) >>> 0
  x = (x ^ (x >>> 15)) >>> 0
  x = Math.imul(x, 0x846ca68b) >>> 0
  return (x ^ (x >>> 16)) >>> 0
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let t = 0; t < 4000; t += 10) {
    if (cond()) return
    await sleep(10)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

const host = (o: Partial<HostOptions> = {}): Promise<Host> => startHost({ secret: SECRET, tickHz: 50, authority: planeAuthority(), ledgerLock: PINNED, ...o })

const mac = (key: string, n: number, body: unknown): string => createHmac('sha256', key).update(canonical({ n, body }), 'utf8').digest('hex')

/** A ledger client: every message the host sends is opened and its seal and number checked before it is recorded. */
interface LedgerClient {
  ws: WebSocket
  got: Record<string, unknown>[]
  closed: Promise<{ code: number; reason: string }>
  send(body: unknown, n?: number): void
  next(t: string, from?: number): Promise<Record<string, unknown>>
}

async function open(h: Host, subject: string, token = h.token(subject)): Promise<LedgerClient> {
  const ws = new WebSocket(h.url, [LEDGER_SUBPROTOCOL, AUTH_PREFIX + token])
  const got: Record<string, unknown>[] = []
  let received = 0
  let sent = 0
  const closed = new Promise<{ code: number; reason: string }>((r) => { ws.onclose = (ev) => r({ code: ev.code, reason: ev.reason }) })
  ws.onmessage = (ev) => {
    const env = JSON.parse(String(ev.data)) as { n: number; body: Record<string, unknown>; mac: string }
    assert.equal(env.mac, mac(token, env.n, env.body), 'the host seals under the session token')
    assert.ok(env.n > received, 'the host numbers rise')
    received = env.n
    got.push(env.body)
  }
  await new Promise<void>((r, j) => { ws.onopen = () => r(); ws.onerror = () => j(new Error('socket error')) })
  assert.equal(ws.protocol, LEDGER_SUBPROTOCOL)
  return {
    ws, got, closed,
    send: (body, n = ++sent) => ws.send(JSON.stringify({ n, body, mac: mac(token, n, body) })),
    next: async (t, from = 0) => {
      let found: Record<string, unknown> | undefined
      await until(() => { found = got.slice(from).find((m) => m.t === t); return found !== undefined }, `a '${t}' message`)
      return found!
    },
  }
}

/** A ledger of `n` learn entries by couriers (and a wipe), chained, with the weights it folds to. */
function ledger(n: number, salt = 0): { entries: (number | string)[][]; head: string; weights: Int32Array } {
  const weights = new Int32Array(4096 * 8)
  const entries: (number | string)[][] = []
  let head = LEDGER_GENESIS
  for (let k = 0; k < n; k++) {
    const h = mix32(k ^ salt)
    const body: EntryBody = k === 3
      ? [WIPE, k, 7, 0, 0]
      : [LEARN, k, h % 3072, (h >>> 12) % 8, Math.floor((1 << 22) / (((h >>> 3) % (1 << 20)) + 64))]
    head = link(body, head)
    entries.push([...body, head])
    const row = body[2] * 8
    if (body[0] === LEARN) weights[row + body[3]] = (weights[row + body[3]] + (((body[4] - weights[row + body[3]]) | 0) >> 3)) | 0
    else weights.fill(0, row, row + 8)
  }
  return { entries, head, weights }
}

const digestOf = (w: Int32Array): string => {
  const p: [number, number][] = []
  for (let i = 0; i < w.length; i++) if (w[i] !== 0) p.push([i, w[i]])
  return sha256(canonical(p))
}

async function sendLedger(c: LedgerClient, l: ReturnType<typeof ledger>): Promise<Record<string, unknown>> {
  c.send({ t: 'hello', v: 1, config: CANONICAL })
  const ready = await c.next('ready')
  assert.equal(ready.digest, PINNED)
  for (let i = 0; i < l.entries.length; i += 64) c.send({ t: 'entries', list: l.entries.slice(i, i + 64) })
  c.send({ t: 'seal', head: l.head, count: l.entries.length, weights: digestOf(l.weights) })
  return c.next('verified')
}

test('a ledger verifies, and another runtime fetches the verified weights', async () => {
  const h = await host()
  try {
    const l = ledger(1000)
    const a = await open(h, 'runtime-a')
    const v = await sendLedger(a, l)
    assert.deepEqual([v.head, v.count, v.weights], [l.head, 1000, digestOf(l.weights)])
    // The fleet: a second runtime of the same configuration takes the verified weights, in sealed chunks.
    const b = await open(h, 'runtime-b')
    b.send({ t: 'hello', v: 1, config: CANONICAL })
    await b.next('ready')
    b.send({ t: 'fetch' })
    const end = await b.next('end')
    const got = new Int32Array(4096 * 8)
    for (const m of b.got.filter((x) => x.t === 'weights')) for (const [i, w] of m.list as [number, number][]) got[i] = w
    assert.deepEqual([end.head, end.count, end.weights], [l.head, 1000, digestOf(l.weights)])
    assert.deepEqual(got, l.weights, 'the fetched weights are the verified ones, every one')
    assert.deepEqual(h.ledger(), { sessions: 2, verified: 1, refused: 0, fetched: 1 })
    a.ws.close()
    b.ws.close()
  } finally {
    await h.close()
  }
})

test('the door needs a token, is shut without a pinned digest, and the room keeps its own protocol', async () => {
  const shut = await host({ ledgerLock: undefined })
  const forged = await host()
  try {
    assert.equal(shut.ledger(), null)
    const refused = (url: string, protocols: string[]): Promise<boolean> =>
      new Promise((r) => { const ws = new WebSocket(url, protocols); ws.onopen = () => { ws.close(); r(false) }; ws.onerror = () => r(true) })
    assert.ok(await refused(shut.url, [LEDGER_SUBPROTOCOL, AUTH_PREFIX + shut.token('x')]), 'no pinned digest: no door')
    assert.ok(await refused(forged.url, [LEDGER_SUBPROTOCOL, `${AUTH_PREFIX}forged`]), 'a forged token: 401')
    assert.ok(await refused(forged.url, [LEDGER_SUBPROTOCOL]), 'no token: 401')
    assert.equal(forged.stats().unauthorized, 2)
    // Offering the room's protocol goes to the room, whatever else is offered.
    const ws = new WebSocket(forged.url, [SUBPROTOCOL, LEDGER_SUBPROTOCOL, AUTH_PREFIX + forged.token('player')])
    await new Promise<void>((r) => { ws.onopen = () => r() })
    assert.equal(ws.protocol, SUBPROTOCOL)
    ws.close()
  } finally {
    await shut.close()
    await forged.close()
  }
})

test('a forged seal, a replay, a binary frame and a broken ledger each end the session, and nothing is kept', async () => {
  const h = await host()
  try {
    const cases: [string, (c: LedgerClient) => void, RegExp][] = [
      ['forged seal', (c) => c.ws.send(JSON.stringify({ n: 1, body: { t: 'hello', v: 1, config: CANONICAL }, mac: '0'.repeat(64) })), /bad seal/],
      ['replay', (c) => { c.send({ t: 'hello', v: 1, config: CANONICAL }, 5); c.send({ t: 'fetch' }, 5) }, /replayed/],
      ['binary', (c) => c.ws.send(new Uint8Array([1, 2, 3])), /binary/],
      ['other configuration', (c) => c.send({ t: 'hello', v: 1, config: CANONICAL.replace('= 3;', '= 4;') }), /pinned/],
      ['sentry learning', (c) => {
        c.send({ t: 'hello', v: 1, config: CANONICAL })
        const body: EntryBody = [LEARN, 1, 3500, 0, 100]
        c.send({ t: 'entries', list: [[...body, link(body, LEDGER_GENESIS)]] })
      }, /never declared with learn/],
      ['seal that lies', (c) => {
        const l = ledger(10)
        c.send({ t: 'hello', v: 1, config: CANONICAL })
        c.send({ t: 'entries', list: l.entries })
        c.send({ t: 'seal', head: l.head, count: 10, weights: sha256('not the fold') })
      }, /not the fold/],
    ]
    for (const [name, act, why] of cases) {
      const c = await open(h, `case-${name}`)
      act(c)
      const { code } = await c.closed
      assert.equal(code, 4008, name)
      const refused = c.got.find((m) => m.t === 'refused')
      assert.ok(refused && why.test(String(refused.reason)), `${name}: ${JSON.stringify(c.got)}`)
    }
    // None of them left anything to fetch.
    const f = await open(h, 'fetcher')
    f.send({ t: 'hello', v: 1, config: CANONICAL })
    await f.next('ready')
    f.send({ t: 'fetch' })
    await f.next('none')
    f.ws.close()
    assert.equal(h.ledger()?.verified, 0)
  } finally {
    await h.close()
  }
})

test('a session ends with its token', async () => {
  let t = 1_000_000
  const h = await host({ now: () => t })
  try {
    const c = await open(h, 'brief', h.token('brief', 2000))
    t += 2500
    const { code } = await c.closed
    assert.equal(code, 4003)
  } finally {
    await h.close()
  }
})

test('malformed and mutated messages never bring the host down, and a good ledger verifies after them', async () => {
  const h = await host()
  try {
    const good = ledger(200, 77)
    let seed = 0x5eed
    const rnd = (): number => (seed = mix32(seed + 0x9e3779b9))
    // Mutations of each field of a good session's messages, and noise.
    const mutate = (v: unknown): unknown => {
      const k = rnd() % 9
      if (k === 0) return null
      if (k === 1) return rnd()
      if (k === 2) return -1
      if (k === 3) return 'x'.repeat(rnd() % 50)
      if (k === 4) return [v, v]
      if (k === 5) return 1e300
      if (k === 6) return { t: 'entries', list: [v] }
      if (k === 7) return Array.isArray(v) ? v.slice(1) : v
      return v
    }
    for (let session = 0; session < 40; session++) {
      const c = await open(h, `fuzz-${session}`)
      c.send({ t: 'hello', v: 1, config: rnd() % 4 === 0 ? CANONICAL.slice(rnd() % CANONICAL.length) : CANONICAL })
      for (let k = 0; k < 30; k++) {
        const e = good.entries[rnd() % good.entries.length].map((x) => (rnd() % 4 === 0 ? mutate(x) : x))
        const pick = rnd() % 6
        if (pick === 0) c.send({ t: 'entries', list: [e] })
        else if (pick === 1) c.send(mutate({ t: 'seal', head: good.head, count: 200, weights: digestOf(good.weights) }))
        else if (pick === 2) c.ws.send(String(rnd()).repeat(rnd() % 5))
        else if (pick === 3) c.send({ t: 'fetch' })
        else if (pick === 4) c.send({ t: String(rnd()) })
        else c.send({ t: 'entries', list: [mutate(e)] })
      }
      c.ws.close()
    }
    await until(() => h.ledger()?.sessions === 0, 'every fuzzed session closed')
    const after = h.ledger()!
    assert.ok(after.refused >= 30, `the fuzz was refused, not ignored: ${JSON.stringify(after)}`)
    assert.equal(after.verified, 0, 'no mutated ledger verified')
    // The host is up and still verifies a good ledger.
    const c = await open(h, 'after')
    const v = await sendLedger(c, good)
    assert.equal(v.head, good.head)
    c.ws.close()
  } finally {
    await h.close()
  }
})
