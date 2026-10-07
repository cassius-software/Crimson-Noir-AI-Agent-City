/**
 * Why does this file exist? The code dissolve: when the user's body meets an agent, a vehicle or a prop, that mesh
 * dissolves into falling green binary code and reinstantiates once clear. This is the render half, one TSL helper any
 * MeshStandardNodeMaterial takes: given a per-instance `amount` (0 solid, 1 gone), the mesh's cells vanish top-down
 * in falling columns as the amount rises, the cells still standing keep the base shading dimmed by (1 − amount) and
 * glow with green glyph ink (an alphabet of two glyphs, '0' and '1', drawn from strokes here: no font), and at full
 * amount every vertex folds to `origin` so nothing is rasterised at all. The mask it sets also governs the shadow
 * pass, so a dissolved mesh casts no shadow either. It costs nothing while no instance dissolves: the amount is 0,
 * every cell survives, the shading is untouched.
 * - Stage 01 so the world's props (world.ts), the fleet (fleetView.ts) and the crowd (crowd.ts) can all take it
 *   without a stage-order violation; it imports only three.
 * - Pure: it builds nodes and never needs a renderer, so the graph is tested under Node.
 * What breaks if it is removed? The passage through a lamp, a car or a person clips the camera through solid
 * geometry; the envelope in 07_Execute_Actions/dissolve.ts would drive nothing.
 */
import type { MeshStandardNodeMaterial, Node, NodeBuilder } from 'three/webgpu'
import {
  Fn, bool, clamp, dot, exp, float, floor, fract, hash, length, materialColor, max, mix, positionLocal, positionPrevious,
  screenCoordinate, screenSize, select, smoothstep, step, time, vec2, vec3,
} from 'three/tsl'

/** The look of the falling code a mesh becomes. */
export const CODE_DISSOLVE = Object.freeze({
  /** Glyph rows on screen (cells are 0.64 as wide as tall, at least 10 px tall). */
  rows: 40,
  /** Falling speed of a column, rows/s, and the spread between columns. */
  speed: 5,
  speedSpread: 7,
  /** Rows of fading trail behind a column's head. */
  trail: 8,
  /** How much the emissive ink glows (scene-referred, before the output transform). */
  glow: 6,
  /** An amount at or above this folds the whole mesh to its origin: nothing rasterised. */
  fold: 0.999,
  /** An amount below this leaves the mesh exactly as it was. */
  idle: 0.001,
})

type V2 = Node<'vec2'>
type V3 = Node<'vec3'>
type F1 = Node<'float'>

/** Whether the pass being built writes motion vectors (three's builder knows; its typings leave the method out). */
const needsPrevious = (b: NodeBuilder): boolean => (b as NodeBuilder & { needsPreviousData(): boolean }).needsPreviousData()

/** Distance from p to the segment ab. */
const segment = (p: V2, a: V2, b: V2): F1 => {
  const pa = p.sub(a), ba = b.sub(a)
  const t = clamp(dot(pa, ba).div(dot(ba, ba)), 0, 1)
  return length(pa.sub(ba.mul(t)))
}

/**
 * The binary alphabet: a '0' (a rectangle outline from four strokes) and a '1' (one vertical stroke with a short
 * flag), as segments on the unit glyph box. Each is the product's own, drawn here from strokes, not from any font.
 */
export const BINARY_GLYPHS: Readonly<Record<'zero' | 'one', readonly (readonly [number, number, number, number])[]>> = Object.freeze({
  zero: Object.freeze([[0.15, 0, 0.85, 0], [0.85, 0, 0.85, 1], [0.85, 1, 0.15, 1], [0.15, 1, 0.15, 0]].map((s) => Object.freeze(s as [number, number, number, number]))),
  one: Object.freeze([[0.5, 0, 0.5, 1], [0.5, 0, 0.2, 0.25]].map((s) => Object.freeze(s as [number, number, number, number]))),
})

/**
 * Ink of the glyph at `local` (0..1 in its cell of `cellPx` pixels): the '1' where `one` is set, the '0' otherwise;
 * strokes of about 1.2 px, anti-aliased by a pixel, inside a margin.
 */
function digitInk(local: V2, cellPx: V2, one: F1): F1 {
  const scale = cellPx.mul(vec2(0.72, 0.76))
  const p = local.sub(vec2(0.14, 0.12)).mul(cellPx)
  const inkOf = (strokes: readonly (readonly [number, number, number, number])[]): F1 => {
    let ink: F1 = float(0)
    for (const [ax, ay, bx, by] of strokes) {
      const d = segment(p, vec2(ax, ay).mul(scale), vec2(bx, by).mul(scale))
      ink = max(ink, float(1).sub(smoothstep(0.6, 1.6, d)))
    }
    return ink
  }
  return mix(inkOf(BINARY_GLYPHS.zero), inkOf(BINARY_GLYPHS.one), one)
}

/**
 * The falling code at this fragment's screen cell: whether the cell still stands at `amount`, and its glyph's ink
 * (brighter at a column's falling head, fading up its trail).
 * Cells are keyed on the column and on the row less the column's fall, so the pattern of cells that have gone slides
 * down the screen as time passes; the key is mixed with the row's height so, at any amount, the cells nearest the
 * top of the screen go first: the mesh is eaten top-down, in falling columns, and rebuilt bottom-up as the amount
 * falls back.
 */
function fallingCells(amount: F1): { alive: Node<'bool'>; ink: F1 } {
  const px = screenCoordinate.xy
  const size = screenSize
  const cellH = max(float(10), floor(size.y.div(CODE_DISSOLVE.rows)))
  const cellPx = vec2(floor(cellH.mul(0.64)), cellH)
  const c = floor(px.div(cellPx))
  const local = fract(px.div(cellPx))
  const column = hash(c.x.mul(7.13).add(0.5))
  const rows = size.y.div(cellH)
  const fallen = time.mul(column.mul(CODE_DISSOLVE.speedSpread).add(CODE_DISSOLVE.speed))
  // Survival: half the row's height down the screen (0 at the top), half a hash sliding down with the column.
  const key = hash(c.x.mul(7.13).add(floor(c.y.sub(fallen)).mul(0.61)).add(column.mul(3.1)))
  const survival = mix(key, clamp(c.y.div(rows), 0, 1), 0.5)
  const alive = survival.greaterThanEqual(amount)
  // The head of each column and its trail, as the ghost view's columns fall.
  const span = rows.add(CODE_DISSOLVE.trail * 2)
  const head = fract(fallen.div(span).add(column.mul(9.7))).mul(span).sub(CODE_DISSOLVE.trail)
  const behind = head.sub(c.y)
  const trail = select(behind.greaterThanEqual(0), exp(behind.negate().div(CODE_DISSOLVE.trail)), float(0))
  // Which digit the cell shows, rolling over at the column's pace.
  const roll = floor(time.mul(column.mul(4).add(1)).add(hash(c.x.add(c.y.mul(131)))))
  const one = step(0.5, hash(c.x.mul(17.1).add(c.y.mul(311.7)).add(roll.mul(0.37))))
  const ink = digitInk(local, cellPx, one).mul(float(0.25).add(trail.mul(0.75)))
  return { alive, ink }
}

/**
 * Makes `material` dissolve by `amount` (a float node: 0 solid, 1 gone; per instance, from an instanced attribute or
 * a storage element) into falling green binary code of `colour` (linear RGB).
 * - positionNode: at an amount of `fold` or more every vertex sits on `origin` (zero-area triangles, nothing
 *   rasterised: the crowd's own-body pattern); an existing positionNode is kept under it, and a pass that writes
 *   motion vectors folds positionPrevious the same way, so the velocity buffer sees no motion from the fold.
 * - maskNode: the existing mask AND the cell's survival (an idle amount keeps every cell), so the shadow pass, which
 *   honours the mask, drops the same cells.
 * - colorNode: the base shading (its RGB) dimmed by (1 − amount); emissiveNode: the existing emissive plus the glyph ink in
 *   `colour`, scaled by the amount and the glow. Roughness and metalness are untouched.
 * Returns the same material.
 */
export function applyCodeDissolve(material: MeshStandardNodeMaterial, amount: F1, origin: V3, colour: readonly [number, number, number]): MeshStandardNodeMaterial {
  const gone = amount.greaterThanEqual(CODE_DISSOLVE.fold)
  const current: Node = material.positionNode ?? positionLocal
  const folded = select(gone, origin, current)
  material.positionNode = Fn((builder: NodeBuilder) => {
    // Only a pass with a velocity target asks for the previous frame (the shadow map and ?cinema=0 never do).
    if (needsPrevious(builder)) positionPrevious.assign(select(gone, origin, positionPrevious))
    return folded
  })()

  const { alive, ink } = fallingCells(amount)
  const idle = amount.lessThan(CODE_DISSOLVE.idle)
  const survives = idle.or(alive)
  const existingMask = material.maskNode as Node<'bool'> | null
  material.maskNode = existingMask ? bool(existingMask).and(survives) : survives

  const base = vec3((material.colorNode ?? materialColor) as Node<'vec3'>)
  material.colorNode = base.mul(float(1).sub(amount))
  const glow = vec3(...colour).mul(ink).mul(amount).mul(CODE_DISSOLVE.glow)
  const existingEmissive = material.emissiveNode as Node<'vec3'> | null
  material.emissiveNode = existingEmissive ? vec3(existingEmissive).add(glow) : glow
  return material
}
