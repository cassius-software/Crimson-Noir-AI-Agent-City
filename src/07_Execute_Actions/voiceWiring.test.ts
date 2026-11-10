// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the microphone's wiring through the page, which no Node test can run (App.tsx,
 * Hud.tsx, TouchControls.tsx and Concierge.tsx are React over a browser): the one line that decides whether a first
 * visit opens the microphone at boot and that it ships false; that the page opens the device only on a kept switch,
 * on a press, on the console's word or beside the recogniser; that V and the right stick's click (not M, which is
 * rain mode, nor L3, the run latch) reach the engine as one action the host's switch takes; that the HUD's pill is a
 * real button with the device's state in its name, shown while the device is open even with the HUD hidden; that
 * Sloane's voice is told to the detector and cut by a barge-in; that the recogniser's words reach Sloane; and that the
 * device is released when the city goes away or halts.
 * What breaks if it is removed? A hot microphone at boot, or a device open with nothing on the HUD saying so, with
 * every unit test green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const APP = read('../App.tsx')
const HUD = read('./Hud.tsx')
const CONCIERGE = read('./Concierge.tsx')
const ENGINE = read('./engine.ts')
const INPUT = read('../04_Connect_Hardware/input.ts')
const PAD = read('../04_Connect_Hardware/gamepad.ts')
const TOUCH = read('../04_Connect_Hardware/TouchControls.tsx')
const MIC = read('../04_Connect_Hardware/microphone.ts')
const COMMANDS = read('./terminal/commands.ts')

test('the microphone opens at boot: one line, true; the page opens the device only at boot (the kept switch, else the line), on a press, the console or beside the recogniser', () => {
  assert.match(MIC, /^export const MIC_OPEN_BY_DEFAULT = true$/m, 'the one line (the owner\'s word, 2026-11-07)')
  assert.match(MIC, /return s\.kept \? s\.on : byDefault/, 'a kept choice (a mute too) wins over the line')
  assert.equal(MIC.match(/MIC_OPEN_BY_DEFAULT/g)?.length, 5, 'declared, read by opensAtBoot twice and the console line, named in the doc comment; set nowhere else')
  assert.match(APP, /if \(mic\.opensAtBoot\(\)\) void mic\.listen\(\)/, 'the boot asks the kept switch (else the one line) first')
  const opens = APP.match(/mic\.listen\(\)/g) ?? []
  assert.equal(opens.length, 3, 'the boot, the recogniser already listening, and the console: nowhere else')
  assert.match(APP, /detail\.state === 'listening' && !mic\.open && mic\.phase !== 'opening'\) void mic\.listen\(\)/, 'the recogniser open (recruit listen) opens the pill\'s microphone too')
  assert.match(APP, /on: \(on: boolean\) => \(on \? mic\.listen\(\)/, 'the console\'s mic on')
  assert.match(APP, /const onMic = useCallback\(\(\) => \{ void mic\.toggle\(\) \}, \[mic\]\)/, 'the one switch the pill, the keys and the Menu share')
  assert.doesNotMatch(APP, /navigator\.mediaDevices|getUserMedia/, 'App never opens a device itself')
})

test('V and the right stick\'s click are the mute (M is rain mode, L3 the run latch); the engine hands the press to the host', () => {
  assert.match(INPUT, /^\s+KeyV: 'mute',$/m)
  assert.match(INPUT, /^\s+KeyM: 'matrix',$/m, 'M stays rain mode')
  assert.match(INPUT, /if \(edges & PAD_EDGE\.mute\) this\.queued\.add\('mute'\)/)
  assert.match(PAD, /mute: 32 \} as const/)
  assert.match(PAD, /if \(rising & \(1 << PAD\.r3\)\) edges \|= PAD_EDGE\.mute/)
  assert.match(PAD, /if \(rising & \(\(1 << PAD\.l3\) \| PADDLE_LEFT\)\) l3 = true/, 'L3 stays the run latch')
  assert.match(ENGINE, /^\s+onMute: \(\(\) => void\) \| null = null$/m)
  // Taken before a home's doorstep card drains the poll's other presses: a privacy switch nothing holds back.
  assert.match(ENGINE, /input\.poll\(dt\)\n(?:\s*\/\/[^\n]*\n)*\s*const mute = input\.take\('mute'\)\n(?:\s*\/\/[^\n]*\n)*\s*if \(this\.homeCard !== null \|\| this\.drainNext\) \{ input\.drain\(\); this\.drainNext = false \}/)
  assert.match(ENGINE, /if \(mute\) this\.onMute\?\.\(\)/)
  assert.doesNotMatch(ENGINE, /from '\.\.\/04_Connect_Hardware\/microphone\.ts'|new Microphone\(/, 'the engine never holds the microphone')
  assert.match(APP, /e\.onMute = onMic/)
  assert.match(TOUCH, /\{ label: 'Microphone', on: host\.mic === true, run: \(\) => input\.press\('mute'\) \}/, 'the touch Menu\'s item is the same press')
  assert.match(APP, /mic: hud\.supplier\.voice \? micIsOpen\(hud\.supplier\.voice\.phase\) : false,/)
})

test('the HUD\'s pill: a button named by the device\'s state, fed every snapshot, shown while the device is open even with the HUD hidden', () => {
  assert.match(APP, /s\.supplier\.voice = \{ phase: mic\.phase, detail: mic\.state\.detail, speaking: speaker\.speaking, path: mic\.path, words: recruiter !== null && recruiter\.mic\.state === 'listening' \}\n(?:\s*\/\/[^\n]*\n)*\s*if \(crew\) \{ s\.supplier\.lanes = crew\.lines\(\); s\.supplier\.team = crew\.line\(\) \}\n\s+if \(recruiter\) s\.supplier\.recruiting = hudLine\(/, 'written before the recruiter\'s line, every HUD interval')
  assert.match(APP, /<Hud s=\{hud\}[^\n]* mic=\{mic\} onMic=\{onMic\}[^\n]*\/>/)
  assert.match(HUD, /const micNeeded = voice \? micOpen \|\| voice\.phase === 'opening' \|\| voice\.phase === 'blocked' \|\| voice\.phase === 'error' \|\| voice\.phase === 'unavailable' : false/)
  assert.match(HUD, /const micShown = voice && \(micOpen \|\| \(visible && \(!compact \|\| micNeeded\)\)\)\n\s+const micPill = micShown && <MicPill voice=\{voice\} mic=\{mic\} onMic=\{onMic\}/, 'always while open; at rest on a desktop; on a phone only opening, open or failed (the Menu is the switch there)')
  // On a phone the pill is a badge on the minimap's corner: with the microphone open from the start it is up all the
  // time, and as a row of the panels' column it pushed them into Sloane's chip at the wheel on a 320 x 568 phone.
  assert.match(HUD, /const micBadge = micShown && visible && compact && <MicBadge voice=\{voice\} onMic=\{onMic\} panel=\{panel\} \/>/)
  const compactFrame = HUD.slice(HUD.indexOf('{visible && compact && ('), HUD.indexOf('{visible && pingChip}'))
  assert.ok(compactFrame.length > 0 && !compactFrame.includes('{micPill}'), 'no pill row in the phone\'s panels')
  assert.match(compactFrame, /data-hud="minimap">[^]*?<div className="relative">\n\s+<Minimap [^\n]*\/>\n\s+\{micBadge && <div className="absolute bottom-0 left-0">\{micBadge\}<\/div>\}\n\s+<\/div>/, 'inside the minimap\'s box, so it moves nothing')
  assert.match(HUD, /function MicBadge[^]*?className=\{`pointer-events-auto relative flex h-7 w-7 [^`]*focus-visible:outline-2[^`]*\$\{panel\}`\}\n\s+data-hint="voice"/, '28 px, the pill\'s focus ring and hint')
  assert.match(HUD, /\{failed && <path d="M2\.5 2\.5l11 11" \/>\}/, 'struck through when the device could not open')
  assert.match(HUD, /\{!visible && \(recChip \|\| micPill \|\| rc\?\.listening \|\| captionStrip\) && \(/, 'the hidden HUD still frames an open microphone')
  assert.match(HUD, /<button\n\s+type="button"\n\s+onClick=\{onMic\}\n\s+aria-label=\{pillLabel\(voice\.phase, voice\.speaking, failed \? voice\.detail : ''\)\}\n\s+aria-pressed=\{open\}/)
  assert.match(HUD, /className=\{`pointer-events-auto flex [^`]*focus-visible:outline-2[^`]*\$\{panel\}`\}/, 'the one HUD element that takes the pointer, with a visible focus ring')
  assert.match(HUD, /<span className="sr-only" role="status" aria-live="polite" data-mic-told>\{voice \? micTold\(voice\.phase\) : ''\}<\/span>/, 'a screen reader hears the state change')
  const root = HUD.indexOf('className="ui-zoom pointer-events-none absolute inset-0'), told = HUD.indexOf('data-mic-told'), frame = HUD.indexOf('{visible && !compact && (')
  assert.ok(root < told && told < frame, 'in the HUD\'s root, mounted whatever the layout, so a mute pressed on a phone or with the HUD hidden is heard')
  assert.match(HUD, /phaseWord\(phase === 'speech' \? 'listening' : phase\)/, 'but not every onset of speech')
  assert.match(HUD, /requestAnimationFrame\(draw\)/, 'the meter runs at frame rate, outside React')
})

test('Sloane and the microphone: her voice is told to the detector, a barge-in cuts her line, the recogniser\'s words reach her; the device is released with the city', () => {
  assert.match(APP, /const untell = speaker\.onSpeaking\(\(on\) => mic\.setSpeaking\(on\)\)\n\s+const unline = speaker\.onLine\(\(\) => mic\.newLine\(\)\)\n\s+const barge = \(\) => speaker\.stop\(\)\n\s+mic\.addEventListener\('barge', barge\)/, 'a line that cuts the one still playing is learned afresh (no edge of speaking there)')
  assert.match(APP, /untell\(\)\n\s+unline\(\)\n\s+mic\.setSpeaking\(false\)/)
  assert.match(APP, /if \(!heardNow\(speaker\.speaking, performance\.now\(\), quietAt\)\) return\n\s+if \(parseRequest\(t\) === null\) setHeard\(\{ id: \+\+heardId, text: t \}\)/, 'nothing while Sloane speaks or just after (her own line back through the speakers); a recruitment request is the recruiter\'s; the rest is Sloane\'s')
  assert.match(APP, /const unquiet = speaker\.onSpeaking\(\(on\) => \{ if \(!on && !mic\.speech\) quietAt = performance\.now\(\) \}\)/, 'a line cut by a barge-in leaves no quiet tail: the words after it are the visitor\'s')
  assert.match(APP, /r\.removeEventListener\('heard', onHeard\)\n\s+unquiet\(\)/, 'and let go with the city')
  assert.match(APP, /heard=\{heard\}/)
  assert.match(CONCIERGE, /heard\?: \{ id: number; text: string \} \| null/)
  assert.match(CONCIERGE, /const said = heardGoal\(text, open\)/, 'heard.ts decides what of it is a goal')
  assert.match(APP, /if \(!open && mic\.phase !== 'opening'\) \{ micWasOpen = false; if \(live\) r\.stop\(\); return \}/, 'the recogniser stops whenever the microphone settles closed, not only on an open-to-closed edge (a mute while it was opening)')
  assert.match(APP, /if \(open && !live && words\(\)\) void r\.listen\(\)/, 'and starts with it where the browser has one')
  assert.equal(APP.match(/mic\.close\(\)/g)?.length, 3, 'the city going away, a halt, and the shell unmounting')
  assert.match(APP, /unlisten\?\.\(\)\n\s+tasks\.dispose\(\)\n\s+r\.dispose\(\)\n\s+mic\.close\(\)\n\s+setLocked\(reason\)/, 'a halt releases the device')
  assert.match(APP, /useEffect\(\(\) => \(\) => \{ mic\.close\(\) \}, \[mic\]\)/, 'the shell unmounting closes it (not dispose: a development double mount reuses the same microphone)')
  assert.doesNotMatch(APP, /mic\.dispose\(\)/)
  assert.match(APP, /const wake = \(\) => mic\.resume\(\)/, 'a gesture wakes a context opened at boot')
  assert.match(COMMANDS, /\{ name: 'mic', usage: 'mic \[on\|off\]'/)
})
