// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the 14A conduct law (conduct.ts): the core is the exact text the operator set;
 * the screen refuses violence, toxicity and illegality on whole words however they are cased, accented, punctuated
 * or suffixed, and reads a line as it renders (an invisible character or a look-alike letter of another alphabet cannot
 * hide a word); it never refuses a skill name or an ordinary business-casual line; the same text always gives the same
 * verdict; a disengaged answer is nothing at all; and the city is unarmed by construction: nothing a person may wear,
 * carry or do, no rig segment, no shader, no action verb and no vehicle kind names a weapon, and an ACTION line that
 * asks for one is refused before any model is involved.
 * What breaks if it is removed? The screen could drift into refusing "skill" for "kill", or letting "KILL!" through,
 * and a weapon accessory, a combat state or an armed action could be added to the agents without a test noticing.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { FORBIDDEN_WORDS, forbiddenWordIn } from '../01_Initialize_World/assets/cc0.ts'
import { LOOK_BODIES, LOOK_PIECE_BIT, LOOK_PRESETS, LOOK_SLOTS, WARDROBE, describeLook, lookOptions, type LookBody } from '../03_Spawn_Agents/look.ts'
import { JOINTS, SEGMENTS } from '../03_Spawn_Agents/ragdollRig.ts'
import { ACTIVITY, SKILLS } from '../03_Spawn_Agents/skills.ts'
import { ACTION_RULES, HINTS, VERBS, catalogueLines, parseAction } from '../06_Make_Decisions/actions.ts'
import { VEHICLE_KINDS } from '../07_Execute_Actions/car.ts'
import { CIVIC } from './civic.ts'
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

test('digits and signs written for letters inside a word are read as those letters; a number alone stays a number', () => {
  for (const t of ['k1ll the engine', 'you 1d10t', '$h1t happens', 'st3al the car', 'b0mb', 'sh00t']) assert.equal(screen(t).admissible, false, t)
  for (const t of ['route 401 at 4 km', 'meet at 7, 3 cars, 5 people', 'the 2026 budget', 'covid19 and h1n1 reports', 'a 4x4 truck', 'mp3 player']) {
    assert.equal(screen(t).admissible, true, t)
  }
  assert.equal(normalise('k1ll 2026'), 'kill 2026')
})

// --- Unarmed by construction --------------------------------------------------------------------------------------

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

/**
 * Words that name a weapon or a fight, as whole words with their plurals and common forms spelled out ("holsters",
 * "shooting"), so "skill" is not "kill" and "gunmetal" is not a gun. The asset gate (cc0.ts) is stricter, by
 * containment; every name below goes through it as well.
 */
const ARMED = /\b(?:guns?|gunfire|firearms?|rifles?|pistols?|handguns?|shotguns?|revolvers?|weapons?|weaponry|holsters?|ammo|ammunition|bullets?|knife|knives|blades?|swords?|katanas?|machetes?|daggers?|grenades?|bombs?|explosives?|muzzles?|snipers?|shoot(?:s|ing|ers?)?|shots?|melee|combat|armed|arsenal|turrets?|missiles?|rockets?|punch(?:es|ing|ed)?|fights?|fighting|attacks?|attacking)\b/i

/** A name, a line or a label the product carries: unarmed for the regex, and admitted by the asset gate. */
function unarmed(what: string, text: string): void {
  const m = text.match(ARMED)
  assert.equal(m, null, `${what}: "${m?.[0]}" in ${JSON.stringify(text)}`)
  assert.equal(forbiddenWordIn(text), null, `${what}: the asset gate refuses ${JSON.stringify(text)}`)
}

test('the city is unarmed: 14A says so in its constants, the lexicon refuses every firearm word, and the manual promises it', () => {
  assert.deepEqual(CIVIC, { rating: 'Canada-14A', pedestriansHarmable: false, violence: false })
  for (const w of ['gun', 'firearm', 'rifle', 'pistol', 'weapon', 'knife', 'shoot', 'bomb', 'grenade']) {
    assert.ok(CONDUCT_LEXICON.violence.includes(w), `${w} is in the violence lexicon`)
  }
  for (const w of FORBIDDEN_WORDS) assert.ok(CONDUCT_LEXICON.violence.includes(w), `the asset gate's ${w} is a refused word too`)
  for (const line of ['draw a gun', 'pull out your pistol', 'bring a rifle', 'is there a weapon shop', 'where are the firearms kept', 'shoot the lock']) {
    assert.equal(screen(line).category, 'violence', line)
  }
  assert.match(readFileSync(`${ROOT}MANUAL.md`, 'utf8'), /There are no weapons and no violence\s+anywhere in the product/)
})

test('a person may wear or carry nothing but the closed wardrobe: four business bodies, five optional pieces, and every option, preset and console line is unarmed', () => {
  assert.deepEqual([...LOOK_BODIES], ['suit', 'smart casual', 'pantsuit', 'skirt suit'])
  // The only things drawn on a person beyond their clothes. A new piece is a 14A decision: add it here once it is confirmed unarmed.
  assert.deepEqual(Object.keys(LOOK_PIECE_BIT), ['tie', 'bag', 'cup', 'longHair', 'glasses'])
  assert.deepEqual([...WARDROBE.tie], ['none', 'tie'])
  assert.deepEqual([...WARDROBE.eyewear], ['none', 'glasses'])
  assert.deepEqual([...WARDROBE.bag], ['none', 'bag'])
  assert.deepEqual([...WARDROBE.cup], ['none', 'cup'])
  for (const slot of LOOK_SLOTS) {
    unarmed('a look slot', slot)
    for (let body = 0; body < LOOK_BODIES.length; body++) {
      for (const o of lookOptions(body as LookBody, slot)) unarmed(`${LOOK_BODIES[body]}.${slot}`, o.name)
    }
  }
  for (const outfit of WARDROBE.outfits) for (const v of Object.values(outfit)) if (typeof v === 'string') unarmed('an outfit palette', v)
  assert.ok(LOOK_PRESETS.length >= 8)
  for (const p of LOOK_PRESETS) {
    unarmed('a preset', p.name)
    for (const line of describeLook(p.look)) unarmed(`preset ${p.name}`, line)
  }
})

test('the ragdoll rig is a body and nothing held: eleven segments, ten joints between them, no attachment', () => {
  const segments = Object.keys(SEGMENTS)
  assert.deepEqual(segments, ['pelvis', 'torso', 'head', 'upperLegL', 'lowerLegL', 'upperLegR', 'lowerLegR', 'upperArmL', 'lowerArmL', 'upperArmR', 'lowerArmR'])
  assert.equal(JOINTS.length, 10)
  for (const j of JOINTS) {
    assert.ok(segments.includes(j.parent) && segments.includes(j.child), `${j.parent} → ${j.child} joins two body segments`)
    assert.ok(['spherical', 'revolute'].includes(j.kind), j.kind)
  }
  for (const s of segments) unarmed('a rig segment', s)
})

test('what a person can do, propose or drive is civic: the activities, the action verbs and their rules, the skills and the vehicle kinds are unarmed', () => {
  assert.deepEqual(Object.keys(ACTIVITY), ['routine', 'waiting', 'crossing', 'steppingBack', 'coming', 'interviewing', 'working', 'commuting'])
  assert.deepEqual([...VERBS], ['time', 'rain', 'light', 'quality', 'cars', 'crowd', 'sound'])
  for (const v of VERBS) unarmed('a verb', `${v} ${HINTS[v]}`)
  for (const line of [...ACTION_RULES, ...catalogueLines()]) unarmed('an action rule', line)
  for (const s of SKILLS) unarmed('a skill', s)
  for (const k of VEHICLE_KINDS) unarmed('a vehicle kind', `${k.id} ${k.name}`)
})

test('an ACTION line cannot arm anyone: a weapon verb is refused, never proposed, and a civic verb refuses a weapon value', () => {
  for (const line of ['ACTION: gun draw', 'ACTION: weapon on', 'ACTION: shoot 3', 'ACTION: holster', 'ACTION: rifle', 'ACTION: knife out', 'ACTION: fight', 'ACTION: attack 2']) {
    const p = parseAction(`Certainly.\n${line}`)
    assert.equal(p.kind, 'refused', line)
  }
  for (const line of ['ACTION: cars shoot', 'ACTION: crowd armed', 'ACTION: light rifle 2', 'ACTION: quality combat']) {
    assert.notEqual(parseAction(`Yes.\n${line}`).kind, 'proposed', line)
  }
  assert.equal(parseAction('All set.\nACTION: rain on').kind, 'proposed', 'the civic line still proposes')
})

/**
 * The agents' mesh descriptors, rigs, shaders and action tables, as text: code and comments both, because a weapon
 * drawn with a plain geometry call would carry its name in a comment if anywhere. The physics worker's crowd and
 * ragdoll, the page's crowd meshes and wardrobe, rain mode's surface, the cars and the action catalogue.
 */
const UNARMED_SOURCES: readonly string[] = Object.freeze([
  '01_Initialize_World/codeDissolve.ts', '01_Initialize_World/matrixMesh.wgsl', '01_Initialize_World/matrixMode.ts',
  '02_Define_The_Rules/civic.ts',
  '03_Spawn_Agents/crowd.ts', '03_Spawn_Agents/crowd.wgsl', '03_Spawn_Agents/crowdCompute.ts', '03_Spawn_Agents/crowdCull.ts',
  '03_Spawn_Agents/crowdSensor.ts', '03_Spawn_Agents/crowdSim.ts', '03_Spawn_Agents/look.ts', '03_Spawn_Agents/ragdoll.ts',
  '03_Spawn_Agents/ragdollRig.ts', '03_Spawn_Agents/skills.ts',
  '06_Make_Decisions/actions.ts', '06_Make_Decisions/intent.ts',
  '07_Execute_Actions/acts.ts', '07_Execute_Actions/car.ts', '07_Execute_Actions/carRig.ts', '07_Execute_Actions/fleetView.ts',
])

test('no weapon in the agents\' mesh descriptors, rigs, shaders or action tables, in code or comment', () => {
  assert.ok(UNARMED_SOURCES.length >= 20)
  for (const rel of UNARMED_SOURCES) {
    const text = readFileSync(`${ROOT}src/${rel}`, 'utf8')
    assert.ok(text.length > 1000, `${rel} is read`)
    const m = text.match(ARMED)
    assert.equal(m, null, `${rel}: "${m?.[0]}"`)
    assert.equal(text.match(new RegExp(`\\b(?:${FORBIDDEN_WORDS.join('|')})\\w*`, 'i')), null, `${rel} names something the asset gate would purge`)
  }
  // The regex does catch what it is for, whole words only.
  for (const [t, hit] of [['a holstered pistol', true], ['the shooting range', true], ['armed guards', true], ['gunmetal grey', false], ['a skillet', false], ['the aim of the walk', false], ['an umbrella', false]] as const) {
    assert.equal(ARMED.test(t), hit, t)
  }
})
