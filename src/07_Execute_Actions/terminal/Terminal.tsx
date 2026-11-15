// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Ring-0 developer terminal: a drop-down console on the
 * backquote/tilde key with the look of a raw root shell (ash prompt, block cursor, monospace). It reads
 * and tunes the city only through the TerminalBridge; while it is open it owns the keyboard, so no
 * keystroke typed here reaches the game. The prompt is a multi-line buffer (Shift+Enter adds a line
 * under a `…` continuation prompt) so operator scripts can be typed in place.
 * A local model's answer (`ask`) streams in live under the scrollback until its final lines replace it. A city action
 * an agent proposed and decided off the console (the card, a host, the gateway) is printed here as it happens, open or
 * hidden (commands.ts actEventLines over the bridge's `operator.acts.follow`), so the scrollback is complete on reopening.
 * With `fullscreen` (Track B, ?boot=tty) it is the whole page instead: open from the first render, full height,
 * black, and no key closes it; a `boot` result is handed to the host (onBoot), which reloads on that track. Its text
 * starts below the host's 'Back to the city' button (App.tsx TtyShell: the same top offset plus the button's 44 px
 * and a gap), so the button never covers the first lines on a phone; change the two together.
 * One R0 machine (`r0`, repl.ts) lives for the life of the console, so definitions outlive a line; a typed key or
 * token never enters the history as typed (redactForHistory).
 * A touch screen has no tilde key: the host opens the console through its handle (TerminalHandle.open, the touch
 * menu's Console item), and a Close button shows on coarse pointers only.
 * It also hosts the console's operating layer (os/, through commands.ts): it hands the layer its clocks, random bytes
 * and the host's disk store, gives it turns on a timer while it has work (a job in the background, a line that answers
 * later), shows what it prints in order with everything else, shows the shell's own prompt (the directory changes; a
 * line already printed keeps the prompt it was typed at), sends Ctrl+C and Ctrl+D to it (a touch screen gets a Stop
 * and an End input button while a job has the terminal), and saves its disk a moment after it changes and when the
 * page is hidden.
 * What breaks if it is removed? Operators lose the live Rapier3D / crowd / kernel readout, the quality,
 * clock, audio and hardware-pairing controls, and the operator tier's scripts, answers and harnesses.
 */
import { memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref, type SyntheticEvent } from 'react'
import { flushSync } from 'react-dom'
import { BRAND } from '../../brand.ts'
import { offlineBridge, type TerminalBridge } from './bridge.ts'
import { actEventLines, commonPrefix, completeLine, continuationPrompt, isToggleKey, motd, recallsHistory, redactForHistory, replSession, run, type CommandResult, type DiskStore, type Line, type LiveFrame, type OsSession, type ReplSession } from './commands.ts'

const MAX_ROWS = 600
const MAX_HISTORY = 200
const LIVE_MS = 250
/** Stick to the bottom while the view is within this many pixels of it. */
const STICK_PX = 32
/** Longest entry: scripts can be long. */
const MAX_CHARS = 8192
const OFFLINE = offlineBridge(BRAND)
/** The operating layer's turns: how often while it has work, how often to look when it has none, and how long a turn may take. */
const OS_BUSY_MS = 16
const OS_IDLE_MS = 250
const OS_TURN_MS = 4
/** Full screen there is no city to draw, so a turn may be longer. */
const OS_TURN_FULL_MS = 12
/** The disk is saved this long after it last changed (and at once when the page is hidden). */
const SAVE_MS = 1500
/** The most random bytes the browser hands out in one call. */
const ENTROPY_CHUNK = 65536

/** A line to show; an entered line may carry the prompt it was typed at (else the prompt of the moment is shown). */
interface Shown extends Line { ps?: string }
interface Row extends Shown { id: number }

/** An answer streaming in: its text so far, and the tokens of thinking before it. */
interface Streaming { id: number; thinking: number; text: string }

const FONT = "ui-monospace, 'Cascadia Mono', 'SF Mono', Menlo, Consolas, 'DejaVu Sans Mono', monospace"

const CSS = `
.r0-root{position:absolute;top:0;left:0;right:0;z-index:9999;box-sizing:border-box;display:flex;flex-direction:column;
height:calc(45vh + env(safe-area-inset-top,0px));height:calc(45dvh + env(safe-area-inset-top,0px));min-height:10rem;
padding:calc(env(safe-area-inset-top,0px) + 6px) max(12px,env(safe-area-inset-right,0px)) 6px max(12px,env(safe-area-inset-left,0px));
background:rgba(0,0,0,0.85);color:#c8c8c8;font:13px/1.4 ${FONT};font-variant-ligatures:none;text-align:left;
border-bottom:1px solid #3a3a3a;user-select:text;-webkit-user-select:text;cursor:text;
transform:translateY(-100%);visibility:hidden;pointer-events:none;transition:transform 140ms ease-in,visibility 0s linear 140ms}
.r0-root[data-open]{transform:none;visibility:visible;pointer-events:auto;transition:transform 160ms ease-out,visibility 0s}
.r0-root[data-full]{height:100%;min-height:0;transform:none;visibility:visible;pointer-events:auto;border-bottom:0;background:#000;transition:none;
padding-top:calc(max(0.75rem,env(safe-area-inset-top,0px)) + 3.25rem)}
.r0-root ::selection{background:#c8c8c8;color:#000}
.r0-scroll{flex:1;min-height:0;overflow-y:auto;overscroll-behavior:contain;white-space:pre-wrap;overflow-wrap:anywhere;
scrollbar-width:thin;scrollbar-color:#4a4a4a transparent}
.r0-line{min-height:1.4em}
.r0-cmd,.r0-ps1{color:#ececec}
.r0-err{color:#ff7b72}
.r0-sys{color:#8c8c8c}
.r0-prompt{position:relative}
.r0-input{position:absolute;top:0;bottom:0;display:block;box-sizing:border-box;margin:0;padding:0;border:0;outline:0;background:transparent;
font:inherit;color:transparent;caret-color:transparent;opacity:0;resize:none;overflow:hidden;white-space:pre-wrap;overflow-wrap:anywhere}
.r0-cursor{background:#c8c8c8;color:#000;animation:r0-blink 1.06s steps(1) 0.5s infinite}
.r0-cursor[data-idle]{background:transparent;color:inherit;box-shadow:inset 0 0 0 1px #c8c8c8;animation:none}
.r0-sel{background:#c8c8c8;color:#000}
@keyframes r0-blink{50%{background:transparent;color:inherit}}
@media (max-width:640px){.r0-root{font-size:12px}}
@media (pointer:coarse){.r0-input{font-size:16px}}
.r0-close{display:none}
.r0-job{display:none}
@media (pointer:coarse){.r0-root[data-open] .r0-job,.r0-root[data-full] .r0-job{display:flex;gap:8px;position:absolute;z-index:1;
top:calc(env(safe-area-inset-top,0px) + 6px);right:max(12px,env(safe-area-inset-right,0px))}
.r0-root[data-open]:not([data-full]) .r0-job{right:calc(max(12px,env(safe-area-inset-right,0px)) + 84px)}
.r0-job button{min-width:72px;height:40px;padding:0 14px;border:1px solid #5a5a5a;border-radius:6px;background:#111;color:#ececec;
font:600 13px/1 ${FONT};touch-action:manipulation}}
@media (pointer:coarse){.r0-root[data-open]:not([data-full]) .r0-close{display:block;position:absolute;z-index:1;
top:calc(env(safe-area-inset-top,0px) + 6px);right:max(12px,env(safe-area-inset-right,0px));min-width:72px;height:40px;padding:0 14px;
border:1px solid #5a5a5a;border-radius:6px;background:#111;color:#ececec;font:600 13px/1 ${FONT};touch-action:manipulation}}
@media (prefers-reduced-motion:reduce){.r0-root,.r0-root[data-open]{transition:none}.r0-cursor{animation:none}}
`

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

function isEditable(t: EventTarget | null): boolean {
  return t instanceof HTMLElement && (t.isContentEditable || t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement)
}

/**
 * Keys that end a live `stats` view wherever focus is: q on an empty prompt, or Ctrl+C with nothing
 * selected (with a selection, Ctrl+C copies).
 */
function stopsLive(e: KeyboardEvent, input: HTMLTextAreaElement | null): boolean {
  if (e.metaKey || e.altKey) return false
  if (e.key === 'q' && !e.ctrlKey) return !input?.value
  if (!e.ctrlKey || (e.key !== 'c' && e.key !== 'C')) return false
  const inPrompt = input !== null && document.activeElement === input && input.selectionStart !== input.selectionEnd
  return !inPrompt && !window.getSelection()?.toString()
}

/** Scrollback, memoised so a parent re-render (the HUD ticks at 10 Hz) never re-renders hundreds of rows. */
const Scrollback = memo(function Scrollback({ rows, prompt }: { rows: readonly Row[]; prompt: string }) {
  const cont = continuationPrompt(prompt)
  return (
    <>
      {rows.map((r) => (
        <div key={r.id} className={`r0-line r0-${r.kind}`}>{r.kind === 'cmd' ? (r.ps ?? prompt) + r.text.replace(/\n/g, `\n${r.ps === undefined ? cont : continuationPrompt(r.ps)}`) : r.text}</div>
      ))}
    </>
  )
})

/** What the host can do besides the toggle key, which a touch screen does not have. */
export interface TerminalHandle {
  /**
   * Opens the console and focuses its prompt before returning. iOS raises the on-screen keyboard only for a focus made
   * while the tap that asked for it is still being handled, so call this from the tap's own click handler.
   */
  open(): void
  /**
   * Opens the console and puts `text` into its prompt in place of whatever is typed, without taking focus (a phone's
   * keyboard does not rise for it). Enter (or `run`) submits it.
   */
  type(text: string): void
  /** Opens the console and submits `line` as if typed (the prompt's own text is left as it is); with no line, submits the prompt's text. */
  run(line?: string): void
  /**
   * Adds `lines` to the scrollback as the console's own lines, open or not, without running anything or touching the
   * prompt or the history: the first walk's banner when the city opens (App.tsx, firstWalk.ts passedBanner).
   */
  print(lines: readonly string[]): void
}

export function Terminal({ bridge, onOpenChange, fullscreen = false, onBoot, onMap, onLine, disk = null, ref }: {
  bridge: TerminalBridge | null
  /** Where the console's disk is kept between visits (the host's storage); without one, its files last as long as the page. */
  disk?: DiskStore | null
  onOpenChange(open: boolean): void
  /** Every line submitted, as typed (trimmed), after it ran: the first walk hears of the console in use. */
  onLine?(line: string): void
  /** Track B: the console is the whole page, open from the start; the toggle key and Esc never close it. */
  fullscreen?: boolean
  /** A `boot gui|tty` result: the host reloads the page on that track. */
  onBoot?(track: 'gui' | 'tty'): void
  /** A `map` result: the host keeps the choice and reloads on that map (`default` forgets it). */
  onMap?(choice: 'city' | 'lakefront' | 'default'): void
  ref?: Ref<TerminalHandle>
}) {
  const [open, setOpen] = useState(fullscreen)
  const [rows, setRows] = useState<Row[]>(() => motd((bridge ?? OFFLINE).brand).map((l, i) => ({ ...l, id: -1 - i })))
  const [value, setValue] = useState('')
  const [sel, setSel] = useState<readonly [number, number]>([0, 0])
  const [focused, setFocused] = useState(false)
  /** The current frame of a live view (`stats`, `topic watch`) while one runs, else null. */
  const [live, setLive] = useState<readonly string[] | null>(null)
  /** Answers streaming in (`ask`), shown live under the scrollback until their final lines replace them. */
  const [streams, setStreams] = useState<readonly Streaming[]>([])
  /** The operating layer's prompt once it runs (the shell's own; empty while a job has the terminal); null before. */
  const [ps1, setPs1] = useState<string | null>(null)
  /** Whether something reads what is typed (a program's input, the rest of a command): the End input button's cue. */
  const [reading, setReading] = useState(false)

  const rootRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const nextId = useRef(0)
  const history = useRef<string[]>([])
  const histPos = useRef(0)
  const draft = useRef('')
  const stick = useRef(true)
  const caretTo = useRef<number | null>(null)
  const liveFrame = useRef<readonly string[] | null>(null)
  /** How the running live view draws its next frame from the bridge (commands.ts LiveFrame), while one runs. */
  const liveDraw = useRef<LiveFrame | null>(null)
  const openRef = useRef(false)
  const reported = useRef(false)
  const mounted = useRef(true)
  const bridgeRef = useRef(bridge)
  const onOpenChangeRef = useRef(onOpenChange)
  const fullRef = useRef(fullscreen)
  const onLineRef = useRef(onLine)
  /** The console's R0 machine (commands.ts `r0`), made on the first line that needs it. */
  const session = useRef<ReplSession | null>(null)
  /** `submit` as of the latest render, for the handle's `run` (the handle is built once). */
  const submitRef = useRef<(raw: string) => void>(() => {})
  /** `apply` as of the latest render, for the operating layer's timer (set up once). */
  const applyRef = useRef<(r: CommandResult) => void>(() => {})
  const diskRef = useRef(disk)
  /** The prompt as shown now, for the row an entered line leaves behind. */
  const promptRef = useRef('')
  /** The operating layer's next turn, and its next save. */
  const osTimer = useRef<number | null>(null)
  const saveTimer = useRef<number | null>(null)

  const append = useCallback((lines: readonly Shown[]) => {
    if (!lines.length) return
    setRows((prev) => {
      const next = prev.concat(lines.map((l) => (l.ps === undefined ? { kind: l.kind, text: l.text, id: nextId.current++ } : { kind: l.kind, text: l.text, ps: l.ps, id: nextId.current++ })))
      return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
    })
  }, [])

  useImperativeHandle(ref, () => ({
    open() {
      if (fullRef.current) return
      // Committed now, not on the next render: the prompt must be visible and not inert when it takes focus.
      flushSync(() => setOpen(true))
      inputRef.current?.focus({ preventScroll: true })
    },
    type(text) {
      if (!fullRef.current) flushSync(() => setOpen(true))
      setValue(text)
      setSel([text.length, text.length])
      caretTo.current = text.length
    },
    run(line) {
      if (!fullRef.current) flushSync(() => setOpen(true))
      submitRef.current(line ?? inputRef.current?.value ?? '')
    },
    print(lines) {
      append(lines.map((text): Line => ({ kind: 'sys', text })))
    },
  }), [append])

  useEffect(() => {
    bridgeRef.current = bridge
    onOpenChangeRef.current = onOpenChange
    fullRef.current = fullscreen
    onLineRef.current = onLine
    diskRef.current = disk
  })

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      // Unmounted while open: hand the keyboard back to the game instead of leaving it suspended.
      if (reported.current) {
        reported.current = false
        onOpenChangeRef.current(false)
      }
    }
  }, [])

  // Every city action event the console did not cause (allowed or refused on the card or by a host, ended by the
  // gateway) is printed as it happens, hidden or not; the console's own `act ok` / `act no` print theirs, so each line
  // is printed once. The offline bridge's follow is a no-op, so this holds on Track B and before the engine is up.
  useEffect(() => (bridge ?? OFFLINE).operator.acts.follow((ev) => append(actEventLines(ev))), [bridge, append])

  /** Ends a live view, leaving its last frame in the scrollback. */
  const stopLive = useCallback(() => {
    const frame = liveFrame.current
    if (!frame) return
    liveFrame.current = null
    liveDraw.current = null
    setLive(null)
    append(frame.map((text) => ({ kind: 'out', text })))
  }, [append])

  // Open/close side effects: tell the host (it suspends game input), release pointer lock, move focus.
  useEffect(() => {
    openRef.current = open
    if (reported.current !== open) {
      reported.current = open
      onOpenChangeRef.current(open)
    }
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock()
      stick.current = true
      inputRef.current?.focus({ preventScroll: true })
    } else if (document.activeElement instanceof HTMLElement && rootRef.current?.contains(document.activeElement)) {
      document.activeElement.blur()
    }
  }, [open])

  // Toggle key, Esc, and keyboard ownership while open. Window capture runs before any game listener; keyup
  // is left alone on purpose, so a key held when the console opened is still released in the game.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing) return
      const inside = rootRef.current?.contains(e.target as Node) ?? false
      if (isToggleKey(e)) {
        if (fullRef.current) return // the whole page: nothing to toggle, the key is an ordinary character
        if (!openRef.current && !inside && isEditable(e.target)) return // someone else's text field
        e.preventDefault()
        e.stopImmediatePropagation()
        if (!e.repeat) setOpen((o) => !o)
        return
      }
      if (!openRef.current) return
      const live = liveFrame.current !== null
      if (e.key === 'Escape' || (live && stopsLive(e, inputRef.current))) {
        if (e.key === 'Escape' && !live && fullRef.current) return // full screen: Esc has nothing to close
        e.preventDefault()
        e.stopImmediatePropagation()
        if (live) stopLive()
        else setOpen(false)
        return
      }
      if (inside) return // the prompt's own handler takes it (and stops it at the React root)
      // Aimed at a way out over the console (RecoveryCard.tsx's screens, TtyShell's 'Back to the city' in App.tsx):
      // its focused button keeps Enter and Space.
      if (e.target instanceof Element && e.target.closest('[role="alertdialog"], [data-way-out]')) return
      // Aimed elsewhere (focus fell to the page): keep it from the game, and pull typing back to the prompt.
      // Chords are left alone so Ctrl+C still copies a selection made in the scrollback.
      e.stopImmediatePropagation()
      if (!e.ctrlKey && !e.metaKey && (e.key.length === 1 || e.key === 'Enter' || e.key === 'Backspace' || e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        inputRef.current?.focus({ preventScroll: true })
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [stopLive])

  // A live view (`stats`, `topic watch`): redrawn in place ~4×/s while open, by the command's own frame function over
  // the bridge. Paused (not ended) while the console is hidden.
  const isLive = live !== null
  useEffect(() => {
    if (!open || !isLive) return
    const id = window.setInterval(() => {
      const draw = liveDraw.current
      if (!draw) return
      try {
        const frame = draw(bridgeRef.current ?? OFFLINE)
        liveFrame.current = frame
        setLive(frame)
      } catch (e) {
        stopLive()
        append([{ kind: 'err', text: `live: ${message(e)}` }])
      }
    }, LIVE_MS)
    return () => window.clearInterval(id)
  }, [open, isLive, stopLive, append])

  // Follow the output unless the operator scrolled up; apply a caret move requested by history recall.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
    const input = inputRef.current
    if (input && caretTo.current !== null) {
      input.setSelectionRange(caretTo.current, caretTo.current)
      caretTo.current = null
    }
  }, [rows, live, streams, value, open])

  /** Replaces the buffer and puts the caret at `caret` (default: the end). */
  const setLine = (v: string, caret = v.length) => {
    setValue(v)
    setSel([caret, caret])
    const el = inputRef.current
    // Unchanged value: the layout effect will not run, so a deferred caret move would fire on a later keystroke.
    if (el && el.value === v) el.setSelectionRange(caret, caret)
    else caretTo.current = caret
  }

  /** Replaces the selection (or inserts at the caret) with `text`, caret after it. */
  const insert = (el: HTMLTextAreaElement, text: string) => {
    const a = el.selectionStart ?? el.value.length, b = el.selectionEnd ?? a
    setLine(`${el.value.slice(0, a)}${text}${el.value.slice(b)}`, a + text.length)
  }

  const syncSel = (e: SyntheticEvent<HTMLTextAreaElement>) => {
    const t = e.currentTarget
    const a = t.selectionStart ?? t.value.length
    const b = t.selectionEnd ?? a
    setSel((s) => (s[0] === a && s[1] === b ? s : [a, b]))
  }

  /** The console's session, made on the first line (or the first Tab): its two languages and the operating layer. */
  const sessionOf = (): ReplSession => (session.current ??= replSession({
    brand: (bridge ?? OFFLINE).brand,
    clock: () => performance.now(),
    wall: () => Date.now(),
    entropy: (bytes) => {
      for (let at = 0; at < bytes.length; at += ENTROPY_CHUNK) crypto.getRandomValues(bytes.subarray(at, Math.min(bytes.length, at + ENTROPY_CHUNK)) as Uint8Array<ArrayBuffer>)
    },
    disk: diskRef.current,
  }))

  /** Saves the layer's disk if it changed; `soon` waits a moment for more changes first. */
  const saveDisk = (os: OsSession, soon: boolean) => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current)
    saveTimer.current = null
    if (!os.unsavedChanges) return
    if (!soon) { void os.save(); return }
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null
      void os.save()
    }, SAVE_MS)
  }

  /** Shows what the operating layer printed since last asked, takes its prompt, and books its next turn. */
  const follow = () => {
    const os = session.current?.os
    if (!os) return
    // What the layer waits for from outside (the saved disk, a city command's later lines) gets a turn as it arrives.
    os.wake ??= () => { if (mounted.current) turn() }
    for (let r = os.next(); r !== null; r = os.next()) applyRef.current(r)
    setPs1(os.prompt)
    setReading(os.system.capturing)
    if (os.unsavedChanges && saveTimer.current === null) saveDisk(os, true)
    if (osTimer.current !== null) window.clearTimeout(osTimer.current)
    osTimer.current = window.setTimeout(() => {
      osTimer.current = null
      if (mounted.current) turn()
    }, os.busy ? OS_BUSY_MS : OS_IDLE_MS)
  }

  /** One turn of the operating layer, if it has work, and then what it printed. */
  const turn = () => {
    const os = session.current?.os
    if (!os) return
    if (os.busy) {
      os.bridge = bridgeRef.current ?? OFFLINE
      os.pump(fullRef.current ? OS_TURN_FULL_MS : OS_TURN_MS)
    }
    follow()
  }

  /** Ctrl+C for the operating layer: the job that has the terminal ends, a command half read is dropped. */
  const interrupt = () => {
    const os = session.current?.os
    if (!os) return
    os.system.interrupt()
    os.pump(OS_TURN_MS)
    follow()
  }

  /** Ctrl+D on an empty line: whoever reads what is typed is told the input has ended. */
  const endInput = () => {
    const os = session.current?.os
    if (!os || !os.system.capturing) return
    os.system.end()
    os.pump(OS_TURN_MS)
    follow()
  }

  /** Shows one result: its lines (after `first`, the entered line's own row), then whatever else it asks of the console. */
  const apply = (r: CommandResult, first: readonly Shown[] = []) => {
    // Lines under a live view would be redrawn over: the view ends first, as it does when a line is entered.
    if (first.length === 0 && (r.lines.length > 0 || r.live || r.clear)) stopLive()
    if (r.clear) {
      setRows([])
      append(r.lines)
    } else append([...first, ...(r.live ? [] : r.lines)])
    if (r.live) {
      liveFrame.current = r.lines.map((l) => l.text)
      liveDraw.current = r.live
      setLive(liveFrame.current)
    }
    if (r.stream && r.pending) {
      // An answer: shown live as it arrives, then its final lines take its place.
      const id = nextId.current++
      setStreams((s) => [...s, { id, thinking: 0, text: '' }])
      const off = r.stream.subscribe((p) => {
        if (!mounted.current) return
        setStreams((s) => s.map((v) => (v.id !== id ? v : p.kind === 'text' ? { ...v, text: v.text + p.text } : { ...v, thinking: v.thinking + 1 })))
      })
      const end = (lines: readonly Line[]) => {
        off()
        if (!mounted.current) return
        setStreams((s) => s.filter((v) => v.id !== id))
        append(lines)
      }
      r.pending.then(end, () => end([]))
    } else {
      r.pending?.then((lines) => { if (mounted.current) append(lines) }, () => {})
    }
    if (r.close && !fullscreen) setOpen(false)
    if (r.boot) onBoot?.(r.boot)
    if (r.map) onMap?.(r.map)
  }

  const submit = (raw: string) => {
    // A line typed to something already running (a program's input, the rest of a here-document) is kept as typed,
    // since its blanks are part of it; a command loses the blanks at its ends.
    const system = session.current?.os?.system
    const line = system?.capturing === true ? raw : raw.trim()
    // A program's input is the program's (a name, a note, maybe a secret): it never enters the history.
    const feeding = system?.feeding === true
    if (!line && liveFrame.current) return // a blank Enter does not end a live view
    stopLive()
    // The row this line leaves keeps the prompt it was typed at: the shell's changes with the directory.
    const ps = promptRef.current
    // Runs synchronously inside the keydown: `hal pair` needs the user activation to open a device picker.
    const r = run(line, bridge ?? OFFLINE, history.current, sessionOf())
    const h = history.current
    // A key or a token typed on the line is kept as dots, never as typed.
    const kept = feeding ? '' : redactForHistory(line)
    if (kept && h[h.length - 1] !== kept) {
      h.push(kept)
      if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY)
    }
    histPos.current = h.length
    draft.current = ''
    setLine('')
    stick.current = true
    apply(r, [{ kind: 'cmd', text: line, ps }])
    // Whatever else the operating layer printed for this line, in order; then its prompt and its next turn.
    follow()
    if (line) onLineRef.current?.(line)
  }
  useEffect(() => {
    submitRef.current = submit
    applyRef.current = apply
  })

  // The operating layer's disk is saved when the page is hidden or left (a moment after each change otherwise), and
  // its timers end with the console.
  useEffect(() => {
    const flush = () => {
      const os = session.current?.os
      if (os) saveDisk(os, false)
    }
    const hidden = () => { if (document.visibilityState === 'hidden') flush() }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', hidden)
      flush()
      if (osTimer.current !== null) window.clearTimeout(osTimer.current)
      osTimer.current = null
    }
  }, [])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation()
    if (e.nativeEvent.isComposing) return
    const el = e.currentTarget
    const chord = e.ctrlKey && !e.altKey && !e.metaKey
    const key = e.key
    if (key === 'Enter') {
      e.preventDefault()
      // Shift+Enter continues the entry on a new line (a script); Enter submits the whole buffer.
      if (e.shiftKey) insert(el, '\n')
      else submit(el.value)
    } else if (chord && (key === 'c' || key === 'C')) {
      // Live views are stopped in the window listener; with a selection in the prompt the browser copies.
      if (el.selectionStart === el.selectionEnd) {
        e.preventDefault()
        append([{ kind: 'cmd', text: `${el.value}^C`, ps: promptRef.current }])
        histPos.current = history.current.length
        setLine('')
        interrupt()
      }
    } else if (chord && (key === 'd' || key === 'D')) {
      // On an empty line, the end of input for whatever reads it; the browser's own use of the chord stays off the console.
      if (session.current?.os) {
        e.preventDefault()
        if (el.value === '') endInput()
      }
    } else if (chord && (key === 'l' || key === 'L')) {
      e.preventDefault()
      setRows([])
    } else if (chord && (key === 'u' || key === 'U')) {
      e.preventDefault()
      setLine(el.value.slice(el.selectionStart ?? 0), 0)
    } else if (key === 'ArrowUp' || key === 'ArrowDown') {
      // Inside a multi-line buffer the arrows move between its lines; history is recalled from its edges.
      if (!recallsHistory(key, el.value, el.selectionStart ?? 0)) return
      e.preventDefault()
      const h = history.current
      if (histPos.current === h.length) draft.current = el.value
      histPos.current = key === 'ArrowUp' ? Math.max(0, histPos.current - 1) : Math.min(h.length, histPos.current + 1)
      setLine(histPos.current === h.length ? draft.current : h[histPos.current])
    } else if (key === 'Tab') {
      e.preventDefault()
      if (el.value.includes('\n')) {
        insert(el, '  ') // a script: indent
        return
      }
      const options = completeLine(el.value, sessionOf())
      // A directory completed is not the end of the word: no blank after its slash.
      if (options.length === 1) setLine(options[0].endsWith('/') ? options[0] : `${options[0]} `)
      else if (options.length > 1) {
        const common = commonPrefix(options)
        if (common.length > el.value.length) setLine(common)
        else {
          stick.current = true
          append([{ kind: 'cmd', text: el.value, ps: promptRef.current }, { kind: 'out', text: options.map((o) => o.slice(o.lastIndexOf(' ') + 1)).join('  ') }])
        }
      }
    } else if (key === 'PageUp' || key === 'PageDown') {
      e.preventDefault()
      const s = scrollRef.current
      if (s) s.scrollTop += (key === 'PageUp' ? -1 : 1) * s.clientHeight * 0.9
    }
  }

  const onScroll = () => {
    const s = scrollRef.current
    if (s) stick.current = s.scrollHeight - s.scrollTop - s.clientHeight < STICK_PX
  }

  // Click anywhere to type, unless the click finished a text selection (copying output must work).
  const onMouseUp = () => {
    const s = window.getSelection()
    if (s && !s.isCollapsed && s.toString()) return
    inputRef.current?.focus({ preventScroll: true })
  }

  const b = bridge ?? OFFLINE
  // The shell's own prompt once the operating layer runs (the directory in it; nothing while a job has the terminal).
  const prompt = ps1 ?? `${b.brand.host}:~# `
  useEffect(() => {
    promptRef.current = prompt
  })
  const cont = continuationPrompt(prompt)
  /** The buffer as the mirror shows it: every line after the first under the continuation prompt. */
  const show = (s: string) => s.replace(/\n/g, `\n${cont}`)
  const s0 = Math.min(sel[0], value.length)
  const s1 = Math.min(Math.max(sel[1], s0), value.length)
  const cursor = s0 === s1
  const under = value[s0]
  // The block cursor on a line break shows as a space at the end of that line; the break itself follows it.
  const rest = cursor ? (under === '\n' ? '\n' : '') + value.slice(s0 + 1) : value.slice(s1)

  return (
    <div
      ref={rootRef}
      className="r0-root"
      data-open={open || undefined}
      data-full={fullscreen || undefined}
      inert={!open}
      role="dialog"
      aria-label={`${b.brand.name} Ring-0 terminal`}
      onKeyDown={(e) => e.stopPropagation()}
      onMouseUp={onMouseUp}
    >
      <style href="ring0-terminal" precedence="default">{CSS}</style>
      <button type="button" className="r0-close" onClick={() => setOpen(false)}>Close</button>
      {/* A touch screen has no Ctrl key: while a job has the terminal, Stop is Ctrl+C and End input is Ctrl+D. */}
      {ps1 !== null && (ps1 === '' || reading) && (
        <div className="r0-job">
          {reading && <button type="button" onClick={endInput}>End input</button>}
          <button type="button" onClick={() => { append([{ kind: 'cmd', text: '^C', ps: promptRef.current }]); interrupt() }}>Stop</button>
        </div>
      )}
      <div ref={scrollRef} className="r0-scroll" onScroll={onScroll}>
        {/* Only the scrollback is a live region: the redrawn stats frame and the echoed prompt are not announced. */}
        <div role="log" aria-label="Ring-0 output">
          <Scrollback rows={rows} prompt={prompt} />
        </div>
        {streams.map((v) => (
          <div key={v.id} data-streaming="">
            {v.thinking > 0 && !v.text && <div className="r0-line r0-sys">thinking… {v.thinking}</div>}
            {v.text && <div className="r0-line r0-out">{v.text}</div>}
            <div className="r0-line r0-sys">-- answering: ask stop to stop it --</div>
          </div>
        ))}
        {live && (
          <div>
            {live.map((t, i) => <div key={i} className="r0-line">{t}</div>)}
            <div className="r0-line r0-sys">-- live: q, Ctrl+C or Esc to stop --</div>
          </div>
        )}
        <div className="r0-line r0-prompt">
          {/* Visual mirror of the textarea (prompt, block cursor, selection); assistive tech reads the textarea itself. */}
          <span aria-hidden="true">
            <span className="r0-ps1">{prompt}</span>
            {show(value.slice(0, s0))}
            {cursor ? (
              <span key={`${value.length}:${s0}`} className="r0-cursor" data-idle={!focused || undefined}>{under === undefined || under === '\n' ? ' ' : under}</span>
            ) : (
              <span className="r0-sel">{show(value.slice(s0, s1))}</span>
            )}
            {show(rest)}
          </span>
          <textarea
            ref={inputRef}
            className="r0-input"
            style={{ left: `${prompt.length}ch`, width: `calc(100% - ${prompt.length}ch)` }}
            value={value}
            onChange={(e) => { setValue(e.currentTarget.value); syncSel(e) }}
            onKeyDown={onKeyDown}
            onKeyUp={syncSel}
            onSelect={syncSel}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            aria-label="Ring-0 command line"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            enterKeyHint="go"
            rows={1}
            maxLength={MAX_CHARS}
          />
        </div>
      </div>
    </div>
  )
}
