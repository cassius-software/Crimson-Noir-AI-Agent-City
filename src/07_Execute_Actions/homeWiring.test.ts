// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the seven homes (01_Initialize_World/properties.ts), which
 * the engine, the HUD and App carry and Node cannot run. The city hollows the homes' lots after the shops', and a
 * generated region picks its home lots after its shops' and hollows them with the rest. The engine keeps the homes with
 * their names, addresses and arrival spots, and opens a home's doorstep card from E (a car in reach keeps E for its
 * door) or B. While that card is open it holds the avatar still: every queued action is dropped right after the poll
 * and the walk is zeroed after the controls are read. Go home is refused in a network room, at the wheel and for a home
 * that is not in this map. The snapshot says which home the avatar stands in and which homes are owned, and the
 * minimaps draw them. App opens the card from the engine and the chip, suspends the game's input while it is open (all
 * three suspend sites), closes it out of the home, in a headset or when the console opens, hides the touch controls and
 * Sloane under it, feeds the engine what the shopkeeper says is owned, and gives the design house's deed rows Visit and
 * Go home. The physics worker, the network room's mirror and the operator's script facade learn nothing new, and the
 * city's generator never reads anything a browser keeps. Source-level, as the other wiring tests are.
 * What breaks if it is removed? A home could stand in the city with no way to open its card, a pad's south button
 * could open a car door through an open card, the stick could walk the avatar out from under it, or Go home could
 * teleport a player the network room then puts back, and only a browser would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const flat = (s: string) => s.replace(/\s+/g, ' ')
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing ${from}`)
  const b = src.indexOf(to, a + from.length)
  assert.ok(b > a, `missing ${to} after ${from}`)
  return src.slice(a, b)
}
/** What a module imports: every `from '...'` it names. */
const importsOf = (src: string): string[] => [...src.matchAll(/^import[^\n]*?from '([^']+)'/gm)].map((m) => m[1])
/** The house's words a pinned range may not carry (bootloader.test.ts, netWiring.test.ts, splitWiring.test.ts). */
const FORBIDDEN = /\btarget\b|\bthe matrix\b|\bmatrix[- ](?:style|like|rain|code|effect)\b|\bdigital rain\b|\bragdoll\b/i

test('the city and the region: the homes hollowed after the shops; the region\'s home lots picked after the shops\' and hollowed with them', () => {
  const city = flat(read('../01_Initialize_World/city.ts'))
  before(city, 'hollowShops(seed, out)', 'hollowProperties(seed, out)', 'the shops first, so the homes pick among the lots left')
  const src = flat(read('./engine.ts'))
  before(src, 'const shopLots = ', 'const homeLots = ', 'the shops pick before the homes')
  before(src, 'const homeLots = ', 'const hollow = ', 'and the homes are hollowed with the rest')
  assert.ok(src.includes('const homeLots = pack && layout && streets ? regionHomeLots(pack, layout, streets, spawn, options.seed, [...lots, ...shopLots]) : []'), 'never on a workplace\'s or a shop\'s lot')
  assert.ok(src.includes('const hollow = pack && layout ? hollowLots(pack, layout, lots, shopLots, homeLots) : null'))
  // The homes' glass reaches the worker as the world's boxes: no lot list, no new command, nothing new in its protocol.
  assert.doesNotMatch(src, /\{ homes: homeLots \}/, 'the worker is not handed the home lots in this slice')
  assert.doesNotMatch(read('./simProtocol.ts'), /HomeLot|properties\.ts|homes\?:/)
})

test('the engine: the homes kept with their names and addresses; E (unless a car is in reach) or B opens a home\'s card; the card holds the avatar still', () => {
  const raw = read('./engine.ts')
  const src = flat(raw)
  assert.ok(src.includes('homes: hollow ? hollow.homes.map((h) => pageHome(h, places ? places.place(h.door.x, h.door.z) : cityAddress(h.door.x, h.door.z), streets?.lane ?? CITY.lane)) : cityHomes(options.seed).map((h) => pageHome(h, cityAddress(h.door.x, h.door.z), CITY.lane)),'), 'the city\'s homes, or the region\'s at their own addresses')
  assert.ok(src.includes('return { ...h, name: itemById(DEED_BASE + h.home)?.name ?? h.kind, address, arrival: doorFront(h, lane) }'), 'the deed\'s name; the arrival on the sidewalk lane in front of the doorway')
  assert.ok(src.includes('const cityAddress = (x: number, z: number): string => `${ordinal(Math.round(x / CITY.pitch) + 1)} Ave & ${ordinal(Math.round(z / CITY.pitch) + 1)} St`'), 'the snapshot\'s own street words')
  // E is a car's door first, then a shop's card, then a home's; B asks without the car check.
  assert.ok(src.includes("if (input.take('interact') && !this.browse(true) && !this.openHome(true)) this.interact()"))
  assert.ok(src.includes("if (input.take('browse') && !this.browse()) this.openHome()"))
  const open = between(src, ' openHome(interact = false): boolean {', ' setHomeCard(')
  assert.ok(open.includes('if (this.halted || this.disposed || !this.onHome || st.driving >= 0) return false'), 'on foot, in a city that runs')
  assert.ok(open.includes('const h = homeAt(this.homes, st.avatar.x, st.avatar.z)'))
  assert.ok(open.includes('if (h < 0 || (interact && this.nearestCar(st.avatar.x, st.avatar.z, ENTER_RANGE) >= 0)) return false'), 'a car in reach keeps E (only E) for its door')
  assert.ok(src.includes('if (this.halted || this.disposed || st.driving >= 0 || homeAt(this.homes, st.avatar.x, st.avatar.z) !== home) { this.homeCard = null; return false }'), 'the card only for the home the avatar stands in, on foot')
  assert.ok(src.includes('if (home === null) { this.homeCard = null; return true }'), 'closing always takes')
  // The hold: right after the poll every queued action goes (a pad's edges queue even under suspend), then the E line;
  // after the controls are read (and a script's walk applied), the walk is zeroed.
  const frame = between(raw, '  frame(nowMs: number): void {', '  /** One drawn frame')
  before(frame, 'input.poll(dt)', 'if (this.homeCard !== null) input.drain()', 'the poll first')
  before(frame, 'if (this.homeCard !== null) input.drain()', "if (input.take('interact')", 'nothing queued reaches the E line')
  before(frame, 'readControls(input, driving >= 0, foot, drive)', 'if (this.homeCard !== null) { foot.x = 0; foot.z = 0 }', 'the stick walks under suspend')
  before(frame, 'applyWalk(this.scriptedWalk, nowMs, foot)', 'if (this.homeCard !== null) { foot.x = 0; foot.z = 0 }', 'a script\'s walk waits too')
  before(frame, 'if (this.homeCard !== null) { foot.x = 0; foot.z = 0 }', 'const w = footWish(foot.x, foot.z)', 'what the room is told is the held walk')
  // Out of the home (a teleport, the console's moves), the hold ends at once; the host closes the card at its next look.
  before(frame, 'this.shopHere = driving >= 0 ? -1 : shopAt(this.shops, av.x, av.z)', 'this.homeHere = driving >= 0 ? -1 : homeAt(this.homes, av.x, av.z)', 'beside the shop\'s')
  assert.ok(frame.includes('if (this.homeCard !== null && this.homeHere !== this.homeCard) this.homeCard = null'))
  assert.ok(read('../04_Connect_Hardware/input.ts').includes('  drain(): void {\n    this.queued.clear()\n  }'), 'the drain drops the queue and nothing else')
})

test('the engine: Go home is refused in a network room, at the wheel and for a home not in this map; the snapshot and the region\'s minimap know the homes', () => {
  const src = flat(read('./engine.ts'))
  const go = between(src, ' goHome(home: number): boolean {', ' homeWhere(')
  assert.ok(go.includes('if (!h || this.halted || this.disposed || this.netRoom || this.sim.state.driving >= 0) return false'), 'a network room replays only the steps it saw and would put the player back')
  assert.ok(go.includes("this.sim.send({ c: 'teleport', x: h.arrival.x, z: h.arrival.z })"), 'onto the sidewalk in front of the doorway, never inside')
  assert.ok(go.includes('this.input.yaw = Math.atan2(d.x, d.z)'), 'looking in through the doorway')
  const where = between(src, ' homeWhere(home: number)', ' /** Enter the nearest car')
  assert.ok(where.includes("if (!h) return { line: '', why: 'stands in the city, not in this map' }"))
  assert.ok(where.includes("why: this.netRoom ? 'not in a shared room: walk there' : null"))
  assert.ok(src.includes('...(this.homeHere >= 0 && { home: this.homeView(this.homeHere) }),'))
  assert.ok(src.includes('ownedHomes: this.ownedHomes,'))
  assert.ok(src.includes("return { index: home, kind: h?.kind ?? '', name: h?.name ?? '', owned: ((this.ownedHomes >>> home) & 1) === 1, card: this.homeCard === home }"))
  assert.ok(src.includes('drawShops(ctx, shops, x, z, dark, radius); drawHomes(ctx, homes, x, z, dark, this.ownedHomes, radius)'), 'a region\'s homes over its map, after its shops')
  const telemetry = flat(read('../05_Observe_Environment/telemetry.ts'))
  assert.ok(telemetry.includes('home?: { index: number; kind: string; name: string; owned: boolean; card: boolean }'))
  assert.ok(telemetry.includes('ownedHomes?: number'))
  // No word the house keeps out of the engine's pinned ranges in the homes' own code.
  assert.doesNotMatch(between(read('./engine.ts'), '  openHome(interact = false): boolean {', '  /** Enter the nearest car'), FORBIDDEN)
  assert.doesNotMatch(between(read('./engine.ts'), '/** The city\'s street address of a point', '/** One prop\'s dissolve amounts'), FORBIDDEN)
})

test('the HUD: the home\'s chip on foot with its card closed; the homes on the city\'s minimap after the shops', () => {
  const raw = read('./Hud.tsx')
  const src = flat(raw)
  assert.ok(src.includes('const homeChip = home && !home.card && !driving && !terminalOpen && ('), 'never behind the console or at the wheel')
  assert.ok(src.includes('onClick={() => onHome?.(home.index)}'))
  assert.ok(src.includes('<span>Your home: <bdi className="font-semibold">{home.name}</bdi></span>'))
  assert.ok(src.includes("<span>For sale: <bdi className=\"font-semibold\">{home.name}</bdi>{deed && ` · Level ${deed.level} · ${deed.price === 0 ? 'Free' : credits(deed.price)}`}</span>"))
  assert.equal(raw.match(/\{homeChip\}/g)?.length, 2, 'in both layouts, beside the shop\'s chip')
  before(src, 'if (seed !== undefined) drawShops(ctx, shopsOf(seed), x, z, dark)', 'if (homes) drawHomes(ctx, homes, x, z, dark, owned)', 'over the shops\' layer')
  assert.ok(src.includes('else cityMap(ctx, x, z, dark, s.process.seed, homes, s.customer.ownedHomes ?? 0)'), 'the owned ones in gold')
  assert.doesNotMatch(between(raw, '  const homeChip', '  // Desktop, mouse not captured'), FORBIDDEN)
})

test('App: one home card state; the engine and the chip open it; input suspended at all three sites; closed out of the home, in a headset and by the console', () => {
  const src = flat(read('../App.tsx'))
  assert.ok(src.includes('const [homeOpen, setHomeOpen] = useState<number | null>(null)'))
  assert.ok(src.includes('const openHome = useCallback((home: number) => { if (engineRef.current?.setHomeCard(home) !== true) return setLookOpen(false); setStoreOpen(null); setTrying(null); setHomeOpen(home) }, [])'), 'a card the engine refuses never opens; one card at a time, and no try-on left worn')
  assert.ok(src.includes('useEffect(() => { engine?.setHomeCard(homeOpen) }, [engine, homeOpen])'), 'the engine\'s hold follows the card, closed from anywhere')
  assert.ok(src.includes('e.onHome = openHome'))
  assert.ok(src.includes('onHome={openHome}'), 'the chip opens the same card')
  assert.ok(src.includes('homes={engine?.homes ?? null}'), 'the city\'s minimap draws the engine\'s homes')
  // The three suspend sites (storeWiring.test.ts and actWiring.test.ts pin the first two).
  assert.ok(src.includes('engineRef.current?.input.suspend(open || lookOpenRef.current || storeOpenRef.current !== null || homeOpenRef.current !== null)'))
  assert.ok(src.includes('engineRef.current?.input.suspend(lookOpen || storeOpen !== null || homeOpen !== null || termOpenRef.current)'))
  assert.ok(src.includes('}, [lookOpen, storeOpen, homeOpen])'))
  assert.ok(src.includes('if (termOpenRef.current || lookOpenRef.current || storeOpenRef.current !== null || homeOpenRef.current !== null) e.input.suspend(true)'), 'an engine that arrives under an open card starts suspended')
  assert.ok(src.includes('if (open) { setLookOpen(false); setStoreOpen(null); setTrying(null); setHomeOpen(null) }'), 'the console opening puts the card away')
  assert.ok(src.includes("if (homeOpenRef.current !== null && ((s.customer.home?.index ?? -1) !== homeOpenRef.current || s.supplier.xr.state === 'vr' || s.supplier.xr.state === 'ar')) closeHome()"), 'out of the home or into a headset, the card goes')
  assert.ok(src.includes('{engine && hud && !termOpen && homeOpen === null && ( <TouchControls'), 'no touch controls under the card')
  assert.ok(src.includes('visible={veilDone && hudVisible && !termOpen && !lookOpen && storeOpen === null && homeOpen === null && locked === null}'), 'Sloane steps aside')
  assert.ok(src.includes('<HomeCard visible={homeOpen !== null && veilDone && !termOpen && locked === null}'), 'never over the veil, the console or a halted city')
  assert.ok(src.includes('onClose={closeHome}'))
  before(src, '<StoreCard', '<HomeCard', 'beside the store card')
  before(src, '<HomeCard', '<Terminal ref={termRef}', 'under the console and the act card')
  // What the shopkeeper says is owned reaches the engine at once and on every change; the deed rows go and say where.
  assert.ok(src.includes('engine.setOwnedHomes(ownedHomes(keeper)) return keeper.onChange(() => engine.setOwnedHomes(ownedHomes(keeper)))'))
  assert.ok(src.includes("if (e && item.kind === 'deed' && !e.goHome(item.index)) e.toast('Home', 'Walk there: a shared room replays your steps')"))
  assert.ok(src.includes('onGo={goHome}') && src.includes('whereFor={whereFor}'))
  // The ?debug harness reaches the homes the way it reaches the shops.
  assert.ok(src.includes('openHome: () => e.openHome(),'))
})

test('what learns nothing new: the worker\'s glass and the garage\'s rooms list no home; the generator reads nothing a browser keeps; the script facade has no home leaf', () => {
  // No car fits through a home's planters, so the exit rule and the room's garage never need the homes.
  const core = flat(read('./simCore.ts'))
  assert.ok(core.includes('this.#glass = [...rooms, ...(o.region ? (o.streets && o.shops?.length ? shopsAt(o.shops) : []) : shops(o.seed))]'))
  assert.doesNotMatch(core, /properties\.ts|homesAt|cityHomes|hollowProperties/)
  const garage = flat(read('../10_Network/garage.node.ts'))
  assert.ok(garage.includes('this.#rooms = [...workplaces(this.seed), ...shops(this.seed)]'))
  assert.doesNotMatch(garage, /properties\.ts|homesAt|cityHomes/)
  // The worker reaches properties.ts through city.ts: neither may import a saved record, the catalogue or the wardrobe.
  for (const f of ['../01_Initialize_World/city.ts', '../01_Initialize_World/properties.ts', '../02_Define_The_Rules/homeGrid.ts']) {
    for (const m of importsOf(read(f))) assert.doesNotMatch(m, /05_Observe_Environment|storeCatalog|look\.ts|07_Execute_Actions/, `${f} imports ${m}`)
  }
  assert.deepEqual(importsOf(read('../02_Define_The_Rules/homeGrid.ts')), [], 'the floor plan imports nothing')
  assert.doesNotMatch(read('./operator.ts'), /\bhomes?\b|goHome|openHome|setHomeCard|OwnedHomes|homeWhere/i, 'no home leaf on the operator\'s script facade')
})
