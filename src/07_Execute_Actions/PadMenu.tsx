// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A player with only a pad had no way to the console, the HUD's switch, ghost view or the
 * text size: those were keys (~, H, G) and the touch Menu's items. This is the pad's own menu, opened by the pad's
 * menu button (Start; on a pad with no centre buttons, the left shoulder; one-handed, the shoulder held with Select:
 * gamepad.ts PAD_UI), holding the touch Menu's items (menuItems.ts, so the two never drift apart) and
 * two of its own: the on-screen keys, and Sloane's card. The d-pad or the stick moves the highlight, the south button
 * chooses, the east button or the menu button again closes it, as keysPad.ts reads a pad for either hand. While it is
 * open it has player 1's pads (the game stands still, and no card acts on its presses). An item the browser allows
 * only inside a person's own press (the model file's picker, a headset session) is not done from a pad's button,
 * which grants none: the menu says to press it again with a key, a click or a tap.
 * What breaks if it is removed? A pad player cannot open the console, hide the HUD, switch ghost view or reach the
 * on-screen keys without the select button.
 */
import { useEffect, useEffectEvent, useRef, useState, type JSX } from 'react'
import { KeysPad, padButtonsFor } from '../04_Connect_Hardware/keysPad.ts'
import { keysHost } from '../04_Connect_Hardware/keysHost.ts'
import type { MenuItem } from '../04_Connect_Hardware/menuItems.ts'
import { padFamilyOf } from '../04_Connect_Hardware/gamepad.ts'
import { borrowPads, pageHand, playerPads } from './padNav.ts'
import { padButtonName, type PadFamily } from './glyphs.ts'

/** The printed names of the buttons that do these controls for the player's hand, as the menu reads the pad (keysPad.ts). */
function names(family: PadFamily, controls: readonly ('press' | 'close' | 'enter')[]): string {
  const hand = pageHand()
  return [...new Set(controls.flatMap((c) => padButtonsFor(hand, c)).map((b) => padButtonName(family, b)))].join(' or ')
}

/** What a browser says of the press being handled (navigator.userActivation), where it says anything. */
function activeGesture(): boolean {
  const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  return ua === undefined ? true : ua.isActive
}

export function PadMenu({ open, items, onClose }: { open: boolean; items: readonly MenuItem[]; onClose: () => void }): JSX.Element | null {
  if (!open || items.length === 0) return null
  return <Panel items={items} onClose={onClose} />
}

function Panel({ items, onClose }: { items: readonly MenuItem[]; onClose: () => void }): JSX.Element {
  const [at, setAt] = useState(0)
  const [note, setNote] = useState<string | null>(null)
  const [family, setFamily] = useState<PadFamily>('generic')
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const n = items.length
  const here = Math.min(at, n - 1)

  const choose = (i: number): void => {
    const it = items[i]
    if (!it) return
    if (it.gesture && !activeGesture()) {
      setNote(`${it.label}: press it again with a key, a click or a tap. The browser allows it only inside a person's own press.`)
      return
    }
    it.run()
    if (!it.keep) onClose()
  }
  const ask = useEffectEvent((control: string) => {
    switch (control) {
      case 'up': case 'left': setAt((a) => (Math.min(a, n - 1) - 1 + n) % n); setNote(null); return
      case 'down': case 'right': setAt((a) => (Math.min(a, n - 1) + 1) % n); setNote(null); return
      case 'press': choose(here); return
      // The left shoulder too: a pad read by position with no centre buttons opens the menu with it (gamepad.ts PAD_UI).
      case 'close': case 'enter': case 'back': case 'caretLeft': onClose(); return
    }
  })

  // The pads, for as long as the menu is open: lent by the city, borrowed from every card, read here once a frame. The
  // focus it takes for its highlight goes back where it was when it closes (the field the player was typing in).
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    let lentTo = keysHost.get()
    lentTo?.lend('menu', true)
    const giveBack = borrowPads('menu')
    const pad = new KeysPad()
    let raf = 0
    const frame = (t: number): void => {
      raf = requestAnimationFrame(frame)
      const host = keysHost.get()
      if (host !== lentTo) { lentTo?.lend('menu', false); lentTo = host; lentTo?.lend('menu', true) }
      const { pads } = playerPads()
      const first = pads.find((p) => p !== null)
      if (first) setFamily(padFamilyOf(first.id))
      for (const a of pad.read(pads, t, pageHand())) ask(a.control)
    }
    raf = requestAnimationFrame(frame)
    return () => {
      cancelAnimationFrame(raf)
      lentTo?.lend('menu', false)
      giveBack()
      const now = document.activeElement
      const lost = now === null || now === document.body || !now.isConnected || (now instanceof Element && now.closest('[data-pad-menu]') !== null)
      if (before && before.isConnected && lost) before.focus({ preventScroll: true })
    }
  }, [])
  // The highlighted item has the focus, so a screen reader says it and the focus ring shows it.
  useEffect(() => { buttons.current[here]?.focus({ preventScroll: true }) }, [here])

  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 z-[10000] flex items-center justify-center p-4">
      <div aria-hidden className="pointer-events-auto absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        role="menu"
        aria-label="Menu"
        data-pad-menu=""
        className="pointer-events-auto relative flex max-h-full w-[min(20rem,100%)] flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-2xl border border-white/15 bg-black/70 p-2 text-white shadow-2xl backdrop-blur-md"
      >
        {items.map((it, i) => (
          <button
            key={it.id ?? it.label}
            ref={(el) => { buttons.current[i] = el }}
            type="button"
            role={it.on === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={it.on}
            data-at={i === here ? '' : undefined}
            onClick={() => { setAt(i); choose(i) }}
            className={`h-11 shrink-0 rounded-xl px-4 text-left text-[14px] font-semibold tracking-tight outline-none ${i === here ? 'ring-4 ring-[#ffd400]' : ''} ${it.on ? 'bg-white/80 text-slate-900' : 'hover:bg-white/10'}`}
          >
            {it.on === undefined ? it.label : `${it.label} · ${it.on ? 'On' : 'Off'}`}
          </button>
        ))}
        {note && <p role="status" className="px-3 py-2 text-[13px] leading-snug text-amber-200">{note}</p>}
        <p className="px-3 pt-1 pb-0.5 text-[12px] text-slate-300">
          <b className="text-white">{names(family, ['press'])}</b> choose · <b className="text-white">{names(family, ['close', 'enter'])}</b> close
        </p>
      </div>
    </div>
  )
}
