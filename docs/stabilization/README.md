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
