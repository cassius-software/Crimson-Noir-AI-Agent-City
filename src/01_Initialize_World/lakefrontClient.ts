// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's handle on the map builder (lakefront.worker.ts): start the build for a seed
 * the moment the onboarding opens, hear each stage in plain words, and ask for the pack once the visitor has chosen
 * where to start. Where workers are not available (a test, an odd embedding) it builds on the page's thread instead,
 * with the same stages, so the onboarding never depends on a worker existing.
 * What breaks if it is removed? The onboarding and `?map=lakefront` have no way to build the map in the background.
 */
import { generateLakefront, type LakefrontMap, type Zone } from './lakefront.ts'
import { BUILD_STAGES, WALK_BLOCKS, packOf, type BuildStage, type FromWorker, type ToWorker } from './lakefrontPack.ts'
import type { RegionPack } from './region/pack.ts'

/** Something that posts to and hears from the builder: a Worker, or the inline stand-in. */
export interface BuilderPort {
  postMessage(m: ToWorker): void
  onmessage: ((e: { data: FromWorker }) => void) | null
  terminate(): void
}

/** The builder run on this thread, for pages and tests without workers: same protocol, same stages, same bytes. */
export function inlinePort(): BuilderPort {
  let map: LakefrontMap | null = null
  const port: BuilderPort = {
    onmessage: null,
    terminate: () => { map = null },
    postMessage: (m) => {
      const say = (r: FromWorker) => port.onmessage?.({ data: r })
      try {
        if (m.kind === 'build') {
          for (const stage of BUILD_STAGES.slice(0, 2)) say({ kind: 'stage', stage })
          map = generateLakefront(m.seed, m.blocks)
          for (const stage of BUILD_STAGES.slice(2, 5)) say({ kind: 'stage', stage })
          const zoneBlocks = new Array<number>(6).fill(0)
          for (const z of map.zones) zoneBlocks[z]++
          say({ kind: 'built', seed: m.seed, blocks: m.blocks, zoneBlocks, zones: map.zones.slice() })
        } else {
          if (!map) throw new Error('no map was built yet')
          say({ kind: 'stage', stage: 'names' })
          const pack = packOf(map, m.zone)
          say({ kind: 'stage', stage: 'ready' })
          say({ kind: 'pack', id: m.id, pack })
        }
      } catch (err) {
        say({ kind: 'error', message: err instanceof Error ? err.message : String(err), ...(m.kind === 'pack' && { id: m.id }) })
      }
    },
  }
  return port
}

/** The builder's Worker as builderPort holds it: a port that can also fail as a whole (its script, an uncaught throw). */
export interface BuilderWorker extends BuilderPort {
  onerror: ((e: { message?: string; preventDefault?(): void }) => void) | null
}

/**
 * The worker as a port whose own failure reaches the client as an error message (the worker reports it as an `error`
 * event, never as a message): the build and every pack asked for reject with it instead of waiting forever, so a
 * returning visitor is not left on the splash and the onboarding goes on to the first city.
 */
export function reportingPort(worker: BuilderWorker): BuilderPort {
  worker.onerror = (e) => {
    e.preventDefault?.()
    worker.onmessage?.({ data: { kind: 'error', message: `the map builder stopped: ${e.message || 'worker error'}` } })
  }
  return worker
}

export interface BuilderEvents {
  /** Each stage of the build, in order, as plain words are wanted. */
  onStage?(stage: BuildStage): void
  /** The map is built (the pack can be asked for): how many blocks each zone has, and the zone of every block (row-major, `blocks` per row). */
  onBuilt?(zoneBlocks: readonly number[], zones: Uint8Array): void
}

/**
 * The map builder: `start` begins the build at once; `pack(zone)` resolves with the region pack starting in that zone
 * (after the build, however early it is asked); `dispose` ends the worker. One builder, one seed.
 */
export class LakefrontBuilder {
  private readonly port: BuilderPort
  private built: Promise<readonly number[]>
  private resolveBuilt!: (zoneBlocks: readonly number[]) => void
  private rejectBuilt!: (err: Error) => void
  private readonly waiting = new Map<number, { resolve(p: RegionPack): void; reject(e: Error): void }>()
  private next = 1
  private disposed = false
  /** The error that ended the builder (its build or its whole worker): every later pack rejects with it. */
  private failed: Error | null = null
  readonly seed: number
  readonly blocks: number

  constructor(seed: number, port: BuilderPort, events: BuilderEvents = {}, blocks: number = WALK_BLOCKS) {
    this.seed = seed
    this.blocks = blocks
    this.port = port
    this.built = new Promise<readonly number[]>((resolve, reject) => { this.resolveBuilt = resolve; this.rejectBuilt = reject })
    this.built.catch(() => {}) // observed by pack(); an unobserved rejection is not an error here
    port.onmessage = (e) => {
      const m = e.data
      if (m.kind === 'stage') events.onStage?.(m.stage)
      else if (m.kind === 'built') { events.onBuilt?.(m.zoneBlocks, m.zones); this.resolveBuilt(m.zoneBlocks) }
      else if (m.kind === 'pack') { this.waiting.get(m.id)?.resolve(m.pack); this.waiting.delete(m.id) }
      else if (m.kind === 'error') {
        const err = new Error(m.message)
        if (m.id !== undefined) { this.waiting.get(m.id)?.reject(err); this.waiting.delete(m.id); return }
        // An error that names no request is the build's, or the whole worker's: nothing it was asked will come now.
        this.failed = err
        this.rejectBuilt(err)
        for (const w of this.waiting.values()) w.reject(err)
        this.waiting.clear()
      }
    }
    port.postMessage({ kind: 'build', seed, blocks })
  }

  /** The region pack with `zone`'s centre at the visitor's feet; rejects if the build failed or the builder is disposed. */
  async pack(zone: Zone): Promise<RegionPack> {
    await this.built
    if (this.disposed) throw new Error('the map builder was disposed')
    if (this.failed) throw this.failed
    const id = this.next++
    return new Promise<RegionPack>((resolve, reject) => {
      this.waiting.set(id, { resolve, reject })
      this.port.postMessage({ kind: 'pack', zone, id })
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.port.onmessage = null
    this.port.terminate()
    const gone = new Error('the map builder was disposed')
    for (const w of this.waiting.values()) w.reject(gone)
    this.waiting.clear()
    this.rejectBuilt(gone)
  }
}
