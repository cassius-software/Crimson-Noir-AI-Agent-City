# The joint bridge: robots in the realm (draft 0.1)

Status: **implemented in part, nothing tried on real hardware**. Every module named here is written and tested in
Node against simulated devices (a simulated arm, an in-test MQTT broker, fake serial links). No physical robot, no
real broker, no serial board and no BLE board has been connected: every statement about a real device is
**UNCONFIRMED** until someone runs it. The pure halves (`jointState.ts`, `urdf.ts`, `actuatorFit.ts`,
`sparkplug.ts`, `mqttCodec.ts`) are proved against fixtures and published byte vectors; the stateful halves (the
relay, the HAL bus, the realm) against simulated peers.

> **Real-world caveat.** This is a software gate and a simulation, not a safety case. The city cannot certify that a
> real arm or vehicle is safe to drive. The device's own firmware must enforce its own limits, its own watchdog and
> its own stop independently of anything the city sends. A device that moves must have a physical stop within reach.

## 1. Why

The city's realm is a deterministic physics loop at 60 Hz (`simCore.ts`). The joint bridge lets a robot stand in it:

- **Real2Sim ("twin").** A real or simulated robot reports its joints; a body of the same links and joints in the
  realm follows it, so the city sees what the robot is doing, in the city's own metres, with the city's own contacts.
- **Sim2Real ("leader").** The body in the realm is driven by the operator (the console) and its joints go out to the
  robot as setpoints, through the same gate every actuating peripheral has to pass (docs/hal-peripherals-spec.md).
- **Calibration.** The city measures how the robot answers, the link's round trip and a step on one joint at a time,
  and gives the twin the same lag, so what the body does in the realm is what the robot will do a moment later. It is
  a latency and response calibration: no load-side stiffness is measured.

The state vector is URDF's: per movable joint a position q (rad or m), a speed q̇ (rad/s or m/s) and an effort τ
(N·m or N), in the manifest's order. Fixed joints carry no state. Floating and planar joints are not built.

## 2. Words

| Word | Meaning |
|---|---|
| **manifest** | A robot's description: links (name, mass, shape), joints (kind, parent, child, origin, axis, limits), and `movable`, the indices of the joints that carry state, which is the order of every q, q̇, τ array. `jointState.ts buildManifest` is the single judge; a URDF file becomes one through `urdf.ts parseUrdf`. Bounds: at most 32 links and `MAX_JOINTS` = 64 movable joints; the realm builds at most `REALM_BOUNDS`: 500 kg a link, 3 m a shape, 3 m an offset, revolute, continuous, prismatic and fixed joints only. |
| **frame** | One reading, device → city (`JointFrame`): `stamp` (ms, the sender's clock, never compared with ours), `seq` (rising), `q`, `qd`, `tau` (each `movable.length` long or empty), and `ack`, the `seq` of the last setpoints the device applied, when it says. |
| **setpoints** | One command, city → device (`JointTargets`): the gate's three words `seq`, `issuedAt`, `ttlMs`, and `q`, `qd`, `tau` (where to be, how fast to be moving there, at most how hard; an empty `qd` or `tau` means 0 / the joint's own cap). |
| **robot id** | `hal:<device id>` for a HAL/1 device, `ws:<n>` for a WebSocket peer of the relay, `<group>/<node>/<device>` for a Sparkplug device, `sim:<name>` for a body spawned from a manifest alone. |
| **mode** | `twin`: the realm's body follows the robot's frames. `leader`: the body follows the console and the body's joints go out as setpoints. `watch`: frames are shown, the body holds. `sim`: no robot, the body answers the console with the calibrated (or default) lag. |
| **caps** | The device's capability declaration (docs/hal-peripherals-spec.md §3): class `actuator` with `servo` in `actuation` is what lets a robot be armed. A robot that sends joints but no caps is a sensor: `twin` and `watch` work, `robot arm` says not-declared. |

Never written in the console's usage, summaries, HUD or this document: the singular of "setpoints" as a noun for
what is aimed at. Say setpoint, command or goal.

## 3. The three doors

Every door delivers the same four things: a manifest (once), frames (often), setpoints (only through the gate), and
the gate's own lines (caps, arm, armed, beat, disarm, ack). The page never opens a socket to anything but loopback
(`airgap.ts netServer`); what is not on this machine reaches the page through the relay.

### 3.1 HAL/1 over Web Serial or BLE (`lineLink.ts`, `hal.ts`)

Framing unchanged: UTF-8 lines ending in `\n`, at most 1,024 bytes; `HELLO`/`READY`, then `PING`/`PONG`; `CAPS 1
{json}` right after `READY` as the peripherals spec says. The extension (`jointState.ts JOINT_LINE`):

| Direction | Line | Meaning |
|---|---|---|
| device → host | `JOINTS 1 {manifest json}` | The manifest, after `READY` and `CAPS`. Over 1,024 bytes it is sent in parts `JOINTS 1 <i>/<n> {part}` (1-based, at most 64 parts, all within 10 s). A manifest the judge refuses is ignored and logged; a second `JOINTS` replaces the first only while the device is disarmed. A board that resets re-announces the same device id. |
| device → host | `JS {frame json}` | A frame, at the device's rate; the newest wins. |
| host → device | `JT {setpoints json}` | Setpoints, only after the gate admitted them, at most 20 a second on serial and 10 a second over BLE (the newest wins when the host is faster). |
| device → host | `JA <seq>` | The setpoints of that `seq` were applied (a frame's `ack` says the same). |

A HAL/1 robot may have at most `JOINT_LINE.halJoints` = 24 movable joints (q, q̇ and τ at five figures fit the
line); a bigger robot speaks to the relay. The device rule, which the simulated arm implements and a real device
must: **hold q and report q̇ = 0 and τ = 0 when no admitted `JT` has arrived for 500 ms or the current `ttlMs` has
elapsed, judged from arrival; resume on the next fresh `JT`.** The host re-sends a held setpoint every 200 ms so a
standing command never lapses while armed.

### 3.2 The loopback relay (`robotRelay.node.ts`, `npm run serve:robots`)

A second Node module serves the network: the room host (`replication.node.ts`) and the robot relay, both bound to
`127.0.0.1` unless `ROBOT_HOST` says otherwise (the same `?? '127.0.0.1'` rule zeroTrust pins). Default port 8790
(`ROBOT_PORT`); port 0 in tests. It prints two tokens at start, minted with `replication.node.ts mintToken` from
`ROBOT_SECRET` (16+ characters; a random one when unset, printed when `ROBOT_PRINT_TOKEN=1`): a **page** token
(subject `page`) and a **robot** token (subject `robot`), each a day long.

Two WebSocket paths, text frames only, each frame at most 1 MiB, JSON objects with a string `t`:

- **`/` (the page).** Needs the page token as `auth.<token>` in the subprotocol list beside `joints.1`, and an
  `Origin` header that is a loopback origin (`http://127.0.0.1:*`, `http://localhost:*`, `https://` the same); an
  absent or `null` Origin is refused 403. One page at a time arms; a second page connection may watch.
- **`/robot` (a peer).** Needs the robot token the same way. This is how a ROS 2 bridge script, a vendor adapter or
  the simulated arm joins.

Peer → relay (`/robot`): `{t:'hello', v:1, manifest | urdf, caps}` first (a `urdf` string is read by `urdf.ts`;
`caps` is the CAPS body: `{class, telemetry, actuation}`), then `{t:'state', frame}` at its rate, `{t:'armed',
nonce}`, `{t:'beat', n}` (at least every 200 ms while armed), `{t:'ack', seq}`. Relay → peer: `{t:'welcome', id,
manifest, order}` (`order`: the movable joints' names), `{t:'arm', nonce}`, `{t:'disarm', cause}`, `{t:'targets',
setpoints}`.

Relay → page: `{t:'hello', relay, robots:[{id, name, via:'ws'|'mqtt', manifest, caps}]}`, `{t:'robot', id, gone?}`
on change, `{t:'state', id, frame}` (the newest per robot per flush, flushed at most 120 times a second), `{t:'armed',
id, nonce}`, `{t:'beat', id, n}`, `{t:'ack', id, seq}`, `{t:'echo', seq, at}` (the page's own echo back),
`{t:'refused', id, why}`. Page → relay: `{t:'echo', seq, at}`, `{t:'arm', id, nonce}`, `{t:'disarm', id, cause}`,
`{t:'targets', id, setpoints}`.

The relay is a **second gate**, not the gate: it forwards setpoints only for a robot it armed for this page
connection, with a rising `seq`, finite numbers, arrays of the manifest's length, `issuedAt` within `ttlMs` by its
own clock plus a round-trip allowance of 100 ms, under 25 a second per robot; anything else is dropped and
`{t:'refused'}` says why. When the page connection that armed a robot closes, the relay sends every robot it armed
`disarm` with cause `page-gone`. Limits: `hello` at most 512 KiB, `state` and `targets` at most 16 KiB, a peer or a
page whose socket backlog passes 512 KiB is closed. Every relay-side count (accepted, refused by reason, disarmed)
is kept and printed on `SIGINT`.

### 3.3 MQTT Sparkplug B (`sparkplug.ts`, `mqttCodec.ts`, inside the relay)

When `ROBOT_MQTT=mqtt://host:1883` is set (plain TCP, MQTT 3.1.1; user and password from `ROBOT_MQTT_USER` /
`ROBOT_MQTT_PASSWORD`; the broker must be on loopback unless `ROBOT_MQTT_ANY_HOST=1`), the relay is a Sparkplug B
**Host Application** named `ROBOT_SPARKPLUG_HOST` (default `agentcity`), client id `agentcity-<8 hex>`, keepalive
30 s (PINGREQ every 20 s, a missed PINGRESP closes). The session, in the order the specification requires:
CONNECT with clean session and a Will on `spBv1.0/STATE/<host>` carrying `{"online":false,"timestamp":T}`
(QoS 1, retained) → SUBSCRIBE `spBv1.0/#` and the host's own STATE → PUBLISH `{"online":true,"timestamp":T}`, the
same `T` as the Will, retained → re-publish online when a retained offline with an older timestamp arrives. A SUBACK
of `0x80` is logged and the connection closed. Reconnect with a backoff from 1 s to 30 s and a full new session.

A device is a robot when its DBIRTH carries `Joints/Manifest` (String, the manifest JSON). The convention
(`JOINT_METRICS`): per movable joint `Joints/<name>/q`, `/qd`, `/tau` (Double, aliased or named); `Joints/Seq`,
`Joints/IssuedAt`, `Joints/TtlMs` (Int64) declared by a robot that accepts setpoints; `Joints/Caps` (String, the
CAPS body), `Joints/Arm` (String, written by the host), `Joints/Armed` (String, echoed by the device), `Joints/Beat`
(Int64, published at least five times a second while armed, whether or not it changed), `Joints/Ack` (Int64).
Setpoints go out as a DCMD to the device's topic, QoS 0, not retained, with a payload timestamp and no `seq`, using
the names or the aliases the birth declared; arm and disarm are DCMDs writing `Joints/Arm` (the nonce, or
`DISARM <cause>`). Frames come from DDATA merged onto the last frame (report by exception); an `is_null` metric reads
as NaN, which `checkFrame` refuses, which holds. The rules: DDATA before DBIRTH is ignored; NDEATH whose `bdSeq`
matches the NBIRTH takes every device of that node offline and disarmed; DDEATH takes the device offline; a gap in
`seq` sends `Node Control/Rebirth` (NCMD), debounced 5 s; every NCMD and DCMD the broker delivers to the host is
ignored (only devices take commands). Not built: templates, datasets, properties, QoS 2, TLS.

## 4. The gate

The gate is `peripheralPolicy.ts admit`, pure, with a new command: `{ kind: 'joints'; capability: 'servo'; seq;
issuedAt; ttlMs; q; qd; tau }`. Beyond the common checks (lock, declared `servo`, operator tier, a live lease,
armed, a heartbeat under 500 ms, a rising `seq`, `ttlMs` ≤ 250, under 20 commands a second) it checks that every
array is empty or `joints` long (the count is the third argument of `initialState`) and every number finite.

How the page uses it (`robotLink.ts`):

- **The lease** is console-held: `robot arm <id>` makes it; it is aborted, which disarms, when the robot's body is
  more than 12 m from the operator, on `robot disarm`, `operator lock`, a halt, a hidden page (`visibilitychange`,
  `pagehide`) or the door closing.
- **Operator** is read from the engine's operator gate on every arm and admit.
- **Decimation.** The realm offers a setpoint every step; the page sends at most 20 a second (10 over BLE), the
  newest winning, and re-sends a held setpoint every 200 ms. The 50 ms period is part of what calibration measures.
- **Staleness.** A frame older than 500 ms marks the robot `stale`; a twin then holds.
- **Halt.** `Engine.halt()` calls the bridge's `panic()` before the HAL bus is disposed: DISARM on every door.

## 5. The realm

`articulated.ts` builds the body: one dynamic Rapier body per link (the root fixed where it was placed, at
`x, y, z, heading`), a contact shape from the manifest's shape (a shapeless link is a 2 cm ball), every shape in the
ragdoll contact groups (links never meet people, cars or each other, so robots are outside the Ring-0 audit by
construction), revolute and prismatic joints with the manifest's limits, fixed joints as fixed. Rapier's joint motors
are not used (under a steady load they leave a share of the error uncorrected and cancel feed-forward); each joint
is driven by a velocity servo of equal and opposite torque impulses, sized by the inertia of everything below the
joint in its present pose reduced with the parent link, with the weight below fed forward and the whole capped at the
joint's effort (`ROBOT.servoRate` 30 /s, `ROBOT.servoShare` 0.9). q is read from the joint frames, q̇ as the change
of q over the step, τ is the torque the servo applied (the actuator torque of the twin, not a sensed one).

`jointRealm.ts` holds at most `MAX_ROBOTS` = 4 bodies and runs them inside the realm's step: before the substeps it
takes the newest setpoints per robot; in every substep it measures, then drives. The commands (`simProtocol.ts`):

| Command | Meaning |
|---|---|
| `{c:'robotSpawn', id, manifest, x, y, z, heading}` | Build the body (`buildable` first). A refused build leaves the slot empty: the page, which ran `buildable` itself, reports the realm refused. |
| `{c:'robotRemove', id}` | Remove it. |
| `{c:'robotTargets', id, seq, q, qd, tau}` | Setpoints for this step (one per robot per step; the newest wins). |
| `{c:'robotMode', id, mode:'follow'|'filter'|'hold', tauMs?, delaySteps?, shaping?, friction?}` | `follow`: track the newest setpoints (a twin following frames: first-order hold on q̇ for up to 100 ms, then hold). `filter`: every setpoint is held back `delaySteps` steps (`DelayBuffer`) and passed through `y += (u − y)(1 − e^(−h/τ))`, the calibrated lag (a leader's body, a `sim` body). `hold`: stand still at the effort cap. Setpoints older than 500 ms hold in every mode. `shaping` (one entry per movable joint, `null` for the filter) puts the second-order reference actuator of section 6 in place of the filter on that joint, with its own delay; `friction` (one per movable joint, `null` for none) is a Coulomb, viscous and stiction torque the realm applies about the joint after the servo. Both are kept when not given and cleared by an empty array; every number is judged before any of it is kept, so a bad command changes nothing. A body that stops being finite is removed and counted as a rejection. |

**Joint friction** (`jointRealm.ts`, applied through `articulated.ts` `jointTorque`, the servo's own equal and
opposite impulse pair): Coulomb `c` and stiction `s` in N·m or N, viscous `b` in N·m·s/rad or N·s/m. A joint moving
slower than 0.01 rad/s or m/s whose servo asks less than `s` (the demand net of the weight it feeds forward) is held:
friction cancels the servo's push and takes out the creep it had, on the reduced inertia the servo uses. Otherwise
`c + b·|v|` opposes the speed `v` the servo's impulse leaves the joint with, clamped to what brings `v` to rest within
the step and never over the effort cap, so friction only takes speed away and the servo's stability bound stands. In
the test a joint stopped by friction at its whole cap moves back by the solver's own position correction alone, under
a tenth of a milliradian. Coulomb and stiction are judged within the joint's effort cap. τ in the slot stays the
servo's applied torque.

Frames out, every step, through the **joint buffer** (`jointBridge.ts`): one SharedArrayBuffer the page sends once
(`{t:'joints', buffer}`), with its own lock and header (Int32 words: `lock`, `seq`, `step`, `robots`, `simTimeMs`,
16 words), then `MAX_ROBOTS` slots of Float32 words: 8 slot words (`id`, `joints`, `links`, `flags` (bit 0: holding),
`ack` (the `seq` of the setpoints the body is tracking), three reserved), `q[64]`, `qd[64]`, `tau[64]`, and 32 link
poses of 7 (x, y, z, qx, qy, qz, qw, world frame). Without shared memory (the page from a file) the same slot words
travel in `StepState.robots` (a Float32Array of `robots × 424` words, null when there are none) and the page fills
the same layout from it. Setpoints go in as commands, never through the buffer.

## 6. Calibration (`actuatorFit.ts`)

`robot calibrate <id> <joint>`, armed, one joint at a time:

1. **Round trip.** Each setpoint's `seq` and send time are kept; the first frame whose `ack` ≥ `seq` closes the
   measurement (an exponential average, α = 0.2, and the minimum are kept).
2. **Step.** The joint is held 500 ms, then asked to move min(5 % of its range, 0.1 rad or m), never less than
   0.001, toward the farther of its limits (a continuous joint steps 0.1 rad up); the response is recorded for up to
   3 s or until it has been within 2 % of its final value for 300 ms. A joint that never moves (gain under 5 %) or
   never settles is reported as such.
3. **Fit.** A first-order lag with a delay (gain K, delay L, time constant τ): the two-point rule from the 28.3 %
   and 63.2 % crossings, refined by a bounded search on the squared error.
4. **Mapping.** `gainsFor(fit, returnTripMs)`: the twin's filter takes `tauMs` = τ and `delaySteps` =
   round((L − return trip) · 60 / 1000), never below 0 and at most 120 (L was timed from the page, so the link is in it
   twice). The result is shown and applied to that robot's `filter` mode.

`robot fit <id> <joint>` runs the same hold and step and fits the recording twice:

5. **Second-order fit** (`fitStep2`): gain K, delay L, natural rate ω, damping ζ, the response
   `y0 + K·Δu·s(t − L)` with `s` the closed-form unit step response (under-damped, critically damped within 10⁻⁶ of
   ζ = 1, over-damped). Seeded from the first-order fit (ω = 1/τ, ζ = 1, and starts that put the 63.2 % crossing where
   the first-order fit had it, and heavily damped starts that answer like the first-order fit itself, so the search
   never starts worse than the model it must beat); the four best seeds descend by a shrinking coordinate search over
   (L, ω, ζ) with diagonal moves in (ω, ζ), the gain re-solved by least squares at every point. On a clean recording
   of a second-order plant ω and ζ come back within 3 % and 5 % (15 % and 25 % over-damped, where the poles and the
   delay trade off along a flat valley), the gain within 1 %.
6. **Occam** (`pickFit`): the second-order model is taken only when it lowers the first-order fit's rmse by 10 % or
   more, and never when the first-order rmse is already under 0.2 % of the response.
7. **The reference actuator** (`ActuatorShaping`, `gainsFor2`, `stepShaping`): a chosen second-order fit becomes
   that joint's shaping: ω (clamped to 1/h, 60 rad/s at 60 Hz), ζ, the gain (0.05 to 10), the delay counted as
   `gainsFor` counts it, and the joint's own speed cap. In `filter` mode the delayed setpoint drives
   `ẍ = ω²(K·r − x) − 2ζω·ẋ` (a speed cap; Coulomb, viscous and stiction terms of its own, which a domain leaves at 0),
   stepped semi-implicitly in four sub-steps with the damping implicit: bounded for any ζ ≥ 0 up to the clamp, within
   0.5 % of the closed form at ω 10, 2 % at ω 30 ζ 0.5 and 6 % at the clamp with ζ 0.3. The servo tracks the
   reference, its speed fed forward.

**Domain randomization** (`randomizeDomain(seed, manifest, base?)`, `robot shape <id> <seed>`): from `createRng(seed)`
alone, in a fixed order, so a seed is the same world on any machine. Every link's mass × [0.8, 1.2] and its
`inertiaScale` × [0.7, 1.3]: a URDF's inertia tensor is not read, so the manifest's one inertia word scales the
link's shape-derived tensor at the same mass (`articulated.ts` `shapeInertia`, the closed forms checked against what
Rapier derives). Per movable joint a friction relative to its own caps: Coulomb 0 to 5 % of the effort cap (a
geared servo's running friction is a few percent of its rated torque), stiction one to two times that, viscous
costing at most 10 % of the effort at the speed cap. Per movable joint a shaping jittered about the fitted one (or a
nominal 20 rad/s critically damped servo): ω and ζ ±25 %, the gain ±2 %, up to one more step of delay. The page
re-spawns the body from the randomized manifest and sends the friction and shaping with the mode.

## 7. Console (`robot`)

`robot` (list: id, door, mode, joints, name, state: armed, body, last frame age or stale, calibrated, refusals) ·
`robot relay <ws url> <token>` / `robot relay off` / `robot relay` (status) · `robot spawn <id> [x z]` (a body for a
robot that announced itself, or `sim:<name>` from `robot urdf` or `robot demo`; two metres before the operator when
no x z is given) · `robot urdf <loopback url> [name]` (a `sim` robot from a URDF file served on this machine) ·
`robot demo [name]` (the built-in three-joint arm, `sim:demo`, so the bridge can be tried with nothing attached) ·
`robot mode <id> twin|leader|watch|sim` · `robot set <id> <joint> <q>` (a leader's or sim's setpoint, clamped to the
joint's limits) · `robot arm <id>` / `robot disarm <id>` · `robot calibrate <id> <joint>` · `robot fit <id> <joint>`
(both models, Occam choosing, the choice applied to that joint) · `robot shape <id> <seed>` / `robot shape <id> off` /
`robot shape <id>` (the body re-spawned where it stood from the seed's domain, the plain body back, or the domain's
table: each link's factors, each joint's friction and shaping; a re-shaped robot is disarmed, since the new body
stands at q = 0) · `robot cell` / `robot cell <kind> <station>` (every station of every room with its cell kind, or
the cell's robot as `sim:<kind>-<station>` at that station, facing its yaw) · `robot remove <id>`.
The relay, a spawn, a cell, a shape, a URDF read, arming, calibrating and fitting are the operator's
(`operator unlock`); the list, the demo, a mode, a setpoint, a disarm, a remove, the relay's status or its off, the
stations' list and a domain's table run at any time.

**Workstation cells** (`cells.ts`): `arm` (six revolute joints, a tabletop collaborative arm of 14.6 kg, 60 N·m at the
shoulder to 6 N·m at the tool), `gantry` (two prismatic axes of 1.2 and 0.8 m under a slab and a wrist), `shaker`
(one vertical axis of ±25 mm, 2 kN), `treadmill` (one continuous joint, a gait belt's roller: 30 rad/s is 1.5 m/s) and
`console` (no robot). A workplace kind id maps to a cell by string, `console` for any kind the table does not know:
roboticsLab, kitchen and fleetBay an arm; warehouse, microFab and greenhouse a gantry; acousticsLab a shaker; gaitLab
(and the clinic it replaces) a treadmill; the rest a console. `toUrdf(manifest)` writes any manifest back out as URDF
that `urdf.ts` reads to an equal manifest (every cell and the demo arm are tested), so a cell can go to a ROS tool. HAL/1 robots arrive
through `hal pair serial|ble` and `hal.autoconnect` (granted ports re-open at boot). The HUD shows `Robots · n` with
the armed count and the first robot's line; the namespace carries the count under `Hardware/Bus/robots`.

## 8. Limits, and what is not built

- No LAN scan, no mDNS, no UDP: "discovery" means what announces itself to the relay or the broker. Nothing opens at
  boot but the HAL/1 ports the browser already granted.
- Fixed-base robots only (the root link is fixed where it was placed). Wheeled bases, floating and planar joints,
  mimic joints applied, meshes (a mesh link is shapeless and gets the stand-in ball), Sparkplug templates and
  datasets, QoS 2, MQTT over TLS, the recorder, the network room's mirror of robots: not built.
- A HAL/1 robot is at most 24 joints; a relay robot at most 64; four robots at once.
- τ reported by a twin is the servo's applied torque; a device's τ is whatever it reports.
- Nothing in section 6 has met a physical robot: the second-order fit, the reference actuator, the friction and the
  domain are proved against plants of known numbers in Node and against Rapier, not against an actuator. Inertia is
  randomized as one scale on the shape's own tensor (a URDF's full tensor is not read or written); the reference's
  own friction terms exist but a domain leaves them at 0 and puts friction on the joint. A cell's robot stands at a
  station the crowd's workday still uses; its links never meet people (section 5), so a worker and the robot share
  the spot.
- `tools/robot/ros2_bridge.py` is an example of a `/robot` peer written from the ROS 2 Python API's documentation and
  never run against ROS 2 here.

## 9. Where it plugs in

| Piece | File |
|---|---|
| Vocabulary, lines, judges | `src/04_Connect_Hardware/jointState.ts` |
| URDF | `src/04_Connect_Hardware/urdf.ts` |
| Calibration, the second-order fit, the reference actuator, the domain | `src/04_Connect_Hardware/actuatorFit.ts` |
| Workstation cells, URDF out | `src/04_Connect_Hardware/cells.ts` |
| The gate's command | `src/04_Connect_Hardware/peripheralPolicy.ts` |
| HAL/1 lines in and out | `src/04_Connect_Hardware/lineLink.ts`, `hal.ts` |
| The page's bridge and console | `src/04_Connect_Hardware/robotLink.ts`, `src/engine.ts` |
| Sparkplug B, MQTT | `src/10_Network/sparkplug.ts`, `mqttCodec.ts` |
| The relay | `src/10_Network/robotRelay.node.ts` |
| The body, the pool, the buffer | `src/07_Execute_Actions/articulated.ts`, `jointRealm.ts`, `jointBridge.ts` |
| A peer to try it with | `tools/robot/sim-arm.mjs` (`node tools/robot/sim-arm.mjs ws://127.0.0.1:8790/robot <robot token>`) |
