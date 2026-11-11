// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the crowd's tattoos on the GPU: the WGSL the near body's fragment stage (crowd.ts)
 * runs for each fragment of skin, written as TSL functions. tattoo() finds the zone a fragment of skin lies on by its
 * bone (a hand, the neck, the nape, a forearm, the calf, the ankle), the design and the ink there (a chosen look's
 * tattoo word, or the street's draw from the person's seed), maps the rest position through the zone's frame into
 * the design's square, and draws the design as a signed distance with one pixel of soft edge: sixty-four designs in
 * eight families of eight, each family one case of tatShape and each design a row of numbers, with no texture, no
 * sampler, no uniform and no varying of its own. The ink's line is the skin taken most of the way to the ink, and
 * where it would not stand out from that skin by 3:1 a halo moves the skin just far enough that it does. The text is
 * built at load from tattoo.ts's tables (the designs' bytes, the pictures' points, the frames, the inks, the street's
 * zone sets) and look.ts's street draw (its colour links, its hash's step and its odds), so the shader, the card,
 * the console and the CPU mirror (look.ts streetTattoos) read one set of numbers. The comments live here in
 * TypeScript, beside the WGSL they describe; the text itself is squeezed of spare whitespace once, at load.
 *
 * The drawings keep to plain things (flowers, sprigs, spirals, shapes, bands round the limb, small pictures) and to
 * rules each drawing enforces: the sunburst has eight short rays that never reach the square's edge (never a
 * sixteen-ray starburst); the compass rose has four long and four short points round a ring (never two overlapping
 * squares); the nested triangles are concentric and point up (never two crossed into a six-point star, and no
 * triangle anywhere points down); the honeycomb is hexagonal cells (never a lattice of six-point stars); the crescent
 * is never paired with a star and the moon's phases are five discs, never three; there is no plain five-point star
 * (the comet has three streaks, the sea star curved arms with rows of dots); the spirals have one arm or two, never
 * three; the braided rope band is two strands of a sine, not knotwork; the circuit traces run from a cell's centre to
 * one edge's midpoint, so no cross and no figure with bent arms can form. Nothing here is a crest, a lettering, a
 * sign of a faith, a clan, a gang or a people, a cross, a skull, a crown, a flag, a swallow or a nautical star, and
 * nothing is violent.
 * What breaks if it is removed? No one in the city wears a tattoo: the near body has no ink to draw, the street's
 * draw that look.ts mirrors has no shader, and the ink studio's mirror shows bare skin.
 */
import { wgslFn } from 'three/tsl'
import { crowdHash } from './crowdBody.ts'
import { SLOT } from './humanoid.ts'
import { LOOK_FIELD, LOOK_HASH, LOOK_HASHED_COLOUR, LOOK_ODDS, LOOK_STREET_FLAG } from './look.ts'
import {
  TATTOO_FRAMES, TATTOO_HALO, TATTOO_HEAD_SPLIT, TATTOO_INK, TATTOO_INKS, TATTOO_MOTIFS, TATTOO_MOTIF_PACKED, TATTOO_PICTURES, TATTOO_POINTS_PACKED,
  TATTOO_POINT_STARTS, TATTOO_POINT_STARTS_PACKED, TATTOO_STREET_SETS, TATTOO_STREET_SETS_PACKED, TATTOO_STUDIO_LINES, TATTOO_TILE, TATTOO_ZONES,
} from './tattoo.ts'

/** A number as a WGSL f32 literal (an integer gets its point). */
const f = (n: number): string => (Number.isInteger(n) ? `${n}.0` : `${n}`)

/**
 * A computed number as the shortest WGSL f32 literal that reads back as the same f32 (a product such as 45 × 7.919 is
 * 356.35499999999996 in a double; its literal is 356.355).
 */
const lit = (n: number): string => {
  if (Number.isInteger(n)) return `${n}.0`
  for (let p = 1; p <= 17; p++) {
    const s = String(Number(n.toPrecision(p)))
    if (Math.fround(Number(s)) === Math.fround(n)) return s.includes('.') || s.includes('e') ? s : `${s}.0`
  }
  return `${n}`
}

/** A u32 as a WGSL hex literal. */
const hex = (n: number): string => `0x${n.toString(16)}u`
/** A u32 of four bytes as a WGSL hex literal, all eight digits shown, so each byte reads off it. */
const bytes = (n: number): string => `0x${n.toString(16).padStart(8, '0')}u`

/**
 * How far inside its square a single design is drawn: the square's coordinates are scaled by this before the design
 * reads them, so no line or petal is cut at the square's edge. A test or a thumbnail that draws a design as the city
 * does applies it too.
 */
export const TATTOO_INSET = 1.07

/** The value of `z` that means no zone: the zone count. */
const NO_ZONE = TATTOO_ZONES.length
/** The planar zones (the hands) come first in zone order; their radius is 0, and their band wraps round the wrist. */
const PLANAR = TATTOO_FRAMES.findIndex((frame) => frame.radius > 0)
/** The zones each genome word holds (the eight over two words: word 7 the first four, word 8 the rest), and the bits a zone's field takes. */
const ZONES_A_WORD = TATTOO_ZONES.length / 2
const ZONE_BITS = LOOK_FIELD.tattooHand[2]
/** The street's links: the colours' chain, link k at the seed plus k times the chain's step (crowd.ts `h(k)`). */
const link = (k: number): string => lit(k * LOOK_HASH.colours)
/** The designs the street draws from: every one after the studio's lines. */
const STREET_DESIGNS = TATTOO_MOTIFS.length - TATTOO_STUDIO_LINES

/** The distance from p to the segment a..b. */
const TAT_SEG = `
fn tatSeg(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0));
}`

/** A pointed leaf (a vesica: the lens two circles share) along +y from the origin, half-length b, half-width h. */
const TAT_LEAF = `
fn tatLeaf(p: vec2f, b: f32, h: f32) -> f32 {
  let r = (b * b + h * h) / (2.0 * h);
  let d = r - h;
  let q = abs(p - vec2f(0.0, b));
  return select(length(q - vec2f(-d, 0.0)) - r, length(q - vec2f(0.0, b)), (q.y - b) * d > q.x * b);
}`

/**
 * The distance to the polyline of points i0 to i1 - 1 of the point table (tattoo.ts TATTOO_POINTS_PACKED: a byte a
 * point, four bits a coordinate on the 15 by 15 grid, 7 the centre; the byte 255 lifts the pen). The table is a `var`
 * because it is indexed by a value only known at run time.
 */
const TAT_POLY = `
fn tatPoly(p: vec2f, i0: u32, i1: u32) -> f32 {
  var pts = array<u32, ${TATTOO_POINTS_PACKED.length}>(${TATTOO_POINTS_PACKED.map(hex).join(', ')});
  var d = 9.0;
  var last = 255u;
  for (var i = i0; i < i1; i++) {
    let c = (pts[i >> 2u] >> ((i & 3u) * 8u)) & 255u;
    if (c != 255u && last != 255u) {
      d = min(d, tatSeg(p, (vec2f(f32(last >> 4u), f32(last & 15u)) - 7.0) / 7.0, (vec2f(f32(c >> 4u), f32(c & 15u)) - 7.0) / 7.0));
    }
    last = c;
  }
  return d;
}`

/**
 * Flowers: petals round a centre, filled or drawn (the bits of 0xa5 are the drawn ones), notched or not, a ring
 * round the centre; the per-variant rows are the petal count, how sharp a petal is and the centre's size. The
 * forget-me-not is three small flowers: each fragment takes the frame of the nearest one, 2.3 times smaller. The
 * hibiscus has its stamen.
 */
const FLOWERS = `
    case 0u: {
      var pn = array<f32, 8>(12.0, 6.0, 5.0, 13.0, 5.0, 4.0, 5.0, 5.0);
      var pk = array<f32, 8>(4.0, 0.6, 0.9, 1.3, 0.35, 0.8, 0.7, 0.5);
      var pb = array<f32, 8>(0.22, 0.34, 0.18, 0.42, 0.2, 0.18, 0.2, 0.2);
      var fq = q;
      var fs = 1.0;
      if (v == 4u) {
        var cc = vec2f(-0.42, 0.3);
        if (length(q - vec2f(0.42, 0.36)) < length(q - cc)) { cc = vec2f(0.42, 0.36); }
        if (length(q - vec2f(0.0, -0.4)) < length(q - cc)) { cc = vec2f(0.0, -0.4); }
        fs = 2.3;
        fq = (q - cc) * fs;
      }
      let fr = length(fq);
      let fa = atan2(fq.x, fq.y);
      let n = pn[v];
      let c = pb[v];
      let notch = select(0.0, 0.3 * pow(max(cos(fa * n), 0.0), 24.0), v == 5u || v == 6u);
      d = (fr - c - (0.95 - c) * pow(abs(cos(fa * n * 0.5)), pk[v]) + notch) * 0.6;
      if (((0xa5u >> v) & 1u) == 1u) { d = abs(d) - w * fs; }
      d = min(max(d, c * 0.85 - fr), abs(fr - c * 0.55) - w * fs) / fs;
      if (v == 7u) { d = min(d, tatSeg(q, vec2f(0.0), vec2f(0.3, 0.8)) - w); }
    }`

/**
 * Rays round a centre, folded into one sector: the compass rose (four long and four short points round a ring), the
 * four-point star, the comet (a head and three streaks behind it, never a single tapering tail, which reads as a
 * teardrop), the sunburst (eight short rays outside a disc, never reaching the edge), the snowflake, sparkles (three
 * four-point stars of falling size), the dandelion clock and the sea star (fat rounded arms, each with a row of pale
 * dots down it, so never a flat five-point star).
 */
const RAYS = `
    case 1u: {
      var rn = array<f32, 8>(8.0, 4.0, 5.0, 8.0, 6.0, 4.0, 18.0, 5.0);
      var ri = array<f32, 8>(0.16, 0.2, 0.4, 0.0, 0.0, 0.2, 0.0, 0.28);
      let n = rn[v];
      let sec = 6.2831853 / n;
      let t = (a + select(0.0, 0.45 * r, v == 7u)) / sec + 0.5;
      let k = floor(t);
      let sa = (t - k - 0.5) * sec;
      let p = r * vec2f(abs(sin(sa)), cos(sa));
      let odd = (u32(k + 64.0) & 1u) == 1u;
      let len = select(select(1.0, 0.72, v == 7u), 0.6, odd && v == 0u);
      let ed = normalize(ri[v] * vec2f(sin(sec * 0.5), cos(sec * 0.5)) - vec2f(0.0, len));
      let star = (p.y - len) * ed.x - p.x * ed.y;
      if (v == 0u) { d = min(select(abs(star) - w * 0.7, star, sa > 0.0), abs(r - 0.3) - w * 0.7); }
      else if (v == 7u) {
        d = max(star - 0.12, 0.03 - length(vec2f(p.x, p.y - clamp(round(p.y / 0.15) * 0.15, 0.3, 0.6))));
      }
      else if (v == 1u) { d = star; }
      else if (v == 2u) {
        d = length(q - vec2f(0.42)) - 0.25;
        for (var i = 0u; i < 3u; i++) {
          let th = 3.927 + (f32(i) - 1.0) * 0.3;
          d = min(d, tatSeg(q, vec2f(0.42), vec2f(0.42) + vec2f(sin(th), cos(th)) * select(1.05, 1.45, i == 1u)) - w * 1.1);
        }
      }
      else if (v == 3u) { d = min(r - 0.36, tatSeg(p, vec2f(0.0, 0.5), vec2f(0.0, 0.8)) - 0.07 * (1.0 - p.y)); }
      else if (v == 4u) { d = min(tatSeg(p, vec2f(0.0), vec2f(0.0, 0.95)), min(tatSeg(p, vec2f(0.0, 0.5), vec2f(0.22, 0.72)), tatSeg(p, vec2f(0.0, 0.25), vec2f(0.14, 0.4)))) - w; }
      else if (v == 5u) {
        var cs = array<vec3f, 3>(vec3f(-0.22, 0.18, 0.62), vec3f(0.5, -0.42, 0.38), vec3f(0.52, 0.56, 0.26));
        for (var i = 0u; i < 3u; i++) {
          let lq = (q - cs[i].xy) / cs[i].z;
          let lt = atan2(lq.x, lq.y) / sec + 0.5;
          let ls = (lt - floor(lt) - 0.5) * sec;
          let lp = length(lq) * vec2f(abs(sin(ls)), cos(ls));
          d = min(d, ((lp.y - 1.0) * ed.x - lp.x * ed.y) * cs[i].z);
        }
      }
      else { d = min(min(tatSeg(p, vec2f(0.0, 0.1), vec2f(0.0, 0.75)) - w * 0.5, length(p - vec2f(0.0, 0.82)) - 0.06), tatSeg(q, vec2f(0.0, -0.1), vec2f(0.12, -1.0)) - w); }
    }`

/**
 * Circles and orbits: the unit circle's half turn (a circle on its diameter, the two points where it meets it, an arc
 * above with an arrowhead: Euler's identity drawn, not written), the atom (three ellipses about a nucleus), a ringed
 * planet (one ellipse, its near half before the disc), orbits, the moon's phases (five discs), an eclipse (a disc, a
 * corona ring and a bead), ripples and a waxing crescent (never paired with a star). An ellipse's distance is its
 * implicit value over its gradient's length, half-axes 0.9 by 0.3.
 */
const ORBITS = `
    case 2u: {
      if (v == 0u) {
        d = min(min(abs(r - 0.62) - w * 0.8, tatSeg(q, vec2f(-0.95, 0.0), vec2f(0.95, 0.0)) - w * 0.5), min(length(q - vec2f(-0.62, 0.0)), length(q - vec2f(0.62, 0.0))) - 0.08);
        d = min(d, select(9.0, abs(r - 0.82) - w * 0.6, q.y > 0.0));
        d = min(d, min(tatSeg(q, vec2f(-0.82, 0.0), vec2f(-0.94, 0.14)), tatSeg(q, vec2f(-0.82, 0.0), vec2f(-0.68, 0.12))) - w * 0.6);
      } else if (v == 1u || v == 2u) {
        let turns = select(1u, 3u, v == 1u);
        d = select(r - 0.42, r - 0.12, v == 1u);
        for (var i = 0u; i < turns; i++) {
          let th = f32(i) * 1.0471976 - select(0.35, 0.0, v == 1u);
          let p = vec2f(q.x * cos(th) - q.y * sin(th), q.x * sin(th) + q.y * cos(th));
          let g = length(vec2f(p.x / 0.81, p.y / 0.09));
          let el = (length(vec2f(p.x / 0.9, p.y / 0.3)) - 1.0) / max(g / max(length(vec2f(p.x / 0.9, p.y / 0.3)), 0.001), 0.001);
          if (v == 2u) { d = select(max(d, 2.5 * w - abs(el)), d, p.y > 0.0 && r < 0.42); d = min(d, select(abs(el) - w, 9.0, p.y > 0.0 && r < 0.42)); }
          else { d = min(d, abs(el) - w * 0.7); }
        }
      } else if (v == 3u) {
        d = min(min(r - 0.13, abs(r - 0.45) - w * 0.5), min(abs(r - 0.85) - w * 0.5, min(length(q - vec2f(-0.35, 0.28)) - 0.09, length(q - vec2f(0.6, -0.6)) - 0.11)));
      } else if (v == 4u) {
        let i = clamp(round(q.x / 0.38), -2.0, 2.0);
        let c = q - vec2f(i * 0.38, 0.0);
        d = min(abs(length(c) - 0.15) - w * 0.5, max(length(c) - 0.15, 0.15 - length(c + vec2f(i * 0.11, 0.0))));
      } else if (v == 5u) {
        d = min(min(r - 0.46, abs(r - 0.64) - w * 0.5), length(q - vec2f(0.4525, 0.4525)) - 0.1);
      } else if (v == 6u) {
        let re = length(vec2f(q.x, q.y * 2.6));
        d = max(abs(re * 3.5 - floor(re * 3.5 + 0.5)) / 3.5 - w * (1.15 - re * 0.8), re - 0.95) * 0.6;
        d = min(d, tatSeg(q, vec2f(0.0, 0.2), vec2f(0.0, 0.62)) - w * 0.9);
      } else {
        d = max(r - 0.8, 0.7 - length(q - vec2f(0.34, 0.14)));
      }
    }`

/**
 * Shapes drawn by their edges, folded into one sector: a bold triangle, nested triangles (concentric, pointing up), a
 * bold diamond, nested diamonds, a pentagon, a flat-topped bold hexagon, an isometric cube (a hexagon with three
 * spokes) and the honeycomb: hexagonal cells 0.24 across, each fragment in the nearer of two lattices' cells, cut to
 * a hexagon.
 */
const SHAPES = `
    case 3u: {
      var gn = array<f32, 8>(3.0, 3.0, 4.0, 4.0, 5.0, 6.0, 6.0, 6.0);
      var gr = array<u32, 8>(1u, 2u, 1u, 3u, 1u, 1u, 1u, 0u);
      let n = gn[v];
      let sec = 6.2831853 / n;
      let t = a / sec + select(0.0, 0.5, v == 5u);
      let one = v == 0u || v == 2u || v == 5u;
      let sa = (t - floor(t) - 0.5) * sec;
      for (var i = 0u; i < gr[v]; i++) {
        d = min(d, abs(r * cos(sa) - (select(0.48, 0.4, one) - f32(i) * 0.17) * select(1.0, 1.25, n > 3.5)) - select(w, w * 1.6, one));
      }
      if (v == 6u) {
        d = min(d, min(tatSeg(q, vec2f(0.0), vec2f(0.0, -0.6)), min(tatSeg(q, vec2f(0.0), vec2f(0.52, 0.3)), tatSeg(q, vec2f(0.0), vec2f(-0.52, 0.3)))) - w);
      }
      if (v == 7u) {
        let s = vec2f(0.32, 0.5543);
        let g1 = q - s * floor(q / s + 0.5);
        let g2 = q - s * (floor((q - s * 0.5) / s + 0.5) + 0.5);
        let g = select(g2, g1, dot(g1, g1) < dot(g2, g2));
        let h = abs(g);
        let aq = abs(q);
        d = max(abs(max(h.x, h.x * 0.5 + h.y * 0.866) - 0.16) - w * 0.6, max(aq.x, aq.x * 0.5 + aq.y * 0.866) - 0.85);
      }
    }`

/**
 * Bands round the limb and fields over it, periodic across the square, so a band repeated round the limb meets
 * itself: the braided rope band (two strands of a sine, crossing), the scalloped arc band, the soundwave band, the
 * ocean wave band, the circuit trace and the star chart (each cell of a 4 by 4 grid hashed: a trace from the cell's
 * centre to one edge's midpoint and a pad on some, or a star and a line to the next cell's), the heartbeat line (its
 * one period from the point table) and the double helix. The two fields break at every cell's edge by design.
 */
const BANDS = `
    case 4u: {
      let s = q.x * 2.0;
      let ph = s - floor(s);
      if (v == 0u) {
        let y = 0.22 * sin(6.2831853 * s);
        let sl = 2.764 * cos(6.2831853 * s);
        let g = sqrt(1.0 + sl * sl);
        d = max(min(abs(q.y - y), abs(q.y + y)) / g - 0.075, abs(q.y) - 0.34);
      } else if (v == 1u) {
        let c = vec2f((ph - 0.5) * 0.5, q.y + 0.25);
        let rr = length(c);
        d = max(abs(rr * 12.0 - floor(rr * 12.0 + 0.5)) / 12.0 - w * 0.6, max(-c.y, rr - 0.26));
      } else if (v == 2u) {
        let i = floor(q.x * 8.0);
        let hgt = 0.12 + 0.62 * abs(sin(i * 1.7) * sin(i * 0.37 + 1.0));
        d = max(abs(q.x * 8.0 - i - 0.5) / 8.0 - 0.034, abs(q.y) - hgt * 0.5);
      } else if (v == 3u) {
        let y = 0.16 * sin(6.2831853 * s);
        let sl = 2.01 * cos(6.2831853 * s);
        d = min(abs(q.y - y) / sqrt(1.0 + sl * sl) - w, abs(q.y + 0.24 - 0.1 * sin(6.2831853 * s + 1.2)) - w * 0.6);
        d = min(d, length(vec2f((ph - 0.5) * 0.5, q.y - 0.3)) - 0.05);
      } else if (v == 4u || v == 5u) {
        let cell = floor((q + 1.0) * 4.0);
        let lp = (q + 1.0) * 4.0 - cell - 0.5;
        let h1 = crowdHash(cell.x * 7.0 + cell.y * 113.0 + 1000.0);
        let h2 = crowdHash(cell.x * 7.0 + cell.y * 113.0 + 2000.0);
        if (v == 4u) {
          let dir = u32(h1 * 3.999);
          let to = select(select(vec2f(0.0, 0.5), vec2f(0.0, -0.5), dir == 1u), select(vec2f(0.5, 0.0), vec2f(-0.5, 0.0), dir == 3u), dir >= 2u);
          d = min(tatSeg(lp, vec2f(0.0), to) * 0.25 - w * 0.5, select(9.0, abs(length(lp) - 0.16) * 0.25 - w * 0.4, h2 > 0.6));
        } else {
          let st = vec2f(h1, h2) * 0.6 - 0.3;
          let nx = vec2f(crowdHash(cell.x * 7.0 + cell.y * 113.0 + 1007.0), crowdHash(cell.x * 7.0 + cell.y * 113.0 + 2007.0)) * 0.6 - 0.3 + vec2f(1.0, 0.0);
          d = min(length(lp - st) * 0.25 - 0.012 - 0.03 * h2, select(9.0, tatSeg(lp, st, nx) * 0.25 - w * 0.35, h1 > 0.55));
        }
      } else if (v == 6u) {
        d = tatPoly(vec2f(ph * 2.0 - 1.0, q.y * 1.4), ${TATTOO_POINT_STARTS[TATTOO_PICTURES.length]}u, ${TATTOO_POINT_STARTS[TATTOO_PICTURES.length + 1]}u) / 1.4 - w * 0.8;
      } else {
        let y = 0.3 * sin(6.2831853 * ph);
        d = min(abs(abs(q.y) - abs(y)) - w * 0.8, max(abs(ph * 6.0 - floor(ph * 6.0) - 0.5) / 12.0 - w * 0.5, abs(q.y) - abs(y)));
      }
    }`

/**
 * Spirals, each to its outer end at r 0.9: logarithmic (a growth `sb` a radian: the golden one, the nautilus shell,
 * the spiral galaxy, the ammonite, the storm spiral, the snail shell) or even (sb 0: Archimedes', the rope coil), one
 * arm or two (the galaxy and the storm: never three), over `sk` + 1 turns. The nearest turn is found by rounding, so
 * the distance is the radial gap to it. The shells add their chambers or ribs, the snail its foot, the rope its
 * twist, the galaxy its core.
 */
const SPIRALS = `
    case 5u: {
      var sb = array<f32, 8>(0.3063, 0.2, 0.3, 0.0, 0.22, 0.5, 0.25, 0.0);
      var sk = array<f32, 8>(2.0, 3.0, 2.0, 3.0, 3.0, 0.0, 2.0, 2.0);
      var qq = q;
      if (v == 0u) { qq = q - vec2f(-0.12, 0.08); }
      if (v == 6u) { qq = q - vec2f(0.0, 0.2); }
      let rr = length(qq);
      let arms = select(1.0, 2.0, v == 2u || v == 5u);
      let per = 6.2831853 / arms;
      let th0 = atan2(qq.x, qq.y) + 3.1415927;
      let th = th0 - per * floor(th0 / per);
      let b = sb[v];
      let kmax = sk[v];
      var rs = 0.0;
      if (b > 0.0) {
        let a0 = 0.9 * exp(-b * per * (kmax + 1.0));
        let k = clamp(round((log(max(rr, 0.001) / a0) / b - th) / per), 0.0, kmax);
        rs = a0 * exp(b * (th + per * k));
      } else {
        let c = 0.9 / (6.2831853 * (kmax + 1.0));
        let k = clamp(round((rr / c - th) / 6.2831853), 0.0, kmax);
        rs = c * (th + 6.2831853 * k);
      }
      d = abs(rr - rs) * 0.9 - select(w, w * 2.2, v == 7u) * select(1.0, 1.8 - rr * 1.5, v == 2u || v == 5u);
      if (v == 1u) { d = min(d, max(abs(sin(th * 6.0 - log(max(rr, 0.001)) * 1.5)) * rr * 0.17 - w * 0.5, rr - rs)); }
      if (v == 4u) { d = min(d, max(abs(sin(th * 16.0)) * rr * 0.08 - w * 0.4, abs(rr - rs * 0.85) - rs * 0.13)); }
      if (v == 5u) { d = max(min(d, abs(rr - 0.22) - w * 1.4), 0.12 - rr); }
      if (v == 6u) { d = min(d, min(tatSeg(q, vec2f(-0.9, -0.8), vec2f(0.75, -0.8)), tatSeg(q, vec2f(0.75, -0.8), vec2f(0.95, -0.4))) - w); }
      if (v == 7u) { d = max(d, (0.25 - abs(sin(th * 10.0 + rr * 30.0))) * 0.05); }
      if (v == 2u) { d = min(d, rr - 0.1); }
    }`

/**
 * Sprigs: a stem bending a little, leaves along it, alternate or in pairs, drawn or filled, tapering to the tip for
 * the fern and the pine; the per-variant rows are a leaf's half-length, its half-width, its angle off the stem and
 * the leaf count. Each fragment tests the two nearest leaf positions on each side.
 */
const SPRIGS = `
    case 6u: {
      var lb = array<f32, 8>(0.24, 0.26, 0.2, 0.15, 0.13, 0.15, 0.32, 0.1);
      var lh = array<f32, 8>(0.07, 0.11, 0.06, 0.045, 0.11, 0.075, 0.0, 0.075);
      var la = array<f32, 8>(0.9, 1.1, 0.7, 1.25, 1.2, 0.4, 0.95, 0.8);
      var ln = array<f32, 8>(6.0, 7.0, 7.0, 12.0, 6.0, 7.0, 12.0, 11.0);
      let n = ln[v];
      let y0 = select(select(-0.65, -0.05, v == 5u), 0.15, v == 7u);
      let gap = (0.85 - y0) / n;
      let bend = select(select(0.08, 0.3, v == 7u), 0.22, v == 1u);
      let sx = bend * sin(q.y * 2.5);
      d = select(abs(q.x - sx) - w * 0.8, 9.0, q.y > 0.95 || q.y < -0.95);
      let pairs = v == 2u || v == 3u || v == 5u || v == 6u;
      let j = clamp(floor((q.y - y0) / gap), 0.0, n - 1.0);
      for (var o = 0.0; o < 2.0; o += 1.0) {
        let i = clamp(j + o, 0.0, n - 1.0);
        let by = y0 + i * gap;
        let base = vec2f(bend * sin(by * 2.5), by);
        let taper = select(1.0, 1.0 - i / (n * 1.5), v == 3u || v == 6u);
        for (var side = -1.0; side <= 1.0; side += 2.0) {
          let alt = select(1.0, select(-1.0, 1.0, (u32(i) & 1u) == 0u), !pairs);
          if (!pairs && side != alt) { continue; }
          let th = la[v] * side;
          let p = q - base;
          let lp = vec2f(p.x * cos(th) - p.y * sin(th), p.x * sin(th) + p.y * cos(th));
          var leaf = 9.0;
          if (v == 6u) { leaf = tatSeg(lp, vec2f(0.0), vec2f(0.0, lb[v] * taper)) - w * 0.5; }
          else { leaf = tatLeaf(lp, lb[v] * taper, lh[v] * taper); }
          if (v == 0u || v == 1u || v == 4u) { leaf = abs(leaf) - w * 0.6; }
          d = min(d, leaf);
        }
      }
    }`

/** Pictures: one polyline each from the point table, picture v from start v to start v + 1 (two 16-bit starts a word). */
const PICTURES = `
    default: {
      var st = array<u32, ${TATTOO_POINT_STARTS_PACKED.length}>(${TATTOO_POINT_STARTS_PACKED.map(hex).join(', ')});
      d = tatPoly(q, (st[v >> 1u] >> ((v & 1u) * 16u)) & 65535u, (st[(v + 1u) >> 1u] >> (((v + 1u) & 1u) * 16u)) & 65535u) - w;
    }`

/**
 * The signed distance (ink below zero) of the design whose table byte is e (family << 5 | variant << 2 | tile) at q
 * in its square, -1 to 1 each way, y up. One switch over the eight families; within a family the variants are told
 * apart by rows of numbers. `w` is the drawn line's half-width.
 */
const TAT_SHAPE = `
fn tatShape(q: vec2f, e: u32) -> f32 {
  let fam = e >> 5u;
  let v = (e >> 2u) & 7u;
  let r = length(q);
  let a = atan2(q.x, q.y);
  let w = 0.045;
  var d = 9.0;
  switch (fam) {${FLOWERS}${RAYS}${ORBITS}${SHAPES}${BANDS}${SPIRALS}${SPRIGS}${PICTURES}
  }
  return d;
}`

/**
 * The street's draw for a person (look.ts streetTattoos is its CPU mirror): 0 for four people in five, else the set
 * of zones (bit z for zone z) they wear ink on, one of tattoo.ts TATTOO_STREET_SETS (a byte each, four to a word), by
 * look.ts's pick (the link times the count less a thousandth, bounded to the last).
 */
const TAT_ZONES = `
fn tatZones(seed: f32) -> u32 {
  if (crowdHash(seed + ${link(LOOK_HASHED_COLOUR.tattoo)}) < ${lit(LOOK_ODDS.tattoo)}) { return 0u; }
  var sets = array<u32, ${TATTOO_STREET_SETS_PACKED.length}>(${TATTOO_STREET_SETS_PACKED.map(bytes).join(', ')});
  let pick = min(u32(crowdHash(seed + ${link(LOOK_HASHED_COLOUR.tattooZones)}) * ${lit(TATTOO_STREET_SETS.length - 0.001)}), ${TATTOO_STREET_SETS.length - 1}u);
  return (sets[pick >> 2u] >> ((pick & 3u) * 8u)) & 255u;
}`

/** The street's inks from the ink link, rarest last (look.ts LOOK_ODDS: each from its threshold up), black below them all. */
const STREET_INKS: readonly (readonly [ink: number, edge: number])[] = [
  [TATTOO_INK.greyWash, LOOK_ODDS.inkGrey], [TATTOO_INK.indigo, LOOK_ODDS.inkIndigo], [TATTOO_INK.brickRed, LOOK_ODDS.inkRed],
  [TATTOO_INK.forestGreen, LOOK_ODDS.inkGreen], [TATTOO_INK.white, LOOK_ODDS.inkWhite],
]
const streetInk = STREET_INKS.reduce((below, [ink, edge]) => `select(${below}, ${ink}u, hi >= ${lit(edge)})`, `${TATTOO_INK.black}u`)

/**
 * The street's design on zone z (0 for none) with its ink above bit 8. The set's first zone takes its design from one
 * link and the second zone from another; the designs are the ones after the studio's lines (never a studio design) and
 * the inks never the studio's gold leaf or luminescent. Split from tatZones so the CPU mirror test can call it.
 */
const TAT_STREET = `
fn tatStreet(seed: f32, z: u32) -> u32 {
  let zs = tatZones(seed);
  if (((zs >> z) & 1u) == 0u) { return 0u; }
  let second = (zs & ((1u << z) - 1u)) != 0u;
  let hi = crowdHash(seed + ${link(LOOK_HASHED_COLOUR.tattooInk)});
  let ink = ${streetInk};
  return ${TATTOO_STUDIO_LINES + 1}u + min(u32(crowdHash(seed + select(${link(LOOK_HASHED_COLOUR.tattooFirst)}, ${link(LOOK_HASHED_COLOUR.tattooSecond)}, second)) * ${lit(STREET_DESIGNS - 0.001)}), ${STREET_DESIGNS - 1}u) + (ink << 8u);
}`

/** The case of the zone pick for a zone's bone (the head's two zones share one case, below). */
const boneCase = (z: number): string => `
      case ${TATTOO_ZONES[z].bone}u: { z = ${z}u; }`
const vec4 = (...n: number[]): string => `vec4f(${n.map(f).join(', ')})`
const vec3 = (n: readonly number[]): string => `vec3f(${n.map(f).join(', ')})`
const { mix: INK_MIX, luminance: LUM, contrast: CONTRAST, white: WHITE, black: BLACK, split: SPLIT, width: HALO_WIDTH } = TATTOO_HALO

/**
 * The tattoo on one fragment: the skin (as toned, marked and aged; never written back), the rest position, the bone
 * and the slot (rig.x and the flat slot: a caller passes SKIN's slot for skin a rolled sleeve or a bare leg shows),
 * genome words 7 and 8 (word 7 with its street bit set for a person who wears no chosen look), the seed and a
 * pixel's width on the rest body (crowd.ts footprint, a derivative read at the top of the stage, so nothing here takes
 * one). It returns the colour and the ink's coverage in w.
 *
 * In order: the zone by bone, on skin only (the hands; the head's skin below 1.62 is the nape at or behind its z and
 * otherwise the neck below the chin ring; the forearms; the calf and the ankle). The design and the ink: the look's
 * fields (seven bits a zone, four zones a word; the ink in word 7) or tatStreet. The design's byte from the table, four
 * to a word. The zone's frame: a single design or a sequence is mapped flat on the hands' front face (their back face
 * draws none) or by arc length round a cylinder elsewhere, and a fragment outside the square returns; a sequence
 * repeats two or three times up the zone, staggered; a single design is inset (TATTOO_INSET). A band round the limb
 * repeats a whole number of times round it (the hands' round the wrist), and its pixel size takes the wrap's stretch.
 * The fade: full until a pixel is 0.15 of a design unit, gone at 0.4, so far off nothing is drawn, not even a tint.
 * The coverage is one pixel of soft edge on the distance.
 *
 * The ink: the line is the skin mixed most of the way to the ink. Where it would not stand out from the skin by 3:1
 * (WCAG's ratio for graphics, on the albedo's relative luminance), a halo just outside the line takes the skin toward
 * a warm white (for a dark line) or a brown-black (for a light one: past the luminance where white and black contrast
 * with it alike) just far enough that the line stands out from the halo by 3:1. Luminance is linear in linear
 * colour, so the halo lands on the ratio, and both poles lie past every skin tone, so it always gets there.
 */
const TATTOO = `
fn tattoo(skin: vec3f, rest: vec3f, bone: f32, slot: f32, w7: u32, w8: u32, seed: f32, px: f32) -> vec4f {
  var z = ${NO_ZONE}u;
  if (u32(slot + 0.5) == ${SLOT.SKIN}u) {
    switch (u32(bone + 0.5)) {${boneCase(0)}${boneCase(1)}
      case ${TATTOO_ZONES[2].bone}u: { if (rest.y < ${f(TATTOO_HEAD_SPLIT.top)}) { z = select(select(${NO_ZONE}u, 2u, rest.y < ${f(TATTOO_HEAD_SPLIT.neckTop)}), 3u, rest.z <= ${f(TATTOO_HEAD_SPLIT.napeZ)}); } }${boneCase(4)}${boneCase(5)}${boneCase(6)}${boneCase(7)}
      default: { }
    }
  }
  if (z == ${NO_ZONE}u) { return vec4f(skin, 0.0); }
  var m = 0u;
  var ink = 0u;
  if ((w7 >> ${LOOK_STREET_FLAG.bit}u) == 0u) {
    m = select(w8 >> ((z - ${ZONES_A_WORD}u) * ${ZONE_BITS}u), w7 >> (z * ${ZONE_BITS}u), z < ${ZONES_A_WORD}u) & ${(1 << ZONE_BITS) - 1}u;
    ink = (w7 >> ${LOOK_FIELD.tattooInk[1]}u) & ${(1 << LOOK_FIELD.tattooInk[2]) - 1}u;
  } else {
    let st = tatStreet(seed, z);
    m = st & 255u;
    ink = st >> 8u;
  }
  if (m == 0u || m > ${TATTOO_MOTIFS.length}u) { return vec4f(skin, 0.0); }
  var tab = array<u32, ${TATTOO_MOTIF_PACKED.length}>(${TATTOO_MOTIF_PACKED.map(hex).join(', ')});
  let e = (tab[(m - 1u) >> 2u] >> (((m - 1u) & 3u) * 8u)) & 255u;
  let tile = e & 3u;
  var fr = array<vec4f, ${TATTOO_FRAMES.length}>(${TATTOO_FRAMES.map((fz) => vec4(fz.axisX, fz.centreY, fz.angle, fz.half)).join(', ')});
  var rad = array<f32, ${TATTOO_FRAMES.length}>(${TATTOO_FRAMES.map((fz) => f(fz.radius)).join(', ')});
  var reps = array<f32, ${TATTOO_FRAMES.length}>(${TATTOO_FRAMES.map((fz) => f(fz.reps)).join(', ')});
  let fz = fr[z];
  let ang = atan2(rest.x - fz.x, rest.z);
  var q = vec2f(0.0);
  var pq = px / fz.w;
  if (tile == ${TATTOO_TILE.wrap}u) {
    let u = (ang / 6.2831853 + 0.5) * reps[z];
    q = vec2f((u - floor(u)) * 2.0 - 1.0, (rest.y - select(fz.y, ${f(TATTOO_FRAMES[0].wrapY)}, z < ${PLANAR}u)) / fz.w);
    pq = px * max(reps[z] / (3.1415927 * max(rad[z], 0.03)), 1.0 / fz.w);
    if (abs(q.y) > 1.0) { return vec4f(skin, 0.0); }
  } else {
    let da = ang - fz.z - 6.2831853 * floor((ang - fz.z + 3.1415927) / 6.2831853);
    q = select(vec2f(da * rad[z], rest.y - fz.y), rest.xy - fz.xy, z < ${PLANAR}u) / fz.w;
    if ((z < ${PLANAR}u && rest.z < 0.0) || max(abs(q.x), abs(q.y)) > 1.0) { return vec4f(skin, 0.0); }
    if (tile != ${TATTOO_TILE.one}u) {
      let k = f32(tile + 1u);
      let cy = floor((q.y + 1.0) * 0.5 * k);
      q = vec2f(q.x * k + select(-0.35, 0.35, (u32(cy) & 1u) == 1u) * (k - 1.0), ((q.y + 1.0) * 0.5 * k - cy) * 2.0 - 1.0);
      pq = pq * k;
    }
    q = q * ${f(TATTOO_INSET)};
    pq = pq * ${f(TATTOO_INSET)};
  }
  let fade = clamp(1.6 - 4.0 * pq, 0.0, 1.0);
  if (fade <= 0.0) { return vec4f(skin, 0.0); }
  let dist = tatShape(q, e);
  let cov = clamp(0.5 - dist / pq, 0.0, 1.0) * fade;
  var inks = array<vec3f, ${TATTOO_INKS.length}>(${TATTOO_INKS.map((i) => vec3(i.rgb)).join(', ')});
  let line = mix(skin, inks[ink], ${f(INK_MIX)});
  let lum = ${vec3(LUM)};
  let li = dot(line, lum);
  let ls = dot(skin, lum);
  let lite = li > ${f(SPLIT)};
  let toward = select(${vec3(WHITE)}, ${vec3(BLACK)}, lite);
  let need = select(${f(CONTRAST)} * li + ${lit((CONTRAST - 1) * 0.05)}, (li + 0.05) / ${f(CONTRAST)} - 0.05, lite);
  let t = select(clamp((need - ls) / (dot(toward, lum) - ls), 0.0, 1.0), 0.0, max(li, ls) + 0.05 >= ${f(CONTRAST)} * (min(li, ls) + 0.05));
  let halo = clamp(0.5 - (dist - ${f(HALO_WIDTH)}) / pq, 0.0, 1.0) * fade;
  return vec4f(mix(mix(skin, mix(skin, toward, t), halo), line, cov), cov);
}`

/**
 * WGSL needs no space round its operators and punctuation: the text is collapsed to single spaces, then those beside
 * a symbol go. (No line here has `- -`, which this would close up into a decrement: tattoo.test.ts checks for `--`.)
 */
const squeeze = (src: string): string => src
  .replace(/\s+/g, ' ')
  .replace(/ ?([{}()[\],;:=+*/<>&|!?^%]) ?/g, '$1')
  .replace(/ ?- ?/g, '-')
  .trim()

/** The functions by name, in the order a reader meets their calls bottom up; each its own wgslFn. */
const FUNCTIONS: ReadonlyMap<string, string> = new Map([
  ['tatSeg', TAT_SEG], ['tatLeaf', TAT_LEAF], ['tatPoly', TAT_POLY], ['tatShape', TAT_SHAPE],
  ['tatZones', TAT_ZONES], ['tatStreet', TAT_STREET], ['tattoo', TATTOO],
].map(([name, src]) => [name, squeeze(src)]))

/**
 * The module's WGSL as three writes it into the stage (crowdBody.ts crowdHash, which it calls, comes before it from
 * its own wgslFn): what tattoo.test.ts runs through wgslHost.ts.
 */
export const TATTOO_WGSL: string = [...FUNCTIONS.values()].join('')

/**
 * Which functions each function calls (its wgslFn includes, so three writes each once per shader, crowdHash among the
 * crowd's own). A call the table misses would build in Node and fail only when a GPU compiles the module:
 * tattoo.test.ts checks every `tatX(` and `crowdHash(` in the text against this table, transitively.
 */
export const TATTOO_INCLUDES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  tatPoly: Object.freeze(['tatSeg']),
  tatShape: Object.freeze(['crowdHash', 'tatSeg', 'tatLeaf', 'tatPoly']),
  tatZones: Object.freeze(['crowdHash']),
  tatStreet: Object.freeze(['crowdHash', 'tatZones']),
  tattoo: Object.freeze(['tatStreet', 'tatShape']),
})

type Includes = Parameters<typeof wgslFn>[1]
const built = new Map<string, ReturnType<typeof wgslFn>>([['crowdHash', crowdHash]])
/** The TSL function of a WGSL `fn`, its includes built first from the table (each once; crowdHash is crowdBody.ts's). */
const fn = (name: string): ReturnType<typeof wgslFn> => {
  const have = built.get(name)
  if (have) return have
  const includes = (TATTOO_INCLUDES[name] ?? []).map(fn)
  const made = wgslFn(FUNCTIONS.get(name)!, includes as Includes)
  built.set(name, made)
  return made
}

/** The near body's tattoo: tattoo(skin, rest, bone, slot, w7, w8, seed, px) → (colour, coverage). */
export const tattoo = fn('tattoo')
