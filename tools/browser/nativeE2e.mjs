#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It drives the Linux app, built with the native model runner and the tiny test model
 * (src-tauri features tiny-model; tools/browser/tinyGguf.mjs tiny-a.gguf as the resource models/tiny-a.gguf), in its
 * real web view (WebKitGTK) through tauri-driver and the W3C WebDriver protocol, spoken here with fetch alone, and asks
 * the model with the page's own code: before the run it bundles the page's shellRunner (src/07_Execute_Actions/
 * desktopShell.ts) and createNativeMind (src/09_Cognition/nativeMind.ts) from their sources into one script with vite
 * (an entry written to a temporary folder, never committed), and injects it into the app's page once the page's own
 * module has run, and again after the reload. Every check runs inside that page, under its real Content-Security-Policy
 * and air gap (src/02_Define_The_Rules/airgap.ts, which refuses Tauri's ipc:// fetch, so every command and every
 * channel message takes the message path the product takes). The answers are asked through
 * createNativeMind({ host: shellRunner() }); the host is watched (each event, how the shell's answer ended, each stop
 * and its answer are recorded and passed on unchanged), and each Tauri channel's end is recorded
 * (Channel.prototype.cleanupCallback, wrapped). In this web view Tauri hands a channel its end before the command's
 * reply, so an answer as it comes does not show that shellRunner waits for the end before it hands back the reply
 * (DRAIN_MS; desktopShell.test.ts holds that with fakes). One answer shows it: its channel's every message, and then
 * its end, are handed over HOLD_MS late (Channel.prototype's onmessage and cleanupCallback, wrapped), as a reply that
 * overtakes them would find them, and a shellRunner that hands back the reply without waiting loses that text.
 * It asserts:
 * - the web view has no JSPI (WebAssembly.Suspending and promising), so this is the path the product takes on Linux,
 *   and the page's CSP is in force and its air gap refuses the ipc:// fetch Tauri tries first;
 * - native_model (shellRunner's model()) answers exactly { file: "tiny-a.gguf", bytes: 156992, status }, its status
 *   reaching ready (the model is loaded at the first answer, not before); the mind lists tiny-a.gguf and says the
 *   model is still to be loaded (cold), and no longer once the first answer has run;
 * - the first answer through the mind is the tiny model's 16 "a"s, reason 'length', 16 tokens, its pieces making up
 *   that text; the runner ended it by its token cap with exactly the 16 tokens asked (the tiny model never writes its
 *   end-of-text token); its events came in order, the load first (its fractions rising to 1), then the prompt read
 *   (to its end), then the text; the asker's phases went "loading the model in the app", "reading the prompt" up to
 *   100%, then none; the channel had ended when shellRunner handed back the reply; the timings are sane and the plan
 *   is the computer's; a longer answer (512 tokens) comes in several events, each under 8 KiB of JSON;
 * - an answer (64 tokens) whose channel's every message and its end reach shellRunner HOLD_MS (300 ms) or more after
 *   they came still comes whole through the mind, and its end had come when shellRunner handed back the reply;
 * - a Stop at the first piece: the mind rejects at once with AbortError and hands the asker nothing more, its stop
 *   reaches the runner (native_stop answers true) and the runner ends the long answer 'stopped' with fewer tokens than
 *   asked; a second stop answers false. A 1 ms first-piece wait runs out: the mind rejects with a 'timeout'
 *   CognitionError in a plain sentence, and the runner ends the answer 'stopped';
 * - a stop sent right behind its request stops it every time (24 times in the same task through shellRunner, 12 times
 *   through the mind aborting as soon as it asked): native_generate is async, so the stop can reach the runner first,
 *   and the runner keeps it for the answer (src-tauri/src/runner.rs);
 * - a request with the number of an answer still being made is refused with a plain sentence (asked through
 *   shellRunner: the mind picks its own numbers);
 * - a reload while 32 long answers are going (asked through shellRunner; each one asked while another is being made
 *   is told it waits) stops them (src-tauri/src/lib.rs on_page_load), proved by the new page's first request through
 *   its own mind: the model is no longer cold, the answer ("aaaaaaaa", 8 tokens) is told to wait for nothing and
 *   completes long before the old answers could have ended by themselves at the rate measured above; and the old
 *   number is free again.
 * It also records, without asserting, whether the page reaches Sloane's card in this web view at all, or shows the
 * recovery card (risk K1: no WebGPU in WebKitGTK).
 *   node tools/browser/nativeE2e.mjs --app src-tauri/target/debug/crimson-noir-app [--driver tauri-driver]
 *                                    [--port 4444] [--out report.json]
 * It needs the repository's node_modules (vite), a display (xvfb-run in .github/workflows/native-e2e.yml), tauri-driver
 * and WebKitWebDriver. The exit code is 1 when any check fails; the report (--out) holds every check, the bundled
 * modules and the K1 observation.
 * What breaks if it is removed? The shell's commands and the page's own runner path are proved against fakes only,
 * and a channel that loses the answer's tail, a stop that does not stop, or a reload that leaves the old page's answer
 * running reaches users.
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { build } from 'vite'
import { HPARAMS } from './tinyGguf.mjs'

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const APP = arg('app')
if (!APP) {
  console.error('usage: node tools/browser/nativeE2e.mjs --app <the app built with --features tiny-model> [--driver tauri-driver] [--port 4444] [--out report.json]')
  process.exit(2)
}
const DRIVER = arg('driver') ?? 'tauri-driver'
const PORT = Number(arg('port') ?? 4444)
const OUT = arg('out')

const ROOT = resolve(import.meta.dirname, '..', '..')
/** The page's own modules the run asks through. */
const SHELL = 'src/07_Execute_Actions/desktopShell.ts'
const MIND = 'src/09_Cognition/nativeMind.ts'
/** The carried model (src-tauri/src/model_file.rs TINY_*). */
const TINY = Object.freeze({ file: 'tiny-a.gguf', bytes: 156_992 })
/** The runner's plan on a computer (src-tauri/src/runner.rs): the context is lowered to what the model was trained on. */
const PLAN = Object.freeze({ nCtx: Math.min(8192, HPARAMS.nCtxTrain), nBatch: 512, maxTokens: 2048, threadsCap: 8 })
/** Long answers being made when the page reloads: the first is made, the others wait their turn behind it. */
const LONG_ANSWERS = 32
/** Stops sent right behind their request: in the same task through shellRunner, and through the mind's own abort. */
const RACES = Object.freeze({ shell: 24, mind: 12 })
/** How late the held answer's channel hands over each message and its end, ms: well under DRAIN_MS (1,000). */
const HOLD_MS = 300

const report = { app: resolve(APP), checks: [], bundle: null, k1: null, env: null, rate: null, races: null }
let failed = 0
function check(ok, what, detail) {
  report.checks.push({ ok: !!ok, what, ...(detail === undefined ? {} : { detail }) })
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail !== undefined ? `: ${JSON.stringify(detail).slice(0, 600)}` : ''}`)
}

// ---- The page's own code, bundled -------------------------------------------------------------------------------

/**
 * shellRunner and createNativeMind as one script (an IIFE that sets window.__nativeE2e), built by vite from an entry
 * written to a temporary folder; with them the two phase lines the checks compare (nativeMind.ts LOADING_APP,
 * inPage.ts WAITING).
 */
async function bundle() {
  const dir = mkdtempSync(join(tmpdir(), 'native-e2e-'))
  try {
    const entry = join(dir, 'entry.ts')
    const from = (p) => JSON.stringify(resolve(ROOT, p))
    writeFileSync(entry, [
      `import { shellRunner } from ${from(SHELL)}`,
      `import { createNativeMind, LOADING_APP } from ${from(MIND)}`,
      `import { WAITING } from ${from('src/09_Cognition/inPage.ts')}`,
      ';(globalThis as Record<string, unknown>).__nativeE2e = Object.freeze({ shellRunner, createNativeMind, LOADING_APP, WAITING })',
      '',
    ].join('\n'))
    const built = await build({
      configFile: false, root: dir, logLevel: 'silent', publicDir: false,
      build: { write: false, minify: false, target: 'es2022', lib: { entry, formats: ['iife'], name: 'nativeE2e', fileName: () => 'native-e2e.js' } },
    })
    const [chunk] = (Array.isArray(built) ? built : [built]).flatMap((b) => b.output).filter((o) => o.type === 'chunk')
    const modules = Object.keys(chunk.modules).filter((m) => m.startsWith(ROOT)).map((m) => relative(ROOT, m)).sort()
    return { code: chunk.code, modules }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---- WebDriver over fetch -------------------------------------------------------------------------------------

async function wd(method, path, body) {
  const res = await fetch(`http://127.0.0.1:${PORT}${path}`, {
    method,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = { value: text } }
  if (!res.ok) throw new Error(`WebDriver ${method} ${path}: HTTP ${res.status}: ${JSON.stringify(json.value ?? json).slice(0, 1500)}`)
  return json.value
}

/**
 * What every script in the page starts with: the page's own code once injected (`own`), and `watched()`, its
 * shellRunner with each answer's events, how the shell's answer ended (and whether its channel had ended by then), and
 * each stop and its answer recorded, every call passed on unchanged.
 */
const PRELUDE = String.raw`
const core = window.__TAURI__ && window.__TAURI__.core
const own = window.__nativeE2e || null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const randomId = () => crypto.getRandomValues(new Uint32Array(1))[0]
const messages = [{ role: 'system', content: 'You are Sloane.' }, { role: 'user', content: 'Say hi.' }]
const said = (e) => (e instanceof Error ? { name: e.name, code: e.code === undefined ? null : e.code, message: e.message } : e)
const watched = () => {
  const host = own.shellRunner()
  const ends = window.__nativeE2eEnds
  const asked = []
  const stops = []
  return {
    asked,
    stops,
    host: Object.freeze({
      model: () => host.model(),
      generate: (req, onEvent) => {
        const a = { req, events: [], t0: Date.now(), endsBefore: ends.length }
        asked.push(a)
        a.settled = host.generate(req, (e) => { a.events.push(e); onEvent(e) }).then(
          (done) => { a.done = done; return done },
          (error) => { a.error = error; throw error },
        ).finally(() => { a.ms = Date.now() - a.t0; a.drained = ends.length > a.endsBefore })
        return a.settled
      },
      stop: (id) => {
        const s = { id }
        s.answered = host.stop(id).then((v) => { s.answer = v; return v })
        stops.push(s)
        return s.answered
      },
    }),
  }
}
const settledAll = (w) => Promise.all([...w.asked.map((a) => a.settled.catch(() => null)), ...w.stops.map((s) => s.answered.catch(() => null))])
const plain = (w) => ({
  asked: w.asked.map((a) => ({
    req: { id: a.req.id, maxTokens: a.req.maxTokens, think: a.req.think, roles: a.req.messages.map((m) => m.role) },
    events: a.events, done: a.done || null, error: a.error === undefined ? null : said(a.error), ms: a.ms, drained: a.drained,
  })),
  stops: w.stops.map((s) => ({ id: s.id, answer: s.answer })),
})
const ask = async (mind, { signal, onPiece } = {}) => {
  const phases = []
  const pieces = []
  let answer = null
  let error = null
  try {
    answer = await mind.answer({ tethers: [], prompt: 'Say hi.', signal: signal || new AbortController().signal, talk: true, onPhase: (p) => phases.push(p) },
      (p) => { pieces.push(p); if (onPiece) onPiece(p) })
  } catch (e) { error = said(e) }
  return { answer, error, phases, pieces }
}
`

let sid = null
/** Runs `body` (an async function's body, `args` in scope) in the page and returns what it returns. */
async function page(body, ...args) {
  const script = `${PRELUDE}
const __done = arguments[arguments.length - 1]
const __args = Array.prototype.slice.call(arguments, 0, -1)
;(async (args) => {
${body}
})(__args).then((v) => __done({ ok: true, v }), (e) => __done({ ok: false, e: e instanceof Error ? e.message : JSON.stringify(e) }))`
  const r = await wd('POST', `/session/${sid}/execute/async`, { script, args })
  if (!r || r.ok !== true) throw new Error(`in the page: ${r?.e ?? JSON.stringify(r)}`)
  return r.v
}

// ---- What the page is asked -------------------------------------------------------------------------------------

/**
 * The page's own module has run (main.tsx sets window.__bootDone after it installed the air gap and mounted the
 * page): the app starts loading before the session is open, so the first script can come before it.
 */
const BOOTED = String.raw`
const deadline = Date.now() + 120000
while (window.__bootDone !== true && Date.now() < deadline) await sleep(50)
`

/**
 * After the bundle: each channel's end recorded (window.__nativeE2eEnds), and a channel made while
 * window.__nativeE2eHold is set holds back every message and then its end that many ms, in order, each recorded with
 * how late it came (window.__nativeE2eHeld). Tauri's Channel calls this.cleanupCallback() at the end, so the end
 * shellRunner sets on its channel is kept by a setter here and handed out by the getter, held when the channel is.
 * Then what the page now holds.
 */
const INSTRUMENT = String.raw`
const C = window.__TAURI__.core.Channel
if (!Array.isArray(window.__nativeE2eEnds)) {
  const proto = C.prototype
  const ends = []
  const held = []
  const base = proto.cleanupCallback
  const recorded = function () { ends.push(Date.now()); return base.call(this) }
  const holds = new WeakMap()
  const theirs = new WeakMap()
  const late = (channel, kind, f) => {
    const at = performance.now()
    setTimeout(() => { held.push({ kind, lateMs: performance.now() - at }); f() }, holds.get(channel))
  }
  const message = Object.getOwnPropertyDescriptor(proto, 'onmessage')
  Object.defineProperty(proto, 'onmessage', {
    configurable: true,
    get() { return message.get.call(this) },
    set(handler) {
      const ms = window.__nativeE2eHold || 0
      const channel = this
      if (ms > 0) holds.set(channel, ms)
      message.set.call(channel, ms > 0 ? (m) => late(channel, 'message', () => handler.call(channel, m)) : handler)
    },
  })
  Object.defineProperty(proto, 'cleanupCallback', {
    configurable: true,
    get() {
      const f = theirs.get(this)
      if (!f) return recorded
      const channel = this
      return holds.has(channel) ? () => late(channel, 'end', () => f.call(channel)) : f
    },
    set(f) { theirs.set(this, f) },
  })
  window.__nativeE2eEnds = ends
  window.__nativeE2eHeld = held
}
const own = window.__nativeE2e
const accessor = (name) => typeof (Object.getOwnPropertyDescriptor(C.prototype, name) || {}).set === 'function'
return {
  bundled: typeof own === 'object' && own !== null && typeof own.shellRunner === 'function' && typeof own.createNativeMind === 'function',
  host: !!own && own.shellRunner() !== null,
  ends: Array.isArray(window.__nativeE2eEnds) && C.prototype.cleanupCallback.toString().includes('ends.push'),
  holds: Array.isArray(window.__nativeE2eHeld) && accessor('onmessage') && accessor('cleanupCallback'),
  booted: window.__bootDone === true,
}`

const ENV = String.raw`${BOOTED}
const W = WebAssembly
let refusal = null
try { await fetch('ipc://localhost/native_model', { method: 'POST' }); refusal = 'answered' } catch (e) { refusal = String((e && e.message) || e) }
const d = Object.getOwnPropertyDescriptor(window, 'fetch')
return {
  jspi: typeof W.Suspending === 'function' && typeof W.promising === 'function',
  memory64: (() => { try { new W.Memory({ initial: 1, maximum: 2, address: 'i64' }); return true } catch { return false } })(),
  webgpu: typeof navigator.gpu === 'object' && navigator.gpu !== null,
  csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || { content: null }).content,
  fetchFixed: !!d && d.writable === false && d.configurable === false,
  bootDone: window.__bootDone === true,
  refusal,
  shell: !!core && typeof core.invoke === 'function' && typeof core.Channel === 'function',
  origin: location.origin,
  isolated: self.crossOriginIsolated === true,
  agent: navigator.userAgent,
}`

/** Sloane's card or chip, or the recovery card, whichever the page shows within 30 s (risk K1; recorded only). */
const K1 = String.raw`
const deadline = Date.now() + 30000
for (;;) {
  const sloane = document.querySelector('[data-concierge]')
  const recovery = document.querySelector('[role="alertdialog"][data-failure]')
  if (sloane || recovery || Date.now() > deadline) {
    return {
      sloane: sloane ? sloane.getAttribute('data-concierge') : null,
      recovery: recovery ? recovery.getAttribute('data-failure') : null,
      heading: recovery ? ((recovery.querySelector('h1, h2, h3') || {}).textContent || '').trim() : null,
      webgpu: typeof navigator.gpu === 'object' && navigator.gpu !== null,
      waitedMs: 30000 - Math.max(0, deadline - Date.now()),
    }
  }
  await sleep(250)
}`

/** What the app carries, through the page's own shellRunner, until the file's check is over. */
const MODEL = String.raw`
const host = own.shellRunner()
const deadline = Date.now() + 60000
const seen = []
for (;;) {
  const m = await host.model()
  const state = m && m.status ? m.status.state : null
  if (seen[seen.length - 1] !== state) seen.push(state)
  if (state === 'ready' || state === 'loaded' || state === 'failed' || Date.now() > deadline) return { m, seen }
  await sleep(50)
}`

/**
 * One answer through a new mind over the watched shellRunner: its look first, then the answer, its channel held back
 * `holdMs` when that is given.
 */
const ANSWER = String.raw`
const [maxTokens, holdMs = 0] = args
const w = watched()
const mind = own.createNativeMind({ host: w.host, maxTokens: () => maxTokens })
let installed
try { installed = await mind.installed() } catch (e) { installed = said(e) }
const coldBefore = mind.cold()
const heldFrom = window.__nativeE2eHeld.length
window.__nativeE2eHold = holdMs
let r
try { r = await ask(mind) } finally { window.__nativeE2eHold = 0 }
await settledAll(w)
const held = window.__nativeE2eHeld.slice(heldFrom)
return { installed, coldBefore, coldAfter: mind.cold(), settings: mind.settings(), ...r, ...plain(w), held, after: await w.host.model(), LOADING_APP: own.LOADING_APP }`

/** A Stop pressed at the first piece of a long answer, then the same number stopped once more. */
const STOP = String.raw`
const w = watched()
const mind = own.createNativeMind({ host: w.host, maxTokens: () => 100000 })
await mind.installed()
const ac = new AbortController()
const r = await ask(mind, { signal: ac.signal, onPiece: () => ac.abort() })
await settledAll(w)
const seen = plain(w)
const again = w.asked.length === 1 ? await own.shellRunner().stop(w.asked[0].req.id) : null
return { ...r, ...seen, again }`

/** The first piece waited for 1 ms (and every later gap): the wait runs out before the runner can answer. */
const TIMEOUT = String.raw`
const w = watched()
const mind = own.createNativeMind({ host: w.host, maxTokens: () => ${PLAN.maxTokens}, timeouts: { firstMs: 1, stallMs: 1 } })
await mind.installed()
const r = await ask(mind)
await settledAll(w)
return { ...r, ...plain(w) }`

/** A request and its stop in the same task, through shellRunner, again and again. */
const RACE_SHELL = String.raw`
const [n] = args
const host = own.shellRunner()
const runs = []
for (let i = 0; i < n; i++) {
  const id = randomId()
  let texts = 0
  const settled = host.generate({ id, messages, maxTokens: ${PLAN.maxTokens}, think: false }, (e) => { if (e && e.kind === 'text') texts++ })
  const stopped = host.stop(id)
  const [end, answer] = await Promise.all([settled.then((d) => d, (e) => ({ error: said(e) })), stopped])
  runs.push({ reason: end.reason || null, tokens: end.tokens === undefined ? null : end.tokens, error: end.error || null, answer, texts })
}
return runs`

/** The mind asked, and its asker's signal aborted at once, again and again. */
const RACE_MIND = String.raw`
const [n] = args
const w = watched()
const mind = own.createNativeMind({ host: w.host, maxTokens: () => ${PLAN.maxTokens} })
await mind.installed()
const runs = []
for (let i = 0; i < n; i++) {
  const ac = new AbortController()
  const asked = mind.answer({ tethers: [], prompt: 'Say hi.', signal: ac.signal, talk: true }, () => {})
  ac.abort()
  let name = null
  try { await asked } catch (e) { name = e && e.name }
  await settledAll(w)
  const g = w.asked[i]
  const s = w.stops[i]
  runs.push({ name, reason: g && g.done ? g.done.reason : null, tokens: g && g.done ? g.done.tokens : null, error: g && g.error ? said(g.error) : null, answer: s ? s.answer : null, sameId: !!g && !!s && g.req.id === s.id })
}
return { runs, asked: w.asked.length, stops: w.stops.length }`

/** A second request with the number of an answer still being made, through shellRunner (the mind picks its own). */
const DUPLICATE = String.raw`
const host = own.shellRunner()
const id = randomId()
let dup = null
const r = await host.generate({ id, messages, maxTokens: 100000, think: false }, (m) => {
  if (m.kind === 'text' && dup === null) {
    const events = []
    dup = host.generate({ id, messages, maxTokens: 8, think: false }, (e) => events.push(e)).then((done) => ({ done }), (error) => ({ error: said(error) }))
      .then(async (d) => ({ ...d, events, stopped: await host.stop(id) }))
  }
}).then((done) => ({ done }), (error) => ({ error: said(error) }))
return { r, dup: await dup }`

/**
 * Long answers set going through shellRunner, the page left while they are being made: the first is being made (its
 * first text came), the others wait behind it (each told so), and the same numbers asked again are refused, so each
 * is still live at that moment. native_generate is async, so a request can reach the runner after the first answer's
 * text has come: the numbers are asked again only once every request has heard from the runner (the first its text,
 * each other that it waits) or been answered, or a request still on its way would find its number taken by the probe.
 */
const BEFORE_RELOAD = String.raw`
const [count] = args
window.__nativeE2eOld = true
const host = own.shellRunner()
const ids = Array.from({ length: count }, randomId)
const heard = ids.map(() => [])
const over = ids.map(() => false)
const first = new Promise((resolve) => {
  let seen = false
  ids.forEach((id, i) => host.generate({ id, messages, maxTokens: 100000, think: false }, (m) => {
    heard[i].push(m.kind)
    if (i === 0 && m.kind === 'text' && !seen) { seen = true; resolve({ at: Date.now(), text: m.text.length }) }
  }).catch(() => undefined).finally(() => { over[i] = true }))
})
const started = await first
const deadline = Date.now() + 10000
while (!heard.every((k, i) => k.length > 0 || over[i]) && Date.now() < deadline) await sleep(5)
const takenMs = Date.now() - started.at
const probes = await Promise.all([ids[0], ids[ids.length - 1]].map((id) => host.generate({ id, messages, maxTokens: 8, think: false }, () => {}).then(() => null, (e) => said(e))))
return { ids, started, takenMs, heard: heard.map((k) => k.join(',')), probes, liveAt: Date.now() }`

/** The new page's first request (a fresh number) through its own mind, then the old first number asked again. */
const AFTER_RELOAD = String.raw`
const [oldId] = args
const at = Date.now()
const old = window.__nativeE2eOld === true
const booted = window.__bootDone === true
const w = watched()
const mind = own.createNativeMind({ host: w.host, maxTokens: () => 8 })
let installed
try { installed = await mind.installed() } catch (e) { installed = said(e) }
const cold = mind.cold()
const r = await ask(mind)
const doneAt = Date.now()
await settledAll(w)
const seen = plain(w)
const again = await own.shellRunner().generate({ id: oldId, messages, maxTokens: 8, think: false }, () => {}).then((done) => ({ done }), (error) => ({ error: said(error) }))
return { at, doneAt, old, booted, installed, cold, ...r, ...seen, again, WAITING: own.WAITING }`

// ---- The checks on what came back -------------------------------------------------------------------------------

const kinds = (events) => events.map((e) => e && e.kind)
const textOf = (events) => events.filter((e) => e && e.kind === 'text').map((e) => e.text).join('')
const sentence = (s) => typeof s === 'string' && /^[a-z]/.test(s) && !/[{}]|Err\(|Some\(/.test(s) && !s.endsWith('.')
const readPct = (p) => Number(/^reading the prompt (\d+)%$/.exec(typeof p === 'string' ? p : '')?.[1] ?? NaN)

/** The bundle, the end recorder and the hold are in the page. */
async function inject(when) {
  await page(`${BOOTED}\nreturn window.__bootDone === true`)
  const r = await wd('POST', `/session/${sid}/execute/sync`, { script: `${report.bundle.code}\n${INSTRUMENT}`, args: [] })
  check(r && r.bundled && r.host && r.ends && r.holds && r.booted,
    `${when}: the page's own shellRunner and createNativeMind (bundled from ${SHELL} and ${MIND}) are in the page, after its module ran; each channel's end is recorded and a channel can be held back`, r)
}

/**
 * The checks on one answer asked through the mind (`r`, from ANSWER): the mind's answer, the request it sent, and the
 * shell's own answer as shellRunner handed it back; with `holdMs`, that its channel was held back that long.
 */
function answered(name, r, asked, { first = false, holdMs = 0 } = {}) {
  check(r.error === null && r.answer, `${name}: the mind answers`, r.error)
  check(r.asked.length === 1, `${name}: the mind asked shellRunner's generate once`, r.asked.length)
  const g = r.asked[0]
  if (!r.answer || !g) return null
  const a = r.answer
  check(a.text === 'a'.repeat(asked) && a.reason === 'length' && a.tokens === asked,
    `${name}: the mind's answer is the tiny model's ${asked} "a"s, reason 'length', ${asked} tokens`, { text: a.text.slice(0, 80), length: a.text.length, reason: a.reason, tokens: a.tokens })
  check(r.pieces.length > 0 && r.pieces.every((p) => p.kind === 'text') && r.pieces.map((p) => p.text).join('') === a.text, `${name}: the pieces the asker was handed make up that text`, r.pieces.length)
  check(g.req.maxTokens === asked && g.req.think === false && g.req.roles.join(',') === 'system,user',
    `${name}: the mind's request: ${asked} tokens, no thinking, a system and a user message`, g.req)
  const d = g.done
  check(d && !g.error, `${name}: shellRunner's generate answers how it ended`, g.error)
  if (!d) return null
  if (holdMs > 0) {
    const late = Array.isArray(r.held) ? r.held : []
    check(late.length === g.events.length + 1 && late.slice(0, -1).every((h) => h.kind === 'message') && late.at(-1).kind === 'end' && late.every((h) => h.lateMs >= holdMs - 1),
      `${name}: each of its ${g.events.length} messages, and then its end, reached shellRunner ${holdMs} ms or more after it came`, late.slice(-3))
    check(g.drained, `${name}: the held end had come when shellRunner handed back the reply (shellRunner waits for the channel's end)`)
  } else {
    check(g.drained, `${name}: the channel had ended (its cleanupCallback) when shellRunner handed back the reply (in this web view Tauri sends the end first)`)
  }
  check(d.id === g.req.id, `${name}: the ending carries the request's number`, { id: g.req.id, got: d.id })
  check(d.reason === 'maxTokens' && d.tokens === asked,
    `${name}: the runner ended it by its token cap with exactly the ${asked} tokens asked (the tiny model never writes its end-of-text token)`, { reason: d.reason, tokens: d.tokens })
  const seq = kinds(g.events).join(',') + ','
  const order = first ? /^(loading,)+(read,)+(text,)+$/ : /^(read,)+(text,)+$/
  check(order.test(seq), `${name}: the events come in order (${first ? 'the load, then ' : ''}the prompt read, then the text)`, seq.slice(0, 300))
  if (first) {
    const loads = g.events.filter((e) => e.kind === 'loading')
    check(loads.length > 0 && loads.every((e, i) => e.fraction >= 0 && e.fraction <= 1 && (i === 0 || e.fraction >= loads[i - 1].fraction)) && loads.at(-1).fraction === 1,
      `${name}: the load is told, its fractions rising to 1`, loads.map((e) => e.fraction))
  }
  const reads = g.events.filter((e) => e.kind === 'read')
  check(reads.every((e, i) => i === 0 || e.done >= reads[i - 1].done) && reads.length > 0 && reads.at(-1).done === reads.at(-1).total && reads.at(-1).total === d.promptTokens,
    `${name}: the prompt is read to its end, ${d.promptTokens} tokens`, reads.slice(-3))
  check(g.events.every((e) => JSON.stringify(e).length < 8192), `${name}: every event is under 8 KiB of JSON, the size Tauri hands straight to the page`)
  const text = textOf(g.events)
  check(text === 'a'.repeat(d.tokens), `${name}: the events' text is the tiny model's, one "a" a token, nothing lost or repeated`, { tokens: d.tokens, text: text.slice(0, 80), length: text.length })
  check(d.promptTokens > 0 && d.reused >= 0 && d.reused <= d.promptTokens, `${name}: the prompt's tokens and the reused share are sane`, { promptTokens: d.promptTokens, reused: d.reused })
  check(Number.isInteger(d.prefillMs) && Number.isInteger(d.genMs) && d.prefillMs >= 0 && d.genMs >= 0 && d.prefillMs + d.genMs <= g.ms + 1000,
    `${name}: the timings are whole milliseconds within the answer's own time`, { prefillMs: d.prefillMs, genMs: d.genMs, wallMs: g.ms })
  check(d.threads >= 1 && d.threads <= PLAN.threadsCap && d.nCtx === PLAN.nCtx && d.nBatch === PLAN.nBatch && d.gpu === false,
    `${name}: the plan is the computer's (threads 1-8, context ${PLAN.nCtx}, batch ${PLAN.nBatch}, no GPU)`, { threads: d.threads, nCtx: d.nCtx, nBatch: d.nBatch, gpu: d.gpu })
  const reading = r.phases.slice(first ? 1 : 0, -1)
  check((!first || r.phases[0] === r.LOADING_APP) && reading.length > 0 && reading.every((p, i) => readPct(p) >= 0 && (i === 0 || readPct(p) >= readPct(reading[i - 1]))) && readPct(reading.at(-1)) === 100 && r.phases.at(-1) === null,
    `${name}: the asker's phases come in order (${first ? `"${r.LOADING_APP}", then ` : ''}"reading the prompt" up to 100%, then none)`, r.phases)
  check(r.settings.server === 'this app' && r.settings.model === TINY.file && new RegExp(`^the app itself, on the processor, [1-8] threads?, ${PLAN.nCtx} tokens of context; last answer: ${d.promptTokens} prompt tokens .*, ${asked} written in `).test(r.settings.runtime ?? ''),
    `${name}: the mind names the carried file and the runner's measured cost, on the processor`, r.settings)
  return d
}

// ---- The run ----------------------------------------------------------------------------------------------------

async function run() {
  report.env = await page(ENV)
  const env = report.env
  console.log(`web view: ${env.agent}; origin ${env.origin}; webgpu ${env.webgpu}; memory64 ${env.memory64}`)
  check(env.bootDone, 'the scripts run in the page\'s own world, after its module ran (window.__bootDone, main.tsx)', env)
  check(env.shell, 'the page has Tauri\'s core.invoke and core.Channel (withGlobalTauri)')
  check(env.jspi === false, 'WebKitGTK reports no JSPI: the app takes the native runner, not the model in the page', env)
  check(typeof env.csp === 'string' && /connect-src 'self'/.test(env.csp) && !/ipc:/.test(env.csp), 'the page\'s CSP is in force and admits no ipc: address', env.csp)
  check(env.fetchFixed && /is not on this machine/.test(env.refusal ?? ''), 'the air gap holds: fetch is fixed and refuses Tauri\'s ipc:// address, so commands take the message path', env.refusal)

  report.k1 = await page(K1)
  console.log(`K1 (recorded, not asserted): ${JSON.stringify(report.k1)}`)

  await inject('the first page')

  const model = await page(MODEL)
  const m = model.m
  check(m && m.file === TINY.file && m.bytes === TINY.bytes && Object.keys(m).sort().join(' ') === 'bytes file status',
    'native_model answers exactly { file: "tiny-a.gguf", bytes: 156992, status }', m)
  check(m && m.status && m.status.state === 'ready', `native_model's status reaches ready, the model not loaded before the first answer (seen: ${model.seen.join(' -> ')})`, m && m.status)

  const short = await page(ANSWER, 16)
  check(Array.isArray(short.installed) && short.installed.join(',') === TINY.file, 'the mind lists the carried model, tiny-a.gguf', short.installed)
  check(short.coldBefore === true && short.coldAfter === false, 'the mind says the app\'s model is still to be loaded before the first answer (cold), and not once it has run', { before: short.coldBefore, after: short.coldAfter })
  answered('first answer (16 tokens)', short, 16, { first: true })
  check(short.after && short.after.status && short.after.status.state === 'loaded', 'after the first answer native_model says loaded', short.after)

  const long = await page(ANSWER, 512)
  const d = answered('longer answer (512 tokens)', long, 512)
  check(long.asked[0] && long.asked[0].events.filter((e) => e.kind === 'text').length > 1, 'the longer answer comes in more than one text event', long.asked[0] && kinds(long.asked[0].events).length)
  const msPerToken = d && d.tokens > 0 ? Math.max(d.genMs, 1) / d.tokens : null
  report.rate = { msPerToken, tokens: d?.tokens, genMs: d?.genMs, prefillMs: d?.prefillMs, threads: d?.threads }
  console.log(`rate: ${msPerToken?.toFixed(3)} ms a token (${d?.tokens} tokens in ${d?.genMs} ms, ${d?.threads} threads)`)

  const held = await page(ANSWER, 64, HOLD_MS)
  answered(`held answer (64 tokens, its channel held back ${HOLD_MS} ms)`, held, 64, { holdMs: HOLD_MS })

  const stop = await page(STOP)
  const sg = stop.asked[0]
  const sd = sg && sg.done
  check(stop.error && stop.error.name === 'AbortError' && stop.answer === null, 'a Stop at the first piece: the mind rejects at once with AbortError', stop.error)
  check(stop.pieces.length === 1, 'nothing the runner sent after the Stop reached the asker', stop.pieces.length)
  check(sg && stop.stops.length === 1 && stop.stops[0].id === sg.req.id && stop.stops[0].answer === true,
    'the mind told the runner (shellRunner\'s stop, native_stop), which answered true', stop.stops)
  check(sd && sd.reason === 'stopped' && sd.id === sg.req.id, 'the runner ended the long answer (100,000 tokens asked) \'stopped\'', sd ?? (sg && sg.error))
  check(sd && sd.tokens >= 1 && sd.tokens < PLAN.maxTokens, `it made fewer tokens than asked (${sd?.tokens} of at most ${PLAN.maxTokens})`, sd)
  const stopText = sg ? textOf(sg.events) : ''
  check(sd && stopText === 'a'.repeat(stopText.length) && stopText.length <= sd.tokens, 'what it wrote before the stop is the tiny model\'s, none of it after its count', { text: stopText.length, tokens: sd?.tokens })
  check(stop.again === false, 'a second native_stop of the ended answer answers false')

  const timeout = await page(TIMEOUT)
  const tg = timeout.asked[0]
  check(timeout.error && timeout.error.name === 'CognitionError' && timeout.error.code === 'timeout' && sentence(timeout.error.message) && timeout.error.message.startsWith('the model inside this app '),
    'a 1 ms first-piece wait runs out: the mind rejects with a \'timeout\' CognitionError, in a plain sentence', timeout.error)
  check(tg && timeout.stops.length === 1 && timeout.stops[0].id === tg.req.id && tg.done && tg.done.reason === 'stopped',
    'the mind told the runner, which ended that answer \'stopped\'', { stops: timeout.stops, done: tg && (tg.done ?? tg.error) })

  const shellRaces = await page(RACE_SHELL, RACES.shell)
  const mindRaces = await page(RACE_MIND, RACES.mind)
  const early = (runs) => runs.filter((r) => r.answer === false).length
  report.races = { shell: shellRaces, mind: mindRaces }
  console.log(`races: ${early(shellRaces)} of ${RACES.shell} stops through shellRunner and ${early(mindRaces.runs)} of ${RACES.mind} through the mind reached the runner before their request`)
  check(shellRaces.length === RACES.shell && shellRaces.every((r) => r.reason === 'stopped' && r.texts <= r.tokens),
    `a stop sent in the same task right behind its request stops it, ${RACES.shell} times of ${RACES.shell} (the runner keeps a stop that comes first)`, shellRaces.filter((r) => r.reason !== 'stopped').slice(0, 4))
  check(mindRaces.runs.length === RACES.mind && mindRaces.asked === RACES.mind && mindRaces.stops === RACES.mind && mindRaces.runs.every((r) => r.name === 'AbortError' && r.reason === 'stopped' && r.sameId),
    `an asker that aborts as soon as it asked the mind: AbortError, and the runner ends that answer 'stopped', ${RACES.mind} times of ${RACES.mind}`, mindRaces.runs.filter((r) => r.reason !== 'stopped' || r.name !== 'AbortError').slice(0, 4))

  const dup = await page(DUPLICATE)
  check(dup.dup && dup.dup.error && dup.dup.error.code === 'model' && sentence(dup.dup.error.message) && dup.dup.events.length === 0,
    'a request with the number of an answer still being made is refused (model) with a plain sentence, and sent nothing', dup.dup)
  check(dup.dup && dup.dup.stopped === true && dup.r.done && dup.r.done.reason === 'stopped', 'the answer that holds the number goes on until it is stopped', dup.r.done ?? dup.r.error)

  // The reload: long answers going, the page reloaded, and the new page asks first.
  const before = await page(BEFORE_RELOAD, LONG_ANSWERS)
  check(before.probes.every((p) => p && p.code === 'model'), 'before the reload the first answer (being made) and the last (waiting) are both live: their numbers are refused', before.probes)
  const waited = before.heard.filter((k) => k.startsWith('waiting')).length
  check(waited >= LONG_ANSWERS - 1, `each answer asked while another is being made is told it waits (${waited} of ${LONG_ANSWERS})`, before.heard.slice(0, 4))
  const reloadAt = Date.now()
  await wd('POST', `/session/${sid}/refresh`, {})
  await inject('after the reload')
  const after = await page(AFTER_RELOAD, before.ids[0])
  const reloadMs = Date.now() - reloadAt
  check(after.old === false && after.booted, 'the reload gave a new page, and its module ran')
  check(Array.isArray(after.installed) && after.installed.join(',') === TINY.file && after.cold === false, 'the new page\'s mind lists tiny-a.gguf and finds the model loaded (not cold)', { installed: after.installed, cold: after.cold })
  const fg = after.asked[0]
  check(after.answer && after.answer.text === 'aaaaaaaa' && after.answer.reason === 'length' && after.answer.tokens === 8 && fg && fg.done && fg.done.reason === 'maxTokens' && fg.done.tokens === 8,
    'the new page\'s first request, through its own mind, completes ("aaaaaaaa", reason \'length\', 8 tokens)', { answer: after.answer, error: after.error, done: fg && (fg.done ?? fg.error) })
  check(fg && !kinds(fg.events).includes('waiting') && !after.phases.includes(after.WAITING),
    'it waits for nothing: every answer of the old page was already ended (lib.rs on_page_load stops them)', { events: fg && kinds(fg.events), phases: after.phases })
  check(after.again.done && after.again.done.reason === 'maxTokens', 'the old page\'s number is free again', after.again.done ?? after.again.error)
  // By themselves, the old answers would still be writing when the new page's first answer ended: the first had at
  // most PLAN.maxTokens to go, each other a full PLAN.maxTokens, at the rate measured above. (Without on_page_load the
  // first request waits behind all of them, and this span is their whole run.)
  const natural = msPerToken === null ? null : (LONG_ANSWERS * PLAN.maxTokens - before.started.text) * msPerToken
  const span = after.doneAt - before.started.at
  report.reload = { reloadMs, spanMs: span, naturalMs: natural, longAnswers: LONG_ANSWERS, takenMs: before.takenMs }
  console.log(`reload: the old answers' first text to the new page's first answer ended ${span} ms; by themselves they would run about ${natural?.toFixed(0)} ms more; every request had reached the runner ${before.takenMs} ms after the first text`)
  check(natural !== null && span < natural / 2, 'the old answers ended because the page reloaded, not by running out: the new page\'s first answer ended well before they could have', report.reload)
}

const driver = spawn(DRIVER, ['--port', String(PORT)], { stdio: ['ignore', 'inherit', 'inherit'] })
driver.on('error', (e) => { console.error(`tauri-driver did not start (${e.message})`); process.exit(1) })
const guard = setTimeout(() => { console.error('the run took more than 15 minutes'); driver.kill(); process.exit(1) }, 15 * 60_000)
try {
  report.bundle = await bundle()
  console.log(`bundled the page's own ${SHELL} and ${MIND}: ${report.bundle.code.length} bytes, ${report.bundle.modules.length} modules`)
  const ready = Date.now() + 30_000
  for (;;) {
    try { if ((await wd('GET', '/status'))?.ready !== false) break } catch (e) { if (Date.now() > ready) throw e }
    await sleep(200)
  }
  const session = await wd('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: report.app } } } })
  sid = session.sessionId
  await wd('POST', `/session/${sid}/timeouts`, { script: 180_000, pageLoad: 180_000 })
  await run()
} catch (e) {
  check(false, 'the run finished', e instanceof Error ? e.message : String(e))
} finally {
  if (sid) await wd('DELETE', `/session/${sid}`).catch(() => {})
  driver.kill()
  clearTimeout(guard)
}
if (report.bundle) report.bundle = { bytes: report.bundle.code.length, modules: report.bundle.modules }
if (OUT) writeFileSync(OUT, JSON.stringify(report, null, 2) + '\n')
console.log(`${report.checks.length - failed} of ${report.checks.length} checks passed`)
process.exit(failed === 0 ? 0 : 1)
