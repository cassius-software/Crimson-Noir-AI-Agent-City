#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the evidence that the microphone understands words in a real browser with no
 * recogniser of the browser's own: the web copy (dist-web/, with the speech pack placed beside it by
 * tools/web/speechPack.mjs) is served the way a static host serves it, a headless Chrome or Chromium opens it with a
 * microphone that plays a spoken clip (Chrome's fake capture device, fed a WAV file), and the check passes only when
 *   1. the pill beside the minimap shows what was said, and it says every expected word (the whole road: the open
 *      microphone, the detector and the tap in the audio worklet, the pack fetched from beside the page, every byte
 *      hashed in the worker, the model run there, the sentence handed back);
 *   2. the site was asked for the pack's manifest and for each of its four files exactly once;
 *   3. on a second visit in the same browser the words are understood again and the site is asked for nothing under
 *      speech/ at all (the pack was kept: a later visit costs no download and works offline);
 *   4. the browser could reach nothing but this machine throughout (cdp.mjs loopbackOnly).
 *
 *   node tools/browser/speech.mjs --clip <spoken.wav> --expect "<words>" [--web dist-web] [--out <dir>] [--chrome <path>]
 *
 * The clip is any WAV of someone saying the words (CI makes one with espeak-ng, so no recording is kept in the
 * repository). It is resampled to 48 kHz and set in a quiet room (a second and a half before it, six after: Chrome
 * plays the file in a loop, and the detector needs the pause to end the utterance), then handed to the browser.
 * The loop may be caught in the middle the first time round (half a sentence is then read, and the check waits for
 * the next round), and a small model reads a synthetic voice less surely than a person's: name the words that matter
 * in --expect, not the whole sentence, and pick a sentence the pack reads the same way at any speaking rate
 * (tools/web/speechPack.mjs read tells).
 * What it does not show: a real microphone, a phone, Safari or Firefox. It is one Chromium on a software GPU.
 * What breaks if it is removed? Nothing checks, outside a unit test with fakes, that the page's own recogniser reads
 * speech at all, or that the pack is kept between visits.
 */
import { createReadStream, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser, findChrome, loopbackOnly, SOFTWARE_WEBGPU } from './cdp.mjs'
import { readWav, saysAll } from '../web/speechPack.mjs'
import { SPEECH_DIR, SPEECH_PACK } from '../../src/09_Cognition/speechPack.ts'

/** The rate Chrome's fake capture device is fed at, and the room around the speech (seconds before, seconds after). */
export const MIC_RATE = 48_000
export const MIC_LEAD = 1.5
export const MIC_TAIL = 6
/** The room's own noise, peak: far under speech, well over the level the page calls a silent microphone. */
export const ROOM_LEVEL = 0.002

/** `samples` at `rate`, resampled to `to` by linear interpolation (speech for a recogniser, not for listening). */
export function resample(samples, rate, to) {
  if (rate === to) return Float32Array.from(samples)
  const n = Math.max(1, Math.round(samples.length * (to / rate)))
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const at = i * (rate / to)
    const a = Math.min(samples.length - 1, Math.floor(at))
    const b = Math.min(samples.length - 1, a + 1)
    out[i] = samples[a] + (samples[b] - samples[a]) * (at - a)
  }
  return out
}

/**
 * What the fake microphone plays: the speech at 48 kHz in a quiet room, `lead` seconds of room before it and `tail`
 * after. The room is a faint steady noise, never digital silence: a real microphone is never exactly zero, and the
 * page reads a stretch of exact zeros at the start as a microphone that gives no sound.
 */
export function micClip(samples, rate, { lead = MIC_LEAD, tail = MIC_TAIL, level = ROOM_LEVEL } = {}) {
  const speech = resample(samples, rate, MIC_RATE)
  const before = Math.round(lead * MIC_RATE), after = Math.round(tail * MIC_RATE)
  const out = new Float32Array(before + speech.length + after)
  let x = 1
  for (let i = 0; i < out.length; i++) {
    x = (x * 1664525 + 1013904223) >>> 0
    out[i] = (x / 0xffffffff - 0.5) * 2 * level
  }
  for (let i = 0; i < speech.length; i++) out[before + i] += speech[i]
  return out
}

/** Samples as a 16-bit mono PCM WAV file. */
export function wavBytes(samples, rate) {
  const b = Buffer.alloc(44 + samples.length * 2)
  b.write('RIFF', 0, 'latin1'); b.writeUInt32LE(36 + samples.length * 2, 4); b.write('WAVEfmt ', 8, 'latin1')
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28)
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36, 'latin1'); b.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2)
  return b
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm' }

/**
 * Serves a folder the way a static host such as GitHub Pages does: its files by name, the folder's index, no isolation
 * headers, and a cache lifetime (ten minutes, as Pages sends). `asked` lists every path asked for, in order.
 */
export async function serveFolder(dir) {
  const root = resolve(dir)
  const asked = []
  const server = createServer((req, res) => {
    let name
    try {
      name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname).slice(1) || 'index.html'
    } catch {
      res.writeHead(400).end()
      return
    }
    asked.push(name)
    const file = resolve(root, name)
    if (!(file === root || file.startsWith(root + sep)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': statSync(file).size, 'Cache-Control': 'max-age=600' })
    createReadStream(file).pipe(res)
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { origin: `http://127.0.0.1:${server.address().port}`, asked, close: () => { server.closeAllConnections(); server.close() } }
}

/** The pill as the page shows it: its phase, its tooltip, what was said and the few words beside it. */
const PILL = `(() => {
  const pill = document.querySelector('[data-mic]')
  return {
    phase: pill?.getAttribute('data-mic') ?? '',
    title: pill?.getAttribute('title') ?? '',
    said: (document.querySelector('[data-mic-said]')?.textContent ?? '').replace(/[\\u201c\\u201d]/g, ''),
    note: document.querySelector('[data-mic-note]')?.textContent ?? '',
  }
})()`

/** How many times each file under speech/ was asked for, among `asked`. */
export function speechAsks(asked) {
  const counts = {}
  for (const name of asked) if (name.startsWith(SPEECH_DIR)) counts[name.slice(SPEECH_DIR.length)] = (counts[name.slice(SPEECH_DIR.length)] ?? 0) + 1
  return counts
}

/** What a first visit must have asked of speech/: the manifest and each of the pack's files, once each, and nothing else. */
export function firstVisitAsks(pin = SPEECH_PACK) {
  return Object.fromEntries([['manifest.json', 1], ...pin.files.map((f) => [f.file, 1])])
}

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }

async function main() {
  const web = resolve(arg('web') ?? 'dist-web')
  const clip = arg('clip')
  const expect = arg('expect')
  const out = arg('out') ? resolve(arg('out')) : null
  const fail = (why) => { console.error(`::error::speech.mjs: ${why}`); return 1 }
  if (!clip) return fail('--clip <spoken.wav> is needed (a WAV of someone saying the expected words)')
  if (!expect || !/[\p{L}\p{N}]/u.test(expect)) return fail('--expect "<words>" is needed (the words the pill must show)')
  if (!existsSync(join(web, 'index.html'))) return fail(`${web} has no index.html (npm run build:web makes it)`)
  for (const f of ['manifest.json', ...SPEECH_PACK.files.map((x) => x.file)]) {
    if (!existsSync(join(web, SPEECH_DIR, f))) return fail(`${join(web, SPEECH_DIR, f)} is missing (node tools/web/speechPack.mjs place --from <dir> --out ${web} puts the pack there)`)
  }
  const chrome = findChrome(arg('chrome'))
  if (!chrome) return fail('no Chrome or Chromium found (set CHROME=/path/to/chrome)')
  if (out) mkdirSync(out, { recursive: true })

  const scratch = mkdtempSync(join(tmpdir(), 'agent-city-speech-'))
  const spoken = readWav(resolve(clip))
  const mic = join(scratch, 'microphone.wav')
  writeFileSync(mic, wavBytes(micClip(spoken.samples, spoken.rate), MIC_RATE))
  const seconds = spoken.samples.length / spoken.rate
  console.log(`speech.mjs: the microphone plays ${clip} (${seconds.toFixed(1)} s of speech) in a loop, ${(MIC_LEAD + seconds + MIC_TAIL).toFixed(1)} s a round; expecting ${JSON.stringify(expect)}`)

  const site = await serveFolder(web)
  const net = loopbackOnly([
    ...SOFTWARE_WEBGPU, '--window-size=1280,720',
    // A microphone that plays the clip, and a permission prompt that answers yes.
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${mic}`,
    '--autoplay-policy=no-user-gesture-required',
  ])
  const b = await Browser.launch(chrome, net.args, { env: net.env })
  const lines = []
  b.on('Runtime.consoleAPICalled', (e) => lines.push(`[${e.type}] ${(e.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ')}`.slice(0, 600)))
  b.on('Runtime.exceptionThrown', (e) => lines.push(`[exception] ${e.exceptionDetails?.exception?.description ?? e.exceptionDetails?.text ?? ''}`.slice(0, 600)))
  let failures = 0
  const bad = (why) => { failures++; console.error(`::error::speech.mjs: ${why}`) }
  // The light city the browser smoke boots (smoke.mjs LIGHT): no onboarding, a small crowd, half resolution.
  const url = `${site.origin}/?debug&onboarding=0&crowd=512&cars=8&scale=0.5&cinema=0&audio=0`

  /** One visit: waits for the pill to show a sentence with every expected word; resolves to what was seen. */
  const visit = async (label, ms) => {
    const began = Date.now()
    const seen = { phases: [], notes: [], said: [], title: '' }
    let last = ''
    for (;;) {
      let s = null
      try { s = await b.eval(PILL) } catch { /* the page is between documents */ }
      if (s) {
        if (s.phase && seen.phases.at(-1) !== s.phase) seen.phases.push(s.phase)
        if (s.note && seen.notes.at(-1) !== s.note) seen.notes.push(s.note)
        if (s.said && seen.said.at(-1) !== s.said) seen.said.push(s.said)
        if (s.title) seen.title = s.title
        const line = JSON.stringify(s)
        if (line !== last) { console.log(`  ${label} ${((Date.now() - began) / 1000).toFixed(0).padStart(3)} s  ${line}`); last = line }
        if (seen.said.some((text) => saysAll(text, expect))) return seen
      }
      if (Date.now() - began > ms) return seen
      await new Promise((r) => setTimeout(r, 300))
    }
  }

  try {
    // First visit: nothing kept, so the pack comes from the site.
    await b.send('Page.navigate', { url })
    const first = await visit('first visit ', 420_000)
    if (out) writeFileSync(join(out, 'speech-first.png'), await b.screenshot())
    const heard = first.said.find((text) => saysAll(text, expect))
    if (!heard) {
      bad(`the pill never showed a sentence saying ${JSON.stringify(expect)} (it showed ${JSON.stringify(first.said)}; phases ${first.phases.join(' > ')}; notes ${first.notes.join(' > ')}; ${first.title})`)
    } else {
      console.log(`speech.mjs: first visit: heard ${JSON.stringify(heard)} (${first.title})`)
    }
    if (!/understood on this device/.test(first.title)) bad(`the pill's tooltip does not say the words are understood on this device: ${JSON.stringify(first.title)}`)
    const asks = speechAsks(site.asked)
    if (JSON.stringify(Object.entries(asks).sort()) !== JSON.stringify(Object.entries(firstVisitAsks()).sort())) {
      bad(`the first visit asked the site for ${JSON.stringify(asks)} under ${SPEECH_DIR}; it should be the manifest and each file once: ${JSON.stringify(firstVisitAsks())}`)
    } else {
      console.log(`speech.mjs: first visit: the site was asked for the manifest and each of the pack's ${SPEECH_PACK.files.length} files once`)
    }

    // Second visit, same browser: the pack is in the page's keep.
    const before = site.asked.length
    await b.send('Page.navigate', { url: `${url}&again=1` })
    await b.waitFor('new URLSearchParams(location.search).has("again") && document.readyState === "complete"', 60_000)
    const second = await visit('second visit', 420_000)
    if (out) writeFileSync(join(out, 'speech-second.png'), await b.screenshot())
    const again = second.said.find((text) => saysAll(text, expect))
    if (!again) bad(`on the second visit the pill never showed a sentence saying ${JSON.stringify(expect)} (it showed ${JSON.stringify(second.said)}; phases ${second.phases.join(' > ')}; notes ${second.notes.join(' > ')}; ${second.title})`)
    else console.log(`speech.mjs: second visit: heard ${JSON.stringify(again)}`)
    const later = speechAsks(site.asked.slice(before))
    if (Object.keys(later).length > 0) bad(`the second visit asked the site for ${JSON.stringify(later)} under ${SPEECH_DIR}; the kept pack should have cost no request at all`)
    else console.log('speech.mjs: second visit: nothing under speech/ was asked of the site (the pack was kept)')
  } catch (e) {
    bad(e instanceof Error ? e.message : String(e))
  } finally {
    if (out) {
      writeFileSync(join(out, 'speech-console.txt'), `${lines.join('\n')}\n`)
      writeFileSync(join(out, 'speech-asked.txt'), `${site.asked.join('\n')}\n`)
    }
    if (failures) for (const l of lines.filter((x) => /^\[(error|exception|warning)\]/.test(x)).slice(-20)) console.error(`  page: ${l}`)
    await b.close()
    site.close()
    rmSync(scratch, { recursive: true, force: true })
  }
  console.log(failures ? `speech.mjs: ${failures} failure${failures === 1 ? '' : 's'}` : 'speech.mjs: the microphone understood the words, twice, and the pack was fetched once')
  return failures ? 1 : 0
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await main()
