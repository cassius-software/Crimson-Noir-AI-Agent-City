// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's entry point: before the page does anything it holds the global's outbound
 * primitives to this machine (02_Define_The_Rules/airgap.ts installAirgap), then mounts App under React's StrictMode.
 * What breaks if it is removed? The page never starts, and nothing would hold its outbound requests to this machine
 * before the first one.
 */
import { installAirgap } from './02_Define_The_Rules/airgap.ts'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// Before anything else the page does: the global's outbound primitives are held to this machine and frozen
// (02_Define_The_Rules/airgap.ts). The imports above evaluate first, and none of them addresses anything at load
// (10_Network/airgap.test.ts pins every call site in the product); the physics worker installs its own.
installAirgap(globalThis)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
