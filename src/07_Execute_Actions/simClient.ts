/**
 * Why does this file exist? It is the page's end of the realm boundary: it starts the physics worker (inlined
 * into the single HTML file), sends the world once, then at most one step request at a time (the frame's
 * controls and queued commands, with the other local players' controls beside them; never anything about
 * pedestrians) and keeps the newest state the worker sent
 * back, with the crowd's render frame when one came. The page renders from that state, one step behind the
 * worker (the price of running physics in parallel with rendering), and hands the pose and crowd buffers back
 * for reuse. It holds numbers and a Worker handle; nothing in it can reach a Rapier body or a pedestrian.
 * What breaks if it is removed? The page cannot start or talk to the physics realm.
 */
import PhysicsWorker from './physics.worker.ts?worker&inline'
import { MAX_PLAYERS, type DriveControls, type FootControls, type FromWorker, type PlayerControls, type SimCommand, type SimInit, type SimMeta, type StepState } from './simProtocol.ts'

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
  readonly #worker: Worker
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
  /** Players 1..3's controls, sent with every step request (setPlayers); null for one player. */
  #players: PlayerControls[] | null = null

  private constructor(worker: Worker, meta: SimMeta, first: StepState) {
    this.#worker = worker
    this.meta = meta
    this.#state = first
    worker.onmessage = (e: MessageEvent<FromWorker>) => this.#receive(e.data)
    worker.onerror = (e) => { e.preventDefault(); this.#fault(`Physics realm fault: ${e.message || 'worker error'}`) }
    Object.freeze(this)
  }

  /** Builds the world in a new worker and resolves once its first state has arrived. */
  static create(init: Omit<SimInit, 't'>): Promise<SimClient> {
    const worker = new PhysicsWorker({ name: 'physics' })
    return new Promise((resolve, reject) => {
      let meta: SimMeta | null = null
      const fail = (why: string) => { worker.terminate(); reject(new Error(why)) }
      worker.onerror = (e) => { e.preventDefault(); fail(`physics worker failed to start: ${e.message || 'unknown error'}`) }
      worker.onmessage = (e: MessageEvent<FromWorker>) => {
        const m = e.data
        if (m.t === 'error') return fail(m.message)
        if (m.t === 'panic') return fail(m.reason)
        if (m.t === 'ready') {
          meta = m.meta
          const idle = { steer: 0, fwd: 0, back: 0, handbrake: false }
          worker.postMessage({ t: 'step', id: 0, dt: 0, foot: { x: 0, z: 0, heading: 0 }, drive: idle, cmds: [] })
          return
        }
        if (m.t === 'state' && meta) resolve(new SimClient(worker, meta, m))
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
   * Ring-0 audit halts the simulation or the physics realm faults.
   */
  listen(onState: (s: StepState, prev: StepState) => void, onPanic: (reason: string) => void): void {
    this.#onState = onState
    this.#onPanic = onPanic
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

  #fault(reason: string): void {
    if (this.#closed) return
    this.#closed = true
    this.#onPanic?.(reason)
  }

  /** Stops the worker (dispose). */
  terminate(): void {
    this.#closed = true
    this.#worker.terminate()
  }
}
