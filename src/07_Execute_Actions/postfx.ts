/**
 * Why does this file exist? It is the photographic finish: a restrained bloom that only catches real
 * highlights (sun glints, lamps, signals, head and tail lights), the Ultra tier's golden-hour sun shafts
 * (volumetrics.ts: half-res crepuscular rays from the scene depth, gated by a uniform so the other tiers
 * pay nothing and no tier change recompiles), a gentle vignette, the tone curve applied explicitly, then FXAA on
 * the display-referred image. One RenderPipeline: the rays render into their own half-res target inside it, like
 * the bloom mips. In cinema mode (the default) it is a film camera: the scene pass also writes a velocity buffer,
 * the 180° shutter (shutter.ts) smears 1/48 s of motion into the colour before anything else reads it, and after
 * the lens effects a neutral-density stage and the film response (cinema.ts FILM) replace ACES. With ?cinema=0 the
 * chain is the video one: no velocity buffer, no shutter, ACES.
 * What breaks if it is removed? The scene renders without anti-aliasing, highlights, sun shafts, motion blur or a
 * tone curve.
 */
import {
  Matrix4, NoToneMapping, RenderPipeline, SRGBColorSpace, type Mesh, type Node, type NodeBuilder, type PerspectiveCamera,
  type Scene, type UniformNode, type WebGPURenderer,
} from 'three/webgpu'
import {
  Fn, exp2, float, length, max, min, mrt, output, pass, renderOutput, screenUV, smoothstep, uniform, vec3, vec4, velocity,
} from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { fxaa } from 'three/addons/tsl/display/FXAANode.js'
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
export type GhostLayer = Pick<GhostView, 'scene' | 'strength' | 'seconds' | 'contact' | 'contactKind'>

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

export function buildPost(
  renderer: WebGPURenderer, scene: Scene, camera: PerspectiveCamera, cinema: CinemaScene | null = null,
  ghost: GhostLayer | null = null,
): { pipeline: RenderPipeline; volumetrics: Volumetrics; cinema: CinemaPost | null } {
  const scenePass = pass(scene, camera)
  const pipeline = new RenderPipeline(renderer)
  pipeline.outputColorTransform = false
  const vignette = float(1).sub(smoothstep(0.55, 1.2, length(screenUV.sub(0.5)).mul(1.4)).mul(0.3))
  // Last of all, over the finished (shuttered, graded, anti-aliased) frame: ghost view, when the page has one. Its
  // shapes render in a pass of their own, never in the scene pass, so they reach no velocity buffer.
  const finish = (fxaaImage: Node): Node => {
    const image = fxaaImage as unknown as Node<'vec4'>
    return ghost ? ghostComposite(image, pass(ghost.scene, camera).getTextureNode('output'), ghost) : image
  }
  if (!cinema) {
    const color = scenePass.getTextureNode('output')
    const volumetrics = createVolumetrics()
    const rays = sunShafts(scenePass.getTextureNode('depth'), volumetrics, renderer.reversedDepthBuffer)
    // Threshold well above sunlit surfaces (~2 in linear HDR): only lamps, signals and glints bloom.
    const glow = bloom(color, 0.3, 0.3, 4.0)
    // Rays are in-scattered light: added in linear HDR, before tone mapping. The scene colour comes first so
    // the scene pass is sequenced before the bloom and ray targets that read it.
    const lit = color.rgb.add(glow.rgb).add(rays.rgb).mul(vignette)
    // Tone map first, then anti-alias the display-referred image (FXAA expects it).
    pipeline.outputNode = finish(fxaa(renderOutput(vec4(lit, 1))))
    return { pipeline, volumetrics, cinema: null }
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
  const lit = exposed.rgb.add(glow.rgb).add(rays.rgb).mul(vignette)
  // The ND filter (neutral: the same transmission for every channel), the exposure behind it, then the film.
  const nd = uniform(0)
  const exposure = uniform(1)
  const filtered = lit.mul(exp2(nd.negate())).mul(exposure)
  pipeline.outputNode = finish(fxaa(renderOutput(vec4(filmResponse(filtered), 1), NoToneMapping, SRGBColorSpace)))
  return { pipeline, volumetrics, cinema: { shutter, nd, exposure, previousViewProjection } }
}
