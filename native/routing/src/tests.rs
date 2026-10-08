// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Unit tests on the host target: a 2 × 2-block car ring laid out exactly as tracks.ts ring() lays it (pitch 40 m,
//! entry 7.5 m, lane offset 2 m, stop line 8.8 m, half-length 2.3 m), and hand-computed values on it. The bit-for-bit
//! parity with the TypeScript reference is proved from the host side (src/06_Make_Decisions/routingWasm.test.ts).

use super::*;
use std::vec::Vec;

const PITCH: f64 = 40.0;
const ENTRY: f64 = 7.5;
const LANE: f64 = 2.0;
const STOP_LINE: f64 = 8.8;
const HALF_LENGTH: f64 = 2.3;
const ROAD_HALF: f64 = 4.0;
const STOP_CLEAR: f64 = STOP_LINE + ROAD_HALF + 2.0 * HALF_LENGTH;
const SPEED_LIMIT: f64 = 40.0 / 3.6;
const CORNER_SPEED: f64 = 5.5;
const DECEL: f64 = 3.0;

fn right(d: (f64, f64)) -> (f64, f64) {
    (-d.1, d.0)
}

/// tracks.ts cornerPiece: 256 chords integrate the length, then t is read at equal steps of s (as f32).
fn corner(s0: f64, e: (f64, f64), c: (f64, f64), x: (f64, f64)) -> (Vec<f64>, f64) {
    let bez = |t: f64| {
        let u = 1.0 - t;
        (u * u * e.0 + 2.0 * u * t * c.0 + t * t * x.0, u * u * e.1 + 2.0 * u * t * c.1 + t * t * x.1)
    };
    const N: usize = 256;
    let mut cum = [0.0f64; N + 1];
    let (mut px, mut pz) = e;
    for i in 1..=N {
        let (qx, qz) = bez(i as f64 / N as f64);
        cum[i] = cum[i - 1] + hypot(qx - px, qz - pz);
        px = qx;
        pz = qz;
    }
    let length = cum[N];
    let mut words = std::vec![0.0; PIECE_WORDS];
    words[P_KIND] = KIND_CORNER;
    words[P_S0] = s0;
    words[P_LENGTH] = length;
    words[P_EX] = e.0;
    words[P_EZ] = e.1;
    words[P_CX] = c.0;
    words[P_CZ] = c.1;
    words[P_XX] = x.0;
    words[P_XZ] = x.1;
    let mut j = 0;
    for k in 0..LUT_SIZE {
        let goal = (k as f64 / (LUT_SIZE - 1) as f64) * length;
        while j < N - 1 && cum[j + 1] < goal {
            j += 1;
        }
        let span = cum[j + 1] - cum[j];
        let t = (j as f64 + if span > 0.0 { (goal - cum[j]) / span } else { 0.0 }) / N as f64;
        words[P_LUT + k] = (t as f32) as f64;
    }
    words[P_LUT + LUT_SIZE - 1] = 1.0;
    (words, length)
}

fn line(s0: f64, x0: f64, z0: f64, d: (f64, f64), length: f64) -> Vec<f64> {
    let mut words = std::vec![0.0; PIECE_WORDS];
    words[P_KIND] = KIND_LINE;
    words[P_S0] = s0;
    words[P_LENGTH] = length;
    words[P_X0] = x0;
    words[P_Z0] = z0;
    words[P_DX] = d.0;
    words[P_DZ] = d.1;
    words
}

/// The clockwise ring of the 2 × 2-block cell at the origin: four 65 m straights and four right-turn corners, a stop
/// line at every intersection (tracks.ts ring()).
fn ring() -> Vec<f64> {
    let corners: [(f64, f64); 4] = [(0.0, 0.0), (2.0, 0.0), (2.0, 2.0), (0.0, 2.0)];
    let mut pieces: Vec<Vec<f64>> = Vec::new();
    let mut stops: Vec<(f64, f64)> = Vec::new();
    let mut s = 0.0;
    for i in 0..4 {
        let (a, b, c) = (corners[i], corners[(i + 1) % 4], corners[(i + 2) % 4]);
        let dir = ((b.0 - a.0).signum() * f64::from(b.0 != a.0), (b.1 - a.1).signum() * f64::from(b.1 != a.1));
        let next = ((c.0 - b.0).signum() * f64::from(c.0 != b.0), (c.1 - b.1).signum() * f64::from(c.1 != b.1));
        let blocks = 2.0;
        let r = right(dir);
        let x0 = a.0 * PITCH + dir.0 * ENTRY + r.0 * LANE;
        let z0 = a.1 * PITCH + dir.1 * ENTRY + r.1 * LANE;
        let length = blocks * PITCH - 2.0 * ENTRY;
        pieces.push(line(s, x0, z0, dir, length));
        let axis = if dir.0 != 0.0 { AXIS_EW } else { AXIS_NS };
        for j in 1..=2 {
            stops.push((s + j as f64 * PITCH - ENTRY - STOP_LINE - HALF_LENGTH, axis));
        }
        s += length;
        let bpt = (b.0 * PITCH, b.1 * PITCH);
        let (r1, r2) = (right(dir), right(next));
        let e = (bpt.0 - dir.0 * ENTRY + r1.0 * LANE, bpt.1 - dir.1 * ENTRY + r1.1 * LANE);
        let x = (bpt.0 + next.0 * ENTRY + r2.0 * LANE, bpt.1 + next.1 * ENTRY + r2.1 * LANE);
        let ctrl = (bpt.0 + r1.0 * LANE - dir.0 * LANE, bpt.1 + r1.1 * LANE - dir.1 * LANE);
        let (words, len) = corner(s, e, ctrl, x);
        pieces.push(words);
        s += len;
    }
    let mut words = std::vec![0.0; T_HEADER];
    words[T_LENGTH] = s;
    words[T_Y] = 0.0;
    words[T_SPEED_LIMIT] = SPEED_LIMIT;
    words[T_CORNER_SPEED] = CORNER_SPEED;
    words[T_DECEL] = DECEL;
    words[T_PIECES] = pieces.len() as f64;
    words[T_STOPS] = stops.len() as f64;
    for p in pieces {
        words.extend(p);
    }
    for (s, axis) in stops {
        words.push(s);
        words.push(axis);
    }
    words
}

fn near(a: f64, b: f64, tol: f64) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn the_ring_is_well_formed_and_closed() {
    let w = ring();
    assert!(Track::check(&w));
    let t = Track::new(&w);
    assert_eq!(t.pieces(), 8);
    assert_eq!(t.stops(), 8);
    assert_eq!(t.words(), w.len());
    let corner_len = t.piece(1)[P_LENGTH];
    assert!(near(t.length(), 4.0 * (65.0 + corner_len), 1e-9));
    // A corner of two 5.5 m legs at a right angle is longer than the chord and shorter than the legs.
    assert!(corner_len > 7.78 && corner_len < 11.0, "corner {corner_len}");
    // The corner ends where the next straight begins.
    let end = pose_at(t, 65.0 + corner_len);
    assert!(near(end.x, 78.0, 1e-9) && near(end.z, 7.5, 1e-9));
    let start = pose_at(t, 65.0);
    assert!(near(start.x, 72.5, 1e-12) && near(start.z, 2.0, 1e-12));
}

#[test]
fn wrap_and_piece_at() {
    let w = ring();
    let t = Track::new(&w);
    let l = t.length();
    assert_eq!(wrap(l, 0.0), 0.0);
    assert_eq!(wrap(l, l), 0.0);
    assert!(near(wrap(l, -1.0), l - 1.0, 1e-12));
    assert!(near(wrap(l, 2.0 * l + 3.0), 3.0, 1e-9));
    assert_eq!(piece_at(t, 0.0), 0);
    assert_eq!(piece_at(t, 64.999), 0);
    assert_eq!(piece_at(t, 65.0), 1);
    assert_eq!(piece_at(t, l - 1e-9), 7);
}

#[test]
fn poses_on_a_straight_and_through_a_corner_by_hand() {
    let w = ring();
    let t = Track::new(&w);
    let p = pose_at(t, 10.0);
    assert_eq!((p.x, p.z, p.tangent_x, p.tangent_z), (17.5, 2.0, 1.0, 0.0));
    assert_eq!(p.heading, core::f64::consts::FRAC_PI_2);
    // Wrapped: a lap on is the same pose.
    let q = pose_at(t, 10.0 + t.length());
    assert!(near(q.x, p.x, 1e-9) && near(q.z, p.z, 1e-9));
    // The corner's arc-length midpoint is its Bézier midpoint (symmetric legs): (76.625, 3.375), tangent at 45°.
    let corner_len = t.piece(1)[P_LENGTH];
    let m = pose_at(t, 65.0 + corner_len / 2.0);
    assert!(near(m.x, 76.625, 2e-3) && near(m.z, 3.375, 2e-3), "{m:?}");
    assert!(near(m.tangent_x, core::f64::consts::FRAC_1_SQRT_2, 2e-3) && near(m.tangent_z, core::f64::consts::FRAC_1_SQRT_2, 2e-3));
    assert!(near(m.heading, core::f64::consts::FRAC_PI_4, 2e-3));
    // Entering the corner the tangent is the straight's; leaving it, the next straight's (0, 1).
    let a = pose_at(t, 65.0);
    assert_eq!((a.tangent_x, a.tangent_z), (1.0, 0.0));
    let b = pose_at(t, 65.0 + corner_len);
    assert!(near(b.tangent_x, 0.0, 1e-12) && near(b.tangent_z, 1.0, 1e-12));
}

#[test]
fn projection_by_hand_with_and_without_a_hint() {
    let w = ring();
    let t = Track::new(&w);
    // 1 m to the right of travel on the first straight (right of +x travel is +z).
    let (s, lateral) = project_onto(t, 17.5, 3.0, f64::NAN);
    assert_eq!((s, lateral), (10.0, 1.0));
    // A fresh hint converges in one step; a stale one two pieces away falls back to the global search.
    assert_eq!(project_onto(t, 17.5, 3.0, 9.0), (10.0, 1.0));
    assert_eq!(project_onto(t, 17.5, 3.0, 200.0), (10.0, 1.0));
    // 0.5 m to the left of travel on the second straight (travel +z; left is +x... right of +z travel is −x).
    let (s2, lat2) = project_onto(t, 78.5, 20.0, f64::NAN);
    let corner_len = t.piece(1)[P_LENGTH];
    assert!(near(s2, 65.0 + corner_len + 12.5, 1e-9), "{s2}");
    assert!(near(lat2, -0.5, 1e-12), "{lat2}");
    // A point on the corner projects back to where it was taken from.
    for k in 1..8 {
        let s0 = 65.0 + corner_len * k as f64 / 8.0;
        let p = pose_at(t, s0);
        let (s1, l1) = project_onto(t, p.x, p.z, f64::NAN);
        assert!(near(s1, s0, 1e-6), "{s0} → {s1}");
        assert!(near(l1, 0.0, 1e-6));
        let (s3, _) = project_onto(t, p.x, p.z, s0 + 2.0);
        assert!(near(s3, s0, 1e-6), "{s0} → {s3} from a hint 2 m on");
    }
}

#[test]
fn next_stop_holds_a_passed_line_until_the_box_is_cleared() {
    let w = ring();
    let t = Track::new(&w);
    let corner_len = t.piece(1)[P_LENGTH];
    // At s = 0 the last straight's second stop line (61.4 m into a 65 m straight, so 3.6 m + a corner behind) is
    // still current: passed by less than STOP_CLEAR, and the distance is negative.
    let z = next_stop(t, 0.0, STOP_CLEAR).unwrap();
    assert!(near(z.s, t.length() - 3.6 - corner_len, 1e-9) && z.axis == AXIS_NS && near(z.distance, -3.6 - corner_len, 1e-9), "{z:?}");
    let a = next_stop(t, 10.0, STOP_CLEAR).unwrap();
    assert!(near(a.s, 21.4, 1e-12) && a.axis == AXIS_EW && near(a.distance, 11.4, 1e-9), "{a:?}");
    let b = next_stop(t, 30.0, STOP_CLEAR).unwrap();
    assert!(near(b.s, 21.4, 1e-12) && near(b.distance, -8.6, 1e-9), "{b:?}");
    let c = next_stop(t, 40.0, STOP_CLEAR).unwrap();
    assert!(near(c.s, 61.4, 1e-12) && near(c.distance, 21.4, 1e-9), "{c:?}");
    // The second straight's stops are 'ns'; 10 m into it the first straight's last line is 13.6 m + a corner behind.
    let d = next_stop(t, 65.0 + corner_len + 10.0, STOP_CLEAR).unwrap();
    assert_eq!(d.axis, AXIS_NS);
    assert!(near(d.distance, 11.4, 1e-9), "{d:?}");
    // A track without stops has none.
    let mut bare = ring();
    bare[T_STOPS] = 0.0;
    bare.truncate(T_HEADER + 8 * PIECE_WORDS);
    assert!(Track::check(&bare));
    assert_eq!(next_stop(Track::new(&bare), 0.0, STOP_CLEAR), None);
}

#[test]
fn speed_limit_anticipates_the_corner_and_holds_corner_speed_inside_it() {
    let w = ring();
    let t = Track::new(&w);
    assert_eq!(corner_ahead(t, 0.0), 65.0);
    assert_eq!(speed_limit_at(t, 0.0), SPEED_LIMIT);
    assert_eq!(corner_ahead(t, 60.0), 5.0);
    assert!(near(speed_limit_at(t, 60.0), 60.25f64.sqrt(), 1e-12));
    assert_eq!(corner_ahead(t, 66.0), 0.0);
    assert_eq!(speed_limit_at(t, 66.0), CORNER_SPEED);
    // On a loop of straights nothing is ahead and the limit holds everywhere.
    let mut straight = std::vec![0.0; T_HEADER];
    straight[T_LENGTH] = 100.0;
    straight[T_SPEED_LIMIT] = 9.0;
    straight[T_CORNER_SPEED] = 4.0;
    straight[T_DECEL] = DECEL;
    straight[T_PIECES] = 1.0;
    straight.extend(line(0.0, 0.0, 0.0, (1.0, 0.0), 100.0));
    let st = Track::new(&straight);
    assert_eq!(corner_ahead(st, 3.0), f64::INFINITY);
    assert_eq!(speed_limit_at(st, 3.0), 9.0);
}

#[test]
fn hypot_is_the_engines_kahan_form_and_the_js_min_max_keep_the_zeros() {
    assert_eq!(hypot(3.0, 4.0), 5.0);
    assert_eq!(hypot(-3.0, 4.0), 5.0);
    assert_eq!(hypot(0.0, 0.0), 0.0);
    assert_eq!(hypot(1e308, 1e308), core::f64::consts::SQRT_2 * 1e308);
    assert_eq!(hypot(f64::NAN, f64::INFINITY), f64::INFINITY);
    assert!(hypot(f64::NAN, 1.0).is_nan());
    // (0.1, 0.2): the Kahan form and the naive sqrt(x² + z²) agree here; a value both must give.
    assert_eq!(hypot(0.1, 0.2), (0.1f64 * 0.1 + 0.2 * 0.2).sqrt());
    assert!(jmax(0.0, -0.0).is_sign_positive() && jmax(-0.0, 0.0).is_sign_positive());
    assert!(jmin(0.0, -0.0).is_sign_negative() && jmin(-0.0, 0.0).is_sign_negative());
    assert_eq!(jmax(-3.0, jmin(3.0, 7.0)), 3.0);
    assert_eq!(jmax(-3.0, jmin(3.0, -7.0)), -3.0);
    assert_eq!(jmax(-3.0, jmin(3.0, 0.5)), 0.5);
}

#[test]
fn check_refuses_a_malformed_or_truncated_track() {
    let w = ring();
    assert!(Track::check(&w));
    assert!(!Track::check(&w[..w.len() - 1]), "one word short");
    assert!(!Track::check(&w[..3]), "no header");
    let mut bad = ring();
    bad[T_HEADER + P_KIND] = 2.0;
    assert!(!Track::check(&bad), "a piece of no known kind");
    let mut none = ring();
    none[T_PIECES] = 0.0;
    assert!(!Track::check(&none), "no pieces");
    let mut frac = ring();
    frac[T_PIECES] = 7.5;
    assert!(!Track::check(&frac), "a fractional count");
    let mut back = ring();
    back[T_HEADER + PIECE_WORDS + P_S0] = 1.0e9;
    assert!(!Track::check(&back), "s0 out of order");
    let mut late = ring();
    late[T_HEADER + P_S0] = 1.0;
    assert!(!Track::check(&late), "the first piece must start at 0");
    let mut axis = ring();
    axis[T_HEADER + 8 * PIECE_WORDS + S_AXIS] = 2.0;
    assert!(!Track::check(&axis), "an axis of neither kind");
}

#[test]
fn the_c_abi_reads_the_arena_and_refuses_what_does_not_fit() {
    let track = ring();
    let n = track.len();
    // An arena holding the ring at 0 and one word too few for a second copy at `n`.
    let mut arena = std::vec![0.0; 2 * n - 1];
    arena[..n].copy_from_slice(&track);
    arena[n..].copy_from_slice(&track[..n - 1]);
    unsafe { set_arena(arena.as_ptr(), arena.len()) };
    assert_eq!(routing_check(0), 1);
    assert_eq!(routing_check(n as u32), 0, "the second copy overruns the arena");
    assert_eq!(routing_check((2 * n) as u32), 0, "past the arena");
    assert_eq!(routing_check((n - 3) as u32), 0, "a header of zeros is no track");
    // routing_out() is a 32-bit linear-memory address: on the host the block is read by its real address.
    let out = unsafe { core::slice::from_raw_parts(core::ptr::addr_of!(OUT) as *const f64, OUT_WORDS) };
    assert_eq!(routing_out(), core::ptr::addr_of!(OUT) as usize as u32);
    assert_eq!(routing_pose_at(0, 10.0), 1);
    assert_eq!(&out[..6], &[17.5, 0.0, 2.0, core::f64::consts::FRAC_PI_2, 1.0, 0.0]);
    assert_eq!(routing_pose_at(n as u32, 10.0), 0);
    assert_eq!(routing_project_onto(0, 17.5, 3.0, f64::NAN), 1);
    assert_eq!(&out[..2], &[10.0, 1.0]);
    assert_eq!(routing_next_stop(0, 10.0, STOP_CLEAR), 1);
    assert!(near(out[0], 21.4, 1e-12) && out[1] == AXIS_EW && near(out[2], 11.4, 1e-9), "{:?}", &out[..3]);
    assert_eq!(routing_speed_limit_at(0, 0.0), SPEED_LIMIT);
    assert!(routing_speed_limit_at((2 * n) as u32, 0.0).is_nan());
    assert_eq!(routing_next_stop((2 * n) as u32, 0.0, STOP_CLEAR), 0);
    for (i, &v) in TABLE.iter().enumerate() {
        assert_eq!(routing_layout(i as u32) as usize, v);
    }
    assert_eq!(routing_layout(TABLE.len() as u32), 0);
    // routing_arena: alignment and an empty arena are refused; a well-aligned Vec is taken.
    assert_eq!(routing_arena(8, 0), 0);
    assert_eq!(routing_arena(12, 4), 0);
    unsafe { set_arena(core::ptr::null(), 0) };
    assert_eq!(routing_check(0), 0, "no arena, no track");
}
