// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's one view of the desktop shell (src-tauri): whether the page runs inside
 * the Tauri window rather than a browser tab, the handle to that window's controls, and the shell's reading of the
 * GPUs' memory (src-tauri/src/gpu.rs `gpu_memory`), which a page cannot read. Tauri injects its API at
 * `window.__TAURI__` (tauri.conf.json `withGlobalTauri`), so the page bundles nothing for it and the browser build is
 * byte for byte what it was. Everything here is typed to the few calls the title bar makes, and the capabilities file
 * (src-tauri/capabilities/default.json) admits exactly those; the app's own commands are allowed by Tauri's default.
 * What breaks if it is removed? The title bar cannot tell a window from a tab, and has nothing to drive; the Windows
 * app gives auto no GPU figure.
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

/** How long the page waits for the shell's GPU reading, ms: DXGI answers in milliseconds; past this, there is none. */
export const GPU_READ_MS = 2000

/**
 * The shell's reading of the GPUs' memory: each hardware adapter's dedicated bytes, in DXGI's order (src-tauri/src/
 * gpu.rs). Null in a browser, in a shell without the command, and when the answer is not a list of numbers or does not
 * come within `waitMs`; it never throws. The page judges the list (modelFit.ts figureFromAdapters).
 */
export async function shellGpuMemory(g: object = globalThis, waitMs = GPU_READ_MS): Promise<number[] | null> {
  const api = (g as Record<string, unknown>)[SHELL_GLOBAL]
  const core = typeof api === 'object' && api !== null ? (api as { core?: { invoke?: unknown } }).core : undefined
  if (typeof core !== 'object' || core === null || typeof core.invoke !== 'function') return null
  const invoke = core.invoke as (command: string) => Promise<unknown>
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs) })
  try {
    const answer = await Promise.race([Promise.resolve().then(() => invoke.call(core, 'gpu_memory')), late])
    return Array.isArray(answer) && answer.every((b) => typeof b === 'number') ? answer : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}
