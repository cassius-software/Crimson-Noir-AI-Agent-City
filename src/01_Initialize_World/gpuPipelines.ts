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
 * caller tells the two apart: a validation refusal is a bug to show, an internal one is a GPU to give a lighter
 * kernel (03_Spawn_Agents/crowdSim.ts). Pure apart from the device calls; the Node tests drive it with mocks.
 * What breaks if it is removed? A phone whose driver refuses the crowd's simulate kernel shows a card that blames
 * "a previous error", and nothing on it says what the driver said.
 */

/** Why a pipeline was refused: WebGPU's validation (the shader, or the browser), the GPU's own compiler, or no reason given. */
export type RefusalReason = 'validation' | 'internal' | 'unknown'

/** One of a module's entry points could not become a pipeline. `message` is the browser's; `compilation` the module's messages. */
export class ShaderRefusedError extends Error {
  readonly module: string
  readonly entryPoint: string
  readonly reason: RefusalReason
  readonly compilation: readonly string[]
  constructor(module: string, entryPoint: string, reason: RefusalReason, message: string, compilation: readonly string[] = []) {
    super(`${module} ${entryPoint}: ${reason === 'validation' ? 'failed WebGPU validation' : reason === 'internal' ? "refused by the GPU's own compiler (internal error)" : 'refused for no reason given'}: ${message}${compilation.length ? `; compiler messages: ${compilation.join(' | ')}` : ''}`)
    this.name = 'ShaderRefusedError'
    this.module = module
    this.entryPoint = entryPoint
    this.reason = reason
    this.compilation = compilation
  }
}

/** The part of a device used here (the tests hand in mocks). */
export interface PipelineDevice {
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
 */
export async function compilePasses<N extends string>(device: PipelineDevice, label: string, code: string, passes: readonly N[]): Promise<CompiledPasses<N>> {
  const module = device.createShaderModule({ label, code })
  // Pipelines are labelled by the module's stem and the pass ("crowd.simulate"), whatever else the label says of the module.
  const stem = label.replace(/\.wgsl\b.*$/, '')
  const results = await Promise.allSettled(passes.map((name) => device.createComputePipelineAsync({ label: `${stem}.${name}`, layout: 'auto', compute: { module, entryPoint: name } })))
  const failed = results.findIndex((r) => r.status === 'rejected')
  if (failed >= 0) {
    const e = (results[failed] as PromiseRejectedResult).reason
    throw new ShaderRefusedError(label, passes[failed], refusalReason(e), messageOf(e), await compilationOf(module, code))
  }
  const pipelines = new Map<N, GPUComputePipeline>()
  results.forEach((r, i) => pipelines.set(passes[i], (r as PromiseFulfilledResult<GPUComputePipeline>).value))
  return { module, pipelines }
}

/** The error filters a scope can watch: everything a device can report short of losing itself. */
export const ERROR_FILTERS: readonly GPUErrorFilter[] = Object.freeze(['validation', 'out-of-memory', 'internal'])

/** The part of a device the scopes use. */
export interface ScopedDevice {
  pushErrorScope(filter: GPUErrorFilter): void
  popErrorScope(): Promise<GPUError | null>
}

/** One captured error: its filter and the browser's words. */
export interface ScopedError { filter: GPUErrorFilter; message: string }

/**
 * Runs `build` under one scope per error filter (validation, out of memory, internal) and resolves with its value and
 * the first error each scope captured, innermost popped first, in ERROR_FILTERS order. A validation scope alone let a
 * GPU that refused a buffer or a pipeline for a reason of its own go unseen until the first use.
 */
export async function withErrorScopes<T>(device: ScopedDevice, build: () => T): Promise<{ value: T; errors: ScopedError[] }> {
  for (const filter of ERROR_FILTERS) device.pushErrorScope(filter)
  const value = build()
  const popped: (GPUError | null)[] = []
  for (let i = ERROR_FILTERS.length - 1; i >= 0; i--) popped[i] = await device.popErrorScope()
  const errors: ScopedError[] = []
  ERROR_FILTERS.forEach((filter, i) => { if (popped[i]) errors.push({ filter, message: popped[i]!.message }) })
  return { value, errors }
}

/** The scoped errors as one line: the browser's words alone when validation is all that spoke, else each under its filter. */
export function scopedMessage(errors: readonly ScopedError[]): string {
  return errors.every((e) => e.filter === 'validation') ? errors.map((e) => e.message).join('; ') : errors.map((e) => `${e.filter}: ${e.message}`).join('; ')
}
