# Notices

This file is the notice the ORC License requires, plus the credits and third-party notices for this
product. The build embeds it in `dist/index.html` (without the operator notes at its end), so the
notice travels with the product; the Concierge card also shows the ORC Notice as fine print.

## ORC Notice

> This product is licensed under the ORC License located at the Library of Congress at TX 9-307-067 and available online at various locations including www.azoralaw.com/orclicense and others. All warranties are disclaimed as set forth therein.

## Attribution

This product is based on the following Licensed Material:

- Pathfinder Player Core © 2023 Paizo Inc., Designed by Logan Bonner, Jason Bulmahn, Stephen
  Radney-MacFarland, and Mark Seifter. Authors: Alexander Augunas, Kate Baker, Logan Bonner, Jason
  Bulmahn, Carlos Cabrera, Calder CaDavid, James Case, Eleanor Ferron, Steven Hammond, Joan Hong,
  Vanessa Hoskins, James Jacobs, Jenny Jarzabski, Erik Keith, Dustin Knight, Lyz Liddell, Luis Loza,
  Patchen Mortimer, Dennis Muldoon, Stephen Radney-MacFarland, Mikhail Rekun, David N. Ross, Michael
  Sayre, Mark Seifter, Kendra Leigh Speedling, Mark Thompson, Clark Valentine, Andrew White, Landon
  Winkler, and Linda Zayas-Palmer.
- Pathfinder GM Core © 2023 Paizo Inc., Designed by Logan Bonner and Mark Seifter. Authors: Amirali Attar
  Olyaee, Logan Bonner, Creighton Broadhurst, Jason Bulmahn, James Case, Jesse Decker, Eleanor Ferron, Fabby
  Garza Marroquín, Jaym Gates, Matthew Goetz, James Jacobs, Brian R. James, Jenny Jarzabski, Dustin Knight,
  Jason LeMaitre, Lyz Liddell, Luis Loza, Ron Lundeen, Stephen Radney-MacFarland, David N. Ross, Michael Sayre,
  Mark Seifter, Owen K.C. Stephens, Amber Stewart, Clark Valentine, Landon Winkler, and Linda Zayas-Palmer.

If you use our Licensed Material in your own published works, please credit us as follows:

- Crimson Noir: Agent City © 2026 Julian Cassius Subban.

Naming the upstream work is attribution only, as Section III(b) of the ORC License requires. This
product is not affiliated with, sponsored or endorsed by Paizo Inc. or any other licensor (Section
II(d)(i)). Pathfinder is a trademark of Paizo Inc. and is used here only to identify the attributed
work; no upstream name, setting or text appears in the product.

## Licensed Material

The game mechanics in this product are Licensed Material under the ORC License, including but not
limited to:

- **Degrees of success** (`src/02_Define_The_Rules/degrees.ts`, mirrored in `crowd.wgsl`): four
  degrees (critical failure, failure, success, critical success); meeting a DC succeeds, beating it by
  10 is a critical success, missing it by 10 is a critical failure; a natural 20 raises and a natural 1
  lowers the result one degree; proficiency ranks (untrained, trained, expert, master, legendary);
  fortune and misfortune (roll twice, keep the higher or the lower die); exact outcome odds.
- **Checks this product adds on top** (Adapted Licensed Material, `civic.ts`, `traffic.ts`,
  `crowd.wgsl`): a pedestrian's yield save whose DC rises with the approaching vehicle's speed; a
  driver's perception check whose degree sets a reaction latency before a comfortable stop; a waiting
  pedestrian's walk-start check whose degree sets a start delay after the walk signal.
- **The three-law command ruling** (`laws.ts`): the ranking under which every vehicle command is
  vetted (protect people, then follow instructions, then preserve the vehicle), the stopping-envelope
  test and the standoff distance.
- **The operator's progression** (`src/02_Define_The_Rules/progression.ts`, kept by
  `src/07_Execute_Actions/progress.ts`): six attribute modifiers (strength, dexterity, constitution,
  intelligence, wisdom, charisma) and attribute boosts at levels 5, 10, 15 and 20, four to different
  attributes, a boost at +4 or more counting half; skill proficiency ranks with one skill increase a level,
  master from level 7 and legendary from level 15; levels 1 to 20 at 1,000 XP each; the level-based DC
  table and the easy adjustment (-2); hero points (at most three, one at the start of a session, spent to
  reroll a check); three actions and a reaction per six-second round; the treasure-by-level table, at ten
  credits to the gold piece, and fifteen gold pieces of starting wealth; item bonuses to skills (+1 from item
  level 3, +2 from 9, +3 from 17; of several bonuses of one type only the highest applies).
- **What the progression adds on top** (Adapted Licensed Material, the same files): eight skills of the
  city (computers, piloting, robotics, cyber security, swarm command, acoustics and voice, optics and
  cinema, architecture and commerce) and the attribute each adds; a check for each thing the operator does,
  paid by degree from a fixed table; the payout by level; a breadth bonus by how many different skills a
  cycle of checks has used; resolve, capped by constitution; a bad-luck guard that gives the check after
  three misses in a row fortune; a minute's rest before a skill earns again; civic credits and the unlocks
  they buy; a rest at a home the operator owns, whose item bonus follows the deed's level, is capped by the
  home's comfort (+1 from one kind of furniture standing there, +2 from three, +3 from five) and applies to every
  check for the next 30 rather than to one skill while an item is in use.
- **The 5-Whys intent engine** (`intent.ts`): the question-selection tables and the plan mapping are
  this product's own mechanics. The "5 Whys" questioning technique itself is a long-established, public
  root-cause method and is not claimed.

## Reserved Material

Reserved Material elements in this product include, but may not be limited to: the product name
Crimson Noir: Agent City and its short form Crimson Noir (set in `src/brand.ts`), and the terminal host name derived
from them; the product logo, a city skyline of five towers and a spire over one crimson line on an ink rounded square
(`MonolithLogo`, `MONOLITH_SVG`), at every size, as the favicon and as the app and home-screen icons; the product's trade dress, namely the frosted-glass
HUD, the boot splash, the Concierge card and the arrangement of their panels; the visual art of the city, its procedural
models, materials and textures; the product's sound design; and all elements designated as Reserved
Material under the ORC License.

## Expressly Designated Licensed Material

None. No Reserved Material of this product is designated as Licensed Material.

## Other credits

- **Three Laws.** The ranked safety kernel follows the Three Laws of Robotics that Isaac Asimov
  introduced in the short story "Runaround" (1942). The concept is credited to Isaac Asimov; the
  wording of the laws in this product is original and reproduces none of his text. This product is
  not affiliated with or endorsed by his estate.
- **Monk Skin Tone Scale.** Ten of the character customizer's skin tones (`mst-01` to `mst-10`,
  `src/03_Spawn_Agents/look.ts` and `crowd.ts`) are the Monk Skin Tone Scale developed by Dr. Ellis Monk and
  published by Google under the Creative Commons Attribution 4.0 International licence (CC BY 4.0). The ten
  colour values are used as published, unmodified; the
  scale is credited to Dr. Ellis Monk. This product is not affiliated with or endorsed by him or by Google.
- **Motion blur.** The cinema camera's shutter reconstructs motion blur with the tile-based filter published
  by Morgan McGuire, Padraic Hennessy, Michał Bukowski and Brian Osman ("A Reconstruction Filter for Plausible
  Motion Blur", I3D 2012) and the direction-aware gather of Jean-Philippe Guertin, Morgan McGuire and Derek
  Nowrouzezahrai ("A Fast and Stable Feature-Aware Motion Blur Filter", HPG 2014). The implementation is
  original; the algorithms are credited to their authors.

## Third-party software

The build bundles the following open-source packages. Each remains under its own license, not the
ORC License. The build embeds the full license text of every bundled package at the end of
`dist/index.html`; the same texts are in `node_modules/<package>/LICENSE`.

| Package | License | Copyright |
|---|---|---|
| react, react-dom, scheduler | MIT | Meta Platforms, Inc. and affiliates |
| three (three.js) | MIT | three.js authors |
| @dimforge/rapier3d-simd-compat (Rapier) | Apache-2.0 | Dimforge and the Rapier contributors |
| tailwindcss (generated CSS) | MIT | Tailwind Labs, Inc. |
| @wllama/wllama (wllama, the in-page model runtime) | MIT | Xuan Son Nguyen |

**The in-page model runtime.** A page that carries the in-page model runtime carries it as `wllama.wasm`, the
WebAssembly module @wllama/wllama 3.8.1 publishes, unchanged (pinned in `third_party/wllama/3.8.1/`, with its sha256).
It is wllama's build of llama.cpp, build b11364-46ca246, and has these compiled into it, each under its own license:

- llama.cpp and ggml, with the parts of its server, mtmd and common code that wllama links (MIT, the ggml authors);
- nlohmann/json, which llama.cpp vendors (MIT, Niels Lohmann);
- stb_image, which llama.cpp vendors to decode images (MIT or public domain, Sean Barrett);
- miniaudio's audio decoders, which llama.cpp vendors (public domain or MIT No Attribution, David Reid);
- the SHA-256 code llama.cpp vendors (public domain, Igor Pavlov; its rotate-bits.h is MIT, William Casarin);
- Dawn's emdawnwebgpu, the WebGPU bindings (BSD-3-Clause, the Dawn & Tint Authors);
- the Emscripten runtime (MIT or the University of Illinois/NCSA license, the Emscripten authors);
- musl libc, as Emscripten bundles it (MIT, Rich Felker, et al.);
- LLVM libc++ and libc++abi, as Emscripten bundles them (Apache-2.0 WITH LLVM-exception, the LLVM project).

wllama's JavaScript also carries feature tests from wasm-feature-detect (Apache-2.0, Google Inc.). A page that carries
the runtime also carries the full text of each of these licenses at the end of `dist/index.html`, from
`third_party/wllama/3.8.1/NOTICE`.

**The model the web copy serves.** The page file, the bare Windows .exe and the OS media carry no model. The
published web copy of the page serves one model beside it, Qwen2.5 0.5B Instruct (the file
`Qwen2.5-0.5B-Instruct-Q4_K_M.gguf`), which the page downloads from its own site, by itself once the city is on
screen in a browser that can run it (not on mobile data or data saver, and not once the visitor has stopped it) or when
a visitor taps for it, and keeps in that visitor's browser. The model is the Qwen team's, Copyright 2024 Alibaba Cloud, licensed under the Apache
License 2.0; the file is a GGUF conversion of its weights quantized to Q4_K_M by bartowski, served unchanged. It
remains under its own licence, not under this product's licence: the full text of the Apache License 2.0 with that
copyright line, and a notice of where the file comes from, are served beside it as `models/LICENSE` and
`models/NOTICE`, from `third_party/qwen2.5-0.5b-instruct/`.

**The model the Windows installer carries.** The Windows app's installer and its .msi carry one model beside the app,
Qwen2.5 1.5B Instruct (the file `Qwen2.5-1.5B-Instruct-Q4_K_M.gguf`), which the app's page copies into its own storage
once the city is on screen, or when the person taps for it. The model is the Qwen team's, Copyright 2024 Alibaba Cloud,
licensed under the Apache License 2.0; the file is a GGUF conversion of its weights quantized to Q4_K_M by bartowski,
shipped unchanged. It remains under its own licence, not under this product's licence: the full text of the Apache
License 2.0 with that copyright line, and a notice of where the file comes from, are installed beside it as
`models/LICENSE` and `models/NOTICE` in the app's folder, from `third_party/qwen2.5-1.5b-instruct/`.

**The model the NixOS package carries.** The NixOS package (the flake's `nix run` and its NixOS module) carries the
same file: `tools/nix/model.nix` fetches it from Hugging Face at the pinned revision with Nix's fetchurl, which refuses
any other bytes, and keeps it in the Nix store beside the same `LICENSE` and `NOTICE` from
`third_party/qwen2.5-1.5b-instruct/`. The package's launcher serves that folder beside the page on this machine
(`127.0.0.1`) as `models/`, and the page copies the model into the browser profile's storage once the city is on screen,
or when the person taps for it. A configuration that sets `programs.crimson-noir-agent-city.model = false` builds the
package without it.

## Map data (the surveyed region)

Every build carries a region whose geometry is surveyed open data (walked with `?region=on`; the pilot build,
`npm run build:pilot`, opens on it): its buildings' footprints and heights, its streets' paths, classes, lanes and
directions of travel, and its shoreline. Every name in
it (the region, its streets and its water) is fictional, generated by the product. The data providers do not endorse
this product.

- Contains information licensed under the Open Government Licence – Ontario (Ontario Road Network; Ontario Hydro
  Network).
- Contains information licensed under the Open Government Licence – Canada (Statistics Canada, The Open Database of
  Buildings).
- The Open Database of Buildings includes information licensed under the Open Government Licence – Toronto.

## Third-party trademarks

Chrome, Android and Go (Google LLC), Edge, Windows, WebView2 and TypeScript (Microsoft Corporation), Brave (Brave
Software, Inc.), Safari, iPhone, iPad and Mac (Apple Inc.), PlayStation and DualSense (Sony Interactive
Entertainment Inc.), Bluetooth (Bluetooth SIG, Inc.), Rust (the Rust Foundation), Python (the Python
Software Foundation), Ollama (Ollama, Inc.), OpenAI (OpenAI and its affiliates), Qwen (Alibaba Cloud), Claude and
Anthropic (Anthropic, PBC), llama.cpp (its authors) and Tauri (the Tauri Programme within The Commons
Conservancy) are trademarks of their respective owners. The browsers, platforms, native shells and hardware are
named only to identify what the product runs on; the programming languages are named only as skills the city's
pedestrians have, so the operator can ask for them (`03_Spawn_Agents/skills.ts`); Ollama is named only to identify
the local model server API the operator's `ask` speaks, OpenAI only to identify the chat-completions wire format
it can speak instead (`ask api chat`), llama.cpp only to identify the local server that serves packaged models in
that format (`ask provider llamacpp`) and the engine compiled into the in-page model runtime (`ask provider inpage`),
Claude and Anthropic only to identify the network model API the operator can choose with a key of their own
(`ask provider claude`, `09_Cognition/claudeApi.ts`), and Qwen3-VL only as the model `ask` asks the local server for
unless the operator chooses another (`09_Cognition/localCompute.ts`), and Qwen2.5 only as the models the web copy
serves beside its page and the Windows installer and the NixOS package carry, for the in-page runtime
(`09_Cognition/siteModel.ts`). No model server ships with the product, and the page file, the bare Windows .exe and
the OS media carry no model: the operator's server, or a model file kept in their browser for the in-page runtime,
holds the model under the model's own licence. The two models the product offers are Qwen2.5 0.5B Instruct, which
the web copy serves beside its page and fetches by itself once the city is on screen, or when the visitor taps for it
(`third_party/qwen2.5-0.5b-instruct/`, served beside it as `models/LICENSE` and `models/NOTICE`), and Qwen2.5 1.5B
Instruct, which the Windows installer carries beside the app and the NixOS package's launcher serves beside its page
(`third_party/qwen2.5-1.5b-instruct/`, beside it as `models/LICENSE` and `models/NOTICE`); both Apache-2.0, Copyright 2024 Alibaba Cloud, the files quantized by
bartowski, each under its own licence. The network provider
answers only with the operator's own key, which stays in their browser. No speech engine, speech
model or voice ships either: the operator's `say` talks to a speech server the operator runs on the same machine
(`09_Cognition/localSpeech.ts`). This product is not affiliated with or endorsed by any of them.

## Operator notes

Not shipped: the build embeds only the text above this heading. Resolve every item before a public
release; each one is something the release engineering could not confirm.

### Operator must verify

1. **Copyright holder.** Resolved: the rights holder is Julian Cassius Subban, named in `LICENSE`, in the
   credit line above and in every source file's header (`tools/license/headers.mjs` checks them).
2. **Upstream attribution wording.** Section III(b)(i) of the ORC License asks for attribution "worded
   in any accurate and reasonable manner so requested by such parties". The Player Core credit line
   above was taken from secondary sources (the ORC notices published on pf2orc.d20pfsrd.com), not from
   the book. Check it against the ORC Notice printed in Pathfinder Player Core (Paizo, 2023) and use
   Paizo's requested wording exactly.
3. **Upstream scope.** The mechanics used are check resolution, proficiency ranks and fortune/
   misfortune (Player Core), and since the operator's progression (7 November 2026) attribute modifiers
   and boosts, skill increases, levels and XP, hero points and the three-action round (Player Core) and the
   level-based DCs, the easy adjustment and the treasure-by-level table (GM Core). The civic checks'
   DCs (`civic.ts`) are still original numbers. The GM Core credit line above was taken from the Archives of
   Nethys licence page (2e.aonprd.com/Licenses.aspx, read 7 November 2026), not from the book; check it
   against the ORC Notice printed in Pathfinder GM Core (Paizo, 2023), as item 2 asks for Player Core.
   Confirm no other ORC work was drawn on. If one was, add it to the attribution. The rest at home (November
   2026) uses the item-bonus ladder for skills (+1 from item level 3, +2 from 9, +3 from 17, highest of one
   type applies), which was not checked against either book: confirm which of the two prints it, and at those
   levels, before release.
4. **Licensing the code.** The ORC License grants no licence to software code (the ORC AxE, "Digital
   Applications of the ORC License"). `LICENSE` licenses the mechanics under ORC, keeps the core
   (`src/`, `crimson_noir_os/`, `native/`, `world/`, `brand/`) proprietary under
   `LICENSES/LicenseRef-CrimsonNoir-Proprietary.txt`, and opens the auxiliary tooling (`tools/`,
   `deploy/`, `.github/`, `docs/`) under MIT (`LICENSES/MIT.txt`). Have counsel review the
   combination. The same AxE section warns that assigning all rights in the code to a distributor, as
   some software publishers and stores require, would violate the ORC License: the product's new game
   mechanics must stay offered under it. Check any store or publishing agreement for such a clause.
5. **Notice placement.** The ORC Notice is on the Concierge card and embedded, with the full attribution,
   in `dist/index.html`. If the product is listed in a store or on a web page, repeat this notice in its
   credits or legal page ("in a reasonable manner based on the medium", Section III).
6. **Name clearance.** `BRAND.name` is Crimson Noir: Agent City (settled 2026-10-16). The notes below are
   preliminary web research on the earlier candidates, not a clearance search. Commission a full search (USPTO, CIPO, EUIPO; classes 9, 41 and 42) before
   filing or launching. When the name changes, update `src/brand.ts`, this file and `LICENSE`.
   `degrees.test.ts` fails if this file does not name the current `BRAND.name`.
7. **Logo clearance.** A city skyline in a dark rounded square is a common motif. Compare it with skyline
   and city-silhouette marks in games and software before registering. "Monolith" is only the internal
   component name, kept from the earlier triangle mark. Do not use it as a public name: MONOLITH is
   associated in games with Monolith Productions (Warner Bros. Games; the studio closed in 2025, but
   the mark may still be held) and Monolith Soft (Nintendo).
8. **"14A".** 14A is a Canadian provincial film classification, not a video-game rating (games in
   Canada carry ESRB ratings). Keep "14A" as an internal content guideline. Do not market the product
   as "14A-rated" unless it has been classified.
9. **Build-tool snippets.** The embedded third-party notices list every npm package whose modules are
   bundled, plus Tailwind CSS. Small runtime helpers that the build tools generate (Vite's
   module-preload polyfill, Rolldown's runtime helpers) are MIT-licensed and are not listed
   separately. Add Vite's and Rolldown's MIT notices if counsel wants them.
10. **Home-screen icon.** Only the SVG favicon is provided. iOS home-screen icons need a PNG
    `apple-touch-icon`. A PNG would have to be inlined as a data URI to keep the single-file build.
11. **Speech servers and voices.** `say` sends text to a speech server the operator installs and runs, over a
    loopback HTTP port. Nothing of any server is bundled or linked, so its licence does not reach this product's
    code. The server's own code, its model weights and each voice come under their own terms, which vary: some
    servers are GPL or AGPL, and some voices are non-commercial or require attribution. Check them before speech
    is used commercially, for example in a recording that is published. The same applies to `ask`'s model; the one
    model the product itself serves, on the web copy, is item 14.
12. **Personal data in the swarm's memory.** The memory keeps the operator's prompts, the start of each answer,
    and the text of everything said, in this browser's IndexedDB (`civic-simulation:swarm-memory`), on this
    machine only. Nothing is transmitted. `memory forget all` erases one city; clearing the site's data erases
    everything. If the product is deployed to other people's machines, say so in its privacy notice.

13. **The surveyed map (the pilot region and the whole-region build to come).** Geometry comes from open
    government data under the three Open Government Licences above; the names are generated. Before a public release:
    - **Attribution in the product.** The licences ask for the attribution statement to be included "in your product
      or application". It is in this notice (embedded in the page); add it to an in-app credits screen as well.
    - **No endorsement.** Nothing may suggest a government source endorses the product; keep official symbols and
      crests out.
    - **Landmarks and architecture.** Buildings are drawn as massing from their surveyed footprints, not as models of
      their architecture. A few are famous shapes (a civic square's curved towers, a domed stadium, the tallest
      towers). Have counsel decide which to vary, as fictional versions of real cities do, and whether reproducing
      public buildings' massing in a game is covered where the product is sold (in Canada, s. 32.2(1)(b) of the
      Copyright Act covers paintings, drawings, photographs and cinematographic works of architecture, and says
      nothing of games).
    - **The region's name.** "Harrowmere" is a placeholder, chosen only to pass the compiler's real-name check. Clear
      the final name like the brand.
    - **Copyright in the code.** Most of this codebase was written with an AI assistant under the operator's direction.
      Copyright protection for AI-assisted work is unsettled (the US Copyright Office's 2025 guidance protects only
      human-authored expression; Canada has no ruling). Ask counsel what records of human authorship to keep.

14. **The model the web copy serves.** The web copy on GitHub Pages serves Qwen2.5 0.5B Instruct beside its page
    (`src/09_Cognition/siteModel.ts` pins it; `third_party/qwen2.5-0.5b-instruct/` and `docs/ip-audit.md` section 1
    record it): the Qwen team's weights, Apache-2.0, Copyright 2024 Alibaba Cloud, as a Q4_K_M GGUF file quantized with
    an importance matrix by bartowski, fetched by the web workflow from Hugging Face at a pinned revision, checked
    against its size and SHA-256 and served unchanged, with the licence and a notice beside it. The weights are not in
    this repository, in `dist/index.html`, in the Windows app or in any release build. Before a public release:
    - **The licence text.** `third_party/qwen2.5-0.5b-instruct/LICENSE` is the Apache License 2.0 with Qwen's copyright
      line, rebuilt from the canonical text; it was not compared byte for byte with the LICENSE file in Qwen's own
      repository, because Hugging Face was not reachable from the container that wrote it. Compare it once.
    - **A third party's quantization.** The file served is bartowski's conversion of Qwen's weights (format and numeric
      precision changed), not Qwen's own file, and bartowski's repository names its licence as apache-2.0 without a
      licence file of its own. The NOTICE beside the model says so, as section 4(b) of the licence asks of a modified
      file. Confirm that this is enough, or serve Qwen's own GGUF file instead.
    - **Privacy and bandwidth.** The web copy downloads about 0.4 GB from its own site, by itself on a first visit from
      a browser that can run the model (not on mobile data or data saver, and not once the visitor has stopped it), or
      when a visitor taps for it, and nothing of the visitor's goes with the request. Say so in a privacy notice if the
      web copy gets one. GitHub Pages has a soft bandwidth limit of 100 GB a month, about 250 full downloads of the
      model, so about 250 new visitors a month from such browsers.
    - **The Windows installer's model.** The installer and the .msi carry Qwen2.5 1.5B Instruct
      (`third_party/qwen2.5-1.5b-instruct/`, pinned as `APP_MODEL` in the same file) the same way: bartowski's Q4_K_M
      file, fetched at a pinned revision, checked and shipped unchanged with the Apache License 2.0 and a notice
      installed beside it. The same two points apply to it: compare its LICENSE once with the one in
      `Qwen/Qwen2.5-1.5B-Instruct`, and confirm the NOTICE is enough for a third party's quantization. Every installer
      download is about 0.9 GB from GitHub's release storage.
    - **The NixOS package's model.** The same file again (`tools/nix/model.nix`, the same pin), fetched by each
      machine that builds the package straight from Hugging Face at the pinned revision (about 0.9 GB, once a machine),
      so the product does not redistribute it there; the Nix store keeps it beside the same LICENSE and NOTICE. The
      same two points apply. A binary cache that serves the built package would redistribute it: the file is its own
      store path, and the LICENSE and NOTICE sit in the package's model folder that links to it, so a cache serving
      the package's closure serves them together but could serve the file's path alone.

### Candidate names: trademark notes (AEGIS, ONYX, SENTIS)

The product's name was settled on 2026-10-16 as Crimson Noir: Agent City, and none of these names is shown in the
product any more; the notes are kept for counsel. Preliminary findings from web searches in September 2026. These
results were not checked against the USPTO, CIPO or EUIPO registers.

- **SENTIS: high risk.** Sentis is Unity Technologies' on-device neural-network inference package for
  games and apps (`com.unity.ai.inference`, displayed as "Sentis"). Unity filed UNITY SENTIS with the
  USPTO (serial 98079287, filed 2023-07-11) for class 9 software for computer games and interactive 3D
  worlds. This is the same market, for goods that would be sold side by side.
- **ONYX: medium to high risk (crowded field).** Onyx Path Publishing is a tabletop RPG publisher in the
  same hobby space as the ORC License. ONYX is Onyx Graphics' RIP software brand (class 9). ONYX was
  filed by Tsos Technologies (serial 98685416) for online gaming services. There are hobby game engines
  named Onyx, and "The Black Onyx" is a 1984 RPG. JPMorgan's former "Onyx" unit was renamed Kinexys in
  2024. A plain ONYX mark would be weak and hard to register or enforce for games. A compound mark
  would fare better.
- **AEGIS: medium to high risk, and off-brand.** AEGIS is Lockheed Martin's naval weapons system: a
  combat connotation that conflicts with the pacifist product. Games already use it: "AEGIS: Guardian
  of the Fleet" (1994), "Aegis" and "AEGIS 2186" on Steam, and the Aegis of the Immortal item in Dota 2.
  In software, Aegis Authenticator is a well-known open-source 2FA app.

Sources: docs.unity3d.com (Sentis manual and changelog), trademarks.justia.com (UNITY SENTIS 98079287),
uspto.report (ONYX 98685416), en.wikipedia.org (Onyx Path Publishing, The Black Onyx, Aegis Combat
System, AEGIS: Guardian of the Fleet, Monolith Productions), onyxgfx.com, store.steampowered.com,
getaegis.app, jpmorgan.com (Kinexys).
