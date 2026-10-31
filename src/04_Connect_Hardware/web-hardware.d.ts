// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? TypeScript's DOM lib does not type WebHID, Web Serial or Web Bluetooth,
 * and the unit tests type-check without the DOM lib at all. These are the minimal structural shapes
 * the HAL touches (module-scoped, so nothing leaks into globals or collides with @types packages),
 * written against the WHATWG/WICG specs: hid.spec.whatwg.org, wicg.github.io/serial,
 * webbluetoothcg.github.io/web-bluetooth, w3c.github.io/gamepad. The last sections cover what the
 * .agv recorder needs beyond lib.dom's WebCodecs: MediaStreamTrackProcessor
 * (w3c.github.io/mediacapture-transform) and showSaveFilePicker (wicg.github.io/file-system-access), and the
 * WebXR slice the device resolver, the headset mapper (xrInput.ts) and the session (07_Execute_Actions/xrSession.ts)
 * read (immersive-web.github.io/webxr, the Gamepads Module and Hand Input): the DOM's own objects satisfy these
 * shapes structurally, and the Node tests hand in fakes, so no WebXR typings are needed to type-check them.
 * What breaks if it is removed? hal.ts, dualsense.ts, lineLink.ts, gamepad.ts, devices.ts, xrInput.ts, xrSession.ts
 * and recorder.ts stop type-checking.
 */

// ── WebHID ─────────────────────────────────────────────────────────────────────────────────────────

export interface HidReportItem { readonly reportSize?: number; readonly reportCount?: number }

export interface HidReportInfo { readonly reportId?: number; readonly items?: readonly HidReportItem[] }

export interface HidCollectionInfo {
  readonly usagePage?: number
  readonly usage?: number
  readonly inputReports?: readonly HidReportInfo[]
  readonly outputReports?: readonly HidReportInfo[]
  readonly featureReports?: readonly HidReportInfo[]
}

export interface HidInputReportEvent { readonly reportId: number; readonly data: DataView }

export interface HidDevice {
  readonly opened: boolean
  readonly vendorId: number
  readonly productId: number
  readonly productName: string
  readonly collections: readonly HidCollectionInfo[]
  open(): Promise<void>
  close(): Promise<void>
  /** `data` excludes the report ID byte. */
  sendReport(reportId: number, data: Uint8Array): Promise<void>
  /** Per spec the first byte MAY be the report ID; parse defensively. */
  receiveFeatureReport(reportId: number): Promise<DataView>
  addEventListener(type: 'inputreport', listener: (e: HidInputReportEvent) => void): void
  removeEventListener(type: 'inputreport', listener: (e: HidInputReportEvent) => void): void
}

export interface HidDeviceFilter { vendorId?: number; productId?: number; usagePage?: number; usage?: number }

export interface HidConnectionEvent { readonly device: HidDevice }

export interface Hid {
  getDevices(): Promise<HidDevice[]>
  requestDevice(options: { filters: HidDeviceFilter[] }): Promise<HidDevice[]>
  addEventListener(type: 'connect' | 'disconnect', listener: (e: HidConnectionEvent) => void): void
  removeEventListener(type: 'connect' | 'disconnect', listener: (e: HidConnectionEvent) => void): void
}

// ── Web Serial ─────────────────────────────────────────────────────────────────────────────────────

export interface ByteReadResult { readonly value?: Uint8Array; readonly done: boolean }

export interface ByteReader {
  read(): Promise<ByteReadResult>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

export interface ByteWriter {
  write(chunk: Uint8Array): Promise<void>
  close(): Promise<void>
  releaseLock(): void
}

export interface SerialOpenOptions {
  baudRate: number
  dataBits?: 7 | 8
  stopBits?: 1 | 2
  parity?: 'none' | 'even' | 'odd'
  bufferSize?: number
  flowControl?: 'none' | 'hardware'
}

export interface SerialPort {
  readonly readable: { getReader(): ByteReader } | null
  readonly writable: { getWriter(): ByteWriter } | null
  open(options: SerialOpenOptions): Promise<void>
  close(): Promise<void>
  getInfo(): { usbVendorId?: number; usbProductId?: number }
}

/** `connect` / `disconnect` events are fired at the SerialPort and bubble to navigator.serial. */
export interface SerialConnectionEvent { readonly target: unknown }

export interface Serial {
  getPorts(): Promise<SerialPort[]>
  requestPort(options?: { filters?: { usbVendorId?: number; usbProductId?: number }[] }): Promise<SerialPort>
  addEventListener(type: 'connect' | 'disconnect', listener: (e: SerialConnectionEvent) => void): void
  removeEventListener(type: 'connect' | 'disconnect', listener: (e: SerialConnectionEvent) => void): void
}

// ── Web Bluetooth ──────────────────────────────────────────────────────────────────────────────────

export interface BleValueEvent { readonly target: unknown }

export interface BleCharacteristic {
  readonly value?: DataView | null
  readonly properties?: { readonly write?: boolean; readonly writeWithoutResponse?: boolean; readonly notify?: boolean }
  startNotifications(): Promise<unknown>
  stopNotifications(): Promise<unknown>
  writeValueWithoutResponse?(value: Uint8Array): Promise<void>
  writeValueWithResponse?(value: Uint8Array): Promise<void>
  /** Deprecated alias of writeValueWithResponse, still the only writer in older Chromium. */
  writeValue?(value: Uint8Array): Promise<void>
  addEventListener(type: 'characteristicvaluechanged', listener: (e: BleValueEvent) => void): void
  removeEventListener(type: 'characteristicvaluechanged', listener: (e: BleValueEvent) => void): void
}

export interface BleService { getCharacteristic(uuid: string): Promise<BleCharacteristic> }

export interface BleServer {
  readonly connected: boolean
  connect(): Promise<BleServer>
  disconnect(): void
  getPrimaryService(uuid: string): Promise<BleService>
}

export interface BleDevice {
  readonly id: string
  readonly name?: string | null
  readonly gatt?: BleServer | null
  addEventListener(type: 'gattserverdisconnected', listener: () => void): void
  removeEventListener(type: 'gattserverdisconnected', listener: () => void): void
}

export interface BleRequestOptions {
  filters?: { services?: string[]; name?: string; namePrefix?: string }[]
  optionalServices?: string[]
  acceptAllDevices?: boolean
}

export interface Bluetooth {
  requestDevice(options: BleRequestOptions): Promise<BleDevice>
  /** Only with the "new permissions backend" (Chromium flag at the time of writing). */
  getDevices?(): Promise<BleDevice[]>
}

// ── Gamepad API (DOM Gamepad objects satisfy these shapes structurally) ────────────────────────────

export interface GamepadButtonLike { readonly pressed: boolean; readonly value: number }

export interface GamepadHapticsLike {
  playEffect?(type: 'dual-rumble', params: { startDelay?: number; duration?: number; weakMagnitude?: number; strongMagnitude?: number }): Promise<unknown>
  reset?(): Promise<unknown>
}

export interface GamepadLike {
  readonly id: string
  readonly index: number
  readonly connected: boolean
  readonly mapping: string
  readonly timestamp: number
  readonly axes: readonly number[]
  readonly buttons: readonly GamepadButtonLike[]
  readonly vibrationActuator?: GamepadHapticsLike | null
  /** A DualSense Edge's Fn keys and back paddles (dualsense.ts PADDLE bits); only the HID driver's pad carries them. */
  readonly paddles?: number
}

// ── WebXR input (the slice devices.ts reads of an XRInputSource; a DOM one satisfies it structurally) ─────────

/** An XR input source's gamepad: `mapping` is 'xr-standard' for a tracked controller, '' otherwise. */
export interface XrGamepadLike {
  readonly mapping: string
  readonly axes: readonly number[]
  readonly buttons: readonly GamepadButtonLike[]
}

export interface XrInputSourceLike {
  /** 'none', 'left' or 'right'. */
  readonly handedness: string
  /** 'gaze', 'tracked-pointer', 'screen' or 'transient-pointer' (a gaze-and-pinch headset). */
  readonly targetRayMode: string
  /** Input profile names, most specific first (immersive-web.github.io/webxr-input-profiles). */
  readonly profiles: readonly string[]
  readonly gamepad?: XrGamepadLike | null
  /** WebXR Hand Input: present when the source is an articulated hand. */
  readonly hand?: unknown
}

// ── WebXR session (the slice xrSession.ts drives and xrInput.ts reads; a DOM XRSession satisfies it structurally) ─

/** A select or squeeze event: the source that pinched or pulled. */
export interface XrInputSourceEventLike { readonly inputSource: XrInputSourceLike }

/** The `inputsourceschange` event: what arrived and what left. */
export interface XrInputSourcesChangeEventLike { readonly added: readonly XrInputSourceLike[]; readonly removed: readonly XrInputSourceLike[] }

export type XrSelectEvent = 'select' | 'selectstart' | 'selectend' | 'squeeze' | 'squeezestart' | 'squeezeend'

export interface XrSessionLike {
  /** Live: the array the session keeps up to date as sources come and go. */
  readonly inputSources: ArrayLike<XrInputSourceLike>
  /** The features granted (WebXR Level 2+); the WebGPU binding needs 'webgpu' among them. */
  readonly enabledFeatures?: readonly string[]
  /** 'visible', 'visible-blurred' or 'hidden'. */
  readonly visibilityState?: string
  /** 'opaque' (a VR headset), 'alpha-blend' or 'additive' (passthrough or see-through). */
  readonly environmentBlendMode?: string
  addEventListener(type: 'inputsourceschange', listener: (e: XrInputSourcesChangeEventLike) => void): void
  addEventListener(type: XrSelectEvent, listener: (e: XrInputSourceEventLike) => void): void
  addEventListener(type: 'end' | 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'inputsourceschange', listener: (e: XrInputSourcesChangeEventLike) => void): void
  removeEventListener(type: XrSelectEvent, listener: (e: XrInputSourceEventLike) => void): void
  removeEventListener(type: 'end' | 'visibilitychange', listener: () => void): void
  end(): Promise<void>
}

export type XrSessionMode = 'immersive-vr' | 'immersive-ar'

export interface XrSessionInit { requiredFeatures?: string[]; optionalFeatures?: string[] }

/** navigator.xr, as far as the page asks of it. */
export interface XrSystemLike {
  isSessionSupported(mode: XrSessionMode): Promise<boolean>
  /** Needs a user gesture: the page calls it synchronously inside a tap or a key press. */
  requestSession(mode: XrSessionMode, init?: XrSessionInit): Promise<XrSessionLike>
}

// ── navigator ──────────────────────────────────────────────────────────────────────────────────────

/** The slice of `navigator` the HAL reads. Every member is optional: Safari, Firefox and iOS lack most. */
export interface HardwareNavigator {
  readonly hid?: Hid
  readonly serial?: Serial
  readonly bluetooth?: Bluetooth
  getGamepads?(): ArrayLike<GamepadLike | null>
  /** WebXR (Chromium on a headset's Android, visionOS Safari); absent nearly everywhere else. */
  readonly xr?: XrSystemLike
}

// ── WebCodecs capture and the save-file picker (lib.dom has VideoEncoder, VideoFrame, EncodedVideoChunk,
//    FileSystemFileHandle and FileSystemWritableFileStream; it lacks the two constructors below) ─────────

/** What the recorder touches on a VideoFrame; a DOM VideoFrame satisfies it. */
export interface VideoFrameLike { readonly timestamp: number; close(): void }

export interface VideoFrameReader {
  read(): Promise<{ readonly value?: VideoFrameLike; readonly done: boolean }>
  cancel(reason?: unknown): Promise<void>
  releaseLock(): void
}

export interface TrackProcessor { readonly readable: { getReader(): VideoFrameReader } }

export interface TrackProcessorCtor { new (init: { track: MediaStreamTrack; maxBufferSize?: number }): TrackProcessor }

/** What the recorder touches on a VideoEncoder; a DOM VideoEncoder satisfies it. */
export interface VideoEncoderLike {
  readonly state: CodecState
  readonly encodeQueueSize: number
  configure(config: VideoEncoderConfig): void
  encode(frame: VideoFrameLike, options?: VideoEncoderEncodeOptions): void
  flush(): Promise<void>
  close(): void
}

export interface VideoEncoderCtor {
  new (init: VideoEncoderInit): VideoEncoderLike
  isConfigSupported(config: VideoEncoderConfig): Promise<VideoEncoderSupport>
}

export interface SaveFilePickerOptions {
  suggestedName?: string
  excludeAcceptAllOption?: boolean
  id?: string
  types?: { description?: string; accept: Record<string, string[]> }[]
}

/** The slice of `window` the recorder reads. Every member is optional: Safari, Firefox and iOS lack the
 *  codecs API, and headless or non-Chromium browsers lack the picker. */
export interface RecorderGlobals {
  readonly VideoEncoder?: VideoEncoderCtor
  readonly MediaStreamTrackProcessor?: TrackProcessorCtor
  showSaveFilePicker?(options?: SaveFilePickerOptions): Promise<FileSystemFileHandle>
}
