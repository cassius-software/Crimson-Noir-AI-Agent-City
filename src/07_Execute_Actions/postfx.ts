// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the photographic finish: a restrained bloom that only catches real
 * highlights (sun glints, lamps, signals, head and tail lights), the Ultra tier's golden-hour sun shafts
 * (volumetrics.ts: half-res crepuscular rays from the scene depth, gated by a uniform so the other tiers
 * pay nothing and no tier change recompiles), a gentle vignette, the tone curve applied explicitly, then FXAA on
 * the display-referred image. One RenderPipeline: the rays render into their own half-res target inside it, like
 * the bloom mips. In cinema mode (the default) it is a film camera: the scene pass also writes a velocity buffer,
 * the 180° shutter (shutter.ts) smears 1/48 s of motion into the colour before anything else reads it, and after
 * the lens effects a neutral-density stage and the film response (cinema.ts FILM) replace ACES. With ?cinema=0 the
 * chain is the video one: no velocity buffer, no shutter, ACES. Where the boot chose it (governor.ts msaaCandidate), the
 * scene pass draws 4 samples a pixel and three resolves them as the pass ends: every reader downstream (the shutter,
 * bloom, the film) sees the resolved frame, and the sun shafts read the first sample of the multisampled depth. Where
 * the boot built it (governor.ts aoCandidate), the chain holds three's screen-space ambient occlusion (GatedSSAO): half-
 * res, from the scene pass's own depth (normals rebuilt from it, so no attachment is added and no scene pipeline
 * changes), multiplied into the HDR colour after the shutter and before bloom. Its passes run only on a tier with taps
 * (Ultra, Peak) and are skipped on the others; the composite reads it behind a uniform, so no tier change recompiles.
 * What breaks if it is removed? The scene renders without anti-aliasing, ambient occlusion, highlights, sun shafts,
 * motion blur or a tone curve.
 */
import {
  Matrix3, Matrix4, NoToneMapping, RenderPipeline, SRGBColorSpace, type Mesh, type Node, type NodeBuilder, type NodeFrame,
  type PassNode, type PerspectiveCamera, type Scene, type UniformNode, type WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, If, exp2, float, getNormalFromDepth, length, luminance, max, min, mix, mrt, output, pass, renderOutput, sample,
  screenSize, screenUV, smoothstep, uniform, vec3, vec4, velocity,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
import SSAONode from 'three/addons/tsl/display/SSAONode.js'
import { createVolumetrics, sunShafts, type Volumetrics } from './volumetrics.ts'
import { ShutterNode, cameraMotion, motionTexel } from './shutter.ts'
import { FILM, HDR_MAX } from './cinema.ts'
import { ghostComposite, type GhostView } from './ghost.ts'

/** What the engine drives in cinema mode, once per presented frame. */
export interface CinemaPost {
  /** The 180° shutter; its `exposure` uniform is the blur's scale (cinema.ts shutterScale, 0 on a cut). */
  shutter: ShutterNode
  /** The variable ND filter's strength, stops (world.ts ndStopsFor). */
  nd: UniformNode<'float', number>
  /** The exposure behind the ND: the operator's light.exposure (1 = as authored). */
  exposure: UniformNode<'float', number>
  /** The camera's projection × view at the previous presented frame (the re-ordered instances' motion). */
  previousViewProjection: UniformNode<'mat4', Matrix4>
}

/** Ghost view's layer: the collider proxies' scene and the composite's two uniforms (ghost.ts). */
export type GhostLayer = Pick<GhostView, 'scene' | 'strength' | 'seconds'>

/** Where the velocity buffer needs help: instanced meshes whose instances world.ts re-orders at runtime. */
export interface CinemaScene { resorted: readonly Mesh[] }

/**
 * The film response per channel on scene-linear light (cinema.ts FILM; filmCurve is the CPU twin): y = xⁿ/(xⁿ + σⁿ),
 * the input held inside the half-float range (so an infinite highlight is white, not NaN) and above 1e-8 (so pow
 * never sees 0; that is far below the 8-bit black step).
 */
export function filmResponse(c: Node<'vec3'>): Node<'vec3'> {
  const p = min(max(c, vec3(1e-8)), vec3(HDR_MAX)).div(FILM.sigma).pow(vec3(FILM.contrast))
  return p.div(p.add(1))
}

/**
 * The motion a material writes into the velocity buffer: the camera's alone for the re-ordered instances (their slots
 * change hands at every sort, so their matrix history means nothing), three's per-object velocity for everything else.
 */
export function pickMotion(material: unknown, resorted: ReadonlySet<unknown>, cameraOnly: Node<'vec2'>): Node<'vec2'> {
  return resorted.has(material) ? cameraOnly : (velocity as unknown as Node<'vec2'>)
}

/** The colour-vision filter's matrix (access.ts visionMatrix), the identity until the host sets one. */
export type VisionUniform = UniformNode<'mat3', Matrix3>

/**
 * The ambient occlusion's fixed tuning. Starting values, judged on the software adapter's pictures only:
 * - resolutionScale: of the drawing buffer, set once at build (no tier resizes the targets).
 * - radius m, intensity, bias: three's SSAONode uniforms (the occluders within a metre and a half: kerbs, doorways, a
 *   bench's feet, the foot of every wall). Intensity 2: at three's 1 the software adapter's pictures barely changed.
 * - bright: HDR luminance over which a pixel keeps its light (lamps, windows and signals are sources, not creases; bloom's
 *   threshold is 4).
 * - haze m: the occlusion fades out over this distance, so it never darkens the far haze.
 * - smear px: under the cinema camera the occlusion comes from the unsmeared depth; it fades out where the shutter smears
 *   the frame further than this.
 */
export const AO = Object.freeze({
  resolutionScale: 0.5, radius: 1.5, intensity: 2, bias: 0.03,
  bright: Object.freeze([1.5, 4] as const), haze: Object.freeze([60, 300] as const), smear: Object.freeze([2, 8] as const),
})

/**
 * three's SSAONode (examples/jsm/tsl/display/SSAONode.js) with its three passes (the occlusion, then a depth-aware blur
 * across and down) skipped while `on` is false: a node's updateBefore is called every frame once it is built, so a
 * strength uniform alone would still render them. The first call always runs: that is the boot's validated draw
 * (engine.ts), so both of its pipelines are compiled and judged before play, and none is compiled mid-game. While
 * skipped its target keeps the last picture, which nothing reads (the composite reads it only at a strength above 0).
 */
export class GatedSSAO extends SSAONode {
  /** Whether the passes run this frame: the engine writes it from the tier (and rain mode) before the chain renders. */
  on = false
  private primed = false
  override updateBefore(frame: NodeFrame): boolean | undefined {
    if (!this.on && this.primed) return undefined
    this.primed = true
    return super.updateBefore(frame)
  }
}

/** What the engine drives of the ambient occlusion, once per frame. */
export interface AmbientOcclusion {
  /** The passes, their switch (`on`) and their tap count (`samples`, a uniform loop bound: 1 or more). */
  node: GatedSSAO
  /** How much of the occlusion the composite applies (0 = none, and the composite reads no texture). */
  strength: UniformNode<'float', number>
}

/**
 * The post chain as the boot decided it: the scene pass's samples per pixel (governor.ts MSAA) and whether it holds the
 * ambient occlusion (governor.ts aoCandidate; absent: no).
 */
export interface PostAa { sceneSamples: 0 | 4; ao?: boolean }

/** What buildPost hands the engine. `release` lets go of every target the chain owns (a refused chain at boot). */
export interface PostChain {
  pipeline: RenderPipeline
  volumetrics: Volumetrics
  cinema: CinemaPost | null
  vision: VisionUniform
  /** The ambient occlusion, where the boot built it. */
  ao: AmbientOcclusion | null
  release: () => void
}

/**
 * The occlusion for a scene pass: three's SSAONode on the pass's own depth, with each pixel's normal rebuilt from that
 * depth (three's getNormalFromDepth: the nearer of two neighbours per axis, so a silhouette takes its own surface's), so
 * the pass gets no attachment and its pipelines stay as they are. Every read of the depth is a load without a sampler:
 * at 4 samples a pixel three declares it a multisampled depth texture and loads its first sample (as the sun shafts do);
 * at one, its nearest filtering makes it unfilterable, and three loads it the same way. Built with one tap and nothing
 * applied: the engine writes the tier's taps, strength and switch.
 */
function buildAo(scenePass: PassNode, camera: PerspectiveCamera): AmbientOcclusion {
  const depth = scenePass.getTextureNode('depth')
  // By reference: three keeps the camera's inverse projection current (and reversed for the reversed depth) in place.
  const projectionInverse = uniform(camera.projectionMatrixInverse)
  const raw = depth.value as unknown as Node
  const normal = sample((at) => getNormalFromDepth(at, raw, projectionInverse))
  const node = new GatedSSAO(depth, normal, camera)
  node.resolutionScale = AO.resolutionScale
  // The occlusion divides by it: never 0.
  node.samples.value = 1
  node.radius.value = AO.radius
  node.intensity.value = AO.intensity
  node.bias.value = AO.bias
  return { node, strength: uniform(0) }
}

/**
 * The factor the HDR colour is multiplied by: exactly 1, with no texture read, unless the strength is above 0 (a
 * uniform, so the branch is uniform on the GPU). Inside it the occlusion fades out on bright pixels, with distance into
 * the haze and, under the cinema camera, where the shutter smears the frame.
 */
function occlusion(ao: AmbientOcclusion, hdr: Node<'vec3'>, distance: () => Node<'float'>, smearPx: (() => Node<'float'>) | null): Node<'float'> {
  return Fn(() => {
    const k = float(1).toVar()
    If(ao.strength.greaterThan(0), () => {
      const occluded = ao.node.getTextureNode().sample(screenUV).level(float(0)).r
      const lit = smoothstep(AO.bright[0], AO.bright[1], luminance(hdr)).oneMinus()
      const near = smoothstep(AO.haze[0], AO.haze[1], distance()).oneMinus()
      const still = smearPx ? smoothstep(AO.smear[0], AO.smear[1], smearPx()).oneMinus() : float(1)
      k.assign(mix(float(1), occluded, ao.strength.mul(lit).mul(near).mul(still).clamp(0, 1)))
    })
    return k
  })() as unknown as Node<'float'>
}

export function buildPost(
  renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera, cinema: CinemaScene | null = null,
  ghost: GhostLayer | null = null, aa: PostAa = { sceneSamples: 0 },
): PostChain {
  // WebGPU multisamples at 1 or 4 alone; any other count would reach three's render context unrounded.
  if (aa.sceneSamples !== 0 && aa.sceneSamples !== 4) throw new RangeError(`the scene pass takes 0 or 4 samples, not ${String(aa.sceneSamples)}`)
  // The samples are the pass's own, never the renderer's (split screen's direct path may have 4). At 4 the multisampled
  // colour is resolved as the pass ends and never stored (the pass clears it every frame); its depth is stored, since
  // the sun shafts read it.
  const multisampled = aa.sceneSamples > 0
  const scenePass = pass(scene, camera, { samples: aa.sceneSamples, storeMultisampledColorBuffer: !multisampled })
  // Ghost view's shapes render in a pass of their own, never in the scene pass, so they reach no velocity buffer, and
  // at one sample: they are laid on after FXAA.
  const ghostPass = ghost ? pass(ghost.scene, camera, { samples: 0 }) : null
  const ao = aa.ao ? buildAo(scenePass, camera) : null
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const vignette = float(1).sub(smoothstep(0.55, 1.2, length(screenUV.sub(0.5)).mul(1.4)).mul(0.3))
  // The colour-vision filter (access.ts): one 3×3 over the finished, display-referred frame, the identity unless the
  // host sets a protan, deutan or tritan daltonisation. After the ghost, so its colours are moved with the frame's.
  const vision: VisionUniform = uniform(new Matrix3())
  // Last of all, over the finished (shuttered, graded, anti-aliased) frame: ghost view, when the page has one.
  const finish = (fxaaImage: Node): Node => {
    const image = fxaaImage as unknown as Node<'vec4'>
    const over = ghost && ghostPass ? ghostComposite(image, ghostPass.getTextureNode('output'), ghost) : image
    return vec4(vision.mul(over.rgb).clamp(), over.a)
  }
  // Every node that owns a render target, for release(): RenderPipeline.dispose frees its own quad's material alone.
  const owners: { dispose(): void }[] = [scenePass, ...(ghostPass ? [ghostPass] : []), ...(ao ? [ao.node] : [])]
  const release = (): void => {
    for (const node of owners) node.dispose()
    pipeline.dispose()
  }
  if (!cinema) {
    const color = scenePass.getTextureNode('output')
    const volumetrics = createVolumetrics()
    const rays = sunShafts(scenePass.getTextureNode('depth'), volumetrics, renderer.reversedDepthBuffer)
    // Threshold well above sunlit surfaces (~2 in linear HDR): only lamps, signals and glints bloom.
    const glow = bloom(color, 0.3, 0.3, 4.0)
    // The occlusion darkens the scene's own light (its distance from the depth, which every reader loads at sample 0);
    // bloom is taken from the light before it, and the rays, in-scattered light, are never occluded.
    const shaded = ao ? color.rgb.mul(occlusion(ao, color.rgb, () => scenePass.getViewZNode().negate(), null)) : color.rgb
    // Rays are in-scattered light: added in linear HDR, before tone mapping. The scene colour comes first so
    // the scene pass is sequenced before the bloom and ray targets that read it.
    const lit = shaded.add(glow.rgb).add(rays.rgb).mul(vignette)
    // Tone map first, then anti-alias the display-referred image (FXAA expects it).
    const smooth = fxaa(renderOutput(vec4(lit, 1)))
    owners.push(rays, glow, smooth.textureNode)
    pipeline.outputNode = finish(smooth)
    return { pipeline, volumetrics, cinema: null, vision, ao, release }
  }

  const volumetrics = createVolumetrics()
  const rays = sunShafts(scenePass.getTextureNode('depth'), volumetrics, renderer.reversedDepthBuffer)
  // Every surface writes its motion since the previous presented frame beside its colour (shutter.ts motionTexel).
  // Cars get theirs from three's per-instance matrix history, pedestrians from their own velocity (crowd.ts), the
  // re-ordered buildings from the camera alone. Each material picks as it compiles for this pass, never through a
  // material-level MRT: that would follow the material into the renderer's direct draw (the post chain off at the
  // Minimal tier), whose target has no velocity buffer, and a velocity-only output there is an empty shader struct.
  const previousViewProjection = uniform(new Matrix4())
  const resorted = new Set<unknown>(cinema.resorted.map((mesh) => mesh.material))
  const cameraOnly = cameraMotion(previousViewProjection)
  const motion = Fn(({ material }: NodeBuilder) => pickMotion(material, resorted, cameraOnly))
  scenePass.setMRT(mrt({ output, velocity: motionTexel(motion() as unknown as Node<'vec2'>) }))
  const shutter = new ShutterNode(scenePass.getTextureNode('output'), scenePass.getTextureNode('velocity'))
  // Everything downstream sees the exposed frame: a moving lamp's bloom is smeared like the lamp.
  const exposed = shutter.getTextureNode()
  const glow = bloom(exposed, 0.3, 0.3, 4.0)
  // The occlusion after the shutter, and bloom taken from the light before it. It is drawn from the unsmeared depth, so it
  // fades out where the smear is long: the velocity texel's NDC motion across the target, in px, times the shutter's
  // share. Its distance is the texel's too (shutter.ts motionTexel: z = metres along the view axis).
  const texel = scenePass.getTextureNode('velocity')
  const shaded = ao
    ? exposed.rgb.mul(occlusion(ao, exposed.rgb, () => texel.z, () => length(texel.xy.mul(screenSize).mul(0.5)).mul(shutter.exposure)))
    : exposed.rgb
  const lit = shaded.add(glow.rgb).add(rays.rgb).mul(vignette)
  // The ND filter (neutral: the same transmission for every channel), the exposure behind it, then the film.
  const nd = uniform(0)
  const exposure = uniform(1)
  const filtered = lit.mul(exp2(nd.negate())).mul(exposure)
  const smooth = fxaa(renderOutput(vec4(filmResponse(filtered), 1), NoToneMapping, SRGBColorSpace))
  owners.push(rays, shutter, glow, smooth.textureNode)
  pipeline.outputNode = finish(smooth)
  return { pipeline, volumetrics, cinema: { shutter, nd, exposure, previousViewProjection }, vision, ao, release }
}
