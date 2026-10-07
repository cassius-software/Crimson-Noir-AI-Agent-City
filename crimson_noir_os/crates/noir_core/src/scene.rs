//! Why does this file exist? It builds the tutorial's room from the system's own data. The server room is the swarm's
//! floor: every rack stands where the Global Matrix has a wall, every docking pad where it has a station, half a metre
//! to a cell, so what the tutorial shows is the state it tests. It also stages the five whys along the real aisles
//! (where the camera stands, where the tutor walks, where the containment cage, the crash cart and the sorting table
//! go), and draws the tutor: a figure in business attire (a charcoal blazer, a white shirt, a crimson tie). The room
//! is baked once into the declared triangle arrays; the moving parts are appended after it every frame.
//! What breaks if it is removed? The tutorial has no room, no tutor and nothing to sort on.

use crate::config::Dims;
use crate::matrix::{Matrix, RACK_EVERY, RACK_MARGIN};
use crate::render::{self, Camera, Frame, Mesh, ONE, TURN, frac, m, mul, push_box, push_glow, push_limb, push_quad};

/// One cell of the swarm's floor, in metres (fixed point).
pub const CELL: i32 = ONE / 2;
pub const RACK_TOP: i32 = frac(22, 10);
pub const WALL_TOP: i32 = m(4);
/// The sorting table's height, and the gap between its file slots.
pub const TABLE_TOP: i32 = frac(78, 100);
pub const SLOT_GAP: i32 = frac(36, 100);

const FLOOR_A: u32 = 0x24262e;
const FLOOR_B: u32 = 0x1b1c22;
const WALL: u32 = 0x16161b;
const RACK: u32 = 0x202229;
const PANEL: u32 = 0x313541;
const CRIMSON: u32 = 0xc8102e;
const TRIM: u32 = 0x9a0c22;
const STRIP: u32 = 0xc9d0e0;
const PAD: u32 = 0x4a0a14;
const STEEL: u32 = 0x7d828f;

/// The centre of cell column (or row) `c`, in metres.
pub fn cell_mid(c: i32) -> i32 {
    c * CELL + CELL / 2
}

/// A cell index's centre on the floor, in metres (x, z).
pub fn cell_at(d: &Dims, c: u32) -> [i32; 2] {
    [cell_mid((c % d.width as u32) as i32), cell_mid((c / d.width as u32) as i32)]
}

/// The centre line of aisle `k` (between rack rows k and k + 1), in metres; clamped to the aisles the floor has.
pub fn aisle_z(d: &Dims, k: i32) -> i32 {
    let rows = (d.depth / RACK_EVERY) as i32;
    let k = k.clamp(0, rows - 1);
    cell_mid(k * RACK_EVERY as i32 + RACK_EVERY as i32 / 2)
}

/// Cell column `c` of the default 64-cell floor, scaled to this floor's width, in metres.
fn col(d: &Dims, c: i32) -> i32 {
    cell_mid((c * d.width as i32 / 64).clamp(1, d.width as i32 - 2))
}

/// One shot of the tutorial: the camera moves from `eye[0]` to `eye[1]` while looking from `target[0]` to `target[1]`;
/// the tutor walks from `tutor[0]` to `tutor[1]` (the same spot when it stands) and then faces `face` (TURN units).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Shot {
    pub eye: [[i32; 3]; 2],
    pub target: [[i32; 3]; 2],
    pub focal: i32,
    pub tutor: [[i32; 2]; 2],
    pub face: i32,
}

/// The shots, in order.
pub const INTRO: usize = 0;
pub const MEMORY: usize = 1;
pub const COMPUTE: usize = 2;
pub const CONTAINMENT: usize = 3;
pub const DISPLAY: usize = 4;
pub const SORT: usize = 5;
pub const PASSED: usize = 6;
pub const SHOTS: usize = 7;

/// Where the props stand (metres, x and z): the containment cage (around the cell the self-test walls the looper in
/// front of), the crash cart with its monitor, and the sorting table.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Props {
    pub cage: [i32; 2],
    pub cart: [i32; 2],
    pub table: [i32; 2],
}

pub fn props(d: &Dims, trap_cell: u32) -> Props {
    let cells = (d.width * d.depth) as u32;
    let cage = if trap_cell < cells { cell_at(d, trap_cell) } else { [cell_mid(d.width as i32 / 2), aisle_z(d, 2)] };
    Props { cage, cart: [col(d, 14), aisle_z(d, 4)], table: [col(d, 42), aisle_z(d, 6)] }
}

/// A file slot's z on the table (slot 0 is on the camera's left: the camera looks along +x, so its right is -z).
pub fn slot_z(p: &Props, k: usize) -> i32 {
    p.table[1] + SLOT_GAP * 7 / 2 - SLOT_GAP * k as i32
}

pub fn shots(d: &Dims, p: &Props) -> [Shot; SHOTS] {
    let y = |n: i32| frac(n, 100);
    let a3 = aisle_z(d, 3);
    let a1 = aisle_z(d, 1);
    let (wx, wz) = ((d.width as i32) * CELL, (d.depth as i32) * CELL);
    let inside = |x: i32, z: i32| [x.clamp(CELL, wx - CELL), z.clamp(CELL, wz - CELL)];
    let [cx, cz] = p.cage;
    let ce = inside(cx + m(3) + frac(1, 2), cz - frac(7, 10));
    let [kx, kz] = p.cart;
    let [tx, tz] = p.table;
    let walk_to = col(d, 36);
    [
        // The intro: down an aisle, the tutor walking toward the camera.
        Shot {
            eye: [[col(d, 54), y(165), a3], [col(d, 46), y(160), a3]],
            target: [[col(d, 18), y(120), a3], [walk_to, y(135), a3]],
            focal: 420,
            tutor: [[col(d, 18), a3], [walk_to, a3]],
            face: TURN / 4,
        },
        // Memory: at a rack.
        Shot {
            eye: [[col(d, 15), y(175), a1 - y(150)], [col(d, 16), y(160), a1 - y(130)]],
            target: [[col(d, 21), y(125), a1 + y(110)], [col(d, 21), y(120), a1 + y(105)]],
            focal: 400,
            tutor: [[col(d, 21), a1 + y(105)]; 2],
            face: TURN / 2 + TURN / 12,
        },
        // Compute: a crane over the whole floor, the swarm running.
        Shot {
            eye: [[wx / 2, m(15) + y(50), -m(3)], [wx / 2 + m(1) + y(50), m(13) + y(50), -m(1)]],
            target: [[wx / 2, 0, wz * 13 / 32], [wx / 2 + y(50), 0, wz * 15 / 32]],
            focal: 300,
            tutor: [[walk_to, a3]; 2],
            face: TURN / 4,
        },
        // Containment: the cage around the cell the looper was walled in front of.
        Shot {
            eye: [[ce[0], y(260), ce[1]], [ce[0] - y(40), y(240), ce[1] + y(20)]],
            target: [[cx, y(40), cz], [cx, y(35), cz]],
            focal: 380,
            tutor: [[cx + m(1) + y(80), cz + y(110)]; 2],
            face: TURN / 4 + TURN / 6,
        },
        // Display: the crash cart's monitor.
        Shot {
            eye: [[kx + m(3) + y(90), y(160), kz - y(60)], [kx + m(3) + y(30), y(155), kz - y(40)]],
            target: [[kx, y(140), kz + y(20)], [kx, y(140), kz + y(15)]],
            focal: 420,
            tutor: [[kx + y(40), kz + y(105)]; 2],
            face: TURN / 4 + TURN / 16,
        },
        // The sort: across the table, the tutor behind it.
        Shot {
            eye: [[tx - m(2) - y(90), y(195), tz], [tx - m(2) - y(70), y(190), tz]],
            target: [[tx, y(95), tz], [tx, y(92), tz]],
            focal: 330,
            tutor: [[tx + y(75), tz]; 2],
            face: 3 * TURN / 4,
        },
        // Passed: up and away over the floor.
        Shot {
            eye: [[tx - m(2) - y(70), y(190), tz], [tx - m(4), m(9), (tz + m(5)).min(wz + m(4))]],
            target: [[tx, y(92), tz], [wx / 2, 0, wz / 2]],
            focal: 330,
            tutor: [[tx + y(75), tz]; 2],
            face: 3 * TURN / 4,
        },
    ]
}

/// A flat panel facing +x (0), -x (1), +z (2) or -z (3), centred at `c`, `hw` wide and `hh` tall, front-facing toward
/// a viewer in front of it (listed bottom-left, top-left, top-right, bottom-right as that viewer sees it).
pub fn push_panel(mesh: &mut Mesh, c: [i32; 3], facing: u8, hw: i32, hh: i32, rgb: u32) {
    let (y0, y1) = (c[1] - hh, c[1] + hh);
    let (x, z) = (c[0], c[2]);
    let (l, r): ([i32; 2], [i32; 2]) = match facing {
        0 => ([x, z - hw], [x, z + hw]),
        1 => ([x, z + hw], [x, z - hw]),
        2 => ([x + hw, z], [x - hw, z]),
        _ => ([x - hw, z], [x + hw, z]),
    };
    push_quad(mesh, [l[0], y0, l[1]], [l[0], y1, l[1]], [r[0], y1, r[1]], [r[0], y0, r[1]], rgb);
}

/// The static room. Returns the triangles it used (they stay at the front of the mesh; moving parts follow).
pub fn build_room(mesh: &mut Mesh, d: &Dims, mtx: &Matrix, p: &Props) -> usize {
    let (w, depth) = (d.width as i32, d.depth as i32);
    let (rx, rz) = (w * CELL, depth * CELL);
    // The floor, in tiles: two metres each, or larger on a larger floor (sixteen across at most).
    let tile = m(2).max(rx.max(rz) / 16);
    let (nx, nz) = ((rx + tile - 1) / tile, (rz + tile - 1) / tile);
    for tz in 0..nz {
        for tx in 0..nx {
            let (x0, z0) = (tx * tile, tz * tile);
            let (x1, z1) = ((x0 + tile).min(rx), (z0 + tile).min(rz));
            let rgb = render::shade(if (tx + tz) % 2 == 0 { FLOOR_A } else { FLOOR_B }, [0, ONE, 0]);
            push_quad(mesh, [x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0], rgb);
        }
    }
    // The walls, with a crimson trim at shoulder height.
    let t = frac(1, 5);
    push_box(mesh, [-t, 0, -t], [rx + t, WALL_TOP, 0], WALL);
    push_box(mesh, [-t, 0, rz], [rx + t, WALL_TOP, rz + t], WALL);
    push_box(mesh, [-t, 0, 0], [0, WALL_TOP, rz], WALL);
    push_box(mesh, [rx, 0, 0], [rx + t, WALL_TOP, rz], WALL);
    let (s0, s1, e) = (frac(26, 10), frac(265, 100), frac(1, 50));
    push_glow(mesh, [0, s0, 0], [rx, s1, e], TRIM);
    push_glow(mesh, [0, s0, rz - e], [rx, s1, rz], TRIM);
    push_glow(mesh, [0, s0, 0], [e, s1, rz], TRIM);
    push_glow(mesh, [rx - e, s0, 0], [rx, s1, rz], TRIM);
    // The racks: every run of wall cells inside the room (the border is the room's own wall), with a door panel per
    // rack unit on both faces. A unit is 0.6 m, or wider on a floor so large that its panels would take more than a
    // third of the declared triangles.
    let inner = |cz: i32, cx: i32| mtx.walls[(cz * w + cx) as usize] & 1 != 0;
    let rack_cells: i64 = (1..depth - 1).map(|cz| (1..w - 1).filter(|&cx| inner(cz, cx)).count() as i64).sum();
    let budget = (d.triangles as i64 / 3 / 4).max(1);
    let unit = (frac(6, 10) as i64).max(rack_cells * CELL as i64 / budget + 1) as i32;
    for cz in 1..depth - 1 {
        let mut cx = 1;
        while cx < w - 1 {
            if !inner(cz, cx) {
                cx += 1;
                continue;
            }
            let start = cx;
            while cx < w - 1 && inner(cz, cx) {
                cx += 1;
            }
            let (x0, x1) = (start * CELL, cx * CELL);
            let (z0, z1) = (cz * CELL + frac(1, 20), (cz + 1) * CELL - frac(1, 20));
            push_box(mesh, [x0, 0, z0], [x1, RACK_TOP, z1], RACK);
            push_glow(mesh, [x0, RACK_TOP, z0 + frac(1, 5)], [x1, RACK_TOP + frac(2, 100), z1 - frac(1, 5)], 0x3a0a12);
            let units = ((x1 - x0) / unit).max(1);
            let uw = (x1 - x0) / units;
            for u in 0..units {
                let ux = x0 + uw * u + uw / 2;
                let (hw, hh, cy) = (uw / 2 - frac(3, 100), RACK_TOP / 2 - frac(8, 100), RACK_TOP / 2);
                push_panel(mesh, [ux, cy, z0 - frac(1, 200)], 3, hw, hh, render::shade(PANEL, [0, 0, -ONE]));
                push_panel(mesh, [ux, cy, z1 + frac(1, 200)], 2, hw, hh, render::shade(PANEL, [0, 0, ONE]));
            }
        }
    }
    // Light strips over every aisle, above the racks.
    let rows = depth / RACK_EVERY as i32;
    let (lx0, lx1) = ((RACK_MARGIN as i32) * CELL, (w - RACK_MARGIN as i32) * CELL);
    for k in 0..rows {
        let z = aisle_z(d, k);
        push_glow(mesh, [lx0, frac(34, 10), z - frac(6, 100)], [lx1, frac(345, 100), z + frac(6, 100)], STRIP);
    }
    // The docking pads.
    for &cell in &mtx.station {
        let [x, z] = cell_at(d, cell);
        let (r, y) = (frac(45, 100), frac(1, 100));
        push_quad(mesh, [x - r, y, z - r], [x - r, y, z + r], [x + r, y, z + r], [x + r, y, z - r], PAD);
        let q = frac(30, 100);
        push_quad(mesh, [x - q, y * 2, z - q], [x - q, y * 2, z + q], [x + q, y * 2, z + q], [x + q, y * 2, z - q], 0x7a1020);
    }
    push_cage(mesh, p.cage);
    push_cart(mesh, p.cart);
    push_table(mesh, p);
    mesh.n
}

/// The containment cage: twelve steel edges of a 1.8 × 2.2 × 1.8 m frame around `at`.
fn push_cage(mesh: &mut Mesh, at: [i32; 2]) {
    let [cx, cz] = at;
    let (h, top, e) = (frac(9, 10), frac(22, 10), frac(25, 1000));
    let corners = [[-h, -h], [h, -h], [h, h], [-h, h]];
    for k in 0..4 {
        let [ax, az] = corners[k];
        let [bx, bz] = corners[(k + 1) % 4];
        push_box(mesh, [cx + ax - e, 0, cz + az - e], [cx + ax + e, top, cz + az + e], STEEL);
        for y in [frac(2, 100), top - 2 * e] {
            push_box(mesh, [cx + ax.min(bx) - e, y, cz + az.min(bz) - e], [cx + ax.max(bx) + e, y + 2 * e, cz + az.max(bz) + e], STEEL);
        }
    }
    // A crimson line on the floor around it.
    let r = h + frac(15, 100);
    let y = frac(1, 100);
    for [a, b] in [[[-r, -r], [r, -r + e]], [[-r, r - e], [r, r]], [[-r, -r], [-r + e, r]], [[r - e, -r], [r, r]]] {
        push_glow(mesh, [cx + a[0], 0, cz + a[1]], [cx + b[0], y, cz + b[1]], CRIMSON);
    }
}

/// The crash cart: a two-shelf cart with a monitor facing +x; the monitor shows colour bars.
fn push_cart(mesh: &mut Mesh, at: [i32; 2]) {
    let [x, z] = at;
    let (hx, hz) = (frac(28, 100), frac(38, 100));
    for (sx, sz) in [(-1, -1), (1, -1), (1, 1), (-1, 1)] {
        let (px, pz) = (x + sx * (hx - frac(2, 100)), z + sz * (hz - frac(2, 100)));
        push_box(mesh, [px - frac(2, 100), 0, pz - frac(2, 100)], [px + frac(2, 100), frac(95, 100), pz + frac(2, 100)], 0x2a2b31);
    }
    for y in [frac(25, 100), frac(95, 100)] {
        push_box(mesh, [x - hx, y, z - hz], [x + hx, y + frac(3, 100), z + hz], 0x30323a);
    }
    // The monitor on a short neck.
    push_box(mesh, [x - frac(4, 100), frac(98, 100), z - frac(4, 100)], [x + frac(4, 100), frac(115, 100), z + frac(4, 100)], 0x26272c);
    let (mz, my0, my1) = (frac(42, 100), frac(115, 100), frac(165, 100));
    push_box(mesh, [x - frac(3, 100), my0, z - mz], [x + frac(3, 100), my1, z + mz], 0x0c0c0f);
    const BARS: [u32; 7] = [0xc0c0c0, 0xc0c000, 0x00c0c0, 0x00c000, 0xc000c0, 0xc00000, 0x0000c0];
    let bw = (2 * mz - frac(6, 100)) / 7;
    let z0 = z - mz + frac(3, 100);
    for (k, &rgb) in BARS.iter().enumerate() {
        let c = [x + frac(3, 100) + frac(1, 200), (my0 + my1) / 2, z0 + bw * k as i32 + bw / 2];
        push_panel(mesh, c, 0, bw / 2, (my1 - my0) / 2 - frac(3, 100), rgb);
    }
}

/// The sorting table: across the aisle, eight slots along it.
fn push_table(mesh: &mut Mesh, p: &Props) {
    let [x, _] = p.table;
    let (hx, z0, z1) = (frac(25, 100), slot_z(p, 7) - SLOT_GAP, slot_z(p, 0) + SLOT_GAP);
    push_box(mesh, [x - hx, TABLE_TOP - frac(4, 100), z0], [x + hx, TABLE_TOP, z1], 0x3b2a22);
    for (lx, lz) in [(x - hx, z0), (x + hx - frac(6, 100), z0), (x - hx, z1 - frac(6, 100)), (x + hx - frac(6, 100), z1 - frac(6, 100))] {
        push_box(mesh, [lx, 0, lz], [lx + frac(6, 100), TABLE_TOP - frac(4, 100), lz + frac(6, 100)], 0x22180f);
    }
    // A crimson slot mark under each file.
    for k in 0..8 {
        let z = slot_z(p, k);
        let r = frac(13, 100);
        let y = TABLE_TOP + frac(1, 200);
        push_quad(mesh, [x - r, y, z - r], [x - r, y, z + r], [x + r, y, z + r], [x + r, y, z - r], 0x5a0d18);
    }
}

/// The tutor's pose: where it stands (metres), which way it faces (TURN units), how far into its stride (TURN units),
/// and whether its arms are out in front (carrying files).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TutorPose {
    pub x: i32,
    pub z: i32,
    pub heading: i32,
    pub stride: i32,
    pub carrying: bool,
}

/// The tutor: about 1.8 m in business attire, legs and arms swinging with its stride. Each part is a box swung about
/// its joint (push_limb: the joint is the pivot, given in the box's own frame from its centre).
pub fn push_tutor(mesh: &mut Mesh, p: &TutorPose) {
    let h = p.heading;
    let (sh, ch) = (render::sin(h), render::cos(h));
    // A point `side` metres to the figure's right and `fwd` in front of it, at height `y`.
    let at = |side: i32, fwd: i32, y: i32| [p.x + mul(side, ch) + mul(fwd, sh), y, p.z - mul(side, sh) + mul(fwd, ch)];
    let y = |n: i32| frac(n, 1000);
    let swing = mul(render::sin(p.stride), TURN / 11);
    for (side, s) in [(-y(110), swing), (y(110), -swing)] {
        // Trousers from the hip (0.92 m), and a shoe swung about the same hip.
        push_limb(mesh, at(side, 0, y(490)), h, [0, y(430), 0], [y(75), y(430), y(85)], s, 0x2b2d33);
        push_limb(mesh, at(side, y(40), y(40)), h, [0, y(880), -y(40)], [y(65), y(40), y(130)], s, 0x0e0e10);
    }
    // The blazer, the shirt's front, the tie.
    push_limb(mesh, at(0, 0, y(1230)), h, [0, 0, 0], [y(220), y(310), y(130)], 0, 0x34363f);
    push_limb(mesh, at(0, y(125), y(1420)), h, [0, 0, 0], [y(70), y(120), y(12)], 0, 0xe6e6ea);
    push_limb(mesh, at(0, y(135), y(1320)), h, [0, 0, 0], [y(25), y(170), y(12)], 0, CRIMSON);
    // Sleeves from the shoulder (1.50 m) and hands, swinging opposite the legs, or held out when carrying.
    for (side, s) in [(-y(290), -swing), (y(290), swing)] {
        let lift = if p.carrying { -TURN / 5 } else { s };
        push_limb(mesh, at(side, 0, y(1200)), h, [0, y(300), 0], [y(60), y(300), y(65)], lift, 0x34363f);
        push_limb(mesh, at(side, 0, y(860)), h, [0, y(640), 0], [y(45), y(50), y(45)], lift, 0xc89a7c);
    }
    // Neck, head, hair.
    push_limb(mesh, at(0, 0, y(1570)), h, [0, 0, 0], [y(50), y(40), y(50)], 0, 0xc89a7c);
    push_limb(mesh, at(0, 0, y(1700)), h, [0, 0, 0], [y(95), y(115), y(105)], 0, 0xc89a7c);
    push_limb(mesh, at(0, -y(10), y(1800)), h, [0, 0, 0], [y(100), y(35), y(110)], 0, 0x1c1410);
}

/// A file: a buff folder box standing on the table, its tab crimson when it is one of the pair being compared.
pub fn push_file(mesh: &mut Mesh, x: i32, y: i32, z: i32, lit: bool) {
    let (hx, hz, top) = (frac(12, 100), frac(12, 100), frac(30, 100));
    push_box(mesh, [x - hx, y, z - hz], [x + hx, y + top, z + hz], if lit { 0xe0c08e } else { 0xa88d66 });
    let tab = if lit { CRIMSON } else { 0x5c4a34 };
    push_glow(mesh, [x - hx - frac(1, 100), y + top, z - frac(5, 100)], [x - hx + frac(3, 100), y + top + frac(4, 100), z + frac(5, 100)], tab);
}

/// A position from the Position Array (cells) in metres, fixed point: exact, because positions are eighths of a cell.
pub fn pos(cells: f32) -> i32 {
    ((cells * 8.0) as i32).saturating_mul(CELL / 8)
}

/// A unit of the swarm marked for the camera: a small glowing block where agent `i` stands (the looper in its cage).
pub fn push_marker(mesh: &mut Mesh, mtx: &Matrix, i: usize, rgb: u32) {
    let (x, z) = (pos(mtx.px[i]), pos(mtx.pz[i]));
    let r = frac(9, 100);
    push_glow(mesh, [x - r, 0, z - r], [x + r, frac(22, 100), z + r], rgb);
}

/// A wall the self-test raised (the looper's trap), as a crimson block.
pub fn push_trap(mesh: &mut Mesh, d: &Dims, cell: u32) {
    let [x, z] = cell_at(d, cell);
    let r = CELL / 2 - frac(2, 100);
    push_glow(mesh, [x - r, 0, z - r], [x + r, frac(5, 100), z + r], CRIMSON);
    push_box(mesh, [x - r, frac(5, 100), z - r], [x + r, frac(60, 100), z + r], 0x5a0d18);
}

/// Every live agent of the swarm as a dot on the floor: couriers crimson, sentries amber, the tutor white, and the
/// agents in `mark` white and larger.
pub fn draw_swarm(f: &mut Frame, cam: &Camera, mtx: &Matrix, mark: [u32; 2]) {
    let y = frac(4, 100);
    for i in 0..mtx.alive.len() {
        if mtx.alive[i] == 0 {
            continue;
        }
        let marked = mark.contains(&(i as u32));
        let rgb = match (marked, mtx.role[i]) {
            (true, _) => 0xffffff,
            (_, 0) => 0xe0283c,
            (_, 1) => 0xd89a2a,
            _ => 0xf0f0f0,
        };
        render::dot(f, cam, [pos(mtx.px[i]), y, pos(mtx.pz[i])], if marked { 4 } else { 2 }, rgb);
    }
}

/// The racks' status lights: three a cell on each face, blinking with the frame count.
pub fn draw_lights(f: &mut Frame, cam: &Camera, d: &Dims, mtx: &Matrix, frame: u32) {
    let w = d.width as i32;
    for cz in 1..d.depth as i32 - 1 {
        for cx in 1..w - 1 {
            let c = (cz * w + cx) as u32;
            if mtx.walls[c as usize] & 1 == 0 {
                continue;
            }
            for (k, y) in [frac(55, 100), frac(115, 100), frac(175, 100)].into_iter().enumerate() {
                let h = crate::hash::mix32(c.wrapping_mul(3).wrapping_add(k as u32));
                if crate::hash::mix32(h ^ (frame / 8)) & 3 == 0 {
                    continue;
                }
                let rgb = [0xff3040, 0xffb43a, 0x38f0a0][(h % 3) as usize];
                let x = cell_mid(cx) + ((h >> 8) % 5) as i32 * frac(4, 100) - frac(8, 100);
                render::dot(f, cam, [x, y, cz * CELL + frac(4, 100)], 1, rgb);
                render::dot(f, cam, [x, y, (cz + 1) * CELL - frac(4, 100)], 1, rgb);
            }
        }
    }
}

/// The camera for a shot at `t` (0..=65536 of the way through its move).
pub fn camera_of(s: &Shot, t: i32) -> Camera {
    let k = render::ease(t);
    let eye = render::lerp3(s.eye[0], s.eye[1], k);
    let target = render::lerp3(s.target[0], s.target[1], k);
    let (yaw, pitch) = render::look_at(eye, target);
    Camera { x: eye[0], y: eye[1], z: eye[2], yaw, pitch, focal: s.focal }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{parse, validate};
    use crate::matrix;

    fn world() -> (Dims, Matrix) {
        let c = validate(&parse(include_str!("../../../containment.nix")).unwrap()).unwrap();
        let d = c.dims;
        let mut mtx = matrix::new(&d);
        matrix::lay_out_world(&d, &mut mtx);
        (d, mtx)
    }

    fn free(d: &Dims, mtx: &Matrix, x: i32, z: i32) -> bool {
        let (cx, cz) = (x / CELL, z / CELL);
        (0..d.width as i32).contains(&cx) && (0..d.depth as i32).contains(&cz) && mtx.walls[(cz * d.width as i32 + cx) as usize] == 0
    }

    #[test]
    fn every_shot_is_staged_on_the_floor_and_off_the_racks() {
        let (d, mtx) = world();
        let p = props(&d, 2905);
        for (k, s) in shots(&d, &p).iter().enumerate() {
            for e in s.eye {
                // Eye level stands in an aisle; a crane may fly over the racks and the walls.
                assert!(e[1] > WALL_TOP || free(&d, &mtx, e[0], e[2]), "shot {k}: the camera stands in a rack");
            }
            for t in s.tutor {
                assert!(free(&d, &mtx, t[0], t[1]), "shot {k}: the tutor stands in a rack");
            }
        }
        for (name, at) in [("cage", p.cage), ("cart", p.cart), ("table", p.table)] {
            assert!(free(&d, &mtx, at[0], at[1]), "the {name} stands in a rack");
        }
        for k in 0..8 {
            assert!(free(&d, &mtx, p.table[0], slot_z(&p, k)), "file slot {k} is on a rack");
        }
    }

    #[test]
    fn the_room_fits_the_declared_triangles_on_every_floor_the_validator_allows() {
        for (w, depth) in [(32, 32), (64, 64), (256, 32), (256, 256)] {
            let (mut d, _) = world();
            d.width = w;
            d.depth = depth;
            let mut mtx = matrix::new(&d);
            matrix::lay_out_world(&d, &mut mtx);
            let p = props(&d, u32::MAX);
            let (mut x, mut y, mut z, mut rgb) =
                (std::vec![0; d.triangles * 3], std::vec![0; d.triangles * 3], std::vec![0; d.triangles * 3], std::vec![0; d.triangles]);
            let mut mesh = Mesh { x: &mut x, y: &mut y, z: &mut z, rgb: &mut rgb, n: 0, dropped: 0 };
            let n = build_room(&mut mesh, &d, &mtx, &p);
            assert_eq!(mesh.dropped, 0, "{w}x{depth}: the room needs {n}+ triangles");
            // Room for the moving parts after it.
            assert!(n + 2048 <= d.triangles, "{w}x{depth}: {n} triangles leave too little for the moving parts");
            let _ = shots(&d, &p);
        }
    }

    #[test]
    fn look_at_points_the_camera_at_its_target() {
        let eye = [m(3), m(2), m(5)];
        for target in [[m(10), m(1), m(5)], [m(3), 0, m(12)], [-m(4), m(2), m(1)], [m(4), m(6), m(4)]] {
            let (yaw, pitch) = render::look_at(eye, target);
            let cam = Camera { x: eye[0], y: eye[1], z: eye[2], yaw, pitch, focal: 300 };
            let (mut color, mut depth) = (std::vec![0u32; 64 * 36], std::vec![0u32; 64 * 36]);
            let f = Frame { color: &mut color, depth: &mut depth, w: 64, h: 36 };
            let (x, y, _) = render::screen_of(&f, &cam, target).expect("the target is on screen");
            assert!((x - 32).abs() <= 1 && (y - 18).abs() <= 1, "{target:?} lands at ({x}, {y}), not the centre");
        }
    }
}

#[cfg(test)]
mod preview {
    use super::*;
    use crate::config::{parse, validate};
    use crate::matrix;
    use crate::render::{Fog, clear, cinematic, draw};

    /// Writes each shot's opening frame as a PPM into $NOIR_PREVIEW (a development aid; ignored by default).
    #[test]
    #[ignore]
    fn preview_the_shots() {
        let Ok(dir) = std::env::var("NOIR_PREVIEW") else { return };
        let c = validate(&parse(include_str!("../../../containment.nix")).unwrap()).unwrap();
        let d = c.dims;
        let counts: std::vec::Vec<u32> = c.roles.iter().map(|r| r.count).collect();
        let caps: std::vec::Vec<u32> = c.roles.iter().map(|r| r.caps).collect();
        let mut mtx = matrix::new(&d);
        let mut proof = matrix::golden_begin(&d, &counts, &caps, &mut mtx);
        let (mut x, mut y, mut z, mut rgb) =
            (std::vec![0; d.triangles * 3], std::vec![0; d.triangles * 3], std::vec![0; d.triangles * 3], std::vec![0; d.triangles]);
        let mut mesh = Mesh { x: &mut x, y: &mut y, z: &mut z, rgb: &mut rgb, n: 0, dropped: 0 };
        let p = props(&d, 2905);
        let room = build_room(&mut mesh, &d, &mtx, &p);
        while matrix::golden_step(&d, &mut mtx, &mut proof) {}
        let (w, h) = (d.display_width, d.display_height);
        let (mut color, mut depth) = (std::vec![0u32; w * h], std::vec![0u32; w * h]);
        for (k, s) in shots(&d, &p).iter().enumerate() {
            for (j, t) in [(0, 0), (1, ONE)] {
                mesh.n = room;
                let [tx, tz] = s.tutor[j];
                push_tutor(&mut mesh, &TutorPose { x: tx, z: tz, heading: s.face, stride: 300 * j as i32, carrying: k == SORT });
                for f in 0..8 {
                    push_file(&mut mesh, p.table[0], TABLE_TOP, slot_z(&p, f), f == 2 || f == 5);
                }
                push_marker(&mut mesh, &mtx, proof.looper as usize, 0xffffff);
                push_trap(&mut mesh, &d, proof.trap_cell);
                let cam = camera_of(s, t);
                let mut fr = Frame { color: &mut color, depth: &mut depth, w, h };
                let fog = Fog { rgb: 0x07080c, near: m(4), far: m(30) };
                clear(&mut fr, 0x07080c);
                let n = mesh.n;
                draw(&mut fr, &cam, &mesh, 0, n, &fog);
                draw_lights(&mut fr, &cam, &d, &mtx, 3);
                draw_swarm(&mut fr, &cam, &mtx, [proof.looper, proof.rogue]);
                cinematic(&mut fr, 7, 36);
                let mut out = std::format!("P6\n{w} {h}\n255\n").into_bytes();
                for &p in fr.color.iter() {
                    out.extend_from_slice(&[(p >> 16) as u8, (p >> 8) as u8, p as u8]);
                }
                std::fs::write(std::format!("{dir}/shot{k}{j}.ppm"), out).unwrap();
            }
        }
    }
}
