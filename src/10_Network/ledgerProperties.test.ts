/**
 * Why does this file exist? It is the property-based fuzzing of the ledger door (ledger.ts, ledger.node.ts) over real
 * loopback sockets, seeded and replayable (02_Define_The_Rules/property.ts), from the attacker's side of a `crimson.1`
 * session. Where ledger.node.test.ts pins a handful of hand-written cases, this generates random VALID ledgers of the
 * OS's own configuration and holds three properties over hundreds of them:
 * - Soundness over randomness: every valid random ledger verifies, the host's `verified` names its head, count and
 *   weights digest, and a second runtime fetches exactly the weights it left (sealed, chunked).
 * - The fold is the same arithmetic both ends compute: the weights the door seals equal the ledger.ts fold of the same
 *   entries, which equal the independent fold this file keeps as it builds each ledger (the i32 shift the kernel does).
 * - No single mutation slips through: one field of one entry, or the hash of one link, or the seal's head/count/weights
 *   nudged — each by the shared `mutate` or by a targeted change — is refused with 4008, and nothing is kept.
 * It drives the door through the same sealed WebSocket a runtime uses, so a rule that holds in ledger.ts but is not
 * reached by ledger.node.ts (a chunk boundary, a reorder, a mutation that still parses) is covered here too.
 * What breaks if it is removed? A valid ledger the hand-written cases never shaped could fail to verify, or a mutation
 * they never tried could verify, and nothing would catch it.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { canonical, sha256 } from '../02_Define_The_Rules/integrity.ts'
import { gen, type Gen, mutate } from '../02_Define_The_Rules/property.ts'
import {
  admit, begin, LEARN, LEDGER_CHUNK, LEDGER_GENESIS, LEDGER_SUBPROTOCOL, link, newSession, pairs, producible, REWARD_MAX, REWARD_MIN, roleOf, WIPE,
  type CrimsonConfig, type EntryBody,
} from './ledger.ts'
import { planeAuthority } from './plane.node.ts'
import { AUTH_PREFIX } from './replication.ts'
import { startHost, type Host, type HostOptions } from './replication.node.ts'

const OS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'crimson_noir_os')
const CANONICAL = readFileSync(join(OS, 'containment.canonical'), 'utf8')
const PINNED = sha256(CANONICAL)
const SECRET = 'ledger-properties-secret-16+'
const CAPACITY = 4096
const STATIONS = 8
const LEARN_SHIFT = 3
const COURIERS = 3072 // slots 0..3071 hold the only role declared with learn.
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const mac = (key: string, n: number, body: unknown): string => createHmac('sha256', key).update(canonical({ n, body }), 'utf8').digest('hex')

const host = (o: Partial<HostOptions> = {}): Promise<Host> => startHost({ secret: SECRET, tickHz: 50, authority: planeAuthority(), ledgerLock: PINNED, ...o })

async function until(cond: () => boolean, what: string, ms = 8000): Promise<void> {
  for (let t = 0; t < ms; t += 5) {
    if (cond()) return
    await sleep(5)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

interface LedgerClient {
  ws: WebSocket
  got: Record<string, unknown>[]
  closed: Promise<{ code: number; reason: string }>
  send(body: unknown, n?: number): void
  raw(wire: string): void
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
  return {
    ws, got, closed,
    send: (body, n = ++sent) => ws.send(JSON.stringify({ n, body, mac: mac(token, n, body) })),
    raw: (wire) => ws.send(wire),
    next: async (t, from = 0) => {
      let found: Record<string, unknown> | undefined
      await until(() => { found = got.slice(from).find((m) => m.t === t); return found !== undefined }, `a '${t}' message`)
      return found!
    },
  }
}

/** A valid ledger of the OS's configuration, with the weights it folds to, built as the kernel would fold them. */
interface Built {
  entries: (number | string)[][]
  head: string
  count: number
  weights: Int32Array
  config: CrimsonConfig
}

/** A reward the kernel can produce, drawn so the generator never wastes a case on an impossible one. */
function producibleReward(g: Gen): number {
  for (;;) {
    const clock = g.int(0, 1 << 20)
    const r = Math.floor((1 << 22) / (clock + 64))
    if (producible(r)) return r
  }
}

/** A random valid ledger: learns by couriers at real stations for producible rewards, and wipes, ticks never falling. */
function buildLedger(g: Gen, n: number): Built {
  const s = newSession()
  const begun = begin(s, CANONICAL, PINNED)
  assert.ok(begun.ok, begun.ok ? '' : begun.reason)
  const weights = new Int32Array(CAPACITY * STATIONS)
  const entries: (number | string)[][] = []
  let head = LEDGER_GENESIS
  let tick = 0
  for (let k = 0; k < n; k++) {
    tick += g.int(0, 3)
    const agent = g.int(0, COURIERS - 1)
    const body: EntryBody = g.bool(0.85)
      ? [LEARN, tick, agent, g.int(0, STATIONS - 1), producibleReward(g)]
      : [WIPE, tick, agent, 0, 0]
    head = link(body, head)
    entries.push([...body, head])
    // The independent fold, the kernel's i32 arithmetic (ledger.ts admit mirrors this).
    const row = body[2] * STATIONS
    if (body[0] === LEARN) {
      const w = weights[row + body[3]]
      weights[row + body[3]] = (w + (((body[4] - w) | 0) >> LEARN_SHIFT)) | 0
    } else weights.fill(0, row, row + STATIONS)
    // The door's own admit must take every entry we build (the generator and the rules agree).
    const a = admit(s, entries[k])
    assert.ok(a.ok, `entry ${k} the generator built was refused: ${a.ok ? '' : a.reason}`)
  }
  assert.deepEqual(s.weights, weights, 'the door fold equals the independent fold')
  assert.equal(s.head, head)
  return { entries, head, count: n, weights, config: begun.value }
}

const digestOf = (w: Int32Array): string => sha256(canonical(pairs(w)))

async function submit(c: LedgerClient, b: Built, chunk = LEDGER_CHUNK): Promise<void> {
  c.send({ t: 'hello', v: 1, config: CANONICAL })
  const ready = await c.next('ready')
  assert.equal(ready.digest, PINNED)
  for (let i = 0; i < b.entries.length; i += chunk) c.send({ t: 'entries', list: b.entries.slice(i, i + chunk) })
  c.send({ t: 'seal', head: b.head, count: b.count, weights: digestOf(b.weights) })
}

test('random valid ledgers verify, the door fold is the TypeScript fold, and a fresh runtime fetches exactly those weights', { timeout: 120_000 }, async () => {
  const h = await host()
  try {
    const g = gen(0x1ed6e401)
    for (let i = 0; i < 60; i++) {
      const b = buildLedger(g, g.int(1, 600))
      const chunk = g.pick([1, 7, 64]) // chunk boundaries the hand-written cases do not vary.
      const a = await open(h, `rt-a-${i}`)
      await submit(a, b, chunk)
      const v = await a.next('verified')
      assert.deepEqual([v.head, v.count, v.weights], [b.head, b.count, digestOf(b.weights)], `seed case ${i}: the verdict names this ledger`)
      a.ws.close()
      // The fleet sync: a fresh runtime fetches the weights just verified, every pair, sealed.
      const f = await open(h, `rt-b-${i}`)
      f.send({ t: 'hello', v: 1, config: CANONICAL })
      await f.next('ready')
      f.send({ t: 'fetch' })
      const end = await f.next('end')
      const fetched = new Int32Array(CAPACITY * STATIONS)
      for (const m of f.got.filter((x) => x.t === 'weights')) for (const [idx, w] of m.list as [number, number][]) fetched[idx] = w
      assert.deepEqual([end.head, end.count, end.weights], [b.head, b.count, digestOf(b.weights)], `seed case ${i}: the end names this ledger`)
      assert.deepEqual(fetched, b.weights, `seed case ${i}: the fetched weights are the verified ones, every pair`)
      f.ws.close()
    }
    assert.equal(h.ledger()?.verified, 60, 'every random ledger verified')
    assert.equal(h.ledger()?.refused, 0, 'none was refused')
  } finally {
    await h.close()
  }
})

/** The seal of a valid ledger: head, count and the weights digest. */
const sealOf = (b: Built): Record<string, unknown> => ({ head: b.head, count: b.count, weights: digestOf(b.weights) })

test('no single mutation of a valid ledger verifies: a field of one entry, a link, or the seal', { timeout: 120_000 }, async () => {
  const h = await host()
  try {
    const g = gen(0x5a1ad)
    let refused = 0
    for (let i = 0; i < 90; i++) {
      // A small ledger, so a mutation lands often and a session is cheap.
      const b = buildLedger(g, g.int(2, 40))
      const roll = g.int(0, 4)
      const c = await open(h, `mut-${i}`)
      c.send({ t: 'hello', v: 1, config: CANONICAL })
      await c.next('ready')
      if (roll <= 2) {
        // One field of one entry, or its whole hash, changed; the rest of the chain sent as it was.
        const k = g.int(0, b.entries.length - 1)
        const entries = b.entries.map((e) => [...e])
        const field = roll === 2 ? 5 : g.int(0, 4) // 5 is the hash.
        const before = entries[k][field]
        if (field === 5) entries[k][field] = sha256(`mutated ${g.next()}`)
        else entries[k][field] = (mutate(before, g) as number)
        // Skip the rare no-op (a number mutated to itself, or a kind that stays in range and still links by luck).
        if (JSON.stringify(entries[k]) === JSON.stringify(b.entries[k])) { c.ws.close(); continue }
        for (let j = 0; j < entries.length; j += LEDGER_CHUNK) c.send({ t: 'entries', list: entries.slice(j, j + LEDGER_CHUNK) })
        c.send({ t: 'seal', ...sealOf(b) })
      } else {
        // The entries sent whole and valid, the seal mutated: head, count or the weights digest.
        for (let j = 0; j < b.entries.length; j += LEDGER_CHUNK) c.send({ t: 'entries', list: b.entries.slice(j, j + LEDGER_CHUNK) })
        const s = sealOf(b)
        const key = g.pick(['head', 'count', 'weights'] as const)
        s[key] = key === 'count' ? (s.count as number) + g.pick([-1, 1, 2]) : sha256(`other ${key} ${g.next()}`)
        if (key === 'count' && (s.count as number) === b.count) { c.ws.close(); continue }
        c.send({ t: 'seal', ...s })
      }
      const { code } = await c.closed
      assert.equal(code, 4008, `case ${i} (roll ${roll}): a mutation closed the session`)
      const refusal = c.got.find((m) => m.t === 'refused')
      assert.ok(refusal, `case ${i}: a mutation earned a sealed refusal: ${JSON.stringify(c.got).slice(0, 300)}`)
      assert.ok(c.got.every((m) => m.t !== 'verified'), `case ${i}: a mutation must not verify`)
      refused++
    }
    assert.ok(refused > 60, `most mutations were real and refused (${refused}/90)`)
    assert.equal(h.ledger()?.verified, 0, 'no mutated ledger verified')
    // The door still verifies a clean ledger after all of it.
    const clean = buildLedger(g, 120)
    const c = await open(h, 'clean-after')
    await submit(c, clean)
    assert.equal((await c.next('verified')).head, clean.head)
    c.ws.close()
  } finally {
    await h.close()
  }
})

test('the generator only ever builds rewards the kernel can produce, by couriers, at the world\'s stations', () => {
  const g = gen(0xc0de)
  for (let i = 0; i < 2000; i++) {
    const r = producibleReward(g)
    assert.ok(producible(r) && r >= REWARD_MIN && r <= REWARD_MAX, `reward ${r}`)
  }
  const b = buildLedger(g, 300)
  for (const e of b.entries) {
    const [kind, , agent, station, reward] = e as [number, number, number, number, number, string]
    assert.ok(agent < COURIERS && roleOf(b.config, agent)?.caps.includes('learn'), `agent ${agent} learns`)
    if (kind === LEARN) assert.ok(station < STATIONS && producible(reward), `entry ${JSON.stringify(e)}`)
  }
})
