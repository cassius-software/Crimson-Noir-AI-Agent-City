// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is SHA-256 as the published standard states it (FIPS 180-4), written out in plain
 * integer arithmetic so it runs at once and the same everywhere: the platform's own digest is asynchronous, and the
 * console's file system is not. It takes its input whole or a piece at a time (so `sha256sum` digests a file of any
 * length without holding it), and the saved image of the disk is sealed with it so a corrupt or half-written save is
 * noticed and set aside instead of being read as files.
 * What breaks if it is removed? The disk's image has no seal, and `sha256sum` has nothing to print.
 */

const K: Int32Array = Int32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
  0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** The hash value every digest starts from. */
const START: readonly number[] = Object.freeze([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19])

/** Mixes the 64-byte block of `bytes` that starts at `at` into the hash value `h`; `w` is room for the block's schedule. */
function compress(h: Int32Array, w: Int32Array, bytes: Uint8Array, at: number): void {
  for (let i = 0; i < 16; i++, at += 4) w[i] = (bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15]
    const y = w[i - 2]
    const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3)
    const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10)
    w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
  }
  let a = h[0]
  let b = h[1]
  let c = h[2]
  let d = h[3]
  let e = h[4]
  let f = h[5]
  let g = h[6]
  let hh = h[7]
  for (let i = 0; i < 64; i++) {
    const s1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7))
    const ch = (e & f) ^ (~e & g)
    const t1 = (hh + s1 + ch + K[i] + w[i]) | 0
    const s0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10))
    const maj = (a & b) ^ (a & c) ^ (b & c)
    const t2 = (s0 + maj) | 0
    hh = g
    g = f
    f = e
    e = (d + t1) | 0
    d = c
    c = b
    b = a
    a = (t1 + t2) | 0
  }
  h[0] = (h[0] + a) | 0
  h[1] = (h[1] + b) | 0
  h[2] = (h[2] + c) | 0
  h[3] = (h[3] + d) | 0
  h[4] = (h[4] + e) | 0
  h[5] = (h[5] + f) | 0
  h[6] = (h[6] + g) | 0
  h[7] = (h[7] + hh) | 0
}

/**
 * SHA-256 a piece at a time, so input of any length is digested without being held: `update` with each piece in
 * order, then `digest`. Only a block of 64 bytes not yet full is kept between pieces. The digest is that of every byte
 * given so far, and asking for it changes nothing (more may be given after).
 */
export class Sha256 {
  private readonly h = Int32Array.from(START)
  private readonly w = new Int32Array(64)
  /** The bytes of a block not yet full. */
  private readonly block = new Uint8Array(64)
  private fill = 0
  /** Bytes given in all. */
  private length = 0

  /** Takes the next piece of the input. */
  update(data: Uint8Array): this {
    const n = data.length
    let i = 0
    this.length += n
    if (this.fill > 0) {
      i = Math.min(64 - this.fill, n)
      this.block.set(data.subarray(0, i), this.fill)
      this.fill += i
      if (this.fill < 64) return this
      compress(this.h, this.w, this.block, 0)
      this.fill = 0
    }
    for (; i + 64 <= n; i += 64) compress(this.h, this.w, data, i)
    if (i < n) {
      this.block.set(data.subarray(i))
      this.fill = n - i
    }
    return this
  }

  /** The 32-byte digest of everything given so far. */
  digest(): Uint8Array {
    const h = Int32Array.from(this.h)
    // What is left, a 1 bit, zeros, then the length in bits as 64 bits, big-endian: one block, or two when it does not fit.
    const tail = new Uint8Array(this.fill < 56 ? 64 : 128)
    tail.set(this.block.subarray(0, this.fill))
    tail[this.fill] = 0x80
    const bitsHigh = Math.floor(this.length / 0x20000000)
    const bitsLow = (this.length % 0x20000000) * 8
    const end = tail.length
    tail[end - 8] = (bitsHigh >>> 24) & 255
    tail[end - 7] = (bitsHigh >>> 16) & 255
    tail[end - 6] = (bitsHigh >>> 8) & 255
    tail[end - 5] = bitsHigh & 255
    tail[end - 4] = (bitsLow >>> 24) & 255
    tail[end - 3] = (bitsLow >>> 16) & 255
    tail[end - 2] = (bitsLow >>> 8) & 255
    tail[end - 1] = bitsLow & 255
    for (let at = 0; at < end; at += 64) compress(h, this.w, tail, at)
    const out = new Uint8Array(32)
    for (let i = 0; i < 8; i++) {
      const v = h[i]
      out[i * 4] = (v >>> 24) & 255
      out[i * 4 + 1] = (v >>> 16) & 255
      out[i * 4 + 2] = (v >>> 8) & 255
      out[i * 4 + 3] = v & 255
    }
    return out
  }
}

/** The 32-byte SHA-256 digest of `data`. */
export function sha256(data: Uint8Array): Uint8Array {
  return new Sha256().update(data).digest()
}
