// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place the product is named. The HUD, boot splash, Concierge, Ring-0
 * terminal, page title, favicon, recordings and HAL handshake all read from here, so a rename is a one-line change.
 * What breaks if it is removed? Every surface that shows the product's name or version.
 */
export const BRAND = {
  /** The product's name (Julian, 2026-10-16: "it will definitely still be called crimson noir: agent city"). */
  name: 'Crimson Noir: Agent City',
  /** The name where the full one does not fit: the phone HUD, the home-screen label, the HAL handshake. */
  short: 'Crimson Noir',
  tagline: 'An enterprise in the palm of your hands.',
  version: '1.0.0-stable-beta',
  /** Host name in the terminal prompt and `uname`, and the start of a recording's file name. */
  host: 'crimson-noir',
} as const

/** The mark's skyline (the cover art's towers and its spire) in the 120 x 120 frame, shared with MonolithLogo.tsx. */
export const MARK_SKYLINE = 'M24 84V64H38V84ZM40 84V48H43V43H49V48H52V84ZM54 84V32H57V26H59V13H61V26H63V32H66V84ZM68 84V42H80V84ZM82 84V60H96V84Z'

/**
 * The mark as markup, for places React does not render (favicon, index.html): an ink rounded square with a titanium
 * hairline, the skyline in titanium and one crimson street line under it (brand/STYLE.md, "Marks"). MonolithLogo.tsx
 * renders the same shapes as JSX; both keep the name of the earlier Monolith mark so other code's imports still hold.
 */
export const MONOLITH_SVG =
  '<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="120" height="120" rx="28" fill="#050507"/>' +
  '<rect x="0.5" y="0.5" width="119" height="119" rx="27.5" stroke="#2c2e36"/>' +
  `<path d="${MARK_SKYLINE}" fill="#c8c8cc"/>` +
  '<rect x="24" y="88" width="72" height="4" fill="#e8203a"/>' +
  '</svg>'
