// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the property-based fuzzing of the kv-pager page table (native/kv-pager, carried as
 * kvPager.wasm.ts) against a reference model of what it holds (each agent's sequence length), seeded and replayable
 * (02_Define_The_Rules/property.ts): thousands of random spawns, forks, appends and despawns, with agent ids that exist
 * and ones that do not, prompts that share pages and ones that do not, on pools small enough to run out. After every
 * call the table's own invariant check holds, every live agent's length is the model's, an unknown agent is refused
 * as one, a call that fails changes nothing (out of pages included), the pool's counts add up (every block free,
 * cached idle or mapped; no more shared than mapped; never more mapped than the agents' pages), and with every agent
 * gone nothing stays mapped.
 * What breaks if it is removed? A call order nobody tried could break the table's accounting, and `ask` would report
 * counts nobody checked.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { forAll } from '../02_Define_The_Rules/property.ts'
import { PAGE_TOKENS, kvPagerWasmBytes, type KvExports } from './prefixCache.ts'

const ERR = { pages: -1, unknown: -2, exists: -3, invariant: -4 }
const { instance } = await WebAssembly.instantiate(kvPagerWasmBytes(), {})
const e = instance.exports as unknown as KvExports

test('the page table is its reference over random spawns, forks, appends and despawns, on pools that run out', () => {
  forAll('kv-pager', { seed: 0x9a6e, runs: 300 }, (g) => ({ seed: g.int(0, 2 ** 31), pool: g.pick([2, 4, 8, 16, 64]), ops: g.int(20, 300) }), (c) => {
    const g = (() => { let s = c.seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32) })()
    const int = (lo: number, hi: number) => lo + Math.floor(g() * (hi - lo + 1))
    const h = e.kv_new(c.pool, 512)
    assert.ok(h !== 0)
    try {
      const model = new Map<number, number>()
      const pages = (n: number) => Math.ceil(n / PAGE_TOKENS)
      // A few shared prompts, so spawns find cached pages.
      const prompts = Array.from({ length: 3 }, () => Array.from({ length: int(0, 70) }, () => int(1, 9)))
      const agent = (): number => (g() < 0.8 && model.size > 0 ? [...model.keys()][int(0, model.size - 1)] : int(1, 40))
      for (let i = 0; i < c.ops; i++) {
        const before = new Map(model)
        const op = int(0, 3)
        let r: number
        if (op === 0) {
          const a = agent()
          const tokens = g() < 0.6 ? prompts[int(0, 2)] : Array.from({ length: int(0, 60) }, () => int(1, 1000))
          new Uint32Array(e.memory.buffer, e.kv_scratch(h), tokens.length).set(tokens)
          r = e.kv_spawn(h, a, tokens.length)
          if (model.has(a)) assert.equal(r, ERR.exists, `spawn ${a} again`)
          else if (r >= 0) model.set(a, tokens.length)
          else assert.equal(r, ERR.pages)
        } else if (op === 1) {
          const p = agent(), child = int(1, 40)
          r = e.kv_fork(h, p, child)
          // Both refusals can apply (an unknown parent onto a child that exists): either is the truth.
          if (!model.has(p) && model.has(child)) assert.ok(r === ERR.unknown || r === ERR.exists, `fork ${p} to ${child}: ${r}`)
          else if (!model.has(p)) assert.equal(r, ERR.unknown, `fork from ${p}`)
          else if (model.has(child)) assert.equal(r, ERR.exists, `fork to ${child}`)
          else if (r >= 0) model.set(child, model.get(p)!)
          else assert.equal(r, ERR.pages)
        } else if (op === 2) {
          const a = agent()
          r = e.kv_append(h, a, int(1, 1000))
          if (!model.has(a)) assert.equal(r, ERR.unknown, `append to ${a}`)
          else if (r >= 0) model.set(a, model.get(a)! + 1)
          else assert.equal(r, ERR.pages)
        } else {
          const a = agent()
          r = e.kv_despawn(h, a)
          if (!model.has(a)) assert.equal(r, ERR.unknown, `despawn ${a}`)
          else {
            assert.ok(r >= 0)
            model.delete(a)
          }
        }
        // After every call: the table's own invariants, every length the model's, a failed call changed nothing.
        assert.equal(e.kv_check(h), 0, `op ${i}: invariant`)
        if (r < 0) assert.deepEqual(model, before)
        for (let a = 1; a <= 40; a++) assert.equal(e.kv_len(h, a), model.has(a) ? model.get(a)! : ERR.unknown, `op ${i}: agent ${a}`)
        assert.equal(e.kv_stats(h), 0)
        const s = new Uint32Array(e.memory.buffer, e.kv_out(h), 8)
        const [capacity, free, idle, mapped, shared, , , agents] = s
        assert.equal(capacity, c.pool)
        assert.equal(free + idle + mapped, capacity, 'every block free, cached idle or mapped')
        assert.ok(shared <= mapped)
        let most = 0, all = 0
        for (const n of model.values()) {
          most = Math.max(most, pages(n))
          all += pages(n)
        }
        assert.ok(mapped >= most && mapped <= all, `mapped ${mapped} for agents of ${most}..${all} pages`)
        assert.equal(agents, model.size)
      }
      for (const a of [...model.keys()]) assert.ok(e.kv_despawn(h, a) >= 0)
      assert.equal(e.kv_stats(h), 0)
      assert.equal(new Uint32Array(e.memory.buffer, e.kv_out(h), 8)[3], 0, 'nothing mapped once every agent is gone')
      assert.equal(e.kv_check(h), 0)
    } finally {
      e.kv_free(h)
    }
  })
})
