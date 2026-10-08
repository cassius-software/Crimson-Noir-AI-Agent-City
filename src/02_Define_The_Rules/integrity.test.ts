// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the integrity law (integrity.ts) against the published vectors: SHA-256 over
 * the empty string, "abc", the two-block message and a million "a"s (FIPS 180-4), HMAC-SHA256 over the RFC 4231
 * cases (short, block-sized and over-block keys, the truncated case); and, since the Node host signs with node:crypto
 * while the page can only use this file, that the two agree bit for bit over many seeded inputs of every length
 * class. The canonical form is proven order-independent and strict about what is plain data; a seal verifies, and
 * one byte changed anywhere, or a MAC under another key, does not.
 * What breaks if it is removed? A digest could drift from the standard, and the page and the host could stop agreeing
 * on a seal without a test going red.
 */
import assert from 'node:assert/strict'
import { createHash, createHmac } from 'node:crypto'
import { test } from 'node:test'
import { canonical, DIGEST_HEX, hmacSha256, isDigest, opened, sameDigest, seal, sha256, sha256Bytes, verify } from './integrity.ts'

const bytes = (n: number, fill: number): Uint8Array => new Uint8Array(n).fill(fill)

test('SHA-256: the FIPS 180-4 vectors, over strings and over bytes', () => {
  assert.equal(sha256(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
  assert.equal(sha256('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'), '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1')
  assert.equal(sha256('a'.repeat(1_000_000)), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0')
  assert.equal(sha256(new TextEncoder().encode('abc')), sha256('abc'), 'bytes and their string are the same input')
  assert.equal(sha256('naïve 東京'), createHash('sha256').update('naïve 東京', 'utf8').digest('hex'), 'UTF-8, not UTF-16 code units')
  assert.equal(sha256Bytes('').length, 32)
  // Every length through the padding boundaries (55, 56, 63, 64, 65 bytes are the ones that go wrong).
  for (let n = 0; n <= 130; n++) {
    const m = bytes(n, 0x61)
    assert.equal(sha256(m), createHash('sha256').update(m).digest('hex'), `${n} bytes`)
  }
})

test('HMAC-SHA256: the RFC 4231 cases', () => {
  assert.equal(hmacSha256(bytes(20, 0x0b), 'Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7')
  assert.equal(hmacSha256('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843')
  assert.equal(hmacSha256(bytes(20, 0xaa), bytes(50, 0xdd)), '773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe')
  assert.equal(hmacSha256(Uint8Array.from({ length: 25 }, (_, i) => i + 1), bytes(50, 0xcd)), '82558a389a443c0ea4cc819899f2083a85f0faa3e578f8077a2e3ff46729665b')
  assert.equal(hmacSha256(bytes(20, 0x0c), 'Test With Truncation').slice(0, 32), 'a3b6167473100ee06e0c796c2955552b')
  assert.equal(hmacSha256(bytes(131, 0xaa), 'Test Using Larger Than Block-Size Key - Hash Key First'), '60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54')
  assert.equal(
    hmacSha256(bytes(131, 0xaa), 'This is a test using a larger than block-size key and a larger than block-size data. The key needs to be hashed before being used by the HMAC algorithm.'),
    '9b09ffa71b942fcb27635fbcd5b0e944bfdc63644f0713938a7f51535c3a35e2',
  )
})

test('the page and the host agree bit for bit: this file against node:crypto over seeded keys and messages of every length class', () => {
  let s = 0x2545f491
  const rand = (): number => {
    s ^= s << 13
    s ^= s >>> 17
    s ^= s << 5
    return (s >>> 0) / 0x100000000
  }
  const lengths = [0, 1, 3, 31, 32, 55, 56, 63, 64, 65, 100, 127, 128, 129, 300, 1000]
  for (const kn of lengths) {
    for (const mn of lengths) {
      const key = Uint8Array.from({ length: kn }, () => Math.floor(rand() * 256))
      const msg = Uint8Array.from({ length: mn }, () => Math.floor(rand() * 256))
      assert.equal(hmacSha256(key, msg), createHmac('sha256', key).update(msg).digest('hex'), `key ${kn} bytes, message ${mn} bytes`)
    }
  }
  // A string key and a string message, as the replication seal uses them (the token is text).
  for (let i = 0; i < 50; i++) {
    const key = `token-${Math.floor(rand() * 1e9).toString(36)}`
    const msg = `{"n":${i},"body":{"t":"chat","text":"line ${Math.floor(rand() * 1e6)}"}}`
    assert.equal(hmacSha256(key, msg), createHmac('sha256', key).update(msg, 'utf8').digest('hex'))
  }
})

test('canonical: sorted keys, no whitespace, undefined dropped from objects and null in arrays; the same data always gives the same text', () => {
  assert.equal(canonical({ b: 1, a: [true, null, 'x', { d: 2, c: -0 }], e: undefined }), '{"a":[true,null,"x",{"c":0,"d":2}],"b":1}')
  assert.equal(canonical({ a: 1, b: 2 }), canonical({ b: 2, a: 1 }))
  assert.equal(canonical([undefined]), '[null]')
  assert.equal(canonical('line\n"quoted"'), '"line\\n\\"quoted\\""')
  assert.equal(canonical(null), 'null')
  assert.equal(canonical(1e21), '1e+21')
  assert.equal(canonical(Object.freeze({ z: Object.freeze([1]) })), '{"z":[1]}', 'frozen plain data is plain data')
  for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, () => 1, Symbol('s'), 10n, new Date(0), new Map(), { a: Number.NaN }, [1n]]) {
    assert.throws(() => canonical(bad), TypeError, String(typeof bad))
  }
  assert.throws(() => canonical(undefined), TypeError, 'undefined alone is not data')
  assert.equal(sha256(canonical({ a: 1, b: 'two' })), sha256(canonical({ b: 'two', a: 1 })))
})

test('seal and verify: a sealed value verifies, one byte changed or another key does not; digests are compared in constant time', () => {
  const env = seal({ t: 'chat', seq: 3, text: 'Good morning' }, 'session-token')
  assert.deepEqual(env, { body: '{"seq":3,"t":"chat","text":"Good morning"}', hash: sha256(env.body), mac: hmacSha256('session-token', env.body) })
  assert.ok(Object.isFrozen(env))
  assert.equal(verify(env, 'session-token'), true)
  assert.equal(verify(env), true, 'the hash alone, without a key')
  assert.equal(verify(env, 'another-token'), false)
  assert.equal(verify({ ...env, body: env.body.replace('Good', 'Gold') }, 'session-token'), false, 'the body edited')
  assert.equal(verify({ ...env, hash: `${env.hash.slice(0, -1)}0` }, 'session-token'), false, 'the hash edited')
  assert.equal(verify({ ...env, mac: env.mac!.toUpperCase() }, 'session-token'), false, 'the mac edited')
  assert.equal(verify({ body: env.body, hash: env.hash }, 'session-token'), false, 'no mac under a key')
  assert.equal(verify(seal([1, 2, 3])), true)
  assert.equal(verify(seal([1, 2, 3]), 'k'), false, 'unsigned, under a key')
  for (const bad of [null, 7, 'env', {}, { body: 1, hash: env.hash }, { body: env.body, hash: 'short' }]) assert.equal(verify(bad), false, JSON.stringify(bad))
  assert.deepEqual(opened(env), { seq: 3, t: 'chat', text: 'Good morning' })
  assert.equal(seal({ a: 1 }).hash, seal({ a: 1 }).hash, 'deterministic')
  assert.ok(isDigest(env.hash) && env.hash.length === DIGEST_HEX)
  assert.equal(isDigest(env.hash.toUpperCase()), false)
  assert.equal(isDigest(env.hash.slice(1)), false)
  assert.equal(sameDigest('abc', 'abc'), true)
  assert.equal(sameDigest('abc', 'abd'), false)
  assert.equal(sameDigest('abc', 'ab'), false)
})
