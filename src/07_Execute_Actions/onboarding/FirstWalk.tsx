// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the first walk's card (09_Cognition/firstWalk.ts, fed by useFirstWalk.ts): one
 * small panel in Sloane's own style (the onboarding's ink and titanium) that names the stage the visitor is on, says
 * the one thing to do in their device's words, tells them what it is in a line an eight-year-old follows, and unfolds
 * the five whys one at a time when they ask. It has no close button, no skip and no key that puts it away: the walk
 * ends when the console's exit program unlocks the city, and the card says so in plain words. Its accessible path is
 * one button per stage that has Sloane do the action for a visitor who cannot (a switch, a screen reader, a phone with
 * no keyboard): walk and turn, plan a goal, take them to a car, take them inside, open the console; on the last stage
 * the buttons type each line of the program into the console's prompt and run it, so the walk is completable with
 * taps alone. It stands clear of the HUD, the touch controls and Sloane's own card: on a wide screen under the
 * readout on the right, with Sloane's open card moved left of it (Concierge.tsx WIDE_BESIDE) from 60 rem across and,
 * in a narrower wide window, stepping aside while her card is open; on a compact or touch screen in the band above
 * the stick and the buttons and below her chip, stepping aside while her card is open (hers takes the same band); on
 * a phone held sideways between the thumbs, above the HUD's chips at the foot, and away while the visitor is at the
 * wheel there (the car's buttons fill the band); with the console open, at the foot of the screen under it.
 * On a phone held upright that band is all of the city the visitor sees between the HUD and their thumbs (131 px of
 * a 360 x 552 page), so there the card folds: a one-line strip under the HUD's header, beside the minimap (Hud.tsx
 * and walkSlot.ts), always says the stage and its number, and the card itself opens under Sloane's chip for each new line
 * and at a tap on the strip, and folds at the next touch outside it, after a few metres, or getting into a car (at
 * the wheel a new line is heard and the strip marks it; the card waits for a tap). Open, it shows Sloane's line cut
 * to the lines its band has room for over the stage's button, and More unfolds the rest (the whole line, what the
 * stage is, the whys). That short card takes touches on its buttons only: a finger dragged across its words turns the
 * view, as the first stage asks, and folds it. Folding puts nothing away for good: the strip has no close either, and
 * the walk still ends only in the console.
 * What breaks if it is removed? The walk has no face: Sloane's lines are heard but never seen, and a visitor without
 * a keyboard or a mouse has no way through it.
 */
import { useEffect, useEffectEvent, useLayoutEffect, useRef, useState, useSyncExternalStore, type JSX } from 'react'
import { createPortal } from 'react-dom'
import { PROGRAM, type Beat, type StageCard } from '../../09_Cognition/firstWalk.ts'
import { besideRoom } from '../Concierge.tsx'
import { WALK_SLOT } from '../walkSlot.ts'
import { CONCIERGE_NAME } from './script.ts'
import { FOLD_METRES, UNMEASURED, fitLines } from './walkFold.ts'

/** Where the card stands (full class strings, so Tailwind sees them). The card is inside the text size's zoom
 *  (index.css `.ui-zoom`), like the HUD it keeps clear of: the HUD's wide readout is 18 rem wide and about 14 rem tall
 *  under a 1.25 rem frame; the compact frame is 0.75 rem with the minimap row 8.75 rem tall, and Sloane's chip under
 *  the minimap ends at --chip-bottom (Concierge.tsx; zoomed lengths already), lower at the wheel. What is not zoomed is
 *  divided by --ui-zoom: the window's height (dvh), the touch buttons' top edge and left edge (--touch-top,
 *  --touch-left, window pixels; TouchControls.tsx), the stick's zone (11.5 rem of the unzoomed touch layer, 12.5 rem
 *  with its gaps), the top of the HUD's chips at the foot (--hud-foot, Hud.tsx) and the console's 45 dvh. Sideways,
 *  the band between the thumbs starts 10.5 rem down, clear of the header, the readout and Sloane's chip, and ends
 *  above the HUD's chips at the foot. Where that band is short of 8 rem (a large text size, a short screen, captions
 *  or a shop's chip at the foot), Sloane's chip moves up to the top row and the card rises over the HUD's header and
 *  readout, which take no taps, to stand under it (--chip-bottom): the two read the same band through the same step
 *  (Concierge.tsx CHIP_TOP.walk), its foot latched at its highest (--hud-foot-peak, footPeak.ts) so captions coming
 *  and going cannot flip it. Either way it ends left of the minimap's column (7 rem wide under a 0.75 rem frame),
 *  and its foot comes down over the HUD's chips rather than let it grow up over the chip once what is left is less
 *  than its own padding and border (1.875 rem). Upright on a touch screen (`touch`) the card starts 0.5 rem under
 *  Sloane's chip and ends 0.5 rem above the HUD's chips at the foot (the captions, a shop's chip: --hud-foot latched at
 *  its highest, so captions coming and going do not move it), the buttons and the stick's zone, while that band holds
 *  7 rem. Where it does not, it ends above the buttons and the stick alone, over the HUD's chips (an open card folds at
 *  the next touch, and they are back). Where even that band is short of 7 rem (a short phone beside a car, whose Enter
 *  car button stands above the Menu, or at the wheel, where the car's buttons reach up), it stands above her chip
 *  instead, from the frame's top to 0.5 rem over her chip's head (--chip-head, Concierge.tsx), over the HUD's header,
 *  the walk's strip and the minimap: never over her chip, which stages ask the visitor to tap. Each switch is the
 *  sideways place's kind of step (0 while the band holds, else the screen's height). Opened out with More
 *  (`touchMore`) the card ends above the buttons and the stick whatever the HUD's chips: the visitor asked to read all
 *  of it, and Less or the next touch gives the chips back. */
const AT = {
  wide: 'right-[max(1.25rem,env(safe-area-inset-right))] top-[calc(max(1.25rem,env(safe-area-inset-top))+16rem)] w-[20rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(1.25rem,env(safe-area-inset-top))_-_16rem_-_7.5rem)]',
  compact: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[calc(max(0.75rem,env(safe-area-inset-bottom))+4.5rem)] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(calc(max(0.75rem,env(safe-area-inset-top))_+_8.75rem),calc(var(--chip-bottom,0px)_+_0.5rem))_-_max(0.75rem,env(safe-area-inset-bottom))_-_5rem)]',
  touch: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(max(calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem),calc(calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)),calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1)))_+_0.5rem)_-_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)),calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh))),calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-head,0px)_-_0.5rem)_-_100vh_+_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh)))] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(max(0.75rem,env(safe-area-inset-top)),calc(calc(var(--chip-bottom,0px)_+_0.5rem)_-_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh)))_-_max(max(calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem),calc(calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)),calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1)))_+_0.5rem)_-_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)),calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh))),calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-head,0px)_-_0.5rem)_-_100vh_+_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh))))]',
  touchMore: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem),calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-head,0px)_-_0.5rem)_-_100vh_+_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh)))] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(max(0.75rem,env(safe-area-inset-top)),calc(calc(var(--chip-bottom,0px)_+_0.5rem)_-_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh)))_-_max(calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem),calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-head,0px)_-_0.5rem)_-_100vh_+_clamp(0px,calc((7rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_calc(var(--chip-bottom,0px)_+_0.5rem)_-_calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)))_*_10000),100vh))))]',
  between: 'left-[calc(env(safe-area-inset-left,0px)_+_calc(12.5rem_/_var(--ui-zoom,1)))] right-[max(calc(calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_+_0.5rem),calc(max(0.75rem,env(safe-area-inset-right))_+_7.5rem))] bottom-[max(0px,min(max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)),calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(max(max(0.75rem,env(safe-area-inset-top)),calc(var(--chip-bottom,0px)_+_0.5rem)),calc(max(0.75rem,env(safe-area-inset-top))_+_10.5rem_-_clamp(0px,calc((8rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_10.5rem_-_max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1))_+_0.5rem))))_*_10000),100vh)))_-_1.875rem)))] mx-auto max-w-[28rem] max-h-[calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(max(max(0.75rem,env(safe-area-inset-top)),calc(var(--chip-bottom,0px)_+_0.5rem)),calc(max(0.75rem,env(safe-area-inset-top))_+_10.5rem_-_clamp(0px,calc((8rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_10.5rem_-_max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1))_+_0.5rem))))_*_10000),100vh)))_-_max(0px,min(max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem)),calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(max(max(0.75rem,env(safe-area-inset-top)),calc(var(--chip-bottom,0px)_+_0.5rem)),calc(max(0.75rem,env(safe-area-inset-top))_+_10.5rem_-_clamp(0px,calc((8rem_-_calc(calc(100dvh_/_var(--ui-zoom,1))_-_max(0.75rem,env(safe-area-inset-top))_-_10.5rem_-_max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1))_+_0.5rem))))_*_10000),100vh)))_-_1.875rem))))]',
  console: 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] bottom-[max(0.75rem,env(safe-area-inset-bottom))] mx-auto max-w-[28rem] max-h-[calc(calc(55dvh_/_var(--ui-zoom,1))_-_4rem)]',
} as const

/** A media query as a stable external store (the HUD's and the Concierge's compact query). */
function mediaStore(query: string) {
  let list: MediaQueryList | null = null
  const media = () => (list ??= window.matchMedia(query))
  return {
    subscribe(onChange: () => void) {
      const m = media()
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    matches: () => media().matches,
    server: () => false,
  }
}
const SMALL = mediaStore('(max-width: 639px), (max-height: 499px)')
/** A short screen held sideways (Concierge.tsx's short layout in landscape): no room above the thumbs, so the card stands between them. */
const SIDEWAYS = mediaStore('(orientation: landscape) and (max-height: 499px)')
/**
 * SMALL at the text size's zoom: the window, measured in the zoom's pixels, is a small screen's. The wide place under
 * the HUD's readout is 24.75 rem down a window of zoomed rem, so at 200 % a laptop's 800 or 864 px leave the card a
 * sliver; there it takes the compact place at the foot instead (over the HUD, which at that zoom fills the window).
 * At 100 % it is SMALL itself. One store per zoom.
 */
const SQUEEZED = new Map<number, ReturnType<typeof mediaStore>>()
export function squeezedQuery(zoom: number): string {
  const z = Math.max(1, zoom)
  return `(max-width: ${Math.round(639 * z)}px), (max-height: ${Math.round(499 * z)}px)`
}
function squeezedAt(zoom: number): ReturnType<typeof mediaStore> {
  let store = SQUEEZED.get(zoom)
  if (!store) SQUEEZED.set(zoom, (store = mediaStore(squeezedQuery(zoom))))
  return store
}

export interface FirstWalkCardProps {
  /** Shown (pass false while the boot veil covers the page or the city is halted). */
  visible: boolean
  card: StageCard
  /** Sloane's newest line (the stage's ask, or a hint); the ask is shown until one comes. */
  beat: Beat | null
  /** The exit's doors so far. */
  exam: { seal: boolean; swarm: boolean }
  /** The touch overlay on screen (snapshot.supplier.touch), the console open. */
  overlay: boolean
  termOpen: boolean
  /** The accessible path: Sloane does this stage's action. */
  onShow(): void
  /** The last stage: a program line into the console's prompt, and the prompt run. */
  onType(line: string): void
  onRun(): void
  /** Sloane's spoken voice: called once with each new line. */
  onSay?(text: string): void
  /** Sloane's own card is open (Concierge onOpen): anywhere but a wide window from 60 rem across, where the two stand side by side, this card steps aside until hers closes. */
  crowded?: boolean
  /** At the wheel (the HUD's input mode): on a phone held sideways the car's buttons fill the band between the thumbs, and the card steps aside; held upright it folds and waits for a tap. */
  driving?: boolean
  /** The text size's zoom (access.ts scale / 100): the 60 rem are zoomed rem (Concierge.tsx besideRoom). */
  zoom?: number
  /** Metres walked plus driven so far (snapshot.experience): on a phone held upright the open card folds once the visitor has covered a few since it opened, whatever moved them (a paired pad sends no touch). */
  travelled?: number
}

export function FirstWalkCard({ visible, card, beat, exam, overlay, termOpen, onShow, onType, onRun, onSay, crowded = false, driving = false, zoom = 1, travelled }: FirstWalkCardProps): JSX.Element | null {
  const compact = useSyncExternalStore(SMALL.subscribe, SMALL.matches, SMALL.server)
  const sideways = useSyncExternalStore(SIDEWAYS.subscribe, SIDEWAYS.matches, SIDEWAYS.server)
  const tight = squeezedAt(zoom)
  const squeezed = useSyncExternalStore(tight.subscribe, tight.matches, tight.server)
  // Room for Sloane's open card beside this one on a wide screen (Concierge.tsx's own query, at the same zoom).
  const room = besideRoom(zoom)
  const roomy = useSyncExternalStore(room.subscribe, room.matches, room.server)
  /** The HUD's slot for the strip (walkSlot.ts): there while its compact layout is on screen. */
  const slot = useSyncExternalStore(WALK_SLOT.subscribe, WALK_SLOT.get, WALK_SLOT.server)
  /** Between the thumbs of a phone held sideways (the console's place wins while it is open). */
  const between = overlay && sideways && !termOpen
  /** A phone held upright, the touch controls on screen, the console shut, and the HUD up to hold the strip: the card
   *  folds to the strip and opens from it. Without the HUD (the H key) there is nowhere to fold to, and it stays open. */
  const foldable = overlay && !sideways && !termOpen && slot !== null
  /** Side by side with Sloane's open card: only in the wide place, with the room for both. Anywhere else her card
   *  takes the band this one stands in (a phone's, a small window's, the centre of a window small only at the zoom). */
  const besideHers = !overlay && !compact && !squeezed && roomy
  /** Heard: up, and not stepping aside for Sloane's open card where the two cannot stand apart (her card is speaking). */
  const heard = visible && !(crowded && !termOpen && !besideHers)
  /** On screen: heard, and not at the wheel between a sideways phone's thumbs, where the car's buttons leave no band. It
   *  is back once the visitor is on foot; meanwhile Sloane still says each line (the stage the car finished hands over
   *  to the next one at the wheel, and its ask is heard there). */
  const shown = heard && !(between && driving)
  /** How many of the whys are unfolded, and whether the folding card shows all of itself (both reset with the stage). */
  const [whys, setWhys] = useState(0)
  const [more, setMore] = useState(false)
  const [stage, setStage] = useState(card.stage)
  if (stage !== card.stage) { setStage(card.stage); setWhys(0); setMore(false) }
  /** Folded to the strip (it counts only where the card folds). A new line opens the card, except at the wheel, where
   *  it is heard and the strip marks it unread until a tap; getting into a car folds it. Adjusted while rendering, from
   *  the values seen last. */
  const [folded, setFolded] = useState(false)
  const [unread, setUnread] = useState(false)
  const [seenBeat, setSeenBeat] = useState(beat?.id ?? -1)
  if (beat && beat.id !== seenBeat) { setSeenBeat(beat.id); setFolded(driving); setUnread(driving) }
  const [seenDriving, setSeenDriving] = useState(driving)
  if (driving !== seenDriving) { setSeenDriving(driving); if (driving) setFolded(true) }
  const open = !(foldable && folded)
  const sayRef = useRef(onSay)
  useEffect(() => { sayRef.current = onSay }, [onSay])
  const said = useRef(-1)
  useEffect(() => {
    if (!beat || beat.id === said.current) return
    // A line that comes while the card is away (not heard) waits for it, except a hint: that came while the visitor was
    // busy in another card (the wardrobe, a shop's, a home's, Sloane's own), and closing that card has often done what it
    // asks, so it is let go unspoken rather than said a moment before the next stage's line cuts it off. At the wheel
    // between a sideways phone's thumbs the card is off screen but still heard, so its lines are spoken there; a card
    // folded to its strip is heard too.
    if (!heard) { if (beat.kind === 'hint') said.current = beat.id; return }
    said.current = beat.id
    sayRef.current?.(beat.text)
  }, [beat, heard])
  // The open card folds when the visitor is under way: a touch that lands outside it and its strip (the stick, the look
  // area, a button, Sloane's chip), as Sloane's own card settles into her chip, or a few metres covered since it opened
  // (a paired pad, Sloane walking for them). Only where it folds, and only while it is on screen.
  const cardRef = useRef<HTMLElement>(null)
  const stripRef = useRef<HTMLButtonElement>(null)
  const lineRef = useRef<HTMLParagraphElement>(null)
  /** Focus is on one of the open card's buttons: when a fold takes the card away it goes to the strip, not the page. */
  const focusIn = useRef(false)
  const folding = foldable && shown && open
  const onOutside = useEffectEvent((e: PointerEvent) => {
    if (e.pointerType === 'mouse') return
    const at = e.target instanceof Node ? e.target : null
    if (at && (cardRef.current?.contains(at) || stripRef.current?.contains(at))) return
    setFolded(true)
  })
  useEffect(() => {
    if (!folding) return
    const down = (e: PointerEvent) => onOutside(e)
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [folding])
  useLayoutEffect(() => {
    if (open && shown) return
    if (!focusIn.current) return
    focusIn.current = false
    if (!document.activeElement || document.activeElement === document.body) stripRef.current?.focus({ preventScroll: true })
  }, [open, shown])
  const travelFrom = useRef(Number.NaN)
  useEffect(() => { travelFrom.current = Number.NaN }, [folding, seenBeat])
  useEffect(() => {
    if (!folding || travelled === undefined || !Number.isFinite(travelled)) return
    if (Number.isNaN(travelFrom.current)) travelFrom.current = travelled
    else if (travelled - travelFrom.current >= FOLD_METRES) setFolded(true)
  }, [folding, travelled])

  // The strip, in the HUD's own column under its header (a portal: it is drawn with the HUD's panels and zoomed with
  // them, and stays while Sloane's open card has this card step aside): the stage's number and title, and a tap opens
  // or folds the card. It is not shown where the card itself is put away whole (the wardrobe, a shop's card, a halt).
  const line = beat && beat.stage === card.stage ? beat.text : card.ask
  // With the strip the line is told from beside it (a live region that stays while the card folds and opens), so a
  // reader hears each new line, folded or not; the open card's own line is then not a live region too.
  const strip = visible && foldable && slot !== null && createPortal(
    <>
    <button
      ref={stripRef}
      type="button"
      onClick={() => { setFolded(open && shown); setUnread(false) }}
      aria-expanded={open && shown}
      aria-label={`Your first walk, ${card.index} of ${card.count}: ${card.title}.${unread ? ` A new line from ${CONCIERGE_NAME}.` : ''} ${open && shown ? 'Fold' : 'Show'} ${CONCIERGE_NAME}’s line.`}
      data-walk-strip={card.stage}
      data-walk-unread={unread || undefined}
      className="noir-panel pointer-events-auto flex max-w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left font-noir-text text-[12px] leading-4 text-noir-titanium-200 antialiased focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-noir-crimson"
    >
      <span className={`inline-block h-2 w-2 shrink-0 rounded-full bg-noir-crimson ${unread ? 'animate-pulse motion-reduce:animate-none' : ''}`} aria-hidden="true" />
      <span className="shrink-0 tabular-nums text-noir-titanium-400">{card.index} of {card.count}</span>
      <span className="min-w-0 truncate font-semibold text-noir-titanium-100">{card.title}</span>
      <svg viewBox="0 0 12 12" className={`h-3 w-3 shrink-0 text-noir-titanium-400 ${open && shown ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M2.5 4.5 6 8l3.5-3.5" />
      </svg>
    </button>
    <span className="sr-only" role="status" aria-live="polite" data-walk-told>{CONCIERGE_NAME}: {line}</span>
    </>,
    slot,
  )
  const exitStage = card.stage === 'exam'
  /** Where it folds the card is short: the line cut to the lines the band has room for over the button, the rest
   *  behind More (the strip above carries the stage's number and title, so the card's own header is left out). */
  const brief = foldable && !more
  // The short card's lines: measured from the card as it is laid out (its greatest height is the band, resolved by
  // the browser from the touch layer's and Sloane's published edges), and again when the window, those edges (the
  // root's style) or the card's own box change. Set before the browser paints.
  const [fit, setFit] = useState({ ...UNMEASURED, below: false })
  const measuring = brief && shown && open
  const measure = useEffectEvent(() => {
    const el = cardRef.current, text = lineRef.current
    if (!el || !text) return
    const box = getComputedStyle(el)
    const px = (v: string) => Number.parseFloat(v) || 0
    const kids = Array.from(el.children) as HTMLElement[]
    const all = kids.reduce((sum, k) => sum + k.offsetHeight, 0) + px(box.rowGap) * Math.max(0, kids.length - 1)
      + px(box.paddingTop) + px(box.paddingBottom) + px(box.borderTopWidth) + px(box.borderBottomWidth)
    const next = fitLines(px(box.maxHeight), all - text.offsetHeight, px(getComputedStyle(text).lineHeight), text.scrollHeight)
    // Under Sloane's chip, or above it where the band under it is short (AT.touch): only under it may touches go
    // through the card's words (above it they would reach the HUD's strip or the microphone's badge).
    const chip = document.querySelector('[data-concierge="chip"]')
    const pill = chip?.closest('[role="group"]') ?? chip
    const below = !pill || el.getBoundingClientRect().top >= pill.getBoundingClientRect().bottom - 1
    setFit((f) => (f.lines === next.lines && f.whole === next.whole && f.below === below ? f : { ...next, below }))
  })
  useLayoutEffect(() => {
    if (!measuring) return
    measure()
    const again = () => measure()
    const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(again) : null
    if (cardRef.current) sized?.observe(cardRef.current)
    const edges = typeof MutationObserver === 'function' ? new MutationObserver(again) : null
    edges?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', again)
    return () => { sized?.disconnect(); edges?.disconnect(); window.removeEventListener('resize', again) }
  }, [measuring, line, card.stage])
  if (!shown || !open) return strip || null

  const at = termOpen ? AT.console : between ? AT.between : overlay ? AT.touch : compact || squeezed ? AT.compact : AT.wide
  /** Opened out with More, the folding card takes the band from the minimap's row down. */
  const place = foldable && more ? AT.touchMore : at
  /** The short card, when all of it fits, takes touches on its buttons only: a finger on its words reaches the look
   *  area or the stick under it (and folds the card, as any touch outside does). The last stage's card holds the
   *  program and scrolls, so it keeps its touches; so does a short card too tall for its band, and one standing above
   *  Sloane's chip. */
  const through = brief && !exitStage && fit.whole && fit.below
  return (
    <>
      {strip}
      {/* The text size's zoom (index.css .ui-zoom) on a layer of its own over the whole screen, which lets the city's
          pointer through; the card takes it back. */}
      <div className="ui-zoom pointer-events-none absolute inset-0 z-[1050]">
        <section
          ref={cardRef}
          role="region"
          aria-label={`Your first walk, ${card.index} of ${card.count}: ${card.title}`}
          data-walk={card.stage}
          data-walk-index={card.index}
          data-walk-through={through || undefined}
          onFocus={() => { focusIn.current = true }}
          onBlur={(e) => { if (e.relatedTarget instanceof Node && !cardRef.current?.contains(e.relatedTarget)) focusIn.current = false }}
          className={`noir-panel absolute flex flex-col overflow-y-auto overscroll-contain font-noir-text text-noir-titanium-200 antialiased ${through ? 'pointer-events-none' : 'pointer-events-auto'} ${foldable ? 'gap-2 p-3' : 'gap-2.5 p-3.5'} ${place}`}
        >
          {!foldable && (
            <>
              <header className="flex items-center gap-2">
                <span className="inline-block h-2 w-2 shrink-0 rounded-full bg-noir-crimson" aria-hidden="true" />
                <span className="noir-label">Your first walk</span>
                <span className="ml-auto text-[12px] tabular-nums text-noir-titanium-400">{card.index} of {card.count}</span>
              </header>
              <div className="flex gap-1" aria-hidden="true">
                {Array.from({ length: card.count }, (_, i) => (
                  <span key={i} className={`h-1 flex-1 rounded-full ${i < card.index - 1 ? 'bg-noir-titanium-400' : i === card.index - 1 ? 'bg-noir-crimson' : 'bg-noir-titanium-800'}`} />
                ))}
              </div>
              <h2 className="text-[17px] font-semibold leading-[22px] text-noir-titanium-100">{card.title}</h2>
            </>
          )}
          <p ref={lineRef} className={`shrink-0 text-[15px] leading-5 text-noir-titanium-100 ${brief ? 'line-clamp-3' : ''}`} style={brief ? { WebkitLineClamp: fit.lines } : undefined} aria-live={foldable ? undefined : 'polite'} data-walk-line>
            <span className="text-noir-titanium-400">{CONCIERGE_NAME}: </span>{line}
          </p>
          {!brief && <p className="text-[13px] leading-[18px] text-noir-titanium-400">{card.eli8}</p>}

          {exitStage && (
            <div className="flex flex-col gap-1.5">
              <pre className="overflow-x-auto rounded-noir-control border border-noir-titanium-800 bg-noir-ink-2 px-3 py-2 font-noir-mono text-[12px] leading-[18px] text-noir-titanium-100" aria-label="The program">
                {PROGRAM.map((l, i) => <div key={i}>noir {l}</div>)}
              </pre>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Type the program">
                {PROGRAM.map((l, i) => (
                  <button key={i} type="button" onClick={() => onType(`noir ${l}`)} className="noir-button" data-walk-line-button={i + 1}>Line {i + 1}</button>
                ))}
                <button type="button" onClick={onRun} className="noir-button is-active" data-walk-run>Run</button>
              </div>
              <div className="flex gap-3 text-[12px] text-noir-titanium-400" aria-live="polite" data-walk-doors>
                <span data-door="seal">{exam.seal ? '✓' : '○'} seal</span>
                <span data-door="swarm">{exam.swarm ? '✓' : '○'} swarm</span>
                <span data-door="city">○ city</span>
              </div>
            </div>
          )}

          {!brief && whys > 0 && (
            <ol className="flex flex-col gap-1.5 text-[13px] leading-[18px] text-noir-titanium-200" aria-label="The five whys" data-walk-whys={whys}>
              {card.whys.slice(0, whys).map((w, i) => <li key={i} className="border-l-2 border-noir-titanium-800 pl-2.5">{w}</li>)}
            </ol>
          )}

          <div className="flex shrink-0 flex-wrap items-center gap-2 [&>button]:pointer-events-auto">
            {!brief && whys < card.whys.length && (
              <button type="button" onClick={() => setWhys((n) => n + 1)} className="noir-button" data-walk-why>{whys === 0 ? 'Why?' : 'And why?'}</button>
            )}
            <button type="button" onClick={onShow} className="noir-button" data-walk-show>{card.show}</button>
            {foldable && <button type="button" onClick={() => setMore((m) => !m)} aria-expanded={more} className="noir-button" data-walk-more>{more ? 'Less' : 'More'}</button>}
          </div>
          {!brief && <p className="text-[11px] leading-4 text-noir-titanium-600">No skip: the city opens when the program on the last card has run.</p>}
        </section>
      </div>
    </>
  )
}
