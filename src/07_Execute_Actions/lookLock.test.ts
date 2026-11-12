// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the wardrobe's shop lock (lookLock.ts) to the decision of 2026-11-12: every worn
 * line a shop sells locks what it sells until it is bought, and nothing else is locked; the atelier's limbs, glasses
 * and hearing aids never lock; a design is held on every zone and its rolled sleeves stay free; the coat is the
 * tailor's in every colour, the one no line sells too, and a colour's own overcoat opens that colour alone; what the
 * look wore before stays on; a preset, a seed's look or a code is worn with what is held put back, never with anything
 * held left on, and a look that wears only what is bought or kept passes unchanged; the console refuses a held slot or
 * garment in words that name the line, the shop, where it stands, the price and the level, and fits the rest; the
 * card and the console are wired to it (the card's rows, the presets, the code, App's console knob), and agents' looks
 * stay free.
 * What breaks if it is removed? The lock could leak (a preset or a code wearing what nobody bought), lock what no shop
 * sells, lock someone's own body, or strip what a returning player already wears.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SHOP_INFO } from '../01_Initialize_World/storefronts.ts'
import { LAYER, LOOK_PRESETS, LOOK_SLOTS, WARDROBE, lookFromSeed, lookOptions, withLookSlot, type Look, type LookBody, type LookSlot } from '../03_Spawn_Agents/look.ts'
import { TATTOO_MOTIFS, TATTOO_ZONES } from '../03_Spawn_Agents/tattoo.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { CATALOGUE, onSale, wearItem, type StoreItem } from './storeCatalog.ts'
import {
  FREE_SHOPS, HOW_WORN, LOCKED_LINES, LOOK_LOCKS, changeLookLocked, fitLook, heldBy, heldWords, holding, lockLabel, lockWords, wornFromShops, type Owns,
} from './lookLock.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const nothing: Owns = () => false
const everything: Owns = () => true
const only = (...ids: number[]): Owns => (i) => ids.includes(i.id)
const zones = TATTOO_ZONES.map((z) => z.slot).filter((s) => (LOOK_SLOTS as readonly string[]).includes(s)) as LookSlot[]
/** A plain suit with nothing a shop sells on it: no tie, no coat, no trim, no scarf, no bag, no design. */
const plain: Look = Object.freeze({ ...LOOK_PRESETS[0].look, tie: 0 })
const slotsOf = (l: Look) => LOOK_SLOTS.map((s) => l[s]).join(',')

test('the lines that lock: every worn line on sale but the atelier\'s, and nothing locks a plain suit', () => {
  const want = CATALOGUE.filter((i) => i.kind === 'wear' && onSale(i) && i.shop !== 'prosthetics').map((i) => i.id)
  assert.deepEqual(LOCKED_LINES.map((i) => i.id), want)
  assert.ok(want.length >= 40, 'the tailor, the ink studio and the watch shop: forty-odd lines')
  assert.deepEqual([...FREE_SHOPS], ['prosthetics'])
  assert.deepEqual([...HOW_WORN], ['sleeves'])
  assert.equal(LOOK_LOCKS.length, LOCKED_LINES.length + 1, 'one lock a line, and the coat itself')
  assert.deepEqual(holding(plain, plain, nothing), [])
  assert.equal(heldBy(plain, plain, nothing), null)
})

test('every locked line holds what it sells until it is bought, and stops once bought, or kept on from before', () => {
  for (const line of LOCKED_LINES) {
    const worn = wearItem(plain, line)
    assert.ok(worn, `${line.name} dresses the plain suit`)
    assert.equal(heldBy(worn, plain, nothing), line, `${line.name}: held by its own line`)
    assert.equal(heldBy(worn, plain, only(line.id)), null, `${line.name}: open once bought`)
    assert.equal(heldBy(worn, worn, nothing), null, `${line.name}: kept on when worn before`)
  }
})

test('the atelier\'s limbs, glasses and hearing aids are never locked: nobody buys their own body', () => {
  const body = plain.body as LookBody
  for (const slot of ['prosthetic', 'prostheticFinish', 'eyewear', 'frames', 'hearing'] as LookSlot[]) {
    for (let v = 0; v < lookOptions(body, slot, plain.layer).length; v++) {
      const next = withLookSlot(slot === 'frames' ? withLookSlot(plain, 'eyewear', 1)! : plain, slot, v)
      if (next) assert.equal(heldBy(next, plain, nothing), null, `${slot} ${v}`)
    }
  }
  for (const line of CATALOGUE.filter((i) => i.shop === 'prosthetics' && i.kind === 'wear')) assert.equal(heldBy(wearItem(plain, line)!, plain, nothing), null, line.name)
  assert.equal(WARDROBE.hearing.length, 5, 'every hearing device free')
})

test('a design is held on every zone, its sleeves stay free, and the wardrobe\'s own designs are free', () => {
  const olive = LOCKED_LINES.find((i) => i.wear?.tattooForearm === 1)!
  assert.equal(olive.name, 'Fine-line olive branch')
  for (const zone of zones) {
    const next = withLookSlot(plain, zone, 1)
    if (!next) continue
    assert.equal(heldBy(next, plain, nothing), olive, `the olive branch held on ${zone}`)
    assert.equal(heldBy(next, plain, only(olive.id)), null, `and open on ${zone} once bought`)
  }
  const sold = new Set(LOCKED_LINES.flatMap((i) => (i.wear && 'tattooForearm' in i.wear ? [i.wear.tattooForearm] : [])))
  assert.equal(sold.size, 12)
  for (const m of TATTOO_MOTIFS) {
    if (sold.has(m.id)) continue
    assert.equal(heldBy(withLookSlot(plain, 'tattooHand', m.id)!, plain, nothing), null, `${m.name} is the wardrobe's own`)
  }
  assert.equal(heldBy(withLookSlot(plain, 'sleeves', 1)!, plain, nothing), null, 'rolled sleeves are free')
  // A design kept on one zone is kept on every zone while the card is open.
  const kept = withLookSlot(plain, 'tattooForearm', 1)!
  assert.equal(heldBy(withLookSlot(kept, 'tattooHand', 1)!, kept, nothing), null)
})

test('the coat is the tailor\'s in every colour: its own overcoat opens a colour, any overcoat opens the colour no line sells', () => {
  const coats = LOCKED_LINES.filter((i) => i.wear?.layer === LAYER.coat)
  assert.equal(coats.length, 6)
  const coat = (top: number) => withLookSlot(withLookSlot(plain, 'layer', LAYER.coat)!, 'top', top)
  const seventh = coat(6)
  assert.ok(seventh, 'the suit reaches the coat palette\'s seventh colour')
  assert.equal(heldBy(seventh, plain, nothing)?.name, 'Overcoat in charcoal', 'the cheapest overcoat opens it')
  assert.equal(heldBy(seventh, plain, only(coats[3].id)), null, 'any overcoat opens it')
  assert.equal(heldBy(coat(1)!, plain, only(coats[0].id))?.name, 'Overcoat in navy', 'the charcoal overcoat does not open the navy')
  assert.equal(heldBy(coat(1)!, plain, only(coats[1].id)), null)
  // A jacket in the coat's colour is no coat.
  assert.equal(heldBy(withLookSlot(plain, 'top', 1)!, plain, nothing), null)
  // The names a card prints for what is kept on: the coat itself only when no overcoat's line names it.
  assert.deepEqual(wornFromShops(seventh, nothing), ['a coat'])
  assert.deepEqual(wornFromShops(coat(1)!, nothing), ['Overcoat in navy'])
  assert.deepEqual(wornFromShops(coat(1)!, only(coats[1].id)), [])
})

test('fitLook: a preset or a seed\'s look is worn with what the shops hold put back, never with anything held left on', () => {
  for (const p of LOOK_PRESETS) {
    const fit = fitLook(p.look, plain, plain, nothing)
    assert.equal(holding(fit.look, plain, nothing).length, 0, p.name)
    assert.equal(fitLook(p.look, plain, plain, everything).look, p.look, `${p.name}: everything bought, worn as it is`)
    assert.deepEqual(fitLook(p.look, plain, plain, everything).held, [])
  }
  for (let seed = 0; seed < 400; seed++) {
    const fit = fitLook(lookFromSeed(seed), plain, plain, nothing)
    assert.equal(holding(fit.look, plain, nothing).length, 0, `seed ${seed}`)
  }
  // The charcoal suit: the coat goes back to the jacket (keeping the navy cloth), the tie and the briefcase come off.
  const charcoal = LOOK_PRESETS.find((p) => p.name === 'charcoal suit')!.look
  const fit = fitLook(charcoal, plain, plain, nothing)
  assert.equal(fit.look.layer, plain.layer)
  assert.equal(fit.look.top, charcoal.top)
  assert.equal(fit.look.tie, 0)
  assert.equal(fit.look.bag, 0)
  assert.deepEqual(fit.held.map((i) => i.name), ['Overcoat in navy', 'Silk tie', 'Leather briefcase'])
  assert.equal(heldWords(fit.held), 'Overcoat in navy (Verrin & Vale Tailors, 400 cr), Silk tie (Verrin & Vale Tailors, 120 cr), Leather briefcase (Escapement Row Horology, 300 cr)')
  // Everything but the hair kept: what the look wore before is never stripped.
  const changed = withLookSlot(charcoal, 'hairColour', (charcoal.hairColour + 1) % 4)!
  assert.equal(slotsOf(fitLook(changed, charcoal, charcoal, nothing).look), slotsOf(changed))
})

test('the console: a held slot or garment refused in words naming the line, the shop, where it stands, the price and the level; a preset fitted', () => {
  const tie = changeLookLocked(plain, { kind: 'slot', slot: 'tie', value: 'tie' }, 1, nothing)
  assert.equal(tie.look, null)
  assert.equal(tie.error, 'Silk tie: sold at Verrin & Vale Tailors, Midtown Avenue, for 120 cr (level 1); buy it there to wear it')
  const bought = changeLookLocked(plain, { kind: 'slot', slot: 'tie', value: 'tie' }, 1, only(24))
  assert.equal(bought.look?.tie, 1)
  const coat = changeLookLocked(plain, { kind: 'slot', slot: 'layer', value: 'coat' }, 1, nothing)
  assert.equal(coat.look, null)
  assert.match(coat.error ?? '', /^Overcoat in /)
  const preset = changeLookLocked(plain, { kind: 'preset', name: 'charcoal suit' }, 1, nothing)
  assert.equal(preset.look?.tie, 0)
  assert.deepEqual(preset.held.map((i) => i.name), ['Overcoat in navy', 'Silk tie', 'Leather briefcase'])
  assert.equal(changeLookLocked(plain, { kind: 'slot', slot: 'nope', value: '1' }, 1, nothing).error, changeLookLocked(plain, { kind: 'slot', slot: 'nope', value: '1' }, 1, everything).error, 'the wardrobe\'s own refusals pass through')
  assert.equal(changeLookLocked(plain, { kind: 'slot', slot: 'hairColour', value: '2' }, 1, nothing).look?.hairColour, 1)
})

test('the lock\'s words: the shop and the price on the card, the 14A screen passes them all', () => {
  const tie = LOCKED_LINES.find((i) => i.name === 'Silk tie') as StoreItem
  assert.equal(lockLabel(tie), 'Verrin & Vale Tailors · 120 cr')
  for (const i of LOCKED_LINES) {
    assert.ok(lockWords(i).includes(SHOP_INFO[i.shop].name) && lockWords(i).includes(SHOP_INFO[i.shop].arcade), i.name)
    assert.equal(screen(lockWords(i)).admissible, true, i.name)
  }
})

test('wired: the card locks the player\'s own look through the shopkeeper, never an agent\'s; the console\'s look passes the lock', () => {
  const card = read('./Customizer.tsx')
  assert.ok(card.includes("keeper?: Pick<Shopkeeper, 'owns' | 'onChange'>"))
  assert.ok(card.includes('useEffect(() => keeper?.onChange(() => setBought((v) => v + 1)), [keeper])'), 'a purchase redraws the card')
  assert.ok(card.includes(': <LookEditor worn={worn} seed={seed} onChange={onChange} owns={owns} t={t} />'), 'the You tab is locked')
  assert.ok(card.includes('<LookEditor worn={worn} seed={seed} onChange={wear} t={t} />'), 'an agent\'s tab is not')
  assert.ok(card.includes('const [kept] = useState(worn)'), 'what the card opened on stays on')
  assert.ok(card.includes('const set = (slot: LookSlot, value: number) => choose(withLookSlot(worn, slot, value), slot)'))
  for (const bundle of ['onClick={() => wearAll(p.look)}', 'onClick={() => wearAll(lookFromSeed(randomSeed()))}', 'onClick={() => wearAll(lookFromSeed(seed))}', 'wearAll(parsed)']) assert.ok(card.includes(bundle), bundle)
  assert.ok(card.includes("onClick={() => choose(next, 'garment')}"), 'a coat among the garments is locked like the layer')
  // The editor wears a look in three places only: a choice the lock let through, a bundle with no lock (an agent's
  // tab), a bundle fitted.
  const editor = card.slice(card.indexOf('function LookEditor('), card.indexOf('function AgentEditor('))
  assert.deepEqual([...editor.matchAll(/\bonChange\(([^)]*)\)/g)].map((m) => m[1]).slice(1), ['next', 'next', 'fit.look'], 'nothing worn around the lock')
  // A locked option stays a pressable button (switch scanning skips a disabled one), says the lock and wears nothing.
  assert.doesNotMatch(card, /\sdisabled=/)
  assert.ok((card.match(/aria-disabled=\{line \? true : undefined\}/g) ?? []).length >= 4, 'swatches, pills, garments and designs')
  const app = read('../App.tsx')
  assert.match(app, /<Customizer\n[\s\S]*?keeper=\{keeper\}\n\s*\/>/)
  assert.ok(app.includes('const r = changeLookLocked(host.worn(), seeded, host.seed(), host.owns)'))
  assert.ok(app.includes('owns: (line) => keeper.owns(line.id),'))
  assert.doesNotMatch(app, /\bchangeLook\(/, 'the console never changes the look around the lock')
})
