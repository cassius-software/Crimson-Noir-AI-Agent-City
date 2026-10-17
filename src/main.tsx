// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's entry point: before the page does anything it holds the global's outbound
 * primitives to this machine (02_Define_The_Rules/airgap.ts installAirgap), then mounts App under React's StrictMode,
 * tells index.html's boot watchdog that the page's script ran (window.__bootDone), and hands the watchdog any error
 * React could not catch, which would otherwise unmount the whole page to a blank screen (window.__bootFatal draws the
 * card with Restart and Open the console without React).
 * What breaks if it is removed? The page never starts, and nothing would hold its outbound requests to this machine
 * before the first one.
 */
import { installAirgap } from './02_Define_The_Rules/airgap.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BRAND } from './brand.ts'
import './index.css'
import App from './App.tsx'
import { TitleBar } from './07_Execute_Actions/TitleBar.tsx'

// Before anything else the page does: the global's outbound primitives are held to this machine and frozen
// (02_Define_The_Rules/airgap.ts). The imports above evaluate first, and none of them addresses anything at load
// (10_Network/airgap.test.ts pins every call site in the product); the physics worker installs its own.
installAirgap(globalThis)

createRoot(document.getElementById('root')!, {
  // An error no boundary caught leaves React nothing to draw: the watchdog's card (index.html) says so and offers
  // Restart, and the console, which may still run where the city cannot.
  onUncaughtError(error) {
    console.error(error)
    const tty = new URLSearchParams(window.location.search).get('boot') === 'tty'
    window.__bootFatal?.(
      tty ? `The ${BRAND.name} console stopped` : `${BRAND.name} stopped`,
      ['Something on the page failed, and it can no longer draw.', 'Restart to start again.'],
      error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      !tty,
    )
  },
}).render(
  <StrictMode>
    <TitleBar />
    <App />
  </StrictMode>,
)
// The boot watchdog (index.html) stands down: from here a failure has the page's own cards.
window.__bootDone = true

declare global {
  interface Window {
    /** index.html's boot watchdog: draws its card (title, lines, the raw detail, whether to offer the console) once. */
    __bootFatal?: (title: string, lines: readonly string[], detail: string, withConsole: boolean) => void
    /** Set once this module has run: the watchdog then leaves the page alone. */
    __bootDone?: boolean
  }
}
