// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the scripted fallback: a mind that answers is left alone; a backend
 * that is offline or refused gets the script, built from the request's own context, streamed as one piece with the
 * reason 'scripted'; any other failure is still reported; the script is deterministic and plain; and the stand-in never ends
 * with a city action line (06_Make_Decisions/actions.ts), whatever the prompt asks for.
 * What breaks if it is removed? A silent city, or a script that hides a real error, would ship unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Answer, AnswerRequest, Mind, Piece } from '../07_Execute_Actions/operator.ts'
import { CognitionError } from './localCompute.ts'
import { SCRIPTED, scriptStandsIn, scriptedAnswer, withScriptedFallback } from './scripted.ts'

const req = (over: Partial<AnswerRequest> = {}): AnswerRequest => ({ tethers: [{ agent: 17, serial: 1, skills: ['Rust'] }], prompt: 'Where is the lake?', signal: new AbortController().signal, ...over })

function mind(answer: (req: AnswerRequest, onPiece: (p: Piece) => void) => Promise<Answer>): Mind {
  return {
    settings: () => ({ server: 'http://localhost:8089', model: 'm', provider: 'claude' }),
    setServer: (u) => u, setModel: (n) => n, installed: async () => ['m'], answer,
  }
}

test('the script speaks from the context: where they stand, the last moment, the question, the skills; the same request, the same words', () => {
  const r = req({ context: [{ agent: 17, surroundings: 'Standing near The Spire in Lakefront Metro at 17:02.', recent: [{ who: 'the player', what: 'asked "hi" and you answered "hello there"', where: 'Lakefront Metro', at: 1, clock: '17:01' }] }] })
  const a = scriptedAnswer(r)
  assert.equal(a, scriptedAnswer(r))
  assert.match(a, /^I'm standing near The Spire in Lakefront Metro at 17:02\./)
  assert.match(a, /A moment ago the player asked me "hi" and I said "hello there"\./)
  assert.match(a, /You ask about "Where is the lake"\./)
  assert.match(a, /I can help with Rust; that is what I know\./)
  assert.doesNotMatch(a, /\n/, 'plain text, one paragraph')
  assert.equal(scriptedAnswer(req({ tethers: [] })), 'Nobody is here to answer.')
  assert.match(scriptedAnswer(req({ tethers: [{ agent: 1, serial: 1, skills: ['Go'] }, { agent: 2, serial: 2, skills: ['Rust'] }] })), /There are 2 of us here with you/)
})

test('a mind that answers is left alone; offline or refused gets the script as one piece with reason scripted and no tokens; other failures still throw', async () => {
  const fine = withScriptedFallback(mind(async (_r, on) => { on({ kind: 'text', text: 'real' }); return { text: 'real', thinking: 0, tokens: 3, reason: 'stop' } }))
  const got: Piece[] = []
  assert.deepEqual(await fine.answer(req(), (p) => got.push(p)), { text: 'real', thinking: 0, tokens: 3, reason: 'stop' })
  assert.equal(fine.scripted, 0)
  assert.equal(fine.settings().scripted, undefined)

  const down = withScriptedFallback(mind(async () => { throw new CognitionError('offline', 'nothing listening') }))
  const pieces: Piece[] = []
  const a = await down.answer(req(), (p) => pieces.push(p))
  assert.equal(a.reason, SCRIPTED)
  assert.equal(a.tokens, 0)
  assert.equal(pieces.length, 1)
  assert.equal(pieces[0].text, a.text)
  assert.equal(down.scripted, 1)
  assert.match(down.settings().scripted ?? '', /^1 answer came from the script/)
  await down.answer(req(), () => {})
  assert.match(down.settings().scripted ?? '', /^2 answers came/)

  const refused = withScriptedFallback(mind(async () => { throw new CognitionError('refused', 'no') }))
  assert.equal((await refused.answer(req(), () => {})).reason, SCRIPTED)

  const broken = withScriptedFallback(mind(async () => { throw new CognitionError('server', 'boom') }))
  await assert.rejects(broken.answer(req(), () => {}), /boom/)
  const other = withScriptedFallback(mind(async () => { throw new TypeError('bad') }))
  await assert.rejects(other.answer(req(), () => {}), TypeError)
  assert.equal(scriptStandsIn(new CognitionError('offline', 'x')), true)
  assert.equal(scriptStandsIn(new CognitionError('model', 'x')), false)
  assert.equal(scriptStandsIn(new Error('offline')), false)
})

test('the script standing in for a model never proposes a city action, whatever the prompt asks for (the chosen scripted provider does: router.test.ts)', async () => {
  const down = withScriptedFallback(mind(async () => { throw new CognitionError('offline', 'nothing listening') }))
  for (const prompt of ['make it night', 'thin the crowd', 'rain on please', 'lowest quality please']) {
    const pieces: Piece[] = []
    const a = await down.answer(req({ prompt }), (p) => pieces.push(p))
    assert.doesNotMatch(a.text, /ACTION|\n/, `${prompt}: the stand-in is one plain paragraph, no line: ${a.text}`)
    assert.equal(pieces.map((p) => p.text).join(''), a.text)
    assert.deepEqual([a.reason, a.standIn], [SCRIPTED, 'nothing listening'])
  }
})

test('an aborted request is not scripted (the operator stopped it)', async () => {
  const ctl = new AbortController()
  const m = withScriptedFallback(mind(async () => { ctl.abort(); throw new CognitionError('offline', 'gone') }))
  await assert.rejects(m.answer(req({ signal: ctl.signal }), () => {}), /gone/)
  assert.equal(m.scripted, 0)
})
