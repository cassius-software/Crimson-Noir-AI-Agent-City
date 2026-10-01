/**
 * Why does this file exist? It is the integrity law of everything agents and players say to one another: a pure,
 * dependency-free SHA-256 and HMAC-SHA256 (synchronous, deterministic, no Web Crypto, so the page, the physics worker
 * and the Node host all compute the same digest bit for bit), a canonical serialisation of plain data (sorted keys, so
 * the same message always hashes the same whatever order its fields were written in) and the seal that goes on a
 * message: its canonical body, the body's hash and, under a key, its MAC. The swarm's memory chains every episode on
 * it (08_Swarm/memory.ts), the operator's diary records the hash of the exact system prompt a model was given, and the
 * replication protocol seals every frame between the page and the host (10_Network/replication.ts), so a hidden
 * payload cannot be slipped into a channel, replayed, or edited after the fact without the chain, the audit or the
 * seal saying so. Stage 02 imports nothing above it; this file imports nothing at all.
 * What breaks if it is removed? A tampered memory, a replayed frame and a prompt nobody can prove would all pass in
 * silence.
 */

/** The round constants of SHA-256 (FIPS 180-4 §4.2.2): the first 32 bits of the fractional parts of the cube roots of the first 64 primes. */
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** The initial hash value (§5.3.3): the first 32 bits of the fractional parts of the square roots of the first 8 primes. */
const H0 = Uint32Array.from([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])

/** The block size of SHA-256, bytes (also HMAC's). */
const BLOCK = 64
/** The digest size, bytes. */
export const DIGEST_BYTES = 32
/** A digest as hex: this many characters. */
export const DIGEST_HEX = DIGEST_BYTES * 2

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))

/** `input` as bytes: a string is UTF-8 encoded; bytes are taken as they are. */
export function utf8(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? new TextEncoder().encode(input) : input
}

/** The SHA-256 digest of `input` (a string is UTF-8 encoded), 32 bytes. */
export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const msg = utf8(input)
  const len = msg.length
  // Padding (§5.1.1): a 1 bit, zeros, then the length in bits as 64 bits big-endian, to a whole number of blocks.
  const padded = new Uint8Array(Math.ceil((len + 9) / BLOCK) * BLOCK)
  padded.set(msg)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  const bits = len * 8
  view.setUint32(padded.length - 8, Math.floor(bits / 0x100000000))
  view.setUint32(padded.length - 4, bits >>> 0)
  const h = Uint32Array.from(H0)
  const w = new Uint32Array(64)
  for (let off = 0; off < padded.length; off += BLOCK) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = w[i - 16] + s0 + w[i - 7] + s1
    }
    let a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7]
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (hh + s1 + ch + K[i] + w[i]) >>> 0
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (s0 + maj) >>> 0
      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    h[0] += a
    h[1] += b
    h[2] += c
    h[3] += d
    h[4] += e
    h[5] += f
    h[6] += g
    h[7] += hh
  }
  const out = new Uint8Array(DIGEST_BYTES)
  const ov = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i])
  return out
}

/** Bytes as lower-case hex. */
export function hex(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += (b < 16 ? '0' : '') + b.toString(16)
  return s
}

/** The SHA-256 digest of `input` as 64 hex characters. */
export const sha256 = (input: string | Uint8Array): string => hex(sha256Bytes(input))

/** HMAC-SHA256 (RFC 2104) of `message` under `key`, 32 bytes: a key longer than a block is hashed first. */
export function hmacSha256Bytes(key: string | Uint8Array, message: string | Uint8Array): Uint8Array {
  let k = utf8(key)
  if (k.length > BLOCK) k = sha256Bytes(k)
  const inner = new Uint8Array(BLOCK + utf8(message).length)
  const outer = new Uint8Array(BLOCK + DIGEST_BYTES)
  for (let i = 0; i < BLOCK; i++) {
    const b = i < k.length ? k[i] : 0
    inner[i] = b ^ 0x36
    outer[i] = b ^ 0x5c
  }
  inner.set(utf8(message), BLOCK)
  outer.set(sha256Bytes(inner), BLOCK)
  return sha256Bytes(outer)
}

/** HMAC-SHA256 of `message` under `key` as 64 hex characters. */
export const hmacSha256 = (key: string | Uint8Array, message: string | Uint8Array): string => hex(hmacSha256Bytes(key, message))

/** Whether two digests (hex, or any two strings) are the same, in time that depends only on their length. */
export function sameDigest(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/** Whether `s` is a digest as this file writes one: 64 lower-case hex characters. */
export const isDigest = (s: unknown): s is string => typeof s === 'string' && s.length === DIGEST_HEX && /^[0-9a-f]+$/.test(s)

/**
 * Plain data (null, booleans, finite numbers, strings, arrays, plain objects) as one canonical JSON text: object keys
 * sorted, a key with an undefined value left out, an undefined array element written as null (as JSON.stringify does),
 * no whitespace. The same value always gives the same text, whatever order its fields were written in; anything that is
 * not plain data (a non-finite number, a function, a class instance, a bigint) throws, so nothing is hashed by accident.
 */
export function canonical(value: unknown): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError(`canonical: not a finite number: ${String(value)}`)
      return JSON.stringify(value)
    case 'string':
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value)) return `[${value.map((v) => canonical(v === undefined ? null : v)).join(',')}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== null && proto !== Object.prototype) throw new TypeError('canonical: not plain data')
      const o = value as Record<string, unknown>
      const parts: string[] = []
      for (const k of Object.keys(o).sort()) {
        if (o[k] !== undefined) parts.push(`${JSON.stringify(k)}:${canonical(o[k])}`)
      }
      return `{${parts.join(',')}}`
    }
    default:
      throw new TypeError(`canonical: not plain data (${typeof value})`)
  }
}

/** A sealed message: its canonical body, the body's SHA-256, and under a key its HMAC-SHA256. Plain data: it is sent or stored as it is. */
export interface Envelope {
  readonly body: string
  readonly hash: string
  readonly mac?: string
}

/** `value` sealed: canonicalised, hashed, and signed under `key` when one is given. */
export function seal(value: unknown, key?: string | Uint8Array): Envelope {
  const body = canonical(value)
  const hash = sha256(body)
  return Object.freeze(key === undefined ? { body, hash } : { body, hash, mac: hmacSha256(key, body) })
}

/**
 * Whether `envelope` is intact: a string body whose hash is its SHA-256 and, when `key` is given, whose MAC is its
 * HMAC under that key (an envelope without a MAC fails under a key). Digests are compared in constant time.
 */
export function verify(envelope: unknown, key?: string | Uint8Array): boolean {
  if (typeof envelope !== 'object' || envelope === null) return false
  const { body, hash, mac } = envelope as { body?: unknown; hash?: unknown; mac?: unknown }
  if (typeof body !== 'string' || !isDigest(hash) || !sameDigest(hash, sha256(body))) return false
  if (key === undefined) return true
  return isDigest(mac) && sameDigest(mac, hmacSha256(key, body))
}

/** The value a verified envelope carries (its canonical body parsed); throws if the body is not JSON. */
export const opened = (envelope: Envelope): unknown => JSON.parse(envelope.body)
