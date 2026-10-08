// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the 180° shutter: motion blur reconstructed from the scene pass's velocity
 * buffer, so each presented frame carries the smear of 1/48 s of motion (a car's along its own path, a pedestrian's
 * along their walk, the whole frame's under a turning head) the way film exposed through a half-open rotary shutter
 * does. The filter is the tile-based reconstruction of McGuire, Hennessy, Bukowski and Osman ("A Reconstruction
 * Filter for Plausible Motion Blur", I3D 2012), with the direction-aware gather of its 2014 successor: the largest
 * motion in each K×K tile, then in each 3×3 neighbourhood of tiles, tells every pixel how far to look, and depth,
 * velocity and direction weights let a moving car's smear spill over the still street behind it while the street
 * never smears across the car. Three passes into targets sized like the scene pass, HDR in and out. Also here: the
 * velocity-buffer layout both sides agree on, and the motion of static surfaces whose instances are re-ordered at
 * runtime.
 * What breaks if it is removed? postfx.ts has no shutter: moving things stay sharp at 24 fps and strobe.
 */
import {
  HalfFloatType, Matrix4, NearestFilter, NodeMaterial, NodeUpdateType, QuadMesh, RenderTarget, RendererUtils, TempNode,
  Vector2, type Node, type NodeBuilder, type NodeFrame, type PassNode, type TextureNode, type UniformNode,
} from 'three/webgpu'
import {
  Fn, If, Loop, cameraProjectionMatrix, cameraViewMatrix, clamp, context, dot, float, floor, int, interleavedGradientNoise,
  ivec2, length, max, min, mix, passTexture, positionView, positionWorld, screenCoordinate, smoothstep, step, texture, uniform,
  vec2, vec4,
} from 'three/tsl'

/** The reconstruction's constants. */
export const SHUTTER = Object.freeze({
  /** Taps per moving pixel, half along the neighbourhood's motion and half along its own (odd: the centre tap is the
   *  pixel itself). A still tile skips them all. */
  taps: 21,
  /** Tile edge and longest half-smear, px, per 720 px of target height (at least 8, at most 40). */
  tilePer720: 20,
  /** Depth difference over which "in front" fades to "behind": this much plus 1 % of the distance, m. */
  softDepth: 0.1,
  softDepthRel: 0.01,
  /** Half-smears shorter than this are still, px (McGuire's 0.5 px floor). */
  still: 0.5,
})

/** Tile edge (the longest half-smear) for a target this tall, px. */
export function tileSize(height: number): number {
  return Math.min(40, Math.max(8, Math.round((height * SHUTTER.tilePer720) / 720)))
}

type V2 = Node<'vec2'>
type V4 = Node<'vec4'>
type F1 = Node<'float'>
type I2 = Node<'ivec2'>

/** Integer pixel coordinates held inside 0..hi (WGSL's min and max take integer vectors; three's typings do not). */
export const clampPx = (p: Node, hi: Node): I2 => {
  const lo = min as unknown as (a: Node, b: Node) => I2
  const up = max as unknown as (a: Node, b: Node) => I2
  return up(lo(p, hi), ivec2(0))
}

/**
 * The velocity buffer's texel, written by every material in the scene pass: xy = NDC motion from the previous
 * presented frame to this one (three's velocity convention, y up), z = distance from the camera along the view
 * axis, m (the reconstruction's depth test), w = 1.
 */
export function motionTexel(ndcMotion: V2): V4 {
  return vec4(ndcMotion, positionView.z.negate(), 1)
}

/**
 * NDC motion of a surface that does not move, from the camera's motion alone: its world position under this frame's
 * view-projection against the previous presented frame's. For instanced meshes whose instances are re-ordered at
 * runtime (world.ts sorts the buildings front to back): three's per-instance history would pair a slot's matrix with
 * another building's from the frame before.
 */
export function cameraMotion(previousViewProjection: UniformNode<'mat4', Matrix4>): V2 {
  const p = vec4(positionWorld, 1)
  const now = cameraProjectionMatrix.mul(cameraViewMatrix).mul(p)
  const then = previousViewProjection.mul(p)
  return now.xy.div(now.w).sub(then.xy.div(then.w))
}

const quad = new QuadMesh(new NodeMaterial())
let rendererState = {} as ReturnType<typeof RendererUtils.resetRendererState>
const size = new Vector2()

/**
 * The shutter as a node: `getTextureNode()` is the blurred HDR colour, rendered once per frame before anything reads
 * it. `exposure` is the shutter's share of the motion in the velocity buffer (cinema.ts shutterScale); at 0 (a
 * still frame, a cut) every tile is still and the gather copies the colour through.
 */
export class ShutterNode extends TempNode<'vec4'> {
  readonly exposure: UniformNode<'float', number> = uniform(0)
  private readonly color: TextureNode
  private readonly motion: TextureNode
  /** Target size, px; tile edge, px; tiles across and down. */
  private readonly targetSize: UniformNode<'vec2', Vector2> = uniform(new Vector2(1, 1))
  private readonly tile: UniformNode<'float', number> = uniform(20)
  private readonly tiles: UniformNode<'vec2', Vector2> = uniform(new Vector2(1, 1))
  private readonly tileTarget = target('Shutter.tileMax', true)
  private readonly neighbourTarget = target('Shutter.neighbourMax', true)
  private readonly output = target('Shutter.output', false)
  private readonly outputNode: TextureNode
  private tileMaterial: NodeMaterial | null = null
  private neighbourMaterial: NodeMaterial | null = null
  private gatherMaterial: NodeMaterial | null = null

  constructor(color: TextureNode, motion: TextureNode) {
    super('vec4')
    this.color = color
    this.motion = motion
    // A PassTextureNode builds its producer into whatever reads it, so the passes run before any reader.
    this.outputNode = passTexture(this as unknown as PassNode, this.output.texture)
    this.updateBeforeType = NodeUpdateType.FRAME
  }

  getTextureNode(): TextureNode {
    return this.outputNode
  }

  setSize(width: number, height: number): void {
    const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height))
    const k = tileSize(h)
    const tw = Math.ceil(w / k), th = Math.ceil(h / k)
    this.targetSize.value.set(w, h)
    this.tile.value = k
    this.tiles.value.set(tw, th)
    this.output.setSize(w, h)
    this.tileTarget.setSize(tw, th)
    this.neighbourTarget.setSize(tw, th)
  }

  updateBefore(frame: NodeFrame): undefined {
    const renderer = frame.renderer!
    // The scene pass sizes itself from the drawing buffer the same way, in the same frame.
    renderer.getDrawingBufferSize(size)
    this.setSize(size.width, size.height)
    rendererState = RendererUtils.resetRendererState(renderer, rendererState)
    for (const [material, rt, name] of [
      [this.tileMaterial, this.tileTarget, 'Shutter [ tile max ]'],
      [this.neighbourMaterial, this.neighbourTarget, 'Shutter [ neighbour max ]'],
      [this.gatherMaterial, this.output, 'Shutter [ gather ]'],
    ] as const) {
      quad.material = material!
      quad.name = name
      renderer.setRenderTarget(rt)
      quad.render(renderer)
    }
    RendererUtils.restoreRendererState(renderer, rendererState)
  }

  setup(builder: NodeBuilder): TextureNode {
    const k = this.tile
    const last = ivec2(this.targetSize.sub(1))
    const lastTile = ivec2(this.tiles.sub(1))
    const exposure = this.exposure
    const targetSize = this.targetSize
    const colorAt = (p: Node) => this.color.load(p)
    const motionAt = (p: Node) => this.motion.load(p)

    /** The half-smear in px (NDC motion × exposure, halved, y down), no longer than a tile. */
    const smear = (m: V4): V2 => {
      const v = m.xy.mul(vec2(0.25, -0.25)).mul(targetSize).mul(exposure).toVar()
      const len = length(v)
      return v.mul(min(float(1), k.div(max(len, 1e-6)))) as V2
    }

    // 1. The largest half-smear in each K×K tile.
    const tileMax = Fn(() => {
      const origin = ivec2(screenCoordinate.xy).mul(int(k))
      const best = vec2(0).toVar()
      const bestLen = float(0).toVar()
      Loop({ start: int(0), end: int(k), type: 'int' }, { start: int(0), end: int(k), type: 'int' }, ({ i, j }) => {
        const v = smear(motionAt(clampPx(origin.add(ivec2(i, j)), last)))
        const l = dot(v, v)
        If(l.greaterThan(bestLen), () => {
          best.assign(v)
          bestLen.assign(l)
        })
      })
      return vec4(best, 0, 1)
    })

    // 2. The largest of each tile's 3×3 neighbourhood: any motion that can reach a pixel of this tile.
    const tileAt = (p: Node) => texture(this.tileTarget.texture).load(p)
    const neighbourMax = Fn(() => {
      const t = ivec2(screenCoordinate.xy)
      const best = vec2(0).toVar()
      const bestLen = float(0).toVar()
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const v = tileAt(clampPx(t.add(ivec2(dx, dy)), lastTile)).xy
          const l = dot(v, v)
          If(l.greaterThan(bestLen), () => {
            best.assign(v)
            bestLen.assign(l)
          })
        }
      }
      return vec4(best, 0, 1)
    })

    // 3. The gather: SHUTTER.taps across the longest motion in reach, alternately along the neighbourhood's motion
    // (so a still pixel beside a moving car finds the car's smear) and along this pixel's own (so a spinning wheel
    // smears around, not along whatever its tile's neighbours do). Each tap counts where its motion covers this pixel
    // along the tap's direction: one in front spreads by its own motion, one behind shows through by this pixel's,
    // and both smearing together are one moving surface (Guertin, McGuire and Nowrouzezahrai's direction weights,
    // "A Fast and Stable Feature-Aware Motion Blur Filter", 2014, which keep tile edges out of the result).
    const neighbourAt = (p: Node) => texture(this.neighbourTarget.texture).load(p)
    const cone = (d: F1, len: F1): F1 => clamp(float(1).sub(d.div(len)), 0, 1)
    const cylinder = (d: F1, len: F1): F1 => float(1).sub(smoothstep(len.mul(0.95), len.mul(1.05), d))
    /** A unit direction for a half-smear, or `fallback` where it is too short to have one. */
    const heading = (v: V2, fallback: V2): V2 => {
      const len = length(v)
      return mix(fallback, v.div(max(len, 1e-6)), step(float(SHUTTER.still), len)) as V2
    }
    const taps = SHUTTER.taps
    const centre = (taps - 1) / 2
    const gather = Fn(() => {
      const x = ivec2(screenCoordinate.xy)
      const cx = colorAt(x)
      const out = vec4(cx).toVar()
      const vn = neighbourAt(x.div(int(k))).xy
      const reach = length(vn)
      If(reach.greaterThan(SHUTTER.still), () => {
        const mx = motionAt(x)
        const vx = smear(mx)
        const lenX = max(length(vx), SHUTTER.still)
        const zx = mx.z
        const wn = vn.div(reach)
        const wc = heading(vx, wn)
        const total = float(1).div(lenX).toVar()
        const sum = cx.rgb.mul(total).toVar()
        const jitter = interleavedGradientNoise(screenCoordinate).sub(0.5)
        const centreX = vec2(x).add(0.5)
        Loop(taps - 1, ({ i }) => {
          // Tap index skipping the centre, jittered per pixel so the taps' banding becomes fine noise; odd taps follow
          // this pixel's own motion, even ones the neighbourhood's.
          const fi = float(i)
          const n = fi.add(step(float(centre), fi))
          const t = mix(float(-1), float(1), n.add(jitter).add(1).div(taps + 1))
          const dir = mix(wn, wc, fi.mod(2))
          const d = t.abs().mul(reach)
          const y = clampPx(ivec2(floor(centreX.add(dir.mul(t.mul(reach))))), last)
          const my = motionAt(y)
          const vy = smear(my)
          const lenY = max(length(vy), SHUTTER.still)
          const zy = my.z
          const alongX = dot(wc, dir).abs()
          const alongY = dot(heading(vy, dir), dir).abs()
          const soft = max(float(SHUTTER.softDepth), min(zx, zy).mul(SHUTTER.softDepthRel))
          const inFront = clamp(float(1).add(zx.sub(zy).div(soft)), 0, 1)
          const behind = clamp(float(1).add(zy.sub(zx).div(soft)), 0, 1)
          const w = inFront.mul(cone(d, lenY)).mul(alongY)
            .add(behind.mul(cone(d, lenX)).mul(alongX))
            .add(cylinder(d, min(lenY, lenX)).mul(max(alongX, alongY)).mul(2))
          total.addAssign(w)
          sum.addAssign(colorAt(y).rgb.mul(w))
        })
        out.assign(vec4(sum.div(total), cx.a))
      })
      return out
    })

    // The passes that read the scene pass's textures share the reader's context, as three's own post nodes do.
    const shared = (builder as NodeBuilder & { getSharedContext(): object }).getSharedContext()
    this.tileMaterial = material(this.tileMaterial, tileMax(), 'Shutter.tileMax', shared)
    this.neighbourMaterial = material(this.neighbourMaterial, neighbourMax(), 'Shutter.neighbourMax', null)
    this.gatherMaterial = material(this.gatherMaterial, gather(), 'Shutter.gather', shared)
    return this.outputNode
  }

  dispose(): void {
    this.tileTarget.dispose()
    this.neighbourTarget.dispose()
    this.output.dispose()
    this.tileMaterial?.dispose()
    this.neighbourMaterial?.dispose()
    this.gatherMaterial?.dispose()
    super.dispose()
  }
}

/** A half-float colour target; tiles are read texel by texel (nearest), the output is filtered for its readers. */
function target(name: string, nearest: boolean): RenderTarget {
  const rt = new RenderTarget(1, 1, {
    depthBuffer: false, type: HalfFloatType,
    ...(nearest ? { minFilter: NearestFilter, magFilter: NearestFilter } : {}),
  })
  rt.texture.name = name
  return rt
}

function material(m: NodeMaterial | null, fragment: Node, name: string, shared: object | null): NodeMaterial {
  const out = m ?? new NodeMaterial()
  if (shared) out.contextNode = context(shared)
  out.fragmentNode = fragment
  out.name = name
  out.needsUpdate = true
  return out
}
