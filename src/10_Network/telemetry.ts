/**
 * Why does this file exist? It is the IIoT telemetry pipeline, SIPOC-shaped, in one pure module:
 *   Supplier  an edge node (an actor over the WebAssembly routing core, or any sensor) that samples its state,
 *   Input     a frame: FRAME_WORDS 32-bit words [node, seq, tick, five values], numbered per node without gaps,
 *   Process   a deterministic integer kernel (`frameDigest`: FNV-1a over the words, finished with mix32) that the
 *             fog runs as a WGSL compute shader (crimson_noir_os/shaders/telemetry.wgsl, one invocation per frame)
 *             and the edge runs here, in the same arithmetic, on the same words; and a chain fold (`chain`) that
 *             folds each digest into the node's running head in sequence order,
 *   Output    the cloud's ledger: one entry per admitted frame, hash-chained with SHA-256 like the OS's weight
 *             ledger (ledger.ts), so a customer can verify every reading back to genesis,
 *   Customer  whoever reads the ledger, or the fleet sync.
 * Nothing in it is trusted across a link. A frame is admitted only when the fog's digest equals the edge's own
 * (two independent runs of the kernel agreed: a desynchronised cache, a stale shader result or a flipped word is
 * refused, never chained); only in sequence order, once each (a duplicate is answered with the current
 * acknowledgement, a frame ahead of its turn waits in a bounded buffer, a frame too far ahead is refused and
 * re-sent later); and the acknowledgement carries the head the cloud reached, which the edge compares with its
 * own fold of the same frames: a disagreement is a desync the edge reports and resolves by re-sending from the
 * last acknowledged sequence number. Delivery is at least once (the MQTT QoS 1 contract): the edge keeps every
 * frame until it is acknowledged and re-sends after `RESEND_AFTER` ticks. telemetry.fuzz.test.ts drives all of it
 * through extreme latency, reordering, duplication, drops and injected cache desyncs and holds the ledger equal
 * to the clean run's. The hosted runtime's telemetry.rs and telemetry.wgsl are the same kernel, pinned to the same
 * vectors (VECTORS), so edge (here), fog (the GPU) and cloud (here) agree word for word.
 * What breaks if it is removed? Telemetry would have no frame, no digest to agree on and no ledger to land in.
 */
import { canonical, sha256 } from '../02_Define_The_Rules/integrity.ts'

/** Words in a frame: node, seq, tick, then VALUE_WORDS values. */
export const FRAME_WORDS = 8
export const VALUE_WORDS = FRAME_WORDS - 3
/** Frames a node may have in flight ahead of the cloud's next expected sequence number. */
export const WINDOW = 64
/** Ticks the edge waits for an acknowledgement before re-sending a frame. */
export const RESEND_AFTER = 8
/** The hash before the first ledger entry. */
export const GENESIS = '0'.repeat(64)
const FNV_OFFSET = 0x811c9dc5
const FNV_PRIME = 0x01000193

/** The 32-bit mixer the OS kernels use (noir_core hash.rs mix32, swarm.wgsl mix32). */
export function mix32(x0: number): number {
  let x = x0 >>> 0
  x ^= x >>> 16
  x = Math.imul(x, 0x7feb352d) >>> 0
  x ^= x >>> 15
  x = Math.imul(x, 0x846ca68b) >>> 0
  x ^= x >>> 16
  return x >>> 0
}

/** FNV-1a over 32-bit words, each fed as its four little-endian bytes, from `h` (noir_core hash.rs fnv1a_words). */
export function fnv1aWords(h0: number, words: ArrayLike<number>): number {
  let h = h0 >>> 0
  for (let i = 0; i < words.length; i++) {
    const w = words[i] >>> 0
    for (let b = 0; b < 4; b++) h = Math.imul(h ^ ((w >>> (8 * b)) & 0xff), FNV_PRIME) >>> 0
  }
  return h >>> 0
}

/** The Process kernel: the digest of one frame's FRAME_WORDS words (telemetry.wgsl `digest`, telemetry.rs frame_digest). */
export function frameDigest(words: ArrayLike<number>): number {
  if (words.length !== FRAME_WORDS) throw new RangeError(`a frame is ${FRAME_WORDS} words, not ${words.length}`)
  return mix32(fnv1aWords(FNV_OFFSET, words))
}

/** The chain fold: the node's head after a frame with `digest` at `seq` (telemetry.rs chain). */
export function chain(head: number, digest: number, seq: number): number {
  return mix32((head ^ digest ^ Math.imul(seq >>> 0, 0x9e3779b9)) >>> 0)
}

/** A frame as the edge sends it: its words and the edge's own digest of them. */
export interface Frame {
  readonly node: number
  readonly seq: number
  readonly tick: number
  readonly words: Uint32Array
  /** The edge's digest (Process, run at the edge). */
  readonly digest: number
}

export function frame(node: number, seq: number, tick: number, values: ArrayLike<number>): Frame {
  if (values.length !== VALUE_WORDS) throw new RangeError(`${VALUE_WORDS} values, not ${values.length}`)
  const words = new Uint32Array(FRAME_WORDS)
  words[0] = node >>> 0
  words[1] = seq >>> 0
  words[2] = tick >>> 0
  for (let i = 0; i < VALUE_WORDS; i++) words[3 + i] = values[i] >>> 0
  return { node: words[0], seq: words[1], tick: words[2], words, digest: frameDigest(words) }
}

/** What the fog hands the cloud: the frame and the digest the shader computed for it. */
export interface Processed {
  readonly frame: Frame
  readonly fogDigest: number
}

/** The fog's Process stage on the CPU (the reference of telemetry.wgsl): one digest per frame, in order. */
export function process(frames: readonly Frame[]): Processed[] {
  return frames.map((f) => ({ frame: f, fogDigest: frameDigest(f.words) }))
}

/** The cloud's answer to a frame: the node's cumulative acknowledgement and the head it reached. */
export interface Ack {
  readonly node: number
  /** Every seq below this is in the ledger. */
  readonly next: number
  readonly head: number
  /** Why the frame itself was not admitted, when it was not. */
  readonly refused: 'digest' | 'window' | 'stale' | null
}

/** One ledger entry: [node, seq, tick, digest], the node's head after it, and its link in the node's chain. */
export interface Entry {
  readonly node: number
  readonly seq: number
  readonly tick: number
  readonly digest: number
  readonly head: number
  readonly hash: string
}

export const link = (body: readonly [number, number, number, number], previous: string): string => sha256(canonical(body) + previous)

interface NodeState {
  next: number
  head: number
  /** The node's SHA-256 chain head (its last entry's hash). */
  hash: string
  /** Frames ahead of their turn, by seq. */
  waiting: Map<number, Processed>
}

/**
 * The cloud's ledger (Output): every node's chain, every admitted frame, hash-chained per node (a node's chain
 * depends on its own frames alone, whatever order the nodes' frames arrived in between each other).
 */
export class Ledger {
  readonly entries: Entry[] = []
  refusedDigest = 0
  refusedWindow = 0
  duplicates = 0
  private readonly nodes = new Map<number, NodeState>()

  private node(n: number): NodeState {
    let s = this.nodes.get(n)
    if (!s) {
      s = { next: 0, head: 0, hash: GENESIS, waiting: new Map() }
      this.nodes.set(n, s)
    }
    return s
  }

  /** The node's next expected seq, its head and its chain's last hash. */
  state(node: number): { next: number; head: number; hash: string } {
    const s = this.node(node)
    return { next: s.next, head: s.head, hash: s.hash }
  }

  /** The nodes with an entry or a frame seen. */
  get nodeIds(): number[] {
    return [...this.nodes.keys()].sort((a, b) => a - b)
  }

  /** The node's entries, in sequence order. */
  of(node: number): Entry[] {
    return this.entries.filter((e) => e.node === node)
  }

  /** Admits a processed frame (or refuses it) and answers with the node's acknowledgement. */
  admit(p: Processed): Ack {
    const f = p.frame
    const s = this.node(f.node)
    if (p.fogDigest !== f.digest || frameDigest(f.words) !== f.digest) {
      // Edge and fog disagree, or the words do not match the digest they came with: never chained.
      this.refusedDigest++
      return { node: f.node, next: s.next, head: s.head, refused: 'digest' }
    }
    if (f.seq < s.next) {
      this.duplicates++
      return { node: f.node, next: s.next, head: s.head, refused: 'stale' }
    }
    if (f.seq >= s.next + WINDOW) {
      this.refusedWindow++
      return { node: f.node, next: s.next, head: s.head, refused: 'window' }
    }
    s.waiting.set(f.seq, p)
    // Apply everything that is now in order.
    while (s.waiting.has(s.next)) {
      const q = s.waiting.get(s.next)!
      s.waiting.delete(s.next)
      const g = q.frame
      s.head = chain(s.head, g.digest, g.seq)
      const body: [number, number, number, number] = [g.node, g.seq, g.tick, g.digest]
      s.hash = link(body, s.hash)
      this.entries.push({ node: g.node, seq: g.seq, tick: g.tick, digest: g.digest, head: s.head, hash: s.hash })
      s.next++
    }
    return { node: f.node, next: s.next, head: s.head, refused: null }
  }

  /** Every node's chain re-verified from genesis: true when every link holds and every head folds. */
  verify(): boolean {
    const heads = new Map<number, { next: number; head: number; hash: string }>()
    for (const e of this.entries) {
      const st = heads.get(e.node) ?? { next: 0, head: 0, hash: GENESIS }
      if (e.seq !== st.next) return false
      st.head = chain(st.head, e.digest, e.seq)
      st.hash = link([e.node, e.seq, e.tick, e.digest], st.hash)
      st.next++
      heads.set(e.node, st)
      if (st.head !== e.head || st.hash !== e.hash) return false
    }
    for (const [n, st] of heads) {
      const s = this.nodes.get(n)
      if (!s || s.next !== st.next || s.head !== st.head || s.hash !== st.hash) return false
    }
    return true
  }
}

/** A frame the edge still owes an acknowledgement for. */
interface InFlight {
  readonly frame: Frame
  sentAt: number
  sends: number
}

/** An edge node (Supplier): numbers its frames, keeps them until acknowledged, re-sends, and detects desync. */
export class EdgeNode {
  seq = 0
  /** The edge's own fold of its acknowledged frames: must equal the cloud's head at `acked`. */
  head = 0
  acked = 0
  desyncs = 0
  resends = 0
  private readonly flight: InFlight[] = []
  private readonly heads = new Map<number, number>()

  readonly node: number

  constructor(node: number) {
    this.node = node
  }

  /** A new frame of `values` at `tick`, queued for sending. */
  sample(tick: number, values: ArrayLike<number>): Frame {
    const f = frame(this.node, this.seq++, tick, values)
    // The edge folds ahead of the cloud so it can check each acknowledgement's head against its own.
    const prev = f.seq === 0 ? 0 : this.heads.get(f.seq - 1)!
    this.heads.set(f.seq, chain(prev, f.digest, f.seq))
    this.flight.push({ frame: f, sentAt: -1, sends: 0 })
    return f
  }

  /** The frames to send now: new ones, and any unacknowledged one older than RESEND_AFTER ticks. */
  due(tick: number): Frame[] {
    const out: Frame[] = []
    for (const f of this.flight) {
      if (f.sentAt < 0 || tick - f.sentAt >= RESEND_AFTER) {
        if (f.sentAt >= 0) this.resends++
        f.sentAt = tick
        f.sends++
        out.push(f.frame)
      }
    }
    return out
  }

  /** Frames not yet acknowledged. */
  get inFlight(): number {
    return this.flight.length
  }

  /**
   * Takes an acknowledgement: drops every frame below `next`, and compares the cloud's head with the edge's own
   * fold at that point. A disagreement is a desync: counted, and every frame from `next` on is re-sent at once
   * (the cloud is the authority for what it chained; the edge's duty is to get it the frames it lacks).
   */
  acknowledge(ack: Ack, tick: number): void {
    if (ack.node !== this.node) return
    if (ack.next > this.acked) {
      const own = this.heads.get(ack.next - 1)
      if (own !== undefined && own !== ack.head) {
        this.desyncs++
      }
      this.acked = ack.next
      this.head = own ?? this.head
      while (this.flight.length && this.flight[0].frame.seq < ack.next) this.flight.shift()
      for (let k = 0; k < ack.next - 1; k++) this.heads.delete(k)
    } else if (ack.refused === 'window') {
      // Too far ahead: everything in flight goes again from the start.
      for (const f of this.flight) f.sentAt = tick - RESEND_AFTER
    }
  }
}

/** The vectors the Rust and WGSL twins pin (telemetry.rs tests): frames, their digests, and the chain of the three. */
export const VECTORS: ReadonlyArray<{ words: readonly number[]; digest: number }> = [
  { words: [0, 0, 0, 0, 0, 0, 0, 0], digest: 0xf8da9ded },
  { words: [1, 2, 3, 4, 5, 6, 7, 8], digest: 0x0543e119 },
  { words: [7, 41, 1000, 0xffffffff, 0x80000000, 0x7fffffff, 0xdeadbeef, 0x01020304], digest: 0x525f35c4 },
]
/** The head after folding the three vectors' digests at seq 0, 1, 2 from 0. */
export const VECTORS_CHAIN = 0xdeb20183
