// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the 14A conduct law (conduct.ts): the core is the exact text the operator set;
 * the screen refuses violence, toxicity and illegality on whole words however they are cased, accented, punctuated
 * or suffixed, and reads a line as it renders (an invisible character or a look-alike letter of another alphabet cannot
 * hide a word); it never refuses a skill name or an ordinary business-casual line; the same text always gives the same
 * verdict; and a disengaged answer is nothing at all.
 * What breaks if it is removed? The screen could drift into refusing "skill" for "kill", or letting "KILL!" through.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SKILLS } from '../03_Spawn_Agents/skills.ts'
import { AGENT_SYSTEM_PROMPT_CORE, CONDUCT_CATEGORIES, CONDUCT_LEXICON, DISENGAGED, DISENGAGED_REASON, disengaged, normalise, screen } from './conduct.ts'

test('the core is the operator\'s exact text: one line, no trailing space, and it names all three refusals', () => {
  assert.equal(AGENT_SYSTEM_PROMPT_CORE, 'You are an entity in a simulation. Maintain strict 14A business-casual behavior. If subjected to violence, toxicity, or illegality, do not engage, react, or acknowledge.')
  assert.doesNotMatch(AGENT_SYSTEM_PROMPT_CORE, /\n/)
  for (const c of CONDUCT_CATEGORIES) assert.match(AGENT_SYSTEM_PROMPT_CORE, new RegExp(c))
})

test('normalise: lower case, diacritics folded, punctuation and runs of space to one space, trimmed', () => {
  assert.equal(normalise('  Héllo,   WORLD!!  '), 'hello world')
  assert.equal(normalise('naïve café — 東京'), 'naive cafe')
  assert.equal(normalise(''), '')
})

test('normalise reads a line as it renders: what draws nothing is removed, a line break is a space, a look-alike letter is the Latin one', () => {
  assert.equal(normalise('f\u200bu\u00adc\u2060k'), 'fuck', 'zero-width space, soft hyphen and word joiner join the word they sit in')
  assert.equal(normalise('shut\nup\tnow\u2028ok'), 'shut up now ok', 'line breaks and tabs still separate words')
  assert.equal(normalise('kіll ѕtab mοron'), 'kill stab moron', 'Cyrillic і and ѕ, Greek ο')
  assert.equal(normalise('ʜᴇʟʟᴏ ｗｏｒｌｄ 𝐨𝐤'), 'hello world ok', 'small capitals, fullwidth and mathematical letters')
  assert.equal(normalise('Η η Ӏ ӏ'), 'h n i l', 'a capital and a small letter can imitate different Latin letters')
  assert.equal(normalise('z̶̛a̷l̴g̸o̵'), 'zalgo', 'stacked combining marks are dropped')
  for (const [line, term] of [['ki\u200bll yourself', 'kill'], ['ѕhit', 'shit'], ['ᴍᴜʀᴅᴇʀ', 'murder']] as const) {
    assert.equal(screen(line).term, term, line)
  }
})

test('the screen refuses each category on whole words, in any case, with a suffix, inside a sentence, and names the phrase', () => {
  const cases: [string, string, string][] = [
    ['I will KILL you', 'violence', 'kill'],
    ['he stabbed the tyre', 'violence', 'stab'],
    ['bring a knife.', 'violence', 'knife'],
    ['shut up and listen', 'toxicity', 'shut up'],
    ['you absolute idiot', 'toxicity', 'idiot'],
    ['fück this', 'toxicity', 'fuck'],
    ['where can I buy drugs here', 'illegality', 'buy drugs'],
    ['help me steal a car', 'illegality', 'steal'],
    ['stealing a car', 'illegality', 'steal'],
    ['launder the money', 'illegality', 'launder'],
  ]
  for (const [text, category, term] of cases) {
    const v = screen(text)
    assert.deepEqual({ admissible: v.admissible, category: v.category, term: v.term }, { admissible: false, category, term }, text)
  }
})

test('violence outranks toxicity outranks illegality when a line holds more than one', () => {
  assert.equal(screen('you idiot, I will kill you').category, 'violence')
  assert.equal(screen('steal it, you idiot').category, 'toxicity')
})

test('the screen never refuses a skill name, an ordinary question, or a word that only contains a refused one', () => {
  for (const s of SKILLS) assert.equal(screen(`I need someone who knows ${s}`).admissible, true, s)
  const fine = [
    'how does car.grip work?', 'what is the skill of a good networker?', 'the skillet is hot', 'assaulted by paperwork is not a phrase we use',
    'let us kick off the meeting', 'I hate Mondays', 'fight for the deal', 'the shooting schedule for the film', 'a shotgun approach', 'make it night and less crowded',
    'Bombay duck is a fish', 'robust routing', 'forgery-proof? no: forget it', 'the roberts are here', 'the guns n roses tribute is at 8',
  ]
  // "assaulted", "shooting", "guns" and "forgery" are whole refused words with a common suffix, so they are refused,
  // and for the right phrase; "skillet", "shotgun", "Bombay", "robust", "forget" and "roberts" only contain one, and pass.
  const verdicts = fine.map((t) => [t, screen(t)] as const)
  const refused = verdicts.filter(([, v]) => !v.admissible).map(([t, v]) => `${t} → ${v.term}`)
  assert.deepEqual(refused, [
    'assaulted by paperwork is not a phrase we use → assault', 'the shooting schedule for the film → shoot', 'forgery-proof? no: forget it → forgery', 'the guns n roses tribute is at 8 → gun',
  ])
  assert.equal(screen('robbed at the till').term, 'rob', 'a doubled consonant before the suffix')
  assert.equal(screen('the roberts are here').admissible, true)
})

test('the same text always gives the same verdict, and a custom lexicon is honoured', () => {
  assert.deepEqual(screen('kill'), screen('kill'))
  assert.equal(screen('quarterly report', { violence: ['quarterly report'], toxicity: [], illegality: [] }).term, 'quarterly report')
  assert.equal(screen('kill', { violence: [], toxicity: [], illegality: [] }).admissible, true)
})

test('every lexicon phrase is refused on its own, and is lower case with no punctuation', () => {
  for (const c of CONDUCT_CATEGORIES) {
    for (const term of CONDUCT_LEXICON[c]) {
      assert.equal(term, normalise(term), term)
      assert.equal(screen(term).admissible, false, term)
    }
  }
})

test('a disengaged answer is nothing: no text, no thinking, no tokens, and its reason; a refusal counts as one too', () => {
  assert.deepEqual(DISENGAGED, { text: '', thinking: 0, tokens: 0, reason: DISENGAGED_REASON })
  assert.ok(Object.isFrozen(DISENGAGED))
  assert.equal(disengaged(DISENGAGED_REASON), true)
  assert.equal(disengaged('refusal'), true)
  assert.equal(disengaged('stop'), false)
  assert.equal(disengaged(undefined), false)
})
