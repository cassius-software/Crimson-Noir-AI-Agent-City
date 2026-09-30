/**
 * Why does this file exist? Every surface in the city is procedural, sampled in world space from the
 * FBM texture baked at startup: reflective curtain-wall glass, limestone, brick and metal-panel
 * facades with lit retail frontages; the heritage quarter's limestone and brick rows, cornices, slate and copper
 * roofs; the lakefront's pale condominium panels and balcony glass; the pier's timber deck; asphalt with Canadian
 * road markings; concrete sidewalks, brick pavers in the heritage quarter, park grass and the promenade's paving;
 * lamp pools at night. No image file is ever loaded. All noise is read through FbmSet.sample(), so the
 * autoscaler's resolution swap reaches every material without rebuilding a shader.
 * What breaks if it is removed? Buildings and streets render as flat untextured grey.
 */
import { MeshStandardNodeMaterial } from 'three/webgpu'
import {
  Fn, abs, attribute, cross, dFdx, dFdy, dot, exp, faceDirection, float, floor, fract, fwidth, hash, max, min, mix,
  normalViewGeometry, normalWorldGeometry, positionView, positionWorld, select, sign, smoothstep, step,
  time, vec2, vec3,
} from 'three/tsl'
import type { Node, UniformNode } from 'three/webgpu'
import { CITY, HERITAGE_COLUMNS, STYLE } from './city.ts'
import type { FbmSet } from './fbmTexture.ts'
import { TRAFFIC } from '../02_Define_The_Rules/civic.ts'

type F = Node<'float'>
type V2 = Node<'vec2'>
type V3 = Node<'vec3'>

/** Bump from a procedural height via screen-space derivatives. */
function bumpedNormal(height: F, strength: number) {
  return Fn(() => {
    const n = normalViewGeometry.normalize()
    const dpdx = dFdx(positionView)
    const dpdy = dFdy(positionView)
    const r1 = cross(dpdy, n)
    const r2 = cross(n, dpdx)
    const det = dot(dpdx, r1).mul(faceDirection)
    const grad = sign(det).mul(dFdx(height).mul(strength).mul(r1).add(dFdy(height).mul(strength).mul(r2)))
    return abs(det).mul(n).sub(grad).normalize()
  })()
}

/**
 * A line `width` of a period wide on every integer of `x` (joints, mullions, markings), filtered by the pixel's
 * footprint. It is drawn at least a pixel wide, with a pixel and a half of anti-aliasing, and faded in proportion,
 * so a joint thinner than a pixel stays a faint, continuous line instead of breaking into dashes. Once a period spans
 * only a few pixels the lines would alias into moiré (brick courses a street away), so they fade to their mean
 * cover, `width`, as the footprint grows from a fifth of a period to nearly half.
 */
const line = (x: F, width: number) => {
  // Twice the distance to the nearest line, in periods: a line `width` wide is where this is under `width`.
  const d2 = float(1).sub(abs(fract(x).mul(2).sub(1)))
  const px = fwidth(x)
  const drawn = min(max(px, float(width)), float(0.5))
  const aa = px.mul(1.5)
  const cover = float(1).sub(smoothstep(drawn.sub(aa), drawn.add(aa), d2)).mul(float(width).div(drawn))
  return mix(cover, float(width), smoothstep(0.2, 0.45, px))
}
const band = (x: F, lo: number, hi: number) => step(lo, x).mul(step(x, hi))

/** The box's finish (city.ts STYLE), a per-instance attribute; 0 is a downtown lot's own mix. */
const isStyle = (style: F, s: number) => abs(style.sub(s)).lessThan(0.5)

/**
 * `facadeU`: the horizontal facade coordinate, m. The city's boxes face the axes, so it is the world x or z; a region's
 * surveyed walls run at any angle and carry their distance along the wall as an attribute (region/regionWorld.ts).
 */
export function buildingMaterial(fbm: FbmSet, night: UniformNode<'float', number>, facadeU?: Node<'float'>): MeshStandardNodeMaterial {
  const noise = (uv: V2) => fbm.sample(uv)
  const m = new MeshStandardNodeMaterial()
  const p = positionWorld
  const n = normalWorldGeometry
  const roof = n.y.greaterThan(0.5)
  const u = facadeU ?? select(abs(n.x).greaterThan(0.5), p.z, p.x)
  const v = p.y
  const lot = floor(p.xz.div(CITY.pitch))
  const seed = hash(lot.x.mul(57.1).add(lot.y.mul(13.7)))
  const style = attribute('style', 'float') as unknown as F
  const mixed = isStyle(style, STYLE.mixed)
  const glassStyle = mixed.and(seed.lessThan(0.42))
  const stoneStyle = mixed.and(seed.greaterThanEqual(0.42).and(seed.lessThan(0.74))).or(isStyle(style, STYLE.stone))
  const brickStyle = mixed.and(seed.greaterThanEqual(0.74).and(seed.lessThan(0.88))).or(isStyle(style, STYLE.brick))
  const condoStyle = isStyle(style, STYLE.condo)
  // Finishes without windows or shopfronts: cornices and trim, roofs, plain concrete and masonry, the pier.
  const blind = isStyle(style, STYLE.trim).or(isStyle(style, STYLE.roof)).or(isStyle(style, STYLE.concrete))
    .or(isStyle(style, STYLE.masonry)).or(isStyle(style, STYLE.deck)).or(isStyle(style, STYLE.rail))

  const facadeUv = vec2(u, v).add(seed.mul(97))
  const broad = noise(facadeUv.div(19))
  const detail = noise(facadeUv.div(2.1))
  const retail = v.lessThan(4.6).and(roof.not()).and(blind.not())

  // Curtain wall: 1.5 m mullions, 3.8 m floors, an opaque spandrel at each slab.
  const cwCell = fract(vec2(u.div(1.5), v.div(3.8)))
  const mullion = max(line(u.div(1.5), 0.03), line(v.div(3.8), 0.02))
  const spandrel = band(cwCell.y, 0.0, 0.22)
  const tint = mix(vec3(0.05, 0.08, 0.11), vec3(0.08, 0.1, 0.09), seed.mul(2.4).fract())

  // Punched windows (stone, brick): 3.0 m bays, 3.6 m floors.
  const pw = fract(vec2(u.div(3.0), v.div(3.6)))
  const punched = band(pw.x, 0.2, 0.8).mul(band(pw.y, 0.28, 0.82))
  // Ribbon windows (metal panel): continuous strips.
  const ribbon = band(fract(v.div(3.6)), 0.3, 0.78)

  // Condominiums: floor-to-ceiling glass behind balcony slabs every 3.2 m.
  const balcony = band(fract(v.div(3.2)), 0.0, 0.14)
  const condoGlass = band(fract(u.div(4.0)), 0.08, 0.92).mul(float(1).sub(balcony)).mul(band(fract(v.div(3.2)), 0.2, 0.95))
  const isGlass = select(glassStyle, float(1).sub(max(mullion, spandrel)), select(stoneStyle.or(brickStyle), punched, select(condoStyle, condoGlass, ribbon)))
  const glazing = select(roof.or(blind), float(0), select(retail, band(fract(u.div(6.0)), 0.05, 0.95).mul(band(v, 0.2, 3.9)), isGlass))

  const stone = mix(vec3(0.5, 0.47, 0.42), vec3(0.62, 0.59, 0.53), broad.r).mul(detail.g.mul(0.15).add(0.92))
  const courses = max(line(v.div(0.075), 0.12), line(u.div(0.225).add(floor(v.div(0.075)).mul(0.5)), 0.05))
  const brick = mix(mix(vec3(0.36, 0.17, 0.12), vec3(0.47, 0.25, 0.17), detail.r), vec3(0.62, 0.6, 0.56), courses)
  const panel = vec3(0.13, 0.14, 0.15).mul(broad.g.mul(0.2).add(0.9))
  const aluminium = vec3(0.62, 0.64, 0.66)
  const condo = mix(vec3(0.74, 0.73, 0.7), vec3(0.84, 0.83, 0.8), broad.r).mul(detail.g.mul(0.08).add(0.95))
  const trim = mix(vec3(0.66, 0.62, 0.55), vec3(0.74, 0.7, 0.62), broad.g)
  // Roofs: slate, or copper gone green, one or the other per lot.
  const roofing = select(step(0.7, seed).greaterThan(0.5), vec3(0.3, 0.44, 0.37), vec3(0.17, 0.19, 0.2)).mul(detail.r.mul(0.2).add(0.9))
  const concrete = vec3(0.56, 0.55, 0.52).mul(broad.b.mul(0.15).add(0.9))
  const planks = line(u.div(0.18), 0.08)
  const deck = mix(vec3(0.36, 0.27, 0.19), vec3(0.2, 0.15, 0.1), planks).mul(detail.a.mul(0.2).add(0.9))
  const rail = vec3(0.12, 0.13, 0.14)
  const finished = select(isStyle(style, STYLE.trim), trim, select(isStyle(style, STYLE.roof), roofing, select(isStyle(style, STYLE.concrete), concrete,
    select(isStyle(style, STYLE.masonry), brick, select(isStyle(style, STYLE.deck), deck, rail)))))
  const opaque = select(blind, finished, select(glassStyle, mix(vec3(0.16, 0.18, 0.2), aluminium, mullion), select(stoneStyle, stone, select(brickStyle, brick, select(condoStyle, condo, panel)))))
  const membrane = vec3(0.42, 0.43, 0.42).mul(noise(p.xz.div(4.0)).a.mul(0.25).add(0.85))
  const signage = band(v, 3.9, 4.6).mul(select(retail, float(0), float(1)))
  // Tops: a roof membrane, but the roofing, the deck and the trim show their own finish on top too.
  const ownTop = isStyle(style, STYLE.roof).or(isStyle(style, STYLE.deck)).or(isStyle(style, STYLE.trim))
  const wall = select(roof.and(ownTop.not()), membrane, mix(opaque, vec3(0.06, 0.06, 0.065), signage.mul(select(blind, float(0), float(1)))))

  // Offices behind glass: a few lights by day, far more at night; retail interiors always lit.
  const cell = floor(vec2(u.div(3.0), v.div(3.6)))
  const winId = hash(cell.x.mul(12.9898).add(cell.y.mul(78.233)).add(seed.mul(437.1)).add(n.x.mul(3).add(n.z.mul(7))))
  const litFraction = mix(0.06, 0.3, night)
  const officeLit = step(float(1).sub(litFraction), winId)
  const interior = mix(vec3(1.0, 0.88, 0.7), vec3(0.8, 0.9, 1.0), step(0.55, hash(winId.mul(91))))
  // Fake interior depth: ceiling lights brighten the top of the pane; some offices have blinds.
  const paneY = fract(v.div(3.6))
  const ceiling = smoothstep(0.45, 0.8, paneY).mul(0.6).add(0.4)
  const blinds = mix(float(1), step(0.5, fract(v.div(0.09))).mul(0.5).add(0.35), step(0.7, hash(winId.mul(17))))
  const officeGlow = interior.mul(officeLit).mul(ceiling).mul(blinds).mul(hash(winId.mul(53)).mul(0.6).add(0.4)).mul(mix(0.08, 0.42, night))
  const shopOpen = step(mix(0.1, 0.35, night), hash(floor(u.div(6.0)).add(seed.mul(71))))
  const shopGlow = vec3(1.0, 0.86, 0.66).mul(shopOpen).mul(smoothstep(0.2, 3.6, v).mul(0.5).add(0.5)).mul(mix(0.12, 0.5, night))
  const glassColor = select(glassStyle.and(retail.not()), tint, vec3(0.03, 0.035, 0.04))

  m.colorNode = mix(wall, glassColor, glazing)
  m.metalnessNode = mix(select(glassStyle, mullion.mul(0.8), float(0)), float(0.55), glazing)
  m.roughnessNode = mix(select(glassStyle, float(0.35), select(isStyle(style, STYLE.rail), float(0.4), select(roof, float(0.9), float(0.82)))), float(0.05), glazing)
  m.emissiveNode = glazing.mul(select(retail, shopGlow, officeGlow))
  // Glass stays optically flat; only the opaque skin gets texture relief.
  const height = detail.a.mul(0.15).sub(mullion.mul(0.3)).sub(courses.mul(select(brickStyle, float(0.4), float(0)))).mul(float(1).sub(glazing))
  m.normalNode = bumpedNormal(height, 0.2)
  return m
}

/** Warm pools under the curb-side lamps at night (lamps at 10 m and 30 m into each block). */
function lampPool(p: V3): F {
  const pitch = CITY.pitch
  const pool = (along: F, across: F) => {
    const la = along.sub(10).div(20).round().mul(20).add(10)
    const d2 = along.sub(la).pow(2).add(abs(across).sub(CITY.furniture).pow(2))
    return exp(d2.negate().div(2 * 3.6 * 3.6))
  }
  const cz = p.z.sub(p.z.div(pitch).round().mul(pitch))
  const cx = p.x.sub(p.x.div(pitch).round().mul(pitch))
  return max(pool(p.x, cz), pool(p.z, cx))
}

export function groundMaterial(fbm: FbmSet, night: UniformNode<'float', number>): MeshStandardNodeMaterial {
  const noise = (uv: V2) => fbm.sample(uv)
  const m = new MeshStandardNodeMaterial()
  const p = positionWorld
  const pitch = float(CITY.pitch)
  const ox = p.x.sub(p.x.div(pitch).round().mul(pitch))
  const oz = p.z.sub(p.z.div(pitch).round().mul(pitch))
  const dx = abs(ox)
  const dz = abs(oz)
  // For the street a pixel belongs to: signed offset across it, and signed distance to the nearest
  // intersection centre along it.
  const alongX = dz.lessThan(dx)
  const across = select(alongX, oz, ox)
  const delta = select(alongX, ox, oz)
  const a = abs(across)
  const inIntersection = abs(delta).lessThan(CITY.pitch / 2 - CITY.lotHalf)
  const road = min(dx, dz).lessThan(CITY.roadHalf)
  const curb = band(min(dx, dz), CITY.roadHalf, CITY.roadHalf + 0.3)

  const fine = noise(p.xz.div(3.3))
  const broad = noise(p.xz.div(41))
  const grain = fine.a.mul(0.6).add(fine.g.mul(0.4))
  const wheelTracks = float(1).sub(smoothstep(0.3, 0.9, abs(a.sub(TRAFFIC.laneOffset))).oneMinus().mul(0.12))
  const patching = smoothstep(0.62, 0.66, broad.b).mul(0.06)
  const asphalt = vec3(0.105, 0.108, 0.112).mul(grain.mul(0.45).add(0.78)).mul(wheelTracks).add(patching)

  // Markings: double yellow centreline, white stop bars on the approach side, zebra crosswalks.
  const yellow = band(a, 0.07, 0.17).mul(select(inIntersection, float(0), float(1)))
  const stopBar = band(abs(delta), TRAFFIC.stopLine - 0.25, TRAFFIC.stopLine + 0.25).mul(step(delta.mul(across), 0)).mul(step(a, CITY.roadHalf - 0.1))
  const crosswalk = band(abs(delta), TRAFFIC.crosswalk[0], TRAFFIC.crosswalk[1]).mul(step(fract(a.div(1.0)), 0.5)).mul(step(a, CITY.roadHalf - 0.2))
  const white = max(stopBar, crosswalk)
  const paintWear = fine.r.mul(0.35).add(0.65)
  const roadColor = mix(mix(asphalt, vec3(0.75, 0.6, 0.18).mul(paintWear), yellow), vec3(0.8, 0.8, 0.78).mul(paintWear), white)

  const slabs = max(line(p.x.div(1.5), 0.02), line(p.z.div(1.5), 0.02))
  const pavement = mix(vec3(0.34, 0.335, 0.32), vec3(0.42, 0.41, 0.39), broad.r).mul(grain.mul(0.18).add(0.9)).mul(float(1).sub(slabs.mul(0.3)))
  // Districts by lot (city.ts districtOfLot): the heritage quarter's sidewalks are brick pavers; the park row is
  // grass with a gravel walk; south of the outer street the promenade is paved in wide slabs to the seawall.
  const lot = floor(p.xz.div(pitch))
  const lotLocal = p.xz.sub(lot.add(0.5).mul(pitch))
  const inside = max(abs(lotLocal.x), abs(lotLocal.y)).lessThan(CITY.lotHalf)
  const parkRow = lot.y.equal(CITY.blocks - 1)
  const heritage = lot.x.lessThan(HERITAGE_COLUMNS).and(lot.y.lessThan(CITY.blocks - 2))
  const promenade = p.z.greaterThan(CITY.blocks * CITY.pitch + CITY.roadHalf + 0.3)
  const paverJoints = max(line(p.x.div(0.2), 0.08), line(p.z.div(0.1), 0.08))
  const pavers = mix(vec3(0.42, 0.22, 0.16), vec3(0.52, 0.3, 0.22), fine.r).mul(float(1).sub(paverJoints.mul(0.35)))
  const grass = mix(vec3(0.16, 0.26, 0.09), vec3(0.24, 0.34, 0.12), broad.g).mul(fine.g.mul(0.3).add(0.8))
  const walk = band(abs(lotLocal.x.add(lotLocal.y.mul(0.35))), 0, 1.4)
  const park = mix(grass, vec3(0.5, 0.47, 0.41).mul(grain.mul(0.2).add(0.85)), walk)
  const promenadeSlabs = max(line(p.x.div(3.0), 0.015), line(p.z.div(3.0), 0.015))
  const promenadeColor = mix(vec3(0.5, 0.49, 0.46), vec3(0.58, 0.56, 0.52), broad.r).mul(float(1).sub(promenadeSlabs.mul(0.35)))
  const sidewalk = select(promenade, promenadeColor, select(parkRow.and(inside), park, select(heritage, pavers, pavement)))
  const base = select(road, roadColor, mix(sidewalk, vec3(0.48, 0.47, 0.45), curb))

  m.colorNode = base
  m.roughnessNode = select(road, mix(float(0.92), float(0.65), max(yellow, white)), select(parkRow.and(inside).and(promenade.not()), float(0.95), float(0.86)))
  m.metalnessNode = float(0)
  m.emissiveNode = base.mul(vec3(1.0, 0.8, 0.55)).mul(lampPool(p).mul(night).mul(0.7))
  // The light catches each zone's own joints (no joints in the road or the grass), the same ones the colour draws.
  const joints = select(road.or(parkRow.and(inside).and(promenade.not())), float(0), select(promenade, promenadeSlabs, select(heritage, paverJoints, slabs)))
  m.normalNode = bumpedNormal(grain.mul(0.25).sub(joints.mul(0.5)), 0.12)
  return m
}

/**
 * The lake: dark, glossy water whose ripples drift with time (a bump from two FBM layers scrolling apart). The sky and
 * the city reflect in it through the environment probe; the haze carries it to the horizon.
 */
export function waterMaterial(fbm: FbmSet): MeshStandardNodeMaterial {
  const m = new MeshStandardNodeMaterial()
  const p = positionWorld
  const a = fbm.sample(p.xz.div(9).add(vec2(time.mul(0.021), time.mul(0.013)))).a
  const b = fbm.sample(p.xz.div(23).sub(vec2(time.mul(0.009), time.mul(0.017)))).g
  m.colorNode = mix(vec3(0.02, 0.055, 0.065), vec3(0.035, 0.08, 0.085), b)
  m.roughnessNode = float(0.07)
  m.metalnessNode = float(0)
  m.normalNode = bumpedNormal(a.mul(0.6).add(b.mul(0.4)), 0.35)
  return m
}
