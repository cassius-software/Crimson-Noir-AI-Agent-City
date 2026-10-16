// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the physics worker's door: the only code that reads what the page sends.
 * It treats every message as untrusted data: one init (a second is refused), then step requests whose shape
 * it checks before SimCore clamps every number; anything else is counted as refused and dropped. It replies
 * with plain-data state (the pose buffer is transferred, never shared; the one shared memory is the page's bridge of
 * sharedBridge.ts, which the realm only ever writes, under its lock, after a step) and, once the Ring-0 audit has halted
 * the simulation or this realm faults, with a panic, after which it answers nothing. No DOM, no worker API:
 * physics.worker.ts binds it to postMessage, and the node tests drive it with a plain function.
 * What breaks if it is removed? The worker cannot hear the page, and nothing vets what the page says.
 */
import { SimCore, type SimCoreOptions } from './simCore.ts'
import { MAX_PLAYERS, POSE, RIG_POSE, TRACK_POSE, type FromWorker, type SimInit } from './simProtocol.ts'
import { packAgents, packAvatars, packVehicles, PhysicsBridge } from './sharedBridge.ts'
import type { RegionGround } from './physics.ts'
import { CITY } from '../01_Initialize_World/city.ts'
import { WINDOW_BLOCKS, type StreetGrid } from '../01_Initialize_World/region/streets.ts'

export type Post = (msg: FromWorker, transfer?: Transferable[]) => void

/** Simulated time may run at most this much faster than wall time (a flood of steps cannot fast-forward the city). */
const TIME_RATE = 1.5
/** Simulated seconds that may be banked while the page is idle (a frame after a stall still gets its step). */
const TIME_BANK = 0.25
const now = (): number => (typeof performance === 'undefined' ? Date.now() : performance.now())
const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** Returns the handler for one incoming message. `create` is injectable for tests. */
/**
 * A region's physics, checked: null when there is none, undefined when it is malformed (finite, ordered bounds; walls a
 * list of finite numbers in fives, at most 4 million walls).
 */
function regionOf(u: unknown): RegionGround | null | undefined {
  if (u === undefined || u === null) return null
  if (!isRecord(u) || !isRecord(u.bounds)) return undefined
  const { x0, z0, x1, z1 } = u.bounds as Record<string, unknown>
  if (![x0, z0, x1, z1].every((n) => typeof n === 'number' && Number.isFinite(n)) || !((x0 as number) < (x1 as number) && (z0 as number) < (z1 as number))) return undefined
  const w = u.walls
  const list = w instanceof Float32Array || w instanceof Float64Array || Array.isArray(w) ? (w as ArrayLike<number>) : null
  if (!list || list.length % 5 !== 0 || list.length > 5 * 4_000_000) return undefined
  for (let i = 0; i < list.length; i++) if (typeof list[i] !== 'number' || !Number.isFinite(list[i])) return undefined
  return { bounds: { x0: x0 as number, z0: z0 as number, x1: x1 as number, z1: z1 as number }, walls: list }
}

/**
 * A region's street window, checked: null when there is none, undefined when it is malformed (a finite origin on the
 * pitch, WINDOW_BLOCKS blocks, finite positive widths, segment lists of the right length with bits 0..3).
 */
function streetsOf(u: unknown): StreetGrid | null | undefined {
  if (u === undefined || u === null) return null
  if (!isRecord(u)) return undefined
  const { originX, originZ, blocks, roadHalf, lane, furniture, h, v } = u
  if (![originX, originZ, roadHalf, lane, furniture].every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  if (blocks !== WINDOW_BLOCKS || (originX as number) % CITY.pitch !== 0 || (originZ as number) % CITY.pitch !== 0) return undefined
  if (!((roadHalf as number) > 0 && (lane as number) > (roadHalf as number) && (furniture as number) > 0)) return undefined
  const n = (WINDOW_BLOCKS + 1) * WINDOW_BLOCKS
  const list = (x: unknown): Uint8Array | null => {
    const a = x instanceof Uint8Array || Array.isArray(x) ? (x as ArrayLike<number>) : null
    if (!a || a.length !== n) return null
    const out = new Uint8Array(n)
    for (let i = 0; i < n; i++) {
      if (!(Number.isInteger(a[i]) && a[i] >= 0 && a[i] <= 3)) return null
      out[i] = a[i]
    }
    return out
  }
  const hs = list(h), vs = list(v)
  if (!hs || !vs) return undefined
  return { originX: originX as number, originZ: originZ as number, blocks: WINDOW_BLOCKS, roadHalf: roadHalf as number, lane: lane as number, furniture: furniture as number, h: hs, v: vs }
}

/**
 * The extra players' spawns, checked: an empty list when there are none, undefined when malformed (a list of at most
 * MAX_PLAYERS − 1 records with finite x and z).
 */
function spawnsOf(u: unknown): { x: number; z: number }[] | undefined {
  if (u === undefined || u === null) return []
  if (!Array.isArray(u) || u.length > MAX_PLAYERS - 1) return undefined
  const out: { x: number; z: number }[] = []
  for (const p of u) {
    if (!isRecord(p) || typeof p.x !== 'number' || typeof p.z !== 'number' || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return undefined
    out.push({ x: p.x, z: p.z })
  }
  return out
}

export function createSimHost(post: Post, create: (o: SimCoreOptions) => Promise<SimCore> = SimCore.create): (data: unknown) => Promise<void> {
  let core: SimCore | null = null
  let initStarted = false
  let refusedEarly = 0
  let panicked = false
  /** Pose buffers the page handed back, ready for reuse. */
  const pool: ArrayBuffer[] = []
  /** Craft buffers the page handed back (tracks on), ready for reuse. */
  const craftPool: ArrayBuffer[] = []
  /** Rig stream buffers the page handed back (ragdoll on), ready for reuse. */
  const rigPool: ArrayBuffer[] = []
  /** The page's zero-copy bridge once it has sent one that fits (sharedBridge.ts); written after every step. */
  let bridge: PhysicsBridge | null = null
  /** Simulated seconds the page may still spend, refilled at TIME_RATE × wall time. */
  let bank = TIME_BANK
  let lastWall = now()

  const refuse = (reason: string): void => {
    if (core) core.noteRejected(reason)
    else refusedEarly++
  }

  const panic = (reason: string): void => {
    if (panicked) return
    panicked = true
    post({ t: 'panic', reason })
  }

  return async (data: unknown): Promise<void> => {
    if (panicked) return
    if (!isRecord(data)) return refuse('not a message object')
    if (data.t === 'init') {
      if (initStarted) return refuse('init: the world is already built')
      initStarted = true
      const init = data as unknown as SimInit
      if (!Array.isArray(init.boxes) || !isRecord(init.furniture) || !isRecord(init.spawn)) {
        post({ t: 'error', message: 'init: boxes, furniture and spawn are required' })
        return
      }
      try {
        const region = regionOf(init.region)
        if (region === undefined) {
          post({ t: 'error', message: 'init: a region needs finite bounds and walls in fives' })
          return
        }
        const spawns = spawnsOf(init.spawns)
        if (spawns === undefined) {
          post({ t: 'error', message: `init: spawns must be at most ${MAX_PLAYERS - 1} finite x, z pairs` })
          return
        }
        const streets = streetsOf(init.streets)
        if (streets === undefined) {
          post({ t: 'error', message: `init: a street window is ${WINDOW_BLOCKS} blocks on the pitch with segment bits` })
          return
        }
        core = await create({
          seed: init.seed, cars: init.cars, agents: init.agents, boxes: init.boxes, furniture: init.furniture, spawn: init.spawn, spawns, debug: init.debug === true, region,
          streets: region ? streets : null, tracks: init.tracks === true, ragdoll: init.ragdoll === true,
        })
        for (let i = 0; i < refusedEarly; i++) core.noteRejected('message before init')
        post({ t: 'ready', meta: core.meta })
      } catch (e) {
        post({ t: 'error', message: `init: ${message(e)}` })
      }
      return
    }
    if (data.t === 'bridge') {
      if (!core) return refuse('bridge before init')
      if (bridge) return refuse('bridge: already bridged')
      const opened = PhysicsBridge.open(data.buffer, { vehicles: core.meta.count, avatars: core.meta.players, agents: core.meta.agents })
      if (!opened) return refuse('bridge: not a SharedArrayBuffer of the layout this world needs')
      bridge = opened
      return
    }
    if (data.t !== 'step') return refuse(`unknown message '${String(data.t)}'`)
    if (!core) return refuse('step before init')
    const id = typeof data.id === 'number' && Number.isFinite(data.id) ? data.id : 0
    const wall = now()
    bank = Math.min(TIME_BANK, bank + ((wall - lastWall) / 1000) * TIME_RATE)
    lastWall = wall
    const asked = typeof data.dt === 'number' && data.dt > 0 ? data.dt : 0
    const dt = Math.min(asked, bank)
    bank -= dt
    const bytes = core.meta.count * POSE.stride * 4
    if (data.buffer instanceof ArrayBuffer && data.buffer.byteLength === bytes && pool.length < 4) pool.push(data.buffer)
    const buffer = pool.pop() ?? new ArrayBuffer(bytes)
    if (data.crowdBuffer instanceof ArrayBuffer) core.recycleCrowd(data.crowdBuffer)
    const craftBytes = core.meta.craft * TRACK_POSE.stride * 4
    if (craftBytes > 0 && data.craftBuffer instanceof ArrayBuffer && data.craftBuffer.byteLength === craftBytes && craftPool.length < 4) craftPool.push(data.craftBuffer)
    const craft = craftBytes > 0 ? craftPool.pop() ?? new ArrayBuffer(craftBytes) : null
    const rigBytes = core.meta.rigSlots * RIG_POSE.stride * 4
    if (rigBytes > 0 && data.rigBuffer instanceof ArrayBuffer && data.rigBuffer.byteLength === rigBytes && rigPool.length < 4) rigPool.push(data.rigBuffer)
    const rigs = rigBytes > 0 ? rigPool.pop() ?? new ArrayBuffer(rigBytes) : null
    // Players 1..3: a list of records (anything else in it is an idle player); a `players` that is not a list is
    // refused and counts as none. SimCore clamps every number in them as it does player 0's.
    let players: Record<string, unknown>[] = []
    if (Array.isArray(data.players)) {
      players = data.players.slice(0, MAX_PLAYERS - 1).map((p: unknown) => (isRecord(p) ? p : {}))
    } else if (data.players !== undefined) {
      refuse('step: players must be a list')
    }
    try {
      const state = core.step({
        dt,
        foot: (isRecord(data.foot) ? data.foot : {}) as never,
        drive: (isRecord(data.drive) ? data.drive : {}) as never,
        players: players.map((p) => ({ foot: (isRecord(p.foot) ? p.foot : {}) as never, drive: (isRecord(p.drive) ? p.drive : {}) as never })),
        cmds: Array.isArray(data.cmds) ? data.cmds : [],
      }, new Float32Array(buffer), craft ? new Float32Array(craft) : null, rigs ? new Float32Array(rigs) : null)
      // The zero-copy bridge, written under its lock before the state is posted: the page may read it the moment
      // the publish count moves, with no message in between. The poses and the frame are the audited buffers above.
      if (bridge && !core.halted) {
        const frame = state.crowdFrame, activity = core.crowdActivity
        bridge.publish(id, state.simTime, state.drivings, (f32, i32, b) => {
          packVehicles(f32, i32, b.vehicles, state.poses, b.counts.vehicles, POSE.stride, POSE.mode)
          packAvatars(f32, i32, b.avatars, state.avatars, b.counts.avatars)
          if (frame) packAgents(f32, i32, b.agents, frame, b.counts.agents, activity)
        })
      }
      // Anything else the page put in the message (a hazard array, GPU flags, a clock) is never read.
      const transfer: Transferable[] = [buffer]
      if (state.crowdFrame) transfer.push(state.crowdFrame.buffer as ArrayBuffer)
      if (state.craft) transfer.push(state.craft.buffer as ArrayBuffer)
      else if (craft) craftPool.push(craft)
      if (state.rigs) transfer.push(state.rigs.buffer as ArrayBuffer)
      else if (rigs) rigPool.push(rigs)
      post({ t: 'state', id, ...state }, transfer)
    } catch (e) {
      // A fault inside this realm leaves the simulation in an unknown state: it is halted like a panic.
      core.halt(`Physics realm fault: ${message(e)}`)
    }
    if (core.halted) panic(core.panic ?? 'halted')
  }
}
