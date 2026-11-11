// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the doorstep's home card (HomeCard.tsx) and the deed and furniture rows of Lintel
 * & Lumen's card (StoreCard.tsx) to their promises, which Node cannot render, so it reads their source as the other
 * wiring tests do. Each of the seven homes has one line about it (homeView.ts CITY_LINES, the one list the card and
 * the city share), and every line, every sky-floor note, every deed name and every word the furnishing view says
 * passes the 14A screen, carries no armed word, names no real place and avoids the banned word. Only the two tower
 * deeds say that their sky floor opens later. The card buys through the shopkeeper's gate on line 224 + the home,
 * offers Claim (free) for the free loft, shows the gate's reason when it refuses, and marks what the smoke test looks
 * for. Esc, B, the close button and Done put it away through the host, in a capture-phase listener that never takes H
 * or `. For the owner it is the furnishing view (section 6 and 7 of the homes plan): its keys only, the pad read by
 * padEdges in its own frame loop (a held button ignored), the sticks, every button big enough for a finger, every
 * committed edit handed to the host as a whole record, Undo of 20, and the draft taken away when it closes. The store
 * card's deed rows have Visit or Go home, off with the reason as the title, an address line, a purchase line that says
 * where the home stands, and a warning when a deed leaves too little for any furniture; its furniture says where it
 * goes. The furnishing view's fourth tab, Rest, shows the host's words and rests with its own button, and every
 * sentence a rest at home can say passes the same screen. Its fifth, Staff, shows the player's own agents as a strip
 * of 48 px buttons, each with where the agent is under the name, and the workstations here as a list of 48 px buttons
 * that move the cursor, turns Place and Remove into Post and Stand down, keeps the store and the roster out of the
 * card, and every sentence staffing can say passes the same screen.
 * What breaks if it is removed? A tagline could fail the screen or name a real place, the card could buy around the
 * gate or swallow the HUD's key, the furnishing view could lose a control or an edit, and the deed rows could lose the
 * way to the home without anyone noticing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { forbiddenWordIn } from '../01_Initialize_World/assets/cc0.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { REAL_PLACES } from '../../tools/world/real-places.mjs'
import { itemById } from './storeCatalog.ts'
import { PAD, padEdges, padStep, padsFor } from './padNav.ts'
import { createProgress, restOffer, restTake } from './progress.ts'
import { AT, seal } from '../02_Define_The_Rules/progression.ts'
import { GRID, DEPTH } from '../02_Define_The_Rules/homeGrid.ts'
import { freshHomes, layoutOf, withHome } from '../05_Observe_Environment/homeStore.ts'
import { STAFF_TAB, Visit, type StaffAgent, type StaffHooks } from './furnishVisit.ts'
import type { Shopkeeper } from './shopkeeper.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const flat = (s: string) => s.replace(/\s+/g, ' ')
const card = read('./HomeCard.tsx')
/** The furnishing view's state and edits, its words, the stick and the focus rule (furnishVisit.ts, which Node also runs: furnishVisit.test.ts). */
const visitSrc = read('./furnishVisit.ts')
const store = flat(read('./StoreCard.tsx'))
const view = read('./homeView.ts')

/** The single-quoted strings of the source between `start` and the next `end`, unescaped. */
function stringsIn(src: string, start: string, end: string): string[] {
  const a = src.indexOf(start)
  assert.ok(a >= 0, `missing ${start}`)
  const b = src.indexOf(end, a + start.length)
  assert.ok(b > a, `no end after ${start}`)
  return [...src.slice(a + start.length, b).matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1].replace(/\\(.)/g, '$1'))
}

const LINES = stringsIn(view, 'export const CITY_LINES: readonly string[] = Object.freeze([', '])')
const NOTES = stringsIn(card, 'const SKY_NOTES: Readonly<Record<number, string>> = Object.freeze({', '})')
/** The furnishing view's words for canPlace's verdicts, as the card writes them. */
const VERDICTS = stringsIn(visitSrc, 'const VERDICT_WORDS: Readonly<Record<Verdict, string>> = Object.freeze({', '})')
/** The furniture lines' short names on the plan and in the strip. */
const SHORT = stringsIn(visitSrc, 'const SHORT: Readonly<Record<number, string>> = Object.freeze({', '})')
/** Every button tag of a source, whole: an arrow function's `=>` inside an attribute is not the tag's end. */
const buttonsIn = (src: string): string[] => src.match(/<button(?:=>|[^>])*>/g) ?? []

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
  // The card shows the city's own line for the home (homeView.ts), so the doorstep and the city never tell two stories.
  assert.ok(card.includes("import { CITY_LINES, type Draft } from './homeView.ts'"))
  assert.ok(card.includes('<p className="mt-2 leading-snug" data-tagline>{CITY_LINES[home]}</p>'))
  assert.ok(!card.includes('HOME_LINES'), 'no second list of taglines in the card')
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
  // The card's other fixed words, the furnishing view's among them, and what a visit's edits say (furnishVisit.ts).
  const fixed = [
    'Claim (free)', 'Buy', 'Yours', 'Also sold at', 'Esc or B closes', 'Your civic credits', 'Saved in this browser · Esc or B to finish',
    'Not placed here (', 'Order', 'Rotate', 'Place', 'Remove', 'Undo', 'View', 'Done', 'Clear', 'Furnish ', 'Furniture', 'Floor', 'Walls',
    'Nothing in hand at ', ': Place picks it up, Remove takes it out',
  ]
  for (const words of fixed) {
    assert.ok(card.includes(words), `the card says ${words}`)
    clean('the card', words)
  }
  const said = [
    "'Furniture', 'Floor', 'Walls'", 'picked up: Place puts it down, Undo puts it back', 'Nothing here to pick up: choose a piece in the strip',
    'Nothing here to remove', 'Nothing in hand to turn: choose a piece in the strip', 'Nothing to undo', 'Undone', 'taken out of the home',
    'The pieces not placed here are cleared', ': move it into place and press Place', ' moved', ' placed', 'Floor: ', 'Walls: ',
  ]
  for (const words of said) {
    assert.ok(visitSrc.includes(words), `a visit says ${words}`)
    clean('a visit', words)
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
  // Every button is big enough for a finger and marked for touch: the deed view's three and the furnishing view's 16
  // (Rest among them, in Place's spot in the Rest tab, and the Staff tab's agent and workstation buttons).
  assert.ok(src.includes("const BUTTON = 'min-h-12 "))
  const buttons = buttonsIn(src)
  assert.equal(buttons.length, 19, 'every button tag, read whole')
  for (const b of buttons) assert.ok(b.includes('${BUTTON}') && b.includes('data-touch'), b)
  // Imports point down: no wardrobe and no properties module in the card, and of the saved homes only the pure record
  // helpers: the host loads and saves the record (App.tsx), the card hands it each edit.
  assert.ok(!/from '\.\.\/03_Spawn_Agents|properties\.ts'/.test(src))
  assert.deepEqual([...src.matchAll(/from '\.\.\/05_Observe_Environment\/([^']+)'/g)].map((m) => m[1]), ['homeStore.ts'])
  assert.ok(src.includes("import { finishOf, freshHomes, type HomeRecord } from '../05_Observe_Environment/homeStore.ts'"))
  assert.ok(!/loadHomes|saveHomes|clearHomes|localStorage/.test(src), 'the card never reads or writes the browser\'s store')
  // The visit the same: the record helpers alone, and the purchase only through the shopkeeper the card hands it.
  const visit = flat(visitSrc)
  assert.ok(!/from '\.\.\/03_Spawn_Agents|properties\.ts'/.test(visit))
  assert.deepEqual([...visit.matchAll(/from '\.\.\/05_Observe_Environment\/([^']+)'/g)].map((m) => m[1]), ['homeStore.ts'])
  assert.ok(visit.includes("import { finishOf, layoutOf, withHome, type HomeLayout, type HomeRecord } from '../05_Observe_Environment/homeStore.ts'"))
  assert.ok(!/loadHomes|saveHomes|clearHomes|localStorage|purchaseGate|purse\.buy|saveShop/.test(visit), 'nor does a visit, which buys only through the shopkeeper')
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
  assert.equal(src.match(/onClick=\{onClose\}/g)?.length, 3, 'the close button, the deed view\'s Done and the furnishing view\'s Done')
  assert.ok(src.includes('aria-label="Close"'))
  assert.ok(src.includes('aria-label="Done (Esc)"'))
  assert.ok(src.includes('usePadNav(cardRef, open && pad && !furnishing, padFrom)'), 'in the deed view a pad presses and moves between the buttons, unless the host hands the pad elsewhere; only the player\'s pads; the furnishing view reads its own')
  assert.ok(src.includes('dark = false, pad = true, padFrom, record = NO_RECORD, onRecord, furnish = null, onClose }: HomeCardProps'), 'the pad is the card\'s unless the host says otherwise')
  // The deed view's pad close: East (B) and Menu, by edges, so the press that opened the card never closes it.
  assert.ok(src.includes('const CLOSE_BUTTONS: readonly number[] = Object.freeze([BTN.b, BTN.menu])'))
  assert.ok(src.includes('const { held, down } = padEdges(prev, padsFor(readPads(), padFrom), CLOSE_BUTTONS)'))
  assert.ok(src.includes('if (down.has(BTN.b) || down.has(BTN.menu)) { onClose(); return }'))
})

test('the store card\'s deed rows: Visit or Go home, off with the reason, an address line, a purchase that says where; furniture says where it goes', () => {
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
  // Furniture is on sale now (furnishing opened its kind): only worn lines are still on order, and an owned piece
  // (and the purchase line) says where it goes.
  assert.ok(store.includes("{later.some((r) => r.item.kind === 'wear') && <p className={`mt-1 text-[11px] leading-snug ${t.muted}`}>Worn lines arrive with the wardrobe update.</p>}"))
  assert.ok(!store.includes('Furniture arrives with furnishing'))
  assert.ok(store.includes("{owned && item.kind === 'furniture' && <div className={`text-[11px] leading-snug ${t.muted}`} data-at-home>Place it at home (B)</div>}"))
  assert.ok(store.includes("setSaid({ shop, text: r.verdict === GATE.bought && item.kind === 'furniture' ? `${r.message}: place it at home (B)` : r.message })"))
  // A priced deed the gate would sell, which would leave less than the cheapest furniture on sale, says so on its row.
  assert.ok(store.includes("const cheapest = cheapestOnSale('furniture')"))
  assert.ok(store.includes("if (item.kind !== 'deed' || verdict !== GATE.bought || item.price === 0 || cheapest === null) return null"))
  assert.ok(store.includes('const left = balance - item.price'))
  assert.ok(store.includes('return left < cheapest ? `Leaves ${credits(left)}, less than any furniture` : null'))
  assert.ok(store.includes('{warn && <div className={`text-[11px] leading-snug ${t.warn}`} data-warn>{warn}</div>}'))
  assert.ok(store.includes('balance={w.credits()}'), 'the purse as it is now')
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

test('the furnishing view says the plan\'s words for every verdict, and each furniture line has a short name with its own initial', () => {
  // Section 6 of the homes plan, in canPlace's order; N is the line's cap in one home.
  assert.deepEqual(VERDICTS, [
    'Fits', 'Outside the room', 'Something is already there', 'Keeps the doorway clear', 'Goes against a wall',
    'N of these is the most for one home', '16 pieces is the most a home holds', 'You are standing there',
    'Would cut off part of the room', 'Would block a workstation\'s seat', 'Not yours yet: Order it',
  ])
  const keys = [...visitSrc.slice(visitSrc.indexOf('const VERDICT_WORDS'), visitSrc.indexOf('})', visitSrc.indexOf('const VERDICT_WORDS'))).matchAll(/\n\s*(\w+):/g)].map((m) => m[1])
  assert.deepEqual(keys, ['ok', 'outside', 'overlap', 'doorway', 'wall', 'copies', 'full', 'you', 'sealed', 'seat', 'unowned'])
  assert.ok(visitSrc.includes("VERDICT_WORDS[v].replace(/^N\\b/, String(shapeOf(id)?.cap ?? ''))"), 'N becomes the line\'s cap')
  for (const words of VERDICTS) clean('a verdict', words.replace(/^N\b/, '2'))
  // The nine lines, 160 to 168: each a furniture line in the catalogue, named shortly, no two with one initial on the plan.
  const ids = [...visitSrc.slice(visitSrc.indexOf('const SHORT'), visitSrc.indexOf('})', visitSrc.indexOf('const SHORT'))).matchAll(/\n\s*(\d+):/g)].map((m) => Number(m[1]))
  assert.deepEqual(ids, [160, 161, 162, 163, 164, 165, 166, 167, 168])
  assert.equal(SHORT.length, 9)
  assert.equal(new Set(SHORT.map((n) => n[0])).size, 9, 'each piece\'s initial on the plan is its own')
  for (const [i, name] of SHORT.entries()) {
    const item = itemById(ids[i])
    assert.ok(item && item.kind === 'furniture' && item.index === ids[i] - 160, `line ${ids[i]} is furniture`)
    clean(`line ${ids[i]}'s short name`, name)
  }
})

test('the furnishing view takes only its own keys, in the capture phase: never H, `, Esc or B; Enter on a button reached with Tab stays the button\'s, on one a mouse clicked it places', () => {
  const src = flat(card)
  const body = card.slice(card.indexOf('function keyAct('), card.indexOf('\n}\n', card.indexOf('function keyAct(')))
  assert.ok(body.includes("if (e.code === 'KeyZ' && !e.altKey) return 'undo'"), 'Z, or Ctrl (Cmd) + Z, undoes')
  assert.ok(body.includes('if (e.ctrlKey || e.metaKey || e.altKey) return null'), 'no other chord is taken')
  assert.ok(body.includes('const n = e.shiftKey ? 4 : 1'), 'Shift moves four cells')
  assert.ok(body.includes('default: return null'), 'any other key is the page\'s')
  // Each key's action, as the switch writes it.
  const acts = new Map<string, string>()
  for (const [, codes, act] of body.matchAll(/((?:case '\w+': )+)return ([^\n]+)/g)) {
    for (const [, code] of codes.matchAll(/case '(\w+)'/g)) acts.set(code, act.trim())
  }
  assert.deepEqual(Object.fromEntries(acts), {
    ArrowUp: '{ move: [0, -n] }', KeyW: '{ move: [0, -n] }', ArrowDown: '{ move: [0, n] }', KeyS: '{ move: [0, n] }',
    ArrowLeft: "finish ? 'prev' : { move: [-n, 0] }", ArrowRight: "finish ? 'next' : { move: [n, 0] }",
    KeyA: '{ move: [-n, 0] }', KeyD: '{ move: [n, 0] }',
    Enter: "'place'", NumpadEnter: "'place'", Space: "'place'", KeyR: "'rotate'",
    Delete: "'remove'", Backspace: "'remove'", KeyX: "'remove'", KeyQ: "'prev'", KeyE: "'next'",
    Digit1: '{ tab: 0 }', Digit2: '{ tab: 1 }', Digit3: '{ tab: 2 }', Digit4: '{ tab: 3 }', Digit5: '{ tab: 4 }', KeyC: "'view'",
  })
  for (const never of ['KeyH', 'Backquote', 'Escape', 'KeyB']) assert.ok(!acts.has(never), `${never} is never the furnishing view's`)
  // The listener: captured, skipping a field being typed in, stopping only a key it handles; held, only moves repeat.
  assert.ok(src.includes('origin.key(e.code) if (isEditableTarget(e.target)) return const a = keyAct(e, visit.tab) if (a === null) return'))
  assert.ok(src.includes("if (a === 'place' && origin.byKeys(e.target)) return e.preventDefault() e.stopPropagation()"))
  // How a button got the focus is followed as the focus moves (furnishVisit.ts FocusOrigin, run in furnishVisit.test.ts),
  // never read from :focus-visible at the key, which a mouse-clicked button already matches by then.
  assert.ok(!/matches\(':focus-visible'\)|focusedByKeys/.test(src), 'no :focus-visible test at the key')
  assert.ok(src.includes('const origin = new FocusOrigin()'))
  assert.ok(src.includes('origin.pointerDown(active && e.target instanceof Node && active.contains(e.target) ? active : null)'), 'a press on the focused control is the pointer\'s')
  for (const [type, fn] of [['pointerdown', 'onPointer'], ['click', 'onClick'], ['focusin', 'onFocus']]) {
    assert.ok(src.includes(`document.addEventListener('${type}', ${fn}, true)`), `${type} in the capture phase`)
    assert.ok(src.includes(`document.removeEventListener('${type}', ${fn}, true)`), `${type} let go`)
  }
  assert.ok(src.includes("window.addEventListener('blur', onBlur)") && src.includes("window.removeEventListener('blur', onBlur)"))
  assert.ok(src.includes("if (e.repeat && typeof a === 'string') return visit.run(a)"))
  assert.equal(src.match(/window\.addEventListener\('keydown', onKey, true\)/g)?.length, 2, 'the card\'s close listener and the furnishing view\'s')
})

test('the furnishing view reads the pad in its own frame loop by edges, so a button held as it opens is ignored; the sticks as section 7 says', () => {
  const src = flat(card)
  assert.ok(flat(visitSrc).includes('export const STICK = Object.freeze({ dead: 0.5, first: 300, repeat: 120, turn: 0.15 })'))
  assert.ok(src.includes('const BTN = Object.freeze({ a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, view: 8, menu: 9, up: 12, down: 13, left: 14, right: 15 })'))
  assert.ok(src.includes("[BTN.a]: 'place', [BTN.b]: 'close', [BTN.menu]: 'close', [BTN.x]: 'remove', [BTN.y]: 'rotate', [BTN.lb]: 'prev', [BTN.rb]: 'next', [BTN.lt]: 'tabPrev', [BTN.rt]: 'tabNext', [BTN.view]: 'undo',"))
  assert.ok(src.includes('[BTN.up]: { move: STEP[0] }, [BTN.right]: { move: STEP[1] }, [BTN.down]: { move: STEP[2] }, [BTN.left]: { move: STEP[3] },'))
  assert.ok(src.includes('const pads = padsFor(readPads(), padFrom) const { held, down } = padEdges(prev, pads, PAD_BUTTONS) prev = held'), 'only the player\'s pads, by edges')
  assert.ok(src.includes('raf = requestAnimationFrame(poll)'))
  assert.ok(src.includes("if (!p || p.mapping !== 'standard') continue"), 'the sticks of standard-mapped pads only')
  // The left stick's timing is stickStep's (furnishVisit.test.ts runs it: once, after 300 ms, every 120 ms, a held
  // diagonal never faster, a stick held as the view opens counted once let go).
  assert.ok(src.includes('const stick: StickState = { armed: false, dir: -1, next: 0 }'), 'unarmed until the stick rests')
  assert.ok(src.includes('const dir = stickStep(stick, lx, ly, now) if (dir >= 0) visit.run({ move: STEP[dir] })'))
  assert.ok(src.includes("else if (turn.armed && !turn.held) { turn.held = true; visit.run(rx > 0 ? 'view' : 'unview') }"), 'the right stick turns the view a quarter at a time')
  // padEdges itself: A held on the first poll (the press that opened the card) is learnt, not pressed; held on, still
  // nothing; let go and pressed again, it counts once.
  const pad = (...held: number[]) => ({ buttons: Array.from({ length: 16 }, (_, b) => ({ pressed: held.includes(b) })) })
  const buttons = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 12, 13, 14, 15]
  const first = padEdges(new Set(), [pad(0)], buttons)
  assert.equal(first.down.size, 0, 'the held A is ignored')
  const still = padEdges(first.held, [pad(0)], buttons)
  assert.equal(still.down.size, 0, 'still held: still nothing')
  const up = padEdges(still.held, [pad()], buttons)
  assert.deepEqual([...padEdges(up.held, [pad(0)], buttons).down], [0], 'pressed again: one press')
})

test('the furnishing view: every committed edit reaches the host as the whole record; Undo keeps 20; closing puts a piece in hand back and takes the draft away', () => {
  const src = flat(card)
  // Only an owner, with the engine's leave: otherwise the deed view says why not.
  assert.ok(src.includes('const refusal = open && owned && furnish !== null && home !== null ? furnish.refusal(home) : null'))
  assert.ok(src.includes('const furnishing = open && owned && furnish !== null && onRecord !== undefined && refusal === null'))
  assert.ok(src.includes('{owned && refusal && <p className={`mt-2 text-[12px] leading-snug ${t.muted}`} data-refusal>{refusal}</p>}'))
  assert.ok(src.includes('aria-label={furnishing ? `Furnish ${name}` : name}'))
  assert.ok(src.includes('<Furnisher key={home} home={home} keeper={keeper} record={record} onRecord={onRecord} hooks={furnish}'))
  // The visit (furnishVisit.ts; furnishVisit.test.ts runs it): what stands here is what the engine draws (fitLayout
  // with the lines owned); a piece goes down only where canPlace says.
  const visit = flat(visitSrc)
  assert.ok(src.includes('const [visit] = useState(() => new Visit(home, record, { keeper, onRecord, hooks, onClose, changed }))'), 'one visit per home opened')
  assert.ok(visit.includes('return fitLayout(this.home, this.record[this.home]?.pieces ?? [], (id) => this.owns(id))'))
  assert.ok(visit.includes('return h && canPlace(this.home, fit.placed, h, this.blocked, (id) => this.owns(id))'))
  assert.ok(visit.includes("if (hand && verdict === 'ok') {"))
  // Each edit: the layout before it kept (20 at most), and the whole record handed up (placed first, then the stored).
  assert.ok(visit.includes('export const UNDO_STEPS = 20'))
  assert.ok(visit.includes('this.undoSteps.push({ layout: this.record[this.home] ?? null, lifted: this.lifted, at: this.liftedAt, rot: this.rot }) if (this.undoSteps.length > UNDO_STEPS) this.undoSteps.shift()'))
  assert.ok(visit.includes('this.send(layoutOf(next.floor ?? f.floor, next.wall ?? f.wall, next.placed, next.stored))'))
  assert.ok(visit.includes('this.record = withHome(this.record, this.home, layout) this.produced.add(this.record) this.io.onRecord(this.record)'))
  assert.ok(visit.includes('if ((this.record[this.home] ?? null) !== step.layout) this.send(step.layout)'), 'Undo hands the layout before back')
  // Order buys through the same gate as the design house.
  assert.ok(visit.includes('const r = this.io.keeper.buy(id) if (r.verdict !== GATE.bought) { this.say(r.message); return }'))
  assert.ok(!/purchaseGate|purse\.buy|saveShop/.test(src))
  // The engine begins furnishing, follows the draft, and the visit settles when it ends.
  assert.ok(src.includes('useEffect(() => { hooks.begin(home) }, [hooks, home])'))
  assert.ok(src.includes('useEffect(() => { hooks.setDraft(draft) }, [hooks, draft])'))
  assert.ok(src.includes('useEffect(() => () => visit.settle(), [visit])'))
  const settle = visit.slice(visit.indexOf('settle(): void {'), visit.indexOf('export function stickStep('))
  assert.ok(settle.includes('const back = this.returned(p)') && settle.includes('this.send(layoutOf(f.floor, f.wall, back.placed, back.stored))'), 'a piece in hand goes back where it was, at its place in the saved order')
  assert.ok(settle.includes('this.io.hooks.setDraft(null)'), 'and the draft is taken away')
  // What the smoke test reads.
  for (const mark of ['data-furnishing', 'data-cursor={`${c},${r}`}', 'data-piece={handId ?? \'\'}', 'data-placed={fit.placed.length}', 'data-furnish={furnishing || undefined}', 'data-line={item.id}', 'data-action="order"', 'data-action="pick"', 'data-action="place"', 'data-count>', 'data-stored={fit.stored.length}', 'data-plan', 'data-reason>{reason}</p>', 'data-saved>Saved in this browser · Esc or B to finish</div>']) {
    assert.ok(src.includes(mark), `missing ${mark}`)
  }
})

test('the furnishing view\'s pointers and fingers: the 3D view through pickCell, the plan by its cells, the right button removes, the wheel turns, every button 48 px', () => {
  const src = flat(card)
  assert.ok(src.includes('const canvas = hooks.canvas() if (!canvas) return const pick = (e: PointerEvent) => visit.io.hooks.pickCell(e.clientX, e.clientY)'))
  assert.equal(src.match(/if \(e\.button === 2\) \{ e\.preventDefault\(\); visit\.run\(\{ removeAt: (?:pick|cellOf)\(e\) \}\); return \}/g)?.length, 2, 'the right button removes, on both')
  assert.equal(src.match(/addEventListener\('contextmenu', onMenu\)/g)?.length, 2, 'no context menu on either')
  assert.ok(src.includes('const onMenu = (e: Event) => e.preventDefault()'))
  assert.equal(src.match(/addEventListener\('wheel', onWheel, \{ passive: false \}\)/g)?.length, 2, 'the wheel turns the piece, the page never scrolls')
  assert.ok(src.includes("if (e.pointerType === 'touch') return"), 'a finger moves the cursor by its tap, not by hovering')
  // Hover moves the cursor on the plan alone: the draft camera follows the cursor, so a hover on the city would chase itself.
  assert.equal(src.match(/addEventListener\('pointermove', onMove\)/g)?.length, 1, 'one hover, the plan\'s')
  assert.ok(src.includes("el.addEventListener('pointermove', onMove)"))
  const visit = flat(visitSrc)
  assert.ok(visit.includes('if (cell.c === this.cursor.c && cell.r === this.cursor.r) this.place() else this.moveTo(cell.c, cell.r)'), 'tap the cursor\'s cell again to place')
  // A right press on no cell does nothing, as a left press there does (furnishVisit.test.ts runs both).
  assert.ok(visit.includes("else if ('removeAt' in a) this.removeAt(a.removeAt)"))
  assert.ok(visit.includes('removeAt(cell: { c: number; r: number } | null): void { if (!cell) return this.moveTo(cell.c, cell.r) this.remove() }'))
  // The touch sizes are the touch layout's (TOUCH.minTarget, TOUCH.gap), on every toolbar button and every row.
  assert.ok(src.includes('const TARGET = Object.freeze({ minWidth: TOUCH.minTarget, minHeight: TOUCH.minTarget })'))
  assert.ok(src.includes('const GAP = Object.freeze({ gap: TOUCH.gap })'))
  const toolbar = src.slice(src.indexOf('<div role="toolbar"'), src.indexOf('</div>', src.indexOf('<div role="toolbar"')))
  const tools = buttonsIn(toolbar)
  assert.deepEqual(tools.map((b) => b.match(/data-action="(\w+)"/)?.[1]), ['prev', 'next', 'rotate', 'rest', 'place', 'remove', 'undo', 'view', 'done'])
  for (const b of tools) assert.ok(b.includes('style={TARGET}'), b)
  assert.ok(src.includes('<canvas ref={planRef} role="img"'), 'the plan is named for a screen reader')
  assert.ok(src.includes('role="status" aria-live="polite" data-reason'))
})

test('the host keeps the homes\' record, saves every edit and hands it to the engine with what is owned; an owner\'s card asks to furnish', () => {
  const app = flat(read('../App.tsx'))
  assert.ok(app.includes("import { loadHomes, saveHomes, type HomeRecord } from './05_Observe_Environment/homeStore.ts'"))
  assert.ok(app.includes('const [homes, setHomes] = useState<HomeRecord>(loadHomes)'))
  assert.ok(app.includes('for (const id of SHAPE_IDS) if (keeper.owns(id)) mask |= 1 << (id - FURNITURE_BASE)'), 'lineMask bit i: line 160 + i owned')
  assert.ok(app.includes('const onRecord = useCallback((next: HomeRecord) => { homesRef.current = next setHomes(next) saveHomes(next) engineRef.current?.setFurnishings(next, ownedHomes(keeper), ownedLines(keeper)) }, [keeper])'))
  assert.ok(app.includes('const furnish = () => { const deeds = ownedHomes(keeper) engine.setFurnishings(homesRef.current, deeds, ownedLines(keeper)) setOwnedDeeds(deeds) } furnish() return keeper.onChange(furnish)'), 'at boot and on every change of what is owned')
  assert.ok(app.includes('useEffect(() => { engine?.setHomeCard(homeOpen, homeOpen !== null && ((ownedDeeds >>> homeOpen) & 1) === 1) }, [engine, homeOpen, ownedDeeds])'))
  for (const hook of ['refusal: (home: number) => engine.furnishRefusal(home)', 'begin: (home: number) => { if (!engine.furnishing) engine.setHomeCard(home, true) }', 'setDraft: (draft) => engine.setHomeDraft(draft)', 'blocked: (home: number) => engine.blockedCells(home)', 'pickCell: (x: number, y: number) => engine.pickCell(x, y)', 'canvas: () => canvasRef.current']) {
    assert.ok(app.includes(hook), `missing ${hook}`)
  }
  assert.ok(app.includes('record={homes} onRecord={onRecord} furnish={furnishHooks}'))
})

test('the Rest tab: the panel shows the host\'s words (hooks.rest.offer), never computed in the card; there the toolbar\'s primary button is Rest (BUTTON, TARGET, Enter, aria-describedby the panel) while Place keeps its own button; the finishes show only in Floor and Walls; the tabs wrap; the deed view says resting waits with furnishing', () => {
  const src = flat(card)
  const visit = flat(visitSrc)
  assert.ok(visit.includes("export const TABS = Object.freeze(['Furniture', 'Floor', 'Walls', 'Rest', 'Staff'] as const)"))
  assert.ok(visit.includes('export const REST_TAB = 3'))
  assert.ok(visit.includes("case 'place': if (this.tab === REST_TAB) this.rest(); else this.place(); return"), 'Enter, Space, A and the button rest in the Rest tab')
  assert.ok(visit.includes("this.say(this.io.hooks.rest?.take(this.home) ?? 'Resting is not offered here')"))
  // The panel: the host's lines as they come, then the hint; the card computes nothing of a rest.
  assert.ok(src.includes('const restId = `home-rest-${home}`'))
  assert.ok(src.includes("{visit.tab === REST_TAB && ( <div id={restId} className={`mt-3 rounded-2xl border px-3 py-2 text-[12px] leading-snug ${t.rule}`} data-rest> {(hooks.rest?.offer(home).lines ?? ['Resting is not offered here']).map((line) => <p key={line}>{line}</p>)}"))
  assert.ok(src.includes(`{"Enter, Space, the pad's south button or Rest below rests here."}`))
  assert.ok(!/progress\.ts'|progression\.ts'|restBonus|homeRest|restAtHome|pageProgress|comfortOf/.test(src), 'nothing of the keeper or the rules in the card')
  assert.ok(!/progress\.ts'|progression\.ts'|restBonus|homeRest|restAtHome|pageProgress/.test(visit), 'nor in the visit')
  // The toolbar: Rest in Place's spot, the same size and colour, named for Enter and described by the panel.
  const toolbar = src.slice(src.indexOf('<div role="toolbar"'), src.indexOf('</div>', src.indexOf('<div role="toolbar"')))
  const restButton = buttonsIn(toolbar).find((b) => b.includes('data-action="rest"'))
  assert.ok(restButton, 'a Rest button')
  for (const part of ["onClick={() => visit.run('place')}", 'aria-label="Rest here (Enter)"', 'aria-describedby={restId}', 'className={`${BUTTON} px-4 font-semibold ${t.buy}`}', 'style={TARGET}', 'data-touch']) {
    assert.ok(restButton.includes(part), `the Rest button: ${part}`)
  }
  assert.ok(toolbar.includes('{visit.tab === REST_TAB ? ( <button'), 'Rest only in the Rest tab, Place everywhere else')
  assert.ok(toolbar.includes('data-action="rest" data-touch>Rest</button> ) : ( <button'))
  assert.ok(toolbar.includes("aria-label={staffTab ? 'Previous agent (Q)' : visit.tab === 1 || visit.tab === 2 ? 'Previous finish (Q)' : 'Previous piece (Q)'}"))
  assert.ok(toolbar.includes("aria-label={staffTab ? 'Next agent (E)' : visit.tab === 1 || visit.tab === 2 ? 'Next finish (E)' : 'Next piece (E)'}"))
  // The finishes only in Floor and Walls, and the arrows move the cursor in the Rest tab as in Furniture.
  assert.ok(src.includes('{(visit.tab === 1 || visit.tab === 2) && ( <div className="mt-3 grid grid-cols-2"'))
  assert.ok(!src.includes('visit.tab !== 0'))
  assert.ok(src.includes('const finish = tab === 1 || tab === 2'))
  // Five tabs wrap on a narrow phone.
  assert.ok(src.includes('<div role="tablist" aria-label="Furnish, rest or staff" className="mt-2 flex flex-wrap" style={GAP}>'))
  // The deed view in a network room: resting waits with furnishing.
  assert.ok(src.includes('{owned && refusal && furnish?.rest && <p className={`mt-1 text-[12px] leading-snug ${t.muted}`} data-rest-wait>Resting here waits for the same reason.</p>}'))
  for (const words of ['Resting is not offered here', "Enter, Space, the pad's south button or Rest below rests here.", 'Resting here waits for the same reason.', 'Rest here (Enter)', 'Furnish, rest or staff']) clean('the Rest tab', words)
})

test('every sentence a rest at home can say passes the card\'s screen', () => {
  const levels = Array.from({ length: 7 }, (_, h) => itemById(224 + h)?.level ?? 0)
  assert.deepEqual(levels, [1, 3, 6, 10, 14, 17, 20])
  const said = new Set<string>()
  for (const hero of [1, 3]) {
    for (const level of levels) {
      for (const kinds of [0, 1, 3, 5, 9]) {
        const p = createProgress({ store: null, seed: () => 3, now: () => 0 })
        p.record[AT.hero] = hero
        seal(p.record)
        for (const l of restOffer(p, level, kinds).lines) said.add(l)
        said.add(restTake(p, level, kinds))
        for (const other of levels) for (const l of restOffer(p, other, 9).lines) said.add(l)
        said.add(restTake(p, 20, 9))
        said.add(restTake(p, 20, 9))
      }
    }
  }
  assert.ok(said.size >= 20, `${said.size} sentences`)
  for (const text of said) clean('a rest at home', text)
})

test('the Staff tab: a strip of the player\'s agents with where each is, and a list of the workstations here that moves the cursor, 48 px with text labels; Post and Stand down in Place\'s and Remove\'s buttons; the plan\'s label counts the staffed; the store and the roster stay out of the card', () => {
  const src = flat(card)
  const visit = flat(visitSrc)
  assert.ok(visit.includes('export const STAFF_TAB = 4'))
  assert.ok(src.includes('const staffTab = visit.tab === STAFF_TAB, seat = staffTab ? visit.station(fit) : null'))
  assert.ok(src.includes('|| (staffTab ? visit.staffLine() : hand && verdict ?'), 'the reason line is the visit\'s in the Staff tab')
  // The panel: the strip of agents (a group of buttons, the chosen one pressed, the name and where the agent is shown
  // and in the label), the list of workstations, and the hint.
  assert.ok(src.includes('const staffId = `home-staff-${home}`'))
  assert.ok(src.includes('{staffTab && ( <div id={staffId} className="mt-3" data-staff>'))
  assert.ok(src.includes('<div role="group" className="flex overflow-x-auto pb-1" style={GAP} aria-label="Your agents" data-agents>'))
  assert.ok(src.includes('{visit.staffAgents().map((a) => { const at = visit.whereIs(a)'), 'where each agent is, in the visit\'s words')
  const agent = buttonsIn(src).find((b) => b.includes('data-action="agent"'))
  assert.ok(agent, 'an agent button')
  for (const part of ['onClick={() => visit.run({ agent: a.name })}', 'aria-pressed={inHandName === a.name}', 'aria-label={`${a.name}: ${at}`}', '${BUTTON}', 'data-touch']) {
    assert.ok(agent.includes(part), `the agent button: ${part}`)
  }
  assert.ok(src.includes('data-touch > <span className="block font-semibold">{a.name}</span> <span className="block text-[12px]">{at}</span> </button>'),
    'its text label is the name over where the agent is, as its aria-label says')
  // The list: one button per workstation here in reading order, a tap moving the cursor onto it (a second posts, as any
  // press on the cursor's cell), the one under the cursor pressed.
  assert.ok(src.includes('<div role="group" className="mt-2 grid grid-cols-2" style={GAP} aria-label="Workstations here" data-stations> {visit.stations(fit).map((p, i) => { const who = visit.who(p)?.name ?? \'Nobody\''))
  const station = buttonsIn(src).find((b) => b.includes('data-action="station"'))
  assert.ok(station, 'a workstation button')
  for (const part of [
    'onClick={() => visit.run({ press: { c: p.c, r: p.r } })}', 'aria-pressed={seat?.n === i + 1}', 'aria-label={`Workstation ${i + 1}, ${placeWords(home, p)}: ${who}`}',
    'data-seat={`${p.c},${p.r}`}', '${BUTTON}', 'data-touch',
  ]) {
    assert.ok(station.includes(part), `the workstation button: ${part}`)
  }
  assert.ok(src.includes('data-touch > Workstation {i + 1} · {who} </button>'), 'its text label is its number and who stands there')
  // The toolbar: Post and Stand down are Place's and Remove's own buttons (the data-action list is unchanged), named for their keys.
  const toolbar = src.slice(src.indexOf('<div role="toolbar"'), src.indexOf('</div>', src.indexOf('<div role="toolbar"')))
  const place = buttonsIn(toolbar).find((b) => b.includes('data-action="place"'))!
  assert.ok(place.includes("aria-label={staffTab ? `Post ${inHandName ?? 'an agent'} here (Enter)` : hand"))
  assert.ok(place.includes('aria-describedby={staffTab ? staffId : undefined}'))
  assert.ok(toolbar.includes("data-action=\"place\" data-touch>{staffTab ? 'Post' : 'Place'}</button>"))
  assert.ok(toolbar.includes("aria-label={staffTab ? 'Stand down (Delete)' : 'Remove the piece (Delete)'}"))
  assert.ok(toolbar.includes("data-action=\"remove\" data-touch>{staffTab ? 'Stand down' : 'Remove'}</button>"))
  // The plan: each posted agent's disc and initial, and the cursor round the workstation under it; its label counts the
  // workstations staffed in the Staff tab.
  assert.ok(src.includes('staff: visit.staffMarks(), seat: seat?.p ?? null'))
  assert.ok(src.includes('the cursor at ${where}${staffTab ? `; ${visit.staffMarks().length} of ${visit.stations(fit).length} workstations staffed` : \'\'}`}'))
  assert.ok(src.includes('const f = (o.hand && footprint(o.hand)) ?? (o.seat && footprint(o.seat)) ?? { c: o.cursor.c, r: o.cursor.r, cols: 1, rows: 1 }'))
  assert.ok(src.includes('staff: \'#7c3aed\','))
  // The card and the visit never reach the store or the roster: the host's hooks answer for them.
  assert.ok(!/from '[^']*(?:staffStore|roster)\.ts'|from '\.\.\/08_Swarm/.test(src), 'nothing of the store or the roster in the card')
  assert.ok(!/from '[^']*(?:staffStore|roster)\.ts'|from '\.\.\/08_Swarm/.test(visit), 'nor in the visit')
  assert.ok(!/loadStaff|saveStaff|localStorage/.test(src + visit), 'neither reads nor writes the browser\'s store')
  const words = [
    'Your agents', 'Workstations here', 'Workstation', 'Nobody', ' workstations staffed', 'Previous agent (Q)', 'Next agent (E)', 'Post', 'an agent', ' here (Enter)',
    'Stand down (Delete)', 'Stand down', 'Posted agents stand there between visits, and step away while out with you.', 'Furnish, rest or staff', 'Staff',
    'Free', ' · out with you', 'Workstation moved or put away', 'Workstations turn in the Furniture tab', ' (moved from ',
  ]
  for (const w of words) {
    assert.ok(card.includes(w) || visitSrc.includes(w), `the card says ${w}`)
    clean('the Staff tab', w)
  }
  // No desk in the player's words, and nothing a posted agent does not do.
  for (const w of [...words, ...stringsIn(visitSrc, 'const NO_AGENTS = ', '\n')]) assert.doesNotMatch(w, /\bdesks?\b|\bsit|\bseated\b|\bworks\b|\bearn|\bassigned\b|\blane\b|\bteam\b/i, w)
})

test('every sentence staffing can say passes the card\'s screen', () => {
  const keeper = { owns: () => true, buy: () => ({ verdict: 0, message: '' }) } as unknown as Shopkeeper
  const said = new Set<string>()
  const names = ['Mara', 'Theo', 'Ines', 'Abcdefghijklmnopqrstuvwx']
  for (let home = 0; home < 7; home++) {
    const first = GRID - DEPTH[home]
    const record = withHome(freshHomes(), home, layoutOf(0, 0, [{ id: 168, c: 4, r: first, rot: 0 }, { id: 168, c: 10, r: first, rot: 2 }], []))
    for (const mode of ['ok', 'away', 'refused', 'none', 'bare'] as const) {
      const posts = new Map<string, { home: number; c: number; r: number }>()
      // Away: one agent posted in the next home, one where no workstation stands now.
      if (mode === 'away') { posts.set('Ines', { home: (home + 1) % 7, c: 4, r: 20 }); posts.set('Theo', { home, c: 20, r: first + 3 }) }
      const hooks: StaffHooks = {
        agents: (): StaffAgent[] => (mode === 'none' ? [] : names.map((name, i) => ({ name, out: i % 2 === 1, post: posts.get(name) ?? null }))),
        homeName: (h) => itemById(224 + h)?.name ?? 'another home',
        post: (h, c, r, name) => { if (mode === 'refused') return 'Furnishing happens inside the home: walk in first'; for (const [n, p] of posts) if (p.c === c && p.r === r) posts.delete(n); posts.set(name, { home: h, c, r }); return null },
        standDown: (_h, c, r) => { for (const [n, p] of posts) if (p.c === c && p.r === r) posts.delete(n); return null },
      }
      const v = new Visit(home, mode === 'bare' ? freshHomes() : record, {
        keeper, onRecord: () => {}, onClose: () => {}, changed: () => {},
        hooks: { refusal: () => null, begin: () => {}, setDraft: () => {}, blocked: () => new Uint8Array(GRID * GRID), pickCell: () => null, canvas: () => null, staff: hooks },
      })
      v.run({ tab: STAFF_TAB })
      const note = () => { said.add(v.staffLine()); if (v.said) said.add(v.said); for (const a of v.staffAgents()) said.add(v.whereIs(a)) }
      for (const [c, r] of [[4, first], [11, first + 1], [20, first + 3]]) {
        v.moveTo(c, r)
        note()
        for (const name of names) {
          v.run({ agent: name })
          v.run('place')
          note()
          v.run('place')
          note()
        }
        v.run('remove')
        note()
        v.run('remove')
        note()
        v.run('rotate')
        note()
      }
      // One agent moved from the first workstation to the second.
      v.moveTo(4, first)
      v.run({ agent: names[0] })
      v.run('place')
      v.moveTo(11, first + 1)
      v.run('place')
      note()
    }
  }
  // The host's own refusals (App.tsx), with each name.
  const app = read('../App.tsx')
  assert.ok(app.includes("'No workstation stands there now'") && app.includes('`No agent called ${name} on your roster`'))
  said.add('No workstation stands there now')
  for (const name of names) said.add(`No agent called ${name} on your roster`)
  for (const kind of [/\(moved from workstation \d\)/, /\(moved from [A-Z]/, /^Workstation moved or put away/, / · out with you$/, /^Free$/, /^Workstations turn in the Furniture tab$/]) {
    assert.ok([...said].some((t) => kind.test(t)), `among them: ${kind}`)
  }
  assert.ok(said.size >= 20, `${said.size} sentences`)
  for (const text of said) clean('staffing', text)
})
