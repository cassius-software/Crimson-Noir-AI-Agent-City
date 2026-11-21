// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is where the console's disk (terminal/os/, the files under / and the home directory)
 * is kept between visits: one image in the page's own IndexedDB, written whole. Three things could lose a person's
 * files, and each is closed here. Two tabs of the site: every image is stored with a generation number, and a save
 * is one transaction that reads the stored generation first and writes only if it is the one this page loaded or
 * last saved, so a tab that fell behind is told 'stale' and writes nothing over the newer disk. A store that could
 * not be read (the browser refused it, the read failed, it never answered): the load is refused, so the console can
 * say at once that its files are not kept, and saving is refused for the visit, because an image that may still be
 * there must not be replaced by an empty disk. An image that fails the system's own checks: it is copied under
 * another key before anything is saved, so it can be looked at later, and never over a copy kept before (up to
 * REFUSED_MAX of them). A console made again in the same page (the terminal mounted anew) loads the disk afresh: it
 * gets what was last saved, never the first read of it. Nothing here waits on the browser for longer than OPEN_MS:
 * the load (opening and reading), each save and each copy set aside are given up on after it, so the console can tell
 * the person when a store stops answering instead of waiting on it for good; a write that lands after that still keeps
 * this page's generation in step with the stored one.
 * The image is the page's own data in the page's own storage: nothing here sends anything anywhere.
 * What breaks if it is removed? The console's files last only as long as the page: a reload starts an empty disk.
 */
import type { DiskStore } from './terminal/commands.ts'

/** The database and its one object store; the saved image and the copies of refused ones are rows of it. */
export const CONSOLE_DISK_DB = 'civic-simulation:console-disk'
const STORE = 'disk'
const IMAGE = 'image'
/** The first refused image is kept under this key; each later, different one under `refused:` and its last bytes. */
const REFUSED = 'refused'
/** The most refused images kept: past it, a refused image is not copied and the stored one is left where it is. */
export const REFUSED_MAX = 8
/** How long the browser gets to answer (to open the database and read the image, to save, to copy an image aside). */
export const OPEN_MS = 4000

/** A stored image: the bytes and the count of saves that made them. */
interface Row { gen: number; bytes: Uint8Array }

const request = <T>(r: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  r.onsuccess = () => resolve(r.result)
  r.onerror = () => reject(r.error ?? new Error('the request failed'))
})

const finished = (t: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  t.oncomplete = () => resolve()
  t.onerror = () => reject(t.error ?? new Error('the transaction failed'))
  t.onabort = () => reject(t.error ?? new Error('the transaction was aborted'))
})

/** A stored row as an image, or null when the row is not one (nothing stored, or a shape this code did not write). */
function rowOf(value: unknown): Row | null {
  if (typeof value !== 'object' || value === null) return null
  const { gen, bytes } = value as { gen?: unknown; bytes?: unknown }
  if (typeof gen !== 'number' || !Number.isSafeInteger(gen) || gen < 1) return null
  if (bytes instanceof Uint8Array) return { gen, bytes }
  if (bytes instanceof ArrayBuffer) return { gen, bytes: new Uint8Array(bytes) }
  return null
}

const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i])

/** The key a refused image is kept under when the first holds another: its last eight bytes (its seal's end) in hex. */
const asideKey = (image: Uint8Array): string =>
  `${REFUSED}:${Array.from(image.subarray(Math.max(0, image.length - 8)), (x) => x.toString(16).padStart(2, '0')).join('')}`

/**
 * The console's disk store over a browser's IndexedDB (`factory`: window.indexedDB, or nothing where the browser has
 * none). `wait` is the timer every wait on the browser is bounded by (the page's setTimeout). Nothing is opened until
 * `load`.
 */
export function consoleDisk(factory: IDBFactory | null | undefined, wait: (fn: () => void, ms: number) => unknown, name: string = CONSOLE_DISK_DB): DiskStore {
  let db: IDBDatabase | null = null
  /** The generation this page loaded or last saved: 0 when nothing was stored. */
  let gen = 0
  /** Whether the stored image is known (read, or known absent): only then may it be written over. */
  let known = false
  let loading: Promise<Uint8Array | null> | null = null

  /**
   * One wait of OPEN_MS on the browser: `race(p)` settles as `p` does, or is refused with 'the storage did not answer'
   * once the wait is over; `over` says whether it is, for what `p` started (a database that opens after it is closed).
   */
  const bound = (): { race<T>(p: Promise<T>): Promise<T>; readonly over: boolean } => {
    let over = false
    const late = new Promise<never>((_, reject) => {
      wait(() => {
        over = true
        reject(new Error('the storage did not answer'))
      }, OPEN_MS)
    })
    // The browser usually answers first, and then nothing waits on this refusal: it must not be reported as unhandled.
    late.catch(() => {})
    return { race: (p) => Promise.race([p, late]), get over() { return over } }
  }

  /** Opens the database; `stopped` says whether the console has stopped waiting, so a late connection is closed. */
  const open = (stopped: () => boolean): Promise<IDBDatabase> => new Promise((resolve, reject) => {
    if (!factory) { reject(new Error('this browser has no storage for the page')); return }
    let settled = false
    const settle = (fn: () => void): void => { if (!settled) { settled = true; fn() } }
    let opening: IDBOpenDBRequest
    try {
      opening = factory.open(name, 1)
    } catch (e) {
      settle(() => reject(e instanceof Error ? e : new Error(String(e))))
      return
    }
    opening.onupgradeneeded = () => {
      if (!opening.result.objectStoreNames.contains(STORE)) opening.result.createObjectStore(STORE)
    }
    opening.onerror = () => settle(() => reject(opening.error ?? new Error('the storage refused to open')))
    opening.onblocked = () => settle(() => reject(new Error('the storage is held by another page')))
    opening.onsuccess = () => {
      const opened = opening.result
      // Another page that needs the database changed must not wait on this one.
      opened.onversionchange = () => opened.close()
      if (settled || stopped()) opened.close()
      else settle(() => resolve(opened))
    }
  })

  const load = async (): Promise<Uint8Array | null> => {
    // One wait bounds the opening and the read together: a browser that answers neither must not hold the console up.
    const limit = bound()
    try {
      db ??= await limit.race(open(() => limit.over))
      const row = rowOf(await limit.race(request(db.transaction(STORE, 'readonly').objectStore(STORE).get(IMAGE))))
      gen = row?.gen ?? 0
      known = true
      return row?.bytes ?? null
    } catch (e) {
      // Unread is not the same as empty: nothing is written over what may still be there, and the caller is told.
      known = false
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  /**
   * One save's transaction: it reads the stored generation and writes the image only over the one this page loaded or
   * last saved. The page's generation moves when the write has landed, even after the save was given up on, so it stays
   * the stored one and the page's next save is not told 'stale' over its own late write.
   */
  const write = async (into: IDBDatabase, image: Uint8Array): Promise<'kept' | 'stale'> => {
    const t = into.transaction(STORE, 'readwrite')
    const done = finished(t)
    // A read that fails aborts the transaction while nothing waits on it yet: the refusal is answered below, not left unhandled.
    done.catch(() => {})
    const store = t.objectStore(STORE)
    const stored = rowOf(await request(store.get(IMAGE)))
    // Another page saved since this one loaded: its disk is newer, and this page writes nothing over it.
    if ((stored?.gen ?? 0) !== gen) {
      await done.catch(() => {})
      return 'stale'
    }
    const row: Row = { gen: gen + 1, bytes: image }
    store.put(row, IMAGE)
    await done
    gen = row.gen
    return 'kept'
  }

  /**
   * Copies a refused image aside in one transaction, never over a different copy: the first under REFUSED, each later
   * one under its own key (asideKey). The same bytes again add nothing. False when REFUSED_MAX copies are kept already,
   * or when its key holds another image.
   */
  const aside = async (into: IDBDatabase, image: Uint8Array): Promise<boolean> => {
    const t = into.transaction(STORE, 'readwrite')
    const done = finished(t)
    done.catch(() => {})
    const store = t.objectStore(STORE)
    const first = rowOf(await request(store.get(REFUSED)))
    let key = REFUSED
    if (first !== null) {
      if (same(first.bytes, image)) return true
      key = asideKey(image)
      const there = rowOf(await request(store.get(key)))
      if (there !== null) return same(there.bytes, image)
      const keys = await request(store.getAllKeys())
      const kept = keys.filter((k) => k === REFUSED || (typeof k === 'string' && k.startsWith(`${REFUSED}:`))).length
      if (kept >= REFUSED_MAX) return false
    }
    store.put({ gen: Math.max(1, gen), bytes: image }, key)
    await done
    return true
  }

  return {
    // Asked again while a read is on its way: that read. Asked again after it (a new session of the console): a new one,
    // so a disk saved since is what comes back, with its generation.
    load: () => (loading ??= load().finally(() => { loading = null })),
    async save(image) {
      if (!known || db === null) return 'failed'
      try {
        // A store that never answers is a failed save, so the console counts it and can say when it gives up.
        return await bound().race(write(db, image))
      } catch {
        return 'failed'
      }
    },
    async setAside(image) {
      if (db === null) return false
      try {
        return await bound().race(aside(db, image))
      } catch {
        // The copy could not be kept (or the store did not answer): the caller leaves the stored image where it is.
        return false
      }
    },
  }

}
