// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves auto's sizing of the Ollama model in the router (router.ts with modelFit.ts)
 * over a fake machine: with no GPU figure nothing changes; with one, an answer is measured once through Ollama's own
 * /api/ps and the next answer uses the largest listed model whose need fits; a model whose weights alone exceed the
 * figure is never chosen; a bigger step that is slow, split or will not load is dropped, at most once a visit; marks
 * kept across visits are undone by ask vram; a measurement that lands after a settings change is dropped; the
 * operator's own model is measured and never replaced; and every request stays on Ollama's own paths on this machine.
 * What breaks if it is removed? A change to the router could grow the model on a machine that gave no figure, keep a
 * model that does not fit, or ask something off this machine, and nothing in CI would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Answer, AnswerRequest, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { CognitionError, DEFAULT_MODEL, DEFAULT_SERVER, type FetchLike, type Timeouts } from './localCompute.ts'
import { VRAM_USAGE } from './modelFit.ts'
import { createMindRouter, type MindRouter } from './router.ts'
import { withScriptedFallback } from './scripted.ts'

const enc = new TextEncoder()
const ndjson = (...lines: object[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
const sse = (...events: object[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** A model Ollama lists: its name, its weight bytes (absent: none said) and, when Ollama says, what it does. */
interface Listed { readonly name: string; readonly size?: number; readonly capabilities?: readonly string[] }
/**
 * How /api/generate answers for a model: a done line with `tokens` written in `ns` nanoseconds (absent: no timing),
 * the first line `delayMs` late; a hang until the request is cut off; one piece and then nothing; one piece and then
 * Ollama's error line; or Ollama's 500.
 */
type Writes = { readonly tokens?: number; readonly ns?: number; readonly delayMs?: number } | 'hang' | 'stall' | 'broke' | 500
/** Where /api/ps says a model is loaded: its bytes in all and on the GPU. */
interface Placed { readonly size: number; readonly vram: number }
/** One request the page made: its address, how it was sent, and the model a body named. */
interface Call { readonly url: string; readonly mode?: string; readonly model?: string }

/**
 * A fake machine: Ollama on :11434 (its list with sizes and capabilities, /api/generate, /api/ps, /api/version, and
 * the chat format), nothing listening on any other port (:8080, :1234, :8089). Every request is noted. `hold` keeps
 * /api/ps waiting; `psFails` makes the next /api/ps requests answer 500; `psHang` makes /api/ps never answer (until
 * the request is cut off); `down` takes Ollama away.
 */
function machine(o: { models: Listed[]; ps?: Record<string, Placed>; writes?: Record<string, Writes> }) {
  const state: { models: Listed[]; ps: Record<string, Placed>; writes: Record<string, Writes>; hold: Promise<void> | null; down: boolean; psFails: number; psHang: boolean } = { models: o.models, ps: o.ps ?? {}, writes: o.writes ?? {}, hold: null, down: false, psFails: 0, psHang: false }
  const calls: Call[] = []
  const generate = (model: string, signal: AbortSignal | undefined): Promise<Response> | Response => {
    const w = state.writes[model] ?? {}
    if (w === 500) return json({ error: 'model requires more system memory (12.0 GiB) than is available (8.0 GiB)' }, 500)
    if (w === 'hang') {
      return new Promise<Response>((_, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        // An open connection keeps the process alive, as a real socket would.
        const open = setInterval(() => {}, 1000)
        signal?.addEventListener('abort', () => { clearInterval(open); reject(signal.reason) }, { once: true })
      })
    }
    const piece = { response: `${model} says hi`, done: false }
    const headers = { 'content-type': 'application/x-ndjson' }
    if (w === 'stall') return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(ndjson(piece))) } }), { status: 200, headers })
    if (w === 'broke') return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(ndjson(piece, { error: 'out of memory' }))); c.close() } }), { status: 200, headers })
    const done = { done: true, done_reason: 'stop', eval_count: w.tokens ?? 3, ...(w.ns !== undefined && { eval_duration: w.ns }) }
    const delay = w.delayMs ?? 0
    return new Response(new ReadableStream<Uint8Array>({
      start(c) {
        const send = (): void => {
          try {
            c.enqueue(enc.encode(ndjson(piece, done)))
            c.close()
          } catch {
            // the request was cut off first
          }
        }
        if (delay > 0) setTimeout(send, delay)
        else send()
      },
    }), { status: 200, headers })
  }
  const f: FetchLike = async (url, init) => {
    const u = new URL(url)
    const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : null
    calls.push({ url, ...(init?.mode !== undefined && { mode: init.mode }), ...(body?.model !== undefined && { model: body.model }) })
    if (u.port !== '11434' || state.down) throw new TypeError('Failed to fetch')
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 })
    const signal = init?.signal ?? undefined
    if (u.pathname === '/api/version') return json({ version: '0.30.0' })
    if (u.pathname === '/api/tags') {
      return json({ models: state.models.map((m) => ({ name: m.name, model: m.name, ...(m.size !== undefined && { size: m.size }), ...(m.capabilities && { capabilities: m.capabilities }) })) })
    }
    if (u.pathname === '/api/ps') {
      if (state.hold) await state.hold
      // Never answers: cut off only when the request's signal aborts, as a real fetch is.
      if (state.psHang) {
        return new Promise<Response>((_, reject) => {
          if (signal?.aborted) return reject(signal.reason)
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      }
      if (state.psFails > 0) {
        state.psFails--
        return json({ error: 'busy' }, 500)
      }
      return json({ models: Object.entries(state.ps).map(([name, p]) => ({ name, model: name, size: p.size, size_vram: p.vram })) })
    }
    if (u.pathname === '/api/generate') return generate(body?.model ?? '', signal)
    if (u.pathname === '/v1/models') return json({ data: state.models.map((m) => ({ id: m.name })) })
    if (u.pathname === '/v1/chat/completions') {
      return new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(sse({ choices: [{ delta: { content: 'chat says hi' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n')); c.close() } }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    return new Response('?', { status: 404 })
  }
  return { f, calls, state }
}

/** A store as the page's local storage is, one per test. */
const memory = (json: string | null = null) => {
  const s = { json, load: (): string | null => s.json, save: (v: string): void => { s.json = v } }
  return s
}
const FAST: Timeouts = { firstMs: 50, stallMs: 50 }
type Fake = ReturnType<typeof machine>
const make = (m: Fake, o: { vram?: string | null; store?: ReturnType<typeof memory>; timeouts?: Timeouts | undefined; lookMs?: number; inPage?: () => Mind } = {}): MindRouter =>
  createMindRouter({ fetch: m.f, lookMs: 50, timeouts: FAST, ...o })

const req = (): AnswerRequest => ({ tethers: [{ agent: 7, serial: 1, skills: ['Rust'] }], prompt: 'hi', signal: new AbortController().signal })
const ask = async (r: MindRouter): Promise<string> => (await r.answer(req(), () => {})).text
const timedOut = (e: unknown): boolean => e instanceof CognitionError && e.code === 'timeout'
/** The models /api/generate was asked for, in order. */
const sent = (m: Fake): (string | undefined)[] => m.calls.filter((c) => c.url.endsWith('/api/generate')).map((c) => c.model)
const lastSent = (m: Fake): string | undefined => sent(m).at(-1)
/** How many times /api/ps was asked. */
const looks = (m: Fake): number => m.calls.filter((c) => c.url.endsWith('/api/ps')).length
/** What the router kept under `fit`. */
const fitOf = (s: { json: string | null }): { vram: number | null; seen: { model: string; fails: number; pace: number | null }[]; usual?: string } | undefined => (JSON.parse(s.json ?? '{}') as { fit?: never }).fit
const keptOf = (s: { json: string | null }): Record<string, unknown> => JSON.parse(s.json ?? '{}') as Record<string, unknown>
/** Lets a measurement sent after an answer land (it runs detached, on a fake that answers at once). */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 1))
}
const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 500 && !ok(); i++) await new Promise((r) => setTimeout(r, 1))
  assert.ok(ok(), 'never happened')
}
/** Waits until /api/ps has been asked `n` times in all, and that measurement has landed. */
const measured = async (m: Fake, n: number): Promise<void> => {
  await until(() => looks(m) === n)
  await settle()
}
const L = (name: string, size?: number, capabilities?: readonly string[]): Listed => ({ name, ...(size !== undefined && { size }), ...(capabilities && { capabilities }) })
/** The machine of the 24 GB card: today's pick, a 14b that fits by measure, a 32b that does not. */
const CARD = (): Listed[] => [L(DEFAULT_MODEL, 3.3e9), L('qwen3:14b', 9.3e9), L('qwen3:32b', 20e9)]
const QUICK = { tokens: 412, ns: 10e9 } as const // 41.2 tokens a second
const SLOW = { tokens: 64, ns: 32e9 } as const // 2 tokens a second

test("no figure: main's requests and model, even after a slow answer split between the GPU and the processor; nothing kept, no fit row", async () => {
  const m = machine({ models: [L(DEFAULT_MODEL, 3.3e6), L('qwen3:14b', 9.3e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 2e6 } }, writes: { [DEFAULT_MODEL]: { tokens: 64, ns: 64e9 } } })
  const store = memory()
  const r = make(m, { store })
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await settle()
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  // A first wait that runs out, with no figure, marks nothing either: the floor device is never demoted.
  m.state.writes[DEFAULT_MODEL] = 'hang'
  await assert.rejects(ask(r), timedOut)
  m.state.writes[DEFAULT_MODEL] = SLOW
  await settle()
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await settle()
  assert.equal(looks(m), 0, 'no /api/ps without a figure')
  assert.deepEqual(m.calls.filter((c) => c.url.startsWith(DEFAULT_SERVER)).map((c) => c.url.slice(DEFAULT_SERVER.length)), ['/api/tags', '/api/generate', '/api/generate', '/api/generate', '/api/generate'])
  assert.deepEqual(sent(m), [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL])
  assert.equal(r.settings().model, DEFAULT_MODEL)
  assert.ok(!('fit' in r.settings()), 'no fit row')
  assert.ok(!('fit' in keptOf(store)), 'nothing kept under fit')
  assert.ok(!('picked' in keptOf(store)), 'the default stands, as on main')
})

test('a figure from the address: the first answer is measured once; the next uses the largest model Ollama lists whose need fits the figure less 2 GiB', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const store = memory()
  // The client's own five-minute first wait: the 14b's 47 s of reading earns no longer one, so the row names none.
  const r = make(m, { vram: '23.9', store, timeouts: undefined })
  // Before any look: nothing found yet to size.
  assert.equal(r.settings().fit, "23.9 GB given by the page's address (vram=); auto sizes Ollama's model once a look finds Ollama on this machine")
  await r.installed()
  assert.equal(r.settings().fit, "23.9 GB given by the page's address (vram=); the next answer is measured before auto picks bigger")
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 1)
  // The model the next answer goes to follows the measurement at once, before any look.
  assert.equal(r.settings().model, 'qwen3:14b')
  const ps = m.calls.findIndex((c) => c.url.endsWith('/api/ps'))
  assert.equal(m.calls[ps].url, `${DEFAULT_SERVER}/api/ps`)
  assert.ok(ps > m.calls.findIndex((c) => c.url.endsWith('/api/generate')), 'measured after the answer')
  // `ask` alone looks again, and the row says what the next answer uses.
  await r.installed()
  assert.equal(r.settings().fit, "23.9 GB given by the page's address (vram=); qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.2 tokens a second; auto answers with qwen3:14b, the largest that fits by what was measured (8.7 GB of weights, about 13.1 GB loaded by that measure; ask model <name> keeps another)")
  m.state.ps['qwen3:14b'] = { size: 14e9, vram: 14e9 }
  // Two tokens a second, but over 20 tokens: too few to call it slow.
  m.state.writes['qwen3:14b'] = { tokens: 20, ns: 10e9 }
  assert.equal(await ask(r), 'qwen3:14b says hi', 'not qwen3:32b, whose need of 28.2 GB does not fit')
  await measured(m, 2)
  assert.equal(await ask(r), 'qwen3:14b says hi')
  await settle()
  assert.equal(looks(m), 2, 'exactly one /api/ps per measured answer: a model measured this visit is not asked again')
  assert.deepEqual(sent(m), [DEFAULT_MODEL, 'qwen3:14b', 'qwen3:14b'])
  const kept = keptOf(store)
  assert.equal(kept.picked, 'qwen3:14b', "auto's own")
  assert.equal(fitOf(store)?.usual, DEFAULT_MODEL, 'the model it moved from')
  assert.deepEqual(fitOf(store)?.seen.map((s) => [s.model, s.fails]), [[DEFAULT_MODEL, 0], ['qwen3:14b', 0]])
})

test("a model whose weights alone exceed the figure is never chosen while a smaller one is listed, today's pick included", async () => {
  const m = machine({ models: [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)] })
  const store = memory()
  const r = make(m, { vram: '318.5', store, timeouts: undefined })
  assert.equal(await ask(r), 'qwen3:235b says hi')
  const first = m.calls.findIndex((c) => c.url.endsWith('/api/generate'))
  assert.equal(m.calls[first].model, 'qwen3:235b', 'the very first answer, with nothing measured yet')
  assert.ok(!m.calls.slice(0, first).some((c) => c.url.endsWith('/api/ps')), 'no /api/ps before it')
  await settle()
  assert.equal(keptOf(store).picked, 'qwen3:235b')
  assert.equal(fitOf(store)?.usual, 'deepseek-r1:671b')
  assert.equal(r.settings().fit, "318.5 GB given by the page's address (vram=); deepseek-r1:671b has 376.3 GB of weights alone, more than the GPU's 318.5 GB; auto answers with qwen3:235b, the largest smaller one Ollama lists (ask model <name> keeps another); ask vram auto measures afresh")
})

test('need is the largest loaded-to-weights ratio this server measured', async () => {
  const seen = (ratios: readonly (readonly [string, number, number])[]) => JSON.stringify({ v: 3, provider: 'auto', fit: { vram: null, seen: ratios.map(([model, weights, loaded]) => ({ server: DEFAULT_SERVER, model, weights, loaded, gpu: loaded, pace: 30, fails: 0 })) } })
  const models = (): Listed[] => [L('gemma3:4b', 3e9), L(DEFAULT_MODEL, 3.3e9), L('qwen3:14b', 9.3e9), L('qwen3:32b', 20e9)]
  // 1.8 measured first, 1.1 newest: the 32b fits only at 1.1 (22e9 of a 23.6e9 budget), so the 14b answers.
  const m = machine({ models: models() })
  const r = make(m, { vram: '24', store: memory(seen([['gemma3:4b', 3e9, 5.4e9], [DEFAULT_MODEL, 3.3e9, 3.63e9]])) })
  assert.equal(await ask(r), 'qwen3:14b says hi')
  // The client's 50 ms first wait here, so the 14b's 46.5 s of reading is a longer one, and the row says so.
  assert.match(r.settings().fit ?? '', /auto answers with qwen3:14b, the largest that fits by what was measured \(8\.7 GB of weights, about 15\.6 GB loaded by that measure; its first answer may wait up to 1 minute while Ollama reads it; ask model <name> keeps another\)$/)
  // With only the 1.1 measured, the 32b would fit: the larger ratio is what kept it out.
  const only = machine({ models: models() })
  assert.equal(await ask(make(only, { vram: '24', store: memory(seen([[DEFAULT_MODEL, 3.3e9, 3.63e9]])) })), 'qwen3:32b says hi')
  // A measurement counts only at the weights Ollama lists now: the 4b pulled again at another size voids its 1.8.
  const pulled = machine({ models: [L('gemma3:4b', 3.1e9), ...models().slice(1)] })
  assert.equal(await ask(make(pulled, { vram: '24', store: memory(seen([['gemma3:4b', 3e9, 5.4e9], [DEFAULT_MODEL, 3.3e9, 3.63e9]])) })), 'qwen3:32b says hi')
  // ...and only on the server it was made on.
  const elsewhere = JSON.parse(seen([['gemma3:4b', 3e9, 5.4e9], [DEFAULT_MODEL, 3.3e9, 3.63e9]])) as { fit: { seen: { server: string }[] } }
  elsewhere.fit.seen[0].server = 'http://127.0.0.1:11434'
  const other = machine({ models: models() })
  assert.equal(await ask(make(other, { vram: '24', store: memory(JSON.stringify(elsewhere)) })), 'qwen3:32b says hi')
})

test('a GPU that runs nothing (all on the processor) never grows the model', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 0 } } })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  await r.installed()
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  assert.equal(r.settings().fit, "24.0 GB given by the page's address (vram=); qwen3-vl:4b measured 4.7 GB loaded, all on the processor; nothing bigger that Ollama lists fits by what was measured, so auto keeps qwen3-vl:4b")
  assert.deepEqual(sent(m), [DEFAULT_MODEL, DEFAULT_MODEL])
})

test('an up-step that is too slow is dropped: the model below answers the next ask, and no bigger step is tried again this visit', async () => {
  const m = machine({
    models: [...CARD(), L('qwen3:8b', 5.2e9)],
    ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 }, 'qwen3:14b': { size: 14e9, vram: 14e9 }, 'qwen3:8b': { size: 7e9, vram: 7e9 } },
    writes: { [DEFAULT_MODEL]: QUICK, 'qwen3:14b': SLOW },
  })
  const store = memory()
  const r = make(m, { vram: '24', store })
  // No wait between the asks: each answer first awaits the measurement the one before it sent.
  await ask(r)
  assert.equal(await ask(r), 'qwen3:14b says hi')
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'the model below answers')
  assert.equal(looks(m), 2)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'and not the 8b: one failed step up a visit')
  await r.installed()
  assert.equal(r.settings().fit, "24.0 GB given by the page's address (vram=); qwen3:14b measured 13.0 GB loaded, all on the GPU, 2.0 tokens a second: too slow here; auto keeps qwen3-vl:4b for the rest of this visit; ask vram auto measures afresh")
  assert.deepEqual(sent(m), [DEFAULT_MODEL, 'qwen3:14b', DEFAULT_MODEL, DEFAULT_MODEL])
  assert.deepEqual(fitOf(store)?.seen.map((s) => [s.model, s.fails, s.pace]), [[DEFAULT_MODEL, 0, 41.2], ['qwen3:14b', 1, 2]])
})

test('too big in two visits and a model is avoided until ask vram, which forgets it; a measured pass clears the count', async () => {
  const m = machine({ models: [L(DEFAULT_MODEL, 3.3e9), L('qwen3:14b', 9.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 }, 'qwen3:14b': { size: 14e9, vram: 14e9 } }, writes: { [DEFAULT_MODEL]: QUICK, 'qwen3:14b': SLOW } })
  const store = memory()
  const fails = (): number | undefined => fitOf(store)?.seen.find((s) => s.model === 'qwen3:14b')?.fails
  // Visit one: measured, stepped up, too slow.
  const a = make(m, { vram: '24', store })
  await ask(a)
  await measured(m, 1)
  assert.equal(await ask(a), 'qwen3:14b says hi')
  await measured(m, 2)
  assert.equal(fails(), 1)
  // Visit two: what was measured earns the step at once; too slow again.
  const b = make(m, { vram: '24', store })
  assert.equal(await ask(b), 'qwen3:14b says hi')
  await measured(m, 3)
  assert.equal(fails(), 2)
  // Visit three: avoided from the start, and the row names the way back.
  const c = make(m, { vram: '24', store })
  assert.equal(await ask(c), `${DEFAULT_MODEL} says hi`)
  await measured(m, 4)
  await c.installed()
  assert.equal(c.settings().fit, "24.0 GB given by the page's address (vram=); qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.2 tokens a second; nothing bigger that Ollama lists fits by what was measured, so auto keeps qwen3-vl:4b; ask vram auto measures afresh")
  assert.equal(await ask(c), `${DEFAULT_MODEL} says hi`)
  // ask vram forgets every measurement, the marks with them: the 14b is tried again once measured.
  assert.match(c.setVram('24'), /^24\.0 GB at the console, kept: /)
  assert.deepEqual(fitOf(store)?.seen, [])
  assert.equal(await ask(c), `${DEFAULT_MODEL} says hi`)
  await measured(m, 5)
  assert.equal(await ask(c), 'qwen3:14b says hi')
  await measured(m, 6)
  assert.equal(fails(), 1)
  // A fourth visit: quick this time, and the pass clears the count.
  m.state.writes['qwen3:14b'] = { tokens: 300, ns: 10e9 }
  const d = make(m, { store })
  assert.equal(await ask(d), 'qwen3:14b says hi')
  await measured(m, 7)
  assert.equal(fails(), 0)
})

test('a first-piece wait that runs out fails a model only when Ollama split it: whole on the GPU, no verdict; not loaded, one more chance', async () => {
  // A figure of 2.1 GB leaves a budget of 0.1 GB: room for these small models, whose first waits stay 50 ms.
  const m = machine({ models: [L(DEFAULT_MODEL, 4e6), L('qwen3:8b', 9e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 5e6 }, 'qwen3:8b': { size: 11e6, vram: 11e6 } }, writes: { 'qwen3:8b': 'hang' } })
  const store = memory()
  const r = make(m, { vram: '2.1', store })
  await ask(r)
  await measured(m, 1)
  // Whole on the GPU when its wait ran out: still loading, no verdict, nothing kept.
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b')
  await measured(m, 2)
  assert.deepEqual(fitOf(store)?.seen.map((s) => s.model), [DEFAULT_MODEL])
  // Not loaded at all: one more chance, then set aside for the visit.
  delete m.state.ps['qwen3:8b']
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b')
  await measured(m, 3)
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b', 'one more chance')
  await measured(m, 4)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'set aside after the second')
  assert.deepEqual(fitOf(store)?.seen.map((s) => s.model), [DEFAULT_MODEL], 'nothing kept between visits for a model never seen loaded')
  // Split when its wait ran out: too big for this GPU, set aside and counted.
  assert.match(r.setVram('2.1'), /^2\.1 GB at the console/)
  m.state.ps['qwen3:8b'] = { size: 11e6, vram: 5e6 }
  await ask(r)
  await measured(m, 5)
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b')
  await measured(m, 6)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  assert.deepEqual(fitOf(store)?.seen.map((s) => [s.model, s.fails, s.pace]), [[DEFAULT_MODEL, 0, null], ['qwen3:8b', 1, null]])
  await r.installed()
  assert.match(r.settings().fit ?? '', /; qwen3:8b measured 0\.0 GB loaded, 45% on the GPU, the rest on the processor: too big for this GPU; auto keeps qwen3-vl:4b for the rest of this visit; ask vram 2\.1 measures afresh$/)
  // An answer the operator stopped is no measurement, whatever words the stop came with (the client's own five-minute
  // wait here, so only the stop ends it).
  const quiet = machine({ models: [L(DEFAULT_MODEL, 4e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 2e6 } }, writes: { [DEFAULT_MODEL]: 'hang' } })
  const q = make(quiet, { vram: '2.1', timeouts: undefined })
  for (const [i, why] of [new DOMException('stopped by the operator', 'AbortError'), new CognitionError('timeout', 'stopped by the operator')].entries()) {
    const stop = new AbortController()
    const a = q.answer({ ...req(), signal: stop.signal }, () => {})
    await until(() => sent(quiet).length === i + 1)
    stop.abort(why)
    await assert.rejects(a, (e: unknown) => e === why)
  }
  await settle()
  assert.equal(looks(quiet), 0, 'nothing asked after a stop')
})

test('a stall counts as pace 0: a bigger model is dropped, one no bigger only when split', async () => {
  const m = machine({
    models: [L('gemma3:1b', 1e6), L(DEFAULT_MODEL, 4e6), L('qwen3:8b', 9e6)],
    ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 5e6 }, 'qwen3:8b': { size: 11e6, vram: 11e6 } },
    writes: { 'qwen3:8b': 'stall' },
  })
  const store = memory()
  const r = make(m, { vram: '2.1', store })
  await ask(r)
  await measured(m, 1)
  // Bigger, all on the GPU, but it went quiet: slow, so dropped.
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b')
  await measured(m, 2)
  assert.deepEqual(fitOf(store)?.seen.find((s) => s.model === 'qwen3:8b'), { server: DEFAULT_SERVER, model: 'qwen3:8b', weights: 9e6, loaded: 11e6, gpu: 11e6, pace: 0, fails: 1 })
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  // No bigger and whole on the GPU: a stall alone is no verdict on it.
  m.state.writes[DEFAULT_MODEL] = 'stall'
  await assert.rejects(ask(r), timedOut)
  await measured(m, 3)
  assert.deepEqual(fitOf(store)?.seen.find((s) => s.model === DEFAULT_MODEL)?.fails, 0)
  m.state.writes[DEFAULT_MODEL] = {}
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  // Split and stalled: too big for this GPU, and the model below answers.
  m.state.writes[DEFAULT_MODEL] = 'stall'
  m.state.ps[DEFAULT_MODEL] = { size: 5e6, vram: 2e6 }
  await assert.rejects(ask(r), timedOut)
  await measured(m, 4)
  assert.equal(await ask(r), 'gemma3:1b says hi')
  assert.match(r.settings().fit ?? '', /; qwen3-vl:4b measured 0\.0 GB loaded, 40% on the GPU, the rest on the processor, 0\.0 tokens a second: too big for this GPU; auto answers with gemma3:1b, the largest smaller one Ollama lists \(ask model <name> keeps another\); ask vram auto measures afresh$/)
})

test("a big model's first answer may wait a second per 200 MB of its weights, figure or not", async () => {
  // 20e6 bytes earn 100 ms over the client's own 50 ms: a first line at 75 ms is not cut off. No figure is given.
  const big = machine({ models: [L(DEFAULT_MODEL, 20e6)], writes: { [DEFAULT_MODEL]: { delayMs: 75 } } })
  assert.equal(await ask(make(big)), `${DEFAULT_MODEL} says hi`)
  // A size not said earns nothing: the same server is cut off at 50 ms.
  const unknown = machine({ models: [L(DEFAULT_MODEL)], writes: { [DEFAULT_MODEL]: { delayMs: 75 } } })
  await assert.rejects(ask(make(unknown)), timedOut)
  assert.equal(looks(big) + looks(unknown), 0)
  // Under ask provider ollama the wait is the client's own, though auto's look read the size this visit.
  const own = machine({ models: [L(DEFAULT_MODEL, 20e6)], writes: { [DEFAULT_MODEL]: { delayMs: 75 } } })
  const r = make(own)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  r.setProvider('ollama')
  await assert.rejects(ask(r), timedOut)
})

test('a moved model Ollama will not load is set aside and the same ask is answered once more by the next one', async () => {
  const models = (): Listed[] => [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)]
  const m = machine({ models: models(), writes: { 'qwen3:235b': 500 } })
  const store = memory()
  const r = make(m, { vram: '318.5', store })
  assert.equal(await ask(r), 'qwen3:8b says hi')
  assert.deepEqual(sent(m), ['qwen3:235b', 'qwen3:8b'], 'two answers asked in one ask: the 500, then the next one down')
  await settle()
  assert.deepEqual(fitOf(store)?.seen, [], 'nothing persisted: the mark is for this visit')
  assert.equal(fitOf(store)?.usual, 'deepseek-r1:671b')
  assert.equal(await ask(r), 'qwen3:8b says hi', 'set aside for the visit')
  // The next one fails too: once only, and that failure is the ask's.
  const both = machine({ models: models(), writes: { 'qwen3:235b': 500, 'qwen3:8b': 500 } })
  await assert.rejects(ask(make(both, { vram: '318.5' })), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(sent(both), ['qwen3:235b', 'qwen3:8b'])
  // Once the answer has begun, Ollama's failure is that answer's: not answered again.
  const broke = machine({ models: models(), writes: { 'qwen3:235b': 'broke' } })
  await assert.rejects(ask(make(broke, { vram: '318.5' })), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(sent(broke), ['qwen3:235b'])
  // A bigger step that will not load: the usual model answers, not the next bigger one (one failed step up a visit).
  const up = machine({ models: [L(DEFAULT_MODEL, 3.3e9), L('qwen3:8b', 5.2e9), L('qwen3:14b', 9.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { 'qwen3:14b': 500 } })
  const u = make(up, { vram: '24' })
  await ask(u)
  assert.equal(await ask(u), `${DEFAULT_MODEL} says hi`)
  assert.deepEqual(sent(up), [DEFAULT_MODEL, 'qwen3:14b', DEFAULT_MODEL])
  assert.equal(await ask(u), `${DEFAULT_MODEL} says hi`)
  // A model auto did not move is not answered again, though a smaller one is listed: the 500 is the answer.
  const plain = machine({ models: [L('gemma3:1b', 1e9), L(DEFAULT_MODEL, 3.3e9)], writes: { [DEFAULT_MODEL]: 500 } })
  await assert.rejects(ask(make(plain, { vram: '24' })), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(sent(plain), [DEFAULT_MODEL])
  await assert.rejects(ask(make(plain)), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(sent(plain), [DEFAULT_MODEL, DEFAULT_MODEL], 'nor with no figure')
})

test('a measurement that lands after ask vram 16 is dropped', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const store = memory()
  const r = make(m, { vram: '24', store, lookMs: 5000 })
  let release = (): void => {}
  m.state.hold = new Promise<void>((done) => { release = done })
  await ask(r)
  await measured(m, 1)
  r.setVram('16')
  release()
  m.state.hold = null
  await settle()
  assert.deepEqual(fitOf(store), { vram: 16, seen: [] })
  assert.equal(r.settings().fit, '16.0 GB given at the console (ask vram); the next answer is measured before auto picks bigger')
  // The next answer is today's pick again, and is measured afresh.
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 2)
  assert.deepEqual(fitOf(store)?.seen.map((s) => s.model), [DEFAULT_MODEL])
  // Every other settings change drops it too.
  const changes: readonly [string, (x: MindRouter) => unknown][] = [
    ['ask model', (x) => x.setModel('qwen3:14b')], ['ask model auto', (x) => x.setModel('auto')], ['ask provider', (x) => x.setProvider('auto')],
    ['ask server', (x) => x.setServer(DEFAULT_SERVER)], ['ask api', (x) => x.setApi?.('generate')], ['ask connect', (x) => x.connect('auto')],
  ]
  for (const [what, change] of changes) {
    const n = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } } })
    const kept = memory()
    const x = make(n, { vram: '24', store: kept, lookMs: 5000 })
    let go = (): void => {}
    n.state.hold = new Promise<void>((done) => { go = done })
    await ask(x)
    await measured(n, 1)
    change(x)
    go()
    await settle()
    assert.deepEqual(fitOf(kept)?.seen ?? [], [], what)
  }
  // A change while the answer is still coming: the answer is not measured at all.
  const late = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: { delayMs: 20 } } })
  const y = make(late, { vram: '24', timeouts: undefined })
  const coming = ask(y)
  await until(() => sent(late).length === 1)
  y.setApi?.('generate')
  assert.equal(await coming, `${DEFAULT_MODEL} says hi`)
  await settle()
  assert.equal(looks(late), 0)
})

test('ask model auto hands the Ollama model back to auto: the default, then auto\'s own pick; the three sentences', async () => {
  const m = machine({ models: [L('gemma3:4b', 3e9), L('qwen3:14b', 9.3e9)] })
  const store = memory()
  const r = make(m, { store })
  // Under provider ollama: the default for now.
  r.setProvider('ollama')
  r.setModel('qwen3:14b')
  assert.equal(keptOf(store).picked, null)
  assert.equal(r.setModel(' auto '), `auto: ${DEFAULT_MODEL} for now; auto chooses the Ollama model only under ask provider auto`)
  assert.equal(r.settings().model, DEFAULT_MODEL)
  assert.ok(!('picked' in keptOf(store)))
  // Under auto before a look: at the next look.
  r.setProvider('auto')
  r.setProvider('ollama')
  r.setModel('qwen3:14b')
  r.setProvider('auto')
  assert.equal(r.setModel('auto'), 'auto: auto chooses the Ollama model again at its next look')
  assert.equal(await ask(r), 'gemma3:4b says hi', 'the first text model, as the server lacks the default')
  // Under auto with Ollama found: the operator chooses, then hands it back, and auto chooses at once.
  r.setModel('qwen3:14b')
  assert.equal(await ask(r), 'qwen3:14b says hi')
  assert.equal(r.setModel('auto'), 'auto: auto chooses the Ollama model again (gemma3:4b now)')
  assert.equal(keptOf(store).picked, 'gemma3:4b')
  assert.equal(await ask(r), 'gemma3:4b says hi')
  // Under another provider, auto is just a model name for that server.
  r.setProvider('llamacpp')
  assert.equal(r.setModel('auto'), 'auto')
  assert.equal(r.settings().model, 'auto')
  assert.equal(keptOf(store).picked, 'gemma3:4b', "the Ollama model stays auto's own")
})

test('a model Ollama says writes no text is never a step, whatever its name', async () => {
  const m = machine({
    models: [L(DEFAULT_MODEL, 3.3e9, ['completion', 'vision']), L('qwen3:14b', 9.3e9, ['completion', 'embedding']), L('qwen3:30b', 18e9, ['embedding']), L('qwen3-vl:8b', 6e9, ['completion', 'vision'])],
    ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } },
  })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  assert.equal(await ask(r), 'qwen3-vl:8b says hi', 'not the 14b or the 30b, which Ollama says do not write text')
})

test("the operator's model is measured and shown, never replaced", async () => {
  const m = machine({
    models: [L(DEFAULT_MODEL, 3.3e9), L('qwen3:8b', 5.2e9), L('qwen3:14b', 9.3e9)],
    ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 }, 'qwen3:8b': { size: 6e9, vram: 6e9 }, 'qwen3:14b': { size: 14e9, vram: 14e9 } },
    writes: { 'qwen3:8b': { tokens: 300, ns: 10e9 } },
  })
  const store = memory()
  const r = make(m, { vram: '24', store })
  await ask(r)
  assert.equal(await ask(r), 'qwen3:14b says hi', 'auto stepped up')
  // The operator chooses: theirs from now on, and auto forgets the model it had moved from.
  r.setModel('qwen3:8b')
  assert.equal(keptOf(store).picked, null)
  assert.equal(fitOf(store)?.usual, undefined)
  assert.equal(await ask(r), 'qwen3:8b says hi')
  await measured(m, 3)
  await r.installed()
  assert.equal(r.settings().fit, "24.0 GB given by the page's address (vram=); the model is yours (ask model chose it): auto sizes only a model it chose (ask model auto hands it back); qwen3:8b measured 5.6 GB loaded, all on the GPU, 30.0 tokens a second")
  assert.equal(await ask(r), 'qwen3:8b says hi', 'though the 14b fits by that measure')
  // Split and slow, twice in one visit: shown, counted once, and still theirs.
  m.state.ps['qwen3:8b'] = { size: 6e9, vram: 3e9 }
  m.state.writes['qwen3:8b'] = SLOW
  assert.equal(await ask(r), 'qwen3:8b says hi')
  assert.equal(await ask(r), 'qwen3:8b says hi')
  await measured(m, 5)
  assert.deepEqual(fitOf(store)?.seen.find((s) => s.model === 'qwen3:8b')?.fails, 1)
  assert.match(r.settings().fit ?? '', /; qwen3:8b measured 5\.6 GB loaded, 50% on the GPU, the rest on the processor, 2\.0 tokens a second: too big for this GPU$/)
  assert.deepEqual(sent(m), [DEFAULT_MODEL, 'qwen3:14b', 'qwen3:8b', 'qwen3:8b', 'qwen3:8b', 'qwen3:8b'])
})

test('only Ollama\'s own paths on this machine: /api/tags, /api/generate, /api/ps and /api/version, every one loopback', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 }, 'qwen3:14b': { size: 14e9, vram: 14e9 } }, writes: { [DEFAULT_MODEL]: QUICK, 'qwen3:14b': SLOW } })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  await r.installed()
  await ask(r)
  await measured(m, 2)
  await ask(r)
  // Ollama goes away: the answer fails, auto looks again, and nothing answers.
  m.state.down = true
  await assert.rejects(ask(r), (e: unknown) => e instanceof CognitionError && e.code === 'offline')
  assert.deepEqual(sent(m), [DEFAULT_MODEL, 'qwen3:14b', DEFAULT_MODEL, DEFAULT_MODEL])
  for (const c of m.calls) assert.match(c.url, /^http:\/\/localhost:(11434|8080|1234|9931|8000|30000|8089)\//, c.url)
  const ollama = new Set(m.calls.filter((c) => c.url.startsWith(DEFAULT_SERVER)).map((c) => c.url.slice(DEFAULT_SERVER.length)))
  assert.deepEqual([...ollama].sort(), ['/api/generate', '/api/ps', '/api/tags', '/api/version'])
  // The other servers (the second round's addresses too) were asked only what a look asks: their lists, and whether
  // anything listens.
  const others = new Set(m.calls.filter((c) => !c.url.startsWith(DEFAULT_SERVER)).map((c) => new URL(c.url).pathname))
  assert.deepEqual([...others].sort(), ['/api/version', '/v1/models'])
})

test('what is kept: the console figure and the measurements, read back checked; a malformed or off-machine record is dropped', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const store = memory()
  const r = make(m, { store })
  r.setVram('24')
  await ask(r)
  await measured(m, 1)
  const entry = { server: DEFAULT_SERVER, model: DEFAULT_MODEL, weights: 3.3e9, loaded: 5e9, gpu: 5e9, pace: 41.2, fails: 0 }
  // The step up follows the measurement at once, so the model it moved from is kept with it.
  assert.deepEqual(fitOf(store), { vram: 24, seen: [entry], usual: DEFAULT_MODEL })
  // Read back next visit: the console's figure and the measurement stand.
  const next = make(m, { store })
  await next.installed()
  assert.match(next.settings().fit ?? '', /^24\.0 GB given at the console \(ask vram\); qwen3-vl:4b measured 4\.7 GB loaded, all on the GPU, 41\.2 tokens a second; auto answers with qwen3:14b, /)
  // A record tampered with: a server off this machine, bytes out of bounds, a count past the limit and a figure out
  // of range are each dropped; what is well formed is kept.
  const bad = { ...keptOf(store), fit: { vram: 5000, usual: 7, seen: [{ ...entry, server: 'http://example.com:11434' }, { ...entry, weights: -1 }, { ...entry, loaded: 2 ** 51 }, { ...entry, fails: 3 }, { ...entry, gpu: 6e9 }, entry] } }
  store.json = JSON.stringify(bad)
  const read = make(m, { store })
  read.setKey('')
  assert.deepEqual(fitOf(store), { vram: null, seen: [entry] })
  assert.ok(!('fit' in read.settings()), 'no figure left: no row')
  store.json = JSON.stringify({ ...bad, fit: 'not a record' })
  make(m, { store }).setKey('')
  assert.ok(!('fit' in keptOf(store)))
})

test("ask vram: 0 sizes nothing whatever the address says; auto hands back to the address; the four sentences, and the suffix under another provider", async () => {
  const m = machine({ models: [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9)] })
  const store = memory()
  const r = make(m, { vram: '318.5', store })
  assert.equal(await ask(r), 'qwen3:235b says hi')
  await settle()
  // 0 at the console: off, whatever the address says, and the model auto moved goes back at once.
  assert.equal(r.setVram('0'), "0: auto sizes nothing by the GPU, whatever the page's address says; what was measured before is forgotten (ask vram auto hands it back)")
  assert.equal(r.settings().model, 'deepseek-r1:671b')
  assert.equal(r.settings().fit, "off at the console (ask vram 0): auto keeps its usual model (ask vram auto hands sizing back to the page's address)")
  const before = looks(m)
  assert.equal(await ask(r), 'deepseek-r1:671b says hi')
  await settle()
  assert.equal(looks(m), before, 'nothing measured while off')
  // auto: the address again.
  assert.equal(r.setVram('AUTO'), "auto: 318.5 GB from the page's address (vram=); what was measured before is forgotten")
  assert.deepEqual(fitOf(store), { vram: null, seen: [] })
  assert.equal(await ask(r), 'qwen3:235b says hi')
  assert.equal(r.setVram('16'), '16.0 GB at the console, kept: auto may give Ollama a bigger model it already has once an answer has been measured; what was measured before is forgotten')
  assert.equal(r.settings().model, 'deepseek-r1:671b', 'handed back while auto chose it')
  for (const bad of ['5000', 'lots', '-1', '24GB', '']) assert.throws(() => r.setVram(bad), (e: unknown) => e instanceof TypeError && e.message === VRAM_USAGE, bad)
  assert.equal(fitOf(store)?.vram, 16, 'a refused figure changes nothing')
  // No figure in the address.
  assert.equal(make(machine({ models: [] })).setVram('auto'), 'auto: no GPU size given, so auto keeps its usual model; what was measured before is forgotten')
  // Under another provider: kept for auto, and said so; no row there.
  r.setProvider('ollama')
  assert.equal(r.setVram('8'), '8.0 GB at the console, kept: auto may give Ollama a bigger model it already has once an answer has been measured; what was measured before is forgotten; it applies under ask provider auto')
  assert.equal(r.settings().fit, undefined)
  // The page's wrappers keep the router's own setter (scripted.ts withScriptedFallback binds it).
  assert.equal(withScriptedFallback(r).setVram?.('0').split(':')[0], '0')
})

test('another provider found, or the chat format: nothing measured, and the row says why', async () => {
  // A phone: no model server, the page's own model answers.
  const page = (): Mind => ({
    settings: () => ({ server: 'this page', model: 'tiny.gguf', runtime: 'this browser runs it (one thread)', storage: 'kept in this page' }),
    setServer: () => { throw new Error('no server') },
    setModel: (name: string) => name,
    installed: async () => ['tiny.gguf'],
    answer: async (_req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {
      onPiece({ kind: 'text', text: 'inpage says hi' })
      return { text: 'inpage says hi', thinking: 0, tokens: 3, reason: 'stop' }
    },
  })
  const phone = machine({ models: [] })
  phone.state.down = true
  const p = make(phone, { vram: '8', inPage: page })
  assert.equal(await ask(p), 'inpage says hi')
  assert.equal(p.settings().fit, "8.0 GB given by the page's address (vram=); auto sizes only a model Ollama lists (inpage answers now)")
  assert.equal(looks(phone), 0)
  // Ollama in the chat format: nothing measured and nothing sized, though a measurement in the generate format would
  // have earned the 14b.
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } } })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  r.setApi?.('chat')
  assert.equal(await ask(r), 'chat says hi')
  assert.equal(await ask(r), 'chat says hi')
  await settle()
  assert.deepEqual(m.calls.filter((c) => c.url.endsWith('/v1/chat/completions')).map((c) => c.model), [DEFAULT_MODEL, DEFAULT_MODEL])
  assert.equal(r.settings().fit, "24.0 GB given by the page's address (vram=); auto sizes Ollama's model only in the generate format (ask api generate)")
  assert.equal(looks(m), 1)
  // The chat format from the first answer: never measured.
  const chat = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } } })
  const c = make(chat, { vram: '24' })
  await c.installed()
  c.setApi?.('chat')
  assert.equal(await ask(c), 'chat says hi')
  await settle()
  assert.equal(looks(chat), 0)
})

test('a measurement that fails is asked again after the next answer, and the step follows it at once', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const r = make(m, { vram: '24' })
  m.state.psFails = 1
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 1)
  assert.equal(r.settings().model, DEFAULT_MODEL, 'nothing measured, nothing moved')
  assert.equal(r.settings().fit, "24.0 GB given by the page's address (vram=); the next answer is measured before auto picks bigger")
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 2)
  assert.equal(r.settings().model, 'qwen3:14b', 'measured the second time')
  assert.match(r.settings().fit ?? '', /; auto answers with qwen3:14b, the largest that fits by what was measured /)
  assert.equal(await ask(r), 'qwen3:14b says hi')
})

test('a refused command leaves a measurement under way alone; an accepted one drops it, and the next answer is measured again', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const r = make(m, { vram: '24' })
  let release = (): void => {}
  m.state.hold = new Promise<void>((res) => { release = res })
  await ask(r)
  await until(() => looks(m) === 1)
  assert.throws(() => r.connect('bogus'))
  assert.throws(() => r.setProvider('nope'))
  assert.throws(() => r.setModel(''))
  assert.throws(() => r.setApi?.('smoke'))
  assert.throws(() => r.setServer('http://example.com:11434'))
  release()
  m.state.hold = null
  await settle()
  assert.equal(r.settings().model, 'qwen3:14b', 'kept, and the step followed')
  // Accepted, though it changes nothing: the measurement under way is dropped, and the next answer is measured.
  const n = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const r2 = make(n, { vram: '24' })
  n.state.hold = new Promise<void>((res) => { release = res })
  await ask(r2)
  await until(() => looks(n) === 1)
  r2.setProvider('auto')
  release()
  n.state.hold = null
  await settle()
  assert.equal(r2.settings().model, DEFAULT_MODEL, 'dropped')
  await ask(r2)
  await measured(n, 2)
  assert.equal(r2.settings().model, 'qwen3:14b')
})

test('a stop while a measurement is under way ends the ask at once, and ask alone too', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const r = make(m, { vram: '24', lookMs: 2000 })
  let release = (): void => {}
  m.state.hold = new Promise<void>((res) => { release = res })
  await ask(r)
  await until(() => looks(m) === 1)
  const held = (p: Promise<unknown>): Promise<string> => Promise.race([p.then(() => 'answered', () => 'stopped'), new Promise<string>((res) => setTimeout(() => res('held'), 500))])
  // Unstopped, ask alone waits for the measurement under way.
  const alone = r.installed()
  assert.equal(await held(alone), 'held', 'ask alone waits for the measurement under way')
  const stop = new AbortController()
  const answer = r.answer({ ...req(), signal: stop.signal }, () => {})
  stop.abort(new DOMException('stopped by the operator', 'AbortError'))
  assert.equal(await held(answer), 'stopped')
  const quit = new AbortController()
  const list = r.installed(quit.signal)
  quit.abort(new DOMException('stopped by the operator', 'AbortError'))
  assert.equal(await held(list), 'stopped')
  assert.equal(sent(m).length, 1, 'nothing more was sent')
  release()
  m.state.hold = null
  await alone
  assert.equal(r.settings().model, 'qwen3:14b', 'ask alone answers once the measurement has landed')
})

test('found in the chat format, then ask api generate: the next answer looks again and is sized before it is sent', async () => {
  const m = machine({ models: [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)] })
  const store = memory()
  const first = make(m, { store })
  await first.installed()
  first.setApi?.('chat')
  // Next visit: found in the chat format, with no list of sizes.
  const r = make(m, { vram: '318.5', store })
  assert.equal(await ask(r), 'chat says hi')
  assert.equal(r.settings().fit, "318.5 GB given by the page's address (vram=); auto sizes Ollama's model only in the generate format (ask api generate)")
  r.setApi?.('generate')
  assert.equal(await ask(r), 'qwen3:235b says hi', 'not deepseek-r1:671b, whose weights alone exceed the figure')
  assert.deepEqual(sent(m), ['qwen3:235b'])
})

test('ask model auto in the chat format: the next ask looks, and chooses from what Ollama lists then', async () => {
  const m = machine({ models: [L('llama3:8b', 4.7e9), L('qwen3:8b', 5.2e9)] })
  const store = memory()
  const first = make(m, { store })
  await first.installed()
  first.setApi?.('chat')
  const r = make(m, { store })
  await r.installed()
  r.setModel('qwen3:8b')
  assert.equal(r.setModel('auto'), 'auto: auto chooses the Ollama model again at its next look')
  const before = m.calls.length
  assert.equal(await ask(r), 'chat says hi')
  const after = m.calls.slice(before).filter((c) => c.url.startsWith(DEFAULT_SERVER)).map((c) => `${new URL(c.url).pathname} ${c.model ?? ''}`.trim())
  assert.deepEqual(after, ['/v1/models', '/v1/chat/completions llama3:8b'], 'looked first; not the default, which Ollama does not list')
})

test('the answer R8 gives once more is measured too', async () => {
  const m = machine({ models: [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)], ps: { 'qwen3:8b': { size: 6e9, vram: 6e9 } }, writes: { 'qwen3:235b': 500, 'qwen3:8b': QUICK } })
  const store = memory()
  const r = make(m, { vram: '318.5', store })
  assert.equal(await ask(r), 'qwen3:8b says hi')
  await measured(m, 1)
  assert.deepEqual(fitOf(store)?.seen.map((s) => s.model), ['qwen3:8b'])
  assert.equal(r.settings().model, 'qwen3:8b')
})

test('an /api/ps that never answers is cut off after the look wait: the next ask is not held, nothing is kept, and the next answer asks again', async () => {
  const m = machine({ models: CARD(), ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: QUICK } })
  const store = memory()
  const r = make(m, { vram: '24', store, lookMs: 50 })
  m.state.psHang = true
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await until(() => looks(m) === 1)
  const next = ask(r)
  assert.equal(await Promise.race([next, new Promise<string>((res) => setTimeout(() => res('held'), 1000))]), `${DEFAULT_MODEL} says hi`)
  await until(() => looks(m) === 2)
  await new Promise((res) => setTimeout(res, 100))
  assert.equal(fitOf(store)?.seen.length ?? 0, 0, 'nothing kept')
  assert.equal(r.settings().model, DEFAULT_MODEL)
})

test('whole on the processor when a first wait runs out: still loading, no verdict, and a count kept from before stands', async () => {
  const before = JSON.stringify({ v: 3, provider: 'auto', fit: { vram: null, seen: [{ server: DEFAULT_SERVER, model: 'qwen3:8b', weights: 9e6, loaded: 11e6, gpu: 5e6, pace: 2, fails: 1 }] } })
  const m = machine({ models: [L(DEFAULT_MODEL, 4e6), L('qwen3:8b', 9e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 5e6 }, 'qwen3:8b': { size: 11e6, vram: 0 } }, writes: { 'qwen3:8b': 'hang' } })
  const store = memory(before)
  // Kept from before: the 8b measured partly on the GPU at 11 MB, which fits a 2.1 GB figure less 2 GiB, so auto
  // steps up to it at once.
  const r = make(m, { vram: '2.1', store })
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b')
  await measured(m, 1)
  assert.deepEqual(fitOf(store)?.seen.map((s) => [s.model, s.fails]), [['qwen3:8b', 1]], 'no verdict: the count of 1 stands')
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b', 'not set aside')
})

test('ask vram gives a model one more chance again after a first wait with nothing loaded', async () => {
  const m = machine({ models: [L(DEFAULT_MODEL, 4e6), L('qwen3:8b', 9e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 5e6 } }, writes: { 'qwen3:8b': 'hang' } })
  const r = make(m, { vram: '2.1' })
  await ask(r)
  await measured(m, 1)
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b')
  await measured(m, 2)
  r.setVram('2.1')
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 3)
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b')
  await measured(m, 4)
  await assert.rejects(ask(r), timedOut)
  assert.equal(lastSent(m), 'qwen3:8b', 'one more chance after ask vram, as at the start of a visit')
})

test("the operator's model named without its tag (ask model qwen3) is measured and shown like qwen3:latest", async () => {
  const m = machine({ models: [L(DEFAULT_MODEL, 3.3e9), L('qwen3:latest', 5.2e9)], ps: { 'qwen3:latest': { size: 6e9, vram: 6e9 } }, writes: { qwen3: SLOW } })
  const r = make(m, { vram: '24' })
  await r.installed()
  r.setModel('qwen3')
  assert.equal(await ask(r), 'qwen3 says hi')
  await measured(m, 1)
  assert.match(r.settings().fit ?? '', /^24\.0 GB given by the page's address \(vram=\); the model is yours \(ask model chose it\): auto sizes only a model it chose \(ask model auto hands it back\); qwen3 measured 5\.6 GB loaded, all on the GPU, 2\.0 tokens a second/)
})
