// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the page's own start of the site's model (siteAuto.ts) to its rules: the
 * connection is read from whatever the browser offers and only data saver, mobile data and a 2G link hold it back;
 * the verdict refuses, in order, a browser that cannot run it, a provider or a model file the visitor chose, a copy
 * kept already and a page that cannot keep one; and the record between visits remembers the visitor's Stop, waits an
 * hour then a day after tries that ended short and gives up after three, counts a page that closed mid-way (a mark with
 * no lock held behind it) once and gives up after two, tells a tab still getting it from a page that died, lets one tab
 * try at a time, and never throws when the storage does. The storage and the locks are fakes; two records over one
 * storage are two tabs, a fresh lock manager is a browser whose earlier page is gone.
 * What breaks if it is removed? A phone on mobile data, a device that dies in the copy or a visitor who said Stop could
 * be handed the download again on every visit, with no test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTO_KEY, AUTO_LOCK, BACKOFF_MS, STOPPED, autoVerdict, createAutoRecord, linkHold, readLink, type AutoFacts, type AutoLocks, type AutoStore } from './siteAuto.ts'
import { SITE_MODEL } from './siteModel.ts'

/** A page's local storage in memory; `broken` makes every call throw. */
function memoryStore(broken = false): AutoStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  const fail = (): never => { throw new Error('storage refused') }
  return {
    map,
    getItem: (k) => (broken ? fail() : map.get(k) ?? null),
    setItem: (k, v) => { if (broken) fail(); map.set(k, v) },
    removeItem: (k) => { if (broken) fail(); map.delete(k) },
  }
}

/** Web Locks in memory, shared by the tabs of one browser: ifAvailable grants a free name, and null for a held one. */
function lockManager(): AutoLocks & { held: Set<string> } {
  const held = new Set<string>()
  return {
    held,
    request: async (name, _options, granted) => {
      if (held.has(name)) return granted(null)
      held.add(name)
      try {
        return await granted({ name })
      } finally {
        held.delete(name)
      }
    },
    query: async () => ({ held: [...held].map((name) => ({ name })) }),
  }
}

const HOUR = 60 * 60 * 1000
/** A turn of the event loop: a lock let go is free again once its request's promise has settled. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))
const facts = (o: Partial<AutoFacts> = {}): AutoFacts => ({ cannot: null, provider: 'auto', chosen: null, kept: false, lasting: true, link: null, ...o })

test('readLink reads what the browser says of the connection, and null where it says nothing', () => {
  assert.equal(readLink(undefined), null)
  assert.equal(readLink(null), null)
  assert.equal(readLink({}), null)
  assert.equal(readLink({ connection: 'wifi' }), null)
  assert.deepEqual(readLink({ connection: {} }), { type: null, saveData: false, effectiveType: null })
  assert.deepEqual(readLink({ connection: { type: 'cellular', saveData: true, effectiveType: '4g' } }), { type: 'cellular', saveData: true, effectiveType: '4g' })
  assert.deepEqual(readLink({ connection: { type: 7, saveData: 'yes', effectiveType: null } }), { type: null, saveData: false, effectiveType: null })
  // A navigator whose connection getter throws is a browser that says nothing.
  assert.equal(readLink({ get connection(): unknown { throw new Error('denied') } }), null)
})

test('linkHold holds back on data saver, mobile data and a 2G link, and nothing else', () => {
  assert.equal(linkHold(null), null)
  assert.equal(linkHold({ type: null, saveData: false, effectiveType: null }), null, 'Firefox, Safari, Brave: nothing said, nothing held')
  assert.equal(linkHold({ type: 'wifi', saveData: false, effectiveType: '4g' }), null)
  assert.equal(linkHold({ type: 'ethernet', saveData: false, effectiveType: '3g' }), null)
  assert.equal(linkHold({ type: null, saveData: false, effectiveType: '4g' }), null, 'desktop Chrome says no type')
  assert.match(linkHold({ type: 'wifi', saveData: true, effectiveType: '4g' }) ?? '', /save data/)
  assert.match(linkHold({ type: 'cellular', saveData: false, effectiveType: '4g' }) ?? '', /mobile data/)
  assert.match(linkHold({ type: null, saveData: false, effectiveType: '2g' }) ?? '', /too slow/)
  assert.match(linkHold({ type: null, saveData: false, effectiveType: 'slow-2g' }) ?? '', /too slow/)
})

test('autoVerdict goes only where the browser can run and keep it, nothing else was chosen, and the connection does not say the data costs', () => {
  assert.deepEqual(autoVerdict(facts()), { go: true })
  assert.deepEqual(autoVerdict(facts({ provider: 'inpage' })), { go: true }, 'the in-page provider with no file chosen yet')
  assert.deepEqual(autoVerdict(facts({ chosen: SITE_MODEL.file })), { go: true }, 'the site\'s own file chosen but gone from the store')
  assert.deepEqual(autoVerdict(facts({ link: { type: 'wifi', saveData: false, effectiveType: '4g' } })), { go: true })
  const why = (f: AutoFacts): string => {
    const v = autoVerdict(f)
    assert.equal(v.go, false)
    return v.go ? '' : v.why
  }
  assert.equal(why(facts({ cannot: 'this browser lacks JSPI' })), 'this browser lacks JSPI')
  assert.match(why(facts({ provider: 'scripted' })), /scripted provider is chosen/)
  for (const p of ['claude', 'ollama', 'llamacpp', 'openai', 'something-new']) assert.match(why(facts({ provider: p })), new RegExp(`the ${p} provider is chosen`))
  assert.match(why(facts({ chosen: 'my-own-7b.gguf' })), /a model file of your own \(my-own-7b\.gguf\) is chosen/)
  assert.match(why(facts({ kept: true })), /is kept in this page already/)
  assert.match(why(facts({ lasting: false })), /cannot keep files for the page, so the model would download again on every visit/)
  assert.match(why(facts({ link: { type: 'cellular', saveData: false, effectiveType: '4g' } })), /mobile data/)
  // In order: the browser before the provider, the provider before the file, the file before the copy, the copy before the connection.
  assert.equal(why(facts({ cannot: 'no runtime', provider: 'scripted' })), 'no runtime')
  assert.match(why(facts({ provider: 'ollama', chosen: 'x.gguf' })), /ollama/)
  assert.match(why(facts({ chosen: 'x.gguf', kept: true })), /of your own/)
  assert.match(why(facts({ kept: true, lasting: false })), /kept in this page already/)
  assert.match(why(facts({ lasting: false, link: { type: 'cellular', saveData: true, effectiveType: '2g' } })), /cannot keep files/)
})

test('the record: nothing held at first; one try at a time; kept clears it; the visitor\'s Stop is remembered', async () => {
  const store = memoryStore()
  const locks = lockManager()
  const rec = createAutoRecord(store, locks)
  assert.equal(await rec.hold(0), null)
  const t = await rec.begin(1000)
  assert.ok(t, 'the first try begins')
  assert.ok(locks.held.has(AUTO_LOCK), 'and holds the lock while it runs')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 1000, lock: AUTO_LOCK } }, 'marked with its lock')
  assert.equal(await rec.begin(1001), null, 'a second try in the same tab waits for the first')
  // Another tab of the same browser: the mark has its lock held behind it, so it is a try running, not a page that died.
  const other = createAutoRecord(store, locks)
  assert.equal(await other.hold(1002), 'another tab is getting it')
  assert.equal(await other.begin(1002), null, 'and its lock is not free')
  t.end('done', 2000)
  await tick()
  assert.equal(store.map.has(AUTO_KEY), false, 'kept: nothing left in the record')
  assert.equal(locks.held.has(AUTO_LOCK), false, 'and the lock is let go')
  t.end('failed', 2001)
  assert.equal(store.map.has(AUTO_KEY), false, 'a try ends once')
  const s = await rec.begin(3000)
  assert.ok(s)
  s.end('stopped', 3100)
  assert.equal(await rec.hold(4000), STOPPED)
  assert.equal(await createAutoRecord(store, lockManager()).hold(10 * 24 * HOUR), STOPPED, 'remembered on later visits')
})

test('the record: a try that ended short waits an hour, a second a day, and a third leaves it to the button', async () => {
  const store = memoryStore()
  const rec = createAutoRecord(store, lockManager())
  const fail = async (at: number): Promise<void> => {
    const t = await rec.begin(at)
    assert.ok(t)
    t.end('failed', at)
    await tick()
  }
  await fail(0)
  assert.match((await rec.hold(1)) ?? '', /the last try to get it ended short: the next one is in 60 minutes, or now with the button/)
  assert.match((await rec.hold(BACKOFF_MS[0] - 30 * 60_000)) ?? '', /in 30 minutes/)
  assert.equal(await rec.hold(BACKOFF_MS[0]), null, 'an hour later it tries again')
  await fail(BACKOFF_MS[0])
  assert.match((await rec.hold(BACKOFF_MS[0] + 1)) ?? '', /in 24 hours/)
  assert.equal(await rec.hold(BACKOFF_MS[0] + BACKOFF_MS[1]), null, 'a day later it tries again')
  await fail(BACKOFF_MS[0] + BACKOFF_MS[1])
  assert.match((await rec.hold(100 * 24 * HOUR)) ?? '', /the last tries to get it ended short, so it waits for the button/, 'after three, for good')
  // A paused try (the network changed, the city ended) counts for nothing.
  const store2 = memoryStore()
  const rec2 = createAutoRecord(store2, lockManager())
  const p = await rec2.begin(0)
  assert.ok(p)
  p.end('paused', 0)
  assert.equal(await rec2.hold(1), null)
  assert.equal(store2.map.has(AUTO_KEY), false)
  // Kept after a failure: the failures are forgotten.
  const ok = await rec.begin(200 * 24 * HOUR)
  assert.ok(ok)
  ok.end('done', 200 * 24 * HOUR)
  assert.equal(await rec.hold(200 * 24 * HOUR), null)
})

test('the record: a page that closed mid-way is counted once, lets the next visit try again, and the second leaves it to the button', async () => {
  const store = memoryStore()
  const first = createAutoRecord(store, lockManager())
  assert.ok(await first.begin(0), 'a try begins, and the page dies in it (no pagehide, no end)')
  // The next visit: a new page in a browser whose earlier page (and its lock) is gone.
  const second = createAutoRecord(store, lockManager())
  assert.equal(await second.hold(10), null, 'one page that died: the next visit tries once more')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 }, 'counted, and its mark taken away')
  assert.equal(await second.hold(11), null, 'counted once')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 })
  assert.ok(await second.begin(20), 'and dies again')
  const third = createAutoRecord(store, lockManager())
  assert.match((await third.hold(30)) ?? '', /the page closed while it was getting the model, twice, so it waits for the button/)
  // A try that runs to its end, whatever its outcome, starts the count again; a pause does not.
  const s2 = memoryStore()
  const a = createAutoRecord(s2, lockManager())
  assert.ok(await a.begin(0))
  const b = createAutoRecord(s2, lockManager())
  assert.equal(await b.hold(1), null)
  const pausing = await b.begin(2)
  assert.ok(pausing)
  pausing.end('paused', 3)
  assert.deepEqual(JSON.parse(s2.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 }, 'a pause keeps the count')
  await tick()
  const failing = await b.begin(4)
  assert.ok(failing)
  failing.end('failed', 5)
  assert.deepEqual(JSON.parse(s2.map.get(AUTO_KEY) ?? '{}'), { v: 1, fails: 1, failedAt: 5 }, 'a try that ended (short) is no page that died')
})

test('the record: a page that unloads mid-way (pagehide) takes its mark with it, so it is not counted as one that died', async () => {
  const store = memoryStore()
  const rec = createAutoRecord(store, lockManager())
  assert.ok(await rec.begin(0))
  rec.leave()
  assert.equal(store.map.has(AUTO_KEY), false)
  assert.equal(await createAutoRecord(store, lockManager()).hold(1), null)
  assert.equal(store.map.has(AUTO_KEY), false, 'nothing counted')
  // A leave with no try of its own, or after another tab's mark replaced it, takes nothing.
  const quiet = createAutoRecord(store, lockManager())
  quiet.leave()
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, mark: { at: 99, lock: AUTO_LOCK } }))
  rec.leave()
  assert.ok(store.map.has(AUTO_KEY))
})

test('the record without Web Locks marks its try with no lock (any mark found is a page that died) and never throws when the storage does', async () => {
  const store = memoryStore()
  const rec = createAutoRecord(store, null)
  const t = await rec.begin(0)
  assert.ok(t)
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 0, lock: null } })
  assert.equal(await createAutoRecord(store, null).hold(1), null)
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 })
  // Unreadable or odd records are nothing held.
  for (const raw of ['not json', '[1,2]', 'null', '{"v":1,"fails":-3,"kills":"x","off":""}']) {
    const s = memoryStore()
    s.map.set(AUTO_KEY, raw)
    assert.equal(await createAutoRecord(s, lockManager()).hold(0), null, raw)
  }
  const broken = createAutoRecord(memoryStore(true), lockManager())
  assert.equal(await broken.hold(0), null)
  const b = await broken.begin(0)
  assert.ok(b, 'a storage that refuses still lets this visit try')
  b.end('failed', 1)
  broken.leave()
  // Locks that throw are no locks granted: no try.
  const bad: AutoLocks = { request: () => { throw new Error('denied') }, query: async () => { throw new Error('denied') } }
  assert.equal(await createAutoRecord(memoryStore(), bad).begin(0), null)
})
