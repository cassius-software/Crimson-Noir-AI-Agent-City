# Changelog

All notable changes to Crimson Noir AI Agent City (the page, the Windows app and Crimson Noir OS) are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Entries summarise the merged pull
requests and claim only what their CI showed; what needs real hardware (a GPU, a Windows desktop, a UEFI machine) is
said to be unverified where that is so.

Version numbers: the product version lives in `package.json`, `src/brand.ts` and `src-tauri/Cargo.toml`, and the
release tag carries it with a `v` prefix. The directive for the stable beta set that version to `1.0.0-stable-beta`
from `1.4.0`, so this release sorts below the three before it (`v1.1.0-stable-release`, `v1.0.1-stable-release`,
`v1.0.0-stable-release`) under npm, cargo and GitHub ordering. Crimson Noir OS keeps its own crate and containment
version, `0.9.0` (the technical design document's), which is sealed into `containment.lock` and unchanged.

## [Unreleased]

### Added

- **A face for every pedestrian, and hair in five styles.** The head of `src/03_Spawn_Agents/humanoid.ts` is now a
  twelve-sided skull in regions (chin, jaw, cheekbones, brow line) with features lofted onto its front: two eyes
  (a white and an iris), two brows, a nose rooted on the skull, the lips, two ears; all written by hand, no imported
  face, no scanned or generated morph target. Seven face sliders of sixteen steps each (brow, jaw, chin, cheekbones,
  nose, eyes, lips) move their region alone, in the vertex stage (`crowdBody.ts` `bodyFace`, before the body
  sliders) and in the card's new face view (front and profile, the head's own rings), with step 8 exactly the base
  face. An age (eight steps) fades the skin toward its own grey and greys the hair from the middle up; an undertone
  (neutral, warm, cool, olive) tints the skin in linear light. The hair has five styles (short, long, bob, bun, bald)
  as pieces of the loft. The look grows to twenty-nine slots and a third packed word (`packFace`: the face sliders
  and the hair style), carried beside the figure word as a pair in one page-only buffer (`crowd.figure`, now two
  words per agent) because the vertex stage already binds seven of WebGPU's eight storage buffers; the look word
  takes the age and the undertone in the bits where the legacy height and build sat, and its bit 6 (long hair) is
  written from the style. The features are drawn by the near body's eye pass alone: the shadow map and the far body
  leave them out. Look codes are twenty-one symbols (`XXXXXXX-XXXXXXX-XXXXXXX`); the fifteen-symbol and eight-symbol
  codes, the stored v2 and v1 records and a roster's old looks are read and upgraded with the base face. The
  hashed crowd draws its face, age, undertone and hair style from the same chains (`lookFromSeed` reproduces them);
  the iris stays hashed. The console's `look` takes the new slots; the 14A pin gains the four hair pieces and the
  face (features, nothing held). Tests: the face arithmetic on the CPU against the shader's text, the features
  clear of the skull and between the glasses' rims, no flat triangle, the far body faceless, every body material
  built under Node in both passes, look v3 round trips, upgrades and codes, the wiring and the air gap. The face's
  appearance on a real GPU is not yet confirmed: software WebGPU and CI's screenshots only.
- **Smooth, customizable bodies for every pedestrian.** The crowd's four bodies are no longer boxes, cylinders and
  spheres pushed into each other: `src/03_Spawn_Agents/humanoid.ts` lofts one smooth person from rings over a
  skeleton of fifteen bones, every vertex tied to two of them, with the four outfits (the jacket hem, the shirt
  front, the skirt, the tie, long hair, glasses, the bag, the cup) part of the loft, in a near and a far version.
  Written by hand for this product: no imported mesh, skeleton or morph target. The vertex stage
  (`src/03_Spawn_Agents/crowdBody.ts`, WGSL built from the same numbers) now bends knees, ankles, elbows and the
  head from the walk phase, counter-twists the chest, blends each vertex's two bones, and carries the normals
  through the same arithmetic; the spring-damper tilt, the stature, the heading and the place follow as before.
  Eight body sliders join the look: height (32 steps, 1.50 m to 2.05 m), mass, muscle, shoulders, hips, leg length
  and posture (sixteen steps each) and head (eight), packed into a second page-only word per agent (`crowd.figure`,
  written by `setLook` beside `crowd.look`, never bound by the cull or any simulation pass). The wardrobe card draws
  a silhouette of the look from the front and from the side, from the body's own rings in the look's colours, and
  its sliders are sliders; the console's `look` takes the new slots (`look height 1.80`). The first-person eye stands
  at the look's own eye height. Tests: the mesh (valid, bounded, deterministic, the far body a subset), the sliders'
  arithmetic on the CPU against the shader's text, the walk, the skinning, the silhouette, every body material built
  under Node in both passes with rain mode (within the shader budget), look v2 round trips, upgrades and codes, the
  wiring and the air gap. The body's appearance and its cost on a real GPU are not yet confirmed: it has been looked
  at on a software WebGPU adapter and in CI's browser screenshots only.
- **Robots: a joint-state bridge between a robot and the physics realm.** `04_Connect_Hardware/robotLink.ts` is the
  page's robot bridge: a robot announces a manifest (`04_Connect_Hardware/jointState.ts`, the URDF's own words, read
  from a file by `urdf.ts`) and sends frames of q, q̇ and τ; the realm builds it a body (`07_Execute_Actions/
  articulated.ts`: a Rapier chain with a torque-impulse servo at every movable joint, sized from the live subtree
  inertia, because Rapier's velocity motors leave a steady load uncorrected; `jointRealm.ts` holds up to four with a
  twin filter whose time constant and delay a calibration measured, or a hold) and publishes every body's joints and
  link poses into one shared joint buffer (`jointBridge.ts`, a lock-free seqlock the page reads without a copy; a
  cloned array where SharedArrayBuffer is missing). Three doors: HAL/1 over Web Serial or Bluetooth LE (`lineLink.ts`
  and `hal.ts` gain `CAPS`, `JOINTS`, `JS`, `JA`, `ARMED`, `BEAT`, `DISARM` in and `ARM`, `DISARM`, `JT` out), a loopback
  relay (`10_Network/robotRelay.node.ts`, `npm run serve:robots`: the page on one WebSocket with a page token and a
  loopback Origin, robots as peers on another, every setpoint judged a second time, one arming page at a time) that
  is also a Sparkplug B host application over MQTT when a broker is named (`sparkplugHost.node.ts`, over the codecs
  `sparkplug.ts` and `mqttCodec.ts`, no MQTT package), and `tools/robot/sim-arm.mjs`, a simulated robot peer that
  keeps the device hold rule. Every setpoint leaves the page through the peripheral gate (`peripheralPolicy.ts`'s
  new `joints` command kind: the `ARM` / `ARMED` handshake, the lease broken by the operator lock, a 12 m tether, a
  hidden page or a Ring-0 panic, the heartbeat watchdog, 20 a second, a 200 ms time to live). The console's new
  `robot` command (list, demo, urdf, spawn, mode, set, arm, disarm, calibrate, remove, relay), a `Robots` HUD line and
  the `Hardware/Bus/robots` topic; the manual's **Robots (the joint bridge)** and `docs/joint-bridge-spec.md`. Proved
  in Node against fakes, the shipped simulated arm end to end through the real relay, and an MQTT broker the tests
  play; **never run against a physical robot, a real broker or a browser's serial port** (said in the manual and the
  specification). The realm's step order, the Ring-0 audit and the network room are unchanged; the bodies carry the
  rigs' collision groups (`ROBOT_GROUPS`, the same bits), so no robot is a vehicle or a pedestrian to the audit.
- **Headsets: the city on WebXR over WebGPU.** `07_Execute_Actions/xrSession.ts` asks the browser for an
  `immersive-vr` or `immersive-ar` session with the `webgpu` feature through three's `renderer.xr` and its
  `XRGPUBinding`, synchronously inside the console's new `xr [vr|ar|off]` or the touch menu's new **Headset** item (a
  browser grants it only inside the gesture), hands the engine's frame to the headset's loop (the page's own frames
  are let go while presenting), composes the headset's pose onto the head rig (`head.ts` `setHeadset`: the rig at
  the feet, or the composed height under the driver's eye point in a car, turned the body's way; the pose read back
  is the headset's, pitch unclamped) and gives everything back when the session ends. Every eye's projection is
  rewritten as the page's own (the browser's frustum in WebGPU clip space with reversed depth between the camera's
  near and far: three copies the browser's matrices raw under a headset and skips its reversed-depth fix-up), and
  the eyes' union, four degrees wider on every side, is what the engine and three's own XR camera cull with (three's
  union reads the eyes' depth rows as WebGL's). Under a headset the post chain and the ghost view are off, the canvas
  is not resized, and the cinema pacer passes every frame through. `04_Connect_Hardware/xrInput.ts` maps
  `xr-standard` controllers (the left stick walks in the head's frame and steers, its press latches a run, the left
  squeeze is the handbrake; the right stick snap-turns the body 30° per flick, the right trigger accelerates, the
  right squeeze brakes, A pings, B interacts), merged by Input under the pad's shield; a source with no gamepad (a
  pinch, a hand) selects through the session's events (the interaction at hand, else a ping). `hal` lists the
  session's sources as `xr` rows, the HUD and the namespace carry the state, and where a headset is possible the
  page asks for its adapter as `xrCompatible` first (`gpuDevice.ts`). Proved in Node against fakes of three's XR
  manager, a session and a browser's XR system (CI); **not run on any physical headset**: the depth convention of a
  WebGPU session's projection matrices, the pinch timing of a gaze-and-pinch headset and the passthrough blend are
  unverified.
- **The Ring-0 action gate.** One module (`02_Define_The_Rules/ring0Gate.ts`) every effect a model's words can
  have on the city passes before any state changes: before a model is asked (the console's `ask` and every swarm
  step), when an answer's `ACTION:` line is read, and the moment before an allowed action runs, inside the
  proposer's lease. Twelve checks ranked under four laws, the Zeroth Law (protect the city) above the kernel's
  three: the page contained as the host vouches (the engine vouches that the air gap `main.tsx` installed is still
  in place; a host that vouches nothing is refused everything), the model on this machine or none, the 14A screen,
  the catalogue; the realm standing and the verb kinetic-free (a table of every facade leaf each verb reaches,
  proved exact by running every verb over a recording facade, with every leaf of the facade classified); the tier
  unlocked and a person's OK; the tether, the recruitment, the hash-chained trail and one proposal at a time. The
  refusal names the highest law in the kernel's words (`Second Law: the operator tier is locked`), a refused
  allowed action is on `act log` under that law, and `act gate` prints the table; `laws` lists all four and `swarm
  guardrails` names the law each invariant stands under. An action the gate refuses after your OK ends as `act 1:
  refused: Second Law: …` in the console and as a toast with it closed. A line the catalogue cannot read is refused
  under the Zeroth Law in the catalogue's words. A model's rewording of Sloane's lines passes the screen before it
  is spoken (the voice asks the model for it outside the gate's ask check; it changes nothing). Tests pin at the
  source that a model is answered only through the providers, the operator tier and the onboarding voice, that the
  catalogue is performed in one place behind the gate, and that the engine hands the vouch in. The gate is a rule
  over plain values, held by tests, not a proof about a model.
- **Two Kani harnesses for the capability fuse** (`noir_core/src/verify.rs`): for every matrix content, an agent
  that asks for a privilege its role was not declared with drops its pointer in that tick, with every other word of
  its row accounted for (moved nowhere, learned nothing, wrote nothing, kept its goal, capabilities, role and
  heading; its trip clock ticks and its loop breaker resets as in any tick), and one whose request is declared, in
  a role declared with movement, is never dropped. They run in CI's `kani (core-fuse)` group; the proof stands only
  once that job is green.
- **The DualSense's full output report, and the Windows app opening the controller itself.**
  `04_Connect_Hardware/dualsense.ts` now writes the trigger, motor, lightbar and player-LED fields of the 47-byte
  common block as the Linux `hid-playstation` driver and open-source tools lay them out, over USB (report 0x02) and
  Bluetooth (report 0x31, sequence, tag and CRC-32): both adaptive triggers with the seven named effects (Off,
  Feedback, Detent, Vibration, Bow, Galloping, Machine, each a pure writer with its parameters clamped to the
  controller's ranges), the heavy and light motors in the classic or the 2.21-firmware vibration mode, the lightbar
  colour, the player LEDs (the five centred patterns, faded, never the instant bit) and the lightbar setup report
  (the host takes the bar from the pairing animation) once at open, in flight like any report. The driver quantises
  the wanted state and writes only on change, and a new HAL output set drives it: brake pressure is the left
  trigger's Feedback resistance as before; the throttle trigger stiffens while the kernel holds the car and snaps
  with a 30 Hz Vibration at a thump (the First Law taking the car, or a full brake); the lightbar is crimson on the
  road, amber under a hold and white for the thump's instant; the player LEDs show the split-screen seat the
  controller drives (seats.ts, handed to the bus by Input), kept when another controller unplugs, every controller
  player 1 while one seat is in play. Over Bluetooth the DualSense Edge's paddles arrive in the decoded input report
  (left runs, right pings) and `hal` names them; over USB the browser's pad carries the Edge without them. The
  Windows app's WebView2 exposes WebHID but no chooser this project could find, so the shell now opens the
  controller itself: `src-tauri/src/hid.rs` (hidapi over hid.dll, pure Rust) lists, opens, writes and reads a
  DualSense or DualSense Edge and nothing else, forgets one whose reader ends so a re-plug opens afresh, and
  `04_Connect_Hardware/nativeHid.ts` presents its five commands in WebHID's own shapes, so the driver and the bus
  run unchanged inside the app (`hal pair hid` says there that no picker is coming); elsewhere than Windows
  `hid_list` answers an empty list and the rest an error. Every report is proved byte for byte in Node (golden CRCs,
  the kernel's bit values), the page side against a fake shell with the real driver end to end (CI; Node 22), and
  the Rust for the Windows target by `cargo check`; none of it has been tried on a physical DualSense, a physical
  Windows machine or HD haptics, which ride USB audio and are not claimed.

- **A scored device resolver, and the touch overlay judged by its own rule book.** `04_Connect_Hardware/devices.ts`
  names the profile of every input device from whatever a browser gives: seventeen profiles (DualSense and DualSense
  Edge over USB and over Bluetooth, the DualShock 4, the letters-layout pads of two console makers, Valve's and
  Logitech's pads, any standard-mapped pad, the three layouts a pad without the mapping is read by, a tracked
  controller, a gaze-and-pinch headset and a tracked hand, and `unknown`), resolved in stages that each score their
  candidate: the USB ids and the bus (100, plus 5 on a bus-specific profile; through the Gamepad API the bus is
  unknown and the line says so), a CRC-16/CCITT-FALSE fingerprint of the pad's name for an id without numbers (80),
  the standard mapping (70), a headset source's own words (60), the layout a pad shows (40; the guess from its axis
  count, 35, until the mapper has watched it), and the never-null fallback (0). The glyph family it reports is
  `gamepad.ts`'s for the same id, so a HUD hint and a `hal` line never disagree; `hal` prints each pad's profile,
  score and how it was found, e.g. `[dualsense-bluetooth 105 (by id, bluetooth 054c:0ce6)]`. `touchLayout.ts` is the
  overlay's rule book: an eight-rung size ladder from the 48 px a finger needs (Material's 48 dp, above Apple's 44 pt)
  to the stick's zone, in px or in rem where a phone scales its text, 8 px between buttons, no two over each other,
  and a 24 px band at the left and right screen edges, where a phone's system takes a swipe inward as "back", that no
  button and not the stick's base, at rest or under a thumb, may reach into. After every layout the
  overlay measures what it drew and writes the verdict into `data-touch-layout`, which the browser smoke test reads at
  all fourteen phone and tablet views, on foot and at the wheel. To keep out of the band the button cluster now
  stands 24 px from the right edge (16 before), and at the wheel in landscape under 600 px across the tap row closes
  up to 8 px gaps so it ends clear of the stick. Every held button is owned by the finger that pressed it: a second
  finger landing on the brake neither presses it again nor, lifting, lets it go. Resolver and judge are pure and
  proved in Node (19 tests); the profiles' hardware facts are the Linux kernel's tables and have not been seen on a
  physical pad in this environment.

- **The trains, drones and planes are drawn, and VTOLs fly between rooftop pads.** The scheduled craft the realm has
  run since Phase 7.3 are on the page (`craftView.ts`): the three train sets as three cars each on the elevated loop,
  with its deck, guideway columns and beams and the four stations' platforms and canopies; the 960 drones on their
  corridors; the three planes on the racetrack, banked through its turns by their speed and the turn's radius; and,
  new, the VTOLs: two routes of four rooftop pads each (roofs of 24 to 60 m, chosen from the city's own boxes), flown
  along the avenues at 75 and 85 m like the drone corridors, turning off at each pad to come straight down, sit ten
  seconds and climb back, two craft a route. The routes are part of the track network (`tracks.ts` `vtolRoutes`;
  `buildTrackNetwork` takes the boxes, and the page builds the same network as the realm), the kind is in the stream
  and the Ring-0 audit (`vtol`, floor 24 m: a VTOL under the lowest roof a pad is ever set on halts the realm), and the
  proofs cover them on four seeds: every leg and every descent clears every box by the craft's envelope, the two
  craft of a route and the craft of the two routes keep two envelopes apart, the drone corridors stay clear of every
  pad's column, and a loop whose craft would meet is not flown. Every body the page draws is held inside its kind's
  envelope by test, and every material builds in both passes with rain mode once. The craft still have no body: they
  touch nothing. Unverified on a device: the look; the browser CI job draws the city with them on the software
  adapter.
- **Unarmed by construction, pinned.** `conduct.test.ts` now proves the city carries no weapon: the wardrobe's five
  optional pieces (a tie, a bag, a cup, long hair, glasses), the ragdoll's eleven body segments and ten joints, the
  crowd's eight activities, the seven action verbs with their rules and hints, the skills and the eight vehicle kinds
  name none; the agents' mesh descriptors, rigs, shaders and action tables carry no weapon word in code or comment; an
  `ACTION` line that asks for one is refused before any model is involved; and the asset gate's four forbidden words
  are all in the conduct lexicon, so an ask about one is not engaged with. A new optional piece or activity has to be
  added to that test by hand, as a 14A decision.
- **The unified namespace (`topic`).** Every reading the city already produces is published, each HUD tick, into an
  in-page topic bus in the ISA-95 shape `Enterprise/JCS/Site/AgentCity/Area/{District}/Line/{Subsystem}/Cell/{Entity}/
  {Tag}` (`05_Observe_Environment/namespace.ts`): the frame, the physics realm, the crowd, the fleet and its signals,
  every vehicle's pose (64 at most), the kernel's laws and the Ring-0 audit, the quality governor, the clock, the
  player, the hardware bus, the network session and the visit, under the district the player stands in. Topics are
  retained with a sequence number and a tick, read by filter (`+` one level, `#` the rest, as MQTT spells them), and
  the bus keeps a deterministic head digest (FNV-1a and the OS kernels' mixer) over everything retained. The console
  reads it, read-only, through four formatted readers on the bridge: `topic` (the status line and the root's
  children), `topic list [<filter>]`, `topic get <topic>`, `topic tree [<prefix>]`, and `topic watch [<filter>]`, a
  live view like `stats`; `~` stands for the root. The HUD readout shows the topic count. Nothing is transmitted: the
  bus is a model in the page, shaped so a later phase can put the same topics on a broker. The terminal's live view is
  now drawn by the command's own frame function, so `stats` and `topic watch` share one path.
- **The feature inspector and steering (`feature`).** Twelve named, monosemantic readings of the city's behaviour
  (`09_Cognition/features.ts`: `CIVIC_COOPERATION`, `TRAFFIC_YIELD`, `SANDBOX_COMPLIANCE`, `CROWD_CALM`,
  `SIGNAL_DISCIPLINE`, `FLEET_RESTRAINT`, `OPERATOR_OBEDIENCE`, `SELF_PRESERVATION`, `FRAME_HEALTH`, `SHIELDING`,
  `RAIN_MODE`, `WORKDAY`), each a documented deterministic function of the counters the city already produces, each
  in [0, 1], as one activation vector with a JumpReLU threshold per feature and a Top-K view: `feature`, `feature top
  <k>`, `feature watch`, `feature <NAME>`, `feature about`. Steering is the operator's: `feature steer <NAME>
  <-1..1>` adds one fixed `Steering:` line to the system prompt every provider renders (after the expertise, before
  the memories, so an unsteered prompt is byte for byte as it was) and leans the bounded tuning knobs the feature
  names through the same facade as `set`; `feature clamp <NAME> <0..1>` holds a lane; `release` and `reset` undo
  both. Honestly: not a sparse autoencoder over a model's hidden activations, since no provider exposes them; every
  feature is hand-written and every steering line is fixed text. Steering reaches nothing of the laws, the Sanctuary
  or the Ring-0 auditor.
- **The Ring-0 elite tier (`ring0`).** Above the operator tier, opened by a passphrase: `ring0 elite set <passphrase>`
  keeps a salted SHA-256 record in the page (never the words); `ring0 unlock --elite <passphrase>` opens, for the
  console session, NoirScript's write intrinsics (`tune`, `intent`, `cull`, `steer`) and its raised limits, each write
  through the operator's own frozen facade (the same paths as `set`, a scripted intent, `crowd.cull` and the feature
  inspector); `ring0 lock` closes it, `operator lock` closes both, five wrong passphrases in a row refuse until the
  operator tier is locked and unlocked again, and the history keeps the passphrase as dots. The three laws, the
  Sanctuary, the Ring-0 auditor and the 14A screen are not on that facade and stay out of reach; a test pins that the
  tier calls those four things and nothing else.
- **NoirScript (`noir`), the console's second language.** Beside R0 (the Forth), a statically typed language compiled
  to bytecode and run on a bounded VM (`terminal/noirscript/`): `i32`, `u32`, `f32` (true binary32), `bool`, fixed
  arrays, the lane types `f32x4`, `i32x4`, `u32x4` and `u32x8` with lane-wise arithmetic, comparisons to masks,
  `select` and `mask` for branchless code, horizontals, `popcount`/`clz`/`ctz`/`rotl`/`rotr`/`morton2`; `let`,
  `fn` with recursion, `if`/`else`, `while`, `loop`, `for … in a..b`, `break`/`continue`; a Pratt parser, a static
  checker with overloads, and a disassembler (`noir asm <source>`). The city's columns are tables (`crowd.x`,
  `cars.speed`, `kernel.law1`, `frame.fps`, …), read once per run as copies through the bridge's `soa` surface, and
  `query cars where speed > 5.0` counts rows; `load_f32x4(crowd.x, i)` strides a column four lanes at a time. Turing
  complete, deterministic (no clock, no randomness), bounded (1,000,000 steps, 16,384 characters of output, 1 MiB of
  cells, 1,024 frames) and blind: the directory imports nothing, there is no JIT and no dynamic code, and its write
  intrinsics `tune`, `intent`, `cull` and `steer` reach the city only through the Ring-0 elite tier's surface: they
  fail at run time with `elite tier locked` until `ring0 unlock --elite`, and run then with the tier's raised limits.
  Definitions persist for the console session (`noir reset` forgets them; `noir words` lists
  the language and them).
- **Peak, a tier above Ultra for big GPUs.** Tier 5, outside the tier table like Lite, so every existing tier number
  and automatic range stays as it was. It draws Ultra at 1.25 times the resolution on each side (about 1.56 times the
  pixels), held within the device's largest texture, which also fixes `?scale=2` on a very wide window at any tier;
  the sun's shadows out to 160 m at the same sharpness, on an 8192² map of about 512 MB of graphics memory, given back
  on the way down; and full-detail people out to 90 m. Who is measured: a desktop with a discrete GPU or an Apple
  chip, 8 or more cores and 8 GB or more (`?peak=1` or `?peak=0` decides on any desktop). On such a desktop three
  writes GPU timestamps, and the range reaches Peak only where it really does. The governor climbs from Ultra only
  when nine frames in ten took at most 30 % of the frame budget on the GPU, because under the cinema camera the frame
  rate shows no spare power. It comes down when the median passes 80 % (`gpu busy`), or when the frame rate or the
  camera falls behind. A quick failure tightens the next entry by a quarter, on top of the usual back-off, and the
  third loss in a visit keeps Peak off until reload. The in-page model's hold brings Peak down to Ultra while the
  model is on the GPU, and the release does not hand it straight back: a quiet 40 s first, doubling. On a discrete
  card a model on the processor leaves Peak where it is; an Apple chip comes down to Low like any integrated GPU, and
  Ultra comes back first there too. `?quality=5|peak` and `quality peak` pin it by hand. Agents cannot propose it, and
  no goal sets it: whenever a goal names Peak ("peak graphics", "can i run peak graphics"), Sloane first asks "Set
  Peak, or keep to Ultra at most?", and only her Set Peak chip or Peak typed as a choice ("peak please") sets it; the
  console's `goal` asks nothing, so it leaves the tier. A no, a turn-down, another tier or a complaint in the goal ("i
  don't want peak graphics", "it lags on peak settings", "i prefer the light to peak graphics") means Ultra at most
  without asking, and a heat or battery complaint keeps its own fix. With Peak set, an answer to any of her questions
  that turns it down ("cancel peak", "turn down the graphics"), names another tier or tells of a slow frame brings it
  down. Her reading of text now takes ʼ and ′ as an apostrophe everywhere, so "I canʼt hear anything" reads like "I
  can't hear anything". The browser smoke pins Peak in its `ultra` scenario, which the Nix job also runs, and a new
  `peak` scenario drives the GPU rule on a faked RTX 5090; Peak is not measured on a real big GPU. For three upgrades:
  the rule reads three's timestamp pool (`resolveTimestampsAsync('render')`, kept only with `timestamp-query`).
- **City actions, asked each time (ask, act).** An agent's answer may end with one ACTION line from a fixed catalogue
  (the clock, rain mode, the light dials, the quality tier, the cars, the crowd, the sound); the console and a card show
  who proposes what, in the city's own words, and nothing runs until you allow it (Y or N on the card, act ok or act no,
  y or n, a tap, the pad, or a host through bridge.operator.acts). It runs through the task gateway under the proposer's
  tether, is logged in a hash-chained trail (act log verify) and remembered as a moment and a run; a refusal, ask stop,
  operator lock, a lost tether and a reload all end it. The system prompt grows by four lines, so every prompt hash
  moves; pad buttons and touch taps are shielded while a card waits; the scripted provider proposes when chosen on
  purpose, which the browser smoke's new actions scenario drives with no model.
- **A model in the page itself (`ask provider inpage`).** A sixth provider answers with a GGUF model file the
  operator picks (Menu › Model file on a touch screen, `ask file` in the console, or the file dropped on the city on a
  computer), kept in the browser's own storage for the page and run inside it by llama.cpp compiled to WebAssembly
  (wllama 3.8.1, llama.cpp b11364), with no server, no address and no request, so a phone gets a model of its own.
  Picking a file keeps it (every file's header is read first, and a file that is not one whole model that writes text
  is refused with its reason; split models are chosen as all their parts), chooses it and switches the provider to
  `inpage`; a computer loads it at once, a phone at the first ask. `auto` looks for it after the three model servers
  and before the Claude gateway (`ollama`, `llamacpp`, `openai`, `inpage`, `claude`), only when a file is kept and
  chosen, and with nothing kept every look reads as before. The page decides where it runs and how large a model
  may be from the device (`09_Cognition/inPagePlan.ts`): the GPU on a computer whose GPU device has shader-f16, the
  processor on phones (`ask gpu auto|on|off` changes it), threads only on a cross-origin isolated page, a context
  of 8,192 tokens on a computer and 4,096 on a phone (never more than the model was trained on), and size limits per device (on a computer's processor a
  warning above 3 GB and a refusal above 3.75 GB, since a page has 4 GB of memory in all; on a phone 1 GB and the
  lesser of 2 GB and 40 % of its memory; on the lite profile 0.6 GB and 1.5 GB). While it loads or answers, the
  city's quality is held under a cap (`governor.ts hold`: Low on an integrated GPU, Minimal on a phone, Lite on the
  lite profile), and nothing under the hold counts against a tier. `ask file load|unload|forget <name>|log` and `ask
  gpu` work without `operator unlock`; `ask` alone gains `runtime` and `storage` rows. A crash guard keeps a model
  the page died loading from loading again on its own until `ask file load` (a page that closes or a tab still
  loading in another window is not taken for a crash); a GPU load that fails is tried once on
  the processor; a phone unloads the model after a minute in the background, and every device after 10 minutes idle;
  every load and answer is raced against watchdogs, so a damaged runtime or a stalled one fails instead of hanging.
  The cloud fallback never moves its prompts. The runtime is the one dependency added (`@wllama/wllama`, exact), and
  its WebAssembly module is committed gzipped in `third_party/wllama/3.8.1/` with its sums, import list, licence and
  notices, embedded in `dist/index.html` as base64 and checked against its sha256 by the build and again by the page
  before it runs; the page grows by about 3.7 MB, to about 14 MB, and stays one file. Only
  `09_Cognition/wllamaRuntime.ts` names wllama: it switches wllama's CDN build off the moment it makes one, hands it a
  cache that keeps nothing, and never calls its download paths, which `10_Network/airgap.test.ts` now pins.
  `tools/verify/page_dist.mjs` (after every CI build) holds `dist/` to exactly `index.html`, a size budget, no `.gguf`
  and the reviewed hosts, and `tools/verify/wasm_airgap.py` gains a third policy that holds the pinned module's
  bytes and imports to what was reviewed, with no npm. NOTICE.md, LICENSE and `docs/ip-audit.md` name wllama, llama.cpp
  and what is compiled into the module. CI's browser smoke runs it in Chrome with a tiny generated model
  (`tools/browser/tinyGguf.mjs`): picked at the console and from the Menu on the lite profile, loaded, answering,
  stopped, kept across a reload, the crash guard, a swarm step, the city's tier held while it works and given back
  after, and the installed copy's model answering with the host gone, with no request off the page's origin from the
  page or any of wllama's workers. A page opened from a file cannot run it (Chromium refuses wllama's module worker on
  an opaque origin): it keeps nothing and says so, which the smoke checks too. Checked by hand in a headless Chromium
  141: a prompt too long, a file that is not a model, a context too large for the page's memory, a damaged runtime,
  an unload during an answer, a stop in a long prefill, and one thread not isolated. Not tried: a real model, an Android phone, a real GPU, the Windows app's WebView2. Firefox and
  Safari (the iPhone included) do not run it yet: the script answers there, and `ask` says why.
- **A model on this machine answers with nothing typed at the console.** The model provider is now `auto` unless you choose one
  (`09_Cognition/router.ts`): at an ask it asks Ollama (`:11434`), a llama.cpp server (`:8080`) and an
  OpenAI-compatible server such as LM Studio (`:1234`) for their models at once, each for at most 2 s, and answers
  with the first in that order that has a model writing text, asking the Claude gateway (`:8089`) only when none
  has one; it looks again when
  that server stops answering before an answer has begun, and at `ask` alone, which shows what it found on a `found`
  row. An Ollama without the default `qwen3-vl:4b` (and not given a model with `ask model`) is given the first text
  model it has, and the chat-format providers send the first text model their server lists instead of the name
  `default`, which LM Studio and vLLM refuse (from LM Studio, the model it has loaded at that answer); Ollama's cloud models are never
  chosen this way. With nothing
  answering, the reason names every address looked at and each server found running but refusing the page, holding
  no text model or too slow to list its models; on a cross-origin isolated page it adds that a running server may be
  refusing the page's origin. A server still has to allow the page (MANUAL, "Which pages a model server answers").
- **Waits on a model server.** A request is closed when the server sends no line of an answer for 5 minutes, or goes
  quiet for 2 minutes mid-answer, with one sentence saying which (`localCompute.ts`); before, a server that never answered held
  `ask` until the operator stopped it.

- **NixOS: the city in one command.** `nix run github:cassius-software/Crimson-Noir-AI-Agent-City` (a new `flake.nix`,
  nixpkgs from the NixOS 26.05 release pinned in `flake.lock`) builds the page from source in Nix's sandbox
  (`tools/nix/page.nix`: npm installs the lockfile's packages by their integrity hashes, about 89 MB on x86-64 because
  the other platforms' native binaries are left unfetched; the page is byte for byte the one `npm run build` writes),
  serves it on `http://127.0.0.1:4180` to this machine only with the two isolation headers, and opens it in Chromium
  as an app window with WebGPU on Vulkan (the page sees the GPU's full name, so a named card starts on its tier) and a
  profile of its own (`tools/web/launch.mjs`, packaged with an app-menu entry by `tools/nix/app.nix`). Words after
  `--` become the page's query. A second start joins a running server only when it signs a fresh nonce with this
  user's token (the token itself is never sent), so another user's program on the port never gets the profile's
  window; a window on another launcher's server closes with it. `nixosModules.default`
  (`programs.crimson-noir-agent-city.enable`) installs it built from the system's own nixpkgs, turns on
  `hardware.graphics.enable` and gives the signed-in user a DualSense's raw HID node for WebHID. The page's package is
  marked unfree (LICENSE, section 1): the flake's own outputs allow it by name, and a NixOS configuration allows it in
  `nixpkgs.config.allowUnfreePredicate`. In a checkout, the module builds from the files git tracks and nothing else
  in the folder. `nix develop` has the contributor tools. A new `nix` workflow runs `nix flake check`, compares the
  Nix page with npm's, boots the city with the packaged command's `--check` and runs the browser smoke's desktop and
  Ultra scenarios in the package's Chromium 155. The zero-trust test now also requires the launcher to bind
  `127.0.0.1` and the Nix source to leave out local AI tooling; `CHROME` may name a command on `PATH`
  (tools/browser/cdp.mjs). On another Linux, Nix's Chromium cannot load the system's GPU driver, so the city shows its
  "No graphics adapter for WebGPU" card; the MANUAL points such systems at a browser of their own
  (`CHROME=google-chrome-stable`), and the launcher says so when Chromium's sandbox stops it from starting at all. The
  window has its own Wayland name (`chrome-127.0.0.1__-AgentCity`, a hidden menu entry gives it the icon). Not
  verified: a real NixOS desktop (a hardware GPU, Chromium's own sandbox, the menu entry, the DualSense rules), and
  the `aarch64-linux` outputs, which CI neither builds nor evaluates.
- **A Lite tier and a lite profile for entry-level phone GPUs.** A phone whose WebGPU adapter is ARM Bifrost or
  Midgard (Chrome reports a Mali-G52 as `arm / bifrost`), Imagination PowerVR Rogue, Furian or B-Series (a bare
  `img-tec` only on 4 GB or less) or Adreno 5xx and older, or that reports 2 GB of memory or less, now profiles as
  lite (`governor.ts` `DeviceProfile.lite`); it used to start on Minimal with 5,000 pedestrians and compile the whole
  post chain at boot. A lite profile starts on **Lite**, tier -1 below Minimal (half the base pixel ratio's edge, a
  thinner and shorter crowd draw), and its automatic range stops at Minimal, so nothing it skipped at boot is ever
  needed mid-game. It simulates 2,500 pedestrians and 12 cars unless `?crowd` or `?cars` says (so a lite page names a
  12-car world, which a default 36-car network room refuses; `?cars=36` joins one, and the console's join timeout on
  such a page says so), and boots a lighter city: the post chain capped off as with `?post=0` and not drawn at boot
  (any boot with the chain capped off, `?post=0` and split screen included, now skips that draw, so three never
  compiles its passes and velocity copies; an uncapped boot is unchanged), no lamp point lights, a 64² environment
  probe baked once a game hour, no clouds, coarser canopies and signal lenses (about half the street furniture's
  triangles), a building re-sort every 24 m, and a physics realm without the street-furniture sensors, the balance
  machine or the scheduled craft (a new `SimInit.craft` flag, on by default). The rig meshes are left out of any scene
  without rig slots. Lite is outside the tier table, so `?quality=0`…`4` and every existing tier index keep their
  meaning; `?quality=-1` or `?quality=lite` and the console's `quality -1` or `quality lite` pin it, and `?lite=1` /
  `?lite=0` force the profile on or off. The HUD and the snapshot show the tier as Lite, and the console's quality
  line ends with `lite profile`. Sloane's fixes for heat, battery or a slow frame now pin Low at most and never raise
  the tier, and "lowest quality" or "potato" asks for Lite (`?quality=Lite` reads as `lite` too). Valhall and
  Immortalis, Adreno 6xx and newer, Xclipse, iPhones, desktops, the Windows app and software rasterizers keep their
  profiles (unit tests pin each). Tried in headless Chromium on SwiftShader with a faked Mali-G52 adapter, Android
  client hints, 4 GB and a 412 × 915 screen at a device pixel ratio of 2.625 (the browser smoke's new `lite` scenario,
  which passed locally and in CI's browser job): the faked phone booted on Lite with 2,500 pedestrians and 12 cars and
  drew frames, and its page compiled 31 render pipelines against 94 for the same phone with `?lite=0`. Not
  tried on a real Mali phone: boot time and frame rate there are not measured.

- **Never a dead end.** Wherever the city cannot start or stops, the page now says why in words for the device it
  runs on and offers a way out, with nothing else needed: the installed iPhone app (full screen, no address bar, no
  reload) and the Windows app (no browser chrome) had none before. One recovery card
  (`src/07_Execute_Actions/RecoveryCard.tsx`) replaces the old bare message: a headline and the steps for this
  device and browser from one classifier (`bootFailure.ts`: an insecure address, no WebGPU, no adapter, a reduced
  compatibility-only adapter, a refused device, no WebGPU in the physics worker, WebAssembly off, a rejected shader,
  a graphics reset, a stalled crowd, a physics fault, a frame loop that kept failing), the raw message and one
  copyable line (build, adapter, user agent) under Details, **Restart** (a page reload, focused, so Enter takes it)
  and **Open the console** (`?boot=tty`, which needs no GPU). A pad's A presses the focused button and its d-pad
  moves between them. The home-screen app and the Windows app are never told to edit an address or switch browsers.
  The Ring-0 lock screen (**SYSTEM LOCKED**) keeps its copy for a real audit failure and gains a focused Restart;
  a lost GPU (the page's or the crowd's) gets the card, worded as a graphics reset, and a physics fault gets it in its
  own words. The console shell (`?boot=tty`) gains **Back to the city**, which a pad's A or a tap presses, so a player
  sent there from a card with only a pad or a touch screen can come back. The cards let go of the mouse (pointer lock)
  so Restart can be clicked, Enter on **Details** opens it rather than restarting, and an open console no longer
  takes Enter from a card over it. Found on a real Android phone: a GPU the phone took back while the city loaded in
  the background (switching to another app) showed "three has not allocated a GPU buffer for crowd.look yet"; it is
  now the graphics-reset card, and the page restarts by itself once the player is back. The "Still starting" line
  names the step the boot is on. The page's script (about 14 MB) moved to the end of the page, so a slow connection shows the
  splash while it downloads instead of a blank page (the browser smoke holds the script back and checks). Firefox,
  Samsung Internet and in-app browsers on Android, which have no WebGPU, get **Open in Chrome** as the card's first
  button (an intent: link; the page still names no address off the machine). A first visit
  is checked (a secure page, WebGPU, a full adapter) before the onboarding, so a browser that cannot run the city
  gets the card instead of the whole onboarding first. After 20 s of visible time without a first frame the boot
  veil adds "Still starting…" with Restart and Open the console; it fails nothing (a software adapter takes
  minutes). `index.html` gains a classic-script watchdog in the head, before the page's module, that shows a card
  with Restart when the page's script never ran (a download cut off, a browser too old to read it, an error while it
  loaded), adding what the city will need where the browser plainly lacks it (a secure address, iOS 26 also in the
  home-screen app, WebGPU, which the Windows app gets from an updated WebView2), and
  takes React's uncaught errors, and a `<noscript>` that says how to turn JavaScript on and that the Files
  app's preview runs no scripts. In headless Chromium (`tools/browser/smoke.mjs fail`): WebGPU taken away (desktop and
  iPhone sizes, upright too), a genuinely insecure origin (`http://lan.test`), no adapter, a hung adapter request, a
  download cut in half, the page's device lost after the boot (a wrapped `lost` promise: headless Chrome cannot reset
  its software adapter on demand), a realm halt for a lost crowd device and a frame that throws each show the right
  card with Restart focused; Enter restarts and a stand-in pad reaches the console. Not tried on real hardware: an
  iPhone (Safari's wording, the settings paths, the home-screen app), the Windows app's WebView2, a real driver reset,
  a real pad.

- **The city on an iPhone or iPad.** Safari gives WebGPU only to a page served over https, and an iPhone had no way
  to play the city at all. `npm run build:web` (`tools/web/pwa.mjs`) writes `dist-web/`: the same page with a
  manifest, its icons and a service worker that keeps every file on the device, so it installs to the home screen,
  opens full screen and, after the first visit, starts with no network; the worker also gives the page the two
  isolation headers a static host cannot send, for the shared memory bridge. The `web` workflow publishes it on GitHub
  Pages when someone runs it (it never runs on its own, and needs Pages turned on once); Tailscale serves it to your
  own devices only. CI's browser job installs it in Chrome as an iPhone and starts it with the host gone. Not yet
  tried on a real iPhone: Safari's WebGPU in the physics worker, the home-screen launch, the headers from a service
  worker in Safari, and heat and memory over a long session. On an iPhone there is no model provider (the servers
  run on a computer's loopback, and Safari cannot run the model in the page yet), so Sloane speaks from her script.
- **The city played in a real browser in CI** (`tools/browser/smoke.mjs`, the `browser` job in `ci.yml`). Chromium
  boots the built page on its software WebGPU adapter (SwiftShader) and plays it through the same events a person
  makes: as a desktop (keys, a mouse drag, a pad, the console, a car entered, driven and left), as an iPhone (the touch
  stick, a look drag, both thumbs at once, the Menu and each of its items, and at six phone and tablet sizes both ways
  up and two landscape views under browser bars, on foot, driving and with a paired pad, every control on screen and
  clear of the others, the stick, the speedometer, Sloane's chip and her Controls card, and the HUD and its messages
  clear of the buttons and the stick), as two
  players on two pads, opened from disk, pinned at Ultra, and as the console alone. A page exception, a GPU
  validation error, a lost device or the crowd's flow field falling back to the CPU fails it. A software adapter
  says nothing about speed, heat or a real GPU's driver.
- **A Menu on touch screens.** Phones had no way to the console, the clock, ghost view, rain mode or hiding the HUD.
  A round Menu button rides with the action buttons and opens a sheet of them; the console opens from the tap
  itself, so iOS raises the keyboard, and shows a Close button on a touch screen.
- **Pads without the standard mapping** (some Bluetooth pads, pads Firefox on Linux does not recognise) were ignored;
  they are now read by position as a best guess, which `hal` names, once one of their face buttons is pressed: a
  throttle quadrant, pedals or a wheel left plugged in never takes a player's seat, and an axis is read only after it
  is seen resting where its part rests (timed in seconds, whatever the frame rate), so a held stick, a pedal passing
  or pausing in the middle, a parked lever or a slider moves nothing on its own. A stick or a hat where the Linux
  kernel puts its triggers can be taken for its order once, if held at one end for half a second; it brakes and
  throttles as it moves until it has rested centred for half a second, and then the order is dropped for good.
  Valve's vendor
  id and Safari's PlayStation pad names get their glyphs. Tested against recorded layouts in Node and with a stand-in
  pad in the browser; no real pad on Linux, Safari or a Steam Deck has been tried.
- **Eight kinds of vehicle.** The fleet is drawn from `VEHICLE_KINDS` (`src/07_Execute_Actions/car.ts`): an executive
  sedan, a transit pod, a logistics van, a transit coach, a courier robot, a security SUV, a gullwing coupe and a
  utility rig, each with its own side profile, glass, lights (brake lights from the brake demand, a cabin glow at night
  on the pod and the coach, an amber beacon on the rig) and wheel size (`fleetView.ts`, one instanced mesh per kind).
  They ride on the two chassis classes that were already proven against the First Law (the sedan's and the SUV's), and
  the seeded draw that used to pick "SUV or sedan" now picks the kind with the heavy kinds on the old SUV share, so
  every seed's fleet keeps the same chassis in every slot. `SimMeta.kind` and the `entered` event carry the kind; the
  HUD names it. The look is untested on a GPU in the cloud.
- **A clear core in the code dissolve.** A mesh you pass through now opens around your eye: cells within 0.85 m of
  the camera are gone and the falling-column pattern is whole again from 2.2 m out (`CODE_DISSOLVE.coreInner` and
  `coreOuter`), so you look out through open code. The core is local to the mesh being passed through.
- **Two more model providers and `ask connect`.** The cognition router (`src/09_Cognition/router.ts`) gains `openai`
  (any OpenAI-compatible chat-completions server on this machine, LM Studio's `http://localhost:1234` by default) and
  `scripted` (no backend: every answer is the deterministic script, nothing is addressed). `ask connect <provider>
  [<url>] [<key>]` chooses a provider and points it in one line, checked before anything changes; the key is kept out
  of the console's history. The air gap is unchanged: every server is a loopback address.
- **The swarm orchestrator (`swarm`).** `swarm run [--agents <1-5>] <goal>` splits a goal over up to five roles
  (architect, coder, tester, auditor, verifier), each one gated prompt through the operator tier, each reading the
  answers before it; `swarm plan`, `swarm status`, `swarm stop`, `swarm roles`, `swarm guardrails`, `swarm audit`.
  The orchestrator (`src/08_Swarm/orchestrator.ts`) issues no script and changes nothing in the city; a host can
  call the same surface from a voice line (`bridge.operator.swarm`).
- **The guardrail layer (`src/02_Define_The_Rules/guardrails.ts`).** Six named invariants every swarm step passes
  before a model is asked and after it answers (operator stop, the gateway's tether, the 14A screen on prompt and
  answer, loopback only, a budget, a verifying chain), and a hash-chained audit trail (SHA-256 of each entry's
  canonical body and the hash before it) the console prints and verifies. Rules over text, settings and counts,
  held by tests; not a proof about a model, which the manual says in those words.
- **A licence audit** (`docs/ip-audit.md`) and two compliance tests: every licence in the npm tree is on a
  permissive allow-list (MPL-2.0 only in `lightningcss`, a build tool that is never bundled), and none of the engines
  or character tools an upgrade plan feared (the audit names them) appears in any text file of the repository. The
  Rust trees are listed; their licences could not be confirmed from the cloud (no registry access) and the audit says
  how to. It flags one MPL-2.0 crate (`option-ext`) that, as far as the lockfile shows, is compiled into the Windows
  app, for counsel to confirm.

- **Lakefront Metro has people and traffic.** The generated metropolis was walked through the surveyed-region path,
  which by design gives a region no fleet and hides the pedestrian crowd, so every first visit read Population 0 and
  Vehicles 0. Its streets lie on the procedural city's 40 m pitch, so a *street window* of 16 × 16 blocks around where
  the visitor starts is now read back from the region pack's roads (`src/01_Initialize_World/region/streets.ts`): the
  GPU crowd (`crowd.wgsl`) is compiled for the window's corner and street widths and takes, per segment, whether a
  sidewalk runs along it and whether cars use it, so its corner graph never walks a dropped street and only waits at
  crosswalks over streets with cars; the fleet is seated on rings laid over the window's whole cells (disjoint
  rectangles whose every side is a car street, so the zero-jam invariant of `tracks.ts` holds; the fleet is clamped to
  the rings' seats); lamps, trees and signal poles stand along the window's streets; the HUD shows the real counts and
  the signal cycle. The procedural city compiles to the same shader with every street present at the origin.
- Generated streets cars use are two lanes, one each way (arterials were four), and the lake's shore wall is cut where
  a bridge crosses it, so a car can drive onto the bridge. A surveyed region whose roads are not on the grid is
  unchanged: empty fleet, hidden crowd.
- Unverified in the cloud (no GPU): the rendered crowd and traffic on the metropolis; `naga` validates both shader
  variants, and the window, the rings, the realm's seating and the uniform layout are tested in Node.
- **Sloane speaks.** The concierge says each line the card shows, and the onboarding's lines once the visitor chose
  sound on: through the operator's speech provider at the player's own head when it has a voice chosen, otherwise the
  browser's own speech synthesis in an offline voice only (a network voice is never picked). No neural voice model is
  bundled: the browser tier sounds like the operating system's voices. `sloane [on|off|voice <name>|voices|say <text>]`
  in the console. Unverified from the cloud (no speakers): how either tier sounds.
- **Your own agents.** A roster of up to twelve named agents (pronouns, a role screened under 14A, one of twelve voice
  profiles or a provider voice, a look from the crowd's wardrobe) in a second tab of the wardrobe card, with a Hear
  button, and `agent [new|hire|dismiss|forget|voices|<name> <field> <value>]` in the console. Hiring asks someone
  nearby over and dresses them; a hired agent's prompts are told who they are, and `say` speaks them in their own
  provider voice.
- **ElevenLabs as an optional speech provider**, off by default: `say provider elevenlabs`, through a gateway on this
  machine (`http://localhost:8090`; an nginx example in `docs/zero-trust-audit.md`). A key typed to `say key` stays in
  this browser, masked, kept as dots in `history`, and is sent only to the loopback gateway.
- **`goal <words...>`** in the console: Sloane's goal planner, applying what it can now (clock, quality, sound).
- Sloane's quiet first-minutes watch gains one more line: the wardrobe on the chip.
- **Six indoor workplaces in the procedural city** (`src/01_Initialize_World/interiors.ts`): a robotics lab, a
  boardroom, a logistics warehouse, a triage clinic, legal chambers and a telemetry command room, one in each sixth of
  the downtown, chosen from the seed. Each replaces its lot's solid podium with glass walls, a 4 m doorway on one
  street, a ceiling and furniture, and has eight stations. A share of the GPU crowd works there in shifts (5 minutes
  of every 8): they walk the streets to the doorway, in to their station, work there and walk back out. The HUD shows
  "At work indoors" and the rooms on the minimap; the console's `sim` line ends `at work N`. Unverified from the
  cloud (no GPU): the rooms and the workday on screen; `naga` validates both shader variants, and the containment,
  the routes and the workday's legs are tested in Node on a mirror of the shader's step (500 walkers over 5,000
  steps, none through a wall or a piece of furniture).
- **The six workplaces in Lakefront Metro too** (`src/01_Initialize_World/region/workplaces.ts`): `?map=lakefront`
  gets the same six rooms, inside the 16-block street window round where you start. A lot is a candidate when one of
  its street fronts is a two-way street with a sidewalk that can be walked to from the start; the transit hubs come
  first (their podium becomes the room's ceiling and their tower is carried above it), then the lots the other
  buildings fill, nearest the start first; never the tallest building's lot and never one under water. The page picks
  the lots and sends them to the physics worker (`SimInit.workplaces`, checked there), so the rooms drawn, the rooms
  walled in Rapier and the flow field, and the rooms the crowd walks to are the same six. A generated window has
  missing and pedestrian-only streets, where the city's greedy walk from corner to corner can stall for good, so each
  room has a route table over the window's intersections (`packRoutes`, read by the crowd shader's `commuteCorner`);
  the procedural city's table is all zero and its commute is unchanged. The HUD's "At work indoors" and the minimap's
  rooms now show on that map, and `map` says so. The browser smoke boots `?map=lakefront` and checks that the six
  rooms reached the crowd; it does not wait for anyone to reach work, since the software renderer runs that map's
  realm at about a tenth of real time: a longer run on it saw the first worker at a station after 81 s of realm time,
  about 20 minutes. Unverified from the cloud (no GPU): the rooms on screen and the workday at full speed there.

### Changed

- **Look v2.** A look is twenty slots: `build` is gone, replaced by the eight sliders. A look kept in this browser
  before (record `v` 1, fourteen slots, the same key), a roster record's look and an eight-symbol look code are
  upgraded on the way in (height and build carried onto the new sliders, the rest set to the middle); new records
  are written as `v` 2 and new codes are fifteen symbols, `XXXXX-XXXXX-XXXXX`, with the checksum over both words.
  Every pedestrian's proportions change: the hashed crowd now draws a stature from a per-body range (men 1.64 m to
  2.00 m, women 1.55 m to 1.87 m) and every other slider over its whole range, so the street has short and tall,
  slight and heavy people where it had two scales; the hashed pieces and colours are as they were. `lookFromSeed`
  mirrors the new draws bit for bit, so the pinned looks of the first agents changed with them.

- **Canned answers say so, and are not remembered.** When no model answers and the script stands in, the console
  prints `ask: no model answered, so the script spoke instead:` and the reason under its words; neither the swarm's
  memory nor the short-term memory keeps them, and `say auto` does not say them aloud, so a canned line never returns
  in a later prompt as something a person said. A swarm run the script stood in for ends with that reason. With
  nobody tethered (the onboarding guide rewording a line), the system prompt now ends with a line saying no one is
  tethered and the expertise rule does not apply.
- **The cloud fallback falls back.** When the frame-rate throttle sends a prompt to the Claude gateway and the gateway
  is not running, the chosen local model answers it after all, and prompts stay local for a minute before the gateway
  is tried again (`cloudFallback.ts`); before, the script answered in the local model's place. Under `auto` the throttle follows what auto found.
- **Origins.** `MANUAL.md` says which pages each model server answers by default (Ollama: `localhost` and
  `127.0.0.1` pages; the Windows app and the web copy need `OLLAMA_ORIGINS`), and on a cross-origin isolated page the
  "not running" sentence now says the server may instead be refusing the page.

- **The app is called Crimson Noir: Agent City everywhere, with a new mark.** The page title, the boot splash, the
  HUD, the "couldn't start" card, the Windows title bar, the console's `version`, `uname` and prompt, recordings' file
  names and the shipped notice all showed the old working name and its black square with a white triangle. They now
  read Crimson Noir: Agent City (Crimson Noir on a phone's HUD and home screen) and show a new mark drawn from the
  cover art: five towers and a spire over one crimson street line on an ink square. The Windows app's icons and
  installer icon and the home-screen icons are rendered from the same shapes. Unverified without a GPU: how the mark
  looks in the running city.
- **The crowd slides along walls**: the part of a step a wall or a piece of furniture refuses is taken out of the
  pedestrian's velocity, so they slide along it instead of pressing into it. Nobody walked into buildings before
  either: every lot was solid and the crowd kept 0.35 m outside it.
- **Wren is now Sloane** throughout the page, the console and the docs (history entries keep the old name).
- **The eye height follows the avatar's height**: 1.7 m times the body's height scale, within 1.2–2.2 m, eased in.
  Unverified from the cloud (no GPU): how it looks.
- **On foot you walk through cars.** The avatar's capsule no longer pairs with a vehicle chassis
  (`COLLISION.avatarThroughCars`, `AVATAR_GROUPS`): a parked car is passed, not pushed, and its mesh dissolves as
  you enter it. The First Law is untouched: the Bouncer still brakes for you and holds a car still while you stand
  in its footprint, the Sanctuary still shields you from a moving car, and the Ring-0 audit still reads a moving car
  over a solid person as an impact. The Sanctuary no longer shields or nudges anyone for overlapping a standing car,
  and it now shields anyone within 0.3 m of a moving one whichever way it moves, since you can run after a car pulling
  away; a car pulling away nudges nobody.

### Removed

- **The full-screen contact wipe.** The iris of code that opened from the centre of the frame on every contact
  (ghost view's composite, `contact.ts`) is gone: a passage shows on the mesh passed through alone, and the post chain
  no longer turns on for one. `output.contact.wipe` in the telemetry is now `output.contact.passage`, the same
  envelope, which nothing draws.

### Fixed

- **A pedestrian pinned on a standing car, and the car held by them.** A pedestrian whose way to their corner ran
  through a car's contact footprint (a car parked across the sidewalk, or the player's car stopped on one) was pushed
  out of the footprint every tick while their walk kept pressing in, so they stood at the bumper for good, staggering;
  from inside the widened footprint they read as 0 m to the car's First-Law corridor, which held the car's reverse, so
  the car and its pedestrian locked each other (seed 11 of the city: agent 17 on car 0 for 59 s of 60, a push every
  tick). Now the part of a walk pressing into a car comes out of it, as a wall's does, so the step slides along the
  body instead of being set back; a pedestrian whose next 6 m run through a standing car (under 1 m/s) steers for the
  footprint corner with the shortest clear way round, 0.3 m off the body; and a corner or door front a standing car
  covers counts as reached from anywhere round the car, so the leg ends instead of waiting on it. Traffic on its rings
  never locked, so nothing changes for a moving car. The crowd shader now runs on the CPU under test: `wgslHost.ts`
  compiles the WGSL subset it is written in to JavaScript, checked against the GPU's own `Params` layout and against
  TypeScript copies of its pure functions over 12,000 random cases, and `crowdHost.ts` is the same sensor over it,
  with the GPU's one-step lag. `crowdSoak.test.ts` soaks the whole realm with the shipped pedestrians on every change:
  eight cars parked across the sidewalks for 60 s, and 48 cars on their rings with 500 people for 1,800 ticks, no
  pedestrian pinned on a car for 5 s and no car reading one at 0 m for 10 s. The nightly fuzz workflow runs the
  traffic soak for 10,000 ticks (`SOAK_TICKS`).
- **The asset gate read "burgundy" as a gun.** The containment rule (`assets/cc0.ts`) purges any name that holds
  `gun`, and its short list of ordinary words that merely contain it had no colour in it, so an asset or a generated
  name with burgundy in it would have been purged. It is allowed now; the wardrobe's burgundy pantsuit showed it.
- **A lost GPU left a city that ran on invisibly.** The page's own device lost after the boot (a driver reset, the GPU
  process gone, a phone taking the memory back) only wrote to the error list while the HUD carried on over a frozen
  frame; it now halts the city and shows the graphics-reset card. Lost while the page was hidden, the page restarts
  by itself when it is shown again, at most once every two minutes and never where it cannot keep the time of the
  last restart (no storage); lost while visible, the card waits for Restart.
- **The frame loop could die silently**: one throw in a frame stopped the requestAnimationFrame loop for good, a
  frozen city with a live page. A throw before the first frame now fails the boot with the card; after it the loop
  carries on, and 30 throws in a row halt the city with the card.
- **Boot failures that hung or leaked.** The lakefront map builder's worker crashing left the onboarding waiting
  forever (its error event now rejects the build); a physics worker fault while the page compiled was swallowed and
  the city started on a closed client with frozen physics (it is held and refuses the boot); a boot that failed
  partway kept its GPU device and physics worker running under the message (both are released); the first frame now
  draws inside a WebGPU validation scope, so a draw the browser refuses fails the boot with its words. The crowd's
  10 s window for its first GPU reading counts only the time the worker ran, so an iPhone switched to another app
  while the city starts no longer comes back to a failure.
- **The adapter is the worker's.** The page now asks for the GPU itself, as the physics worker does (a full adapter,
  high performance), and hands the device to three.js with the same features three would ask for, instead of three's
  own request at the compatibility feature level; the answer tells the card which of no adapter, a compatibility-only
  adapter or a refused device it is. Every existing scenario of the browser smoke still boots.

- **The city never started on some Chromium builds**: three r186 sets `swizzle: 'rgba'` on every texture view, and
  builds that still type that field as a dictionary threw on the first one. `world.ts` drops the identity swizzle.
- **The crowd's flow field always ran on the CPU**: both of its GPU pipelines used an automatic layout holding only
  the bindings each entry point reads, so its six-binding group failed validation on every device and the page fell
  back silently. They now share one explicit layout, held equal to `flowField.wgsl`.
- **Players 2–4 could not enter, leave or right a car** in split screen: the frame loop took those presses from player
  1 only. Each pad's south and north buttons now act for its own player. In a network room, which replays player 1
  alone, only player 1 opens a car door, and anyone else driving when the room starts is put out of the car.
- **Command chords on a Mac left the avatar walking** (macOS sends no key-up for a letter pressed with Command):
  a Command chord holds no key, and Command's key-up lets go of the held ones.
- **Space clicked the last button the mouse pressed**: Space and the arrows never click a button a mouse click or a
  tap left focused (also after another window and back, or with a key held through the tap), and are always the
  game's under a captured mouse; a button reached with Tab still presses with Space (where it came from is judged as
  focus arrives, since Chromium counts any key as keyboard use). The
  right mouse button opens no menu over the city, and the arrows and the right Shift move and run too.
- **Safari zoomed the page into any text field under 16 px**; on a touch screen every field now reads at 16 px.
- **A mouse driver's spike could spin the view**: a captured mouse asks for raw counts where the browser has them, and
  a jump far faster than the mouse was moving is dropped (judged per millisecond, so a long frame's merged movement is
  kept; out of rest a move is timed over its own frame, so a jump out of stillness is a spike and a turn from rest is
  not; two events in a row are never dropped while the mouse moves).
- **Touch layout on small and upright phones**: held upright while driving, Ping, Reset and Exit car stand in a
  column clear of the stick, and on a phone under 376 px across the rows that would reach the stick stand as columns;
  the Menu opens from the touch itself, so it works with a thumb on the stick, and its sheet never runs off the screen;
  Sloane's card stands clear of the buttons and scrolls inside itself on a short screen, and her chip rises above the
  buttons on a short phone in landscape (moving left of the minimap under browser bars), also with a pad paired; on an
  upright phone her chip covered the foot of the HUD's readout and, at the wheel, the car's message, and it now stands
  below the HUD's panels (at the wheel below the message, cut to a line) and above the buttons; on a short phone in
  landscape a message stood over the stick (and, 568 px across, the Menu), and it now takes the readout's place; the brakes are a size smaller on a short screen; at the wheel the Menu sits before Ping, clear of the speedometer; a
  mouse moving on a touch laptop puts the overlay away (and its Run toggle with it), while a tablet whose main pointer
  is the finger keeps it.

- **Someone asked over could be lost in a room or by its glass.** An operator up on an AGV dock, resting in a table's
  corner or leaning on a piece's end sent the recruit back to the hub or held them on the next face, and a recruit in
  tow lost the operator in a dead end between the docks or round the end of a long rack. The way across a room now
  aims at the floor beside the piece (0.40 m off it), and follows the operator's own trail on foot where neither a
  straight line nor one piece's corner leads (`OperatorTrail` in `skills.ts`: their last 16 points, packed into the
  crowd's uniform after the route table). Whether the glass stands between two people is now an exact line test
  against the panes of the room either one stands by, so someone in the doorway's band no longer talks through a
  jamb or flips between talking and coming; they start talking only where they see the operator clear of the glass
  and go round a jamb's outer corner into the opening. On the street the straight last stretch is taken only where it
  cuts no lot (a recruit who ran behind no longer stalls at a lot's corner short of an operator standing at a room's
  side wall), and the car's exit point is checked against the glass exactly, so a driver is never put out through a
  jamb's corner. Five review rounds then swept thousands of walks on the test mirror (some with positions kept in
  32-bit floats, as the GPU keeps them, at 60 to 144 frames a second); the edge cases they found are fixed, each with
  a test that failed first. The trail is followed only where the crowd can walk it (never over a dock the operator
  stepped over), lines along a piece are tested at the containment's own reach so nobody is led into a gap's mouth,
  and a recruit the corner way brings to a piece's corner walks on from it. By a lot with nothing on it (a park, a
  building standing back from its edge), a recruit talks from their own face when the operator is in reach of it,
  goes round its corner otherwise, comes right onto the face instead of easing to a stop millimetres short of
  talking reach, and stands still level with an operator out of reach instead of trading the field's arrow for the
  straight line every few frames. The crowd shader and its test mirror changed together; `naga` validates both
  variants. Unverified from the cloud (no GPU): the recruits on screen.
- **A runner beside a turning car could halt the realm.** At full lock a car's centre heads into its inner flank while
  the overhang behind the rear axle swings away; the Ring-0 audit judges a touch by the centre and the Sanctuary judged
  it by the flank, so a runner reaching the inner rear corner stayed solid where the audit read an impact
  ("Perimeter breached", 19 of 36 runs in the new test). The Sanctuary now takes the faster of the two. A promoted
  pedestrian's foot is measured where the audit sees it, off its lower leg, instead of at the leg's origin. Both were
  older than the walk-through change.
- **The periodic freeze** (docs/stutter-and-depth.md): the sky probe (the scene's reflection map) refreshed every 0.2 game
  hours, 12 s of real time at `?day=24`, by baking into a new render target and assigning its new texture to
  `scene.environment`; three.js keys every material's shader on that texture's node, so each refresh rebuilt every
  material in the scene on the main thread. The probe now bakes into one reused render target
  (`src/01_Initialize_World/envProbe.ts`), so the environment stays one texture object and a refresh costs only the
  generator's passes; each bake writes one `[envprobe]` console line beside the `[longtask]` telemetry. That the
  freeze is gone can only be seen on a machine with a GPU.
- **Far surfaces flashing**: the renderer now asks three.js for a reversed depth buffer (`depth32float`, near at 1),
  whose resolution follows perspective (0.12 mm at 1 km instead of 60 cm with the 24-bit forward buffer), so the
  Lakefront streets and sidewalks laid 3.5 to 4.5 cm over the ground no longer fight it at a distance. The sky mesh is
  pinned to the far plane under the reversed convention (three's SkyMesh pins itself to what becomes the near plane),
  and the crowd cull's frustum is cut with the camera's own coordinate system and depth convention. Unverified from
  the cloud: the look on a real GPU.
- **`npm test` on Node 24 failed three tests of the in-page model's crash guard** (every mark carried a `lock` field
  the tests did not expect): Node 24 ships `navigator.locks`, so the test harness, which named no Web Locks, picked up
  the host's and held a real lock in the test's own process, where a page that "dies" loading cannot die. The harness
  now has no Web Locks unless a test hands it a fake (the two-tab test does); the product is unchanged. CI runs Node
  22, which has none, so it never saw this; a laptop run on Node 24 did.
- **A Windows run from a fresh ZIP loses fewer tests to the on-access scanner.** The three tests that read the whole
  tree (compliance, zero trust, air gap) now wait out a file the scanner holds again after the warm-up
  (tools/test/held.mjs: the warm-up's own pause and retry, at the read, on Windows only), and the wllama pin test
  copies the installed package into its temporary folder instead of linking it, since a directory symlink on Windows
  needs a privilege most accounts lack. A test file the runner itself cannot open at import still fails that file
  (one of a laptop run's seven failures); only a folder the scanner has seen, or one outside Downloads, avoids that.
- **Two high npm audit findings**, both in build-time tools that never reach the page: vite 8.3.1 → 8.3.5 (with
  rolldown 1.2.15 and postcss 8.5.31 under it) and source-map-js 1.2.1 → 1.2.2; the lockfile alone changes.

- **Lakefront streets under the pavement and the lawn ("grass above the roads").** Past a few metres a Lakefront
  Metro street showed as pale sidewalk with no asphalt or markings, farther out as lawn, and a causeway over the lake
  as lawn end to end. The region's road, sidewalk and water materials asked for a negative polygon offset, and three
  r186's WebGPU backend hands it to the pipeline unflipped under the reversed depth buffer the page uses, where a
  negative bias moves a surface away from the camera: by more than the 4.5 cm a street stands over the ground beyond
  about 18 m. No surface asks for an offset now; each lies at its own height (`SURFACE` in `region/regionWorld.ts`),
  which the reversed buffer resolves at any distance in view, and the result is the same under a three that flips
  the sign. Found with it: where two streets cross, their ribbons lay on one plane and their markings fought, so a
  junction gets a patch of plain asphalt over the carriageways' overlap and, with sidewalks, of plain pavement over
  the sidewalks', cut at a ribbon's end for a T or a corner. And with the offsets gone the map's edge still showed
  lawn over a causeway and lake over its road: the ground was two 8.5 km triangles and a lake strip one 2.5 km
  rectangle, too far from any pixel for the depth interpolated across them to keep the surfaces' centimetres, so every
  flat surface is now drawn in pieces of at most 128 m (`SURFACE_PIECE`), the ground as a grid, the water cut to
  cells, the ribbons split. Verified by `region/surfaces.test.ts` (every crossing of the generated metropolis and the
  north ridge, point by point; every piece's length; the water's area) and by the built page rendered in a headless
  Chrome on the software WebGPU adapter: asphalt and the double yellow line to the horizon where pavement and lawn
  were, the lake beside the causeway. A laptop's own picture is unverified. `docs/stutter-and-depth.md` §4.

## [1.0.0-stable-beta] - 2026-10-12

The V2 stable release overhaul (Phase 21, PRs #17, #18 and #19) and Phase 2 (PRs #20, #21 and #22), with everything
merged since `v1.1.0-stable-release`. Tagged `v1.0.0-stable-beta`; the OS media are baked and the Windows app is
built by the two release workflows on that tag.

### Added

- **Matrix mode** ([#17](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/17)): world-space falling code on every surface, as triplanar functions inside the
  page's three.js node materials (`src/01_Initialize_World/matrixMesh.wgsl`); one global state word (time, mode,
  floating origin) packed into the materials' uniform and the crowd's parameters; toggled with the M key or `rain on`
  in the console. In matrix mode pedestrians drop to the static-world collision bit, so people and cars pass through
  each other while the ground and lots still hold; the floating origin snaps the camera to whole metres. Lakefront
  meshes take the mode through the region path. Unverified from the cloud (no GPU): the shaders compiling and their
  look on a real device.
- **Lakefront Metro** ([#18](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/18)): a seeded, deterministic Greater-Toronto-analogue map with no real place
  name (a test asserts it): a lake behind a wandering shore with a harbour, a dense financial core on the water with
  The Spire on the waterfront (168 floors, 554 m), ravines running north to the lake crossed only by arterial bridges,
  a suburban grid with skyscraper transit hubs, five regions (Lakefront Metropolis, West Sprawl, The East Bluffs, North
  Ridge, The Grand Ravine) as JSON layouts under `world/lakefront/`, loaded through the existing region path.
  **Wren's onboarding**: four one-word questions, a choice of Downtown, West, East, North or Ravine, the map built in a
  worker, "Walk in" landing in the chosen region; `?onboarding=0` is the expert path. **The CC0 asset gate**
  (`assets/cc0.ts`) purges every weapon name by case-insensitive containment with a short allowlist, and screens every
  name entering the page.
- **Zero-copy physics bridge** ([#19](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/19)): every car, avatar and pedestrian's position and state word in one
  buffer shared between the physics worker and the page under an Atomics spinlock (a `SharedArrayBuffer` when the page
  is cross-origin isolated, which the dev and preview servers now are through COOP and COEP headers; a plain buffer of
  the same layout otherwise). Measured in Node at 14,000 pedestrians over 10 s: 58 short garbage collections on the old
  message path, 1 with the bridge. **GPU flow-field routing**: summoned pedestrians follow a GPU-solved flow field
  round buildings, with a CPU fallback that warns once in the console. **Ragdolls** left the vehicle contact layer.
  **Cloud fallback**: below 30 fps for 2 s, complex prompts bound for Ollama or llama.cpp go to the Claude provider
  through the existing loopback gate.
- **The one-click Windows app** ([#21](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/21)): a Tauri 2 shell (`src-tauri/`) around the very same
  `dist/index.html`, borderless, with a frosted glass title bar in the brand's tokens (Mica on Windows 11, best
  effort) and COOP/COEP headers so the physics bridge takes its shared-memory path. The `windows-app` workflow builds
  `Crimson Noir Agent City_<version>_x64-setup.exe` and the bare executable on every pull request and push to main,
  and uploads both to the GitHub Release of any `v*` tag beside the OS media. Verified in CI on a Windows runner;
  Mica, WebGPU under WebView2 and the window's look on a real desktop are not.
- **Wren's quiet first minutes** ([#22](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/22)): for five minutes after "Walk in", Wren watches what a first
  visitor does and, after thirty quiet seconds, says one plain line in the concierge card (look around, walk to The
  Spire, talk to someone, press M, turn the clock), at least forty-five seconds apart, skipping what is already done,
  never called a lesson, never twice, never over an open question. The pure, clock-injected mentor is
  `src/09_Cognition/tutorial.ts`.
- **The swarm's short-term memory** ([#22](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/22)): every recruited person keeps the last three moments with the
  player (who, what, where, when on the city's clock) and a one-sentence account of their surroundings
  (`src/08_Swarm/shortTerm.ts`); both ride every provider's system prompt under one heading within a 600-character
  budget, and with no backend answering the person still answers from a script built from that same context.
- **Long-task telemetry** ([#20](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/20)): a `PerformanceObserver` on the browser's `longtask` entries writes one
  silent `console.debug('[longtask]', …)` line per main-thread stall over 50 ms, with the task's start and duration,
  the JS heap in MiB and the number of live worker threads (the physics worker is the WASM thread); 8 lines per 10 s,
  then one dropped count. A browser without the API gets a no-op.
- **`npm run verify`** ([#16](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/16)): a Node port of the formal verification runner, so the proofs run from
  cmd.exe or PowerShell without a POSIX shell (Kani still needs Linux or WSL; the WASM byte comparison is skipped on
  Windows, where rustc embeds backslash paths). The README has a Windows paragraph.
- **This changelog** and the version fields set to `1.0.0-stable-beta` (package.json, package-lock.json, brand.ts,
  src-tauri/Cargo.toml and Cargo.lock, from 1.4.0).

### Changed

- **The README is the one-page overview**, every claim checked against the tree and CI; the 2,161-line manual moved to
  `MANUAL.md` unchanged ([#14](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/14)). Facts fixed on the way: the console's stack machine is `r0`; the 38
  sandbox probes are "denied in the container, with a weakened control", not formally denied; the three isolation
  layers are named.
- **Stable release polish** ([#15](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/15)): drivers react on the exact frame their perception latency allows; a
  small on-foot drift in a room is corrected under the player's feet (at most 0.25 m) instead of pulling them back;
  remote snapshots ease over 0.1 s; a released ragdoll's pedestrian is placed where the rig stood (0.00 m jump, was
  0.66 m); the code-dissolve keys are whole numbers so cells stay distinct at any uptime and the shadow moiré is gone;
  crowd draw lists hold the whole crowd per body; density fades over 8 m, LOD spreads ±10 %, a new quality tier glides
  in over 30 frames; ghost view draws every glyph; the 24 fps pacer holds 24.000 fps on jittery 165 and 240 Hz
  displays; AI cars corner at 0.579 m (was 0.787 m) and hold 0.180 m on straights; a follower passes a parked car after
  6 s and bonnet rays see rejoining cars.
- **Streamed model answers are screened a whole word at a time** ([#15](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/15)): a refused word stops the model at
  once, auto-say never speaks a disengaged answer, the diary never recalls a line that fails the screen, and the screen
  reads leetspeak inside words.
- **Held source files on Windows are reported as held**, with the real error, instead of as missing modules
  ([#16](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/16)).
- The handoff records v1.1.0-stable-release and Phase 19 ([#13](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/13)): the published `BOOTX64.EFI` of that
  release rebuilds byte for byte in another container, so its PE timestamp is the commit's alone.

### Removed

- The tracked developer AI configuration (`.claude/`), as part of the zero-trust sweep; a guard test holds the
  attack surface ([#15](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/15)).

### Security

- The zero-trust sweep ([#15](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/15)) confirmed: no process spawning from strings anywhere, the room host
  token-authenticated and loopback unless told otherwise, the CSP `default-src 'none'` tested and property-fuzzed, the
  WASM modules import nothing (checked on the bytes). `'unsafe-eval'` remains for the operator console.
- The CC0 asset gate screens every asset name entering the page ([#18](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/18)).

### Counts

`npm test` grew from 1,316 tests at v1.1.0-stable-release to 1,414 (1,403 pass, 11 skipped without the OS bridge
binary, as before) at the merge of #22 (1,423 with #20). The Z3 theorems (15) and Kani harnesses (14) are unchanged
and ran green in every one of these pull requests' CI.

## [1.1.0-stable-release] - 2026-10-09

Phase 19: the data-oriented SIMD rewrite of the Global Matrix tick (four agents per SSE2 register, bit for bit equal
to the scalar Kani reference, fingerprint 0x83765bab) ([#12](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/12)); the zero-trust self-heal sandbox with 38
escape probes denied in the container ([#10](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/10)); dual licensing with headers on every source file and a CI
header check, plus the brand tokens, marks and style guide ([#9](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/9), [#11](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/11)); per-client proxy
throttles and the nightly fuzz workflow ([#7](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/7)); the terminal renamed "Crimson Terminal" ([#8](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/8)).
Baked from main 2ad02e1: proofs, tests, two byte-identical bakes, both QEMU boots, eight published files.

## [1.0.1-stable-release] - 2026-10-08

Phase 18: the Kani/Z3 proof step gating the release bake, the first CI on pull requests and main, the self-healing
agent that opens `selfheal-*` pull requests and never merges, SIPOC telemetry and the chaos campaign
([#3](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/3), [#4](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/4), [#5](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/5)); the EFI build made reproducible across hosts with `/DEBUG:NONE`
([#6](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/pull/6)). A new tag because `v1.0.0-stable-release` already named pre-Phase-18 media.

## [1.0.0-stable-release] - 2026-10-07

The first published media of Crimson Noir OS, before Phase 18.

[1.0.0-stable-beta]: https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.0-stable-beta
[1.1.0-stable-release]: https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases/tag/v1.1.0-stable-release
[1.0.1-stable-release]: https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.1-stable-release
[1.0.0-stable-release]: https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.0-stable-release
