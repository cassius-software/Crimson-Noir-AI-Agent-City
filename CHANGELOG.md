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
  names the step the boot is on. The page's 10 MB script moved to the end of the page, so a slow connection shows the
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
  worker in Safari, and heat and memory over a long session. On a phone there is no model provider (they run on a
  computer's loopback), so Sloane speaks from her script.
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
  "At work indoors" and the rooms on the minimap; the console's `sim` line ends `at work N`. The Lakefront Metro map
  has no rooms yet (`map city` shows them). Unverified from the cloud (no GPU): the rooms and the workday on screen;
  `naga` validates both shader variants, and the containment, the routes and the workday's legs are tested in Node
  on a mirror of the shader's step (500 walkers over 5,000 steps, none through a wall or a piece of furniture).

### Changed

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
