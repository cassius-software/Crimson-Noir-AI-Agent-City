// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It is the Crimson Terminal: the operator's console once the self-test has passed. It is
//! a small Forth, so it is a programming language and not a menu: numbers and words on a data stack, definitions,
//! variables and arrays in its own dictionary, IF/ELSE, BEGIN loops, counted DO loops and recursion. That makes it
//! Turing complete in the usual sense of a real machine (bounded by its declared memory and its step budget); the
//! tests run Rule 110, a universal cellular automaton, in it. Its words reach the system's raw state: every array of
//! the Global Matrix (positions in eighths of a cell, the 1/0 masks, memory blocks, walls, routing fields), the
//! kernels (tick, route, respawn, the scripted self-test), the runtime knobs of the compute configuration, and the
//! locked declarative configuration (read-only: it is shown and its SHA-256 lock re-checked, never changed).
//!
//! Each typed line is compiled as one anonymous word and then run, so loops and IF work at the prompt; a defining word
//! (`:`, `variable`, `constant`, `create`) first runs what came before it. Everything it holds lives in the declared
//! arrays (term_dict, term_stack, term_rstack, term_text, term_line): it allocates nothing. Every access is checked,
//! so a bad program is an error message, never a crash: the data and return stacks have their declared depths, the
//! dictionary its declared cells, and one line may take at most `terminal.stepBudget` steps (the terminal's own
//! loop breaker; a tick of the swarm costs a step per agent slot). Containment holds from here too: the declared
//! privileges (`caps`, `role`) are read-only, and a privilege asked for on an agent's behalf (`ask`) is a request
//! the kernels judge: the agent's pointer is dropped on the next tick.
//! What breaks if it is removed? The operator has no way into the system after the tutorial.

use core::fmt::Write;

use crate::config::{CAP_LEARN, CAP_MEMORY, CAP_MOVE, CAP_ROUTE, CAP_SPAWN, CAPABILITIES, Dims, TERM_COLS, TERM_MIN_CELLS};
use crate::hash;
use crate::kernels::{self, Tally};
use crate::matrix::{self, GOLDEN_TICKS};
use crate::render::scale;
use crate::system::{Buffers, KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_ESC, KEY_PAGE_DOWN, KEY_PAGE_UP, KEY_UP, Locked, System};
use crate::text::{self, Buf, Target};

/// Dictionary cells below this are never a header (so 0 means "none").
const RESERVED: usize = 8;
/// A name is packed four characters to a cell.
const NAME_CELLS: usize = 4;
const MAX_NAME: usize = NAME_CELLS * 4;
/// The typed line's code is compiled into the dictionary's last cells.
const SCRATCH: usize = 1024;
// The validator's smallest dictionary holds the line's area and room for definitions.
const _: () = assert!(TERM_MIN_CELLS >= SCRATCH + RESERVED + 512);
/// The longest input line, and the lines of history kept after it in term_line.
const INPUT: usize = TERM_COLS - 2;
const HISTORY: usize = 3;
/// How deep IF, BEGIN and DO may nest.
const CONTROL: usize = 32;
/// The return address that ends a run.
const SENTINEL: i32 = -1;

/// What the operator asked the platform for.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Request {
    None,
    Tutorial,
    Reboot,
    Halt,
}

/// Why a line stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
    Underflow,
    Overflow,
    ReturnStack,
    Budget,
    DivZero,
    Address,
    Index,
    NoArray,
    ReadOnly(&'static str),
    Range(&'static str),
    Unknown,
    Compile(&'static str),
    Full,
    Corrupt,
}

impl Fault {
    fn message(self) -> &'static str {
        match self {
            Fault::Underflow => "stack underflow",
            Fault::Overflow => "stack overflow (the declared depth)",
            Fault::ReturnStack => "return stack overflow or underflow (too deep, or an unbalanced >r r>)",
            Fault::Budget => "step budget spent: loop broken (terminal.stepBudget)",
            Fault::DivZero => "division by zero",
            Fault::Address => "address outside the dictionary",
            Fault::Index => "index outside the array",
            Fault::NoArray => "no such array",
            Fault::ReadOnly(what) | Fault::Range(what) | Fault::Compile(what) => what,
            Fault::Unknown => "no such word",
            Fault::Full => "the dictionary is full (terminal.cells)",
            Fault::Corrupt => "the dictionary holds something that is not code",
        }
    }
}

type R<T> = Result<T, Fault>;

/// One open control structure while compiling: what it is, the address it resolves, and its chain of LEAVEs.
#[derive(Clone, Copy, Debug, Default)]
struct Ctl {
    kind: u8,
    at: usize,
    leaves: usize,
}

const C_IF: u8 = 1;
const C_ELSE: u8 = 2;
const C_BEGIN: u8 = 3;
const C_WHILE: u8 = 4;
const C_DO: u8 = 5;

/// The terminal's scalar state (its memory is the declared arrays in Buffers).
#[derive(Clone, Copy, Debug)]
pub struct Term {
    pub here: usize,
    pub latest: usize,
    pub sp: usize,
    pub rp: usize,
    /// Scrollback lines in use, the cursor's column on the last, and how far the view is scrolled back.
    pub lines: usize,
    pub col: usize,
    /// A message ended its line: the next output starts a new one (" ok" does not).
    pub pending: bool,
    pub scroll: usize,
    pub input: usize,
    pub history: usize,
    pub recall: usize,
    pub base: u32,
    /// The swarm's tick counter, whether it ticks every frame, and the floor map.
    pub tick: u32,
    pub running: bool,
    pub map: bool,
    pub mark: u32,
    /// The compute configuration as run (the locked one, unless a knob was changed here), and the locked one.
    pub dims: Dims,
    pub locked: Dims,
    pub tally: Tally,
    pub request: Request,
    /// Steps the current line has taken.
    pub steps: u64,
    /// The `:` definition being compiled (its header), or 0.
    def: usize,
    ctl: [Ctl; CONTROL],
    nctl: usize,
    /// The platform's clock at the last frame, and when the running swarm ticks next (milliseconds).
    now: u64,
    next_tick: u64,
}

macro_rules! prims {
    ($($id:ident = $name:literal),* $(,)?) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        enum P { $($id),* }
        /// The built-in words, by name; a code cell holds -(index + 1). Names with a space cannot be typed.
        const PRIMS: &[(&str, P)] = &[$(($name, P::$id)),*];
    };
}

prims! {
    Lit = " lit", Branch = " branch", ZBranch = " 0branch", Do = " do", QDo = " ?do", Loop = " loop",
    PlusLoop = " +loop", Leave = " leave", Exit = " exit", DotQ = " .\"",
    Dup = "dup", Drop = "drop", Swap = "swap", Over = "over", Rot = "rot", MRot = "-rot", Nip = "nip", Tuck = "tuck",
    Pick = "pick", TwoDup = "2dup", TwoDrop = "2drop", TwoSwap = "2swap", QDup = "?dup", Depth = "depth",
    Clear = "clear",
    Add = "+", Sub = "-", Mul = "*", Div = "/", Mod = "mod", DivMod = "/mod", MulDiv = "*/", Negate = "negate",
    Abs = "abs", Min = "min", Max = "max", Inc = "1+", Dec = "1-", Twice = "2*", Half = "2/",
    And = "and", Or = "or", Xor = "xor", Invert = "invert", Lshift = "lshift", Rshift = "rshift",
    Eq = "=", Ne = "<>", Lt = "<", Gt = ">", Le = "<=", Ge = ">=", ZEq = "0=", ZNe = "0<>", ZLt = "0<", ZGt = "0>",
    ULt = "u<", True = "true", False = "false",
    Fetch = "@", Store = "!", PlusStore = "+!", Comma = ",", Here = "here", Allot = "allot",
    ToR = ">r", RFrom = "r>", RFetch = "r@", I = "i", J = "j", Unloop = "unloop",
    Dot = ".", UDot = "u.", DotS = ".s", Emit = "emit", Cr = "cr", Space = "space", Spaces = "spaces",
    Hex = "hex", Decimal = "decimal",
    Px = "px", Pz = "pz", Alive = "alive", Doomed = "doomed", Caps = "caps", Req = "req", Role = "role",
    Goal = "goal", Run = "run", Last = "last", Trips = "trips", Clock = "clock", Heading = "heading", Fate = "fate",
    Weights = "weights", Memory = "memory", Walls = "walls", Field = "field", Station = "station",
    AFetch = "@a", AStore = "!a", ALen = "#a", AFill = "fill-a", ACount = "count-a",
    CapMove = "cap-move", CapRoute = "cap-route", CapLearn = "cap-learn", CapMemory = "cap-memory",
    CapSpawn = "cap-spawn", Ask = "ask", Cell = "cell", Xz = "xz",
    Tick = "tick", Ticks = "ticks", Go = "go", Stop = "stop", Stats = "stats", Agent = "agent", Flush = "flush", Respawn = "respawn",
    World = "world", Route = "route", Golden = "golden", Map = "map", Mark = "mark",
    Cfg = "cfg", Digest = "digest", Roles = "roles", Params = "params", SetLoop = "loop-limit!", SetStep = "step!",
    SetLearn = "learn!", SetExplore = "explore!", Locked = "locked",
    Words = "words", Help = "help", Page = "page", Cold = "cold", Tutorial = "tutorial", Reboot = "reboot",
    Halt = "halt",
}

/// The arrays the terminal reaches, in the order of the array words (px .. station).
const ARRAYS: [&str; 19] = [
    "px", "pz", "alive", "doomed", "caps", "req", "role", "goal", "run", "last", "trips", "clock", "heading", "fate",
    "weights", "memory", "walls", "field", "station",
];

const HELP: [&str; 12] = [
    "A Forth over the Global Matrix; each line is compiled as one word, then run.",
    "  2 3 + .    : sq dup * ;    10 0 do i sq . loop    variable v 5 v ! v @ .",
    "  if else then  begin until  begin while repeat  do ?do loop +loop leave",
    "arrays (index, then array): 17 alive @a .   0 17 doomed !a   alive #a .",
    "  px pz alive doomed caps req role goal run last trips clock heading fate",
    "  weights memory walls field station    1 alive count-a .   0 walls fill-a",
    "  positions are eighths of a cell; caps and role are declared: read-only",
    "swarm: tick ticks go stop stats agent ask flush respawn world route golden map",
    "  cap-spawn 5 ask 1 tick 5 agent   (a privilege it was never declared)",
    "config: cfg digest roles params loop-limit! step! learn! explore! locked",
    "system: words page cold mark tutorial reboot halt .s hex decimal recurse",
    "keys: Enter runs, Up/Down recall, PgUp/PgDn scroll, Esc clears the line",
];

/// A fresh terminal over the system's declared memory, its banner printed.
pub fn open(sys: &mut System, d: &Dims, lk: &Locked) -> Term {
    let mut t = Term {
        here: RESERVED,
        latest: 0,
        sp: 0,
        rp: 0,
        lines: 0,
        col: 0,
        pending: false,
        scroll: 0,
        input: 0,
        history: 0,
        recall: 0,
        base: 10,
        tick: 0,
        running: false,
        map: false,
        mark: u32::MAX,
        dims: *d,
        locked: *d,
        tally: Tally::default(),
        request: Request::None,
        steps: 0,
        def: 0,
        ctl: [Ctl::default(); CONTROL],
        nctl: 0,
        now: 0,
        next_tick: 0,
    };
    sys.b.term_text.fill(b' ');
    sys.b.term_line.fill(b' ');
    let mut o = sink(&mut t, &mut sys.b);
    let _ = writeln!(o, "CRIMSON NOIR OS {} ({}): the self-test passed.", lk.version, lk.name);
    let _ = writeln!(o, "containment {}", lk.digest);
    let _ = writeln!(o, "help shows the basics, words lists every word; the swarm waits for go.");
    t
}

// ---------------------------------------------------------------------------------------------------------------
// The scrollback

/// Writes into the scrollback: wraps at TERM_COLS, scrolls the oldest line away when it is full.
struct Sink<'a> {
    lines: &'a mut usize,
    col: &'a mut usize,
    pending: &'a mut bool,
    text: &'a mut [u8],
}

fn sink<'a>(t: &'a mut Term, b: &'a mut Buffers) -> Sink<'a> {
    Sink { lines: &mut t.lines, col: &mut t.col, pending: &mut t.pending, text: &mut b.term_text }
}

impl Sink<'_> {
    fn newline(&mut self) {
        let cap = self.text.len() / TERM_COLS;
        if *self.lines >= cap {
            self.text.copy_within(TERM_COLS.., 0);
        } else {
            *self.lines += 1;
        }
        let last = (*self.lines - 1) * TERM_COLS;
        self.text[last..last + TERM_COLS].fill(b' ');
        *self.col = 0;
    }

    /// Ends a message's line: the next output (but not " ok") starts a new one.
    fn end_line(&mut self) {
        *self.pending = *self.col > 0;
    }

    fn put(&mut self, c: u8) {
        if core::mem::replace(self.pending, false) {
            self.newline();
        }
        if *self.lines == 0 {
            *self.lines = 1;
            self.text[..TERM_COLS].fill(b' ');
            *self.col = 0;
        }
        if c == b'\n' {
            self.newline();
            return;
        }
        if *self.col >= TERM_COLS {
            self.newline();
        }
        let at = (*self.lines - 1) * TERM_COLS + *self.col;
        self.text[at] = if (32..127).contains(&c) { c } else { b'?' };
        *self.col += 1;
    }
}

impl Write for Sink<'_> {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        for c in s.bytes() {
            self.put(c);
        }
        Ok(())
    }
}

/// Starts a fresh line unless the cursor is already at the start of one.
fn fresh_line(o: &mut Sink) {
    *o.pending = false;
    if *o.col > 0 {
        o.newline();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Stacks and the dictionary

fn push(t: &mut Term, b: &mut Buffers, v: i32) -> R<()> {
    let slot = b.term_stack.get_mut(t.sp).ok_or(Fault::Overflow)?;
    *slot = v;
    t.sp += 1;
    Ok(())
}

fn pop(t: &mut Term, b: &Buffers) -> R<i32> {
    if t.sp == 0 {
        return Err(Fault::Underflow);
    }
    t.sp -= 1;
    Ok(b.term_stack[t.sp])
}

/// The `k`th item from the top (0 is the top).
fn peek(t: &Term, b: &Buffers, k: usize) -> R<i32> {
    if k >= t.sp {
        return Err(Fault::Underflow);
    }
    Ok(b.term_stack[t.sp - 1 - k])
}

fn rpush(t: &mut Term, b: &mut Buffers, v: i32) -> R<()> {
    let slot = b.term_rstack.get_mut(t.rp).ok_or(Fault::ReturnStack)?;
    *slot = v;
    t.rp += 1;
    Ok(())
}

fn rpop(t: &mut Term, b: &Buffers) -> R<i32> {
    if t.rp == 0 {
        return Err(Fault::ReturnStack);
    }
    t.rp -= 1;
    Ok(b.term_rstack[t.rp])
}

fn rpeek(t: &Term, b: &Buffers, k: usize) -> R<i32> {
    if k >= t.rp {
        return Err(Fault::ReturnStack);
    }
    Ok(b.term_rstack[t.rp - 1 - k])
}

fn cell(b: &Buffers, at: usize) -> R<i32> {
    b.term_dict.get(at).copied().ok_or(Fault::Address)
}

fn addr(b: &Buffers, v: i32) -> R<usize> {
    let a = usize::try_from(v).map_err(|_| Fault::Address)?;
    if a >= b.term_dict.len() {
        return Err(Fault::Address);
    }
    Ok(a)
}

/// Where definitions may grow to (the line's code lives above).
fn limit(b: &Buffers) -> usize {
    b.term_dict.len() - SCRATCH
}

fn code_of(p: P) -> i32 {
    -(PRIMS.iter().position(|&(_, q)| q == p).unwrap_or(0) as i32) - 1
}

fn lower(c: u8) -> u8 {
    c.to_ascii_lowercase()
}

/// A header's name, unpacked into `out`; returns its length.
fn name_of(dict: &[i32], header: usize, out: &mut [u8; MAX_NAME]) -> usize {
    let len = (dict.get(header + 1).copied().unwrap_or(0) & 0xff) as usize;
    let len = len.min(MAX_NAME);
    for (k, o) in out.iter_mut().enumerate().take(len) {
        let w = dict.get(header + 2 + k / 4).copied().unwrap_or(0) as u32;
        *o = (w >> (8 * (k % 4))) as u8;
    }
    len
}

fn body_of(header: usize) -> usize {
    header + 2 + NAME_CELLS
}

/// The newest user word called `name` (lower case), by its header.
fn find(t: &Term, b: &Buffers, name: &[u8]) -> Option<usize> {
    let mut h = t.latest;
    let mut buf = [0u8; MAX_NAME];
    let mut guard = 0;
    while h >= RESERVED && h < b.term_dict.len() && guard < b.term_dict.len() {
        let n = name_of(&b.term_dict, h, &mut buf);
        if n == name.len() && buf[..n].iter().zip(name).all(|(a, c)| a == c) {
            return Some(h);
        }
        h = cell(b, h).unwrap_or(0) as usize;
        guard += 1;
    }
    None
}

fn prim(name: &[u8]) -> Option<P> {
    PRIMS.iter().find(|(n, _)| n.as_bytes() == name).map(|&(_, p)| p)
}

/// Lays down a header for `name` at `here` (not yet linked); returns it.
fn header(t: &mut Term, b: &mut Buffers, name: &[u8]) -> R<usize> {
    if name.is_empty() || name.len() > MAX_NAME {
        return Err(Fault::Compile("a name is 1 to 16 characters"));
    }
    let h = t.here;
    if h + 2 + NAME_CELLS + 4 > limit(b) {
        return Err(Fault::Full);
    }
    b.term_dict[h] = t.latest as i32;
    b.term_dict[h + 1] = name.len() as i32;
    for k in 0..NAME_CELLS {
        let mut w = 0u32;
        for j in 0..4 {
            let c = name.get(k * 4 + j).copied().unwrap_or(0);
            w |= (lower(c) as u32) << (8 * j);
        }
        b.term_dict[h + 2 + k] = w as i32;
    }
    t.here = body_of(h);
    Ok(h)
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens and numbers

/// The next whitespace-separated token of `line` from `*pos`, as a range.
fn token(line: &[u8], pos: &mut usize) -> Option<(usize, usize)> {
    while *pos < line.len() && line[*pos] <= b' ' {
        *pos += 1;
    }
    if *pos >= line.len() {
        return None;
    }
    let start = *pos;
    while *pos < line.len() && line[*pos] > b' ' {
        *pos += 1;
    }
    Some((start, *pos))
}

/// A number in the current base, or with a prefix ($ hex, # decimal, % binary), or a character literal ('a').
fn number(tok: &[u8], base: u32) -> Option<i32> {
    if tok.len() == 3 && tok[0] == b'\'' && tok[2] == b'\'' {
        return Some(tok[1] as i32);
    }
    let (neg, rest) = match tok.first() {
        Some(b'-') if tok.len() > 1 => (true, &tok[1..]),
        _ => (false, tok),
    };
    let (base, digits) = match rest.first() {
        Some(b'$') => (16, &rest[1..]),
        Some(b'#') => (10, &rest[1..]),
        Some(b'%') => (2, &rest[1..]),
        _ => (base, rest),
    };
    if digits.is_empty() {
        return None;
    }
    let mut v: i64 = 0;
    for &c in digits {
        let d = (c as char).to_digit(base)? as i64;
        v = v * base as i64 + d;
        if v > u32::MAX as i64 {
            return None;
        }
    }
    let v = if neg { -v } else { v };
    if v < i32::MIN as i64 {
        return None;
    }
    Some(v as u32 as i32)
}

fn print_num(o: &mut Sink, v: i32, base: u32, unsigned: bool) {
    let _ = match (base, unsigned) {
        (16, _) => write!(o, "{:x} ", v as u32),
        (_, true) => write!(o, "{} ", v as u32),
        _ => write!(o, "{} ", v),
    };
}

// ---------------------------------------------------------------------------------------------------------------
// The compiler

/// Where the line is being compiled: the definition in progress (at `here`), or the line's own code.
struct Code {
    sc: usize,
    scratch: usize,
}

fn pointer(t: &Term, c: &Code) -> usize {
    if t.def != 0 { t.here } else { c.sc }
}

fn comma(t: &mut Term, b: &mut Buffers, c: &mut Code, v: i32) -> R<()> {
    if t.def != 0 {
        if t.here >= limit(b) {
            return Err(Fault::Full);
        }
        b.term_dict[t.here] = v;
        t.here += 1;
    } else {
        if c.sc >= b.term_dict.len() {
            return Err(Fault::Compile("the line is too long to compile"));
        }
        b.term_dict[c.sc] = v;
        c.sc += 1;
    }
    Ok(())
}

fn open_ctl(t: &mut Term, kind: u8, at: usize) -> R<()> {
    if t.nctl >= CONTROL {
        return Err(Fault::Compile("IF, BEGIN and DO nest too deep"));
    }
    t.ctl[t.nctl] = Ctl { kind, at, leaves: 0 };
    t.nctl += 1;
    Ok(())
}

fn close_ctl(t: &mut Term, kinds: &[u8], what: &'static str) -> R<Ctl> {
    if t.nctl == 0 || !kinds.contains(&t.ctl[t.nctl - 1].kind) {
        return Err(Fault::Compile(what));
    }
    t.nctl -= 1;
    Ok(t.ctl[t.nctl])
}

/// Runs the line's code compiled so far, and starts it afresh.
fn flush(t: &mut Term, sys: &mut System, lk: &Locked, c: &mut Code) -> R<()> {
    // Checked first: a BEGIN compiles nothing, yet a definition after it would branch into the line's code. (A
    // definition's own open structures may span lines: the line's code is empty then.)
    if t.def == 0 && t.nctl != 0 {
        return Err(Fault::Compile("finish the IF, BEGIN or DO before defining a word"));
    }
    if c.sc == c.scratch {
        return Ok(());
    }
    let exit = code_of(P::Exit);
    comma(t, &mut sys.b, c, exit)?;
    c.sc = c.scratch;
    exec(t, sys, lk, c.scratch)
}

/// Compiles and runs one typed line.
fn interpret(t: &mut Term, sys: &mut System, lk: &Locked, line: &[u8]) -> R<()> {
    let scratch = limit(&sys.b);
    let mut c = Code { sc: scratch, scratch };
    let mut pos = 0;
    let mut low = [0u8; TERM_COLS];
    while let Some((s, e)) = token(line, &mut pos) {
        let n = (e - s).min(low.len());
        for k in 0..n {
            low[k] = lower(line[s + k]);
        }
        let tok = &low[..n];
        let b = &mut sys.b;
        match tok {
            b"\\" => break,
            b"(" => {
                while pos < line.len() && line[pos] != b')' {
                    pos += 1;
                }
                pos += 1;
            }
            b".\"" => {
                // The text after one space, up to the closing quote.
                let start = (pos + 1).min(line.len());
                let mut end = start;
                while end < line.len() && line[end] != b'"' {
                    end += 1;
                }
                pos = end + 1;
                let text = &line[start..end];
                comma(t, b, &mut c, code_of(P::DotQ))?;
                comma(t, b, &mut c, text.len() as i32)?;
                for chunk in text.chunks(4) {
                    let mut w = 0u32;
                    for (j, &ch) in chunk.iter().enumerate() {
                        w |= (ch as u32) << (8 * j);
                    }
                    comma(t, b, &mut c, w as i32)?;
                }
            }
            b":" => {
                if t.def != 0 {
                    return Err(Fault::Compile("a : inside a definition"));
                }
                flush(t, sys, lk, &mut c)?;
                let (ns, ne) = token(line, &mut pos).ok_or(Fault::Compile(": needs a name"))?;
                let mut name = [0u8; MAX_NAME + 1];
                let nl = (ne - ns).min(MAX_NAME + 1);
                name[..nl].copy_from_slice(&line[ns..ns + nl]);
                t.def = header(t, &mut sys.b, &name[..nl])?;
            }
            b";" => {
                if t.def == 0 {
                    return Err(Fault::Compile("; without a :"));
                }
                if t.nctl != 0 {
                    return Err(Fault::Compile("an IF, BEGIN or DO is still open at ;"));
                }
                comma(t, b, &mut c, code_of(P::Exit))?;
                t.latest = t.def;
                t.def = 0;
            }
            b"variable" | b"constant" | b"create" => {
                if t.def != 0 {
                    return Err(Fault::Compile("define words outside a : definition"));
                }
                flush(t, sys, lk, &mut c)?;
                let value = if tok == b"constant" { pop(t, &sys.b)? } else { 0 };
                let (ns, ne) = token(line, &mut pos).ok_or(Fault::Compile("it needs a name"))?;
                let mut name = [0u8; MAX_NAME + 1];
                let nl = (ne - ns).min(MAX_NAME + 1);
                name[..nl].copy_from_slice(&line[ns..ns + nl]);
                let b = &mut sys.b;
                let h = header(t, b, &name[..nl])?;
                let body = t.here;
                let data = body + 3;
                b.term_dict[body] = code_of(P::Lit);
                b.term_dict[body + 1] = match tok {
                    b"constant" => value,
                    _ => data as i32,
                };
                b.term_dict[body + 2] = code_of(P::Exit);
                t.here = body + 3;
                if tok == b"variable" {
                    b.term_dict[data] = 0;
                    t.here += 1;
                }
                t.latest = h;
            }
            b"if" => {
                comma(t, b, &mut c, code_of(P::ZBranch))?;
                open_ctl(t, C_IF, pointer(t, &c))?;
                comma(t, b, &mut c, 0)?;
            }
            b"else" => {
                let f = close_ctl(t, &[C_IF], "ELSE without IF")?;
                comma(t, b, &mut c, code_of(P::Branch))?;
                let hole = pointer(t, &c);
                comma(t, b, &mut c, 0)?;
                b.term_dict[f.at] = pointer(t, &c) as i32;
                open_ctl(t, C_ELSE, hole)?;
            }
            b"then" => {
                let f = close_ctl(t, &[C_IF, C_ELSE], "THEN without IF")?;
                b.term_dict[f.at] = pointer(t, &c) as i32;
            }
            b"begin" => open_ctl(t, C_BEGIN, pointer(t, &c))?,
            b"until" | b"again" => {
                let f = close_ctl(t, &[C_BEGIN], "UNTIL or AGAIN without BEGIN")?;
                comma(t, b, &mut c, code_of(if tok == b"until" { P::ZBranch } else { P::Branch }))?;
                comma(t, b, &mut c, f.at as i32)?;
            }
            b"while" => {
                if t.nctl == 0 || t.ctl[t.nctl - 1].kind != C_BEGIN {
                    return Err(Fault::Compile("WHILE without BEGIN"));
                }
                comma(t, b, &mut c, code_of(P::ZBranch))?;
                open_ctl(t, C_WHILE, pointer(t, &c))?;
                comma(t, b, &mut c, 0)?;
            }
            b"repeat" => {
                let w = close_ctl(t, &[C_WHILE], "REPEAT without WHILE")?;
                let f = close_ctl(t, &[C_BEGIN], "REPEAT without BEGIN")?;
                comma(t, b, &mut c, code_of(P::Branch))?;
                comma(t, b, &mut c, f.at as i32)?;
                b.term_dict[w.at] = pointer(t, &c) as i32;
            }
            b"do" | b"?do" => {
                if tok == b"do" {
                    comma(t, b, &mut c, code_of(P::Do))?;
                    open_ctl(t, C_DO, pointer(t, &c))?;
                } else {
                    comma(t, b, &mut c, code_of(P::QDo))?;
                    let hole = pointer(t, &c);
                    comma(t, b, &mut c, 0)?;
                    open_ctl(t, C_DO, pointer(t, &c))?;
                    t.ctl[t.nctl - 1].leaves = hole;
                }
            }
            b"loop" | b"+loop" => {
                let f = close_ctl(t, &[C_DO], "LOOP without DO")?;
                comma(t, b, &mut c, code_of(if tok == b"loop" { P::Loop } else { P::PlusLoop }))?;
                comma(t, b, &mut c, f.at as i32)?;
                // Every LEAVE (and ?DO's skip) lands after the loop: the holes are chained through themselves.
                let after = pointer(t, &c) as i32;
                let mut l = f.leaves;
                let mut guard = 0;
                while l != 0 && guard < CONTROL * 64 {
                    let next = b.term_dict[l] as usize;
                    b.term_dict[l] = after;
                    l = next;
                    guard += 1;
                }
            }
            b"leave" => {
                let k = (0..t.nctl).rev().find(|&k| t.ctl[k].kind == C_DO).ok_or(Fault::Compile("LEAVE outside a DO loop"))?;
                comma(t, b, &mut c, code_of(P::Leave))?;
                let hole = pointer(t, &c);
                comma(t, b, &mut c, t.ctl[k].leaves as i32)?;
                t.ctl[k].leaves = hole;
            }
            b"recurse" => {
                if t.def == 0 {
                    return Err(Fault::Compile("RECURSE outside a : definition"));
                }
                comma(t, b, &mut c, body_of(t.def) as i32)?;
            }
            b"exit" => comma(t, b, &mut c, code_of(P::Exit))?,
            b"hex" | b"decimal" => {
                // At the prompt the base changes at once, so the rest of the line is read in it; it also changes
                // when the code runs (and only then, inside a definition).
                if t.def == 0 {
                    t.base = if tok == b"hex" { 16 } else { 10 };
                }
                comma(t, b, &mut c, code_of(if tok == b"hex" { P::Hex } else { P::Decimal }))?;
            }
            _ => {
                if let Some(h) = find(t, b, tok) {
                    comma(t, b, &mut c, body_of(h) as i32)?;
                } else if let Some(p) = prim(tok) {
                    comma(t, b, &mut c, code_of(p))?;
                } else if let Some(v) = number(tok, t.base) {
                    comma(t, b, &mut c, code_of(P::Lit))?;
                    comma(t, b, &mut c, v)?;
                } else {
                    let mut o = sink(t, &mut sys.b);
                    fresh_line(&mut o);
                    let _ = write!(o, "? ");
                    for &ch in &line[s..e] {
                        o.put(ch);
                    }
                    let _ = write!(o, ": ");
                    return Err(Fault::Unknown);
                }
            }
        }
    }
    if t.def == 0 && t.nctl != 0 {
        return Err(Fault::Compile("an IF, BEGIN or DO is still open at the end of the line"));
    }
    flush(t, sys, lk, &mut c)
}

// ---------------------------------------------------------------------------------------------------------------
// The inner interpreter

/// Spends `n` steps of the line's budget.
fn charge(t: &mut Term, n: u64) -> R<()> {
    t.steps += n;
    if t.steps > t.locked.term_steps as u64 {
        return Err(Fault::Budget);
    }
    Ok(())
}

fn flag(b: bool) -> i32 {
    -(b as i32)
}

/// The operand cell after an instruction, as a jump target.
fn target(b: &Buffers, ip: usize) -> R<usize> {
    addr(b, cell(b, ip)?)
}

/// Runs code from `start` until it returns.
fn exec(t: &mut Term, sys: &mut System, lk: &Locked, start: usize) -> R<()> {
    let base = t.rp;
    rpush(t, &mut sys.b, SENTINEL)?;
    let mut ip = start;
    loop {
        charge(t, 1)?;
        let b = &mut sys.b;
        let code = cell(b, ip)?;
        ip += 1;
        if code >= 0 {
            let to = addr(b, code)?;
            rpush(t, b, ip as i32)?;
            ip = to;
            continue;
        }
        let p = PRIMS.get((-(code as i64) - 1) as usize).map(|&(_, p)| p).ok_or(Fault::Corrupt)?;
        match p {
            P::Lit => {
                let v = cell(b, ip)?;
                push(t, b, v)?;
                ip += 1;
            }
            P::Branch => ip = target(b, ip)?,
            P::ZBranch => {
                ip = if pop(t, b)? == 0 { target(b, ip)? } else { ip + 1 };
            }
            P::Exit => {
                let r = rpop(t, b)?;
                if r == SENTINEL {
                    if t.rp != base {
                        return Err(Fault::ReturnStack);
                    }
                    return Ok(());
                }
                ip = addr(b, r)?;
            }
            P::Do | P::QDo => {
                let index = pop(t, b)?;
                let lim = pop(t, b)?;
                if p == P::QDo && index == lim {
                    ip = target(b, ip)?;
                } else {
                    rpush(t, b, lim)?;
                    rpush(t, b, index)?;
                    ip += (p == P::QDo) as usize;
                }
            }
            P::Loop | P::PlusLoop => {
                let step = if p == P::Loop { 1 } else { pop(t, b)? };
                let index = rpeek(t, b, 0)?;
                let lim = rpeek(t, b, 1)?;
                let next = index.wrapping_add(step);
                // Done when the index crosses the boundary between limit - 1 and limit.
                let d = index.wrapping_sub(lim);
                let done = if p == P::Loop { next == lim } else { (d ^ d.wrapping_add(step)) < 0 };
                if done {
                    t.rp -= 2;
                    ip += 1;
                } else {
                    b.term_rstack[t.rp - 1] = next;
                    ip = target(b, ip)?;
                }
            }
            P::Leave => {
                rpeek(t, b, 1)?;
                t.rp -= 2;
                ip = target(b, ip)?;
            }
            P::DotQ => {
                let len = cell(b, ip)?.clamp(0, TERM_COLS as i32 * 4) as usize;
                let mut text = [0u8; TERM_COLS * 4];
                for (k, ch) in text.iter_mut().enumerate().take(len) {
                    *ch = (cell(b, ip + 1 + k / 4)? as u32 >> (8 * (k % 4))) as u8;
                }
                ip += 1 + len.div_ceil(4);
                let mut o = sink(t, b);
                for &ch in &text[..len] {
                    o.put(ch);
                }
            }
            _ => word(t, sys, lk, p)?,
        }
    }
}

fn two(t: &mut Term, b: &Buffers) -> R<(i32, i32)> {
    let y = pop(t, b)?;
    let x = pop(t, b)?;
    Ok((x, y))
}

/// The array an array word pushed, checked.
fn array_of(v: i32) -> R<usize> {
    usize::try_from(v).ok().filter(|&a| a < ARRAYS.len()).ok_or(Fault::NoArray)
}

fn array_len(m: &matrix::Matrix, a: usize) -> usize {
    match a {
        0 => m.px.len(),
        1 => m.pz.len(),
        14 => m.weights.len(),
        15 => m.memory.len(),
        16 => m.walls.len(),
        17 => m.field.len(),
        18 => m.station.len(),
        _ => m.alive.len(),
    }
}

fn words_u32(m: &mut matrix::Matrix, a: usize) -> Option<&mut [u32]> {
    Some(match a {
        2 => &mut m.alive,
        3 => &mut m.doomed,
        4 => &mut m.caps,
        5 => &mut m.req,
        6 => &mut m.role,
        7 => &mut m.goal,
        8 => &mut m.run,
        9 => &mut m.last,
        10 => &mut m.trips,
        11 => &mut m.clock,
        12 => &mut m.heading,
        13 => &mut m.fate,
        15 => &mut m.memory,
        16 => &mut m.walls,
        17 => &mut m.field,
        18 => &mut m.station,
        _ => return None,
    })
}

/// A position (cells) as eighths of a cell.
fn eighths(v: f32) -> i32 {
    (v * 8.0) as i32
}

fn read_array(sys: &mut System, a: usize, i: usize) -> R<i32> {
    let m = &mut sys.m;
    if i >= array_len(m, a) {
        return Err(Fault::Index);
    }
    Ok(match a {
        0 => eighths(m.px[i]),
        1 => eighths(m.pz[i]),
        14 => m.weights[i],
        _ => words_u32(m, a).ok_or(Fault::NoArray)?[i] as i32,
    })
}

fn write_array(t: &Term, sys: &mut System, a: usize, i: usize, v: i32) -> R<()> {
    let d = &t.dims;
    let m = &mut sys.m;
    if i >= array_len(m, a) {
        return Err(Fault::Index);
    }
    match a {
        // On the floor, in exact eighths of a cell.
        0 => m.px[i] = v.clamp(0, d.width as i32 * 8 - 1) as f32 / 8.0,
        1 => m.pz[i] = v.clamp(0, d.depth as i32 * 8 - 1) as f32 / 8.0,
        4 | 6 => return Err(Fault::ReadOnly("caps and role are declared in containment.nix: read-only (ask requests)")),
        2 | 3 | 16 if v != 0 && v != 1 => return Err(Fault::Range("alive, doomed and walls are 1/0 masks: write 0 or 1")),
        14 => m.weights[i] = v,
        18 => {
            if v < 0 || v as usize >= d.width * d.depth {
                return Err(Fault::Range("a station is a cell index: 0 to width x depth - 1"));
            }
            m.station[i] = v as u32;
        }
        _ => words_u32(m, a).ok_or(Fault::NoArray)?[i] = v as u32,
    }
    Ok(())
}

fn set_knob(t: &mut Term, b: &mut Buffers, v: i32, lo: i32, hi: i32, name: &'static str, what: &'static str) -> R<u32> {
    if !(lo..=hi).contains(&v) {
        return Err(Fault::Range(what));
    }
    let mut o = sink(t, b);
    fresh_line(&mut o);
    let _ = write!(o, "{name} {v}: a runtime override; containment.nix and its lock are unchanged");
    o.end_line();
    Ok(v as u32)
}

fn print_role(o: &mut Sink, lk: &Locked, role: u32) {
    let _ = o.write_str(lk.role_names.get(role as usize).copied().unwrap_or("?"));
}

fn print_caps(o: &mut Sink, caps: u32) {
    let mut any = false;
    for (k, name) in CAPABILITIES.iter().enumerate() {
        if caps & (1 << k) != 0 {
            let _ = write!(o, "{}{}", if any { " " } else { "" }, name);
            any = true;
        }
    }
    if !any {
        let _ = o.write_str("none");
    }
}

/// The built-in words that are not control flow.
fn word(t: &mut Term, sys: &mut System, lk: &Locked, p: P) -> R<()> {
    let base = t.base;
    let b = &mut sys.b;
    match p {
        P::Dup => {
            let v = peek(t, b, 0)?;
            push(t, b, v)?;
        }
        P::Drop => {
            pop(t, b)?;
        }
        P::Swap => {
            let (x, y) = two(t, b)?;
            push(t, b, y)?;
            push(t, b, x)?;
        }
        P::Over => {
            let v = peek(t, b, 1)?;
            push(t, b, v)?;
        }
        P::Rot | P::MRot => {
            let c = pop(t, b)?;
            let bb = pop(t, b)?;
            let a = pop(t, b)?;
            let order = if p == P::Rot { [bb, c, a] } else { [c, a, bb] };
            for v in order {
                push(t, b, v)?;
            }
        }
        P::Nip => {
            let v = pop(t, b)?;
            pop(t, b)?;
            push(t, b, v)?;
        }
        P::Tuck => {
            let (x, y) = two(t, b)?;
            for v in [y, x, y] {
                push(t, b, v)?;
            }
        }
        P::Pick => {
            let k = pop(t, b)?;
            let v = peek(t, b, usize::try_from(k).map_err(|_| Fault::Underflow)?)?;
            push(t, b, v)?;
        }
        P::TwoDup => {
            let (x, y) = (peek(t, b, 1)?, peek(t, b, 0)?);
            push(t, b, x)?;
            push(t, b, y)?;
        }
        P::TwoDrop => {
            two(t, b)?;
        }
        P::TwoSwap => {
            let (c, d) = two(t, b)?;
            let (a, bb) = two(t, b)?;
            for v in [c, d, a, bb] {
                push(t, b, v)?;
            }
        }
        P::QDup => {
            let v = peek(t, b, 0)?;
            if v != 0 {
                push(t, b, v)?;
            }
        }
        P::Depth => {
            let n = t.sp as i32;
            push(t, b, n)?;
        }
        P::Clear => t.sp = 0,
        P::Add | P::Sub | P::Mul | P::Div | P::Mod | P::Min | P::Max | P::And | P::Or | P::Xor | P::Lshift | P::Rshift => {
            let (x, y) = two(t, b)?;
            let v = match p {
                P::Add => x.wrapping_add(y),
                P::Sub => x.wrapping_sub(y),
                P::Mul => x.wrapping_mul(y),
                P::Div => x.checked_div(y).ok_or(if y == 0 { Fault::DivZero } else { Fault::Range("overflow in /") })?,
                P::Mod => x.checked_rem(y).ok_or(if y == 0 { Fault::DivZero } else { Fault::Range("overflow in mod") })?,
                P::Min => x.min(y),
                P::Max => x.max(y),
                P::And => x & y,
                P::Or => x | y,
                P::Xor => x ^ y,
                P::Lshift => ((x as u32).checked_shl(y as u32).unwrap_or(0)) as i32,
                _ => ((x as u32).checked_shr(y as u32).unwrap_or(0)) as i32,
            };
            push(t, b, v)?;
        }
        P::DivMod => {
            let (x, y) = two(t, b)?;
            if y == 0 {
                return Err(Fault::DivZero);
            }
            push(t, b, x.wrapping_rem(y))?;
            push(t, b, x.wrapping_div(y))?;
        }
        P::MulDiv => {
            let c = pop(t, b)?;
            let (x, y) = two(t, b)?;
            if c == 0 {
                return Err(Fault::DivZero);
            }
            push(t, b, (x as i64 * y as i64 / c as i64) as i32)?;
        }
        P::Negate | P::Abs | P::Inc | P::Dec | P::Twice | P::Half | P::Invert | P::ZEq | P::ZNe | P::ZLt | P::ZGt => {
            let x = pop(t, b)?;
            let v = match p {
                P::Negate => x.wrapping_neg(),
                P::Abs => x.wrapping_abs(),
                P::Inc => x.wrapping_add(1),
                P::Dec => x.wrapping_sub(1),
                P::Twice => x.wrapping_shl(1),
                P::Half => x >> 1,
                P::Invert => !x,
                P::ZEq => flag(x == 0),
                P::ZNe => flag(x != 0),
                P::ZLt => flag(x < 0),
                _ => flag(x > 0),
            };
            push(t, b, v)?;
        }
        P::Eq | P::Ne | P::Lt | P::Gt | P::Le | P::Ge | P::ULt => {
            let (x, y) = two(t, b)?;
            let v = match p {
                P::Eq => x == y,
                P::Ne => x != y,
                P::Lt => x < y,
                P::Gt => x > y,
                P::Le => x <= y,
                P::Ge => x >= y,
                _ => (x as u32) < (y as u32),
            };
            push(t, b, flag(v))?;
        }
        P::True => push(t, b, -1)?,
        P::False => push(t, b, 0)?,
        P::Fetch => {
            let a = addr(b, pop(t, b)?)?;
            let v = b.term_dict[a];
            push(t, b, v)?;
        }
        P::Store | P::PlusStore => {
            let a = addr(b, pop(t, b)?)?;
            let v = pop(t, b)?;
            if a >= limit(b) {
                return Err(Fault::Address);
            }
            b.term_dict[a] = if p == P::Store { v } else { b.term_dict[a].wrapping_add(v) };
        }
        P::Comma => {
            let v = pop(t, b)?;
            if t.here >= limit(b) {
                return Err(Fault::Full);
            }
            b.term_dict[t.here] = v;
            t.here += 1;
        }
        P::Here => {
            let h = t.here as i32;
            push(t, b, h)?;
        }
        P::Allot => {
            let n = pop(t, b)?;
            let to = t.here as i64 + n as i64;
            if n < 0 || to > limit(b) as i64 {
                return Err(Fault::Full);
            }
            b.term_dict[t.here..to as usize].fill(0);
            t.here = to as usize;
        }
        P::ToR => {
            let v = pop(t, b)?;
            rpush(t, b, v)?;
        }
        P::RFrom => {
            let v = rpop(t, b)?;
            push(t, b, v)?;
        }
        P::RFetch | P::I => {
            let v = rpeek(t, b, 0)?;
            push(t, b, v)?;
        }
        P::J => {
            let v = rpeek(t, b, 2)?;
            push(t, b, v)?;
        }
        P::Unloop => {
            rpeek(t, b, 1)?;
            t.rp -= 2;
        }
        P::Dot | P::UDot => {
            let v = pop(t, b)?;
            print_num(&mut sink(t, b), v, base, p == P::UDot);
        }
        P::DotS => {
            let n = t.sp;
            let mut o = Sink { lines: &mut t.lines, col: &mut t.col, pending: &mut t.pending, text: &mut b.term_text };
            let _ = write!(o, "<{n}> ");
            for k in 0..n {
                print_num(&mut o, b.term_stack[k], base, false);
            }
        }
        P::Emit => {
            let v = pop(t, b)?;
            sink(t, b).put(v as u8);
        }
        P::Cr => sink(t, b).newline(),
        P::Space => sink(t, b).put(b' '),
        P::Spaces => {
            let n = pop(t, b)?.clamp(0, 4 * TERM_COLS as i32);
            charge(t, n as u64)?;
            let mut o = sink(t, b);
            for _ in 0..n {
                o.put(b' ');
            }
        }
        P::Hex => t.base = 16,
        P::Decimal => t.base = 10,
        P::Px | P::Pz | P::Alive | P::Doomed | P::Caps | P::Req | P::Role | P::Goal | P::Run | P::Last | P::Trips
        | P::Clock | P::Heading | P::Fate | P::Weights | P::Memory | P::Walls | P::Field | P::Station => {
            let name = PRIMS.iter().find(|&&(_, q)| q == p).map_or("", |&(n, _)| n);
            let id = ARRAYS.iter().position(|&a| a == name).unwrap_or(0) as i32;
            push(t, b, id)?;
        }
        P::AFetch => {
            let a = array_of(pop(t, b)?)?;
            let i = usize::try_from(pop(t, b)?).map_err(|_| Fault::Index)?;
            let v = read_array(sys, a, i)?;
            push(t, &mut sys.b, v)?;
        }
        P::AStore => {
            let a = array_of(pop(t, b)?)?;
            let i = usize::try_from(pop(t, b)?).map_err(|_| Fault::Index)?;
            let v = pop(t, b)?;
            write_array(t, sys, a, i, v)?;
        }
        P::ALen => {
            let a = array_of(pop(t, b)?)?;
            let n = array_len(&sys.m, a) as i32;
            push(t, &mut sys.b, n)?;
        }
        P::AFill | P::ACount => {
            let a = array_of(pop(t, b)?)?;
            let v = pop(t, b)?;
            let n = array_len(&sys.m, a);
            charge(t, n as u64)?;
            let mut count = 0;
            for i in 0..n {
                if p == P::AFill {
                    write_array(t, sys, a, i, v)?;
                } else {
                    count += (read_array(sys, a, i)? == v) as i32;
                }
            }
            if p == P::ACount {
                push(t, &mut sys.b, count)?;
            }
        }
        P::CapMove => push(t, b, CAP_MOVE as i32)?,
        P::CapRoute => push(t, b, CAP_ROUTE as i32)?,
        P::CapLearn => push(t, b, CAP_LEARN as i32)?,
        P::CapMemory => push(t, b, CAP_MEMORY as i32)?,
        P::CapSpawn => push(t, b, CAP_SPAWN as i32)?,
        P::Ask => {
            let i = usize::try_from(pop(t, b)?).map_err(|_| Fault::Index)?;
            let caps = pop(t, b)? as u32;
            let m = &mut sys.m;
            if i >= m.req.len() {
                return Err(Fault::Index);
            }
            m.req[i] |= caps;
            let (declared, alive) = (m.caps[i], m.alive[i] == 1);
            let mut o = sink(t, &mut sys.b);
            fresh_line(&mut o);
            let _ = write!(o, "agent {i} asks for ");
            print_caps(&mut o, caps);
            let _ = o.write_str(match (alive, caps & !declared != 0) {
                (false, _) => ": it is not alive",
                (true, true) => ": never declared, so its pointer drops next tick",
                (true, false) => ": declared, no violation",
            });
                o.end_line();
        }
        P::Cell => {
            let (x, z) = two(t, b)?;
            let d = &t.dims;
            if x < 0 || z < 0 || x as usize >= d.width || z as usize >= d.depth {
                return Err(Fault::Range("a cell is x 0..width-1, z 0..depth-1"));
            }
            push(t, b, z * d.width as i32 + x)?;
        }
        P::Xz => {
            let c = pop(t, b)?;
            let (w, cells) = (t.dims.width as i32, (t.dims.width * t.dims.depth) as i32);
            if !(0..cells).contains(&c) {
                return Err(Fault::Range("a cell index is 0 to width x depth - 1"));
            }
            push(t, b, c % w)?;
            push(t, b, c / w)?;
        }
        P::Tick => {
            let n = pop(t, b)?;
            for _ in 0..n.max(0) {
                charge(t, t.dims.capacity as u64)?;
                swarm_tick(t, sys);
            }
        }
        P::Ticks => {
            let v = t.tick as i32;
            push(t, b, v)?;
        }
        P::Go | P::Stop => {
            t.running = p == P::Go;
            let mut o = sink(t, b);
            fresh_line(&mut o);
            let _ = o.write_str(if p == P::Go { "the swarm runs, a tick a frame (stop stops it)" } else { "the swarm is stopped" });
            o.end_line();
        }
        P::Stats => {
            // A pool's worth of work, charged before it is done: the budget bounds a line's time, not only its steps.
            charge(t, 2 * t.dims.capacity as u64)?;
            let m = &sys.m;
            let alive = m.alive.iter().filter(|&&a| a == 1).count();
            let doomed = m.doomed.iter().filter(|&&a| a == 1).count();
            let (tl, tick) = (t.tally, t.tick);
            let mut o = sink(t, &mut sys.b);
            fresh_line(&mut o);
            let _ = write!(o, "tick {}  alive {} of {}  doomed {}", tick, alive, m.alive.len(), doomed);
            o.newline();
            let _ = write!(
                o,
                "since the terminal opened: dropped {}  flushed {}  reaped {}  docked {}",
                tl.dropped, tl.flushed, tl.reaped, tl.docked
            );
                o.end_line();
        }
        P::Agent => {
            let i = usize::try_from(pop(t, b)?).map_err(|_| Fault::Index)?;
            if i >= sys.m.alive.len() {
                return Err(Fault::Index);
            }
            charge(t, (t.dims.stations + 2 * t.dims.block_words) as u64)?;
            let m = &sys.m;
            let (x, z) = (eighths(m.px[i]), eighths(m.pz[i]));
            let d = t.dims;
            let cx = (x / 8).clamp(0, d.width as i32 - 1);
            let cz = (z / 8).clamp(0, d.depth as i32 - 1);
            let set = |s: &[u32]| s.iter().filter(|&&w| w != 0).count();
            let weights = m.weights[i * d.stations..(i + 1) * d.stations].iter().filter(|&&w| w != 0).count();
            let memory = set(&m.memory[i * d.block_words..(i + 1) * d.block_words]);
            let row = (m.alive[i], m.doomed[i], m.caps[i], m.req[i], m.role[i], m.goal[i], m.run[i], m.trips[i], m.clock[i]);
            let (heading, fate) = (m.heading[i], m.fate[i]);
            let zero = matrix::row_is_zero(&d, m, i);
            let mut o = sink(t, &mut sys.b);
            fresh_line(&mut o);
            if zero {
                let _ = write!(o, "agent {i}: an empty slot (its row is all zero)");
                o.end_line();
                return Ok(());
            }
            let _ = write!(o, "agent {i}: ");
            print_role(&mut o, lk, row.4);
            let _ = write!(o, "  alive {}  doomed {}  caps ", row.0, row.1);
            print_caps(&mut o, row.2);
            o.newline();
            let _ = write!(
                o,
                "  at {}.{:03} {}.{:03} (cell {})  goal {}  trips {}  clock {}  run {}",
                x / 8,
                (x % 8) * 125,
                z / 8,
                (z % 8) * 125,
                cz * d.width as i32 + cx,
                row.5,
                row.7,
                row.8,
                row.6
            );
            o.newline();
            let _ = write!(o, "  req {}  heading {}  fate {}  weights {} set  memory {}/{} words", row.3, heading, fate, weights, memory, d.block_words);
            o.end_line();
        }
        P::Flush => {
            // The manual loop-breaker: zero an agent's row, weights and memory block at once. It only clears, so it
            // keeps containment; the swarm may be running (`go`), and the next tick simply finds an empty slot.
            let i = usize::try_from(pop(t, b)?).map_err(|_| Fault::Index)?;
            if i >= sys.m.alive.len() {
                return Err(Fault::Index);
            }
            kernels::flush(&t.dims, &mut sys.m, i);
            let mut o = sink(t, &mut sys.b);
            fresh_line(&mut o);
            let _ = write!(o, "agent {i} flushed: its row, weights and memory block are zero");
            o.end_line();
        }
        P::Respawn => {
            charge(t, t.dims.capacity as u64)?;
            matrix::spawn(&t.dims, lk.role_counts, lk.role_caps, &mut sys.m);
            t.tick = 0;
            let mut o = sink(t, &mut sys.b);
            fresh_line(&mut o);
            let _ = o.write_str("the declared roles are spawned afresh; tick 0");
            o.end_line();
        }
        P::World | P::Route => {
            if p == P::World {
                charge(t, (t.dims.width * t.dims.depth) as u64)?;
                matrix::lay_out_world(&t.dims, &mut sys.m);
            }
            let passes = route(t, sys)?;
            let mut o = sink(t, &mut sys.b);
            fresh_line(&mut o);
            let _ = write!(o, "{}routing fields relaxed in {} passes", if p == P::World { "world laid out; " } else { "" }, passes);
            o.end_line();
        }
        P::Golden => {
            charge(t, GOLDEN_TICKS as u64 * t.locked.capacity as u64)?;
            let proof = matrix::golden(&t.locked, lk.role_counts, lk.role_caps, &mut sys.m);
            t.tick = GOLDEN_TICKS;
            let ok = proof == lk.golden;
            let mut o = sink(t, &mut sys.b);
            fresh_line(&mut o);
            let _ = write!(o, "the scripted run: fingerprint {:#010x}, the build's {:#010x}: ", proof.fingerprint, lk.golden.fingerprint);
            let _ = o.write_str(if ok { "MATCH" } else { "DIFFERENT" });
            o.end_line();
        }
        P::Map => t.map = !t.map,
        P::Mark => {
            let i = pop(t, b)?;
            t.mark = i as u32;
        }
        P::Cfg => {
            charge(t, lk.canonical.len() as u64)?;
            let mut o = sink(t, b);
            fresh_line(&mut o);
            let _ = write!(o, "containment.nix as locked (canonical form, read-only):");
            o.newline();
            let _ = o.write_str(lk.canonical.trim_end());
            o.end_line();
        }
        P::Digest => {
            charge(t, lk.canonical.len() as u64)?;
            let mut out = [0u8; 64];
            let live = hash::sha256(lk.canonical.as_bytes());
            let ok = hash::hex(&live, &mut out) == lk.digest;
            let mut o = sink(t, b);
            fresh_line(&mut o);
            let _ = write!(o, "sha256 {}", core::str::from_utf8(&out).unwrap_or("?"));
            o.newline();
            let _ = o.write_str(if ok { "  = containment.lock: the lock holds" } else { "  differs from containment.lock: THE LOCK IS BROKEN" });
            o.end_line();
        }
        P::Roles => {
            charge(t, (lk.role_names.len() * TERM_COLS) as u64)?;
            let mut o = sink(t, b);
            for (k, name) in lk.role_names.iter().enumerate() {
                fresh_line(&mut o);
                let _ = write!(o, "{:<16} {:>6}  ", name, lk.role_counts.get(k).copied().unwrap_or(0));
                print_caps(&mut o, lk.role_caps.get(k).copied().unwrap_or(0));
            }
                o.end_line();
        }
        P::Params => {
            let (d, l) = (t.dims, t.locked);
            let mut o = sink(t, b);
            fresh_line(&mut o);
            let _ = write!(o, "loop-limit {}  step {}/8  learn-shift {}  explore {}", d.loop_limit, d.step_eighths, d.learn_shift, d.explore);
            o.newline();
            let changed = (d.loop_limit, d.step_eighths, d.learn_shift, d.explore) != (l.loop_limit, l.step_eighths, l.learn_shift, l.explore);
            let _ = o.write_str(if changed { "  (overridden here; locked restores containment.nix)" } else { "  (as containment.nix declares)" });
            o.end_line();
        }
        P::SetLoop => {
            let v = pop(t, b)?;
            t.dims.loop_limit = set_knob(t, b, v, 2, 1_000_000, "loop-limit", "loop-limit is 2 to 1000000")?;
        }
        P::SetStep => {
            let v = pop(t, b)?;
            t.dims.step_eighths = set_knob(t, b, v, 1, 8, "step", "step is 1 to 8 eighths of a cell")?;
        }
        P::SetLearn => {
            let v = pop(t, b)?;
            t.dims.learn_shift = set_knob(t, b, v, 1, 15, "learn-shift", "learn-shift is 1 to 15")?;
        }
        P::SetExplore => {
            let v = pop(t, b)?;
            t.dims.explore = set_knob(t, b, v, 0, 65536, "explore", "explore is 0 to 65536")?;
        }
        P::Locked => {
            t.dims = t.locked;
            let mut o = sink(t, b);
            fresh_line(&mut o);
            let _ = o.write_str("the compute configuration is containment.nix's again");
            o.end_line();
        }
        P::Words => {
            charge(t, b.term_dict.len() as u64)?;
            let mut buf = [0u8; MAX_NAME];
            let mut h = t.latest;
            let mut o = Sink { lines: &mut t.lines, col: &mut t.col, pending: &mut t.pending, text: &mut b.term_text };
            if *o.col > 0 {
                o.newline();
            }
            let mut guard = 0;
            while h >= RESERVED && h < b.term_dict.len() && guard < b.term_dict.len() {
                let n = name_of(&b.term_dict, h, &mut buf);
                if *o.col + n + 1 > TERM_COLS {
                    o.newline();
                }
                for &ch in &buf[..n] {
                    o.put(ch);
                }
                o.put(b' ');
                h = b.term_dict[h] as usize;
                guard += 1;
            }
            for (name, _) in PRIMS.iter().filter(|(n, _)| !n.starts_with(' ')) {
                if *o.col + name.len() + 1 > TERM_COLS {
                    o.newline();
                }
                let _ = write!(o, "{name} ");
            }
            let _ = write!(o, ": ; variable constant create if else then begin until again while repeat do ?do loop");
            let _ = write!(o, " +loop leave recurse exit .\" ( \\");
            o.end_line();
        }
        P::Help => {
            charge(t, (HELP.len() * TERM_COLS) as u64)?;
            let mut o = sink(t, b);
            for line in HELP {
                fresh_line(&mut o);
                let _ = o.write_str(line);
            }
            o.end_line();
        }
        P::Page => {
            t.lines = 0;
            t.col = 0;
            t.scroll = 0;
        }
        P::Cold => {
            t.here = RESERVED;
            t.latest = 0;
            t.base = 10;
            let mut o = sink(t, b);
            fresh_line(&mut o);
            let _ = o.write_str("the dictionary is empty again");
            o.end_line();
        }
        P::Tutorial | P::Reboot | P::Halt => {
            t.request = match p {
                P::Tutorial => Request::Tutorial,
                P::Reboot => Request::Reboot,
                _ => Request::Halt,
            };
        }
        // Control flow is the inner interpreter's.
        _ => return Err(Fault::Corrupt),
    }
    Ok(())
}

/// matrix::route, metered: every pass of the relaxation is charged to the line's budget (a pass updates every cell
/// of every station's field: an eighth of a step each), so a maze that needs more passes than the budget allows ends
/// the line with the budget error instead of holding the machine.
fn route(t: &mut Term, sys: &mut System) -> R<u32> {
    let d = t.dims;
    let m = &mut sys.m;
    let cells = d.width * d.depth;
    m.field.fill(kernels::INF);
    for s in 0..d.stations {
        // Station writes are range-checked, so the index is in the field.
        let home = (m.station[s] as usize).min(cells - 1);
        m.field[s * cells + home] = 0;
    }
    let per_pass = (d.stations * cells / 8).max(1) as u64;
    let mut passes = 0;
    loop {
        charge(t, per_pass)?;
        let changed = kernels::relax_pass(&d, &m.walls, &m.station, &m.field, &mut m.scratch);
        core::mem::swap(&mut m.field, &mut m.scratch);
        passes += 1;
        if changed == 0 || passes as usize >= cells {
            return Ok(passes);
        }
    }
}

/// One tick of the swarm under the terminal's compute configuration.
fn swarm_tick(t: &mut Term, sys: &mut System) {
    let tl = kernels::tick(&t.dims, &mut sys.m, t.tick);
    t.tally.dropped += tl.dropped;
    t.tally.flushed += tl.flushed;
    t.tally.reaped += tl.reaped;
    t.tally.docked += tl.docked;
    t.tick = t.tick.wrapping_add(1);
}

// ---------------------------------------------------------------------------------------------------------------
// Keys, lines, frames

/// Runs a line as if it were typed (the echo, the result, " ok" or the error).
pub fn run_line(t: &mut Term, sys: &mut System, lk: &Locked, line: &str) {
    let bytes = line.as_bytes();
    let n = bytes.len().min(INPUT);
    let mut copy = [0u8; INPUT];
    copy[..n].copy_from_slice(&bytes[..n]);
    {
        let mut o = sink(t, &mut sys.b);
        fresh_line(&mut o);
        let _ = o.write_str("> ");
        for &c in &copy[..n] {
            o.put(c);
        }
        o.newline();
    }
    t.steps = 0;
    let result = interpret(t, sys, lk, &copy[..n]);
    let compiling = t.def != 0;
    let mut o = sink(t, &mut sys.b);
    match result {
        Ok(()) => {
            *o.pending = false;
            let _ = o.write_str(if compiling { " compiled" } else { " ok" });
        }
        Err(f) => {
            if f != Fault::Unknown {
                fresh_line(&mut o);
                let _ = o.write_str("? ");
            }
            let _ = o.write_str(f.message());
            // A failed line leaves nothing half done: the stacks are emptied and an open definition abandoned.
            t.sp = 0;
            t.rp = 0;
            t.nctl = 0;
            if t.def != 0 {
                t.here = t.def;
                t.def = 0;
            }
        }
    }
    t.scroll = 0;
}

/// A key, as the platform read it.
pub fn key(t: &mut Term, sys: &mut System, lk: &Locked, k: u32) {
    let line = &mut sys.b.term_line;
    match k {
        KEY_ENTER => {
            let n = t.input;
            let mut copy = [0u8; INPUT];
            copy[..n].copy_from_slice(&line[..n]);
            if n > 0 {
                // Into the history (newest first).
                line.copy_within(TERM_COLS..TERM_COLS * HISTORY, TERM_COLS * 2);
                line[TERM_COLS..TERM_COLS * 2].fill(b' ');
                line[TERM_COLS..TERM_COLS + n].copy_from_slice(&copy[..n]);
                t.history = (t.history + 1).min(HISTORY);
            }
            line[..TERM_COLS].fill(b' ');
            t.input = 0;
            t.recall = 0;
            let text = core::str::from_utf8(&copy[..n]).unwrap_or("");
            run_line(t, sys, lk, text);
        }
        KEY_BACKSPACE => {
            t.input = t.input.saturating_sub(1);
            line[t.input] = b' ';
        }
        KEY_ESC => {
            line[..TERM_COLS].fill(b' ');
            t.input = 0;
            t.recall = 0;
        }
        KEY_UP | KEY_DOWN => {
            let r = if k == KEY_UP { (t.recall + 1).min(t.history) } else { t.recall.saturating_sub(1) };
            t.recall = r;
            line[..TERM_COLS].fill(b' ');
            t.input = 0;
            if r > 0 {
                let from = TERM_COLS * r;
                let len = line[from..from + TERM_COLS].iter().rposition(|&c| c != b' ').map_or(0, |p| p + 1).min(INPUT);
                line.copy_within(from..from + len, 0);
                t.input = len;
            }
        }
        KEY_PAGE_UP => t.scroll = (t.scroll + 10).min(t.lines.saturating_sub(1)),
        KEY_PAGE_DOWN => t.scroll = t.scroll.saturating_sub(10),
        32..=126 if t.input < INPUT => {
            line[t.input] = k as u8;
            t.input += 1;
        }
        _ => {}
    }
}

/// One frame at `now` (milliseconds): a running swarm ticks at the declared tickHz (at most once a frame).
pub fn frame(t: &mut Term, sys: &mut System, now: u64) {
    t.now = now;
    if t.running && now >= t.next_tick {
        swarm_tick(t, sys);
        let period = 1000 / t.dims.tick_hz.max(1) as u64;
        t.next_tick = (t.next_tick + period).max(now.saturating_sub(period));
    }
}

const BG: u32 = 0x0a0a0e;
const FG: u32 = 0xc8c8cc;
const RED: u32 = 0xe8203a;
const ECHO: u32 = 0xffffff;

/// Draws the terminal into the system's render target.
pub fn render(t: &Term, sys: &mut System, lk: &Locked) {
    let d = &t.dims;
    let (w, h) = (d.display_width, d.display_height);
    let b = &mut sys.b;
    let m = &sys.m;
    let mut tg = Target { pixels: &mut b.color, width: w, height: h, stride: w };
    text::fill(&mut tg, 0, 0, w as i32, h as i32, BG);
    // The header: the name, and the swarm's state.
    text::fill(&mut tg, 0, 0, w as i32, 12, 0x2a0710);
    text::fill(&mut tg, 0, 12, w as i32, 1, RED);
    text::draw(&mut tg, 4, 2, 1, 0xffd0d6, "CRIMSON TERMINAL");
    let alive = m.alive.iter().filter(|&&a| a == 1).count();
    let mut status: Buf<96> = Buf::new();
    let _ = write!(status, "tick {}  alive {}  {}  lock {}", t.tick, alive, if t.running { "RUNNING" } else { "stopped" }, &lk.digest[..8.min(lk.digest.len())]);
    let sw = text::width(status.as_str(), 1);
    text::draw(&mut tg, w as i32 - 4 - sw, 2, 1, 0xd0b0b6, status.as_str());
    // The scrollback, newest at the bottom, above the input line.
    let rows = (h - 16 - 14) / 10;
    let last = t.lines.saturating_sub(t.scroll);
    let first = last.saturating_sub(rows);
    for (k, line) in (first..last).enumerate() {
        let bytes = &b.term_text[line * TERM_COLS..(line + 1) * TERM_COLS];
        let s = core::str::from_utf8(bytes).unwrap_or("");
        let color = match bytes.first() {
            Some(b'>') => ECHO,
            Some(b'?') => RED,
            _ => FG,
        };
        text::draw(&mut tg, 0, 16 + 10 * k as i32, 1, color, s.trim_end());
    }
    // The input line, and a blinking cursor.
    let y = h as i32 - 12;
    text::fill(&mut tg, 0, y - 3, w as i32, 1, 0x3a1018);
    text::draw(&mut tg, 0, y, 1, RED, ">");
    let input = core::str::from_utf8(&b.term_line[..t.input]).unwrap_or("");
    text::draw(&mut tg, 16, y, 1, ECHO, input);
    if (t.now / 500).is_multiple_of(2) {
        text::fill(&mut tg, 16 + 8 * t.input as i32, y, 7, 8, RED);
    }
    if t.scroll > 0 {
        let mut s: Buf<32> = Buf::new();
        let _ = write!(s, "-- {} lines back --", t.scroll);
        text::draw(&mut tg, w as i32 - 4 - text::width(s.as_str(), 1), y, 1, RED, s.as_str());
    }
    if t.map {
        draw_map(t, &mut tg, m, d);
    }
}

/// The floor from above: walls, stations, every live agent; the marked one ringed. It fits a square of at most 128
/// pixels inside the screen (a cell may take several pixels, or a pixel several cells), and every write is clipped.
fn draw_map(t: &Term, tg: &mut Target, m: &matrix::Matrix, d: &Dims) {
    let side = 128.min(tg.height as i32 - 40).min(tg.width as i32 / 3).max(16);
    let (cw, cd) = (d.width as i32, d.depth as i32);
    let (mw, mh) = (side * cw / cw.max(cd), side * cd / cw.max(cd));
    let (x0, y0) = (tg.width as i32 - mw - 8, 20);
    // Cell (x, z) and its far corner, in pixels.
    let at = |x: i32, z: i32| (x0 + x * mw / cw, y0 + z * mh / cd);
    text::fill(tg, x0 - 3, y0 - 3, mw + 6, mh + 6, RED);
    text::fill(tg, x0 - 2, y0 - 2, mw + 4, mh + 4, 0x050507);
    for c in 0..(d.width * d.depth) {
        if m.walls[c] & 1 != 0 {
            let (x, z) = ((c % d.width) as i32, (c / d.width) as i32);
            let ((ax, az), (bx, bz)) = (at(x, z), at(x + 1, z + 1));
            text::fill(tg, ax, az, (bx - ax).max(1), (bz - az).max(1), 0x2c2e36);
        }
    }
    for &s in &m.station {
        let (x, z) = ((s as usize % d.width) as i32, (s as usize / d.width) as i32);
        let (ax, az) = at(x, z);
        text::fill(tg, ax - 1, az - 1, 3, 3, RED);
    }
    // A position (eighths of a cell) in pixels, inside the map.
    let spot = |i: usize| {
        let x = (eighths(m.px[i]) as i64 * mw as i64 / (cw as i64 * 8)).clamp(0, mw as i64 - 1) as i32;
        let z = (eighths(m.pz[i]) as i64 * mh as i64 / (cd as i64 * 8)).clamp(0, mh as i64 - 1) as i32;
        (x0 + x, y0 + z)
    };
    for i in 0..m.alive.len() {
        if m.alive[i] != 1 {
            continue;
        }
        let rgb = match m.role[i] {
            0 => 0xe0283c,
            1 => 0xd89a2a,
            _ => 0xffffff,
        };
        let (x, z) = spot(i);
        text::fill(tg, x, z, 1, 1, rgb);
    }
    if (t.mark as usize) < m.alive.len() {
        let i = t.mark as usize;
        let (x, z) = spot(i);
        let rgb = if m.alive[i] == 1 { 0xffffff } else { scale(0xffffff, 90) };
        text::fill(tg, x - 4, z, 3, 1, rgb);
        text::fill(tg, x + 2, z, 3, 1, rgb);
        text::fill(tg, x, z - 4, 1, 3, rgb);
        text::fill(tg, x, z + 2, 1, 3, rgb);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Dims;
    use crate::hash::mix32;
    use crate::tests::allocations;
    use crate::tutorial::tests::setup;
    use std::string::String;
    use std::vec::Vec;

    fn term() -> (Term, System, Locked, Dims) {
        let (d, lk, _, mut sys) = setup();
        matrix::golden_begin(&d, lk.role_counts, lk.role_caps, &mut sys.m);
        let t = open(&mut sys, &d, &lk);
        (t, sys, lk, d)
    }

    /// The scrollback as text, one line per line, trailing spaces trimmed.
    fn screen(t: &Term, sys: &System) -> Vec<String> {
        (0..t.lines)
            .map(|k| String::from_utf8_lossy(&sys.b.term_text[k * TERM_COLS..(k + 1) * TERM_COLS]).trim_end().into())
            .collect()
    }

    /// Runs `line` on a cleared screen and returns what it printed after the echo, lines joined by '|'.
    fn say(t: &mut Term, sys: &mut System, lk: &Locked, line: &str) -> String {
        t.lines = 0;
        t.col = 0;
        run_line(t, sys, lk, line);
        let s = screen(t, sys);
        assert_eq!(s[0], std::format!("> {line}").trim_end(), "the echo");
        s[1..].join("|")
    }

    #[test]
    fn it_is_a_forth() {
        let (mut t, mut sys, lk, _) = term();
        let mut ask = |line: &str| say(&mut t, &mut sys, &lk, line);
        assert_eq!(ask("2 3 + ."), "5  ok");
        assert_eq!(ask("7 2 /mod . . -7 2 / ."), "3 1 -3  ok");
        assert_eq!(ask("1 2 3 rot .s clear"), "<3> 2 3 1  ok");
        assert_eq!(ask("hex ff 1+ . decimal 10 ."), "100 10  ok");
        assert_eq!(ask("$ff %101 'a' -5 . . . ."), "-5 97 5 255  ok");
        assert_eq!(ask("3 4 < . 3 4 > . -1 0< . 5 0= ."), "-1 0 -1 0  ok");
        assert_eq!(ask(": sq dup * ;"), " ok");
        assert_eq!(ask("7 sq ."), "49  ok");
        assert_eq!(ask(": fact dup 1 > if dup 1- recurse * then ;"), " ok");
        assert_eq!(ask("10 fact ."), "3628800  ok");
        assert_eq!(ask("5 0 do i . loop"), "0 1 2 3 4  ok");
        assert_eq!(ask("3 3 ?do i . loop 0 10 do i . -3 +loop"), "10 7 4 1  ok");
        assert_eq!(ask("10 0 do i dup . 3 = if leave then loop"), "0 1 2 3  ok");
        assert_eq!(ask("3 0 do 2 0 do j . i . loop loop"), "0 0 0 1 1 0 1 1 2 0 2 1  ok");
        assert_eq!(ask("0 1 begin dup 100 < while dup . swap over + repeat 2drop"), "1 1 2 3 5 8 13 21 34 55 89  ok");
        assert_eq!(ask("1 begin 2* dup 1000 > until ."), "1024  ok");
        assert_eq!(ask("variable x 41 x ! 1 x +! x @ ."), "42  ok");
        assert_eq!(ask("12 constant dozen dozen dozen * ."), "144  ok");
        assert_eq!(ask("create row 4 allot 9 row 2 + ! row 2 + @ . row 3 + @ ."), "9 0  ok");
        assert_eq!(ask(".\" hello, operator\" cr 1 ."), "hello, operator|1  ok");
        assert_eq!(ask("5 ( a comment ) 6 + . \\ the rest is ignored"), "11  ok");
        // A definition may span lines; the line says so.
        assert_eq!(ask(": tri 0 swap 1+ 1 do"), " compiled");
        assert_eq!(ask("i + loop ;"), " ok");
        assert_eq!(ask("100 tri ."), "5050  ok");
    }

    #[test]
    fn a_bad_program_is_an_error_message_never_a_crash() {
        let (mut t, mut sys, lk, _) = term();
        let mut ask = |line: &str| say(&mut t, &mut sys, &lk, line);
        assert_eq!(ask("1 0 /"), "? division by zero");
        assert_eq!(ask("1 2 fizz 3"), "? fizz: no such word");
        assert_eq!(ask("drop"), "? stack underflow");
        assert_eq!(ask("begin again"), "? step budget spent: loop broken (terminal.stepBudget)");
        assert_eq!(ask(": down recurse ; down"), "? return stack overflow or underflow (too deep, or an unbalanced >r r>)");
        assert_eq!(ask("1 if 2"), "? an IF, BEGIN or DO is still open at the end of the line");
        assert_eq!(ask("then"), "? THEN without IF");
        assert_eq!(ask(": a : b ;"), "? a : inside a definition");
        assert_eq!(ask("300 0 do i loop"), "? stack overflow (the declared depth)");
        assert_eq!(ask("-5 @"), "? address outside the dictionary");
        assert_eq!(ask("5 >r"), "? return stack overflow or underflow (too deep, or an unbalanced >r r>)");
        assert_eq!(ask(": waytoolongnameforaword ;"), "? a name is 1 to 16 characters");
        // After every error the stacks are empty and nothing half-defined is left behind.
        assert_eq!(ask("1 2 3 : half 1 fizz"), "? fizz: no such word");
        assert_eq!(ask("depth ."), "0  ok");
        assert_eq!(ask("half"), "? half: no such word");
    }

    #[test]
    fn its_words_reach_the_raw_arrays_and_containment_still_holds() {
        let (mut t, mut sys, lk, d) = term();
        let mut ask = |line: &str| say(&mut t, &mut sys, &lk, line);
        assert_eq!(ask("px #a . alive #a . walls #a . 1 alive count-a ."), "4096 4096 4096 4096  ok");
        assert_eq!(ask("17 caps @a . 4095 role @a ."), "15 2  ok");
        // Positions are eighths of a cell, kept on the floor.
        assert_eq!(ask("100 17 px !a 17 px @a . 9999 17 px !a 17 px @a ."), "100 511  ok");
        // The declared privileges cannot be changed from here.
        assert_eq!(ask("31 17 caps !a"), "? caps and role are declared in containment.nix: read-only (ask requests)");
        assert_eq!(ask("0 17 role !a"), "? caps and role are declared in containment.nix: read-only (ask requests)");
        assert_eq!(ask("5000 0 station !a"), "? a station is a cell index: 0 to width x depth - 1");
        assert_eq!(ask("4096 alive @a"), "? index outside the array");
        // A privilege asked for on an agent's behalf: the next tick drops its pointer, the tick after zeroes its row.
        assert_eq!(ask("cap-spawn 17 ask"), "agent 17 asks for spawn: never declared, so its pointer drops next tick ok");
        assert_eq!(ask("1 tick 17 alive @a . 17 doomed @a ."), "0 1  ok");
        assert_eq!(ask("1 tick 17 agent"), "agent 17: an empty slot (its row is all zero) ok");
        // A privilege inside the role is no violation.
        assert_eq!(ask("cap-move 18 ask 1 tick 18 alive @a ."), "agent 18 asks for move: declared, no violation|1  ok");
        // 1/0 masks: kill a block of the pool by its doomed mask, and count.
        // Agent 17 is already gone, so 99 more go: 4096 - 1 - 99.
        assert_eq!(ask("100 0 do 1 i doomed !a loop 1 tick 1 alive count-a ."), "3996  ok");
        // The kernels' knobs move only within the validator's ranges, and the lock can be checked live.
        assert_eq!(ask("1 loop-limit!"), "? loop-limit is 2 to 1000000");
        let s = ask("50 loop-limit! params");
        assert!(s.contains("loop-limit 50") && s.contains("overridden"), "{s}");
        let s = ask("locked params");
        assert!(s.contains(&std::format!("loop-limit {}", d.loop_limit)) && s.contains("as containment.nix declares"), "{s}");
        let s = ask("digest");
        assert!(s.contains(lk.digest) && s.contains("the lock holds"), "{s}");
        let s = ask("golden");
        assert!(s.ends_with("MATCH ok"), "{s}");
        assert_eq!(ask("ticks ."), "600  ok");
        // The step budget meters the kernels too: a tick costs a step per slot.
        assert_eq!(ask("100000 tick"), "? step budget spent: loop broken (terminal.stepBudget)");
        let s = ask("cfg");
        assert!(s.contains("pool.capacity = 4096;"), "{s}");
        assert_eq!(ask("tutorial"), " ok");
        assert_eq!(t.request, Request::Tutorial);
    }

    /// Rule 110, a cellular automaton proved universal (Cook, 2004), written in the terminal and checked cell for cell
    /// against the same rule in Rust: the terminal is a real programming language over its declared memory.
    #[test]
    fn it_runs_rule_110() {
        let (mut t, mut sys, lk, _) = term();
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
            assert_eq!(say(&mut t, &mut sys, &lk, line), " ok", "{line}");
        }
        t.lines = 0;
        t.col = 0;
        let before = allocations();
        run_line(&mut t, &mut sys, &lk, "24 gens");
        assert_eq!(allocations(), before, "the program allocated");
        let lines = screen(&t, &sys);
        let got: Vec<&str> = lines[1..].iter().map(|s| s.as_str()).collect();
        let mut row = [0u8; 64];
        row[63] = 1;
        for (g, line) in got.iter().take(24).enumerate() {
            let want: String = row.iter().map(|&c| if c == 1 { '#' } else { '.' }).collect();
            assert_eq!(*line, want, "generation {g}");
            let mut next = [0u8; 64];
            for i in 0..64 {
                let pattern = (row[(i + 63) % 64] << 2) | (row[i] << 1) | row[(i + 1) % 64];
                next[i] = (110 >> pattern) & 1;
            }
            row = next;
        }
        assert_eq!(got[24], " ok");
    }

    /// The review's findings, each as it was reproduced: a full floor of walls hung `respawn`; a mask written as -1
    /// or 2 overflowed the kernel or half-wiped a row (rewriting the read-only caps and role); `route` on a long maze
    /// held the machine past the step budget; a BEGIN before a definition compiled it into the line's code.
    #[test]
    fn the_reviewed_holes_stay_closed() {
        let (mut t, mut sys, lk, _) = term();
        let mut ask = |line: &str| say(&mut t, &mut sys, &lk, line);
        assert_eq!(ask("1 walls fill-a respawn 1 tick"), "the declared roles are spawned afresh; tick 0 ok");
        assert_eq!(ask("2 walls fill-a"), "? alive, doomed and walls are 1/0 masks: write 0 or 1");
        assert_eq!(ask("-1 0 alive !a"), "? alive, doomed and walls are 1/0 masks: write 0 or 1");
        assert_eq!(ask("2 18 doomed !a"), "? alive, doomed and walls are 1/0 masks: write 0 or 1");
        assert_eq!(ask("-2 4095 doomed !a"), "? alive, doomed and walls are 1/0 masks: write 0 or 1");
        assert_eq!(ask("begin : foo again ;"), "? finish the IF, BEGIN or DO before defining a word");
        assert_eq!(ask("1 if variable v then"), "? finish the IF, BEGIN or DO before defining a word");
        assert_eq!(
            ask("world respawn 18 caps @a . 4095 role @a ."),
            "world laid out; routing fields relaxed in 118 passes|the declared roles are spawned afresh; tick 0|15 2  ok"
        );
        // A serpentine maze: every other row walled across, the gap at alternating ends. Its paths are about 1,800
        // cells long, more passes than one line's budget pays for: the line ends, the machine does not hang.
        for line in [
            ": gap 4 mod if 1 else 62 then ;",
            ": wall! cell 1 swap walls !a ;",
            ": row dup gap swap 63 1 do over i <> if i over wall! then loop 2drop ;",
            ": maze 61 2 do i row 2 +loop ;",
        ] {
            assert_eq!(ask(line), " ok", "{line}");
        }
        assert_eq!(ask("maze route"), "? step budget spent: loop broken (terminal.stepBudget)");
        assert_eq!(ask("world"), "world laid out; routing fields relaxed in 118 passes ok");
    }

    #[test]
    fn a_large_floor_on_a_small_screen_draws_its_map_inside_the_screen() {
        let src = include_str!("../../../containment.nix")
            .replace("width = 64;", "width = 256;")
            .replace("depth = 64;", "depth = 256;")
            .replace("width = 640;", "width = 320;")
            .replace("height = 360;", "height = 200;");
        let c = crate::config::validate(&crate::config::parse(&src).unwrap()).unwrap();
        let d = c.dims;
        assert_eq!((d.width, d.depth, d.display_width, d.display_height), (256, 256, 320, 200));
        let (_, lk, _, _) = setup();
        let mut sys = crate::system::allocate(&d);
        matrix::golden_begin(&d, lk.role_counts, lk.role_caps, &mut sys.m);
        let mut t = open(&mut sys, &d, &lk);
        run_line(&mut t, &mut sys, &lk, "map 100 mark");
        assert!(t.map);
        render(&t, &mut sys, &lk);
    }

    /// `flush` zeroes exactly the named agent's block while the swarm runs, keeps containment, and bounds its index.
    #[test]
    fn flush_zeroes_one_agents_block_and_nothing_else() {
        let (mut t, mut sys, lk, d) = term();
        let mut ask = |line: &str| say(&mut t, &mut sys, &lk, line);
        // A live hex bitmask edit, then a flush of the same agent while running.
        assert_eq!(ask("$ff 300 heading !a 300 heading @a ."), "255  ok");
        assert_eq!(ask("go 300 flush"), "the swarm runs, a tick a frame (stop stops it)|agent 300 flushed: its row, weights and memory block are zero ok");
        assert_eq!(ask("300 alive @a . 300 heading @a . 300 caps @a ."), "0 0 0  ok");
        // Its neighbours are untouched.
        assert_eq!(ask("301 alive @a . 299 alive @a ."), "1 1  ok");
        // The index is bounds-checked; a flush cannot grant a privilege (it only clears).
        assert_eq!(ask("4096 flush"), "? index outside the array");
        assert_eq!(ask("-1 flush"), "? index outside the array");
        // After a flush the row reads as an empty slot, and a tick leaves it empty.
        assert_eq!(ask("1 tick 300 agent"), "agent 300: an empty slot (its row is all zero) ok");
        let _ = d;
    }

    /// The help's example agent is alive after the self-test's scripted run (the state the terminal opens in).
    #[test]
    fn the_help_example_works_where_the_terminal_opens() {
        let (mut t, mut sys, lk, d) = term();
        matrix::golden(&d, lk.role_counts, lk.role_caps, &mut sys.m);
        assert!(HELP.iter().any(|l| l.contains("cap-spawn 5 ask 1 tick 5 agent")));
        assert_eq!(say(&mut t, &mut sys, &lk, "5 alive @a ."), "1  ok");
        let s = say(&mut t, &mut sys, &lk, "cap-spawn 5 ask 1 tick 5 agent");
        assert!(s.starts_with("agent 5 asks for spawn: never declared"), "{s}");
        assert!(s.contains("alive 0  doomed 1"), "{s}");
        assert_eq!(say(&mut t, &mut sys, &lk, "1 tick 5 agent"), "agent 5: an empty slot (its row is all zero) ok");
    }

    #[test]
    fn keys_edit_recall_and_scroll() {
        let (mut t, mut sys, lk, _) = term();
        for k in "1 2 +x".bytes() {
            key(&mut t, &mut sys, &lk, k as u32);
        }
        key(&mut t, &mut sys, &lk, KEY_BACKSPACE);
        for k in " .".bytes() {
            key(&mut t, &mut sys, &lk, k as u32);
        }
        key(&mut t, &mut sys, &lk, KEY_ENTER);
        let s = screen(&t, &sys);
        assert_eq!(&s[s.len() - 2..], ["> 1 2 + .", "3  ok"]);
        key(&mut t, &mut sys, &lk, KEY_UP);
        assert_eq!(&sys.b.term_line[..t.input], b"1 2 + .");
        key(&mut t, &mut sys, &lk, KEY_ENTER);
        let s = screen(&t, &sys);
        assert_eq!(s.last().unwrap(), "3  ok");
        key(&mut t, &mut sys, &lk, KEY_PAGE_UP);
        assert!(t.scroll > 0);
        key(&mut t, &mut sys, &lk, KEY_ESC);
        assert_eq!(t.input, 0);
        // The scrollback keeps its declared lines, dropping the oldest.
        for _ in 0..400 {
            run_line(&mut t, &mut sys, &lk, "1 .");
        }
        assert_eq!(t.lines, sys.b.term_text.len() / TERM_COLS);
    }

    /// Thousands of random lines over the whole vocabulary, writes to random addresses included: errors, never a
    /// panic, and never an allocation.
    #[test]
    fn random_programs_never_crash_or_allocate() {
        let (mut t, mut sys, lk, _) = term();
        let vocab = [
            "1", "0", "-1", "7", "300", "65535", "-99999", "dup", "drop", "swap", "over", "rot", "pick", "+", "-", "*",
            "/", "mod", "/mod", "*/", "and", "or", "invert", "lshift", "rshift", "=", "<", "0=", "@", "!", "+!", ",",
            "here", "allot", ">r", "r>", "r@", "i", "j", "unloop", ".", ".s", "emit", "cr", "spaces", "hex", "decimal",
            "if", "else", "then", "begin", "until", "again", "while", "repeat", "do", "?do", "loop", "+loop", "leave",
            "exit", "recurse", ":", ";", "foo", "variable", "constant", "create", "px", "alive", "walls", "station",
            "memory", "caps", "@a", "!a", "#a", "count-a", "ask", "cell", "xz", "agent", "mark", "map", ".\"", "(",
            "\\", "words", "page", "cold", "stats", "params", "locked", "go", "stop", "1 tick", "help", "digest",
        ];
        let mut seed = 0x5eed_u32;
        let mut line = String::with_capacity(INPUT + 16);
        let before = allocations();
        for _ in 0..3000 {
            line.clear();
            let n = 1 + mix32(seed) % 12;
            for _ in 0..n {
                seed = mix32(seed.wrapping_add(0x9e37_79b9));
                let w = vocab[seed as usize % vocab.len()];
                if line.len() + w.len() + 1 >= INPUT {
                    break;
                }
                line.push_str(w);
                line.push(' ');
            }
            let a0 = allocations();
            run_line(&mut t, &mut sys, &lk, &line);
            frame(&mut t, &mut sys, 20 * seed as u64 % 100_000);
            assert_eq!(allocations(), a0, "{line}");
            assert!(t.sp <= sys.b.term_stack.len() && t.rp <= sys.b.term_rstack.len());
        }
        render(&t, &mut sys, &lk);
        assert_eq!(allocations(), before, "the terminal allocated");
    }

    /// Writes the terminal after a short session as a PPM into $NOIR_PREVIEW (a development aid; ignored by default).
    #[test]
    #[ignore]
    fn preview_the_terminal() {
        let Ok(dir) = std::env::var("NOIR_PREVIEW") else { return };
        let (mut t, mut sys, lk, d) = term();
        for line in ["help", "cap-spawn 17 ask 1 tick 17 agent", ": sq dup * ;", "10 0 do i sq . loop", "digest", "stats", "map 42 mark go"] {
            run_line(&mut t, &mut sys, &lk, line);
        }
        for k in "1 2 + .".bytes() {
            key(&mut t, &mut sys, &lk, k as u32);
        }
        for f in 0..40 {
            frame(&mut t, &mut sys, f * 17);
        }
        render(&t, &mut sys, &lk);
        let (w, h) = (d.display_width, d.display_height);
        let mut out = std::format!("P6\n{w} {h}\n255\n").into_bytes();
        for &p in &sys.b.color {
            out.extend_from_slice(&[(p >> 16) as u8, (p >> 8) as u8, p as u8]);
        }
        std::fs::write(std::format!("{dir}/terminal.ppm"), out).unwrap();
    }

    #[test]
    fn it_draws_without_allocating() {
        let (mut t, mut sys, lk, _) = term();
        run_line(&mut t, &mut sys, &lk, "help 17 mark");
        let before = allocations();
        for f in 0..3 {
            frame(&mut t, &mut sys, f * 17);
            render(&t, &mut sys, &lk);
        }
        assert_eq!(allocations(), before);
        // The header bar is drawn in the declared target.
        assert_eq!(sys.b.color[0], 0x2a0710);
    }
}
