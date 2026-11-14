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
| MakeHuman / MPFB Python source is bundled | **Not present.** No `makehuman` or `mpfb` anywhere. The pedestrians are procedural meshes built in `src/03_Spawn_Agents/` (`humanoid.ts` lofts the body from rings written in that file, with its own fifteen-bone skeleton, skin weights, slider arithmetic, and a head whose skull regions and features (eyes, brows, nose, lips, ears) and face sliders are hand-written rings and arithmetic in the same file, as are the coat and the scarf, and the jacket's lines (`GARMENT`) that `crowd.ts`'s fragment stage cuts from the rest position, and the walk and the gaze (each leg solved from where its foot is, the head and the chest turned by arithmetic; no motion-capture data or animation clip from anywhere); `crowdBody.ts` is the WGSL of the same); no exported character mesh, skeleton, rig, blendshape, face scan or morph target from any character tool is in the repository, so there is nothing to re-licence. The CC0 gate (`src/01_Initialize_World/assets/cc0.ts`) is a filter over asset names (it purges weapon words), not a store of CC0 meshes; the plan misread its name. |
| Pathfinder 2e ability scores (`STR`, `DEX`, …) in production code | **Since 7 November 2026: six attribute modifiers, under ORC (§7).** At the time of this audit: **no ability scores.** No ability score (`STR`, `DEX`, `CON`, `INT`, `WIS`, `CHA`) or ability modifier is in the code. What the product does borrow under the ORC Licence is listed in `NOTICE.md` ("Licensed Material"): the four degrees of success, the proficiency ranks **with their bonuses** (`RANK_BONUS` in `src/02_Define_The_Rules/degrees.ts`: untrained +0, trained +2, expert +4, master +6, legendary +8, plus the level from trained up, which is the Pathfinder 2e proficiency table), fortune/misfortune and the exact outcome odds (`degrees.ts`, mirrored in `crowd.wgsl`), and the checks built on them, among them a Reflex-style save (`YIELD_SAVE` in `src/02_Define_The_Rules/civic.ts`, a modifier against a DC; the same wording is in `crowd.wgsl`). The "Vance" persona JSON the plan refers to is in the plan's own source document, not in this repository (the file `context engineered system prompt` at the root is a 22-line research-analyst prompt with no stat block). Renaming scores that do not exist changes nothing; see §4 on the ORC point that does exist. |

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

### The model the web copy serves (`third_party/qwen2.5-0.5b-instruct/`, added 12 November 2026)

The one set of model weights the product offers, so that a visitor to the web copy with no model of their own can talk
to Sloane with no setup (the page gets it by itself once the city is on screen, or in one tap). It is weights, not
code, and none of it is in the repository:

- **What it is.** `Qwen2.5-0.5B-Instruct-Q4_K_M.gguf` (397,808,192 bytes, sha256
  `6eb923e7d26e9cea28811e1a8e852009b21242fb157b26149d3b188f3a8c8653`), as bartowski publishes it in the Hugging Face
  repository `bartowski/Qwen2.5-0.5B-Instruct-GGUF` at revision `41ba88dbac95fed2528c92514c131d73eb5a174b`: a GGUF
  conversion of the Qwen team's Qwen2.5-0.5B-Instruct weights (Alibaba Cloud; Apache-2.0, Copyright 2024 Alibaba
  Cloud) quantized to Q4_K_M with an importance matrix (llama.cpp release b3772, as the NOTICE beside it records).
- **How it is held.** Never committed and never in the page. `src/09_Cognition/siteModel.ts` pins it (`SITE_MODEL`:
  the file's name, size and SHA-256, the repository and the revision), `SHA256SUMS` beside the licence holds the same
  line, and `siteModel.test.ts` holds the two equal. The web workflow (`.github/workflows/web.yml`) fetches the file
  from Hugging Face at the pinned revision whenever its cache (keyed by the whole pin) does not hold it and, on every
  publish, cached or not, `tools/web/siteModel.mjs place` checks its size and SHA-256 against the pin while copying it
  into `dist-web/models/`, with `manifest.json`, `LICENSE` and `NOTICE` beside it; a mismatch fails the publish and
  leaves no model behind. `place` refuses a folder that is not the web copy, so `dist/` (the single page that the
  Windows app, the flake and the release builds carry) never gets it, and `tools/verify/page_dist.mjs` still fails a
  `dist/` that holds a `.gguf`. `.github/workflows/site-model.yml` fetches and checks the pin on a pull request that
  touches it. The page itself downloads the file from its own site, by itself once the city is on screen (where
  `src/09_Cognition/siteAuto.ts` lets it) or when a visitor taps for it, and checks the same size and hash as it
  streams before anything is kept.
- **The texts.** `LICENSE` is the Apache License 2.0 with Qwen's copyright line ("Copyright 2024 Alibaba Cloud") in
  its appendix, the form Qwen's repositories carry. `NOTICE` says what the file is, where it comes from and at which
  revision, that it is a quantization of Qwen's weights, and that the product serves it unchanged; `SHA256SUMS` is
  its one hash line. The web workflow serves `LICENSE` and `NOTICE` beside the model as `models/LICENSE` and
  `models/NOTICE`. `NOTICE.md` (in its shipped part, a paragraph under "Third-party software" and the trademark
  paragraph; in its operator notes, item 14) and `LICENSE` section 4 name the model and this directory.
- **Open points, for the owner before a release.**
  1. `LICENSE` was reconstructed from the canonical Apache-2.0 text with Qwen's copyright line added; it was not
     compared byte for byte with the copy in Qwen's own repository (`Qwen/Qwen2.5-0.5B-Instruct`), because Hugging
     Face was not reachable from the build container. Compare it once, and on the same visit confirm the NOTICE's
     statements about the repositories (neither Qwen repository has a NOTICE file; bartowski's names its licence as
     apache-2.0 and has no licence file of its own; the llama.cpp release b3772).
  2. The file served is a third party's quantization, not a file the Qwen team publishes. Section 4(b) of the licence
     asks that a modified file carry a prominent notice that it was changed; the NOTICE served beside it says the
     format and numeric precision were changed by bartowski's quantization and that the product changes nothing
     further. Counsel should confirm that this is enough; the alternative is to pin a GGUF file the Qwen team
     publishes itself (`Qwen/Qwen2.5-0.5B-Instruct-GGUF`), with its own size and hash.
  3. The web copy is served from GitHub Pages, whose soft bandwidth limit is 100 GB a month, about 250 full downloads
     of the model; the workflow never downloads it to check the served copy. Whether the downloads stay within
     GitHub's terms for Pages is for the owner to watch.
  4. The owner reviews the NOTICE, this entry and the pin before the change that adds them reaches main: the web
     workflow serves the model from the next publish of main on.

### The model the Windows installer carries (`third_party/qwen2.5-1.5b-instruct/`, added 13 November 2026)

The second set of model weights the product offers, so that a person who installs the Windows app can talk to Sloane
from the first launch with no model of their own. It is held exactly as the web copy's model is (the entry above), and
none of it is in the repository:

- **What it is.** `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf` (986,048,768 bytes, sha256
  `1adf0b11065d8ad2e8123ea110d1ec956dab4ab038eab665614adba04b6c3370`), as bartowski publishes it in the Hugging Face
  repository `bartowski/Qwen2.5-1.5B-Instruct-GGUF` at revision `9eadc66189c7641e1ddd226b8267a9119b2ce2d4`: a GGUF
  conversion of the Qwen team's Qwen2.5-1.5B-Instruct weights (Alibaba Cloud; Apache-2.0, Copyright 2024 Alibaba
  Cloud) quantized to Q4_K_M with an importance matrix (llama.cpp release b3772). Of the Qwen2.5 instruct sizes, 0.5B,
  1.5B, 7B, 14B and 32B are Apache-2.0; 3B and 72B are under Qwen's own licences, so they are not used. The size, the
  hash, the revision and the licence named by both repositories were read from Hugging Face's API on 13 November 2026;
  `site-model.yml` (on a pull request that touches the pin, or run by hand) and `windows-app.yml` fetch the file when
  their cache (keyed by the whole pin) does not hold it, and check its size and hash on every run, a cached file too.
- **How it is held.** Never committed, never in the page and never in the bare .exe. `src/09_Cognition/siteModel.ts`
  pins it (`APP_MODEL`), `SHA256SUMS` beside its licence holds the same line, and `src-tauri/src/model_file.rs` names
  the same file and size; `siteModel.test.ts` holds the three equal. `.github/workflows/windows-app.yml` fetches the
  file at the pinned revision when its cache does not hold it and, on every build, `tools/web/siteModel.mjs app`
  checks its size and SHA-256 while copying it into `src-tauri/models/` (git-ignored) with `LICENSE` and `NOTICE`; a
  mismatch fails the build and leaves no model behind. `src-tauri/tauri.model.conf.json` bundles those three files
  into the installer and the .msi, which install them under `models/` in the app's folder. The app's page reads the
  file only through the shell's two read-only commands and checks the same size and hash on every byte.
- **The texts.** `LICENSE` is the same Apache License 2.0 text with Qwen's copyright line as the 0.5B record's (Qwen's
  repository `Qwen/Qwen2.5-1.5B-Instruct` carries the Apache License 2.0 with "Copyright 2024 Alibaba Cloud" in its
  appendix, as read on 13 November 2026); `NOTICE` says what the file is, where it comes from, at which revision, that
  it is a quantization of Qwen's weights and that the product ships it unchanged. Both are installed beside the model.
  `NOTICE.md` (a paragraph under "Third-party software", the trademark paragraph and operator note 14) and `LICENSE`
  section 4 name the model and this directory.
- **Open points, for the owner before a release.** The first two of the entry above apply here as well: compare
  `LICENSE` once byte for byte with the copy in `Qwen/Qwen2.5-1.5B-Instruct`, and have counsel confirm that the NOTICE
  is enough for a third party's quantization (the alternative is Qwen's own `Qwen/Qwen2.5-1.5B-Instruct-GGUF` file).
  Every installer download is about 0.9 GB from GitHub's release storage.
- **The NixOS package (added 13 November 2026).** The same file, at the same pin, for the flake's `nix run` and its
  NixOS module. `tools/nix/model.nix` names the pin (`siteModel.test.ts` holds it equal to `APP_MODEL`) and fetches the
  file with Nix's `fetchurl` from the same Hugging Face address, which refuses any bytes but the pinned SHA-256; the
  folder it builds in the Nix store holds a link to the fetched file, the same `LICENSE` and `NOTICE` from this
  directory, and a manifest naming the file. Each machine that builds the package fetches the file itself, so the
  product does not redistribute it to Nix users; a binary cache that serves the built package would. The file sits in
  its own fixed-output store path (`…-Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`), and the `LICENSE`, `NOTICE` and manifest sit
  in the package's model folder (`…-crimson-noir-agent-city-model`), which links to it: a cache serving the package's
  closure serves both, but it could serve the file's path on its own. CI's `nix.yml` puts the file in its runner's store
  from its own Linux cache keyed by the whole pin (the Windows workflow uses the same key, but an entry saved on Windows
  is not restored on Linux), else from Hugging Face at the pinned revision, checked by its SHA-256 either way, so the
  build there fetches nothing. The launcher serves the folder beside the page on `127.0.0.1` only, and the page checks
  the same size and hash on every byte. `programs.crimson-noir-agent-city.model = false` builds the module's package
  without it. The same open points apply.

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
cargo license --manifest-path native/llm/Cargo.toml
```

- **`crimson_noir_os/Cargo.lock` (152 crates)** and **`native/kv-pager/Cargo.lock` (126 crates)**: the `wgpu` stack
  (`wgpu`, `wgpu-core`, `wgpu-hal`, `naga`, `ash`, `glow`, `metal`/`objc2`, `windows`), `bytemuck`, `font8x8`,
  `log`, `env_logger`, `serde`, `tokio`, `parking_lot`, `hashbrown`, `indexmap`. Every one of these is MIT,
  Apache-2.0, MIT OR Apache-2.0, BSD-3-Clause or Zlib as far as is known. `crimson_noir_os/README.md` already states the
  image contains no Linux kernel or other GPL code and links only `font8x8` (MIT) at runtime.
- **`native/routing/Cargo.lock`** and **`native/kv-pager-wasm/Cargo.lock`**: no third-party crates at all (the
  routing core and the WebAssembly host import nothing; the air-gap check proves the modules import nothing).
- **`native/llm/Cargo.lock` (65 crates, added 13 November 2026)**, each licence read from the crate's own manifest in
  the registry cache of the session that wrote it: the native model runner (llama.cpp in the app's own process, for
  the macOS, Linux, Android and iOS apps). It is compiled into no shipped build yet; only its tests run
  (`native-llm.yml`), and the Linux app built for the end-to-end test alone (`native-e2e.yml`, feature
  `tiny-model`). Linked into it (19 crates): `llama-cpp-2` and `llama-cpp-sys-2` 0.1.161 (MIT OR Apache-2.0; the
  sys crate is llama-cpp-rs at commit e7af607e), which compile the llama.cpp and ggml sources they vendor (MIT,
  Copyright 2023-2026 The ggml authors); `serde`, `serde_core`, `sha2`, `digest`, `block-buffer`, `crypto-common`,
  `cpufeatures`, `typenum`, `libc`, `thiserror`, `enumflags2`, `cfg-if`, `once_cell` and `pin-project-lite` (MIT OR
  Apache-2.0); and `tracing`, `tracing-core` and `generic-array` (MIT). Build time only, among them: `bindgen`
  (BSD-3-Clause), `clang-sys` (Apache-2.0), `libloading` (ISC), `cmake`, `cc`, `regex`, `glob` (MIT OR Apache-2.0),
  the proc-macro crates (MIT OR Apache-2.0, except `tracing-attributes`, which is MIT; `unicode-ident` adds
  Unicode-3.0), `nom` (MIT), `memchr`, `walkdir` and `same-file` (Unlicense OR MIT; `winapi-util`, also Unlicense OR
  MIT, on Windows only), and `r-efi` (MIT OR Apache-2.0 OR LGPL-2.1-or-later, so a permissive choice is available).
  The notice for what llama.cpp compiles in (ggml, the llamafile matrix code, the YaRN code, and what its common
  library brings) lands with the first app build that carries the runner.
- **`src-tauri/Cargo.lock` (427 crates; 407 before 13 November 2026)**: the 20 added are the native runner's crate and
  what it brings (the list above), recorded because the app names it as an optional, Linux-only dependency behind the
  `native-runner` feature, which is off by default: no shipped build compiles them, and the Windows and macOS builds
  link exactly what they did. The rest is the Tauri 2 stack. Tauri, `wry`, `tao`, `muda`, `tray-icon`,
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

## 7. The operator's progression (7 November 2026)

A second plan (another AI's, pasted by Julian on 7 November 2026) asked for a progression in the style of the
Pathfinder Second Edition remaster: six ability modifiers, eight skills with proficiency ranks, levels 1 to 20 at
1,000 XP, a local currency paid from a wealth table "derived from ORC GM Core Treasure by Level", hero points,
resolve, three-action pips and the four degrees of success. What was checked and what was done:

| Point | Finding |
|---|---|
| The wealth table | **Is GM Core's.** Its twenty values are the "Total Value" column of GM Core's Treasure by Level table (GM Core p. 59: 175 gp at level 1 to 490,000 gp at level 20, read on the Archives of Nethys on 7 November 2026) times ten. Using it means using GM Core as Licensed Material, so `NOTICE.md` now attributes GM Core beside Player Core. `progression.test.ts` pins the values to the published table. |
| The payout table | **The plan's own.** Each value is about a thirteenth of the level's treasure; it is not any table of either book. |
| DCs | GM Core's level-based DC table (p. 52, read the same day) and its easy adjustment (-2) are used for the operator's checks; the civic checks keep their original DCs. Pinned in `progression.test.ts`. |
| Attributes, ranks, levels, hero points, actions | Player Core mechanics (already attributed). Six attributes by their common English names and abbreviations, ranks by their names, as mechanics only; no class, ancestry, feat, spell, deity, setting or other named content of either book. |
| Resolve, the breadth bonus, the bad-luck guard, the skills of the city | The product's own mechanics, listed in `NOTICE.md` as Adapted Licensed Material. Resolve is not a Player Core mechanic. |
| The item-bonus ladder (the rest at home, November 2026) | **Licensed, not yet checked against the book.** An item's bonus to a skill, +1 from item level 3, +2 from 9, +3 from 17, the highest of one type applying, sets a rest's bonus from the deed's level (`progression.ts` `ITEM_BONUS_LEVELS`, pinned in `progression.test.ts`). `NOTICE.md` lists it as Licensed Material; its operator notes (item 3) ask which book prints it. The comfort steps (1, 3 and 5 kinds of furniture), the 30 checks and the bonus on every check rather than one skill's item in use are the product's own, listed as Adapted Licensed Material. No upstream name is used: the product says "Rest" and "prepared". |
| Upstream names in the product | None. No file under `src/` names Pathfinder, Paizo or either book (the console's tests and `progress.test.ts` check the progression's files); `NOTICE.md` names them for the attribution only. The store key is `civic-simulation:progress:v1`, not the plan's name with the game's in it. |
| What the plan asked that was not built | A reward-prediction-error multiplier that scales a payout by how much it surprises (up to 5x), a hidden pity counter that guarantees a big payout on a variable ratio, and drop tokens: mechanics whose purpose is compulsion, not play. Payouts are a fixed table the console prints (`progress table`), and a visible guard (the check after three misses rolls twice) takes the pity counter's place. No real money is involved anywhere, and the word the plan used for the conditioning stays out of the product. |

`NOTICE.md` (attribution, Licensed Material, operator note 3) and `LICENSE` (section 3) were updated; nothing else
in the licence files changed.

## 6. Left for a machine with registry access

1. Run the four `cargo license` commands above and attach the output to this document.
2. Consider adding `cargo deny check licenses` (with an allow-list of MIT, Apache-2.0, BSD, ISC, Zlib and
   Unicode-3.0, plus per-crate exceptions for MPL-2.0 naming `option-ext` and, if `cargo tree` shows them in the
   Windows build, the Servo CSS crates, once counsel has confirmed the MPL reading in §3) to `ci.yml` beside the
   `license-headers` job, so the Rust trees are held the
   way the npm tree now is. It needs network access to the registry on the runner, which CI has and this session
   did not.

## 7. Names in the storefronts and the property catalogue (7 November 2026)

The second master prompt (another AI's plan) named five shops and seven homes. Each name was searched on the web in
quotes, with its trade, for a business or a registered mark in the same line of trade, and checked against
`src/compliance.test.ts`'s list of real places. What was renamed, and why:

| Plan's name | Found | Now |
|---|---|---|
| Sovereign Thread Tailors | "Sovereign Threads, LLC" is listed as the owner of US trademarks (Justia's owner listing; the goods were not readable from here), a name one letter from the tailor's in the clothing trade | **Verrin & Vale Tailors** (no result for the name) |
| Chronos (watch shop) | CHRONOS is a registered mark, and Chronos Manufactures SA holds marks (Justia listings) | **Escapement Row Horology** (results only for the watch part "escapement") |
| Domus (design house) | Domus is an established architecture and design magazine (domusweb.it) | **Lintel & Lumen Design House** (no result for the name) |
| Harbourfront Galleria, Harbourfront Timber Loft | Harbourfront is a real Toronto neighbourhood, refused by the compliance list | **Waterline Galleria**, **Pierside Timber Loft** |
| Apex Citadel (top-tier home) | "Citadel Apex" is a place name in another video game's lore | **Crown Spire Sky-Mansion** |

Kept, with nothing found in the same trade: Aethelgard Ink Studio (the name turns up only in fantasy world-building),
Bio-Frame Prosthetics Atelier (no prosthetics business or mark of that name), and the homes' descriptive names
(Metro-Line Micro-Loft, Midtown Brownstone, Crimson Tower Penthouse, Lakefront Glass Villa, Sovereign Lakefront
Estate). A web search is not a clearance search: before the shops' names go on anything sold, counsel should run them
through the USPTO, CIPO and EUIPO registers in classes 25 (clothing), 14 (watches), 10 (prostheses), 20 (furniture),
35 (retail) and 36 (real estate). `storefronts.test.ts` and `storeCatalog.test.ts` keep the old names out of the
shops and the catalogue.

