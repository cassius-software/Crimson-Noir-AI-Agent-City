// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Customer-facing output: an enterprise-grade HUD layered over the
 * canvas with pointer-events: none (so every click and mouse movement still reaches the head rig) —
 * frosted-glass panels that go dark after sunset, the brand mark and the visitor's name, a rotating radar
 * minimap, a speedometer with the posted limit, live signal state, quality tier and Ring-0 kernel
 * counters, the unified namespace's topic count (namespace.ts; the console reads the topics), the cinema camera's frame rate, shutter and ND beside the input rate, notifications, a REC chip
 * while the .agv recorder runs, the operator's pings (a ring on the minimap per ping and, for the newest, a
 * chip over the world with its distance), and glyph-aware control hints (the enter-vehicle prompt and, until
 * the player is under way, a small capture-and-controls chip) that switch silently to a controller's glyphs.
 * The operator's progression chip shows the level, XP, credits, hero points and the round's pips, what a fresh success
 * was and paid, and one soft ring for it (none under reduced motion); its words come finished in the snapshot.
 * Onboarding is zero-click: there is no title card; the Concierge (Concierge.tsx) greets the player.
 * On phones and touch devices (or any small window) it switches to a compact layout that keeps the
 * bottom corners free for the touch controls: stick bottom-left, buttons bottom-right. A phone held in
 * landscape is short, so there the panels spread across the top and the speedometer goes bottom-centre.
 * What breaks if it is removed? The player loses location, time, speed, signals and control hints.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { isOpen, phaseWord, pillLabel, pillWord, type MicMeter } from '../04_Connect_Hardware/microphone.ts'
import { CITY, CITY_SIZE, LAKE, districtOfLot } from '../01_Initialize_World/city.ts'
import { drawRooms, workplaces, type Workplace } from '../01_Initialize_World/interiors.ts'
import { drawShops, shops, type Shop } from '../01_Initialize_World/storefronts.ts'
import { DEED_BASE, drawHomes, type Home } from '../01_Initialize_World/properties.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import type { HudPing, HudProgress, Light, SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'
import { BRAND } from '../brand.ts'
import { MonolithLogo } from '../MonolithLogo.tsx'
import { controlHints, glyph, glyphKind, spokenGlyph, type ControlAction, type GlyphKind } from './glyphs.ts'
import { nextFootPeak, type FootPeak } from './footPeak.ts'
import { credits, itemById } from './storeCatalog.ts'

const LIGHT_COLOR: Record<Light, string> = { green: 'bg-emerald-400', amber: 'bg-amber-400', red: 'bg-rose-500' }
/** A ping's colour by what it asks, on the minimap and the chip. */
const PING_COLOR: Record<HudPing['kind'], string> = { go: '#f59e0b', look: '#0ea5e9', gather: '#a855f7', wait: '#94a3b8' }
const PING_WORD: Record<HudPing['kind'], string> = { go: 'go there', look: 'look there', gather: 'gather there', wait: 'wait there' }
const LIMIT_KMH = Math.round(TRAFFIC.speedLimit * 3.6)

/** Panels sit inside this frame: a fixed gap from the edges, or the safe-area inset where that is larger. */
const FRAME_WIDE =
  'absolute top-[max(1.25rem,env(safe-area-inset-top))] right-[max(1.25rem,env(safe-area-inset-right))] ' +
  'bottom-[max(1.25rem,env(safe-area-inset-bottom))] left-[max(1.25rem,env(safe-area-inset-left))]'
const FRAME_COMPACT =
  'absolute top-[max(0.75rem,env(safe-area-inset-top))] right-[max(0.75rem,env(safe-area-inset-right))] ' +
  'bottom-[max(0.75rem,env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))]'

/** Where the compact layout's panels end, for Sloane's chip (Concierge.tsx), which keeps clear of them:
 *  --hud-bottom is the height from the screen's top to the foot of the panels and the status chips under them
 *  (and of the toast, upright at the wheel), --hud-row-bottom to the foot of the header and readout
 *  alone, and --hud-right the width from the screen's left edge to the right edge of the header and readout's
 *  last line (a landscape phone sets them side by side, wrapping when narrow). Upright on foot the toasts make
 *  room for the chip instead: while it stands under the minimap it publishes its own foot as --chip-bottom, and
 *  they start below it. A ref callback, so it runs when the panels mount and cleans up when they go. */
function publishPanels(el: HTMLDivElement | null) {
  if (!el) return
  const root = document.documentElement.style
  const publish = () => {
    root.setProperty('--hud-bottom', `${Math.round(el.getBoundingClientRect().bottom)}px`)
    // Read afresh each time: on a short screen a toast swaps in for the readout (and is watched from then on).
    const row = Array.from(el.querySelector('[data-hud-row]')?.children ?? [])
    for (const p of row) watch?.observe(p)
    const rects = row.map((p) => p.getBoundingClientRect())
    const foot = Math.max(0, ...rects.map((r) => r.bottom))
    const right = Math.max(0, ...rects.filter((r) => r.bottom > foot - 1).map((r) => r.right))
    root.setProperty('--hud-row-bottom', `${Math.round(foot)}px`)
    root.setProperty('--hud-right', `${Math.round(right)}px`)
  }
  const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
  publish()
  watch?.observe(el)
  window.addEventListener('resize', publish)
  return () => {
    watch?.disconnect()
    window.removeEventListener('resize', publish)
    root.removeProperty('--hud-bottom')
    root.removeProperty('--hud-row-bottom')
    root.removeProperty('--hud-right')
  }
}

/** Where the compact layout's chips at the foot begin (the captions, the shop's chip, the speedometer of a phone held
 *  sideways at the wheel; with the HUD hidden, the captions alone), for the first walk's card (onboarding/FirstWalk.tsx),
 *  which stands above them between a sideways phone's thumbs: --hud-foot is the height from the screen's foot to the
 *  top of the stack, in window pixels. A ref callback on the stack, so it is published while the stack is on screen and
 *  taken away when it goes (React runs the old stack's cleanup before the new one's ref when H swaps them). */
let footPeak: FootPeak | null = null
/** Lets the latch go when the window changes size, before any stack republishes (installed once, ahead of theirs). */
let footSized = false
function sizeOf(): string { return `${window.innerWidth}x${window.innerHeight}` }
/** Also --hud-foot-peak (footPeak.ts): the highest foot since the window took its size, which the first walk's band
 *  reads to choose its place, so captions coming and going cannot flip it. */
function publishFoot(el: HTMLDivElement | null) {
  if (!el) return
  const root = document.documentElement.style
  if (!footSized) {
    footSized = true
    window.addEventListener('resize', () => {
      if (footPeak?.size === sizeOf()) return
      footPeak = null
      root.removeProperty('--hud-foot-peak')
    })
  }
  const publish = () => {
    const foot = Math.round(window.innerHeight - el.getBoundingClientRect().top)
    root.setProperty('--hud-foot', `${foot}px`)
    const next = nextFootPeak(footPeak, sizeOf(), foot)
    if (next !== footPeak) root.setProperty('--hud-foot-peak', `${next.peak}px`)
    footPeak = next
  }
  const watch = typeof ResizeObserver === 'function' ? new ResizeObserver(publish) : null
  publish()
  watch?.observe(el)
  window.addEventListener('resize', publish)
  return () => {
    watch?.disconnect()
    window.removeEventListener('resize', publish)
    root.removeProperty('--hud-foot')
  }
}

/** The capture chip steps aside once the player has covered this much ground: by then they know the controls
 *  (and Sloane's chip lists them all). */
const HINT_UNTIL_METRES = 30
/** The chip's second line: what the Concierge's three tips and the in-context prompt do not cover. */
const CHIP_FOOT: ReadonlySet<ControlAction> = new Set(['run', 'clock', 'console', 'hud'])
const CHIP_DRIVE: ReadonlySet<ControlAction> = new Set(['handbrake', 'reset', 'console', 'hud'])

/** A media query as a stable external store for useSyncExternalStore (one MediaQueryList, created lazily). */
function mediaStore(query: string) {
  let list: MediaQueryList | null = null
  const media = () => (list ??= window.matchMedia(query))
  return {
    subscribe(onChange: () => void) {
      const m = media()
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    matches: () => media().matches,
    server: () => false,
  }
}
/** Phone-sized viewport in either orientation; SHORT is a phone held in landscape. Concierge.tsx uses the
 *  same two queries. */
const SMALL = mediaStore('(max-width: 639px), (max-height: 499px)')
const SHORT = mediaStore('(max-height: 499px)')
/** The system asks for reduced motion: the progress chip's ring after a success stays still (its words still show). */
const CALM = mediaStore('(prefers-reduced-motion: reduce)')
/** Room for the capture chip's key row: one line between the minimap and the speed panel, and height left
 *  for the Concierge card above it. Smaller windows get the one-line chip (Sloane's list has every key). */
const ROOMY = { ...mediaStore('(min-width: 1100px) and (min-height: 600px)'), server: () => true }

export function Hud({ s, adapter, visible, terminalOpen = false, mapLayer = null, mic = null, onMic, highContrast = false, captionPx = 13, onBrowse, homes = null, onHome }: {
  s: SipocSnapshot | null
  adapter: string
  visible: boolean
  /** The Ring-0 terminal owns the keyboard (and has released pointer lock): hold back the capture hint. */
  terminalOpen?: boolean
  /** A region's minimap layer (engine.mapLayer): drawn instead of the procedural city's grid. */
  mapLayer?: MapLayer | null
  /** The microphone's meter (04_Connect_Hardware/microphone.ts), read at frame rate while the pill shows the device open; null without one. */
  mic?: MicMeter | null
  /** The pill's press: open the microphone, or mute it (the same switch as V, the right stick's click and the touch Menu). */
  onMic?: () => void
  /** High contrast in force (07_Execute_Actions/access.ts highContrast; index.css flattens the panels): the meter draws white. */
  highContrast?: boolean
  /** The caption strip's font size, CSS px (access.ts CAPTION_PX). */
  captionPx?: number
  /** Open the catalogue of the shop the avatar stands in (the chip's tap; E and B go through the engine). */
  onBrowse?: (index: number) => void
  /** The world's homes (engine.homes), for the procedural city's minimap; a region's map layer draws its own. */
  homes?: readonly Home[] | null
  /** Open the doorstep card of the home the avatar stands in, by its property index (the chip's tap; E and B go through the engine). */
  onHome?: (home: number) => void
}) {
  const small = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const short = useSyncExternalStore(SHORT.subscribe, SHORT.matches, SHORT.server)
  const roomy = useSyncExternalStore(ROOMY.subscribe, ROOMY.matches, ROOMY.server)
  if (!s) return null
  const c = s.customer
  const touch = s.supplier.touch
  const family = s.supplier.glyphs
  const compact = touch || small
  const dark = c.daylight < 0.35
  const glass = dark
    ? 'bg-slate-900/55 text-slate-50 border-white/10 shadow-[0_10px_40px_rgba(0,0,0,0.45)]'
    : 'bg-white/60 text-slate-900 border-white/70 shadow-[0_10px_40px_rgba(15,23,42,0.18)]'
  const panel = `rounded-2xl border backdrop-blur-xl backdrop-saturate-150 ${glass}`
  const muted = dark ? 'text-slate-300/80' : 'text-slate-500'
  const rule = dark ? 'border-white/10' : 'border-slate-900/10'
  const divider = `w-px self-stretch ${dark ? 'bg-white/15' : 'bg-slate-900/10'}`
  const driving = s.input.mode === 'vehicle'
  const q = s.quality
  const k = s.kernel
  const drawn = s.process.drawnNear + s.process.drawnFar
  const mapRing = dark ? 'border-slate-900/60' : 'border-white/80'
  const name = c.name

  // Touch devices get an Enter/Exit button from the touch controls instead of a prompt.
  const enterPrompt = s.input.nearVehicle && !touch && family !== 'touch' && (
    <div className={`flex items-center gap-2 px-4 py-2 ${panel}`}>
      <GlyphKey glyph={glyph('interact', family)} kind={glyphKind('interact', family)} /> <span>Enter vehicle</span>
    </div>
  )
  // Inside a storefront (storefronts.ts), on foot, its catalogue closed, the console shut: the shop's name and the way
  // in, a button a tap or a click opens. Its key is E (the pad's interact button), or B when a car in reach keeps E for
  // its door (a pad has no B: the chip itself is the way in then).
  const shop = c.shop
  const shopGlyph = touch || family === 'touch' ? null : !s.input.nearVehicle ? glyph('interact', family) : family === 'keyboard' ? 'B' : null
  const shopChip = shop && !shop.showroom && !driving && !terminalOpen && (
    <button type="button" onClick={() => onBrowse?.(shop.index)} className={`pointer-events-auto flex items-center gap-2 px-4 py-2 text-left ${panel}`} data-hint="shop">
      {shopGlyph && <><GlyphKey glyph={shopGlyph} kind={glyphKind('interact', family)} />{' '}</>}
      <span>Browse <bdi className="font-semibold">{shop.name}</bdi></span>
    </button>
  )
  // Inside a home (properties.ts), on foot, its card closed, the console shut: the home's deed for sale with its level
  // and price, or, in the player's own home, Furnish and its name; a button that opens its card (the furnishing view
  // for an owner, HomeCard.tsx, or the reason it waits); the key is the shop chip's.
  const home = c.home
  const deed = home ? itemById(DEED_BASE + home.index) : null
  const homeChip = home && !home.card && !driving && !terminalOpen && (
    <button type="button" onClick={() => onHome?.(home.index)} className={`pointer-events-auto flex items-center gap-2 px-4 py-2 text-left ${panel}`} data-hint="home" data-owned={home.owned || undefined}>
      {shopGlyph && <><GlyphKey glyph={shopGlyph} kind={glyphKind('interact', family)} />{' '}</>}
      {home.owned
        ? <span>Furnish <bdi className="font-semibold">{home.name}</bdi></span>
        : <span>For sale: <bdi className="font-semibold">{home.name}</bdi>{deed && ` · Level ${deed.level} · ${deed.price === 0 ? 'Free' : credits(deed.price)}`}</span>}
    </button>
  )
  // Desktop, mouse not captured, player not yet under way: how to look around, plus the controls the
  // Concierge's tips leave out. Never shown to controllers or touch, never over the centre of view.
  const moved = s.experience.distanceWalked + s.experience.distanceDriven
  const captureHint = family === 'keyboard' && !touch && !s.supplier.pointerLocked && !terminalOpen && moved < HINT_UNTIL_METRES
  const chipKeys = controlHints(family, driving, 'all').filter((h) => (driving ? CHIP_DRIVE : CHIP_FOOT).has(h.action))
  const captureChip = (withKeys: boolean) => (
    <div className={`max-w-full px-4 py-2.5 ${panel}`} data-hint="capture">
      <div className="flex items-center justify-center gap-2 text-[13px] font-medium">
        <MouseIcon />
        <span>Click to capture the mouse, or drag to look</span>
      </div>
      {withKeys && (
        <div className={`mt-2 flex flex-wrap items-center justify-center gap-x-3.5 gap-y-1.5 text-[11px] ${muted}`}>
          {chipKeys.map((h) => (
            <span key={h.action} className="flex items-center gap-1.5 whitespace-nowrap">
              <GlyphKey glyph={h.glyph} kind={h.kind} />{' '}
              {h.label}
            </span>
          ))}
        </div>
      )}
    </div>
  )
  const nameTag = name && (
    <span className={`ml-2 inline-block max-w-[9rem] truncate rounded-full border px-2 py-px align-[1px] text-[11px] font-medium tracking-normal ${dark ? 'border-white/20 text-slate-100' : 'border-slate-900/15 text-slate-700'}`}>
      <bdi>{name}</bdi>
    </span>
  )
  // Under the header while the local .agv recorder runs (recorder.ts): elapsed time, frames, source. It
  // outlives the H key: a capture (the camera above all) is never running without its indicator.
  const rec = s.supplier.recording
  const recChip = rec?.active && (
    <div className={`flex max-w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold tabular-nums ${panel}`} data-hint="rec">
      <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-rose-500" />
      <span className="truncate">REC {recClock(rec.seconds)} · {rec.frames.toLocaleString()} frames · {rec.source}</span>
    </div>
  )

  // The microphone's pill (microphone.ts): its state, a live meter while it is open, and the switch. While the HUD is
  // hidden it shows only with the device open: the browser's own indicator is never on without it (like REC).
  const voice = s.supplier.voice
  const micOpen = voice ? isOpen(voice.phase) : false
  // On a phone it shows only while the device is open, opening or could not open (the Menu's Microphone item is the
  // switch there), and not as a row of the panels' column but as a badge on the minimap's corner (MicBadge): with the
  // microphone open from the start it is up all the time, and a row under the readout pushed the panels into Sloane's
  // chip on the smallest screens at the wheel (the browser smoke's phone layouts, 320 x 568).
  const micNeeded = voice ? micOpen || voice.phase === 'opening' || voice.phase === 'blocked' || voice.phase === 'error' || voice.phase === 'unavailable' : false
  const micShown = voice && (micOpen || (visible && (!compact || micNeeded)))
  const micPill = micShown && <MicPill voice={voice} mic={mic} onMic={onMic} contrast={highContrast} panel={panel} muted={muted} dark={dark} />
  const micBadge = micShown && visible && compact && <MicBadge voice={voice} onMic={onMic} panel={panel} />
  // Recruitment: who is coming over, the Active swarm's skills and the activity line; then the team at work (Sloane's
  // for a goal, or the first walk's swarm), in one line (08_Swarm/team.ts). Without a host microphone (an older host,
  // no pill) the chip also carries the MIC dot, so an open microphone is never without its indicator (it outlives the H
  // key, like REC).
  const rc = s.supplier.recruiting
  const dotted = Boolean(rc?.listening) && !voice
  const team = s.supplier.team ?? ''
  const micChip = ((rc && (dotted || rc.line)) || team) && (
    <div className={`flex max-w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold tabular-nums ${panel}`} data-hint="mic">
      {dotted && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" />}
      <span className="truncate">{[dotted ? 'MIC · on-device' : '', rc?.line ?? '', team].filter(Boolean).join(' · ')}</span>
    </div>
  )

  // Closed captions of the soundscape (captions.ts, fed by the engine): every sound with its bearing and distance,
  // speech with its words. An accessibility surface, so it outlives the H key like the MIC and REC chips.
  const captions = c.captions
  const captionStrip = captions && captions.length > 0 && (
    <div role="status" aria-live="polite" className={`flex max-w-full flex-col items-center gap-1 px-4 py-2 font-medium ${panel}`} style={{ fontSize: `${captionPx}px` }} data-hint="captions">
      {captions.map((line, i) => (
        <div key={`${i}:${line}`} className="max-w-full truncate text-center">{line}</div>
      ))}
    </div>
  )

  // The newest ping, over the world where it landed (the engine projects it; off screen it is on the minimap alone):
  // what it asks, what it landed on, and how far it is.
  const newestPing = s.output.pings?.at(-1)
  const pingChip = newestPing && Number.isFinite(newestPing.sx) && Number.isFinite(newestPing.sy) && (
    <div
      className="absolute flex -translate-x-1/2 -translate-y-full flex-col items-center"
      style={{ left: `${(newestPing.sx * 100).toFixed(2)}%`, top: `${(newestPing.sy * 100).toFixed(2)}%`, opacity: Math.min(1, 0.35 + newestPing.left / 4) }}
      data-hint="ping"
    >
      <div className={`flex items-center gap-2 px-3 py-1.5 text-[11px] font-semibold tabular-nums whitespace-nowrap ${panel}`}>
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: PING_COLOR[newestPing.kind] }} />
        <span>{PING_WORD[newestPing.kind]} · {pingWhat(newestPing)} · {newestPing.distance.toFixed(0)} m</span>
      </div>
      <span className="h-3 w-px" style={{ background: PING_COLOR[newestPing.kind] }} />
    </div>
  )

  // Ghost view: the altered picture always says what it is (and how to leave it).
  const ghostChip = s.output.ghost && (
    <div className={`flex max-w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold ${panel}`} data-hint="ghost">
      <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
      <span className="truncate">GHOST VIEW · physics shapes · G to hide</span>
    </div>
  )

  // The operator's progression (progress.ts hudProgress; App puts the finished words on the snapshot): the standing,
  // and for a few seconds after a success what it was and what it paid. Game feedback, so it goes with the H key. On
  // a phone it shows only while a check is fresh and never on a short screen, so Sloane's chip under the column moves
  // only for those seconds.
  const pr = s.supplier.progress
  const progressChip = pr && (!compact || (pr.cue !== null && !short)) && <ProgressChip p={pr} panel={panel} muted={muted} />

  // Render off (the console's render knob): the black canvas says why, and how to draw again. It outlives the
  // H key like the recorder's chip: a blank screen is never left unexplained.
  const renderChip = s.output.rendering === false && (
    <div className={`flex max-w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold ${panel}`} data-hint="render">
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
      <span className="truncate">RENDER OFF · console only · render on</span>
    </div>
  )

  // Compact: the toasts stack under the header, so only as many as clear the touch stick below them
  // (one, on a single body line, on a short screen, where it stands in the readout's place). Upright on foot
  // they start below Sloane's chip; at the wheel the buttons reach across the screen, so they cannot run on
  // below it: one toast on a single body line stands under the panels, measured with them, and the chip below it.
  const tight = compact && short
  const stacked = compact && !short && driving
  const toasts = (compact ? s.toasts.slice(0, short || stacked ? 1 : 2) : s.toasts).map((t) => (
    <div key={t.id} className={`px-4 py-2.5 ${panel}`} data-hud="panel">
      <div className={`text-[13px] font-semibold ${tight || stacked ? 'truncate' : ''}`}>{t.title}</div>
      <div className={`text-xs ${muted} ${tight || stacked ? 'truncate' : ''}`}>{t.body}</div>
    </div>
  ))
  const speedChip = (
    <div className={`flex items-center gap-2.5 py-2 pr-2.5 pl-3.5 ${panel}`} data-hud="speed">
      <div className="text-right">
        <div className="text-2xl leading-none font-semibold tabular-nums tracking-tight">{c.speedKmh.toFixed(0)}</div>
        <div className={`mt-0.5 text-[10px] ${muted}`}>km/h · {c.gear}</div>
      </div>
      <LimitSign small />
    </div>
  )

  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 font-sans text-[13px] antialiased select-none">
      {/* The screen reader's line (announcer.ts): always in the page, so a reader follows it from the first word. */}
      <span className="sr-only" role="status" aria-live="polite" data-announce>{c.announce ?? ''}</span>
      {/* The microphone's state for a reader: here, not in the pill, which a phone or a hidden HUD leaves unmounted while
          the device is shut, so "muted" is heard wherever the switch was pressed (the Menu, V, R3). */}
      <span className="sr-only" role="status" aria-live="polite" data-mic-told>{voice ? micTold(voice.phase) : ''}</span>
      {visible && !compact && (
        <div className={FRAME_WIDE}>
          <div className="absolute top-0 left-0 flex flex-col items-start gap-2">
            <div className={`flex items-center gap-4 py-3 pr-5 pl-3.5 ${panel}`}>
              <MonolithLogo size={36} title="" />
              <div className="min-w-0">
                <div className="flex items-center text-[15px] font-semibold tracking-tight">{BRAND.name}{nameTag}</div>
                <div className={`text-xs ${muted}`}>{c.district}</div>
              </div>
              <div className={divider} />
              <div className="text-right">
                <div className="text-xl font-semibold tabular-nums tracking-tight">{c.clock}</div>
                <div className={`text-[11px] ${muted}`}>{skyLabel(c.daylight)}</div>
              </div>
            </div>
            {recChip}
            {micPill}
            {micChip}
            {ghostChip}
            {renderChip}
            {progressChip}
          </div>

          <div className={`absolute top-0 right-0 w-72 px-5 py-4 ${panel}`}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Kpi label="Population" value={s.process.pedestrians.toLocaleString()} muted={muted} />
              <Kpi label="Vehicles" value={s.process.vehicles} muted={muted} />
              <Kpi label="Waiting at lights" value={s.process.waiting.toLocaleString()} muted={muted} />
              <Kpi label="On crosswalks" value={s.process.crossing.toLocaleString()} muted={muted} />
              {/* The indoor workplaces (interiors.ts), the city's or a generated region's: who is at a workstation now. A surveyed region has none. */}
              {s.process.working !== undefined && <Kpi label="At work indoors" value={s.process.working.toLocaleString()} muted={muted} />}
            </div>
            {/* A surveyed region has no traffic signals: the shared cycle would mean nothing there. A street window's follow it. */}
            {(!c.region || c.streets) && (
              <div className={`mt-3 flex items-center justify-between border-t pt-3 text-[11px] ${rule} ${muted}`}>
                <div className="flex items-center gap-2">
                  <Signal label="E–W" light={c.signalEW} />
                  <Signal label="N–S" light={c.signalNS} />
                </div>
                <span className="tabular-nums">{c.signalRemaining.toFixed(0)}s</span>
              </div>
            )}
            {/* The quality column carries a label plus the Auto badge ("Medium Auto"), so it gets the room. */}
            <div className={`mt-3 grid grid-cols-[1.6fr_1fr_1fr] gap-x-2 border-t pt-3 ${rule}`}>
              <div className="min-w-0">
                <div className={`text-[11px] ${muted}`}>Quality</div>
                <div className="flex items-center gap-1.5 text-[13px] leading-tight font-semibold">
                  <span className="truncate">{q.label}</span>
                  {q.auto && <Badge dark={dark}>Auto</Badge>}
                </div>
              </div>
              <div className="min-w-0">
                <div className={`text-[11px] ${muted}`}>First Law</div>
                <div className="text-[13px] leading-tight font-semibold tabular-nums">
                  {k.law1.toLocaleString()} <span className={`text-[11px] font-normal ${muted}`}>holds</span>
                </div>
              </div>
              <div className="min-w-0">
                <div className={`text-[11px] ${muted}`}>Sensor flips</div>
                <div className="flex items-center gap-1.5 text-[13px] leading-tight font-semibold tabular-nums">
                  {k.sensorFlips.toLocaleString()}
                  {k.shielded && <span className="h-2 w-2 rounded-full bg-emerald-400" />}
                </div>
              </div>
            </div>
            {/* With the cinema camera the picture runs at 24 while input and physics keep the display's rate. */}
            {s.output.camera && <div className={`mt-3 text-[11px] tabular-nums ${muted}`}>{cameraLine(s.output.camera)}</div>}
            <div className={`${s.output.camera ? 'mt-0.5' : 'mt-3'} text-[11px] tabular-nums ${muted}`}>
              {s.output.camera ? `Input ${s.output.fps.toFixed(0)} Hz` : `${s.output.fps.toFixed(0)} fps`} · {s.output.frameMs.toFixed(1)} ms · {drawn.toLocaleString()} drawn · {s.process.safetyNudges} safety nudges
            </div>
            <div className={`mt-0.5 truncate text-[10px] ${muted}`}>{adapter}</div>
            {s.supplier.hal && <div className={`mt-0.5 truncate text-[10px] ${muted}`}>HAL · {s.supplier.hal}</div>}
            {s.supplier.xr.state !== 'unsupported' && s.supplier.xr.state !== 'off' && <div className={`mt-0.5 truncate text-[10px] ${muted}`}>Headset · {s.supplier.xr.detail}</div>}
            {s.supplier.robots !== undefined && s.supplier.robots.count > 0 && <div className={`mt-0.5 truncate text-[10px] ${muted}`}>Robots · {s.supplier.robots.detail}</div>}
          </div>

          <div className="absolute top-0 left-1/2 flex w-96 -translate-x-1/2 flex-col gap-2">{toasts}</div>

          <Minimap s={s} dark={dark} ui={1} layer={mapLayer} homes={homes} className={`absolute bottom-0 left-0 h-52 w-52 overflow-hidden rounded-full border-4 ${mapRing} shadow-[0_10px_40px_rgba(15,23,42,0.35)]`} />

          <div className={`absolute right-0 bottom-0 flex items-end gap-4 px-5 py-4 ${panel}`}>
            {driving ? (
              <>
                <div className="text-right">
                  <div className="text-5xl leading-none font-semibold tabular-nums tracking-tight">{c.speedKmh.toFixed(0)}</div>
                  <div className={`mt-1 text-xs ${muted}`}>km/h · {c.gear}</div>
                </div>
                <LimitSign small={false} />
              </>
            ) : (
              <div>
                <div className="text-sm font-semibold">On foot</div>
                <div className={`text-xs ${muted}`}>{(s.experience.distanceWalked / 1000).toFixed(2)} km walked · {(s.experience.distanceDriven / 1000).toFixed(2)} km driven</div>
              </div>
            )}
          </div>

          {(enterPrompt || shopChip || homeChip) && <div className="absolute bottom-20 left-1/2 flex -translate-x-1/2 flex-col items-center gap-2">{shopChip}{homeChip}{enterPrompt}</div>}
          {/* The captions above the enter prompt, clear of the minimap and the speed panel like the capture chip. */}
          {captionStrip && <div className="absolute bottom-32 left-1/2 w-max max-w-[calc(100%_-_34rem)] -translate-x-1/2">{captionStrip}</div>}
          {/* Clear of the minimap (13 rem) and the speed panel on either side. */}
          {captureHint && (
            <div className="absolute bottom-0 left-1/2 w-max max-w-[calc(100%_-_34rem)] -translate-x-1/2">{captureChip(roomy)}</div>
          )}
        </div>
      )}

      {visible && compact && (
        <div className={FRAME_COMPACT}>
          <div className="absolute top-0 left-0 flex max-w-[calc(100%_-_7.75rem)] flex-col items-start gap-2">
            <div ref={publishPanels} className="flex max-w-full flex-col items-start gap-2">
              {/* Landscape phone: header and readout side by side (wrapping if narrow), and a toast takes the
                  readout's place while it shows, so nothing reaches down to the touch stick or the buttons.
                  Otherwise `contents` keeps them in the column. */}
              <div className={short ? 'flex max-w-full flex-wrap items-start gap-2' : 'contents'} data-hud-row>
                <div className={`flex max-w-full items-center gap-2.5 py-2 pr-3.5 pl-2.5 ${panel}`} data-hud="panel">
                  <MonolithLogo size={28} title="" />
                  <div className="min-w-0">
                    <div className="flex min-w-0 items-center text-[14px] leading-tight font-semibold tracking-tight"><span className="shrink-0 whitespace-nowrap">{BRAND.short}</span>{nameTag}</div>
                    <div className={`truncate text-[11px] ${muted}`}>{c.district}</div>
                  </div>
                  <div className={divider} />
                  <div className="text-[15px] font-semibold tabular-nums tracking-tight">{c.clock}</div>
                </div>
                {/* On a short screen the readout keeps to three lines and 12 rem, so it stays beside the header and
                    above Sloane's chip: a device line (a paired pad) takes the First Law line's place. */}
                {tight && toasts.length > 0 ? <div className="flex w-48 max-w-full flex-col gap-2">{toasts}</div> : (
                  <div className={`${tight ? 'max-w-[min(100%,12rem)]' : 'max-w-full'} px-3 py-2 text-[11px] ${panel}`} data-hud="panel">
                    {(!c.region || c.streets) && (
                      <div className="flex items-center gap-2">
                        <Signal label="E–W" light={c.signalEW} />
                        <Signal label="N–S" light={c.signalNS} />
                        <span className={`tabular-nums ${muted}`}>{c.signalRemaining.toFixed(0)}s</span>
                      </div>
                    )}
                    <div className={`mt-1 truncate tabular-nums ${muted}`}>
                      {s.output.camera ? `${s.output.camera.fps.toFixed(0)} fps · ${s.output.fps.toFixed(0)} Hz` : `${s.output.fps.toFixed(0)} fps`} · {q.label}{q.auto ? ' · auto' : ''}
                    </div>
                    {!(tight && s.supplier.hal) && (
                      <div className={`truncate tabular-nums ${muted}`}>
                        First Law {k.law1.toLocaleString()} · {k.sensorFlips.toLocaleString()} flips
                      </div>
                    )}
                    {s.supplier.hal && <div className={`truncate ${muted}`}>{s.supplier.hal}</div>}
                    {/* The unified namespace (namespace.ts): how many topics the bus retains. Not on a phone: upright at the
                        wheel the readout's foot already meets Sloane's chip where it must end above the touch buttons
                        (Concierge.tsx CHIP_TOP), and a short screen has three lines; the console's `topic` has the count. */}
                    {!compact && s.output.topics && (
                      <div className={`truncate tabular-nums ${muted}`} data-hud="topics">
                        namespace {s.output.topics.count.toLocaleString()} topics
                      </div>
                    )}
                  </div>
                )}
              </div>
              {recChip}
              {micChip}
              {ghostChip}
              {renderChip}
              {progressChip}
              {stacked && <div className="flex w-68 max-w-full flex-col gap-2">{toasts}</div>}
            </div>
            {!stacked && !short && <div className="mt-[max(0px,calc(var(--chip-bottom,0px)_-_var(--hud-bottom,0px)_/_var(--ui-zoom,1)))] flex w-68 max-w-full flex-col gap-2">{toasts}</div>}
          </div>

          <div className="absolute top-0 right-0 flex flex-col items-end gap-2" data-hud="minimap">
            {/* The microphone's badge stands in the minimap's lower-left corner, inside its box, so it moves nothing. */}
            <div className="relative">
              <Minimap s={s} dark={dark} ui={208 / 112} layer={mapLayer} homes={homes} className={`h-28 w-28 overflow-hidden rounded-full border-2 ${mapRing} shadow-[0_8px_24px_rgba(15,23,42,0.3)]`} />
              {micBadge && <div className="absolute bottom-0 left-0">{micBadge}</div>}
            </div>
            {driving && !short && speedChip}
          </div>

          {/* Bottom-centre, between the thumbs: the capture hint (a small desktop window), the enter
              prompt, and — on a phone held in landscape, where browser bars take 30-60 px of its height
              and the speedometer under the minimap would reach the driving buttons — the speedometer. */}
          {(captureHint || enterPrompt || shopChip || homeChip || (driving && short) || captionStrip) && (
            <div ref={publishFoot} className="absolute bottom-0 left-1/2 flex max-w-full -translate-x-1/2 flex-col items-center gap-2" data-hud="foot">
              {captionStrip}
              {captureHint && captureChip(false)}
              {shopChip}
              {homeChip}
              {enterPrompt}
              {driving && short && speedChip}
            </div>
          )}
        </div>
      )}

      {visible && pingChip}

      {!visible && (recChip || micPill || rc?.listening || captionStrip) && (
        <div className={compact ? FRAME_COMPACT : FRAME_WIDE}>
          <div className="absolute top-0 left-0 flex max-w-full flex-col items-start gap-2">
            {recChip}
            {micPill}
            {rc?.listening && micChip}
          </div>
          {captionStrip && <div ref={publishFoot} className="absolute bottom-0 left-1/2 w-max max-w-full -translate-x-1/2" data-hud="foot">{captionStrip}</div>}
        </div>
      )}

      {!visible && renderChip && (
        <div className={compact ? FRAME_COMPACT : FRAME_WIDE}>
          <div className="absolute top-0 left-1/2 max-w-full -translate-x-1/2">{renderChip}</div>
        </div>
      )}
    </div>
  )
}

/**
 * The microphone's pill (04_Connect_Hardware/microphone.ts): a button with the state's word and colour, a live meter
 * of the room while the device is open, and an accessible name that says the state, what a press does and the key.
 * The meter is drawn at frame rate from the microphone's own ring of levels, outside React; the word comes with the
 * snapshot. A live region beside it tells a screen reader of a change of state (listening, muted, blocked), not of
 * every onset of speech nor of Sloane speaking: those are the meter's news.
 */
function MicPill({ voice, mic, onMic, contrast, panel, muted, dark }: {
  voice: NonNullable<SipocSnapshot['supplier']['voice']>; mic: MicMeter | null; onMic?: () => void; contrast: boolean; panel: string; muted: string; dark: boolean
}) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const open = isOpen(voice.phase)
  useEffect(() => {
    const el = canvas.current
    if (!el || !mic || !open) return
    const ctx = el.getContext('2d')
    if (!ctx) return
    let raf = 0
    const draw = () => {
      const w = el.width, h = el.height, n = mic.levels.length, bar = w / n
      ctx.clearRect(0, 0, w, h)
      ctx.fillStyle = contrast ? '#fff' : dark ? 'rgba(255,255,255,0.85)' : 'rgba(15,23,42,0.8)'
      for (let i = 0; i < n; i++) {
        // The square root lifts a quiet room into view; a full level fills the height.
        const v = mic.levels[(mic.head + i) % n]
        const bh = Math.max(1, Math.min(h, Math.sqrt(v > 0 ? v : 0) * h))
        ctx.fillRect(i * bar, (h - bh) / 2, Math.max(1, bar - 1), bh)
      }
      raf = requestAnimationFrame(draw)
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [mic, open, dark, contrast])
  const failed = voice.phase === 'blocked' || voice.phase === 'error' || voice.phase === 'unavailable'
  const dot = voice.phase === 'speech' ? 'bg-emerald-400' : open && voice.speaking ? 'bg-amber-400' : open ? 'bg-sky-500' : failed ? 'bg-rose-500' : dark ? 'bg-slate-400' : 'bg-slate-500'
  return (
    <button
      type="button"
      onClick={onMic}
      aria-label={pillLabel(voice.phase, voice.speaking, failed ? voice.detail : '')}
      aria-pressed={open}
      title={voice.detail || undefined}
      className={`pointer-events-auto flex max-w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[11px] font-semibold tabular-nums focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${panel}`}
      data-hint="voice"
      data-mic={voice.phase}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot} ${voice.phase === 'speech' ? 'animate-pulse' : ''}`} />
      <span className="truncate">{pillWord(voice.phase, voice.speaking)}</span>
      {open && <canvas ref={canvas} width={96} height={20} className="h-3.5 w-12 shrink-0" aria-hidden="true" />}
      {open && voice.words && <span className={`truncate font-medium ${muted}`}>words on-device</span>}
    </button>
  )
}

/**
 * The microphone's pill on a phone (and in any compact window): a round badge, 28 px, on the minimap's lower-left
 * corner, so it takes no row of the panels' column. A microphone glyph, struck through when the device could not open,
 * and the pill's coloured dot at its shoulder (green while it hears speech, amber while Sloane speaks, blue while it
 * listens, red when it could not open); no meter. A tap does what the pill's does, and its accessible name is the pill's.
 */
function MicBadge({ voice, onMic, panel }: {
  voice: NonNullable<SipocSnapshot['supplier']['voice']>; onMic?: () => void; panel: string
}) {
  const open = isOpen(voice.phase)
  const failed = voice.phase === 'blocked' || voice.phase === 'error' || voice.phase === 'unavailable'
  const dot = voice.phase === 'speech' ? 'bg-emerald-400' : open && voice.speaking ? 'bg-amber-400' : open ? 'bg-sky-500' : failed ? 'bg-rose-500' : 'bg-slate-400'
  return (
    <button
      type="button"
      onClick={onMic}
      aria-label={pillLabel(voice.phase, voice.speaking, failed ? voice.detail : '')}
      aria-pressed={open}
      title={voice.detail || undefined}
      className={`pointer-events-auto relative flex h-7 w-7 cursor-pointer items-center justify-center focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400 ${panel}`}
      data-hint="voice"
      data-mic={voice.phase}
    >
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true">
        <rect x="5.5" y="1.5" width="5" height="8.5" rx="2.5" />
        <path d="M3 8a5 5 0 0 0 10 0M8 13v1.75" />
        {failed && <path d="M2.5 2.5l11 11" />}
      </svg>
      <span className={`absolute top-0 right-0 h-2 w-2 rounded-full ${dot} ${voice.phase === 'speech' ? 'animate-pulse' : ''}`} />
    </button>
  )
}

/** The reader's line for the microphone: the state without speech onsets (speech reads as listening) or Sloane's turns. */
function micTold(phase: NonNullable<SipocSnapshot['supplier']['voice']>['phase']): string {
  return `Microphone ${phaseWord(phase === 'speech' ? 'listening' : phase).replace(/^Mic /, '').toLowerCase()}`
}

/** What a ping landed on: 'a spot', 'person 12', 'car 3', 'pole 7'. */
function pingWhat(p: HudPing): string {
  return p.pick === 'point' ? 'a spot' : `${p.pick} ${p.index}`
}

function skyLabel(daylight: number): string {
  return daylight > 0.5 ? 'Clear' : daylight > 0.05 ? 'Twilight' : 'Night'
}

/** The cinema camera's line: presented frames, the shutter (while the post chain runs), the ND as optical density. */
function cameraLine(cam: NonNullable<SipocSnapshot['output']['camera']>): string {
  const shutter = cam.shutterS > 0 ? ` · 1/${Math.round(1 / cam.shutterS)} s shutter` : ''
  return `Camera ${cam.fps.toFixed(0)} fps${shutter} · ND ${(cam.ndStops * Math.log10(2)).toFixed(2)}`
}

/** Elapsed recording time as mm:ss. */
function recClock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

function Kpi({ label, value, muted }: { label: string; value: string | number; muted: string }) {
  return (
    <div>
      <div className={`text-[11px] ${muted}`}>{label}</div>
      <div className="text-lg leading-tight font-semibold tabular-nums tracking-tight">{value}</div>
    </div>
  )
}

function Signal({ label, light }: { label: string; light: Light }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2.5 w-2.5 rounded-full ${LIGHT_COLOR[light]}`} />
      {label}
      <span className="sr-only">{` ${light}`}</span>
    </span>
  )
}

function Badge({ dark, children }: { dark: boolean; children: string }) {
  const tone = dark ? 'border-white/20 text-slate-200' : 'border-slate-900/15 text-slate-600'
  return <span className={`rounded border px-1 py-px text-[9px] leading-none font-semibold tracking-wide uppercase ${tone}`}>{children}</span>
}

/** The progress chip's ring: how long it shows, the least time between two, and how young a check must be to show it
 *  at all, so a chip mounted again (the H key, a layout swap) never replays an older check. */
const GLOW_MS = 600
const GLOW_GAP_MS = 1000
const GLOW_FRESH_MS = 300
/** When the ring last showed (performance.now() ms), shared by both layouts' chips. */
let glowedAt = -Infinity

/**
 * The operator's progression: the standing on one line and, while a success is fresh, what it was and paid on a second.
 * A screen reader reads it in full words (the label) as plain text beside the symbols it hides, as GlyphKey does,
 * because a name on a container whose content is all hidden is skipped by some readers' browse modes. Never a live
 * region, so the round refilling is not read aloud; the chime's caption already says a check happened. A success
 * brings one soft ring (a warmer one for a critical success, which the words also say): opacity alone, once, at most
 * once a second, and none under reduced motion.
 */
function ProgressChip({ p, panel, muted }: { p: HudProgress; panel: string; muted: string }) {
  const ring = useRef<HTMLSpanElement>(null)
  const cueAt = p.cueAt
  const young = p.cueAge <= GLOW_FRESH_MS
  useEffect(() => {
    const el = ring.current
    if (!el || cueAt < 0 || !young || CALM.matches()) return
    const now = performance.now()
    if (now - glowedAt < GLOW_GAP_MS) return
    glowedAt = now
    // Never cancelled: a ring still fading when the next check comes finishes its fade (it is short and holds no fill),
    // and the gap above decides whether a new one starts, so a soft ring never ends in a cut.
    el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }], { duration: GLOW_MS, easing: 'ease-out' })
    // Keyed on the check alone: the age only gates the first render that sees it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cueAt])
  return (
    <div className={`relative flex max-w-full flex-col items-start px-3 py-1.5 text-[11px] font-semibold tabular-nums ${panel}`} data-hint="progress">
      <span ref={ring} aria-hidden className={`pointer-events-none absolute -inset-px rounded-2xl opacity-0 ring-2 ${p.cue === 'critical' ? 'ring-amber-300/80' : 'ring-sky-300/70'}`} />
      <span aria-hidden className="flex max-w-full items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full bg-violet-400" />
        <span className="truncate">{p.text}</span>
      </span>
      {p.cue && <span aria-hidden className={`max-w-full truncate pl-4 font-medium ${muted}`}>{p.delta ? `${p.cueText} · ${p.delta}` : p.cueText}</span>}
      <span className="sr-only">{p.label}</span>
    </div>
  )
}

/** Posted-limit sign (white regulatory plate). */
function LimitSign({ small }: { small: boolean }) {
  return (
    <div className={`flex flex-col items-center justify-center rounded-md border-2 border-slate-900 bg-white text-slate-900 ${small ? 'h-10 w-8' : 'h-14 w-11'}`}>
      <div className={`${small ? 'text-[5px]' : 'text-[7px]'} leading-none font-bold`}>MAXIMUM</div>
      <div className={`${small ? 'text-sm' : 'text-lg'} leading-none font-bold`}>{LIMIT_KMH}</div>
    </div>
  )
}

const GLYPH_SHAPE: Record<GlyphKind, string> = {
  key: 'min-w-[22px] rounded-md border border-slate-400/60 px-1.5',
  button: 'w-[22px] rounded-full border border-slate-400/60',
  stick: 'w-[22px] rounded-full border-2 border-slate-500/70',
  pill: 'rounded-full border border-slate-400/60 px-2',
}

/** Shapes that some platforms (Windows) draw as colour emoji unless asked for text presentation (U+FE0E). */
const EMOJI_CAPABLE = /[◀▶▲△○✕□]/gu

/** A control glyph drawn like the thing it names: keycap, round face button, stick, or text pill. Shared
 *  with the Concierge. Shapes are spelled out for screen readers ("✕" reads as "Cross"). */
export function GlyphKey({ glyph: g, kind }: { glyph: string; kind: GlyphKind }) {
  const spoken = spokenGlyph(g)
  return (
    <kbd className={`inline-flex h-[22px] shrink-0 items-center justify-center bg-white/85 font-sans text-[11px] leading-none font-semibold whitespace-nowrap text-slate-800 ${GLYPH_SHAPE[kind]}`}>
      {spoken === g ? g : (
        <>
          <span aria-hidden>{g.replace(EMOJI_CAPABLE, '$&\uFE0E')}</span>
          <span className="sr-only">{spoken}</span>
        </>
      )}
    </kbd>
  )
}

function MouseIcon() {
  return (
    <svg width="14" height="18" viewBox="0 0 14 18" fill="none" aria-hidden className="shrink-0 opacity-70">
      <rect x="1" y="1" width="12" height="16" rx="6" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7 4v3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

/** The procedural city's map around (x, z): the lake, the lots and parks, the street grid. */
/** The seed's workplaces, for the minimap (interiors.ts is pure and seeded: the same sixteen the city hollowed). */
let roomsFor: { seed: number; rooms: readonly Workplace[] } | null = null
function roomsOf(seed: number): readonly Workplace[] {
  if (roomsFor?.seed !== seed) roomsFor = { seed, rooms: workplaces(seed) }
  return roomsFor.rooms
}

/** The city's storefronts for a seed, kept like its rooms (storefronts.ts is pure, but there is no need to redo it each frame). */
let shopsFor: { seed: number; shops: readonly Shop[] } | null = null
function shopsOf(seed: number): readonly Shop[] {
  if (shopsFor?.seed !== seed) shopsFor = { seed, shops: shops(seed) }
  return shopsFor.shops
}

function cityMap(ctx: CanvasRenderingContext2D, x: number, z: number, dark: boolean, seed?: number, homes: readonly Home[] | null = null, owned = 0): void {
  const { pitch, lotHalf, roadHalf } = CITY
  // The lake beyond the seawall.
  ctx.fillStyle = dark ? '#0c2a3a' : '#9cc9dd'
  ctx.fillRect(x - 200, LAKE.shore, 400, 400)
  // Built lots, and the parks.
  for (let k = -1; k <= CITY.blocks; k++) {
    for (let m = -1; m <= CITY.blocks; m++) {
      const cx = (k + 0.5) * pitch, cz = (m + 0.5) * pitch
      if (Math.abs(cx - x) > 150 || Math.abs(cz - z) > 150) continue
      const d = districtOfLot(k, m)
      if (d === 'shore') continue
      ctx.fillStyle = d === 'park' ? (dark ? '#14532d' : '#b7d8a6') : dark ? '#1e293b' : '#cfd3d9'
      ctx.beginPath()
      ctx.roundRect(cx - lotHalf, cz - lotHalf, lotHalf * 2, lotHalf * 2, 2)
      ctx.fill()
    }
  }
  // The indoor workplaces: the lot drawn as a room with the doorway open on its street front (interiors.ts drawRooms,
  // which a region's map layer draws its rooms with too).
  if (seed !== undefined) drawRooms(ctx, roomsOf(seed), x, z, dark)
  // The storefronts, the same way in the shops' own colour (storefronts.ts drawShops).
  if (seed !== undefined) drawShops(ctx, shopsOf(seed), x, z, dark)
  // The homes, the same way: the player's own in gold, the rest (on sale) in violet (properties.ts drawHomes).
  if (homes) drawHomes(ctx, homes, x, z, dark, owned)
  // Roads.
  ctx.fillStyle = dark ? '#334155' : '#ffffff'
  for (let i = 0; i <= CITY.blocks; i++) {
    ctx.fillRect(i * pitch - roadHalf, -10, roadHalf * 2, CITY_SIZE + 20)
    ctx.fillRect(-10, i * pitch - roadHalf, CITY_SIZE + 20, roadHalf * 2)
  }
}

/** Draws a region's map around (x, z) within a radius, on a context already in the engine's metres. */
export type MapLayer = (ctx: CanvasRenderingContext2D, x: number, z: number, radius: number, dark: boolean) => void

/**
 * Radar minimap, heading-up: rotated so the view direction points to the top. The canvas is always
 * 208 px; `ui` scales the arrow and the north marker so they stay legible when CSS shows it smaller.
 */
function Minimap({ s, dark, ui, className, layer = null, homes = null }: { s: SipocSnapshot; dark: boolean; ui: number; className: string; layer?: MapLayer | null; homes?: readonly Home[] | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const size = canvas.width
    const scale = size / 190 // pixels per metre: ~95 m radius
    const { x, z, viewYaw } = s.customer
    ctx.save()
    ctx.fillStyle = dark ? '#0f172a' : '#e7e9ec'
    ctx.fillRect(0, 0, size, size)
    ctx.translate(size / 2, size / 2)
    // Rotate so the camera's forward (-sin yaw, -cos yaw) points to the top of the map.
    ctx.rotate(viewYaw)
    ctx.scale(scale, scale)
    ctx.translate(-x, -z)
    if (layer) layer(ctx, x, z, 150, dark)
    else cityMap(ctx, x, z, dark, s.process.seed, homes, s.customer.ownedHomes ?? 0)
    // Vehicles.
    for (const car of s.map) {
      if (Math.abs(car.x - x) > 150 || Math.abs(car.z - z) > 150) continue
      ctx.save()
      ctx.translate(car.x, car.z)
      ctx.rotate(-car.heading)
      // Yours in blue; a parked car (nobody at its wheel: one you may take) in green; traffic in grey.
      ctx.fillStyle = car.player ? '#2563eb' : car.parked ? '#16a34a' : dark ? '#94a3b8' : '#64748b'
      ctx.beginPath()
      ctx.roundRect(-0.95, -2.3, 1.9, 4.6, 0.6)
      ctx.fill()
      ctx.restore()
    }
    // The operator's pings: a ring per mark, its colour by what it asks, fading over its last seconds.
    for (const p of s.output.pings ?? []) {
      if (Math.abs(p.x - x) > 150 || Math.abs(p.z - z) > 150) continue
      ctx.save()
      ctx.globalAlpha = Math.max(0.25, Math.min(1, p.left / 3))
      ctx.strokeStyle = PING_COLOR[p.kind]
      ctx.fillStyle = PING_COLOR[p.kind]
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.arc(p.x, p.z, 3.2, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(p.x, p.z, 1.1, 0, Math.PI * 2)
      ctx.fill()
      ctx.restore()
    }
    ctx.restore()
    // Player arrow (points along the avatar's or car's heading relative to the view).
    ctx.save()
    ctx.translate(size / 2, size / 2)
    ctx.rotate(viewYaw - s.customer.heading + Math.PI)
    ctx.scale(ui, ui)
    ctx.fillStyle = '#2563eb'
    ctx.strokeStyle = '#ffffff'
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(0, -9)
    ctx.lineTo(7, 7)
    ctx.lineTo(0, 3)
    ctx.lineTo(-7, 7)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
    ctx.restore()
    // North marker on the rim.
    ctx.save()
    ctx.translate(size / 2, size / 2)
    ctx.rotate(viewYaw)
    ctx.fillStyle = dark ? '#e2e8f0' : '#0f172a'
    ctx.font = `600 ${Math.round(13 * ui)}px system-ui, sans-serif`
    ctx.textAlign = 'center'
    ctx.fillText('N', 0, -size / 2 + 18 * ui)
    ctx.restore()
  }, [s, dark, ui, layer, homes])
  return <canvas ref={ref} width={208} height={208} className={className} />
}
