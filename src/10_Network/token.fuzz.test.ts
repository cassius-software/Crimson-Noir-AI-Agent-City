// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the property-based fuzzing of the session tokens the host hands out and checks
 * (replication.node.ts mintToken, verifyToken, tokenExpiry) and of the upgrade header they ride in (offeredToken,
 * offers, the room/ledger door routing), seeded and replayable (02_Define_The_Rules/property.ts). The properties: a
 * token round-trips under any secret (MIN_SECRET..256 characters, controls and unicode included) for any subject the
 * pattern allows and any safe expiry, and dies at the instant it says; every single-character change of a token
 * (replaced, inserted, deleted, case-flipped, at every position) fails, every other spelling of the signature the
 * base64url decoder would take fails (its leniency is pinned here so the spelling guard is known to be exercised), a
 * secret one character off never verifies another's token, and a token signed by hand with a subject or an expiry
 * outside the pattern is refused even though its signature holds; the upgrade header yields the token through odd
 * whitespace, repeated and empty entries, prefixes in odd places, commas inside the token and lists up to the bound,
 * and never past it; a minted token survives authProtocol and the header unchanged. Timing is not asserted here (a
 * measurement is in the Phase 16 audit notes): what is pinned is that the signature is compared whole, never by prefix.
 * What breaks if it is removed? A spelling of a token nobody minted, or a header shape nobody tried, could open the
 * door, and nothing would say so until it did.
 */
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { forAll, gen, type Gen } from '../02_Define_The_Rules/property.ts'
import { LEDGER_SUBPROTOCOL } from './ledger.ts'
import { MIN_SECRET, mintToken, offeredToken, offers, tokenExpiry, verifyToken } from './replication.node.ts'
import { AUTH_PREFIX, authProtocol, LIMITS, SUBPROTOCOL } from './replication.ts'

const MAX_SAFE = Number.MAX_SAFE_INTEGER
const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
/** The subject pattern, character by character: \w, space, dot, dash. */
const SUBJECT_CHARS = [...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_ .-']
/**
 * Characters a secret may hold: printable ASCII, C0 controls (not NUL: a trailing NUL is the same HMAC key, RFC 2104
 * pads a short key with zeros), Latin, CJK, an emoji (a surrogate pair). Never a lone surrogate (UTF-8 encodes every
 * lone surrogate as U+FFFD, so two secrets differing only there would be one key) and never U+FFFD itself.
 */
const SECRET_CHARS = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)), '\t', '\n', '\u001b', 'é', 'ß', '日', '本', 'Ω', '😀', ' ']

const secret = (g: Gen, len = g.int(MIN_SECRET, 256)): string => Array.from({ length: len }, () => g.pick(SECRET_CHARS)).join('')
const subject = (g: Gen, len = g.int(1, LIMITS.name)): string => Array.from({ length: len }, () => g.pick(SUBJECT_CHARS)).join('')
const expiry = (g: Gen): number => {
  const roll = g.next()
  if (roll < 0.1) return g.pick([1, 2, 1000, MAX_SAFE, MAX_SAFE - 1, 2 ** 52, 10 ** 15, 10 ** 15 + 1])
  if (roll < 0.5) return g.int(1, 2 ** 31)
  return g.int(1, 2 ** 45) * g.int(1, 255)
}
/** The host's own signature, for tokens this file signs by hand: HMAC-SHA256 of the body under the secret, base64url. */
const signed = (s: string, body: string): string => `${body}.${createHmac('sha256', s).update(body).digest().toString('base64url')}`
const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64url')
const decoded = (mac: string): Buffer => Buffer.from(mac, 'base64url')

// ---------------------------------------------------------------- round trip

test('a token round-trips under any secret, for any subject and safe expiry, and dies at the instant it says', () => {
  forAll('round trip', { seed: 0x70c3, runs: 2500 }, (g) => ({ s: secret(g), who: subject(g), at: expiry(g) }), ({ s, who, at }) => {
    const t = mintToken(s, who, at)
    assert.ok(t.length <= LIMITS.token, 'within the token bound')
    assert.equal(t.split('.').length, 3)
    assert.match(t, /^[A-Za-z0-9_-]+\.\d+\.[A-Za-z0-9_-]{43}$/, 'base64url, digits, base64url: what a subprotocol may carry')
    assert.equal(verifyToken(s, t, at - 1), who, 'the instant before')
    assert.equal(verifyToken(s, t, 0), who, 'at the epoch')
    assert.equal(verifyToken(s, t, Math.floor(at / 2)), who)
    assert.equal(verifyToken(s, t, at), null, 'expired at the instant')
    assert.equal(verifyToken(s, t, at + 1), null, 'and after')
    assert.equal(verifyToken(s, t, MAX_SAFE), null)
    assert.equal(tokenExpiry(t), at)
    assert.equal(authProtocol(t), AUTH_PREFIX + t, 'a minted token is one a subprotocol carries')
    assert.equal(offeredToken(`${SUBPROTOCOL}, ${authProtocol(t)}`), t, 'and it survives the header')
    assert.equal(mintToken(s, who, at), t, 'minting is deterministic')
  })
})

test('subjects at the edges of the pattern survive; those outside it are refused by mintToken and, signed by hand, by verifyToken', () => {
  const s = 'a-secret-long-enough-for-the-host'
  const classes = ['A', 'z', '0', '_', ' ', '.', '-']
  for (const c of classes) {
    for (const who of [c, c.repeat(LIMITS.name), `${c}${'x'.repeat(LIMITS.name - 2)}${c}`]) {
      assert.equal(verifyToken(s, mintToken(s, who, 10), 9), who, JSON.stringify(who))
    }
  }
  assert.equal(verifyToken(s, mintToken(s, 'a.b', 10), 9), 'a.b', 'a dot is allowed in a subject (the token stays three parts: the subject is base64url)')
  assert.equal(verifyToken(s, mintToken(s, 'Ada Lovelace-1815_', 10), 9), 'Ada Lovelace-1815_')
  const bad = ['', 'x'.repeat(LIMITS.name + 1), 'Ada\n', '\nAda', 'a\nb', 'a\u0000b', '\u0000', 'é', 'Ada\t', 'a,b', 'a/b', 'a+b', 'a=b', 'a:b', '日本', 'Ada\r', 'a b', '😀', 'Ada ']
  for (const who of bad) {
    assert.throws(() => mintToken(s, who, 10), /subject/, `mintToken refuses ${JSON.stringify(who)}`)
    const forged = signed(s, `${b64(who)}.10`)
    assert.equal(verifyToken(s, forged, 9), null, `verifyToken refuses a signed ${JSON.stringify(who)}`)
  }
})

test('expiries: 0, 2^53-1 and every safe integer mint; 10^16, 17 digits, fractions and NaN do not; a hand-signed spelling outside ^\\d{1,16}$ never verifies', () => {
  const s = 'another-secret-long-enough-xyz'
  const who = 'Ada'
  assert.equal(verifyToken(s, mintToken(s, who, 0), 0), null, 'an expiry of 0 is dead at the epoch')
  assert.equal(verifyToken(s, mintToken(s, who, 0), 1), null)
  assert.equal(tokenExpiry(mintToken(s, who, 0)), 0)
  assert.equal(verifyToken(s, mintToken(s, who, MAX_SAFE), MAX_SAFE - 1), who, '2^53-1 is the last safe expiry (16 digits)')
  assert.equal(verifyToken(s, mintToken(s, who, MAX_SAFE), MAX_SAFE), null)
  for (const at of [10 ** 16, 10 ** 16 + 2, 10 ** 17, 2 ** 53, 1.5, -0.5, Number.NaN, Infinity, -Infinity, 1e21]) {
    assert.throws(() => mintToken(s, who, at), /expiresAt/, `mintToken refuses ${at}`)
  }
  // A negative expiry is a safe integer: minted, and dead on arrival (its spelling is not an expiry).
  const negative = mintToken(s, who, -5)
  assert.equal(verifyToken(s, negative, 0), null)
  assert.equal(verifyToken(s, negative, -10), null)
  assert.ok(Number.isNaN(tokenExpiry(negative)))
  // Spellings a signer could write that the pattern refuses: signed under the secret, so only the pattern stands between them and the door.
  for (const spelled of ['1e3', ' 1000', '1000 ', '+1000', '-1000', '1000.0', '1_000', '0x3e8', '', '١٠٠٠', 'Infinity', 'NaN', '10000000000000000', '1'.repeat(17), '1'.repeat(40)]) {
    const forged = signed(s, `${b64(who)}.${spelled}`)
    assert.equal(verifyToken(s, forged, 0), null, `expiry spelled ${JSON.stringify(spelled)}`)
    assert.ok(Number.isNaN(tokenExpiry(forged)), `tokenExpiry of ${JSON.stringify(spelled)}`)
  }
  // Leading zeros fit the pattern (16 digits): unsigned they fail like any other change; this file does not pin what a signer's own zeros do.
  const t = mintToken(s, who, 1000)
  const [who64, , mac] = t.split('.')
  assert.equal(verifyToken(s, `${who64}.01000.${mac}`, 0), null, 'a leading zero is another body')
  assert.equal(verifyToken(s, `${who64}.0000000000001000.${mac}`, 0), null)
})

// ---------------------------------------------------------------- mutations

/** Characters a mutation may write: the token alphabet, the dot, what a decoder might skip, and some that are none of those. */
const MUTATION_CHARS = [...B64URL, '.', '=', '+', '/', ' ', '\t', '\n', '\u0000', 'é', '*', ' ']

/** Every single-character mutation of `t`: each position replaced (by a few characters), case-flipped, deleted, and a character inserted at each gap. */
function* mutations(t: string, g: Gen): Generator<[string, string]> {
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    for (let k = 0; k < 3; k++) {
      const r = g.pick(MUTATION_CHARS)
      if (r !== c) yield [`replace ${i} '${c}' by ${JSON.stringify(r)}`, t.slice(0, i) + r + t.slice(i + 1)]
    }
    const flipped = c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()
    if (flipped !== c) yield [`case flip ${i}`, t.slice(0, i) + flipped + t.slice(i + 1)]
    yield [`delete ${i}`, t.slice(0, i) + t.slice(i + 1)]
  }
  for (let i = 0; i <= t.length; i++) yield [`insert at ${i}`, t.slice(0, i) + g.pick(MUTATION_CHARS) + t.slice(i)]
}

test('every single-character mutation of a token, at every position, fails to verify; a secret one character off never verifies it', () => {
  forAll('mutations', { seed: 0xbad70c, runs: 160 }, (g) => ({ s: secret(g), who: subject(g), at: expiry(g) }), ({ s, who, at }, i) => {
    const g = gen(i)
    const t = mintToken(s, who, at)
    const now = at - 1
    assert.equal(verifyToken(s, t, now), who)
    let tried = 0
    for (const [what, m] of mutations(t, g)) {
      tried++
      assert.notEqual(m, t)
      assert.equal(verifyToken(s, m, now), null, `${what} of ${t}`)
    }
    assert.ok(tried >= 5 * t.length, 'every position was tried')
    // The secret one character off: replaced, inserted, deleted. (A NUL appended to a short key is the same HMAC key by
    // RFC 2104, so the characters written here are never NUL; see the pinned note below.)
    const at2 = g.int(0, s.length - 1)
    const others = [
      s.slice(0, at2) + g.pick(SECRET_CHARS.filter((c) => c !== s[at2])) + s.slice(at2 + 1),
      s.slice(0, at2) + g.pick(SECRET_CHARS) + s.slice(at2),
      s.slice(0, at2) + s.slice(at2 + 1),
      s.slice(1),
      s.slice(0, -1),
      s.toUpperCase() === s ? s.toLowerCase() : s.toUpperCase(),
    ]
    for (const other of others) {
      if (other === s) continue
      assert.equal(verifyToken(other, t, now), null, `secret ${JSON.stringify(other)} verifies a token of ${JSON.stringify(s)}`)
      assert.equal(verifyToken(s, mintToken(other, who, at), now), null, 'nor the other way')
    }
  })
})

test('every spelling of the signature the base64url decoder would take, other than the minted one, fails: the decoder\'s leniency is pinned so the guard is known to be exercised', () => {
  forAll('spellings', { seed: 0x5e11, runs: 400 }, (g) => ({ s: secret(g), who: subject(g), at: expiry(g) }), ({ s, who, at }, i) => {
    const g = gen(i ^ 0x5e11)
    const t = mintToken(s, who, at)
    const [who64, exp, mac] = t.split('.')
    const want = decoded(mac)
    assert.equal(want.length, 32)
    const spellings: [string, string][] = []
    // The last character's two low bits are not part of the 256-bit signature: three other characters decode the same.
    const last = B64URL.indexOf(mac.at(-1) ?? '')
    for (const c of B64URL) if (c !== mac.at(-1) && (B64URL.indexOf(c) & 0x3c) === (last & 0x3c)) spellings.push(['last character', mac.slice(0, -1) + c])
    // The other alphabet (base64's + and /), which the decoder also takes.
    if (/[-_]/.test(mac)) spellings.push(['base64 alphabet', mac.replace(/-/g, '+').replace(/_/g, '/')])
    // Padding, whitespace, NUL and a character outside both alphabets, which the decoder skips.
    spellings.push(['padding', `${mac}=`], ['double padding', `${mac}==`])
    const gap = g.int(0, mac.length)
    for (const junk of [' ', '\t', '\n', '\r', '\u0000', '*', '!']) spellings.push([`${JSON.stringify(junk)} inserted`, mac.slice(0, gap) + junk + mac.slice(gap)])
    assert.ok(spellings.length >= 10)
    for (const [what, other] of spellings) {
      assert.notEqual(other, mac)
      assert.ok(decoded(other).equals(want), `${what}: ${JSON.stringify(other)} decodes to the same 32 bytes (the precondition of this test)`)
      assert.equal(verifyToken(s, `${who64}.${exp}.${other}`, at - 1), null, `${what} verifies: ${JSON.stringify(other)}`)
    }
    // The subject's spelling is signed too: another encoding of the same name is another body.
    const stdSubject = Buffer.from(who, 'utf8').toString('base64')
    if (stdSubject !== who64) assert.equal(verifyToken(s, `${stdSubject}.${exp}.${mac}`, at - 1), null, 'a base64 (padded) subject')
    assert.equal(verifyToken(s, `${who64}=.${exp}.${mac}`, at - 1), null)
    assert.equal(verifyToken(s, ` ${who64}.${exp}.${mac}`, at - 1), null)
    assert.equal(verifyToken(s, `${who64}.${exp}.${mac} `, at - 1), null)
    // Shapes that are not three parts, or not a string.
    for (const u of [`${who64}.${exp}`, `${who64}.${exp}.${mac}.`, `.${who64}.${exp}.${mac}`, `${who64}..${exp}.${mac}`, '', '.', '..', 42, null, undefined, { toString: () => t }, [t], Symbol.for(t), 1n]) {
      assert.equal(verifyToken(s, u, at - 1), null)
    }
    assert.equal(verifyToken(s, `${t}${'A'.repeat(LIMITS.token)}`, at - 1), null, 'over the bound')
  })
})

test('the signature is compared whole: the first 42 of 43 characters right, with every spelling of the last, is no closer than none', () => {
  // A prefix oracle would let an attacker build a signature one character at a time; this pins that no prefix verifies
  // and that the comparison takes the whole decoded signature (a shorter one is a length mismatch, not a prefix match).
  const s = 'a-secret-of-thirty-two-chars-abc'
  const t = mintToken(s, 'Ada', 1000)
  const [who64, exp, mac] = t.split('.')
  let verified = 0
  for (const c of B64URL) verified += verifyToken(s, `${who64}.${exp}.${mac.slice(0, -1)}${c}`, 0) === null ? 0 : 1
  assert.equal(verified, 1, 'exactly one spelling of the last character verifies: the minted one')
  for (let len = 0; len < mac.length; len++) assert.equal(verifyToken(s, `${who64}.${exp}.${mac.slice(0, len)}`, 0), null, `a ${len}-character prefix`)
  for (let len = 1; len <= 3; len++) assert.equal(verifyToken(s, `${who64}.${exp}.${mac}${'A'.repeat(len)}`, 0), null, `${len} characters past the end`)
})

test('pinned: the HMAC key is the secret\'s UTF-8 bytes zero-padded to the block, so a short secret with NULs appended is the same key (RFC 2104); MIN_SECRET counts characters, not entropy', () => {
  // This is HMAC's own definition, not a defect of the token: it is pinned so that a change to how the secret is
  // taken (bytes, a KDF) is a deliberate one. The audit lists it as a nit against MIN_SECRET's comment.
  const s = 'sixteen-chars-ok'
  assert.equal(s.length, MIN_SECRET)
  const t = mintToken(s, 'Ada', 1000)
  assert.equal(verifyToken(`${s}\u0000`, t, 0), 'Ada', 'the secret with a NUL appended is the same key')
  assert.equal(verifyToken(`\u0000${s}`, t, 0), null, 'a NUL in front is another key')
  assert.equal(verifyToken('', mintToken('\u0000'.repeat(MIN_SECRET), 'Ada', 1000), 0), 'Ada', 'sixteen NULs are the empty key')
})

// ---------------------------------------------------------------- the upgrade header

/** Entries a header may carry that are neither a door's protocol nor a token. */
const NOISE =['', 'x', 'onyx.3', 'onyx.44', 'Onyx.4', 'ONYX.4', 'crimson.2', 'auth', 'auth_x', 'Auth.x', 'AUTH.x', 'xauth.y', 'a uth.x', 'auth .x', 'au th.x', 'permessage-deflate', 'chat', 'superchat', 'onyx.4.1', '.onyx.4', 'x'.repeat(200)]
const PAD = ['', ' ', '  ', '\t', ' \t ']
const pad = (g: Gen, e: string): string => `${g.pick(PAD)}${e}${g.pick(PAD)}`

interface HeaderCase {
  header: string
  /** The door the room routes to by the header alone: offers(crimson.1) and not offers(onyx.4). */
  toLedger: boolean
  /** The protocol offeredToken is asked for (the door's own), and what it must answer. */
  protocol: string
  want: string | null
  offersRoom: boolean
  offersLedger: boolean
}

/**
 * A header built so its answer is known by construction: which doors are in it, how many `auth.` entries and what
 * the one token is, with the noise, the whitespace and the order random.
 */
function headerCase(g: Gen): HeaderCase {
  const room = g.next() < 0.7
  const ledger = g.bool(0.3)
  const auths = g.next() < 0.75 ? 1 : g.pick([0, 2, 3])
  // The token: one a subprotocol carries; sometimes followed by a comma (the header's own separator) and more, which
  // cannot ride whole: the list is split before the token is read, so what is read is the part before the comma.
  const plainToken = Array.from({ length: g.int(1, 60) }, () => g.pick([...B64URL, '.'])).join('')
  const token = g.bool(0.9) ? plainToken : `${plainToken},${g.pick(NOISE)}`
  const empty = g.bool(0.2) // an `auth.` entry with nothing after it: an auth entry like any other, and so a second one
  const entries: string[] = []
  if (room) for (let k = g.int(1, 2); k > 0; k--) entries.push(SUBPROTOCOL)
  if (ledger) entries.push(LEDGER_SUBPROTOCOL)
  for (let k = auths; k > 0; k--) entries.push(k === 1 ? `${AUTH_PREFIX}${token}` : `${AUTH_PREFIX}${plainToken}${k}`)
  if (empty) entries.push(AUTH_PREFIX)
  for (let k = g.int(0, 4); k > 0; k--) entries.push(g.pick(NOISE))
  for (let i = entries.length - 1; i > 0; i--) {
    const j = g.int(0, i)
    ;[entries[i], entries[j]] = [entries[j], entries[i]]
  }
  const header = entries.map((e) => pad(g, e)).join(',')
  const within = header.length <= 2 * LIMITS.token
  const offersRoom = within && room
  const offersLedger = within && ledger
  const toLedger = offersLedger && !offersRoom
  const protocol = toLedger ? LEDGER_SUBPROTOCOL : SUBPROTOCOL
  const inDoor = toLedger ? offersLedger : offersRoom
  const want = inDoor && auths === 1 && !empty ? plainToken : null
  return { header, toLedger, protocol, want, offersRoom, offersLedger }
}

test('the upgrade header: the token through whitespace, repeats, empties, odd prefixes and commas; both doors offered is the room; nothing past the bound', () => {
  forAll('header', { seed: 0x4ead, runs: 20_000 }, headerCase, (c) => {
    assert.equal(offers(c.header, SUBPROTOCOL), c.offersRoom, 'offers onyx.4')
    assert.equal(offers(c.header, LEDGER_SUBPROTOCOL), c.offersLedger, 'offers crimson.1')
    assert.equal(offers(c.header, LEDGER_SUBPROTOCOL) && !offers(c.header, SUBPROTOCOL), c.toLedger, 'the routing the host computes')
    assert.equal(offeredToken(c.header, c.protocol), c.want, `offeredToken for ${c.protocol}`)
    if (c.toLedger) assert.equal(offeredToken(c.header), null, 'the room door reads no token from a ledger-only header')
    if (c.want !== null) {
      assert.ok(!c.want.includes(','), 'a token read off the header never holds a comma')
      assert.ok(offers(c.header, c.protocol))
    }
  })
  for (const u of [undefined, null, 42, ['onyx.4', 'auth.x'], { toString: () => 'onyx.4, auth.x' }, Symbol.for('onyx.4')]) {
    assert.equal(offeredToken(u), null, String(typeof u))
    assert.equal(offers(u, SUBPROTOCOL), false)
  }
  for (const h of [`${SUBPROTOCOL},${AUTH_PREFIX}t`, `${AUTH_PREFIX}t,${SUBPROTOCOL}`, `${SUBPROTOCOL}, ${AUTH_PREFIX}t`, `  ${SUBPROTOCOL}\t,\t${AUTH_PREFIX}t  `, `${SUBPROTOCOL},,${AUTH_PREFIX}t,`, `,${SUBPROTOCOL},${AUTH_PREFIX}t`, `${SUBPROTOCOL},${SUBPROTOCOL},${AUTH_PREFIX}t`, `${LEDGER_SUBPROTOCOL},${SUBPROTOCOL},${AUTH_PREFIX}t`]) {
    assert.equal(offeredToken(h), 't', JSON.stringify(h))
  }
  for (const h of [`${SUBPROTOCOL},${AUTH_PREFIX}`, `${SUBPROTOCOL},${AUTH_PREFIX} `, `${SUBPROTOCOL},x${AUTH_PREFIX}t`, `${SUBPROTOCOL},${AUTH_PREFIX}t,${AUTH_PREFIX}u`, `${SUBPROTOCOL},${AUTH_PREFIX}t,${AUTH_PREFIX}`, `${SUBPROTOCOL} ${AUTH_PREFIX}t`, `${SUBPROTOCOL};${AUTH_PREFIX}t`, `${AUTH_PREFIX}${SUBPROTOCOL}`, `${AUTH_PREFIX}t`, `${LEDGER_SUBPROTOCOL},${AUTH_PREFIX}t`]) {
    assert.equal(offeredToken(h), null, JSON.stringify(h))
  }
  assert.equal(offeredToken(`${SUBPROTOCOL},${AUTH_PREFIX}${AUTH_PREFIX}t`), `${AUTH_PREFIX}t`, 'a doubled prefix is a token beginning with auth. (which verifies nowhere)')
  assert.equal(offeredToken(`${LEDGER_SUBPROTOCOL},${AUTH_PREFIX}t`, LEDGER_SUBPROTOCOL), 't')
  // Entries are trimmed with String.prototype.trim, which also strips Unicode spaces (NBSP, BOM): a fact pinned, not a promise.
  assert.equal(offeredToken(`${SUBPROTOCOL}, ${AUTH_PREFIX}t﻿`), 't')
  assert.equal(offeredToken(`${SUBPROTOCOL},${AUTH_PREFIX}t u`), 't u', 'inside a token nothing is trimmed')
})

test('very long lists: a good token in a list within the bound is read; one past the bound is not, however good the token', () => {
  const s = 'a-secret-long-enough-for-the-host'
  const t = mintToken(s, 'Ada', 1000)
  forAll('long lists', { seed: 0x10d6, runs: 1500 }, (g) => {
    const filler = g.pick(['x,', 'permessage-deflate, ', ',', ' , ', 'onyx.3,'])
    const n = g.int(0, Math.ceil((2 * LIMITS.token + 40) / filler.length))
    const list = filler.repeat(n)
    return g.bool() ? `${SUBPROTOCOL},${list}${AUTH_PREFIX}${t}` : `${list}${AUTH_PREFIX}${t},${SUBPROTOCOL}`
  }, (header) => {
    const within = header.length <= 2 * LIMITS.token
    assert.equal(offeredToken(header), within ? t : null, `${header.length} characters`)
    assert.equal(offers(header, SUBPROTOCOL), within)
    if (within) assert.equal(verifyToken(s, offeredToken(header), 0), 'Ada')
  })
  const longest = `${SUBPROTOCOL},${AUTH_PREFIX}${'A'.repeat(LIMITS.token)}`
  assert.equal(offeredToken(longest), 'A'.repeat(LIMITS.token), 'the longest token the host reads fits the header bound')
  assert.equal(offeredToken(`${longest},${'y'.repeat(2 * LIMITS.token)}`), null)
})
