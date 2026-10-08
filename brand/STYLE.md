# Crimson Noir style guide

Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved. The marks, palette and trade dress here are Reserved
Material (NOTICE.md).

This is the design system of Crimson Noir OS and Agent City: the page (`src/`), the Crimson Terminal
(`crimson_noir_os`) and everything printed about them. The tokens live in `brand/tokens.json`; the page reads them
from `src/brand/tokens.css` (as custom properties and as Tailwind utilities); the terminal's constants in
`crimson_noir_os/crates/noir_core/src/term.rs` are the `terminal` group of the tokens, value for value. The marks
are in `brand/marks/`. `brand/preview.html` shows all of it in one page.

## Principles

1. **Minimal.** One accent, two materials, one face. A screen shows what the operator needs and nothing it does not.
2. **Industrial luxury.** Surfaces are Vantablack and anodized titanium: matte, flat, hairline-edged. No gradients,
   no glow, no frosted glass, no drop shadow but the mark's own.
3. **Precise geometry.** Everything sits on a 4pt grid; corners share the mark's family of radii; crimson is a line,
   a point or a triangle, never a wash.
4. **Quiet motion.** Two durations, one curve. Things reveal; they do not bounce.

## Palette

| Token | Value | Use |
|---|---|---|
| `black` | `#000000` | the boot veil, the terminal shell's page, the field behind the mark |
| `ink` | `#050507` | the base surface of every screen |
| `ink-2` | `#0a0a0e` | the Crimson Terminal's background; a sunk panel |
| `ink-3` | `#121216` | a raised panel on ink |
| `titanium-100` | `#e7e9ec` | display text |
| `titanium-200` | `#c8c8cc` | body text; the terminal's text |
| `titanium-400` | `#8c8c90` | secondary text, icons at rest, labels |
| `titanium-600` | `#5a5a60` | placeholder, disabled |
| `titanium-800` | `#2c2e36` | hairlines, dividers, the map's blocks |
| `crimson` | `#e8203a` | **the one accent**: a rule under a header, the live dot, an error line, a selected edge |
| `crimson-deep` | `#2a0710` | the terminal's header bar |
| `crimson-rule` | `#3a1018` | the hairline above the terminal's input |
| `crimson-tint` | `#ffd0d6` | a title on crimson-deep |
| `crimson-muted` | `#d0b0b6` | a status on crimson-deep |
| `amber` | `#d89a2a` | caution only |
| `white` | `#ffffff` | an echoed command; the Monolith's triangle |

Rules: crimson covers at most a line, a dot or the inner triangle of the mark; a screen never has two crimson
surfaces. Text is titanium on ink; never ink on titanium except in print. Contrast: `titanium-200` on `ink` is
13.9:1, `titanium-400` on `ink` is 6.1:1, `crimson` on `ink` is 4.6:1 (text at 15px and above only; prefer it for
lines and dots).

## Typography

The system face, always: the page's content security policy admits no font host, and the system face is the
Apple-grade one on every platform (SF on Apple, Segoe UI Variable on Windows, Roboto on Android). No web font.

| Style | Spec | Use |
|---|---|---|
| display | 600 34/40, tracking −0.02em | a title card, the product name |
| title | 600 22/28, −0.01em | a panel's title |
| headline | 600 17/22 | a section heading |
| body | 400 15/20 | prose, the concierge |
| caption | 400 13/18 | hints, secondary lines |
| label | 500 11/14, +0.08em, uppercase | a label over a value, the terminal header |
| mono | 400 13/20 `ui-monospace` | the terminal, codes, digests, numbers that align |

Numbers are tabular (`font-variant-numeric: tabular-nums`) wherever they change in place.

## Grid, radii, lines

- Spacing is the 4pt grid: 4, 8, 12, 16, 24, 32, 48, 64. A panel's padding is 16; its gap is 8; a row is 12.
- Radii are the mark's family: 4 (a hairline chip), 8 (a control), 14 (a panel), 28 (the mark at 120; 23.333%).
- Lines are 1px hairlines in `titanium-800`; a focus ring is 2px `crimson`, offset 2px.

## Motion

- `fast` 250ms for state (hover, press, a toggle); `reveal` 1200ms for an entrance (the boot veil).
- One curve: `cubic-bezier(0.4, 0, 0.2, 1)`. `prefers-reduced-motion` collapses every reveal to `fast`.

## Marks

- **The mark** (`brand/marks/crimson-noir-mark.svg`): an ink rounded square (rx 28 of 120) with a titanium hairline
  ring, the open triangle of the Monolith in `titanium-200`, its inner triangle filled `crimson`. The Monolith
  (`src/MonolithLogo.tsx`: black field, white open triangle) is the same geometry one step quieter; the favicon and
  the boot veil keep it until the operator clears the final mark.
- **One colour** (`crimson-noir-mark-mono.svg`): the field takes `currentColor`, the triangle is white. For print,
  embossing and anywhere crimson cannot be reproduced.
- **The wordmark** (`crimson-noir-wordmark.svg`): the mark, CRIMSON NOIR in display weight, a crimson rule, a label
  line. 520 × 120.
- **The terminal glyph** (`crimson-terminal-glyph.svg`): the Crimson Terminal's own icon, its header bar and rule
  in miniature with a prompt chevron and a crimson cursor.
- Clear space is the inner triangle's height (24 of 120) on every side. Minimum size 24px. Never recolour the
  triangle, rotate the mark, add a shadow beyond `drop-shadow(0 10px 15px rgba(0,0,0,.2))`, or set it on anything
  but ink, black or white.

## Structure

### The page (Agent City)

- **The boot veil**: `black`, the mark centred at `clamp(80px, 14vmin, 120px)`, nothing else; it fades over
  `reveal` into the city.
- **The HUD**: panels (`.noir-panel`: `ink-3`, titanium hairline, radius 14) pinned to the edges on the 4pt grid,
  never touching; a label over each value; the live indicator is the one crimson dot. The header carries the mark
  at 24px, the product name in headline, and a hairline.
- **The Concierge card**: title, body, caption; one primary `.noir-button`; the ORC Notice as caption in
  `titanium-400`.
- **The console on the page** (`?boot=tty`): the terminal frame below, full-bleed on `black`.
- Dark is the only theme. Light surfaces exist in print alone.

### The Crimson Terminal (the OS, and the page's terminal frame)

Top to bottom, as `term.rs` draws it at scale 1 and `.noir-term` reproduces it:

1. **Header bar**, 12px, `crimson-deep`: the name CRIMSON TERMINAL at the left in `crimson-tint` (label style),
   the status (`tick`, `alive`, RUNNING/stopped, the lock's digest) at the right in `crimson-muted`.
2. **Rule**, 1px `crimson`, the full width.
3. **Scrollback**, rows of 10px on `ink-2`: text in `titanium-200`, an echoed command (`>`) in `white`, an error
   (`?`) in `crimson`. The map, when shown, is `map-bg` with `map-block` blocks and role dots `role-0..2`.
4. **Input rule**, 1px `crimson-rule`, then the **input line** in `white` with a blinking block cursor.

Nothing else: no borders, no icons, no second colour.

## In code

- Page: `bg-noir-ink`, `text-noir-titanium-200`, `border-noir-titanium-800`, `border-noir-crimson`,
  `font-noir-mono`, `rounded-noir-panel`, or the custom properties `var(--noir-*)`. The structural classes
  `.noir-panel`, `.noir-rule`, `.noir-label`, `.noir-button`, `.noir-term*` are in `src/brand/tokens.css`.
- OS: the constants at the top of `term.rs`'s `render` are the `terminal` tokens; change them there and in
  `tokens.json` together.
- A new colour is a new token with a role, added to `tokens.json` and `tokens.css` in the same change, or it is
  not added.
