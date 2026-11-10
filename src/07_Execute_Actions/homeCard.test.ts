// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the doorstep's home card (HomeCard.tsx) and the deed rows of Lintel & Lumen's card
 * (StoreCard.tsx) to their promises, which Node cannot render, so it reads their source as the other wiring tests do.
 * Each of the seven homes has one line about it, and every line, every sky-floor note and every deed name passes the
 * 14A screen, carries no armed word, names no real place and avoids the banned word. Only the two tower deeds say that
 * their sky floor opens later. The card buys through the shopkeeper's gate on line 224 + the home, offers Claim (free)
 * for the free loft, shows the gate's reason when it refuses, and marks what the smoke test looks for. Esc, B, the
 * close button and Done put it away through the host, in a capture-phase listener that never takes H or `. The store
 * card's deed rows have Visit or Go home, off with the reason as the title, an address line, and a purchase line that
 * says where the home stands.
 * What breaks if it is removed? A tagline could fail the screen or name a real place, the card could buy around the
 * gate or swallow the HUD's key, and the deed rows could lose the way to the home without anyone noticing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { forbiddenWordIn } from '../01_Initialize_World/assets/cc0.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { REAL_PLACES } from '../../tools/world/real-places.mjs'
import { itemById } from './storeCatalog.ts'
import { PAD, padStep, padsFor } from './padNav.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const flat = (s: string) => s.replace(/\s+/g, ' ')
const card = read('./HomeCard.tsx')
const store = flat(read('./StoreCard.tsx'))

/** The single-quoted strings of the source between `start` and the next `end`, unescaped. */
function stringsIn(src: string, start: string, end: string): string[] {
  const a = src.indexOf(start)
  assert.ok(a >= 0, `missing ${start}`)
  const b = src.indexOf(end, a + start.length)
  assert.ok(b > a, `no end after ${start}`)
  return [...src.slice(a + start.length, b).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1'))
}

const LINES = stringsIn(card, 'const HOME_LINES: readonly string[] = Object.freeze([', '])')
const NOTES = stringsIn(card, 'const SKY_NOTES: Readonly<Record<number, string>> = Object.freeze({', '})')

/** The words conduct.test.ts calls armed (its ARMED), as whole words with their common forms. */
const ARMED = /\b(?:guns?|gunfire|firearms?|rifles?|pistols?|handguns?|shotguns?|revolvers?|weapons?|weaponry|holsters?|ammo|ammunition|bullets?|knife|knives|blades?|swords?|katanas?|machetes?|daggers?|grenades?|bombs?|explosives?|muzzles?|snipers?|shoot(?:s|ing|ers?)?|shots?|melee|combat|armed|arsenal|turrets?|missiles?|rockets?|punch(?:es|ing|ed)?|fights?|fighting|attacks?|attacking)\b/i
/** The shipped source's real-place scan (compliance.test.ts REAL_PLACES). */
const SHIPPED_PLACES = /\b(?:Toronto|Ontario|Mississauga|Brampton|Scarborough|Etobicoke|Markham|Oakville|Burlington|Oshawa|Pickering|Vaughan|Richmond Hill|Hamilton|Niagara|Cambridge|Galt|Hespeler|Harbourfront|Queens? Quay|Yonge|Gardiner|Don Valley|Humber|CN Tower|Rogers Centre|Scotiabank)\b/

/** A line the card shows: admitted by the 14A screen, unarmed, fictional, and free of the banned word. */
function clean(what: string, text: string): void {
  assert.ok(screen(text).admissible, `${what} fails the screen: ${JSON.stringify(text)}`)
  assert.equal(text.match(ARMED), null, `${what} is armed: ${JSON.stringify(text)}`)
  assert.equal(forbiddenWordIn(text), null, `${what}: the asset gate refuses ${JSON.stringify(text)}`)
  assert.equal(text.match(SHIPPED_PLACES), null, `${what} names a real place: ${JSON.stringify(text)}`)
  for (const place of REAL_PLACES) {
    assert.ok(!new RegExp(`\\b${place.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text), `${what} names ${place}: ${JSON.stringify(text)}`)
  }
  assert.doesNotMatch(text, /matrix/i, what)
}

test('one line per home, each a sentence; they, the sky-floor notes and the seven deed names all pass the screen', () => {
  assert.equal(LINES.length, 7, 'one line for each of the seven homes')
  assert.equal(new Set(LINES).size, 7, 'no two homes share a line')
  for (const [i, line] of LINES.entries()) {
    assert.match(line, /^[A-Z].{20,110}\.$/, `home ${i}: a full sentence of one line`)
    clean(`home ${i}'s line`, line)
  }
  for (const note of NOTES) clean('a sky-floor note', note)
  for (let i = 0; i < 7; i++) {
    const deed = itemById(224 + i)
    assert.ok(deed && deed.kind === 'deed' && deed.index === i, `deed ${224 + i} is home ${i}'s`)
    clean(`deed ${deed.id}`, deed.name)
  }
  // The card's other fixed words.
  for (const words of ['Claim (free)', 'Buy', 'Yours', 'Also sold at', 'Esc or B closes', 'Your civic credits']) {
    assert.ok(card.includes(words), `the card says ${words}`)
    clean('the card', words)
  }
})

test('only the Penthouse and the Sky-Mansion say that their sky floor opens later', () => {
  assert.equal(NOTES.length, 2)
  const keys = [...card.slice(card.indexOf('const SKY_NOTES'), card.indexOf('})', card.indexOf('const SKY_NOTES'))).matchAll(/\n\s*(\d+):/g)].map((m) => Number(m[1]))
  assert.deepEqual(keys, [3, 6])
  assert.deepEqual([itemById(227)?.name, itemById(230)?.name], ['Crimson Tower Penthouse', 'Crown Spire Sky-Mansion'])
  for (const note of NOTES) assert.match(note, /^The residence at the foot of .+ \(the sky floor opens later\)\.$/)
  assert.match(NOTES[0], /Crimson Tower/)
  assert.match(NOTES[1], /Crown Spire/)
})

test('the card buys the deed through the shopkeeper\'s gate, offers Claim for the free loft, and shows the reason when refused', () => {
  const src = flat(card)
  assert.ok(src.includes('const DEED = 224'), 'home h is catalogue line 224 + h')
  assert.ok(src.includes("const item = home !== null ? itemById(DEED + home) : null"))
  assert.ok(src.includes("const open = visible && item !== null && item.kind === 'deed'"), 'only a deed is shown')
  assert.ok(src.includes('const r = keeper.buy(item.id)'), 'the one shopkeeper, so the doorstep and the design house agree')
  assert.ok(!/purchaseGate|purse\.buy|saveShop/.test(src), 'never around the shopkeeper')
  assert.ok(src.includes("{free ? 'Claim (free)' : 'Buy'}"))
  assert.ok(src.includes('const free = item.price === 0'))
  assert.ok(src.includes('disabled={verdict !== GATE.bought}'), 'Buy only when the gate would sell')
  assert.ok(src.includes('data-why>{row?.why'), 'the gate\'s reason, in words')
  assert.ok(src.includes('data-yours>Yours</span>'), 'an owner sees Yours')
  assert.ok(src.includes('{!owned && <p'), 'the design house is named to a buyer')
  assert.ok(src.includes('Also sold at {SHOP_INFO.designHouse.name}'))
  assert.ok(src.includes('const sky = SKY_NOTES[home]'))
  // What the smoke test and the wiring tests look for.
  for (const mark of ['data-home={home}', 'data-owned={owned || undefined}', 'data-action="buy"', 'data-action="done"', 'data-purse>', 'data-said>', 'data-place>{address}']) {
    assert.ok(src.includes(mark), `missing ${mark}`)
  }
  // Every button is big enough for a finger and marked for touch.
  assert.ok(src.includes("const BUTTON = 'min-h-12 "))
  const buttons = src.match(/<button[^>]*>/g) ?? []
  assert.ok(buttons.length >= 3)
  for (const b of buttons) assert.ok(b.includes('${BUTTON}') && b.includes('data-touch'), b)
  // Imports point down: no saved record, no wardrobe, no properties module in the card.
  assert.ok(!/from '\.\.\/05_Observe_Environment|from '\.\.\/03_Spawn_Agents|properties\.ts'/.test(src))
})

test('Esc, B, the close button and Done put the card away through the host; H and ` are never the card\'s', () => {
  const src = flat(card)
  assert.ok(src.includes("window.addEventListener('keydown', onKey, true)"), 'captured, as the store card\'s')
  assert.ok(src.includes("window.removeEventListener('keydown', onKey, true)"))
  const closes = src.slice(src.indexOf('function closes('), src.indexOf('}', src.indexOf('function closes(')))
  assert.ok(closes.includes("e.key === 'Escape'"))
  assert.ok(closes.includes("e.code === 'KeyB' && !e.repeat"), 'a held B that opened the card never closes it')
  assert.ok(closes.includes('!isEditableTarget(e.target)'))
  assert.ok(!/KeyH|Backquote|'`'/.test(src), 'the HUD\'s H and the console\'s ` are never taken')
  assert.ok(src.includes('if (!closes(e)) return e.preventDefault() e.stopPropagation() onClose()'), 'only a closing key is stopped')
  assert.equal(src.match(/onClick=\{onClose\}/g)?.length, 2, 'the close button and Done')
  assert.ok(src.includes('aria-label="Close"'))
  assert.ok(src.includes('usePadNav(cardRef, open && pad, padFrom)'), 'a pad presses and moves between the buttons, unless the host hands the pad elsewhere; only the player\'s pads')
  assert.ok(src.includes('dark = false, pad = true, padFrom, onClose }: HomeCardProps'), 'the pad is the card\'s unless the host says otherwise')
})

test('the store card\'s deed rows: Visit or Go home, off with the reason, an address line, a purchase that says where, furniture on order', () => {
  assert.ok(store.includes('onGo?: (item: StoreItem) => void'))
  assert.ok(store.includes('whereFor?: (item: StoreItem) => Where | null'))
  assert.ok(store.includes('type Where = { line: string; why: string | null }'))
  assert.ok(store.includes("{item.kind === 'deed' && onGo && ("), 'only a deed\'s row has the button')
  assert.ok(store.includes('const goOff = where === null || where.why !== null'))
  assert.ok(store.includes('disabled={goOff} title={where?.why ?? undefined}'), 'off, with the reason as its title')
  assert.ok(store.includes('data-action="go"'))
  assert.ok(store.includes("{owned ? 'Go home' : 'Visit'}"))
  assert.ok(store.includes('data-place>{place}</div>'), 'where the home stands, and why Visit cannot go')
  assert.ok(store.includes("const place = where ? [where.line, where.why].filter(Boolean).join(' · ') : ''"))
  assert.ok(store.includes("setSaid({ shop, text: line ? `${item.name} is yours: ${line}` : `${item.name} is yours` })"), 'the purchase says where')
  assert.ok(store.includes("later.some((r) => r.item.kind === 'furniture') && 'Furniture arrives with furnishing.'"))
  assert.ok(!store.includes('open with the properties'))
})

test('in split screen the card reads only the player\'s pads: another seat\'s A and d-pad never press or move through it', () => {
  const pad = (...held: number[]) => ({ buttons: Array.from({ length: 16 }, (_, b) => ({ pressed: held.includes(b) })) })
  const mine = (i: number) => i === 1
  // Both pads present at the first poll; then pad 0 (player 2's) presses A and the d-pad: nothing for the card.
  const first = padStep(new Set(), padsFor([pad(), pad()], mine))
  assert.equal(padStep(first.held, padsFor([pad(PAD.a), pad()], mine)).action, null, 'player 2\'s A')
  assert.equal(padStep(first.held, padsFor([pad(PAD.right), pad()], mine)).action, null, 'player 2\'s d-pad')
  // Pad 1 (player 1's) presses A: the card's.
  assert.equal(padStep(first.held, padsFor([pad(), pad(PAD.a)], mine)).action, 'press')
  // With no filter (one player), every pad reaches it, as before.
  const all = padStep(new Set(), padsFor([pad(), pad()]))
  assert.equal(padStep(all.held, padsFor([pad(PAD.a), pad()])).action, 'press')
  // The host's filter: seat 0's pads in split screen, stable across renders.
  const app = read('../App.tsx').replace(/\s+/g, ' ')
  assert.ok(app.includes('const playerOnePad = useCallback((padIndex: number) => engineRef.current?.input.playerOnePad(padIndex) ?? true, [])'))
  assert.ok(app.includes('padFrom={playerOnePad}'))
  assert.match(read('./padNav.ts'), /padStep\(prev \?\? new Set\(\), padsFor\(readPads\(\), accept\), pageHand\(\)\)/)
})
