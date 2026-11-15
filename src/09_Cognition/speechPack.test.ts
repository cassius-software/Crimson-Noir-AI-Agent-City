// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the speech pack to its record: the pin (speechPack.ts SPEECH_PACK) equals the
 * SHA256SUMS lines and the notices beside the model's and the runtime's licences (third_party/moonshine-tiny-en/,
 * third_party/onnxruntime-web/1.31.1/), the runtime's WebAssembly module in the installed package is the pinned one,
 * the page names no address the pack comes from, the manifest offers only exactly the pin, a file is taken only whole
 * and at the pinned size (a short body, a long one, an HTTP error, an unreachable site and a stop each end with a
 * plain sentence and no bytes), and the keep between visits gives back only a copy of the pinned size, under a name of
 * the pack's own that the web copy's service worker does not clear, and never throws.
 * What breaks if it is removed? A pin that drifted from its record, a pack of another model taken for this one, or a
 * keep that threw in a private window would pass in silence, and the microphone would understand nothing there.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { SiteFetch } from './siteModel.ts'
import { SITE_DIR, siteUrl } from './siteModel.ts'
import {
  SERVED_DIRS, SPEECH_CACHE, SPEECH_DIR, SPEECH_MANIFEST, SPEECH_PACK, fetchSpeechFile, parseSpeechManifest, speechBytes, speechFile, speechManifestText,
  speechOffered, speechPath, speechSize, speechStore, type CachesLike, type SpeechFile, type SpeechPackPin,
} from './speechPack.ts'

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const bytesOf = (p: string): Uint8Array => readFileSync(new URL(p, import.meta.url))
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex')

/** A small pack of made-up files, pinned by their own bytes. */
function tiny(): { pin: SpeechPackPin; data: Record<string, Uint8Array> } {
  const data: Record<string, Uint8Array> = {
    'rt.wasm': Uint8Array.from({ length: 700 }, (_, i) => i & 255),
    'enc.onnx': Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255),
    'dec.onnx': Uint8Array.from({ length: 500 }, (_, i) => (i * 13) & 255),
    'tokens.json': new TextEncoder().encode('["<unk>","<s>","</s>"]'),
  }
  const f = (role: SpeechFile['role'], file: string): SpeechFile => ({ role, file, bytes: data[file].length, sha256: sha(data[file]) })
  return { pin: { id: 'tiny+rt', name: 'Tiny', lang: 'en', files: [f('runtime', 'rt.wasm'), f('encoder', 'enc.onnx'), f('decoder', 'dec.onnx'), f('tokens', 'tokens.json')] }, data }
}

/** A body in chunks of `step` bytes. */
function body(b: Uint8Array, step = 128, fail = -1): ReadableStream<Uint8Array> {
  let at = 0
  return new ReadableStream({
    pull(c) {
      if (fail >= 0 && at >= fail) { c.error(new Error('connection reset')); return }
      if (at >= b.length) { c.close(); return }
      c.enqueue(b.slice(at, Math.min(b.length, at + step)))
      at += step
    },
  })
}

test('the pin is the record beside the licences: both SHA256SUMS files, both notices, the committed vocabulary and the installed runtime', () => {
  const line = (f: SpeechFile): string => `${f.sha256}  ${f.file}\n`
  assert.equal(read('../../third_party/moonshine-tiny-en/SHA256SUMS'), ['encoder', 'decoder', 'tokens'].map((r) => line(speechFile(r as SpeechFile['role']))).join(''))
  assert.equal(read('../../third_party/onnxruntime-web/1.31.1/SHA256SUMS'), line(speechFile('runtime')))
  const model = read('../../third_party/moonshine-tiny-en/NOTICE'), runtime = read('../../third_party/onnxruntime-web/1.31.1/NOTICE')
  for (const f of SPEECH_PACK.files) {
    const notice = f.role === 'runtime' ? runtime : model
    assert.match(notice, new RegExp(`${f.file.replaceAll('.', '\\.')} +${f.bytes} bytes, sha256 ${f.sha256}`), `${f.file} in its notice`)
    assert.match(f.sha256, /^[0-9a-f]{64}$/)
    assert.ok(Number.isSafeInteger(f.bytes) && f.bytes > 0)
    assert.match(f.file, /^[A-Za-z0-9][A-Za-z0-9._-]*$/)
    assert.ok(Object.isFrozen(f))
  }
  assert.ok(Object.isFrozen(SPEECH_PACK) && Object.isFrozen(SPEECH_PACK.files))
  assert.deepEqual(SPEECH_PACK.files.map((f) => f.role), ['runtime', 'encoder', 'decoder', 'tokens'])
  // The licences beside the records are the MIT texts, each with its holder.
  assert.match(read('../../third_party/moonshine-tiny-en/LICENSE'), /MIT License[\s\S]*Copyright \(c\) 2025 Useful Sensors, Inc\.[\s\S]*Permission is hereby granted, free of charge/)
  assert.match(read('../../third_party/onnxruntime-web/1.31.1/LICENSE'), /MIT License[\s\S]*Copyright \(c\) Microsoft Corporation[\s\S]*Permission is hereby granted, free of charge/)
  assert.match(model, /Licence: MIT/)
  assert.match(model, /Spanish model under the Moonshine AI Community License[\s\S]*not fetched, not shipped/, 'the notice says what is not used')
  // The vocabulary is committed; the runtime's module is the installed package's, at the version package.json pins.
  const tokens = bytesOf('../../third_party/moonshine-tiny-en/tokens.json')
  assert.deepEqual([tokens.length, sha(tokens)], [speechFile('tokens').bytes, speechFile('tokens').sha256])
  const wasm = bytesOf('../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm')
  assert.deepEqual([wasm.length, sha(wasm)], [speechFile('runtime').bytes, speechFile('runtime').sha256], 'the installed runtime is the pinned one')
  const pkg = JSON.parse(read('../../package.json')) as { dependencies: Record<string, string> }
  assert.equal(pkg.dependencies['onnxruntime-web'], '1.31.1', 'pinned exactly: a caret would let the module drift from the pin')
  assert.ok(SPEECH_PACK.id.endsWith('+ort-1.31.1') && runtime.includes('version\n1.31.1'), 'the id and the notice name the same version')
})

test('the size, the folder and the paths: 41 MB in all, speech/ beside models/, every file a path siteUrl admits', () => {
  assert.equal(speechBytes(), 14_848_852 + 7_937_661 + 20_243_286 + 307_261)
  assert.equal(speechSize(), '41 MB')
  assert.equal(SPEECH_DIR, 'speech/')
  assert.equal(SPEECH_MANIFEST, 'speech/manifest.json')
  assert.deepEqual([...SERVED_DIRS], [SITE_DIR, SPEECH_DIR])
  const base = 'https://owner.github.io/Crimson-Noir-AI-Agent-City/'
  for (const f of SPEECH_PACK.files) assert.equal(siteUrl(speechPath(f), base), `${base}speech/${f.file}`)
  assert.equal(siteUrl(SPEECH_MANIFEST, base), `${base}speech/manifest.json`)
  assert.throws(() => speechFile('nope' as SpeechFile['role']), /has no nope/)
  // The page names no address the pack comes from: where the files are fetched from is the tool's to know.
  const src = read('./speechPack.ts')
  assert.doesNotMatch(src, /https?:\/\//, 'no address in the page\'s source')
})

test('the manifest offers only exactly the pin', () => {
  const { pin } = tiny()
  const text = speechManifestText(pin)
  assert.ok(text.endsWith('}\n') && !text.slice(0, -1).includes('\n'), 'one line and a newline')
  assert.deepEqual(JSON.parse(text), { v: 1, id: pin.id, files: pin.files.map(({ role, file, bytes, sha256 }) => ({ role, file, bytes, sha256 })) })
  assert.ok(parseSpeechManifest(text, pin))
  assert.ok(parseSpeechManifest(speechManifestText()), 'the real pin reads its own manifest')
  assert.ok(!parseSpeechManifest(text), 'another pack is no offer')
  const m = JSON.parse(text) as { v: number; id: string; files: { role: string; file: string; bytes: number; sha256: string }[] }
  const change = (fn: (x: typeof m) => void): string => { const c = structuredClone(m); fn(c); return JSON.stringify(c) }
  for (const [what, bad] of [
    ['another version', change((x) => { x.v = 2 })],
    ['another id', change((x) => { x.id = 'other' })],
    ['a file fewer', change((x) => { x.files.pop() })],
    ['a file more', change((x) => { x.files.push(x.files[0]) })],
    ['another size', change((x) => { x.files[1].bytes++ })],
    ['another hash', change((x) => { x.files[2].sha256 = '0'.repeat(64) })],
    ['another name', change((x) => { x.files[0].file = 'x.wasm' })],
    ['another order', change((x) => { x.files.reverse() })],
    ['a null file', change((x) => { (x.files as unknown[])[0] = null })],
    ['a page', '<!doctype html><title>404</title>'],
    ['nothing', ''],
    ['null', 'null'],
    ['an array', '[]'],
  ] as const) assert.ok(!parseSpeechManifest(bad, pin), what)
})

test('speechOffered: yes for this pin\'s manifest, no where the site has none, and a throw where it could not say', async () => {
  const { pin } = tiny()
  const asked: { path: string; init: RequestInit }[] = []
  const site = (res: () => Response): SiteFetch => async (path, init) => { asked.push({ path, init }); return res() }
  assert.equal(await speechOffered(site(() => new Response(speechManifestText(pin))), pin), true)
  assert.deepEqual([asked[0].path, asked[0].init.cache], ['speech/manifest.json', 'no-cache'], 'the manifest is always asked of the site, never taken stale')
  assert.equal(await speechOffered(site(() => new Response(speechManifestText())), pin), false, 'another pack')
  assert.equal(await speechOffered(site(() => new Response('<html>home</html>')), pin), false, 'a page served for every path')
  assert.equal(await speechOffered(site(() => new Response('gone', { status: 404 })), pin), false)
  assert.equal(await speechOffered(site(() => new Response('gone', { status: 410 })), pin), false)
  for (const status of [429, 500, 503]) await assert.rejects(speechOffered(site(() => new Response('later', { status })), pin), new RegExp(`answered ${status}`))
  await assert.rejects(speechOffered(async () => { throw new TypeError('Failed to fetch') }, pin), /Failed to fetch/)
})

test('a file is taken whole and at the pinned size, counting as it goes; anything else is a plain sentence and no bytes', async () => {
  const { pin, data } = tiny()
  const f = pin.files[2]
  const asked: { path: string; cache: unknown }[] = []
  const site = (res: () => Response): SiteFetch => async (path, init) => { asked.push({ path, cache: init.cache }); return res() }
  const counted: number[] = []
  const got = await fetchSpeechFile(site(() => new Response(body(data[f.file]))), f, (n) => counted.push(n))
  assert.deepEqual(new Uint8Array(got), data[f.file])
  assert.deepEqual(counted, [128, 128, 128, 116], 'each chunk as it arrived')
  assert.deepEqual(asked[0], { path: 'speech/dec.onnx', cache: 'no-cache' }, 'the browser\'s copy is taken once the site says it is current: the path is the same under every pin')
  await fetchSpeechFile(site(() => new Response(body(data[f.file]))), f, () => undefined, undefined, true)
  assert.equal(asked[1].cache, 'reload', 'fresh goes past the cache')
  const none = (): void => undefined
  await assert.rejects(fetchSpeechFile(site(() => new Response(body(data[f.file].slice(0, 200)))), f, none), /the download of dec\.onnx stopped at 200 of 500 bytes/)
  await assert.rejects(fetchSpeechFile(site(() => new Response(body(new Uint8Array(501)))), f, none), /larger than the speech pack this page was built for/)
  await assert.rejects(fetchSpeechFile(site(() => new Response(body(data[f.file], 128, 256))), f, none), /stopped at 256 of 500 bytes/)
  await assert.rejects(fetchSpeechFile(site(() => new Response('no', { status: 404 })), f, none), /did not send dec\.onnx of the speech pack \(HTTP 404\)/)
  await assert.rejects(fetchSpeechFile(site(() => new Response(null, { status: 200 })), f, none), /did not send dec\.onnx/)
  await assert.rejects(fetchSpeechFile(async () => { throw new TypeError('Failed to fetch') }, f, none), /could not be reached for the speech pack \(Failed to fetch\)/)
  // A stop: before it starts, and in the middle (the reader is cancelled and the abort's own reason is what rejects).
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(fetchSpeechFile(site(() => new Response(body(data[f.file]))), f, none, stopped.signal), { name: 'AbortError' })
  const mid = new AbortController()
  await assert.rejects(fetchSpeechFile(site(() => new Response(body(data[f.file]))), f, () => mid.abort(), mid.signal), { name: 'AbortError' })
})

/** Cache Storage as a Map of Maps, with switches to make it refuse. */
function fakeCaches() {
  const stores = new Map<string, Map<string, Uint8Array>>()
  const fail = { open: false, put: false, match: false }
  const caches: CachesLike = {
    async open(name) {
      if (fail.open) throw new DOMException('refused', 'SecurityError')
      let s = stores.get(name)
      if (!s) stores.set(name, (s = new Map()))
      const store = s
      return {
        async match(key) {
          if (fail.match) throw new Error('read failed')
          const b = store.get(key)
          return b ? { arrayBuffer: async () => b.slice().buffer } : undefined
        },
        async put(key, response) {
          if (fail.put) throw new DOMException('no room', 'QuotaExceededError')
          store.set(key, new Uint8Array(await response.arrayBuffer()))
        },
        async delete(key) { return store.delete(key) },
      }
    },
    async keys() { return [...stores.keys()] },
    async delete(name) { return stores.delete(name) },
  }
  return { caches, stores, fail }
}

test('the keep: a cache of the pack\'s own name, each file under its name and hash; only a copy of the pinned size comes back', async () => {
  const { pin, data } = tiny()
  const c = fakeCaches()
  const keep = speechStore(c.caches, pin)
  const f = pin.files[1]
  assert.equal(await keep.get(f), null, 'nothing kept yet')
  const bytes = data[f.file].slice().buffer
  await keep.put(f, bytes)
  assert.equal(bytes.byteLength, f.bytes, 'the bytes are not taken from the caller')
  assert.deepEqual([...c.stores.keys()], [`${SPEECH_CACHE}${pin.id}`])
  assert.deepEqual([...c.stores.get(`${SPEECH_CACHE}${pin.id}`)!.keys()], [`speech/${f.file}?sha256=${f.sha256}`])
  assert.deepEqual(new Uint8Array((await keep.get(f))!), data[f.file])
  assert.equal(await keep.get(pin.files[0]), null, 'another file is not there')
  // The same name with another hash (a newer pin's file) is another entry: never taken for this one.
  assert.equal(await keep.get({ ...f, sha256: 'f'.repeat(64) }), null)
  // A kept copy of the wrong size (a write cut short) is no copy.
  c.stores.get(`${SPEECH_CACHE}${pin.id}`)!.set(`speech/${f.file}?sha256=${f.sha256}`, data[f.file].slice(0, 10))
  assert.equal(await keep.get(f), null)
  await keep.drop(f)
  assert.equal(c.stores.get(`${SPEECH_CACHE}${pin.id}`)!.size, 0)
  await keep.drop(f)
  // Not the web copy's own prefix: its service worker deletes every cache named agent-city-* but its newest.
  assert.ok(!SPEECH_CACHE.startsWith('agent-city-'))
  assert.match(read('../../tools/web/pwa.mjs'), /k\.startsWith\('agent-city-'\)/, 'the prefix the service worker clears is still that one')
})

test('the keep clears an older pack\'s cache when this one is first written, and leaves every other cache alone', async () => {
  const { pin, data } = tiny()
  const c = fakeCaches()
  c.stores.set(`${SPEECH_CACHE}older-pack`, new Map([['speech/x', new Uint8Array(4)]]))
  c.stores.set('agent-city-abc123', new Map([['./', new Uint8Array(4)]]))
  c.stores.set('someone-elses', new Map())
  const keep = speechStore(c.caches, pin)
  await keep.get(pin.files[0])
  assert.ok(c.stores.has(`${SPEECH_CACHE}older-pack`), 'reading clears nothing')
  await keep.put(pin.files[0], data[pin.files[0].file].slice().buffer)
  assert.deepEqual([...c.stores.keys()].sort(), ['agent-city-abc123', 'someone-elses', `${SPEECH_CACHE}${pin.id}`].sort())
})

test('the keep never throws: no Cache Storage, storage refused, no room, a failed read each keep nothing and say nothing', async () => {
  const { pin, data } = tiny()
  const f = pin.files[0]
  const bytes = (): ArrayBuffer => data[f.file].slice().buffer
  for (const none of [null, undefined]) {
    const keep = speechStore(none, pin)
    await keep.put(f, bytes())
    assert.equal(await keep.get(f), null)
    await keep.drop(f)
  }
  const c = fakeCaches()
  const keep = speechStore(c.caches, pin)
  c.fail.open = true
  await keep.put(f, bytes())
  assert.equal(await keep.get(f), null)
  await keep.drop(f)
  c.fail.open = false
  c.fail.put = true
  await keep.put(f, bytes())
  assert.equal(await keep.get(f), null, 'nothing was kept')
  c.fail.put = false
  await keep.put(f, bytes())
  c.fail.match = true
  assert.equal(await keep.get(f), null)
  c.fail.match = false
  assert.deepEqual(new Uint8Array((await keep.get(f))!), data[f.file])
  // The default response is plain bytes.
  const real = speechStore(c.caches, pin)
  await real.put(pin.files[3], data['tokens.json'].slice().buffer)
  assert.equal(new TextDecoder().decode((await real.get(pin.files[3]))!), '["<unk>","<s>","</s>"]')
})
