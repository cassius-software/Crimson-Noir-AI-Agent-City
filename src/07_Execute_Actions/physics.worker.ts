// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the physics realm: a dedicated Web Worker that alone owns the Rapier
 * world, the fleet, the avatar, the Bouncer, the Sanctuary, the Ring-0 auditor (simCore.ts) and the GPU
 * pedestrian crowd with its First-Law hazard sensing, on a GPU device of its own (crowdSim.ts). The page
 * builds it once (simClient.ts, inlined into the single HTML file) and can only exchange messages with it; a
 * worker's heap and its GPU device are not reachable from the page's scripts, so no DOM script, React
 * component or injected code can read or write a body or a pedestrian, lower a hazard reading, swap a law or
 * skip the audit. Everything it hears goes through simHost.ts. The worker has a global object of its own, so it
 * installs the air gap on it first (02_Define_The_Rules/airgap.ts): nothing in the realm can address anything off
 * this machine either.
 * What breaks if it is removed? There is no physics and no crowd, and nothing separates them from the page.
 */
import { installAirgap } from '../02_Define_The_Rules/airgap.ts'
import { CrowdSim, KernelLostError } from '../03_Spawn_Agents/crowdSim.ts'
import type { CrowdKernel } from '../03_Spawn_Agents/crowdSensor.ts'
import { adapterLine } from '../01_Initialize_World/gpuDevice.ts'
import { lossOf } from '../01_Initialize_World/gpuPipelines.ts'
import type { FlowGrid } from '../06_Make_Decisions/flowField.ts'
import type { StreetGrid } from '../01_Initialize_World/region/streets.ts'
import type { Workplace } from '../01_Initialize_World/interiors.ts'
import { createRoutingCore } from '../06_Make_Decisions/routingWasm.ts'
import { useRoutingCore } from '../06_Make_Decisions/tracks.ts'
import { createSimHost } from './simHost.ts'
import { SensingLostError, SimCore, type SimCoreOptions } from './simCore.ts'
import { coded, type SimCrowdKernel } from './simProtocol.ts'

installAirgap(globalThis)
// The track arithmetic as WebAssembly (routingWasm.ts): the fleet's rings are laid into its arena on first sight. The
// core is optional (tracks.ts answers every call itself), so a browser that refuses it does not stop the worker here:
// the realm still starts if it can, and says why if it cannot (Rapier needs WebAssembly too: realm below).
try {
  // oxlint-disable-next-line react/rules-of-hooks -- not a React hook: tracks.ts takes its routing core
  useRoutingCore(createRoutingCore())
} catch (e) {
  console.warn(`[physics worker] the routing core did not load; the TypeScript tracks answer instead: ${e instanceof Error ? e.message : String(e)}`)
}

const scope = self as unknown as {
  postMessage(message: unknown, transfer: Transferable[]): void
  onmessage: ((e: MessageEvent) => void) | null
  navigator: { gpu?: GPU }
}

/** The browser's words on the page's card and in its memory, at most (a driver's message can run to pages). */
const WORDS_MAX = 600
/** Tells the page the crowd's kernel ladder moved (simProtocol.ts SimCrowdKernel). */
const ladder = (rung: CrowdKernel, step: SimCrowdKernel['step'], words?: string): void => {
  scope.postMessage({ t: 'crowdKernel', rung, step, ...(words && { words: words.slice(0, WORDS_MAX) }) } satisfies SimCrowdKernel, [])
}

/**
 * The crowd's own GPU device, requested here in the worker. There is no fallback: without WebGPU in the worker
 * the realm refuses to start rather than let the page sense pedestrians for it. The ladder of kernels starts at
 * `from` (what the page remembers of this GPU), and every step of it is told to the page as it happens, before the
 * compile it announces: a GPU process that dies under a kernel takes the page's device with it, and the page must
 * already know which kernel was being built. A device lost under a kernel fails the realm as 'kernel-lost'; nothing
 * is tried on another device here, because the page (whose device is usually gone too) starts again with the
 * kernel it then remembers.
 */
async function gpuCrowd(agents: number, grid: FlowGrid, streets: StreetGrid | null, rooms: readonly Workplace[] | null, from?: CrowdKernel): Promise<CrowdSim> {
  const gpu = scope.navigator.gpu
  if (!gpu) throw coded('worker-gpu', 'WebGPU is not available inside the physics worker (the pedestrian sensing needs it there)')
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw coded('worker-gpu', 'no WebGPU adapter inside the physics worker')
  const device = await adapter.requestDevice({ label: 'physics-realm crowd' })
  // A device handed over already lost (the browser's GPU process went between the adapter and the device, as right
  // after a restart that follows a crash) is a loss of its own: no kernel was asked of it, and none is blamed.
  const born = await lossOf(device)
  if (born) throw new Error(`GPU device lost (${born.reason}) as the physics worker was given it: ${born.message || 'no message'}`)
  // Errors no scope captured, kept while the crowd is built: a failure's words then carry them to the page's card, where
  // a phone's console is nothing anyone reads. The adapter's line names the GPU that refused, the page's own being unknown
  // to this worker (and unknown to the card when the city failed before the page's engine stood).
  const uncaptured: string[] = []
  device.addEventListener('uncapturederror', (e) => {
    const message = (e as GPUUncapturedErrorEvent).error.message
    if (uncaptured.length < 8) uncaptured.push(message)
    console.error('[physics worker] crowd GPU error:', message)
  })
  try {
    return await CrowdSim.create(device, agents, grid, streets, rooms, { from, note: (rung, step, words) => ladder(rung, step, words) })
  } catch (e) {
    const info = adapterLine((adapter as Partial<Pick<GPUAdapter, 'info'>>).info)
    const extra = uncaptured.length ? `; uncaptured GPU errors meanwhile: ${uncaptured.join(' | ')}` : ''
    const words = `${e instanceof Error ? e.message : String(e)} [crowd device: ${info}${extra}]`
    if (e instanceof KernelLostError) {
      ladder(e.rung, 'lost', e.loss.message)
      throw coded('kernel-lost', words)
    }
    throw new Error(words)
  }
}

/**
 * The realm, built on init. Rapier is WebAssembly: a browser with it switched off (Lockdown Mode, a policy) cannot build
 * one. A crowd whose device is lost before its first reading (simCore.ts SensingLostError: the kernel's first dispatch)
 * is the kernel's loss as well, told to the page the same way (a device destroyed on purpose is not one).
 */
function realm(o: SimCoreOptions): Promise<SimCore> {
  if (typeof WebAssembly !== 'object') return Promise.reject(coded('wasm', 'WebAssembly is turned off in this browser (the physics needs it)'))
  return SimCore.create(o, gpuCrowd).catch((e: unknown) => {
    if (!(e instanceof SensingLostError) || e.destroyed) throw e
    ladder(e.kernel, 'lost', e.message)
    throw coded('kernel-lost', e.message)
  })
}

const handle = createSimHost((m, transfer) => scope.postMessage(m, transfer ?? []), realm)
// One message at a time, in arrival order; init is the only asynchronous one and the page waits for it.
let queue: Promise<void> = Promise.resolve()
scope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data)).catch((err: unknown) => {
    scope.postMessage({ t: 'panic', reason: `Physics realm fault: ${err instanceof Error ? err.message : String(err)}` }, [])
  })
}
