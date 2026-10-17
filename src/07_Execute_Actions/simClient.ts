// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's end of the realm boundary: it starts the physics worker (inlined
 * into the single HTML file), sends the world once, then at most one step request at a time (the frame's
 * controls and queued commands, with the other local players' controls beside them; never anything about
 * pedestrians) and keeps the newest state the worker sent
 * back, with the crowd's render frame when one came. The page renders from that state, one step behind the
 * worker (the price of running physics in parallel with rendering), and hands the pose and crowd buffers back
 * for reuse. It holds numbers and a Worker handle; nothing in it can reach a Rapier body or a pedestrian. It also owns
 * the page's end of the zero-copy bridge (sharedBridge.ts): on a cross-origin isolated page a SharedArrayBuffer the
 * worker fills after every step (sent once, after `ready`), which the page reads with no message and no copy; elsewhere
 * a plain buffer of the same layout the client fills itself from each state, so readers never know the difference.
 * What breaks if it is removed? The page cannot start or talk to the physics realm.
 */
import PhysicsWorker from './physics.worker.ts?worker&inline'
import { trackWorker } from './longTasks.ts'
import { coded, MAX_PLAYERS, POSE, type DriveControls, type FootControls, type FromWorker, type PlayerControls, type SimCommand, type SimFailureCode, type SimInit, type SimMeta, type StepState } from './simProtocol.ts'
import { canShareMemory, packAgents, packAvatars, packVehicles, PhysicsBridge } from './sharedBridge.ts'

/** Commands waiting for the next step request; a flood beyond this is dropped here (the worker caps them too). */
const MAX_QUEUE = 256

export interface StepInput {
  dt: number
  foot: FootControls
  drive: DriveControls
  /** Players 1..3 (index k − 1 for player k); absent or short means idle players. */
  players?: PlayerControls[]
}

export class SimClient {
  readonly meta: SimMeta
  /** The zero-copy bridge: shared with the worker when the page is cross-origin isolated, else filled here per state. */
  readonly bridge: PhysicsBridge
  readonly #worker: Worker
  /** Takes the worker off the live-thread count (longTasks.ts) once it is terminated. */
  readonly #untrack: () => void
  #state: StepState
  #onState: ((s: StepState, prev: StepState) => void) | null = null
  #onPanic: ((reason: string) => void) | null = null
  #pending = false
  #id = 0
  #spare: ArrayBuffer | null = null
  #spareCrowd: ArrayBuffer | null = null
  #spareCraft: ArrayBuffer | null = null
  #spareRigs: ArrayBuffer | null = null
  #queue: SimCommand[] = []
  /** Commands that go ahead of the queue in the next request (send's `first`). */
  #first: SimCommand[] = []
  #dropped = 0
  #closed = false
  /**
   * A fault that came before anyone listened (a worker error or panic between `ready` and the engine's listen(), while
   * the page still compiles): held, so listen() hands it on rather than the city starting on a closed client.
   */
  #missed: string | null = null
  /** Players 1..3's controls, sent with every step request (setPlayers); null for one player. */
  #players: PlayerControls[] | null = null

  private constructor(worker: Worker, untrack: () => void, meta: SimMeta, first: StepState, bridge: PhysicsBridge) {
    this.#worker = worker
    this.#untrack = untrack
    this.meta = meta
    this.bridge = bridge
    this.#state = first
    if (!bridge.shared) this.#fill(first)
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.#receive(e.data)
    worker.onerror = (e) => { e.preventDefault(); this.#fault(`Physics realm fault: ${e.message || 'worker error'}`) }
    Object.freeze(this)
  }

  /**
   * Builds the world in a new worker and resolves once its first state has arrived. `share`: whether the bridge may
   * be a SharedArrayBuffer (by default, whether this page is cross-origin isolated: sharedBridge.ts canShareMemory).
   */
  static create(init: Omit<SimInit, 't'>, share: boolean = canShareMemory()): Promise<SimClient> {
    const worker = new PhysicsWorker({ name: 'physics' })
    const untrack = trackWorker()
    return new Promise((resolve, reject) => {
      let meta: SimMeta | null = null
      let bridge: PhysicsBridge | null = null
      // The worker's class of the failure (no WebGPU in the worker, no WebAssembly) stays on the error for the card.
      const fail = (why: string, code?: SimFailureCode) => { worker.terminate(); untrack(); reject(code ? coded(code, why) : new Error(why)) }
      worker.onerror = (e) => { e.preventDefault(); fail(`physics worker failed to start: ${e.message || 'unknown error'}`) }
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data
        if (m.t === 'error') return fail(m.message, m.code)
        if (m.t === 'panic') return fail(m.reason)
        if (m.t === 'ready') {
          meta = m.meta
          // The bridge is laid out from the world the worker built; shared memory goes over once, before the first step.
          bridge = PhysicsBridge.create({ vehicles: meta.count, avatars: meta.players, agents: meta.agents }, share)
          if (bridge.shared) worker.postMessage({ t: 'bridge', buffer: bridge.buffer })
          const idle = { steer: 0, fwd: 0, back: 0, handbrake: false }
          worker.postMessage({ t: 'step', id: 0, dt: 0, foot: { x: 0, z: 0, heading: 0 }, drive: idle, cmds: [] })
          return
        }
        if (m.t === 'state' && meta && bridge) resolve(new SimClient(worker, untrack, meta, m, bridge))
      }
      worker.postMessage({ t: 'init', ...init } satisfies SimInit)
    })
  }

  /** The newest state from the worker (the page renders from it). Replaced, never mutated, per step. */
  get state(): StepState {
    return this.#state
  }

  /**
   * `onState` runs for each new state, before the next frame renders it; `onPanic` once, when the worker's
   * Ring-0 audit halts the simulation or the physics realm faults. A fault that came before this call is handed to
   * `onPanic` now.
   */
  listen(onState: (s: StepState, prev: StepState) => void, onPanic: (reason: string) => void): void {
    this.#onState = onState
    this.#onPanic = onPanic
    const missed = this.#missed
    this.#missed = null
    if (missed !== null) onPanic(missed)
  }

  /** The fault that closed this client before anyone listened, or null (Engine.create refuses to start on one). */
  get fault(): string | null {
    return this.#missed
  }

  /** True while a step request is out (the worker has not answered it yet). */
  get pending(): boolean {
    return this.#pending
  }

  /** Commands dropped because the queue was full. */
  get dropped(): number {
    return this.#dropped
  }

  /**
   * The extra players' controls (local split screen, index k − 1 for player k) that every step request carries from
   * now on, read at each request (the engine fills the same records in place every frame); null or empty: none sent.
   */
  setPlayers(players: readonly PlayerControls[] | null): void {
    this.#players = players && players.length > 0 ? players.slice(0, MAX_PLAYERS - 1) : null
  }

  /**
   * Queues a command for the next step request. `first`: ahead of every command queued the ordinary way (a network
   * room's switch and corrections: the player's own commands, queued before the truth arrived, then act on the truth).
   */
  send(cmd: SimCommand, first = false): void {
    if (this.#closed) return
    if (this.#queue.length + this.#first.length >= MAX_QUEUE) { this.#dropped++; return }
    if (first) this.#first.push(cmd)
    else this.#queue.push(cmd)
  }

  /**
   * Sends one step request unless the previous one is still out (then false: the caller keeps its dt and sends
   * it with the next). The last pose buffer goes back to the worker for reuse.
   */
  request(input: StepInput): boolean {
    if (this.#pending || this.#closed) return false
    this.#pending = true
    const cmds = this.#first.length > 0 ? [...this.#first, ...this.#queue] : this.#queue
    this.#first = []
    this.#queue = []
    const buffer = this.#spare, crowdBuffer = this.#spareCrowd, craftBuffer = this.#spareCraft, rigBuffer = this.#spareRigs
    this.#spare = null
    this.#spareCrowd = null
    this.#spareCraft = null
    this.#spareRigs = null
    const transfer: ArrayBuffer[] = []
    if (buffer) transfer.push(buffer)
    if (crowdBuffer) transfer.push(crowdBuffer)
    if (craftBuffer) transfer.push(craftBuffer)
    if (rigBuffer) transfer.push(rigBuffer)
    const players = input.players ?? this.#players ?? undefined
    this.#worker.postMessage({
      t: 'step', id: ++this.#id, ...input, players, cmds, buffer: buffer ?? undefined, crowdBuffer: crowdBuffer ?? undefined, craftBuffer: craftBuffer ?? undefined,
      rigBuffer: rigBuffer ?? undefined,
    }, transfer)
    return true
  }

  #receive(m: FromWorker): void {
    if (this.#closed) return
    if (m.t === 'state') {
      const prev = this.#state
      this.#state = m
      this.#pending = false
      // Without shared memory the bridge is this page's own: filled from the state before anyone reads it.
      if (!this.bridge.shared) this.#fill(m)
      // The previous frame's poses and craft are no longer read once the new state is in: hand them back.
      this.#spare = prev.poses.buffer as ArrayBuffer
      this.#spareCraft = prev.craft ? (prev.craft.buffer as ArrayBuffer) : null
      this.#spareRigs = prev.rigs ? (prev.rigs.buffer as ArrayBuffer) : null
      try {
        this.#onState?.(m, prev)
      } catch (e) {
        console.error(e)
      }
      // The listener has uploaded the crowd frame (writeBuffer copies it): its buffer goes back to the worker.
      if (m.crowdFrame) {
        this.#spareCrowd = m.crowdFrame.buffer as ArrayBuffer
        m.crowdFrame = null
      }
      return
    }
    if (m.t === 'panic') return this.#fault(m.reason)
    if (m.t === 'error') return this.#fault(`Physics realm fault: ${m.message}`)
  }

  /** The plain-buffer bridge filled from a state: the same words the worker writes over shared memory. */
  #fill(s: StepState): void {
    const b = this.bridge
    b.publish(s.id, s.simTime, s.drivings, (f32, i32) => {
      packVehicles(f32, i32, b.vehicles, s.poses, b.counts.vehicles, POSE.stride, POSE.mode)
      packAvatars(f32, i32, b.avatars, s.avatars, b.counts.avatars)
      if (s.crowdFrame) packAgents(f32, i32, b.agents, s.crowdFrame, b.counts.agents, null)
    })
  }

  #fault(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#onPanic) this.#onPanic(reason)
    else this.#missed = reason
  }

  /** Stops the worker (dispose). */
  terminate(): void {
    this.#closed = true
    this.#worker.terminate()
    this.#untrack()
  }
}
