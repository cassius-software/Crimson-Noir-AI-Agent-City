// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the CC0 asset gate: each of the four forbidden words purges an asset wherever it
 * appears (name, path, tag, metadata), in any case and inside a longer word; the allowed near misses (gunmetal) pass;
 * clean assets are kept in order; every purge is logged with the word that caught it; and the region word lists the
 * generated maps name their streets from carry no forbidden word.
 * What breaks if it is removed? A rename of a forbidden word, or a loosening of the containment rule, goes unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ALLOWED_WORDS, FORBIDDEN_WORDS, forbiddenWordIn, purgeLine, screenAsset, screenAssets, screenNames } from './cc0.ts'
import { NAME_HEADS, NAME_TAILS } from '../region/names.ts'

test('the four words, in any case, anywhere in a word, are forbidden', () => {
  assert.deepEqual(FORBIDDEN_WORDS, ['gun', 'rifle', 'pistol', 'weapon'])
  for (const w of FORBIDDEN_WORDS) {
    assert.equal(forbiddenWordIn(w), w)
    assert.equal(forbiddenWordIn(w.toUpperCase()), w)
    assert.equal(forbiddenWordIn(`props/${w}_01.glb`), w)
    assert.equal(forbiddenWordIn(`Mega${w}X`), w)
  }
  assert.equal(forbiddenWordIn('shotgun'), 'gun')
  assert.equal(forbiddenWordIn('HandGun'), 'gun')
  assert.equal(forbiddenWordIn('Weaponry rack'), 'weapon')
  assert.equal(forbiddenWordIn('sniper rifles'), 'rifle')
  assert.equal(forbiddenWordIn('water pistols'), 'pistol')
})

test('ordinary words that merely contain gun pass; a forbidden word beside them does not', () => {
  for (const w of ALLOWED_WORDS) assert.equal(forbiddenWordIn(w), null, w)
  assert.equal(forbiddenWordIn('gunmetal grey sedan'), null)
  assert.equal(forbiddenWordIn('The race has begun'), null)
  assert.equal(forbiddenWordIn('burgundy pantsuit'), null, 'a colour of the wardrobe (look.ts LOOK_PRESETS)')
  assert.equal(forbiddenWordIn('burgundy gun'), 'gun')
  assert.equal(forbiddenWordIn('gunmetal gun'), 'gun')
  assert.equal(forbiddenWordIn('lamp post'), null)
  assert.equal(forbiddenWordIn(''), null)
})

test('an asset is purged for its name, path, a tag or any metadata text, and kept otherwise', () => {
  assert.deepEqual(screenAsset({ name: 'Rifle' }), { asset: 'Rifle', field: 'name', word: 'rifle' })
  assert.deepEqual(screenAsset({ name: 'prop_17', path: 'cc0/weapons/prop_17.glb' }), { asset: 'prop_17', field: 'path', word: 'weapon' })
  assert.deepEqual(screenAsset({ name: 'prop_18', tags: ['metal', 'PISTOL'] }), { asset: 'prop_18', field: 'tag', word: 'pistol' })
  assert.deepEqual(screenAsset({ name: 'prop_19', metadata: { title: 'A fine shotgun' } }), { asset: 'prop_19', field: 'metadata.title', word: 'gun' })
  assert.deepEqual(screenAsset({ name: 'prop_20', metadata: { nested: { note: 'handgun' } } }), { asset: 'prop_20', field: 'metadata.nested', word: 'gun' })
  assert.equal(screenAsset({ name: 'bench', path: 'cc0/furniture/bench.glb', tags: ['wood', 'gunmetal'], metadata: { licence: 'CC0-1.0' } }), null)
})

test('screenAssets keeps the clean ones in order and logs each purge with the word that caught it', () => {
  const lines: string[] = []
  const r = screenAssets([
    { name: 'bench' }, { name: 'machinegun_turret' }, { name: 'lamp' }, { name: 'ok', tags: ['rifle'] }, { name: 'tree' },
  ], (l) => lines.push(l))
  assert.deepEqual(r.kept.map((a) => a.name), ['bench', 'lamp', 'tree'])
  assert.deepEqual(r.purged, [{ asset: 'machinegun_turret', field: 'name', word: 'gun' }, { asset: 'ok', field: 'tag', word: 'rifle' }])
  assert.deepEqual(lines, [purgeLine(r.purged[0]), purgeLine(r.purged[1])])
  assert.equal(lines[0], 'cc0: purged "machinegun_turret" (name contains "gun")')
})

test('screenNames reports every forbidden name in a pack and nothing else', () => {
  const lines: string[] = []
  const purged = screenNames(['', 'Copperdale Street', 'Pistol Range Road', 'Gunmetal Avenue'], 'names', (l) => lines.push(l))
  assert.deepEqual(purged, [{ asset: 'Pistol Range Road', field: 'names', word: 'pistol' }])
  assert.equal(lines.length, 1)
})

test('the region word lists carry no forbidden word, so no generated street can', () => {
  for (const w of [...NAME_HEADS, ...NAME_TAILS]) assert.equal(forbiddenWordIn(w), null, w)
})
