// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's accessibility settings and the arithmetic behind them: high contrast for
 * every overlay (the HUD, Sloane's card, the wardrobe, the action card, the way-out card: flat black and white, solid
 * borders, no frosted glass, a thick focus ring), a colour-vision filter over the finished frame for a protan, deutan
 * or tritan viewer (the post chain's last 3×3, postfx.ts), a text scale from 100 % to 200 % that enlarges every
 * overlay without the canvas (a CSS zoom on each overlay's root, index.css `.ui-zoom`), and a caption size for the
 * HUD's strip. The settings are kept between visits (ACCESS_KEY), can be set for one visit in the URL (`?contrast=high`,
 * `?vision=deutan`, `?ui=150`, `?captions=large`), and 'auto' contrast follows the operating system's own switch
 * (`prefers-contrast: more`). Four more are for the hands and the ears: the dwell click (04_Connect_Hardware/dwell.ts),
 * single-switch scanning (scanning.ts), a one-handed pad layout (gamepad.ts PadHand) and the screen reader's lines
 * (07_Execute_Actions/announcer.ts). The console's `access` command reads and writes them (accessBridge); the touch
 * Menu holds the two most wanted (contrast, text size). Pure: every function here runs in a Node test; `applyAccess`
 * takes the document's root element as an argument.
 *
 * The colour-vision filter is a daltonisation: the frame is simulated as the viewer would see it (Machado, Oliveira
 * and Fernandes 2009, severity 1.0), the colour lost to the simulation is found (the difference), and that loss is
 * shifted into the channels the viewer does see (for a protan or deutan the red channel's loss into green and blue,
 * the usual shift; for a tritan the blue channel's loss into red and green). As one matrix: T = I + K·(I − M). It is applied to the display-referred frame after tone mapping and FXAA (the matrices are
 * published for linear light; on the display-referred frame they are an approximation that keeps the hues apart,
 * which is the point). It changes nothing a viewer with full colour vision needs; it is off ('none') by default.
 * What breaks if it is removed? Every overlay is frosted glass at one size, the frame's colours are the camera's, and a
 * viewer who cannot tell the signals' red from green has nothing to switch on.
 */
import type { AccessBridge } from './terminal/bridge.ts'
import type { PadHand } from '../04_Connect_Hardware/gamepad.ts'

export type Contrast = 'auto' | 'high' | 'normal'
export type Vision = 'none' | 'protan' | 'deutan' | 'tritan'
export const SCALES = [100, 125, 150, 175, 200] as const
export type Scale = (typeof SCALES)[number]
export type CaptionSize = 'normal' | 'large' | 'huge'

export interface AccessSettings {
  /** High contrast for every overlay: 'auto' follows the operating system (`prefers-contrast: more`). */
  readonly contrast: Contrast
  /** The colour-vision filter over the finished frame. */
  readonly vision: Vision
  /** The text scale of every overlay, percent. */
  readonly scale: Scale
  /** The HUD caption strip's size. */
  readonly captions: CaptionSize
  /** A pointer resting on a control presses it (dwell.ts). */
  readonly dwell: boolean
  /** The controls offered one at a time, the Space bar pressing the one offered (scanning.ts). */
  readonly scan: boolean
  /** The pad layout: both hands, or one (gamepad.ts PadHand). */
  readonly pad: PadHand
  /** The screen reader told of the district, a vehicle beside you, a seat and the toasts (announcer.ts). */
  readonly announce: boolean
}

export const ACCESS_DEFAULTS: AccessSettings = Object.freeze({ contrast: 'auto', vision: 'none', scale: 100, captions: 'normal', dwell: false, scan: false, pad: 'both', announce: true })

/** Where the settings are kept between visits. */
export const ACCESS_KEY = 'civic-simulation:access:v1'

export const CONTRASTS: readonly Contrast[] = ['auto', 'high', 'normal']
export const VISIONS: readonly Vision[] = ['none', 'protan', 'deutan', 'tritan']
export const CAPTION_SIZES: readonly CaptionSize[] = ['normal', 'large', 'huge']
export const PAD_HANDS: readonly PadHand[] = ['both', 'left', 'right']
/** The console's field words, in the order accessStatus prints their lines. */
export const ACCESS_FIELDS = ['contrast', 'vision', 'text', 'captions', 'dwell', 'scan', 'pad', 'announce'] as const
/** The caption strip's font size per setting, CSS px before the text scale. */
export const CAPTION_PX: Readonly<Record<CaptionSize, number>> = Object.freeze({ normal: 13, large: 18, huge: 24 })

export interface KeyStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

function browserStore(): KeyStore | null {
  try { return (globalThis as { localStorage?: KeyStore }).localStorage ?? null } catch { return null }
}

const isScale = (v: unknown): v is Scale => typeof v === 'number' && (SCALES as readonly number[]).includes(v)
const isContrast = (v: unknown): v is Contrast => typeof v === 'string' && (CONTRASTS as readonly string[]).includes(v)
const isVision = (v: unknown): v is Vision => typeof v === 'string' && (VISIONS as readonly string[]).includes(v)
const isCaptionSize = (v: unknown): v is CaptionSize => typeof v === 'string' && (CAPTION_SIZES as readonly string[]).includes(v)
const isHand = (v: unknown): v is PadHand => typeof v === 'string' && (PAD_HANDS as readonly string[]).includes(v)
/** The console's and the URL's on and off words. */
const onOff = (v: string): boolean | null => (v === 'on' || v === '1' || v === 'true' ? true : v === 'off' || v === '0' || v === 'false' ? false : null)

/** The settings kept in `store` (a field that is not a known value reads as its default; anything odd reads as the defaults). */
export function loadAccess(store: KeyStore | null = browserStore()): AccessSettings {
  if (!store) return ACCESS_DEFAULTS
  try {
    const raw = store.getItem(ACCESS_KEY)
    if (typeof raw !== 'string' || !raw || raw.length > 256) return ACCESS_DEFAULTS
    const d = JSON.parse(raw) as { v?: unknown; contrast?: unknown; vision?: unknown; scale?: unknown; captions?: unknown; dwell?: unknown; scan?: unknown; pad?: unknown; announce?: unknown }
    if (!d || typeof d !== 'object' || d.v !== 1) return ACCESS_DEFAULTS
    return Object.freeze({
      contrast: isContrast(d.contrast) ? d.contrast : ACCESS_DEFAULTS.contrast,
      vision: isVision(d.vision) ? d.vision : ACCESS_DEFAULTS.vision,
      scale: isScale(d.scale) ? d.scale : ACCESS_DEFAULTS.scale,
      captions: isCaptionSize(d.captions) ? d.captions : ACCESS_DEFAULTS.captions,
      dwell: typeof d.dwell === 'boolean' ? d.dwell : ACCESS_DEFAULTS.dwell,
      scan: typeof d.scan === 'boolean' ? d.scan : ACCESS_DEFAULTS.scan,
      pad: isHand(d.pad) ? d.pad : ACCESS_DEFAULTS.pad,
      announce: typeof d.announce === 'boolean' ? d.announce : ACCESS_DEFAULTS.announce,
    })
  } catch { return ACCESS_DEFAULTS }
}

export function saveAccess(s: AccessSettings, store: KeyStore | null = browserStore()): void {
  if (!store) return
  try { store.setItem(ACCESS_KEY, JSON.stringify({ v: 1, contrast: s.contrast, vision: s.vision, scale: s.scale, captions: s.captions, dwell: s.dwell, scan: s.scan, pad: s.pad, announce: s.announce })) } catch { /* storage unavailable */ }
}

/**
 * The settings for this visit from the URL over `base`: `?contrast=high|normal|auto`, `?vision=protan|deutan|tritan|none`,
 * `?ui=100|125|150|175|200` (any number is rounded to the nearest step), `?captions=large|huge|normal`
 * (`?captions=0`, the strip's off switch, is another option's and ignored here), `?dwell=1|0`, `?scan=1|0`,
 * `?pad=both|left|right` and `?announce=1|0`. Anything else leaves `base` as it is.
 */
export function accessFromQuery(q: { get(name: string): string | null }, base: AccessSettings = ACCESS_DEFAULTS): AccessSettings {
  const contrast = q.get('contrast'), vision = q.get('vision'), ui = q.get('ui'), captions = q.get('captions'), pad = q.get('pad')
  // An empty ?ui= is no number (Number('') is 0, which would round to 100 % over a kept size).
  const n = ui === null || ui.trim() === '' ? Number.NaN : Number(ui)
  const nearest = Number.isFinite(n) ? [...SCALES].sort((a, b) => Math.abs(a - n) - Math.abs(b - n) || a - b)[0] : null
  const flag = (name: string, was: boolean): boolean => { const v = q.get(name); return v === null ? was : (onOff(v.toLowerCase()) ?? was) }
  const next: AccessSettings = {
    contrast: isContrast(contrast) ? contrast : base.contrast,
    vision: isVision(vision) ? vision : base.vision,
    scale: nearest ?? base.scale,
    captions: isCaptionSize(captions) ? captions : base.captions,
    dwell: flag('dwell', base.dwell),
    scan: flag('scan', base.scan),
    pad: isHand(pad) ? pad : base.pad,
    announce: flag('announce', base.announce),
  }
  return (Object.keys(next) as (keyof AccessSettings)[]).every((k) => next[k] === base[k]) ? base : Object.freeze(next)
}

/** Whether the overlays are in high contrast now: the setting, or with 'auto' the operating system's switch. */
export function highContrast(s: AccessSettings, prefersMore: boolean): boolean {
  return s.contrast === 'high' || (s.contrast === 'auto' && prefersMore)
}

/**
 * One field set from the console's words: `contrast auto|high|normal`, `vision none|protan|deutan|tritan`,
 * `text 100|125|150|175|200` (`text 100%` too), `captions normal|large|huge`, `dwell on|off`, `scan on|off`,
 * `pad both|left|right`, `announce on|off`. Returns the next settings, or the error for the console (a string).
 */
export function withAccess(s: AccessSettings, field: string, value: string): AccessSettings | string {
  const f = field.trim().toLowerCase(), v = value.trim().toLowerCase()
  switch (f) {
    case 'contrast':
      return isContrast(v) ? Object.freeze({ ...s, contrast: v }) : `access: contrast is one of ${CONTRASTS.join(', ')}`
    case 'vision':
      return isVision(v) ? Object.freeze({ ...s, vision: v }) : `access: vision is one of ${VISIONS.join(', ')}`
    case 'text': {
      const n = Number(v.replace(/%$/, ''))
      return isScale(n) ? Object.freeze({ ...s, scale: n }) : `access: text is one of ${SCALES.join(', ')} (percent)`
    }
    case 'captions':
      return isCaptionSize(v) ? Object.freeze({ ...s, captions: v }) : `access: captions is one of ${CAPTION_SIZES.join(', ')}`
    case 'dwell':
    case 'scan':
    case 'announce': {
      const on = onOff(v)
      return on === null ? `access: ${f} is on or off` : Object.freeze({ ...s, [f]: on })
    }
    case 'pad':
      return isHand(v) ? Object.freeze({ ...s, pad: v }) : `access: pad is one of ${PAD_HANDS.join(', ')}`
    default:
      return `access: nothing to set called '${field.trim()}': ${ACCESS_FIELDS.join(', ')}`
  }
}

/** The next text scale after `scale`, round again from the top (the touch Menu's item cycles through them). */
export function nextScale(scale: Scale): Scale {
  return SCALES[(SCALES.indexOf(scale) + 1) % SCALES.length]
}

/** The settings with the next text scale (the touch Menu's Text size item). */
export function cycleScale(s: AccessSettings): AccessSettings {
  return Object.freeze({ ...s, scale: nextScale(s.scale) })
}

/** The settings with high contrast switched: off when it is on now (by the setting or the system), else on (the touch Menu's item). */
export function toggleContrast(s: AccessSettings, prefersMore: boolean): AccessSettings {
  return Object.freeze({ ...s, contrast: highContrast(s, prefersMore) ? 'normal' : 'high' })
}

// ---------------------------------------------------------------- colour vision

/** A 3×3 matrix, row by row. */
export type Mat3 = readonly [number, number, number, number, number, number, number, number, number]

export const IDENTITY: Mat3 = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]) as unknown as Mat3

/**
 * How a protan, deutan or tritan viewer sees RGB (Machado, Oliveira and Fernandes 2009, severity 1.0; the simulation
 * matrices as published, row by row). Each row sums to one: a grey stays that grey.
 */
export const CVD_SIM: Readonly<Record<Exclude<Vision, 'none'>, Mat3>> = Object.freeze({
  protan: Object.freeze([0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998]) as unknown as Mat3,
  deutan: Object.freeze([0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881]) as unknown as Mat3,
  tritan: Object.freeze([1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900]) as unknown as Mat3,
})

/** The red channel's error into green and blue at 0.7, green's and blue's kept (Fidaner, Lin and Ozguven 2005). */
const K_RED: Mat3 = Object.freeze([0, 0, 0, 0.7, 1, 0, 0.7, 0, 1]) as unknown as Mat3
/** The blue channel's error into red and green at 0.7, the same shift turned for a tritan viewer. */
const K_BLUE: Mat3 = Object.freeze([1, 0, 0.7, 0, 1, 0.7, 0, 0, 0]) as unknown as Mat3
/** Where the lost colour goes, per viewer. */
export const DALTON_K: Readonly<Record<Exclude<Vision, 'none'>, Mat3>> = Object.freeze({ protan: K_RED, deutan: K_RED, tritan: K_BLUE })

const mul = (a: Mat3, b: Mat3): Mat3 => {
  const out: number[] = []
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.push(a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c])
  return out as unknown as Mat3
}
const sub = (a: Mat3, b: Mat3): Mat3 => a.map((v, i) => v - b[i]) as unknown as Mat3
const add = (a: Mat3, b: Mat3): Mat3 => a.map((v, i) => v + b[i]) as unknown as Mat3

/** The filter for a viewer, T = I + K·(I − M), row by row; the identity for 'none'. */
export function visionMatrix(v: Vision): Mat3 {
  if (v === 'none') return IDENTITY
  return add(IDENTITY, mul(DALTON_K[v], sub(IDENTITY, CVD_SIM[v])))
}

/** `m` applied to a colour (row by row), for a test or a readout. */
export function applyMat3(m: Mat3, c: readonly [number, number, number]): [number, number, number] {
  return [
    m[0] * c[0] + m[1] * c[1] + m[2] * c[2],
    m[3] * c[0] + m[4] * c[1] + m[5] * c[2],
    m[6] * c[0] + m[7] * c[1] + m[8] * c[2],
  ]
}

export function visionWord(v: Vision): string {
  switch (v) {
    case 'none': return 'none (the camera\'s colours)'
    case 'protan': return 'protan (red weak or blind): reds shifted toward blue, apart from the greens'
    case 'deutan': return 'deutan (green weak or blind): reds shifted toward blue, apart from the greens'
    case 'tritan': return 'tritan (blue weak or blind): blues shifted toward red, apart from the yellows'
  }
}

// ---------------------------------------------------------------- the page

/** The document's root element, by what is written to it. */
export interface RootLike { dataset: { contrast?: string; pad?: string }; style: { setProperty(name: string, value: string): void } }

/**
 * Writes the settings onto the page's root: `data-contrast` (index.css keys its rules on it), `--ui-zoom`, and
 * `data-pad`, the hand the ways out of a stopped city read (padNav.ts), since they can stand where no prop reaches.
 */
export function applyAccess(s: AccessSettings, prefersMore: boolean, root: RootLike): void {
  root.dataset.contrast = highContrast(s, prefersMore) ? 'high' : 'normal'
  root.dataset.pad = s.pad
  root.style.setProperty('--ui-zoom', String(s.scale / 100))
}

/**
 * What to keep after a change: the kept settings with only the fields the change made differ from the live ones written
 * over them, so a setting the URL gave for one visit (?ui=200) is not written down by a later switch of something else,
 * while a field the visitor sets again is kept, whatever the URL said.
 */
export function keepAccess(kept: AccessSettings, live: AccessSettings, next: AccessSettings): AccessSettings {
  const out: Record<string, unknown> = { ...kept }
  for (const field of Object.keys(next) as (keyof AccessSettings)[]) if (next[field] !== live[field]) out[field] = next[field]
  return out as unknown as AccessSettings
}

/**
 * The console's `access` lines. `visionNote` is why the colour-vision filter cannot be drawn now (the engine's
 * visionBlocked(): the post chain is off), said on the vision line while a filter is chosen.
 */
export function accessStatus(s: AccessSettings, prefersMore: boolean, visionNote: string | null = null): string[] {
  const high = highContrast(s, prefersMore)
  const held = s.vision !== 'none' && visionNote !== null ? `, but not drawn now: it ${visionNote}` : ''
  return [
    `contrast  ${s.contrast}${s.contrast === 'auto' ? ` (the system asks for ${prefersMore ? 'more' : 'no more'}: ${high ? 'high' : 'normal'})` : ''}  (access contrast auto|high|normal)`,
    `vision    ${visionWord(s.vision)}${held}  (access vision none|protan|deutan|tritan)`,
    `text      ${s.scale} %  (access text 100|125|150|175|200)`,
    `captions  ${s.captions}, ${CAPTION_PX[s.captions]} px  (access captions normal|large|huge)`,
    `dwell     ${s.dwell ? 'on: a pointer resting on a control presses it' : 'off'}  (access dwell on|off)`,
    `scan      ${s.scan ? 'on: the controls are offered in turn, Space presses the one offered' : 'off'}  (access scan on|off)`,
    `pad       ${s.pad === 'both' ? 'both hands' : `${s.pad} hand: its stick moves, with ${s.pad === 'left' ? 'L1' : 'R1'} held it looks; select runs, start pings`}  (access pad both|left|right)`,
    `announce  ${s.announce ? 'on: the district, a vehicle beside you, a seat and the toasts are read' : 'off'}  (access announce on|off)`,
    `kept      ${ACCESS_KEY}; for one visit: ?contrast= ?vision= ?ui= ?captions= ?dwell= ?scan= ?pad= ?announce=`,
  ]
}

/**
 * The console's bridge over the host's settings: `read` the current ones, `prefersMore` the system's switch, `write`
 * keeps and applies the next (`whole` for a reset, which keeps every field, not only the changed ones), `visionNote`
 * why the colour filter cannot be drawn now (null when it can).
 */
export function accessBridge(
  read: () => AccessSettings,
  prefersMore: () => boolean,
  write: (next: AccessSettings, whole?: boolean) => void,
  visionNote: () => string | null = () => null,
): AccessBridge {
  return Object.freeze({
    status: () => accessStatus(read(), prefersMore(), visionNote()),
    set: (field: string, value: string): { line: string } | { error: string } => {
      const next = withAccess(read(), field, value)
      if (typeof next === 'string') return { error: next }
      write(next)
      return { line: accessStatus(next, prefersMore(), visionNote())[(ACCESS_FIELDS as readonly string[]).indexOf(field.trim().toLowerCase())] }
    },
    reset: (): string => {
      write(ACCESS_DEFAULTS, true)
      return 'access: the defaults (auto contrast, no colour filter, text 100 %, normal captions, no dwell, no scan, both hands, announcing)'
    },
  })
}
