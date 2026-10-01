//! The flat f64 layout of a track in the arena: one definition the host (src/06_Make_Decisions/routingWasm.ts
//! LAYOUT) repeats word for word, and `routing_layout` hands back so the host can check the two agree at load.
//!
//! Why does this file exist? The core reads tracks the host laid into linear memory; both sides must agree on where
//! every number is. What breaks if it is removed? Nothing can be laid or read.
//!
//! A track is `T_HEADER` words, then `pieces` pieces of `PIECE_WORDS` words each, then `stops` stops of `STOP_WORDS`:
//!
//! ```text
//! track:  [length, y, speedLimit, cornerSpeed, decel, pieces, stops] pieces... stops...
//! piece:  [kind, s0, length, ...]      kind 0 (line):   [x0, z0, dx, dz]
//!                                      kind 1 (corner): [ex, ez, cx, cz, xx, xz, lut[0..33]]
//! stop:   [s, axis]                    axis 0 = 'ew', 1 = 'ns'
//! ```

/// Metres around the loop; every s is taken modulo this.
pub const T_LENGTH: usize = 0;
/// Height of the track.
pub const T_Y: usize = 1;
pub const T_SPEED_LIMIT: usize = 2;
pub const T_CORNER_SPEED: usize = 3;
/// The comfortable deceleration speed_limit_at anticipates a corner with (TRAFFIC.comfortableDecel).
pub const T_DECEL: usize = 4;
/// Number of pieces (an integer stored as f64).
pub const T_PIECES: usize = 5;
/// Number of stops (an integer stored as f64).
pub const T_STOPS: usize = 6;
pub const T_HEADER: usize = 7;

/// Words per piece, whatever its kind.
pub const PIECE_WORDS: usize = 42;
pub const P_KIND: usize = 0;
pub const P_S0: usize = 1;
pub const P_LENGTH: usize = 2;
pub const KIND_LINE: f64 = 0.0;
pub const KIND_CORNER: f64 = 1.0;
/// A line: from (x0, z0) along the unit axis vector (dx, dz).
pub const P_X0: usize = 3;
pub const P_Z0: usize = 4;
pub const P_DX: usize = 5;
pub const P_DZ: usize = 6;
/// A corner: the quadratic Bézier e → c → x and its arc-length table (t at s = k · length / (LUT_SIZE − 1)).
pub const P_EX: usize = 3;
pub const P_EZ: usize = 4;
pub const P_CX: usize = 5;
pub const P_CZ: usize = 6;
pub const P_XX: usize = 7;
pub const P_XZ: usize = 8;
pub const P_LUT: usize = 9;
pub const LUT_SIZE: usize = 33;

pub const STOP_WORDS: usize = 2;
pub const S_S: usize = 0;
pub const S_AXIS: usize = 1;
pub const AXIS_EW: f64 = 0.0;
pub const AXIS_NS: f64 = 1.0;

/// Newton steps of project_onto are clamped to this many metres (tracks.ts NEWTON_STEP).
pub const NEWTON_STEP: f64 = 3.0;
/// project_onto's hint is trusted only within this lateral distance of the track (tracks.ts HINT_LATERAL).
pub const HINT_LATERAL: f64 = 5.0;

/// Words a track of `pieces` pieces and `stops` stops takes.
pub const fn track_words(pieces: usize, stops: usize) -> usize {
    T_HEADER + PIECE_WORDS * pieces + STOP_WORDS * stops
}

/// The layout as numbers, by index, for the host's load-time check (`routing_layout`).
pub const TABLE: [usize; 12] = [T_HEADER, PIECE_WORDS, STOP_WORDS, LUT_SIZE, P_LUT, P_X0, P_EX, T_PIECES, T_STOPS, T_DECEL, S_AXIS, P_S0];
