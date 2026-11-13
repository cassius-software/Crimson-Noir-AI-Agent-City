// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the page's own start of the site's model (siteAuto.ts) to its rules: the
 * connection is read from whatever the browser offers and only data saver, mobile data and a 2G link hold it back;
 * the verdict refuses, in order, a browser that cannot run it, a provider or a model file of the visitor's own (chosen
 * or kept), a file being kept, a copy kept already, a page that cannot keep one and a page that cannot keep the
 * record; the record between visits remembers the visitor's Stop, waits an hour then a day after tries that ended
 * short and gives up after three, counts a page that closed mid-way (a mark with no lock held behind it) once however
 * many tabs judge it and gives up after two, tells a tab still getting it from a page that died, lets one tab try at a
 * time (a tapped download holds the lock too), reads its holds again once the lock is held, and never throws when the
 * storage does; and the start itself (createSiteAuto) waits to be seen, stops at every hold before anything is asked
 * of the site, reads the facts again once it holds the lock, stops on a costly connection, and records and says how
 * each try ended. The storage, the locks and the page are fakes, the job is the real one over a work the test steps;
 * two records over one storage are two tabs, a fresh lock manager is a browser whose earlier page is gone.
 * What breaks if it is removed? A phone on mobile data, a device that dies in the copy or a visitor who said Stop could
 * be handed the download again on every visit, with no test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AUTO_KEY, AUTO_LOCK, BACKOFF_MS, STOPPED, autoVerdict, createAutoRecord, createSiteAuto, linkHold, readLink, type AutoFacts, type AutoHost, type AutoLocks, type AutoRecord, type AutoStore, type AutoTry, type Link } from './siteAuto.ts'
import { createSiteJob, SiteJobHeld, type SiteGet, type SiteJobHow } from './siteJob.ts'
import { SITE_MODEL, type SiteModelProgress } from './siteModel.ts'

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
const facts = (o: Partial<AutoFacts> = {}): AutoFacts => ({ cannot: null, provider: 'auto', own: null, busy: null, kept: false, lasting: true, remembers: true, link: null, ...o })
/** A try, from begin's answer (a string is why there is none). */
function tryOf(t: AutoTry | string): AutoTry {
  assert.equal(typeof t, 'object', `a try begins, not: ${String(t)}`)
  return t as AutoTry
}
/** Steps until `pred` holds (a few hundred turns at most). */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 300 && !pred(); i++) await tick()
  assert.ok(pred(), what)
}

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

test('autoVerdict goes only where the browser can run and keep it, nothing else was chosen or kept, and the connection does not say the data costs', () => {
  assert.deepEqual(autoVerdict(facts()), { go: true })
  assert.deepEqual(autoVerdict(facts({ provider: 'inpage' })), { go: true }, 'the in-page provider with no file chosen yet')
  assert.deepEqual(autoVerdict(facts({ own: SITE_MODEL.file })), { go: true }, 'the site\'s own file chosen but gone from the store')
  assert.deepEqual(autoVerdict(facts({ link: { type: 'wifi', saveData: false, effectiveType: '4g' } })), { go: true })
  const why = (f: AutoFacts): string => {
    const v = autoVerdict(f)
    assert.equal(v.go, false)
    return v.go ? '' : v.why
  }
  assert.equal(why(facts({ cannot: 'this browser lacks JSPI' })), 'this browser lacks JSPI')
  assert.match(why(facts({ provider: 'scripted' })), /scripted provider is chosen/)
  for (const p of ['claude', 'ollama', 'llamacpp', 'openai', 'something-new']) assert.match(why(facts({ provider: p })), new RegExp(`the ${p} provider is chosen`))
  assert.match(why(facts({ own: 'my-own-7b.gguf' })), /a model file of your own \(my-own-7b\.gguf\) is in this page/)
  assert.equal(why(facts({ busy: 'a model file is being kept in this page just now' })), 'a model file is being kept in this page just now')
  assert.match(why(facts({ kept: true })), /is kept in this page already/)
  assert.match(why(facts({ lasting: false })), /cannot keep files for the page, so the model would download again on every visit/)
  assert.match(why(facts({ remembers: false })), /cannot keep the page's record of it, so a Stop could not be remembered/)
  assert.match(why(facts({ link: { type: 'cellular', saveData: false, effectiveType: '4g' } })), /mobile data/)
  // In order: the browser, the provider, the visitor's own file, a keep under way, the copy, lasting, the record, the connection.
  assert.equal(why(facts({ cannot: 'no runtime', provider: 'scripted' })), 'no runtime')
  assert.match(why(facts({ provider: 'ollama', own: 'x.gguf' })), /ollama/)
  assert.match(why(facts({ own: 'x.gguf', busy: 'busy', kept: true })), /of your own/)
  assert.equal(why(facts({ busy: 'busy', kept: true })), 'busy')
  assert.match(why(facts({ kept: true, lasting: false })), /kept in this page already/)
  assert.match(why(facts({ lasting: false, remembers: false })), /cannot keep files/)
  assert.match(why(facts({ remembers: false, link: { type: 'cellular', saveData: true, effectiveType: '2g' } })), /record/)
})

test('the record: nothing held at first; one try at a time; kept clears it; the visitor\'s Stop is remembered', async () => {
  const store = memoryStore()
  const locks = lockManager()
  const rec = createAutoRecord(store, locks)
  assert.equal(rec.remembers(), true)
  assert.equal(await rec.hold(0), null)
  const t = tryOf(await rec.begin(1000))
  assert.ok(locks.held.has(AUTO_LOCK), 'the try holds the lock while it runs')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 1000, lock: AUTO_LOCK } }, 'marked with its lock')
  assert.equal(await rec.begin(1001), 'it is being got in this tab already', 'a second try in the same tab waits for the first')
  // Another tab of the same browser: the mark has its lock held behind it, so it is a try running, not a page that died.
  const other = createAutoRecord(store, locks)
  assert.equal(await other.hold(1002), 'another tab is getting it')
  assert.equal(await other.begin(1002), 'another tab is getting it', 'and its lock is not free')
  t.end('done', 2000)
  await tick()
  assert.equal(store.map.has(AUTO_KEY), false, 'kept: nothing left in the record')
  assert.equal(locks.held.has(AUTO_LOCK), false, 'and the lock is let go')
  t.end('failed', 2001)
  assert.equal(store.map.has(AUTO_KEY), false, 'a try ends once')
  tryOf(await rec.begin(3000)).end('stopped', 3100)
  assert.equal(await rec.hold(4000), STOPPED)
  assert.equal(await createAutoRecord(store, lockManager()).hold(10 * 24 * HOUR), STOPPED, 'remembered on later visits')
  assert.equal(store.map.has(`${AUTO_KEY}:probe`), false, 'remembers() leaves nothing behind')
})

test('the record: a try that ended short waits an hour, a second a day, and a third leaves it to the button', async () => {
  const store = memoryStore()
  const rec = createAutoRecord(store, lockManager())
  const fail = async (at: number): Promise<void> => {
    tryOf(await rec.begin(at)).end('failed', at)
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
  // A paused try (the network changed, a choice, the city ended) counts for nothing.
  const store2 = memoryStore()
  const rec2 = createAutoRecord(store2, lockManager())
  tryOf(await rec2.begin(0)).end('paused', 0)
  assert.equal(await rec2.hold(1), null)
  assert.equal(store2.map.has(AUTO_KEY), false)
  // After three, not even begin starts one (it reads the holds again once the lock is its own).
  assert.match(String(await rec.begin(200 * 24 * HOUR)), /waits for the button/)
  // Kept after a failure: the failures are forgotten.
  tryOf(await rec2.begin(1)).end('failed', 1)
  await tick()
  tryOf(await rec2.begin(1 + BACKOFF_MS[0])).end('done', 2 + BACKOFF_MS[0])
  assert.equal(await rec2.hold(3 + BACKOFF_MS[0]), null)
  assert.equal(store2.map.has(AUTO_KEY), false)
})

test('the record: a page that closed mid-way is counted once, lets the next visit try again, and the second leaves it to the button', async () => {
  const store = memoryStore()
  const first = createAutoRecord(store, lockManager())
  tryOf(await first.begin(0)) // a try begins, and the page dies in it (no pagehide, no end)
  // The next visit: a new page in a browser whose earlier page (and its lock) is gone.
  const second = createAutoRecord(store, lockManager())
  assert.equal(await second.hold(10), null, 'one page that died: the next visit tries once more')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 }, 'counted, and its mark taken away')
  assert.equal(await second.hold(11), null, 'counted once')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 })
  tryOf(await second.begin(20)) // and dies again
  const third = createAutoRecord(store, lockManager())
  assert.match((await third.hold(30)) ?? '', /the page closed while it was getting the model, twice, so it waits for the button/)
  // A try that runs to its end, whatever its outcome, starts the count again; a pause does not.
  const s2 = memoryStore()
  tryOf(await createAutoRecord(s2, lockManager()).begin(0))
  const b = createAutoRecord(s2, lockManager())
  assert.equal(await b.hold(1), null)
  tryOf(await b.begin(2)).end('paused', 3)
  assert.deepEqual(JSON.parse(s2.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 }, 'a pause keeps the count')
  await tick()
  tryOf(await b.begin(4)).end('failed', 5)
  assert.deepEqual(JSON.parse(s2.map.get(AUTO_KEY) ?? '{}'), { v: 1, fails: 1, failedAt: 5 }, 'a try that ended (short) is no page that died')
})

test('the record: two tabs that judge the same dead mark count it once; a mark that changed while one looked is not counted', async () => {
  // Locks whose query waits until the test lets it go: both tabs read the mark before either has counted it.
  const slow = (): AutoLocks & { go: () => void } => {
    const base = lockManager()
    const waiting: (() => void)[] = []
    return { ...base, query: () => new Promise((resolve) => { waiting.push(() => resolve({ held: [] })) }), go: () => { for (const w of waiting.splice(0)) w() } }
  }
  const store = memoryStore()
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, mark: { at: 5, lock: AUTO_LOCK } }))
  const locks = slow()
  const a = createAutoRecord(store, locks), b = createAutoRecord(store, locks)
  const ha = a.hold(10), hb = b.hold(10)
  await tick()
  locks.go()
  assert.deepEqual([await ha, await hb], [null, null])
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 }, 'one page died, one counted, never two')
  // While a tab looks, another tab's try ends (its mark goes, its outcome is written): no kill is counted for it.
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, mark: { at: 7, lock: AUTO_LOCK } }))
  const locks2 = slow()
  const c = createAutoRecord(store, locks2)
  const hc = c.hold(20)
  await tick()
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, fails: 1, failedAt: 19 }))
  locks2.go()
  assert.match((await hc) ?? '', /ended short/)
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, fails: 1, failedAt: 19 }, 'no kill that never happened')
  // And one whose mark another tab replaced with its own while it looked: that tab's try is running.
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, mark: { at: 8, lock: AUTO_LOCK } }))
  const locks3 = slow()
  const d = createAutoRecord(store, locks3)
  const hd = d.hold(30)
  await tick()
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, mark: { at: 9, lock: AUTO_LOCK } }))
  locks3.go()
  assert.equal(await hd, 'another tab is getting it')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 9, lock: AUTO_LOCK } }, 'its live mark is left alone')
})

test('the record: begin reads the holds again once the lock is its own, so a Stop or a failure another tab wrote meanwhile holds it back', async () => {
  const store = memoryStore()
  const locks = lockManager()
  const a = createAutoRecord(store, locks)
  assert.equal(await a.hold(0), null)
  // Another tab's try ended short between this tab's hold and its begin.
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, fails: 1, failedAt: 1 }))
  assert.match(String(await a.begin(2)), /ended short: the next one is in 60 minutes/)
  assert.equal(locks.held.has(AUTO_LOCK), false, 'the lock is let go')
  assert.equal(JSON.parse(store.map.get(AUTO_KEY) ?? '{}').mark, undefined, 'and nothing is marked')
  // Or the visitor pressed Stop there.
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, off: STOPPED }))
  assert.equal(await a.begin(3), STOPPED)
  await tick()
  assert.equal(locks.held.has(AUTO_LOCK), false)
})

test('the record: a tapped download holds the lock while it is free, so another tab\'s page does not start beside it', async () => {
  const store = memoryStore()
  const locks = lockManager()
  const tab = createAutoRecord(store, locks)
  const release = await tab.claim()
  assert.ok(locks.held.has(AUTO_LOCK), 'the tap holds the lock')
  assert.equal(store.map.has(AUTO_KEY), false, 'and leaves no mark (a tap the system ends is not the page\'s try)')
  assert.equal(await tab.begin(0), 'it is being got in this tab already')
  const other = createAutoRecord(store, locks)
  assert.equal(await other.hold(0), null)
  assert.equal(await other.begin(0), 'another tab is getting it')
  // A second claim while it is held (another tab's tap) holds nothing, and its release lets nothing go.
  const none = await other.claim()
  none()
  assert.ok(locks.held.has(AUTO_LOCK))
  release()
  release()
  await tick()
  assert.equal(locks.held.has(AUTO_LOCK), false, 'let go once the tap ends')
  tryOf(await other.begin(1)).end('done', 2)
  // Without Web Locks a claim holds nothing.
  ;(await createAutoRecord(store, null).claim())()
})

test('the record: a page that unloads mid-way (pagehide) takes its mark with it, so it is not counted as one that died', async () => {
  const store = memoryStore()
  const locks = lockManager()
  const rec = createAutoRecord(store, locks)
  tryOf(await rec.begin(0))
  // Another tab with no try of its own closes while this one runs: this tab's mark stays.
  const quiet = createAutoRecord(store, locks)
  quiet.leave()
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 0, lock: AUTO_LOCK } }, 'a tab with no try takes nothing')
  rec.leave()
  assert.equal(store.map.has(AUTO_KEY), false)
  assert.equal(await createAutoRecord(store, lockManager()).hold(1), null)
  assert.equal(store.map.has(AUTO_KEY), false, 'nothing counted')
  // A leave after another tab's mark replaced its own takes nothing.
  const again = createAutoRecord(store, lockManager())
  tryOf(await again.begin(50))
  store.map.set(AUTO_KEY, JSON.stringify({ v: 1, mark: { at: 99, lock: AUTO_LOCK } }))
  again.leave()
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 99, lock: AUTO_LOCK } })
})

test('the record without Web Locks marks its try with no lock (any mark found is a page that died) and never throws when the storage does', async () => {
  const store = memoryStore()
  const rec = createAutoRecord(store, null)
  const t = tryOf(await rec.begin(0))
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 0, lock: null } })
  assert.equal(await rec.begin(1), 'it is being got in this tab already', 'one try at a time in a tab, locks or none')
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, mark: { at: 0, lock: null } }, 'its mark untouched')
  t.end('paused', 2)
  tryOf(await rec.begin(3))
  assert.equal(await createAutoRecord(store, null).hold(4), null)
  assert.deepEqual(JSON.parse(store.map.get(AUTO_KEY) ?? '{}'), { v: 1, kills: 1 })
  // Unreadable or odd records are nothing held.
  for (const raw of ['not json', '[1,2]', 'null', '{"v":1,"fails":-3,"kills":"x","off":""}']) {
    const s = memoryStore()
    s.map.set(AUTO_KEY, raw)
    assert.equal(await createAutoRecord(s, lockManager()).hold(0), null, raw)
  }
  const broken = createAutoRecord(memoryStore(true), lockManager())
  assert.equal(broken.remembers(), false, 'a storage that refuses cannot remember a Stop')
  assert.equal(createAutoRecord(null, lockManager()).remembers(), false, 'nor can no storage')
  assert.equal(await broken.hold(0), null)
  tryOf(await broken.begin(0)).end('failed', 1)
  broken.leave()
  // Locks that throw are no locks granted: no try.
  const bad: AutoLocks = { request: () => { throw new Error('denied') }, query: async () => { throw new Error('denied') } }
  assert.equal(await createAutoRecord(memoryStore(), bad).begin(0), 'another tab is getting it')
})

/** A work the test steps, for the real job (siteJob.ts). */
function steppedWork(): { get: SiteGet; calls: { how: SiteJobHow; progress: (p: SiteModelProgress) => void; signal: AbortSignal; resolve: (line: string) => void; reject: (e: unknown) => void }[] } {
  const calls: ReturnType<typeof steppedWork>['calls'] = []
  const get: SiteGet = (how, progress, signal) => new Promise<string>((resolve, reject) => { calls.push({ how, progress, signal, resolve, reject }) })
  return { get, calls }
}

const WIFI: Link = { type: 'wifi', saveData: false, effectiveType: '4g' }
const CELL: Link = { type: 'cellular', saveData: false, effectiveType: '4g' }

/** A page for createSiteAuto: every step it asks is logged, each answer can be swapped. */
function page(o: { facts?: () => AutoFacts; host?: Partial<AutoHost> } = {}) {
  const store = memoryStore()
  const locks = lockManager()
  const rec = createAutoRecord(store, locks)
  const calls: string[] = []
  const record: AutoRecord = {
    hold: (n) => { calls.push('hold'); return rec.hold(n) },
    begin: (n) => { calls.push('begin'); return rec.begin(n) },
    claim: () => rec.claim(),
    remembers: () => rec.remembers(),
    leave: () => rec.leave(),
  }
  const work = steppedWork()
  const job = createSiteJob(work.get)
  const said: string[] = []
  const state = { link: WIFI as Link | null, offline: false, changed: null as (() => void) | null }
  const h: AutoHost = {
    seen: async () => { calls.push('seen') },
    ended: () => null,
    served: () => { calls.push('served'); return true },
    facts: async () => { calls.push('facts'); return o.facts ? o.facts() : facts({ link: state.link }) },
    offer: async () => { calls.push('offer'); return { kept: false } },
    refusal: async () => { calls.push('refusal'); return null },
    link: () => state.link,
    onLink: (cb) => { calls.push('onLink'); state.changed = cb; return () => { calls.push('unlink'); state.changed = null } },
    offline: () => state.offline,
    record,
    job,
    say: (l) => { said.push(l) },
    now: () => 10 * 24 * HOUR,
    ...o.host,
  }
  return { h, calls, store, locks, work, job, said, state, saved: () => JSON.parse(store.map.get(AUTO_KEY) ?? 'null') as Record<string, unknown> | null }
}

test('the start: once seen, the facts, the record, the manifest, the room, the lock, the facts again, then the job; kept, said, and the record cleared', async () => {
  const p = page()
  const auto = createSiteAuto(p.h)
  const run = auto()
  await until(() => p.work.calls.length === 1, 'the job is started')
  assert.deepEqual(p.calls, ['seen', 'served', 'facts', 'hold', 'offer', 'refusal', 'begin', 'facts', 'onLink'])
  assert.equal(p.work.calls[0].how, 'auto')
  assert.deepEqual(p.saved()?.mark, { at: 10 * 24 * HOUR, lock: AUTO_LOCK }, 'marked while it runs')
  p.work.calls[0].resolve('Qwen2.5-0.5B-Instruct-Q4_K_M.gguf is kept in this page (379 MB)')
  assert.equal(await run, 'Qwen2.5-0.5B-Instruct-Q4_K_M.gguf is kept in this page (379 MB)')
  assert.equal(p.calls.at(-1), 'unlink', 'it stops listening to the connection once the job ends')
  assert.deepEqual(p.said, ['Qwen2.5-0.5B-Instruct-Q4_K_M.gguf is kept in this page (379 MB)'], 'the toast says what was kept')
  assert.equal(p.saved(), null, 'kept: nothing left in the record')
  assert.equal(await auto(), 'the page has looked already this visit', 'once a city')
  assert.equal(p.work.calls.length, 1)
})

test('the start waits until the page is seen, and a city that ended or halted starts nothing', async () => {
  let show!: () => void
  const p = page({ host: { seen: () => new Promise<void>((resolve) => { show = resolve }) } })
  const run = createSiteAuto(p.h)()
  for (let i = 0; i < 20; i++) await tick()
  assert.deepEqual(p.calls, [], 'nothing is read or asked while the page is in the background')
  show()
  await until(() => p.work.calls.length === 1, 'then it goes')
  p.work.calls[0].resolve('kept')
  await run
  for (const why of ['the city ended', 'the city halted']) {
    const q = page({ host: { ended: () => why } })
    assert.equal(await createSiteAuto(q.h)(), why)
    assert.deepEqual(q.calls, ['seen'], 'nothing read, nothing asked')
  }
  // A halt while it asks: the lock is its own, but the job is never started, and the try is only paused.
  let halted: string | null = null
  const r = page({ host: { ended: () => halted, refusal: async () => { halted = 'the city halted'; return null } } })
  assert.equal(await createSiteAuto(r.h)(), 'the city halted')
  assert.equal(r.work.calls.length, 0)
  assert.equal(r.saved(), null, 'a pause counts for nothing')
  assert.equal(r.locks.held.has(AUTO_LOCK), false)
})

test('the start stops at each hold before the site is asked for anything, and starts no job', async () => {
  const cases: { name: string; p: ReturnType<typeof page>; want: RegExp; asked: string[] }[] = []
  const add = (name: string, p: ReturnType<typeof page>, want: RegExp, asked: string[]): void => { cases.push({ name, p, want, asked }) }
  add('not the web copy', page({ host: { served: () => false } }), /only the web copy/, ['seen'])
  add('on mobile data', page({ facts: () => facts({ link: CELL }) }), /mobile data/, ['seen', 'served', 'facts'])
  add('a model server chosen', page({ facts: () => facts({ provider: 'ollama' }) }), /ollama provider is chosen/, ['seen', 'served', 'facts'])
  add('a file of the visitor\'s own kept', page({ facts: () => facts({ own: 'mine.gguf' }) }), /of your own \(mine\.gguf\)/, ['seen', 'served', 'facts'])
  add('a record it cannot keep', page({ facts: () => facts({ remembers: false }) }), /record/, ['seen', 'served', 'facts'])
  const stopped = page()
  stopped.store.map.set(AUTO_KEY, JSON.stringify({ v: 1, off: STOPPED }))
  add('the visitor stopped it before', stopped, new RegExp(STOPPED), ['seen', 'served', 'facts', 'hold'])
  add('no model beside the page', page({ host: { offer: async () => null } }), /serves no model/, ['seen', 'served', 'facts', 'hold'])
  add('kept already, by the manifest\'s look', page({ host: { offer: async () => ({ kept: true }) } }), /kept in this page already/, ['seen', 'served', 'facts', 'hold'])
  add('another tab holds the lock', page(), /another tab is getting it/, ['seen', 'served', 'facts', 'hold', 'offer', 'refusal', 'begin'])
  add('no room', page({ host: { refusal: async () => 'the page\'s storage has room for 100 MB' } }), /room for 100 MB/, ['seen', 'served', 'facts', 'hold', 'offer'])
  const blocker = cases.find((c) => c.name === 'another tab holds the lock')?.p
  assert.ok(blocker)
  const releaseOther = await createAutoRecord(blocker.store, blocker.locks).claim()
  for (const c of cases) {
    const run = createSiteAuto(c.p.h)()
    // Bounded: a start that went past its hold would wait on the stepped work for ever.
    const out = await Promise.race([run, new Promise<string>((resolve) => setTimeout(() => resolve('it went on to the job'), 200))])
    assert.match(out, c.want, c.name)
    assert.equal(c.p.work.calls.length, 0, `${c.name}: no job`)
    if (c.p !== blocker) assert.equal(c.p.locks.held.has(AUTO_LOCK), false, `${c.name}: no lock`)
    // Exactly the steps before the hold, nothing after: the manifest is never asked before the record's holds.
    assert.deepEqual(c.p.calls.filter((x) => x !== 'onLink' && x !== 'unlink'), c.asked, `${c.name}: what it asked`)
  }
  releaseOther()
  // A job running already (a tap that came first), or another tab holding the lock.
  // A job running already in this tab (a tap that came first).
  const tapped = page()
  void tapped.job.start('tap')
  const out = await Promise.race([createSiteAuto(tapped.h)(), new Promise<string>((resolve) => setTimeout(() => resolve('it waited on the tap\'s job'), 200))])
  assert.equal(out, 'it is being got already')
  assert.equal(tapped.work.calls.length, 1, 'the tap\'s, and no other')
  assert.ok(!tapped.calls.includes('begin'), 'and no try of its own begins')
})

test('the start reads the facts again once the lock is its own: what changed while it asked holds it back, as a pause', async () => {
  for (const [name, late, want] of [
    ['the connection turned to mobile data', facts({ link: CELL }), /mobile data/],
    ['the visitor chose a model server', facts({ provider: 'claude' }), /claude provider/],
    ['the visitor picked a file of their own', facts({ busy: 'a model file is being kept in this page just now' }), /being kept/],
    ['another tab kept it', facts({ kept: true }), /kept in this page already/],
  ] as const) {
    let n = 0
    const p = page({ facts: () => (++n === 1 ? facts({ link: WIFI }) : late) })
    const out = await Promise.race([createSiteAuto(p.h)(), new Promise<string>((resolve) => setTimeout(() => resolve('it went on to the job'), 200))])
    assert.match(out, want, name)
    assert.equal(p.work.calls.length, 0, `${name}: no job`)
    assert.equal(p.saved(), null, `${name}: a pause, nothing counted`)
    await tick()
    assert.equal(p.locks.held.has(AUTO_LOCK), false, `${name}: the lock let go`)
  }
})

test('the start: the visitor\'s Stop is remembered; the connection turning costly stops it as a pause, and says so', async () => {
  const p = page()
  const run = createSiteAuto(p.h)()
  await until(() => p.work.calls.length === 1, 'started')
  p.state.changed?.()
  assert.equal(p.job.state()?.phase, 'running', 'a change that is not costly changes nothing')
  p.state.link = CELL
  p.state.changed?.()
  assert.equal(p.job.state()?.phase, 'stopped', 'mobile data stops it')
  assert.equal(p.work.calls[0].signal.aborted, true)
  p.work.calls[0].reject(p.work.calls[0].signal.reason)
  assert.equal(await run, 'stopped (network)')
  assert.equal(p.saved(), null, 'a pause: nothing counted')
  assert.match(p.said.join(' | '), /^Sloane's model waits: this device is on mobile data; the page gets it on a later visit, or now with the button on Sloane's card$/)
  const q = page()
  const run2 = createSiteAuto(q.h)()
  await until(() => q.work.calls.length === 1, 'started')
  assert.ok(q.job.stop('person'))
  q.work.calls[0].reject(new DOMException('stopped', 'AbortError'))
  assert.equal(await run2, 'stopped (person)')
  assert.equal(q.saved()?.off, STOPPED, 'the visitor\'s Stop is remembered')
  assert.deepEqual(q.said, [], 'and needs no toast')
})

test('the start: a try that ended short is counted and said, unless the connection says why (then a pause); a choice made meanwhile is a pause; a tap that came first is the visitor\'s', async () => {
  const p = page()
  const run = createSiteAuto(p.h)()
  await until(() => p.work.calls.length === 1, 'started')
  p.work.calls[0].reject(new Error('its SHA-256 differs from the one this page was built for'))
  assert.match(await run, /SHA-256 differs/)
  assert.equal(p.saved()?.fails, 1, 'counted')
  assert.deepEqual(p.said, ['Sloane\'s model was not kept: its SHA-256 differs from the one this page was built for'])
  // The network dropped it (Chrome cuts a fetch when the network changes, often before the change is told).
  for (const [name, set] of [['offline', (q: ReturnType<typeof page>) => { q.state.offline = true }], ['now on mobile data', (q: ReturnType<typeof page>) => { q.state.link = CELL }]] as const) {
    const q = page()
    const r = createSiteAuto(q.h)()
    await until(() => q.work.calls.length === 1, 'started')
    set(q)
    q.work.calls[0].reject(new TypeError('Failed to fetch'))
    assert.match(await r, /^paused: /, name)
    assert.equal(q.saved(), null, `${name}: nothing counted`)
    assert.match(q.said.join(' | '), /^Sloane's model waits: /, `${name}: said`)
  }
  // The work held itself back (the visitor chose a provider while it came): a pause, no toast.
  const c = page()
  const rc = createSiteAuto(c.h)()
  await until(() => c.work.calls.length === 1, 'started')
  c.work.calls[0].reject(new SiteJobHeld('choice', 'the ollama provider is chosen'))
  assert.equal(await rc, 'stopped (choice)')
  assert.equal(c.saved(), null)
  assert.deepEqual(c.said, [])
  // A tap that started the job once the lock was this tab's (as the facts were read again): the end is the tap's.
  let reads = 0
  const t = page({ facts: () => { if (++reads === 2) void t.job.start('tap'); return facts({ link: WIFI }) } })
  const rt = createSiteAuto(t.h)()
  await until(() => t.work.calls.length === 1, 'the tap\'s job')
  t.work.calls[0].reject(new Error('the site did not send the model (HTTP 503)'))
  await rt
  assert.equal(t.work.calls[0].how, 'tap')
  assert.equal(t.work.calls.length, 1, 'one job, the tap\'s')
  assert.equal(t.saved(), null, 'a tap\'s failure is not the page\'s')
  assert.deepEqual(t.said, [], 'and its card says why, not a toast')
})
