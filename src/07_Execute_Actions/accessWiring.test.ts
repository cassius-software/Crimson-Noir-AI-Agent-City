// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the accessibility settings' wiring through the page (access.ts is tested in
 * access.test.ts; this is the React and shader side no Node test can run): that App reads the kept settings under the
 * URL once, writes them onto <html> above every shell, follows the system's contrast switch, hands the colour-vision
 * filter to the engine and the settings to the console's bridge, the HUD and the touch Menu; that every overlay's root
 * carries the zoom class and every card the blur utility the high-contrast rules key on; that the post chain's last
 * step is the filter's matrix on both of its paths, the identity until set; and that the console knows `access`.
 * What breaks if it is removed? A setting that is kept but applied nowhere, a card the zoom or the contrast misses,
 * a filter built into the chain that nothing sets, with every unit test green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const APP = read('../App.tsx')
const HUD = read('./Hud.tsx')
const CONCIERGE = read('./Concierge.tsx')
const ACT = read('./ActCard.tsx')
const WARDROBE = read('./Customizer.tsx')
const RECOVERY = read('./RecoveryCard.tsx')
const ONBOARDING = read('./onboarding/Onboarding.tsx')
const TOUCH = read('../04_Connect_Hardware/TouchControls.tsx')
const CSS = read('../index.css')
const POSTFX = read('./postfx.ts')
const ENGINE = read('./engine.ts')
const COMMANDS = read('./terminal/commands.ts')
const BRIDGE = read('./terminal/bridge.ts')
const INPUT = read('../04_Connect_Hardware/input.ts')
const SCANNING = read('../04_Connect_Hardware/scanning.ts')
const TELEMETRY = read('../05_Observe_Environment/telemetry.ts')

test('App: the settings are read once under the URL, written onto <html> above every shell, kept on every change; auto contrast follows the system', () => {
  assert.match(APP, /const \[access, setAccessState\] = useState\(\(\) => accessFromQuery\(new URLSearchParams\(window\.location\.search\), loadAccess\(\)\)\)/)
  assert.match(APP, /window\.matchMedia\('\(prefers-contrast: more\)'\)/)
  assert.match(APP, /const prefersMore = useSyncExternalStore\(PREFERS_MORE\.subscribe, PREFERS_MORE\.matches, PREFERS_MORE\.server\)/)
  assert.match(APP, /const onAccess = useCallback\(\(next: AccessSettings\) => \{ setAccessState\(next\); saveAccess\(next\) \}, \[\]\)/)
  assert.match(APP, /useEffect\(\(\) => \{ applyAccess\(access, prefersMore, document\.documentElement\) \}, \[access, prefersMore\]\)/)
  const app = APP.indexOf('function App() {'), apply = APP.indexOf('applyAccess(access, prefersMore, document.documentElement)'), tty = APP.indexOf("if (options.boot === 'tty') return <TtyShell />")
  assert.ok(app < apply && apply < tty, 'applied in App before any shell is chosen: the console alone and the onboarding hold it too')
  assert.equal(APP.match(/saveAccess\(/g)?.length, 1, 'one place keeps them')
  assert.equal(APP.match(/loadAccess\(/g)?.length, 1, 'read once')
})

test('the shell: the filter reaches the engine as it changes, the bridge reads the live settings, the HUD gets the contrast and the caption size, the Menu the two switches', () => {
  assert.match(APP, /const high = highContrast\(access, prefersMore\)/)
  assert.match(APP, /useEffect\(\(\) => \{ engine\?\.setVision\(access\.vision\) \}, \[engine, access\.vision\]\)/)
  assert.match(APP, /access: accessBridge\(\(\) => accessRef\.current, \(\) => prefersRef\.current, onAccess\),/)
  assert.match(APP, /useEffect\(\(\) => \{ accessRef\.current = access; prefersRef\.current = prefersMore \}, \[access, prefersMore\]\)/, 'the refs follow the state, since the bridge is built once')
  assert.match(APP, /<Hud s=\{hud\}[^\n]* highContrast=\{high\} captionPx=\{CAPTION_PX\[access\.captions\]\} mic=\{mic\} onMic=\{onMic\} \/>/)
  assert.match(APP, /contrast: high,\n\s+onContrast: \(\) => onAccess\(toggleContrast\(access, prefersMore\)\),\n\s+textScale: access\.scale,\n\s+onTextScale: \(\) => onAccess\(cycleScale\(access\)\),/)
  assert.match(TOUCH, /\{ label: 'High contrast', on: host\.contrast === true, run: host\.onContrast \}/)
  assert.match(TOUCH, /\{ label: `Text size \$\{host\.textScale \?\? 100\} %`, run: host\.onTextScale, keep: true \}/, 'the sheet stays open while the size cycles')
  assert.match(ENGINE, /^\s+setVision\(mode: Vision\): string \{\n\s+this\.visionMode = mode\n\s+this\.vision\.value\.set\(\.\.\.visionMatrix\(mode\)\)\n\s+return visionWord\(mode\)\n\s+\}/m)
  assert.match(BRIDGE, /set\(field: string, value: string\): \{ line: string \} \| \{ error: string \}/)
  assert.match(COMMANDS, /\{ name: 'access', usage: 'access \[contrast auto\|high\|normal\|vision none\|protan\|deutan\|tritan\|text 100\|125\|150\|175\|200\|captions normal\|large\|huge\|dwell on\|off\|scan on\|off\|pad both\|left\|right\|announce on\|off\|reset\]'/)
  assert.match(COMMANDS, /'access vision': \['deutan', 'none', 'protan', 'tritan'\]/)
})

test('every overlay root carries the zoom class, every card the blur utility the contrast rules key on; the HUD meter and captions follow', () => {
  for (const [name, src, roots] of [['Hud', HUD, 1], ['Concierge', CONCIERGE, 2], ['ActCard', ACT, 1], ['Customizer', WARDROBE, 1], ['RecoveryCard', RECOVERY, 2], ['Onboarding', ONBOARDING, 1]] as const) {
    assert.equal(src.match(/className="ui-zoom (?:pointer-events-none )?(?:absolute|fixed) inset-0/g)?.length, roots, `${name}: its full-screen root${roots > 1 ? 's' : ''} zoom`)
  }
  for (const [name, src] of [['Hud', HUD], ['Concierge', CONCIERGE], ['ActCard', ACT], ['Customizer', WARDROBE], ['RecoveryCard', RECOVERY]] as const) {
    assert.match(src, /backdrop-blur-/, `${name}: the card is frosted glass, which index.css flattens`)
  }
  assert.match(CSS, /:root \{\n\s+--ui-zoom: 1;\n\}/)
  assert.match(CSS, /\.ui-zoom \{\n\s+zoom: var\(--ui-zoom\);\n\}/)
  assert.match(CSS, /html\[data-contrast='high'\] \[class\*='backdrop-blur'\] \{\n\s+background-color: #000 !important;\n\s+color: #fff !important;\n\s+border: 2px solid #fff !important;[^}]*backdrop-filter: none !important;/)
  assert.match(CSS, /html\[data-contrast='high'\] :focus-visible \{\n\s+outline: 3px solid #ffd400 !important;/)
  assert.doesNotMatch(CSS, /canvas[^{]*\{[^}]*filter/, 'the canvas is never filtered by CSS: the colour-vision filter is the post chain\'s')
  assert.match(HUD, /style=\{\{ fontSize: `\$\{captionPx\}px` \}\} data-hint="captions"/)
  assert.match(HUD, /ctx\.fillStyle = contrast \? '#fff' : dark \?/, 'the meter is white on the flattened pill')
  assert.match(HUD, /<MicPill voice=\{voice\} mic=\{mic\} onMic=\{onMic\} contrast=\{highContrast\}/)
})

test('the post chain ends in the filter on both paths, the identity until the host sets it, after the ghost so its colours move with the frame', () => {
  assert.match(POSTFX, /const vision: VisionUniform = uniform\(new Matrix3\(\)\)/, 'a three Matrix3 is the identity')
  assert.match(POSTFX, /const over = ghost \? ghostComposite\(image, pass\(ghost\.scene, camera\)\.getTextureNode\('output'\), ghost\) : image\n\s+return vec4\(vision\.mul\(over\.rgb\)\.clamp\(\), over\.a\)/)
  assert.equal(POSTFX.match(/, vision \}$/gm)?.length, 2, 'returned with and without the cinema camera')
  assert.match(ENGINE, /const \{ pipeline: post, volumetrics, cinema, vision \} = buildPost\(/)
  assert.match(ENGINE, /this\.vision = p\.vision/)
  assert.equal(ENGINE.match(/this\.vision\.value\.set\(/g)?.length, 1, 'set in one place')
})

test('the hands and the ears: the dwell and the scan run above every shell, the switch is taken before the city sees it, the pad layout reaches the input, the reader\'s line is in the HUD from the first render', () => {
  const app = APP.indexOf('function App() {'), tty = APP.indexOf("if (options.boot === 'tty') return <TtyShell />")
  for (const line of ['const dwell = new DwellClicker(browserDwellEnv())', 'const scan = new Scanner(browserScanEnv())']) {
    const at = APP.indexOf(line)
    assert.ok(app < at && at < tty, `${line}: in App, before any shell is chosen`)
  }
  assert.match(APP, /if \(!access\.dwell\) return\n\s+const dwell = new DwellClicker\(browserDwellEnv\(\)\)\n\s+dwell\.start\(\)\n\s+return \(\) => dwell\.stop\(\)\n\s+\}, \[access\.dwell\]\)/)
  assert.match(APP, /if \(!access\.scan\) return\n\s+const scan = new Scanner\(browserScanEnv\(\)\)\n\s+scan\.start\(\)\n\s+return \(\) => scan\.stop\(\)\n\s+\}, \[access\.scan\]\)/)
  assert.match(APP, /useEffect\(\(\) => \{ engine\?\.input\.setHand\(access\.pad\) \}, \[engine, access\.pad\]\)/)
  assert.match(INPUT, /setHand\(hand: PadHand\): void \{\n\s+this\.mapper\.hand = hand\n\s+\}/)
  assert.match(APP, /if \(accessRef\.current\.announce\) \{ const said = announcer\.next\(s, now\); if \(said\) s\.customer\.announce = said \}\n\s+\/\/ The microphone's pill/, 'written every HUD interval, before the pill\'s line')
  assert.match(HUD, /className="ui-zoom pointer-events-none absolute inset-0 [^"]*">\n\s+\{\/\*[^\n]*\*\/\}\n\s+<span className="sr-only" role="status" aria-live="polite" data-announce>\{c\.announce \?\? ''\}<\/span>/, 'the first child of the root, HUD shown or hidden')
  assert.match(TELEMETRY, /^\s+announce\?: string$/m)
  assert.match(SCANNING, /doc\.addEventListener\('keydown', h, \{ capture: true \}\)/, 'ahead of the city\'s keydown')
  assert.match(SCANNING, /e\.preventDefault\(\)\n\s+e\.stopImmediatePropagation\(\)/)
  assert.match(INPUT, /on\(document, 'keydown', \(e\) => \{\n\s+const target = e\.target/, 'the city listens on the way up, after the scan')
  assert.match(CSS, /\[data-dwell='arming'\] \{\n\s+outline: 3px solid #ffd400 !important;[^}]*animation: dwell-arm 600ms linear forwards;/)
  assert.match(CSS, /\[data-scan\] \{\n\s+outline: 4px solid #ffd400 !important;/)
})
