// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? Matrix mode's surface: falling columns of green code drawn ON the city's meshes, in world
// space, by triplanar mapping (a roof takes its columns from (x, z), a wall facing x from (z, y), any other wall from
// (x, y)), so the code sits on the facades and streets and moves with them as the camera moves. It replaces nothing
// of the ghost view (07_Execute_Actions/ghost.ts), which is a screen-space pass over the finished frame and so
// recedes the sky with the city; this shader never touches the sky, because the sky's mesh never takes it.
// It is one WGSL function that three's node materials call from their colour graph (matrixMode.ts applyMatrixMode
// binds it with wgslFn): the fragment pipeline, its vertex output and its bind groups are three's own, so
// `world_position`, `normal` and `base_color` arrive as arguments where a hand-written pipeline would read them
// from a VertexOutput struct and a texture, and `global_state` is the one vec4 uniform matrixMode.ts packs for every
// pipeline that takes matrix mode (this one and 03_Spawn_Agents/crowd.wgsl Params.global): x = time (s),
// y = matrix mode (1 on, 0 off), z and w = the floating origin (x, z), metres.
// The floating origin: the pattern is a fract() of the world position times ten, and at a kilometre from the world's
// origin an f32 fract of that has a thousandth of a cell of precision, at a hundred kilometres none. So the host
// anchors an origin near the camera, snapped to whole metres (matrixMode.ts floatingOrigin), and the columns are
// computed relative to it; the column's id adds the origin back as a whole number (exact in f32 below 2^24, that
// is 1,677 km), so the pattern keyed on the id is the same wherever the camera stands and never slides as the
// origin moves.
// What breaks if it is removed? Matrix mode has no surface: the materials' graphs reference a function that does
// not exist, and the page fails to compile its shaders.

fn matrixRandom(st: vec2<f32>) -> f32 {
    return fract(sin(dot(st.xy, vec2<f32>(12.9898, 78.233))) * 43758.5453123);
}

// The surface in matrix mode: rgb = the code's glow (emissive, scene-referred) and the dim base, a = 1; or, with
// matrix mode off, rgb = base_color untouched and a = 0, so the host knows nothing was changed.
fn matrixSurface(world_position: vec3<f32>, normal: vec3<f32>, base_color: vec3<f32>, global_state: vec4<f32>) -> vec4<f32> {
    if (global_state.y < 0.5) { return vec4<f32>(base_color, 0.0); }

    let time = global_state.x * 1.5;
    let origin = global_state.zw;
    var rain_uv: vec2<f32>;
    var origin_uv: vec2<f32>;
    if (abs(normal.y) > 0.5) {
        rain_uv = vec2<f32>(world_position.x, world_position.z);
        origin_uv = vec2<f32>(origin.x, origin.y);
    } else if (abs(normal.x) > 0.5) {
        rain_uv = vec2<f32>(world_position.z, world_position.y);
        origin_uv = vec2<f32>(origin.y, 0.0);
    } else {
        rain_uv = vec2<f32>(world_position.x, world_position.y);
        origin_uv = vec2<f32>(origin.x, 0.0);
    }

    // Camera-relative: the fract terms below see small numbers; the id sees the same whole number as at the origin.
    let grid_uv = (rain_uv - origin_uv) * 10.0;
    let id = floor(grid_uv) + origin_uv * 10.0;
    let column_speed = matrixRandom(vec2<f32>(id.x, 0.0)) * 2.0 + 0.5;
    let drop_pos = fract(time * column_speed + matrixRandom(vec2<f32>(id.x, 1.0)));
    let dist = 1.0 - fract(grid_uv.y + drop_pos * 20.0);
    let glow = smoothstep(0.0, 0.5, dist) * step(0.2, matrixRandom(id));
    let matrix_color = vec3<f32>(0.05, 0.8, 0.15) * glow;
    let edge = smoothstep(0.0, 0.05, fract(world_position.y * 5.0));
    let final_color = matrix_color + (vec3<f32>(0.0, 0.2, 0.0) * edge);

    return vec4<f32>(final_color + (base_color * 0.1), 1.0);
}
