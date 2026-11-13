// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how the operator's steering (features.ts) reaches a model: every provider renders
 * the system prompt through the one builder, with the request's steering lines, and the operator tier is the only
 * place that puts them on a request (gatedAsk, from the steering the tier holds). A provider that built its own prompt,
 * or dropped the lines, would steer nothing and show nothing in Node.
 * What breaks if it is removed? A provider could stop passing the lines and only a live model would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('every provider renders the prompt through systemFor, which hands the request\'s steering to systemPrompt, and nothing else builds one', () => {
  const sites: [string, number][] = [['./localCompute.ts', 1], ['./router.ts', 3], ['./inPage.ts', 1]]
  for (const [file, n] of sites) {
    const src = read(file)
    assert.equal(src.match(/systemFor\(req\)/g)?.length ?? 0, n, `${file}: ${n} call(s) through the one builder`)
    // No provider builds its own (one that forgot the lines would steer nothing).
    assert.equal(src.match(/systemPrompt\(req\./g)?.length ?? 0, file === './localCompute.ts' ? 1 : 0, `${file}: no call of its own`)
  }
  const local = read('./localCompute.ts')
  // A conversation (AnswerRequest.talk) carries no steering; every other request is rendered with it.
  assert.match(local, /^export function systemFor\(req: Pick<MindRequest, 'tethers' \| 'memories' \| 'context' \| 'steering' \| 'talk'>\): string \{\n {2}return req\.talk === true \? TALK_PROMPT : systemPrompt\(req\.tethers, req\.memories, req\.context, req\.steering\)\n\}$/m)
  assert.match(local, /^export function systemPrompt\(tethers: readonly GateTether\[\], memories: readonly Memories\[\] = \[\], context: readonly AgentContext\[\] = \[\], steering: readonly string\[\] = \[\]\): string \{$/m)
})

test('the operator tier alone puts steering on a request, from the steering it holds, and only when there is some', () => {
  const op = read('../07_Execute_Actions/operator.ts')
  assert.match(op, /^ {2}steering\?: readonly string\[\]$/m, 'AnswerRequest.steering')
  assert.match(op, /\.\.\.\(steering && steering\.length > 0 \? \{ steering \} : \{\}\)/, 'absent when nothing is steered: the prompt hash is then as it was')
  assert.match(op, /gatedAsk\(gate, mind, skills, words, diary, awareness, steeringLines\(steering\)\)/)
  assert.equal(op.match(/steeringLines\(/g)?.length, 2, 'the request and the console\'s `feature prompt`, nothing else')
  // The knobs a bias leans on go through the same facade as `set`: the engine validates and clamps them again.
  assert.match(op, /const setKnob = \(table: 'physics' \| 'shaders', key: string, value: number\): number =>/)
  assert.match(op, /return setKnob\(table, key, value\)/)
  assert.match(op, /setKnob\(e\.table, e\.key, e\.value\)/)
  // Steering reaches nothing of the laws: the inspector reads the snapshot through the facade and writes knobs through it.
  // The inspector's code (the comments may name what is out of reach; the code must not), up to the next tier.
  const features = op.slice(op.indexOf('const features = Object.freeze({'), op.indexOf('  return Object.freeze({\n    unlock:')).replace(/^\s*\/\/.*$/gm, '')
  assert.ok(features.length > 100)
  assert.doesNotMatch(features, /laws|bouncer|sanctuary|blindSensing|sim\.kernel|ring0\.ts/i)
  assert.match(features, /if \(!unlocked\) throw locked\('feature'\)/g)
  assert.equal(features.match(/if \(!unlocked\) throw locked\('feature'\)/g)?.length, 4, 'steer, clamp, release, reset')
})
