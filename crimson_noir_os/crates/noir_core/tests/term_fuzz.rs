// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the adversarial property suite for the Crimson Terminal through its public API
//! (open, run_line, key, frame, render), driven by a seeded splitmix64 so every failing line names the seed that
//! replays it. Thousands of random lines over the whole dictionary (every built-in word, every compiling word,
//! numbers at the edges of every base, strings and comments left open, names too long, tokens that are not words,
//! lines longer than the input) run on the shipped configuration and on the smallest the validator accepts (a
//! 2,048-cell dictionary, a 16-deep stack, a 1,000-step budget, 16 scrollback lines), and after every one the
//! terminal is still inside its declared memory: the stacks within their depths, `here` below the line's code area,
//! the scrollback within its lines, the kernel knobs within the validator's ranges, the 1/0 masks still 1/0, the
//! step counter within one charge of the budget. The classic faults (division by zero, underflow, overflow, unknown
//! words, unbalanced control words, a full dictionary) are messages that leave the stacks empty; `flush` refuses
//! every index outside the pool and zeroes exactly one block inside it; and the step budget ends every runaway
//! line. One test is a regression for a Phase 16 audit finding (named in its comment) and fails until term.rs
//! charges the words that do the pool's or the dictionary's worth of work for one step.
//! What breaks if it is removed? The terminal's bounds are checked by a handful of typed lines and one random run
//! on the shipped configuration only.

use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

use noir_core::config::{Config, Dims, canonical, digest_hex, parse, validate};
use noir_core::matrix::{self, GOLDEN_TICKS, Matrix, row_is_zero};
use noir_core::system::{self, KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_LEFT, KEY_PAGE_DOWN, KEY_PAGE_UP, KEY_RIGHT, KEY_UP, Locked, System};
use noir_core::term::{self, Request, Term};

const SAMPLE: &str = include_str!("../../../containment.nix");
const COLS: usize = 80;
/// The longest line the terminal takes (term.rs INPUT).
const INPUT: usize = COLS - 2;
/// The line's code area at the top of the dictionary (term.rs SCRATCH).
const SCRATCH: usize = 1024;

// ---------------------------------------------------------------------------------------------------------------
// A seeded PRNG (splitmix64).

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

    fn below(&mut self, n: usize) -> usize {
        (self.next() % n.max(1) as u64) as usize
    }

    fn pick<T: Copy>(&mut self, xs: &[T]) -> T {
        xs[self.below(xs.len())]
    }

    fn one_in(&mut self, k: usize) -> bool {
        self.below(k) == 0
    }
}

// ---------------------------------------------------------------------------------------------------------------
// A system with its terminal open, as the platforms build one from their locked tables.

fn config(edits: &[(&str, &str)]) -> Config {
    let mut src = String::from(SAMPLE);
    for (from, to) in edits {
        assert!(src.contains(from), "the sample holds {from:?}");
        src = src.replacen(from, to, 1);
    }
    validate(&parse(&src).unwrap_or_else(|e| panic!("{e}"))).unwrap_or_else(|e| panic!("{e}"))
}

fn shipped() -> Config {
    config(&[])
}

/// The smallest system the validator accepts: a 64-slot pool on a 32-cell floor with two stations, a 2,048-cell
/// dictionary, a 16-deep stack, a 1,000-step budget and 16 lines of scrollback.
fn smallest() -> Config {
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
    ])
}

/// The locked tables of a configuration, with the scripted run's proof, and the system allocated for it after the
/// run (the state the terminal opens in).
fn boot(c: &Config) -> (Dims, Locked, System) {
    let d = c.dims;
    let names: Vec<&'static str> = c.roles.iter().map(|r| &*Box::leak(r.name.clone().into_boxed_str())).collect();
    let counts: Vec<u32> = c.roles.iter().map(|r| r.count).collect();
    let caps: Vec<u32> = c.roles.iter().map(|r| r.caps).collect();
    let mut sys = system::allocate(&d);
    let golden = matrix::golden(&d, &counts, &caps, &mut sys.m);
    let canon = canonical(c);
    let digest = digest_hex(&canon);
    let lk = Locked {
        name: Box::leak(c.name.clone().into_boxed_str()),
        version: Box::leak(c.version.clone().into_boxed_str()),
        digest: Box::leak(digest.into_boxed_str()),
        canonical: Box::leak(canon.into_boxed_str()),
        role_names: Box::leak(names.into_boxed_slice()),
        role_counts: Box::leak(counts.into_boxed_slice()),
        role_caps: Box::leak(caps.into_boxed_slice()),
        golden,
    };
    (d, lk, sys)
}

fn opened(c: &Config) -> (Term, System, Locked, Dims) {
    let (d, lk, mut sys) = boot(c);
    let t = term::open(&mut sys, &d, &lk);
    (t, sys, lk, d)
}

/// The scrollback as lines, trailing spaces trimmed.
fn screen(t: &Term, sys: &System) -> Vec<String> {
    (0..t.lines).map(|k| String::from_utf8_lossy(&sys.b.term_text[k * COLS..(k + 1) * COLS]).trim_end().to_string()).collect()
}

/// Runs a line on a cleared screen and returns what it printed after the echo, lines joined by '|'.
fn say(t: &mut Term, sys: &mut System, lk: &Locked, line: &str) -> String {
    t.lines = 0;
    t.col = 0;
    t.pending = false;
    term::run_line(t, sys, lk, line);
    let s = screen(t, sys);
    if t.lines < sys.b.term_text.len() / COLS {
        assert!(s[0].starts_with("> "), "the echo of {line:?}: {:?}", s[0]);
    }
    s[1..].join("|")
}

/// Every bound the terminal must be inside after any line, or the first it is outside.
fn inside(t: &Term, sys: &System, d: &Dims) -> Result<(), String> {
    let b = &sys.b;
    let m = &sys.m;
    let limit = b.term_dict.len() - SCRATCH;
    let checks: [(&str, bool); 18] = [
        ("sp within the data stack", t.sp <= b.term_stack.len()),
        ("rp within the return stack", t.rp <= b.term_rstack.len()),
        ("here below the line's code area", t.here <= limit),
        ("here above the reserved cells", t.here >= 8),
        ("latest below here or none", t.latest == 0 || (t.latest >= 8 && t.latest < t.here)),
        ("lines within the scrollback", t.lines <= d.term_lines),
        ("the column within a line", t.col <= COLS),
        ("the input within the line", t.input <= INPUT),
        ("the recall within the history", t.recall <= 3),
        ("the base decimal or hex", t.base == 10 || t.base == 16),
        ("the steps within one charge of the budget", t.steps <= d.term_steps as u64 + GOLDEN_TICKS as u64 * d.capacity as u64),
        ("loop-limit in the validator's range", (2..=1_000_000).contains(&t.dims.loop_limit)),
        ("step in the validator's range", (1..=8).contains(&t.dims.step_eighths)),
        ("learn-shift in the validator's range", (1..=15).contains(&t.dims.learn_shift)),
        ("explore in the validator's range", t.dims.explore <= 65536),
        (
            "the sizes untouched by the knobs",
            (t.dims.capacity, t.dims.block_words, t.dims.stations, t.dims.width, t.dims.depth, t.dims.term_cells, t.dims.term_stack, t.dims.term_steps, t.dims.term_lines)
                == (d.capacity, d.block_words, d.stations, d.width, d.depth, d.term_cells, d.term_stack, d.term_steps, d.term_lines),
        ),
        ("alive, doomed and walls still 1/0 masks", m.alive.iter().chain(&m.doomed).chain(&m.walls).all(|&w| w <= 1)),
        ("every station on the floor", m.station.iter().all(|&s| (s as usize) < d.width * d.depth)),
    ];
    checks.iter().find(|(_, ok)| !ok).map_or(Ok(()), |(what, _)| Err(what.to_string()))
}

fn copy(d: &Dims, m: &Matrix) -> Matrix {
    let mut c = matrix::new(d);
    c.px.copy_from_slice(&m.px);
    c.pz.copy_from_slice(&m.pz);
    c.weights.copy_from_slice(&m.weights);
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
    c
}

/// Every (array, index) whose bits differ.
fn diff(a: &Matrix, b: &Matrix) -> Vec<(&'static str, usize)> {
    let mut out = Vec::new();
    let mut words = |name: &'static str, x: &[u32], y: &[u32]| {
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

// ---------------------------------------------------------------------------------------------------------------
// The dictionary, as typed

/// Every built-in word of term.rs that can be typed (the compiler's words included).
const WORDS: &[&str] = &[
    "dup", "drop", "swap", "over", "rot", "-rot", "nip", "tuck", "pick", "2dup", "2drop", "2swap", "?dup", "depth", "clear",
    "+", "-", "*", "/", "mod", "/mod", "*/", "negate", "abs", "min", "max", "1+", "1-", "2*", "2/", "and", "or", "xor",
    "invert", "lshift", "rshift", "=", "<>", "<", ">", "<=", ">=", "0=", "0<>", "0<", "0>", "u<", "true", "false", "@",
    "!", "+!", ",", "here", "allot", ">r", "r>", "r@", "i", "j", "unloop", ".", "u.", ".s", "emit", "cr", "space",
    "spaces", "hex", "decimal", "px", "pz", "alive", "doomed", "caps", "req", "role", "goal", "run", "last", "trips",
    "clock", "heading", "fate", "weights", "memory", "walls", "field", "station", "@a", "!a", "#a", "fill-a", "count-a",
    "cap-move", "cap-route", "cap-learn", "cap-memory", "cap-spawn", "ask", "cell", "xz", "tick", "ticks", "go", "stop",
    "stats", "agent", "flush", "respawn", "world", "route", "golden", "map", "mark", "cfg", "digest", "roles", "params",
    "loop-limit!", "step!", "learn!", "explore!", "locked", "words", "help", "page", "cold", "tutorial", "reboot", "halt",
    ":", ";", "variable", "constant", "create", "if", "else", "then", "begin", "until", "again", "while", "repeat", "do",
    "?do", "loop", "+loop", "leave", "recurse", "exit", ".\"", "(", "\\",
];

/// Numbers at the edges of every base and every width, and things that look like numbers.
const NUMBERS: &[&str] = &[
    "0", "1", "-1", "2", "3", "7", "8", "15", "16", "63", "64", "255", "256", "1023", "1024", "4095", "4096", "4097", "65535",
    "65536", "2147483647", "-2147483648", "2147483648", "4294967295", "4294967296", "-4294967295", "$ff", "$ffffffff",
    "$7fffffff", "$80000000", "$", "-$1", "%1010", "%", "#99", "#", "'a'", "'", "''", "'ab'", "-", "--1", "1.5", "0x10", "1e3",
    "999999999999999999999999", "-0", "00", "0000000000000000000000000000000000000000000000000000000000000000000001",
];

/// Names, words that are not, and strings and comments left open.
const STRAYS: &[&str] = &[
    "x", "fizz", "sq", "v", "FOO", "Dup", "é", "🦀", "\u{0}", "\u{7f}", "a-b", "a'b", "::", ";;", ".\" hi\"", ".\" unclosed",
    ".\"", "( c )", "( unclosed", "\\ the rest", "aaaaaaaaaaaaaaaaa", "sixteencharsname",
];

fn word(r: &mut Rng) -> String {
    match r.below(10) {
        0..=2 => r.pick(NUMBERS).to_string(),
        3 => r.pick(STRAYS).to_string(),
        4 if r.one_in(4) => "a".repeat(1 + r.below(INPUT)),
        _ => r.pick(WORDS).to_string(),
    }
}

/// A random line: a few words, usually within the input, now and then far longer than it.
fn line(r: &mut Rng) -> String {
    let n = 1 + r.below(14);
    let long = r.one_in(50);
    let mut out = String::new();
    for _ in 0..n {
        let w = word(r);
        if !long && out.len() + w.len() + 1 > INPUT {
            break;
        }
        out.push_str(&w);
        out.push(if r.one_in(20) { '\t' } else { ' ' });
    }
    if long {
        for _ in 0..r.below(2000) {
            out.push_str("1 ");
        }
    }
    out
}

/// Runs `line` without a panic, or names the panic.
fn run(t: &mut Term, sys: &mut System, lk: &Locked, line: &str) -> Result<(), String> {
    catch_unwind(AssertUnwindSafe(|| term::run_line(t, sys, lk, line))).map_err(|p| {
        p.downcast_ref::<String>().cloned().or_else(|| p.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default()
    })
}

fn fuzz(c: &Config, lines: usize, seed: u64) {
    let (mut t, mut sys, lk, d) = opened(c);
    let mut r = Rng::new(seed);
    let keys = [KEY_BACKSPACE, KEY_ENTER, KEY_ESC, KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_PAGE_UP, KEY_PAGE_DOWN, 0, 31, 32, 126, 127, 0x100, 0x107, 0xffff, u32::MAX];
    let mut faults = 0;
    for n in 0..lines {
        let line_seed = r.next();
        let l = line(&mut Rng::new(line_seed));
        let tag = format!("line {n} seed {line_seed:#x}: {l:?}");
        if let Err(p) = run(&mut t, &mut sys, &lk, &l) {
            panic!("{tag}: panicked: {p}");
        }
        if let Err(what) = inside(&t, &sys, &d) {
            panic!("{tag}: {what}");
        }
        assert_eq!(t.scroll, 0, "{tag}: a line leaves the view at the bottom");
        // The line ends with " ok", " compiled" or a fault's message (an `emit` may print a '?' of its own); a long
        // message wraps, so the last two rows are read together.
        let from = t.lines.saturating_sub(2) * COLS;
        let last = String::from_utf8_lossy(&sys.b.term_text[from..t.lines * COLS]).trim_end().to_string();
        if !(last.ends_with(" ok") || last.ends_with(" compiled")) {
            faults += 1;
            assert!(last.contains("? "), "{tag}: ended with neither ok, compiled nor a fault: {last:?}");
            assert!(t.sp == 0 && t.rp == 0, "{tag}: a fault left the stacks ({} {})", t.sp, t.rp);
        }
        // Keys and frames between lines: the input line, the history and the view stay inside their arrays.
        for _ in 0..r.below(6) {
            let k = if r.one_in(3) { r.pick(&keys) } else { 32 + r.below(95) as u32 };
            if let Err(p) = catch_unwind(AssertUnwindSafe(|| term::key(&mut t, &mut sys, &lk, k))) {
                panic!("{tag}: key {k:#x} panicked: {p:?}");
            }
            assert!(t.input <= INPUT && t.recall <= 3 && t.scroll <= t.lines.saturating_sub(1), "{tag}: key {k:#x}");
        }
        term::frame(&mut t, &mut sys, r.next() % 1_000_000);
        if let Err(what) = inside(&t, &sys, &d) {
            panic!("{tag}: after keys and a frame, {what}");
        }
        t.request = Request::None;
    }
    assert!(faults > lines / 10, "only {faults} of {lines} lines faulted: the lines are too tame to mean anything");
    term::render(&t, &mut sys, &lk);
}

/// Thousands of random lines on the smallest system, hundreds on the shipped one: never a panic, every bound held.
#[test]
fn random_lines_over_the_whole_dictionary_never_panic_or_leave_the_declared_memory() {
    fuzz(&smallest(), 6000, 0x7e12_0001);
    fuzz(&shipped(), 400, 0x7e12_0002);
}

/// Division by zero, underflow, overflow, the return stack, bad addresses, unknown words, unbalanced control words,
/// names too long, a full dictionary, out-of-range writes and knobs: each a message, the stacks empty after.
#[test]
fn every_classic_fault_is_a_message_that_leaves_the_stacks_empty() {
    let (mut t, mut sys, lk, _) = opened(&shipped());
    let cases: &[(&str, &str)] = &[
        ("1 0 /", "division by zero"),
        ("1 0 mod", "division by zero"),
        ("1 0 /mod", "division by zero"),
        ("1 2 0 */", "division by zero"),
        ("-2147483648 -1 /", "overflow in /"),
        ("-2147483648 -1 mod", "overflow in mod"),
        ("drop", "stack underflow"),
        ("+", "stack underflow"),
        ("1 +", "stack underflow"),
        ("swap", "stack underflow"),
        ("1 2 3 2swap", "stack underflow"),
        ("5 pick", "stack underflow"),
        ("-1 pick", "stack underflow"),
        ("j", "return stack"),
        ("unloop", "return stack"),
        ("r>", "return stack"),
        ("5 >r", "return stack"),
        ("begin 1 again", "stack overflow"),
        ("300 0 do i loop", "stack overflow"),
        (": down recurse ; down", "return stack"),
        ("-1 @", "address outside"),
        ("16384 @", "address outside"),
        ("2147483647 @", "address outside"),
        ("-2147483648 @", "address outside"),
        ("1 15360 !", "address outside"),
        ("1 -1 +!", "address outside"),
        ("fizz", "fizz: no such word"),
        ("1 2 fizz 3", "fizz: no such word"),
        ("é", "no such word"),
        ("'", "no such word"),
        ("$", "no such word"),
        ("%", "no such word"),
        ("#", "no such word"),
        ("-$", "no such word"),
        ("1.5", "no such word"),
        ("4294967296", "no such word"),
        ("then", "THEN without IF"),
        ("else", "ELSE without IF"),
        ("until", "UNTIL or AGAIN without BEGIN"),
        ("again", "UNTIL or AGAIN without BEGIN"),
        ("while", "WHILE without BEGIN"),
        ("repeat", "REPEAT without WHILE"),
        ("begin while repeat", "stack underflow"),
        ("loop", "LOOP without DO"),
        ("+loop", "LOOP without DO"),
        ("leave", "LEAVE outside a DO loop"),
        ("recurse", "RECURSE outside"),
        (";", "; without a :"),
        (":", ": needs a name"),
        (": a : b ;", "a : inside a definition"),
        (": a variable v ;", "define words outside"),
        ("variable", "it needs a name"),
        ("constant x", "stack underflow"),
        ("1 if", "still open at the end of the line"),
        ("begin", "still open at the end of the line"),
        ("1 0 do", "still open at the end of the line"),
        ("begin : foo again ;", "finish the IF, BEGIN or DO before defining a word"),
        (": waytoolongnameforaword ;", "a name is 1 to 16 characters"),
        ("create big 20000 allot", "the dictionary is full"),
        ("-1 allot", "the dictionary is full"),
        ("2 0 alive !a", "write 0 or 1"),
        ("-1 0 doomed !a", "write 0 or 1"),
        ("2 walls fill-a", "write 0 or 1"),
        ("31 0 caps !a", "read-only"),
        ("0 0 role !a", "read-only"),
        ("4096 0 station !a", "a station is a cell index"),
        ("-1 0 station !a", "a station is a cell index"),
        ("4096 alive @a", "index outside the array"),
        ("-1 px @a", "index outside the array"),
        ("0 -1 px !a", "index outside the array"),
        ("0 19 @a", "no such array"),
        ("0 -1 @a", "no such array"),
        ("64 0 cell", "a cell is x 0..width-1"),
        ("0 -1 cell", "a cell is x 0..width-1"),
        ("4096 xz", "a cell index is 0 to width x depth - 1"),
        ("-1 xz", "a cell index is 0 to width x depth - 1"),
        ("1 loop-limit!", "loop-limit is 2 to 1000000"),
        ("1000001 loop-limit!", "loop-limit is 2 to 1000000"),
        ("0 step!", "step is 1 to 8"),
        ("9 step!", "step is 1 to 8"),
        ("0 learn!", "learn-shift is 1 to 15"),
        ("16 learn!", "learn-shift is 1 to 15"),
        ("-1 explore!", "explore is 0 to 65536"),
        ("65537 explore!", "explore is 0 to 65536"),
        ("-1 ask", "index outside the array"),
        ("4096 flush", "index outside the array"),
        ("-1 agent", "index outside the array"),
        ("begin again", "step budget spent"),
        ("100000 tick", "step budget spent"),
    ];
    for (line, want) in cases {
        let s = say(&mut t, &mut sys, &lk, line);
        assert!(s.contains(want), "{line:?} said {s:?}, not {want:?}");
        assert!(s.contains("? ") || s.ends_with(": no such word"), "{line:?}: not marked as a fault: {s:?}");
        assert_eq!((t.sp, t.rp), (0, 0), "{line:?} left the stacks");
        assert_eq!(say(&mut t, &mut sys, &lk, "depth ."), "0  ok", "after {line:?}");
    }
    // A line longer than the input is cut at it: 39 ones fit, the rest is never read.
    let long = "1 ".repeat(5000);
    assert_eq!(say(&mut t, &mut sys, &lk, &long), " ok");
    assert_eq!(say(&mut t, &mut sys, &lk, "depth . clear"), "39  ok");
    // One token as long as the input, and one number as long: not words, and the echo fits its line.
    let s = say(&mut t, &mut sys, &lk, &"a".repeat(INPUT));
    assert!(s.ends_with(": no such word"), "{s}");
    let s = say(&mut t, &mut sys, &lk, &"9".repeat(INPUT));
    assert!(s.ends_with(": no such word"), "{s}");
    assert_eq!(say(&mut t, &mut sys, &lk, &format!(".\" {}", "x".repeat(INPUT - 3))), format!("{} ok", "x".repeat(INPUT - 3)));
    assert_eq!(say(&mut t, &mut sys, &lk, "( never closed"), " ok");
    assert_eq!(say(&mut t, &mut sys, &lk, "\\ 1 0 /"), " ok");
    assert_eq!(say(&mut t, &mut sys, &lk, "hex ff . decimal"), "ff  ok");
    assert_eq!(say(&mut t, &mut sys, &lk, "$ffffffff . 4294967295 u. -2147483648 negate ."), "-1 4294967295 -2147483648  ok");
    // The smallest system: a 16-deep stack and a 1,000-step budget end what the shipped one would run.
    let (mut t, mut sys, lk, _) = opened(&smallest());
    assert_eq!(say(&mut t, &mut sys, &lk, "17 0 do i loop"), "? stack overflow (the declared depth)");
    assert_eq!(say(&mut t, &mut sys, &lk, "16 0 do i loop clear"), " ok");
    assert_eq!(say(&mut t, &mut sys, &lk, "1000 0 do loop"), "? step budget spent: loop broken (terminal.stepBudget)");
    assert_eq!(say(&mut t, &mut sys, &lk, "create big 1016 allot"), "? the dictionary is full (terminal.cells)");
    // A failed allot leaves its create defined (9 cells), as in any Forth: a cold start and the line's 1,015 cells
    // (a 6-cell header, a 3-cell body, 1,006 allotted) fill the 1,024 below the line's code area exactly.
    say(&mut t, &mut sys, &lk, "cold");
    assert_eq!(say(&mut t, &mut sys, &lk, "create big 1006 allot"), " ok");
    assert_eq!(say(&mut t, &mut sys, &lk, "1 ,"), " ok");
    assert_eq!(say(&mut t, &mut sys, &lk, "1 ,"), "? the dictionary is full (terminal.cells)");
    assert_eq!(say(&mut t, &mut sys, &lk, "golden"), "? step budget spent: loop broken (terminal.stepBudget)");
    assert_eq!(say(&mut t, &mut sys, &lk, "world"), "? step budget spent: loop broken (terminal.stepBudget)");
}

/// `flush` refuses every index outside the pool (the matrix untouched) and, inside it, zeroes that row, its weights
/// and its block and nothing else, whether the swarm runs or not.
#[test]
fn flush_refuses_every_index_outside_the_pool_and_zeroes_one_block_inside() {
    for c in [shipped(), smallest()] {
        let (mut t, mut sys, lk, d) = opened(&c);
        let mut r = Rng::new(0x7e12_0003);
        let cap = d.capacity as i64;
        let outside = [i32::MIN as i64, -(cap + 1), -1, cap, cap + 1, 2 * cap, i32::MAX as i64, u32::MAX as i64];
        for i in outside.into_iter().chain((0..20).map(|_| cap + r.below(i32::MAX as usize - cap as usize) as i64)) {
            let before = copy(&d, &sys.m);
            let s = say(&mut t, &mut sys, &lk, &format!("{i} flush"));
            assert_eq!(s, "? index outside the array", "{i} flush");
            assert_eq!(diff(&before, &sys.m), [], "{i} flush touched the matrix");
        }
        for round in 0..40 {
            let i = match round % 4 {
                0 => 0,
                1 => d.capacity - 1,
                _ => r.below(d.capacity),
            };
            if r.one_in(2) {
                say(&mut t, &mut sys, &lk, "go");
            } else {
                say(&mut t, &mut sys, &lk, "stop");
            }
            let before = copy(&d, &sys.m);
            let s = say(&mut t, &mut sys, &lk, &format!("{i} flush"));
            assert_eq!(s, format!("agent {i} flushed: its row, weights and memory block are zero ok"));
            assert!(row_is_zero(&d, &sys.m, i), "slot {i} is not zero");
            for (name, at) in diff(&before, &sys.m) {
                let own = match name {
                    "weights" => at / d.stations == i,
                    "memory" => at / d.block_words == i,
                    "walls" | "field" | "scratch" | "station" | "fate" => false,
                    _ => at == i,
                };
                assert!(own, "{i} flush changed {name}[{at}]");
            }
            term::frame(&mut t, &mut sys, 1_000 * round as u64 + 1_000);
            assert!(row_is_zero(&d, &sys.m, i) || t.running, "slot {i} after a frame");
        }
    }
}

/// Every runaway line ends with the budget message within one charge of the budget, the machine free again; the
/// scripted run and the lock check fit the shipped budget, and the budget is the locked one however the knobs move.
#[test]
fn the_step_budget_ends_every_runaway_line() {
    let (mut t, mut sys, lk, d) = opened(&shipped());
    let budget = d.term_steps as u64;
    for line in [
        "begin again",
        "begin 1 drop again",
        "0 begin 1+ dup 0= until",
        "begin 0 while repeat begin 1 while repeat",
        "2147483647 0 do loop",
        "2147483647 -2147483648 do loop",
        "0 1 do 0 +loop",
        ": r recurse ; r",
        ": f begin again ; f",
        "variable p : q p @ ; here p ! begin q drop again",
        "1000000 tick",
        "begin respawn again",
        "begin 0 walls fill-a again",
        "begin 1 alive count-a drop again",
        "begin 100 spaces again",
        "begin cfg again",
        "begin digest again",
        "begin route again",
    ] {
        let s = say(&mut t, &mut sys, &lk, line);
        assert!(
            s.ends_with("? step budget spent: loop broken (terminal.stepBudget)") || s.ends_with("? return stack overflow or underflow (too deep, or an unbalanced >r r>)"),
            "{line:?}: {s}"
        );
        assert!(t.steps <= budget + d.capacity.max(d.width * d.depth) as u64, "{line:?} took {} steps", t.steps);
        assert_eq!(say(&mut t, &mut sys, &lk, "1 2 + ."), "3  ok", "after {line:?}");
    }
    assert!(say(&mut t, &mut sys, &lk, "golden").ends_with("MATCH ok"));
    assert!(t.steps <= budget, "golden took {} of {budget}", t.steps);
    assert!(say(&mut t, &mut sys, &lk, "digest").contains("the lock holds"));
    say(&mut t, &mut sys, &lk, "1000000 loop-limit! 8 step! 15 learn! 65536 explore!");
    assert_eq!(say(&mut t, &mut sys, &lk, "begin again"), "? step budget spent: loop broken (terminal.stepBudget)");
    assert!(t.steps <= budget + 1);
    assert!(say(&mut t, &mut sys, &lk, "locked params").contains("as containment.nix declares"));
}

/// REGRESSION for Phase 16 audit finding "the step budget does not bound a line's work": `stats` scans the whole
/// pool twice, `agent` an agent's weights and block, `words` the dictionary and `help`/`roles` print a screen, each
/// for one step, so `begin stats again` runs 2.5 million pool scans inside the 5,000,000-step budget. Measured on
/// the code as audited (4 CPUs shared): `begin 1 . again` 0.07 s, `begin stats again` 17.9 s, `begin words again`
/// 15.1 s, `begin help again` 13.1 s, `begin roles again` 3.0 s; at the validator's largest stepBudget that is 20x
/// longer. The budget's own loop is the yardstick, so the bound holds on any machine: a printing or scanning loop
/// may take a few times what a bare loop takes, plus a second, never a hundred times. It passes once those words
/// charge the work they do (as `tick`, `fill-a`, `count-a`, `route`, `cfg` and `digest` already do).
#[test]
fn a_runaway_line_cannot_hold_the_machine_longer_than_its_budget_implies() {
    let (mut t, mut sys, lk, _) = opened(&shipped());
    let mut time = |line: &str| {
        let t0 = Instant::now();
        term::run_line(&mut t, &mut sys, &lk, line);
        let took = t0.elapsed();
        let last = screen(&t, &sys).pop().unwrap_or_default();
        assert_eq!(last, "? step budget spent: loop broken (terminal.stepBudget)", "{line:?}");
        took
    };
    let bare = time("begin 1 drop again");
    let bound = bare * 4 + Duration::from_secs(1);
    for line in ["begin stats again", "begin 17 agent again", "begin roles again", "begin help again", "begin words again"] {
        let took = time(line);
        assert!(took <= bound, "{line:?} held the machine {took:?}; the budget's bare loop took {bare:?} (bound {bound:?})");
    }
}
