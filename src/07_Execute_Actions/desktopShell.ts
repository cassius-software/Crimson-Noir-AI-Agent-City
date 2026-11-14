// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's one view of the desktop shell (src-tauri): whether the page runs inside
 * the Tauri window rather than a browser tab, the handle to that window's controls, and the shell's reading of the
 * GPUs' memory (src-tauri/src/gpu.rs `gpu_memory`), which a page cannot read. Tauri injects its API at
 * `window.__TAURI__` (tauri.conf.json `withGlobalTauri`), so the page bundles nothing for it and the browser build is
 * byte for byte what it was. Everything here is typed to the few calls the title bar makes, and the capabilities file
 * (src-tauri/capabilities/default.json) admits exactly those; the app's own commands are allowed by Tauri's default.
 * It is also the page's way to the model the Windows app's installer puts beside the app (src-tauri/src/model.rs:
 * `app_model` says whether it is there, `app_model_read` reads a piece of it): shellModel and shellModelFetch, which
 * hand App.tsx the same offer and fetch the web copy gets from its site (09_Cognition/siteModel.ts), so the page holds
 * the app's model to its pin exactly as it holds the site's. And it is the page's one way to the model the app runs
 * itself (shellRunner: `native_model`, `native_generate`, `native_stop`), which 09_Cognition/nativeMind.ts asks.
 * What breaks if it is removed? The title bar cannot tell a window from a tab, and has nothing to drive; the Windows
 * app gives auto no GPU figure, and carries a model the page cannot reach; the page cannot ask the app's own model.
 */
import type { NativeHost } from '../09_Cognition/nativeMind.ts'
import { SITE_DIR, type SiteFetch, type SiteModelOffer, type SiteModelPin } from '../09_Cognition/siteModel.ts'

/** The window commands the title bar uses, as Tauri's `getCurrentWindow()` exposes them. */
export interface ShellWindow {
  minimize(): Promise<void>
  toggleMaximize(): Promise<void>
  close(): Promise<void>
  isMaximized(): Promise<boolean>
  /** Resolves to the function that stops listening. */
  onResized(handler: () => void): Promise<() => void>
}

/** The part of Tauri's injected global the page reads. */
export interface ShellGlobal {
  window: { getCurrentWindow(): ShellWindow }
}

/** Where Tauri puts its API when `withGlobalTauri` is on. */
export const SHELL_GLOBAL = '__TAURI__'

/** The Tauri window around this page, or null in a browser (or any global without the API). */
export function desktopShell(g: object = globalThis): ShellGlobal | null {
  const api = (g as Record<string, unknown>)[SHELL_GLOBAL]
  if (typeof api !== 'object' || api === null) return null
  const win = (api as { window?: unknown }).window
  if (typeof win !== 'object' || win === null || typeof (win as { getCurrentWindow?: unknown }).getCurrentWindow !== 'function') return null
  return api as ShellGlobal
}

/** The attribute the page's data-shell carries while the title bar is mounted; index.css lays the root out under it. */
export const SHELL_ATTRIBUTE = 'tauri'

/** How long the page waits for the shell's GPU reading, ms: DXGI answers in milliseconds; past this, there is none. */
export const GPU_READ_MS = 2000

/**
 * The shell's reading of the GPUs' memory: each hardware adapter's dedicated bytes, in DXGI's order (src-tauri/src/
 * gpu.rs). Null in a browser, in a shell without the command, and when the answer is not a list of numbers or does not
 * come within `waitMs`; it never throws. The page judges the list (modelFit.ts figureFromAdapters).
 */
export async function shellGpuMemory(g: object = globalThis, waitMs = GPU_READ_MS): Promise<number[] | null> {
  const invoke = shellInvoke(g)
  if (!invoke) return null
  const answer = await soon(() => invoke('gpu_memory'), waitMs)
  return Array.isArray(answer) && answer.every((b) => typeof b === 'number') ? answer : null
}

/** The part of Tauri's `core` namespace the page calls: `invoke` (always on `core`, as Tauri expects) and `Channel`. */
type ShellCore = { invoke(command: string, args?: Record<string, unknown>): Promise<unknown>; Channel?: unknown }

/** Tauri's `core` namespace on the injected global when it has `invoke`, or null. */
function shellCoreOf(g: object): ShellCore | null {
  const api = (g as Record<string, unknown>)[SHELL_GLOBAL]
  const core = typeof api === 'object' && api !== null ? (api as { core?: { invoke?: unknown } }).core : undefined
  return typeof core === 'object' && core !== null && typeof core.invoke === 'function' ? (core as ShellCore) : null
}

/** One of the shell's commands, asked on Tauri's `core` as it expects. */
type ShellInvoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>

/** Tauri's `core.invoke`, bound to `core`, or null in a browser (or a global without it). */
function shellInvoke(g: object): ShellInvoke | null {
  const core = shellCoreOf(g)
  if (core === null) return null
  return (command, args) => Promise.resolve().then(() => core.invoke(command, args))
}

/** What `ask` resolves to within `waitMs`, or null when it is late or throws; it never throws itself. */
async function soon(ask: () => Promise<unknown>, waitMs: number): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), waitMs) })
  try {
    return await Promise.race([ask(), late])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** How long the page waits for the shell to say whether it carries a model, ms: it looks at one file's size. */
export const APP_MODEL_ASK_MS = 5000

/**
 * The most the page asks the shell for in one read, bytes (src-tauri/src/model_file.rs MAX_READ is the same): 4 MiB,
 * sent as base64 text, because the shell's answers reach this page as text (its binary path is a request the page's
 * air gap refuses, so Tauri falls back to one that carries text only). About 240 reads for the 1.5B model.
 */
export const APP_READ_BYTES = 4 * 1024 * 1024

/**
 * The model the app carries, as the site's manifest would offer it: null in a browser, where the app carries none
 * (the bare .exe, or any app but the Windows installer's: the shell answers nothing) or one that is not exactly `pin`
 * by name and size. It throws where the shell could not say just now (it refused the command, or did not answer
 * within `waitMs`), so the caller asks again later rather than taking that for "none" (App.tsx siteHost.offer); the
 * page and the shell ship in one build, so there is no older shell without the command. Its SHA-256 is the pin's
 * here; the page checks it on every byte it reads (siteModel.ts fetchSiteModel).
 */
export async function shellModel(pin: SiteModelPin, g: object = globalThis, waitMs = APP_MODEL_ASK_MS): Promise<SiteModelOffer | null> {
  const invoke = shellInvoke(g)
  if (!invoke) return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`the app did not say within ${waitMs} ms whether it carries a model`)), waitMs)
  })
  let answer: unknown
  try {
    answer = await Promise.race([invoke('app_model'), late])
  } finally {
    clearTimeout(timer)
  }
  if (typeof answer !== 'object' || answer === null) return null
  const a = answer as Record<string, unknown>
  return a.file === pin.file && a.bytes === pin.bytes ? { file: pin.file, bytes: pin.bytes, sha256: pin.sha256 } : null
}

/** base64 text as bytes: the engine's own decoder where it has one, atob otherwise; throws on anything not base64. */
export function fromBase64(text: string): Uint8Array {
  const native = (Uint8Array as unknown as { fromBase64?: (s: string) => Uint8Array }).fromBase64
  if (typeof native === 'function') return native(text)
  const bin = atob(text)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

/**
 * A fetch of the model the app carries, in the shape the site's fetch has (siteModel.ts SiteFetch), or null in a
 * browser: it answers only for `models/<pin.file>` and refuses any other path. Its response streams the file read by
 * read (`app_model_read`, at most `chunk` bytes each, the next asked only once the last is taken), so the page holds
 * no more of it than the browser's own file does; the first read is made before the response is handed back, so a
 * file that cannot be read says so as the fetch's own refusal. The shell ends the file with an empty read; the size
 * and SHA-256 are checked by the caller (fetchSiteModel), which counts every byte. The request's signal stops it
 * between reads.
 */
export function shellModelFetch(pin: SiteModelPin, g: object = globalThis, chunk = APP_READ_BYTES): SiteFetch | null {
  const invoke = shellInvoke(g)
  if (!invoke) return null
  const read = async (offset: number): Promise<Uint8Array> => {
    const text = await invoke('app_model_read', { offset, len: chunk })
    if (typeof text !== 'string') throw new Error('the app answered a read of its model with something other than text')
    const bytes = fromBase64(text)
    if (bytes.byteLength > chunk) throw new Error(`the app sent ${bytes.byteLength} bytes for a read of ${chunk}`)
    return bytes
  }
  return async (path, init) => {
    if (path !== `${SITE_DIR}${pin.file}`) throw new Error(`${path} is not the model this app carries`)
    init.signal?.throwIfAborted()
    // The first piece, read now; `offset` is how far the reads have come.
    let first: Uint8Array | null = await read(0)
    let offset = first.byteLength
    const body = new ReadableStream<Uint8Array>({
      async pull(ctl) {
        let piece = first
        first = null
        if (piece === null) {
          init.signal?.throwIfAborted()
          piece = await read(offset)
          offset += piece.byteLength
        }
        if (piece.byteLength === 0) ctl.close()
        else ctl.enqueue(piece)
      },
    }, { highWaterMark: 0 })
    return new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(pin.bytes) } })
  }
}

/**
 * How long an answer's reply waits for its channel's end, ms: Tauri sends the end once the shell lets the channel go,
 * after its last message; without one (a shell that kept it) the reply is taken anyway.
 */
export const DRAIN_MS = 1000

/**
 * The app's own model runner (src-tauri: `native_model`, `native_generate`, `native_stop`; native/llm), or null where
 * the global has no `core.invoke` or no `core.Channel` (a browser). An answer's events come back on a Tauri channel
 * made for it: each is a small JSON message the shell hands straight to the page, never a request the air gap would
 * see. The request goes as `{ req, onEvent }`, the names the shell's command takes. The command's reply comes back
 * over the ipc fetch and can overtake the channel's last message, so the answer settles only once the channel has
 * ended (Tauri hands every earlier message to `onmessage` first, then calls the channel's `cleanupCallback`), or
 * after DRAIN_MS. Whether the app runs a model at all is the runner's own answer (nativeMind.ts): every shell has
 * invoke and Channel.
 */
export function shellRunner(g: object = globalThis): NativeHost | null {
  const core = shellCoreOf(g)
  const Channel = core?.Channel
  if (core === null || typeof Channel !== 'function') return null
  const Made = Channel as new () => { onmessage: (message: unknown) => void; cleanupCallback?: () => void }
  return Object.freeze<NativeHost>({
    model: () => core.invoke('native_model'),
    generate: (req, onEvent) => {
      const channel = new Made()
      channel.onmessage = onEvent
      let drained!: () => void
      const end = new Promise<void>((resolve) => { drained = resolve })
      const cleanup = channel.cleanupCallback
      channel.cleanupCallback = function (this: unknown) {
        try { cleanup?.call(this) } finally { drained() }
      }
      const ended = (): Promise<void> => {
        let t: ReturnType<typeof setTimeout> | undefined
        return Promise.race([end, new Promise<void>((r) => { t = setTimeout(r, DRAIN_MS) })]).finally(() => clearTimeout(t))
      }
      return core.invoke('native_generate', { req, onEvent: channel }).then(
        (done) => ended().then(() => done),
        (e: unknown) => ended().then(() => { throw e }),
      )
    },
    stop: (id) => core.invoke('native_stop', { id }),
  })
}
