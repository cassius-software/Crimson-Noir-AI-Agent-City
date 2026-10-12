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

## [1.0.0-stable-beta] - 2026-10-12

The V2 stable release overhaul (Phase 21, PRs #17, #18 and #19) and Phase 2 (PRs #20, #21 and #22), with everything
merged since `v1.1.0-stable-release`. Tagged `v1.0.0-stable-beta`; the OS media are baked and the Windows app is
built by the two release workflows on that tag.

### Added

- **Matrix mode** ([#17](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/17)): world-space falling code on every surface, as triplanar functions inside the
  page's three.js node materials (`src/01_Initialize_World/matrixMesh.wgsl`); one global state word (time, mode,
  floating origin) packed into the materials' uniform and the crowd's parameters; toggled with the M key or `rain on`
  in the console. In matrix mode pedestrians drop to the static-world collision bit, so people and cars pass through
  each other while the ground and lots still hold; the floating origin snaps the camera to whole metres. Lakefront
  meshes take the mode through the region path. Unverified from the cloud (no GPU): the shaders compiling and their
  look on a real device.
- **Lakefront Metro** ([#18](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/18)): a seeded, deterministic Greater-Toronto-analogue map with no real place
  name (a test asserts it): a lake behind a wandering shore with a harbour, a dense financial core on the water with
  The Spire on the waterfront (168 floors, 554 m), ravines running north to the lake crossed only by arterial bridges,
  a suburban grid with skyscraper transit hubs, five regions (Lakefront Metropolis, West Sprawl, The East Bluffs, North
  Ridge, The Grand Ravine) as JSON layouts under `world/lakefront/`, loaded through the existing region path.
  **Wren's onboarding**: four one-word questions, a choice of Downtown, West, East, North or Ravine, the map built in a
  worker, "Walk in" landing in the chosen region; `?onboarding=0` is the expert path. **The CC0 asset gate**
  (`assets/cc0.ts`) purges every weapon name by case-insensitive containment with a short allowlist, and screens every
  name entering the page.
- **Zero-copy physics bridge** ([#19](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/19)): every car, avatar and pedestrian's position and state word in one
  buffer shared between the physics worker and the page under an Atomics spinlock (a `SharedArrayBuffer` when the page
  is cross-origin isolated, which the dev and preview servers now are through COOP and COEP headers; a plain buffer of
  the same layout otherwise). Measured in Node at 14,000 pedestrians over 10 s: 58 short garbage collections on the old
  message path, 1 with the bridge. **GPU flow-field routing**: summoned pedestrians follow a GPU-solved flow field
  round buildings, with a CPU fallback that warns once in the console. **Ragdolls** left the vehicle contact layer.
  **Cloud fallback**: below 30 fps for 2 s, complex prompts bound for Ollama or llama.cpp go to the Claude provider
  through the existing loopback gate.
- **The one-click Windows app** ([#21](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/21)): a Tauri 2 shell (`src-tauri/`) around the very same
  `dist/index.html`, borderless, with a frosted glass title bar in the brand's tokens (Mica on Windows 11, best
  effort) and COOP/COEP headers so the physics bridge takes its shared-memory path. The `windows-app` workflow builds
  `Crimson Noir Agent City_<version>_x64-setup.exe` and the bare executable on every pull request and push to main,
  and uploads both to the GitHub Release of any `v*` tag beside the OS media. Verified in CI on a Windows runner;
  Mica, WebGPU under WebView2 and the window's look on a real desktop are not.
- **Wren's quiet first minutes** ([#22](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/22)): for five minutes after "Walk in", Wren watches what a first
  visitor does and, after thirty quiet seconds, says one plain line in the concierge card (look around, walk to The
  Spire, talk to someone, press M, turn the clock), at least forty-five seconds apart, skipping what is already done,
  never called a lesson, never twice, never over an open question. The pure, clock-injected mentor is
  `src/09_Cognition/tutorial.ts`.
- **The swarm's short-term memory** ([#22](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/22)): every recruited person keeps the last three moments with the
  player (who, what, where, when on the city's clock) and a one-sentence account of their surroundings
  (`src/08_Swarm/shortTerm.ts`); both ride every provider's system prompt under one heading within a 600-character
  budget, and with no backend answering the person still answers from a script built from that same context.
- **Long-task telemetry** ([#20](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/20)): a `PerformanceObserver` on the browser's `longtask` entries writes one
  silent `console.debug('[longtask]', …)` line per main-thread stall over 50 ms, with the task's start and duration,
  the JS heap in MiB and the number of live worker threads (the physics worker is the WASM thread); 8 lines per 10 s,
  then one dropped count. A browser without the API gets a no-op.
- **`npm run verify`** ([#16](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/16)): a Node port of the formal verification runner, so the proofs run from
  cmd.exe or PowerShell without a POSIX shell (Kani still needs Linux or WSL; the WASM byte comparison is skipped on
  Windows, where rustc embeds backslash paths). The README has a Windows paragraph.
- **This changelog** and the version fields set to `1.0.0-stable-beta` (package.json, package-lock.json, brand.ts,
  src-tauri/Cargo.toml and Cargo.lock, from 1.4.0).

### Changed

- **The README is the one-page overview**, every claim checked against the tree and CI; the 2,161-line manual moved to
  `MANUAL.md` unchanged ([#14](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/14)). Facts fixed on the way: the console's stack machine is `r0`; the 38
  sandbox probes are "denied in the container, with a weakened control", not formally denied; the three isolation
  layers are named.
- **Stable release polish** ([#15](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/15)): drivers react on the exact frame their perception latency allows; a
  small on-foot drift in a room is corrected under the player's feet (at most 0.25 m) instead of pulling them back;
  remote snapshots ease over 0.1 s; a released ragdoll's pedestrian is placed where the rig stood (0.00 m jump, was
  0.66 m); the code-dissolve keys are whole numbers so cells stay distinct at any uptime and the shadow moiré is gone;
  crowd draw lists hold the whole crowd per body; density fades over 8 m, LOD spreads ±10 %, a new quality tier glides
  in over 30 frames; ghost view draws every glyph; the 24 fps pacer holds 24.000 fps on jittery 165 and 240 Hz
  displays; AI cars corner at 0.579 m (was 0.787 m) and hold 0.180 m on straights; a follower passes a parked car after
  6 s and bonnet rays see rejoining cars.
- **Streamed model answers are screened a whole word at a time** ([#15](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/15)): a refused word stops the model at
  once, auto-say never speaks a disengaged answer, the diary never recalls a line that fails the screen, and the screen
  reads leetspeak inside words.
- **Held source files on Windows are reported as held**, with the real error, instead of as missing modules
  ([#16](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/16)).
- The handoff records v1.1.0-stable-release and Phase 19 ([#13](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/13)): the published `BOOTX64.EFI` of that
  release rebuilds byte for byte in another container, so its PE timestamp is the commit's alone.

### Removed

- The tracked developer AI configuration (`.claude/`), as part of the zero-trust sweep; a guard test holds the
  attack surface ([#15](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/15)).

### Security

- The zero-trust sweep ([#15](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/15)) confirmed: no process spawning from strings anywhere, the room host
  token-authenticated and loopback unless told otherwise, the CSP `default-src 'none'` tested and property-fuzzed, the
  WASM modules import nothing (checked on the bytes). `'unsafe-eval'` remains for the operator console.
- The CC0 asset gate screens every asset name entering the page ([#18](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/18)).

### Counts

`npm test` grew from 1,316 tests at v1.1.0-stable-release to 1,414 (1,403 pass, 11 skipped without the OS bridge
binary, as before) at the merge of #22 (1,423 with #20). The Z3 theorems (15) and Kani harnesses (14) are unchanged
and ran green in every one of these pull requests' CI.

## [1.1.0-stable-release] - 2026-10-09

Phase 19: the data-oriented SIMD rewrite of the Global Matrix tick (four agents per SSE2 register, bit for bit equal
to the scalar Kani reference, fingerprint 0x83765bab) ([#12](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/12)); the zero-trust self-heal sandbox with 38
escape probes denied in the container ([#10](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/10)); dual licensing with headers on every source file and a CI
header check, plus the brand tokens, marks and style guide ([#9](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/9), [#11](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/11)); per-client proxy
throttles and the nightly fuzz workflow ([#7](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/7)); the terminal renamed "Crimson Terminal" ([#8](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/8)).
Baked from main 2ad02e1: proofs, tests, two byte-identical bakes, both QEMU boots, eight published files.

## [1.0.1-stable-release] - 2026-10-08

Phase 18: the Kani/Z3 proof step gating the release bake, the first CI on pull requests and main, the self-healing
agent that opens `selfheal-*` pull requests and never merges, SIPOC telemetry and the chaos campaign
([#3](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/3), [#4](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/4), [#5](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/5)); the EFI build made reproducible across hosts with `/DEBUG:NONE`
([#6](https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/pull/6)). A new tag because `v1.0.0-stable-release` already named pre-Phase-18 media.

## [1.0.0-stable-release] - 2026-10-07

The first published media of Crimson Noir OS, before Phase 18.

[1.0.0-stable-beta]: https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.0-stable-beta
[1.1.0-stable-release]: https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/v1.1.0-stable-release
[1.0.1-stable-release]: https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.1-stable-release
[1.0.0-stable-release]: https://github.com/exitwoundscassius-ux/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.0-stable-release
