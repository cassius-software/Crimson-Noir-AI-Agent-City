// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's one view of the desktop shell (src-tauri): whether the page runs inside
 * the Tauri window rather than a browser tab, and the handle to that window's controls. Tauri injects its API at
 * `window.__TAURI__` (tauri.conf.json `withGlobalTauri`), so the page bundles nothing for it and the browser build is
 * byte for byte what it was. Everything here is typed to the few calls the title bar makes, and the capabilities file
 * (src-tauri/capabilities/default.json) admits exactly those.
 * What breaks if it is removed? The title bar cannot tell a window from a tab, and has nothing to drive.
 */

/** The window commands the title bar uses, as Tauri's `getCurrentWindow()` exposes them. */
export interface ShellWindow {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** Resolves to the function that stops listening. */
  onResized(handler: () => void): Promise<() => void>
}

/** The part of Tauri's injected global the page reads. */
export interface ShellGlobal {
  window: { getCurrentWindow(): ShellWindow }
}

/** Where Tauri puts its API when `withGlobalTauri` is on. */
export const SHELL_GLOBAL = '__TAURI__'

/** The Tauri window around this page, or null in a browser (or any global without the API). */
export function desktopShell(g: object = globalThis): ShellGlobal | null {
  const api = (g as Record<string, unknown>)[SHELL_GLOBAL]
  if (typeof api !== 'object' || api === null) return null
  const win = (api as { window?: unknown }).window
  if (typeof win !== 'object' || win === null || typeof (win as { getCurrentWindow?: unknown }).getCurrentWindow !== 'function') return null
  return api as ShellGlobal
}

/** The attribute the page's data-shell carries while the title bar is mounted; index.css lays the root out under it. */
export const SHELL_ATTRIBUTE = 'tauri'
