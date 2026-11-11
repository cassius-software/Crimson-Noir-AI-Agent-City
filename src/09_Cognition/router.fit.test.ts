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
 * Ollama's context and answer cap double once a visit after a cut answer on a settled model measured all on the GPU,
 * with room; the first answer there is measured and goes back when split, slow, on the processor, refused (that ask
 * answered once more at 8,192, once, and measured there, unless a setting changed) or failed partway (not answered
 * again), a refusal or a failure whatever changed since and never by setting the model aside; the moved model's retry
 * and the answer after a look, at a grown context, are measured there and go back when refused or failing partway;
 * Ollama gone at a grown context leaves it; the trained context Ollama reports is taken, with its own first waits; a
 * verdict on an older context is ignored, and /api/ps read once any answer to that model at another context ran,
 * measured or not, is no measurement; an answer goes, and is measured, at the context noted as it was sent, and one
 * that ends after the figure has gone is not measured; Seen and the step up are as without growth; and without a
 * figure, in the chat format, for the operator's model and under ask provider ollama every body is today's, byte for
 * byte.
 * What breaks if it is removed? A change to the router could grow the model on a machine that gave no figure, keep a
 * model that does not fit, ask Ollama for a context that does not fit, or ask something off this machine, and nothing
 * in CI would say so.
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
 * How /api/generate answers for a model: a done line with `tokens` written in `ns` nanoseconds (absent: no timing)
 * and `reason` as its done_reason ('stop' unless said), the first line `delayMs` late, and Ollama's 500 for a context
 * above `refuseAbove`; a hang until the request is cut off; one piece and then nothing; one piece and then Ollama's
 * error line; or Ollama's 500.
 */
type Writes = { readonly tokens?: number; readonly ns?: number; readonly delayMs?: number; readonly reason?: string; readonly refuseAbove?: number } | 'hang' | 'stall' | 'broke' | 500
/**
 * Where /api/ps says a model is loaded: its bytes in all and on the GPU. With `kv` (bytes per 8,192 tokens of context)
 * it also says the context the model was last asked for, capped at `trained`, as context_length, as Ollama v0.10.0
 * and later do; its size grows by `kv` for each 8,192 tokens over 8,192, and `vram` is then what the GPU holds of it
 * at most (so a size above it is split).
 */
interface Placed { readonly size: number; readonly vram: number; readonly kv?: number; readonly trained?: number }
/** One request the page made: its address, how it was sent, the model a body named, and its body as sent. */
interface Call { readonly url: string; readonly mode?: string; readonly model?: string; readonly body?: string }

/**
 * A fake machine: Ollama on :11434 (its list with sizes and capabilities, /api/generate, /api/ps, /api/version, and
 * the chat format), nothing listening on any other port (:8080, :1234, :8089). Every request is noted. `hold` keeps
 * /api/ps waiting; `psFails` makes the next /api/ps requests answer 500; `psHang` makes /api/ps never answer (until
 * the request is cut off); `down` takes Ollama away. Each /api/generate, and each answer in the chat format, takes the
 * next entry of `holds` (none left, or null: it answers at once) and answers, as `writes` then says, only once that
 * resolves. An answer in the chat format sends no context, so Ollama loads the model at one of its own (4,096 here).
 */
function machine(o: { models: Listed[]; ps?: Record<string, Placed>; writes?: Record<string, Writes> }) {
  const state: { models: Listed[]; ps: Record<string, Placed>; writes: Record<string, Writes>; hold: Promise<void> | null; down: boolean; psFails: number; psHang: boolean; ctx: Record<string, number>; holds: (Promise<void> | null)[] } = { models: o.models, ps: o.ps ?? {}, writes: o.writes ?? {}, hold: null, down: false, psFails: 0, psHang: false, ctx: {}, holds: [] }
  const calls: Call[] = []
  const generate = (model: string, signal: AbortSignal | undefined, numCtx: number): Promise<Response> | Response => {
    const w = state.writes[model] ?? {}
    if (w === 500 || (typeof w === 'object' && w.refuseAbove !== undefined && numCtx > w.refuseAbove)) return json({ error: 'model requires more system memory (12.0 GiB) than is available (8.0 GiB)' }, 500)
    // Loaded at the context asked for (Ollama loads the model again for another one).
    state.ctx[model] = numCtx
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
    const done = { done: true, done_reason: w.reason ?? 'stop', eval_count: w.tokens ?? 3, ...(w.ns !== undefined && { eval_duration: w.ns }) }
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
    const body = init?.body ? (JSON.parse(String(init.body)) as { model?: string; options?: { num_ctx?: number } }) : null
    calls.push({ url, ...(init?.mode !== undefined && { mode: init.mode }), ...(body?.model !== undefined && { model: body.model }), ...(init?.body !== undefined && { body: String(init.body) }) })
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
      return json({
        models: Object.entries(state.ps).map(([name, p]) => {
          if (p.kv === undefined) return { name, model: name, size: p.size, size_vram: p.vram }
          const ctx = Math.min(state.ctx[name] ?? 8192, p.trained ?? Infinity)
          const size = p.size + Math.round(p.kv * (ctx - 8192) / 8192)
          return { name, model: name, size, size_vram: Math.min(size, p.vram), context_length: ctx }
        }),
      })
    }
    if (u.pathname === '/api/generate') {
      const held = state.holds.shift()
      if (held) await held
      return generate(body?.model ?? '', signal, body?.options?.num_ctx ?? 0)
    }
    if (u.pathname === '/v1/models') return json({ data: state.models.map((m) => ({ id: m.name })) })
    if (u.pathname === '/v1/chat/completions') {
      const held = state.holds.shift()
      if (held) await held
      if (body?.model !== undefined) state.ctx[body.model] = 4096
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
const make = (m: Fake, o: { vram?: string | null; appVram?: () => number | null; store?: ReturnType<typeof memory>; timeouts?: Timeouts | undefined; lookMs?: number; inPage?: () => Mind } = {}): MindRouter =>
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

test('the Windows app\'s figure: used when neither the console nor the address gives one, read at each ask (so a reading that arrives late counts), and never kept', async () => {
  const m = machine({ models: [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)] })
  const store = memory()
  // Nothing read yet (the shell has not answered): today's pick, and no fit row.
  let reading: number | null = null
  const r = make(m, { appVram: () => reading, store })
  assert.equal(await ask(r), 'deepseek-r1:671b says hi')
  assert.equal(r.settings().fit, undefined)
  // The reading arrives: the next ask is sized by it, and the row says where it came from.
  reading = 318.5
  assert.equal(await ask(r), 'qwen3:235b says hi')
  await settle()
  assert.equal(r.settings().fit, "318.5 GB read from the GPUs by the Windows app; deepseek-r1:671b has 376.3 GB of weights alone, more than the GPU's 318.5 GB; auto answers with qwen3:235b, the largest smaller one Ollama lists (ask model <name> keeps another); ask vram auto measures afresh")
  assert.equal(fitOf(store)?.vram, null, 'the app\'s figure is read afresh each visit, never kept as the console\'s')
  // ask vram auto names it; ask vram 0 turns it off; a console figure beats it.
  assert.equal(r.setVram('auto'), 'auto: 318.5 GB read from the GPUs by the Windows app; what was measured before is forgotten')
  assert.equal(r.setVram('0'), "0: auto sizes nothing by the GPU, whatever the page's address or the Windows app says; what was measured before is forgotten (ask vram auto hands it back)")
  assert.equal(await ask(r), 'deepseek-r1:671b says hi')
  r.setVram('8')
  assert.match(r.settings().fit ?? '', /^8\.0 GB given at the console \(ask vram\); /)
  // The address beats it.
  const a = make(machine({ models: [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9)] }), { vram: '500', appVram: () => 318.5 })
  assert.equal(await ask(a), 'deepseek-r1:671b says hi', '500 GB from the address: the 404 GB model fits by its weights')
  assert.match(a.settings().fit ?? '', /^500\.0 GB given by the page's address \(vram=\); /)
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
  assert.equal(r.setVram('0'), "0: auto sizes nothing by the GPU, whatever the page's address or the Windows app says; what was measured before is forgotten (ask vram auto hands it back)")
  assert.equal(r.settings().model, 'deepseek-r1:671b')
  assert.equal(r.settings().fit, "off at the console (ask vram 0): auto keeps its usual model (ask vram auto hands sizing back to the page's address or the Windows app)")
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

// ---------------------------------------------------------------- the context and the answer cap (R1-R7)

/** The context and answer cap each /api/generate body asked for, as `num_ctx/num_predict`, in order. */
const bodies = (m: Fake): string[] => m.calls.filter((c) => c.url.endsWith('/api/generate')).map((c) => {
  const o = (JSON.parse(c.body ?? '{}') as { options?: { num_ctx?: number; num_predict?: number } }).options
  return `${o?.num_ctx}/${o?.num_predict}`
})
/** How every generate body has ended since before slice 4: today's context and answer cap, byte for byte. */
const TODAY = ',"options":{"num_ctx":8192,"num_predict":2048}}'
/** An answer cut at its answer cap: 2,048 tokens in 50 s (41.0 a second, room for 4,096 in 100 s). */
const CUT = { tokens: 2048, ns: 50e9, reason: 'length' } as const
/** The same answer, finished. */
const WHOLE = { tokens: 2048, ns: 50e9 } as const
/** One model on a 24 GB figure: 5 GB loaded at 8,192 tokens, 1 GB more for each 8,192 more, all of it on the GPU. */
const ONE = (writes: Writes = CUT, placed: Partial<Placed> = {}): Fake => machine({ models: [L('gemma3:1b', 1e9), L(DEFAULT_MODEL, 3.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 20e9, kv: 1e9, ...placed } }, writes: { [DEFAULT_MODEL]: writes } })
const ROW = "24.0 GB given by the page's address (vram=); qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.0 tokens a second; nothing bigger that Ollama lists fits by what was measured, so auto keeps qwen3-vl:4b"

test('a cut answer on a model measured all on the GPU doubles its context and answer cap once this visit; the first answer there is measured; Seen and the model stay as they were', async () => {
  const m = ONE()
  const store = memory()
  const r = make(m, { vram: '24', store })
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 1)
  const seen = fitOf(store)?.seen
  assert.deepEqual(seen, [{ server: DEFAULT_SERVER, model: DEFAULT_MODEL, weights: 3.3e9, loaded: 5e9, gpu: 5e9, pace: 40.96, fails: 0 }])
  assert.equal(r.settings().fit, `${ROW}; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured`)
  // The next answer asks for twice the context and four times its quarter, and is measured there (its own key).
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 2)
  assert.equal(r.settings().fit, `${ROW}; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 (measured 5.6 GB loaded at that context, all on the GPU)`)
  // Cut again: once a visit, so it stays, and a model measured there is not asked again.
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await settle()
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '16384/4096'])
  assert.equal(looks(m), 2, 'one /api/ps for the first answer, one for the first at the larger context')
  assert.deepEqual(sent(m), [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL], 'the model never moved')
  assert.deepEqual(fitOf(store)?.seen, seen, 'only a measurement at 8,192 is kept: Seen is as it was')
  assert.ok(!('wide' in (fitOf(store) ?? {})), 'nothing of the context is kept between visits')
  // A new visit on the same store starts at 8,192 again.
  const next = ONE(WHOLE)
  const n = make(next, { vram: '24', store })
  await ask(n)
  await ask(n)
  assert.deepEqual(bodies(next), ['8192/2048', '8192/2048'])
})

test('the gate: no figure, the chat format, the operator\'s model and ask provider ollama send today\'s bodies byte for byte, and ask Ollama nothing more than a finished answer would', async () => {
  /** The requests a run made, the bodies as sent. */
  const trail = (m: Fake): string[] => m.calls.map((c) => `${c.url} ${c.body ?? ''}`)
  const runs: [string, (r: MindRouter) => Promise<void>, { vram?: string }][] = [
    ['no figure', async (r) => { for (let i = 0; i < 3; i++) await ask(r) }, {}],
    ['the chat format', async (r) => { await r.installed(); r.setApi?.('chat'); for (let i = 0; i < 3; i++) await ask(r) }, { vram: '24' }],
    ["the operator's model", async (r) => { await r.installed(); r.setModel(DEFAULT_MODEL); for (let i = 0; i < 3; i++) { await ask(r); await settle() } }, { vram: '24' }],
    ['ask provider ollama', async (r) => { r.setProvider('ollama'); for (let i = 0; i < 3; i++) await ask(r) }, { vram: '24' }],
  ]
  for (const [what, run, o] of runs) {
    const cut = ONE(CUT)
    await run(make(cut, o))
    await settle()
    const whole = ONE(WHOLE)
    await run(make(whole, o))
    await settle()
    assert.deepEqual(trail(cut), trail(whole), `${what}: the same requests, byte for byte, as answers that were not cut`)
    const gen = cut.calls.filter((c) => c.url.endsWith('/api/generate'))
    for (const c of gen) assert.ok(c.body?.endsWith(TODAY), `${what}: ${c.body?.slice(-60)}`)
    for (const c of cut.calls.filter((x) => x.url.endsWith('/v1/chat/completions'))) assert.match(c.body ?? '', /"max_tokens":2048,/, what)
  }
  // A figure that goes away (the Windows app's reading, read at each ask): today's body at once, though it grew.
  let reading: number | null = 24
  const app = ONE(CUT)
  const a = make(app, { appVram: () => reading })
  await ask(a)
  await measured(app, 1)
  reading = null
  await ask(a)
  assert.deepEqual(bodies(app), ['8192/2048', '8192/2048'])
  // No figure: no /api/ps at all.
  const none = ONE(CUT)
  const r = make(none)
  for (let i = 0; i < 3; i++) await ask(r)
  await settle()
  assert.equal(looks(none), 0)
  assert.deepEqual(bodies(none), ['8192/2048', '8192/2048', '8192/2048'])
})

test("grown, then the operator chooses the model: today's body while it is theirs; ask model auto gives the grown context back", async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  r.setModel(DEFAULT_MODEL)
  await ask(r)
  assert.match(r.settings().fit ?? '', /the model is yours \(ask model chose it\)/)
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/, 'no context clause for a model auto did not choose')
  assert.equal(r.setModel('auto'), `auto: auto chooses the Ollama model again (${DEFAULT_MODEL} now)`)
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096'])
})

test('room: the bytes loaded plus what doubling costs must fit the figure less 2 GiB; exactly at it grows, one byte over does not', async () => {
  const GIB = 2 ** 30
  const room = async (weights: number): Promise<string[]> => {
    // 12 GiB loaded for these weights: doubling costs 12 GiB less the weights, and the figure of 24 leaves 22 GiB.
    const m = machine({ models: [L(DEFAULT_MODEL, weights)], ps: { [DEFAULT_MODEL]: { size: 12 * GIB, vram: 40 * GIB, kv: 1e9 } }, writes: { [DEFAULT_MODEL]: CUT } })
    const r = make(m, { vram: '24' })
    await ask(r)
    await measured(m, 1)
    await ask(r)
    return bodies(m)
  }
  assert.deepEqual(await room(2 * GIB), ['8192/2048', '16384/4096'], '12 + 10 = 22 GiB: exactly at the budget')
  assert.deepEqual(await room(2 * GIB - 1), ['8192/2048', '8192/2048'], 'one byte over')
})

test('a larger context that splits, runs slower than 5 tokens a second over 32, or that Ollama will not load goes back for the visit; the model is never set aside', async () => {
  // Split: the GPU holds 5.5 GB of it, and it takes 6 GB at 16,384.
  const m = ONE(CUT, { vram: 5.5e9 })
  const store = memory()
  const r = make(m, { vram: '24', store })
  await ask(r)
  await measured(m, 1)
  const seen = fitOf(store)?.seen
  await ask(r)
  await measured(m, 2)
  assert.equal(r.settings().fit, `${ROW}; 16,384 tokens of context did not fit the GPU (some of it ran on the processor), so qwen3-vl:4b stays at 8,192 for this visit`)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'not gemma3:1b: the model was not set aside')
  await ask(r)
  await settle()
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048', '8192/2048'], 'back, and not grown again this visit')
  assert.deepEqual(fitOf(store)?.seen, seen, 'Seen untouched')
  assert.doesNotMatch(r.settings().fit ?? '', /measures afresh/, 'nothing avoided')
  // All on the processor at 16,384.
  const cpu = ONE(CUT)
  const c = make(cpu, { vram: '24' })
  await ask(c)
  await measured(cpu, 1)
  cpu.state.ps[DEFAULT_MODEL] = { size: 5e9, vram: 0, kv: 1e9 }
  await ask(c)
  await measured(cpu, 2)
  assert.match(c.settings().fit ?? '', /; 16,384 tokens of context did not fit the GPU \(all of it ran on the processor\), so qwen3-vl:4b stays at 8,192 for this visit$/)
  // The pace at the larger context: 4.99 a second over 499 tokens goes back; 5.00 over 500 stays.
  for (const [tokens, want] of [[499, /; 16,384 tokens of context was too slow here, so qwen3-vl:4b stays at 8,192 for this visit$/], [500, /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\)$/]] as const) {
    const p = ONE(CUT)
    const x = make(p, { vram: '24' })
    await ask(x)
    await measured(p, 1)
    p.state.writes[DEFAULT_MODEL] = { tokens, ns: 100e9 }
    await ask(x)
    await measured(p, 2)
    assert.match(x.settings().fit ?? '', want, String(tokens))
    await ask(x)
    assert.equal(bodies(p).at(-1), tokens === 499 ? '8192/2048' : '16384/4096', String(tokens))
  }
})

test('a larger context Ollama will not load: the same ask is answered once more at 8,192, the model stays, and that is the ask\'s one retry', async () => {
  const m = ONE({ ...CUT, refuseAbove: 8192 })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'answered within the one ask')
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048'])
  assert.deepEqual(sent(m), [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL])
  await settle()
  assert.equal(r.settings().fit, `${ROW}; 16,384 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit`)
  // A model auto moved, which R8 would answer again with the next one down: the context's retry comes first, once,
  // and its failure is the ask's (no R8 after it, and no look).
  const models = (): Listed[] => [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)]
  const moved = machine({ models: models(), ps: { 'qwen3:235b': { size: 150e9, vram: 400e9, kv: 8e9 } }, writes: { 'qwen3:235b': CUT } })
  const x = make(moved, { vram: '318.5' })
  assert.equal(await ask(x), 'qwen3:235b says hi')
  await measured(moved, 1)
  moved.state.writes['qwen3:235b'] = 500
  const before = moved.calls.length
  await assert.rejects(ask(x), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(moved.calls.slice(before).map((c) => `${new URL(c.url).pathname} ${c.model ?? ''}`.trim()), ['/api/generate qwen3:235b', '/api/generate qwen3:235b'], 'two answers in the ask, at 16,384 then 8,192: no R8, no look')
  assert.deepEqual(bodies(moved), ['8192/2048', '16384/4096', '8192/2048'])
  // Back at 8,192, the next ask is R8's as before: the moved model is set aside and the next one down answers.
  assert.equal(await ask(x), 'qwen3:8b says hi')
  assert.deepEqual(sent(moved), ['qwen3:235b', 'qwen3:235b', 'qwen3:235b', 'qwen3:235b', 'qwen3:8b'])
})

test('Ollama runs it at its trained context: 12,288 is used (answers of up to 3,072) and measured; 8,192 goes back; neither grows again', async () => {
  const m = ONE(CUT, { trained: 12288 })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  await ask(r)
  await measured(m, 2)
  assert.equal(r.settings().fit, `${ROW}; qwen3-vl:4b was trained on 12,288 tokens of context, so it runs at that with answers of up to 3,072`)
  await ask(r)
  await measured(m, 3)
  assert.equal(r.settings().fit, `${ROW}; qwen3-vl:4b was trained on 12,288 tokens of context, so it runs at that with answers of up to 3,072 (measured 5.1 GB loaded at that context, all on the GPU)`)
  await ask(r)
  await settle()
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '12288/3072', '12288/3072'])
  assert.equal(looks(m), 3)
  // Trained on 8,192 (as Llama 3 was): back, and the row says why.
  const t = ONE(CUT, { trained: 8192 })
  const x = make(t, { vram: '24' })
  await ask(x)
  await measured(t, 1)
  await ask(x)
  await measured(t, 2)
  await ask(x)
  assert.deepEqual(bodies(t), ['8192/2048', '16384/4096', '8192/2048'])
  assert.equal(x.settings().fit, `${ROW}; qwen3-vl:4b was trained on 8,192 tokens of context, so it stays at 8,192 for this visit`)
})

test('nothing grows without a measured context_length, on a model split at 8,192, on an answer not cut, or on one too slow for the larger answer', async () => {
  const cases: [string, Fake][] = [
    ['an Ollama that does not say context_length', machine({ models: [L(DEFAULT_MODEL, 3.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 5e9 } }, writes: { [DEFAULT_MODEL]: CUT } })],
    ['split at 8,192', ONE(CUT, { vram: 4e9 })],
    ['not cut', ONE(WHOLE)],
    // 2,048 tokens in 160 s: 12.8 a second, under the 13.65 that writes 4,096 in 300 s.
    ['too slow for 4,096', ONE({ tokens: 2048, ns: 160e9, reason: 'length' })],
  ]
  for (const [what, m] of cases) {
    const r = make(m, { vram: '24' })
    for (let i = 0; i < 3; i++) { await ask(r); await settle() }
    assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048'], what)
    assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/, what)
  }
})

test('the step up is decided by measurements at 8,192 alone: the same models and the same Seen with the context grown as without', async () => {
  // Visit one at 15 GB: the 14b's need by the 4b's ratio (14.1e9) does not fit 13 GiB, so the 4b settles and grows; at
  // 16,384 it takes 8 GB. Visit two at 18 GB: by the ratio measured at 8,192 the 14b fits 16 GiB, and is chosen.
  const run = async (writes: Writes): Promise<{ sent: (string | undefined)[]; bodies: string[]; seen: unknown }> => {
    const m = machine({ models: [L(DEFAULT_MODEL, 3.3e9), L('qwen3:14b', 9.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 40e9, kv: 3e9 }, 'qwen3:14b': { size: 14e9, vram: 40e9 } }, writes: { [DEFAULT_MODEL]: writes, 'qwen3:14b': WHOLE } })
    const store = memory()
    const one = make(m, { vram: '15', store })
    for (let i = 0; i < 3; i++) { await ask(one); await settle() }
    const two = make(m, { vram: '18', store })
    for (let i = 0; i < 2; i++) { await ask(two); await settle() }
    return { sent: sent(m), bodies: bodies(m), seen: fitOf(store)?.seen }
  }
  const grown = await run(CUT)
  const plain = await run(WHOLE)
  assert.deepEqual(grown.bodies, ['8192/2048', '16384/4096', '16384/4096', '8192/2048', '8192/2048'], 'it grew in visit one')
  assert.deepEqual(plain.bodies, ['8192/2048', '8192/2048', '8192/2048', '8192/2048', '8192/2048'])
  assert.deepEqual(grown.sent, [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, 'qwen3:14b', 'qwen3:14b'])
  assert.deepEqual(grown.sent, plain.sent)
  assert.deepEqual(grown.seen, plain.seen)
})

test('ask vram forgets a grown context with what was measured: the next answer is at 8,192 and measured afresh', async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  await ask(r)
  await measured(m, 2)
  assert.match(r.settings().fit ?? '', /runs at 16,384 tokens of context/)
  r.setVram('24')
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/)
  await ask(r)
  await measured(m, 3)
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048', '16384/4096'], 'grown again once measured: ask vram starts the visit over')
})

test('a settings change between the cut and the decision means no growth', async () => {
  const m = ONE()
  const r = make(m, { vram: '24', lookMs: 5000 })
  let release = (): void => {}
  m.state.hold = new Promise<void>((done) => { release = done })
  await ask(r)
  await until(() => looks(m) === 1)
  r.setApi?.('generate')
  release()
  m.state.hold = null
  await settle()
  await ask(r)
  assert.equal(bodies(m)[1], '8192/2048')
})

test('a first wait that runs out at the larger context: whole on the GPU is no verdict; nothing loaded twice goes back; split goes back at once', async () => {
  // Small enough that the first waits stay the client's 50 ms; a figure of 3.1 GB leaves 1.1 GiB, room for 1 GiB more.
  const small = (): Fake => machine({ models: [L(DEFAULT_MODEL, 4e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 1e9, kv: 1e6 } }, writes: { [DEFAULT_MODEL]: CUT } })
  const m = small()
  const r = make(m, { vram: '3.1' })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = 'hang'
  await assert.rejects(ask(r), timedOut)
  await measured(m, 2)
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/, 'whole on the GPU: still loading, no verdict')
  delete m.state.ps[DEFAULT_MODEL]
  await assert.rejects(ask(r), timedOut)
  await measured(m, 3)
  await assert.rejects(ask(r), timedOut)
  await measured(m, 4)
  assert.match(r.settings().fit ?? '', /; 16,384 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit$/)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '16384/4096', '16384/4096'])
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  assert.equal(bodies(m).at(-1), '8192/2048')
  // Split when the first wait ran out: back at once.
  const s = small()
  const x = make(s, { vram: '3.1' })
  await ask(x)
  await measured(s, 1)
  s.state.writes[DEFAULT_MODEL] = 'hang'
  s.state.ps[DEFAULT_MODEL] = { size: 5e6, vram: 5.5e6, kv: 1e6 }
  await assert.rejects(ask(x), timedOut)
  await measured(s, 2)
  assert.match(x.settings().fit ?? '', /; 16,384 tokens of context did not fit the GPU \(some of it ran on the processor\), so qwen3-vl:4b stays at 8,192 for this visit$/)
})

test('the model is settled first: a cut answer whose measurement steps up to a bigger model grows nothing, and the model it left is at 8,192 when it comes back', async () => {
  const m = machine({ models: [L(DEFAULT_MODEL, 3.3e9), L('qwen3:14b', 9.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 40e9, kv: 1e9 }, 'qwen3:14b': { size: 14e9, vram: 14e9 } }, writes: { [DEFAULT_MODEL]: CUT, 'qwen3:14b': SLOW } })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  assert.equal(r.settings().model, 'qwen3:14b', 'stepped up on that measurement')
  await ask(r)
  await measured(m, 2)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'the 14b was too slow: back to the 4b')
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048'])
})

/** A promise and the call that resolves it: a /api/generate held (machine `holds`) until the test lets it answer. */
const latch = (): { held: Promise<void>; open: () => void } => {
  let open = (): void => {}
  const held = new Promise<void>((done) => { open = done })
  return { held, open }
}

test('a larger context that fails after some of its answer arrived goes back for the visit with no retry: the text shown is never written twice', async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = 'broke'
  const pieces: string[] = []
  await assert.rejects(r.answer(req(), (p) => { pieces.push(p.text) }), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(pieces, [`${DEFAULT_MODEL} says hi`], 'shown once')
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096'], 'one answer in that ask: no retry')
  await settle()
  assert.equal(r.settings().fit, `${ROW}; 16,384 tokens of context failed partway through an answer in Ollama, so qwen3-vl:4b stays at 8,192 for this visit`)
  m.state.writes[DEFAULT_MODEL] = CUT
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'the model was not set aside')
  await settle()
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048', '8192/2048'], 'back, and not grown again this visit')
  assert.equal(looks(m), 1, 'nothing more to measure')
})

test('the same ask answered once more at 8,192 is measured there, under the model it was sent to; a settings change while it runs drops that measurement', async () => {
  // Refused at 16,384; the answer at 8,192 is slow (2 tokens a second), so it is measured though 8,192 was.
  const m = ONE()
  const store = memory()
  const r = make(m, { vram: '24', store })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = { ...SLOW, refuseAbove: 8192 }
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await measured(m, 2)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048'])
  assert.deepEqual(fitOf(store)?.seen.map((s) => [s.model, s.pace]), [[DEFAULT_MODEL, 2]], 'measured at 8,192, so kept as Seen, with its own pace')
  // The operator chooses another model while the answer at 8,192 runs: its measurement is dropped, not taken as
  // gemma3:1b's placement at qwen3-vl:4b's pace.
  const x = ONE()
  x.state.ps['gemma3:1b'] = { size: 1.5e9, vram: 1.5e9 }
  const kept = memory()
  const y = make(x, { vram: '24', store: kept })
  await ask(y)
  await measured(x, 1)
  x.state.writes[DEFAULT_MODEL] = { ...SLOW, refuseAbove: 8192 }
  const { held, open } = latch()
  x.state.holds = [null, held]
  const asked = ask(y)
  await until(() => bodies(x).length === 3)
  y.setModel('gemma3:1b')
  open()
  assert.equal(await asked, `${DEFAULT_MODEL} says hi`)
  await settle()
  assert.equal(looks(x), 1, 'not measured')
  assert.deepEqual(fitOf(kept)?.seen.map((s) => [s.model, s.pace]), [[DEFAULT_MODEL, 40.96]])
})

test('a settings change while the larger context is refused or fails partway: no retry, the failure is the answer, and the context goes back all the same', async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = { ...CUT, refuseAbove: 8192 }
  const { held, open } = latch()
  m.state.holds = [held]
  const asked = ask(r)
  await until(() => bodies(m).length === 2)
  r.setApi?.('generate')
  open()
  await assert.rejects(asked, (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096'])
  assert.equal(r.settings().fit, `${ROW}; 16,384 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit`)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048'], 'not sent at 16,384 again')
  // Some of the answer arrives, then Ollama's error, after ask provider auto: back too, and the next answer at 8,192.
  const p = ONE()
  const x = make(p, { vram: '24' })
  await ask(x)
  await measured(p, 1)
  p.state.writes[DEFAULT_MODEL] = 'broke'
  const two = latch()
  p.state.holds = [two.held]
  const broke = ask(x)
  await until(() => bodies(p).length === 2)
  x.setProvider('auto')
  two.open()
  await assert.rejects(broke, (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.equal(x.settings().fit, `${ROW}; 16,384 tokens of context failed partway through an answer in Ollama, so qwen3-vl:4b stays at 8,192 for this visit`)
  p.state.writes[DEFAULT_MODEL] = CUT
  assert.equal(await ask(x), `${DEFAULT_MODEL} says hi`)
  assert.deepEqual(bodies(p), ['8192/2048', '16384/4096', '8192/2048'])
  // ask vram while the larger context is refused: it already forgot the grown context, so the refusal is the answer.
  const q = ONE()
  const y = make(q, { vram: '24' })
  await ask(y)
  await measured(q, 1)
  q.state.writes[DEFAULT_MODEL] = { ...CUT, refuseAbove: 8192 }
  const three = latch()
  q.state.holds = [three.held]
  const refused = ask(y)
  await until(() => bodies(q).length === 2)
  y.setVram('24')
  three.open()
  await assert.rejects(refused, (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.doesNotMatch(y.settings().fit ?? '', /tokens of context/)
  assert.equal(await ask(y), `${DEFAULT_MODEL} says hi`)
  assert.deepEqual(bodies(q), ['8192/2048', '16384/4096', '8192/2048'])
})

test('a moved model whose larger context Ollama refuses after a settings change is not set aside: no answer from the next model down, and its next answer at 8,192', async () => {
  const models = (): Listed[] => [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)]
  const moved = machine({ models: models(), ps: { 'qwen3:235b': { size: 150e9, vram: 400e9, kv: 8e9 }, 'qwen3:8b': { size: 6e9, vram: 6e9 } }, writes: { 'qwen3:235b': CUT, 'qwen3:8b': QUICK } })
  const x = make(moved, { vram: '318.5' })
  assert.equal(await ask(x), 'qwen3:235b says hi')
  await measured(moved, 1)
  assert.match(x.settings().fit ?? '', /so qwen3:235b gets 16,384 tokens of context/)
  moved.state.writes['qwen3:235b'] = { ...CUT, refuseAbove: 8192 }
  const { held, open } = latch()
  moved.state.holds = [held]
  const asked = ask(x)
  await until(() => bodies(moved).length === 2)
  x.setApi?.('generate')
  open()
  await assert.rejects(asked, (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(sent(moved), ['qwen3:235b', 'qwen3:235b'], "no answer from qwen3:8b: the context's failure is not the model's")
  // Still auto's pick (deepseek-r1:671b is too big for the figure, as before), with the context back.
  assert.equal(x.settings().fit, "318.5 GB given by the page's address (vram=); deepseek-r1:671b has 376.3 GB of weights alone, more than the GPU's 318.5 GB; qwen3:235b measured 139.7 GB loaded, all on the GPU, 41.0 tokens a second; auto answers with qwen3:235b, the largest smaller one Ollama lists (ask model <name> keeps another); 16,384 tokens of context would not load in Ollama, so qwen3:235b stays at 8,192 for this visit; ask vram auto measures afresh")
  assert.equal(await ask(x), 'qwen3:235b says hi')
  assert.deepEqual(bodies(moved), ['8192/2048', '16384/4096', '8192/2048'])
})

test('the answer R8 gives once more: a settings change while it runs drops its measurement', async () => {
  const m = machine({ models: [L('deepseek-r1:671b', 404e9), L('qwen3:235b', 142e9), L('qwen3:8b', 5.2e9)], ps: { 'qwen3:8b': { size: 6e9, vram: 6e9 } }, writes: { 'qwen3:235b': 500, 'qwen3:8b': QUICK } })
  const store = memory()
  const r = make(m, { vram: '318.5', store })
  const { held, open } = latch()
  m.state.holds = [null, held]
  const asked = ask(r)
  await until(() => sent(m).length === 2)
  r.setApi?.('generate')
  open()
  assert.equal(await asked, 'qwen3:8b says hi')
  await settle()
  assert.equal(looks(m), 0)
  assert.deepEqual(fitOf(store)?.seen, [])
})

test("grown, then ask provider ollama: today's body byte for byte; back under auto, the grown context", async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  r.setProvider('ollama')
  await ask(r)
  r.setProvider('auto')
  await ask(r)
  const gen = m.calls.filter((c) => c.url.endsWith('/api/generate'))
  assert.ok(gen[1].body?.endsWith(TODAY), gen[1].body?.slice(-60))
  assert.equal(gen[1].body, gen[0].body, 'byte for byte the body sent before it grew')
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096'])
})

test("a cut answer on the operator's own model grows nothing that ask model auto then uses", async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await r.installed()
  r.setModel(DEFAULT_MODEL)
  await ask(r)
  await measured(m, 1)
  assert.equal(r.setModel('auto'), `auto: auto chooses the Ollama model again (${DEFAULT_MODEL} now)`)
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/)
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048'])
})

test('ask vram forgets what was measured at each context and a trained context learned: a cut answer after it grows only on a fresh measurement', async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  await ask(r)
  await measured(m, 2)
  r.setVram('24')
  // The measurement after the next answer fails: nothing measured at 8,192 since ask vram, so nothing grows.
  m.state.psFails = 1
  await ask(r)
  await measured(m, 3)
  await ask(r)
  await measured(m, 4)
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048', '8192/2048', '16384/4096'], 'grown again once measured afresh')
  // A trained context learned (12,288) is forgotten too.
  const t = ONE(CUT, { trained: 12288 })
  const x = make(t, { vram: '24' })
  await ask(x)
  await measured(t, 1)
  await ask(x)
  await measured(t, 2)
  assert.match(x.settings().fit ?? '', /was trained on 12,288 tokens of context/)
  x.setVram('24')
  assert.doesNotMatch(x.settings().fit ?? '', /tokens of context/)
  await ask(x)
  assert.deepEqual(bodies(t), ['8192/2048', '16384/4096', '8192/2048'])
})

test('ask vram gives a larger context one more chance again after a first wait with nothing loaded', async () => {
  const placed: Placed = { size: 5e6, vram: 1e9, kv: 1e6 }
  const m = machine({ models: [L(DEFAULT_MODEL, 4e6)], ps: { [DEFAULT_MODEL]: placed }, writes: { [DEFAULT_MODEL]: CUT } })
  const r = make(m, { vram: '3.1' })
  const nothingLoaded = async (n: number): Promise<void> => {
    delete m.state.ps[DEFAULT_MODEL]
    m.state.writes[DEFAULT_MODEL] = 'hang'
    await assert.rejects(ask(r), timedOut)
    await measured(m, n)
  }
  await ask(r)
  await measured(m, 1)
  await nothingLoaded(2)
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/, 'one more chance')
  r.setVram('3.1')
  m.state.ps[DEFAULT_MODEL] = placed
  m.state.writes[DEFAULT_MODEL] = CUT
  await ask(r)
  await measured(m, 3)
  await nothingLoaded(4)
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/, 'one more chance again, as at the start of the visit')
  await nothingLoaded(5)
  assert.match(r.settings().fit ?? '', /; 16,384 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit$/)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048', '16384/4096', '16384/4096'])
})

test('a verdict on an answer sent at an older context is ignored, and a placement read while an answer at another context is under way says nothing', async () => {
  const m = ONE(CUT, { trained: 12288 })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  // Two asks at 16,384 held while a third at 16,384 learns the trained context.
  const one = latch(); const two = latch()
  m.state.holds = [one.held, two.held]
  const quick = ask(r)
  await until(() => bodies(m).length === 2)
  const broke = ask(r)
  await until(() => bodies(m).length === 3)
  await ask(r)
  await measured(m, 2)
  const learned = `${ROW}; qwen3-vl:4b was trained on 12,288 tokens of context, so it runs at that with answers of up to 3,072`
  assert.equal(r.settings().fit, learned)
  // The first held answer lands and is measured: at 16,384 it says nothing of 12,288.
  one.open()
  await quick
  await measured(m, 3)
  assert.equal(r.settings().fit, learned, 'a measurement of 16,384')
  // An answer at 12,288 while the second is still under way at 16,384: Ollama may load the model again for that one.
  await ask(r)
  await measured(m, 4)
  assert.equal(r.settings().fit, learned, 'read while an answer at 16,384 was under way')
  // The second fails after its first piece: nor does that say anything of 12,288.
  m.state.writes[DEFAULT_MODEL] = 'broke'
  two.open()
  await assert.rejects(broke, (e: unknown) => e instanceof CognitionError && e.code === 'server')
  await settle()
  assert.equal(r.settings().fit, learned, 'a failure at 16,384')
  // Nothing at another context since: the next answer at 12,288 is measured, and it holds.
  m.state.writes[DEFAULT_MODEL] = CUT
  await ask(r)
  await measured(m, 5)
  assert.equal(r.settings().fit, `${learned} (measured 5.1 GB loaded at that context, all on the GPU)`)
  await ask(r)
  await settle()
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '16384/4096', '16384/4096', '12288/3072', '12288/3072', '12288/3072'])
  assert.equal(looks(m), 5)
})

test('a cut answer on a model already measured at 8,192 this visit grows it too, with no measurement of its own', async () => {
  const m = ONE(WHOLE)
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = CUT
  await ask(r)
  await settle()
  assert.equal(looks(m), 1, 'quick, and measured at 8,192 this visit: not measured again')
  assert.equal(r.settings().fit, `${ROW}; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured`)
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096'])
})

test('nothing loaded after answers at the larger context whose first waits did not run out says nothing, however often', async () => {
  // As with OLLAMA_KEEP_ALIVE=0, which unloads the model as each answer ends.
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  const placed = m.state.ps[DEFAULT_MODEL]
  delete m.state.ps[DEFAULT_MODEL]
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  await measured(m, 2)
  await ask(r)
  await measured(m, 3)
  assert.equal(r.settings().fit, `${ROW}; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured`)
  m.state.ps[DEFAULT_MODEL] = placed
  await ask(r)
  await measured(m, 4)
  assert.match(r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\)$/)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '16384/4096', '16384/4096'])
})

test("a stop that lands with Ollama's refusal of the larger context learns nothing: no retry, and the context stays", async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = { ...CUT, refuseAbove: 8192 }
  const { held, open } = latch()
  m.state.holds = [held]
  const stop = new AbortController()
  const asked = r.answer({ ...req(), signal: stop.signal }, () => {})
  await until(() => bodies(m).length === 2)
  stop.abort()
  open()
  await assert.rejects(asked)
  await settle()
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096'], 'no retry')
  assert.equal(r.settings().fit, `${ROW}; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured`)
})

test("the moved model's retry goes to the next model at the context that model grew to; refused there or failing partway, that context goes back, unless a stop lands with it", async () => {
  /** The 4b grown and measured at 16,384; then the 14b is pulled and ask alone steps up to it; the 14b will not load. */
  const stepped = async (): Promise<{ m: Fake; r: MindRouter }> => {
    const m = ONE()
    const r = make(m, { vram: '24' })
    await ask(r)
    await measured(m, 1)
    await ask(r)
    await measured(m, 2)
    assert.match(r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context/)
    m.state.models.push(L('qwen3:14b', 9.3e9))
    m.state.writes['qwen3:14b'] = 500
    await r.installed()
    assert.equal(r.settings().model, 'qwen3:14b')
    m.state.writes[DEFAULT_MODEL] = { ...WHOLE, refuseAbove: 8192 }
    return { m, r }
  }
  const { m, r } = await stepped()
  await assert.rejects(ask(r), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(sent(m).slice(2), ['qwen3:14b', DEFAULT_MODEL])
  assert.deepEqual(bodies(m).slice(2), ['8192/2048', '16384/4096'], "R8's retry at the 4b's grown context")
  assert.equal(r.settings().fit, "24.0 GB given by the page's address (vram=); qwen3-vl:4b measured 4.7 GB loaded, all on the GPU, 41.0 tokens a second; auto keeps qwen3-vl:4b for the rest of this visit; 16,384 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit; ask vram auto measures afresh")
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  assert.equal(bodies(m).at(-1), '8192/2048', 'not sent at 16,384 again')
  // Failing after its first piece there: back as a failure partway, and that failure is the ask's.
  const b = await stepped()
  b.m.state.writes[DEFAULT_MODEL] = 'broke'
  await assert.rejects(ask(b.r), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(bodies(b.m).slice(2), ['8192/2048', '16384/4096'])
  assert.match(b.r.settings().fit ?? '', /; 16,384 tokens of context failed partway through an answer in Ollama, so qwen3-vl:4b stays at 8,192 for this visit; ask vram auto measures afresh$/)
  // A stop that lands with the refusal of that retry: nothing is learned.
  const s = await stepped()
  const { held, open } = latch()
  s.m.state.holds = [null, held]
  const stop = new AbortController()
  const asked = s.r.answer({ ...req(), signal: stop.signal }, () => {})
  await until(() => bodies(s.m).length === 4)
  stop.abort()
  open()
  await assert.rejects(asked)
  assert.match(s.r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\); ask vram auto measures afresh$/)
})

test('a placement read once an answer at another context may have made Ollama load the model again measures nothing: at 8,192 nothing is kept or set aside, above it there is no verdict', async () => {
  // Measured at 8,192. A cut answer grows the model while a second, sent at 8,192 before it grew, is held; that one
  // ends slow (so it is measured) after an answer at 16,384 that Ollama split: what /api/ps says then is that load.
  const m = ONE(WHOLE, { vram: 5.5e9 })
  const store = memory()
  const r = make(m, { vram: '24', store })
  await ask(r)
  await measured(m, 1)
  const seen = fitOf(store)?.seen
  m.state.writes[DEFAULT_MODEL] = CUT
  const one = latch(); const two = latch()
  m.state.holds = [one.held, two.held]
  const cut = ask(r)
  await until(() => bodies(m).length === 2)
  const late = ask(r)
  await until(() => bodies(m).length === 3)
  one.open()
  await cut
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/)
  m.state.writes[DEFAULT_MODEL] = { ...SLOW, delayMs: 100 }
  two.open()
  await new Promise((done) => setTimeout(done, 1))
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  await late
  await measured(m, 3)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048', '16384/4096'])
  assert.deepEqual(fitOf(store)?.seen, seen, 'the 16,384 load is not kept as a measurement at 8,192')
  assert.equal(r.settings().fit, `${ROW}; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured`)
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`, 'not set aside')
  await measured(m, 4)
  assert.equal(bodies(m).at(-1), '16384/4096')
  assert.match(r.settings().fit ?? '', /; 16,384 tokens of context did not fit the GPU \(some of it ran on the processor\), so qwen3-vl:4b stays at 8,192 for this visit$/)
  // An answer at 16,384 whose /api/ps is answered after one at 8,192, sent before the model grew, made Ollama load it
  // at 8,192 again: that is not the context the model was trained on.
  const j = ONE(WHOLE)
  const y = make(j, { vram: '24', lookMs: 5000 })
  const early = latch()
  j.state.holds = [early.held]
  const before = ask(y)
  await until(() => bodies(j).length === 1)
  j.state.writes[DEFAULT_MODEL] = CUT
  await ask(y)
  await measured(j, 1)
  let release = (): void => {}
  j.state.hold = new Promise<void>((done) => { release = done })
  j.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(y)
  await until(() => looks(j) === 2)
  early.open()
  await before
  release()
  j.state.hold = null
  await measured(j, 2)
  assert.equal(y.settings().fit, `${ROW}; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured`)
  await ask(y)
  await measured(j, 3)
  assert.match(y.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\)$/)
  assert.deepEqual(bodies(j), ['8192/2048', '8192/2048', '16384/4096', '16384/4096'])
})

test("the moved model's retry counts as an answer at its context: a measurement at 8,192 read after it went at 16,384 is not kept", async () => {
  const m = ONE(WHOLE)
  const store = memory()
  const r = make(m, { vram: '24', store, lookMs: 5000 })
  await ask(r)
  await measured(m, 1)
  const seen = fitOf(store)?.seen
  // An answer at 8,192 held; a cut one grows the model; then the 14b is pulled and ask alone steps up to it.
  const late = latch()
  m.state.holds = [late.held]
  const slow = ask(r)
  await until(() => bodies(m).length === 2)
  m.state.writes[DEFAULT_MODEL] = CUT
  await ask(r)
  m.state.models.push(L('qwen3:14b', 9.3e9))
  m.state.writes['qwen3:14b'] = 500
  await r.installed()
  assert.equal(r.settings().model, 'qwen3:14b')
  const q = latch()
  m.state.holds = [q.held]
  const asked = ask(r)
  await until(() => bodies(m).length === 4)
  // The held answer ends slow, so it is measured; its /api/ps is answered only after the 14b will not load and R8's
  // retry has gone to the 4b at 16,384.
  let release = (): void => {}
  m.state.hold = new Promise<void>((done) => { release = done })
  m.state.writes[DEFAULT_MODEL] = SLOW
  late.open()
  await slow
  await until(() => looks(m) === 2)
  m.state.writes[DEFAULT_MODEL] = WHOLE
  q.open()
  assert.equal(await asked, `${DEFAULT_MODEL} says hi`)
  release()
  m.state.hold = null
  await measured(m, 3)
  assert.deepEqual(sent(m), [DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, 'qwen3:14b', DEFAULT_MODEL])
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048', '8192/2048', '16384/4096'])
  assert.deepEqual(fitOf(store)?.seen, seen, 'the 16,384 load is not kept as a measurement at 8,192')
})

test('an Ollama answer auto does not measure counts as an answer at its context too: sent before the figure arrived, under ask provider ollama or in the chat format, and run after the measured one was sent, it leaves that one no verdict', async () => {
  /** An answer at the model's context whose /api/ps is answered only after the held answer, not measured, has run. */
  const crossedBy = async (m: Fake, r: MindRouter, early: { open: () => void }, before: Promise<string>, n: number): Promise<void> => {
    let release = (): void => {}
    m.state.hold = new Promise<void>((done) => { release = done })
    m.state.writes[DEFAULT_MODEL] = WHOLE
    await ask(r)
    await until(() => looks(m) === n)
    early.open()
    await before
    release()
    m.state.hold = null
    await measured(m, n)
  }
  const grown = /; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured$/
  // Sent at 8,192 before the Windows app's reading arrived (no figure: not measured), and run by Ollama after the
  // answer at 16,384: what /api/ps says then is that load, not the context the model was trained on.
  let reading: number | null = null
  const m = ONE(WHOLE)
  const r = make(m, { appVram: () => reading, lookMs: 5000 })
  const early = latch()
  m.state.holds = [early.held]
  const before = ask(r)
  await until(() => bodies(m).length === 1)
  reading = 24
  m.state.writes[DEFAULT_MODEL] = CUT
  await ask(r)
  await measured(m, 1)
  await crossedBy(m, r, early, before, 2)
  assert.match(r.settings().fit ?? '', grown)
  await ask(r)
  await measured(m, 3)
  assert.match(r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\)$/)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096', '16384/4096'])
  // Sent under ask provider ollama (at 8,192, not measured), then auto again: the same.
  const p = ONE()
  const x = make(p, { vram: '24', lookMs: 5000 })
  await ask(x)
  await measured(p, 1)
  x.setProvider('ollama')
  const theirs = latch()
  p.state.holds = [theirs.held]
  const held = ask(x)
  await until(() => bodies(p).length === 2)
  x.setProvider('auto')
  await crossedBy(p, x, theirs, held, 2)
  assert.match(x.settings().fit ?? '', grown)
  assert.deepEqual(bodies(p), ['8192/2048', '8192/2048', '16384/4096'])
  // In the chat format Ollama chooses the context itself: a measurement at 8,192 read after a chat answer ran is not
  // kept, and the next answer is measured again.
  const c = ONE(WHOLE)
  const store = memory()
  const y = make(c, { vram: '24', store, lookMs: 5000 })
  await y.installed()
  y.setApi?.('chat')
  const chat = latch()
  c.state.holds = [chat.held]
  const said = ask(y)
  await until(() => c.calls.some((k) => k.url.endsWith('/v1/chat/completions')))
  y.setApi?.('generate')
  await crossedBy(c, y, chat, said, 1)
  assert.deepEqual(fitOf(store)?.seen ?? [], [], 'the load at 4,096 is not kept as a measurement at 8,192')
  await ask(y)
  await measured(c, 2)
  assert.deepEqual(fitOf(store)?.seen.map((k) => [k.model, (k as unknown as { loaded: number }).loaded]), [[DEFAULT_MODEL, 5e9]])
})

test("the moved model's retry at a context grown and not yet measured is measured when its first wait runs out (one of the two) or it stalls (too slow); measured good there, a first wait with the model loaded leaves it; at 8,192 it is measured only once it ends, as before", async () => {
  /** A small 4b (first waits stay 50 ms) grown to 16,384 (and, with `there`, measured there); then a 14b is pulled, ask alone steps up to it, and it will not load. */
  const stepped = async (there = false): Promise<{ m: Fake; r: MindRouter }> => {
    const m = machine({ models: [L(DEFAULT_MODEL, 4e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 1e9, kv: 1e6 } }, writes: { [DEFAULT_MODEL]: CUT } })
    const r = make(m, { vram: '3.1' })
    await ask(r)
    await measured(m, 1)
    if (there) { await ask(r); await measured(m, 2) }
    assert.match(r.settings().fit ?? '', there ? /runs at 16,384 tokens of context/ : /gets 16,384 tokens of context/)
    m.state.models.push(L('qwen3:14b', 8e6))
    m.state.writes['qwen3:14b'] = 500
    await r.installed()
    assert.equal(r.settings().model, 'qwen3:14b')
    return { m, r }
  }
  // Nothing loaded when R8's retry runs out its first wait at 16,384: one more chance, then back at the next.
  const { m, r } = await stepped()
  m.state.writes[DEFAULT_MODEL] = 'hang'
  delete m.state.ps[DEFAULT_MODEL]
  await assert.rejects(ask(r), timedOut)
  await measured(m, 2)
  assert.deepEqual(sent(m).slice(1), ['qwen3:14b', DEFAULT_MODEL])
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/, 'one more chance')
  await assert.rejects(ask(r), timedOut)
  await measured(m, 3)
  assert.match(r.settings().fit ?? '', /; 16,384 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit; ask vram auto measures afresh$/)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096', '16384/4096'])
  // A stall there: too slow, back.
  const s = await stepped()
  s.m.state.writes[DEFAULT_MODEL] = 'stall'
  await assert.rejects(ask(s.r), timedOut)
  await measured(s.m, 2)
  assert.match(s.r.settings().fit ?? '', /; 16,384 tokens of context was too slow here, so qwen3-vl:4b stays at 8,192 for this visit; ask vram auto measures afresh$/)
  // Measured good at 16,384 first: a first wait that runs out with the model whole on the GPU is still loading, so the
  // context stays (only a refusal or a failure partway sends it back at once).
  const g = await stepped(true)
  g.m.state.writes[DEFAULT_MODEL] = 'hang'
  await assert.rejects(ask(g.r), timedOut)
  await measured(g.m, 3)
  assert.deepEqual(bodies(g.m).slice(2), ['8192/2048', '16384/4096'])
  assert.match(g.r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 0\.0 GB loaded at that context, all on the GPU\); ask vram auto measures afresh$/)
  // Not grown: R8's retry at 8,192 whose first wait runs out is not measured, as before the context could grow.
  const e = machine({ models: [L(DEFAULT_MODEL, 4e6)], ps: { [DEFAULT_MODEL]: { size: 5e6, vram: 1e9, kv: 1e6 } }, writes: { [DEFAULT_MODEL]: WHOLE } })
  const w = make(e, { vram: '3.1' })
  await ask(w)
  await measured(e, 1)
  e.state.models.push(L('qwen3:14b', 8e6))
  e.state.writes['qwen3:14b'] = 500
  await w.installed()
  e.state.writes[DEFAULT_MODEL] = 'hang'
  await assert.rejects(ask(w), timedOut)
  await settle()
  assert.deepEqual(sent(e), [DEFAULT_MODEL, 'qwen3:14b', DEFAULT_MODEL])
  assert.deepEqual(bodies(e), ['8192/2048', '8192/2048', '8192/2048'])
  assert.equal(looks(e), 1)
})

test('Ollama gone at a larger context: the context stays and the ask looks again; the answer after a look that finds it goes at that context, is measured there, and goes back when refused, with no answer after it', async () => {
  // Gone, and the look finds nothing either: the context is not what failed.
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  m.state.down = true
  await assert.rejects(ask(r), (e: unknown) => e instanceof CognitionError && e.code === 'offline')
  m.state.down = false
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/)
  await ask(r)
  await measured(m, 2)
  assert.match(r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\)$/)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '16384/4096'], 'the first at 16,384 never reached Ollama')
  /** ONE() whose next /api/generate fails as an Ollama that has gone does, once `drop` is set. */
  const flaky = (writes: Writes = CUT): { p: Fake; f: Fake; drop: () => void } => {
    const p = ONE(writes)
    let drop = false
    return { p, f: { ...p, f: async (url, init) => { if (drop && url.endsWith('/api/generate')) { drop = false; throw new TypeError('Failed to fetch') } return p.f(url, init) } }, drop: () => { drop = true } }
  }
  // Gone for one answer: the look finds Ollama again and the same ask goes at 16,384, measured there.
  const a = flaky()
  const x = make(a.f, { vram: '24' })
  await ask(x)
  await measured(a.p, 1)
  a.drop()
  assert.equal(await ask(x), `${DEFAULT_MODEL} says hi`)
  await measured(a.p, 2)
  assert.match(x.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\)$/)
  // Refused there: back, and the failure is the ask's (that answer was its one more); the next ask is at 8,192.
  const b = flaky()
  const y = make(b.f, { vram: '24' })
  await ask(y)
  await measured(b.p, 1)
  b.drop()
  b.p.state.writes[DEFAULT_MODEL] = { ...CUT, refuseAbove: 8192 }
  await assert.rejects(ask(y), (e: unknown) => e instanceof CognitionError && e.code === 'server')
  assert.deepEqual(bodies(b.p), ['8192/2048', '16384/4096'], 'the answer after the look, at 16,384, and none after it')
  await settle()
  assert.equal(y.settings().fit, `${ROW}; 16,384 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit`)
  assert.equal(await ask(y), `${DEFAULT_MODEL} says hi`)
  assert.equal(bodies(b.p).at(-1), '8192/2048')
  // At 8,192 the answer after the look is sent as before the context could grow: not measured, however slow.
  const c = flaky(WHOLE)
  const z = make(c.f, { vram: '24' })
  await ask(z)
  await measured(c.p, 1)
  c.drop()
  c.p.state.writes[DEFAULT_MODEL] = SLOW
  await ask(z)
  await settle()
  assert.equal(looks(c.p), 1)
})

test("an answer to another model at another context leaves a model's measurement alone: Ollama loads each model at its own", async () => {
  const m = ONE()
  const store = memory()
  const r = make(m, { vram: '24', store })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  await measured(m, 2)
  assert.match(r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context/)
  // The 14b is pulled and ask alone steps up to it. Its first answer is held while another ask to it is refused and R8's
  // retry goes to the 4b at 16,384; then the held answer ends and is measured.
  m.state.models.push(L('qwen3:14b', 9.3e9))
  m.state.ps['qwen3:14b'] = { size: 14e9, vram: 14e9 }
  await r.installed()
  assert.equal(r.settings().model, 'qwen3:14b')
  const held = latch()
  m.state.holds = [held.held]
  const first = ask(r)
  await until(() => bodies(m).length === 3)
  m.state.writes['qwen3:14b'] = 500
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  assert.deepEqual(sent(m).slice(2), ['qwen3:14b', 'qwen3:14b', DEFAULT_MODEL])
  assert.deepEqual(bodies(m).slice(2), ['8192/2048', '8192/2048', '16384/4096'])
  m.state.writes['qwen3:14b'] = QUICK
  held.open()
  assert.equal(await first, 'qwen3:14b says hi')
  await measured(m, 3)
  assert.deepEqual(fitOf(store)?.seen.map((k) => k.model), [DEFAULT_MODEL, 'qwen3:14b'], "the 14b's measurement is kept")
})

test('one more chance after a first wait with nothing loaded is given at each context: the trained context Ollama reports gets its own', async () => {
  const placed: Placed = { size: 5e6, vram: 1e9, kv: 1e6, trained: 12288 }
  const m = machine({ models: [L(DEFAULT_MODEL, 4e6)], ps: { [DEFAULT_MODEL]: placed }, writes: { [DEFAULT_MODEL]: CUT } })
  const r = make(m, { vram: '3.1' })
  const nothingLoaded = async (n: number): Promise<void> => {
    delete m.state.ps[DEFAULT_MODEL]
    m.state.writes[DEFAULT_MODEL] = 'hang'
    await assert.rejects(ask(r), timedOut)
    await measured(m, n)
  }
  await ask(r)
  await measured(m, 1)
  await nothingLoaded(2)
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/, 'one more chance at 16,384')
  m.state.ps[DEFAULT_MODEL] = placed
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  await measured(m, 3)
  const trained = /; qwen3-vl:4b was trained on 12,288 tokens of context, so it runs at that with answers of up to 3,072$/
  assert.match(r.settings().fit ?? '', trained)
  await nothingLoaded(4)
  assert.match(r.settings().fit ?? '', trained, 'one more chance at 12,288 too')
  await nothingLoaded(5)
  assert.match(r.settings().fit ?? '', /; 12,288 tokens of context would not load in Ollama, so qwen3-vl:4b stays at 8,192 for this visit$/)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '16384/4096', '12288/3072', '12288/3072'])
})

test('a cut answer that lands after a look found nothing grows nothing: the context grows only while Ollama is found', async () => {
  const m = ONE(WHOLE)
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  m.state.writes[DEFAULT_MODEL] = CUT
  const held = latch()
  m.state.holds = [held.held]
  const cut = ask(r)
  await until(() => bodies(m).length === 2)
  m.state.down = true
  await assert.rejects(r.installed())
  m.state.down = false
  held.open()
  await cut
  await settle()
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048'])
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/)
})

/** `m` behind a fetch whose next answer (/api/generate, or the chat format's) fails as an Ollama that has gone does, once `drop` is called. */
const gone = (m: Fake): { f: Fake; drop: () => void } => {
  let drop = false
  const answer = (url: string): boolean => url.endsWith('/api/generate') || url.endsWith('/v1/chat/completions')
  return { f: { ...m, f: async (url, init) => { if (drop && answer(url)) { drop = false; throw new TypeError('Failed to fetch') } return m.f(url, init) } }, drop: () => { drop = true } }
}

test('a look that begins as an answer is sent: that answer goes at the context it was noted at, and is measured there', async () => {
  const m = ONE()
  // The Windows app's reading is taken as the answer is sent; a look begun then finds nothing until Ollama lists again.
  let looking = false
  const r: MindRouter = make(m, { appVram: () => { if (looking) { looking = false; void r.installed().catch(() => {}) } return 24 } })
  await ask(r)
  await measured(m, 1)
  assert.match(r.settings().fit ?? '', /gets 16,384 tokens of context/)
  looking = true
  await ask(r)
  await measured(m, 2)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096'])
  assert.match(r.settings().fit ?? '', /; qwen3-vl:4b runs at 16,384 tokens of context with answers of up to 4,096 \(measured 5\.6 GB loaded at that context, all on the GPU\)$/)
})

test('the figure gone before an answer ends: no /api/ps for it, the first answer or the one more at 8,192 after a larger context is refused', async () => {
  let reading: number | null = 24
  const m = ONE()
  const store = memory()
  const r = make(m, { appVram: () => reading, store })
  const first = latch()
  m.state.holds = [first.held]
  const plain = ask(r)
  await until(() => bodies(m).length === 1)
  reading = null
  first.open()
  await plain
  await settle()
  assert.equal(looks(m), 0, 'the first answer, sent with a figure, ends without one')
  reading = 24
  await ask(r)
  await measured(m, 1)
  const seen = fitOf(store)?.seen
  m.state.writes[DEFAULT_MODEL] = { ...SLOW, refuseAbove: 8192 }
  const { held, open } = latch()
  m.state.holds = [held]
  const asked = ask(r)
  await until(() => bodies(m).length === 3)
  reading = null
  open()
  assert.equal(await asked, `${DEFAULT_MODEL} says hi`)
  await settle()
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096', '8192/2048'])
  assert.equal(looks(m), 1, 'no /api/ps without a figure')
  assert.deepEqual(fitOf(store)?.seen, seen, 'nothing measured')
})

test('grown, then the chat format: the answer after a look that finds Ollama is not measured, and back in the generate format the grown context stands', async () => {
  const m = ONE()
  const g = gone(m)
  const r = make(g.f, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  r.setApi?.('chat')
  g.drop()
  assert.equal(await ask(r), 'chat says hi')
  await settle()
  assert.equal(looks(m), 1, 'Ollama chooses the context in the chat format: nothing to measure')
  r.setApi?.('generate')
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096'])
})

test("the answer after a look, at 8,192 with no figure, counts as an answer at its context: a reading at 16,384 taken after it ran says nothing", async () => {
  // Grown to 16,384, not yet measured there. The Windows app's reading is gone for one ask whose answer finds Ollama
  // gone; the look finds it and that ask's answer goes at 8,192, held.
  let reading: number | null = 24
  const m = ONE()
  const g = gone(m)
  const r = make(g.f, { appVram: () => reading, lookMs: 5000 })
  await ask(r)
  await measured(m, 1)
  reading = null
  g.drop()
  const late = latch()
  m.state.holds = [late.held]
  const before = ask(r)
  await until(() => bodies(m).length === 2)
  // The reading is back: an answer at 16,384 whose /api/ps is answered only after the held answer has run.
  reading = 24
  let release = (): void => {}
  m.state.hold = new Promise<void>((done) => { release = done })
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  await until(() => looks(m) === 2)
  late.open()
  await before
  release()
  m.state.hold = null
  await measured(m, 2)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096'])
  assert.match(r.settings().fit ?? '', /; an answer was cut at 2,048 tokens, so qwen3-vl:4b gets 16,384 tokens of context and answers of up to 4,096 from its next answer, which is measured$/)
})

test("a settings change during a cut answer's measurement means no growth, though another answer's measurement at 8,192 fits", async () => {
  // Two answers at 8,192 before either is measured: the first ends whole and its measurement (all on the GPU) lands;
  // the second ends cut, and the operator changes a setting while its own /api/ps is under way.
  const m = ONE(WHOLE)
  const r = make(m, { vram: '24', lookMs: 5000 })
  const one = latch(); const two = latch()
  m.state.holds = [one.held, two.held]
  const whole = ask(r)
  const cut = ask(r)
  await until(() => bodies(m).length === 2)
  let release = (): void => {}
  m.state.hold = new Promise<void>((done) => { release = done })
  one.open()
  await whole
  await until(() => looks(m) === 1)
  m.state.writes[DEFAULT_MODEL] = CUT
  two.open()
  await cut
  let again = (): void => {}
  const next = new Promise<void>((done) => { again = done })
  release()
  m.state.hold = next
  await until(() => looks(m) === 2)
  r.setApi?.('generate')
  again()
  m.state.hold = null
  await settle()
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048'])
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/)
})

test('the newest measurement at 8,192 decides: a cut answer after a split one kept (nothing else fits) grows nothing', async () => {
  const m = machine({ models: [L(DEFAULT_MODEL, 3.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 20e9, kv: 1e9 } }, writes: { [DEFAULT_MODEL]: WHOLE } })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  // Slow and split: measured, and kept, since Ollama lists nothing else.
  m.state.ps[DEFAULT_MODEL] = { size: 5e9, vram: 4e9, kv: 1e9 }
  m.state.writes[DEFAULT_MODEL] = SLOW
  await ask(r)
  await measured(m, 2)
  m.state.writes[DEFAULT_MODEL] = CUT
  assert.equal(await ask(r), `${DEFAULT_MODEL} says hi`)
  await settle()
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048', '8192/2048'])
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/)
})

test('the newest measurement at 8,192 decides when answers overlap: a cut answer ending while a slow one is measured waits for that reading, and grows nothing once it says split', async () => {
  const m = machine({ models: [L(DEFAULT_MODEL, 3.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 20e9, kv: 1e9 } }, writes: { [DEFAULT_MODEL]: WHOLE } })
  const r = make(m, { vram: '24', lookMs: 5000 })
  await ask(r)
  await measured(m, 1)
  // Two answers at 8,192 together: the first ends slow and its /api/ps is held; the second ends cut meanwhile.
  const one = latch(); const two = latch()
  m.state.holds = [one.held, two.held]
  const slow = ask(r)
  const cut = ask(r)
  await until(() => bodies(m).length === 3)
  let release = (): void => {}
  m.state.hold = new Promise<void>((done) => { release = done })
  m.state.writes[DEFAULT_MODEL] = SLOW
  one.open()
  await slow
  await until(() => looks(m) === 2)
  m.state.writes[DEFAULT_MODEL] = CUT
  two.open()
  await cut
  // The slow one's reading lands: split, and kept, since Ollama lists nothing else.
  m.state.ps[DEFAULT_MODEL] = { size: 5e9, vram: 4e9, kv: 1e9 }
  release()
  m.state.hold = null
  await settle()
  m.state.writes[DEFAULT_MODEL] = WHOLE
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '8192/2048', '8192/2048'])
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/)
})

test('ask vram leaves the answers in flight: a reading at 8,192 taken while an answer at 16,384 sent before it is under way is not kept, and grows nothing', async () => {
  const m = ONE()
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  const { held, open } = latch()
  m.state.holds = [held]
  const wide = ask(r)
  await until(() => bodies(m).length === 2)
  r.setVram('24')
  await ask(r)
  await measured(m, 2)
  assert.doesNotMatch(r.settings().fit ?? '', /tokens of context/, 'read while the answer at 16,384 was under way')
  open()
  await wide
  await settle()
  // Nothing at another context since: the next answer at 8,192 is measured, and grows.
  await ask(r)
  await measured(m, 3)
  await ask(r)
  assert.deepEqual(bodies(m), ['8192/2048', '16384/4096', '8192/2048', '8192/2048', '16384/4096'])
})

test('a model auto moved to grows by its own weights: the 14b, cut, gets 16,384 where the 4b\'s weights would leave no room', async () => {
  // Doubling the 14b costs what it loads beyond its weights: 14 + 4.7 GB fits 22 GiB; by the 4b's weights, 14 + 10.7 would not.
  const m = machine({ models: [L(DEFAULT_MODEL, 3.3e9), L('qwen3:14b', 9.3e9)], ps: { [DEFAULT_MODEL]: { size: 5e9, vram: 40e9, kv: 1e9 }, 'qwen3:14b': { size: 14e9, vram: 40e9, kv: 1e9 } }, writes: { [DEFAULT_MODEL]: WHOLE, 'qwen3:14b': CUT } })
  const r = make(m, { vram: '24' })
  await ask(r)
  await measured(m, 1)
  assert.equal(r.settings().model, 'qwen3:14b')
  await ask(r)
  await measured(m, 2)
  assert.equal(await ask(r), 'qwen3:14b says hi')
  assert.deepEqual(sent(m), [DEFAULT_MODEL, 'qwen3:14b', 'qwen3:14b'])
  assert.deepEqual(bodies(m), ['8192/2048', '8192/2048', '16384/4096'])
})
