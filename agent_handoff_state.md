# Agent handoff state

Written under the operator's Phase 13 protocol ("if you approach limits, write your exact execution state … into
`agent_handoff_state.md`"). It is the bridge for the next agent: read it first, then continue from **Next steps**.

## Where things stand (updated as work lands)

- Phase 2 of the V2 stable release (the one-click Windows app, Wren's quiet first minutes and the swarm's short-term
  memory, long-task telemetry, the version and the changelog; PRs #20 to #23) is merged into main and released as
  `v1.0.0-stable-beta` on 2026-10-12 from 6a6b3ff (run 38195437087: proofs, two identical bakes, both QEMU boots, the
  eight OS files; `BOOTX64.EFI` is byte for byte v1.1.0's, SHA-256 74bbd347…, since no OS source changed). The product
  version is 1.0.0-stable-beta (from 1.4.0, as directed; it sorts below the earlier tags) and `CHANGELOG.md` records
  every release. The Windows app did not reach that release on its own: the release workflow made the tag with its
  own token, for which GitHub starts no tag-push run; windows-app.yml now takes the tag as an input and
  build-release.yml dispatches it. Phase 21 (the V2 overhaul: matrix mode, Lakefront Metro, the zero-copy bridge;
  PRs #17 to #19) is in that release too.
- Phase 19 (the commercial release overhaul: the data-oriented SIMD core, the zero-trust self-heal sandbox, dual
  licensing and brand assets; PRs #9 to #12, with #6, #7 and #8 before them) is merged into main and released as
  `v1.1.0-stable-release` on 2026-10-09 from 2ad02e1: see the Phase 19 section at the end. The published EFI's
  stamp is now the commit's alone (a build here gives the same bytes).
- Phase 18 (formal verification, self-healing CI/CD, IIoT telemetry) is merged into main (PRs #3 and #4) and
  released as `v1.0.1-stable-release` on 2026-10-08 (the bake runs the proofs first and refuses a commit whose proofs
  fail): see the Phase 18 section at the end, including why the published EFI's TimeDateStamp is not this
  container's, and the linker change that makes the next release's stamp the commit's alone. CI now runs on every
  pull request and push to main (ci.yml); PR #5 (merged) carried the self-heal workflow's first-run fixes.
  container's. CI now runs on every pull request and push to main (ci.yml); PR #5 carries the self-heal workflow's
  first-run fixes.
- Phase 17 (the plan written between Phases 16 and 18, then skipped; picked up on 2026-10-08): the two code items
  Phase 18 had not covered are on the branch `claude/project-thread-q8gvxn`; see the Phase 17 section at the end.
- Phase 14 (the approved hosted-runtime bridge) is complete: see the Phase 14 section at the end.
- Branch `claude/quirky-faraday-xkpdln`. Phase 13 is complete and release-ready: two adversarial reviews fixed (the
  second's 4 + 13 + 4 findings below), 1,219 tests passing, tagged `v1.0.0-stable-release` (see `git log`, `git tag`).
- The Crimson Noir OS (the operator's next directive, below) is under way in `crimson_noir_os/`:
  - DONE the core crate (`crates/noir_core`, 22 tests): config/lock/generator, Global Matrix, branchless kernels,
    sorting network, text, the declared system allocation.
  - DONE the UEFI image (`boot/`): own UEFI FFI, GOP 1280x720, the declared arena, ExitBootServices, own GDT/IDT (all
    32 exceptions to a fault screen), COM1 log, PS/2 keyboard, TSC clock, a sealed bump allocator (it caught an
    undeclared 992-byte Vec on the first boot). In QEMU+OVMF (`tools/build-image.sh`, `tools/boot_test.py`): memory
    march 16 MiB clean, 4,274,560 bytes declared = allocated, the scripted run's fingerprint 0x83765bab equal to the
    build machine's (soft-float on the image), display read-back clean, `SELFTEST PASS` in 6.5 s, keys echoed.
  - DONE (task 30) the tutorial and the terminal, all in the `no_std` core and allocation-free (a counting allocator
    in the tests proves it): `render.rs` (integer-only rasterizer: Q16.16, sine table, look-at camera, near clipping,
    1/z depth, fog, dots, letterbox/vignette/grain), `scene.rs` (the room from the matrix walls and stations, staged
    along the real aisles; the tutor in a blazer/shirt/crimson tie; cage at the trap cell, crash cart, sorting
    table), `tutorial.rs` (the 5-Whys film: memory march of the arena's untouched part + the seal probe, the scripted
    run against GOLDEN_PROOF, containment from that run with live row-zero reads, the screen read-back, the bitonic
    sort animated comparator by comparator with the 0-1 proof; ESC skips the film, never the checks; any failure is
    the fault screen), `term.rs` (the Sith Lord Terminal: a bounds-checked Forth over the arrays; caps/role read-only,
    `ask` requests judged by the kernels; knobs within the validator's ranges; `cfg`/`digest` read-only with a live
    SHA-256 re-check; step budget = loop breaker; Rule 110 runs in it). 41 core tests (+3 ignored preview tools).
    The image runs it all: QEMU boot -> SELFTEST PASS 6.8 s -> the film (about 14 fps under TCG) -> PASSED 76 s ->
    terminal (golden MATCH, digest holds, help example) -> `halt` powers the VM off (runtime services).
    Boot test with screenshots: see the command under Next steps.
  - DONE (task 31) the hosted runtime (`src/`, wgpu 30, bytemuck, log + env_logger, pollster): `shaders/*.wgsl`
    (swarm tick, routing relaxation, bitonic pass; branch-free, linted, naga-validated offline), `gpu.rs` (SoA
    buffers, batched dispatches at dynamic uniform offsets, the scripted run replayed on the GPU), `host.rs` (a
    thread-sealable counting allocator: tutorial/terminal frames run sealed on the desktop too; host platform; PNG).
    `cargo run -- selftest` on lavapipe: GPU scripted run = CPU matrix word for word (fingerprint 0x83765bab), routing
    fields equal (118 passes), 1,048,576 keys sorted equal. Tests: 6 (random-state parity with injected requests and
    single-tick comparisons; 4 of 5 shader mutants caught, the 5th is equivalent). `frames DIR`, `terminal` (stdin).
  - IN PROGRESS (task 32): `crimson_noir_os/README.md` written (uncommitted). The ISO boots too (ESC skip: every check
    still runs, PASSED at 24 s). Fixed: a key pressed in the verdict's first 2 s was dropped (now remembered; test).
    The read-only review found 6 verified defects, all fixed with regression tests: `1 walls fill-a respawn` hung
    (spawn's scan now bounded); `alive = -1` overflowed the kernel in debug and `doomed = 2` half-wiped a row,
    rewriting the read-only caps/role (kernels and WGSL read masks as bit 0; the terminal writes masks as 0/1 only);
    `route` was under-charged (now metered per pass); `begin : foo again ;` compiled into the line's code (flush
    checks open structures first, outside definitions); terminal.cells < 2048 and a 256-cell floor on a 200-px screen
    panicked (validator minimum; the map fits and clips). Fingerprint unchanged (0x83765bab); 46 core + 6 hosted tests.
    DONE (task 32): final boot tests with the final build. Disk image: the whole film, each shot captured into
    `crimson_noir_os/docs/screenshots/` (README gallery), then a terminal session replaying the review's inputs on the
    real image (all refused), golden MATCH, digest holds, halt powers off (96.7 s). ISO: ESC skip still runs every
    check (PASSED at 21 s), golden MATCH, halt (26.4 s). Readout panels now size to their lines.
  - The Crimson Noir OS is at stable beta. Remaining work is optional: a signed Secure Boot shim, USB keyboards
    without legacy emulation, renaming the terminal before any commercial release ("Sith" is a trademark).
- The local tag `stable-beta` exists only locally (GitHub refused the tag push, HTTP 403).
- Machine: 4 CPUs, 16 GB. Do not run several Rapier-heavy experiments and a multi-agent workflow at once (exit 137 once).

## The operator's current directive: Phase 13

1. Close the vehicle teleport exploit: the server must know where cars are and verify entering and leaving a car within
   0.5 m of its own computed vehicle coordinate.
2. Property-based fuzzing of the WebSocket host, the Ring-0 kernel and the WASM reconciliation bounds; chaotic network
   conditions; prove client/server parity <= 1 um under adversarial load.
3. Fix every defect found, keep 14A and the loopback air gap intact, run the full suite, commit, tag
   `v1.0.0-stable-release`.

## What was established (facts, measured)

- AI car positions are NOT computable on a server: each car is a Rapier body driven along its ring by a track follower
  that stops at signals and is held by the First Law for pedestrians read from each page's own GPU crowd. What the server
  computes natively: every ring's geometry, every car's ring, seat and SUV flag (carRig.ts planFleet, the fleet's own
  plan). A player's own car IS replayed on the server, to the bit.
- Bit-exact car replay needs: the full city's building boxes in the server's world (furniture is sensors, not needed),
  AND the car rebuilt from the same numbers on both sides (carRig.ts rebuildCarRig: new chassis, collider, controller).
  A fresh controller alone is not enough: a car resting against a building keeps contact warm-start impulses (3 mm drift).
- Every fresh Rapier world must be stepped once before its first query (Physics.build now does): the page's realm moved
  its avatar in an unstepped world on the first substep (ground snap missed, 3 cm) while the mirror's was stepped.
- In a room the realm's player 1 is a ghost (only fixed geometry stops it), so foot parity is exact (0) and the mirror's
  tolerance is now 1 um (MIRROR.tolerance). Claims must be the f32 numbers read back from Rapier.
- Lane envelope of AI cars (measured, 36 cars, 30 s): lateral < 1.0 m (GARAGE.lane), heading < 0.5 rad, never over the
  ring's limit.

## Progress on the plan

- DONE A. Room mode in the realm (simCore 'room', player.ts ghost, sanctuary ghost wards, tuning refused in a room).
- DONE B (server side). carRig.ts (shared car physics, planFleet, exitPoint, rebuildCarRig), vehicles.ts refactor,
  garage.node.ts (doors, replay, park/hold, settle), mirror.node.ts judge with doors (enter checked by the garage; exit
  within 0.5 m of the room's own exit point; the room puts the player at its own point), protocol 4 in replication.ts
  (drive runs [throttle, brake, steer, handbrake, n], door {enter:{car,state}}|{exit:{x,z}}, correct.car, world
  'city/<seed>/<cars>', door bucket 2/s burst 4, stale-fix grace 5 s before the rate check, 3 s stall budgets),
  plane.node.ts updated, host option `cars` / NET_CARS.
- DONE (host hardening, uncommitted until the WIP commit): MIN_SECRET 16, one connection per token (4010), token expiry
  enforced in session (4003), pings metered, backlog on every write, error handler first in onUpgrade, refused upgrades
  destroyed, loggable() log escaping, no reads after close.
- DONE C (page side). engine.ts reports doors (simProtocol.ts doorOf: the step's own entered/exited events; a forced
  exit or a room seat cancels), wheel runs from st.wheels, footWish-clamped velocity; sends {c:'room'} on the welcome
  and off on let-go; a correction with `car` becomes {c:'netCar'}; join refuses ?tracks=0, names `city/<seed>/<cars>`,
  lets the last session go first; only 'stale'/'refused' moves count as dropped. netClient.ts: Move with wheels/door,
  MoveStatus, a door in an input of its own, keepalive ack every KEEPALIVE_MS (5 s) via an injectable `every`.
  simCore: one door a step for player 1 in a room; 'exited' carries `forced` for teleport/netCar exits.
- Full suite at this point: 1,181 tests, all passing after netWiring.test.ts was updated; smoke:net passes (9 crafted
  packets incl. 4 car exploits). authority.node.test.ts is now the two-driver end-to-end proof (0 corrections over
  thousands of steps under the 1 um tolerance).
- DONE D (fuzzing and the proof). property.ts harness; protocol.fuzz, host.fuzz, ring0.fuzz, carRig.fuzz,
  routingWasm.fuzz, kvPager.fuzz, parity.fuzz (two drivers + a liar on a chaotic link: 0 honest corrections, exact at
  the end). Fixed what they found (see README History 1.4.0 and the commit "property-based fuzzing ...").
- DONE E (docs, mostly): README Networking rewritten, Layout row, History 1.4.0, blueprint Phase 13, zero-trust audit
  note; package version 1.4.0. Still to fill after the final run: README "what is verified" Phase 13 entry (test
  count, smoke timings).
- Review findings status: every finding below is fixed or superseded by Phase 13 except "seals keyed only by the
  token" (low: a replay across sequential connections of one subject needs injection into a loopback/tunnel stream;
  one live connection per subject now) and "mirror churn" (not reproduced). Both are named in the final report.
- Final checks at commit "handoff state after the fuzzing" + this one: 1,204 tests, 1,204 pass (88 s); tsc and
  oxlint clean; `npm run build` clean (dist/index.html 9.99 MB, no server code); smoke:net 9/9 refused in 0.9-9.1 ms.
- Adversarial review launched: workflow run wf_36a42bed-56f (5 reviewers + 1 skeptic per finding). If the session
  dies, resume with Workflow({scriptPath: <session>/workflows/scripts/phase13-adversarial-review-wf_36a42bed-56f.js,
  resumeFromRunId: "wf_36a42bed-56f"}), or rerun a fresh review the same way.
- DONE (the second review: three reviewers, protocol/host, page against the real host, documents against code; the
  first review's run died with a container restart). Every finding reproduced, fixed, with a test that fails without
  the fix (mutation-checked):
  - protocol: 14A screen bypass by invisible characters and look-alike letters (conduct.ts normalise; replication.ts
    `unprintable` refuses C1, separators, bidi controls, lone surrogates); loggable leaked C1/DEL/U+2028 and cut at 161;
    an honest client kicked after a 6.5 s stall or 8 short ones (netClient MAX_IN_FLIGHT 150; refusals an allowance,
    8 burst, 4/min back); pending() inverted after a correction (now emptied).
  - page: drift at a terrace's shared wall (page and room part by micrometres; honest players kicked on foot and at
    the wheel): MIRROR.drift (0.25 m foot, 1 m wheel) keeps the input as replayed and resyncs uncounted (`drift: true`
    on the correct message; host stats `resynced`); reconnect stranded a left car (every car the room does not hold
    goes back to its ring's lane: at room on, on a forced exit, the oldest past HELD_CARS; a refused held re-entry
    releases the room's hold); an E queued before a correction was reported as a door (SimClient `first` lane).
  - docs: door hops beat a run (doorsPerSecond 2 -> 1.75; a substep charge was tried and dropped: it corrected the
    parity proof's honest drivers); flaky smoke ack wait; vacuous tests (clock hack, full input, CSP one-way, log,
    backlog, room-refused commands, hop rate); Ring-0 at the wheel kept a refused replay (now undone); headers on
    App.tsx/main.tsx/index.css (test added); stale lines; README verified entry and History 13.4 written.
- Final checks for the tag: 1,219 tests, 1,219 pass (93 s); tsc and oxlint clean; build clean (9.99 MB, no server
  code); smoke:net 9/9 refused in 1.0-13.5 ms.

## Next directive (after the release): the Crimson Noir OS Technical Design Document

The operator attached `Technical_Design_Document.md` (Chrismon Noir OS 0.9.0), then a corrected copy,
`Technical_Design_Document_1.md` (**Crimson Noir OS** 0.9.0; this one rules): build a Rust DOD runtime (no OOP, 1-D
SoA arrays, branchless hot path, WGSL compute via wgpu), a Nix-style declarative containment generator ("NixOS and seL4
microkernel paradigms"), a self-testing visual tutorial (a "5-Whys ELI5" agent runs a minimal system initialization in
3D; sorting the array on screen verifies memory, compute and display; a failure is caught as a hardware fault), a
Turing-complete terminal over the raw arrays, the compute shader configuration and the declarative configuration, a
one-click bootable image; MIT OR Apache-2.0. The loop breaker in the corrected copy: an index that loops identical
failure states continuously has its memory block flushed and zeroed (the first copy said "> 100 times"; the threshold
is declared in the configuration). Execution directives: `cargo new crimson_noir_os --bin` (done at the repo root); wgpu
+ bytemuck + logging, `no_std` where applicable; the arrays; the sandbox generator; iterate until it boots into the
visual tutorial.
Plan (decided): `crimson_noir_os/` (a Cargo workspace): a `no_std` + alloc core (the Global Matrix, the branchless
kernels, the containment masks, the dropped-pointer defense, the loop breaker, the self-test sort, a software
rasterizer for the tutorial, a small Forth-like terminal), the hosted bin (std: wgpu compute with the same kernels in
WGSL, CPU parity, the terminal, PNG frames of the tutorial), a `boot/` UEFI image (x86_64-unknown-uefi, its own UEFI
FFI: GOP framebuffer, keyboard) booted in QEMU with OVMF and screenshotted, and the containment generator (a
`containment.nix`-style spec -> locked, hashed const tables via build.rs). Network allows crates.io, rustup and apt
(qemu-system-x86, ovmf, mesa-vulkan-drivers for lavapipe, mtools). Honest limits to state: wgpu cannot run bare-metal
(the UEFI image runs the CPU kernels; the hosted runtime runs WGSL); "provable ASI containment" is not achievable, only
the narrow invariants the tests prove; a Linux kernel stays GPL-2.0 (the image carries none: it is a standalone UEFI
program); no code earns regulatory approval; the rendering is stylized, not photorealistic; "Sith" is a third-party
trademark to clear before a commercial release.

## Review findings on Phase 12 (adversarial workflow; [k/n] = verifiers who confirmed)

- [2/2 verifiers say real] **critical** `src/10_Network/mirror.node.ts:258` — Switching foot and drive with 0-substep inputs moves the truth 16.5 m per pair, with no correction
  - scenario: A peer holding a valid token sends this pair over and over: {mode:'drive', segs:[[0,0,0]], claim 8.49 m ahead at y=1}, then {mode:'foot', segs:[[0,0,0]], from: 7.99 m further, claim = from at the standing y 0.95}. Every input is kept, and other players see the peer jump about 16.5 m each pair. At the input rate that is about 495 m/s sustained (95x RUN), and the 120-input burst moves it about 990 m
  - fix: Let the reach only be spent with a car to spend it on: allow at most one switch between foot and drive per some cooldown, measured in substeps actually run. Better, require n>0 and charge the 8 m reach against the substep budget. Also measure the `from` exit from the position the body held before it
- [2/2 verifiers say real] **critical** `src/10_Network/replication.node.ts:362` — A tokenless client crashes the host process by resetting the connection after a refused upgrade
  - scenario: Any client connects, sends `GET / ... Upgrade: websocket ... Sec-WebSocket-Version: 13` with no Sec-WebSocket-Protocol, reads the 401, then resets the TCP connection (socket.resetAndDestroy()). The host exits with code 1 (`Error: read ECONNRESET ... Unhandled 'error' event`), and every joined player is disconnected. An RST that arrives while the 401 is still being written crashes it too (`write EC
  - fix: At the top of onUpgrade, before any write, add `socket.on('error', () => socket.destroy())`. For every refusal, write the response and then destroy it, e.g. `socket.end(resp); setTimeout(() => socket.destroy(), 1000).unref()`, or `socket.destroySoon()`. Add a test that resets after a 401 and checks 
- [2/2 verifiers say real] **critical** `src/10_Network/replication.node.ts:357` — Unauthenticated one-request crash: a TCP reset after a 401/429/400/503 refusal kills the host process
  - scenario: An attacker (or any local process, or anyone when the host is exposed via NET_HOST as the README suggests for a cloud server) connects, sends `GET / HTTP/1.1 ... Sec-WebSocket-Protocol: onyx.3` with no or a bad token, reads the `401 Unauthorized`, and calls `socket.resetAndDestroy()`. The host process exits with code 1, every joined player is dropped, and the room is gone until someone restarts it
  - fix: At the very top of onUpgrade, before any write, attach `socket.on('error', () => socket.destroy())`. For every refusal, write the response and then destroy the socket (`socket.end(resp, () => socket.destroy())`, plus an unref'd destroy timer as a backstop). Add a test that resets the connection afte
- [2/2 verifiers say real] **high** `src/10_Network/mirror.node.ts:38` — driveSlack is granted per input regardless of substeps, so driving beats the 50 m/s cap
  - scenario: While driving, a peer sends drive inputs at the full input rate. Each carries 1 substep and a claim 0.5 m + 50/60 m ahead (or n=0 and 0.499 m ahead). Every input is kept, and the truth advances at up to about 80 m/s, 1.6x the Ring-0 velocity cap the docs promise, with no correction. With n=0 alone, it creeps 30 m/s without spending a single substep.
  - fix: Grant the slack once over a window, not per input. For example, bound the total distance across consecutive drive inputs by 50 m/s times the substeps spent plus one fixed slack, tracking the leftover between inputs. Or refuse a drive input with n=0 that moves at all.
- [2/2 verifiers say real] **high** `src/10_Network/mirror.node.ts:262` — Drive claims can rise to 12 m and drop straight down, landing on roofs and inside buildings
  - scenario: From the street at x=40 (z=20), the peer sends: drive n=0 to (40, 12, 20), drive n=30 to (60, 12, 20) over the lot, then drive n=0 to (60, 1, 20). All three are kept, and the truth now sits inside the lot's solid podium. Others see the player or car embedded in the building, or hovering on a rooftop if the claim is y = roof + 0.5.
  - fix: Bound the vertical move as well as the horizontal one. Cast the rays (or a shape cast of the chassis box) along the full 3D segment from before to claim. Require the claimed chassis to sit within a small band above the ground or a drivable surface under it (a downward ray to the ground, not to a roo
- [2/2 verifiers say real] **high** `src/10_Network/replication.node.ts:365` — One session token can occupy all 32 room slots (no per-token/subject limit), and per-peer budgets reset on every reconnect
  - scenario: Any player who was given a token opens 32 WebSocket connections with it and joins each (or just reconnects unjoined sockets every 5 s, before the join timeout). Every other player, including the operator, then gets HTTP 503 for as long as the token is valid. Joined sockpuppets stay forever by sending a valid input or ack every <15 s. Being kicked (4008) costs nothing: the next connection gets fres
  - fix: Key the session to the token or subject: allow at most one live peer per token (a new join replaces the old one or is refused), and cap unjoined sockets per token or address. Keep refusal and correction budgets per subject across reconnects for a cool-down window. Consider a token id plus a revocati
- [2/2 verifiers say real] **high** `src/10_Network/mirror.node.ts:254` — On foot the mirror keeps its own replay, not the claim, so obstacles that only the page has (cars, split-screen players 2-4, Sanctuary nudges) get an honest player snapped into the obstacle and kicked within about 2 s
  - scenario: An honest player walks west at walking speed into a parked car 3.5 m from the spawn. The realm stops at the car's face; the mirror walks on. First correction at 1.35 s, about 0.2 s after contact ('claim 0.27 m from the mirror's pose'). After that a correction every 50 ms, and the player is kicked at 1.85 s. In split screen, player 1 walking north into idle player 2 standing 3 m ahead is kicked at 
  - fix: Make the tolerance per input. When a foot claim is within tolerance and no further from `before` than the replay went (a blocked page only ever falls short, so speed hacks are still refused), restore the mirror avatar to the claim, as the wheel branch already does. Alternatively bound the accumulate
- [2/2 verifiers say real] **high** `src/10_Network/replication.node.ts:438` — An empty NET_SECRET makes the token HMAC key '' (anyone can mint tokens), while the console says a random secret was made
  - scenario: The operator deploys with NET_SECRET present but empty. The log reads 'secret made for this run'. A stranger computes `body = b64url('mallory') + '.' + (now+1h)` and `mac = HMAC-SHA256('', body)`, offers `auth.<body>.<mac>`, gets a 101, joins, and can mint tokens for any subject and any expiry.
  - fix: Use `process.env.NET_SECRET || randomBytes(32).toString('hex')` and print from the same condition. In startHost, throw when `secret` is shorter than 32 bytes or so, so an empty or weak secret cannot start a host that tokens gate.
- [2/2 verifiers say real] **high** `src/10_Network/replication.node.ts:352` — A token is not bound to one connection or to its subject: one (shared) token fills all 32 slots and joins under any name
  - scenario: A player holding the shared token (or a token for 'guest') opens 32 sockets and joins each, and keeps them alive with an ack every few seconds. Every other legitimate user, even with their own valid token, gets a 503 for as long as the holder likes. The same holder joins as 'operator', or under another player's name, and chats under it.
  - fix: Keep the subject on Conn from verifyToken at upgrade. Cap live connections per subject (1, or a small N; either close the older connection or refuse with 409/429), and key the cap on the subject (or a canonical re-encoding of the token), not the raw string. Bind the room name to the subject (or show
- [2/2 verifiers say real] **high** `src/10_Network/mirror.node.test.ts:189` — The drive bound is never tested across several inputs; per-input slack and zero-substep inputs let a car go far past 50 m/s, and all of it is kept
  - scenario: A client enters a car 3 m off the spawn sidewalk. Case 1: it sends 60 drive inputs paced at 60 Hz, each with 1 substep and claiming 50/60 + 0.49 m further. It moves 79.4 m in 60 substeps (1 s of realm time), with 61 kept and 0 corrections. Case 2: it sends 110 drive inputs with n = 0 back to back, each claiming +0.49 m. It jumps 53.9 m in 0.12 s while spending zero substeps, with 111 kept and 0 co
  - fix: Add a socket test on the mirror host: enter a car, send 60 one-substep drive inputs each claiming cap + slack, and expect a correction; also expect an n = 0 drive input to be refused. In mirror.node.ts, refuse drive inputs with n = 0 (netClient never sends them without `from`). Bound the drive dista
- [2/2 verifiers say real] **high** `src/10_Network/replication.node.test.ts:507` — The mirror socket test's inputUs < 5000 check measures the cold first input, sits within 2x of its limit when idle, and fails 3 of 4 runs under load
  - scenario: On a CI runner with one busy vCPU, `the mirror on the socket` fails with 'an input handled in 5494 µs' even though every movement check passed.
  - fix: Drop the timing check from this test (the 12-walker test already covers cost), or measure a warmed median: reset the stats or time judge() after a warm-up. Do not use an average seeded by the first sample over 10 inputs.
- [2/2 verifiers say real] **medium** `src/10_Network/replication.node.ts:317` — WebSocket pings are unmetered and pongs bypass the backlog rule; an unjoined peer is never checked, so unsent pongs pile up for the whole join window
  - scenario: A token holder upgrades, never joins, pauses reading, and floods masked 125-byte ping frames. Host RSS goes from about 140 MB to over 1 GB in 5 s, with event-loop gaps of 100–340 ms, which delays every tick and snapshot for the joined players. At join timeout the socket closes and is replaced by the next one. On a small VPS this OOM-kills the host; on any host it causes recurring lag spikes.
  - fix: Apply the backlog check to every write (pongs and close frames included), not only to joined peers: close when writableLength > maxBacklog whatever the join state. Put pings on a token bucket (e.g. a few per second, counted as refusals past it) and/or refuse control frames before join.
- [2/2 verifiers say real] **medium** `src/10_Network/replication.ts:729` — A network stall longer than about 2.1 s gets an honest page kicked: inputs under an old fix are counted as over-rate refusals before they are dropped unread
  - scenario: A Wi-Fi roam or TCP retransmission backoff holds the socket for 2.5 s while the page keeps reporting steps at 60/s. 150 inputs arrive at once. One gets 'more substeps than time allows' (a correction), the next 30 get 'input: over rate' refusals, and the peer is kicked (4008), even though none of those inputs would have been read.
  - fix: Drop `msg.fix < peer.fix` inputs before the rate check, or at least do not count an over-rate input under an older fix as a refusal. Optionally size inputBurst so it is never the binding limit when stepBurst is not.
- [2/2 verifiers say real] **medium** `src/07_Execute_Actions/engine.ts:1318` — The engine reports the unclamped foot velocity, so a scripted walk faster than a run on one axis fails the host's validator, and every input in flight earns a correction and a refusal until the kick
  - scenario: Joined to a room, the operator runs `sim.avatar.walk(8, 0)`. The realm walks at 5.2 m/s, exactly as the mirror would. Each reported move carries segs [[8,0,n]] and is refused as 'input: velocity'. Each in-flight input triggers a fresh correction plus a refusal, and after 8 (about 130 ms) the host closes the socket with 'repeated refusals'.
  - fix: Record what the realm applies: `const w = footWish(foot.x, foot.z); this.netSent.x = w.x; this.netSent.z = w.z` (footWish is already shared). Optionally clamp in netClient.move as well.
- [2/2 verifiers say real] **medium** `src/10_Network/replication.node.ts:362` — Refused upgrades are never destroyed and have no timeout: a client without a token can pin host file descriptors and lock out good tokens, invisibly after five log lines
  - scenario: An attacker opens N connections, each sending an upgrade with no token, and keeps them half-open. Each costs the host one descriptor forever. At the process limit, accept() fails, and players with valid tokens get no answer. The log shows five 401 lines and nothing more.
  - fix: Destroy refused sockets once the response is flushed (`socket.end(resp, () => socket.destroy())`) with a short unref'd destroy timer as a backstop. Also give the pre-join phase a hard socket timeout. Report `stats.throttled` periodically (or log it rate-limited) so a 429 flood is visible.
- [2/2 verifiers say real] **medium** `tools/net/smoke.mjs:141` — The 'speed hack on the clock' check corrects the second burst, not the third; the packet labelled as the hack is dropped unread
  - scenario: A regression halves stepBurst to 30, or makes refused inputs spend extra budget. The smoke and the socket test stay green while honest clients recovering from a 1 s stall get corrected.
  - fix: Wait for the bank to refill (sleep at least 1 s) before the bursts, wait for each burst to be acknowledged (peer.seq or a snapshot ack) before sending the next, and assert that the correction's `ack` equals the second burst's seq. Then the third packet really is the one refused.
- [2/2 verifiers say real] **low** `src/10_Network/replication.node.ts:330` — After close() the host keeps reading and concatenating into c.buf for up to a second (quadratic copy, loop stalls)
  - scenario: A token holder triggers a close (e.g. an unmasked frame → 1002), keeps its side half-open, and streams 64 KB chunks. Each such socket costs the host about 0.3 s of copying within its 1 s grace. With 32 sockets on one token in parallel the host showed event-loop gaps of 190–390 ms over several seconds, which delays ticks and input handling for every player.
  - fix: In close(), drop the data handler (`socket.removeAllListeners('data')`, or `socket.pause()`), clear c.buf, and return early in onData when c.closing before touching the buffer. Consider destroying sooner when the peer is the one being refused.
- [2/2 verifiers say real] **low** `src/07_Execute_Actions/player.ts:151` — After a snap, the realm's first substep is computed at the pre-snap collider position: up to one substep's travel (8.7 cm at a run) is lost and kept, where the tests and comments say 'a millimetre or two'
  - scenario: The realm is pressed against the podium wall at x≈326.68 when it is snapped to a truth at x=325.80, and the player keeps running east. On the first claim the realm reports x 325.800 / y 0.950 against the mirror's 325.887 / 0.920 (off 0.092 m). Every later claim stays 0.0866 m behind.
  - fix: In Avatar.teleport/restore in realm mode, also update the collider's position (world.propagateModifiedBodyPositionsToColliders(), or collider.setTranslation) so the next move starts at the new point, as in mirror mode. Add a test that snaps from a position different from the truth.
- [2/2 verifiers say real] **low** `src/07_Execute_Actions/engine.ts:950` — 'net status' dropped count includes every frame that ran no substep and every move only held for coalescing; pending lists already-acknowledged inputs after a correction
  - scenario: A player on a 144 Hz monitor joins and stands still for a minute. 'net status' shows 'dropped ~5000' with no correction and nothing lost. After a correction with ack 2 and inputs 1..5 unsent, pending reports 2 (inputs 1 and 2, both kept) until the next tick.
  - fix: Have move() return a status ('sent' | 'held' | 'idle' | 'stale') and count only stale (and possibly held, labelled as such). In the correct handler, clear unsent, or filter `i.seq > msg.ack` and then drop those too, since they will never be acknowledged.
- [2/2 verifiers say real] **low** `src/07_Execute_Actions/engine.ts:871` — Rejoining before the next frame has seen the close skips netLetGo: the stale netFix suppresses the new welcome's spawn teleport and the first corrections
  - scenario: Session 1 ends in a kick after 10 corrections (netFix = 11). A script polling `__SIM__.net.status()` calls `net.join` in the same task as the close. The new welcome (fix 1) is not applied, the page's claims are refused, corrections 2-11 are skipped by the `> netFix` test, and the corrections bucket kicks the session again.
  - fix: In net.join, call netLetGo (or at least reset netFix, netSent.fix/snap, netMove and netPeers) before connecting whenever the previous session's end was not observed. Alternatively key the engine's applied-correction state to the client session (for example its id or a session counter) rather than a 
- [2/2 verifiers say real] **low** `src/10_Network/netClient.test.ts:309` — netClient's 'a full input goes at once' section never coalesces anything; its final assertion is redundant
  - scenario: A regression in the full-input path (for example, flush(true) losing the held runs, or claiming the new step's pose for the old runs) passes this test unchanged, and the mirror then corrects honest clients that coalesce 30+ substeps after a stall.
  - fix: Do not advance the clock before the loop, so the rate stays spent and steps are held. Then assert that an input with exactly 30 substeps goes out when the 31st substep arrives, with its claim at the end of the 30th step, and that the new step starts the next held input.
- [1/2 verifiers say real] **low** `src/10_Network/replication.node.ts:274` — Host log injection and unbounded log flooding from unsealed frame content
  - scenario: A token holder sends `{"n":1,"mac":"000…","body":{"t":"x'\nupgrade from 203.0.113.9 refused: a token that does not verify\npeer 1 closed: operator banned peer 7 for cheating\n…"}}`. The operator's log shows forged host lines (a fake listener address, fake refusals blamed on another IP, fake kicks). Looping connect, 7 junk frames, reconnect fills the disk at multiple KB per frame.
  - fix: Never interpolate untrusted values into refusal reasons (use fixed strings like 'unknown message type' and 'join: protocol'), or JSON.stringify and truncate them. Also escape or strip control characters inside the host's log() and rate-limit refusal logging per connection and globally.
- [1/2 verifiers say real] **low** `src/10_Network/replication.ts:407` — Seals are keyed only by the bearer token: frames replay across every connection that shares a token, and the key travels in clear beside them
  - scenario: Two pages (two tabs, or two players handed the operator token) are joined. An attacker who can inject into page B's plaintext ws stream but missed its handshake replays a 'correct' frame captured from page A's stream with an n above B's counter. Page B's openServerFrame accepts it and the engine teleports B's player to A's truth. The same works host-bound with A's chat or ping frames injected into
  - fix: Derive a per-connection key, for example HMAC(secret, token + connection nonce), with the nonce sent in the 101 response or the welcome. Put the peer id and a direction label in the canonical sealed object. Otherwise, narrow the docs' claim to 'within one connection; TLS is the protection'.
- [1/2 verifiers say real] **low** `index.html:12` — The page's CSP blocks the [::1] and 127.0.0.0/8 hosts that netServer and the README promise for the room
  - scenario: An operator forwards the room with `ssh -L [::1]:8787:127.0.0.1:8787 server` (or binds a proxy on 127.0.0.2) and types `net join ws://[::1]:8787`. netServer and the guard accept it, then the CSP refuses the connection and the console only reports 'socket error'.
  - fix: Either add `ws://[::1]:* wss://[::1]:*` to connect-src and narrow netServer and the README to the hosts the CSP allows, or have connect() refuse hosts outside the CSP list with a clear message. Add a test that compares the CSP's connect-src host list with netServer's accepted hosts.
- [0/0 verifiers say real] **critical** `src/10_Network/mirror.node.ts:256` — Any honest contact with a car starts a correction loop that gets the player kicked within about a second
  - scenario: On the real host and client (startHost, seed 1337 mirror, netClient, a SimCore with 40 cars on tracks), car 0 is parked at (322, 345) beside the spawn sidewalk. The player walks at 2 m/s from (325.8, 347.5) toward (318.5, 343.5), a line that meets the car. Result: 11 corrections between 11.96 s and 12.49 s, then the socket closes with 'repeated illegal movement'. Other honest cases: leaning on the
  - fix: Do not snap a client into an obstacle the mirror cannot see. Being blocked only shortens a move and the Sanctuary nudge is bounded (6 m/s), so a claim that is reachable from the last kept pose (inside the replay's swept distance plus a bounded per-second nudge allowance, and clear of static geometry
- [0/0 verifiers say real] **high** `src/10_Network/replication.node.ts:357` — Refused upgrades are never destroyed: a tokenless attacker holds host file descriptors forever and host.close() never resolves
  - scenario: Without any token, an attacker opens N connections, sends an upgrade request with no or a bad auth entry, reads the 401/429, and never ends its side. Each costs the host one fd for good. When N reaches RLIMIT_NOFILE, accept() fails with EMFILE and a player with a valid token can no longer connect. The attacker needs no credentials and keeps no state beyond idle sockets.
  - fix: Destroy refused sockets yourself: `socket.end(resp); setTimeout(() => socket.destroy(), 1000).unref()` (or destroy on 'finish'), with an 'error' listener as in the crash fix. Optionally cap concurrent pre-101 sockets per address. Track refused sockets so host.close() can destroy them.
- [0/0 verifiers say real] **high** `src/10_Network/mirror.node.ts:170` — Mirror never steps its world, so every join/leave permanently slows every later substep (peer churn degrades the authority)
  - scenario: One player with a valid token loops connect → join → close (no limit per token or address). In my run that was 567 cycles/s from one machine. Each cycle adds about 0.75–1.1 ns to every later substep. After 20k cycles (35 s) a 30-substep judge costs 1.06 ms instead of 0.60 ms. Extrapolated: after about 300k cycles (around 10 minutes) a substep costs about 0.25 ms, so a full room (32 peers × 60 subs
  - fix: Drain Rapier's change lists: call world.step() (or a cheap equivalent) after each leave or every N joins/leaves (the world is static, so a step only clears the bookkeeping). Alternatively, pool and reuse Avatar bodies by moving them out of the way instead of creating and removing them. Add a test th
- [0/0 verifiers say real] **high** `src/10_Network/mirror.node.ts:192` — A correction that lands at the wheel puts the player inside the car they just left, and the loop never ends
  - scenario: Drive car 0 north 2 s from (322, 345) and stop; any correction lands (truth = chassis (322.00, 0.95, 347.52)). Standing still afterwards: 100 corrections in 5 s with RTT 0, bucket empty 0.5 s after the first; 30 corrections in 5 s with RTT 100 ms, bucket empty after 1.6 s. Walking away east: 19 corrections, and the 10-correction budget is still exceeded.
  - fix: Make the truth at the wheel a place to stand. settle() for a driving peer should put the body down at an exit point beside the chassis (the realm's 2.1 m left/right rule, checked with a corrected #clear), and the correction should carry that point. Alternatively, the page's teleport-from-car should 
- [0/0 verifiers say real] **high** `src/10_Network/mirror.node.ts:306` — Honest car exits on the pier deck (and next to the seawall) are refused, then the at-the-wheel loop kicks the player
  - scenario: Car 0 starts on the promenade at (320, 650) facing +z; the player drives at 0.6 throttle for 5 s and the car climbs onto the pier (chassis y 0.86 at z = 682). The player brakes and presses interact: realm exit at (322.1, 682.0); mirror refuses 'exit point inside a building'; 40 more corrections follow in about 2 s (bucket empty at t=9.1 s). With a car parked at (300, 664.5) heading +x, the exit is
  - fix: In #clear, find the support height first (a downward ray like the ground guard, or ignore geometry below autostep height) and test the capsule standing on it. In simCore #interact, choose the exit point with a capsule-clearance test against solid fixed geometry (seawall, railings, deck) instead of i
- [0/0 verifiers say real] **high** `README.md:1295` — README claims a car is never faster than 50 m/s, but the at-the-wheel bound accepts 80 m/s sustained and about 480 m/s by hopping in and out
  - scenario: A joined peer enters a car and sends 60 inputs a second, each with 1 substep and a claim 1.33 m further along the street. Every input is kept, with no correction and no kick: 80 m/s held for as long as the peer keeps it up. Alternatively it alternates {mode:'drive', segs:[[0,0,0]], claim 8.4 m ahead} with {mode:'foot', segs:[[0,0,0]], from: 7.9 m ahead}. That uses no substep budget and moves about
  - fix: Either fix the bound (charge a minimum substep for drive inputs or refuse n = 0 at the wheel, make driveSlack a per-second budget, and refuse an enter followed by an exit with no substeps in between, or require substeps for each door), or rewrite the README and blueprint to give the real envelope: p
- [0/0 verifiers say real] **medium** `src/10_Network/mirror.node.ts:192` — A correction while driving drops the body on foot at the chassis spot without checking the spot is clear
  - scenario: The peer drives into a podium as above, then sends an input with seq <= peer.seq. correct() calls settle(), and the truth becomes (60.00, 0.95, 20.00), on foot, inside the solid box, with driving=false. Every snapshot shows the other players a pedestrian standing inside the building.
  - fix: In settle(), when the body is driving, put it down at the nearest clear standing point (the same #clear test the exit uses). If none is within reach, use the last pose that was on foot or clear.
- [0/0 verifiers say real] **medium** `src/10_Network/netClient.ts:298` — The page never sends 'ack': a joined player whose tab is hidden for 15 s is dropped as 'idle'
  - scenario: A player joins, then switches to another tab or minimises the window for 15 s (or the engine is paused). The host closes them with 4001 'idle' even though the socket is healthy and snapshots were still arriving. The player has to type `net join` again and respawns at the spawn sidewalk.
  - fix: Have netClient send `{ t: 'ack', ack: replica.tick }` from a timer independent of rAF (e.g. every 5 s when no input was sent), since background timers still run at ≥1/min. Alternatively, let any well-formed frame refresh `seen`. Add a netClient test with no move() for longer than idleTimeoutMs.
- [0/0 verifiers say real] **medium** `src/10_Network/mirror.node.ts:189` — A correction at the wheel puts the walker down at the chassis centre, inside the car the realm has just parked there
  - scenario: The player sits in a stopped car (chassis at x 322.30). A correction arrives at the wheel, the page exits and is put at x 322.30 inside the car, and the player walks east to get clear. The realm moves west (322.233, 322.167, 322.100) while the mirror moves east (322.333, 322.367). The claim is refused every third frame ('claim 0.30 m from the mirror's pose'), each snap puts the walker back inside 
  - fix: When settling a driving body, put the walker where the realm's exit does (2.1 m to the driver's side, or the other side if that is in a lot, checked with #clear), and teleport the page's realm to that point, not the chassis centre. Alternatively have the realm's teleport-while-driving move the parke
- [0/0 verifiers say real] **medium** `src/10_Network/replication.node.ts:287` — Token expiry is checked only at upgrade and join: a session outlives its token indefinitely
  - scenario: An operator hands a visitor a token good for 10 minutes. The visitor joins at minute 9 and keeps playing (or keeps an idle script acking every 10 s) for days. A fresh upgrade with that token is refused, but the open session is never touched.
  - fix: Keep the verified expiry on Conn at upgrade. In the ticker, close any conn whose expiry has passed (for example code 4001 'token expired'), and say in the docs that a session ends when its token does.
- [0/0 verifiers say real] **medium** `src/10_Network/replication.node.test.ts:406` — Two socket tests skip host.close() on failure, so one red assertion makes node --test hang forever
  - scenario: The 426 status assertion fails, or `until(() => forged.status === 'closed')` times out. The runner then never finishes, and CI shows a job timeout instead of the failing test.
  - fix: Wrap both bodies in try { … } finally { await host.close() }, as the other socket tests do. host.close() is safe to call twice. Pass a per-file `timeout` to `test()` for the socket tests as a backstop.
- [0/0 verifiers say real] **medium** `tools/net/smoke.mjs:127` — The smoke's 'first message is the correction' and 50 ms checks flake under load against a 20 Hz room; a startup timeout leaks the server process
  - scenario: On a loaded machine, `npm run smoke:net` exits 1 with 'an injected velocity: three runs  NO  no  kept 17.2 input: velocity': the packet was refused and the truth kept, but a snapshot arrived first. When the server is slow to start, the smoke fails and leaves an orphaned host running.
  - fix: Let the server take NET_TICK_HZ and have the smoke use 1 Hz like the in-process test, or match the correction by its fix number and ignore interleaved snapshots instead of requiring got[from] to be the correction. Measure latency against a looser bound or report it without failing. Move the startup 
- [0/0 verifiers say real] **medium** `src/10_Network/mirror.node.ts:266` — The 25 cm tolerance is used up over the whole session: kept inputs never re-anchor the mirror, so honest offsets pile up
  - scenario: Walk once along x = 323.1 past car 0 parked at (322, 345): 0 refusals, but the mirror stays 0.142-0.147 m off for every later input (686 of the next inputs at p50 0.146 m). Walk back the same way: 59 corrections, kicked 0.5 s into the second pass. After the Sanctuary loop in the 5-minute enter.ts run, the remaining 16,260 inputs sat at p50 0.191 m, 76% of the tolerance. One car exit after getting 
  - fix: Apply the tolerance per input, not per session. When a claim is kept, adopt it (or move the mirror toward it) as long as it is reachable from the previous kept pose within the replay's distance plus a bounded nudge allowance and is clear of static geometry. Blocking can only shorten a move, so this 
- [0/0 verifiers say real] **medium** `src/07_Execute_Actions/player.ts:109` — Split-screen partners block player 1 on the page but not in the mirror, and joining a room with ?players>1 is allowed
  - scenario: ?players=2 in a room, with player 2 standing at (325.8, 336) on the spawn sidewalk. Player 1 walks north past them at 2 m/s: 1 refusal (correction), then a 16.7 cm offset for the rest of the session (190 of 361 inputs over 10 cm). A couple more bumps lead to the loop in the first finding and a kick.
  - fix: Either refuse net.join while the screen is split (as is already done for regions), or have the page's player-0 controller ignore the other local avatars as the mirror does (exclude kinematic bodies for avatar-vs-avatar). Add a netWiring test with spawns.
- [0/0 verifiers say real] **medium** `tools/net/smoke.mjs:140` — Smoke 'third half-second burst' row: the third packet is never judged; the correction timed is for an earlier burst
  - scenario: Run `npm run smoke:net`: the row 'speed hack on the clock: a third burst at once ... refused ... 1.7 ms' prints, yet the server never judged that packet. If the clock-hack check broke for a lone over-budget packet, the smoke and the node test could still pass on an earlier burst's correction.
  - fix: In smoke.mjs and the node test, wait until the bank is full after the refused claim, or send the bursts first, and update `fix` from each burst's correction. Assert that the correction's ack shows the crafted seq itself was refused. Correct the README and blueprint wording, and re-measure the timing
- [0/0 verifiers say real] **medium** `README.md:1257` — Docs say a throttled address gets a 429 'without the check being run'; the host always runs the HMAC check first and admits a good token
  - scenario: An operator who reads the docs believes a flooding address costs the host no HMAC work once throttled. In fact every upgrade from that address still runs a full HMAC-SHA256 verification. A good token from the same address is let straight in, which the docs' wording ('turned away') implies cannot happen.
  - fix: Reword the README and blueprint: 'after five failures in quick succession (refilling one per 5 s), further failed tokens from that address are answered 429 instead of 401 and not logged; the token is still checked, and a good one is always admitted.'
- [0/0 verifiers say real] **medium** `README.md:1326` — README 14A paragraph: a stale input sequence number no longer counts toward the eight-refusal kick
  - scenario: A peer replays stale-seq inputs: each one earns a correction (with its reason, which the old 'the host never explains a refusal' rule forbade), refusals stay 0, and the socket stays open past eight. It is closed only after the 11th within the corrections burst, or never if paced.
  - fix: Separate the two budgets in the paragraph: malformed, out-of-rate and forged frames and inadmissible chat count toward eight refusals; inputs the authority will not keep (stale seq, bad fix, future ack, a failed judgement) are corrected and count toward ten corrections a minute.
- [0/1 verifiers say real] **low** `src/10_Network/replication.node.test.ts:434` — Host removal paths are pinned only by regex or the pure core: backpressure 4009, the corrections kick, and the joined-idle timeout never run over a socket
  - scenario: Possible regressions that would stay green: apply() closing before sending the correction reply; the ticker's expired() loop skipping joined peers; close() for 4009 being reached but the socket never ending. The regex test also goes red on a harmless refactor of send().
  - fix: Add socket tests on the plane host. Send 11 lying inputs and assert 10 corrections, then close code 4008 with 'repeated illegal movement'. Join, advance the injected clock by idleTimeoutMs, and assert close 4001 'idle'. For 4009, use startHost({ maxBacklog: 0 }) with a peer that has stopped reading,
- [0/0 verifiers say real] **low** `src/07_Execute_Actions/player.ts:154` — First step after a teleport or car exit uses the page capsule's old collider position (up to 9 cm, documented as millimetres)
  - scenario: Car 0 is parked half on the sidewalk at (324.6, 345). The player leans east on the podium wall at x = 327, gets in, drives, stops, and gets out at (322.5, 342.6) running east. Page claim (322.5000, 0.9501, 342.6154) vs mirror (322.5867, 0.9200, 342.6154): 9.18 cm on that step and 8.67 cm for the rest of the session. Every welcome: claim y 0.9473 vs mirror 0.9200 (2.73 cm).
  - fix: In Avatar.teleport (and in restore on the page) also move the collider at once, e.g. physics.world.propagateModifiedBodyPositionsToColliders() or collider.setTranslation, so the page and the mirror start the next move from the same collider. Do the same when the collider is re-enabled on a car exit.
- [0/0 verifiers say real] **low** `README.md:1293` — 'A refused packet changes nothing on the server' is false at the wheel: the correction ejects the driver on the server
  - scenario: A driver whose page runs 1 m ahead of the 0.5 m slack in one input (a frame hitch, a bump from local traffic) gets one refusal. The server's truth switches to on foot, and the page is pulled out of the car at the chassis position.
  - fix: Document that a correction at the wheel puts the player on foot at the chassis (as the mirror.node.ts header already does), or make settle keep `driving` and y for drive-mode refusals.
- [0/0 verifiers say real] **low** `README.md:1367` — Layout table says the page client 'joins only over wss (or plain ws on this machine)'; the gate refuses wss to anywhere but loopback
  - scenario: An operator reading the Layout table runs `net join wss://rooms.example.net/...` expecting it to work for a cloud room. It is refused before a socket opens ('only ws or wss to this machine, with no credentials').
  - fix: Change the row to 'the opt-in page client that speaks ws or wss only to this machine (a host here, or the local end of a tunnel or proxy)'.
- [0/0 verifiers say real] **low** `src/10_Network/replication.node.ts:6` — Host header says a binary frame closes the socket; it is only counted as a refusal
  - scenario: A client that sends a binary frame stays connected and can send seven more before it is closed. Anyone relying on the header (for example when writing a proxy rule or a client) expects an immediate close.
  - fix: Header: 'anything fragmented or over the message bound closes the socket; a binary frame is refused and counted like any malformed one'.
- [0/0 verifiers say real] **low** `src/10_Network/replication.node.ts:182` — HostStats doc says 'unauthorized' includes the 429s; the code counts 429s only in 'throttled'
  - scenario: An operator reading host.stats() during a token flood takes 'unauthorized' as the total number of refused upgrades and undercounts it by every throttled attempt.
  - fix: Document 'unauthorized' as 401s only and 'throttled' as 429s, or count both in 'unauthorized'.

## Next steps / resume commands

```sh
cd /home/user/Crimson-Noir-AI-Agent-City && git fetch origin claude/quirky-faraday-xkpdln && git status && git log --oneline -5
npx tsc -b && npx oxlint && npm test && npm run build && npm run smoke:net     # the release's checks, all green
npm run smoke:bridge                                                           # the OS bridge vs the real host
cd crimson_noir_os && NOIR_REQUIRE_GPU=1 cargo test --workspace                # core 48 + hosted 15 (GPU via lavapipe)
cargo run -- selftest && cargo run -- frames /tmp/frames                        # CPU = GPU, word for word; PNG frames
cargo clippy --workspace --all-targets && cargo clippy -p crimson_boot --target x86_64-unknown-uefi --release
sh tools/build-image.sh                                                        # target/image/crimson_noir_os.{img,iso}
python3 -I tools/boot_test.py target/image/crimson_noir_os.img --timeout 150 --wait "SELFTEST PASS" \
  --step "wait:TUTORIAL 5 SORT" --step sleep:8 --step shot:/tmp/sort.png --step "wait:TUTORIAL 6 PASSED" \
  --step 'type:\n' --step "wait:TERMINAL READY" --step 'type:golden\n' --step wait:MATCH \
  --step 'type:halt\n' --step exit                                              # about 95 s under TCG
```

## Phase 14 (operator directive): bare-metal deployment, terminal expansion, cloud RL bridge

Directive: (1) physical USB/bare-metal target with network drivers for outbound WebSocket, keeping the DOD sandbox;
(2) terminal expansion — live hex bitmasks over the 1-D arrays, a memory-safe `flush` to zero agent blocks during
compute; (3) connect the OS to the Phase 12 authoritative Node/Deno server, send the hash-chained RL weight ledger for
verification against the 14A rules, sync validated weights back.

Status and honest assessment:
- DONE part 2: `flush` word added (kernels::flush = the manual loop-breaker wipe; clears only, so containment holds;
  index bounds-checked). Live hex bitmask editing already existed (`$ff`, and/or/xor, `!a`, `fill-a`). 47 core tests
  (new: flush_zeroes_one_agents_block_and_nothing_else), clippy clean, verified through the hosted `terminal` binary.
- BLOCKED / needs operator decision, parts 1 and 3:
  - This environment has ONLY QEMU; there is no physical hardware and no way to flash/boot USB here. "Verify the
    physical deployment" cannot be done in this session — only a QEMU boot can.
  - A real bare-metal network stack (NIC driver + ARP/IPv4/TCP + TLS 1.3 + WebSocket, no_std, no entropy/cert store on
    bare metal) is months of specialist work and cannot be honestly stubbed and called verified. Will not fake it.
  - Outbound network directly contradicts `containment.network = false` (the validator refuses `true`: "the air gap is
    not configurable") and the operator's own standing instruction to keep the air gap intact. It also contradicts
    "prove the sandbox does not leak" — an outbound socket IS the leak. Cannot prove both.
  - Honest achievable alternative offered: build the cloud bridge + RL ledger verification in the HOSTED runtime
    (`src/`, std, real networking, already runs the same kernels/weights). It talks WebSocket to the Phase 12 server,
    sends the hash-chained weight ledger, server validates the fold vs 14A, syncs validated weights back. The
    bare-metal image stays air-gapped. This is testable against the real server.
  - Operator chose "Bridge in hosted runtime", then confirmed it ("PHASE 14 ARCHITECTURAL PIVOT APPROVED": no
    bare-metal TCP/IP, keep `containment.network = false`, the QEMU/USB image stays air-gapped). Do NOT flip
    network=false or write a bare-metal driver.
- DONE part 3, as approved (the hosted runtime, never the image):
  - Host: `src/10_Network/ledger.ts` (pure checks: canonical config vs the pinned lock, 14A screen, network=false,
    entry rules, fold, seal, contained weights; rewards must be ones the kernel's formula can produce — exact, via
    `producible`, not just the range) and `ledger.node.ts` (the `crimson.1` door in replication.node.ts beside
    `onyx.4`: same tokens/401/429/sealed envelopes; verified → kept by digest; fetch → weights chunks + end; refused →
    sealed reason + 4008). Opens only with `ledgerLock` (NET_LEDGER_LOCK or crimson_noir_os/containment.lock), else
    404. Tests: ledger.test.ts (8), ledger.node.test.ts (5, real sockets, incl. a 40-session mutation fuzz).
    airgap.test.ts allowlists the new imports with reasons and forbids the ledger files any outbound call.
  - Runtime: `crimson_noir_os/src/wire.rs` (std-only RFC 6455 client, SHA-1, base64, HMAC-SHA256, bounded JSON,
    canonical writer; literal loopback addresses only — no DNS lookup, no TLS), `ledger.rs` (recorder around
    golden_step: LEARN on dock by a learn role, WIPE on flush/reap; fold == matrix weights; adopt checks digest,
    range, learn roles), `bridge.rs` (session/submit/fetch/run; `run` records, self-checks, submits, then a fresh
    matrix fetches and adopts — bit-exact). `main.rs`: `bridge [URL]` (token from CRIMSON_TOKEN only) and
    `canonical`. `containment.canonical` is held equal to the generator (Rust test) and its SHA-256 to the lock (TS).
    One link pinned in both languages: link([0,5,17,3,1234], GENESIS) = 946cde52….
  - End to end: `npm run smoke:bridge` (tools/net/bridge-smoke.mjs): real host process + real runtime; 3,576
    entries (3,551 learns, 25 wipes) verified, a fresh runtime adopts 3,200 weights bit-exact; refused: no token,
    forged token (401), off-machine address, a name to look up; over the wire (the ignored live Rust test
    `a_tampered_ledger_is_refused_by_the_live_host`): a sentry that learns, a swapped reward sealed as the honest
    weights, an edited entry, a reward no clock gives; the host still shares only the honest weights. 10/10 checks.
  - Checks (all green): `npx tsc -b`, `npx oxlint`, `npm test` 1,232/1,232, `npm run build`, `npm run smoke:net`,
    `npm run smoke:bridge`, `NOIR_REQUIRE_GPU=1 cargo test --workspace` 63 passed (48 core + 15 runtime; 4 ignored:
    3 QEMU-side, 1 live), clippy workspace + UEFI clean. No network code in `boot/` or `crates/`.
- NOT DONE, and why (part 1): nothing was flashed or booted on physical hardware (only QEMU exists here); the image
  has no NIC driver or network stack, by the operator's approved pivot. The bridge is loopback-only `ws://` with no
  TLS; anything remote reaches the host through the operator's TLS reverse proxy, as the room's players do.
- Tags `v1.0.0-stable-release` and `stable-beta` exist locally only: pushing tags returned HTTP 403 from the git
  proxy. The operator must push them (or create them on GitHub at the matching commits).

## Phase 15 (operator directive): production infrastructure and CI/CD

Directive:
1. `publish.ps1`, for the operator to push the tags `v1.0.0-stable-release` and `stable-beta` at cb99379 (the
   agent's git proxy answers 403 to tag pushes).
2. `.github/workflows/build-release.yml`: on a tag push, set up Rust, build the OS, make the .img and .iso, and
   attach them to a GitHub Release.
3. A minimal multi-stage Dockerfile for the Node host, and an nginx TLS reverse proxy (wss:// outside, ws:// to the
   host inside).

### State: COMPLETE

Committed in 913bba0 (checkpoint) and the review-fix commit after it.

**The deliverables:**
- `publish.ps1` (Windows PowerShell 5.1 and PowerShell 7). The default commit is the full SHA of cb99379, so no
  short prefix can be matched by a look-alike commit.
  - It works on the clone it lives in. Every fetch and push URL of the remote must name the repository (anchored
    match).
  - It fetches with `--no-tags --no-prune`, leaving the operator's own tags alone.
  - It accepts one to three tags ('a,b' is two).
  - A local tag is reused only if it is annotated (and signed, with -Sign).
  - Moving a tag needs -Force, and the push carries a lease. The push is atomic, and the tags are read back after.
  - It decodes git's output as UTF-8 and hides credentials in printed URLs.
  - It names the branch head as the commit to tag when the default commit predates the workflow.
- `.github/workflows/build-release.yml`, in two jobs.
  - The bake job is read-only:
    - Rust 1.97.0, `cargo fetch --locked`, the workspace tests with lavapipe;
    - build-image.sh, which now gives reproducible media;
    - QEMU boots: the .img through the terminal run to a logged POWER OFF, the .iso to SELFTEST PASS;
    - SHA256SUMS, covering NOTICE.txt and LICENSE-MIT/APACHE too.
  - The publish job alone has contents: write:
    - it checks the sums;
    - it checks that the tag still names the baked commit;
    - it creates the release, or updates an existing one's files and notes;
    - it marks prereleases by an exact alpha/beta/rc match.
- Container deployment:
  - `Dockerfile` and `.dockerignore`;
  - `tools/net/closure.mjs`, with a regression test in `src/10_Network/closure.node.test.ts` holding its list equal
    to what Node loads;
  - `tools/net/image-check.mjs` and `tools/net/mint-token.mjs`;
  - in `deploy/`:
    - `docker-compose.yml`: an internal network, IPv4 publishing, a stop grace period;
    - `nginx.conf`: worker_shutdown_timeout, a 426 with an Upgrade header, honest origin and limits comments, a
      complete real-IP recipe;
    - `bridge-tunnel.conf`, used by the game page and the OS runtime alike;
    - `README.md` and `.gitignore`.

**Host and test changes:**
- The host takes `NET_SECRET_FILE` and `NET_PRINT_TOKEN=0`, and refuses to run tokenless without a secret.
- **Bug fixed:** `verifyToken` now accepts only the canonical base64url spelling of the signature. Before, four
  spellings verified, because the decoder ignores the last character's padding bits. A unit test holds this. The
  bridge smoke's "forged token" changed only the last character, so it passed or failed by chance (3 in 64): it now
  changes the first.
- The smoke scripts ignore an operator's NET_SECRET_FILE and NET_PRINT_TOKEN.
- boot_test.py no longer spins for 10 s on a closed monitor.
- build-image.sh builds with --locked and reproducibly. Every timestamp is the commit time (SOURCE_DATE_EPOCH), and
  the GPT GUIDs and FAT serial come from the commit hash. Three builds were byte-identical. The EFI binary embeds no
  machine paths, only the toolchain's /rustc/<hash>.

**The review:**
- 7 agents ran: 3 execution verifiers, 2 reviewers and 2 skeptics, raising 62 findings.
- Every finding confirmed real, and every cheap improvement, was fixed.
- Rejected by the skeptics as not real:
  - Origin "null" as a bypass: the token is the access control, and no Origin is admitted anyway;
  - GH_TOKEN step scoping as a security boundary (moved to the step anyway);
  - the frontend pin;
  - the healthcheck start delay (measured at 5 s).

**Verified here:**
- tsc, oxlint, `npm test` 1233/1233, build, smoke:net, smoke:bridge;
- `cargo test --workspace` 63 passed with the GPU, clippy on the workspace and the UEFI target;
- actionlint (with shellcheck), `docker build --check`, hadolint (in the review), PSScriptAnalyzer (only Write-Host;
  no 5.1 or 7.0 syntax, command or type issues), `docker compose config`.
- publish.ps1 under pwsh 7.4.2 against fixture repositories:
  - refuses to move tags; -WhatIf changes nothing; real runs make annotated tags; re-runs are idempotent;
  - refuses local-only commits, a wrong or evil-prefixed URL, a wrong push URL, a lightweight local tag, a garbage
    commit, and a shallow clone (with a hint);
  - -Force moves under a lease;
  - parses comma-joined tags as separate tags;
  - ignores GIT_TRACE noise, runs from another directory, keeps a non-ASCII path and subject intact under code
    page 850, and preserves the operator's local tags under pruneTags.
- The live stack, with a test CA:
  - status codes 426 (with Upgrade), 404, 405, 403, 401 and 301; TLS 1.1 refused, TLS 1.3 verified, HSTS sent;
  - the room joined over wss and through the tunnel; the OS ledger verified through the tunnel, adopted bit-exact,
    and 4 tampers refused;
  - no egress from the host; .image-checked owned by root with mode 0444; no token in any log;
  - a proxy stop in 0.5 s.

**For the operator:**
- cb99379 (the directive's commit and publish.ps1's default) has no workflow file, so tags there start no bake. To get
  the release media, either run `.\publish.ps1 -Commit <branch head>` (the script prints the SHA), or keep cb99379,
  merge the branch into main, and run `gh workflow run build-release.yml -f tag=<tag>` for each tag.
- The old local-only tags in this container (v1.0.0-stable-release at 994eb6d, stable-beta at ca4a41f) were never on
  origin, and the operator's machine does not have them.

**Not verified:**
- No GitHub Actions run (no runner here).
- No Windows PowerShell 5.1 (only static analysis against its profile).
- No physical hardware.

**Local test tooling (not committed):**
- pwsh 7.4.2 copied out of mcr.microsoft.com/powershell into the scratchpad;
- dockerd started by hand;
- the stack ran from deploy/ with a throwaway CA, and was torn down at the end.

## Phase 16 (operator directive): final audit and launch

Directive: (1) a 7+ agent adversarial audit with property-based fuzzing of memory boundaries and token validation,
fixing anything found with regression tests; (2) a PR from `claude/quirky-faraday-xkpdln` to `main`, merged;
(3) releases `v1.0.0-stable-release` and `stable-beta` cut through the API, and the bake watched; (4) a production
`docker-compose.yml` and a one-touch `deploy-live.sh` with Let's Encrypt.

### State

**The audit (done).** Eight attackers (nginx proxy, container bounds, Rust no_std core, WASM engine, ledger wire,
tokens and seals, air gap and CSP, memory and determinism), then a skeptic per attacker (the first pass hit the
operator's usage limit; the workflow was resumed and every agent finished: 16 agents, ~3.0M tokens). 51 findings;
the skeptics confirmed 13 as real (none worse than minor), rejected the rest as theoretical here or as documented
limits. Fixed, each with its regression test committed (the attackers' tests, 9 files, 72 new tests):
- Rust core: a name with `"`, `\` or `$` broke the canonical round trip (config.rs text() refuses them); a long
  dotted path recursed the parser off its stack (bounded by MAX_DEPTH); stats/agent/words/help/roles were not
  charged to the terminal's step budget (charged, so a budget bounds a line's time); a patrol walked off the floor
  with the edge walls cleared (positions clamped, CPU and WGSL alike; the scripted run's fingerprint is unchanged);
  bitonic_sort of an empty slice, zero_one_proof's precondition.
- The Rust bridge (wire.rs/bridge.rs): a 10 s per-message deadline and at most 64 pings per message (a drip or a
  ping flood no longer holds it); a fetch takes at most one weight per slot of the pool; the host's text is escaped
  (`loggable`) before any terminal line carries it.
- The ledger door: the host keeps for the fleet only the configuration's own run, whose seal is pinned in
  `crimson_noir_os/containment.seal` (`cargo run -- seal`; a Rust test holds the file equal, the image carries it as
  NET_LEDGER_SEAL, image-check proves it is pinned). Any other lawful ledger is answered `verified` with
  `kept: false`. The skeptic rated the finding a nit (the bridge's own adopt already refused a replaced set), but a
  token-holder could still make every other runtime's fleet sync fail; now it cannot.
- Host: a NaN clock refuses (not admits) an expired token; the secret is measured in bytes with no NUL; the failure
  buckets are capped at 4,096 addresses and swept once a second; readFrame judges a 64-bit length against a whole
  bound and refuses non-minimal length encodings (1002).
- Page: canonical() writes a sparse array's holes as null; the prefix cache re-takes its output view after each
  append (a grow detached it: copies went uncounted), compares a hit by tokens not by a 32-bit digest, reports a
  hit's own `forked`, bounds `pages` to 2^20 and refreshes its counts after a refused ask; the routing wrapper
  re-takes its views when the exported memory changed and reports a refused grow as an error; the native routing
  module refuses a piece count whose words would wrap a wasm32 usize (rebuilt: routing.wasm.ts); the gate's
  isLoopbackHost takes four octets of at most 255; `x-dns-prefetch-control: off` in index.html, and the link-hint
  limit documented in docs/zero-trust-audit.md.
- Deployment: `backend` has an isolated gateway (the host could reach any service the server binds on 0.0.0.0;
  Docker 28+, and deploy-live.sh adds the cut with iptables too); `edge` does not masquerade and deploy-live.sh
  drops new connections from the proxy to the internet and to the server's own stack (the proxy could reach both);
  memswap and cpu limits; the proxy's /tmp sized (64 MB); deploy-live.sh acts only in the real deploy directory
  (a symlinked or copied script could lock /usr/local/bin to root) and reads the published port from compose;
  X-Real-IP/Forwarded cleared at the proxy; .dockerignore keeps the page's sources out of the build context; the
  tunnel's documented docker run carries the stack's hardening.
- Rejected by the skeptics and left as documented limits (see deploy/README.md "Limits to know" and
  docs/zero-trust-audit.md): the port-80 redirect reflecting Host, the case-insensitive 'null' origin, navigation
  and WebRTC-through-a-realm exfiltration, loopbackServer admitting 127.0.0.2 and [::1] (the CSP refuses them), the
  gate admitting a fragment (the WebSocket constructor refuses it; the gate's test pins it).

**Verified after the fixes:** `npm test` 1,301/1,301; `cargo test --workspace` 85 (48 core, 16 runtime incl. the
seal pin, 21 property tests in crates/noir_core/tests); native tests; clippy on every target; tsc; oxlint; build;
smoke:net; smoke:bridge (10/10, the host keeps the run); the image rebuilt and the stack recreated by deploy-live.sh
with the new network options; the proxy cannot connect out; the host cannot reach a listener on the server's
0.0.0.0 (Docker's isolated gateway refuses it); a join over wss and through the tunnel; the bridge through the tunnel
(verified, kept, bit-exact); an empty lawful ledger verified and not kept, the fetch after it still the pinned run.

**Provisioning (done, part 4):** `deploy/docker-compose.yml` (renamed from compose.yaml) and `deploy/deploy-live.sh`
(self-signed, Let's Encrypt with a stand-in certbot incl. the renewal hook, idempotent re-run; its first run found
the 0700 tls/ directory bug, fixed).

**Release path (parts 2 and 3):** `gh` has no valid token here (GH_TOKEN rejected); the GitHub MCP tools work as the
owner but have no release-creation call. So build-release.yml now cuts a release from a dispatch: for a tag that
does not exist it bakes the dispatched commit and makes the tag as part of the release (`gh release create
--target`), with `title` and `notes` inputs; an existing release keeps its title and notes above a marker. Replayed
locally with a stand-in gh in four scenarios. The plan: merge the PR, dispatch on main for
`v1.0.0-stable-release` (title "Crimson Noir OS v1.0.0 Stable Release", notes "Production ISO Release. Fully
Audited.") and `stable-beta` ("Stable Beta", a prerelease by the alpha/beta/rc rule), watch the runs, verify the
assets.

**Merged and released (parts 2 and 3, done):**
- PR #1 (the branch's standing pull request, retitled to the full scope) merged into `main` at 0f68d954 with a merge
  commit; auto-merge is not enabled on the repository, so it was merged directly with the head pinned to c198b066.
- build-release.yml dispatched on main twice (run 37650576963 for v1.0.0-stable-release, run 37650584700 for
  stable-beta); both completed successfully in about 7 minutes: tests, bake, both QEMU boots, publish. The workflow
  made the tags at 0f68d954 and the releases:
  - https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.0-stable-release
    ("Crimson Noir OS v1.0.0 Stable Release", notes "Production ISO Release. Fully Audited." above the media
    description, not a prerelease);
  - https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/stable-beta ("Stable Beta", a
    prerelease). Each carries crimson_noir_os.img (36 MiB), crimson_noir_os.iso, BOOTX64.EFI, containment.nix,
    containment.lock, NOTICE.txt, LICENSE-MIT, LICENSE-APACHE and SHA256SUMS.
- Found by comparing the two: the EFI binaries of the two releases differ from each other (and so do the img and
  iso) in exactly two 4-byte linker timestamps (the PE header's and the debug directory's). The local
  reproducibility test in Phase 15 never rebuilt the EFI (cargo was a no-op the second time), so it missed this.
  Fixed on the branch: crimson_noir_os/.cargo/config.toml passes /Brepro to lld-link for the UEFI target (two clean
  builds and two clean bakes are now byte-identical), and the workflow bakes twice from a clean build and refuses a
  release whose two bakes differ. The two published releases predate the fix: everything in them was built and
  booted by CI, but their media are not bit-identical to each other or to a rebuild; cutting new tags from a commit
  with the fix is the operator's call (publish.ps1 or a dispatch with a new tag name).

**Not verified:** no Windows PowerShell 5.1; no physical hardware; no real Let's Encrypt issuance (needs a public
name).

## Phase 18 (operator directive): self-healing CI/CD and formal WebAssembly verification

Directive: (1) a formal verification platform step (SMT / symbolic execution) in the build pipeline over the
Rust/WASM kernel: prove the 64-ring deterministic schedule and the 1D DOD arrays never reach an undefined state or a
memory trap, from the LLVM IR, hard-failing the build on any path that violates the Phase 11 air gap or the memory
isolation bounds; (2) build-release.yml upgraded into a self-correcting loop: on a failed proof, telemetry test or
test suite, a sandboxed remediation agent isolates the failure, maps it to the AST, formulates a structural patch,
re-runs the suite in an ephemeral container, dampened at 3 attempts, and on success pushes a `selfheal-*` branch and a
documented PR; (3) the IIoT SIPOC telemetry pipeline (edge WASM actors → WGSL Process → hash-chained ledger) under
an adversarial campaign (extreme latency, cache desyncs, dropped packets); verify `/Brepro`; finalize the deployment.
Working rules from the project: deliver through a PR; no tag or release without the operator's confirmation; the
agent opens PRs and never merges.

### State: RELEASED (PRs #3 and #4 merged into main, 1afdec0; `v1.0.1-stable-release` published from it on 2026-10-08; PR #5 open with the self-heal workflow's first-run fixes)

**Part 1, the verification step (`tools/verify/fvps.sh`, modes all|kani|smt|wasm|ir).** Wired into
build-release.yml before the bake (smt, wasm, ir: a failed proof refuses the bake) and into the new `ci.yml`
(jobs `page`, `rust`, `fvps`; the repository had no CI on pull requests or pushes to main at all before this, only
the release bake). What exists and what it proves:
- Kani 0.68 (CBMC 6.11) harnesses, `cfg(kani)` only, run with `-Z stubbing`:
  `crimson_noir_os/crates/noir_core/src/verify.rs` (6 harnesses over a symbolic matrix at the smallest validated
  dims, every knob symbolic: an agent's tick isolated to its own row/weights/memory block and on the floor, flush
  zeroes one row, relaxation and bitonic passes in bounds, the masks' meaning, compare-exchange) and
  `native/routing/src/verify.rs` (8 harnesses: arena setter, check on any arena, no track refused-not-trapped, the
  projection, pose on one and two pieces, next stop and speed limit, project_onto). Transcendentals, the Bézier
  point, offsets, the fold and `eval_piece` are stubbed to "any f64" (sound: never an index; the parity tests hold
  the values). Lessons: fill loops over symbolic arrays fail the unwinding assertion, use `kani::any::<[T; N]>()`;
  CBMC's NaN checks fire on any float arithmetic over symbolic words, so float-only functions must be stubbed; a
  standard runner of a private repository has 7 GB and 2 cores, so a harness must peak well under that (measure
  with `ps -o rss= -C cbmc` while it runs, one at a time); a count a loop runs to that is only assumed
  (`kani::assume(words[T_PIECES] == 1.0)`) is still symbolic to the unroller, which unrolls the loop to the
  harness's bound behind a guard with every inner loop in each copy, so write such counts into the words
  (`one_piece_words`: 12.5 GB and 21 min became 0.2 GB and 16 s for the same checks); `pkill -f "cargo kani"`
  kills the shell that runs it (`pkill -x cbmc`). Results (every harness proved, `sh tools/verify/fvps.sh kani`,
  times on a 4-core container): core masks 5 s, compare_exchange 5 s, bitonic 1 s, flush 156 s, relax (8x8 floor)
  49 s, agent_tick (8x8 floor) 473 s at a 5.5 GB peak (284 s on the runner); routing arena_setter under a minute,
  no-track refused 153 s,
  no-track refused by the projection 10 s, check on any arena 117 s, pose on one piece 280 s, pose on two pieces
  389 s, next stop and speed limit 609 s, projection on a short piece 16 s. Six harnesses were re-bounded after a
  run could not finish them: the relaxation at 32x32, the bitonic permutation by sums, the arena check over two
  pieces' words and the projection with the refinement inlined (locally); then the agent tick at 32x32 (1,086 s
  here, killed with the runner 8 minutes in) and the projection with its counts assumed (killed 2 minutes in; 12.5
  GB here before it was stopped), found by the first run on main. The routing harnesses run with
  `--no-overflow-checks` (a NaN is a value, not a trap). ci.yml runs them as a `kani` matrix of six groups on
  parallel runners (90 min each, with 8 GB of swap added beside the runner's memory); the fast `fvps` job runs smt,
  ir, wasm.
- Z3 theorems (`tools/verify/fvps_smt.py`, 15 s): index arithmetic over 32-bit words and IEEE doubles for every
  validated dimension, each with a vacuity check and a self-check that a wrong theorem is refused. All proved.
- `tools/verify/wasm_airgap.py`: 0 imports, 1 exported memory, no start, no exported table, the exact export sets
  (routing 8, kv-pager 14), both rebuilt modules byte-equal to the committed ones. Its first CI run found the
  committed kv-pager module carried `/home/user/.../native/kv-pager/src/02_page_table.rs` (the path dependency's
  panic location), so a rebuild elsewhere differed by 32 bytes: build-wasm.mjs and fvps.sh now build with
  `--remap-path-prefix=<checkout>=/crimson-noir`, the module was regenerated (53,133 bytes, dcbcaaf3…), and a
  rebuild from another directory gives the same bytes. Passes.
- IR: `cargo rustc --emit=llvm-ir` on the routing crate (21 functions, 18 external declarations, 36 trap sites);
  only LLVM intrinsics, the four libm symbols and core's panic entry points may be declared. The system `opt` (LLVM
  18) cannot parse rustc's IR, so the step scans the declarations rather than running a pass.
- Honest limits: floats are held by parity tests, not proofs; `fmod` has no exact SMT model; the Kani dims are the
  smallest validated ones (the theorems quantify over every dimension); nothing here is a proof of the whole program.
- `/Brepro`: `crimson_noir_os/.cargo/config.toml` passes it to lld-link for the UEFI target. Verified here: two
  clean builds of crimson_boot.efi are byte-identical (SHA-256 a476ee01…), the PE TimeDateStamp is the hash
  0xe9cd5aa1, not a time. It is an lld-link (PE) flag: the Linux runtime binary is not covered by it (nor shipped).

**Part 2, the self-healing loop (`.github/workflows/selfheal.yml`, `tools/selfheal/`).** `workflow_run` on a failed
ci or build-release run (never on a `selfheal-*` head): builds `Dockerfile.sandbox` (rust 1.97 + node 22 + mesa +
z3; Kani optional) and runs `agent.mjs --checks <the failed jobs' checks> --max-attempts 3 --push`. The agent: copies
the tree, re-runs the failed checks with `--network none` to isolate (`failures.mjs` parses node:test, cargo test,
tsc, oxlint, Kani), maps each failure to a declaration (`ast.mjs`: the TypeScript compiler API; brace matching for
Rust), asks the planner (`planner.mjs`: built-in remedies for a stale committed wasm module or seal, then Claude
through `@anthropic-ai/sdk` with a JSON-schema output of patches limited to the shown loci, at most 3 model calls),
applies, re-runs the failed checks then every check in a fresh container, dampens on an identical failure signature
or a refused patch, and on success pushes `selfheal-<run>-<sha7>` and opens a PR with `gh pr create` (Before/After,
the failures, the map, every attempt, the diff) and dispatches ci.yml on it. It cannot merge (no permission; the
workflow documents the "Allow GitHub Actions to create and approve pull requests" setting it needs). 16 tests in
`selfheal.test.mjs`, including an end-to-end fixture healed in the host sandbox. Not exercised: a real run on
GitHub (needs a failure on main or a dispatch; `ANTHROPIC_API_KEY` is not set as a secret, so only the built-in
remedies would run there).

**Part 3, telemetry.** `src/10_Network/telemetry.ts` (frames of 8 words, FNV-1a+mix32 digest, chain fold, Ledger
with digest/stale/window refusals and a per-node SHA-256 chain, EdgeNode with at-least-once resends and desync
detection; 7 tests), `telemetry.fuzz.test.ts` (64 edge actors sampling poses from the WASM routing core over the car
rings; 10 seeded campaigns plus the worst link: 200 ticks of latency, 50 % drops, 50 % duplicates, 34 % fog cache
desyncs; the ledger equals the clean run's, verifies, refused every desync; the window burst; a corrupt edge cache
refused forever), `crimson_noir_os/src/telemetry.rs` + `shaders/telemetry.wgsl` + `gpu::digests` (GPU == CPU on
lavapipe for 1..4097 frames, pinned VECTORS 0xf8da9ded, 0x0543e119, 0x525f35c4, chain 0xdeb20183; in the no-branch
and naga validation lists).

**Verified before the merge (locally, and on CI for the page, Rust and fast proof jobs):** tsc, oxlint, `npm test`
1,312 tests (1,301 pass, 11 skipped), build, `smoke`, the 16 self-heal tests, `cargo test --workspace` (incl. the
GPU parity on lavapipe with NOIR_REQUIRE_GPU=1 and the selftest's telemetry step), clippy on every target, the
native tests, fvps smt/ir/wasm, every Kani harness (above), two clean UEFI builds byte-identical. The first CI runs
found and fixed five things the local runs had not: the runner's `pip install z3-solver` lands in the user site
that `python3 -I` ignores; the committed kv-pager module embedded this checkout's path; `airgap.test.ts` had no
allowlist entry for telemetry.ts; `replication.node.test.ts`'s mirror test raced the host's 1 Hz snapshot on a
loaded runner (now tolerated); and the first run on main (ff8dc5d) lost the `kani (core-tick)` and `kani
(routing-projection)` jobs to the runner's shutdown signal (exit 143: the checker outgrew the private-repository
runner's 7 GB), fixed in PR #4 by the two re-bounded harnesses above and the swap step. Three routing-crate clippy
lints on the current toolchain were fixed (the module regenerated, same size, new bytes).

**Release (2026-10-08, the operator's "grand opening" directive).** The directive named the tag
`v1.0.0-stable-release`, which already existed: it was published on 2026-10-07 at 16:22 UTC from 0f68d95 (PR #1's
merge, before Phase 18), and build-release.yml bakes an existing tag's commit, so that dispatch (run 37705701478)
stopped at the proof step with "cannot open tools/verify/fvps.sh" (the commit predates tools/verify). The operator
chose a new tag over moving the published one. build-release.yml run 37817355201 on main (1afdec0) made
`v1.0.1-stable-release` ("Crimson Noir OS v1.0.1 Stable Release", notes "Production ISO Release. Formally Verified
via SMT/Kani.") in 7 minutes: proofs (smt, wasm, ir) passed, the core and hosted-runtime tests passed, the bake and a
second clean bake gave the same bytes, QEMU booted the disk image through SELFTEST PASS, TUTORIAL 6 PASSED, TERMINAL
READY, the scripted `golden` run (MATCH, fingerprint 0x83765bab) and POWER OFF (85.8 s), and the ISO to SELFTEST
PASS. Published: https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.1-stable-release
with crimson_noir_os.img (37,748,736 bytes, 8b6662d7…), crimson_noir_os.iso (36,036,608 bytes, a37aed33…),
BOOTX64.EFI (220,672 bytes, 32264e78…), containment.nix, containment.lock, NOTICE.txt, the two licences and
SHA256SUMS. The `v1.0.0-stable-release` and `stable-beta` releases are unchanged (pre-Phase-18 media).
- The TimeDateStamp question. The directive expected the EFI's PE TimeDateStamp to be 0xe9cd5aa1; the published
  BOOTX64.EFI's is 0xefa3b9b5. 0xe9cd5aa1 is the stamp of this container's build of the same commit with the same
  rustc 1.97.0. The two files differ in exactly 20 bytes: the COFF TimeDateStamp, the two debug-directory
  timestamps and the first 8 bytes of the CodeView GUID; every byte of code and data is the same. Cause, read from
  the linker: rustc links with `/DEBUG /PDBALTPATH:%_PDB% /Brepro`, so lld writes a PDB sidecar first (it embeds
  the absolute paths of the object file, the working directory and rust-lld: `/home/user/...` here,
  `/home/runner/work/...` on the runner), derives the GUID from the PDB and only then hashes the executable, GUID
  included, for the timestamp. So the stamp is stable on one host (the dual bake passes) but not across hosts.
  Fixed after the release, for the next one (it changes the media's bytes): `.cargo/config.toml` now passes
  `/DEBUG:NONE` after rustc's own `/DEBUG` (lld takes the last), so no PDB is written, the image carries no
  CodeView record, and the stamp is a hash of the code alone. Checked here: the same commit built in two
  directories gives the same bytes (220,672, SHA-256 55d0af9a…, TimeDateStamp 0x245203b6), where before the fix
  the two directories gave two stamps. `strip = "debuginfo"` in the release profile does not do it: cargo passes
  `-C strip=debuginfo`, but rustc 1.97 still links with `/DEBUG` and the PDB is still written. The published
  v1.0.0 EFI's 0x6ac6715a is a real build time (2026-10-07 16:20:42 UTC): that commit had no /Brepro.
- The self-healing workflow's first real runs (on the first CI run of main and on the failed bake) never reached
  the agent; PR #5 fixes what they found: `docker build -f tools/selfheal/Dockerfile.sandbox .` took the root
  `.dockerignore`, the host image's allowlist, so the sandbox could not copy the OS crates (now
  `Dockerfile.sandbox.dockerignore` beside the Dockerfile); the container's root-owned files in the mounted copy made
  the agent's `rmSync` throw EACCES and end the run (a container of the same image now empties the copy first, and a
  copy that still cannot be removed is logged and left); `tools/verify/__pycache__` was tracked. A dispatched heal
  on the branch (checks `fvps-smt`, planner `claude`) now runs end to end: the image builds, the agent isolates the
  check in the sandbox, finds nothing to heal on a healthy tree and exits 3 (run 37817635304). The `ANTHROPIC_API_KEY`
  secret reached the agent's environment (seen by name only). Still unverified: "Allow GitHub Actions to create and
  approve pull requests", which only a heal that pushes a patch exercises; the agent's log says so if the pull
  request cannot be opened.

**Not done / the operator's call:** the next release (any new tag dispatched to build-release.yml) carries the
host-independent stamp; nothing else is open.
**Not done / the operator's call:** merge PR #5; decide on `strip = "debuginfo"` for a host-independent stamp
in the next release.

## Phase 17 (planned 2026-10-07, done 2026-10-08): standing verification, the release's loose ends

The plan (`/mnt/project-files/plans/phase-17-plan.md` in the project) had six items. Phase 18 covered 17.1 (CI on
every pull request and push: ci.yml) and 17.2 (a reproducible release re-cut: `v1.0.1-stable-release`). Done here:

- **17.5 Per-client limits behind the proxy.** `HostOptions.trustProxy` / `NET_TRUST_PROXY=1`: the failure throttle
  keys on the last `X-Forwarded-For` entry when it is an IP literal (`forwardedFor`, replication.node.ts), else on
  the socket's address; a host that trusts no proxy ignores the header, so a direct client cannot buy budgets by
  inventing addresses. `deploy/docker-compose.yml` sets it (only the proxy can reach the host there; nginx.conf
  writes exactly `$remote_addr`). Test in replication.node.test.ts (both hosts, the fallback, a balancer's entry, a
  good token from a throttled client). deploy/README.md "Limits to know" updated.
- **17.6 Nightly fuzz.** `.github/workflows/fuzz.yml` runs the `*.fuzz.test.ts` suites nightly (03:17 UTC) and on
  dispatch with `FUZZ_SCALE` (20) and `FUZZ_SEED` (the run number), both read once by property.ts `FUZZ`; a failure
  prints the `{ seed, runs }` that replay it with no knob set. Scale 3 with a seed offset passed here (54 suites).

Verified: tsc, oxlint, `npm test` 1,302/1,302, smoke:net, `docker compose config`.

**17.3 (done, Julian's decision on 2026-10-08):** the terminal is the Crimson Terminal (code, tests, README; the
screenshot predates it). **Still the operator's call (17.4):** settling the product name; the real-target checks (a physical UEFI boot, a real Let's Encrypt issuance, publish.ps1 under Windows
PowerShell 5.1, a room from two browser tabs, `?players=4` on a real GPU); branch protection on main requiring ci.yml.

## Phase 19 (operator directive, 2026-10-08): the commercial release overhaul, and `v1.1.0-stable-release`

Three tracks from the operator's four-part directive, each on its own branch and PR, all merged by the operator on
2026-10-08 (ci.yml green on the merge commit 2ad02e1, run 37861920678, the six Kani groups included):

- **Data-oriented SIMD core (PR #12).** The swarm's tick runs four agents a SSE2 register (`lanes.rs`,
  `kernels::tick_lanes`; plain lane loops on the UEFI target, built with SSE off), held bit for bit to the unchanged
  scalar `agent_tick` that the Kani harnesses prove, with a fuzz test over adversarial matrices comparing every word.
  The KV page table and the drivers' hazard machine are structure-of-arrays tables; the pager's WebAssembly module is
  rebuilt. Fingerprint 0x83765bab unchanged. 4,096 agents: 3,799 ticks/s scalar, 4,537 in lanes (1.19x; bound by the
  routing-field gathers). `tools/stabilize` ran every suite ten rounds on fresh seeds: 80 of 80 green, posterior pass
  0.917 a suite, Wilson 95% lower bound 0.722 (`docs/stabilization/progress.json`). Not converted: `crowd.wgsl`'s
  branches (no reference test), the page's object wrappers. No proof covers the SIMD kernel beyond the fuzz.
- **Zero-trust self-heal sandbox (PR #10).** The sandbox mounts nothing of the host (tar stream onto a
  noexec/nosuid/nodev tmpfs, read-only root, unprivileged, every capability dropped, loopback-only netns, an
  environment allowlist refusing credential-shaped names). The `sandbox` CI job runs the escape probes contained (all
  denied) and in a weakened control (the named ones escape) and keeps the evidence as an artifact. The kernel's
  namespace, seccomp and mount-flag semantics are argued, not proved.
- **Dual licensing and brand (PRs #9 and #11).** Proprietary core (Copyright (c) 2026 Julian Cassius Subban. All
  Rights Reserved.) on src/, crimson_noir_os/, native/, world/, brand/, the page entry and build; MIT on tools/,
  deploy/, .github/, docs/, Dockerfile, publish.ps1; a header on every source file and a CI check for it. Releases
  up to v1.0.1 stay MIT OR Apache-2.0. The ORC grant on the mechanics is unchanged (counsel still to review the
  combination). brand/tokens.json, four SVG marks, STYLE.md, preview.html, the page's token stylesheet.

Before them on main since v1.0.1: PR #6 (the EFI stamp is the commit's alone: `/DEBUG:NONE` in `.cargo/config.toml`),
PR #7 (Phase 17.5 and 17.6: per-client throttles behind the proxy, nightly fuzz), PR #8 (17.3: the Crimson Terminal).

**Release (2026-10-09, the operator's "go, fill in the blanks").** build-release.yml run 37863601029, dispatched on
main (2ad02e1) with the new tag `v1.1.0-stable-release` (a minor bump: new licence terms and a rewritten core), title
"Crimson Noir OS v1.1.0 Stable Release", notes written from the merged PR bodies. Five minutes: proofs (smt, wasm,
ir) passed, the core and hosted-runtime tests passed, the second clean bake gave the same bytes, QEMU booted the disk
image through SELFTEST PASS (4.8 s), TUTORIAL 6 PASSED (71.3 s), TERMINAL READY, golden MATCH (0x83765bab) and POWER
OFF (76.4 s), and the ISO to SELFTEST PASS (5.0 s). Published:
https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/v1.1.0-stable-release with 8 files:
crimson_noir_os.img (37,748,736 bytes, 170db152…), crimson_noir_os.iso (36,036,608 bytes, 6e3fd44b…), BOOTX64.EFI
(233,984 bytes, 74bbd347…), containment.nix, containment.lock, NOTICE.txt, LICENSE (one proprietary licence where
v1.0.1 shipped LICENSE-MIT and LICENSE-APACHE) and SHA256SUMS.
- The stamp is the commit's. The published BOOTX64.EFI's PE TimeDateStamp is 0x095d3559. The same commit built in
  this container (rustup 1.97.0, `cargo build --locked -p crimson_boot --target x86_64-unknown-uefi --release`) gives
  the identical 233,984 bytes, SHA-256 74bbd347…: PR #6's `/DEBUG:NONE` holds across hosts, which v1.0.1's stamp
  (0xefa3b9b5 on the runner, 0xe9cd5aa1 here) did not. The value differs from PR #6's 0x245203b6 because PR #12
  changed the code the hash covers.
- Earlier releases are unchanged: `v1.0.1-stable-release` (Phase 18 media, the per-host stamp), `v1.0.0-stable-release`
  and `stable-beta` (pre-Phase-18 media).

**Still the operator's call:** Phase 17.4's real-target checks (a physical UEFI boot of this release's image, a real
Let's Encrypt issuance, publish.ps1 under Windows PowerShell 5.1, a room from two browser tabs); branch protection on
main requiring ci.yml; counsel on the ORC grant beside the proprietary core; the OS README's terminal screenshot
(still the pre-rename header until reshot from a real boot).
