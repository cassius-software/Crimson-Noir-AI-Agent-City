// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The tattoos are drawn by WGSL no GPU runs in a test, so this runs the very text the near
 * body's fragment stage carries (crowdTattoo.ts TATTOO_WGSL, after crowdBody.ts crowdHash) through wgslHost.ts and
 * holds it to what the rest of the city promises: every design fills a fair share of its square and none is too like
 * another, the bands meet themselves round the limb, a single design stays inside its square; the street's draw is
 * look.ts streetTattoos to the bit; the zone is picked from skin of the right bone alone, on the side a viewer sees,
 * the right way round, inside the body's own rings; every ink stands out from every skin by 3:1; the include table
 * covers every call; and the text keeps to what every WGSL compiler takes.
 * What breaks if it is removed? A design could be cut, smeared or mirrored, the street could ink people the card's
 * mirror does not, an ink could vanish on a skin, or a call missing from the includes would build here and fail only
 * when a GPU compiles the stage.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { forbiddenWordIn } from '../01_Initialize_World/assets/cc0.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { crowdHash } from './crowdBody.ts'
import { TATTOO_INCLUDES, TATTOO_INSET, TATTOO_WGSL } from './crowdTattoo.ts'
import { BONE, BONES, SLOT, SLOTS, humanoidMesh } from './humanoid.ts'
import { LAYER, LEGWEAR, LOOK_FIELD, LOOK_HASH, LOOK_PALETTE, LOOK_STREET_FLAG, SLEEVES, lookFromSeed, shaderHash, streetTattoos } from './look.ts'
import {
  TATTOO_FRAMES, TATTOO_HALO, TATTOO_HEAD_SPLIT, TATTOO_INK, TATTOO_INKS, TATTOO_LEG_ZONES, TATTOO_MOTIFS, TATTOO_SHOP_INKS, TATTOO_SLEEVE, TATTOO_STUDIO_LINES, TATTOO_TILE, TATTOO_ZONES,
  inkLine, tattooContrast, tattooLuminance, type TattooFrame, type TattooRgb,
} from './tattoo.ts'
import { compileWgsl } from './wgslHost.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const CROWD = read('./crowd.ts')

/** The hash's text as three writes it (the wgslFn's own code), then the module: the stage's tattoo functions. */
const HASH = (crowdHash as unknown as { code: string }).code
const host = compileWgsl(HASH + TATTOO_WGSL)

type V2 = readonly [number, number]
type V3 = readonly [number, number, number]
const f32 = Math.fround
const shape = (q: V2, entry: number): number => host.call('tatShape', [f32(q[0]), f32(q[1])], entry) as number
/** tattoo() itself: (colour, coverage). */
const tattoo = (skin: V3, rest: V3, bone: number, slot: number, w7: number, w8: number, seed: number, px: number): number[] =>
  host.call('tattoo', skin.map(f32), rest.map(f32), bone, slot, w7 >>> 0, w8 >>> 0, f32(seed), f32(px)) as number[]

const motif = (name: string) => {
  const m = TATTOO_MOTIFS.find((d) => d.name === name)
  assert.ok(m, name)
  return m
}
/** A design on zone z as the look's words hold it: word 7 for the first four zones, word 8 for the rest. */
const words = (z: number, id: number): [number, number] => (z < 4 ? [(id << (7 * z)) >>> 0, 0] : [0, (id << (7 * (z - 4))) >>> 0])
/** Every zone wearing design `id` in ink `ink`. */
const everywhere = (id: number, ink = 0): [number, number] => [((id | (id << 7) | (id << 14) | (id << 21)) | (ink << 28)) >>> 0, (id | (id << 7) | (id << 14) | (id << 21)) >>> 0]

/** A soft mask of a design at n by n over its square, one pixel of edge (as the city draws it, coverage 0..1). */
const mask = (entry: number, n: number): Float64Array => {
  const out = new Float64Array(n * n)
  const px = 2 / n
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const d = shape([((x + 0.5) / n) * 2 - 1, 1 - ((y + 0.5) / n) * 2], entry)
    out[y * n + x] = Math.min(1, Math.max(0, 0.5 - d / px))
  }
  return out
}
let masks32: Float64Array[] | null = null
const masks = (): Float64Array[] => (masks32 ??= TATTOO_MOTIFS.map((m) => mask(m.entry, 32)))

test('coverage: every design inks between 3% and 60% of its square at 32 by 32', () => {
  const cover = masks().map((mk) => mk.reduce((a, b) => a + b, 0) / mk.length)
  for (const [i, c] of cover.entries()) assert.ok(c >= 0.03 && c <= 0.6, `${TATTOO_MOTIFS[i].name}: ${(100 * c).toFixed(1)}%`)
  const least = cover.indexOf(Math.min(...cover)), most = cover.indexOf(Math.max(...cover))
  assert.equal(TATTOO_MOTIFS[least].name, 'lavender sprig', 'the lightest')
  assert.equal(TATTOO_MOTIFS[most].name, 'anemone', 'the heaviest')
})

test('distinctness: no two designs overlap by as much as 0.6 (soft intersection over union) at 32 by 32', () => {
  const all = masks()
  let worst = 0, pair = ''
  for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) {
    let inter = 0, union = 0
    for (let k = 0; k < all[a].length; k++) { inter += Math.min(all[a][k], all[b][k]); union += Math.max(all[a][k], all[b][k]) }
    const iou = union > 0 ? inter / union : 0
    assert.ok(iou < 0.6, `${TATTOO_MOTIFS[a].name} and ${TATTOO_MOTIFS[b].name}: ${iou.toFixed(3)}`)
    if (iou > worst) { worst = iou; pair = `${TATTOO_MOTIFS[a].name} / ${TATTOO_MOTIFS[b].name}` }
  }
  assert.equal(pair, 'nautilus shell / ammonite', `the closest pair (${worst.toFixed(3)})`)
})

test('wrap seams: every band round the limb meets itself, its coverage at the square\'s left edge that at its right within 1e-3', () => {
  const wraps = TATTOO_MOTIFS.filter((m) => m.tile === TATTOO_TILE.wrap).map((m) => m.id)
  assert.deepEqual(wraps, [3, 4, 5, 6, 8, 10, 12, 43, 44])
  // The circuit trace (4) and the star chart (5) are fields of hashed cells, each cell drawn on its own: they break at
  // every cell's edge by design, the square's edge among them, so they are left out.
  const px = 2 / 48
  const cov = (q: V2, entry: number) => Math.min(1, Math.max(0, 0.5 - shape(q, entry) / px))
  for (const id of wraps.filter((i) => i !== 4 && i !== 5)) {
    const { entry, name } = TATTOO_MOTIFS[id - 1]
    for (let y = -1; y <= 1.0001; y += 0.01) {
      const gap = Math.abs(cov([-1, y], entry) - cov([0.99999, y], entry))
      assert.ok(gap <= 1e-3, `${name} at y ${y.toFixed(2)}: ${gap}`)
    }
  }
})

test('inset: a single design, drawn a little inside its square (TATTOO_INSET), inks at most 0.1% of the 96 by 96 square in its outer band', () => {
  assert.equal(TATTOO_INSET, 1.07)
  assert.ok(TATTOO_WGSL.includes(`q=q*${TATTOO_INSET};pq=pq*${TATTOO_INSET};`), 'the shader insets by the same factor')
  const n = 96
  const allowed = Math.floor(0.001 * n * n)
  const touching: string[] = []
  for (const m of TATTOO_MOTIFS) {
    if (m.tile === TATTOO_TILE.wrap) continue
    let inked = 0
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const q: V2 = [((x + 0.5) / n) * 2 - 1, 1 - ((y + 0.5) / n) * 2]
      if (Math.max(Math.abs(q[0]), Math.abs(q[1])) <= 0.985) continue
      if (shape([q[0] * TATTOO_INSET, q[1] * TATTOO_INSET], m.entry) < 0) inked++
    }
    assert.ok(inked <= allowed, `${m.name}: ${inked} pixels of the band`)
    if (inked > 0) touching.push(`${m.name} ${inked}`)
  }
  assert.deepEqual(touching, ['compass rose 4', 'sea star 1'], 'only the compass rose\'s points and a sea star\'s arm reach the band')
})

test('the hash: the module calls crowdBody.ts crowdHash (humanoid.test.ts holds it to look.ts shaderHash); through this compile too it is shaderHash for every seed to 100,000 and past f32\'s whole numbers', () => {
  assert.ok(TATTOO_WGSL.includes('crowdHash('), 'the module calls the crowd\'s hash')
  assert.ok(!TATTOO_WGSL.includes('fn crowdHash'), 'and does not write its own: three writes crowdBody.ts\'s once for the stage')
  for (let s = 0; s <= 100_000; s++) assert.ok(Object.is(host.call('crowdHash', s), shaderHash(s)), `seed ${s}`)
  for (const s of [2 ** 24 + 2, 2 ** 31, 2 ** 32 - 256, 1e12, -3]) assert.ok(Object.is(host.call('crowdHash', f32(s)), shaderHash(s)), `seed ${s}`)
})

/** An agent's colours' chain, as the fragment stage forms its links (crowd.ts `h(k)`) and lookFromSeed takes it. */
const coloursOf = (s: number) => (k: number): number => shaderHash(f32(f32(s) + f32(k * LOOK_HASH.colours)))

test('the street\'s draw: tatStreet is look.ts streetTattoos for every agent below 20,000 on all eight zones, never a studio design or a studio ink; one person in five carries ink, one in ten on the hands, the neck or the nape', () => {
  const n = 20_000
  let carriers = 0, shown = 0
  for (let s = 0; s < n; s++) {
    const cpu = streetTattoos(coloursOf(s))
    const zones = host.call('tatZones', s) as number
    if (zones !== 0) carriers++
    if ((zones & 15) !== 0) shown++
    for (let z = 0; z < TATTOO_ZONES.length; z++) {
      const got = host.call('tatStreet', s, z) as number
      const want = cpu.motifs[z] === 0 ? 0 : cpu.motifs[z] + (cpu.ink << 8)
      if (got !== want) assert.fail(`agent ${s}, zone ${z}: the shader draws ${got}, the mirror ${want}`)
      assert.equal(((zones >>> z) & 1) === 1, got !== 0, `agent ${s}, zone ${z}: the zone set`)
      if (got === 0) continue
      assert.ok((got & 255) > TATTOO_STUDIO_LINES && (got & 255) <= TATTOO_MOTIFS.length, `agent ${s}: design ${got & 255}`)
      assert.ok(!TATTOO_SHOP_INKS.includes(got >>> 8), `agent ${s}: ink ${got >>> 8}`)
    }
  }
  assert.ok(Math.abs(carriers / n - 0.2) < 0.005, `carriers ${carriers / n}`)
  assert.ok(Math.abs(shown / n - 0.1005) < 0.005, `on the hands, the neck or the nape ${shown / n}`)
  // The street flag is word 7's bit 31, which no worn look sets (look.ts LOOK_STREET_FLAG).
  assert.deepEqual({ ...LOOK_STREET_FLAG }, { word: 7, bit: 31 })
  assert.ok(TATTOO_WGSL.includes('if((w7>>31u)==0u){'), 'the shader reads the flag there')
})

test('the street\'s sleeves: the shader rolls them for a passer-by whose designs reach a forearm (tatZones against TATTOO_SLEEVE.zones) unless a coat keeps them down, as look.ts lookFromSeed does, for every agent below 20,000', () => {
  let rolled = 0
  for (let s = 0; s < 20_000; s++) {
    const look = lookFromSeed(s)
    const gpu = ((host.call('tatZones', s) as number) & TATTOO_SLEEVE.zones) !== 0 && look.layer !== LAYER.coat
    if (gpu !== (look.sleeves === SLEEVES.rolled)) assert.fail(`agent ${s}: the shader ${gpu ? 'rolls' : 'keeps down'} the sleeves, lookFromSeed ${look.sleeves}`)
    assert.equal(look.sleeves === SLEEVES.rolled, look.tattooForearm + look.tattooForearmR > 0 && look.layer !== LAYER.coat)
    if (gpu) rolled++
  }
  // About six passers-by in a hundred: three of the eight street sets reach a forearm (the left, the right, both) of
  // the one in five who carry ink, less those in a coat.
  assert.ok(rolled > 1100 && rolled < 1500, `rolled ${rolled}`)
})

test('the street\'s legs: the shader bares them for a skirt-suit passer-by (the fourth body, crowd.ts variant 3) whose designs reach the calf or the ankle (tatZones against TATTOO_LEG_ZONES), as look.ts lookFromSeed does; everyone else\'s are as hashed, for every agent below 20,000', () => {
  let bare = 0
  for (let s = 0; s < 20_000; s++) {
    const look = lookFromSeed(s)
    const gpu = s % 4 === 3 && ((host.call('tatZones', s) as number) & TATTOO_LEG_ZONES) !== 0 ? LEGWEAR.bare : LEGWEAR.hashed
    if (gpu !== look.legwear) assert.fail(`agent ${s}: the shader's legs ${gpu}, lookFromSeed ${look.legwear}`)
    assert.equal(look.legwear === LEGWEAR.bare, look.body === 3 && look.tattooCalf + look.tattooAnkleR > 0)
    if (gpu === LEGWEAR.bare) bare++
  }
  // About one in 160: the one in five who carry ink, of the skirt suit's quarter, whose set (one in eight) reaches the legs.
  assert.ok(bare > 90 && bare < 170, `bare ${bare}`)
})

const cross = (u: V3, v: V3): V3 => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]

/**
 * The rest position of the point at q (before the inset) of zone z's square, on the body's surface, found from
 * outside: a viewer facing the surface looks along its inward normal, and their right is that direction crossed with
 * up, so q.x steps that way (round the limb by arc length, or straight across a hand's front face, `front` its z).
 */
const restOf = (z: number, q: V2, front = 0.02): V3 => {
  const fr: TattooFrame = TATTOO_FRAMES[z]
  const y = fr.centreY + q[1] * fr.half
  const n: V3 = [Math.sin(fr.angle), 0, Math.cos(fr.angle)]
  const right = cross([-n[0], -n[1], -n[2]], [0, 1, 0])
  const s = q[0] * fr.half
  if (fr.radius === 0) return [fr.axisX + right[0] * s, y, front + right[2] * s]
  const d = s / fr.radius
  return [fr.axisX + fr.radius * (n[0] * Math.cos(d) + right[0] * Math.sin(d)), y, fr.radius * (n[2] * Math.cos(d) + right[2] * Math.sin(d))]
}
const SKIN: V3 = [0.5, 0.4, 0.3]
const CRISP = 1e-5

test('the zone: each zone\'s centre on its bone\'s skin is inked; no other slot ever is (the top over a hand neither), nor a bone with no zone; a hand\'s back face takes no single design; a nape band never reaches the front; a pixel past 0.4 of a design unit leaves the skin as it was', () => {
  // The shader holds one wrist height for both hands' bands and each limb's own centre for the rest (crowdTattoo.ts
  // takes the first frame's wrapY and every other frame's centreY): the planar frames come first.
  for (const [z, fr] of TATTOO_FRAMES.entries()) {
    if (z < 2) assert.ok(fr.radius === 0 && fr.wrapY === TATTOO_FRAMES[0].wrapY, `${TATTOO_ZONES[z].slot}: flat, banded at the wrist`)
    else assert.ok(fr.radius > 0 && fr.wrapY === fr.centreY, `${TATTOO_ZONES[z].slot}: round the limb, banded at its centre`)
  }
  assert.ok(TATTOO_WGSL.includes(`select(fz.y,${TATTOO_FRAMES[0].wrapY},z<2u)`))
  const sun = motif('sunburst').id
  const [w7, w8] = everywhere(sun)
  const zoneBones = new Set(TATTOO_ZONES.map((zone) => zone.bone))
  for (const [z, zone] of TATTOO_ZONES.entries()) {
    const at = restOf(z, [0, 0])
    const one = words(z, sun)
    const hit = tattoo(SKIN, at, zone.bone, SLOT.SKIN, one[0], one[1], 0, CRISP)
    assert.ok(hit[3] > 0.999, `${zone.slot}: the sunburst's disc at the centre (${hit[3]})`)
    for (let slot = 0; slot < SLOTS; slot++) {
      if (slot === SLOT.SKIN) continue
      const got = tattoo(SKIN, at, zone.bone, slot, w7, w8, 0, CRISP)
      assert.deepEqual(got, [...SKIN.map(f32), 0], `${zone.slot}: slot ${slot} is never inked`)
    }
    for (let bone = 0; bone < BONES; bone++) {
      if (zoneBones.has(bone)) continue
      assert.equal(tattoo(SKIN, at, bone, SLOT.SKIN, w7, w8, 0, CRISP)[3], 0, `${zone.slot}: bone ${bone} has no zone`)
    }
  }
  for (const bone of [BONE.HAND_R, BONE.HAND_L]) assert.equal(tattoo(SKIN, restOf(bone === BONE.HAND_R ? 0 : 1, [0, 0]), bone, SLOT.TOP, w7, w8, 0, CRISP)[3], 0, 'a sleeve over the hand')
  // The hands' single designs are on the front face (+z) alone.
  assert.equal(tattoo(SKIN, restOf(0, [0, 0], -0.02), BONE.HAND_R, SLOT.SKIN, w7, w8, 0, CRISP)[3], 0, 'the left hand\'s back face')
  assert.equal(tattoo(SKIN, restOf(1, [0, 0], -0.02), BONE.HAND_L, SLOT.SKIN, w7, w8, 0, CRISP)[3], 0, 'the right hand\'s back face')
  // A band round the nape (the braided rope) inks the back and never the front (z > -0.035): the chin and the jaw
  // above the chin ring are no zone, the neck below it is the neck's.
  const rope = motif('braided rope band').id
  let back = 0
  for (let y = 1.548; y <= 1.608; y += 0.002) for (let a = -Math.PI; a < Math.PI; a += 0.05) {
    const p: V3 = [0.058 * Math.sin(a), y, 0.058 * Math.cos(a)]
    const w = tattoo(SKIN, p, BONE.HEAD, SLOT.SKIN, rope << 21, 0, 0, 0.0004)[3]
    if (p[2] > TATTOO_HEAD_SPLIT.napeZ) assert.equal(w, 0, `the nape's band at y ${y.toFixed(3)}, angle ${a.toFixed(2)}`)
    else if (w > 0) back++
  }
  assert.ok(back > 100, `the band shows behind (${back})`)
  // Far off: past 0.4 of a design unit to the pixel, the design is gone, not tinted; at 0.3 it is still drawn.
  const half = TATTOO_FRAMES[0].half
  const single = (pq: number) => tattoo(SKIN, restOf(0, [0, 0]), BONE.HAND_R, SLOT.SKIN, sun, 0, 0, (pq * half) / TATTOO_INSET)
  assert.deepEqual(single(0.4 * 1.0001), [...SKIN.map(f32), 0], 'a single design past 0.4')
  assert.ok(single(0.3)[3] > 0.3, 'a single design at 0.3')
  const wrist = (pq: number) => tattoo(SKIN, [0.212, TATTOO_FRAMES[0].wrapY, 0.02], BONE.HAND_R, SLOT.SKIN, rope, 0, 0, pq / Math.max(TATTOO_FRAMES[0].reps / (Math.PI * 0.03), 1 / half))
  assert.deepEqual(wrist(0.4 * 1.0001), [...SKIN.map(f32), 0], 'a band past 0.4')
  // A chosen look's word without the street flag reads its own fields; with it, the seed's draw (agent 5: the nape).
  const nape = restOf(3, [0, 0])
  assert.equal(tattoo(SKIN, nape, BONE.HEAD, SLOT.SKIN, 0, 0, 5, CRISP)[3], 0, 'an untattooed look')
  const street = streetTattoos(coloursOf(5))
  assert.equal(street.motifs[3], motif('heartbeat line').id)
  assert.deepEqual(tattoo(SKIN, nape, BONE.HEAD, SLOT.SKIN, 0x80000000, 0, 5, CRISP), tattoo(SKIN, nape, BONE.HEAD, SLOT.SKIN, street.motifs[3] << 21, 0, 5, CRISP), 'the street flag draws what the mirror says')
})

test('handedness: no design is mirrored: on every zone a point to the right of the centre, as a viewer outside the surface sees it, is the design\'s right (the comet and the paper plane)', () => {
  for (const name of ['comet', 'paper plane']) {
    const { id, entry } = motif(name)
    // A point inked on the right and bare at its mirror on the left.
    let q: V2 | null = null
    for (let y = -0.8; y <= 0.8 && !q; y += 0.05) for (let x = 0.2; x <= 0.8 && !q; x += 0.05) {
      if (shape([x, y], entry) < -0.02 && shape([-x, y], entry) > 0.02) q = [x, y]
    }
    assert.ok(q, `${name} has a right side of its own`)
    for (const [z, zone] of TATTOO_ZONES.entries()) {
      const [w7, w8] = words(z, id)
      const pre: V2 = [q[0] / TATTOO_INSET, q[1] / TATTOO_INSET]
      const right = tattoo(SKIN, restOf(z, pre), zone.bone, SLOT.SKIN, w7, w8, 0, CRISP)[3]
      const left = tattoo(SKIN, restOf(z, [-pre[0], pre[1]]), zone.bone, SLOT.SKIN, w7, w8, 0, CRISP)[3]
      assert.ok(right > 0.999 && left < 0.001, `${name} on ${zone.slot}: right ${right}, left ${left}`)
    }
  }
})

test('the frames against the bodies\' rest rings (humanoid.ts, all four bodies): each holds skin of its bone (or, for the forearms, the calf and the ankle, the sleeve and the leg their slices bare); the hand\'s single square is clear of the watch; the neck\'s ends below the chin ring; the forearm\'s lies between the cuff and the roll; the ankle\'s above the shoe', () => {
  // The watch's band and its case (crowd.ts): a band within `band` of `wy`, a case within `size` of it.
  const wy = Number(CROWD.match(/const wy = rest\.y\.sub\(([\d.]+)\)/)![1])
  const band = Number(CROWD.match(/wy\.abs\(\)\.lessThan\(([\d.]+)\)\.or\(face\)/)![1])
  const smart = Number(CROWD.match(/rest\.z\.abs\(\)\.lessThan\([\d.]+\)\)\.and\(wy\.abs\(\)\.lessThan\(([\d.]+)\)\)/)![1])
  assert.deepEqual([wy, band, smart], [0.905, 0.007, 0.013])
  const hand = TATTOO_FRAMES[0]
  assert.ok(hand.centreY + hand.half < wy - band, 'below the band (0.898)')
  assert.ok(hand.centreY + hand.half < wy - Math.max(smart, 0.012), 'below the case, round or a smartwatch\'s')
  const legs: readonly number[] = [SLOT.BOTTOM, SLOT.LEGWEAR]
  for (let v = 0; v < 4; v++) {
    const mesh = humanoidMesh(v, true)
    const at = (i: number): V3 => [mesh.position[3 * i], mesh.position[3 * i + 1], mesh.position[3 * i + 2]]
    const boneOf = (i: number) => Math.round(mesh.rig[3 * i]), slotOf = (i: number) => Math.round(mesh.rig[3 * i + 1])
    const ringsOf = (keep: (i: number) => boolean): number[] => {
      const ys = new Set<number>()
      for (let i = 0; i < mesh.vertexCount; i++) if (keep(i)) ys.add(Math.round(at(i)[1] * 1e4) / 1e4)
      return [...ys].sort((a, b) => a - b)
    }
    for (const [z, zone] of TATTOO_ZONES.entries()) {
      const fr = TATTOO_FRAMES[z]
      const slots: readonly number[] = z < 4 ? [SLOT.SKIN] : z < 6 ? [SLOT.TOP] : legs
      // The body's surface in the square's own coordinates (q, as the shader maps a rest point): every triangle of the
      // zone's bone whose slot (its first vertex's, flat) is the zone's; on a hand its front face alone, round a limb
      // none that touches the axis (a tube's cap, hidden inside the body).
      const qOf = (p: V3): V2 => {
        if (fr.radius === 0) return [(p[0] - fr.axisX) / fr.half, (p[1] - fr.centreY) / fr.half]
        const da = Math.atan2(p[0] - fr.axisX, p[2]) - fr.angle
        return [((da - 2 * Math.PI * Math.floor((da + Math.PI) / (2 * Math.PI))) * fr.radius) / fr.half, (p[1] - fr.centreY) / fr.half]
      }
      const faces: { ps: V3[]; qs: V2[] }[] = []
      for (let t = 0; t < mesh.index.length; t += 3) {
        const corners = [mesh.index[t], mesh.index[t + 1], mesh.index[t + 2]]
        if (!slots.includes(slotOf(corners[0])) || corners.some((i) => boneOf(i) !== zone.bone)) continue
        const ps = corners.map(at)
        if (fr.radius === 0 ? ps.some((p) => p[2] < -1e-6) || ps.every((p) => p[2] <= 1e-6) : ps.some((p) => Math.hypot(p[0] - fr.axisX, p[2]) < 0.01)) continue
        // A face across the back of the frame's turn (where its angle wraps) would span every q.x: it is skipped.
        const qs = ps.map(qOf)
        if (fr.radius > 0 && Math.max(...qs.map((q) => q[0])) - Math.min(...qs.map((q) => q[0])) > (Math.PI * fr.radius) / fr.half) continue
        faces.push({ ps, qs })
      }
      /** The rest point of the surface at q (the first face over it, by its barycentric weights), or null where none is. */
      const surfaceAt = (q: V2): V3 | null => {
        for (const { ps, qs: [a, b, c] } of faces) {
          const area = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
          if (Math.abs(area) < 1e-12) continue
          const wb = ((q[0] - a[0]) * (c[1] - a[1]) - (q[1] - a[1]) * (c[0] - a[0])) / area
          const wc = ((b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0])) / area
          const wa = 1 - wb - wc
          if (wa < -1e-9 || wb < -1e-9 || wc < -1e-9) continue
          return [0, 1, 2].map((k) => wa * ps[0][k] + wb * ps[1][k] + wc * ps[2][k]) as unknown as V3
        }
        return null
      }
      for (const qx of [-0.75, 0, 0.75]) for (const qy of [-0.75, 0, 0.75]) {
        const p = surfaceAt([qx, qy])
        assert.ok(p, `body ${v}, ${zone.slot}: the square at (${qx}, ${qy}) lies on its bone's ${z < 4 ? 'skin' : 'sleeve or leg'}`)
        // And there the shader picks this zone: the head's skin splits at the nape's z and the chin ring.
        if (z === 2) assert.ok(p[1] < TATTOO_HEAD_SPLIT.neckTop && p[2] > TATTOO_HEAD_SPLIT.napeZ, `body ${v}: the neck's square at (${qx}, ${qy}) is the neck`)
        if (z === 3) assert.ok(p[1] < TATTOO_HEAD_SPLIT.top && p[2] <= TATTOO_HEAD_SPLIT.napeZ, `body ${v}: the nape's square at (${qx}, ${qy}) is the nape`)
      }
    }
    // The neck's square ends below the chin ring, the head's first skin ring above the neck's.
    const head = ringsOf((i) => boneOf(i) === BONE.HEAD && slotOf(i) === SLOT.SKIN)
    assert.ok(head.includes(TATTOO_HEAD_SPLIT.neckTop), `body ${v}: the chin ring at ${TATTOO_HEAD_SPLIT.neckTop}`)
    assert.ok(TATTOO_FRAMES[2].centreY + TATTOO_FRAMES[2].half < TATTOO_HEAD_SPLIT.neckTop, 'the neck\'s square below the chin ring')
    // The forearm's between the cuff (the forearm's lowest ring) and the roll line (1.10, its highest).
    const forearm = ringsOf((i) => boneOf(i) === BONE.FOREARM_R)
    assert.deepEqual([forearm[0], forearm[forearm.length - 1]], [0.935, TATTOO_SLEEVE.roll], `body ${v}: the cuff and the roll line`)
    for (const z of [4, 5]) assert.ok(TATTOO_FRAMES[z].centreY - TATTOO_FRAMES[z].half > forearm[0] && TATTOO_FRAMES[z].centreY + TATTOO_FRAMES[z].half < forearm[forearm.length - 1])
    // The ankle's above the shoe's top.
    const shoe = Math.max(...ringsOf((i) => slotOf(i) === SLOT.SHOES))
    assert.equal(shoe, 0.085, `body ${v}: the shoe's top`)
    assert.ok(TATTOO_FRAMES[7].centreY - TATTOO_FRAMES[7].half > shoe, 'the ankle\'s square above the shoe')
  }
})

/** linear RGB of an sRGB hex, as three's Color reads it. */
const linear = (hex: number): TattooRgb => {
  const c = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
  return [c(((hex >> 16) & 255) / 255), c(((hex >> 8) & 255) / 255), c((hex & 255) / 255)]
}

test('contrast through the shader: for all eight inks on all eighty-one skins the line stands out from what lies beside it (the halo, or the skin where none is needed) by 3:1, and it is inkLine\'s line and halo; black on MST-10 takes a light halo', () => {
  // The skins as crowd.ts makes them: the Monk tones under the four undertones' tints, young and grey with age (a
  // quarter of the way to the tone's own grey), and vitiligo's pale.
  const tintLine = CROWD.match(/^ {4}const tint = (.*)$/m)
  assert.ok(tintLine)
  const tints = [...tintLine[1].matchAll(/vec3\(([^)]*)\)/g)].map((m) => m[1].split(',').map(Number) as unknown as TattooRgb)
  assert.equal(tints.length, 4)
  assert.ok(CROWD.includes('vec3(dot(marked, vec3(0.2126, 0.7152, 0.0722))), age.mul(0.25))'), 'age greys the skin by a quarter at most')
  const skins: TattooRgb[] = [linear(Number.parseInt(CROWD.match(/const VITILIGO_PALE = new Color\(0x([0-9a-f]{6})\)/)![1], 16))]
  for (const hex of LOOK_PALETTE.monk) for (const tint of tints) for (const age of [0, 1]) {
    const c = linear(hex).map((v, i) => v * tint[i]) as unknown as TattooRgb
    const g = tattooLuminance(c)
    skins.push(c.map((v) => v + (g - v) * age * 0.25) as unknown as TattooRgb)
  }
  assert.equal(skins.length, 81)
  // On the left hand, the sunburst: its disc's centre is the line's colour; just outside the disc (0.04 of a unit,
  // within the halo's 0.075) is the halo's.
  const { id, entry } = motif('sunburst')
  const lineAt: V2 = [0, 0], haloAt: V2 = [0.4 * Math.sin(Math.PI / 8), 0.4 * Math.cos(Math.PI / 8)]
  assert.ok(shape(lineAt, entry) < -0.3)
  const gap = shape(haloAt, entry)
  assert.ok(gap > 0.02 && gap < TATTOO_HALO.width - 0.02, `the halo's point (${gap})`)
  const on = (q: V2): V3 => restOf(0, [q[0] / TATTOO_INSET, q[1] / TATTOO_INSET])
  const haloed = TATTOO_INKS.map(() => 0)
  for (const [ink] of TATTOO_INKS.entries()) {
    const w7 = (id | (ink << 28)) >>> 0
    for (const skin of skins) {
      const line = tattoo(skin, on(lineAt), BONE.HAND_R, SLOT.SKIN, w7, 0, 0, CRISP)
      const beside = tattoo(skin, on(haloAt), BONE.HAND_R, SLOT.SKIN, w7, 0, 0, CRISP)
      assert.ok(line[3] > 0.999 && beside[3] < 0.001, 'the line covered, its halo not')
      const li = tattooLuminance(line.slice(0, 3) as unknown as TattooRgb), lb = tattooLuminance(beside.slice(0, 3) as unknown as TattooRgb)
      // The shader works in f32, whose rounding (about one part in ten million a step) reaches the ratio's sixth
      // decimal: the rule is exact in doubles (look.test.ts holds inkLine to 1e-9).
      assert.ok(tattooContrast(li, lb) >= TATTOO_HALO.contrast - 1e-5, `${TATTOO_INKS[ink].name} on ${skin.map((c) => c.toFixed(4))}: ${tattooContrast(li, lb)}`)
      const cpu = inkLine(skin, ink)
      for (let c = 0; c < 3; c++) {
        assert.ok(Math.abs(line[c] - cpu.line[c]) < 1e-5, 'the shader\'s line is inkLine\'s')
        assert.ok(Math.abs(beside[c] - cpu.halo[c]) < 1e-5, 'and its halo')
      }
      if (cpu.t > 0) haloed[ink]++
    }
  }
  assert.deepEqual(haloed, [32, 40, 49, 57, 47, 48, 56, 56], 'haloed skins of the eighty-one, per ink')
  const deepest = linear(LOOK_PALETTE.monk[9])
  const w7 = (id | (TATTOO_INK.black << 28)) >>> 0
  const line = tattoo(deepest, on(lineAt), BONE.HAND_R, SLOT.SKIN, w7, 0, 0, CRISP).slice(0, 3)
  const halo = tattoo(deepest, on(haloAt), BONE.HAND_R, SLOT.SKIN, w7, 0, 0, CRISP).slice(0, 3) as unknown as TattooRgb
  assert.deepEqual(line.map((c) => c.toFixed(4)), ['0.0130', '0.0126', '0.0140'], 'black on MST-10: the line')
  assert.equal(tattooLuminance(halo).toFixed(4), '0.1383', 'its halo')
  const ls = tattooLuminance(deepest)
  assert.equal(((tattooLuminance(halo) - ls) / (tattooLuminance(TATTOO_HALO.white) - ls)).toFixed(4), '0.1257', 'taken an eighth of the way to the warm white')
})

test('TATTOO_INCLUDES: every tatX( and crowdHash( call in each function is an include of it (transitively), every include is a function, and tattoo reaches them all', () => {
  const parts = new Map(TATTOO_WGSL.split(/(?=fn )/).map((p) => [p.match(/^fn (\w+)\(/)![1], p]))
  assert.deepEqual([...parts.keys()], ['tatSeg', 'tatLeaf', 'tatPoly', 'tatShape', 'tatZones', 'tatStreet', 'tattoo'])
  const reach = (name: string, seen = new Set<string>()): Set<string> => {
    for (const inc of TATTOO_INCLUDES[name] ?? []) if (!seen.has(inc)) { seen.add(inc); reach(inc, seen) }
    return seen
  }
  for (const [name, text] of parts) {
    const body = text.replace(/^fn \w+\([^)]*\)[^{]*\{/, '')
    const calls = new Set([...body.matchAll(/\b(tat\w+|tattoo|crowdHash)\(/g)].map((m) => m[1]).filter((c) => c !== name))
    const included = reach(name)
    for (const c of calls) assert.ok(included.has(c), `${name} calls ${c}, which TATTOO_INCLUDES does not reach from it`)
    for (const inc of TATTOO_INCLUDES[name] ?? []) assert.ok(parts.has(inc) || inc === 'crowdHash', `${name} includes ${inc}, which is no function`)
  }
  assert.deepEqual([...reach('tattoo')].sort(), ['crowdHash', 'tatLeaf', 'tatPoly', 'tatSeg', 'tatShape', 'tatStreet', 'tatZones'])
  // The module ships through crowd.ts: the tattoo on the near body, the street's zones on both (the sleeves).
  assert.match(CROWD, /^import \{ tattoo, tattooZones \} from '\.\/crowdTattoo\.ts'$/m)
})

/** Words WGSL reserves (the WGSL specification's list): no name the module declares may be one. */
const RESERVED = new Set(('NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await become binding_array cast catch class co_await co_return co_yield coherent column_major common compile compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external fallthrough filter final finally friend from fxgroup get goto groupshared highp impl implements import inline instanceof interface layout lowp macro macro_rules match mediump meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation noperspective null nullptr of operator package packoffset partition pass patch pixelfragment precise precision premerge priv protected pub public readonly ref regardless register reinterpret_cast require resource restrict self set shared sizeof smooth snorm static static_assert static_cast std subroutine super target template this thread_local throw trait try type typedef typeid typename typeof union unless unorm unsafe unsized use using varying virtual volatile wgsl where with writeonly yield').split(' '))

test('source hygiene: the WGSL uses nothing wgslHost.ts or a GPU compiler would refuse (no fract, smoothstep or step, no derivative, no reserved word for a name, no let-bound array indexed at run time, no pow of a negative), carries no comment and closes no `- -` into a decrement', () => {
  for (const banned of [/\bfract\(/, /\bsmoothstep\(/, /\bstep\(/, /\bdpdx/, /\bdpdy/, /\bfwidth/, /--/, /\/\//, /\/\*/]) assert.doesNotMatch(TATTOO_WGSL, banned, String(banned))
  const declared = new Set<string>()
  for (const m of TATTOO_WGSL.matchAll(/\b(?:let|var)\s*(\w+)\s*=/g)) declared.add(m[1])
  for (const m of TATTOO_WGSL.matchAll(/fn \w+\(([^)]*)\)/g)) for (const p of m[1].split(',')) declared.add(p.split(':')[0].trim())
  for (const name of declared) assert.ok(!RESERVED.has(name), `${name} is a reserved word`)
  assert.ok(declared.has('pts') && declared.has('toward'), 'the names were read')
  assert.doesNotMatch(TATTOO_WGSL, /\blet \w+=array</, 'an array indexed at run time is a var')
  for (const m of TATTOO_WGSL.matchAll(/\bpow\((\w+)\(/g)) assert.ok(m[1] === 'max' || m[1] === 'abs', `pow of ${m[1]}(...): a base that cannot be negative`)
  assert.equal([...TATTOO_WGSL.matchAll(/\bpow\(/g)].length, 2)
  assert.equal(TATTOO_WGSL.length, 12_801, 'the module\'s size, squeezed')
})

/** A regular expression another test declares (`const NAME = /.../flags`), read from its file so the two stay one. */
const regexIn = (file: string, name: string): RegExp => {
  const m = read(file).match(new RegExp(`^const ${name} = \\/(.+)\\/([a-z]*)$`, 'm'))
  assert.ok(m, `${file} declares ${name}`)
  return new RegExp(m[1], m[2])
}

test('names: every design, ink and zone label is lower-case words (labels capitalised), passes the conduct screen and the asset gate, and is no people\'s, no culture\'s or faith\'s design, nothing armed', () => {
  const ARMED = regexIn('../02_Define_The_Rules/conduct.test.ts', 'ARMED')
  const PEOPLE = regexIn('./look.test.ts', 'PEOPLE')
  const DENIED = regexIn('./look.test.ts', 'TATTOO_DENIED')
  const names = [...TATTOO_MOTIFS.map((m) => m.name), ...TATTOO_INKS.map((i) => i.name)]
  for (const name of names) assert.match(name, /^[a-z][a-z -]*[a-z]$/, name)
  for (const label of TATTOO_ZONES.map((z) => z.label)) assert.match(label, /^[A-Z][a-z]*(?: [a-z]+)?$/, label)
  for (const name of [...names, ...TATTOO_ZONES.map((z) => z.label)]) {
    assert.ok(screen(name).admissible, `${name}: the conduct screen`)
    assert.equal(forbiddenWordIn(name), null, `${name}: the asset gate`)
    assert.doesNotMatch(name, ARMED, name)
    assert.doesNotMatch(name, PEOPLE, name)
    assert.doesNotMatch(name, DENIED, name)
  }
  for (const word of ['celtic', 'seigaiha', 'wayfinder', 'vegvisir', 'skull']) assert.match(word, DENIED, 'the denylist holds what it names')
  // The zones' look slots: the tattoo word's fields in zone order (four to a word), the ink above them.
  for (const [z, zone] of TATTOO_ZONES.slice(0, 4).entries()) assert.deepEqual(LOOK_FIELD[zone.slot as keyof typeof LOOK_FIELD], [7, 7 * z, 7], zone.slot)
  assert.deepEqual(LOOK_FIELD.tattooInk, [7, 28, 3])
})
