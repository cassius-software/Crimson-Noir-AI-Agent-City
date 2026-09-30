/**
 * Why does this file exist? It checks the region pack the pilot build embeds (world/pilot.region.json.gz), as shipped:
 * the shape the engine reads, fictional names only (none of the region's real places, landmarks or streets on the
 * tools' denylist, and nothing the source-code scan would refuse), its data licences stated, and its size. The raw
 * sources are not in the repository, so the compiler's full check (every real street name) ran when it was compiled;
 * this one keeps the committed file honest.
 * What breaks if it is removed? A hand-edited or stale pack could carry a real name into the pilot build.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'
import { REAL_PLACES } from '../../../tools/world/real-places.mjs'
import { realNamesIn } from './compile.ts'
import { normal } from './names.ts'
import { polygonCount, validatePack } from './pack.ts'

const FILE = new URL('../../../world/pilot.region.json.gz', import.meta.url)

test('the pilot pack: its shape, fictional names only, its licences, a sensible size', { skip: !existsSync(FILE) && 'no pilot pack compiled' }, () => {
  const raw = readFileSync(FILE)
  assert.ok(raw.length < 8e6, `${raw.length} bytes gzipped`)
  const pack = validatePack(JSON.parse(gunzipSync(raw).toString('utf8')))
  assert.ok(polygonCount(pack.buildings) > 10000 && pack.roads.cls.length > 1000 && polygonCount(pack.water) > 0)
  // The tools' denylist (whole names, phrases and their words). A fictional street is one generated word, then the
  // source's street type and direction: those later words are the ordinary ones the compiler lets through.
  const ordinary = [...new Set(pack.names.flatMap((n) => normal(n).split(' ').slice(1)))]
  assert.deepEqual(realNamesIn(pack, REAL_PLACES, ordinary), [])
  // And the scan the shipped source gets (compliance.test.ts REAL_PLACES), over every name in the pack.
  const shipped = /\b(?:Toronto|Ontario|Mississauga|Brampton|Scarborough|Etobicoke|Markham|Oakville|Burlington|Oshawa|Pickering|Vaughan|Hamilton|Niagara|Cambridge|Harbourfront|Yonge|Gardiner|Humber|Bloor|Spadina)\b/i
  for (const n of [pack.name, ...pack.names]) assert.doesNotMatch(n, shipped, n)
  assert.ok(pack.names.every((n, i) => i === 0 || /^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(n)), 'every name is words of letters')
  assert.equal(new Set(pack.names.map(normal)).size, pack.names.length, 'no name twice')
  // The licences travel with the data.
  const lic = pack.attribution.join(' ')
  for (const l of ['Open Government Licence – Ontario', 'Open Government Licence – Canada', 'Open Government Licence – Toronto']) assert.ok(lic.includes(l), l)
})
