// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the part a download writes into the page's storage (modelPart.ts) to its rule,
 * over in-memory files: each write is flushed before the note is written, so the note never says more than the part
 * holds and its hash is over exactly the bytes it counts; a hold writes what is buffered and notes it; a writer that
 * simply stops (a closed tab) leaves the last write to be picked up; a note is trusted only when the pin, the
 * validator, its age and the part's size agree and every byte it counts, read back from the part and hashed again,
 * comes to the state it saved (a byte changed anywhere, at the real write size too, a whole part's among them), and
 * anything else starts from the first byte; bytes past the pin's size are refused; a part that holds the whole file
 * ends with its SHA-256 and no write; and handles whose methods return promises (the first browsers that had them)
 * work the same.
 * What breaks if it is removed? A note that runs ahead of its part, or one picked up against the wrong bytes, would
 * pass in silence until a model failed to load.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { PART_DAYS, WRITE_BYTES, forPin, noteText, openPart, parseNote, partName, resumable, type PartNote, type PartPin, type SyncFile } from './modelPart.ts'
import { sha256Stream } from '../02_Define_The_Rules/integrity.ts'

const NOW = 1_800_000_000_000
const DAY = 24 * 60 * 60 * 1000
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

/** A file of the page's storage in memory, its every call written to `log` (shared by the files of one test). */
class MemFile implements SyncFile {
  data = new Uint8Array(0)
  readonly name: string
  readonly log: string[]
  readonly later: boolean
  constructor(name: string, log: string[] = [], later = false) {
    this.name = name
    this.log = log
    this.later = later
  }
  private done<T>(v: T): T | Promise<T> { return this.later ? Promise.resolve(v) : v }
  read(buf: Uint8Array, o: { at: number }): number {
    const n = Math.max(0, Math.min(buf.length, this.data.length - o.at))
    buf.set(this.data.subarray(o.at, o.at + n))
    return n
  }
  write(buf: Uint8Array, o: { at: number }): number {
    const end = o.at + buf.length
    if (end > this.data.length) {
      const grown = new Uint8Array(end)
      grown.set(this.data)
      this.data = grown
    }
    this.data.set(buf, o.at)
    this.log.push(`${this.name} write ${o.at}+${buf.length}`)
    return buf.length
  }
  truncate(n: number): void | Promise<void> {
    const cut = new Uint8Array(n)
    cut.set(this.data.subarray(0, n))
    this.data = cut
    this.log.push(`${this.name} truncate ${n}`)
    return this.done(undefined)
  }
  getSize(): number | Promise<number> { return this.done(this.data.length) }
  flush(): void | Promise<void> {
    this.log.push(`${this.name} flush`)
    return this.done(undefined)
  }
  close(): void | Promise<void> {
    this.log.push(`${this.name} close`)
    return this.done(undefined)
  }
}

/** A model of `n` bytes that is not all one byte (so a part at the wrong offset cannot pass), and its pin. */
function model(n: number): { bytes: Uint8Array; pin: PartPin } {
  const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 131 + (i >> 8)) & 0xff)
  return { bytes, pin: { file: 'm.gguf', bytes: n, sha256: sha(bytes) } }
}

/** The part and the note of one directory, kept across writers as the storage keeps them across visits. */
function storage(later = false) {
  const log: string[] = []
  return { log, data: new MemFile('part', log, later), note: new MemFile('note', log, later) }
}

const noteOf = (s: ReturnType<typeof storage>): PartNote | null => parseNote(new TextDecoder().decode(s.note.data))

test('each write is flushed before the note is written; the note counts exactly the bytes written and its hash is over them', async () => {
  const { bytes, pin } = model(10_000)
  const s = storage()
  const w = await openPart(s.data, s.note, pin, () => NOW, 4096)
  assert.deepEqual(w.found, { at: 0, validator: null })
  await w.begin(0, '"e1"')
  let taken = 0
  for (let at = 0; at < bytes.length; at += 777) taken = await w.put(bytes.subarray(at, at + 777))
  assert.equal(taken, bytes.length, 'every byte taken (written or buffered)')
  // Two whole writes so far, each a write, a flush of the part, then the note written, cut and flushed.
  const writes = s.log.filter((l) => l.startsWith('part write'))
  assert.deepEqual(writes, ['part write 0+4096', 'part write 4096+4096'])
  for (const w8 of writes) {
    const i = s.log.indexOf(w8)
    assert.deepEqual(s.log.slice(i + 1, i + 3).map((l) => l.replace(/\d+\+\d+$/, '')), ['part flush', 'note write '], `${w8}: flushed, then noted`)
  }
  const mid = noteOf(s)
  assert.ok(mid)
  assert.equal(mid.at, 8192)
  assert.equal(mid.hash.total, 8192)
  assert.equal(mid.validator, '"e1"')
  assert.ok(forPin(mid, pin))
  const check = sha256Stream(mid.hash)
  check.update(bytes.subarray(8192))
  assert.equal(Buffer.from(check.digest()).toString('hex'), pin.sha256, 'the noted hash is over exactly the bytes noted')
  const end = await w.end()
  assert.deepEqual(end, { bytes: bytes.length, sha256: pin.sha256 })
  assert.deepEqual(s.data.data, bytes)
  assert.equal(noteOf(s)?.at, bytes.length, 'the last write is noted too')
  assert.deepEqual(s.log.slice(-2), ['part close', 'note close'])
  await assert.rejects(w.put(bytes.subarray(0, 1)), /closed/)
})

test('a hold writes what is buffered and notes it; a writer that simply stops (a closed tab) leaves its last write to be picked up', async () => {
  const { bytes, pin } = model(10_000)
  const s = storage()
  const w = await openPart(s.data, s.note, pin, () => NOW, 4096)
  await w.begin(0, '"e1"')
  await w.put(bytes.subarray(0, 5003))
  assert.equal(await w.hold(), 5003, 'everything that arrived is kept, not only the whole writes')
  assert.equal(noteOf(s)?.at, 5003)
  // Picked up: the same validator, from 5003; the next writer stops after one more whole write, without a hold.
  const again = await openPart(s.data, s.note, pin, () => NOW + DAY, 4096)
  assert.deepEqual(again.found, { at: 5003, validator: '"e1"' })
  await again.begin(5003, '"e1"')
  await again.put(bytes.subarray(5003, 9500))
  // 4096 written (to 9099), 401 buffered: the tab closes here.
  assert.equal(noteOf(s)?.at, 9099)
  const third = await openPart(s.data, s.note, pin, () => NOW + DAY, 4096)
  assert.deepEqual(third.found, { at: 9099, validator: '"e1"' }, 'what was buffered and never written is not vouched for')
  await third.begin(9099, '"e1"')
  assert.equal(s.data.data.length, 9099, 'the part is cut back to what its note vouches for')
  await third.put(bytes.subarray(9099))
  assert.deepEqual(await third.end(), { bytes: bytes.length, sha256: pin.sha256 })
  assert.deepEqual(s.data.data, bytes)
})

test('a note is picked up only when everything agrees; anything else starts from the first byte', async () => {
  const { bytes, pin } = model(3000)
  /** A storage holding the first `at` bytes and a note for them, changed by `edit`. */
  const holding = async (at: number, edit: (n: PartNote) => Partial<PartNote> = () => ({})): Promise<ReturnType<typeof storage>> => {
    const s = storage()
    const w = await openPart(s.data, s.note, pin, () => NOW, 1000)
    await w.begin(0, '"e1"')
    await w.put(bytes.subarray(0, at))
    await w.hold()
    const n = noteOf(s)
    assert.ok(n)
    s.note.data = new TextEncoder().encode(noteText({ ...n, ...edit(n) }))
    return s
  }
  const found = async (s: ReturnType<typeof storage>, now = NOW): Promise<{ at: number; validator: string | null }> => (await openPart(s.data, s.note, pin, () => now, 1000)).found
  assert.deepEqual(await found(await holding(1234)), { at: 1234, validator: '"e1"' }, 'everything agrees')
  assert.deepEqual(await found(await holding(1234, () => ({ validator: null }))), { at: 0, validator: null }, 'no validator to ask with')
  assert.deepEqual(await found(await holding(1234, () => ({ sha256: 'f'.repeat(64) }))), { at: 0, validator: null }, 'another pin')
  assert.deepEqual(await found(await holding(1234, () => ({ file: 'other.gguf' }))), { at: 0, validator: null }, 'another file')
  assert.deepEqual(await found(await holding(1234), NOW + (PART_DAYS + 1) * DAY), { at: 0, validator: null }, 'older than PART_DAYS')
  assert.deepEqual(await found(await holding(1234), NOW - 2 * DAY), { at: 0, validator: null }, 'saved in this clock\'s future')
  const short = await holding(1234)
  short.data.data = short.data.data.slice(0, 1200)
  assert.deepEqual(await found(short), { at: 0, validator: null }, 'the part holds less than the note says')
  const tail = await holding(1234)
  tail.data.data[1233] ^= 1
  assert.deepEqual(await found(tail), { at: 0, validator: null }, 'the part\'s last byte is not the one the hash took')
  const junk = await holding(1234)
  junk.note.data = new TextEncoder().encode('{"v":1,"at":12')
  assert.deepEqual(await found(junk), { at: 0, validator: null }, 'a note written halfway')
  const lying = await holding(1234, (n) => ({ at: n.at + 64 }))
  assert.deepEqual(await found(lying), { at: 0, validator: null }, 'a count its hash does not agree with')
  // Starting over empties the part and starts a fresh hash.
  const s = await holding(1234, () => ({ validator: null }))
  const w = await openPart(s.data, s.note, pin, () => NOW, 1000)
  await w.begin(0, '"e2"')
  assert.equal(s.data.data.length, 0)
  await w.put(bytes)
  assert.deepEqual(await w.end(), { bytes: bytes.length, sha256: pin.sha256 })
})

test('a part whose bytes changed on disk since its note is not picked up, wherever the change: every byte the note counts is hashed again', async () => {
  const { bytes, pin } = model(10_000)
  // A writer whose writes are whole blocks of the hash (as WRITE_BYTES is) stops after two of them without a hold (a
  // killed tab): its note holds no tail, so the hash's tail alone would compare no byte of the part at all.
  const killed = async (): Promise<ReturnType<typeof storage>> => {
    const s = storage()
    const w = await openPart(s.data, s.note, pin, () => NOW, 4096)
    await w.begin(0, '"e1"')
    await w.put(bytes.subarray(0, 8192 + 100))
    const n = noteOf(s)
    assert.equal(n?.at, 8192)
    assert.equal(n?.hash.tail, '', 'a whole number of blocks: the hash holds no tail')
    return s
  }
  const found = async (s: ReturnType<typeof storage>): Promise<{ at: number; validator: string | null }> => (await openPart(s.data, s.note, pin, () => NOW, 4096)).found
  assert.deepEqual(await found(await killed()), { at: 8192, validator: '"e1"' }, 'untouched, it is picked up')
  for (const i of [0, 10, 4095, 4096, 8191]) {
    const s = await killed()
    s.data.data[i] ^= 1
    assert.deepEqual(await found(s), { at: 0, validator: null }, `byte ${i} changed: started over`)
  }
  const both = await killed()
  both.data.data[10] ^= 1
  both.data.data[8191] ^= 1
  const over = await openPart(both.data, both.note, pin, () => NOW, 4096)
  assert.deepEqual(over.found, { at: 0, validator: null })
  // Started over, the rest of the file comes from the first byte and ends with the pin's SHA-256 over what is on disk.
  await over.begin(0, '"e1"')
  await over.put(bytes)
  assert.deepEqual(await over.end(), { bytes: bytes.length, sha256: pin.sha256 })
  assert.deepEqual(both.data.data, bytes)
  // A whole part (a Stop that came as the last bytes did) is checked the same before its end gives a SHA-256.
  const whole = storage()
  const w = await openPart(whole.data, whole.note, pin, () => NOW, 4096)
  await w.begin(0, '"e1"')
  await w.put(bytes)
  await w.hold()
  assert.deepEqual(await found(whole), { at: bytes.length, validator: '"e1"' })
  whole.data.data[10] ^= 1
  const changed = await openPart(whole.data, whole.note, pin, () => NOW, 4096)
  assert.deepEqual(changed.found, { at: 0, validator: null }, 'a whole part with a byte changed is not kept as it is')
  await assert.rejects(changed.end(), /not begun/, 'and it has no end until it is written again')
})

test('at the real write size too: a killed tab\'s note after one whole 8 MiB write, its last byte changed on disk, starts over', async () => {
  const { bytes, pin } = model(WRITE_BYTES + 5_000)
  const killed = async (): Promise<ReturnType<typeof storage>> => {
    const s = storage()
    const w = await openPart(s.data, s.note, pin, () => NOW)
    await w.begin(0, '"e1"')
    await w.put(bytes.subarray(0, WRITE_BYTES + 1_000))
    assert.equal(noteOf(s)?.at, WRITE_BYTES)
    assert.equal(noteOf(s)?.hash.tail, '')
    return s
  }
  const s = await killed()
  assert.deepEqual((await openPart(s.data, s.note, pin, () => NOW)).found, { at: WRITE_BYTES, validator: '"e1"' })
  s.data.data[WRITE_BYTES - 1] ^= 1
  assert.deepEqual((await openPart(s.data, s.note, pin, () => NOW)).found, { at: 0, validator: null })
})

test('the writer refuses what does not fit: a begin elsewhere than 0 or what was found, bytes before a begin or past the pin\'s size', async () => {
  const { bytes, pin } = model(3000)
  const s = storage()
  const w = await openPart(s.data, s.note, pin, () => NOW, 1000)
  await assert.rejects(w.put(bytes.subarray(0, 10)), /not begun/)
  await assert.rejects(w.begin(10, '"e1"'), /holds 0 bytes, not 10/)
  await w.begin(0, '"e1"')
  await assert.rejects(w.begin(0, '"e1"'), /begun already/)
  await w.put(bytes)
  await assert.rejects(w.put(Uint8Array.of(1)), RangeError)
  // A part that holds the whole file ends with its SHA-256, nothing written.
  await w.hold()
  const whole = await openPart(s.data, s.note, pin, () => NOW, 1000)
  assert.deepEqual(whole.found, { at: 3000, validator: '"e1"' })
  const writes = s.log.length
  assert.deepEqual(await whole.end(), { bytes: 3000, sha256: pin.sha256 })
  assert.ok(!s.log.slice(writes).some((l) => l.includes('write')), 'nothing written')
})

test('handles whose methods return promises (the first browsers that had them) write and pick up the same', async () => {
  const { bytes, pin } = model(5000)
  const s = storage(true)
  const w = await openPart(s.data, s.note, pin, () => NOW, 1024)
  await w.begin(0, '"e1"')
  await w.put(bytes.subarray(0, 2500))
  assert.equal(await w.hold(), 2500)
  const again = await openPart(s.data, s.note, pin, () => NOW, 1024)
  assert.deepEqual(again.found, { at: 2500, validator: '"e1"' })
  await again.begin(2500, '"e1"')
  await again.put(bytes.subarray(2500))
  assert.deepEqual(await again.end(), { bytes: 5000, sha256: pin.sha256 })
})

test('resumable and the note\'s names: the pin, a validator, saved within PART_DAYS; the part is the model\'s name with .part', () => {
  const pin: PartPin = { file: 'm.gguf', bytes: 10, sha256: 'a'.repeat(64) }
  const hash = sha256Stream().save()
  const n: PartNote = { v: 1, ...pin, at: 0, validator: '"x"', hash, savedAt: NOW }
  // As a plain yes or no (resumable narrows its argument's type, which an assertion of it would carry on).
  const may = (x: PartNote | null, p: PartPin, t: number): boolean => resumable(x, p, t)
  assert.ok(may(n, pin, NOW))
  assert.ok(may(n, pin, NOW + PART_DAYS * DAY))
  assert.ok(!may(n, pin, NOW + PART_DAYS * DAY + 1))
  assert.ok(!may({ ...n, validator: null }, pin, NOW))
  assert.ok(!may(n, { ...pin, bytes: 11 }, NOW))
  assert.ok(!may(null, pin, NOW))
  assert.equal(partName('m.gguf'), 'm.gguf.part')
  assert.deepEqual(parseNote(noteText(n)), n)
  for (const bad of [{ ...n, v: 2 }, { ...n, at: 11 }, { ...n, at: -1 }, { ...n, bytes: 0 }, { ...n, validator: '' }, { ...n, sha256: 'A'.repeat(64) }, { ...n, savedAt: 'now' }, { ...n, hash: { ...hash, total: 5 } }]) {
    assert.equal(parseNote(JSON.stringify(bad)), null, JSON.stringify(bad).slice(0, 80))
  }
})
