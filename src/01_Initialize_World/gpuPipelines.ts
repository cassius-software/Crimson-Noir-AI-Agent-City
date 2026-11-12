// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It compiles a WGSL module's compute entry points into pipelines and keeps the browser's
 * own words when one is refused. createComputePipeline, inside a validation error scope, hid the one failure that
 * matters on a phone: a pipeline the GPU's own shader compiler refuses (the driver's vkCreateComputePipelines, say)
 * is an *internal* error in WebGPU, which a validation scope never captures, and the first validation error the
 * scope does capture is the follow-on one, "[Invalid ComputePipeline] is invalid due to a previous error - While
 * Validating GetBindGroupLayout(0)", which names nothing. createComputePipelineAsync rejects with the real
 * GPUPipelineError instead: its `reason` says whether WebGPU refused the shader (validation: the WGSL, or a
 * browser too old for it) or the GPU's compiler did (internal), and its message is the browser's. The module's own
 * compilation messages (getCompilationInfo: Tint's line and column, with the source line quoted) go with it. A
 * caller tells the two apart: a refusal with the WGSL's own errors in it is a bug to show, any other a GPU to give a
 * lighter kernel (03_Spawn_Agents/crowdSim.ts; Safari reports its Metal compiler's refusals as validation, so the
 * reason alone does not say). A third thing looks like the second and is neither: the device lost under the compile
 * (the browser's GPU process gone: a driver that crashed in its compiler, the GPU watchdog, a phone taking the
 * memory back). Chrome then rejects every pending pipeline as an *internal* error ("A valid external Instance
 * reference no longer exists") and every later one at once, and popErrorScope, which never rejects on a live device,
 * rejects with "Instance dropped in popErrorScope". Read as refusals, a ladder of kernels ran down a dead device in a
 * few milliseconds and blamed the compiler for three kernels it never saw. So a refusal is checked against the
 * device's own `lost` first, and a loss is thrown as a DeviceLostError: nothing more can be asked of that device.
 * Pure apart from the device calls; the Node tests drive it with mocks.
 * What breaks if it is removed? A phone whose driver refuses the crowd's simulate kernel shows a card that blames
 * "a previous error", and nothing on it says what the driver said; one whose driver takes the GPU down with it is
 * told its compiler refused kernels that were never compiled.
 */

/** Why a pipeline was refused: WebGPU's validation (the shader, or the browser), the GPU's own compiler, or no reason given. */
export type RefusalReason = 'validation' | 'internal' | 'unknown'

/** One of a module's entry points could not become a pipeline. `message` is the browser's; `compilation` the module's messages. */
export class ShaderRefusedError extends Error {
  readonly module: string
  readonly entryPoint: string
  readonly reason: RefusalReason
  readonly compilation: readonly string[]
  /**
   * Whether the module's own compilation messages hold an error: the WGSL's fault (or a browser too old for it), the
   * same on any device. Without one, the refusal is the pipeline's: a rule it breaks, or the GPU's own compiler, which
   * Chrome reports as internal and Safari as validation (WebKit rejects every backing failure with reason 'validation').
   */
  readonly wgslErrors: boolean
  constructor(module: string, entryPoint: string, reason: RefusalReason, message: string, compilation: readonly string[] = []) {
    super(`${module} ${entryPoint}: ${reason === 'validation' ? 'failed WebGPU validation' : reason === 'internal' ? "refused by the GPU's own compiler (internal error)" : 'refused for no reason given'}: ${message}${compilation.length ? `; compiler messages: ${compilation.join(' | ')}` : ''}`)
    this.name = 'ShaderRefusedError'
    this.module = module
    this.entryPoint = entryPoint
    this.reason = reason
    this.compilation = compilation
    this.wgslErrors = compilation.some((line) => /^error\b/.test(line))
  }
}

/** What a lost device says of itself (GPUDeviceLostInfo): 'unknown' for a reset or a GPU process gone, 'destroyed' for destroy(). */
export interface DeviceLoss { reason: string; message: string }

/** The part of a device that says when it is lost; absent on a mock that never is. */
export interface LosableDevice {
  readonly lost?: PromiseLike<{ readonly reason?: unknown; readonly message?: unknown }>
}

/**
 * The device was lost while `during`: its own reason and the browser's words. Nothing more can be built on it (every
 * call is refused at once), so nothing is tried again on it: a caller asks for another device, or says so.
 */
export class DeviceLostError extends Error {
  readonly during: string
  readonly reason: string
  /** The browser's words for the loss ('' where it gave none). */
  readonly detail: string
  constructor(during: string, reason: string, detail: string) {
    super(`GPU device lost (${reason}) while ${during}: ${detail || 'no message'}`)
    this.name = 'DeviceLostError'
    this.during = during
    this.reason = reason
    this.detail = detail
  }
}

/**
 * How long a refusal waits for the device to say it is lost, ms. Chrome settles `lost` before it rejects what was
 * pending (measured: the same turn), so the wait is for a browser that tells it the other way round; it is paid
 * only on a refusal, never on a pass that compiled.
 */
export const LOSS_GRACE_MS = 150

/** The browser's words for work that died with its GPU process (Chrome: a pending pipeline; a scope popped after). */
const DROPPED = /Instance dropped|external Instance reference no longer exists/i

/**
 * Pure. Whether `words` are the browser's for its GPU process going (Chrome's: the page's connection to it was
 * dropped). That takes every device the page and its workers hold at once, where a device lost for a reason of its
 * own (the driver reset one, the system took its memory back) takes that device alone.
 */
export function processGone(words: string): boolean {
  return DROPPED.test(words)
}

/**
 * The graphics backend's own words for a device it has lost. Dawn hands a pipeline that failed this way to
 * createComputePipelineAsync as a plain 'internal' rejection (the driver's result in its words) without telling the
 * WebGPU device, whose `lost` then stays pending: read as a refusal, the next kernel would be asked of a device the
 * driver has already declared gone.
 */
const BACKEND_LOST = /VK_ERROR_DEVICE_LOST|DXGI_ERROR_DEVICE_(?:REMOVED|HUNG|RESET)/

/** Pure. Whether a refusal's `words` say the device itself is gone: the GPU process (processGone), or the backend's device. */
export function saysLost(words: string): boolean {
  return DROPPED.test(words) || BACKEND_LOST.test(words)
}

/**
 * The device's loss if it has one to report: already settled, or settling within `graceMs` (0: only what has settled;
 * a settled `lost` wins the race against the wait). Null for a live device, and for one that cannot say (a mock).
 */
export async function lossOf(device: LosableDevice, graceMs = 0): Promise<DeviceLoss | null> {
  const lost = device.lost
  if (!lost || typeof lost.then !== 'function') return null
  let timer: ReturnType<typeof setTimeout> | undefined
  const waited = graceMs > 0 ? new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), graceMs) }) : Promise.resolve(null)
  try {
    const info = await Promise.race([lost, waited])
    return info ? { reason: typeof info.reason === 'string' && info.reason ? info.reason : 'unknown', message: typeof info.message === 'string' ? info.message : '' } : null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/** The part of a device used here (the tests hand in mocks). */
export interface PipelineDevice extends LosableDevice {
  createShaderModule(descriptor: { label?: string; code: string }): GPUShaderModule
  createComputePipelineAsync(descriptor: { label?: string; layout: 'auto'; compute: { module: GPUShaderModule; entryPoint: string } }): Promise<GPUComputePipeline>
}

export interface CompiledPasses<N extends string> {
  module: GPUShaderModule
  pipelines: ReadonlyMap<N, GPUComputePipeline>
}

/** The `reason` of a GPUPipelineError (or anything shaped like one), 'unknown' for anything else. */
export function refusalReason(e: unknown): RefusalReason {
  const r = typeof e === 'object' && e !== null ? (e as { reason?: unknown }).reason : undefined
  return r === 'validation' || r === 'internal' ? r : 'unknown'
}

/** What was thrown, as words. */
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : String(e))

/**
 * A module's compilation messages as lines a card can show: the kind, the module line and column, the message, and
 * the source line itself (so a line number into an assembled module, header and all, still names the statement).
 */
export function compilationLines(info: Pick<GPUCompilationInfo, 'messages'> | null | undefined, code: string): string[] {
  if (!info || !Array.isArray(info.messages)) return []
  const lines = code.split('\n')
  return info.messages.map((m) => {
    const at = m.lineNum > 0 ? ` at line ${m.lineNum}:${m.linePos}` : ''
    const src = m.lineNum > 0 && m.lineNum <= lines.length ? lines[m.lineNum - 1].trim() : ''
    const quoted = src ? ` "${src.length > 120 ? `${src.slice(0, 117)}...` : src}"` : ''
    return `${m.type}${at}: ${m.message}${quoted}`
  })
}

/** The module's messages, or none where the browser has no getCompilationInfo (an old one, a mock). */
async function compilationOf(module: GPUShaderModule, code: string): Promise<string[]> {
  const get = (module as Partial<Pick<GPUShaderModule, 'getCompilationInfo'>>).getCompilationInfo
  if (typeof get !== 'function') return []
  try {
    return compilationLines(await get.call(module), code)
  } catch {
    return []
  }
}

/**
 * The module from `code`, and a pipeline (layout 'auto') per entry point in `passes`, all compiled at once. The first
 * refusal in `passes` order is thrown as a ShaderRefusedError carrying its reason, the browser's message and the
 * module's compilation messages; every pass the browser accepted is forgotten (a caller builds all or nothing).
 * A refusal on a device that is lost (it says so itself, or the refusal's words are the ones Chrome gives work that
 * died with its GPU process, or the backend's for a device it lost) is no refusal: a DeviceLostError, with the
 * device's reason and words. So is a build that "went well" on a device that is lost: WebGPU resolves a lost
 * device's pipelines (invalid ones), so a compile that outlived its device rejects nothing.
 */
export async function compilePasses<N extends string>(device: PipelineDevice, label: string, code: string, passes: readonly N[]): Promise<CompiledPasses<N>> {
  const module = device.createShaderModule({ label, code })
  // Pipelines are labelled by the module's stem and the pass ("crowd.simulate"), whatever else the label says of the module.
  const stem = label.replace(/\.wgsl\b.*$/, '')
  const results = await Promise.allSettled(passes.map((name) => device.createComputePipelineAsync({ label: `${stem}.${name}`, layout: 'auto', compute: { module, entryPoint: name } })))
  const failed = results.findIndex((r) => r.status === 'rejected')
  if (failed >= 0) {
    const e = (results[failed] as PromiseRejectedResult).reason
    const words = messageOf(e)
    const loss = await lossOf(device, LOSS_GRACE_MS)
    if (loss || saysLost(words)) throw new DeviceLostError(`compiling ${label}`, loss?.reason ?? 'unknown', loss?.message || words)
    throw new ShaderRefusedError(label, passes[failed], refusalReason(e), words, await compilationOf(module, code))
  }
  const gone = await lossOf(device)
  if (gone) throw new DeviceLostError(`compiling ${label}`, gone.reason, gone.message)
  const pipelines = new Map<N, GPUComputePipeline>()
  results.forEach((r, i) => pipelines.set(passes[i], (r as PromiseFulfilledResult<GPUComputePipeline>).value))
  return { module, pipelines }
}

/** The error filters a scope can watch: everything a device can report short of losing itself. */
export const ERROR_FILTERS: readonly GPUErrorFilter[] = Object.freeze(['validation', 'out-of-memory', 'internal'])

/** The part of a device the scopes use. */
export interface ScopedDevice extends LosableDevice {
  pushErrorScope(filter: GPUErrorFilter): void
  popErrorScope(): Promise<GPUError | null>
}

/** One captured error: its filter and the browser's words. */
export interface ScopedError { filter: GPUErrorFilter; message: string }

/**
 * Runs `build` under one scope per error filter (validation, out of memory, internal) and resolves with its value and
 * the first error each scope captured, innermost popped first, in ERROR_FILTERS order. A validation scope alone let a
 * GPU that refused a buffer or a pipeline for a reason of its own go unseen until the first use. A device lost under
 * the build is a DeviceLostError naming `during`: a pop that rejects (it never does on a live device: the browser's
 * GPU process is gone, "Instance dropped in popErrorScope"), or a device that says it is lost once the scopes are
 * popped (a lost device's scopes capture nothing, so they would have read as a build that went well).
 */
export async function withErrorScopes<T>(device: ScopedDevice, build: () => T, during = 'building on the GPU'): Promise<{ value: T; errors: ScopedError[] }> {
  for (const filter of ERROR_FILTERS) device.pushErrorScope(filter)
  let value: T
  try {
    value = build()
  } catch (e) {
    // A build that throws still leaves the device its scopes back: left pushed, they would swallow every later error.
    for (let i = 0; i < ERROR_FILTERS.length; i++) await device.popErrorScope().catch(() => null)
    throw e
  }
  const popped: (GPUError | null)[] = []
  try {
    for (let i = ERROR_FILTERS.length - 1; i >= 0; i--) popped[i] = await device.popErrorScope()
  } catch (e) {
    const loss = await lossOf(device, LOSS_GRACE_MS)
    throw new DeviceLostError(during, loss?.reason ?? 'unknown', loss?.message || messageOf(e))
  }
  const loss = await lossOf(device)
  if (loss) throw new DeviceLostError(during, loss.reason, loss.message)
  const errors: ScopedError[] = []
  ERROR_FILTERS.forEach((filter, i) => { if (popped[i]) errors.push({ filter, message: popped[i]!.message }) })
  return { value, errors }
}

/** The scoped errors as one line: the browser's words alone when validation is all that spoke, else each under its filter. */
export function scopedMessage(errors: readonly ScopedError[]): string {
  return errors.every((e) => e.filter === 'validation') ? errors.map((e) => e.message).join('; ') : errors.map((e) => `${e.filter}: ${e.message}`).join('; ')
}
