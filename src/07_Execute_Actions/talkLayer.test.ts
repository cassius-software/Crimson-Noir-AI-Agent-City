// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the conversation panel's field and place (TalkLayer.tsx over
 * talkField.ts), which Node cannot render. The field's rules run here for real: a line sent with Enter leaves the
 * controller an empty, unfocused field even though the blur that lets go of the keyboard fires inside the send; a
 * focus request moves the keyboard off a focused button but never out of another text field; Esc from anywhere but a
 * text field finishes (a draft cleared first); the repeats of a key held as the field took the keyboard type nothing.
 * The panel is then pinned at its source: it uses those rules (the blur and focus read the kept text, Esc listens on
 * the page, the focus request asks mayFocus, the field's keys pass the gate), names the pad hand's talk button, stands
 * in places of its own clear of Sloane's chip (under it upright, left of it on a wide screen, her chip tucked away
 * where no band holds a conversation, and back when it closes), above the HUD's captions, with every window length
 * divided by the text size's zoom, and as a column whose head and field never give way.
 * What breaks if it is removed? A conversation that never closes for being idle after a typed line, T that leaves the
 * keyboard on a button so the letters fire the city's keys, an Esc keycap that does nothing after a sent line, a field
 * filling with t's, a left-handed player told to press a dead button, or the panel back over Sloane's chip or the
 * captions, all with every other test green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { escapeAction, FieldDraft, mayFocus, RepeatGate } from './talkField.ts'

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), 'utf8')
const LAYER = read('./TalkLayer.tsx')
const CONCIERGE = read('./Concierge.tsx')
const HUD = read('./Hud.tsx')
const CSS = read('../index.css')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}

/** A controller's view of the field (talk.ts setDraft): idle only with an empty, unfocused field. */
function sink() {
  const calls: [string, boolean][] = []
  return {
    calls,
    setDraft(text: string, focused: boolean) { calls.push([text, focused]) },
    get last() { return calls[calls.length - 1] },
    get idle() { const l = calls[calls.length - 1]; return !l || (l[0] === '' && !l[1]) },
  }
}

test('a line sent with Enter on a keyboard leaves the controller an empty, unfocused field, though the field blurs inside the send', () => {
  const s = sink()
  const keep = new FieldDraft(s)
  keep.focus()
  keep.type('what do you do all day?')
  assert.deepEqual(s.last, ['what do you do all day?', true])
  // The browser fires the blur at once, inside the handler that sends, before React has drawn the empty field.
  let focused = true
  keep.sent(() => { focused = false; keep.blur() }, () => focused)
  assert.equal(keep.text, '')
  assert.ok(s.calls.slice(-2).every(([text]) => text === ''), `the line just sent never comes back as a draft: ${JSON.stringify(s.calls)}`)
  assert.deepEqual(s.last, ['', false])
  assert.ok(s.idle, 'idle again: the minute without anything going on and the 6 m walk-away both count')
})

test('a line sent by touch (the field keeps the keyboard) leaves an empty, focused field; typing and Esc are heard as they happen', () => {
  const s = sink()
  const keep = new FieldDraft(s)
  keep.type('hi')
  keep.sent(() => {}, () => true)
  assert.deepEqual(s.last, ['', true])
  keep.type('and you?')
  keep.blur()
  assert.deepEqual(s.last, ['and you?', false], 'a blur with a draft keeps it: not idle while something is typed')
  keep.focus()
  assert.deepEqual(s.last, ['and you?', true])
  keep.type('')
  assert.deepEqual(s.last, ['', true])
})

test('a focus request takes the keyboard from the page, the canvas, a focused button or the panel, never from another text field', () => {
  const el = (tagName: string, more: object = {}) => ({ tagName, ...more }) as unknown as Element
  const outside = () => false
  assert.equal(mayFocus(null, outside), true)
  assert.equal(mayFocus(el('BODY'), outside), true)
  assert.equal(mayFocus(el('CANVAS'), outside), true)
  assert.equal(mayFocus(el('BUTTON'), outside), true, 'a clicked microphone pill keeps focus in most browsers: it gives way')
  assert.equal(mayFocus(el('A'), outside), true)
  assert.equal(mayFocus(el('INPUT'), outside), false, 'the console\'s prompt or another field keeps the keyboard')
  assert.equal(mayFocus(el('TEXTAREA'), outside), false)
  assert.equal(mayFocus(el('SELECT'), outside), false)
  assert.equal(mayFocus(el('DIV', { isContentEditable: true }), outside), false)
  assert.equal(mayFocus(el('INPUT'), () => true), true, 'the panel\'s own field or buttons')
})

test('Esc from anywhere but a text field finishes the conversation, a draft cleared first; a field\'s, an input method\'s or a handled Esc is left', () => {
  const key = (p: Partial<{ key: string; defaultPrevented: boolean; isComposing: boolean; target: unknown }>) =>
    ({ key: 'Escape', defaultPrevented: false, isComposing: false, target: { tagName: 'BODY' }, ...p }) as Parameters<typeof escapeAction>[0]
  assert.equal(escapeAction(key({}), ''), 'end', 'after a sent line the field has let go: Esc on the page ends')
  assert.equal(escapeAction(key({ target: { tagName: 'CANVAS' } }), ''), 'end')
  assert.equal(escapeAction(key({ target: { tagName: 'BUTTON' } }), ''), 'end', 'with the Talk chip or Done focused')
  assert.equal(escapeAction(key({ target: null }), ''), 'end')
  assert.equal(escapeAction(key({}), 'half a line'), 'clear', 'as in the field: a draft goes first')
  assert.equal(escapeAction(key({ target: { tagName: 'INPUT' } }), ''), null, 'the field handles its own Esc, and another field keeps its')
  assert.equal(escapeAction(key({ defaultPrevented: true }), ''), null)
  assert.equal(escapeAction(key({ isComposing: true }), ''), null)
  assert.equal(escapeAction(key({ key: 'Enter' }), ''), null)
})

test('the repeats of a key held as the field took the keyboard type nothing; a fresh press lets repeats through again', () => {
  const gate = new RepeatGate()
  assert.equal(gate.pass(true), true, 'a key held in a field the player clicked into still repeats')
  gate.focused()
  for (let i = 0; i < 5; i++) assert.equal(gate.pass(true), false, 'T held past the repeat delay: no t\'s')
  assert.equal(gate.pass(false), true, 'a new key typed')
  assert.equal(gate.pass(true), true, 'and held: it repeats')
  gate.focused()
  assert.equal(gate.pass(true), false, 'a later focus request holds them again')
})

test('the panel keeps its field by those rules: the kept text on focus, blur and send, Esc on the page, mayFocus and the gate', () => {
  const conv = between(LAYER, 'function Conversation(', '\n  return (\n')
  assert.match(LAYER, /onFocus=\{\(\) => keep\.focus\(\)\}/)
  assert.match(LAYER, /onBlur=\{\(\) => keep\.blur\(\)\}/, 'the blur reads the kept text, never a render\'s')
  assert.doesNotMatch(LAYER, /talk\.setDraft\(/, 'every report goes through FieldDraft')
  assert.match(conv, /keep\.sent\(\(\) => \{ if \(family === 'keyboard'\) field\.current\?\.blur\(\) \}, \(\) => document\.activeElement === field\.current\)/, 'emptied before the field lets go')
  assert.match(conv, /document\.addEventListener\('keydown', esc\)/, 'Esc on the page')
  assert.match(conv, /return \(\) => document\.removeEventListener\('keydown', esc\)/, 'let go with the panel')
  assert.match(conv, /const act = escapeAction\(e, keep\.text\)/)
  assert.match(conv, /if \(!mayFocus\(document\.activeElement, \(el\) => panel\.current\?\.contains\(el\) === true\)\) return\n\s+gate\.focused\(\)\n\s+field\.current\?\.focus\(\{ preventScroll: true \}\)/)
  assert.doesNotMatch(conv, /instanceof HTMLCanvasElement/, 'no list of what may hold the focus: only a text field keeps it')
  const onKey = between(conv, 'const onKey = ', '\n  }\n')
  assert.match(onKey, /^const onKey = \(e: ReactKeyboardEvent<HTMLInputElement>\) => \{\n\s+if \(!gate\.pass\(e\.repeat\)\) \{\n\s+e\.preventDefault\(\)\n\s+return\n\s+\}/, 'the gate first, before anything is typed')
  // The field's own Esc is handled and stopped, so the page's listener never sees it twice.
  assert.match(onKey, /e\.preventDefault\(\)\n\s+e\.stopPropagation\(\)\n\s+if \(keep\.text\) type\(''\)\n\s+else talk\.end\('done'\)/)
})

test('the pad hand\'s talk button is what the label, the HUD\'s chip and Done name', () => {
  assert.match(LAYER, /import \{ pageHand \} from '\.\/padNav\.ts'/)
  assert.equal(LAYER.match(/const hand = pageHand\(\)/g)?.length, 2, 'the label and the panel')
  assert.match(LAYER, /glyph\('talk', family, hand\) : ''\n\s+const kind = key && family \? glyphKind\('talk', family, hand\) : 'key'/)
  assert.match(LAYER, /family === 'keyboard' \? 'Esc' : glyph\('talk', family, hand\)/)
  assert.match(LAYER, /glyphKind\('talk', family, hand\)\} \/>\}\n\s+<\/button>/)
  assert.doesNotMatch(LAYER, /glyph(?:Kind)?\('talk', family\)/, 'never the hand-blind glyph')
  assert.match(HUD, /const hand = pageHand\(\)\n\s+const talkGlyph = touch \|\| family === 'touch' \? '' : glyph\('talk', family, hand\)/)
  assert.match(HUD, /kind=\{glyphKind\('talk', family, hand\)\}/)
})

test('the panel stands in places of its own, clear of Sloane\'s chip: under it upright, left of it wide, her chip tucked where no band holds it', () => {
  assert.match(LAYER, /import \{ besideRoom, roomAcross, SHORT, SMALL, WIDE_COLUMN, WIDE_SPACER \} from '\.\/Concierge\.tsx'/, 'not her card\'s places: her card replaces her chip, the panel stands beside it')
  assert.doesNotMatch(LAYER, /CARD_AT\./)
  // Her column only where a wide window has no room right of her chip, and then her chip is tucked.
  assert.match(LAYER, /className=\{!clear \? WIDE_COLUMN : beside && roomy \? PANEL_AT\.wideBeside : PANEL_AT\.wide\}/)
  assert.match(LAYER, /const across = roomAcross\(WIDE_CLEAR_REM, zoom\)/)
  assert.match(LAYER, /const WIDE_CLEAR_REM = 43\n/, '18.5 rem and the frame\'s 1.25 rem to her chip\'s right, a 22 rem column and the frame\'s 1.25 rem')
  const at = between(LAYER, 'const PANEL_AT = {', '} as const')
  const place = (name: string): string => new RegExp(`\\n  ${name}: '([^']*)'`).exec(at)?.[1] ?? ''
  const under = 'max(calc(max(0.75rem,env(safe-area-inset-top))_+_7.5rem),calc(var(--chip-bottom,0px)_+_0.5rem))'
  for (const name of ['tall', 'tallTouch']) {
    assert.ok(place(name).startsWith(`top-[${under}]`), `${name}: under her chip (the first walk's compact rule)`)
    assert.ok(place(name).includes(`_-_${under}_-_`), `${name}: its height under the same top`)
  }
  for (const name of ['tallTucked', 'tallTouchTucked']) assert.ok(place(name).startsWith('top-[max(0.75rem,env(safe-area-inset-top))]'), `${name}: the whole height, her chip tucked`)
  assert.match(place('shortRaised'), /max\(max\(0\.75rem,env\(safe-area-inset-top\)\),calc\(var\(--chip-bottom,0px\)_\+_0\.5rem\)\)\)\]/, 'a short window: under her chip')
  // Above the HUD's chips at the foot (the captions among them) in every compact place.
  for (const name of ['tall', 'tallTouch', 'tallTucked', 'tallTouchTucked', 'short', 'shortRaised', 'shortRaisedTucked']) {
    assert.ok(place(name).includes('calc(var(--hud-foot,0px)_/_var(--ui-zoom,1))'), `${name}: above the HUD's foot`)
    assert.ok(place(name).includes('overflow-y-auto'), `${name}: scrolls only as a last resort`)
  }
  // Wide: left of the column clear of her chip, which stands 1.25 rem in and up to 18 rem wide above the minimap.
  const chipWide = /\n  wide: '([^']*)'/.exec(between(CONCIERGE, 'const CHIP_AT = {', '} as const'))?.[1] ?? ''
  assert.match(chipWide, /left-\[max\(1\.25rem,env\(safe-area-inset-left\)\)\] max-w-\[18rem\]/)
  for (const name of ['wide', 'wideBeside']) assert.ok(place(name).includes('left-[calc(max(1.25rem,env(safe-area-inset-left))_+_18.5rem)]'), `${name}: 0.5 rem right of her widest chip`)
  // Every window length divided by the text size's zoom first (Concierge.tsx's rule for her places).
  const all = at + between(LAYER, 'const PROBE_AT = {', '} as const')
  for (const v of ['touch-top', 'touch-left', 'hud-foot']) {
    const uses = all.match(new RegExp(`var\\(--${v},[^)]*\\)`, 'g')) ?? []
    assert.ok(uses.length > 0, `--${v} is used`)
    assert.equal(all.match(new RegExp(`calc\\(var\\(--${v},[^)]*\\)_/_var\\(--ui-zoom,1\\)\\)`, 'g'))?.length, uses.length, `every --${v} is divided by the zoom`)
  }
  const dvh = all.match(/100dvh/g)?.length ?? 0
  assert.ok(dvh > 0)
  assert.equal(all.split('calc(calc(100dvh_-_var(--keys-height,0px))_/_var(--ui-zoom,1))').length - 1, dvh, 'the viewport less the on-screen keys, divided by the zoom')
  assert.ok(!all.includes('var(--hud-foot-peak'), 'the probe reads the screen alone, so captions coming and going never tuck her chip')
})

test('her chip is tucked (hidden, never unmounted) only while the panel needs it so, and back when it closes', () => {
  const panel = between(LAYER, 'export function TalkPanel(', '\n  return (\n')
  assert.match(panel, /const tucked = open && \(wide \? !clear : \(layout === 'short' && overlay\) \|\| cramped\)/, 'sideways with the touch buttons, a band too short, or a wide window with no room right of her chip')
  assert.match(panel, /useLayoutEffect\(\(\) => \{\n\s+if \(!tucked\) return\n\s+const root = document\.documentElement\n\s+root\.setAttribute\('data-chip-tucked', ''\)\n\s+return \(\) => root\.removeAttribute\('data-chip-tucked'\)\n\s+\}, \[tucked\]\)/, 'before paint, and let go on close or unmount')
  assert.match(panel, /const read = \(\) => setCramped\(el\.offsetHeight < 1\)/)
  assert.match(CSS, /html\[data-chip-tucked\] \[data-concierge-pill\] \{\n\s+visibility: hidden;\n\}/, 'hidden, not display: none or unmounted')
  const chip = between(CONCIERGE, "if (view === 'chip') {", '\n  }\n')
  assert.equal(chip.match(/ref=\{chipRef\}[^>]*data-concierge-pill>/g)?.length, 2, 'both of her pills (asking a name, and her buttons)')
})

test('the panel is a column whose head and field never give way; on a wide screen the HUD\'s captions stand above its head', () => {
  const conv = LAYER.slice(LAYER.indexOf('function Conversation('))
  assert.match(conv, /className=\{`pointer-events-auto \$\{at\} flex flex-col /)
  assert.match(conv, /<div className="flex shrink-0 items-start gap-2 leading-tight">/, 'the name and Done')
  assert.match(conv, /<form onSubmit=\{submit\} className="mt-2 flex shrink-0 items-center gap-2">/, 'the field and Send')
  assert.match(conv, /min-h-0 shrink flex-col gap-1 overflow-y-auto overscroll-contain text-\[13px\] leading-snug`\} data-talk="transcript"/, 'the transcript gives way')
  for (const what of ['status', 'mic']) assert.match(conv, new RegExp(`min-h-0 shrink-\\[\\d\\] overflow-hidden [^\`]*\`\\} data-talk="${what}"`), `the ${what} line gives way`)
  assert.match(conv, /root\.setProperty\('--talk-top', `\$\{Math\.round\(el\.getBoundingClientRect\(\)\.top\)\}px`\)/)
  assert.match(conv, /root\.removeProperty\('--talk-top'\)/)
  assert.match(HUD, /const talking = talk !== undefined && talk\.state !== 'near'/)
  assert.match(HUD, /\$\{talking \? 'bottom-\[min\(calc\(calc\(calc\(100dvh_-_var\(--talk-top,50dvh\)\)_\/_var\(--ui-zoom,1\)\)_-_max\(1\.25rem,env\(safe-area-inset-bottom\)\)_\+_0\.5rem\),calc\(100%_-_2\.5rem\)\)\]' : wideRow > 2/, 'the wide strip 0.5 rem above the panel\'s head, never off the frame')
})
