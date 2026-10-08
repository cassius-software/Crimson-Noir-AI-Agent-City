// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the determinism and memory proof of the core through its public API (the Phase 16
//! audit): the self-test's scripted run, run twice in one process (once whole, once tick by tick), must leave two
//! matrices that are bit-identical in every array, the relaxation's scratch buffer included, with the same proof;
//! the fingerprint `generate` emits for the build (the `GOLDEN` and `GOLDEN_PROOF` tables src/main.rs holds the
//! booted system to) must be the one a fresh run computes, field for field, and, for the lock this repository pins,
//! the one the hosted runtime printed and README.md documents; `system::allocate` must make exactly the declared
//! allocations and exactly the declared bytes (counted as the image's sealed arena counts them, each rounded up to
//! ALLOC_ALIGN); and nothing on the hot path may allocate: not a tick of the kernels, not a step of the scripted
//! run, not the fingerprint, not a line of the terminal (the Rule 110 program the crate's own tests run, then
//! hundreds of seeded random lines over its vocabulary) with its frame and its render. A counting global allocator
//! sees every allocation this thread makes, so "nothing" is a number, not a reading of the source.
//! What breaks if it is removed? A hidden allocation on the hot path would fault the first time the image's sealed
//! allocator refused it, and a drift in the scripted run between two runs, or between the build and the runtime,
//! would be caught only by a boot.

use std::alloc::{GlobalAlloc, Layout, System as Sys};
use std::cell::Cell;

use noir_core::config::{self, ALLOC_ALIGN, Config, LAYOUT_LEN, canonical, declared_bytes, digest_hex, locked_digest, parse, validate};
use noir_core::hash::mix32;
use noir_core::kernels::tick;
use noir_core::matrix::{self, GOLDEN_TICKS, Matrix, Proof, fingerprint, golden, golden_begin, golden_step};
use noir_core::system::{self, Locked, System};
use noir_core::term::{self, Term};

const SAMPLE: &str = include_str!("../../../containment.nix");
const LOCK: &str = include_str!("../../../containment.lock");
/// The lock this repository pins (generation 0), and the scripted run's fingerprint the hosted runtime printed for it
/// (`crimson_noir_os selftest`, twice, 2026-10-07: `fingerprint 0x83765bab`), as README.md documents. A configuration
/// change moves the lock and this guard steps aside; a kernel change under the same lock does not get to.
const PINNED_LOCK: &str = "96c3d1d3a733cf6d31c6afe0531cd9a72f734a7b63d72cfebc5737b6025d261b";
const PINNED_FINGERPRINT: u32 = 0x8376_5bab;
const COLS: usize = config::TERM_COLS;

// ---------------------------------------------------------------------------------------------------------------
// A counting allocator: every allocation this thread makes, and its bytes as the image's arena would carve them.

struct Counting;

thread_local! {
    static CALLS: Cell<usize> = const { Cell::new(0) };
    static BYTES: Cell<usize> = const { Cell::new(0) };
}

fn noted(size: usize) {
    CALLS.with(|c| c.set(c.get() + 1));
    BYTES.with(|b| b.set(b.get() + size.div_ceil(ALLOC_ALIGN) * ALLOC_ALIGN));
}

// SAFETY: every call is forwarded to the system allocator unchanged; the bookkeeping is two thread-local integers,
// which never allocate.
unsafe impl GlobalAlloc for Counting {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        noted(l.size());
        unsafe { Sys.alloc(l) }
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        noted(l.size());
        unsafe { Sys.alloc_zeroed(l) }
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, size: usize) -> *mut u8 {
        noted(size);
        unsafe { Sys.realloc(p, l, size) }
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        unsafe { Sys.dealloc(p, l) }
    }
}

#[global_allocator]
static COUNTING: Counting = Counting;

/// Allocations this thread has made so far.
fn allocations() -> usize {
    CALLS.with(Cell::get)
}

/// Bytes this thread has allocated so far, each allocation rounded up to ALLOC_ALIGN (src/host.rs `allocated`).
fn allocated() -> usize {
    BYTES.with(Cell::get)
}

// ---------------------------------------------------------------------------------------------------------------
// The configurations, the locked tables, and a bit-exact view of a matrix.

fn config(edits: &[(&str, &str)]) -> Config {
    let mut src = String::from(SAMPLE);
    for (from, to) in edits {
        assert!(src.contains(from), "the sample holds {from:?}");
        src = src.replacen(from, to, 1);
    }
    validate(&parse(&src).unwrap_or_else(|e| panic!("{e}"))).unwrap_or_else(|e| panic!("{e}"))
}

/// The shipped configuration, and the smallest the validator accepts (every allocation at its least, some below one
/// ALLOC_ALIGN, so the rounding the arena does is exercised).
fn configs() -> Vec<Config> {
    vec![
        config(&[]),
        config(&[
            ("capacity = 4096;", "capacity = 64;"),
            ("blockWords = 64;", "blockWords = 8;"),
            ("width = 64;", "width = 32;"),
            ("depth = 64;", "depth = 32;"),
            ("stations = 8;", "stations = 2;"),
            ("count = 3072;", "count = 40;"),
            ("count = 1023;", "count = 23;"),
            ("cells = 16384;", "cells = 2048;"),
            ("stack = 256;", "stack = 16;"),
            ("stepBudget = 5000000;", "stepBudget = 1000;"),
            ("lines = 256;", "lines = 16;"),
        ]),
    ]
}

fn roles(c: &Config) -> (Vec<u32>, Vec<u32>) {
    (c.roles.iter().map(|r| r.count).collect(), c.roles.iter().map(|r| r.caps).collect())
}

/// The locked tables of a configuration with the scripted run's proof, as the build emits them (term_fuzz.rs `boot`).
fn locked(c: &Config, golden: Proof) -> Locked {
    let names: Vec<&'static str> = c.roles.iter().map(|r| &*Box::leak(r.name.clone().into_boxed_str())).collect();
    let (counts, caps) = roles(c);
    let canon = canonical(c);
    let digest = digest_hex(&canon);
    Locked {
        name: Box::leak(c.name.clone().into_boxed_str()),
        version: Box::leak(c.version.clone().into_boxed_str()),
        digest: Box::leak(digest.into_boxed_str()),
        canonical: Box::leak(canon.into_boxed_str()),
        role_names: Box::leak(names.into_boxed_slice()),
        role_counts: Box::leak(counts.into_boxed_slice()),
        role_caps: Box::leak(caps.into_boxed_slice()),
        golden,
    }
}

/// Every array of the matrix as words, in a fixed order: the positions by their bits, the weights reinterpreted.
fn words(m: &Matrix) -> Vec<(&'static str, Vec<u32>)> {
    let mut out: Vec<(&'static str, Vec<u32>)> = vec![
        ("px", m.px.iter().map(|f| f.to_bits()).collect()),
        ("pz", m.pz.iter().map(|f| f.to_bits()).collect()),
    ];
    for (name, a) in [
        ("alive", &m.alive),
        ("doomed", &m.doomed),
        ("caps", &m.caps),
        ("req", &m.req),
        ("role", &m.role),
        ("goal", &m.goal),
        ("run", &m.run),
        ("last", &m.last),
        ("trips", &m.trips),
        ("clock", &m.clock),
        ("heading", &m.heading),
        ("fate", &m.fate),
        ("memory", &m.memory),
        ("walls", &m.walls),
        ("field", &m.field),
        ("scratch", &m.scratch),
        ("station", &m.station),
    ] {
        out.push((name, a.clone()));
    }
    out.push(("weights", m.weights.iter().map(|&w| w as u32).collect()));
    out
}

/// The first word that differs between two matrices, named, or None when they are bit-identical throughout.
fn first_difference(a: &Matrix, b: &Matrix) -> Option<String> {
    for ((name, x), (_, y)) in words(a).iter().zip(words(b).iter()) {
        if x.len() != y.len() {
            return Some(format!("{name}: {} words against {}", x.len(), y.len()));
        }
        if let Some(k) = (0..x.len()).find(|&k| x[k] != y[k]) {
            return Some(format!("{name}[{k}]: {:#010x} against {:#010x}", x[k], y[k]));
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------

#[test]
fn the_scripted_run_is_bit_identical_twice_in_one_process_whole_and_tick_by_tick() {
    for c in configs() {
        let d = &c.dims;
        let (counts, caps) = roles(&c);
        let mut whole = matrix::new(d);
        let p = golden(d, &counts, &caps, &mut whole);
        assert_eq!(p.tick, GOLDEN_TICKS);
        assert_eq!(p.fingerprint, fingerprint(&whole), "the proof's fingerprint is the matrix's");
        // The same run again, whole: every word the same.
        let mut again = matrix::new(d);
        let q = golden(d, &counts, &caps, &mut again);
        assert_eq!(q, p, "the proof of the second run");
        assert_eq!(first_difference(&whole, &again), None, "the matrix of the second run");
        // And once more, one tick at a time, checked against the whole run at the end and never allocating.
        let mut stepped = matrix::new(d);
        let mut r = golden_begin(d, &counts, &caps, &mut stepped);
        let before = allocations();
        let mut ticks = 0;
        while golden_step(d, &mut stepped, &mut r) {
            ticks += 1;
        }
        assert_eq!(allocations(), before, "golden_step allocated");
        assert_eq!(ticks, GOLDEN_TICKS);
        assert_eq!(r, p, "the proof of the stepped run");
        assert_eq!(first_difference(&whole, &stepped), None, "the matrix of the stepped run");
    }
}

/// Reads one `name: value` field out of the emitted GOLDEN_PROOF line (on a word boundary: `dropped` is not the
/// tail of `rogue_dropped`).
fn field<'a>(line: &'a str, name: &str) -> &'a str {
    let key = format!(" {name}: ");
    let at = line.find(&key).unwrap_or_else(|| panic!("{name} in {line}")) + key.len();
    let rest = &line[at..];
    let end = rest.find([',', ' ', '}']).unwrap_or(rest.len());
    &rest[..end]
}

fn number(s: &str) -> u32 {
    s.strip_prefix("0x").map_or_else(|| s.parse().unwrap_or_else(|e| panic!("{s}: {e}")), |h| u32::from_str_radix(h, 16).unwrap_or_else(|e| panic!("{s}: {e}")))
}

#[test]
fn the_fingerprint_the_build_pins_is_the_one_a_fresh_run_computes() {
    // The lock pins the shipped configuration's canonical form (config::load refuses anything else).
    let c = config(&[]);
    let digest = digest_hex(&canonical(&c));
    assert_eq!(locked_digest(LOCK), Some(digest.as_str()), "containment.lock pins containment.nix");
    // What the build emits: the tables src/main.rs compiles in and holds the self-test to (`p != locked::GOLDEN_PROOF`).
    let src = noir_core::generate(SAMPLE, LOCK).unwrap_or_else(|e| panic!("{e}"));
    let golden_line = src.lines().find(|l| l.starts_with("pub const GOLDEN: u32 = ")).unwrap_or_else(|| panic!("GOLDEN in {src}"));
    let built = number(golden_line.trim_start_matches("pub const GOLDEN: u32 = ").trim_end_matches(';'));
    let proof_line = src.lines().find(|l| l.starts_with("pub const GOLDEN_PROOF: ")).unwrap_or_else(|| panic!("GOLDEN_PROOF in {src}"));
    // A fresh run in this process, as the runtime's selftest makes it.
    let d = &c.dims;
    let (counts, caps) = roles(&c);
    let mut m = matrix::new(d);
    let p = golden(d, &counts, &caps, &mut m);
    assert_eq!(p.fingerprint, built, "GOLDEN");
    assert_eq!(number(field(proof_line, "fingerprint")), p.fingerprint, "GOLDEN_PROOF.fingerprint");
    assert_eq!(number(field(proof_line, "tick")), p.tick);
    assert_eq!(number(field(proof_line, "rogue")), p.rogue);
    assert_eq!(field(proof_line, "rogue_dropped"), format!("{}", p.rogue_dropped));
    assert_eq!(field(proof_line, "rogue_reaped"), format!("{}", p.rogue_reaped));
    assert_eq!(number(field(proof_line, "looper")), p.looper);
    assert_eq!(number(field(proof_line, "trap_cell")), p.trap_cell);
    assert_eq!(number(field(proof_line, "trapped_at")), p.trapped_at);
    assert_eq!(number(field(proof_line, "looper_flushed_at")), p.looper_flushed_at);
    assert_eq!(number(field(proof_line, "dropped")), p.totals.dropped);
    assert_eq!(number(field(proof_line, "flushed")), p.totals.flushed);
    assert_eq!(number(field(proof_line, "reaped")), p.totals.reaped);
    assert_eq!(number(field(proof_line, "docked")), p.totals.docked);
    assert!(p.rogue_dropped && p.rogue_reaped && p.looper_flushed_at != u32::MAX, "{p:?}");
    // The same run on this machine, twice more, so the build's value is not a one-off of this process either.
    for _ in 0..2 {
        let mut again = matrix::new(d);
        assert_eq!(golden(d, &counts, &caps, &mut again), p);
    }
    // For the lock this repository pins, the fingerprint the hosted runtime printed (README.md).
    if digest == PINNED_LOCK {
        assert_eq!(p.fingerprint, PINNED_FINGERPRINT, "the scripted run's fingerprint under lock {PINNED_LOCK}: {p:?}");
    }
}

#[test]
fn allocate_makes_exactly_the_declared_allocations_and_the_declared_bytes() {
    for c in configs() {
        let d = &c.dims;
        let layout = config::layout(d);
        let (calls0, bytes0) = (allocations(), allocated());
        let sys = system::allocate(d);
        let (calls, bytes) = (allocations() - calls0, allocated() - bytes0);
        assert_eq!(bytes, declared_bytes(d), "{}: bytes allocated against the layout's", c.name);
        assert_eq!(calls, LAYOUT_LEN, "{}: one allocation per declared array, nothing else", c.name);
        assert!(declared_bytes(d) <= d.arena_bytes, "{}: the declaration fits the arena", c.name);
        // Each array's capacity is its declared size: nothing was grown and nothing is spare.
        let m = &sys.m;
        let b = &sys.b;
        let sizes: [(&str, usize); LAYOUT_LEN] = [
            ("px", m.px.capacity() * 4),
            ("pz", m.pz.capacity() * 4),
            ("alive", m.alive.capacity() * 4),
            ("doomed", m.doomed.capacity() * 4),
            ("caps", m.caps.capacity() * 4),
            ("req", m.req.capacity() * 4),
            ("role", m.role.capacity() * 4),
            ("goal", m.goal.capacity() * 4),
            ("run", m.run.capacity() * 4),
            ("last", m.last.capacity() * 4),
            ("trips", m.trips.capacity() * 4),
            ("clock", m.clock.capacity() * 4),
            ("heading", m.heading.capacity() * 4),
            ("fate", m.fate.capacity() * 4),
            ("weights", m.weights.capacity() * 4),
            ("memory", m.memory.capacity() * 4),
            ("walls", m.walls.capacity() * 4),
            ("field", m.field.capacity() * 4),
            ("scratch", m.scratch.capacity() * 4),
            ("station", m.station.capacity() * 4),
            ("color", b.color.capacity() * 4),
            ("zbuf", b.zbuf.capacity() * 4),
            ("tri_x", b.tri_x.capacity() * 4),
            ("tri_y", b.tri_y.capacity() * 4),
            ("tri_z", b.tri_z.capacity() * 4),
            ("tri_rgb", b.tri_rgb.capacity() * 4),
            ("term_dict", b.term_dict.capacity() * 4),
            ("term_stack", b.term_stack.capacity() * 4),
            ("term_rstack", b.term_rstack.capacity() * 4),
            ("term_text", b.term_text.capacity()),
            ("term_line", b.term_line.capacity()),
        ];
        for (name, size) in sizes {
            let a = layout.iter().find(|a| a.name == name).unwrap_or_else(|| panic!("{name} in the layout"));
            assert_eq!(size, a.elems * a.elem_bytes, "{}: {name}", c.name);
        }
    }
}

#[test]
fn a_tick_of_the_kernels_the_scripted_run_and_the_fingerprint_allocate_nothing() {
    for c in configs() {
        let d = &c.dims;
        let (counts, caps) = roles(&c);
        let mut sys = system::allocate(d);
        let mut p = golden_begin(d, &counts, &caps, &mut sys.m);
        let before = allocations();
        // The kernels straight, as the terminal's `tick` runs them.
        for t in 0..300u32 {
            let tally = tick(d, &mut sys.m, t);
            std::hint::black_box(tally);
        }
        assert_eq!(allocations(), before, "{}: a tick allocated", c.name);
        // The scripted run's remaining ticks, with the trap and the rogue's request along the way.
        while golden_step(d, &mut sys.m, &mut p) {}
        assert_eq!(allocations(), before, "{}: a step of the scripted run allocated", c.name);
        std::hint::black_box(fingerprint(&sys.m));
        assert_eq!(allocations(), before, "{}: the fingerprint allocated", c.name);
    }
}

/// The scrollback's rows written so far, trailing spaces trimmed, joined by '|'.
fn screen(t: &Term, sys: &System) -> String {
    let rows = t.lines.min(sys.b.term_text.len() / COLS);
    (0..rows).map(|k| String::from_utf8_lossy(&sys.b.term_text[k * COLS..(k + 1) * COLS]).trim_end().to_string()).collect::<Vec<_>>().join("|")
}

/// Runs a line on a cleared screen; what the screen then shows.
fn say(t: &mut Term, sys: &mut System, lk: &Locked, line: &str) -> String {
    t.lines = 0;
    t.col = 0;
    t.pending = false;
    term::run_line(t, sys, lk, line);
    screen(t, sys)
}

#[test]
fn a_terminal_line_its_frame_and_its_render_allocate_nothing() {
    let c = config(&[]);
    let d = c.dims;
    let (counts, caps) = roles(&c);
    let mut proof = matrix::new(&d);
    let lk = locked(&c, golden(&d, &counts, &caps, &mut proof));
    let mut sys = system::allocate(&d);
    golden_begin(&d, lk.role_counts, lk.role_caps, &mut sys.m);
    let mut t = term::open(&mut sys, &d, &lk);
    // The Rule 110 program the crate's own tests run (term.rs `it_runs_rule_110`), then its generations.
    let program = [
        "create cells 64 allot create next 64 allot",
        ": cell@ 63 and cells + @ ;",
        ": rule swap 2* or swap 4 * or 110 swap rshift 1 and ;",
        ": step1 64 0 do i 1- cell@ i cell@ i 1+ cell@ rule next i + ! loop ;",
        ": step2 64 0 do next i + @ cells i + ! loop ;",
        ": show 64 0 do i cell@ if '#' else '.' then emit loop cr ;",
        ": gens 0 do show step1 step2 loop ;",
        "1 cells 63 + !",
    ];
    for line in program {
        let shown = say(&mut t, &mut sys, &lk, line);
        assert!(shown.ends_with(" ok") || shown.ends_with(" compiled"), "{line}: {shown}");
    }
    t.lines = 0;
    t.col = 0;
    t.pending = false;
    let before = allocations();
    term::run_line(&mut t, &mut sys, &lk, "24 gens");
    assert_eq!(allocations(), before, "the program allocated");
    assert_eq!(t.lines, 26, "24 generations shown, the echo and the ok");
    // Hundreds of seeded random lines over the vocabulary (term.rs `random_programs_never_crash_or_allocate`), each
    // followed by a frame as the image draws one; errors are messages, never allocations.
    let vocab = [
        "1", "0", "-1", "7", "300", "65535", "-99999", "dup", "drop", "swap", "over", "rot", "pick", "+", "-", "*", "/", "mod",
        "/mod", "*/", "and", "or", "invert", "lshift", "rshift", "=", "<", "0=", "@", "!", "+!", ",", "here", "allot", ">r",
        "r>", "r@", "i", "j", "unloop", ".", ".s", "emit", "cr", "spaces", "hex", "decimal", "if", "else", "then", "begin",
        "until", "again", "while", "repeat", "do", "?do", "loop", "+loop", "leave", "exit", "recurse", ":", ";", "foo",
        "variable", "constant", "create", "px", "alive", "walls", "station", "memory", "caps", "@a", "!a", "#a", "count-a",
        "ask", "cell", "xz", "agent", "mark", "map", ".\"", "(", "\\", "words", "page", "cold", "stats", "params", "locked",
        "go", "stop", "1 tick", "help", "digest",
    ];
    let input = COLS - 2;
    let mut seed = 0x5eed_u32;
    let mut line = String::with_capacity(input + 16);
    let before = allocations();
    for n in 0..400 {
        line.clear();
        let words = 1 + mix32(seed) % 12;
        for _ in 0..words {
            seed = mix32(seed.wrapping_add(0x9e37_79b9));
            let w = vocab[seed as usize % vocab.len()];
            if line.len() + w.len() + 1 >= input {
                break;
            }
            line.push_str(w);
            line.push(' ');
        }
        let a0 = allocations();
        term::run_line(&mut t, &mut sys, &lk, &line);
        term::frame(&mut t, &mut sys, 20 * n as u64);
        assert_eq!(allocations(), a0, "line {n} (seed {seed:#x}) allocated: {line}");
        assert!(t.sp <= sys.b.term_stack.len() && t.rp <= sys.b.term_rstack.len(), "line {n}: a stack past its depth");
    }
    term::render(&t, &mut sys, &lk);
    assert_eq!(allocations(), before, "the terminal allocated");
}
