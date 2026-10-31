// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the universal hardware abstraction layer: one bus that discovers, pairs,
 * labels and feeds every optional device the city can talk to — DualSense / DualSense Edge over WebHID, or
 * over the desktop shell's own HID commands inside the Windows app (nativeHid.ts): both triggers, rumble,
 * the lightbar and the player LEDs; HAL/1 line-protocol gadgets over Web Serial or Bluetooth LE (telemetry, and
 * the robot side of the joint bridge, docs/joint-bridge-spec.md §3.1: the device's CAPS, its JOINTS manifest, JS
 * frames judged against it, JA acks and the gate's ARMED / BEAT / DISARM in, the page's control lines and JT
 * setpoints out; the gate itself is the page's, robotLink.ts, this bus keeps no policy state); and Gamepad API pads
 * (rumble) — behind one transport-neutral API. Every browser API it touches is optional: where WebHID, Web Serial or
 * Web Bluetooth are missing (Safari, Firefox, iOS) it reports them unsupported and does nothing, silently.
 * What breaks if it is removed? Input.hal, the Ring-0 terminal's `hal` command, the HUD device line and the serial
 * door of the joint bridge.
 */
import { BRAND } from '../brand.ts'
import { describeResolution, padClues, resolveDevice, xrClues } from './devices.ts'
import { DUALSENSE_FILTERS, DualSense, dualSenseName, isDualSense, lightbarWord, QUIET, type DsOutputs } from './dualsense.ts'
import { isUsablePad, padName, parsePadId, pressesFaceButton, type GenericLayout } from './gamepad.ts'
import { checkFrame, JOINT_LINE, ManifestAssembler, parseJointLine, type JointFrame, type JointLine, type Manifest } from './jointState.ts'
import { LineLink, NUS, openBle, openSerial, type ByteChannel } from './lineLink.ts'
import { nativeNavigator } from './nativeHid.ts'
import { LEGACY_CAPABILITIES, parseCapabilities, type Capabilities } from './peripheralPolicy.ts'
import type { BleDevice, GamepadLike, HardwareNavigator, HidConnectionEvent, HidDevice, SerialConnectionEvent, SerialPort, XrInputSourceLike } from './web-hardware.d.ts'

/** 'xr' is a headset session's input source (xrInput.ts), listed here and never paired: the session brings it. */
export type Transport = 'hid' | 'serial' | 'bluetooth' | 'gamepad' | 'xr'

export interface HalDevice {
  id: string
  transport: Transport
  name: string
  state: 'handshaking' | 'ready' | 'error' | 'disconnected'
  detail: string
  /** The device resolver's word (devices.ts describeResolution) for an input device; absent on a HAL/1 link. */
  profile?: string
  /** A HAL/1 device that announced a manifest: its movable joint count, the manifest's robot name, and whether the page armed it. */
  robot?: { joints: number; name: string; armed: boolean }
}

/**
 * The robot side of a HAL/1 device (docs/joint-bridge-spec.md §3.1): listed from the moment its manifest is in until
 * the device drops. A snapshot: robots() builds it fresh each call.
 */
export interface HalRobot {
  /** `hal:<device id>` (spec §2): the one id robots(), every HalRobotEvent and every robot method of this bus share. */
  id: string
  /** The manifest's robot name. */
  name: string
  transport: Transport
  manifest: Manifest
  /** From the CAPS line; LEGACY_CAPABILITIES when none (or a refused one) came: a sensor, which the gate never arms. */
  caps: Capabilities
  /** The newest frame that passed checkFrame, and the bus clock when it came (0 while frame is null). */
  frame: JointFrame | null
  frameAt: number
  /** Frames accepted, and frames refused (not JSON, wrong length, non-finite, or before any manifest). */
  frames: number
  badFrames: number
  /** The newest seq the device said it applied (JA, or a frame's ack); −1 until it said one. */
  ack: number
  /** Set by the page (markArmed) when its gate armed the robot; while set, a new JOINTS does not replace the manifest. */
  armed: boolean
}

/** What a robot's device said, in the order it said it; 'gone' is the last word about an id (the device dropped). */
export type HalRobotEvent =
  | { kind: 'manifest'; id: string; manifest: Manifest }
  | { kind: 'frame'; id: string; frame: JointFrame; at: number }
  | { kind: 'ack'; id: string; seq: number }
  | { kind: 'armed'; id: string; nonce: string }
  | { kind: 'beat'; id: string; n: number }
  | { kind: 'disarm'; id: string; cause: string }
  | { kind: 'gone'; id: string }

/**
 * What the page asks of its controllers: brake-trigger resistance, rumble, the throttle trigger's hold or snap
 * and a lightbar colour (dualsense.ts DsOutputs). Pads without a HID driver get the rumble alone.
 */
export type HalOutputs = DsOutputs

export interface HalOptions {
  /** Defaults to globalThis.navigator; null disables every transport. */
  navigator?: HardwareNavigator | null
  brand?: { name: string; version: string }
  now?: () => number
  /** Minimum spacing of DualSense output reports, ms. */
  hidIntervalMs?: number
  /** Bluetooth connect + service discovery budget, ms. */
  bleConnectMs?: number
}

/**
 * The seating plan the player LEDs follow (seats.ts SeatTable satisfies it): how many seats are in play, and the
 * seat the pad at an index holds (−1 none). Input hands the bus its table once; the bus reads it at every push.
 */
export interface SeatSource {
  readonly players: number
  seatOf(padIndex: number): number
}

interface Entry {
  dev: HalDevice
  key: unknown
  ds?: DualSense
  link?: LineLink
  /** The robot side of a line link's session: made with the link, cleared (with 'gone') when the session ends. */
  robot?: RobotState
}

interface RobotState {
  id: string
  caps: Capabilities
  assembler: ManifestAssembler
  manifest: Manifest | null
  frame: JointFrame | null
  frameAt: number
  frames: number
  badFrames: number
  ack: number
  armed: boolean
}

/** The gate's lines a device says (docs/hal-peripherals-spec.md §3); the page's policy reads them through HalRobotEvent. */
const GATE_WORD = /^(ARMED|BEAT|DISARM)(?:[ \t]+(.*))?$/

interface PadSlot {
  dev: HalDevice
  index: number
  id: string
  /** A standard pad, or one without the mapping whose face button has been pressed: passed on to the mapper. */
  awake: boolean
  /** For a pad read by position, the layout GenericPads settled on (padLayout); null until it has. */
  layout: GenericLayout | null
  vendor: number
  product: number
  pad: GamepadLike
  frame: number
  /** Frame in which this pad was hidden as the browser's mirror of a HID-decoded controller. */
  hidden: number
  rumble: number
  rumbleAt: number
}

/** Gamepad rumble is a timed effect: re-issued while held so it never lapses between frames. */
const PAD_RUMBLE = { durationMs: 250, refreshMs: 150, minGapMs: 50, steps: 16 } as const
const TELEMETRY_MS = 100
const LABEL: Readonly<Record<'hid' | 'serial' | 'bluetooth', string>> = { hid: 'WebHID', serial: 'Web Serial', bluetooth: 'Web Bluetooth' }

const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0)
const hex4 = (n: number) => n.toString(16).padStart(4, '0')
const errorName = (e: unknown) => (typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : '')
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
/** Reads live state (TypeScript would otherwise keep a pre-await narrowing). */
const gone = (e: { dev: HalDevice }) => e.dev.state === 'disconnected'
/**
 * The hardware list's word on a pad without the standard mapping: whether gamepad.ts GenericPads reads it, and whether
 * it has been woken (readPads passes such a pad on only after one of its first four buttons is pressed).
 */
function genericDetail(p: GamepadLike, awake: boolean): string {
  if (!isUsablePad(p)) return 'non-standard mapping (ignored: no stick)'
  return awake ? 'non-standard mapping (best guess by position)' : 'non-standard mapping (press a face button on it to use it)'
}
/** A row as handed out: its own object, with the optional fields present only when set (callers compare rows whole). */
function copy(d: HalDevice): HalDevice {
  const c: HalDevice = { id: d.id, transport: d.transport, name: d.name, state: d.state, detail: d.detail }
  if (d.profile !== undefined) c.profile = d.profile
  if (d.robot) c.robot = { joints: d.robot.joints, name: d.robot.name, armed: d.robot.armed }
  return c
}

/** The browser's navigator; inside the desktop shell, with the shell's own HID in the place of WebView2's. */
function defaultNavigator(): HardwareNavigator | null {
  const g = globalThis as { navigator?: HardwareNavigator }
  return nativeNavigator(g.navigator ?? null)
}

const guard = (f: () => void) => { try { f() } catch { /* API present but blocked */ } }

/** Runs a browser call that may throw synchronously (permissions policy) or reject; never fails. */
function quietly(f: () => Promise<unknown>): Promise<void> {
  try { return f().then(() => {}, () => {}) } catch { return Promise.resolve() }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then((v) => { clearTimeout(t); resolve(v) }, (e: unknown) => { clearTimeout(t); reject(e) })
  })
}

type DomLike = { addEventListener?(t: string, f: () => void): void; removeEventListener?(t: string, f: () => void): void; visibilityState?: string }

export class HalBus {
  private readonly nav: HardwareNavigator | null
  private readonly brand: { name: string; version: string }
  private readonly now: () => number
  private readonly hidInterval: number
  private readonly bleConnectMs: number
  private readonly entries: Entry[] = []
  private readonly slots: PadSlot[] = []
  /** The headset session's input sources as rows (setHeadset); empty outside a session. */
  private readonly headset: HalDevice[] = []
  private readonly padList: GamepadLike[] = []
  private readonly want: HalOutputs = { ...QUIET }
  private readonly unlisten: (() => void)[] = []
  private readonly robotListeners = new Set<(e: HalRobotEvent) => void>()
  private listening = false
  private disposed = false
  private hidden = false
  private frame = 0
  private serialNo = 0
  private lastTelemetry = -1e9

  /** The seating plan the player LEDs follow (seatPads); null = one seat, every controller player 1. */
  private seats: SeatSource | null = null
  /** The pad frame readPads synced last (syncPads); a slot hidden in it mirrors a decoded controller. */
  private padFrame = 0
  /** The navigator was this bus's own (defaultNavigator): its shell HID, if any, is disposed with the bus. */
  private readonly ownsNav: boolean

  constructor(opts: HalOptions = {}) {
    this.ownsNav = opts.navigator === undefined
    this.nav = this.ownsNav ? defaultNavigator() : (opts.navigator ?? null)
    this.brand = opts.brand ?? { name: BRAND.short, version: BRAND.version }
    this.now = opts.now ?? (() => performance.now())
    this.hidInterval = opts.hidIntervalMs ?? 25
    this.bleConnectMs = opts.bleConnectMs ?? 10000
  }

  /** The four pairable or pollable APIs; a headset is not among them (the session is asked for elsewhere, xrSession.ts). */
  support(): Record<Exclude<Transport, 'xr'>, boolean> {
    const n = this.nav
    return {
      hid: !!n?.hid,
      serial: !!n?.serial,
      bluetooth: !!n?.bluetooth,
      gamepad: typeof n?.getGamepads === 'function',
    }
  }

  /**
   * The headset session's input sources (its live list, or null when it ends), as rows: a tracked controller, a
   * pinch or a hand each with the resolver's profile, named by its hand and its most specific input profile.
   */
  setHeadset(list: ArrayLike<XrInputSourceLike> | null): void {
    const rows = this.headset
    rows.length = 0
    if (!list) return
    for (let i = 0; i < list.length; i++) {
      const s = list[i]
      const r = resolveDevice(xrClues(s))
      const hand = s.handedness === 'left' || s.handedness === 'right' ? ` (${s.handedness})` : ''
      rows.push({
        id: `xr:${i}`,
        transport: 'xr',
        name: `${r.profile.name}${hand}`,
        state: 'ready',
        detail: `${typeof s.targetRayMode === 'string' && s.targetRayMode ? s.targetRayMode : 'no target ray'}${s.profiles?.[0] ? `, ${s.profiles[0]}` : ''}`,
        profile: describeResolution(r),
      })
    }
  }

  /** Re-opens devices this origin was granted before, and follows plug/unplug events. Never prompts. */
  async autoconnect(): Promise<void> {
    const n = this.nav
    if (!n || this.disposed) return
    this.listen()
    const hid = n.hid, serial = n.serial, ble = n.bluetooth
    await Promise.all([
      hid && quietly(() => hid.getDevices().then((list) => Promise.all(list.filter((d) => isDualSense(d.vendorId, d.productId)).map((d) => this.openHid(d))))),
      serial && quietly(() => serial.getPorts().then((list) => Promise.all(list.map((p) => this.openSerialPort(p))))),
      ble?.getDevices && quietly(() => ble.getDevices!().then((list) => Promise.all(list.map((d) => this.openBleDevice(d, true))))),
    ])
  }

  /**
   * Shows the browser's device chooser. It is requested synchronously, so call this directly inside a click or
   * key handler (the browser demands a user gesture). Resolves null when the person cancels; an unsupported
   * transport or a refused request resolves a device in state 'error' whose detail says why (not listed).
   */
  pair(kind: 'hid' | 'serial' | 'bluetooth'): Promise<HalDevice | null> {
    const n = this.nav
    if (this.disposed) return Promise.resolve(null)
    const refused = (e: unknown): HalDevice | null => {
      const name = errorName(e)
      if (name === 'NotFoundError' || name === 'AbortError') return null
      return { id: `${kind}:request`, transport: kind, name: LABEL[kind], state: 'error', detail: errorText(e) }
    }
    try {
      if (kind === 'hid' && n?.hid) {
        const request = n.hid.requestDevice({ filters: DUALSENSE_FILTERS.map((f) => ({ vendorId: f.vendorId, productId: f.productId })) })
        this.listen()
        return request.then(async (list) => {
          const mine = list.filter((d) => isDualSense(d.vendorId, d.productId))
          if (!mine.length) return null
          const opened = await Promise.all(mine.map((d) => this.openHid(d)))
          return opened[0]
        }, refused)
      }
      if (kind === 'serial' && n?.serial) {
        const request = n.serial.requestPort()
        this.listen()
        return request.then((p) => this.openSerialPort(p), refused)
      }
      if (kind === 'bluetooth' && n?.bluetooth) {
        const request = n.bluetooth.requestDevice({ filters: [{ services: [NUS.service] }], optionalServices: [NUS.service] })
        this.listen()
        return request.then((d) => this.openBleDevice(d, false), refused)
      }
    } catch (e) {
      return Promise.resolve(refused(e))
    }
    return Promise.resolve({ id: `${kind}:request`, transport: kind, name: LABEL[kind], state: 'error', detail: `${LABEL[kind]} is not available in this browser` })
  }

  devices(): HalDevice[] {
    const out: HalDevice[] = []
    for (const e of this.entries) out.push(copy(e.dev))
    for (const s of this.slots) out.push(copy(s.dev))
    for (const h of this.headset) out.push(copy(h))
    return out
  }

  /** Desired outputs. Cheap when nothing changed; drivers quantize, rate-limit and write change-only. */
  output(o: Partial<HalOutputs>): void {
    let changed = false
    const w = this.want
    if (o.triggerResistance !== undefined) {
      const v = clamp01(o.triggerResistance)
      if (v !== w.triggerResistance) { w.triggerResistance = v; changed = true }
    }
    if (o.rumble !== undefined) {
      const v = clamp01(o.rumble)
      if (v !== w.rumble) { w.rumble = v; changed = true }
    }
    if (o.throttleResistance !== undefined) {
      const v = clamp01(o.throttleResistance)
      if (v !== w.throttleResistance) { w.throttleResistance = v; changed = true }
    }
    if (o.throttleVibration !== undefined) {
      const v = clamp01(o.throttleVibration)
      if (v !== w.throttleVibration) { w.throttleVibration = v; changed = true }
    }
    if (o.lightbar !== undefined) {
      const v = lightbarWord(o.lightbar)
      if (v !== w.lightbar) { w.lightbar = v; changed = true }
    }
    if (changed && !this.hidden && !this.disposed) this.push()
  }

  /** At most 10 Hz, one JSON line to every ready line-protocol device. */
  telemetry(fields: Record<string, number | string | boolean>): void {
    const now = this.now()
    if (now - this.lastTelemetry < TELEMETRY_MS || this.disposed) return
    let line: string | null = null
    for (let i = 0; i < this.entries.length; i++) {
      const link = this.entries[i].link
      if (!link || link.state !== 'ready') continue
      if (line === null) {
        try { line = `${JSON.stringify(fields)}\n` } catch { return }
      }
      link.telemetry(line)
    }
    if (line !== null) this.lastTelemetry = now
  }

  /** The HAL/1 devices that announced a manifest, as the page's bridge (robotLink.ts) reads them. */
  robots(): HalRobot[] {
    const out: HalRobot[] = []
    for (const e of this.entries) {
      const r = e.robot
      if (!r || !r.manifest) continue
      out.push({
        id: r.id, name: r.manifest.robot, transport: e.dev.transport, manifest: r.manifest, caps: r.caps,
        frame: r.frame, frameAt: r.frameAt, frames: r.frames, badFrames: r.badFrames, ack: r.ack, armed: r.armed,
      })
    }
    return out
  }

  /** Robot events as they arrive, in order; every id is one robots() lists (or listed, for 'gone'). Returns the unsubscribe. */
  onRobot(listener: (e: HalRobotEvent) => void): () => void {
    this.robotListeners.add(listener)
    return () => { this.robotListeners.delete(listener) }
  }

  /**
   * One control line to a robot (ARM, DISARM, anything the page composes), ahead of setpoints and telemetry. False
   * when the robot is not listed, its link is not ready or LINE.controlQueue lines already wait (lineLink.ts send).
   */
  sendLine(id: string, line: string): boolean {
    const e = this.robotEntry(id)
    return e?.link ? e.link.send(line) : false
  }

  /** The setpoint slot of a robot's link (a JT line the gate admitted): the newest unsent one wins. */
  sendSetpoint(id: string, line: string): void {
    this.robotEntry(id)?.link?.setpoint(line)
  }

  /** Drops a robot's unsent setpoint (on disarm, so no stale JT follows the DISARM). */
  clearSetpoint(id: string): void {
    this.robotEntry(id)?.link?.clearSetpoint()
  }

  /** The page's gate armed (or disarmed) the robot: while armed, a new JOINTS from the device does not replace its manifest. */
  markArmed(id: string, armed: boolean): void {
    const e = this.robotEntry(id)
    if (!e) return
    e.robot.armed = armed
    if (e.dev.robot) e.dev.robot.armed = armed
  }

  /** One line for the HUD, e.g. "1 device · DualSense (USB) ready" ('' when nothing is attached). */
  summary(): string {
    let n = 0, head: HalDevice | null = null, rank = -1
    const consider = (d: HalDevice) => {
      if (d.state === 'disconnected') return
      n++
      const r = (d.state === 'ready' ? 4 : d.state === 'handshaking' ? 2 : 0) + (d.transport === 'gamepad' ? 0 : 1)
      if (r > rank) { rank = r; head = d }
    }
    for (const e of this.entries) consider(e.dev)
    for (const s of this.slots) consider(s.dev)
    for (const h of this.headset) consider(h)
    if (!head) return ''
    const h: HalDevice = head
    return `${n} device${n === 1 ? '' : 's'} · ${h.name} ${h.state}${n > 1 ? ` +${n - 1}` : ''}`
  }

  /**
   * Per frame, from Input.poll: the pads to read — browser pads plus HID-decoded DualSense pads, minus a browser
   * pad whose controller the HID driver is already decoding, and minus a pad without the standard mapping until one of
   * its face buttons has been pressed. Also refreshes gamepad rumble. Reuses one array.
   */
  readPads(): readonly GamepadLike[] {
    const list = this.padList
    list.length = 0
    const n = this.nav
    let pads: ArrayLike<GamepadLike | null> | null = null
    if (n && typeof n.getGamepads === 'function' && !this.disposed) {
      try { pads = n.getGamepads() } catch { pads = null }
    }
    const frame = this.syncPads(pads)
    this.padFrame = frame
    const now = this.now()
    for (let i = 0; i < this.entries.length; i++) {
      const ds = this.entries[i].ds
      if (!ds || !ds.inputLive(now)) continue
      list.push(ds.pad)
      this.hideMirror(ds, frame)
    }
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (!p || !p.connected) continue
        const s = this.slotOf(p.index)
        if (s && s.hidden === frame) continue
        // A pad without the standard mapping waits for a face button: a flight stick, a wheel or a throttle quadrant
        // (browsers report those the same way) left alone never takes a split-screen seat or moves anyone.
        if (s && !s.awake) {
          if (!isUsablePad(p) || !pressesFaceButton(p)) continue
          s.awake = true
          s.dev.detail = genericDetail(p, true)
        }
        list.push(p)
      }
    }
    this.pumpPadRumble(now)
    return list
  }

  /**
   * Per frame from Input.poll, for a pad read by position: the layout GenericPads has settled on (gamepad.ts
   * layoutOf; null while it is still watching). The row's profile follows it, so `hal` names the layout the pad
   * shows (a 40) instead of the guess from its axis count (35).
   */
  padLayout(index: number, layout: GenericLayout | null): void {
    const s = this.slotOf(index)
    if (!s || s.layout === layout) return
    s.layout = layout
    s.dev.profile = describeResolution(resolveDevice(padClues(s.pad, layout)))
  }

  /**
   * The seating plan the player LEDs follow (seats.ts): a controller's LEDs show the seat its pad holds, plus one,
   * so player 2's controller lights the second pattern whatever order the controllers were opened in, and keeps it
   * when another controller unplugs. With one seat in play every controller merges into player 1 and is lit so; a
   * pad the table has not seated (beyond the free seats) shows no light. Input hands its table over once.
   */
  seatPads(seats: SeatSource | null): void {
    this.seats = seats
    this.seatsChanged()
  }

  /** A seat changed hands (Input, after SeatTable.assign or setPlayers): the player LEDs follow at once. */
  seatsChanged(): void {
    if (!this.hidden && !this.disposed) this.push()
  }

  /** True inside the Windows app, where the shell lists the controllers itself and `pair` shows no chooser (nativeHid.ts). */
  get shellHid(): boolean {
    return (this.nav?.hid as { shell?: boolean } | undefined)?.shell === true
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const u of this.unlisten) guard(u)
    // A shell HID this bus made for itself (defaultNavigator) stops its poll and its input listener with the bus.
    if (this.ownsNav) guard(() => (this.nav?.hid as { dispose?: () => void } | undefined)?.dispose?.())
    this.unlisten.length = 0
    for (const s of this.slots) this.stopPadRumble(s)
    const jobs: Promise<unknown>[] = []
    for (const e of this.entries) {
      this.robotGone(e)
      if (e.ds) jobs.push(e.ds.close())
      if (e.link) jobs.push(e.link.close())
      e.dev.state = 'disconnected'
      e.dev.detail = 'closed'
    }
    this.robotListeners.clear()
    await Promise.allSettled(jobs)
  }

  // ── internals ────────────────────────────────────────────────────────────────────────────────────

  private listen(): void {
    if (this.listening || this.disposed) return
    this.listening = true
    const n = this.nav
    if (n?.hid) {
      const hid = n.hid
      const onConnect = (e: HidConnectionEvent) => {
        if (isDualSense(e.device.vendorId, e.device.productId)) void this.openHid(e.device)
      }
      const onDisconnect = (e: HidConnectionEvent) => {
        const entry = this.find(e.device)
        if (entry) void this.drop(entry, 'unplugged')
      }
      guard(() => {
        hid.addEventListener('connect', onConnect)
        hid.addEventListener('disconnect', onDisconnect)
        this.unlisten.push(() => { hid.removeEventListener('connect', onConnect); hid.removeEventListener('disconnect', onDisconnect) })
      })
    }
    if (n?.serial) {
      const serial = n.serial
      const onConnect = (e: SerialConnectionEvent) => { if (e.target) void this.openSerialPort(e.target as SerialPort) }
      const onDisconnect = (e: SerialConnectionEvent) => {
        const entry = this.find(e.target)
        if (entry) void this.drop(entry, 'unplugged')
      }
      guard(() => {
        serial.addEventListener('connect', onConnect)
        serial.addEventListener('disconnect', onDisconnect)
        this.unlisten.push(() => { serial.removeEventListener('connect', onConnect); serial.removeEventListener('disconnect', onDisconnect) })
      })
    }
    // A stuck rumble or a stiff trigger must not outlive the visible page.
    const g = globalThis as { document?: DomLike } & DomLike
    const doc = g.document
    if (doc?.addEventListener) {
      // A page opened in a background tab starts hidden: nothing may stiffen a trigger before it is seen.
      this.hidden = doc.visibilityState === 'hidden'
      const onVisibility = () => this.setHidden(doc.visibilityState === 'hidden')
      guard(() => {
        doc.addEventListener!('visibilitychange', onVisibility)
        this.unlisten.push(() => doc.removeEventListener?.('visibilitychange', onVisibility))
      })
    }
    if (typeof g.addEventListener === 'function') {
      const onPageHide = () => { for (const e of this.entries) e.ds?.panic() }
      guard(() => {
        g.addEventListener!('pagehide', onPageHide)
        this.unlisten.push(() => g.removeEventListener?.('pagehide', onPageHide))
      })
    }
  }

  private setHidden(hidden: boolean): void {
    if (hidden === this.hidden) return
    this.hidden = hidden
    if (hidden) {
      for (const e of this.entries) e.ds?.quiet()
      for (const s of this.slots) this.stopPadRumble(s)
    } else this.push()
  }

  /** The same outputs to every controller; each DualSense also gets the player number its LEDs show (playerOf). */
  private push(): void {
    const now = this.now()
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e.ds && e.dev.state !== 'disconnected') e.ds.set(this.want, this.playerOf(e, now))
    }
    this.pumpPadRumble(now)
  }

  /**
   * The player number a DualSense's LEDs show: the seat of the pad its input reaches the table as, plus one (1..4),
   * 0 for a pad the table has not seated. One seat in play, or no plan: player 1 for every controller.
   */
  private playerOf(entry: Entry, now: number): number {
    const seats = this.seats
    if (!seats || seats.players <= 1) return 1
    const index = this.padIndexOf(entry, now)
    if (index < 0) return 0
    const seat = seats.seatOf(index)
    return seat < 0 ? 0 : seat + 1
  }

  /**
   * The pad index a controller's input reaches the table as: the driver's own pad (16+) while its decoded Bluetooth
   * input is live; otherwise the browser's pad of the same model, the k-th such pad (by index) for the k-th such
   * controller, since no id a browser gives tells two identical USB controllers apart (they pair by order; a mirror
   * hidden this frame is a decoded controller's and is skipped). −1 when no pad of the model is listed.
   */
  private padIndexOf(entry: Entry, now: number): number {
    const ds = entry.ds
    if (!ds) return -1
    if (ds.inputLive(now)) return ds.pad.index
    const vendor = ds.device.vendorId, product = ds.device.productId
    let k = 0
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e === entry) break
      const o = e.ds
      if (o && e.dev.state !== 'disconnected' && !o.inputLive(now) && o.device.vendorId === vendor && o.device.productId === product) k++
    }
    let after = -1
    for (;;) {
      let best = -1
      for (let i = 0; i < this.slots.length; i++) {
        const s = this.slots[i]
        if (s.hidden === this.padFrame || s.vendor !== vendor || s.product !== product || s.index <= after) continue
        if (best < 0 || s.index < best) best = s.index
      }
      if (best < 0 || k === 0) return best
      after = best
      k--
    }
  }

  private find(key: unknown): Entry | undefined {
    for (const e of this.entries) if (e.key === key) return e
    return undefined
  }

  private add(key: unknown, transport: Transport, id: string, name: string): Entry {
    const e: Entry = { key, dev: { id, transport, name, state: 'handshaking', detail: 'opening' } }
    // A re-plugged device can come back as a new object: retire its stale disconnected row (same id stem).
    const stem = id.split('#')[0]
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const old = this.entries[i].dev
      if (old.state === 'disconnected' && old.id.split('#')[0] === stem) this.entries.splice(i, 1)
    }
    this.entries.push(e)
    return e
  }

  private async drop(e: Entry, reason: string): Promise<void> {
    e.dev.state = 'disconnected'
    e.dev.detail = reason
    this.robotGone(e)
    const ds = e.ds, link = e.link
    e.ds = undefined
    e.link = undefined
    try {
      if (ds) await ds.close()
      if (link) await link.close()
    } catch { /* already gone */ }
    e.dev.detail = reason
  }

  /** What an open attempt after dispose() reports: nothing is opened, nothing is listed. */
  private closedRow(transport: Transport, name: string): HalDevice {
    return { id: `${transport}:closed`, transport, name, state: 'disconnected', detail: 'closed' }
  }

  private async openHid(device: HidDevice): Promise<HalDevice> {
    if (this.disposed) return this.closedRow('hid', dualSenseName(device.productId))
    let e = this.find(device)
    if (e && e.ds && e.dev.state !== 'error') return copy(e.dev)
    const name = dualSenseName(device.productId)
    if (!e) e = this.add(device, 'hid', `hid:${hex4(device.vendorId)}:${hex4(device.productId)}#${++this.serialNo}`, name)
    const entry = e
    // A driver whose writes failed is retired (listener off, device reset and closed) before a fresh one opens.
    const old = entry.ds
    entry.ds = undefined
    if (old) void old.close()
    entry.dev.state = 'handshaking'
    entry.dev.detail = 'opening'
    const ds = new DualSense(device, {
      now: this.now,
      minIntervalMs: this.hidInterval,
      padIndex: 16 + (this.serialNo & 7),
      onStatus: (err) => {
        if (entry.ds !== ds || entry.dev.state === 'disconnected') return
        entry.dev.state = err ? 'error' : 'ready'
        entry.dev.detail = err ? `write failed: ${err}` : ds.describe()
      },
    })
    entry.ds = ds
    // The open report carries the outputs and the seat already wanted (set() before open() is kept for it).
    if (!this.hidden) ds.set(this.want, this.playerOf(entry, this.now()))
    try {
      await ds.open()
      if (this.disposed || entry.ds !== ds) { await ds.close(); return copy(entry.dev) }
      entry.dev.name = `${ds.name} (${ds.bus === 'usb' ? 'USB' : 'Bluetooth'})`
      entry.dev.state = 'ready'
      entry.dev.detail = ds.describe()
      entry.dev.profile = describeResolution(resolveDevice({ id: device.productName, vendorId: device.vendorId, productId: device.productId, bus: ds.bus }))
      if (!this.hidden) this.push()
    } catch (err) {
      if (entry.ds === ds) entry.ds = undefined
      void ds.close()
      if (!gone(entry)) {
        entry.dev.state = 'error'
        entry.dev.detail = errorText(err)
      }
    }
    return copy(entry.dev)
  }

  private async openSerialPort(port: SerialPort): Promise<HalDevice> {
    if (this.disposed) return this.closedRow('serial', 'Serial port')
    const known = this.find(port)
    if (known && known.link && (known.dev.state === 'ready' || known.dev.state === 'handshaking')) return copy(known.dev)
    let info: { usbVendorId?: number; usbProductId?: number } = {}
    try { info = port.getInfo() } catch { /* optional */ }
    const usb = info.usbVendorId !== undefined ? `${hex4(info.usbVendorId)}:${hex4(info.usbProductId ?? 0)}` : ''
    const label = usb ? `Serial ${usb}` : 'Serial port'
    const e = known ?? this.add(port, 'serial', `serial:${usb || 'port'}#${++this.serialNo}`, label)
    e.dev.state = 'handshaking'
    e.dev.detail = 'opening'
    let channel: ByteChannel
    try {
      channel = await openSerial(port)
    } catch (err) {
      e.dev.state = 'error'
      e.dev.detail = errorText(err)
      return copy(e.dev)
    }
    return this.handshake(e, channel)
  }

  private async openBleDevice(device: BleDevice, quiet: boolean): Promise<HalDevice> {
    if (this.disposed) return this.closedRow('bluetooth', device.name || 'BLE UART')
    const known = this.find(device.id)
    if (known && known.link && (known.dev.state === 'ready' || known.dev.state === 'handshaking')) return copy(known.dev)
    const e = known ?? this.add(device.id, 'bluetooth', `ble:${device.id}`, device.name || 'BLE UART')
    e.dev.state = 'handshaking'
    e.dev.detail = 'connecting'
    let channel: ByteChannel
    try {
      channel = await withTimeout(openBle(device), this.bleConnectMs, 'Bluetooth connect')
    } catch (err) {
      // A remembered device that is simply out of range is not an error.
      e.dev.state = quiet ? 'disconnected' : 'error'
      e.dev.detail = errorText(err)
      try { device.gatt?.disconnect() } catch { /* ignore */ }
      return copy(e.dev)
    }
    return this.handshake(e, channel)
  }

  private async handshake(e: Entry, channel: ByteChannel): Promise<HalDevice> {
    const sync = () => {
      const l = e.link
      if (!l) return
      e.dev.state = l.state
      e.dev.detail = l.detail
      if (l.name) e.dev.name = l.name
      if (l.state === 'disconnected' || l.state === 'error') this.robotGone(e)
    }
    // A fresh robot side per session: a re-plugged board announces itself again (same device id, spec §3.1).
    this.robotGone(e)
    e.robot = { id: `hal:${e.dev.id}`, caps: LEGACY_CAPABILITIES, assembler: new ManifestAssembler(), manifest: null, frame: null, frameAt: 0, frames: 0, badFrames: 0, ack: -1, armed: false }
    const link = new LineLink(channel, {
      brand: this.brand.name,
      version: this.brand.version,
      onChange: sync,
      // A retired link's late lines (one that failed while a new session opened) must not reach the new session's robot.
      onLine: (line) => { if (e.link === link) this.robotLine(e, line) },
    })
    e.link = link
    sync()
    if (this.disposed) { await link.close(); return copy(e.dev) }
    await link.start()
    sync()
    return copy(e.dev)
  }

  // ── the robot side of a line link ────────────────────────────────────────────────────────────────

  private robotEntry(id: string): (Entry & { robot: RobotState }) | undefined {
    for (const e of this.entries) if (e.robot && e.robot.id === id) return e as Entry & { robot: RobotState }
    return undefined
  }

  /** Ends an entry's robot side: 'gone' for a robot that was listed, nothing for a device that never announced a manifest. */
  private robotGone(e: Entry): void {
    const r = e.robot
    if (!r) return
    e.robot = undefined
    e.dev.robot = undefined
    if (r.manifest) this.emit({ kind: 'gone', id: r.id })
  }

  /** A page listener's fault is not the link's: a throw must not end the serial read loop that called this. */
  private emit(ev: HalRobotEvent): void {
    for (const l of this.robotListeners) {
      try { l(ev) } catch { /* the listener's own problem */ }
    }
  }

  /** Every inbound line after READY that is not the link's own (lineLink.ts onLine). Unknown lines are read and dropped. */
  private robotLine(e: Entry, line: string): void {
    const r = e.robot
    if (!r) return
    const caps = parseCapabilities(line)
    if (caps !== null) {
      // A CAPS this host cannot read leaves the device a legacy sensor (hal-peripherals-spec.md §3); the row says why.
      if ('error' in caps) e.dev.detail = `CAPS refused: ${caps.error}`
      else r.caps = caps
      return
    }
    const j = parseJointLine(line)
    if (j) {
      if (j.kind === 'manifest') this.robotManifest(e, r, j)
      else if (j.kind === 'state') this.robotFrame(r, j.body)
      else if (j.kind === 'ack' && r.manifest) { r.ack = j.seq; this.emit({ kind: 'ack', id: r.id, seq: j.seq }) }
      // 'targets' (JT) is the host's direction: a device saying it is ignored.
      return
    }
    // The gate's words mean something only for a robot the page can have armed: one with a manifest.
    const m = GATE_WORD.exec(line.trim())
    if (!m || !r.manifest) return
    const arg = (m[2] ?? '').trim()
    if (m[1] === 'ARMED') { if (arg) this.emit({ kind: 'armed', id: r.id, nonce: arg }) }
    else if (m[1] === 'BEAT') this.emit({ kind: 'beat', id: r.id, n: /^\d{1,15}$/.test(arg) ? Number(arg) : 0 })
    else this.emit({ kind: 'disarm', id: r.id, cause: arg || 'device' })
  }

  private robotManifest(e: Entry, r: RobotState, l: Extract<JointLine, { kind: 'manifest' }>): void {
    const got = r.assembler.feed(l, this.now())
    if (got === null) return
    if (!got.ok) { e.dev.detail = `JOINTS refused: ${got.reason}`; return }
    const m = got.value
    if (m.movable.length > JOINT_LINE.halJoints) {
      e.dev.detail = `JOINTS refused: ${m.movable.length} movable joints; a HAL/1 robot has at most ${JOINT_LINE.halJoints} (a bigger robot speaks to the relay)`
      return
    }
    // The page's gate judges setpoints by the manifest's joint count: it cannot change under an armed robot.
    if (r.manifest && r.armed) { e.dev.detail = 'JOINTS ignored: the robot is armed (disarm before a new manifest)'; return }
    r.manifest = m
    r.frame = null
    e.dev.robot = { joints: m.movable.length, name: m.robot, armed: r.armed }
    if (e.link) e.dev.detail = e.link.detail
    this.emit({ kind: 'manifest', id: r.id, manifest: m })
  }

  /** A JS line: kept and announced only when it passes checkFrame against the manifest; otherwise counted. */
  private robotFrame(r: RobotState, body: string): void {
    if (r.manifest) {
      let o: unknown = null
      try { o = JSON.parse(body) } catch { /* not JSON: a bad frame */ }
      const c = checkFrame(r.manifest.movable.length, o)
      if (c.ok) {
        r.frame = c.value
        r.frameAt = this.now()
        r.frames++
        if (c.value.ack !== undefined) r.ack = c.value.ack
        this.emit({ kind: 'frame', id: r.id, frame: c.value, at: r.frameAt })
        return
      }
    }
    r.badFrames++
  }

  private slotOf(index: number): PadSlot | undefined {
    for (let i = 0; i < this.slots.length; i++) if (this.slots[i].index === index) return this.slots[i]
    return undefined
  }

  /** Tracks connected browser pads by index; allocates only when a pad connects or disconnects. */
  private syncPads(pads: ArrayLike<GamepadLike | null> | null): number {
    const frame = ++this.frame
    let seen = 0
    if (pads) {
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i]
        if (!p || !p.connected) continue
        seen++
        const s = this.slotOf(p.index)
        if (s && s.id === p.id) { s.pad = p; s.frame = frame; continue }
        if (s) { this.stopPadRumble(s); this.slots.splice(this.slots.indexOf(s), 1) }
        const ids = parsePadId(p.id)
        const standard = p.mapping === 'standard'
        this.slots.push({
          dev: {
            id: `gamepad:${p.index}`, transport: 'gamepad', name: padName(p.id), state: 'ready',
            detail: standard ? `standard mapping${p.vibrationActuator?.playEffect ? ' · rumble' : ''}` : genericDetail(p, false),
            profile: describeResolution(resolveDevice(padClues(p))),
          },
          index: p.index, id: p.id, awake: standard, layout: null, vendor: ids?.vendor ?? -1, product: ids?.product ?? -1, pad: p, frame, hidden: 0, rumble: 0, rumbleAt: -1e9,
        })
      }
    }
    if (seen !== this.slots.length) {
      for (let i = this.slots.length - 1; i >= 0; i--) if (this.slots[i].frame !== frame) this.slots.splice(i, 1)
    }
    return frame
  }

  /**
   * Hides the browser's own pad for a controller the HID driver is decoding (it would double every press). Pads
   * cannot be matched to HID devices exactly, so one pad per decoded controller is hidden: the same model's pad
   * whose data went stale longest (the decoded one stops updating in the browser) — a second controller of the
   * same model stays usable.
   */
  private hideMirror(ds: DualSense, frame: number): void {
    let best: PadSlot | null = null
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      if (s.hidden === frame || s.vendor !== ds.device.vendorId || s.product !== ds.device.productId) continue
      if (!best || s.pad.timestamp < best.pad.timestamp) best = s
    }
    if (best) best.hidden = frame
  }

  /** Browser pads that are the same physical DualSense as an open HID device get rumble from the HID driver. */
  private hidRumbles(s: PadSlot): boolean {
    for (let i = 0; i < this.entries.length; i++) {
      const e = this.entries[i]
      if (e.ds && e.dev.state === 'ready' && e.ds.device.vendorId === s.vendor && e.ds.device.productId === s.product) return true
    }
    return false
  }

  private pumpPadRumble(now: number): void {
    if (this.slots.length === 0) return
    const level = this.hidden || this.disposed ? 0 : Math.round(this.want.rumble * PAD_RUMBLE.steps) / PAD_RUMBLE.steps
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]
      const act = s.pad.vibrationActuator
      if (!act?.playEffect || s.pad.mapping !== 'standard') continue
      const want = this.hidRumbles(s) ? 0 : level
      if (want === 0) { if (s.rumble !== 0) this.stopPadRumble(s); continue }
      const due = want !== s.rumble ? now - s.rumbleAt >= PAD_RUMBLE.minGapMs : now - s.rumbleAt >= PAD_RUMBLE.refreshMs
      if (!due) continue
      s.rumble = want
      s.rumbleAt = now
      // Runs inside the frame loop (Input.poll): a synchronous throw from a browser actuator must not escape.
      try {
        act.playEffect('dual-rumble', { startDelay: 0, duration: PAD_RUMBLE.durationMs, strongMagnitude: want, weakMagnitude: want * 0.5 })?.catch(() => {})
      } catch { /* unsupported effect: the pad simply stays still */ }
    }
  }

  private stopPadRumble(s: PadSlot): void {
    if (s.rumble === 0) return
    s.rumble = 0
    s.rumbleAt = -1e9
    const act = s.pad.vibrationActuator
    try {
      if (act?.reset) act.reset()?.catch(() => {})
      else act?.playEffect?.('dual-rumble', { duration: 0, strongMagnitude: 0, weakMagnitude: 0 })?.catch(() => {})
    } catch { /* ignore */ }
  }
}

