// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
//! Why does this file exist? It draws the tutorial's 3D server room with integer arithmetic only: fixed-point
//! coordinates (Q16.16 metres), a sine table built at compile time, a camera, near-plane clipping, a triangle
//! rasterizer with a depth buffer (1/z, interpolated as a plane), per-triangle fog, depth-tested points for the swarm,
//! and the cinematic pass (letterbox bars, vignette, film grain). Integer only because the bootable image is compiled
//! soft-float: a float per pixel would cost a library call per operation there. The scene (scene.rs) is baked into
//! flat arrays of triangles, a structure of arrays like everything else: no object per mesh, no method per triangle.
//! What breaks if it is removed? Nothing can be shown in three dimensions: the tutorial has no room to walk in.

use crate::hash::mix32;

/// One metre, in fixed point.
pub const ONE: i32 = 1 << 16;
/// A full turn, in angle units.
pub const TURN: i32 = 4096;
/// The near plane, metres (fixed point): nothing closer than 10 cm is drawn.
pub const NEAR: i32 = ONE / 10;

const fn sin_table() -> [i32; TURN as usize] {
    let mut t = [0i32; TURN as usize];
    let mut i = 0;
    while i < TURN as usize {
        let mut x = (i as f64) * core::f64::consts::TAU / (TURN as f64);
        if x > core::f64::consts::PI {
            x -= core::f64::consts::TAU;
        }
        let x2 = x * x;
        let mut term = x;
        let mut sum = x;
        let mut k = 1;
        while k < 12 {
            term = -term * x2 / (((2 * k) * (2 * k + 1)) as f64);
            sum += term;
            k += 1;
        }
        let v = sum * 65536.0;
        t[i] = if v >= 0.0 { (v + 0.5) as i32 } else { (v - 0.5) as i32 };
        i += 1;
    }
    t
}

static SIN: [i32; TURN as usize] = sin_table();

/// sin(a) in Q16.16, `a` in TURN units.
pub fn sin(a: i32) -> i32 {
    SIN[(a & (TURN - 1)) as usize]
}

pub fn cos(a: i32) -> i32 {
    sin(a + TURN / 4)
}

/// a × b in Q16.16.
pub fn mul(a: i32, b: i32) -> i32 {
    ((a as i64 * b as i64) >> 16) as i32
}

/// Metres (a whole number, or a fraction n/d) in fixed point.
pub const fn m(n: i32) -> i32 {
    n * ONE
}

pub const fn frac(n: i32, d: i32) -> i32 {
    ((n as i64 * ONE as i64) / d as i64) as i32
}

/// Linear blend of two 0x00RRGGBB colours, `t` in 0..=256.
pub fn blend(a: u32, b: u32, t: u32) -> u32 {
    let t = t.min(256);
    let ch = |s: u32| (((a >> s) & 0xff) * (256 - t) + ((b >> s) & 0xff) * t) >> 8;
    (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/// Scales a colour by `f`/256 (f may exceed 256: brighter, clamped).
pub fn scale(c: u32, f: u32) -> u32 {
    let ch = |s: u32| ((((c >> s) & 0xff) * f) >> 8).min(255);
    (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/// Adds two colours, clamped.
pub fn add(a: u32, b: u32) -> u32 {
    let ch = |s: u32| (((a >> s) & 0xff) + ((b >> s) & 0xff)).min(255);
    (ch(16) << 16) | (ch(8) << 8) | ch(0)
}

/// Where the eye is: a position (Q16 metres), a heading (yaw: 0 looks along +z, a quarter turn along +x), a pitch
/// (positive looks down), and the focal length in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Camera {
    pub x: i32,
    pub y: i32,
    pub z: i32,
    pub yaw: i32,
    pub pitch: i32,
    pub focal: i32,
}

/// The render target: colour and depth (1/z: larger is nearer, 0 is nothing), `w` × `h`.
pub struct Frame<'a> {
    pub color: &'a mut [u32],
    pub depth: &'a mut [u32],
    pub w: usize,
    pub h: usize,
}

/// The scene's triangles: vertex k of triangle t at (x[3t+k], y[3t+k], z[3t+k]), its colour rgb[t]. `n` are in use.
pub struct Mesh<'a> {
    pub x: &'a mut [i32],
    pub y: &'a mut [i32],
    pub z: &'a mut [i32],
    pub rgb: &'a mut [u32],
    pub n: usize,
    /// Triangles that did not fit the declared capacity.
    pub dropped: usize,
}

/// Adds a triangle; past the declared capacity it is counted, not drawn.
pub fn push_tri(mesh: &mut Mesh, a: [i32; 3], b: [i32; 3], c: [i32; 3], rgb: u32) {
    let t = mesh.n;
    if t >= mesh.rgb.len() {
        mesh.dropped += 1;
        return;
    }
    for (k, v) in [a, b, c].iter().enumerate() {
        mesh.x[3 * t + k] = v[0];
        mesh.y[3 * t + k] = v[1];
        mesh.z[3 * t + k] = v[2];
    }
    mesh.rgb[t] = rgb;
    mesh.n += 1;
}

/// A quad a-b-c-d (one winding for its front), as two triangles.
pub fn push_quad(mesh: &mut Mesh, a: [i32; 3], b: [i32; 3], c: [i32; 3], d: [i32; 3], rgb: u32) {
    push_tri(mesh, a, b, c, rgb);
    push_tri(mesh, a, c, d, rgb);
}

/// The light of the room, baked into each face's colour from its normal (Q16 unit vector): an ambient, a cool
/// overhead fill, a little more from the south and the east, and a faint crimson rim from the room's west.
pub fn shade(rgb: u32, n: [i32; 3]) -> u32 {
    let up = n[1].max(0) as u32; // 0..65536
    let west = (-n[0]).max(0) as u32;
    let east = n[0].max(0) as u32;
    let south = (-n[2]).max(0) as u32;
    let f = 150 + ((up * 110) >> 16) + ((south * 50) >> 16) + ((east * 30) >> 16);
    let base = scale(rgb, f);
    add(base, scale(0x7a0f1e, (west * 40) >> 16))
}

/// Eight corners of a box (0..3 the bottom, 4..7 the top, counter-clockwise from above) as faces, each shaded by its
/// normal. The corners may be rotated (a limb), so the normals are worked out from them.
pub fn push_hull(mesh: &mut Mesh, c: &[[i32; 3]; 8], rgb: u32) {
    const FACES: [[usize; 4]; 6] = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
    for f in FACES {
        let (a, b, cc) = (c[f[0]], c[f[1]], c[f[2]]);
        let u = [(b[0] - a[0]) as i64, (b[1] - a[1]) as i64, (b[2] - a[2]) as i64];
        let v = [(cc[0] - a[0]) as i64, (cc[1] - a[1]) as i64, (cc[2] - a[2]) as i64];
        let nx = u[1] * v[2] - u[2] * v[1];
        let ny = u[2] * v[0] - u[0] * v[2];
        let nz = u[0] * v[1] - u[1] * v[0];
        let (nx, ny, nz) = (nx as i128, ny as i128, nz as i128);
        let len = isqrt((nx * nx + ny * ny + nz * nz) as u128).max(1) as i128;
        let n = [(nx * 65536 / len) as i32, (ny * 65536 / len) as i32, (nz * 65536 / len) as i32];
        push_quad(mesh, c[f[0]], c[f[1]], c[f[2]], c[f[3]], shade(rgb, n));
    }
}

/// An axis-aligned box from `lo` to `hi`.
pub fn push_box(mesh: &mut Mesh, lo: [i32; 3], hi: [i32; 3], rgb: u32) {
    let c = [
        [lo[0], lo[1], lo[2]],
        [hi[0], lo[1], lo[2]],
        [hi[0], lo[1], hi[2]],
        [lo[0], lo[1], hi[2]],
        [lo[0], hi[1], lo[2]],
        [hi[0], hi[1], lo[2]],
        [hi[0], hi[1], hi[2]],
        [lo[0], hi[1], hi[2]],
    ];
    push_hull(mesh, &c, rgb);
}

/// A box of half-extents `half` around (0, 0, 0) in its own frame, swung by `swing` about the x axis through `pivot`
/// (its own frame), turned by `yaw` about the vertical and set down at `at` (a limb of a walking figure).
pub fn push_limb(mesh: &mut Mesh, at: [i32; 3], yaw: i32, pivot: [i32; 3], half: [i32; 3], swing: i32, rgb: u32) {
    let (ss, cs) = (sin(swing), cos(swing));
    let (sy, cy) = (sin(yaw), cos(yaw));
    let mut c = [[0i32; 3]; 8];
    for (k, corner) in c.iter_mut().enumerate() {
        let lx = if k == 1 || k == 2 || k == 5 || k == 6 { half[0] } else { -half[0] };
        let ly = if k >= 4 { half[1] } else { -half[1] };
        let lz = if k == 2 || k == 3 || k == 6 || k == 7 { half[2] } else { -half[2] };
        // Swing about x through the pivot.
        let (py, pz) = (ly - pivot[1], lz - pivot[2]);
        let (ry, rz) = (mul(py, cs) - mul(pz, ss) + pivot[1], mul(py, ss) + mul(pz, cs) + pivot[2]);
        let rx = lx;
        // Turn about the vertical, then place.
        *corner = [at[0] + mul(rx, cy) + mul(rz, sy), at[1] + ry, at[2] - mul(rx, sy) + mul(rz, cy)];
    }
    push_hull(mesh, &c, rgb);
}

/// A box that gives off its own light: every face the flat colour, unshaded (light strips, the crimson trim, LEDs).
pub fn push_glow(mesh: &mut Mesh, lo: [i32; 3], hi: [i32; 3], rgb: u32) {
    const FACES: [[usize; 4]; 6] = [[0, 1, 2, 3], [7, 6, 5, 4], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
    let c = [
        [lo[0], lo[1], lo[2]],
        [hi[0], lo[1], lo[2]],
        [hi[0], lo[1], hi[2]],
        [lo[0], lo[1], hi[2]],
        [lo[0], hi[1], lo[2]],
        [hi[0], hi[1], lo[2]],
        [hi[0], hi[1], hi[2]],
        [lo[0], hi[1], hi[2]],
    ];
    for f in FACES {
        push_quad(mesh, c[f[0]], c[f[1]], c[f[2]], c[f[3]], rgb);
    }
}

/// The angle (TURN units) whose sine and cosine point along (`s`, `c`): the camera's yaw toward a direction (x, z) on
/// the floor, or its pitch toward (-height, distance). A coarse sweep, then a search that halves its step: the dot
/// product with a direction is unimodal on the circle, so each step keeps the true angle within reach.
pub fn angle_of(s: i64, c: i64) -> i32 {
    let score = |a: i32| s * sin(a) as i64 + c * cos(a) as i64;
    let mut best = 0;
    let mut top = i64::MIN;
    for k in 0..16 {
        let a = k * (TURN / 16);
        let v = score(a);
        if v > top {
            top = v;
            best = a;
        }
    }
    let mut step = TURN / 32;
    while step > 0 {
        for a in [best - step, best + step] {
            let v = score(a);
            if v > top {
                top = v;
                best = a;
            }
        }
        step /= 2;
    }
    best & (TURN - 1)
}

/// The yaw and pitch that look from `eye` at `target`.
pub fn look_at(eye: [i32; 3], target: [i32; 3]) -> (i32, i32) {
    let (dx, dy, dz) = ((target[0] - eye[0]) as i64, (target[1] - eye[1]) as i64, (target[2] - eye[2]) as i64);
    let yaw = angle_of(dx, dz);
    let flat = isqrt((dx * dx + dz * dz) as u128) as i64;
    let pitch = angle_of(-dy, flat);
    // A pitch past straight down or up wraps; keep it within a quarter turn either way.
    let pitch = if pitch > TURN / 2 { pitch - TURN } else { pitch };
    (yaw, pitch.clamp(-TURN / 4 + 1, TURN / 4 - 1))
}

/// `a` to `b` by `t` of 65536 (fixed point), per component.
pub fn lerp3(a: [i32; 3], b: [i32; 3], t: i32) -> [i32; 3] {
    [a[0] + mul(b[0] - a[0], t), a[1] + mul(b[1] - a[1], t), a[2] + mul(b[2] - a[2], t)]
}

/// Smoothstep of `t` (0..=65536): starts and stops gently.
pub fn ease(t: i32) -> i32 {
    let t = t.clamp(0, ONE);
    mul(mul(t, t), 3 * ONE - 2 * t)
}

/// The integer square root of `v` (floor).
pub fn isqrt(v: u128) -> u128 {
    if v < 2 {
        return v;
    }
    let mut x = 1u128 << ((128 - v.leading_zeros()).div_ceil(2));
    loop {
        let y = (x + v / x) / 2;
        if y >= x {
            return x;
        }
        x = y;
    }
}

/// A point in camera space (Q16): right, up, forward.
fn to_camera(cam: &Camera, p: [i32; 3]) -> [i64; 3] {
    let (dx, dy, dz) = ((p[0] - cam.x) as i64, (p[1] - cam.y) as i64, (p[2] - cam.z) as i64);
    let (s, c) = (sin(cam.yaw) as i64, cos(cam.yaw) as i64);
    let x1 = (dx * c - dz * s) >> 16;
    let z1 = (dx * s + dz * c) >> 16;
    let (sp, cp) = (sin(cam.pitch) as i64, cos(cam.pitch) as i64);
    let y2 = (dy * cp + z1 * sp) >> 16;
    let z2 = (z1 * cp - dy * sp) >> 16;
    [x1, y2, z2]
}

/// A camera-space point on screen: x and y in 28.4 (sixteenths of a pixel), and 1/z for the depth test.
fn project(w: usize, h: usize, focal: i32, p: [i64; 3]) -> [i64; 3] {
    let z = p[2].max(NEAR as i64);
    let sx = ((w as i64) << 3) + ((p[0] * focal as i64) << 4) / z;
    let sy = ((h as i64) << 3) - ((p[1] * focal as i64) << 4) / z;
    [sx.clamp(-(1 << 24), 1 << 24), sy.clamp(-(1 << 24), 1 << 24), (1i64 << 32) / z]
}

/// What the room fades into with distance, and over which depths (metres, fixed point).
#[derive(Clone, Copy)]
pub struct Fog {
    pub rgb: u32,
    pub near: i32,
    pub far: i32,
}

fn fogged(rgb: u32, z: i64, fog: &Fog) -> u32 {
    let t = ((z - fog.near as i64) * 230 / (fog.far - fog.near).max(1) as i64).clamp(0, 230) as u32;
    blend(rgb, fog.rgb, t)
}

/// Fills one screen-space triangle (counter-clockwise on screen is its front; the back is not drawn).
fn raster(f: &mut Frame, v: [[i64; 3]; 3], rgb: u32) {
    let [a, b, c] = v;
    let area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if area <= 0 {
        return;
    }
    let minx = ((a[0].min(b[0]).min(c[0])) >> 4).max(0);
    let maxx = (((a[0].max(b[0]).max(c[0])) + 15) >> 4).min(f.w as i64 - 1);
    let miny = ((a[1].min(b[1]).min(c[1])) >> 4).max(0);
    let maxy = (((a[1].max(b[1]).max(c[1])) + 15) >> 4).min(f.h as i64 - 1);
    if minx > maxx || miny > maxy {
        return;
    }
    // Edge functions at the first pixel centre, and their steps per pixel.
    let edge = |p: [i64; 3], q: [i64; 3], x: i64, y: i64| (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]);
    let (x0, y0) = (minx * 16 + 8, miny * 16 + 8);
    let mut row = [edge(b, c, x0, y0), edge(c, a, x0, y0), edge(a, b, x0, y0)];
    let dx = [-(c[1] - b[1]) * 16, -(a[1] - c[1]) * 16, -(b[1] - a[1]) * 16];
    let dy = [(c[0] - b[0]) * 16, (a[0] - c[0]) * 16, (b[0] - a[0]) * 16];
    // 1/z as a plane over the screen (Q16 fraction kept), its steps per pixel.
    let (dz1, dz2) = (b[2] - a[2], c[2] - a[2]);
    let zdx = (((dz1 * (c[1] - a[1]) - dz2 * (b[1] - a[1])) << 16) / area) * 16;
    let zdy = (((dz2 * (b[0] - a[0]) - dz1 * (c[0] - a[0])) << 16) / area) * 16;
    let mut zrow = (a[2] << 16) + (((x0 - a[0]) * zdx + (y0 - a[1]) * zdy) >> 4);
    for py in miny..=maxy {
        let mut e = row;
        let mut z = zrow;
        let base = py as usize * f.w;
        for px in minx..=maxx {
            if (e[0] | e[1] | e[2]) >= 0 {
                let d = (z >> 16).clamp(1, u32::MAX as i64) as u32;
                let i = base + px as usize;
                if d > f.depth[i] {
                    f.depth[i] = d;
                    f.color[i] = rgb;
                }
            }
            e[0] += dx[0];
            e[1] += dx[1];
            e[2] += dx[2];
            z += zdx;
        }
        row[0] += dy[0];
        row[1] += dy[1];
        row[2] += dy[2];
        zrow += zdy;
    }
}

/// Clears colour and depth.
pub fn clear(f: &mut Frame, rgb: u32) {
    f.color.fill(rgb);
    f.depth.fill(0);
}

/// Draws triangles `from..to` of the mesh. Returns how many reached the screen.
pub fn draw(f: &mut Frame, cam: &Camera, mesh: &Mesh, from: usize, to: usize, fog: &Fog) -> usize {
    let mut drawn = 0;
    for t in from..to.min(mesh.n) {
        let mut cs = [[0i64; 3]; 3];
        for (k, c) in cs.iter_mut().enumerate() {
            *c = to_camera(cam, [mesh.x[3 * t + k], mesh.y[3 * t + k], mesh.z[3 * t + k]]);
        }
        let near = NEAR as i64;
        let behind = cs.iter().filter(|c| c[2] < near).count();
        if behind == 3 {
            continue;
        }
        let zavg = (cs[0][2] + cs[1][2] + cs[2][2]) / 3;
        let rgb = fogged(mesh.rgb[t], zavg, fog);
        if behind == 0 {
            raster(f, [project(f.w, f.h, cam.focal, cs[0]), project(f.w, f.h, cam.focal, cs[1]), project(f.w, f.h, cam.focal, cs[2])], rgb);
            drawn += 1;
            continue;
        }
        // Clipped against the near plane: the polygon's part in front of it, as a fan.
        let mut poly = [[0i64; 3]; 4];
        let mut n = 0;
        for k in 0..3 {
            let (p, q) = (cs[k], cs[(k + 1) % 3]);
            if p[2] >= near {
                poly[n] = p;
                n += 1;
            }
            if (p[2] >= near) != (q[2] >= near) {
                let t = ((near - p[2]) << 16) / (q[2] - p[2]);
                poly[n] = [p[0] + (((q[0] - p[0]) * t) >> 16), p[1] + (((q[1] - p[1]) * t) >> 16), near];
                n += 1;
            }
        }
        for k in 1..n.saturating_sub(1) {
            let tri = [poly[0], poly[k], poly[k + 1]];
            raster(f, [project(f.w, f.h, cam.focal, tri[0]), project(f.w, f.h, cam.focal, tri[1]), project(f.w, f.h, cam.focal, tri[2])], rgb);
        }
        drawn += 1;
    }
    drawn
}

/// Projects a world point; None when it is behind the eye or off screen. Some((x, y, 1/z)).
pub fn screen_of(f: &Frame, cam: &Camera, p: [i32; 3]) -> Option<(i32, i32, u32)> {
    let c = to_camera(cam, p);
    if c[2] < NEAR as i64 {
        return None;
    }
    let s = project(f.w, f.h, cam.focal, c);
    let (x, y) = ((s[0] >> 4) as i32, (s[1] >> 4) as i32);
    ((0..f.w as i32).contains(&x) && (0..f.h as i32).contains(&y)).then_some((x, y, s[2].clamp(1, u32::MAX as i64) as u32))
}

/// A depth-tested square dot of `size` pixels at a world point (one agent of the swarm).
pub fn dot(f: &mut Frame, cam: &Camera, p: [i32; 3], size: i32, rgb: u32) {
    if let Some((x, y, d)) = screen_of(f, cam, p) {
        for yy in y..(y + size).min(f.h as i32) {
            for xx in x..(x + size).min(f.w as i32) {
                let i = yy as usize * f.w + xx as usize;
                if d >= f.depth[i] {
                    f.depth[i] = d;
                    f.color[i] = rgb;
                }
            }
        }
    }
}

/// The cinematic pass: black bars of `bar` rows top and bottom, a vignette, and grain that changes every frame.
pub fn cinematic(f: &mut Frame, frame: u32, bar: usize) {
    let (w, h) = (f.w as i64, f.h as i64);
    let reach = (w * w / 4) * 5 + (h * h / 4) * 9;
    for y in 0..f.h {
        let row = &mut f.color[y * f.w..(y + 1) * f.w];
        if y < bar || y >= f.h - bar {
            row.fill(0);
            continue;
        }
        let dy = y as i64 - h / 2;
        for (x, px) in row.iter_mut().enumerate() {
            let dx = x as i64 - w / 2;
            let v = (256 - (dx * dx * 5 + dy * dy * 9) * 150 / reach).clamp(96, 256) as u32;
            let g = (mix32((y as u32 * 0x9e37) ^ (x as u32) ^ frame.wrapping_mul(0x85eb_ca6b)) & 15) as i32 - 8;
            let c = scale(*px, v);
            let ch = |s: u32| (((c >> s) & 0xff) as i32 + g).clamp(0, 255) as u32;
            *px = (ch(16) << 16) | (ch(8) << 8) | ch(0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::vec;

    #[test]
    fn the_sine_table_is_the_sine() {
        for a in (0..TURN).step_by(37) {
            let want = ((a as f64) * std::f64::consts::TAU / TURN as f64).sin() * 65536.0;
            assert!((sin(a) as f64 - want).abs() <= 1.0, "sin({a})");
            assert!(((sin(a) as i64).pow(2) + (cos(a) as i64).pow(2) - (1i64 << 32)).abs() < 1 << 18);
        }
        assert_eq!(isqrt(1 << 40), 1 << 20);
        assert_eq!(isqrt(99), 9);
    }

    fn frame(w: usize, h: usize) -> (std::vec::Vec<u32>, std::vec::Vec<u32>) {
        (vec![0; w * h], vec![0; w * h])
    }

    #[test]
    fn a_box_in_front_of_the_eye_is_drawn_and_the_nearer_of_two_wins() {
        let (w, h) = (160, 90);
        let (mut color, mut depth) = frame(w, h);
        let (mut x, mut y, mut z, mut rgb) = (vec![0; 300], vec![0; 300], vec![0; 300], vec![0; 100]);
        let mut mesh = Mesh { x: &mut x, y: &mut y, z: &mut z, rgb: &mut rgb, n: 0, dropped: 0 };
        // A far red box and a near green one, both straight ahead.
        push_box(&mut mesh, [m(-1), m(-1), m(9)], [m(1), m(1), m(11)], 0xff0000);
        push_box(&mut mesh, [frac(-1, 5), frac(-1, 5), m(4)], [frac(1, 5), frac(1, 5), m(5)], 0x00ff00);
        let cam = Camera { x: 0, y: 0, z: 0, yaw: 0, pitch: 0, focal: 100 };
        let mut f = Frame { color: &mut color, depth: &mut depth, w, h };
        let fog = Fog { rgb: 0, near: m(100), far: m(200) };
        let n = mesh.n;
        assert_eq!(draw(&mut f, &cam, &mesh, 0, n, &fog), 24);
        let at = |x: usize, y: usize| f.color[y * w + x];
        let centre = at(80, 45);
        assert!(centre & 0x00ff00 != 0 && centre & 0xff0000 == 0, "the near green box covers the centre: {centre:06x}");
        // Beside the green box (5 px each side) but inside the red one's silhouette (11 px): red.
        assert!(at(80 - 8, 45) & 0xff0000 != 0, "{:06x}", at(72, 45));
        assert!(at(80 + 8, 45) & 0xff0000 != 0, "{:06x}", at(88, 45));
        // Outside both: nothing.
        assert_eq!(at(80 - 14, 45), 0);
        assert_eq!(at(5, 5), 0);
    }

    #[test]
    fn the_eye_inside_geometry_or_looking_anywhere_never_panics_or_draws_outside() {
        let (w, h) = (64, 36);
        let (mut color, mut depth) = frame(w, h);
        let (mut x, mut y, mut z, mut rgb) = (vec![0; 3000], vec![0; 3000], vec![0; 3000], vec![0; 1000]);
        let mut mesh = Mesh { x: &mut x, y: &mut y, z: &mut z, rgb: &mut rgb, n: 0, dropped: 0 };
        for k in 0..20 {
            push_box(&mut mesh, [m(k - 10), m(-1), m(-3)], [m(k - 9), m(2), m(3)], 0x808080);
        }
        push_limb(&mut mesh, [m(0), m(1), m(0)], 300, [0, frac(1, 2), 0], [frac(1, 5), frac(1, 2), frac(1, 5)], 200, 0x404040);
        let fog = Fog { rgb: 0x101010, near: m(2), far: m(30) };
        for yaw in (0..TURN).step_by(173) {
            for pitch in [-900, -300, 0, 400, 1000] {
                let mut f = Frame { color: &mut color, depth: &mut depth, w, h };
                clear(&mut f, 0);
                let cam = Camera { x: m(0), y: m(0), z: frac(1, 3), yaw, pitch, focal: 40 };
                let n = mesh.n;
                draw(&mut f, &cam, &mesh, 0, n, &fog);
                dot(&mut f, &cam, [m(0), m(0), m(2)], 3, 0xffffff);
                cinematic(&mut f, yaw as u32, 4);
            }
        }
        // Past the declared capacity a triangle is counted, not written.
        let full = mesh.rgb.len();
        mesh.n = full;
        push_box(&mut mesh, [0; 3], [ONE; 3], 1);
        assert_eq!((mesh.n, mesh.dropped), (full, 12));
    }
}
