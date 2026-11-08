// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the accessibility settings and their arithmetic (access.ts): what is
 * kept and read back, what the URL sets for one visit, when high contrast is in force, the console's words, the Menu's
 * toggle and cycle, the colour-vision matrices (a grey through every filter is that grey, the pair a viewer confuses
 * is pulled apart), what is written onto the page's root, and the console's bridge.
 * What breaks if it is removed? A kept setting could read as another, a filter could tint the greys or do nothing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACCESS_DEFAULTS, ACCESS_FIELDS, ACCESS_KEY, CAPTION_PX, CVD_SIM, DALTON_K, IDENTITY, SCALES, accessBridge, accessFromQuery, accessStatus,
  applyAccess, keepAccess, applyMat3, cycleScale, highContrast, loadAccess, nextScale, saveAccess, toggleContrast, visionMatrix, visionWord, withAccess,
  type AccessSettings, type KeyStore, type Mat3,
} from './access.ts'

const store = (init: Record<string, string> = {}): KeyStore & { map: Map<string, string> } => {
  const map = new Map(Object.entries(init))
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}
const near = (a: readonly number[], b: readonly number[], eps = 1e-6): boolean => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps)
const rowSums = (m: Mat3): number[] => [0, 1, 2].map((r) => m[r * 3] + m[r * 3 + 1] + m[r * 3 + 2])

test('kept settings: the defaults without a store or a record, or with anything odd; a record field by field, an unknown value as its default; save then load is the identity', () => {
  assert.equal(loadAccess(null), ACCESS_DEFAULTS)
  assert.equal(loadAccess(store()), ACCESS_DEFAULTS)
  assert.equal(loadAccess(store({ [ACCESS_KEY]: 'not json' })), ACCESS_DEFAULTS)
  assert.equal(loadAccess(store({ [ACCESS_KEY]: JSON.stringify({ v: 2, contrast: 'high' }) })), ACCESS_DEFAULTS, 'another version')
  assert.equal(loadAccess(store({ [ACCESS_KEY]: `{"v":1,"contrast":"high","pad":"${'x'.repeat(300)}"}` })), ACCESS_DEFAULTS, 'too long to be ours')
  assert.deepEqual(
    loadAccess(store({ [ACCESS_KEY]: JSON.stringify({ v: 1, contrast: 'high', vision: 'sepia', scale: 150, captions: 'huge' }) })),
    { ...ACCESS_DEFAULTS, contrast: 'high', scale: 150, captions: 'huge' }, 'an unknown value reads as its default, the rest kept',
  )
  assert.equal(loadAccess(store({ [ACCESS_KEY]: JSON.stringify({ v: 1, scale: 160 }) })).scale, 100, 'a scale off the steps')
  const s = store()
  const next: AccessSettings = { contrast: 'normal', vision: 'tritan', scale: 200, captions: 'large', dwell: true, scan: true, pad: 'left', announce: false }
  assert.deepEqual(loadAccess(store({ [ACCESS_KEY]: JSON.stringify({ v: 1, dwell: 'yes', scan: 1, pad: 'feet', announce: false }) })), { ...ACCESS_DEFAULTS, announce: false }, 'the hands\' fields: booleans and a hand, or the defaults')
  saveAccess(next, s)
  assert.deepEqual(loadAccess(s), next)
  assert.ok(Object.isFrozen(loadAccess(s)))
  assert.deepEqual(JSON.parse(s.map.get(ACCESS_KEY)!), { v: 1, ...next })
  const blocked: KeyStore = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') }, removeItem: () => {} }
  assert.equal(loadAccess(blocked), ACCESS_DEFAULTS)
  assert.doesNotThrow(() => saveAccess(next, blocked))
  assert.doesNotThrow(() => saveAccess(next, null))
})

test('the URL for one visit: each option over the kept settings, ?ui rounded to the nearest step, anything else left as it was (the same object back)', () => {
  const q = (s: string) => new URLSearchParams(s)
  assert.equal(accessFromQuery(q(''), ACCESS_DEFAULTS), ACCESS_DEFAULTS, 'nothing asked: the same object')
  assert.equal(accessFromQuery(q('contrast=loud&vision=x&ui=abc&captions=0'), ACCESS_DEFAULTS), ACCESS_DEFAULTS, "nothing valid (captions=0 is the strip's own switch)")
  assert.deepEqual(accessFromQuery(q('contrast=high&vision=deutan&ui=150&captions=huge')), { ...ACCESS_DEFAULTS, contrast: 'high', vision: 'deutan', scale: 150, captions: 'huge' })
  assert.deepEqual(accessFromQuery(q('dwell=1&scan=on&pad=right&announce=0')), { ...ACCESS_DEFAULTS, dwell: true, scan: true, pad: 'right', announce: false })
  assert.deepEqual(accessFromQuery(q('dwell=maybe&pad=feet&announce='), ACCESS_DEFAULTS), ACCESS_DEFAULTS, 'words that are neither on nor off, and a hand that is not one, change nothing')
  assert.deepEqual(accessFromQuery(q('dwell=0&scan=false'), { ...ACCESS_DEFAULTS, dwell: true, scan: true }), ACCESS_DEFAULTS, 'off over a kept on')
  assert.ok(Object.isFrozen(accessFromQuery(q('ui=125'))))
  assert.equal(accessFromQuery(q('ui=140')).scale, 150)
  assert.equal(accessFromQuery(q('ui=112')).scale, 100)
  assert.equal(accessFromQuery(q('ui=112.5')).scale, 100, 'a tie goes to the smaller step')
  assert.equal(accessFromQuery(q('ui=900')).scale, 200)
  assert.equal(accessFromQuery(q('ui=0')).scale, 100)
  assert.equal(accessFromQuery(q('ui='), { ...ACCESS_DEFAULTS, scale: 150 }).scale, 150, 'an empty number is none: the kept size holds')
  assert.equal(accessFromQuery(q('ui=%20'), { ...ACCESS_DEFAULTS, scale: 150 }).scale, 150, 'a blank number is none too')
  const kept: AccessSettings = { ...ACCESS_DEFAULTS, contrast: 'normal', vision: 'protan', scale: 125, captions: 'large' }
  assert.deepEqual(accessFromQuery(q('vision=none'), kept), { ...kept, vision: 'none' }, 'one option over the kept ones')
  assert.equal(accessFromQuery(q('vision=protan'), kept), kept, 'the kept value asked again: the same object')
})

test("high contrast: the setting, or the system's switch under auto; the Menu's toggle turns off whichever is on; the scale cycles round from the top", () => {
  assert.equal(highContrast(ACCESS_DEFAULTS, false), false)
  assert.equal(highContrast(ACCESS_DEFAULTS, true), true)
  assert.equal(highContrast({ ...ACCESS_DEFAULTS, contrast: 'normal' }, true), false, 'normal overrides the system')
  assert.equal(highContrast({ ...ACCESS_DEFAULTS, contrast: 'high' }, false), true)
  assert.equal(toggleContrast(ACCESS_DEFAULTS, true).contrast, 'normal', 'on by the system: the toggle turns it off')
  assert.equal(toggleContrast(ACCESS_DEFAULTS, false).contrast, 'high')
  assert.equal(toggleContrast({ ...ACCESS_DEFAULTS, contrast: 'high' }, false).contrast, 'normal')
  assert.equal(toggleContrast({ ...ACCESS_DEFAULTS, contrast: 'normal' }, true).contrast, 'high')
  assert.ok(Object.isFrozen(toggleContrast(ACCESS_DEFAULTS, false)))
  assert.deepEqual(SCALES, [100, 125, 150, 175, 200])
  assert.equal(nextScale(100), 125)
  assert.equal(nextScale(200), 100, 'round again from the top')
  let s = ACCESS_DEFAULTS
  const seen: number[] = []
  for (let i = 0; i < SCALES.length; i++) {
    s = cycleScale(s)
    seen.push(s.scale)
  }
  assert.deepEqual(seen, [125, 150, 175, 200, 100])
  assert.ok(Object.isFrozen(s))
  assert.equal(s.vision, ACCESS_DEFAULTS.vision, 'the other fields ride along')
})

test("withAccess: each field from the console's words, case, blanks and a trailing % forgiven; a bad value or field is the error line and nothing else", () => {
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, 'contrast', 'HIGH'), { ...ACCESS_DEFAULTS, contrast: 'high' })
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, 'vision', 'tritan'), { ...ACCESS_DEFAULTS, vision: 'tritan' })
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, 'text', '175%'), { ...ACCESS_DEFAULTS, scale: 175 })
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, ' Captions ', 'large'), { ...ACCESS_DEFAULTS, captions: 'large' })
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, 'contrast', 'auto'), ACCESS_DEFAULTS)
  assert.ok(Object.isFrozen(withAccess(ACCESS_DEFAULTS, 'text', '125')))
  assert.equal(withAccess(ACCESS_DEFAULTS, 'contrast', 'loud'), 'access: contrast is one of auto, high, normal')
  assert.equal(withAccess(ACCESS_DEFAULTS, 'vision', 'sepia'), 'access: vision is one of none, protan, deutan, tritan')
  assert.equal(withAccess(ACCESS_DEFAULTS, 'text', '160'), 'access: text is one of 100, 125, 150, 175, 200 (percent)')
  assert.equal(withAccess(ACCESS_DEFAULTS, 'text', ''), 'access: text is one of 100, 125, 150, 175, 200 (percent)', 'an empty number is not 0')
  assert.equal(withAccess(ACCESS_DEFAULTS, 'captions', 'big'), 'access: captions is one of normal, large, huge')
  assert.equal(withAccess(ACCESS_DEFAULTS, 'font', '12'), "access: nothing to set called 'font': contrast, vision, text, captions, dwell, scan, pad, announce")
  assert.deepEqual([...ACCESS_FIELDS], ['contrast', 'vision', 'text', 'captions', 'dwell', 'scan', 'pad', 'announce'])
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, 'dwell', 'ON'), { ...ACCESS_DEFAULTS, dwell: true })
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, 'scan', '1'), { ...ACCESS_DEFAULTS, scan: true })
  assert.deepEqual(withAccess({ ...ACCESS_DEFAULTS, announce: true }, 'announce', 'off'), { ...ACCESS_DEFAULTS, announce: false })
  assert.deepEqual(withAccess(ACCESS_DEFAULTS, 'pad', 'Left'), { ...ACCESS_DEFAULTS, pad: 'left' })
  assert.equal(withAccess(ACCESS_DEFAULTS, 'dwell', 'maybe'), 'access: dwell is on or off')
  assert.equal(withAccess(ACCESS_DEFAULTS, 'pad', 'feet'), 'access: pad is one of both, left, right')
})

test('the colour-vision matrices: every simulation row sums to one; the filter is the identity for none and I + K(I − M) otherwise, so a grey passes unchanged; red keeps its red and gains green and blue for a protan or deutan viewer, blue keeps its blue and gains red and green for a tritan; the words name the viewer', () => {
  assert.equal(visionMatrix('none'), IDENTITY)
  assert.deepEqual([...IDENTITY], [1, 0, 0, 0, 1, 0, 0, 0, 1])
  assert.deepEqual([...DALTON_K.protan], [0, 0, 0, 0.7, 1, 0, 0.7, 0, 1])
  assert.equal(DALTON_K.deutan, DALTON_K.protan, 'the same shift for the two red-green viewers')
  assert.deepEqual([...DALTON_K.tritan], [1, 0, 0.7, 0, 1, 0.7, 0, 0, 0])
  for (const v of ['protan', 'deutan', 'tritan'] as const) {
    assert.ok(near(rowSums(CVD_SIM[v]), [1, 1, 1], 1e-5), `${v}: a grey is simulated as that grey`)
    const t = visionMatrix(v)
    assert.notEqual(t, IDENTITY)
    assert.ok(near(rowSums(t), [1, 1, 1], 1e-5), `${v}: the filter keeps every grey`)
    assert.ok(near(applyMat3(t, [0.5, 0.5, 0.5]), [0.5, 0.5, 0.5], 1e-5))
    assert.ok(near(applyMat3(t, [0, 0, 0]), [0, 0, 0]))
    // By hand, element by element: T = I + K·(I − M).
    const m = CVD_SIM[v], k = DALTON_K[v]
    const d = IDENTITY.map((x, i) => x - m[i])
    const expected = IDENTITY.map((x, i) => {
      const r = Math.floor(i / 3), c = i % 3
      return x + k[r * 3] * d[c] + k[r * 3 + 1] * d[3 + c] + k[r * 3 + 2] * d[6 + c]
    })
    assert.ok(near(t, expected), `${v}: the filter is the formula`)
    assert.match(visionWord(v), new RegExp(`^${v} \\(`))
  }
  for (const v of ['protan', 'deutan'] as const) {
    const out = applyMat3(visionMatrix(v), [1, 0, 0])
    assert.ok(Math.abs(out[0] - 1) < 1e-6, `${v}: red kept (the shift's first row is zero)`)
    assert.ok(out[1] > 0.1 && out[2] > 0.1, `${v}: red gains green and blue: ${out.join(', ')}`)
    const green = applyMat3(visionMatrix(v), [0, 1, 0])
    assert.ok(green[1] < 0.95 && green[0] < 1e-6, `${v}: green is pulled the other way: ${green.join(', ')}`)
  }
  const blue = applyMat3(visionMatrix('tritan'), [0, 0, 1])
  assert.ok(Math.abs(blue[2] - 1) < 1e-6, 'tritan: blue kept')
  assert.ok(blue[0] > 0.1 && blue[1] > 0.1, `tritan: blue gains red and green: ${blue.join(', ')}`)
  const yellow = applyMat3(visionMatrix('tritan'), [1, 1, 0])
  assert.ok(yellow[0] < 0.9 && yellow[1] < 0.9 && Math.abs(yellow[2]) < 1e-6, `tritan: yellow is pulled the other way: ${yellow.join(', ')}`)
  assert.equal(visionWord('none'), "none (the camera's colours)")
})

test('applyAccess writes data-contrast and --ui-zoom onto the root; the status lines; the bridge reads and writes through, hands back the field\'s line or the error, and the defaults', () => {
  const root = { dataset: {} as { contrast?: string; pad?: string }, style: { vars: {} as Record<string, string>, setProperty(n: string, v: string) { this.vars[n] = v } } }
  applyAccess(ACCESS_DEFAULTS, false, root)
  assert.equal(root.dataset.contrast, 'normal')
  assert.equal(root.style.vars['--ui-zoom'], '1')
  applyAccess({ ...ACCESS_DEFAULTS, scale: 150 }, true, root)
  assert.equal(root.dataset.contrast, 'high')
  assert.equal(root.style.vars['--ui-zoom'], '1.5')
  assert.equal(root.dataset.pad, 'both')
  applyAccess({ ...ACCESS_DEFAULTS, contrast: 'normal', scale: 125, pad: 'left' }, true, root)
  assert.equal(root.dataset.contrast, 'normal')
  assert.equal(root.style.vars['--ui-zoom'], '1.25')
  assert.equal(root.dataset.pad, 'left', 'the hand the ways out of a stopped city read')

  const lines = accessStatus({ ...ACCESS_DEFAULTS, vision: 'deutan', scale: 175, captions: 'huge', pad: 'left' }, true)
  assert.equal(lines.length, 9)
  assert.match(lines[0], /^contrast {2}auto \(the system asks for more: high\) {2}\(access contrast auto\|high\|normal\)$/)
  assert.match(lines[1], /^vision {4}deutan \(green weak or blind\)/)
  assert.match(lines[2], /^text {6}175 % {2}\(access text 100\|125\|150\|175\|200\)$/)
  assert.match(lines[3], /^captions {2}huge, 24 px/)
  assert.match(lines[4], /^dwell {5}off {2}\(access dwell on\|off\)$/)
  assert.match(lines[5], /^scan {6}off {2}\(access scan on\|off\)$/)
  assert.match(lines[6], /^pad {7}left hand: its stick moves, with L1 held it looks; select runs, start pings {2}\(access pad both\|left\|right\)$/)
  assert.match(lines[7], /^announce {2}on: the district, a vehicle beside you, a seat and the toasts are read {2}\(access announce on\|off\)$/)
  assert.ok(lines[8].includes(ACCESS_KEY) && lines[8].includes('?contrast= ?vision= ?ui= ?captions= ?dwell= ?scan= ?pad= ?announce='))
  assert.match(accessStatus({ ...ACCESS_DEFAULTS, dwell: true, scan: true, pad: 'right', announce: false }, false).slice(4, 8).join('\n'), /^dwell {5}on: a pointer resting[^\n]*\nscan {6}on: the controls are offered[^\n]*\npad {7}right hand: its stick moves, with R1 held[^\n]*\nannounce {2}off/)
  assert.match(accessStatus(ACCESS_DEFAULTS, false)[0], /^contrast {2}auto \(the system asks for no more: normal\)/)
  assert.doesNotMatch(accessStatus({ ...ACCESS_DEFAULTS, contrast: 'high' }, false)[0], /the system/, 'a set contrast says nothing of the system')
  assert.deepEqual(CAPTION_PX, { normal: 13, large: 18, huge: 24 })

  let held: AccessSettings = ACCESS_DEFAULTS
  const writes: AccessSettings[] = []
  const wholes: boolean[] = []
  let note: string | null = null
  const b = accessBridge(() => held, () => false, (n, whole) => { held = n; writes.push(n); wholes.push(whole === true) }, () => note)
  assert.ok(Object.isFrozen(b))
  assert.deepEqual(b.status(), accessStatus(ACCESS_DEFAULTS, false))
  assert.deepEqual(b.set('vision', 'protan'), { line: accessStatus({ ...ACCESS_DEFAULTS, vision: 'protan' }, false)[1] })
  assert.equal(held.vision, 'protan')
  assert.deepEqual(b.set('text', '300'), { error: 'access: text is one of 100, 125, 150, 175, 200 (percent)' })
  assert.equal(writes.length, 1, 'an error writes nothing')
  assert.deepEqual(b.set(' TEXT ', '125'), { line: accessStatus({ ...ACCESS_DEFAULTS, vision: 'protan', scale: 125 }, false)[2] })
  assert.equal(held.scale, 125)
  assert.deepEqual(b.set('pad', 'right'), { line: accessStatus({ ...ACCESS_DEFAULTS, vision: 'protan', scale: 125, pad: 'right' }, false)[6] }, 'the later fields find their own line')
  assert.equal(held.pad, 'right')
  note = 'needs the post-processing chain, which ?post=0 turned off'
  assert.match(b.status()[1], /^vision {4}protan[^\n]*, but not drawn now: it needs the post-processing chain, which \?post=0 turned off {2}\(access vision/, 'a filter the chain cannot draw says so')
  assert.match(b.reset(), /^access: the defaults/)
  assert.equal(held, ACCESS_DEFAULTS)
  assert.equal(writes.length, 4)
  assert.deepEqual(wholes, [false, false, false, true], 'a reset is kept whole; a change only by its field')
  assert.doesNotMatch(b.status()[1], /not drawn/, 'no filter, nothing to say')
})

test('a change keeps only the fields it changes: a setting the URL gave for one visit is not written down by a later switch', () => {
  const kept: AccessSettings = { ...ACCESS_DEFAULTS, scale: 150 }
  const live = accessFromQuery(new URLSearchParams('?ui=200&vision=deutan'), kept)
  assert.equal(live.scale, 200)
  const next = { ...live, contrast: 'high' as const }
  assert.deepEqual(keepAccess(kept, live, next), { ...kept, contrast: 'high' }, 'the contrast is kept; the visit\'s text size and filter are not')
  assert.deepEqual(keepAccess(kept, live, { ...live, scale: 125 }), { ...kept, scale: 125 }, 'a field set again is kept, whatever the URL said')
  assert.deepEqual(keepAccess(kept, live, live), kept, 'nothing changed, nothing new kept')
})
