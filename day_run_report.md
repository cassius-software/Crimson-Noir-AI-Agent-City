# Day run report — 2026-09-29 (Phase 4: pre-compute and architecture hardening)

All work ran on the CPU and the AMD iGPU. The NVIDIA driver was not touched, as directed.

## ⚠ Read first: two things found that I did not create or change

1. **`skRouter.cjs` (repo root, created 02:00 today, before this session).** It is an HTTP server on port 8080 that
   runs any shell command sent to it (`execSync(req.body.command)`), with no authentication. It listens on all
   interfaces, not only this machine. Anything that can reach port 8080 can run commands as you. I didn't run,
   modify or delete it.
   - If you didn't put it there on purpose, stop any running copy and remove it.
   - It also contradicts the air-gap law: the product only speaks to loopback servers.
2. **`express` was added to `package.json` `dependencies` at 01:57 today**, apparently for `skRouter.cjs`. The
   build's licence gate refuses every runtime dependency without an embedded notice, so **`npm run build` fails
   today, independently of this run's changes**.
   - I didn't remove it, because that's your change to make. The fix: delete the file and the dependency, or move
     `express` to `devDependencies` if the router is a dev tool.
   - My failed build attempt emptied `dist/`. I restored the previous `dist/index.html` (built 09-28 21:17)
     byte for byte, so the shipped page is unchanged.

## 1. Chaos fuzzing: `native/kv-pager`

`proptest` isn't in the offline cargo cache. Adding it would have made the crate need the network, so I wrote a
self-contained property fuzzer instead: `src/bin/chaos/core.rs` + `main.rs`, with a bounded slice in
`tests/chaos.rs`. It has seeded streams, a shadow model of every agent's tokens, and delta-debugging shrinking.

**What it checks after every operation:**
- every table invariant (`check()`);
- every live agent reads back exactly its own tokens;
- every block is in exactly one place (free, idle-cached or mapped): no orphans;
- a refusal changes nothing, and an append is only refused when the pool is truly empty;
- a fork allocates nothing;
- copy-on-write copies exactly the slots before the write;
- the GPU table layout matches every agent.

After each stream, every agent leaves and one agent must then be able to take **every** page of the pool.

**Main run:**

| | |
|---|---|
| Streams | 20,000 seeds × 2,000 ops on 16 workers, 26.4 s |
| Pools | 4, 8, 16, 32, 64, 128 pages |
| Keyings | real chain key; forced constant collisions; no prefix cache |
| Operations | 40,000,000: 8.3 M spawns, 3.4 M forks, 134.7 M token appends, 11.8 M despawns (1.2 M in mass-despawn waves) |
| Refusals | 6.1 M (the pools run full by design) |
| Copy-on-write copies | 1,117,244 |
| Prefix-cache hit tokens | 79.5 M |
| Full-pool reclaims | 20,000 of 20,000 succeeded |
| **Fuzzer panics / failing seeds** | **0** |
| **Orphaned blocks** | **0** |
| **False refusals** | **0** |
| Shared table, 8 threads × 25,000 ops, one 48-page table behind a mutex | every invariant after every op; every page back at the end (39,701 refusals, 0.5 s) |

**Fragmentation:**
- **External fragmentation:** none by construction. Pages are fixed-size and any free page serves any request; the
  full-pool reclaim proves it after every stream.
- **Internal fragmentation** (empty slots in the partly filled last page of each sequence): mean **10.5 %** of mapped
  slots, max 93.8 %. The max is a 4-page pool holding a single 1-token tail.
- **Idle cached pages** (full pages kept for prefix reuse, evictable on demand): mean 28.8 % of the pool.
- **Peak occupancy** (mapped + cached): 100 %.

**The oracle itself:**
- **One oracle bug, found and fixed.** My first oracle expected an admission refusal to report `available ==
  free + idle`. The table correctly reports less: the idle pages the prompt's own prefix hits would revive can't
  also be evicted for new tokens. That was an oracle bug, not a page-table bug.
- **Mutation check.** I planted four real bugs, one at a time, then restored the file (it compares identical to the
  original afterwards).

| Planted bug | Caught | Shrunk repro |
|---|---|---|
| Released page never returned to the free list | 400/400 seeds: "block 3: 0 refs, yet not free" | 1 op |
| Copy-on-write disabled | 400/400: "agent 79 reads back other tokens" | 4 ops (spawn, fork, 2 appends) |
| Admission overcounts revivable pages (overcommit) | 133/400: "counted before anything changed" | 3 ops (spawn, despawn, spawn) |
| Newest-first eviction | 0/400: not a correctness property | caught by unit test `…evicted_oldest_first` |

**Races:** safe Rust rules out data races in the page table (every mutation takes `&mut self`). A host that shares
it must lock it, and the 8-thread run exercises exactly that, with arbitrary interleaving at operation granularity.

## 2. Causal refactor

**`native/kv-pager`.** The crate is now organised by cause, like the web tree. The public API is unchanged
(`kv_pager::PageTable`, `kv_pager::gpu::*`).
- `src/01_geometry.rs`: what a token is and costs.
- `src/02_page_table.rs`: which page holds each token. It also gains `PoolStats` / `stats()` for the fuzzer.
- `src/03_gpu/kernel.rs` + `paged_attention.wgsl`: the reader, always compiled so a test pins its page size.
- `src/03_gpu/pool.rs` (feature `gpu`): the device pool, the copy-on-write copies, the pipeline.
- `src/bin/stress.rs`, `src/bin/chaos/`: the proofs.
- Every file opens with "Why does this file exist? / What breaks if it is removed?".
- `lib.rs` is now the crate's door with the causal map. `shaders/` moved to `src/03_gpu/`.
- The `adapters` example now requires the `gpu` feature, so a plain `cargo test` needs no wgpu. Two clippy lints
  are fixed; clippy is clean.

**Checked after the refactor:**
- `cargo test` passes: 12 unit tests + 3 chaos tests.
- The DX12 stress run on the AMD iGPU gives a final telemetry row identical to the pre-refactor run: 725/910 pages,
  90 copy-on-write copies, flat 2050 MiB driver allocation, kernel error 4.1e-7.

**Copy-on-write causal chain.** `native/kv-pager/CAUSAL.md` documents it in 12 steps, with file:line references.
The chain runs from fork (shares, allocates nothing), through the write that finds a shared tail, to the take-or-
refuse-whole step that is the no-out-of-memory guarantee. Then the table is repointed and the bytes are copied
through staging on the GPU (WebGPU forbids copying a buffer into itself). A queue-ordering argument explains why the
copy can't overwrite the new token. The poll that returns staging memory is part of it: without it, the driver
allocation grew 2050 → 3850 MiB. The kernel then reads the diverged tables. It ends with the proof both ways:
4e-7 error with the copies, 0.10 without.

**`engine.ts` audit.** It already follows the rules: it's the stage-07 orchestrator, with the header in place, and
its WebGPU work already lives in its stage files (renderer in 01 `world.ts`, crowd compute in 03, post chain in 07
`postfx.ts`). I found two departures and fixed both:
1. **Imports weren't in causal order.** Three stage-05 imports and `brand.ts` sat after the stage-07 modules; they
   are reordered (`brand`, then 01 → 07).
2. **`present()` packed the six frustum planes inline.** That is culling input, defined by stage 03's cull contract.
   It's now `packFrustumPlanes()` in `03_Spawn_Agents/crowdCompute.ts`: pure, structurally typed, with a new test.
   `engine.ts` calls it.

**Not verified in the real app:** the rebuilt page couldn't be probed in Brave, because the build is blocked (see
the top). Before the change, the smoke probe on the old build drew 4,581 pedestrians at 89 fps with no page errors.
**Next step once the build works:** rerun that probe and compare `drawn`.

## 3. Ragdoll and HAL scaffolding (neither is wired into the running engine)

**Active ragdoll:** `src/03_Spawn_Agents/ragdoll.ts`, `ragdollRig.ts`, plus 17 tests (6 against real Rapier).
- **States:** kinematic → perturbed → (catchStep) → sittingDown → seated → recovering → kinematic.
  - The thresholds are named constants measured on the rig.
  - The transition table is fuzzed: no transition outside it ever occurs.
- **Allowed push causes:** a shove in a dense crowd, a kerb or seawall-edge trip, or a slip.
  - A vehicle is refused as a cause, by name, as is anything unknown.
  - Reason: Ring-0 halts the whole sim on any car–person contact, so a vehicle can never be a legitimate cause.
- **Promotion pool:** at most 8 rigs, within 25 m of the operator. It never evicts someone mid-step or sitting down.
  It hands back position and velocity when a person is promoted, and releases the rig on demotion.
- **Rig:** 11 capsule segments and 2 flat feet (76 kg), 10 joints with limits.
  - Building and removing it leaves the Rapier world exactly at baseline after 25 cycles.
  - A powered rig stands for 4 s; a limp one sits down (the positive control).
- **Design finding:** Rapier 0.21's joint motors are too weak to use here. A 1 kg arm sagged 0.43 m at stiffness
  10⁴, and `JointData.spherical` returns a joint with no motor methods at run time. So the joints are
  velocity servos driven by the rig, plus a balance assist.
- **Four planted bugs**, each caught by 1–5 tests.
- **Open:**
  - catchStep doesn't yet physically place a foot;
  - two people's rigs don't touch each other yet;
  - nothing is tested inside the worker or renderer: the handback to the GPU crowd, and the cost of 8 rigs per tick.

**HAL peripheral spec:** `docs/hal-peripherals-spec.md` (draft 0.1) + `src/04_Connect_Hardware/peripheralPolicy.ts`,
plus 13 tests.
- **Device classes:** sensor, actuator, drone.
- **Handshake:** an additive, versioned HAL/1 extension: `CAPS 1 {json}`, `ARM`/`ARMED` with a nonce, `BEAT`, `CMD`,
  `DISARM`, `FAILSAFE LAND`. Legacy gadgets are never armed.
- **Default-deny gate:** 16 refusal reasons, in order:
  1. `locked`
  2. `refused-at-handshake`
  3. `not-declared`
  4. `no-operator-tier`
  5. `no-lease`
  6. `not-armed`
  7. `heartbeat-lost`
  8. `stale-sequence`
  9. `expired`
  10. `rate-limited`
  11. `non-finite`
  12. `no-geofence`
  13. `outside-geofence`
  14. `above-ceiling`
  15. `over-speed`
  16. `beyond-range`
- **Refused for the whole session:** payload release, projectile and aiming capabilities are refused at the
  handshake and re-checked on every command.
- **Disarm events:** a Ring-0 panic (disarms and latches), a broken tether, or a lost heartbeat.
- **Drone failsafe:** hold, then land in place, never a return flight.
- **Stated limit:** the spec is a software gate, not a safety case, and local aviation rules apply.

## 4. Structural changes (every file touched)

| File | Change |
|---|---|
| `native/kv-pager/src/lib.rs` | Now the crate door + causal map |
| `native/kv-pager/src/01_geometry.rs`, `02_page_table.rs`, `03_gpu/kernel.rs`, `03_gpu/pool.rs` | New (split from `lib.rs` / `gpu.rs`); `PoolStats`; lint fixes |
| `native/kv-pager/src/03_gpu/paged_attention.wgsl` | Moved from `shaders/` (unchanged) |
| `native/kv-pager/src/bin/chaos/{core,main}.rs`, `tests/chaos.rs` | New: the fuzzer |
| `native/kv-pager/src/tests.rs` | `HashMap` import after the split |
| `native/kv-pager/Cargo.toml` | `adapters` example gated on `gpu` |
| `native/kv-pager/CAUSAL.md` | New: stage map + copy-on-write chain |
| `src/07_Execute_Actions/engine.ts` | Imports in causal order; plane packing moved out |
| `src/03_Spawn_Agents/crowdCompute.ts` (+ test) | `packFrustumPlanes` + test |
| `src/03_Spawn_Agents/ragdoll.ts`, `ragdollRig.ts` (+ tests) | New (scaffold) |
| `src/04_Connect_Hardware/peripheralPolicy.ts` (+ test), `docs/hal-peripherals-spec.md` | New (draft) |
| `README.md` | Layout table: 03 and 04 rows, a `native/kv-pager` row |
| `dist/index.html` | Restored to the 09-28 build after the blocked build emptied it |

## Final state

- **Web:**
  - `npx tsc -b`: exit 0.
  - `npm run lint`: clean.
  - `npm test`: **715/715** (684 at the start of the day).
  - `npm run build`: **blocked by the `express` dependency** (see the top).
- **Native:**
  - `cargo test --features gpu`: 15/15.
  - `cargo clippy --all-targets --features gpu`: clean.
  - chaos: 0 failures in 40 M ops.
  - stress: unchanged.

To reproduce, from `native/kv-pager`:

```
cargo run --release --bin chaos                 # 20,000 seeds x 2,000 ops + shared-table threads
WGPU_BACKEND=dx12 ./target/release/stress.exe   # GPU stress (AMD iGPU today)
```
