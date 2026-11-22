// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A generated region's lamps, trees and signal poles used to stand along its 640 m street
 * window only, so a visitor who walked out of it found streets with no lamp, no tree and no signal, dark after sunset.
 * The page now draws the whole map's street furniture (streets.ts windowFurniture over mapStreetGrid: about 46,000
 * props on Lakefront Metro), which is sixteen times the window's and far too much to draw every frame, so this file
 * cuts it into square tiles TILE_BLOCKS blocks a side and says which tiles a place needs (tilesWithin): the world draws
 * one instanced mesh per kind of prop per tile and shows only the tiles within the tier's prop reach (governor.ts
 * propReach), each culled by the camera's frustum as one sphere.
 * - tileFurniture lists every prop of each kind tile by tile (row by row of tiles, each tile's props in the order the
 *   furniture gave them), so a tile's props are one run of the list: the instance a mesh draws is a run's slot, and an
 *   index into the list (the pole index of contact.ts, the code dissolve's slot, a ping's pick) finds its tile at once.
 * - Every prop falls in exactly one tile, by where it stands (a prop on the map's outer kerb in the edge tile, one
 *   whose place is not a number in the first), so the tiles together are the furniture, each prop once.
 * - PROP_FOLD and propKeep: how a prop folds to its foot as it nears the reach, the same number for the props' shader,
 *   a lit lamp's real light and its painted pool (world.ts, regionWorld.ts), so no light shines where no pole stands.
 * Pure: numbers in, numbers out, nothing of three.
 * What breaks if it is removed? The region's props are the window's alone again, or the whole map's drawn every frame.
 */
import { CITY, type Furniture } from '../city.ts'

/** A tile's side, blocks: 160 m, so a tile holds at most a few hundred props and a phone's reach takes about nine. */
export const TILE_BLOCKS = 4
/** A tile's side, m. */
export const TILE = TILE_BLOCKS * CITY.pitch

/**
 * One tile: its bounds (engine metres) and, per kind of prop, the run [start, end) of the tiled lists it holds. The bounds
 * are its square, grown over any prop it holds that stands outside it (the props on the map's outer kerb, a few metres
 * past the last street line), so a place within reach of a prop is within reach of its tile.
 */
export interface PropTile {
  /** Column and row of the tile, from the map's north-west corner. */
  i: number
  j: number
  x0: number
  z0: number
  x1: number
  z1: number
  lamps: readonly [number, number]
  trees: readonly [number, number]
  signals: readonly [number, number]
}

/** The furniture in tile order and the tiles that cut it (tileFurniture). */
export interface TiledFurniture {
  furniture: Furniture
  tiles: readonly PropTile[]
  /** Tiles per axis. */
  across: number
  /** The tiles' north-west corner, engine metres. */
  originX: number
  originZ: number
}

/**
 * The furniture of a map whose north-west corner is (originX, originZ) and which is `blocks` blocks a side, in tile
 * order, with its tiles. Deterministic, the input only read; an empty kind gives empty runs.
 */
export function tileFurniture(f: Furniture, map: { originX: number; originZ: number; blocks: number }): TiledFurniture {
  const across = Math.max(1, Math.ceil(map.blocks / TILE_BLOCKS))
  // A place off the map is in the tile at its edge; one that is not a number, in the first.
  const along = (v: number, origin: number): number => {
    const k = Math.floor((v - origin) / TILE)
    return Number.isNaN(k) ? 0 : Math.min(across - 1, Math.max(0, k))
  }
  const cellOf = (x: number, z: number): number => along(z, map.originZ) * across + along(x, map.originX)
  // A stable bucket sort per kind: the tile's props keep the order they had.
  const sort = <T extends readonly number[]>(list: readonly T[]): { out: T[]; runs: [number, number][] } => {
    const counts = new Uint32Array(across * across)
    const cells = list.map(([x, z]) => cellOf(x, z))
    for (const c of cells) counts[c]++
    const starts = new Uint32Array(across * across + 1)
    for (let c = 0; c < counts.length; c++) starts[c + 1] = starts[c] + counts[c]
    const out = new Array<T>(list.length)
    const fill = starts.slice(0, counts.length)
    cells.forEach((c, n) => { out[fill[c]++] = list[n] })
    const runs: [number, number][] = []
    for (let c = 0; c < counts.length; c++) runs.push([starts[c], starts[c + 1]])
    return { out, runs }
  }
  const lamps = sort(f.lamps), trees = sort(f.trees), signals = sort(f.signals)
  const tiles: PropTile[] = []
  for (let j = 0; j < across; j++) {
    for (let i = 0; i < across; i++) {
      const c = j * across + i
      let x0 = map.originX + i * TILE, z0 = map.originZ + j * TILE, x1 = x0 + TILE, z1 = z0 + TILE
      for (const [list, runs] of [[lamps.out, lamps.runs], [trees.out, trees.runs], [signals.out, signals.runs]] as const) {
        for (let n = runs[c][0]; n < runs[c][1]; n++) {
          const [x, z] = list[n]
          if (!Number.isFinite(x) || !Number.isFinite(z)) continue
          x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z)
        }
      }
      tiles.push(Object.freeze({ i, j, x0, z0, x1, z1, lamps: lamps.runs[c], trees: trees.runs[c], signals: signals.runs[c] }))
    }
  }
  return {
    furniture: { lamps: lamps.out, trees: trees.out, signals: signals.out },
    tiles: Object.freeze(tiles), across, originX: map.originX, originZ: map.originZ,
  }
}

/** The squared distance from (x, z) to a tile's bounds (0 inside them). */
export function tileDistance2(t: Pick<PropTile, 'x0' | 'z0' | 'x1' | 'z1'>, x: number, z: number): number {
  const dx = Math.max(t.x0 - x, 0, x - t.x1), dz = Math.max(t.z0 - z, 0, z - t.z1)
  return dx * dx + dz * dz
}

/**
 * Whether a tile has any ground within `reach` of (x, z): every prop within `reach` stands in such a tile. A place
 * that is not finite needs no tile.
 */
export function tileWithin(t: Pick<PropTile, 'x0' | 'z0' | 'x1' | 'z1'>, x: number, z: number, reach: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(z) || !(reach > 0)) return false
  return tileDistance2(t, x, z) < reach * reach
}

/** The indices of the tiles with ground within `reach` of (x, z), in tile order (tileWithin). */
export function tilesWithin(tiled: Pick<TiledFurniture, 'tiles'>, x: number, z: number, reach: number): number[] {
  const out: number[] = []
  tiled.tiles.forEach((t, n) => { if (tileWithin(t, x, z, reach)) out.push(n) })
  return out
}

/**
 * How far before the prop reach a generated region's street furniture folds down to its feet, m (world.ts
 * placeInTiles): a prop PROP_FOLD metres inside the reach stands whole, one at the reach is a point on the ground, so a
 * tile that comes into reach shows nothing new and props grow out of the street as the visitor nears them.
 */
export const PROP_FOLD = 40

/**
 * How much of a prop stands `distance` m from the focus under a reach of `reach` m: 1 whole, 0 folded to its foot, by
 * the smoothstep the props' shader takes over the reach's last PROP_FOLD metres (world.ts placeInTiles). A lit lamp's
 * real light and its painted pool are scaled by it, so neither shines where its pole is not drawn. Not a number: 0.
 */
export function propKeep(distance: number, reach: number): number {
  if (!Number.isFinite(distance) || !Number.isFinite(reach)) return 0
  const t = Math.min(1, Math.max(0, (distance - (reach - PROP_FOLD)) / PROP_FOLD))
  return 1 - t * t * (3 - 2 * t)
}
