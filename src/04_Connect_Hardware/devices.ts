// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the scored device resolver: the one table of every kind of input device the city
 * knows (seventeen profiles: Sony's pads over USB and Bluetooth, the letters-layout pads of the other two console
 * makers, Valve's and Logitech's pads, any pad with the browser's standard mapping, the three ways a pad without it
 * is read by position, three kinds of headset input, and the never-null fallback), and one function that names the
 * profile a device belongs to from whatever clues a browser gives. The clues are tried in order of how much they
 * say, each stage scoring its candidate, and the highest score wins: the USB vendor and product id plus the bus
 * (100: Chromium and Firefox print the ids in a pad's name, WebHID and Web Serial give them outright), a CRC-16
 * fingerprint of the pad's name (80: Safari prints neither id, only a name), a headset source's own words (70: its
 * target-ray mode, its hand, its gamepad's `xr-standard` mapping), the standard mapping (60), and the layout a pad
 * without it shows (40). Nothing ever resolves to null: a device nobody recognises is the `unknown` profile,
 * named by position, with no feature the city would try to drive. It is pure (no DOM, no clock, no import of a
 * browser API), so every profile and every stage is proved in Node, and the glyph family it reports is the one
 * gamepad.ts reports for the same id, so a HUD hint and a `hal` line never disagree.
 * What breaks if it is removed? The HAL cannot say what a device is beyond its name, a pad with no ids in its name
 * (Safari) is never recognised, and a headset's input has no profile to be read by.
 */
import { SONY_VENDOR_ID } from './dualsense.ts'
import { padFamilyOf, padName, parsePadId, type GenericLayout, type PadFamily } from './gamepad.ts'
import type { GamepadLike, XrInputSourceLike } from './web-hardware.d.ts'

/** The bus a device is reached over; `unknown` when the browser hides it (the Gamepad API always does). */
export type Bus = 'usb' | 'bluetooth' | 'unknown'

export type ProfileId =
  | 'dualsense-usb' | 'dualsense-bluetooth' | 'dualsense-edge-usb' | 'dualsense-edge-bluetooth' | 'dualshock4'
  | 'letters-a-south' | 'letters-b-south' | 'valve-pad' | 'logitech-pad' | 'standard-pad'
  | 'generic-evdev' | 'generic-four-axis' | 'generic-stick-only'
  | 'xr-controller' | 'xr-transient-pointer' | 'xr-hand'
  | 'unknown'

/** The stage of the resolver that named the profile, in the order the stages are tried. */
export type Stage = 'id' | 'fingerprint' | 'xr' | 'standard' | 'layout' | 'fallback'

/** What the city may drive or read on a device of the profile; every flag false on `unknown`. */
export interface Features {
  /** Two-motor rumble (the Gamepad API's dual-rumble, or the HID driver's compatible vibration). */
  readonly rumble: boolean
  /** Adaptive triggers the HID driver can program (dualsense.ts). */
  readonly adaptiveTriggers: boolean
  /** A lightbar and player LEDs the HID driver can set. */
  readonly lightbar: boolean
  /** Back paddles and function buttons (DualSense Edge). */
  readonly paddles: boolean
  /** A touchpad. */
  readonly touchpad: boolean
  /** The HID driver (dualsense.ts) can decode and drive it; the Gamepad API is a mirror. */
  readonly hidDriver: boolean
  /** A 6-DoF tracked controller or hand (a headset's input). */
  readonly tracked: boolean
  /** Articulated hand joints (WebXR Hand Input). */
  readonly hand: boolean
}

export interface DeviceProfile {
  readonly id: ProfileId
  /** A name for the HUD and `hal`: the device as its owner calls it, with no console maker's brand. */
  readonly name: string
  readonly kind: 'pad' | 'xr' | 'unknown'
  /** The glyph family the profile's buttons carry when the id gives no better word (gamepad.ts padFamilyOf). */
  readonly family: PadFamily
  /** The bus the profile is for; `unknown` for one that is the same over any bus. */
  readonly bus: Bus
  /**
   * How the pad is read: 'standard' by the W3C mapping, a GenericLayout by position (gamepad.ts GenericPads),
   * 'xr-standard' by the WebXR Gamepads Module, 'pointer' by select events alone (a transient pointer, a hand), 'none'.
   */
  readonly layout: 'standard' | GenericLayout | 'xr-standard' | 'pointer' | 'none'
  readonly features: Features
}

const NONE: Features = Object.freeze({ rumble: false, adaptiveTriggers: false, lightbar: false, paddles: false, touchpad: false, hidDriver: false, tracked: false, hand: false })
const feat = (f: Partial<Features>): Features => Object.freeze({ ...NONE, ...f })
const RUMBLE = feat({ rumble: true })
const SONY = feat({ rumble: true, adaptiveTriggers: true, lightbar: true, touchpad: true, hidDriver: true })
const EDGE = feat({ rumble: true, adaptiveTriggers: true, lightbar: true, touchpad: true, hidDriver: true, paddles: true })
const TRACKED = feat({ rumble: true, tracked: true })

const profile = (p: DeviceProfile): DeviceProfile => Object.freeze(p)

/** The seventeen profiles, in a fixed order (the index is stable: tests and telemetry may count on it). */
export const PROFILES: readonly DeviceProfile[] = Object.freeze([
  profile({ id: 'dualsense-usb', name: 'DualSense', kind: 'pad', family: 'numbered', bus: 'usb', layout: 'standard', features: SONY }),
  profile({ id: 'dualsense-bluetooth', name: 'DualSense', kind: 'pad', family: 'numbered', bus: 'bluetooth', layout: 'standard', features: SONY }),
  profile({ id: 'dualsense-edge-usb', name: 'DualSense Edge', kind: 'pad', family: 'numbered', bus: 'usb', layout: 'standard', features: EDGE }),
  profile({ id: 'dualsense-edge-bluetooth', name: 'DualSense Edge', kind: 'pad', family: 'numbered', bus: 'bluetooth', layout: 'standard', features: EDGE }),
  profile({ id: 'dualshock4', name: 'DualShock 4', kind: 'pad', family: 'numbered', bus: 'unknown', layout: 'standard', features: feat({ rumble: true, touchpad: true }) }),
  profile({ id: 'letters-a-south', name: 'Letters pad (A south)', kind: 'pad', family: 'abxy', bus: 'unknown', layout: 'standard', features: RUMBLE }),
  profile({ id: 'letters-b-south', name: 'Letters pad (B south)', kind: 'pad', family: 'bayx', bus: 'unknown', layout: 'standard', features: RUMBLE }),
  profile({ id: 'valve-pad', name: 'Valve pad', kind: 'pad', family: 'abxy', bus: 'unknown', layout: 'standard', features: RUMBLE }),
  profile({ id: 'logitech-pad', name: 'Logitech pad', kind: 'pad', family: 'abxy', bus: 'unknown', layout: 'standard', features: RUMBLE }),
  profile({ id: 'standard-pad', name: 'Standard pad', kind: 'pad', family: 'generic', bus: 'unknown', layout: 'standard', features: RUMBLE }),
  profile({ id: 'generic-evdev', name: 'Pad by position (kernel order)', kind: 'pad', family: 'generic', bus: 'unknown', layout: 'evdev', features: NONE }),
  profile({ id: 'generic-four-axis', name: 'Pad by position (four axes)', kind: 'pad', family: 'generic', bus: 'unknown', layout: 'four-axis', features: NONE }),
  profile({ id: 'generic-stick-only', name: 'Pad by position (stick only)', kind: 'pad', family: 'generic', bus: 'unknown', layout: 'stick-only', features: NONE }),
  profile({ id: 'xr-controller', name: 'Tracked controller', kind: 'xr', family: 'generic', bus: 'unknown', layout: 'xr-standard', features: TRACKED }),
  profile({ id: 'xr-transient-pointer', name: 'Gaze and pinch', kind: 'xr', family: 'generic', bus: 'unknown', layout: 'pointer', features: feat({ tracked: true }) }),
  profile({ id: 'xr-hand', name: 'Tracked hand', kind: 'xr', family: 'generic', bus: 'unknown', layout: 'pointer', features: feat({ tracked: true, hand: true }) }),
  profile({ id: 'unknown', name: 'Unknown device', kind: 'unknown', family: 'generic', bus: 'unknown', layout: 'none', features: NONE }),
])

const BY_ID: ReadonlyMap<ProfileId, DeviceProfile> = new Map(PROFILES.map((p) => [p.id, p]))

/** The profile of an id (every ProfileId has one). */
export function profileOf(id: ProfileId): DeviceProfile {
  return BY_ID.get(id)!
}

/** What each stage is worth; a bus-specific profile matched on its bus earns BUS_BONUS on top. */
export const STAGE_SCORE: Readonly<Record<Stage, number>> = Object.freeze({ id: 100, fingerprint: 80, xr: 70, standard: 60, layout: 40, fallback: 0 })
export const BUS_BONUS = 5
const STAGES: readonly Stage[] = ['id', 'fingerprint', 'xr', 'standard', 'layout', 'fallback']

/**
 * USB ids → profile. A row without a product id covers the vendor. Sources: the USB-IF vendor assignments; the
 * Linux kernel's hid-ids.h (Sony: 0x054c; DualSense 0x0ce6, DualSense Edge 0x0df2, DualShock 4 0x05c4 and 0x09cc,
 * its USB wireless adaptor 0x0ba0) and its xpad driver's table (vendor 0x045e: the letters pads with A at the
 * south button); vendor 0x057e: the pads with B there; Valve 0x28de: Steam Input's virtual pad, the Steam
 * controller and the Steam Deck; Logitech 0x046d: the F310 (0xc216 in its D mode, 0xc21d in its X mode) and the
 * F710 (0xc219, 0xc21f), listed by product since Logitech's wheels and sticks share the vendor.
 */
interface IdRow { vendorId: number; productId?: number; usb?: ProfileId; bluetooth?: ProfileId; any: ProfileId }
const ID_TABLE: readonly IdRow[] = [
  { vendorId: SONY_VENDOR_ID, productId: 0x0ce6, usb: 'dualsense-usb', bluetooth: 'dualsense-bluetooth', any: 'dualsense-usb' },
  { vendorId: SONY_VENDOR_ID, productId: 0x0df2, usb: 'dualsense-edge-usb', bluetooth: 'dualsense-edge-bluetooth', any: 'dualsense-edge-usb' },
  { vendorId: SONY_VENDOR_ID, productId: 0x05c4, any: 'dualshock4' },
  { vendorId: SONY_VENDOR_ID, productId: 0x09cc, any: 'dualshock4' },
  { vendorId: SONY_VENDOR_ID, productId: 0x0ba0, any: 'dualshock4' },
  { vendorId: 0x045e, any: 'letters-a-south' },
  { vendorId: 0x057e, any: 'letters-b-south' },
  { vendorId: 0x28de, any: 'valve-pad' },
  { vendorId: 0x046d, productId: 0xc216, any: 'logitech-pad' },
  { vendorId: 0x046d, productId: 0xc21d, any: 'logitech-pad' },
  { vendorId: 0x046d, productId: 0xc219, any: 'logitech-pad' },
  { vendorId: 0x046d, productId: 0xc21f, any: 'logitech-pad' },
]

/** The profile of a vendor/product pair on a bus, or null when the table has no row for it. */
export function profileForId(vendorId: number, productId: number, bus: Bus): { profile: DeviceProfile; busMatched: boolean } | null {
  for (const row of ID_TABLE) {
    if (row.vendorId !== vendorId || (row.productId !== undefined && row.productId !== productId)) continue
    const specific = bus === 'usb' ? row.usb : bus === 'bluetooth' ? row.bluetooth : undefined
    return { profile: profileOf(specific ?? row.any), busMatched: specific !== undefined }
  }
  return null
}

// ── CRC-16 fingerprints ─────────────────────────────────────────────────────────────────────────────────────────

/**
 * CRC-16/CCITT-FALSE (polynomial 0x1021, initial value 0xFFFF, no reflection, no final XOR; check value of
 * "123456789" is 0x29B1), over the UTF-8 bytes of the text. Table-driven, no allocation per call.
 */
const CRC16_TABLE = (() => {
  const t = new Uint16Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n << 8
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff
    t[n] = c
  }
  return t
})()

export function crc16(bytes: Uint8Array): number {
  let c = 0xffff
  for (let i = 0; i < bytes.length; i++) c = (CRC16_TABLE[((c >>> 8) ^ bytes[i]) & 0xff] ^ (c << 8)) & 0xffff
  return c
}

const encoder = new TextEncoder()

/**
 * A pad's name as the fingerprint sees it: without the browser's decorations (padName), lower case, one space
 * between words. Chromium's "DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)", Firefox's
 * "54c-ce6-DualSense Wireless Controller" and Safari's "DualSense Wireless Controller" all come to the same text.
 */
export function normalizeName(id: string): string {
  return padName(id).toLowerCase().replace(/\s+/g, ' ').trim()
}

/** The fingerprint of a pad id: crc16 of its normalized name. */
export function fingerprintOf(id: string): number {
  return crc16(encoder.encode(normalizeName(id)))
}

/**
 * Names browsers print for pads whose ids they hide (Safari prints the product name alone; so does a Bluetooth pad
 * on some platforms): each one's fingerprint names a profile. Only names that belong to one profile: "Wireless
 * Controller" alone is what several makers' pads call themselves, so it is left to the standard stage.
 */
export const FINGERPRINT_NAMES: readonly { readonly name: string; readonly profile: ProfileId }[] = Object.freeze([
  { name: 'DualSense Wireless Controller', profile: 'dualsense-usb' },
  { name: 'DualSense Edge Wireless Controller', profile: 'dualsense-edge-usb' },
  { name: 'DUALSHOCK 4 Wireless Controller', profile: 'dualshock4' },
  { name: 'Pro Controller', profile: 'letters-b-south' },
  { name: 'Steam Deck', profile: 'valve-pad' },
  { name: 'Steam Controller', profile: 'valve-pad' },
  { name: 'Steam Virtual Gamepad', profile: 'valve-pad' },
  { name: 'Logitech Gamepad F310', profile: 'logitech-pad' },
  { name: 'Logitech Gamepad F710', profile: 'logitech-pad' },
  { name: 'Logitech Dual Action', profile: 'logitech-pad' },
])

const FINGERPRINTS: ReadonlyMap<number, ProfileId> = (() => {
  const m = new Map<number, ProfileId>()
  for (const { name, profile: p } of FINGERPRINT_NAMES) {
    const f = crc16(encoder.encode(normalizeName(name)))
    const other = m.get(f)
    // Two names colliding would make one of them resolve wrong: fail loudly where the table is written.
    if (other !== undefined && other !== p) throw new Error(`fingerprint collision: "${name}" with another name (0x${f.toString(16)})`)
    m.set(f, p)
  }
  return m
})()

/** The profile a fingerprint names, or null. */
export function profileForFingerprint(fingerprint: number): DeviceProfile | null {
  const id = FINGERPRINTS.get(fingerprint)
  return id === undefined ? null : profileOf(id)
}

// ── Clues and the resolution ────────────────────────────────────────────────────────────────────────────────────

/** What a headset source says of itself (the slice of XRInputSource the resolver reads). */
export interface XrClues {
  readonly handedness: 'none' | 'left' | 'right'
  /** 'tracked-pointer', 'gaze', 'screen' or 'transient-pointer' (Apple's gaze-and-pinch). */
  readonly targetRayMode: string
  /** The WebXR input profiles registry names, most specific first (e.g. "generic-trigger-squeeze-thumbstick"). */
  readonly profiles: readonly string[]
  /** Its gamepad's mapping ('xr-standard' or ''), or null without a gamepad. */
  readonly mapping: string | null
  /** WebXR Hand Input joints are exposed. */
  readonly hand: boolean
}

/** Everything a resolver call may be given; every clue optional. */
export interface DeviceClues {
  /** The Gamepad API id, or a HID product name. */
  readonly id?: string
  /** The Gamepad API mapping: 'standard', '' or 'xr-standard'. */
  readonly mapping?: string
  readonly axes?: number
  readonly buttons?: number
  /** From WebHID, Web Serial or the id string; −1 or absent when unknown. */
  readonly vendorId?: number
  readonly productId?: number
  readonly bus?: Bus
  /** How gamepad.ts GenericPads reads the pad by now (null before it has decided). */
  readonly layout?: GenericLayout | null
  readonly xr?: XrClues
}

export interface Candidate { readonly profile: DeviceProfile; readonly stage: Stage; readonly score: number }

export interface Resolution {
  readonly profile: DeviceProfile
  readonly stage: Stage
  readonly score: number
  /** The glyph family for the HUD: what gamepad.ts says of the id when there is one, else the profile's. */
  readonly family: PadFamily
  readonly bus: Bus
  /** −1 when no clue carried them. */
  readonly vendorId: number
  readonly productId: number
  /** crc16 of the normalized name (0 without a name). */
  readonly fingerprint: number
  /** The device's own name, cleaned (padName), or the profile's. */
  readonly name: string
  /** Every stage's candidate, best first. */
  readonly candidates: readonly Candidate[]
}

const hex4 = (n: number) => n.toString(16).padStart(4, '0')

/** The clues of a Gamepad API pad, with the ids its name carries (Chromium, Firefox) and GenericPads' layout. */
export function padClues(p: GamepadLike, layout: GenericLayout | null = null, bus: Bus = 'unknown'): DeviceClues {
  const ids = parsePadId(p.id)
  return { id: p.id, mapping: p.mapping, axes: p.axes.length, buttons: p.buttons.length, vendorId: ids?.vendor ?? -1, productId: ids?.product ?? -1, bus, layout }
}

/** The clues of a WebXR input source. */
export function xrClues(s: XrInputSourceLike): DeviceClues {
  const xr: XrClues = {
    handedness: s.handedness === 'left' || s.handedness === 'right' ? s.handedness : 'none',
    targetRayMode: typeof s.targetRayMode === 'string' ? s.targetRayMode : '',
    profiles: Array.isArray(s.profiles) ? s.profiles.filter((x): x is string => typeof x === 'string') : [],
    mapping: s.gamepad ? s.gamepad.mapping : null,
    hand: !!s.hand,
  }
  return { id: xr.profiles[0] ?? '', mapping: xr.mapping ?? '', axes: s.gamepad?.axes.length ?? 0, buttons: s.gamepad?.buttons.length ?? 0, xr }
}

/**
 * Names the profile of a device. Every stage with something to say adds a candidate; the highest score wins, and
 * on a tie the stage tried first. Never null: with no clue at all the answer is `unknown` at score 0.
 */
export function resolveDevice(c: DeviceClues): Resolution {
  const id = c.id ?? ''
  const parsed = id ? parsePadId(id) : null
  const vendorId = c.vendorId !== undefined && c.vendorId >= 0 ? c.vendorId : (parsed?.vendor ?? -1)
  const productId = c.productId !== undefined && c.productId >= 0 ? c.productId : (parsed?.product ?? -1)
  const bus: Bus = c.bus ?? 'unknown'
  const fingerprint = id ? fingerprintOf(id) : 0
  const candidates: Candidate[] = []
  const add = (p: DeviceProfile, stage: Stage, bonus = 0) => { candidates.push({ profile: p, stage, score: STAGE_SCORE[stage] + bonus }) }

  if (vendorId >= 0 && productId >= 0) {
    const hit = profileForId(vendorId, productId, bus)
    if (hit) add(hit.profile, 'id', hit.busMatched ? BUS_BONUS : 0)
  }
  if (id) {
    const hit = profileForFingerprint(fingerprint)
    if (hit) add(hit, 'fingerprint')
  }
  const xr = c.xr
  if (xr) {
    if (xr.targetRayMode === 'transient-pointer') add(profileOf('xr-transient-pointer'), 'xr')
    else if (xr.hand || xr.profiles.includes('generic-hand')) add(profileOf('xr-hand'), 'xr')
    else if (xr.mapping === 'xr-standard' || xr.targetRayMode === 'tracked-pointer') add(profileOf('xr-controller'), 'xr')
  }
  if (c.mapping === 'standard') add(profileOf('standard-pad'), 'standard')
  if (!xr && c.mapping !== 'standard') {
    const layout = c.layout ?? guessLayout(c.axes ?? 0, c.buttons ?? 0)
    if (layout) add(profileOf(layout === 'evdev' ? 'generic-evdev' : layout === 'four-axis' ? 'generic-four-axis' : 'generic-stick-only'), 'layout', c.layout ? 0 : -5)
  }
  add(profileOf('unknown'), 'fallback')
  candidates.sort((a, b) => b.score - a.score || STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage))
  const best = candidates[0]
  const resolvedBus: Bus = bus !== 'unknown' ? bus : best.profile.bus
  const family: PadFamily = id && best.profile.kind === 'pad' ? padFamilyOf(id) : best.profile.family
  const name = id && best.profile.kind !== 'xr' ? padName(id) : best.profile.name
  return { profile: best.profile, stage: best.stage, score: best.score, family, bus: resolvedBus, vendorId, productId, fingerprint, name, candidates }
}

/**
 * The layout a pad without the standard mapping most likely has before GenericPads has watched it: four axes is the
 * four-axis layout, six or more is read as stick-only until the kernel's order shows (gamepad.ts), two or three
 * axes with four buttons is stick-only; fewer is no pad at all (null).
 */
export function guessLayout(axes: number, buttons: number): GenericLayout | null {
  if (axes === 4 && buttons >= 4) return 'four-axis'
  if (axes >= 2 && buttons >= 4) return 'stick-only'
  return null
}

/** One line for `hal`: the profile, the score and the stage, e.g. "dualsense-bluetooth 105 (by id, usb 054c:0ce6)". */
export function describeResolution(r: Resolution): string {
  const by = r.stage === 'id' ? `by id, ${r.bus} ${hex4(r.vendorId)}:${hex4(r.productId)}`
    : r.stage === 'fingerprint' ? `by name, crc16 ${hex4(r.fingerprint)}`
    : r.stage === 'xr' ? 'by the headset'
    : r.stage === 'standard' ? 'standard mapping'
    : r.stage === 'layout' ? 'by position'
    : 'nothing recognised'
  return `${r.profile.id} ${r.score} (${by})`
}
