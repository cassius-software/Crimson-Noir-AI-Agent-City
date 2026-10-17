// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the Customer-facing output: an enterprise-grade HUD layered over the
 * canvas with pointer-events: none (so every click and mouse movement still reaches the head rig) —
 * frosted-glass panels that go dark after sunset, the brand mark and the visitor's name, a rotating radar
 * minimap, a speedometer with the posted limit, live signal state, quality tier and Ring-0 kernel
 * counters, the cinema camera's frame rate, shutter and ND beside the input rate, notifications, a REC chip
 * while the .agv recorder runs, the operator's pings (a ring on the minimap per ping and, for the newest, a
 * chip over the world with its distance), and glyph-aware control hints (the enter-vehicle prompt and, until
 * the player is under way, a small capture-and-controls chip) that switch silently to a controller's glyphs.
 * Onboarding is zero-click: there is no title card; the Concierge (Concierge.tsx) greets the player.
 * On phones and touch devices (or any small window) it switches to a compact layout that keeps the
 * bottom corners free for the touch controls: stick bottom-left, buttons bottom-right. A phone held in
 * landscape is short, so there the panels spread across the top and the speedometer goes bottom-centre.
 * What breaks if it is removed? The player loses location, time, speed, signals and control hints.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react'
import { CITY, CITY_SIZE, LAKE, districtOfLot } from '../01_Initialize_World/city.ts'
import { ROOM, doorDir, workplaces, type Workplace } from '../01_Initialize_World/interiors.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'
import type { HudPing, Light, SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'
import { BRAND } from '../brand.ts'
import { MonolithLogo } from '../MonolithLogo.tsx'
import { controlHints, glyph, glyphKind, spokenGlyph, type ControlAction, type GlyphKind } from './glyphs.ts'

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
/** Room for the capture chip's key row: one line between the minimap and the speed panel, and height left
 *  for the Concierge card above it. Smaller windows get the one-line chip (Sloane's list has every key). */
const ROOMY = { ...mediaStore('(min-width: 1100px) and (min-height: 600px)'), server: () => true }

export function Hud({ s, adapter, visible, terminalOpen = false, mapLayer = null }: {
  s: SipocSnapshot | null
  adapter: string
  visible: boolean
  /** The Ring-0 terminal owns the keyboard (and has released pointer lock): hold back the capture hint. */
  terminalOpen?: boolean
  /** A region's minimap layer (engine.mapLayer): drawn instead of the procedural city's grid. */
  mapLayer?: MapLayer | null
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

  // Recruitment: an open microphone is never without its indicator (it outlives the H key, like REC), and who
  // is coming over, and the Active swarm's skills.
  const rc = s.supplier.recruiting
  const micChip = rc && (rc.listening || rc.line) && (
    <div className={`flex max-w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold tabular-nums ${panel}`} data-hint="mic">
      {rc.listening && <span className="h-2 w-2 shrink-0 rounded-full bg-sky-500" />}
      <span className="truncate">{[rc.listening ? 'MIC · on-device' : '', rc.line].filter(Boolean).join(' · ')}</span>
    </div>
  )

  // Closed captions of the soundscape (captions.ts, fed by the engine): every sound with its bearing and distance,
  // speech with its words. An accessibility surface, so it outlives the H key like the MIC and REC chips.
  const captions = c.captions
  const captionStrip = captions && captions.length > 0 && (
    <div role="status" aria-live="polite" className={`flex max-w-full flex-col items-center gap-1 px-4 py-2 text-[13px] font-medium ${panel}`} data-hint="captions">
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

  // Render off (the console's render knob): the black canvas says why, and how to draw again. It outlives the
  // H key like the recorder's chip: a blank screen is never left unexplained.
  const renderChip = s.output.rendering === false && (
    <div className={`flex max-w-full items-center gap-2 px-3 py-1.5 text-[11px] font-semibold ${panel}`} data-hint="render">
      <span className="h-2 w-2 shrink-0 rounded-full bg-amber-400" />
      <span className="truncate">RENDER OFF · console only · render on</span>
    </div>
  )

  // Compact: the toasts stack under the header, so only as many as clear the touch stick below them
  // (one, on a single body line, on a phone held in landscape).
  const tight = compact && short
  const toasts = (compact ? s.toasts.slice(0, short ? 1 : 2) : s.toasts).map((t) => (
    <div key={t.id} className={`px-4 py-2.5 ${panel}`}>
      <div className={`text-[13px] font-semibold ${tight ? 'truncate' : ''}`}>{t.title}</div>
      <div className={`text-xs ${muted} ${tight ? 'truncate' : ''}`}>{t.body}</div>
    </div>
  ))
  const speedChip = (
    <div className={`flex items-center gap-2.5 py-2 pr-2.5 pl-3.5 ${panel}`}>
      <div className="text-right">
        <div className="text-2xl leading-none font-semibold tabular-nums tracking-tight">{c.speedKmh.toFixed(0)}</div>
        <div className={`mt-0.5 text-[10px] ${muted}`}>km/h · {c.gear}</div>
      </div>
      <LimitSign small />
    </div>
  )

  return (
    <div className="pointer-events-none absolute inset-0 font-sans text-[13px] antialiased select-none">
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
            {micChip}
            {ghostChip}
            {renderChip}
          </div>

          <div className={`absolute top-0 right-0 w-72 px-5 py-4 ${panel}`}>
            <div className="grid grid-cols-2 gap-x-4 gap-y-3">
              <Kpi label="Population" value={s.process.pedestrians.toLocaleString()} muted={muted} />
              <Kpi label="Vehicles" value={s.process.vehicles} muted={muted} />
              <Kpi label="Waiting at lights" value={s.process.waiting.toLocaleString()} muted={muted} />
              <Kpi label="On crosswalks" value={s.process.crossing.toLocaleString()} muted={muted} />
              {/* The city's indoor workplaces (interiors.ts): who is at a workstation now. A region has none. */}
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
          </div>

          <div className="absolute top-0 left-1/2 flex w-96 -translate-x-1/2 flex-col gap-2">{toasts}</div>

          <Minimap s={s} dark={dark} ui={1} layer={mapLayer} className={`absolute bottom-0 left-0 h-52 w-52 overflow-hidden rounded-full border-4 ${mapRing} shadow-[0_10px_40px_rgba(15,23,42,0.35)]`} />

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

          {enterPrompt && <div className="absolute bottom-20 left-1/2 -translate-x-1/2">{enterPrompt}</div>}
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
            {/* Landscape phone: header and readout side by side (wrapping if narrow), so the toast
                below them ends above the touch stick. Otherwise `contents` keeps them in the column. */}
            <div className={short ? 'flex max-w-full flex-wrap items-start gap-2' : 'contents'}>
              <div className={`flex max-w-full items-center gap-2.5 py-2 pr-3.5 pl-2.5 ${panel}`}>
                <MonolithLogo size={28} title="" />
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center text-[14px] leading-tight font-semibold tracking-tight">{BRAND.name}{nameTag}</div>
                  <div className={`truncate text-[11px] ${muted}`}>{c.district}</div>
                </div>
                <div className={divider} />
                <div className="text-[15px] font-semibold tabular-nums tracking-tight">{c.clock}</div>
              </div>
              <div className={`max-w-full px-3 py-2 text-[11px] ${panel}`}>
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
                <div className={`truncate tabular-nums ${muted}`}>
                  First Law {k.law1.toLocaleString()} · {k.sensorFlips.toLocaleString()} flips
                </div>
                {s.supplier.hal && <div className={`truncate ${muted}`}>{s.supplier.hal}</div>}
              </div>
            </div>
            {recChip}
            {micChip}
            {ghostChip}
            {renderChip}
            <div className="flex w-68 max-w-full flex-col gap-2">{toasts}</div>
          </div>

          <div className="absolute top-0 right-0 flex flex-col items-end gap-2">
            <Minimap s={s} dark={dark} ui={208 / 112} layer={mapLayer} className={`h-28 w-28 overflow-hidden rounded-full border-2 ${mapRing} shadow-[0_8px_24px_rgba(15,23,42,0.3)]`} />
            {driving && !short && speedChip}
          </div>

          {/* Bottom-centre, between the thumbs: the capture hint (a small desktop window), the enter
              prompt, and — on a phone held in landscape, where browser bars take 30-60 px of its height
              and the speedometer under the minimap would reach the driving buttons — the speedometer. */}
          {(captureHint || enterPrompt || (driving && short) || captionStrip) && (
            <div className="absolute bottom-0 left-1/2 flex max-w-full -translate-x-1/2 flex-col items-center gap-2">
              {captionStrip}
              {captureHint && captureChip(false)}
              {enterPrompt}
              {driving && short && speedChip}
            </div>
          )}
        </div>
      )}

      {visible && pingChip}

      {!visible && (recChip || rc?.listening || captionStrip) && (
        <div className={compact ? FRAME_COMPACT : FRAME_WIDE}>
          <div className="absolute top-0 left-0 flex max-w-full flex-col items-start gap-2">
            {recChip}
            {rc?.listening && micChip}
          </div>
          {captionStrip && <div className="absolute bottom-0 left-1/2 w-max max-w-full -translate-x-1/2">{captionStrip}</div>}
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
    </span>
  )
}

function Badge({ dark, children }: { dark: boolean; children: string }) {
  const tone = dark ? 'border-white/20 text-slate-200' : 'border-slate-900/15 text-slate-600'
  return <span className={`rounded border px-1 py-px text-[9px] leading-none font-semibold tracking-wide uppercase ${tone}`}>{children}</span>
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
/** The seed's workplaces, for the minimap (interiors.ts is pure and seeded: the same six the city hollowed). */
let roomsFor: { seed: number; rooms: readonly Workplace[] } | null = null
function roomsOf(seed: number): readonly Workplace[] {
  if (roomsFor?.seed !== seed) roomsFor = { seed, rooms: workplaces(seed) }
  return roomsFor.rooms
}

function cityMap(ctx: CanvasRenderingContext2D, x: number, z: number, dark: boolean, seed?: number): void {
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
  // The indoor workplaces: the lot drawn as a room (its floor in the accent colour inside the walls) with the doorway
  // open on its street front, so the way in reads on the map.
  if (seed !== undefined) {
    for (const r of roomsOf(seed)) {
      if (Math.abs(r.cx - x) > 150 || Math.abs(r.cz - z) > 150) continue
      ctx.fillStyle = dark ? '#b45309' : '#f59e0b'
      ctx.fillRect(r.cx - lotHalf, r.cz - lotHalf, lotHalf * 2, lotHalf * 2)
      const inner = lotHalf - ROOM.wall * 3
      ctx.fillStyle = dark ? '#451a03' : '#fef3c7'
      ctx.fillRect(r.cx - inner, r.cz - inner, inner * 2, inner * 2)
      const d = doorDir(r.side)
      const w = ROOM.door * 2, depth = lotHalf - inner + 0.2
      const gx = r.cx + d.x * (lotHalf - depth / 2), gz = r.cz + d.z * (lotHalf - depth / 2)
      const [gw, gh] = d.x !== 0 ? [depth, w] : [w, depth]
      ctx.fillRect(gx - gw / 2, gz - gh / 2, gw, gh)
    }
  }
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
function Minimap({ s, dark, ui, className, layer = null }: { s: SipocSnapshot; dark: boolean; ui: number; className: string; layer?: MapLayer | null }) {
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
    else cityMap(ctx, x, z, dark, s.process.seed)
    // Vehicles.
    for (const car of s.map) {
      if (Math.abs(car.x - x) > 150 || Math.abs(car.z - z) > 150) continue
      ctx.save()
      ctx.translate(car.x, car.z)
      ctx.rotate(-car.heading)
      ctx.fillStyle = car.player ? '#2563eb' : dark ? '#94a3b8' : '#64748b'
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
  }, [s, dark, ui, layer])
  return <canvas ref={ref} width={208} height={208} className={className} />
}
