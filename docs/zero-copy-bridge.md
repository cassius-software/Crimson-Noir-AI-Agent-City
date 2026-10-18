# The zero-copy bridge, the flow field, and the cloud fallback throttle

This note records what was built for the "zero-copy memory bridge" and "cognition and pathfinding" modules of the
stable release overhaul, what was measured, and what can only be checked on a machine with a GPU.

## 1. The zero-copy memory bridge

`src/07_Execute_Actions/sharedBridge.ts` is one buffer the physics realm (the worker) and the page view at once: a
16-word Int32 header, then one slot of four words per vehicle, avatar and pedestrian, viewed as a `Float32Array`
(x, y, z) and an `Int32Array` (the state word: the car's drive mode, the avatar's enabled and shielded bits, the
pedestrian's activity). The header carries a strict spinlock word, the publish count, the realm's step id and clock,
and the car each local player drives.

- **Lock.** `Atomics.compareExchange(lock, 0, 1)` takes it, `Atomics.store(lock, 0)` + `Atomics.notify` free it. The
  writer (the worker) spins up to 256 times, then waits on the word for at most 2 ms (a worker may block), then skips
  the step if a reader still holds it. A reader on the page's thread spins at most 64 times and never blocks: if a
  write is in progress it keeps its last reading. `sharedBridge.test.ts` runs a real worker thread hammering the lock
  while the main thread reads: never a torn slot, never a blocked read, the publish count only grows.
- **Shared when the page is cross-origin isolated.** `vite.config.ts` now sends `Cross-Origin-Opener-Policy:
  same-origin` and `Cross-Origin-Embedder-Policy: require-corp` from the dev and preview servers, so `crossOriginIsolated`
  is true there and the bridge is a `SharedArrayBuffer` the client sends to the worker once (`{ t: 'bridge' }`, after
  `ready`). The host accepts only a SharedArrayBuffer of exactly the layout its world needs, once. `dist/index.html`
  opened from disk is not isolated: there the bridge is a plain `ArrayBuffer` of the same layout which the client fills
  itself from each state, so every reader is written once. A deployment serving the page from its own server sends
  the same two headers to get the shared path.
- **What reads it.** `SimControls.crowd.positions` (the console's and scripts' view of where every pedestrian stands)
  reads straight off the bridge under the lock; the engine's per-step copy loop of the crowd frame into a page array
  for it is gone. The crowd frame itself still crosses by transfer (it is uploaded to the GPU, not read), as do the
  pose, craft and rig buffers; the step's events, stats and recruit views still cross as a small structured clone.

### What was measured

`node --expose-gc tools/bridge/measure.mjs [agents] [seconds] [hz]` runs a worker thread publishing every position at a
steady step rate two ways, and reports the main thread's collections and heap growth after a one-second warm-up:
`message` posts the state per step the way `StepState` crosses (typed arrays transferred, the rest cloned) and copies
the positions out; `bridge` writes them into the shared buffer under the lock and the main thread reads them there.

On the cloud container that built this (Node 22, no browser, the numbers are the collector's, not Chromium's):

| agents | mode    | steps | GCs | GC ms | longest GC | heap growth |
|-------:|---------|------:|----:|------:|-----------:|------------:|
|  4,096 | message |   540 |   4 |  13.3 |    11.5 ms |     0.44 MB |
|  4,096 | bridge  |   540 |   2 |   9.9 |     9.1 ms |     0.26 MB |
| 14,000 | message |   540 |  58 |  60.9 |    11.3 ms |     0.60 MB |
| 14,000 | bridge  |   540 |   1 |   8.0 |     8.0 ms |     1.14 MB |

At the shipped crowd size (14,000 pedestrians) the message path triggers a young-generation collection about every
170 ms on the main thread; the bridge path triggers one in ten seconds. Each of those collections is short (under 12 ms
here). **This does not confirm a fifteen-second cycle.** Nothing in the per-step serialisation allocates on a
fifteen-second period: it allocates a little every step, and the collector reclaims it often and quickly. A stutter
every fifteen seconds that is tens of milliseconds long is the signature of a major (old-generation) collection or of
something else periodic: a telemetry snapshot, the prompt-prefix page table, the shadow map re-render, a WebGPU
readback stall. The bridge removes the per-step position copies and lets the page read positions without waiting for
a message, which is worth having on its own; whether it removes the stutter Julian sees needs a Chromium performance
trace of a live page (DevTools, Performance tab, record 30 s, look for the "Major GC" bars and what runs just before
them). That trace cannot be taken from the cloud container, which has no GPU and cannot run the physics worker.

*Later (October 2026):* the periodic work was found by reading the frame path: the sky probe's PMREM refresh every
0.2 game hours (12 s at `?day=24`) allocated a new render target and re-keyed every material in the scene. See
docs/stutter-and-depth.md for the finding and the fix.

## 2. The vector flow field

`src/06_Make_Decisions/flowField.ts` is the CPU reference: a grid of 2 m cells over the city (buildings blocked after
a 0.5 m pad, by cell centre; street cells weighted ×3 so a route crosses a road rather than walking down it), the
integration field by Jacobi relaxation (what the GPU does, one pass per dispatch) and by a bucket queue (Dial's
algorithm, the same fixed point, one call), and the direction field (the unit vector to the cheapest of the eight
neighbours, diagonals never cutting a blocked corner). `flowField.test.ts` holds the two solvers equal on random
mazes and shows a route from behind a building going round it along the sidewalk.

`src/06_Make_Decisions/flowField.wgsl` + `flowFieldGpu.ts` solve the same field on the physics worker's GPU device:
`relax` passes in batches of 32, ping-ponging two cost buffers, one word read back per batch (how many cells changed),
stopping at the first batch that changed nothing, then `direction` written into an `rg32float` texture the crowd
samples. The test drives the wiring on a mock device whose dispatches run the reference's own passes, so the batching,
the ping-pong, the early stop and the texture write are checked; the shader's constants, neighbour tables and rules
are read out of the WGSL and held to the reference's.

How it reaches the pedestrians: `crowd.wgsl` gained one sampled texture binding (14, `flowField`) and a lookup used in
one place, the "coming over" branch of a summons: a person asked over walks the field's direction under their feet
instead of the straight line, until the last stretch, where the straight line resumes so they arrive and stop as
before. The crowd's own block-edge walking, the kerb rule and the First-Law sensing are untouched. `SimCore` asks the
crowd to route towards the operator each crowd step while anyone is asked over; `CrowdSim.routeTo` solves once per
change of the operator's cell, on the GPU when `flowField.wgsl` validates on the device, else on the CPU with one
`writeTexture`. The `simulate` pass was at WebGPU's default eight storage buffers, which is why the field is a texture.

**Not verifiable from the cloud (no GPU):** that `flowField.wgsl` and the changed `crowd.wgsl` compile on a real
device, and the visible result. Manual check: open the page with `?debug`, summon someone (`recruit <skill>` at the
console), walk round a block corner so the straight line to you crosses the lot, and watch them follow the sidewalk
round the corner instead of pressing against the wall. The console's `ask` line is unrelated; a WGSL compile failure
shows as the physics realm refusing to start ("crowd.wgsl pipeline validation failed") or, for the flow shader alone,
as a `[crowd] the flow field is solved on the CPU` warning in the worker's console, after which the field still works.

## 3. Ragdolls out of the vehicle layer

`collision.ts` gained `RAGDOLL_GROUPS`: a rig segment is a member of the ragdoll bit and filters out the ragdoll,
vehicle and query bits, so Rapier's broad phase never pairs a fallen person with a chassis or a wheel ray. A car that
reaches a ragdoll exchanges no impulse and cannot ride up on it: no pile-up behind a fallen pedestrian. The Sanctuary
still flips every segment to a sensor before a car can reach it and the Ring-0 audit still halts the realm if one does:
this removes the contact, not the law. `collision.test.ts` checks every pairing.

## 4. The cloud fallback throttle

`src/09_Cognition/cloudFallback.ts` wraps the mind App hands the engine. `FrameRate` is a ring of frame times; the rate
is the count over the last two seconds, unknown until thirty frames are in the window. When the rate is below 30 fps,
the chosen provider is a model server on this machine (`ollama`, `llamacpp`, `openai`) and the prompt is complex (more than one
person bound, over 240 characters, or memories in it), `answer` goes to the router's `cloud` provider (the Claude API
through the loopback gateway, `router.ts`) instead; everything else, and every prompt when the chosen provider is
already `claude` or the mind has no cloud provider, goes where it always went. The console's `ask` shows a `fallback`
line with the rate and how many prompts were sent. The gateway is one the operator may never have started: when it fails
before any of its answer arrived, the chosen local model answers that prompt after all, and prompts stay local for a
minute (`FALLBACK.retryMs`) before the gateway is tried again; the `fallback` line counts those misses. Under the `auto`
provider the throttle follows the server auto found. No new network call exists: the cloud provider is the router's own,
behind the loopback gate. `cloudFallback.test.ts` drives the real router with a fake fetch and sees the offloaded prompt
reach `http://localhost:8089/v1/messages` and nothing else.
