// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
// Run with: node tools/ebook/v2-gate.mjs
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const html = readFileSync(new URL('../../crimson-noir-script-mastery-ebook-v2.html', import.meta.url), 'utf8')
const engine = html.match(/<script>(var NoirScriptEngine = \(\(\) => \{[\s\S]*?\n\}\)\(\);)/)?.[1]
const labJson = html.match(/const LABS=(\[.*\]);/)?.[1]
const hostCode = html.match(/function makeMockCityHost\(\{ elite = false, exam = true \} = \{\}\) \{[\s\S]*?\n\}\n\n(?=const \$=)/)?.[0]
assert.ok(engine && labJson && hostCode, 'embedded engine, lab catalogue and simulated host must be extractable')
const labs = JSON.parse(labJson)
const context = vm.createContext({})
vm.runInContext(engine + '\n' + hostCode + '\nthis.makeHost = makeMockCityHost;', context)
const NS = context.NoirScriptEngine
assert.equal(labs.length, 20)
assert.equal(new Set(labs.map(l => l.id)).size, 20)
for (const lab of labs) {
  const budget = lab.budgetMode === 'lane' ? NS.LANE_LIMITS : lab.budgetMode === 'elite' ? NS.ELITE_LIMITS : NS.LIMITS
  const session = new NS.NoirSession(budget, lab.budgetMode === 'lane' ? { tableRoom: true } : undefined)
  const result = session.run(lab.code, context.makeHost({ elite: lab.budgetMode === 'elite', exam: true }), budget)
  assert.equal(result.error, undefined, lab.id + ': ' + result.error)
  assert.equal(result.fault, undefined, lab.id + ': ' + result.fault)
  if (['lab-12c', 'lab-12e', 'lab-12f'].includes(lab.id)) assert.ok(result.steps < 4096, lab.id + ' exceeded lane budget')
  console.log(`${lab.id}: PASS ${result.steps}/${budget.steps} steps (${(100 * result.steps / budget.steps).toFixed(2)}%)`)
}

// Tail padding is not a row: compare SIMD box count with a separate scalar count on varying host lengths.
const spatial = labs.find(l => l.id === 'lab-12f').code
for (const n of [0, 1, 2, 3, 4, 5, 7, 63, 64, 65]) {
  const base = context.makeHost().tables()
  const x = Float32Array.from({ length: n }, (_, i) => (i * 37 % 320) - 159.5)
  const z = Float32Array.from({ length: n }, (_, i) => (i * 53 % 320) - 160.25)
  const expected = Array.from(x).filter((v, i) => v >= -80 && v < 80 && z[i] >= -80 && z[i] < 80).length
  const host = { tables: () => ({ ...base, crowd: { n, x, z } }) }
  const result = new NS.NoirSession(NS.LANE_LIMITS, { tableRoom: true }).run(spatial, host, NS.LANE_LIMITS)
  assert.equal(result.error, undefined, `length ${n}: ${result.error}`)
  assert.equal(result.fault, undefined)
  assert.ok(result.out.includes(`crowd_in_box: ${expected} cars_above_5: 10`), `length ${n} output: ${result.out}`)
}
// The sample uses abstract bit positions, not the live application's authority checks.
const gate = labs.find(l => l.id === 'lab-12e').code
for (const asked of [0, 1, 5, 15, 16, 32, 128, 240, 256, 511]) for (const held of [0, 1, 5, 15, 255]) {
  const code = gate.replace('let held: u32 = 5u;', `let held: u32 = ${held}u;`).replace('let asked: u32 = 37u;', `let asked: u32 = ${asked}u;`)
  const result = new NS.NoirSession(NS.LANE_LIMITS, { tableRoom: true }).run(code, context.makeHost(), NS.LANE_LIMITS)
  assert.equal(result.error, undefined)
  const expected = ((asked & (~held >>> 0)) === 0 && (asked & 240) === 0 && (asked & (~255 >>> 0)) === 0)
  assert.ok(result.out.some(line => line.endsWith('allowed: ' + expected)), `asked=${asked}, held=${held}, out=${result.out}`)
}
const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1])
const appScripts = scripts.filter((_, i) => i !== 5 && i !== 6)
const ids = new Set([...html.matchAll(/\bid=["']([^"']+)["']/g)].map(m => m[1]))
const refs = new Set()
for (const code of appScripts) {
  for (const match of code.matchAll(/(?:getElementById|byId|\bid|listen)\(\s*['"]([\w-]+)['"]\s*[,)]|(?:\$|querySelector)\(\s*['"]#([\w-]+)['"]/g)) refs.add(match[1] || match[2])
}
const missing = [...refs].filter(id => !ids.has(id))
assert.deepEqual(missing, [], 'literal DOM ID references')
for (const dynamic of ['cache-mode-soa', 'cache-mode-aos', 'mha-head-0', 'mha-head-1', 'sky-ghost', 'sky-rain']) assert.ok(ids.has(dynamic))
assert.equal(appScripts.join('\n').match(/search\.addEventListener\('input'/g)?.length, 1, 'one search input listener')
assert.ok(!/\.app-shell\s*,\s*@media/.test(html), 'no media at-rule in the companion selector')
assert.ok(html.includes("default-src 'none'") && html.includes("connect-src 'none'"))
assert.ok(html.includes('SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary'))
assert.ok(html.includes('Copyright (c) 2013-2020 Khan Academy and other contributors'))
const readable = html.split('<script>var NoirScriptEngine')[0]
assert.ok(!/(?<![\w])NoirScript(?![\w])/.test(readable), 'no legacy standalone branding in body')
console.log(`20/20 labs passed; SIMD tails and capability samples passed; ${refs.size} literal and 6 dynamic ID references resolved; one search listener; offline CSP and notices present.`)
