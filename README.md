# ONYX

*An enterprise in the palm of your hands.*

> **ONYX is a provisional working name.** The name lives in one place, `src/brand.ts`; see
> [Brand](#brand) before choosing the final one.

A business-casual, non-violent civic simulation that ships as one self-contained HTML file. It is a
16 × 16-block city under a moving sun: a downtown of towers, a heritage quarter of stone and brick rows, and a
lakefront of condominiums along a promenade, a seawall and a pier. It has 14,000 GPU-simulated pedestrians
who wait for the walk signal, and Rapier3D traffic that obeys the lights. Every vehicle command, from the AI or
from you, passes a three-law safety kernel before it reaches the wheels. You see everything **first
person**, at eye level, on foot or from the driver's seat. You can walk the districts (straight through people, lamps and trees: the
collision model is ghost mode), take any car, see every physics shape in ghost view (`G`), or open the Ring-0
console with `~`.

It opens with no clicks. A black Monolith splash fades straight into the street at golden hour, and
Wren, the concierge, asks what to call you: type a name and press Enter, then walk.

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck (app + tests), then emit dist/index.html: one file, every asset inlined
npm test         # 650+ unit tests (node --test), including real Rapier physics in Node
npm run lint     # oxlint
```

Open `dist/index.html` directly: no server, no network, works offline. (The exceptions are the operator's
optional `ask` and `say`, which talk only to a model server and a speech server on this same machine, and only
when asked: see The local model and Speech.) It needs WebGPU:

- **Desktop and Android:** a current Chrome, Edge or Brave.
- **iPhone, iPad and Mac:** Safari 26.

The crowd runs as WGSL compute and has no WebGL path.

## Controls

| | Keyboard and mouse | Gamepad (standard mapping) | Touch |
|---|---|---|---|
| Walk / drive | W A S D | left stick; right trigger throttle, left trigger brake | left thumb stick |
| Look (head) | drag with the mouse, or click to capture it | right stick | drag on the right half |
| Run | Shift | left-stick click | Run button |
| Enter / exit a car | E | south face button | Enter car / Exit car |
| Handbrake | Space | east face button | Handbrake |
| Right the car | R | north face button | Reset |
| Clock −1 h / +1 h | `[` `]` | D-pad left / right | |
| Ghost view | G | | |
| Hide HUD | H | | |
| Ring-0 console | `~` (Backquote) | | |

## URL options

| Option | Meaning |
|---|---|
| `?quality=auto` (default) | The quality governor picks the tier; `?quality=0`…`4` pins one: Minimal, Low, Medium, High, Ultra |
| `?fps=60` | Frame-rate target (default: estimated from the display, held within 60–90) |
| `?crowd=14000` | Pedestrians, from 256 to 60,000 (default: 14,000 on a desktop GPU, 8,000 on a phone, 5,000 on the weakest devices) |
| `?cars=36` | Cars, at most 48 |
| `?time=17` | Start hour (default 17:00, golden hour) |
| `?day=24` | Real minutes per simulated day |
| `?scale=1` | Base pixel ratio |
| `?seed=1337` | World seed |
| `?shadows=0`, `?post=0` | Caps that apply at every quality tier |
| `?cinema=0` | Turns the cinema camera off: every frame is drawn, no motion blur, ACES tone mapping (see The cinema camera) |
| `?audio=0` | Start with the soundscape muted |
| `?profile` | GPU timestamps |
| `?debug` | Exposes `window.__SIM__` test hooks; off by default |

## The city

`01_Initialize_World/city.ts` generates the whole city from the world seed: a 640 m grid of 16 × 16 blocks on a
40 m street pitch, one road network the traffic, the crowd and the physics all share. No map data is imported and
no real building is copied. The districts have generic names, and the HUD shows the one you are in:

- **Downtown** (the Financial District at the centre, then Midtown, the Civic Centre, the Market Quarter and
  Lakeshore around it): towers rising toward the centre, in curtain wall, stone, brick and metal panel.
- **The Heritage Quarter** (the four western columns): a southern-Ontario main street. Its two- to
  four-storey limestone and brick rows are built to the sidewalk, with cornices and some mansard roofs, and
  its sidewalks are brick pavers. A stone church has a stepped spire (48 m); a brick mill has a 40 m chimney.
- **The Lakefront** (the southern rows): mid-rise condominiums over shops, then a row of parkland with trees and
  the odd pavilion. Past the last street, a paved promenade with trees and lamps runs along a seawall, and a
  pier runs 80 m out over the lake.
- **The lake.** Water ripples from the shore to the horizon. The seawall and the pier's railings are the edge of
  the physics world: you cannot walk into the lake, but you can step onto the pier's deck (0.3 m, one step up)
  and walk to its end.

Streets run the full grid; the crowd walks every sidewalk and stops short of the water.

## The surveyed map (pilot)

The map is becoming a real metropolitan region with fictional names: its streets, buildings, shoreline and water
are surveyed, and every name is invented. Real fictional cities work the same way. The first piece is a
pilot region of 12.1 × 7.8 km: the downtown waterfront, its harbour and islands, 49,620 buildings, 11,141 street runs.
It is a separate build:

```sh
npm run build:pilot   # dist-pilot/index.html: the same single offline file, with the region embedded
```

Open it the same way. `?region=off` shows the procedural city instead.

- **What you get.** You walk first person on the sidewalks of the real street grid. The streets have their surveyed
  widths, lane counts, centre lines, lane dashes and one-way flows. Every building stands at its surveyed footprint
  and height, dressed by the city's facade shader, with windows that follow each wall at any angle. The lake has
  its islands, the harbour its slips.
  - Walls stop you, the shoreline stops you at the water, and the region's edge stops you.
  - The HUD names where you stand ("Harrowmere · Peppergrove Avenue & Orchidknoll Street West"). The minimap draws
    the region's streets, buildings and water.
  - The cinema camera, the kernel, ghost view and the console all run as usual.
- **Every name is fictional.** Streets and water bodies are named by `region/names.ts`. A name is a compound of two
  original word lists, fixed per real name, and never one real name for two streets.
  - A street keeps only its type and direction ("… Street West").
  - The compiler denies every real name the sources hold, plus a list of the region's municipalities,
    neighbourhoods, landmarks and highways (`tools/world/real-places.mjs`). It refuses to write a pack in which any of
    them survives.
  - `pilotPack.test.ts` checks the shipped pack again. "Harrowmere" is a placeholder name for the region.
- **The data and its licences.** Everything comes from open government data that allows commercial use with
  attribution and has no share-alike terms. OpenStreetMap is avoided on purpose: its licence is share-alike.
  - Streets: the Ontario Road Network composite. Water: the Ontario Hydro Network. Both are under the Open Government
    Licence – Ontario.
  - Buildings: Statistics Canada's Open Database of Buildings, under the Open Government Licence – Canada, with
    municipal outlines under the Open Government Licence – Toronto.
  - The statements are in `NOTICE.md` and travel inside the pack.
- **The pipeline** (`tools/world/`, never shipped). The compiled pack is `world/pilot.region.json.gz` (2.5 MB):
  - `fetch.mjs` pulls the streets and water inside a box from the provincial query services.
  - `odb.py` streams one province file of the building database straight out of its remote zip: it inflates while
    downloading, pulls the footprints in the box through the file's spatial index, then deletes the file. The disk
    never holds more than one 0.9 GB file.
  - `compile.mjs` runs the pure compiler (`src/01_Initialize_World/region/`):
    - a transverse Mercator projection to metres, agreeing with the meridian arc to 0.1 mm over 55 km;
    - clipping to the box and simplification;
    - holes grouped into the polygons they pierce (the islands);
    - fictional naming;
    - the real-name check.
- **How it runs.** The region's geometry is built on the page:
  - buildings are merged into 445 tiles of 400 m;
  - streets and sidewalks become ribbons, and water is triangulated.
  The physics worker gets the region's bounds and its 431,461 walls. It lays ground tiles of 200 m over the region at
  once and builds walls as trimeshes of 250 m tiles, only within two tiles of the player, as they move. The physics
  boots in 0.34 s instead of 6 s, and a region of any size would boot in the same time. The Ring-0 audit's
  containment slab is the region's own.
- **Not there yet:**
  - traffic and pedestrians (the AI drives and walks the procedural grid, so the region's fleet is empty and the
    crowd it keeps is hidden, kilometres away);
  - traffic signals, street lamps and trees;
  - terrain (the region is flat: no ravines, no bluffs);
  - elevated roads and bridges (the expressway runs at street level, and you can wade the rivers);
  - varied landmarks;
  - an in-app credits screen.
  - On this machine's integrated GPU, boot takes 20–40 s, and the frame rate swings between the Low and High tiers.
    Level of detail and streaming for rendering are the next step.

## Ghost view

`G`, or `ghost on` in the console, shows every physics shape as falling green code over the frame: buildings,
the pier, lamps, trees and signal poles, every car's chassis, and the capsule of every pedestrian within 160 m. The glyphs are
the product's own, 16 strokes on a 3 × 3 lattice. Edges light where one shape meets another or a surface turns
away; everything else dims behind the code. `G` again, or `ghost off`, fades it out.

- **View only.** It draws copies of the colliders' shapes in a pass of their own
  (`07_Execute_Actions/ghost.ts`). It never touches the physics, the kernel or a pedestrian, and it is not in the
  scene the city renders.
- **Sharp under the cinema camera.** It is composited last, over the finished frame: after the 1/48 s shutter,
  the ND, the film curve and FXAA. It writes nothing to the velocity buffer, so it never smears. The city behind
  it still does.
- **Every tier.** It lives in the post chain, so while it is on the chain runs even at the Minimal tier. With
  `?post=0` there is no chain, and `ghost on` says so.

## Ghost-mode collision

You pass through people, street lamps, trees and signal poles, and they pass through you. Nothing reacts: nobody is
shoved, no pole stops you, and the people keep their line.

- **The street furniture is in the physics world as sensors** (`physics.ts`). Ghost view still shows every pole, and
  a query can still find one, but a pole exchanges no contact. The avatar's controller, a car's wheels, the AI
  drivers' obstacle ray and the ground guard all ignore sensors. A car drives through a lamp as over open road.
- **The crowd never sees you as a neighbour.** The avatar is not put in the grid the pedestrians steer by
  (`crowd.wgsl` `binAgents`), so none of them steps aside, falls in beside you, or drifts toward you. Someone you ask
  over still keeps their talking distance: that comes from the summons, not from collision.
- **What stays solid:** the ground, the buildings, the seawall, the pier's deck and railings, and the cars. Cars stay
  solid because the kernel is built on them. The Bouncer brakes for you, and the Sanctuary turns you into a sensor
  when a car is about to reach you. The Ring-0 audit treats a car overlapping a solid person as an impact. None of that
  changed.
- **The transition.** Where the camera goes through something, the frame washes into code for a moment
  (`07_Execute_Actions/contact.ts`, drawn by ghost view's composite).
  - It triggers on foot on a pole, a person or a car (the Sanctuary letting one through you). At the wheel it
    triggers on a pole or a person.
  - An iris of the ghost view's falling glyphs opens from the centre of the frame in 0.12 s, in the green of what you
    met. It holds at least 0.2 s and clears over 0.55 s. A glancing touch plays the whole wipe.
  - **View-only**, like ghost view. It reads what the page already has (the city's furniture, the audited state, the
    crowd's newest frame) and sets two uniforms. It is composited after the shutter, the film curve and FXAA, so it is
    never smeared or graded.
  - While a wipe plays the post chain runs, even at the Minimal tier, unless `?post=0`. There, for that moment, the
    film curve stands in for the direct path's ACES under the code.
  - `sim` and `__SIM__` report it as `output.contact`: how far the iris is open, the kind met, and how many
    passages since boot.

## First person, WebXR-ready

The camera is only ever the avatar's head (`07_Execute_Actions/player.ts`, `HeadRig`). There is no
orbit, chase or detached camera and no zoom.

- **On foot:** the eye is 1.7 m above the feet, and the mouse, touch drag or right stick turn the head
  (yaw and pitch, no roll). The body faces where you look. Your own body is not drawn to your eye, but it
  still casts its shadow.
- **Driving:** the eye sits at the driver's seat (left side). The head turns with the car and can look
  about 110° either way within the cabin. The car's shell is drawn from inside (cowl, pillars, roof
  lining) with clear glass, and the exterior sound is muffled in the cabin.
- **VR comfort:** there is no head bob. Only vertical steps such as curbs are smoothed, never
  horizontal motion.
- **WebXR seam:** `HeadRig.pose` (eye position, yaw, pitch) is the one place the camera is set. A
  future WebXR session would drive or offset that pose from the headset. WebXR itself is not implemented
  yet.

## Onboarding and the spatial HUD

- **Boot:** the page is black with the Monolith from its first paint. There are no loading bars or
  text. Once the city is running it fades from black into the first-person view at golden hour.
- **Wren, the concierge** (they/them), introduces themselves on a frosted-glass card and asks what to
  call you. The name field is already focused: type and press Enter (Esc skips).
  - The name labels your avatar in the HUD and is kept in this browser only (`localStorage`, key
    `civic-simulation:profile:v1`). A returning visitor is welcomed back by name without the question.
  - Wren then gives two or three tips and settles into a small chip.
- **Glyphs:** every control hint follows the input in use. When a pad is picked up it switches silently to
  that pad's layout: the two letter layouts (A or B at the south button), numbered shoulders and stick clicks,
  or button positions (South, East, North) for a pad it does not recognise. On phones it switches to touch
  labels. Hints are plain letters, numbers, positions and arrows: no platform names, logos or button symbols.
- **Tell Wren a goal.** From the chip, say what you want in plain words ("make it night and less
  crowded", "it feels laggy"). Wren asks up to five short "why" questions with quick replies, then shows a
  brief: the steps it can apply now (clock, quality, sound) are done at once, the rest are laid out as a
  plan, and "Copy brief" gives an engineer a note naming the modules each step would touch. This engine
  (`06_Make_Decisions/intent.ts`) is deterministic and offline: no language model, no network, and no
  console syntax is ever shown.

## The ethical kernel

All pedestrians and the player's avatar count as people. There are no weapons and no violence
anywhere in the product.

- **Ring-0 bouncer** (`02_Define_The_Rules/laws.ts`). Every vehicle command is ranked by three laws.
  A lower law never overrides a higher one:
  1. **Protect people.** If a person is inside the stopping envelope in the direction of travel, the
     command becomes a full emergency stop, whatever the driver asked for. The envelope is
     `v·latency + v²/2a`, plus a 1.5 m standoff.
  2. **Follow instructions.** Otherwise the player's controls stand, even when the Third Law would
     object.
  3. **Preserve itself.** AI drivers do not throttle into an obstacle they cannot stop for.

  The ranking follows Isaac Asimov's Three Laws of Robotics (1942). The wording is original.
- **Sensing** (`crowd.wgsl`, `crowdSim.ts`). Every step the GPU measures, for each car, the distance to the
  nearest pedestrian inside its steering-bent corridor ahead and behind. It does this in the physics worker, on
  a GPU device of the worker's own, over pedestrians that only the worker simulates. The CPU measures the avatar
  exactly. Before the Bouncer uses a reading, the worker makes it safe for its age:
  - It takes off how far the car has actually driven since (its odometer on the realm clock, beyond the sensing
    latency the envelope already covers).
  - It takes off how far a pedestrian can have walked at the shader's 3 m/s cap.
  - Once a reading is older than that latency, "nobody" only means "nobody within 30 m", and it ages like any
    other reading.

  A stale reading therefore only ever brings a person nearer. A car moved by `recover` holds until the crowd has
  measured it where it now stands. Scripted intents are ruled on the same step's sensing as the player's own
  controls. A sensor silent for over a second vouches for nobody, so every car holds. A lost sensor halts the
  realm.
- **Sanctuary** (`07_Execute_Actions/sanctuary.ts`). This is the last line of defence, run before
  every Rapier step.
  - A person collider that a moving vehicle is about to reach flips from **Solid to Sensor**, so no
    impulse is exchanged. The person is nudged aside, never through a wall.
  - The collider becomes solid again once every car is clear.
  - Wheel ray casts ignore sensors, so a car never rides over anyone.
  - The GPU pedestrians are never Rapier bodies, so they carry no kinetic impact to begin with. A car
    that touches one only pushes them aside into a spring-damper stagger (a "safety nudge").
- **Ring-0 audit** (`02_Define_The_Rules/ring0.ts`). After every physics step, inside the physics worker and
  before any state leaves it (so before anything is rendered or sent to hardware), an independent auditor (plain
  geometry, no Rapier query) checks every vehicle and every Rapier person. Any of these is a **kernel panic**:
  a non-finite position or velocity anywhere (including a
  flag the GPU crowd raises for its own state); a body below the ground or outside the world slab; a speed over
  100 m/s; a *solid* person overlapped by a moving vehicle (an impact: the Bouncer and the Sanctuary both
  failed); a moving vehicle within the 1.5 m standoff of a solid person in its path *without* an emergency stop
  applied (the Bouncer failed). A panic logs `[RING-0 FATAL]`, disconnects the hardware bus, halts physics,
  rendering and audio, shows **SYSTEM LOCKED**, and throws out of the frame. Speeds over 50 m/s are clamped and
  counted rather than panicked, and the 1.85 m radius around any moving vehicle is a watched perimeter whose
  breaches are counted, because verified First-Law stops land 1.71–1.97 m from the bumper and the Sanctuary's
  nudge leaves a shielded person 1.52 m from a car's centreline. The audit's counters are in the console
  (`kernel`, `stats`) and in `sim.kernel.stats().audit`; the auditor and its panic helper are frozen.
- **The physics realm** (`physics.worker.ts`, `simHost.ts`, `simCore.ts`). The Rapier world runs in a dedicated
  Web Worker, inlined into the single HTML file, together with everything that touches it: the fleet and its
  Bouncer, the avatar, the Sanctuary, the Ring-0 audit, and the GPU pedestrians with their hazard sensing, on
  the worker's own GPU device. Neither a worker's memory nor its GPU device can be reached from the page. So no DOM
  script, React component or injected code can read or write a body or a pedestrian, lower a hazard reading,
  replace a law or skip the audit.
  - **One door in.** The worker reads messages in `simHost.ts` and nowhere else. It accepts one `init` and then
    step requests; anything else is refused and counted.
  - **Plain numbers across.** Each step request carries the frame's controls and queued commands, and nothing
    about pedestrians or time. The worker clamps every number: nobody walks faster than a run, and the wheel and
    pedals stay in range. It keeps its own clock, which the cars, the crowd and the lights the page draws all
    run on, and lets it run at most 1.5× faster than the wall clock.
  - **The same order as before.** The worker runs the step in the order the page used to: commands, sensing,
    vetted controls, AI drivers, then the fixed substeps (Sanctuary, avatar, wheels). The audit runs right after
    the last substep, in the same realm, and includes the crowd's own non-finite flag. The crowd then steps on
    that outcome. Only then does the state leave: the car poses (`simProtocol.ts` POSE, drawn by `fleetView.ts`)
    and the pedestrians' newest render frame. The page writes that frame into its render buffers and culls it
    for its camera (`crowdCull.ts`); a frame whose flags halted the realm never leaves it.
  - **On a panic.** The worker halts for good and says why. The page then locks exactly as before.
  - **What the page can still do.** It can send the player's controls, which the Bouncer and the L2 limiter vet.
    It can send operator commands: tuning that only strengthens stopping, vetted intents, and teleport/recover
    (a car is never recovered onto a person). It sends the direction the player's own figure faces, which only
    turns that figure. It chooses which of the worker's pedestrians it draws, which changes only the picture.
  - **What it cannot do.** It cannot report or hide a pedestrian, raise or suppress the crowd's Ring-0 flag, or
    set the clock the signals run on. It cannot blind person sensing, switch off the Sanctuary, set a velocity or
    inject a hazard: those are harness commands, and only a worker built for `?debug` accepts them. It can stop
    the simulation by closing the worker, and that fails safe.
  - **The cost.** The page renders the worker's newest state, which is one physics step behind the frame's
    input. The head (mouse, headset) still turns in the same frame. The pedestrians are one GPU round trip
    older than the cars, about 2 frames. Each step, about 480 KB of pedestrian state crosses to the page for
    10,000 people. The page's CPU no longer runs the physics, and handing a step over costs it about 0.1 ms.
    The browser must offer WebGPU inside workers; without it the realm refuses to start rather than let the
    page sense pedestrians for it.
- **Runtime integrity inside the realm** (`vehicles.ts`, `laws.ts`). The Fleet and the Bouncer keep their state
  in ECMAScript `#private` fields, frozen with their prototypes. Each vehicle's Rapier handles never leave the
  Fleet; the Sanctuary gets plain-number footprints, and the audit's `clampSpeed()` can only slow a car down.
- **Degrees of success** (ORC-licensed open mechanics, `degrees.ts`, mirrored in WGSL). These checks
  shape behaviour: they never decide safety. A result 10 over the DC is a critical success, and 10
  under is a critical failure.
  - Pedestrians make a Reflex save to step out of an approaching car's path.
  - Pedestrians make a Perception check to notice the walk signal.
  - AI drivers make a Perception check that sets their reaction time before a comfortable stop.

Measured in headless Brave:
- **Driver stop:** an AI car at 39 km/h stops 1.9 m short of a person placed 24 m ahead.
- **First-Law floor:** with a person placed *inside* its envelope at 40 km/h, the floor stops the car
  1.95 m short.
- **Sanctuary alone:** with the bouncer deliberately blinded, a car rolling at 12 m/s passes through
  the person at 11.6 m/s (no impact), and the person is nudged 1.9 m aside.

## Ring-0 console

Press `~` to open it. It is a drop-down TTY: black at 85 % opacity, monospace, an ash-style prompt, a
React overlay at `z-index: 9999`. The simulation keeps running underneath, and game input is suspended
while you type.

- `stats` is live: Rapier step latency, physics phase, substeps, bodies, colliders and CCD bodies;
  drawn agents (near, far, total); fps, frame time, p95, CPU and GPU time; quality tier; kernel
  counters. `stats --once` prints a single frame.
- Other commands: `laws`, `kernel`, `quality [auto|0-4]`, `time [HH[:MM]]`,
  `audio [on|off|0-100]`, `ghost [on|off]`, `hal`, `hal pair hid|serial|ble`, `history`, `clear`, `uname -a`,
  `help`.
- `recruit <skill>` asks someone nearby with that skill over; `recruit listen`, `recruit stop`,
  `recruit install` and `recruit dismiss` run the voice side (see Recruitment below). `recruit` alone
  prints the microphone, who is coming over or tethered, the swarm's skills, and the last outcome.
- `memory` says where the swarm's memory is kept, how many people it holds, and what each person tethered now
  remembers; `memory <agent>` lists one pedestrian's episodes (see The swarm's memory below).

### The operator tier

`operator unlock` opens the elite tier for systems engineers; `operator lock` closes it again. While
unlocked:

- `run <skill>[,<skill>...]: <js>` runs a script (Shift+Enter for more lines) with a frozen `sim`
  object and a capturing `console`; `await` works, and a script that runs past its timeout is
  abandoned. `api` lists what `sim` offers: the clock, quality, the avatar (where it stands, feet height
  included; teleport; a walk at a given velocity for up to 10 s), every vehicle (state, park, recover, a
  player-style intent), crowd culling and where every pedestrian stands, physics and shader tuning, and the
  kernel counters.
- **A script needs someone with the skill.** It names the skills it needs before the colon (`run rust:
  sim.physics.tune()`, `run rust, go: …`), and it runs only through the task gateway (below): the
  console prints the gateway's word at once. **Rejected (Insufficient Capabilities)**: nobody tethered to
  you has one of them, and the script never runs. **Authorized**: the console names who it is bound to,
  and it starts in that same step. **Aborted (Spatial Tether Lost)**: one of them was let go (you walked
  more than 12 m away, got into a car, dismissed them, or the city halted); the console prints it the
  moment the state that let them go arrives, after whatever the script had logged, and a toast says so
  with the console closed. A line that names no skill is refused before anything reaches the gateway.
  While it runs, the HUD's swarm line counts the scripts bound to the swarm.
- **What a script bound to the swarm can do.** Every `sim` call goes through its lease: it is checked
  against the newest copy of the swarm and made in the same step, and once the tether breaks every call
  throws instead. `sleep` rejects the moment the tether breaks, and `signal` (an `AbortSignal`, also in
  scope) fires, so a script can stop cleanly. A script that ignores both cannot reach the city again. A
  script that times out loses its lease too, so an abandoned script cannot keep calling `sim` afterwards.
- `ask <skill>[,<skill>...]: <prompt>` asks the local model, answering as the tethered people who have the
  skill; the answer streams in live (see The local model below). `ask` alone reports the server, the model
  and what the server has; `ask model <name>` and `ask server <url>` set them up; `ask stop` stops an answer.
- `say <skill>[,<skill>...]: <text>` has the tethered person with the skill say the text aloud, from where
  they stand (see Speech below). `say` alone reports the speech server, the voice and the voices it has;
  `say voice <name>`, `say model <name>`, `say server <url>` and `say auto on|off` set it up; `say stop` cuts
  it off.
- `memory forget <agent>` and `memory forget all` erase what the swarm remembers (all: everyone in this city).
- `get [prefix]`/`set <key> <value>` read and write the tuning keys, namespaced by table:
  `physics.car.power`, `physics.car.drag`, `physics.car.grip`, `physics.car.brake`, `shaders.light.haze`,
  `shaders.light.exposure`, `shaders.light.sun`, `shaders.light.fill`, `shaders.volumetrics.strength`
  (`get physics` lists a whole table). Scripts use the same keys without the table prefix:
  `sim.physics.set('car.grip', 1.2)`. These are fixed, bounded knobs, not code: they go through the same
  validated facade directly, run no script, and need nobody tethered.
- `harness list` and `harness run <name>` run the physics harnesses in-page and print a report:
  `kernel-stop`, `first-law-floor`, `sanctuary`, `brake-distance`, `traffic-lights`, `spatial` (below).
- `record start [canvas|camera]`, `record stop`, `record status` record the simulation view (default) or the
  webcam (explicit; the browser asks for permission) as an `.agv` file: the product's own container, one packet
  per encoded frame (AV1, falling back to H.264 then VP9) with that frame's real telemetry alongside it — clock,
  tier, mode, position, kernel and audit counters, Wren's active brief. The file goes only where you choose it
  (the save dialog, or a download at stop where the dialog is unavailable); nothing is transmitted anywhere,
  and the recorder contains no network code. `05_Observe_Environment/agv.ts` reads the format back.

#### The spatial harness (`harness run spatial`)

Agents injected across the whole city to prove its spatial mechanics, from a plan the world seed alone decides
(`07_Execute_Actions/spatial.ts`), so the probes follow the generator wherever it puts a building:

- **The crowd, as it stands.** Every pedestrian's position is read three times, a second apart, and checked
  against the containment the crowd's shader enforces every step: nobody inside a lot (buildings and parks), nobody
  past the city's edge (so nobody in the lake), nobody at a non-finite position. Anyone on a carriageway away from a
  zebra crossing is counted; more than 2 % fails it.
- **The avatar, injected at 21 probes.** In each district (downtown, the heritage quarter, the lakefront, the park
  row), two lots, each with a run along its sidewalk (it must get through) and a run into its buildings (it must stop
  where the generator put the face, give or take 0.15 m; into a park it must walk on in). On the shore, a run into
  the seawall at two places, a walk up onto the pier's deck and out over the lake, and runs into its east railing
  and its far end.
- **A car, injected on six streets.** Downtown, through the heritage quarter, along the lakefront, along the
  lakeshore street and the east edge (the streets the grid gained), and the old grid edge. It drives on in its lane:
  at least 8 m, less than 0.8 m off its line, not turning.
- It borrows a spare car and moves the avatar, and puts both back. On this machine it takes about 70 s.
- The same harness runs in `npm test` on the whole generated city in real Rapier, with injected pedestrians.
  Faults are planted to prove it sees them, and the whole harness fails on each one alone:
  - a building left without its collider is walked into;
  - a seawall left out lets a run go on into the lake;
  - a pier without its deck is walked under, the feet at ground height;
  - a wall across a car's lane stops the car;
  - a pedestrian placed in a lot or in the lake is named.
  With a car parked in a probe's lane, that probe waits and then skips the street rather than drive into it.
- Each verdict is a pure function in `spatial.ts` (`judgeWalk`, `judgeCar`, `crowdFailures`, `streetFailures`),
  tested at the edge of each of its limits; a position that is not a finite number never passes. The plan steps
  around a tree or a pole planted in its way.

What the operator tier cannot do, by construction: the script facade has no member that reaches the
three laws, the Bouncer, the Sanctuary or the crowd's safety nudge (a structural test asserts it at every
depth); a scripted vehicle intent is vetted like the player's; and tuning is clamped so grip and brakes can
only be made stronger, never weaker, so no script can lengthen a stop past what the First Law assumes.
Only the harnesses may blind person sensing, for at most 20 s, to prove that the Sanctuary alone still
protects.

The console is air-gapped from the swarm. It can reach the engine only through a frozen
`TerminalBridge` (`terminal/bridge.ts`): read-only statistics, the laws, five operator controls
(clock, quality, audio, ghost view, peripheral pairing), recruitment, and the swarm's memory to read (erasing it
needs the operator tier). Recruitment is the one knob that reaches a
pedestrian, and it can only ask: the physics worker decides on its own readings whether anyone comes over,
and a summoned person's safety reflexes still come first. No command can spawn anyone, place or alter an
agent, move a vehicle or change the physics world. A unit test enforces that `terminal/*` imports only types
from the rest of the engine, and the locked-tier sweep pins the knobs to exactly these. The swarm reaches
the console the other way round too, read-only: the operator tier is handed the task gateway, which only
reads the worker's list, and every script must pass it. The console never holds the gateway, the
recruiter or the engine.

## Recruitment

Every pedestrian has two skills, fixed by their index (`03_Spawn_Agents/skills.ts`): Rust, TypeScript,
Python, Go, C++, WGSL, Shaders, Audio, Design, Testing, Security, Data, Robotics, Networking, Writing and
Accessibility. Stand on a sidewalk and ask for one, and the nearest person within earshot who has it
is **Interviewing** while they walk over. Once they stop 1.5 m from you and face you they are **Active**:
tethered to you, part of your swarm, until the tether breaks.

- **By voice.** `recruit listen` in the console opens the microphone for continuous recognition. Say a
  request word and a skill: "recruit a Rust developer", "I need someone who knows TypeScript", "anyone
  here do C plus plus?". The microphone is always open, so only an explicit request counts: a request
  phrase with the skill right after it (only words like "a", "someone who knows" or "good" may stand
  between). A skill named in passing ("rust never sleeps", "is there a problem with the network") asks
  nobody, nor does a request turned down ("I don't need a Rust developer", "we aren't hiring"), and a bare
  "go" is a verb. A later request in the same breath still counts ("never mind, recruit a designer").
  `recruit listen` reports what happened: listening, or why not (permission refused, no model, no
  microphone), and a failure also shows on the HUD. A blue **MIC** chip shows whenever the microphone
  is open, even with the HUD hidden. `recruit install` is refused while the microphone is open.
- **Without a microphone.** `recruit rust` in the console, or `recruit("Rust")` in the browser's
  developer console, makes the same request. The call returns a promise with the outcome.
- **Who can hear you.** Only people within 5 m (`AUDIBLE_RADIUS`), standing on the sidewalk, on your
  side of the street, with a straight walk to you that never touches the road. Nobody is called into a
  street, so you must be on a sidewalk yourself, and on foot. At most eight people can be over at once:
  that is the swarm's size.
- **Two realms decide.** The page matches on the main thread, against its own copy of the pedestrians'
  positions (refreshed from the render frames four times a second) and your head position
  (`head.ts`). It then asks the physics worker (`simCore.ts`), which checks again on its own readback. If
  the page's pick no longer qualifies, the worker asks the nearest person who does. A request goes with
  the next step the page sends, so while the tab is hidden it simply waits. If an answer is ever lost,
  the page gives up after 30 worker states, and lets the person go if an acceptance turns up later. The
  worker answers every request with an event, and its list of recruits is authoritative.
- **Walking over.** The request rides the crowd's uniform as a summon slot (`crowd.wgsl`). The GPU
  takes it only from someone on the sidewalk and within reach. A car still comes first: the freeze and
  the step back outrank a summons. The approach slows near you. A recruit never steps off the kerb, not
  even when the crowd jostles them: the rule binds the step they actually take, not only the one they
  choose.
- **Tethered.** An Active recruit follows you. Every worker step points their summons at where you stand
  now, and marks it tethered, so they walk after you and stop about 1.5 m away again. Fallen behind,
  they hurry at up to 2.4 m/s (`TETHER_PACE`). That keeps up with your 2 m/s walk and stays under the
  3 m/s pedestrian speed the First Law's sensing assumes, so a run outpaces them. Within 1.5 m, the
  part of their step that would take them towards you is dropped, whatever the crowd adds, and they
  back off as fast as you walk. Your own walk can still bring you closer as you pass someone on a narrow
  sidewalk (about 0.5 m at worst in the probes). Catching up does not make them Interviewing again.
  They follow in a straight line along the sidewalk and never step onto the road, so if you cross a
  street they wait at the kerb.
- **Your swarm on the HUD.** The step readout carries each recruit's two skills, the one you asked for
  first. The HUD shows every skill the Active recruits bring, each once, in the order they joined
  (`Active swarm 2: [Rust, Audio, Design, Data]`), then anyone still coming over. `recruit` in the
  console lists them too. The skills are display only: no command reaches a recruit through them.
- **Ending.** No timer ends a tether. It breaks if you walk more than 12 m away (you outran them, or
  crossed a street and kept going), if you get into a car, or on `recruit dismiss`. Before arrival, a
  recruit is also let go if the crowd never took the summons or if they cannot reach you in 15 s. They
  return to their day from the nearest corner of their own block, never from mid-street.
- **Your voice stays on the device.** Recognition runs only with the browser's on-device processing
  (`processLocally`); a browser that cannot promise it is not used, and the console says so. The
  on-device model is downloaded only when you run `recruit install` (the browser downloads it once).
  That is the only network access recruitment makes, and it happens only on your command. Nothing you
  say is stored beyond the last transcript shown by `recruit`.

A short two-note cue sounds where the person you asked stands, so you hear who is coming.

### The task gateway

`08_Swarm/taskRouter.ts` is the layer that work needing a skill goes through, so that it only happens
while someone who has that skill is physically with you. Every operator script goes through it (see The
operator tier): App builds it over the recruiter and hands it to the engine's terminal bridge, so the
operator tier knows only its shape (`SkillGate` in `operator.ts`) and never imports it.

- **The gate.** A task names the skills it requires, exactly as the city names them (any case; no
  guessing, so "rust developer" is not Rust). The gateway intersects them with the union of the skills
  of everyone Active in the page's newest copy of the worker's list. If any is missing, the task is
  **Rejected** (insufficient capabilities) and never runs. Otherwise it is **Authorized**, bound to the
  fewest tethers that cover it (the earliest to have joined on a tie), and started at once. The check
  and the start happen in one synchronous step, so no state can arrive between them.
- **The lease.** The task runs under an `AbortController`. Every state from the worker replaces the
  page's copy of the list first and re-checks every lease before that state's events are dispatched.
  A lease breaks when a bound tether is no longer Active: released, not arrived, or the same person under
  a new recruitment (each recruitment has its own serial, never reused). The task is then **Aborted**
  (spatial tether lost): its state changes, then its signal fires, inside that very update.
  `lease.use(act)` is the check and the use as one step: it looks at the newest list itself and runs
  `act` only if the lease still holds. A result counts only if the lease still holds when it arrives.
  There is no failover: a task bound to one person is aborted when they leave, even if someone else
  with the skill is still there.
- **What it cannot do.** It only reads the list the worker sends. It holds no engine, sends no command
  and reaches no pedestrian (a structural test pins its imports), and it has no clock and no randomness:
  a verdict depends only on the requirement, the states and the order in which the task settles. The
  guarantee is relative to what the page has been told. The worker decides who is tethered, from GPU
  readings a few frames old, and its states reach the page one step later.

### The local model (`ask`)

`ask rust: how does car.grip work?` asks a model running on this machine, as the person tethered to you
who knows Rust. `09_Cognition/localCompute.ts` speaks two wire formats, both streamed. The Ollama API
(`/api/generate`) is the default. The OpenAI-compatible chat-completions format (`/v1/chat/completions`, which most
local model servers also offer) is the other: `ask api chat` or `ask api generate`. No model and no model server
ships with the product: you run your own, and the city works exactly the same without one.

- **The default cognitive engine** is `qwen3-vl:4b` (Qwen3-VL 4B, open weights under Apache-2.0) on the local
  server at `http://localhost:11434`: `ask` answers with it as soon as the server has it, with nothing to set up.
  A server without it says so in one sentence (pull it, or choose another).
- **Two wire formats.** `ask api chat` sends a system and a user message to `/v1/chat/completions` and reads the
  server-sent events back. It shows the thinking a server streams, whichever of the two usual names the server gives
  it, and lists models from `/v1/models`.
  - In this format the server sets its own context window and decides whether to think, so `ask think` does not
    apply.
  - With Ollama, keep `generate`: it is the format that bounds the context (see Bounded).
  - The address must still be on this machine. A proprietary service can answer only through a gateway you run
    locally. The page itself never sends a prompt anywhere else.
- **Setting it up.** `ask` alone shows the server, the model, the wire format, whether it thinks first, and the
  models the server has. `ask model <name>` chooses another, `ask server <url>` another server on this machine, and
  `ask think on|off` whether the model reasons before it answers (off unless turned on). All are kept in this
  browser's local storage for this page.
- **Thinking takes time.** `qwen3-vl:4b` is a thinking model and reasons before it answers even with thinking
  off. Measured on this machine (AMD integrated GPU), a one-line question:
  - with the city closed: answered in 51 s, after 459 tokens of thinking;
  - with the city running on the same GPU: still thinking after 5 minutes. The model ran at about half speed and
    thought far longer; its sampling varies from one run to the next.
  For quick answers, pull an instruct model into the server and choose it with `ask model <name>`.
- **Through the gateway.** An ask is a task like a script. **Rejected (Insufficient Capabilities)**:
  nobody tethered has the skill, and the server never hears the prompt. **Authorized**: the request
  starts at once. The system prompt is the bound people's skills: who they are, all they know, and an
  instruction to answer only from that, then the last few things each of them remembers of you (see The
  swarm's memory). **Aborted (Spatial Tether Lost)**: if you walk away mid-answer,
  the request is cancelled in the state that lets them go, and the server sees the connection close. The
  console keeps what had arrived. `ask stop` stops an answer yourself. One answer runs at a time.
- **Live.** The answer streams into the console as the model writes it. A thinking model's thinking
  shows as a live count ("thinking… 57") until its answer starts. The HUD shows the latest words, and
  counts the task bound to the swarm. Each piece reaches the screen only through the lease, so nothing
  arrives once the tether is gone.
- **When it cannot answer, it says why in one sentence:** no server answering (start it, or point `ask`
  at it), running but refusing this page, no such model, a model that does not write text, or the
  server's own failure (for example, out of memory).
- **A page opened from a file.** The browser sends that page's origin as `null`, and a local server
  usually refuses it: Ollama does by default. `ask` detects this (a server that is up but refusing is
  told apart from one that is down) and says so. Open the page from `http://localhost` instead
  (`npm run preview` serves `dist` on `http://localhost:4173`, which Ollama allows by default), or allow
  the page's origin in the server's own settings.
- **Bounded.** Every request asks for a context of 8,192 tokens and an answer of at most 2,048. A
  model's own maximum can be far larger, and a server that sizes its memory to it can fail before the
  first word (seen here: a 4B model asking for 20.5 GB). Running a model beside the city costs frame
  rate, and the quality governor drops the tier to compensate.
- **What it cannot do.** It talks only to a loopback address (`localhost`, `127.0.0.0/8`, `[::1]`), and
  any other address is refused before anything is sent, so a prompt cannot leave the machine. It sends
  nothing unless you type `ask`, and nothing polls in the background. It sends no referrer. The engine
  holds no network code: App hands the client to the operator tier, which knows only its shape (`Mind` in
  `operator.ts`). A model's answer is text: nothing it writes is run or touches the city.

### Speech (`say`)

`say rust: over here, by the lamp` has the person tethered to you who knows Rust say it aloud, from where they
stand. `09_Cognition/localSpeech.ts` speaks the JSON API that local open-weights speech servers commonly offer
(`POST /v1/audio/speech`: the text, a voice, optionally a model; WAV back). No speech engine, model or voice ships
with the product: you run your own server under its own licence, and the city works exactly the same without one.

- **Setting it up.** `say` alone shows the server (`http://localhost:8880` unless you change it with
  `say server <url>`), the voice, the model and the voices the server lists. Choose a voice with
  `say voice <name>`: voice names differ from one server to the next, so none is guessed. The model is sent only
  once you choose one (`say model <name>`); otherwise the server uses its own. The settings are kept in this
  browser's local storage.
- **Through the gateway.** A say is a task like a script or an ask. **Rejected**: nobody tethered has the skill,
  and the server never hears the text. **Authorized**: the first person it is bound to says it. The audio is
  decoded by the soundscape and played through its own HRTF voice at that person's head (1.6 m), and the voice
  follows them as they walk. The HUD shows `Speaking · agent N`. **Aborted (Spatial Tether Lost)**: walk away and
  the speech stops mid-word, in the state that lets them go. A request still downloading is cancelled. `say stop`
  cuts it off yourself. One utterance at a time; at most 1,200 characters.
- **Answers aloud.** `say auto on` has every whole answer to `ask` said by whoever gave it, through the gateway
  again. The answer stays on screen as it streamed until the speech is over.
- **When it cannot speak, it says why in one sentence:** no server answering, running but refusing this page
  (a page opened from a file sends the origin `null`), no such voice, not a speech server, the server's own
  failure, or the city's sound being off (`audio on`).
- **What it cannot do.** It talks only to a loopback address, and any other is refused before anything is sent.
  It sends nothing unless you type `say` (or turn auto on), and no referrer. The engine holds no network code:
  it only decodes and places the audio App's client fetched (`SpeechOut` in `operator.ts`). Nothing from any
  speech server is bundled or linked, so its licence (some are GPL) does not reach this product.

### The swarm's memory

`08_Swarm/memory.ts` gives every pedestrian an episodic ledger, kept on this machine in the page's IndexedDB
(database `civic-simulation:swarm-memory`). A ledger is keyed by the world seed and the pedestrian's number, so
the same person in the same city remembers you however many times you ask them over. Each recruitment's serial
is written into its episodes, never used as the key.

- **What is remembered.** Being asked over and arriving (with the skills they brought); being let go, and why;
  every script, prompt and say they were bound to, with its outcome (Authorized, Rejected, Aborted), the
  prompt and the start of the answer. Each episode is one short line (at most 280 characters). A ledger keeps
  its newest 200 episodes in time order: a task is noted when it ends but placed where it began, so a say cut
  short by a release comes before it.
- **Used in answers.** While someone is tethered, their ledger is loaded, and an `ask` bound to them carries
  their last six episodes into the system prompt, as their own recollection ("5 min ago: the operator asked you
  about Rust: …").
- **Reading and forgetting.** `memory` and `memory <agent>` read it at any time. `memory forget <agent>` and
  `memory forget all` (this city only) need the operator tier.
- **Where it stays.** Only this browser, on this machine: nothing is sent anywhere, and nothing reaches the
  physics worker. A browser that refuses storage keeps the memory for the visit only, and `memory` says so.

## The cinema camera

By default the city is filmed like a high-end cinema camera: 24 frames per second through a 180° shutter, a
variable ND filter, and a film response instead of a video tone curve. `?cinema=0` turns it off.

- **24 fps, decoupled.** Every animation frame still reads input, sends the physics worker its step request,
  drives the haptics, poses the head and feeds the audio, at the display's rate. Only culling, lighting and
  drawing wait for the pacer (`07_Execute_Actions/cinema.ts`), which picks the animation frame nearest each 1/24 s:
  - 60 Hz alternates holds of 2 and 3 refreshes (the 3:2 cadence); 120 and 144 Hz hold 5 and 6 evenly.
  - Browser timestamps are rounded (to 0.1 ms), and at 60 Hz every other frame falls exactly between two
    refreshes. A slow phase lock keeps frames off those ties, so the cadence doesn't stutter.
  - After a dropped frame or a stall, the cadence restarts rather than hurrying frames to catch up. No two
    frames are ever closer than 25 ms.
- **180° shutter (1/48 s).**
  - The scene pass writes a velocity buffer beside its colour:
    - the static city's motion comes from the camera alone;
    - the cars' from three.js's per-instance matrix history;
    - each pedestrian's from their own velocity;
    - the front-to-back sorted buildings' from the camera only, because their instance slots change.
  - The shutter (`shutter.ts`) scales that motion to exactly 1/48 s whatever the hold was, and reconstructs
    the blur with tile-based filters from the graphics literature (credited in `NOTICE.md`).
  - A moving car's smear spills over the street behind it, and a spinning wheel smears around its rim.
  - Seat changes, teleports, stalls and resizes are cuts: that frame has no blur.
- **ND filter and film response.**
  - After the lens effects (bloom, sun shafts, vignette) a neutral-density stage takes the exposure down with
    the light: none at night, 0.84 stops (ND 0.25) in daylight. These are the same numbers the direct render
    path uses.
  - The film curve then maps light to the screen: y = xⁿ/(xⁿ + σⁿ), n = 1.5. It is calibrated so mid-grey
    lands where ACES put it in daylight, so the city keeps its brightness.
  - Highlights roll off toward white and never clip.
  - Shadows keep detail: ACES clips everything more than about 6 stops under mid-grey to black, and the film
    keeps code values there.
- **HUD.** The stats panel shows `Camera 24 fps · 1/48 s shutter · ND 0.25` above `Input 60 Hz`. The console's
  `stats` and `sim` add a `camera` row.
- **What it costs.**
  - The picture is up to one frame period (41.7 ms) behind the input; input and physics are not.
  - The 3:2 cadence on a 60 Hz display judders, as film on a 60 Hz TV does.
  - The Minimal tier draws without the post chain, so it gets the pacing but no blur and no film curve (unless
    ghost view is on, which keeps the chain running).

Measured in headless Brave (AMD GCN-5 integrated GPU, 1280×720) against `?cinema=0` on the same build:
- **Frame rate:** 24.00 frames drawn per second, with animation frames at the display's full rate. The
  governor held Ultra, against High with `?cinema=0`, which also dropped frames.
- **Input:** a key reached the physics worker in the same 2–3 animation frames either way.
- **Motion blur:** a 115°/s head turn kept 33 % of the still frame's edge contrast, against 85 % without the
  camera.
- **Tone:** pixels crushed to black fell from 0.23 % to 0.03 %.

## Golden-hour volumetrics

On the Ultra tier only, the post chain adds screen-space sun shafts: the scene's depth marks the sky,
which is blurred radially toward the sun's screen position and added as in-scattered light before tone
mapping. The effect is strongest with the sun 2–15° up, fades as the sun leaves the frame, and sits
behind a uniform gate, so lower tiers pay nothing and a tier change never recompiles a pipeline. Stand on
a street looking west at 17:20 and the building rows cut the sun into shafts.

## Hardware (Universal HAL)

`04_Connect_Hardware/hal.ts` is one bus for four transports. On start it silently re-opens every
device the browser granted before. Pairing a new device needs a user gesture, as browsers require:
run `hal pair …` in the console.

- **WebHID, DualSense and DualSense Edge.**
  - Brake pressure, including a First-Law stop, becomes left-trigger resistance.
  - Rumble pulses while the kernel holds your car.
  - Supported over USB (report 0x02) and Bluetooth (report 0x31 with CRC-32). The layouts are
    cross-checked against the Linux `hid-playstation` driver and open-source tools, **not yet
    verified on physical hardware**.
  - Trigger effects are reset on exit.
- **Web Serial and Web Bluetooth (Nordic UART Service).** These carry `HAL/1`, a line protocol for DIY
  dashboards:
  - The host sends `HELLO <name>/<version>` every 500 ms. The device answers `READY <device-name>`
    within 2 s.
  - The host then sends one JSON telemetry line at up to 10 Hz.
  - `PING` is answered with `PONG`. Serial runs at 115200 8N1; BLE writes go to RX `6e400002…` and
    the host listens on TX `6e400003…`.
- **Gamepad API.** Any standard-mapped controller works, no pairing needed.

Every API degrades silently where it is missing. Safari and Firefox have no WebHID, Web Serial or
Web Bluetooth.

## Autoscaling

A quality governor (`05_Observe_Environment/governor.ts`), fed from the `requestAnimationFrame` loop,
holds the frame rate between 60 and 90 FPS, from high-end desktop GPUs down to flagship phones, in a browser tab
or a native shell. Under the cinema camera it also holds the camera's 24 frames a second. It works silently: there
are no toasts and no settings menu, and the console's `quality` command is the only manual control.

- **Starting tier:** a device profile (adapter, touch, cores, memory) picks the starting tier. Phones
  start on Minimal or Low and are capped at Medium in auto mode.
- **Tiers:** there are five, Minimal to Ultra. They scale render resolution, shadows and shadow-map
  size, post-processing, and the crowd's LOD distance, near radius, draw distance and **density**.
  Density is a stable per-agent hash, so the same people stay visible.
- **Stepping down:** when FPS stays below 60 for more than 2 s (with 5 % vsync tolerance, so a clean
  60 Hz display never trips it), the governor steps down one tier. That thins the crowd's drawn
  InstancedMesh count and lowers the procedural texture resolution (256 → 192 → 128 → 64). Textures are
  pre-baked and swapped, so no shader recompiles and no frame hitch.
- **Stepping up:** only after several seconds of headroom, with cooldowns and backoff so it never
  oscillates. Both render paths are compiled during the boot splash, so a later tier change never
  compiles a pipeline mid-game.
- **Floor and ceiling:** phones start on Minimal or Low and are capped at Medium in auto mode; the
  browser exposes no thermal state, so frame time is the proxy. Ultra adds the volumetrics.
- **Under the cinema camera:** the governor still reads every animation frame, so it keeps input and physics
  at the display's rate. Only 24 of those frames a second are drawn, so each drawn frame gets more GPU time, and
  the governor usually settles a tier or two higher than it does with `?cinema=0`. Two rules are specific to it:
  - The animation frames are held at the 60 FPS floor whatever the display. A 120 or 144 Hz display does not buy
    extra input frames with fidelity, since the camera shows 24.
  - The camera's own frames are counted, in half-second slices. Short of 90 % of them in every slice for more
    than 2 s (a frame missed in each) steps down one tier, even while the animation frames look fine. A step up
    waits until the camera has presented 97 % of its frames for 5 s.
- **Where it runs.** A native shell (a Tauri v2 window, whose WebView2 on Windows 11 is desktop Chromium) is
  recognised by what Tauri injects, and the snapshot says so (`process.host`). It profiles as the desktop it is:
  a high-end GPU starts on Ultra with the full crowd.
- **How many pedestrians.** Unless `?crowd` says, the profile decides at boot: 14,000 wherever it starts on
  Medium or above, 8,000 on a phone, and 5,000 on the weakest GPUs and software rasterizers. The simulation's size
  is fixed for the session (the GPU buffers are sized for it). The tiers then scale how many are drawn.

Under a deliberate overload (60,000 pedestrians at 2× resolution) in headless Brave, it held for 5.5 s,
then stepped from High to Minimal. Drawn pedestrians fell from 17,345 to 615 and the texture from 256
to 64.

Under the cinema camera, measured in headless Brave on this machine (AMD integrated GPU):
- **At the defaults over 150 s:** Ultra at 24.0 presented frames a second. For about 25 s the machine slowed (the
  crowd's GPU round trip rose about 25×; it does this in every build here, the old ones included). The governor
  stepped down to Low within about 10 s, on the camera's rule and then on the 60 FPS rule, and the camera was
  back at 24 at Low. When the slowdown passed, it probed back up one tier at a time and held Ultra at 24 again.
- **With 60,000 pedestrians at 2× pixels:** it stepped down one tier at a time on the camera's rule, and Low held
  22–24 presented frames for about 30 s. When the machine slowed, only a smaller crowd could help: the crowd's
  simulation does not scale with the tiers.

## Spatial audio

`07_Execute_Actions/audio.ts` is a procedural Web Audio soundscape with no audio files and
HRTF-panned sources:
- **Cars:** the nearest cars get engine notes that follow a 5-speed gearbox, plus tyre noise, with
  Doppler.
- **Crowd:** a murmur on the sidewalks scales with crowd density and daylight.
- **Walk signals:** an accessible walk-signal tone plays at the nearest intersection during a walk
  phase: a cuckoo for north–south, a chirp for east–west.
- **Driving:** inside a car, the exterior is muffled.
- **Recruits:** a short two-note cue plays where someone you asked over stands.
- **Speech:** what a tethered person says (`say`) comes from their head, and follows them as they walk.

Audio starts on your first click, tap or key, as browsers require.

## Layout (causal order)

Every source file opens with "Why does this file exist? / What breaks if it is removed?".

| Stage | Files | Role |
|---|---|---|
| — | `brand.ts`, `MonolithLogo.tsx`, `App.tsx` | Product name and mark, React shell: boot veil, HUD, concierge, touch and console overlays |
| 01_Initialize_World | `world.ts`, `city.ts`, `materials.ts`, `fbmTexture.ts`, `solar.ts`, `region/` (`projection.ts`, `grid.ts`, `names.ts`, `clip.ts`, `pack.ts`, `compile.ts`, `regionWorld.ts`) | WebGPU device, city grid, districts, shoreline and furniture, procedural materials (filtered against moiré), sky, sun, haze, the lake; the surveyed region: its projection, fictional names, the compiler's core, the pack format, and its meshes, walls and places |
| 02_Define_The_Rules | `laws.ts`, `ring0.ts`, `ring0Panic.ts`, `civic.ts`, `degrees.ts` | Ring-0 bouncer and audit (both run in the physics worker), the page's panic lock; kernel limits, signal cycle, speed limit, checks; degrees of success |
| 03_Spawn_Agents | `crowd.wgsl`, `crowdCompute.ts`, `crowdSensor.ts`, `crowdSim.ts`, `crowdCull.ts`, `crowd.ts`, `skills.ts`, `ragdoll.ts`, `ragdollRig.ts` | GPU pedestrians, their hazard sensing and their summons (in the physics worker), the contract and layouts both sides share, culling/LOD/density and indirect InstancedMesh rendering (on the page); every pedestrian's skills and the recruitment rules both realms run; active-ragdoll scaffolding, not yet wired (the balance state machine and promotion pool, never a vehicle as cause; the Rapier rig with servo-driven joints) |
| 04_Connect_Hardware | `input.ts`, `hal.ts`, `dualsense.ts`, `lineLink.ts`, `gamepad.ts`, `peripheralPolicy.ts`, `TouchControls.tsx` | Keyboard/mouse/touch/gamepad, the hardware bus and its drivers; the draft default-deny gate for actuating peripherals (microcontrollers, drones; `docs/hal-peripherals-spec.md`), not yet wired |
| 05_Observe_Environment | `telemetry.ts`, `governor.ts`, `profile.ts` | SIPOC X snapshot, frame statistics, quality governor, the visitor's name |
| 06_Make_Decisions | `traffic.ts`, `intent.ts` | AI driver, including its reaction check; the 5-Whys intent engine |
| 07_Execute_Actions | `engine.ts`, `simClient.ts`, `simProtocol.ts`, `physics.worker.ts`, `simHost.ts`, `simCore.ts`, `physics.ts`, `vehicles.ts`, `car.ts`, `fleetView.ts`, `sanctuary.ts`, `player.ts`, `head.ts`, `quality.ts`, `audio.ts`, `postfx.ts`, `cinema.ts`, `shutter.ts`, `volumetrics.ts`, `ghost.ts`, `contact.ts`, `operator.ts`, `harness.ts`, `spatial.ts`, `Hud.tsx`, `BootVeil.tsx`, `Concierge.tsx`, `glyphs.ts`, `terminal/` | Frame loop; the physics realm (worker entry, its message door, the simulation core, Rapier world, fleet, sanctuary, avatar) and the page's end of it (client, protocol, fleet drawing, first-person head); quality applier, soundscape (with its speech voice), post chain, the cinema camera (24 fps pacer, 180° shutter, ND and film response), sun shafts, ghost view and the contact transition, operator facade and physics harnesses (the spatial sweep's plan among them), HUD, boot veil, concierge, control glyphs, console |
| 08_Swarm | `recruitment.ts`, `taskRouter.ts`, `memory.ts` | The operator's voice: on-device continuous speech recognition, the request parser, the main-thread proximity match, the request to the physics worker, and the console and `recruit()` fallback; the task gateway that binds skill-bound work to the tethered swarm; the swarm's episodic memory (IndexedDB, by world seed and pedestrian) |
| 09_Cognition | `localCompute.ts`, `localSpeech.ts` | The operator's local model and voice: clients for a model server and a speech server on this machine only, the system prompt from the tethered people's skills and memories, the streamed answer, the audio for the soundscape, the cut when the tether breaks, and every failure as one sentence |
| native/kv-pager | `01_geometry.rs`, `02_page_table.rs`, `03_gpu/`, `bin/stress.rs`, `bin/chaos/` | Outside the web build: a paged KV cache for a future native host (prefix caching, copy-on-write, the WGSL decode kernel, the stress and chaos runs); `CAUSAL.md` traces the copy-on-write chain |

## Vehicles

Sedans and SUVs are Rapier raycast vehicles:
- **Collisions:** strict CCD on every chassis.
- **Steering:** Ackermann geometry (the inner front wheel steers more).
- **Resistance:** aerodynamic drag and rolling resistance. Coast-down from 50 km/h is about
  0.3 m/s².
- **Powertrain and brakes:** a power limit, brakes scaled to mass, and engine braking.
- **Wheels:** visual wheel spin comes from Rapier.

AI drivers keep the right-hand lane, turn on Bézier paths, brake feed-forward to the stop line
(`v²/2d`) and hold it until green. They keep a safe following distance and steer by pure pursuit.

## Constraints

- **Single file.** `vite-plugin-singlefile` inlines everything, and Rapier's WASM ships embedded. Do
  not add a `public/` directory. The build embeds `NOTICE.md` and every bundled package's license text
  at the end of `dist/index.html`, and fails if `package.json`'s version differs from `BRAND.version`.
- **Content.** Civic and non-violent: the internal guideline is Canadian 14A. That is a film
  classification, so do not market the product as "14A-rated" (see `NOTICE.md`). Streets and districts
  have generic names.
- **Geography.** The procedural city is generated: no map data, no real building, no real place's name. Its
  districts borrow only a general character (a southern-Ontario heritage main street, a Great Lakes waterfront). The
  surveyed map (the pilot build) takes its geometry from open government data under the licences in `NOTICE.md`,
  never from share-alike sources. Its names are all fictional, and a pack in which a real one survives is refused.
  `compliance.test.ts` fails on any real place, landmark or street of the region named in the shipped source.
- **Brand names.** Control hints, labels and docs name positions and letters, not console makers or their
  button symbols. `compliance.test.ts` scans the source, the build config, the HTML shell, this README and the
  shipped notice for them, and checks that every runtime dependency (the physics worker's Rapier included) has
  its licence embedded in the build. The build itself fails if one is missing.
- **Licensing.** The game mechanics are under the ORC License; see `LICENSE` and `NOTICE.md`. The ORC
  License does not license software code. See the operator notes in `NOTICE.md` before a public
  release.

## Brand

The mark is the Monolith: a black rounded square with an open white triangle
(`MonolithLogo.tsx`). The favicon is generated from the same SVG. "ONYX" is provisional.
Preliminary trademark notes for ONYX, AEGIS and SENTIS are in `NOTICE.md`: Unity sells an AI
inference package named Sentis, and Aegis is a naval weapons system. Commission a clearance search
before you settle the name.

## Browser support and what is verified

Verified in headless Brave (WebGPU, AMD GCN-5 integrated GPU, 1280×720), about 75–85 fps:
- boot, brand, console, kernel and sanctuary;
- the governor under overload;
- the HRTF audio graph (running, 7 voices);
- phone emulation (390×844, touch): tap to begin, virtual stick.

The physics worker is verified the same way: the acceptance probes pass against it, and a hostile-script probe on
the production page finds no physics object in the page and has every crafted message refused.

For 1.3.0, on the release build, the same way (fresh profiles, interleaved with the 1.2.0 build):
- **Through a lamp.** Walking into the lamp at (290, 324.5): 1.2.0 stops the avatar at its face (x 289.56), 1.3.0
  walks through to x 293 with 0.001 m of sideways drift. The wipe starts at x 289.6, in the pole's green. Standing
  inside the lamp, 14–28 % of the frame is code; a step clear of it, none.
- **Through people.** Standing 30 s in a sidewalk lane, the nearest pedestrian came within 0.14–0.29 m of the avatar
  on 1.3.0, with 5–10 passages each playing the wipe. The avatar never moved. On 1.2.0 the crowd kept 0.53–0.68 m
  away (it stepped around the user).
- **The Minimal tier** shows the wipe too (the chain runs while it plays). Ghost view's own probe still passes: sharp
  code over a smeared head turn, and at the Minimal tier.
- **Tests and mutations:** 737 tests. 32 bugs planted in this release's code, and every one is caught.

For 1.2.0, on the release build, the same way:
- **The spatial harness:** `harness run spatial` typed into the live console passed in 69 s. It found all 13,999
  pedestrians inside the crowd's containment three times over (0.07 % on a carriageway off the zebras). All 21
  avatar probes and the 6 car probes passed, and the avatar came home.
- **The governor:** the default desktop profile simulated the full crowd and held 24.0 presented frames a
  second. A simulated Tauri window was recognised as native. Phone emulation got 5,000 pedestrians at Minimal. The
  overload and the 150 s runs are described under Autoscaling.
- **The default cognitive engine:** served from `http://localhost:4173` against the real local server with a
  fresh profile, `ask` alone showed `qwen3-vl:4b` as the chosen model. A prompt went to it through the gateway
  with no `ask model` typed. It was still thinking after 5 minutes (about 1,600 tokens of thinking), with the city
  sharing the GPU. The same request sent straight to the server with the city closed answered in 51 s. That
  latency is noted under The local model.

For 1.1.0, on the release build, the same way:
- **The city** at the Minimal, High and automatic tiers, with no page or GPU errors. The HUD names each district.
  The seawall stops a run at its face (z 665.7). The pier's deck takes you out over the lake (feet at 0.32 m), and
  its far rail stops you.
- **Ghost view** over the cinema camera stays sharp while the city behind it smears. It also runs at the Minimal
  tier, with no errors.
- **Speech**, from a mock loopback server with the same wire format:
  - Rejected never reaches the server.
  - A recruit says the line from their own head (the voice 0 m from them, at 1.6 m).
  - Walking away cuts it mid-word.
  - Every request stays on the machine.
- **The swarm's memory** in IndexedDB, from a page opened as a file, survives a reload in time order. Forget needs
  the operator tier.
- **Regressions:** the cinema camera's cadence, look and driver's seat; the tether; the operator loop; the local
  model's whole path.
- **Mutation testing:**
  - 57 planted bugs in this release's code: every one is caught by a test, or by the build for the licence
    plugin.
  - The cinema camera's 30 are still caught too.

Frame rates swung widely with other GPU load on the machine during these runs, so they were only compared in
interleaved runs. At a pinned Medium tier the release held about 23 of 24 presented frames a second. Going from
10,000 to 14,000 pedestrians cost 4–9 % of the animation-frame rate and nothing measurable in presented frames.

Not verified: a real open-weights speech server (a mock with the same wire format stood in), physical phones, a
physical DualSense, and HAL/1 devices.

## History

**Next (unreleased): the surveyed map.** The pilot region is described in The surveyed map (pilot). `npm run
build:pilot` builds it, `tools/world/` compiles regions, and a guard test checks the shipped pack's names. Also:
- the physics worker builds a region, streaming its walls;
- the Ring-0 audit takes a region's slab;
- the minimap takes a region's layer;
- an empty fleet no longer leaves WebGPU a zero-sized binding.

**1.3.0** (the Crimson Noir architecture spec):
- **Ghost-mode collision.** Lamps, trees and signal poles are sensors, so the avatar and every car pass through them.
  The crowd no longer steers around the user, and each person keeps their line. Buildings, the shore and the cars
  stay solid, and so does the safety kernel.
- **The contact transition.** Passing through a person, a pole or (on foot) a car washes the frame into code for a
  moment, composited after the film camera like ghost view.
- **`ask api chat`**: the OpenAI-compatible chat-completions format beside the Ollama API, still loopback only.
- **Rulings on the spec:**
  - **Motion blur.** The spec's "three-pass accumulation buffer" is kept as built. The 180° shutter already reconstructs
    1/48 s of motion in three passes (tile maximum, neighbourhood maximum, gather). Re-rendering the scene three times
    a frame would triple the cost for the same exposure, and the optics are locked.
  - **Already shipped:** the 24 fps pacer, the soft film curve (n = 1.5, shadows kept), the three laws and
    non-violence, the Ring-0 audit, and the lakefront.
  - **"Hybrid" model.** The operator chose to keep the air gap: any server that speaks either format can answer, as
    long as it is on this machine.
  - **The map.** The operator's order to make the map a near-identical Greater Toronto Area, under fictional names, is
    the next phase. It starts with a pilot area.
- **Fixes:** two real place names reached the screen: the HUD's sky line read "Clear · Toronto", and Wren called the
  waterfront "Harbourfront". They now read "Clear" and "Lakefront", and `compliance.test.ts` fails the build's tests
  on any string in the shipped source that names a real place of the region, a landmark or a street.

**1.2.0**:
- **Agent injection:** the spatial harness (`harness run spatial`, and in `npm test` on the whole city in real
  Rapier), with `sim.avatar.walk`, `sim.avatar.position().feetY` and `sim.crowd.positions` for scripts.
- **The default cognitive engine:** `qwen3-vl:4b` on the local server, with no setup; `ask think on|off`.
- **The governor under the cinema camera:** it holds the camera's 24 frames a second as well as the 60 FPS floor
  (at 60 whatever the display), recognises native Tauri v2 windows, and picks the crowd's size from the device
  profile when `?crowd` does not.
- **Fixes:** the socket tests wait for the server to see a request end, instead of 60 ms (they could fail on a
  busy machine).

**1.1.0** (the Crimson Noir release):
- **Compliance.** The physics worker's bundle now has its licences collected too, so Rapier's Apache-2.0 notice
  is embedded, and the build fails if any runtime dependency lacks its notice. Controller hints name button
  positions (South, East, North), never a console maker's symbols or names.
- **Ghost view** (`G`): every physics shape as code over the finished frame, sharp under the cinema camera.
- **The city grew** from 12 × 12 to 16 × 16 blocks, with the heritage quarter, the lakefront, the promenade,
  the seawall, the pier and the lake. The default crowd rose from 10,000 to 14,000 (slightly fewer people per
  street than before).
- **Speech** (`say`) through a local speech server, heard from the tethered person's head.
- **The swarm's memory**, kept in IndexedDB by world seed and pedestrian number.
- **Fixes:**
  - At the Minimal tier the buildings' shader failed to build (an empty output). The cinema camera's velocity
    output for the re-sorted buildings was attached to their material, so it followed them into the direct,
    no-post render. It now lives in the scene pass alone.
  - Brick courses, paving joints and window mullions no longer shimmer into moiré at a distance. Joints thinner
    than a pixel stay continuous instead of breaking into dashes.
  - The ground's relief follows each zone's own paving. The downtown slab pattern had been lit everywhere, on the
    promenade too.

This project began as Agent City. Its 0.11.0-rc.1 Rust workspace is archived, unmodified, at
`../AgentCity-0.11.0-rc.1-rust-archive.zip` (70 files).
