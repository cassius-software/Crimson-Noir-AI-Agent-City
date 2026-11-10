// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the seven homes (01_Initialize_World/properties.ts), which
 * the engine, the world, the HUD and App carry and Node cannot run. The city hollows the homes' lots after the shops',
 * and a generated region picks its home lots after its shops', hollows them with the rest and hands them to the physics
 * worker, which takes from them only each home's room frame to check the furniture's solids against (the 'home'
 * command; the city's frames it builds from the seed) and builds no home geometry. The engine keeps the homes with
 * their names, addresses and arrival spots, and opens a home's doorstep card from E (a car in reach keeps E for its
 * door) or B. While that card is open it holds the avatar still: every queued action is dropped right after the poll
 * and the walk is zeroed after the controls are read. Go home is refused in a network room, at the wheel and for a home
 * that is not in this map. The snapshot says which home the avatar stands in and which homes are owned, and the
 * minimaps draw them. App opens the card from the engine and the chip, suspends the game's input while it is open (all
 * three suspend sites), closes it out of the home, in a headset or when the console opens, hides the touch controls and
 * Sloane under it, feeds the engine what the shopkeeper says is owned, and gives the design house's deed rows Visit and
 * Go home.
 * The furnishing (slice 2b): the world draws every home's finishes and furniture in one HomeFurniture mesh in the
 * buildings' own material, built before the engine compiles, empty yet visible and within three's uniform path. The
 * engine draws the default finishes and the show homes from boot, sends the realm a home's solids only when they change
 * and never in a network room, draws no pieces in a room and forgets what it sent there (a 'home' queued behind the
 * room's start is refused), and sends every home again on leaving. Furnishing is refused in a network room, in a
 * headset, at the wheel, outside the home and for a home not owned; it holds the look (yaw and pitch, which the right
 * stick would otherwise turn under the card) and gives it back. The draft
 * camera is posed in present() alone, after the shop's orbit, and a copy of it is kept for pickCell before the head
 * comes back. The network room's mirror and the operator's script facade learn nothing new, and the city's generator
 * never reads anything a browser keeps. Source-level, as the other wiring tests are.
 * What breaks if it is removed? A home could stand in the city with no way to open its card, a pad's south button
 * could open a car door through an open card, the stick could walk the avatar out from under it, Go home could
 * teleport a player the network room then puts back, the furniture could be drawn where the realm has no collider (or
 * a collider stand where nothing is drawn) after a network room, or a click on the canvas could pick a cell the draft
 * camera never showed, and only a browser would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PadLook } from '../04_Connect_Hardware/gamepad.ts'

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

test('the city and the region: the homes hollowed after the shops; the region\'s home lots picked after the shops\', hollowed with them and handed to the worker for the furniture\'s frames', () => {
  const city = flat(read('../01_Initialize_World/city.ts'))
  before(city, 'hollowShops(seed, out)', 'hollowProperties(seed, out)', 'the shops first, so the homes pick among the lots left')
  const src = flat(read('./engine.ts'))
  before(src, 'const shopLots = ', 'const homeLots = ', 'the shops pick before the homes')
  before(src, 'const homeLots = ', 'const hollow = ', 'and the homes are hollowed with the rest')
  assert.ok(src.includes('const homeLots = pack && layout && streets ? regionHomeLots(pack, layout, streets, spawn, options.seed, [...lots, ...shopLots]) : []'), 'never on a workplace\'s or a shop\'s lot')
  assert.ok(src.includes('const hollow = pack && layout ? hollowLots(pack, layout, lots, shopLots, homeLots) : null'))
  // The homes' glass reaches the worker as the world's boxes; the region's lots go with the shops' only so the worker
  // can check each home's furniture against that home's room frame (the 'home' command).
  assert.ok(src.includes('...(homeLots.length > 0 && { homes: homeLots }),'), 'the worker checks the furniture against the rooms the page drew')
  before(src, '...(shopLots.length > 0 && { shops: shopLots }),', '...(homeLots.length > 0 && { homes: homeLots }),', 'beside the shops')
  const protocol = flat(read('./simProtocol.ts'))
  assert.ok(protocol.includes('homes?: HomeLot[] | null'), 'SimInit carries the region\'s home lots')
  assert.ok(protocol.includes("| { c: 'home'; index: number; boxes: number[] }"), 'and the command that makes a home\'s furniture solid')
})

test('the engine: the homes kept with their names and addresses; E (unless a car is in reach) or B opens a home\'s card; the card holds the avatar still', () => {
  const raw = read('./engine.ts')
  const src = flat(raw)
  assert.ok(src.includes('homes: hollow ? hollow.homes.map((h) => pageHome(h, places ? places.place(h.door.x, h.door.z) : cityAddress(h.door.x, h.door.z), streets?.lane ?? CITY.lane)) : cityHomes(options.seed).map((h) => pageHome(h, cityAddress(h.door.x, h.door.z), CITY.lane)),'), 'the city\'s homes, or the region\'s at their own addresses')
  assert.ok(src.includes('return { ...h, name: itemById(DEED_BASE + h.home)?.name ?? h.kind, address, arrival: doorFront(h, lane) }'), 'the deed\'s name; the arrival on the sidewalk lane in front of the doorway')
  assert.ok(src.includes('const cityAddress = (x: number, z: number): string => `${ordinal(Math.round(x / CITY.pitch) + 1)} Ave & ${ordinal(Math.round(z / CITY.pitch) + 1)} St`'), 'the snapshot\'s own street words')
  // E is a car's door first, then a shop's card, then a home's; B asks without the car check.
  assert.ok(src.includes("if (input.take('interact') && !this.browse(true) && !this.openHome(true)) { this.doorPressedAt = performance.now(); this.interact() }"), 'only a press that went to a door is stamped (progress.ts)')
  assert.ok(src.includes("if (input.take('browse') && !this.browse()) this.openHome()"))
  const open = between(src, ' openHome(interact = false): boolean {', ' setHomeCard(')
  assert.ok(open.includes('if (this.halted || this.disposed || !this.onHome || st.driving >= 0 || this.rig.headset) return false'), 'on foot, out of a headset (the card is the page\'s), in a city that runs')
  assert.ok(open.includes('const h = homeAt(this.homes, st.avatar.x, st.avatar.z)'))
  assert.ok(open.includes('if (h < 0 || (interact && this.nearestCar(st.avatar.x, st.avatar.z, ENTER_RANGE) >= 0)) return false'), 'a car in reach keeps E (only E) for its door')
  assert.ok(src.includes('if (this.halted || this.disposed || st.driving >= 0 || this.rig.headset || homeAt(this.homes, st.avatar.x, st.avatar.z) !== home) { this.homeCard = null; return false }'), 'the card only for the home the avatar stands in, on foot, never in a headset (no hold with nothing drawn)')
  // The hold: right after the poll every queued action goes (a pad's edges queue even under suspend), then the E line;
  // after the controls are read (and a script's walk applied), the walk is zeroed.
  const frame = between(raw, '  frame(nowMs: number): void {', '  /** One drawn frame')
  const drain = 'if (this.homeCard !== null || this.drainNext) { input.drain(); this.drainNext = false }'
  before(frame, 'input.poll(dt)', drain, 'the poll first')
  before(frame, drain, "if (input.take('interact')", 'nothing queued reaches the E line')
  // The press that closed the card (a pad's, which padNav.ts clicks after this frame's poll) reaches the next poll as a
  // fresh edge: closing an open card drops that poll's queue too, so the E line cannot reopen it.
  assert.ok(src.includes('if (home === null) { if (this.homeCard !== null) this.drainNext = true this.homeCard = null return true }'), 'closing always takes, and only a close of an open card arms the extra drop')
  assert.equal((raw.match(/this\.drainNext = /g) ?? []).length, 2, 'armed on a close, spent by the drop: set nowhere else')
  before(frame, 'readControls(input, driving >= 0, foot, drive)', 'if (this.homeCard !== null) { foot.x = 0; foot.z = 0 }', 'the stick walks under suspend')
  before(frame, 'applyWalk(this.scriptedWalk, nowMs, foot)', 'if (this.homeCard !== null) { foot.x = 0; foot.z = 0 }', 'a script\'s walk waits too')
  before(frame, 'if (this.homeCard !== null) { foot.x = 0; foot.z = 0 }', 'const w = footWish(foot.x, foot.z)', 'what the room is told is the held walk')
  // Out of the home (a teleport, the console's moves), the hold ends at once; the host closes the card at its next look.
  before(frame, 'this.shopHere = driving >= 0 ? -1 : shopAt(this.shops, av.x, av.z)', 'this.homeHere = driving >= 0 ? -1 : homeAt(this.homes, av.x, av.z)', 'beside the shop\'s')
  assert.ok(frame.includes('if (this.homeCard !== null && (this.homeHere !== this.homeCard || this.rig.headset)) this.homeCard = null'), 'out of the home or into a headset, the hold ends at once, whatever the page\'s loop is doing')
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
  assert.ok(src.includes('<span>Furnish <bdi className="font-semibold">{home.name}</bdi></span>'), 'an owner\'s chip says what it opens (slice 2b)')
  assert.ok(!src.includes('Your home: '))
  assert.ok(src.includes("<span>For sale: <bdi className=\"font-semibold\">{home.name}</bdi>{deed && ` · Level ${deed.level} · ${deed.price === 0 ? 'Free' : credits(deed.price)}`}</span>"))
  assert.equal(raw.match(/\{homeChip\}/g)?.length, 2, 'in both layouts, beside the shop\'s chip')
  before(src, 'if (seed !== undefined) drawShops(ctx, shopsOf(seed), x, z, dark)', 'if (homes) drawHomes(ctx, homes, x, z, dark, owned)', 'over the shops\' layer')
  assert.ok(src.includes('else cityMap(ctx, x, z, dark, s.process.seed, homes, s.customer.ownedHomes ?? 0)'), 'the owned ones in gold')
  assert.doesNotMatch(between(raw, '  const homeChip', '  // Desktop, mouse not captured'), FORBIDDEN)
})

test('App: one home card state; the engine and the chip open it; input suspended at all three sites; closed out of the home, in a headset and by the console', () => {
  const src = flat(read('../App.tsx'))
  assert.ok(src.includes('const [homeOpen, setHomeOpen] = useState<number | null>(null)'))
  assert.ok(src.includes('if (termOpenRef.current || engineRef.current?.setHomeCard(home) !== true) return setLookOpen(false); setStoreOpen(null); setTrying(null); setHomeOpen(home) }, [])'), 'a card the engine refuses, or one the console would hide while the engine held the avatar, never opens; one card at a time, and no try-on left worn')
  assert.ok(src.includes('pad={act === null || !bridge}'), 'while a city action waits for its OK the act card alone reads the pad (ActCard.tsx shows it when there is a bridge)')
  assert.ok(src.includes('useEffect(() => { engine?.setHomeCard(homeOpen, homeOpen !== null && ((ownedDeeds >>> homeOpen) & 1) === 1) }, [engine, homeOpen, ownedDeeds])'), 'the engine\'s hold follows the card, closed from anywhere; an owner\'s card asks to furnish (slice 2b)')
  assert.ok(src.includes('e.onHome = openHome'))
  assert.ok(src.includes('onHome={openHome}'), 'the chip opens the same card')
  assert.ok(src.includes('homes={engine?.homes ?? null}'), 'the city\'s minimap draws the engine\'s homes')
  // The three suspend sites (storeWiring.test.ts and actWiring.test.ts pin the first two).
  assert.ok(src.includes('engineRef.current?.input.suspend(open || lookOpenRef.current || storeOpenRef.current !== null || homeOpenRef.current !== null)'))
  assert.ok(src.includes('engineRef.current?.input.suspend(lookOpen || storeOpen !== null || homeOpen !== null || termOpenRef.current)'))
  assert.ok(src.includes('}, [lookOpen, storeOpen, homeOpen])'))
  assert.ok(src.includes('if (termOpenRef.current || lookOpenRef.current || storeOpenRef.current !== null || homeOpenRef.current !== null) e.input.suspend(true)'), 'an engine that arrives under an open card starts suspended')
  assert.ok(src.includes("if (open) { setLookOpen(false); setStoreOpen(null); setTrying(null); setHomeOpen(null); walkRef.current.note('console') }"), 'the console opening puts the card away (and the first walk hears of it)')
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

test('what learns nothing new: the worker\'s glass and the garage\'s rooms list no home, and the worker builds no home geometry; the generator reads nothing a browser keeps; the script facade has no home leaf', () => {
  // No car fits through a home's planters, so the exit rule and the room's garage never need the homes. The worker
  // knows only each home's frame, for the furniture's solids, never its shell.
  const core = flat(read('./simCore.ts'))
  assert.ok(core.includes('this.#glass = [...rooms, ...(o.region ? (o.streets && o.shops?.length ? shopsAt(o.shops) : []) : shops(o.seed))]'))
  assert.ok(core.includes('homeFrames(o.streets && o.homes?.length ? o.homes : []) : homeFrames(cityHomes(o.seed))'), 'the frames: a region\'s from its lots, the city\'s from its seed')
  assert.doesNotMatch(core, /homesAt|hollowProperties/, 'no home geometry in the worker')
  const garage = flat(read('../10_Network/garage.node.ts'))
  assert.ok(garage.includes('this.#rooms = [...workplaces(this.seed), ...shops(this.seed)]'))
  assert.doesNotMatch(garage, /properties\.ts|homesAt|cityHomes/)
  // The worker reaches properties.ts through city.ts: neither may import a saved record, the catalogue or the wardrobe.
  for (const f of ['../01_Initialize_World/city.ts', '../01_Initialize_World/properties.ts', '../02_Define_The_Rules/homeGrid.ts']) {
    for (const m of importsOf(read(f))) assert.doesNotMatch(m, /05_Observe_Environment|storeCatalog|look\.ts|07_Execute_Actions/, `${f} imports ${m}`)
  }
  assert.deepEqual(importsOf(read('../02_Define_The_Rules/homeGrid.ts')), [], 'the floor plan imports nothing')
  assert.doesNotMatch(read('./operator.ts'), /\bhomes?\b|goHome|openHome|setHomeCard|OwnedHomes|homeWhere|furnish|HomeDraft|pickCell|blockedCells/i, 'no home leaf on the operator\'s script facade')
})

test('the world: the homes\' finishes and furniture in one HomeFurniture mesh in the buildings\' own material, built in buildWorld (so the boot\'s compile sees it), empty yet visible, within three\'s uniform path', () => {
  const src = flat(read('../01_Initialize_World/world.ts'))
  // Seven homes of a floor, five panels and sixteen pieces of four boxes (490), and the draft's ghost and cursor (5); past
  // 1,024 three r186 reads the transforms as instanced attributes instead, another vertex shader the boot never compiles.
  const cap = Number(/export const HOME_INSTANCES = (\d+)/.exec(src)?.[1])
  assert.ok(cap >= 495 && cap <= 1024, `HOME_INSTANCES ${cap}`)
  assert.ok(src.includes('setHomes(list: readonly Building[]): void'), 'the world hands the engine one setter')
  const build = flat(between(read('../01_Initialize_World/world.ts'), 'export function buildWorld(', '\n}\n'))
  const made = /const (\w+) = new InstancedMesh\((\w+), buildings\.material, HOME_INSTANCES\)/.exec(build)
  assert.ok(made, 'one instanced mesh of HOME_INSTANCES sharing the buildings\' material: a finish is a style number, never a new shader')
  const [, mesh, geometry] = made
  assert.ok(build.includes(`${geometry}.setAttribute('style', `), 'a style attribute of its own (the buildings\' is sized to their boxes)')
  for (const line of [`${mesh}.count = 0`, `${mesh}.visible = true`, `${mesh}.frustumCulled = false`, `${mesh}.name = 'HomeFurniture'`]) assert.ok(build.includes(line), line)
  // Indoors under the slab: it takes the sun's shadows and casts none (no shadow pass is built for it, shadowShaders.test.ts).
  for (const line of [`${mesh}.castShadow = false`, `${mesh}.receiveShadow = true`]) assert.ok(build.includes(line), line)
  // The two furniture styles draw blind (no window, no shopfront under 4.6 m), show their own finish on top, and the
  // screens glow on top of whatever the building material already emits.
  const mat = flat(read('../01_Initialize_World/materials.ts'))
  assert.equal(mat.split('.or(plantedStyle).or(litStyle)').length - 1, 2, 'leaves and screens are blind and keep their own top')
  assert.ok(mat.includes('select(plantedStyle, planted, select(litStyle, screen, rail))'), 'each with its own finish')
  assert.ok(mat.includes('m.emissiveNode = select(ceilingFace, luminaire, glazing.mul(select(retail, shopGlow, officeGlow))).add(screenGlow)'), 'the screens\' glow added, nothing else lit differently')
  // A count of 0 skips only the draw; visible, it is in the scene the boot compiles, whenever the buildings are.
  assert.ok(build.includes(`if (!region || plan.length > 0) scene.add(${mesh})`), 'in the scene whenever the buildings are')
  before(build, 'if (!region || plan.length > 0) scene.add(buildings)', `scene.add(${mesh})`, 'after the buildings')
  assert.match(build, /return \{[^}]*\bsetHomes\b[^}]*\}/, 'the setter on the world')
  before(flat(read('./engine.ts')), 'const world = buildWorld(', 'await gpu.renderer.compileAsync(world.scene, world.camera)', 'built before the boot compiles')
})

test('the engine: furnishing only for the owner, on foot inside the home, out of a headset and of a network room; the look held while it lasts and given back; it ends with the card or as soon as it is refused', () => {
  const raw = read('./engine.ts')
  const src = flat(raw)
  const refusal = between(src, ' furnishRefusal(home: number): string | null {', ' get furnishing(): boolean {')
  assert.ok(refusal.includes("if (this.netRoom) return 'Furnishing waits until you leave the shared room: it replays your walk and does not know your furniture'"), 'the room replays the walk and knows nothing of the furniture')
  for (const [check, why] of [
    ['if (this.rig.headset) return ', 'the plan is drawn on the page'],
    ['if (st.driving >= 0) return ', 'on foot'],
    ['if (homeAt(this.homes, st.avatar.x, st.avatar.z) !== home) return ', 'inside that home'],
    ['if (((this.homeDeeds >>> home) & 1) !== 1) return ', 'the deed owned, by the same mask the furniture is drawn with'],
  ] as const) assert.ok(refusal.includes(check), why)
  // The card: 2a's hold as it was (pinned above); furnishing only on a card that took, and only where it is allowed.
  const card = between(src, ' setHomeCard(home: number | null, furnish = false): boolean {', ' furnishRefusal(')
  assert.ok(card.includes('if (home === null || !furnish || home !== this.furnishHome || this.furnishRefusal(home) !== null) this.endFurnish()'), 'closed, asked without it, another home, or refused: it ends')
  before(card, 'this.homeCard = home', 'if (furnish && this.furnishHome === null && this.furnishRefusal(home) === null) this.beginFurnish(home)', 'only on a card that took')
  const begin = between(src, ' private beginFurnish(home: number): void {', ' private endFurnish(')
  const end = between(src, ' private endFurnish(): void {', ' setOwnedHomes(')
  assert.ok(begin.includes('this.furnishYaw = this.input.yaw') && begin.includes('this.furnishPitch = this.input.pitch'), 'the look kept on open, yaw and pitch')
  assert.ok(end.includes('this.input.yaw = this.furnishYaw') && end.includes('this.input.pitch = this.furnishPitch'), 'and given back on close')
  // Held every frame between: Input turns the head by the right stick even under suspend, and the card's right stick
  // turns the draft camera, so whatever the poll turned is put back before the controls read the yaw (the figure's
  // heading) and the rig the look. Pitch as well as yaw: the card turns its view on the stick's x alone, and a flick
  // that leans a little up, as a thumb does, tilts the head too.
  const look = new PadLook(), step = { yaw: 0, pitch: 0 }
  let yaw = 0, pitch = 0
  for (let i = 0; i < 45; i++) {
    look.step(i < 15 ? 0.8 : 0, i < 15 ? 0.35 : 0, 1 / 60, step)
    yaw += step.yaw
    pitch += step.pitch
  }
  assert.ok(Math.abs(yaw) > 0.2 && Math.abs(pitch) > 0.05, `a quarter-second flick at (0.8, 0.35) turns the head ${yaw.toFixed(3)} rad and tilts it ${pitch.toFixed(3)} rad`)
  const loop = between(raw, '  frame(nowMs: number): void {', '  /** One drawn frame')
  const hold = 'if (this.furnishHome !== null) { input.yaw = this.furnishYaw; input.pitch = this.furnishPitch }'
  before(loop, 'input.poll(dt)', hold, 'after the poll that turned it')
  before(loop, hold, 'readControls(input, driving >= 0, foot, drive)', 'before the figure\'s heading is read from the yaw')
  before(loop, hold, 'this.rig.onFoot(cam, av.x, av.feetY, av.z, input.yaw, input.pitch, dt)', 'and before the rig reads the look')
  assert.equal((raw.match(/this\.furnishHome = /g) ?? []).length, 2, 'begun in one place, ended in one place')
  // Ended at once once refused: the card's end, a network room, a headset, the deed gone.
  const frame = between(raw, '  frame(nowMs: number): void {', '  /** One drawn frame')
  before(frame, 'if (this.homeCard !== null && (this.homeHere !== this.homeCard || this.rig.headset)) this.homeCard = null', 'if (this.furnishHome !== null && (this.homeCard !== this.furnishHome || this.furnishRefusal(this.furnishHome) !== null)) this.endFurnish()', 'after the card\'s own end')
  before(frame, 'this.endFurnish()', 'this.present(nowMs, st, focusX, focusZ)', 'before the draw')
})

test('the engine: every home drawn from boot; a home\'s solids sent only when they change and never in a network room; a room draws no pieces and forgets what was sent; leaving sends every home again', () => {
  const raw = read('./engine.ts')
  const src = flat(raw)
  // The default finishes and the show homes from the first frame, before the host hands over its record and deeds.
  assert.ok(between(src, ' private constructor(p: {', ' static async create(').includes('this.setFurnishings(freshHomes(), 0, 0)'), 'drawn and solid at boot')
  const set = between(src, ' setFurnishings(record: HomeRecord, deedMask: number, lineMask: number): void {', ' setHomeDraft(')
  before(set, 'this.redrawHomes()', 'this.sendHomes()', 'drawn, then sent')
  const draw = between(src, ' private redrawHomes(): void {', ' private sendHomes(')
  assert.ok(draw.includes('this.world.setHomes(homeInstances(this.homes, this.homeRecord, this.homeDeeds, this.homeLines, { room: this.netRoom, base: this.homeBase, draft }))'), 'in a room the finishes alone')
  assert.ok(draw.includes('const d = this.draft, draft = d && this.furnishHome !== null && d.home === this.furnishHome ? d : null'), 'the ghost and cursor only while that home is furnished')
  const send = between(raw, '  private sendHomes(): void {', '\n  }\n')
  assert.match(send, /^ {4}if \(this\.netRoom \|\| this\.halted \|\| this\.disposed\) return$/m, 'never in a network room: its realm refuses the command')
  assert.ok(send.includes('const boxes = homeSolids(h, homePlaced(h.home, this.homeRecord, this.homeDeeds, this.homeLines))'), 'the solids of the pieces drawn')
  before(send, 'if (this.homeSent[h.home] === key) continue', "this.sim.send({ c: 'home', index: h.home, boxes })", 'only a change is sent')
  assert.equal((raw.match(/c: 'home'/g) ?? []).length, 1, 'one place sends a home\'s solids')
  assert.equal((raw.match(/this\.sendHomes\(\)/g) ?? []).length, 2, 'on a change of furnishing and on leaving a room')
  assert.ok(src.includes("private readonly homeSent: (string | null)[] = Array.from({ length: HOME_COUNT }, () => '')"), 'the realm starts with no set')
  // Joining: the room's start goes ahead of everything queued (simClient.ts first), so a 'home' queued just before it is
  // refused; what was sent is forgotten, and the homes are drawn without pieces.
  const nf = between(raw, '  private netFrame(', '  /**\n   * A realm state as the room')
  before(nf, "this.sim.send({ c: 'room', on: true }, true)", 'this.netRoom = true', 'the room mode first')
  before(nf, 'this.netRoom = true', 'this.endFurnish()', 'furnishing ends in the room')
  before(nf, 'this.netRoom = true', 'this.homeSent.fill(null)', 'every home to send again')
  before(nf, 'this.homeSent.fill(null)', 'this.redrawHomes()', 'and drawn without pieces')
  // Leaving: the room's end first (sent ahead), then every home drawn and sent behind it.
  const go = between(raw, '  private netLetGo(why: string): void {', '\n  }\n')
  before(go, 'const inRoom = this.netRoom', "this.sim.send({ c: 'room', on: false }, true)", 'whether it was in a room, read before it is left')
  before(go, 'this.netRoom = false', 'if (inRoom) { this.redrawHomes(); this.sendHomes() }', 'out of the room before anything is sent')
})

test('the engine: the draft camera posed in present() alone, after the mirror\'s term, the head restored after the draw; pickCell through the copy kept before the head goes back; blockedCells from the local avatars on foot', () => {
  const raw = read('./engine.ts')
  const src = flat(raw)
  const present = between(src, ' private present(', ' private presentView(')
  const mirror = 'const mirror = this.showroom && orbitEye(st.avatar.x, st.avatar.feetY, st.avatar.z, this.showroom.angle) || this.furnishView()'
  assert.ok(present.includes(mirror), 'the shop\'s orbit first, then the draft camera, posed through the same lines')
  assert.equal((src.match(/this\.furnishView\(\)/g) ?? []).length, 1, 'posed in present() alone')
  const copy = 'this.pickCam = (this.pickCam ?? cam.clone()).copy(cam, false)'
  for (const [a, b] of [
    [mirror, 'cam.lookAt(mirror.at.x, mirror.at.y, mirror.at.z)'],
    ['cam.lookAt(mirror.at.x, mirror.at.y, mirror.at.z)', 'packFrustumPlanes(this.frustum.planes, this.planes)'],
    ['else this.gpu.renderer.render(this.world.scene, cam)', copy],
    [copy, 'cam.position.copy(this.headPos)'],
    ['cam.position.copy(this.headPos)', 'cam.quaternion.copy(this.headRot)'],
  ] as const) before(present, a, b, `${a} before ${b}`)
  assert.ok(present.includes('if (!this.showroom && this.furnishHome !== null) {'), 'the copy is the draft camera\'s, never the shop\'s orbit')
  assert.equal((src.match(/this\.pickCam = /g) ?? []).length, 1, 'kept in one place')
  const view = between(src, ' private furnishView(): ', ' private redrawHomes(')
  assert.ok(view.includes('if (home === null || !d || d.home !== home) return null'), 'only the draft of the home being furnished')
  assert.ok(view.includes('return h ? furnishEye(h, d.cursor, d.view) : null'))
  const pick = between(src, ' pickCell(clientX: number, clientY: number): { c: number; r: number } | null {', ' private furnishView(')
  assert.ok(pick.includes('this.pickHome !== home'), 'only once that home\'s draft camera has drawn')
  assert.ok(pick.includes('const view = this.views.length > 1 ? this.views[0].rect : { x: 0, y: 0, width: cw, height: ch }'), 'player 1\'s view of the canvas: the whole of it alone, whatever it was resized to')
  before(pick, 'const eye = cam.getWorldPosition(this.pickEye)', '.unproject(cam).sub(eye)', 'a ray from the eye through the point')
  assert.ok(pick.includes('const y = this.homeBase + PICK_FLOOR'), 'met with the floor 5 cm up (a region\'s paved floor under it)')
  before(pick, 'const at = toLocal(h, eye.x + d.x * t, eye.z + d.z * t)', 'const cell = cellAt(at.u, at.v)', 'in the room frame')
  assert.ok(pick.includes('return cell && inMask(home, cell.c, cell.r) ? cell : null'), 'only a cell of the home\'s floor plan')
  assert.ok(src.includes('const PICK_FLOOR = 0.05'))
  assert.ok(src.includes('this.homeBase = p.places ? SURFACE.sidewalk : 0'), 'a region\'s homes stand on its paved floors')
  const blocked = between(src, ' blockedCells(home: number): Uint8Array {', ' pickCell(')
  assert.ok(blocked.includes('if ((st.drivings[k] ?? -1) < 0 && homeAt(this.homes, a.x, a.z) === home) people.push(toLocal(h, a.x, a.z))'), 'every local avatar on foot in that home, in its room frame')
  assert.ok(blocked.includes('return cellsNear(people, PERSON.radius + STAND_CLEAR)'))
  assert.ok(src.includes('const STAND_CLEAR = 0.05'))
  // No word the house keeps out of the engine's pinned ranges in the furnishing's own code.
  assert.doesNotMatch(between(raw, '  setFurnishings(record: HomeRecord', '  /**\n   * A ping of `kind`'), FORBIDDEN)
  assert.doesNotMatch(between(raw, '  setHomeCard(home: number | null, furnish = false): boolean {', '  /** Enter the nearest car'), FORBIDDEN)
})
