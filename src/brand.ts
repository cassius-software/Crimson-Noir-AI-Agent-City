// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place the product is named. The HUD, boot splash, Concierge, Ring-0
 * terminal, page title and favicon all read from here, so a rename is a one-line change. The working
 * name is provisional until the operator clears a final mark.
 * What breaks if it is removed? Every surface that shows the product's name or version.
 */
export const BRAND = {
  /** Provisional working name (see README, "Brand"). */
  name: 'ONYX',
  tagline: 'An enterprise in the palm of your hands.',
  version: '1.0.0-stable-beta',
  /** Host name in the terminal prompt and `uname`. */
  host: 'onyx',
} as const

/**
 * The Monolith mark as markup, for places React does not render (favicon, index.html). MonolithLogo.tsx
 * renders the same paths as JSX.
 */
export const MONOLITH_SVG =
  '<svg width="120" height="120" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg">' +
  '<rect width="120" height="120" rx="28" fill="#000000"/>' +
  '<path fill-rule="evenodd" clip-rule="evenodd" d="M60 25L90 77H30L60 25ZM60 48L46 72H74L60 48Z" fill="#FFFFFF"/>' +
  '</svg>'
