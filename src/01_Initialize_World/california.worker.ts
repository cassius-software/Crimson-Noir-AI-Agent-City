// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It builds the California-analog map off the page's thread, so the concierge can talk while
 * the ocean, hills, regions, streets and buildings are generated (californiaPack.ts). It takes a seed, reports each
 * stage in plain words, keeps the map, and answers each `pack` request with the region pack starting in the asked zone.
 * It fetches nothing and holds nothing of the page: a seed in, a pack out.
 * What breaks if it is removed? The onboarding builds the map on the page's thread, and the first words stutter.
 */
import { generateCalifornia, ZONE, type CaliforniaMap } from './california.ts'
import { packOf, type FromWorker, type ToWorker } from './californiaPack.ts'

const scope = self as unknown as { postMessage(message: FromWorker): void; onmessage: ((e: MessageEvent<ToWorker>) => void) | null }
const say = (m: FromWorker) => scope.postMessage(m)

let map: CaliforniaMap | null = null

scope.onmessage = (e) => {
  const m = e.data
  try {
    if (m.kind === 'build') {
      say({ kind: 'stage', stage: 'ocean' })
      say({ kind: 'stage', stage: 'hills' })
      map = generateCalifornia(m.seed, m.blocks)
      say({ kind: 'stage', stage: 'regions' })
      say({ kind: 'stage', stage: 'streets' })
      say({ kind: 'stage', stage: 'buildings' })
      const zoneBlocks = new Array<number>(6).fill(0)
      for (const z of map.zones) zoneBlocks[z]++
      say({ kind: 'built', seed: m.seed, blocks: m.blocks, zoneBlocks, zones: map.zones.slice() })
    } else if (m.kind === 'pack') {
      if (!map) throw new Error('no map was built yet')
      say({ kind: 'stage', stage: 'names' })
      const pack = packOf(map, m.zone in ZONE ? m.zone : ZONE.delMar)
      say({ kind: 'stage', stage: 'ready' })
      say({ kind: 'pack', id: m.id, pack })
    }
  } catch (err) {
    say({ kind: 'error', message: err instanceof Error ? err.message : String(err), ...(m.kind === 'pack' && { id: m.id }) })
  }
}
