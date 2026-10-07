# Agent handoff state

Written under the operator's Phase 13 protocol ("if you approach limits, write your exact execution state … into
`agent_handoff_state.md`"). It is the bridge for the next agent: read it first, then continue from **Next steps**.

## Where things stand (updated as work lands)

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

State (updated as work lands):
- `gh` has no valid token in this session (GH_TOKEN is rejected), so GitHub work goes through the GitHub MCP tools.
  Those can open and merge PRs and dispatch workflows, but have no release-creation call. So the release workflow was
  extended: a dispatch for a tag that does not exist bakes the dispatched commit and makes the tag as part of the
  release (`gh release create --target`), with optional `title` and `notes` inputs; an existing release keeps its
  title and hand-written notes (the media's description sits under a marker). Releases will be cut by dispatching
  the workflow on `main` after the merge.
- DONE: `deploy/compose.yaml` renamed to `deploy/docker-compose.yml` (all references updated); `deploy/deploy-live.sh`
  written and run three times here (self-signed; Let's Encrypt with a stand-in certbot, incl. the renewal hook; an
  idempotent re-run). It found and fixed one bug on first run: a 0700 `tls/` directory is 0700 inside the container
  too, so nginx (uid 101) could not read the world-readable certificate; mounted dirs are 0755, the parent is 0700.
- RUNNING: the audit workflow (8 attackers: nginx, container, rust-kernels, wasm, ledger-wire, tokens-seals,
  airgap-csp, memory-determinism; a skeptic per attacker). Attackers leave new test files at assigned paths:
  crates/noir_core/tests/{kernels_fuzz,term_fuzz,determinism}.rs, src/06_Make_Decisions/routingWasm.bounds.test.ts,
  src/09_Cognition/kvPager.bounds.test.ts, src/10_Network/{hostileHost.node,ledgerProperties,token.fuzz,seal.fuzz,
  churn.node}.test.ts, src/02_Define_The_Rules/airgap.fuzz.test.ts.
- NEXT: integrate the audit (fix confirmed findings, keep passing tests, full suites), commit, PR, merge, dispatch
  the two releases, watch the bakes, final handoff.
