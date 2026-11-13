// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins what the page remembers of a GPU and the crowd's kernels (crowdKernelMemory.ts): the
 * record and where it holds, the policy (after a refusal the next rung, after a loss the light kernel, after the light
 * kernel's loss nothing for an hour; one loss asked about again a day later, two standing; a refusal asked again
 * after a week), which start asks for what (the address's word, the record, the GPU family's rung, the full kernel),
 * what counts as a loss seen in this browser before (lostBefore), one boot's bookkeeping
 * (KernelWatch: the record is written at a verdict and when the realm stands, never in between; a loss while the page
 * was hidden, or of the page's device alone, blames no kernel), and the failures a loss comes to, with their words.
 * The restart can never repeat: a start whose kernel is the address's own word never restarts itself, and the page
 * puts its restart's kernel in the address.
 * What breaks if it is removed? A change that asked a GPU again for the kernel that took it down, restarted the page
 * in a loop, or kept one GPU's verdict for another browser or build, would pass every other test.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  afterLoss, afterRefusal, clearKernelMemory, describeKernelMemory, KERNEL_MEMORY_KEY, kernelLostFailure, kernelNoneFailure, KernelResetError, KernelWatch, loadKernelMemory,
  familyKernel, heldNone, LOST_RETRY_MS, LOST_STRIKES, lostBefore, NONE_RETRY_MS, noneHoldMs, parseKernelMemory, planKernel, REFUSED_RETRY_MS, saveKernelMemory, type KernelMemory, type KernelStore, type KernelVerdict,
  type KernelWhere,
} from './crowdKernelMemory.ts'
import { WebGPUUnavailableError } from '../01_Initialize_World/gpuDevice.ts'
import { classify, kindOf } from '../07_Execute_Actions/bootFailure.ts'

const HERE: KernelWhere = { sources: '1a2b3c4d', ua: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/156.0.0.0 Mobile Safari/537.36', adapter: 'arm / valhall' }
const GONE = 'GPU device lost (unknown): A valid external Instance reference no longer exists.'

/** A store over a map; `fail` makes writes throw (a private window), `forget` makes them vanish (a browser that keeps nothing). */
function store(o: { fail?: boolean; forget?: boolean } = {}): KernelStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { if (o.fail) throw new Error('QuotaExceededError'); if (!o.forget) map.set(k, v) },
    removeItem: (k) => { map.delete(k) },
  }
}
/** A verdict as lost() gives it: no time heard (elapsedMs null) and no hold unless said. */
const verdict = (over: Partial<KernelVerdict> = {}): KernelVerdict => ({ rung: 'full', next: 'lite', saved: true, words: GONE, elapsedMs: null, holdMs: 0, ...over })
const record = (over: Partial<KernelMemory> = {}): KernelMemory => ({ v: 1, ...HERE, from: 'lite', why: 'lost', rung: 'full', words: GONE, at: 1000, strikes: 1, ...over })

test('the policy: after a refusal the next rung in order; after a loss the light kernel, and nothing after the light kernel itself', () => {
  assert.equal(afterRefusal('full'), 'narrow')
  assert.equal(afterRefusal('narrow'), 'lite')
  assert.equal(afterRefusal('lite'), 'none')
  // A loss skips the narrow kernel: the same module at half the workgroup is not worth a second GPU process.
  assert.equal(afterLoss('full'), 'lite')
  assert.equal(afterLoss('narrow'), 'lite')
  assert.equal(afterLoss('lite'), 'none')
})

test('the record: read back only where it was learnt (the kernels\' fingerprint, the user agent, the adapter), and never from a corrupt or foreign value', () => {
  const s = store()
  assert.equal(loadKernelMemory(s, HERE), null, 'nothing kept')
  assert.equal(saveKernelMemory(s, HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 1234), true)
  assert.deepEqual(loadKernelMemory(s, HERE), record({ at: 1234 }))
  assert.deepEqual(Object.keys(JSON.parse(s.map.get(KERNEL_MEMORY_KEY)!)).sort(), ['adapter', 'at', 'from', 'rung', 'sources', 'strikes', 'ua', 'v', 'why', 'words'])
  // Another build's kernels, another browser version, another GPU: each asks afresh.
  assert.equal(loadKernelMemory(s, { ...HERE, sources: 'ffffffff' }), null, 'changed kernels')
  assert.equal(loadKernelMemory(s, { ...HERE, ua: HERE.ua.replace('156', '157') }), null, 'an updated browser')
  assert.equal(loadKernelMemory(s, { ...HERE, adapter: 'qualcomm / adreno-6xx' }), null, 'another GPU')
  // Anything that is not a record reads as nothing.
  const raw = JSON.stringify(record())
  for (const bad of [null, '', 'x', '[]', '{}', '"lite"', raw.replace('"v":1', '"v":2'), raw.replace('"from":"lite"', '"from":"full"'), raw.replace('"from":"lite"', '"from":"heavy"'),
    raw.replace('"why":"lost"', '"why":"tired"'), raw.replace('"rung":"full"', '"rung":"none"'), raw.replace('"at":1000', '"at":"now"'), raw.replace('"words":', '"word":'), raw.replace('"strikes":1', '"strikes":0'), raw.replace('"strikes":1', '"strikes":1.5'), raw.replace(',"strikes":1', ''),
    `${raw.slice(0, -1)},"pad":"${'x'.repeat(5000)}"}`]) {
    assert.equal(parseKernelMemory(bad, HERE), null, String(bad).slice(0, 60))
  }
  assert.equal(parseKernelMemory(raw.replace('"from":"lite"', '"from":"none"'), HERE)?.from, 'none')
  // Strikes are counted to LOST_STRIKES and no further, written or read.
  assert.equal(LOST_STRIKES, 2)
  assert.equal(parseKernelMemory(raw.replace('"strikes":1', '"strikes":9'), HERE)?.strikes, 2)
  saveKernelMemory(s, HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE, strikes: 7 }, 1)
  assert.equal(loadKernelMemory(s, HERE)?.strikes, 2)
  // The browser's words are cut, not refused: a driver's message can run long.
  saveKernelMemory(s, HERE, { from: 'narrow', why: 'refused', rung: 'full', words: 'x'.repeat(5000) }, 1)
  assert.equal(loadKernelMemory(s, HERE)?.words.length, 600)
  // Storage that refuses, or keeps nothing, is said: only a record the next start will find counts as saved.
  assert.equal(saveKernelMemory(store({ fail: true }), HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 1), false)
  assert.equal(saveKernelMemory(store({ forget: true }), HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 1), false)
  assert.equal(saveKernelMemory(null, HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 1), false)
  assert.equal(loadKernelMemory(null, HERE), null)
  assert.equal(loadKernelMemory({ ...s, getItem: () => { throw new Error('SecurityError') } }, HERE), null)
  clearKernelMemory(s)
  assert.equal(s.map.size, 0)
  clearKernelMemory(null)
})

test('planKernel: the address\'s word, else the record, else the full kernel; a record of none stops the start for an hour, save ?kernel=full; one loss is asked about again after a day, a refusal after a week', () => {
  assert.deepEqual(planKernel(null, null, 0), { from: 'full', by: 'default' })
  assert.deepEqual(planKernel(null, record({ from: 'narrow', why: 'refused' }), 1000), { from: 'narrow', by: 'memory' })
  assert.deepEqual(planKernel(null, record(), 1000), { from: 'lite', by: 'memory' })
  for (const asked of ['full', 'narrow', 'lite'] as const) {
    assert.deepEqual(planKernel(asked, null, 0), { from: asked, by: 'address' })
    assert.deepEqual(planKernel(asked, record(), 1000), { from: asked, by: 'address' }, 'the address beats the record')
    assert.deepEqual(planKernel(asked, record(), 1000 + LOST_RETRY_MS), { from: asked, by: 'address' }, 'and beats the retry')
  }
  // Every kernel took the GPU down at t = 1000: for an hour nothing is asked of it, whatever lighter word the address has.
  const none = record({ from: 'none', rung: 'lite' })
  assert.deepEqual(planKernel(null, none, 1000), { from: null, by: 'memory' })
  assert.deepEqual(planKernel(null, none, 1000 + NONE_RETRY_MS - 1), { from: null, by: 'memory' })
  assert.deepEqual(planKernel('lite', none, 2000), { from: null, by: 'memory' }, 'the restart\'s own ?kernel=lite does not ask again')
  assert.deepEqual(planKernel('narrow', none, 2000), { from: null, by: 'memory' })
  assert.deepEqual(planKernel('full', none, 2000), { from: 'full', by: 'address' }, '?kernel=full asks for everything again')
  // After the hour the light kernel is asked once more (and the address's word counts again).
  assert.deepEqual(planKernel(null, none, 1000 + NONE_RETRY_MS), { from: 'lite', by: 'memory' })
  assert.deepEqual(planKernel('narrow', none, 1000 + NONE_RETRY_MS), { from: 'narrow', by: 'address' })
  // A clock set back does not hold the record for ever.
  assert.deepEqual(planKernel(null, none, 500), { from: 'lite', by: 'memory' })
  // The lightest kernel down twice running: a day, not an hour (each try stops the browser's graphics in every tab).
  assert.equal(noneHoldMs(1), NONE_RETRY_MS)
  assert.equal(noneHoldMs(2), LOST_RETRY_MS)
  const twice = record({ from: 'none', rung: 'lite', strikes: 2 })
  assert.deepEqual(planKernel(null, twice, 1000 + NONE_RETRY_MS), { from: null, by: 'memory' })
  assert.deepEqual(planKernel(null, twice, 1000 + LOST_RETRY_MS), { from: 'lite', by: 'memory' })
  // Before any device exists there is no adapter to match: 'none' is read without one, and stops the start the same.
  const s = store()
  saveKernelMemory(s, HERE, { from: 'none', why: 'lost', rung: 'lite', words: GONE }, 1000)
  const loose = { sources: HERE.sources, ua: HERE.ua }
  assert.deepEqual(heldNone(s, loose, null, 2000), record({ from: 'none', rung: 'lite' }))
  assert.deepEqual(heldNone(s, loose, 'lite', 2000)?.from, 'none', 'the restart\'s own ?kernel=lite does not ask again')
  assert.equal(heldNone(s, loose, 'full', 2000), null, '?kernel=full asks for everything again')
  assert.equal(heldNone(s, loose, null, 1000 + NONE_RETRY_MS), null, 'the hour is up')
  assert.equal(heldNone(s, { ...loose, ua: 'another browser' }, null, 2000), null)
  assert.equal(heldNone(s, { ...loose, sources: 'ffffffff' }, null, 2000), null)
  assert.equal(heldNone(null, loose, null, 2000), null)
  assert.equal(heldNone({ ...s, getItem: () => { throw new Error('SecurityError') } }, loose, null, 2000), null)
  saveKernelMemory(s, HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 1000)
  assert.equal(heldNone(s, loose, null, 2000), null, 'a record with a kernel left stops nothing')

  // One loss is one piece of evidence (the GPU process serves every tab): a day later the kernel it names is asked
  // once more. A second loss stands for as long as the record matches.
  assert.equal(LOST_RETRY_MS, 86_400_000)
  assert.deepEqual(planKernel(null, record(), 1000 + LOST_RETRY_MS - 1), { from: 'lite', by: 'memory' })
  assert.deepEqual(planKernel(null, record(), 1000 + LOST_RETRY_MS), { from: 'full', by: 'retry' })
  assert.deepEqual(planKernel(null, record({ rung: 'narrow' }), 1000 + LOST_RETRY_MS), { from: 'narrow', by: 'retry' }, 'the kernel that was lost, not the one above it')
  assert.deepEqual(planKernel(null, record({ strikes: 2 }), 1000 + 400 * LOST_RETRY_MS), { from: 'lite', by: 'memory' }, 'twice lost: not asked again')
  assert.deepEqual(planKernel(null, record(), 500), { from: 'full', by: 'retry' }, 'a clock set back holds nothing')
  // A refusal costs only its compile: after a week the ladder is asked from the top again.
  assert.equal(REFUSED_RETRY_MS, 7 * 86_400_000)
  const refused = record({ from: 'lite', why: 'refused', rung: 'narrow' })
  assert.deepEqual(planKernel(null, refused, 1000 + REFUSED_RETRY_MS - 1), { from: 'lite', by: 'memory' })
  assert.deepEqual(planKernel(null, refused, 1000 + REFUSED_RETRY_MS), { from: 'full', by: 'default' })
})

test('a GPU family that starts lower: Mali Bifrost begins on the light kernel before anything is learnt, a record and the address still win, and ?kernel=full asks for everything', () => {
  // The family from the adapter's line: Dawn's architecture, or the Mali's own name where a browser gives only that.
  for (const line of ['arm / bifrost', 'arm / bifrost / Mali-G52 MC2', 'ARM / Bifrost', 'arm / Mali-G31', 'Mali-G51', 'arm / mali-g71 mp8', 'arm / Mali-G72 MP3', 'arm / Mali-G76 MC4']) assert.equal(familyKernel(line), 'lite', line)
  for (const line of ['arm / valhall', 'arm / Mali-G57 MC2', 'arm / Mali-G710', 'arm / Mali-G520', 'arm / Mali-G310', 'qualcomm / adreno-6xx', 'apple / metal-3', 'unknown adapter', '', 'arm / bifrosting']) assert.equal(familyKernel(line), null, line)
  // Nothing known: the family's rung, said as the family's.
  assert.deepEqual(planKernel(null, null, 0, 'lite'), { from: 'lite', by: 'family' })
  assert.deepEqual(planKernel(null, null, 0, null), { from: 'full', by: 'default' })
  // The address beats the family, ?kernel=full included: the one way to ask such a GPU for everything.
  for (const asked of ['full', 'narrow', 'lite'] as const) assert.deepEqual(planKernel(asked, null, 0, 'lite'), { from: asked, by: 'address' })
  // A record of this very GPU beats the family: a refusal that left the narrow kernel standing is kept for its week.
  const narrow = record({ from: 'narrow', why: 'refused', rung: 'full' })
  assert.deepEqual(planKernel(null, narrow, 1000, 'lite'), { from: 'narrow', by: 'memory' })
  // A refusal old enough to ask again asks from the family's top, not the full kernel's; but where the rung the record
  // saw stand is above the family's (the address asked for everything once, and the narrow kernel ran), that rung.
  assert.deepEqual(planKernel(null, record({ from: 'lite', why: 'refused', rung: 'narrow' }), 1000 + REFUSED_RETRY_MS, 'lite'), { from: 'lite', by: 'family' })
  assert.deepEqual(planKernel(null, narrow, 1000 + REFUSED_RETRY_MS, 'lite'), { from: 'narrow', by: 'memory' })
  assert.deepEqual(planKernel(null, narrow, 1000 + 400 * REFUSED_RETRY_MS, 'lite'), { from: 'narrow', by: 'memory' })
  assert.deepEqual(planKernel(null, narrow, 1000 + REFUSED_RETRY_MS, null), { from: 'full', by: 'default' }, 'any other GPU asks from the top again')
  // One loss under the full kernel is not asked about again for such a GPU: the record stands, a day later or a year.
  assert.deepEqual(planKernel(null, record(), 1000 + LOST_RETRY_MS, 'lite'), { from: 'lite', by: 'memory' })
  assert.deepEqual(planKernel(null, record({ rung: 'narrow' }), 1000 + LOST_RETRY_MS, 'lite'), { from: 'lite', by: 'memory' })
  // 'none' holds as it does for any GPU, and after its hour the light kernel is asked once more, as the family's start
  // (nothing heavier was asked of such a GPU, so `hardware` blames no heavier kernel).
  const none = record({ from: 'none', rung: 'lite' })
  assert.deepEqual(planKernel(null, none, 1000, 'lite'), { from: null, by: 'memory' })
  assert.deepEqual(planKernel(null, none, 1000 + NONE_RETRY_MS, 'lite'), { from: 'lite', by: 'family' })
  assert.deepEqual(planKernel(null, none, 1000 + NONE_RETRY_MS, null), { from: 'lite', by: 'memory' })
  assert.deepEqual(planKernel('full', none, 2000, 'lite'), { from: 'full', by: 'address' })

  // One boot on such a GPU: the light kernel is asked first, and standing on it writes nothing (nothing was learnt).
  const BIFROST: KernelWhere = { ...HERE, adapter: 'arm / bifrost' }
  const s = store()
  const w = new KernelWatch(s, BIFROST, null, () => 50)
  assert.deepEqual(w.plan, { from: 'lite', by: 'family' })
  w.note({ rung: 'lite', step: 'trying' }, true)
  w.note({ rung: 'lite', step: 'running' }, true)
  w.stood('lite')
  assert.equal(s.map.size, 0)
  // A Valhall Mali is asked for the full kernel as before.
  assert.deepEqual(new KernelWatch(store(), HERE, null, () => 50).plan, { from: 'full', by: 'default' })
  // The light kernel's own loss on such a GPU is the loss of the last rung, as anywhere: nothing is left to ask, and
  // the card says so in words true of one loss (the lightest kernel stopped the graphics, not "each time").
  const t = store()
  const lost = new KernelWatch(t, BIFROST, null, () => 80)
  lost.note({ rung: 'lite', step: 'trying' }, true)
  const gone = lost.pageLost(GONE, true, true)
  assert.equal(gone?.next, 'none')
  assert.equal(loadKernelMemory(t, BIFROST)?.from, 'none')
  const card = classify(kernelLostFailure(gone!, lost.plan), { ua: HERE.ua, secure: true, standalone: false, native: false, origin: '', touchPoints: 5 })
  assert.equal(card.kind, 'kernel-none')
  assert.equal(card.headline, 'The crowd’s lightest kernel stopped this device’s graphics')
  assert.doesNotMatch([card.headline, ...card.steps].join(' '), /keeps|each time/)
  // After the hold the light kernel is asked once more as the family's start, and standing forgets the record: no
  // heavier kernel was ever asked of this GPU, so none is remembered as lost.
  const after = new KernelWatch(t, BIFROST, null, () => 80 + NONE_RETRY_MS)
  assert.deepEqual(after.plan, { from: 'lite', by: 'family' })
  after.note({ rung: 'lite', step: 'trying' }, true)
  after.note({ rung: 'lite', step: 'running' }, true)
  after.stood('lite')
  assert.equal(t.map.size, 0)
  assert.deepEqual(new KernelWatch(t, BIFROST, null, () => 90 + NONE_RETRY_MS).plan, { from: 'lite', by: 'family' })
  // A heavier kernel the address asked for, standing after such a hold, forgets the record too: the address counts
  // for its visit only, and no loss of a heavier kernel is made up.
  const n = store()
  saveKernelMemory(n, BIFROST, { from: 'none', why: 'lost', rung: 'lite', words: GONE }, 100)
  const narrowAsked = new KernelWatch(n, BIFROST, 'narrow', () => 100 + NONE_RETRY_MS)
  assert.deepEqual(narrowAsked.plan, { from: 'narrow', by: 'address' })
  narrowAsked.stood('narrow')
  assert.equal(n.map.size, 0)
  assert.deepEqual(new KernelWatch(n, BIFROST, null, () => 200 + NONE_RETRY_MS).plan, { from: 'lite', by: 'family' })
  // Any other GPU keeps the record of one loss above the light kernel, as before.
  const v = store()
  saveKernelMemory(v, HERE, { from: 'none', why: 'lost', rung: 'lite', words: GONE }, 100)
  const valhall = new KernelWatch(v, HERE, null, () => 100 + NONE_RETRY_MS)
  assert.deepEqual(valhall.plan, { from: 'lite', by: 'memory' })
  valhall.stood('lite')
  assert.deepEqual(loadKernelMemory(v, HERE), record({ from: 'lite', why: 'lost', rung: 'full', at: 100 + NONE_RETRY_MS }))
  // A record of a loss under the full kernel, from before this rule, is not asked about again a day later.
  const u = store()
  saveKernelMemory(u, BIFROST, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 1000)
  assert.deepEqual(new KernelWatch(u, BIFROST, null, () => 1000 + LOST_RETRY_MS).plan, { from: 'lite', by: 'memory' })
})

test('lostBefore: a record of a loss learnt anywhere (another build, browser version or adapter) counts; a refusal, nothing or a corrupt value does not', () => {
  const raw = JSON.stringify(record())
  assert.equal(lostBefore(raw), true)
  assert.equal(lostBefore(JSON.stringify(record({ ua: 'Chrome/155.0.0.0', sources: 'ffffffff', adapter: 'qualcomm / adreno-6xx' }))), true, 'a browser update asks afresh, but the crash happened')
  assert.equal(lostBefore(JSON.stringify(record({ from: 'none', rung: 'lite' }))), true)
  assert.equal(lostBefore(JSON.stringify(record({ from: 'narrow', why: 'refused' }))), false)
  for (const bad of [null, '', 'x', '[]', '{}', 'null', '"lost"', raw.replace('"v":1', '"v":2'), raw.replace('"at":1000', '"at":"then"'), `${raw.slice(0, -1)},"pad":"${'x'.repeat(5000)}"}`]) assert.equal(lostBefore(bad), false, String(bad).slice(0, 40))
})

test('one boot: the record is written at a verdict and when the realm stands, never in between; a refusal makes the rung that stands the start of later visits; the full kernel standing forgets', () => {
  // The driver refuses the full kernel and the narrow one, cleanly: the light one stands and is where later starts begin.
  const s = store()
  const w = new KernelWatch(s, HERE, null, () => 50)
  assert.deepEqual(w.plan, { from: 'full', by: 'default' })
  assert.equal(w.memory, null)
  assert.equal(w.building, null, 'before the crowd\'s build began')
  w.note({ rung: 'full', step: 'trying' }, true)
  assert.equal(w.building, 'full')
  assert.equal(s.map.size, 0, 'trying writes nothing')
  w.note({ rung: 'full', step: 'refused', words: 'VK_ERROR_INITIALIZATION_FAILED' }, true)
  assert.equal(w.building, null, 'between rungs')
  w.note({ rung: 'narrow', step: 'trying' }, true)
  w.note({ rung: 'narrow', step: 'refused', words: 'VK_ERROR_UNKNOWN' }, true)
  w.note({ rung: 'lite', step: 'trying' }, true)
  w.note({ rung: 'lite', step: 'running' }, true)
  assert.equal(w.building, 'lite', 'built, its first reading still to come')
  assert.equal(s.map.size, 0, 'nothing is written before the realm stands: the first dispatch is still to come')
  w.stood('lite')
  assert.equal(w.building, null)
  assert.deepEqual(loadKernelMemory(s, HERE), record({ from: 'lite', why: 'refused', rung: 'narrow', words: 'VK_ERROR_UNKNOWN', at: 50 }))
  assert.equal(w.verdict, null)
  // Nothing after that is heard: a loss once the realm stands is no kernel's.
  w.note({ rung: 'lite', step: 'lost', words: GONE }, true)
  assert.equal(w.pageLost(GONE, true, true), null)
  assert.equal(w.lost('lite', GONE, true), null)
  assert.equal(loadKernelMemory(s, HERE)?.why, 'refused')
  // The next visit starts there, and writes nothing more (no refusal in that boot).
  const again = new KernelWatch(s, HERE, null, () => 60)
  assert.deepEqual(again.plan, { from: 'lite', by: 'memory' })
  again.note({ rung: 'lite', step: 'trying' }, true)
  again.note({ rung: 'lite', step: 'running' }, true)
  again.stood('lite')
  assert.equal(loadKernelMemory(s, HERE)?.at, 50)
  // ?kernel=full, and this time the full kernel stands (a browser fixed): nothing is held against the GPU any more.
  const fixed = new KernelWatch(s, HERE, 'full', () => 70)
  fixed.note({ rung: 'full', step: 'trying' }, true)
  fixed.note({ rung: 'full', step: 'running' }, true)
  assert.equal(s.map.size, 1, 'running alone forgets nothing')
  fixed.stood('full')
  assert.equal(s.map.size, 0)
  // No crowd asked for (?crowd=0): nothing learnt, nothing changed.
  saveKernelMemory(s, HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 75)
  new KernelWatch(s, HERE, null, () => 76).stood('none')
  assert.equal(loadKernelMemory(s, HERE)?.at, 75)
})

test('one boot: a loss in front keeps the light kernel, and a second under the same kernel a day later stands; a loss while hidden, between rungs or of the page\'s device alone blames no kernel', () => {
  // The GPU process goes while the full kernel compiles, the page in front: the light kernel is kept, the narrow one skipped.
  const s2 = store()
  const lost = new KernelWatch(s2, HERE, null, () => 80)
  lost.note({ rung: 'full', step: 'trying' }, true)
  const v = lost.pageLost(GONE, true, true)
  assert.deepEqual(v, verdict({ elapsedMs: 0 }))
  assert.deepEqual(loadKernelMemory(s2, HERE), record({ at: 80 }))
  // The worker's own report of the same loss changes nothing, nor anything else it still says: the first verdict stands.
  lost.note({ rung: 'full', step: 'lost', words: 'GPU device lost (unknown) while compiling crowd.wgsl: gone' }, true)
  lost.note({ rung: 'full', step: 'running' }, true)
  lost.stood('full')
  assert.equal(lost.verdict, v)
  assert.deepEqual(loadKernelMemory(s2, HERE), record({ at: 80 }), 'a late word from a worker under a failed boot wipes nothing')
  // The restart (the address's ?kernel=lite): the light kernel stands. The record stays as it was.
  const lite = new KernelWatch(s2, HERE, 'lite', () => 85)
  assert.deepEqual(lite.plan, { from: 'lite', by: 'address' })
  lite.note({ rung: 'lite', step: 'trying' }, true)
  lite.note({ rung: 'lite', step: 'running' }, true)
  lite.stood('lite')
  assert.deepEqual(loadKernelMemory(s2, HERE), record({ at: 80 }))
  // A day later the full kernel is asked once more. It goes down again: that stands, and is not asked a third time.
  const retry = new KernelWatch(s2, HERE, null, () => 80 + LOST_RETRY_MS)
  assert.deepEqual(retry.plan, { from: 'full', by: 'retry' })
  retry.note({ rung: 'full', step: 'trying' }, true)
  assert.deepEqual(retry.pageLost(GONE, true, true), verdict({ elapsedMs: 0 }))
  assert.deepEqual(loadKernelMemory(s2, HERE), record({ at: 80 + LOST_RETRY_MS, strikes: 2 }))
  assert.equal((kernelLostFailure(retry.verdict!, retry.plan) as KernelResetError).auto, true, 'the retry\'s loss restarts on the light kernel by itself')
  assert.deepEqual(new KernelWatch(s2, HERE, null, () => 80 + 30 * LOST_RETRY_MS).plan, { from: 'lite', by: 'memory' })
  // Had the retry stood instead (the first loss was another tab's, a driver since fixed): the record is forgotten.
  const s5 = store()
  saveKernelMemory(s5, HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 80)
  const well = new KernelWatch(s5, HERE, null, () => 80 + LOST_RETRY_MS)
  well.note({ rung: 'full', step: 'trying' }, true)
  well.note({ rung: 'full', step: 'running' }, true)
  well.stood('full')
  assert.equal(s5.map.size, 0)
  // A narrow kernel asked for again that stands forgets the record too: the next start learns the ladder afresh.
  saveKernelMemory(s5, HERE, { from: 'lite', why: 'lost', rung: 'narrow', words: GONE }, 80)
  const narrow = new KernelWatch(s5, HERE, null, () => 80 + LOST_RETRY_MS)
  assert.deepEqual(narrow.plan, { from: 'narrow', by: 'retry' })
  narrow.stood('narrow')
  assert.equal(s5.map.size, 0)

  // The light kernel goes down too (the restart's ?kernel=lite). Nothing is left; the hour begins.
  const s3 = store()
  saveKernelMemory(s3, HERE, { from: 'lite', why: 'lost', rung: 'full', words: GONE }, 80)
  const second = new KernelWatch(s3, HERE, 'lite', () => 90)
  second.note({ rung: 'lite', step: 'trying' }, true)
  second.note({ rung: 'lite', step: 'lost', words: GONE }, true)
  assert.deepEqual(second.verdict, verdict({ rung: 'lite', next: 'none', elapsedMs: 0, holdMs: NONE_RETRY_MS }))
  assert.deepEqual(new KernelWatch(s3, HERE, 'lite', () => 100).plan, { from: null, by: 'memory' })
  // ?kernel=full asks for everything again while 'none' still holds, and the full kernel goes down: nothing lighter is
  // left to go to, so the verdict is 'none' at once (not a restart on the light kernel, which would be a second crash),
  // and the record stands as it was, its time too.
  const everything = new KernelWatch(s3, HERE, 'full', () => 5000)
  assert.deepEqual(everything.plan, { from: 'full', by: 'address' })
  everything.note({ rung: 'full', step: 'trying' }, true)
  assert.deepEqual(everything.pageLost(GONE, true, true), verdict({ next: 'none', elapsedMs: 0, holdMs: 90 + NONE_RETRY_MS - 5000 }))
  assert.deepEqual(loadKernelMemory(s3, HERE), record({ from: 'none', rung: 'lite', at: 90 }), 'a loss never raises what the record holds')
  // After the hour the light kernel is asked once more; standing, it leaves one loss of the kernel above on record,
  // to be asked about a day later.
  const later = new KernelWatch(s3, HERE, null, () => 90 + NONE_RETRY_MS)
  assert.deepEqual(later.plan, { from: 'lite', by: 'memory' })
  later.note({ rung: 'lite', step: 'trying' }, true)
  later.stood('lite')
  assert.deepEqual(loadKernelMemory(s3, HERE), record({ at: 90 + NONE_RETRY_MS }))

  // A device lost with the first reading still to come ('running' told, the realm not yet up): the kernel's first dispatch.
  const first = new KernelWatch(store(), HERE, null, () => 1)
  first.note({ rung: 'full', step: 'trying' }, true)
  first.note({ rung: 'full', step: 'running' }, true)
  assert.deepEqual(first.pageLost(GONE, true, true), verdict({ elapsedMs: 0 }))

  // No kernel is blamed before the crowd's build began, between rungs, while the page was hidden (a phone takes the
  // GPU back from an app in the background), or for a loss of the page's device alone; and then nothing is kept.
  const s4 = store()
  const early = new KernelWatch(s4, HERE, null, () => 1)
  assert.equal(early.pageLost(GONE, true, true), null, 'before any rung')
  early.note({ rung: 'full', step: 'trying' }, false)
  assert.equal(early.pageLost(GONE, false, true), null, 'hidden')
  early.note({ rung: 'full', step: 'lost', words: GONE }, false)
  assert.equal(early.verdict, null)
  const between = new KernelWatch(s4, HERE, null, () => 1)
  between.note({ rung: 'full', step: 'trying' }, true)
  between.note({ rung: 'full', step: 'refused', words: 'no' }, true)
  assert.equal(between.pageLost(GONE, true, true), null, 'between rungs')
  const alone = new KernelWatch(s4, HERE, null, () => 1)
  alone.note({ rung: 'full', step: 'trying' }, true)
  assert.equal(alone.pageLost('GPU device lost (unknown): the driver reset this device', true, false), null, 'the page\'s device alone: the worker\'s kernel is not what went')
  assert.equal(s4.map.size, 0)
  // The worker then says its own device went under the kernel: that is the verdict.
  alone.note({ rung: 'full', step: 'lost', words: 'VK_ERROR_DEVICE_LOST' }, true)
  assert.deepEqual(alone.verdict, verdict({ words: 'VK_ERROR_DEVICE_LOST', elapsedMs: 0 }))

  // Storage that refuses: the verdict says it was not kept (the restart's address carries the kernel instead).
  const mute = new KernelWatch(store({ fail: true }), HERE, null, () => 1)
  mute.note({ rung: 'full', step: 'trying' }, true)
  assert.deepEqual(mute.pageLost(GONE, true, true), verdict({ saved: false, elapsedMs: 0 }))
  const none = new KernelWatch(null, HERE, null, () => 1)
  none.note({ rung: 'narrow', step: 'trying' }, true)
  assert.deepEqual(none.pageLost(GONE, true, true), verdict({ rung: 'narrow', saved: false, elapsedMs: 0 }))

  // How long after the kernel was asked for the GPU went, by the page's clock: under fifteen seconds is no watchdog.
  let clock = 1000
  const timed = new KernelWatch(store(), HERE, null, () => clock)
  timed.note({ rung: 'full', step: 'trying' }, true)
  clock = 4200
  assert.equal(timed.pageLost(GONE, true, true)?.elapsedMs, 3200)
  // The lightest kernel down twice running (the hour's retry lost it again): a day's rest.
  const s6 = store()
  saveKernelMemory(s6, HERE, { from: 'none', why: 'lost', rung: 'lite', words: GONE }, 0)
  const hourly = new KernelWatch(s6, HERE, null, () => NONE_RETRY_MS)
  assert.deepEqual(hourly.plan, { from: 'lite', by: 'memory' })
  hourly.note({ rung: 'lite', step: 'trying' }, true)
  assert.deepEqual(hourly.pageLost(GONE, true, true), verdict({ rung: 'lite', next: 'none', elapsedMs: 0, holdMs: LOST_RETRY_MS }))
  assert.equal(loadKernelMemory(s6, HERE)?.strikes, 2)
  // A refusal whose words name memory is the system short of it at that moment: the rung that stands is not kept.
  const s7 = store()
  const short = new KernelWatch(s7, HERE, null, () => 1)
  short.note({ rung: 'full', step: 'refused', words: 'CreateComputePipelines failed with VK_ERROR_OUT_OF_DEVICE_MEMORY' }, true)
  short.note({ rung: 'narrow', step: 'running' }, true)
  short.stood('narrow')
  assert.equal(s7.map.size, 0)
})

test('what a loss comes to: kernel-lost with the lighter kernel to restart on (by itself only when the address did not ask), kernel-none after the lightest; the words say which, and whether it was kept', () => {
  const env = { ua: HERE.ua, secure: true, standalone: false, native: false, origin: 'https://example.test', touchPoints: 5, href: 'https://example.test/city/?debug&crowd=512' }
  const auto = kernelLostFailure(verdict(), { from: 'full', by: 'default' })
  assert.ok(auto instanceof KernelResetError && auto instanceof WebGPUUnavailableError)
  assert.equal(auto.code, 'kernel-lost')
  assert.equal(auto.lighter, 'lite')
  assert.equal(auto.auto, true)
  assert.equal(auto.background, false)
  assert.equal(auto.message, `The GPU was lost while the full kernel of the crowd was being built (${GONE}). Restart asks for the light kernel (?kernel=lite); the page remembers it for later visits.`)
  // The record's own start (memory) restarts itself too; the address's own word never does: a page restarted with
  // ?kernel= cannot restart itself again, whatever storage keeps.
  assert.equal((kernelLostFailure(verdict({ rung: 'narrow' }), { from: 'narrow', by: 'memory' }) as KernelResetError).auto, true)
  // The time from the kernel being asked for to the loss is said where the page heard it.
  assert.equal(kernelLostFailure(verdict({ elapsedMs: 3249 }), { from: 'full', by: 'default' }).message, `The GPU was lost while the full kernel of the crowd was being built, 3.2 s after it was asked for (${GONE}). Restart asks for the light kernel (?kernel=lite); the page remembers it for later visits.`)
  const asked = kernelLostFailure(verdict({ saved: false, words: '' }), { from: 'full', by: 'address' })
  assert.ok(asked instanceof KernelResetError)
  assert.equal(asked.auto, false)
  assert.equal(asked.message, 'The GPU was lost while the full kernel of the crowd was being built (no message). Restart asks for the light kernel (?kernel=lite); this browser kept no note of it for later visits (no storage for this page).')
  // The card: its own kind, and Restart goes to the address with the lighter kernel, whatever the address said before.
  const card = classify(auto, env)
  assert.equal(card.kind, 'kernel-lost')
  assert.equal(card.headline, 'The browser’s graphics stopped while building the crowd')
  assert.equal(card.restartHref, 'https://example.test/city/?debug=&crowd=512&kernel=lite')
  assert.equal(classify(asked, { ...env, href: 'https://example.test/?kernel=full' }).restartHref, 'https://example.test/?kernel=lite')
  assert.equal(classify(auto, { ...env, href: '' }).restartHref, null, 'no address to carry it: Restart reloads')
  assert.equal(classify(new Error('GPU device lost (unknown): x'), env).restartHref, null, 'a plain reset restarts where it is')

  // After the lightest kernel: nothing left, no restart address, and the rest said (an hour, a day after the second time).
  const last = kernelLostFailure(verdict({ rung: 'lite', next: 'none', holdMs: NONE_RETRY_MS }), { from: 'lite', by: 'address' })
  assert.ok(!(last instanceof KernelResetError))
  assert.equal(last.code, 'kernel-none')
  assert.equal(last.message, `The GPU was lost while the light kernel of the crowd was being built (${GONE}). That is the lightest kernel: none is left to ask this GPU for. The city leaves this GPU alone for about an hour, then asks it for the light kernel once more; ?kernel=full in the address asks for everything again at once.`)
  assert.match(kernelLostFailure(verdict({ rung: 'lite', next: 'none', holdMs: LOST_RETRY_MS }), { from: 'lite', by: 'memory' }).message, /leaves this GPU alone for about 24 hours, then asks/)
  // A heavier kernel lost while 'none' still held: the same card, saying why nothing lighter is tried, and what is left of the rest.
  assert.match(kernelLostFailure(verdict({ next: 'none', holdMs: 25 * 60_000 }), { from: 'full', by: 'address' }).message,
    /the full kernel of the crowd was being built \(.*\)\. The light kernel took this GPU down on an earlier start as well: none is left to ask this GPU for\. The city leaves this GPU alone for about 25 minutes, then/)
  // Its card is true of that path too: the lightest kernel took the GPU out on an earlier start, the full one on this.
  const heldCard = classify(kernelLostFailure(verdict({ next: 'none', holdMs: 25 * 60_000 }), { from: 'full', by: 'address' }), env)
  assert.equal(heldCard.kind, 'kernel-none')
  assert.equal(heldCard.steps[0], 'The crowd’s lightest kernel took the GPU out of the browser, on this start or an earlier one, so no lighter kernel is left to ask it for; the details say which kernels were lost and when.')
  const noneCard = classify(last, env)
  assert.equal(noneCard.kind, 'kernel-none')
  assert.equal(noneCard.headline, 'The crowd’s lightest kernel stopped this device’s graphics')
  assert.equal(noneCard.restartHref, null)
  // The later start that asks nothing: the record in words.
  const held = kernelNoneFailure(record({ from: 'none', rung: 'lite' }), 1000 + 20 * 60_000)
  assert.equal(held.code, 'kernel-none')
  assert.equal(held.message, `The light kernel took this GPU down on an earlier start (${GONE}); no kernel is left to ask for. The city leaves this GPU alone for about 40 minutes, then asks it for the light kernel once more; ?kernel=full in the address asks for everything again at once.`)
  assert.match(kernelNoneFailure(record({ from: 'none', rung: 'lite' }), 1000 + NONE_RETRY_MS - 30_000).message, /alone for a minute, then/)
  assert.equal(kindOf(held, env), 'kernel-none', 'the code wins over the words (a loss\'s words alone read as a reset)')
  assert.equal(describeKernelMemory(record({ from: 'narrow', why: 'refused', rung: 'full', words: 'VK_ERROR_UNKNOWN' })), "this GPU's compiler refused the full kernel on an earlier start (VK_ERROR_UNKNOWN); starts begin at the full kernel at narrow workgroups")
  assert.equal(describeKernelMemory(record({ strikes: 2 })), `the full kernel took this GPU down on 2 earlier starts (${GONE}); starts begin at the light kernel`)
  // Where the browser kept nothing, the card does not promise an hour's rest it cannot keep.
  const unkept = kernelLostFailure(verdict({ rung: 'lite', next: 'none', saved: false, holdMs: NONE_RETRY_MS }), { from: 'lite', by: 'address' })
  assert.match(unkept.message, /none is left to ask this GPU for\. This browser kept no note of it \(no storage for this page\), so a restart asks this GPU again\.$/)
})
