// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the storefronts (01_Initialize_World/storefronts.ts), which
 * the engine, the HUD and App carry and Node cannot run: the city's buildings are hollowed for the shops after the
 * workplaces, the worker's exit rule knows the shops' glass (the city's, or a generated region's lots), the engine
 * keeps the city's shops or the region's (region/shops.ts, hollowed by regionWorld.ts hollowLots and handed to the worker)
 * and opens a shop's card from E (a car in reach keeps E for its door) or B, the mirror camera circles the body while
 * the card is open and ends when the avatar leaves the shop, the HUD shows the shop's chip and draws the shops on the
 * minimap, and App opens the card from the engine and the chip, suspends the game's input while it is open, wears a
 * try-on without keeping it, and gives the eye back on close. Source-level, as the other wiring tests are.
 * What breaks if it is removed? A shop could stand in the city with no way to open its card, keep the eye circling
 * after the card closed, keep a try-on nobody paid for, or let E open the card instead of a car's door.
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

test('the city and the worker: shops hollowed after the workplaces; a car left in a shop puts its driver down clear of the glass', () => {
  const city = flat(read('../01_Initialize_World/city.ts'))
  before(city, 'hollowWorkplaces(seed, out)', 'hollowShops(seed, out)', 'the workplaces first, so the shops pick among the lots left')
  const core = flat(read('./simCore.ts'))
  assert.ok(core.includes('this.#glass = [...rooms, ...(o.region ? (o.streets && o.shops?.length ? shopsAt(o.shops) : []) : shops(o.seed))]'), 'the city\'s shops, or the region\'s lots')
  assert.ok(core.includes('exitPoint(t.x, t.z, h, this.#glass)'))
  // The network room's authority puts a driver down by the same rooms, or it refuses every exit at a shop.
  const garage = flat(read('../10_Network/garage.node.ts'))
  assert.ok(garage.includes('this.#rooms = [...workplaces(this.seed), ...shops(this.seed)]'))
})

test('the engine: the city\'s shops kept; E opens a shop\'s card unless a car is in reach, B always; the mirror camera ends outside the shop', () => {
  const src = flat(read('./engine.ts'))
  assert.ok(src.includes('shops: hollow ? hollow.shops.map((s) => (places ? { ...s, arcade: places.place(s.door.x, s.door.z) } : s)) : cityShops(options.seed),'), 'the city\'s shops, or the region\'s at their own addresses')
  // The card names the shop's own arcade (a region's address there), never the city's district for its kind.
  const card = flat(read('./StoreCard.tsx'))
  assert.ok(card.includes('data-arcade>{shop.arcade}</div>'))
  assert.ok(!card.includes('info.arcade'))
  // A region's shops: picked after its workplaces, never on one of their lots, hollowed with them, the same lots to the worker.
  before(src, 'const lots = pack && layout && streets ? regionWorkplaceLots(', 'const shopLots = pack && layout && streets ? regionShopLots(pack, layout, streets, spawn, options.seed, lots) : []', 'the workplaces first')
  assert.ok(src.includes('hollowLots(pack, layout, lots, shopLots)'))
  assert.ok(src.includes('...(shopLots.length > 0 && { shops: shopLots }),'), 'the worker builds the same glass')
  assert.ok(src.includes('drawRooms(ctx, rooms, x, z, dark, radius); drawShops(ctx, shops, x, z, dark, radius)'), 'the region\'s minimap shows its shops')
  assert.ok(src.includes("if (input.take('interact') && !this.browse(true)) { this.doorPressedAt = performance.now(); this.interact() }"), 'E is the shop\'s only when browse took it, and only a door press is stamped (progress.ts)')
  assert.ok(src.includes("if (input.take('browse')) this.browse()"), 'B asks without the car check')
  assert.ok(src.includes('if (i < 0 || (interact && this.nearestCar(st.avatar.x, st.avatar.z, ENTER_RANGE) >= 0)) return false'), 'a car in reach keeps E (only E) for its door')
  assert.ok(src.includes('if (show && (this.shopHere !== show.shop || this.rig.headset || this.netRoom)) this.showroom = null'), 'out of the shop, in a headset or a room, the eye goes back to the head')
  assert.ok(src.includes('if (!shop || this.netRoom || st.driving >= 0 || this.rig.headset ||'), 'no step onto the fitting spot the network room did not make')
  // The orbit is the draw's alone (present()): posed and its matrices refreshed before the cull reads them, the head
  // put back after the draw, so the listener (fed after present()) keeps the head.
  const present = src.slice(src.indexOf(' private present('), src.indexOf(' private expose('))
  assert.ok(present.length > 0, 'present() found')
  for (const [a, b] of [
    ['const mirror = this.showroom && orbitEye(st.avatar.x, st.avatar.feetY, st.avatar.z, this.showroom.angle)', 'cam.lookAt(mirror.at.x, mirror.at.y, mirror.at.z)'],
    ['cam.lookAt(mirror.at.x, mirror.at.y, mirror.at.z)', 'cam.updateMatrixWorld()'],
    ['cam.updateMatrixWorld()', 'this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)'],
    ['else this.gpu.renderer.render(this.world.scene, cam)', 'cam.quaternion.copy(this.headRot)'],
  ] as const) before(present, a, b, `${a} before ${b}`)
  before(src, 'this.present(nowMs, st, focusX, focusZ)', 'this.listen(dt, st)', 'the listener after the draw, with the head back')
  const input = flat(read('../04_Connect_Hardware/input.ts'))
  assert.ok(input.includes("KeyB: 'browse',"))
})

test('the HUD: the shop\'s chip while on foot in a shop with its card closed; the shops on the city\'s minimap', () => {
  const src = flat(read('./Hud.tsx'))
  assert.ok(src.includes('const shopChip = shop && !shop.showroom && !driving && !terminalOpen && ('), 'never behind the console')
  assert.ok(src.includes('onClick={() => onBrowse?.(shop.index)}'))
  assert.ok(src.includes('if (seed !== undefined) drawShops(ctx, shopsOf(seed), x, z, dark)'))
})

test('App: the card from the engine and the chip; input suspended while open; a try-on worn, never kept; the eye given back on close', () => {
  const src = flat(read('../App.tsx'))
  assert.ok(src.includes('e.onBrowse = openStore'))
  assert.ok(src.includes('onBrowse={openStore}'), 'the chip opens the same card')
  assert.ok(src.includes('useEffect(() => { engine?.setShowroom(storeOpen) }, [engine, storeOpen])'), 'the mirror camera follows the card, open and closed')
  assert.ok(src.includes('engineRef.current?.input.suspend(lookOpen || storeOpen !== null || termOpenRef.current)'))
  assert.ok(src.includes('engineRef.current?.input.suspend(open || lookOpenRef.current || storeOpenRef.current !== null)'))
  assert.ok(src.includes("if (storeOpenRef.current !== null && ((s.customer.shop?.index ?? -1) !== storeOpenRef.current || s.supplier.xr.state === 'vr' || s.supplier.xr.state === 'ar')) closeStore()"), 'out of the shop or into a headset, the card goes')
  assert.ok(src.includes('useEffect(() => { engine?.setLook(PLAYER_INDEX, trying?.look ?? worn) }, [engine, worn, trying])'), 'a try-on over the look, the look itself untouched')
  assert.ok(src.includes('const closeStore = useCallback(() => { setStoreOpen(null); setTrying(null) }, [])'), 'closing takes the try-on off')
  assert.ok(src.includes('onWear={wearLook}'), 'a bought line is kept the way the wardrobe keeps a look')
  assert.ok(src.includes('visible={storeOpen !== null && veilDone && !termOpen && locked === null}'), 'never over the veil, the console or a halted city')
  assert.ok(!/onTry=\{[^}]*saveLook/.test(src), 'a try-on is never saved')
  // The Concierge steps aside while the card is open, as it does for the wardrobe card.
  assert.ok(src.includes('!lookOpen && storeOpen === null && locked === null'))
})
