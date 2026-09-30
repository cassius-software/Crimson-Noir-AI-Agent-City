/**
 * Why does this file exist? TypeScript's DOM lib does not type WebHID, Web Serial or Web Bluetooth,
 * and the unit tests type-check without the DOM lib at all. These are the minimal structural shapes
 * the HAL touches (module-scoped, so nothing leaks into globals or collides with @types packages),
 * written against the WHATWG/WICG specs: hid.spec.whatwg.org, wicg.github.io/serial,
 * webbluetoothcg.github.io/web-bluetooth, w3c.github.io/gamepad. The last section covers what the
 * .agv recorder needs beyond lib.dom's WebCodecs: MediaStreamTrackProcessor
 * (w3c.github.io/mediacapture-transform) and showSaveFilePicker (wicg.github.io/file-system-access).
 * What breaks if it is removed? hal.ts, dualsense.ts, lineLink.ts, gamepad.ts and recorder.ts stop
 * type-checking.
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
}

// ── navigator ──────────────────────────────────────────────────────────────────────────────────────

/** The slice of `navigator` the HAL reads. Every member is optional: Safari, Firefox and iOS lack most. */
export interface HardwareNavigator {
  readonly hid?: Hid
  readonly serial?: Serial
  readonly bluetooth?: Bluetooth
  getGamepads?(): ArrayLike<GamepadLike | null>
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
