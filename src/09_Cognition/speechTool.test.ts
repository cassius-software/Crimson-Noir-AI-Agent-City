// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the tool that puts the speech pack beside the web copy (tools/web/speechPack.mjs)
 * to its record and to its refusals: where each file comes from (SOURCES) is what the notices say (the package, the
 * version, the tarball's size and SHA-256), the installed runtime is the pinned version, the licences it places exist,
 * the pin it prints for the workflow changes when the pack does, a tar archive gives up exactly the files asked for,
 * a tarball that is not the pinned one is refused before anything is unpacked, a folder that is not the web copy gets
 * no pack, a missing model file says how to get it, and a WAV clip is read as its first channel.
 * The pack's own files (28 MB of model) are not in the repository, so placing them for real is the workflows' to
 * show (ci.yml speech, web.yml), not this file's.
 * What breaks if it is removed? The tool could drift from the notices it ships, or put a pack beside the single-file
 * page (which must stay one file), and only a publish would find out.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gzipSync } from 'node:zlib'
import { SPEECH_PACK, speechFile, speechManifestText } from './speechPack.ts'

// The tool is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const TOOL: string = '../../tools/web/speechPack.mjs'
const tool = (await import(TOOL)) as {
  SOURCES: {
    runtime: { package: string; version: string; path: string; licence: string }
    model: { package: string; version: string; url: string; file: string; bytes: number; sha256: string; paths: { encoder: string; decoder: string }; licence: string }
    tokens: string
  }
  LICENCE_FILES: readonly (readonly [string, string])[]
  cacheKey(): string
  pinLines(): string[]
  untar(tar: Buffer, wanted: string[]): Map<string, Buffer>
  unpack(o: { tarball: string; to: string }): string[]
  sourcesOf(from: string, root?: string): Record<string, string>
  checkPack(o: { from: string; root?: string }): Record<string, Buffer>
  placePack(o: { from: string; out: string; root?: string }): string[]
  readWav(path: string): { rate: number; samples: Float32Array }
  saysAll(text: string, expect: string): boolean
  writeTokens(tokenizer: string, to: string): { entries: number; bytes: number; sha256: string }
}
// The browser check (tools/browser/speech.mjs), for the parts of it that need no browser.
const CHECK: string = '../../tools/browser/speech.mjs'
const check = (await import(CHECK)) as {
  MIC_RATE: number
  MIC_LEAD: number
  MIC_TAIL: number
  ROOM_LEVEL: number
  resample(samples: Float32Array, rate: number, to: number): Float32Array
  micClip(samples: Float32Array, rate: number, o?: { lead?: number; tail?: number; level?: number }): Float32Array
  wavBytes(samples: Float32Array, rate: number): Buffer
  serveFolder(dir: string): Promise<{ origin: string; asked: string[]; close(): void }>
  speechAsks(asked: string[]): Record<string, number>
  firstVisitAsks(): Record<string, number>
}
const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')

/** A scratch folder, removed when the test ends. */
function scratch(t: { after(fn: () => void): void }): string {
  const dir = mkdtempSync(join(tmpdir(), 'speech-tool-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** A ustar archive of plain files. */
function tar(files: Record<string, Buffer>, dirs: string[] = []): Buffer {
  const blocks: Buffer[] = []
  const entry = (path: string, body: Buffer, type: string): void => {
    const head = Buffer.alloc(512)
    head.write(path, 0, 100, 'utf8')
    head.write('0000644\0', 100, 'latin1')
    head.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
    head.write(type, 156, 'latin1')
    head.write('ustar\0', 257, 'latin1')
    blocks.push(head, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  for (const d of dirs) entry(d, Buffer.alloc(0), '5')
  for (const [path, body] of Object.entries(files)) entry(path, body, '0')
  blocks.push(Buffer.alloc(1024))
  return Buffer.concat(blocks)
}

test('where each file comes from is what the notices say, and the installed runtime is the pinned version', () => {
  const { SOURCES } = tool
  const model = read('../../third_party/moonshine-tiny-en/NOTICE'), runtime = read('../../third_party/onnxruntime-web/1.31.1/NOTICE')
  assert.ok(model.includes(`${SOURCES.model.package}, version ${SOURCES.model.version}`), 'the model\'s package and version')
  assert.ok(model.includes(`${SOURCES.model.file}, ${SOURCES.model.bytes} bytes, sha256\n  ${SOURCES.model.sha256}`), 'the tarball\'s name, size and SHA-256')
  for (const p of Object.values(SOURCES.model.paths)) assert.ok(model.includes(p.replace(/^package\//, '').replace(/[^/]+$/, '')), `the folder of ${p}`)
  assert.equal(SOURCES.model.url, `https://registry.npmjs.org/${SOURCES.model.package}/-/${SOURCES.model.file}`, 'the registry\'s own address for that version, over https')
  assert.ok(SOURCES.model.file.endsWith(`-${SOURCES.model.version}.tgz`))
  assert.match(SOURCES.model.sha256, /^[0-9a-f]{64}$/)
  assert.ok(runtime.includes(`npm package ${SOURCES.runtime.package}, version\n${SOURCES.runtime.version}`))
  assert.ok(runtime.includes(SOURCES.runtime.path))
  const pkg = JSON.parse(read('../../package.json')) as { dependencies: Record<string, string>; devDependencies?: Record<string, string> }
  assert.equal(pkg.dependencies[SOURCES.runtime.package], SOURCES.runtime.version, 'the dependency is pinned to exactly the version the pack names')
  assert.equal((JSON.parse(read(`../../node_modules/${SOURCES.runtime.package}/package.json`)) as { version: string }).version, SOURCES.runtime.version)
  // The model's package is a source of two files, never code this project runs.
  assert.ok(!(SOURCES.model.package in pkg.dependencies) && !(SOURCES.model.package in (pkg.devDependencies ?? {})))
  assert.ok(!existsSync(new URL(`../../node_modules/${SOURCES.model.package}`, import.meta.url)))
  assert.equal(readFileSync(SOURCES.tokens).length, speechFile('tokens').bytes)
  // Every licence it places exists, and they are the six the notices promise beside the pack.
  assert.deepEqual(tool.LICENCE_FILES.map(([name]) => name), ['MODEL-LICENSE', 'MODEL-NOTICE', 'RUNTIME-LICENSE', 'RUNTIME-NOTICE', 'RUNTIME-ThirdPartyNotices.txt', 'RUNTIME-EMSCRIPTEN-NOTICES.txt'])
  for (const [name, src] of tool.LICENCE_FILES) assert.ok(readFileSync(src).length > 500, `${name} is there`)
  assert.ok(runtime.includes('ThirdPartyNotices.txt') && runtime.includes('EMSCRIPTEN-NOTICES.txt') && runtime.includes('SCRIPT-LICENCE'), 'the runtime\'s notice names every record beside it')
  assert.equal(tool.sourcesOf('/x').encoder, join('/x', 'encoder_model.onnx'))
})

test('the pin printed for the workflow: the cache key names the tarball and the pack, with the address, the size and the hash', () => {
  const lines = tool.pinLines()
  assert.deepEqual(lines.map((l) => l.slice(0, l.indexOf('='))), ['key', 'url', 'file', 'bytes', 'sha256'])
  const out = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]))
  assert.match(out.key, /^speech-pack-[0-9a-f]{32}-[0-9a-f]{16}$/)
  assert.ok(out.key.includes(tool.SOURCES.model.sha256.slice(0, 32)), 'a new tarball is a new key')
  assert.equal(out.key, tool.cacheKey())
  assert.deepEqual([out.url, out.file, out.bytes, out.sha256], [tool.SOURCES.model.url, tool.SOURCES.model.file, String(tool.SOURCES.model.bytes), tool.SOURCES.model.sha256])
  for (const l of lines) assert.doesNotMatch(l, /[\s"'`$]/, 'safe to append to the workflow\'s outputs as it is')
})

test('untar gives up exactly the files asked for, whole, and nothing else', () => {
  const a = Buffer.from('encoder bytes'), b = Buffer.alloc(1300, 7), c = Buffer.from('not wanted')
  const archive = tar({ 'package/dist/a.onnx': a, 'package/readme.md': c, 'package/dist/b.onnx': b }, ['package/', 'package/dist/'])
  const got = tool.untar(archive, ['package/dist/a.onnx', 'package/dist/b.onnx', 'package/missing'])
  assert.deepEqual([...got.keys()], ['package/dist/a.onnx', 'package/dist/b.onnx'])
  assert.ok(got.get('package/dist/a.onnx')!.equals(a) && got.get('package/dist/b.onnx')!.equals(b))
  assert.equal(tool.untar(archive, ['package/dist/']).size, 0, 'a folder is not a file')
  assert.equal(tool.untar(Buffer.alloc(1024), ['x']).size, 0, 'an empty archive')
  assert.equal(tool.untar(Buffer.alloc(100), ['x']).size, 0, 'less than a header')
})

test('a tarball that is not the pinned one is refused before anything is unpacked', (t) => {
  const dir = scratch(t)
  const to = join(dir, 'out')
  assert.throws(() => tool.unpack({ tarball: join(dir, 'nope.tgz'), to }), /nope\.tgz is missing/)
  const small = join(dir, 'small.tgz')
  writeFileSync(small, gzipSync(tar({ [tool.SOURCES.model.paths.encoder]: Buffer.from('x') })))
  assert.throws(() => tool.unpack({ tarball: small, to }), new RegExp(`small\\.tgz is \\d+ bytes; the pin says ${tool.SOURCES.model.bytes}`))
  // The right size and the wrong bytes: the hash says so.
  const sized = join(dir, 'sized.tgz')
  writeFileSync(sized, Buffer.alloc(tool.SOURCES.model.bytes, 1))
  assert.throws(() => tool.unpack({ tarball: sized, to }), new RegExp(`sized\\.tgz has SHA-256 [0-9a-f]{64}; the pin says ${tool.SOURCES.model.sha256}`))
  assert.ok(!existsSync(to), 'nothing was written')
})

test('a folder that is not the web copy gets no pack; a missing model file says how to get it; nothing is left behind', (t) => {
  const dir = scratch(t)
  const from = join(dir, 'pack')
  mkdirSync(from)
  // The single-file page's folder (no web app manifest in its page) and an empty folder are refused outright.
  const dist = join(dir, 'dist')
  mkdirSync(dist)
  assert.throws(() => tool.placePack({ from, out: dist }), /is not the web copy/)
  writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Agent City</title>')
  assert.throws(() => tool.placePack({ from, out: dist }), /is not the web copy \(tools\/web\/pwa\.mjs writes it\): the speech pack goes beside that page only/)
  assert.deepEqual(readdirSync(dist), ['index.html'])
  // The web copy, but the model's files were never fetched: said plainly, with the command, and no speech/ folder is left.
  const web = join(dir, 'dist-web')
  mkdirSync(join(web, 'speech'), { recursive: true })
  writeFileSync(join(web, 'index.html'), '<!doctype html><link rel="manifest" href="manifest.webmanifest">')
  writeFileSync(join(web, 'speech', 'stale.onnx'), 'an older pack')
  assert.throws(() => tool.placePack({ from, out: web }), /encoder_model\.onnx is missing \(node tools\/web\/speechPack\.mjs fetch --to <dir> gets it\)/)
  assert.deepEqual(readdirSync(web), ['index.html'], 'the stale folder is gone and no half pack stands in its place')
  // A model file of the wrong bytes is named with both hashes.
  writeFileSync(join(from, 'encoder_model.onnx'), 'not the model')
  assert.throws(() => tool.checkPack({ from }), new RegExp(`encoder_model\\.onnx is 13 bytes; the pin says ${speechFile('encoder').bytes}`))
  // Another version of the runtime installed: refused before any file is read.
  const root = join(dir, 'root')
  mkdirSync(join(root, 'node_modules', 'onnxruntime-web'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'onnxruntime-web', 'package.json'), '{"version":"1.32.0"}')
  assert.throws(() => tool.checkPack({ from, root }), /onnxruntime-web 1\.32\.0 is installed; the speech pack is pinned to 1\.31\.1/)
})

test('the manifest the tool writes is the page\'s own text for its own pin', () => {
  const src = read('../../tools/web/speechPack.mjs')
  assert.match(src, /writeFileSync\(join\(dir, 'manifest\.json'\), speechManifestText\(\)\)/)
  assert.match(src, /import \{ SPEECH_DIR, SPEECH_PACK, speechFile, speechManifestText \} from '\.\.\/\.\.\/src\/09_Cognition\/speechPack\.ts'/, 'the pin is imported from the page, not written twice')
  assert.ok(speechManifestText().includes(SPEECH_PACK.id))
  // The download is https only, to a .part file renamed once whole.
  assert.match(src, /'--proto', '=https', '--tlsv1\.2'/)
  assert.match(src, /renameSync\(`\$\{tarball\}\.part`, tarball\)/)
})

test('a WAV clip is read as its first channel at its own rate: 16-bit, 8-bit, 32-bit and float, mono or stereo', (t) => {
  const dir = scratch(t)
  const wav = (name: string, o: { rate: number; channels: number; bits: number; format?: number; frames: number[][]; streamed?: boolean; junk?: boolean }): string => {
    const width = o.bits / 8
    const data = Buffer.alloc(o.frames.length * o.channels * width)
    o.frames.forEach((frame, i) => frame.forEach((v, c) => {
      const at = (i * o.channels + c) * width
      if (o.format === 3) data.writeFloatLE(v, at)
      else if (o.bits === 16) data.writeInt16LE(Math.round(v * 32767), at)
      else if (o.bits === 8) data.writeUInt8(Math.round(v * 127) + 128, at)
      else data.writeInt32LE(Math.round(v * 2147483647), at)
    }))
    const fmt = Buffer.alloc(24)
    fmt.write('fmt ', 0, 'latin1'); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(o.format ?? 1, 8); fmt.writeUInt16LE(o.channels, 10)
    fmt.writeUInt32LE(o.rate, 12); fmt.writeUInt32LE(o.rate * o.channels * width, 16); fmt.writeUInt16LE(o.channels * width, 20); fmt.writeUInt16LE(o.bits, 22)
    const junk = o.junk ? Buffer.concat([Buffer.from('LIST'), Buffer.from([3, 0, 0, 0]), Buffer.from('abc\0')]) : Buffer.alloc(0)
    const head = Buffer.alloc(8)
    head.write('data', 0, 'latin1'); head.writeUInt32LE(o.streamed ? 0xffffffff : data.length, 4)
    const riff = Buffer.alloc(12)
    riff.write('RIFF', 0, 'latin1'); riff.writeUInt32LE(4 + fmt.length + junk.length + 8 + data.length, 4); riff.write('WAVE', 8, 'latin1')
    const path = join(dir, name)
    writeFileSync(path, Buffer.concat([riff, fmt, junk, head, data]))
    return path
  }
  const near = (a: Float32Array, b: number[], eps: number): void => { assert.equal(a.length, b.length); b.forEach((v, i) => assert.ok(Math.abs(a[i] - v) < eps, `${a[i]} is not ${v}`)) }
  const mono = tool.readWav(wav('mono.wav', { rate: 22_050, channels: 1, bits: 16, frames: [[0], [0.5], [-0.5], [1]] }))
  assert.equal(mono.rate, 22_050)
  near(mono.samples, [0, 0.5, -0.5, 1], 1e-3)
  near(tool.readWav(wav('stereo.wav', { rate: 48_000, channels: 2, bits: 16, frames: [[0.25, -1], [-0.25, 1]], junk: true })).samples, [0.25, -0.25], 1e-3)
  near(tool.readWav(wav('float.wav', { rate: 16_000, channels: 1, bits: 32, format: 3, frames: [[0.125], [-0.75]] })).samples, [0.125, -0.75], 1e-7)
  near(tool.readWav(wav('eight.wav', { rate: 8_000, channels: 1, bits: 8, frames: [[0], [0.5]] })).samples, [0, 0.5], 0.02)
  near(tool.readWav(wav('wide.wav', { rate: 16_000, channels: 1, bits: 32, frames: [[0.5], [-0.5]] })).samples, [0.5, -0.5], 1e-6)
  // A writer that streamed the file left the data's size unset (espeak-ng to a pipe does): the rest of the file is the data.
  near(tool.readWav(wav('streamed.wav', { rate: 22_050, channels: 1, bits: 16, frames: [[0.5], [0.25], [0]], streamed: true })).samples, [0.5, 0.25, 0], 1e-3)
  const bad = join(dir, 'bad.wav')
  writeFileSync(bad, 'ID3 not a wav file at all')
  assert.throws(() => tool.readWav(bad), /is not a WAV file/)
  writeFileSync(bad, Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')]))
  assert.throws(() => tool.readWav(bad), /has no audio/)
})

test('saysAll: every expected word is in what was read, any order, any case, punctuation aside', () => {
  assert.ok(tool.saysAll('Take me to the tailor.', 'tailor'))
  assert.ok(tool.saysAll('Take me to the Tailor!', 'TAILOR take'))
  assert.ok(!tool.saysAll('Take meat on the tailor.', 'me'), 'whole words: "meat" is not "me"')
  assert.ok(!tool.saysAll('', 'tailor'))
  assert.ok(tool.saysAll('anything', ''), 'nothing expected is always said')
})

test('the vocabulary is written id by id from the tokenizer\'s table, and a table with a gap is refused', (t) => {
  const dir = scratch(t)
  const src = join(dir, 'tokenizer.json'), to = join(dir, 'tokens.json')
  writeFileSync(src, JSON.stringify({ model: { vocab: { '</s>': 2, '<unk>': 0, '<s>': 1, '▁the': 3 } } }))
  const made = tool.writeTokens(src, to)
  assert.equal(readFileSync(to, 'utf8'), '["<unk>","<s>","</s>","▁the"]\n')
  assert.deepEqual([made.entries, made.bytes], [4, readFileSync(to).length])
  writeFileSync(src, JSON.stringify({ model: { vocab: { a: 0, c: 2 } } }))
  assert.throws(() => tool.writeTokens(src, to), /no piece for id 1/)
})

test('the browser check\'s microphone: the clip at 48 kHz in a quiet room that is never digital silence, as a WAV the tool reads back', (t) => {
  // Resampling keeps the length in time and the shape: a ramp stays a ramp.
  const ramp = Float32Array.from({ length: 100 }, (_, i) => i / 100)
  const up = check.resample(ramp, 16_000, 48_000)
  assert.equal(up.length, 300)
  for (let i = 0; i < 297; i++) assert.ok(Math.abs(up[i] - i / 300) < 1e-6, `sample ${i}`)
  assert.deepEqual([...check.resample(ramp, 48_000, 48_000)], [...ramp], 'the same rate is a copy')
  assert.notEqual(check.resample(ramp, 48_000, 48_000), ramp)
  assert.equal(check.resample(ramp, 48_000, 16_000).length, 33)
  // The room: a second and a half before the speech and six after (Chrome loops the file; the pause ends the utterance).
  const speech = new Float32Array(16_000).fill(0.25)
  const clip = check.micClip(speech, 16_000)
  assert.equal(check.MIC_RATE, 48_000)
  const lead = check.MIC_LEAD * 48_000, said = 48_000, tail = check.MIC_TAIL * 48_000
  assert.equal(clip.length, lead + said + tail)
  const peak = (from: number, to: number): number => clip.subarray(from, to).reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  assert.ok(peak(0, lead) <= check.ROOM_LEVEL && peak(lead + said, clip.length) <= check.ROOM_LEVEL, 'the room is faint')
  assert.ok(peak(0, lead) > check.ROOM_LEVEL / 4, 'and never silent')
  // No run of exact zeros anywhere: the page reads those, at the start, as a microphone that gives no sound.
  let zeros = 0, longest = 0
  for (const v of clip) { zeros = v === 0 ? zeros + 1 : 0; longest = Math.max(longest, zeros) }
  assert.ok(longest < 8, `a run of ${longest} zeros`)
  assert.ok(Math.abs(clip[lead + said / 2] - 0.25) <= check.ROOM_LEVEL, 'the speech sits on the room, at its own level')
  // As a file: 16-bit mono at 48 kHz, which the tool's own reader gives back within a 16-bit step.
  const dir = scratch(t)
  const file = join(dir, 'microphone.wav')
  const bytes = check.wavBytes(clip, check.MIC_RATE)
  assert.equal(bytes.length, 44 + clip.length * 2)
  writeFileSync(file, bytes)
  const back = tool.readWav(file)
  assert.deepEqual([back.rate, back.samples.length], [48_000, clip.length])
  for (const i of [0, lead - 1, lead + 10, clip.length - 1]) assert.ok(Math.abs(back.samples[i] - clip[i]) < 1 / 16_000, `sample ${i}`)
  // Loud samples clip at full scale and do not wrap.
  const loud = check.wavBytes(Float32Array.from([2, -2]), 48_000)
  assert.deepEqual([loud.readInt16LE(44), loud.readInt16LE(46)], [32767, -32768])
})

test('the browser check\'s host serves a folder as a static site does, lists what was asked, and gives nothing from outside it', async (t) => {
  const dir = scratch(t)
  const webDir = join(dir, 'web')
  mkdirSync(join(webDir, 'speech'), { recursive: true })
  writeFileSync(join(webDir, 'index.html'), '<!doctype html>city')
  writeFileSync(join(webDir, 'speech', 'manifest.json'), '{"v":1}')
  writeFileSync(join(dir, 'secret.txt'), 'outside the site')
  const site = await check.serveFolder(webDir)
  t.after(() => site.close())
  const get = (path: string): Promise<Response> => fetch(`${site.origin}${path}`)
  const page = await get('/?debug&x=1')
  assert.deepEqual([page.status, page.headers.get('content-type'), await page.text()], [200, 'text/html; charset=utf-8', '<!doctype html>city'])
  assert.equal(page.headers.get('cross-origin-opener-policy'), null, 'no isolation headers: a static host sends none')
  const manifest = await get('/speech/manifest.json')
  assert.deepEqual([manifest.status, manifest.headers.get('content-type'), manifest.headers.get('content-length'), await manifest.text()], [200, 'application/json', '7', '{"v":1}'])
  for (const path of ['/missing.onnx', '/speech/', '/speech', '/%2e%2e/secret.txt', '/speech/..%2f..%2fsecret.txt', '/%zz']) {
    const r = await get(path)
    assert.ok(r.status === 404 || r.status === 400, `${path}: ${r.status}`)
    assert.notEqual(await r.text(), 'outside the site')
  }
  assert.deepEqual(site.asked.slice(0, 3), ['index.html', 'speech/manifest.json', 'missing.onnx'])
})

test('the browser check counts what was asked under speech/: a first visit is the manifest and each file once', () => {
  const asked = ['index.html', 'sw.js', 'speech/manifest.json', ...SPEECH_PACK.files.map((f) => `speech/${f.file}`), 'models/manifest.json', 'speech/tokens.json']
  const counts = check.speechAsks(asked)
  assert.equal(counts['tokens.json'], 2, 'a second ask of a file shows')
  assert.equal(counts['manifest.json'], 1)
  assert.ok(!('index.html' in counts) && !('models/manifest.json' in counts), 'only the speech folder')
  assert.deepEqual(check.firstVisitAsks(), { 'manifest.json': 1, 'ort-wasm-simd-threaded.wasm': 1, 'encoder_model.onnx': 1, 'decoder_model_merged.onnx': 1, 'tokens.json': 1 })
  assert.deepEqual(check.speechAsks(['index.html']), {})
  // The check's own words are held to what it shows: one browser, no real microphone.
  const src = read('../../tools/browser/speech.mjs')
  assert.match(src, /What it does not show: a real microphone, a phone, Safari or Firefox\./)
  assert.match(src, /loopbackOnly\(\[/, 'the browser can reach nothing but this machine')
  assert.match(src, /'--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=\$\{mic\}`/)
})

test('ci\'s speech job: the pinned pack reads a sentence made on the runner under Node, then Chrome hears it on two visits', () => {
  const yml = readFileSync(new URL('../../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const start = yml.indexOf('\n  speech:\n')
  assert.ok(start >= 0, 'the job exists')
  const next = yml.slice(start + 1).search(/\n  [a-z][\w-]*:\n/)
  const job = next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next)
  const at = (needle: string): number => {
    const i = job.indexOf(needle)
    assert.ok(i >= 0, needle)
    return i
  }
  const pin = at('run: node tools/web/speechPack.mjs pin >> "$GITHUB_OUTPUT"')
  const cache = at('key: ${{ steps.speech.outputs.key }}')
  const fetchStep = at('if: steps.speech-cache.outputs.cache-hit != \'true\'')
  const fetched = at('run: node tools/web/speechPack.mjs fetch --to "$RUNNER_TEMP/speech-pack"')
  const spoken = at('espeak-ng -v en-us -s 150 -w "$RUNNER_TEMP/spoken.wav" "Where is the nearest coffee shop?"')
  const read = at('run: node tools/web/speechPack.mjs read --from "$RUNNER_TEMP/speech-pack" --expect "where is the nearest coffee shop" "$RUNNER_TEMP/spoken.wav"')
  const build = at('npm run build:web')
  const place = at('node tools/web/speechPack.mjs place --from "$RUNNER_TEMP/speech-pack" --out dist-web')
  const hear = at('run: node tools/browser/speech.mjs --web dist-web --clip "$RUNNER_TEMP/spoken.wav" --expect "nearest coffee shop" --out "$RUNNER_TEMP/speech"')
  assert.ok(pin < cache && cache < fetchStep && fetchStep < fetched && fetched < spoken && spoken < read && read < build && build < place && place < hear, 'pin, cache, fetch, a clip, read, build, place, hear')
  assert.doesNotMatch(job, /restore-keys/, 'a new pin never restores an old file')
  // What the browser must hear is part of what Node must read, and both are words of the sentence that was spoken.
  const said = 'where is the nearest coffee shop'
  assert.ok(tool.saysAll(said, 'where is the nearest coffee shop') && tool.saysAll(said, 'nearest coffee shop'))
  // Whatever happens, what the browser showed and asked for is kept.
  assert.match(job.slice(hear), /uses: actions\/upload-artifact@v4\n\s+if: always\(\)/)
})
