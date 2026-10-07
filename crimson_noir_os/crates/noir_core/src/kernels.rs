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

/// One tick of the whole pool.
pub fn tick(d: &Dims, m: &mut Matrix, t: u32) -> Tally {
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
