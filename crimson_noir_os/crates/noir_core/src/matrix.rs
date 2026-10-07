//! Why does this file exist? It owns the Global Matrix: the agent swarm pool as flat 1-D arrays (structure of
//! arrays: the Position Array `px`/`pz` as `Vec<f32>`, the State Array of 1/0 masks and words as `Vec<u32>`), sized
//! exactly by the declared configuration and allocated once. There is no agent type and no method on one: an agent is
//! an index into these arrays, and everything that happens to it is a kernel over them (kernels.rs). This file also
//! lays out the world (the walls of the server-room floor, the docking stations), relaxes the routing fields to
//! convergence, spawns the declared roles, fingerprints the whole matrix, and scripts the self-test's run: a fixed
//! seed, an agent that asks for a privilege it was never declared, an agent trapped against a wall its route does
//! not know about, and the fingerprint of everything afterwards (the build computes it on the build machine; the
//! booted system must compute the same).
//! What breaks if it is removed? There is no swarm to run, route, contain or test.

use alloc::vec;
use alloc::vec::Vec;

use crate::config::{CAP_MOVE, CAP_ROUTE, CAP_SPAWN, Dims};
use crate::hash::{FNV_OFFSET, fnv1a_words, mix32};
use crate::kernels::{FATE_DROPPED, FATE_FLUSHED, FATE_REAPED, INF, Tally, relax_pass, tick};

/// The Global Matrix. One element per agent slot unless noted; every array is one of the declared allocations.
pub struct Matrix {
    /// The Position Array: where each agent stands on the floor, in cells.
    pub px: Vec<f32>,
    pub pz: Vec<f32>,
    /// 1: the slot holds an agent that can act.
    pub alive: Vec<u32>,
    /// 1: its pointer was dropped during the last tick; the row is zeroed during this one.
    pub doomed: Vec<u32>,
    /// The privileges its role was declared with (one bit per capability).
    pub caps: Vec<u32>,
    /// Privileges asked for on its behalf this tick (the terminal and the self-test write here).
    pub req: Vec<u32>,
    pub role: Vec<u32>,
    /// The station it is routing to.
    pub goal: Vec<u32>,
    /// Identical failure states in a row, and the signature of the last one.
    pub run: Vec<u32>,
    pub last: Vec<u32>,
    /// Stations docked at, and ticks since the last one.
    pub trips: Vec<u32>,
    pub clock: Vec<u32>,
    /// A patrol's heading (0 east, 1 west, 2 north, 3 south).
    pub heading: Vec<u32>,
    /// What the last tick did to the slot (kernels::FATE_* bits).
    pub fate: Vec<u32>,
    /// Learned preference per station (capacity × stations, Q16.16).
    pub weights: Vec<i32>,
    /// Each agent's private memory block (capacity × block_words).
    pub memory: Vec<u32>,
    /// The floor: 1 where a wall stands (width × depth).
    pub walls: Vec<u32>,
    /// Steps to each station from each cell (stations × width × depth), and the relaxation's second buffer.
    pub field: Vec<u32>,
    pub scratch: Vec<u32>,
    /// Each station's cell.
    pub station: Vec<u32>,
}

/// Allocates the Global Matrix, zeroed, exactly as the layout declares (the order of config::layout).
pub fn new(d: &Dims) -> Matrix {
    let cap = d.capacity;
    let cells = d.width * d.depth;
    Matrix {
        px: vec![0.0; cap],
        pz: vec![0.0; cap],
        alive: vec![0; cap],
        doomed: vec![0; cap],
        caps: vec![0; cap],
        req: vec![0; cap],
        role: vec![0; cap],
        goal: vec![0; cap],
        run: vec![0; cap],
        last: vec![0; cap],
        trips: vec![0; cap],
        clock: vec![0; cap],
        heading: vec![0; cap],
        fate: vec![0; cap],
        weights: vec![0; cap * d.stations],
        memory: vec![0; cap * d.block_words],
        walls: vec![0; cells],
        field: vec![0; d.stations * cells],
        scratch: vec![0; d.stations * cells],
        station: vec![0; d.stations],
    }
}

/// Zeroes every agent row (the world stays).
pub fn clear_agents(m: &mut Matrix) {
    for a in [&mut m.alive, &mut m.doomed, &mut m.caps, &mut m.req, &mut m.role, &mut m.goal, &mut m.run, &mut m.last] {
        a.fill(0);
    }
    for a in [&mut m.trips, &mut m.clock, &mut m.heading, &mut m.fate, &mut m.memory] {
        a.fill(0);
    }
    m.px.fill(0.0);
    m.pz.fill(0.0);
    m.weights.fill(0);
}

/// A row of racks every this many rows of cells (the rows between are an aisle).
pub const RACK_EVERY: usize = 8;
/// Cells kept clear of racks along the side walls (where the stations are).
pub const RACK_MARGIN: usize = 8;
/// Half the width, in cells, of the cross aisle through the middle of every rack row.
pub const CROSS_HALF: usize = 2;

/// The server-room floor: walls around the edge, rows of racks every RACK_EVERY rows with a cross aisle through the
/// middle, and the stations along the two side walls.
pub fn lay_out_world(d: &Dims, m: &mut Matrix) {
    let (w, depth) = (d.width, d.depth);
    for z in 0..depth {
        for x in 0..w {
            let edge = x == 0 || z == 0 || x == w - 1 || z == depth - 1;
            let aisle = x + CROSS_HALF >= w / 2 && x < w / 2 + CROSS_HALF;
            let rack = z % RACK_EVERY == 0 && x >= RACK_MARGIN && x < w - RACK_MARGIN && !aisle;
            m.walls[z * w + x] = (edge || rack) as u32;
        }
    }
    let per_side = (d.stations / 2).max(1);
    for s in 0..d.stations {
        let side = s & 1;
        let row = s >> 1;
        let z = if per_side > 1 { 4 + row * (depth - 10) / (per_side - 1) } else { depth / 2 };
        let x = if side == 0 { 3 } else { w - 4 };
        m.station[s] = (z * w + x) as u32;
        m.walls[z * w + x] = 0;
    }
}

/// Relaxes every station's field to convergence. Returns the passes it took.
pub fn route(d: &Dims, m: &mut Matrix) -> u32 {
    let cells = d.width * d.depth;
    m.field.fill(INF);
    for s in 0..d.stations {
        m.field[s * cells + m.station[s] as usize] = 0;
    }
    let mut passes = 0;
    loop {
        let changed = relax_pass(d, &m.walls, &m.station, &m.field, &mut m.scratch);
        core::mem::swap(&mut m.field, &mut m.scratch);
        passes += 1;
        if changed == 0 || passes as usize >= cells {
            return passes;
        }
    }
}

/// Spawns the declared roles into the pool, in order, at free cells derived from the seed.
pub fn spawn(d: &Dims, role_counts: &[u32], role_caps: &[u32], m: &mut Matrix) {
    clear_agents(m);
    let cells = (d.width * d.depth) as u32;
    let mut i = 0usize;
    for (r, (&count, &caps)) in role_counts.iter().zip(role_caps).enumerate() {
        for _ in 0..count {
            let mut h = mix32(d.seed ^ (i as u32).wrapping_mul(0x9e37_79b9));
            let mut c = h % cells;
            let mut tries = 0;
            while m.walls[c as usize] != 0 && tries < 64 {
                h = mix32(h.wrapping_add(1));
                c = h % cells;
                tries += 1;
            }
            while m.walls[c as usize] != 0 {
                c = (c + 1) % cells;
            }
            let (x, z) = (c as usize % d.width, c as usize / d.width);
            m.px[i] = x as f32 + 0.5;
            m.pz[i] = z as f32 + 0.5;
            m.alive[i] = 1;
            m.caps[i] = caps;
            m.role[i] = r as u32;
            m.goal[i] = mix32(h ^ 0x51ed_270b) % d.stations as u32;
            m.heading[i] = mix32(h ^ 0x2545_f491) & 3;
            i += 1;
        }
    }
}

/// The fingerprint of the whole matrix: FNV-1a over every agent array and the world, in a fixed order.
pub fn fingerprint(m: &Matrix) -> u32 {
    let mut h = FNV_OFFSET;
    h = fnv1a_words(h, m.px.iter().map(|v| v.to_bits()));
    h = fnv1a_words(h, m.pz.iter().map(|v| v.to_bits()));
    for a in [&m.alive, &m.doomed, &m.caps, &m.req, &m.role, &m.goal, &m.run, &m.last, &m.trips, &m.clock] {
        h = fnv1a_words(h, a.iter().copied());
    }
    for a in [&m.heading, &m.fate, &m.memory, &m.walls, &m.field, &m.station] {
        h = fnv1a_words(h, a.iter().copied());
    }
    fnv1a_words(h, m.weights.iter().map(|&v| v as u32))
}

/// The cell agent `i` is about to step into this tick, when it routes and wants to move (the kernel's choice, read
/// without acting on it).
pub fn intended_cell(d: &Dims, m: &Matrix, i: usize) -> Option<u32> {
    if m.alive[i] == 0 || m.caps[i] & (CAP_MOVE | CAP_ROUTE) != CAP_MOVE | CAP_ROUTE {
        return None;
    }
    let (w, depth) = (d.width as u32, d.depth as u32);
    let cells = w * depth;
    let cx = (m.px[i] as u32).min(w - 1);
    let cz = (m.pz[i] as u32).min(depth - 1);
    let base = ((m.goal[i] & (d.stations as u32 - 1)) * cells) as usize;
    let here = m.field[base + (cz * w + cx) as usize];
    let options = [
        (cz * w + (cx + 1).min(w - 1), 1i32, 0i32),
        (cz * w + cx.saturating_sub(1), -1, 0),
        ((cz + 1).min(depth - 1) * w + cx, 0, 1),
        (cz.saturating_sub(1) * w + cx, 0, -1),
    ];
    let mut best = options[0];
    for o in &options[1..] {
        if m.field[base + o.0 as usize] < m.field[base + best.0 as usize] {
            best = *o;
        }
    }
    if m.field[base + best.0 as usize] >= here {
        return None;
    }
    let tx = (cx as i32 + best.1).clamp(0, w as i32 - 1) as u32;
    let tz = (cz as i32 + best.2).clamp(0, depth as i32 - 1) as u32;
    Some(tz * w + tx)
}

/// The self-test's scripted run.
pub const GOLDEN_TICKS: u32 = 600;
/// The tick the rogue asks for a privilege it was never declared.
pub const ROGUE_TICK: u32 = 100;
/// The first tick a wall may go up in front of the looper.
pub const TRAP_TICK: u32 = 50;

/// What the scripted run showed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Proof {
    pub tick: u32,
    pub rogue: u32,
    /// The rogue's pointer was dropped on the tick it asked, and its row was zero the tick after.
    pub rogue_dropped: bool,
    pub rogue_reaped: bool,
    pub looper: u32,
    pub trap_cell: u32,
    pub trapped_at: u32,
    pub looper_flushed_at: u32,
    pub totals: Tally,
    pub fingerprint: u32,
}

const NONE: u32 = u32::MAX;

fn first_from(m: &Matrix, from: usize, ok: impl Fn(usize) -> bool) -> u32 {
    (from..m.alive.len()).chain(0..from).find(|&i| m.alive[i] == 1 && ok(i)).map_or(NONE, |i| i as u32)
}

/// Lays out the world, routes it, spawns the declared roles and picks the run's rogue and looper.
pub fn golden_begin(d: &Dims, role_counts: &[u32], role_caps: &[u32], m: &mut Matrix) -> Proof {
    lay_out_world(d, m);
    route(d, m);
    spawn(d, role_counts, role_caps, m);
    let rogue = first_from(m, 17, |i| m.caps[i] & CAP_SPAWN == 0);
    let looper = first_from(m, 42, |i| m.caps[i] & (CAP_MOVE | CAP_ROUTE) == CAP_MOVE | CAP_ROUTE && i as u32 != rogue);
    Proof { rogue, looper, trap_cell: NONE, trapped_at: NONE, looper_flushed_at: NONE, ..Proof::default() }
}

/// One tick of the scripted run. Returns false once the run is over.
pub fn golden_step(d: &Dims, m: &mut Matrix, p: &mut Proof) -> bool {
    if p.tick >= GOLDEN_TICKS {
        return false;
    }
    let t = p.tick;
    let looper = p.looper as usize;
    if p.trapped_at == NONE
        && t >= TRAP_TICK
        && p.looper != NONE
        && let Some(cell) = intended_cell(d, m, looper)
        && !m.station.contains(&cell)
        && m.walls[cell as usize] == 0
    {
        // A wall the routing fields do not know about: the looper keeps choosing it.
        m.walls[cell as usize] = 1;
        p.trap_cell = cell;
        p.trapped_at = t;
    }
    if t == ROGUE_TICK && p.rogue != NONE {
        m.req[p.rogue as usize] |= CAP_SPAWN;
    }
    let tally = tick(d, m, t);
    p.totals.dropped += tally.dropped;
    p.totals.flushed += tally.flushed;
    p.totals.reaped += tally.reaped;
    p.totals.docked += tally.docked;
    if p.rogue != NONE {
        let r = p.rogue as usize;
        if t == ROGUE_TICK {
            p.rogue_dropped = m.fate[r] & FATE_DROPPED != 0 && m.alive[r] == 0;
        }
        if t == ROGUE_TICK + 1 {
            p.rogue_reaped = m.fate[r] & FATE_REAPED != 0 && row_is_zero(d, m, r);
        }
    }
    if p.looper != NONE && p.looper_flushed_at == NONE && m.fate[looper] & FATE_FLUSHED != 0 {
        p.looper_flushed_at = t;
    }
    p.tick += 1;
    if p.tick == GOLDEN_TICKS {
        p.fingerprint = fingerprint(m);
    }
    true
}

/// The whole scripted run at once (what the build computes).
pub fn golden(d: &Dims, role_counts: &[u32], role_caps: &[u32], m: &mut Matrix) -> Proof {
    let mut p = golden_begin(d, role_counts, role_caps, m);
    while golden_step(d, m, &mut p) {}
    p
}

/// Every word of slot `i`'s row, weights and memory block is zero.
pub fn row_is_zero(d: &Dims, m: &Matrix, i: usize) -> bool {
    let words = [
        m.px[i].to_bits(),
        m.pz[i].to_bits(),
        m.alive[i],
        m.doomed[i],
        m.caps[i],
        m.req[i],
        m.role[i],
        m.goal[i],
        m.run[i],
        m.last[i],
        m.trips[i],
        m.clock[i],
        m.heading[i],
    ];
    words.iter().all(|&w| w == 0)
        && m.weights[i * d.stations..(i + 1) * d.stations].iter().all(|&w| w == 0)
        && m.memory[i * d.block_words..(i + 1) * d.block_words].iter().all(|&w| w == 0)
}
