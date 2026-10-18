<p align="center">
  <img src="docs/cover.jpg" alt="Crimson Noir: Agent City cover art: an operator on a night terrace above the city recruits an agent, while a drone halts at a glowing safety perimeter" width="440">
</p>

# CRIMSON NOIR // AGENT CITY
### Deterministic Zero-Trust Agent Architecture & Bare-Metal Civic Simulation

![Build & Proofs](https://img.shields.io/badge/FVPS-Kani%20%2B%20Z3%20Verified-brightgreen)
![Zero-Trust Sandbox](https://img.shields.io/badge/Sandbox-38%2F38%20Probes%20Denied-success)
![SIMD Engine](https://img.shields.io/badge/Swarm%20Ticks-SIMD%20Lanes-blue)
![Tests](https://img.shields.io/badge/Tests-1%2C316-darkgreen)
![Dual-License](https://img.shields.io/badge/Core-Proprietary%20%7C%20Tools%3A%20MIT-crimson)
[![Release](https://img.shields.io/badge/Release-v1.0.0--stable--beta-black)](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.0-stable-beta)

**Crimson Noir** is an offline, mathematically contained multi-agent simulation and operating-system substrate
that compiles to a single, self-contained HTML file (`dist/index.html`) or to a bootable bare-metal UEFI image.

Built on data-oriented design (DOD) principles, the architecture isolates untrusted agent reasoning and network
bridges behind loopback-only boundaries, formal proofs over the kernels, and a three-law ethical kernel that every
vehicle command, from the AI or from you, must pass before it reaches the wheels.

The full manual (controls, URL options, the city, the console, the model providers, networking, the OS, what is
verified, history) is [MANUAL.md](MANUAL.md). The bare-metal system has its own [README](crimson_noir_os/README.md).

---

### Core Architectural Tracks

* **Track A (Civic Simulation):** A $16 \times 16$-block procedural metropolis running under a moving golden-hour
  sun. Powered by WebGPU WGSL compute shaders, 14,000 GPU-simulated pedestrians on a desktop GPU (8,000 on a phone),
  Rapier3D physics compiled to WebAssembly (the SIMD build), a fixed right-turn-ring track network that cannot jam,
  and a film-accurate 24 FPS / 180° shutter cinema pipeline (a phase-locked frame pacer and a 1/48 s exposure).
* **Track B (Ring-0 TTY Shell):** A headless mode (`?boot=tty`) that opens the Ring-0 console alone, with no
  WebGPU or canvas at all. Its own language, `r0`, is a deterministic, Turing-complete Forth-like stack machine
  that imports nothing: no DOM, no clock, no randomness, no network, no storage, no dynamic code.
* **Zero-Trust Containment:** Three layers of network isolation in the page: one loopback-only gate that every
  client asks before it addresses anything, an air gap that replaces and freezes every outbound primitive of the
  global object, and a Content-Security-Policy that admits loopback only. The cognitive gateway speaks to Claude
  (default model `claude-opus-5-5`) through a loopback proxy the operator runs, to a local Ollama, llama.cpp or
  other OpenAI-compatible server, to a GGUF model file the operator keeps in the page and runs in it (llama.cpp
  compiled to WebAssembly, with no request at all), or to a deterministic script with no backend at all; no model,
  server or key ships with the product. The self-healing agent's checks run in a container
  that mounts nothing of the host, and 38 adversarial escape probes (egress, daemon sockets, execution,
  privilege, credentials) are denied inside it on every CI run, with a weakened control where the same probes
  must escape. The kernel and Docker are the trusted base: tested and argued, not proved
  (see [docs/zero-trust-sandbox.md](docs/zero-trust-sandbox.md)).
* **Formal Verification (FVPS):** Bit-precise CBMC model checking via Kani over the Global Matrix kernels (an
  agent's tick touches only its own row, weights and memory block, never traps) and the WebAssembly routing core
  (never traps, every index in bounds); SMT theorem proving via Z3 over the index arithmetic; a WebAssembly
  air-gap check (the modules import nothing and own one memory); and an LLVM IR call-graph scan of the routing
  core. Floating-point values are held bit for bit by parity tests, not proved.

---

### Quickstart

```bash
# Install dependencies
npm install

# Local development server (WebGPU)
npm run dev

# Run the test suite: 1,360 Node tests (node --test), including real Rapier physics and a real WebSocket host.
# 11 of them exercise the OS bridge binary and are skipped until `cargo build` in crimson_noir_os/ has made it.
npm test

# Run the formal verification step (Z3 theorems + WebAssembly air gap + LLVM IR scan + Kani harnesses)
# Needs `cargo kani`, `pip install z3-solver` and the wasm32-unknown-unknown target; `-- smt`, `wasm`, `ir` or `kani` runs one part.
# (CI and the release bake run the same step as `sh tools/verify/fvps.sh`; `npm run verify` is that script for cmd and PowerShell too.)
npm run verify

# Single-file production build (all assets, shaders & WASM inlined)
npm run build
```

**On Windows**, `npm install`, `npm run dev`, `npm test`, `npm run verify` and `npm run build` run as written from cmd.exe or
PowerShell (Node 22 or newer; no `sh` is needed). Use `git clone`, or extract the ZIP somewhere other than `Downloads`
before the first run: a fresh download carries the mark of the web, and a scanner that holds those files on first
open fails `npm test` file by file with `EPERM: operation not permitted, open '…\src\…\x.ts'` while the runner's
parallel processes import them at once (no test asserts anything in those failures). On Windows `npm test` first opens
every file of the checkout one at a time, waiting out the scanner (tools/test/warm.mjs), and says when the folder is
inside `Downloads`; a folder the scanner has already seen, or an exclusion for it, runs clean from the first try.
Kani (the `kani` part of the proofs) runs on Linux and macOS only: `npm run verify` leaves it out on Windows and says
so in its last line; use WSL for that part.

**The Windows app.** No Node, no terminal: download `Crimson Noir Agent City_<version>_x64-setup.exe` from the
[latest release](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases) (or the
`windows-installer-*` artifact of the latest [windows-app](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/actions/workflows/windows-app.yml)
run), double-click it, and the city opens in its own borderless window with a frosted glass title bar. It installs
for the current user, so no administrator prompt; SmartScreen may ask once because the file is not code-signed
(More info, Run anyway). The `windows-portable-*` artifact is the bare `.exe` that runs from anywhere. The app is
the same single page in a Tauri 2 window (src-tauri/): WebView2 runs the WebGPU city, the physics realm shares one
memory bridge with the page, and nothing in the app reaches a host but this machine. To build it yourself:
`npm run app:build` (Rust and the Visual Studio C++ build tools; NSIS is fetched by Tauri).

Open `dist/index.html` directly: no server, and it works offline. It needs WebGPU: a current Chrome, Edge or
Brave on desktop and Android, or Safari 26 on a Mac (an iPhone or iPad plays the web app, below). `?boot=tty` needs
none.
`npm run dev` and `npm run preview` serve the page cross-origin isolated (the COOP and COEP headers), so the physics
realm and the page share one memory bridge for every position (docs/zero-copy-bridge.md); the file opened from disk
uses the same bridge over a private buffer. A server of your own sends the same two headers to get the shared path.

**On an iPhone or iPad.** Safari gives WebGPU only to a page served over https, so a phone plays the installable
copy: `npm run build:web` writes `dist-web/`, the same page with a manifest, its icons and a service worker that keeps
it on the phone. Serve that folder over https, either on GitHub Pages (once: Settings > Pages > Source: GitHub
Actions; then Actions > web > Run workflow) or through Tailscale to your own devices only, open it in Safari, then
Share > Add to Home Screen: it opens full screen with the touch controls and, after the first visit, starts with no
network. MANUAL.md, On an iPhone, has the steps, what CI checks and what still needs a real iPhone.

**On NixOS.** `nix run github:cassius-software/Crimson-Noir-AI-Agent-City` (flakes on) builds the page from source,
serves it on `http://127.0.0.1:4180` with the two isolation headers and opens it in Chromium as an app window with
WebGPU on Vulkan; words after `--` become the page's query (`-- quality=4 map=lakefront`). To install it, add the
flake's `nixosModules.default`, set `programs.crimson-noir-agent-city.enable = true;` and allow the page by name (it
is the proprietary core): it is then built from the system's own nixpkgs, so Chromium can load the system's GPU
driver, with an app-menu entry and access for a DualSense's triggers over WebHID. On another Linux, Nix's Chromium
cannot load the system's GPU driver: prefix `CHROME=google-chrome-stable` to use a browser installed outside Nix.
MANUAL.md, On NixOS, has the module snippet, what CI checks and what still needs a real NixOS desktop.

A first visit opens on Sloane, the concierge, who asks four one-word questions (a name, where to start, the time of day,
sound) while Lakefront Metro, a fictitious great-lake metropolis of five regions (Lakefront Metropolis with The Spire,
West Sprawl with Transit City, The East Bluffs, North Ridge, The Grand Ravine), is generated in the background from
the world seed; the answers are kept, so a return visit opens on the same city. `?onboarding=0` skips to the
procedural city (the expert path), `?onboarding=1` shows the onboarding again, `?map=lakefront` walks the metropolis
and `?map=city` the procedural city regardless of what was saved; `?region=on` is the surveyed region as before. The
metropolis has its own crowd and traffic: a 16 × 16-block street window around where the visitor starts is read back
from its streets, the GPU pedestrians walk its sidewalks and the car fleet drives rings over its whole cells, with
lamps and signals along its streets (`src/01_Initialize_World/region/streets.ts`). The metropolis's structural layouts
are committed under `world/lakefront/` (`node tools/world/lakefront.mjs` regenerates them; `--check` compares).

---

### Release

The current release is [**v1.0.0-stable-beta**](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases/tag/v1.0.0-stable-beta)
(Crimson Noir Agent City v1.0.0 Stable Beta, 2026-10-12; its number was set below the earlier
[v1.1.0-stable-release](https://github.com/cassius-software/Crimson-Noir-AI-Agent-City/releases/tag/v1.1.0-stable-release)
on purpose, see [CHANGELOG.md](CHANGELOG.md)), baked from `main` with the proofs: a GPT disk image and a hybrid UEFI ISO
for a UEFI x86-64 machine with Secure Boot off, the `BOOTX64.EFI` application, its locked configuration, and
`SHA256SUMS`. The media are reproducible: the same commit built with Rust 1.97.0 gives the same bytes, and the EFI's
stamp is a hash of the code alone. Before publishing, CI booted the disk image in QEMU through the self-test, the
tutorial and the Crimson Terminal's scripted run; no physical machine is part of that check.

---

### Licensing

Dual-licensed (`LICENSE`). The core (`src/`, `crimson_noir_os/`, `native/`, `world/`, `brand/`, the page's entry and
build) is proprietary: Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved. The auxiliary tooling
(`tools/`, `deploy/`, `.github/`, `docs/`, the container build, the publish script and the Nix flake) is open source
under MIT.
The game mechanics are offered under the ORC License (`NOTICE.md`). Releases up to v1.0.1 were published under
MIT OR Apache-2.0 and those grants stand. Every source file carries its header, and CI checks them.
