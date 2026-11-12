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

- **Bare legs and tattoos on the calf and the ankle.** The look genome's cloth word gains the legs (word 5, bits 18
  and 19: as hashed, as before; bare; sheer; opaque) and the second tattoo word a design (0 for none, or one of
  sixty-four) on the left calf and the right ankle at seven bits each (word 8, bits 14 to 27; bits 28 to 31 spare and
  refused). Option 0 of each is as before, so every earlier look keeps its code. The legs are a veil over the skin
  (`src/03_Spawn_Agents/crowd.ts` `veil`): as hashed, the old link (about one in two in dark hose or a dark sock);
  bare, none; sheer, the skin 35% of the way to the hose's dark (`look.ts` `LEGWEAR_VEIL`); opaque, all of it. It sets
  the skirt suit's hose and the sock or the bare ankle below cropped trousers and culottes, on the near and the far
  body alike. Where a leg shows bare or sheer the skin's slot goes to the ink (`inkSlot`), so the calf and the ankle
  take their designs there, dimmed under sheer legs as the colour is, never on a prosthetic shin, under a boot's shaft
  or under the culottes' inside band. A skirt-suit passer-by whose drawn designs reach the calf or the ankle goes
  bare-legged, in the shader (`crowdTattoo.ts` `tatZones` against `tattoo.ts` `TATTOO_LEG_ZONES`) and in
  `lookFromSeed` alike: `tattoo.test.ts` finds the two agree on all of 20,000 seeds, 132 of them bare-legged. The card
  shows all eight tattoo zones and a Legs row (for the skirt suit and below cropped trousers and culottes; full-length
  trousers hide the legs), and its outline's skirt-suit legs follow the choice; a zone's note says what covers it
  ("the trousers cover it", "the boots cover it", "opaque legs cover it", "covered by the limb"). The console takes
  `look legwear bare` and `look tattooAnkleR anchor`. The shader budget holds: the worst near main fragment stage is
  183,846 characters (was 185,605) and the worst far one 142,706 (was 142,122). `dist/index.html` grows by 1,971
  bytes, from 12,004,143 to 12,006,114; the limit in `tools/verify/page_dist.mjs` is unchanged. Fifteen pictures of the
  ink studio's mirror on the software WebGPU adapter (SwiftShader) show the calf's design on bare legs, dimmed under
  sheer legs and hidden under opaque ones and under the hash's dark hose, white ink on the deepest skin, gold leaf, the
  bare ankle below cropped trousers, full-length trousers and boots covering the designs, a prosthetic left leg taking
  the calf, and option 0 as before. The mirror draws the player's body with its left leg only, as it already did on
  main, so the right ankle's design is not pictured. Unverified: no hardware GPU has compiled or drawn it yet.
- **Rolled sleeves and tattoos on the forearms.** The look genome's cloth word gains the sleeves (word 5, bits 16 and
  17: full, as before, or rolled) and word 8 becomes the second tattoo word: a design (0 for none, or one of
  sixty-four) on the left and the right forearm at seven bits each, its other bits spare and refused. Option 0 of each
  is as before, so every earlier look keeps its code; a look with a forearm's design has a sixty-two symbol code.
  Rolled sleeves are paint over the sleeve's own geometry (`src/03_Spawn_Agents/crowd.ts`): below the roll line (1.10
  m standing, the forearm's top ring, `tattoo.ts` `TATTOO_SLEEVE`) the top's fragments on an arm take the skin's slot
  for the colour, the skin's marks, the tattoos, a prosthetic arm's finish and the skin's roughness, and above it a
  2 cm band of the sleeve's cloth reads as turned back under a fold line. A coat keeps its sleeves down. The near and
  the far body both draw the rolled sleeves, so a person's arms do not change as they come close; only the near body
  inks them, reading a chosen look's word 8 from `crowd.figure` (no varying is added). A passer-by whose drawn designs
  reach a forearm rolls their sleeves unless they wear a coat, in the shader (`crowdTattoo.ts` `tatZones` against the
  forearms' zones) and in `lookFromSeed` alike: `tattoo.test.ts` finds the two agree on all of 20,000 seeds, 1,274 of
  them rolled. The card shows six tattoo zones and a Sleeves row (not under a coat); the console takes `look sleeves
  rolled` and `look tattooForearm circuit trace`. The ink studio's twelve designs (lines 48 to 59) go on sale, each
  wearing its design on the left forearm with the sleeves rolled, so what is bought is what the mirror showed; a
  design the look would hide says so on its row ("A coat keeps its sleeves down", "Covered by the limb";
  `storeCatalog.ts` `coverHint`). The shader budget holds: the worst near main fragment stage is 185,605 characters
  (was 183,728) and the worst far one 142,122 (was 139,888). `dist/index.html` grows by 1,991 bytes, from 12,000,653 to
  12,002,644; the limit in `tools/verify/page_dist.mjs` is unchanged. Eighteen pictures of the ink studio's mirror on
  the software WebGPU adapter (SwiftShader) show the rolled sleeves in a jacket and in shirt sleeves, four inks on the
  forearms, the halo on the deepest skin, sleeves down and a coat hiding the designs, a prosthetic left arm taking its
  bared forearm, and vitiligo going on up the bared skin. Five more, taken by pressing the studio card's own buttons,
  show the twelve designs on sale, the coat's hint on every row, and Try on rolling the sleeves for the mirror.
  Unverified: no hardware GPU has compiled or drawn it yet.

- **Tattoos on the hands, the neck and the nape, in eight inks.** The look genome's word 7 becomes the tattoo word
  (`src/03_Spawn_Agents/look.ts` LOOK_FIELD): a design (0 for none, or one of sixty-four) on the left hand, the right
  hand, the neck and the nape at seven bits each, and one ink at three; bit 31 is the shader's street flag, which no
  look may set. Option 0 of each is as before, so every preset, every bare look and every untattooed hashed look keeps
  its code, and a stored record without the five keys still validates. The designs (eight families of eight:
  flowers, stars and rays, circles and orbits, shapes, bands, spirals, sprigs, pictures) and the inks (black, indigo,
  white, gold leaf, luminescent, brick red, forest green, grey wash) are plain tables (`tattoo.ts`), and the near
  body's fragment stage draws them as signed-distance drawings from the skin's rest position (`crowdTattoo.ts`,
  12,801 characters of WGSL written from those tables): no texture, sampler, uniform or varying is added, only the
  skin is inked, and the far body, the vertex stages and the shadow pass draw none. Gold leaf adds a metal's sheen and
  luminescent a faint glow. Every ink keeps 3:1 against the skin under it (WCAG 1.4.11): where the line would fall
  short, a halo just outside it takes the skin toward a warm white or a brown-black until it does. `tattoo.test.ts`
  runs the shipped WGSL through the WGSL host (`wgslHost.ts`): for the eight inks on 81 skins (ten Monk tones, four
  undertones, two ages and the vitiligo pale) no ratio is under 2.9999989 (3 in f32); each design covers 5.5% to
  46.8% of its square and no two overlap by more than 0.582 (soft masks at 32 pixels). One passer-by in five carries a
  tattoo, drawn in the shader from colour links 44 to 48, never one of the ink studio's twelve designs or its two
  inks: over 20,000 seeds the test finds carriers within 0.20 ± 0.005 and those shown on a hand, the neck or the nape
  within 0.1005 ± 0.005, and the CPU mirror `lookFromSeed` uses (`streetTattoos`) agrees with the shader on every zone
  of all 20,000. The card gains a Tattoos section in place of the slots' own rows (zone, design family, design and
  ink, all button radiogroups that switch scanning and dwell can press, and a note on a zone a prosthetic arm, the cup
  or a turtleneck covers), and the console `look tattooHand compass rose`, `look tattooHand 10`, `look tattooNape
  none` and `look tattooInk gold leaf`, with Tab completing the names (`commands.test.ts` pins the lists to the
  wardrobe's). A tattooed look's code is fifty-six symbols. The ink studio's gold-leaf and luminescent inks (lines 64
  and 65) go on sale; trying one on a look with no design showing borrows the olive branch for the mirror alone,
  on the left hand or the first zone nothing covers, and buying sets the ink alone (`storeCatalog.ts` `previewItem`); the studio's mirror circles at 1.4 m
  instead of 2.6 m (`storefronts.ts` `SHOP_ORBIT`, inside the shop's clear circle); four of its forearm lines are
  renamed for what they draw (Braided rope band, Scalloped arc band, Compass rose, Euler's identity circle; their ids
  and bits are unchanged), and all twelve stay on order until the forearm has its slot. The shader budget holds
  (`SHADOW_SHADERS_REPORT=1`, `shadowShaders.test.ts`): the worst near main fragment stage, the suit's, is 183,728
  characters (the pantsuit's 183,551), under the 225,000 target the test now asserts for every near body; the far
  fragments (at most 139,888), the vertex stages (at most 54,921) and the shadow fragment (1,101) are as after the
  hash change below. `dist/index.html` grows by 31,595 bytes, from 11,969,058 to 12,000,653; the limit in
  `tools/verify/page_dist.mjs` is unchanged. In the browser on the software WebGPU adapter (SwiftShader), Chrome's WGSL
  compiler builds the tattoo code (the desktop smoke passes), and pictures of the ink studio's mirror show the designs
  on both hands, the neck and the nape, the eight inks, the halo on the lightest and deepest skins, and the cover by a
  prosthetic arm, a turtleneck and a full beard. Unverified: no hardware GPU has compiled or drawn it yet.
- **Sky floors.** In the city, the Crimson Tower Penthouse and the Crown Spire Sky-Mansion each have a floor up their
  tower: a 15.6 m square room with clear glass on four sides (seed 1337: 193.8 m and 228.0 m up). The home's card
  offers Go up inside the home and Go down upstairs, by keyboard, mouse, pad or touch. Visitors may ride, and only the
  owner furnishes. The floor is furnished like the home below, with its own pieces, caps, floor finish, Rest and Staff,
  and a staged floor while the deed is not yours. It is saved in this browser under `civic-simulation:home-sky:v1`,
  with the home record unchanged. A post upstairs saves the staff record as version 2, which an older build shows no
  posts from and never overwrites. The ride waits outside a network room, whose replay would put you back. There are
  no sky floors in Lakefront Metro. The physics worker and the network room build the floor from the same city boxes.
  Covered by unit tests and the `homes` smoke scenario, whose headless browser run is CI's.
- **Staff at home.** The furnishing view's fifth tab, Staff, posts your own agents (the roster's names) at the agent
  workstations standing in a home you own. Each stands at the workstation's seat facing its screen, in their body
  and their top's colour, at their height, in every visit until stood down, and steps away while hired (their disc
  on the plan fades). The tab shows each agent with where they are posted, and lists the home's workstations in
  reading order with who stands at each (a tap on a row moves the cursor there, a second posts); a post that moves an
  agent from another workstation or home says from where. They are drawn by the page alone: no collider, never in the
  crowd or the physics realm, nothing in a network room. Nothing is earned and no work is done. Saved in this browser
  under `civic-simulation:staff:v1`; a rename keeps the post, a forget lets it go, and a record a newer build wrote is
  never overwritten. `engine.homeSeats` lists each owned home's workstations, read-only: kind, name, the home's
  doorstep, the standing point and who is posted, the same array until one of those changes. Covered by unit tests
  and the `rest` smoke scenario, whose headless browser run is CI's.
- **Rest at home.** The furnishing view gains a Rest tab: a hero point, a new round, and an item bonus on the next 30
  checks, +1 from a level 3 deed, +2 from 9, +3 from 17, capped by the kinds of furniture standing there (1, 3, 5).
  Kept in progression record word 40 with no layout change; refused in a network room with furnishing; the chip,
  `progress` and each check line say when it applies.
- **Shoe styles, frames, a watch and a lapel pin.** The look genome's word 6 becomes the accessory word
  (`src/03_Spawn_Agents/look.ts` LOOK_FIELD, bits 0 to 14; bits 15 and up are spare and refused): a shoe style
  (twelve: plain, lace-up, cap toe, wingtip, loafer, buckle strap, two-tone, sneaker, flat, ankle boot, lace-up boot,
  knee boot), the glasses' frames (eight finishes, black first), a watch (none, steel three-hand, tourbillon
  chronograph, leather strap, smartwatch) and a lapel pin (none, rank pin, silver bar, buttonhole flower). Option 0 of
  each is as before: every preset, every bare look and every hashed look without them packs word 6 to zero and keeps
  its code, and a stored record without the four keys still validates. All four are fragment paint on meshes the
  crowd already draws (`crowd.ts` `footwearPaint`, a boot's shaft up the bare leg, the watch on the left wrist over the
  skin or a prosthetic hand, the pin on the left lapel, the frames' finish on the rims): no piece, mesh, varying or
  uniform is added, and the vertex stages (but for one generated buffer name) and the shadow pass are unchanged. The hashed crowd draws them from new links
  of the colours' chain (38 to 43), as `lookFromSeed` does: a little over half the street wears a shoe style (one of
  its body's eight), about 28% a watch, half of those in glasses a frame other than black, about 3% a pin, and the street
  never wears the tourbillon or the rank pin. The card gains the Shoe style, Lapel pin, Frames and Watch rows (Shoes is
  now Shoe colour; the pin's row leaves in shirt sleeves and the frames' without glasses), the console `look footwear
  wingtip`, `look watch smartwatch`, `look frames`, `look lapelPin`, and a look code with the accessory word is
  forty-nine symbols (`-XXXXXXXX-XXXXXXXX-XXXXX` after the head). The watch shop's steel three-hand watch, tourbillon
  chronograph and rank lapel pin (lines 129 to 131) go on sale; the umbrella and the headphones stay on order. The
  shader budget holds (`SHADOW_SHADERS_REPORT=1`, `shadowShaders.test.ts`): the worst near fragment stage, the
  pantsuit's, goes from 200,360 to 221,913 characters and the worst far one from 159,904 to 173,039, against 225,000;
  the shadow fragment stays at 1,105.

- **The microphone pill, an on-device voice detector and barge-in over Sloane.** A pill under the HUD's header
  (`07_Execute_Actions/Hud.tsx` `MicPill`) reads the microphone's state (Mic off, Listening with a live meter of the
  room, Hearing you, Speaking while Sloane talks over it, Muted, or why it could not open) and is a button: a press,
  `V`, the right stick's click (R3) or the touch Menu's new Microphone item opens the microphone or mutes it, all
  one action through the engine (`input.ts` `'mute'`, `gamepad.ts` `PAD_EDGE.mute`, `engine.ts` `onMute`), which
  goes through even while an action card waits for the OK or a home's doorstep card holds the avatar. Mute
  releases the device, so the browser's own indicator goes out with the pill's, and the device is never open
  without the pill, which outlives `H` like REC (on a phone it is a 28 px badge on the minimap's lower-left corner, a
  microphone glyph struck through when it could not open and the pill's dot, shown only while the device is open,
  opening or could not open: the Menu's item is the switch there, and as a row of the panels' column, up from the
  start, it pushed them into Sloane's chip at the wheel on a 320 × 568 phone). The
  microphone opens as the city starts (`MIC_OPEN_BY_DEFAULT` in `04_Connect_Hardware/microphone.ts`, true on Julian's
  word of 2026-11-07), so the browser asks its permission then; after that the visitor's own choice is kept (key
  `civic-simulation:voice:v1`): one who left it on finds it on, one who muted it finds it muted, and a no at the
  browser's prompt is kept like a mute, so the page does not ask again at every boot (a press asks again); a missing
  device or an insecure page keeps nothing. Open, a voice activity
  detector (`vad.ts`: energy over an adaptive floor, the zero-crossing rate and spectral flatness, per frame of about
  11 ms, with onset and release counts) runs in an audio worklet where the browser has one and polled from the page
  where it has not (each poll feeds the samples since the last by the context's clock), feeding the meter and the
  pill. The crossings and the flatness are read over the band the frame carries (up to its last bin within 30 dB of
  its mean power, read through a Hann window; the flatness below 16 kHz too), so hiss stays hiss where the
  microphone's band ends before the context's: a 16 kHz headset heard in a 48 kHz context, a call codec's 7 kHz or
  3.4 kHz edge, a 48 kHz capture in a 96 kHz context. Hiss whose band slopes away over more than about a tenth of its
  width, and pink or brown noise, can still read as a voice. The frame follows the audio context's sample rate, which
  is the output device's (`vadFrame`: 512 samples at 44.1 and 48 kHz, 1024 at 88.2 and 96 kHz, up to 8192 at 768 kHz),
  so every time the detector counts below holds at 44.1 or 48 kHz or either doubled or halved (at 8, 16, 32, 64 and
  128 kHz a frame is 8 ms and those times are three quarters as long; the 1.5 s after her line in which words are not
  taken is the clock's);
  speech starting while Sloane speaks cuts her line (`speaker.ts`
  `onSpeaking`, `speaking`), with the browser's echo cancellation and a margin in the detector against her own
  voice; the detector also learns how loud her voice comes back through the speakers over each line's first 1.5 s
  and 0.43 s past the last steady sound in them (`speaking` starts when the clip plays or the browser speaks, not
  while a provider voice is synthesised, decoded or failing over; an operating system's voice can still start late;
  a line that cuts the one still playing starts its own learning, `onLine`), taking the steady level (the quietest
  of five frames, so a click or a knock of up to 32 ms is not taken for her, while one that rings on in the room is,
  like a cough), then holds her loudest word
  through her pauses (it falls only after 1.5 s without her voice near it, and rises at most 1 % a frame) and wants a
  voice 1.6 times that for about a quarter of a second before it cuts her; with none of her coming back (headphones)
  the onset is short. Against simulated lines (syllables whose loudness swings by 3 to 4 dB, pauses between
  sentences, a start up to 1.3 s late, a room's reverberation, half of them 3 dB louder at the end) her own line
  never cut itself in 640 tries, nor in 320 more with a click or a murmur before her late voice. With nothing of her
  coming back, a visitor cut in within a second every time (80 tries at two levels down to about 17 dB over the
  room, 40 with a click in her first 1.5 s, and 480 with a knock of 12 to 31 ms there, wherever it fell across the
  frames). Over her echo with no echo cancellation, a visitor 14 dB louder than her usual words cut in within a
  second 33 times in 40, 12 dB louder 23 in 40, and 9.5 dB louder 10 in 40; the rest later or not at all. Swings of
  6 dB between syllables still cut 23 lines in 320, and with half the lines rising 6 dB at the end instead of 3,
  6 in 736 cut themselves, in the same simulation. Nobody cuts in during her line's first 1.5 s: a voice or a
  lasting sound there (a cough) is learned as hers, and a visitor learned that way usually cannot cut in until they
  have been quiet for a few seconds (the estimate holds 1.5 s, then halves every 1.5 s).
  Where the browser promises on-device speech recognition (`08_Swarm/recruitment.ts`) it listens while the
  microphone is open, `recruit listen` opens the pill's microphone too, and words that are not a recruitment
  request reach Sloane (`Concierge.tsx` `heard`, `onboarding/heard.ts`: a line that names Sloane first opens the
  goal dialogue, "Sloan" too; an open question takes the whole line), but none heard while she speaks or in the
  1.5 s after (`heardNow`), so her own line is never taken for the visitor's; a line the visitor cut off leaves no
  such pause, so the words they cut in with are kept. The console's `mic [on|off]` prints
  and switches it. The screen reader hears the microphone's state through a live region in the HUD's root (not
  every onset of speech), there on a phone and with the HUD hidden too, and the pill's accessible name says the
  state, what a press does and the key. A mute that lands while the device is still opening stops the recogniser
  as well, and changing an accessibility setting never restarts the city or the microphone. Firefox has no on-device recognition, so there the pill shows the
  level and speech only; no audio leaves the page, nothing is recorded, and no speech model ships with the page
  (no Whisper). Verified by Node tests against synthetic room, voice, syllable-shaped speech, click and hiss signals and fake browser objects
  (`vad.test.ts`, `microphone.test.ts`, `voiceWiring.test.ts`); a real microphone, a phone's and Safari's permission
  flow, and the barge-in's feel with a loudspeaker are unverified. The page grew 17.7 KB for it, past a budget main
  was 7.5 KB under, so `tools/verify/page_dist.mjs` re-measures: 14,385,135 bytes plus 3%.
- **Sloane always answers, and dispatches.** The dead end is gone: a goal is never answered with "that's not
  something I can do yet". `src/06_Make_Decisions/dispatch.ts` (new) is the deterministic team planner: a goal's
  work words name desks (sixteen, one per indoor workplace kind in slot order, the six first rooms found under either
  name), a count in the goal is how many sub-agents (up to the lane runner's 32; more is said to be dropped), and a
  goal nothing maps to sends two scouts (the twin studio and the control tower) that read the city and report; the
  intent engine (`intent.ts`) gains the `dispatch` control beside its knobs. `src/08_Swarm/team.ts` (new) runs a team:
  one isolated NoirScript lane a sub-agent, placed at its desk's door front, a probe a tick under the lane limits, with
  move and a workplace task as its whole capability word; one person within earshot with the desk's skill is asked
  over through the recruiter, after the lane's own ask on the gate, and sent in only once the player stands within
  rally range of the desk's door (the tether is never loosened). The Concierge shows the lanes' readings under the
  brief, the HUD's activity line carries the team's one-line count, and the console gains `lanes [ledger
  [verify]|stop]` (`goal` lists a dispatched team's lanes). Sloane may say a brief's sentence in their own words
  through the page's mind (`sloaneVoice`: the router's order, a local server first, then the model kept in this page;
  never with the provider set to scripted), screened as the onboarding's rewording is and with every number kept; the
  planner's sentence stands until it answers and whenever it does not. The model rewords; it never decides, and
  nothing a goal says about work reaches any knob. Tests pin the planner (every desk's words, no knob word among
  them, every probe under six tenths of the gas on a ten-thousand-row city, the window walk, determinism), the runner
  over a fake host (placement, the bodies and the rally range, isolation through the gate at the first tick with a
  verified ledger, replacement and late answers, a host that throws), the console's `lanes`, the App wiring and
  Sloane's voice. After main's first walk, shops and hardware classes landed beside it: a lane's session grows its
  arena for the city's columns and keeps its own 64 Ki cells of room above them (`NoirSession`'s `tableRoom`), so a
  team on a workstation-class crowd (32,768 people, up to `?crowd=60000`) reads instead of every lane being isolated
  for memory at its first tick, and a prelude's fault names its reason on the lane; "twenty-four sub-agents" (the
  first walk's own swarm) is 24, with the teens and tens-and-units counted; a goal about something the city already
  has (the shops, the workplaces, the homes, the wardrobe) is answered with where to find it and sends nobody, and "tasks" or
  "jobs" in a goal that names work no longer bring the missions note; a desk the map has no room for reads around
  where the player started (`teamCentre`), not the map's corner; Sloane's rewording belongs to the brief it was asked
  for; `act gate` says which checks a lane passes; `goal` prints a dispatch's lane count and missing desks. Tests pin
  each (`lanes.test.ts` at 60,000 people, `dispatch.test.ts`, `team.test.ts`, `teamWiring.test.ts`,
  `commands.test.ts`).
- **Gas metering in the NoirScript VM, and the lane runner.** A bound that ends a NoirScript run is now named in
  the result as well as in its text (`NoirResult.fault`: `gas`, `bounds`, `memory`, `depth` or `output`; a division
  by zero, a type error or a refused host write is a plain error and carries none), and the VM exports the lane
  limits (`LANE_LIMITS`: `MAX_OPS_PER_TICK` = 4,096 instructions a tick, 256 characters of output, a 65,536-cell
  arena, 32 frames). `src/08_Swarm/lanes.ts` (new) runs a dispatched plan's sub-agents in isolated lanes: one
  session each (its own arena), one program a tick against one snapshot of the city's columns, every tick and every
  effect put to the Ring-0 action gate's `admitLane`, which gains two Zeroth-Law checks, `GasWithin` and
  `MemoryWithin` (fifteen checks now; `act gate` prints them, and the first walk's `verify_ring0` seal covers all
  fifteen by name). A refusal is the lane panic: the lane zeroed and
  sealed, the fault hashed onto the runner's ledger with the gate's sentence as its reason, one console line, and the
  frame untouched; a write for vehicle teleop from a lane without the bit is a capability fault; the operator's
  knobs (`tune`, `cull`, `steer`) are nobody's lane's. Tests pin every fault kind end to end, isolation of one lane
  among others, a plain error keeping its lane, `ask` on an effect outside the VM, a host that vouches nothing or
  whose realm has halted, that nothing throws, lane-to-lane memory isolation, the `LANE_MAX` cap and determinism to
  the ledger's head. Nothing dispatches into lanes yet: that is the next slice.
- **Capability lanes, the lane panic and the forbidden doors.** A sub-agent lane has a 32-bit capability word
  (`src/02_Define_The_Rules/capabilities.ts`), one `Uint32` per lane: four grantable bits (`CAP_MOVE`,
  `CAP_WORKPLACE_TASK`, `CAP_VEHICLE_TELEOP`, `CAP_SUBAGENT_SPAWN`), everything else forbidden for good
  (`CAP_FORBIDDEN_MASK`), the top four bits naming the host's doors no lane is granted (the network, dynamic code, a
  window, the host process) and `FORBIDDEN_DOORS` the names a script would use for them. `violation(asked, held)` is
  the kernel's branchless `asked & !caps`; a `CapabilityLanes` table grants grantable bits only and never grants a
  zeroed lane again; a `FaultLedger` hashes every fault over the one before it with the city's SHA-256
  (`integrity.ts`) and verifies by recomputation. The Ring-0 action gate has a thirteenth check, `LaneCapable`
  (Second Law), and a fourth moment, `admitLane`, the moment before a lane's effect; a refusal there is what
  `lanePanic` (`ring0Panic.ts`) answers: the lane's word zeroed and sealed, the fault on the ledger, one console
  line with the audit hash, and the frame untouched (the realm's `kernelPanic` still locks the page; the lane's
  never throws). The air gap now holds `window.open` to this machine like `fetch` (a new tab is a way out too);
  `act gate` prints the thirteen checks. Tests pin the bits, the branchless check against a plain reference over
  thousands of words, the sealed lane, the ledger's chain and tamper detection, the panic's log line and that it
  never throws, that every network and window door in the list is guarded or removed by the air gap, and that no
  door's name is in the code of the lane modules. The lanes themselves (the runner and what dispatches into them)
  come in the next slices.
- **Sixteen indoor workplaces, in a fixed order that is their id** (`src/01_Initialize_World/interiors.ts`). The six
  rooms become sixteen, `WORKPLACE_KINDS` in this order: roboticsLab, warehouse, serverVault, metroOps, controlTower,
  kitchen, microFab, twinStudio, fleetBay, greenhouse, acousticsLab, responseCenter, clearingFloor, gaitLab,
  microgrid, consoleDeck (the Sanctuary, a Ring-0 executive console deck: a room, unrelated to the First Law's
  `sanctuary.ts`). The six first rooms keep their furniture and stations to the centimetre under their new ids
  (telemetryCommand is controlTower, the boardroom twinStudio, the legal chambers clearingFloor, the clinic gaitLab);
  the ten new layouts (hot and cold aisle racks and coolant manifolds, signal boards and switch consoles, induction
  islands and prep arms and a plating conveyor, CNC cells and wafer handlers and the gantry's rail, lift platforms
  and a battery rack, grow towers and dosing pumps, an anechoic chamber with shaker tables, a weather grid and
  dispatch terminals, relay cabinets and inverters, a mainframe plinth and the console ring) keep every rule the
  crowd's mirror tests hold a layout to, written down over the layouts (station rows at v = ±4.6, the aisles clear,
  nothing past u = 5, a back-wall piece shallow where a bay row starts). `ROOM.slots` is 16: the crowd shader's
  `Params` grows from 5,600 to 11,360 bytes (sixteen rooms of 416, the route table to 160 rows), still far inside the
  65,536 a uniform binding has; the workday deals 128 stations with the same stride 29 (coprime with 128 as it was
  with 48), one worker in about 205 pedestrians instead of one in 77, never fewer than one in eight. The procedural
  city picks sixteen lots on a 4 × 4 grid over the inner downtown (`workplaceLots`; every downtown lot has a podium to
  hollow); Lakefront Metro's `regionWorkplaceLots` returns up to sixteen, and every window of the three test seeds
  yields sixteen (seed 1337's metropolis: its twelve transit hubs first, the six old lots among them, then four more).
  Two flat tables for a swarm that dispatches by slot, pure and documented in the manual: `workplaceTable` (16 rows of
  `kind, x, y, z, doorX, doorZ, doorYaw, stations`, kind −1 where a map has no such room) and `stationTable` (128 rows
  of `x, y, z, yaw`, row r × 8 + s the crowd's own station slot), with frozen `WORKPLACE_TABLE` and `STATION_TABLE`
  layouts; the engine exposes both as getters computed once (`window.__SIM__.engine.workplaceTable`,
  `.stationTable`). The console gains `rooms` (`terminal/commands.ts`, `bridge.ts` `RoomRow`): slot, kind, lot,
  doorway, stations and name, in the city and in Lakefront Metro, `none` on the surveyed region, refused in the
  console-alone shell. The first walk's indoor stage says sixteen workplaces and its why says sixteen trades (`firstWalk.ts`). The worker's refusal says "one of the sixteen kinds"; the browser smoke pins sixteen rooms on
  the desktop and sixteen drawn and sixteen in the crowd on `?map=lakefront`. Tests: `interiors.test.ts` (every
  invariant over the sixteen layouts and four seeds, the six old rooms' geometry pinned piece by piece, the tables),
  `region/workplaces.test.ts` (sixteen lots on every window, seed 1337's picks), `commands.test.ts` (`rooms`), and the
  pins in `simCore`, `regionPhysics`, `crowdCompute` and `intent` (`wgslHost` reads the room's size from the source). The passer-by mirror in
  `interiors.test.ts` now judges "already inside" as the shader does (strictly within the walls), since a lot's
  position can round the doorway band's outer edge a hair either way. Unverified from the cloud (no GPU): the ten new
  rooms, their furniture and the workday on screen; the shader is validated by `naga` and run on the CPU by the
  `wgslHost` tests as before.
- **Sixteen trouser cuts, sixteen skirt cuts and twenty lower garments.** The cloth word's next four bits carry the
  lower garment's cut (`LOOK_FIELD.bottomCut`, word 5 bits 12 to 15; `humanoid.ts` TROUSER_CUT, SKIRT_CUT). The three
  trouser bodies share one list: straight (0, every pair as it was, so every older look and code reads back unchanged
  and is drawn as before), pressed crease, pleated, turn-ups, side stripe, wide-leg, tapered, flared, cropped,
  culottes, high-waisted, belted, piped seam, slim, pleated turn-ups and palazzo. The skirt suit has its own: straight
  (0), pencil, A-line, pleated, box pleat, wrap, midi, midi pencil, midi A-line, back vent, button front, tulip,
  panelled, high-waisted, belted and flared. Changing the body between the skirt suit and the others starts the cut
  again at straight. Some cuts change the shape with no new geometry. The vertex stage moves the lower garment's own
  rings before the body sliders (`crowdBody.ts` bodyGarment, the GPU twin of `humanoid.ts` garmentPoint, which the
  card's silhouette uses too). Each trouser leg is reshaped about its own axis and the skirt about the trunk's.
  Normals follow the shape by the cylinder's rule, so a flare is lit as one. A wide leg, a palazzo, a flare or the
  culottes widen the leg, a taper or a slim cut narrows it, a midi lengthens the skirt to 0.36 m, an A-line or a
  flared skirt widens toward the hem, a pencil or a tulip narrows it, and the high waist raises it. Every cut skirt
  follows the legs as well as the trunk (`humanoid.ts` skirtPose): its front moves with the leg that carries it
  furthest forward, its back with the one that carries it furthest back, handed over smoothly, and its sides with the
  leg on their own side, fully from the knee-level ring down, and a midi's hem below the knee hangs from the shin, so
  the legs stay inside it at a walk (no cloth is simulated; the midi pencil's narrow hem still lets a bent knee show
  by up to 2 cm at the far end of a stride). A coat's panels below the waist follow the legs too, hung from its waist
  (`humanoid.ts` coatPose). Under a coat no skirt widens, and every skirt, the straight one too, follows as the coat
  does, so it stays inside the coat.
  The cut reaches the vertex stage in `morphB.w` (the cut, plus 16 under a coat), so no new buffer is bound. The
  fragment stage paints the rest from the rest position: the crease, pleats, turn-ups, a satin side stripe, a piped
  seam, the cropped and culottes hems above a bare or socked ankle (a prosthetic leg shows its finish there; below the
  culottes' wide hem, its shadowed inside), a belt and buckle where the waist shows, the high waist's cloth up the
  trunk in shirt sleeves or under a cropped jacket, and the skirt's pleats, box pleats, panels, wrap edge, back vent,
  button front, tulip petals, belt, waist seam and flared folds. About one pedestrian in three wears a lower cut, one
  of eight per body (`BOTTOM_CUT_STREET`). `LOOK_LOWER_GARMENTS` names twelve pairs of trousers and eight skirts, each
  a lower cut and a weave. A skirt is refused on a trouser body and trousers on the skirt suit, with a line that says
  why. With the forty-four tops that makes sixty-four garments. Customizer rows **Trousers** or **Skirts** (the lower
  garments the body wears) and **Trousers' cut**, **Chinos' cut** or **Skirt's cut**. Console: `look bottomCut
  wide-leg`, `look garment pencil skirt`. On today's main the suit's main fragment stage is about 200,000 characters,
  its shadow pass about 138,000 and its vertex stage about 62,000, inside the 262,144 budget. Pinned by
  `humanoid.test.ts`, `look.test.ts`, `lookWiring.test.ts` and `commands.test.ts`. Browser screenshots on SwiftShader
  only; nothing visual is confirmed on real hardware.
- **Sixteen cuts of the outer layer, and forty-four named garments.** The cloth word's next four bits carry the
  outer layer's cut (`LOOK_FIELD.cut`, word 5 bits 8 to 11; `look.ts` CUT): notch lapel (0, every jacket as it was,
  so every older look and code reads back unchanged and is drawn as before), peak lapel, shawl collar, double-breasted,
  band collar, turtleneck, waistcoat, cardigan, open front, belted, cropped, wrap front, zip front, side closure,
  quilted and patch pockets, each named for the cut and never for a people's dress. The crowd's fragment stage cuts
  the jacket or the coat from the rest position: the cut moves where the V closes, where its centre runs and how
  wide the lapels are (the notch lapel moves none of them), then paints its own marks: the waistcoat's shirt sleeves
  and dark satin lining, the cropped jacket's shirt below the waist, a belt and buckle, one or two columns of
  buttons, a zip, the side closure's line, diamond quilting, the cardigan's rib, patch pockets, a fine outer edge on
  the peak, shawl, double-breasted and wrap lapels, a satin sheen on the shawl's facing, and the turtleneck's knit up
  the neck. Under a band collar, a turtleneck, a zip front, a side closure or a quilted jacket the tie comes off
  (`TIELESS_CUTS`), in the look's mask and in the crowd's vertex stage alike. Three outer layers in ten in the hashed
  crowd wear a cut, one of eight per body (`CUT_STREET`).
  `LOOK_GARMENTS` names forty-four tops (suit jackets, blazers, evening jackets, band-collar and side-closure
  jackets, waistcoats, cardigans, cropped, belted, wrap, quilted and zip-front jackets, and seven coats), each a
  layer, a cut and a weave (the shawl-collar jackets also take the darkest trim) that keeps the look's colours;
  like a build, a garment is a starting point, not a slot (`withGarment`, `garmentOf`). Customizer rows **Garment**
  and **Cut** (**Coat's cut** under a coat; the Cut row hidden under shirt sleeves, where a garment puts the layer
  back on), console `look garment <name>` and `look cut <name>`. The suit's main fragment stage grows to about
  170,000 characters and its shadow pass to about 122,000, inside the 262,144 budget. Pinned by `look.test.ts`,
  `lookWiring.test.ts` and `commands.test.ts`. Browser screenshots on SwiftShader only; nothing visual is confirmed
  on real hardware.
- **Sixteen fabric weaves.** A cloth word joins the look genome (word 5): the top's weave and the bottom's at four
  bits each (`LOOK_FIELD.topWeave`, `LOOK_FIELD.bottomWeave`). 0 is plain, as before, so every older look and code
  reads back unchanged. The weaves (`look.ts` WEAVE) are plain, twill, herringbone, pinstripe, chalk stripe,
  houndstooth, glen check, windowpane, tartan (a generic check), tweed, linen, silk, cashmere, merino, batik (plain
  dots and rings, no classical pattern of the craft) and strip weave (bars and blocks, no named pattern). The crowd's
  fragment stage paints the top's weave on the jacket or the coat (a matching trim too) and the bottom's on the
  trousers or the skirt, from the rest position, round each part by the angle about its own axis so stripes run down
  the body and the sleeves. Threads finer than a pixel fade to the weave's own mean colour: the pixel's footprint is a
  derivative, read at the top of the stage before any branch. Silk, merino, linen, tweed and cashmere set their own
  roughness. The bottom's option 0 is `matching`: the top's weave where the trousers are the jacket's cloth, plain
  elsewhere. Four tops in ten in the hashed crowd are woven, one of eight weaves per body (`WEAVE_STREET`: suitings
  for the suit and the pantsuit, tweeds and checks for the blazer, the softer cloths and the prints for the skirt
  suit's top). A look with a weave carries a second word in its code's tail (fifteen symbols). The suit's main
  fragment stage grows to about 144,000 characters (from about 119,000) and its shadow pass to about 97,000 (from
  about 76,000). Customizer rows **Weave** and **Trousers' weave** (**Skirt's weave** on the skirt suit), console
  `look topWeave <name>` and `look bottomWeave <name>`. Pinned by `look.test.ts`, `lookWiring.test.ts` and
  `commands.test.ts`. Browser shots on SwiftShader only; nothing visual is confirmed on real hardware.
- **Facial hair, hearing aids and cochlear implants, and prosthetic limbs.** The skin word's next eleven bits carry
  the facial hair (none, stubble, moustache, goatee, short beard, full beard, long beard: 3 bits), the hearing devices
  (none, hearing aids, a cochlear implant, implants on both sides, an implant with an aid: 3 bits), a prosthetic limb
  (either arm, either leg, both arms, both legs: 3 bits) and its finish (matte, carbon, chrome, skin-matched: 2 bits);
  all are 0 for "as before", so every older look and code reads back unchanged, and the skin word's top two bits stay
  spare. Facial hair and the prosthetics are painted by the crowd's fragment stage (a prosthetic hand and wrist below
  the sleeve, a prosthetic shin below the knee where the leg is bare, with the socket's line); the long beard and the
  hearing devices are pieces (`humanoid.ts` PIECE 19 to 23, which fills the float piece mask to bit 23), the devices
  on the near body only. The hashed crowd gains facial hair for about forty-five men in a hundred (stubble to a full
  beard), hearing aids for about two people in a hundred, a cochlear implant for under one, and a prosthetic arm or
  leg for one. The near body grows by about 130 vertices (budget 1,950, from 1,850) and the far body by about 20
  (budget 540, from 520). The people's fragment stage is now written out once per value: three writes each branch of
  a `select` on its own, so the skin and the hair as painted, and the hash links, were written again in every slot's
  branch that read them, and these paints took the stage past the 256 KiB a stage may be (`shadowShaders.test.ts`).
  They are declared once at the top of the stage instead, each paint still under its own branches: the main pass's
  fragment for the suit is about 119,000 characters (from about 198,000 before this change) and its shadow pass's
  about 76,000 (from about 156,000). Pinned by `look.test.ts`, `humanoid.test.ts`, `lookWiring.test.ts`,
  `commands.test.ts` and `conduct.test.ts` (the new pieces confirmed unarmed). Browser shots on SwiftShader only;
  nothing visual is confirmed on real hardware.
- **Thirty-two hair styles, curl patterns 1A to 4C, eight headwear and twenty-four face shapes.** The look's hair
  style takes two high bits in the skin word (`LOOK_FIELD_HIGH.hairStyle`) and reaches thirty-two styles
  (`HAIR_STYLES`: the five older ones keep their numbers), each a set of hair pieces and a paint. Three new hair
  shapes join the body (`humanoid.ts` PIECE: a full rounded shell, a puff on the crown, a tail) and four headwear
  shapes (a head scarf over the head and neck, a wound crown, a snug crown, a flat cap's peak), near body only; the
  far body paints the hair's cap in the headwear's cloth. The skin word also carries the curl pattern (4 bits), the
  headwear (none, hijab, turban, head wrap, kippah, durag, beanie, flat cap: 3 bits) and its cloth (3 bits); all are
  0 for "as before", so every older look and code reads back unchanged. The crowd's vertex stage picks each hair
  piece with one shift of a 32-bit style set per piece (`HAIR_PIECE_STYLES`), and the fragment stage paints the cut
  and the curl texture from the rest position under branches. The hashed crowd gains a curl pattern each and a few
  headwear (about seven women and five men in a hundred). Twenty-four face shapes (`LOOK_FACE_SHAPES`, named by shape
  alone) set the head and the face sliders, as a card row and `look face <shape>`. The near body grows by about 270
  vertices (budget 1,850, from 1,600) and the far body by about 30 (budget 520, from 500). Pinned by `look.test.ts`,
  `humanoid.test.ts`, `lookWiring.test.ts`, `commands.test.ts` and `conduct.test.ts` (the new pieces confirmed
  unarmed). Browser shots on SwiftShader only; nothing visual is confirmed on real hardware.
- **Sloane's first walk, the first-run tutorial (stages, switch and card).** Six stages a brand-new visitor does before
  the city is theirs (turn the head and walk; tell Sloane a goal; get into a parked car; stand inside a workplace; run
  `laws` at the Ring-0 console; run the three-line NoirScript exit program), as a pure stage engine with Sloane's
  lines (`src/09_Cognition/firstWalk.ts`: the thing to do in the device's own words, one line for an eight-year-old,
  five whys one deeper each, one hint per stage after forty-five quiet seconds), a switch and a pass record
  (`src/07_Execute_Actions/onboarding/firstWalkStore.ts`: `?tutorial=1|0`, `?onboarding=0` and `?boot=tty` keep it away,
  the pass under `civic-simulation:first-walk:v1`), the page hook (`useFirstWalk.ts`) and a card with no close, no
  skip and no key that puts it away (`FirstWalk.tsx`), one accessible button per stage that has Sloane do the action,
  and on the last card buttons that type each program line into the console's prompt and run it. The console's
  handle gained `type` and `run` and reports every line run (`onLine`); the Concierge reports a goal sent
  (`onGoalSent`); the engine shows its workplaces (`workplaces()`). On by default (`FIRST_WALK_DEFAULT`, one
  constant); the exit program is the next entry's. The quiet five-minute watch waits until the walk is passed. Pinned
  by node tests (the stage order and detection, the switch, the wiring, the lines' plainness, conduct screen and brand
  scrub); how the card stands on a real phone, a pad or a screen reader is unverified.
- **The first walk's way out: three NoirScript words and the exam behind them.** `verify_ring0() -> u32`,
  `spawn_subagents(n: i32, role: str) -> i32` and `unlock_city(seal: u32, swarm: i32) -> bool` are intrinsics of the
  console's language (`src/07_Execute_Actions/terminal/noirscript`: a new `NoirHost.exam` surface with `noExam` as its
  refusal, three zero-operand opcodes, the folder's air gap unchanged), behind an exam the city composes into the
  console bridge (`src/07_Execute_Actions/onboarding/exam.ts`): a 32-bit FNV-1a seal over the live kernel (the four
  laws, the twelve checks, the host's vouch for the air gap, the audit standing) salted once per page load, 0 when any
  part fails; a swarm asked over through the recruiter's own lane (`Recruiter.tryAsk`, the same checks and realm
  answers as `recruit`), answering with how many were asked, never the number wished for; an unlock only for this
  session's live seal and a swarm of one or more, which tells the walk and keeps the pass. The console's `noir` prints
  what the doors said after each line; a read-only `tutorial [status|program]`; no `tutorial off`. The exam has no
  write surface: the Ring-0 gate and the elite tier stand as they were. A browser-smoke scenario (`walk`) does the
  whole walk on the accessible path. Pinned by node tests (the VM's call-through and lane types, the seal, the swarm's
  honesty, the unlock's refusals, the console's wiring, the air gap's export list); a real GPU, phone or pad is
  unverified.
- **The first walk's seventh stage: your look.** Between the workplaces and Ring-0 the walk now asks the visitor to
  choose how they look, in the wardrobe card already in the city (Track A of the character customizer: the closed
  business-casual wardrobe, the body and face sliders, the shareable code, the Agents tab), opened from **Look** on
  Sloane's chip; putting the card away again (Done, its close button, Escape or the console taking over) finishes the
  stage, and its accessible button, *Open the wardrobe*, opens the card. Sloane's line, hint, eight-year-old's line and
  five whys say only what the wardrobe does today. The stage is passed over on a page without the card, and the exit
  program is unchanged. The second plan's stores and owned places are not built yet; when they land they join this
  stage as more ways to finish it. `tutorial status` counts seven stages; the browser smoke's `walk` scenario opens
  and closes the wardrobe on the way. Pinned by node tests (the order, the wardrobe event, the stage passed over, the
  lines' plainness, conduct screen and brand scrub, App's wiring); a real phone, pad or screen reader is unverified.
- **The first walk's look stage takes the shops too.** On a map with shops (the city's five, Lakefront Metro's) the
  "Your look" stage can now be finished in a shop as well as in the wardrobe card: walking in, opening the shop's card
  (B, or E with no car near; the pad's south face button; the Browse chip on touch) and putting it away again (Done, ×,
  Escape, the console taking over, or walking out) passes it, whether or not anything was tried on or bought. Sloane's
  line, hint and eight-year-old's line name the shops only on a map that has them, in the device's own words, and say
  that trying on is free; the five whys now name the ten Monk tones, freckles and vitiligo of the look genome, the
  card's tabs for your own agents, and, where there are shops, the camera that circles you in one (not in a headset
  or a shared room). The walk's card steps aside while a shop's card is open. A surveyed region, which has no shops,
  keeps the stage as it was; owned homes are not built yet. The browser smoke gains a `walkshop` scenario (the look
  stage passed in the first shop, a try-on that costs nothing). Pinned by node tests (the shop event, the stage kept
  when done early, the lines with and without shops on each device, App's wiring); a real phone, pad or screen reader
  is unverified.
- **The first walk's card and Sloane's open card side by side.** On a desktop window narrower than about 1,300 px
  the walk's card (20 rem, on the right under the readout) lay over the right end of Sloane's open card, her name
  question's Continue button among it, on every first run. From 960 px across her card's column now runs from the
  minimap's clearance to just short of the walk's card while the walk is on (`Concierge.tsx` `WIDE_BESIDE`, centred
  there up to its usual 38 rem); below 960 px the walk's card steps aside while her card is open (`onOpen`, `crowded`)
  and comes back when she settles into her chip. The browser smoke's `walk` scenario measures the two apart at
  960×540, 1024×640, 1152×648, 1280×720 and 1366×657 and the walk's card away at 900×600 while her question is open.
- **The first walk's look stage takes the homes too.** On a map with homes for sale (the city's seven, Lakefront
  Metro's up to seven) the "Your look" stage can now be finished in a home as well: stepping inside, opening its
  doorstep card (B, or E with no car near; the pad's south face button; the For sale chip on touch) and putting it
  away again (Done, ×, Escape, B, the console taking over, or a headset) passes it, whether or not the deed was
  bought (`HomeCard.tsx`, a `'home'` walk event, `city.homes`). Sloane's line, hint and eight-year-old's line name
  the homes only on a map that has them, the line and the hint in the device's own words, and the line and the
  eight-year-old's line say the smallest costs nothing to claim; the fifth why adds that a deed is one line of the
  shops' catalogue kept by the one shopkeeper. The walk's card steps aside while a doorstep card is open, as it does
  for the wardrobe and a shop's card. A hint that comes while the walk's card is away (the visitor busy in the
  wardrobe, a shop's, a home's or Sloane's own card) is let go instead of being spoken when the card comes back,
  where it could tell the visitor to do what closing that card had just done; a stage's first line still waits for
  the card. A surveyed region, which has no homes, keeps the stage as it was. The browser smoke gains a `walkhome` scenario (the stage passed in the Micro-Loft,
  its chip clear of the walk's card, nothing bought). Also drops a stale tail of the first walk's opt-in wording that a
  merge had left under the side-by-side entry. Pinned by node tests (the home event, the stage kept when done early,
  the lines with and without homes on each device, App's wiring).
- **Lakefront Metro's transit map** (`src/01_Initialize_World/region/transit.ts`, pure: the page and the physics worker
  build it from the same seed, street window, craft boxes and bounds). A generated region's street window now carries
  what the procedural city has had since the fixed track network, and a little more. An **elevated train loop** on the
  9 m deck round the city's own corridor where every side of it has a sidewalk, else the largest walkable rectangle of
  the window (at least 4 blocks a side), with four mid-side stations and guideway columns at the window's own 3.9 m
  kerb (`tracks.ts` `trainLoop(corners)` and `guideway(track, kerb)`, the city's calls unchanged). **Drone corridors**
  at 40 and 46 m over every walkable 4-block cell. The **plane racetrack** at 400 m (`planeCorridors(centre)`),
  centred on the window and held inside the region (`RACETRACK_REACH`: a window by the region's edge no longer sends
  the planes 1.8 km out over the margin), moved by whole blocks when The Spire comes within the envelope's
  half-length of it. **VTOL routes** between rooftop pads of the window's own buildings: `tracks.ts` `vtolRoutes(boxes,
  cells, band)` and `vtolPads(boxes, band)` take a region's cells and a `VtolBand`; the city's band (roofs of 24 to
  60 m, cruising at 75 and 85) serves where the window has such roofs, and a second band over a generated map's
  towers (`HIGH_BAND`: roofs of 60 to 140 m, flown between at 150 and 160 m, over the drones and under the planes),
  its cells cut where the towers stand (`padCells`); twelve of the fifteen test windows get one or two routes, seed
  7's east bluffs and its north ridge (the grand ravine's window too) none (no tower in their windows: legal). The whole network is
  `windowNetwork(seed, window, craftBoxes, bounds)`: `SimInit.craftBoxes` (the window's rectangular buildings and the
  ring of lots round them, every building that reaches into the racetrack's envelope, and the region's plan:
  `craftBoxesOf`, at most `MAX_CRAFT_BOXES` 4,096, judged in `simHost.ts` like every other field) lets the worker,
  which holds the pack's walls and not its boxes, lay the same routes as the page; `simCore.ts` schedules the craft in
  a region with a window (a surveyed region still has none) and `engine.ts` builds the `CraftView` for them with the
  window's kerb (`craftView.ts` takes a `kerb`). **Zebra crossings** on every walkable arm of every window
  intersection, as geometry: six 0.5 m stripes across a car street and three across a pedestrian one, in the crowd's
  own `TRAFFIC.crosswalk` band, in one `RegionMarkings` mesh of one material at a new `SURFACE.marking` (0.055 m,
  over the junction asphalt; no polygon offset, pieces under `SURFACE_PIECE`). **Pedestrian plazas**: `fromMacro.ts`
  writes a generated pack's plaza lots as `pack.plazas` (one rectangle each; optional in the format, the surveyed
  pilot has none; `validatePack` checks it when present), and `regionWorld.ts` paves them at the sidewalks' height, so
  the hubs' squares are stone, not lawn. A **harbour ferry dock** (`ferryDock`): a pier from the lake shore nearest the
  window, its deck from the quay 60 m out over the water, railed, with a 10 × 20 m berth platform at its end, as boxes
  the page draws and the worker walls (in the plan with the rooms); the shore wall is opened for it
  (`regionPhysics(pack, layout, openings)`); `ferryBerth()` gives where a vessel would come alongside (the vessel is
  another change's). A **STOL strip** (`stolStrip`): 300 × 24 m of asphalt on the open land nearest the window, off
  the window and clear of every building, road, water polygon and plaza by 2 m, with threshold bars and a centreline
  at `SURFACE.marking`; the planes keep the racetrack at 400 m and do not land (landing is not built). No
  subterranean line: a track has one height. `region/clip.ts` gains `isRect`, `region/streets.ts` now holds
  `LANE_WIDTH`, `SIDEWALK` and `roadWidth` (re-exported by `regionWorld.ts`), so the worker can read them. Tests:
  `transit.test.ts` (fourteen windows of three seeds: the loop's sides walkable and no larger rectangle missed, its
  columns clear of every lamp, tree, signal pole, box and the carriageway; INV-1 for every train, drone, plane and
  VTOL piece against every craft box with the city's envelopes; the racetrack inside the region and off the needles;
  the network's craft audit clean on the realm's clock, the core scheduling them from the boxes it was sent and the
  page placing every craft where the realm does; the worker refusing malformed craft boxes; the crossings counted
  against the walkable arms; the plazas built on by nothing; the pier over the water with the shore wall opened for
  it and every other wall as it was; the strip clear; the markings drawn at their height; a source pin that the page
  and the worker call the same function with the same arguments), `surfaces.test.ts` keeps the new height in order,
  and the browser smoke's `?map=lakefront` scenario checks the craft and the markings. Unverified from the cloud (no
  GPU): the loop, the craft, the crossings, the pier and the strip on screen.
- **Actuator shaping, domain randomization and workstation cells for the joint bridge**
  (`src/04_Connect_Hardware/actuatorFit.ts`, `cells.ts`; `src/07_Execute_Actions/jointRealm.ts`, `articulated.ts`).
  A step response can now be fitted as a second-order system with dead time (`fitStep2`: gain, delay, natural rate ω
  and damping ζ from the closed forms of the under-, critically and over-damped responses, seeded from the
  first-order fit and refined by a shrinking search from its four best seeds), and `pickFit` takes it over the
  first-order lag only when the error falls by a tenth or more (Occam), never when the first-order fit is already
  within 0.2 % of the response. A chosen second-order fit becomes the joint's **reference actuator**
  (`ActuatorShaping`, `gainsFor2`, `stepShaping`): in `filter` mode the delayed setpoint drives a spring and damper
  with a speed cap, ω clamped to 60 rad/s, stepped semi-implicitly in four sub-steps so it stays bounded at 60 Hz for
  any damping, and the servo tracks it; the first-order filter is unchanged for a joint without one. **Domain
  randomization** (`randomizeDomain(seed, manifest)`, `DOMAIN`): from the rules' PRNG alone, every link's mass within
  ±20 % and its inertia within ±30 % at the same mass (a new optional `inertiaScale` on a link, judged within 0.1 to
  10, which the realm applies to the shape's own tensor: `shapeInertia`, whose closed forms match what Rapier derives),
  a friction per movable joint relative to its own caps (Coulomb up to 5 % of the effort cap, stiction one to two
  times that, viscous costing at most 10 % of the effort at the speed cap) and a jittered shaping per joint. The
  realm applies **joint friction** about each joint after the servo, through the servo's own impulse pair
  (`jointTorque`): stiction holds a still joint while the servo asks less than it, Coulomb and viscous friction never
  take more than the speed the joint has by the realm's measure and never exceed the effort cap. `robotMode` carries
  an optional `shaping` and `friction` per movable joint, every number judged in the worker before any of it is kept
  (a bad one is a counted rejection; the old command shape is unchanged). The console gains `robot fit <id> <joint>`
  (both fits, the choice, applied), `robot shape <id> [<seed>|off]` (the body re-spawned where it stood from the
  seed's domain, disarmed; the plain body back; or the domain's table) and `robot cell [<kind> <station>]`. **Cells**
  (`cells.ts`): a six-joint arm, a two-axis gantry with a wrist, a vibration table, a gait belt and a console with no
  robot, mapped from the workplace kind ids by string (`console` for an unknown kind); `robot cell` lists every
  station of every room with its cell (a new read-only `roomStations()` on the terminal bridge) and `robot cell
  <kind> <station>` spawns that cell's robot at the station, facing its yaw. `toUrdf` writes any manifest back out as
  URDF that `urdf.ts` reads to an equal manifest. Tests: `actuatorFit.test.ts` (five plants across the damping cases
  fitted back, ω within 3 % and ζ within 5 % where under- or critically damped, with noise, Occam on first-order
  plants, the stepper against the closed form and bounded at its clamp, stiction, Coulomb, the speed cap, the domain's
  spreads and determinism), `cells.test.ts` (every cell built through the one judge, the map, the URDF round trip of
  every cell and the demo arm), `jointRealm.test.ts` (the new mode fields judged and nothing kept from a bad command;
  a joint following an under-damped reference within 0.05 rad, overshooting as it does, with its own delay; stiction
  holding a joint under twice the servo's demand and letting go at half; Coulomb friction at the whole cap stopping a
  moving joint without turning it round beyond the solver's own correction), `articulated.test.ts` (the closed-form
  inertia against Rapier's, an inertia scale at the same mass), `jointState.test.ts` (`inertiaScale`),
  `robotLink.test.ts` (a fit against a second-order realm sends that joint a shaping of its ω and ζ, against a
  first-order realm none; a shaped body re-spawned in place with the friction and shaping; a cell at its station) and
  `commands.test.ts`. Unverified: nothing here has met a physical robot or a real actuator; the cells have not been
  seen on screen (no GPU in the cloud), and a cell's robot shares its station with the crowd's worker (robots never
  touch people).
- **The ten Monk skin tones, vitiligo, freckles and body builds, on a look genome of sixteen words.** The character
  customizer's look (`src/03_Spawn_Agents/look.ts`) grows from four packed words to a genome of sixteen
  (`LOOK_WORDS`): words 0 to 3 are the look, figure, face and wardrobe words exactly as they were, word 4 is a new
  skin word, and words 5 to 15 are spare (zero, and refused otherwise). Every field of the later words is 0 for "as
  before", so every stored look (records v1 to v4), every look code (28, 21, 15 and 8 symbols) and every roster look
  reads back as the same look, and a look without the new fields keeps its exact code. The skin slot holds the eight
  older tones and then the ten tones of the Monk Skin Tone Scale (`mst-01` to `mst-10`; Dr. Ellis Monk, published by
  Google under CC BY 4.0, credited in `NOTICE.md`); the street's hash now draws everyone from the Monk tones evenly,
  so the two deepest tones, which no pedestrian wore before, are as common as the lightest. **Vitiligo** (six
  patterns: hands, face, hands and face, scattered, widespread, one side) and **freckles** (light, medium, dense) are
  painted by the crowd's fragment stage from the rest position (two octaves of value noise for the patches, one dot at
  most per 1.6 cm cell for the freckles, thickest over the cheeks and nose, never on a paled patch), each under its own
  branch so a person without them pays nothing; two pedestrians in a hundred have vitiligo and about one in six
  freckles. A **Build** row (slight, lean, athletic, muscular, broad, stocky, soft, full) sets the mass, muscle,
  shoulder and hip sliders together, on the card and as `look build <name>` at the console. `crowd.figure` becomes
  four quads a person (64 bytes: the figure, face and wardrobe words with the rig slot word, then genome words 4 to
  15), the vertex stage still binds seven storage buffers, and the skin word reaches the fragment as one flat integer
  varying (`@interpolate(flat)`, not three's `flat, either`). A look code with a skin word grows a tail of eight
  symbols with its own check, and its head's check then covers every word, so the head alone is refused instead of
  read in an older tone. The stored record is v5. Pinned by `look.test.ts` (the genome's layout and round trip,
  the hashed crowd's odds and the shader's links, the codes with and without a tail, the builds) and
  `lookWiring.test.ts` (the buffer, the varying, the engine's record and the v4 record read as it is).

- **Five shops you can walk into, browse and buy from.** Five ground floors of the procedural city are storefronts
  (`src/01_Initialize_World/storefronts.ts`): Verrin & Vale Tailors, Aethelgard Ink Studio, Bio-Frame Prosthetics
  Atelier, Escapement Row Horology and Lintel & Lumen Design House, each on a lot of its own quarter, picked from the
  seed among the lots no workplace has. Each lot's podium is hollowed into a glass room with a counter, a mirror and
  its trade's fixtures, and the ceiling slab keeps the building's finish; the minimap draws the shops in teal. On foot
  inside one, E (unless a car is in reach), B, the pad's south button or the HUD's Browse chip opens the shop's card
  (`src/07_Execute_Actions/StoreCard.tsx`): the avatar steps onto a fitting spot kept clear of every fixture and the
  camera circles the body, so the outfit shows; every line has its level and price, Try on, Buy (worn at once) and
  Wear. Purchases go through one shopkeeper (`shopkeeper.ts`) over the progression engine's keeper (`progress.ts`
  `pageProgress`, adapted by `progressionPurse`): the card shows its level and civic credits, and its purchase gate
  takes the price and sets the line's unlock bit in the same saved record (worn lines at look 512 and up, furniture
  from 0, homes 0 to 6). A new operator starts at level 1 with 150 credits, enough for a first-floor line such as the
  tie, and earns more by the city's work. On sale now: the tailor's overcoats, trims, scarves and tie,
  the atelier's smart eyewear and the watch shop's briefcase; tattoos, limbs, watches and the other lines that need
  wardrobe slots not built yet are listed as on order, the design house's furniture stays on order until furnishing
  opens, and its seven property deeds are on sale (see the homes entry below). Three of the plan's shop names and two home names were changed after a trademark and place-name
  search (`docs/ip-audit.md` §7). Pinned by `storefronts.test.ts` (one shop per kind on its quarter for 64 seeds,
  never on a workplace lot, the podium gone, every fixture inside the walls, the walk-in and the camera's circle
  clear, the real Rapier avatar walking from the sidewalk to the fitting spot), `storeCatalog.test.ts` (ids, the
  deeds' levels and prices, every worn line on sale wearable by every preset body, the spaces, level cap and verdicts equal
  to the progression engine's, the shopkeeper over a real keeper bought once and kept across a reload, and over a
  stand-in that refuses) and `storeWiring.test.ts`.
- **The five shops in Lakefront Metro too.** A generated region's street window gets the same five storefronts
  (`src/01_Initialize_World/region/shops.ts`), on the lots nearest the visitor's start once its workplaces have taken
  theirs, from the same candidates as the workplaces (`region/workplaces.ts` `lotCandidates`, shared now): a doorway on
  a two-way street with a sidewalk the start can walk to, never the landmark's lot or a lot under water.
  `regionWorld.ts` `hollowLots` hollows a shop's lot as it hollows a room's (the slab in the podium's height and
  finish, a tower carried on it, the floor and forecourt paved), the worker takes the lots in `SimInit.shops` and
  refuses malformed ones, each with its reason, the region's minimap draws the shops, and each shop's card names the
  streets it stands on (the city's arcades are the city's districts). Pinned by
  `region/shops.test.ts` (two seeds, every zone: five shops, never a workplace's lot, the nearest lots first, the
  hollowing and the workplaces unchanged by it), `regionPhysics.test.ts` (the worker's refusals) and
  `storeWiring.test.ts`.
- **Seven homes you can buy and walk into, in the city and in Lakefront Metro.** The design house's seven deeds are
  on sale, and each stands for a home (`src/01_Initialize_World/properties.ts`): a ground-floor glass room built from
  the shop's recipe on a lot no workplace or shop has, picked from the seed with dice of its own (the Micro-Loft beside
  an elevated-loop station, the Brownstone on the heritage seam, the Pierside Timber Loft, the Glass Villa and the
  Estate on the lakefront row facing the lake, the Penthouse and the Sky-Mansion at the foot of two headquarters
  towers, sold for now as the residences at the towers' feet). A smaller home is a shallower room, with a solid block
  behind it on the shared 32 × 32 floor plan (`src/02_Define_The_Rules/homeGrid.ts`), and two concrete planters in the
  doorway let a person through and no car. A generated region's street window gets up to seven homes too
  (`region/homes.ts`), after its workplaces and shops, the grander homes on the better-built lots, hollowed by
  `regionWorld.ts` `hollowLots`. On foot inside a home the HUD's chip reads "For sale" with the deed's level and price,
  or "Your home"; E (unless a car is in reach), B or the chip opens a doorstep card
  (`src/07_Execute_Actions/HomeCard.tsx`) that sells the deed through the one shopkeeper (Claim (free) for the loft) or
  says Yours, and holds the avatar still while it is open (the engine drops every queued action after the poll and
  zeroes the walk; `Input.drain`). The design house's deed rows say where each home stands and offer Visit, or Go home
  once owned, which puts the avatar on the sidewalk in front of the doorway, and is refused in a network room. The
  minimaps draw the homes in violet, the owned ones in gold. Furniture stays on order until furnishing opens. Pinned by
  `homeGrid.test.ts`, `properties.test.ts` (seven distinct free lots by the rules for 64 seeds; the shell, the fill
  block and planters, and the pads and tracks unchanged for 16; either car's collider cast through the real Rapier
  world at a doorway and stopped by the planters on seed 1337, and a real Rapier avatar walking in on 4 seeds), `region/homes.test.ts` (two seeds, every zone), `storeCatalog.test.ts` (deeds on sale, a new
  operator's progression keeper claims the loft and is told the Brownstone's level, a level 3 keeper buys it),
  `homeCard.test.ts`, `input.test.ts` (the drain) and `homeWiring.test.ts` (also: the poll after a card closes is
  dropped too, so the pad press that closed it cannot reopen it; no card under the console or in a headset; while a
  city action waits, only its card reads the pad; in split screen only player 1's pads reach it).
- **Furnishing a home you own: nine furniture lines, free floors and walls, and pieces you walk round.** The design
  house's nine furniture lines go on sale through the same purchase gate as the deeds (`storeCatalog.ts` `OPEN_KINDS`
  adds furniture; a line is bought once and serves every home you own). Inside a home you own, B, E or the HUD's chip,
  which now reads "Furnish" and the home's name, opens the doorstep card as the furnishing view
  (`src/07_Execute_Actions/HomeCard.tsx`, its visit in `furnishVisit.ts`); in a network room it shows the deed with
  the engine's reason instead, and walking out of the home or putting on a headset closes it. The view has three tabs:
  the furniture strip (an owned line says how many stand here out of its cap, any other says its price and offers
  Order through the shopkeeper, or the gate's reason, and the pieces the record keeps that are not placed here are
  listed with Clear), three floors and six walls, all free. Under them is the home's 32 × 32 floor plan, drawn on a
  canvas (the back at the top, the doorway under an arrow, only the home's own rows, so a smaller home is a shorter
  plan, the apron hatched, each piece in its finish's colour with its initial, a workstation's seat dotted, the people
  in the home as dots, and the cursor with the piece in hand in green where it fits and red where it does not, the
  reason in words under it), while the room shows the same draft as a ghost from a camera under the ceiling. Place,
  Rotate, Remove, Undo (20 steps), View and Done each have a key, a pad button and a 48 px button; placing on a piece
  picks it up, and closing the card or taking another line puts a picked-up piece back at its place in the saved order
  (so a stored piece that fits only while it is out stays stored). The card's keys are taken in the capture phase,
  never H or `, and Enter and Space stay Place after a mouse click on one of its buttons (how a button got the focus
  is decided as the focus moves, as `input.ts` does, since Chromium already counts the key as keyboard use inside its
  keydown); it reads the pad in its own frame loop through `padEdges`, so a button held as it opens counts only from
  its next press, with the left stick past 0.5 moving the cursor (again after 300 ms, then every 120 ms; near a
  diagonal the direction changes only when the other axis leads by 0.15, so the stick's noise never moves it every
  frame) and the right stick turning the view while the engine holds the head's yaw and pitch where they were; a
  pointer on the room's canvas reaches a cell through `pickCell`, the right button removes the piece pressed (nothing
  when the press is on no cell) and the wheel turns. Every committed edit goes to App as the whole record, which saves
  it in this browser (`src/05_Observe_Environment/homeStore.ts`, `civic-simulation:home:v1`) and hands it to the
  engine with the deeds and lines the shopkeeper says are owned, at boot and on every change of what is owned. The
  rules (`src/02_Define_The_Rules/homeLayout.ts` `canPlace` and `fitLayout`) keep the apron free, never cut off part
  of a room or a workstation's seat, and keep a saved piece that no longer fits or is no longer owned without placing
  it. The world draws every home's finishes and pieces in one HomeFurniture mesh (`homeView.ts`, `world.ts`; two new
  styles, planted and lit), a home on sale shows a show home, and an owned home starts empty. The city's ground is
  drawn in 128 m cells, as a region's is: as two triangles 3.2 km by 2 km, its depth on the software adapter came out
  centimetres high in many views and the street showed through a home's floor finish 3 to 15 mm over it. The physics
  realm takes each home's pieces as one collider each (the `'home'` command): one put down over someone stays off
  until they step off it, and a network room takes them out of the world, while the room keeps every home's floor and
  walls. A deed row at the design house whose price would leave less than the cheapest furniture on sale says so, and
  an owned furniture line says "Place it at home (B)". Pinned by `homeLayout.test.ts` (the shapes, the finishes, each
  verdict, the wall rule for every turn, 2,000 seeded runs keeping the apron free, every seat reachable and every
  removal allowed, every show home fitting, no two boxes sharing a face), `homeStore.test.ts` (the round trip, the
  size limit, bad records, homes and pieces refused one at a time, a save checked before it is written),
  `homeView.test.ts` (pieces only for owned deeds and lines, the show homes, finishes only in a room, within the mesh,
  the solids, the draft camera inside the room), `properties.test.ts` (the home frames and the box checks),
  `physics.test.ts`, `simCore.test.ts` (the `'home'` command refused in a room and when malformed, a set stopping a
  walking avatar, off over someone until they step off, a room taking the sets out, parity with the room's world),
  `regionPhysics.test.ts`, `recoveryWiring.test.ts` (`padEdges` on its down edge only, the first poll only learning
  what is held, `padStep` unchanged), `city.test.ts`, `storeCatalog.test.ts` (furniture on sale through the same gate,
  a level 2 keeper buying the bookcase and the sofa, the cheapest line on sale), `intent.test.ts` (the label),
  `homeCard.test.ts` (the furnishing view's verdict words and keys, never H, `, Esc or B, its pad by edges and its
  sticks, every edit handed to App as a whole record, Undo of 20, the draft taken away on close, the pointer handlers,
  every button 48 px, the store card's warning and hint, and App's record, save and engine calls),
  `furnishVisit.test.ts` (a piece picked up put back at its place on closing or taking another line, past a stored
  piece that wants its cells and in a full home; a right press on no cell removing nothing; the stick's timing, steady
  and with noise on a diagonal; how a button got the focus) and `homeWiring.test.ts` (the HomeFurniture mesh, the
  engine's refusals and its draft camera, the solids sent only when they change and never in a room, the chip's
  "Furnish" and App's furnishing request). The browser smoke test has a `furnish` run (claim the loft, buy a bookcase
  and a sofa, place both by keyboard, Enter after a real mouse click on View still the card's, Done, reload: the
  layout kept and two more colliders), which passed with the `walkhome`, `homes`, `desktop` and `lakefront` runs on
  the software adapter (97 checks). The page grew by about 55 KB.
- **One command for every platform's build: `npm run build:matrix`.** `tools/build/matrix.mjs` (plain Node, programs
  with argument vectors, never a shell, so cmd.exe and sh run the same thing) builds the page once and then each
  target a machine can build: the Tauri 2 shell for Windows x64 (`windows-x64`: NSIS installer, .msi and bare .exe)
  and Windows arm64 (`windows-arm64`, cross-compiled on Windows x64), Linux x64 and arm64 (`linux-x64`, `linux-arm64`:
  .deb, .rpm and .AppImage), macOS (`macos-universal`: one universal .app, zipped, and .dmg, unsigned), Android
  (`android-apk`: arm64-v8a, signed with the debug key unless `CRIMSON_ANDROID_KEYSTORE` names one) and iOS
  (`ios-ipa`: built with code signing off, so unsigned), and Crimson Noir OS's UEFI application for x86-64
  (`uefi-x64`, with the .img and .iso media where the media tools are installed) and aarch64 (`uefi-arm64`, the entry
  after next). `--list`, `--targets
  <ids>|all|host`, `--dry-run`, `--out`, `--skip-page`; a target named by hand that the machine cannot build fails
  the run, under `all` it is skipped with a note. `.github/workflows/build-matrix.yml` runs the same command on
  GitHub's runners, one job per target (Windows, Linux x64, Linux arm64, macOS twice, Linux with the Android SDK), lays
  the nine targets out in the run's summary, and on a v* tag uploads the files to the tag's release after
  build-release.yml has created it; build-release.yml dispatches it for a tag it makes itself, as it does
  windows-app.yml. Not made: anything signed or notarized (no Apple or Windows signing account). Tried in Node (the
  dry run and the table's tests); the workflow's first runs are the pull request's own, and no file it makes has been
  opened on a Mac, a phone or a Windows on Arm machine.
  The workflow's first run on this change's own pull request built all seven: Windows arm64, Linux x64, Linux arm64,
  macOS universal, the Android .apk, the iOS .ipa and the UEFI application with its media (the Android and iOS jobs
  needed the Tauri CLI driven as Tauri expects: the mobile projects generated through npm, so Gradle and Xcode can
  call it back, and the .ipa from `tauri ios build --no-sign`). None of the files has been opened on a device yet
  except the Windows app.
- **The .msi and the .rpm, with the version's numbers as the installers' own.** WiX takes no pre-release tag and rpm
  no hyphen in a version, and the version is `1.0.0-stable-beta`. The Windows targets now also make an .msi, with
  WiX's own version set to the numbers (`bundle.windows.wix.version`: 1.0.0), and windows-app.yml packages one from
  the same binary with `tauri bundle` on every change (artifact `windows-msi-<version>`, and onto a tag's release).
  The Linux targets make an .rpm with `tauri bundle` from the binary the build made: Version 1.0.0, Release
  0.stable.beta (the final 1.0.0-1 sorts after it). Nothing is compiled with the shorter version, so the app inside
  every installer says 1.0.0-stable-beta (`installerVersion`, `rpmRelease` in tools/build/matrix.mjs, pinned by
  tests). The pull request's runners built all four: the x64 .msi in windows-app.yml, the arm64 .msi (WiX target
  arm64, 8.3 MiB), and `Crimson Noir Agent City-1.0.0-0.stable.beta.x86_64.rpm` (8.2 MiB) and `.aarch64.rpm`. Not
  installed on a machine yet.
- **Crimson Noir OS boots on aarch64 (`uefi-arm64`).** The boot crate's machine layer is split by architecture
  (`crimson_noir_os/boot/src/arch.rs`): `arch/x86_64.rs` is the old one, and `arch/aarch64.rs` drives an Arm machine
  after ExitBootServices: the serial line is the UART the firmware's ACPI SPCR table names (a PL011 or an SBSA generic
  UART; no table, no log), the clock the generic timer's virtual count, and the image installs its own exception
  vectors (VBAR_EL1, or VBAR_EL2 where the firmware runs at EL2), so every exception lands on the fault screen with its
  class, syndrome, fault address and return address. An Arm machine has no PS/2 controller and the image has no USB
  stack, so the keyboard is the serial console (a terminal's bytes, arrows and Page Up/Down). Everything above that
  layer is shared, and the compute self-test reaches the x86-64 image's fingerprint (0x83765bab). `build-image.sh`
  takes the target (`BOOTAA64.EFI` on the ESP; the media's identity names the architecture, the x86-64 media's is
  unchanged), `boot_test.py --arch aarch64` boots QEMU's Arm `virt` machine with edk2 (AAVMF), a ramfb screen and the
  serial line on a socket it types into, and build-matrix.yml's two UEFI jobs bake their media twice, compare the
  bytes, and boot the disk image through the tutorial and the terminal to power-off and the ISO to the self-test. On
  a tag the x86-64 media stay build-release.yml's (the build matrix no longer uploads its copies over them). Checked in
  QEMU here and on the pull request's runners: the aarch64 disk image through the whole boot test (`SELFTEST PASS`
  after 8 s, the tutorial passed after 74 s, `golden` matched, powered off), the ISO from a SCSI CD to the self-test,
  a second clean bake byte for byte, and the x86-64 image through the same tests after the split; here also a forced
  data abort and a BRK on the fault screen. Not booted on Arm hardware.
- **Hardware classes, lanes per class and the `hardware` command.** The engine now decides once at boot which of
  three machines it is on (`src/05_Observe_Environment/governor.ts` `classifyHardware`): a phone (any phone, tablet
  or lite profile), a workstation (a Peak candidate whose WebGPU adapter binds at least 512 MiB in one storage buffer
  and makes a 1 GiB buffer: `readAdapterLimits`, read from the adapter in `world.ts`, since the page's device is made
  with the defaults), or a desktop (everything else; the adapter's limits are a veto, never a promotion, `?peak=1`
  skips it). The class sets how many pedestrians the realm simulates unless `?crowd` says (`defaultLanes`: 32,768 on
  a workstation, the 14,000, 8,000, 5,000 and 2,500 of before elsewhere, never over what the adapter binds or the
  realm's 60,000), rides on the governor's state (`quality.hardware`, the namespace's `Quality/Governor/hardware`)
  and changes no tier rule. The governor's rings are walked by a mask (every ring a power of two, pinned by a test),
  and it reports the percentiles of its own window (`Governor.percentiles`: p50, p95, p99, allocation-free). The HUD
  clock keeps 256 frames and adds p99 (`output.p99Ms`, the namespace's `Frame/Page/p99Ms`, the `stats` and `sim`
  frame rows). The console's `hardware` prints the class, the profile and range, the adapter and its limits, the
  lanes, the window's percentiles and the machine as the browser reports it; MANUAL.md, Autoscaling, has the rules.
  Tried in Node (the governor, console and namespace suites) and in headless Chromium on the software adapter (the
  browser smoke's `desktop` and `lite` scenarios see a desktop and a phone); no workstation was seen on real
  hardware, and the plan's 131,072 lanes are not raised here (the crowd's grid, readback and draw would need
  resizing and measuring on a real big GPU).
- **The sun's shadows reach farther, in two cascades, with a softer, tier-set penumbra.** The one directional light
  with a fixed shadow box of ±80 m around the player (±160 m on Peak, on an 8192² map of half a gigabyte) is replaced
  by three r186's cascaded sun light (`src/01_Initialize_World/sunShadow.ts`, three/addons `SunLight`): a near cascade
  fitted to the first stretch of the view with fine texels (about 32 m on Medium, 42 m on High, 62 m on Ultra and
  Peak), a far one to the rest out to the tier's distance (the governor's new `shadowDistance`: 120 m on Medium, 160 m
  on High, 240 m on Ultra and Peak), fading out over its last tenth instead of ending in a line, the two drawn side by
  side in one atlas (1024 texels a cascade on Medium, 2048 on High, 4096 on Ultra and Peak, so Peak's shadows take a
  quarter gigabyte instead of a half) and fitted and snapped to whole texels by three every shadow pass; in split
  screen each viewport's shadows are fitted to its own head. Two things three leaves to the page are done in
  `CitySunShadow`: casters are drawn from at least 320 m toward the sun whichever way the player faces (three alone
  drew them from as little as one shadow distance sunward, so a tower's long low-sun shadow came and went as the head
  turned), and every cascade spans at least 700 m of depth, so the depth bias means the 21 cm it did over the old box.
  The filter is three's own PCF (a Vogel disk of hardware depth comparisons rotated per pixel) with the tap count read
  from a uniform (`shadowTaps`: 5 on Medium, 8, 12, 16 on Peak; the taps are written out with every one past five behind
  an `if` on it, no loop) and the disk's radius a tier knob too (`shadowRadius`, round on the atlas), so the shadows
  soften up the tiers without a recompile. Peak keeps Ultra's cascades and reach (a farther reach would stretch the
  near cascade and coarsen the shadows nearest the eye) and adds taps and a wider penumbra. Parking (shadows off below
  Medium) works as before, on the same shadow object. Sloane's Peak question no longer says Peak takes half a gigabyte
  more. Pinned by `sunShadow.test.ts` (the light, its node class registered with the renderer once, the filter
  installed before the first build, two cascades in one atlas, casters from 320 m sunward at every heading, tier and
  sun height over at least 700 m without moving three's fit across the light, the taps' bounds), `shadowShaders.test.ts`
  (every material still builds in both passes within the binding budget; the lit fragment's shadow is sixteen written-out
  hardware comparisons a cascade, eleven behind an `if` on one uniform, no loop, and its WGSL is byte-identical for
  Medium's and Peak's taps, distance and map; the shadow pass, built for a real caster, compares nothing) and the
  governor, Peak and browser-smoke pins (Peak's atlas is 8192 wide with a three-texel penumbra, Ultra's 2.5, both 240 m;
  the lakefront's Medium atlas 2048 × 1024 and 120 m). three's own `CSMShadowNode` was not used: it clones the light's
  shadow once at the first compile, so nothing written to the sun's shadow afterwards (the tier's map size, the
  parking) reaches its cascades. Unverified: how it looks on a real GPU (software-WebGPU pictures only, which at the
  photographed spots look like the old ones), and the cost of the second shadow pass on an integrated GPU at Medium (the
  governor measures and steps down as ever).
- **4x multisampled anti-aliasing for the scene, decided at boot.** FXAA was the only anti-aliasing, and it cannot
  bring back a lamp pole or a mast arm thinner than a pixel. Now the post chain's scene pass can draw 4 samples a pixel
  (three r186's `pass(scene, camera, { samples: 4 })`; colour and, under the cinema camera, the velocity buffer resolved
  as the pass ends, the multisampled colour never stored; the sun shafts read the first sample of the multisampled
  depth), with FXAA and the ghost view's composite after it as before. Who gets it: `governor.ts msaaCandidate`, by
  itself only on a Peak candidate's hardware that the profile starts on Ultra (a high-end discrete card the browser
  identifies as one: stock Chromium names no AMD card, so an AMD card there starts on High and needs `?msaa=1`) at no
  more than 2560 × 1440 drawn pixels (`?scale` counted, squared); `?msaa=1` asks for it on any desktop, `?msaa=0`
  refuses it, and a phone or a lite profile never takes it. The sample count is in the key of every scene pipeline
  three builds, so it is not a tier knob: the boot decides it once, there is still one post chain, and no tier change
  recompiles. Split screen, which has no post chain, multisamples the renderer's own frame instead under the same rule
  (`?post=0` included; split screen refuses a headset, so the headset's targets stay at one sample); the renderer keeps
  that for its life, so split screen keeps it at every tier, and it has no one-sample fallback. The boot's first frame
  now draws the direct path and the post chain in a validation scope each: a refused direct path fails the boot as
  before, and only a refused 4x chain is released and built again at one sample, then drawn again in its own scope,
  with the boot's own failure text kept. `Engine.sceneSamples` says what the boot chose; `tools/browser/shot.mjs` logs
  the samples of the path that drew each picture. On the Lakefront map the street ribbons (carriageways and sidewalks)
  are now cut into 32 m pieces instead of 128 m (`regionWorld.ts RIBBON_PIECE`): multisampled, the software adapter drew
  a pale line of junction pavement across the road at junctions about 50 m off, because the pavement lies 5 mm under
  the asphalt and the depth taken off the pixel centre across a 128 m piece lost those 5 mm; at 32 m (and at 16 m) the
  line is gone, for about three times the streets' vertices (some 21,000 more on the metropolis's street window;
  `surfaces.test.ts` pins the pieces). Pinned by `governorMsaa.test.ts` (who is a candidate, ?msaa, the
  screen cap with ?scale squared, an unnamed AMD card, no tier carries a knob), `postfxAa.test.ts` (the scene pass at 4
  from its construction, colour not stored and depth stored, the ghost pass at one sample and after FXAA, the
  renderer's samples never reaching the scene pass, release() freeing the targets, 1, 2 and 8 refused),
  `aaWiring.test.ts` (the host's ?msaa, split screen's renderer samples, the boot decision, the two scopes and the 1x
  fallback, no sample count set by a tier) and the browser smoke on the software adapter (a desktop at one sample;
  `?msaa=1` at Ultra under the cinema camera with every two-target pipeline at 4x through Low, Peak and Ultra, no
  pipeline compiled by those tier changes, and ghost view and rain mode validating; the faked RTX 5090 multisampling by
  itself; split screen at 4x on the renderer; the lite phone, and the phone with `?lite=0&msaa=1`, at one sample).
  Limits: the plain resolve averages linear light before the film curve, so bright edges stay hard and a thin dark pole
  against a bright day sky keeps only part of its contrast; shader-drawn edges (road markings, rain mode) are not
  multisampled; the cost is not shed tier by tier (with one player only Minimal, without ghost view, has none); Lite,
  the headset, and Minimal and `?post=0` with one player still have no anti-aliasing (a phone off the lite profile
  keeps FXAA at Low and Medium). Unverified: how it looks and what it costs on a real GPU (software-WebGPU pictures
  only).
- **Ambient occlusion at Ultra and Peak.** The post chain now holds three r186's screen-space ambient occlusion
  (`SSAONode`, wrapped as `postfx.ts GatedSSAO`): from the scene pass's own depth at half resolution, with each
  pixel's normal rebuilt from that depth (`getNormalFromDepth`), a rotated disk of taps within 1.5 m (intensity 2: at
  three's default of 1 the software adapter's pictures barely changed), then a depth-aware blur across and down; the
  result multiplies the HDR colour after the shutter, bloom is taken from the light before it, and the sun shafts are
  added after it, never occluded. It fades out on bright pixels (HDR luminance 1.5 to 4: lamps, windows and signals
  keep their light), from 60 to 300 m into the haze and, under the cinema camera, where the shutter smears the frame
  more than 2 to 8 px (it is drawn from the unsmeared depth); rain mode and an operator strength of 0 turn it off. The
  tier knob is `aoTaps` (Ultra 12, Peak 16, 0 below and on Lite), a uniform loop bound: a tier change writes the taps,
  a strength uniform and a JS switch, and `GatedSSAO.updateBefore` skips the three passes while off (a node's
  updateBefore runs every frame once built, so a strength of 0 alone would still render them). Its first frame always
  draws, so the boot's validated draw compiles both of its pipelines. Who builds it: `governor.ts aoCandidate`, every
  desktop-class profile unless `?ao=0`, never a phone or a lite profile; split screen and `?post=0` have no post
  chain. The scene pass gets no attachment and no context node, so no scene pipeline changes, at one sample or four:
  every read of the depth is a load without a sampler (at 4x three declares a multisampled depth texture and loads its
  first sample, as the sun shafts do; at one, its nearest filtering makes it unfilterable). GTAO (`GTAONode`) was
  rejected: it gathers depth with `textureGather`, which a multisampled depth texture refuses, so every 4x boot would
  fall back to one sample, and its tap count is compiled in. Screen-space reflections were not adopted: they need new
  scene-pass attachments chosen at boot and written on every tier that runs post, for surfaces this city barely has
  (the lake's water has no metalness, the roads are dry). Material-level occlusion (`builtinAOContext`) would need a
  second full prepass of the city and the crowd. The operator key `shaders.ao.strength` (0 to 1) scales it;
  `tools/browser/shot.mjs` logs its state, and the browser smoke counts its two pipelines (tagged by their one R8
  target) and their draws: built and skipped below Ultra, drawn every frame at Ultra (12 taps) and Peak (16), at 4x
  too, with nothing compiled after boot, none drawn at Low or in rain mode, and never built on split screen, Lite or a
  phone off the lite profile. Pinned by `governorAo.test.ts` (who builds it, ?ao), `governor.test.ts` (the knob per
  tier, never decreasing going up, only with post, the applier writing it and a post cap writing 0),
  `postfxAo.test.ts` (on the scene pass's own depth with rebuilt normals, the scene pass's targets unchanged at one
  sample and four, built applying nothing with one tap, the first frame drawn and later frames only while on,
  release() freeing its two targets) and `aoWiring.test.ts` (the host's ?ao, the build decided after the post cap and
  kept through the 1x rebuild, the frame's writes and rain mode, no tier touching its resolution, blur or the scene
  pass's targets, no GTAO, SSR or material occlusion in the chain). Limits: it darkens a pixel's finished light,
  direct sun and lamps included, not only the indirect light (masked on bright pixels); it sees only what is on
  screen; its normals carry no bump detail; without temporal accumulation the half-resolution result can crawl on thin
  geometry; at 4x it follows the first sample's coverage while the colour is the resolved average (up to a pixel at
  silhouettes); the network ghosts occlude like solid things; its two targets (about 1 MB at 1080p) stay allocated on
  every tier once built; three's SSAONode leaves out the sky only under a conventional depth buffer (depth 1), and
  this city's is reversed (the sky is 0), so the sky's pixels run the taps too (they come out unoccluded: every tap
  lands on the far plane) and the pass costs the same under open sky as facing a wall. Unverified: how it looks and
  what it costs on a real GPU (software-WebGPU pictures only).
- **The operator's progression.** The operator now has a level (1 to 20, 1,000 XP each, the rest rolling over), six
  attribute modifiers, eight skills of the city with proficiency ranks, civic credits, hero points, resolve and three
  actions and a reaction per six-second round (`src/02_Define_The_Rules/progression.ts`, over one 128-word record,
  sealed and range-checked, kept in this browser by `src/05_Observe_Environment/progressStore.ts`). A console
  command that does something in the city earns a check in its skill: a d20 plus the skill's modifier against the
  level-based DC, eased by 2, paying a fixed table by degree and level, raised by how many different skills the
  current cycle of 24 checks has used (1x to 3.5x). A skill rests a minute between checks; after three misses in a row
  the next check rolls twice; a hero point rerolls the last check. The console's `progress` prints the status, the
  table, spends skill increases and hero points, and starts over with `reset --yes`. Credits buy through one purchase
  gate (`buy`, `canBuy`, `owns`, `spend` on `pageProgress()`), which debits the credits and sets the unlock in the
  same record and save, for the wardrobe, the properties and their furniture to use. The mechanics are offered under
  the ORC License: `NOTICE.md` now attributes Pathfinder GM Core as well (its level-based DCs and treasure table are
  used) and lists what was taken and added, and `docs/ip-audit.md` §7 records the checks. The plan's surprise-scaled
  payouts, hidden pity counter and drop tokens were not built (`docs/progression.md` says why). The cues on a success
  and the checks the city itself earns are not in this change.
- **The city earns checks, and a success is cued.** The second slice of the operator's progression. The city's own
  deeds now earn: boarding a car with the door key (piloting; a network room's correction or a script's `interact()`
  does not), someone recruited arriving however they were asked (swarm command, from the round's reaction), a spoken
  request the recruiter understood (acoustics and voice, from a new `understood` event), the clock keys, the rain key,
  the ghost key when the view really shows or goes, and the touch menu's Headset (optics and cinema), and the wardrobe
  card's first real change of a visit (architecture and commerce). The setters behind the keys and the agents' city
  knobs earn nothing, so the console's own checks are not lost to a skill's rest, and `recruit <skill>` and `recruit
  listen` at the console no longer earn (the arrival and the understood request do, once). One keeper listener in App
  cues every success, the console's or the city's: a short head-locked chime in player 1's ears (a C5 E5 G5 arpeggio,
  or a C4 C6 G6 chord for a critical success, rendered once at build, straight to the master gain with no panner or
  reverb, captioned as text alone: `[chime: Piloting, success]`; at the ear quieter than the recruitment cue from
  anyone near enough to be asked over, waiting for a cue or a ping still sounding and fading out under one that
  starts, so it never covers either); one or two 50 ms taps on a controller's rumble while no guardrail signal holds
  the motors, the screen is not split and the page is shown, the hold, the snap and the lightbar untouched; one or
  two short vibrations on a phone; and a HUD progress chip (the level, '420 of 1,000 XP', the credits, the hero
  points, the round's pips, and for four seconds what a check was and paid) with one soft ring at most once a second
  and none under the system's reduced-motion setting. A hero point's reroll that stayed a success is not cued again. `haptics [on|off]` at the console
  and `?haptics=0` switch the rumble and the vibration off. What CI shows: the chime's buffers, levels and graph
  (`audio.test.ts`), its caption (`captions.test.ts`), the tap's envelope and the guarded `vibrate` on fake
  navigators (`hal.test.ts`), the earns, the chip's words and its cache (`progress.test.ts`, `recruitment.test.ts`), the
  knob (`commands.test.ts`), and the wiring by source scan (`progressWiring.test.ts`: the tap merged after the
  guardrails, the deeds only at the keys and the boarding, one listener taken back on a halt and with the city). How the
  chime sounds, how the pad's tap and the phone's vibration feel on real devices, the chip's glow in a real browser, and
  the plan's under-16 ms budget are unverified. An action card's cost in pips is not in this change.
- **A box truck, an automated guided vehicle and a counterbalance forklift.** Three working kinds join
  `VEHICLE_KINDS` (`src/07_Execute_Actions/car.ts`), eleven in all: a cab-over box truck on the heavy class, and a
  cab-less guided vehicle and a forklift under its overhead guard on the light class, the last two drawn smaller than
  the sedan's box, with an amber beacon on the guided vehicle's sensor dome and on the forklift's guard. Each has its
  own extruded profile and glass (`fleetView.ts` `PROFILES`; the driver's eye looks out through the guided vehicle's
  sensor band and the forklift's open cab and mast), inside its class's box plus the dissolve's reach (`vehicleKinds.test.ts`), and a name the conduct test
  reads. The first eight kinds keep their indices and the heavy share of the fleet's draw is unchanged, so every slot
  keeps its chassis class; a slot's kind within its class can change. Manual: Vehicles.
- **Two harbour ferries on the lake.** A new craft kind, `ferry` (`src/06_Make_Decisions/tracks.ts` `ferryRoutes`,
  `TRACKS.ferry`; `simProtocol.ts` `TRACK_KINDS`): two 26 m ferries share one 1.8 km route on the lake, calling
  alongside the pier head for 30 s with the hull 2 m off the pier's end, then sailing at up to 6 m/s, half a lap
  apart, on the train's timetable machinery with their own acceleration and dwell. `craftView.ts` draws them
  (`ferryGeometry`, a pointed hull with the crimson stripe, cabin, wheelhouse, side lights and a mast beacon). The
  proof is the seawall, not height: `tracks.test.ts` measures the hull (`hullGap`, a rectangle, not a disc) every
  half metre against every box of four seeds (closest approach: the 2 m berth) and keeps every hull corner 2 m off
  the seawall; `trackFleet.test.ts` reads the hull's clearance off the stream for ten minutes (more than a lap) and
  the ferries on the water, on their route and clean for the audit for two hours of realm time. The Ring-0 craft
  audit gains the kind's floor (its waterline) and a shore, the pier's end (`CRAFT.shore`, 746 m), read with the
  hull at its heading (`CRAFT.halfLength`, `CRAFT.halfBeam`): a ferry whose hull reaches the land side of it halts
  the realm, and every pose of the route keeps its hull more than a metre clear (`ring0.test.ts`). Nobody boards a
  craft yet. Manual: Vehicles.
- **Kerbside bays, and the only car you may take.** One car in four of a fleet is seated, empty, in a kerbside bay
  (`src/07_Execute_Actions/parking.ts` `BAYS`, `bayNear`, `bayClear`; `carRig.ts` `planFleet` takes the city's
  boxes): the last quarter of the plan, so every earlier slot is as it was and the seed's stream is not drawn from,
  on the sidewalk's inner strip 5.2 m from the street's centreline on the right-hand side of travel, 15 m or 25 m
  along a block side (clear of the lamps and the tree), facing along the lane, and only where the lot's boxes leave a
  car's footprint clear; a region's street window has its own origin. The traffic passes a bay without queueing
  behind it or finding it with its bonnet rays, and a pedestrian walks round it. The minimap draws a bay car green
  (`MapCar.parked`). A bay car a player leaves stands where it was left; when a network room starts, when the room's
  held cars overflow, or when the room puts a driver out, it goes back to its bay (`Fleet.rebay`), so the page and
  the room expect the same car in the same place with no further state. `parking.test.ts` checks the plan, every
  bay's place and clearance, the realm's traffic flowing past the bays for 1,800 ticks (no follower stands beside a
  bay for more than 3 s), and the door on both kinds of car. Manual: Vehicles.
- **The contact policy as one rule.** Six collision layers (`src/02_Define_The_Rules/collision.ts` `LAYER`:
  terrain, structure, player, agent, vehicle, prop) and one branchless rule, `canCollide`: an actor (a player, an
  agent, a vehicle) meets the solid world (terrain, a structure) and nothing else, −1 or 0, the same either way
  round. The Rapier words that already carried the policy (each collider class's body kind, sensor flag and
  interaction groups, now listed in `COLLIDERS`) are checked against the rule pair by pair, and the sources that
  set them are pinned, so a group that drifts from the rule fails the suite. `wallContact.test.ts` drives a sedan and
  an SUV into a wall at the speed cap in real Rapier: a dead stop inside 0.15 m, upright, nothing added to or taken
  from the world, no First-Law ruling, and away again in reverse; a corner hit slides along the wall. `WALL_CONTACT`
  (restitution 0, friction 0.4) is on every chassis. There is no damage model, and the suite checks that none is
  named in any vehicle, physics or collision source. Manual: Ghost-mode collision.
- **Every street lamp near you is a real light, and every workplace has a lit ceiling.** The city's night lighting
  moves to three r186's clustered (Forward+) lighting (`src/01_Initialize_World/cityLights.ts`): the lamps' point
  lights live in a texture, a compute pass bins them once a render into a 48 × 27 × 24 grid of view-frustum cells,
  and each fragment loops over the few lights of its own cell, so the light count is a uniform and one lit shader
  serves six lamps or four hundred. Before, every point light was part of every lit material's pipeline key, so the
  page lit six lamps and no more; a region's asphalt had no painted pools either, so the lakefront metropolis's
  streets were dark under their lamps. Now the lamps nearest the player carry a real light after dark, as many as the
  tier allows (the governor's new `lampLights` knob: 32 on Minimal, 64, 128, 192, 256 on Ultra, 384 on Peak; about
  45 m around you on Minimal, 155 m on Peak at the city's lamp density), lighting the asphalt, the sidewalk, the people,
  the cars and the facades under them, warm sodium (28 cd at the head, 28 m reach: the night is drawn near the day's
  exposure, so a lamp is a fraction of the sun); the city ground's painted pools fade out inside that radius and stand
  in beyond it, as they always did. Every workplace (the city's six and a region's) gets four ceiling fixtures (18 cd,
  cool office white, always on) under a ceiling of white tile with a luminaire panel over each fixture, drawn by the
  building material. The grid is held constant (`CityLightsNode`), unlike
  three's node, which rebuilds its compute pass whenever the drawing buffer changes size and so re-keys every lit
  material: a tier step, a resize or dusk never recompiles anything, and a split-screen viewport bins its own grid
  over its own rectangle. A lite boot builds none of it (no point lights, no cluster grid: its lit shaders stay as
  short as they were) and under a headset the lamps go back to emissive heads (three's XR path is not the render the
  grid is computed for). Pinned by `cityLights.test.ts` (the nearest-lamp choice, the fixtures inside their rooms,
  the constant grid against three's rebuilding one) and `shadowShaders.test.ts` (every material still builds in both
  passes within the binding budget; the same lit fragment for 6 and 128 lit lamps and by day; the lite boot's has no
  grid). The page grows by 11 KB (three's clustered lights node and `cityLights.ts`), past the page budget main was
  at; the budget (`tools/verify/page_dist.mjs` `MAX_BYTES`) is raised here exactly as the voice pill's PR raises it
  (the same lines, so the two merge either way round). What CI shows:
  the browser job's frames on the software adapter; `tools/browser/shot.mjs` (new, below) photographed the lakefront
  and the city at night before and after. How it looks on a real GPU is unverified.
- **A screenshot tool for rendering changes.** `node tools/browser/shot.mjs --out DIR --query "map=lakefront&quality=3"
  --at "name,hour[,yaw,pitch[,x,z]]"` boots the built page once in a headless Chrome on the software WebGPU adapter
  (the way the browser smoke does, served from 127.0.0.1 with the isolation headers) and photographs it at any
  number of clock hours, head angles and places, the concierge's card skipped and the HUD hidden; it exits 1 when the
  page threw, logged a WebGPU error or a shader three could not build.

- **Accessibility: high contrast, colour-vision filters, text size, caption size.** Four settings
  (`07_Execute_Actions/access.ts`), kept between visits (`civic-simulation:access:v1`), set for one visit in the URL
  (`?contrast=`, `?vision=`, `?ui=`, `?captions=large|huge`; a change of another setting keeps only that one, so
  a URL's setting is not saved by it), read and written by the console's `access` and, the two
  most wanted on a phone, by the touch Menu's High contrast and Text size items. High contrast (`auto` by default:
  the operating system's `prefers-contrast: more`) is written onto the page's root (`data-contrast`) and flattens
  every frosted-glass card (`index.css`, keyed on the blur utility so every card holds without knowing) to white on
  black with solid borders and a thick focus ring, every light button inside one to black on white, the chosen one
  of a set (a wardrobe pill, a pressed toggle) the other way round (a colour swatch keeps its colour and takes the
  ring), and the status dots (a traffic signal's lights,
  the recording and recruiting dots) keep their colours, brightened and ringed; the colour-vision filter is one more 3×3 at the end of the post
  chain (`postfx.ts`, after the ghost composite), a daltonisation for a protan, deutan or tritan viewer (the Machado,
  Oliveira and Fernandes 2009 simulation, the lost colour shifted into the channels the viewer sees) and the identity
  otherwise, set through `Engine.setVision`, which keeps the post chain on at every tier while a filter is chosen
  (where the page turned the chain off, under the lite profile, a split screen, `?post=0` or a headset, the
  console's `access` says the filter is not drawn and why); the text size is a CSS zoom on every overlay's root (`--ui-zoom`,
  `.ui-zoom`: the HUD, Sloane, the wardrobe, the action card, the way-out and lock screens, the onboarding, the shops'
  card, the first walk's card, the touch Menu's sheet), never the canvas or the touch buttons, which are sized for thumbs (inside it, every
  length measured in the window's pixels, such as the touch buttons' edges or where the Menu's sheet opens, is divided
  by the zoom, so Sloane's card still clears the buttons at 200 %, and the Menu's sheet opens on the screen; a test
  reads every component's syntax tree for a full-screen overlay outside the zoom, or a zoom inside another); the
  caption strip has a size of its own. Checked in headless Chromium with a phone's touch layout: at 200 % the Menu's
  sheet opens on the screen at 360 × 740, 375 × 667 and 390 × 844 and in landscape, and at 150 and 175 % on a
  320 × 568 phone; there at 200 % Sloane's open card lies over the Menu button. The first walk's card (merged in from
  main) takes the zoom on a layer of its own: the room for it beside Sloane's open card is 60 rem at that zoom
  (`Concierge.tsx` `besideRoom`, 1,920 px at 200 %), and a window small at the zoom (`FirstWalk.tsx` `squeezedQuery`,
  the compact query times the zoom) puts it at the foot of the screen, where at 200 % a 1,280 × 800 or 1,536 × 864
  window gave it a strip 60 to 70 px tall under the zoomed readout (Chromium, before and after); high contrast
  flattens the ink panels (`.noir-panel`: the onboarding's and the first walk's) like the frosted ones. Verified by Node tests of the arithmetic (every filter keeps every
  grey and pulls the confused pair apart) and the settings, and by source pins over the page (`access.test.ts`,
  `accessWiring.test.ts`); how the filter and the zoom look on a real display is unverified.

- **The hands and the ears: dwell click, single-switch scanning, one-handed pad layouts, the screen reader's lines.**
  Four more settings in `access.ts` (`access dwell|scan|pad|announce`, `?dwell= ?scan= ?pad= ?announce=`). The dwell
  click (`04_Connect_Hardware/dwell.ts`) presses the control a pointer rests on for 0.6 s, its ring filling over
  that time, once per rest (a control replaced in the same spot waits for the pointer to move), never a touch, a
  real press or anything under pointer lock; single-switch scanning (`scanning.ts`) offers the page's controls one
  at a time every 1.2 s, focused and ringed, and takes the Space bar as the switch ahead of the city (on a field
  offered it takes the field; a control the browser will not focus as it is, a `role="button"` with no tabindex, is
  lent tabindex -1 for its offer so the switch's key reaches it, and given back once the focus has left it (on its
  blur, at the next offer, or when the focus lands anywhere, since a focus moved while the window is in the back fires
  no blur), never if the page wrote that tabindex itself meanwhile (a roving tabindex's "-1" too, watched with a
  MutationObserver); a field taken by the switch, focused any other way
  or typed into holds the round until 6 s pass without a key, and a space typed there stays one); the pad mapper (`gamepad.ts` `PadHand`, `Input.setHand`)
  gains a left-hand and a right-hand layout (one stick moves, and looks while its shoulder is held; that side's
  pedals and buttons; select is the run latch, which holds until the stick has walked and come home, a glance
  aside; start a ping, the stick's click the mute; on a pad without the standard mapping read by position with four
  axes or one stick (or not placed yet), whose d-pad and centre buttons are not read, the left hand keeps its stick
  and glance and opens doors with south, and the right hand reads with both hands unless the pad has four axes; a pad
  read in kernel order keeps the one-hand layouts, its d-pad being the hat on axes 6 and 7, and with six axes (no hat)
  the left hand opens doors with south and has no throttle or clock keys), and the action card, the way-out card and the lock
  screen take the same hand (`padNav.ts`: start presses for the left hand and moves on for the right; the glance
  shoulders never act there); and a live region on the HUD
  (`announcer.ts`, `customer.announce`) tells a screen reader of the district walked into once held, a vehicle
  beside you and what enters it, a seat taken or left, and every toast, oldest first, one line per 2.5 s with a
  short queue. Verified by Node tests over
  fake pages and pads (`dwell.test.ts`, `scanning.test.ts`, `announcer.test.ts`, `gamepad.test.ts`) and source pins
  (`accessWiring.test.ts`); a real head mouse, switch interface or screen reader is unverified.

- **The fallen wear their own bodies.** A pedestrian the realm promotes to a physical body (a shove, a kerb trip, a
  slip near the operator) is no longer hidden and replaced by grey capsules: the crowd's vertex stage hangs each of
  the body's fifteen bones from the rig shape it belongs to (`src/03_Spawn_Agents/humanoid.ts` `RIG_REST`,
  `rigPoint`; `crowdBody.ts` `bodyRig`), from the thirteen shape poses the realm already streams, so the suit, the
  face, the hair and the wardrobe fall with the person and stand up again, in the eye pass and the shadow pass
  alike. The rig slot rides the spare fourth figure word and the poses one uniform array (`crowd.ts` `rigPoses`),
  both written by the engine every frame; a test pins every bone's shape and standing centre to the realm's own rig
  tables. The fallen figure's row in the crowd's render copy is pinned to the rig's pelvis (`crowdCull.ts` `pin`),
  so the cull, the passage pulse and the code dissolve find the body where it lies and not where the crowd walks
  its twin, and a fallen body writes no motion of its own into the cinema camera's blur. `?rigs=capsules` brings
  the bare capsules back as a debug view; ghost view shows the rig's shapes either way. The rig is still the rig's
  one size (a 1.75 m adult), so a tall or short body's joints sit a few centimetres off its shapes while promoted.
  How it looks on a real GPU is unverified.
- **Feet that stay planted, heads that look.** Each leg of the crowd's body is solved from where its foot is
  (`src/03_Spawn_Agents/humanoid.ts` `footAt`, `legSolve`; `crowdBody.ts` `bodyFoot`, `bodyLeg`). The worker
  advances the walk phase with the distance walked, so a foot carried back linearly in the phase through its stance
  keeps its spot of ground (a test walks seven speeds, statures and headings and pins the planted ankle to a
  micrometre), rolls onto its heel at the strike and its toes at the push-off, and the pelvis drops what the planted
  leg cannot span at the ends of a stride, so the body rises and falls with the step instead of bobbing on a sine.
  Under half a metre a second the stride shrinks toward standing, so a person who stops stands with their feet
  together whatever the phase (and shuffles a little while slowing). The head and the chest turn toward the
  operator's eye when it is in front of them, within reach (whole to 2.5 m, gone by 4.5 m) and not their own
  (`gazeAt`, `bodyGaze`: one `gazeTarget` uniform the engine writes every frame, so the shadow looks where the body
  does; from a car nobody is looked at), and toward the way they go otherwise, the head leading a turn, the chest
  taking three tenths of the yaw. The card's silhouette runs the same arithmetic. The ground under the crowd is
  flat (kerbs are painted bands), so there is no height for the feet to follow. The walk and the gaze are
  hand-written arithmetic: no motion capture or animation clip. How the gait and the gaze look on a real GPU is
  unverified.
- **A layered wardrobe with dye channels.** Every look has a **layer** (the jacket, shirt sleeves or a coat), a
  **trim** (matching, or one of seven cloths on the lapels, the collar band and the cuffs) and a **scarf** (none or
  one of seven cloths). The coat is a shell of `src/03_Spawn_Agents/humanoid.ts`'s loft over the trunk, worn by
  the near and the far body, and owns the top's dye (seven coat cloths in the jacket's bits); the scarf wraps the
  neck on both bodies with a tail down the chest on the near one. The jacket's lines (the shirt's V, the lapels,
  the shirt's collar, the collar band, the cuffs) are no longer vertices: the fragment stage of `crowd.ts` cuts
  them from the rest position (`GARMENT`), so the shirt's slot leaves the loft and a trim costs the shadow pass
  nothing. The slot a band of the body paints is now a flat varying (each triangle its lower ring's), which ends
  the stripes a jacket's hem showed over the trousers. The look grows to thirty-two slots and a fourth packed word
  (`packWardrobe`), carried as the third of four words per agent in `crowd.figure`; look codes are twenty-eight
  symbols (`XXXXXXX-XXXXXXX-XXXXXXX-XXXXXXX`), and the twenty-one-, fifteen- and eight-symbol codes, the stored v3,
  v2 and v1 records and a roster's old looks are read and upgraded with the jacket, a matching trim and no scarf.
  The hashed crowd draws the layer, the trim and the scarf from the same chains (`lookFromSeed` reproduces them:
  one in five in shirt sleeves, three in twenty in a coat, one in five with a trim, three in twenty-five with a
  scarf). The card gains Layer, Trim and Scarf rows (the jacket's and the trim's hidden under shirt sleeves) and
  the console's `look` the three slots; the 14A pin gains the coat and the scarf (clothing, nothing held). Tests:
  the garment lines against the loft, the coat outside the trunk, look v4 round trips, upgrades and codes, the
  wiring and the air gap, every body material built under Node in both passes. The crowd's palettes now ride one
  uniform buffer: a buffer per palette reached thirteen in the fragment stage with the coats, the trims and the
  scarves, past the twelve WebGPU promises a stage, and no body's pipeline built; `shadowShaders.test.ts` now
  counts every material's bindings a stage against that promise. The garments' appearance on a real GPU is not yet
  confirmed: software WebGPU and CI's screenshots only.
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
  crowd's eight activities, the seven action verbs with their rules and hints, the skills and the eleven vehicle kinds
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
  Ultra's sun shadows with a wider sixteen-tap penumbra (it first drew them out to 160 m on an 8192² map of about
  512 MB; the cascades above replaced that, and Peak's shadows now take Ultra's 256 MB); and full-detail people out to
  90 m. Who is measured: a desktop with a discrete GPU or an Apple
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
- **NixOS: Ollama in one line.** `programs.crimson-noir-agent-city.ollama.enable = true;` in the flake's NixOS module
  runs Ollama as a service on this machine's loopback, `127.0.0.1:11434`, where the city's auto provider finds it once
  it has a model. The build is chosen by `acceleration` (`pkgs.ollama-vulkan` by default; `rocm`, `cuda`, `cpu`, or
  null for the service's own), since NixOS 26.05 removed `services.ollama.acceleration`; Vulkan and CUDA turn on
  `hardware.graphics.enable`. Ollama skips integrated GPUs by default, so `integratedGpu = true` sets
  `OLLAMA_IGPU_ENABLE=1` for a machine whose only GPU is integrated. `models` are pulled once it starts, `extraOrigins`
  become `OLLAMA_ORIGINS` (the launcher's own page needs none), host and port stay nixpkgs' own and the rest it sets
  are defaults the configuration can override, and it warns about a host off loopback, a port other than 11434, and
  an `OLLAMA_ORIGINS` set elsewhere. It works without the city's own `enable`. CI evaluates it in `nix flake check` on
  the pinned NixOS 26.05: loopback, the Vulkan, CPU and default builds, the graphics driver for
  Vulkan and CUDA only, CUDA refused until unfree packages are allowed, origins, models and the integrated GPU only
  when asked for, the system's own settings winning, the three warnings. The service on a real GPU is untried.
- **NixOS: a VM test of the Ollama option, run by CI.** The nix workflow's new `vm` job builds
  `vmTests.x86_64-linux.ollama` (`tools/nix/ollama-test.nix`), a NixOS VM under KVM with the flake's module, the CPU
  build and one extra origin, which checks that `ollama.service` comes up, that its server process's only listening
  TCP socket is `127.0.0.1:11434` and nothing else listens on port 11434, that it starts with no models, that
  `/api/tags` answers the launcher's origin and the extra one with 200 and another with 403, and that it runs with
  `OLLAMA_ORIGINS`. It is outside `nix flake check`, and fails on a runner without KVM. This is what the job checks,
  not a result: its first runs are the pull request that added it. The service, on a real machine or any GPU, stays
  unverified.
- **NixOS: Ollama's cloud off unless asked for.** The Ollama option gains `cloud`, false by default, which sets
  `OLLAMA_NO_CLOUD=1`; `programs.crimson-noir-agent-city.ollama.cloud = true;` leaves it unset. In the `vm` job's
  first run Ollama tried to reach ollama.com twice as it started, for model recommendations and for its cloud models'
  details (the VM has no network, so both failed). Read from Ollama's source at the version the flake builds, those
  two jobs are the only requests it makes on its own, and `OLLAMA_NO_CLOUD` stops both before their request, as it
  refuses cloud models, web search and web fetch with a 403; pulls are untouched (`models` and `ollama pull` still
  download from Ollama's registry). The console now says a cloud model was refused because the server runs none, in
  Ollama's words, where it used to report any 403 as the page's origin being refused. The option's variables
  (`OLLAMA_ORIGINS` and `OLLAMA_IGPU_ENABLE` as well as the new one) are now defaults on `ollama.service` itself
  (`systemd.services.ollama.environment`), not in `services.ollama.environmentVariables`, where a definition
  outranked, and dropped, a configuration's whole set given as `lib.mkDefault { ... }`; a value in
  `environmentVariables`, set in any way, wins over them, and replacing the whole set with `lib.mkForce` keeps them.
  While the service is on, the option warns when `OLLAMA_NO_CLOUD` does not turn the cloud off with `cloud` false, or
  turns it off with `cloud` true, reading the value as Ollama does (but for a vertical tab, a form feed and the
  Unicode spaces, which it does not trim) from the environment systemd gives `ollama.service` (the unit's own over
  `systemd.globalEnvironment`; an `EnvironmentFile` and Ollama's own `.ollama/server.json` are not read), so a value
  set on the unit or globally, or the unit's set to `null`, counts; the warning names the value there, or that it is
  unset. The `extraOrigins` warning, which read only `environmentVariables`, now reads the same environment and is
  worded the same way. `nix flake check` evaluates the default, `cloud = true`, the system's own values winning, a
  whole `environmentVariables` replaced or given as a default, and the warnings: the cloud one firing for Go's false
  spellings (`0`, `f`, `F`, `false`, `False` and `FALSE`), an empty value, a quoted `False` and the variable set to
  `null`, not for `1`, `true` or `no`, and for `1` with `cloud = true`, with the unit's and the global environment,
  the origins one with the unit's variable set to another value or to `null`, and neither with the service off. The
  `vm` job now also checks that the server runs with `OLLAMA_NO_CLOUD=1`, logs `Ollama cloud disabled: true` and, once
  both startup jobs have logged that they skipped ollama.com, that no line of its journal names it past the default
  `OLLAMA_REMOTES` in the configuration it logs, a list of allowed hosts, not a request (Ollama's debug logging is on
  in that VM, since both say so only at debug level; the check reads only the journal and captures no network
  traffic). This is what the checks are, not a result. Ollama on a real machine, and its cloud setting on one that can
  reach ollama.com, stay unverified.

- **Sloane holds a conversation.** Small talk and a question nothing in the city maps to ("how's it going", "who are
  you", "what is the meaning of life?") used to fall through to the two scouts and a "Nothing maps to that directly"
  line, and no model was ever asked to converse: the only request was a 4 s rewording of that line. The planner now
  reads a message that is talk and nothing else, and such a question, as talk (`src/06_Make_Decisions/intent.ts`
  Brief.chat: nobody sent, nothing applied, no why asked); a talk word beside a goal, an "I don't know" beside a thanks,
  a request worded as a question, a question about the city's whereabouts and a wish to send someone read as before.
  The card puts talk to the page's mind as Sloane (`src/07_Execute_Actions/onboarding/voice.ts` sloaneChat): the
  person's words through the 14A prompt screen first (refused words reach no model), Sloane's framing and the last
  eight turns, the reply streamed in whole words through `admitWords`, cut and stopped at the first action line as
  `actions.ts` reads one (new `actionCut`), no deadline of its own beyond the router's. The field stays open for the
  next turn, where a goal is still a goal; while a reply is on its way the next message waits, with **Stop**. With no
  model answering, Sloane says so plainly and offers **Choose a model file** (the Menu's picker, now reachable on a
  computer without the console), the local-server route with the `OLLAMA_ORIGINS` note, and **Ask again**. The
  "Company" note no longer says nobody holds a conversation, and covers talk aimed at anyone but Sloane.
  `chat.test.ts` and new cases in `intent.test.ts` cover it; the conversation's quality and speed with a real model
  are not verified in CI.

### Changed

- **The crowd's shader writes its hash once and its three cloths once, and the turtleneck reaches up the neck.**
  three's `hash` node was written out inline at every use (110 copies in the suit's near fragment stage, 39 in the
  vertex stage). `crowdBody.ts` `crowdHash` is one WGSL function with the same arithmetic, so each stage carries it
  once and no look on the street changes: `humanoid.test.ts` compares it with `look.ts` `shaderHash` bit for bit over
  seeds 0 to 100,000, every link of every agent 0 to 20,000, and large, fractional and negative seeds. The shirt, the
  bottom and the top cloth are declared once in the fragment stage, and the turned cuff multiplies its cloth by a
  factor instead of selecting a second copy of it, pixel for pixel the same. Measured in `shadowShaders.test.ts`, the
  worst near main fragment stage goes from 221,913 characters (the pantsuit's) to 172,390 (the suit's) and the worst
  far one from 173,039 to 139,888, and no vertex stage is over 54,921; the tattoos above spend 11,338 of the near
  stage's saving. The turtleneck under a jacket or a coat now knits up the neck to the chin ring (below y 1.578 on the
  head bone), where it used to stop at the collar line and leave the neck bare; `look.test.ts` pins the gate, and
  `shadowShaders.test.ts` now holds every near body's main fragment stage to 225,000 characters.
- **The page is about 2.8 MB smaller.** The physics engine's WebAssembly (Rapier's compatibility module, 3.3 MB of
  code) rode in the page as plain base64, 4.4 MB of text and about a third of the file. The build now stores it
  deflated, about 1.6 MB as base64, and the physics worker inflates it with the browser's own DecompressionStream as
  Rapier starts, the way the in-page model's runtime already rides (`vite.config.ts` `rapierDeflate`, `deflateRapier`
  and `INFLATE_HELPER`). The deflater is fflate's (plain JavaScript, shipped with three) rather than Node's zlib,
  whose output differed between CI's Node and the flake's, so the flake's page stays byte for byte npm's. The inflater checks the size it gets back, and a Rapier upgrade that moved its
  initialisation, carried two, or carried bytes that are not WebAssembly stops the build instead of shipping a page
  whose physics cannot start. `dist/index.html` went from 14,806,761 bytes to 12,005,697; the page size limit in
  `tools/verify/page_dist.mjs` is unchanged. `src/rapierDeflate.test.ts` deflates the installed package, runs the
  page's inflater in Node and gets the package's module back byte for byte, and checks the built page carries no
  plain copy; the browser smoke boots, walks and drives on it.
- **The prosthetics atelier sells its four limbs.** They were on order, waiting for limb slots the wardrobe gained
  under other names (`prosthetic` and `prostheticFinish`, `look.ts` PROSTHETIC and WARDROBE.prostheticFinish). Each
  line now sets the limb and its finish, and its name says the side: the brushed-titanium right arm (chrome), the
  matte carbon-fibre left arm (carbon), the carbon-fibre right lower leg (carbon) and the skin-matched silicone left
  leg (skin-matched). Ids, bits, levels and prices are unchanged. The running blade is renamed the right lower leg,
  because the crowd draws a shin and an ankle in the chosen finish, not a blade. The wardrobe still sets any limb,
  side and finish at no cost. `storeCatalog.test.ts` checks each line's limb and finish on every preset body. The
  manual no longer lists the hearing processor as on order: it went on sale when the wardrobe gained `hearing`.
- **A car in traffic is nobody's to take.** The only car a player may enter is a parked one: the realm's door
  (`simCore.ts` `#interact` asks the fleet for the nearest parked car; a car in traffic within reach gets the toast
  "that car has a driver", or "that car is being driven"), the console's `intent` (refused on an AI car: park it
  first with `setMode parked`), and a network room's garage (`garage.node.ts` `whyNotEnter`: a car the room does not
  hold must be a bay car standing in its bay within 0.5 m, turned at most 0.1 rad, upright, at a car's height and at
  rest; a lane car is refused, `enter: car N has a driver`). The earlier door for a moving lane car (on its ring's
  lane within 1 m, facing along it, at the ring's speed or under) is gone; the fleet is still measured against that
  envelope in `garage.node.test.ts`. The room tests (`mirror.node.test.ts`, `authority.node.test.ts`,
  `parity.fuzz.test.ts`, `simPlayers.test.ts`, `simCore.test.ts`) take bay cars now. Manual: Vehicles, Networking.
- **Players pass through players.** The avatar's controller skipped dynamic bodies and sensors and now skips
  kinematic bodies too (`src/07_Execute_Actions/player.ts` `PASS_VEHICLES`), as the one contact rule says of two
  players, so in a room two people at the same spot never block each other; a wall still stops both. A chassis
  carries `WALL_CONTACT` instead of Rapier's default contact (friction 0.4 where it was 0.5; restitution 0 as
  before, now stated and tested: a bounce would live in the solver's warm-start, which a car rebuilt from a room
  correction cannot copy, so the room's replay would part from the page's at every wall, `mirror.node.test.ts`).
- **The web copy on GitHub Pages follows main by itself.** `.github/workflows/web.yml` ran only when someone started
  it, so the public copy fell behind main (it last showed the Oct 31 build). It now also runs each time ci passes on
  main (a `workflow_run` trigger on ci, main only): it builds the commit ci tested and publishes it only while that
  commit is still main's tip, asked before the build and again before the deploy (so re-running an old run's failed
  jobs cannot put an old build back). A burst of merges is published once, after the last one's ci passes, and the
  copy never steps back to an older build or shows a commit ci has not passed. A failed or cancelled ci, or one for a
  pull request (a fork's branch named main included), publishes nothing. Run workflow still publishes main by hand.
  The trigger takes effect once the file is on main; what it does there is not yet shown by a run.
- **The physics realm's step is a quarter to a third faster: the street furniture is a hundred compound sensors,
  not 4,599 colliders.** rapier.js walks every collider in the world through a WebAssembly-to-JavaScript callback at
  the end of each `world.step()`, so the city's lamps, trees and signal poles (sensors nothing in the realm touches or
  queries) cost every step about 0.6 ms and 1.4 MB of garbage. `physics.ts` now packs them into one compound sensor
  per 80 m tile, each pole the same cylinder where it stood. Measured in Node on a four-core container, best of three:
  the realm's whole step (`SimCore`, the city, 600 steps) 1.78 → 1.32 ms with 36 cars and 2.27 → 1.49 ms with 48 cars
  and a stand-in crowd; the world's step alone 0.73 → 0.30 ms and 2.26 → 0.86 MB of garbage a step. A bonnet ray costs
  the same as before (it excludes sensors inside Rapier). The cars' poses over those 600 steps hash the same as before,
  to the bit. A new `physics.test.ts`
  keeps the one-sensor-per-pole world as the reference and holds the packed one to it: the same poles along 4,000
  seeded rays (to Rapier's ray-cast tolerance: under a millimetre, a few millimetres at a graze), every pole found inside
  its rim on all four sides and under its top and not just outside them, every pole in one compound sensor on the fixed
  body, and every one of 2,000 seeded solid rays answered exactly as before.
- **The flow field's CPU solve is 3.3× faster, and allocation-free once warm.** The bucket queue and the direction
  pass (`src/06_Make_Decisions/flowField.ts` `solveDial`, `directions`), which the physics worker runs for every
  new goal whenever the field is not solved on the GPU, now work over the grid padded by a ring of blocked cells, with
  the eight neighbours as flat tables (`NEIGHBOUR_DI`, `NEIGHBOUR_DJ`, `NEIGHBOUR_COST`, `NEIGHBOUR_DX`,
  `NEIGHBOUR_DZ`), a byte per cell of open steps built once per grid (and again whenever the grid's weights are
  written), one doubly linked list per bucket threaded through two cell-indexed arrays, and a working set kept per
  grid, instead of a tuple destructured per neighbour, a bounds test and three weight loads per step, and a growable
  array per bucket. Measured in a four-core container under Node 22: the city's 320 × 320 grid from 18.7 ms to 5.3 ms
  a solve, the Lakefront Metro grid (1280 × 1280, 1.6 M cells) from 495 ms to 150 ms. The field is the same to the
  bit: a test holds both solvers to the tuple form, kept in the test as the reference, over sixty random mazes (heavy
  cells; repeated, blocked, off-grid and fractional goals), a handmade cost field and the city, with a cell blocked,
  reopened and made road between solves, and the relaxation (the GPU's own pass, unchanged) still reaches the same
  fixed point. A branchless pick in the direction pass was measured too and was slower under V8; the branch stayed.
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
- **auto can give Ollama a bigger model it already has, by the GPUs' memory.** Given the GPUs' memory (`ask vram
  <GB>`, kept in this browser, or `vram=` in the address, which the NixOS launcher now adds from `nvidia-smi` or the
  amdgpu driver), provider `auto` measures an Ollama answer (one `GET /api/ps` on this machine) and then answers with
  the largest text model Ollama already lists that fits the figure less 2 GB by that measure. A model whose weights
  alone exceed the figure is never chosen while a smaller one is listed; a bigger model that is slow, or split between
  the GPU and the processor when its first wait runs out, is dropped for the visit, and one too big in two visits is avoided until `ask vram`. The
  console's `fit` row says which model and why; `ask model auto` hands a chosen model back to auto; under auto, a
  model Ollama lists at over 60 GB gets longer to start answering (a second per 200 MB). Without a figure only that wait changes: the same requests and
  the same model. The 2 GB reserve, 5 tokens a second over 32 tokens, two visits, 200 MB a second and the launcher's 4 GB
  floor are starting values, not measured. CI proves it in Node against a fake Ollama and a stubbed `nvidia-smi`, and
  in the browser smoke on a software adapter (the row and the commands); no real GPU ran it. Nothing grows on a phone,
  and in a browser on Windows the figure has to be typed (`ask vram`; the Windows app reads it, below); on NixOS the
  launcher also counts an integrated Radeon given 4 GB or more by its firmware (not tried on one; `-- vram=0` sizes
  nothing). Nothing is downloaded, and
  the page still addresses only this machine.
- **auto finds llama-server, vLLM and SGLang on their own default ports.** With the three usual addresses, provider
  `auto` now asks llama-server's new default `http://localhost:9931` (since build b11521), vLLM's
  `http://localhost:8000` and SGLang's `http://localhost:30000`, at the same moment (each given 2 s, as the usual three are), and uses
  them only when none of the usual three has a text model. The first with a text model answers and is kept as that
  provider's address, as `ask server` would keep it (and the old default goes into this second round, so auto finds
  it again if the server moves back). It never looks past an address the operator set that is not one of these,
  never moves a provider to a server that lacks the model chosen for it, and never takes the gateway's address for
  one. Nothing listening there goes unsaid; a server there refusing the page or holding no text model is named, and
  on an isolated page the reason names vLLM's `--allowed-origins` flag when nothing answered on 8000. CI proves it in
  Node against fake servers by port, and in the browser smoke (a fake llama-server answering as `localhost:9931`); no
  real llama-server, vLLM or SGLang ran it. The addresses are on the same loopback host, so the air gap is
  unchanged.
- **The Windows app reads the GPUs' memory itself.** Auto's Ollama model no longer needs `ask vram` typed in the
  Windows app: as the city starts, the app asks DXGI for each hardware adapter's dedicated memory (one new command,
  `gpu_memory` in `src-tauri/src/gpu.rs`, read only) and the page sums the adapters of 3.5 GB or more, rounded down to
  0.1 GB, as the NixOS launcher sums. DXGI reads a card a little under its size (one 4 GB card is reported at
  3,949 MB), hence the floor under the launcher's 4 GB: a 4 GB card counts on both. The console's figure and `vram=`
  in the address still beat it, `ask vram 0` turns it off, and with no adapter counted (an integrated GPU's usual
  share) nothing changes. An integrated Radeon given 3.5 GB or more is counted, and a data-centre card in TCC or MCDM
  mode is not seen (type `ask vram` there). CI proves the page's side in Node (the rule, the order of figures, a fake
  shell that answers oddly, refuses or hangs, and the launcher's sum and rounding) and compiles the app on Windows; no
  Windows machine ran it.
- **Ollama's context and answer length grow on measurement, for the visit.** Under `auto` with the GPUs' memory given
  and Ollama in the generate format, an answer cut at its 2,048-token limit on a model auto chose, measured all on
  the GPU at 8,192 tokens of context (Ollama's own `context_length`, v0.10.0 and later), fast enough to write the
  longer answer in 5 minutes, and with room under the figure less 2 GB, doubles that model's context once, to 16,384,
  with answers of up to a quarter of it (4,096). The first answer there is measured (one more `GET /api/ps`): split,
  all on the processor, slower than 5 tokens a second, refused by Ollama, or failing in Ollama after some of the
  answer arrived goes back to 8,192 for the visit and does not grow again (a refusal or a failure goes back whatever
  setting changed meanwhile; a refusal of an ask's first answer before any of it arrives answers that ask once more
  at 8,192, its one retry, unless a setting changed or a stop came with it; a failure partway is not answered again,
  since its text was shown; a first wait that runs out with the model split or on the processor goes back too),
  and a smaller context Ollama reports (the one it was trained on), with the model all on the GPU and not slow
  there, is used when above 8,192. The moved model's retry and the answer after a new look, when at a larger context, are measured and go back
  the same way, with no answer after them; Ollama not answering there leaves the context. Each answer's context is
  worked out once, as it is sent, and its body, its measurement and what counts as an answer at that context all
  take that one; an answer that ends after the figure has gone is not measured. It never sets a model aside by
  itself, and only measurements at 8,192 are kept, so the step up is decided as without it (a moved model that will
  not load at the larger context is set aside only once it fails at 8,192 too, so later); what `/api/ps` says once
  any answer to that model at another context ran since the measured one was sent, measured or not, is no
  measurement; nothing of it is kept between visits, and `ask vram` starts it over. The `fit` row gains a clause
  once a context grew. Without a figure, in the chat format, for the operator's own model and under
  `ask provider ollama`, every request is today's, byte for byte. The quarter, 32,768 at most, one doubling a visit,
  the 1 GB least cost and the 5 minutes are starting values. CI proves it in Node against a fake Ollama; no
  real GPU or real Ollama ran it.

### Removed

- **The full-screen contact wipe.** The iris of code that opened from the centre of the frame on every contact
  (ghost view's composite, `contact.ts`) is gone: a passage shows on the mesh passed through alone, and the post chain
  no longer turns on for one. `output.contact.wipe` in the telemetry is now `output.contact.passage`, the same
  envelope, which nothing draws.

### Fixed

- **A newly published build of the web copy is what the next launch runs.** The service worker answered every launch
  from its copy and fetched a new build in the background, so the build a phone ran was always one launch behind the
  host (two reloads after every publish), and a copy that could not start had to stay alive through a 7 MB download
  before it could be replaced. Now the host decides and the copy delivers (`tools/web/pwa.mjs` `worker`): on a page load
  the worker asks the host for `build.txt` (new: the published build's cache name, some forty bytes, never kept and
  never from the browser's cache) with a two-second deadline; the same name, no answer in time, an offline phone or
  anything else, and the copy answers as before; another name, and the page is streamed from the host's fixed
  `index.html` (not the address that was opened, so no query string is a download of its own), isolated like the copy,
  while the new build's own worker keeps it in the background, after the launch's own download: the worker handing the
  page on holds a named lock until that page is over, and a newer worker's install waits for it, half a minute at most
  (Safari starts that install a second into the launch, and two downloads side by side would halve what the pace rule
  sees of the link; on a first visit the page now registers its worker at its load event, for the same reason). A launch
  is not left to a bad link: the host's page must begin within four seconds, and one that then brings nothing for more
  than five seconds, breaks, or averages under 600 kB a second after its first four is given up, and the launch starts
  from the copy. The worker holds back the page's first 32 kB (they carry the page's watchdog; the builder refuses a
  page where they do not): given up before they have come, the copy's body takes that very answer over, with no second
  load; given up later, the page ends cleanly where it stopped (an errored or open body would leave a splash with
  nothing to press) and the page's watchdog (`index.html`), finding at load that its script never ran under a worker,
  loads the page again, once a minute a tab at most, which the copy answers; the card with Restart only after that. The
  worker then leaves the host alone for up to five minutes of its own life. A page that keeps its pace is never cut;
  with no copy there is no deadline either, the host's page is waited for and nothing is given up. Install now asks the
  host past the browser's HTTP cache and keeps a build only when the page carries that build's stamp, so a deploy caught
  half way cannot file the older page under the new name; it reads the small files whole before it asks for the page,
  because a browser lets a worker hold only a few answers whose bodies nobody is reading (an install that waited on all
  five headers first never finished in Chrome, which the browser run caught). The build word covers what is published
  (the page as published, the manifest, the icons, the worker's own text), so a changed icon or worker is a new build
  with a cache of its own. No request the worker answers writes a cache. `webApp.test.ts` runs the worker against a
  scripted host that holds back a fourth unread answer as Chrome does, and a clock the test turns (every refusal,
  deadline, pace and query string; sixty-four deliberate breakages of the worker and the builder each fail a test), and
  `bootWatchdog.test.ts` the page's one load again; CI's `pwa` scenario publishes a second build into the served folder,
  first over a link that goes quiet a megabyte into the page (the page loads again by itself and the copy starts), then
  over one that goes quiet in the page's first bytes (the copy answers that very load), then whole: it runs on the very
  next load, isolated, is kept by its own worker with the older copy dropped, and starts offline. A phone holding the
  worker from before needs one launch online to get this one. On GitHub Pages a new build's name can take up to ten
  minutes to reach a phone (the host's delivery network). Not verified on a real iPhone (Safari streaming the host's
  page through a worker, ending one it gave up so that the page loads again, and its locks between two workers). Manual:
  On an iPhone (the web app).
- **Standing still, both legs.** In a shop's mirror the player's own body showed one leg: the other had swung half a
  turn up through the hip and into the trunk. Anyone standing still has a stride of nothing, so the walk's leg solve
  (`src/03_Spawn_Agents/crowdBody.ts` `bodyLeg`) got the foot's distance ahead as a zero of either sign, and took the
  thigh's line from `atan2(-dz, -dy)`. For a negative zero over a positive x IEEE gives that zero, but the software
  WebGPU adapter (SwiftShader, which CI and the project's pictures draw on) gives pi, as a compute pass on it showed:
  hip 3.112 radians for one leg instead of -0.03. Passers-by walk, so their feet are never exactly under the hip, and
  they kept both legs. A foot straight below the hip now takes the line's zero, on the GPU and in the CPU twin
  (`humanoid.ts` `legSolve`). `humanoid.test.ts` runs `bodyLeg` through `wgslHost.ts` (which learned `asin` and `acos`)
  with a stand-in for the adapter's `atan2`; the test fails without the fix. Mirror pictures from the software adapter
  show both legs from every side. Whether a hardware GPU ever did this is unverified.

- **A start whose GPU goes away while the crowd is built starts again on the light kernel, instead of stopping at
  "Instance dropped in popErrorScope".** A Mali-G52 phone showed "init: Instance dropped in popErrorScope" on the
  card: Chrome's words for an error scope popped after its GPU process has gone, which takes every WebGPU device of
  the page with it (the physics worker's and the page's own). A kernel the driver refuses leaves the device alive and
  the ladder steps down in place; a kernel the driver dies on cannot be stepped past, and the old code read the dead
  device's rejections as one more refusal. Now `gpuPipelines.ts` asks the device whether it was lost before a failed
  compile counts as a refusal (`lossOf`, `DeviceLostError`; `withErrorScopes` pops every scope it pushed when the
  build throws), the worker stops at the kernel it was building and tells the page (`kernel-lost`; every ladder step
  is posted before the compile it announces), and the page remembers what it learnt of this GPU in this browser
  (`crowdKernelMemory.ts`, new: a refusal moves the next start to the next rung; a loss to the light kernel; the light
  kernel's own loss to none for an hour, a day once twice running; one loss is asked about again a day later, a
  refusal a week later; the record holds only for the same kernels, user agent and adapter). After a loss under a
  kernel the page starts again by itself, once, with `?kernel=lite` (new address word: `lite`, `narrow`, `full`),
  waiting first for the browser to hand out a GPU again (`gpuDevice.ts` `gpuBack`); it never does so twice in two
  minutes, never when the address named the kernel, never when it would be the GPU's third loss in five minutes, and
  never where the browser keeps nothing for the page.
  New cards: "The browser’s graphics stopped while building the crowd" (Restart goes to the lighter kernel), "The
  crowd keeps stopping this device’s graphics" (no kernel left; says how long the GPU is left alone, and a start
  inside that time asks for no adapter), and "The browser has paused graphics for this page" for Chrome's own pause
  after two losses within two minutes (measured in Chromium 153; it used to read as a device with no adapter). A boot
  that fails gives its worker up at once (`simClient.ts` `SimBootHooks.signal`), a device handed over already lost is
  no kernel's fault, and a loss while the page was hidden blames none. The card's details line now names the web
  copy's build (`tools/web/pwa.mjs` stamps the page with it) and, where the browser offers them, the phone's real
  model and versions; `hardware` says why a lighter kernel runs. CI's browser job kills Chrome's GPU process as the
  worker asks for the full kernel (the city then stands on the light one, remembered, the address clean) and again
  under the light kernel (the no-kernel card, then a start that asks for no adapter), under software WebGPU;
  `crowdKernelMemory.test.ts`, `gpuPipelines.test.ts`, `bootFailure.test.ts`, `realmBoot.test.ts` and
  `recoveryWiring.test.ts` pin the rules, the words and the wiring. Whether the phone's driver survives the light
  kernel is not known until it is tried there. Manual: When the city cannot start or stops.

- **The first walk's way out works from wherever you stand.** `spawn_subagents` asked only people within 5 m, and its
  loop stopped at the first skill nobody near knew (Robotics), so the exit program answered a swarm of 0 and
  `unlock_city` refused. The walk's own workplace stage leaves the visitor inside a room, where nobody can be asked
  over at all, so on the accessible path the uncloseable walk could not be finished (seen on the live copy). Now the
  exam sets its swarm to work through the same team runner Sloane's goals use (`onboarding/exam.ts`, `App.tsx`,
  `dispatch.ts` `swarmTeam`): one lane a sub-agent, dealt round all sixteen workplaces' desks, opened from anywhere,
  with anyone within earshot who has a desk's skill asked over by the runner. It answers with the lanes still running
  after their first tick, says which team it replaced, caps at the runner's 32, and opens nothing while the page is not
  contained or the realm is halted; on a map without workplaces (a surveyed region) it says the lanes read around
  where you started and that nobody is asked over. The swarm stays at work after the city opens (`lanes`, `lanes
  stop`), and the MIC chip counts a team at more than four desks in workplaces ("Team 24 · 16 workplaces") rather
  than naming all sixteen. The walk stays uncloseable. The browser smoke's `walk` scenario now runs the program from
  where the workplace stage leaves the visitor, checks that nobody within earshot could be asked over there, and reads
  the swarm back with `lanes`.

- **A phone whose GPU refuses the crowd's kernel gets a lighter one, and a card that says what the GPU said.** Chrome on
  an Android phone (a Mali-G52) stopped at the boot with "crowd.wgsl pipeline validation failed: [Invalid
  ComputePipeline "crowd.simulate"] is invalid due to a previous error. - While Validating GetBindGroupLayout (0)". Not
  a limit the crowd was over: every pass sits within the limits WebGPU promises every device (simulate binds exactly its
  eight storage buffers, a 128-wide workgroup, an 11 KB uniform, no extension). The pipelines were built with
  `createComputePipeline` inside a validation error scope, which keeps only the first validation error; a GPU driver
  refusing to build a kernel is an *internal* error in WebGPU, which that scope never sees, so the first validation
  error it saw was the follow-on one, which names nothing. `src/01_Initialize_World/gpuPipelines.ts` (new) compiles a
  module's passes with `createComputePipelineAsync`, whose `GPUPipelineError` says whether WebGPU refused the shader
  (validation) or the GPU's own compiler did (internal), in the browser's words, with the module's compilation messages
  (line, column and the source line quoted); the crowd's buffers, bind groups and spawn stand under validation,
  out-of-memory and internal scopes at once (the page's cull and the flow field's solver the same). When the full
  simulate pass is refused for anything but an error in the WGSL itself (the GPU's own compiler, which Chrome reports as
  an internal error and Safari as validation; a pipeline rule), `crowdSim.ts` climbs down a ladder of kernels
  (`crowdCompute.ts` `CROWD_KERNELS`), every refusal kept for the record: the same module at 64-wide workgroups (a phone
  GPU's core seats fewer threads of a kernel this size than a workgroup of 128 asks for), then the light kernel,
  `crowdWayLite.wgsl` in the place of `crowdWay.wgsl` (new: the room and lot routing moved out of `crowd.wgsl`, the
  functions unchanged), which walks someone asked over indoors by the straight line, or round the first piece of
  furniture in its way by a corner, and onto a lot by the straight line, instead of the trail following and the
  lot-corner search; the First-Law sensing, the contact, the containment, the detour round standing cars, the commute
  and the flocking are the same `crowd.wgsl` on every rung. The recovery card has its own words for the driver ("This
  device's graphics driver couldn't build the crowd": update Chrome and the phone's system software; on an iPhone, iOS,
  whose graphics come with it), names the adapter when the boot fails before the engine stands, and its details carry
  the driver's words, the kernel it refused and the worker's uncaptured GPU errors; `hardware` at the console names the
  kernel that runs on a row of its own. `crowdCompute.test.ts` pins every pass of every kernel within the default limits
  (bindings a stage, workgroup size and storage, the uniform, every buffer and every dispatch at the largest crowd), the
  narrow kernel as the full module at half the width, the light kernel's drops and keeps, and the ladder with its
  messages; `bootFailure.test.ts` and `commands.test.ts` pin the card's words and the console's row. The browser job now
  compiles every rung's five passes under Chrome's software WebGPU as well (`tools/browser/kernels.mjs`, `checks.sh
  page-kernels`), the evidence the fallback kernels keep compiling where no runner has a phone's GPU. Whether that
  phone's driver accepts the narrower or the light kernel is not known until it is tried on one; if it refuses them all,
  the card now shows what it said. Manual: When the city cannot start or stops.
- **The page no longer ships its shaders' comments.** The `.wgsl` files are imported as text, so the single file carried
  every comment in them, and the crowd's shaders twice (the page's bundle and the physics worker's): about 83 KB that no
  GPU reads. With the light kernel's file, the phone layouts, the context growth and the customizer's shoes, frames,
  watch and pin together the page came out 8 KB over its byte budget (`tools/verify/page_dist.mjs`); rather than raise
  the budget, the build now hands over each shader without its comments (`vite.config.ts` `leanShaders` in the page's
  plugin list and the workers', `src/01_Initialize_World/leanWgsl.node.ts`; the dev server serves the same text). Only a
  comment's text and the spaces before it go: every line keeps its number, so a compilation message on the recovery card
  still names the file's line, and each file's licence header stays word for word. `leanWgsl.test.ts` pins every shader
  line by line against its source, WGSL's comment rules (nested blocks, every line break the language has) and the
  plugin in both lists; `tools/browser/kernels.mjs` compiles that same text in the browser job.
- **A chat-format server with a small window answers a long prompt instead of refusing it.** The chat format
  (`09_Cognition/localCompute.ts` `chat`, used for llama-server, LM Studio, vLLM, SGLang and Ollama's chat format)
  always asks for answers of up to 2,048 tokens, and SGLang from 0.5.10 and vLLM up to 0.15 (by their sources,
  vLLM's read back to 0.5.5) refuse with 400 when the prompt and that cap together are longer than the model's window
  (SGLang up to 0.5.10.post1 also when they fill it exactly), so the agent gave no answer, only a sentence saying the
  server failed (400). Now a 400 that says, in SGLang's sentence or either of vLLM's (one up to 0.10.0, another from
  0.10.1), the window and the server's count of the prompt is sent once more, the same body with the answer cap
  lowered to one token under the window less the prompt, when the window less the prompt is at least 256 tokens
  (`ANSWER_MIN_TOKENS`, a starting value); with less, one sentence says the prompt leaves no room in the model's
  window. SGLang before 0.5.10 sends this refusal inside a streamed answer, and vLLM 0.16 to 0.31 in other words with
  the prompt's count cut short, so there it reads as before; vLLM 0.32 lowers the cap itself. The cap only comes
  down, by the server's own numbers and never an estimate: a request a server accepts is sent byte for byte as
  before, any other 400 reads as before, the retry is sent once and under the same stop and waits, and one that
  cannot reach the server or is refused this page (403) is the server's failure, so auto neither looks again nor
  answers twice for it. `localCompute.test.ts` pins the three sentences, copied from the servers' sources with the
  file and line, against fake servers on this machine: each retries with one token under the window less the prompt,
  2,048 and 256 tokens of room retry (with 2,047 and 255) and 255 does not, a second refusal is the answer, a 403 on
  the retry or one that cannot reach the server is the server's failure and any other failure of it keeps its own
  code, a stop during the retry closes it, so does what is left of the answer's one first-piece wait, and other
  bodies and statuses are as before; `router.auto.test.ts` shows one ask sends at most one more request for it. No
  real SGLang or vLLM ran it.
- **The first walk's card on phones.** Upright, the card stood over Sloane's name question on every first run (390 ×
  844), and held sideways it was squeezed into a strip 30 to 50 px tall above the thumbs, over her chip. Now
  (`onboarding/FirstWalk.tsx`): anywhere but the wide side-by-side place it steps aside while her card is open; upright
  it stays under her chip (`--chip-bottom`) and above the buttons; sideways it stands between the stick and the buttons
  (`--touch-left`), above the HUD's chips at the foot (`--hud-foot`, published by the compact HUD and by the hidden
  HUD's captions). Where that band is short of 8 rem (a large text size, captions or a shop's chip at the foot),
  Sloane's chip moves up to the top row and the card rises under it over the HUD's header and readout, both reading
  one CSS step (`Concierge.tsx` `CHIP_TOP.walk`) on the foot latched at its highest until the window changes size
  (`footPeak.ts`), so captions coming and going never move them. At the wheel sideways the card steps aside (the
  car's buttons fill the band) while Sloane still says its lines, and the touch Menu's sheet now opens over the card
  (`TouchControls.tsx`, z 1060). The browser smoke's new `walkphone` scenario checks all of it on an iPhone: the card
  away during her question, clear of her chip, the minimap, the foot chips and every touch control upright, at
  874 × 402, 844 × 390 and 667 × 375 sideways and at 125 % and 175 % text, under the Menu's sheet, the latch held and
  let go, and the wheel both ways; it fails three ways on the old layout. A real phone is unverified.
- **Craft show red to port and green to starboard, and planes bank into their turns.** A craft's body has its right
  side on +z under the view's yaw (`craftView.ts`), but the drone's and the plane's red light sat on +z, and a plane
  rolled its outer wing down through a turn. The side lights move to their own sides (the new ferry's too), the bank
  lowers the inner wing, and `craftView.test.ts` now pins both: every side light on its side of the body, every
  craft's +z on the right of travel as the stream places it, and the plane's right wing down in a right turn. The
  drawing only; no craft moves differently.
- **A scrape along a lot wall replays to the bit.** The city's lots are boxes that overlap (a plinth, and buildings
  raised from the street inside it), so a street face was two solid faces in one plane up to the plinth's top. A
  chassis working its corner along it got two identical contacts, and how Rapier split the impulse between them
  depended on which other bodies shared the broad phase's cell (the traffic beside a kerbside bay): the page's car
  and a network room's replay of it parted by one float32 step a frame (15 µm at 150 m, 13 mm after ten seconds),
  and the room put an honest driver back every frame of the scrape; a steady slide along the doubled face also paid
  two frictions for one wall. `src/07_Execute_Actions/physics.ts` `solidBoxes` clips a box standing inside another
  to the part above it before the colliders are built, on the page and in the room alike (a box wholly inside is
  left out; boxes on top of, beside or straddling another are as they were; what is drawn is unchanged).
  `solidBoxes.test.ts` pins the clip, counts the city's clipped boxes (hundreds a seed) and replays the scrape beside
  thirty-five cars to the bit; `authority.node.test.ts` and `parity.fuzz.test.ts` drive bay cars along their lot
  walls and are never put back. Manual: Ghost-mode collision.
- **A walking skirt let the swung thigh through its front, a leaning one let the shin through its side, and a midi's
  hem stood out ahead of the knee.** Before this, a skirt hung from the trunk alone except for the part of its hem a
  thigh carried, and that part tapered to nothing at the sides. On the CPU, at a brisk walk, the leading thigh came
  about 6 to 18 cm through the front of every cut. A worker leaning sideways at a desk, or a body pushed from the side, let
  the shin through the hem's side by up to 6.5 cm. A midi's hem, bound to the thigh's lever, rose 18 to 19 cm and
  tilted 60 to 64 degrees from vertical mid-stride. Now every cut but the straight one (0, the skirt as it always
  was) follows the legs fully from the knee-level ring down. The front goes with the leg that carries it furthest
  forward and the back with the one that carries it furthest back, handed over across 10 cm of the difference, so the
  hem never jumps from one leg to the other as the stride crosses over. The sides follow the leg on their own side. A
  midi's hem below the knee hangs from the shin, bent by 0.6 of the knee's bend, so the calf never kicks the hem's
  back inside out. Each cut's follow is about the least that keeps the legs inside. In the same model,
  measured where each leg vertex stands, on a neutral, a slumped, a long-legged and a short body at a walk, the legs
  stay within 1 cm of every cut but the midi pencil (within 2 cm), no hem point moves more than 4.5 cm in a 60 Hz
  frame, and no skirt triangle turns inside out. Bent 0.14 to 0.25 rad to either side, forward or back, the legs stay
  within half a centimetre. A hem's front never tilts further than the thigh swung under it. `humanoid.test.ts`
  checks all of it on every cut. The Customizer's side view now poses a skirt's rings as the shader does. It had drawn
  the hem up to 6 cm from the street body at a slumped or an upright posture.
- **A walking coat let the legs out through its front.** The coat hung from the trunk alone, so at a brisk walk the
  stepping thigh came 12 to 18 cm out through it on every body, measured on the CPU. Its panels below the waist now
  hang from its waist and follow the legs (`humanoid.ts` coatFollow and coatPose, `crowdBody.ts` bodyVertex): 0.9 of
  the thighs' carry at the knee-level height and below, and above it the carry of the point straight below at that
  height, growing in step with the depth below 0.98 m, so each panel turns about the waist with the thigh, hangs
  straight and is lit as one face. The front goes with the leg that carries it furthest forward and the back with the
  one furthest back. Carried point by point as a skirt is, with the share eased in, the panels stood out in a ledge
  between the 0.86 and the 0.7 rings, tilted 1.2 rad against the thigh's 0.67; now no band tilts more than 0.06 rad
  past the thigh and its own flare. A skirt under the coat follows the same way, at the same heights, the straight
  skirt too: one that stopped following where the coat covered it let the knee through skirt and coat at a walk, one
  hung from the trunk alone came 6 to 9 cm out through the coat's back at a desk lean, and with the skirt's rule one
  that followed 6 cm lower than the coat came up to 1.6 cm out of it. On the CPU, on a neutral, a slumped, an upright,
  a heavy and a short body, measured along the ray from the coat's axis through each point, the trunk and legs under
  the coat now stay within 1 cm of it at a walk and half a centimetre at a desk lean. Every skirt stays within 1 cm of
  it at a walk and at a desk lean, sampled over every triangle, and a midi keeps the legs below the coat inside it. On
  the far body's coarser coat, the trunk and legs stay within 1 cm and every skirt within 2 cm at a walk. The coat
  moves smoothly through the stride and never turns inside out. As a rigid panel, the coat's hem lifts 17 to 19 cm at
  the front at the far end of a stride, as a cut skirt's does (no cloth is simulated).
- **The skirt and the coat left a gap in their own shadows.** three's shadow pass draws a front-sided material's back
  faces alone, so an open shell's wall nearer the sun stayed out of the shadow map. The crowd's material now draws
  both faces into it (`shadowSide`).
- **A worker at a desk leaned toward the last push, not the desk.** The desk lean bends the body about the push's
  direction less the heading, and nothing set the push's direction at a desk. A worker who was never pushed leaned 0.06 to
  0.14 rad (the nod) to the side or backward, depending on which way the desk faced. At work the direction is now the heading (`crowd.wgsl`), so every worker leans toward the desk.
- **The crowd's shadow pass ran the whole paint.** three multiplies a shadow's alpha by the material's colour alpha
  (`Renderer._getShadowNodes` reads `colorNode.a`), so every body's shadow-map fragment stage carried the look's whole
  paint, the weaves, cuts, hair, skin and faces, about 138,000 characters per body, run for every shadow-map texel a
  body covers, for an alpha that is always 1. The crowd's colour now answers `.a` with 1 itself, and its shadow pass is
  the pose and the code dissolve's shadow mask alone: 1,105 characters for each of the eight bodies.
  `shadowShaders.test.ts` holds it under 4,096. Found when CI's browser job on this slice outran its 30 minutes, every
  suite 1.5 to 2 times slower than on `main`.
- **The sleeves, the hands, the legs, the shoes, the bag, the skirt, the long hair, the bob, the ponytail and the
  long beard were drawn inside out.** The loft lays a tube's quads counter-clockwise seen from outside (the face three draws) only when its rings run from
  the bottom up, and it closes `capTop` on the last ring and `capBottom` on the first. These tubes listed their rings
  from the top down, so their outer faces were culled: each showed the inside of its far wall, lit by normals pointing
  in, and the hands and the shoes closed with a cone from the wrong ring (a point below the wrist, a spike inside the
  shoe), the soles left open. On an arm or a leg the outline hid it; on the skirt the legs stood in front of its back
  panel, so the knees seemed to come through. `humanoid.ts` now lays every tube from its lowest ring up (no ring
  moves), and `humanoid.test.ts` checks that every round tube's triangles face out on every body, near and far, that
  every cap lies past the ring it closes, and that the skirt's hem faces out. In the code since the first bodies
  (#59); found in this slice's SwiftShader screenshots (`/mnt/project-files/screenshots/lower-cuts/`), not yet seen
  on real hardware.
- **Sloane no longer takes the focus from a halted city's way-out card.** The Concierge became visible when the boot
  veil finished fading, whatever the city's state, and its name field took the keyboard focus from anything but
  another text field, so a halt inside the veil's last second (the browser smoke's thrown frame right after the veil
  lifts, or a graphics reset then) showed the recovery card with Restart focused and, a moment later, Sloane's
  question with the focus: Enter typed a name instead of restarting. `App.tsx` now hides the Concierge while the city
  is halted, as the look card and the action card already were (`recoveryWiring.test.ts` and `lookWiring.test.ts` pin
  the line), and the browser smoke's card check names what holds the focus when it is not Restart. Seen once on
  `main`'s CI after #65 merged; the same tree had passed the job forty minutes earlier.
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

- **Sloane's rewording no longer kills the model loading in this page.** The brief's 4 s rewording asked the page's
  mind, and an answer's stop ends the load it started (`src/09_Cognition/inPage.ts`), so with a model file kept and not
  yet loaded every brief began a load and killed it at 4 s. The rewording now asks nothing while that model is still to
  be loaded (`InPageMind.cold()`, checked in `src/App.tsx`; under auto only until a look finds a server); the
  planner's sentence stands meanwhile.

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
