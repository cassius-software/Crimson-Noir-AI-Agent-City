// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is the whole pedestrian population's brain and body: GPU spawn,
// spatial-hash flocking, sidewalk navigation with signal-controlled crosswalks and a Perception check
// to notice the walk signal, the Reflex save to get out of a vehicle's path, the 14A safety nudge (a
// car that touches someone only pushes them aside), First-Law hazard sensing for every car (nearest
// person in its corridor ahead and behind), spring-damper staggers, the Ring-0 flag for a non-finite
// pedestrian state, the operator's summons (a person asked over walks to the operator along the sidewalk
// and stops to talk, the safety reflexes still first), the workday (one person in WORK_ONE_IN has a station in
// one of the city's indoor workplaces, 01_Initialize_World/interiors.ts: on shift they walk the corner graph to the
// workplace's block, along the sidewalk to its doorway, in to their station and work there, then walk out and back
// to their day), the containment that keeps everyone out of the lots but lets a room's doorway through and slides
// a step along a wall or a piece of furniture instead of into it, and the visibility/density/LOD compaction that
// feeds the indirect draws. Pedestrian coordinates are only ever written here, on the GPU.
// What breaks if it is removed? Nobody spawns, walks, waits for a light, or gets drawn, and no car
// can see the people in its path.
//
// CITY_*, TRAFFIC_*, SIGNAL_*, YIELD_*, WALK_*, KERNEL_*, CAR_*, GRID_*, SUMMON_*, ROOM_*, WORK_*, ACT_* and the limits below are
// prepended at runtime from city.ts / civic.ts / crowdCompute.ts so the CPU and GPU share one set of
// numbers. The streets are a window of CITY_BLOCKS × CITY_BLOCKS blocks at CITY_PITCH from CITY_ORIGIN_X/Z: the
// procedural city itself (every street present, at the origin), or a window of a generated region (Lakefront Metro,
// 01_Initialize_World/region/streets.ts), where Params.streets says which segments exist and which carry cars.

const TAU: f32 = 6.28318530718;
const PI: f32 = 3.14159265359;

const K_BEND: f32 = 70.0;
const C_BEND: f32 = 9.0;
const K_TILT: f32 = 120.0;
const C_TILT: f32 = 15.0;
const SEP_R2: f32 = 0.64;   // 0.8 m personal space
const NEIGH_R2: f32 = 6.25; // 2.5 m flocking radius
const BODY_PAD: f32 = 0.35; // a person's reach beyond their centre: contact margin around a car

const CROSS_NONE: f32 = 0.0;
const CROSS_WAIT: f32 = 1.0;
const CROSS_WALK: f32 = 2.0;

// The workday's phases (Brain.d.x). Off duty a worker walks the streets like anyone; on shift they commute: the
// corner graph towards the workplace's corner, the sidewalk to the door front, in through the doorway to the hub,
// across to their station's row, along it to the station, work; then the same legs out, and back to their day.
const WORK_OFF: f32 = 0.0;
const WORK_COMMUTE: f32 = 1.0;
const WORK_APPROACH: f32 = 2.0;
const WORK_ENTER: f32 = 3.0;
const WORK_ROW: f32 = 4.0;
const WORK_STATION: f32 = 5.0;
const WORK_WORKING: f32 = 6.0;
const WORK_LEAVE_ROW: f32 = 7.0;
const WORK_LEAVE_HUB: f32 = 8.0;
const WORK_LEAVE_DOOR: f32 = 9.0;
// A step indoors or to the door front counts as arrived this close, m (a corner: 1.3).
const WORK_ARRIVE: f32 = 0.6;

// Hash salts: independent streams for the walk-start roll, the draw-density lottery and the detailed-body distance.
const WALK_SALT: u32 = 0x2545f491u;
const DENSITY_SALT: u32 = 0x68e31da4u;
const LOD_SALT: u32 = 0x3c6ef372u;

// IEEE 754 binary32 exponent bits: all set means infinite or not a number.
const EXP_MASK: u32 = 0x7f800000u;

struct Car {
  a: vec4f, // x, z, heading, speed (forward = (sin heading, cos heading))
  b: vec4f, // half width, half length, path curvature (1/m, + = turning left), corridor reach (m)
}

// One person the operator asked over (skills.ts, simCore.ts): walk to `at` and stop there. agent 0 (the player's
// own body) marks an empty slot. flags: bit 0 a summons, bit 1 tethered (Active: they hurry after the operator).
struct Summon {
  at: vec2f,
  agent: u32,
  flags: u32,
}

// An indoor workplace (01_Initialize_World/interiors.ts packRooms): a downtown lot whose ground floor is a room behind
// glass walls ROOM_WALL thick with a doorway 2 · ROOM_DOOR wide on one street front. a = (lot centre x, z, doorway side:
// 0 faces +z, 1 −z, 2 +x, 3 −x; present), b = (the hub's u, m inside the doorway; furniture count; -, -), furniture =
// (x0, z0, x1, z1) city boxes a step slides round, stations = (u, v, facing yaw, present) in the room's frame (u from
// the back wall to the doorway, v across). A room with a.w = 0 is an empty slot (a region has none).
struct Room {
  a: vec4f,
  b: vec4f,
  furniture: array<vec4f, ROOM_FURNITURE>,
  stations: array<vec4f, ROOM_STATIONS>,
}

struct Params {
  dt: f32,
  time: f32,
  frame: u32,
  agentCount: u32,
  carCount: u32,
  signalTime: f32,
  lodDistance: f32,
  nearRadius: f32,
  player: vec4f, // x, z, heading, speed
  aux: vec4f,    // player visible, draw density beyond nearRadius (0..1), max draw distance, -
  camera: vec4f, // x, y, z, -
  // Matrix mode's global state, the one word 01_Initialize_World/globalState.ts packs for every pipeline that takes
  // the mode (this one and the mesh surface matrixMesh.wgsl): time (s), matrix mode (1 on, 0 off), the page's
  // floating origin (x, z, m). The simulation reads the mode alone: its own geometry is lot-relative (streetOffsets,
  // pushOut), and its positions stay absolute so the fingerprinted run is the same whoever looks at it.
  global: vec4f,
  planes: array<vec4f, 6>,
  cars: array<Car, MAX_CARS>,
  summons: array<Summon, SUMMON_SLOTS>,
  // The street window's segments (streets.ts packStreets): two bits per segment, a sidewalk along it (bit 0) and cars
  // on it (bit 1); the east-west segments (index m · CITY_BLOCKS + k) then the north-south ((CITY_BLOCKS + 1) ·
  // CITY_BLOCKS + k · CITY_BLOCKS + m). The procedural city sets every bit.
  streets: array<vec4u, STREET_VEC4S>,
  // The indoor workplaces (interiors.ts): the procedural city's six, or empty slots in a region.
  rooms: array<Room, ROOM_SLOTS>,
}

// a = (goal.xy, preferred speed, retreat speed)
// b = (tilt velocity, bend velocity, crossing state, summons: 0 none, 1 coming over, 2 interviewing)
// c = (retreat dir.xy, retreat timer, freeze timer)
// d = (workday phase WORK_*, the room it is in or heading for, -, -)
struct Brain {
  a: vec4f,
  b: vec4f,
  c: vec4f,
  d: vec4f,
}

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> pos: array<vec4f>;  // x, y, z, heading
@group(0) @binding(2) var<storage, read_write> vel: array<vec4f>;  // vx, vz, walk phase, speed
@group(0) @binding(3) var<storage, read_write> pose: array<vec4f>; // tilt, bend, push angle, activity (ACT_*)
@group(0) @binding(4) var<storage, read_write> brain: array<Brain>;
@group(0) @binding(5) var<storage, read_write> gridCountW: array<atomic<u32>>;
@group(0) @binding(6) var<storage, read_write> gridSlotsW: array<vec4f>;
@group(0) @binding(7) var<storage, read> gridCountR: array<u32>;
@group(0) @binding(8) var<storage, read> gridSlotsR: array<vec4f>;
// nudges, waiting, crossing, retreating, flags (bit 0: a non-finite pedestrian state was computed; sticky
// until the CPU has read it back, for the Ring-0 audit), working (at a station this step), -, -.
@group(0) @binding(9) var<storage, read_write> stats: array<atomic<u32>, 8>;
@group(0) @binding(10) var<storage, read_write> drawArgs: array<atomic<u32>>;
@group(0) @binding(11) var<storage, read_write> drawLists: array<u32>;
// First Law: centimetres each car can travel before its widened footprint reaches the nearest person
// (corridorGap), reset to 0xffffffff (nobody) every frame. [0, MAX_CARS) driving on, [MAX_CARS,
// 2·MAX_CARS) reversing. simulate now uses 8 storage buffers, the WebGPU default per-stage limit.
@group(0) @binding(12) var<storage, read_write> hazards: array<atomic<u32>, HAZARD_SLOTS>;
// The page's look word per agent (look.ts packLook; 0 = as hashed), read by the cull alone for the body to draw:
// no simulation pass binds it, so nothing of it reaches the pedestrians' motion or the First-Law sensing.
@group(0) @binding(13) var<storage, read> look: array<u32>;
// The flow field towards the operator (06_Make_Decisions/flowField.ts, solved on this device by flowField.wgsl): one
// texel per FLOW_CELL-metre cell of the city, the unit direction to walk from there round the buildings, zero where
// there is none (a wall, no route, or no field yet). A sampled texture, read by the summons alone: simulate is at the
// eight-storage-buffer limit, and nothing of it reaches the First-Law sensing.
@group(0) @binding(14) var flowField: texture_2d<f32>;

// ---------------------------------------------------------------- hashing and dice

fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hash2(a: u32, b: u32) -> u32 { return pcg(a ^ pcg(b + 0x9e3779b9u)); }

// The flow field's direction under (x, z): the texel of the cell under the point, zero outside the grid.
fn flowAt(p: vec2f) -> vec2f {
  let dims = vec2i(textureDimensions(flowField));
  let c = vec2i(floor((p - vec2f(FLOW_ORIGIN_X, FLOW_ORIGIN_Z)) * FLOW_INV_CELL));
  if (any(c < vec2i(0)) || any(c >= dims)) { return vec2f(0.0); }
  return textureLoad(flowField, c, 0).xy;
}

// True when either component is infinite or not a number. Read from the bits, not by comparison: a
// compiler may assume no NaN and fold `x != x` or `!(abs(x) < big)` away, the exponent it cannot.
fn nonFinite(v: vec2f) -> bool {
  return any((bitcast<vec2u>(v) & vec2u(EXP_MASK)) == vec2u(EXP_MASK));
}
fn rand(a: u32, b: u32) -> f32 { return f32(hash2(a, b) >> 8u) / 16777216.0; }
fn d20(a: u32, b: u32) -> i32 { return i32(hash2(a, b) % 20u) + 1; }

// Mirrors degreeOf() in 02_Define_The_Rules/degrees.ts.
fn degreeOf(natural: i32, total: i32, dc: i32) -> i32 {
  var d = 1;
  if (total >= dc + 10) { d = 3; } else if (total >= dc) { d = 2; } else if (total <= dc - 10) { d = 0; }
  if (natural == 20) { d = min(3, d + 1); } else if (natural == 1) { d = max(0, d - 1); }
  return d;
}

// Seconds the walk phase for travel along x (or z) has been running at t, or -1 outside it.
// Mirrors walkAllowed() in 02_Define_The_Rules/civic.ts: >= 0 exactly when that returns true.
fn walkElapsed(alongX: bool, t: f32) -> f32 {
  let p = t - SIGNAL_CYCLE * floor(t / SIGNAL_CYCLE);
  let start = select(SIGNAL_EW_AMBER, 0.0, alongX);
  return select(-1.0, p - start, p >= start && p < start + SIGNAL_WALK);
}

// WALK_START.delay in civic.ts: how long after the walk signal a pedestrian of this degree steps off.
fn walkDelay(deg: i32) -> f32 {
  return select(select(select(WALK_DELAY_0, WALK_DELAY_1, deg >= 1), WALK_DELAY_2, deg >= 2), WALK_DELAY_3, deg >= 3);
}

// Clockwise turn from angle a0 to angle a1, in [0, 2π). A contact that rounding puts a hair behind a0
// (under a centimetre of travel at curvature k: WGSL lets atan2 err by 4096 ULP, a few millimetres at
// full lock) is now, not a whole turn away. That is tested before the wrap, since f32 cannot tell
// TAU - 1e-2·k from TAU below k ≈ 2e-5: a wrapped hair would read as nobody at the bumper.
fn clockwise(a0: f32, a1: f32, k: f32) -> f32 {
  let d = a0 - a1;
  let hair = 1e-2 * k;
  let t = d - TAU * floor(d / TAU);
  return select(t, 0.0, (d < 0.0 && d > -hair) || t > TAU - hair);
}

// First-Law sensing, the kinematic bicycle model Fleet.corridorDistance (vehicles.ts) applies to the
// avatar, so a person counts the same whichever side measures them. On a steer of `curvature` (1/m,
// positive = left) the chassis turns rigidly about the rear axle's turn centre, so its footprint, widened
// by KERNEL_CORRIDOR either side, sweeps the ground exactly: the nose swings toward the turn at once and
// the inner side cuts the corner (a path bent by curvature·s²/2 alone misses the nose's lead,
// (halfLength + |axle|)·curvature·s). Returns the metres the rear axle travels before that footprint
// reaches a person at (u, left) — u metres from the car's centre in the direction of travel, `left` to
// the chassis' left, the rear axle at u = axle — or -1 when it does not within KERNEL_RANGE. Straight, it
// is the distance from the leading bumper. A person inside the widened footprint is 0 m away whichever
// way the car moves (so is one it left under a centimetre of travel ago: see clockwise). Written in k
// rather than the radius 1/k, so it stays exact in f32 down to straight.
fn corridorGap(u: f32, left: f32, halfWidth: f32, halfLength: f32, curvature: f32, axle: f32) -> f32 {
  let half = halfWidth + KERNEL_CORRIDOR;
  if (abs(u) <= halfLength && abs(left) <= half) { return 0.0; }
  let k = abs(curvature);
  if (k < 1e-6) {
    let s = u - halfLength;
    return select(-1.0, s, s >= 0.0 && s <= KERNEL_RANGE && abs(left) <= half);
  }
  // Mirror a right turn onto a left one, so the turn centre is at (axle, 1/k). Relative to the car the
  // person then circles it clockwise; angles are measured at the centre from the rear axle's line.
  let l = select(-left, left, curvature > 0.0);
  let x = u - axle;
  let m = k * (x * x + l * l) - 2.0 * l; // ((kρ)² - 1) / k, ρ the person's distance from the centre
  // Exact rejections, cheapest first, that leave only the band the footprint sweeps (almost nobody).
  // 1. The person's circle must pass between the footprint's nearest and farthest points from the
  //    centre, ρmin = 1/k - half (or 0 once the centre is inside it) and ρmax = |(halfLength + |axle|,
  //    1/k + half)|; in m that is the band below, exact in f32 at any curvature.
  let lead = halfLength + abs(axle);
  let mMin = select(-1.0 / k, k * half * half - 2.0 * half, half * k < 1.0);
  let mMax = 2.0 * half + k * (half * half + lead * lead);
  if (m < mMin - 1e-3 || m > mMax + 1e-3) { return -1.0; }
  // 2. Until the heading has turned a quarter circle every footprint point stays ahead of the rear
  //    axle or of where it started, so on any gentler lock nobody behind the footprint is reached
  //    within the range.
  if (u < -halfLength && k * KERNEL_RANGE < 1.5 && half * k < 1.0) { return -1.0; }
  // 3. Per metre of travel the person moves kρ metres round the centre, so they cannot reach the
  //    footprint before travelling (distance to it) / kρ.
  let rk2 = 1.0 + k * m; // (kρ)²
  let du = max(abs(u) - halfLength, 0.0);
  let dl = max(abs(left) - half, 0.0);
  if (du * du + dl * dl > KERNEL_RANGE * KERNEL_RANGE * rk2 + 1e-3) { return -1.0; }
  let psi = atan2(k * x, 1.0 - k * l);
  var best = TAU;
  for (var e = -1.0; e <= 1.0; e += 2.0) {
    // Front or back edge, u = e·halfLength: reached at the angle whose sine is k·d / kρ, on the car's
    // side of the centre (lateral lNear) or, in a turn tighter than the car is wide, beyond it. The
    // angle comes from atan2, never asin(k·d / kρ): WGSL lets asin be 6.77e-5 rad off outright, metres
    // of travel once divided by a gentle k, while atan2's error stays relative to the angle.
    let d = e * halfLength - axle;
    let kd = k * d;
    let cc = rk2 - kd * kd; // (kρ·cos)²
    if (cc >= 0.0) {
      let kc = sqrt(cc);
      let a = atan2(kd, kc);
      let lNear = (kd * d - m) / (1.0 + kc); // (1 - kc) / k without the cancellation
      if (abs(lNear) <= half + 1e-5) { best = min(best, clockwise(psi, a, k)); }
      if ((1.0 + kc) / k <= half + 1e-5) { best = min(best, clockwise(psi, PI - a, k)); }
    }
    // Side, left = e·half: reached where kρ·cos = 1 - k·side, ahead of the axle's line or behind it.
    // (kρ·sin)² there is k·(m + 2·side - k·side²), grouped so nothing cancels for someone beside it.
    let side = e * half;
    let ss = k * (k * x * x + (l - side) * (k * (l + side) - 2.0));
    if (ss >= 0.0) {
      let q = sqrt(ss);
      let a = atan2(q, 1.0 - k * side);
      let along = q / k;
      if (abs(axle + along) <= halfLength + 1e-5) { best = min(best, clockwise(psi, a, k)); }
      if (abs(axle - along) <= halfLength + 1e-5) { best = min(best, clockwise(psi, -a, k)); }
    }
  }
  let travel = best / k;
  return select(-1.0, travel, best < TAU && travel <= KERNEL_RANGE);
}

// ---------------------------------------------------------------- physics layers

// The physics mask a pedestrian carries this tick (01_Initialize_World/globalState.ts PHYSICS_LAYER, PHYSICS_MASK): every layer, or in
// matrix mode the static world alone (bit 0: the ground that holds them at y = 0, the lots pushOut keeps them out
// of, the city's edge), so the other pedestrians (bit 1) and the cars (bit 2) phase through them while they stay
// grounded. The First-Law sensing is not a contact and keeps its eyes: a car still sees whoever is in its path.
fn physicsMaskFor(global_state: vec4f) -> u32 {
  var physics_mask: u32;
  if (global_state.y > 0.5) { physics_mask = 0x00000001u; } else { physics_mask = 0xFFFFFFFFu; }
  return physics_mask;
}
// 1.0 when the mask selects the layer, else 0.0: a factor the contact's whole effect is multiplied by.
fn layerOn(mask: u32, layer: u32) -> f32 { return select(0.0, 1.0, (mask & layer) != 0u); }

// ---------------------------------------------------------------- city geometry

fn cellOf(p: vec2f) -> vec2i {
  return clamp(vec2i(floor((p - vec2f(GRID_ORIGIN_X, GRID_ORIGIN_Z)) / GRID_CELL)), vec2i(0), vec2i(GRID_DIM - 1));
}
fn cellId(c: vec2i) -> u32 { return u32(c.y * GRID_DIM + c.x); }

// The window's corner: street k runs along x = CITY_ORIGIN_X + k · CITY_PITCH, street m along z = CITY_ORIGIN_Z + m · CITY_PITCH.
fn origin() -> vec2f { return vec2f(CITY_ORIGIN_X, CITY_ORIGIN_Z); }

// ---------------------------------------------------------------- the street window

// The bits of segment `index` of Params.streets (streets.ts packStreets).
fn segBits(index: u32) -> u32 {
  let bit = index * 2u;
  let w = P.streets[(bit / 32u) / 4u][(bit / 32u) % 4u];
  return (w >> (bit % 32u)) & 3u;
}
// The east-west segment at line m between k and k + 1, and the north-south one at line k between m and m + 1; none
// outside the window.
fn hSeg(k: i32, m: i32) -> u32 {
  if (k < 0 || k >= CITY_BLOCKS || m < 0 || m > CITY_BLOCKS) { return 0u; }
  return segBits(u32(m * CITY_BLOCKS + k));
}
fn vSeg(k: i32, m: i32) -> u32 {
  if (m < 0 || m >= CITY_BLOCKS || k < 0 || k > CITY_BLOCKS) { return 0u; }
  return segBits(u32((CITY_BLOCKS + 1) * CITY_BLOCKS + k * CITY_BLOCKS + m));
}
fn walkable(bits: u32) -> bool { return (bits & 1u) != 0u; }
fn driveable(bits: u32) -> bool { return (bits & 2u) != 0u; }
// A sidewalk corner exists where one of its two streets does: quadrant (sx, sz) of intersection (k, m).
fn cornerExists(k: i32, m: i32, sx: f32, sz: f32) -> bool {
  let hk = select(k - 1, k, sx > 0.0);
  let vm = select(m - 1, m, sz > 0.0);
  return walkable(hSeg(hk, m)) || walkable(vSeg(k, vm));
}
// Cars run on the north-south street at line k by intersection m (either side of it), or the east-west one at line m by k.
fn roadV(k: i32, m: i32) -> bool { return driveable(vSeg(k, m)) || driveable(vSeg(k, m - 1)); }
fn roadH(k: i32, m: i32) -> bool { return driveable(hSeg(k, m)) || driveable(hSeg(k - 1, m)); }

fn lotCenter(p: vec2f) -> vec2f { return (floor((p - origin()) / CITY_PITCH) + 0.5) * CITY_PITCH + origin(); }
fn pushOut(p: vec2f, pad: f32) -> vec2f {
  let c = lotCenter(p);
  let l = p - c;
  let lim = CITY_LOT_HALF + pad;
  if (abs(l.x) >= lim || abs(l.y) >= lim) { return p; }
  if (lim - abs(l.x) < lim - abs(l.y)) { return vec2f(c.x + select(-lim, lim, l.x >= 0.0), p.y); }
  return vec2f(p.x, c.y + select(-lim, lim, l.y >= 0.0));
}
fn clampCity(p: vec2f) -> vec2f { return clamp(p, origin() - 6.5, origin() + CITY_SIZE + 6.5); }

// ---------------------------------------------------------------- the indoor workplaces (interiors.ts, mirrored there)

// The room frame's u axis in the city for a doorway side, and its v axis (u turned a quarter clockwise).
fn doorDir(side: f32) -> vec2f {
  if (side < 0.5) { return vec2f(0.0, 1.0); }
  if (side < 1.5) { return vec2f(0.0, -1.0); }
  if (side < 2.5) { return vec2f(1.0, 0.0); }
  return vec2f(-1.0, 0.0);
}
fn acrossDir(d: vec2f) -> vec2f { return vec2f(d.y, -d.x); }
// A city point in room r's frame (u, v), and back.
fn roomLocal(r: u32, p: vec2f) -> vec2f {
  let d = doorDir(P.rooms[r].a.z);
  let q = p - P.rooms[r].a.xy;
  return vec2f(dot(q, d), dot(q, acrossDir(d)));
}
fn roomWorld(r: u32, uv: vec2f) -> vec2f {
  let d = doorDir(P.rooms[r].a.z);
  return P.rooms[r].a.xy + d * uv.x + acrossDir(d) * uv.y;
}
// The room whose lot p lies in (the lot square and the street halves round it), or -1.
fn roomOf(p: vec2f) -> i32 {
  let c = lotCenter(p);
  for (var r = 0u; r < ROOM_SLOTS; r++) {
    if (P.rooms[r].a.w > 0.5 && all(abs(c - P.rooms[r].a.xy) < vec2f(0.5))) { return i32(r); }
  }
  return -1;
}
// True when p is inside room r's walls (not in them: the doorway's band counts as the street).
fn insideRoom(r: u32, p: vec2f) -> bool {
  let l = abs(roomLocal(r, p));
  return max(l.x, l.y) < CITY_LOT_HALF - ROOM_WALL;
}
// Where a step from `was` to `to` ends in room r's lot (interiors.ts containInRoom): the walls are a band between the
// room (|u|, |v| < lotHalf − wall) and the street (beyond lotHalf), each grown by pad; a step landing in the band is put
// back on the side it came from, projected to that side's nearest free point so the rest of the step slides along the
// wall. Through the doorway (|v| < door − pad on the door side) the band is open, to whoever `mayEnter` (a worker
// on an entering or leaving leg, someone asked over following the flow field, anyone already inside: never a passer-by
// jostled off the sidewalk, who would stand lost in a room). Inside, each furniture box grown by pad pushes a step
// out along its least-penetrated axis.
fn containRoom(r: u32, was: vec2f, to: vec2f, pad: f32, mayEnter: bool) -> vec2f {
  let limOut = CITY_LOT_HALF + pad;
  let limIn = CITY_LOT_HALF - ROOM_WALL - pad;
  var l = roomLocal(r, to);
  let m = max(abs(l.x), abs(l.y));
  let inDoor = l.x > 0.0 && abs(l.y) < ROOM_DOOR - pad && mayEnter;
  if (m > limIn && m < limOut && !inDoor) {
    let f = abs(roomLocal(r, was));
    if (max(f.x, f.y) < CITY_LOT_HALF - ROOM_WALL * 0.5) {
      l = clamp(l, vec2f(-limIn), vec2f(limIn));
    } else if (limOut - abs(l.x) < limOut - abs(l.y)) {
      l.x = select(-limOut, limOut, l.x >= 0.0);
    } else {
      l.y = select(-limOut, limOut, l.y >= 0.0);
    }
  }
  var p = roomWorld(r, l);
  let n = min(u32(P.rooms[r].b.y), ROOM_FURNITURE);
  for (var k = 0u; k < n; k++) {
    let box = P.rooms[r].furniture[k];
    let lo = box.xy - pad;
    let hi = box.zw + pad;
    if (p.x <= lo.x || p.x >= hi.x || p.y <= lo.y || p.y >= hi.y) { continue; }
    let dx = min(p.x - lo.x, hi.x - p.x);
    let dz = min(p.y - lo.y, hi.y - p.y);
    if (dx < dz) { p.x = select(hi.x, lo.x, p.x - lo.x < hi.x - p.x); } else { p.y = select(hi.y, lo.y, p.y - lo.y < hi.y - p.y); }
  }
  return p;
}
// The containment of every step: a room's where the step lands in a room's lot, else the lot square's.
fn contain(was: vec2f, to: vec2f, pad: f32, mayEnter: bool) -> vec2f {
  let r = roomOf(to);
  if (r < 0) { return pushOut(to, pad); }
  return containRoom(u32(r), was, to, pad, mayEnter || insideRoom(u32(r), was));
}
// The workday's dice. Agent i's station slot (room · ROOM_STATIONS + station) when one in WORK_ONE_IN has one in a
// room this world has, else -1; and whether they are on shift at t (each starts at their own moment of the cycle).
fn workerSlot(i: u32) -> i32 {
  // The workers are every WORK_ONE_IN-th index (odd: they wear every body), the w-th dealt station w · WORK_DEAL mod
  // the stations (coprime: every station once before any twice, the rooms in turn).
  if ((i + 1u) % WORK_ONE_IN != 0u) { return -1; }
  let w = (i + 1u) / WORK_ONE_IN - 1u;
  let s = (w * WORK_DEAL) % (ROOM_SLOTS * ROOM_STATIONS);
  let r = s / ROOM_STATIONS;
  if (P.rooms[r].a.w < 0.5 || P.rooms[r].stations[s % ROOM_STATIONS].w < 0.5) { return -1; }
  return i32(s);
}
fn onDuty(i: u32, t: f32) -> bool {
  let s = t + rand(i, WORK_SALT + 2u) * WORK_CYCLE;
  return s - WORK_CYCLE * floor(s / WORK_CYCLE) < WORK_SHIFT;
}
// The door front: the sidewalk lane point outside room r's doorway, where the route leaves the street.
fn doorFront(r: u32) -> vec2f { return roomWorld(r, vec2f(CITY_PITCH * 0.5 - CITY_LANE, 0.0)); }
// The sidewalk corner a commuter walks the corner graph to: the corner of the doorway's street on the room's own block
// (interiors.ts targetCorner); its lane coordinate is the door front's, so the last stretch is straight along the lane.
fn targetCorner(r: u32) -> vec2f {
  let km = vec2i(floor((P.rooms[r].a.xy - origin()) / CITY_PITCH));
  let side = P.rooms[r].a.z;
  if (side < 0.5) { return cornerPos(km.x, km.y + 1, 1.0, -1.0); }
  if (side < 1.5) { return cornerPos(km.x, km.y, 1.0, 1.0); }
  if (side < 2.5) { return cornerPos(km.x + 1, km.y, -1.0, 1.0); }
  return cornerPos(km.x, km.y, 1.0, 1.0);
}

// Signed offsets from the nearest north-south (x) and east-west (y) street centrelines.
fn streetOffsets(p: vec2f) -> vec2f { return (p - origin()) - round((p - origin()) / CITY_PITCH) * CITY_PITCH; }
// The nearest intersection's indices.
fn nearestLines(p: vec2f) -> vec2i { return vec2i(round((p - origin()) / CITY_PITCH)); }
// On a carriageway: within CITY_ROAD_HALF of a street's centreline where cars run (a pedestrian street, or a line with no
// street in this window, is not a road: people walk its whole width).
fn onRoad(p: vec2f) -> bool {
  let o = abs(streetOffsets(p));
  let km = nearestLines(p);
  return (o.x < CITY_ROAD_HALF && roadV(km.x, km.y)) || (o.y < CITY_ROAD_HALF && roadH(km.x, km.y));
}
// Shortest way back to a sidewalk from the roadway.
fn curbwards(p: vec2f) -> vec2f {
  let o = streetOffsets(p);
  if (abs(o.y) < abs(o.x)) { return vec2f(0.0, select(-1.0, 1.0, o.y >= 0.0)); }
  return vec2f(select(-1.0, 1.0, o.x >= 0.0), 0.0);
}

fn cornerPos(k: i32, m: i32, sx: f32, sz: f32) -> vec2f {
  return vec2f(CITY_ORIGIN_X + f32(k) * CITY_PITCH + sx * CITY_LANE, CITY_ORIGIN_Z + f32(m) * CITY_PITCH + sz * CITY_LANE);
}

// Pedestrians walk a graph of sidewalk corners: two crosswalks and two block edges leave every corner, each taken only
// where the window has the street (a block edge needs its segment, a crosswalk its far corner). The same dice as ever:
// where every street exists (the procedural city) the choice is the one it always was; a corner with no way out holds.
fn nextCorner(t: vec2f, seed: u32) -> vec2f {
  let km = nearestLines(t);
  let k = km.x;
  let m = km.y;
  let sx = select(-1.0, 1.0, t.x - (CITY_ORIGIN_X + f32(k) * CITY_PITCH) >= 0.0);
  let sz = select(-1.0, 1.0, t.y - (CITY_ORIGIN_Z + f32(m) * CITY_PITCH) >= 0.0);
  let nk = k + i32(sx);
  let nm = m + i32(sz);
  let alongX = walkable(hSeg(min(k, nk), m));
  let alongZ = walkable(vSeg(k, min(m, nm)));
  let acrossX = cornerExists(k, m, -sx, sz);
  let acrossZ = cornerExists(k, m, sx, -sz);
  let r = rand(seed, 17u);
  if (r < 0.38 && alongX) { return cornerPos(nk, m, -sx, sz); }
  if (r < 0.76 && alongZ) { return cornerPos(k, nm, sx, -sz); }
  if (r < 0.88 && acrossX) { return cornerPos(k, m, -sx, sz); }
  if (acrossZ) { return cornerPos(k, m, sx, -sz); }
  if (acrossX) { return cornerPos(k, m, -sx, sz); }
  if (alongZ) { return cornerPos(k, nm, sx, -sz); }
  if (alongX) { return cornerPos(nk, m, -sx, sz); }
  return t;
}
// The corner graph with a destination: of the four ways out of corner t (as nextCorner has them, each where the window
// has the street), the one that brings a commuter nearest `dest` by city blocks (Manhattan: every way out runs along
// an axis, so the distance falls at every step and the walk ends at the target's corner). A corner with no way nearer
// (never, where every street exists) falls back to the day's dice.
fn towardCorner(t: vec2f, dest: vec2f, seed: u32) -> vec2f {
  let km = nearestLines(t);
  let k = km.x;
  let m = km.y;
  let sx = select(-1.0, 1.0, t.x - (CITY_ORIGIN_X + f32(k) * CITY_PITCH) >= 0.0);
  let sz = select(-1.0, 1.0, t.y - (CITY_ORIGIN_Z + f32(m) * CITY_PITCH) >= 0.0);
  let nk = k + i32(sx);
  let nm = m + i32(sz);
  let ways = array<vec2f, 4>(cornerPos(nk, m, -sx, sz), cornerPos(k, nm, sx, -sz), cornerPos(k, m, -sx, sz), cornerPos(k, m, sx, -sz));
  let open = array<bool, 4>(walkable(hSeg(min(k, nk), m)), walkable(vSeg(k, min(m, nm))), cornerExists(k, m, -sx, sz), cornerExists(k, m, sx, -sz));
  var best = t;
  var bestD = abs(t.x - dest.x) + abs(t.y - dest.y);
  for (var w = 0u; w < 4u; w++) {
    if (!open[w]) { continue; }
    let d = abs(ways[w].x - dest.x) + abs(ways[w].y - dest.y);
    if (d < bestD - 1e-3) {
      bestD = d;
      best = ways[w];
    }
  }
  if (all(best == t)) { return nextCorner(t, seed); }
  return best;
}
// The sidewalk corner nearest p on p's own block (both street offsets keep their sign): reachable along the
// sidewalk without crossing a street. A released recruit resumes their day from there.
fn cornerOf(p: vec2f) -> vec2f {
  let km = nearestLines(p);
  let o = streetOffsets(p);
  return cornerPos(km.x, km.y, select(-1.0, 1.0, o.x >= 0.0), select(-1.0, 1.0, o.y >= 0.0));
}

// Moving between two corners of the same intersection means using a crosswalk: over the street cars run on, the walk
// signal is waited for (a pedestrian street, or a line with none in this window, is crossed at will).
fn isCrossing(a: vec2f, b: vec2f) -> bool {
  let km = nearestLines(a);
  if (!all(km == nearestLines(b))) { return false; }
  if (abs(b.x - a.x) > abs(b.y - a.y)) { return roadV(km.x, km.y); }
  return roadH(km.x, km.y);
}

fn approachAngle(a: f32, b: f32, maxStep: f32) -> f32 {
  var d = b - a;
  d = d - TAU * floor((d + PI) / TAU);
  return a + clamp(d, -maxStep, maxStep);
}

fn dirTo(a: vec2f, b: vec2f) -> vec2f {
  let d = b - a;
  let l = length(d);
  return select(vec2f(0.0), d / l, l > 1e-4);
}

// ---------------------------------------------------------------- passes

@compute @workgroup_size(256)
fn clearGrid(@builtin(global_invocation_id) gid: vec3u) {
  if (gid.x < GRID_CELLS) { atomicStore(&gridCountW[gid.x], 0u); }
}

// Snapshot (pos.xz, vel.xz) into the hash grid; the simulate pass reads only this snapshot, so
// neighbour reads never race with this frame's writes. The player's avatar is never binned: the crowd is
// ghost-mode to the user, who walks through people while they keep their own line (no separation, alignment
// or cohesion from the user). Someone asked over still keeps their talking distance, from the summons.
@compute @workgroup_size(128)
fn binAgents(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.agentCount || i == PLAYER_INDEX) { return; }
  let p = pos[i];
  if (p.y < -50.0) { return; }
  let ci = cellId(cellOf(p.xz));
  let s = atomicAdd(&gridCountW[ci], 1u);
  if (s < GRID_CAP) { gridSlotsW[ci * GRID_CAP + s] = vec4f(p.xz, vel[i].xy); }
}

@compute @workgroup_size(128)
fn spawn(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.agentCount) { return; }
  // A block edge with a sidewalk: the first dice where every street exists (the procedural city), else the next few
  // throws, else the window's first (SPAWN_K, SPAWN_M; streets.ts spawnSegment).
  var k = i32(hash2(i, 1u) % u32(CITY_BLOCKS));
  var m = i32(hash2(i, 2u) % u32(CITY_BLOCKS));
  for (var t = 1u; t < 16u && !walkable(hSeg(k, m)); t++) {
    k = i32(hash2(i, 1u + t * 64u) % u32(CITY_BLOCKS));
    m = i32(hash2(i, 2u + t * 64u) % u32(CITY_BLOCKS + 1));
  }
  if (!walkable(hSeg(k, m))) { k = SPAWN_K; m = SPAWN_M; }
  let sz = select(-1.0, 1.0, (hash2(i, 6u) & 1u) == 1u);
  // Start somewhere along a block edge heading east (never mid-crosswalk).
  let c = cornerPos(k, m, 1.0, sz);
  let goal = cornerPos(k + 1, m, -1.0, sz);
  let dir = dirTo(c, goal);
  let p = mix(c, goal, 0.1 + 0.8 * rand(i, 8u)) + vec2f(0.0, (rand(i, 9u) - 0.5) * 1.4);
  let flip = (hash2(i, 12u) & 1u) == 1u;
  pos[i] = vec4f(p.x, 0.0, p.y, atan2(dir.x, dir.y));
  vel[i] = vec4f(0.0, 0.0, rand(i, 11u) * TAU, 0.0);
  pose[i] = vec4f(0.0);
  var b: Brain;
  b.a = vec4f(select(goal, c, flip), 1.1 + rand(i, 10u) * 0.4, 0.0);
  b.b = vec4f(0.0);
  b.c = vec4f(0.0);
  b.d = vec4f(0.0);
  brain[i] = b;
}

@compute @workgroup_size(128)
fn simulate(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.agentCount) { return; }
  let dt = P.dt;

  // Agent 0 is the player's avatar: the CPU (Rapier character controller) owns its position.
  // Its hazard distances come from the CPU too (Fleet measures the avatar exactly).
  if (i == PLAYER_INDEX) {
    let vis = P.aux.x > 0.5;
    let h = P.player.z;
    let v0 = vel[i];
    let ph = v0.z + P.player.w * dt * (TAU / 1.45);
    pos[i] = vec4f(P.player.x, select(-100.0, 0.0, vis), P.player.y, h);
    vel[i] = vec4f(sin(h) * P.player.w, cos(h) * P.player.w, ph - TAU * floor(ph / TAU), P.player.w);
    pose[i] = vec4f(0.0);
    return;
  }

  var p = pos[i];
  var v = vel[i];
  var ps = pose[i];
  var b = brain[i];
  var me = p.xz;
  let physicsMask = physicsMaskFor(P.global);
  // The other pedestrians' and the cars' contact with this person, 1 or 0 by the mask (the static world's bit is
  // never consulted: the ground, the lots and the city's edge hold everyone, in every mode).
  let bodies = layerOn(physicsMask, PHYSICS_BODY);
  let vehicles = layerOn(physicsMask, PHYSICS_VEHICLE);

  var sep = vec2f(0.0);
  var ali = vec2f(0.0);
  var coh = vec2f(0.0);
  var cnt = 0.0;
  let c = cellOf(me);
  for (var dy = -1; dy <= 1; dy++) {
    for (var dx = -1; dx <= 1; dx++) {
      let cc = c + vec2i(dx, dy);
      if (any(cc < vec2i(0)) || any(cc >= vec2i(GRID_DIM))) { continue; }
      let ci = cellId(cc);
      let n = min(gridCountR[ci], GRID_CAP);
      for (var s = 0u; s < n; s++) {
        let q = gridSlotsR[ci * GRID_CAP + s];
        let d = me - q.xy;
        let d2 = dot(d, d);
        if (d2 < 1e-6) { continue; }
        if (d2 < SEP_R2) { sep += d / d2 * bodies; }
        if (d2 < NEIGH_R2) {
          ali += q.zw * bodies;
          coh += q.xy * bodies;
          cnt += bodies;
        }
      }
    }
  }

  // Vehicles: First-Law sensing for the car, a Reflex save to get out of the way, and a hard safety
  // nudge if one touches anyone.
  let road = onRoad(me);
  for (var j = 0u; j < P.carCount; j++) {
    let car = P.cars[j];
    let f = vec2f(sin(car.a.z), cos(car.a.z));
    let r = vec2f(-f.y, f.x); // the car's right
    let rel = me - car.a.xy;
    var lz = dot(rel, f);
    var lx = dot(rel, r);
    // Nobody farther than the corridor reach (corridorReach, crowdCompute.ts) is in this car's path
    // either way. In the direction of travel the rear axle is CAR_AXLE behind the centre driving on,
    // ahead of it reversing; the chassis' left is -lx either way. u32() floors to whole centimetres, so
    // a reported gap never exceeds the true one.
    if (dot(rel, rel) <= car.b.w * car.b.w) {
      let ahead = corridorGap(lz, -lx, car.b.x, car.b.y, car.b.z, -CAR_AXLE);
      if (ahead >= 0.0) { atomicMin(&hazards[j], u32(ahead * 100.0)); }
      let behind = corridorGap(-lz, -lx, car.b.x, car.b.y, car.b.z, CAR_AXLE);
      if (behind >= 0.0) { atomicMin(&hazards[MAX_CARS + j], u32(behind * 100.0)); }
    }
    // The contact and the save are the vehicle layer's: off the mask, a car passes through this person (and the
    // person through the car) with no push, no stagger, no step back; the sensing above still counted them.
    let hw = (car.b.x + BODY_PAD) * vehicles;
    let hl = (car.b.y + BODY_PAD) * vehicles;
    if (abs(lx) < hw && abs(lz) < hl) {
      if (hw - abs(lx) < hl - abs(lz)) { lx = select(-hw, hw, lx >= 0.0); } else { lz = select(-hl, hl, lz >= 0.0); }
      let pushed = car.a.xy + r * lx + f * lz;
      let push = pushed - me;
      me = pushed;
      ps.z = atan2(push.x, push.y);
      b.b.x += 1.2;
      b.b.y += 4.0;
      atomicAdd(&stats[0], 1u);
    } else if (road && vehicles > 0.5 && b.c.z <= 0.0 && abs(car.a.w) > 1.0 && lz > 0.0 && lz < YIELD_LOOKAHEAD && abs(lx) < 2.6) {
      let dc = YIELD_DC + i32(round(YIELD_DC_BONUS * clamp(abs(car.a.w) / 12.0, 0.0, 1.0)));
      let nat = d20(i, hash2(j, u32(P.time * 2.0)));
      let deg = degreeOf(nat, nat + YIELD_MOD, dc);
      var speed = 2.2;
      var freeze = 0.0;
      if (deg == 2) {
        speed = 1.9;
        freeze = 0.2;
      } else if (deg == 1) {
        speed = 1.6;
        freeze = 0.55;
      } else if (deg == 0) {
        speed = 1.4;
        freeze = 1.0;
      }
      b.a.w = speed;
      b.c = vec4f(curbwards(me), 1.8, freeze);
    }
  }

  // Navigation: block edges freely, crosswalks only on the walk signal.
  var desired = vec2f(0.0);
  var faceDir = vec2f(0.0);
  var crossing = b.b.z;
  var activity = ACT_ROUTINE;
  // True while the summons arm steers this person (coming over or talking): the kerb then binds their whole step.
  var asked = false;
  // True while the workday steers this person off the corner graph (to the door, indoors, back out): no flocking then,
  // and the doorway lets them through.
  var working = false;
  var mayEnter = false;

  // Summons: is this person one the operator asked over, and to where?
  var summoned = false;
  var tethered = false;
  var at = vec2f(0.0);
  for (var s = 0u; s < SUMMON_SLOTS; s++) {
    let q = P.summons[s];
    if (q.agent == i && q.flags != 0u) {
      summoned = true;
      tethered = (q.flags & 2u) != 0u;
      at = q.at;
    }
  }
  summoned = summoned && !nonFinite(at);
  if (!summoned && b.b.w > 0.0) {
    // Released (dismissed, the tether broke, or they were never reachable): back to their day from the
    // nearest corner of their own block, never mid-street.
    b.b.w = 0.0;
    b.a = vec4f(cornerOf(me), b.a.z, b.a.w);
    crossing = CROSS_NONE;
  }
  if (summoned && b.b.w == 0.0) {
    // The request is taken only from someone standing on the sidewalk and still within earshot; anyone else goes
    // on with their day (the physics realm sees they never came and lets the request go).
    if (!road && crossing != CROSS_WALK && distance(me, at) <= SUMMON_ACCEPT) {
      b.b.w = 1.0;
      crossing = CROSS_NONE;
      // Whatever the workday was doing, the operator's request comes first; released, they resume their day from a corner.
      b.d = vec4f(0.0);
    } else {
      summoned = false;
    }
  }

  if (b.c.w > 0.0) {
    b.c.w -= dt;
    activity = ACT_STEPPING_BACK;
  } else if (b.c.z > 0.0) {
    b.c.z -= dt;
    desired = b.c.xy * b.a.w;
    atomicAdd(&stats[3], 1u);
    activity = ACT_STEPPING_BACK;
  } else if (summoned) {
    asked = true;
    // Asked over: walk straight to the operator along the sidewalk (the request was only made where that line stays
    // off the road), slowing near, and stop at SUMMON_STOP facing them. Talking, they keep that distance: jostled
    // closer they step back (as fast as the operator walks, so someone the operator walks towards gives way), drifted
    // off they step in (a dead band keeps them still in between). A step that would leave the kerb is not taken;
    // someone already on the road heads back to the kerb. If the operator walks off, follow (the tether).
    let d = at - me;
    let dist = length(d);
    if (b.b.w < 1.5 && dist <= SUMMON_STOP) {
      b.b.w = 2.0;
    } else if (b.b.w > 1.5 && dist > SUMMON_STOP * 1.5) {
      b.b.w = 1.0;
    }
    if (b.b.w > 1.5) {
      let gap = dist - SUMMON_STOP;
      desired = dirTo(me, at) * select(0.0, clamp(gap * 4.0, -2.4, 0.6), abs(gap) > 0.2);
      faceDir = d;
      activity = ACT_INTERVIEWING;
    } else {
      // Tethered and fallen behind: hurry (TETHER_PACE, under the 3 m/s cap), easing to their own pace near.
      let pace = select(b.a.z, max(b.a.z, TETHER_PACE * clamp((dist - SUMMON_STOP) / 2.0, 0.0, 1.0)), tethered);
      // Round the buildings: the flow field's direction under their feet when it has one, the straight line on the
      // last stretch (so they arrive and stop as before) and wherever the field is silent.
      let flow = flowAt(me);
      let way = select(dirTo(me, at), flow, dot(flow, flow) > 0.5 && dist > 4.0 * SUMMON_STOP);
      desired = way * pace * clamp(dist - SUMMON_STOP, 0.25, 1.0);
      activity = ACT_COMING;
    }
    if (road) {
      desired = curbwards(me) * b.a.z;
    } else {
      if (onRoad(me + vec2f(desired.x, 0.0) * 0.5)) { desired.x = 0.0; }
      if (onRoad(me + vec2f(0.0, desired.y) * 0.5)) { desired.y = 0.0; }
    }
  } else {
    // The workday. A worker's phase is theirs alone (nobody else ever has one); off duty it is WORK_OFF and they walk
    // the corner graph like everyone. On shift the next corner reached is chosen towards the workplace, and from the
    // workplace's corner the legs below take over. Anyone standing inside a room with no phase (a recruit the operator
    // let go indoors, a fallen person set back on their feet there) leaves it by the hub and the doorway.
    let slot = workerSlot(i);
    var phase = b.d.x;
    var room = u32(b.d.y);
    if (slot >= 0) {
      // Their own workplace, until a shift ends (the leaving legs keep whichever room they are in).
      if (phase < 6.5) { room = u32(slot) / ROOM_STATIONS; }
      let duty = onDuty(i, P.time);
      if (phase < 0.5 && duty) { phase = WORK_COMMUTE; }
      if (phase > 5.5 && phase < 6.5 && !duty) { phase = WORK_LEAVE_ROW; }
    } else if (phase > 0.5 && phase < 6.5) {
      // No workplace any more (never, in one world): finish by walking out from wherever this leg is.
      phase = select(WORK_OFF, WORK_LEAVE_HUB, phase > 2.5);
    }
    if (phase < 0.5) {
      let here = roomOf(me);
      if (here >= 0 && insideRoom(u32(here), me)) {
        phase = WORK_LEAVE_HUB;
        room = u32(here);
      }
    }
    if (phase >= WORK_APPROACH) {
      working = true;
      mayEnter = phase > 2.5;
      let st = P.rooms[room].stations[u32(max(slot, 0)) % ROOM_STATIONS];
      let station = roomWorld(room, st.xy);
      var dest = doorFront(room);
      var arrive = WORK_ARRIVE + 0.2;
      if ((phase > 2.5 && phase < 3.5) || (phase > 7.5 && phase < 8.5)) { dest = roomWorld(room, vec2f(P.rooms[room].b.x, 0.0)); arrive = WORK_ARRIVE; }
      if ((phase > 3.5 && phase < 4.5) || (phase > 6.5 && phase < 7.5)) { dest = roomWorld(room, vec2f(P.rooms[room].b.x, st.y)); arrive = WORK_ARRIVE; }
      if (phase > 4.5 && phase < 6.5) { dest = station; arrive = WORK_ARRIVE; }
      let to = dest - me;
      let dist = length(to);
      if (phase > 5.5 && phase < 6.5) {
        // At work: hold the station (a spring back to it against the jostle), face the desk, lean to it.
        desired = select(vec2f(0.0), to / dist * min(dist * 3.0, b.a.z), dist > 1e-3);
        faceDir = vec2f(sin(st.z), cos(st.z));
        activity = ACT_WORKING;
        atomicAdd(&stats[5], 1u);
      } else {
        desired = select(vec2f(0.0), to / dist * b.a.z * clamp(dist / 1.5, 0.3, 1.0), dist > 1e-3);
        activity = ACT_COMMUTING;
        if (dist < arrive) {
          if (phase > 8.5) {
            // Out on the sidewalk again: back to the day from this block's nearest corner.
            phase = WORK_OFF;
            b.a = vec4f(cornerOf(me), b.a.z, b.a.w);
          } else {
            phase += 1.0;
          }
        }
      }
      crossing = CROSS_NONE;
    } else {
    let goal = b.a.xy;
    if (crossing == CROSS_WAIT) {
      let d = goal - me;
      // Perception check to notice the walk signal, one roll per agent per signal cycle: its degree
      // sets how long into the walk phase this pedestrian steps off. Someone arriving after that
      // delay has already run goes at once; nobody starts outside the walk phase.
      let cycle = bitcast<u32>(i32(floor(P.signalTime / SIGNAL_CYCLE)));
      let nat = d20(i, hash2(cycle, WALK_SALT));
      let delay = walkDelay(degreeOf(nat, nat + WALK_MOD, WALK_DC));
      let walked = walkElapsed(abs(d.x) > abs(d.y), P.signalTime);
      if (walked >= 0.0 && walked >= delay) {
        crossing = CROSS_WALK;
      } else {
        faceDir = d;
        atomicAdd(&stats[1], 1u);
        activity = ACT_WAITING;
      }
    }
    if (crossing != CROSS_WAIT) {
      if (distance(me, goal) < 1.3) {
        let commuting = phase > 0.5 && phase < 1.5;
        if (commuting && distance(goal, targetCorner(room)) < 0.5) {
          // The workplace's corner: along the lane to the door front from here.
          phase = WORK_APPROACH;
          crossing = CROSS_NONE;
        } else {
          let next = select(nextCorner(goal, hash2(i, P.frame)), towardCorner(goal, targetCorner(room), hash2(i, P.frame)), commuting);
          crossing = select(CROSS_NONE, CROSS_WAIT, isCrossing(goal, next));
          b.a = vec4f(next, b.a.z, b.a.w);
        }
      } else {
        desired = dirTo(me, goal) * b.a.z;
        if (crossing == CROSS_WALK) {
          desired *= 1.12;
          atomicAdd(&stats[2], 1u);
          activity = ACT_CROSSING;
        }
      }
    }
    }
    b.d = vec4f(phase, f32(room), 0.0, 0.0);
  }
  b.b.z = crossing;

  // Boids steering: separation for everyone, gentle alignment and cohesion for walking flows (not for someone
  // walking over to the operator: a passing stream would carry them off their line).
  var steer = desired + sep * 0.8;
  if (cnt > 0.0 && dot(desired, desired) > 0.01 && !asked && !working) {
    steer += (ali / cnt - v.xy) * 0.2 + (coh / cnt - me) * 0.04;
  }
  var nv = mix(v.xy, steer, clamp(dt * 5.0, 0.0, 1.0));
  let sp = length(nv);
  if (sp > 3.0) { nv *= 3.0 / sp; }
  // Nor does the crowd's jostle (recruits queueing behind them, above all) carry someone asked over inside SUMMON_STOP:
  // there, the part of the step taken towards the operator is dropped. Before the kerb clip, which has the last word.
  if (asked) {
    let to = at - me;
    let dd = length(to);
    if (dd > 1e-4 && dd < SUMMON_STOP) {
      let u = to / dd;
      let inward = dot(nv, u);
      if (inward > 0.0) { nv -= u * inward; }
    }
  }
  // Someone asked over never leaves the sidewalk, whatever the crowd's jostle adds to their own step. The carriageway is
  // where either street offset is under CITY_ROAD_HALF, so each axis is tested on its own, and together they are exact.
  if (asked && !road) {
    if (onRoad(me + vec2f(nv.x * dt, 0.0))) { nv.x = 0.0; }
    if (onRoad(me + vec2f(0.0, nv.y * dt))) { nv.y = 0.0; }
  }
  // The new position before containment: clampCity would launder an infinity or a NaN into a corner.
  let next = me + nv * dt;
  // The lots hold everyone out, a room's doorway lets its people through (contain). The part of the step a wall or a
  // piece of furniture refused is taken out of the velocity too, so the step slides along it and the walk phase reads
  // the speed actually made, with nothing left pressing into the wall.
  let held = contain(me, next, 0.35, mayEnter || asked);
  me = clampCity(held);
  let refused = held - next;
  if (dot(refused, refused) > 1e-10) {
    let wallN = normalize(refused);
    let into = dot(nv, wallN);
    if (into < 0.0) { nv -= wallN * into; }
  }

  // Stagger: harmonic oscillators pull the torso and body back upright.
  b.b.y += (-K_BEND * ps.y - C_BEND * b.b.y) * dt;
  ps.y += b.b.y * dt;
  b.b.x += (-K_TILT * ps.x - C_TILT * b.b.x) * dt;
  ps.x += b.b.x * dt;
  // At work: a lean to the desk with a slow nod on it (the springs bring the body back up when the shift ends).
  if (activity == ACT_WORKING) { ps.y = 0.1 + 0.04 * sin(P.time * 2.5 + f32(i)); }

  let spd = length(nv);
  var heading = p.w;
  if (dot(faceDir, faceDir) > 1e-6) {
    heading = atan2(faceDir.x, faceDir.y);
  } else if (spd > 0.15) {
    heading = atan2(nv.x, nv.y);
  }
  p.w = approachAngle(p.w, heading, dt * 6.0);
  let phase = v.z + spd * dt * (TAU / 1.45);

  // Ring-0 audit (ring0.ts): a non-finite position, velocity, heading or walk phase raises the sticky
  // flag the CPU reads back with the stats; the engine treats it as NON_FINITE for the pedestrians.
  if (nonFinite(next) || nonFinite(nv) || nonFinite(vec2f(p.w, phase))) { atomicOr(&stats[4], FLAG_NON_FINITE); }

  pos[i] = vec4f(me.x, 0.0, me.y, p.w);
  vel[i] = vec4f(nv, phase - TAU * floor(phase / TAU), spd);
  ps.w = activity;
  pose[i] = ps;
  brain[i] = b;
}

// The density lottery's cut at distance d: everyone at the near radius, falling linearly to `density` over
// DENSITY_FADE metres beyond it (a fixed draw below the cut is drawn, so people thin out instead of popping at a wall).
fn densityCut(d: f32, near: f32, density: f32) -> f32 {
  let t = clamp((d - near) / DENSITY_FADE, 0.0, 1.0);
  return 1.0 + (density - 1.0) * t;
}

// A person's detailed-body distance: lodDistance spread by ±LOD_SPREAD/2 on their fixed draw r in [0, 1), so the
// bodies at a ring (or a tier change moving it) swap a few at a time. Zero stays zero.
fn lodCut(lodDistance: f32, r: f32) -> f32 {
  return lodDistance * (1.0 + (r - 0.5) * LOD_SPREAD);
}

// Visibility + density + LOD compaction: every drawn agent is appended to its (variant, LOD) draw
// list and bumps that indirect draw's instance count. Agents close to the camera are kept even when
// outside the frustum so their shadows still land in view. Beyond nearRadius the drawn fraction
// falls to `density` over DENSITY_FADE metres, chosen by a fixed per-agent lottery so the same people
// stay on screen (and raising the density only adds people). Nobody is drawn beyond the max draw distance.
@compute @workgroup_size(128)
fn cull(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.agentCount) { return; }
  let p = pos[i];
  if (p.y < -50.0) { return; }
  let c = vec3f(p.x, 0.9, p.z);
  let d = distance(c, P.camera.xyz);
  if (d >= P.aux.z) { return; }
  var visible = d < P.nearRadius;
  if (!visible) {
    // The avatar is never thinned out.
    if (i != PLAYER_INDEX && rand(i, DENSITY_SALT) >= densityCut(d, P.nearRadius, P.aux.y)) { return; }
    visible = true;
    for (var k = 0u; k < 6u; k++) {
      let pl = P.planes[k];
      if (dot(pl.xyz, c) + pl.w < -1.2) {
        visible = false;
        break;
      }
    }
  }
  if (!visible) { return; }
  let lod = select(1u, 0u, d < lodCut(P.lodDistance, rand(i, LOD_SALT)));
  // The body: the look word's (bits 1-2) when one is worn (bit 0), else the index's.
  let w = look[i];
  let variant = select(i % VARIANTS, (w >> 1u) & 3u, (w & 1u) == 1u);
  let draw = lod * VARIANTS + variant;
  let slot = atomicAdd(&drawArgs[draw * 5u + 1u], 1u);
  drawLists[lod * LIST_LOD_STRIDE + variant * AGENT_QUOTA + slot] = i;
}
