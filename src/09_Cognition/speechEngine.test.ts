// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It runs the page's speech recogniser (speechEngine.ts) through every path with fakes for
 * the site, the worker, the keep, the connection and the clock: a first visit asks for the manifest and the four files
 * once each, keeps them and hands them to the worker; a later visit asks the network for nothing; an unasked start on
 * mobile data waits and a pressed one does not; a site with no pack is `absent` for the visit; a site that could not
 * say is asked again later; a failed try is held off (15 s, 60 s, 5 min, then only on the visitor's ask); a file that
 * is not the pin's is forgotten, fetched once more past the cache and refused the second time; a worker that will not
 * start, dies or stops answering is `failed` with its reason and replaced on the next start; utterances are read one
 * at a time in order, the oldest waiting dropped when speech outruns the device; a sentence cut at the microphone's
 * cap is joined with its rest; stop ends everything and a later start begins again.
 * What breaks if it is removed? Any of those paths could strand the pill on "words soon" for ever, download the pack
 * twice, run a file that is not the pin's, or pass half a sentence on as a whole one, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import type { Link } from './siteAuto.ts'
import type { SiteFetch } from './siteModel.ts'
import { holdChecked, type Reading } from './speechCore.ts'
import {
  JOIN_MS, LOAD_MS, READ_MS, RETRY_MS, SpeechEngine, TRIES, WAITING_MAX, speechNote, speechWord,
  type Heard, type SpeechPhase, type SpeechReply, type SpeechRequest, type SpeechState, type SpeechWorkerLike,
} from './speechEngine.ts'
import { SPEECH_MANIFEST, SPEECH_PACK, speechManifestText, type SpeechFile, type SpeechPackPin, type SpeechRole, type SpeechStore } from './speechPack.ts'

const sha = (b: Uint8Array | ArrayBuffer): string => createHash('sha256').update(new Uint8Array(b)).digest('hex')
/** Lets every settled promise's continuation run (the engine awaits the keep, the site and the worker in turn). */
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setImmediate(r)) }

function tinyPack(): { pin: SpeechPackPin; data: Record<string, Uint8Array> } {
  const data: Record<string, Uint8Array> = {
    'rt.wasm': Uint8Array.from({ length: 700 }, (_, i) => i & 255),
    'enc.onnx': Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255),
    'dec.onnx': Uint8Array.from({ length: 500 }, (_, i) => (i * 13) & 255),
    'tokens.json': new TextEncoder().encode('["<unk>","<s>","</s>"]'),
  }
  const f = (role: SpeechRole, file: string): SpeechFile => ({ role, file, bytes: data[file].length, sha256: sha(data[file]) })
  return { pin: { id: 'tiny+rt', name: 'Tiny', lang: 'en', files: [f('runtime', 'rt.wasm'), f('encoder', 'enc.onnx'), f('decoder', 'dec.onnx'), f('tokens', 'tokens.json')] }, data }
}

/** A clock and its timers, moved by hand. */
function clock() {
  let now = 1_000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number): unknown => { timers.set(++seq, { at: now + ms, fn }); return seq },
    clearTimeout: (h: unknown): void => { timers.delete(h as number) },
    advance(ms: number): void {
      const end = now + ms
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
        if (!due) break
        now = due[1].at
        timers.delete(due[0])
        due[1].fn()
      }
      now = end
    },
    pending: () => timers.size,
  }
}

/** The worker: checks hashes as the real one does and answers `ready`, unless told otherwise. */
class FakeWorker implements SpeechWorkerLike {
  onmessage: ((e: { data: SpeechReply }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  terminated = false
  readonly posted: { m: SpeechRequest; transfer: Transferable[] }[] = []
  readonly held = new Map<SpeechRole, ArrayBuffer>()
  /** What a complete load answers: 'ready', a failure's reason, or null for silence. */
  onLoad: 'ready' | { failed: string } | null = 'ready'
  /** Whether read messages are answered at once with this text ('' for an empty reading), or left for the test. */
  auto: string | null = null
  postMessage(m: SpeechRequest, transfer: Transferable[] = []): void {
    if (this.terminated) throw new Error('posted to a terminated worker')
    this.posted.push({ m, transfer })
    if (m.t === 'load') {
      // The real worker's own check (speechCore.ts holdChecked), so this fake cannot drift from it.
      void holdChecked(this.held, m.files, async (b) => sha(b)).then((bad) => {
        for (const role of bad) this.say({ t: 'bad', role })
        if (bad.length > 0 || this.held.size < 4 || this.onLoad === null) return
        this.say(this.onLoad === 'ready' ? { t: 'ready', ms: 12 } : { t: 'failed', why: this.onLoad.failed })
      })
    } else if (this.auto !== null) {
      const text = this.auto
      queueMicrotask(() => this.answer(m.id, text))
    }
  }
  terminate(): void { this.terminated = true }
  say(m: SpeechReply): void { this.onmessage?.({ data: m }) }
  answer(id: number, text: string, more: Partial<Reading> = {}, ms = 80): void {
    this.say({ t: 'read', id, ms, reading: { text, dropped: text === '' ? 'empty' : '', tokens: text === '' ? [] : [5], sure: 0.9, cut: false, seconds: 1, ...more } })
  }
  get loads(): SpeechRequest[] { return this.posted.map((p) => p.m).filter((m) => m.t === 'load') }
  get reads(): Extract<SpeechRequest, { t: 'read' }>[] { return this.posted.map((p) => p.m).filter((m): m is Extract<SpeechRequest, { t: 'read' }> => m.t === 'read') }
}

interface Rig {
  engine: SpeechEngine
  pin: SpeechPackPin
  data: Record<string, Uint8Array>
  /** Every request of the site, in order: the path, ' (fresh)' when it went past the cache. */
  asked: string[]
  /** What the site answers a path with: change it to make the site fail. */
  serve: { manifest: () => Response; file: (name: string, fresh: boolean) => Response | Promise<Response> }
  workers: FakeWorker[]
  /** The keep: what is in it, and every call. */
  kept: Map<SpeechRole, Uint8Array>
  ops: string[]
  phases: SpeechPhase[]
  heard: Heard[]
  dropped: { why: string; seconds: number }[]
  time: ReturnType<typeof clock>
  link: { value: Link | null }
  opts: { served: boolean; makeWorker: (() => FakeWorker) | null }
}

function rig(o: { store?: boolean; kept?: SpeechRole[] } = {}): Rig {
  const { pin, data } = tinyPack()
  const time = clock()
  const asked: string[] = []
  const serve: Rig['serve'] = { manifest: () => new Response(speechManifestText(pin)), file: (name) => res(data[name]) }
  const fetch: SiteFetch = async (path, init) => {
    const fresh = init.cache === 'reload'
    asked.push(`${path}${fresh ? ' (fresh)' : ''}`)
    if (init.signal?.aborted) throw init.signal.reason
    return path === SPEECH_MANIFEST ? serve.manifest() : serve.file(path.slice('speech/'.length), fresh)
  }
  const kept = new Map<SpeechRole, Uint8Array>()
  for (const role of o.kept ?? []) kept.set(role, data[pin.files.find((f) => f.role === role)!.file].slice())
  const ops: string[] = []
  const store: SpeechStore = {
    get: async (f) => { ops.push(`get ${f.role}`); const b = kept.get(f.role); return b && b.length === f.bytes ? b.slice().buffer : null },
    put: async (f, bytes) => { ops.push(`put ${f.role}`); kept.set(f.role, new Uint8Array(bytes.slice(0))) },
    drop: async (f) => { ops.push(`drop ${f.role}`); kept.delete(f.role) },
  }
  const workers: FakeWorker[] = []
  const link: Rig['link'] = { value: null }
  const opts: Rig['opts'] = { served: true, makeWorker: null }
  const engine = new SpeechEngine({
    fetch,
    worker: () => { const w = opts.makeWorker ? opts.makeWorker() : new FakeWorker(); workers.push(w); return w },
    served: () => opts.served,
    store: o.store === false ? undefined : store,
    link: () => link.value,
    pin,
    now: time.now,
    setTimeout: time.setTimeout,
    clearTimeout: time.clearTimeout,
  })
  const phases: SpeechPhase[] = []
  const heard: Heard[] = []
  const dropped: Rig['dropped'] = []
  engine.addEventListener('change', (e) => { const p = (e as CustomEvent<SpeechState>).detail.phase; if (phases.at(-1) !== p) phases.push(p) })
  engine.addEventListener('heard', (e) => heard.push((e as CustomEvent<Heard>).detail))
  engine.addEventListener('dropped', (e) => dropped.push((e as CustomEvent<{ why: string; seconds: number }>).detail))
  return { engine, pin, data, asked, serve, workers, kept, ops, phases, heard, dropped, time, link, opts }
}

/** A response whose body is these bytes. */
const res = (b: Uint8Array): Response => new Response(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer)
const samples = (seconds = 1): Float32Array => new Float32Array(Math.round(seconds * 16_000)).fill(0.1)
const CELLULAR: Link = { type: 'cellular', saveData: false, effectiveType: '4g' }

test('a first visit: the manifest, then the four files once each, kept, handed to the worker with their hashes, and ready', async () => {
  const r = rig()
  assert.deepEqual([r.engine.phase, r.engine.ready, r.engine.claims, r.engine.held], ['off', false, false, false])
  const s = await r.engine.start()
  assert.deepEqual([s.phase, s.detail], ['ready', 'Tiny'])
  assert.deepEqual(r.phases, ['checking', 'getting', 'starting', 'ready'])
  assert.equal(r.asked[0], 'speech/manifest.json')
  assert.deepEqual(r.asked.slice(1).sort(), ['speech/dec.onnx', 'speech/enc.onnx', 'speech/rt.wasm', 'speech/tokens.json'], 'each file once, none past the cache')
  assert.deepEqual(r.ops.filter((x) => x.startsWith('put')).sort(), ['put decoder', 'put encoder', 'put runtime', 'put tokens'])
  for (const f of r.pin.files) assert.deepEqual(r.kept.get(f.role), r.data[f.file], `${f.file} is kept whole`)
  assert.equal(r.workers.length, 1)
  const load = r.workers[0].posted[0]
  assert.equal(load.m.t, 'load')
  const files = (load.m as Extract<SpeechRequest, { t: 'load' }>).files
  assert.deepEqual(files.map((f) => [f.role, f.sha256]), r.pin.files.map((f) => [f.role, f.sha256]), 'all four, in the pin\'s order, each with the hash it must have')
  assert.deepEqual(load.transfer, files.map((f) => f.bytes), 'the bytes go to the worker, not copied')
  assert.ok(r.engine.ready && r.engine.claims)
  assert.equal(r.engine.word(), 'words: understood on this device (Tiny)')
  assert.equal(r.time.pending(), 0, 'no timer is left running')
  // Asked again while ready: nothing happens.
  await r.engine.start()
  await r.engine.start(true)
  assert.equal(r.asked.length, 5)
  assert.equal(r.workers.length, 1)
})

test('the percent counts what is still to come, and moves as the bytes arrive', async () => {
  const r = rig({ kept: ['runtime', 'tokens'] })
  // The two missing files arrive in halves, each half let through by hand.
  const gates: (() => void)[] = []
  r.serve.file = (name) => {
    const b = r.data[name]
    let part = 0
    return new Response(new ReadableStream<Uint8Array>({
      async pull(c) {
        if (part === 2) { c.close(); return }
        await new Promise<void>((go) => gates.push(go))
        c.enqueue(part === 0 ? b.slice(0, b.length / 2) : b.slice(b.length / 2))
        part++
      },
    }))
  }
  const pcts: number[] = []
  r.engine.addEventListener('change', (e) => { const s = (e as CustomEvent<SpeechState>).detail; if (s.phase === 'getting' && pcts.at(-1) !== s.pct) pcts.push(s.pct) })
  const done = r.engine.start()
  await settle()
  assert.equal(r.engine.phase, 'getting')
  assert.deepEqual(r.asked.sort(), ['speech/dec.onnx', 'speech/enc.onnx', 'speech/manifest.json'], 'only what is not kept is asked for')
  assert.equal(speechNote(r.engine.state), 'words 0%')
  while (r.engine.phase === 'getting') { gates.shift()?.(); await settle() }
  await done
  // 800 bytes to come (300 + 500), in halves: every step is a whole percent of those, and it ends at 100.
  assert.equal(pcts[0], 0)
  assert.equal(pcts.at(-1), 100)
  assert.ok(pcts.length >= 4 && pcts.every((p, i) => i === 0 || p > pcts[i - 1]), `rising: ${pcts.join(',')}`)
  assert.ok(r.engine.ready)
})

test('a later visit: everything kept, so the network is asked for nothing, even when it is not there', async () => {
  const r = rig({ kept: ['runtime', 'encoder', 'decoder', 'tokens'] })
  r.serve.manifest = () => { throw new TypeError('Failed to fetch') }
  r.serve.file = () => { throw new TypeError('Failed to fetch') }
  r.link.value = CELLULAR
  const s = await r.engine.start()
  assert.equal(s.phase, 'ready', 'offline, and on mobile data: the kept pack costs nothing')
  assert.deepEqual(r.asked, [])
  assert.deepEqual(r.phases, ['checking', 'starting', 'ready'])
  assert.deepEqual(r.ops, ['get runtime', 'get encoder', 'get decoder', 'get tokens'], 'read, and not written again')
  assert.equal(r.workers[0].loads.length, 1)
})

test('with nowhere to keep it the pack is fetched each visit, and still runs', async () => {
  const r = rig({ store: false })
  assert.equal((await r.engine.start()).phase, 'ready')
  assert.equal(r.asked.length, 5)
  assert.deepEqual(r.ops, [])
})

test('mobile data, a data saver or a 2G link hold an unasked start; the visitor\'s own ask does not wait', async () => {
  for (const [link, why] of [
    [CELLULAR, 'this device is on mobile data'],
    [{ type: 'wifi', saveData: true, effectiveType: '4g' }, 'the browser is set to save data'],
    [{ type: null, saveData: false, effectiveType: '2g' }, 'the connection is too slow for it'],
  ] as const) {
    const r = rig()
    r.link.value = link
    const s = await r.engine.start()
    assert.deepEqual([s.phase, s.detail], ['waiting', why])
    assert.ok(r.engine.held && !r.engine.claims)
    assert.deepEqual(r.asked, [], 'not even the manifest')
    assert.equal(r.engine.word(), `words: waiting (${why})`)
    assert.equal(speechNote(r.engine.state), 'words waiting')
    // Asked again unasked (every speech onset does): nothing is read, asked or said again.
    const before = [r.ops.length, r.phases.length]
    await r.engine.start()
    await r.engine.start()
    assert.deepEqual([r.ops.length, r.phases.length], before)
    // The visitor's own ask gets it.
    assert.equal((await r.engine.start(true)).phase, 'ready')
    assert.ok(!r.engine.held)
    assert.equal(r.asked.length, 5)
  }
  // The link clears by itself (home Wi-Fi): the next unasked start goes.
  const r = rig()
  r.link.value = CELLULAR
  await r.engine.start()
  r.link.value = { type: 'wifi', saveData: false, effectiveType: '4g' }
  assert.equal((await r.engine.start()).phase, 'ready')
})

test('no pack on this site is final for the visit: the page opened as a file, a 404, or another pack\'s manifest', async () => {
  const file = rig()
  file.opts.served = false
  const s = await file.engine.start()
  assert.deepEqual([s.phase, s.detail], ['absent', 'it was opened as a file, not served by a site'])
  assert.deepEqual([file.asked, file.ops], [[], []], 'nothing is asked or read')
  for (const manifest of [() => new Response('nope', { status: 404 }), () => new Response(speechManifestText(SPEECH_PACK)), () => new Response('<html></html>')]) {
    const r = rig()
    r.serve.manifest = manifest
    const a = await r.engine.start()
    assert.deepEqual([a.phase, a.detail], ['absent', 'this site serves none'])
    assert.equal(r.engine.word(), 'words: this page has no speech pack beside it (this site serves none)')
    assert.equal(speechNote(r.engine.state), '', 'nothing beside the pill: the browser\'s own recogniser may still be there')
    assert.ok(!r.engine.claims)
    await r.engine.start()
    await r.engine.start(true)
    assert.deepEqual(r.asked, ['speech/manifest.json'], 'not asked again')
    assert.equal(r.workers.length, 0)
    r.engine.stop()
    assert.equal(r.engine.phase, 'absent', 'a stop does not forget it')
  }
})

test('a site that could not say just now is asked again later, no sooner than after a failure', async () => {
  const r = rig()
  r.serve.manifest = () => new Response('busy', { status: 503 })
  const s = await r.engine.start()
  assert.equal(s.phase, 'waiting')
  assert.match(s.detail, /this site could not be asked for it just now \(the site answered 503/)
  assert.ok(!r.engine.held, 'not the connection\'s hold: pressing is not what it waits for')
  await r.engine.start()
  assert.equal(r.asked.length, 1, 'held off')
  r.time.advance(RETRY_MS[0])
  r.serve.manifest = () => new Response(speechManifestText(r.pin))
  assert.equal((await r.engine.start()).phase, 'ready')
})

test('a failed try is held off 15 s, then 60 s, then 5 min; after four only the visitor\'s ask tries; a success starts the count again', async () => {
  const r = rig()
  r.serve.file = (name) => (name === 'enc.onnx' ? new Response('gone', { status: 500 }) : res(r.data[name]))
  const tries = (): number => r.asked.filter((a) => a === 'speech/manifest.json').length
  const s = await r.engine.start()
  assert.deepEqual([s.phase, s.detail], ['failed', 'this site did not send enc.onnx of the speech pack (HTTP 500)'])
  assert.equal(r.engine.word(), `words: not available (${s.detail})`)
  assert.equal(speechNote(s), 'no words')
  assert.equal(r.workers.length, 0, 'no worker is made for a pack that did not arrive')
  for (const [i, wait] of RETRY_MS.entries()) {
    r.time.advance(wait - 1)
    await r.engine.start()
    assert.equal(tries(), i + 1, `held off for ${wait} ms`)
    r.time.advance(1)
    await r.engine.start()
    assert.equal(tries(), i + 2, 'then tried')
    assert.equal(r.engine.phase, 'failed')
  }
  assert.equal(tries(), TRIES)
  r.time.advance(24 * 3_600_000)
  await r.engine.start()
  assert.equal(tries(), TRIES, 'the visit\'s own tries are spent')
  await r.engine.start(true)
  assert.equal(tries(), TRIES + 1, 'the visitor\'s ask still tries')
  // The site mends: a forced start gets it, and what earlier tries kept is not fetched again.
  r.serve.file = (name) => res(r.data[name])
  const before = r.asked.length
  assert.equal((await r.engine.start(true)).phase, 'ready')
  const last = r.asked.slice(before)
  assert.ok(last.includes('speech/enc.onnx') && last.length <= 5)
  for (const f of r.pin.files) assert.deepEqual(r.kept.get(f.role), r.data[f.file])
  // The count began again: one crash later, the hold-off is the first one.
  r.workers.at(-1)!.onerror?.({ message: 'out of memory' })
  assert.deepEqual([r.engine.phase, r.engine.state.detail], ['failed', 'the recogniser stopped (out of memory)'])
  r.time.advance(RETRY_MS[0] - 1)
  await r.engine.start()
  assert.equal(r.engine.phase, 'failed')
  r.time.advance(1)
  assert.equal((await r.engine.start()).phase, 'ready', 'a new worker, from the keep')
  assert.equal(r.asked.length, before + last.length, 'and nothing asked of the network')
})

test('a file that is not the pin\'s is forgotten and fetched once more past the cache; still wrong, it is refused and nothing runs', async () => {
  // What the browser's cache gave is corrupt; the site's own copy is right.
  const r = rig()
  const corrupt = r.data['dec.onnx'].slice()
  corrupt[7] ^= 1
  r.serve.file = (name, fresh) => res(name === 'dec.onnx' && !fresh ? corrupt : r.data[name])
  assert.equal((await r.engine.start()).phase, 'ready')
  assert.deepEqual(r.asked.at(-1), 'speech/dec.onnx (fresh)')
  assert.equal(r.asked.filter((a) => a.endsWith('(fresh)')).length, 1)
  const loads = r.workers[0].loads as Extract<SpeechRequest, { t: 'load' }>[]
  assert.deepEqual(loads.map((l) => l.files.map((f) => f.role)), [['runtime', 'encoder', 'decoder', 'tokens'], ['decoder']], 'only the bad file is sent again')
  assert.deepEqual(r.ops.slice(-2), ['drop decoder', 'put decoder'])
  assert.deepEqual(r.kept.get('decoder'), r.data['dec.onnx'], 'the keep ends with the right bytes')
  // Two files wrong at once (the first and the last): each comes again, and the two between them were not lost.
  const two = rig()
  two.serve.file = (name, fresh) => res((name === 'rt.wasm' || name === 'tokens.json') && !fresh ? two.data[name].map((b) => b ^ 2) : two.data[name])
  assert.equal((await two.engine.start()).phase, 'ready')
  assert.deepEqual(two.asked.filter((a) => a.endsWith('(fresh)')).sort(), ['speech/rt.wasm (fresh)', 'speech/tokens.json (fresh)'])
  assert.deepEqual([...two.workers[0].held.keys()].sort(), ['decoder', 'encoder', 'runtime', 'tokens'])
  for (const f of two.pin.files) assert.deepEqual(two.kept.get(f.role), two.data[f.file])
  // The kept copy is corrupt (same size): nothing else is asked for, not even the manifest.
  const k = rig({ kept: ['runtime', 'encoder', 'decoder', 'tokens'] })
  k.kept.set('encoder', k.kept.get('encoder')!.map((b, i) => (i === 3 ? b ^ 255 : b)))
  assert.equal((await k.engine.start()).phase, 'ready')
  assert.deepEqual(k.asked, ['speech/enc.onnx (fresh)'])
  assert.deepEqual(k.kept.get('encoder'), k.data['enc.onnx'])
  // The site's own copy is wrong too: refused, the worker ended, the bad copy not left in the keep's way.
  const bad = rig()
  bad.serve.file = (name) => res(name === 'rt.wasm' ? bad.data['rt.wasm'].map((b) => b ^ 1) : bad.data[name])
  const s = await bad.engine.start()
  assert.deepEqual([s.phase, s.detail], ['failed', 'what this site sent as rt.wasm is not the speech pack this page was built for (its SHA-256 differs), so it was not run'])
  assert.ok(bad.workers[0].terminated)
  assert.equal(bad.asked.filter((a) => a === 'speech/rt.wasm (fresh)').length, 1, 'asked past the cache once, not for ever')
  assert.equal(bad.time.pending(), 0)
})

test('a corrupt kept file on mobile data is forgotten and waited for, not fetched unasked', async () => {
  const r = rig({ kept: ['runtime', 'encoder', 'decoder', 'tokens'] })
  r.kept.set('decoder', r.kept.get('decoder')!.map((b, i) => (i === 0 ? b ^ 1 : b)))
  r.link.value = CELLULAR
  const s = await r.engine.start()
  assert.deepEqual([s.phase, s.detail], ['waiting', 'this device is on mobile data'])
  assert.ok(r.engine.held)
  assert.deepEqual(r.asked, [])
  assert.ok(!r.kept.has('decoder'), 'the bad copy is gone')
  assert.ok(r.workers[0].terminated)
  assert.equal(r.time.pending(), 0)
  assert.equal((await r.engine.start(true)).phase, 'ready', 'the visitor\'s ask gets the one file')
  assert.deepEqual(r.asked, ['speech/manifest.json', 'speech/dec.onnx'])
})

test('a worker that cannot be made, says it failed, dies or never answers is a failure with its reason, and is ended', async () => {
  const none = rig()
  none.opts.makeWorker = () => { throw new Error('Worker is not defined') }
  let s = await none.engine.start()
  assert.deepEqual([s.phase, s.detail], ['failed', 'this browser could not start the recogniser\'s worker (Worker is not defined)'])
  assert.equal(none.time.pending(), 0)

  const said = rig()
  said.opts.makeWorker = () => Object.assign(new FakeWorker(), { onLoad: { failed: 'this browser could not load the speech model (out of memory)' } })
  s = await said.engine.start()
  assert.deepEqual([s.phase, s.detail], ['failed', 'this browser could not load the speech model (out of memory)'])
  assert.ok(said.workers[0].terminated)

  const died = rig()
  died.opts.makeWorker = () => Object.assign(new FakeWorker(), { onLoad: null })
  let p = died.engine.start()
  await settle()
  assert.equal(died.engine.phase, 'starting')
  assert.equal(speechNote(died.engine.state), 'words starting')
  died.workers[0].onerror?.({ message: 'Script error.' })
  s = await p
  assert.deepEqual([s.phase, s.detail], ['failed', 'the recogniser\'s worker stopped (Script error.)'])
  assert.ok(died.workers[0].terminated)
  assert.equal(died.time.pending(), 0)

  const hung = rig()
  hung.opts.makeWorker = () => Object.assign(new FakeWorker(), { onLoad: null })
  p = hung.engine.start()
  await settle()
  hung.time.advance(LOAD_MS - 1)
  await settle()
  assert.equal(hung.engine.phase, 'starting')
  hung.time.advance(1)
  s = await p
  assert.deepEqual([s.phase, s.detail], ['failed', 'the recogniser took too long to start'])
  assert.ok(hung.workers[0].terminated)
  // A late answer from the ended worker changes nothing.
  hung.workers[0].say({ t: 'ready', ms: 1 })
  assert.equal(hung.engine.phase, 'failed')
})

test('utterances are read one at a time, in order, and each sentence is passed on with how long it was and how sure', async () => {
  const r = rig()
  assert.equal(r.engine.read(samples()), false, 'nothing is read, or kept, before it is ready')
  await r.engine.start()
  const w = r.workers[0]
  assert.equal(r.engine.read(new Float32Array(0)), false)
  const a = samples(1.5), b = samples(2)
  assert.equal(r.engine.read(a), true)
  assert.equal(r.engine.read(b), true)
  assert.equal(w.reads.length, 1, 'the second waits for the first')
  assert.deepEqual([w.reads[0].id, w.reads[0].samples], [1, a])
  assert.deepEqual(w.posted.at(-1)!.transfer, [a.buffer], 'the samples go to the worker, not copied')
  assert.equal(r.engine.state.reading, true)
  w.answer(1, 'Take me to the tailor.', { sure: 0.8 }, 240)
  assert.deepEqual(r.heard, [{ text: 'Take me to the tailor.', seconds: 1.5, ms: 240, sure: 0.8 }])
  assert.deepEqual([w.reads.length, w.reads[1].id], [2, 2], 'then the next')
  // An answer for a reading that is not the current one is not taken.
  w.answer(1, 'again')
  w.answer(7, 'never asked')
  assert.equal(r.heard.length, 1)
  w.answer(2, 'Thanks.')
  assert.deepEqual(r.heard.map((h) => h.text), ['Take me to the tailor.', 'Thanks.'])
  assert.equal(r.engine.state.reading, false)
  assert.equal(r.engine.counts.heard, 2)
  assert.equal(r.time.pending(), 0, 'no watchdog is left')
})

test('readings with no words are counted by reason and say nothing; a runtime error is one of them', async () => {
  const r = rig()
  await r.engine.start()
  const w = r.workers[0]
  for (const [i, why] of (['short', 'quiet', 'unsure', 'empty'] as const).entries()) {
    r.engine.read(samples())
    w.answer(i + 1, '', { dropped: why })
  }
  r.engine.read(samples(2))
  w.say({ t: 'error', id: 5, why: 'bad tensor' })
  assert.deepEqual(r.dropped.map((d) => d.why), ['short', 'quiet', 'unsure', 'empty', 'error'])
  assert.equal(r.dropped[4].seconds, 2)
  assert.deepEqual(r.heard, [])
  assert.deepEqual(r.engine.counts, { heard: 0, short: 1, quiet: 1, unsure: 1, empty: 1, error: 1 })
  assert.ok(r.engine.ready, 'one bad reading does not end the recogniser')
})

test('speech that outruns the device: at most three wait, and the oldest waiting is the one dropped', async () => {
  const r = rig()
  await r.engine.start()
  const w = r.workers[0]
  const all = [1, 2, 3, 4, 5, 6].map((n) => samples(n / 10))
  for (const s of all) r.engine.read(s)
  // The first is being read; of the five after it, the two oldest were dropped.
  assert.equal(WAITING_MAX, 3)
  assert.deepEqual(r.dropped.map((d) => [d.why, Number(d.seconds.toFixed(1))]), [['late', 0.2], ['late', 0.3]])
  for (let id = 1; id <= 4; id++) w.answer(id, `s${id}`)
  assert.deepEqual(w.reads.map((m) => m.samples.length), [all[0], all[3], all[4], all[5]].map((s) => s.length), 'the newest are read, in order')
  assert.deepEqual(r.heard.map((h) => h.text), ['s1', 's2', 's3', 's4'])
  assert.equal(r.engine.counts.late, 2)
})

test('a worker that stops answering a reading is taken for hung after 20 s and four times the speech, ended, and replaced on the next start', async () => {
  const r = rig()
  await r.engine.start()
  r.engine.read(samples(5))
  r.engine.read(samples(1))
  r.time.advance(READ_MS + 5 * 4_000 - 1)
  assert.ok(r.engine.ready)
  r.time.advance(1)
  assert.deepEqual([r.engine.phase, r.engine.state.detail], ['failed', 'the recogniser stopped (it stopped answering)'])
  assert.ok(r.workers[0].terminated)
  assert.equal(r.engine.read(samples()), false)
  assert.equal(r.engine.state.reading, false)
  // Its late answer is nothing; what waited is gone with it.
  r.workers[0].answer(1, 'too late')
  assert.equal(r.heard.length, 0)
  r.time.advance(RETRY_MS[0])
  const asked = r.asked.length
  assert.equal((await r.engine.start()).phase, 'ready')
  assert.equal(r.workers.length, 2)
  assert.equal(r.asked.length, asked, 'from the keep')
  r.engine.read(samples())
  assert.deepEqual(r.workers[1].reads.length, 1, 'only new speech is read: nothing of the old queue')
  r.workers[1].answer(r.workers[1].reads[0].id, 'Hello again.')
  assert.deepEqual(r.heard.map((h) => h.text), ['Hello again.'])
})

test('a sentence cut at the microphone\'s cap waits for its rest and is passed on as one', async () => {
  const r = rig()
  await r.engine.start()
  const w = r.workers[0]
  let id = 0
  const say = (text: string, cut: boolean, seconds: number, more: Partial<Reading> = {}, ms = 100): void => { r.engine.read(samples(seconds), cut); w.answer(++id, text, more, ms) }
  // Two parts: joined, the lengths and times added, as sure as the less sure part.
  say('Take me to the tailor on', true, 12, { sure: 0.9 }, 300)
  assert.equal(r.heard.length, 0, 'held')
  say('the far side of the river.', false, 3, { sure: 0.6 }, 100)
  assert.deepEqual(r.heard, [{ text: 'Take me to the tailor on the far side of the river.', seconds: 15, ms: 400, sure: 0.6 }])
  assert.equal(r.engine.counts.heard, 1)
  // Three parts.
  say('one', true, 12); say('two', true, 12); say('three', false, 1)
  assert.equal(r.heard[1].text, 'one two three')
  // The rest gave nothing: the first part goes on alone.
  say('Only this', true, 12)
  say('', false, 1, { dropped: 'unsure' })
  assert.equal(r.heard[2].text, 'Only this')
  // The rest threw: likewise.
  say('Before the error', true, 12)
  r.engine.read(samples(1))
  w.say({ t: 'error', id: ++id, why: 'x' })
  assert.equal(r.heard[3].text, 'Before the error')
  // The rest never came: passed on alone after the wait.
  say('Left hanging', true, 12)
  r.time.advance(JOIN_MS - 1)
  assert.equal(r.heard.length, 4)
  r.time.advance(1)
  assert.equal(r.heard[4].text, 'Left hanging')
  // The microphone closed: flushed at once (App.tsx calls flush on close).
  say('Closed on', true, 12)
  r.engine.flush()
  assert.equal(r.heard[5].text, 'Closed on')
  r.engine.flush()
  assert.equal(r.heard.length, 6, 'nothing held, nothing said')
  // A cut part that gave nothing holds nothing, and the next sentence stands alone.
  say('', true, 12)
  say('Fresh start.', false, 2)
  assert.equal(r.heard[6].text, 'Fresh start.')
  // The worker died with a part held: what was read is still passed on.
  say('Read before it died', true, 12)
  w.onerror?.({ message: 'gone' })
  assert.equal(r.heard[7].text, 'Read before it died')
  assert.equal(r.engine.counts.heard, 8)
  assert.equal(r.time.pending(), 0)
})

test('stop ends the download, the worker and every timer; a late answer is nothing; a later start begins again', async () => {
  // Stopped while the files are arriving.
  const r = rig()
  let release: () => void = () => undefined
  r.serve.file = (name) => new Response(new ReadableStream<Uint8Array>({ async pull(c) { await new Promise<void>((go) => { release = go }); c.enqueue(r.data[name]); c.close() } }))
  const p = r.engine.start()
  await settle()
  assert.equal(r.engine.phase, 'getting')
  r.engine.stop()
  assert.equal(r.engine.phase, 'off')
  release()
  const s = await p
  assert.equal(s.phase, 'off', 'the stopped start says where things stand, and changed nothing')
  assert.equal(r.workers.length, 0)
  assert.equal(r.time.pending(), 0)
  // Stopped while the worker loads.
  const l = rig()
  l.opts.makeWorker = () => Object.assign(new FakeWorker(), { onLoad: null })
  const q = l.engine.start()
  await settle()
  assert.equal(l.engine.phase, 'starting')
  l.engine.stop()
  assert.ok(l.workers[0].terminated)
  assert.equal(l.time.pending(), 0, 'the load\'s timer ends with it')
  l.workers[0].say({ t: 'ready', ms: 1 })
  assert.equal((await q).phase, 'off')
  // Stopped while ready, with a reading under way and a part held.
  const d = rig()
  await d.engine.start()
  d.engine.read(samples(12), true)
  d.workers[0].answer(1, 'half a')
  d.engine.read(samples())
  d.engine.stop()
  assert.deepEqual([d.engine.phase, d.engine.state.reading, d.workers[0].terminated], ['off', false, true])
  assert.equal(d.time.pending(), 0)
  d.workers[0].answer(2, 'late')
  d.time.advance(JOIN_MS * 2)
  assert.deepEqual(d.heard, [], 'a stop passes nothing on (the page flushes first where it wants the words)')
  assert.equal(d.engine.read(samples()), false)
  // And it starts again, from the keep.
  const asked = d.asked.length
  assert.equal((await d.engine.start()).phase, 'ready')
  assert.deepEqual([d.workers.length, d.asked.length], [2, asked])
  // Disposed: nothing starts again.
  d.engine.dispose()
  assert.equal((await d.engine.start(true)).phase, 'off')
  assert.equal(d.workers.length, 2)
})

test('two starts at once are one start', async () => {
  const r = rig()
  const [a, b] = await Promise.all([r.engine.start(), r.engine.start(true)])
  assert.deepEqual([a.phase, r.engine.phase], ['ready', 'ready'])
  assert.ok(b.phase === 'checking' || b.phase === 'ready', 'the second says where the first stands')
  assert.equal(r.asked.length, 5)
  assert.equal(r.workers.length, 1)
})

test('the words for every phase', () => {
  const s = (phase: SpeechPhase, detail = '', pct = 0): SpeechState => ({ phase, detail, pct, reading: false })
  const { pin } = tinyPack()
  assert.equal(speechWord(s('off'), pin), 'words: not started')
  assert.equal(speechWord(s('checking'), pin), 'words: asking this site for the speech pack')
  assert.equal(speechWord(s('getting', '', 37), pin), 'words: getting the speech pack, 37% of 0 MB')
  assert.equal(speechWord(s('getting', '', 37)), 'words: getting the speech pack, 37% of 41 MB')
  assert.equal(speechWord(s('starting'), pin), 'words: starting the recogniser')
  assert.equal(speechWord(s('ready'), pin), 'words: understood on this device (Tiny)')
  assert.equal(speechWord(s('ready')), 'words: understood on this device (Moonshine Tiny (English))')
  assert.deepEqual((['off', 'absent', 'ready', 'checking', 'getting', 'starting', 'waiting', 'failed'] as const).map((p) => speechNote(s(p, 'x', 5))), ['', '', '', 'words soon', 'words 5%', 'words starting', 'words waiting', 'no words'])
})
