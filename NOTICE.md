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

If you use our Licensed Material in your own published works, please credit us as follows:

- ONYX © 2026 the ONYX authors.

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
- **The 5-Whys intent engine** (`intent.ts`): the question-selection tables and the plan mapping are
  this product's own mechanics. The "5 Whys" questioning technique itself is a long-established, public
  root-cause method and is not claimed.

## Reserved Material

Reserved Material elements in this product include, but may not be limited to: the product name
ONYX (the provisional working name set in `src/brand.ts`) and the terminal host name derived from it;
the product logo, a black rounded square with an open white triangle (`MonolithLogo`,
`MONOLITH_SVG`), at every size and as the favicon; the product's trade dress, namely the frosted-glass
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

## Map data (the pilot region build)

The pilot build (`npm run build:pilot`) carries a region whose geometry is surveyed open data: its buildings'
footprints and heights, its streets' paths, classes, lanes and directions of travel, and its shoreline. Every name in
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
Software Foundation), Ollama (Ollama, Inc.), OpenAI (OpenAI and its affiliates), Qwen (Alibaba Cloud) and Tauri (the Tauri Programme within The Commons
Conservancy) are trademarks of their respective owners. The browsers, platforms, native shells and hardware are
named only to identify what the product runs on; the programming languages are named only as skills the city's
pedestrians have, so the operator can ask for them (`03_Spawn_Agents/skills.ts`); Ollama is named only to identify
the local model server API the operator's `ask` speaks, and OpenAI only to identify the chat-completions wire format
it can speak instead (`ask api chat`), and Qwen3-VL only as the model `ask` asks that server for
unless the operator chooses another (`09_Cognition/localCompute.ts`). No model and no model server ships with the
product: the operator's server holds the model under the model's own licence. No speech engine, speech model or
voice ships either: the operator's `say` talks to a speech server the operator runs on the same machine
(`09_Cognition/localSpeech.ts`). This product is not affiliated with or endorsed by any of them.

## Operator notes

Not shipped: the build embeds only the text above this heading. Resolve every item before a public
release; each one is something the release engineering could not confirm.

### Operator must verify

1. **Copyright holder.** "the ONYX authors" stands in for the legal name of the rights holder (person
   or company) in `LICENSE` and in the credit line above. Replace it with the real legal name.
2. **Upstream attribution wording.** Section III(b)(i) of the ORC License asks for attribution "worded
   in any accurate and reasonable manner so requested by such parties". The Player Core credit line
   above was taken from secondary sources (the ORC notices published on pf2orc.d20pfsrd.com), not from
   the book. Check it against the ORC Notice printed in Pathfinder Player Core (Paizo, 2023) and use
   Paizo's requested wording exactly.
3. **Upstream scope.** The mechanics used are check resolution, proficiency ranks and fortune/
   misfortune. Nothing from GM Core (for example, DC-by-level tables) is used: every DC here is an
   original number. Confirm no other ORC work was drawn on. If one was, add it to the attribution.
4. **Licensing the code.** The ORC License grants no licence to software code (the ORC AxE, "Digital
   Applications of the ORC License"). As written, `LICENSE` licenses the mechanics under ORC and
   reserves all other rights in the code. If the code is meant to be open source, add a software
   licence for it, for example MIT or Apache-2.0, alongside the ORC notice. Have counsel review the
   combination. The same AxE section warns that assigning all rights in the code to a distributor, as
   some software publishers and stores require, would violate the ORC License: the product's new game
   mechanics must stay offered under it. Check any store or publishing agreement for such a clause.
5. **Notice placement.** The ORC Notice is on the Concierge card and embedded, with the full attribution,
   in `dist/index.html`. If the product is listed in a store or on a web page, repeat this notice in its
   credits or legal page ("in a reasonable manner based on the medium", Section III).
6. **Name clearance.** `BRAND.name` is provisional. The notes below are preliminary web research,
   not a clearance search. Commission a full search (USPTO, CIPO, EUIPO; classes 9, 41 and 42) before
   filing or launching. When the name changes, update `src/brand.ts`, this file and `LICENSE`.
   `degrees.test.ts` fails if this file does not name the current `BRAND.name`.
7. **Logo clearance.** A triangle in a dark rounded square is a simple geometric mark. Compare it with
   triangle marks in software and developer tools (for example Vercel's triangle) before registering.
   "Monolith" is only the internal component name. Do not use it as a public name: MONOLITH is
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
    is used commercially, for example in a recording that is published. The same applies to `ask`'s model.
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

### Candidate names: trademark notes (AEGIS, ONYX, SENTIS)

Preliminary findings from web searches in September 2026. These results were not checked against
the USPTO, CIPO or EUIPO registers.

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
