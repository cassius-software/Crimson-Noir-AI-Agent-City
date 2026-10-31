// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the touch Supplier for phones and tablets: a frosted-glass, thumb-sized
 * overlay with a floating virtual stick on the left (walk, or steer + throttle), drag on the right half to
 * turn the first-person head (yaw and pitch), and context buttons — Enter/Exit car when relevant, Run on
 * foot, Brake, Handbrake and Reset while driving, and Ping (a mark where the head looks) in both modes. A Menu
 * button beside them opens what a keyboard reaches with one key and a phone has no key for: the Ring-0 console (and
 * through it `ask`, the agents and every setting), the model file kept in this page (the browser's file picker), the
 * clock an hour back or on, ghost view, rain mode, and hiding the HUD. Only its own controls take pointer events, so
 * the rest of the HUD stays click-through. After every layout it measures what it drew and judges it by the rule book
 * (touchLayout.ts: finger-sized, on the size ladder, clear of each other and of the system's swipe bands), and says
 * so in its `data-touch-layout` attribute, which the browser smoke test reads at every phone size.
 * What breaks if it is removed? Touch devices can neither move, look nor drive.
 *
 * Every control acts on pointer events, never on `click`: browsers synthesize a click only for a lone tap, so a
 * button pressed while the other thumb holds the stick would never fire. Every held control is owned by the pointer
 * that pressed it (touchLayout.ts PointerOwner): a second finger neither presses it again nor, lifting, lets it go.
 */
import { useCallback, useEffect, useReducer, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent } from 'react'
import type { Input, TouchButton } from './input.ts'
import { layoutAttribute, PointerOwner, stickCentreBounds, TOUCH, validateTouchLayout, type ControlKind, type ControlRect, type Viewport } from './touchLayout.ts'

const STICK = { zone: 184, base: 116, knob: 52, travel: 42, deadPx: 5 } as const

const GLASS = 'border border-white/30 bg-slate-900/35 text-white shadow-[0_8px_28px_rgba(15,23,42,0.35)] backdrop-blur-xl backdrop-saturate-150'
const GLASS_ON = 'border border-white/80 bg-white/80 text-slate-900 shadow-[0_8px_28px_rgba(15,23,42,0.35)] backdrop-blur-xl backdrop-saturate-150'
const CONTROL = 'pointer-events-auto touch-none select-none'

/** The safe-area insets as custom properties, so the layout judge can read them back (env() cannot be read from a script). */
const ROOT_STYLE: CSSProperties = {
  WebkitTouchCallout: 'none', WebkitUserSelect: 'none',
  ['--safe-top' as string]: 'env(safe-area-inset-top, 0px)', ['--safe-right' as string]: 'env(safe-area-inset-right, 0px)',
  ['--safe-bottom' as string]: 'env(safe-area-inset-bottom, 0px)', ['--safe-left' as string]: 'env(safe-area-inset-left, 0px)',
}

const KINDS: readonly ControlKind[] = ['tap', 'hold', 'menu', 'stick', 'look']
const px = (v: string) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0 }

/** The controls the layer drew, as the judge sees them: every element marked data-touch that has a size. */
function measureControls(layer: HTMLElement): ControlRect[] {
  const out: ControlRect[] = []
  for (const el of layer.querySelectorAll<HTMLElement>('[data-touch]')) {
    const kind = el.dataset.touch as ControlKind
    if (!KINDS.includes(kind)) continue
    const r = el.getBoundingClientRect()
    if (!(r.width > 0 && r.height > 0)) continue
    // The layout size, not the drawn one: a pressed pill is drawn at active:scale-95 and would measure 46 px.
    const w = el.offsetWidth || r.width, h = el.offsetHeight || r.height
    out.push({ name: el.getAttribute('aria-label') || el.textContent?.trim() || kind, kind, x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h })
  }
  return out
}

/** The viewport and the safe-area insets the layer's custom properties resolved to. */
function viewportOf(layer: HTMLElement): Viewport {
  const cs = getComputedStyle(layer)
  const side = (name: string) => px(cs.getPropertyValue(name))
  const fontScale = (px(getComputedStyle(document.documentElement).fontSize) || 16) / 16
  return { width: window.innerWidth, height: window.innerHeight, safe: { top: side('--safe-top'), right: side('--safe-right'), bottom: side('--safe-bottom'), left: side('--safe-left') }, fontScale }
}

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
  /**
   * Opens the browser's file picker for the model file kept in this page; called from the tap's click handler, since a
   * browser opens its picker only inside a tap. Absent: the item is not shown (the host keeps no model file).
   */
  onModelFile?: () => void
  /** Shows or hides the HUD (the H key). */
  onHud(): void
  hudVisible: boolean
  /** Ghost view and rain mode as the last snapshot reported them, so their items read On or Off. */
  ghost: boolean
  rain: boolean
  /** Enters or leaves the headset (WebXR), inside the tap; absent where no immersive session can be asked for. */
  onHeadset?: () => void
  headset?: boolean
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
  // The open Menu's sheet stands beside the button that opened it (null: closed).
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null)
  const closeMenu = useCallback(() => setMenuAt(null), [])
  // Getting in or out of a car, or a remount, moves the button: the sheet closes (a turn of the phone closes it too,
  // MenuSheet). Adjusted while rendering, from the values seen last, so it never shows a frame beside nothing.
  const [menuFor, setMenuFor] = useState({ driving, epoch })
  if (menuFor.driving !== driving || menuFor.epoch !== epoch) {
    setMenuFor({ driving, epoch })
    setMenuAt(null)
  }

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

  // Where the buttons stand, for Sloane's card (Concierge.tsx), which keeps clear of them: --touch-top is the height
  // from the screen's foot to the buttons' top edge, --touch-left the width from its right edge to their left edge.
  // The same pass measures every control and judges the layout (touchLayout.ts), into data-touch-layout on the layer:
  // on mount, on every resize, whenever the cluster changes size, and when the buttons change with the mode.
  const cluster = useRef<HTMLDivElement>(null)
  const layer = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = cluster.current, root = layer.current
    if (!el || !root) return
    const page = document.documentElement.style
    const publish = () => {
      const r = el.getBoundingClientRect()
      page.setProperty('--touch-top', `${Math.round(window.innerHeight - r.top)}px`)
      page.setProperty('--touch-left', `${Math.round(window.innerWidth - r.left)}px`)
      root.setAttribute('data-touch-layout', layoutAttribute(validateTouchLayout(measureControls(root), viewportOf(root))))
    }
    publish()
    const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
    watch?.observe(el)
    window.addEventListener('resize', publish)
    return () => {
      watch?.disconnect()
      window.removeEventListener('resize', publish)
      page.removeProperty('--touch-top')
      page.removeProperty('--touch-left')
    }
  }, [epoch, driving, nearVehicle])

  const run = input.touchHeld('run')
  const press = (fn: () => void) => () => { input.engageTouch(); fn() }
  // The Menu rides with the action buttons, never over them, the stick, Sloane's chip or the speedometer, at any phone
  // size: on foot above Ping and Run (beside Enter car near one), at the wheel just before Ping (in landscape the row
  // above the brakes reads Menu, Ping, Reset, Exit car; beside the brakes it would meet the speedometer, which stands
  // between the thumbs on a short phone, and above the column it would meet the chip). Held upright on a phone under
  // 376 px across, the rows that would reach over the stick's zone stand as columns instead.
  const menuButton = menu && <MenuButton open={menuAt !== null} onToggle={(at) => { input.engageTouch(); setMenuAt((o) => (o ? null : at)) }} />

  return (
    <>
      <div ref={layer} className="pointer-events-none absolute inset-0 z-10 select-none" style={ROOT_STYLE}>
        <LookZone key={`look-${epoch}`} input={input} />
        <Stick key={`stick-${epoch}`} input={input} />
        <div
          key={`buttons-${epoch}`}
          ref={cluster}
          className="pointer-events-none absolute flex flex-col items-end gap-3"
          style={{ right: `calc(env(safe-area-inset-right, 0px) + ${TOUCH.insetX}px)`, bottom: `calc(env(safe-area-inset-bottom, 0px) + ${TOUCH.insetY}px)` }}
        >
          {driving ? (
            <div className="flex flex-col items-end gap-3">
              {/* A column in portrait: as a row, Ping would sit over the stick's zone on a phone held upright. Under
                  376 px across, Reset and Exit car share a row above the brakes, which stand one over the other. In
                  landscape under 600 px across (a 568 px phone) the row closes up to 8 px gaps, the least two targets may
                  keep (touchLayout.ts), so it ends clear of the stick's zone with the cluster 24 px in from the edge. */}
              <div className="flex gap-3 portrait:flex-col portrait:items-end landscape:max-[600px]:gap-2">
                <div className="flex items-center gap-3 landscape:max-[600px]:gap-2">
                  {menuButton}
                  <TapButton label="Ping" onTap={press(() => input.press('ping'))} />
                </div>
                <div className="flex gap-3 portrait:flex-col portrait:items-end portrait:max-[376px]:flex-row landscape:max-[600px]:gap-2">
                  <TapButton label="Reset" onTap={press(() => input.press('reset'))} />
                  <TapButton label="Exit car" onTap={press(() => input.press('interact'))} />
                </div>
              </div>
              <div className="flex items-end gap-3 portrait:max-[376px]:flex-col">
                <HoldButton label="Handbrake" size={BRAKE_SIZE.handbrake} button="handbrake" input={input} />
                <HoldButton label="Brake" size={BRAKE_SIZE.brake} button="brake" input={input} />
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-end gap-3">
              <div className="flex items-end gap-3 portrait:max-[376px]:flex-col-reverse">
                {menuButton}
                {nearVehicle && <TapButton label="Enter car" onTap={press(() => input.press('interact'))} />}
              </div>
              <div className="flex items-end gap-3 portrait:max-[376px]:flex-col">
                <TapButton label="Ping" round onTap={press(() => input.press('ping'))} />
                <TapButton
                  label="Run"
                  pressed={run}
                  round
                  onTap={() => { input.setTouchButton('run', !input.touchHeld('run')); rerender() }}
                />
              </div>
            </div>
          )}
        </div>
      </div>
      {menu && menuAt && <MenuSheet input={input} host={menu} at={menuAt} onClose={closeMenu} />}
    </>
  )
}

/**
 * Right half: drag to turn the head — the view follows the finger like a mouse (right turns right, up looks
 * up) at Input's first-person touch sensitivity. One finger at a time; the others belong to the stick and
 * buttons. A mouse press on a touch laptop is not a finger: it is left alone (moving the mouse puts the whole overlay
 * away, Input.mouseHidesTouch), so the mouse keeps its own look. On a tablet whose primary pointer is the finger the
 * overlay stays, and there a mouse or trackpad drag looks like a finger's.
 */
function LookZone({ input }: { input: Input }) {
  const look = useRef<{ id: number; x: number; y: number } | null>(null)
  const end = (e: PointerEvent<HTMLDivElement>) => { if (look.current?.id === e.pointerId) look.current = null }
  return (
    <div
      aria-hidden
      data-touch="look"
      className={`${CONTROL} absolute top-0 right-0 bottom-0 w-1/2`}
      onPointerDown={(e) => {
        if ((e.pointerType === 'mouse' && input.mouseHidesTouch) || (look.current && owns(e, look.current.id))) return
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
      data-touch="stick"
      className={`${CONTROL} absolute`}
      style={{
        left: `calc(env(safe-area-inset-left, 0px) + ${TOUCH.stickInset}px)`,
        bottom: `calc(env(safe-area-inset-bottom, 0px) + ${TOUCH.stickInset}px)`,
        width: STICK.zone,
        height: STICK.zone,
      }}
      onPointerDown={(e) => {
        if ((e.pointerType === 'mouse' && input.mouseHidesTouch) || !zone.current || (drag.current && owns(e, drag.current.id))) return
        capture(e)
        const rect = zone.current.getBoundingClientRect()
        // The base jumps to the thumb, but never into the swipe band at the screen's edge (touchLayout.ts).
        const b = stickCentreBounds(rect)
        const cx = Math.max(b.minX, Math.min(b.maxX, e.clientX))
        const cy = Math.max(b.minY, Math.min(b.maxY, e.clientY))
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
 * The round Menu button among the action buttons; it reports where it stands, for its sheet. Opens on pointerdown, like the buttons beside it: a browser makes a click only of a lone tap, so a click would never
 * come while the other thumb holds the stick. A click with no press before it (keyboard or assistive activation) also
 * toggles it.
 */
function MenuButton({ open, onToggle }: { open: boolean; onToggle: (at: DOMRect) => void }) {
  const pointerAt = useRef(-1e9)
  const stamp = (e: PointerEvent<HTMLButtonElement>) => { pointerAt.current = e.timeStamp }
  return (
    <button
      type="button"
      aria-label="Menu"
      aria-expanded={open}
      aria-haspopup="menu"
      data-touch="menu"
      onPointerDown={(e) => {
        stamp(e)
        if (e.pointerType !== 'mouse' || e.button === 0) onToggle(e.currentTarget.getBoundingClientRect())
      }}
      onPointerUp={stamp}
      onPointerCancel={stamp}
      onClick={(e) => { if (e.timeStamp - pointerAt.current > 600) onToggle(e.currentTarget.getBoundingClientRect()) }}
      onContextMenu={noMenu}
      className={`${CONTROL} flex h-12 w-12 shrink-0 flex-col items-center justify-center gap-[5px] rounded-full ${open ? GLASS_ON : GLASS}`}
    >
      <span className="block h-[2px] w-5 rounded-full bg-current" />
      <span className="block h-[2px] w-5 rounded-full bg-current" />
      <span className="block h-[2px] w-5 rounded-full bg-current" />
    </button>
  )
}

/** The sheet's width with its padding and border (its items are at least 148 px), for where it fits. */
const SHEET_W = 172

/**
 * The keyboard's one-key actions for a phone, in a sheet that opens upward from the Menu button's foot, to its left, or,
 * where there is no room to its left (a narrow phone held upright), upward from the button's top with their right edges
 * aligned: it never runs off the screen (its height is capped to the room above, and it scrolls past that; its items
 * keep their height), and it leaves the button showing. Its items act on `click`, a whole tap: the console's has to,
 * since iOS raises the keyboard only for a focus made while the tap is handled, and the model file's too, since a
 * browser opens its file picker only while a tap is handled. The clock items leave the sheet open
 * for another hour; the rest close it, as does a tap anywhere else (that tap lands on a backdrop and does nothing more;
 * the click that ends the tap which opened the sheet lands there too, and is not a tap on it) and a turn of the phone,
 * which moves the button.
 */
function MenuSheet({ input, host, at, onClose }: { input: Input; host: TouchMenuHost; at: DOMRect; onClose: () => void }) {
  useEffect(() => {
    window.addEventListener('resize', onClose)
    return () => window.removeEventListener('resize', onClose)
  }, [onClose])
  const pressed = useRef(false)
  const act = (fn: () => void, close = true) => () => {
    input.engageTouch()
    fn()
    if (close) onClose()
  }
  const items: { label: string; on?: boolean; run: () => void; keep?: boolean }[] = [
    { label: 'Console', run: host.onConsole },
    ...(host.onModelFile ? [{ label: 'Model file', run: host.onModelFile }] : []),
    { label: 'Clock −1 h', run: () => input.press('timeBack'), keep: true },
    { label: 'Clock +1 h', run: () => input.press('timeForward'), keep: true },
    { label: 'Ghost view', on: host.ghost, run: () => input.press('ghost') },
    { label: 'Rain mode', on: host.rain, run: () => input.press('matrix') },
    ...(host.onHeadset ? [{ label: 'Headset', on: host.headset === true, run: host.onHeadset }] : []),
    { label: host.hudVisible ? 'Hide HUD' : 'Show HUD', run: host.onHud },
  ]
  const beside = at.left - 12 - SHEET_W >= 8
  const sheet: CSSProperties = beside
    ? {
        right: Math.max(8, window.innerWidth - at.left + 12),
        bottom: Math.max(8, window.innerHeight - at.bottom),
        maxHeight: `calc(${Math.round(at.bottom)}px - max(12px, env(safe-area-inset-top, 0px)))`,
      }
    : {
        right: Math.max(8, window.innerWidth - at.right),
        bottom: Math.max(8, window.innerHeight - at.top + 12),
        maxHeight: `calc(${Math.round(at.top - 12)}px - max(12px, env(safe-area-inset-top, 0px)))`,
      }
  // Its own layer above the HUD cards and the Concierge (z-30), below the console: an open sheet must not hide under the
  // Concierge on a short landscape screen.
  return (
    <div className="pointer-events-none absolute inset-0 z-40 select-none" style={ROOT_STYLE}>
      <div
        aria-hidden
        className={`${CONTROL} absolute inset-0`}
        onPointerDown={() => { pressed.current = true }}
        onClick={() => { if (pressed.current) onClose() }}
        onContextMenu={noMenu}
      />
      <div role="menu" aria-label="Menu" style={sheet} className={`pointer-events-auto absolute flex touch-pan-y flex-col gap-1.5 overflow-y-auto overscroll-contain rounded-2xl p-2 select-none ${GLASS}`}>
        {items.map((it) => (
          <button
            key={it.label}
            type="button"
            role={it.on === undefined ? 'menuitem' : 'menuitemcheckbox'}
            aria-checked={it.on}
            onClick={act(it.run, !it.keep)}
            onContextMenu={noMenu}
            className={`pointer-events-auto h-11 min-w-[148px] shrink-0 touch-pan-y rounded-xl px-4 text-left text-[13px] font-semibold tracking-tight select-none ${it.on ? 'bg-white/80 text-slate-900' : 'text-white'}`}
          >
            {it.on === undefined ? it.label : `${it.label} · ${it.on ? 'On' : 'Off'}`}
          </button>
        ))}
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
      data-touch="tap"
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

/**
 * The brakes' sizes (full class strings, so Tailwind sees them): 72 and 84 px, and 64 and 72 px on a short screen (the
 * HUD's and Sloane's short query), where the row above them would otherwise reach up to Sloane's chip under the
 * minimap on a phone in landscape.
 */
const BRAKE_SIZE = {
  handbrake: 'size-[72px] [@media(max-height:499px)]:size-16',
  brake: 'size-[84px] [@media(max-height:499px)]:size-[72px]',
} as const

/**
 * Down while the finger that pressed it is on it; pointer capture keeps it down when the thumb slides off the edge.
 * The pressing pointer owns it (PointerOwner): a second finger landing on it is ignored, and its lifting lets nothing
 * go, so two thumbs never cancel each other's holds; the owner's lift, cancel or lost capture releases it.
 */
function HoldButton({ label, size, button, input }: { label: string; size: string; button: TouchButton; input: Input }) {
  const [down, setDown] = useState(false)
  const owner = useRef<PointerOwner | null>(null)
  const own = () => (owner.current ??= new PointerOwner())
  const set = (on: boolean) => {
    setDown(on)
    input.setTouchButton(button, on)
  }
  const release = (e: PointerEvent<HTMLButtonElement>) => { if (own().release(e.pointerId)) set(false) }
  return (
    <button
      type="button"
      aria-pressed={down}
      data-touch="hold"
      onPointerDown={(e) => {
        const o = own()
        // A finger whose capture was never taken or silently lost would hold the button for good: it is taken over.
        if (o.held && !owns(e, o.id)) { o.clear(); set(false) }
        if (!o.claim(e.pointerId)) return
        capture(e)
        set(true)
      }}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={noMenu}
      className={`${CONTROL} ${size} flex items-center justify-center rounded-full font-semibold tracking-tight ${label.length > 6 ? 'text-[11px]' : 'text-[13px]'} ${down ? GLASS_ON : GLASS}`}
    >
      {label}
    </button>
  )
}
