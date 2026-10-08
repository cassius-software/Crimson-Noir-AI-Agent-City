// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the adversarial property suite over the core's public API: the branchless kernels,
//! the Global Matrix and its scripted run, the bitonic network and the configuration parser, driven by a seeded
//! splitmix64 so every failing case names the seed that replays it. Each test pins a bound the design claims and an
//! attacker would want broken: a tick touches only the agent's own row and block whatever the row holds (masks of
//! all ones, a clock past its cap, weights at the i32 extremes, a goal past the stations, a position off the floor
//! or not a number); visiting order, repetition and a fork cannot change a tick or the scripted run; flush zeroes
//! exactly one block; the learning rule cannot leave the reward's range for any reachable input and any shift the
//! type allows; the relaxation is a true shortest path on any floor; spawn fills exactly the declared counts; the
//! network sorts whatever the reference sorts; and no mutation of containment.nix panics the parser while only a
//! faithful text validates, its canonical form describing itself. Two tests are regressions for the Phase 16 audit's
//! findings (named in their comments) and fail until config.rs is fixed. It runs on three validator-accepted
//! configurations: the shipped one and the two extremes of the ranges the validator allows.
//! What breaks if it is removed? The kernels' memory bounds, determinism and the parser's robustness are checked
//! only on the shipped configuration and the happy path.

use std::collections::VecDeque;
use std::panic::{AssertUnwindSafe, catch_unwind};

use noir_core::config::{
    CAP_LEARN, CAP_MOVE, CAP_ROUTE, Config, Dims, canonical, declared_bytes, digest_hex, locked_digest, parse, validate,
};
use noir_core::kernels::{FATE_DOCKED, FATE_FLUSHED, FATE_REAPED, INF, Tally, agent_tick, flush, relax_pass, step_of, tick, tick_scalar};
use noir_core::lanes::{LANES, PACKED};
use noir_core::matrix::{self, GOLDEN_TICKS, Matrix, fingerprint, golden, golden_begin, golden_step, row_is_zero};
use noir_core::sort::{NETWORK8, bitonic_sort, is_sorted, network, reference_sort, run_network, zero_one_proof};

const SAMPLE: &str = include_str!("../../../containment.nix");
const LOCK: &str = include_str!("../../../containment.lock");

// ---------------------------------------------------------------------------------------------------------------
// A seeded PRNG (splitmix64): every case a test draws is replayable from the seed its message prints.

struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    fn u32(&mut self) -> u32 {
        self.next() as u32
    }

    /// 0..n.
    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len())]
    }

    fn one_in(&mut self, k: usize) -> bool {
        self.below(k) == 0
    }

    /// One of the edge values, or (one time in three) any word at all.
    fn word(&mut self, edges: &[u32]) -> u32 {
        if self.one_in(3) { self.u32() } else { self.pick(edges) }
    }

    fn shuffle<T>(&mut self, xs: &mut [T]) {
        for k in (1..xs.len()).rev() {
            let j = self.below(k + 1);
            xs.swap(k, j);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The configurations under test, and the matrix helpers the crate does not export (copy, diff).

fn config(edits: &[(&str, &str)]) -> Config {
    let mut src = String::from(SAMPLE);
    for (from, to) in edits {
        assert!(src.contains(from), "the sample holds {from:?}");
        src = src.replacen(from, to, 1);
    }
    validate(&parse(&src).unwrap_or_else(|e| panic!("{e}"))).unwrap_or_else(|e| panic!("{e}"))
}

/// The shipped configuration, the smallest the validator accepts (pool, floor, stations, block, terminal), and the
/// widest (floor, stations, block, every kernel knob at its far end).
fn configs() -> Vec<Config> {
    vec![
        config(&[]),
        config(&[
            ("capacity = 4096;", "capacity = 64;"),
            ("blockWords = 64;", "blockWords = 8;"),
            ("width = 64;", "width = 32;"),
            ("depth = 64;", "depth = 32;"),
            ("stations = 8;", "stations = 2;"),
            ("learnShift = 3;", "learnShift = 1;"),
            ("count = 3072;", "count = 40;"),
            ("count = 1023;", "count = 23;"),
            ("cells = 16384;", "cells = 2048;"),
            ("stack = 256;", "stack = 16;"),
            ("stepBudget = 5000000;", "stepBudget = 1000;"),
            ("lines = 256;", "lines = 16;"),
        ]),
        config(&[
            ("capacity = 4096;", "capacity = 128;"),
            ("blockWords = 64;", "blockWords = 1024;"),
            ("width = 64;", "width = 256;"),
            ("depth = 64;", "depth = 32;"),
            ("stations = 8;", "stations = 16;"),
            ("loopLimit = 100;", "loopLimit = 2;"),
            ("stepEighths = 1;", "stepEighths = 8;"),
            ("learnShift = 3;", "learnShift = 15;"),
            ("explore = 2048;", "explore = 65536;"),
            ("count = 3072;", "count = 100;"),
            ("count = 1023;", "count = 27;"),
        ]),
    ]
}

fn roles(c: &Config) -> (Vec<u32>, Vec<u32>) {
    (c.roles.iter().map(|r| r.count).collect(), c.roles.iter().map(|r| r.caps).collect())
}

/// The world laid out, routed and spawned.
fn world(c: &Config) -> Matrix {
    let d = &c.dims;
    let mut m = matrix::new(d);
    matrix::lay_out_world(d, &mut m);
    matrix::route(d, &mut m);
    let (counts, caps) = roles(c);
    matrix::spawn(d, &counts, &caps, &mut m);
    m
}

fn copy(d: &Dims, m: &Matrix) -> Matrix {
    let mut c = matrix::new(d);
    c.px.copy_from_slice(&m.px);
    c.pz.copy_from_slice(&m.pz);
    for (to, from) in [
        (&mut c.alive, &m.alive),
        (&mut c.doomed, &m.doomed),
        (&mut c.caps, &m.caps),
        (&mut c.req, &m.req),
        (&mut c.role, &m.role),
        (&mut c.goal, &m.goal),
        (&mut c.run, &m.run),
        (&mut c.last, &m.last),
        (&mut c.trips, &m.trips),
        (&mut c.clock, &m.clock),
        (&mut c.heading, &m.heading),
        (&mut c.fate, &m.fate),
        (&mut c.memory, &m.memory),
        (&mut c.walls, &m.walls),
        (&mut c.field, &m.field),
        (&mut c.scratch, &m.scratch),
        (&mut c.station, &m.station),
    ] {
        to.copy_from_slice(from);
    }
    c.weights.copy_from_slice(&m.weights);
    c
}

/// Every (array, index) whose bits differ between two matrices.
fn diff(a: &Matrix, b: &Matrix) -> Vec<(&'static str, usize)> {
    let mut out = Vec::new();
    let mut words = |name: &'static str, x: &[u32], y: &[u32]| {
        assert_eq!(x.len(), y.len(), "{name}");
        out.extend(x.iter().zip(y).enumerate().filter(|(_, (p, q))| p != q).map(|(k, _)| (name, k)));
    };
    let bits = |v: &[f32]| v.iter().map(|f| f.to_bits()).collect::<Vec<u32>>();
    words("px", &bits(&a.px), &bits(&b.px));
    words("pz", &bits(&a.pz), &bits(&b.pz));
    for (name, x, y) in [
        ("alive", &a.alive, &b.alive),
        ("doomed", &a.doomed, &b.doomed),
        ("caps", &a.caps, &b.caps),
        ("req", &a.req, &b.req),
        ("role", &a.role, &b.role),
        ("goal", &a.goal, &b.goal),
        ("run", &a.run, &b.run),
        ("last", &a.last, &b.last),
        ("trips", &a.trips, &b.trips),
        ("clock", &a.clock, &b.clock),
        ("heading", &a.heading, &b.heading),
        ("fate", &a.fate, &b.fate),
        ("memory", &a.memory, &b.memory),
        ("walls", &a.walls, &b.walls),
        ("field", &a.field, &b.field),
        ("scratch", &a.scratch, &b.scratch),
        ("station", &a.station, &b.station),
    ] {
        words(name, x, y);
    }
    let w = |v: &[i32]| v.iter().map(|&i| i as u32).collect::<Vec<u32>>();
    words("weights", &w(&a.weights), &w(&b.weights));
    out
}

/// Whether a change at (array, index) lies in slot `i`'s own row, weights or block.
fn own(d: &Dims, i: usize, name: &str, at: usize) -> bool {
    match name {
        "weights" => at / d.stations == i,
        "memory" => at / d.block_words == i,
        "walls" | "field" | "scratch" | "station" => false,
        _ => at == i,
    }
}

/// A position: on the floor, at its edges, past them, negative, not a number, infinite, or any bits at all.
fn position(r: &mut Rng, extent: usize) -> f32 {
    match r.below(10) {
        0 => 0.0,
        1 => 0.5,
        2 => extent as f32 - 0.125,
        3 => extent as f32,
        4 => -1.0,
        5 => f32::NAN,
        6 => f32::INFINITY,
        7 => f32::NEG_INFINITY,
        8 => r.below(extent * 8) as f32 * 0.125,
        _ => f32::from_bits(r.u32()),
    }
}

/// Fills slot `i`'s row, weights and block with edge values.
fn scramble(r: &mut Rng, d: &Dims, m: &mut Matrix, i: usize) {
    let s = d.stations as u32;
    m.px[i] = position(r, d.width);
    m.pz[i] = position(r, d.depth);
    m.alive[i] = r.word(&[0, 1, 1, 1, 2, u32::MAX, 0x8000_0000]);
    m.doomed[i] = r.word(&[0, 0, 1, 2, u32::MAX, u32::MAX - 1]);
    m.caps[i] = r.word(&[0, 1, 15, 31, 9, 11, 1 << 31, u32::MAX]);
    m.req[i] = r.word(&[0, 0, 0, 16, 1 << 31, u32::MAX]);
    m.role[i] = r.word(&[0, 1, 2, u32::MAX]);
    m.goal[i] = r.word(&[0, s - 1, s, u32::MAX]);
    m.run[i] = r.word(&[0, d.loop_limit - 1, d.loop_limit, u32::MAX]);
    m.last[i] = r.u32();
    m.trips[i] = r.word(&[0, u32::MAX]);
    m.clock[i] = r.word(&[0, 63, 64, 1 << 20, (1 << 20) + 1, u32::MAX]);
    m.heading[i] = r.word(&[0, 1, 2, 3, 4, u32::MAX]);
    m.fate[i] = r.word(&[0, 15]);
    for w in &mut m.weights[i * d.stations..(i + 1) * d.stations] {
        *w = r.word(&[0, 65536, 65537, 1, u32::MAX, i32::MIN as u32, i32::MAX as u32]) as i32;
    }
    for w in &mut m.memory[i * d.block_words..(i + 1) * d.block_words] {
        *w = r.u32();
    }
}

/// The shared world at an extreme: no walls, all walls, a random floor; stations anywhere; fields of any value.
fn scramble_world(r: &mut Rng, d: &Dims, m: &mut Matrix) {
    let cells = d.width * d.depth;
    match r.below(4) {
        0 => m.walls.fill(0),
        1 => m.walls.fill(1),
        2 => m.walls.iter_mut().for_each(|w| *w = r.word(&[0, 1, 2, u32::MAX])),
        _ => matrix::lay_out_world(d, m),
    }
    for s in &mut m.station {
        *s = r.below(cells) as u32;
    }
    match r.below(3) {
        0 => m.field.iter_mut().for_each(|f| *f = r.word(&[0, 1, INF, INF - 1, u32::MAX])),
        1 => {
            matrix::route(d, m);
        }
        _ => {}
    }
}

fn sum(t: &mut Tally, fate: u32) {
    t.dropped += fate & 1;
    t.flushed += (fate >> 1) & 1;
    t.reaped += (fate >> 2) & 1;
    t.docked += (fate >> 3) & 1;
}

// ---------------------------------------------------------------------------------------------------------------
// The kernels

/// One agent's tick, given any row at all, never panics and changes nothing but that agent's own row, weights and
/// block; at most one word of the block unless the row is wiped, and then the whole row is zero.
#[test]
fn a_tick_touches_only_the_agents_own_row_and_block() {
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        let seed = 0x5eed_0001 + k as u64;
        let mut r = Rng::new(seed);
        let mut m = world(c);
        let step = step_of(d);
        for round in 0..600 {
            let i = match r.below(4) {
                0 => 0,
                1 => d.capacity - 1,
                _ => r.below(d.capacity),
            };
            for j in [i, i.saturating_sub(1), (i + 1).min(d.capacity - 1)] {
                if r.one_in(2) {
                    scramble(&mut r, d, &mut m, j);
                }
            }
            if r.one_in(5) {
                scramble_world(&mut r, d, &mut m);
            }
            let any = r.u32();
            let t = r.pick(&[0, 1, 63, 64, 1 << 20, u32::MAX - 1, u32::MAX, any]);
            let before = copy(d, &m);
            let fate = agent_tick(d, &mut m, i, t, step);
            let tag = format!("config {k} seed {seed:#x} round {round} slot {i} tick {t}");
            assert_eq!(fate, m.fate[i], "{tag}: the returned fate is the stored one");
            let changed = diff(&before, &m);
            for &(name, at) in &changed {
                assert!(own(d, i, name, at), "{tag}: changed {name}[{at}], outside its own row");
            }
            let wiped = fate & (FATE_FLUSHED | FATE_REAPED) != 0;
            let block = changed.iter().filter(|(n, _)| *n == "memory").count();
            assert!(block <= 1 || wiped, "{tag}: wrote {block} words of its block in one tick");
            if wiped {
                assert!(row_is_zero(d, &m, i), "{tag}: wiped but not zero");
            }
            assert!(m.alive[i] <= 1 && m.doomed[i] <= 1, "{tag}: a mask left outside 0 and 1");
            assert!(m.alive[i] == 0 || m.doomed[i] == 0, "{tag}: alive and doomed at once");
            assert!(m.goal[i] < d.stations as u32 || m.goal[i] == before.goal[i], "{tag}: a goal past the stations");
            assert_eq!(m.req[i], 0, "{tag}: a request outlived its tick");
        }
    }
}

/// The same state ticked by `tick`, by `tick` again on a copy, and by `agent_tick` in a random order, gives the same
/// bits and the same tally.
#[test]
fn visiting_order_and_repetition_cannot_change_a_tick() {
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        let seed = 0x5eed_0002 + k as u64;
        let mut r = Rng::new(seed);
        let mut a = world(c);
        let step = step_of(d);
        for t in 0..80u32 {
            for _ in 0..8 {
                let i = r.below(d.capacity);
                scramble(&mut r, d, &mut a, i);
            }
            if t % 20 == 10 {
                scramble_world(&mut r, d, &mut a);
            }
            let mut b = copy(d, &a);
            let mut c3 = copy(d, &a);
            let ta = tick(d, &mut a, t);
            let tb = tick(d, &mut b, t);
            let mut order: Vec<usize> = (0..d.capacity).collect();
            r.shuffle(&mut order);
            let mut tc = Tally::default();
            for &i in &order {
                sum(&mut tc, agent_tick(d, &mut c3, i, t, step));
            }
            let tag = format!("config {k} seed {seed:#x} tick {t}");
            assert_eq!(ta, tb, "{tag}: the tally of the same tick twice");
            assert_eq!(ta, tc, "{tag}: the tally in a random order");
            assert_eq!(diff(&a, &b), [], "{tag}: the same tick twice");
            assert_eq!(diff(&a, &c3), [], "{tag}: a random visiting order");
            assert_eq!(fingerprint(&a), fingerprint(&c3), "{tag}");
        }
    }
}

/// The SIMD tick (`tick`, LANES agents a register) leaves every bit the scalar reference (`tick_scalar`, `agent_tick`
/// one slot at a time) leaves, on any row at all (masks of all ones, positions off the floor or not a number,
/// weights at the extremes, a goal past the stations, a clock past its cap) and any world, with the same tally; on
/// x86_64 the lanes are SSE2 instructions (PACKED), so this is the packed arithmetic held to the scalar.
#[test]
fn the_simd_lanes_leave_the_bits_the_scalar_kernel_leaves() {
    assert_eq!(PACKED, cfg!(target_arch = "x86_64"), "on x86_64 the lanes are packed registers");
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        assert_eq!(d.capacity % LANES, 0, "a validated capacity is whole lane groups");
        let seed = 0x5eed_0051 + k as u64;
        let mut r = Rng::new(seed);
        let mut a = world(c);
        for t in 0..400u32 {
            let n = [0, 1, LANES, 16, d.capacity][r.below(5)];
            for _ in 0..n {
                let i = r.below(d.capacity);
                scramble(&mut r, d, &mut a, i);
            }
            if t % 25 == 7 {
                scramble_world(&mut r, d, &mut a);
            }
            for _ in 0..r.below(6) {
                let i = r.below(d.capacity);
                a.req[i] |= 1 << r.below(6);
            }
            let mut b = copy(d, &a);
            let ta = tick(d, &mut a, t);
            let tb = tick_scalar(d, &mut b, t);
            let tag = format!("config {k} seed {seed:#x} tick {t}");
            assert_eq!(ta, tb, "{tag}: the tally");
            assert_eq!(diff(&a, &b), [], "{tag}: the SIMD tick and the scalar tick leave different bits");
            assert_eq!(fingerprint(&a), fingerprint(&b), "{tag}");
        }
    }
}

/// `flush` zeroes slot `i`'s row, weights and block, leaves every other word (its fate too) as it was, and does the
/// same again.
#[test]
fn flush_zeroes_exactly_one_block_and_nothing_else() {
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        let seed = 0x5eed_0003 + k as u64;
        let mut r = Rng::new(seed);
        let mut m = world(c);
        for round in 0..300 {
            let i = match r.below(4) {
                0 => 0,
                1 => d.capacity - 1,
                _ => r.below(d.capacity),
            };
            for j in [i, i.saturating_sub(1), (i + 1).min(d.capacity - 1)] {
                scramble(&mut r, d, &mut m, j);
            }
            let before = copy(d, &m);
            flush(d, &mut m, i);
            let tag = format!("config {k} seed {seed:#x} round {round} slot {i}");
            assert!(row_is_zero(d, &m, i), "{tag}: the row is not zero");
            for &(name, at) in &diff(&before, &m) {
                assert!(own(d, i, name, at) && name != "fate", "{tag}: flush changed {name}[{at}]");
            }
            let again = copy(d, &m);
            flush(d, &mut m, i);
            assert_eq!(diff(&again, &m), [], "{tag}: a second flush changed something");
        }
    }
}

/// Drives slot `i` into docking at station `g` with `clock` ticks on its trip and weight `lw` there: what the kernel
/// then stores as the learned weight.
fn dock(d: &Dims, m: &mut Matrix, i: usize, g: usize, clock: u32, lw: i32) -> i32 {
    let cell = m.station[g] as usize;
    m.px[i] = (cell % d.width) as f32 + 0.5;
    m.pz[i] = (cell / d.width) as f32 + 0.5;
    m.alive[i] = 1;
    m.doomed[i] = 0;
    m.req[i] = 0;
    m.caps[i] = CAP_MOVE | CAP_ROUTE | CAP_LEARN;
    m.goal[i] = g as u32;
    m.clock[i] = clock;
    m.weights[i * d.stations + g] = lw;
    let fate = agent_tick(d, m, i, 7, step_of(d));
    assert!(fate & FATE_DOCKED != 0, "slot {i} at station {g}'s cell did not dock (fate {fate})");
    m.weights[i * d.stations + g]
}

/// The learning rule as the design states it, in arithmetic that cannot wrap: w + ((reward - w) >> shift) with the
/// reward 64 / (ticks + 64) in Q16.16 and the clock capped at 2^20.
fn learned(lw: i64, clock: u32, shift: u32) -> i64 {
    let reward = (1i64 << 22) / (clock.min(1 << 20) as i64 + 64);
    lw + ((reward - lw) >> shift)
}

/// From any weight in 0..=65536, any clock and any shift the type allows (0 to 31; the validator allows 1 to 15),
/// the kernel's wrapping arithmetic agrees with the exact rule and stays in 0..=65536; a weight the operator pushed
/// outside the range (the terminal writes any i32) is pulled back inside by learning, never into a negative value
/// that stays.
#[test]
fn the_learning_rule_cannot_leave_the_rewards_range() {
    let c = &configs()[1];
    let mut d = c.dims;
    let mut m = world(c);
    let mut r = Rng::new(0x5eed_0004);
    let clocks = [0, 1, 63, 64, 65, 1000, 65536, (1 << 20) - 1, 1 << 20, (1 << 20) + 1, u32::MAX - 1, u32::MAX];
    for shift in [0, 1, 2, 3, 7, 14, 15, 16, 30, 31] {
        d.learn_shift = shift;
        for lw in (0..=65536i32).step_by(257).chain([65535, 65536, 1, 2, 3, 4]) {
            for &clock in &clocks {
                let i = r.below(d.capacity);
                let g = r.below(d.stations);
                let got = dock(&d, &mut m, i, g, clock, lw);
                let want = learned(lw as i64, clock, shift);
                assert_eq!(got as i64, want, "shift {shift} weight {lw} clock {clock}");
                assert!((0..=65536).contains(&got), "shift {shift} weight {lw} clock {clock} -> {got}");
            }
        }
    }
    // Every reachable reward, at the stride the validator's shifts can resolve: the rule itself, exhaustively.
    let mut rewards: Vec<i64> = (0..=(1u32 << 20) + 1).map(|c| (1i64 << 22) / (c.min(1 << 20) as i64 + 64)).collect();
    rewards.sort_unstable();
    rewards.dedup();
    assert_eq!((rewards[0], *rewards.last().unwrap()), (3, 65536));
    for shift in 0..32 {
        for lw in (0..=65536i64).step_by(61).chain([65535, 65536]) {
            for &reward in &rewards {
                let w = lw + ((reward - lw) >> shift);
                assert!((0..=65536).contains(&w), "shift {shift} weight {lw} reward {reward} -> {w}");
            }
        }
    }
    // The extremes an operator can write: one docking never panics, and with the shipped shift the weight is back in
    // range within 400 dockings (the pull is geometric), never stuck negative.
    d.learn_shift = 3;
    for lw in [i32::MIN, i32::MIN + 1, -70000, -1, 65537, 1 << 30, i32::MAX] {
        let mut w = lw;
        let mut back = None;
        for n in 0..400 {
            w = dock(&d, &mut m, 5, 0, 0, w);
            if (0..=65536).contains(&w) {
                back = Some(n);
                break;
            }
        }
        assert!(back.is_some(), "weight {lw} never came back into range (last {w})");
    }
    // Dynamically, from the spawned state, on every configuration: no weight leaves the range.
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        let mut m = world(c);
        let mut r = Rng::new(0x5eed_0044 + k as u64);
        for t in 0..1500u32 {
            for _ in 0..4 {
                let i = r.below(d.capacity);
                m.req[i] = m.caps[i] & r.u32();
            }
            tick(d, &mut m, t);
            if t % 100 == 99 {
                assert!(m.weights.iter().all(|w| (0..=65536).contains(w)), "config {k} tick {t}");
            }
        }
    }
}

/// The scripted run gives the same Proof and matrix twice, step by step as at once, and from a fork taken at any
/// tick; the generator's text is the same twice and the lock pins the shipped canonical form.
#[test]
fn the_scripted_run_replays_bit_for_bit_from_any_tick() {
    let mut r = Rng::new(0x5eed_0005);
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        let (counts, caps) = roles(c);
        let mut m1 = matrix::new(d);
        let p1 = golden(d, &counts, &caps, &mut m1);
        let mut m2 = matrix::new(d);
        let p2 = golden(d, &counts, &caps, &mut m2);
        assert_eq!(p1, p2, "config {k}");
        assert_eq!(diff(&m1, &m2), [], "config {k}");
        assert_eq!(p1.tick, GOLDEN_TICKS);
        assert_eq!(p1.fingerprint, fingerprint(&m1), "config {k}");
        let fork_at = r.below(GOLDEN_TICKS as usize) as u32;
        let mut m3 = matrix::new(d);
        let mut p3 = golden_begin(d, &counts, &caps, &mut m3);
        let mut fork = None;
        while golden_step(d, &mut m3, &mut p3) {
            if p3.tick == fork_at {
                fork = Some((copy(d, &m3), p3));
            }
        }
        assert_eq!(p3, p1, "config {k}: step by step");
        assert_eq!(diff(&m3, &m1), [], "config {k}: step by step");
        let (mut m4, mut p4) = fork.expect("the fork tick is inside the run");
        while golden_step(d, &mut m4, &mut p4) {}
        assert_eq!(p4, p1, "config {k}: forked at {fork_at}");
        assert_eq!(diff(&m4, &m1), [], "config {k}: forked at {fork_at}");
        assert!(!golden_step(d, &mut m4, &mut p4), "the run is over");
    }
    let a = noir_core::generate(SAMPLE, LOCK).unwrap_or_else(|e| panic!("{e}"));
    let b = noir_core::generate(SAMPLE, LOCK).unwrap_or_else(|e| panic!("{e}"));
    assert_eq!(a, b, "the generator twice");
    assert_eq!(locked_digest(LOCK), Some(digest_hex(&canonical(&configs()[0])).as_str()), "the lock pins the shipped form");
}

/// On any floor (none, all walls, a checkerboard, random densities) with stations anywhere (in a wall, shared), the
/// relaxation converges within the cell count to the breadth-first distances: 0 at the station, INF where a wall
/// stands or nothing reaches, and one more pass changes nothing.
#[test]
fn the_relaxation_is_a_shortest_path_on_any_floor() {
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        let cells = d.width * d.depth;
        let seed = 0x5eed_0006 + k as u64;
        let mut r = Rng::new(seed);
        let mut m = matrix::new(d);
        for floor in 0..7 {
            match floor {
                0 => m.walls.fill(0),
                1 => m.walls.fill(1),
                2 => m.walls.iter_mut().enumerate().for_each(|(c, w)| *w = ((c % d.width + c / d.width) % 2) as u32),
                3 => matrix::lay_out_world(d, &mut m),
                _ => {
                    let density = [1, 3, 9][floor - 4];
                    m.walls.iter_mut().for_each(|w| *w = (r.below(10) < density) as u32);
                }
            }
            for s in &mut m.station {
                *s = r.below(cells) as u32;
            }
            let passes = matrix::route(d, &mut m);
            let tag = format!("config {k} seed {seed:#x} floor {floor}");
            assert!(passes >= 1 && passes as usize <= cells, "{tag}: {passes} passes");
            for s in 0..d.stations {
                let home = m.station[s] as usize;
                let mut want = vec![INF; cells];
                want[home] = 0;
                let mut queue = VecDeque::from([home]);
                while let Some(c0) = queue.pop_front() {
                    let (x, z) = (c0 % d.width, c0 / d.width);
                    let near = [
                        (x + 1 < d.width).then_some(c0 + 1),
                        (x > 0).then_some(c0.wrapping_sub(1)),
                        (z + 1 < d.depth).then_some(c0 + d.width),
                        (z > 0).then_some(c0.wrapping_sub(d.width)),
                    ];
                    for n in near.into_iter().flatten() {
                        if m.walls[n] == 0 && want[n] == INF {
                            want[n] = want[c0] + 1;
                            queue.push_back(n);
                        }
                    }
                }
                let field = &m.field[s * cells..(s + 1) * cells];
                assert!(field.iter().all(|&f| f <= INF), "{tag}: a field past INF");
                if let Some(at) = (0..cells).find(|&c| field[c] != want[c]) {
                    panic!("{tag}: station {s} cell {at}: field {} want {}", field[at], want[at]);
                }
            }
            let mut scratch = vec![0; m.field.len()];
            assert_eq!(relax_pass(d, &m.walls, &m.station, &m.field, &mut scratch), 0, "{tag}: not converged");
            assert_eq!(scratch, m.field, "{tag}: a pass at the fixed point rewrote it");
        }
    }
}

/// `spawn` fills exactly the declared counts, in order, each agent alive with its role's privileges at the centre of
/// a free cell (or any cell when the floor has none), the rest of the pool zero, and does it the same twice.
#[test]
fn spawn_fills_exactly_the_declared_counts_and_is_reproducible() {
    for (k, c) in configs().iter().enumerate() {
        let d = &c.dims;
        let seed = 0x5eed_0007 + k as u64;
        let mut r = Rng::new(seed);
        let mut m = matrix::new(d);
        for round in 0..24 {
            match round % 3 {
                0 => matrix::lay_out_world(d, &mut m),
                1 => m.walls.fill(1),
                _ => m.walls.iter_mut().for_each(|w| *w = r.one_in(2) as u32),
            }
            let n = 1 + r.below(16);
            let mut counts = vec![0u32; n];
            let mut left = d.capacity as u32;
            for (j, count) in counts.iter_mut().enumerate() {
                *count = if j + 1 == n && r.one_in(2) { left } else { r.below(left as usize + 1) as u32 };
                left -= *count;
            }
            let caps: Vec<u32> = (0..n).map(|_| r.below(32) as u32).collect();
            matrix::spawn(d, &counts, &caps, &mut m);
            let mut again = copy(d, &m);
            matrix::spawn(d, &counts, &caps, &mut again);
            let tag = format!("config {k} seed {seed:#x} round {round} counts {counts:?}");
            assert_eq!(diff(&m, &again), [], "{tag}: spawn twice");
            let walled = m.walls.iter().all(|&w| w & 1 == 1);
            let mut i = 0;
            for (role, &count) in counts.iter().enumerate() {
                for _ in 0..count {
                    assert_eq!((m.alive[i], m.doomed[i], m.role[i], m.caps[i]), (1, 0, role as u32, caps[role]), "{tag}: slot {i}");
                    let (x, z) = (m.px[i], m.pz[i]);
                    assert!(x.fract() == 0.5 && z.fract() == 0.5, "{tag}: slot {i} at {x},{z}");
                    assert!(x > 0.0 && z > 0.0 && (x as usize) < d.width && (z as usize) < d.depth, "{tag}: slot {i} off the floor");
                    let cell = z as usize * d.width + x as usize;
                    assert!(walled || m.walls[cell] & 1 == 0, "{tag}: slot {i} spawned in a wall");
                    assert!(m.goal[i] < d.stations as u32 && m.heading[i] < 4, "{tag}: slot {i}");
                    i += 1;
                }
            }
            assert!((i..d.capacity).all(|j| row_is_zero(d, &m, j)), "{tag}: a slot past the declared agents is not zero");
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The sort

/// Every power-of-two size up to 4096, on every shape of input (equal, sorted, reversed, random over the whole
/// range, a few values, one-hot): the passes and the eight-file network sort what the standard library sorts, the
/// reference sort agrees, and the 0-1 principle proves the networks for 2, 4, 8 and 16 keys and refutes any network
/// missing one comparator.
#[test]
fn the_network_sorts_whatever_the_reference_sorts() {
    let mut r = Rng::new(0x5eed_0008);
    for n in [1usize, 2, 4, 8, 16, 32, 64, 256, 1024, 4096] {
        for shape in 0..12 {
            let keys: Vec<u32> = match shape {
                0 => vec![7; n],
                1 => (0..n as u32).collect(),
                2 => (0..n as u32).rev().collect(),
                3 => (0..n).map(|_| r.u32()).collect(),
                4 => (0..n).map(|_| r.below(3) as u32).collect(),
                5 => (0..n).map(|k| (k == n / 2) as u32).collect(),
                6 => (0..n).map(|_| r.pick(&[0, u32::MAX, 1, u32::MAX - 1])).collect(),
                _ => (0..n).map(|_| r.below(1000) as u32).collect(),
            };
            let mut sorted = keys.clone();
            bitonic_sort(&mut sorted);
            let mut want = keys.clone();
            want.sort_unstable();
            assert_eq!(sorted, want, "n {n} shape {shape}");
            assert!(is_sorted(&sorted));
            let mut reference = vec![0; n];
            reference_sort(&keys, &mut reference);
            assert_eq!(reference, want, "n {n} shape {shape}: the reference");
            if n == 8 {
                let mut by_network = keys.clone();
                run_network(&mut by_network, &NETWORK8);
                assert_eq!(by_network, want, "shape {shape}: the eight-file network");
            }
        }
    }
    const N2: [(u8, u8, bool); 1] = network::<2, 1>();
    const N4: [(u8, u8, bool); 6] = network::<4, 6>();
    const N16: [(u8, u8, bool); 80] = network::<16, 80>();
    assert_eq!(zero_one_proof(&N2, 2), Some(4));
    assert_eq!(zero_one_proof(&N4, 4), Some(16));
    assert_eq!(zero_one_proof(&NETWORK8, 8), Some(256));
    assert_eq!(zero_one_proof(&N16, 16), Some(65536));
    for skip in 0..N16.len() {
        let mut broken = N16.to_vec();
        broken.remove(skip);
        assert_eq!(zero_one_proof(&broken, 16), None, "sixteen keys without comparator {skip}");
    }
    // A comparator with its direction flipped is caught too.
    for flip in [0, 5, 11, 23] {
        let mut broken = NETWORK8;
        broken[flip].2 = !broken[flip].2;
        assert_eq!(zero_one_proof(&broken, 8), None, "comparator {flip} flipped");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// The configuration

const PALETTE: &[char] = &[
    '{', '}', '[', ']', '=', ';', '"', '#', '.', '\n', ' ', '0', '9', '-', '_', '$', '\\', '\'', 'a', 'x', 'é', '∞', '🦀',
    '\u{0}', '\u{7f}', '\t', '\r',
];

const TOKENS: &[&str] = &[
    "true",
    "false",
    "network = true;",
    "import ./x.nix",
    "${x}",
    "\"${x}\"",
    "99999999999999999999",
    "-1",
    "0",
    "2147483648",
    "4294967296",
    "9223372036854775807",
    "9223372036854775808",
    "-9223372036854775808",
    "[ ",
    "{ ",
    "a.b.c = 1;",
    "a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a.a = 1;",
    "roles.courier.count = 5000;",
    "roles.x = { count = 1; caps = [ \"network\" ]; };",
    "roles.x = { count = 1; caps = [ \"move\" \"move\" ]; };",
    "system.name = \"x\";",
    "\"",
    "\\\"",
    "\\",
    "learnShift = 0;",
    "learnShift = 31;",
    "capacity = 65536;",
    "capacity = 3;",
    "stations = 1;",
    "arenaBytes = 1;",
    "\n",
    "  # comment\n",
    "é",
    "\u{feff}",
];

/// One random mutation of the shipped text: a character replaced, several replaced, a token inserted, a character
/// or a line removed, a line duplicated, the text truncated, or a number rewritten at an edge.
fn mutate(r: &mut Rng, src: &str) -> (String, &'static str) {
    let mut chars: Vec<char> = src.chars().collect();
    let lines: Vec<&str> = src.lines().collect();
    match r.below(8) {
        0 => {
            let at = r.below(chars.len());
            chars[at] = r.pick(PALETTE);
            (chars.into_iter().collect(), "a character replaced")
        }
        1 => {
            for _ in 0..2 + r.below(7) {
                let at = r.below(chars.len());
                chars[at] = r.pick(PALETTE);
            }
            (chars.into_iter().collect(), "several characters replaced")
        }
        2 => {
            let at = r.below(chars.len() + 1);
            let tok: Vec<char> = r.pick(TOKENS).chars().collect();
            chars.splice(at..at, tok);
            (chars.into_iter().collect(), "a token inserted")
        }
        3 => {
            let at = r.below(chars.len());
            chars.remove(at);
            (chars.into_iter().collect(), "a character removed")
        }
        4 => {
            let at = r.below(chars.len() + 1);
            chars.truncate(at);
            (chars.into_iter().collect(), "truncated")
        }
        5 => {
            let k = r.below(lines.len());
            let s: String = lines.iter().enumerate().filter(|&(j, _)| j != k).map(|(_, l)| format!("{l}\n")).collect();
            (s, "a line removed")
        }
        6 => {
            let k = r.below(lines.len());
            let s: String =
                lines.iter().enumerate().map(|(j, l)| if j == k { format!("{l}\n{l}\n") } else { format!("{l}\n") }).collect();
            (s, "a line duplicated")
        }
        _ => {
            // The k-th run of digits becomes an edge number.
            let runs: Vec<(usize, usize)> = {
                let mut out = Vec::new();
                let mut k = 0;
                while k < chars.len() {
                    if chars[k].is_ascii_digit() {
                        let start = k;
                        while k < chars.len() && chars[k].is_ascii_digit() {
                            k += 1;
                        }
                        out.push((start, k));
                    } else {
                        k += 1;
                    }
                }
                out
            };
            let (start, end) = r.pick(&runs);
            let edge = r.pick(&[
                "0",
                "1",
                "-1",
                "2",
                "4095",
                "4097",
                "65536",
                "65537",
                "2147483647",
                "2147483648",
                "4294967295",
                "4294967296",
                "9223372036854775807",
                "9223372036854775808",
                "99999999999999999999999999",
                "00000",
                "1.5",
                "1e9",
                "0x10",
            ]);
            chars.splice(start..end, edge.chars());
            (chars.into_iter().collect(), "a number rewritten")
        }
    }
}

/// Parses and validates without a panic, or names the panic.
fn try_load(src: &str) -> Result<Result<Config, String>, String> {
    catch_unwind(AssertUnwindSafe(|| parse(src).and_then(|v| validate(&v)))).map_err(|p| {
        p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
    })
}

/// A validated configuration's canonical form is itself in the subset: it parses, validates to the same
/// configuration and canonicalises to the same text.
fn round_trips(c: &Config) -> Result<(), String> {
    let canon = canonical(c);
    let again = validate(&parse(&canon).map_err(|e| format!("the canonical form does not parse: {e}\n{canon}"))?)
        .map_err(|e| format!("the canonical form does not validate: {e}\n{canon}"))?;
    if again != *c {
        return Err(format!("the canonical form is another configuration:\n{canon}"));
    }
    if canonical(&again) != canon {
        return Err(format!("the canonical form is not a fixed point:\n{canon}"));
    }
    Ok(())
}

/// Thousands of mutations of containment.nix: none panics the parser or the validator; whatever validates obeys the
/// rules (no network, the roles fit the pool, the shifts in range, the layout in the arena) and round-trips through
/// its canonical form; a mutation that leaves the digest unchanged touched only comments or layout.
#[test]
fn no_mutation_of_the_configuration_panics_and_only_a_faithful_text_validates() {
    let original = configs()[0].clone();
    let digest = digest_hex(&canonical(&original));
    let mut r = Rng::new(0x5eed_0009);
    let (mut accepted, mut benign) = (0, 0);
    for round in 0..4000 {
        let seed = r.next();
        let (src, how) = mutate(&mut Rng::new(seed), SAMPLE);
        let tag = format!("round {round} seed {seed:#x} ({how})");
        match try_load(&src) {
            Err(panic) => panic!("{tag}: the parser or validator panicked: {panic}\n{src}"),
            Ok(Err(e)) => assert!(e.starts_with("containment.nix:") || !e.is_empty(), "{tag}: an empty refusal"),
            Ok(Ok(c)) => {
                accepted += 1;
                assert!(!c.network, "{tag}: a network");
                assert!(c.roles.iter().map(|r| r.count as u64).sum::<u64>() <= c.dims.capacity as u64, "{tag}: roles past the pool");
                assert!((1..=15).contains(&c.dims.learn_shift), "{tag}: learn_shift {}", c.dims.learn_shift);
                assert!(declared_bytes(&c.dims) <= c.dims.arena_bytes, "{tag}: the layout past the arena");
                assert!(c.dims.capacity.is_power_of_two() && c.dims.stations.is_power_of_two(), "{tag}");
                assert!(c.dims.block_words.is_power_of_two() && c.dims.width.is_power_of_two() && c.dims.depth.is_power_of_two(), "{tag}");
                if let Err(e) = round_trips(&c) {
                    panic!("{tag}: {e}");
                }
                if digest_hex(&canonical(&c)) == digest {
                    benign += 1;
                    assert_eq!(c, original, "{tag}: the same digest for another configuration");
                }
            }
        }
    }
    assert!(accepted > 50 && benign > 20, "the mutator found {accepted} accepted, {benign} benign: too few to mean anything");
    // The directed cases the brief names, each refused with its reason.
    let refused = |edits: &[(&str, &str)], reason: &str| {
        let mut src = String::from(SAMPLE);
        for (from, to) in edits {
            assert!(src.contains(from), "{from}");
            src = src.replacen(from, to, 1);
        }
        match try_load(&src) {
            Ok(Err(e)) => assert!(e.contains(reason), "{edits:?}: refused for {e:?}, not {reason:?}"),
            Ok(Ok(_)) => panic!("{edits:?}: accepted"),
            Err(p) => panic!("{edits:?}: panicked: {p}"),
        }
    };
    refused(&[("network = false;", "network = true;")], "air gap");
    refused(&[("count = 3072;", "count = 4096;")], "more than pool.capacity");
    refused(&[("count = 3072;", "count = 4097;")], "between 1 and 4096");
    refused(&[("count = 3072;", "count = 0;")], "between 1 and 4096");
    refused(&[("learnShift = 3;", "learnShift = 0;")], "between 1 and 15");
    refused(&[("learnShift = 3;", "learnShift = 31;")], "between 1 and 15");
    refused(&[("learnShift = 3;", "learnShift = 16;")], "between 1 and 15");
    refused(&[("seed = 1337;", "seed = 4294967296;")], "between 0 and 4294967295");
    refused(&[("seed = 1337;", "seed = -1;")], "between 0 and 4294967295");
    refused(&[("seed = 1337;", "seed = 99999999999999999999;")], "too large");
    refused(&[("tickHz = 60;", "tickHz = 1e3;")], "whole numbers");
    refused(&[("capacity = 4096;", "capacity = 65536;")], "declared layout needs");
    refused(&[("stations = 8;", "stations = 1;")], "between 2 and 16");
    refused(&[("stations = 8;", "stations = 12;")], "power of two");
    refused(&[("\"move\" \"route\" \"learn\" \"memory\"", "\"move\" \"network\"")], "not a capability");
    refused(
        &[("\"move\" \"route\" \"learn\" \"memory\"", "\"move\" \"learn\" \"memory\""), ("[ \"move\" \"route\" \"memory\" ]", "[ \"move\" \"memory\" ]")],
        "holds both",
    );
    refused(&[("name = \"crimson-noir\";", "name = \"crimson-noir\"; name = \"x\";")], "declared twice");
    refused(&[("name = \"crimson-noir\";", "name = \"crimsön\";")], "short printable string");
    refused(&[("name = \"crimson-noir\";", &format!("name = \"{}\";", "a".repeat(33)))], "short printable string");
    refused(&[("courier = {", "cöurier = {")], "expected '='");
    refused(&[("courier = {", "ö = {")], "expected a name");
    refused(&[("courier = {", "Courier = {")], "lowercase name");
    refused(&[("dependencies = [", "dependencies = [ \"../evil\"")], "not a crate name");
    refused(&[("  system = {", "  extra = 1;\n  system = {")], "not part of the configuration");
    for (text, reason) in [
        ("", "ends early"),
        ("{", "expected a name"),
        ("{}", "system is not declared"),
        ("[]", "must be an attribute set"),
        ("{ a = \"${x}\"; }", "interpolation"),
        ("{ a = \"x\n\"; }", "span lines"),
        ("{ a = \"\\q\"; }", "unknown escape"),
        ("{ a = 1; } x", "text after"),
        (&format!("{}{}", "[".repeat(33), "]".repeat(33)), "nested too deeply"),
        (&format!("{}1{}", "[".repeat(31), "]".repeat(31)), "must be an attribute set"),
        (&format!("{}1{}", "[".repeat(32), "]".repeat(32)), "nested too deeply"),
        (&format!("{{ a = {}1{}; }}", "[".repeat(40), "]".repeat(40)), "nested too deeply"),
    ] {
        match try_load(text) {
            Ok(Err(e)) => assert!(e.contains(reason), "{text:?}: refused for {e:?}, not {reason:?}"),
            Ok(Ok(_)) => panic!("{text:?}: accepted"),
            Err(p) => panic!("{text:?}: panicked: {p}"),
        }
    }
}

/// REGRESSION for Phase 16 audit finding "a validated name can break the canonical form" (config.rs `text`, which
/// accepts every ASCII graphic byte, including the quote, the backslash and the dollar that the subset's strings
/// give meaning to; `canonical` then writes them unescaped). Fails on the code as audited: `system.name =
/// "crimson\"noir";` validates, and its canonical form does not parse. It passes once such a name is refused (or
/// escaped, which keeps the round trip): either way every validated configuration must describe itself.
#[test]
fn a_validated_configuration_always_has_a_self_describing_canonical_form() {
    for (field, bad) in [
        ("name = \"crimson-noir\";", "name = \"crimson\\\"noir\";"),
        ("name = \"crimson-noir\";", "name = \"crimson\\\\noir\";"),
        ("name = \"crimson-noir\";", "name = \"crimson\\${noir}\";"),
        ("version = \"0.9.0\";", "version = \"0.9\\\"0\";"),
        ("version = \"0.9.0\";", "version = \"\\\\\";"),
    ] {
        let src = SAMPLE.replacen(field, bad, 1);
        assert_ne!(src, SAMPLE, "{bad}");
        match try_load(&src) {
            Err(p) => panic!("{bad}: panicked: {p}"),
            Ok(Err(_)) => {}
            Ok(Ok(c)) => {
                if let Err(e) = round_trips(&c) {
                    panic!("{bad} was accepted, and {e}");
                }
            }
        }
    }
}

/// REGRESSION for Phase 16 audit finding "a dotted path recurses the parser off its stack" (config.rs `insert`
/// recurses once per path segment, and `MAX_DEPTH` counts only nested values): `{ a.a.a...a = 1; }` with 20,000
/// segments (40 KB) aborts the build script with a stack overflow on a 2 MiB stack, 100,000 on an 8 MiB one. The
/// test uses 2,000 segments, which the audited code parses without overflowing, and requires the refusal the
/// nesting rule gives any other over-deep text (an iterative `insert` alone would not do: the nested `Value` it
/// builds is dropped, cloned and compared recursively).
#[test]
fn a_dotted_path_cannot_recurse_the_parser_off_its_stack() {
    let mut src = String::from("{ ");
    src.push_str(&"a.".repeat(2_000));
    src.push_str("a = 1; }");
    match catch_unwind(|| parse(&src)) {
        Err(_) => panic!("the parser panicked"),
        Ok(Ok(_)) => panic!("a 2,000-segment path parsed (the validator refuses the key after, but the depth is unbounded)"),
        Ok(Err(e)) => assert!(e.contains("nested too deeply") || e.contains("path"), "refused for another reason: {e}"),
    }
}
