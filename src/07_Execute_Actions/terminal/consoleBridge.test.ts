// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the console alone's talk with Sloane (consoleBridge.ts, ?boot=tty), driven through
 * the console's own commands (commands.ts run) over the page's real router (09_Cognition/pageMind.ts createPageMind)
 * with a fake app runner and a fake model server: `ask` is gated by `operator unlock` as the city's is; `ask <words>`
 * streams Sloane's reply in whole words and ends it with the time, through whichever provider the router's auto order
 * finds (the app's own model, a server on this machine); `ask stop` stops it and keeps what was shown; one answer at a
 * time; words the 14A screen refuses reach no model; the Zeroth Law stands before each answer; where nothing answers,
 * the router's one sentence says what would, and nothing fetches or keeps a model file; the router is loaded at the
 * first `ask`, never before, and a load that failed is tried again at the next; settings typed before it is loaded
 * wait for it; words that start with a setting's name are Sloane's unless they are that setting's exact form, and
 * keep nothing; her framing says no city runs here; the router's "ask file load tries again" can be followed here,
 * while choosing a file and `ask gpu` stay the city's; a kept scripted provider prints SCRIPTED_CHOSEN and no model is
 * asked; the bridge refuses a locked ask itself, behind commands.ts; and everything that needs the city says the
 * engine is not running, whether the tier is locked or open.
 * What breaks if it is removed? The console could ask Sloane while locked, load the router at its start, hang on a
 * stop, start a download, keep a question as a setting, offer changes to a city that is not there, or print nothing
 * where no model answers, with no test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ANSWER_COMING, STOPPED, chatAnswer, consoleBridge, type ConsoleFile } from './consoleBridge.ts'
import { run, type CommandResult } from './commands.ts'
import type { TerminalBridge } from './bridge.ts'
import { createPageMind, type PageDevice } from '../../09_Cognition/pageMind.ts'
import type { GenRequest, NativeHost } from '../../09_Cognition/nativeMind.ts'
import { GUARD_KEY, type InPageRuntime } from '../../09_Cognition/inPage.ts'
import type { KeptModel, ModelStore } from '../../09_Cognition/modelStore.ts'
import type { FetchLike } from '../../09_Cognition/localCompute.ts'
import { askRefusal, type Mind } from '../operator.ts'
import { SCRIPTED_CHOSEN } from '../onboarding/voice.ts'

const BRAND = { name: 'TESTBRAND', version: '9.8.7', host: 'testhost', track: 'tty' as const }
const DESKTOP: PageDevice = { mobile: false, lite: false, gpuClass: 'unknown', cores: 8, memoryGb: 8, isolated: false, f16: false }
const NO_SERVER: FetchLike = async () => { throw new TypeError('fetch failed') }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !ok(); i++) await sleep(2)
}

/** The model the app carries, ready, answering with `pieces` (then waiting for a stop when `hold`). */
function appRunner(pieces: readonly string[], hold = false) {
  const sent: GenRequest[] = []
  const stopped: number[] = []
  let release: () => void = () => {}
  const host: NativeHost = {
    model: async () => ({ file: 'm.gguf', bytes: 1, status: { state: 'ready' } }),
    generate: async (req, send) => {
      sent.push(req)
      for (const text of pieces) {
        send({ kind: 'text', text })
        await sleep(1)
      }
      if (hold) await new Promise<void>((r) => { release = r })
      return { id: req.id, reason: hold ? 'stopped' : 'eog', tokens: pieces.length, promptTokens: 9, reused: 0, prefillMs: 1, genMs: 1, threads: 1, nCtx: 4096, nBatch: 256, gpu: false }
    },
    stop: async (id) => {
      stopped.push(id)
      release()
      return true
    },
  }
  return { host, sent, stopped }
}

/** No model file kept in this page; a keep or an open is a failure of the test (the console fetches and keeps nothing). */
function emptyStore() {
  const calls: string[] = []
  const store: ModelStore = {
    keep: async () => { calls.push('keep'); throw new Error('nothing is kept from the console') },
    list: async () => { calls.push('list'); return [] },
    open: async () => { calls.push('open'); throw new Error('nothing is opened from the console') },
    forget: async () => 0,
    usage: async () => null,
    storageLine: () => 'kept in this page',
  }
  return { store, calls }
}

/** A runtime that must never load anything: the console's ask has no model file to load. */
function idleRuntime() {
  const calls: string[] = []
  const runtime: InPageRuntime = {
    caps: () => ({ jspi: true, mem64shared: true, simd: true, exceptions: true, isolated: true, opfs: true, webgpu: false, opaque: false }),
    load: async () => { calls.push('load'); throw new Error('no load from the console') },
    chat: async () => { calls.push('chat'); throw new Error('no chat from the console') },
    unload: async () => { calls.push('unload') },
    loaded: () => false,
    idle: async () => {},
    log: () => [],
  }
  return { runtime, calls }
}

/** The router's kept settings (App.tsx COGNITION_KEY in local storage), readable by the test. */
const memoryStore = (initial: string | null = null) => {
  let json = initial
  return { load: () => json, save: (v: string) => { json = v }, json: () => json }
}

/**
 * The console alone over the page's router, as App.tsx ttyBridge builds it (the router and its in-page mind); `loads`
 * counts the router's loads, `kept` reads its kept settings.
 */
function consoleOver(o: { fetch?: FetchLike; runner?: NativeHost | null; contained?: boolean; kept?: string; models?: ModelStore; runtime?: InPageRuntime } = {}) {
  const fetched: string[] = []
  const fetchFn: FetchLike = (url, init) => {
    fetched.push(url)
    return (o.fetch ?? NO_SERVER)(url, init)
  }
  const store = emptyStore()
  const rt = idleRuntime()
  const settings = memoryStore(o.kept ?? null)
  let loads = 0
  let router: Mind | null = null
  const bridge = consoleBridge(BRAND, {
    contained: () => o.contained ?? true,
    mind: async () => {
      loads++
      const pm = createPageMind({
        fetch: fetchFn, store: settings, runtime: () => o.runtime ?? rt.runtime, models: () => o.models ?? store.store, device: () => DESKTOP,
        runner: o.runner === undefined ? null : o.runner, gpuMemory: async () => null, vram: null,
      })
      router = pm.router
      return { router: pm.router, inPage: pm.inPage }
    },
  })
  return { bridge, fetched, store, rt, loads: () => loads, router: () => router, kept: () => settings.json() }
}

/** One console line through the console's own dispatch: its first lines, what streamed, and its final lines. */
async function line(b: TerminalBridge, input: string): Promise<{ first: string[]; streamed: string[]; final: string[] }> {
  const r: CommandResult = run(input, b, [])
  const streamed: string[] = []
  const off = r.stream?.subscribe((p) => { if (p.kind === 'text') streamed.push(p.text) })
  const final = r.pending ? await r.pending : []
  off?.()
  return { first: r.lines.map((l) => l.text), streamed, final: final.map((l) => l.text) }
}

test('the console alone: ask is gated by operator unlock as the city\'s is, and the router is not loaded until the first ask', async () => {
  const c = consoleOver({ runner: appRunner(['Hello ', 'there.']).host })
  for (const input of ['help', 'version', 'boot status', 'operator', 'ask hello', 'ask', 'ask provider native', 'ask stop']) await line(c.bridge, input)
  await sleep(10)
  assert.equal(c.loads(), 0, 'nothing typed so far loads the router, nor anything left to run after it')
  assert.deepEqual((await line(c.bridge, 'ask hello')).first, ["ask: locked; type 'operator unlock' first"])
  const unlock = await line(c.bridge, 'operator unlock')
  assert.equal(unlock.first[0], 'Ring-0 operator tier unlocked.')
  assert.ok(unlock.first.some((l) => /ask <words> of Sloane/.test(l)), unlock.first.join('\n'))
  assert.ok(unlock.first.some((l) => /engine not running/.test(l)), 'and says what still needs the city')
  assert.deepEqual((await line(c.bridge, 'operator')).first, ['operator: unlocked'])
  assert.equal(c.loads(), 0, 'unlocking loads nothing either')
  const said = await line(c.bridge, 'ask hello')
  assert.equal(c.loads(), 1, 'the first ask loads it')
  assert.deepEqual(said.first, ['ask: asking Sloane'])
  await line(c.bridge, 'ask how are you')
  assert.equal(c.loads(), 1, 'once')
  assert.deepEqual((await line(c.bridge, 'operator lock')).first, ['operator: locked'])
  assert.deepEqual((await line(c.bridge, 'ask hello')).first, ["ask: locked; type 'operator unlock' first"])
})

test('ask <words>: Sloane\'s reply from the model the app carries streams in whole words, then ends with the time; the next turn carries the last', async () => {
  const app = appRunner(['Hello ', 'there, ', 'I am ', 'Sloane. ', 'Welcome.'])
  const c = consoleOver({ runner: app.host })
  await line(c.bridge, 'operator unlock')
  const r = await line(c.bridge, 'ask hello')
  assert.deepEqual(r.first, ['ask: asking Sloane'])
  assert.ok(r.streamed.length >= 2, `it streamed (${JSON.stringify(r.streamed)})`)
  assert.equal(r.streamed.join(''), 'Hello there, I am Sloane.', 'whole words only while it streams')
  assert.equal(r.final[0], 'Hello there, I am Sloane. Welcome.')
  assert.match(r.final[1], /^-- answered in \d+\.\d s --$/)
  assert.equal(app.sent.length, 1)
  const prompt = app.sent[0].messages.map((m) => m.content).join('\n')
  assert.match(prompt, /You are Sloane, the concierge of Crimson Noir: Agent City/, 'her framing, as her card in the city sends it')
  assert.match(prompt, /The city is not running here/, 'for the console alone')
  assert.doesNotMatch(prompt, /walking through|they only need to say what they want|tell them what to ask for/, 'no change to a city that is not running is offered')
  assert.match(prompt, /Person: hello\nSloane:$/m)
  await line(c.bridge, 'ask and you?')
  const next = app.sent[1].messages.map((m) => m.content).join('\n')
  assert.match(next, /Person: hello\nSloane: Hello there, I am Sloane\. Welcome\.\nPerson: and you\?\nSloane:/, 'the conversation so far')
  // `ask` alone shows which model answers: the app's own, found by auto.
  const status = await line(c.bridge, 'ask')
  assert.ok(status.final.some((l) => /^found\s+native: the model this app carries/.test(l)), status.final.join('\n'))
  assert.ok(status.final.some((l) => /^server\s+none: the app runs the model$/.test(l)), status.final.join('\n'))
})

test('ask <words> over a model server on this machine: the router\'s auto order finds it first, and every request stays on this machine', async () => {
  const enc = new TextEncoder()
  const server: FetchLike = async (url) => {
    if (url.endsWith('/api/tags')) return new Response(JSON.stringify({ models: [{ name: 'qwen3-vl:4b' }] }), { status: 200 })
    if (url.endsWith('/api/generate')) {
      const body = [{ response: 'Good evening ', done: false }, { response: 'from Ollama.', done: false }, { done: true, done_reason: 'stop', eval_count: 4 }].map((l) => JSON.stringify(l)).join('\n') + '\n'
      return new Response(new ReadableStream<Uint8Array>({ start(ctl) { ctl.enqueue(enc.encode(body)); ctl.close() } }), { status: 200, headers: { 'content-type': 'application/x-ndjson' } })
    }
    throw new TypeError('fetch failed')
  }
  const app = appRunner(['never'])
  const c = consoleOver({ fetch: server, runner: app.host })
  await line(c.bridge, 'operator unlock')
  const r = await line(c.bridge, 'ask hello')
  assert.equal(r.final[0], 'Good evening from Ollama.')
  assert.match(r.final[1], /^-- answered in/)
  assert.equal(app.sent.length, 0, 'a server on this machine comes before the app\'s own model in the auto order')
  assert.ok(c.fetched.length > 0)
  for (const u of c.fetched) assert.match(u, /^http:\/\/(127\.0\.0\.1|localhost):\d+\//, u)
})

test('ask stop: the answer stops at once, the words shown are kept, the runner is told; one answer at a time', async () => {
  const app = appRunner(['Hello ', 'there ', 'and '], true)
  const c = consoleOver({ runner: app.host })
  await line(c.bridge, 'operator unlock')
  const r = run('ask tell me a long story', c.bridge, [])
  const streamed: string[] = []
  r.stream?.subscribe((p) => streamed.push(p.text))
  await until(() => streamed.join('') === 'Hello there and')
  assert.equal(streamed.join(''), 'Hello there and')
  assert.deepEqual((await line(c.bridge, 'ask another')).first, [`ask: ${ANSWER_COMING}`], 'one answer at a time')
  assert.deepEqual((await line(c.bridge, 'ask stop')).first, ['ask: stopping the answer'])
  const final = (await r.pending)?.map((l) => l.text)
  assert.deepEqual(final, ['Hello there and', `ask: ${STOPPED}`])
  await until(() => app.stopped.length > 0)
  assert.deepEqual(app.stopped, [app.sent[0].id], 'the runner was told')
  assert.deepEqual((await line(c.bridge, 'ask stop')).first, ['ask: no answer is being generated'])
})

test('where nothing answers: the router\'s one sentence says what would, and no model file is fetched, kept or loaded', async () => {
  const c = consoleOver({ runner: null })
  await line(c.bridge, 'operator unlock')
  const r = await line(c.bridge, 'ask hello')
  assert.equal(r.final.length, 1, r.final.join('\n'))
  assert.match(r.final[0], /^ask: no model is answering on this machine \(looked for ollama at .+, claude at [^)]+\): start one, or choose one with ask provider <name>$/)
  assert.deepEqual(r.streamed, [])
  for (const u of c.fetched) {
    assert.match(u, /^http:\/\/(127\.0\.0\.1|localhost):\d+\//, `only the servers on this machine are looked for (${u})`)
    assert.doesNotMatch(u, /\.gguf\b|\/models\/|\/api\/pull\b/, `no model file is fetched (${u})`)
  }
  assert.deepEqual(c.store.calls.filter((x) => x !== 'list'), [], 'nothing kept or opened in this page')
  assert.deepEqual(c.rt.calls, [], 'nothing loaded in this page')
})

test('the person\'s words the 14A screen refuses reach no model; the Zeroth Law stands before each answer', async () => {
  const app = appRunner(['Sure.'])
  const c = consoleOver({ runner: app.host })
  await line(c.bridge, 'operator unlock')
  assert.deepEqual((await line(c.bridge, 'ask shut up')).final, ['-- no reply --'])
  assert.equal(app.sent.length, 0, 'no model was asked')
  // Not vouched contained: the gate refuses before the model is asked, in its own words.
  const loose = consoleOver({ runner: appRunner(['Sure.']).host, contained: false })
  await line(loose.bridge, 'operator unlock')
  const r = await line(loose.bridge, 'ask hello')
  const router = loose.router()
  assert.ok(router)
  const why = askRefusal(router, false, true)
  assert.ok(why)
  assert.deepEqual(r.final, [`ask: ${why}`])
})

test('settings typed before the router is loaded wait for it; everything that needs the city still says so', async () => {
  const c = consoleOver({ runner: appRunner(['Hi.']).host })
  await line(c.bridge, 'operator unlock')
  const set = await line(c.bridge, 'ask provider native')
  assert.deepEqual(set.first, [])
  assert.match(set.final[0], /^provider\s+native: /)
  assert.equal(c.loads(), 1)
  // Loaded now: answered at once.
  assert.match((await line(c.bridge, 'ask provider auto')).first[0], /^provider\s+auto: /)
  assert.match((await line(c.bridge, 'ask provider nonsense')).first[0], /^ask: /)
  for (const input of ['run rust: 1 + 1', 'say rust: hi', 'ask file', 'ask gpu on', 'get', 'stats', 'recruit', 'swarm run x']) {
    const r = await line(c.bridge, input)
    assert.match([...r.first, ...r.final].join('\n'), /engine not running$/, input)
  }
})

test('chatAnswer: each way a reply ends reads as the operator\'s answer', () => {
  assert.deepEqual(chatAnswer({ kind: 'said', text: 'Hi.' }, 'Hi', 5), { state: 'Authorized', text: 'Hi.', thinking: 0, done: 'stop', ms: 5 })
  assert.deepEqual(chatAnswer({ kind: 'none', why: 'no model is answering' }, '', 5), { state: 'Authorized', text: '', thinking: 0, error: 'no model is answering', ms: 5 })
  assert.deepEqual(chatAnswer({ kind: 'slow', why: 'it took too long' }, '', 5), { state: 'Authorized', text: '', thinking: 0, error: 'it took too long', ms: 5 })
  assert.deepEqual(chatAnswer({ kind: 'held' }, 'Hel', 5), { state: 'Authorized', text: '', thinking: 0, disengaged: true, ms: 5 }, 'nothing of a held reply is shown')
  assert.deepEqual(chatAnswer({ kind: 'refused' }, '', 5), { state: 'Authorized', text: '', thinking: 0, disengaged: true, ms: 5 })
  assert.deepEqual(chatAnswer({ kind: 'failed', why: 'stopped' }, 'Hel', 5), { state: 'Authorized', text: 'Hel', thinking: 0, error: STOPPED, stopped: true, ms: 5 })
  assert.deepEqual(chatAnswer({ kind: 'failed', why: 'the model failed' }, 'Hel', 5), { state: 'Authorized', text: 'Hel', thinking: 0, error: 'the model failed', ms: 5 })
})

/** The words a request put to the model, as one text. */
const promptOf = (req: GenRequest): string => req.messages.map((m) => m.content).join('\n')
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

test('words that start with a setting\'s name are Sloane\'s and keep nothing; only a setting\'s exact form is that setting; ask -- <words> is always hers', async () => {
  const app = appRunner(['Sure.'])
  const c = consoleOver({ runner: app.host })
  await line(c.bridge, 'operator unlock')
  await line(c.bridge, 'ask provider auto')
  const before = c.kept()
  assert.ok(before)
  for (const words of ['key facts about this city please', 'key to my heart?', 'model trains, are there any in the city?', 'think of a name for me', 'think about it',
    'connect me with someone', 'file a complaint', 'file a complaint for me', 'provider of the city is who?', 'gpu of this machine?', 'vram is what?', 'server me a drink',
    'effort is all it takes', 'api of the city?']) {
    const n = app.sent.length
    const r = await line(c.bridge, `ask ${words}`)
    assert.deepEqual(r.first, ['ask: asking Sloane'], words)
    assert.equal(r.final[0], 'Sure.', words)
    assert.equal(app.sent.length, n + 1, `${words}: put to the model`)
    assert.match(promptOf(app.sent[n]), new RegExp(`Person: ${escapeRe(words)}\\nSloane:$`, 'm'), words)
    assert.equal(c.kept(), before, `${words}: the kept settings are byte for byte as they were`)
  }
  // A setting's name and one value of its kind is a setting; `ask -- ` puts even that to Sloane.
  const n = app.sent.length
  const escaped = await line(c.bridge, 'ask -- model trains?')
  assert.deepEqual(escaped.first, ['ask: asking Sloane'])
  assert.match(promptOf(app.sent[n]), /Person: model trains\?\nSloane:$/m)
  assert.equal(c.kept(), before)
  assert.deepEqual((await line(c.bridge, 'ask --')).first, ['usage: ask -- <words>'])
  const sent = app.sent.length
  const key = await line(c.bridge, 'ask key sk-x')
  assert.match(key.first[0], /^key\s+.*: kept in this browser's local storage/)
  assert.equal((JSON.parse(c.kept() ?? '{}') as { claude: { key: string } }).claude.key, 'sk-x', 'kept as the Claude key')
  assert.match((await line(c.bridge, 'ask vram 8')).first[0], /^vram\s+8/)
  assert.deepEqual((await line(c.bridge, 'ask think on')).first, ['ask: the native provider has no think switch'], 'a setting, refused by the provider auto found')
  assert.match((await line(c.bridge, 'ask gpu on')).first.join('\n'), /^ask: engine not running$/, 'ask gpu stays the city\'s')
  assert.match((await line(c.bridge, 'ask provider native')).first[0], /^provider\s+native: /)
  assert.match((await line(c.bridge, 'ask connect ollama http://127.0.0.1:11434')).first[0], /^provider\s+/)
  assert.equal((JSON.parse(c.kept() ?? '{}') as { provider: string }).provider, 'ollama')
  assert.equal(app.sent.length, sent, 'no setting reached the model')
})

test('the router\'s "ask file load tries again" can be followed here: ask file load|unload|forget|log act on the file kept in this page; choosing one and ask gpu stay the city\'s', async () => {
  const g = globalThis as { localStorage?: unknown }
  const had = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  const marks = new Map<string, string>([[GUARD_KEY, JSON.stringify({ model: 'site', gpu: false, at: 5 })]])
  g.localStorage = { getItem: (k: string) => marks.get(k) ?? null, setItem: (k: string, v: string) => { marks.set(k, v) }, removeItem: (k: string) => { marks.delete(k) } }
  try {
    const loads: string[] = []
    const runtime: InPageRuntime = { ...idleRuntime().runtime, load: async () => { loads.push('load'); throw new Error('this test runtime loads nothing') } }
    const site: KeptModel = { id: 'site-1', name: 'site', files: [{ name: 'site.gguf', bytes: 1000 }], bytes: 1000, keptAt: 1, durable: true }
    const spaced: KeptModel = { id: 'mine-2', name: 'My Model Q4.gguf', files: [{ name: 'My Model Q4.gguf', bytes: 1000 }], bytes: 1000, keptAt: 2, durable: true }
    const forgot: string[] = []
    const models: ModelStore = { ...emptyStore().store, list: async () => [site, spaced], open: async () => [new File([], 'site.gguf')], forget: async (id) => { forgot.push(String(id)); return 1 } }
    const c = consoleOver({ runner: null, kept: JSON.stringify({ provider: 'auto', inpage: JSON.stringify({ model: 'site' }) }), models, runtime })
    await line(c.bridge, 'operator unlock')
    const r = await line(c.bridge, 'ask hello')
    assert.match(r.final.join('\n'), /inpage: the page closed while it was loading site last time .*: ask file load tries again/)
    assert.deepEqual(loads, [], 'not loaded again on its own')
    const load = await line(c.bridge, 'ask file load')
    assert.deepEqual(load.first, ['ask: loading the model in this page...'])
    assert.doesNotMatch(load.final.join('\n'), /engine not running/)
    assert.deepEqual(loads, ['load'], 'the runtime was asked to load the file kept')
    assert.equal(marks.has(GUARD_KEY), false, 'the mark the closed page left is cleared')
    assert.deepEqual((await line(c.bridge, 'ask file log')).first, ['ask: the runtime in this page has logged nothing yet'])
    assert.match((await line(c.bridge, 'ask file unload')).final[0], /^file\s+no model is loaded in this page$/)
    assert.doesNotMatch((await line(c.bridge, 'ask file forget site')).final.join('\n'), /engine not running/)
    assert.deepEqual(forgot, ['site-1'])
    // A kept name may hold spaces (the file's own name): still that file, never a question for Sloane.
    assert.doesNotMatch((await line(c.bridge, 'ask file forget My Model Q4.gguf')).first.join('\n'), /asking Sloane/)
    assert.deepEqual(forgot, ['site-1', 'mine-2'])
    const bare = await line(c.bridge, 'ask file forget')
    assert.match([...bare.first, ...bare.final].join('\n'), /usage: ask file forget <name>/, 'a bare forget is the usage line, as in the city')
    for (const input of ['ask file', 'ask gpu auto']) {
      const x = await line(c.bridge, input)
      assert.match([...x.first, ...x.final].join('\n'), /^ask: engine not running$/m, input)
    }
  } finally {
    if (had) Object.defineProperty(globalThis, 'localStorage', had)
    else delete g.localStorage
  }
})

test('the console bridge refuses a locked ask itself, behind commands.ts, and loads nothing', async () => {
  let loads = 0
  let release: (r: { router: Mind; inPage: ConsoleFile }) => void = () => {}
  const b = consoleBridge(BRAND, { contained: () => true, mind: () => { loads++; return new Promise((r) => { release = r }) } })
  const op = b.operator
  assert.ok(op)
  for (const f of [() => op.ask([], 'hi'), () => op.askStatus(), () => op.askSet('provider', 'native'), () => op.askConnect('native'), () => op.askStop()]) {
    assert.throws(f, /^Error: ask: locked; type 'operator unlock' first$/)
  }
  assert.equal(loads, 0, 'a locked ask loads no router')
  // A setting typed while unlocked waits for the router; locked before it loads, only the bridge's own gate refuses it.
  run('operator unlock', b, [])
  const r = run('ask provider native', b, [])
  assert.equal(loads, 1)
  run('operator lock', b, [])
  const file: ConsoleFile = { load: async () => '', unload: async () => '', forget: async () => '', log: () => [] }
  release({ router: { settings: () => ({}) } as unknown as Mind, inPage: file })
  assert.deepEqual((await r.pending)?.map((l) => l.text), ["ask: locked; type 'operator unlock' first"])
})

test('a router load that failed is tried again at the next ask', async () => {
  const app = appRunner(['Hi.'])
  let calls = 0
  const bridge = consoleBridge(BRAND, {
    contained: () => true,
    mind: async () => {
      calls++
      if (calls === 1) throw new Error('the module did not load')
      const pm = createPageMind({ fetch: NO_SERVER, store: memoryStore(), runtime: () => idleRuntime().runtime, models: () => emptyStore().store, device: () => DESKTOP, runner: app.host, gpuMemory: async () => null, vram: null })
      return { router: pm.router, inPage: pm.inPage }
    },
  })
  await line(bridge, 'operator unlock')
  assert.deepEqual((await line(bridge, 'ask hello')).final, ['ask: the module did not load'])
  assert.equal((await line(bridge, 'ask hello')).final[0], 'Hi.')
  assert.equal(calls, 2)
})

test('with the scripted provider kept, Sloane is not asked as a model', async () => {
  const app = appRunner(['Hi.'])
  const c = consoleOver({ runner: app.host })
  await line(c.bridge, 'operator unlock')
  await line(c.bridge, 'ask provider scripted')
  assert.deepEqual((await line(c.bridge, 'ask hello')).final, [`ask: ${SCRIPTED_CHOSEN}`])
  assert.equal(app.sent.length, 0)
})

test('while the tier is locked, the commands it gates that need the city say engine not running, as they do once it is open; ask asks for operator unlock', async () => {
  const c = consoleOver({ runner: null })
  const gated = ['run rust: 1 + 1', 'say rust: hi', 'swarm run x', 'ring0 unlock --elite password12', 'get x', 'set physics.car.power 2', 'act ok', 'record start',
    'harness run kernel-stop', 'memory forget all', 'feature reset']
  for (const input of gated) {
    const r = await line(c.bridge, input)
    assert.deepEqual([...r.first, ...r.final], [`${input.split(' ')[0]}: engine not running`], input)
  }
  assert.deepEqual((await line(c.bridge, 'ask hello')).first, ["ask: locked; type 'operator unlock' first"])
  await line(c.bridge, 'operator unlock')
  for (const input of gated) {
    const r = await line(c.bridge, input)
    assert.match([...r.first, ...r.final].join('\n'), /engine not running$/, `${input}, open`)
  }
  assert.equal(c.loads(), 0)
})
