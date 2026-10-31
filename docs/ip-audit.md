# Licence and IP audit of the repository (16 October 2026)

This is the record of what was looked for, where, and what was found, written for Julian and for counsel. It
is a report of facts about the files in this repository and its lockfiles, not legal advice; the points that need a
lawyer's reading are listed at the end. It was prompted by an upgrade plan (another AI's) that said the repository
might carry code from `vkQuake3` / `ioquake3` (GPLv2) and from MakeHuman / MPFB (AGPLv3 / GPLv3), and that the
Pathfinder-derived mechanics needed renaming. Each of those claims was checked against the code.

`src/compliance.test.ts` now holds the first two findings as tests, so they stay true: every licence in the npm tree
is on a permissive allow-list (MPL-2.0 only in one build tool), and none of the named engines' or tools' names in any
text file of the repository but this document.

## 1. Third-party source code

| Claim in the plan | Finding |
|---|---|
| `vkQuake3` / `ioquake3` C code is linked or bundled | **Not present.** No file in `src/`, `native/`, `crimson_noir_os/`, `src-tauri/`, `tools/`, `world/`, `brand/`, `deploy/`, `.github/` or `docs/` contains `vkquake`, `ioquake`, `ioq3`, `quake3`, `Quake III`, `id tech`, `Id Software` or any Quake source, and there is no C or C++ source in the repository at all (the one compiled third-party module, the in-page model runtime below, has none of these names in its bytes either, and no GPL marker). The renderer is Three.js (MIT) over WebGPU with the product's own WGSL; the OS image renders with `wgpu` (MIT OR Apache-2.0). There is no BSP, PVS or Quake-derived culler to replace. |
| MakeHuman / MPFB Python source is bundled | **Not present.** No `makehuman` or `mpfb` anywhere. The pedestrians are procedural meshes built in `src/03_Spawn_Agents/` (`humanoid.ts` lofts the body from rings written in that file, with its own fifteen-bone skeleton, skin weights, slider arithmetic, and a head whose skull regions and features (eyes, brows, nose, lips, ears) and face sliders are hand-written rings and arithmetic in the same file, as are the coat and the scarf, and the jacket's lines (`GARMENT`) that `crowd.ts`'s fragment stage cuts from the rest position; `crowdBody.ts` is the WGSL of the same); no exported character mesh, skeleton, rig, blendshape, face scan or morph target from any character tool is in the repository, so there is nothing to re-licence. The CC0 gate (`src/01_Initialize_World/assets/cc0.ts`) is a filter over asset names (it purges weapon words), not a store of CC0 meshes; the plan misread its name. |
| Pathfinder 2e ability scores (`STR`, `DEX`, …) in production code | **No ability scores.** No ability score (`STR`, `DEX`, `CON`, `INT`, `WIS`, `CHA`) or ability modifier is in the code. What the product does borrow under the ORC Licence is listed in `NOTICE.md` ("Licensed Material"): the four degrees of success, the proficiency ranks **with their bonuses** (`RANK_BONUS` in `src/02_Define_The_Rules/degrees.ts`: untrained +0, trained +2, expert +4, master +6, legendary +8, plus the level from trained up, which is the Pathfinder 2e proficiency table), fortune/misfortune and the exact outcome odds (`degrees.ts`, mirrored in `crowd.wgsl`), and the checks built on them, among them a Reflex-style save (`YIELD_SAVE` in `src/02_Define_The_Rules/civic.ts`, a modifier against a DC; the same wording is in `crowd.wgsl`). The "Vance" persona JSON the plan refers to is in the plan's own source document, not in this repository (the file `context engineered system prompt` at the root is a 22-line research-analyst prompt with no stat block). Renaming scores that do not exist changes nothing; see §4 on the ORC point that does exist. |

### The in-page model runtime (`third_party/wllama/3.8.1/`, added 18 October 2026)

The one compiled third-party binary in the repository. It is not built here and holds no source:

- **What it is.** `wllama.wasm.gz` is the WebAssembly module the npm package `@wllama/wllama` 3.8.1 (MIT, Xuan Son
  Nguyen) publishes at `esm/wasm/wllama.wasm`, byte for byte (8,763,949 bytes, sha256
  `551f13439366eff11e057b1b91fe46a7fdac29d56d67372d4c5f19a549dfe70c`), gzipped. wllama built it from llama.cpp build
  b11364-46ca246 (the package's `esm/index.js`, `LIBLLAMA_VERSION`) with Emscripten 4.0.20 against Dawn's
  emdawnwebgpu v20260317.182325 (the package's `scripts/build_wasm.sh` and `scripts/docker-compose.yml`). The page
  carries it as base64 and the adapter gunzips it in the page; nothing downloads it.
- **How it is held.** `tools/native/wllama-pack.mjs` (`npm run native:wllama`) writes the gz, `SHA256SUMS` and
  `IMPORTS` from `node_modules`, and `--check` fails on any difference (`src/10_Network/wllamaPin.test.ts` runs it).
  The build (`vite.config.ts`, `wllamaRuntime`) refuses a gz that is not the module `SHA256SUMS` names or not the
  module the installed package publishes. `tools/verify/wasm_airgap.py` (the rust and fvps jobs, the release bake,
  no npm) holds it to its 68 reviewed imports, all from `env` and `wasi_snapshot_preview1`, none named for a socket
  or a request, and to one imported shared 64-bit memory.
- **What is compiled into it, and the licences.** From the strings and imports of the module and the package's build
  scripts: llama.cpp and ggml, including parts of its `tools/server`, `tools/mtmd` and `common` code (MIT, the ggml
  authors); nlohmann/json, vendored by llama.cpp (MIT); three more libraries llama.cpp vendors, all linked through its
  `tools/mtmd/mtmd-helper.cpp` (which wllama calls to decode an image or a sound): stb_image (MIT or public domain,
  Sean Barrett; eleven of its own error strings, such as `bad png sig` and `no SOI`, are in the module), miniaudio's
  decoders (public domain or MIT No Attribution, David Reid; its FLAC decoder's CRC-8 and CRC-16 tables lie back to
  back in the module's data) and the SHA-256 code of `vendor/hash` (public domain, Igor Pavlov, with `rotate-bits.h`,
  MIT, William Casarin; its round constants are in the module). The xxHash (BSD-2-Clause) and SHA-1 code that
  `vendor/hash` also builds is not linked: its one caller, `hash.cpp`, uses SHA-256 alone, and neither one's constants
  are in the module. Dawn's emdawnwebgpu, behind the `emwgpu*` imports (BSD-3-Clause); the Emscripten runtime (MIT or
  University of Illinois/NCSA); musl libc as Emscripten bundles it (MIT); LLVM libc++ and libc++abi as Emscripten
  bundles them (Apache-2.0 WITH LLVM-exception; the module's strings name `libcxxabi` sources). wllama's JavaScript,
  bundled as an npm package, carries feature tests copied from wasm-feature-detect (Apache-2.0, said in its
  `src/utils.ts`). No GPL, LGPL or other copyleft component was found.
- **The texts.** None of those licence texts is in the npm package (its llama.cpp is a git submodule). All twelve were
  fetched on 18 October 2026 from each project's own repository (llama.cpp's for what it vendors) and copied unchanged
  into `third_party/wllama/3.8.1/NOTICE`; `LICENCE` beside it is the package's own:

  | Component | Fetched from |
  |---|---|
  | llama.cpp and ggml | `https://raw.githubusercontent.com/ggml-org/llama.cpp/b11364/LICENSE` |
  | nlohmann/json | `https://raw.githubusercontent.com/nlohmann/json/develop/LICENSE.MIT` |
  | stb_image (v2.30) | the licence statement at the end of `https://raw.githubusercontent.com/ggml-org/llama.cpp/b11364/vendor/stb/stb_image.h` |
  | miniaudio (v0.11.25) | the licence statement at the end of `https://raw.githubusercontent.com/ggml-org/llama.cpp/b11364/vendor/miniaudio/miniaudio.h` |
  | SHA-256 | `https://raw.githubusercontent.com/ggml-org/llama.cpp/b11364/vendor/hash/sha256/LICENSE` |
  | rotate-bits.h | `https://raw.githubusercontent.com/ggml-org/llama.cpp/b11364/vendor/hash/rotate-bits/LICENSE.md` |
  | Dawn | `https://raw.githubusercontent.com/google/dawn/v20260317.182325/LICENSE` |
  | Emscripten | `https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.20/LICENSE` |
  | musl | `https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.20/system/lib/libc/musl/COPYRIGHT` |
  | LLVM libc++ | `https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.20/system/lib/libcxx/LICENSE.TXT` |
  | LLVM libc++abi | `https://raw.githubusercontent.com/emscripten-core/emscripten/4.0.20/system/lib/libcxxabi/LICENSE.TXT` |
  | wasm-feature-detect | `https://raw.githubusercontent.com/GoogleChromeLabs/wasm-feature-detect/main/LICENSE` |

  The build embeds that NOTICE at the end of `dist/index.html` whenever the page carries the module, and
  `tools/verify/page_dist.mjs` fails a build that carries the module without it. `NOTICE.md` (shipped part) and
  `LICENSE` section 4 name the module and its components.
- **Open points, for the owner before a release.**
  1. Dawn's BSD-3-Clause asks that a redistribution in binary form reproduce its notice "in the documentation and/or
     other materials provided with the distribution". The page reproduces it in the HTML comment at its end, which
     is where every other notice of the product is; confirm that this is enough for the page, the installable copy
     and the Windows app, or also show it on a visible credits screen.
  2. Which commit tag b11364 names was not confirmed from here (the GitHub API was not reachable); the package calls
     the build b11364-46ca246. The licence text is the project's MIT text either way. The nlohmann/json and
     wasm-feature-detect texts were taken from their default branches, not from the exact versions compiled in.
  3. That musl, libc++ and libc++abi are linked is inferred from the module's strings and the usual Emscripten
     link; it is listed so that nothing is missing, not because each was traced.
  4. The owner reviews the NOTICE, this section and the module's provenance before the first release that ships the
     runtime.

## 2. The npm dependency tree (`package-lock.json`)

Checked every entry of the lockfile by its `license` field (the test does the same on every run).

| Licence | Packages | Where |
|---|---|---|
| MIT | 100 | runtime and build |
| Apache-2.0 | 4 (`@dimforge/rapier3d-compat`, `@dimforge/rapier3d-simd-compat`, `detect-libc`, `typescript`) | Rapier at runtime; the rest build-only |
| Apache-2.0 OR MIT | 12 | build-only (Rust-built binaries of the toolchain) |
| ISC | 2 (`graceful-fs`, `picocolors`) | build-only |
| BSD-3-Clause | 1 (`source-map-js`) | build-only |
| Unlicense | 1 (`fast-sha256`) | build-only |
| MPL-2.0 | 24, all `lightningcss` and its per-platform binaries | **devDependency only**: Tailwind's CSS compiler. It runs at build time and none of its code is in `dist/index.html`; its MPL obligations attach to its own files, which are not redistributed. The build's embedded notice (`vite.config.ts`, `noticesComment`) lists only bundled packages: `react`, `react-dom`, `scheduler`, `three`, `@dimforge/rapier3d-simd-compat`, `@wllama/wllama`, all MIT or Apache-2.0, and the pinned runtime's own NOTICE (§1). |
| GPL, AGPL, LGPL, SSPL, EUPL, non-commercial | **0** | |

The five runtime dependencies in `package.json` (`react`, `react-dom`, `three`, `@dimforge/rapier3d-simd-compat`,
`@wllama/wllama` pinned at exactly 3.8.1) are MIT or Apache-2.0 and each ships its licence text (`compliance.test.ts`,
"the real runtime dependencies all have a licence file the build can embed"; `@wllama/wllama`'s file is named
`LICENCE`). `compliance.test.ts` lists the five by name, so a sixth comes through this audit.

## 3. The Rust dependency trees (unverified from the cloud)

The crates in each lockfile were listed; their licences could **not** be confirmed from this session, because
crates.io is not reachable from the cloud container (HTTP 403 through the proxy) and no registry cache is present.
What follows is the crate names and what their licences are known to be from general knowledge of the ecosystem;
counsel should have it confirmed on a machine with registry access, in one command each:

```
cargo install cargo-license
cargo license --manifest-path crimson_noir_os/Cargo.toml
cargo license --manifest-path native/kv-pager/Cargo.toml
cargo license --manifest-path src-tauri/Cargo.toml
```

- **`crimson_noir_os/Cargo.lock` (152 crates)** and **`native/kv-pager/Cargo.lock` (126 crates)**: the `wgpu` stack
  (`wgpu`, `wgpu-core`, `wgpu-hal`, `naga`, `ash`, `glow`, `metal`/`objc2`, `windows`), `bytemuck`, `font8x8`,
  `log`, `env_logger`, `serde`, `tokio`, `parking_lot`, `hashbrown`, `indexmap`. Every one of these is MIT,
  Apache-2.0, MIT OR Apache-2.0, BSD-3-Clause or Zlib as far as is known. `crimson_noir_os/README.md` already states the
  image contains no Linux kernel or other GPL code and links only `font8x8` (MIT) at runtime.
- **`native/routing/Cargo.lock`** and **`native/kv-pager-wasm/Cargo.lock`**: no third-party crates at all (the
  routing core and the WebAssembly host import nothing; the air-gap check proves the modules import nothing).
- **`src-tauri/Cargo.lock` (407 crates)**: the Tauri 2 stack. Tauri, `wry`, `tao`, `muda`, `tray-icon`,
  `window-vibrancy`, `webview2-com`, the `windows` crates, `serde`, `tokio`, `reqwest`, `url`, `html5ever`,
  `brotli`, `png`, `uuid`: MIT, Apache-2.0, or both; the ICU crates (`icu_*`, `zerovec`, `yoke`) are Unicode-3.0;
  `r-efi` (via `getrandom`) is MIT OR Apache-2.0 OR LGPL-2.1-or-later, so a permissive choice is available.
  **File-level copyleft (MPL-2.0) that reaches the Windows build:** `option-ext` 0.2.0 comes in through
  `tauri` → `dirs` 7 → `dirs-sys` 0.5 → `option-ext`, and the lockfile records no target condition on that chain, so
  as far as the lockfile shows it is compiled into the Windows installer and executable that `windows-app.yml`
  publishes. `option-ext` is MPL-2.0. The Servo CSS crates `cssparser` 0.37, `cssparser-macros`, `selectors` 0.38
  and `dtoa-short` (believed MPL-2.0) come in through `dom_query`, which both `tauri-utils` and `wry` use; whether
  they end up in the Windows executable or only in build-time code depends on features and targets the lockfile
  does not record, so `cargo tree --target x86_64-pc-windows-msvc -i cssparser` on a machine with registry access
  should settle it. MPL-2.0 is file-level: as commonly read, a proprietary program may link MPL files unchanged,
  provided the source of those files stays available to recipients and their notices are kept. **For counsel:**
  confirm that reading for this product, and whether `NOTICE.md` should name these crates and where their source
  is (crates.io). Nothing here was modified, and no MPL file is copied into the repository.
  **Two more to confirm:** the crates compiled **only for Linux targets**, `libappindicator`/`libappindicator-sys`
  (the tray on Linux; the crate itself is believed to be LGPL-3.0, wrapping an LGPL system library) and
  `libdbus-sys` (links the system `libdbus`, AFL-2.1 OR GPL-2.0 as a system library). Neither is compiled into the
  product that ships: `windows-app.yml` builds the Windows installer and executable only, where the tray and the
  webview come from `windows`/`webview2-com` (Microsoft's WebView2 runtime is a system component, not redistributed).
  If a Linux build of the app is ever published, these two need a decision (the Tauri project's own position is that
  dynamic linking to them is fine; counsel should confirm it for a proprietary product).

## 4. The ORC Licence point that is real

`LICENSE` and `NOTICE.md` already handle this correctly as far as the files go: the mechanics listed under
"Licensed Material" are offered under the ORC Licence, the code is proprietary (the ORC AxE says the licence grants
no licence to software code), and the auxiliary tooling is MIT. The open question for counsel, recorded in
`NOTICE.md`'s operator notes (item 4) and repeated here, is whether offering the product's *new* mechanics (the
yield save, the perception latency, the walk-start delay, the three-law ruling as written in `laws.ts`) under ORC
constrains any store or publishing agreement, and whether the degrees-of-success resolution as used in a
non-tabletop product is Licensed Material at all. The plan's proposal to rename the six ability scores does not
touch this, since the product uses no ability scores. Nothing in this PR changes the licence files.

## 5. What this PR adds to keep it true

- `src/compliance.test.ts`: every licence in the npm lockfile must be on an allow-list (MIT, Apache-2.0,
  `Apache-2.0 OR MIT`, BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Unlicense), so a GPL, AGPL, LGPL, SSPL, EUPL,
  non-commercial, source-available (`BUSL-1.1`, `Elastic-2.0`, PolyForm, Commons Clause) or `UNLICENSED` entry
  fails it; MPL-2.0 is allowed only for `lightningcss` in `devDependencies`; every runtime dependency is permissive;
  and none of the names in §1 appears in any text file of the repository (C and C++ sources included, build output
  and `node_modules` skipped) but this one.
- This document, under `docs/` (MIT, like the rest of the tooling and documentation).

## 6. Left for a machine with registry access

1. Run the three `cargo license` commands above and attach the output to this document.
2. Consider adding `cargo deny check licenses` (with an allow-list of MIT, Apache-2.0, BSD, ISC, Zlib and
   Unicode-3.0, plus per-crate exceptions for MPL-2.0 naming `option-ext` and, if `cargo tree` shows them in the
   Windows build, the Servo CSS crates, once counsel has confirmed the MPL reading in §3) to `ci.yml` beside the
   `license-headers` job, so the Rust trees are held the
   way the npm tree now is. It needs network access to the registry on the runner, which CI has and this session
   did not.
