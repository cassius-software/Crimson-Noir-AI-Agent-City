// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the simulation hot path, and nothing else: the per-agent tick and the per-cell
//! routing relaxation, written without `if`, `else`, `match` or a data-dependent loop (a test reads this file and
//! refuses one). Every decision is a 1/0 mask folded into arithmetic, the design's
//! `NewState = CurrentState + (UpdateValue × Mask)`: a blocked agent adds zero. Each agent reads and writes only its
//! own row of the Global Matrix (and reads the shared world), so the order agents are visited in cannot change the
//! result, and `shaders/swarm.wgsl` runs the same arithmetic one invocation per agent (the hosted runtime checks the
//! two agree bit for bit). The containment rules live here too, because they are arithmetic: a privilege outside the
//! agent's declared capabilities drops its pointer (it can no longer act, and its row is zeroed during the next
//! tick); the same failure state, at the same cell, the same way, `loop_limit` times in a row flushes and zeroes its
//! row at once; and every memory write lands inside the agent's own block because the index is masked into it.
//! What breaks if it is removed? The swarm does not move, learn or stay contained.

use crate::config::{CAP_LEARN, CAP_MEMORY, CAP_MOVE, CAP_ROUTE, Dims};
use crate::hash::mix32;
use crate::lanes::{F32x4, LANES, U32x4, mix32x4};
use crate::matrix::Matrix;

/// What a station's field holds for a wall or a cell it cannot reach.
pub const INF: u32 = 0x3fff_ffff;

/// The fate bits a tick records for a slot.
pub const FATE_DROPPED: u32 = 1;
pub const FATE_FLUSHED: u32 = 2;
pub const FATE_REAPED: u32 = 4;
pub const FATE_DOCKED: u32 = 8;

/// 1 when `x` is not zero, else 0.
#[inline(always)]
pub fn nz(x: u32) -> u32 {
    (x | x.wrapping_neg()) >> 31
}

/// `a` where the 1/0 mask `m` is 1, else `b`: bit arithmetic, no branch.
#[inline(always)]
pub fn sel(m: u32, a: u32, b: u32) -> u32 {
    b ^ ((a ^ b) & m.wrapping_neg())
}

#[inline(always)]
pub fn sel_i(m: u32, a: i32, b: i32) -> i32 {
    sel(m, a as u32, b as u32) as i32
}

/// A 1/0 mask widened to all ones or all zeros.
#[inline(always)]
pub fn wide(m: u32) -> u32 {
    m.wrapping_neg()
}

/// The counts one tick leaves behind.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Tally {
    pub dropped: u32,
    pub flushed: u32,
    pub reaped: u32,
    pub docked: u32,
}

/// The distance one tick moves an agent, in cells (an exact binary fraction, so positions stay exact).
pub fn step_of(d: &Dims) -> f32 {
    d.step_eighths as f32 * 0.125
}

/// One tick of the whole pool: LANES agents at a time through the SIMD kernel (`tick_lanes`), then any slots past
/// the last full lane group one at a time through the scalar reference (a capacity is a power of two of at least
/// 64, so there are none; the arithmetic is the same either way).
pub fn tick(d: &Dims, m: &mut Matrix, t: u32) -> Tally {
    let step = step_of(d);
    let mut tally = Tally::default();
    let groups = d.capacity / LANES;
    for g in 0..groups {
        let fate = tick_lanes(d, m, g * LANES, t, step);
        tally.dropped += fate.and(U32x4::splat(FATE_DROPPED)).sum();
        tally.flushed += fate.and(U32x4::splat(FATE_FLUSHED)).shr::<1>().sum();
        tally.reaped += fate.and(U32x4::splat(FATE_REAPED)).shr::<2>().sum();
        tally.docked += fate.and(U32x4::splat(FATE_DOCKED)).shr::<3>().sum();
    }
    for i in groups * LANES..d.capacity {
        let fate = agent_tick(d, m, i, t, step);
        tally.dropped += fate & FATE_DROPPED;
        tally.flushed += (fate & FATE_FLUSHED) >> 1;
        tally.reaped += (fate & FATE_REAPED) >> 2;
        tally.docked += (fate & FATE_DOCKED) >> 3;
    }
    tally
}

/// The same tick, one agent at a time through the scalar reference kernel alone (what the SIMD kernel is held to).
pub fn tick_scalar(d: &Dims, m: &mut Matrix, t: u32) -> Tally {
    let step = step_of(d);
    let mut tally = Tally::default();
    for i in 0..d.capacity {
        let fate = agent_tick(d, m, i, t, step);
        tally.dropped += fate & FATE_DROPPED;
        tally.flushed += (fate & FATE_FLUSHED) >> 1;
        tally.reaped += (fate & FATE_REAPED) >> 2;
        tally.docked += (fate & FATE_DOCKED) >> 3;
    }
    tally
}

/// Zeroes slot `i`'s row, its learned weights and its memory block where `keep` is all zeros; leaves them where it is
/// all ones.
#[inline(always)]
fn wipe(d: &Dims, m: &mut Matrix, i: usize, keep: u32) {
    m.px[i] = f32::from_bits(m.px[i].to_bits() & keep);
    m.pz[i] = f32::from_bits(m.pz[i].to_bits() & keep);
    m.alive[i] &= keep;
    m.doomed[i] &= keep;
    m.caps[i] &= keep;
    m.req[i] &= keep;
    m.role[i] &= keep;
    m.goal[i] &= keep;
    m.run[i] &= keep;
    m.last[i] &= keep;
    m.trips[i] &= keep;
    m.clock[i] &= keep;
    m.heading[i] &= keep;
    for w in &mut m.weights[i * d.stations..(i + 1) * d.stations] {
        *w &= keep as i32;
    }
    for w in &mut m.memory[i * d.block_words..(i + 1) * d.block_words] {
        *w &= keep;
    }
}

/// Zeroes slot `i`'s row, its learned weights and its memory block at once: the manual form of the loop breaker's
/// flush, for the terminal. It only clears, never grants, so it cannot raise a privilege or move an agent off the
/// floor; the index is the caller's to bound.
pub fn flush(d: &Dims, m: &mut Matrix, i: usize) {
    wipe(d, m, i, 0);
}

/// One agent slot's tick. Returns its fate bits (also stored in `fate`).
#[inline(always)]
pub fn agent_tick(d: &Dims, m: &mut Matrix, i: usize, t: u32, step: f32) -> u32 {
    let w = d.width as u32;
    let depth = d.depth as u32;
    let stations = d.stations as u32;
    let cells = w * depth;

    // The 1/0 masks are bit 0 of their words, whatever else a word holds.
    let a = m.alive[i] & 1;
    let caps = m.caps[i];
    // A pointer dropped during the last tick: its row is zeroed at the end of this one.
    let reaped = m.doomed[i] & 1;

    // Where the agent stands, and what its station's field says about the four cells around it.
    let cx = (m.px[i] as u32).min(w - 1);
    let cz = (m.pz[i] as u32).min(depth - 1);
    let c = cz * w + cx;
    let g = m.goal[i] & (stations - 1);
    let base = (g * cells) as usize;
    let here = m.field[base + c as usize];
    let fe = m.field[base + (cz * w + (cx + 1).min(w - 1)) as usize];
    let fw = m.field[base + (cz * w + cx.saturating_sub(1)) as usize];
    let fnorth = m.field[base + ((cz + 1).min(depth - 1) * w + cx) as usize];
    let fsouth = m.field[base + (cz.saturating_sub(1) * w + cx) as usize];

    // The closest of the four, ties broken east, west, north, south.
    let mut best = fe;
    let mut dx = 1i32;
    let mut dz = 0i32;
    let b = (fw < best) as u32;
    best = sel(b, fw, best);
    dx = sel_i(b, -1, dx);
    dz = sel_i(b, 0, dz);
    let b = (fnorth < best) as u32;
    best = sel(b, fnorth, best);
    dx = sel_i(b, 0, dx);
    dz = sel_i(b, 1, dz);
    let b = (fsouth < best) as u32;
    best = sel(b, fsouth, best);
    dx = sel_i(b, 0, dx);
    dz = sel_i(b, -1, dz);

    // An agent without the route privilege patrols its heading instead: 0 east, 1 west, 2 north, 3 south.
    let routes = nz(caps & CAP_ROUTE);
    let h = m.heading[i] & 3;
    let hdx = sel_i((h == 0) as u32, 1, sel_i((h == 1) as u32, -1, 0));
    let hdz = sel_i((h == 2) as u32, 1, sel_i((h == 3) as u32, -1, 0));
    let dx = sel_i(routes, dx, hdx);
    let dz = sel_i(routes, dz, hdz);
    let want = a & sel(routes, (best < here) as u32, 1);
    let arrived = a & routes & ((here == 0) as u32);

    // What the agent asks for this tick: what it is about to use, and anything asked on its behalf (`req`).
    let learns = arrived & nz(caps & CAP_LEARN);
    let writes = a & nz(caps & CAP_MEMORY);
    let asked = m.req[i] | (CAP_MOVE * want) | (CAP_ROUTE * (routes & a)) | (CAP_LEARN * learns) | (CAP_MEMORY * writes);
    // The dropped-pointer defense: a privilege its role was not declared with, and the agent can no longer act.
    let violated = a & nz(asked & !caps);
    let ok = a & (violated ^ 1);

    // Move one step toward the chosen cell, unless that cell is a wall.
    let tx = (cx as i32 + dx).max(0).min(w as i32 - 1) as u32;
    let tz = (cz as i32 + dz).max(0).min(depth as i32 - 1) as u32;
    let blocked = m.walls[(tz * w + tx) as usize] & 1;
    let moves = ok & want & nz(caps & CAP_MOVE);
    let go = moves & (blocked ^ 1);
    // The floor's edge holds even when the operator has cleared the edge walls.
    m.px[i] = (m.px[i] + (dx as f32) * step * (go as f32)).max(0.0).min(w as f32 - 0.125);
    m.pz[i] = (m.pz[i] + (dz as f32) * step * (go as f32)).max(0.0).min(depth as f32 - 0.125);
    // A patrol that meets a wall turns around (east and west, north and south, are pairs).
    m.heading[i] = h ^ (moves & blocked & (routes ^ 1));

    // The loop breaker: the same failure, at the same cell, the same way, again and again.
    let fail = moves & blocked;
    let way = ((dx + 1) as u32) | (((dz + 1) as u32) << 2);
    let sig = (mix32((c << 4) | way) | 1) * fail;
    let same = (sig == m.last[i]) as u32;
    let run = m.run[i].wrapping_mul(same).wrapping_add(1) * fail;
    m.run[i] = run;
    m.last[i] = sig;
    let flushed = a & ((run >= d.loop_limit) as u32);

    // Docking: learn how quick the trip was (Q16.16: 64 / (ticks + 64)), then pick the next station by learned weight
    // plus a little exploration noise.
    let docked = arrived & ok;
    let wi = i * d.stations + g as usize;
    let reward = ((1u32 << 22) / (m.clock[i].min(1 << 20) + 64)) as i32;
    let lw = m.weights[wi];
    let learned = (learns & ok) as i32;
    m.weights[wi] = lw.wrapping_add((reward.wrapping_sub(lw) >> d.learn_shift).wrapping_mul(learned));
    let mut pick = g;
    let mut top = i32::MIN;
    for s in 0..stations {
        let noise = (mix32((i as u32) ^ (t << 12) ^ (s << 24) ^ 0x9e37_79b9) % (d.explore + 1)) as i32;
        let weight = m.weights[i * d.stations + s as usize].wrapping_add(noise);
        let cand = sel_i((s == g) as u32, i32::MIN, weight);
        let better = (cand > top) as u32;
        top = sel_i(better, cand, top);
        pick = sel(better, s, pick);
    }
    m.goal[i] = sel(docked, pick, g);
    m.trips[i] = m.trips[i].wrapping_add(docked);
    m.clock[i] = m.clock[i].wrapping_add(1) * (docked ^ 1) * a;

    // Memory: the agent logs where it stood into its own block; the index is masked into the block.
    let slot = i * d.block_words + (t as usize & (d.block_words - 1));
    m.memory[slot] = sel(writes & ok, c | (way << 16) | 0x8000_0000, m.memory[slot]);

    // Requests last one tick. A dropped pointer stops acting now and is zeroed during the next tick; a flush zeroes
    // the row at once; a row dropped last tick is zeroed now.
    m.req[i] = 0;
    m.alive[i] = a & (violated ^ 1);
    m.doomed[i] = violated;
    wipe(d, m, i, wide((flushed | reaped) ^ 1));
    let fate = violated | (flushed << 1) | (reaped << 2) | (docked << 3);
    m.fate[i] = fate;
    fate
}

/// The tick of LANES agent slots `i0 .. i0 + LANES` at once: `agent_tick` line for line, every word a lane of a SIMD
/// register and every 1/0 mask a lane of ones and zeros, the same arithmetic in the same order (lanes.rs says which
/// operations are packed instructions and which are the scalar operation lane by lane), so the lanes leave the bits
/// the scalar kernel leaves. The slots' rows are disjoint and the shared world is only read, so LANES agents in one
/// register are as isolated from each other as LANES agents visited in turn. Returns the lanes' fate bits.
#[inline(always)]
pub fn tick_lanes(d: &Dims, m: &mut Matrix, i0: usize, t: u32, step: f32) -> U32x4 {
    let w = d.width as u32;
    let depth = d.depth as u32;
    let stations = d.stations as u32;
    let cells = w * depth;
    let wv = U32x4::splat(w);
    let one = U32x4::splat(1);
    let zero = U32x4::zero();
    let lanes = U32x4::iota(i0 as u32);
    let row = i0..i0 + LANES;

    // The 1/0 masks are bit 0 of their words, whatever else a word holds.
    let a = U32x4::load(&m.alive[row.clone()]).and(one);
    let caps = U32x4::load(&m.caps[row.clone()]);
    let reaped = U32x4::load(&m.doomed[row.clone()]).and(one);

    // Where each agent stands, and what its station's field says about the four cells around it.
    let px = F32x4::load(&m.px[row.clone()]);
    let pz = F32x4::load(&m.pz[row.clone()]);
    let cx = px.to_u32_sat().min_u(U32x4::splat(w - 1));
    let cz = pz.to_u32_sat().min_u(U32x4::splat(depth - 1));
    let c = cz.mul(wv).add(cx);
    let g = U32x4::load(&m.goal[row.clone()]).and(U32x4::splat(stations - 1));
    let base = g.mul(U32x4::splat(cells));
    let east = cx.add(one).min_u(U32x4::splat(w - 1));
    // `cx.saturating_sub(1)` is `max(cx, 1) - 1`.
    let west = cx.lt_u(one).sel(one, cx).sub(one);
    let north = cz.add(one).min_u(U32x4::splat(depth - 1));
    let south = cz.lt_u(one).sel(one, cz).sub(one);
    let here = U32x4::gather(&m.field, base.add(c));
    let fe = U32x4::gather(&m.field, base.add(cz.mul(wv)).add(east));
    let fw = U32x4::gather(&m.field, base.add(cz.mul(wv)).add(west));
    let fnorth = U32x4::gather(&m.field, base.add(north.mul(wv)).add(cx));
    let fsouth = U32x4::gather(&m.field, base.add(south.mul(wv)).add(cx));

    // The closest of the four, ties broken east, west, north, south.
    let (plus, minus) = (one, U32x4::splat(u32::MAX));
    let mut best = fe;
    let mut dx = plus;
    let mut dz = zero;
    let b = fw.lt_u(best);
    best = b.sel(fw, best);
    dx = b.sel(minus, dx);
    dz = b.sel(zero, dz);
    let b = fnorth.lt_u(best);
    best = b.sel(fnorth, best);
    dx = b.sel(zero, dx);
    dz = b.sel(plus, dz);
    let b = fsouth.lt_u(best);
    best = b.sel(fsouth, best);
    dx = b.sel(zero, dx);
    dz = b.sel(minus, dz);

    // An agent without the route privilege patrols its heading instead: 0 east, 1 west, 2 north, 3 south.
    let routes = caps.and(U32x4::splat(CAP_ROUTE)).nz();
    let h = U32x4::load(&m.heading[row.clone()]).and(U32x4::splat(3));
    let hdx = h.eq(zero).sel(plus, h.eq(one).sel(minus, zero));
    let hdz = h.eq(U32x4::splat(2)).sel(plus, h.eq(U32x4::splat(3)).sel(minus, zero));
    let dx = routes.sel(dx, hdx);
    let dz = routes.sel(dz, hdz);
    let want = a.and(routes.sel(best.lt_u(here), one));
    let arrived = a.and(routes).and(here.eq(zero));

    // What each agent asks for this tick, and the dropped-pointer defense (a mask times a constant is the constant
    // under the mask widened).
    let learns = arrived.and(caps.and(U32x4::splat(CAP_LEARN)).nz());
    let writes = a.and(caps.and(U32x4::splat(CAP_MEMORY)).nz());
    let asked = U32x4::load(&m.req[row.clone()])
        .or(U32x4::splat(CAP_MOVE).and(want.wide()))
        .or(U32x4::splat(CAP_ROUTE).and(routes.and(a).wide()))
        .or(U32x4::splat(CAP_LEARN).and(learns.wide()))
        .or(U32x4::splat(CAP_MEMORY).and(writes.wide()));
    let violated = a.and(asked.and(caps.xor(minus)).nz());
    let ok = a.and(violated.xor(one));

    // Move one step toward the chosen cell, unless that cell is a wall (the target clamped to the floor as signed
    // words: `.max(0).min(w - 1)`).
    let tx = cx.add(dx);
    let tx = tx.gt_i(zero).sel(tx, zero);
    let tx = tx.gt_i(U32x4::splat(w - 1)).sel(U32x4::splat(w - 1), tx);
    let tz = cz.add(dz);
    let tz = tz.gt_i(zero).sel(tz, zero);
    let tz = tz.gt_i(U32x4::splat(depth - 1)).sel(U32x4::splat(depth - 1), tz);
    let blocked = U32x4::gather(&m.walls, tz.mul(wv).add(tx)).and(one);
    let moves = ok.and(want).and(caps.and(U32x4::splat(CAP_MOVE)).nz());
    let go = moves.and(blocked.xor(one));
    let stepv = F32x4::splat(step);
    let px = px.add(dx.to_f32().mul(stepv).mul(go.to_f32())).clamp_each(0.0, w as f32 - 0.125);
    let pz = pz.add(dz.to_f32().mul(stepv).mul(go.to_f32())).clamp_each(0.0, depth as f32 - 0.125);
    let heading = h.xor(moves.and(blocked).and(routes.xor(one)));

    // The loop breaker: the same failure, at the same cell, the same way, again and again.
    let fail = moves.and(blocked);
    let way = dx.add(one).or(dz.add(one).shl::<2>());
    let sig = mix32x4(c.shl::<4>().or(way)).or(one).and(fail.wide());
    let last = U32x4::load(&m.last[row.clone()]);
    let same = sig.eq(last);
    let run = U32x4::load(&m.run[row.clone()]).and(same.wide()).add(one).and(fail.wide());
    let flushed = a.and(run.lt_u(U32x4::splat(d.loop_limit)).xor(one));

    // Docking: learn how quick the trip was (Q16.16: 64 / (ticks + 64)), then pick the next station by learned weight
    // plus a little exploration noise.
    let docked = arrived.and(ok);
    let stationsv = U32x4::splat(stations);
    let wi = lanes.mul(stationsv).add(g);
    let clock = U32x4::load(&m.clock[row.clone()]);
    let reward = U32x4::splat(1 << 22).div_each(clock.min_u(U32x4::splat(1 << 20)).add(U32x4::splat(64)));
    let lw = U32x4::gather_i(&m.weights, wi);
    let learned = learns.and(ok);
    let lw = lw.add(reward.sub(lw).sra(d.learn_shift).and(learned.wide()));
    wi.scatter_i(&mut m.weights, lw);
    let mut pick = g;
    let mut top = U32x4::splat(i32::MIN as u32);
    let salt = lanes.xor(U32x4::splat((t << 12) ^ 0x9e37_79b9));
    for s in 0..stations {
        let sv = U32x4::splat(s);
        let noise = mix32x4(salt.xor(U32x4::splat(s << 24))).rem(d.explore + 1);
        let weight = U32x4::gather_i(&m.weights, lanes.mul(stationsv).add(sv)).add(noise);
        let cand = sv.eq(g).sel(U32x4::splat(i32::MIN as u32), weight);
        let better = cand.gt_i(top);
        top = better.sel(cand, top);
        pick = better.sel(sv, pick);
    }
    let goal = docked.sel(pick, g);
    let trips = U32x4::load(&m.trips[row.clone()]).add(docked);
    let clock = clock.add(one).and(docked.xor(one).wide()).and(a.wide());

    // Memory: each agent logs where it stood into its own block; the index is masked into the block.
    let slot = lanes.mul(U32x4::splat(d.block_words as u32)).add(U32x4::splat(t & (d.block_words as u32 - 1)));
    let logged = c.or(way.shl::<16>()).or(U32x4::splat(0x8000_0000));
    let held = U32x4::gather(&m.memory, slot);
    slot.scatter(&mut m.memory, writes.and(ok).sel(logged, held));

    // Requests last one tick. A dropped pointer stops acting now and is zeroed during the next tick; a flush zeroes
    // the row at once; a row dropped last tick is zeroed now: every word of the row is kept under `keep`.
    let keep = flushed.or(reaped).xor(one).wide();
    px.bits().and(keep).as_f32().store(&mut m.px[row.clone()]);
    pz.bits().and(keep).as_f32().store(&mut m.pz[row.clone()]);
    a.and(violated.xor(one)).and(keep).store(&mut m.alive[row.clone()]);
    violated.and(keep).store(&mut m.doomed[row.clone()]);
    caps.and(keep).store(&mut m.caps[row.clone()]);
    zero.store(&mut m.req[row.clone()]);
    U32x4::load(&m.role[row.clone()]).and(keep).store(&mut m.role[row.clone()]);
    goal.and(keep).store(&mut m.goal[row.clone()]);
    run.and(keep).store(&mut m.run[row.clone()]);
    sig.and(keep).store(&mut m.last[row.clone()]);
    trips.and(keep).store(&mut m.trips[row.clone()]);
    clock.and(keep).store(&mut m.clock[row.clone()]);
    heading.and(keep).store(&mut m.heading[row.clone()]);
    for (l, &k) in keep.to_array().iter().enumerate() {
        let i = i0 + l;
        for w in &mut m.weights[i * d.stations..(i + 1) * d.stations] {
            *w &= k as i32;
        }
        for w in &mut m.memory[i * d.block_words..(i + 1) * d.block_words] {
            *w &= k;
        }
    }
    let fate = violated.or(flushed.shl::<1>()).or(reaped.shl::<2>()).or(docked.shl::<3>());
    fate.store(&mut m.fate[row]);
    fate
}

/// One Jacobi pass of the routing relaxation for every station's field: each cell takes the smallest of its own
/// distance and its neighbours' plus one; a wall is INF and a station's own cell is 0. Returns how many cells changed.
pub fn relax_pass(d: &Dims, walls: &[u32], station: &[u32], src: &[u32], dst: &mut [u32]) -> u32 {
    let w = d.width as u32;
    let depth = d.depth as u32;
    let cells = w * depth;
    let mut changed = 0;
    for s in 0..d.stations as u32 {
        let base = (s * cells) as usize;
        let home = station[s as usize];
        for c in 0..cells {
            let x = c % w;
            let z = c / w;
            let e = src[base + (z * w + (x + 1).min(w - 1)) as usize];
            let west = src[base + (z * w + x.saturating_sub(1)) as usize];
            let n = src[base + ((z + 1).min(depth - 1) * w + x) as usize];
            let south = src[base + (z.saturating_sub(1) * w + x) as usize];
            let near = e.min(west).min(n).min(south);
            let own = src[base + c as usize];
            let v = own.min(near.min(INF - 1) + 1);
            let v = sel(walls[c as usize] & 1, INF, v);
            let v = sel((c == home) as u32, 0, v);
            dst[base + c as usize] = v;
            changed += (v != own) as u32;
        }
    }
    changed
}

/// The comparator of a sorting network: puts the smaller key first when `ascending` is 1, the larger when 0. Returns 1
/// if it swapped them.
#[inline(always)]
pub fn compare_exchange(keys: &mut [u32], lo: usize, hi: usize, ascending: u32) -> u32 {
    let a = keys[lo];
    let b = keys[hi];
    let first = sel(ascending, a.min(b), a.max(b));
    let second = sel(ascending, a.max(b), a.min(b));
    keys[lo] = first;
    keys[hi] = second;
    (first != a) as u32
}

/// One pass of a bitonic sort over a power-of-two array (stage `k`, distance `j`): every comparator of the pass,
/// numbered so that none is skipped and none needs a test. Returns the swaps it made.
pub fn bitonic_pass(keys: &mut [u32], k: usize, j: usize) -> u32 {
    let mut swaps = 0;
    for p in 0..keys.len() / 2 {
        let i = ((p & !(j - 1)) << 1) | (p & (j - 1));
        swaps += compare_exchange(keys, i, i | j, ((i & k) == 0) as u32);
    }
    swaps
}
