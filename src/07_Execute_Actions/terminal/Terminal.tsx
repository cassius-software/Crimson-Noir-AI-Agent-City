// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Ring-0 developer terminal: a drop-down console on the
 * backquote/tilde key with the look of a raw root shell (ash prompt, block cursor, monospace). It reads
 * and tunes the city only through the TerminalBridge; while it is open it owns the keyboard, so no
 * keystroke typed here reaches the game. The prompt is a multi-line buffer (Shift+Enter adds a line
 * under a `…` continuation prompt) so operator scripts can be typed in place.
 * A local model's answer (`ask`) streams in live under the scrollback until its final lines replace it.
 * With `fullscreen` (Track B, ?boot=tty) it is the whole page instead: open from the first render, full height,
 * black, and no key closes it; a `boot` result is handed to the host (onBoot), which reloads on that track.
 * One R0 machine (`r0`, repl.ts) lives for the life of the console, so definitions outlive a line; a typed key or
 * token never enters the history as typed (redactForHistory).
 * What breaks if it is removed? Operators lose the live Rapier3D / crowd / kernel readout, the quality,
 * clock, audio and hardware-pairing controls, and the operator tier's scripts, answers and harnesses.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type SyntheticEvent } from 'react'
import { BRAND } from '../../brand.ts'
import { offlineBridge, type TerminalBridge } from './bridge.ts'
import { commonPrefix, complete, continuationPrompt, formatStats, isToggleKey, motd, recallsHistory, redactForHistory, replSession, run, type Line, type ReplSession } from './commands.ts'

const MAX_ROWS = 600
const MAX_HISTORY = 200
const LIVE_MS = 250
/** Stick to the bottom while the view is within this many pixels of it. */
const STICK_PX = 32
/** Longest entry: scripts can be long. */
const MAX_CHARS = 8192
const OFFLINE = offlineBridge(BRAND)

interface Row extends Line { id: number }

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
.r0-root[data-full]{height:100%;min-height:0;transform:none;visibility:visible;pointer-events:auto;border-bottom:0;background:#000;transition:none}
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
        <div key={r.id} className={`r0-line r0-${r.kind}`}>{r.kind === 'cmd' ? prompt + r.text.replace(/\n/g, `\n${cont}`) : r.text}</div>
      ))}
    </>
  )
})

export function Terminal({ bridge, onOpenChange, fullscreen = false, onBoot }: {
  bridge: TerminalBridge | null
  onOpenChange(open: boolean): void
  /** Track B: the console is the whole page, open from the start; the toggle key and Esc never close it. */
  fullscreen?: boolean
  /** A `boot gui|tty` result: the host reloads the page on that track. */
  onBoot?(track: 'gui' | 'tty'): void
}) {
  const [open, setOpen] = useState(fullscreen)
  const [rows, setRows] = useState<Row[]>(() => motd((bridge ?? OFFLINE).brand).map((l, i) => ({ ...l, id: -1 - i })))
  const [value, setValue] = useState('')
  const [sel, setSel] = useState<readonly [number, number]>([0, 0])
  const [focused, setFocused] = useState(false)
  /** The current `stats` frame while a live view runs, else null. */
  const [live, setLive] = useState<readonly string[] | null>(null)
  /** Answers streaming in (`ask`), shown live under the scrollback until their final lines replace them. */
  const [streams, setStreams] = useState<readonly Streaming[]>([])

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
  const openRef = useRef(false)
  const reported = useRef(false)
  const mounted = useRef(true)
  const bridgeRef = useRef(bridge)
  const onOpenChangeRef = useRef(onOpenChange)
  const fullRef = useRef(fullscreen)
  /** The console's R0 machine (commands.ts `r0`), made on the first line that needs it. */
  const session = useRef<ReplSession | null>(null)

  useEffect(() => {
    bridgeRef.current = bridge
    onOpenChangeRef.current = onOpenChange
    fullRef.current = fullscreen
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

  const append = useCallback((lines: readonly Line[]) => {
    if (!lines.length) return
    setRows((prev) => {
      const next = prev.concat(lines.map((l) => ({ kind: l.kind, text: l.text, id: nextId.current++ })))
      return next.length > MAX_ROWS ? next.slice(next.length - MAX_ROWS) : next
    })
  }, [])

  /** Ends a live view, leaving its last frame in the scrollback. */
  const stopLive = useCallback(() => {
    const frame = liveFrame.current
    if (!frame) return
    liveFrame.current = null
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

  // Live `stats`: redraw in place ~4×/s while open. Paused (not ended) while the console is hidden.
  const isLive = live !== null
  useEffect(() => {
    if (!open || !isLive) return
    const id = window.setInterval(() => {
      try {
        const frame = formatStats((bridgeRef.current ?? OFFLINE).stats())
        liveFrame.current = frame
        setLive(frame)
      } catch (e) {
        stopLive()
        append([{ kind: 'err', text: `stats: ${message(e)}` }])
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

  const submit = (raw: string) => {
    const line = raw.trim()
    if (!line && liveFrame.current) return // a blank Enter does not end a live view
    stopLive()
    // Runs synchronously inside the keydown: `hal pair` needs the user activation to open a device picker.
    const r = run(line, bridge ?? OFFLINE, history.current, (session.current ??= replSession()))
    const h = history.current
    // A key or a token typed on the line is kept as dots, never as typed.
    const kept = redactForHistory(line)
    if (kept && h[h.length - 1] !== kept) {
      h.push(kept)
      if (h.length > MAX_HISTORY) h.splice(0, h.length - MAX_HISTORY)
    }
    histPos.current = h.length
    draft.current = ''
    setLine('')
    stick.current = true
    if (r.clear) setRows([])
    else append([{ kind: 'cmd', text: line }, ...(r.live ? [] : r.lines)])
    if (r.live) {
      liveFrame.current = r.lines.map((l) => l.text)
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
  }

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
        append([{ kind: 'cmd', text: `${el.value}^C` }])
        histPos.current = history.current.length
        setLine('')
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
      const options = complete(el.value)
      if (options.length === 1) setLine(`${options[0]} `)
      else if (options.length > 1) {
        const common = commonPrefix(options)
        if (common.length > el.value.length) setLine(common)
        else {
          stick.current = true
          append([{ kind: 'cmd', text: el.value }, { kind: 'out', text: options.map((o) => o.slice(o.lastIndexOf(' ') + 1)).join('  ') }])
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
  const prompt = `${b.brand.host}:~# `
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
