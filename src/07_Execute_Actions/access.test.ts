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
  applyAccess, applyMat3, cycleScale, highContrast, loadAccess, nextScale, saveAccess, toggleContrast, visionMatrix, visionWord, withAccess,
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
    { contrast: 'high', vision: 'none', scale: 150, captions: 'huge' }, 'an unknown value reads as its default, the rest kept',
  )
  assert.equal(loadAccess(store({ [ACCESS_KEY]: JSON.stringify({ v: 1, scale: 160 }) })).scale, 100, 'a scale off the steps')
  const s = store()
  const next: AccessSettings = { contrast: 'normal', vision: 'tritan', scale: 200, captions: 'large' }
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
  assert.deepEqual(accessFromQuery(q('contrast=high&vision=deutan&ui=150&captions=huge')), { contrast: 'high', vision: 'deutan', scale: 150, captions: 'huge' })
  assert.ok(Object.isFrozen(accessFromQuery(q('ui=125'))))
  assert.equal(accessFromQuery(q('ui=140')).scale, 150)
  assert.equal(accessFromQuery(q('ui=112')).scale, 100)
  assert.equal(accessFromQuery(q('ui=112.5')).scale, 100, 'a tie goes to the smaller step')
  assert.equal(accessFromQuery(q('ui=900')).scale, 200)
  assert.equal(accessFromQuery(q('ui=0')).scale, 100)
  assert.equal(accessFromQuery(q('ui=')).scale, 100, 'an empty number is none')
  const kept: AccessSettings = { contrast: 'normal', vision: 'protan', scale: 125, captions: 'large' }
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
  assert.equal(withAccess(ACCESS_DEFAULTS, 'font', '12'), "access: nothing to set called 'font': contrast, vision, text, captions")
  assert.deepEqual([...ACCESS_FIELDS], ['contrast', 'vision', 'text', 'captions'])
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
  const root = { dataset: {} as { contrast?: string }, style: { vars: {} as Record<string, string>, setProperty(n: string, v: string) { this.vars[n] = v } } }
  applyAccess(ACCESS_DEFAULTS, false, root)
  assert.equal(root.dataset.contrast, 'normal')
  assert.equal(root.style.vars['--ui-zoom'], '1')
  applyAccess({ ...ACCESS_DEFAULTS, scale: 150 }, true, root)
  assert.equal(root.dataset.contrast, 'high')
  assert.equal(root.style.vars['--ui-zoom'], '1.5')
  applyAccess({ ...ACCESS_DEFAULTS, contrast: 'normal', scale: 125 }, true, root)
  assert.equal(root.dataset.contrast, 'normal')
  assert.equal(root.style.vars['--ui-zoom'], '1.25')

  const lines = accessStatus({ contrast: 'auto', vision: 'deutan', scale: 175, captions: 'huge' }, true)
  assert.equal(lines.length, 5)
  assert.match(lines[0], /^contrast {2}auto \(the system asks for more: high\) {2}\(access contrast auto\|high\|normal\)$/)
  assert.match(lines[1], /^vision {4}deutan \(green weak or blind\)/)
  assert.match(lines[2], /^text {6}175 % {2}\(access text 100\|125\|150\|175\|200\)$/)
  assert.match(lines[3], /^captions {2}huge, 24 px/)
  assert.ok(lines[4].includes(ACCESS_KEY) && lines[4].includes('?contrast= ?vision= ?ui= ?captions='))
  assert.match(accessStatus(ACCESS_DEFAULTS, false)[0], /^contrast {2}auto \(the system asks for no more: normal\)/)
  assert.doesNotMatch(accessStatus({ ...ACCESS_DEFAULTS, contrast: 'high' }, false)[0], /the system/, 'a set contrast says nothing of the system')
  assert.deepEqual(CAPTION_PX, { normal: 13, large: 18, huge: 24 })

  let held: AccessSettings = ACCESS_DEFAULTS
  const writes: AccessSettings[] = []
  const b = accessBridge(() => held, () => false, (n) => { held = n; writes.push(n) })
  assert.ok(Object.isFrozen(b))
  assert.deepEqual(b.status(), accessStatus(ACCESS_DEFAULTS, false))
  assert.deepEqual(b.set('vision', 'protan'), { line: accessStatus({ ...ACCESS_DEFAULTS, vision: 'protan' }, false)[1] })
  assert.equal(held.vision, 'protan')
  assert.deepEqual(b.set('text', '300'), { error: 'access: text is one of 100, 125, 150, 175, 200 (percent)' })
  assert.equal(writes.length, 1, 'an error writes nothing')
  assert.deepEqual(b.set(' TEXT ', '125'), { line: accessStatus({ ...ACCESS_DEFAULTS, vision: 'protan', scale: 125 }, false)[2] })
  assert.equal(held.scale, 125)
  assert.match(b.reset(), /^access: the defaults/)
  assert.equal(held, ACCESS_DEFAULTS)
  assert.equal(writes.length, 3)
})
