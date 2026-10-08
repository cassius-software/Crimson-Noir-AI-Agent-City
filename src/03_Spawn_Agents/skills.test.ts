// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? Recruitment is only as good as its rules: everyone keeps the same skills forever, a
 * request needs both a request word and a skill word (naming a language in passing asks nobody over), only
 * someone within earshot on the operator's own side of the street qualifies, and the search always finds the
 * nearest such person. The page and the physics worker both run these rules, so they are pinned here once.
 * What breaks if it is removed? A regression could summon someone across a carriageway, or on every "let's go".
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CITY } from '../01_Initialize_World/city.ts'
import {
  AUDIBLE_RADIUS, eligible, findRecruit, onRoad, parseRequest, sidewalkPath, skillNamed, SKILL_WORDS, SKILLS, skillsOf, SUMMON_ACCEPT, whyNot,
  type Skill,
} from './skills.ts'

/** A sidewalk mid-block: 5.8 m east of a north-south street, 20 m from the cross streets. */
const OP = { x: 2 * CITY.pitch + CITY.lane, z: 3 * CITY.pitch + 20 }
const agentsWith = (skill: Skill, n = 400) => Array.from({ length: n }, (_, k) => k + 1).filter((a) => skillsOf(a).includes(skill))
const field = (n: number) => new Float32Array(2 * n).fill(NaN)
const put = (xz: Float32Array, agent: number, x: number, z: number) => { xz[2 * agent] = x; xz[2 * agent + 1] = z }

test('everyone has two different skills, the same ones every time; the player\'s own body has none', () => {
  assert.deepEqual(skillsOf(0), [])
  for (const bad of [-1, 1.5, NaN, Infinity]) assert.deepEqual(skillsOf(bad), [])
  const seen = new Map<Skill, number>()
  for (let a = 1; a <= 20000; a++) {
    const s = skillsOf(a)
    assert.equal(s.length, 2)
    assert.notEqual(s[0], s[1])
    assert.deepEqual(skillsOf(a), s, 'deterministic')
    for (const k of s) seen.set(k, (seen.get(k) ?? 0) + 1)
  }
  // Every skill is common enough to find in a crowd: within 25 % of an even share.
  assert.equal(seen.size, SKILLS.length)
  const even = (2 * 20000) / SKILLS.length
  for (const [k, n] of seen) assert.ok(Math.abs(n - even) < even * 0.25, `${k}: ${n}`)
})

test('a spoken request needs a request phrase with a skill word after it; the first skill named after it wins', () => {
  assert.equal(parseRequest('recruit a Rust developer'), 'Rust')
  assert.equal(parseRequest('I need someone who knows TypeScript'), 'TypeScript')
  assert.equal(parseRequest('hire a type script engineer'), 'TypeScript')
  assert.equal(parseRequest('anyone here do C plus plus?'), 'C++')
  assert.equal(parseRequest('Looking for a golang programmer'), 'Go')
  assert.equal(parseRequest('find me a w g s l person'), 'WGSL')
  assert.equal(parseRequest('need a designer, or maybe python'), 'Design')
  assert.equal(parseRequest("I'm looking for python or a designer"), 'Python')
  assert.equal(parseRequest('I need a coffee, then recruit a rust developer'), 'Rust', 'a skill after any request counts')
  assert.equal(parseRequest('HIRING: SECURITY!'), 'Security')
  // Naming a skill in passing asks nobody; neither does a request with no skill.
  assert.equal(parseRequest('rust never sleeps'), null)
  // The microphone is always open: everyday speech with "need" or "anyone" in it is not a request, nor is a skill named
  // before the request, nor a request turned down.
  for (const said of [
    "I don't need a Rust developer", 'no need for security', 'does anyone have the data', 'I need to finish writing this',
    'we need more data', 'anyone seen my docs', 'rust developers, never hire them', 'we do not need a designer',
    'nobody is looking for python', 'rust is great, anyway I need a coffee', "don't recruit anyone who knows audio",
    // Everyday questions that happen to hold a request phrase and a skill word, not together.
    'is there a problem with the network', 'is there a bug in the shader', 'is there a way to turn the sound down',
    'is there an easier way to parse this data', 'who can hear that sound', 'who can say what the data means',
    'find someone to blame for the security hole', 'looking for the data file', 'I need a break from writing',
    'who knows what the data says', 'find a way to fix the network',
    // Turned down in other words.
    "we aren't hiring rust developers", "we shouldn't hire a rust developer", "I wouldn't hire a python dev",
    "we aren't looking for a designer", "we haven't got time to find a tester", 'never mind recruit a python developer',
  ]) assert.equal(parseRequest(said), null, said)
  // A negation in another clause, or a request after a turned-down one, still asks.
  for (const [said, skill] of [
    ['never mind, recruit a python developer', 'Python'], ['not now. recruit a rust developer', 'Rust'],
    ['not that one, hire a designer', 'Design'], ["I don't know, find me a designer", 'Design'],
    ['no problem, hire a writer', 'Writing'], ['no, recruit a rust developer', 'Rust'],
    ["I don't need a designer, I need a rust developer", 'Rust'], ["I don't need a designer but I need a rust developer", 'Rust'],
    ["isn't there anyone who knows rust", 'Rust'],
    // Ordinary phrasings.
    ['can you recruit a rust developer', 'Rust'], ['recruit someone for security', 'Security'], ["I'd like to hire a designer", 'Design'],
    ['hire me a python dev', 'Python'], ['who knows wgsl', 'WGSL'], ['does anyone know rust', 'Rust'], ['who can do shaders', 'Shaders'],
    ['is there anyone who knows networking', 'Networking'], ['hire designers', 'Design'], ['recruit a good senior go developer', 'Go'],
    ['recruit a data scientist', 'Data'], ['hire a rustacean', 'Rust'],
  ] as const) assert.equal(parseRequest(said), skill, said)
  assert.equal(parseRequest('the python exhibit is closed'), null)
  assert.equal(parseRequest('I need a coffee'), null)
  // "go" alone is a verb, not a language.
  assert.equal(parseRequest('I need to go'), null)
  assert.equal(parseRequest("let's go find a rust person"), 'Rust')
  // Whole words only: "trust" is not Rust, "datastore" not Data, "unhired" not a request.
  assert.equal(parseRequest('recruit someone I can trust'), null)
  assert.equal(parseRequest('need a datastore'), null)
  assert.equal(parseRequest('unhired rust'), null)
  for (const junk of ['', '   ', undefined as unknown as string, null as unknown as string, 42 as unknown as string]) assert.equal(parseRequest(junk), null)
})

test('the console names a skill by its name or any word for it, in any case', () => {
  for (const s of SKILLS) {
    assert.equal(skillNamed(s), s)
    assert.equal(skillNamed(s.toUpperCase()), s)
    for (const w of SKILL_WORDS[s]) assert.equal(skillNamed(w), s, w)
  }
  assert.equal(skillNamed('  rust '), 'Rust')
  assert.equal(skillNamed('c++'), 'C++')
  assert.equal(skillNamed('go'), 'Go', 'on the console "go" is unambiguous')
  for (const junk of ['', 'juggling', 'rusty', undefined as unknown as string, {} as unknown as string]) assert.equal(skillNamed(junk), null, String(junk))
})

test('the road, as the crowd shader draws it: within roadHalf of any street centreline', () => {
  const p = CITY.pitch, h = CITY.roadHalf
  assert.ok(onRoad(0, 17) && onRoad(p * 3 + h - 0.01, 17) && onRoad(17, p * 2 - h + 0.01))
  assert.ok(!onRoad(p * 3 + h + 0.01, 17) && !onRoad(OP.x, OP.z) && !onRoad(p / 2, p / 2))
  // Straight along the sidewalk: fine; across the carriageway, or clipping a corner of it: not.
  assert.ok(sidewalkPath(OP.x, OP.z, OP.x, OP.z + 4.9))
  assert.ok(!sidewalkPath(OP.x, OP.z, OP.x - 2 * CITY.lane, OP.z))
  assert.ok(!sidewalkPath(OP.x, 3 * CITY.pitch + 5, OP.x + 1, 3 * CITY.pitch - 5))
  assert.equal(whyNot(null), 'recruiting works on foot')
  assert.equal(whyNot({ x: NaN, z: 0 }), 'the operator is nowhere')
  assert.match(whyNot({ x: 2 * CITY.pitch, z: OP.z })!, /sidewalk/)
  assert.equal(whyNot(OP), null)
  assert.ok(SUMMON_ACCEPT > AUDIBLE_RADIUS, 'the GPU takes the request from anyone the rule could have picked, a few frames later')
  // Two sidewalks across a street are at least a carriageway (2 · roadHalf) apart, so while earshot is shorter nobody
  // across a street can hear the operator at all; the sidewalk-path check in eligible() guards a longer earshot.
  assert.ok(AUDIBLE_RADIUS < 2 * CITY.roadHalf, 'raising earshot past a carriageway makes the sidewalk-path check load-bearing: test it then')
})

test('only someone with the skill, within earshot, on this side of the street qualifies; the nearest is asked', () => {
  const [a, b, c, d, e] = agentsWith('Rust')
  const other = Array.from({ length: 400 }, (_, k) => k + 1).find((x) => !skillsOf(x).includes('Rust'))!
  const xz = field(401)
  put(xz, a, OP.x, OP.z + 4)          // 4 m up the sidewalk
  put(xz, b, OP.x + 0.5, OP.z - 3)    // 3.04 m: the nearest
  put(xz, c, OP.x - 2 * CITY.lane, OP.z) // the far kerb: 11.6 m, and across the road
  put(xz, d, OP.x, OP.z + AUDIBLE_RADIUS + 0.01) // just out of earshot
  put(xz, e, OP.x - 3, OP.z)          // 3 m, but standing in the road
  put(xz, other, OP.x, OP.z + 1)      // nearest of all, no Rust
  assert.ok(Math.abs(eligible(xz, a, OP, 'Rust') - 4) < 1e-4)
  assert.ok(Math.abs(eligible(xz, b, OP, 'Rust') - Math.hypot(0.5, 3)) < 1e-4)
  for (const x of [c, d, e, other, 0, -1, 1.5, 401, 10_000]) assert.equal(eligible(xz, x, OP, 'Rust'), -1, `agent ${x}`)
  assert.deepEqual(findRecruit(xz, OP, 'Rust')?.agent, b)
  assert.deepEqual(findRecruit(xz, OP, 'Rust', (x) => x === b)?.agent, a, 'someone already asked is skipped')
  assert.equal(findRecruit(xz, OP, 'Rust', (x) => x === a || x === b), null)
  // A skill none of the people in earshot has (a, b and the no-Rust neighbour are the only ones there).
  const missing = SKILLS.find((k) => ![a, b, other].some((x) => skillsOf(x).includes(k)))!
  assert.equal(findRecruit(xz, OP, missing), null, missing)
  // Nobody placed yet (NaN) is nobody; the player's own body (index 0) is never a candidate.
  put(xz, 0, OP.x, OP.z + 0.5)
  assert.deepEqual(findRecruit(xz, OP, 'Rust')?.agent, b)
  assert.equal(findRecruit(field(401), OP, 'Rust'), null)
})
