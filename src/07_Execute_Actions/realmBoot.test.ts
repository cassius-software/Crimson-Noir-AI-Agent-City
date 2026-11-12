// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the physics realm's boot failures reach the page with their class intact and
 * are never swallowed: a crowd that throws a coded error (no WebGPU in the worker) posts {t:'error', code} through the
 * message door; SimClient.create rejects with that code on the Error; a fault that comes before the engine listens is
 * held and handed on when it does (the engine refuses to start on one); the worker reports its own WebAssembly and
 * WebGPU failures with codes and keeps going without the optional routing core; and the crowd's first-reading window
 * counts only the time the worker ran, so an iPhone switched to another app while the city starts does not come back
 * to a failure. A fake Worker stands in for the inlined physics worker (a module hook resolves Vite's `?worker&inline`).
 * What breaks if it is removed? A boot failure could lose its class (and its words on the card), a worker fault during
 * boot could leave the city running on a closed client with frozen physics, or the window could shrink unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { test } from 'node:test'
import { createSimHost } from './simHost.ts'
import { coded, failureCode, POSE, type FromWorker } from './simProtocol.ts'
import { CROWD_PRIME_MS, PRIME_GAP_MS, primeElapsed } from './simCore.ts'

/** Every fake worker made, newest last: the inlined physics worker's stand-in. */
interface FakeWorker {
  posted: unknown[]
  terminated: boolean
  onmessage: ((e: { data: FromWorker }) => void) | null
  onerror: ((e: { message: string; preventDefault(): void }) => void) | null
}
const workers: FakeWorker[] = ((globalThis as { __fakeWorkers?: FakeWorker[] }).__fakeWorkers = [])
const FAKE = `export default class { constructor() { this.posted = []; this.terminated = false; this.onmessage = null; this.onerror = null; globalThis.__fakeWorkers.push(this) }
  postMessage(m) { this.posted.push(m) } terminate() { this.terminated = true } }`
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('?worker&inline')) return { url: `data:text/javascript,${encodeURIComponent(FAKE)}`, shortCircuit: true }
    return nextResolve(specifier, context)
  },
})
const { SimClient } = await import('./simClient.ts')

const INIT = { seed: 1, cars: 0, agents: 256, boxes: [], furniture: { lamps: [], trees: [], signals: [] }, spawn: { x: 0, z: 0 }, debug: false } as const
const META = { count: 1, agents: 256, suv: [false], kind: [0], paint: [0], person: { radius: 0.3, halfHeight: 0.6 }, debug: false, craft: 0, players: 1, rigSlots: 0 }
const state = (id: number) => ({
  t: 'state', id, simTime: 0, poses: new Float32Array(POSE.stride), avatars: [{ x: 0, y: 0, z: 0, enabled: true, sensor: false }], drivings: [-1], crowdFrame: null, craft: null, rigs: null, robots: null,
}) as unknown as FromWorker

/** Starts a client on a fresh fake worker and answers its init up to the first state. */
async function booted() {
  const p = SimClient.create(INIT as never, false)
  const w = workers[workers.length - 1]
  w.onmessage?.({ data: { t: 'ready', meta: META } as FromWorker })
  w.onmessage?.({ data: state(0) })
  return { client: await p, w }
}

test('the message door forwards the class of an init failure with its words', async () => {
  const out: FromWorker[] = []
  await createSimHost((m) => out.push(m), async () => { throw coded('worker-gpu', 'no WebGPU adapter inside the physics worker') })(
    { t: 'init', ...INIT },
  )
  assert.deepEqual(out, [{ t: 'error', message: 'init: no WebGPU adapter inside the physics worker', code: 'worker-gpu' }])
  const plain: FromWorker[] = []
  await createSimHost((m) => plain.push(m), async () => { throw new Error('Rapier said no') })({ t: 'init', ...INIT })
  assert.deepEqual(plain, [{ t: 'error', message: 'init: Rapier said no' }], 'no code when the worker does not know the class')
  assert.equal(failureCode(Object.assign(new Error('x'), { code: 9 })), undefined, 'a DOMException\'s number is not a code')
})

test('SimClient.create rejects with the worker\'s code on the Error; the old words stay the message', async () => {
  const p = SimClient.create(INIT as never, false)
  const w = workers[workers.length - 1]
  w.onmessage?.({ data: { t: 'error', message: 'init: WebAssembly is turned off in this browser (the physics needs it)', code: 'wasm' } })
  await assert.rejects(p, (e: Error & { code?: string }) => e.code === 'wasm' && /WebAssembly is turned off/.test(e.message))
  assert.equal(w.terminated, true)
  const q = SimClient.create(INIT as never, false)
  const v = workers[workers.length - 1]
  v.onerror?.({ message: 'Uncaught ReferenceError: WebAssembly is not defined', preventDefault() {} })
  await assert.rejects(q, /physics worker failed to start: Uncaught ReferenceError: WebAssembly is not defined/)
})

test('SimClient.create tells the boot the crowd\'s ladder and the moment the world stands, and a boot that gives up stops the worker where it is', async () => {
  // The ladder as the worker tells it, then 'ready' (the crowd's first reading is in), each before the first state.
  const heard: string[] = []
  const p = SimClient.create(INIT as never, false, {
    ladder: (step) => { heard.push(`${step.rung} ${step.step}`) },
    ready: (meta) => { heard.push(`ready ${meta.agents}`) },
  })
  const w = workers[workers.length - 1]
  w.onmessage?.({ data: { t: 'crowdKernel', rung: 'full', step: 'trying' } })
  w.onmessage?.({ data: { t: 'crowdKernel', rung: 'full', step: 'refused', words: 'no' } })
  w.onmessage?.({ data: { t: 'crowdKernel', rung: 'narrow', step: 'running' } })
  w.onmessage?.({ data: { t: 'ready', meta: META } as FromWorker })
  assert.deepEqual(heard, ['full trying', 'full refused', 'narrow running', 'ready 256'])
  w.onmessage?.({ data: state(0) })
  await p
  // A listener that throws does not stop the boot it is told about.
  const errors: unknown[] = []
  const said = console.error
  console.error = (...a: unknown[]) => { errors.push(a[0]) }
  try {
    const q = SimClient.create(INIT as never, false, { ladder: () => { throw new Error('listener bug') }, ready: () => { throw new Error('another') } })
    const v = workers[workers.length - 1]
    v.onmessage?.({ data: { t: 'crowdKernel', rung: 'full', step: 'trying' } })
    v.onmessage?.({ data: { t: 'ready', meta: META } as FromWorker })
    v.onmessage?.({ data: state(0) })
    assert.ok(await q)
    assert.equal(errors.length, 2)
  } finally {
    console.error = said
  }
  // The boot failed elsewhere (the page's own device lost): the worker is stopped, the promise rejects, and nothing it
  // had still to say is heard.
  const gaveUp = new AbortController()
  const late: string[] = []
  const r = SimClient.create(INIT as never, false, { signal: gaveUp.signal, ladder: (step) => { late.push(step.step) } })
  const u = workers[workers.length - 1]
  u.onmessage?.({ data: { t: 'crowdKernel', rung: 'full', step: 'trying' } })
  gaveUp.abort()
  await assert.rejects(r, /the boot was given up before the physics worker was ready/)
  assert.equal(u.terminated, true)
  u.onmessage?.({ data: { t: 'crowdKernel', rung: 'full', step: 'lost', words: 'gone' } })
  u.onmessage?.({ data: { t: 'ready', meta: META } as FromWorker })
  assert.deepEqual(late, ['trying'])
  assert.equal(u.posted.filter((m) => (m as { t?: string }).t === 'step').length, 0, 'no step is asked of a worker given up')
  // Given up before it began: no init is sent at all.
  const before = new AbortController()
  before.abort()
  const t = SimClient.create(INIT as never, false, { signal: before.signal })
  const x = workers[workers.length - 1]
  await assert.rejects(t, /the boot was given up/)
  assert.equal(x.terminated, true)
  assert.equal(x.posted.length, 0)
  // Given up after the client stood: nothing happens here (the engine closes the client itself).
  const after = new AbortController()
  const s = SimClient.create(INIT as never, false, { signal: after.signal })
  const y = workers[workers.length - 1]
  y.onmessage?.({ data: { t: 'ready', meta: META } as FromWorker })
  y.onmessage?.({ data: state(0) })
  await s
  after.abort()
  assert.equal(y.terminated, false)
})

test('a fault before anyone listens is held, refuses the boot, and reaches onPanic once listen() is called', async () => {
  const { client, w } = await booted()
  assert.equal(client.fault, null)
  w.onerror?.({ message: 'Uncaught RangeError: memory access out of bounds', preventDefault() {} })
  assert.equal(client.fault, 'Physics realm fault: Uncaught RangeError: memory access out of bounds', 'Engine.create reads it before it builds the engine')
  assert.equal(client.request({ dt: 0.016, foot: { x: 0, z: 0, heading: 0 }, drive: { steer: 0, fwd: 0, back: 0, handbrake: false } }), false, 'the client is closed')
  const heard: string[] = []
  client.listen(() => {}, (r) => heard.push(r))
  assert.deepEqual(heard, ['Physics realm fault: Uncaught RangeError: memory access out of bounds'])
  assert.equal(client.fault, null, 'handed on once')
  // A panic posted before listen() is held the same way, and a later fault is not reported twice.
  const second = await booted()
  second.w.onmessage?.({ data: { t: 'panic', reason: 'Sensing Failure: pedestrian sensing stopped (GPU device lost (unknown): x).' } })
  const got: string[] = []
  second.client.listen(() => {}, (r) => got.push(r))
  second.w.onerror?.({ message: 'later', preventDefault() {} })
  assert.deepEqual(got, ['Sensing Failure: pedestrian sensing stopped (GPU device lost (unknown): x).'])
  client.terminate()
  second.client.terminate()
})

test('Engine.create refuses to build an engine over a client that faulted while the page compiled', () => {
  const engine = readFileSync(new URL('./engine.ts', import.meta.url), 'utf8')
  const create = engine.slice(engine.indexOf('  static async create('), engine.indexOf('  /** The minimap'))
  assert.match(create, /if \(sim\.fault !== null\) throw new Error\(sim\.fault\)/)
  assert.ok(create.indexOf('sim.fault') < create.indexOf('new Engine('), 'before the engine (and its listen) exists')
})

test('the worker codes its own failures and does without the optional routing core', () => {
  const src = readFileSync(new URL('./physics.worker.ts', import.meta.url), 'utf8')
  assert.match(src, /throw coded\('worker-gpu', 'WebGPU is not available inside the physics worker \(the pedestrian sensing needs it there\)'\)/)
  assert.match(src, /throw coded\('worker-gpu', 'no WebGPU adapter inside the physics worker'\)/)
  assert.match(src, /if \(typeof WebAssembly !== 'object'\) return Promise\.reject\(coded\('wasm', /)
  assert.match(src, /try \{\n\s*\/\/ oxlint-disable-next-line react\/rules-of-hooks[^\n]*\n\s*useRoutingCore\(createRoutingCore\(\)\)\n\s*\} catch/, 'the routing core may fail without stopping the worker')
  // A crowd device lost under a kernel (crowdSim.ts KernelLostError), or before the crowd's first reading (simCore.ts
  // SensingLostError: the kernel's first dispatch): the page is told which kernel first, then the realm fails as
  // 'kernel-lost', the code the page's next start goes lighter on (crowdKernelMemory.ts).
  assert.match(src, /if \(e instanceof KernelLostError\) \{\n\s+ladder\(e\.rung, 'lost', e\.loss\.message\)\n\s+throw coded\('kernel-lost', words\)\n\s+\}/)
  assert.match(src, /if \(!\(e instanceof SensingLostError\) \|\| e\.destroyed\) throw e\n\s+ladder\(e\.kernel, 'lost', e\.message\)\n\s+throw coded\('kernel-lost', e\.message\)/, 'a device destroyed on purpose is no kernel\'s loss')
  // A device handed over already lost was lost under no kernel: said in plain words (a reset on the card), before any rung is told.
  assert.match(src, /const born = await lossOf\(device\)\n\s+if \(born\) throw new Error\(`GPU device lost \(\$\{born\.reason\}\) as the physics worker was given it: /)
  assert.ok(src.indexOf('const born = await lossOf(device)') < src.indexOf('CrowdSim.create(device, agents'), 'asked before the crowd is built')
  // Every step of the ladder goes to the page as it happens, 'trying' before the compile it announces: a GPU process
  // that dies under a kernel takes the page's device with it, and the page must already know which kernel it was.
  assert.match(src, /CrowdSim\.create\(device, agents, grid, streets, rooms, \{ from, note: \(rung, step, words\) => ladder\(rung, step, words\) \}\)/)
  assert.match(src, /scope\.postMessage\(\{ t: 'crowdKernel', rung, step, /)
})

test('the crowd\'s first-reading window: 10 s of the worker running; a suspension counts for a quarter second', () => {
  assert.equal(CROWD_PRIME_MS, 10_000)
  assert.equal(PRIME_GAP_MS, 250)
  // A steady 1 ms poll counts every millisecond.
  let t = 0, primed = 0
  for (let i = 0; i < 100; i++) { primed = primeElapsed(primed, t, t + 1); t += 1 }
  assert.equal(primed, 100)
  // The iPhone switched to another app for a minute while the city started: one wait of 60 s.
  assert.equal(primeElapsed(500, 1_000, 61_000), 750, 'the minute away is not counted')
  assert.ok(primeElapsed(0, 0, 60_000) < CROWD_PRIME_MS, 'so it cannot fail the boot on its own')
  assert.equal(primeElapsed(10, 5, 4), 10, 'a clock that went back counts nothing')
  const core = readFileSync(new URL('./simCore.ts', import.meta.url), 'utf8')
  assert.match(core, /if \(primed > CROWD_PRIME_MS\) throw new Error\('pedestrian sensing failed to start: no reading from the GPU'\)/)
  assert.match(core, /primed = primeElapsed\(primed, last, t\)/)
})
