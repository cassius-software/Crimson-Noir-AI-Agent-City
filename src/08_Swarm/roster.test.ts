// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence for the roster (roster.ts): a record holds only what the page can show
 * (a kept name, known pronouns, a one-line admissible role, a one-word voice, a wardrobe look), the roster keeps at most
 * twelve, names are unique, every change is saved and read back, a hire binds one body to one record, and the console
 * bridge over it hires through the recruiter and dresses the pedestrian. The twelve voice profiles are pinned, and so
 * is the console's own copy of the pronoun words.
 * What breaks if it is removed? A stored record could carry anything into a prompt or the wardrobe, and the hire could
 * dress nobody, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LOOK_PRESETS, formatLookCode } from '../03_Spawn_Agents/look.ts'
import { PRONOUN_WORDS } from '../07_Execute_Actions/terminal/commands.ts'
import {
  CONCIERGE_PROFILE, PRONOUNS, ROSTER_KEY, ROSTER_MAX, Roster, VOICE_PROFILES, agentBridge, describeIdentity, identityLine, loadRoster,
  newIdentity, sanitizeRole, sanitizeVoice, validateIdentity, voiceProfile, type KeyStore,
} from './roster.ts'

function memoryStore(): KeyStore & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => { map.set(k, v) }, removeItem: (k) => { map.delete(k) } }
}

test('twelve voice profiles, six that lean neither way, three lighter, three deeper; Sloane\'s is velvet; the console\'s pronoun words are the roster\'s', () => {
  assert.equal(VOICE_PROFILES.length, 12)
  assert.equal(new Set(VOICE_PROFILES.map((p) => p.name)).size, 12)
  assert.equal(VOICE_PROFILES.filter((p) => p.pitch >= 0.9 && p.pitch <= 1.1).length, 6)
  assert.equal(VOICE_PROFILES.filter((p) => p.pitch > 1.1).length, 3)
  assert.equal(VOICE_PROFILES.filter((p) => p.pitch < 0.9).length, 3)
  for (const p of VOICE_PROFILES) assert.ok(p.rate > 0.8 && p.rate < 1.2 && Object.isFrozen(p), p.name)
  assert.equal(voiceProfile(CONCIERGE_PROFILE)?.name, 'velvet')
  assert.equal(voiceProfile(' Velvet '), VOICE_PROFILES[0])
  assert.equal(voiceProfile('af_sky'), null)
  assert.equal(PRONOUN_WORDS, PRONOUNS.join('|'))
})

test('a record holds only what the page can show: name, pronouns, role (one admissible line), voice (one word), look (the wardrobe\'s), agent (a row)', () => {
  assert.equal(sanitizeRole('  a quant   analyst \n on the desk '), 'a quant analyst on the desk')
  assert.equal(sanitizeRole('x'.repeat(80)).length, 48)
  assert.equal(sanitizeRole('kill them all'), '', 'the 14A screen holds here too')
  assert.equal(sanitizeRole(42), '')
  assert.equal(sanitizeVoice(' bright '), 'bright')
  assert.equal(sanitizeVoice('two words'), '')
  assert.equal(sanitizeVoice('x'.repeat(30)), '')
  const look = LOOK_PRESETS[0].look
  const id = validateIdentity({ name: ' Nova ', pronouns: 'she/her', role: 'a quant analyst', voice: 'bright', look, agent: 42 })
  assert.deepEqual(id, { name: 'Nova', pronouns: 'she/her', role: 'a quant analyst', voice: 'bright', look, agent: 42 })
  assert.ok(Object.isFrozen(id))
  assert.equal(validateIdentity({ name: '', pronouns: 'she/her' }), null, 'no name, no record')
  assert.equal(validateIdentity({ name: 'Nova', look: { body: 9 } }), null, 'a look outside the wardrobe refuses the record')
  assert.deepEqual(validateIdentity({ name: 'Nova', pronouns: 'xe/xem', role: 7, voice: '', look: null, agent: -1 }), { name: 'Nova', pronouns: 'they/them', role: '', voice: 'even', look: null, agent: null }, 'the defaults for anything odd')
  assert.equal(validateIdentity('Nova'), null)
  assert.deepEqual(newIdentity('Kai'), { name: 'Kai', pronouns: 'they/them', role: '', voice: 'even', look: null, agent: null })
  assert.equal(identityLine({ name: 'Nova', pronouns: 'she/her', role: 'a quant analyst', voice: 'bright', look: null, agent: 42 }), 'You go by Nova (she/her), a quant analyst.')
  assert.equal(identityLine({ name: 'Kai', pronouns: 'any', role: '', voice: 'even', look: null, agent: null }), 'You go by Kai.')
  assert.deepEqual(describeIdentity({ name: 'Kai', pronouns: 'any', role: '', voice: 'af_sky', look, agent: null }), [
    'Kai  any',
    '  voice  af_sky (a voice the speech provider knows)',
    `  look   ${formatLookCode(look)}`,
    '  hired  not yet: agent hire <name> [<skill>]',
  ])
})

test('the roster: add, set, bind, remove; unique names; at most twelve; every change kept and read back; a refusing store is silent', () => {
  const store = memoryStore()
  const r = new Roster(store)
  let changes = 0
  const off = r.onChange(() => changes++)
  assert.deepEqual(r.list(), [])
  const nova = r.add('Nova')
  assert.equal(nova.name, 'Nova')
  assert.throws(() => r.add('nova'), /already an agent called Nova/)
  assert.throws(() => r.add('   '), /not a name/)
  assert.throws(() => r.add('Nova Star'), /one word/, 'the console reads the name as one word')
  assert.throws(() => r.add('Moron'), /business-casual/, 'a name reaches every prompt they answer: screened like the role')
  assert.equal(r.set('Nova', 'role', ' a quant analyst ').role, 'a quant analyst')
  assert.throws(() => r.set('Nova', 'role', 'kill them all'), /business-casual/)
  assert.equal(r.set('Nova', 'role', '').role, '', 'a role can be cleared')
  assert.equal(r.set('Nova', 'pronouns', 'she/her').pronouns, 'she/her')
  assert.throws(() => r.set('Nova', 'pronouns', 'xe'), /they\/them, she\/her, he\/him, any/)
  assert.equal(r.set('Nova', 'voice', 'af_sky').voice, 'af_sky')
  assert.throws(() => r.set('Nova', 'voice', 'two words'), /one word/)
  const code = formatLookCode(LOOK_PRESETS[2].look)
  assert.deepEqual(r.set('Nova', 'look', code).look, LOOK_PRESETS[2].look)
  assert.throws(() => r.set('Nova', 'look', 'nonsense'), /not a look code/)
  assert.equal(r.set('Nova', 'look', 'none').look, null)
  assert.throws(() => r.set('Nova', 'name', 'Nova Prime'), /one word/)
  assert.equal(r.set('Nova', 'name', 'Vega').name, 'Vega')
  assert.equal(r.get('vega')?.name, 'Vega')
  assert.equal(r.get('Nova'), null)
  assert.throws(() => r.set('Nobody', 'role', 'x'), /no agent called 'Nobody'/)
  // A hire binds one body to one record: another record on the same row lets it go.
  assert.equal(r.bind('Vega', 42).agent, 42)
  assert.equal(r.byAgent(42)?.name, 'Vega')
  assert.throws(() => r.bind('Vega', 0), /not a pedestrian's number/)
  r.add('Kai')
  r.bind('Kai', 42)
  assert.equal(r.get('Vega')?.agent, null)
  assert.equal(r.byAgent(42)?.name, 'Kai')
  // A hire is this visit's alone: read back, nobody is hired (the next page has no tether to them).
  assert.equal(new Roster(store).get('Kai')?.agent, null)
  // The recruiter's list no longer has someone: their record is let go, and only then is anything saved or told.
  const before = changes
  assert.deepEqual(r.keepOnly([42, 7]), [])
  assert.equal(changes, before, 'nobody let go: nothing told')
  assert.deepEqual(r.keepOnly([7]), [42])
  assert.equal(r.get('Kai')?.agent, null)
  assert.equal(changes, before + 1)
  r.bind('Kai', 42)
  assert.equal(r.bind('Kai', null).agent, null)
  assert.ok(changes >= 12)
  off()
  // Read back: the same records, in order; the store holds one key.
  assert.deepEqual(new Roster(store).list(), r.list())
  assert.deepEqual([...store.map.keys()], [ROSTER_KEY])
  assert.equal(r.remove('Kai').name, 'Kai')
  assert.throws(() => r.remove('Kai'), /no agent called/)
  for (let i = r.list().length; i < ROSTER_MAX; i++) r.add(`Agent${i}`)
  assert.throws(() => r.add('OneMore'), /roster is full/)
  // A stored list is read within the rules: bad records dropped, duplicate names first-wins, cut at twelve.
  store.map.set(ROSTER_KEY, JSON.stringify({ v: 1, agents: [{ name: 'A' }, { name: 'a', role: 'twin' }, { name: '' }, 'junk', ...Array.from({ length: 20 }, (_, i) => ({ name: `B${i}` }))] }))
  const read = loadRoster(store)
  assert.equal(read.length, ROSTER_MAX)
  assert.deepEqual(read.slice(0, 2).map((a) => a.name), ['A', 'B0'])
  store.map.set(ROSTER_KEY, '{not json')
  assert.deepEqual(loadRoster(store), [])
  assert.deepEqual(loadRoster(null), [])
  const broken: KeyStore = { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') }, removeItem: () => {} }
  const b = new Roster(broken)
  assert.equal(b.add('Sam').name, 'Sam', 'storage refused: the roster lasts for the visit')
})

test('the console bridge: list, add, set; hire goes through the recruiter and dresses the pedestrian; dismiss undresses; forget removes; voices lists the profiles', async () => {
  const store = memoryStore()
  const r = new Roster(store)
  const worn: [number, unknown][] = []
  let answer: { ok: boolean; message: string; agent?: number } = { ok: true, message: 'agent 77 (Rust) is coming over', agent: 77 }
  const asked: string[] = []
  const a = agentBridge(r, { recruit: (skill) => { asked.push(skill); return Promise.resolve(answer) }, wear: (agent, look) => { worn.push([agent, look]); return true }, skills: () => ['Rust', 'Go'] })
  assert.deepEqual(a.list(), ['no agents on the roster yet: agent new <name> adds one (at most 12)'])
  assert.equal(a.add('Nova')[0], 'Nova  they/them')
  assert.equal(a.set('Nova', 'role', 'a quant analyst')[0], 'Nova  they/them  a quant analyst')
  const code = formatLookCode(LOOK_PRESETS[1].look)
  a.set('Nova', 'look', code)
  assert.deepEqual(worn, [], 'not hired: nobody to dress yet')
  assert.equal(await a.hire('Nova', 'Rust'), 'Nova is on the way: agent 77 (Rust) is coming over')
  assert.deepEqual(asked, ['Rust'])
  assert.deepEqual(worn, [[77, LOOK_PRESETS[1].look]], 'dressed the moment they are bound')
  assert.equal(r.byAgent(77)?.name, 'Nova')
  assert.equal(await a.hire('Nova', 'Go'), 'Nova is already hired as pedestrian 77 (agent dismiss Nova lets them go)')
  a.set('Nova', 'look', formatLookCode(LOOK_PRESETS[3].look))
  assert.deepEqual(worn[1], [77, LOOK_PRESETS[3].look], 'a hired agent\'s new look is worn at once')
  assert.equal(a.dismiss('Nova'), 'Nova let go (pedestrian 77 keeps walking; recruit dismiss breaks the tether)')
  assert.deepEqual(worn[2], [77, null])
  assert.equal(a.dismiss('Nova'), 'Nova is not hired')
  answer = { ok: false, message: 'nobody with Rust within earshot' }
  assert.equal(await a.hire('Nova', 'Rust'), 'nobody with Rust within earshot')
  assert.equal(r.get('Nova')?.agent, null)
  await assert.rejects(a.hire('Nobody', 'Rust'), /no agent called 'Nobody'/)
  // Hired onto a body another record had dressed: dressed as this record says, the city's own look here.
  answer = { ok: true, message: 'agent 77 (Rust) is coming over', agent: 77 }
  a.add('Kai')
  await a.hire('Nova', 'Rust')
  await a.hire('Kai', 'Rust')
  assert.equal(r.get('Nova')?.agent, null, 'one body per record')
  assert.deepEqual(worn.at(-1), [77, null])
  assert.equal(a.forget('Nova'), 'Nova forgotten')
  assert.throws(() => a.forget('Nova'), /no agent called/)
  assert.equal(a.voices().length, 12)
  assert.match(a.voices()[0], /^velvet\s+smooth and unhurried/)
})
