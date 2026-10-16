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
| `vkQuake3` / `ioquake3` C code is linked or bundled | **Not present.** No file in `src/`, `native/`, `crimson_noir_os/`, `src-tauri/`, `tools/`, `world/`, `brand/`, `deploy/`, `.github/` or `docs/` contains `vkquake`, `ioquake`, `ioq3`, `quake3`, `Quake III`, `id tech`, `Id Software` or any Quake source, and there is no C or C++ source in the repository at all. The renderer is Three.js (MIT) over WebGPU with the product's own WGSL; the OS image renders with `wgpu` (MIT OR Apache-2.0). There is no BSP, PVS or Quake-derived culler to replace. |
| MakeHuman / MPFB Python source is bundled | **Not present.** No `makehuman` or `mpfb` anywhere. The pedestrians are procedural meshes built in `src/03_Spawn_Agents/`; no exported character mesh, skeleton or blendshape from any character tool is in the repository, so there is nothing to re-licence. The CC0 gate (`src/01_Initialize_World/assets/cc0.ts`) is a filter over asset names (it purges weapon words), not a store of CC0 meshes; the plan misread its name. |
| Pathfinder 2e ability scores (`STR`, `DEX`, …) in production code | **No ability scores.** No ability score (`STR`, `DEX`, `CON`, `INT`, `WIS`, `CHA`) or ability modifier is in the code. What the product does borrow under the ORC Licence is listed in `NOTICE.md` ("Licensed Material"): the four degrees of success, the proficiency ranks **with their bonuses** (`RANK_BONUS` in `src/02_Define_The_Rules/degrees.ts`: untrained +0, trained +2, expert +4, master +6, legendary +8, plus the level from trained up, which is the Pathfinder 2e proficiency table), fortune/misfortune and the exact outcome odds (`degrees.ts`, mirrored in `crowd.wgsl`), and the checks built on them, among them a Reflex-style save (`YIELD_SAVE` in `src/02_Define_The_Rules/civic.ts`, a modifier against a DC; the same wording is in `crowd.wgsl`). The "Vance" persona JSON the plan refers to is in the plan's own source document, not in this repository (the file `context engineered system prompt` at the root is a 22-line research-analyst prompt with no stat block). Renaming scores that do not exist changes nothing; see §4 on the ORC point that does exist. |

## 2. The npm dependency tree (`package-lock.json`)

Checked every entry of the lockfile by its `license` field (the test does the same on every run).

| Licence | Packages | Where |
|---|---|---|
| MIT | 99 | runtime and build |
| Apache-2.0 | 4 (`@dimforge/rapier3d-compat`, `@dimforge/rapier3d-simd-compat`, `detect-libc`, `typescript`) | Rapier at runtime; the rest build-only |
| Apache-2.0 OR MIT | 12 | build-only (Rust-built binaries of the toolchain) |
| ISC | 2 (`graceful-fs`, `picocolors`) | build-only |
| BSD-3-Clause | 1 (`source-map-js`) | build-only |
| Unlicense | 1 (`fast-sha256`) | build-only |
| MPL-2.0 | 24, all `lightningcss` and its per-platform binaries | **devDependency only**: Tailwind's CSS compiler. It runs at build time and none of its code is in `dist/index.html`; its MPL obligations attach to its own files, which are not redistributed. The build's embedded notice (`vite.config.ts`, `noticesComment`) lists only bundled packages: `react`, `react-dom`, `scheduler`, `three`, `@dimforge/rapier3d-simd-compat`, all MIT or Apache-2.0. |
| GPL, AGPL, LGPL, SSPL, EUPL, non-commercial | **0** | |

The four runtime dependencies in `package.json` (`react`, `react-dom`, `three`, `@dimforge/rapier3d-simd-compat`)
are MIT or Apache-2.0 and each ships its licence text (`compliance.test.ts`, "the real runtime dependencies all have
a licence file the build can embed").

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
