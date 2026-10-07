/**
 * Why does this file exist? It is the adversarial campaign over the telemetry pipeline (telemetry.ts), seeded and
 * replayable (02_Define_The_Rules/property.ts): 64 edge actors, one per car ring, sample their pose from the
 * WebAssembly routing core (Supplier) and frame it (Input); the frames cross a link that holds them for up to hundreds
 * of ticks, reorders them, duplicates them and drops them in both directions (the MQTT QoS 1 at-least-once
 * contract, and worse); the fog's Process stage is hit with cache desyncs (a digest served for the wrong frame, a
 * flipped bit, a stale result), and the cloud's acknowledgements cross the same link back. Whatever the campaign
 * does, the ledger (Output) must end equal, entry for entry, hash for hash, to the one a clean link produces, must
 * re-verify from genesis, must have refused every desynchronised digest, and every edge must have seen its own fold
 * agree with the cloud's head. A campaign that ends with a frame still in flight, or a chain that differs by one
 * word, fails with the seed to replay it.
 * What breaks if it is removed? The pipeline would be held only on an orderly link, which the field never offers.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forAll, gen as forAllGen, type Gen } from '../02_Define_The_Rules/property.ts'
import { createRoutingCore } from '../06_Make_Decisions/routingWasm.ts'
import { buildTrackNetwork, type Track } from '../06_Make_Decisions/tracks.ts'
import { EdgeNode, frameDigest, Ledger, process, RESEND_AFTER, VALUE_WORDS, WINDOW, type Ack, type Frame, type Processed } from './telemetry.ts'

const rings: Track[] = buildTrackNetwork(1337).tracks.filter((t) => t.kind === 'car')
const core = createRoutingCore()
assert.equal(rings.length, 64)

/** The sensor reading of ring `t` at tick `tick`: the pose of a car `speed` metres a tick around it, in millimetres and microradians. */
function reading(t: Track, tick: number, speed: number): number[] {
  const p = core.poseAt(t, ((tick * speed) % t.length + t.length) % t.length)
  const q = (v: number): number => Math.round(v * 1000) >>> 0
  const out = [q(p.x), q(p.z), q(p.heading * 1000), q(p.tangentX), q(p.tangentZ)]
  assert.equal(out.length, VALUE_WORDS)
  return out
}

/** The clean run: every frame of every ring, delivered at once, in order; the ledger the campaign must reproduce. */
function cleanRun(ticks: number, speeds: number[]): { ledger: Ledger; frames: Frame[][] } {
  const ledger = new Ledger()
  const frames: Frame[][] = rings.map(() => [])
  for (let tick = 0; tick < ticks; tick++) {
    rings.forEach((t, i) => {
      const edge = new EdgeNode(t.id)
      edge.seq = tick
      const f = edge.sample(tick, reading(t, tick, speeds[i]))
      frames[i].push(f)
      for (const p of process([f])) assert.equal(ledger.admit(p).refused, null)
    })
  }
  return { ledger, frames }
}

interface Chaos {
  readonly seed: number
  /** Ticks of sampling. */
  readonly ticks: number
  /** The longest the link holds a message. */
  readonly latency: number
  readonly drop: number
  readonly duplicate: number
  /** Probability that the fog's cache serves a wrong digest for a frame. */
  readonly desync: number
}

interface Held<T> {
  at: number
  readonly item: T
}

/** A link that holds, reorders, duplicates and drops: what goes in comes out later, maybe twice, maybe never. */
class Link<T> {
  readonly held: Held<T>[] = []
  dropped = 0
  duplicated = 0
  private readonly g: Gen
  private readonly c: Chaos
  constructor(g: Gen, c: Chaos) {
    this.g = g
    this.c = c
  }

  send(item: T, now: number): void {
    if (this.g.bool(this.c.drop)) {
      this.dropped++
      return
    }
    const copies = this.g.bool(this.c.duplicate) ? 2 : 1
    if (copies === 2) this.duplicated++
    for (let k = 0; k < copies; k++) this.held.push({ at: now + 1 + this.g.int(0, this.c.latency), item })
  }

  /** Everything due at `now`, in an order the link chooses. */
  receive(now: number): T[] {
    const out: T[] = []
    for (let i = this.held.length - 1; i >= 0; i--) {
      if (this.held[i].at <= now) {
        out.push(this.held[i].item)
        this.held[i] = this.held[this.held.length - 1]
        this.held.pop()
      }
    }
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.g.int(0, i)
      ;[out[i], out[j]] = [out[j], out[i]]
    }
    return out
  }

  get pending(): number {
    return this.held.length
  }
}

/** The fog's Process stage with a cache that sometimes answers for the wrong frame, a stale run or a flipped bit. */
function fogProcess(g: Gen, c: Chaos, frames: readonly Frame[], last: { digest: number }): { out: Processed[]; injected: number } {
  const out = process(frames)
  let injected = 0
  for (let i = 0; i < out.length; i++) {
    if (!g.bool(c.desync)) {
      last.digest = out[i].fogDigest
      continue
    }
    const right = out[i].fogDigest
    let wrong: number
    switch (g.int(0, 2)) {
      case 0: wrong = last.digest // the L1 line of the previous frame, served again
        break
      case 1: wrong = (right ^ (1 << g.int(0, 31))) >>> 0 // one bit flipped between caches
        break
      default: wrong = frameDigest(new Uint32Array([...frames[i].words.slice(0, 7), (frames[i].words[7] + 1) >>> 0])) // a stale word
    }
    if (wrong === right) continue
    out[i] = { frame: out[i].frame, fogDigest: wrong }
    injected++
  }
  return { out, injected }
}

interface Outcome {
  readonly ledger: Ledger
  readonly edges: EdgeNode[]
  readonly finished: boolean
  readonly ticksRun: number
  readonly injected: number
  readonly dropped: number
  readonly duplicated: number
}

/** The campaign: sampling for `c.ticks` ticks over a chaotic link, then draining until every frame is acknowledged or patience runs out. */
function campaign(c: Chaos, speeds: number[]): Outcome {
  const g = gen2(c.seed)
  const edges = rings.map((t) => new EdgeNode(t.id))
  const ledger = new Ledger()
  const up = new Link<Frame>(g, c)
  const down = new Link<Ack>(g, c)
  const last = { digest: 0 }
  let injected = 0
  // Every frame is re-sent at least every RESEND_AFTER ticks and crosses twice; the drain bound lets the slowest frame
  // be dropped many times over and still land.
  const patience = c.ticks + 40 * (RESEND_AFTER + 2 * (c.latency + 1))
  let tick = 0
  for (; tick < patience; tick++) {
    if (tick < c.ticks) rings.forEach((t, i) => edges[i].sample(tick, reading(t, tick, speeds[i])))
    for (const a of down.receive(tick)) edges[a.node].acknowledge(a, tick)
    for (const e of edges) for (const f of e.due(tick)) up.send(f, tick)
    const arrived = up.receive(tick)
    const fog = fogProcess(g, c, arrived, last)
    injected += fog.injected
    for (const p of fog.out) down.send(ledger.admit(p), tick)
    if (tick >= c.ticks && edges.every((e) => e.inFlight === 0) && up.pending === 0 && down.pending === 0) break
  }
  return { ledger, edges, finished: tick < patience, ticksRun: tick, injected, dropped: up.dropped + down.dropped, duplicated: up.duplicated + down.duplicated }
}

/** A second generator over the same seed, so the campaign's own draws do not move the case generator. */
function gen2(seed: number): Gen {
  return forAllGen(seed ^ 0x5bd1e995)
}


function sameLedger(a: Ledger, b: Ledger): void {
  assert.deepEqual(a.nodeIds, b.nodeIds)
  for (const n of a.nodeIds) {
    const x = a.of(n)
    const y = b.of(n)
    assert.equal(y.length, x.length, `node ${n}: ${y.length} entries, not ${x.length}`)
    for (let i = 0; i < x.length; i++) assert.deepEqual(y[i], x[i], `node ${n} entry ${i}`)
    assert.deepEqual(b.state(n), a.state(n))
  }
}

const speeds = rings.map((_t, i) => 3 + ((i * 7919) % 11))

test('the ledger ends equal to the clean run under extreme latency, reordering, duplication, drops and cache desyncs', () => {
  const ticks = 24
  const clean = cleanRun(ticks, speeds)
  assert.equal(clean.ledger.entries.length, 64 * ticks)
  assert.equal(clean.ledger.verify(), true)
  forAll(
    'telemetry campaign',
    { seed: 0x7e1e, runs: 10 },
    (g): Chaos => ({
      seed: g.int(0, 2 ** 31),
      ticks,
      latency: g.pick([0, 1, 3, 10, 50, 200]),
      drop: g.pick([0, 0.05, 0.2, 0.5]),
      duplicate: g.pick([0, 0.1, 0.5]),
      desync: g.pick([0, 0.02, 0.1, 0.3]),
    }),
    (c) => {
      const o = campaign(c, speeds)
      assert.equal(o.finished, true, `a frame never landed in ${o.ticksRun} ticks`)
      sameLedger(clean.ledger, o.ledger)
      assert.equal(o.ledger.verify(), true)
      assert.equal(o.ledger.refusedDigest, o.injected, 'every desynchronised digest refused, nothing else')
      for (const e of o.edges) {
        assert.equal(e.desyncs, 0, `edge ${e.node} disagreed with the cloud's head`)
        assert.equal(e.acked, ticks)
        assert.equal(e.head, o.ledger.state(e.node).head)
      }
    },
  )
})

test('the worst link: 200 ticks of latency, half the messages dropped, half duplicated, a third of the fog results desynchronised', () => {
  const ticks = 12
  const clean = cleanRun(ticks, speeds)
  const c: Chaos = { seed: 99, ticks, latency: 200, drop: 0.5, duplicate: 0.5, desync: 0.34 }
  const o = campaign(c, speeds)
  assert.equal(o.finished, true, `a frame never landed in ${o.ticksRun} ticks`)
  assert.ok(o.dropped > 0 && o.duplicated > 0 && o.injected > 0)
  sameLedger(clean.ledger, o.ledger)
  assert.equal(o.ledger.verify(), true)
  assert.equal(o.ledger.refusedDigest, o.injected)
  assert.ok(o.ledger.duplicates > 0, 'the re-sends and duplicates were answered, not chained twice')
})

test('a burst past the window is refused, re-sent and lands in order', () => {
  const ticks = WINDOW + 20
  const clean = cleanRun(ticks, speeds)
  // The first frame of every node is lost until the burst has run past the window: everything behind it waits,
  // the frames past the window are refused, the edge backs off, and when seq 0 finally lands the chain catches up.
  const edges = rings.map((t) => new EdgeNode(t.id))
  const ledger = new Ledger()
  let tick = 0
  for (; tick < ticks + 400; tick++) {
    if (tick < ticks) rings.forEach((t, i) => edges[i].sample(tick, reading(t, tick, speeds[i])))
    for (const e of edges) {
      for (const f of e.due(tick)) {
        if (f.seq === 0 && tick < WINDOW + 10) continue
        for (const p of process([f])) e.acknowledge(ledger.admit(p), tick)
      }
    }
    if (tick >= ticks && edges.every((e) => e.inFlight === 0)) break
  }
  assert.ok(tick < ticks + 400, 'a frame never landed')
  assert.ok(ledger.refusedWindow > 0, 'the burst ran past the window')
  sameLedger(clean.ledger, ledger)
  assert.equal(ledger.verify(), true)
  for (const e of edges) assert.equal(e.desyncs, 0)
})

test('an edge whose own digest is wrong (a corrupt edge cache) is refused forever and never reaches the chain', () => {
  const ledger = new Ledger()
  const edge = new EdgeNode(3)
  const good = edge.sample(0, [1, 2, 3, 4, 5])
  const bad = edge.sample(1, [6, 7, 8, 9, 10])
  const corrupt: Frame = { ...bad, digest: (bad.digest ^ 0x100) >>> 0 }
  assert.equal(ledger.admit(process([good])[0]).refused, null)
  for (let k = 0; k < 5; k++) assert.equal(ledger.admit({ frame: corrupt, fogDigest: frameDigest(corrupt.words) }).refused, 'digest')
  assert.equal(ledger.entries.length, 1)
  assert.equal(ledger.refusedDigest, 5)
  assert.equal(ledger.verify(), true)
})
