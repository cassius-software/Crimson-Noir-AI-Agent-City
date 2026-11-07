// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the screen reader's lines (announcer.ts): nothing of the first
 * snapshot, a seat taken or left, a vehicle beside you with the right word for the controls, a district once held,
 * every new toast once, one line per gap with the rest queued and the oldest dropped past the queue's length.
 * What breaks if it is removed? A reader flooded at a district border, or told of a car that was always there.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ANNOUNCE, Announcer, enterWord, type Announced } from './announcer.ts'

const snap = (p: Partial<{ mode: 'foot' | 'vehicle'; near: boolean; district: string; toasts: { id: number; title: string; body: string }[]; glyphs: Announced['supplier']['glyphs']; touch: boolean }> = {}): Announced => ({
  supplier: { glyphs: p.glyphs ?? 'keyboard', touch: p.touch ?? false },
  input: { mode: p.mode ?? 'foot', nearVehicle: p.near ?? false },
  customer: { district: p.district ?? 'Old Town' },
  toasts: p.toasts ?? [],
})

test('the first snapshot is the baseline; a vehicle beside you, a seat taken and left, each said once, one line per gap', () => {
  const a = new Announcer()
  assert.equal(a.next(snap({ near: true, toasts: [{ id: 3, title: 'Network', body: 'joined' }] }), 0), null, 'what was already so is not news')
  assert.equal(a.next(snap({ near: true }), 100), null)
  assert.equal(a.next(snap({ near: false }), 200), null, 'a vehicle leaving is not said')
  assert.equal(a.next(snap({ near: true }), 300), 'A vehicle is beside you: E enters it.')
  assert.equal(a.next(snap({ near: true, mode: 'vehicle' }), 400), null, 'inside the gap: held')
  assert.equal(a.pending, 1)
  assert.equal(a.next(snap({ near: true, mode: 'vehicle' }), 300 + ANNOUNCE.gapMs), 'Driving.')
  assert.equal(a.next(snap({ near: true, mode: 'foot' }), 300 + 2 * ANNOUNCE.gapMs), 'On foot.')
  assert.equal(a.next(snap({ near: true, mode: 'foot' }), 300 + 3 * ANNOUNCE.gapMs), null, 'still beside it: said already')
})

test('a district is said once it has been held, and not again until another was; toasts are said once each, oldest first, beyond the queue the oldest go', () => {
  const a = new Announcer()
  a.next(snap({ district: 'Old Town' }), 0)
  assert.equal(a.next(snap({ district: 'Harbour' }), 1000), null, 'just crossed: held')
  assert.equal(a.next(snap({ district: 'Old Town' }), 2000), null, 'back over the border: the hold starts again')
  assert.equal(a.next(snap({ district: 'Harbour' }), 3000), null)
  assert.equal(a.next(snap({ district: 'Harbour' }), 3000 + ANNOUNCE.districtHoldMs - 1), null)
  assert.equal(a.next(snap({ district: 'Harbour' }), 3000 + ANNOUNCE.districtHoldMs), 'Now in Harbour.')
  assert.equal(a.next(snap({ district: 'Harbour' }), 20000), null, 'said once')
  const t = (id: number) => ({ id, title: `T${id}`, body: id % 2 ? 'odd' : '' })
  assert.equal(a.next(snap({ district: 'Harbour', toasts: [t(1), t(2)] }), 30000), 'T1: odd')
  assert.equal(a.next(snap({ district: 'Harbour', toasts: [t(1), t(2)] }), 30000 + ANNOUNCE.gapMs), 'T2', 'a toast without a body is its title')
  assert.equal(a.next(snap({ district: 'Harbour', toasts: [t(2)] }), 40000), null, 'nothing new')
  a.next(snap({ district: 'Harbour', toasts: [t(3), t(4), t(5), t(6), t(7), t(8)] }), 50000)
  assert.equal(a.pending, ANNOUNCE.queue - 1, 'one said, the queue holds its length, the oldest dropped')
  const rest: string[] = []
  for (let i = 1; i <= 6; i++) { const l = a.next(snap({ district: 'Harbour', toasts: [t(8)] }), 50000 + i * ANNOUNCE.gapMs); if (l) rest.push(l) }
  assert.deepEqual(rest, ['T6', 'T7: odd', 'T8'])
})

test('what enters a vehicle, for the controls in use', () => {
  assert.equal(enterWord('keyboard', false), 'E enters it')
  assert.equal(enterWord('abxy', false), 'the bottom face button enters it')
  assert.equal(enterWord('numbered', false), 'the bottom face button enters it')
  assert.equal(enterWord('touch', false), 'the Enter car button enters it')
  assert.equal(enterWord('keyboard', true), 'the Enter car button enters it')
  const a = new Announcer()
  a.next(snap({ glyphs: 'bayx' }), 0)
  assert.equal(a.next(snap({ glyphs: 'bayx', near: true }), 10), 'A vehicle is beside you: the bottom face button enters it.')
})
