// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the touch Supplier for phones and tablets: a frosted-glass, thumb-sized
 * overlay with a floating virtual stick on the left (walk, or steer + throttle), drag on the right half to
 * turn the first-person head (yaw and pitch), and context buttons — Enter/Exit car when relevant, Run on
 * foot, Brake, Handbrake and Reset while driving, and Ping (a mark where the head looks) in both modes. A Menu
 * button on the right edge opens what a keyboard reaches with one key and a phone has no key for: the Ring-0 console
 * (and through it `ask`, the agents and every setting), the clock an hour back or on, ghost view, rain mode, and
 * hiding the HUD. Only its own controls take pointer events, so the rest of the HUD stays click-through.
 * What breaks if it is removed? Touch devices can neither move, look nor drive.
 *
 * Every control acts on pointer events, never on `click`: browsers synthesize a click only for a lone tap, so a
 * button pressed while the other thumb holds the stick would never fire.
 */
import { useEffect, useReducer, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import type { Input, TouchButton } from './input.ts'

const STICK = { zone: 184, base: 116, knob: 52, travel: 42, deadPx: 5 } as const

const GLASS = 'border border-white/30 bg-slate-900/35 text-white shadow-[0_8px_28px_rgba(15,23,42,0.35)] backdrop-blur-xl backdrop-saturate-150'
const GLASS_ON = 'border border-white/80 bg-white/80 text-slate-900 shadow-[0_8px_28px_rgba(15,23,42,0.35)] backdrop-blur-xl backdrop-saturate-150'
const CONTROL = 'pointer-events-auto touch-none select-none'
const INSET = 16

const ROOT_STYLE: CSSProperties = { WebkitTouchCallout: 'none', WebkitUserSelect: 'none' }

/** Keeps a drag or a held button tracking the finger after it leaves the element (throws if already lifted). */
function capture(e: PointerEvent<HTMLElement>): void {
  try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* pointer already gone */ }
}

/**
 * A drag this element still owns. One whose capture was never taken or silently lost (its pointerup went
 * elsewhere) would otherwise block the control forever; such a stale drag may be taken over by a new finger.
 */
function owns(e: PointerEvent<HTMLElement>, id: number): boolean {
  try { return e.currentTarget.hasPointerCapture(id) } catch { return false }
}

const noMenu = (e: MouseEvent) => e.preventDefault()

/** What the menu reaches outside the input layer: the host owns the console and the HUD. */
export interface TouchMenuHost {
  /** Opens the Ring-0 console; called from the tap's click handler, so iOS raises the keyboard (TerminalHandle.open). */
  onConsole(): void
  /** Shows or hides the HUD (the H key). */
  onHud(): void
  hudVisible: boolean
  /** Ghost view and rain mode as the last snapshot reported them, so their items read On or Off. */
  ghost: boolean
  rain: boolean
}

interface Props { input: Input; driving: boolean; nearVehicle: boolean; menu?: TouchMenuHost }

export function TouchControls({ input, driving, nearVehicle, menu }: Props) {
  if (!input.touch) return null
  return <TouchLayer input={input} driving={driving} nearVehicle={nearVehicle} menu={menu} />
}

function TouchLayer({ input, driving, nearVehicle, menu }: Props) {
  const [, rerender] = useReducer((n: number) => n + 1, 0)
  // Bumped when the window loses focus or the page is hidden: the controls remount, dropping every drag and hold.
  const [epoch, reset] = useReducer((n: number) => n + 1, 0)

  // Buttons that unmount mid-press never see their pointerup: release what this mode was holding.
  useEffect(() => () => {
    input.setTouchButton('brake', false)
    input.setTouchButton('handbrake', false)
  }, [input, driving])
  useEffect(() => () => input.setTouchStick(0, 0), [input])

  // Pointer-ups and cancels are not guaranteed when focus or the page goes away mid-press.
  useEffect(() => {
    const release = () => {
      input.setTouchStick(0, 0)
      input.setTouchButton('brake', false)
      input.setTouchButton('handbrake', false)
      reset()
    }
    const onVisibility = () => { if (document.visibilityState === 'hidden') release() }
    window.addEventListener('blur', release)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('blur', release)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [input])

  const run = input.touchHeld('run')
  const press = (fn: () => void) => () => { input.engageTouch(); fn() }

  return (
    <>
      <div className="pointer-events-none absolute inset-0 z-10 select-none" style={ROOT_STYLE}>
        <LookZone key={`look-${epoch}`} input={input} />
        <Stick key={`stick-${epoch}`} input={input} />
        <div
          key={`buttons-${epoch}`}
          className="pointer-events-none absolute flex flex-col items-end gap-3"
          style={{ right: `calc(env(safe-area-inset-right, 0px) + ${INSET}px)`, bottom: `calc(env(safe-area-inset-bottom, 0px) + ${INSET}px)` }}
        >
          {driving ? (
            <>
              <div className="flex gap-3">
                <TapButton label="Ping" onTap={press(() => input.press('ping'))} />
                <TapButton label="Reset" onTap={press(() => input.press('reset'))} />
                <TapButton label="Exit car" onTap={press(() => input.press('interact'))} />
              </div>
              <div className="flex items-end gap-3">
                <HoldButton label="Handbrake" size={72} button="handbrake" input={input} />
                <HoldButton label="Brake" size={84} button="brake" input={input} />
              </div>
            </>
          ) : (
            <>
              {nearVehicle && <TapButton label="Enter car" onTap={press(() => input.press('interact'))} />}
              <div className="flex items-end gap-3">
                <TapButton label="Ping" round onTap={press(() => input.press('ping'))} />
                <TapButton
                  label="Run"
                  pressed={run}
                  round
                  onTap={() => { input.setTouchButton('run', !input.touchHeld('run')); rerender() }}
                />
              </div>
            </>
          )}
        </div>
      </div>
      {menu && <Menu key={`menu-${epoch}`} input={input} host={menu} />}
    </>
  )
}

/**
 * Right half: drag to turn the head — the view follows the finger like a mouse (right turns right, up looks
 * up) at Input's first-person touch sensitivity. One finger at a time; the others belong to the stick and
 * buttons.
 */
function LookZone({ input }: { input: Input }) {
  const look = useRef<{ id: number; x: number; y: number } | null>(null)
  const end = (e: PointerEvent<HTMLDivElement>) => { if (look.current?.id === e.pointerId) look.current = null }
  return (
    <div
      aria-hidden
      className={`${CONTROL} absolute top-0 right-0 bottom-0 w-1/2`}
      onPointerDown={(e) => {
        if (look.current && owns(e, look.current.id)) return
        capture(e)
        look.current = { id: e.pointerId, x: e.clientX, y: e.clientY }
        input.engageTouch()
      }}
      onPointerMove={(e) => {
        const l = look.current
        if (!l || l.id !== e.pointerId) return
        input.touchLook(e.clientX - l.x, e.clientY - l.y)
        l.x = e.clientX
        l.y = e.clientY
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onContextMenu={noMenu}
    />
  )
}

/** Floating stick: the base jumps to where the thumb lands inside its zone, the knob follows within `travel`. */
function Stick({ input }: { input: Input }) {
  const zone = useRef<HTMLDivElement>(null)
  const base = useRef<HTMLDivElement>(null)
  const knob = useRef<HTMLDivElement>(null)
  const drag = useRef<{ id: number; cx: number; cy: number; bx: number; by: number } | null>(null)

  const place = (bx: number, by: number, kx: number, ky: number) => {
    if (base.current) base.current.style.transform = `translate(${bx}px, ${by}px)`
    if (knob.current) knob.current.style.transform = `translate(${bx + kx}px, ${by + ky}px)`
  }
  const move = (x: number, y: number) => {
    const d = drag.current
    if (!d) return
    const dx = x - d.cx, dy = y - d.cy
    const len = Math.hypot(dx, dy)
    const k = len > STICK.travel ? STICK.travel / len : 1
    place(d.bx, d.by, dx * k, dy * k)
    const mag = len <= STICK.deadPx ? 0 : Math.min(1, (len - STICK.deadPx) / (STICK.travel - STICK.deadPx))
    input.setTouchStick(len > 0 ? (dx / len) * mag : 0, len > 0 ? (-dy / len) * mag : 0)
  }
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.id !== e.pointerId) return
    drag.current = null
    place(0, 0, 0, 0)
    input.setTouchStick(0, 0)
  }
  const half = STICK.zone / 2, r = STICK.base / 2

  return (
    <div
      ref={zone}
      aria-hidden
      className={`${CONTROL} absolute`}
      style={{
        left: `calc(env(safe-area-inset-left, 0px) + ${INSET - 8}px)`,
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${INSET - 8}px)`,
        width: STICK.zone,
        height: STICK.zone,
      }}
      onPointerDown={(e) => {
        if (!zone.current || (drag.current && owns(e, drag.current.id))) return
        capture(e)
        const rect = zone.current.getBoundingClientRect()
        const cx = Math.max(rect.left + r, Math.min(rect.right - r, e.clientX))
        const cy = Math.max(rect.top + r, Math.min(rect.bottom - r, e.clientY))
        drag.current = { id: e.pointerId, cx, cy, bx: cx - (rect.left + half), by: cy - (rect.top + half) }
        input.engageTouch()
        move(e.clientX, e.clientY)
      }}
      onPointerMove={(e) => { if (drag.current?.id === e.pointerId) move(e.clientX, e.clientY) }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onContextMenu={noMenu}
    >
      <div
        ref={base}
        className={`absolute rounded-full ${GLASS}`}
        style={{ left: half - r, top: half - r, width: STICK.base, height: STICK.base }}
      />
      <div
        ref={knob}
        className="absolute rounded-full border border-white/80 bg-white/80 shadow-[0_4px_14px_rgba(15,23,42,0.35)]"
        style={{ left: half - STICK.knob / 2, top: half - STICK.knob / 2, width: STICK.knob, height: STICK.knob }}
      />
    </div>
  )
}

/**
 * The keyboard's one-key actions for a phone: a round Menu button half-way down the right edge (clear of the stick,
 * the action buttons and the HUD's corners) opening a sheet beside it. Its items act on `click`, a whole tap: the console's has
 * to, since iOS raises the keyboard only for a focus made while the tap is handled, and a menu is never pressed with
 * the other thumb busy. The clock items leave the sheet open for another hour; the rest close it, as does a tap
 * anywhere else (that tap lands on a backdrop and does nothing more).
 */
function Menu({ input, host }: { input: Input; host: TouchMenuHost }) {
  const [open, setOpen] = useState(false)
  const act = (fn: () => void, close = true) => () => {
    input.engageTouch()
    fn()
    if (close) setOpen(false)
  }
  const items: { label: string; on?: boolean; run: () => void; keep?: boolean }[] = [
    { label: 'Console', run: host.onConsole },
    { label: 'Clock −1 h', run: () => input.press('timeBack'), keep: true },
    { label: 'Clock +1 h', run: () => input.press('timeForward'), keep: true },
    { label: 'Ghost view', on: host.ghost, run: () => input.press('ghost') },
    { label: 'Rain mode', on: host.rain, run: () => input.press('matrix') },
    { label: host.hudVisible ? 'Hide HUD' : 'Show HUD', run: host.onHud },
  ]
  // Its own layer above the HUD cards and the Concierge (z-30), below the console: an open sheet must not hide under the
  // action buttons or the Concierge on a short landscape screen.
  return (
    <div className="pointer-events-none absolute inset-0 z-40 select-none" style={ROOT_STYLE}>
      {open && <div aria-hidden className={`${CONTROL} absolute inset-0`} onClick={() => setOpen(false)} onContextMenu={noMenu} />}
      <div
        className="pointer-events-none absolute flex items-center gap-3"
        style={{ right: `calc(env(safe-area-inset-right, 0px) + ${INSET}px)`, top: '50%', transform: 'translateY(-50%)' }}
      >
        {open && (
          <div role="menu" aria-label="Menu" className={`${CONTROL} flex flex-col gap-1.5 rounded-2xl p-2 ${GLASS}`}>
            {items.map((it) => (
              <button
                key={it.label}
                type="button"
                role={it.on === undefined ? 'menuitem' : 'menuitemcheckbox'}
                aria-checked={it.on}
                onClick={act(it.run, !it.keep)}
                onContextMenu={noMenu}
                className={`${CONTROL} h-11 min-w-[148px] rounded-xl px-4 text-left text-[13px] font-semibold tracking-tight ${it.on ? 'bg-white/80 text-slate-900' : 'text-white'}`}
              >
                {it.on === undefined ? it.label : `${it.label} · ${it.on ? 'On' : 'Off'}`}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          aria-label="Menu"
          aria-expanded={open}
          aria-haspopup="menu"
          onClick={() => { input.engageTouch(); setOpen((o) => !o) }}
          onContextMenu={noMenu}
          className={`${CONTROL} flex h-12 w-12 flex-col items-center justify-center gap-[5px] rounded-full ${open ? GLASS_ON : GLASS}`}
        >
          <span className="block h-[2px] w-5 rounded-full bg-current" />
          <span className="block h-[2px] w-5 rounded-full bg-current" />
          <span className="block h-[2px] w-5 rounded-full bg-current" />
        </button>
      </div>
    </div>
  )
}

/**
 * Fires on pointerdown (any finger, even while another holds the stick). The click a pointer press produces
 * afterwards is ignored; a click with no press before it (keyboard or assistive activation) fires.
 */
function TapButton({ label, onTap, pressed, round }: { label: string; onTap: () => void; pressed?: boolean; round?: boolean }) {
  /** Event time of this button's latest pointer down/up/cancel: a click right after one is that press's echo. */
  const pointerAt = useRef(-1e9)
  const stamp = (e: PointerEvent<HTMLButtonElement>) => { pointerAt.current = e.timeStamp }
  const shape = round
    ? 'flex h-[76px] w-[76px] items-center justify-center transition-colors'
    : 'h-12 min-w-[88px] px-5 active:scale-95'
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onPointerDown={(e) => {
        stamp(e)
        if (e.pointerType !== 'mouse' || e.button === 0) onTap()
      }}
      onPointerUp={stamp}
      onPointerCancel={stamp}
      onClick={(e) => { if (e.timeStamp - pointerAt.current > 600) onTap() }}
      onContextMenu={noMenu}
      className={`${CONTROL} ${shape} rounded-full text-[13px] font-semibold tracking-tight ${pressed ? GLASS_ON : GLASS}`}
    >
      {label}
    </button>
  )
}

/** Down while a finger is on it; pointer capture keeps it down when the thumb slides off the edge. */
function HoldButton({ label, size, button, input }: { label: string; size: number; button: TouchButton; input: Input }) {
  const [down, setDown] = useState(false)
  const set = (on: boolean) => {
    setDown(on)
    input.setTouchButton(button, on)
  }
  return (
    <button
      type="button"
      aria-pressed={down}
      onPointerDown={(e) => { capture(e); set(true) }}
      onPointerUp={() => set(false)}
      onPointerCancel={() => set(false)}
      onLostPointerCapture={() => set(false)}
      onContextMenu={noMenu}
      className={`${CONTROL} flex items-center justify-center rounded-full font-semibold tracking-tight ${label.length > 6 ? 'text-[11px]' : 'text-[13px]'} ${down ? GLASS_ON : GLASS}`}
      style={{ width: size, height: size }}
    >
      {label}
    </button>
  )
}
