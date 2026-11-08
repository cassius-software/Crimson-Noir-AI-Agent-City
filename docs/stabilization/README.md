<!--
Copyright (c) 2026 Julian Cassius Subban
SPDX-License-Identifier: MIT
Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
-->
# The stabilization loop and its log

Why does this file exist? It says what `tools/stabilize/stabilize.py` runs, how to read `progress.json`, and what the
data-oriented pass of October 2026 converted and what it left, so the log's numbers are read against the right
claims. What breaks if it is removed? The log is a file of numbers with no statement of what they measure.

## Running the loop

```sh
python3 tools/stabilize/stabilize.py --rounds 3 --first-round 10 --require-gpu --chaos-seeds 3000 --fuzz-scale 3
```

Each round runs every suite once; the chaos fuzzer draws a fresh block of seeds each round and the page's property
suites a fresh `FUZZ_SEED`, so rounds sample new cases rather than replaying the same ones. `--only chaos,page-fuzz`
runs a subset; `--first-round` sets the round number the seeds follow, so a later run draws seeds no earlier run drew. The loop exits 1 if any run failed, and keeps the failing run's output tail in the log for the next
iteration to work from. `--require-gpu` makes the GPU twin's absence a failure (CI sets it; a machine with Mesa's
lavapipe passes).

## Reading `progress.json`

- `runs`: one entry per suite per round: the command, its working directory and environment, the seed it drew,
  whether it passed, its exit code and its seconds (and the output tail when it failed).
- `suites`: per suite, its SIPOC line (what supplies the suite, what it takes in, what it does, what it produces, who
  consumes the result), the run and pass counts, the observed pass rate, the posterior mean of the pass probability
  under a uniform prior (the mean of Beta(passes + 1, failures + 1)) and the Wilson score interval's lower bound at
  95%. A suite that has passed 3 of 3 has a posterior mean of 0.8 and a Wilson lower bound of 0.44: three green runs
  are evidence, not proof, and the bound says how much. The interval tightens as rounds accumulate; the log is meant to
  be appended to, commit after commit.

## What the data-oriented pass converted, and what it left

Converted in this pass:

- **The swarm's tick runs in SIMD lanes** (`crimson_noir_os/crates/noir_core/src/lanes.rs`, `kernels::tick_lanes`):
  four agents a register, SSE2 on x86_64, plain lane loops on the UEFI target (built with SSE off). The scalar kernel
  stays as the reference the Kani harnesses prove, and the lanes are held to it bit for bit by the determinism suite's
  pinned fingerprint and by a fuzz test over adversarial matrices. Measured on the shipped configuration (4,096 agents,
  `bench_the_tick`, a 4-core cloud container, 2026-10-08): 3,799 ticks/s scalar, 4,537 ticks/s in lanes, 1.19x; the tick
  is bound by its gathers from the routing fields, which SSE2 has no instruction for, so the gain is the arithmetic's.
- **The KV pager's page table is a structure of arrays** (`native/kv-pager/src/02_page_table.rs`): one array per
  field of a block and one flat token array instead of a vector of block objects; the agents' block tables are one flat
  table in the layout the GPU kernel reads, so `gpu_tables` copies rows. The chaos fuzzer (thousands of seeds, millions
  of operations, every invariant after every operation) and the GPU stress run are the oracle.
- **The drivers' hazard state machine is a table** (`src/06_Make_Decisions/hazards.ts`): one row per driver, the
  transition between its states written as 1/0 masks folded into arithmetic, with the old branching state machine kept
  in the tests as the reference it must agree with step for step. `HazardEpisode` is a handle on a row.

Already data-oriented before this pass, and verified rather than rewritten:

- The Global Matrix (`matrix.rs`) has been a structure of arrays since the core was written: an agent is an index,
  and every array is one of the declared allocations.
- `kernels.rs` and the four WGSL shaders (`swarm.wgsl`, `route.wgsl`, `sort.wgsl`, `telemetry.wgsl`) were already
  branchless, one GPU invocation per agent, cell, comparator or frame, and the hosted runtime's tests compare the GPU's
  bits with the CPU's.

Left as it was, and why:

- The page's pedestrians already live on the GPU as flat buffers (`crowd.wgsl`, `crowdSim.ts`); the shader's per-agent
  branches (crossings, summons, flocking) were not rewritten branchless here, because no test runs that shader against
  a reference and a behaviour change in it would be unprovable on this machine.
- The page's other classes (the Fleet, the physics, the terminal, the hardware layer, the network host) are objects
  around the DOM, WebGPU, Rapier and sockets: their state is small, their calls are the browser's, and converting them
  would change layout without a hot path to gain or an oracle to hold them to.
- The terminal (`term.rs`) is an interpreter; its dispatch is a `match` by design and it is not on the tick.

## The hot-loop audit of November 2026: what it measured, what it changed, what it left

A second pass (2026-11-07) read every hot kernel again, one independent reader per area (the flow field, the crowd
shader, the crowd's CPU side, the physics realm's tick, the page's frame, the routing core and the KV pager, the OS
kernel, the WGSL host compiler), measured on a four-core container with Node 22 and cargo 1.97 and no GPU. A change was
made only where a benchmark showed the gain and a test could hold the old behaviour to the bit.

Changed:

- **The flow field's CPU solvers** (`src/06_Make_Decisions/flowField.ts`, PR #71): a padded grid, flat neighbour
  tables, a byte of open steps per cell and an intrusive bucket ring. Lakefront Metro's 1.6 M-cell solve went from
  495 ms to 150 ms, the city's from 18.7 ms to 5.3 ms. The old tuple form stays in the test as the reference.
- **The street furniture as compound sensors** (`src/07_Execute_Actions/physics.ts`, PR #89): rapier.js walks every
  collider through a WebAssembly-to-JavaScript callback after every step, so 4,599 poles nothing touched cost the realm
  0.6 ms and 1.4 MB a step. As 100 compound sensors, the realm's step with 48 cars went from 2.27 ms to 1.49 ms, and the
  cars' poses hash the same. The one-sensor-per-pole world stays in the test as the reference.

Measured, and left as it is:

- **A branchless pick is slower in V8.** The flow field's direction pass was tried with a mask select in place of
  `if (n < best)`: 3.9 ms became 6.6 ms on the city. The branch stayed. A branch the predictor gets right costs less
  than the arithmetic that replaces it.
- **The crowd's CPU side** packs and reads back buffers that are already flat. The whole worker-side crowd step is
  about 90 µs at 14,000 people (0.5% of a frame), most of it one de-interleave loop at 5 ns a person.
- **The crowd shader's branches** (`crowd.wgsl`): about twenty short diamonds could be `select()` with the same bits,
  and the car loop diverges because neighbouring lanes hold people from anywhere in the city. A sort of the dispatch
  by cell could help that, but it needs another buffer than the eight `simulate` binds, and nothing here can time a
  GPU. Without a device to measure on, the shader was not touched.
- **The page's frame** is GPU-bound by design. What runs per entity on the CPU totals 0.4 to 0.6 ms of a 16.7 ms frame:
  the contact pulse's scan of the pedestrians, a 36-car overlap test, the craft and the rigs. The audit's largest
  page-side item, the nearest-lamp search, was rewritten by the clustered lighting change (PR #78) with a 3 m gate.
- **The routing core's wrapper.** For a drone's pose the WebAssembly core costs more than the TypeScript it replaces
  (about 0.10 against 0.06 ms a frame for 966 craft), because the call's shape and its returned object cost more than
  the arithmetic. A one-entry memo of the track's arena offset was tried and measured no faster. Writing poses straight
  into the craft buffer would save about 0.04 ms a frame, across three modules. Left.
- **`wrap()` calls a software `fmod` in WebAssembly.** A three-compare fold gives the same bits (for every positive,
  finite track length), but saves only about 0.3 µs a car a frame. That is not worth regenerating the module.
- **The OS kernel's wipe** (`noir_core/src/kernels.rs`): every tick ANDs every agent's 72-word block with its keep
  mask, though almost no agent is wiped. Skipping it when no lane in a group is wiped makes the tick 1.2x faster, bit
  for bit. It would need a data-dependent loop or an `if`, which the kernel's contract forbids (a test reads the file
  and refuses one), and the tick already runs about eighty times faster than the 60 Hz it is asked for. Left, by
  choice.
- **The OS kernel's station loop** does its lane-to-array round trips through memory. Register-resident weights and a
  multiply-high remainder could be worth 1.15x to 1.3x more, still branchless. That is unmeasured end to end and is
  headroom only, so it was left.
- **No `simd128` for the routing and KV pager crates.** They have no loop wide enough. The UEFI target has SSE off by
  rustc's target specification. Rapier is already its SIMD build.
- **The bonnet rays.** Each car casts three 22 m rays a frame, about 0.2 ms a step at 48 cars. They are the Third
  Law's obstacle sense, so cutting them is a behaviour question for the vehicles, not a layout one.
- **The paged-attention shader** could use subgroups and vec4 loads. That needs a device to validate, and not every
  adapter has subgroups.
- **The WGSL host compiler's output** (`src/03_Spawn_Agents/wgslHost.ts`) builds a fresh JavaScript array for every
  vector operation and an object for every struct it reads: about 10 KB per person per `simulate` pass, 50 KB with 48
  cars, and a tenth of the time in garbage collection. Scalarising vectors and structs into locals (the same
  `Math.fround` tree, so the same bits) ran hand-converted pieces 4 to 11 times faster, and one dispatch loop per entry
  point halves `clearGrid`. But the CPU twin is a test oracle: nothing in the page or the worker imports it. The gain
  is CI time (the 27.5 s crowd soak to an estimated 13 to 15 s), not a player's frame, so it was left for a pass of its
  own with a differential test against today's emitter.
- **Beyond the areas above**, a last reader looked for hot loops no area had read. The bootable image's cinematic pass
  (`noir_core/src/render.rs`) does a 64-bit divide per pixel for a vignette that depends only on the pixel and the
  resolution: 1.3 ms of a 16.7 ms frame in a host build, and a table would give the same bits. The replication room's
  tick (`src/10_Network/replication.node.ts`) seals every other peer's pose once per peer: 2.9 ms a tick at 32 peers.
  Both are candidates for a next slice. The clustered lights' per-render binning and the code-dissolve and ghost-view
  fragment costs belong to the lighting work and need a GPU to time.
