// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the product's brand mark (the skyline: an ink square, the city's towers and
 * spire, one crimson street line) as a React component, used in the HUD header, the boot veil, the title bar
 * and the onboarding card. The shapes are identical to MONOLITH_SVG in brand.ts, which the favicon and the boot
 * splash use, so every surface shows the same mark; only the rendered size varies. The file keeps the name of the
 * earlier Monolith mark so the components that import it need no change.
 * What breaks if it is removed? The HUD header and the title card lose the logo (the build fails).
 */
import { useId } from 'react'
import { BRAND, MARK_SKYLINE } from './brand.ts'

/** `title` is the accessible name (default: the product name). Pass '' where adjacent text already
 *  names the product: the mark is then decorative and hidden from assistive technology. */
export function MonolithLogo({ size = 120, title }: { size?: number; title?: string }) {
  const titleId = useId()
  const label = title ?? BRAND.name
  const a11y = label
    ? { role: 'img', 'aria-labelledby': titleId }
    : { 'aria-hidden': true, focusable: false }
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" style={{ filter: 'drop-shadow(0px 10px 15px rgba(0, 0, 0, 0.2))' }} {...a11y}>
      {label && <title id={titleId}>{label}</title>}
      <rect width="120" height="120" rx="28" fill="#050507" />
      <rect x="0.5" y="0.5" width="119" height="119" rx="27.5" stroke="#2c2e36" />
      <path d={MARK_SKYLINE} fill="#c8c8cc" />
      <rect x="24" y="88" width="72" height="4" fill="#e8203a" />
    </svg>
  )
}
