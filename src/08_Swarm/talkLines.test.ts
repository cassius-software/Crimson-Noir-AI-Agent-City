// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence that what people say in a conversation without a model
 * (talkLines.ts) is safe to say and to hear back. Every opener, line and fallback, filled for every role, every pair
 * of skills, sample roster names and every part of the day, passes the 14A screen, is never heard as a recruitment
 * request (the browser's own recogniser has no echo guard), has at most three sentences of at most twenty syllables
 * and 240 characters with no slot left unfilled, says nothing of the weather or the news, and holds to the house's
 * word rules (the FORBIDDEN regex the wiring tests share, the brands and real places compliance.test.ts refuses, and
 * the unarmed regex conduct.test.ts holds the city to), each read from the file that owns it so the two never drift.
 * It also pins that the choice is deterministic and varied, how lines are read for intent, which lines greet the
 * person near (never Sloane's, never plain talk), that a pedestrian's label is the engine's own caption form and their
 * voice is never Sloane's, and the prompt's bounds.
 * What breaks if it is removed? A script line could trip the screen, recruit someone when it comes back through the
 * speakers, run long, name a real place, or repeat itself, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { parseRequest, SKILLS, skillsOf } from '../03_Spawn_Agents/skills.ts'
import { CONCIERGE_PROFILE, newIdentity, VOICE_PROFILES, type AgentIdentity } from './roster.ts'
import {
  ABOUT_MAX, DAYPARTS, FALLBACK, INTENTS, LINES, OPENERS, PROMPT_MAX, PROMPT_TURNS, TURN_CHARS, VARIANT_SPAN, daypartOf, fillLine, greets,
  intentOf, lineFor, openerFor, personPrompt, talkWho, type Intent, type TalkRole, type TalkWho,
} from './talkLines.ts'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const source = (rel: string): string => readFileSync(`${ROOT}${rel}`, 'utf8')

/** A regular expression literal in source text: its body (classes may hold a slash) and its flags. */
const LITERAL = /\/((?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\[\n])+)\/([dgimsuy]*)/g
/** The regular expression literals assigned to `name` on its one line in `rel` (`const NAME = /…/i` or `= [/…/, …]`). */
function literals(rel: string, name: string): RegExp[] {
  const line = source(rel).split('\n').find((l) => new RegExp(`^const ${name}\\b`).test(l))
  assert.ok(line, `${rel} still defines ${name} on one line`)
  return [...line.slice(line.indexOf('=') + 1).matchAll(LITERAL)].map((m) => new RegExp(m[1], m[2]))
}

/** The house FORBIDDEN regex the wiring tests share (bootloader, splitWiring, homeWiring, netWiring). */
const [FORBIDDEN] = literals('src/07_Execute_Actions/bootloader.test.ts', 'FORBIDDEN')
/** The brand names and the real places compliance.test.ts refuses. */
const SCRUBBED = literals('src/compliance.test.ts', 'SCRUBBED')
const [REAL_PLACES] = literals('src/compliance.test.ts', 'REAL_PLACES')
/** The words conduct.test.ts holds the city unarmed with. */
const [ARMED] = literals('src/02_Define_The_Rules/conduct.test.ts', 'ARMED')
/** The weather and the news, which no person here knows anything of (by substring, so 'brainstorm' counts too). */
const WEATHER_NEWS = /rain|snow|storm|weather|news/i

/** Sample roster names: short, long, and the longest one word the roster keeps (24 characters). */
const NAMES = ['Mira', 'Tobin', 'Wren', 'Annaliese', 'Bartholomewsonhawthornes']
const ROLES: readonly TalkRole[] = ['stranger', 'recruit', 'crew']

/** A hired agent's record, as the roster would hold it. */
function hired(name: string, row: number, more: Partial<AgentIdentity> = {}): AgentIdentity {
  const id = newIdentity(name)
  assert.ok(id, `the roster keeps the name ${name}`)
  return { ...id, agent: row, ...more }
}

/** A person of `role` at `row` whose skills are `skill` and `skill2` (labelled by the first), named `name` when crew. */
function person(role: TalkRole, row: number, skill: string, skill2: string, name = 'Mira'): TalkWho {
  const base = role === 'crew' ? talkWho(row, hired(name, row), null, null)
    : role === 'recruit' ? talkWho(row, null, { skill, state: 'Active' }, null) : talkWho(row, null, null, null)
  return { ...base, skill, skill2, label: role === 'crew' ? base.label : `Pedestrian ${row} (${skill})` }
}

/** Everyone the tables are filled for: every role, every ordered pair of distinct skills, crew under every sample name. */
function everyone(): TalkWho[] {
  const out: TalkWho[] = []
  for (const role of ROLES) {
    for (const a of SKILLS) {
      for (const b of SKILLS) {
        if (a === b) continue
        if (role === 'crew') for (const name of NAMES) out.push(person(role, 4242, a, b, name))
        else out.push(person(role, 32767, a, b))
      }
    }
  }
  return out
}

/** Sentences as a listener hears them: split after . ! or ? (a skill such as C++ holds none). */
const sentences = (line: string): string[] => line.split(/[.!?]+(?=\s|$)/).map((s) => s.trim()).filter(Boolean)

/**
 * A word's syllables, near enough for a cap: a word with plus signs is said 'see plus plus'; a word of two or more
 * capitals is said letter by letter (W is three); anything else counts its vowel groups, a silent final e or a final
 * -es or -ed after a consonant left out, at least one.
 */
function syllables(word: string): number {
  const plus = (word.match(/\+/g) ?? []).length
  if (plus) return plus + word.replace(/[^A-Za-z]/g, '').length
  const bare = word.replace(/[^A-Za-z]/g, '')
  if (!bare) return 0
  if (/^[A-Z]{2,}$/.test(bare)) return [...bare].reduce((n, ch) => n + (ch === 'W' ? 3 : 1), 0)
  const w = bare.toLowerCase()
  if (w.length <= 3) return 1
  const stem = w.replace(/(?:[^laeiouy]es|[^laeiouy]ed|[^laeiouy]e)$/, (m) => m[0]).replace(/^y/, '')
  return Math.max(1, (stem.match(/[aeiouy]{1,2}/g) ?? []).length)
}
const sentenceSyllables = (s: string): number => s.split(/[\s—–-]+/).reduce((n, w) => n + syllables(w), 0)

/** Every rule a filled line is held to. */
function heldTo(where: string, line: string): void {
  const verdict = screen(line)
  assert.ok(verdict.admissible, `${where}: the screen refuses "${verdict.term}" in ${JSON.stringify(line)}`)
  assert.equal(parseRequest(line), null, `${where}: heard as a request for a skill: ${JSON.stringify(line)}`)
  assert.ok(line.length <= 240, `${where}: ${line.length} characters: ${JSON.stringify(line)}`)
  assert.ok(!/[{}]/.test(line), `${where}: a slot left unfilled: ${JSON.stringify(line)}`)
  assert.ok(!/\d/.test(line), `${where}: a number is said: ${JSON.stringify(line)}`)
  const parts = sentences(line)
  assert.ok(parts.length >= 1 && parts.length <= 3, `${where}: ${parts.length} sentences: ${JSON.stringify(line)}`)
  for (const s of parts) assert.ok(sentenceSyllables(s) <= 20, `${where}: ${sentenceSyllables(s)} syllables in ${JSON.stringify(s)}`)
  assert.doesNotMatch(line, WEATHER_NEWS, where)
  assert.doesNotMatch(line, FORBIDDEN, where)
  for (const re of SCRUBBED) assert.doesNotMatch(line, re, where)
  assert.doesNotMatch(line, REAL_PLACES, where)
  assert.doesNotMatch(line, ARMED, where)
}

test('the house word rules are read from the files that own them, and each still has its shape', () => {
  assert.ok(FORBIDDEN instanceof RegExp && FORBIDDEN.flags.includes('i') && FORBIDDEN.source.split('|').length >= 5)
  // The first of its words, as the file writes it, is caught (so the reading is the regex, not an empty one).
  const firstForbidden = FORBIDDEN.source.split('|')[0].replace(/\\b/g, '')
  assert.ok(FORBIDDEN.test(`a ${firstForbidden} here`))
  assert.ok(SCRUBBED.length >= 6 && SCRUBBED.every((re) => re.flags.includes('i')))
  const firstPlace = /\(\?:([A-Za-z ]+)\|/.exec(REAL_PLACES.source)?.[1] ?? ''
  assert.ok(firstPlace.length > 3 && REAL_PLACES.test(`near ${firstPlace}`))
  assert.ok(ARMED instanceof RegExp && ARMED.source.length > 200)
  assert.equal(ARMED.test('a skillet and an umbrella'), false)
})

test('the tables: every role has openers for every part of the day and at least three lines for every intent, all frozen', () => {
  for (const role of ROLES) {
    assert.ok(Object.isFrozen(OPENERS[role]) && Object.isFrozen(LINES[role]))
    for (const part of DAYPARTS) {
      assert.ok(OPENERS[role][part].length >= 3, `${role} ${part}`)
      assert.ok(OPENERS[role][part].length < VARIANT_SPAN)
      assert.ok(Object.isFrozen(OPENERS[role][part]))
    }
    assert.deepEqual(Object.keys(LINES[role]).sort(), [...INTENTS].sort())
    for (const intent of INTENTS) {
      const lines = LINES[role][intent]
      assert.ok(lines.length >= 3 && lines.length < VARIANT_SPAN, `${role} ${intent}: ${lines.length}`)
      assert.ok(Object.isFrozen(lines))
      assert.equal(new Set(lines).size, lines.length, `${role} ${intent} repeats a line`)
    }
    assert.ok(!/[{}]/.test(FALLBACK[role]), 'a fallback has no slots')
  }
  // A pedestrian's number is never said aloud: only crew lines name the person.
  for (const role of ['stranger', 'recruit'] as const) {
    for (const lines of [...Object.values(OPENERS[role]), ...Object.values(LINES[role])]) for (const l of lines) assert.ok(!l.includes('{name}'), l)
  }
  // The refused lines are fixed words: no slot, so nothing of what was refused can come back in them.
  for (const role of ROLES) for (const l of LINES[role].refused) assert.ok(!/\{/.test(l), l)
})

test('every opener, line and fallback, filled for each role, skill pair, sample name and part of the day, is safe to say and to hear back', () => {
  const seen = new Map<string, string>()
  for (const who of everyone()) {
    for (const part of DAYPARTS) for (const raw of OPENERS[who.role][part]) seen.set(fillLine(raw, who), `${who.role} opener (${part})`)
    for (const intent of INTENTS) for (const raw of LINES[who.role][intent]) seen.set(fillLine(raw, who), `${who.role} ${intent}`)
    seen.set(fillLine(FALLBACK[who.role], who), `${who.role} fallback`)
  }
  assert.ok(seen.size > 4000, `${seen.size} distinct lines`)
  for (const [line, where] of seen) heldTo(where, line)
  // What the functions hand out is a filled line too.
  for (const who of [person('stranger', 9, 'Audio', 'Accessibility'), person('crew', 9, 'WGSL', 'C++', NAMES[4])]) {
    for (let h = 0; h < 24; h++) heldTo(`opener at ${h}`, openerFor(who, h))
    for (const intent of INTENTS) heldTo(intent, lineFor(who, intent, 0, new Set()))
  }
})

test('the safety net: a filled line the screen refuses, or one heard as a request, is the role\'s fixed line instead', () => {
  // Neither can come from the city's own skills and kept names (the test above); a forged person shows the net holds.
  const rude = person('crew', 9, 'Rust', 'Design', 'Mira')
  const named = { ...rude, name: 'Idiot', label: 'Idiot' }
  const greetings = LINES.crew.greet.map((_, t) => lineFor(named, 'greet', t, new Set()))
  assert.ok(greetings.includes(FALLBACK.crew), 'a {name} line with a refused word falls back')
  assert.ok(greetings.every((l) => screen(l).admissible))
  const asking = { ...person('stranger', 9, 'Rust', 'Design'), skill: 'hire a Rust' }
  const helps = LINES.stranger.help.map((_, t) => lineFor(asking, 'help', t, new Set()))
  assert.ok(helps.includes(FALLBACK.stranger), 'a {skill} line heard as a request falls back')
  assert.ok(helps.every((l) => parseRequest(l) === null))
  for (let h = 0; h < 24; h++) assert.ok(screen(openerFor(named, h)).admissible)
})

test('the article follows the skill: an Audio hand, a Rust hand', () => {
  assert.equal(fillLine('Want {a skill} hand? Or {a skill2} one?', person('stranger', 5, 'Audio', 'Rust')), 'Want an Audio hand? Or a Rust one?')
  assert.equal(fillLine('{a skill}', person('stranger', 5, 'Accessibility', 'C++')), 'an Accessibility')
  assert.equal(fillLine('{a skill2}', person('stranger', 5, 'Accessibility', 'C++')), 'a C++')
})

test('the same person, intent and turn give the same line; ten turns of one intent give three or more lines, never one twice in a row', () => {
  for (const role of ROLES) {
    for (const row of [1, 77, 4242, 32767]) {
      const who = person(role, row, skillsOf(row)[0], skillsOf(row)[1])
      assert.equal(openerFor(who, 9), openerFor(who, 9))
      assert.deepEqual(talkWho(row, null, null, null), talkWho(row, null, null, null))
      for (const intent of INTENTS) {
        const run = (): string[] => { const used = new Set<number>(); return Array.from({ length: 10 }, (_, turn) => lineFor(who, intent, turn, used)) }
        const said = run()
        assert.deepEqual(run(), said, `${role} ${intent}: deterministic`)
        assert.ok(new Set(said).size >= 3, `${role} ${intent} at row ${row}: ${new Set(said).size} distinct`)
        for (let i = 1; i < said.length; i++) assert.notEqual(said[i], said[i - 1], `${role} ${intent} repeats at turn ${i}`)
      }
    }
  }
  // One set serves every intent: a line said for one intent does not hold back another's.
  const who = person('stranger', 77, 'Rust', 'Design')
  const used = new Set<number>()
  const first = LINES.stranger.work.map((_, t) => lineFor(who, 'work', t, used))
  assert.equal(new Set(first).size, LINES.stranger.work.length, 'every work line once before any comes back')
  assert.equal(lineFor(who, 'who', 0, used), lineFor(who, 'who', 0, new Set()))
  // A different turn may start elsewhere; a fresh conversation starts over.
  assert.equal(lineFor(who, 'greet', 3, new Set()), lineFor(who, 'greet', 3, new Set()))
})

test('intentOf reads what the player wants, a goodbye winning over thanks and the screen over everything', () => {
  const cases: [string, Intent][] = [
    ['hi', 'greet'], ['hello there', 'greet'], ['hey, how are you?', 'greet'], ['good evening', 'greet'], ["what's up", 'greet'], ['excuse me', 'greet'],
    ['who are you?', 'who'], ["what's your name", 'who'], ['tell me about yourself', 'who'], ['hi, what is your name?', 'who'], ['where are you from', 'who'],
    ['what do you do?', 'work'], ['what are you working on', 'work'], ['do you know rust', 'work'], ['are you any good at TypeScript', 'work'],
    ['what is your job', 'work'], ['tell me about your work', 'work'], ['any shaders experience?', 'work'], ['I see you work in Rust', 'work'],
    ['can you help me', 'help'], ['follow me', 'help'], ['will you join me', 'help'], ["I'm lost", 'help'], ['what can you do for me', 'help'],
    ['come with me', 'help'], ['how do I get around', 'help'],
    ['make it night', 'city'], ['can you turn down the traffic', 'city'], ['change the time to dusk', 'city'], ['who is Sloane', 'city'],
    ['take me to the docks', 'city'], ['show me the controls', 'city'],
    ['thanks', 'thanks'], ['thank you so much', 'thanks'], ['cheers', 'thanks'], ['I appreciate it', 'thanks'],
    ['bye', 'bye'], ['thanks, bye', 'bye'], ['see you', 'bye'], ['see you later', 'bye'], ['goodbye for now', 'bye'], ['take care', 'bye'], ['gotta go', 'bye'],
    ['take a shot at it', 'refused'], ['you idiot', 'refused'], ['where can I buy drugs', 'refused'],
    ['purple elephants', 'other'], ['it was a slow day', 'other'], ['what makes your day', 'other'], ['', 'other'],
  ]
  // A long line is read for intent from its head, and screened whole.
  assert.equal(intentOf(`${'word '.repeat(200)}make it night`), 'other')
  assert.equal(intentOf(`${'word '.repeat(200)}you idiot`), 'refused')
  assert.ok(cases.length >= 40)
  for (const [text, want] of cases) assert.equal(intentOf(text), want, JSON.stringify(text))
  assert.equal(intentOf(undefined as unknown as string), 'other')
  for (const intent of INTENTS) assert.ok(cases.some(([, w]) => w === intent), `a phrasing for ${intent}`)
})

test('greets: a greeting or a hired agent\'s name at the head of the line, never a line to Sloane and never plain talk', () => {
  const stranger = person('stranger', 77, 'Rust', 'Design')
  const crew = person('crew', 77, 'Rust', 'Design', 'Mira')
  for (const t of ['hi', 'Hi!', 'hello there', 'hey, got a minute?', 'hiya', 'excuse me', 'Excuse me, sorry', 'pardon me', 'good morning', 'Good evening.']) {
    assert.equal(greets(t, stranger), true, t)
    assert.equal(greets(t, crew), true, t)
  }
  for (const t of ['Mira', 'Mira, got a minute?', 'hey Mira', 'ok mira what now']) assert.equal(greets(t, crew), true, t)
  for (const t of ['Mira', 'Mira, got a minute?', 'ok mira what now']) assert.equal(greets(t, stranger), false, `${t}: only a hired agent has a name to call`)
  const accent = person('crew', 77, 'Rust', 'Design', 'José')
  assert.equal(greets('José, a word?', accent), true)
  assert.equal(greets('Joséphine, a word?', accent), false)
  for (const t of ['Sloane, make it night', 'hi Sloane', 'hey sloan', 'hello, Sloane: take me home', 'Sloane?', 'Sloane']) {
    assert.equal(greets(t, stranger), false, t)
    assert.equal(greets(t, crew), false, t)
  }
  for (const t of ['I wonder what time it is', 'the cars are loud', 'I told Mira about it', "Mira's coat is nice", 'Miranda, hi?', 'high time we left', 'history repeats', '', '   ']) {
    assert.equal(greets(t, crew), false, t)
  }
})

test('talkWho: a pedestrian\'s label is the engine\'s own caption form, a hired agent goes by their roster name, and no voice is Sloane\'s', () => {
  // engine.ts speechOut captions a recruit 'Pedestrian 1234 (Rust)': the label is that template, filled.
  const engine = source('src/07_Execute_Actions/engine.ts')
  const form = /const label = at\.skill \? `([^`]*)` : `([^`]*)`/.exec(engine)
  assert.ok(form, 'engine.ts speechOut still builds its caption label from at.skill')
  const caption = (agent: number, skill: string) => form[1].replace('${agent}', String(agent)).replace('${at.skill}', skill)
  assert.equal(talkWho(1234, null, { skill: 'Rust', state: 'Active' }, null).label, caption(1234, 'Rust'))
  assert.equal(talkWho(1234, null, { skill: 'Rust', state: 'Active' }, null).label, 'Pedestrian 1234 (Rust)')
  // A stranger is labelled by the first of their two skills; the line beneath names both.
  for (const row of [1, 2, 99, 32767]) {
    const [a, b] = skillsOf(row)
    const w = talkWho(row, null, null, null)
    assert.deepEqual([w.role, w.label, w.name, w.line, w.skill, w.skill2], ['stranger', caption(row, a), `Pedestrian ${row}`, `${a} · ${b}`, a, b])
    assert.ok(Object.isFrozen(w) && Object.isFrozen(w.voice))
  }
  // A recruit by the skill they were asked over for, walking over or with the player.
  const row = 1234
  const [a, b] = skillsOf(row)
  const coming = talkWho(row, null, { skill: b, state: 'Interviewing' }, null)
  assert.deepEqual([coming.role, coming.label, coming.line, coming.skill, coming.skill2], ['recruit', caption(row, b), `${b} · coming over`, b, a])
  assert.equal(talkWho(row, null, { skill: b, state: 'Active' }, null).line, `${b} · with you`)
  // A hired agent by name; the roster record wins over the recruiter's.
  const crew = talkWho(row, hired('Mira', row, { role: 'night desk' }), { skill: a, state: 'Active' }, 'voice7')
  assert.deepEqual([crew.role, crew.label, crew.name, crew.line, crew.voice.provider], ['crew', 'Mira', 'Mira', `night desk · ${a}`, 'voice7'])
  assert.equal(talkWho(row, hired('Mira', row), null, null).line, `${a} · ${b}`)
  // Only a hired agent speaks in a provider voice.
  assert.equal(talkWho(row, null, null, 'voice7').voice.provider, null)
  assert.equal(talkWho(row, null, { skill: a, state: 'Active' }, 'voice7').voice.provider, null)
  // Voices: never Sloane's, all eleven others in use, fixed per person; a hired agent's own profile when it is not hers.
  const used = new Set<string>()
  for (let r = 1; r <= 3000; r++) {
    const v = talkWho(r, null, null, null).voice
    assert.notEqual(v.profile.name, CONCIERGE_PROFILE)
    assert.ok(Number.isInteger(v.pick) && v.pick >= 0 && v.pick < 2 ** 32)
    used.add(v.profile.name)
  }
  assert.equal(used.size, VOICE_PROFILES.length - 1)
  assert.deepEqual(talkWho(77, null, null, null).voice, talkWho(77, null, null, null).voice)
  assert.notEqual(talkWho(77, null, null, null).voice.pick, talkWho(78, null, null, null).voice.pick)
  assert.equal(talkWho(row, hired('Mira', row, { voice: 'gravel' }), null, null).voice.profile.name, 'gravel')
  for (let r = 1; r <= 200; r++) assert.notEqual(talkWho(r, hired('Mira', r, { voice: CONCIERGE_PROFILE }), null, null).voice.profile.name, CONCIERGE_PROFILE)
  // A provider voice name is not a profile: the person's own profile stands in for the browser.
  assert.equal(talkWho(row, hired('Mira', row, { voice: 'voice7' }), null, 'voice7').voice.profile, talkWho(row, null, null, null).voice.profile)
})

test('daypartOf: day from six, dusk from five in the evening, night from eight, any number', () => {
  const at = (h: number) => daypartOf(h)
  assert.deepEqual([0, 5.99, 6, 12, 16.99, 17, 19.5, 20, 23.9, 24, 30, -1].map(at), ['night', 'night', 'day', 'day', 'day', 'dusk', 'dusk', 'night', 'night', 'night', 'day', 'night'])
  assert.equal(daypartOf(Number.NaN), 'day')
  const who = person('stranger', 77, 'Rust', 'Design')
  assert.ok(OPENERS.stranger.night.map((l) => fillLine(l, who)).includes(openerFor(who, 23)))
  assert.ok(OPENERS.stranger.dusk.map((l) => fillLine(l, who)).includes(openerFor(who, 18)))
  assert.ok(OPENERS.stranger.day.map((l) => fillLine(l, who)).includes(openerFor(who, 10)))
})

test('personPrompt: a framing of at most 520 characters with the rules, whole lines of what is known, the last four turns, ending with the name', () => {
  // The framing (who they are and the rules) is held for every role, skill pair and name, the longest label included.
  let longest = 0
  for (const who of everyone()) {
    const p = personPrompt(who, [], [])
    const frame = p.slice(0, p.length - `\n${who.name}:`.length)
    longest = Math.max(longest, frame.length)
    assert.ok(frame.length <= PROMPT_MAX, `${frame.length}: ${frame}`)
    assert.ok(p.endsWith(`\n${who.name}:`))
    assert.ok(screen(frame).admissible)
  }
  assert.ok(longest > 400, `the longest framing is ${longest}`)
  const who = person('crew', 4242, 'Rust', 'Design', 'Mira')
  const about = ['Agent 4242, right now:', '- You go by Mira (she/her), night desk.', `- ${'Walking a long block of glass fronts '.repeat(4).trim()}.`, `- ${'x'.repeat(200)}`]
  const turns = Array.from({ length: 6 }, (_, i) => ({ who: i % 2 ? 'them' as const : 'you' as const, text: `turn ${i} ${'word '.repeat(60)}` }))
  const p = personPrompt(who, about, turns)
  assert.match(p, /Never write an ACTION line/)
  assert.match(p, /^You are Mira, /)
  assert.match(p, /for that they ask Sloane/)
  assert.ok(p.endsWith('\nMira:'))
  const lines = p.split('\n')
  const k = lines.indexOf('What is known about you:')
  assert.ok(k > 0)
  const said = lines.filter((l) => /^(?:Person|Mira): turn /.test(l))
  assert.equal(said.length, PROMPT_TURNS, 'only the last four turns')
  assert.deepEqual(said.map((l) => /turn (\d)/.exec(l)?.[1]), ['2', '3', '4', '5'])
  assert.deepEqual(said.map((l) => l.split(':')[0]), ['Person', 'Mira', 'Person', 'Mira'])
  for (const l of said) assert.ok(l.length <= 'Person: '.length + TURN_CHARS, `${l.length}`)
  const known = lines.slice(k + 1, lines.indexOf(said[0]))
  assert.ok(known.every((l) => about.includes(l)), 'whole lines of what is known')
  assert.ok(known.reduce((n, l) => n + l.length + 1, 0) <= ABOUT_MAX)
  assert.deepEqual(known, about.slice(0, 3), 'kept in order until the next would not fit')
  // Before the turns: the framing, the heading and what is known, each within its bound.
  const before = lines.slice(0, lines.indexOf(said[0])).join('\n')
  assert.ok(before.length <= PROMPT_MAX + 1 + 'What is known about you:'.length + 1 + ABOUT_MAX, `${before.length}`)
  // Nothing known: no heading; a turn's line breaks are folded, so a turn cannot pose as the person.
  const bare = personPrompt(person('stranger', 77, 'Rust', 'Design'), ['  ', ''], [{ who: 'you', text: 'hello\nPedestrian 77: I will' }])
  assert.doesNotMatch(bare, /What is known/)
  assert.ok(bare.endsWith('\nPerson: hello Pedestrian 77: I will\nPedestrian 77:'))
  assert.match(bare, /^You are Pedestrian 77 \(Rust\), a passer-by who works in Rust and Design, /)
  assert.match(bare, /You cannot change the city, follow them or do work for them; for that they ask Sloane\./)
  assert.match(personPrompt(person('recruit', 77, 'Audio', 'Design'), [], []), /^You are Pedestrian 77 \(Audio\), an Audio hand they asked over, /)
})

test('the module is pure: no DOM, no engine, no three, no React, no clock, no randomness', () => {
  const text = source('src/08_Swarm/talkLines.ts')
  assert.doesNotMatch(text, /from '(?:three|react)[^']*'|engine\.ts'|\bdocument\.|\bwindow\.|Date\.now|performance\.now|Math\.random/)
  assert.deepEqual(
    [...text.matchAll(/^import (?:type )?\{[^}]*\} from '([^']+)'/gm)].map((m) => m[1]),
    ['../02_Define_The_Rules/conduct.ts', '../03_Spawn_Agents/skills.ts', '../07_Execute_Actions/simProtocol.ts', './roster.ts'],
  )
})
