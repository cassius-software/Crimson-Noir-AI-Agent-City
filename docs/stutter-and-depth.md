<!--
Copyright (c) 2026 Julian Cassius Subban
SPDX-License-Identifier: MIT
Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
-->
# The periodic stall and the texture flashing

This note records what was found behind the two complaints about the page on a real GPU (a freeze of a few seconds
about every fifteen seconds, and far surfaces flashing), what was changed, what the cloud could verify, and the one
check only a machine with a GPU can make.

## 1. The stall: the sky probe re-keyed every material every 12 s

`src/01_Initialize_World/world.ts` bakes the sky into the scene's reflection map (a PMREM, 256² with its mip chain)
and refreshes it as the sun moves, once the clock has advanced 0.2 h. The clock runs one game hour a real minute at
the default `?day=24`, so the refresh ran every **12 s** of real time, which matches the reported period (the frame
clock is capped at 50 ms a frame, so a freeze itself barely advances the clock; the next refresh comes 12 s after the
freeze ends, which is the "about fifteen" seen).

Each refresh did three things on the main thread:

1. `PMREMGenerator.fromScene(envScene, 0.02)` with no target: three allocates a **new** render target and texture
   (`_allocateTarget`), renders the six cube faces, blurs them and builds the mip chain.
2. `scene.environment = next.texture`: a **new texture object**. three's node renderer keys every material's shader on
   the environment texture's node (`Nodes.updateEnvironment` makes a new `texture()` node per texture object, and
   `getCacheKey` folds that node's id into the scene's cache key). A new key means every render object in the scene
   is rebuilt: the node graph of every material (buildings, streets, water, the fleet, the pedestrians, the props)
   is generated again, and any shader whose generated code differs is compiled again by the GPU driver.
3. `envTarget.dispose()`: the previous target's GPU resources released.

Nothing else in the page runs on a 10 to 20 s period: the longtask telemetry (PR #20), the governor's quality probe
(12 s, but it only reads frame intervals), the crowd's GPU readbacks (asynchronous, with free staging slots, never
awaited on the frame) and the map builder (one build, in a worker, before the game) were all read and ruled out, as
had the garbage collector been (docs/zero-copy-bridge.md §1: 58 short collections per 10 s brought to 1 with no
change to the stall).

The fix (`src/01_Initialize_World/envProbe.ts`): every bake after the first renders into the **first bake's render
target** (`fromScene(..., { renderTarget })`), so `scene.environment` is one texture object for the whole session,
no material is re-keyed and nothing is allocated or disposed. A refresh now costs the generator's own passes, a few
milliseconds of GPU time. Each bake writes one console line, `[envprobe] 3.1 ms`, so a saved console log shows the
probe's cadence beside the `[longtask]` lines.

## 2. The flashing: 24-bit forward depth over a 2.4 km view

The camera's near plane is 0.1 m and its far plane 2,400 m. With a conventional 24-bit depth buffer the depth
resolution at a distance d is about d² · 6e-7 m for this camera: 6 mm at 100 m, **4 cm at 260 m, 60 cm at 1,000 m**.
The Lakefront Metro map lays its sidewalks 3.5 cm and its streets 4.5 cm above the ground plane and the lake 2 cm
above it (`region/regionWorld.ts`, with a polygon offset of one or two units), so beyond about 250 m the streets and
the ground resolve to the same depth and the winner changes from frame to frame as the camera moves: the flashing.
The procedural city bakes its markings into one ground material and keeps the lake off the land, so it fights less,
but its buildings' footings and the furniture at a distance share the same buffer.

The fix: the renderer asks three for a **reversed depth buffer** (`reversedDepthBuffer: true` in `createRenderer`),
which three backs with `depth32float` and a near-at-1, far-at-0 projection. A float's precision follows the 1/d of
perspective, so the resolution is about d · 1.2e-7 m everywhere: 0.12 mm at 1,000 m. three itself flips the depth
functions, the shadow bias, the clear value, and the `depth` texture the post chain samples (the sun shafts already
read `renderer.reversedDepthBuffer`). Two things in the page depended on the convention and were changed with it:

- three's `SkyMesh` pins itself to clip z = w, which is the far plane under a conventional buffer but the **near**
  plane under a reversed one, where it would pass the (flipped) depth test over the whole city. `skyAtFarPlane` in
  `world.ts` wraps its vertex node to write z = 0 instead (the far plane, the value the buffer is cleared to). The
  sky still writes no depth and still draws after the city, so it shows exactly where nothing else was drawn.
- The crowd cull's frustum (`engine.ts`) is now cut with `camera.coordinateSystem` and `camera.reversedDepth`; it was
  cut with WebGL's plane formulas, which under WebGPU's [0, 1] clip depth put the near plane ahead of the eye and
  under a reversed buffer would have swapped near and far.

## 3. What was verified, and what only a GPU can show

Verified in the cloud (no GPU): `tsc`, `oxlint`, the licence headers, the test suite with two new files
(`envProbe.test.ts`: the schedule and the target reuse; `depthWiring.test.ts`: the renderer flag, the sky wrapper,
the frustum calls and the probe wiring), and the Vite build.

Only a machine with a GPU can show that the freeze is gone and the flashing with it. The check, in the Windows app or
a browser with WebGPU, at the default map and `?day=24`:

1. Open the console (F12 in a browser; the Windows app has no devtools, so use the browser for this).
2. Watch for two minutes. Expected: a `[envprobe] n ms` line every 12 s with n in the single digits, and **no**
   `[longtask]` line beside it. Before this change a long task of hundreds to thousands of milliseconds landed on the
   same cadence.
3. Look down a long street toward the horizon and pan slowly. Expected: the far road surface and sidewalks hold
   still; before, they shimmered against the ground.

If a `[longtask]` line still arrives on a 12 s cadence, the probe was not the whole story and a DevTools Performance
recording of 30 s (Performance tab, record, look at what runs in the long task) is the next step.
