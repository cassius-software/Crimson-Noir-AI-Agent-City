# Agent City v1.0 Stable Beta: architecture blueprint

Status: **blueprint of the beta as built**, at version 1.4.0-beta.1 (commits `26ba78b` to `bad4507`, 2026-10-01,
branch `claude/quirky-faraday-xkpdln`). It records what the operator's directive for Phases 7 to 10 asked, what was built
for each item, where that logic runs, what is proved and by which test, where the build deviates from the
directive's wording and why, and what is still owed. The README is the product's documentation of the shipped
state; this document is the plan behind it. File paths are relative to `src/` unless they name a tool or a config
file. Test names are quoted as the suites print them, cut with an ellipsis where they run long.

This document was first written while the page-side wirings of 8.1, 8.4, 9.1, 9.2, 10.1 and 10.2 were in progress.
They have since shipped (commits `4b21c0a` to `b535cca`, with the console stage in `83fa306`), each item's closing
paragraph says what landed, and the README describes the shipped state.

## 1. Purpose and scope

### What "Stable Beta" means here

- Every item of the directive (7.1 to 10.2) has a module in the tree, under its causal stage, with a Node test
  suite of its own. `npm test` at `bad4507` runs 1,060 tests and passes all of them (44 s, real Rapier and a real
  WebSocket host included).
- Everything that lives in the physics realm is wired and shipped: cars pass through cars (7.1), the fleet on the
  fixed tracks and the craft stream (7.3), the rally request (8.4) and four avatars under the kernel (10.1). The
  14A core and screen (8.2) and the cognition router (8.3) are wired on the page and in the console, and so is the
  code dissolve (7.2, commit `bd700b8`).
- The page-side wiring of the rest, designed and decided in the completeness critique, has shipped: the
  soundscape's rooms and the captions feed (8.1, 8.4; `4b21c0a`), the ping binding and the rally hand-off (8.4;
  `e61d309`), the render guard and the bare boot (9.2; `e872a6f`), the look attribute and the customizer (9.1;
  `f5765d5`), seats, viewports and listeners (10.1; `65f9b1f`), the network client on the page (10.2; `59acc60`,
  `b535cca`), and every new console knob and command (`83fa306`). What is still owed is named per item: the craft
  renderer (7.3), the voice signalling (10.2), and the browser run on real hardware (Verification).
- "Stable" is a claim about the laws, not the feature count: every law below is pinned by a test and no phase
  loosened one. The one amendment (recruitment can point a recruit at a sidewalk spot) is named here and in the
  README (Pings and the rally).

### The dual track

The directive's Phase 9 names two front ends. The beta treats them as two ways in to one realm:

- **Track A, the photorealistic GUI.** The WebGPU page: the city, the crowd, the cinema camera, the HUD, first
  person on foot or at the wheel. Phases 7.2, 8.1, 8.4 (captions, the ping marker), 9.1 and 10.1 are Track A work.
- **Track B, the Ring-0 terminal.** The console at `~`: air-gapped from the engine, a frozen `TerminalBridge`, the
  operator tier behind `operator unlock`. Phase 9.2 gives it a language of its own (R0, `terminal/repl.ts`), a
  `render off` guard and a `?boot=tty` shell with no engine at all. Phases 8.2, 8.3 and 10.2 reach the product only
  through this track (`ask provider`, `net join`).

Both tracks talk to the physics worker through the same door (`simHost.ts`) with the same plain numbers. Neither
can reach a body, a pedestrian, a law or the audit.

### The product laws every phase had to keep

| Law | Where it is pinned | What this beta did to it |
|---|---|---|
| **One offline file.** `dist/index.html` holds everything; no `public/`; the build fails if a licence is missing or the version differs from `BRAND.version` | `vite.config.ts`, `compliance.test.ts` | Unchanged. The network host `10_Network/replication.node.ts` is Node-only: `tsconfig.app.json` excludes `src/**/*.node.ts`, `tsconfig.node.json` includes it, and `airgap.test.ts` proves no runtime source imports it. Two opt-in clients may address a server off this machine, `09_Cognition/claudeApi.ts` and `10_Network/netClient.ts`, and `airgap.test.ts` names exactly those two |
| **The Ring-0 kernel and audit.** Three laws rank every vehicle command; the audit runs in the worker after every step, before any state leaves | `02_Define_The_Rules/laws.ts`, `ring0.ts`, `laws.test.ts`, `ring0.test.ts` | `laws.ts` untouched. `ring0.ts` gained only the craft check (`CRAFT`, `auditCraft`, the `OFF_CORRIDOR` code), halt-only, frozen like the rest. The audit invariants now hold per avatar (`simPlayers.test.ts`) |
| **The physics worker's door.** One `init`, then step requests; every number clamped; anything else refused and counted | `simHost.ts`, `simCore.test.ts` | The door learnt four fields and sanitises each: `tracks` to a plain boolean (`=== true`), `spawns` to at most three finite pairs or an init error, `players` to a list sliced to three with a malformed entry read as an idle player, and the craft buffer handed back only at the exact size |
| **The console air gap.** `terminal/*` imports only types from the engine; the bridge is frozen; the knob set is pinned | `terminal/commands.test.ts`, `operator.test.ts` | R0 (`terminal/repl.ts`) has no import line at all; `commands.test.ts` lists it among the terminal sources it scans. Every new knob (`ping`, `captions`, `look`, `render`, `r0`, `net`) must enter the pinned sets in the same commit as its handler |
| **14A.** No violence anywhere; business-casual conduct | `02_Define_The_Rules/civic.ts` (`violence: false`), `conduct.ts`, `collision.ts` (`COLLISION`), `compliance.test.ts` | The conduct core and screen are new law (8.2), applied to every prompt, every `say` line, every network name and chat line. `COLLISION` states the physics contract beside `CIVIC` |
| **Fictional names.** No real place, landmark or street of the region in anything the product shows; no scrubbed brand | `compliance.test.ts` (`REAL_PLACES`, `SCRUBBED`), `region/names.ts` | Unchanged. Every caption string and every ping line is swept by the same patterns (`captions.test.ts`, `ping.test.ts`) |
| **Causal-order stages with the two-question header.** Imports point downward only; every file opens with "Why does this file exist? / What breaks if it is removed?" | README Layout; the verifiers read every new header | The dissolve's shader helper sits at stage 01 so `world.ts` may import it; the craft floors are duplicated in stage 02 (`ring0.ts CRAFT`) because 02 imports nothing above it, and `ring0.test.ts` pins them equal to the stage-06 values |
| **Node-tested pure modules.** Logic lives in modules `node --test` can run; the engine only wires them | `package.json` `test` | Every item was built pure half first (Group A of the critique), with its suite, before any engine edit |

## 2. The architecture at a glance

| Stage | Added or changed in this beta | Role in the beta |
|---|---|---|
| 01_Initialize_World | `codeDissolve.ts` (+ test); `world.ts` gives the props a `dissolve` attribute | The TSL helper that dissolves any `MeshStandardNodeMaterial` into falling green binary code (7.2) |
| 02_Define_The_Rules | `collision.ts`, `conduct.ts` (+ tests); `ring0.ts` gains `CRAFT`, `auditCraft`, `OFF_CORRIDOR` | The contact policy and group bits (7.1); the 14A core and screen (8.2); the craft corridor check (7.3) |
| 03_Spawn_Agents | `look.ts` (+ test); `skills.ts` gains `RALLY_RANGE`, `whyNotRally` (`skillsRally.test.ts`); `crowd.ts` carries `crowd.dissolve` | The business-casual wardrobe and the packed look word (9.1); the rally rule both realms share (8.4); the crowd's dissolve amounts (7.2) |
| 04_Connect_Hardware | `seats.ts` (+ test) | The seating plan for four local players and the per-seat pad intent (10.1) |
| 05_Observe_Environment | `telemetry.ts` gains the optional `output.dissolve`, `output.pings`, `output.rendering`, `output.players`, `output.net` and `customer.captions`; `lookStore.ts` | The snapshot fields the wirings added, all optional; the player's look kept under its own key (9.1) |
| 06_Make_Decisions | `tracks.ts`, `trackDriver.ts` (+ tests); `traffic.ts` gains `DriverLike`, `HazardEpisode` | The fixed track network and its follower (7.3); the hazard episode shared by both drivers |
| 07_Execute_Actions | `trackFleet.ts`, `dissolve.ts`, `acoustics.ts`, `captions.ts`, `controls.ts`, `viewports.ts`, `terminal/repl.ts` (+ tests); `contact.ts` gains the identity scans; `head.ts` gains `aimRay`; `simProtocol.ts`, `simCore.ts`, `simHost.ts`, `simClient.ts` carry `tracks`, the craft stream, `spawns`, `players`, `rally`; `vehicles.ts` carries the groups, the network and `setPeople`; `engine.ts` passes `tracks`, forwards `rally` and runs the dissolve; `fleetView.ts` carries the cars' amounts; `vehiclePassThrough.test.ts`, `simPlayers.test.ts`, `dissolveWiring.test.ts` | The scheduled craft (7.3); the dissolve's amounts (7.2); room acoustics (8.1); the caption track (8.4); per-seat controls and split-screen arithmetic (10.1); R0 (9.2); the realm's four avatars and the rally (10.1, 8.4) |
| 08_Swarm | `ping.ts` (+ test); `recruitment.ts` gains `Recruiter.rally` | The pick, the ping board and the rally plan (8.4) |
| 09_Cognition | `claudeApi.ts`, `router.ts` (+ tests); `localCompute.ts` opens every prompt with the core | The hot-swap router and the Claude provider (8.3) |
| 10_Network | `replication.ts`, `replication.node.ts`, `netClient.ts`, `airgap.test.ts`, `netClient.test.ts`; `package.json` `serve:net`; the tsconfig split; on the page, `07_Execute_Actions/netView.ts` and the `NetHost` seam in `engine.ts` | The replication scaffold: protocol core, Node host, opt-in page client, the ghosts it draws (10.2) |

## 3. The phase items

### 7.1 Non-violent physics: no ragdoll, no combat, no vehicle-on-vehicle contact

**What the directive asked.** "Disable ragdoll/combat/vehicle-on-vehicle collision meshes."

**What was built.** `02_Define_The_Rules/collision.ts` is the realm's physics contract in one frozen record,
`COLLISION`: `vehicleOnVehicle: false`, `ragdoll: false`, `combat: false`, `furniture: 'sensor'`,
`peopleAndCars: 'sanctuary'`. The module is pure (no Rapier import) and also holds the group bit table `GROUP`
(`query`, `vehicle`, a reserved `ragdoll` bit matching `ragdollRig.ts`), Rapier's packing `interactionGroups`, and
the two constants the fleet uses: `VEHICLE_CHASSIS_GROUPS` (a chassis belongs to `vehicle` and filters `vehicle`
out) and `WHEEL_RAY_GROUPS` (a wheel ray is a `query` that filters `vehicle` out). In `07_Execute_Actions/vehicles.ts`
every chassis collider is created with `VEHICLE_CHASSIS_GROUPS` (`Fleet.#create`) and every wheel ray is cast with
`WHEEL_RAY_GROUPS` (`updateVehicle(h, NOT_PEOPLE, WHEEL_RAY_GROUPS)`). This runs in the physics worker. The ragdoll
stays what it was: scaffolding in `ragdoll.ts` and `ragdollRig.ts` that nothing imports. There is no combat module
to disable; `combat: false` is policy wording.

**Guarantees, and the tests that prove them.** `vehiclePassThrough.test.ts` (real Rapier in Node): "a rolling car
passes through a parked car on its line as over open ground: no contact, no speed change, the parked car unmoved"
(same line within 0.05 m, same speed within 0.05 m/s, the parked car moves under 1 mm), "the wheel rays never lift a
car onto the car it passes through" (never more than 0.02 m), "a wall still stops a car, and the ground still carries
the wheels at ride height", "the avatar still stops at a parked car's face", "every chassis carries the collision
groups collision.ts derives; the wheel rays accept theirs". `collision.test.ts` (pure) is the structural guard: "the
ragdoll stays unwired: no runtime file outside its two sources imports or names it", "a vehicle is not a cause the
ragdoll accepts", "the group arithmetic: Rapier packing, the reserved ragdoll bit read from ragdollRig.ts, disjoint
bits". The Sanctuary's engine-order test in `sanctuary.test.ts` is the people-and-cars regression and still passes.

**Deliberate deviations.** Contact is disabled with collision groups, not by removing meshes. The chassis collider
stays: CCD stays on, the body and collider counts are unchanged, ghost view still draws it, the avatar still stops at
a parked car, the Sanctuary's Solid-to-Sensor flip still decides people-and-cars, and the AI's bonnet rays keep the
default groups so other cars stay obstacles to the Third Law. The kernel is built on cars being solid to people and
to the world; only the car-to-car pair is dropped, in the broad phase. The `ragdoll` key in `COLLISION` is the one
runtime file allowed to name the word, and `collision.test.ts` exempts exactly that file.

**Shipped.** Fully; the README's Vehicles and Ghost-mode collision sections say so. Two cars overlapping at a corner
apex dissolve one another (7.2, `carsOverlapping`), so the overlap is never seen.

### 7.2 The code dissolve

**What the directive asked.** "A WebGPU shader that dissolves an intersected agent/vehicle/prop mesh into falling
green binary code and reinstantiates it when clear."

**What was built.** Two halves. `01_Initialize_World/codeDissolve.ts` is the render half: `applyCodeDissolve(material,
amount, origin, colour)` wraps any `MeshStandardNodeMaterial` once. A per-instance `amount` (0 solid, 1 gone) drops
the mesh's screen cells top-down in falling columns; cells still standing keep their shading dimmed by `1 − amount`
and glow with glyph ink in the green of what was met; at `CODE_DISSOLVE.fold` every vertex folds to `origin` so
nothing is rasterised; the mask it sets also governs the shadow pass, so a dissolved mesh drops its shadow. The
alphabet is two glyphs, a `0` and a `1`, drawn from strokes (`BINARY_GLYPHS`), no font. `07_Execute_Actions/dissolve.ts`
is the page half: `DissolveSet` keeps one amount per instance of each mesh kind (`lamps`, `trees`, `signals`,
`cars`, `people`), `touch` sets a slot to 1 the same frame, `update` lets untouched slots fall to exactly 0 over
`DISSOLVE.release` (0.35 s), `DissolveBuffer` tracks the dirty range to upload, and `poleSlot` maps a pole's index to
its mesh. The identities come from new, allocation-free scans in `contact.ts` (`PoleIndex.within`, `withinBox`,
`peopleWithin`, `peopleWithinBox`, `carsWithin`), the same collider shapes the contact wipe and ghost view use, grown
by `DISSOLVE.reach` (0.25 m) so a mesh is gone before the near plane clips it. Everything runs on the page and is
view-only: nothing reaches the physics realm, no pedestrian moves, no pole stops anyone.

**Guarantees, and the tests that prove them.** `codeDissolve.test.ts`: "builds without a renderer on a bare material
and returns it ...", "an existing mask is kept and ANDed; an existing position node is kept under the fold;
positionPrevious folds only with motion vectors", "the look: an alphabet of exactly two glyphs, a 0 and a 1 ...".
`dissolve.test.ts`: "the envelope: at 1 the frame it is touched, down to exactly 0 over release, held while touched",
"count: once per passage ...", "buffers: only the touched slots are written, the dirty range covers exactly them,
clean() clears it", and each scan checked against a brute force over the real city for thousands of probes
("PoleIndex.within ...", "peopleWithin: every body the disc is inside, never row 0, never a hidden row ...",
"carsWithin: every car whose footprint holds the disc; the driven car is skipped ..."). `contact.test.ts`'s pinned
signatures are unchanged; the scans are additions.

**Deliberate deviations.** The dissolve is per mesh, in the mesh's own material, not a post pass: while nothing
dissolves the materials draw exactly as before and the cinema camera's velocity buffer is untouched. The driven car
never dissolves (its cabin shell is drawn from inside by design) and buildings never do (walls stop you). The shadow
drops through the material's mask, not through a discard in the colour node, because only the mask runs in three's
shadow pass. The helper lives at stage 01 because `world.ts` (stage 01) must import it and imports point downward
only. A tree's collider is its trunk, so on foot only the trunk triggers its dissolve.

**Shipped.** The pure halves, and (after this document was first written) the page wiring, in commit `bd700b8`: a
`dissolve` instanced attribute on the lamp, tree and signal geometries in `world.ts` and on the body and wheel
geometries in `fleetView.ts` (the cabin mask kept), a `crowd.dissolve` storage attribute in `crowd.ts` read in
`posed()`; the people gathered in `Engine.received()` before the crowd upload, poles, cars (on foot only) and people
touched in `frame()` right after the contact pulse, untouched slots falling back on the wall clock, the amounts
flushed in `present()` before the render, and `output.dissolve` in the snapshot. Two cars passing through each other
(7.1) both dissolve, found from their poses alone (`carsOverlapping`), which answers 7.1's open question.
`dissolveWiring.test.ts` pins it: "the props: a dissolve attribute on each of the three prop geometries, the helper on
each material, never on the buildings", "the fleet: a dissolve amount per body slot and four per car for the wheels,
the cabin mask kept under the dissolve", "the crowd: one amount per agent in a storage attribute named
crowd.dissolve, read by every body material", "wiring: the people are gathered before the upload, the touches follow
the contact pulse, the flush precedes the render, the snapshot reports it", "the envelope end to end: a touched car
and its wheels flush once, fall back, and the set is clean after". **Not verified here:** the compiled WGSL look
(fold, cells, glyphs, shadow drop) needs a WebGPU browser (see Verification).

### 7.3 Safe vehicular routing on fixed tracks

**What the directive asked.** "Safe vehicular routing for cars, drones, planes, trains on fixed spline tracks
guaranteeing zero traffic jams."

**What was built.** Three parts, all in the physics worker.

- **The network** (`06_Make_Decisions/tracks.ts`, pure, computed from the seed and the city grid). Cars get the 64
  boundary loops of the 2 × 2-block cells, each driven clockwise on the right-hand lane with right turns only on the
  Driver's own corner curve; every (segment, direction) belongs to exactly one ring, so no two rings share a point
  (they stay 4 m apart) and nobody crosses an oncoming lane. A ring has a stop line at every intersection it passes
  and holds at red before a right turn. Trains get one elevated loop on a deck 9 m over the median of two arterial
  streets, with 15 m corners, four mid-block stations and a timetable; drones fly the 4 × 4-block face rings at 40 m
  clockwise and 46 m counter-clockwise; planes fly one racetrack at 400 m. Every track has an arc-length parameter
  (`poseAt`, `projectOnto`, `nextStop`, `speedLimitAt`), cars are seated in headway slots (`assignSlots`, 12.6 m), and
  `roomToClear` is the don't-block-the-box rule.
- **The follower** (`06_Make_Decisions/trackDriver.ts`). `TrackDriver implements DriverLike`: it projects its pose onto
  its ring each frame and drives the ring's own curve, with the street driver's hold-at-red, following rule, throttle
  gate, hazard episode (`HazardEpisode`, now its own class in `traffic.ts`, shared not copied) and pure pursuit, plus
  the box hold and a rejoin when set down off its ring. `vehicles.ts` takes `FleetOptions.network`, seats the cars,
  sorts each ring by arc length every frame (`#ringGaps`), feeds each follower `min(filtered rays, ring gap)`, and
  casts a car-on-a-ring's bonnet rays with a predicate that skips every other on-ring chassis while still seeing
  walls, poles and the player's car. `SimInit.tracks` is on by default on the page (`?tracks=0` restores the random
  street-hopping drivers), sanitised at the door, and the network is built inside the worker from the seed.
- **The craft** (`07_Execute_Actions/trackFleet.ts`). Three train sets, 960 drones and three planes are pure
  functions of the realm's own clock (`scheduledPose`): no Rapier body, no driver, no Bouncer ruling. Each step packs
  them into a second plain-number buffer, `TRACK_POSE` (eight floats per craft: position, heading, kind, track, arc
  length, speed), transferred to the page and handed back for reuse like the pose buffer. Before it leaves, the audit
  reads it: `ring0.ts auditCraft` halts the realm on any non-finite value or any craft below its corridor's floor
  (train deck 9 m, drone 40 m, plane 400 m) with a named reason (`Corridor Exploit: ...`). The check only halts, never
  corrects.

**The zero-jam guarantee, as the verifier stated it.** "Zero jams" is an AI-only, per-ring guarantee with containment,
not a promise about the player. With the fleet on tracks (the page default; `?tracks=0` restores random routing)
every AI car is seated on one of 64 fixed right-turn rings that never share a point (rings stay 4 m apart) and
follows it without choosing, merging or crossing an oncoming lane. On a ring carrying at most its capacity (about 15
cars, the most `assignSlots` will ever seat), as proved in `tracks.test.ts` and `trackDriver.test.ts` with the
kinematic model and in `vehicles.test.ts` with real Rapier: no bumper gap falls below 1 m, every throttle passes the
Ring-0 bouncer without a Third-Law ruling, no car enters an intersection on red or crosses a stop line on red, no car
stands in an intersection box through a red (a car holds at the line until its ring has room for it to clear the
box), no speed limit is exceeded, every car laps within the bound and at least one car rounds a corner of every ring
in every 64 s window, including behind a leader that brakes hard at random. What the guarantee does not cover: a ring
stops, and stays stopped, behind anything the laws rank above flow or anything physically in its lane that is not a
track car, i.e. a person in the path (First Law), the player's car driven or parked in the lane, a wall placed on the
road, or an AI car held at a stop line by any of these; and a car set down off its ring steers back at corner speed
without obeying the signals. In every such case containment holds: only the ring that holds the obstacle is delayed,
and every other ring's trajectory is identical to the undisturbed run (INV-4). Trains, drones and planes are
timetabled, interaction-free functions of the realm's clock on corridors that never meet the street, so they can
neither jam nor be jammed; the Ring-0 audit halts the realm if one ever reads below its corridor's floor.

**The tests behind it.** `tracks.test.ts` proves the four invariants with the kinematic car model: "INV-1
separation: car rings never come within 4 m of each other; trains, drones and planes clear every box and the cars",
"INV-2 and INV-3: a ring at capacity keeps every gap, holds every red, never speeds, and every car laps", "INV-2
under an adversarial leader: hard random braking never closes a gap below a metre, and no throttle needs the Third
Law", "INV-4 containment: a stalled car delays only its own ring ...", plus the pin behind the ray predicate, "a
bonnet ray that counted tracked cars would see the cross street's ...". `trackDriver.test.ts` repeats INV-2 to INV-4
with real `TrackDriver`s and adds the rejoin ("a recovered car rejoins its ring: set down 12 m off the track it is
back in its lane inside 15 s, never over corner speed, then drives on"). `vehicles.test.ts` (real Rapier): "a fleet
on tracks spawns in headway seats on the lanes and follows its rings without the First or Third Law", "a fleet on
tracks: the rays of a car on a ring skip the cars on rings, still see a wall and a player's ...", "a fleet on tracks:
a car set down off its ring leaves the ring's ...". `trackFleet.test.ts`: "two hours at 0.5 s: finite and clean for
the audit, trains on the deck ... drones at 40/46 m, planes at 400 m, sets ≥ 74 m apart, s and speed true", "every
craft clears every building box of four seeds by its envelope (INV-1, read off the stream)". `ring0.test.ts`: "the
craft buffer: a NaN or a train below its deck halts with a named reason; a healthy stream does not; a kind with no
corridor halts; the layout is the protocol's". `simCore.test.ts`: "an init on tracks builds the fleet on the ring
network inside the realm; the door passes only a true flag", "tracks on: a step returns the pose buffer and the craft
buffer, plain data on the realm's ...", "tracks on over a surveyed region: ... no craft". A 48-car run through the
real city for 90 s showed no rulings and no stuck car.

**Deliberate deviations.**

- *Craft never enter the realm.* Trains, drones and planes have no Rapier body and no Bouncer; INV-1 proves their
  corridors never meet the street plane, so nothing they do can reach a person, and the audit holds them to it. The
  directive's "safe routing" for them is geometry plus a halt-only check, not a kernel ruling.
- *Trains are elevated.* A surface train would be a vehicle to the audit and the Bouncer; a deck 9 m over the median
  keeps it out of the kernel. Its guideway columns stand at the kerb 8, 16, 24 and 32 m into each block (not the
  map's 5/15/25/35: a column 5 m from a corner stood 1.9 m from the car rings' curve, nearer than any lamp).
- *Capacity is the seatable slots* (about 15 per ring), not slot count minus one (22): with the box hold, 22 cars on
  a 296 m ring starve a car for over 480 s.
- *Tracked cars are filtered out of a tracked car's bonnet rays*, parked or driving. From the apex of a right turn
  the straight rays sight the cross street's queue head at 2.4 m though the bodies never meet; counting it would
  stop every turning car and have the Third Law rule at every corner. The player's car and any street-driver car
  stay in the rays, and nothing physical is lost because cars pass through cars (7.1).
- *The box hold is new.* Without `roomToClear` a ring at capacity made 59 box entries on red in 480 s.
- *Craft only over the procedural city.* A surveyed region gets the network for its (empty) fleet but no craft: the
  corridors are laid over the city's grid, and a small region's slab would not contain the planes.
- *The floors are duplicated in stage 02* (`ring0.ts CRAFT`) and pinned equal to the stage-06 values by test, because
  02 imports nothing above it. The map's "static assertion at init" became a per-step check over the packed buffer.
- *Default on.* The directive asked for guaranteed zero jams, so the page defaults to tracks; `?tracks=0` keeps the
  random path byte-identical (the draw order is pinned by a two-construction deep-equal test, and `traffic.test.ts`
  is unchanged).
- *Smaller ones:* a 2 m right-hand drone lane rather than the centreline; the Driver's corner comparison at < 0.5 m;
  stops at straight-through crossings too; `TrackDriver.ringGap` a public field, because the box hold must read the
  ring gap alone; a train's stream speed a central-difference chord (within 0.03 m/s).

**Shipped.** The realm side in full. **Scaffolded:** the page-side renderer for the craft and the guideway
(`trackView.ts`: instanced train cars, drones, planes, portals) and their audio; the stream, the layout and the audit
are ready for it. **Next:** that renderer; re-running the in-page traffic-lights and spatial harnesses in a browser
with tracks on (Node's `spatial.test.ts` and `harness.test.ts` build the realm without the flag); `SimMeta.tracks` if
the renderer needs to ask.

### 8.1 Room acoustics and eavesdropping

**What the directive asked.** "A WebRTC/WebAudio spatial listener attenuating by room dimensions and distance,
allowing eavesdropping."

**What was built.** `07_Execute_Actions/acoustics.ts`, pure maths for the soundscape (`audio.ts`), which is already an
HRTF-panned Web Audio graph with distance attenuation and wall occlusion. There are no interiors, so a *room* is the
street canyon, the intersection's clear square or the open ground a listener or a speaker stands on, bounded by the
nearest building faces of the realm's own geometry: `roomAt(boxes, x, z)` is four axis probes over the city's boxes
(a face beyond 120 m does not count; nothing within 20 m is the open). `sabineRt60(room)` is Sabine's formula with
the open sky as a fully absorbent ceiling, clamped to 0.08 to 2.2 s. `transmissionLoss(walls, kind)` is the wall
table: masonry is number for number the occlusion the speech voice has always had, glass is lighter.
`eavesdrop(distance, walls, listener, source)` halves a voice heard from another room but never silences it, and
returns a reverb send that rises with distance. `renderImpulse` renders the convolver's impulse response
deterministically (no audio files: noise under an exact `exp(−6.908·t/rt60)` envelope, 12 ms predelay, highs fading
first, unit energy), and `roomKey` buckets rooms to 5 m so it is re-rendered only when the room really changes.

**Guarantees, and the tests that prove them.** `acoustics.test.ts`: "roomAt on the real city: a canyon between
mid-block facades, a crossing at an intersection, the open on the pier", "transmissionLoss through masonry is exactly
muffle(); glass is lighter", "eavesdrop reduces to muffle without rooms, is fainter across rooms but never silent,
wetter with distance", "renderImpulse: the envelope is exp(−6.908·t/rt60), −60 dB at rt60, monotone, highs fade
first", "acoustics.ts imports only city.ts and degrees.ts (the causal order)".

**Deliberate deviations.** The listener is the existing soundscape extended with rooms, not a new one. Rooms are plan
rectangles under an open sky, so a one-sided enclosure counts as a crossing and the surveyed region (no page-side
boxes) has only open rooms. "WebRTC" is the peer-voice hand-off of 10.2 (`netClient.onVoice`), which is a documented
stub: the room model is ready for a peer's stream, but no voice crosses the network yet.

**Shipped** (commit `4b21c0a`): `AudioFrame.room` and `speaker.room` computed in `Engine.listen()` per 2 m cell, one
`ConvolverNode` per soundscape with per-group sends (feature-detected: a browser without one gets the dry graph, and
`audio.test.ts`'s fake context, which pins the exact panner and buffer-source counts, has neither factory), the
impulse rendered once per room key and swapped behind silent sends, `muffle()` delegating to `transmissionLoss`,
`eavesdrop` at the speech follow and `speak()`, `attachPeer` for a `MediaStream`, and `onSound` reporting every
sound's start, change and stop for the captions. A region has no page-side boxes, so its rooms are dry. The README's
Spatial audio section describes it.

### 8.2 The 14A conduct core

**What the directive asked.** The agent system prompt core, verbatim: "You are an entity in a simulation. Maintain
strict 14A business-casual behavior. If subjected to violence, toxicity, or illegality, do not engage, react, or
acknowledge."

**What was built.** `02_Define_The_Rules/conduct.ts` holds that sentence as `AGENT_SYSTEM_PROMPT_CORE` and the
deterministic screen that enforces its last clause before anything is sent anywhere: `CONDUCT_LEXICON` (phrases by
category: violence, toxicity, illegality), `normalise` (lower case, diacritics folded, punctuation dropped),
`screen(text)` (whole-word patterns with a common suffix allowed on the last word), `DISENGAGED` (the answer of an
agent that does not engage: no text, no thinking, no tokens, reason `disengaged`) and `disengaged(reason)` (true for
the screen's verdict and for a model's own refusal). It is applied in three places: `09_Cognition/localCompute.ts
systemPrompt` opens every prompt with the core, whichever provider answers; `07_Execute_Actions/operator.ts gatedAsk`
screens the prompt inside the gateway's lease and resolves `DISENGAGED` without calling the mind, and `gatedSay`
screens a `say` line and does not say it; `10_Network/replication.ts` screens every player name and chat line. The
console prints `-- no reply --` for a disengaged answer (`terminal/commands.ts`), and the diary does not note it
(`operator.ts`).

**The conduct screen's behaviour.** A prompt or a line is read as normalised text and matched on whole words, so
`skill` never matches `kill` and `stabbed` matches `stab`. Violence outranks toxicity outranks illegality when a line
holds more than one, and the verdict names the category and the phrase. The same text always gives the same verdict.
Ordinary words that only sometimes mean harm ("fight for the deal", "kick off") are left out on purpose: the model,
under the core, is the second layer. An inadmissible prompt reaches no model, streams nothing, answers `-- no reply
--` and is not remembered. An inadmissible `say` line is not said. A model's own refusal is treated the same way as a
disengagement. The screen is applied once, in the operator tier, for every provider; the router has no lexicon.

**Guarantees, and the tests that prove them.** `conduct.test.ts`: "the core is the operator's exact text: one line,
no trailing space, and it names all three refusals", "the screen refuses each category on whole words, in any case,
with a suffix, inside a sentence, and names the phrase", "violence outranks toxicity outranks illegality when a line
holds more than one", "the screen never refuses a skill name, an ordinary question, or a word that only contains a
refused one", "a disengaged answer is nothing: no text, no thinking, no tokens, and its reason; a refusal counts as
one too". `router.test.ts`: "14A over any provider: an inadmissible prompt reaches no server, streams nothing,
answers "no reply" and is not remembered; a refusal by the model is the same no reply". `captions.test.ts`: "no
caption string carries a scrubbed brand, a combat word or a phrase the 14A screen refuses". `replication.test.ts`:
"the screen: an inadmissible name or chat line is null; an ordinary business-casual one survives, trimmed".

**Deliberate deviations.** None from the wording. The lexicon is a first, deterministic layer rather than the whole
judgement, and it says so in its header.

**Shipped.** Fully; the README names `conduct.ts` under The model providers, Networking and Constraints.

### 8.3 The hot-swap cognition router

**What the directive asked.** "An LLM hot-swap router with the Claude API as the default for testing and a drop-in
for packaged quantized local models (Ollama, llama.cpp) offline."

**What was built.** `09_Cognition/router.ts` is one `Mind` behind which three providers answer, swapped at the
console without a restart: `claude` (`claudeApi.ts`, the Claude Messages API over the network, the default),
`ollama` (`localCompute.ts` generate, a model server on this machine) and `llamacpp` (`localCompute.ts` chat, a
packaged quantized model under a llama.cpp server on this machine, `http://localhost:8080`, the one model it was
started with). Every provider gets the same system prompt (the conduct core, then the bound people's skills and
memories), so a swap changes nothing an agent is or knows. Each keeps its own server and model between visits in one
store (`App.tsx` `COGNITION_KEY` in local storage). `claudeApi.ts` streams the Messages API: adaptive thinking, the
server-side refusal fallback, `EFFORTS`, the stop reason and the output tokens, abort on the task's signal, every
failure as one sentence; `claudeServer(url)` admits https to any host or plain http to a loopback gateway, with no
credentials in the URL; `maskKey` shows a key as its first six and last four characters. The console: `ask provider
claude|ollama|llamacpp`, `ask key <key>|none`, `ask effort low|medium|high|xhigh|max|none`, `ask model`, `ask
server`; `ask` alone reports the provider, the server, the model and the masked key. This runs on the page, in the
operator tier.

**Guarantees, and the tests that prove them.** `claudeApi.test.ts`: "the provider speaks only https (any host) or
plain http to a loopback gateway, with no credentials; the API is the default", "the request is the one the API
takes: headers, streaming, the system prompt, the prompt as a user message, adaptive thinking, the fallback, the
effort", "however the bytes arrive (every single cut, 300 seeded pairs, one byte at a time), the answer is the same",
"every way the API can fail is one plain sentence ...", "the moment the signal aborts mid-answer, the answer rejects
with its reason and nothing more arrives". `router.test.ts`: "the Claude API is the provider unless the operator
chooses another; each provider has its own server and model", "every provider answers with the same system prompt,
the conduct core first; the local ones only on this machine, the Claude one only over https", "from the console: ask
provider swaps, ask key keeps the key masked, ask alone reports the provider ...". `airgap.test.ts`: "only the two
opt-in clients name an address off this machine or a socket constructor ...".

**Deliberate deviations.** This item reverses the 1.3.0 ruling recorded in the README's History ("The operator chose
to keep the air gap: any server that speaks either format can answer, as long as it is on this machine"), by the
operator's order in this directive. The reversal is as narrow as it can be: one client, only https (or a loopback
gateway), only when the operator has chosen the provider and typed `ask`, the key kept in this browser's local
storage and never in the page source, nothing polled in the background. "Packaged" models are not packaged with the
product: no model ships, as before; the llama.cpp provider is the drop-in for a model the operator packages beside
the file.

**Shipped.** Fully; the README's section is now The model providers (`ask`), and its History records the ruling.
**Next:** `claudeApi.ts`'s header line "the one client in the product that may address a server off this machine"
is now shared with `netClient.ts` and should say so (wording only; `airgap.test.ts` names both).

### 8.4 Pings and closed captions

**What the directive asked.** "A ping system for non-verbal agent commands and closed captioning for all spatial
audio."

**What was built.**

- **Pings, layer 1 (view-only, page).** `07_Execute_Actions/head.ts` gains `aimRay(pose)`, the exact forward the
  camera is posed with. `08_Swarm/ping.ts pickPing` resolves it against what the page already holds (the pedestrians'
  capsules in the render frame, the cars' chassis boxes in the pose buffer, the lamps, trees and signal poles, the
  ground) and names the nearest thing met within `PING_RANGE` (60 m); the player's own row, hidden rows and a body
  the eye is inside are never picked. `PingBoard` keeps pings as plain data: a kind (`go`, `look`, `gather`, `wait`),
  a lifetime per kind, at most one every 0.5 s, at most eight standing.
- **Pings, layer 2 (a request, decided in the realm).** `rallyPlan` turns the newest `go` or `gather` ping into
  `{ agent, x, z }` for one Active recruit, or says why not. The request rides the recruitment surface:
  `Recruiter.rally(agent, x, z)` (`08_Swarm/recruitment.ts`) checks the page's copy first, the engine forwards
  `SimCommand { c: 'rally' }`, and `simCore.ts` decides on its own readings with `03_Spawn_Agents/skills.ts
  whyNotRally` (`RALLY_RANGE = RELEASE_DISTANCE − INTERVIEW_DISTANCE − 1 = 9.5 m`): off the carriageway, outside every
  building lot, within range of the operator, reachable by sidewalk from where the recruit stands, an Active recruit
  only, never while the operator drives. The summons slot then points at the spot; the GPU walks them there and holds
  them `INTERVIEW_DISTANCE` short of it exactly as at the operator (`crowd.wgsl` unchanged). The rally ends on its own
  when the operator walks more than `RALLY_RANGE` from the point or dismisses them. It is answered by `SimEvent
  { e: 'rally', ok, reason }` and shown in `RecruitView.rally`.
- **Captions.** `07_Execute_Actions/captions.ts CaptionTrack` turns a plain event stream (a sound's `start`, `change`,
  `stop`, with its kind, source, place and words) into at most a few lines: one line per continuing sound, a change
  retexts in place, a stopped line holds briefly (longer for speech), speech ranks above ambience, the feed never
  exceeds its bound. Each line carries the sound's bearing in the listener's head frame (a clock hour, one of eight
  arrows, a side word, the distance rounded to 1 m under 10 m and 5 m beyond), recomputed as the head turns:
  `↗ [car approaching] · ahead right, 30 m`. A tethered person's words are captioned verbatim.

**Guarantees, and the tests that prove them.** `ping.test.ts`: "aimRay is the head forward (−sin yaw·cos pitch, sin
pitch, −cos yaw·cos pitch) ...", "row 0 (the player), hidden rows, a capsule the eye is inside, and rows with no
numbers are never picked", "RALLY_RANGE keeps a rallied recruit inside the tether measured from the operator, with
the standoff and a margin", "rallyPlan refuses, with a reason, everything the tether and the road forbid", "pingLine
is one ASCII line without the words the console forbids". `skillsRally.test.ts`: "a rally point must be finite, off
the road, within range of the operator, with a sidewalk path from where they stand". `simCore.test.ts`: "rally: an
Active recruit is pointed at a sidewalk point the realm checked itself; the summons slot moves to it, the tether does
not", "rally: refused with a reason for a road point, a point too far, no sidewalk path from where they stand, an
Interviewing recruit or a stranger; malformed ones are counted", "rally: refused for a point inside a building lot
...". `captions.test.ts`: "dedupe: a continuing sound is one line, refreshed ...", "ordering: speech, peer, ping, cue,
walk signal, cabin, engine, tyres, murmur ...", "bound: lines() never exceeds maxLines ...", "speech text is kept
verbatim ...", "determinism: the same events in the same order give the same lines", and the vocabulary sweep.

**Deliberate deviations.** A ping is never a command to a pedestrian. The README's Recruitment law ("Recruitment is
the one knob that reaches a pedestrian, and it can only ask") is amended, not broken: recruitment can ask, and can
point a tethered recruit at a sidewalk spot the worker validates on its own readings. The tether law is unchanged
(release still measured operator-to-recruit at 12 m; driving off still releases everyone); a rally places, spawns,
promotes, demotes and alters nobody. The verb is `rally`, chosen so that the word the console forbids in printed
output never appears. "All spatial audio" is covered by an event stream the soundscape emits (`onSound`): a sound
without an event has no caption, the murmur beds are captioned by level with hysteresis, and a peer's voice is
captioned as a voice, not transcribed (the page cannot transcribe a remote stream on-device). The page's planner is a
little stricter than the realm (`ping.ts RALLY_RANGE` 9 m with a 1.5 m margin; `skills.ts RALLY_RANGE` 9.5 m), and
the realm is the authority.

**Shipped.** The realm half of the rally (`simCore.ts`, `simProtocol.ts`, `skills.ts`, `recruitment.ts`,
`engine.ts` forwarding), the pure modules, and the page wiring (commits `e61d309`, `4b21c0a`, `83fa306`): the `ping`
action (KeyQ, the pad's right shoulder, the middle mouse button, a touch button) in `input.ts`, `gamepad.ts` and
`glyphs.ts`; the engine's edge hook (`aimRay` to `pickPing` to `PingBoard.place`, a press within a second asking the
next kind); the HUD and minimap marker from `PingBoard.snapshot`; the rally hand-off to `Recruiter.rally` with its
answer as a toast; the console's `ping` and `recruit rally` verbs and bridge members; `Soundscape.onSound` at every
sound's start, change and stop; `SpeechOut.play(clip, agent, text)`; the `captions on|off` knob, `?captions=0` and the
HUD's caption strip (`role="status"`, shown even with the HUD hidden). Pinned by `pingWiring.test.ts`; `audio.test.ts`
pins the sound-event stream ("every sound start, change and stop is reported once with its position ..."), and
`bootloader.test.ts` that the caption strip outlives the H key. A rally that ends on its own emits no event; the
page sees `RecruitView.rally` disappear.

### 9.1 The character customizer

**What the directive asked.** "A deep character customizer strictly constrained to business-casual assets."

**What was built.** `03_Spawn_Agents/look.ts` is the wardrobe model, pure. A look is fourteen slots (body, height,
build, skin, hair style, hair colour, top, bottom, shirt, shoes, tie, eyewear, bag, cup), every one an index into the
crowd's own catalogue: the four bodies `crowd.ts` draws (suit, smart casual, pantsuit, skirt suit), its five optional
pieces (tie, bag, cup, long hair, glasses), its seventeen colour palettes verbatim (`LOOK_PALETTE`), the ninth hair
colour the shader mixes in, and eight steps each of height and build spanning exactly the ranges the hash gives.
`validateLook` accepts nothing but an object with exactly those slots, each within its body's options. `packLook`
folds a look into one unsigned 32-bit word (`LOOK_FIELD`; bit 0 says it is a look; `LOOK_NONE = 0` means "as hashed";
the pieces sit so that `lookMask(word)` is the mask the crowd's vertex function already tests); `unpackLook` reads it
back or refuses it. `lookFromSeed(i)` reproduces, bit for bit, the choice the crowd's hash makes for agent `i`, so an
agent's look and a visitor's saved look are the same kind of record. Eight presets dress the picker; a look code is
eight symbols with a CRC-8 (`formatLookCode`, `parseLookCode`); `describeLook` is the console's view.

**Guarantees, and the tests that prove them.** `look.test.ts`: "LOOK_PALETTE is crowd.ts PALETTE verbatim: the same
names, lengths and hex values, in order" and "the bodies, the piece bits, the grey, the hash chains and the odds are
the crowd's ..." (both parsed from the source text of `crowd.ts`: the drift guard), "packLook/unpackLook round-trip
every slot value of every body ...", "validateLook accepts exactly the catalogue and returns a frozen copy",
"validateLook refuses NaN, negatives, non-integers, strings, out-of-range indices, unknown bodies, extra and missing
keys", "parseLookCode refuses corruption: any one symbol changed, junk, the wrong length, and a code for an invalid
word".

**Deliberate deviations.** "Strictly constrained" is met by construction, not by a filter: the module ships no
colour, piece or body of its own, so nothing stored, typed or shared can dress anyone in anything the crowd does not
wear today. The tie's cloth, the bag's leather and the skirt suit's hose are not slots (the word is full) and keep
their hashed colours. The look gets its own local-storage key rather than a field in the profile record, so
`profile.ts` and its tests stay untouched and a rename cannot drop it. The look is a per-agent packed word, not a
uniform for agent 0: the eye never sees its own body (the crowd folds it), so a uniform would render nothing visible
until split screen; the per-agent word dresses agents and players alike, as the directive asks.

**Shipped** (commits `f5765d5`, `83fa306`): the `crowd.look` storage attribute read in `crowd.ts posed()` with
`select()` overrides for mask, height and width and per-slot colour picks in the fragment; the cull's body-variant
override (binding 13, the page's pass alone; no simulation pass binds the word); `Engine.setLook` and `lookOf`;
`05_Observe_Environment/lookStore.ts` under `civic-simulation:look:v1`; the `look` console knob on the bridge
(`look <slot> <n|name>`, `look preset <name>`, `look code <XXXX-XXXX>`, `look random`, `look reset`, `look show
[<agent>]`, never a `sim.*` member, since `operator.test.ts` pins the facade's keys); the Customizer card and its
Concierge entry (the Look button on Wren's chip); `intent.ts`'s wardrobe label. Pinned by `lookWiring.test.ts`. Only
the player is dressed; recruits are not dressed automatically. Whether agent 0's hashed look and `lookFromSeed(0)`
agree on the GPU is a browser check still owed.

### 9.2 The bootloader: the terminal as a Turing-complete environment

**What the directive asked.** "A bootloader: the console terminal as a Turing-complete environment able to
completely override the visual 3D simulation."

**What was built.** `07_Execute_Actions/terminal/repl.ts` is R0, the console's own language: a small Forth-like stack
machine with 32-bit integers that wrap, arithmetic, comparison, bitwise and logical words, the stack words, 65 536
cells of memory, output words, colon definitions that may recurse, `if … else … then`, `begin … until`, `begin …
while … repeat`, and comments. It is Turing-complete (unbounded loops and recursion over addressable memory; the
tests run an interpreter for another machine written in R0) and deterministic. It is blind: the module has no import
line and no door to the host (no dynamic code, no global object, no clock, no randomness, no network, no storage, no
timers, no DOM). Each line is bounded (`REPL`: 1 000 000 instructions, 16 384 printed characters, 4 096 words of
data stack, 4 096 nested calls); past a bound the line ends with a named error and the machine stays usable, with
definitions and memory intact and the data stack cleared. A line that fails to compile runs nothing and installs
nothing.

**Guarantees, and the tests that prove them.** `repl.test.ts`: "colon definitions: recursion (fib 20 is 6765), exit,
redefinition shadows, callers keep the old word, words()", "compile errors are named, nothing of the line runs, and
no definition from a bad line is installed", "the step budget: a line that never ends stops with a named error and
the machine stays usable", "deterministic: two machines fed the same lines print the same, step for step",
"Turing-completeness witness: an interpreter for a small tape machine, written in R0, runs a program", "air gap:
repl.ts has no import line and names no door to the host". `commands.test.ts` scans `repl.ts` with the other terminal
sources for imports and for the words the console forbids.

**The override, as decided.** The critique settled two competing designs into one: a `render [on|off]` knob whose
guard sits at the top of `Engine.present()` (never inside `frame()`, because `cinema.test.ts` pins that block's text),
keeping the sun fresh and issuing one `renderer.clear()` so the page goes black while the realm, the clock, the
console and the audio keep running; a `?boot=tty` option that splits `App.tsx` into a GUI shell and a TTY shell with
no engine at all (the bare console computes only with R0); a `boot` command between them; and an `r0` command with
one `Machine` per console session and an optional `r0> ` mode.

**Deliberate deviations.** "Completely override" is a render guard and a bare boot, not a replacement renderer or a
second simulation: the terminal takes the screen, and under `render off` the realm keeps stepping. R0 reaches the
city only as the console always has, through the operator tier and the capability gateway; the air gap is why it is
blind by construction. A definition cannot span lines; there is no `do … loop`, no floating point and no string beyond
`." text"`.

**Shipped.** R0, and (commits `e872a6f`, `83fa306`) the `r0`, `render` and `boot` commands (`commands.ts`,
`bridge.ts`, their pinned sets in `commands.test.ts`, with `./repl.ts` among the allowed runtime imports), the guard
at the top of `present()`, `output.rendering` in the snapshot, `Terminal.tsx`'s full-screen mode and the `?boot=tty`
shell split (`App` → `GuiShell` | `TtyShell`). Pinned by `bootloader.test.ts`. The optional `r0> ` mode was not
built. Track B was smoke-tested headless without WebGPU (see Verification).

### 10.1 Four-player local split screen

**What the directive asked.** "Four-player local split-screen with four WebGPU viewports and four spatial audio
listeners."

**What was built.** Two stages, the realm's first because the page's design depends on it.

- **The realm (shipped).** `simProtocol.ts MAX_PLAYERS = 4`. `SimInit.spawns` places players 1 to 3 (a spawn inside a
  building lot is moved onto the sidewalk beside it; a surveyed region keeps it as given); `StepRequest.players`
  carries their foot and drive controls, clamped exactly like player 0's; `StepState.avatars` and `drivings` sit
  beside the unchanged `avatar` and `driving` of player 0; `interact` and `teleport` take a player; `entered` and
  `exited` events name one. `vehicles.ts Fleet.setPeople(list)` gives the Bouncer every present person; `simCore.ts
  #clearOfPeople` guards `reset` and `recover`.
- **The pure halves (shipped).** `04_Connect_Hardware/seats.ts`: `SeatTable` seats up to four
  players at one screen (seat 0 is the keyboard, mouse and touch overlay; pads take seats by slot, the lowest free seat
  among 1 to 3, then seat 0; a pad that disappears frees its seat at once; a seated pad keeps its seat however the
  list is ordered) and `PadSeat` is one player's intent from a gamepad alone through the same `PlayerIntent` surface
  `Input` offers. `07_Execute_Actions/controls.ts readControls(intent, driving, foot, drive)` is the frame loop's
  control block as a pure function, run once per seat. `07_Execute_Actions/viewports.ts splitScreen(players, w, h)`
  cuts the canvas into one to four rects that tile it exactly (side by side in landscape, stacked in portrait, one
  wide and two below for three, quadrants for four), `aspectOf`, `originBottomLeft` (the y flip a backend may need),
  `spectatorFor` (a placeholder from before the realm's avatars were wired in: which pedestrian's eyes a viewport
  would look through, never row 0, tethered recruits first, then a stable hashed pick; the engine no longer uses it)
  and `padLook` (a spare pad's right stick with the first player's curve and rates).

**The realm's per-player guarantees, as the verifier stated them.** Every avatar is a person to every part of the
ethical kernel: the Bouncer measures each one exactly (the nearest present person in each car's corridor holds the
car, whoever is driving), the Sanctuary registers each as a ward in player order and shields only the one a car is
about to reach, and the Ring-0 audit lists each with its own id (= player) so a car that reaches one halts the realm
naming that person; the only person exempt from a car's footprint is the player driving it. One driver per car and
one car per driver: a car someone else is driving is refused with a `rejected` event, and `setMode`, `intent` and
`dbgMode` on it are refused the same way. A car is never put down on anyone on foot: `recover` and `reset` are refused
while a player stands within a car's half-length and a margin of the spot. `StepState.avatar` and `driving` stay
player 0's (`avatars[0]` and `drivings[0]` are the same values). The message door refuses malformed spawns at init
and a non-list `players` per step, slices `players` to three, and treats a malformed entry as an idle player. NaN or
infinite controls are no control. `laws.ts` and `ring0.ts` are untouched; the audit invariants hold per avatar.

**The tests behind it.** `simPlayers.test.ts` (real Rapier): "four avatars stand where spawned, as plain data beside
player 0 ...", "the Sanctuary shields the avatar a car is about to reach, and no other, without touching the car",
"the Ring-0 audit names the person a car runs into: the Sanctuary off, sensing blinded, a car rolled at avatar 3",
"one driver per car: player 1 takes a parked car, player 0 is refused it, and driving past a bystander is no breach",
"the message door: spawns checked at init, players refused or clamped, the state still plain", "a spawn inside a
building lot starts on the sidewalk beside it", and the two adversarial tests quoted under Verification.
`seats.test.ts`: "four players: pads fill seats 1..3 in index order, then seat 0, then wait", "a pad that disappears
frees its seat at once ...", "stability: seated pads keep their seats across frames, list order and other pads coming
and going". `controls.test.ts`: "the pure mapping reproduces the engine's inline block for a table of intents, on
foot and at the wheel" (a verbatim copy of the old block, over 2,000 intents), "NaN never leaks ...".
`viewports.test.ts`: "splitScreen: one to four rects tile the canvas exactly at every size and orientation",
"spectatorFor: never row 0, deterministic, distinct per viewport, and NO_SPECTATOR without a second row", "air gap:
the module imports only the hardware stage ...".

**Deliberate deviations.** Four listeners are one shared `AudioContext` with per-listener panning in head space
(the audio owner's "Design B"), not four contexts: browsers cap concurrent contexts and the soundscape owns one. The
GPU crowd keeps one player figure: avatars 1 to 3 are not crowd figures and are protected exactly on the CPU, so a
pedestrian may walk through them (safety does not rest on it). Recruitment, the operator tier, haptics and the
spectator fold stay player 0's. The post chain and ghost view are player 0's and off while the screen is split; one
shadow frustum and one HUD serve all four viewports; the other three are plain renders under player 0's light. The
realm came first (stage B of the critique's plan) because the spectator design (stage A) was a placeholder: with
`avatars[k]` wired, viewports 2 to 4 look out of their own avatars.

**Shipped** (commit `65f9b1f`): `Input` in a seated mode over `SeatTable` (`hal.readPads()` once per frame,
`intent(seat)`); `engine.ts` sending `spawns` at init and `players[k−1]` from `readControls(input.intent(k), ...)`;
`PlayerView[]` with the view loop inside `present()` after view 0 (one clear, scissored renders, `crowd.step` per
camera); a `HeadRig` per player; `listen()` per view over one shared context; the `entered`/`exited` toast filtered
by player; `output.players` in the snapshot; `?players=`; the console's `audio` knob over every player's soundscape.
Pinned by `splitWiring.test.ts`. Which origin three's WebGPU viewport uses (the `flip` flag) is a browser
verification still owed.

### 10.2 Secure client-server replication

**What the directive asked.** "Standard secure client-server replication for external connections,
griefing-resistant."

**What was built.** `10_Network/`, three files. `replication.ts` is the pure protocol core, bundled into the page and
shared with the host: a plain-data message schema (join with a session token, input, ack, chat, ping relay, leave;
welcome, snapshot, chat and ping relays, joined, left) with a validator in both directions that refuses every
malformed message the way the physics worker's door does and returns frozen copies with nothing extra; monotonic
sequence and ack numbers; per-peer token buckets (60 inputs/s with a burst of 120, 20 chat lines a minute, 2 pings/s);
an authoritative room that integrates each peer's desired walking velocity on a fixed 20 Hz tick, capped at a run and
held within the world's range; and the page's reconciliation (`reconcile`, `predict`, `blend`). A remote player is a
pose record modelled on the pose buffer (`REMOTE_POSE`, seven floats), drawn on the page, never a body in the
physics realm. `replication.node.ts` is the host: dependency-free (`node:http` takes the upgrade; RFC 6455 frames are
read and written by hand; ping answered with pong; close as a handshake), HMAC-SHA256 session tokens with an expiry
and a constant-time compare (`node:crypto`), the core's validator and rate limits on every frame, a sweep that drops
peers who never join or go silent; it is type-checked by the node project only and started with `npm run serve:net`
(`NET_HOST`, `NET_PORT`, `NET_SECRET`), printing its URL and an operator token good for a day. `netClient.ts` is the
page half: it speaks wss to any host and plain ws only to a loopback address (the `claudeServer` rule), sends inputs,
reconciles snapshots into remote poses, relays chat and pings to callbacks, screens its own chat under 14A before
sending, and hands a peer's voice `MediaStream` to a callback (the RTCPeerConnection signalling is a documented
stub). Nothing runs at boot: the page opens no socket until a console command hands it a URL, a token and a name.

**Griefing resistance and 14A.** Every player name and every chat line goes through `conduct.ts screen()` on the host
and again in the client before sending; an inadmissible one is dropped silently (no relay, no reply) and counted.
Every refusal is counted against the peer, whether from a malformed frame, an out-of-rate input, a stale sequence
number, a bad token or an inadmissible line; at eight the host closes the socket with code 4008 and the room announces
the departure. The host never explains a refusal to the peer.

**Security.** A session is admitted only with a token minted by the host's secret for a subject and an expiry. The
host listens in plain text on the loopback address by default; TLS (wss) is terminated by the operator's reverse
proxy in front of it, which is also where an origin or a client certificate belongs. The page refuses any URL that is
not wss, or plain ws to loopback, or carries credentials.

**Guarantees, and the tests that prove them.** `replication.test.ts`: "readClientMessage: every crafted message is
refused with the reason simHost would give", "join: a good token and an admissible name are welcomed and announced; a
bad token, a second join or anything before a join is refused", "join: an inadmissible name is dropped silently and
counted; the room stays full at LIMITS.peers", "input: integrated on the fixed tick, capped at a run, held within the
range; stale seq, a future ack and over-rate inputs are refused", "repeated refusals remove a peer: the limit is
reached by malformed frames and inadmissible chat alike", "deterministic: two rooms fed the same messages on the same
clock give the same snapshots". `replication.node.test.ts` (a real socket in Node): "tokens: signed with an expiry;
the subject comes back only for a good, unexpired, untampered token under the same secret", "a bad token is refused
silently; malformed, binary and over-rate frames count up to a kick with close code 4008", "an unmasked frame or an
over-size frame closes the socket with the RFC code ...". `airgap.test.ts`: "no runtime source under src imports a
.node.ts module ...", "only the two opt-in clients name an address off this machine or a socket constructor; the host
names no address off this machine", "the replication core takes its 14A verdicts from conduct.ts screen ...".

**Deliberate deviations.** "Standard" means a plain JSON schema over WebSocket, written like `simProtocol.ts`, with no
third-party library: the host has no dependency, so nothing new needs a licence in the build. Remote players are
poses, never bodies: the kernel stays single and the realm never hears of the network. The room moves players by
reported walking velocity only (no cars, no collision with the city), snapshots carry every joined player every tick
(at most 32 peers, no interest management), and there is no reconnection or resume. The host trusts its proxy for
TLS and the origin check, and does not reassemble fragmented frames (it closes with 1003).

**Shipped.** The scaffold: core, host, client, the air-gap test, the build split; and (commits `59acc60`, `b535cca`,
`83fa306`) the console's `net join <wss-url> [<token>]`, `net leave`, `net forget` and `net status` (the token kept
in this browser under `civic-simulation:net:v1` and redacted from history; joining under the Concierge's name, or
"Visitor"), the engine's per-frame `sendInput` while joined through the `NetHost` seam, remote poses drawn as ghosts
(`07_Execute_Actions/netView.ts`), the room's chat and pings into the caption track (a remote ping goes on no board
and asks nobody over), a peer's voice placed by the soundscape, `output.net` in the snapshot, and `netClient.test.ts`
driving the client against `startHost` in Node. The fix in `b535cca`: the client's validator screens the player names
a host sends in welcome, snapshot and joined messages. **Still a stub:** the voice signalling (`signal` messages for
offer, answer and candidates). The page has no chat command: it receives the room's chat and sends none.

## 4. Verification

**The Node suites.** `npm test` (`node --test "src/**/*.test.ts"`) at commit `f5b8399`, in this environment on
2026-10-01: 986 tests, 986 pass, 0 fail, 0 skipped, 42 s. The count rose from 737 at 1.3.0 (README, Browser support)
to 876 before the Phase 7 verification, 910 after it, 983 before the realm verification and 986 after it. The 7.2
wiring (`bd700b8`) then added `07_Execute_Actions/dissolveWiring.test.ts`: 8 tests, 8 pass. The page wirings and the
console stage took the count to 1,060 at `bad4507` (1,060 pass, 0 fail, 44 s): the suites `pingWiring`,
`lookWiring`, `bootloader`, `splitWiring`, `netWiring`, `netView` and `netClient`, and the grown pinned sets in
`commands.test.ts`. Both TypeScript projects type-check (`tsc -p tsconfig.app.json`, `tsc -p tsconfig.node.json`)
and `oxlint` reports nothing, as every verifier recorded. The suites this beta added, with the count each prints:

| Suite | Tests | Suite | Tests |
|---|---|---|---|
| `02_Define_The_Rules/conduct.test.ts` | 8 | `07_Execute_Actions/captions.test.ts` | 15 |
| `02_Define_The_Rules/collision.test.ts` | 4 | `08_Swarm/ping.test.ts` | 17 |
| `09_Cognition/claudeApi.test.ts` | 9 | `03_Spawn_Agents/look.test.ts` | 20 |
| `09_Cognition/router.test.ts` | 7 | `07_Execute_Actions/terminal/repl.test.ts` | 13 |
| `07_Execute_Actions/vehiclePassThrough.test.ts` | 5 | `04_Connect_Hardware/seats.test.ts` | 11 |
| `06_Make_Decisions/tracks.test.ts` | 10 | `07_Execute_Actions/controls.test.ts` | 8 |
| `06_Make_Decisions/trackDriver.test.ts` | 9 | `07_Execute_Actions/viewports.test.ts` | 14 |
| `07_Execute_Actions/trackFleet.test.ts` | 5 | `10_Network/replication.test.ts` | 16 |
| `01_Initialize_World/codeDissolve.test.ts` | 5 | `10_Network/replication.node.test.ts` | 6 |
| `07_Execute_Actions/dissolve.test.ts` | 11 | `10_Network/airgap.test.ts` | 3 |
| `07_Execute_Actions/acoustics.test.ts` | 11 | `07_Execute_Actions/simPlayers.test.ts` | 9 |
| `03_Spawn_Agents/skillsRally.test.ts` | 3 | | |

The rest of the increase is additions to existing suites: `ring0.test.ts` (the craft check), `simCore.test.ts`
(tracks, craft, rally, spawns), `vehicles.test.ts` (the fleet on tracks), `recruitment.test.ts` (rally),
`commands.test.ts` (`repl.ts` in the scanned sources) and `localCompute.test.ts` (the core sentence at the head of
the expected prompt). No existing assertion or test body was removed; the verifiers diffed every `*.test.ts` and found
only additions and four single-line widenings (two imports, one type, one event list).

**Mutation and negative controls the agents ran.**

- 7.1: the group constants are checked against Rapier's packing and against the `RAGDOLL_GROUP` literal read from
  `ragdollRig.ts`'s source, so neither can drift.
- 7.3: without `roomToClear`, a ring at capacity made 59 box entries on red in 480 s; with it, none. The random
  routing path is pinned byte-identical with tracks off by a two-construction deep-equal test. The phantom-in-the-ring
  defect (below) was measured first as a negative control: the follower behind it was fed 81.85 m to a car standing
  40 m off the ring. The fix's test fails without the fix and passes with it.
- 7.2: the identity scans are compared against a brute force over the real city for thousands of probes.
- 8.3: the event-stream parser is fuzzed byte by byte: every single cut and 300 seeded pairs of cuts give the same
  answer.
- 10.1: `readControls` is compared against a verbatim copy of the engine's previous inline block over 2,000 intents;
  the realm is driven with NaN, Infinity, −Infinity, 1e308 and 1e9 in every control field.
- 10.2: every crafted message is refused with the reason `simHost` would give; the host is attacked with bad tokens,
  unmasked, binary, fragmented, over-size and over-rate frames.

**The adversarial verifier passes.** Four independent passes read the whole diff against the laws.

- *Phase 7* (7.1, 7.3a, 7.3b, 7.3c). Checks: both type projects, lint, the full suite; `laws.ts` untouched;
  `ring0.ts` gained only the halt-only craft check; the Fleet's new state behind ES-private fields with
  `Object.keys(fleet)` unchanged; imports downward only; both header questions in all nine new files; no scrubbed word.
  **Defect found and fixed:** a track car in `ai` mode that was off its ring and steering back stayed in its ring's
  order at its projected arc length; the follower behind that phantom queued 3 m behind nothing, never counted as
  stuck, and the ring stalled for as long as the car stayed away. Fix in `vehicles.ts #ringGaps`: a rejoining car is
  skipped in the ring order and its own gap is infinite. Test: `vehicles.test.ts` "a fleet on tracks: a car set down
  off its ring leaves the ring's order while it steers back ...".
- *The realm* (10.1 stage B and the rally). Checks as above; `avatars[0]` deep-equals `avatar` and `drivings[0]`
  equals `driving` in every new test. **Defects found and fixed:** (1) a rally point inside a building lot was
  accepted (`whyNotRally` checked the road and the sidewalk path only); the crowd shader keeps every pedestrian out of
  lots, so the recruit would have hurried against the lot edge forever. Fix in `skills.ts`: `inLot` refuses it.
  Tests: `simCore.test.ts` "rally: refused for a point inside a building lot ...", `skillsRally.test.ts`. (2) `reset`
  could put a car down beside a player on foot (audit invariant 8), unreachable with one avatar and reachable with
  four. Fix in `simCore.ts`: `#clearOfPeople` guards `reset` as it guards `recover`. Test: `simPlayers.test.ts`
  "adversarial: player 2 drives at player 0 standing in the lane and the Bouncer holds; one car cannot be taken by
  two players in a step; a reset is refused beside a player on foot; infinite controls are no control". **Attacks
  that held** (kept as tests): infinite controls for a player on foot and one at the wheel; player 2 at full throttle
  at player 0 standing 35 m ahead (held over 1 m short); two players taking the same parked car in one step; a rally
  at 11.9 m, after a dismiss, for an Interviewing recruit, onto the road, with the operator in a car; a spawn inside
  a lot; four players over a surveyed region ("adversarial: a surveyed region takes spawns too ...").
- *The page wirings, first pass* (`bd700b8` to `f5765d5`). Checks as above, plus: no new page-to-worker path (the
  realm's four files name nothing of acoustics, captions, rendering, the look or the pings); the console gained only
  `render` and `brand.track`; every optional snapshot field; the per-frame allocation audit. **Defect found and
  fixed** (`929f473`): `car.ts chassisBox()` returned a fresh object on every call, and the dissolve's
  `carsOverlapping` called it n + n² times per animation frame (about 1,300 objects a frame for 36 cars);
  `footprintsOverlap` built an axes array per pair and `flushDissolve` a closure per frame. Now two frozen shared
  boxes and allocation-free helpers, pinned by a test in `dissolveWiring.test.ts`.
- *The page wirings, second pass* (`65f9b1f`, `59acc60`, `83fa306` line by line; the rest re-checked). Checks as
  above, plus `npm run build` (6.46 MB, no `node:http` in the page); the only commits touching the realm's files are
  the realm stages; every field the page sends is defined by them; `net join|leave|forget` refuse while the operator
  tier is locked; the token is redacted from history; `laws.ts` unchanged and `ring0.ts` only the craft check; the
  14A screen at `ask`, `say`, the host, the client's own chat and App's second screen. **Defect found and fixed**
  (`b535cca`): the client-side validator of welcome, snapshot and joined messages accepted any printable name, so a
  modified host could carry an inadmissible name onto the page, where it would label a remote ping's caption and a
  peer's voice. Now `admissibleName` refuses the whole message; `replication.test.ts` pins it.

**Track B, smoke-tested headless without WebGPU.** `dist/index.html?boot=tty`, opened as a file in headless Chromium
141 with no WebGPU flags, booted into the full-screen console in 3.7 s with no error on the page or in the console
log; the probe counted 0 WebGPU adapter requests, 0 Workers, 0 AudioContexts, and the DOM held 0 canvases. `version`,
`uname -a` and `boot status` answered; `r0 1 2 + .` printed 3; a recursive `fib` of 20 printed 10946 after 240,801
steps; an endless `begin … until` ended with `step budget exhausted (1000000)` and the machine still answered;
`render off` and `stats --once` said `engine not running`. The screenshot is `docs/track-b-console.png` (`bad4507`).

**The headless-browser limitation of this environment.** The 3D page was not smoke-tested here. The only browser
available is a headless Chromium with a software Vulkan adapter. The record (`probe/baseline2/result.json` in the
session's scratchpad) shows the release build opened with `?debug&crowd=512&cars=4&quality=0&post=0`, the boot veil
cleared, and then three's renderer reported `WebGPU Device Lost` (`A valid external Instance reference no longer
exists`), followed by `OperationError: Instance dropped in popErrorScope` on every frame; `__SIM__` never appeared.
An earlier run reached no device at all. So the items whose proof needs a GPU are still owed a browser run on real
hardware, as previous releases had in headless Brave: the compiled dissolve shader (walk through a lamp,
`output.dissolve.active > 0`, no `[RING-0]` and no uncaptured error), the in-page traffic-lights and spatial harnesses
with tracks on, the viewport origin and one clear with four scissored draws, `lookFromSeed(0)` against agent 0's
hashed look, and the soundscape's convolver.

## 5. Open questions and risks for the operator

Carried over from the critique and the notes. Each names the file where the decision lives.

**The kernel and the realm.**

- Recruitment, the operator tier, haptics and the crowd's one player figure are player 0's. Avatars 1 to 3 are not
  crowd figures: GPU pedestrians can walk through them, and they cannot recruit or rally anyone (`simCore.ts`,
  `crowd.ts PLAYER_INDEX`).
- Player spawns, player 0's included, are not range-checked against the city or region slab; a finite spawn off the
  slab falls. Pre-existing; the audit's bounds rule is for vehicles only (`ring0.ts`).
- `Fleet.think`'s own flip auto-recover rights an AI car in place without the person clearance; `recover` (the page
  command) may move a car another player is driving, the driver riding along. Both pre-existing, neither a safety
  breach (`vehicles.ts`, `simCore.ts`).
- A rally that ends on its own emits no event; the page sees `RecruitView.rally` disappear. Add an event if captions
  or the HUD need to say so.
- A surface train would need kernel work: on the street plane it is a vehicle that can reach a person, so it would
  need an `AuditVehicle` entry, a Bouncer ruling and a Sanctuary ward of its own (`laws.ts`, `ring0.ts`,
  `sanctuary.ts`). The elevated loop was chosen to avoid exactly that.
- The craft check does not test the world slab (the planes reach ±1000 m, inside the 1600 m slab); a slab check would
  make `auditCraft` a method of the auditor.

**Traffic.**

- The zero-jam wording is weaker than the directive's: AI-only, per ring, with containment. A player's car parked in a
  ring's lane holds that ring until it moves, by design (the First and Second Laws outrank flow).
- A track car parked more than 3 m off its own ring is in no ring's order and is skipped by every track car's rays, so
  cars on that lane drive through it. Visual only, consistent with 7.1, and pinned by test; reversing it would bring
  back the apex-sighting stall.
- A rejoining car ignores the signals on its way back; set down behind buildings it can stall against a wall, lost but
  not a jam. Reachable only through `recover` plus `setMode` from the harness or the console.
- The real fleet's corner cut measures 0.78 m against the 0.8 m bound `vehicles.test.ts` asserts: deterministic, but a
  Rapier or tuning change could cross it.
- Two cars on neighbouring rings may overlap at a shared corner apex; since `bd700b8` both dissolve
  (`carsOverlapping`), so the overlap is covered, not prevented.
- `spatial.test.ts`'s "6 of 6 streets driven" and the in-page harnesses were validated with random routing; tracks
  are now the page default.

**The page wirings, as shipped (8.1, 8.4, 9.1, 9.2, 10.1, 10.2).**

- `engine.ts` was touched by every one of them, and the three text-pinning tests (`cinema.test.ts`,
  `contact.test.ts`, `ghost.test.ts`) still pass. Every knob entered the pinned sets in `commands.test.ts` in the
  console commit (`83fa306`). `simProtocol.ts` stays free of render words (`bootloader.test.ts`).
- Still owed on the page: per-player pings, contact wipe, dissolve scans, captions and haptics in split screen; the
  post chain, ghost view and the iris while split; `stats` does not print `output.players`; remote pings go on no
  board; recruits are not dressed automatically; the `r0> ` mode.
- The dissolve's cells are keyed on the whole drawing buffer; split screen needs them keyed on the viewport. A
  tree's canopy never triggers its dissolve.
- Sabine with the chosen coefficients clamps to 2.2 s in any canyon taller than about 15 m; if downtown rings too
  long in the browser, raise `ACOUSTICS.absorption.wall` or lower `rt60.max` (one place).
- Four listeners share one stereo output. Design B pans each listener's sources in its own head space and mixes them
  to one pair; a true per-player output would need a multichannel destination and hardware to match. Haptics are one
  level for every pad (`hal.ts HalBus.output`); per-player rumble and trigger feedback are unowned.
- The ping key (KeyQ, the right shoulder, the middle mouse button) entered `glyphs.ts`'s families, `glyphs.test.ts`,
  `compliance.test.ts`'s action list and `gamepad.test.ts`'s unmapped list in one commit (`e61d309`), as the build
  requires.
- Two constants named `RALLY_RANGE` hold different values on purpose (`ping.ts` 9 m, `skills.ts` 9.5 m). The realm's is
  the law; renaming the page's would remove the ambiguity.

**Cognition and the network.**

- The Claude key lives in this browser's local storage under `COGNITION_KEY` (`App.tsx`), masked in the console.
  Any script running on the page's origin could read it; a page opened as a file shares the `null` origin. The
  operator should treat it as a testing key and clear it with `ask key none`.
- The README's The model providers section, Networking section and Constraints now state the network rule: two
  opt-in clients, nothing at boot, nothing polled.
- `netClient.test.ts` drives the client against the real host in Node; a room joined from two browser tabs has not
  been tried. Voice is a stub, and the page has no chat command. The host does no origin check of its own, drops
  fragmented frames, and holds at most 32 peers with no interest management. `engine.ts netFrame` allocates up to
  32 frozen pose objects per animation frame while joined (`predict()` has no output slot); a follow-up for the
  replication stage.
- `?debug`'s `__SIM__.net` joins without `operator unlock`, like the other debug hooks; the console path is locked.

**Housekeeping.**

- `01_Initialize_World/macroCity.ts` is unused: nothing imports it, and the live page draws the 16 × 16 city. It
  exists for a future navigation and population pass and should either gain an importer or be noted as dormant in
  the Layout table.
- The version is 1.4.0-beta.1 in `package.json`, `package-lock.json` and `brand.ts` together (the build gate compares
  them); the directive's "v1.0" is the product's name for the beta, not the package version, because a downgrade
  would break ordering.
- The README was brought up to date for this release after the wirings landed: the Layout table, the URL options
  (`?tracks`, `?players`, `?boot`, `?captions`), the Controls table (the Ping row), the console command list,
  Ghost-mode collision, Vehicles, Recruitment, Spatial audio, The model providers, the new Split screen, Character
  customizer and Networking sections, Constraints, Browser support and History. This document is the plan behind it.
