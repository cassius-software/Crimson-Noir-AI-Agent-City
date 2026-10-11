// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? It is the vector flow field solved on the GPU (06_Make_Decisions/flowField.ts is the
// CPU reference it is held equal to): `relax` is one Jacobi pass of the integration field over the grid (dispatched
// again and again, ping-ponging two cost buffers, until a pass changes nothing), and `direction` turns the converged
// costs into the unit direction per cell, written straight into the crowd's flow texture (crowd.wgsl flowAt samples
// it by the cell under a person's feet). Costs are integers: 10 a straight step, 14 a diagonal, times the cell's entry weight (0 blocked, 1
// sidewalk, 3 road); UNREACHED marks a wall or a cell no route reaches. The neighbour order, the corner rule (a
// diagonal never cuts a blocked corner) and the tie rule (the first cheaper neighbour wins) are the reference's.
// What breaks if it is removed? The field is solved on the worker's CPU instead (flowFieldGpu.ts falls back).

const UNREACHED: i32 = 0x3fffffff;
const STRAIGHT: i32 = 10;
const DIAGONAL: i32 = 14;
const DIAGONAL_UNIT: f32 = 0.70710677;

struct Grid {
  width: u32,
  height: u32,
  cells: u32,
  pad: u32,
}

@group(0) @binding(0) var<uniform> grid: Grid;
// Per cell: 0 blocked, else the weight a step into it is multiplied by.
@group(0) @binding(1) var<storage, read> weight: array<u32>;
@group(0) @binding(2) var<storage, read> costIn: array<i32>;
@group(0) @binding(3) var<storage, read_write> costOut: array<i32>;
// The crowd's flow texture: one texel per cell, (x, z) of the direction, written by `direction` alone.
@group(0) @binding(4) var flow: texture_storage_2d<rg32float, write>;
// How many cells the last relax pass changed (the host clears it before a batch and reads it after).
@group(0) @binding(5) var<storage, read_write> changed: atomic<u32>;

const DI = array<i32, 8>(1, -1, 0, 0, 1, -1, 1, -1);
const DJ = array<i32, 8>(0, 0, 1, -1, 1, 1, -1, -1);

// Whether a step from (i, j) to (i + di, j + dj) may be taken: inside, unblocked, and a diagonal between two open cells.
fn open(i: i32, j: i32, di: i32, dj: i32, diagonal: bool) -> bool {
  let ni = i + di;
  let nj = j + dj;
  let w = i32(grid.width);
  let h = i32(grid.height);
  if (ni < 0 || nj < 0 || ni >= w || nj >= h) { return false; }
  if (weight[u32(nj * w + ni)] == 0u) { return false; }
  if (diagonal && (weight[u32(j * w + ni)] == 0u || weight[u32(nj * w + i)] == 0u)) { return false; }
  return true;
}

@compute @workgroup_size(64)
fn relax(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x;
  if (c >= grid.cells) { return; }
  let w = weight[c];
  if (w == 0u) { costOut[c] = UNREACHED; return; }
  let i = i32(c % grid.width);
  let j = i32(c / grid.width);
  var best = costIn[c];
  for (var k = 0u; k < 8u; k++) {
    let diagonal = k >= 4u;
    if (!open(i, j, DI[k], DJ[k], diagonal)) { continue; }
    let n = costIn[u32((j + DJ[k]) * i32(grid.width) + (i + DI[k]))];
    if (n >= UNREACHED) { continue; }
    let v = n + select(STRAIGHT, DIAGONAL, diagonal) * i32(w);
    if (v < best) { best = v; }
  }
  costOut[c] = best;
  if (best != costIn[c]) { atomicAdd(&changed, 1u); }
}

@compute @workgroup_size(64)
fn direction(@builtin(global_invocation_id) id: vec3<u32>) {
  let c = id.x;
  if (c >= grid.cells) { return; }
  var dx = 0.0;
  var dz = 0.0;
  let own = costIn[c];
  if (weight[c] != 0u && own < UNREACHED && own > 0) {
    let i = i32(c % grid.width);
    let j = i32(c / grid.width);
    var best = own;
    for (var k = 0u; k < 8u; k++) {
      let diagonal = k >= 4u;
      if (!open(i, j, DI[k], DJ[k], diagonal)) { continue; }
      let n = costIn[u32((j + DJ[k]) * i32(grid.width) + (i + DI[k]))];
      if (n < best) {
        best = n;
        dx = select(f32(DI[k]), f32(DI[k]) * DIAGONAL_UNIT, diagonal);
        dz = select(f32(DJ[k]), f32(DJ[k]) * DIAGONAL_UNIT, diagonal);
      }
    }
  }
  textureStore(flow, vec2<i32>(i32(c % grid.width), i32(c / grid.width)), vec4<f32>(dx, dz, 0.0, 0.0));
}
