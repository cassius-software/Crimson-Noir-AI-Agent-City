// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the formal side of the kernels: proof harnesses for the Kani model checker
//! (`cargo kani`, tools/verify/fvps.sh), compiled only under `cfg(kani)`. Where tests.rs runs the kernels on chosen
//! inputs, each harness here runs them on a symbolic one: every value `kani::any()` yields is every value of its
//! type at once, and Kani (CBMC under it, bit-precise for u32 and f32 alike) explores every execution path of the
//! kernel over them and reports the first path that reaches a panic (an index out of bounds, an overflow in debug
//! arithmetic, an `unreachable`) or fails an assertion. A harness that passes is a proof for the dimensions it
//! fixes, not a test: no input of those dimensions reaches a trap or breaks the stated bound.
//! What the harnesses prove: an agent's tick reads and writes only its own row, its own weights and its own memory
//! block (memory isolation), keeps the agent on the floor, leaves 1/0 masks as 1/0, and never traps, for every
//! matrix content and every validated kernel knob; the capability fuse drops the pointer of an agent that asks for
//! a privilege its role was not declared with, in that tick, every other word of its row accounted for (moved
//! nowhere, learned nothing, wrote nothing, kept its goal, its capabilities, its role and its heading; its trip clock
//! ticks and its loop breaker resets as in any tick), and never drops one whose request is declared, in a role
//! declared with movement; the routing relaxation and the sorting network never index out of
//! their arrays; the mask arithmetic (`nz`, `sel`) means what the hot path takes it to mean, for all 2^32 words.
//! The dimensions are the smallest the configuration validator admits (capacity 64, 8-word blocks, 2 stations, a
//! 32x32 floor), except the floor of the agent tick and the relaxation, 8x8 (see `SMALL`); tools/verify/fvps_smt.py
//! proves the index arithmetic for every power-of-two dimension with an SMT solver, where the matrix itself does not
//! have to be built.
//! What breaks if it is removed? `cargo kani` has nothing to prove and the verification step of the pipeline is empty.

use crate::config::{CAP_MOVE, Dims};
use crate::kernels::{FATE_DROPPED, FATE_FLUSHED, INF, agent_tick, bitonic_pass, compare_exchange, flush, nz, relax_pass, sel, step_of};
use crate::matrix::{self, Matrix};

const CAP: usize = 64;
const BLOCK: usize = 8;
const STATIONS: usize = 2;
const WIDTH: usize = 32;
const DEPTH: usize = 32;
const CELLS: usize = WIDTH * DEPTH;

/// The smallest configuration the validator admits (config.rs: capacity >= 64, blockWords >= 8, stations >= 2,
/// a 32x32 floor), with every kernel knob symbolic within its validated range.
fn dims() -> Dims {
    dims_on(WIDTH, DEPTH)
}

/// The floor the agent tick and the relaxation harnesses use: 8x8, below what the validator admits, because the
/// checker's memory grows with the floor (the relaxation unrolls its pass over every cell; the tick's reads of the
/// field and the walls at symbolic cells cost it more than a CI runner's 7 GB at 32x32). Both kernels' arithmetic
/// is per cell and the same at 32x32, and tools/verify/fvps_smt.py proves their index arithmetic (the tick's five
/// field reads, its step, its memory and weight slots; the pass's neighbours) for every validated floor.
const SMALL: usize = 8;
const SMALL_CELLS: usize = SMALL * SMALL;

fn dims_on(width: usize, depth: usize) -> Dims {
    let loop_limit: u32 = kani::any();
    kani::assume((2..=1_000_000).contains(&loop_limit));
    let step_eighths: u32 = kani::any();
    kani::assume((1..=8).contains(&step_eighths));
    let learn_shift: u32 = kani::any();
    kani::assume((1..=15).contains(&learn_shift));
    let explore: u32 = kani::any();
    kani::assume(explore <= 65536);
    Dims {
        capacity: CAP,
        block_words: BLOCK,
        stations: STATIONS,
        width,
        depth,
        loop_limit,
        step_eighths,
        learn_shift,
        explore,
        seed: kani::any(),
        tick_hz: 60,
        display_width: 320,
        display_height: 200,
        triangles: 1024,
        term_cells: 2048,
        term_stack: 64,
        term_steps: 1000,
        term_lines: 32,
        arena_bytes: 1 << 20,
    }
}

/// Fills `v` with symbolic words, as one symbolic array (no loop for the checker to unroll).
fn any_u32s<const N: usize>(v: &mut [u32]) {
    let a: [u32; N] = kani::any();
    v.copy_from_slice(&a);
}

fn any_i32s<const N: usize>(v: &mut [i32]) {
    let a: [i32; N] = kani::any();
    v.copy_from_slice(&a);
}

fn any_f32s<const N: usize>(v: &mut [f32]) {
    let a: [f32; N] = kani::any();
    v.copy_from_slice(&a);
}

/// A symbolic index below `n`.
fn index(n: usize) -> usize {
    let i: usize = kani::any();
    kani::assume(i < n);
    i
}

/// A matrix of the dimensions whose every word is symbolic: any content at all, including what no kernel would
/// ever write (NaN positions, masks with high bits set, fields past INF). `WALLS` and `FIELD` are the floor's cell
/// count and the field's word count (stations x cells) for `d`'s floor, as constants so each is one symbolic array.
fn any_matrix<const WALLS: usize, const FIELD: usize>(d: &Dims) -> Matrix {
    let mut m = matrix::new(d);
    any_f32s::<CAP>(&mut m.px);
    any_f32s::<CAP>(&mut m.pz);
    for a in [&mut m.alive, &mut m.doomed, &mut m.caps, &mut m.req, &mut m.role, &mut m.goal, &mut m.run, &mut m.last] {
        any_u32s::<CAP>(a);
    }
    for a in [&mut m.trips, &mut m.clock, &mut m.heading, &mut m.fate] {
        any_u32s::<CAP>(a);
    }
    any_u32s::<{ CAP * BLOCK }>(&mut m.memory);
    any_u32s::<WALLS>(&mut m.walls);
    any_u32s::<FIELD>(&mut m.field);
    any_u32s::<STATIONS>(&mut m.station);
    any_i32s::<{ CAP * STATIONS }>(&mut m.weights);
    m
}

/// One agent's tick on the 8x8 floor (see `SMALL`), over every matrix content, every validated knob, every slot
/// and every tick number: it never traps, and it touches nothing outside its own row, weights and memory block.
#[kani::proof]
#[kani::unwind(9)]
fn agent_tick_is_isolated_to_its_own_row() {
    let d = dims_on(SMALL, SMALL);
    let mut m = any_matrix::<SMALL_CELLS, { STATIONS * SMALL_CELLS }>(&d);
    let i = index(d.capacity);
    let t: u32 = kani::any();
    // One symbolic witness per array: a word outside the agent's own part, chosen by the checker (so every word
    // outside it is covered, with no loop to unroll).
    let mw = index(m.memory.len());
    kani::assume(!(i * d.block_words..(i + 1) * d.block_words).contains(&mw));
    let ww = index(m.weights.len());
    kani::assume(!(i * d.stations..(i + 1) * d.stations).contains(&ww));
    let rw = index(d.capacity);
    kani::assume(rw != i);
    let fw = index(m.field.len());
    let lw = index(m.walls.len());
    let (memory, weight, alive, px, pz, caps, goal, field, wall) =
        (m.memory[mw], m.weights[ww], m.alive[rw], m.px[rw].to_bits(), m.pz[rw].to_bits(), m.caps[rw], m.goal[rw], m.field[fw], m.walls[lw]);

    let fate = agent_tick(&d, &mut m, i, t, step_of(&d));

    // The fate bits are the four the kernel defines, and nothing else.
    assert!(fate < 16);
    // Masks come out 1/0.
    assert!(m.alive[i] <= 1 && m.doomed[i] <= 1);
    // The agent is on the floor: positions are finite and inside [0, width) x [0, depth).
    assert!(m.px[i] >= 0.0 && m.px[i] < d.width as f32);
    assert!(m.pz[i] >= 0.0 && m.pz[i] < d.depth as f32);
    // Memory isolation: no memory word outside the agent's block, no weight outside its row, no other row changed.
    assert!(m.memory[mw] == memory, "a memory word outside the agent's block changed");
    assert!(m.weights[ww] == weight, "a weight outside the agent's row changed");
    assert!(m.alive[rw] == alive && m.px[rw].to_bits() == px && m.pz[rw].to_bits() == pz, "another row changed");
    assert!(m.caps[rw] == caps && m.goal[rw] == goal, "another row changed");
    // The world is read-only to a tick.
    assert!(m.field[fw] == field && m.walls[lw] == wall, "the world changed");
}

/// The capability fuse, for every matrix content, every validated knob, every slot and every tick: an alive agent
/// whose request holds a privilege its role was not declared with (`req` has a bit outside `caps`) drops its pointer
/// in that tick: its fate is FATE_DROPPED alone, it is no longer alive and is doomed (its row is zeroed in the next
/// tick), and every other word of its row is accounted for: it moved nowhere, learned nothing, wrote nothing to its
/// memory, kept its goal, its capabilities, its role and its heading, its trip count stands, and its trip clock ticks
/// and its loop breaker resets as they do for any alive agent that did not move. (The page's Ring-0 action gate,
/// 02_Define_The_Rules/ring0Gate.ts, is a rule in TypeScript held by tests, not a proof; this is the kernel's own law
/// of that kind, and the one that is proved.)
#[kani::proof]
#[kani::unwind(9)]
fn an_undeclared_privilege_drops_the_pointer_for_every_matrix() {
    let d = dims_on(SMALL, SMALL);
    let mut m = any_matrix::<SMALL_CELLS, { STATIONS * SMALL_CELLS }>(&d);
    let i = index(d.capacity);
    let t: u32 = kani::any();
    kani::assume(m.alive[i] & 1 == 1 && m.doomed[i] & 1 == 0);
    kani::assume(m.req[i] & !m.caps[i] != 0);
    // On the floor, so the tick's hold to the floor is the identity and a position left alone is a position unchanged.
    kani::assume(m.px[i] >= 0.0 && m.px[i] <= SMALL as f32 - 0.125);
    kani::assume(m.pz[i] >= 0.0 && m.pz[i] <= SMALL as f32 - 0.125);
    let (px, pz) = (m.px[i], m.pz[i]);
    let goal = m.goal[i] & (d.stations as u32 - 1);
    let heading = m.heading[i] & 3;
    let (caps, role, trips, clock) = (m.caps[i], m.role[i], m.trips[i], m.clock[i]);
    // One symbolic witness in its memory block and one in its weights: every word of each is covered.
    let mw = i * d.block_words + index(d.block_words);
    let ww = i * d.stations + index(d.stations);
    let (memory, weight) = (m.memory[mw], m.weights[ww]);

    let fate = agent_tick(&d, &mut m, i, t, step_of(&d));

    assert!(fate == FATE_DROPPED, "dropped, and only dropped");
    assert!(m.fate[i] == FATE_DROPPED);
    assert!(m.alive[i] == 0 && m.doomed[i] == 1, "it can act no more, and is zeroed next tick");
    assert!(m.px[i] == px && m.pz[i] == pz, "it moved nowhere");
    assert!(m.memory[mw] == memory, "it wrote nothing to its memory");
    assert!(m.weights[ww] == weight, "it learned nothing");
    assert!(m.goal[i] == goal, "it kept its goal");
    assert!(m.caps[i] == caps && m.role[i] == role, "it kept its capabilities and its role");
    assert!(m.heading[i] == heading && m.trips[i] == trips, "its heading and its trip count stand");
    assert!(m.clock[i] == clock.wrapping_add(1), "its trip clock ticks, as for any alive agent");
    assert!(m.run[i] == 0 && m.last[i] == 0, "its loop breaker resets, as for any agent that did not move");
    assert!(m.req[i] == 0, "a request lasts one tick");
}

/// The converse, for every matrix: an alive agent whose request holds nothing outside its declared capabilities,
/// and whose role was declared with movement (the one privilege a tick asks for of itself), is never dropped: its
/// fate has no FATE_DROPPED bit, it is not doomed, and it goes on acting unless the loop breaker flushed it in that
/// same tick.
#[kani::proof]
#[kani::unwind(9)]
fn a_declared_request_never_drops_the_pointer() {
    let d = dims_on(SMALL, SMALL);
    let mut m = any_matrix::<SMALL_CELLS, { STATIONS * SMALL_CELLS }>(&d);
    let i = index(d.capacity);
    let t: u32 = kani::any();
    kani::assume(m.alive[i] & 1 == 1 && m.doomed[i] & 1 == 0);
    kani::assume(m.req[i] & !m.caps[i] == 0);
    kani::assume(m.caps[i] & CAP_MOVE != 0);

    let fate = agent_tick(&d, &mut m, i, t, step_of(&d));

    assert!(fate & FATE_DROPPED == 0, "a declared request is never a violation");
    assert!(m.doomed[i] == 0);
    assert!(fate & FATE_FLUSHED != 0 || m.alive[i] == 1, "it goes on acting, unless the loop breaker flushed it");
}

/// A flush zeroes exactly one row, its weights and its block, for every slot.
#[kani::proof]
#[kani::unwind(9)]
fn flush_zeroes_one_row_only() {
    let d = dims();
    let mut m = any_matrix::<CELLS, { STATIONS * CELLS }>(&d);
    let i = index(d.capacity);
    let inside = index(d.block_words);
    let outside = index(m.memory.len());
    kani::assume(!(i * d.block_words..(i + 1) * d.block_words).contains(&outside));
    let kept = m.memory[outside];
    flush(&d, &mut m, i);
    assert!(m.alive[i] == 0 && m.caps[i] == 0 && m.px[i].to_bits() == 0 && m.pz[i].to_bits() == 0);
    assert!(m.memory[i * d.block_words + inside] == 0);
    assert!(m.weights[i * d.stations + index(d.stations)] == 0);
    assert!(m.memory[outside] == kept);
}

/// One relaxation pass over every field, wall and station content never indexes out of its arrays and never writes a
/// distance past INF.
#[kani::proof]
#[kani::unwind(66)]
fn relax_pass_stays_in_bounds() {
    const CELLS: usize = SMALL * SMALL;
    let d = dims_on(SMALL, SMALL);
    let walls: [u32; CELLS] = kani::any();
    let station: [u32; STATIONS] = kani::any();
    let src: [u32; STATIONS * CELLS] = kani::any();
    let mut dst: [u32; STATIONS * CELLS] = kani::any();
    let changed = relax_pass(&d, &walls, &station, &src, &mut dst);
    assert!(changed as usize <= d.stations * CELLS);
    assert!(dst[index(STATIONS * CELLS)] <= INF);
}

/// Every comparator of every pass of the bitonic network over an array of the smallest power-of-two sizes lands
/// inside the array, a pass makes at most one swap per comparator, and every key ends where it was or at its
/// comparator's partner (the pass moves keys only within pairs: a witness index, not a sum over the array, which
/// the checker could not finish).
#[kani::proof]
#[kani::unwind(9)]
fn bitonic_pass_stays_in_bounds() {
    let before: [u32; 8] = kani::any();
    let mut keys = before;
    let (k, j): (usize, usize) = (kani::any(), kani::any());
    kani::assume(k.is_power_of_two() && k >= 2 && k <= 8);
    kani::assume(j.is_power_of_two() && j >= 1 && j < k);
    let swaps = bitonic_pass(&mut keys, k, j);
    assert!(swaps <= 4);
    let w = index(8);
    assert!(keys[w] == before[w] || keys[w] == before[w ^ j]);
}

/// The comparator orders its pair whichever way it is asked, for all keys.
#[kani::proof]
fn compare_exchange_orders_the_pair() {
    let mut keys = [kani::any::<u32>(), kani::any::<u32>()];
    let ascending: u32 = kani::any();
    kani::assume(ascending <= 1);
    compare_exchange(&mut keys, 0, 1, ascending);
    if ascending == 1 {
        assert!(keys[0] <= keys[1]);
    } else {
        assert!(keys[0] >= keys[1]);
    }
}

/// The mask arithmetic the hot path is built from means what it is taken to mean, for all 2^32 words.
#[kani::proof]
fn masks_mean_what_the_kernels_take_them_to_mean() {
    let x: u32 = kani::any();
    assert!(nz(x) == (x != 0) as u32);
    let m: u32 = kani::any();
    kani::assume(m <= 1);
    let (a, b): (u32, u32) = (kani::any(), kani::any());
    assert!(sel(m, a, b) == if m == 1 { a } else { b });
}
