// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the desktop app's title bar. The Tauri window has no decorations of its own
 * (src-tauri/tauri.conf.json), so the page draws one: a frosted glass strip in the brand's tokens (the mark, the
 * product name as a label, and the three window controls), draggable through Tauri's `data-tauri-drag-region`, with
 * minimise, maximise and close through the window API the capabilities file admits. It mounts only inside the Tauri
 * window (desktopShell.ts): a browser tab renders nothing and lays out as before. While mounted it marks the document
 * (`data-shell="tauri"`) so index.css lets the root start under the bar and keeps the strip itself transparent for the
 * window's Mica.
 * What breaks if it is removed? The desktop window has no way to be moved, minimised or closed but the keyboard.
 */
import { useEffect, useState } from 'react'
import { BRAND } from '../brand.ts'
import { MonolithLogo } from '../MonolithLogo.tsx'
import { desktopShell, SHELL_ATTRIBUTE, type ShellWindow } from './desktopShell.ts'

/** The bar's height; index.css's --noir-titlebar is the same value. */
export const TITLE_BAR_HEIGHT = 38

const control =
  'inline-flex h-full w-[46px] items-center justify-center text-noir-titanium-400 transition-colors ' +
  'duration-[250ms] hover:bg-white/[0.06] hover:text-noir-titanium-100 focus-visible:outline-2 focus-visible:outline-noir-crimson focus-visible:-outline-offset-2'

/** Minimise, maximise, restore and close as 10px strokes, the way Windows 11 draws them, in the current colour. */
function Glyph({ kind }: { kind: 'minimize' | 'maximize' | 'restore' | 'close' }) {
  const props = { width: 10, height: 10, viewBox: '0 0 10 10', fill: 'none', stroke: 'currentColor', strokeWidth: 1, 'aria-hidden': true as const }
  switch (kind) {
    case 'minimize':
      return <svg {...props}><path d="M0 5.5h10" /></svg>
    case 'maximize':
      return <svg {...props}><rect x="0.5" y="0.5" width="9" height="9" /></svg>
    case 'restore':
      return <svg {...props}><path d="M2.5 2.5V0.5h7v7h-2" /><rect x="0.5" y="2.5" width="7" height="7" /></svg>
    case 'close':
      return <svg {...props}><path d="M0.5 0.5l9 9M9.5 0.5l-9 9" /></svg>
  }
}

/** The bar over a Tauri window; null in a browser. */
export function TitleBar() {
  const [win] = useState<ShellWindow | null>(() => desktopShell()?.window.getCurrentWindow() ?? null)
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    if (!win) return
    const root = document.documentElement
    root.dataset.shell = SHELL_ATTRIBUTE
    root.style.setProperty('--noir-titlebar', `${TITLE_BAR_HEIGHT}px`)
    let stop: (() => void) | null = null
    let gone = false
    const read = () => { win.isMaximized().then((m) => { if (!gone) setMaximized(m) }).catch(() => {}) }
    read()
    win.onResized(read).then((off) => { if (gone) off(); else stop = off }).catch(() => {})
    return () => {
      gone = true
      stop?.()
      delete root.dataset.shell
      root.style.removeProperty('--noir-titlebar')
    }
  }, [win])

  if (!win) return null
  const call = (f: () => Promise<void>) => () => { f().catch(() => {}) }
  return (
    <header
      data-tauri-drag-region
      className="noir-titlebar fixed inset-x-0 top-0 z-[20000] flex items-center justify-between select-none"
      style={{ height: TITLE_BAR_HEIGHT }}
    >
      <div data-tauri-drag-region className="flex h-full items-center gap-3 pl-3">
        <span className="pointer-events-none flex"><MonolithLogo size={16} title="" /></span>
        <span data-tauri-drag-region className="noir-label text-noir-titanium-200">{BRAND.short}</span>
        <span data-tauri-drag-region className="noir-label hidden sm:inline">Agent City</span>
      </div>
      <div className="flex h-full items-stretch">
        <button type="button" className={control} onClick={call(() => win.minimize())} aria-label="Minimise"><Glyph kind="minimize" /></button>
        <button type="button" className={control} onClick={call(() => win.toggleMaximize())} aria-label={maximized ? 'Restore' : 'Maximise'}>
          <Glyph kind={maximized ? 'restore' : 'maximize'} />
        </button>
        <button type="button" className={`${control} hover:bg-noir-crimson hover:text-white`} onClick={call(() => win.close())} aria-label="Close"><Glyph kind="close" /></button>
      </div>
    </header>
  )
}
