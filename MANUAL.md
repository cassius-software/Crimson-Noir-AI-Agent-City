# Crimson Noir: Agent City, the manual

*An enterprise in the palm of your hands.*

> This is the full manual of Crimson Noir: Agent City. The overview, quickstart, release and licence are in
> [README.md](README.md).

> **The product is Crimson Noir: Agent City.** Its name and its mark live in one place, `src/brand.ts`; see
> [Brand](#brand).

A business-casual, non-violent civic simulation that ships as one self-contained HTML file. It is a
16 × 16-block city under a moving sun: a downtown of towers, a heritage quarter of stone and brick rows, and a
lakefront of condominiums along a promenade, a seawall and a pier. It has 14,000 GPU-simulated pedestrians
who wait for the walk signal, and Rapier3D traffic that obeys the lights and, by default, drives a fixed network
of right-turn rings that cannot jam (trains, drones, planes and VTOLs keep timetables above it). Every
vehicle command, from the AI or from you, passes a three-law safety kernel before it reaches the wheels. You see
everything **first person**, at eye level, on foot or from the driver's seat. You can walk the districts (straight
through people, lamps and trees, which dissolve into falling green binary code as you pass: the collision model is
ghost mode), take any car, see every physics shape in ghost view (`G`), or open the Ring-0 console with `~`. Up to
four people can play on one screen, and the operator can join a room hosted on this machine.

It opens with no clicks. A black splash with the skyline mark fades straight into the street at golden hour, and
Sloane, the concierge, asks what to call you: type a name and press Enter, then walk. Sloane's chip also opens the
wardrobe.

```sh
npm install
npm run dev      # local dev server
npm run build    # typecheck (app + tests), then emit dist/index.html: one file, every asset inlined
npm test         # 1,316 tests (node --test), including real Rapier physics and a real WebSocket host in Node
npm run lint     # oxlint
npm run verify   # the formal verification step (tools/verify/fvps.sh for cmd and PowerShell too): see FVPS below
npm run serve:net  # the optional network host (Node only, never bundled): see Networking
npm run smoke:net  # the host as a process of its own, attacked with crafted illegal movement: see Networking
npm run smoke:bridge  # Crimson Noir OS's hosted runtime against the host's ledger door: see Networking
sudo deploy/deploy-live.sh HOST EMAIL  # the host in production on a server, behind Let's Encrypt TLS: see deploy/README.md
```

Open `dist/index.html` directly: no server, and it works offline. The page sends nothing off this machine except
through a gateway to the Claude API that the operator runs on it with their own key, and to a session the operator
joins with `net join`. The gateway, when one is running, is asked when the operator chooses it (`ask provider
claude`), when the default provider `auto` finds no model on this machine answering and no model file kept in the page
(first for its list of models, which it asks the Claude API for; also when a model stops answering partway through a
visit), and by the cloud fallback while the frame rate is low. While `auto` answers with a model on this machine, it
asks the gateway nothing; once it has found the gateway it keeps it for the visit, so a model started afterwards is
used only when the gateway stops answering or `ask` alone looks again. The local model providers and `say` talk only
to a model server and a speech server on this same machine, and only when asked (see The model providers, Speech and
Networking). A model file you keep in the page itself (`ask provider inpage`) runs inside the page and talks to
nothing at all, on a page that is served rather than opened from a file (see A model in this page). It needs WebGPU:

- **Desktop and Android:** a current Chrome, Edge or Brave.
- **iPhone, iPad and Mac:** Safari 26.

The crowd runs as WGSL compute and has no WebGL path. `?boot=tty` opens the Ring-0 console alone, with no WebGPU
at all (see Track B under Ring-0 console).

## Controls

| | Keyboard and mouse | Gamepad | Touch |
|---|---|---|---|
| Walk / drive | W A S D, or the arrow keys | left stick; right trigger throttle, left trigger brake | left thumb stick |
| Look (head) | drag with the mouse, or click to capture it | right stick | drag on the right half |
| Run | Shift (either) | left-stick click | Run button |
| Enter / exit a car | E | south face button | Enter car / Exit car |
| Handbrake | Space | east face button | Handbrake |
| Right the car | R | north face button | Reset |
| Ping (mark a spot or a person where you look) | Q, or the middle mouse button | right shoulder button | Ping |
| Clock −1 h / +1 h | `[` `]` | D-pad left / right | Menu: Clock −1 h / +1 h |
| Ghost view | G | | Menu: Ghost view |
| Rain mode | M | | Menu: Rain mode |
| Hide HUD | H | | Menu: Hide HUD |
| Ring-0 console | `~` (Backquote) | | Menu: Console (Close shuts it) |
| A model file for the model in this page | `ask file` in the console, or drop the file on the city | | Menu: Model file |
| Allow / refuse a city action an agent proposed | Y / N with the console closed; act ok / act no, or y / n, in it | d-pad and the south face button on the card | tap Allow / Refuse |

A ping pressed again within a second asks the next kind: go, look, gather, wait (see Pings and the rally under
Recruitment). With `?players=2`…`4` the keyboard, the mouse and touch stay player 1's, and each further gamepad
drives a player of its own, entering, leaving and righting its own car (see Split screen).

- **Touch.** The round Menu button (three lines) rides with the action buttons at the bottom right: on foot above
  Ping and Run (beside Enter car near one), at the wheel just before Ping (the row above the brakes, in landscape).
  Like them it answers the touch itself, so it opens with the other thumb on the stick. It opens a sheet with the
  keyboard's one-key actions, upward and to the button's left (above the button where there is no room to its left),
  never past the edge of the screen (a sheet taller than the room scrolls); turning the phone or getting in or out of
  a car closes it. The console opens from the tap itself, so the on-screen keyboard comes up, and shows a Close button
  on a touch screen. Every text field reads at 16 px on a touch screen, so Safari does not zoom the page when one
  takes focus. Held upright while driving, Ping, Reset and Exit car stand in a column, clear of the stick (on a phone
  under 376 px across, Reset and Exit car share a row above the brakes, which stand one over the other). On a short
  screen (under 500 px tall) the Brake and Handbrake buttons are a size smaller. Sloane's card stands clear of the
  buttons: on foot in the band between the stick and the buttons (on a phone under 600 px across it gives up the
  stick's inner edge rather than grow too narrow), at the wheel over the buttons, and it scrolls inside itself when a
  short screen cannot hold it. Her chip stands under the minimap and the HUD's panels, above the buttons; held
  upright, the HUD's messages start below it on foot, and at the wheel one message, cut to a line, stands above it; on
  a short phone in landscape it rises to end above the buttons, and where there is no room under the minimap (a phone
  under browser bars) it moves left of it, its goal text cut short to keep clear of the HUD's panels on the left
  (under about 600 px across it can still reach a passing message there). On a short screen the HUD's readout keeps to
  three lines: a paired pad's line takes the First Law counter's place, and a passing message takes the readout's
  place while it shows, clear of the stick. This follows the touch buttons being on screen, so a pad paired with a
  phone keeps it. The browser smoke test checks, at six phone and tablet sizes both ways up and at two landscape views
  under browser bars, on foot, driving and driving with a paired pad, that every control is on screen and clear of the
  others, the stick, the speedometer, Sloane's chip and her Controls card, that the chip is clear of the stick, the
  minimap and the HUD's panels and as wide as its buttons, that the HUD, with two of its messages raised at each size,
  stays clear of the buttons and the stick, and that the Menu's sheet stays inside the screen. On a touch laptop the
  overlay goes away as soon as the mouse moves (the Run toggle with it), and comes back with the next touch. On a
  tablet whose main pointer stays the finger with a mouse or trackpad attached (an iPad in Safari 26, going by
  WebKit's source and not yet tried on an iPad; a Windows 2-in-1 in tablet mode) the overlay stays, and a mouse drag
  there looks like a finger's; if the browser comes to report a fine main pointer, it behaves like a touch laptop (the
  overlay goes, the Run toggle with it).
- **Mouse and keyboard.** A captured mouse asks for raw counts (`unadjustedMovement`) where the browser has them. A
  jump of more than 400 counts arriving at many times the speed of the moves before it (a driver's spike) is dropped;
  speed is counts per millisecond between events, so a long frame whose moves the browser merged into one event is
  kept, and while the mouse keeps moving, two events in a row are never dropped. Once the mouse has rested (50 ms and
  two frames without a move), the next move is timed over the frame it arrived in: a jump of more than 400 counts at
  over 16 counts per millisecond is a spike, while a turn from rest and a long frame's merged move are kept (a flick
  fast enough to cover 400 counts in its first 25 ms loses that first frame). Space and the arrows never click a
  button a mouse click or a tap left focused, also after switching to another window and back or with a key held
  through the tap, and under a captured mouse they are always the game's; a button reached with Tab (Sloane's chips)
  still presses with Space. A Command chord on a Mac (Cmd+A, Cmd+Tab) holds no key, since macOS sends no key-up for
  its letter. The right mouse button opens no menu over the city. Keys are read by place (`KeyboardEvent.code`), so
  on AZERTY the walk keys are Z Q S D.
- **Gamepads.** A pad with the standard mapping is read as the table says. One without it (some Bluetooth pads, and
  pads Firefox on Linux does not recognise) waits until one of its first four buttons (its face buttons) is pressed,
  so a throttle quadrant, pedals or a wheel left plugged in never takes a player's seat; that press only wakes it.
  `hal` lists it meanwhile, with what to press, and a device without a stick is never used. Awake, it is read by
  position, and `hal` lists it as a best guess by position: the left stick and the first face buttons always; the
  Linux kernel's order in full (both sticks, the triggers, the d-pad) once axes 2 and 5 have sat at one end for half
  a second with the sticks centred; a right stick on axes 2/3 when there are exactly four axes. Each axis is read only
  after it is seen resting where its part rests (a stick centred, a trigger at its end), timed in seconds whatever
  the frame rate. An axis already off centre when the pad wakes must sit centred and still (within 1% of its travel)
  for a second and a half before it counts as a stick, so a stick held then comes alive a moment after it is let go,
  while a pedal, a trigger or a lever resting at an end never walks or drives anyone, even after passing the middle
  or pausing there under a foot. A pad that puts a stick or a hat on axes 2 and 5 (the joystick driver's order on
  Linux; Chromium on Windows puts a pad's right stick there) is taken for the kernel's order if it is held at one end
  for half a second; until both sit centred and still for half a second, moving them brakes and throttles (at half
  when centred), and then the order is dropped for good. Two real triggers held still at half pull together for half
  a second drop it too, until the pad reconnects. It is still a guess: a lever parked at its middle when the pad
  wakes, or a pair of triggers on a four-axis pad, is read as a stick and can turn or spin the view.

## URL options

| Option | Meaning |
|---|---|
| `?quality=auto` (default) | The quality governor picks the tier; `?quality=0`…`4` pins one: Minimal, Low, Medium, High, Ultra; `?quality=-1` or `?quality=lite` pins Lite, below Minimal (see Autoscaling); `?quality=5` or `?quality=peak` pins Peak, above Ultra |
| `?peak=1`, `?peak=0` | `?peak=1` lets the governor try Peak on this computer even when it would not pick it by itself (it still needs the GPU's own timings); `?peak=0` keeps Peak away. Phones and the lite profile never try it (see Autoscaling) |
| `?fps=60` | Frame-rate target (default: estimated from the display, held within 60–90) |
| `?crowd=14000` | Pedestrians, from 256 to 60,000 (default: 14,000 on a desktop GPU, 8,000 on a phone, 5,000 on the weakest devices, 2,500 on a lite profile) |
| `?cars=36` | Cars, at most 48 (default: 36, or 12 on a lite profile) |
| `?lite=1`, `?lite=0` | Forces the lite profile on any device, or keeps it off one the profile would make lite (default: the device profile decides; see Autoscaling) |
| `?map=city` | The procedural city (people and traffic); `?map=lakefront` the generated metropolis; `?region=on` the embedded surveyed map. With neither, the console's `map` choice, else the onboarding's metropolis, else the city |
| `?time=17` | Start hour (default 17:00, golden hour) |
| `?day=24` | Real minutes per simulated day |
| `?scale=1` | Base pixel ratio |
| `?seed=1337` | World seed |
| `?shadows=0`, `?post=0` | Caps that apply at every quality tier |
| `?tracks=0` | Turns the fixed track network off: AI cars take random street-hopping routes, and there are no trains, drones or planes (default: on; see Vehicles) |
| `?players=1`…`4` | Local split screen: one viewport per player (default 1; see Split screen) |
| `?cinema=0` | Turns the cinema camera off: every frame is drawn, no motion blur, ACES tone mapping (see The cinema camera) |
| `?ragdoll=0` | Turns the balance machine off: no pedestrian is ever promoted to a physical body (default: on; see The balance machine under The ethical kernel) |
| `?audio=0` | Start with the soundscape muted |
| `?captions=0` | Start with the closed captions off (`captions on` turns them on; see Spatial audio) |
| `?boot=tty` | Track B: the Ring-0 console alone, full screen, with no canvas, no engine, no WebGPU, no physics worker and no audio; `boot gui` reloads the city (see Ring-0 console) |
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

The fixed track network (`06_Make_Decisions/tracks.ts`) is laid over the grid from the same seed: 64 right-turn
rings for the cars, one round each 2 × 2-block cell; one elevated train loop on a deck 9 m over the median of the
two arterial streets, with four mid-block stations and guideway columns at the kerb; drone corridors at 40 m and
46 m over the 4 × 4-block face rings; one plane racetrack at 400 m; and two VTOL routes along the avenues at 75 and
85 m, each calling at four rooftop pads. See Vehicles.

## The surveyed map

The map is becoming a real metropolitan region with fictional names: its streets, buildings, shoreline and water
are surveyed, and every name is invented. Real fictional cities work the same way. The first piece is a
pilot region of 12.1 × 7.8 km: the downtown waterfront, its harbour and islands, 49,620 buildings, 11,141 street runs.
Every build carries it: `dist/index.html` holds the compiled pack (`world/pilot.region.json.gz`, 2.5 MB, as base64,
about 3.4 MB of the file's 14 MB), so the one file plays the region from a disk or a stick with no network and nothing
beside it. The page inflates the pack itself (the browser's own gzip stream); nothing is fetched.

- `?region=on` walks the surveyed region in any build. The default build opens on the procedural city, where the
  traffic, the crowd and the tracks are; the surveyed region has none of them yet (see Not there yet). Lakefront Metro,
  the generated map, has its own (next).
- `?map=lakefront` walks Lakefront Metro instead: a fictitious great-lake metropolis generated from the world seed
  (`?seed`) by `src/01_Initialize_World/lakefront.ts`, 64 blocks (2.56 km) across in the page and 256 (10.24 km) in
  the committed layouts. A massive lake fills the south behind a wandering shore with a harbour; a highly dense
  financial core stands against the water with The Spire (168 floors, 554 m) on the waterfront; deep ravines, meandering
  by fractal Brownian motion, slice the grid from the north to the lake and are crossed only by the arterials' bridges;
  and a suburban grid sprawls north, west and east with transit hubs, nodes of skyscrapers, inside it. Five regions
  under CC0 fictitious names: Lakefront Metropolis (the core and the old city), West Sprawl (its main hub is Transit
  City), The East Bluffs (houses on the cliffs above the east shore), North Ridge (the northern sprawl on its rise) and
  The Grand Ravine (the main ravine and the streets along it). The map is built in a worker while the concierge's
  onboarding talks a first visitor through four one-word questions, and turned into a region pack
  (`region/fromMacro.ts`), so it is walked through the same region path as the surveyed region. Unlike that one it has
  people and traffic: its streets lie on the city's own 40 m pitch, so a **street window** of 16 × 16 blocks around
  where the visitor starts (`region/streets.ts`) is read back from the pack's roads, and the GPU crowd walks that
  window's sidewalks (crowd.wgsl takes the window's corner and, per street segment, whether a sidewalk runs along it and
  whether cars use it, so nobody walks a dropped street or waits at a crosswalk over a pedestrian street), while the
  fleet is seated on rings laid over the window's whole cells (disjoint rectangles whose every side is a car street,
  the zero-jam rule of `tracks.ts` kept) and the lamps, trees and signal poles stand along the window's streets. Every
  street cars use is two lanes, one each way; a bridge's shore walls are cut for its width. Beyond the window the
  metropolis is still quiet. The visitor's answers are saved, so the next visit opens on the same city at the chosen region;
  `?map=city` or `?region=off` opens the procedural city, `?onboarding=0` skips the onboarding (the expert path) and
  `?onboarding=1` shows it again. The structural layouts, one JSON file per region with an index naming The Spire and
  the hubs, are committed under `world/lakefront/` and regenerated with `node tools/world/lakefront.mjs` (`--check`
  compares; `lakefront.test.ts` fails while they are stale). Every name a map or pack carries passes the CC0 asset gate
  (`src/01_Initialize_World/assets/cc0.ts`), which purges anything naming a gun, rifle, pistol or weapon.
- The pilot build opens on the region, and `?region=off` shows the procedural city instead:

```sh
npm run build:pilot   # dist-pilot/index.html: the same single offline file, opening on the region
```

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
- **Not there yet** (the surveyed region; Lakefront Metro has its street window, above):
  - traffic and pedestrians (the AI drives and walks the procedural grid, so the surveyed region's fleet is empty and
    the crowd it keeps is hidden, kilometres away);
  - the craft (the elevated loop, the corridors and the VTOL pads are laid over the procedural grid and its roofs, so
    no region gets trains, drones, planes or VTOLs);
  - room acoustics (a region's walls live in the physics worker, so every voice there is dry);
  - traffic signals, street lamps and trees (the surveyed region has none; a street window has them along its streets);
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
  `?post=0` there is no chain, and `ghost on` says so; the same while the screen is split (see Split screen) and on
  a lite profile, whose boot never compiles the chain (`?lite=0` brings it back; see Autoscaling).

## Matrix mode

`M`, or `rain on` in the console, turns every surface of the city into falling green code, drawn in world space by
the surfaces' own materials (`01_Initialize_World/matrixMesh.wgsl`, bound by `matrixMode.ts`): a roof takes its
columns from its (x, z), a wall from its own plane, so the code sits on the facades, the streets, the lake, the
props, the cars and the people and moves with them as the camera moves. The sky is never touched: it is drawn as
ever. `M` again, or `rain off`, restores every surface at once.

- **One global state.** Both pipelines read one word, `global_state` = (time, matrix mode, floating origin x, z),
  defined once (`01_Initialize_World/globalState.ts`): the materials' uniform, and the crowd's `Params.global`
  (`03_Spawn_Agents/crowd.wgsl`), so the drawing and the simulation cannot disagree about the mode.
- **Physics.** In matrix mode every pedestrian's physics mask drops to the static world's layer alone
  (`crowd.wgsl physicsMaskFor`): the ground still holds them at street level and the lots and the city's edge still
  keep them out of the buildings, while the other pedestrians and the cars pass through them with no push, no
  stagger and no step back. The First-Law sensing is untouched: a car still sees whoever is in its path, and the
  Sanctuary and the kernel run as usual. Cars already pass through cars (`02_Define_The_Rules/collision.ts`).
- **Floating origin.** The pattern is a `fract()` of the world position, which loses precision far from the
  world's origin. The page anchors an origin at the camera, snapped to whole metres, and the shader computes its
  columns relative to it, adding the origin back into the column's id as a whole number, so the pattern is the same
  wherever the camera stands and never slides as the origin steps.

## Ghost-mode collision

You pass through people, street lamps, trees and signal poles, and they pass through you. Nothing reacts: nobody is
shoved, no pole stops you, and the people keep their line.

- **The street furniture is in the physics world as sensors** (`physics.ts`). Ghost view still shows every pole, and
  a query can still find one, but a pole exchanges no contact. The avatar's controller, a car's wheels, the AI
  drivers' obstacle ray and the ground guard all ignore sensors. A car drives through a lamp as over open road.
- **The crowd never sees you as a neighbour.** The avatar is not put in the grid the pedestrians steer by
  (`crowd.wgsl` `binAgents`), so none of them steps aside, falls in beside you, or drifts toward you. Someone you ask
  over still keeps their talking distance: that comes from the summons, not from collision.
- **What stays solid:** the ground, the buildings, the seawall, the pier's deck and railings, to people and to the
  world; and the cars to the world. On foot you walk through a car, parked or rolling, as through a lamp
  (`COLLISION.avatarThroughCars`): your capsule and a chassis never pair, so there is no impulse either way, and the
  car's mesh dissolves around your eye as you enter it. The kernel does not rest on cars being solid to people: the
  Bouncer brakes every car for you, holds one still while you stand inside its footprint, and the Sanctuary turns you
  into a sensor when a moving car is about to reach you, or when you come within 0.3 m of one whichever way it moves
  (you can run after a car pulling away). The Ring-0 audit treats a moving car overlapping a solid person as an
  impact; a standing one is no reason to shield, so a parked car neither shields nor nudges you. Cars are not solid to
  each other either.
- **Cars pass through cars** (`02_Define_The_Rules/collision.ts`). The realm's contact policy is one frozen record,
  `COLLISION`, beside `CIVIC`'s `violence: false`: no vehicle-on-vehicle contact, the ragdoll balance machine wired
  with no vehicle ever a cause (see The balance machine under The ethical kernel), no combat, furniture as sensors,
  the Sanctuary between people and cars. Every chassis collider carries a collision group that filters other
  chassis out, and every wheel ray filters them out too, so a chassis pair is dropped in Rapier's broad phase: no
  contact, no impulse, and a wheel cannot ride up on a car it passes through. The ground, the buildings, the seawall
  and the pier keep the default groups, so a car is as solid as before to the world; the avatar's capsule filters
  chassis out too, so you walk through a parked car and shove nothing (`vehiclePassThrough.test.ts` walks the avatar
  straight through one with the Sanctuary on: no stop, no lift, no flip, the car unmoved). The AI drivers' bonnet rays keep the default groups too, so other cars stay
  obstacles to the Third Law, and CCD stays on every chassis. `vehiclePassThrough.test.ts` (real Rapier in Node)
  rolls a car at 10 m/s through a parked car on its line: it ends on the same line within 0.05 m and at the same
  speed within 0.05 m/s as over open road, the parked car moves under 1 mm, the rolling car never lifts more than
  0.02 m, and a wall still stops it. `collision.test.ts` keeps one road to the ragdoll: its two sources are imported
  at run time by `ragdollRealm.ts` alone, that module by `simCore.ts` alone, only the listed files name it, and a
  vehicle is not a cause it accepts. The avatar's capsule carries a group that filters a rig's segments out
  (`AVATAR_GROUPS`), so you walk through a promoted person as through anyone else, and shove nobody.
- **The code dissolve** (`01_Initialize_World/codeDissolve.ts`, `07_Execute_Actions/dissolve.ts`). Where your body
  meets something it passes through, that thing gives way. When the avatar's disc on foot, or the driven car's
  chassis at the wheel, each grown by 0.25 m, is inside a street lamp, a tree, a signal pole, a pedestrian or (on
  foot) a car, that mesh dissolves into falling green binary code at once and reinstantiates over 0.35 s once you
  are clear. Two cars passing through each other both dissolve, so the pass-through is never seen as
  interpenetration. The driven car never dissolves (its cabin is drawn from inside), and buildings never do (walls
  stop you).
  - It lives in each mesh's own material, not in a pass of its own: a per-instance amount, 0 solid to 1 gone, drops
    the mesh's screen cells top-down in falling columns, dims the cells still standing and inks them with glyphs in
    the green of what you met; at 1 every vertex folds to a point and nothing is rasterised. The alphabet is a `0`
    and a `1` drawn from strokes, no font. The same mask governs the shadow pass, so a dissolving mesh loses its
    shadow with its body. While nothing dissolves the materials draw exactly as before, and the cinema camera's
    velocity buffer is untouched.
  - Around your eye the dissolving mesh has a clear core: every cell of a fragment within 0.85 m of the camera is
    gone, and the column pattern is whole again from 2.2 m out (`CODE_DISSOLVE.coreInner`/`coreOuter`), so you look
    out through open code rather than into a wall of glyphs. The core belongs to the mesh you are inside: a mesh
    whose amount is idle has none, however close you stand, and nothing is drawn over the frame as a whole. A touched
    slot is at 1 the same frame; an untouched one falls to exactly 0 over the release. Each passage counts once.
  - **View-only**, like ghost view: it reads what the page already holds (the city's furniture, the
    audited state, the crowd's newest frame) and writes instance attributes. Nothing reaches the physics worker, no
    pedestrian moves, no pole stops anyone. `sim` and `__SIM__` report it as `output.dissolve`: how many instances
    are dissolved or reinstantiating now, and how many passages since boot. Its scans allocate nothing per frame.
  - **Limits.** A tree's collider is its trunk, so only the trunk triggers it (the canopy is never met). Under the
    cinema shutter a dissolving mesh's smear is sampled from the cells that survive. The envelope, the scans and the
    material graph are tested in Node; the compiled shader has not been seen in a WebGPU browser in this
    environment (see Browser support).
- **No full-screen transition.** Nothing is drawn over the frame as a whole when you pass through something: the
  mesh you are inside dissolves, and that is the whole effect. (Earlier builds opened an iris of code from the centre
  of the frame on every contact; it is gone, and the post chain no longer turns on for a passage.) The passage is
  still measured (`07_Execute_Actions/contact.ts`): `sim` and `__SIM__` report `output.contact` as the passage
  envelope (0..1, up over 0.12 s while your body is inside a lamp, a car or a person, held 0.2 s, down over 0.55 s),
  the kind met, and how many passages since boot.

## First person, WebXR-ready

The camera is only ever the avatar's head (`07_Execute_Actions/head.ts`, `HeadRig`; `player.ts` is the physics
worker's character controller, not a camera). There is no orbit, chase or detached camera and no zoom.

- **On foot:** the eye is 1.7 m above the feet for the reference body, and the mouse, touch drag or right stick turn
  the head (yaw and pitch, no roll). The wardrobe's **Height** moves the eye with the body (`eyeHeightFor`: 1.7 m
  times the body's height scale, held within 1.2–2.2 m), eased in like a curb step, never snapped: a tall look sees
  over the crowd, a short one looks up at it. The body faces where you look. Your own body is not drawn to your eye,
  but it
  still casts its shadow.
- **Driving:** the eye sits at the driver's seat (left side). The head turns with the car and can look
  about 110° either way within the cabin. The car's shell is drawn from inside (cowl, pillars, roof
  lining) with clear glass, and the exterior sound is muffled in the cabin.
- **VR comfort:** there is no head bob. Only vertical steps such as curbs are smoothed, never
  horizontal motion.
- **WebXR seam:** `HeadRig.pose` (eye position, yaw, pitch) is the one place the camera is set. A
  future WebXR session would drive or offset that pose from the headset. WebXR itself is not implemented
  yet.
- **Split screen:** with `?players`, each viewport is its own player's head, posed from that player's own avatar
  in the physics realm, or the car they drive (below).

## Split screen

`?players=2`…`4` cuts the canvas into a viewport per player (`07_Execute_Actions/viewports.ts`): two side by side
in landscape or stacked in portrait, three as one wide view across the top and two below, four as quadrants in
reading order. The rects tile the canvas exactly, in whole pixels.

- **Seats** (`04_Connect_Hardware/seats.ts`). Player 1 is the keyboard, the mouse, the touch overlay and the pad in
  seat 0. Players 2–4 are gamepads, dealt to seats in the order they appear: the lowest free seat among 1 to
  `n − 1` first, then seat 0; a pad that leaves frees its seat at once, and a seated pad keeps its seat however the
  browser orders its pad list. One pad per seat, one seat per pad; pads beyond the free seats wait. Every seat uses
  the same bindings (`07_Execute_Actions/controls.ts`: the frame loop's control block as a pure function, checked
  against a verbatim copy of the previous inline block over 2,000 intents, with nothing non-finite reaching the
  realm).
- **Every player is an avatar of their own in the physics realm.** Players 2–4 spawn beside player 1 along the
  sidewalk (`SimInit.spawns`), send their controls in the same step request (`StepRequest.players`), and are
  people to every part of the ethical kernel (see Up to four avatars under The ethical kernel). Each viewport is
  its own player's head (`HeadRig`), posed from that player's avatar or the car they drive; a pad's right stick
  turns it with the first player's curve and rates. Each pad's south button enters and leaves a car for its own
  player, and its north button rights that player's car (`interact` and `reset` carry the player). In a network
  room (see Networking) the room replays player 1 alone, so there only player 1 opens a car door: a player already
  driving when the room starts is put out of the car, and the other pads' south button does nothing until it
  ends.
- **Every player hears their own city.** Each has a soundscape of their own, in head space, over one shared audio
  context: Web Audio has one listener per context, so that listener stays at the identity and every source is
  placed relative to each head, with smaller car-voice and murmur pools per player. Speech and cues fan out to
  every listener. The console's `audio` knob acts on every player's soundscape, and its status line gains
  `· N players`.
- **What stays player 1's.** The post chain (the cinema shutter, bloom, ND, film response, ghost view) is player
  1's alone and is off while the screen is split: every viewport takes the direct ACES path, and
  `ghost on` says so. The sun's shadow focus, the lamp lights and the building sort follow player 1, so the other
  viewports get shadows only near player 1. The HUD, the captions, the pings, the code dissolve's scans, the
  passage count, the haptics, recruitment and the operator tier stay player 1's. Players 2–4 are not drawn as crowd
  figures, so a pedestrian may walk through them; they are protected exactly on the CPU, and safety does not rest
  on the figure.
- **Cost.** The crowd cull runs once per camera per presented frame, and `stats` reflects the last view. `sim` and
  `__SIM__` report `output.players`: the count, each viewport's rect and its seat.
- Four viewports on a WebGPU device, and which origin three's viewport uses, are browser checks not yet made here
  (see Browser support).

## Onboarding and the spatial HUD

- **Boot:** the page is black with the mark from its first paint. There are no loading bars or
  text. Once the city is running it fades from black into the first-person view at golden hour.
- **Sloane, the concierge** (they/them), introduces themselves on a frosted-glass card and asks what to
  call you. The name field is already focused: type and press Enter (Esc skips).
  - The name labels your avatar in the HUD and is kept in this browser only (`localStorage`, key
    `civic-simulation:profile:v1`). A returning visitor is welcomed back by name without the question.
  - Sloane then gives two or three tips and settles into a small chip. The chip's **Look** button ("Change my look"
    in the full list) opens the wardrobe card: see The character customizer.
- **Sloane's voice** (`07_Execute_Actions/onboarding/speaker.ts`). With the sound on, Sloane says each line the card
  shows (the greeting, the goal questions, a nudge) and, in the onboarding, each line after you chose sound on. Two
  tiers, chosen per line, neither a download: the operator's speech provider when it has a voice chosen (`say voice`,
  see Speech), heard at your own head with no walls between; otherwise the browser's own speech synthesis, in an
  offline voice only (a voice the browser would fetch from a network service is never picked), a little lower and
  slower than it comes (Sloane's `velvet` profile). A provider that fails mid-line hands the line to the browser's
  voice; a new line cuts the one before. Nothing is said while the sound is off or `sloane off` is set (kept
  between visits, key `civic-simulation:concierge:v1`). No neural voice model ships with the page, so the browser
  tier sounds like the operating system's own voices and no better; `sloane` in the console says which tier speaks.
- **Pings and captions on the HUD.** The minimap rings every standing ping in its kind's colour, fading as it
  expires, and the newest shows as a chip over the world with what it asks, what it landed on and the distance (see
  Pings and the rally). The chip goes with `H`; the caption strip and the MIC chip do not (see Spatial audio).
- **Glyphs:** every control hint follows the input in use. When a pad is picked up it switches silently to
  that pad's layout: the two letter layouts (A or B at the south button), numbered shoulders and stick clicks,
  or button positions (South, East, North) for a pad it does not recognise. On phones it switches to touch
  labels. Hints are plain letters, numbers, positions and arrows: no platform names, logos or button symbols.
- **Tell Sloane a goal.** From the chip, say what you want in plain words ("make it night and less
  crowded", "it feels laggy"). Sloane asks up to five short "why" questions with quick replies, then shows a
  brief: the steps it can apply now (clock, quality, sound) are done at once, the rest are laid out as a
  plan, and "Copy brief" gives an engineer a note naming the modules each step would touch. This engine
  (`06_Make_Decisions/intent.ts`) is deterministic and offline: no language model, no network, and no
  console syntax is ever shown.
- **Sloane's first five minutes.** A visitor who has just walked in from the onboarding is watched quietly
  (`09_Cognition/tutorial.ts`, fed by `07_Execute_Actions/onboarding/useMentor.ts`): when they have done nothing
  for thirty seconds, Sloane says one line in the card, in the shape of a why and then a how ("Ever wonder what's
  behind you? Hold the mouse button down and drag…"), then settles back into the chip. Opening the wardrobe counts
  as having found it. One line at a time, at least
  forty-five seconds apart, in a fixed order (looking around, walking to The Spire, talking to someone, the M key,
  the clock keys, the wardrobe on Sloane's chip), skipping anything already done (a turn of the head, standing under
  the tower, a prompt sent, M
  pressed, the clock turned) and anything the device cannot do (a touch screen has no console or keys), and
  nothing after five minutes. It is never called a lesson. The line is the script's, or the configured model's
  rewording when it answers in time and keeps the key or name the line needs. Nothing of it is saved; the expert
  path (`?onboarding=0`, "I know my way around") and returning visitors are never watched.

## The character customizer

Sloane's chip has a **Look** button ("Change my look" in the full list) that opens the wardrobe card
(`07_Execute_Actions/Customizer.tsx`). The console's `look` edits the same look (see Ring-0 console).

- **The body** (`03_Spawn_Agents/humanoid.ts`) is one smooth person, lofted from rings over a skeleton of fifteen
  bones (trunk, chest, head; thigh, shin and foot; upper arm, forearm and hand; both sides), every vertex tied to
  two bones with a weight. The four outfits are part of the loft (a jacket hem, a shirt front between the lapels,
  the skirt, the tie, long hair, glasses, the bag, the cup), and a near and a far version of each body are built
  at boot (about a thousand and about 360 vertices). Everything is written by hand in that one file: no imported
  mesh, skeleton or morph target. The crowd's vertex stage (`03_Spawn_Agents/crowdBody.ts`, WGSL built from the
  same numbers) reshapes each vertex by the sliders, bends each joint from the walk phase (hips, knees and ankles;
  shoulders and elbows; a counter-twist of the chest; the head), blends its two bones, then applies the
  spring-damper tilt, the stature, the heading and the place, with the normals carried through the same
  arithmetic, so a wide shoulder is lit as the round thing it is. The CPU runs the same arithmetic for the card's
  silhouette and the tests, so the body the card draws is the body the street draws, to the number.
- **The wardrobe** (`03_Spawn_Agents/look.ts`) is the crowd's own, and closed by construction. A look is twenty
  slots: the body, eight body sliders (height, mass, muscle, shoulders, hips, legs, posture, head), and the eleven
  dress slots (skin, hair style, hair colour, top, bottom, shirt, shoes, tie, eyewear, bag, cup), every one an
  index into the crowd's catalogue: the four bodies `crowd.ts` draws (suit, smart casual, pantsuit, skirt suit),
  its five optional pieces (tie, bag, cup, long hair, glasses), its seventeen colour palettes verbatim
  (`look.test.ts` reads them out of `crowd.ts`'s source, so they cannot drift), the ninth hair colour the shader
  mixes in, and the sliders' steps. The height is 32 steps from 1.50 m to 2.05 m; mass, muscle, shoulders, hips,
  leg length and posture are sixteen steps each; the head eight. The module ships no colour, piece or body of its
  own, so nothing stored, typed or shared can dress anyone in anything the crowd does not wear today:
  `validateLook` accepts nothing but an object with exactly those slots, each within its body's options, and a look
  kept before the sliders existed (fourteen slots, with `build`) is upgraded on the way in, its height and build
  carried onto the new sliders and the rest set to the middle (`upgradeLegacyLook`).
- **The two words.** `packLook` folds the body, the pieces and the colours into one unsigned 32-bit word (its top
  six bits, where the old height and build sat, are spare) and `packFigure` the eight sliders into a second; the
  crowd carries both per agent in page-only storage attributes (`crowd.look`, `crowd.figure`): the body materials
  read them in place of the hash, and the page's cull reads the body out of the first to pick what to draw. No
  simulation pass binds either, so nothing of a look reaches the pedestrians' motion, the First-Law sensing, the
  protocol or the physics worker. `lookFromSeed(i)` reproduces, bit for bit, the choice the crowd's hash makes for
  agent `i`, sliders included (the hashed crowd draws its stature from a per-body range, men 1.64 m to 2.00 m and
  women 1.55 m to 1.87 m, and every other slider over its whole range), so an agent's look and a visitor's saved
  look are the same kind of record. The eye never sees its own body (there is no mirror, by design); its shadow,
  the body the cull draws and every other viewer do. The first-person eye stands at the look's own eye height
  (`head.ts`), so a tall look sees over a short one.
- **Codes and presets.** A look code is fifteen symbols, `XXXXX-XXXXX-XXXXX`, from an alphabet without I, L, O and
  U, carrying both words and a CRC-8 over them: it can be written down and shared, and `parseLookCode` ignores
  case, the dashes and spaces and refuses any single mistyped symbol. An eight-symbol code from before the sliders
  still reads, upgraded the same way as a stored look. Eight named presets, two per body (navy suit, charcoal suit,
  camel blazer, navy blazer, burgundy pantsuit, cream pantsuit, navy skirt suit, camel skirt suit), dress the
  picker, each with a figure of its own.
- **The card.** A silhouette of the look, from the front and from the left (the body's own rings after the
  sliders, in the look's colours; the tie, the bag and the hose keep the street's own colours), above a row per
  slot: the sliders as sliders (the height read in metres), named options as a segmented control, colours as
  swatches from the crowd's palettes; the presets; Randomise (the look the hash would give some other number);
  Reset (the look your own seed gives, the first use of the profile seed); and the code, to copy or to paste. Every
  change is worn at once, and the silhouette moves before the shadow shows it. Esc, the close button or Done puts
  it away.
- **Kept here.** The look is kept in this browser only (`localStorage`, key `civic-simulation:look:v1`,
  `05_Observe_Environment/lookStore.ts`), separate from the profile, so a renamed visitor keeps their outfit;
  every stored value goes through `validateLook` on the way in. The record's `v` names its layout: 2 is written
  now; a 1 (the fourteen slots) is read and upgraded.
- **Your agents** (`08_Swarm/roster.ts`). The card's second row of tabs holds the agents you make your own, at most
  twelve: type a name (one word, screened under 14A like any name the city shows) and press Add. Each tab sets their
  pronouns (they/them, she/her, he/him, any), a role in your words (one line, at most 48 characters, held to the same
  14A screen as names), a voice (one of twelve profiles, six that lean neither way, three lighter, three deeper, or a
  voice name your speech provider lists), and a look over the same wardrobe. **Hear** says a line in that voice: a
  profile shapes the browser's offline voice; a provider voice is said by the provider at your head.
  `agent hire <name> [<skill>]` in the console asks someone nearby with that skill over as them, dresses that pedestrian in the
  agent's look, and from then on their prompts are told who they are ("You go by Nova (she/her), a quant analyst.")
  and `say` speaks them in their provider voice. A hire lasts while that person stays with you: one who leaves or is
  dismissed is let go and dressed as the city dresses them, and no hire outlasts the visit. The roster itself is kept
  in this browser only (key `civic-simulation:roster:v1`); every stored record is validated on the way in. Forget
  removes an agent from the roster and dresses their pedestrian as the city does; it does not break the tether
  (`recruit dismiss` does).
- **Limits.** Recruits who are not on your roster are not dressed automatically, though `look show <agent>`
  reads what any pedestrian wears. A voice profile shapes only the browser's voice (pitch and rate); a provider
  voice is the provider's to sound like. The tie's cloth, the bag's leather and the skirt suit's hose keep their hashed
  colours (the look word has no slot for them). The sliders reshape the walking body and its shadow; a pedestrian the
  realm has promoted to a physical body (a trip, a shove, the balance machine) is still drawn as the rig's capsules at
  the rig's one size for as long as the fall lasts, and the network ghosts keep the base body. Feet still slide a
  little on a kerb (no foot placement yet), and heads do not turn to look. Whether agent 0's hashed look and
  `lookFromSeed(0)` agree on the GPU is a browser check not yet made (see Browser support); the skinned body has been
  looked at on a software WebGPU adapter and in CI's screenshots, not yet on a real GPU.

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
    impulse is exchanged. The person is nudged aside, never through a wall. "About to reach" is read the way the
    Ring-0 audit reads it: a car closes on a person at the faster of its centre's velocity and the nearest point's
    (a turning car's centre heads into its inner flank while the overhang behind the rear axle swings away), and a
    rig's foot is measured where the audit sees it, off its lower leg.
  - Any moving car within 0.3 m of a person's centre shields them whichever way it moves, since on foot you can run
    after a car pulling away. A car pulling away never nudges anyone: it clears them by itself.
  - The collider becomes solid again once every car is clear.
  - Wheel ray casts ignore sensors, so a car never rides over anyone.
  - The GPU pedestrians are never Rapier bodies, so they carry no kinetic impact to begin with. A car
    that touches one only pushes them aside into a spring-damper stagger (a "safety nudge").
- **Ring-0 audit** (`02_Define_The_Rules/ring0.ts`). After every physics step, inside the physics worker and
  before any state leaves it (so before anything is rendered or sent to hardware), an independent auditor (plain
  geometry, no Rapier query) checks every vehicle and every Rapier person (each avatar, and each of the thirteen
  shapes of a promoted pedestrian's rig, with an id of its own from 1000). Any of these is a **kernel panic**:
  a non-finite position or velocity anywhere (including a
  flag the GPU crowd raises for its own state); a body below the ground or outside the world slab; a speed over
  100 m/s; a *solid* person overlapped by a moving vehicle (an impact: the Bouncer and the Sanctuary both
  failed); a moving vehicle within the 1.5 m standoff of a solid person in its path *without* an emergency stop
  applied (the Bouncer failed). A panic logs `[RING-0 FATAL]`, disconnects the hardware bus, halts physics,
  rendering and audio, shows **SYSTEM LOCKED** with a Restart button, and throws out of the frame. Speeds over 50 m/s are clamped and
  counted rather than panicked, and the 1.85 m radius around any moving vehicle is a watched perimeter whose
  breaches are counted, because verified First-Law stops land 1.71–1.97 m from the bumper and the Sanctuary's
  nudge leaves a shielded person 1.52 m from a car's centreline. The audit's counters are in the console
  (`kernel`, `stats`) and in `sim.kernel.stats().audit`; the auditor and its panic helper are frozen. For the
  scheduled craft (trains, drones, planes) the audit also halts on any non-finite value or any craft below its
  corridor's floor (`Corridor Exploit`; see Vehicles). It only halts, never corrects.
- **The physics realm** (`physics.worker.ts`, `simHost.ts`, `simCore.ts`). The Rapier world runs in a dedicated
  Web Worker, inlined into the single HTML file, together with everything that touches it: the fleet and its
  Bouncer, the avatar, the Sanctuary, the Ring-0 audit, the promoted pedestrians' rigs and their balance machine,
  and the GPU pedestrians with their hazard sensing, on the worker's own GPU device. Neither a worker's memory nor its GPU device can be reached from the page. So no DOM
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
    that outcome. Only then does the state leave: the car poses (`simProtocol.ts` POSE, drawn by `fleetView.ts`),
    the craft stream (`TRACK_POSE`, drawn by `craftView.ts`), the rig stream (`RIG_POSE`, drawn by `rigView.ts`) and the
    pedestrians' newest render frame. The page writes that frame into its render buffers and culls it
    for its camera (`crowdCull.ts`); a frame whose flags halted the realm never leaves it, and neither does a rig
    stream.
  - **On a panic.** The worker halts for good and says why. The page then locks exactly as before.
  - **What the page can still do.** It can send the player's controls, which the Bouncer and the L2 limiter vet.
    It can send operator commands: tuning that only strengthens stopping, vetted intents, and teleport/recover
    (a car is never recovered onto a person). It sends the direction the player's own figure faces, which only
    turns that figure. It chooses which of the worker's pedestrians it draws, which changes only the picture. It
    sends players 2–4's controls (`StepRequest.players`), clamped like player 1's, and at init a spawn per extra
    player and whether the fleet drives tracks (a plain boolean at the door). It may ask that an Active recruit
    walk to a sidewalk point (a rally, below).
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
- **Up to four avatars** (`simProtocol.ts` `MAX_PLAYERS = 4`, `simPlayers.test.ts`). The realm holds one avatar
  per local player: player 1 is the operator, players 2–4 start at `SimInit.spawns` (a spawn inside a building lot
  is moved onto the sidewalk beside it; a surveyed region keeps it as given) and send their controls in
  `StepRequest.players`, clamped exactly like player 1's (a run at most; NaN or infinite controls are no control).
  Every avatar is a person to every part of the kernel: the Bouncer measures each one exactly (`Fleet.setPeople`:
  the nearest present person in each car's corridor holds the car, whoever is driving), the Sanctuary registers each
  as a ward in player order and shields the one a car is about to reach, and the Ring-0 audit lists each with its
  own id, so a car that reaches one halts the realm naming that person; the only person exempt from a car's
  footprint is the player driving it. One driver per car and one car per driver: `interact` and `teleport` take a
  player, and a car someone else is driving is refused with a `rejected` event. A car is never put down on anyone
  on foot: `recover` and `reset` are refused while a player stands within a car's half-length and a margin of the
  spot. The message door refuses malformed spawns at init and a non-list `players` per step, slices `players` to
  three, and reads a malformed entry as an idle player. `laws.ts` is untouched by this release and `ring0.ts`
  gained only the craft check; the audit invariants hold per avatar. Recruitment, the operator tier, haptics and
  the crowd's one player figure stay player 1's.
- **The balance machine** (`07_Execute_Actions/ragdollRealm.ts` over `03_Spawn_Agents/ragdoll.ts` and
  `ragdollRig.ts`; `ragdollRealm.test.ts`). The Phase 7.1 policy that kept the ragdoll scaffold unwired is reversed;
  the rule it was kept for is not: a vehicle is never a cause, and nobody is ever harmed. Pedestrians within 25 m of
  the operator may be promoted to a physical body in the realm by three causes, each read off the worker's own crowd
  readout between consecutive steps: a shove in a dense crowd (two people within 0.35 m closing faster than 0.5 m/s,
  the machine's own promote threshold on 70 kg; the slower one is shoved), a kerb trip (crossing the sidewalk's kerb
  line faster than 2.4 m/s) and a slip (one draw per reading from the realm's seeded rng, about one every 40 s near
  the operator, on someone walking). Never a vehicle: the pool refuses the word, no car's push is ever offered, and
  nobody within 3 m of a moving car's centre is promoted. A promoted person's rig (eleven capsules and two flat feet,
  76 kg, ten powered joints) is built where the crowd had them, moving as they moved, and the machine steps it every
  substep on what the rig measures: perturbed, catch step, sitting down, seated, recovering; on recovering the rig is
  removed and the person is the crowd's again. Each of the thirteen shapes is a ward of the Sanctuary (registered
  after the avatars, rebound each time its slot is built again; a car about to reach it flips it to a sensor and
  nudges it clear as a sidestep at the nudge's own speed, and a shielded shape keeps no gravity until every car is
  clear) and a person to the Ring-0 audit (id 1000 + 13 × slot + shape, solid while not a sensor): the IMPACT and
  UNGUARDED rules protect a fallen person exactly as they protect the avatar, and the Bouncer measures each rig's
  pelvis exactly beside the avatars. The crowd keeps simulating a promoted person meanwhile (no override of the GPU
  crowd exists), so the page hides their figure (`crowdCull.ts hide`: its position in the render copy only, sunk
  below the cull's floor) and draws the rig in its place (`rigView.ts`, instanced capsules in the colour the crowd
  gives that person's top; ghost view draws them as person proxies from the same matrices); on the handback the
  figure reappears where the crowd has it. The rig stream (`RIG_POSE`: per slot the pedestrian, the state and the
  thirteen poses, 8 slots) leaves the realm after the audit, like the poses, and is transferred and taken back like
  the craft. `?ragdoll=0` turns it off; a region never has it; the door takes only `true`. Measured in Node (real
  Rapier, the stand-in crowd, 4 cars, 256 pedestrians): a shove at 2.6 m/s promotes one person, who is handed back
  after 4.85 s (catch step → sitting down → seated); the handback jump is 2.59 m with a figure that stood still (the
  shove carried the rig) and 4.22 m with one that walked on at 1.4 m/s; one rig costs about 0.5 ms per realm step
  and eight about 0.7 ms over an empty realm's 0.24 ms; a car at 12 m/s driven at a seated rig with sensing blinded
  flips all thirteen shapes and keeps the open-road speed trace to the last digit, with no panic; with the Sanctuary
  off as well the audit halts the realm with `First-Law Violation: Perimeter breached (0.227m) — vehicle 2, person
  1000.`; the pool never exceeds 8 and never promotes the operator's own figure. Not seen in a WebGPU browser in this
  environment (see Browser support).
- **A rally** (`SimCommand 'rally'`, `03_Spawn_Agents/skills.ts whyNotRally`). The one new thing the page may ask
  of a pedestrian: that an Active recruit walk to a sidewalk point instead of to the operator. The realm decides on
  its own readings, and a rally only changes where a summoned pedestrian walks on the sidewalk (see Pings and the
  rally under Recruitment).
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
- The core commands, as `help` prints them: `help [command]`, `stats [--once]`, `laws`, `kernel`,
  `quality [auto|lite|peak|-1|0-5]`, `time [HH[:MM]]`, `audio [on|off|0-100]`, `ghost [on|off]`, `rain [on|off]`, `render [on|off]`,
  `captions [on|off]`, `ping [go|look|gather|wait|clear]`,
  `look [show [<agent>]|<slot> <n|name>|preset <name>|code <code>|random [<seed>]|reset]`, `hal [pair hid|serial|ble]`,
  `recruit [<skill>|rally <agent> [<x> <z>]|listen|stop|install|dismiss]`, `memory [<agent>|forget <agent>|forget all]`,
  `clear`, `history`, `echo [text]`, `uname [-asnrvmi]`, `whoami`, `version`, `boot [gui|tty|status]`,
  `map [city|lakefront|default|status]`, `r0 <words...>|r0 reset|r0 words`, `agent [...]`, `sloane [...]`,
  `goal <words...>`, `exit`.
- `map` says which map the city shell walks. `map city` reloads into the procedural city (its 14,000 pedestrians and
  its traffic), `map lakefront` into the generated metropolis (no people or traffic of its own yet), and the choice
  is kept between visits until `map default` forgets it; the desktop app has no address bar, so this is its way to
  choose. A `?map=` or `?region=` word in the URL still wins for that visit.
- `render off` stops drawing: the canvas is cleared to black once and the HUD shows `RENDER OFF · console only ·
  render on`, while the physics realm, the step requests, the head pose, the haptics, the audio, the captions and
  the console keep running. The quality governor holds its tier while nothing is drawn. `render on` resumes with a
  cut. View-only: nothing of it crosses to the physics worker (`bootloader.test.ts` pins that the realm's modules
  name none of it).
- `captions [on|off]` turns the closed captions of every sound on or off (see Spatial audio); `?captions=0` starts
  them off.
- `ping [go|look|gather|wait]` marks where you look, as `Q` does; `ping` alone lists the marks standing, and
  `ping clear` takes them off the board. A `go` or `gather` ping is offered to the recruiter as a rally the physics
  worker re-checks (see Pings and the rally).
- `look` shows the look you wear, one line per slot and its code; `look show <agent>` a pedestrian's.
  `look <slot> <n|name>` sets one slot (`body`, `height`, `mass`, `muscle`, `shoulders`, `hips`, `legs`,
  `posture`, `head`, `skin`, `hairStyle`, `hairColour`, `top`, `bottom`, `shirt`, `shoes`, `tie`, `eyewear`, `bag`,
  `cup`; a height takes a step or metres, `look height 1.80`), `look preset <name>` one of the eight presets,
  `look code XXXXX-XXXXX-XXXXX` a shared look (an old eight-symbol code still reads), `look random [<seed>]` the
  look the hash gives some other number, and
  `look reset` the look your own seed gives (see The character customizer). Every value is checked against the
  wardrobe.
- `recruit <skill>` asks someone nearby with that skill over; `recruit rally <agent> [<x> <z>]` asks an Active
  recruit to walk to the newest ping's sidewalk point, or to a typed one (the page checks its own copy, the
  physics worker decides); `recruit listen`, `recruit stop`, `recruit install` and `recruit dismiss` run the voice
  side (see Recruitment below). `recruit` alone prints the microphone, who is coming over or tethered, the swarm's
  skills, and the last outcome.
- `memory` says where the swarm's memory is kept, how many people it holds, and what each person tethered now
  remembers; `memory <agent>` lists one pedestrian's episodes (see The swarm's memory below).
- `agent` lists your agents; `agent new <name>` adds one; `agent <name> pronouns|role|voice|look|name <value...>`
  sets one field (a look as a code from the wardrobe); `agent hire <name> [<skill>]` asks someone with that skill
  (the first skill unless named) over as them; `agent dismiss <name>` lets them go; `agent forget <name>` removes
  them; `agent voices` lists the twelve profiles (see The character customizer).
- `sloane` says whether Sloane speaks, in which tier, and in which voice; `sloane on|off` switches the voice (the
  card stays); `sloane voice <name>` prefers a browser voice by name or a word of it; `sloane voices` lists the
  browser's offline voices; `sloane say <text...>` has Sloane say a line now (see Onboarding and the spatial HUD).
- `goal <words...>` plans a goal as Sloane's card does (at most 160 characters): the steps it can take now (the
  clock, the quality tier, the sound) are applied and printed `done`, the rest `later`, a step that failed `failed`
  with why, and words nothing in the city maps to yet are named.
- `history` and the Up arrow never show a key typed to `ask key` or `say key` or a token typed to `net join`: all
  are kept as dots.

### Track B: the console alone

The product has two front ends over one physics realm. Track A is the WebGPU page: the city, the crowd, the
cinema camera, the HUD. Track B is this console on its own.

- **`?boot=tty`** mounts the console alone, full screen, black from the first paint: no canvas, no engine, no
  WebGPU request, no physics worker, no audio (`App.tsx` is `App` → `GuiShell` or `TtyShell`). The identity
  commands (`version`, `uname`, `help`, `boot`, `r0`, `history`, `echo`, `clear`) work; everything that needs the
  city says `engine not running`. The message of the day says so: `Track B: this console alone; no 3D engine was
  built`. `boot gui` (or the **Back to the city** button at the top right, which a pad's A also presses) reloads the
  page as the city, `boot tty` from the city reloads it as the console, and `boot`
  alone (or `boot status`) says which track is up. Neither the toggle key, Esc nor `exit` closes a full-screen
  console. `docs/track-b-console.png` is a screenshot of it.
- **`render off`** is Track B's override from inside Track A: the console takes the screen while the realm keeps
  stepping (above).
- **`r0`** is R0, the console's own language (`terminal/repl.ts`): a small Forth-like stack machine, the product's
  own. 32-bit integers that wrap; arithmetic (`+ - * / mod negate abs min max 1+ 1-`); comparison
  (`= <> < > <= >=`, true is −1); logic (`and or xor invert` bitwise, `not` logical, `lshift rshift`); the stack
  words (`dup drop swap over rot -rot nip tuck 2dup 2drop depth`); memory (`@ ! +!`) over 65,536 cells of 32-bit
  integers; output (`. emit cr space spaces ." text"`); colon definitions `: name … ;` that may call themselves,
  and `exit`; `if … else … then`, `begin … until`, `begin … while … repeat`; `( comments )` and `\ comments`. It
  is Turing-complete (unbounded loops and recursion over addressable memory; `repl.test.ts` runs an interpreter
  for another machine written in R0) and deterministic: the same lines in the same order always print the same.
  - **What it cannot reach.** It is blind by construction: `repl.ts` has no import line and no door to the host
    (no dynamic code, no global object, no clock, no randomness, no network, no storage, no timers, no DOM), and
    the `r0` command hands it nothing of the bridge, the engine or the page. The city stays reachable from the
    console only as before: through the operator tier and the capability gateway.
  - **Bounded.** Each line may run 1,000,000 instructions, print 16,384 characters, hold 4,096 words on the data
    stack and nest 4,096 calls. Past a bound the line ends with a named error (`step budget exhausted (1000000)`,
    `output limit exhausted (16384)`, `return stack overflow`, `stack overflow`) and the machine stays usable:
    definitions and memory survive, the data stack is cleared. A line that fails to compile (an unknown word, an
    unmatched `if`, an unterminated definition) runs nothing and installs no definition. A redefinition shadows
    the old word without changing words already compiled against it.
  - Definitions and memory last for the console session; `r0 reset` forgets every definition and zeroes the
    memory, and `r0 words` lists the words. A line of 100,000 steps or more prints its step count. A definition
    cannot span lines; there is no `do … loop`, no floating point and no string beyond `." text"`.
- **Not a headless engine.** Track B is "no engine" plus `render off`; a page-side simulation without a renderer
  is not attempted.

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
- `ask <skill>[,<skill>...]: <prompt>` asks the chosen model provider, answering as the tethered people who have the
  skill; the answer streams in live (see The model providers below). `ask` alone reports the provider, the server, the
  model, the masked key and the effort, and what the server has; `ask provider
  auto|claude|ollama|llamacpp|openai|inpage|scripted`, `ask connect <provider> [<url>] [<key>]` (the provider, its
  server and the Claude provider's key in one line, checked before anything changes), `ask key <key>|none`, `ask
  effort <level>`, `ask model <name>` and `ask server <url>` set it up; `ask stop` stops an answer. `ask file [forget
  <name>|load|unload|log]` and `ask gpu auto|on|off` keep and run a model file in this page (A model in this page);
  they send no prompt, so they need no unlock. An inadmissible prompt gets `-- no reply --` and reaches no model. The
  answer may end with one `ACTION:` line; what it proposes is shown as `act N: … proposes: …` and waits for your OK;
  `ask stop` withdraws it.
- **City actions, asked each time.** An agent's answer may end with one action from a fixed catalogue, and nothing
  happens until you allow it. Every provider is told the same four lines, at the end of the system prompt
  (`06_Make_Decisions/actions.ts ACTION_RULES`, so every prompt hash moved with them):

  ```
  City actions: to ask the operator for one change to the city, write your answer, then the action alone on the last line, exactly like this example:
  ACTION: time 20:00
  The actions: time HH:MM (or midnight, dawn, morning, noon, afternoon, golden hour, sunset, dusk, evening, night); rain on or off; light haze, exposure, sun or fill and a number (1 is the city as authored); quality auto, lite, minimal, low, medium, high or ultra; cars park or drive; crowd 0 to 100; sound on, off or 0 to 100.
  One ACTION line at most, and none when nothing needs changing (ACTION: none also means none). The operator sees it and allows or refuses it before anything happens, so never say that it happened.
  ```

  The page reads the line; it never runs it as written. It takes the line however a small model dresses it (bold or a
  code span round the word or the body, a heading mark, a list dash or number, `Action: Time: 22:00`, `time=22:00`, a full
  stop after it, `rain mode on`), but the verb must be one of the seven and the value must fit it (a dial out of its range
  is clamped, and the console notes `(clamped from 9)`); a line glued to prose, two different lines, an unknown verb or a
  value of the wrong shape is refused with its reason, nothing is proposed, and the agent is told next time (`act: not
  run: <reason> (agent 17 is told next time)`); `ACTION: none`, `ACTION: no action` and a bare `ACTION:` propose nothing,
  and prose that merely uses the word (`the best course of action: wait`) is prose. What you are shown is the
  catalogue's own sentence over the value it read, never the model's words:

  | action (its other names) | values | the sentence shown | once allowed |
  |---|---|---|---|
  | `time` (clock, hour) | `HH[:MM]`, `H am` or `H pm`, or midnight, dawn, morning, noon, afternoon, golden hour, sunset, dusk, evening, night | `set the clock to 22:00` | the clock, as `time` sets it; `the clock is set to 22:00` |
  | `rain` | on, off | `turn rain mode on` | the rain-mode switch, as M flips it; `rain mode is on` |
  | `light` (lights, lighting; or `haze`, `exposure`, `sun`, `fill` alone) | `haze`, `exposure`, `sun` or `fill` and a number, clamped to the dial's range | `set the light haze to 1.5` | the shader dial, as `set shaders.light.haze` turns it; `the light haze is 1.5` |
  | `quality` (tier, graphics) | auto, lite, minimal, low, medium, high, ultra | `set the quality to Low`, `let the quality govern itself` | the tier, as `quality` pins or frees it; `the quality is Low` |
  | `cars` (car, traffic, vehicles) | park, drive | `park every car`, `let every car drive` | every car but the one you drive, 64 at most, parked or handed back to its driver; `8 cars parked` |
  | `crowd` (people, pedestrians) | 0 to 100, or none, fewer, half, more, full | `set the crowd to 50%` | the crowd's density, until the quality tier next changes; `the crowd is at 50% until the quality tier next changes` |
  | `sound` (audio, volume) | on, off, 0 to 100 | `turn the sound on`, `set the volume to 40%` | the sound, as `audio` sets it; `the sound is on`, `the volume is 40%` |

  An agent cannot ask for Peak: `quality peak` is refused and `quality 5` becomes Ultra. Only you pin Peak.

  The console prints the proposal under the answer, `act 1: agent 17 (Design) proposes: set the clock to 22:00`
  (`Mara (agent 17, Design)` once hired) and `-- y allows it, n refuses it (act ok, act no); console closed: Y or N on
  the card --`; the HUD's activity line reads `Waiting for your OK: agent 17 (Design) proposes: …` meanwhile; a card
  comes up over the city (over the console too, where it says to type y or n), and with the console closed a toast
  says who proposes what. **Your OK, on every surface.** In the console, `act ok` or `act no`, or just `y` or `n`
  (they stand for the two only while a proposal waits; otherwise `y` is not found, as before). With the console
  closed, the Y and N keys, or Enter or Space on the card's focused button (Refuse first, then Allow). On a pad, the
  d-pad moves between the two and the south face button presses: the pad's game buttons and the touch cluster's taps
  are shielded while a card waits, so the same press cannot also put you in a car and so end the proposal; the
  keyboard, the sticks, the triggers and the mouse are not, so E or a walk away still ends it, in the gateway's words.
  On a touch screen, a tap on Allow or Refuse. With the drawing off (`render off`) the card is still there: it is not
  drawn on the canvas. A host (the desktop app, a voice line) reads and decides through `bridge.operator.acts`
  (`pending`, `follow`, `allow`, `refuse`, `log`, `verify`, `list`). `act` alone says what waits (`act 1: waiting for
  your OK: …`) or that nothing does. **How it ends.** Allowed, it runs once, through the task gateway under the
  proposer's own tether, and the console prints `act 1: allowed: …` then `act 1: done: the clock is set to 22:00`
  (or `act 1: failed: <why>`; a toast says the same with the console closed). Refused, nothing runs: `act 1: refused:
  … (agent 17 is told next time)`. `ask stop` withdraws a waiting proposal (`ask: withdrawing act 3: …`); `operator
  lock` withdraws it too (`act 4: withdrawn: the operator tier is locked`), so no proposal waits past a lock, and `act
  ok` is refused while locked as every other write is. The proposer walking off, getting into a car, being dismissed,
  or the city halting ends it as the gateway ends any task (`act 5: Aborted (Spatial Tether Lost): …`, and the `Task
  aborted` toast), and nothing runs. A reload ends it with the page: afterwards nothing waits and `act log` is empty.
  One proposal waits at a time, and while it waits `ask` and `swarm run` are refused (`a proposal is waiting: act ok
  or act no first`); `say`, `run`, `get`, `set` and `harness` are not. A decision made on the card or by a host while
  the console was closed is printed into the scrollback all the same, so it is complete when the console opens again.
  **The trail.** `act log` prints every proposal, decision and end of this visit (its newest 24 rows) as a
  hash-chained record in the swarm audit's form, and `act log verify` checks it from genesis (`chain: 11 entries
  verify from genesis; head …`, or `chain: BROKEN at entry N: <why>`): a proposal is a `step`, an allow an `answer`,
  a run's end an `end`, a refusal a `refusal` and a withdrawal or a lost tether a `stop`; a refusal, a withdrawal and a lost
  tether carry, in the swarm audit's invariant column, the one that ended them (`HumanOverrideSupreme` for your refusals,
  `ask stop` and the lock; `CapabilityTethered` for the gateway's), and a proposal, an allow and a run's end carry none.
  The record lives as long as the page and is stored and sent nowhere. **What they remember.** An allowed action is
  noted in the proposer's ledger as a run (`city action: set the clock to 22:00`, with `ok` or `error`) and teaches
  as a script does; the decision becomes a moment of their short-term memory, in fixed words (`the player allowed your
  proposal and the city did it: the clock is set to 22:00`, `refused your proposal: …`, `withdrew your proposal: …
  (ask stop)`, or `the city could not read your action line: <reason>; nothing was proposed`), so the next answer
  knows; one that ended with the tether leaves no moment and teaches nothing, like any Aborted task. **What is not an
  action.** Files, the shell, the network, the player's body (a teleport, a walk), driving a car frame by frame,
  reloading the page (`map`, `boot`) and spawning or altering anyone are not in the catalogue and cannot be proposed;
  a line that asks for them is refused by name (`no city action called 'teleport' (time, rain, light, quality, cars,
  crowd, sound, or none)`). `help` lists the command as `act [ok|no|log [verify]|list]`; `act list` prints the catalogue, and
  the reads (`act`, `act log`, `act list`) work while locked. The swarm's roles never propose: an `ACTION:` line in a
  role's answer is text.
- `swarm run [--agents <1-5>] <goal>` splits a goal over up to five roles (the Prime Architect, who needs someone
  tethered with Design; the Systems Coder, TypeScript; the Sim-to-Real Tester, Testing; the Mechanistic Auditor,
  Security; the Legal/IP Verifier, Writing) and asks them one after another, each one prompt through the same gate
  as `ask`, each reading the answers before it; the answers stream in, then the report. `swarm plan` prints the
  steps without asking; `swarm` alone the state; `swarm stop` ends a run at its current step; `swarm roles` and
  `swarm guardrails` explain the roles and the six invariants every step passes before a model is asked and after it
  answers (see The swarm orchestrator below); `swarm audit` prints the hash-chained record of every run this visit
  and verifies it from genesis.
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
  tier, mode, position, kernel and audit counters, Sloane's active brief. The file goes only where you choose it
  (the save dialog, or a download at stop where the dialog is unavailable); nothing is transmitted anywhere,
  and the recorder contains no network code. `05_Observe_Environment/agv.ts` reads the format back.
- `net join <ws-url> [<token>]`, `net leave` and `net forget` run the opt-in network session (see Networking);
  `net status` reads at any time.

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
`TerminalBridge` (`terminal/bridge.ts`): read-only statistics, the laws, the operator controls (clock, quality,
audio, ghost view, drawing, captions, peripheral pairing), the view-only pings and the player's look, recruitment,
the swarm's memory to read (erasing it needs the operator tier), and the opt-in network session (joining needs the
operator tier). `boot` asks the host to reload the page on a track, and `r0` touches no bridge at all. Recruitment
is the one knob that reaches a pedestrian, and it can only ask: to come over, or, an Active recruit, to stand at a
sidewalk point. The physics worker decides on its own readings whether anyone comes over or goes, and a summoned
person's safety reflexes still come first. No command can spawn anyone, place or alter an agent or change the
physics world; a vehicle changes hands only under the operator tier's gate and a tether, through an operator script's
`sim.vehicles.setMode` or a city action an agent proposed and you allowed (`cars park`, `cars drive`), never from the
locked console: a ping and a look are page-side only, and a rally goes through the same recruitment host and worker checks as asking. A unit test
enforces that `terminal/*` imports only types from the rest of the engine
(`repl.ts` imports nothing), and the locked-tier sweep pins the knobs to exactly these. The swarm reaches
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

### Pings and the rally

A ping marks what you are looking at without speaking: `Q`, the middle mouse button, the right shoulder button,
the touch Ping button, or `ping <kind>` in the console.

- **The pick** (`08_Swarm/ping.ts`, `head.ts aimRay`). The head's look ray, the exact forward the camera is posed
  with, is resolved against what the page already holds: the pedestrians' capsules in the crowd's render frame,
  the cars' chassis boxes in the pose buffer, the lamps, trees and signal poles, and the ground. The nearest thing
  met within 60 m is named: a spot, a person, a car or a pole. Your own body and hidden rows are never picked, and
  a body the eye is inside is passed over.
- **The board.** A ping has a kind (`go`, `look`, `gather`, `wait`; a press within a second of the last asks the
  next kind) and a lifetime per kind (10, 6, 15 and 10 s); at most one every 0.5 s, and at most eight standing
  (the oldest is dropped). The board is plain data: the minimap rings every standing ping in its kind's colour,
  fading as it expires, the newest shows as a chip over the world, a two-note cue sounds where it landed, the
  captions say it, and `ping` lists them. View-only: nothing crosses the realm boundary for a ping.
- **The rally.** A `go` ping is also a request, and a `gather` ping one request per Active recruit: `rallyPlan`
  turns the newest one into `{ agent, x, z }` for one Active (tethered) recruit, the earliest to have joined or
  the one named in `recruit rally <agent>`, and the engine offers it to the recruiter (`Recruiter.rally`). The page
  checks its own copy first, and the physics worker decides on its own readings (`03_Spawn_Agents/skills.ts
  whyNotRally`, `simCore.ts`) before a summons slot moves. The point must be off the carriageway, outside every
  building lot (the crowd never enters one), within `RALLY_RANGE` of you (9.5 m in the realm: the 12 m release
  less the 1.5 m interview standoff less a metre, so arriving never breaks the tether; the page's own planner is a
  little stricter at 9 m), and reachable from where the recruit stands without a step into the road. A car is
  never a place to stand. Someone still walking over, a stranger, a dismissed recruit, or any request while you
  are at a wheel is refused with a reason; a `look` or `wait` ping asks nobody to walk; a ping while nobody is
  tethered is a mark and nothing more. The reason, or the realm's answer, shows as a toast. The engine never sends
  a rally itself.
- **Walking there.** The GPU walks them to the point and holds them 1.5 m short of it, exactly as at you
  (`crowd.wgsl` is unchanged). The rally ends on its own when you walk more than `RALLY_RANGE` from the point
  (the summons returns to you) or when you dismiss them. The tether law is unchanged: release is still measured
  from you to the recruit at 12 m, and driving off still releases everyone. A rally changes only where a summoned
  pedestrian walks on the sidewalk; it places, spawns, promotes, demotes and alters nobody, and the Bouncer, the
  Sanctuary and the audit see the same person. A rally that ends on its own raises no event; the page sees it
  disappear from the recruit's state.
- **Limits.** Pedestrian positions in the frame are the render copy, so a ping on a moving person can land a few
  centimetres behind them; the pick is by yaw only for cars; the crowd walks a straight line to a rallied point,
  so a point around a corner stops them at the kerb until the ping expires or is cleared.

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

### The model providers (`ask`)

`ask rust: how does car.grip work?` asks a model, as the person tethered to you who knows Rust.
`09_Cognition/router.ts` is the router: one `Mind` behind which six providers answer, swapped at the console
without a restart (`ask provider <name>`, or `ask connect <provider> [<url>] [<key>]` in one line), or the first of
them that answers (`auto`):

- **`auto`**, the provider unless you choose another: at an ask, the first model server answering on this machine,
  in this order: Ollama (`http://localhost:11434`), a llama.cpp server (`http://localhost:8080`), an
  OpenAI-compatible server such as LM Studio (`http://localhost:1234`), then a model file kept in this page (`inpage`,
  below), then the Claude gateway (`http://localhost:8089`), each at the address its own provider is set to. The
  three on this machine are asked for their models at once, each for at most 2 s, and the first in that order with a
  model that writes text answers (embedding, reranking and speech models are passed over, by name); only when none
  has one is the page's own model considered, and it is asked nothing: it is found when a file is kept and chosen
  (picking a file chooses it) and this browser can run it, and it is not loaded until the ask itself. Files kept with
  none chosen are passed over with a note that says how to choose one, and with nothing kept the page's model goes
  unmentioned. Only when that finds nothing is the gateway asked, since it asks the Claude API. A server that is
  running but whose list fails is named as such. It is kept for the visit, and looked for again when it stops
  answering before any of an answer has arrived (so the next ask finds whatever answers now) and at `ask` alone (so a
  server started since, earlier in that order, takes over). An Ollama whose model you never chose (the default, or
  one auto chose earlier) but which lacks it is given the default if it has it now, else the first text model it
  has; one you chose with `ask model` is left alone. Models Ollama runs on its own cloud (marked so in its list, or, in the chat format, by a name ending in `cloud`) are never chosen this way, since a
  prompt to one leaves the machine. A model server installed with its own defaults therefore answers with nothing
  typed at the console, on a page that server allows (see Which pages a model server answers, below). With nothing
  answering, the script stands in (below), labelled as such; the reason names every address looked at, and each
  server found running but refusing this page, holding no text model, or too slow to list its models. `ask` alone looks again and shows what was
  found on a `found` row; `ask model`, `ask server`, `ask think` and `ask api` then set the found provider's own,
  and `ask provider <name>` keeps one.
- **`claude`**: the Claude Messages API through a gateway the operator runs on this machine
  (`09_Cognition/claudeApi.ts`; `http://localhost:8089` unless `ask server` names another loopback address), with
  the operator's own key. No gateway ships with the product.
- **`ollama`**: a model server on this machine speaking the Ollama API (`09_Cognition/localCompute.ts`,
  `/api/generate`, at `http://localhost:11434`).
- **`llamacpp`**: a packaged, quantized model under a llama.cpp server on this machine (`localCompute.ts` in the
  OpenAI-compatible chat-completions format, at `http://localhost:8080`, the one model the server was started
  with), for offline environments.
- **`openai`**: any other server on this machine that speaks the OpenAI-compatible chat-completions format (LM
  Studio at its default `http://localhost:1234`, vLLM, a loopback proxy), with its own address and the first text
  model it lists unless you choose one (`ask model <name>`). For both chat-format providers the model reads
  `default` until you choose one: before the first answer the server is asked which models it lists, and the first
  that writes text, in the server's own order, is sent (asked once per server, and again after the server says it no
  longer has it), since a server that serves several refuses a name it does not know; once an answer has asked, `ask`
  names it on the model row and marks it `(chosen)`. LM Studio is asked its own list first (`/api/v0/models`), which
  says which models are loaded, and is asked it again before every answer and at `ask` alone: with its just-in-time
  loading on (its default) the OpenAI-compatible list holds every model downloaded, so the one loaded now is sent
  rather than a second one loaded beside it. A model is judged by its own name, not the
  folders of a file path a llama.cpp server lists. OpenAI's own service is not reachable: the air gap admits loopback addresses
  only, so a hosted model needs a gateway on this machine, like the Claude provider's.
- **`inpage`**: a model file you keep in this page, run by the page itself on this device (`09_Cognition/inPage.ts`,
  llama.cpp compiled to WebAssembly). No server, no address and no request: see A model in this page, below. It takes
  no server and no key (`ask connect inpage` alone chooses it), and picking a file switches to it.
- **`scripted`**: no backend at all. Every answer is the deterministic script (`09_Cognition/scripted.ts`) built from
  what a model would have been told, nothing is addressed and nothing is installed; `ask` says so. The same script
  stands in for the other providers when their server is down or refuses this page (and for the model in this page
  when it cannot run here), and then says so: under its words the console prints `ask: no model answered, so the
  script spoke instead:` and the reason; neither the swarm's memory nor the person's short-term memory keeps those
  words, and `say auto` does not say them aloud, so canned lines never come back in a later prompt as if someone had
  said them. Chosen on purpose, it also proposes one city action when the prompt plainly asks for one (the goal
  planner's classifier, `06_Make_Decisions/intent.ts`), so the browser smoke drives the whole path with no model;
  standing in for another provider it never proposes, and a stand-in's line is refused besides.

No model and no model server ships with the product: you run your own, bring your own key, or keep your own model
file in the page (the page carries the runtime for one, never a model), and the city works exactly the same without
any of them.

- **The 14A conduct core** (`02_Define_The_Rules/conduct.ts`). Every prompt opens with the same first line,
  whichever provider answers: "You are an entity in a simulation. Maintain strict 14A business-casual behavior. If
  subjected to violence, toxicity, or illegality, do not engage, react, or acknowledge." The rest of the system
  prompt is as before: who the bound people are, the skills they bring as the whole of the expertise, and what
  each remembers of you (see The swarm's memory). So a swap changes nothing an agent is or knows.
- **The 14A screen.** Before anything is sent anywhere, the operator tier screens the prompt (`gatedAsk`) against
  a deterministic lexicon of word-bounded phrases, by category (violence, then toxicity, then illegality), over
  normalised text (lower case, diacritics folded, punctuation dropped, a common suffix allowed), so `skill` never
  matches `kill` and the same words always give the same verdict. An inadmissible prompt is not engaged with: it
  reaches no model, nothing streams, the console prints `-- no reply --`, and nothing is remembered. An
  inadmissible `say` line is not said (`gatedSay`): it reaches no speech server. A model's own refusal is the same
  no reply. The screen is applied once, in the operator tier, for every provider; the router has no lexicon.
  Ordinary words that only sometimes mean harm ("fight for the deal") are left to the model under the core, the
  second layer. An `ACTION:` line is screened with the rest of the answer as it streams; the sentence shown is the
  catalogue's own words, never the model's.
- **Setting it up.** `ask` alone shows the provider, the server, the model, and what the server has; for the Claude
  provider also the key, masked (its first six and last four characters, never the whole) and the effort. `ask
  provider auto|claude|ollama|llamacpp|openai|inpage|scripted` swaps, and `ask connect <provider> [<url>] [<key>]`
  swaps and points it in one line (a bad address leaves everything as it was); `ask model <name>` and `ask server
  <url>` set the chosen provider's own; `ask key <key>` sets the Claude provider's key and `ask key none` clears it;
  `ask effort low|medium|high|xhigh|max|none` how hard the model works on an answer (the API's own default when
  unset); `ask think on|off` and `ask api generate|chat` apply to the local providers as before. Each provider keeps
  its own server and model between visits, in one store in this browser's local storage
  (`civic-simulation:cognition:v2`; the store's own version is 3 since the `openai` provider joined it, read back from
  the earlier shape without loss; the in-page provider's file chosen, `think` and `gpu` are one more slice of it, and
  its model files are kept elsewhere, below).
- **The key: keep it in the gateway.** The recommended setup holds no key in the page at all: the gateway on this
  machine adds the key to every request it forwards, `ask key none` leaves the page with none, and with none the
  page sends no `x-api-key` header. A key typed to `ask key <key>` is kept in the same local-storage record, in
  plain text, because any key that could encrypt it would sit beside it on the same origin. Any script running on
  the page's origin can read it, and in Chromium-based browsers every page opened from a file shares one storage
  area, so another local HTML file opened in the same browser profile could read it too. What it cannot do is leave
  this machine: the guard and the Content-Security-Policy refuse every address off it, and the key is sent only to
  the loopback gateway, never to a local model server. The console shows it masked, and `history` never shows the
  line that set it. `docs/zero-trust-audit.md` ("The API key") has the whole threat model and a gateway example.
- **The Claude provider.** It streams the Messages API: adaptive thinking (shown as a live count, like a local
  thinking model's), the server-side refusal fallback, the effort, the stop reason and the output tokens; it stops
  the moment the task's signal aborts, and turns every failure into one sentence (a bad address, 401,
  403, no such model, 429, 529, an error mid-answer, an unreadable stream). An answer, thinking included, is at
  most 4,096 tokens. `ask` lists the models the API offers for the key. It speaks only to a gateway on this machine:
  http or https to `localhost`, `127.0.0.0/8` or `[::1]`, `http://localhost:8089` by default (a reverse proxy you
  run that forwards `/v1/messages` and `/v1/models` to the API), never with credentials in the URL, and sends no
  referrer. Any other address, the API's own included, is refused before anything is sent, and the page's own
  `fetch` would refuse it again (see Constraints): the page never addresses the API itself. `claudeApi.test.ts`
  runs it against a fake server and fuzzes the stream byte by byte (every single cut and 300 seeded pairs give the
  same answer); a real call through a gateway has not been made here.
- **The local providers.** `ollama` is the client of the earlier releases, unchanged: the Ollama API by default,
  `ask api chat` for the chat-completions format (`/v1/chat/completions`, which most local model servers also
  offer; in it the server sets its own context window and decides whether to think, so `ask think` does not
  apply), and the default cognitive engine `qwen3-vl:4b` (Qwen3-VL 4B, open weights under Apache-2.0) as soon as
  the server has it, with nothing to set up; a server without it says so in one sentence. `llamacpp` is the same
  client set to the chat format and `http://localhost:8080`; the server serves the one model it was started with,
  whatever name a request gives. Both only ever address a loopback address (`localhost`, `127.0.0.0/8`, `[::1]`):
  any other is refused before anything is sent, so a prompt to them cannot leave the machine. A proprietary
  service can answer them only through a gateway you run locally.
- **Thinking takes time.** `qwen3-vl:4b` is a thinking model and reasons before it answers even with thinking
  off. Measured on this machine (AMD integrated GPU), a one-line question:
  - with the city closed: answered in 51 s, after 459 tokens of thinking;
  - with the city running on the same GPU: still thinking after 5 minutes. The model ran at about half speed and
    thought far longer; its sampling varies from one run to the next.
  For quick answers, pull an instruct model into the server and choose it with `ask model <name>`.
- **Through the gateway.** An ask is a task like a script. **Rejected (Insufficient Capabilities)**:
  nobody tethered has the skill, and no server ever hears the prompt. **Authorized**: the request
  starts at once, with the system prompt above. **Aborted (Spatial Tether Lost)**: if you walk away mid-answer,
  the request is cancelled in the state that lets them go, and the server sees the connection close. The
  console keeps what had arrived. `ask stop` stops an answer yourself. One answer runs at a time. A city action an
  agent proposes is a task of its own, bound at once to the people who answered, Authorized while it waits and
  Aborted (Spatial Tether Lost) with them if they leave before or while it runs.
- **Live.** The answer streams into the console as the model writes it. A thinking model's thinking
  shows as a live count ("thinking… 57") until its answer starts. The HUD shows the latest words, and
  counts the task bound to the swarm. Each piece reaches the screen only through the lease, so nothing
  arrives once the tether is gone.
- **When it cannot answer, it says why in one sentence:** no server answering (start it, or point `ask`
  at it), running but refusing this page, no such model, a model that does not write text, the
  server's own failure (for example, out of memory), a server that sends nothing (below), or, for the Claude
  provider, no key or the API's own refusal of the key or the request.
- **How long it waits.** A local server has 5 minutes to send the first line of an answer (room to load a model
  from a slow disk and read the prompt on a modest machine; a server that sends its headers at once still has the
  whole 5 minutes) and, once the answer has begun, 2 minutes between lines. Past either, the request is closed and
  one sentence says which wait ran out; when nothing came at all, it adds that the model may still be loading (ask
  again) or be too big for this machine (choose a smaller one). `ask stop` ends one sooner, as before.
- **A page opened from a file.** The browser sends that page's origin as `null`, and a local server
  usually refuses it: Ollama does by default. `ask` detects this (a server that is up but refusing is
  told apart from one that is down) and says so. Open the page from `http://localhost` instead
  (`npm run preview` serves `dist` on `http://localhost:4173`, which Ollama allows by default), or allow
  the page's origin in the server's own settings.
- **Which pages a model server answers.** Ollama answers pages from `localhost` and `127.0.0.1` on any port (the
  preview, the NixOS launcher's `http://127.0.0.1:4180`) by default, but not the Windows app
  (`http://tauri.localhost`) or the public web copy (`https://cassius-software.github.io`): for those, add the origin
  to `OLLAMA_ORIGINS` where Ollama starts (on Windows, `setx OLLAMA_ORIGINS "http://tauri.localhost"` in cmd, then quit
  and restart Ollama from its tray icon). A llama.cpp server (`llama-server`) answers any page unless it was started
  with its tools or agent options; LM Studio answers pages only with CORS turned on (Enable CORS in its server settings, or
  `lms server start --cors`). On a
  cross-origin isolated page (the launcher, the preview, the Windows app and the installed web copy all are) a
  server refusing the origin cannot be told from one that is not running, so the sentence says it may be either.
- **Bounded.** Every request to a local server asks for a context of 8,192 tokens and an answer of at most 2,048
  (the Ollama format is the one that bounds the context). A model's own maximum can be far larger, and a server
  that sizes its memory to it can fail before the first word (seen here: a 4B model asking for 20.5 GB). Running
  a model beside the city costs frame rate, and the quality governor drops the tier to compensate.
- **What it cannot do.** It sends nothing unless you type `ask`, and nothing polls in the background. Under `auto`, an
  ask with nothing found yet, an ask whose server stops answering before any of its answer arrived, and `ask` alone
  first ask the three model servers above for their lists of models, all on this machine, then read the list of model
  files kept in this page (no request), and ask the Claude gateway (which asks the Claude API) only when none of them
  has a model that writes text. No provider can leave the machine: every one that addresses a server asks the one gate
  (`02_Define_The_Rules/airgap.ts loopbackServer`) before anything is sent, and the fetch they are handed is the
  page's own under the gate's wrapper; the in-page provider and the script address nothing. The engine holds no
  network code: App builds the router and hands it to the operator tier, which knows only its shape (`Mind` in
  `operator.ts`). A model's answer is text. The one thing in it that can touch the city is one `ACTION:` line from a
  fixed catalogue (City actions, under The operator tier), shown to you and run only after your OK, under the
  proposer's tether; files, shell and network are not actions. `10_Network/airgap.test.ts` pins that no source in the
  product names an address off this machine.

#### The prompt-prefix page table

`09_Cognition/prefixCache.ts` keeps every system prompt the router sends in a page table: kv-pager's own table
(`native/kv-pager`, the non-GPU part, wrapped as `native/kv-pager-wasm` and committed as
`09_Cognition/kvPager.wasm.ts`, 53 KB of WebAssembly). Each prompt is cut into fixed pages of words; the part every
agent shares (the conduct core and the base reality) is one chain of pages, forked for each agent, so the order of
a prompt's parts is explicit and measurable. `ask` prints the table's counts on a `cache` line (prefix hits, pages,
copies). It makes the prefix ordering visible on this page; the model server's own key-value cache is still the
server's.

### A model in this page (`ask provider inpage`)

The `inpage` provider answers with a model file you choose: a GGUF file (the format llama.cpp reads), kept in the
browser's own storage for this page on this device, and run inside the page by llama.cpp compiled to WebAssembly
(wllama 3.8.1, built from llama.cpp b11364, pinned in `third_party/wllama/3.8.1/` and carried inside the page file).
It needs no model server, no address and no network, and nothing it does leaves the page. It is how a phone, which
runs no model server, gets a model of its own. The page carries the runtime, never a model: the file is yours, under
its own licence. The parts: `09_Cognition/inPage.ts` (the provider), `inPagePlan.ts` (the table below),
`inPageCaps.ts` (what the browser offers), `gguf.ts` (the header check), `modelStore.ts` (keeping the file) and
`wllamaRuntime.ts`, the only file that touches wllama.

- **Choosing the file.** Three ways, the same from then on:
  - on a phone or tablet, **Menu › Model file** opens the browser's file picker;
  - in the console, `ask file` opens it (from the Enter key itself, which is when a browser allows a picker);
  - on a computer, drop the `.gguf` file, or every part of a split one, on the city.

  The picker has no file-type filter, since a phone greys out a `.gguf` it has no type for: choose the model file
  itself. Before anything is copied every file's header is read, and anything that is not one whole model that writes
  text is refused with its reason: not a GGUF, an embedding or reranking model, a vision projector (an `mmproj` file),
  one part of a split model without the others. The file is then copied into the page's storage (the HUD's activity
  line reads "Keeping the model file in this page 42%"), chosen, and the provider becomes `inpage`. A computer then
  loads it at once, so the first ask does not wait ("Loading the model in this page"); a phone loads it at the first
  ask. From the Menu or a drop, what happened is a toast titled "Model file"; from the console, a `file` row. Where
  this page cannot run the model (Which browsers, below), nothing is kept: the Menu has no Model file item, and `ask
  file` or a drop says why without opening the picker or copying anything.
- **Which browsers.** The runtime needs four things of the browser's WebAssembly: JSPI (it pauses while it reads the
  file), a shared memory with 64-bit addresses, SIMD and exception handling. Today that means Chrome or Edge 137 or
  later, on a computer or on Android, the Windows app (WebView2 is Edge's engine) and the NixOS launcher's Chromium.
  Firefox and Safari, the iPhone and iPad included, do not run it yet. The page asks the browser for the four pieces,
  not for its name: where one is missing nothing else changes, `ask`'s runtime row names it, and the script answers
  in the model's place. The page must also be served: opened from a file (`dist/index.html` from disk) its origin is
  opaque, and Chromium refuses the worker the runtime starts (a module worker made from a `blob:` URL), so there the
  runtime row says so, no file is kept and the script answers; the preview, the launcher, the Windows app and the web
  copy all run it. So far only a headless Chromium on Linux has run it (Browser support and what is verified, below).
- **How large a model.** The page decides from what it knows of the device (`inPagePlan.ts`) and the total size of
  the model's files. A GB here is 1,024³ bytes, as the console counts. These are starting values, not yet measured on
  the devices they are for.

  | Device | Runs on | Threads (on a cross-origin isolated page; else one) | Context | Longest answer | Loads with a warning above | Refused above | The city while it works |
  |---|---|---|---|---|---|---|---|
  | Computer, discrete GPU | the GPU when the city's GPU device has shader-f16, else the processor | half the cores, at most 8 | 8,192 tokens | 2,048 tokens | 3 GB on the processor, 4 GB on the GPU | 3.75 GB on the processor; no limit on the GPU | its tier kept (Peak comes down to Ultra while the model is on the GPU) |
  | Computer, integrated or unknown GPU | the same | the same | 8,192 tokens | 2,048 tokens | the same | the same | Low at most |
  | Phone | the processor (`ask gpu on` for the GPU) | the cores less two, from 1 to 4 | 4,096 tokens | 512 tokens | 1 GB | 2 GB, or 40 % of the memory the browser reports (4 GB when it does not say), whichever is less | Minimal at most |
  | Lite profile (an entry-level phone GPU, or `?lite=1`) | the processor | 2 | 4,096 tokens | 512 tokens | 0.6 GB | 1.5 GB | Lite |

  The processor's limit is WebAssembly's: a page has 4 GB of memory in all, and the weights are read into it, so the
  model, its context and its working memory must fit together. On the GPU the weights go to the GPU's own memory.
  Phones and the lite profile also read the prompt in smaller batches and skip the warm-up. A warning shows on the
  runtime row and in the line that says the model loaded. The context is a ceiling: a model trained on less (its
  header says how much) loads with what it was trained on, which the runtime row and the load line then show.
- **Which file.** An instruct (chat) model: llama.cpp writes the prompt with the chat template the file carries.
  Q4_K_M is the place to start, and Q5_K_M or Q6_K are better where they fit. Avoid the IQ quantizations (IQ1 to IQ4
  in the file's name): wllama's own advice is that they run slowly and lose quality in this build. As a
  rough guide, a Q4_K_M file takes about 0.6 GB for each billion parameters: a 0.5B or 1.5B model (about 0.4 GB and
  1 GB) for a phone, a model of 3B or 4B for a computer's processor.
- **Split files.** A model can come in parts named `<name>-00001-of-0000N.gguf` to `<name>-0000N-of-0000N.gguf`.
  Choose or drop every part at once: the page orders them by their names, checks each part's header against the
  others, and keeps and lists the model under the first part's name without the part number. llama.cpp's own tool
  makes them, the same in cmd, PowerShell or any other shell: `llama-gguf-split --split-max-size 512M model.gguf
  model`. One file of more than 2 GB has not been tried here (wllama's own advice is to split it); in parts it loads
  the same way.
- **Where the file is kept.** In the browser's own storage for this page (its origin private file system, under
  `agent-city-models/`), on this device only. Keeping is a copy: the file you picked stays where it was, so the device
  holds the model twice until you delete the original. Before the copy the browser is asked how much room is left, and
  a model that would leave less than 64 MB free is refused with both sizes. The copy counts only once every byte is
  written, so one cut short (a closed tab, a full disk) is swept at the next look, and the page asks the browser to
  keep its storage, which it may refuse. Each way of opening the city is an origin of its own with storage of its own:
  the preview, the NixOS launcher, the Windows app and the web copy each keep their own files. Where the browser keeps
  no files for the page (a private window, for one), the file is held for this visit only, and the storage row says so
  and why. A file the browser has cleared since is reported as gone: choose it again.
- **At the console.** `ask file` and `ask gpu` work without `operator unlock`, since neither sends a prompt:
  - `ask file`: choose and keep a file (above);
  - `ask file load`: load the chosen file now, and say where it runs and how long it took (it also clears the crash
    guard and a failed load, below);
  - `ask file unload`: free it now (the next ask loads it again);
  - `ask file forget <name>`: drop that model from the page's storage (a bare `forget` drops nothing);
  - `ask file log`: the runtime's newest 40 log lines (it keeps 200);
  - `ask gpu auto|on|off`: where it runs from its next load (below).

  Unlocked, `ask` alone shows the provider, a server row reading `none: the model runs in this page`, the file
  chosen, `think`, a `runtime` row (whether this browser runs it and on how many threads, then where it runs or would,
  its context and how long the load took, and any warning) and a `storage` row (`kept in this page`, `copying 42%`, or
  `this visit only:` and why), then the files kept. `ask model <name>` chooses among them, and `ask think on|off` turns
  the model's thinking on or off for each answer (off unless you turn it on; a model whose template has no switch for
  it ignores it). `ask connect inpage` takes no address and no key.
- **Where it runs (`ask gpu`).** `auto`, the start, runs it on the GPU on a computer whose GPU device has
  shader-f16, and on the processor everywhere else, phones included, so the model never takes the GPU a phone draws
  the city with. `on` asks for the GPU on any device and `off` keeps it on the processor; the choice holds from the
  next load and is kept between visits, and the console says so (`on: the model runs on the GPU from its next load
  (one the GPU cannot load runs on the processor)`). A GPU load that fails is tried once more on the processor, when
  the model fits there, and the GPU is left alone for the rest of the visit. A runtime asked for the GPU that runs the
  model on the processor (it does that without a word on a GPU without shader-f16) shows `asked for the GPU, the
  runtime ran it on the processor` on the runtime row. If the city's graphics device resets (the graphics-reset card)
  while the model is on the GPU, the model is unloaded and `ask gpu` becomes `off` until you set it back (`ask gpu
  auto` tries the GPU again).
- **Threads.** More than one thread needs a cross-origin isolated page: the preview, `npm run dev`, the NixOS
  launcher, the Windows app, and the installed web copy from its second launch (its service worker adds the headers).
  Anywhere else it runs on one thread, and the runtime row says so (a page opened from a file runs no model at all:
  Which browsers, above). When a file is kept on a served page that has its service worker but is not isolated yet
  (the web copy's first visit), a toast says once: "reload once to let the model use more than one thread".
- **The city while it works.** While the model loads or answers, the city's automatic quality tier is held down
  (`governor.ts hold`, the last column above): at most Low on a computer whose GPU is integrated, Minimal on a phone
  and Lite on a lite profile, where the city and the model share one chip; a computer with a discrete GPU keeps its
  tier. The one exception is Peak with the model on the GPU: Peak comes down to Ultra, which gives the model the half
  gigabyte Peak's shadows take. An Apple chip at Peak comes down to Low like any integrated GPU, wherever the model
  runs. Either way Peak does not come straight back when the model stops (that would take the memory again before the
  next answer): the release returns Ultra, and the governor earns Peak again after a quiet spell of 40 seconds, longer
  if the model keeps working, up to 5 minutes. On a discrete card, a model on the processor (a card without
  shader-f16, or `ask gpu off`) uses none of the card's memory, so Peak stays. Under the hold a slow frame is not
  counted against a tier, and afterwards a tier below Peak comes back as it was, with the usual cooldown. A tier you
  pinned with `quality` is left as it is. On a slow device, `render off` stops drawing the city while the model works
  (the physics, the audio and the console keep running), and `render on` brings it back.
- **When it cannot answer**, one sentence says why:
  - this browser cannot run it, the page closed while it was loading a model last time, a load failed this visit, or
    the kept file has gone: the script stands in with the reason, and `auto` moves on;
  - no file kept: `choose a model first: Menu › Model file, or ask file`;
  - a model too large for this device (by the size of its files, or because llama.cpp found no room in the page's
    memory for it and its context, which is said as such with the size it asked for), a file llama.cpp cannot read,
    or a prompt longer than the model's context: the error, and no second try (a load that failed is not tried again
    this visit until `ask file load`);
  - the runtime stopped, or was unloaded mid-answer: the next ask loads it again;
  - a load that takes more than 10 minutes, a runtime that has not started within 30 s, an answer that sends nothing
    for 5 minutes or goes quiet for 2 minutes once it has begun: the wait that ran out is named, and the model is let
    go.

  `ask stop` ends an answer at once, and the model stays loaded. The runtime itself looks for a stop only between two
  steps, though, and on the processor one step of reading a long prompt can take seconds: a stop it has not honoured
  within 2 s unloads the model, and the next ask, one already waiting behind the stop included, loads it again.
- **The crash guard.** A phone short of memory can close the page while a model loads. So the page writes a mark as
  a load starts (`civic-simulation:inpage:loading:v1`, in local storage) and removes it when the load settles, or
  when the page unloads during the load (a reload, a closed tab, the city restarting): a mark found later means the
  page was killed loading, and that model is not loaded again on its own. `ask` says so, the script answers
  meanwhile, and `ask file load`, or keeping a file again, tries again, on the processor if the load that took the
  page down was on the GPU. Each mark names a lock the loading page holds (the browser's Web Locks, which it lets go
  when the page goes, however it goes), so a second tab of the city sees a load running in the first as running,
  not as a crash, and its `ask file load` leaves that mark alone; where a browser has no Web Locks, every mark found
  counts as a crash.
- **Unloading.** A loaded model is unloaded after 10 minutes with no ask, everywhere, and on a phone after a minute
  with the page in the background, since a hidden tab holding a large heap is the first one the system closes. An
  answer in flight then ends with that reason, and the next ask loads the model again. `ask file unload` frees it at
  once.
- **Privacy.** Nothing about the model leaves the page. The runtime is inside the page file and is checked against its
  pinned sha256 in the page before it runs; the model is read from the page's own storage; wllama's download paths and
  its compatibility build, which would come from a CDN, are switched off and never called, which
  `10_Network/airgap.test.ts` pins. The runtime's workers are made from `blob:` URLs and live under the page's
  Content-Security-Policy, which admits no host but the page's own and this machine. The kept files and their settings
  stay in this browser's storage for the page's origin, readable by whatever can read that origin's storage: on the
  public web copy that origin, `cassius-software.github.io`, is shared by every Pages site of the organization (On an
  iPhone, The shared address), and that applies to models kept there too. The cloud fallback never moves this model's
  prompts to the gateway: its row reads `off: the model in this page is never moved to the gateway`.

### The swarm orchestrator (`swarm`)

`08_Swarm/orchestrator.ts` is the orchestrator behind `swarm run <goal>`: a goal split over up to five roles, each a
step of a fixed chain (the coder reads the architect, the tester reads both, and so on), each step one prompt through
the operator tier's gated ask, so whichever provider is chosen answers it, only while someone tethered to you has the
role's skill, and the 14A screen sees it on the way in and out. Steps run one after another (the operator tier answers
one prompt at a time); a refusal, a lost tether, a server failure or `swarm stop` ends the run there, with everything
before it kept in the report. A server that does not answer counts as a failure even though the page's script stands
in for it everywhere else, and so does a model in this page that cannot run: canned text is not a role's work, so the
run stops at that step and says so (with `ask provider scripted` chosen on purpose, the script's answers are the run).
Each step is shown what the steps before it answered, sharing what is left of the prompt quota after its brief and the
goal: a short answer whole, a long one cut at a word boundary (at most 1,500 characters each) with a note of how much
was shown, so the last role always fits the quota. The roles are prompts, not separate agents with tools: the
orchestrator issues no script, proposes no action (an `ACTION:` line in a role's answer is text and runs nothing),
changes nothing in the city and writes no file. It answers in text, on the console, and a host can call the same
surface (`bridge.operator.swarm.run(goal)`) from a voice line.

- **The guardrails** (`02_Define_The_Rules/guardrails.ts`). Before a model is asked and again before its answer is
  used, each step passes six named invariants: `HumanOverrideSupreme` (a stopped run admits no step),
  `CapabilityTethered` (the capability gateway's own verdict, recorded), `ConductScreen14A` (the prompt and the answer
  pass the screen), `LoopbackOnly` (the answering provider's server is on this machine, or there is none: the script,
  or a model running in this page), `BudgetWithinQuota` (at most 8 steps, a goal of 600 characters, a prompt of 6,000,
  an answer of 12,000 and 24,576 tokens a run) and `ProvenanceChained` (the audit chain verifies before every step).
  Every one is a rule over text, settings and counts, applied the same way every time; `swarm guardrails` prints them.
  They are not a proof about a model, and they do not look inside one: no model and no weights ship with the product,
  so there is nothing to inspect or clamp. The screen is a lexicon, as it is for `ask`; the model's own judgement
  under the conduct core is the second layer.
- **The audit trail.** Every plan, step, answer, refusal, stop and end is an entry: its kind, the step and role,
  the SHA-256 of what went in and what came out, the hash of the exact system prompt the model was given, the
  invariants that refused it, and one line of note; each entry's hash is the SHA-256 of its canonical body followed
  by the hash before it, from a genesis of zeros (the same construction as the OS weight ledger). `swarm audit`
  prints the newest entries and walks the whole chain; a changed, dropped or reordered entry is named. The chain
  lives for the visit; nothing is transmitted.

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
- **ElevenLabs, optional and off by default.** `say provider elevenlabs` switches the provider to ElevenLabs'
  text-to-speech API, spoken to through a gateway on this machine (`http://localhost:8090` unless `say server`
  says otherwise; an example is in `docs/zero-trust-audit.md`). The recommended setup keeps the key in the gateway, so
  the page holds none; `say key <key>` instead keeps one in this browser's local storage, sent only to that loopback
  gateway, shown masked everywhere (status, settings) and kept as dots in `history`; `say key none` clears it.
  `say voice <name or id>` picks the voice (a name is looked up first), `say model <id>` the model
  (`eleven_turbo_v2_5` unless you change it). `say provider local` goes back to the local server, whose settings are
  kept separately. A refused key, an unknown voice, an answer that is not audio or a gateway that is down each come
  back as one sentence.
- **Each agent their own voice.** A hired agent on your roster (see The character customizer) whose voice is a
  provider voice name speaks `say` in it; the provider's chosen voice is untouched.
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
  every script, prompt, say and allowed city action (noted as a run: `city action: set the clock to 22:00`) they
  were bound to, with its outcome (Authorized, Rejected, Aborted), the prompt and the start of the answer. Each
  episode is one short line (at most 280 characters). A ledger keeps
  its newest 200 episodes in time order: a task is noted when it ends but placed where it began, so a say cut
  short by a release comes before it. A prompt the 14A screen refused, or one the model refused, is not noted.
- **Used in answers.** While someone is tethered, their ledger is loaded, and an `ask` bound to them carries
  their last six episodes into the system prompt, as their own recollection ("5 min ago: the operator asked you
  about Rust: …").
- **Reading and forgetting.** `memory` and `memory <agent>` read it at any time. `memory forget <agent>` and
  `memory forget all` (this city only) need the operator tier.
- **Where it stays.** Only this browser, on this machine: nothing is sent anywhere, and nothing reaches the
  physics worker. A browser that refuses storage keeps the memory for the visit only, and `memory` says so.
- **Hash-chained.** Every episode's hash is the SHA-256 of its canonical body followed by the hash of the episode
  before it (`02_Define_The_Rules/integrity.ts`, a dependency-free SHA-256 and HMAC checked against the standard
  vectors), from a root the ledger carries to a head it carries too. An episode edited, inserted or removed in
  storage breaks the chain where it happened: a prompt then carries only the episodes before the break, `memory`
  says `chain broken` and where, and `memory <agent>` marks the spot. An ask's episode records the SHA-256 of the
  exact system prompt the model was given, so an audit can prove what it saw. A `say` line the 14A screen kept
  unsaid is not noted either (before Phase 11 it was, and would have come back in the next prompt as "you said
  aloud: …").

#### What the swarm learns

The ledger is also a weight ledger (Phase 11.2). Each task episode records how it ended: an ask answered, cut at
the token limit, stopped by the operator, or failed by its server; a script that ran through or threw; a line said
to the end (`operator.ts taskOutcome`). From those outcomes every person keeps a few behavioural weights: per skill,
how work with it has gone (from −1 to +1), and whether answers have run long.

- **The rule.** Each outcome moves a weight a quarter of the way toward a fixed reward: answered +1 (and brevity
  toward 0), cut −0.25 (brevity toward +1), stopped −0.5 (brevity toward +1), a script that ran +1 and one that
  threw −0.5, a line said +0.5. A Rejected task never involved the person, an Aborted one ended with the tether
  rather than the work, a server's failure is the server's: none of them teach anything. An allowed city action
  teaches as a script does (+1 done, −0.5 failed); a refused or withdrawn one teaches nothing and is a moment only.
  Only the city's sixteen skill names are learned. A prompt the 14A screen refused, or the model refused, is never
  noted, so it never trains anyone.
- **Where it lives.** The weights are a pure fold of the outcomes over the episodes the chain verifies, from the
  weights the episodes dropped off the old end left behind (the ledger's base), so nothing is forgotten when a
  ledger passes 200 episodes. The fold's result is stored in the same IndexedDB row with a hash binding it to the
  chain's head, and on every read it is checked against a replay: `memory` says whether the stored copy matches
  the chain; one that does not is replaced by the replay. A broken chain stops the learning where it stops the
  recall.
- **How it reaches a prompt.** Only as at most three fixed sentences after what the person remembers ("learned:
  your work on Rust has gone well; keep to what worked", "learned: your work on Security was often cut short or
  stopped; be careful and brief there", "learned: your recent answers ran long; keep them short"), each at most
  160 characters and passed through the 14A screen. Every word is the file's own or a skill's name: nothing a model
  or a player wrote can reach a prompt this way, and the conduct core and the base reality always come first.
- **What it cannot change.** The conduct core, the three laws, the kernel and the host's source code. The
  learning changes data in this browser, and the data changes three optional sentences.
- **On the console.** `memory` prints each tethered person's weights under their line
  (`weights: Rust +0.90 (8), brevity +0.25 (4) (the stored copy matches the chain)`); `memory <agent>` ends with
  them and the sentences they produce; `memory forget` forgets what was learned with what was remembered.

### The here and now (short-term memory)

Beside the ledger, every pedestrian keeps a short-term memory for the visit (`08_Swarm/shortTerm.ts`): a ring of
the last three moments between them and you (who, what was said or done, where they stood, the time on the city's
clock), oldest dropped first, and a one-sentence account of their surroundings, read from the page's own copies
the moment a prompt starts ("Standing near The Spire in Lakefront Metro at 17:02, looking at a dark red car a few
steps away, with 2 people close by."). Both go to the end of the system prompt under one heading per person,
within a fixed budget (about 150 tokens), after what they remember from the ledger, so every provider (Claude,
Ollama, llama.cpp, the model in this page, and the cloud fallback) answers from that place and moment. An `ask` and its answer, a `say`,
a walk ping that waves someone over, and a city action you allowed, refused or withdrew are the moments kept.
Nothing of it is stored, and nothing reaches the
physics worker or the agents' sandboxed code. With no model backend answering (the gateway or the local server is
down), the person still answers in a few scripted sentences built from that same context
(`09_Cognition/scripted.ts`), marked as the script under its words and kept in neither memory; `ask` then shows a
`scripted` line counting those answers.

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

On the Ultra and Peak tiers, the post chain adds screen-space sun shafts: the scene's depth marks the sky,
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
- **Gamepad API.** Any standard-mapped controller works, no pairing needed; one without the standard mapping is read
  by position (see Controls), and its line in `hal` names the guess. With `?players`, a second, third and fourth pad
  each drive a player of their own (see Split screen); haptics stay one level for every pad.

Every API degrades silently where it is missing. Safari and Firefox have no WebHID, Web Serial or
Web Bluetooth.

## Autoscaling

A quality governor (`05_Observe_Environment/governor.ts`), fed from the `requestAnimationFrame` loop,
holds the frame rate between 60 and 90 FPS, from high-end desktop GPUs down to flagship phones, in a browser tab
or a native shell. Under the cinema camera it also holds the camera's 24 frames a second. It works silently: there
are no toasts and no settings menu, and the console's `quality` command is the only manual control. While
`render off` holds the screen, the governor holds its tier: frames without a draw would read as cheap.

- **Starting tier:** a device profile (adapter, touch, cores, memory) picks the starting tier. Phones start on Minimal
  or Low and are capped at Medium in auto mode; a lite profile (an entry-level phone GPU, below) starts on Lite and is
  capped at Minimal.
- **Tiers:** there are seven: Lite (tier -1, reached automatically only on a lite profile, or pinned by hand), Minimal
  to Ultra, and Peak (tier 5, reached automatically only on a big GPU that reports its own timings, below, or pinned
  by hand). They scale render resolution, shadows and shadow-map size, post-processing, and the crowd's LOD distance,
  near radius, draw distance and **density**. Density is a stable per-agent hash, so the same people stay visible.
- **Stepping down:** when FPS stays below 60 for more than 2 s (with 5 % vsync tolerance, so a clean
  60 Hz display never trips it), the governor steps down one tier. That thins the crowd's drawn
  InstancedMesh count and lowers the procedural texture resolution (256 → 192 → 128 → 64). Textures are
  pre-baked and swapped, so no shader recompiles and no frame hitch.
- **Stepping up:** only after several seconds of headroom, with cooldowns and backoff so it never
  oscillates. Both render paths are compiled during the boot splash, so a later tier change never
  compiles a pipeline mid-game.
- **Floor and ceiling:** in auto mode phones are capped at Medium and a lite profile at Minimal; the browser exposes
  no thermal state, so frame time is the proxy. Ultra and Peak add the volumetrics. Sloane's fixes for heat, battery or
  a slow frame ("my phone is hot", "it's laggy") pin Low at most and never raise the tier: a device already below Low
  stays where it is. A slow frame named on Peak ("it lags on peak settings") pins Ultra at most from the console's
  `goal`; in the card Sloane first asks whether the lag is steady: hitches hand the tier back to auto, and a steady lag
  pins Low if you put a steady frame rate first (auto if you keep the detail).
- **While the model in this page works** (A model in this page), the governor is held under a cap (`hold()`): Low on a
  computer whose GPU is integrated, Minimal on a phone, Lite on a lite profile, and nothing lower on a discrete GPU,
  except that Peak comes down to Ultra while the model is on the GPU; with the model on the processor of a discrete
  card's computer Peak stays. An Apple chip at Peak comes down to Low like any integrated GPU. A tier above the cap
  drops to it at once, probes stop at it (and never go into Peak under a hold), and a step down under the hold is
  taken but not remembered against the tier (the device is busy with the model, not too slow for the tier). The
  release returns the tier from before with the usual cooldown, except where the hold took Peak away: then it returns
  Ultra, and Peak is earned back after a quiet spell. A manual tier is left alone; the snapshot's quality carries
  `held` while the cap is on.
- **Under the cinema camera:** the governor still reads every animation frame, so it keeps input and physics
  at the display's rate. Only 24 of those frames a second are drawn, so each drawn frame gets more GPU time, and
  the governor usually settles a tier or two higher than it does with `?cinema=0`. Two rules are specific to it:
  - The animation frames are held at the 60 FPS floor whatever the display. A 120 or 144 Hz display does not buy
    extra input frames with fidelity, since the camera shows 24.
  - The camera's own frames are counted, in half-second slices. Short of 90 % of them in every slice for more
    than 2 s (two frames missed in each) steps down one tier, even while the animation frames look fine. A step up
    waits until the camera has presented 97 % of its frames for 5 s.
- **Where it runs.** A native shell (a Tauri v2 window, whose WebView2 on Windows 11 is desktop Chromium) is
  recognised by what Tauri injects, and the snapshot says so (`process.host`). It profiles as the desktop it is:
  a high-end GPU starts on Ultra with the full crowd. Stock Chrome, Edge and WebView2 report a GPU's vendor and
  architecture but not its name, so an AMD card starts on High there (it cannot be told from an integrated chip of
  its architecture) and the first probe takes it to Ultra about 6 s after boot.
- **Peak, above Ultra.** Tier 5, outside the tier table like Lite, so every other tier number stays as it was.
  - **What it adds.** Ultra drawn at 1.25 times the resolution on each side, about 1.56 times the pixels (smoother
    edges), the sun's shadows reaching 160 m around you instead of 80 m at the same sharpness, and full-detail people
    out to 90 m instead of 45. The shadow map takes about 512 MB of graphics memory instead of 128 MB, and the larger
    picture about 45 MB more at 1080p (about 190 MB at 4K). Both are given back when the tier comes down. The picture
    is never made larger than the graphics card's largest texture, which also keeps `?scale=2` working on a very wide
    window at any tier.
  - **Which computers try it by themselves.** Desktops and laptops with a separate graphics card of any make, or an
    Apple computer's chip, with at least 8 cores and, where the browser says, at least 8 GB of memory. Phones and the
    lite profile never do. It also needs a browser that gives the page the GPU's own timings (WebGPU timestamp
    queries). Without them the governor stops at Ultra. Safari, for one, gives none.
  - **How it decides.** Under the cinema camera the frame rate cannot show spare power, so the governor reads how long
    the GPU spends drawing each frame. It tries Peak only after 5 s on Ultra in which nine frames in ten took at most
    5 ms of the GPU (30 % of a 60 FPS frame; less when `?fps` or a fast display without the camera asks for more
    frames). On Peak, half the frames taking more than 13.3 ms (80 %) for 2 s, or the frame rate or the camera falling
    behind, bring it back to Ultra.
  - **When it comes down.** After a quick failure, the next try needs a GPU time a quarter lower than the one that let
    it in, and the usual wait applies (40 s, then longer). After the third time in a visit, Peak stays off until the
    page is reloaded.
  - **In the console.** In auto on Ultra or Peak, `quality` ends with the GPU time against the limit
    (`peak 3.1/5.0 ms`) or `peak off`.
  - **By hand.** `quality peak` or `quality 5` pins Peak on any computer. On one without a big GPU it can run out of
    graphics memory, and a reload goes back to auto. With the Linux launcher, `crimson-noir-agent-city peak=1` (or
    `nix run … -- peak=1`) adds `?peak=1`. A console-class AMD chip that reports itself as integrated graphics is not
    picked by itself: give it `?peak=1`. In a browser, add `?peak=1` to the address.
  - **Agents and Sloane.** Agents cannot ask for it, and no goal sets it. When a goal names Peak ("peak quality",
    "beyond ultra", "can you turn on peak graphics?", "peak graphics and no traffic"), Sloane asks first: "Peak takes
    a big graphics card and about half a gigabyte more of its memory. Set Peak, or keep to Ultra at most?" The rest of
    the goal reads as it would without Peak, so "peak graphics and no traffic" still clears the roads. The console's
    `goal`, which asks nothing, leaves the quality as it is; `quality peak` pins Peak there. "Best" and "max" still
    mean Ultra. A no, a turn-down, another tier or a complaint about its cost in the goal ("i don't want peak
    graphics", "turn off peak graphics", "ultra instead of peak graphics", "peak graphics is too heavy", "i prefer the
    light to peak graphics", "cancel peak graphics") lowers the quality to Ultra at most without asking, and a lower
    tier or auto named beside it stands ("peak graphics, medium please"). A heat or battery complaint ("hot on peak
    graphics") gets that complaint's own fix. To her question, the Set Peak chip, or Peak by any of its names typed
    with words like "please" or "yes" ("peak please", "yes, set peak", "beyond ultra", "peak, not ultra", "higher than
    ultra"), sets Peak; Ultra at most, a no or a complaint gives Ultra at most; a lower tier or auto you name stands
    ("medium", "auto"); anything else ("yes", "higher", "peak?", "is it worth it") leaves the quality as it is. "Peak"
    in another sense ("sun at its peak, graphics on ultra") reads as it did before Peak. In the card, an answer to any
    of her other questions that names Peak counts as it would in the goal, and with Peak set, a turn-down ("no peak",
    "cancel peak", "turn down the graphics", "my card only has 4gb", and to a question about the picture "lower
    please"; "changed my mind" right after Set Peak), a slow frame, heat or another tier named in any answer ("the
    light, on ultra", or "reduce the quality" for Low) brings it down; "max graphics" keeps it.
  - **Tried so far.** Only in headless Chromium on the software adapter: with a faked RTX 5090 (the browser smoke's
    `peak` scenario), and pinned for a few frames in the `ultra` scenario, also in the Nix package's Chromium. Not
    measured on a real big GPU.
- **How many pedestrians.** Unless `?crowd` says, the profile decides at boot: 14,000 wherever it starts on
  Medium or above, 8,000 on a phone, 5,000 on the weakest GPUs and software rasterizers, and 2,500 on a lite profile.
  The simulation's size is fixed for the session (the GPU buffers are sized for it). The tiers then scale how many
  are drawn.
- **The lite profile and the Lite tier.** Entry-level phone GPUs get a profile of their own: any phone whose adapter
  is ARM Bifrost or Midgard (a Mali-G52 reads `arm / bifrost` in Chrome, and so does an older flagship's Mali-G76,
  since Chrome names only the architecture), Imagination PowerVR Rogue, Furian or B-Series (Dawn: `img-tec / rogue`; a
  bare `img-tec` only on 4 GB or less, so a D-Series is not lite), or Adreno 5xx and older, and any phone that reports
  2 GB of memory or less. Valhall and Immortalis, Adreno 6xx and newer, Xclipse, iPhones, desktops, laptops, the
  native shell and software rasterizers keep their profiles. A lite profile:
  - starts on **Lite**, tier -1, below Minimal: half the base pixel ratio's edge, no shadows or post, and a thinner,
    shorter crowd draw (density 0.15, detailed bodies within 8 m, always drawn within 6 m, nobody beyond 80 m). Its
    automatic range is Lite to Minimal, so it never reaches a tier that needs post or shadows;
  - simulates 2,500 pedestrians and 12 cars unless `?crowd` or `?cars` says (a region's street window still caps the
    cars);
  - boots a lighter city, decided before anything compiles: the post chain capped off as with `?post=0` and never
    drawn at boot (so its passes and the velocity copies of every material are never compiled), no lamp point lights
    (the lamp heads and the ground's lamp pools still glow), a 64² environment probe baked once a game hour instead
    of 256² every 12 game minutes, a cloudless sky, coarser tree canopies and signal lenses (about half the street
    furniture's triangles), and a building re-sort every 24 m instead of 6 m;
  - gives the physics realm no street-furniture sensors (nothing there queries them; the page keeps the furniture for
    drawing, contact, the dissolve and ghost view), no balance machine, and no scheduled craft (nothing draws them
    yet). The physics rate and its substeps are unchanged.

  `?lite=1` forces the profile on any device and `?lite=0` turns it off. `?quality=-1` (or `lite`, and the console's
  `quality -1` or `quality lite`) pins the Lite tier on any device without the rest of the profile. The HUD shows the
  tier as Lite, and the console's quality line (`quality`, `stats`, `sim`) ends with `lite profile` on a lite profile.
  A lite page runs 12 cars by default, so it names a different world from a default network room's 36; join one with
  `?cars=36`. The room refuses the smaller fleet without a reply, so the console's `net join` ends in a join timeout,
  and on a lite page that kept its default fleet the line says so and names `?cars=36`. Tried so far only in headless
  Chromium on SwiftShader with a faked Mali-G52 adapter (the browser smoke's `lite` scenario): the faked phone booted
  on Lite with 2,500 pedestrians and 12 cars, drew frames, and its page compiled 31 render pipelines, none of them the
  post chain's; the same phone with `?lite=0` compiled 94, 37 of them the post chain's colour-and-velocity passes. Not
  tried on a real Mali phone: its boot time and frame rate are not measured.

**The two ends of the range.** `docs/autoscaler/README.md` drives the governor as a flagship phone (Safari 26, 120 Hz,
touch) and as a console-class desktop (16 threads, a 10 TFLOPS GPU, 4K at 60 Hz or 144 Hz, tab and native shell)
through overload, heat, recovery, the camera's rules, pinned tiers and noise, with every tier path in
`docs/autoscaler/phone.csv` and `desktop.csv` (`governorPhone.test.ts`, `governorDesktop.test.ts`). It is the
governor's logic on synthetic frames: this machine's headless WebGPU loses its device at boot, so no real GPU was
measured for it. The phone starts on Low, reaches Medium in 5.9 s and never goes higher; the desktop starts on Ultra
and walks an overload down to Minimal one tier about every 3.9 s, then climbs back with its back-offs.

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
- **Pings:** a short two-note cue (C6, G6) plays where a ping landed, on the recruitment cue's voices.
- **Speech:** what a tethered person says (`say`) comes from their head, and follows them as they walk.
- **Rooms** (`07_Execute_Actions/acoustics.ts`). Every voice is placed in the room it is said from. There are no
  interiors, so a room is the street canyon, the crossing's clear square or the open ground a listener or a speaker
  stands on, bounded by the nearest building faces of the physics realm's own geometry: four axis probes over the
  city's boxes, found again when the head crosses into another 2 m cell (a face beyond 120 m does not count, and
  nothing within 20 m is the open). One convolver carries the room's tail, fed by a send per sound group. Its
  reverberation time is Sabine's formula with the open sky as a fully absorbent ceiling, clamped to 0.08–2.2 s: a
  three-storey street rings for about 0.7 s, a tower canyon longer, the pier and the park barely at all. The
  impulse response is rendered, not loaded: deterministic noise under an exact exp(−6.908·t/rt60) envelope
  (−60 dB at rt60), 12 ms of predelay, the highs fading first, scaled to unit energy so the send alone sets
  wetness. Rooms are bucketed to 5 m, so it is re-rendered only when the room really changes, and swapped behind
  silent sends. Near voices are dry and far voices wet, which is what tells the ear the size of the space.
- **Walls and eavesdropping.** A voice heard through a building loses level and highs by a wall table
  (`transmissionLoss`: masonry is number for number the occlusion the speech voice has always had; glass is
  lighter), and one heard from another street is halved again but never silent (`eavesdrop`), so you can listen
  in round a corner. Browsers without a `ConvolverNode` get the dry graph. A region's walls live in the physics
  worker, so every voice there is dry.
- **Closed captions** (`07_Execute_Actions/captions.ts`). Every sound's start, change and stop is reported by the
  soundscape as a plain event (`onSound`), and `CaptionTrack` turns the stream into at most a few lines: one line
  per continuing sound, refreshed rather than repeated; a change retexts its line in place; a stopped line stays
  readable for a short hold, longer for speech; speech ranks above ambience; the feed never exceeds its bound.
  Each line carries the sound's bearing in the listener's head frame (one of eight arrows, a side word, the
  distance rounded to 1 m under 10 m and 5 m beyond), recomputed as the head turns: `↗ [car approaching] · ahead
  right, 25 m`. Cars approaching, passing and shifting, tyres, the crowd murmur (by level, with hysteresis), the
  walk signal per axis, the recruitment cue, the ping cue, the cabin, speech with its words (`Pedestrian N
  (skill): …`, verbatim: what passed the 14A screen is what is read) and a peer's voice (captioned as a voice, not
  transcribed, since the page cannot transcribe a remote stream on-device) are all captioned. The strip sits
  bottom-centre and outlives the `H` key, like the MIC chip. `captions off` or `?captions=0` turns it off.
  `captions.test.ts` sweeps every string the module can produce through the same patterns as `compliance.test.ts`
  and the conduct screen. A sound without an event has no caption.
- **Peer voices:** `attachPeer` places a `MediaStream` the network client hands in, under the peer's name, with
  its own HRTF panner, wall filter and reverb send, at the peer's pose every frame; the soundscape opens no
  connection. The signalling that would carry a voice is a stub (see Networking).
- **Split screen:** each player has a soundscape of their own, in head space, over one shared context (see
  Split screen).

Audio starts on your first click, tap or key, as browsers require.

## Networking

Nothing about the network runs at boot: the page opens no socket until the operator types `net join`, and the
single-file build is unchanged. The room is authoritative (Phase 12, extended to cars in Phase 13): the server runs
its own physics of the city and of every player's car, and is the only word on where anyone is; the page's own
physics realm is the prediction that hides the latency.

- **The host** (`10_Network/replication.node.ts`) is Node-only and never bundled: `npm run serve:net` starts it (Node 22
  strips the types; `NET_HOST`, `NET_PORT`, `NET_SECRET`, `NET_SEED`, `NET_CARS`, `NET_TICK_HZ`, and `NET_TRUST_PROXY=1`
  behind the operator's proxy, so the failure throttle keys on the address the proxy forwards rather than the proxy's
  own), and it prints its
  address, the world it holds (`city/1337/36` unless `NET_SEED` or `NET_CARS` says otherwise: the seed's city and
  the size of its fleet) and an operator token good for a day. It is dependency-free: `node:http` takes the upgrade,
  the RFC 6455 frames are read and written by hand, ping is answered with pong, close is a handshake. Session tokens
  are HMAC-SHA256 with an expiry (`node:crypto`), compared in constant time. A random secret is made per run if
  `NET_SECRET` is unset; a set one shorter than 16 characters (an empty one included) starts no host. It listens in
  plain text on the loopback address (port 8787) by default.
- **No connection without a token.** The token rides the WebSocket upgrade as a subprotocol (`onyx.4` and
  `auth.<token>`), so the host checks its HMAC and expiry before it answers 101: a missing, forged, tampered or
  expired token is a 401, with no socket and no room slot. After five failures from one address in quick succession
  (one more earned every 5 s), further failures from it are answered 429 instead of 401 and not logged; the token is
  still checked, so a good one is always admitted (behind a proxy everyone shares one address). A refused upgrade's
  socket is ended and destroyed within a second, and a client that resets it is no error of the host's. A client that
  dribbles its request headers is dropped after 5 s. The join must carry the same token, and every frame after it is
  sealed under it both ways (an envelope number that must rise and an HMAC over the canonical message: a forged,
  altered or replayed frame is refused). The host's seals use `node:crypto`; the page's use `integrity.ts`. Both
  produce the same digest, which the tests check bit for bit.
- **One player, one connection; a session ends with its token.** A second connection under the same token's subject
  (the same token, or another minted for the same name) replaces the first (close code 4010), so no player holds two
  of the 32 slots. A session is closed the moment its token expires (4003), whatever it is doing. WebSocket pings are
  metered (four a second); every write the host makes, pongs and close frames included, checks the peer's unread
  backlog first, and a peer too slow to read is closed (4009). Untrusted text reaches the log only escaped (C0, DEL
  and C1 control characters, line and paragraph separators and bidi controls, so no escape sequence or forged line
  reaches the operator's terminal), on one line, at most 160 characters.
- **The headless Ring-0 mirror** (`10_Network/mirror.node.ts`) is the host's authority. It builds the city of the seed
  the way the page's physics realm does: every building box, the tiled ground, and the street furniture as sensors.
  The physics is Rapier, the Rust physics engine compiled to WebAssembly that the page's physics worker loads. Each
  player is the realm's own character controller (`07_Execute_Actions/player.ts`, in a mirror mode: moved in place,
  other players not obstacles). The world is built once and stepped once, to build its query tree (every fresh
  world is, the page's too: an unstepped world answers no query). A substep on foot is replayed in about 22 µs.
  Every pose the mirror keeps passes the Ring-0 audit (finite, inside the 1600 m containment slab, above the ground
  floor; a car also under the velocity cap). At the wheel a replay the audit refuses is undone: the car goes back to
  its last audited state, and the correction carries that.
- **The garage** (`10_Network/garage.node.ts`, Phase 13) is the mirror's authority over cars. From the seed and the
  fleet size alone it knows the fleet's own plan (`07_Execute_Actions/carRig.ts planFleet`): which ring of the track
  network every car was seated on, and which is an SUV. When a player takes a car's wheel, the car is built in a
  drive world of that player's own (the city's building boxes and ground; about 20 MB, built in about 20 ms, stepped
  only while they drive), and from then on every substep at the wheel is replayed there with the page's own car
  physics (`carRig.ts carSubstep`: drivetrain, brakes, Ackermann steering, drag, rolling resistance, the raycast
  wheels, then the world step, and the Ring-0 speed clamp after each step). Both sides build the car from the same
  numbers when it changes hands (`carRig.ts rebuildCarRig`: a new chassis, collider and vehicle controller, so no
  contact or wheel state is carried over), and the page's car and the room's agree to the bit
  (`garage.node.test.ts`). A world step of the full city costs about 0.7 ms, so a driving player costs the host about
  4 % of a core.
- **Room mode.** While joined, player 1 walks and drives in the page's realm as the room does (`simCore.ts` `room`):
  a ghost that only the city's fixed geometry stops (the traffic, the other players and the Sanctuary's nudges are
  the page's alone and never the room's), the car tuning at the authored values, and the console commands that move
  a car (`recover`, `setMode`, `tune` and the debug ones) refused (`mirror.node.test.ts` sends each). A car its driver
  leaves in a room stops dead where it is left, and the room holds it there for them (up to 16; past that the oldest
  goes back to traffic on both sides). Every car the room does not hold is, to the room, an AI car on its own ring's
  lane, so the page puts every other car it had stopped back there as traffic: the cars parked before a session
  starts, and a car a correction takes the player out of. In room mode the page and the room agree to the bit on foot
  too, so the room's tolerance is a micrometre.
- **Drift.** The page and the room agree to the bit almost everywhere. Where the player meets two boxes at once (the
  shared wall of a terrace's lots), each side's physics can take the two contacts in its own order and part by
  micrometres (the second Phase 13 review measured up to 0.6 mm on foot and 1.4 mm at the wheel, and had an honest
  player removed for it). A claim off by more than the micrometre but within the drift bound (`MIRROR.drift`: 25 cm on
  foot, 1 m at the wheel) is kept as the room replayed it, and the page is put back there: a correction to the page
  (marked `drift`), but no refusal, no notice to the player and no count toward removal. The truth is the room's
  replay either way, so a claim moves nothing: a drift gains a liar nothing, and a claim past the bound is a lie,
  refused and counted.
- **What the page sends: the steps its realm ran, and where they left it.** Each realm step is one move, paired by the
  engine with the one step request that ran it:
  - the door it took first, if any (`simProtocol.ts doorOf`: the realm's own entered or exited event; a teleport or a
    correction that moved the player is no door): into car `i` in the state the realm took it over in, or out at the
    point the realm put the player down;
  - on foot the walking velocity asked for, clamped as the realm clamps it; at the wheel the command the car ran (the
    bouncer's vetted throttle, brake and steer, and the handbrake);
  - how many fixed 1/60 s substeps it ran;
  - where it left player 1 (the claim: the capsule, or the chassis);
  - the correction it carried out.
  Moves are coalesced into runs of substeps while the input rate is spent; a door starts an input of its own, and the
  claim is always where the last run ended. A quiet page (a hidden tab, a player standing still) sends a keepalive
  ack every 5 s; the room lets a peer go only after 75 s of silence, since a browser runs a tab hidden for minutes on
  one timer a minute.
- **What the server does with them, the moment they arrive.**
  - **On foot** it replays the substeps on its own capsule, with the same clamp (`simProtocol.ts footWish`) and the
    same controller. A claim more than a micrometre off is put back (within the drift bound) or refused (past it),
    so a speed hack, a wall walked through and a position written into the page's memory move nothing.
  - **Into a car**: the car must be within the realm's door (3.8 m, with 1 cm of slack) of where the room has the
    player. The room then takes over the car in exactly the state the page reported, so every number of that state is
    checked, not only where the car is (`garage.node.ts GARAGE`). Each bound is set from what the fleet was measured
    doing (its own traffic, and an emergency stop for a pedestrian), most with at least twice the measured value; the
    lane and heading bounds have less (1.0 m against 0.78 m measured in corners, 0.5 rad against 0.29 rad).
    - A car this player drove before is held by the room, stopped where it was left: it must be within 0.5 m of that
      spot, turned at most 0.1 rad from how it was left, and moving no faster than a car settling on its springs
      (0.5 m/s, 0.5 rad/s; measured: 0.10 and 0.12 after a dead stop).
    - Any other car is an AI car, and an AI car's position is not computable on a server: it is a Rapier body that
      brakes for the pedestrians of each page's own GPU crowd (the First Law), so every page's traffic is its own.
      What the room checks is everything that can be checked: on its own ring's lane (within 1.0 m: the fleet's own
      cars stray at most 0.53 m on straights and 0.78 m in corners), facing along it (0.5 rad), upright, at a car's
      height, and moving as a car on a street moves: forward along its heading no faster than the ring's limit and
      0.5 m/s, sliding sideways no faster than 4 m/s, rising no faster than 0.5 m/s, pitching or rolling no faster than
      1 rad/s, turning no faster than 3 rad/s. A car claimed moving upward or sideways would otherwise be launched by
      the room's own replay (the Phase 13 review landed one on a roof that way).
  - **At the wheel** it replays the runs on its own copy of the car, which is then the truth: a chassis claim more
    than a micrometre off it is put back with the car's state (within the drift bound) or corrected and counted (past
    it).
  - **Out of a car**: the exit point must be within 0.5 m of the one the room computes from its own chassis
    (`carRig.ts exitPoint`, the realm's rule), and the room puts the player down at its own point.
  - **What a door can carry you**: a pair of doors moves a player at most 5.91 m (3.81 m into a car, 2.1 m out) and
    spends no substep, so the room takes at most 1.75 doors a second (a burst of four): a hop chain alone is no
    faster than a run (5.17 m/s), and the runs between hops add at most a run more, only where cars stand within a
    door's reach along the way (`replication.test.ts` drives every mix of doors and runs against an authority that
    grants each door its full reach).
  - A packet is also refused for any of these: more substeps than the clock allows (the realm's 60 a second, refilled
    5 % faster so a bank spent in a stall comes back within a minute, three seconds banked); more doors than the clock
    allows; a malformed, replayed or forged input; a mode without its door
    (at a wheel without taking one, on foot without leaving it); too many inputs.
  - A refused packet is answered in the same turn with a correction: the truth, under a new correction number. On
    foot nothing of the refused packet is kept; a door it took is kept if it was good on its own. At the wheel the
    replay is kept (it is the room's own physics) and the correction carries the car's full state. Inputs the page
    sent before it applied the correction are dropped unread for 5 s after it (an honest stall's backlog, on an
    allowance of its own); after that, or past that allowance, each is a refusal.
  - **A stalled link.** The page stops sending once 150 of its inputs (two and a half seconds of steps) are
    unacknowledged (`netClient.ts MAX_IN_FLIGHT`), so whatever a stall piles up arrives within the room's input
    allowance, which refilled meanwhile. A stall shorter than that costs nothing; a longer one costs one correction
    (the steps taken past the cap are held, then dropped, and the room corrects the next input), never a refusal,
    however long the stall or the session (`netClient.test.ts` stalls an honest page for 2, 8 and 30 s, and ten
    times in five minutes).
  - A player who keeps earning corrections (more than ten a minute) is removed (code 4008).
- **Snap reconciliation on the page** (`netClient.ts`, `engine.ts`). The welcome is the first correction: the spawn.
  The engine applies each new correction once: on foot as a teleport of player 1 to the truth, at the wheel as the
  car built again in the room's state (`simCore.ts` `netCar`), ahead of anything the player queued meanwhile (an E
  pressed on the same frame then acts on the truth, and no door out of a car the room never had is reported). Those, and the room mode on the welcome and off when
  the session ends, are the only things the room may ask of the physics realm. `net status` shows how often the
  room has snapped you and why (`snapped 1  last: claim 30.00 m from the mirror's pose`); its dropped count is the
  steps the room could not have kept (run before a correction was applied), not the ones held for the next input.
- **What everyone sees.** Other players come from the server's truth, not from what a page claims. They come back
  as pose records and are drawn as ghosts (`07_Execute_Actions/netView.ts`): the crowd's business-casual body on foot,
  the car body at a wheel, in ghost view's ink, translucent, casting no shadow. A remote player is never a collider,
  never in a step request, never sensed by the crowd. The engine holds no network code either: App builds the client
  and hands it in through the `NetHost` seam (`netWiring.test.ts`). The room's chat and pings reach the captions; a
  remote ping is cued where it landed and captioned under the sender's name, goes on no board and asks nobody over.
- **The page** (`netClient.ts`). `net join <ws-url> [<token>]` (operator tier) joins a room under the name Sloane
  knows you by ("Visitor" before you have one), in the city of this page's `?seed` with its fleet (`?cars`) on the track
  network. A page walking the surveyed region (`?region=on`) or with the track network off (`?tracks=0`) cannot join:
  the mirror holds the procedural city and the fleet's plan. The client speaks ws or wss only to `localhost` or
  `127.0.0.1`, the hosts the page's content security policy reaches: the host on this machine, or the local end of a
  tunnel or proxy you run towards a room elsewhere.
  - **A server in the cloud** is reached the same way: run the host there (`NET_HOST`, behind TLS) and reach it
    through a local end on this machine (an SSH tunnel such as `ssh -L 8787:127.0.0.1:8787 <server>`, or a reverse
    proxy terminating wss). The page never names an address off this machine; the Phase 11 air gap
    (`02_Define_The_Rules/airgap.ts netServer`) refuses any other before a socket opens.
  - The token is kept in this browser (`localStorage`, key `civic-simulation:net:v1`) and reused when none is typed.
    `net forget` drops it and `net leave` leaves the room. `net status` (readable at any time) shows the state, the
    room, your player number, the peers drawn, the steps held and pending, the voices placed, the corrections, and
    the reason for the last end. `history` keeps the token as dots.
- **The 14A screen on names and chat.** Every player name and every chat line goes through `conduct.ts screen()`
  on the host, in the client before anything is sent, and once more on the page when it arrives (the host is not
  trusted either: a welcome or snapshot carrying an inadmissible name is refused whole). An inadmissible line is
  dropped silently, with no relay and no reply, and counted. The screen reads a line as it renders: characters that
  draw nothing (zero-width spaces and joiners, the soft hyphen, the word joiner) are removed before the lexicon reads
  it, letters of other alphabets drawn like Latin ones (Cyrillic, Greek, Armenian, Cherokee, the small capitals;
  fullwidth and mathematical letters fold already) are read as the Latin letter, and a name or a line may hold no
  control character, line separator, bidi control (which could reorder what renders) or lone surrogate. It is still
  a lexicon: a misspelling or a digit for a letter passes it. Two budgets remove a peer. Refusals (a malformed or
  forged frame, an out-of-rate input, chat or ping, a stale input long after its correction, a bad token, an
  inadmissible line) are an allowance: eight in a burst close the socket (code 4008), and it comes back at four a
  minute, so an honest client's rare refusal never adds up over a long session. Corrections (a drift is not one; an
  input the authority will not keep: a stale sequence number, a correction never made, a future ack, more substeps or doors
  than time allows, a claim off the truth) count toward ten a minute, with the same close. A host that sends the
  page enough malformed messages is left the same way.
- **The smoke test.** `npm run smoke:net` starts the real server as a process of its own (snapshots once a second,
  so the answer to a packet is plainly its correction) and plays a client over a real socket. It checks that a
  missing or forged token is refused before a socket opens, that an honest walk is kept (it waits for the snapshot
  that acknowledges the walk's last step, however late), and that nine crafted illegal packets are each refused and
  corrected within 50 ms (measured here: 0.7–15.1 ms), with nothing else sent
  back and the server's truth unchanged: a position written into memory, 600 substeps in one packet, a burst past
  the bank of 180 substeps (the correction proves the six honest bursts before it were the ones kept), a walk
  through the podium east of the spawn sidewalk, an injected velocity of three runs, a door into a car 284 m away, a
  car claimed beside the player but off every ring, a door out of a car never taken, and a wheel never taken.
- **Fuzzing and the parity proof** (Phase 13). Seeded, replayable property suites
  (`02_Define_The_Rules/property.ts`) fuzz every layer, with their fixed seeds on every change (`ci.yml`) and, every
  night, at twenty times the case count from a fresh seed (`.github/workflows/fuzz.yml`: `FUZZ_SCALE` and
  `FUZZ_SEED`; a failure prints the `{ seed, runs }` that replay it with no knob set):
  - the protocol core (`protocol.fuzz.test.ts`): validators total, closed and idempotent over 50,000 near misses;
    seals refused for any change; the room's invariants over 400 adversarial sessions on a chaotic clock;
  - the host over real sockets (`host.fuzz.test.ts`): 360 hostile connections a run (random bytes, broken upgrades,
    malformed and oversized frames split at random, resets, silences, same-token races, a slow-header client);
  - the Three Laws, the Bouncer and the Ring-0 auditor (`ring0.fuzz.test.ts`), the car rules both sides share
    (`carRig.fuzz.test.ts`), the WebAssembly routing core against its reference (`routingWasm.fuzz.test.ts`) and
    kv-pager against a model of what it holds (`kvPager.fuzz.test.ts`);
  - and the parity proof (`parity.fuzz.test.ts`): two pages, each the full city with 36 cars, drive on a network
    that jitters both ways, spikes past a second and stalls for 2.5 s; they take doors, floor the throttle, haul the
    handbrake and crash into buildings at once, while a third player lies beside them. Over 90 s of the city the
    room kept about 6,300 steps of the honest two (about 9,100 in all, the liar's honest steps included), each within
    a micrometre of its own replay, corrected neither
    once, and holds the last pose of each to the bit; every lie was corrected, and every drift the liar was made to
    claim put back without a count.
  The fuzzing found and fixed: drive inputs that spent no substep budget, a validator a prototype-less object could
  make throw, player lists left unfrozen, a First Law that a non-number reading slipped past (it now fails toward
  the person), a speed clamp that turned an infinite velocity into a NaN, a substep bank that never came back after
  a stall, and a slow-header client that could hold a socket for a minute.
- **The ledger door** (Phase 14, `ledger.ts`, `ledger.node.ts`). The same host also verifies the learning of
  Crimson Noir OS's hosted runtime (`crimson_noir_os/`, its `bridge` command). It is a second door beside the room,
  on its own subprotocol (`crimson.1`), behind the same tokens, the same 401 and 429, the same sealed and numbered
  envelopes, and its own bound on frames. It opens only when the operator pins the OS configuration's digest
  (`crimson_noir_os/containment.lock`, or the file `NET_LEDGER_LOCK` names); without one it answers 404.
  - A runtime says hello with its configuration's canonical text. The host takes it only if its SHA-256 is the
    pinned digest, it reads strictly, its names pass the 14A screen, and it still declares the bootable image
    air-gapped (`network = false`).
  - Then come the entries of its weight ledger, hash-chained. The host replays the fold under the containment rules:
    only roles declared with `learn` learn, every reward is one the kernel's formula can produce (not merely in
    range), every station exists, ticks never go back, and every entry links to the one before.
  - The seal must name the fold's own head, count and weights digest, and the weights must be in range and held
    only by learning roles. The host answers `verified` and keeps the weights, or `refused` with the reason and a
    close (4008), keeping nothing.
  - Any runtime of the same configuration can then fetch the last verified weights. It checks them again itself
    before it adopts them.
  - The door never dials out: the airgap test forbids the ledger files any outbound call.
  - `npm run smoke:bridge` runs both sides as they ship. It starts the host as a process, has the Rust runtime
    record its run, and gets it verified. A fresh runtime then adopts the weights bit for bit. Finally it checks
    what must be refused:
    - the runtime with no token, with a forged token, aimed off this machine, or given a name to look up (it
      looks up no names);
    - over the wire, a sentry that learns, a swapped reward sealed as the honest weights, an entry edited in place,
      and a reward no clock gives.
    It also checks that the host still shares only the honest weights.
  - `ledger.node.test.ts` adds a fuzz: 40 sessions of mutated messages, none of which ever verifies.
- **Deployment** (Phase 15, `deploy/`, `Dockerfile`). The host ships as a container image built from distroless
  Node 24:
  - It holds only the 27 files the host runs (`tools/net/closure.mjs` follows its imports the way Node does). That is
    about 55 MB compressed, the base included.
  - It runs as a non-root user on a read-only root.
  - The image's own Node proves at build time that the host starts from those files alone.
  
  `deploy/deploy-live.sh` starts it on a plain Ubuntu server in one command, Let's Encrypt included;
  `deploy/docker-compose.yml` puts it behind nginx (`deploy/nginx.conf`):
  - The proxy terminates TLS (1.2 and 1.3, with the hybrid post-quantum key exchange offered first) and admits only
    `GET /` with a WebSocket upgrade.
  - It checks Origin, limits each client address, and logs no header.
  - The host sits on an internal network that has no published port and no route out.
  
  Operator tooling:
  - Tokens are minted per player or runtime with `tools/net/mint-token.mjs`.
  - The secret is a file (`NET_SECRET_FILE`), never an environment variable.
  - The host prints no token when its logs are kept (`NET_PRINT_TOKEN=0`).
  - Clients reach a cloud host through `deploy/bridge-tunnel.conf`: a local nginx on their machine that carries the
    connection over verified TLS. The game page joins with `net join ws://127.0.0.1:8787 <token>`, since its
    loopback gate and content policy allow 127.0.0.1 only. An OS runtime's bridge works the same way, since it has no
    TLS and looks up no names.
  - A token's signature is accepted only in the spelling `mintToken` writes. The decoder's ignored padding bits no
    longer give a token four valid spellings.
  - The host keeps for the fleet only the configuration's own run: its seal is pinned in
    `crimson_noir_os/containment.seal` (Phase 16). Any other lawful ledger is verified, answered `kept: false`, and
    not kept, so no token-holder can replace what runtimes fetch.
  - Phase 16's audit (eight attack agents, a skeptic each) left property tests across the gate, the tokens and
    seals, the frames, the ledger door, a hostile host against the runtime's bridge, the routing and page-table
    modules, the Rust core and the host under churn; every confirmed finding is fixed with a regression test.
- **What is a stub, and what is not there.**
  - Voice: `attachPeer` places a peer's `MediaStream` in the soundscape, but the signalling that would carry one
    (offer, answer and candidates over this socket) is a documented stub, so no voice is sent or received.
  - The page has no chat command: it receives the room's chat and sends none.
  - The surveyed region has no mirror, and street-hopping traffic (`?tracks=0`) no plan.
  - Each page runs its own traffic: the AI cars you see are your page's, not another player's. Cars pass through
    cars (the realm's contact policy), so two players' cars never meet.
  - Snapshots carry every joined player every tick (at most 32 peers, no interest management).
  - There is no reconnection or resume.
  - The host trusts its proxy for TLS and the origin check; it closes on a fragmented frame and counts a binary one
    as a refusal.
  - The HUD does not show the session; `sim` and `__SIM__` report it as `output.net`.
  - Tested in Node: the client against the real host, and the page's realm, client and host end to end
    (`authority.node.test.ts`, two drivers; `parity.fuzz.test.ts`). A room joined from two browser tabs has not been
    tried here: the page's 3D track cannot run in this headless browser (see Browser support).

## Layout (causal order)

Every source file opens with "Why does this file exist? / What breaks if it is removed?".

| Stage | Files | Role |
|---|---|---|
| — | `brand.ts`, `MonolithLogo.tsx`, `App.tsx` | Product name and mark; the React shell (`App` → `GuiShell`, the city, or `TtyShell`, the console alone under `?boot=tty`): boot veil, HUD, concierge, the wardrobe card, touch and console overlays; it builds the cognition router (with the model kept in this page, its file picker and its drop) and the network client and keeps the look and the token |
| 01_Initialize_World | `world.ts`, `city.ts`, `materials.ts`, `fbmTexture.ts`, `solar.ts`, `codeDissolve.ts`, `region/` (`projection.ts`, `grid.ts`, `names.ts`, `clip.ts`, `pack.ts`, `compile.ts`, `regionWorld.ts`) | WebGPU device, city grid, districts, shoreline and furniture, procedural materials (filtered against moiré), sky, sun, haze, the lake; the code dissolve's material helper (any node material into falling green binary code, by a per-instance amount, shadow included); the surveyed region: its projection, fictional names, the compiler's core, the pack format, and its meshes, walls and places |
| 02_Define_The_Rules | `laws.ts`, `ring0.ts`, `ring0Panic.ts`, `civic.ts`, `collision.ts`, `conduct.ts`, `degrees.ts`, `airgap.ts`, `integrity.ts`, `property.ts` | The seeded, replayable property harness every fuzz suite shares; SHA-256, HMAC and canonical encoding for every hash and seal; the air gap (the one definition of "this machine", and the guard installed on the page's and the worker's globals); Ring-0 bouncer and audit (both run in the physics worker; the audit's craft check), the page's panic lock; kernel limits, signal cycle, speed limit, checks; the contact policy (cars pass through cars, the ragdoll balance machine wired with no vehicle a cause, no combat) and the collision groups (the chassis, the wheel rays, the avatar through a rig); the 14A conduct core and screen; degrees of success |
| 03_Spawn_Agents | `crowd.wgsl`, `crowdCompute.ts`, `crowdSensor.ts`, `crowdSim.ts`, `crowdCull.ts`, `crowd.ts`, `skills.ts`, `look.ts`, `ragdoll.ts`, `ragdollRig.ts` | GPU pedestrians, their hazard sensing and their summons (in the physics worker), the contract and layouts both sides share, culling/LOD/density and indirect InstancedMesh rendering, the dissolve amounts and the look words (on the page); every pedestrian's skills, the recruitment rules and the rally rule both realms run; the closed wardrobe and the packed look word; the active ragdoll's balance machine, pool and Rapier body (wired by `07_Execute_Actions/ragdollRealm.ts`; `COLLISION.ragdoll: true`, and `collision.test.ts` keeps that the one road to it) |
| 04_Connect_Hardware | `input.ts`, `hal.ts`, `dualsense.ts`, `lineLink.ts`, `gamepad.ts`, `seats.ts`, `peripheralPolicy.ts`, `TouchControls.tsx` | Keyboard/mouse/touch/gamepad (the ping among the actions), the hardware bus and its drivers; the seating plan for four local players and the per-seat pad intent; the draft default-deny gate for actuating peripherals (microcontrollers, drones; `docs/hal-peripherals-spec.md`), not yet wired |
| 05_Observe_Environment | `telemetry.ts`, `governor.ts`, `profile.ts`, `lookStore.ts` | SIPOC X snapshot (the dissolve, the pings, the drawing switch, the players, the session and the captions among its optional fields), frame statistics, quality governor (and its hold while the model in this page works), the visitor's name and look |
| 06_Make_Decisions | `traffic.ts`, `tracks.ts`, `trackDriver.ts`, `routingWasm.ts`, `routing.wasm.ts` (generated from `native/routing`), `intent.ts` | The track arithmetic as WebAssembly, with `tracks.ts` its reference; AI drivers: the street-hopping driver and the track follower, sharing one reaction check and hazard episode; the fixed track network (the car rings, the train loop, the drone corridors, the plane racetrack, the headway seats, the box hold); the 5-Whys intent engine |
| 07_Execute_Actions | `engine.ts`, `simClient.ts`, `simProtocol.ts`, `physics.worker.ts`, `simHost.ts`, `simCore.ts`, `physics.ts`, `vehicles.ts`, `car.ts`, `carRig.ts`, `fleetView.ts`, `trackFleet.ts`, `ragdollRealm.ts`, `rigView.ts`, `sanctuary.ts`, `player.ts`, `head.ts`, `controls.ts`, `viewports.ts`, `quality.ts`, `audio.ts`, `acoustics.ts`, `captions.ts`, `postfx.ts`, `cinema.ts`, `shutter.ts`, `volumetrics.ts`, `ghost.ts`, `contact.ts`, `dissolve.ts`, `netView.ts`, `operator.ts`, `harness.ts`, `spatial.ts`, `Hud.tsx`, `BootVeil.tsx`, `Concierge.tsx`, `Customizer.tsx`, `glyphs.ts`, `terminal/` (`Terminal.tsx`, `bridge.ts`, `commands.ts`, `repl.ts`) | Frame loop; the physics realm (worker entry, its message door, the simulation core, Rapier world, fleet on its tracks, the car rules the page and the room share (the rig, the substep, the exit point, the fleet's plan), the scheduled craft and their pose stream, the balance machine over the pedestrians near the operator and its rig stream, sanctuary, up to four avatars) and the page's end of it (client, protocol, fleet drawing, rig drawing, first-person heads, per-seat controls, the split-screen arithmetic); quality applier, soundscape (with its speech voice, rooms, peer voices and the sound-event stream), room acoustics, the caption track, post chain, the cinema camera (24 fps pacer, 180° shutter, ND and film response), sun shafts, ghost view, the passage envelope and the code dissolve's envelope, the network ghosts, operator facade and physics harnesses (the spatial sweep's plan among them), HUD, boot veil, concierge, the wardrobe card, control glyphs, console (with R0, its stack machine) |
| 08_Swarm | `recruitment.ts`, `taskRouter.ts`, `memory.ts`, `ping.ts` | The swarm's hash-chained memory and weight ledger; the operator's voice: on-device continuous speech recognition, the request parser, the main-thread proximity match, the request to the physics worker, the rally request, and the console and `recruit()` fallback; the task gateway that binds skill-bound work to the tethered swarm; the swarm's episodic memory (IndexedDB, by world seed and pedestrian); the ping's pick, board and rally plan |
| 09_Cognition | `localCompute.ts`, `claudeApi.ts`, `router.ts`, `prefixCache.ts`, `kvPager.wasm.ts` (generated from `native/kv-pager-wasm`), `localSpeech.ts`, `inPage.ts`, `inPagePlan.ts`, `inPageCaps.ts`, `gguf.ts`, `modelStore.ts`, `modelStore.worker.ts`, `wllamaRuntime.ts` | The prompt-prefix page table over kv-pager as WebAssembly; the operator's model providers and voice: the router (`claude` through a gateway on this machine with the operator's key; `ollama` and `llamacpp` on this machine), the local client in both wire formats and the Claude client, the system prompt opening with the 14A core and then the tethered people's skills and memories, the streamed answer, the speech client for a speech server on this machine, the audio for the soundscape, the cut when the tether breaks, and every failure as one sentence; the model in this page (`inpage`): its device policy, what the browser offers, the GGUF header check, the file kept in the page's storage (copied by a worker of its own), and the one adapter over wllama |
| 10_Network | `replication.ts`, `replication.node.ts`, `mirror.node.ts`, `garage.node.ts`, `plane.node.ts`, `netClient.ts`, `telemetry.ts` | The network room: the plain-data protocol core and authoritative room both sides share (validated both ways, rate-limited, screened under 14A, every input judged by an authority and refused ones corrected), the Node-only WebSocket host (HMAC session tokens checked at the upgrade, one connection per player, never bundled), the headless Ring-0 mirror it judges with (the city of the seed in Rapier, the realm's own character controller, the Ring-0 audit) and its garage (every player's car replayed with the page's own car physics, every door checked), an open-plane authority for the protocol's tests, and the opt-in page client that speaks ws or wss only to `localhost` or `127.0.0.1` (the host on this machine, or the local end of a tunnel or proxy), reports the realm's steps and doors, snaps to corrections, and reconciles the room's snapshots into the poses `netView.ts` draws |
| native/kv-pager | `01_geometry.rs`, `02_page_table.rs`, `03_gpu/`, `bin/stress.rs`, `bin/chaos/` | A paged KV cache (its page table also runs on the page, through `native/kv-pager-wasm`) (prefix caching, copy-on-write, the WGSL decode kernel, the stress and chaos runs); `CAUSAL.md` traces the copy-on-write chain |
| native/kv-pager-wasm | `lib.rs` | kv-pager's page table (no GPU) behind a C ABI, built to WebAssembly as `09_Cognition/kvPager.wasm.ts` (`npm run native:wasm`) |
| native/routing | `lib.rs`, `layout.rs`, `math.rs`, `tests.rs`, `verify.rs` (Kani proof harnesses, `cfg(kani)` only) | The track arithmetic in dependency-free Rust, built to WebAssembly as `06_Make_Decisions/routing.wasm.ts`; its layout is defined once in each language and the two are proved equal |
| tools/native | `build-wasm.mjs`, `wllama-pack.mjs` | Builds both crates for `wasm32-unknown-unknown` with the checkout mapped to one fixed prefix (so the bytes are the same on any machine, and no module carries a builder's directory) and writes the generated modules with their sizes and SHA-256; pins the in-page model runtime from the npm package into `third_party/wllama/3.8.1/` (`npm run native:wllama`: the module gzipped, its sums and its import list) |
| tools/verify | `fvps.sh`, `fvps_smt.py`, `wasm_airgap.py`, `page_dist.mjs` | The formal verification step (Phase 18): the Kani harnesses, the Z3 theorems, the WebAssembly air gap and export pin (and the pinned in-page runtime held to its sums and reviewed imports), the routing core's LLVM IR call scan; one command, run before every release bake and in CI; and the check of the built page (one file, its size budget, no model, only reviewed hosts) |
| tools/sandbox | `probe.sh`, `verify.mjs` | The zero-trust sandbox's escape probes (egress, daemon sockets, workspace-file execution, privilege, credentials) and the experiment that runs them contained, in a weakened control and beside the checks, on every pull request (`docs/zero-trust-sandbox.md`) |
| tools/selfheal | `agent.mjs`, `checks.sh`, `failures.mjs`, `ast.mjs`, `sandbox.mjs`, `planner.mjs`, `Dockerfile.sandbox` | The self-healing agent (Phase 18): the named checks, failure parsers, syntax-tree loci, the network-off sandbox, the planners (built-in remedies, then Claude) and the bounded remediation loop that opens `selfheal-*` pull requests and never merges |

## Vehicles

Eight kinds of vehicle (`07_Execute_Actions/car.ts` `VEHICLE_KINDS`: an executive sedan, a transit pod, a logistics
van, a transit coach, a courier robot, a security SUV, a gullwing coupe and a utility rig) are drawn over two chassis
classes of Rapier raycast vehicle, the sedan's and the SUV's (box, mass, power, drag), each proven once against the
First Law's stopping envelope in `vehicles.test.ts`. A kind picks a class and a body: its own extruded side profile
(`fleetView.ts` `PROFILES`), scaled about the chassis origin, with its own glass (the pod's canopy, the coach's window
band, the van's and the rig's cab), brake lights that follow the brake demand, a warm cabin light through the glass at
night on the pod and the coach, an amber flashing beacon on the rig's roof, and wheels sized to it. Every silhouette
stays inside its class's box plus the dissolve's reach (`vehicleKinds.test.ts`), so the camera never enters a body
the dissolve has not taken; a silhouette longer than its box, a full-length coach or an articulated bus, would need a
stopping envelope of its own and is not one of these. The fleet's one seeded draw that used to decide "SUV or
sedan" now decides the kind, with the heavy kinds on exactly the old SUV share, so every fleet a seed laid out before
keeps the same chassis class in every slot (saved rooms, the network's plan and the determinism golden are
untouched). The realm's `meta` carries `kind` beside `suv`; the HUD names the kind when you take a wheel.
- **Collisions:** strict CCD on every chassis; cars pass through cars (collision groups,
  `02_Define_The_Rules/collision.ts`; see Ghost-mode collision), stay solid to the world, and let the avatar on foot
  walk through them (`avatarThroughCars`).
- **Steering:** Ackermann geometry (the inner front wheel steers more).
- **Resistance:** aerodynamic drag and rolling resistance. Coast-down from 50 km/h is about
  0.3 m/s².
- **Powertrain and brakes:** a power limit, brakes scaled to mass, and engine braking.
- **Wheels:** visual wheel spin comes from Rapier.

AI drivers keep the right-hand lane, turn on Bézier paths, brake feed-forward to the stop line
(`v²/2d`) and hold it until green. They keep a safe following distance and steer by pure pursuit. By default they
drive the fixed track network below; `?tracks=0` restores the random street-hopping routes of the earlier
releases, byte for byte (the same seats, drivers and paint from the same stream).

### The fixed track network

- **The network** (`06_Make_Decisions/tracks.ts`) is computed from the seed and the city grid inside the physics
  worker: nothing is loaded, and nothing about routes crosses from the page (the door passes only a plain boolean).
  Cars get the 64 boundary loops of the 2 × 2-block cells, each driven clockwise on the right-hand lane with right
  turns only, on the Driver's own corner curve. Every (segment, direction) belongs to exactly one ring, so no two
  rings share a point (they stay 4 m apart, the width of two lanes) and nobody crosses an oncoming lane. A ring has
  a stop line at every intersection it passes, corners and straight-through crossings alike, and holds at red
  before a right turn (no right on red). Cars are seated in headway slots of 12.6 m on straights clear of the
  intersection boxes: about 15 seats per ring, 900-odd in all, for a fleet of at most 48.
- **Track followers** (`06_Make_Decisions/trackDriver.ts`). Every AI car is a `TrackDriver` on one ring. It
  projects its pose onto its ring each frame and drives the ring's own curve, so it never picks a route, never
  merges and never turns across an oncoming lane. Everything else is the street driver's, shared rather than
  copied: the same hold-at-red at every stop line, the same following rule with the same throttle gate (so the
  Ring-0 bouncer's Third Law never has to rule), the same hazard episode (`HazardEpisode` in `traffic.ts`: one
  Perception roll per person in the path, latency by degree, a comfortable stop at the standoff), the same pure
  pursuit. It adds a don't-block-the-box hold: a car waits at the line while its ring lacks the room for it to
  leave the intersection, so a queue never stands on a crosswalk through a red. A car set down off its ring (a
  harness returning a borrowed car, a recover elsewhere) steers back to it at corner speed and resumes.
- **The Fleet on the network** (`vehicles.ts`). Each frame the Fleet sorts the cars of every ring by arc length
  and feeds each follower its own ring's bumper gap beside its bonnet rays. The rays of a car on a ring skip the
  chassis of every other car on a ring and keep seeing walls, poles and the player's car: from the apex of a right
  turn the straight rays sight the cross street's queue head at 2.4 m though the bodies never meet, and counting
  it would stop every turning car and have the Third Law rule at every corner (`tracks.test.ts` pins the reason).
  The least of the filtered rays and the ring gap is both the driver's following gap and the bouncer's obstacle
  reading. A car steering back to its ring leaves the ring's order while it does, so nobody queues behind a
  phantom.
- **The craft** (`07_Execute_Actions/trackFleet.ts`). With tracks on, the realm also runs the network's scheduled
  craft: three train sets on the elevated loop (a deck 9 m over the median of the two arterial streets, 15 m
  corners, four mid-block stations, a 15 s dwell, a timetable that keeps the sets at least 74 m apart; guideway
  columns at the kerb 8, 16, 24 and 32 m into each block, clear of every lamp, tree and signal pole), one drone per
  20 m of every drone corridor at 40 m clockwise and 46 m counter-clockwise (960 on the city's 32 corridors),
  three planes on the racetrack at 400 m, and two VTOLs on each of two routes between rooftop pads (below). None
  has a Rapier body, a driver or a Bouncer ruling: each is a pure function of the realm's own clock, so a step only
  evaluates the timetable and packs the result, and the craft never interact. What keeps them away from people is
  geometry, proved in `tracks.test.ts`: every corridor clears every building box of four seeds and sits at least
  6 m over any car roof, and none ever reaches the street or the sidewalk.
- **The VTOL routes** (`tracks.ts` `vtolRoutes`, given the city's boxes by `buildTrackNetwork`). A pad is the
  roof of a box between 24 and 60 m up, at least 4 m each way, with nothing taller within the craft's 3 m descent
  column; the inner route picks one in each of downtown's four quarters, the outer one on each of the four sides
  around them, the tallest roofs first. A route flies at its cruise, 75 m for the inner and 85 m for the outer
  (over the drones' upper band, under the planes), along the street centrelines like the drone corridors, with
  12 m curves at the turns (which keep the envelope over the road, clear of a tower built to a lot's corner), and
  turns off at the middle of the block beside each pad for the short hop over the lot to it; there it stops, comes
  straight down at 4 m/s (eased), sits ten seconds turning to face the next leg, climbs back and flies on at up to
  9 m/s with the train's comfortable acceleration. Every leg is checked against the boxes (8 m of clearance under
  the envelope at cruise) and every pad against the others (8 m apart from any leg that is not its own), and a
  loop whose two craft, half a lap apart, would come within two envelopes of each other is not flown; a city whose
  boxes give no such loop for a route has no such route. The kind has its own Ring-0 floor, 24 m: a VTOL under the
  lowest roof a pad is ever set on halts the realm like a train under its deck. `tracks.test.ts` proves, on four
  seeds, that every sample of every craft's cycle clears every box by its envelope (the roof it sits on lies under
  the envelope's bottom), that craft of one route and the other keep apart, and that the drone corridors stay
  clear of every pad's column.
- **The craft stream.** Every step the realm returns a second plain-number buffer beside the car poses:
  `TRACK_POSE` (`simProtocol.ts`), eight floats per craft (position, heading, kind, track, arc length, speed),
  transferred and handed back for reuse like the pose buffer. Before it leaves, the Ring-0 audit reads it
  (`ring0.ts auditCraft`): every value must be finite and every craft at or above its corridor's floor (the train
  deck at 9 m, the drones at 40 m, the planes at 400 m); anything else is a kernel panic with a named reason
  (`Corridor Exploit: train craft 0 left its corridor (y=2.00m below its 9m floor).`), the buffer that halted the
  realm never leaves it, and a halted realm ships no craft. The check only halts, never corrects. A surveyed region
  gets no craft.
- **The craft on the page** (`craftView.ts`). The page builds the realm's network again from the same seed and boxes
  (the craft count must agree, or the view refuses) and draws, from the stream, one InstancedMesh a kind: each train
  set as three cars laid along the loop about the set's head, the drones nosed a little into their way, the planes
  banked through the racetrack's turns by their own speed and the turn's radius, the VTOLs nosed down with their
  speed and upright over a pad; and the structure that stands still: the loop's deck under the rail top, the
  guideway columns and beams, the four stations' platforms at the cars' floor with a canopy each, and a lit pad on
  every roof a VTOL calls at. Trains, VTOLs, the pads and the structure cast shadows; the drones and the planes do
  not. Every material takes rain mode once, and `craftView.test.ts` holds every body inside the envelope its kind is
  proved clear by.
- **The zero-jam guarantee**, precisely. "Zero jams" is an AI-only, per-ring guarantee with containment, not a
  promise about the player. With the fleet on tracks, every AI car is seated on one of 64 fixed right-turn rings
  that never share a point and follows it without choosing, merging or crossing an oncoming lane. On a ring
  carrying at most its capacity (about 15 cars, the most `assignSlots` will ever seat), as proved in
  `tracks.test.ts` and `trackDriver.test.ts` with the kinematic model and in `vehicles.test.ts` with real Rapier:
  no bumper gap falls below 1 m, every throttle passes the Ring-0 bouncer without a Third-Law ruling, no car enters
  an intersection on red or crosses a stop line on red, no car stands in an intersection box through a red (a car
  holds at the line until its ring has room for it to clear the box), no speed limit is exceeded, every car laps
  within the bound and at least one car rounds a corner of every ring in every 64 s window, including behind a
  leader that brakes hard at random. What the guarantee does not cover: a ring stops, and stays stopped, behind
  anything the laws rank above flow or anything physically in its lane that is not a track car, that is, a person
  in the path (First Law), the player's car driven or parked in the lane, a wall placed on the road, or an AI car
  held at a stop line by any of these; and a car set down off its ring steers back at corner speed without obeying
  the signals. In every such case containment holds: only the ring that holds the obstacle is delayed, and every
  other ring's trajectory is identical to the undisturbed run (INV-4). Trains, drones and planes are timetabled,
  interaction-free functions of the realm's clock on corridors that never meet the street, so they can neither
  jam nor be jammed; the Ring-0 audit halts the realm if one ever reads below its corridor's floor.
- **Known limits.** Two cars on neighbouring rings may come within about a metre of each other at a shared corner
  and, since cars pass through cars, overlap at the apex when a car cuts its corner (the measured cut is 0.78 m,
  inside the lane, against a 0.8 m bound the test asserts); both dissolve while they do. A track car parked more
  than 3 m off its own ring is in no ring's order and is skipped by every track car's rays, so cars on that lane
  drive through it (visual only). A 48-car run through the real city for 90 s showed no rulings, no stuck car and
  every car moving. The in-page traffic-lights and spatial harnesses were validated with random routing; they
  have not been re-run in a browser with tracks on, and Node's `spatial.test.ts` builds the realm without the
  flag.

## The Windows app

The city ships as a one-click Windows program as well as the single page: `src-tauri/` is a Tauri 2 shell (Rust)
around the very same `dist/index.html`, built by `npm run app:build` (the Vite build runs first as Tauri's
`beforeBuildCommand`, then `cargo build --release` and the NSIS installer). The `windows-app` workflow builds it on
every pull request and push to main (artifacts `windows-installer-<version>` and `windows-portable-<version>`) and,
when a `v*` tag is pushed, puts both on the tag's release beside the OS media.

- **Installing.** Download `Crimson Noir Agent City_<version>_x64-setup.exe` and double-click it. It installs for
  the current user (no administrator prompt) and puts a shortcut in the Start menu. The file is not code-signed, so
  SmartScreen may ask once ("More info", then "Run anyway"). The bare `.exe` in the portable artifact runs from any
  folder; both need the WebView2 runtime, which Windows 10 and 11 carry (the installer fetches it if a machine has
  none).
- **The window.** It has no system decorations: the page draws the title bar (`src/07_Execute_Actions/TitleBar.tsx`),
  a frosted glass strip in the brand's tokens over a backdrop blur, draggable, with minimise, maximise and close
  through Tauri's window API; the capabilities file (`src-tauri/capabilities/default.json`) admits exactly those
  commands and nothing else of the host. On Windows 11 the window asks for Mica behind the strip; a Windows that
  cannot keeps the page's own black. The bar mounts only inside the Tauri window (`desktopShell.ts` reads what Tauri
  injects at `window.__TAURI__`); a browser tab renders nothing and lays out as before, and the page bundles no Tauri
  package.
- **The bridge.** Tauri serves the page from its own origin, and its responses carry the two cross-origin isolation
  headers (`app.security.headers` in `tauri.conf.json`), so `crossOriginIsolated` is true and the physics realm and
  the page share one `SharedArrayBuffer` (docs/zero-copy-bridge.md), the same path as `npm run dev`. Should a
  WebView2 ever not isolate, the bridge falls back to its private buffer and nothing else changes.
- **The air gap holds.** The page's policy and its loopback gate are unchanged in the app: Tauri's own IPC fetch is
  refused by the gate like any other host and Tauri falls back to its message channel, which is how the title bar's
  commands travel. Nothing in the app reaches a host but this machine.
- **Development.** `npm run app:dev` opens the window over the Vite dev server (`npm run dev` is its
  `beforeDevCommand`). Building needs Rust (1.85 or newer) and, on Windows, the Visual Studio C++ build tools; on
  Linux, `libwebkit2gtk-4.1-dev` and friends. The icon set (`src-tauri/icons/`) is generated from
  `brand/marks/crimson-noir-mark.svg` with `npx tauri icon brand/marks/crimson-noir-mark.svg -o src-tauri/icons`.

## On an iPhone (the web app)

The latest iPhone plays the whole city in Safari, on its own GPU: Safari 26 (iOS 26) turns WebGPU on by default, and
the page picks the phone's tier itself (Autoscaling). Safari gives WebGPU only to a secure page, one served over
https: the Files app only previews `dist/index.html`, and the page served over plain http on the home network
(`http://192.168.1.20:4173`) gets no WebGPU and shows no city. `npm run build:web` writes `dist-web/`, the same page made installable
by `tools/web/pwa.mjs`:
- a manifest (`manifest.webmanifest`: the name, full screen, black) and the home-screen icon, which the page's
  head names; its content policy gains `manifest-src 'self'` so the browser may read the manifest, and nothing else;
- a service worker (`sw.js`) that keeps a copy of every file on the phone after the first visit. From then on the
  city starts with no network at all, airplane mode included. A new build reaches the phone the next time it opens
  online: it is fetched in the background, and the launch after that runs it;
- the two cross-origin isolation headers, added by the service worker to the page it serves (a static host cannot
  send them), so from the second launch the physics realm and the page share one memory bridge, as in the Windows
  app. Where a browser does not honour headers from a service worker, the bridge uses its private buffer and nothing
  else changes.

Serve the folder over https, open the address in Safari, then Share > Add to Home Screen: the city opens full screen
from its icon, with the touch controls (Controls). Two ways to serve it:
- **GitHub Pages (a public address).** Once, in GitHub: the repository's Settings > Pages > Source: GitHub Actions.
  Then Actions > web > Run workflow (`.github/workflows/web.yml`; it never runs on its own). The city is then at
  `https://cassius-software.github.io/Crimson-Noir-AI-Agent-City/`, for anyone with the address (the repository and
  its releases are public already). GitHub serves the files and runs nothing.
- **Your own devices only (Tailscale).** Tailscale on the PC and on the iPhone, with HTTPS certificates turned on for
  the tailnet (Tailscale's admin console, DNS: MagicDNS and HTTPS Certificates). On the PC, after
  `npm run build:web`: `tailscale serve --bg <full path of dist-web>`. The iPhone opens
  `https://<pc name>.<tailnet name>.ts.net/`; only devices signed in to your tailnet reach it, and the certificate is
  a real one, so Safari trusts it.

What the phone copy keeps, and what it cannot have yet:
- **The air gap is the page's own.** The policy and the loopback gate are unchanged: the page connects to its own
  host (which only serves these files) and to the phone's own `localhost`, nowhere else.
- **Models.** The model servers live on a computer's loopback (The model providers), and an iPhone runs none. The
  model in this page (A model in this page) needs pieces of WebAssembly Safari does not offer yet, so on an iPhone
  `ask`'s runtime row names what is missing, Sloane speaks from her script with the phone's own voices, and `ask`
  answers from the script. Menu › Model file still keeps a file there, which cannot run until Safari can: there is
  no reason to choose one on an iPhone yet. Chrome 137 or later on an Android phone runs a small model in the page
  (not yet tried on a real phone).
- **The shared address.** `cassius-software.github.io` is one origin for every Pages site of the organization, and any
  of them could read what this one saves in the browser, a model key typed into the console and the model files kept
  in the page included. Publish other Pages sites under the organization only if you trust them, or use the Tailscale
  way.
- **Storage.** A site added to the home screen keeps its storage; Safari may clear a site visited only in a tab after
  weeks unused.

What is verified: the CI's browser job runs the installable copy in Chrome as an iPhone (`tools/browser/smoke.mjs
pwa`): the browser reads the manifest through the page's policy, the icons load, the service worker installs, the
second load is cross-origin isolated, and with the host stopped the city starts from the phone's copy with its touch
controls. `src/webApp.test.ts` holds the policy change, the icons and the service worker's answers. Not verified, and
needing a real iPhone: Safari's WebGPU in the physics worker, the home-screen launch, the isolation headers from a
service worker in Safari, and heat and memory over a long session.

## On NixOS

A NixOS desktop is meant to run the city on its own GPU through Chromium's WebGPU on Vulkan: Mesa's radv on an AMD
Radeon (console-class RDNA parts included), ANV on Intel, or NVIDIA's driver where the configuration sets
`services.xserver.videoDrivers = [ "nvidia" ]`. The page picks its tier from the GPU itself (Autoscaling); nothing in
the flake pins one. No hardware GPU has run it yet (what is verified is at the end of this section).

**Installing it.** The flake's NixOS module puts the city in the app menu, with its icon:

```nix
{
  inputs.nixpkgs.url = "https://channels.nixos.org/nixos-26.05/nixexprs.tar.xz";  # your system's channel
  inputs.agent-city.url = "github:cassius-software/Crimson-Noir-AI-Agent-City";
  inputs.agent-city.inputs.nixpkgs.follows = "nixpkgs";
  outputs = { nixpkgs, agent-city, ... }: {
    nixosConfigurations.my-pc = nixpkgs.lib.nixosSystem {
      modules = [
        ./configuration.nix
        agent-city.nixosModules.default
        ({ lib, ... }: {
          programs.crimson-noir-agent-city.enable = true;
          nixpkgs.config.allowUnfreePredicate = pkg: builtins.elem (lib.getName pkg) [ "crimson-noir-agent-city-page" ];
        })
      ];
    };
  };
}
```

The module (`tools/nix/module.nix`) builds the package from the system's own nixpkgs, so Chromium and the Vulkan
driver come from one set of libraries (a Chromium from an older nixpkgs can fail to load a newer system's driver);
turns on
`hardware.graphics.enable` (the Vulkan driver WebGPU needs; a configuration that sets it keeps its own value); and,
unless `programs.crimson-noir-agent-city.dualsense = false;`, gives the signed-in user a DualSense's or DualSense
Edge's raw HID node, over USB and Bluetooth, so the browser's WebHID can drive its trigger resistance, rumble and light
bar (Hardware); the plain gamepad needs none of that. The page is the proprietary core (LICENSE, section 1) and its
package says so (`meta.license` is unfree), so a configuration allows it by name, as above; one that already has an
`allowUnfreePredicate` adds the name to its own. (A configuration that lists the flake's
`packages.<system>.default` itself skips that check: the flake's own package set allows the page already.) A
configuration without flakes can import `tools/nix/module.nix` from a checkout; the page is then built from the files
git tracks there and nothing else in the folder. Git lets only the checkout's owner read it: `sudo nixos-rebuild`
passes your user on, but a root shell or an unattended upgrade needs the checkout in root's git `safe.directory`.

**Trying it without installing.**

```
nix run github:cassius-software/Crimson-Noir-AI-Agent-City
```

Flakes are still an experimental Nix feature: a stock NixOS needs
`nix.settings.experimental-features = [ "nix-command" "flakes" ];` (or `--extra-experimental-features "nix-command
flakes"` on the command). In a checkout, `nix run .` does the same. The first run builds the page from source in Nix's
sandbox (`tools/nix/page.nix`: npm installs the lockfile's packages for this platform, each fetched by its integrity
hash, about 89 MB on x86-64, then `npm run build`; the result is byte for byte the page `npm run build` writes) and
fetches Chromium from the NixOS binary cache. Its nixpkgs is the NixOS 26.05 release pinned in `flake.lock`, and
Chromium from it can fail to load the GPU driver of a newer NixOS (today's nixos-unstable driver needs a newer glibc
than 26.05's): the city then starts without a GPU adapter. On such a system the module avoids it for good, or build
from the system's nixpkgs: on a flake-built NixOS,
`nix run --override-input nixpkgs nixpkgs github:cassius-software/Crimson-Noir-AI-Agent-City` (its registry names the
system's nixpkgs); on a channel-based one,
`nix run --override-input nixpkgs "path:$(readlink -f /nix/var/nix/profiles/per-user/root/channels/nixos)" github:cassius-software/Crimson-Noir-AI-Agent-City`
(the registry there names nixpkgs-unstable, and Nix refuses a `path:` that runs through the channel's links).

**What the command does** (`crimson-noir-agent-city`, which is `tools/web/launch.mjs` with Node 24):
- **Serves the page on `http://127.0.0.1:4180`, to this machine only,** with the two cross-origin isolation headers,
  so the physics realm and the page share one memory bridge as under `npm run preview`. It answers `/` (and
  `/index.html`) and nothing else, uncached, so a rebuilt page shows on the next start. The address stays the same
  from one run to the next because the page keeps its settings (the onboarding's answers, the map, a model key typed to
  the console) per address; `--port` moves it, and the page then starts as on a first visit. Ollama accepts the
  address by default (it allows `127.0.0.1` origins); another model server may need the origin allowed in its own
  settings (The model providers).
- **Opens Chromium as an app window** with WebGPU on (`--enable-unsafe-webgpu` and Vulkan, plus
  `--enable-webgpu-developer-features` so the page sees the GPU's full name and picks its tier by it) and a profile of
  its own (`~/.local/state/crimson-noir-agent-city/chromium`, under `$XDG_STATE_HOME` when set; the profile's folder
  in it is `AgentCity`, which also names the window under Wayland), so the switches apply even while another Chromium
  is open. In a Wayland session Chromium opens a native Wayland window; `--x11` (or `AGENT_CITY_X11=1`) runs it
  through XWayland instead. Closing the window stops the server; Ctrl+C in the terminal closes the window.
- **A second start** while one runs opens another window on the same server, but only when the server proves it is
  this user's: a serving launcher keeps a random token in a file only this user can read (in `$XDG_RUNTIME_DIR`, else
  the state folder), and the second start asks it to sign a fresh random value with that token; the token itself never
  leaves the file. Any user of the machine can take a port on 127.0.0.1, and a server of theirs would otherwise get
  this profile's window, and with it the keys saved for that address; such a port is refused instead. A window opened
  on another launcher's server closes when that server stops.
- **Words after `--`** become the page's query (URL options): `nix run github:cassius-software/Crimson-Noir-AI-Agent-City
  -- quality=4 map=lakefront players=2`. The switches: `--port N`, `--dir <folder>` (another build, such as a
  checkout's `dist/`), `--no-browser` (serve only and print the address, for a browser of your own), `--check` (the
  CI check below) and `--help`. `CHROME` names another browser, by path or as a command on `PATH`
  (`CHROME=google-chrome-stable`); `AGENT_CITY_CHROME_FLAGS` adds switches, each starting with `--` and with no space
  inside its value (an `--enable-features` list joins the launcher's own: Chromium keeps only the last list it is
  given); `AGENT_CITY_PORT` and `AGENT_CITY_DIST` set the port and the page.

`nix develop` opens a shell with Node 24, Chromium (as `CHROME`, for the browser smoke), rustup, Python with z3 (for
`npm run verify -- smt`) and git.

**On another Linux with Nix.** The command runs, but Nix's Chromium cannot load the distribution's GPU driver (the
driver's libraries are not where Nix's programs look for them), so the page finds no WebGPU adapter and shows its
"No graphics adapter for WebGPU" card. Where the distribution restricts unprivileged user namespaces (Ubuntu 23.10 and
newer), Nix's Chromium cannot start its sandbox either and stops at start; the launcher says so. In both cases open it
in a browser installed from the distribution or its vendor, which brings the system's driver and sandbox (a snap's
confinement may keep it out of the profile folder), for example Google Chrome:
`CHROME=google-chrome-stable nix run github:cassius-software/Crimson-Noir-AI-Agent-City`. The launcher, its server and
the page built from source stay the same.

What is verified: the `nix` workflow (`.github/workflows/nix.yml`) runs on every pull request and push to main on an
x86-64 Ubuntu runner: `nix flake check` (the page built in the sandbox, the package, and the module evaluated on a
minimal NixOS system, its package evaluating once the page is allowed and refused while it is not), the Nix page
compared byte for byte with `npm run build`, `crimson-noir-agent-city --check` (the packaged command's server serves
the page and the city boots headless in the package's Chromium on the software adapter, cross-origin isolated, with no
exception on the page), and the browser smoke's desktop and Ultra scenarios in that Chromium (the Ultra one also pins
Peak for a few frames).
`src/desktopLauncher.test.ts` holds the address, the headers, the token, the one features list and the flake's shape.
By hand, in a Linux container (Ubuntu 24.04, not NixOS) running as root, so with `--no-sandbox` and the software
adapter's switches (`--use-vulkan=swiftshader --use-angle=swiftshader --use-gl=angle --enable-unsafe-swiftshader`)
added through `AGENT_CITY_CHROME_FLAGS`: the packaged command opened the city in an app window on a virtual display, a
second start opened a second window on the same server, a server forging the launcher's answer on a port was refused,
and closing the window or Ctrl+C closed Chromium, stopped the server and freed the port; under a headless Wayland
compositor Chromium named the window `chrome-127.0.0.1__-AgentCity`, the name of the package's hidden desktop entry; and
run as an ordinary user where user namespaces are switched off, Nix's Chromium stopped at start and the launcher printed
its hint. Not verified, and needing a real NixOS
desktop: a hardware GPU (radv, ANV or NVIDIA), Chromium's own sandbox (every run here had it off), a desktop shell
matching the window to its menu entry and icon, the DualSense rules, and heat over a long session. The
`aarch64-linux` outputs are declared but neither built nor evaluated by CI.

## When the city cannot start or stops

No failure leaves a black screen with nothing to press: the installed iPhone app and the Windows app have no address
bar and no reload of their own, so the page carries its own way out.

- **The recovery card** (`src/07_Execute_Actions/RecoveryCard.tsx`) says what happened in words for this device and
  browser (`bootFailure.ts`), with **Restart** (the page loaded again, focused: Enter takes it) and **Open the
  console** (`?boot=tty`, which needs no GPU). A pad's A presses the focused button and its d-pad moves between them;
  a button held when the card appears does nothing until it is let go. The console shell has **Back to the city** at
  its top right, which a pad's A or a tap presses. The cards let go of the mouse if the city held it (pointer lock),
  and Enter on Details opens it. Under **Details** are the raw message and
  one line (build, adapter, user agent) to copy into a bug report. Where WebGPU itself is what is missing, the card
  ends with what the city needs: a current Chrome, Edge or Brave on desktop or Android, or Safari 26.
- **What it tells whom.** An insecure address (plain http to another machine, such as `http://192.168.1.20:4173`) is
  named as the problem, not the browser. Without WebGPU, an iPhone before iOS 26 is told it needs iOS 26 (which
  runs on iPhone 11, iPhone SE (2nd generation) and newer); Safari 26 with WebGPU off is pointed at Lockdown Mode
  and the feature flag; another browser on iOS, or an app's built-in browser, is sent to Safari; Android Chrome to
  an update, an Android app's built-in browser to Chrome; Firefox to `dom.webgpu.enabled`; Chrome on Linux with no
  adapter to `chrome://gpu` and its Vulkan flags (and NixOS's `hardware.graphics.enable`). The home-screen app and
  the Windows app are never told to edit an address or switch browsers.
- **Before the onboarding.** A first visit checks the page is secure, has WebGPU and gets a full adapter before the
  onboarding starts; a browser that cannot run the city gets the card instead.
- **A slow start** is not a failure: after 20 s of visible time without a first frame the boot veil adds "Still
  starting…" with the step it is on (asking for the graphics device, building the city, starting the physics,
  preparing the shaders, which is the long step on a phone, drawing the first frame, waiting for the crowd) and
  Restart and Open the console, and the boot goes on. The page's script (about 14 MB) now stands at the end of the
  page, so on a slow connection the splash shows while it downloads instead of a blank page; after the first visit the
  installed copy opens offline.
- **Firefox and other browsers on Android** have no WebGPU: the card's first button, **Open in Chrome**, hands the
  same address to Chrome (which comes with almost every Android phone). A link tapped in another app opens in
  the phone's default browser, which may be Firefox.
- **After the start.** A lost GPU (the page's device, or the crowd's in the physics worker) halts the city with a
  graphics-reset card; lost while the page was hidden (another app, another tab, or switching away while the city
  loads, when a phone short of memory takes the GPU back), the page restarts by itself once it is shown again, at
  most once every two minutes. A physics fault and a frame loop that fails 30 frames in a row
  halt with the card too. Only a real Ring-0 audit failure shows **SYSTEM LOCKED**, now with Restart.
- **When the page's script never runs** (a download cut off, a browser too old to read it, scripts off): a small
  classic script in `index.html`'s head shows a card with Restart, adding what the city will need where the browser
  plainly lacks it (a secure address, iOS 26 on an older iPhone, in Safari or the home-screen app, WebGPU, which the
  Windows app gets from an updated WebView2; nothing of the kind under `?boot=tty`), and
  `<noscript>` says how to turn JavaScript on.
  The Files app only previews `dist/index.html` and runs no scripts: open the page's https address in Safari.

What is verified: the classifier's words against real user agents (iOS 18 and 26 Safari, iOS Chrome, in-app
browsers, Android Chrome and WebView, Firefox and Chrome on Linux, Edge on Windows, the Windows app) in
`bootFailure.test.ts`; the watchdog in a fake page in `bootWatchdog.test.ts`; and in headless Chromium
(`tools/browser/smoke.mjs fail`) WebGPU taken away, a genuinely insecure origin, no adapter, a hung boot, a cut-off
download, the page's device lost (by a wrapped `lost` promise), a realm halt and a throwing frame, each with the right
card and Restart focused, Enter restarting and a stand-in pad reaching the console. Not verified, and needing the
device: the words and settings paths on a real iPhone, the home-screen app, the Windows app's WebView2, a real driver
reset and a real pad.

## Constraints

- **Single file.** `vite-plugin-singlefile` inlines everything, and Rapier's WASM ships embedded. Do
  not add a `public/` directory. The build embeds `NOTICE.md` and every bundled package's license text
  at the end of `dist/index.html`, and fails if `package.json`'s version differs from `BRAND.version`. The
  network host (`10_Network/replication.node.ts`) is Node-only and never bundled: `tsconfig.app.json` excludes
  `src/**/*.node.ts`, `tsconfig.node.json` includes it, and `airgap.test.ts` proves no page source imports it.
- **File size.** `dist/index.html` is about 14 MB, about 3.7 MB more than before, since it carries the in-page
  model's runtime (wllama's WebAssembly build of llama.cpp, 8.8 MB, committed gzipped as
  `third_party/wllama/3.8.1/wllama.wasm.gz` and embedded as base64, about 3.2 MB, with wllama's JavaScript) beside
  the surveyed region's 3.4 MB.
  `tools/verify/page_dist.mjs` (after every build in CI) fails unless `dist/` holds exactly `index.html`, no larger
  than its budget (the measured size plus 3 %), with no `.gguf` file, naming only the reviewed hosts. The page carries
  no model and never will: a model is the operator's own file, kept in their browser. The build checks the embedded
  runtime against its pinned sha256 and against the npm package's, and the page checks it again before it runs.
- **Network.** The page sends nothing off this machine, by construction, in three layers
  (`02_Define_The_Rules/airgap.ts`). The gate: `loopbackOnly` is the one definition of "this machine" (http, https, ws
  or wss to `localhost`, `127.0.0.0/8` or `[::1]`, with no credentials), and every client (the model providers,
  speech, the room client) asks it, or an alias of it, before anything is sent. The guard: `main.tsx` calls
  `installAirgap(globalThis)` before anything else, and `physics.worker.ts` on the worker's own global; it replaces
  `fetch`, `WebSocket`, `EventSource`, `XMLHttpRequest.prototype.open` and `importScripts` with versions that refuse,
  in one sentence, any URL that is not loopback, the page's own origin or a `blob:`/`data:` URL the page made, removes
  `RTCPeerConnection`, `WebTransport` and `navigator.sendBeacon` outright, and freezes those properties, so an
  operator script or an injected one cannot put the originals back. The proof: `10_Network/airgap.test.ts` reads the
  source and fails if any runtime file names an address off this machine, or an outbound primitive outside its
  allowlist, or an allowlisted call site whose enclosing function does not go through the gate, or if either entry
  point does not install the guard first. The page opens no connection at boot and polls nothing; the Claude provider
  needs a gateway on this machine (`http://localhost:8089`); `net join` reaches a host on this machine. What the guard
  cannot close from script (loads the HTML parser and CSS make, navigation, a remote `import()`, a fresh realm from an
  iframe or a blob worker, the browser's own speech recognition) is listed in `docs/zero-trust-audit.md`. Most of it
  is closed by the Content-Security-Policy `index.html` now carries: nothing loads from or connects to any host but
  this machine, for the page and for the iframes and blob workers it could create (`connect-src` names only loopback;
  `frame-src`, `object-src`, `form-action` and `base-uri` are `'none'`). Navigation and the browser's own speech
  recognition stay open, and the audit says so. Nothing of the network reaches the physics realm. The in-page model
  asks the gate nothing, because it addresses nothing: its runtime runs in workers wllama makes from `blob:` URLs,
  where the guard is not installed, so the policy those workers inherit is what holds them, and the adapter never
  calls wllama's download paths (`airgap.test.ts` pins it; the audit has the row).
- **Integrity.** Inter-agent communication is hashed (`02_Define_The_Rules/integrity.ts`): the swarm's memory is
  a SHA-256 chain, an ask records the hash of the system prompt it sent, and every message between the page and a
  room host is sealed with an HMAC-SHA256 over its canonical body and sequence number, keyed by the session
  token; the host refuses, and counts, a frame whose seal fails or whose number does not rise (a replay), and the
  client drops one. The hashes prove what was sent and stored; they are not encryption.
- **WebAssembly.** The physics is WebAssembly (Rapier, in the physics worker). The fleet's track arithmetic is now
  WebAssembly too: `native/routing` is a dependency-free Rust crate (ring geometry, `pose_at`, `project_onto`,
  `next_stop`, `speed_limit_at` over a fixed arena) compiled to `wasm32-unknown-unknown` and committed as
  `06_Make_Decisions/routing.wasm.ts` (13 KB of WebAssembly as base64, with its SHA-256); the physics worker installs
  it at start (`routingWasm.ts`, `tracks.ts useRoutingCore`), and the TypeScript in `tracks.ts` stays as the reference
  and the fallback, proved equal by `routingWasm.test.ts`. `npm run native:wasm` rebuilds both generated modules
  reproducibly (byte for byte), and `npm run native:test` runs the Rust tests of every crate; the single-file build
  needs no Rust. The in-page model's runtime is the one WebAssembly module the repository does not build: wllama's
  own, pinned as published, and `tools/verify/wasm_airgap.py` (Python alone, so it runs where npm does not, the
  release bake included) holds its bytes to the pinned sha256 and its imports to the reviewed list, none of them named
  for a socket or a request. WebAssembly is a compilation target, not a lock: it raises the effort of reading the
  code, but anyone with the file can still disassemble it, and the TypeScript reference ships beside it.
- **Track B.** `?boot=tty` mounts the console with no engine, no WebGPU request and no worker, and `render off`
  stops drawing while the realm runs. A page-side simulation without a renderer is not attempted.
- **Content.** Civic and non-violent: the internal guideline is Canadian 14A. That is a film
  classification, so do not market the product as "14A-rated" (see `NOTICE.md`). Streets and districts
  have generic names. `02_Define_The_Rules/conduct.ts` holds the 14A conduct core every agent's prompt opens with
  and the screen every prompt, `say` line, player name and chat line passes; `collision.ts` states the physics
  side (no vehicle-on-vehicle contact, the balance machine wired with no vehicle ever a cause, no combat).
- **Geography.** The procedural city is generated: no map data, no real building, no real place's name. Its
  districts borrow only a general character (a southern-Ontario heritage main street, a Great Lakes waterfront). The
  surveyed map (in every build: `?region=on`) takes its geometry from open government data under the licences in
  `NOTICE.md`, never from share-alike sources. Its names are all fictional, and a pack in which a real one survives is refused.
  `compliance.test.ts` fails on any real place, landmark or street of the region named in the shipped source.
- **Brand names.** Control hints, labels and docs name positions and letters, not console makers or their
  button symbols. `compliance.test.ts` scans the source, the build config, the HTML shell, this README and the
  shipped notice for them, and checks that every runtime dependency (the physics worker's Rapier included) has
  its licence embedded in the build. The build itself fails if one is missing.
- **Licensing.** The game mechanics are under the ORC License; see `LICENSE` and `NOTICE.md`. The ORC
  License does not license software code. See the operator notes in `NOTICE.md` before a public
  release.

## Brand

The product is Crimson Noir: Agent City, named in one place, `src/brand.ts`: `BRAND.name` everywhere it fits, and
`BRAND.short`, "Crimson Noir", where it does not (the phone HUD, the home-screen label, the HAL handshake). The
terminal's host name and a recording's file name start `crimson-noir`.
The mark is the city's skyline from the cover art (`docs/cover.jpg`): an ink rounded square with a titanium hairline,
five towers in titanium, the tallest with a spire, and one crimson street line under them. `MonolithLogo.tsx` draws
it and `MONOLITH_SVG` in `brand.ts` carries it for the favicon and the boot splash (both keep the name of the earlier
Monolith mark); the Windows app's icons and the home-screen icons are rendered from the same shapes.
The design system is Crimson Noir (`brand/STYLE.md`): Vantablack and anodized titanium surfaces with one crimson
line, the system face, a 4pt grid. Its tokens are `brand/tokens.json`, the page reads them from
`src/brand/tokens.css` (custom properties and Tailwind utilities), the marks are in `brand/marks/`, and
`brand/preview.html` shows them; the Crimson Terminal's colours are the same tokens.
Trademark notes on the earlier candidate names are in the operator notes of `NOTICE.md`. Commission a clearance
search for Crimson Noir before you register it.

## Licensing

The product is dual-licensed (`LICENSE`): the core (`src/`, `crimson_noir_os/`, `native/`, `world/`, `brand/`, the page's
entry and build) is proprietary, copyright (c) 2026 Julian Cassius Subban, all rights reserved
(`LICENSES/LicenseRef-CrimsonNoir-Proprietary.txt`); the auxiliary tooling (`tools/`, `deploy/`, `.github/`,
`docs/`, the container build, the publish script and the Nix flake) is open source under MIT (`LICENSES/MIT.txt`); the game
mechanics are offered under the ORC License (`NOTICE.md`). Every source file opens with its licence header, and
`node tools/license/headers.mjs check` (CI's `license-headers` check) fails on a file without one.

## Browser support and what is verified

Verified in headless Brave (WebGPU, AMD GCN-5 integrated GPU, 1280×720), about 75–85 fps:
- boot, brand, console, kernel and sanctuary;
- the governor under overload;
- the HRTF audio graph (running, 7 voices);
- phone emulation (390×844, touch): tap to begin, virtual stick.

The physics worker is verified the same way: the acceptance probes pass against it, and a hostile-script probe on
the production page finds no physics object in the page and has every crafted message refused.

**The model in this page (unreleased).** What is proved, and where:
- **In Node, on every CI run:** each part has its suite. The device table (`inPagePlan.test.ts`); the browser checks
  against fake globals that lack one piece at a time (`inPageCaps.test.ts`); the header check against real GGUF bytes
  from `tools/browser/tinyGguf.mjs` (`gguf.test.ts`); keeping a file over an in-memory directory, cut short, out of
  room and visit-only (`modelStore.test.ts`); the provider over a fake runtime, from the order of its checks to the
  crash guard, the GPU retry and the unloading (`inPage.test.ts`); the adapter over a fake wllama, its watchdogs and
  the way it reads wllama's failures included (`wllamaRuntime.test.ts`); the governor's hold (`governorHold.test.ts`);
  App's wiring of the picker, the Menu, the drop and the lifecycle (`inPageWiring.test.ts`); the pin
  (`wllamaPin.test.ts`); and the air gap's structural checks on the adapter (`airgap.test.ts`).
- **On the build, in CI:** `dist/` is exactly `index.html`, within its budget, with no `.gguf` and only the reviewed
  hosts (`tools/verify/page_dist.mjs`); the pinned runtime's bytes and imports are what was reviewed
  (`tools/verify/wasm_airgap.py`).
- **In a browser, on every CI run:** the browser job runs the smoke (`tools/browser/smoke.mjs`) on the built page in
  Chrome on the software WebGPU adapter, and four of its scenarios run the real runtime with the tiny model
  `tools/browser/tinyGguf.mjs` writes. `inpage`, cross-origin isolated on two threads: the file picked at the
  console, kept and loaded with two threads and the context the model was trained on; a recruit asked and answered;
  the city's automatic tier set above the hold first, lowered to the hold while the model works and back after; a
  stop mid-answer and the next answer whole (its reason, token count and prompt hash); the file still kept after a
  reload; the crash guard (the script stands in until `ask file load`); a swarm step; and `ask gpu on`. Every request
  from the page and from every worker it started stays on the page's own origin, `blob:` or `data:`, no socket is
  opened, and a worker made from a blob is refused a fetch off this machine by the page's policy. `lite`: the file
  picked from the Menu loads on the processor with the lite profile's row, the tier lowered to Lite while it loads
  and back after. `pwa`: a file kept on the installed copy's second visit answers with the host gone. `file`: the
  page opened from disk opens no picker for `ask file`, keeps nothing, and its runtime row gives the reason.
- **Checked by hand in a headless Chromium 141** (a harness outside the repository), what the smoke does not do:
  the adapter over the real runtime, not isolated on one thread as well as isolated on two. A prompt longer than the
  context was refused and the next answer worked; a file that is not a GGUF and a truncated one failed with
  llama.cpp's reason; a context larger than the page's memory was named as such; a damaged runtime (zeros, cut short,
  or never arriving) failed instead of hanging; an unload during an answer ended the answer; a stop in the middle of
  a long prefill let the model go after 2 s, and the next answer loaded it again and answered. Asked for the GPU on
  the software adapter, it ran on the processor and said so.
- **Known:** a page opened from a file cannot run the model. wllama always starts its worker as a module worker from
  a `blob:` URL, and Chromium refuses that on a page whose origin is opaque, so the page refuses first and says to
  open the city from a server (`npm run preview`, the launcher, the Windows app or the web copy).
- **Not verified, and needing the device:** a real model (its template, thinking, speed and answers), Android Chrome
  (the Lite tier on a Mali-G52 phone, keeping a 1 GB file, the unloading in the background, the crash guard after a
  real kill, the picker and the Menu tap), a real GPU (WebGPU's speed, the frame rate under the hold, a device
  reset), the Windows app's WebView2, the NixOS launcher, a file over 2 GB, and what an iPhone's runtime row says.

**City actions (unreleased).** What is proved, and where:
- **In Node, on every CI run:** the catalogue and its parser (`actions.test.ts`: the eleven answers of the protocol,
  every verb's names and values, the clamps at both ends of every dial, the refusal hints, every sentence and done line
  through the 14A screen and the content rules, the light ranges pinned to `world.ts` by source text, the scripted
  provider's line, one facade call per verb on a recording fake); the keeper (`acts.test.ts`, one test per row of the
  state machine: a proposal only from the console's ask and only when answered, nothing run before the OK, an allow
  that runs once through the lease and notes a run, a second allow that runs nothing, refuse, `ask stop` and `operator
  lock` with their chain kinds and moments, a proposal while locked, a tether lost while it waits and one that slipped
  between the OK and the run, a facade that throws, a new serial, the gateway's refusal, the chain verifying after
  every path and failing on a replaced entry, every `step` with one follower); the wiring (`actWiring.test.ts`: the
  card mounted and the shield set from one state, the HUD line, the follow effects, the suspend expression byte for
  byte, the engine's senses, the four prompt lines in the base reality, the scripted branch, nothing of the swarm
  importing the catalogue); and the updated `operator`, `commands`, `input`, `router`, `scripted`, `taskRouter`
  and `localCompute` tests (the stripped text and the moment, `ask` and `swarm run` refused while a proposal waits, the
  withdrawals, every new console line and the `y`/`n` aliases, the shield on a pad edge and a tap with the keys live,
  the scripted provider's line and the stand-in's none, the same-mirror binding, the prompt's literal).
- **In a browser, on every CI run:** the `actions` scenario of the smoke, one boot, one tether and the scripted
  provider: the tilde key opens the console; someone who knows Design is tethered; the script proposes and the console
  shows who and what; nothing changed before the OK; Y on the card ran it once, and the clock, the HUD and the toast
  agree; the console opens again; the card decisions were printed while the console was closed; n refuses it and
  nothing changes; `ask stop` withdraws a waiting proposal; no proposal waits past a lock; `act` reads while locked and
  `act ok` does not; a lost tether ends the proposal in the gateway's words, and the trail has every proposal, decision
  and end, and verifies.
- **Mutations:** 20 bugs planted in this change's code, each caught by the named test.

For 1.4.0-beta.1 (Agent City v1.0 Stable Beta), in this environment: a Linux container with Node 22, and a
headless Chromium whose only WebGPU adapter is software.
- **The Node suites:** 1,060 tests, 1,060 pass, in 44 s; both TypeScript projects type-check and `oxlint` reports
  nothing. They include real Rapier in Node (cars through cars; the fleet on tracks for 30 s with no First- or
  Third-Law intervention and every ring gap over 1 m; four avatars under the kernel; the rally) and a real
  WebSocket host in Node (`replication.node.test.ts`, `netClient.test.ts`: tokens, frames, a kick at eight
  refusals, two clients each seeing the other's pose move).
- **Negative controls and mutations:** without the box hold, a ring at capacity made 59 box entries on red in
  480 s; with it, none. The random routing is pinned byte-identical with tracks off by a two-construction
  deep-equal test. The dissolve's identity scans are compared against a brute force over the real city for
  thousands of probes. The Claude stream parser is fuzzed byte by byte (every single cut and 300 seeded pairs of
  cuts give the same answer). `readControls` is compared against a verbatim copy of the engine's previous inline
  block over 2,000 intents, and the realm is driven with NaN, Infinity, −Infinity, 1e308 and 1e9 in every control
  field. Every crafted network message is refused with the reason the physics worker's door would give, and the
  host is attacked with bad tokens and unmasked, binary, fragmented, over-size and over-rate frames. The group
  constants are checked against Rapier's packing and the ragdoll rig's own bit, read from its source.
- **The adversarial verifier passes:** four independent passes read the whole diff against the laws, and each
  found and fixed defects, every fix with a test that fails without it: a track car steering back to its ring
  stayed in the ring's order as a phantom, so the follower behind it queued behind nothing (measured first: fed
  81.85 m to a car 40 m off the ring; `vehicles.ts #ringGaps`); a rally point inside a building lot was accepted,
  where the crowd shader would have held the recruit against the lot edge forever (`skills.ts whyNotRally`), and
  `reset` could put a car down beside a player on foot, reachable only with four avatars (`simCore.ts
  #clearOfPeople`); the dissolve's scans and flush allocated about 1,300 objects a frame (`car.ts chassisBox`,
  `dissolve.ts`, `engine.ts`); and the client's validator let a modified host carry an inadmissible player name
  onto the page (`replication.ts`).
- **Track B, headless without WebGPU:** `dist/index.html?boot=tty`, opened as a file in headless Chromium 141
  with no WebGPU flags, booted into the full-screen console in 3.7 s with no error on the page or in the console
  log. The probe counted 0 WebGPU adapter requests, 0 Workers, 0 AudioContexts, and the DOM holds 0 canvases:
  Track B builds no engine, no physics realm and no soundscape. `version`, `uname -a` and `boot status` answered;
  `r0 1 2 + .` printed 3; a recursive `fib` of 20 printed 10946 after 240,801 steps; an endless `begin … until`
  ended with `step budget exhausted (1000000)` and the machine still answered afterwards (`r0 3 4 * .` printed
  12); `render off` and `stats --once` said `engine not running`. `docs/track-b-console.png` is the screenshot.
- **The Stable Beta (tag `stable-beta`):** 1,149 tests, 1,149 pass, in 50 s; both TypeScript projects type-check and
  `oxlint` reports nothing. `dist/index.html` (10 MB, the surveyed region inside), opened from disk in headless
  Chromium with the network off and every request but the file's own aborted: the file was the only request;
  Track B booted and answered `version`; the page inflated the embedded pack itself (2,539,732 bytes, `region/1`,
  3,038 names); Track A stopped at the device loss below. The autoscaler's two profiles are in
  `docs/autoscaler/README.md`.
- **Phase 12 (the authoritative room):** 1,169 tests, 1,169 pass, in 50 s; both TypeScript projects type-check,
  `oxlint` reports nothing, and the build carries no server code (no `node:` module, no mirror).
  - `npm run smoke:net` against the server as a process of its own: a missing and a forged token were refused before
    any socket opened, an honest walk of 40 steps was kept, and five crafted illegal packets were each refused and
    corrected 0.8–5.9 ms after they left (two runs), the truth unchanged.
  - The built page in headless Chromium (Track B, opened from disk), driving its own WebSocket (the air gap's
    guard, the page's Content-Security-Policy) against the live host:
    - a forged token failed at the upgrade (Chromium: "HTTP Authentication failed");
    - an address off this machine was refused by the guard;
    - the good token opened with `onyx.3` and was welcomed at the spawn;
    - a claim 40 m along was answered by the very next message, its correction, with the truth unmoved.
- **Phase 13 (`v1.0.0-stable-release`):** 1,219 tests, 1,219 pass, in 93 s; both TypeScript projects type-check,
  `oxlint` reports nothing, and the build carries no server code.
  - `npm run smoke:net` against the server as a process of its own: a missing and a forged token were refused before
    any socket opened, the good one answered with `onyx.4`, an honest walk of 40 steps was kept (the snapshot that
    acknowledges its last step awaited), and nine crafted illegal packets (five on foot, four about cars) were each
    refused and corrected 1.0–13.5 ms after they left, the truth unchanged.
  - The parity proof (`parity.fuzz.test.ts`, seeded): two pages, each the full city with 36 cars, drove for 90 s of
    the city on a link that jittered, spiked 115 times and stalled twice, taking 44 doors and crashing into
    buildings; the room kept 9,076 steps, and the honest two drew no correction and no drift; the liar beside them
    drew 8 corrections (every one a lie) and had 4 drifts put back (all its own).
  - The second review's reproductions, run again on the release: along a terrace's shared wall for 90 s on foot and
    at the wheel, an honest page drew no correction; a reconnected page took back the car it had left; stalls of
    2, 8 and 30 s cost an honest page no refusal.
- **Not verified here: the 3D page.** Track A did not run in this environment. Chromium's software WebGPU adapter
  loses the device while the page boots (`WebGPU Device Lost: A valid external Instance reference no longer
  exists`, then `OperationError: Instance dropped in popErrorScope` on every frame; `__SIM__` never appeared), and
  the Chromium build here predates the texture-view swizzle field three r186 sends. So everything whose proof
  needs a GPU is still owed a browser run on real hardware, as the earlier releases had in headless Brave: the
  compiled dissolve shader (walk through a lamp, `output.dissolve.active > 0`, no `[RING-0]` and no uncaptured
  error), the look word on the GPU (`lookFromSeed(0)` against agent 0's hashed look), the convolver swap, the
  caption strip in both layouts, `render off`'s black canvas and chip, the ping chip and rings, four viewports and
  the scissor origin, the ghosts of a room joined from two tabs, and the in-page traffic-lights and spatial
  harnesses with tracks on. Also not made here: a real call to the Claude API (a fake server stood in), and a
  real speech server.

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
  latency is noted under The model providers.

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

Not verified: a real open-weights speech server (a mock with the same wire format stood in), a real call to the
Claude API (a fake server stood in), a room joined from a browser, physical phones, a physical DualSense, and HAL/1
devices.

## Formal verification, self-healing CI and telemetry (Phase 18)

**The formal verification step (FVPS).** `sh tools/verify/fvps.sh` (`npm run verify` on a machine without a POSIX
shell: tools/verify/fvps.mjs runs the same four parts, leaving Kani out on Windows and saying so) runs before every release bake
(`build-release.yml` refuses to bake a commit whose proofs fail) and in `ci.yml` on every pull request and push to
`main`: the `fvps` job runs the theorems, the IR scan and the air gap in minutes, and the `kani` matrix runs the
proof harnesses in six groups on parallel runners (the longest harness takes about ten minutes; the `rust` and
`page` jobs run the tests, clippy, tsc, oxlint, the build and the air-gap check alongside). It has four parts, each
honest about what it proves:
- **Kani (CBMC, bit-precise model checking)** over harnesses compiled only under `cfg(kani)`:
  `crimson_noir_os/crates/noir_core/src/verify.rs` lays a symbolic Global Matrix of the smallest validated
  dimensions (64 agents, an 8-word memory block, 2 stations, every kernel knob symbolic; a 32×32 floor for the
  flush, 8×8 for the tick and the relaxation, which read the floor at symbolic cells) and proves
  that one agent's tick writes only its own row, its own weights and its own memory block, keeps its position on the
  floor and its masks at 0 or 1, that the flush zeroes one row only, that a relaxation pass and a bitonic pass never
  index outside their arrays, and that the branchless masks mean what the kernels take them to mean;
  `native/routing/src/verify.rs` lays a symbolic arena (every word any f64, NaN and infinities included) and proves
  the WebAssembly routing core never traps: the arena setter and `routing_check` on any arena, the pose, the piece
  search, the next stop, the speed limit and the projection on one- and two-piece tracks with up to two stops, every
  index they compute in bounds. The transcendental functions, the Bézier point, the offsets, the fold, the piece
  evaluation and the Newton refinement are abstracted to "any f64" (sound: their results never become an index;
  their values are held bit for bit by the parity tests, not proved here), and the routing harnesses run without
  the checker's floating-point checks (a NaN is a value the module returns for a NaN input, not a trap; bounds,
  pointers, integer overflow and assertions stay checked). The sizes are small because the checker unrolls every
  loop and its memory grows with the arrays (the tick and the relaxation pass are proved on an 8×8 floor; the
  projection's track has its piece and stop counts written in rather than assumed, so the scan is unrolled once; the
  theorems cover every validated floor). A standard runner of a private repository has 7 GB, and the first run on
  main found the tick at 32×32 and the projection with assumed counts both outgrow it.
- **Z3 theorems** (`tools/verify/fvps_smt.py`) over 32-bit words and IEEE doubles, for every validated dimension:
  memory-slot isolation between agents, no 32-bit wrap in the index arithmetic, every field read in bounds, the goal
  mask, the stepped cell on the floor, the weight index, the relaxation neighbours, the bitonic comparators, the
  `nz`/`sel` lemmas, the loop breaker's signature, the piece evaluation's look-up index in 0..31 under JavaScript's
  min/max semantics, the arena setter's range. Every theorem has a vacuity check.
- **The WebAssembly air gap** (`tools/verify/wasm_airgap.py`): both modules the page carries import nothing, own
  exactly one memory, have no start function, export no table, and export exactly the functions the host binds; with
  a wasm32 toolchain present both crates are rebuilt and must give the committed bytes. (This check's first run in
  CI found that the committed page-table module carried the absolute path of the checkout that built it, through a
  panic location in its path dependency, so no other machine could reproduce it; both builds now map the checkout
  to a fixed prefix, and the module was regenerated.)
- **The LLVM IR call graph**: the routing core's IR, emitted from the compilation that makes the module, may declare
  nothing external but LLVM intrinsics, the four libm functions and core's panic entry points (every one a trap the
  harnesses prove unreachable).

What it does not prove: floating-point values (parity tests hold them bit for bit), `fmod` (no exact SMT model), and
dimensions larger than the harnesses fix (the theorems cover every validated dimension; the harnesses the
smallest). `/Brepro` (`crimson_noir_os/.cargo/config.toml`) is the lld-link flag the UEFI target uses so the PE
header's timestamp is a hash of the output, not the build time; two clean bakes of one commit give the same bytes
(the workflow bakes twice and compares; verified here, SHA-256 equal).

**The self-healing pipeline.** `selfheal.yml` runs when `ci.yml` or `build-release.yml` ends in failure and runs
`tools/selfheal/agent.mjs` on the failed commit: the agent re-runs the failed checks in a fresh container
(`Dockerfile.sandbox`; air-gapped, nothing of the host mounted, an unprivileged user with no capability, a
`noexec` workspace, no secret in its environment; `docs/zero-trust-sandbox.md`, verified from the inside by
`ci.yml`'s `sandbox` job) to isolate the failure, parses it (`node --test`, `cargo test`, `tsc`, `oxlint`,
Kani) and maps each failure to the declaration it points at in the syntax tree (the TypeScript compiler API for
`.ts`, brace matching for `.rs`), asks its planner for a structural patch of those declarations only (the built-in
remedies first: a stale committed module regenerated, a stale seal re-pinned; then Claude through the Anthropic API
when `ANTHROPIC_API_KEY` is set, at most three model calls), applies it to a copy, re-runs the failed checks and
then every check in a fresh container, and stops after three attempts or sooner when an attempt changes nothing
(the loop dampening). When every check passes it pushes a `selfheal-<run>-<sha7>` branch and opens a pull request
that documents the failure, the map, every attempt and the diff, and dispatches `ci.yml` on it. It never merges:
the workflow has no permission to, and the pull request waits for a review like any other. The repository setting
"Allow GitHub Actions to create and approve pull requests" must be on for the pull request; without it the branch
is pushed and the log says so.

**IIoT telemetry (SIPOC).** `10_Network/telemetry.ts` is the edge-fog-cloud pipeline: an edge node (an actor over
the WebAssembly routing core, or any sensor; the Supplier) frames its readings as eight 32-bit words numbered per
node without gaps (Input); the Process stage digests a frame with FNV-1a finished by the swarm's `mix32`, run at the
edge and again at the fog as the WGSL compute shader `crimson_noir_os/shaders/telemetry.wgsl` (one invocation per
frame, no branch, no float; `telemetry.rs` is its reference and `gpu::digests` runs it, held equal to the CPU on
every frame drawn); the cloud's ledger admits a frame only when the fog's digest equals the edge's own, only in
sequence order, once each, and chains it with SHA-256 per node (Output) for whoever reads it (Customer). Delivery is
at least once: the edge keeps every frame until acknowledged and re-sends; the acknowledgement carries the head the
cloud reached, which the edge compares with its own fold. `telemetry.fuzz.test.ts` drives 64 edge actors, one per
car ring, through a link with up to 200 ticks of latency, reordering, duplication and drops in both directions, and
a fog whose cache serves the wrong digest (the previous frame's line, a flipped bit, a stale word) for up to a third
of the frames: the ledger ends equal, entry for entry and hash for hash, to the clean run's, re-verifies from genesis,
has refused every desynchronised digest and chained none, and every edge's fold agrees with the cloud's. Both twins
pin the same vectors (`VECTORS`, `VECTORS_CHAIN`).

## History

**1.4.0 (Agent City v1.0.0 Stable Release)**: the operator's Phase 13 directive, zero-defect fleet reconciliation
and formal verification. The architecture is `docs/agent-city-v1-beta-blueprint.md` (Phase 13); the networking is
described in Networking above.
- **Phase 13.1, the vehicle teleport exploit closed:** the room replays cars. Its garage (`10_Network/garage.node.ts`)
  knows the fleet's own plan from the seed and replays every player's car with the page's own car physics, shared in
  `07_Execute_Actions/carRig.ts`, to the bit. Every door is checked against the room's own numbers: a car this player
  left within 0.5 m of where the room holds it, an exit within 0.5 m of the point the room computes from its own
  chassis, any other car within the realm's door, on its own ring's lane, facing along it, at its ring's speed or
  under. The 0-substep foot/drive switch that moved a player 16.5 m a pair (the critical finding of the Phase 12
  review) is gone: a mode without its door is refused, a door carries a player at most about 6 m, and the room
  takes two a second. **What the directive asked and what is true:** it asked the server to compute every car's
  coordinate from the Phase 7.3 schedule on the realm clock. An AI car's position is not a schedule: it is a Rapier
  body that stops at signals and brakes for the pedestrians of each page's own GPU crowd (the First Law), so every
  page's traffic is its own and no server can compute it. Only the trains, drones and planes are timetabled. The
  0.5 m check therefore applies to the cars the room holds and to every exit; an AI car the room does not hold is
  checked against its ring's lane within the fleet's measured envelope (1.0 m) and the 3.8 m door.
- **Phase 13.1, room mode:** while joined, player 1 walks and drives in the page's realm as the room does (a ghost
  only fixed geometry stops, the authored tuning, car-moving commands refused, a car left stops dead), so the page
  and the room agree to the bit and the room's tolerance is a micrometre. A correction at the wheel carries the
  car's full state, and both sides build the car again from those numbers.
- **Phase 13.2, property-based fuzzing and the parity proof:** a seeded, replayable harness
  (`02_Define_The_Rules/property.ts`) and suites on the protocol core, the host over real sockets, the Three Laws
  and the Ring-0 auditor, the shared car rules, the WebAssembly routing core and kv-pager; and the proof
  (`parity.fuzz.test.ts`) that two drivers on a network that jitters, spikes and stalls, taking doors and crashing
  into buildings beside a liar, are never a micrometre from the room's replay and end at its pose to the bit. See
  Networking, Fuzzing and the parity proof.
- **Phase 13.3, fixes found on the way** (the Phase 12 review's 47 findings, the fuzzing, and a fresh review of
  Phase 13 itself):
  - a door now checks the whole state the room adopts, not only where the car is: the review took a car the room
    held at rest back at 36 m/s (30 of them upward), and claimed an AI car at its ring's speed but moving upward, and
    the room's own replay landed each on a roof;
  - the host survives a reset after a refused upgrade (it crashed); refused upgrades are ended, a slow-header client
    is dropped, pings are metered and every write checks the backlog; a short secret starts no host; one connection
    per player; a session ends with its token; logged text is escaped;
  - drive inputs now spend the substep budget (they spent none); the budgets ride out a 3 s stall and refill 5 %
    faster than the realm steps, so a stall's bank comes back; inputs under an old correction no longer count
    against the input rate; a quiet page sends a keepalive;
  - the First Law fails toward the person on a reading that is not a number; the speed clamp leaves a non-finite
    velocity to the audit instead of making it a NaN; the validators are total and freeze everything they return;
  - every fresh Rapier world is stepped once at build, so a page's first substep finds the ground as the server's
    does; the engine reports the velocity the realm applies and resets its correction on a new session; `net
    status` counts as dropped only what the room could not keep; the room is joined only at the hosts the page's
    content security policy reaches.
- **Phase 13.4, a second review** (three reviewers: the protocol and host, the page driven against the real host, the
  documents against the code; every finding reproduced before it was fixed, every fix with a test that fails without
  it):
  - an honest player was removed for hugging the shared wall of a terrace's lots, on foot or at the wheel, where the
    page and the room part by micrometres: a drift within the room's bound is now kept as replayed and put back,
    uncounted (above, **Drift**);
  - an honest page was removed after one stall of 6.5 s, or eight short ones in a session: it now keeps at most 150
    inputs unacknowledged, and refusals are an allowance that comes back at four a minute;
  - the 14A screen now reads a line as it renders (invisible characters and look-alike letters hid a word), and names
    and chat may hold no control character, separator or bidi control; the log escapes C1 controls, DEL and the line
    separators, at most 160 characters;
  - a reconnected page could not take back a car it had left: every car the room does not hold goes back onto its
    ring's lane as traffic; an E pressed while a correction was in flight was reported as a door out of a car the room
    never had: corrections go ahead of the player's commands; a refused re-entry into a held car lets the room's hold
    go; at the wheel a replay the Ring-0 audit refuses is undone;
  - hopping between cars beat a run at two doors a second: the room takes 1.75;
  - `pending()` kept the acknowledged inputs after a correction; seven tests checked less than their names said, and
    the smoke test's honest walk passed only if a snapshot landed in a 200 ms window; three source files had no
    header (a test now holds every one to it).
- **Version:** 1.0.0-stable-beta (`package.json`, `brand.ts`, `src-tauri/Cargo.toml`; set from 1.4.0 by the Phase 2 directive, so it sorts below the earlier numbers; the OS crate and its sealed containment stay at 0.9.0), tagged `v1.0.0-stable-beta` and listed in `CHANGELOG.md`; before it the release tag was `v1.1.0-stable-release` (Phase 19, baked from main with the proofs; the first under the proprietary licence); `v1.0.1-stable-release` and `v1.0.0-stable-release` are the earlier ones.

**1.4.0-beta.1 (Agent City v1.0 Stable Beta)**: the operator's directive for Phases 7 to 10. The architecture
behind it, item by item with the tests that prove each, is `docs/agent-city-v1-beta-blueprint.md`.
- **Phase 7.1, cars pass through cars:** the contact policy (`collision.ts`) and the collision groups; the ragdoll
  scaffold stays disabled by policy.
- **Phase 7.2, the code dissolve:** what you pass through dissolves into falling green binary code and
  reinstantiates when you are clear; two cars passing through each other both dissolve.
- **Phase 7.3, the fixed track network:** 64 right-turn rings, the track follower, the zero-jam invariants, the
  timetabled trains, drones and planes with their pose stream and the Ring-0 craft check. On by default;
  `?tracks=0`. The craft are drawn by `craftView.ts`, and the VTOL routes came after (see Vehicles).
- **Phase 8.1, room acoustics:** rooms, Sabine reverberation, wall loss, eavesdropping, rendered impulses; peer
  voices placed (the signalling is a stub).
- **Phase 8.2, the 14A conduct core and screen** (`conduct.ts`), on every prompt, `say` line, player name and
  chat line.
- **Phase 8.3, the cognition router:** `claude` over the network, `ollama` and `llamacpp` on this machine;
  `ask provider|key|effort`.
- **Phase 8.4, pings and captions:** the ping on `Q`, the board, the rally (an Active recruit sent to a sidewalk
  point the worker validates), and closed captions for every sound.
- **Phase 9.1, the character customizer:** the closed wardrobe, the look word, codes and presets, the card from
  Wren's chip, `look`. Later: the smooth skinned body (`humanoid.ts`, `crowdBody.ts`), the eight body sliders in
  a second word, fifteen-symbol codes, the card's silhouette.
- **Phase 9.2, the bootloader:** R0, the console's stack machine; `render off`; `?boot=tty` and `boot`.
- **Phase 10.1, split screen:** up to four local players, each an avatar under the kernel with a head and a
  soundscape of their own.
- **Phase 10.2, networking:** the opt-in client-server replication scaffold, poses only, griefing-resistant and
  screened under 14A; `net join`.
- **Phase 11.1, zero-trust containment:** the operator's order "ensure all API routing is mathematically locked to
  localhost; sever any arbitrary outbound fetch capabilities". `02_Define_The_Rules/airgap.ts` is the one gate
  (`loopbackOnly`, with `loopbackServer` and `netServer` as its aliases) and the guard (`installAirgap`, called
  first in `main.tsx` and `physics.worker.ts`); the Claude provider speaks only to a gateway on this machine
  (`http://localhost:8089` by default); `net join` is loopback-only; `10_Network/airgap.test.ts` allowlists every
  outbound call site; `docs/zero-trust-audit.md` is the audit, with what stays open.
- **Phase 11.1(c), WebAssembly:** the track arithmetic compiled from Rust (`native/routing`) and installed in the
  physics worker, with the TypeScript kept as the reference and proved equal; `npm run native:wasm`,
  `npm run native:test`. See Constraints, WebAssembly.
- **Phase 11.1(d), integrity:** a dependency-free SHA-256 and HMAC (`integrity.ts`); the swarm's memory
  hash-chained; an ask's system prompt hashed into its episode; every replication frame sealed and replays refused.
- **Phase 11.1, the Content-Security-Policy** in `index.html`, closing most of what the guard alone could not.
- **Phase 11.2, what the swarm learns:** the weight ledger in `memory.ts`, folded from outcomes over the verified
  chain, stored and checked against a replay, reaching a prompt only as three fixed, screened sentences (see The
  swarm's memory).
- **Phase 11.3(c), the prefix cache:** kv-pager's page table as WebAssembly behind the cognition router, its counts
  on `ask`'s `cache` line.
- **Phase 11.3(a), the surveyed map pipeline: not run.** `tools/world/fetch.mjs` and `odb.py` need the provincial
  road and water services and the national building database, and this environment's network policy refuses all
  three hosts. The shipped pilot pack (`world/pilot.region.json.gz`) is unchanged and still passes
  `pilotPack.test.ts`; running `fetch.mjs`, `odb.py` and `compile.mjs` on a machine that can reach those hosts
  rebuilds it (see The surveyed map).
- **Phase 11.3(b), the balance machine wired:** the Phase 7.1 policy that kept the ragdoll scaffold unwired is
  reversed; pedestrians near the operator may be promoted to a Rapier rig by a shove, a kerb trip or a slip, every
  shape a Sanctuary ward and an audit person, the rig stream drawn in the hidden figure's place; a vehicle is never a
  cause, and nobody is ever harmed. `?ragdoll=0` (see The balance machine under The ethical kernel).
- **Stable Beta, the rulings:** surface trams are ruled out (`collision.ts COLLISION.surfaceRail`: every train rides
  the elevated deck, the Ring-0 craft floor); recruiting, rallying and dismissing are player 1's alone
  (`skills.ts RECRUITING_PLAYER`; the realm refuses another player's, the page drops other seats' pings); the Claude
  key belongs in the gateway on this machine, the page sending none when it holds none (`docs/zero-trust-audit.md`,
  The API key).
- **Stable Beta, the map offline:** every build carries the surveyed region, `dist/index.html` included (10 MB), so
  the one file plays it from a disk or a stick with no network; `?region=on` walks it (see The surveyed map). Booted
  headless from disk with the network off: the file was the only request. `fetch.mjs` and `odb.py` were run again
  and the network policy still refuses their hosts, so the pack is the one compiled before.
- **Stable Beta, the autoscaler at both ends:** a flagship phone and a console-class desktop, simulated through the
  governor on synthetic frames (`docs/autoscaler/`). They found four defects, all fixed in `governor.ts`: a named
  RDNA2 card started on High; a run of sub-second hitches under the cinema camera stepped the tier down; a step under
  `?fps` was labelled "frames below 60 FPS"; and the camera floor's wording (two frames missed in each half second,
  not one).
- **Phase 12.1, the WebSocket host:** no connection without a token. The HMAC and expiry are checked at the upgrade
  (401 before any socket exists, 429 for an address that keeps failing), the join is bound to that token, and seals
  use `node:crypto`. A slow reader is closed rather than buffered, and the host reports its own costs. The frames
  are protocol 3: a client's frame up to 4 KB, a host's up to 16 KB, others' poses in millimetres. Fixed on the way:
  a client that dropped its connection without a close frame held its room slot until the idle timeout (`node:http`
  keeps sockets half-open); it is now let go at once.
- **Phase 12.2, the headless Ring-0 mirror** (`10_Network/mirror.node.ts`): the city of the seed in Rapier on the
  server, the realm's own character controller per player, the Ring-0 person audit on every pose kept. The page's
  realm and the mirror agree within a micrometre for the same inputs. The order asked for "the Phase 11
  WASM-compiled Rust physics kernel"; the physics kernel is Rapier, Rust compiled to WebAssembly, which is what the
  server runs. Phase 11's own Rust modules (the track arithmetic and kv-pager) are not physics, and the mirror,
  which holds no fleet, does not load them.
- **Phase 12.3, prediction and snap reconciliation:** the page's own realm predicts, and every step it runs is
  reported with the pose it reached. The server keeps an honest claim. Any other it refuses: the packet changes
  nothing, and the page is snapped to the truth by one teleport (`authority.node.test.ts` runs the page's realm, its
  client and the host end to end). At the wheel the server bounds the claim (the velocity cap, the buildings, the
  door), since the car is the page's own. `npm run smoke:net` attacks the server as it ships, a process of its own,
  with five crafted illegal packets: each is refused and corrected within a few milliseconds (0.8–5.9 ms over two
  runs), and the truth never moves.
- **The console:** every new knob and command on the Ring-0 terminal; `history` redacts keys and tokens.
- **The surveyed map (pilot)**, listed as unreleased in 1.3.0's README, ships in this release as
  `npm run build:pilot` (see The surveyed map): `tools/world/` compiles regions, a guard test checks the shipped
  pack's names, the physics worker builds a region and streams its walls, the Ring-0 audit takes a region's slab,
  the minimap takes a region's layer, and an empty fleet no longer leaves WebGPU a zero-sized binding.
- **Rulings:**
  - **The air gap, for the Claude provider only.** The operator's Phase 8.3 order reverses the 1.3.0 ruling
    ("keep the air gap: any server that speaks either format can answer, as long as it is on this machine") for
    one client and nothing else: `claudeApi.ts` may address the Claude API over https, only when the operator has
    chosen the provider and typed `ask`, with a key kept in this browser and never in the page, and nothing
    polled in the background. The local providers, speech and recruitment's model download are as they were.
    Phase 10.2 adds the second and last opt-in client, `netClient.ts`; `airgap.test.ts` names exactly those two.
  - **The air gap, for everything (Phase 11.1).** The operator's later order supersedes the ruling above: the
    Claude provider and `net join` are held to loopback like every other client, the page's own outbound
    primitives are guarded and frozen at boot, and no source may name an address off this machine. The 1.3.0
    ruling is back in force, for every client, with a proof installed on the global rather than a convention.
  - **Zero jams** is an AI-only, per-ring guarantee with containment, not a promise about the player (see
    Vehicles).
  - **Recruitment can now point** an Active recruit at a sidewalk spot the worker validates; it still only asks.
  - **Trains are elevated**, so no train is a vehicle to the audit or the Bouncer. "Completely override" is a
    render guard and a bare boot, not a second renderer. Four listeners are one shared context in head space.
    Remote players are poses, never bodies. "Packaged" models are not packaged with the product: no model ships,
    as before.
- **Fixes:** the phantom in a ring's order, the rally into a building lot, the reset beside a person on foot, the
  per-frame allocation in the dissolve, the unscreened player list from a host (see Browser support and what is
  verified), and a refused `say` line that was still written into memory (Phase 11).
- **Version:** the package version is 1.4.0-beta.1 (`package.json`, `brand.ts`); "v1.0" is the product's name
  for the beta, not the package version, because a downgrade would break ordering.

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
