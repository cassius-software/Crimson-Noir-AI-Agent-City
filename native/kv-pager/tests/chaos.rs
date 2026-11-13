// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It keeps a bounded slice of the chaos fuzzer (src/bin/chaos/core.rs) in `cargo test`, and
//! proves the fuzzer's own oracle and shrinker work, so a regression in the page table fails the ordinary test run. It
//! also runs the whole swarm at once: 1,024 agents on 16 threads sharing one table and one pinned prefix while their
//! routers pick experts every layer, and it holds the log-odds eviction to its two promises (the same order for the
//! same operations; never fewer cached tokens than least-recently-used on the replayed workloads).
//! What breaks if it is removed? Only the full `chaos` binary would catch a page-table regression.

#[path = "../src/bin/chaos/core.rs"]
#[allow(dead_code)]
mod core;
#[path = "../src/bin/chaos/evict.rs"]
#[allow(dead_code)]
mod evict;

use crate::core::{generate, run, run_with, shrink_by, Keying, Op, Rng, World};
use kv_pager::weights::gguf::write::{header, Meta, Tensor};
use kv_pager::weights::gguf::{Gguf, UnitKey, WeightIndex};
use kv_pager::weights::swarm::{group_swarm_by_expert, IoCost, Regime, Route, SwarmScheduler};
use kv_pager::{AgentId, Eviction, LogOdds, PageError, PageTable, Token, BLOCK_TOKENS};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Barrier, Mutex};

#[test]
fn chaotic_streams_keep_every_promise_under_every_keying() {
    for seed in 0..300u64 {
        for (capacity, keying) in [(6, Keying::Chain), (24, Keying::Colliding), (12, Keying::Private), (64, Keying::Chain)] {
            let stream = generate(&mut Rng(seed), 400);
            let stats = run(&stream, capacity, keying).unwrap_or_else(|e| panic!("seed {seed}, pool {capacity}, {keying:?}: {e}"));
            assert_eq!((stats.false_refusals, stats.orphaned_blocks, stats.reclaims), (0, 0, 1));
        }
    }
}

#[test]
fn a_stream_that_exercises_refusal_copy_on_write_and_waves_does_so() {
    let mut total = crate::core::Stats::default();
    for seed in 0..50 {
        total.merge(&run(&generate(&mut Rng(seed), 1000), 8, Keying::Chain).unwrap());
    }
    assert!(total.refusals > 0 && total.cow_copies > 0 && total.waves > 0 && total.prefix_hit_tokens > 0, "{total:?}");
}

#[test]
fn the_shrinker_finds_the_minimal_failing_stream() {
    // A failure that needs exactly two waves and one fork, anywhere in a 2,000-op stream: the minimum is those 3 ops.
    let fails = |ops: &[Op]| {
        ops.iter().filter(|o| matches!(o, Op::Wave { .. })).count() >= 2 && ops.iter().any(|o| matches!(o, Op::Fork { .. }))
    };
    let stream = generate(&mut Rng(11), 2000);
    assert!(fails(&stream));
    let s = shrink_by(&stream, fails);
    assert_eq!(s.len(), 3, "{s:?}");
    assert!(fails(&s));
}

#[test]
fn chaotic_streams_keep_every_promise_under_least_recently_used_eviction_too() {
    for seed in 0..100u64 {
        for (capacity, keying) in [(6, Keying::Chain), (24, Keying::Colliding), (12, Keying::Private)] {
            let stream = generate(&mut Rng(seed), 400);
            let stats = run_with(&stream, capacity, keying, Eviction::Lru)
                .unwrap_or_else(|e| panic!("seed {seed}, pool {capacity}, {keying:?}, LRU: {e}"));
            assert_eq!((stats.false_refusals, stats.orphaned_blocks, stats.reclaims), (0, 0, 1));
        }
    }
}

/// A mixture-of-experts model's index from its header alone: 4 layers of 64 experts, 4 per token.
fn swarm_model() -> WeightIndex {
    let t = |name: String, dims: &[u64], ggml_type: u32| Tensor { name, dims: dims.to_vec(), ggml_type };
    let mut ts = vec![t("token_embd.weight".into(), &[256, 64], 1)];
    for l in 0..4 {
        ts.push(t(format!("blk.{l}.attn_q.weight"), &[256, 256], 12));
        ts.push(t(format!("blk.{l}.ffn_gate_inp.weight"), &[256, 64], 0));
        ts.push(t(format!("blk.{l}.ffn_gate_exps.weight"), &[256, 256, 64], 12));
        ts.push(t(format!("blk.{l}.ffn_up_exps.weight"), &[256, 256, 64], 12));
        ts.push(t(format!("blk.{l}.ffn_down_exps.weight"), &[256, 256, 64], 8));
    }
    let meta = [
        ("general.architecture", Meta::Str("qwen3moe".into())),
        ("qwen3moe.block_count", Meta::U32(4)),
        ("qwen3moe.expert_count", Meta::U32(64)),
        ("qwen3moe.expert_used_count", Meta::U32(4)),
    ];
    let (head, places) = header(&meta, &ts, 32);
    let len = places.last().map_or(head.len() as u64, |&(at, size)| at + size);
    WeightIndex::build(&Gguf::parse(&head, len).unwrap()).unwrap()
}

/// An agent's router at one layer of one step: 4 distinct experts of 64, a hash of who, when and where.
fn route(agent: AgentId, step: u32, layer: u32) -> Route {
    let mut rng = Rng(u64::from(agent) << 20 ^ u64::from(step) << 8 ^ u64::from(layer));
    let mut experts = Vec::new();
    while experts.len() < 4 {
        let e = rng.below(64) as u32;
        if !experts.contains(&e) {
            experts.push(e);
        }
    }
    Route { agent, experts }
}

/// The leader's check of one layer of the whole swarm: the groups are exactly the routes turned inside out, and the
/// plan reads every routed expert (or the whole layer) once.
fn check_layer(planner: &SwarmScheduler, index: &WeightIndex, layer: u32, routes: &[Route]) -> Result<(), String> {
    let groups = group_swarm_by_expert(routes);
    let asked: BTreeSet<(u32, AgentId)> = routes.iter().flat_map(|r| r.experts.iter().map(move |&e| (e, r.agent))).collect();
    let grouped: BTreeSet<(u32, AgentId)> = groups.iter().flat_map(|g| g.agents.iter().map(move |&a| (g.expert, a))).collect();
    let pairs: usize = groups.iter().map(|g| g.agents.len()).sum();
    if asked != grouped || pairs != asked.len() {
        return Err(format!("layer {layer}: {} routed pairs, {} grouped ({} distinct)", asked.len(), pairs, grouped.len()));
    }
    if !groups.windows(2).all(|w| w[0].expert < w[1].expert) || !groups.iter().all(|g| g.agents.windows(2).all(|w| w[0] < w[1])) {
        return Err(format!("layer {layer}: groups out of order"));
    }
    let plan = planner.plan_layer(layer, routes, &|_| false);
    let mut want = vec![UnitKey::Layer(layer)];
    match plan.regime {
        Regime::WholeLayer => want.extend((0..index.experts).map(|expert| UnitKey::Expert { layer, expert })),
        Regime::RoutedExperts => want.extend(groups.iter().map(|g| UnitKey::Expert { layer, expert: g.expert })),
    }
    if plan.units != want {
        return Err(format!("layer {layer}: {:?} plan reads other units", plan.regime));
    }
    // Each unit's bytes land whole where the plan says (a long span is split over several reads).
    let extents: Vec<_> = want.iter().flat_map(|&k| index.unit(k).unwrap().extents.iter().copied()).collect();
    if extents.len() != plan.reads.placements.len() {
        return Err(format!("layer {layer}: {} extents, {} placements", extents.len(), plan.reads.placements.len()));
    }
    for (e, p) in extents.iter().zip(&plan.reads.placements) {
        let (mut need, end) = (p.at, p.at + p.len);
        for r in &plan.reads.reads {
            if need < end && r.at <= need && need < r.at + r.len {
                if r.offset + (need - r.at) != e.offset + (need - p.at) {
                    return Err(format!("layer {layer}: {} bytes at {} land on other bytes", e.len, e.offset));
                }
                need = r.at + r.len;
            }
        }
        if p.len != e.len || need < end {
            return Err(format!("layer {layer}: {} bytes at {} are not read whole", e.len, e.offset));
        }
    }
    Ok(())
}

#[test]
fn a_swarm_of_1024_agents_routed_to_experts_on_one_pinned_prefix_never_corrupts_the_table() {
    const THREADS: u32 = 16;
    const PER_THREAD: u32 = 64;
    const ROUNDS: u32 = 3;
    const STEPS: u32 = 4;
    let index = swarm_model();
    let planner = SwarmScheduler::new(&index, IoCost::NVME, 64 << 10);
    // The pool holds the pinned prefix and every agent's own pages only if some agents are refused: about 1,500 private
    // pages are asked for at the peak of a round, 1,200 exist.
    let pt = Mutex::new(PageTable::new(1_200));
    // The organisation's prompt (enterprise, site, area), pinned: two full pages and a partly filled third.
    let base: Vec<Token> = (0..2 * BLOCK_TOKENS as Token + 8).collect();
    let (pin, _) = pt.lock().unwrap().pin(&base).unwrap();
    let routes: Mutex<Vec<Route>> = Mutex::new(Vec::new());
    let barrier = Barrier::new(THREADS as usize);
    let failures: Mutex<Vec<String>> = Mutex::new(Vec::new());
    let fail = |m: String| failures.lock().unwrap().push(m);
    let refusals = std::sync::atomic::AtomicU64::new(0);
    std::thread::scope(|s| {
        for t in 0..THREADS {
            let (pt, routes, barrier, base, index, planner, fail, refusals) =
                (&pt, &routes, &barrier, &base, &index, &planner, &fail, &refusals);
            s.spawn(move || {
                for round in 0..ROUNDS {
                    // Spawn: half the agents share every page of the pin (its last page copied when they write into it),
                    // half are admitted with the prompt and a line of their own (its full pages found in the cache).
                    let mut mine: HashMap<AgentId, Vec<Token>> = HashMap::new();
                    for i in 0..PER_THREAD {
                        let a = t * 100_000 + round * 1_000 + i;
                        let mut g = pt.lock().unwrap();
                        if i % 2 == 0 {
                            g.fork_pin(pin, a).unwrap();
                            mine.insert(a, base.clone());
                        } else {
                            let mut p = base.clone();
                            p.extend((0..8).map(|j| 1_000_000 + a * 8 + j));
                            match g.admit(a, &p) {
                                Ok(adm) if adm.cached_tokens < 2 * BLOCK_TOKENS => {
                                    fail(format!("agent {a}: only {} of the pinned prefix's tokens shared", adm.cached_tokens))
                                }
                                Ok(_) => {
                                    mine.insert(a, p);
                                }
                                Err(PageError::OutOfBlocks { .. }) => {
                                    refusals.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                }
                                Err(e) => fail(format!("agent {a}: {e:?}")),
                            }
                        }
                    }
                    for step in 0..STEPS {
                        // Every layer: each thread's agents route; once every thread has, the leader groups and plans
                        // the whole swarm's layer and checks the table while everyone waits.
                        let mut last: HashMap<AgentId, u32> = HashMap::new();
                        for layer in 0..index.layers {
                            let ours: Vec<Route> = mine.keys().map(|&a| route(a, round * STEPS + step, layer)).collect();
                            for r in &ours {
                                last.insert(r.agent, r.experts.iter().sum());
                            }
                            routes.lock().unwrap().extend(ours);
                            if barrier.wait().is_leader() {
                                let mut all = routes.lock().unwrap();
                                if let Err(e) = check_layer(planner, index, layer, &all) {
                                    fail(format!("round {round}, step {step}: {e}"));
                                }
                                all.clear();
                                if let Err(e) = pt.lock().unwrap().check() {
                                    fail(format!("round {round}, step {step}, layer {layer}: {e}"));
                                }
                            }
                            barrier.wait();
                        }
                        // The step's token, appended; an agent the pool cannot grow is released whole.
                        let ids: Vec<AgentId> = mine.keys().copied().collect();
                        for a in ids {
                            let tok = 2_000_000 + last[&a] * 64 + step;
                            let mut g = pt.lock().unwrap();
                            match g.append(a, tok) {
                                Ok(_) => mine.get_mut(&a).unwrap().push(tok),
                                Err(PageError::OutOfBlocks { .. }) => {
                                    refusals.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                    g.release(a).unwrap();
                                    mine.remove(&a);
                                }
                                Err(e) => fail(format!("agent {a}: {e:?}")),
                            }
                        }
                        let g = pt.lock().unwrap();
                        for (a, toks) in &mine {
                            if g.tokens_of(*a).as_ref() != Some(toks) {
                                fail(format!("round {round}, step {step}: agent {a} reads back other tokens"));
                            }
                        }
                    }
                    let mut g = pt.lock().unwrap();
                    for a in mine.keys() {
                        g.release(*a).unwrap();
                    }
                    drop(g);
                    barrier.wait();
                }
            });
        }
    });
    let failures = failures.into_inner().unwrap();
    assert!(failures.is_empty(), "{} failures, first: {:?}", failures.len(), &failures[..failures.len().min(5)]);
    let mut g = pt.into_inner().unwrap();
    // While pinned, the prefix's pages are mapped by the pin alone and were never evicted.
    let st = g.stats();
    assert_eq!((g.agents(), g.pins(), st.mapped), (0, 1, 3), "{st:?}");
    g.unpin(pin).unwrap();
    g.check().unwrap();
    let st = g.stats();
    assert_eq!((st.mapped, st.free + st.idle_cached), (0, st.capacity), "{st:?}");
    assert!(refusals.into_inner() > 0, "the pool was meant to be too small for the whole swarm");
}

/// Every idle block in eviction order with its evidence, after each of a stream's operations.
fn eviction_trace(ops: &[Op], capacity: usize, policy: Eviction) -> Vec<Vec<(u32, u64)>> {
    let mut w = World::new(capacity, Keying::Chain, 0, policy);
    let mut trace = Vec::new();
    for &op in ops {
        w.apply(op);
        trace.push(w.pt.eviction_order().into_iter().map(|b| (b, w.pt.reuse_log_odds(b).to_bits())).collect());
    }
    trace
}

#[test]
fn the_log_odds_eviction_order_is_a_function_of_the_operations_alone() {
    // Two tables in one process hash with different random seeds; the order must not depend on them.
    let policy = Eviction::LogOdds(LogOdds::default());
    for seed in 0..40u64 {
        let stream = generate(&mut Rng(seed), 600);
        for capacity in [8, 32] {
            let (a, b) = (eviction_trace(&stream, capacity, policy), eviction_trace(&stream, capacity, policy));
            assert_eq!(a, b, "seed {seed}, pool {capacity}");
        }
    }
    // The same for the city's 1,024 agents through a small pool: two replays serve exactly the same.
    let (a, b) = (evict::city(policy, 1_024, 1_500, 96, 3), evict::city(policy, 1_024, 1_500, 96, 3));
    assert_eq!(a, b);
}

#[test]
fn the_default_eviction_never_keeps_fewer_cached_tokens_than_lru_on_the_replayed_workloads() {
    let (lru, odds) = (Eviction::Lru, PageTable::new(1).eviction());
    assert_eq!(odds, Eviction::LogOdds(LogOdds::default()));
    for pages in [8, 32] {
        let (mut a, mut b) = (0u64, 0u64);
        for seed in 0..60 {
            let stream = generate(&mut Rng(seed), 1_000);
            a += run_with(&stream, pages, Keying::Chain, lru).unwrap().prefix_hit_tokens;
            b += run_with(&stream, pages, Keying::Chain, odds).unwrap().prefix_hit_tokens;
        }
        assert!(b >= a, "fuzzer streams, {pages} pages: LRU {a}, log-odds {b}");
    }
    let (a, b) = (evict::city(lru, 256, 3_000, 120, 7), evict::city(odds, 256, 3_000, 120, 7));
    assert!(b.cached_tokens >= a.cached_tokens, "city: LRU {a:?}, log-odds {b:?}");
    // One-off prompts flooding the pool: LRU loses the popular families every burst, log-odds keeps them.
    for drift in [0, 100] {
        let (a, b) = (evict::scan(lru, 600, 64, 10, drift, 7), evict::scan(odds, 600, 64, 10, drift, 7));
        assert!(b.hit_rate() > a.hit_rate() + 0.2, "scan, drift {drift}: LRU {:.3}, log-odds {:.3}", a.hit_rate(), b.hit_rate());
    }
}
