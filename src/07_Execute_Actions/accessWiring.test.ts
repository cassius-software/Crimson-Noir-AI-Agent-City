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
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import ts from 'typescript'

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')
const APP = read('../App.tsx')
const HUD = read('./Hud.tsx')
const CONCIERGE = read('./Concierge.tsx')
const ACT = read('./ActCard.tsx')
const WARDROBE = read('./Customizer.tsx')
const RECOVERY = read('./RecoveryCard.tsx')
const STORE = read('./StoreCard.tsx')
const ONBOARDING = read('./onboarding/Onboarding.tsx')
const FIRST_WALK = read('./onboarding/FirstWalk.tsx')
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
  assert.match(APP, /const \[start\] = useState\(\(\) => \{ const kept = loadAccess\(\); return \{ kept, live: accessFromQuery\(new URLSearchParams\(window\.location\.search\), kept\) \} \}\)\n\s+const \[access, setAccessState\] = useState\(start\.live\)/)
  assert.match(APP, /window\.matchMedia\('\(prefers-contrast: more\)'\)/)
  assert.match(APP, /const prefersMore = useSyncExternalStore\(PREFERS_MORE\.subscribe, PREFERS_MORE\.matches, PREFERS_MORE\.server\)/)
  assert.match(APP, /const onAccess = useCallback\(\(next: AccessSettings, whole\?: boolean\) => \{\n\s+keptRef\.current = whole === true \? next : keepAccess\(keptRef\.current, liveRef\.current, next\)\n\s+liveRef\.current = next\n\s+setAccessState\(next\)\n\s+saveAccess\(keptRef\.current\)\n\s+\}, \[\]\)/, 'a change keeps only its own fields over what was kept; a reset is whole')
  assert.match(APP, /useEffect\(\(\) => \{ applyAccess\(access, prefersMore, document\.documentElement\) \}, \[access, prefersMore\]\)/)
  const app = APP.indexOf('function App() {'), apply = APP.indexOf('applyAccess(access, prefersMore, document.documentElement)'), tty = APP.indexOf("if (options.boot === 'tty') return <TtyShell />")
  assert.ok(app < apply && apply < tty, 'applied in App before any shell is chosen: the console alone and the onboarding hold it too')
  assert.equal(APP.match(/saveAccess\(/g)?.length, 1, 'one place keeps them')
  assert.equal(APP.match(/loadAccess\(/g)?.length, 1, 'read once')
})

test('the shell: the filter reaches the engine as it changes, the bridge reads the live settings, the HUD gets the contrast and the caption size, the Menu the two switches', () => {
  assert.match(APP, /const high = highContrast\(access, prefersMore\)/)
  assert.match(APP, /useEffect\(\(\) => \{ engine\?\.setVision\(access\.vision\) \}, \[engine, access\.vision\]\)/)
  assert.match(APP, /access: accessBridge\(\(\) => accessRef\.current, \(\) => prefersRef\.current, onAccess, \(\) => engineRef\.current\?\.visionBlocked\(\) \?\? null\),/, 'the console says when the chain cannot draw the filter')
  assert.match(APP, /useEffect\(\(\) => \{ accessRef\.current = access; prefersRef\.current = prefersMore \}, \[access, prefersMore\]\)/, 'the refs follow the state, since the bridge is built once')
  assert.match(APP, /<Hud s=\{hud\}[^\n]* highContrast=\{high\} captionPx=\{CAPTION_PX\[access\.captions\]\} mic=\{mic\} onMic=\{onMic\}[^\n]*\/>/)
  assert.match(APP, /contrast: high,\n\s+onContrast: \(\) => onAccess\(toggleContrast\(access, prefersMore\)\),\n\s+textScale: access\.scale,\n\s+onTextScale: \(\) => onAccess\(cycleScale\(access\)\),/)
  assert.match(TOUCH, /\{ label: 'High contrast', on: host\.contrast === true, run: host\.onContrast \}/)
  assert.match(TOUCH, /\{ label: `Text size \$\{host\.textScale \?\? 100\} %`, id: 'text-size', run: host\.onTextScale, keep: true \}/, 'the sheet stays open while the size cycles')
  assert.match(TOUCH, /key=\{it\.id \?\? it\.label\}/, 'the same button through every size: its focus and the scan\'s place hold')
  assert.match(ENGINE, /^\s+setVision\(mode: Vision\): string \{\n\s+this\.visionMode = mode\n\s+this\.vision\.value\.set\(\.\.\.visionMatrix\(mode\)\)\n\s+if \(!this\.disposed\) this\.applyTier\(\)\n\s+const blocked = mode === 'none' \? null : this\.visionBlocked\(\)\n\s+return blocked \?\? visionWord\(mode\)\n\s+\}/m)
  assert.match(ENGINE, /if \(\(this\.ghost\.on \|\| this\.visionMode !== 'none'\) && this\.options\.post\) k\.post = true/, 'a chosen filter keeps the post chain on at every tier, as ghost view does')
  for (const why of ['off under a headset', 'off while the screen is split', 'the lite profile turned off', '?post=0 turned off']) assert.ok(ENGINE.slice(ENGINE.indexOf('visionBlocked(): string | null {')).split('\n  }')[0].includes(why), `the filter says why it cannot be drawn: ${why}`)
  assert.match(BRIDGE, /set\(field: string, value: string\): \{ line: string \} \| \{ error: string \}/)
  assert.match(COMMANDS, /\{ name: 'access', usage: 'access \[contrast auto\|high\|normal\|vision none\|protan\|deutan\|tritan\|text 100\|125\|150\|175\|200\|captions normal\|large\|huge\|dwell on\|off\|scan on\|off\|pad both\|left\|right\|announce on\|off\|reset\]'/)
  assert.match(COMMANDS, /'access vision': \['deutan', 'none', 'protan', 'tritan'\]/)
})

/** The class tokens a className could hold: every string in it (a template literal's text, a ternary's branches). */
function classTokens(attr: ts.JsxAttribute): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text)
    else if (ts.isTemplateExpression(n)) { out.push(n.head.text); for (const span of n.templateSpans) { visit(span.expression); out.push(span.literal.text) } }
    else ts.forEachChild(n, visit)
  }
  if (attr.initializer) visit(attr.initializer)
  return out.join(' ').split(/\s+/).filter(Boolean)
}

/** Tokens that cover the whole screen: inset-0 with absolute or fixed, or fixed at the top left at full size. */
const fullScreen = (t: string[]): boolean =>
  (t.includes('inset-0') && (t.includes('absolute') || t.includes('fixed'))) ||
  (t.includes('fixed') && t.includes('top-0') && t.includes('left-0') && t.some((c) => /^h-(full|screen|dvh|svh|lvh)$/.test(c)) && t.some((c) => /^w-(full|screen|dvw|svw|lvw)$/.test(c)))

/** Every full-screen element of every component in src, with whether it zooms and whether one it sits in does. */
function overlays(): { file: string; line: number; tokens: string[]; zoom: boolean; inside: boolean }[] {
  const files = (dir: string): string[] => readdirSync(new URL(dir, import.meta.url), { withFileTypes: true }).flatMap((d) => d.isDirectory() ? files(`${dir}${d.name}/`) : d.name.endsWith('.tsx') ? [`${dir}${d.name}`] : [])
  const found: { file: string; line: number; tokens: string[]; zoom: boolean; inside: boolean }[] = []
  for (const file of files('../')) {
    const sf = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
    const walk = (n: ts.Node, zoomed: boolean): void => {
      if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
        const open = ts.isJsxElement(n) ? n.openingElement : n
        const attr = open.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(sf) === 'className')
        const tokens = attr ? classTokens(attr) : []
        const zoom = tokens.includes('ui-zoom')
        if (zoom || fullScreen(tokens)) found.push({ file, line: sf.getLineAndCharacterOfPosition(open.getStart(sf)).line + 1, tokens, zoom, inside: zoomed })
        ts.forEachChild(n, (c) => walk(c, zoomed || zoom))
        return
      }
      ts.forEachChild(n, (c) => walk(c, zoomed))
    }
    walk(sf, false)
  }
  return found
}

test('every overlay root carries the zoom class, every card the blur utility the contrast rules key on; the HUD meter and captions follow', () => {
  for (const [name, src, roots] of [['Hud', HUD, 1], ['Concierge', CONCIERGE, 2], ['ActCard', ACT, 1], ['Customizer', WARDROBE, 1], ['RecoveryCard', RECOVERY, 2], ['Onboarding', ONBOARDING, 1], ['StoreCard', STORE, 1], ['the first walk', FIRST_WALK, 1], ['the touch Menu', TOUCH, 1]] as const) {
    assert.equal(src.match(/className="ui-zoom (?:pointer-events-none )?(?:absolute|fixed) inset-0/g)?.length, roots, `${name}: its full-screen root${roots > 1 ? 's' : ''} zoom`)
  }
  // Every full-screen overlay in the page's components zooms or sits inside one that does, and none zooms inside
  // another (the zoom would apply twice), so a card added later (the shops' was merged in without it) is caught however
  // its classes are written: read from the syntax tree, a template literal's text and any order included. The touch
  // layer's own root (04_Connect_Hardware/TouchControls.tsx, z-10) is the one left out: its buttons are sized for
  // thumbs, not text (its Menu sheet, a list of words, zooms). A component whose full-screen root is drawn inside
  // another component's zoomed root would need its own line here.
  const all = overlays()
  const thumbs = all.filter((o) => o.file.endsWith('/TouchControls.tsx') && !o.zoom && !o.inside && o.tokens.includes('z-10'))
  assert.equal(thumbs.length, 1, 'the touch layer\'s root, and only it, is left out')
  for (const o of all) {
    if (thumbs.includes(o)) continue
    assert.ok(!(o.zoom && o.inside), `${o.file}:${o.line}: a zoom inside a zoom (${o.tokens.join(' ')})`)
    assert.ok(o.zoom || o.inside, `${o.file}:${o.line}: a full-screen overlay without the text-size zoom (${o.tokens.join(' ')})`)
  }
  assert.ok(all.filter((o) => o.zoom).length >= 10, `the sweep reads the zoomed roots: ${all.filter((o) => o.zoom).length}`)
  assert.match(TOUCH, /const unzoom = \(px: number\): string => `calc\(\$\{px\}px \/ var\(--ui-zoom, 1\)\)`/)
  assert.equal(TOUCH.match(/(?:right|bottom): unzoom\(Math\.max\(8, window\.inner(?:Width|Height) - at\.\w+(?: \+ 12)?\)\)/g)?.length, 4, 'the Menu sheet\'s place, in the window\'s pixels, divided by the zoom')
  assert.equal(TOUCH.match(/maxHeight: `calc\(\(\$\{Math\.round\(at\.(?:bottom|top - 12)\)\}px - max\(12px, env\(safe-area-inset-top, 0px\)\)\) \/ var\(--ui-zoom, 1\)\)`/g)?.length, 2, 'and its height')
  assert.match(TOUCH, /const beside = at\.left - 12 - SHEET_W \* zoom >= 8/, 'and it is that much wider')
  for (const [name, src] of [['Hud', HUD], ['Concierge', CONCIERGE], ['ActCard', ACT], ['Customizer', WARDROBE], ['RecoveryCard', RECOVERY], ['StoreCard', STORE]] as const) {
    assert.match(src, /backdrop-blur-/, `${name}: the card is frosted glass, which index.css flattens`)
  }
  assert.match(CSS, /:root \{\n\s+--ui-zoom: 1;\n\}/)
  assert.match(CSS, /\.ui-zoom \{\n\s+zoom: var\(--ui-zoom\);\n\}/)
  assert.match(CSS, /html\[data-contrast='high'\] \[class\*='backdrop-blur'\] \{\n\s+background-color: #000 !important;\n\s+color: #fff !important;\n\s+border: 2px solid #fff !important;[^}]*backdrop-filter: none !important;/)
  assert.match(CSS, /html\[data-contrast='high'\] :focus-visible \{\n\s+outline: 3px solid #ffd400 !important;/)
  assert.doesNotMatch(CSS, /canvas[^{]*\{[^}]*filter/, 'the canvas is never filtered by CSS: the colour-vision filter is the post chain\'s')
  assert.match(HUD, /style=\{\{ fontSize: `\$\{captionPx\}px` \}\} data-hint="captions"/)
  assert.match(HUD, /ctx\.fillStyle = contrast \? '#fff' : dark \?/, 'the meter is white on the flattened pill')
  // The noir panels (the onboarding's card, the first walk's) are ink, not frosted: flattened by their own class.
  for (const src of [ONBOARDING, FIRST_WALK]) assert.match(src, /className=\{?[`"]noir-panel /)
  assert.match(CSS, /html\[data-contrast='high'\] \.noir-panel \{\n\s+background: #000 !important;\n\s+color: #fff !important;\n\s+border: 2px solid #fff !important;\n\}/)
  assert.match(CSS, /html\[data-contrast='high'\] \.noir-panel :is\(\[class\*='text-noir-titanium-'\], \.noir-label\) \{\n\s+color: #fff !important;/, 'the titanium greys white')
  assert.match(CSS, /html\[data-contrast='high'\] \.noir-panel \.noir-button \{\n\s+color: #fff !important;\n\s+background: #000 !important;\n\s+border: 2px solid #fff !important;/)
  assert.match(CSS, /html\[data-contrast='high'\] \.noir-panel input \{/, 'the name field too')
  assert.match(HUD, /<MicPill voice=\{voice\} mic=\{mic\} onMic=\{onMic\} contrast=\{highContrast\}/)
})

test('the post chain ends in the filter on both paths, the identity until the host sets it, after the ghost so its colours move with the frame', () => {
  assert.match(POSTFX, /const vision: VisionUniform = uniform\(new Matrix3\(\)\)/, 'a three Matrix3 is the identity')
  assert.match(POSTFX, /const over = ghost && ghostPass \? ghostComposite\(image, ghostPass\.getTextureNode\('output'\), ghost\) : image\n\s+return vec4\(vision\.mul\(over\.rgb\)\.clamp\(\), over\.a\)/)
  assert.equal(POSTFX.match(/, vision, release \}$/gm)?.length, 2, 'returned with and without the cinema camera')
  assert.match(POSTFX, /^ {2}vision: VisionUniform$/m, 'a member of the chain the engine is handed')
  // The chain built at boot, and the one rebuilt at one sample when the four-sample scene pass is refused: the engine
  // keeps the vision uniform of the chain it draws.
  assert.match(ENGINE, /let \{ pipeline: post, volumetrics, cinema, vision, release \} = chainOf\(sceneSamples\)/)
  assert.match(ENGINE, /;\(\{ pipeline: post, volumetrics, cinema, vision, release \} = chainOf\(sceneSamples\)\)/)
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
  assert.match(CSS, /\[data-dwell='arming'\],\n\[data-dwell='rearming'\] \{\n\s+outline-style: solid !important;\n\s+outline-width: 3px !important;\n\s+outline-color: #ffd400;[^}]*animation: dwell-arm 600ms linear forwards;/, 'the ring\'s colour is the animation\'s: an important colour would outrank it')
  assert.match(CSS, /\[data-dwell='rearming'\] \{\n\s+animation-name: dwell-rearm;\n\}/, 'a restart starts the fill again')
  assert.match(CSS, /\[data-scan\] \{\n\s+outline: 4px solid #ffd400 !important;/)
})

test('a setting changed never rebuilds the city: the shell pins what it booted with, and the engine effect depends on nothing an accessibility change renews', () => {
  assert.match(APP, /const \[boot\] = useState\(\(\) => \(\{ options, plan \}\)\)/)
  assert.match(APP, /const \{ options, plan \} = boot\n/)
  // Exactly these: each is made once per shell (useState, a [] callback, the pinned boot; the first walk's switch is
  // App's own useState), so no setting renews one.
  assert.match(APP, /\}, \[boot, wearLook, link, roster, speaker, walk, keeper, openStore, closeStore, mic, onMic, onAccess, announcer\]\)/, 'no options or plan object among the deps: App renders them anew on every setting')
  assert.doesNotMatch(APP, /\}, \[options, plan, wearLook/)
})

test('high contrast: light buttons lifted, the chosen one of a set reversed (an inline colour kept), touch toggles and status dots readable', () => {
  const block = CSS.slice(CSS.indexOf("html[data-contrast='high'] [class*='backdrop-blur'] {"), CSS.indexOf("html[data-contrast='high'] :focus-visible"))
  assert.match(block, /\[class\*='backdrop-blur'\] \.bg-white,\n/, 'a solid white button is lifted with the translucent ones')
  assert.match(block, /\[class\*='backdrop-blur'\] \.bg-white \*,\n/)
  const chosen = ":is([aria-checked='true'], [aria-selected='true'], [aria-pressed='true'])"
  const at = block.indexOf(`[class*='backdrop-blur'] ${chosen} {`), lift = block.indexOf("[class*='bg-white/'],")
  assert.ok(lift >= 0 && at > lift, 'the chosen rule comes after the lift, which it outranks at equal specificity')
  assert.match(block.slice(at), /^[^}]*color: #fff !important;\n\s+border: 3px solid #fff !important;\n\}/, 'white text and a thick ring')
  assert.doesNotMatch(block.slice(at, block.indexOf('}', at)), /background-color/, 'no fill in the shared rule')
  assert.ok(block.includes(`${chosen}:not([style*='background']) {\n  background-color: #000 !important;\n}`), 'black only where no inline colour is the meaning (a wardrobe swatch keeps its colour)')
  assert.match(block, /html\[data-contrast='high'\] \[data-touch\]\[aria-pressed='true'\] \{\n\s+background-color: #fff !important;\n\s+color: #000 !important;/, 'a held or latched touch button reads on')
  assert.match(block, /\.rounded-full:empty\[class\*='bg-'\] \{\n\s+border: 1px solid #fff !important;/)
  for (const [cls, hex] of [['emerald-400', '#4ade80'], ['amber-400', '#fbbf24'], ['rose-500', '#f87171'], ['sky-500', '#38bdf8']]) {
    assert.ok(block.includes(`.rounded-full:empty.bg-${cls} {\n  background-color: ${hex} !important;`), `the ${cls} dot keeps its colour`)
  }
})

test('inside the text zoom, every length measured in the window\'s pixels is divided by the zoom first', () => {
  const layout = CONCIERGE.slice(CONCIERGE.indexOf('const CARD_AT = {'), CONCIERGE.indexOf('/** A media query as a stable external store'))
  for (const v of ['touch-top', 'touch-left', 'hud-right', 'hud-row-bottom', 'hud-bottom']) {
    const uses = layout.match(new RegExp(`var\\(--${v},[^)]*\\)`, 'g')) ?? []
    assert.ok(uses.length > 0, `--${v} is used`)
    const divided = layout.match(new RegExp(`calc\\(var\\(--${v},[^)]*\\)(?:_/_| / )var\\(--ui-zoom, ?1\\)\\)`, 'g')) ?? []
    assert.equal(divided.length, uses.length, `every --${v} is divided by the zoom`)
  }
  const dvh = layout.match(/100dvh/g)?.length ?? 0
  assert.ok(dvh > 0)
  assert.equal(layout.match(/calc\(100dvh(?:_\/_| \/ )var\(--ui-zoom, ?1\)\)/g)?.length, dvh, 'and so is the viewport\'s height')
  // The first walk's card: the touch buttons' edges and the stick's zone with and without its gaps (the unzoomed touch
  // layer's), the top of the HUD's chips at the foot (window pixels, Hud.tsx), the window's height and the console's share.
  const walk = FIRST_WALK.slice(FIRST_WALK.indexOf('const AT = {'), FIRST_WALK.indexOf('} as const'))
  for (const v of ['touch-top', 'touch-left', 'hud-foot']) {
    const edges = walk.match(new RegExp(`var\\(--${v},[^)]*\\)`, 'g')) ?? []
    assert.ok(edges.length > 0, `--${v} is used`)
    assert.equal(walk.match(new RegExp(`calc\\(var\\(--${v},[^)]*\\)_/_var\\(--ui-zoom,1\\)\\)`, 'g'))?.length, edges.length, `every --${v} is divided by the zoom`)
  }
  for (const zone of ['11\\.5rem', '12\\.5rem']) {
    assert.equal(walk.match(new RegExp(zone, 'g'))?.length, walk.match(new RegExp(`calc\\(${zone}_/_var\\(--ui-zoom,1\\)\\)`, 'g'))?.length, 'and the stick\'s zone')
  }
  const heights = walk.match(/\d+dvh/g) ?? []
  assert.equal(heights.length, 5, 'five cards\' heights')
  assert.equal(walk.match(/calc\(\d+dvh_\/_var\(--ui-zoom,1\)\)/g)?.length, heights.length, 'and the window\'s height')
  assert.match(HUD, /mt-\[max\(0px,calc\(var\(--chip-bottom,0px\)_-_var\(--hud-bottom,0px\)_\/_var\(--ui-zoom,1\)\)\)\]/, 'the HUD\'s toasts under the chip: the chip\'s foot is already in the zoom\'s lengths, the HUD\'s is not')
})
