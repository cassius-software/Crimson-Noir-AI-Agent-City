// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence that the first walk is wired through the page: the hook's small
 * readers (the glyph family to the device's words, a bearing, the nearest workplace, the machine for the first card,
 * the marker's place), the hook reading the engine for nothing but its rooms and its car count, App switching the
 * walk on from the URL and the pass record, feeding it the Concierge's goal, the console's lines and opening, the
 * HUD's microphone and captions, lighting the control and placing the marker while it lends a hand, printing the
 * banner when the console is reached, holding the quiet watch until it is passed, and the card having no close, no
 * skip and no key that puts it away while every stage has its accessible button. Source-level, as the other wiring
 * tests are: the components need a browser to render.
 * What breaks if it is removed? A prop or a report could be dropped and a stage would never finish, or a close could
 * be added and the walk would be a card like any other.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { BRAIN_UNKNOWN, type BrainDefault, type BrainReadout } from '../../09_Cognition/brainReadout.ts'
import { PROGRAM } from '../../09_Cognition/firstWalk.ts'
import { TICK_MS, beaconOf, bearingOf, machineOf, nearestPlace, sloaneOf, wordsOf } from './useFirstWalk.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const shown = (src: string) => src.replace(/^import .*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the hook\'s readers: the device\'s words from the glyphs, a bearing, the nearest workplace', () => {
  assert.deepEqual(wordsOf('keyboard'), { move: 'W A S D', look: 'Mouse', interact: 'E', console: '~' })
  assert.deepEqual(wordsOf('touch'), { move: 'Stick', look: 'Drag', interact: 'Enter car', console: 'Menu' })
  assert.deepEqual(wordsOf('abxy'), { move: 'L', look: 'R', interact: 'A', console: 'Menu' }, 'a pad opens the console from its own menu (PadMenu.tsx)')
  assert.equal(wordsOf('bayx').interact, 'B')
  assert.equal(bearingOf(0, 0, 10, 1), 'east')
  assert.equal(bearingOf(0, 0, -10, 1), 'west')
  assert.equal(bearingOf(0, 0, 1, -10), 'north')
  assert.equal(bearingOf(0, 0, 1, 10), 'south')
  const rooms = [{ name: 'Medical Triage Clinic', door: { x: 100, z: 0 } }, { name: 'Executive Boardroom', door: { x: 0, z: -30 } }]
  assert.deepEqual(nearestPlace(rooms, 0, 0), { name: 'the Executive Boardroom', metres: 30, bearing: 'north' })
  assert.deepEqual(nearestPlace(rooms, 90, 0), { name: 'the Medical Triage Clinic', metres: 10, bearing: 'east' })
  assert.equal(nearestPlace([], 0, 0), null)
  assert.equal(TICK_MS, 1000)
})

test('the first card\'s machine: the device, its graphics and the tier in plain words, the bar from Lite to Peak', () => {
  const laptop = machineOf('desktop', 'integrated', { label: 'Medium', tier: 2 })
  assert.deepEqual({ ...laptop }, { device: 'A laptop or desktop', graphics: 'built-in graphics', picture: 'Medium', level: 4 / 7 })
  assert.ok(Object.isFrozen(laptop))
  assert.equal(machineOf('phone', 'mobile', { label: 'Lite', tier: -1 }).level, 1 / 7, 'Lite is the bar\'s first step, never empty')
  assert.equal(machineOf('phone', 'mobile', { label: 'Lite', tier: -1 }).device, 'A phone')
  assert.equal(machineOf('workstation', 'discrete', { label: 'Peak', tier: 5 }).level, 1)
  assert.equal(machineOf('workstation', 'discrete', { label: 'Peak', tier: 5 }).graphics, 'its own graphics card')
  assert.equal(machineOf('desktop', 'unknown', { label: 'Low', tier: 1 }).graphics, '', 'unknown graphics say nothing')
  // A tier out of range or not a number is held to the scale: the bar never overflows or goes empty.
  assert.equal(machineOf('desktop', 'discrete', { label: 'Peak', tier: 9 }).level, 1)
  assert.equal(machineOf('desktop', 'discrete', { label: '?', tier: Number.NaN }).level, 1 / 7)
  assert.equal(machineOf('desktop', 'discrete', { label: 'High', tier: 3.4 }).level, 5 / 7)
})

test('Sloane\'s row: the model she thinks with where one answers, else her default model coming, else ready to plan; the readout\'s line beside it', () => {
  const brain = (over: Partial<BrainReadout>): BrainReadout => Object.freeze({ ...BRAIN_UNKNOWN, provider: 'auto', ...over })
  const coming = (over: Partial<BrainDefault>): BrainDefault => Object.freeze({ from: 'site', file: 'm.gguf', title: 'Model', bytes: 400, state: 'getting', step: 'download', done: 100, total: 400, why: null, ...over })
  // Before the page binds a readout: nothing known, and her scripted planner still plans.
  assert.deepEqual({ ...sloaneOf(BRAIN_UNKNOWN) }, { text: 'Ready to plan', detail: BRAIN_UNKNOWN.where })
  assert.ok(Object.isFrozen(sloaneOf(BRAIN_UNKNOWN)))
  // Each brain that answers, in a few words; the readout's whole line rides along unchanged.
  const where = 'Sloane answers with the model kept in this page (m.gguf), run on this device'
  assert.deepEqual({ ...sloaneOf(brain({ settled: true, brain: 'page', local: true, model: 'm.gguf', where })) }, { text: 'Thinking on this device', detail: where })
  assert.equal(sloaneOf(brain({ settled: true, brain: 'app', local: true })).text, 'Thinking on this device')
  assert.equal(sloaneOf(brain({ settled: true, brain: 'server', local: true, server: 'http://127.0.0.1:11434' })).text, 'Thinking with a model on this machine')
  assert.equal(sloaneOf(brain({ settled: true, brain: 'server', gateway: true, server: 'http://127.0.0.1:8787' })).text, 'Thinking off this machine', 'the gateway is never called this device')
  // A model answering wins over her default model still on its way.
  assert.equal(sloaneOf(brain({ settled: true, brain: 'server', local: true, default: coming({}) })).text, 'Thinking with a model on this machine')
  // No model answering: her default model's progress while it comes, in whole percent.
  assert.equal(sloaneOf(brain({ default: coming({}) })).text, 'Getting her model, 25%')
  assert.equal(sloaneOf(brain({ settled: true, brain: 'scripted', default: coming({ step: 'keep', done: 399, total: 400 }) })).text, 'Keeping her model, 99%')
  assert.equal(sloaneOf(brain({ default: coming({ done: 0, total: 0 }) })).text, 'Getting her model, 0%', 'nothing counted yet is 0, never NaN')
  assert.equal(sloaneOf(brain({ default: coming({ from: 'native', state: 'checking', step: null, done: 3, total: 4 }) })).text, 'The app checks her model, 75%')
  // Otherwise ready to plan, which is always true: the scripted planner answers, her model is kept, held or none.
  for (const state of ['kept', 'held', 'waiting', 'none'] as const) {
    assert.equal(sloaneOf(brain({ settled: true, brain: 'scripted', default: coming({ state, step: null }) })).text, 'Ready to plan', state)
  }
  assert.equal(sloaneOf(brain({})).text, 'Ready to plan', 'under auto before a look')
})

test('the marker: the nearest parked car on the car stage, the nearest doorway on the indoor stage, nothing elsewhere', () => {
  const cars = [
    { x: 5, z: 0, mode: 'player' },
    { x: 8, z: 0, mode: 'moving' },
    { x: 40, z: 0, mode: 'parked' },
    { x: -30, z: 0, mode: 'parked' },
  ]
  const rooms = [{ name: 'medical triage clinic', door: { x: 100, z: 0 } }, { name: 'executive boardroom', door: { x: 0, z: -30 } }]
  assert.deepEqual(beaconOf('fleet', { cars, rooms }, 0, 0), { x: -30, z: 0, label: 'Parked car' }, 'a parked car before a nearer moving one, never the visitor\'s own')
  assert.deepEqual(beaconOf('fleet', { cars: cars.slice(0, 2), rooms }, 0, 0), { x: 8, z: 0, label: 'Car' }, 'a moving car only when none is parked, and not called a parked one')
  assert.equal(beaconOf('fleet', { cars: cars.slice(0, 1), rooms }, 0, 0), null, 'the visitor\'s own car is never the marker')
  assert.deepEqual(beaconOf('work', { cars, rooms }, 0, 0), { x: 0, z: -30, label: 'Workplace door' })
  assert.deepEqual(beaconOf('work', { cars, rooms }, 90, 0), { x: 100, z: 0, label: 'Workplace door' })
  assert.equal(beaconOf('work', { cars, rooms: [] }, 0, 0), null)
  for (const stage of ['move', 'voice', 'style', 'console', null] as const) assert.equal(beaconOf(stage, { cars, rooms }, 0, 0), null, `${stage}: no marker`)
})

test('the hook listens and never writes: readings from the snapshot, the engine asked only for its rooms, its car count and whether it has shops and homes, the pass kept once', () => {
  const src = read('./useFirstWalk.ts')
  assert.match(src, /engine\.workplaces\(\)/)
  assert.match(src, /engine\.simControls\(\)\.vehicles\.count\(\) > 0/)
  assert.match(src, /stores: engine\.shops\.length > 0/, 'the look stage names the shops only on a map that has them')
  assert.doesNotMatch(src, /engine\.shops(?!\.length > 0)/, 'and of the shops, only whether there are any')
  assert.match(src, /homes: engine\.homes\.length > 0/, 'the look stage names the homes only on a map that has them')
  assert.doesNotMatch(src, /engine\.homes(?!\.length > 0)/, 'and of the homes, only whether there are any')
  assert.doesNotMatch(src, /engine\.(?!workplaces\b|simControls\b)[a-zA-Z]+\(/, 'nothing else of the engine is called')
  assert.doesNotMatch(src, /simControls\(\)\.(?!vehicles\.count\(\))/, 'and of the controls, only the car count')
  assert.match(src, /insideRoom\(r, x, z\)/)
  assert.match(src, /hud\.customer\.viewYaw/)
  assert.match(src, /hud\.input\.mode === 'vehicle'/)
  assert.match(src, /w\.read\(readingOf\(hud, engine, termOpen\), now\(\)\)/)
  // The first reading is taken as the walk starts, before the card can be pressed: a turn made before the next snapshot
  // (Walk for me, pressed at once) is not the anchor itself.
  assert.match(src, /w\.start\(now\(\)\)\n\s+walk\.current = w\n(?:\s+\/\/[^\n]*\n)*\s+if \(h\) w\.read\(readingOf\(h, engine, latest\.current\.termOpen\), now\(\)\)\n\s+sync\(\)/)
  assert.match(src, /if \(w\.passed && !kept\.current\) \{\s*kept\.current = true\s*saveFirstWalkPassed\(/)
  assert.match(src, /mustKeep\(s, b\.keep\)/, 'a rewording that drops the key or command is not shown')
  assert.match(src, /const line = useCallback\(\(_text: string\) => \{ note\('console'\) \}, \[note\]\)/, 'any console line is the console in use')
  assert.match(src, /setAssisting\(w\.assisting\)/, 'the lent hand follows the walk')
  assert.doesNotMatch(src, /installed\(|\.answer\(|\.load\(|job\.start/, 'the machine reading looks at nothing that probes, asks or downloads')
  // The clocks are made once: an inline default is a new function each render, which restarted the once-a-second tick
  // on every HUD snapshot (ten a second), so on a fast machine Sloane's lines, the hint, the hand and the closing line
  // never came.
  assert.match(src, /^const PERF_NOW = \(\): number => performance\.now\(\)$/m)
  assert.match(src, /^const WALL_NOW = \(\): number => Date\.now\(\)$/m)
  assert.match(src, /, now = PERF_NOW, wallClock = WALL_NOW, timing \}: FirstWalkProps\)/)
  assert.doesNotMatch(src, /(?:now|wallClock) = \(\) =>/, 'no clock made inline in the parameters')
  assert.match(src, /\}, \[ready, engine, now, sync\]\)/)
})

test('App: the walk is switched on from the URL and the pass record, fed the Concierge\'s goal, the console\'s lines and opening, the HUD\'s microphone and captions, the wardrobe, a shop\'s card or a home\'s doorstep card put away; the quiet watch waits for it', () => {
  const src = read('../../App.tsx')
  assert.match(src, /needsFirstWalk\(new URLSearchParams\(window\.location\.search\), loadFirstWalk\(\)\)/)
  assert.match(src, /useFirstWalk\(\{ active: walk && veilDone/)
  assert.match(src, /const walking = walk && !fw\.passed/)
  assert.match(src, /useMentor\(\{ active: mentored && veilDone && !walking/)
  assert.match(src, /onGoalSent=\{onGoalSent\}/)
  assert.match(src, /onLine=\{fw\.line\}/)
  // One city console, the one the walk hears: a branch update once left a second <Terminal> holding termRef without onLine.
  assert.equal(src.match(/<Terminal ref=\{termRef\}/g)?.length, 1, 'exactly one city console')
  assert.match(src, /<Terminal ref=\{termRef\}[^>]*onLine=\{fw\.line\}/)
  assert.match(src, /walkRef\.current\.note\('console'\)/)
  assert.match(src, /walkRef\.current\.note\('mic'\)/)
  assert.match(src, /walkRef\.current\.note\('captions'\)/)
  // The look stage: the wardrobe card put away (by Done, its close button, Escape or the console) after it was open.
  assert.match(src, /if \(lookWas\.current && !lookOpen\) walkRef\.current\.note\('wardrobe'\)\s*lookWas\.current = lookOpen/)
  // Or a shop's card put away (Done, ×, Escape, the console, walking out of the shop, a headset) after it was open.
  assert.match(src, /if \(storeWas\.current && storeOpen === null\) walkRef\.current\.note\('store'\)\s*storeWas\.current = storeOpen !== null/)
  // Or a home's doorstep card put away (Done, ×, Escape, B, the console, walking out of the home, a headset) after it was open.
  assert.match(src, /if \(homeWas\.current && homeOpen === null\) walkRef\.current\.note\('home'\)\s*homeWas\.current = homeOpen !== null/)
  assert.match(src, /\}, \[lookOpen, storeOpen, homeOpen\]\)/, 'the effect that hears the cards runs when the doorstep card opens or closes')
  assert.match(src, /<FirstWalkCard\s+visible=\{veilDone && !lookOpen && storeOpen === null && homeOpen === null && locked === null\}/, 'the walk\'s card steps aside for the wardrobe, a shop\'s card and a home\'s doorstep card')
  assert.match(src, /onShow=\{showWalk\}/)
  assert.match(src, /walk: \(\) => walkRef\.current\.stage/, 'the smoke reads the stage')
  // The accessible path goes through the same controls the operator tier has, and the console's handle.
  assert.match(src, /case 'move': \{\s*e\.input\.yaw \+= 0\.7/)
  assert.match(src, /case 'style': openLook\(\); return/, 'the look stage\'s button opens the wardrobe card the chip opens')
  assert.match(src, /case 'console': termRef\.current\?\.open\(\); return/, 'the last stage\'s button opens the console, which ends the walk')
  assert.doesNotMatch(src, /case 'ring0'|case 'exam'/, 'the old Ring-0 and program stages are gone')
  // While it lends a hand: the control lit (one attribute on the root, taken away with the hand), the marker placed
  // from the HUD's own cars and the engine's rooms, and taken away when the walk is over.
  assert.match(src, /const assistTarget = walking && fw\.assisting && fw\.stage !== null \? assistTargetOf\(fw\.stage, familyOf\(hud\?\.supplier\.glyphs \?\? 'keyboard'\)\) : null/)
  assert.match(src, /if \(assistTarget === null\) \{ delete root\.dataset\.walkAssist; return \}\s*root\.dataset\.walkAssist = assistTarget\s*return \(\) => \{ delete root\.dataset\.walkAssist \}/)
  assert.match(src, /e\.setBeacon\(walking && hud \? beaconOf\(fw\.stage, \{\s*cars: hud\.map\.map\(/)
  assert.match(src, /rooms: e\.workplaces\(\),\s*\}, hud\.customer\.x, hud\.customer\.z\) : null\)/)
  // The walk passed: the banner printed in the console once and the passed line said (the card is gone by then).
  assert.match(src, /if \(b === null \|\| b\.kind !== 'passed' \|\| passedSaid\.current !== -1\) return\s*passedSaid\.current = b\.id\s*termRef\.current\?\.print\(passedBanner\(profile\?\.name \?\? '', familyOf\(hud\?\.supplier\.glyphs \?\? 'keyboard'\)\)\)\s*onSay\(b\.text\)/)
  // The exam behind the exit program: composed in the console bridge over the host's vouch for the air gap, the
  // kernel-panic state, the bridge's laws, the page's one team runner and the walk; the nonce drawn once per page load.
  assert.match(src, /exam: createExam\(\{/)
  assert.match(src, /contained: \(\) => airgapInstalled\(globalThis\)/)
  assert.match(src, /standing: \(\) => lockedRef\.current === null/)
  assert.match(src, /laws: \(\) => engineBridge\.laws\(\)/)
  assert.match(src, /checks: \(\) => GATE_CHECK_NAMES/, 'the gate\'s check names come through the operator tier, one of the gate\'s three keepers')
  // The swarm: the planner's sixteen-desk team for the count, through the runner Sloane's goals use (never a second
  // runner, never the recruiter's within-earshot ask, which left a visitor inside a workplace with a swarm of 0), one
  // tick at once, and the count of lanes still running after it.
  const swarm = src.slice(src.indexOf('swarm: (n, role) => {'), src.indexOf('nonce: crypto.getRandomValues'))
  assert.ok(swarm.length > 0, 'the exam host has a swarm')
  assert.match(swarm, /const replaced = team\.views\(\)\.length\n\s+const plan = swarmTeam\(n, `spawn_subagents\(\$\{n\}, "\$\{role\}"\)`\)\n\s+const d = team\.dispatch\(plan\)\n\s+team\.tick\(\)\n\s+const running = team\.views\(\)\.filter\(\(v\) => v\.state === 'ready'\)\.length/)
  assert.match(swarm, /return \{ running, opened: d\.lanes, desks: plan\.kinds\.length, replaced, missing: d\.missing \}/)
  assert.doesNotMatch(swarm, /tryAsk|\br\.recruit\(/, 'the runner asks the bodies, once')
  assert.ok(src.indexOf('const team = new TeamRunner(') < src.indexOf('exam: createExam({'), 'the runner exists before the exam is built')
  assert.match(src, /nonce: crypto\.getRandomValues\(new Uint32Array\(1\)\)\[0\]/)
  assert.match(src, /stage: \(\) => walkRef\.current\.stage/)
  assert.match(src, /on: \(\) => walk,/)
  assert.match(src, /note: \(ev\) => walkRef\.current\.note\(ev\)/)
})

test('the walk\'s card and Sloane\'s open card stand side by side on a wide screen, or the walk\'s steps aside where they cannot', () => {
  const app = read('../../App.tsx')
  const concierge = read('../Concierge.tsx')
  const card = read('./FirstWalk.tsx')
  // App: Sloane is told the walk's card is up and tells App when her card is open; the walk's card hears it.
  assert.match(app, /beside=\{walking && fw\.card !== null\}\s*zoom=\{access\.scale \/ 100\}\s*onOpen=\{setSloaneOpen\}/)
  assert.match(app, /crowded=\{sloaneOpen\}/)
  // Sloane: her wide column moves left of the walk's card when there is room, and her open state is any view but the chip.
  assert.match(concierge, /className=\{beside && roomy \? WIDE_BESIDE : WIDE_COLUMN\}/)
  assert.match(concierge, /const opened = visible && view !== 'chip'/)
  assert.match(card, /import \{ besideRoom \} from '\.\.\/Concierge\.tsx'/, 'one query for both sides')
  // Both cards are inside the text size's zoom, so the room is zoomed rem: twice the window at 200 %, one store per zoom.
  assert.match(concierge, /return `\(min-width: \$\{Math\.round\(BESIDE_ROOM_PX \* Math\.max\(1, zoom\)\)\}px\)`/)
  for (const src of [concierge, card]) assert.match(src, /const room = besideRoom\(zoom\)\n\s+const roomy = useSyncExternalStore\(room\.subscribe, room\.matches, room\.server\)/)
  assert.equal(app.match(/zoom=\{access\.scale \/ 100\}/g)?.length, 2, 'App hands both cards the same zoom')
  // Side by side only in the wide place with room for both: on a phone, a small window or a window small only at the
  // zoom, Sloane's open card takes the band the walk's card stands in (her short and tall layouts), so it steps aside.
  assert.match(card, /const besideHers = !overlay && !compact && !squeezed && roomy/)
  assert.match(card, /const heard = visible && !\(crowded && !termOpen && !besideHers\)\n/)
  assert.match(card, /const shown = heard && !\(between && driving\)\n/)
  // A window small only at the text size's zoom puts the card at the foot (not a sliver under the zoomed readout); it is
  // the compact query itself at 100 %, and still steps aside for Sloane's card, which stays in the window's centre.
  assert.match(card, /return `\(max-width: \$\{Math\.round\(639 \* z\)\}px\), \(max-height: \$\{Math\.round\(499 \* z\)\}px\)`/)
  assert.match(card, /const SMALL = mediaStore\('\(max-width: 639px\), \(max-height: 499px\)'\)/)
  assert.match(card, /const at = termOpen \? AT\.console : between \? AT\.between : overlay \? AT\.touch : compact \|\| squeezed \? AT\.compact : AT\.wide/)
  // A hint that comes while the card is away (not heard) is let go, never spoken late (closing a doorstep card can pass
  // the stage in the same commit that shows the card again); an ask or the passed line waits for the card.
  assert.match(card, /if \(!beat \|\| beat\.id === said\.current\) return\s*(?:\/\/[^\n]*\s*)*if \(!heard\) \{ if \(beat\.kind === 'hint'\) said\.current = beat\.id; return \}\s*said\.current = beat\.id\s*sayRef\.current\?\.\(beat\.text\)/)
  // The measures agree: Sloane's column ends short of the walk's card (its right inset plus its width), and at the
  // query's width it still has at least the 22 rem her centred column never went under.
  const walkRight = Number(/wide: 'right-\[max\(([\d.]+)rem/.exec(card)?.[1])
  const walkWidth = Number(/wide: '[^']*\bw-\[([\d.]+)rem\]/.exec(card)?.[1])
  const beside = /const WIDE_BESIDE = '[^']*left-\[([\d.]+)rem\] right-\[calc\(max\(([\d.]+)rem,env\(safe-area-inset-right\)\)_\+_([\d.]+)rem\)\]/.exec(concierge)
  assert.ok(beside, 'WIDE_BESIDE has a left and a right')
  const [left, inset, past] = [Number(beside[1]), Number(beside[2]), Number(beside[3])]
  assert.equal(inset, walkRight, 'measured from the same right inset')
  assert.ok(past >= walkWidth + 0.5, `${past} rem clears the ${walkWidth} rem card with a gap`)
  const room = Number(/export const BESIDE_ROOM_PX = (\d+)$/m.exec(concierge)?.[1]) / 16
  assert.ok(room - left - inset - past >= 22, `${room - left - inset - past} rem left for Sloane at ${room} rem`)
})

test('on a phone the walk\'s card keeps below Sloane\'s chip, and held sideways it stands between the thumbs above the HUD\'s chips', () => {
  const app = read('../../App.tsx')
  const hud = read('../Hud.tsx')
  const concierge = read('../Concierge.tsx')
  const card = read('./FirstWalk.tsx')
  const place = (name: string) => new RegExp(`\\b${name}: '([^']+)'`).exec(card)?.[1] ?? ''
  // Sloane's chip publishes where it ends in her tall layouts (lower at the wheel): the walk's card stops short of it.
  assert.match(concierge, /--chip-bottom/)
  assert.match(place('compact'), /max-h-\[[^\]]*max\(calc\(max\(0\.75rem,env\(safe-area-inset-top\)\)_\+_8\.75rem\),calc\(var\(--chip-bottom,0px\)_\+_0\.5rem\)\)/, 'compact keeps under the minimap row and her chip')
  // A phone held upright: the card starts under her chip and ends above the HUD's chips at the foot (latched at their
  // highest), the buttons and the stick's zone, while that band holds 7 rem; else it ends above the buttons and the
  // stick alone, over the HUD's chips; where even that band is short it stands above her chip, from the frame's top to
  // her chip's head. Never over her chip: stages ask the visitor to tap it.
  {
    const VH = 'calc(100dvh_/_var(--ui-zoom,1))'
    const TOP = 'max(0.75rem,env(safe-area-inset-top))'
    const CTL = 'calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)))_+_0.5rem)'
    const STK = 'calc(max(calc(var(--touch-top,10.5rem)_/_var(--ui-zoom,1)),calc(11.5rem_/_var(--ui-zoom,1)),calc(var(--hud-foot-peak,var(--hud-foot,0px))_/_var(--ui-zoom,1)))_+_0.5rem)'
    const UNDER = 'calc(var(--chip-bottom,0px)_+_0.5rem)'
    const HEAD = 'calc(var(--chip-head,0px)_-_0.5rem)'
    const step = (foot: string) => `clamp(0px,calc((7rem_-_calc(${VH}_-_${UNDER}_-_${foot}))_*_10000),100vh)`
    const LINE = `max(${TOP},calc(${UNDER}_-_${step(CTL)}))`
    const ABOVE = `calc(${VH}_-_${HEAD}_-_100vh_+_${step(CTL)})`
    const FOOT = `max(max(${CTL},calc(${STK}_-_${step(STK)})),${ABOVE})`
    const SIDES = 'left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))]'
    assert.equal(place('touch'), `${SIDES} bottom-[${FOOT}] mx-auto max-w-[28rem] max-h-[calc(${VH}_-_${LINE}_-_${FOOT})]`, 'under her chip above the HUD\'s chips, else above the controls, else above her chip')
    // Opened out with More it ends above the controls whatever the HUD's chips; the same top, never over her chip.
    const MORE = `max(${CTL},${ABOVE})`
    assert.equal(place('touchMore'), `${SIDES} bottom-[${MORE}] mx-auto max-w-[28rem] max-h-[calc(${VH}_-_${LINE}_-_${MORE})]`)
    assert.match(card, /const place = foldable && more \? AT\.touchMore : at\n/)
    // Her chip publishes its head beside its foot, and takes both away.
    assert.match(concierge, /root\.setProperty\('--chip-head', footOf\)/)
    assert.match(concierge, /root\.removeProperty\('--chip-head'\)/)
  }
  // Sideways (a short landscape screen, Concierge's short layout): no room above the thumbs, so the card stands
  // between them, left of the buttons' left edge and right of the stick's zone, above the HUD's chips at the foot.
  assert.match(card, /const SIDEWAYS = mediaStore\('\(orientation: landscape\) and \(max-height: 499px\)'\)/)
  assert.match(card, /const between = overlay && sideways && !termOpen/)
  const between = place('between')
  assert.match(between, /^left-\[calc\(env\(safe-area-inset-left,0px\)_\+_calc\(12\.5rem_\/_var\(--ui-zoom,1\)\)\)\]/, 'right of the stick and its gaps (unzoomed)')
  assert.ok(between.includes(' right-[max(calc(calc(var(--touch-left,12rem)_/_var(--ui-zoom,1))_+_0.5rem),calc(max(0.75rem,env(safe-area-inset-right))_+_7.5rem))] '), 'left of the buttons (window pixels, unzoomed) and of the minimap\'s column (7 rem under a 0.75 rem frame)')
  // Its top: the 10.5 rem line under the header, the readout and her chip; where the band from there to the HUD's chips
  // at the foot is short of 8 rem, the line steps up to her chip's foot, the chip having moved to the top row by the
  // same step (Concierge's CHIP_TOP.walk). Its foot above the HUD's chips, unless that leaves less than its padding and
  // border: then it comes down over them rather than grow up over her chip. The same foot in the height.
  const FOOT = 'max(max(0.75rem,env(safe-area-inset-bottom)),calc(calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))_+_0.5rem))'
  const VH = 'calc(100dvh_/_var(--ui-zoom,1))'
  const TOP = 'max(0.75rem,env(safe-area-inset-top))'
  // The step reads the foot latched at its highest (footPeak.ts), so captions coming and going cannot flip it.
  const PEAK_FOOT = FOOT.replace('var(--hud-foot,0px)', 'var(--hud-foot-peak,var(--hud-foot,0px))')
  const STEP = `clamp(0px,calc((8rem_-_calc(${VH}_-_${TOP}_-_10.5rem_-_${PEAK_FOOT}))_*_10000),100vh)`
  const LINE = `max(max(${TOP},calc(var(--chip-bottom,0px)_+_0.5rem)),calc(${TOP}_+_10.5rem_-_${STEP}))`
  const BOTTOM = `max(0px,min(${FOOT},calc(${VH}_-_${LINE}_-_1.875rem)))`
  assert.ok(between.includes(` bottom-[${BOTTOM}] `), 'above the HUD\'s chips, never growing up over her chip')
  assert.ok(between.endsWith(` max-h-[calc(${VH}_-_${LINE}_-_${BOTTOM})]`), 'under the header, the readout and her chip, or under her chip on the top row')
  // Sloane's side: the same step, written for an inline style, from shortTouch's own top up to the top row, only while
  // the walk's card is up on foot (at the wheel that card steps aside); it replaces --chip-top, which her other measures
  // read, and is published as --chip-bottom for the card.
  const flat = (x: string) => x.replace(/[\s_]/g, '')
  const walkTop = /\n  walk: '([^']+)',\n/.exec(concierge)?.[1] ?? ''
  const shortTop = /\[--chip-top:([^\]]+)\]/.exec(concierge)?.[1] ?? ''
  assert.ok(shortTop.length > 0 && walkTop.length > 0)
  assert.equal(flat(walkTop), flat(`max(${TOP},calc(${shortTop}_-_${STEP}))`), 'her top row and the card\'s line step on one band')
  assert.match(concierge, /const sideways = layout === 'short' && overlay && landscape\n/)
  assert.match(concierge, /const walkTop = sideways && beside && !driving \? CHIP_TOP\.walk : null\n\s+const footOf = chipTop \?\? walkTop\n/)
  assert.match(concierge, /root\.setProperty\('--chip-bottom', `calc\(\$\{footOf\} \+ \$\{Math\.round\(el\.offsetHeight\)\}px\)`\)/)
  assert.match(concierge, /: walkTop \? \(\{ '--chip-top': walkTop \} as CSSProperties\) : undefined/)
  assert.match(app, /beside=\{walking && fw\.card !== null\}/, 'her chip hears the walk\'s card is up')
  // The HUD publishes the top of its compact chips at the foot, from the screen's foot, and takes it away with them.
  assert.match(hud, /const foot = Math\.round\(window\.innerHeight - el\.getBoundingClientRect\(\)\.top\)\n\s+root\.setProperty\('--hud-foot', `\$\{foot\}px`\)/)
  assert.match(hud, /root\.removeProperty\('--hud-foot'\)/)
  // And the latch the step reads: raised with each foot published, let go only when the window changes size.
  assert.match(hud, /const next = nextFootPeak\(footPeak, footKey\(el\), foot\)\n\s+if \(next !== footPeak\) root\.setProperty\('--hud-foot-peak', `\$\{next\.peak\}px`\)/)
  assert.match(hud, /window\.addEventListener\('resize', \(\) => \{\n\s+if \(footPeak\?\.size\.split\(' '\)\[0\] === sizeOf\(\)\) return\n\s+footPeak = null\n\s+root\.removeProperty\('--hud-foot-peak'\)/)
  assert.doesNotMatch(hud.slice(hud.indexOf('return () => {', hud.indexOf('function publishFoot'))), /^\s+root\.removeProperty\('--hud-foot-peak'\)/m, 'a stack going does not let the latch go')
  assert.match(hud, /<div key=\{lifted \? 'lifted' : 'centre'\} ref=\{publishFoot\} className=\{lifted \? FOOT_LIFTED : touch && short && !driving \? FOOT_BETWEEN : FOOT_CENTRE\} data-hud="foot" data-lifted=\{lifted \|\| undefined\}>\s*\{captionStrip\}/)
  // The latch keeps the lifted stack's height apart from the centred one's: a rotation measures the old layout at the
  // new size before the switch, and that height must not hold the sideways band short.
  assert.match(hud, /function footKey\(el: HTMLElement\): string \{ return `\$\{sizeOf\(\)\}\$\{el\.hasAttribute\('data-lifted'\) \? ' lifted' : ''\}` \}/)
  assert.match(hud, /const FOOT_CENTRE = 'absolute bottom-0 left-1\/2 [^']*'/)
  // With the HUD hidden its captions stay (an access surface H does not put away), and so does the foot they publish.
  assert.equal(hud.match(/ref=\{publishFoot\}/g)?.length, 2, 'the HUD\'s stack and the hidden HUD\'s captions')
  assert.match(hud, /\{captionStrip && <div key=\{lifted \? 'lifted' : 'centre'\} ref=\{publishFoot\} className=\{lifted \? FOOT_LIFTED : '[^']*'\} data-hud="foot" data-lifted=\{lifted \|\| undefined\}>\{captionStrip\}<\/div>\}/)
  // At the wheel sideways the car's buttons fill the band: the card steps aside until the visitor is on foot.
  assert.match(app, /<FirstWalkCard\b[^>]*\bdriving=\{hud\.input\.mode === 'vehicle'\}/, 'the walk\'s card hears the wheel')
  // Meanwhile Sloane still says each line: the car ends one stage and the next stage's ask is heard at the wheel.
  // (heard, not shown: the effect's let-go above reads heard, so a line at the wheel is spoken, not dropped)
  // (nor does it read the fold: a card folded to its strip on an upright phone is heard as well)
  const saying = card.slice(card.indexOf('const said = useRef'), card.indexOf('}, [beat, heard])'))
  assert.ok(saying.length > 200, 'the effect that says each line is there')
  assert.doesNotMatch(shown(saying), /\b(?:shown|open|folded|foldable)\b/)
  assert.match(card, /\}, \[beat, heard\]\)/)
  // The touch Menu's sheet stands over the walk's card (the console stage sends the visitor to it), under the onboarding.
  const touch = read('../../04_Connect_Hardware/TouchControls.tsx')
  const sheet = Number(/<div className="ui-zoom pointer-events-none absolute inset-0 z-\[(\d+)\] select-none" style=\{ROOT_STYLE\}>\n\s+<div\n\s+aria-hidden/.exec(touch)?.[1])
  const walkZ = Number(/<div className="ui-zoom pointer-events-none absolute inset-0 z-\[(\d+)\]">/.exec(card)?.[1])
  assert.ok(sheet > walkZ && sheet < 1100, `the Menu's sheet (${sheet}) over the walk's card (${walkZ}), under the onboarding (1100)`)
})

test('on a phone held upright the card folds to a strip under the HUD\'s header and opens from it; a fold is not a close', () => {
  const app = read('../../App.tsx')
  const hud = read('../Hud.tsx')
  const concierge = read('../Concierge.tsx')
  const touch = read('../../04_Connect_Hardware/TouchControls.tsx')
  const card = read('./FirstWalk.tsx')
  // The HUD keeps a slot for the strip in its compact column, under the header, and says when it is there.
  assert.match(read('../walkSlot.ts'), /export const WALK_SLOT = Object\.freeze\(\{/)
  assert.match(hud, /import \{ holdWalkSlot \} from '\.\/walkSlot\.ts'/)
  assert.match(hud, /\{lifted && <div ref=\{holdWalkSlot\} className="max-w-full empty:hidden" data-hud="walk-slot" \/>\}/, 'only on a phone held upright with the touch controls: a tablet keeps the whole card')
  assert.match(hud, /const lifted = touch && narrow && !short\n/)
  assert.match(card, /const slot = useSyncExternalStore\(WALK_SLOT\.subscribe, WALK_SLOT\.get, WALK_SLOT\.server\)/)
  // It folds only there: the touch controls on screen, upright, the console shut, the HUD up to hold the strip.
  assert.match(card, /const foldable = overlay && !sideways && !termOpen && slot !== null\n/)
  assert.match(card, /const open = !\(foldable && folded\)\n/)
  // The strip is the way back, so it is drawn whenever the card may be folded (also while Sloane's open card has the
  // walk's step aside), and the component returns it when the card itself is not drawn.
  assert.match(card, /const strip = visible && foldable && slot !== null && createPortal\(\n\s+<>\n\s+<button\n/)
  // Beside the strip, a live region tells each new line, folded or open (the open card's line is then not one too),
  // and an unread line is in the strip's name; a fold that takes the focused card away gives the focus to the strip.
  assert.match(card, /<span className="sr-only" role="status" aria-live="polite" data-walk-told>\{CONCIERGE_NAME\}: \{line\}<\/span>/)
  assert.match(card, /aria-live=\{foldable \? undefined : 'polite'\} data-walk-line>/)
  assert.match(card, /\$\{unread \? ` A new line from \$\{CONCIERGE_NAME\}\.` : ''\}/)
  assert.match(card, /if \(!document\.activeElement \|\| document\.activeElement === document\.body\) stripRef\.current\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(card, /if \(!shown \|\| !open\) return strip \|\| null\n/)
  assert.match(card, /<>\n\s+\{strip\}\n/)
  assert.match(card, /data-walk-strip=\{card\.stage\}/)
  assert.match(card, /aria-expanded=\{open && shown\}/)
  assert.match(card, /onClick=\{\(\) => \{ setFolded\(open && shown\); setUnread\(false\) \}\}/, 'a tap opens it or folds it')
  // A new line opens the card again; at the wheel it is heard and the strip marks it unread instead. Getting into a
  // car folds it. The fold is kept nowhere: a reload opens the card.
  assert.match(card, /if \(beat && beat\.id !== seenBeat\) \{ setSeenBeat\(beat\.id\); setFolded\(driving\); setUnread\(driving\) \}\n/)
  assert.match(card, /if \(driving !== seenDriving\) \{ setSeenDriving\(driving\); if \(driving\) setFolded\(true\) \}\n/)
  assert.doesNotMatch(card, /localStorage|sessionStorage|firstWalkStore/, 'the card keeps nothing')
  // Under way it folds by itself: a touch outside it and its strip, or a few metres covered (a paired pad sends no touch).
  assert.match(card, /const folding = foldable && shown && open\n/)
  assert.match(card, /window\.addEventListener\('pointerdown', down, true\)/)
  assert.match(card, /if \(at && \(cardRef\.current\?\.contains\(at\) \|\| stripRef\.current\?\.contains\(at\)\)\) return\n\s+setFolded\(true\)/)
  assert.match(card, /else if \(travelled - travelFrom\.current >= FOLD_METRES\) setFolded\(true\)/)
  assert.match(app, /<FirstWalkCard\b[^>]*\btravelled=\{hud\.experience\.distanceWalked \+ hud\.experience\.distanceDriven\}/)
  // Open it is short: Sloane's line cut to the lines its band has room for (walkFold.ts, measured from the card as
  // laid out), the stage's button under it, and More opens the rest.
  assert.match(card, /const brief = foldable && !more\n/)
  assert.match(card, /const next = fitLines\(px\(box\.maxHeight\), all - text\.offsetHeight, px\(getComputedStyle\(text\)\.lineHeight\), text\.scrollHeight\)/)
  assert.match(card, /style=\{brief \? \{ WebkitLineClamp: fit\.lines \} : undefined\}/)
  assert.match(card, /edges\?\.observe\(document\.documentElement, \{ attributes: true, attributeFilter: \['style'\] \}\)/, 'measured again when the touch layer or Sloane publish a new edge')
  // The short card that fits takes touches on its buttons only: a finger on its words reaches the look area or the
  // stick (and folds the card).
  assert.match(card, /const through = brief && fit\.whole && fit\.below\n/, 'and only under her chip: above it a touch would reach the HUD\'s strip or the microphone\'s badge')
  assert.match(card, /const below = !pill \|\| el\.getBoundingClientRect\(\)\.top >= pill\.getBoundingClientRect\(\)\.bottom - 1\n/)
  assert.match(card, /\$\{through \? 'pointer-events-none' : 'pointer-events-auto'\}/)
  assert.match(card, /<div className="flex shrink-0 flex-wrap items-center gap-2 \[&>button\]:pointer-events-auto">/)
  assert.match(card, /\{foldable && <button type="button" onClick=\{\(\) => setMore\(\(m\) => !m\)\} aria-expanded=\{more\} className="noir-button" data-walk-more>\{more \? 'Less' : 'More'\}<\/button>\}/)
  // A fold is not a close: nothing in the card ends the walk or reports to it but the stage's own button (the hook's
  // props), and the strip stays on screen with the stage's number and title.
  const calls = [...shown(card).matchAll(/\bon[A-Z]\w*\(/g)].map((m) => m[0])
  assert.deepEqual([...new Set(calls)].sort(), ['onOutside(', 'onShow('].sort())
  assert.match(card, /\{card\.index\} of \{card\.count\}<\/span>\n\s+<span className="min-w-0 truncate font-semibold text-noir-titanium-100">\{card\.title\}<\/span>/)
  // The HUD's layer stands over the touch layer and under Sloane's, so the strip (and the HUD's other few buttons)
  // take their taps on a phone, where the look area covers half the screen.
  const hudZ = Number(/<div className="ui-zoom pointer-events-none absolute inset-0 z-(\d+) font-sans /.exec(hud)?.[1])
  const touchZ = Number(/<div ref=\{layer\} className="pointer-events-none absolute inset-0 z-(\d+) select-none"/.exec(touch)?.[1])
  const sloaneZ = [...concierge.matchAll(/<div className="ui-zoom pointer-events-none absolute inset-0 z-(\d+) font-sans /g)].map((m) => Number(m[1]))
  assert.ok(touchZ > 0 && hudZ > touchZ, `the HUD (${hudZ}) over the touch layer (${touchZ})`)
  assert.ok(sloaneZ.length > 0 && sloaneZ.every((z) => z > hudZ), 'and under Sloane')
})

test('the exam reaches the walk\'s program and the bridge\'s type, and nothing else: no gate, no engine, no realm, no write', () => {
  const src = read('exam.ts')
  const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1])
  assert.deepEqual(imports, ['../../09_Cognition/firstWalk.ts', '../terminal/bridge.ts'])
  assert.match(src, /import type \{ ExamBridge \} from '\.\.\/terminal\/bridge\.ts'/, 'the bridge is a type only')
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  assert.doesNotMatch(code, /\bengine\b|simControls|localStorage|fetch\(|\.write\b|write:/i)
  // The console's `tutorial program` without an exam prints the walk's own program (commands.ts keeps a copy; this pins them equal).
  const commands = read('../terminal/commands.ts')
  const copy = commands.match(/const EXAM_PROGRAM: readonly string\[\] = Object\.freeze\((\[[^\]]*\])\)/)
  assert.ok(copy, 'commands.ts keeps the program for the shell without an exam')
  assert.deepEqual([...copy![1]!.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((m) => m[1]), [...PROGRAM])
})

test('the console reports every line run, types or runs a line, and prints the walk\'s banner; the Concierge reports a goal sent; the engine shows its rooms and holds the marker', () => {
  const term = read('../terminal/Terminal.tsx')
  assert.match(term, /onLine\?\(line: string\): void/)
  assert.match(term, /type\(text: string\): void/)
  assert.match(term, /run\(line\?: string\): void/)
  assert.match(term, /print\(lines: readonly string\[\]\): void/)
  assert.match(term, /print\(lines\) \{\s*append\(lines\.map\(\(text\): Line => \(\{ kind: 'sys', text \}\)\)\)\s*\}/, 'printed as the console\'s own rows, nothing run')
  assert.match(term, /if \(line\) onLineRef\.current\?\.\(line\)/)
  assert.match(term, /submitRef\.current\(line \?\? inputRef\.current\?\.value \?\? ''\)/)
  const concierge = read('../Concierge.tsx')
  assert.match(concierge, /onGoalSent\?\(text: string\): void/)
  assert.match(concierge, /onGoalSent\?\.\(goalText\)/)
  const engine = read('../engine.ts')
  assert.match(engine, /workplaces\(\): readonly Workplace\[\] \{\s*return this\.rooms\s*\}/)
  // The marker: kept only when every number is finite, its label cut short, and on the snapshot only while there is one.
  assert.match(engine, /setBeacon\(b: \{ x: number; z: number; label: string \} \| null\): void \{/)
  assert.match(engine, /\.\.\.\(beacon && \{ beacon \}\)/)
  const hud = read('../Hud.tsx')
  assert.match(hud, /data-hint="beacon"/)
})

test('the card has no close, no skip and no key that puts it away; every stage has its button, a lent hand and the first card the machine; it never calls the walk a lesson', () => {
  const src = read('./FirstWalk.tsx')
  assert.doesNotMatch(src, /onClose|onSkip|Escape|data-walk-close|data-walk-skip/, 'no way out but the console')
  assert.doesNotMatch(src, /<button[^>]*>\s*(?:Close|Skip|Dismiss|Later|Not now)\b/i)
  assert.match(src, /data-walk-show/)
  assert.match(src, /data-walk-why/)
  assert.doesNotMatch(src, /data-walk-run|data-walk-line-button|onType|onRun/, 'no program on the card any more')
  assert.match(src, /data-walk=\{card\.stage\}/)
  assert.match(src, /aria-live="polite"/)
  // The lent hand: the stage's button lit, the strip's dot awake, the keys for the stage and a line offering to do it.
  assert.match(src, /data-walk-show data-walk-assist=\{assisting \|\| undefined\}/)
  assert.match(src, /data-walk-hand/)
  assert.match(src, /assistLine\(card\.stage, \{ family: familyOf\(family\) \}\)/)
  // The first card reads the machine (device, picture, Sloane), never on a short folded card. Sloane's row reads the brain
  // readout where it is drawn (a change there renders that row alone), from memory: nothing on the card probes, asks or
  // downloads.
  assert.match(src, /data-walk-machine/)
  assert.match(src, /import \{ readBrain, subscribeBrain \} from '\.\.\/\.\.\/09_Cognition\/brainReadout\.ts'/)
  assert.match(src, /const brain = useSyncExternalStore\(subscribeBrain, readBrain, readBrain\)\s+const row = sloaneOf\(brain\)/)
  assert.match(src, /data-walk-brain=\{brain\.brain \?\? 'unknown'\} data-walk-where=\{row\.detail\}/)
  // The line once to a screen reader: the shown words and their title hidden from it, the words and the line said once.
  assert.match(src, /<span aria-hidden="true" title=\{row\.detail\}>\{row\.text\}<\/span>\s+<span className="sr-only">\{row\.text\}: \{row\.detail\}<\/span>/)
  assert.match(src, /<SloaneBrainRow \/>/)
  assert.doesNotMatch(src, /installed\(|\.answer\(|\.load\(|job\.start|bindBrain|lookState|\.models\(/, 'the card reads the readout and nothing else of the mind')
  const text = shown(src)
  assert.doesNotMatch(text, /[Tt]utorial|lesson/, 'Sloane calls it a walk')
  assert.match(text, /No skip: the city opens the moment you reach the console, on the last card\./)
})
