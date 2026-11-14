// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the site's model's one job (siteJob.ts) to what Sloane's card and chip rely on:
 * a start says running at once and every progress after it; a second start while one runs is handed the same end;
 * the Stop says stopped at once, aborts the work, and is refused once the file is with the copy (the job then ends
 * kept); a failure ends with its reason; the work's late reports after a stop change nothing; a work that throws at once
 * still ends and lets the next start run; and a view whose listener throws does not stop the others. The work is a fake
 * the test steps by hand.
 * What breaks if it is removed? A Stop could leave half a model behind, a download the page started by itself could
 * show as stuck, or the card could ask the turn again for a job that was stopped, with no test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSiteJob, type SiteGet, type SiteJobHow } from './siteJob.ts'
import type { SiteModelProgress } from './siteModel.ts'

/** A work the test steps: its progress callback, its signal, and how to settle it. */
function steppedWork(): { get: SiteGet; calls: { how: SiteJobHow; progress: (p: SiteModelProgress) => void; signal: AbortSignal; resolve: (line: string) => void; reject: (e: unknown) => void }[] } {
  const calls: ReturnType<typeof steppedWork>['calls'] = []
  const get: SiteGet = (how, progress, signal) => new Promise<string>((resolve, reject) => { calls.push({ how, progress, signal, resolve, reject }) })
  return { get, calls }
}

test('a start says running at once, then each progress, then how it ended; a second start while it runs gets the same end', async () => {
  const w = steppedWork()
  const job = createSiteJob(w.get)
  let told = 0
  const off = job.subscribe(() => { told++ })
  assert.equal(job.state(), null, 'nothing has run this visit')
  const end = job.start('auto')
  assert.deepEqual(job.state(), { id: 1, how: 'auto', phase: 'running', step: 'download', done: 0, total: 0 })
  assert.equal(job.start('tap'), end, 'the running job is handed back, whoever asks')
  assert.equal(w.calls.length, 1)
  assert.equal(w.calls[0].how, 'auto')
  w.calls[0].progress({ step: 'download', done: 5, total: 10 })
  assert.deepEqual(job.state(), { id: 1, how: 'auto', phase: 'running', step: 'download', done: 5, total: 10 })
  const same = job.state()
  assert.equal(job.state(), same, 'the same object until it changes')
  w.calls[0].progress({ step: 'keep', done: 0, total: 10 })
  w.calls[0].resolve('kept')
  assert.deepEqual(await end, { id: 1, how: 'auto', phase: 'done', line: 'kept' })
  assert.deepEqual(job.state(), { id: 1, how: 'auto', phase: 'done', line: 'kept' })
  assert.equal(told, 4, 'running, two progresses, done')
  off()
  const again = job.start('tap')
  assert.equal(told, 4, 'unsubscribed')
  assert.equal(w.calls.length, 2, 'a new job once the last has ended')
  assert.equal(job.state()?.id, 2)
  w.calls[1].reject(new Error('the site did not send the model (HTTP 503)'))
  assert.deepEqual(await again, { id: 2, how: 'tap', phase: 'failed', why: 'the site did not send the model (HTTP 503)' })
})

test('the Stop says stopped at once and aborts the work; its late reports and rejection change nothing', async () => {
  const w = steppedWork()
  const job = createSiteJob(w.get)
  const end = job.start('tap')
  w.calls[0].progress({ step: 'download', done: 3, total: 10 })
  assert.equal(job.stop('person'), true)
  assert.deepEqual(job.state(), { id: 1, how: 'tap', phase: 'stopped', by: 'person' })
  assert.equal(w.calls[0].signal.aborted, true, 'the work is told')
  w.calls[0].progress({ step: 'download', done: 4, total: 10 })
  assert.equal(job.state()?.phase, 'stopped', 'a late report changes nothing')
  assert.equal(job.stop('network'), false, 'stopped once')
  w.calls[0].reject(w.calls[0].signal.reason)
  assert.deepEqual(await end, { id: 1, how: 'tap', phase: 'stopped', by: 'person' })
  assert.equal(job.stop('person'), false, 'nothing runs')
})

test('once the file is with the copy a Stop is refused, and the job ends kept', async () => {
  const w = steppedWork()
  const job = createSiteJob(w.get)
  const end = job.start('auto')
  w.calls[0].progress({ step: 'keep', done: 0, total: 10 })
  assert.equal(job.stop('person'), false)
  assert.equal(w.calls[0].signal.aborted, false)
  assert.deepEqual(job.state(), { id: 1, how: 'auto', phase: 'running', step: 'keep', done: 0, total: 10 })
  w.calls[0].progress({ step: 'keep', done: 10, total: 10 })
  w.calls[0].resolve('kept and chosen')
  assert.equal((await end).phase, 'done')
})

test('each stop says who stopped it: the visitor, the connection, the city\'s end', async () => {
  for (const by of ['person', 'network', 'page'] as const) {
    const w = steppedWork()
    const job = createSiteJob(w.get)
    const end = job.start('auto')
    assert.ok(job.stop(by))
    w.calls[0].reject(new DOMException('aborted', 'AbortError'))
    assert.deepEqual(await end, { id: 1, how: 'auto', phase: 'stopped', by })
  }
})

test('a work that throws at once still ends, and the next start runs; a listener that throws does not stop the others', async () => {
  let n = 0
  const job = createSiteJob((() => {
    n++
    if (n === 1) throw new Error('no room')
    return Promise.resolve('kept')
  }) as unknown as SiteGet)
  let seen = 0
  job.subscribe(() => { throw new Error('a broken view') })
  job.subscribe(() => { seen++ })
  assert.deepEqual(await job.start('tap'), { id: 1, how: 'tap', phase: 'failed', why: 'no room' })
  assert.deepEqual(await job.start('tap'), { id: 2, how: 'tap', phase: 'done', line: 'kept' })
  assert.equal(seen, 4, 'running and failed, running and done')
  assert.ok(Object.isFrozen(job))
})
