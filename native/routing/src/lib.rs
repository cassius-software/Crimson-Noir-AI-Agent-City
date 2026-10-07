//! The track arithmetic a car fleet runs every step (src/06_Make_Decisions/tracks.ts: pose_at, project_onto,
//! next_stop, speed_limit_at, over rings of straights on lane lines and quadratic Bézier corners with an arc-length
//! look-up table), as a dependency-free WebAssembly core with a C ABI over linear memory.
//!
//! Why does this file exist? The TypeScript reference stays the specification and the fallback (tracks.ts keeps
//! every function); this core is the same arithmetic compiled to WebAssembly, proved equal to it bit for bit in
//! src/06_Make_Decisions/routingWasm.test.ts, so the fleet's hot loop runs as a module whose every operation is
//! fixed at compile time. The host lays each track into an arena it sizes (`routing_arena`) in the layout of
//! `layout.rs`, checks it (`routing_check`), and calls the four functions with the track's word offset; results come
//! back through one fixed output block (`routing_out`). Nothing here allocates: `#![no_std]`, no heap, no library.
//! What breaks if it is removed? Nothing in the product: tracks.ts answers every call itself. The build has no
//! WebAssembly routing core to ship.
#![no_std]
#![allow(clippy::too_many_arguments)]

#[cfg(not(target_arch = "wasm32"))]
extern crate std;

pub mod layout;
pub mod math;

use layout::*;
use math::{atan2, ceil, floor, hypot, jmax, jmin, sqrt};

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

/// Position and unit tangent at an arc length; heading = atan2(tangentX, tangentZ) (tracks.ts TrackPose).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Pose {
    pub x: f64,
    pub z: f64,
    pub heading: f64,
    pub tangent_x: f64,
    pub tangent_z: f64,
}

/// A stop line and the signed distance to it (tracks.ts nextStop).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct StopAhead {
    pub s: f64,
    /// 0 = 'ew', 1 = 'ns' (layout AXIS_EW / AXIS_NS).
    pub axis: f64,
    pub distance: f64,
}

/// A track laid out as `layout.rs` says, viewed over its words.
#[derive(Clone, Copy)]
pub struct Track<'a> {
    w: &'a [f64],
}

impl<'a> Track<'a> {
    /// A view over `words`, which must start with a well-formed track (`check` says so).
    pub fn new(words: &'a [f64]) -> Self {
        Track { w: words }
    }

    /// True when `words` begins with a well-formed track that fits in it: a header, its piece and stop counts
    /// (whole, non-negative, at least one piece), every piece a line or a corner of positive length with
    /// non-decreasing s0 from 0, a positive loop length and finite limits.
    pub fn check(words: &[f64]) -> bool {
        if words.len() < T_HEADER {
            return false;
        }
        let pieces = words[T_PIECES];
        let stops = words[T_STOPS];
        let whole = |v: f64| v >= 0.0 && v == floor(v) && v < 1.0e9;
        if !whole(pieces) || !whole(stops) || pieces < 1.0 {
            return false;
        }
        let (np, ns) = (pieces as usize, stops as usize);
        match track_words_checked(np, ns) {
            Some(need) if words.len() >= need => {}
            _ => return false,
        }
        let length = words[T_LENGTH];
        if !(length > 0.0 && length.is_finite()) || !words[T_Y].is_finite() || !words[T_SPEED_LIMIT].is_finite() || !words[T_CORNER_SPEED].is_finite() || !words[T_DECEL].is_finite() {
            return false;
        }
        let mut last_s0 = 0.0;
        for i in 0..np {
            let p = &words[T_HEADER + i * PIECE_WORDS..T_HEADER + (i + 1) * PIECE_WORDS];
            if p[P_KIND] != KIND_LINE && p[P_KIND] != KIND_CORNER {
                return false;
            }
            let (s0, len) = (p[P_S0], p[P_LENGTH]);
            if !(len > 0.0 && len.is_finite()) || !s0.is_finite() || s0 < last_s0 || (i == 0 && s0 != 0.0) {
                return false;
            }
            last_s0 = s0;
        }
        let stops_at = T_HEADER + np * PIECE_WORDS;
        for i in 0..ns {
            let st = &words[stops_at + i * STOP_WORDS..stops_at + (i + 1) * STOP_WORDS];
            if !st[S_S].is_finite() || (st[S_AXIS] != AXIS_EW && st[S_AXIS] != AXIS_NS) {
                return false;
            }
        }
        true
    }

    #[inline]
    pub fn length(&self) -> f64 {
        self.w[T_LENGTH]
    }
    #[inline]
    pub fn y(&self) -> f64 {
        self.w[T_Y]
    }
    #[inline]
    pub fn speed_limit(&self) -> f64 {
        self.w[T_SPEED_LIMIT]
    }
    #[inline]
    pub fn corner_speed(&self) -> f64 {
        self.w[T_CORNER_SPEED]
    }
    #[inline]
    pub fn decel(&self) -> f64 {
        self.w[T_DECEL]
    }
    #[inline]
    pub fn pieces(&self) -> usize {
        self.w[T_PIECES] as usize
    }
    #[inline]
    pub fn stops(&self) -> usize {
        self.w[T_STOPS] as usize
    }
    #[inline]
    pub fn piece(&self, i: usize) -> &'a [f64] {
        &self.w[T_HEADER + i * PIECE_WORDS..T_HEADER + (i + 1) * PIECE_WORDS]
    }
    #[inline]
    pub fn stop(&self, i: usize) -> &'a [f64] {
        let at = T_HEADER + self.pieces() * PIECE_WORDS + i * STOP_WORDS;
        &self.w[at..at + STOP_WORDS]
    }
    /// Words this track takes.
    pub fn words(&self) -> usize {
        track_words(self.pieces(), self.stops())
    }
}

// ---------------------------------------------------------------- the arithmetic (tracks.ts, line for line)

/// `s` folded into [0, length).
#[inline]
pub fn wrap(length: f64, s: f64) -> f64 {
    let w = s % length;
    if w < 0.0 { w + length } else { w }
}

/// The index of the piece containing `s` (already wrapped): the last piece whose s0 ≤ s.
pub fn piece_at(t: Track, s: f64) -> usize {
    let (mut lo, mut hi) = (0usize, t.pieces() - 1);
    while lo < hi {
        let mid = (lo + hi + 1) >> 1;
        if t.piece(mid)[P_S0] <= s {
            lo = mid;
        } else {
            hi = mid - 1;
        }
    }
    lo
}

#[inline]
fn bezier_point(p: &[f64], t: f64) -> (f64, f64) {
    let u = 1.0 - t;
    (
        u * u * p[P_EX] + 2.0 * u * t * p[P_CX] + t * t * p[P_XX],
        u * u * p[P_EZ] + 2.0 * u * t * p[P_CZ] + t * t * p[P_XZ],
    )
}

/// The pose `local` metres into piece `p` (tracks.ts evalPiece).
pub fn eval_piece(p: &[f64], local: f64, out: &mut Pose) {
    if p[P_KIND] == KIND_LINE {
        out.x = p[P_X0] + p[P_DX] * local;
        out.z = p[P_Z0] + p[P_DZ] * local;
        out.tangent_x = p[P_DX];
        out.tangent_z = p[P_DZ];
    } else {
        let n = (LUT_SIZE - 1) as f64;
        let u = jmin(n, jmax(0.0, (local / p[P_LENGTH]) * n));
        let i = jmin(n - 1.0, floor(u));
        let f = u - i;
        let k = i as usize;
        let t = p[P_LUT + k] + f * (p[P_LUT + k + 1] - p[P_LUT + k]);
        let (x, z) = bezier_point(p, t);
        let w = 1.0 - t;
        let dx = 2.0 * w * (p[P_CX] - p[P_EX]) + 2.0 * t * (p[P_XX] - p[P_CX]);
        let dz = 2.0 * w * (p[P_CZ] - p[P_EZ]) + 2.0 * t * (p[P_XZ] - p[P_CZ]);
        let h = hypot(dx, dz);
        let m = if h == 0.0 || h.is_nan() { 1.0 } else { h };
        out.x = x;
        out.z = z;
        out.tangent_x = dx / m;
        out.tangent_z = dz / m;
    }
    out.heading = atan2(out.tangent_x, out.tangent_z);
}

/// Position, unit tangent and heading at arc length `s` (any real number; wrapped).
pub fn pose_at(t: Track, s: f64) -> Pose {
    let w = wrap(t.length(), s);
    let p = t.piece(piece_at(t, w));
    let mut out = Pose::default();
    eval_piece(p, w - p[P_S0], &mut out);
    out
}

/// Along-track and (right-positive) lateral offsets of (x, z) from the pose at s.
#[inline]
fn offsets(t: Track, s: f64, x: f64, z: f64) -> (f64, f64) {
    let p = pose_at(t, s);
    let (ox, oz) = (x - p.x, z - p.z);
    (ox * p.tangent_x + oz * p.tangent_z, ox * -p.tangent_z + oz * p.tangent_x)
}

/// Newton steps s ← s + along (each clamped to ±clamp) until the step is below a tenth of a millimetre.
fn refine(t: Track, mut s: f64, x: f64, z: f64, steps: usize, clamp: f64) -> f64 {
    for _ in 0..steps {
        let (along, _) = offsets(t, s, x, z);
        let step = jmax(-clamp, jmin(clamp, along));
        s = wrap(t.length(), s + step);
        if step.abs() < 1e-4 {
            break;
        }
    }
    s
}

/// The arc length nearest (x, z) and the lateral offset there (tracks.ts projectOnto): six Newton steps from a
/// finite hint when they converge within HINT_LATERAL of the track, else a global search over every piece (closed
/// form on lines, a scan every NEWTON_STEP metres on corners) and the same refinement.
pub fn project_onto(t: Track, x: f64, z: f64, hint: f64) -> (f64, f64) {
    let length = t.length();
    if hint.is_finite() {
        let s = refine(t, wrap(length, hint), x, z, 6, NEWTON_STEP);
        let (along, lateral) = offsets(t, s, x, z);
        if along.abs() < 1e-3 && lateral.abs() <= HINT_LATERAL {
            return (s, lateral);
        }
    }
    let mut best = f64::INFINITY;
    let mut best_s = 0.0;
    let mut probe = Pose::default();
    for i in 0..t.pieces() {
        let p = t.piece(i);
        if p[P_KIND] == KIND_LINE {
            let local = jmax(0.0, jmin(p[P_LENGTH], (x - p[P_X0]) * p[P_DX] + (z - p[P_Z0]) * p[P_DZ]));
            let d = hypot(x - (p[P_X0] + p[P_DX] * local), z - (p[P_Z0] + p[P_DZ] * local));
            if d < best {
                best = d;
                best_s = p[P_S0] + local;
            }
        } else {
            let samples = jmax(16.0, ceil(p[P_LENGTH] / NEWTON_STEP));
            let n = samples as usize;
            for k in 0..=n {
                let local = (k as f64 / samples) * p[P_LENGTH];
                eval_piece(p, local, &mut probe);
                let d = hypot(x - probe.x, z - probe.z);
                if d < best {
                    best = d;
                    best_s = p[P_S0] + local;
                }
            }
        }
    }
    let s = refine(t, best_s, x, z, 6, NEWTON_STEP);
    (s, offsets(t, s, x, z).1)
}

/// The stop line a car at `s` answers to: a stop stays current until the car is `behind` metres past it, so the
/// distance may be negative; then the next stop ahead takes over. None on a track without stops.
pub fn next_stop(t: Track, s: f64, behind: f64) -> Option<StopAhead> {
    let length = t.length();
    let w = wrap(length, s);
    let mut best: Option<StopAhead> = None;
    for i in 0..t.stops() {
        let st = t.stop(i);
        let distance = wrap(length, st[S_S] - w + behind) - behind;
        if best.is_none_or(|b| distance < b.distance) {
            best = Some(StopAhead { s: st[S_S], axis: st[S_AXIS], distance });
        }
    }
    best
}

/// Metres from `s` to the start of the next corner (0 inside one; infinity on a track of straights).
pub fn corner_ahead(t: Track, s: f64) -> f64 {
    let length = t.length();
    let w = wrap(length, s);
    if t.piece(piece_at(t, w))[P_KIND] != KIND_LINE {
        return 0.0;
    }
    let mut best = f64::INFINITY;
    for i in 0..t.pieces() {
        let p = t.piece(i);
        if p[P_KIND] == KIND_LINE {
            continue;
        }
        let d = wrap(length, p[P_S0] - w);
        if d < best {
            best = d;
        }
    }
    best
}

/// The speed a track vehicle may hold at `s`: cornerSpeed inside a curve, and before one the anticipation
/// v ≤ sqrt(cornerSpeed² + 2 · decel · distance), capped at the limit.
pub fn speed_limit_at(t: Track, s: f64) -> f64 {
    let d = corner_ahead(t, s);
    if d == 0.0 {
        return t.corner_speed();
    }
    jmin(t.speed_limit(), sqrt(t.corner_speed() * t.corner_speed() + 2.0 * t.decel() * d))
}

// ---------------------------------------------------------------- the C ABI over the arena

/// Words of the output block every call writes its numbers to.
pub const OUT_WORDS: usize = 8;

struct Arena {
    base: *const f64,
    words: usize,
}

static mut ARENA: Arena = Arena { base: core::ptr::null(), words: 0 };
static mut OUT: [f64; OUT_WORDS] = [0.0; OUT_WORDS];

/// The arena the exported functions read tracks from: `words` f64 words at `base` (8-byte aligned). The host
/// writes tracks into it and never moves it while the core is in use.
///
/// # Safety
/// `base` must point to `words` readable f64 words for as long as the exported functions are called.
pub unsafe fn set_arena(base: *const f64, words: usize) {
    ARENA = Arena { base, words };
}

/// The track at word offset `at` of the arena, if its header and body lie inside it.
fn track_at(at: usize) -> Option<Track<'static>> {
    // SAFETY: the host promised `words` readable words at `base` (set_arena); every index is bounds-checked here.
    let (base, words) = unsafe { (ARENA.base, ARENA.words) };
    if base.is_null() || at >= words || words - at < T_HEADER {
        return None;
    }
    let all = unsafe { core::slice::from_raw_parts(base, words) };
    let head = &all[at..];
    let (np, ns) = (head[T_PIECES], head[T_STOPS]);
    if !((1.0..1.0e9).contains(&np) && (0.0..1.0e9).contains(&ns)) {
        return None;
    }
    let need = track_words_checked(np as usize, ns as usize)?;
    if head.len() < need {
        return None;
    }
    Some(Track::new(&head[..need]))
}

#[inline]
fn out_write(values: &[f64]) {
    // SAFETY: single-threaded; the block is only ever written here and read by the host after the call returns.
    unsafe {
        let out = core::ptr::addr_of_mut!(OUT) as *mut f64;
        for (i, v) in values.iter().enumerate() {
            *out.add(i) = *v;
        }
    }
}

/// Sets the arena: `base` is a byte address in linear memory, `words` its size in f64 words. Returns 1, or 0 when
/// the address is not 8-byte aligned, the range overflows, or (on wasm32) it lies outside the memory.
#[no_mangle]
pub extern "C" fn routing_arena(base: u32, words: u32) -> u32 {
    let (b, w) = (base as usize, words as usize);
    if b % 8 != 0 || w == 0 {
        return 0;
    }
    let Some(end) = w.checked_mul(8).and_then(|bytes| b.checked_add(bytes)) else { return 0 };
    #[cfg(target_arch = "wasm32")]
    if end > core::arch::wasm32::memory_size(0) * 65536 {
        return 0;
    }
    let _ = end;
    // SAFETY: the host owns the memory; the range was just checked.
    unsafe { set_arena(b as *const f64, w) };
    1
}

/// 1 when a well-formed track lies at word offset `at` of the arena (`Track::check`), else 0.
#[no_mangle]
pub extern "C" fn routing_check(at: u32) -> u32 {
    match track_at(at as usize) {
        Some(t) => u32::from(Track::check(t.w)),
        None => 0,
    }
}

/// The address of the output block (`OUT_WORDS` f64 words) every call writes to.
#[no_mangle]
pub extern "C" fn routing_out() -> u32 {
    core::ptr::addr_of!(OUT) as usize as u32
}

/// Writes [x, y, z, heading, tangentX, tangentZ] at `s` to the output block; 1, or 0 for no track at `at`.
#[no_mangle]
pub extern "C" fn routing_pose_at(at: u32, s: f64) -> u32 {
    let Some(t) = track_at(at as usize) else { return 0 };
    let p = pose_at(t, s);
    out_write(&[p.x, t.y(), p.z, p.heading, p.tangent_x, p.tangent_z]);
    1
}

/// Writes [s, lateral] of the projection of (x, z) (hint NaN for none) to the output block; 1, or 0 for no track.
#[no_mangle]
pub extern "C" fn routing_project_onto(at: u32, x: f64, z: f64, hint: f64) -> u32 {
    let Some(t) = track_at(at as usize) else { return 0 };
    let (s, lateral) = project_onto(t, x, z, hint);
    out_write(&[s, lateral]);
    1
}

/// Writes [stopS, axis, distance] of the stop a car at `s` answers to; 1 when there is one, 2 on a track without
/// stops, 0 for no track.
#[no_mangle]
pub extern "C" fn routing_next_stop(at: u32, s: f64, behind: f64) -> u32 {
    let Some(t) = track_at(at as usize) else { return 0 };
    match next_stop(t, s, behind) {
        Some(st) => {
            out_write(&[st.s, st.axis, st.distance]);
            1
        }
        None => 2,
    }
}

/// The speed a track vehicle may hold at `s`; NaN for no track.
#[no_mangle]
pub extern "C" fn routing_speed_limit_at(at: u32, s: f64) -> f64 {
    match track_at(at as usize) {
        Some(t) => speed_limit_at(t, s),
        None => f64::NAN,
    }
}

/// The layout's numbers (`layout::TABLE`) by index, for the host's load-time check; 0 past the table.
#[no_mangle]
pub extern "C" fn routing_layout(index: u32) -> u32 {
    TABLE.get(index as usize).map_or(0, |&v| v as u32)
}

#[cfg(test)]
mod tests;
#[cfg(kani)]
mod verify;
