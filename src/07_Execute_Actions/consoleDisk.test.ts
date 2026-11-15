// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the console's disk store (consoleDisk.ts) to the three promises its header
 * makes, over a stand-in for the browser's IndexedDB small enough to read (requests answer a moment later, a
 * transaction's writes land together when it completes or not at all): a page that fell behind is told 'stale' and
 * writes nothing; a store that could not be read refuses the load and is never written over; a read that fails inside
 * a save leaves nothing unhandled; a console made again in the same page loads what was last saved; an image set
 * aside lands under its own key.
 * The real IndexedDB is exercised by the browser smoke run, not here.
 * What breaks if it is removed? The generation check could be dropped or reordered and two tabs would quietly lose
 * one tab's files.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONSOLE_DISK_DB, OPEN_MS, consoleDisk } from './consoleDisk.ts'

interface FakeRequest { onsuccess: (() => void) | null; onerror: (() => void) | null; result: unknown; error: Error | null }

/** How the stand-in behaves when asked to open. */
type Opening = 'ok' | 'refuse' | 'silent' | 'throw'

interface FakeIdb {
  factory: IDBFactory
  /** The rows of each database's one store, by database name. */
  rows: Map<string, Map<string, unknown>>
  opening: Opening
  /** Writes are refused (a full disk): the transaction aborts. */
  full: boolean
  /** Reads are refused. */
  unreadable: boolean
  opens: number
}

function fakeIdb(): FakeIdb {
  const idb: FakeIdb = { factory: null as unknown as IDBFactory, rows: new Map(), opening: 'ok', full: false, unreadable: false, opens: 0 }
  const later = (fn: () => void): void => queueMicrotask(fn)
  const database = (name: string) => {
    const stores = new Set<string>(idb.rows.has(name) ? ['disk'] : [])
    return {
      objectStoreNames: { contains: (s: string) => stores.has(s) },
      createObjectStore: (s: string) => { stores.add(s); if (!idb.rows.has(name)) idb.rows.set(name, new Map()) },
      close: () => {},
      onversionchange: null as (() => void) | null,
      transaction: (_store: string, _mode: string) => {
        const rows = idb.rows.get(name) ?? new Map<string, unknown>()
        const staged = new Map<string, unknown>()
        const tx = { oncomplete: null as (() => void) | null, onerror: null as (() => void) | null, onabort: null as (() => void) | null, error: null as Error | null }
        let pending = 0
        let over = false
        const settleSoon = (): void => later(() => later(() => later(() => {
          if (over || pending > 0) return
          over = true
          for (const [k, v] of staged) rows.set(k, v)
          tx.oncomplete?.()
        })))
        const ask = (fn: () => unknown): FakeRequest => {
          const r: FakeRequest = { onsuccess: null, onerror: null, result: undefined, error: null }
          pending++
          later(() => {
            pending--
            if (over) return
            try {
              r.result = fn()
              r.onsuccess?.()
              settleSoon()
            } catch (e) {
              over = true
              r.error = e as Error
              tx.error = e as Error
              r.onerror?.()
              tx.onabort?.()
            }
          })
          return r
        }
        settleSoon()
        return {
          ...tx,
          set oncomplete(fn: (() => void) | null) { tx.oncomplete = fn },
          set onerror(fn: (() => void) | null) { tx.onerror = fn },
          set onabort(fn: (() => void) | null) { tx.onabort = fn },
          get error() { return tx.error },
          objectStore: () => ({
            get: (key: string) => ask(() => {
              if (idb.unreadable) throw new Error('read refused')
              return staged.has(key) ? staged.get(key) : rows.get(key)
            }),
            put: (value: unknown, key: string) => ask(() => {
              if (idb.full) throw new Error('quota exceeded')
              staged.set(key, structuredClone(value))
            }),
          }),
        }
      },
    }
  }
  idb.factory = {
    open: (name: string) => {
      idb.opens++
      if (idb.opening === 'throw') throw new Error('storage is off')
      const r = { onupgradeneeded: null as (() => void) | null, onsuccess: null as (() => void) | null, onerror: null as (() => void) | null, onblocked: null as (() => void) | null, result: null as unknown, error: null as Error | null }
      if (idb.opening === 'silent') return r
      later(() => {
        if (idb.opening === 'refuse') { r.error = new Error('refused'); r.onerror?.(); return }
        r.result = database(name)
        if (!idb.rows.has(name)) r.onupgradeneeded?.()
        r.onsuccess?.()
      })
      return r
    },
  } as unknown as IDBFactory
  return idb
}

/** A timer the test fires by hand. */
function timers(): { wait: (fn: () => void, ms: number) => void; fire(): void; ms: number[] } {
  const fns: (() => void)[] = []
  const t = { ms: [] as number[], wait: (fn: () => void, ms: number) => { fns.push(fn); t.ms.push(ms) }, fire: () => { for (const fn of fns.splice(0)) fn() } }
  return t
}

const bytes = (...b: number[]): Uint8Array => Uint8Array.of(...b)

test('nothing stored: load gives null, the first save is kept, and another visit loads it', async () => {
  const idb = fakeIdb()
  const t = timers()
  const one = consoleDisk(idb.factory, t.wait)
  assert.equal(idb.opens, 0, 'nothing is opened until the disk is asked for')
  assert.equal(await one.load(), null)
  assert.deepEqual(t.ms, [OPEN_MS])
  assert.equal(await one.save(bytes(1, 2, 3)), 'kept')
  assert.equal(await one.save(bytes(4, 5)), 'kept')
  assert.ok(idb.rows.has(CONSOLE_DISK_DB))
  const two = consoleDisk(idb.factory, t.wait)
  assert.deepEqual([...(await two.load() ?? [])], [4, 5])
  // Asked twice, read once.
  const again = two.load()
  assert.equal(again, two.load())
  // The timer firing after the store answered changes nothing.
  t.fire()
  assert.equal(await two.save(bytes(6)), 'kept')
})

test('two pages: the one that fell behind is told stale and writes nothing over the newer disk', async () => {
  const idb = fakeIdb()
  const t = timers()
  const a = consoleDisk(idb.factory, t.wait)
  const b = consoleDisk(idb.factory, t.wait)
  await a.load()
  await b.load()
  assert.equal(await a.save(bytes(1)), 'kept')
  assert.equal(await b.save(bytes(2)), 'stale')
  assert.equal(await b.save(bytes(2)), 'stale', 'and stays so')
  assert.equal(await a.save(bytes(3)), 'kept')
  const c = consoleDisk(idb.factory, t.wait)
  assert.deepEqual([...(await c.load() ?? [])], [3])
  // The same from a saved disk: both load generation 2, one saves, the other is behind.
  const d = consoleDisk(idb.factory, t.wait)
  await d.load()
  assert.equal(await c.save(bytes(4)), 'kept')
  assert.equal(await d.save(bytes(5)), 'stale')
})

test('a store that cannot be read is never written over: refused, thrown, silent, or a read that fails', async () => {
  // Unread is not empty: the load is refused (so the console can say at once that its files are not kept), never null.
  for (const opening of ['refuse', 'throw', 'silent'] as const) {
    const idb = fakeIdb()
    const t = timers()
    idb.opening = opening
    const d = consoleDisk(idb.factory, t.wait)
    const loading = d.load()
    // A browser that never answers is given up on when the timer fires.
    if (opening === 'silent') { await Promise.resolve(); t.fire() }
    await assert.rejects(loading, Error, opening)
    assert.equal(await d.save(bytes(1)), 'failed', opening)
    assert.equal(await d.setAside(bytes(1)), false, opening)
    assert.equal(idb.rows.size, 0, opening)
  }
  const none = consoleDisk(null, timers().wait)
  await assert.rejects(none.load(), /no storage/)
  assert.equal(await none.save(bytes(1)), 'failed')

  const idb = fakeIdb()
  const t = timers()
  const first = consoleDisk(idb.factory, t.wait)
  await first.load()
  assert.equal(await first.save(bytes(7, 7)), 'kept')
  idb.unreadable = true
  const second = consoleDisk(idb.factory, t.wait)
  await assert.rejects(second.load(), /read refused/, 'unread, not empty')
  idb.unreadable = false
  assert.equal(await second.save(bytes(0)), 'failed')
  const third = consoleDisk(idb.factory, t.wait)
  assert.deepEqual([...(await third.load() ?? [])], [7, 7], 'what was there is still there')
})

test('a read that fails inside a save answers failed and leaves no refusal unhandled; the next save can still be kept', async () => {
  const unhandled: unknown[] = []
  const seen = (e: unknown): void => { unhandled.push(e) }
  process.on('unhandledRejection', seen)
  try {
    const idb = fakeIdb()
    const d = consoleDisk(idb.factory, timers().wait)
    await d.load()
    assert.equal(await d.save(bytes(1)), 'kept')
    idb.unreadable = true
    assert.equal(await d.save(bytes(2)), 'failed')
    idb.unreadable = false
    // Give a refusal nobody caught the turns it takes to be reported.
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(unhandled, [], 'the aborted transaction was waited on')
    assert.equal(await d.save(bytes(3)), 'kept')
    const e = consoleDisk(idb.factory, timers().wait)
    assert.deepEqual([...(await e.load() ?? [])], [3])
  } finally {
    process.off('unhandledRejection', seen)
  }
})

test('a console made again in the same page (the terminal mounted anew) loads the disk as last saved, never the first read of it', async () => {
  const idb = fakeIdb()
  const d = consoleDisk(idb.factory, timers().wait)
  // The first console: nothing stored, then two saves.
  assert.equal(await d.load(), null)
  assert.equal(await d.save(bytes(1)), 'kept')
  assert.equal(await d.save(bytes(1, 2)), 'kept')
  // The terminal is mounted again and its new session asks the one store of the page for the disk: it must get what
  // was saved, or its first save would put the first visit's disk back over the newer one.
  assert.deepEqual([...(await d.load() ?? [])], [1, 2])
  assert.equal(await d.save(bytes(1, 2, 3)), 'kept')
  const other = consoleDisk(idb.factory, timers().wait)
  assert.deepEqual([...(await other.load() ?? [])], [1, 2, 3])
  assert.equal(idb.opens, 2, 'one connection for each store: a second load does not open the database again')
})

test('a full disk fails the save and leaves the stored image as it was; the next save can still be kept', async () => {
  const idb = fakeIdb()
  const t = timers()
  const d = consoleDisk(idb.factory, t.wait)
  await d.load()
  assert.equal(await d.save(bytes(1)), 'kept')
  idb.full = true
  assert.equal(await d.save(bytes(2)), 'failed')
  idb.full = false
  assert.equal(await d.save(bytes(3)), 'kept')
  const e = consoleDisk(idb.factory, t.wait)
  assert.deepEqual([...(await e.load() ?? [])], [3])
})

test('an image set aside lands under its own key and does not count as a save; a row of another shape reads as nothing stored', async () => {
  const idb = fakeIdb()
  const t = timers()
  const d = consoleDisk(idb.factory, t.wait)
  await d.load()
  assert.equal(await d.save(bytes(9)), 'kept')
  assert.equal(await d.setAside(bytes(6, 6, 6)), true)
  const rows = idb.rows.get(CONSOLE_DISK_DB)
  assert.ok(rows !== undefined)
  assert.deepEqual([...rows.keys()].sort(), ['image', 'refused'])
  assert.deepEqual([...(rows.get('refused') as { bytes: Uint8Array }).bytes], [6, 6, 6])
  assert.equal(await d.save(bytes(10)), 'kept', 'setting aside moved no generation')
  idb.full = true
  assert.equal(await d.setAside(bytes(1)), false)
  idb.full = false
  rows.set('image', { gen: 'two', bytes: 'text' })
  const e = consoleDisk(idb.factory, t.wait)
  assert.equal(await e.load(), null)
  assert.equal(await e.save(bytes(11)), 'kept')
})
