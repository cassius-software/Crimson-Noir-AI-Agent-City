// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests SHA-256 (sha.ts) against the digests the published standard gives for its own
 * examples (nothing, "abc", the 448-bit and 896-bit messages, a million letters a), against digests worked out apart
 * from this code for every length where the padding changes shape (55, 56, 63, 64 bytes and so on), and it checks
 * that the hasher fed a piece at a time gives the one-shot digest however the input is split, so `sha256sum` can
 * stream a file of any length and still print the same digest.
 * What breaks if it is removed? A slip in the padding or in the piece-at-a-time bookkeeping would go unnoticed: the
 * disk's seal would still match itself, so nothing would fail until two machines disagreed about the same bytes.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encode, hex } from './bytes.ts'
import { Sha256, sha256 } from './sha.ts'

const digest = (text: string): string => hex(sha256(encode(text)))

/** Bytes that are not all alike: every value, in an order that is not simply counting. */
function mixed(length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = (i * 167 + 13) & 255
  return out
}

/** The digest of `data` fed to one hasher in the pieces that end at each of `cuts`. */
function pieces(data: Uint8Array, cuts: readonly number[]): string {
  const h = new Sha256()
  let from = 0
  for (const cut of [...cuts, data.length]) {
    h.update(data.subarray(from, cut))
    from = cut
  }
  return hex(h.digest())
}

test('sha256: the digests the standard gives for its examples', () => {
  assert.equal(digest(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(digest('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  // 448 bits (56 bytes): too long for the length to follow it in the same block, so the padding takes a second one.
  assert.equal(digest('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  assert.equal(
    digest('abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu'),
    'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1',
  )
  const million = encode('a'.repeat(1000000))
  assert.equal(hex(sha256(million)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  // The same million fed in uneven pieces, and a byte at a time for the first few thousand.
  assert.equal(pieces(million, [1, 64, 4097, 65536, 65600, 999999]), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  const h = new Sha256()
  for (let i = 0; i < 5000; i++) h.update(million.subarray(i, i + 1))
  h.update(million.subarray(5000))
  assert.equal(hex(h.digest()), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
})

test('sha256: every length where the padding changes shape, against digests worked out apart from this code', () => {
  // 55 bytes is the most that leaves room for the 1 bit and the length in the same block; 56 needs another block.
  const known: Record<number, string> = {
    1: 'ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb',
    55: '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318',
    56: 'b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a',
    57: 'f13b2d724659eb3bf47f2dd6af1accc87b81f09f59f2b75e5c0bed6589dfe8c6',
    63: '7d3e74a05d7db15bce4ad9ec0658ea98e3f06eeecf16b4c6fff2da457ddc2f34',
    64: 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb',
    65: '635361c48bb9eab14198e76ea8ab7f1a41685d6ad62aa9146d301d4f17eb0ae0',
    111: '6374f73208854473827f6f6a3f43b1f53eaa3b82c21c1a6d69a2110b2a79baad',
    112: 'f54353008a2553262ecdc4a34749563ba0950e8b0fc8652780b0a614b99683c1',
    119: '31eba51c313a5c08226adf18d4a359cfdfd8d2e816b13f4af952f7ea6584dcfb',
    120: '2f3d335432c70b580af0e8e1b3674a7c020d683aa5f73aaaedfdc55af904c21c',
    127: 'c57e9278af78fa3cab38667bef4ce29d783787a2f731d4e12200270f0c32320a',
    128: '6836cf13bac400e9105071cd6af47084dfacad4e5e302c94bfed24e013afb73e',
    129: 'c12cb024a2e5551cca0e08fce8f1c5e314555cc3fef6329ee994a3db752166ae',
    1000: '41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3',
  }
  for (const [n, want] of Object.entries(known)) {
    const data = encode('a'.repeat(Number(n)))
    assert.equal(hex(sha256(data)), want, `${n} bytes`)
    assert.equal(hex(new Sha256().update(data).digest()), want, `${n} bytes, through the hasher`)
  }
  // Every byte value, so no value is mistaken for a sign bit.
  const all = new Uint8Array(256)
  for (let i = 0; i < 256; i++) all[i] = i
  assert.equal(hex(sha256(all)), '40aff2e9d2d8922e47afd4648e6967497158785fbd1da870e7110266bf944880')
  // A byte order mark is bytes like any other.
  assert.equal(hex(sha256(Uint8Array.of(0xef, 0xbb, 0xbf, 0x61, 0x0a))), 'be4fccb045869c7ad387b9081a44cfd495b37efc020da4b44542de0d980c747f')
})

test('Sha256: fed in two pieces, split anywhere, it gives the one-shot digest, for every length up to three blocks', () => {
  for (let n = 0; n <= 200; n++) {
    const data = mixed(n)
    const whole = hex(sha256(data))
    for (let cut = 0; cut <= n; cut++) assert.equal(pieces(data, [cut]), whole, `${n} bytes cut at ${cut}`)
  }
})

test('Sha256: in three pieces split anywhere, a byte at a time, or with empty pieces between, still the one-shot digest', () => {
  const data = mixed(140)
  const whole = hex(sha256(data))
  for (let i = 0; i <= data.length; i++) {
    for (let j = i; j <= data.length; j++) assert.equal(pieces(data, [i, j]), whole, `cut at ${i} and ${j}`)
  }
  for (let n = 0; n <= 300; n++) {
    const bytes = mixed(n)
    const h = new Sha256()
    for (let i = 0; i < n; i++) h.update(bytes.subarray(i, i + 1)).update(new Uint8Array(0))
    assert.equal(hex(h.digest()), hex(sha256(bytes)), `${n} bytes one at a time`)
  }
})

test('Sha256: asking for the digest changes nothing, the input is never changed, and each digest is a new array', () => {
  const data = mixed(1000)
  const copy = data.slice()
  const h = new Sha256()
  assert.equal(hex(h.digest()), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  h.update(data.subarray(0, 100))
  const first = h.digest()
  const again = h.digest()
  assert.equal(first.length, 32)
  assert.notEqual(first, again)
  assert.deepEqual(first, again)
  assert.equal(hex(first), hex(sha256(data.subarray(0, 100))))
  // More after a digest goes on from where it was.
  h.update(data.subarray(100, 500))
  assert.equal(hex(h.digest()), hex(sha256(data.subarray(0, 500))))
  h.update(data.subarray(500))
  assert.equal(hex(h.digest()), hex(sha256(data)))
  assert.deepEqual(data, copy)
  // A piece that is a view into a larger array is read from its own start, not the array's.
  const big = mixed(5000)
  assert.equal(hex(new Sha256().update(big.subarray(77, 3077)).digest()), hex(sha256(big.slice(77, 3077))))
  assert.equal(hex(sha256(big.subarray(1, 2))), hex(sha256(Uint8Array.of(big[1]))))
})
