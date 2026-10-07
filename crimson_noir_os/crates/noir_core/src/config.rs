//! Why does this file exist? It is the containment matrix's declarative half. `containment.nix` declares everything
//! the system may hold: the size of the agent pool, every allocation (the arena and the layout carved from it), the
//! privileges of each role, the loop breaker's limit, the kernel parameters, the display and the terminal, and the
//! crates the bootable image may link. This module parses that file (a strict subset of the Nix language: attribute
//! sets, dotted attribute paths, lists, strings, integers, booleans, `#` comments; no functions, no imports, no
//! interpolation), refuses anything outside the rules below (an unknown key, an undeclared capability, a pool that is
//! not a power of two, a network switched on, a layout that does not fit the arena), reduces it to a canonical form,
//! locks that form with SHA-256 against `containment.lock`, and emits the Rust tables the system is compiled with
//! (`generate`, called by the build scripts). Changing a privilege is a rebuild with a new lock, never a runtime switch.
//! What breaks if it is removed? The kernels would have no declared bounds: the pool, the privileges and the memory
//! the system may touch would be whatever the code happened to allocate.

use alloc::format;
use alloc::string::{String, ToString};
use alloc::vec::Vec;

use crate::hash::{hex, sha256};

/// The privileges that exist, one bit each. Nothing else can be declared, requested or held: there is no network
/// bit, no device bit, no file bit. An agent that asks for any other bit (or for one its role was not given) has
/// its pointer dropped.
pub const CAPABILITIES: [&str; 5] = ["move", "route", "learn", "memory", "spawn"];
pub const CAP_MOVE: u32 = 1;
pub const CAP_ROUTE: u32 = 2;
pub const CAP_LEARN: u32 = 4;
pub const CAP_MEMORY: u32 = 8;
pub const CAP_SPAWN: u32 = 16;

/// The text columns of the terminal's scrollback (a line is this many bytes).
pub const TERM_COLS: usize = 80;
/// The smallest terminal dictionary: the typed line's code area (1,024 cells) and room for definitions.
pub const TERM_MIN_CELLS: usize = 2048;

// -------------------------------------------------------------------------------------------------------------------
// The Nix subset

#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    Set(Vec<(String, Value)>),
    List(Vec<Value>),
    Str(String),
    Int(i64),
    Bool(bool),
}

struct Cursor<'a> {
    s: &'a [u8],
    i: usize,
    line: u32,
    col: u32,
    depth: u32,
}

const MAX_DEPTH: u32 = 32;

fn fail<T>(c: &Cursor, msg: &str) -> Result<T, String> {
    Err(format!("containment.nix:{}:{}: {}", c.line, c.col, msg))
}

fn peek(c: &Cursor) -> Option<u8> {
    c.s.get(c.i).copied()
}

fn bump(c: &mut Cursor) {
    if peek(c) == Some(b'\n') {
        c.line += 1;
        c.col = 1;
    } else {
        c.col += 1;
    }
    c.i += 1;
}

fn skip(c: &mut Cursor) {
    while let Some(b) = peek(c) {
        if b == b'#' {
            while peek(c).is_some_and(|b| b != b'\n') {
                bump(c);
            }
        } else if b.is_ascii_whitespace() {
            bump(c);
        } else {
            return;
        }
    }
}

fn expect(c: &mut Cursor, want: u8) -> Result<(), String> {
    skip(c);
    if peek(c) == Some(want) {
        bump(c);
        Ok(())
    } else {
        fail(c, &format!("expected '{}'", want as char))
    }
}

fn ident(c: &mut Cursor) -> Result<String, String> {
    skip(c);
    let start = c.i;
    match peek(c) {
        Some(b) if b.is_ascii_alphabetic() || b == b'_' => {}
        _ => return fail(c, "expected a name"),
    }
    while peek(c).is_some_and(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'\'') {
        bump(c);
    }
    Ok(String::from_utf8_lossy(&c.s[start..c.i]).into_owned())
}

fn string(c: &mut Cursor) -> Result<String, String> {
    bump(c); // the opening quote
    let mut out = String::new();
    loop {
        match peek(c) {
            None => return fail(c, "a string is not closed"),
            Some(b'"') => {
                bump(c);
                return Ok(out);
            }
            Some(b'$') if c.s.get(c.i + 1) == Some(&b'{') => {
                return fail(c, "interpolation is not part of the declarative subset");
            }
            Some(b'\\') => {
                bump(c);
                let e = match peek(c) {
                    Some(b'"') => '"',
                    Some(b'\\') => '\\',
                    Some(b'n') => '\n',
                    Some(b't') => '\t',
                    Some(b'$') => '$',
                    _ => return fail(c, "unknown escape in a string"),
                };
                bump(c);
                out.push(e);
            }
            Some(b'\n') => return fail(c, "a string may not span lines"),
            Some(_) => {
                // Copy one UTF-8 character whole.
                let rest = core::str::from_utf8(&c.s[c.i..]).map_err(|_| String::from("not UTF-8"))?;
                let ch = rest.chars().next().unwrap_or('\u{fffd}');
                for _ in 0..ch.len_utf8() {
                    bump(c);
                }
                out.push(ch);
            }
        }
    }
}

fn integer(c: &mut Cursor) -> Result<i64, String> {
    let negative = peek(c) == Some(b'-');
    if negative {
        bump(c);
    }
    if !peek(c).is_some_and(|b| b.is_ascii_digit()) {
        return fail(c, "expected a number");
    }
    let mut v: i64 = 0;
    while let Some(d) = peek(c).filter(|b| b.is_ascii_digit()) {
        v = match v.checked_mul(10).and_then(|v| v.checked_add((d - b'0') as i64)) {
            Some(v) => v,
            None => return fail(c, "a number is too large"),
        };
        bump(c);
    }
    if peek(c).is_some_and(|b| b == b'.' || b.is_ascii_alphabetic()) {
        return fail(c, "only whole numbers are part of the declarative subset");
    }
    Ok(if negative { -v } else { v })
}

/// Puts `value` at `path` inside `set`, merging dotted paths the way Nix does (`a.b = 1; a.c = 2;`).
fn insert(c: &Cursor, set: &mut Vec<(String, Value)>, path: &[String], value: Value) -> Result<(), String> {
    let (head, rest) = (&path[0], &path[1..]);
    let found = set.iter_mut().position(|(k, _)| k == head);
    if rest.is_empty() {
        return match (found, value) {
            (None, value) => {
                set.push((head.clone(), value));
                Ok(())
            }
            // `a.b = 1;` then `a = { c = 2; };`: two sets under one name merge.
            (Some(k), Value::Set(more)) => match &mut set[k].1 {
                Value::Set(existing) => {
                    for (key, v) in more {
                        insert(c, existing, &[key], v)?;
                    }
                    Ok(())
                }
                _ => fail(c, &format!("'{}' is declared twice", head)),
            },
            (Some(_), _) => fail(c, &format!("'{}' is declared twice", head)),
        };
    }
    let k = match found {
        Some(k) => k,
        None => {
            set.push((head.clone(), Value::Set(Vec::new())));
            set.len() - 1
        }
    };
    match &mut set[k].1 {
        Value::Set(inner) => insert(c, inner, rest, value),
        _ => fail(c, &format!("'{}' is not an attribute set", head)),
    }
}

fn value(c: &mut Cursor) -> Result<Value, String> {
    skip(c);
    c.depth += 1;
    if c.depth > MAX_DEPTH {
        return fail(c, "nested too deeply");
    }
    let v = match peek(c) {
        Some(b'{') => {
            bump(c);
            let mut set = Vec::new();
            loop {
                skip(c);
                if peek(c) == Some(b'}') {
                    bump(c);
                    break;
                }
                let mut path = Vec::from([ident(c)?]);
                skip(c);
                while peek(c) == Some(b'.') {
                    bump(c);
                    path.push(ident(c)?);
                    skip(c);
                    // A dotted path nests one set per segment: it is bounded as nesting is.
                    if path.len() + c.depth as usize > MAX_DEPTH as usize {
                        return fail(c, "nested too deeply");
                    }
                }
                expect(c, b'=')?;
                let v = value(c)?;
                expect(c, b';')?;
                insert(c, &mut set, &path, v)?;
            }
            Value::Set(set)
        }
        Some(b'[') => {
            bump(c);
            let mut list = Vec::new();
            loop {
                skip(c);
                if peek(c) == Some(b']') {
                    bump(c);
                    break;
                }
                list.push(value(c)?);
            }
            Value::List(list)
        }
        Some(b'"') => Value::Str(string(c)?),
        Some(b) if b == b'-' || b.is_ascii_digit() => Value::Int(integer(c)?),
        Some(b) if b.is_ascii_alphabetic() => match ident(c)?.as_str() {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            other => return fail(c, &format!("'{}' is not a value of the declarative subset", other)),
        },
        Some(_) => return fail(c, "unexpected character"),
        None => return fail(c, "the file ends early"),
    };
    c.depth -= 1;
    Ok(v)
}

/// Parses the Nix subset into a value tree.
pub fn parse(src: &str) -> Result<Value, String> {
    let mut c = Cursor { s: src.as_bytes(), i: 0, line: 1, col: 1, depth: 0 };
    let v = value(&mut c)?;
    skip(&mut c);
    if c.i < c.s.len() {
        return fail(&c, "text after the configuration");
    }
    Ok(v)
}

// -------------------------------------------------------------------------------------------------------------------
// The rules

/// One declared role: its name, how many agents the pool holds of it, and the only privileges they hold.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Role {
    pub name: String,
    pub count: u32,
    pub caps: u32,
}

/// The validated configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Config {
    pub name: String,
    pub version: String,
    pub tick_hz: u32,
    pub seed: u32,
    pub dims: Dims,
    pub network: bool,
    pub roles: Vec<Role>,
    pub dependencies: Vec<String>,
}

/// Every size and parameter the kernels, the display and the terminal are bound by: plain integers, so the build
/// scripts can emit them as one constant.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Dims {
    /// Agent slots in the pool (a power of two).
    pub capacity: usize,
    /// Words in each agent's private memory block (a power of two).
    pub block_words: usize,
    /// Routing stations; also the learned preferences per agent (a power of two).
    pub stations: usize,
    /// The floor, in cells (powers of two).
    pub width: usize,
    pub depth: usize,
    /// Identical failure states in a row before an index is flushed.
    pub loop_limit: u32,
    /// Cells moved per tick, in eighths.
    pub step_eighths: u32,
    /// The learning rate is 1 / 2^learn_shift.
    pub learn_shift: u32,
    /// The exploration noise added to a station's learned weight (Q16.16).
    pub explore: u32,
    pub seed: u32,
    pub tick_hz: u32,
    /// The internal render target, in pixels.
    pub display_width: usize,
    pub display_height: usize,
    /// The most triangles the scene may hold.
    pub triangles: usize,
    /// The terminal: dictionary cells, data stack depth, steps one command line may take, scrollback lines.
    pub term_cells: usize,
    pub term_stack: usize,
    pub term_steps: u32,
    pub term_lines: usize,
    /// Everything the system may allocate, in bytes.
    pub arena_bytes: usize,
}

type Set = [(String, Value)];

fn lookup<'a>(set: &'a Set, key: &str) -> Option<&'a Value> {
    set.iter().find(|(k, _)| k == key).map(|(_, v)| v)
}

fn need<'a>(set: &'a Set, key: &str, path: &str) -> Result<&'a Value, String> {
    lookup(set, key).ok_or_else(|| format!("{}{} is not declared", path, key))
}

fn only(set: &Set, allowed: &[&str], path: &str) -> Result<(), String> {
    for (k, _) in set {
        if !allowed.contains(&k.as_str()) {
            return Err(format!("{}{} is not part of the configuration (allowed here: {})", path, k, allowed.join(", ")));
        }
    }
    Ok(())
}

fn as_set<'a>(v: &'a Value, path: &str) -> Result<&'a Set, String> {
    match v {
        Value::Set(s) => Ok(s),
        _ => Err(format!("{} must be an attribute set", path)),
    }
}

fn int(set: &Set, key: &str, path: &str, lo: i64, hi: i64) -> Result<i64, String> {
    match need(set, key, path)? {
        Value::Int(n) if (lo..=hi).contains(n) => Ok(*n),
        Value::Int(n) => Err(format!("{}{} must be between {} and {} (got {})", path, key, lo, hi, n)),
        _ => Err(format!("{}{} must be a whole number", path, key)),
    }
}

fn pow2(set: &Set, key: &str, path: &str, lo: i64, hi: i64) -> Result<usize, String> {
    let n = int(set, key, path, lo, hi)?;
    if (n as u64).is_power_of_two() {
        Ok(n as usize)
    } else {
        Err(format!("{}{} must be a power of two (got {})", path, key, n))
    }
}

fn text(set: &Set, key: &str, path: &str) -> Result<String, String> {
    match need(set, key, path)? {
        // Graphic ASCII, less the three bytes the subset's strings give meaning to (a quote, a backslash, a dollar), so
        // the canonical form writes every name unescaped and parses back to it.
        Value::Str(s) if !s.is_empty() && s.len() <= 32 && s.bytes().all(|b| b.is_ascii_graphic() && !matches!(b, b'"' | b'\\' | b'$')) => Ok(s.clone()),
        _ => Err(format!("{}{} must be a short printable string", path, key)),
    }
}

fn names(v: &Value, path: &str) -> Result<Vec<String>, String> {
    let Value::List(items) = v else { return Err(format!("{} must be a list of strings", path)) };
    let mut out: Vec<String> = Vec::new();
    for item in items {
        let Value::Str(s) = item else { return Err(format!("{} must be a list of strings", path)) };
        if out.contains(s) {
            return Err(format!("{} names \"{}\" twice", path, s));
        }
        out.push(s.clone());
    }
    Ok(out)
}

/// The capability mask of a list of capability names; an unknown name is refused.
pub fn caps_of(list: &[String], path: &str) -> Result<u32, String> {
    let mut mask = 0;
    for name in list {
        match CAPABILITIES.iter().position(|c| c == name) {
            Some(bit) => mask |= 1 << bit,
            None => {
                return Err(format!(
                    "{} names \"{}\", which is not a capability of this system (the only ones are: {})",
                    path,
                    name,
                    CAPABILITIES.join(", ")
                ));
            }
        }
    }
    Ok(mask)
}

/// The names of the capabilities in `mask`, in bit order.
pub fn cap_names(mask: u32) -> Vec<&'static str> {
    CAPABILITIES.iter().enumerate().filter(|(bit, _)| mask & (1 << bit) != 0).map(|(_, n)| *n).collect()
}

/// Validates a parsed configuration against the rules of the system.
pub fn validate(root: &Value) -> Result<Config, String> {
    let root = as_set(root, "the configuration")?;
    only(root, &["system", "pool", "world", "memory", "containment", "kernels", "display", "terminal", "roles", "dependencies"], "")?;

    let system = as_set(need(root, "system", "")?, "system")?;
    only(system, &["name", "version", "tickHz", "seed"], "system.")?;
    let name = text(system, "name", "system.")?;
    let version = text(system, "version", "system.")?;
    let tick_hz = int(system, "tickHz", "system.", 1, 1000)? as u32;
    let seed = int(system, "seed", "system.", 0, u32::MAX as i64)? as u32;

    let pool = as_set(need(root, "pool", "")?, "pool")?;
    only(pool, &["capacity", "blockWords"], "pool.")?;
    let capacity = pow2(pool, "capacity", "pool.", 64, 65536)?;
    let block_words = pow2(pool, "blockWords", "pool.", 8, 1024)?;

    let world = as_set(need(root, "world", "")?, "world")?;
    only(world, &["width", "depth", "stations"], "world.")?;
    let width = pow2(world, "width", "world.", 32, 256)?;
    let depth = pow2(world, "depth", "world.", 32, 256)?;
    let stations = pow2(world, "stations", "world.", 2, 16)?;

    let memory = as_set(need(root, "memory", "")?, "memory")?;
    only(memory, &["arenaBytes"], "memory.")?;
    let arena_bytes = int(memory, "arenaBytes", "memory.", 1 << 20, 1 << 30)? as usize;
    if !arena_bytes.is_multiple_of(4096) {
        return Err(format!("memory.arenaBytes must be a whole number of 4 KiB pages (got {})", arena_bytes));
    }

    let containment = as_set(need(root, "containment", "")?, "containment")?;
    only(containment, &["loopLimit", "network"], "containment.")?;
    let loop_limit = int(containment, "loopLimit", "containment.", 2, 1_000_000)? as u32;
    let network = match need(containment, "network", "containment.")? {
        Value::Bool(false) => false,
        Value::Bool(true) => {
            return Err(String::from(
                "containment.network = true is refused: this system has no network capability, and the air gap is not configurable",
            ));
        }
        _ => return Err(String::from("containment.network must be false")),
    };

    let kernels = as_set(need(root, "kernels", "")?, "kernels")?;
    only(kernels, &["stepEighths", "learnShift", "explore"], "kernels.")?;
    let step_eighths = int(kernels, "stepEighths", "kernels.", 1, 8)? as u32;
    let learn_shift = int(kernels, "learnShift", "kernels.", 1, 15)? as u32;
    let explore = int(kernels, "explore", "kernels.", 0, 65536)? as u32;

    let display = as_set(need(root, "display", "")?, "display")?;
    only(display, &["width", "height", "triangles"], "display.")?;
    let display_width = int(display, "width", "display.", 320, 1920)? as usize;
    let display_height = int(display, "height", "display.", 200, 1080)? as usize;
    if !display_width.is_multiple_of(8) || !display_height.is_multiple_of(8) {
        return Err(String::from("display.width and display.height must be multiples of 8"));
    }
    let triangles = int(display, "triangles", "display.", 256, 1 << 20)? as usize;

    let terminal = as_set(need(root, "terminal", "")?, "terminal")?;
    only(terminal, &["cells", "stack", "stepBudget", "lines"], "terminal.")?;
    let term_cells = pow2(terminal, "cells", "terminal.", TERM_MIN_CELLS as i64, 65536)?;
    let term_stack = int(terminal, "stack", "terminal.", 16, 1024)? as usize;
    let term_steps = int(terminal, "stepBudget", "terminal.", 1000, 100_000_000)? as u32;
    let term_lines = int(terminal, "lines", "terminal.", 16, 1024)? as usize;

    let roles_set = as_set(need(root, "roles", "")?, "roles")?;
    if roles_set.is_empty() {
        return Err(String::from("roles must declare at least one role"));
    }
    let mut roles = Vec::new();
    let mut total: u64 = 0;
    for (role, v) in roles_set {
        let path = format!("roles.{}.", role);
        if role.is_empty() || role.len() > 16 || !role.bytes().all(|b| b.is_ascii_lowercase()) {
            return Err(format!("roles.{} must be a lowercase name of at most 16 letters", role));
        }
        let r = as_set(v, &path)?;
        only(r, &["count", "caps"], &path)?;
        let count = int(r, "count", &path, 1, capacity as i64)? as u32;
        let caps = caps_of(&names(need(r, "caps", &path)?, &format!("{}caps", path))?, &format!("{}caps", path))?;
        total += count as u64;
        roles.push(Role { name: role.clone(), count, caps });
    }
    if total > capacity as u64 {
        return Err(format!("the roles declare {} agents, more than pool.capacity ({})", total, capacity));
    }
    if roles.len() > 16 {
        return Err(String::from("at most 16 roles"));
    }
    if !roles.iter().any(|r| r.caps & (CAP_MOVE | CAP_ROUTE) == CAP_MOVE | CAP_ROUTE) {
        return Err(String::from("the self-test needs a role that holds both \"move\" and \"route\""));
    }

    let dependencies = names(need(root, "dependencies", "")?, "dependencies")?;
    for d in &dependencies {
        if d.is_empty() || !d.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-') {
            return Err(format!("dependencies names \"{}\", which is not a crate name", d));
        }
    }

    let dims = Dims {
        capacity,
        block_words,
        stations,
        width,
        depth,
        loop_limit,
        step_eighths,
        learn_shift,
        explore,
        seed,
        tick_hz,
        display_width,
        display_height,
        triangles,
        term_cells,
        term_stack,
        term_steps,
        term_lines,
        arena_bytes,
    };
    let declared = declared_bytes(&dims);
    if declared > arena_bytes {
        return Err(format!(
            "the declared layout needs {} bytes, more than memory.arenaBytes ({})",
            declared, arena_bytes
        ));
    }
    Ok(Config { name, version, tick_hz, seed, dims, network, roles, dependencies })
}

// -------------------------------------------------------------------------------------------------------------------
// The layout: every allocation the system makes, in order

/// One declared allocation: its name, its element count and the bytes of one element.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Alloc {
    pub name: &'static str,
    pub elems: usize,
    pub elem_bytes: usize,
}

/// Every allocation is rounded up to (and aligned on) this many bytes.
pub const ALLOC_ALIGN: usize = 64;

/// How many allocations the layout declares.
pub const LAYOUT_LEN: usize = 31;

/// The arrays the system allocates, in the order it allocates them. The Global Matrix first (one element per agent
/// slot unless noted), then the world, the display and the terminal. (An array, not a Vec: the bootable image reads
/// the layout after its allocator is sealed.)
pub fn layout(d: &Dims) -> [Alloc; LAYOUT_LEN] {
    let cap = d.capacity;
    let cells = d.width * d.depth;
    let pixels = d.display_width * d.display_height;
    let a = |name, elems, elem_bytes| Alloc { name, elems, elem_bytes };
    [
        a("px", cap, 4),
        a("pz", cap, 4),
        a("alive", cap, 4),
        a("doomed", cap, 4),
        a("caps", cap, 4),
        a("req", cap, 4),
        a("role", cap, 4),
        a("goal", cap, 4),
        a("run", cap, 4),
        a("last", cap, 4),
        a("trips", cap, 4),
        a("clock", cap, 4),
        a("heading", cap, 4),
        a("fate", cap, 4),
        a("weights", cap * d.stations, 4),
        a("memory", cap * d.block_words, 4),
        a("walls", cells, 4),
        a("field", d.stations * cells, 4),
        a("scratch", d.stations * cells, 4),
        a("station", d.stations, 4),
        a("color", pixels, 4),
        a("zbuf", pixels, 4),
        a("tri_x", d.triangles * 3, 4),
        a("tri_y", d.triangles * 3, 4),
        a("tri_z", d.triangles * 3, 4),
        a("tri_rgb", d.triangles, 4),
        a("term_dict", d.term_cells, 4),
        a("term_stack", d.term_stack, 4),
        a("term_rstack", d.term_stack, 4),
        a("term_text", d.term_lines * TERM_COLS, 1),
        a("term_line", TERM_COLS * 4, 1),
    ]
}

/// The bytes one declared allocation takes from the arena.
pub fn alloc_bytes(a: &Alloc) -> usize {
    (a.elems * a.elem_bytes).div_ceil(ALLOC_ALIGN) * ALLOC_ALIGN
}

/// The bytes the whole layout takes from the arena.
pub fn declared_bytes(d: &Dims) -> usize {
    layout(d).iter().map(alloc_bytes).sum()
}

// -------------------------------------------------------------------------------------------------------------------
// The canonical form and the lock

fn quoted(list: &[impl AsRef<str>]) -> String {
    let inner: Vec<String> = list.iter().map(|s| format!("\"{}\"", s.as_ref())).collect();
    format!("[ {} ]", inner.join(" "))
}

/// The canonical form of a configuration: one `path = value;` line per setting, in a fixed order, inside one set. It
/// is itself valid in the subset (it parses back to the same configuration); comments and layout do not change it,
/// any setting does.
pub fn canonical(c: &Config) -> String {
    let d = &c.dims;
    let mut lines: Vec<String> = Vec::from([
        format!("system.name = \"{}\";", c.name),
        format!("system.version = \"{}\";", c.version),
        format!("system.tickHz = {};", c.tick_hz),
        format!("system.seed = {};", c.seed),
        format!("pool.capacity = {};", d.capacity),
        format!("pool.blockWords = {};", d.block_words),
        format!("world.width = {};", d.width),
        format!("world.depth = {};", d.depth),
        format!("world.stations = {};", d.stations),
        format!("memory.arenaBytes = {};", d.arena_bytes),
        format!("containment.loopLimit = {};", d.loop_limit),
        format!("containment.network = {};", c.network),
        format!("kernels.stepEighths = {};", d.step_eighths),
        format!("kernels.learnShift = {};", d.learn_shift),
        format!("kernels.explore = {};", d.explore),
        format!("display.width = {};", d.display_width),
        format!("display.height = {};", d.display_height),
        format!("display.triangles = {};", d.triangles),
        format!("terminal.cells = {};", d.term_cells),
        format!("terminal.stack = {};", d.term_stack),
        format!("terminal.stepBudget = {};", d.term_steps),
        format!("terminal.lines = {};", d.term_lines),
    ]);
    for r in &c.roles {
        lines.push(format!("roles.{}.count = {};", r.name, r.count));
        lines.push(format!("roles.{}.caps = {};", r.name, quoted(&cap_names(r.caps))));
    }
    lines.push(format!("dependencies = {};", quoted(&c.dependencies)));
    let mut out = String::from("{\n");
    for l in lines {
        out.push_str("  ");
        out.push_str(&l);
        out.push('\n');
    }
    out.push_str("}\n");
    out
}

/// The SHA-256 of the canonical form, as lowercase hex.
pub fn digest_hex(canonical: &str) -> String {
    let mut buf = [0u8; 64];
    hex(&sha256(canonical.as_bytes()), &mut buf).to_string()
}

/// The digest a lock file pins: its first word that is not a `#` comment.
pub fn locked_digest(lock: &str) -> Option<&str> {
    lock.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with('#')).and_then(|l| l.split_whitespace().next())
}

/// Parses, validates and locks: the configuration, its canonical form and its digest, or why it is refused.
pub fn load(nix: &str, lock: &str) -> Result<(Config, String, String), String> {
    let config = validate(&parse(nix)?)?;
    let canon = canonical(&config);
    let digest = digest_hex(&canon);
    match locked_digest(lock) {
        Some(pinned) if pinned == digest => Ok((config, canon, digest)),
        Some(pinned) => Err(format!(
            "containment.nix no longer matches containment.lock: its canonical form hashes to {} but the lock pins {}. \
             Review the change, then write the new digest into containment.lock.",
            digest, pinned
        )),
        None => Err(format!("containment.lock pins no digest (the configuration hashes to {})", digest)),
    }
}

/// The Rust source the build scripts include: the locked tables, the canonical text and its digest, and the
/// fingerprint of the self-test's run computed on the build machine.
pub fn emit_rust(c: &Config, canon: &str, digest: &str, golden_ticks: u32, golden: u32) -> String {
    let d = &c.dims;
    let mut s = String::from("// Generated by the build script from containment.nix; do not edit.\n");
    s.push_str(&format!("pub const NAME: &str = {:?};\n", c.name));
    s.push_str(&format!("pub const VERSION: &str = {:?};\n", c.version));
    s.push_str(&format!(
        "pub const DIMS: noir_core::config::Dims = noir_core::config::Dims {{ capacity: {}, block_words: {}, stations: {}, \
         width: {}, depth: {}, loop_limit: {}, step_eighths: {}, learn_shift: {}, explore: {}, seed: {}, tick_hz: {}, \
         display_width: {}, display_height: {}, triangles: {}, term_cells: {}, term_stack: {}, term_steps: {}, \
         term_lines: {}, arena_bytes: {} }};\n",
        d.capacity,
        d.block_words,
        d.stations,
        d.width,
        d.depth,
        d.loop_limit,
        d.step_eighths,
        d.learn_shift,
        d.explore,
        d.seed,
        d.tick_hz,
        d.display_width,
        d.display_height,
        d.triangles,
        d.term_cells,
        d.term_stack,
        d.term_steps,
        d.term_lines,
        d.arena_bytes
    ));
    let n = c.roles.len();
    let role_names: Vec<String> = c.roles.iter().map(|r| format!("{:?}", r.name)).collect();
    let role_counts: Vec<String> = c.roles.iter().map(|r| r.count.to_string()).collect();
    let role_caps: Vec<String> = c.roles.iter().map(|r| r.caps.to_string()).collect();
    s.push_str(&format!("pub const ROLE_NAMES: [&str; {}] = [{}];\n", n, role_names.join(", ")));
    s.push_str(&format!("pub const ROLE_COUNTS: [u32; {}] = [{}];\n", n, role_counts.join(", ")));
    s.push_str(&format!("pub const ROLE_CAPS: [u32; {}] = [{}];\n", n, role_caps.join(", ")));
    let deps: Vec<String> = c.dependencies.iter().map(|d| format!("{:?}", d)).collect();
    s.push_str(&format!("pub const DEPENDENCIES: [&str; {}] = [{}];\n", deps.len(), deps.join(", ")));
    s.push_str(&format!("pub const CANONICAL: &str = {:?};\n", canon));
    s.push_str(&format!("pub const DIGEST: &str = {:?};\n", digest));
    s.push_str(&format!("pub const GOLDEN_TICKS: u32 = {};\n", golden_ticks));
    s.push_str(&format!("pub const GOLDEN: u32 = {:#010x};\n", golden));
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::string::String;

    pub const SAMPLE: &str = include_str!("../../../containment.nix");

    fn with(edit: &str, to: &str) -> String {
        assert!(SAMPLE.contains(edit), "the sample holds {edit:?}");
        SAMPLE.replacen(edit, to, 1)
    }

    fn refused(src: &str) -> String {
        match parse(src).and_then(|v| validate(&v)) {
            Ok(_) => panic!("accepted:\n{src}"),
            Err(e) => e,
        }
    }

    #[test]
    fn the_shipped_configuration_is_valid_and_its_canonical_form_round_trips() {
        let c = validate(&parse(SAMPLE).unwrap()).unwrap();
        assert!(!c.network);
        assert!(c.roles.iter().map(|r| r.count).sum::<u32>() <= c.dims.capacity as u32);
        let canon = canonical(&c);
        let again = validate(&parse(&canon).unwrap()).unwrap();
        assert_eq!(again, c, "the canonical form parses back to the same configuration");
        assert_eq!(canonical(&again), canon);
        // Comments and layout do not change the digest; a setting does.
        let spaced = SAMPLE.replace("\n", "\n\n# a comment\n");
        assert_eq!(digest_hex(&canonical(&validate(&parse(&spaced).unwrap()).unwrap())), digest_hex(&canon));
        let changed = with("loopLimit = 100;", "loopLimit = 99;");
        assert_ne!(digest_hex(&canonical(&validate(&parse(&changed).unwrap()).unwrap())), digest_hex(&canon));
    }

    #[test]
    fn the_lock_must_match() {
        let c = validate(&parse(SAMPLE).unwrap()).unwrap();
        let digest = digest_hex(&canonical(&c));
        assert!(load(SAMPLE, &format!("# pinned\n{digest}\n")).is_ok());
        let e = load(SAMPLE, &format!("{}\n", "0".repeat(64))).unwrap_err();
        assert!(e.contains("no longer matches"), "{e}");
        assert!(load(SAMPLE, "# nothing\n").unwrap_err().contains("pins no digest"));
    }

    #[test]
    fn privileges_outside_the_system_are_refused() {
        assert!(refused(&with("containment = {", "containment = { extra = 1;")).contains("not part of the configuration"));
        assert!(refused(&with("network = false;", "network = true;")).contains("air gap"));
        let e = refused(&with("[ \"move\" \"route\" \"learn\" \"memory\" ]", "[ \"move\" \"network\" ]"));
        assert!(e.contains("not a capability"), "{e}");
        assert!(refused(&with("[ \"move\" \"route\" \"learn\" \"memory\" ]", "[ \"move\" \"move\" ]")).contains("twice"));
        assert!(refused(&with("capacity = 4096;", "capacity = 4000;")).contains("power of two"));
        assert!(refused(&with("arenaBytes = 16777216;", "arenaBytes = 1048576;")).contains("declared layout needs"));
        assert!(refused(&with("count = 3072;", "count = 4000;")).contains("more than pool.capacity"));
        assert!(refused(&with("tickHz = 60;", "tickHz = 60.5;")).contains("whole numbers"));
    }

    #[test]
    fn the_subset_is_strict() {
        assert!(parse("{ a = \"${x}\"; }").unwrap_err().contains("interpolation"));
        assert!(parse("{ a = import ./x.nix; }").is_err());
        assert!(parse("{ a = 1; a = 2; }").unwrap_err().contains("declared twice"));
        assert!(parse("{ a.b = 1; a.b = 2; }").unwrap_err().contains("declared twice"));
        assert_eq!(
            parse("{ a.b = 1; a = { c = 2; }; }").unwrap(),
            Value::Set(std::vec![(
                String::from("a"),
                Value::Set(std::vec![(String::from("b"), Value::Int(1)), (String::from("c"), Value::Int(2))])
            )])
        );
        assert!(parse("{ a = 1; } trailing").unwrap_err().contains("text after"));
        assert!(parse("{ a = 99999999999999999999; }").unwrap_err().contains("too large"));
        let deep = format!("{}{}", "[".repeat(100), "]".repeat(100));
        assert!(parse(&deep).unwrap_err().contains("nested too deeply"));
        assert!(parse("{ a = \"x").unwrap_err().contains("not closed"));
        // Every error names its line and column.
        assert!(parse("{\n  a = ;\n}").unwrap_err().starts_with("containment.nix:2:"));
    }

    #[test]
    fn the_layout_fits_and_names_every_array_once() {
        let c = validate(&parse(SAMPLE).unwrap()).unwrap();
        let l = layout(&c.dims);
        for (k, a) in l.iter().enumerate() {
            assert!(l[k + 1..].iter().all(|b| b.name != a.name), "{} declared twice", a.name);
            assert_eq!(alloc_bytes(a) % ALLOC_ALIGN, 0);
        }
        assert!(declared_bytes(&c.dims) <= c.dims.arena_bytes);
    }
}
