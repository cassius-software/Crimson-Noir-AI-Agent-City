// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence that the first walk is wired through the page: the hook's small
 * readers (the glyph family to the device's words, a bearing, the nearest workplace), the hook reading the engine
 * for nothing but its rooms and its car count, App switching the walk on from the URL and the pass record, feeding
 * it the Concierge's goal, the console's lines and opening, the HUD's microphone and captions, holding the quiet
 * watch until it is passed, and the card having no close, no skip and no key that puts it away while every stage
 * has its accessible button. Source-level, as the other wiring tests are: the components need a browser to render.
 * What breaks if it is removed? A prop or a report could be dropped and a stage would never finish, or a close could
 * be added and the walk would be a card like any other.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PROGRAM } from '../../09_Cognition/firstWalk.ts'
import { TICK_MS, bearingOf, nearestPlace, wordsOf } from './useFirstWalk.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const shown = (src: string) => src.replace(/^import .*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')

test('the hook\'s readers: the device\'s words from the glyphs, a bearing, the nearest workplace', () => {
  assert.deepEqual(wordsOf('keyboard'), { move: 'W A S D', look: 'Mouse', interact: 'E', console: '~' })
  assert.deepEqual(wordsOf('touch'), { move: 'Stick', look: 'Drag', interact: 'Enter car', console: 'Menu' })
  assert.deepEqual(wordsOf('abxy'), { move: 'L', look: 'R', interact: 'A', console: '~' })
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

test('the hook listens and never writes: readings from the snapshot, the engine asked only for its rooms, its car count and whether it has shops, the pass kept once', () => {
  const src = read('./useFirstWalk.ts')
  assert.match(src, /engine\.workplaces\(\)/)
  assert.match(src, /engine\.simControls\(\)\.vehicles\.count\(\) > 0/)
  assert.match(src, /stores: engine\.shops\.length > 0/, 'the look stage names the shops only on a map that has them')
  assert.doesNotMatch(src, /engine\.shops(?!\.length > 0)/, 'and of the shops, only whether there are any')
  assert.doesNotMatch(src, /engine\.(?!workplaces\b|simControls\b)[a-zA-Z]+\(/, 'nothing else of the engine is called')
  assert.doesNotMatch(src, /simControls\(\)\.(?!vehicles\.count\(\))/, 'and of the controls, only the car count')
  assert.match(src, /insideRoom\(r, x, z\)/)
  assert.match(src, /hud\.customer\.viewYaw/)
  assert.match(src, /hud\.input\.mode === 'vehicle'/)
  assert.match(src, /consoleOpen: termOpen/)
  assert.match(src, /if \(w\.passed && !kept\.current\) \{\s*kept\.current = true\s*saveFirstWalkPassed\(/)
  assert.match(src, /mustKeep\(s, b\.keep\)/, 'a rewording that drops the key or command is not shown')
  assert.match(src, /if \(lawLine\(text\)\) note\('law'\)/)
})

test('App: the walk is switched on from the URL and the pass record, fed the Concierge\'s goal, the console\'s lines and opening, the HUD\'s microphone and captions, the wardrobe or a shop\'s card put away; the quiet watch waits for it', () => {
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
  assert.match(src, /<FirstWalkCard\s+visible=\{veilDone && !lookOpen && storeOpen === null && locked === null\}/, 'the walk\'s card steps aside for the wardrobe and a shop\'s card')
  assert.match(src, /onShow=\{showWalk\}/)
  assert.match(src, /walk: \(\) => walkRef\.current\.stage/, 'the smoke reads the stage')
  // The accessible path goes through the same controls the operator tier has, and the console's handle.
  assert.match(src, /case 'move': \{\s*e\.input\.yaw \+= 0\.7/)
  assert.match(src, /case 'style': openLook\(\); return/, 'the look stage\'s button opens the wardrobe card the chip opens')
  assert.match(src, /case 'ring0': termRef\.current\?\.run\('laws'\)/)
  assert.match(src, /case 'exam': termRef\.current\?\.type\(`noir \$\{PROGRAM\[0\]\}`\)/)
  // The exam behind the exit program: composed in the console bridge over the host's vouch for the air gap, the
  // kernel-panic state, the bridge's laws, the recruiter's own lane and the walk; the nonce drawn once per page load.
  assert.match(src, /exam: createExam\(\{/)
  assert.match(src, /contained: \(\) => airgapInstalled\(globalThis\)/)
  assert.match(src, /standing: \(\) => lockedRef\.current === null/)
  assert.match(src, /laws: \(\) => engineBridge\.laws\(\)/)
  assert.match(src, /checks: \(\) => GATE_CHECK_NAMES/, 'the gate\'s check names come through the operator tier, one of the gate\'s three keepers')
  assert.match(src, /ask: \(skill\) => r\.tryAsk\(skill\)/)
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
  for (const name of ['touch', 'compact']) {
    assert.match(place(name), /max-h-\[[^\]]*max\(calc\(max\(0\.75rem,env\(safe-area-inset-top\)\)_\+_8\.75rem\),calc\(var\(--chip-bottom,0px\)_\+_0\.5rem\)\)/, `${name} keeps under the minimap row and her chip`)
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
  const STEP = `clamp(0px,calc((8rem_-_calc(${VH}_-_${TOP}_-_10.5rem_-_${FOOT}))_*_10000),100vh)`
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
  assert.match(hud, /root\.setProperty\('--hud-foot', `\$\{Math\.round\(window\.innerHeight - el\.getBoundingClientRect\(\)\.top\)\}px`\)/)
  assert.match(hud, /root\.removeProperty\('--hud-foot'\)/)
  assert.match(hud, /<div ref=\{publishFoot\} className="absolute bottom-0 left-1\/2 [^"]*" data-hud="foot">\s*\{captionStrip\}/)
  // With the HUD hidden its captions stay (an access surface H does not put away), and so does the foot they publish.
  assert.equal(hud.match(/ref=\{publishFoot\}/g)?.length, 2, 'the HUD\'s stack and the hidden HUD\'s captions')
  assert.match(hud, /\{captionStrip && <div ref=\{publishFoot\} className="[^"]*" data-hud="foot">\{captionStrip\}<\/div>\}/)
  // At the wheel sideways the car's buttons fill the band: the card steps aside until the visitor is on foot.
  assert.match(app, /<FirstWalkCard\b[^>]*\bdriving=\{hud\.input\.mode === 'vehicle'\}/, 'the walk\'s card hears the wheel')
  // Meanwhile Sloane still says each line: the car ends one stage and the next stage's ask is heard at the wheel.
  assert.match(card, /if \(!beat \|\| beat\.id === said\.current \|\| !heard\) return/)
  assert.match(card, /\}, \[beat, heard\]\)/)
  // The touch Menu's sheet stands over the walk's card (the Ring-0 stage sends the visitor to it), under the onboarding.
  const touch = read('../../04_Connect_Hardware/TouchControls.tsx')
  const sheet = Number(/<div className="ui-zoom pointer-events-none absolute inset-0 z-\[(\d+)\] select-none" style=\{ROOT_STYLE\}>\n\s+<div\n\s+aria-hidden/.exec(touch)?.[1])
  const walkZ = Number(/<div className="ui-zoom pointer-events-none absolute inset-0 z-\[(\d+)\]">/.exec(card)?.[1])
  assert.ok(sheet > walkZ && sheet < 1100, `the Menu's sheet (${sheet}) over the walk's card (${walkZ}), under the onboarding (1100)`)
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

test('the console reports every line run and types or runs a line for the card; the Concierge reports a goal sent; the engine shows its rooms', () => {
  const term = read('../terminal/Terminal.tsx')
  assert.match(term, /onLine\?\(line: string\): void/)
  assert.match(term, /type\(text: string\): void/)
  assert.match(term, /run\(line\?: string\): void/)
  assert.match(term, /if \(line\) onLineRef\.current\?\.\(line\)/)
  assert.match(term, /submitRef\.current\(line \?\? inputRef\.current\?\.value \?\? ''\)/)
  const concierge = read('../Concierge.tsx')
  assert.match(concierge, /onGoalSent\?\(text: string\): void/)
  assert.match(concierge, /onGoalSent\?\.\(goalText\)/)
  const engine = read('../engine.ts')
  assert.match(engine, /workplaces\(\): readonly Workplace\[\] \{\s*return this\.rooms\s*\}/)
})

test('the card has no close, no skip and no key that puts it away; every stage has its button, the last its program lines and Run; it never calls the walk a lesson', () => {
  const src = read('./FirstWalk.tsx')
  assert.doesNotMatch(src, /onClose|onSkip|Escape|data-walk-close|data-walk-skip/, 'no way out but the program')
  assert.doesNotMatch(src, /<button[^>]*>\s*(?:Close|Skip|Dismiss|Later|Not now)\b/i)
  assert.match(src, /data-walk-show/)
  assert.match(src, /data-walk-why/)
  assert.match(src, /data-walk-run/)
  assert.match(src, /data-walk-line-button=\{i \+ 1\}/)
  assert.match(src, /onType\(`noir \$\{l\}`\)/)
  assert.match(src, /data-walk=\{card\.stage\}/)
  assert.match(src, /aria-live="polite"/)
  const text = shown(src)
  assert.doesNotMatch(text, /[Tt]utorial|lesson/, 'Sloane calls it a walk')
  assert.match(text, /No skip: the city opens when the program on the last card has run\./)
})
