//! Why does this file exist? It is the formal side of the routing core: proof harnesses for the Kani model checker
//! (`cargo kani -Z stubbing`, tools/verify/fvps.sh), compiled only under `cfg(kani)`. The core reads tracks the host
//! laid into an arena it does not control; the WebAssembly module traps (an `unreachable`) if any of that reading
//! steps outside the arena or panics. Each harness lays a symbolic arena, every word any f64 at all (NaN, infinities,
//! negative counts, counts that do not fit), points the core at it and calls the exported functions with symbolic
//! arguments; Kani (CBMC under it, bit-precise for f64) explores every path and reports the first that reaches a
//! panic. A harness that passes proves the exported function never traps on an arena of that size, whatever it
//! holds, and that the indices it computes are the bounded ones the host relies on (a piece index below the count,
//! a stop that is one of the track's, a look-up-table index inside the table).
//!
//! What is abstracted, and why it is sound. The values that never become an index are replaced under the checker by
//! "any f64": the transcendental functions (`atan2`, `hypot`, `sqrt`), the Bézier point, the along/lateral offsets
//! and the fold `wrap` (whose result only ever reaches comparisons and clamps, so every index below is bounded
//! whatever it is, NaN included), the piece evaluation `eval_piece` and the Newton refinement `refine` (pure
//! arithmetic on a piece's words whose results are arc lengths and poses, never indices). The harnesses run with
//! `--no-overflow-checks` (tools/verify/fvps.sh): the checker's floating-point checks report every operation that
//! produces a NaN or an infinity, and a NaN is a value this module returns (for a NaN arc length, as the
//! TypeScript reference does; routingWasm.fuzz.test.ts holds that), not a trap. What stays checked is what traps:
//! every memory access in bounds, every integer operation without overflow (a Rust panic), every unwrap and
//! assertion. A proof over every possible value of those covers the real one; it says nothing
//! about the numbers' accuracy, which src/06_Make_Decisions/routingWasm.test.ts holds bit for bit against the
//! TypeScript reference. `floor` and `ceil` shape indices and loop counts and are kept exact. The arena sizes are
//! small (one or two pieces, up to two stops) because the checker unrolls every loop; the arithmetic is the same at 64
//! rings of 32 pieces, and tools/verify/wasm_airgap.py proves the module can reach nothing outside its own memory at
//! any size.
//! What breaks if it is removed? `cargo kani` has nothing to prove about the module the fleet runs.

use crate::layout::*;
use crate::{Track, next_stop, piece_at, pose_at, project_onto, routing_arena, routing_check, routing_layout, routing_next_stop, routing_pose_at, routing_project_onto, routing_speed_limit_at, set_arena, speed_limit_at};

// ---------------------------------------------------------------- the abstractions (see the module comment)

fn any_atan2(_y: f64, _x: f64) -> f64 {
    kani::any()
}
fn any_hypot(_a: f64, _b: f64) -> f64 {
    kani::any()
}
fn any_sqrt(_x: f64) -> f64 {
    kani::any()
}
fn any_wrap(_length: f64, _s: f64) -> f64 {
    kani::any()
}
fn any_bezier(_p: &[f64], _t: f64) -> (f64, f64) {
    (kani::any(), kani::any())
}
fn any_offsets(_t: Track, _s: f64, _x: f64, _z: f64) -> (f64, f64) {
    (kani::any(), kani::any())
}
fn any_pose(_p: &[f64], _local: f64, out: &mut crate::Pose) {
    *out = crate::Pose { x: kani::any(), z: kani::any(), heading: kani::any(), tangent_x: kani::any(), tangent_z: kani::any() };
}
fn any_refine(_t: Track, _s: f64, _x: f64, _z: f64, _steps: usize, _clamp: f64) -> f64 {
    kani::any()
}

/// `N` symbolic words, as one symbolic array (no loop for the checker to unroll).
fn any_words<const N: usize>() -> [f64; N] {
    kani::any()
}

/// The arena is `words`; every exported function then reads from it.
fn lay(words: &[f64]) {
    // SAFETY: the array outlives every call of the harness.
    unsafe { set_arena(words.as_ptr(), words.len()) };
}

/// A well-formed track: `N` symbolic words that `Track::check` accepts.
fn checked_words<const N: usize>() -> [f64; N] {
    let words = any_words::<N>();
    kani::assume(Track::check(&words));
    words
}

/// A well-formed track of exactly `pieces` pieces (the words past them are stops, or nothing): `N` symbolic words
/// that `Track::check` accepts. Fixing the count keeps the check's loop over the stops within the harness's unwind
/// bound (two pieces' worth of words could otherwise be one piece and twenty-one stops).
fn checked_words_of<const N: usize>(pieces: usize) -> [f64; N] {
    let words = any_words::<N>();
    kani::assume(words[T_PIECES] == pieces as f64);
    kani::assume(Track::check(&words));
    words
}

/// The arena setter refuses what it must (misaligned, empty, overflowing ranges) and never traps; the layout table
/// answers 0 past its end.
#[kani::proof]
fn arena_setter_never_traps() {
    let (base, n): (u32, u32) = (kani::any(), kani::any());
    let ok = routing_arena(base, n);
    assert!(ok <= 1);
    if ok == 1 {
        assert!(base % 8 == 0 && n > 0);
    }
    let i: u32 = kani::any();
    let v = routing_layout(i);
    assert!(i as usize >= TABLE.len() || v as usize == TABLE[i as usize]);
}

/// Whatever the arena holds, `routing_check` answers 0 or 1 and never traps; and an offset it accepts is a track
/// whose header and body lie inside the arena.
#[kani::proof]
#[kani::unwind(4)]
#[kani::stub(crate::math::atan2, any_atan2)]
#[kani::stub(crate::math::hypot, any_hypot)]
#[kani::stub(crate::math::sqrt, any_sqrt)]
#[kani::stub(crate::wrap, any_wrap)]
#[kani::stub(crate::bezier_point, any_bezier)]
#[kani::stub(crate::offsets, any_offsets)]
fn check_never_traps_on_any_arena() {
    // One piece and two stops' worth of words: the offset is symbolic, so the check is tried at every alignment of
    // a track inside the arena (a larger arena holds more stops for the check to walk, and the checker ran out of
    // memory walking them at every offset).
    let words = any_words::<{ T_HEADER + PIECE_WORDS + 2 * STOP_WORDS }>();
    lay(&words);
    let at: u32 = kani::any();
    let ok = routing_check(at);
    assert!(ok <= 1);
    if ok == 1 {
        let t = Track::new(&words[at as usize..]);
        assert!(t.pieces() >= 1 && at as usize + t.words() <= words.len());
    }
}

/// On a one-piece track the piece index is always 0 and the pose call answers 1 without trapping, for every arc
/// length (and every value the fold could give it, NaN included).
#[kani::proof]
#[kani::unwind(8)]
#[kani::stub(crate::math::atan2, any_atan2)]
#[kani::stub(crate::math::hypot, any_hypot)]
#[kani::stub(crate::math::sqrt, any_sqrt)]
#[kani::stub(crate::wrap, any_wrap)]
#[kani::stub(crate::bezier_point, any_bezier)]
#[kani::stub(crate::offsets, any_offsets)]
#[kani::stub(crate::eval_piece, any_pose)]
fn pose_at_never_traps_on_one_piece() {
    let words = checked_words::<{ T_HEADER + PIECE_WORDS }>();
    lay(&words);
    let t = Track::new(&words);
    let s: f64 = kani::any();
    assert!(piece_at(t, s) == 0);
    let _ = pose_at(t, s);
    assert!(routing_pose_at(0, s) == 1);
}

/// On a two-piece track the piece search lands on a piece whose s0 is at or before the arc length (or on the first
/// piece), and the pose call never traps.
#[kani::proof]
#[kani::unwind(8)]
#[kani::stub(crate::math::atan2, any_atan2)]
#[kani::stub(crate::math::hypot, any_hypot)]
#[kani::stub(crate::math::sqrt, any_sqrt)]
#[kani::stub(crate::wrap, any_wrap)]
#[kani::stub(crate::bezier_point, any_bezier)]
#[kani::stub(crate::offsets, any_offsets)]
#[kani::stub(crate::eval_piece, any_pose)]
fn pose_at_never_traps_on_two_pieces() {
    let words = checked_words_of::<{ T_HEADER + 2 * PIECE_WORDS }>(2);
    lay(&words);
    let t = Track::new(&words);
    let s: f64 = kani::any();
    let i = piece_at(t, s);
    assert!(i < 2);
    assert!(i == 0 || t.piece(i)[P_S0] <= s);
    assert!(routing_pose_at(0, s) == 1);
}

/// The stop a car answers to is always one of the track's own stops, for every arc length and every `behind`; a
/// track without stops answers 2; the speed limit never traps.
#[kani::proof]
#[kani::unwind(8)]
#[kani::stub(crate::math::atan2, any_atan2)]
#[kani::stub(crate::math::hypot, any_hypot)]
#[kani::stub(crate::math::sqrt, any_sqrt)]
#[kani::stub(crate::wrap, any_wrap)]
#[kani::stub(crate::bezier_point, any_bezier)]
#[kani::stub(crate::offsets, any_offsets)]
fn next_stop_and_speed_limit_never_trap() {
    let words = checked_words::<{ T_HEADER + PIECE_WORDS + 2 * STOP_WORDS }>();
    lay(&words);
    let t = Track::new(&words);
    let (s, behind): (f64, f64) = (kani::any(), kani::any());
    match next_stop(t, s, behind) {
        Some(st) => {
            assert!(t.stops() > 0);
            let mut own = false;
            for i in 0..t.stops() {
                let w = t.stop(i);
                own |= w[S_S].to_bits() == st.s.to_bits() && w[S_AXIS] == st.axis;
            }
            assert!(own);
            assert!(routing_next_stop(0, s, behind) == 1);
        }
        None => {
            assert!(t.stops() == 0);
            assert!(routing_next_stop(0, s, behind) == 2);
        }
    }
    let _ = speed_limit_at(t, s);
    let _ = routing_speed_limit_at(0, s);
}

/// The projection never traps on a one-piece track, a line or a corner short enough that its scan is 16 samples,
/// for every point and hint (the piece evaluation it samples is abstracted here and proved by the pose harnesses).
#[kani::proof]
#[kani::unwind(19)]
#[kani::stub(crate::math::atan2, any_atan2)]
#[kani::stub(crate::math::hypot, any_hypot)]
#[kani::stub(crate::math::sqrt, any_sqrt)]
#[kani::stub(crate::wrap, any_wrap)]
#[kani::stub(crate::bezier_point, any_bezier)]
#[kani::stub(crate::offsets, any_offsets)]
#[kani::stub(crate::eval_piece, any_pose)]
#[kani::stub(crate::refine, any_refine)]
fn project_onto_never_traps_on_a_short_piece() {
    let words = checked_words::<{ T_HEADER + PIECE_WORDS }>();
    kani::assume(words[T_HEADER + P_LENGTH] <= 16.0 * NEWTON_STEP);
    lay(&words);
    let t = Track::new(&words);
    let (x, z, hint): (f64, f64, f64) = (kani::any(), kani::any(), kani::any());
    let _ = project_onto(t, x, z, hint);
    assert!(routing_project_onto(0, x, z, hint) == 1);
}

/// Every exported function answers "no track" (0, or NaN for the speed) without trapping when the arena is too
/// small for a header, whatever the offset.
#[kani::proof]
#[kani::unwind(8)]
#[kani::stub(crate::math::atan2, any_atan2)]
#[kani::stub(crate::math::hypot, any_hypot)]
#[kani::stub(crate::math::sqrt, any_sqrt)]
#[kani::stub(crate::wrap, any_wrap)]
#[kani::stub(crate::bezier_point, any_bezier)]
#[kani::stub(crate::offsets, any_offsets)]
fn no_track_is_refused_not_trapped() {
    let words = any_words::<{ T_HEADER - 1 }>();
    lay(&words);
    let at: u32 = kani::any();
    let (s, b): (f64, f64) = (kani::any(), kani::any());
    assert!(routing_check(at) == 0);
    assert!(routing_pose_at(at, s) == 0);
    assert!(routing_next_stop(at, s, b) == 0);
    assert!(routing_speed_limit_at(at, s).is_nan());
}

/// The projection too answers "no track" without trapping on an arena too small for a header.
#[kani::proof]
#[kani::unwind(8)]
#[kani::stub(crate::math::atan2, any_atan2)]
#[kani::stub(crate::math::hypot, any_hypot)]
#[kani::stub(crate::math::sqrt, any_sqrt)]
#[kani::stub(crate::wrap, any_wrap)]
#[kani::stub(crate::bezier_point, any_bezier)]
#[kani::stub(crate::offsets, any_offsets)]
#[kani::stub(crate::eval_piece, any_pose)]
fn no_track_is_refused_by_the_projection() {
    let words = any_words::<{ T_HEADER - 1 }>();
    lay(&words);
    let at: u32 = kani::any();
    let (x, z, h): (f64, f64, f64) = (kani::any(), kani::any(), kani::any());
    assert!(routing_project_onto(at, x, z, h) == 0);
}
