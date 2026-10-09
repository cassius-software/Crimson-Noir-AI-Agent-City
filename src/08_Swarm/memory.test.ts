// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the swarm's memory (memory.ts). A ledger is keyed by the world seed and the
 * pedestrian's number, never by a recruitment's serial (which goes into each episode instead). Episodes are kept in
 * the order they happen, the newest LEDGER_LIMIT of them, each cut to one short line; a prompt gets the newest RECALL
 * of the people tethered now, including what happened while their ledger was being loaded. Forgetting is exact: one
 * person, or one city, never another city. The recruiter's arrivals and releases are written with the right serial
 * (the worker's list has already dropped a released person), and a task's note reaches every person it was bound to.
 * A store that cannot open falls back to this visit's memory. (The IndexedDB store itself is proven in the browser.)
 * The chain: every episode's hash links to the one before it from the ledger's root to its head; an episode edited,
 * inserted or removed in storage breaks the chain where it happened, a prompt carries nothing past the break, the
 * console says where it is, and a ledger that has dropped its oldest still verifies from the root it carries; an ask
 * records the hash of the system prompt it was given, and the console lists it.
 * What breaks if it is removed? A person could remember another city, lose their history on a new recruitment, or be
 * remembered wrongly, and a payload slipped into a ledger would be read back, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sha256 } from '../02_Define_The_Rules/integrity.ts'
import type { RecruitView } from '../07_Execute_Actions/simProtocol.ts'
import {
  ago, appended, audit, chainLine, clipText, deferredLedger, emptyLedger, EPISODE_CHARS, followRecruiter, GENESIS, isEpisode, isEpisodeBody, LEDGER_LIMIT,
  ledgerKey, ledgerLine, ledgerOf, link, memoryBridge, memoryLedger, placeIndex, RECALL, recollection, SwarmMemory, type Episode, type EpisodeBody, type Ledger,
  type LedgerStore,
} from './memory.ts'

const T0 = Date.UTC(2026, 8, 28, 16, 0, 0)

/** A memory over a fresh in-memory store, its clock stepping a second per episode. */
function fresh(seed = 1337, store: LedgerStore = memoryLedger()) {
  let t = T0
  return { memory: new SwarmMemory(store, seed, () => (t += 1000)), store }
}

const view = (agent: number, serial: number, skills: string[]): RecruitView => ({
  agent, serial, skill: skills[0], state: 'Active', arrived: true, skills, distance: 1.5, x: 1, z: 2, seconds: 5,
})

/** The recruiter as the memory follows it: its newest list, and its events. */
class Feed extends EventTarget {
  recruits: readonly RecruitView[] = []
  active(v: RecruitView): void {
    this.recruits = [...this.recruits.filter((r) => r.agent !== v.agent), v]
    this.dispatchEvent(new CustomEvent('active', { detail: { agent: v.agent, skill: v.skill, skills: [...v.skills] } }))
  }
  released(agent: number, skill: string, reason: string): void {
    // The worker's list drops them before the event is dispatched (recruitment.ts).
    this.recruits = this.recruits.filter((r) => r.agent !== agent)
    this.dispatchEvent(new CustomEvent('released', { detail: { agent, skill, reason } }))
  }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** An episode without its hash, for comparing what was remembered. */
const body = (e: Episode): EpisodeBody => ({
  at: e.at, serial: e.serial, kind: e.kind, skills: e.skills, text: e.text,
  ...(e.state !== undefined && { state: e.state }), ...(e.promptHash !== undefined && { promptHash: e.promptHash }),
})

/** A ledger built from bodies in order, chained from GENESIS (what appended must produce for episodes in time order). */
const chained = (bodies: EpisodeBody[], limit = LEDGER_LIMIT): Ledger => bodies.reduce((l, e) => appended(l, e, limit), emptyLedger())

test('a ledger is the world seed and the pedestrian\'s number; nothing else makes a key', () => {
  assert.equal(ledgerKey(1337, 17), '1337:17')
  assert.equal(ledgerKey(0, 0), '0:0')
  for (const [seed, agent] of [[-1, 1], [1.5, 1], [1, -2], [1, 2.5], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY]]) {
    assert.throws(() => ledgerKey(seed, agent), TypeError, `${seed}:${agent}`)
  }
  assert.throws(() => new SwarmMemory(memoryLedger(), -1), TypeError)
})

test('episodes are kept in the order they happen, with their serial, each one short line, each chained to the one before; the newest LEDGER_LIMIT stay', async () => {
  const { memory, store } = fresh()
  await memory.record(17, { serial: 3, kind: 'tethered', skills: ['Rust', 'Python'], text: '' })
  await memory.record(17, { serial: 3, kind: 'ask', skills: ['Rust'], text: 'how does\n\ncar.grip   work? → Grip scales tyre friction.', state: 'Authorized' })
  const list = await memory.ledger(17)
  const first: EpisodeBody = { at: T0 + 1000, serial: 3, kind: 'tethered', skills: ['Rust', 'Python'], text: '' }
  const second: EpisodeBody = { at: T0 + 2000, serial: 3, kind: 'ask', skills: ['Rust'], text: 'how does car.grip work? → Grip scales tyre friction.', state: 'Authorized' }
  const h1 = link(first, GENESIS)
  assert.deepEqual(list, [{ ...first, hash: h1 }, { ...second, hash: link(second, h1) }])
  assert.equal(h1, sha256(`{"at":${T0 + 1000},"kind":"tethered","serial":3,"skills":["Rust","Python"],"text":""}${GENESIS}`), 'the link: the canonical body, then the hash before')
  assert.deepEqual(await store.keys(''), ['1337:17'], 'keyed by the seed and the number, not the serial')
  const stored = await memory.read(17)
  assert.deepEqual([stored.root, stored.head], [GENESIS, list[1].hash], 'a ledger carries its root and its head')
  assert.deepEqual(audit(stored), { intact: true, verified: 2 })
  assert.equal(clipText('x'.repeat(EPISODE_CHARS + 50)).length, EPISODE_CHARS)
  assert.ok(clipText('x'.repeat(EPISODE_CHARS + 50)).endsWith('…'))
  for (let i = 0; i < LEDGER_LIMIT + 5; i++) void memory.record(18, { serial: 4, kind: 'run', skills: ['Go'], text: `script ${i}`, state: 'Authorized' })
  const long = await memory.read(18)
  assert.equal(long.episodes.length, LEDGER_LIMIT)
  assert.deepEqual([long.episodes[0].text, long.episodes.at(-1)?.text], ['script 5', `script ${LEDGER_LIMIT + 4}`], 'the oldest went first')
  assert.deepEqual(audit(long), { intact: true, verified: LEDGER_LIMIT }, 'the chain still verifies from the root the ledger carries')
  assert.notEqual(long.root, GENESIS, 'the root is the hash of the last episode dropped')
  assert.equal(long.episodes[0].hash, link(long.episodes[0], long.root))
  await assert.rejects(memory.record(17, { serial: 1.5, kind: 'say', skills: [], text: 'x' }), TypeError)
  await assert.rejects(memory.record(17, { serial: 1, kind: 'ask', skills: [], text: 'x', promptHash: 'not a digest' }), TypeError)
})

test('the same person asked over again remembers the earlier recruitment; a new serial never starts a new ledger', async () => {
  const { memory } = fresh()
  const feed = new Feed()
  followRecruiter(memory, feed)
  feed.active(view(17, 3, ['Rust', 'Python']))
  feed.released(17, 'Rust', 'left behind (12.4 m)')
  feed.active(view(17, 9, ['Rust', 'Python']))
  await settle()
  const list = await memory.ledger(17)
  assert.deepEqual(list.map((e) => [e.serial, e.kind, e.text]), [[3, 'tethered', ''], [3, 'released', 'left behind (12.4 m)'], [9, 'tethered', '']])
  // Someone let go before they ever arrived has nothing to remember.
  feed.released(40, 'Go', 'dismissed')
  await settle()
  assert.deepEqual(await memory.ledger(40), [])
})

test('recall: the newest RECALL episodes of the people tethered now, including what happened while their ledger loaded', async () => {
  const { memory } = fresh()
  for (let i = 0; i < RECALL + 3; i++) await memory.record(17, { serial: 1, kind: 'say', skills: ['Rust'], text: `line ${i}`, state: 'Authorized' })
  assert.deepEqual(memory.recall(17), [], 'not held: nothing to recall without a read')
  const loading = memory.hold(17)
  // Recorded while the read is on its way: stored after it, held all the same.
  void memory.record(17, { serial: 2, kind: 'tethered', skills: ['Rust'], text: '' })
  const held = await loading
  assert.equal(held.length, RECALL + 4)
  assert.deepEqual(memory.recall(17).map((e) => e.text), [...Array.from({ length: RECALL - 1 }, (_, i) => `line ${i + 4}`), ''])
  assert.equal(memory.recall(17).at(-1)?.kind, 'tethered')
  await memory.record(17, { serial: 2, kind: 'ask', skills: ['Rust'], text: 'q → a', state: 'Aborted' })
  assert.equal(memory.recall(17).at(-1)?.text, 'q → a', 'held ledgers follow new episodes at once')
  assert.deepEqual(memory.recall(17), (await memory.ledger(17)).slice(-RECALL), 'the held copy and the stored one agree, hashes and all')
  memory.release(17)
  assert.deepEqual(memory.recall(17), [])
  // Released while it loads: nothing is held.
  const late = memory.hold(17)
  memory.release(17)
  await late
  assert.deepEqual(memory.recall(17), [])
})

test('forget is exact: one person, or one city; another city is never touched; the people list follows', async () => {
  const store = memoryLedger()
  const a = fresh(1337, store).memory
  const b = fresh(42, store).memory
  for (const m of [a, b]) for (const agent of [1, 2, 3]) await m.record(agent, { serial: 1, kind: 'tethered', skills: ['Go'], text: '' })
  assert.deepEqual(await a.people(), [1, 2, 3])
  await a.hold(2)
  assert.equal(await a.forget(2), 1)
  assert.equal(await a.forget(2), 0, 'nothing left to forget')
  assert.deepEqual(a.recall(2), [], 'a held ledger is forgotten too')
  assert.deepEqual(await a.people(), [1, 3])
  assert.equal(await a.forget('all'), 2)
  assert.deepEqual(await a.people(), [])
  assert.deepEqual(await b.people(), [1, 2, 3], 'the other city remembers everything')
  // 13370 starts with '1337' but is another city.
  const c = fresh(13370, store).memory
  await c.record(5, { serial: 1, kind: 'tethered', skills: ['Go'], text: '' })
  await fresh(1337, store).memory.forget('all')
  assert.deepEqual(await c.people(), [5])
})

test('a task\'s note reaches every person it was bound to, with their own serial; the prompt lines are theirs; an ask notes its prompt hash', async () => {
  const { memory } = fresh()
  await memory.hold(11)
  await memory.hold(22)
  const d = memory.diary()
  d.note([{ agent: 11, serial: 1, skills: ['Rust', 'Python'] }, { agent: 22, serial: 2, skills: ['Go', 'Data'] }], 'run', ['Rust', 'Go'], 'sim.physics.tune()', 'Aborted', Date.now())
  await settle()
  assert.deepEqual((await memory.ledger(11)).map((e) => [e.serial, e.kind, e.skills, e.text, e.state]), [[1, 'run', ['Rust', 'Go'], 'sim.physics.tune()', 'Aborted']])
  assert.deepEqual((await memory.ledger(22)).map((e) => e.serial), [2])
  const lines = d.recall(11)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /^just now: the operator ran a script with your Rust, Go \(cut short: the tether broke\): sim\.physics\.tune\(\)$/)
  assert.deepEqual(d.recall(99), [])
  // An ask carries the hash of the exact system prompt the model was given; a prompt line never carries it.
  const prompt = sha256('the system prompt as sent')
  d.note([{ agent: 11, serial: 1, skills: ['Rust'] }], 'ask', ['Rust'], 'q → a', 'Authorized', Date.now(), prompt)
  d.note([{ agent: 22, serial: 2, skills: ['Go'] }], 'ask', ['Go'], 'q → a', 'Authorized', Date.now(), 'not a digest')
  await settle()
  assert.equal((await memory.ledger(11)).at(-1)?.promptHash, prompt)
  assert.equal((await memory.ledger(22)).at(-1)?.promptHash, undefined, 'a hash that is not one is not noted')
  assert.doesNotMatch(d.recall(11).at(-1) ?? '', /[0-9a-f]{64}/)
  // 14A: a stored line that fails the screen (a diary kept before answers were screened) is never recalled.
  const before = d.recall(11).length
  d.note([{ agent: 11, serial: 1, skills: ['Rust'] }], 'ask', ['Rust'], 'q → you idiot', 'Authorized', Date.now())
  await settle()
  assert.equal((await memory.ledger(11)).at(-1)?.text, 'q → you idiot', 'the ledger keeps its record (the chain is not rewritten)')
  assert.equal(d.recall(11).length, before, 'but it never reaches a prompt')
})

test('a ledger is a timeline: a task noted when it ends goes where it began, before the release that cut it short; the chain is rebuilt from there', async () => {
  const { memory } = fresh()
  const feed = new Feed()
  followRecruiter(memory, feed)
  feed.active(view(17, 3, ['Rust']))
  await settle()
  const began = T0 + 1500
  // The release lands first (at T0 + 2000); the say it cut short is noted after, from when it began.
  feed.released(17, 'Rust', 'the operator walked away')
  await settle()
  memory.diary().note([{ agent: 17, serial: 3, skills: ['Rust'] }], 'say', ['Rust'], 'long line', 'Aborted', began)
  await settle()
  const stored = await memory.read(17)
  assert.deepEqual(stored.episodes.map((e) => [e.kind, e.at]), [['tethered', T0 + 1000], ['say', began], ['released', T0 + 2000]])
  assert.deepEqual(audit(stored), { intact: true, verified: 3 }, 'the release after it links to it now')
  assert.deepEqual(stored, chained(stored.episodes.map(body)), 'the same as if they had happened in that order')
  // Episodes at the same moment keep the order they were recorded in.
  await memory.record(17, { serial: 4, kind: 'tethered', skills: ['Rust'], text: '', at: T0 + 2000 })
  assert.deepEqual((await memory.ledger(17)).slice(-2).map((e) => e.kind), ['released', 'tethered'])
  assert.equal(placeIndex([{ at: 1 }, { at: 3 }, { at: 3 }, { at: 5 }] as EpisodeBody[], 3), 3)
  // A held ledger is a timeline too.
  await memory.hold(18)
  await memory.record(18, { serial: 1, kind: 'say', skills: [], text: 'b', at: T0 + 9000 })
  await memory.record(18, { serial: 1, kind: 'say', skills: [], text: 'a', at: T0 + 8000 })
  assert.deepEqual(memory.recall(18).map((e) => e.text), ['a', 'b'])
  assert.deepEqual(memory.recall(18), (await memory.ledger(18)), 'held and stored agree after an insertion')
})

test('the chain: an episode edited, inserted or removed in storage breaks it where it happened; recall stops there; a wrong head or root is caught', () => {
  const e = (i: number, over: Partial<EpisodeBody> = {}): EpisodeBody => ({ at: T0 + i * 1000, serial: 1, kind: 'say', skills: ['Go'], text: `line ${i}`, state: 'Authorized', ...over })
  const good = chained([e(1), e(2), e(3), e(4), e(5)])
  assert.deepEqual(audit(good), { intact: true, verified: 5 })
  assert.equal(good.head, good.episodes[4].hash)
  const edited: Ledger = { ...good, episodes: good.episodes.map((ep, i) => (i === 2 ? { ...ep, text: 'line 3, but not what was said' } : ep)) }
  assert.deepEqual(audit(edited), { intact: false, verified: 2, fault: 'episode 3 of 5 does not link to episode 2' })
  const inserted: Ledger = { ...good, episodes: [...good.episodes.slice(0, 1), { ...good.episodes[1], at: T0 + 1500, text: 'slipped in' }, ...good.episodes.slice(1)] }
  assert.deepEqual(audit(inserted), { intact: false, verified: 1, fault: 'episode 2 of 6 does not link to episode 1' })
  const removed: Ledger = { ...good, episodes: good.episodes.filter((_, i) => i !== 1) }
  assert.deepEqual(audit(removed), { intact: false, verified: 1, fault: 'episode 2 of 4 does not link to episode 1' })
  const truncated: Ledger = { ...good, episodes: good.episodes.slice(0, 4) }
  assert.deepEqual(audit(truncated), { intact: false, verified: 4, fault: 'the head is not the hash of episode 4' })
  const reRooted: Ledger = { ...good, root: sha256('elsewhere') }
  assert.deepEqual(audit(reRooted), { intact: false, verified: 0, fault: 'episode 1 of 5 does not link to the root' })
  assert.deepEqual(audit(emptyLedger()), { intact: true, verified: 0 })
  assert.deepEqual(audit({ ...emptyLedger(), head: '' }), { intact: false, verified: 0, fault: 'the head is not the hash of the root' })
  // An insertion by the memory itself never mends a break: what did not link keeps its hash and still does not.
  const later = appended(edited, e(6), LEDGER_LIMIT)
  assert.deepEqual(audit(later), { intact: false, verified: 2, fault: 'episode 3 of 6 does not link to episode 2' })
  const before = appended(edited, e(0), LEDGER_LIMIT)
  assert.deepEqual(audit(before), { intact: false, verified: 3, fault: 'episode 4 of 6 does not link to episode 3' })
  assert.equal(before.episodes[3].hash, edited.episodes[2].hash, 'the edited episode keeps the hash it had')
  // The words the console uses.
  assert.equal(chainLine(good), `chain intact (head ${good.head.slice(0, 12)})`)
  assert.equal(chainLine(edited), 'chain broken: episode 3 of 5 does not link to episode 2 (recall stops at episode 2)')
  assert.equal(chainLine(reRooted), 'chain broken: episode 1 of 5 does not link to the root (recall stops at nothing)')
})

test('a prompt carries nothing past a break: a held ledger tampered in storage recalls only the verified prefix, and new episodes after it stay out', async () => {
  // A store the test can reach into (memoryLedger keeps its map to itself).
  const bodies = new Map<string, Ledger>()
  const store: LedgerStore = {
    kind: 'memory',
    read: async (key) => bodies.get(key) ?? emptyLedger(),
    append: async (key, e, limit) => { bodies.set(key, appended(bodies.get(key) ?? emptyLedger(), e, limit)) },
    keys: async (prefix) => [...bodies.keys()].filter((k) => k.startsWith(prefix)).sort(),
    remove: async (key) => bodies.delete(key),
    removeAll: async () => 0,
  }
  const { memory } = fresh(1337, store)
  for (let i = 1; i <= 4; i++) await memory.record(7, { serial: 1, kind: 'say', skills: ['Go'], text: `line ${i}`, state: 'Authorized' })
  // Edited behind the memory's back: the third episode's text.
  const stored = bodies.get('1337:7')!
  bodies.set('1337:7', { ...stored, episodes: stored.episodes.map((e, i) => (i === 2 ? { ...e, text: 'a hidden payload' } : e)) })
  await memory.hold(7)
  assert.deepEqual(memory.recall(7).map((e) => e.text), ['line 1', 'line 2'], 'the recall stops at the break')
  await memory.record(7, { serial: 1, kind: 'say', skills: ['Go'], text: 'line 5', state: 'Authorized' })
  assert.deepEqual(memory.recall(7).map((e) => e.text), ['line 1', 'line 2'], 'nothing after the break reaches a prompt')
  assert.deepEqual(memory.diary().recall(7).length, 2)
  const bridge = memoryBridge(memory, { recruits: [view(7, 1, ['Go'])] }, () => T0 + 60_000)
  assert.deepEqual(await bridge.status(), [
    'memory: 1 person remembered in this city (seed 1337), kept for this visit only (this browser refused storage)',
    'agent 7 (Go): 5 episodes, chain broken: episode 3 of 5 does not link to episode 2 (recall stops at episode 2), last just now: say',
    '  weights: none yet (replayed from the chain)',
  ])
  const lines = await bridge.ledger(7)
  assert.equal(lines.length, 7, 'five episodes, the break, and the weights')
  assert.equal(lines[6], '-- weights: none yet (replayed from the chain) --')
  assert.equal(lines[2], '-- chain broken: episode 3 of 5 does not link to episode 2 (recall stops at episode 2) --', 'marked where it breaks')
  assert.match(lines[3], /a hidden payload$/)
  // Forgotten: the chain starts again from the root.
  await memory.forget(7)
  await memory.record(7, { serial: 2, kind: 'tethered', skills: ['Go'], text: '' })
  assert.deepEqual(memory.recall(7).map((e) => e.kind), ['tethered'])
  assert.deepEqual(audit(await memory.read(7)), { intact: true, verified: 1 })
})

test('how a person remembers each kind of episode, and how the console lists it (an ask with the prompt it was given)', () => {
  const at = T0
  const e = (over: Partial<EpisodeBody>): EpisodeBody => ({ at, serial: 3, kind: 'ask', skills: ['Rust'], text: 'q → a', ...over })
  const now = T0 + 5 * 60_000
  assert.equal(recollection(e({ kind: 'tethered', skills: ['Rust', 'Python'], text: '' }), now), '5 min ago: you were asked over for Rust, Python and joined the operator')
  assert.equal(recollection(e({ kind: 'released', text: 'left behind (12.4 m)' }), now), '5 min ago: you left the operator (left behind (12.4 m))')
  assert.equal(recollection(e({ kind: 'ask', state: 'Authorized' }), now), '5 min ago: the operator asked you about Rust: q → a')
  assert.equal(recollection(e({ kind: 'ask', state: 'Authorized', promptHash: sha256('p') }), now), '5 min ago: the operator asked you about Rust: q → a', 'the model never sees a hash')
  assert.equal(recollection(e({ kind: 'say', text: 'over here', state: 'Rejected' }), now), '5 min ago: you said aloud (refused): over here')
  assert.deepEqual([ago(T0, T0 + 59_000), ago(T0, T0 + 3 * 3600_000), ago(T0, T0 + 86400_000), ago(T0, T0 + 3 * 86400_000), ago(T0 + 5000, T0)], ['just now', '3 h ago', '1 day ago', '3 days ago', 'just now'])
  const local = new Date(at)
  const hh = String(local.getHours()).padStart(2, '0'), mm = String(local.getMinutes()).padStart(2, '0'), ss = String(local.getSeconds()).padStart(2, '0')
  assert.equal(ledgerLine(e({ kind: 'tethered', skills: ['Rust', 'Python'], text: '' }), at), `${hh}:${mm}:${ss}  #3  tethered · Rust, Python`)
  assert.equal(ledgerLine(e({ state: 'Aborted' }), at), `${hh}:${mm}:${ss}  #3  ask (Aborted) · q → a`)
  assert.equal(ledgerLine(e({ state: 'Authorized', promptHash: sha256('p') }), at), `${hh}:${mm}:${ss}  #3  ask · q → a  prompt ${sha256('p')}`)
  assert.match(ledgerLine(e({}), at + 3 * 86400_000), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} {2}#3 {2}ask · q → a$/, 'another day: the date too')
})

test('only a well-formed, chained episode is read back (storage can hold anything); a row from before the chain is an empty ledger', () => {
  const ok: Episode = { at: T0, serial: 1, kind: 'say', skills: ['Go'], text: 'x', state: 'Authorized', hash: link({ at: T0, serial: 1, kind: 'say', skills: ['Go'], text: 'x', state: 'Authorized' }, GENESIS) }
  assert.ok(isEpisode(ok))
  assert.ok(isEpisodeBody({ ...ok, promptHash: sha256('p') }))
  for (const bad of [null, 7, {}, { ...ok, at: 'now' }, { ...ok, serial: 1.5 }, { ...ok, kind: 'dream' }, { ...ok, skills: 'Go' }, { ...ok, skills: [1] }, { ...ok, text: null }, { ...ok, state: 'Maybe' }, { ...ok, promptHash: 'abc' }]) {
    assert.equal(isEpisodeBody(bad), false, JSON.stringify(bad))
  }
  for (const bad of [{ ...ok, hash: undefined }, { ...ok, hash: 'abc' }, { ...ok, hash: ok.hash.toUpperCase() }]) assert.equal(isEpisode(bad), false, JSON.stringify(bad))
  assert.deepEqual(ledgerOf(undefined), emptyLedger())
  assert.deepEqual(ledgerOf({ key: '1:1', episodes: [{ at: T0, serial: 1, kind: 'say', skills: [], text: 'old' }] }), emptyLedger(), 'before the chain: nothing well-formed')
  const row = { key: '1:1', episodes: [ok, { not: 'an episode' }], root: GENESIS, head: ok.hash }
  assert.deepEqual(ledgerOf(row), { episodes: [ok], root: GENESIS, head: ok.hash })
  assert.deepEqual(audit(ledgerOf({ ...row, head: 7 })), { intact: false, verified: 1, fault: 'the head is not the hash of episode 1' }, 'a head that is not a digest is not mended')
})

test('a store that cannot open falls back to this visit\'s memory; one that opens says so', async () => {
  const failed = deferredLedger(Promise.reject(new DOMException('refused', 'SecurityError')))
  const m = new SwarmMemory(failed, 7)
  await m.record(1, { serial: 1, kind: 'tethered', skills: ['Go'], text: '' })
  assert.equal((await m.ledger(1)).length, 1)
  assert.equal(failed.kind, 'memory')
  const opened = deferredLedger(Promise.resolve({ ...memoryLedger(), kind: 'indexeddb' as const }))
  assert.equal(opened.kind, 'memory', 'until it opens')
  await opened.keys('')
  assert.equal(opened.kind, 'indexeddb')
})

test('the console\'s view: where it is kept, who is here, what they remember and whether the chain holds; forget in words', async () => {
  const { memory } = fresh()
  const feed = new Feed()
  followRecruiter(memory, feed)
  feed.active(view(11, 1, ['Rust', 'Python']))
  await settle()
  await memory.record(11, { serial: 1, kind: 'ask', skills: ['Rust'], text: 'q → a', state: 'Authorized' })
  await memory.record(30, { serial: 2, kind: 'tethered', skills: ['Go'], text: '' })
  const bridge = memoryBridge(memory, feed, () => T0 + 60_000)
  const head = (await memory.read(11)).head
  assert.deepEqual(await bridge.status(), [
    'memory: 2 people remembered in this city (seed 1337), kept for this visit only (this browser refused storage)',
    `agent 11 (Rust, Python): 2 episodes, chain intact (head ${head.slice(0, 12)}), last just now: ask`,
    '  weights: none yet (replayed from the chain)',
  ])
  assert.equal((await bridge.ledger(11)).length, 3, 'an intact ledger lists its episodes, then its weights')
  assert.deepEqual(await bridge.ledger(99), ['agent 99 remembers nothing in this city'])
  assert.equal(await bridge.forget(30), 'agent 30 remembers nothing now')
  assert.equal(await bridge.forget(30), 'agent 30 had nothing to forget')
  assert.equal(await bridge.forget('all'), 'forgot 1 person in this city')
  const kept = memoryBridge(new SwarmMemory({ ...memoryLedger(), kind: 'indexeddb' }, 5), { recruits: [] })
  assert.deepEqual(await kept.status(), ['memory: 0 people remembered in this city (seed 5), kept on this machine between visits'])
})

test('the console reads where the memory is kept when asked: IndexedDB opens after the page is up', async () => {
  let open: (s: LedgerStore) => void = () => {}
  const store = deferredLedger(new Promise<LedgerStore>((r) => { open = r }))
  const bridge = memoryBridge(new SwarmMemory(store, 9), { recruits: [] })
  open({ ...memoryLedger(), kind: 'indexeddb' })
  assert.deepEqual(await bridge.status(), ['memory: 0 people remembered in this city (seed 9), kept on this machine between visits'])
})

test('unsubscribed, the memory stops following the recruiter', async () => {
  const { memory } = fresh()
  const feed = new Feed()
  const off = followRecruiter(memory, feed)
  off()
  feed.active(view(11, 1, ['Rust']))
  await settle()
  assert.deepEqual(await memory.ledger(11), [])
})
