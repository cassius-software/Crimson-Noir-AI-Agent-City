// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the brain readout (brainReadout.ts) reads and never asks: over the real router
 * (router.ts), the real native provider (nativeMind.ts) and the real site job (siteJob.ts), with every fetch, every
 * provider's list and answer, the shell's runner, the job's start and the site's offer throwing once the readout is
 * made, every read and every subscription passes without calling any of them, and still has not once the calls a
 * provider starts a turn or more later (the shell's native_model, an answer) have had time to arrive. Each provider
 * maps to its brain and its line: auto before a look, during one and after (Ollama, llama.cpp, an OpenAI-compatible
 * server, the app's model, the model kept in this page, the Claude gateway, which is never called local, and nothing,
 * which is the scripted planner, unless the page has kept its default model since: then the next answer looks again),
 * and each provider chosen at the console, which is the scripted planner, said with why, where the page already knows
 * its model cannot run (the app's runner failed or is absent, this page cannot run a model or keeps none). The default
 * model's states (kept, getting with its step and count, checking, held and why, waiting, none) follow the site's job
 * and the app's runner, the app's first; a page served none says none, and a default got this visit then forgotten is
 * held, not kept. Each job change, each change of what the app says of its model (its check during an answer, the
 * check done) and a forget tell a subscriber once, an unsubscribe stops it, `ask model auto` and a look stopped part
 * way each leave no look standing (never the scripted planner), the accessor answers BRAIN_UNKNOWN until App.tsx binds
 * a store, App.tsx tells the readout of a keep, a forget and the app's check, and the module imports types only, so
 * the walk can import it for nothing.
 * What breaks if it is removed? A readout that started a look or a download, or named the wrong brain, would pass.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { Answer, Mind } from '../07_Execute_Actions/operator.ts'
import { BRAIN_UNKNOWN, bindBrain, buildBrain, createBrainReadout, readBrain, subscribeBrain, type BrainFacts, type BrainReadout, type SiteFacts } from './brainReadout.ts'
import { CLAUDE_GATEWAY, DEFAULT_CLAUDE_MODEL } from './claudeApi.ts'
import { ANY_MODEL, DEFAULT_MODEL, DEFAULT_SERVER, type FetchLike } from './localCompute.ts'
import { createNativeMind, NO_RUNNER, type NativeHost, type NativeMind } from './nativeMind.ts'
import { createMindRouter, INPAGE_SERVER, LLAMACPP_SERVER, OPENAI_SERVER, type MindRouter } from './router.ts'
import { createSiteJob, type SiteJob, type SiteJobState } from './siteJob.ts'

/** A machine of model servers by port, each listing these models (absent: nothing listens there). */
function machine(servers: Record<string, readonly string[]>): FetchLike {
  return async (url, init) => {
    const s = servers[new URL(url).port]
    if (init?.mode === 'no-cors') {
      if (!s) throw new TypeError('Failed to fetch')
      return new Response(null, { status: 200 })
    }
    if (!s) throw new TypeError('Failed to fetch')
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: s.map((name) => ({ name })) }), { status: 200 })
    if (url.endsWith('/v1/models') || url.includes('/v1/models?')) return new Response(JSON.stringify({ data: s.map((id) => ({ id })) }), { status: 200 })
    return new Response('?', { status: 404 })
  }
}

/** What the app's runner says it carries (null: none; absent: no runner at all). */
type Carried = { file: string; bytes: number; status: { state: string; done?: number; total?: number; reason?: string; refused?: boolean } } | null

/**
 * The page's router, its app's model and its model kept in this page, over `servers`: until `arm()`, a test's own look
 * and settings reach them; from then on every fetch, every list and answer, every call of the shell's runner throws
 * and is noted in `calls`, which must stay empty.
 */
function rig(servers: Record<string, readonly string[]>, o: { app?: Carried; page?: string | (() => string | null) } = {}) {
  let armed = false
  const calls: string[] = []
  const trip = (what: string): never => {
    calls.push(what)
    throw new Error(`the readout called ${what}`)
  }
  const net = machine(servers)
  const fetch: FetchLike = async (url, init) => (armed ? trip(`fetch ${url}`) : net(url, init))
  const host: NativeHost | null = o.app === undefined ? null : {
    model: async () => (armed ? trip('native_model') : o.app),
    generate: async () => trip('native_generate'),
    stop: async () => trip('native_stop'),
  }
  const keptNow = typeof o.page === 'function' ? o.page : () => (o.page as string | undefined) ?? null
  const page: Mind = {
    settings: () => ({ server: INPAGE_SERVER, model: keptNow(), runtime: 'this browser runs it (one thread)', storage: keptNow() === null ? 'none' : 'kept in this page' }),
    setServer: () => { throw new Error('no server') },
    setModel: (name: string) => name,
    installed: async () => { const kept = keptNow(); return armed ? trip('inpage installed') : kept === null ? [] : [kept] },
    answer: async (): Promise<Answer> => trip('inpage answer'),
  }
  let native!: NativeMind
  const router = createMindRouter({ fetch, inPage: () => page, native: () => (native = createNativeMind({ host })) })
  return { router, native, calls, arm: () => { armed = true } }
}

/** A site source whose offer and whose job's start and stop throw when called (the readout must never call them). */
function siteOf(facts: () => SiteFacts, job: SiteJob, calls: string[]) {
  const no = (what: string) => (): never => {
    calls.push(what)
    throw new Error(`the readout called ${what}`)
  }
  return {
    facts,
    offer: no('offer'),
    job: { state: () => job.state(), subscribe: (l: () => void) => job.subscribe(l), start: no('start'), stop: no('stop') },
  }
}

/** The facts of a site that serves this page its model, nothing kept, nothing decided yet. */
const SITE: SiteFacts = Object.freeze({ from: 'site', file: 'site-model.gguf', title: 'Site Model', bytes: 400, served: true, refusal: null, offered: null, kept: false, decided: null })

/**
 * Lets a call a read might have started a microtask or more later reach `calls` before a test says none was made: the
 * native provider asks the shell's native_model a turn after its call, and the router awaits its cache and the
 * measurement before any fetch, list or answer.
 */
const settle = (): Promise<void> => new Promise((res) => setTimeout(res, 20))
/** The line under auto before a look stands (none yet, or `ask model auto` or a look stopped part way set one aside). */
const NOT_LOOKED = 'Sloane has found no model yet: her next answer looks on this machine'

/** Reads the readout `n` times through every path (read, subscribe, the accessor); returns the last. */
function readMany(store: ReturnType<typeof createBrainReadout>, n = 20): BrainReadout {
  const off = store.subscribe(() => {})
  const unbind = bindBrain(store)
  const unsub = subscribeBrain(() => {})
  let r = store.read()
  for (let i = 0; i < n; i++) {
    r = store.read()
    assert.equal(readBrain(), r, 'the accessor reads the bound store, the same object while nothing changed')
  }
  unsub()
  unbind()
  off()
  return r
}

test('before anything is bound the accessor says nothing is known yet, and binding and unbinding tell its readers', () => {
  assert.equal(readBrain(), BRAIN_UNKNOWN)
  assert.deepEqual({ ...BRAIN_UNKNOWN }, { provider: null, settled: false, brain: null, local: false, gateway: false, server: null, model: null, where: "Sloane's brain is not known yet: the page has not built her mind", downloading: null, default: null })
  assert.ok(Object.isFrozen(BRAIN_UNKNOWN))
  const { router } = rig({})
  let heard = 0
  const unsub = subscribeBrain(() => { heard++ })
  const first = createBrainReadout({ router })
  const unbindFirst = bindBrain(first)
  assert.equal(heard, 1, 'binding tells the readers')
  assert.equal(readBrain().provider, 'auto')
  const second = createBrainReadout({ router })
  bindBrain(second)
  assert.equal(heard, 2)
  unbindFirst()
  assert.equal(heard, 2, "an older city's unbind leaves the store bound since")
  assert.equal(readBrain().provider, 'auto')
  router.setProvider('scripted')
  assert.equal(heard, 3, "the bound store's change reaches the accessor's readers")
  first.dispose()
  router.setProvider('auto')
  assert.equal(heard, 4, 'only the bound store is heard')
  bindBrain(null)
  assert.equal(heard, 5)
  assert.equal(readBrain(), BRAIN_UNKNOWN)
  unsub()
  second.dispose()
})

test('auto before its first look: not settled, and the line says the next answer looks; reading it asks nothing', async () => {
  const r = rig({ 11434: [DEFAULT_MODEL] })
  r.arm()
  const got = readMany(createBrainReadout({ router: r.router, native: r.native }))
  await settle()
  assert.deepEqual(r.calls, [])
  assert.equal(got.provider, 'auto')
  assert.equal(got.settled, false)
  assert.equal(got.brain, null)
  assert.equal(got.local, false)
  assert.equal(got.server, null, "Ollama's address is not said before a look found it")
  assert.equal(got.model, null)
  assert.equal(got.where, NOT_LOOKED)
  assert.ok(Object.isFrozen(got))
})

/** A look the test makes itself (before arming), then the readout read many times with everything armed. */
async function afterLook(servers: Record<string, readonly string[]>, o: { app?: Carried; page?: string } = {}): Promise<BrainReadout> {
  const r = rig(servers, o)
  await r.router.installed().catch(() => [])
  r.arm()
  const got = readMany(createBrainReadout({ router: r.router, native: r.native }))
  await settle()
  assert.deepEqual(r.calls, [], 'the readout made no request and asked no provider')
  return got
}

test('auto after a look: each provider it finds is the right brain, with its address or file and its line', async () => {
  const ollama = await afterLook({ 11434: [DEFAULT_MODEL] })
  assert.deepEqual([ollama.settled, ollama.brain, ollama.local, ollama.gateway, ollama.server, ollama.model], [true, 'server', true, false, DEFAULT_SERVER, DEFAULT_MODEL])
  assert.equal(ollama.where, `Sloane answers with ollama at ${DEFAULT_SERVER} (${DEFAULT_MODEL}), a model server on this machine`)

  const llama = await afterLook({ 8080: ['tiny-llama'] })
  assert.deepEqual([llama.brain, llama.local, llama.server, llama.model], ['server', true, LLAMACPP_SERVER, null], "the server's placeholder is no name until an answer says which model it is")
  assert.equal(ANY_MODEL, 'default', 'the readout knows the placeholder by this name')
  assert.equal(llama.where, `Sloane answers with llamacpp at ${LLAMACPP_SERVER}, a model server on this machine`)

  const studio = await afterLook({ 1234: ['studio-model'] })
  assert.deepEqual([studio.brain, studio.local, studio.server, studio.model], ['server', true, OPENAI_SERVER, null])
  assert.match(studio.where, /^Sloane answers with openai at http:\/\/localhost:1234, a model server on this machine$/)

  const app = await afterLook({}, { app: { file: 'app-model.gguf', bytes: 986, status: { state: 'ready' } } })
  assert.deepEqual([app.brain, app.local, app.gateway, app.server, app.model], ['app', true, false, null, 'app-model.gguf'])
  assert.equal(app.where, 'Sloane answers with the model this app carries (app-model.gguf), run by the app on this device')
  assert.deepEqual(app.default, { from: 'native', file: 'app-model.gguf', title: 'app-model.gguf', bytes: 986, state: 'kept', step: null, done: 0, total: 0, why: null })

  const page = await afterLook({}, { page: 'mine.gguf' })
  assert.deepEqual([page.brain, page.local, page.server, page.model], ['page', true, null, 'mine.gguf'])
  assert.equal(page.where, 'Sloane answers with the model kept in this page (mine.gguf), run on this device')

  const gateway = await afterLook({ 8089: ['m-one'] })
  assert.deepEqual([gateway.brain, gateway.local, gateway.gateway, gateway.server, gateway.model], ['server', false, true, CLAUDE_GATEWAY, DEFAULT_CLAUDE_MODEL], 'the gateway answers from off this machine: never local')
  assert.equal(gateway.where, `Sloane answers through the gateway at ${CLAUDE_GATEWAY} (${DEFAULT_CLAUDE_MODEL}), which asks the Claude API off this machine`)

  const none = await afterLook({})
  assert.deepEqual([none.settled, none.brain, none.local, none.server, none.model], [true, 'scripted', false, null, null])
  assert.equal(none.where, 'Sloane answers from the scripted planner: no model answered at the last look on this machine')
})

/** An app whose runner carries a model and is ready (not asked until a look or an answer asks it). */
const APP_READY: Carried = { file: 'app-model.gguf', bytes: 986, status: { state: 'ready' } }

test('a provider chosen at the console is its brain at once, with no look', async () => {
  const cases: [string, BrainReadout['brain'], boolean, boolean][] = [
    ['ollama', 'server', true, false], ['llamacpp', 'server', true, false], ['openai', 'server', true, false], ['claude', 'server', false, true],
    ['native', 'app', true, false], ['inpage', 'page', true, false], ['scripted', 'scripted', false, false],
  ]
  for (const [p, brain, local, gateway] of cases) {
    // An app that has a runner (not asked yet), so the native provider is not one the page knows cannot run.
    const r = rig({}, { page: 'mine.gguf', app: APP_READY })
    r.router.setProvider(p)
    r.arm()
    const got = readMany(createBrainReadout({ router: r.router, native: r.native }))
    await settle()
    assert.deepEqual(r.calls, [], `${p}: nothing asked`)
    assert.deepEqual([got.provider, got.settled, got.brain, got.local, got.gateway], [p, true, brain, local, gateway], p)
  }
  const s = rig({})
  s.router.setProvider('scripted')
  assert.equal(createBrainReadout({ router: s.router }).read().where, 'Sloane answers from the scripted planner, as chosen: no model is asked')
  const n = rig({}, { app: APP_READY })
  n.router.setProvider('native')
  assert.equal(n.native.present(), null, 'not asked yet: whether it has one is not known')
  const app = createBrainReadout({ router: n.router, native: n.native }).read()
  assert.deepEqual([app.model, app.where], [null, 'Sloane answers with the model this app carries, run by the app on this device'], 'no file is named before the app said one')
})

test('a model chosen by name that the page already knows cannot run here is the scripted planner, said with why', async () => {
  // The app's runner refused this device at the boot's question: every native answer is refused.
  const refused = rig({}, { app: { file: 'app.gguf', bytes: 5, status: { state: 'failed', reason: 'this processor lacks AVX2', refused: true } } })
  await refused.native.installed().catch(() => [])
  refused.router.setProvider('native')
  const avx = createBrainReadout({ router: refused.router, native: refused.native }).read()
  assert.deepEqual([avx.provider, avx.settled, avx.brain, avx.local, avx.model, avx.server], ['native', true, 'scripted', false, null, null])
  assert.equal(avx.where, 'Sloane is set to the model this app carries, but it cannot run here (this processor lacks AVX2): the scripted planner answers', 'the reason said once')
  assert.equal(avx.default?.state, 'held', 'the default part still says how the app model stands')
  // A browser (no runner at all): known absent once a look or an answer has asked.
  const browser = rig({})
  await browser.router.installed().catch(() => [])
  browser.router.setProvider('native')
  assert.equal(browser.native.present(), false)
  const none = createBrainReadout({ router: browser.router, native: browser.native }).read()
  assert.deepEqual([none.brain, none.local, none.model], ['scripted', false, null])
  assert.equal(none.where, `Sloane is set to the model this app carries, but it cannot run here (${NO_RUNNER}): the scripted planner answers`, "the provider's own words")
  // A page that cannot run a model, set to the model kept in this page.
  const line = (o: Partial<BrainFacts>) => buildBrain(facts(o))
  const page = line({ provider: 'inpage', model: 'mine.gguf', site: { ...SITE, refusal: 'this browser lacks WebAssembly threads' } })
  assert.deepEqual([page.brain, page.local, page.model], ['scripted', false, null])
  assert.equal(page.where, 'Sloane is set to the model kept in this page, but it cannot run here (this browser lacks WebAssembly threads): the scripted planner answers')
  // A page that keeps no model file (all forgotten), set to the model kept in this page: inPage.ts says the same.
  const empty = line({ provider: 'inpage', model: null, pageEmpty: true })
  assert.deepEqual([empty.brain, empty.local], ['scripted', false])
  assert.equal(empty.where, 'Sloane is set to the model kept in this page, but it cannot run here (no model file is kept in this page): the scripted planner answers')
  assert.match(readFileSync(new URL('./inPage.ts', import.meta.url), 'utf8'), /\nconst NO_MODEL = 'no model file is kept in this page: /, "the in-page provider's own refusal says the same")
  // Under auto, a model found at the last look that cannot run now: the next answer looks again (not settled).
  const found = line({ look: { looked: true, looking: false, found: 'inpage' }, model: null, pageEmpty: true })
  assert.deepEqual([found.settled, found.brain], [false, null])
  assert.equal(found.where, 'Sloane looks for a model on this machine again at her next answer: the model kept in this page, found at the last look, cannot run here now (no model file is kept in this page)')
  // Facts that say nothing against it change nothing: a runner not asked yet, a page whose files are not listed yet.
  assert.equal(line({ provider: 'native' }).brain, 'app')
  assert.equal(line({ provider: 'inpage' }).brain, 'page')
})

test('the router tells the readout when a look begins and settles, and when the provider or a model changes; the readout tells its readers once each', async () => {
  const r = rig({ 11434: [DEFAULT_MODEL] })
  const store = createBrainReadout({ router: r.router, native: r.native })
  const seen: string[] = []
  const off = store.subscribe(() => { const b = store.read(); seen.push(b.settled ? `${b.brain} ${b.model}` : b.where) })
  assert.deepEqual(r.router.lookState(), { looked: false, looking: false, found: null })
  const looking = r.router.installed()
  assert.equal(r.router.lookState().looking, true)
  await looking
  assert.deepEqual(r.router.lookState(), { looked: true, looking: false, found: 'ollama' })
  assert.deepEqual(seen, ['Sloane is looking for a model on this machine', `server ${DEFAULT_MODEL}`])
  r.router.setModel('qwen3:8b')
  r.router.setModel('qwen3:8b')
  assert.deepEqual(seen.slice(2), ['server qwen3:8b'], 'a change the readout does not show (the same model again) tells nobody')
  r.router.setProvider('scripted')
  assert.deepEqual(seen.slice(3), ['scripted null'])
  off()
  r.router.setProvider('inpage')
  assert.equal(seen.length, 4, 'an unsubscribed reader hears nothing more')
  let routerHeard = 0
  const unhear = r.router.onChange(() => { routerHeard++ })
  r.router.setProvider('auto')
  unhear()
  r.router.setProvider('ollama')
  assert.equal(routerHeard, 1, "the router's own unsubscribe works")
  store.dispose()
})

test('the default model follows the site job: each job change tells a subscriber once, done rises, and nothing calls the job or the offer', async () => {
  const r = rig({})
  const calls: string[] = []
  let facts: SiteFacts = { ...SITE, offered: true }
  let progress!: (p: { step: 'download' | 'keep'; done: number; total: number }) => void
  let finish!: (line: string) => void
  const job = createSiteJob((_how, onProgress) => new Promise<string>((resolve) => { progress = onProgress; finish = resolve }))
  const site = siteOf(() => facts, job, calls)
  r.arm()
  const store = createBrainReadout({ router: r.router, site })
  const heard: BrainReadout[] = []
  const off = store.subscribe(() => heard.push(store.read()))
  assert.equal(store.read().default?.state, 'waiting')
  assert.equal(store.read().where, `${NOT_LOOKED}; her default model (Site Model) is not decided yet: the page decides once the city is on screen`)
  // The page's own start (the test, never the readout) starts the job.
  const end = job.start('auto')
  assert.equal(heard.length, 1)
  assert.deepEqual({ state: heard[0].default?.state, step: heard[0].default?.step, downloading: heard[0].downloading }, { state: 'getting', step: 'download', downloading: { done: 0, total: 0 } })
  progress({ step: 'download', done: 100, total: 400 })
  progress({ step: 'download', done: 200, total: 400 })
  assert.equal(heard.length, 3, 'each job change, once')
  assert.deepEqual(heard.map((h) => h.downloading?.done), [0, 100, 200], 'done rises')
  assert.equal(heard[2].where, `${NOT_LOOKED}; her default model (Site Model) is downloading from this site, 50%`)
  progress({ step: 'keep', done: 0, total: 400 })
  assert.deepEqual([heard.length, heard[3].default?.step, heard[3].downloading], [4, 'keep', { done: 0, total: 400 }])
  assert.match(heard[3].where, /her default model \(Site Model\) is being kept in this page, 0%$/)
  // The keep chose the file: the page's facts now say it is kept.
  facts = { ...facts, kept: true }
  finish('site-model.gguf is kept in this page')
  await end
  assert.equal(heard.length, 5)
  assert.deepEqual([heard[4].default?.state, heard[4].downloading], ['kept', null])
  assert.match(heard[4].where, /her default model \(Site Model\) is kept in this page$/)
  off()
  progress({ step: 'download', done: 300, total: 400 })
  assert.equal(heard.length, 5, 'a job that ended reports nothing, and an unsubscribed reader hears nothing')
  await settle()
  assert.deepEqual(calls, [])
  assert.deepEqual(r.calls, [])
  store.dispose()
})

test('a stopped or failed job holds the default back and says why', async () => {
  const calls: string[] = []
  const r = rig({})
  const stopping = createSiteJob((_h, _p, signal) => new Promise<string>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason))))
  const store = createBrainReadout({ router: r.router, site: siteOf(() => ({ ...SITE, offered: true, decided: 'stopped (person)' }), stopping, calls) })
  void stopping.start('auto')
  stopping.stop('person')
  assert.deepEqual([store.read().default?.state, store.read().default?.why], ['held', "it was stopped: the button on Sloane's card gets it"])
  const failing = createSiteJob(async () => { throw new Error('its SHA-256 differs from the one this page was built with') })
  const failed = createBrainReadout({ router: r.router, site: siteOf(() => ({ ...SITE, offered: true }), failing, calls) })
  await failing.start('auto')
  assert.deepEqual([failed.read().default?.state, failed.read().default?.why], ['held', 'its SHA-256 differs from the one this page was built with'])
  assert.match(failed.read().where, /; her default model \(Site Model\) waits: its SHA-256 differs from the one this page was built with$/)
  await settle()
  assert.deepEqual(calls, [])
})

/** Facts for buildBrain: auto before a look, no app model, no site, no job, unless `o` says otherwise. */
const facts = (o: Partial<BrainFacts> = {}): BrainFacts => ({ provider: 'auto', look: { looked: false, looking: false, found: null }, server: DEFAULT_SERVER, model: DEFAULT_MODEL, native: null, appAbsent: false, pageEmpty: false, site: null, job: null, ...o })
const running = (done: number, total: number, step: 'download' | 'keep' = 'download'): SiteJobState => ({ id: 1, how: 'auto', phase: 'running', step, done, total })

test('buildBrain: every default state, the app runner first, and the line once', () => {
  const d = (o: Partial<BrainFacts>) => buildBrain(facts(o)).default
  assert.equal(d({}), null, 'nothing gets a default here')
  assert.deepEqual(d({ site: SITE }), { from: 'site', file: 'site-model.gguf', title: 'Site Model', bytes: 400, state: 'waiting', step: null, done: 0, total: 0, why: null })
  assert.equal(d({ site: { ...SITE, served: false } })?.state, 'none')
  assert.deepEqual([d({ site: { ...SITE, served: false, decided: 'only the web copy is served with a model beside it' } })?.why], ['only the web copy is served with a model beside it'])
  assert.equal(d({ site: { ...SITE, offered: false } })?.state, 'none')
  assert.deepEqual({ ...d({ site: { ...SITE, refusal: 'this browser cannot run it' } }) }, { ...SITE_DEFAULT, state: 'held', why: 'this browser cannot run it' })
  // Served none and unable to run one (the single file opened from disk): none, with the page's own line, not held.
  assert.deepEqual([d({ site: { ...SITE, served: false, refusal: 'a page opened from a file cannot start it' } })?.state, d({ site: { ...SITE, served: false, refusal: 'x', decided: 'only the web copy is served with a model beside it' } })?.why], ['none', 'only the web copy is served with a model beside it'])
  assert.equal(d({ site: { ...SITE, offered: false, refusal: 'x' } })?.state, 'none', 'the source serves none: none')
  assert.deepEqual({ ...d({ site: { ...SITE, decided: 'the browser is set to save data' } }) }, { ...SITE_DEFAULT, state: 'held', why: 'the browser is set to save data' })
  assert.equal(d({ site: { ...SITE, kept: true, refusal: 'x' } })?.state, 'kept')
  // A job that got it says nothing once it is forgotten: kept is the facts' word alone.
  assert.deepEqual({ ...d({ site: SITE, job: { id: 1, how: 'tap', phase: 'done', line: 'kept' } }) }, { ...SITE_DEFAULT, state: 'held', why: "it is no longer kept in this page, and the button on Sloane's card gets it again" })
  assert.equal(d({ site: { ...SITE, kept: true }, job: { id: 1, how: 'tap', phase: 'done', line: 'kept' } })?.state, 'kept')
  assert.equal(d({ site: { ...SITE, kept: true }, job: running(1, 2) })?.state, 'getting', 'a running job is what the default is doing now')
  assert.equal(d({ site: SITE, job: { id: 1, how: 'auto', phase: 'stopped', by: 'network' } })?.why, 'the connection turned costly while it came, so it waits for a later visit')
  assert.equal(d({ site: SITE, job: { id: 1, how: 'auto', phase: 'stopped', by: 'page' } })?.why, 'the city ended before it arrived')
  assert.equal(d({ site: SITE, job: { id: 1, how: 'auto', phase: 'stopped', by: 'choice' } })?.why, 'another model was chosen while it came')
  // The app's own runner: checking, ready, failed; it stands before the site's source, whose title it borrows for the same file.
  const appSite: SiteFacts = { ...SITE, from: 'app', file: 'app-model.gguf', title: 'App Model', bytes: 986 }
  assert.deepEqual(d({ site: appSite, native: { file: 'app-model.gguf', bytes: null, status: { state: 'preparing', done: 3, total: 4 } } }), { from: 'native', file: 'app-model.gguf', title: 'App Model', bytes: 986, state: 'checking', step: null, done: 3, total: 4, why: null })
  assert.equal(d({ site: appSite, native: { file: 'app-model.gguf', bytes: 986, status: { state: 'loaded' } } })?.state, 'kept')
  assert.deepEqual([d({ native: { file: 'x.gguf', bytes: 5, status: { state: 'failed', reason: 'this processor lacks AVX2', refused: true } } })?.state, d({ native: { file: 'x.gguf', bytes: 5, status: { state: 'failed', reason: 'this processor lacks AVX2', refused: true } } })?.why], ['held', 'this processor lacks AVX2'])

  const line = (o: Partial<BrainFacts>) => buildBrain(facts(o)).where
  assert.equal(line({ site: SITE, job: running(1, 4, 'download'), provider: 'scripted' }), 'Sloane answers from the scripted planner, as chosen: no model is asked; her default model (Site Model) is downloading from this site, 25%')
  assert.match(line({ site: { ...SITE, from: 'app' }, job: running(1, 2) }), /her default model \(Site Model\) is being copied from the app, 50%$/)
  assert.match(line({ site: { ...SITE, from: 'launcher' }, job: running(0, 0) }), /her default model \(Site Model\) is being copied from the launcher, 0%$/)
  assert.match(line({ native: { file: 'x.gguf', bytes: 5, status: { state: 'preparing', done: 1, total: 3 } } }), /; the app is checking her default model \(x\.gguf\), 33%$/)
  assert.equal(line({ provider: 'inpage', model: 'site-model.gguf', site: { ...SITE, kept: true } }), 'Sloane answers with the model kept in this page (site-model.gguf), run on this device', 'the kept default answering is said once')
  assert.equal(line({ provider: 'native', native: { file: 'x.gguf', bytes: 5, status: { state: 'ready' } } }), 'Sloane answers with the model this app carries (x.gguf), run by the app on this device')
  assert.match(line({ provider: 'ollama', native: { file: 'x.gguf', bytes: 5, status: { state: 'ready' } } }), /a model server on this machine; her default model \(x\.gguf\) is ready in the app$/)
  assert.equal(line({ site: { ...SITE, served: false } }), NOT_LOOKED, 'none adds nothing')
  assert.equal(line({ site: { ...SITE, served: false, refusal: 'this page was opened from a file' } }), NOT_LOOKED, 'a page served none never says a default waits')
  assert.equal(line({ look: { looked: true, looking: true, found: 'ollama' } }), 'Sloane is looking for a model on this machine', 'a look under way is not settled, whatever the last found')
  assert.equal(buildBrain(facts({ look: { looked: true, looking: true, found: 'ollama' } })).settled, false)
  assert.equal(buildBrain(facts({ provider: 'later' })).where, "Sloane's brain is not known: the later provider is not one this readout knows")
  assert.deepEqual(buildBrain(facts({ site: SITE, job: running(5, 9) })).downloading, { done: 5, total: 9 })
  assert.equal(buildBrain(facts({ native: { file: 'x.gguf', bytes: 5, status: { state: 'preparing', done: 1, total: 3 } } })).downloading, null, "the app checking its own file is no download")
  assert.deepEqual(buildBrain(facts()), buildBrain(facts()), 'pure: the same facts, an equal readout')
})
const SITE_DEFAULT = { from: 'site', file: 'site-model.gguf', title: 'Site Model', bytes: 400, step: null, done: 0, total: 0 }

test('the app model as last heard: a look counts, a read asks the shell nothing, and the readout says it is being checked', async () => {
  const r = rig({}, { app: { file: 'app-model.gguf', bytes: 986, status: { state: 'preparing', done: 10, total: 986 } } })
  assert.equal(r.native.status(), null, 'nothing heard before a look asked')
  await r.router.installed().catch(() => [])
  r.arm()
  const store = createBrainReadout({ router: r.router, native: r.native })
  const got = readMany(store)
  await settle()
  assert.deepEqual(r.calls, [])
  assert.deepEqual([got.brain, got.default?.state, got.default?.done, got.default?.total], ['app', 'checking', 10, 986])
  assert.match(got.where, /^Sloane answers with the model this app carries \(app-model\.gguf\), run by the app on this device; the app is checking her default model \(app-model\.gguf\), 1%$/)
})

test('brainReadout.ts imports types only, and calls no fetch, list, answer, start or offer', () => {
  const src = readFileSync(new URL('./brainReadout.ts', import.meta.url), 'utf8')
  const imports = src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\s+['"]/.test(l))
  assert.ok(imports.length > 0)
  for (const l of imports) assert.match(l, /^import type \{[^}]*\} from '\.\/[A-Za-z]+\.ts'$/, `a value import would cost the walk the whole module: ${l}`)
  assert.doesNotMatch(src, /\bimport\s*\(/, 'no dynamic import')
  const code = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*\*)/.test(l)).join('\n')
  for (const call of [/\bfetch\s*\(/, /\.installed\s*\(/, /\.answer\s*\(/, /\.start\s*\(/, /\.offer\s*\(/, /\.model\s*\(/, /\.generate\s*\(/]) assert.doesNotMatch(code, call, `the readout must never call ${call}`)
})

test('a change no source announced is found by the next read, and its readers hear it once, after that turn', async () => {
  let provider = 'auto'
  let look = { looked: false, looking: false, found: null as null | 'ollama' }
  const router: Pick<MindRouter, 'provider' | 'lookState' | 'settings' | 'onChange'> = {
    get provider() { return provider as MindRouter['provider'] },
    lookState: () => look,
    settings: () => ({ server: DEFAULT_SERVER, model: DEFAULT_MODEL }),
    onChange: () => () => undefined,
  }
  const store = createBrainReadout({ router })
  let heard = 0
  store.subscribe(() => { heard++ })
  const before = store.read()
  look = { looked: true, looking: false, found: 'ollama' }
  const after = store.read()
  assert.notEqual(after, before)
  assert.equal(after.brain, 'server')
  assert.equal(heard, 0, 'never inside the read itself')
  await Promise.resolve()
  assert.equal(heard, 1)
  assert.equal(store.read(), after, 'the same object while nothing changed')
  store.refresh()
  assert.equal(heard, 1, 'a refresh with nothing new tells nobody')
  provider = 'scripted'
  store.refresh()
  assert.equal(heard, 2)
  assert.equal(store.read().brain, 'scripted')
})

test('a forget through the console is told to the readout: the default got this visit is held, not kept, and no model answers', async () => {
  // Tapped Get on Sloane's card: the job kept the site's model and set the provider to inpage.
  const r = rig({}, { page: 'site-model.gguf' })
  const calls: string[] = []
  let facts: SiteFacts = { ...SITE, offered: true }
  let empty: boolean | null = null
  const job = createSiteJob(async () => 'site-model.gguf is kept in this page: the inpage provider answers with it now')
  r.router.setProvider('inpage')
  const store = createBrainReadout({ router: r.router, page: { empty: () => empty }, site: siteOf(() => facts, job, calls) })
  facts = { ...facts, kept: true }
  empty = false
  await job.start('tap')
  assert.equal(job.state()?.phase, 'done')
  const before = store.read()
  assert.deepEqual([before.brain, before.local, before.default?.state], ['page', true, 'kept'])
  let heard = 0
  const off = store.subscribe(() => { heard++ })
  // App.tsx's console bridge (modelBridge forget): the in-page mind forgets the file, then the readout hears it and
  // the page reads again whether the site's model is kept (keptSite).
  const forget = (): Promise<string> => Promise.resolve('forgot 1 model file: none is kept in this page now').finally(() => {
    empty = true
    facts = { ...facts, kept: false }
    store.refresh()
  })
  await forget()
  assert.equal(heard, 1, 'one change, told once')
  const after = store.read()
  assert.equal(after.default?.state, 'held')
  assert.equal(after.default?.why, "it is no longer kept in this page, and the button on Sloane's card gets it again")
  assert.deepEqual([after.brain, after.local, after.model], ['scripted', false, null], 'nothing kept answers')
  assert.equal(after.where, "Sloane is set to the model kept in this page, but it cannot run here (no model file is kept in this page): the scripted planner answers; her default model (Site Model) waits: it is no longer kept in this page, and the button on Sloane's card gets it again")
  off()
  await settle()
  assert.deepEqual(calls, [])
  store.dispose()
})

test('the app model as it changes: the check done is heard at the next question, and the check during an answer tells a subscriber', async () => {
  // First launch: the boot's question hears the runner still checking its file; the next hears it ready.
  const statuses = [{ state: 'preparing', done: 0, total: 986 }, { state: 'ready' }]
  let asked = 0
  const host: NativeHost = {
    model: async () => ({ file: 'app-model.gguf', bytes: 986, status: statuses[Math.min(asked++, statuses.length - 1)] }),
    generate: async () => { throw new Error('no answer here') },
    stop: async () => true,
  }
  const app = createNativeMind({ host })
  await app.installed()
  const { router } = rig({})
  const store = createBrainReadout({ router, native: app })
  assert.deepEqual([store.read().default?.state, store.read().default?.done], ['checking', 0])
  assert.match(store.read().where, /; the app is checking her default model \(app-model\.gguf\), 0%$/)
  let heard = 0
  const off = store.subscribe(() => { heard++ })
  // App.tsx follows the check from memory (followCheck): its next question hears it ready.
  await app.installed()
  assert.equal(heard, 1, 'the readout is told, with no read and no router change')
  assert.equal(store.read().default?.state, 'kept')
  assert.match(store.read().where, /; her default model \(app-model\.gguf\) is ready in the app$/)
  off()
  store.dispose()

  // Chosen with ask provider native: the file's check reported during an answer, then the load that follows it.
  let release!: () => void
  const told: string[] = []
  const during: NativeHost = {
    model: async () => ({ file: 'app-model.gguf', bytes: 986, status: { state: 'preparing', done: 0, total: 986 } }),
    generate: async (_req, send) => {
      send({ kind: 'preparing', done: 493, total: 986 })
      told.push(`${heardRun} after the check`)
      send({ kind: 'loading', fraction: 0 })
      told.push(`${heardRun} after the load began`)
      await new Promise<void>((res) => { release = res })
      send({ kind: 'text', text: 'hi' })
      return { id: 1, reason: 'eog', tokens: 1, promptTokens: 1, reused: 0, prefillMs: 1, genMs: 1, threads: 1, nCtx: 1, nBatch: 1, gpu: false }
    },
    stop: async () => true,
  }
  const run = createNativeMind({ host: during })
  await run.installed()
  const r2 = rig({})
  r2.router.setProvider('native')
  const live = createBrainReadout({ router: r2.router, native: run })
  let heardRun = 0
  const states: string[] = []
  const offRun = live.subscribe(() => { heardRun++; states.push(`${live.read().default?.state} ${live.read().default?.done}`) })
  const answer = run.answer({ tethers: [], prompt: 'hi', signal: new AbortController().signal }, () => {})
  await new Promise((res) => setTimeout(res, 5))
  assert.deepEqual(told, ['1 after the check', '2 after the load began'], 'each change told while the answer runs, before it ends')
  assert.deepEqual(states, ['checking 493', 'kept 0'], 'the check half done, then ready as the load begins')
  release()
  await answer
  offRun()
  live.dispose()
})

test('auto after a look that found nothing: once the page has kept its default model, the next answer looks again, not the script', async () => {
  // The web copy's first visit: the page's own download runs while the visitor talks to Sloane; the look finds nothing.
  let keptName: string | null = null
  const r = rig({}, { page: () => keptName })
  const calls: string[] = []
  let facts: SiteFacts = { ...SITE, offered: true }
  let finish!: (line: string) => void
  const job = createSiteJob(() => new Promise<string>((resolve) => { finish = resolve }))
  const end = job.start('auto')
  await r.router.installed().catch(() => [])
  assert.deepEqual(r.router.lookState(), { looked: true, looking: false, found: null })
  const store = createBrainReadout({ router: r.router, site: siteOf(() => facts, job, calls) })
  assert.equal(store.read().brain, 'scripted', 'while it is still on its way, the script answers the next ask too')
  // The download finishes: kept, and chosen in the page (keepPicked with the provider left at auto).
  keptName = 'site-model.gguf'
  facts = { ...facts, kept: true }
  finish('site-model.gguf is kept in this page: it answers whenever no model server on this machine does')
  await end
  const got = store.read()
  assert.deepEqual([got.provider, got.settled, got.brain, got.local], ['auto', false, null, false])
  assert.equal(got.where, 'Sloane looks for a model on this machine again at her next answer: none answered at the last look; her default model (Site Model) is kept in this page')
  assert.equal(r.router.settings().auto, 'nothing found yet: the next ask looks on this machine', "the router's own found row says the same")
  // And that look finds it.
  await r.router.installed().catch(() => [])
  assert.deepEqual([store.read().brain, store.read().model], ['page', 'site-model.gguf'])
  await settle()
  assert.deepEqual(calls, [])
  store.dispose()
})

test('ask server then ask model auto: the look that found Ollama no longer stands, and the readout never says none answered', async () => {
  const r = rig({ 11434: [DEFAULT_MODEL] })
  await r.router.installed()
  const store = createBrainReadout({ router: r.router, native: r.native })
  assert.equal(store.read().brain, 'server')
  r.router.setServer('http://localhost:11500')
  let heard = 0
  const off = store.subscribe(() => { heard++ })
  assert.equal(r.router.setModel('auto'), 'auto: auto chooses the Ollama model again at its next look')
  assert.deepEqual(r.router.lookState(), { looked: false, looking: false, found: null })
  assert.equal(heard, 1)
  const got = store.read()
  assert.deepEqual([got.settled, got.brain], [false, null])
  assert.doesNotMatch(got.where, /no model answered|none answered/)
  assert.equal(got.where, NOT_LOOKED, 'as the router\'s found row: nothing found yet, the next ask looks')
  off()
  store.dispose()
})

test('a look stopped part way after one found Ollama: no look stands, and the readout never says the script answers', async () => {
  // Under auto, the Ollama found stops answering, the next ask looks again, and the visitor stops that answer mid-look.
  let hangs = false
  const net = machine({ 11434: [DEFAULT_MODEL] })
  const fetch: FetchLike = (url, init) => (hangs ? new Promise<Response>((_, reject) => {
    const signal = init?.signal
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) : net(url, init))
  const router = createMindRouter({ fetch })
  await router.installed()
  const store = createBrainReadout({ router })
  assert.equal(store.read().brain, 'server')
  hangs = true
  const ctl = new AbortController()
  const going = router.installed(ctl.signal)
  await settle()
  assert.deepEqual([store.read().settled, store.read().where], [false, 'Sloane is looking for a model on this machine'])
  ctl.abort(new DOMException('stopped', 'AbortError'))
  await assert.rejects(going)
  assert.deepEqual(router.lookState(), { looked: false, looking: false, found: null })
  const got = store.read()
  assert.deepEqual([got.settled, got.brain], [false, null])
  assert.doesNotMatch(got.where, /scripted|no model answered|none answered/)
  assert.equal(got.where, NOT_LOOKED, 'as the router\'s found row: nothing found yet, the next ask looks')
  assert.equal(router.settings().auto, 'nothing found yet: the next ask looks on this machine')
  store.dispose()
})

test('after a look that found nothing, a look stopped part way or ask model auto sets it aside: her next answer looks, not the script', async () => {
  let hangs = false
  const net = machine({})
  const fetch: FetchLike = (url, init) => (hangs ? new Promise<Response>((_, reject) => {
    const signal = init?.signal
    if (signal?.aborted) return reject(signal.reason)
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
  }) : net(url, init))
  for (const aside of ['a look stopped part way', 'ask model auto'] as const) {
    hangs = false
    const router = createMindRouter({ fetch })
    await assert.rejects(router.installed())
    const store = createBrainReadout({ router })
    assert.deepEqual([router.lookState(), store.read().brain], [{ looked: true, looking: false, found: null }, 'scripted'], aside)
    if (aside === 'ask model auto') assert.equal(router.setModel('auto'), 'auto: auto chooses the Ollama model again at its next look')
    else {
      hangs = true
      const ctl = new AbortController()
      const going = router.installed(ctl.signal)
      await settle()
      ctl.abort(new DOMException('stopped', 'AbortError'))
      await assert.rejects(going)
    }
    assert.deepEqual(router.lookState(), { looked: false, looking: false, found: null }, aside)
    const got = store.read()
    assert.deepEqual([got.settled, got.brain, got.where], [false, null, NOT_LOOKED], aside)
    assert.match(router.settings().auto ?? '', /^nothing found yet: the next ask looks on this machine/, aside)
    store.dispose()
  }
})

test('App.tsx tells the readout of a keep, a forget and the app model\'s check, and hands it what the page keeps', () => {
  const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
  const code = app.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  // The site's model kept by the job is noted before the job says done (a forget reads it again).
  assert.match(code, /return keepPicked\(\[file\], \(done, total\) => onProgress\(\{ step: 'keep', done, total \}\), how === 'tap'\)\.then\(\(line\) => \{\s+siteKept = true\s+return line\s+\}\)\n/)
  // The city's console: a forget is told to the readout, and whether the site's model is kept is read again.
  assert.match(code, /forget: \(name\?: string\) => inPage\.forget\(name\)\.finally\(\(\) => \{\s+brainHeard\(\)\s+void keptSite\(\)\.catch\(\(\) => null\)\s+\}\),/)
  // The console alone: the same forget refreshes its readout, which is told whether the page keeps no file.
  assert.match(code, /const brain = createBrainReadout\(\{ router, native, page: inPage \}\)/)
  assert.match(code, /forget: \(name\?: string\) => inPage\.forget\(name\)\.finally\(\(\) => brain\.refresh\(\)\),/)
  assert.match(code, /createBrainReadout\(\{\s+router: local,\s+native: appMind,\s+page: inPage,/)
  // The app model's check is followed from memory until it is done, and the follow ends with the city.
  assert.match(code, /if \(cancelled \|\| appMind\.status\(\)\?\.status\.state !== 'preparing'\) return\s+checkTimer = setTimeout\(\(\) => \{ void appMind\.installed\(\)\.catch\(\(\) => \[\]\)\.then\(followCheck\) \}, 1000\)/)
  assert.match(code, /void appMind\.installed\(\)\.catch\(\(\) => \[\]\)\.then\(\(\) => \{ brainHeard\(\); followCheck\(\) \}\)\s+const offCheck = local\.onChange\(followCheck\)/)
  assert.match(code, /clearTimeout\(checkTimer\)\s+offCheck\(\)\s+unbindBrain\(\)/)
})
