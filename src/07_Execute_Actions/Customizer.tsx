// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the wardrobe's card (Track A of the character customizer), in two tabs. "You": the
 * player's own look, slot by slot, out of the crowd's closed business-casual catalogue (03_Spawn_Agents/look.ts).
 * The eight body sliders (height in metres, mass, muscle, shoulders, hips, legs, posture, head) are range inputs
 * over a silhouette, front and side, drawn from the very rings the GPU lofts the body from (humanoid.ts), with the
 * look's own colours; the seven face sliders (brow, jaw, chin, cheekbones, nose, eyes, lips) and the age are range
 * inputs over a face view, front and profile, drawn from the head's rings the same way with the face sliders
 * applied; every other slot is a row of the options look.ts allows for the body chosen — named options
 * as a segmented control, colours as swatches drawn from the crowd's own palettes — except the tattoos, one section
 * of a zone, a design family, a design and the ink (tattoo.ts's tables, so sixty-five designs are never one row) —
 * with the eight presets, a
 * "randomise" that asks lookFromSeed for the look the hash would give some other number, a reset to the look the
 * visitor's own seed gives, and the short shareable code (formatLookCode / parseLookCode, checksummed) to write down
 * or paste. Every change is worn at once: the host writes it to the player's body (engine.setLook) and keeps it
 * (lookStore.ts). "Agents": the player's own agents (08_Swarm/roster.ts), one tab each: a name, pronouns, a role in
 * the player's words, a voice (one of the twelve profiles, or a voice the speech provider knows), and the same
 * wardrobe for their look, worn by the pedestrian hired as them the moment it changes; hiring itself is the
 * console's (agent hire <name> <skill>), so the card never reaches the swarm. There is no mirror by design: the
 * first-person eye never sees its own body, so the card previews with the silhouette and swatches alone; the
 * shadow, the body the cull draws and every other viewer see the look. Sloane's chip opens it; Esc, the close button
 * or Done puts it away.
 * What breaks if it is removed? The player can only change their look or their agents by typing at the console, and
 * nothing shows them what the wardrobe holds.
 */
import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { PIECE, SLOT, faceRings, silhouetteRings, type SilhouetteRing } from '../03_Spawn_Agents/humanoid.ts'
import {
  FRAME_FINISH, LAYER, LOOK_BODY_SLIDERS, LOOK_BUILDS, LOOK_FACE_SHAPES, LOOK_FACE_SLIDERS, LOOK_GARMENTS, LOOK_PRESETS, LOOK_SLOTS, bodyShapeOf, buildOf, faceShapeNameOf, faceShapeOf,
  LOOK_LOWER_GARMENTS, formatLookCode, garmentOf, lookFromSeed, lookOptions, lookSwatch, lookWears, lowerGarmentFits, lowerGarmentOf, matchingSwatch, parseLookCode,
  tattooCover, withBuild, withFaceShape, withGarment, withLookSlot,
  type Look, type LookBody, type LookFaceSlider, type LookSlider, type LookSlot,
} from '../03_Spawn_Agents/look.ts'
import { TATTOO_BY_FAMILY, TATTOO_FAMILIES, TATTOO_MOTIFS, TATTOO_ZONES } from '../03_Spawn_Agents/tattoo.ts'
import { seedFromName } from '../05_Observe_Environment/profile.ts'
import { PRONOUNS, ROSTER_MAX, VOICE_PROFILES, voiceProfile, type AgentIdentity, type Roster } from '../08_Swarm/roster.ts'

export interface CustomizerProps {
  /** Show the card (the host passes false while the boot veil covers the page or the terminal is open). */
  visible: boolean
  /** The look worn now, or null while the hash dresses the player (the card then starts from `seed`'s look). */
  look: Look | null
  /** The visitor's own seed (profile.ts): the look it gives is the card's starting point and what Reset returns to. */
  seed: number
  /** Called with every change; the host wears it at once and keeps it. */
  onChange(look: Look): void
  onClose(): void
  /** Optional: the HUD's night glass (snapshot.customer.daylight < 0.35). */
  dark?: boolean
  /** Optional: the player's own agents, and the roster that keeps them (the host re-renders on its changes). */
  agents?: readonly AgentIdentity[]
  roster?: Roster
  /** Optional: an agent's look changed (null: as the hash dresses them); the host wears it on their pedestrian. */
  onAgentLook?(name: string, look: Look | null): void
  /** Optional: say a line in an agent's voice (a profile or a provider voice), for the Hear button. */
  onHear?(voice: string, line: string): void
}

/** What each slot is called on the card, by body where the cloth differs (and the top by its layer: a coat's dye is the coat). */
function slotLabel(slot: LookSlot, body: LookBody, layer: number = LAYER.jacket): string {
  switch (slot) {
    case 'body': return 'Body'
    case 'height': return 'Height'
    case 'mass': return 'Mass'
    case 'muscle': return 'Muscle'
    case 'shoulders': return 'Shoulders'
    case 'hips': return 'Hips'
    case 'legs': return 'Legs'
    case 'posture': return 'Posture'
    case 'head': return 'Head'
    case 'brow': return 'Brow'
    case 'jaw': return 'Jaw'
    case 'chin': return 'Chin'
    case 'cheek': return 'Cheekbones'
    case 'nose': return 'Nose'
    case 'eyes': return 'Eyes'
    case 'lips': return 'Lips'
    case 'skin': return 'Skin'
    case 'age': return 'Age'
    case 'undertone': return 'Undertone'
    case 'vitiligo': return 'Vitiligo'
    case 'freckles': return 'Freckles'
    case 'hairStyle': return 'Hair'
    case 'curl': return 'Curl pattern'
    case 'hairColour': return 'Hair colour'
    case 'headwear': return 'Headwear'
    case 'headwearColour': return 'Headwear colour'
    case 'facialHair': return 'Facial hair'
    case 'hearing': return 'Hearing devices'
    case 'prosthetic': return 'Prosthetic'
    case 'prostheticFinish': return 'Prosthetic finish'
    case 'layer': return 'Layer'
    case 'cut': return layer === LAYER.coat ? 'Coat\'s cut' : 'Cut'
    case 'top': return layer === LAYER.coat ? 'Coat' : body === 1 ? 'Blazer' : body === 3 ? 'Top' : 'Jacket'
    case 'topWeave': return layer === LAYER.coat ? 'Coat\'s weave' : 'Weave'
    case 'trim': return 'Trim'
    case 'bottomCut': return body === 3 ? 'Skirt\'s cut' : body === 1 ? 'Chinos\' cut' : 'Trousers\' cut'
    case 'bottom': return body === 3 ? 'Skirt' : body === 1 ? 'Chinos' : 'Trousers'
    case 'bottomWeave': return body === 3 ? 'Skirt\'s weave' : 'Trousers\' weave'
    case 'shirt': return body >= 2 ? 'Blouse' : 'Shirt'
    case 'footwear': return 'Shoe style'
    case 'shoes': return 'Shoe colour'
    case 'tie': return 'Tie'
    case 'scarf': return 'Scarf'
    case 'lapelPin': return 'Lapel pin'
    case 'eyewear': return 'Glasses'
    case 'frames': return 'Frames'
    case 'watch': return 'Watch'
    case 'bag': return 'Bag'
    case 'cup': return 'Cup'
    // The tattoo zones by the person's own side (tattoo.ts TATTOO_ZONES' labels), and the one ink of them all.
    case 'tattooHand': return 'Left hand'
    case 'tattooHandR': return 'Right hand'
    case 'tattooNeck': return 'Neck'
    case 'tattooNape': return 'Nape'
    case 'tattooInk': return 'Ink'
    case 'tattooForearm': return 'Left forearm'
    case 'tattooForearmR': return 'Right forearm'
    case 'sleeves': return 'Sleeves'
  }
}

const isBodySlider = (slot: LookSlot): slot is LookSlider => (LOOK_BODY_SLIDERS as readonly string[]).includes(slot)
const isFaceSlider = (slot: LookSlot): slot is LookFaceSlider => (LOOK_FACE_SLIDERS as readonly string[]).includes(slot)
/** The slots shown as a range input: the body sliders, the face sliders and the age. */
const isSlider = (slot: LookSlot): boolean => isBodySlider(slot) || isFaceSlider(slot) || slot === 'age'

/** A number for lookFromSeed that nobody chose: a fresh look out of the same wardrobe on every press. */
const randomSeed = (): number => {
  const out = new Uint32Array(1)
  try { crypto.getRandomValues(out) } catch { out[0] = Math.floor(Math.random() * 0x100000000) }
  return out[0]
}

const hex6 = (n: number) => `#${n.toString(16).padStart(6, '0')}`

/** The card's glass, by daylight. */
interface Theme { muted: string; rule: string; pill: string; pillOn: string; ring: string; field: string; primary: string }

function themeOf(dark: boolean): Theme {
  return {
    muted: dark ? 'text-slate-300/80' : 'text-slate-500',
    rule: dark ? 'border-white/10' : 'border-slate-900/10',
    pill: dark ? 'border-white/15 bg-white/10 hover:bg-white/20' : 'border-slate-900/15 bg-white/60 hover:bg-white',
    pillOn: dark ? 'border-white bg-white text-slate-900' : 'border-slate-900 bg-slate-900 text-white',
    ring: dark ? 'ring-white' : 'ring-slate-900',
    field: dark
      ? 'border-white/15 bg-slate-950/40 text-slate-50 placeholder:text-slate-400 focus:border-white/40'
      : 'border-slate-900/15 bg-white/85 text-slate-900 placeholder:text-slate-400 focus:border-slate-900/40',
    primary: dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white',
  }
}

// --- The silhouette ---------------------------------------------------------------------------------------------

/**
 * What paints each slot of the silhouette: the look's own colour where it holds one; where the shader hashes it (the
 * tie's cloth, the bag's leather, the hose) a quiet neutral, so the card never claims a colour the street may not show.
 */
function silhouettePaint(look: Look): string[] {
  const own = (slot: LookSlot, fallback: number) => hex6(lookSwatch(look, slot) ?? fallback)
  const out: string[] = []
  // The top's slot wears the layer's cloth: the shirt's under shirt sleeves, the coat's under a coat (lookSwatch reads the layer).
  out[SLOT.SHIRT] = own('shirt', 0xf2f2ef)
  out[SLOT.TOP] = look.layer === LAYER.shirt ? out[SLOT.SHIRT] : own('top', 0x33363b)
  out[SLOT.SKIN] = own('skin', 0xd29f79)
  out[SLOT.HAIR] = own('hairColour', 0x3b2618)
  out[SLOT.BOTTOM] = own('bottom', 0x33363b)
  out[SLOT.SHOES] = own('shoes', 0x141414)
  out[SLOT.ACCENT] = '#2b2b2e'
  out[SLOT.PROP] = '#2a2a2a'
  out[SLOT.LEGWEAR] = look.body === 3 ? '#2a2626' : out[SLOT.BOTTOM]
  // The frames in their finish (look.ts FRAME_FINISH, the crowd's own linear values, as the black was): the black, #0d0d0e, as before.
  out[SLOT.FRAME] = hex6(FRAME_FINISH[look.frames].reduce((n, c) => n * 256 + Math.round(255 * c), 0))
  out[SLOT.EYE] = '#e8e2dc'
  out[SLOT.IRIS] = '#4a3a2a'
  out[SLOT.LIP] = lipOf(lookSwatch(look, 'skin') ?? 0xd29f79)
  out[SLOT.SCARF] = own('scarf', 0x6a1e2a)
  out[SLOT.HEADWEAR] = own('headwearColour', 0x1c1c22)
  out[SLOT.DEVICE] = '#2b2c2e'
  return out
}

/** The lips as the shader paints them: the skin by (0.82, 0.55, 0.55). */
function lipOf(skin: number): string {
  const c = (shift: number, k: number) => Math.round(((skin >> shift) & 0xff) * k)
  return hex6((c(16, 0.82) << 16) | (c(8, 0.55) << 8) | c(0, 0.55))
}

/** A shade darker, for the features that stand off the face (the nose, the ears). */
function shaded(hex: string): string {
  const n = parseInt(hex.slice(1), 16)
  const c = (shift: number) => Math.round(((n >> shift) & 0xff) * 0.86)
  return hex6((c(16) << 16) | (c(8) << 8) | c(0))
}

/** Whether the look wears an optional piece of the body (the always-drawn ones have piece 0): the crowd's own mask (look.ts lookWears). */
const wears = (look: Look, piece: number): boolean => lookWears(look, piece)

const m = (v: number): string => (Math.round(v * 1000) / 1000).toString()

/**
 * The rings as four-sided bands between neighbouring rings of one tube, in the lower ring's colour, painted back to
 * front by the upper ring's depth (humanoid.ts Tube.depth: hair behind the skull, the skull and the body, the ears, the
 * hair over the skull, the features).
 */
function bandsOf(rings: readonly SilhouetteRing[], paint: readonly string[], shade: boolean): { points: string; fill: string }[] {
  const bands: { points: string; fill: string; order: number }[] = []
  for (let i = 1; i < rings.length; i++) {
    const a = rings[i - 1], b = rings[i]
    if (a.tube !== b.tube) continue
    let fill = a.piece === PIECE.CUP ? '#ece9e4' : paint[a.slot] ?? '#888'
    if (shade && a.piece === PIECE.FACE && a.slot === SLOT.SKIN) fill = shaded(fill)
    bands.push({ points: `${m(a.left)},${m(-a.y)} ${m(a.right)},${m(-a.y)} ${m(b.right)},${m(-b.y)} ${m(b.left)},${m(-b.y)}`, fill, order: b.depth })
  }
  return bands.sort((p, q) => p.order - q.order)
}

/**
 * One view of the body: every pair of neighbouring rings of a tube as a four-sided band between their edges, in
 * the lower ring's colour, over a ground line. Metres, y up (the SVG's y is negated), 1.2 m across, 2.2 m tall.
 */
function SilhouetteView({ rings, paint, title }: { rings: readonly SilhouetteRing[]; paint: readonly string[]; title: string }) {
  const bands = bandsOf(rings, paint, false)
  return (
    <svg viewBox="-0.6 -2.12 1.2 2.2" width="78" height="143" role="img" aria-label={title} data-silhouette={title.toLowerCase()}>
      <line x1="-0.5" y1="0" x2="0.5" y2="0" stroke="currentColor" strokeOpacity="0.25" strokeWidth="0.008" />
      {bands.map((b, i) => <polygon key={i} points={b.points} fill={b.fill} stroke={b.fill} strokeWidth="0.006" strokeLinejoin="round" />)}
    </svg>
  )
}

/** The look as the city will draw it, standing: from the front and from its left side, in its own colours. */
function Silhouette({ look, t }: { look: Look; t: Theme }) {
  const shape = bodyShapeOf(look)
  const body = look.body as LookBody
  const paint = silhouettePaint(look)
  const views = useMemo(() => {
    // The features are the face view's: at this scale they would only clutter the head.
    const keep = (r: SilhouetteRing) => r.piece !== PIECE.FACE && wears(look, r.piece)
    // The lower cut's shape (a wide leg, a midi hem) is the vertex stage's, through the same garmentPoint.
    const coat = look.layer === LAYER.coat
    return {
      front: silhouetteRings(body, shape, false, look.bottomCut, coat).filter(keep),
      side: silhouetteRings(body, shape, true, look.bottomCut, coat).filter(keep),
    }
  }, [look, body, shape])
  return (
    <div className="flex items-end gap-4" data-row="silhouette">
      <div className="flex flex-col items-center gap-1">
        <SilhouetteView rings={views.front} paint={paint} title="Front" />
        <span className={`text-[10px] font-semibold tracking-wider uppercase ${t.muted}`}>Front</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <SilhouetteView rings={views.side} paint={paint} title="Side" />
        <span className={`text-[10px] font-semibold tracking-wider uppercase ${t.muted}`}>Side</span>
      </div>
      <p className={`max-w-[14rem] pb-4 text-[11px] leading-snug ${t.muted}`}>
        {`${shape.height.toFixed(2)} m, standing. The same rings the city draws; the tie, bag and hose keep the street's own colours; shoe styles, the watch, the pin, rolled sleeves and tattoos show in the city, not in this outline.`}
      </p>
    </div>
  )
}

/**
 * One view of the head, six times the silhouette's scale: the skull and its hair, the features and the rims, as
 * bands like the body's, framed on the skull (the first head tube) from its chin to the top of the hair.
 */
function FaceView({ rings, paint, title }: { rings: readonly SilhouetteRing[]; paint: readonly string[]; title: string }) {
  const bands = bandsOf(rings, paint, true)
  let top = -Infinity, bottom = Infinity, left = Infinity, right = -Infinity
  for (const r of rings) {
    top = Math.max(top, r.y)
    if (r.tube === 0) bottom = Math.min(bottom, r.y)
    left = Math.min(left, r.left)
    right = Math.max(right, r.right)
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null
  const cx = (left + right) / 2
  const w = Math.max(0.3, right - left + 0.04)
  const h = top - bottom + 0.04
  return (
    <svg viewBox={`${m(cx - w / 2)} ${m(-top - 0.02)} ${m(w)} ${m(h)}`} width="96" height={Math.round((96 * h) / w)} role="img" aria-label={title} data-face={title.toLowerCase()}>
      {bands.map((b, i) => <polygon key={i} points={b.points} fill={b.fill} stroke={b.fill} strokeWidth="0.0015" strokeLinejoin="round" />)}
    </svg>
  )
}

/** The face as the city will draw it: from the front and in profile, the face sliders and the hair style applied. */
function Face({ look, t }: { look: Look; t: Theme }) {
  const shape = bodyShapeOf(look)
  const face = faceShapeOf(look)
  const body = look.body as LookBody
  const paint = silhouettePaint(look)
  const views = useMemo(() => {
    const keep = (r: SilhouetteRing) => wears(look, r.piece)
    return { front: faceRings(body, shape, face, false).filter(keep), side: faceRings(body, shape, face, true).filter(keep) }
  }, [look, body, shape, face])
  return (
    <div className="flex items-end gap-4" data-row="face">
      <div className="flex flex-col items-center gap-1">
        <FaceView rings={views.front} paint={paint} title="Face" />
        <span className={`text-[10px] font-semibold tracking-wider uppercase ${t.muted}`}>Face</span>
      </div>
      <div className="flex flex-col items-center gap-1">
        <FaceView rings={views.side} paint={paint} title="Profile" />
        <span className={`text-[10px] font-semibold tracking-wider uppercase ${t.muted}`}>Profile</span>
      </div>
      <p className={`max-w-[14rem] pb-4 text-[11px] leading-snug ${t.muted}`}>
        The head's own rings, up close. The eyes keep the colour the street gives them; the age, the undertone, facial hair short of a long beard and a prosthetic show on the street alone.
      </p>
    </div>
  )
}

// --- The tattoos -------------------------------------------------------------------------------------------------

/** The zones the wardrobe has a slot for (tattoo.ts TATTOO_ZONES, in zone order: the hands, the neck, the nape and the forearms). */
const CARD_ZONES = TATTOO_ZONES.filter((z) => (LOOK_SLOTS as readonly string[]).includes(z.slot)).map((z) => ({ ...z, slot: z.slot as LookSlot }))
/** The slots the Tattoos section shows (the zones and the ink), never as rows of their own. */
const isTattooSlot = (slot: LookSlot): boolean => slot === 'tattooInk' || CARD_ZONES.some((z) => z.slot === slot)
/** A design's name by its id (the zone slot's value; 0 is none). */
const designName = (id: number): string => (id > 0 ? TATTOO_MOTIFS[id - 1].name : 'none')

/**
 * The tattoos, as one section where sixty-five designs on each zone would be four rows of sixty-five pills: which zone
 * (a dot on a zone that holds a design, and what covers it in the city: look.ts tattooCover), the design family (none
 * clears the zone; another family wears its first design at once, as every change on the card is worn), the family's
 * eight designs, and the ink row (`ink`, the slot row the card draws for every swatch slot). The zone chosen is the
 * card's own: it starts on the first zone that holds a design, or the left hand. Every control is a button in a
 * radiogroup, which switch scanning and dwell press like any other.
 */
function TattooSection({ worn, set, ink, t }: { worn: Look; set(slot: LookSlot, value: number): void; ink: ReactNode; t: Theme }) {
  const [zone, setZone] = useState<LookSlot>(() => CARD_ZONES.find((z) => worn[z.slot] > 0)?.slot ?? 'tattooHand')
  const design = worn[zone]
  const family = design > 0 ? TATTOO_MOTIFS[design - 1].family : null
  const label = `w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`
  const pill = (on: boolean) => `rounded-full border px-2.5 py-0.5 text-[12px] ${on ? t.pillOn : t.pill}`
  return (
    <div className={`mb-2 mt-3 border-t pt-3 ${t.rule}`} role="group" aria-label="Tattoos" data-row="tattoos">
      <div className="mb-2 flex items-baseline gap-3">
        <div className={`w-20 shrink-0 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>Tattoos</div>
        <p className={`min-w-0 flex-1 text-[11px] leading-snug ${t.muted}`}>Shown on you in the city and in a shop's mirror. Forearms need rolled sleeves.</p>
      </div>
      <div className="mb-2 flex items-start gap-3" data-row="tattoo-zone">
        <div className={label}>Zone</div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Tattoo zone">
          {CARD_ZONES.map((z) => {
            const on = z.slot === zone
            const inked = worn[z.slot] > 0
            const cover = tattooCover(worn, z.slot)
            return (
              <button
                key={z.slot}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`${z.label}, ${designName(worn[z.slot])}${cover ? `, ${cover}` : ''}`}
                onClick={() => setZone(z.slot)}
                className={pill(on)}
                data-zone={z.slot}
              >
                {inked && <span aria-hidden className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-current align-middle" data-inked />}
                {z.label}
                {cover && <span className="ml-1 text-[11px] opacity-70" data-hint>· {cover}</span>}
              </button>
            )
          })}
        </div>
      </div>
      <div className="mb-2 flex items-start gap-3" data-row="tattoo-family">
        <div className={label}>Design family</div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Design family">
          <button type="button" role="radio" aria-checked={family === null} onClick={() => set(zone, 0)} className={pill(family === null)}>none</button>
          {TATTOO_FAMILIES.map((name, f) => (
            <button key={name} type="button" role="radio" aria-checked={family === f} onClick={() => { if (family !== f) set(zone, TATTOO_BY_FAMILY[f][0]) }} className={pill(family === f)}>
              {name}
            </button>
          ))}
        </div>
      </div>
      {family !== null && (
        <div className="mb-2 flex items-start gap-3" data-row="tattoo-design">
          <div className={label}>Design</div>
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Design">
            {TATTOO_BY_FAMILY[family].map((id) => (
              <button key={id} type="button" role="radio" aria-checked={id === design} onClick={() => set(zone, id)} className={pill(id === design)}>
                {designName(id)}
              </button>
            ))}
          </div>
        </div>
      )}
      {ink}
    </div>
  )
}

/** The wardrobe itself: the silhouette, presets, the slot rows and the code row, over one look; every change goes out through `onChange`. */
function LookEditor({ worn, seed, onChange, t }: { worn: Look; seed: number; onChange(look: Look): void; t: Theme }) {
  const body = worn.body as LookBody
  /** A code being typed to wear, and why the last one was refused. */
  const [code, setCode] = useState('')
  const [refused, setRefused] = useState(false)
  /** The code last copied to the clipboard: "Copied" shows while the look is still that one. */
  const [copied, setCopied] = useState('')
  const set = (slot: LookSlot, value: number) => {
    const next = withLookSlot(worn, slot, value)
    if (next) onChange(next)
  }
  const wearCode = (e: FormEvent) => {
    e.preventDefault()
    const parsed = parseLookCode(code)
    if (!parsed) { setRefused(true); return }
    setRefused(false)
    setCode('')
    onChange(parsed)
  }
  /** A slot's row of options: a colour as a swatch, a named option as a pill. */
  const optionRow = (slot: LookSlot) => {
    const options = lookOptions(body, slot, worn.layer)
    const current = worn[slot]
    return (
      <div key={slot} className="mb-2 flex items-start gap-3" data-slot={slot}>
        <div className={`w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>{slotLabel(slot, body, worn.layer)}</div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label={slotLabel(slot, body, worn.layer)}>
          {options.map((o, i) => {
            const on = i === current
            // A colour is a swatch; a named option is a pill (the matching trousers' carries the jacket's cloth, the matching trim's the outer layer's).
            const hex = o.hex ?? ((slot === 'bottom' || slot === 'trim') && o.name === 'matching' ? matchingSwatch(worn, slot) : null)
            if (o.hex !== null) {
              return (
                <button
                  key={i}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={o.name}
                  title={o.name}
                  onClick={() => set(slot, i)}
                  style={{ backgroundColor: hex6(o.hex) }}
                  className={`h-6 w-6 rounded-full border border-black/20 ${on ? `ring-2 ring-offset-1 ${t.ring}` : ''}`}
                />
              )
            }
            return (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => set(slot, i)}
                className={`rounded-full border px-2.5 py-0.5 text-[12px] capitalize ${on ? t.pillOn : t.pill}`}
              >
                {hex !== null && (
                  <span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full border border-black/20 align-middle" style={{ backgroundColor: hex6(hex) }} />
                )}
                {o.name}
              </button>
            )
          })}
        </div>
      </div>
    )
  }
  const code6 = formatLookCode(worn)
  const copy = () => {
    try {
      void navigator.clipboard.writeText(code6).then(() => setCopied(code6), () => setCopied(''))
    } catch {
      setCopied('')
    }
  }
  return (
    <>
      <div className={`mt-3 flex flex-wrap gap-1.5`} data-row="presets">
        {LOOK_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onChange(p.look)}
            aria-pressed={formatLookCode(p.look) === code6}
            className={`rounded-full border px-2.5 py-1 text-[12px] capitalize ${formatLookCode(p.look) === code6 ? t.pillOn : t.pill}`}
          >
            {p.name}
          </button>
        ))}
        <button type="button" onClick={() => onChange(lookFromSeed(randomSeed()))} className={`rounded-full border px-2.5 py-1 text-[12px] ${t.pill}`} data-action="randomise">
          Randomise
        </button>
        <button type="button" onClick={() => onChange(lookFromSeed(seed))} className={`rounded-full border px-2.5 py-1 text-[12px] ${t.pill}`} data-action="reset">
          Reset
        </button>
      </div>

      <div className={`mt-3 border-t pt-3 ${t.rule}`}>
        <Silhouette look={worn} t={t} />
      </div>

      <div className={`mt-3 border-t pt-3 ${t.rule}`}>
        {LOOK_SLOTS.map((slot) => {
          // Under shirt sleeves the jacket is off: its cut, its cloth, its weave, its trim and the pin on its lapel are not seen, so their rows are not shown.
          if (worn.layer === LAYER.shirt && (slot === 'cut' || slot === 'top' || slot === 'topWeave' || slot === 'trim' || slot === 'lapelPin')) return null
          // The frames are the glasses' finish: without glasses there is nothing to finish.
          if (slot === 'frames' && worn.eyewear === 0) return null
          // A coat keeps its sleeves down (its own piece covers the arm), so under a coat there are no sleeves to roll.
          if (slot === 'sleeves' && worn.layer === LAYER.coat) return null
          // The tattoos are one section, headed where the first zone's row would be: the zones and the ink have no rows of their own.
          if (slot === 'tattooHand') return <TattooSection key={slot} worn={worn} set={set} ink={optionRow('tattooInk')} t={t} />
          if (isTattooSlot(slot)) return null
          const options = lookOptions(body, slot, worn.layer)
          const current = worn[slot]
          if (isSlider(slot)) {
            // A body or face slider, or the age: a range over its steps, the height read in metres.
            const shown = slot === 'height' ? options[current].name : `${current + 1}/${options.length}`
            const row = (
              <div className="mb-2 flex items-center gap-3" data-slot={slot}>
                <div className={`w-20 shrink-0 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>{slotLabel(slot, body, worn.layer)}</div>
                <input
                  type="range"
                  min={0}
                  max={options.length - 1}
                  step={1}
                  value={current}
                  onChange={(e) => set(slot, Number(e.target.value))}
                  aria-label={slotLabel(slot, body, worn.layer)}
                  aria-valuetext={options[current].name}
                  className="min-w-0 flex-1 accent-current"
                />
                <span className={`w-14 shrink-0 text-right font-mono text-[12px] ${t.muted}`} data-slider-value>{shown}</span>
              </div>
            )
            // The builds head the body sliders (each sets the frame's four; any moved after is the person's own).
            if (slot === 'height') {
              const on = buildOf(worn)
              return (
                <Fragment key={slot}>
                  <div className="mb-2 flex items-start gap-3" data-row="build">
                    <div className={`w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>Build</div>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Build">
                      {LOOK_BUILDS.map((b) => (
                        <button
                          key={b.name}
                          type="button"
                          role="radio"
                          aria-checked={on?.name === b.name}
                          onClick={() => { const next = withBuild(worn, b.name); if (next) onChange(next) }}
                          className={`rounded-full border px-2.5 py-0.5 text-[12px] capitalize ${on?.name === b.name ? t.pillOn : t.pill}`}
                        >
                          {b.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  {row}
                </Fragment>
              )
            }
            // The face view heads the face sliders, then the face shapes (each sets the head and the seven sliders).
            if (slot === 'brow') {
              const shape = faceShapeNameOf(worn)
              return (
                <Fragment key={slot}>
                  <div className={`mb-3 mt-3 border-t pt-3 ${t.rule}`}><Face look={worn} t={t} /></div>
                  <div className="mb-2 flex items-start gap-3" data-row="face-shape">
                    <div className={`w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>Face shape</div>
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Face shape">
                      {LOOK_FACE_SHAPES.map((f) => (
                        <button
                          key={f.name}
                          type="button"
                          role="radio"
                          aria-checked={shape?.name === f.name}
                          onClick={() => { const next = withFaceShape(worn, f.name); if (next) onChange(next) }}
                          className={`rounded-full border px-2.5 py-0.5 text-[12px] capitalize ${shape?.name === f.name ? t.pillOn : t.pill}`}
                        >
                          {f.name}
                        </button>
                      ))}
                    </div>
                  </div>
                  {row}
                </Fragment>
              )
            }
            return <Fragment key={slot}>{row}</Fragment>
          }
          const pills = optionRow(slot)
          // The garments head the outer layer's rows (each sets the layer, its cut and its weave; the colours stay the look's).
          if (slot === 'layer') {
            const wearing = garmentOf(worn)
            return (
              <Fragment key={slot}>
                <div className="mb-2 flex items-start gap-3" data-row="garment">
                  <div className={`w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>Garment</div>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label="Garment">
                    {LOOK_GARMENTS.map((g) => (
                      <button
                        key={g.name}
                        type="button"
                        role="radio"
                        aria-checked={wearing?.name === g.name}
                        onClick={() => { const next = withGarment(worn, g.name); if (next) onChange(next) }}
                        className={`rounded-full border px-2.5 py-0.5 text-[12px] ${wearing?.name === g.name ? t.pillOn : t.pill}`}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
                {pills}
              </Fragment>
            )
          }
          // The lower garments head the lower cut's rows, the ones the body wears (a skirt for the skirt suit, trousers
          // for the rest): each sets the cut and, where it names one, the weave.
          if (slot === 'bottomCut') {
            const wearing = lowerGarmentOf(worn)
            return (
              <Fragment key={slot}>
                <div className="mb-2 flex items-start gap-3" data-row="lowerGarment">
                  <div className={`w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>{worn.body === 3 ? 'Skirts' : 'Trousers'}</div>
                  <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label={worn.body === 3 ? 'Skirts' : 'Trousers'}>
                    {LOOK_LOWER_GARMENTS.filter((g) => lowerGarmentFits(worn, g)).map((g) => (
                      <button
                        key={g.name}
                        type="button"
                        role="radio"
                        aria-checked={wearing?.name === g.name}
                        onClick={() => { const next = withGarment(worn, g.name); if (next) onChange(next) }}
                        className={`rounded-full border px-2.5 py-0.5 text-[12px] ${wearing?.name === g.name ? t.pillOn : t.pill}`}
                      >
                        {g.name}
                      </button>
                    ))}
                  </div>
                </div>
                {pills}
              </Fragment>
            )
          }
          return pills
        })}
      </div>

      <div className={`mt-2 border-t pt-3 ${t.rule}`} data-row="code">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>Code</span>
          <code className="break-all rounded-md border border-current/15 px-2 py-0.5 font-mono text-[12px]" data-look-code>{code6}</code>
          <button type="button" onClick={copy} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`}>{copied === code6 ? 'Copied' : 'Copy'}</button>
          <form onSubmit={wearCode} className="flex min-w-0 items-center gap-1.5">
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value); setRefused(false) }}
              placeholder="Paste a code"
              aria-label="A look code to wear"
              aria-invalid={refused || undefined}
              spellCheck={false}
              autoComplete="off"
              className={`w-56 max-w-full rounded-md border px-2 py-0.5 font-mono text-[12px] outline-none ${t.field}`}
            />
            <button type="submit" className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`}>Wear</button>
          </form>
        </div>
        {refused && <p className={`mt-1 text-[11px] ${t.muted}`} role="alert">That is not a look code from this wardrobe.</p>}
      </div>
    </>
  )
}

/** One agent's tab: who they are, how they sound, and their look over the same wardrobe. */
function AgentEditor({ id, roster, onAgentLook, onHear, onForget, t }: { id: AgentIdentity; roster: Roster; onAgentLook?(name: string, look: Look | null): void; onHear?(voice: string, line: string): void; onForget(): void; t: Theme }) {
  const [role, setRole] = useState(id.role)
  const [voiceText, setVoiceText] = useState(voiceProfile(id.voice) ? '' : id.voice)
  const [refused, setRefused] = useState<string | null>(null)
  const seed = id.agent ?? seedFromName(id.name)
  const worn = id.look ?? lookFromSeed(seed)
  const change = (field: 'pronouns' | 'role' | 'voice', value: string) => {
    try { roster.set(id.name, field, value); setRefused(null) } catch (e) { setRefused(e instanceof Error ? e.message : String(e)) }
  }
  const wear = (look: Look | null) => {
    try {
      if (onAgentLook) onAgentLook(id.name, look)
      else roster.set(id.name, 'look', look)
      setRefused(null)
    } catch (e) { setRefused(e instanceof Error ? e.message : String(e)) }
  }
  const label = `text-[11px] font-semibold tracking-wider uppercase ${t.muted}`
  return (
    <div data-agent={id.name}>
      <p className={`mt-2 text-[12px] ${t.muted}`} data-agent-hired={id.agent ?? ''}>
        {id.agent === null
          ? <>Not hired yet. In the console (~): <code className="font-mono">agent hire {id.name} &lt;skill&gt;</code> asks someone nearby over as {id.name}.</>
          : <>Hired as pedestrian {id.agent}: they answer <code className="font-mono">ask</code> and <code className="font-mono">say</code> as {id.name}.</>}
      </p>
      <div className="mt-3 flex items-start gap-3">
        <div className={`w-20 shrink-0 pt-1 ${label}`}>Pronouns</div>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="radiogroup" aria-label="Pronouns">
          {PRONOUNS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={id.pronouns === p} onClick={() => change('pronouns', p)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${id.pronouns === p ? t.pillOn : t.pill}`}>{p}</button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-start gap-3">
        <div className={`w-20 shrink-0 pt-1 ${label}`}>Role</div>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          onBlur={() => { if (role.trim() !== id.role) change('role', role) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); change('role', role) } }}
          maxLength={48}
          placeholder="What they are for, in your words"
          aria-label="Role"
          autoComplete="off"
          className={`min-w-0 flex-1 rounded-md border px-2 py-0.5 text-[12px] outline-none ${t.field}`}
        />
      </div>
      <div className="mt-2 flex items-start gap-3">
        <div className={`w-20 shrink-0 pt-1 ${label}`}>Voice</div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Voice profile">
            {VOICE_PROFILES.map((p) => (
              <button key={p.name} type="button" role="radio" aria-checked={id.voice === p.name} title={p.blurb} onClick={() => change('voice', p.name)} className={`rounded-full border px-2.5 py-0.5 text-[12px] capitalize ${id.voice === p.name ? t.pillOn : t.pill}`}>{p.name}</button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (voiceText.trim()) change('voice', voiceText) }} className="flex items-center gap-1.5">
            <input
              value={voiceText}
              onChange={(e) => setVoiceText(e.target.value)}
              placeholder="Or a voice your speech provider lists"
              aria-label="A provider voice"
              spellCheck={false}
              autoComplete="off"
              className={`w-56 max-w-full rounded-md border px-2 py-0.5 text-[12px] outline-none ${t.field}`}
            />
            <button type="submit" className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`}>Use</button>
            {onHear && (
              <button type="button" onClick={() => onHear(id.voice, `Hi, I’m ${id.name}.${id.role ? ` ${id.role[0].toUpperCase()}${id.role.slice(1)}, at your service.` : ''}`)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`} data-action="agent-hear" title="Hear this voice (the city's sound must be on)">Hear</button>
            )}
          </form>
        </div>
      </div>
      {refused && <p className={`mt-2 text-[11px] ${t.muted}`} role="alert">{refused}</p>}
      <div className={`mt-3 flex flex-wrap items-center gap-2 border-t pt-3 ${t.rule}`}>
        <span className={label}>Look</span>
        <button type="button" onClick={() => wear(null)} aria-pressed={id.look === null} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${id.look === null ? t.pillOn : t.pill}`} data-action="agent-hash">As the city dresses them</button>
        <button type="button" onClick={onForget} className={`ml-auto rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`} data-action="agent-forget">Forget {id.name}</button>
      </div>
      <LookEditor worn={worn} seed={seed} onChange={wear} t={t} />
    </div>
  )
}

export function Customizer({ visible, look, seed, onChange, onClose, dark = false, agents = [], roster, onAgentLook, onHear }: CustomizerProps) {
  const cardRef = useRef<HTMLElement>(null)
  /** Which tab: the player ('you'), or an agent by name. */
  const [tab, setTab] = useState<string>('you')
  const [newName, setNewName] = useState('')
  const [newRefused, setNewRefused] = useState<string | null>(null)

  // Esc puts the card away (captured, so the game's own key handling never sees it while the card has the keyboard).
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    cardRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])

  if (!visible) return null
  const worn = look ?? lookFromSeed(seed)
  const body = worn.body as LookBody
  const t = themeOf(dark)
  const glass = dark
    ? 'border-white/10 bg-slate-900/70 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/80 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const current = tab === 'you' ? null : agents.find((a) => a.name === tab) ?? null
  const showing = current ? 'agent' : 'you'
  const addAgent = (e: FormEvent) => {
    e.preventDefault()
    if (!roster) return
    try {
      const id = roster.add(newName)
      setNewName('')
      setNewRefused(null)
      setTab(id.name)
    } catch (err) {
      setNewRefused(err instanceof Error ? err.message : String(err))
    }
  }
  const forget = (name: string) => {
    if (!roster) return
    try {
      // A hired agent's pedestrian goes back to the look the city gives them before the record goes.
      if (roster.get(name)?.agent != null) onAgentLook?.(name, null)
      roster.remove(name)
    } catch { /* already gone */ }
    setTab('you')
  }

  return (
    <div className="ui-zoom pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4 font-sans text-[13px] antialiased">
      <aside
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={current ? `${current.name}'s look` : 'Your look'}
        data-customizer={body}
        data-customizer-tab={showing}
        className={`pointer-events-auto flex max-h-full w-[min(36rem,100%)] flex-col rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} outline-none`}
      >
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight">{current ? current.name : 'Your look'}</div>
            <p className={`mt-1 text-[12px] leading-snug ${t.muted}`}>
              {current
                ? 'One of your own agents. Everything here is what the city already wears; their look is worn the moment they are hired.'
                : 'Everything here is what the city already wears. Each change is worn at once: your eye never sees itself, but your shadow and everyone else do.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] ${t.pill}`}>×</button>
        </div>

        {roster && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 px-5" role="tablist" aria-label="Who to dress" data-row="tabs">
            <button type="button" role="tab" aria-selected={tab === 'you'} onClick={() => setTab('you')} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${tab === 'you' ? t.pillOn : t.pill}`}>You</button>
            {agents.map((a) => (
              <button key={a.name} type="button" role="tab" aria-selected={tab === a.name} onClick={() => setTab(a.name)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${tab === a.name ? t.pillOn : t.pill}`} data-agent-tab={a.name}>
                {a.name}
              </button>
            ))}
            {agents.length < ROSTER_MAX && (
              <form onSubmit={addAgent} className="flex items-center gap-1.5">
                <input
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setNewRefused(null) }}
                  maxLength={24}
                  placeholder="New agent’s name"
                  aria-label="A new agent’s name"
                  aria-invalid={newRefused !== null || undefined}
                  autoComplete="off"
                  className={`w-36 rounded-md border px-2 py-0.5 text-[12px] outline-none ${t.field}`}
                />
                <button type="submit" className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`} data-action="agent-new">Add</button>
              </form>
            )}
          </div>
        )}
        {newRefused && <p className={`mt-1 px-5 text-[11px] ${t.muted}`} role="alert">{newRefused}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          {current && roster
            ? <AgentEditor key={current.name} id={current} roster={roster} onAgentLook={onAgentLook} onHear={onHear} onForget={() => forget(current.name)} t={t} />
            : <LookEditor worn={worn} seed={seed} onChange={onChange} t={t} />}
        </div>

        <div className={`flex justify-end border-t px-5 py-3 ${t.rule}`}>
          <button type="button" onClick={onClose} className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold ${t.primary}`} data-action="done">Done</button>
        </div>
      </aside>
    </div>
  )
}
