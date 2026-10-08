// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Stage 04: the chaos run (CPU only, no GPU, no network).
//!
//! Why does this file exist? It drives the fuzzer's engine (core.rs) at volume: many seeds across worker threads,
//! pools from 4 to 128 pages under all three keyings, and a shared-table mode where threads spawn and despawn on one
//! table behind a mutex. It prints the fragmentation statistics and, for any failure, the seed and the shrunk stream.
//! What breaks if it is removed? Nothing ships with it; the day-run report has no fuzz numbers.
//!
//! cargo run --release --bin chaos -- [--seeds 20000] [--ops 2000] [--workers 8] [--shared-threads 8] [--shared-ops 200000]

mod core;

use crate::core::{generate, run, shrink, Keying, Op, Rng, Stats};
use kv_pager::{AgentId, PageTable, Token, BLOCK_TOKENS};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Instant;

const CAPACITIES: [usize; 6] = [4, 8, 16, 32, 64, 128];

fn setup(seed: u64) -> (usize, Keying) {
    let keying = match seed % 5 {
        0 => Keying::Colliding,
        1 => Keying::Private,
        _ => Keying::Chain,
    };
    (CAPACITIES[(seed / 5 % CAPACITIES.len() as u64) as usize], keying)
}

struct Failure {
    seed: u64,
    capacity: usize,
    keying: Keying,
    message: String,
    shrunk: Vec<Op>,
}

/// Threads spawn, grow, fork and despawn their own agents on one table; every op holds the lock only for itself, so
/// their operations interleave arbitrarily. Each thread checks its own agents after every op.
fn shared_table(threads: usize, ops: usize, capacity: usize) -> Result<(u64, u64), String> {
    let pt = Arc::new(Mutex::new(PageTable::new(capacity)));
    let handles: Vec<_> = (0..threads)
        .map(|t| {
            let pt = Arc::clone(&pt);
            std::thread::spawn(move || -> Result<u64, String> {
                let mut rng = Rng(0xc0ffee ^ (t as u64) << 32);
                let mut mine: HashMap<AgentId, Vec<Token>> = HashMap::new();
                let mut next = (t as AgentId) << 24;
                let mut refusals = 0u64;
                for _ in 0..ops {
                    let ids: Vec<AgentId> = mine.keys().copied().collect();
                    let mut g = pt.lock().map_err(|_| "poisoned")?;
                    match rng.below(10) {
                        0..=2 => {
                            // A shared prefix across threads: pages shared between threads' agents.
                            let mut p: Vec<Token> = (0..BLOCK_TOKENS as Token + 3).collect();
                            p.extend((0..rng.below(40)).map(|_| rng.below(4) as Token));
                            match g.admit(next, &p) {
                                Ok(_) => { mine.insert(next, p); }
                                Err(_) => refusals += 1,
                            }
                            next += 1;
                        }
                        3 if !ids.is_empty() => {
                            let parent = ids[rng.below(ids.len() as u64) as usize];
                            g.fork(parent, next).map_err(|e| format!("{e:?}"))?;
                            mine.insert(next, mine[&parent].clone());
                            next += 1;
                        }
                        4..=6 if !ids.is_empty() => {
                            let a = ids[rng.below(ids.len() as u64) as usize];
                            let tok = rng.below(4) as Token;
                            match g.append(a, tok) {
                                Ok(_) => mine.get_mut(&a).unwrap().push(tok),
                                Err(_) => refusals += 1,
                            }
                        }
                        7..=9 if !ids.is_empty() => {
                            let a = ids[rng.below(ids.len() as u64) as usize];
                            g.release(a).map_err(|e| format!("{e:?}"))?;
                            mine.remove(&a);
                        }
                        _ => {}
                    }
                    g.check().map_err(|e| format!("thread {t}: {e}"))?;
                    for (a, toks) in &mine {
                        if &g.tokens_of(*a).ok_or("lost agent")? != toks {
                            return Err(format!("thread {t}: agent {a} reads back other tokens"));
                        }
                    }
                }
                let mut g = pt.lock().map_err(|_| "poisoned")?;
                for a in mine.keys() {
                    g.release(*a).map_err(|e| format!("{e:?}"))?;
                }
                Ok(refusals)
            })
        })
        .collect();
    let mut refusals = 0;
    for h in handles {
        refusals += h.join().map_err(|_| "a thread panicked".to_string())??;
    }
    let g = pt.lock().unwrap();
    g.check()?;
    let s = g.stats();
    if s.mapped != 0 || s.free + s.idle_cached != s.capacity {
        return Err(format!("after every thread left: {s:?}"));
    }
    Ok((refusals, (threads * ops) as u64))
}

fn main() {
    let mut seeds = 20_000u64;
    let mut ops = 2_000usize;
    let mut workers = std::thread::available_parallelism().map_or(4, |n| n.get());
    let mut shared_threads = 8usize;
    let mut shared_ops = 200_000usize;
    let mut first_seed = 0u64;
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        let v: u64 = it.next().and_then(|v| v.parse().ok()).unwrap_or_else(|| panic!("{k} needs a number"));
        match k.as_str() {
            "--seeds" => seeds = v,
            "--ops" => ops = v as usize,
            "--workers" => workers = v as usize,
            "--shared-threads" => shared_threads = v as usize,
            "--shared-ops" => shared_ops = v as usize,
            "--first-seed" => first_seed = v,
            _ => panic!("unknown argument {k}"),
        }
    }
    std::panic::set_hook(Box::new(|_| {})); // failures are reported below, shrunk, not as raw panics

    let t = Instant::now();
    let results: Vec<(Stats, Vec<Failure>)> = std::thread::scope(|s| {
        let hs: Vec<_> = (0..workers as u64)
            .map(|w| {
                s.spawn(move || {
                    let mut stats = Stats::default();
                    let mut fails = Vec::new();
                    let mut seed = first_seed + w;
                    while seed < first_seed + seeds {
                        let (capacity, keying) = setup(seed);
                        let stream = generate(&mut Rng(seed), ops);
                        match run(&stream, capacity, keying) {
                            Ok(st) => stats.merge(&st),
                            Err(message) => {
                                let shrunk = shrink(&stream, capacity, keying);
                                fails.push(Failure { seed, capacity, keying, message, shrunk });
                            }
                        }
                        seed += workers as u64;
                    }
                    (stats, fails)
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().expect("worker")).collect()
    });
    let mut total = Stats::default();
    let mut fails: Vec<Failure> = Vec::new();
    for (s, f) in results {
        total.merge(&s);
        fails.extend(f);
    }
    let secs = t.elapsed().as_secs_f64();
    let n = total.ops.max(1) as f64;
    println!("chaos: {seeds} seeds x {ops} ops on {workers} workers, pools {CAPACITIES:?} pages, keyings chain/colliding/private: {:.1} s", secs);
    println!("  ops {} ({:.2} M/s): spawns {}, forks {}, appends {}, despawns {} (in {} mass waves), refusals {}", total.ops, n / secs / 1e6, total.spawns, total.forks, total.appends, total.despawns, total.waves, total.refusals);
    println!("  copy-on-write copies {}, prefix-cache hit tokens {}, full-pool reclaims {}", total.cow_copies, total.prefix_hit_tokens, total.reclaims);
    println!("  internal fragmentation (empty slots of mapped pages): mean {:.1} %, max {:.1} %", 100.0 * total.frag_sum / n, 100.0 * total.frag_max);
    println!("  idle cached pages: mean {:.1} % of the pool; peak occupancy (mapped + cached) {:.1} %", 100.0 * total.idle_sum / n, 100.0 * total.peak_occupancy);
    println!("  false refusals {}, orphaned blocks {}", total.false_refusals, total.orphaned_blocks);
    println!("  failing seeds: {}", fails.len());
    for f in fails.iter().take(10) {
        println!("  FAIL seed {} (pool {}, {:?}): {}\n    shrunk to {} ops: {:?}", f.seed, f.capacity, f.keying, f.message, f.shrunk.len(), f.shrunk);
    }

    let t = Instant::now();
    match shared_table(shared_threads, shared_ops / shared_threads.max(1), 48) {
        Ok((refusals, n)) => println!("shared table: {shared_threads} threads x {} ops on one 48-page table: every invariant after every op, every page back at the end ({refusals} refusals, {:.1} s)", n / shared_threads.max(1) as u64, t.elapsed().as_secs_f64()),
        Err(e) => {
            println!("shared table: FAIL: {e}");
            std::process::exit(1);
        }
    }
    if !fails.is_empty() {
        std::process::exit(1);
    }
}
