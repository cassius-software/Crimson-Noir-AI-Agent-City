// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { NoirSession as SourceSession, INTRINSIC_NAMES } from '../../src/07_Execute_Actions/terminal/noirscript/index.ts'

const html = readFileSync(new URL('../../crimson-noir-script-mastery-ebook.html', import.meta.url), 'utf8')
const script = html.match(/<script>(var NoirScriptEngine = \(\(\) => \{[\s\S]*?\n\}\)\(\);)/)
assert.ok(script, 'embedded engine script exists')
const context = vm.createContext({})
vm.runInContext(script[1], context)
const EmbeddedSession = context.NoirScriptEngine.NoirSession
const labsMatch = html.match(/const LABS=(\[.*\]);/)
assert.ok(labsMatch, 'embedded lab catalogue exists')
const labs = JSON.parse(labsMatch[1])
const plain = (v) => JSON.parse(JSON.stringify(v))

function compare(program) {
  const source = new SourceSession()
  const embedded = new EmbeddedSession()
  const a = plain(source.run(program))
  const b = plain(embedded.run(program))
  assert.deepEqual(b, a)
  return a
}

test('vector operations agree with source and the corrected reference', () => {
  assert.ok(!INTRINSIC_NAMES.includes('dot'))
  assert.match(compare('print(dot(f32x4(1.0,2.0,3.0,4.0),f32x4(1.0,1.0,1.0,1.0)));').error, /unknown fn 'dot'/)
  const sum = compare('print(hsum(f32x4(1.0,2.0,3.0,4.0)*f32x4(1.0,1.0,1.0,1.0)));')
  assert.deepEqual(sum.out, ['10'])
  assert.match(compare('let v=f32x4(1.0,2.0,3.0,4.0);print(v * 2.0);').error, /type mismatch/)
  assert.match(compare('let v=f32x4(1.0,2.0,3.0,4.0);print(v == v);').error, /not defined on f32x4/)
  assert.deepEqual(compare('let v=f32x4(1.0,2.0,3.0,4.0);print(all(veq(v,v)));').out, ['true'])
})

test('runtime faults do not roll back previous global mutations', () => {
  for (const Session of [SourceSession, EmbeddedSession]) {
    const s = new Session()
    assert.equal(s.run('let mut x=0;').error, undefined)
    assert.equal(s.run('x=7; let a=[1,2]; print(a[5]);').fault, 'bounds')
    assert.deepEqual(plain(s.run('print(x);').out), ['7'])
  }
})

test('finite approximate attention has nonzero future probabilities', () => {
  const lab = labs.find(l => l.id === 'lab-07')
  assert.ok(lab)
  const a = plain(new SourceSession().run(lab.code))
  const b = plain(new EmbeddedSession().run(lab.code))
  assert.deepEqual(b, a)
  assert.equal(a.error, undefined)
  assert.equal(a.steps, 1019)
  const probabilities = a.out.find(x => x.startsWith('causal_probs_pos1:'))
  assert.match(probabilities, /9\.969312e-10/)
})

test('included edition and notices remain present', () => {
  assert.equal(labs.length, 18)
  assert.ok(html.includes('Copyright (c) 2013-2020 Khan Academy and other contributors'))
  assert.ok(html.includes('Copyright (c) 2018 Khan Academy'))
  assert.ok(html.includes('Copyright (c) 2026 Julian Cassius Subban'))
  assert.ok(html.includes('Public availability does not grant permission'))
})
