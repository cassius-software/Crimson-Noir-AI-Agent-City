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
const MENU_ITEMS = read('../04_Connect_Hardware/menuItems.ts')
const MIC = read('../04_Connect_Hardware/microphone.ts')
const COMMANDS = read('./terminal/commands.ts')

test('the microphone opens at boot: one line, true; the page opens the device only at boot (the kept switch, else the line), on a press, the console or beside the recogniser', () => {
  assert.match(MIC, /^export const MIC_OPEN_BY_DEFAULT = true$/m, 'the one line (the owner\'s word, 2026-11-07)')
  assert.match(MIC, /return s\.kept \? s\.on : byDefault/, 'a kept choice (a mute too) wins over the line')
  assert.equal(MIC.match(/MIC_OPEN_BY_DEFAULT/g)?.length, 5, 'declared, read by opensAtBoot twice and the console line, named in the doc comment; set nowhere else')
  assert.match(APP, /if \(mic\.opensAtBoot\(\)\) \{ unasked = true; void mic\.listen\(\) \}/, 'the boot asks the kept switch (else the one line) first, and its open is not the visitor\'s ask')
  const opens = APP.match(/mic\.listen\(\)/g) ?? []
  assert.equal(opens.length, 3, 'the boot, the recogniser already listening, and the console: nowhere else')
  assert.match(APP, /detail\.state === 'listening' && !mic\.open && mic\.phase !== 'opening'\) void mic\.listen\(\)/, 'the recogniser open (recruit listen) opens the pill\'s microphone too')
  assert.match(APP, /on: \(on: boolean\) => \{\n\s+if \(!on\) \{ mic\.mute\(\); return 'muted: the device is released' \}\n\s+unasked = false\n\s+return mic\.listen\(\)\.then\(\(st\) => \{ if \(micIsOpen\(st\.phase\)\) void speech\.start\(true\);/, 'the console\'s mic on (the visitor\'s own ask also asks again for the speech pack, once the microphone is open)')
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
  assert.match(MENU_ITEMS, /\{ label: 'Microphone', on: host\.mic === true, run: \(\) => input\.press\('mute'\) \}/, 'the touch Menu\'s item is the same press')
  assert.match(APP, /mic: hud\.supplier\.voice \? micIsOpen\(hud\.supplier\.voice\.phase\) : false,/)
})

test('the HUD\'s pill: a button named by the device\'s state, fed every snapshot, shown while the device is open even with the HUD hidden', () => {
  assert.match(APP, /s\.supplier\.voice = \{ phase: mic\.phase, detail: mic\.silent \? mic\.silentDetail : mic\.hushed \? HUSHED_DETAIL : mic\.state\.detail, speaking: speaker\.speaking, path: mic\.path, words: \(recruiter !== null && recruiter\.mic\.state === 'listening'\) \|\| \(mic\.hearing && PAGE_SPEECH\(\)\.ready\), silent: mic\.silent, hushed: mic\.hushed, note: speechNote\(PAGE_SPEECH\(\)\.state\), speech: PAGE_SPEECH\(\)\.word\(\), said: performance\.now\(\) - said\.at < SAID_MS \? said\.text : '', heard: said\.n, heardText: said\.text \}\n(?:\s*\/\/[^\n]*\n)*\s*if \(crew\) \{ s\.supplier\.lanes = crew\.lines\(\); s\.supplier\.team = crew\.line\(\) \}\n\s+if \(recruiter\) s\.supplier\.recruiting = hudLine\(/, 'written before the recruiter\'s line, every HUD interval')
  assert.match(APP, /<Hud s=\{hud\}[^\n]* mic=\{mic\} onMic=\{onMic\}[^\n]*\/>/)
  assert.match(HUD, /const micNeeded = voice \? micOpen \|\| voice\.phase === 'opening' \|\| voice\.phase === 'blocked' \|\| voice\.phase === 'error' \|\| voice\.phase === 'unavailable' : false/)
  assert.match(HUD, /const micShown = voice && \(micOpen \|\| \(visible && \(!compact \|\| micNeeded\)\)\)\n\s+const micPill = micShown && <MicPill voice=\{voice\} mic=\{mic\} onMic=\{onMic\}/, 'always while open; at rest on a desktop; on a phone only opening, open or failed (the Menu is the switch there)')
  // On a phone the pill is a badge on the minimap's corner: with the microphone open from the start it is up all the
  // time, and as a row of the panels' column it pushed them into Sloane's chip at the wheel on a 320 x 568 phone.
  assert.match(HUD, /const micBadge = micShown && visible && compact && <MicBadge voice=\{voice\} onMic=\{onMic\} panel=\{panel\} \/>/)
  const compactFrame = HUD.slice(HUD.indexOf('{visible && compact && ('), HUD.indexOf('{visible && pingChip}'))
  assert.ok(compactFrame.length > 0 && !compactFrame.includes('{micPill}'), 'no pill row in the phone\'s panels')
  assert.match(compactFrame, /data-hud="minimap">[^]*?<div className="relative">\n\s+<Minimap [^\n]*\/>\n\s+\{micBadge && <div className="absolute bottom-0 left-0">\{micBadge\}<\/div>\}\n\s+\{micWordsChip\}\n\s+<\/div>/, 'inside the minimap\'s box, so it moves nothing')
  assert.match(HUD, /function MicBadge[^]*?className=\{`pointer-events-auto relative flex h-7 w-7 [^`]*focus-visible:outline-2[^`]*\$\{panel\}`\}\n\s+data-hint="voice"/, '28 px, the pill\'s focus ring and hint')
  assert.match(HUD, /\{failed && <path d="M2\.5 2\.5l11 11" \/>\}/, 'struck through when the device could not open')
  assert.match(HUD, /\{!visible && \(recChip \|\| micPill \|\| rc\?\.listening \|\| captionStrip\) && \(/, 'the hidden HUD still frames an open microphone')
  assert.match(HUD, /<button\n\s+type="button"\n\s+onClick=\{onMic\}\n\s+aria-label=\{pillLabel\(voice\.phase, voice\.speaking, failed \|\| quiet \|\| hushed \? voice\.detail : '', 'V', quiet, hushed\)\}\n\s+aria-pressed=\{open\}/)
  assert.match(HUD, /className=\{`pointer-events-auto flex [^`]*focus-visible:outline-2[^`]*\$\{panel\}`\}/, 'the one HUD element that takes the pointer, with a visible focus ring')
  assert.match(HUD, /<span className="sr-only" role="status" aria-live="polite" data-mic-told>\{voice \? micTold\(voice\) : ''\}<\/span>/, 'a screen reader hears the state change')
  const root = HUD.indexOf('className="ui-zoom pointer-events-none absolute inset-0'), told = HUD.indexOf('data-mic-told'), frame = HUD.indexOf('{visible && !compact && (')
  assert.ok(root < told && told < frame, 'in the HUD\'s root, mounted whatever the layout, so a mute pressed on a phone or with the HUD hidden is heard')
  assert.match(HUD, /phaseWord\(phase === 'speech' \? 'listening' : phase\)/, 'but not every onset of speech')
  assert.match(HUD, /requestAnimationFrame\(draw\)/, 'the meter runs at frame rate, outside React')
})

test('Sloane and the microphone: her voice is told to the detector, a barge-in cuts her line, the recogniser\'s words reach her; the device is released with the city', () => {
  assert.match(APP, /const untell = speaker\.onSpeaking\(\(on\) => mic\.setSpeaking\(on\)\)\n\s+const unline = speaker\.onLine\(\(\) => mic\.newLine\(\)\)\n\s+const barge = \(\) => speaker\.stop\(\)\n\s+mic\.addEventListener\('barge', barge\)/, 'a line that cuts the one still playing is learned afresh (no edge of speaking there)')
  assert.match(APP, /untell\(\)\n\s+unline\(\)\n\s+mic\.setSpeaking\(false\)/)
  assert.match(APP, /if \(!vouched && !heardNow\(speaker\.speaking, performance\.now\(\), quietAt\)\) return\n\s+if \(parseRequest\(t\) === null\) setHeard\(\{ id: \+\+heardId, text: t \}\)/, 'nothing while Sloane speaks or just after (her own line back through the speakers); a recruitment request is the recruiter\'s; the rest is Sloane\'s')
  assert.match(APP, /const unquiet = speaker\.onSpeaking\(\(on\) => \{ if \(!on && !mic\.speech\) quietAt = performance\.now\(\) \}\)/, 'a line cut by a barge-in leaves no quiet tail: the words after it are the visitor\'s')
  assert.match(APP, /mic\.hear\(false\)\n\s+speech\.stop\(\)\n\s+r\.removeEventListener\('mic', onRecruiterMic\)\n\s+r\.removeEventListener\('heard', onHeard\)\n\s+unquiet\(\)/, 'and let go with the city: the microphone hands nothing more over, the recogniser\'s worker ends')
  assert.match(APP, /heard=\{heard\}/)
  assert.match(CONCIERGE, /heard\?: \{ id: number; text: string \} \| null/)
  assert.match(CONCIERGE, /const said = heardGoal\(text, open\)/, 'heard.ts decides what of it is a goal')
  assert.match(APP, /if \(!open && mic\.phase !== 'opening'\) \{ micWasOpen = false; speech\.flush\(\); if \(speech\.fetching\) speech\.stop\(\); if \(live\) r\.stop\(\); unasked = false; return \}/, 'the recogniser stops whenever the microphone settles closed, not only on an open-to-closed edge (a mute while it was opening); a download under way stops with it')
  assert.match(APP, /const asked = !unasked\n\s+unasked = false\n\s+if \(open\) void speech\.start\(asked\)\n(?:\s*\/\/[^\n]*\n)*\s+if \(open && !live && words\(\) && !speech\.ready\) \{\n\s+if \(!speech\.claims\) void r\.listen\(\)\n\s+else void onDeviceReady\(\)\.then\(\(ok\) => \{ if \(ok && mic\.open && speech\.claims && !speech\.ready && !browserLive\(\)\) void r\.listen\(\) \}\)\n\s+\}/, 'the page\'s own recogniser starts with the microphone; the browser\'s reads until the page\'s own is ready, and while the page\'s is on its way only if it needs nothing installed')
  assert.match(APP, /on: \(on: boolean\) => \{\n\s+if \(!on\) \{ mic\.mute\(\); return 'muted: the device is released' \}\n\s+unasked = false\n\s+return mic\.listen\(\)\.then\(\(st\) => \{ if \(micIsOpen\(st\.phase\)\) void speech\.start\(true\)/, '`mic on` is the visitor\'s ask, even while the city\'s own open is still under way')
  assert.match(APP, /speech\.claims \|\| speech\.phase === 'absent' \|\| !speech\.served \? '' : ' · mic on asks for it again'/, 'never offered where no pack can be served')
  assert.equal(APP.match(/mic\.close\(\)/g)?.length, 3, 'the city going away, a halt, and the shell unmounting')
  assert.match(APP, /unlisten\?\.\(\)\n\s+tasks\.dispose\(\)\n\s+r\.dispose\(\)\n\s+mic\.close\(\)\n\s+setLocked\(reason\)/, 'a halt releases the device')
  assert.match(APP, /useEffect\(\(\) => \(\) => \{ mic\.close\(\) \}, \[mic\]\)/, 'the shell unmounting closes it (not dispose: a development double mount reuses the same microphone)')
  assert.doesNotMatch(APP, /mic\.dispose\(\)/)
  assert.match(APP, /const wake = \(\) => mic\.resume\(\)/, 'a gesture wakes a context opened at boot')
  assert.match(COMMANDS, /\{ name: 'mic', usage: 'mic \[on\|off\]'/)
})

test('the page\'s own recogniser: one per page over the site\'s own fetch; sentences reach it only while it reads and only when Sloane is not speaking; what it reads goes the recruiter\'s way, vouched for', () => {
  assert.match(APP, /^import SpeechWorker from '\.\/09_Cognition\/speech\.worker\.ts\?worker&inline'$/m, 'the worker is bundled into the page')
  assert.match(APP, /const PAGE_SPEECH = once\(\(\) => new SpeechEngine\(\{\n\s+fetch: siteFetch,\n\s+worker: speechWorker,\n\s+served: \(\) => \/\^https\?:\$\/\.test\(window\.location\.protocol\) && document\.querySelector\('link\[rel="manifest"\]'\) !== null,\n\s+link: \(\) => readLink\(navigator\),\n\s+unknown: \(\) => \(typeof matchMedia === 'function' && matchMedia\('\(pointer: coarse\)'\)\.matches \? 'this browser does not say whether this device is on mobile data' : null\),\n\s+store: speechStore\(typeof caches === 'undefined' \? null : caches\),\n\}\)\)/, 'one engine, fetching only through siteFetch (the page\'s own site)')
  assert.equal(APP.match(/new SpeechEngine\(/g)?.length, 1)
  assert.equal(APP.match(/new SpeechWorker\(/g)?.length, 1)
  assert.match(APP, /const hearing = \(\): void => mic\.hear\(speech\.ready && !browserLive\(\)\)/, 'the microphone hands sentences over only while the page\'s own recogniser is the one reading')
  assert.equal(APP.match(/mic\.hear\(/g)?.length, 2, 'that line, and the release')
  assert.match(APP, /const u = \(ev as CustomEvent<MicUtterance>\)\.detail\n\s+if \(!heardNow\(speaker\.speaking, performance\.now\(\), quietAt\)\) return\n\s+speech\.read\(u\.samples, u\.cut\)/, 'Sloane\'s own line back through the speakers is never read')
  assert.equal(APP.match(/speech\.read\(/g)?.length, 1)
  assert.match(APP, /vouched = true\n\s+try \{ void r\.hear\(h\.text\) \} finally \{ vouched = false \}/, 'judged when it was said, not again when it was read')
  assert.match(APP, /if \(edge && phase === 'ready' && browserLive\(\)\) r\.stop\(\)\n\s+hearing\(\)\n\s+if \(edge && \(phase === 'absent' \|\| phase === 'failed' \|\| phase === 'waiting'\) && mic\.open && words\(\) && !browserLive\(\)\) void r\.listen\(\)/, 'the two recognisers never read the same speech; the browser\'s stands in where the page\'s own is not to be had')
  assert.match(HUD, /const quiet = voice\.silent === true && voice\.phase === 'listening' && !voice\.speaking/)
  assert.match(HUD, /<span className="truncate">\{pillWord\(voice\.phase, voice\.speaking, quiet, hushed\)\}<\/span>/, 'an open device that sends nothing reads Mic silent; one that has sent only zeros, No sound yet')
  assert.match(HUD, /const hushed = !quiet && voice\.hushed === true && voice\.phase === 'listening' && !voice\.speaking/, 'the hint never wears the failure\'s colour')
  assert.match(HUD, /\{micBadge && <div className="absolute bottom-0 left-0">\{micBadge\}<\/div>\}\n\s+\{micWordsChip\}\n\s+<\/div>/, 'on a compact layout the words stand in a chip beside the badge, inside the minimap\'s box, so they move nothing')
  assert.match(HUD, /className=\{`pointer-events-none absolute bottom-0 left-8 max-w-20 truncate /, 'and stay inside it, in its own units: 2 rem (the 1.75 rem badge and its focus ring) plus 5 rem of a 7 rem box')
  assert.match(HUD, /const micWords = micBadge && micOpen && voice \? voice\.said \? `\\u201c\$\{voice\.said\}\\u201d` : voice\.words \? '' : voice\.note \?\? '' : ''/, 'in the pill\'s order: a sentence, nothing while words are read, else the note')
  assert.match(HUD, /if \(voice\.words\) return `\$\{state\}, words on-device`/, 'the reader is told what the pill shows')
  assert.doesNotMatch(HUD, /Heard: \$\{voice\.said\}/, 'a sentence is not in the state\'s region (its quote going would tell the state again)')
  assert.match(HUD, /<span className="sr-only" aria-live="polite" data-mic-heard>\{voice\?\.heardText \? `Heard: \$\{voice\.heardText\}\$\{\(voice\.heard \?\? 0\) % 2 === 1 \? '\\u200b' : ''\}` : ''\}<\/span>/, 'each sentence told once in a region of its own, a repeat told again')
  assert.match(APP, /said\.text = h\.text\n\s+said\.at = performance\.now\(\)\n\s+said\.n\+\+/)
  assert.match(APP, /heard: said\.n, heardText: said\.text \}/)
  assert.match(HUD, /data-mic-said>/, 'the sentence last understood shows on the pill')
  assert.match(HUD, /data-mic-note>\{voice\.note\}/, 'and where the recogniser stands while it is not reading')
})
