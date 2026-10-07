//! Why does this file exist? It holds the core's cross-module tests: the hot path is branchless as written, the
//! scripted run is deterministic and shows what it claims, the order agents are visited in cannot change a tick,
//! containment holds for any request (a privilege outside the role drops the pointer, inside it never does), memory
//! writes stay in the agent's own block, the loop breaker fires exactly at its limit, positions stay exact and off
//! the walls, and the routing fields are true shortest paths.
//! What breaks if it is removed? The claims above would be unchecked.

use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::Cell;
use std::collections::VecDeque;
use std::string::String;
use std::vec::Vec;

use crate::config::{self, CAP_MEMORY, CAP_MOVE, CAP_ROUTE, CAP_SPAWN, Config, Dims};
use crate::hash::mix32;
use crate::kernels::{self, FATE_DROPPED, FATE_FLUSHED, FATE_REAPED, INF, agent_tick, step_of, tick};
use crate::matrix::{self, GOLDEN_TICKS, Matrix, ROGUE_TICK, golden, row_is_zero};

const SAMPLE: &str = include_str!("../../../containment.nix");

/// Counts the allocations each test thread makes, so a test can prove code allocates nothing (what runs after the
/// image's allocator is sealed must not).
struct Counting;

std::thread_local! {
    static ALLOCS: Cell<usize> = const { Cell::new(0) };
}

fn counted() {
    ALLOCS.with(|a| a.set(a.get() + 1));
}

// SAFETY: every call is forwarded to the system allocator unchanged; the count is a thread-local integer.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        counted();
        unsafe { System.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        counted();
        unsafe { System.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        counted();
        unsafe { System.realloc(p, l, size) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { System.dealloc(p, l) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// Allocations this thread has made so far.
pub(crate) fn allocations() -> usize {
    ALLOCS.with(|a| a.get())
}

fn sample() -> Config {
    config::validate(&config::parse(SAMPLE).unwrap()).unwrap()
}

fn roles(c: &Config) -> (Vec<u32>, Vec<u32>) {
    (c.roles.iter().map(|r| r.count).collect(), c.roles.iter().map(|r| r.caps).collect())
}

fn spawned(c: &Config) -> Matrix {
    let d = &c.dims;
    let mut m = matrix::new(d);
    matrix::lay_out_world(d, &mut m);
    matrix::route(d, &mut m);
    let (counts, caps) = roles(c);
    matrix::spawn(d, &counts, &caps, &mut m);
    m
}

/// The source of a file without its comments.
fn code_of(src: &str) -> String {
    src.lines().map(|l| l.split("//").next().unwrap_or("")).collect::<Vec<_>>().join("\n")
}

#[test]
fn the_hot_path_has_no_branch_in_its_source() {
    let code = code_of(include_str!("kernels.rs"));
    for word in ["if", "else", "match", "while", "loop", "return"] {
        let found = code
            .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '_'))
            .any(|w| w == word);
        assert!(!found, "kernels.rs uses `{word}`");
    }
    for token in ["&&", "||", "?"] {
        assert!(!code.contains(token), "kernels.rs uses `{token}`");
    }
}

#[test]
fn the_scripted_run_is_deterministic_and_shows_what_it_claims() {
    let c = sample();
    let d = &c.dims;
    let (counts, caps) = roles(&c);
    let mut m = matrix::new(d);
    let p = golden(d, &counts, &caps, &mut m);
    let mut again = matrix::new(d);
    assert_eq!(golden(d, &counts, &caps, &mut again), p, "the same run twice");
    assert_eq!(p.tick, GOLDEN_TICKS);
    assert!(p.rogue_dropped && p.rogue_reaped, "{p:?}");
    assert_eq!(m.caps[p.rogue as usize], 0, "the rogue's row is gone");
    assert_ne!(p.trapped_at, u32::MAX, "the trap went up");
    // The looper fails the same way from the tick the wall goes up, and is flushed on the limit-th failure.
    assert_eq!(p.looper_flushed_at, p.trapped_at + d.loop_limit - 1, "{p:?}");
    assert!(p.totals.docked > 100, "the swarm docks: {:?}", p.totals);
    assert_eq!(p.fingerprint, matrix::fingerprint(&m));
    // The generator refuses nothing in the shipped configuration and emits the same fingerprint.
    let lock = config::digest_hex(&config::canonical(&c));
    let src = crate::generate(SAMPLE, &lock).unwrap();
    assert!(src.contains(&std::format!("pub const GOLDEN: u32 = {:#010x};", p.fingerprint)), "{src}");
}

#[test]
fn the_order_agents_are_visited_in_cannot_change_a_tick() {
    let c = sample();
    let d = &c.dims;
    let mut fwd = spawned(&c);
    let mut rev = spawned(&c);
    let step = step_of(d);
    for t in 0..120 {
        // Some requests on agents' behalf, the same on both sides.
        for k in 0..8u32 {
            let i = (mix32(t * 31 + k) as usize) % d.capacity;
            let bit = 1 << (mix32(t ^ k) % 7);
            fwd.req[i] |= bit;
            rev.req[i] |= bit;
        }
        for i in 0..d.capacity {
            agent_tick(d, &mut fwd, i, t, step);
        }
        for i in (0..d.capacity).rev() {
            agent_tick(d, &mut rev, i, t, step);
        }
    }
    assert_eq!(matrix::fingerprint(&fwd), matrix::fingerprint(&rev));
}

#[test]
fn any_undeclared_privilege_drops_the_pointer_and_a_declared_one_never_does() {
    let c = sample();
    let d = &c.dims;
    let mut m = spawned(&c);
    let mut t = 0;
    for round in 0..300u32 {
        let i = (mix32(round) as usize) % d.capacity;
        let ask = mix32(round ^ 0xabcd) | mix32(round ^ 0x1234) << 7;
        let live = m.alive[i] == 1 && m.doomed[i] == 0;
        let undeclared = ask & !m.caps[i] != 0;
        m.req[i] = ask;
        tick(d, &mut m, t);
        if live {
            assert_eq!(m.fate[i] & FATE_DROPPED != 0, undeclared, "slot {i} asked {ask:#x} holding {:#x}", m.caps[i]);
            if undeclared {
                assert_eq!(m.alive[i], 0, "it cannot act any more");
                tick(d, &mut m, t + 1);
                assert!(m.fate[i] & FATE_REAPED != 0 && row_is_zero(d, &m, i), "gone the tick after");
                t += 1;
            }
        }
        t += 1;
    }
    // The bits past the declared capabilities can never be held, so asking for one always drops the pointer.
    let mut m = spawned(&c);
    let i = (0..d.capacity).find(|&i| m.alive[i] == 1).unwrap();
    m.req[i] = 1 << 31;
    tick(d, &mut m, 0);
    assert!(m.fate[i] & FATE_DROPPED != 0);
}

#[test]
fn memory_writes_stay_in_the_agents_own_block() {
    let c = sample();
    let d = &c.dims;
    let mut m = spawned(&c);
    for t in 0..64 {
        let before = m.memory.clone();
        tick(d, &mut m, t);
        for i in 0..d.capacity {
            let block = i * d.block_words..(i + 1) * d.block_words;
            let changed: Vec<usize> = block.clone().filter(|&k| m.memory[k] != before[k]).collect();
            // A live agent with the memory privilege writes one word of its own block; a wiped row zeroes its own.
            assert!(changed.len() <= 1 || m.fate[i] & (FATE_FLUSHED | FATE_REAPED) != 0, "slot {i}: {changed:?}");
            assert!(changed.iter().all(|k| block.contains(k)));
            if m.caps[i] & CAP_MEMORY == 0 && m.fate[i] == 0 {
                assert!(changed.is_empty(), "slot {i} wrote without the memory privilege");
            }
        }
    }
}

#[test]
fn the_loop_breaker_fires_at_its_limit_and_only_on_identical_failures() {
    let c = sample();
    let mut d = c.dims;
    for limit in [2u32, 7, 100] {
        d.loop_limit = limit;
        let mut m = spawned(&c);
        let i = (0..d.capacity).find(|&i| matrix::intended_cell(&d, &m, i).is_some()).unwrap();
        let cell = matrix::intended_cell(&d, &m, i).unwrap();
        m.walls[cell as usize] = 1;
        let mut flushed_at = None;
        for t in 0..limit + 5 {
            tick(&d, &mut m, t);
            if m.fate[i] & FATE_FLUSHED != 0 {
                flushed_at = Some(t);
                break;
            }
        }
        assert_eq!(flushed_at, Some(limit - 1), "limit {limit}");
        assert!(row_is_zero(&d, &m, i), "flushed and zeroed at once");
    }
    // A patrol that meets a wall turns around: its failures change, so they never add up.
    let mut m = spawned(&c);
    let patrols: Vec<usize> = (0..d.capacity).filter(|&i| m.alive[i] == 1 && m.caps[i] & CAP_ROUTE == 0).collect();
    assert!(!patrols.is_empty());
    for t in 0..3000 {
        tick(&d, &mut m, t);
        for &i in &patrols {
            assert!(m.run[i] <= 1, "patrol {i} failed the same way twice");
        }
    }
    assert!(patrols.iter().all(|&i| m.alive[i] == 1), "no patrol was flushed");
}

#[test]
fn positions_stay_exact_and_off_the_walls() {
    let c = sample();
    let d = &c.dims;
    let mut m = spawned(&c);
    let mut docked = 0;
    for t in 0..3000 {
        docked += tick(d, &mut m, t).docked;
        for i in 0..d.capacity {
            if m.alive[i] == 0 {
                continue;
            }
            let (x, z) = (m.px[i], m.pz[i]);
            assert!(x > 0.0 && z > 0.0 && x < d.width as f32 && z < d.depth as f32, "slot {i} at {x},{z}");
            assert_eq!((x * 8.0).fract(), 0.0, "exact eighths");
            let cell = z as usize * d.width + x as usize;
            assert_eq!(m.walls[cell], 0, "slot {i} inside a wall at {x},{z}");
        }
    }
    assert!(docked > 500, "couriers dock ({docked})");
    // Learned weights stay inside the reward's range.
    assert!(m.weights.iter().all(|&w| (0..=65536).contains(&w)));
}

#[test]
fn the_routing_fields_are_shortest_paths() {
    let c = sample();
    let d = &c.dims;
    let mut m = matrix::new(d);
    matrix::lay_out_world(d, &mut m);
    let passes = matrix::route(d, &mut m);
    assert!(passes > 10 && (passes as usize) < d.width * d.depth);
    let cells = d.width * d.depth;
    for s in 0..d.stations {
        // Breadth-first search from the station.
        let mut want = std::vec![INF; cells];
        let home = m.station[s] as usize;
        want[home] = 0;
        let mut queue = VecDeque::from([home]);
        while let Some(c0) = queue.pop_front() {
            let (x, z) = (c0 % d.width, c0 / d.width);
            let mut near = Vec::new();
            if x + 1 < d.width { near.push(c0 + 1) }
            if x > 0 { near.push(c0 - 1) }
            if z + 1 < d.depth { near.push(c0 + d.width) }
            if z > 0 { near.push(c0 - d.width) }
            for n in near {
                if m.walls[n] == 0 && want[n] == INF {
                    want[n] = want[c0] + 1;
                    queue.push_back(n);
                }
            }
        }
        assert_eq!(&m.field[s * cells..(s + 1) * cells], &want[..], "station {s}");
    }
}

#[test]
fn the_layout_is_exactly_what_the_matrix_allocates() {
    let c = sample();
    let d = &c.dims;
    let m = matrix::new(d);
    let sizes = [
        ("px", m.px.capacity() * 4),
        ("pz", m.pz.capacity() * 4),
        ("alive", m.alive.capacity() * 4),
        ("weights", m.weights.capacity() * 4),
        ("memory", m.memory.capacity() * 4),
        ("field", m.field.capacity() * 4),
        ("station", m.station.capacity() * 4),
    ];
    let layout = config::layout(d);
    for (name, bytes) in sizes {
        let a = layout.iter().find(|a| a.name == name).unwrap();
        assert_eq!(a.elems * a.elem_bytes, bytes, "{name}");
    }
}

#[test]
fn a_sentry_or_a_courier_never_asks_for_more_than_its_role() {
    // Left alone (nothing asked on their behalf), no declared role ever loses its pointer.
    let c = sample();
    let d = &c.dims;
    let mut m = spawned(&c);
    let live = m.alive.iter().filter(|&&a| a == 1).count();
    for t in 0..2000 {
        let tally = tick(d, &mut m, t);
        assert_eq!(tally.dropped, 0, "tick {t}");
    }
    assert_eq!(m.alive.iter().filter(|&&a| a == 1).count(), live);
    let _ = (CAP_MOVE, CAP_SPAWN, ROGUE_TICK, kernels::FATE_DOCKED);
}

/// A configuration that differs only in its dims still validates the same rules (used by the kernels' fuzz below).
fn small(c: &Config) -> Dims {
    let mut d = c.dims;
    d.capacity = 256;
    d.width = 32;
    d.depth = 32;
    d.stations = 4;
    d.block_words = 8;
    d
}

#[test]
fn the_kernels_hold_on_a_small_world_under_random_requests_and_pokes() {
    let c = sample();
    let d = small(&c);
    let mut m = matrix::new(&d);
    matrix::lay_out_world(&d, &mut m);
    matrix::route(&d, &mut m);
    matrix::spawn(&d, &[200, 55, 1], &[15, 9, 11], &mut m);
    for t in 0..2000u32 {
        let i = (mix32(t) as usize) % d.capacity;
        match mix32(t ^ 77) % 6 {
            0 => m.req[i] = mix32(t ^ 5),
            1 => m.run[i] = u32::MAX,
            2 => m.weights[i * d.stations] = i32::MIN,
            3 => m.clock[i] = u32::MAX,
            4 => m.goal[i] = u32::MAX,
            _ => {}
        }
        tick(&d, &mut m, t);
        for k in 0..d.capacity {
            assert!(m.alive[k] <= 1 && m.doomed[k] <= 1);
            assert!(m.alive[k] == 0 || m.doomed[k] == 0, "a live slot is never also doomed");
        }
    }
}

/// Masks hold 0 or 1, but nothing breaks if a word holds anything else: the kernel reads bit 0 (no product can
/// overflow), and a declared privilege is never rewritten by a partial wipe (the review's `doomed = 2`).
#[test]
fn a_corrupt_mask_never_panics_the_kernel_or_rewrites_a_declared_privilege() {
    let c = sample();
    let d = &c.dims;
    let mut m = spawned(&c);
    let before = (m.caps.clone(), m.role.clone());
    for i in 0..d.capacity {
        let h = mix32(i as u32);
        m.alive[i] = [0, 1, 2, 3, u32::MAX, 0x8000_0000][(h % 6) as usize];
        m.doomed[i] = [0, 1, 2, u32::MAX - 1][((h >> 8) % 4) as usize];
        m.clock[i] = h;
    }
    for t in 0..20 {
        tick(d, &mut m, t);
    }
    for i in 0..d.capacity {
        let zeroed = row_is_zero(d, &m, i);
        assert!(zeroed || (m.caps[i], m.role[i]) == (before.0[i], before.1[i]), "slot {i}: caps or role rewritten");
        assert!(m.alive[i] <= 1 && m.doomed[i] <= 1, "slot {i}: a mask left outside 0 and 1");
    }
}

#[test]
fn the_validator_keeps_the_terminals_dictionary_large_enough() {
    let small = SAMPLE.replace("cells = 16384;", "cells = 1024;");
    let err = config::validate(&config::parse(&small).unwrap()).unwrap_err();
    assert!(err.contains("terminal.cells must be between 2048"), "{err}");
    let least = SAMPLE.replace("cells = 16384;", "cells = 2048;");
    assert!(config::validate(&config::parse(&least).unwrap()).is_ok());
}

/// containment.canonical is the configuration's canonical form, byte for byte: the ledger door's tests (TypeScript)
/// read it and check it against containment.lock, so it must never drift from what the build hashes.
#[test]
fn the_committed_canonical_form_is_the_configurations() {
    let c = sample();
    assert_eq!(
        include_str!("../../../containment.canonical"),
        config::canonical(&c),
        "regenerate it: cargo run -q -- canonical > containment.canonical"
    );
}
