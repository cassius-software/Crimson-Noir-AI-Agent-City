// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the HID driver for Sony's DualSense and DualSense Edge: it builds the main
 * output report byte for byte (USB report 0x02; Bluetooth report 0x31 with its sequence nibble and CRC-32) with
 * both adaptive triggers (the brake's continuous resistance on the left, the throttle's hold or snap on the
 * right, from the full set of named effects), the compatible (classic two-motor) vibration, the lightbar and
 * the player LEDs — and, over Bluetooth, where our first output report puts the controller into its full report
 * mode, decodes the full input report into a standard-mapped pad (the Edge's back paddles and Fn keys included)
 * so steering keeps working. It writes through WebHID or, in the Windows app, the shell's native HID (nativeHid.ts):
 * both present the same HidDevice shape.
 * What breaks if it is removed? No trigger effects, rumble or lightbar on DualSense controllers.
 *
 * Sources (layout facts only, cross-checked against each other; NOT yet verified on hardware by this project):
 *  [K] Linux drivers/hid/hid-playstation.c (Sony Interactive Entertainment): report IDs and sizes,
 *      struct dualsense_output_report_common (47 bytes), valid_flag bits, mute LED, lightbar setup, player LEDs
 *      (centred patterns 0x04 0x0A 0x15 0x1B 0x1F), lightbar RGB, the Bluetooth seq/tag header (tag 0x10,
 *      sequence in the high nibble), CRC-32 seeds 0xA1 (input) / 0xA2 (output), firmware-info feature report 0x20
 *      (update_version, little-endian u16 at byte 44), the "vibration v2" rule, the input report, the Edge's
 *      Fn1/Fn2/paddle bits in buttons[2]. https://github.com/torvalds/linux/blob/master/drivers/hid/hid-playstation.c
 *  [I] Linux drivers/hid/hid-ids.h: vendor 0x054c; DualSense 0x0ce6; DualSense Edge 0x0df2.
 *  [S] libsdl-org/SDL src/joystick/hidapi/SDL_hidapi_ps5.c: the trigger blocks inside the common struct — right
 *      trigger mode byte at +10, left at +21, each followed by 10 parameter bytes; the Edge's extra buttons.
 *  [C] nowrep/dualsensectl main.c: valid_flag0 bit 2 = right trigger, bit 3 = left. https://github.com/nowrep/dualsensectl
 *  [N] John "Nielk1" Klein, TriggerEffectGenerator.cs (MIT): the effect bytes — 0x05 Off; 0x21 Feedback = 10-bit
 *      active-zone mask + 3-bit (strength − 1) per zone; 0x25 a resistance between two zones (called "detent"
 *      here); 0x26 Vibration = zone mask + amplitudes + frequency; 0x22 Bow; 0x23 Galloping; 0x27 Machine.
 *      https://gist.github.com/Nielk1/6d54cc2c00d2201ccb8c2720ad7538db
 *  [D] dogtopus, DualSense USB HID report descriptor dump: output report 0x02 = 47 bytes ("85 02 09 23 95 2f
 *      91 02"), feature 0x20 = 63 bytes. https://gist.github.com/dogtopus/894da226d73afb3bdd195df41b3a26aa
 *  [W] hid.spec.whatwg.org: sendReport() data excludes the report ID; a received feature report "may" start with
 *      the report ID. Chromium (services/device/hid/hid_connection.cc) rejects an output buffer longer than the
 *      device's largest output report and (Windows) zero-pads shorter ones.
 *  Not reachable from here: the HD voice-coil haptics ride the controller's USB audio, not its HID reports.
 */
import type { HidCollectionInfo, HidDevice, HidInputReportEvent } from './web-hardware.d.ts'

export const SONY_VENDOR_ID = 0x054c

export const DUALSENSE_PRODUCTS: Readonly<Record<number, string>> = { 0x0ce6: 'DualSense', 0x0df2: 'DualSense Edge' }

export const DUALSENSE_EDGE_PRODUCT_ID = 0x0df2

export const DUALSENSE_FILTERS: readonly { vendorId: number; productId: number }[] = [
  { vendorId: SONY_VENDOR_ID, productId: 0x0ce6 },
  { vendorId: SONY_VENDOR_ID, productId: DUALSENSE_EDGE_PRODUCT_ID },
]

export function isDualSense(vendorId: number, productId: number): boolean {
  return vendorId === SONY_VENDOR_ID && DUALSENSE_PRODUCTS[productId] !== undefined
}

export function dualSenseName(productId: number): string {
  return DUALSENSE_PRODUCTS[productId] ?? 'DualSense'
}

export type DsBus = 'usb' | 'bluetooth'

export const DS = {
  usbOutputId: 0x02,
  /** Report data length without the report ID [D]. */
  usbOutputLength: 47,
  btOutputId: 0x31,
  /** 78-byte report [K] minus the report ID. */
  btOutputLength: 77,
  btTag: 0x10,
  outputCrcSeed: 0xa2,
  inputCrcSeed: 0xa1,
  btInputId: 0x31,
  btInputLength: 77,
  firmwareInfoId: 0x20,
} as const

/** Byte offsets inside the 47-byte common block [K][S]. */
export const COMMON = {
  flag0: 0, flag1: 1, motorRight: 2, motorLeft: 3, muteLed: 8, rightTrigger: 10, leftTrigger: 21, flag2: 38,
  lightbarSetup: 41, ledBrightness: 42, playerLeds: 43, red: 44, green: 45, blue: 46, length: 47,
} as const

/** Where the common block starts inside the report data (report ID excluded): USB at once; BT after seq + tag. */
export const COMMON_AT: Readonly<Record<DsBus, number>> = { usb: 0, bluetooth: 2 }

export const FLAG0 = { compatibleVibration: 0x01, hapticsSelect: 0x02, rightTrigger: 0x04, leftTrigger: 0x08 } as const
export const FLAG1 = { muteLed: 0x01, powerSave: 0x02, lightbar: 0x04, releaseLeds: 0x08, playerLeds: 0x10 } as const
export const FLAG2 = { lightbarSetup: 0x02, compatibleVibration2: 0x04 } as const
/** lightbar_setup [K]: LIGHT_OUT fades the lightbar out, ending the animation a Bluetooth pairing plays until the host takes the bar. */
export const LIGHTBAR_SETUP = { lightOut: 0x02 } as const
export const EFFECT = { off: 0x05, feedback: 0x21, bow: 0x22, galloping: 0x23, detent: 0x25, vibration: 0x26, machine: 0x27 } as const
export const TRIGGER_BLOCK = 11
/** player_leds patterns [K], centred like the PS5's: index 0 = none lit, 1..5 = that many players. */
export const PLAYER_LEDS: readonly number[] = [0x00, 0x04, 0x0a, 0x15, 0x1b, 0x1f]
export const MAX_PLAYERS = PLAYER_LEDS.length - 1
/** The Edge's extra inputs, as DsPad.paddles bits [K][S] (buttons[2] >> 4). */
export const PADDLE = { fn1: 0x01, fn2: 0x02, left: 0x04, right: 0x08 } as const

const clampInt = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(Number.isFinite(v) ? v : lo)))

/** Effect 0x05: no resistance, trigger stop back to neutral [N]. */
export function writeTriggerOff(out: Uint8Array, at: number): void {
  out[at] = EFFECT.off
  out.fill(0, at + 1, at + TRIGGER_BLOCK)
}

/** The 10-bit mask of zones `from` .. 9 and the 3-bit-per-zone word of one `value` over them [N]. */
function zoneWords(from: number, value: number): { active: number; zones: number } {
  let zones = 0, active = 0
  for (let i = from; i < 10; i++) {
    zones |= (value & 0x07) << (3 * i) // highest bit used is 29: stays a positive int32
    active |= 1 << i
  }
  return { active, zones }
}

function writeZones(out: Uint8Array, at: number, mode: number, active: number, zones: number): void {
  out[at] = mode
  out[at + 1] = active & 0xff
  out[at + 2] = (active >>> 8) & 0xff
  out[at + 3] = zones & 0xff
  out[at + 4] = (zones >>> 8) & 0xff
  out[at + 5] = (zones >>> 16) & 0xff
  out[at + 6] = (zones >>> 24) & 0xff
  out.fill(0, at + 7, at + TRIGGER_BLOCK)
}

/**
 * Official "Feedback" effect [N]: resistance of `strength` (1..8) from zone `position` (0..9) to the end of
 * the travel. Position 0 makes it a continuous resistance over the whole pull. Strength 0 writes Off.
 */
export function writeTriggerFeedback(out: Uint8Array, at: number, position: number, strength: number): void {
  const pos = clampInt(position, 0, 9), str = clampInt(strength, 0, 8)
  if (str === 0) { writeTriggerOff(out, at); return }
  const z = zoneWords(pos, str - 1)
  writeZones(out, at, EFFECT.feedback, z.active, z.zones)
}

/**
 * Effect 0x25 [N]: a resistance of `strength` (1..8) from zone `start` (2..7) that gives way at zone `end`
 * (start + 1 .. 8) — a detent the finger pushes through. Strength 0 writes Off.
 */
export function writeTriggerDetent(out: Uint8Array, at: number, start: number, end: number, strength: number): void {
  const str = clampInt(strength, 0, 8)
  if (str === 0) { writeTriggerOff(out, at); return }
  const s = clampInt(start, 2, 7), e = clampInt(end, s + 1, 8)
  const mask = (1 << s) | (1 << e)
  out[at] = EFFECT.detent
  out[at + 1] = mask & 0xff
  out[at + 2] = (mask >>> 8) & 0xff
  out[at + 3] = (str - 1) & 0x07
  out.fill(0, at + 4, at + TRIGGER_BLOCK)
}

/**
 * Effect 0x26 [N]: a vibration of `amplitude` (1..8) from zone `position` (0..9) to the end of the travel, at
 * `frequency` (1..255, about Hz). Amplitude or frequency 0 writes Off.
 */
export function writeTriggerVibration(out: Uint8Array, at: number, position: number, amplitude: number, frequency: number): void {
  const pos = clampInt(position, 0, 9), amp = clampInt(amplitude, 0, 8), hz = clampInt(frequency, 0, 255)
  if (amp === 0 || hz === 0) { writeTriggerOff(out, at); return }
  const z = zoneWords(pos, amp - 1)
  writeZones(out, at, EFFECT.vibration, z.active, z.zones)
  out[at + 9] = hz
}

/**
 * Effect 0x22 "Bow" [N]: a resistance of `strength` (1..8) between zones `start` (0..7) and `end` (start + 1 .. 8)
 * that snaps back with `snap` (1..8) when released. Strength or snap 0 writes Off.
 */
export function writeTriggerBow(out: Uint8Array, at: number, start: number, end: number, strength: number, snap: number): void {
  const str = clampInt(strength, 0, 8), sn = clampInt(snap, 0, 8)
  if (str === 0 || sn === 0) { writeTriggerOff(out, at); return }
  const s = clampInt(start, 0, 7), e = clampInt(end, s + 1, 8)
  const mask = (1 << s) | (1 << e)
  const pair = ((str - 1) & 0x07) | (((sn - 1) & 0x07) << 3)
  out[at] = EFFECT.bow
  out[at + 1] = mask & 0xff
  out[at + 2] = (mask >>> 8) & 0xff
  out[at + 3] = pair & 0xff
  out[at + 4] = (pair >>> 8) & 0xff
  out.fill(0, at + 5, at + TRIGGER_BLOCK)
}

/**
 * Effect 0x23 "Galloping" [N]: two beats per cycle between zones `start` (0..8) and `end` (start + 1 .. 9), the
 * first at `first` (0..6) and the second at `second` (first + 1 .. 7), at `frequency` (1..255). Frequency 0 writes Off.
 */
export function writeTriggerGalloping(out: Uint8Array, at: number, start: number, end: number, first: number, second: number, frequency: number): void {
  const hz = clampInt(frequency, 0, 255)
  if (hz === 0) { writeTriggerOff(out, at); return }
  const s = clampInt(start, 0, 8), e = clampInt(end, s + 1, 9)
  const f = clampInt(first, 0, 6), sec = clampInt(second, f + 1, 7)
  const mask = (1 << s) | (1 << e)
  out[at] = EFFECT.galloping
  out[at + 1] = mask & 0xff
  out[at + 2] = (mask >>> 8) & 0xff
  out[at + 3] = (sec & 0x07) | ((f & 0x07) << 3)
  out[at + 4] = hz
  out.fill(0, at + 5, at + TRIGGER_BLOCK)
}

/**
 * Effect 0x27 "Machine" [N]: a buzz between zones `start` (0..8) and `end` (start + 1 .. 9) alternating the
 * amplitudes `a` and `b` (0..7) at `frequency` (1..255) with `period` (0..255). Frequency 0 writes Off.
 */
export function writeTriggerMachine(out: Uint8Array, at: number, start: number, end: number, a: number, b: number, frequency: number, period: number): void {
  const hz = clampInt(frequency, 0, 255)
  if (hz === 0) { writeTriggerOff(out, at); return }
  const s = clampInt(start, 0, 8), e = clampInt(end, s + 1, 9)
  const mask = (1 << s) | (1 << e)
  out[at] = EFFECT.machine
  out[at + 1] = mask & 0xff
  out[at + 2] = (mask >>> 8) & 0xff
  out[at + 3] = (clampInt(a, 0, 7) & 0x07) | ((clampInt(b, 0, 7) & 0x07) << 3)
  out[at + 4] = hz
  out[at + 5] = clampInt(period, 0, 255)
  out.fill(0, at + 6, at + TRIGGER_BLOCK)
}

/** Every effect an adaptive trigger can hold, in the units the writers above take. */
export type TriggerEffect =
  | { readonly kind: 'off' }
  | { readonly kind: 'feedback'; readonly position: number; readonly strength: number }
  | { readonly kind: 'detent'; readonly start: number; readonly end: number; readonly strength: number }
  | { readonly kind: 'vibration'; readonly position: number; readonly amplitude: number; readonly frequency: number }
  | { readonly kind: 'bow'; readonly start: number; readonly end: number; readonly strength: number; readonly snap: number }
  | { readonly kind: 'galloping'; readonly start: number; readonly end: number; readonly first: number; readonly second: number; readonly frequency: number }
  | { readonly kind: 'machine'; readonly start: number; readonly end: number; readonly a: number; readonly b: number; readonly frequency: number; readonly period: number }

export function writeTriggerEffect(out: Uint8Array, at: number, e: TriggerEffect): void {
  switch (e.kind) {
    case 'off': writeTriggerOff(out, at); break
    case 'feedback': writeTriggerFeedback(out, at, e.position, e.strength); break
    case 'detent': writeTriggerDetent(out, at, e.start, e.end, e.strength); break
    case 'vibration': writeTriggerVibration(out, at, e.position, e.amplitude, e.frequency); break
    case 'bow': writeTriggerBow(out, at, e.start, e.end, e.strength, e.snap); break
    case 'galloping': writeTriggerGalloping(out, at, e.start, e.end, e.first, e.second, e.frequency); break
    case 'machine': writeTriggerMachine(out, at, e.start, e.end, e.a, e.b, e.frequency, e.period); break
  }
}

/** HAL resistance 0..1 → Feedback strength 0..8. The dead band keeps a resting foot from stiffening the trigger. */
export function resistanceStrength(level: number): number {
  if (!(level > 0.02)) return 0
  return Math.min(8, Math.ceil(level * 8))
}

/** HAL rumble 0..1 → the heavy (left, low-frequency) motor byte, quantized to 32 steps so writes stay change-only. */
export function heavyMotor(level: number): number {
  if (!(level > 0)) return 0
  return Math.round((Math.round(Math.min(1, level) * 31) * 255) / 31)
}

/** The light (right, high-frequency) motor runs at half the heavy one. */
export function lightMotor(level: number): number {
  return heavyMotor(level * 0.5)
}

/** The throttle trigger's snap: a whole-travel vibration at this rate [N] (about Hz; a feel, not a spec). */
export const SNAP_HZ = 30

/**
 * What the HAL asks of a controller, in its own units (hal.ts HalOutputs is this shape). Brake and throttle
 * are the left and right triggers; the lightbar is 0xRRGGBB or −1 to leave the controller's own colour alone.
 */
export interface DsOutputs {
  /** 0..1, the brake (left) trigger's continuous resistance. */
  triggerResistance: number
  /** 0..1, the two motors. */
  rumble: number
  /** 0..1, the throttle (right) trigger's continuous resistance. */
  throttleResistance: number
  /** 0..1, a vibration on the throttle (right) trigger; while above 0 it replaces that trigger's resistance. */
  throttleVibration: number
  /** 0xRRGGBB, or −1: the lightbar is left alone. */
  lightbar: number
}

export const QUIET: Readonly<DsOutputs> = Object.freeze({ triggerResistance: 0, rumble: 0, throttleResistance: 0, throttleVibration: 0, lightbar: -1 })

/**
 * Quantized controller state: the two trigger-effect blocks as bytes (TRIGGER_BLOCK each), the motors 0..255,
 * the lightbar 0xRRGGBB or −1 (its valid flag stays clear), the player LED pattern 0..5 or −1 (left alone).
 */
export interface DsState { left: Uint8Array; right: Uint8Array; heavy: number; light: number; lightbar: number; players: number }

export function createState(): DsState {
  const s: DsState = { left: new Uint8Array(TRIGGER_BLOCK), right: new Uint8Array(TRIGGER_BLOCK), heavy: 0, light: 0, lightbar: -1, players: -1 }
  writeTriggerOff(s.left, 0)
  writeTriggerOff(s.right, 0)
  return s
}

export function copyState(from: Readonly<DsState>, to: DsState): void {
  to.left.set(from.left)
  to.right.set(from.right)
  to.heavy = from.heavy; to.light = from.light; to.lightbar = from.lightbar; to.players = from.players
}

const sameBytes = (a: Uint8Array, b: Uint8Array) => {
  for (let i = 0; i < TRIGGER_BLOCK; i++) if (a[i] !== b[i]) return false
  return true
}

export function sameState(a: Readonly<DsState>, b: Readonly<DsState>): boolean {
  return a.heavy === b.heavy && a.light === b.light && a.lightbar === b.lightbar && a.players === b.players && sameBytes(a.left, b.left) && sameBytes(a.right, b.right)
}

/** A lightbar word for the state: an integer 0..0xFFFFFF, anything else −1 (leave it alone). */
export function lightbarWord(v: number): number {
  return Number.isInteger(v) && v >= 0 && v <= 0xffffff ? v : -1
}

/**
 * HAL units → quantized state. `player` is the controller's seat 1..5 for the player LEDs (0 or more than 5: a
 * pattern is still written, none lit for 0 and all five past 5). The throttle's vibration wins over its resistance.
 */
export function stateFor(o: Readonly<DsOutputs>, player: number, out: DsState): DsState {
  writeTriggerFeedback(out.left, 0, 0, resistanceStrength(o.triggerResistance))
  const snap = resistanceStrength(o.throttleVibration)
  if (snap > 0) writeTriggerVibration(out.right, 0, 0, snap, SNAP_HZ)
  else writeTriggerFeedback(out.right, 0, 0, resistanceStrength(o.throttleResistance))
  out.heavy = heavyMotor(o.rumble)
  out.light = lightMotor(o.rumble)
  out.lightbar = lightbarWord(o.lightbar)
  out.players = clampInt(player, 0, MAX_PLAYERS)
  return out
}

/**
 * The 47-byte common block: both trigger effects + compatible rumble, the lightbar and player LEDs when the state
 * has them (otherwise their valid flags stay clear and the controller keeps its own; audio and the mute LED are
 * never touched). Every report carries the full state.
 */
export function fillCommon(out: Uint8Array, at: number, s: Readonly<DsState>, vibrationV2: boolean): void {
  out.fill(0, at, at + COMMON.length)
  out[at + COMMON.flag0] = FLAG0.leftTrigger | FLAG0.rightTrigger | FLAG0.hapticsSelect | (vibrationV2 ? 0 : FLAG0.compatibleVibration)
  out[at + COMMON.motorRight] = clampInt(s.light, 0, 255)
  out[at + COMMON.motorLeft] = clampInt(s.heavy, 0, 255)
  out.set(s.right.subarray(0, TRIGGER_BLOCK), at + COMMON.rightTrigger)
  out.set(s.left.subarray(0, TRIGGER_BLOCK), at + COMMON.leftTrigger)
  let flag1 = 0
  if (s.lightbar >= 0) {
    flag1 |= FLAG1.lightbar
    out[at + COMMON.red] = (s.lightbar >>> 16) & 0xff
    out[at + COMMON.green] = (s.lightbar >>> 8) & 0xff
    out[at + COMMON.blue] = s.lightbar & 0xff
  }
  if (s.players >= 0) {
    flag1 |= FLAG1.playerLeds
    out[at + COMMON.playerLeds] = PLAYER_LEDS[clampInt(s.players, 0, MAX_PLAYERS)]
  }
  out[at + COMMON.flag1] = flag1
  if (vibrationV2) out[at + COMMON.flag2] = FLAG2.compatibleVibration2
}

/**
 * The common block of the one report sent before any state [K] dualsense_reset_leds: lightbar setup LIGHT_OUT
 * and nothing else, so a Bluetooth pairing's lightbar animation ends and the host's colour can show.
 */
export function fillLightbarSetup(out: Uint8Array, at: number): void {
  out.fill(0, at, at + COMMON.length)
  out[at + COMMON.flag2] = FLAG2.lightbarSetup
  out[at + COMMON.lightbarSetup] = LIGHTBAR_SETUP.lightOut
}

// CRC-32 (IEEE 802.3, reflected, polynomial 0xEDB88320) — the kernel's crc32_le with ~0 in and ~ out.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

const crcStep = (c: number, byte: number) => CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)

/** Plain CRC-32 of `bytes` (check value: "123456789" → 0xCBF43926). */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = crcStep(c, bytes[i])
  return (c ^ 0xffffffff) >>> 0
}

/** CRC-32 over [seed, reportId, data[0..length)] — the Bluetooth report checksum [K]. */
export function reportCrc(seed: number, reportId: number, data: Uint8Array | DataView, length: number): number {
  let c = crcStep(crcStep(0xffffffff, seed), reportId)
  if (data instanceof Uint8Array) for (let i = 0; i < length; i++) c = crcStep(c, data[i])
  else for (let i = 0; i < length; i++) c = crcStep(c, data.getUint8(i))
  return (c ^ 0xffffffff) >>> 0
}

type Fill = (out: Uint8Array, at: number) => void

/** USB output report 0x02 data (report ID excluded). `out` may be longer than 47 (descriptor padding): zeroed. */
function frameUsb(out: Uint8Array, fill: Fill): void {
  out.fill(0)
  fill(out, COMMON_AT.usb)
}

/**
 * Bluetooth output report 0x31 data (77 bytes, report ID excluded) [K]:
 *   [0] sequence << 4 | 0   [1] tag 0x10   [2..48] common block   [49..72] zero   [73..76] CRC-32 LE
 * with the CRC over 0xA2, 0x31 and data[0..72].
 */
function frameBt(out: Uint8Array, seq: number, fill: Fill): void {
  out.fill(0)
  out[0] = (seq & 0x0f) << 4
  out[1] = DS.btTag
  fill(out, COMMON_AT.bluetooth)
  const end = DS.btOutputLength - 4
  const crc = reportCrc(DS.outputCrcSeed, DS.btOutputId, out, end)
  out[end] = crc & 0xff
  out[end + 1] = (crc >>> 8) & 0xff
  out[end + 2] = (crc >>> 16) & 0xff
  out[end + 3] = (crc >>> 24) & 0xff
}

export function buildUsbReport(out: Uint8Array, s: Readonly<DsState>, vibrationV2: boolean): void {
  frameUsb(out, (o, at) => fillCommon(o, at, s, vibrationV2))
}

export function buildBtReport(out: Uint8Array, s: Readonly<DsState>, vibrationV2: boolean, seq: number): void {
  frameBt(out, seq, (o, at) => fillCommon(o, at, s, vibrationV2))
}

export function buildUsbSetup(out: Uint8Array): void {
  frameUsb(out, fillLightbarSetup)
}

export function buildBtSetup(out: Uint8Array, seq: number): void {
  frameBt(out, seq, fillLightbarSetup)
}

/** WebHID hides the bus; the Bluetooth descriptor is the one declaring output report 0x31. */
export function detectBus(collections: readonly HidCollectionInfo[]): DsBus {
  for (const c of collections) for (const r of c.outputReports ?? []) if (r.reportId === DS.btOutputId) return 'bluetooth'
  return 'usb'
}

/** Declared data length of an output report in bytes (0 when the descriptor does not say). */
export function outputLength(collections: readonly HidCollectionInfo[], reportId: number): number {
  let bits = 0
  for (const c of collections) for (const r of c.outputReports ?? []) {
    if (r.reportId !== reportId) continue
    for (const it of r.items ?? []) bits += (it.reportSize ?? 0) * (it.reportCount ?? 0)
  }
  return Math.floor(bits / 8)
}

export interface DsFirmware { hardware: number; firmware: number; update: number }

/**
 * Feature report 0x20 [K]: hardware u32 @24, firmware u32 @28, update version u16 @44 (offsets include the
 * report ID). Whether the browser keeps that ID byte varies [W]; byte 1 is the ASCII build date ("Jun …"), so
 * a leading 0x20 means the ID is present.
 */
export function parseFirmwareInfo(view: DataView): DsFirmware | null {
  const shift = view.byteLength >= 64 && view.getUint8(0) === DS.firmwareInfoId ? 0 : -1
  if (view.byteLength + shift < 46) return null
  return {
    hardware: view.getUint32(24 + shift, true),
    firmware: view.getUint32(28 + shift, true),
    update: view.getUint16(44 + shift, true),
  }
}

/** [K]: Edge always; the original DualSense from feature version 2.21 (0x0215). Unknown firmware → classic mode. */
export function wantsVibrationV2(productId: number, update: number | undefined): boolean {
  if (productId === 0x0df2) return true
  return update !== undefined && update >= 0x0215
}

export function formatUpdateVersion(update: number): string {
  return `${update >>> 8}.${String(update & 0xff).padStart(2, '0')}`
}

/** A standard-mapped pad fed from the full input report (the Gamepad API cannot parse that report mode). */
export class DsPad {
  readonly id: string
  readonly index: number
  readonly mapping = 'standard'
  /** A DualSense Edge: its Fn keys and back paddles are read into `paddles`. */
  readonly edge: boolean
  connected = true
  timestamp = 0
  readonly axes = [0, 0, 0, 0]
  readonly buttons: { pressed: boolean; value: number }[] = []
  /** PADDLE bits held right now (always 0 on a plain DualSense). */
  paddles = 0
  constructor(id: string, index: number, edge = false) {
    this.id = id
    this.index = index
    this.edge = edge
    for (let i = 0; i < 18; i++) this.buttons.push({ pressed: false, value: 0 })
  }
}

const stickAxis = (v: number) => Math.max(-1, Math.min(1, (v - 128) / 127))

function setButton(pad: DsPad, i: number, on: boolean, value = on ? 1 : 0): void {
  const b = pad.buttons[i]
  b.pressed = on
  b.value = value
}

/**
 * Decodes struct dualsense_input_report [K] starting at `at` (USB report 0x01 data: 0; Bluetooth 0x31 data: 1):
 * x y rx ry z rz seq buttons[4]. Hat 0..7 clockwise from north, 8 = released.
 */
export function decodeInput(data: DataView, at: number, pad: DsPad, now: number): void {
  pad.axes[0] = stickAxis(data.getUint8(at))
  pad.axes[1] = stickAxis(data.getUint8(at + 1))
  pad.axes[2] = stickAxis(data.getUint8(at + 2))
  pad.axes[3] = stickAxis(data.getUint8(at + 3))
  const l2 = data.getUint8(at + 4) / 255, r2 = data.getUint8(at + 5) / 255
  const b0 = data.getUint8(at + 7), b1 = data.getUint8(at + 8), b2 = data.getUint8(at + 9)
  setButton(pad, 0, (b0 & 0x20) !== 0) // cross
  setButton(pad, 1, (b0 & 0x40) !== 0) // circle
  setButton(pad, 2, (b0 & 0x10) !== 0) // square
  setButton(pad, 3, (b0 & 0x80) !== 0) // triangle
  setButton(pad, 4, (b1 & 0x01) !== 0) // L1
  setButton(pad, 5, (b1 & 0x02) !== 0) // R1
  setButton(pad, 6, (b1 & 0x04) !== 0 || l2 > 0.5, l2)
  setButton(pad, 7, (b1 & 0x08) !== 0 || r2 > 0.5, r2)
  setButton(pad, 8, (b1 & 0x10) !== 0) // create
  setButton(pad, 9, (b1 & 0x20) !== 0) // options
  setButton(pad, 10, (b1 & 0x40) !== 0) // L3
  setButton(pad, 11, (b1 & 0x80) !== 0) // R3
  const hat = b0 & 0x0f
  setButton(pad, 12, hat === 7 || hat === 0 || hat === 1)
  setButton(pad, 13, hat >= 3 && hat <= 5)
  setButton(pad, 14, hat >= 5 && hat <= 7)
  setButton(pad, 15, hat >= 1 && hat <= 3)
  setButton(pad, 16, (b2 & 0x01) !== 0) // PS
  setButton(pad, 17, (b2 & 0x02) !== 0) // touchpad click
  // The Edge's Fn1, Fn2, left and right paddle are bits 4..7 of buttons[2] [K]; a plain DualSense keeps them reserved.
  pad.paddles = pad.edge ? (b2 >>> 4) & 0x0f : 0
  pad.timestamp = now
}

export interface DualSenseOptions {
  now?: () => number
  /** Minimum spacing of output reports, ms. */
  minIntervalMs?: number
  /** Called after a failed write (message) or a recovered one (''). */
  onStatus?: (error: string) => void
  /** Synthetic Gamepad index for the decoded pad. */
  padIndex?: number
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A failed write leaves the controller's state unknown (it may still hold resistance): resend after this. */
const RETRY_MS = 250

/**
 * Open/close of one HID device run strictly one after another, across driver instances too (a bus disposed while
 * a new one opens the same controller, e.g. React StrictMode's double mount): without it one instance's close()
 * can shut the device under the other, or an open() finishing after close() leaves a listener and an open device.
 */
const DEVICE_QUEUE = new WeakMap<HidDevice, Promise<unknown>>()
/** The newest driver of each device; opening a device hands it over (the previous driver is closed first). */
const DEVICE_OWNER = new WeakMap<HidDevice, DualSense>()

function serialized<T>(device: HidDevice, job: () => Promise<T>): Promise<T> {
  const next = (DEVICE_QUEUE.get(device) ?? Promise.resolve()).then(job, job)
  DEVICE_QUEUE.set(device, next.catch(() => {}))
  return next
}

/** Effects off, motors still, lightbar and player LEDs left alone: the state of a close, a panic or a page out of sight. */
function neutral(s: DsState): void {
  writeTriggerOff(s.left, 0)
  writeTriggerOff(s.right, 0)
  s.heavy = 0; s.light = 0; s.lightbar = -1; s.players = -1
}

/**
 * One opened controller. Writes are change-only, rate-limited, one in flight, from a reused buffer, and only
 * after open() has learned the bus; a failed write is retried (the controller may still hold resistance).
 */
export class DualSense {
  readonly device: HidDevice
  readonly name: string
  readonly pad: DsPad
  /** A DualSense Edge (product 0x0df2): vibration v2 always, paddles in the input report. */
  readonly edge: boolean
  bus: DsBus = 'usb'
  vibrationV2 = false
  firmware: DsFirmware | null = null
  writes = 0
  failures = 0
  crcFailures = 0
  private readonly now: () => number
  private readonly minInterval: number
  private readonly onStatus: (error: string) => void
  private buf = new Uint8Array(DS.usbOutputLength)
  private reportId: number = DS.usbOutputId
  private seq = 0
  private readonly want: DsState = createState()
  private readonly sent: DsState = createState()
  /** `sent` describes a report that went out (false until the first write). */
  private sentKnown = false
  private readonly scratch: DsState = createState()
  private inFlight: Promise<void> | null = null
  private lastWrite = -1e9
  private lastFail = -1e9
  private lastInput = -1e9
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = 0
  /** Bus, report size and firmware are known: only then may the pump write (never a USB report to a BT pad). */
  private ready = false
  private closed = false
  private closing: Promise<void> | null = null
  /** The last write failed: the device state is unknown, so `sent` is resent after RETRY_MS. */
  private stale = false
  private failing = false

  constructor(device: HidDevice, opts: DualSenseOptions = {}) {
    this.device = device
    this.name = dualSenseName(device.productId)
    this.edge = device.productId === DUALSENSE_EDGE_PRODUCT_ID
    this.now = opts.now ?? (() => performance.now())
    this.minInterval = opts.minIntervalMs ?? 25
    this.onStatus = opts.onStatus ?? (() => {})
    this.pad = new DsPad(`${this.name} (HID)`, opts.padIndex ?? 16, this.edge)
  }

  /**
   * Opens the device, learns bus and firmware, sends the lightbar setup report (the host takes the bar) and then
   * the current state (neutral unless set() ran meanwhile) so a stale effect cannot linger. Rejects if close()
   * was called before it finished (the device is then reset and closed again, whatever point the open had reached).
   */
  open(): Promise<void> {
    const d = this.device
    const prev = DEVICE_OWNER.get(d)
    if (prev && prev !== this) void prev.close()
    DEVICE_OWNER.set(d, this)
    return serialized(d, () => this.openNow())
  }

  private async openNow(): Promise<void> {
    const d = this.device
    const abandoned = async () => {
      await this.release()
      return new Error(`${this.name} closed while opening`)
    }
    if (this.closed) throw await abandoned()
    if (!d.opened) await d.open()
    this.configure()
    if (this.closed) throw await abandoned()
    try { this.firmware = parseFirmwareInfo(await d.receiveFeatureReport(DS.firmwareInfoId)) } catch { this.firmware = null }
    if (this.closed) throw await abandoned()
    this.vibrationV2 = wantsVibrationV2(d.productId, this.firmware?.update)
    if (this.bus === 'bluetooth') d.addEventListener('inputreport', this.onInput)
    this.ready = true
    await this.writeSetup()
    if (this.closed) throw await abandoned()
    await this.write(true)
    if (this.closed) throw await abandoned()
  }

  /** Bus, report ID and report size from the descriptor (synchronous; needed before any byte is written). */
  private configure(): void {
    const d = this.device
    this.bus = detectBus(d.collections)
    const bt = this.bus === 'bluetooth'
    this.reportId = bt ? DS.btOutputId : DS.usbOutputId
    const need = bt ? DS.btOutputLength : DS.usbOutputLength
    const declared = outputLength(d.collections, this.reportId)
    this.buf = new Uint8Array(bt ? need : Math.max(need, declared))
  }

  describe(): string {
    const fw = this.firmware ? ` · fw ${formatUpdateVersion(this.firmware.update)}` : ''
    return `both triggers + rumble${this.vibrationV2 ? ' (v2)' : ''} + lightbar${this.edge ? ' + paddles' : ''}${fw}`
  }

  /** Decoded Bluetooth input is arriving with valid CRCs, so the browser's own pad for it is redundant. */
  inputLive(now: number = this.now()): boolean {
    return now - this.lastInput < 250
  }

  /**
   * Desired outputs in HAL units; `player` (1..5) lights the controller's seat on the player LEDs. Returns true
   * when the quantized state changed (a write is then scheduled).
   */
  set(o: Readonly<DsOutputs>, player = 0): boolean {
    if (this.closed) return false
    const next = stateFor(o, player, this.scratch)
    if (sameState(next, this.want)) return false
    copyState(next, this.want)
    this.pump()
    return true
  }

  /** Effects off and motors still; the lightbar and player LEDs stay (the page is out of sight, not gone). */
  quiet(): void {
    if (this.closed) return
    const w = this.want
    writeTriggerOff(w.left, 0)
    writeTriggerOff(w.right, 0)
    w.heavy = 0; w.light = 0
    this.pump()
  }

  /** Unawaited neutral report for page teardown, bypassing the rate limit (separate buffer). */
  panic(): void {
    if (this.closed || !this.ready || !this.device.opened) return
    const buf = new Uint8Array(this.buf.length)
    const zero = createState()
    if (this.bus === 'bluetooth') {
      buildBtReport(buf, zero, this.vibrationV2, this.seq)
      this.seq = (this.seq + 1) & 0x0f
    } else buildUsbReport(buf, zero, this.vibrationV2)
    copyState(zero, this.sent)
    this.sentKnown = true
    try { this.device.sendReport(this.reportId, buf).catch(() => {}) } catch { /* teardown: nothing left to do */ }
  }

  /** Resets the trigger effect and motors, then closes the device. Idempotent: every call shares one close. */
  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true
      this.clearTimer()
      neutral(this.want)
      this.closing = serialized(this.device, () => this.release())
    }
    return this.closing
  }

  /** Neutral report (if the device is open), listener off, device closed. Safe to run more than once. */
  private async release(): Promise<void> {
    const d = this.device
    this.clearTimer()
    try { if (this.inFlight) await this.inFlight } catch { /* reported already */ }
    // Never reset or close a session a newer driver has already opened on this device.
    const owner = DEVICE_OWNER.get(d)
    const foreign = owner !== undefined && owner !== this && owner.ready
    try {
      if (d.opened && !foreign) {
        if (!this.ready) this.configure()
        neutral(this.want)
        await this.write(true)
      }
    } catch { /* the device may already be gone */ }
    d.removeEventListener('inputreport', this.onInput)
    this.ready = false
    this.pad.connected = false
    try { if (d.opened && !foreign) await d.close() } catch { /* ignore */ }
    if (DEVICE_OWNER.get(d) === this) DEVICE_OWNER.delete(d)
  }

  private clearTimer(): void {
    if (this.timer !== null) { clearTimeout(this.timer); this.timer = null }
  }

  private readonly onInput = (e: HidInputReportEvent): void => {
    const data = e.data
    if (e.reportId !== DS.btInputId || data.byteLength < DS.btInputLength) return
    const end = DS.btInputLength - 4
    const crc = reportCrc(DS.inputCrcSeed, DS.btInputId, data, end)
    if (crc !== data.getUint32(end, true)) { this.crcFailures++; return }
    const now = this.now()
    decodeInput(data, 1, this.pad, now)
    this.lastInput = now
  }

  /** Writes when the state changed (rate-limited) or when a failed write must be retried (backed off). */
  private pump(): void {
    if (this.closed || !this.ready || this.inFlight) return
    const changed = !this.sentKnown || !sameState(this.want, this.sent)
    if (!changed && !this.stale) return
    const due = changed ? this.lastWrite + this.minInterval : this.lastFail + RETRY_MS
    const wait = due - this.now()
    if (wait > 0) {
      if (this.timer !== null && this.timerAt <= due) return
      this.clearTimer()
      this.timerAt = due
      this.timer = setTimeout(() => { this.timer = null; this.pump() }, Math.ceil(wait))
      return
    }
    void this.write()
  }

  /** The lightbar setup report [K], once after open; a failure counts like any write's and fails the open. */
  private async writeSetup(): Promise<void> {
    if (this.bus === 'bluetooth') {
      buildBtSetup(this.buf, this.seq)
      this.seq = (this.seq + 1) & 0x0f
    } else buildUsbSetup(this.buf)
    this.lastWrite = this.now()
    try {
      await this.device.sendReport(this.reportId, this.buf)
      this.writes++
    } catch (e) {
      this.failures++
      this.onStatus(errorText(e))
      throw e
    }
  }

  /**
   * Sends `want`. The buffer is never touched while a send is in flight (WebHID reads it in parallel [W]).
   * `rethrow` is for open/close, which must know; the pump path only reports through onStatus.
   */
  private write(rethrow = false): Promise<void> {
    const w = this.want
    if (this.bus === 'bluetooth') {
      buildBtReport(this.buf, w, this.vibrationV2, this.seq)
      this.seq = (this.seq + 1) & 0x0f
    } else buildUsbReport(this.buf, w, this.vibrationV2)
    copyState(w, this.sent)
    this.sentKnown = true
    this.lastWrite = this.now()
    let sending: Promise<void>
    try { sending = this.device.sendReport(this.reportId, this.buf) } catch (e) { sending = Promise.reject(e) }
    const p = sending.then(
      () => {
        this.writes++
        this.stale = false
        if (this.failing) { this.failing = false; this.onStatus('') }
      },
      (e: unknown) => {
        this.failures++
        this.stale = true
        this.lastFail = this.now()
        this.failing = true
        this.onStatus(errorText(e))
        if (rethrow) throw e
      },
    ).finally(() => {
      this.inFlight = null
      this.pump()
    })
    this.inFlight = p
    return p
  }
}
