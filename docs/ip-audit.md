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
| `vkQuake3` / `ioquake3` C code is linked or bundled | **Not present.** No file in `src/`, `native/`, `crimson_noir_os/`, `src-tauri/`, `tools/`, `world/`, `brand/`, `deploy/`, `.github/` or `docs/` contains `vkquake`, `ioquake`, `ioq3`, `quake3`, `Quake III`, `id tech`, `Id Software` or any Quake source, and there is no C or C++ source in the repository at all (the one compiled third-party module, the in-page model runtime below, has none of these names in its bytes either, and no GPL marker; llama.cpp, which the Linux app compiles in, comes from a crate's vendored copy in the build's cargo registry, not from the repository, and is MIT: its entry below). The renderer is Three.js (MIT) over WebGPU with the product's own WGSL; the OS image renders with `wgpu` (MIT OR Apache-2.0). There is no BSP, PVS or Quake-derived culler to replace. |
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

### The model the desktop apps carry (`third_party/qwen2.5-1.5b-instruct/`, added 13 November 2026)

The second set of model weights the product offers, so that a person who installs the Windows app, the Linux app, the
macOS app or the NixOS package can talk to Sloane from the first launch with no model of their own. It is held
exactly as the web copy's model is (the entry above), and none of it is in the repository:

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
- **The Linux packages (added 13 November 2026).** The same file, at the same pin, in the Linux packages: the .deb,
  the .rpm and the AppImage that `build-matrix.yml` builds on x86-64 and Arm, published on a numbered release and on
  the `current` pre-release. Its Linux jobs fetch and check the file exactly as `windows-app.yml` does (the pin's own
  cache key, Hugging Face only on a miss, `tools/web/siteModel.mjs app` on every build), and the same overlay
  (`src-tauri/tauri.model.conf.json`) bundles it, its `LICENSE` and its `NOTICE` under
  `/usr/lib/Crimson Noir Agent City/models/` (in the AppImage, the same path inside its image).
  `tools/build/linuxAudit.mjs packages` fails the job unless each package holds the three there, the model at exactly
  the pinned size. The Linux app does not hand the file to its page: its own process runs it with llama.cpp compiled
  in (the next entry). Each package is about 1 GB, six on each release. The same open points apply.
- **The macOS app (added 14 November 2026).** The same file, at the same pin, in the macOS app: the universal .app
  that `build-matrix.yml`'s macOS job builds, published as a .dmg and as a zipped .app on a numbered release and on the
  `current` pre-release. The job fetches and checks the file exactly as the Linux jobs do, and the same overlay bundles
  it, its `LICENSE` and its `NOTICE` under `Contents/Resources/models/` in the .app. `tools/build/macAudit.mjs package`
  fails the job unless the .app, the .app inside the .dmg (attached read-only) and the .app inside the zip each hold
  the three there, the model at exactly the pinned size, with llama.cpp's texts, and unless the .dmg and the zip are
  each under GitHub's 2 GiB limit for one file. The macOS app runs the file in its own process, like the Linux app
  (the next entry). The .dmg and the zip are about 1 GB each, two on each release. The same open points apply.

### The native model runner in the Linux and macOS apps (`third_party/llama.cpp/`, added 13 and 14 November 2026)

The Linux app runs the model it carries in its own process (`src-tauri/src/runner.rs` over `native/llm`), so compiled
C and C++ of a third party is in a shipped build for the first time; since 14 November 2026 the macOS app does the
same, with the same sources:

- **What it is.** llama.cpp's model library (`libllama`) and ggml (`ggml`, `ggml-base`, `ggml-cpu`), compiled from the
  sources the Rust crate `llama-cpp-sys-2` 0.1.161 vendors (crates.io; the llama-cpp-rs repository at commit
  `e7af607ebd5ec2932709ef918c17cca2f9b0fce4`) and linked statically into the app's executable through `llama-cpp-2`
  0.1.161. llama.cpp and ggml are MIT, "Copyright (c) 2023-2026 The ggml authors" (the vendored `LICENSE`). Two parts
  carry their own MIT lines in their sources: ggml's CPU matrix multiplication from llamafile (`sgemm.cpp`, Copyright
  2024 Mozilla Foundation) and its YaRN rotary scaling (`ops.cpp`, Copyright (c) 2023 Jeffrey Quesnelle and Bowen
  Peng). The two crates are MIT OR Apache-2.0. Read from the crates and the vendored sources in this session's registry
  cache, 13 November 2026; the link map of a local build names the archive members linked (llama's and ggml's own
  objects, none of llama.cpp's common library, cpp-httplib or its vendored libraries). In the macOS app's Apple
  silicon slice ggml's Metal backend (`ggml-metal`, the same MIT and the same authors) is compiled in as well, with
  its shader sources embedded in the executable (ggml's default on Apple systems, `GGML_METAL_EMBED_LIBRARY`); the
  Intel slice is built without Metal (`tools/build/macos-slices.cmake`). The macOS app links Apple's own frameworks
  (Metal, MetalKit, Foundation, Accelerate) and `libc++` from the system, which are not redistributed; ggml's BLAS
  backend is off on Apple systems (llama-cpp-sys-2 sets `GGML_BLAS=OFF` there). Since 21 November 2026 the macOS
  app also links clang's own runtime library from Xcode, compiler-rt's `libclang_rt.osx.a` (Apache-2.0 WITH
  LLVM-exception, the LLVM project), as clang does for every program it links: ggml's Metal code checks the macOS
  version below macOS 15 through its `__isPlatformVersionAtLeast`, and rustc does not link that library by itself
  (`src-tauri/build.rs`). Only the archive members that define what is asked for are linked; the LLVM exception
  waives the licence's notice conditions for such parts compiled into a program.
- **The crates the runner adds to the Linux app** (`cargo tree --target x86_64-unknown-linux-gnu`, with the feature
  against without it; each licence from the crate's manifest in the registry cache). Linked: `crimson-noir-llm` (the
  product's own), `llama-cpp-2` and `llama-cpp-sys-2` (MIT OR Apache-2.0), `enumflags2` (MIT OR Apache-2.0), and
  `tracing` and `tracing-core` (MIT). Build time only: the proc-macro crates `enumflags2_derive` (MIT OR Apache-2.0)
  and `tracing-attributes` (MIT), which run in the compiler and are not in the binary, `bindgen` (BSD-3-Clause),
  `clang-sys` (Apache-2.0), `libloading` (ISC), `cexpr` and `minimal-lexical` (Apache-2.0 or MIT), `nom` (MIT),
  `cmake`, `either`, `find_cuda_helper`, `itertools`, `jobserver`, `prettyplease` and `shlex` (MIT OR Apache-2.0).
  Every other crate of `native/llm/Cargo.lock` was already in the app. `cargo tree --target aarch64-apple-darwin` and
  `--target x86_64-apple-darwin`, with the feature against without it, list the same additions for the macOS app
  (read on 14 November 2026, from the lockfile; no Apple build ran in that session).
- **How it is held.** Nothing of llama.cpp is in the repository. Only the Linux and macOS release builds compile it
  (cargo feature `native-runner`, which `tools/build/matrix.mjs` passes for linux-x64, linux-arm64 and macos-universal
  alone); the Windows, Android and iOS builds, the page and the OS media do not. `tools/build/linuxAudit.mjs symbols`
  fails a Linux build whose binary keeps any download, Hugging Face cache, Docker, HTTP or subprocess code of
  llama.cpp's common library, cpp-httplib, OpenSSL or curl (from the linker's map and the libraries), or holds their
  strings, imports a network call or needs OpenSSL, curl or OpenMP. `tools/build/macAudit.mjs symbols` holds each
  slice of the macOS app to the same list (from each slice's Apple linker map, the binary's strings and each slice's
  imports), and `libraries` fails it if either slice loads anything but macOS's own libraries.
- **The texts.** `third_party/llama.cpp/LICENSE` is the vendored `LICENSE`, byte for byte (sha256
  `94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d`); `third_party/llama.cpp/NOTICE` says what is
  compiled in, from where, and under which lines. The model overlay installs both in every Linux package as
  `/usr/share/doc/crimson-noir-agent-city/llama.cpp/LICENSE` and `NOTICE`, and puts both in the macOS app as
  `Contents/Resources/licenses/llama.cpp/LICENSE` and `NOTICE`; each package check fails without them.
  `NOTICE.md` has a paragraph under "Third-party software" and names llama.cpp in its trademark paragraph.
- **Open points, for the owner before a release.** llama.cpp's `unicode-data.cpp` (linked) is generated from the
  Unicode Character Database, whose licence (Unicode-3.0) asks for its notice in copies of the data: have counsel say
  whether the NOTICE should carry it (the Tauri tree already brings Unicode-3.0 crates, the same question). The
  crates linked into the app (the list above, and the Tauri stack's in §3) carry their MIT and Apache-2.0 notices in
  their sources only; the Linux packages and the macOS app carry no collected notice of them yet, as the Windows
  installer installs none.

### The speech pack the web copy serves (`third_party/moonshine-tiny-en/`, `third_party/onnxruntime-web/1.31.1/`, added 14 November 2026)

The microphone turned speech into words only where the browser has an on-device recogniser of its own, which is a
few browsers. The page now has its own, so a second third-party runtime is bundled and a second set of model weights
is served beside the web copy:

- **What it is.** Two things, both MIT. (1) ONNX Runtime Web 1.31.1 (npm `onnxruntime-web`, Copyright (c) Microsoft
  Corporation), the sixth runtime dependency, pinned exactly: its script `dist/ort.wasm.bundle.min.mjs` (one
  self-contained file with no static import; `speechRuntimeLean.test.ts` and `compliance.test.ts` hold that) is
  bundled into the page inside the speech worker, and its WebAssembly module `dist/ort-wasm-simd-threaded.wasm`
  (14,848,852 bytes, sha256 `4b884c203b0fa48d057be3332c65513ff85aa3c5bddd6946acc0fab7ecda001d`) is served beside
  the web copy, unchanged. (2) Moonshine Tiny, the English speech-to-text model by Useful Sensors, Inc. (Copyright
  (c) 2025 Useful Sensors, Inc.), as quantized ONNX: `encoder_model.onnx` (7,937,661 bytes, sha256
  `c6fc4b7bc5af75c0591fd157a1f3829b533d18e9769a888fd95a62e470dd4f4a`) and `decoder_model_merged.onnx` (20,243,286
  bytes, sha256 `eed87831c3a6103534aae7d47a5d485025c659a1323901513961c39fe8a1a367`), the files of those names under
  `dist/model/tiny/quantized/` in the registry tarball of `@moonshine-ai/moonshine-js` 0.1.29 (21,514,347 bytes,
  sha256 `864e17a00ed494857c71693e835306fa038e0f82002c76e3056d67d574e1c2d8`), and its vocabulary `tokens.json`
  (307,261 bytes, sha256 `23a600089d29502c8966c95cb1b6318e015bbaf23e130fab6f4bb078402c9420`; 32,000 word pieces),
  written from the vendor's tokenizer file in its PyPI package `useful-moonshine-onnx` 20251121. None of that npm
  package's code is used and it is not a dependency; the same vendor's Spanish model, whose licence limits commercial
  use, is not fetched, served or named in any code.
- **How it is held.** The model's two files and the WebAssembly module are never committed and never in the page;
  `tokens.json` is committed (a list of word pieces, 307 KB). `src/09_Cognition/speechPack.ts` pins the four files
  (`SPEECH_PACK`: each file's name, size and SHA-256), the `SHA256SUMS` files beside the licences hold the same lines,
  and `speechPack.test.ts` and `speechTool.test.ts` hold them equal. The web workflow takes the model from the npm
  registry's tarball whenever its cache (keyed by the whole pin) lacks it, the module from the installed dependency
  and the vocabulary from the repository, and on every publish `tools/web/speechPack.mjs place` checks each file's
  size and SHA-256 against the pin while copying it into `dist-web/speech/`, with a manifest and the six licence and
  notice files; a mismatch fails the publish. `place` refuses a folder that is not the web copy, so `dist/` never gets
  the pack, and `tools/verify/page_dist.mjs` fails a `dist/` that holds an `.onnx` file, or any file but the page. The page
  downloads the pack from its own site, checks the same hashes in the worker before any file is run, and keeps it in
  that browser's Cache Storage. ci's `speech` job reads a synthetic sentence with the pinned pack under Node and in a
  desktop Chromium on every run.
- **The texts.** The npm package of ONNX Runtime Web ships no licence file. `third_party/onnxruntime-web/1.31.1/`
  holds `LICENSE` and `ThirdPartyNotices.txt`, the files of those names at tag `v1.31.1` of
  `github.com/microsoft/onnxruntime`; `EMSCRIPTEN-NOTICES.txt`, the licences of what the Emscripten compiler adds to
  a WebAssembly build (Emscripten's runtime, musl libc, LLVM's libc++, libc++abi and compiler-rt), taken at
  Emscripten 4.0.23, the version the build script of that tag names by default; `SCRIPT-LICENCE`, which the build
  embeds in the page for the bundled script (`vite.config.ts` `RECORDED_LICENCES`: a recorded text stands in for a
  package's missing licence file only at the exact version it was recorded for, and the build still fails a bundled
  package with neither); and `NOTICE`. `third_party/moonshine-tiny-en/` holds `LICENSE` (the MIT section of the
  vendor package's LICENSE file, whose opening lines put "the code in this repo and the English-language Moonshine
  speech to text model it uses" under MIT), `NOTICE`, `SHA256SUMS` and `tokens.json`. The web workflow serves all six
  texts beside the pack. `NOTICE.md` (two paragraphs under "Third-party software", the trademark paragraph, operator
  note 15) and `LICENSE` section 4 name them.
- **Open points, for the owner before a release.** They are operator note 15 of `NOTICE.md`: the model's licence
  statement was read in the vendor's npm package and not compared with its Hugging Face model card; the model files
  come from that npm package and were not compared with the vendor's other copies; the vocabulary appears to be the
  32,000-piece vocabulary of the LLaMA model family, which the vendor redistributes inside its MIT packages, and its
  first source was not traced; which of ONNX Runtime's listed third-party components are in the WebAssembly build
  was not audited; that Microsoft built the module with exactly Emscripten 4.0.23 was not verified; the microphone
  opens when the city starts and each new visitor downloads 41 MB (GitHub Pages' soft limit of 100 GB a month, with
  the 0.4 GB model above); and the model is small and English-only.

## 2. The npm dependency tree (`package-lock.json`)

Checked every entry of the lockfile by its `license` field (the test does the same on every run).

| Licence | Packages | Where |
|---|---|---|
| MIT | 103 | runtime and build |
| Apache-2.0 | 6 (`@dimforge/rapier3d-compat`, `@dimforge/rapier3d-simd-compat`, `detect-libc`, `typescript`, `flatbuffers`, `long`) | Rapier at runtime; `flatbuffers` and `long` installed with ONNX Runtime Web and not bundled (below); the rest build-only |
| Apache-2.0 OR MIT | 12 | build-only (Rust-built binaries of the toolchain) |
| ISC | 3 (`graceful-fs`, `picocolors`, `guid-typescript`) | build-only; `guid-typescript` installed with ONNX Runtime Web and not bundled |
| BSD-3-Clause | 11 (`source-map-js`, `protobufjs` and nine `@protobufjs/*`) | `source-map-js` build-only; the rest installed with ONNX Runtime Web and not bundled |
| Unlicense | 1 (`fast-sha256`) | build-only |
| MPL-2.0 | 24, all `lightningcss` and its per-platform binaries | **devDependency only**: Tailwind's CSS compiler. It runs at build time and none of its code is in `dist/index.html`; its MPL obligations attach to its own files, which are not redistributed. The build's embedded notice (`vite.config.ts`, `noticesComment`) lists only bundled packages: `react`, `react-dom`, `scheduler`, `three`, `@dimforge/rapier3d-simd-compat`, `@wllama/wllama`, `onnxruntime-web`, all MIT or Apache-2.0, and the pinned runtimes' own notices (§1). |
| GPL, AGPL, LGPL, SSPL, EUPL, non-commercial | **0** | |

The six runtime dependencies in `package.json` (`react`, `react-dom`, `three`, `@dimforge/rapier3d-simd-compat`,
`@wllama/wllama` pinned at exactly 3.8.1, `onnxruntime-web` pinned at exactly 1.31.1) are MIT or Apache-2.0. Five
ship their licence text (`compliance.test.ts`, "the real runtime dependencies all have a licence file the build can
embed"; `@wllama/wllama`'s file is named `LICENCE`); `onnxruntime-web` ships none, so the text recorded for that exact
version stands in for it (§1, the speech pack). `compliance.test.ts` lists the six by name, so a seventh comes
through this audit.

`onnxruntime-web` brings sixteen packages into the lockfile (14 November 2026): itself and `onnxruntime-common`
(MIT), `platform` (MIT), `flatbuffers` and `long` (Apache-2.0), `guid-typescript` (ISC), `protobufjs` and nine
`@protobufjs/*` packages (BSD-3-Clause). The page bundles one file of `onnxruntime-web` only, a script that imports
nothing (`compliance.test.ts` reads it for an import in the npm tree test). That script has `onnxruntime-common`
(MIT, Microsoft Corporation, the same project and the same licence) compiled into it by Microsoft's own build, so
that package's code is in `dist/index.html`, under the licence text the build embeds for the script; none of the
other fourteen is in `dist/index.html` or served: they are installed because the package lists them for its other
builds.

## 3. The Rust dependency trees (read from the registry on 22 November 2026)

When this audit was first written the crates' licences could not be read from the cloud session (crates.io was not
reachable), and this section listed them from general knowledge. That is no longer so. On 22 November 2026 every
crate of all six lockfiles was read from the registry with `cargo metadata --locked --all-features`, and the answer
is committed as `tools/license/crates.json`: 550 crates, each with the licence its own manifest declares. §8 says
what the gate that reads it holds them to and what it found. In short: every crate offers a permissive licence,
except five under MPL-2.0 that the policy names one by one; none is under a GPL, AGPL, SSPL or any other share-alike
or non-commercial licence, and the two versions of `r-efi` that list LGPL-2.1-or-later list it as one of three
choices, beside MIT and Apache-2.0.

The same command proves it again on every pull request (`crate-licences`, in ci's Rust job), so the notes below are
kept as the record of how each tree was first read, with what the registry has since settled marked as such:

- **`crimson_noir_os/Cargo.lock` (149 crates from the registry)** and **`native/kv-pager/Cargo.lock` (125)**: the
  `wgpu` stack (`wgpu`, `wgpu-core`, `wgpu-hal`, `naga`, `ash`, `glow`, `metal`/`objc2`, `windows`), `bytemuck`,
  `font8x8`, `log`, `env_logger`, `serde`, `tokio`, `parking_lot`, `hashbrown`, `indexmap`. Read from the registry:
  every one offers MIT, Apache-2.0, BSD, ISC, Zlib, Unlicense, CC0-1.0 or Unicode-3.0. The boot images link two
  registry crates only, `font8x8` and `log` (`cargo tree -p crimson_boot -e normal` for the x86-64, AArch64 and
  RISC-V targets alike), both MIT OR Apache-2.0, and `crimson_noir_os/NOTICE.txt`, which `build-image.sh` copies
  into every image, covers them. The image contains no Linux kernel or other GPL code.
- **`native/routing/Cargo.lock`** and **`native/kv-pager-wasm/Cargo.lock`**: no third-party crates at all (the
  routing core and the WebAssembly host import nothing; the air-gap check proves the modules import nothing).
- **`native/llm/Cargo.lock` (65 crates, added 13 November 2026)**, each licence read from the crate's own manifest in
  the registry cache of the session that wrote it: the native model runner (llama.cpp in the app's own process, for
  the macOS, Linux, Android and iOS apps). Since 13 November 2026 the Linux app's release builds compile it, and
  since 14 November 2026 the macOS app's (`build-matrix.yml`, feature `native-runner`; §1, "The native model runner in
  the Linux and macOS apps"); its tests run in
  `native-llm.yml`, and `native-e2e.yml` builds the Linux app with the tiny test model. Linked into it (19 crates):
  `llama-cpp-2` and `llama-cpp-sys-2` 0.1.161 (MIT OR Apache-2.0; the sys crate is llama-cpp-rs at commit e7af607e),
  which compile the llama.cpp and ggml sources they vendor (MIT,
  Copyright 2023-2026 The ggml authors); `serde`, `serde_core`, `sha2`, `digest`, `block-buffer`, `crypto-common`,
  `cpufeatures`, `typenum`, `libc`, `thiserror`, `enumflags2`, `cfg-if`, `once_cell` and `pin-project-lite` (MIT OR
  Apache-2.0); and `tracing`, `tracing-core` and `generic-array` (MIT). Build time only, among them: `bindgen`
  (BSD-3-Clause), `clang-sys` (Apache-2.0), `libloading` (ISC), `cmake`, `cc`, `regex`, `glob` (MIT OR Apache-2.0),
  the proc-macro crates (MIT OR Apache-2.0, except `tracing-attributes`, which is MIT; `unicode-ident` adds
  Unicode-3.0), `nom` (MIT), `memchr`, `walkdir` and `same-file` (Unlicense OR MIT; `winapi-util`, also Unlicense OR
  MIT, on Windows only), and `r-efi` (MIT OR Apache-2.0 OR LGPL-2.1-or-later, so a permissive choice is available).
  The notice for what llama.cpp compiles in (ggml, the llamafile matrix multiplication, the YaRN code) is
  `third_party/llama.cpp/NOTICE`, installed with the Linux app and held in the macOS app; none of its common library
  is linked.
- **`src-tauri/Cargo.lock` (426 crates from the registry)**: the 20 added on 13 November 2026 are the native runner's crate and
  what it brings (the list above), an optional dependency for Linux and macOS alone behind the `native-runner`
  feature, which is off by default: the Linux and macOS release builds turn it on (§1), and the Windows builds link
  exactly what they did. The rest is the Tauri 2 stack. Tauri, `wry`, `tao`, `muda`, `tray-icon`,
  `window-vibrancy`, `webview2-com`, the `windows` crates, `serde`, `tokio`, `reqwest`, `url`, `html5ever`,
  `brotli`, `png`, `uuid`: MIT, Apache-2.0, or both; the ICU crates (`icu_*`, `zerovec`, `yoke`) are Unicode-3.0;
  `r-efi` (via `getrandom`) is MIT OR Apache-2.0 OR LGPL-2.1-or-later, so a permissive choice is available.
  **File-level copyleft (MPL-2.0) that reaches every app:** five crates, and the registry confirms each is
  MPL-2.0. `option-ext` 0.2.0 comes in through `tauri` → `dirs` → `dirs-sys`; the Servo CSS crates `cssparser`,
  `selectors` and `dtoa-short` come in through `dom_query`, which both `tauri-utils` and `wry` use;
  `cssparser-macros` is a procedural macro of `cssparser`'s, so it runs while the app is built and is not linked
  into it. Settled on 22 November 2026 with `cargo tree --locked --target <target> -e normal`: all five are in the
  normal dependency graph of the Windows, Linux, macOS, Android and iOS apps alike, with the runner's feature or
  without it, so the four library crates are compiled into every app the build matrix publishes. MPL-2.0 is
  file-level: as commonly read, a proprietary program may link MPL files unchanged, provided the source of those
  files stays available to recipients and their notices are kept. **For counsel:** confirm that reading for this
  product. Nothing here was modified, and no MPL file is copied into the repository; the policy allows MPL-2.0 for
  these five by name and for nothing else (§8), and §8 records the notices the app packages do not yet carry.
  **Two more to confirm:** the crates recorded **only for Linux targets**, `libappindicator`/`libappindicator-sys`
  (the tray on Linux, wrapping an LGPL system library; the crates' own manifests in the registry cache say Apache-2.0
  OR MIT) and `libdbus-sys` (links the system `libdbus`, AFL-2.1 OR GPL-2.0 as a system library). `libdbus-sys` is
  compiled into the Linux app (through `tao` → `dbus`) and links the system `libdbus-1` dynamically (the binary needs
  `libdbus-1.so.3`); the build matrix publishes that app as `.deb`, `.rpm` and `.AppImage` (on a numbered release and
  on the `current` pre-release). `libappindicator`/`libappindicator-sys` are in the lockfile only as dependencies of
  `tray-icon`, an optional Tauri feature this app does not turn on, so no build compiles them (`cargo tree --target
  x86_64-unknown-linux-gnu -i libappindicator` prints nothing, with the runner's feature or without it). The Windows
  installer and executable compile neither, since the tray and the webview come from `windows`/`webview2-com`
  (Microsoft's WebView2 runtime is a system component, not redistributed). `libdbus-sys` therefore needs a decision
  (the Tauri project's own position is that dynamic linking to it is fine; counsel should confirm it for a proprietary
  product), and `libappindicator` would need one if the tray feature is ever turned on. The AppImage also carries a
  copy of `libdbus-1.so.3` itself, with its package's copyright file (an `unsquashfs` listing of the AppImage the
  rehearsal built on Ubuntu 24.04, 13 November 2026), so for the AppImage the question is redistributing that library
  as well as linking to it.

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

## 6. Left for a machine with registry access (done, 22 November 2026)

Both points are done, in another form. The licences were read with `cargo metadata` itself (it needs no extra tool
on the runner) and are committed as `tools/license/crates.json`; and the gate of §8 does in ci's Rust job what
`cargo deny check licenses` was proposed for, with the allow-list and the five MPL-2.0 crates named in
`tools/license/policy.json`.

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

## 8. The licence gate and what its first run found (22 November 2026)

Julian asked that every change be checked so the product stays legal to sell. A machine cannot give that answer,
but it can refuse the mistakes a machine can see, on every pull request. `tools/license/gate.mjs` does, against
`tools/license/policy.json`, and it is **not legal advice**: it proves that what the policy says is true of the
files, not that the policy is enough. What it holds:

| Check | What fails it | Where it runs |
|---|---|---|
| Crates | A crate in any of the six lockfiles that `tools/license/crates.json` does not list, or lists under a licence the policy does not allow (the permissive family; `LLVM-exception`; MPL-2.0 for five crates by name) | `src/licenceGate.test.ts`, with every test run |
| Crates, from the registry | The committed list differing from what `cargo metadata --locked --all-features` reads from the registry for each workspace | `crate-licences`, in ci's Rust job |
| Names | A name on the policy's list of other owners' names, in any text file of the repository (the page's older check, `compliance.test.ts`, reads the page's sources only) | the test |
| Pictures and packed files | A picture, icon or packed data file with no entry saying where it came from and whose it is | the test |
| Third-party directories | A directory under `third_party/` the policy does not name, or one without its licence text and notices | the test |

`node tools/license/gate.mjs` runs the last four from the files alone; `node tools/license/gate.mjs crates --write`
rewrites the list after a lockfile changes, and its diff is the review of what the change brought in.

**What the first run found, and what was done.**

1. **A film franchise's mark in two screenshots and two documents.** The terminal carried another name before it
   was the Crimson Terminal, and that name held a film franchise's mark. The code was renamed long ago;
   `crimson_noir_os/docs/screenshots/08-terminal-ready.png` and `09-terminal.png` still showed the old header, and
   `crimson_noir_os/README.md` and `agent_handoff_state.md` still spelled the mark in their notes about the rename.
   The screenshots were retaken from this commit's x86-64 image in QEMU and the notes reworded.
   **Not fixed, and Julian's to decide:** the boot file `BOOTX64.EFI` on the published release tagged `stable-beta`
   (7 October 2026) still contains the old name (read from the downloaded file's strings). The numbered releases
   after it and the `current` pre-release do not. Removing or replacing a published release is the owner's step.
2. **"Matrix mode" in the manual, the changelog and forty comment lines.** The labels a user sees have said "rain
   mode" since the rename; a heading and two sentences of `MANUAL.md`, one changelog entry and comments in 22 source
   files had not followed. They now say "rain mode". Identifiers and file names (`matrixMode.ts` and the like) are
   unchanged: they are not shown to anyone, and the name check reads prose, not identifiers.
3. **The crates.** All 550 pass. By what each declares: 516 are under MIT or Apache-2.0 or offer one of them as a
   choice (most offer both; four of these name a second permissive licence that applies as well); 18 are
   Unicode-3.0 (the ICU crates); four are Zlib, three BSD-3-Clause, two ISC, one CC0-1.0, one Apache-2.0 with the
   LLVM exception; five are MPL-2.0 (§3). Share-alike or non-commercial: none.
4. **A gap the first run found, closed by the change after it: the app packages carried no notices for their Rust
   crates.** Each app links between 205 and 250 registry crates (`cargo tree --locked --target <target> -e normal
   --prefix none`, counted per target on 22 November 2026, procedural macros included). MIT, BSD, ISC, Zlib and
   Apache-2.0 all ask that their copyright notice and licence text travel with copies, and MPL-2.0 asks that
   recipients be told where the source of its files is. The packages carried the notices for the model, llama.cpp
   and the page's bundled JavaScript, and nothing for the crates. The boot images are not affected (two crates,
   covered by `NOTICE.txt`). Most Rust applications ship this way and it is rarely pursued, but it is a duty in the
   licences' own words. Now `tools/license/notices.mjs` writes `src-tauri/notices/RUST-CRATES.txt` from the same
   `cargo metadata`, the crates' own packages and the Rust toolchain: all 426 crates of the apps' lockfile (every
   platform's, so each app's file names more crates than that app links, never fewer), the 220 distinct licence,
   copyright and notice texts they ship, the source location of each MPL-2.0 crate, for the 41 crates whose
   packages have no licence text of their own their authors and the text of the licence taken, and the Rust
   project's own statement of the standard library's copyrights for the rustc the apps are built with (1.97.0). The
   app's program holds the file whole and every package ships it as `licenses/RUST-CRATES.txt`; CI fails when the
   file is not what the registry and the toolchain give or when a build does not hold it.

   **Licence files inside a package.** Fourteen licence files sit below the top folder of five packages and cover
   something the package carries, not the crate. Each is accounted for by a rule in `tools/license/policy.json`
   (`notices.nested`), and a file without a rule stops the tool. Reproduced (six): llama.cpp's licence and those of
   four libraries it carries (`llama-cpp-sys-2`), and the Unicode data licence of the tables `regex-syntax`
   compiles into every app. Named and not reproduced (eight), because no app is built with what they cover:
   - `hidapi` carries the HIDAPI library in C, which its authors offer under any one of three licences, one of them
     the GPL version 3. The crate compiles that C source on Windows only without its `windows-native` feature. The
     apps take the crate for Windows alone and with that feature, where it is Rust over the system's own HID
     interface, so no app holds any of that C code and the choice among the three licences never arises.
   - `libdbus-sys` carries the D-Bus library's source for its `vendored` feature, which is off. The Linux app
     loads the D-Bus library the system provides (already among the questions for counsel below).
   - `tracing-core` carries a copy of a once cell that it compiles only without `std`; the apps take it with `std`.

   Each of those three statements is a condition the tool reads from cargo's answer on every run (the feature that
   is on, the feature that is off, the one platform the crate is taken for). When a dependency change makes one
   untrue, `crate-licences` fails and names the rule.

   What it does not settle: whether a notice inside the program and a file in the package is enough in every
   store's eyes (the phones' stores have their own rules for showing licences); whether the standard library's
   statement for all of its platforms is the right form for each app; and the reading of each licence, which is
   counsel's.
5. **The cover picture.** `docs/cover.jpg` carries Content Credentials (a C2PA manifest) signed by Google's media
   services, so it was made or last edited with one of Google's generative image tools. Julian supplied it and it
   was committed on 16 October 2026. Which tool and which plan made it is not recorded, so its terms for commercial
   use have not been read; a picture a model made may carry no copyright of the owner's, which matters if it is to
   be the product's box art; and it shows the earlier title. The gate repeats this as an open question on every run
   until the policy records the answer.
6. **Checked and found in order.** The AppImage carries the copyright file of each system library it bundles
   (`usr/share/doc/<package>/copyright`), the LGPL ones included; an earlier lead that it did not was wrong.

**Left for the owner and for counsel.** None of this can be settled by a check:

- the `stable-beta` release's boot file (point 1): delete the release, replace its files, or leave it;
- the cover picture's tool and terms, and whether to replace it before anything is sold (point 5);
- the MPL-2.0 reading of §3, and the position on the LGPL system libraries the AppImage carries and the Linux app
  links (a written offer of their source, or a pointer to the distribution's), §3's `libdbus` question with them;
- clearance of the product's name and of the names in §7 in the trademark registers, which no web search replaces;
- the ORC question of §4.
