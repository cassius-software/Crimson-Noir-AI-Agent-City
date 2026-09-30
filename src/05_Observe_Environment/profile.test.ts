/**
 * Why does this file exist? It proves the visitor profile is safe to show and safe to keep: names are
 * trimmed, collapsed and stripped of control, bidi and invisible characters, capped at 24 code units
 * without cutting a character in half; the seed is a stable unsigned 32-bit hash; and storage that is
 * missing, throwing, full or holding garbage never breaks the start-up.
 * What breaks if it is removed? A name that reorders the HUD text, a truncated emoji, a seed that changes
 * between visits, or a private window that crashes the Concierge could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  NAME_MAX, PROFILE_KEY, clearProfile, loadProfile, sanitizeName, saveProfile, seedFromName, type ProfileStore,
} from './profile.ts'

function memoryStore(init: Record<string, string> = {}): ProfileStore & { data: Map<string, string> } {
  const data = new Map(Object.entries(init))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => { data.set(k, String(v)) },
    removeItem: (k) => { data.delete(k) },
  }
}
const throwing: ProfileStore = {
  getItem() { throw new DOMException('denied', 'SecurityError') },
  setItem() { throw new DOMException('full', 'QuotaExceededError') },
  removeItem() { throw new DOMException('denied', 'SecurityError') },
}

test('sanitizeName trims and collapses every kind of whitespace', () => {
  assert.equal(sanitizeName('  Julia  '), 'Julia')
  assert.equal(sanitizeName('Mary \t\n  Ann'), 'Mary Ann')
  assert.equal(sanitizeName('A\u00A0B\u2003C\u3000D\u2028E'), 'A B C D E')
  assert.equal(sanitizeName(''), '')
  assert.equal(sanitizeName('   \t\n '), '')
})

test('sanitizeName drops control, bidi and invisible characters', () => {
  assert.equal(sanitizeName('Ju\u0000li\u0007a\u007F\u009B'), 'Julia')
  // Right-to-left override: would visually reverse the HUD text after the name.
  assert.equal(sanitizeName('\u202Eevil\u202C'), 'evil')
  assert.equal(sanitizeName('a\u2066b\u2067c\u2068d\u2069'), 'abcd')
  assert.equal(sanitizeName('\u200Eleft\u200F\u061C'), 'left')
  assert.equal(sanitizeName('Ju\u200Blia\u2060\uFEFF\u00AD'), 'Julia')
  // Blank "filler" letters and braille blank render as nothing: a name of only those is no name.
  assert.equal(sanitizeName('\u3164\u3164'), '')
  assert.equal(sanitizeName('\u2800'), '')
  assert.equal(sanitizeName('\u200B\u200B'), '')
  // Lone surrogates are removed; a valid pair is kept.
  assert.equal(sanitizeName('a\uD800b\uDC00c'), 'abc')
  assert.equal(sanitizeName('🦉 Owl'), '🦉 Owl')
})

test('sanitizeName keeps real writing: scripts, accents, ZWJ emoji and joiners', () => {
  assert.equal(sanitizeName('Zoë'), 'Zoë')
  assert.equal(sanitizeName('Zoe\u0308'), 'Zoë', 'decomposed accents are composed (NFC)')
  assert.equal(sanitizeName('محمد'), 'محمد')
  assert.equal(sanitizeName('王小明'), '王小明')
  assert.equal(sanitizeName('नमस्ते'), 'नमस्ते')
  assert.equal(sanitizeName('می\u200Cخواهم'), 'می\u200Cخواهم', 'ZWNJ is part of Persian spelling')
  assert.equal(sanitizeName('👩\u200D💻 Dev'), '👩\u200D💻 Dev')
  assert.equal(sanitizeName("O'Brien-Smith"), "O'Brien-Smith")
})

test('sanitizeName caps names at 24 code units without splitting a character', () => {
  assert.equal(NAME_MAX, 24)
  assert.equal(sanitizeName('x'.repeat(40)), 'x'.repeat(24))
  // 23 ASCII + an astral emoji (2 units) would be 25: the emoji is dropped whole, not halved.
  const cut = sanitizeName('a'.repeat(23) + '🦉')
  assert.equal(cut, 'a'.repeat(23))
  // A ZWJ family (11 units) that does not fit is dropped whole.
  const fam = sanitizeName('a'.repeat(20) + '👨\u200D👩\u200D👧\u200D👦')
  assert.equal(fam, 'a'.repeat(20))
  // A trailing space left by the cut is trimmed.
  assert.equal(sanitizeName('abcdefghijklmnopqrstuvw xyz'), 'abcdefghijklmnopqrstuvw')
  for (const raw of ['🦉'.repeat(30), 'é'.repeat(30), 'x\u0301'.repeat(30), '👩\u200D💻'.repeat(10)]) {
    const s = sanitizeName(raw)
    assert.ok(s.length > 0 && s.length <= NAME_MAX, `${JSON.stringify(raw)} → ${s.length}`)
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s), 'no lone surrogate')
  }
})

test('sanitizeName limits stacked combining marks', () => {
  const zalgo = 'Z' + '\u0301\u0302\u0303\u0304\u0305\u0306\u0307\u0308\u0309'.repeat(3) + 'oe'
  // NFC first folds Z + acute into Ź; four of the remaining marks survive.
  assert.equal(sanitizeName(zalgo), 'Ź\u0302\u0303\u0304\u0305oe')
  assert.equal(sanitizeName('x' + '\u0301'.repeat(40)).length, 1 + 4)
})

test('sanitizeName tolerates junk input', () => {
  assert.equal(sanitizeName(undefined as unknown as string), '')
  assert.equal(sanitizeName(42 as unknown as string), '')
  assert.equal(sanitizeName('x'.repeat(100_000)).length, 24)
})

test('seedFromName is a stable unsigned 32-bit hash', () => {
  // Pinned values (FNV-1a checked against its reference vectors 'a' → e40c292c, 'foobar' → bf9cf968,
  // then murmur3 fmix32). A change here changes every returning user's avatar.
  const pinned = { '': seedFromName(''), Julia: seedFromName('Julia'), Wren: seedFromName('Wren'), 'Zoë': seedFromName('Zoë') }
  assert.deepEqual(pinned, { '': 2872998923, Julia: 3569089717, Wren: 528159528, 'Zoë': 1291870507 })
  for (const n of ['a', 'b', 'Julia', 'julia', '🦉', 'x'.repeat(24)]) {
    const s = seedFromName(n)
    assert.ok(Number.isInteger(s) && s >= 0 && s <= 0xffffffff, `${n}: ${s}`)
  }
  assert.notEqual(seedFromName('Julia'), seedFromName('julia'))
})

test('seedFromName spreads similar names across the range', () => {
  const seeds = new Set<number>()
  let high = 0
  for (let i = 0; i < 2000; i++) {
    const s = seedFromName(`Player ${i}`)
    seeds.add(s)
    if (s >= 0x80000000) high++
  }
  assert.equal(seeds.size, 2000, 'no collisions among 2000 near-identical names')
  assert.ok(high > 900 && high < 1100, `top bit set on ${high}/2000`)
})

test('saveProfile then loadProfile round-trips through storage', () => {
  const store = memoryStore()
  assert.equal(loadProfile(store), null)
  saveProfile({ name: '  Julia ', seed: 7 }, store)
  assert.deepEqual(JSON.parse(store.data.get(PROFILE_KEY)!), { v: 1, name: 'Julia', seed: 7 })
  assert.deepEqual(loadProfile(store), { name: 'Julia', seed: 7 })
  clearProfile(store)
  assert.equal(loadProfile(store), null)
})

test('saveProfile ignores empty names and repairs invalid seeds', () => {
  const store = memoryStore()
  saveProfile({ name: ' \u202E ', seed: 1 }, store)
  assert.equal(store.data.size, 0)
  for (const seed of [-1, 1.5, NaN, 2 ** 32, Infinity]) {
    saveProfile({ name: 'Ada', seed }, store)
    assert.equal(loadProfile(store)?.seed, seedFromName('Ada'), String(seed))
  }
})

test('loadProfile rejects corrupt or hostile entries', () => {
  const cases: [string, ReturnType<typeof loadProfile>][] = [
    ['not json', null],
    ['null', null],
    ['42', null],
    ['"Julia"', null],
    ['{}', null],
    ['{"name":7,"seed":1}', null],
    ['{"name":"   ","seed":1}', null],
    [JSON.stringify({ name: 'x'.repeat(2000) }), null],
    ['{"name":"Ada"}', { name: 'Ada', seed: seedFromName('Ada') }],
    ['{"name":"Ada","seed":"12"}', { name: 'Ada', seed: seedFromName('Ada') }],
    ['{"name":"\\u202eAda  Lovelace ","seed":12}', { name: 'Ada Lovelace', seed: 12 }],
  ]
  for (const [raw, want] of cases) assert.deepEqual(loadProfile(memoryStore({ [PROFILE_KEY]: raw })), want, raw)
})

test('storage that is missing or throws never throws', () => {
  assert.equal(loadProfile(null), null)
  assert.equal(loadProfile(throwing), null)
  assert.doesNotThrow(() => saveProfile({ name: 'Ada', seed: 1 }, throwing))
  assert.doesNotThrow(() => saveProfile({ name: 'Ada', seed: 1 }, null))
  assert.doesNotThrow(() => clearProfile(throwing))
  // Node has no localStorage: the default store resolves to null and everything is a no-op.
  assert.equal(loadProfile(), null)
  assert.doesNotThrow(() => saveProfile({ name: 'Ada', seed: 1 }))
  // A getter that throws (blocked site data in some browsers) is handled too.
  const g = globalThis as { localStorage?: unknown }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new DOMException('denied', 'SecurityError') } })
  try {
    assert.equal(loadProfile(), null)
    assert.doesNotThrow(() => saveProfile({ name: 'Ada', seed: 1 }))
    assert.doesNotThrow(() => clearProfile())
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete g.localStorage
  }
})
