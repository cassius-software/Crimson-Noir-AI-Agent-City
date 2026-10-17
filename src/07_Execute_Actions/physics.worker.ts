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
import { CrowdSim } from '../03_Spawn_Agents/crowdSim.ts'
import type { FlowGrid } from '../06_Make_Decisions/flowField.ts'
import type { StreetGrid } from '../01_Initialize_World/region/streets.ts'
import type { Workplace } from '../01_Initialize_World/interiors.ts'
import { createRoutingCore } from '../06_Make_Decisions/routingWasm.ts'
import { useRoutingCore } from '../06_Make_Decisions/tracks.ts'
import { createSimHost } from './simHost.ts'
import { SimCore, type SimCoreOptions } from './simCore.ts'
import { coded } from './simProtocol.ts'

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

/**
 * The crowd's own GPU device, requested here in the worker. There is no fallback: without WebGPU in the worker
 * the realm refuses to start rather than let the page sense pedestrians for it.
 */
async function gpuCrowd(agents: number, grid: FlowGrid, streets: StreetGrid | null, rooms: readonly Workplace[] | null): Promise<CrowdSim> {
  const gpu = scope.navigator.gpu
  if (!gpu) throw coded('worker-gpu', 'WebGPU is not available inside the physics worker (the pedestrian sensing needs it there)')
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (!adapter) throw coded('worker-gpu', 'no WebGPU adapter inside the physics worker')
  const device = await adapter.requestDevice({ label: 'physics-realm crowd' })
  device.addEventListener('uncapturederror', (e) => console.error('[physics worker] crowd GPU error:', (e as GPUUncapturedErrorEvent).error.message))
  return CrowdSim.create(device, agents, grid, streets, rooms)
}

/** The realm, built on init. Rapier is WebAssembly: a browser with it switched off (Lockdown Mode, a policy) cannot build one. */
function realm(o: SimCoreOptions): Promise<SimCore> {
  if (typeof WebAssembly !== 'object') return Promise.reject(coded('wasm', 'WebAssembly is turned off in this browser (the physics needs it)'))
  return SimCore.create(o, gpuCrowd)
}

const handle = createSimHost((m, transfer) => scope.postMessage(m, transfer ?? []), realm)
// One message at a time, in arrival order; init is the only asynchronous one and the page waits for it.
let queue: Promise<void> = Promise.resolve()
scope.onmessage = (e) => {
  queue = queue.then(() => handle(e.data)).catch((err: unknown) => {
    scope.postMessage({ t: 'panic', reason: `Physics realm fault: ${err instanceof Error ? err.message : String(err)}` }, [])
  })
}
