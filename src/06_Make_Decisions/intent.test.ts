// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the Concierge's 5-Whys engine: which control each plain-language goal
 * maps to (the taxonomy table), which why-question is asked per category and depth, that questions stop
 * as soon as the mapping is unambiguous and never exceed five, that chips and free text both resolve,
 * that the same goal and answers always give the same brief (deterministic, offline), the copyable
 * markdown brief itself, and the content rules: 14A wording, no syntax or module paths in anything the
 * card shows, every module the brief names exists.
 * What breaks if it is removed? A goal could quietly start mapping to the wrong control, a why-chain could
 * loop past five, or a module path could leak into the card, and nothing would notice.
 */
import assert from 'node:assert/strict'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { LITE_TIER, PEAK_TIER } from '../05_Observe_Environment/governor.ts'
import { classify, FiveWhys, GOAL_MAX, MAX_WHYS, timeName, type Brief, type Control, type PlanStep } from './intent.ts'

const SRC = resolve(import.meta.dirname, '..')

/** Controls and values a goal must map to, strongest first (confidence is not pinned, order is). */
const CLASSES: readonly [goal: string, ...expected: (Control | `${Control}=${string}`)[]][] = [
  // Time of day.
  ['make it night', 'time=22'], ['dark', 'time=22'], ['after dark', 'time=22'], ['evening', 'time=20'],
  ['morning', 'time=8'], ['noon', 'time=12'], ['midday', 'time=12'], ['golden hour', 'time=17.4'], ['warm light', 'time=17.4'],
  ['sunset', 'time=18'], ['dusk', 'time=18.5'], ['dawn', 'time=6.25'], ['midnight', 'time=0'], ['make it day', 'time=12'],
  ['set the clock to 21:30', 'time=21.5'], ['9pm', 'time=21'], ['9 am', 'time=9'], ['6 o\'clock', 'time=18'], ['17h', 'time=17'],
  ['change the time of day', 'time'],
  // A complaint about the light asks for its opposite.
  ['it is too dark', 'time=12'], ['too dim', 'time=12'], ['turn the lights on', 'time=12'], ['too bright', 'time=20'], ['dim it', 'time=20'],
  // Crowd density.
  ['busy', 'crowd=more'], ['crowded', 'crowd=more'], ['packed', 'crowd=more'], ['more people', 'crowd=more'], ['lively', 'crowd=more'],
  ['empty', 'crowd=none'], ['nobody about', 'crowd=none'], ['be alone', 'crowd=none'], ['fewer people', 'crowd=fewer'],
  ['too crowded', 'crowd=fewer'], ['people', 'crowd'],
  ['quiet', 'crowd=fewer', 'audio=30'], ['quiet please', 'crowd=fewer', 'audio=30'],
  // Traffic.
  ['more cars', 'cars=more'], ['rush hour', 'cars=more'], ['fewer cars', 'cars=fewer'], ['less traffic', 'cars=fewer'],
  ['no traffic', 'cars=none'], ['empty roads', 'cars=none'], ['stop the traffic', 'cars=none'], ['traffic', 'cars'], ['noisy', 'audio=30', 'cars=fewer'],
  // Roads are traffic even when the word is "quieter" or "calm"; a bare noun never loses a value already read.
  ['quieter roads', 'cars=fewer'], ['calm the roads', 'cars=fewer'], ['calmer traffic', 'cars=fewer'], ['noisy roads', 'cars=fewer', 'audio=30'],
  // Performance.
  ['it feels laggy', 'quality'], ['lag', 'quality'], ['stutter', 'quality'], ['smoother', 'quality'], ['faster', 'quality'],
  ['runs slow', 'quality'], ['run faster', 'quality'], ['speed it up', 'quality'], ['battery', 'quality=1'], ['my phone is hot', 'quality=1'],
  ['ultra', 'quality=4'], ['prettier', 'quality=4'], ['low quality', 'quality=1'], ['auto quality', 'quality=auto'],
  // Peak, above Ultra, only when named; "max" and "best" stay Ultra.
  ['peak quality', 'quality=5'], ['peak graphics', 'quality=5'], ['beyond ultra', 'quality=5'], ['set quality beyond ultra', 'quality=5'],
  ['max quality', 'quality=4'], ['best graphics', 'quality=4'],
  // Peak beside heat or a slow frame keeps that fix's Low; Peak turned down is Ultra (a ceiling: stepFor).
  ['my phone is hot on peak graphics', 'quality=1'], ['battery dies fast with peak quality', 'quality=1'],
  ['the fans spin up on peak settings', 'quality=1'], ['turn off peak graphics', 'quality=4'], ['disable peak quality', 'quality=4'],
  ['lower from peak quality', 'quality=4'], ["don't go beyond ultra", 'quality=4'], ['nothing above ultra please', 'quality=4'],
  ['peak graphics off', 'quality=4'], ["i don't want peak graphics", 'quality=4'], ['do not go above ultra', 'quality=4'],
  ['reduce peak quality', 'quality=4'], ['avoid peak graphics', 'quality=4'], ['peak graphics is too heavy', 'quality=4'],
  ['nothing really above ultra', 'quality=4'],
  // Peak only for a plain ask: "peak" in its other senses, Peak beside another tier or a turn-down is not.
  ['sun at its peak, graphics on ultra', 'quality=4'], ['set peak graphics to low', 'quality=4'],
  ['ultra instead of peak graphics', 'quality=4'], ['get rid of peak graphics', 'quality=4'], ['peak graphics? no', 'quality=4'],
  ["i do n't want peak graphics", 'quality=4'], ['give up on peak graphics', 'quality=4'],
  ['peak graphics with no traffic', 'cars=none', 'quality=5'], ['can you turn on peak graphics?', 'quality=5'],
  // A question or a mention in passing names the tier with no value: Sloane asks before setting anything.
  ['is peak graphics worth it', 'quality'], ['does my gpu support peak graphics?', 'quality'], ['my pc can handle peak graphics', 'quality'],
  ['can i run peak graphics', 'walk=run', 'quality'],
  // Sound.
  ['mute', 'audio=off'], ['no sound', 'audio=off'], ['no music', 'audio=off'], ['unmute', 'audio=on'], ['loud', 'audio=100'],
  ['too loud', 'audio=30'], ['volume 40%', 'audio=40'], ['music', 'audio'], ['sound', 'audio'],
  // Exploring.
  ['walk', 'walk'], ['run', 'walk=run'], ['walk faster', 'walk=run'], ['go faster', 'walk=run'], ['drive', 'drive'],
  ['drive faster', 'drive'], ['just looking around', 'walk=explore'], ['show me around', 'walk=explore'],
  ['take me to the harbour', 'district=Lakefront'], ['go to the market', 'district=Market Quarter'],
  ['go to the civic centre', 'district=Civic Centre'], ['midtown', 'district=Midtown'], ['the financial district', 'district=Financial District'],
  ['downtown', 'district=Financial District'], ['somewhere new', 'district'],
  // Learning.
  ['how do I drive', 'drive', 'controls'], ['controls', 'controls'], ['help', 'controls'], ['what do I press', 'controls'],
  ['tweak the physics', 'console'], ['the console', 'console'], ['open the terminal', 'console'],
  // Several at once, in the goal's order among equals.
  ['fewer cars and make it night', 'cars=fewer', 'time=22'], ['no sound at night', 'audio=off', 'time=22'],
  ['make it 3pm and busy', 'time=15', 'crowd=more'],
  // Nothing to map: "I don't know", "just looking", the unsupported, and any ask for harm.
  ["I don't know"], ['just looking'], ['not sure'], ['pizza'], ['speed up the day'], ['make it rain'],
  ['run people over'], ['drive into the crowd'], ['hit someone with the car'],
]

const summary = (goal: string) => classify(goal).map((c) => (c.value === undefined ? c.control : `${c.control}=${c.value}`))

test('classification table: the taxonomy maps each goal to its controls and values', () => {
  for (const [goal, ...expected] of CLASSES) assert.deepEqual(summary(goal), expected, goal)
})

test('classification: confidence is 0..1, strongest first, one entry per control', () => {
  for (const [goal] of CLASSES) {
    const cs = classify(goal)
    for (let i = 0; i < cs.length; i++) {
      assert.ok(cs[i].confidence > 0 && cs[i].confidence <= 1, goal)
      if (i) assert.ok(cs[i - 1].confidence >= cs[i].confidence, `${goal}: strongest first`)
    }
    assert.equal(new Set(cs.map((c) => c.control)).size, cs.length, goal)
  }
  assert.equal(classify('quiet')[0].confidence, 0.5, 'an ambiguous word is a half reading')
  assert.equal(classify('make it night')[0].confidence, 1)
})

test('classification: the whole taxonomy is case, punctuation and spacing tolerant', () => {
  assert.deepEqual(summary('  MAKE   it Night!!  '), ['time=22'])
  assert.deepEqual(summary('Golden-hour, please.'), ['time=17.4'])
  assert.deepEqual(summary('9 P.M.'), ['time=21'])
  assert.deepEqual(summary('Ｎｉｇｈｔ'), ['time=22'], 'NFKC folds full-width letters')
  assert.deepEqual(summary('２１：３０'), ['time=21.5'], 'and full-width digits and colons')
  assert.ok(summary('I keep running into people').includes('crowd'), 'bumping into a crowd is not an ask for harm')
  assert.deepEqual(summary('lowest quality'), ['quality=-1'], 'the lowest setting is Lite, below Minimal')
  assert.deepEqual(summary('potato'), ['quality=-1'])
  assert.deepEqual(summary('minimal'), ['quality=0'], 'Minimal by name stays Minimal')
  assert.deepEqual(summary(''), [])
  assert.deepEqual(summary('\u0000​'), [])
})

test('timeName names the clock readings a plan mentions', () => {
  assert.equal(timeName(22), 'night')
  assert.equal(timeName(17.4), 'golden hour')
  assert.equal(timeName(6.25), 'dawn')
  assert.equal(timeName(21.5), undefined)
})

// ---------------------------------------------------------------------------------------------------
// Why-questions per category and depth

const ask = (goal: string, ...answers: string[]) => {
  const m = new FiveWhys(goal)
  for (const a of answers) m.answer(a)
  return m
}
const question = (goal: string, ...answers: string[]) => ask(goal, ...answers).next()?.question ?? null

test('why-questions are chosen by category', () => {
  assert.deepEqual(ask('make it night').next(), { depth: 0, question: 'Is it the look you’re after, or fewer people about?', options: ['The look', 'Fewer people', 'Both'] })
  assert.deepEqual(ask('it feels laggy').next(), { depth: 0, question: 'Is it every few seconds, or all the time?', options: ['Every few seconds', 'All the time'] })
  assert.equal(question('golden hour'), 'Is it the light you’re after, or busier streets too?')
  assert.equal(question('quiet'), 'Quiet as in fewer people about, or as in less sound?')
  assert.equal(question('noisy'), 'Is it the sound level, or the traffic itself?')
  assert.equal(question('change the time of day'), 'What time of day would suit you?')
  assert.equal(question('people'), 'More people about, or fewer?')
  assert.equal(question('traffic'), 'More traffic, or less?')
  assert.equal(question('sound'), 'Sound on, or off?')
  assert.equal(question('music'), 'There’s no music here, only the city’s own sound. Would you like that on, or off?')
  assert.equal(question('settings'), 'Smoother, or more detail?')
  assert.equal(question('fewer people'), 'Is it the feel of the streets, or to help the city run smoother?')
  assert.equal(question('fewer cars'), 'Is it the sound of the traffic, crossing the road, or the look of the streets?')
  assert.equal(question('prettier'), 'Is it sharper detail you’re after, or the light and the sky?')
  assert.equal(question('take me to the harbour'), 'On foot, or by car?')
  assert.equal(question('just looking around'), 'Anywhere in particular?')
  assert.equal(question('tweak the physics'), 'The console is the operator’s desk: commands and scripts over the running city. Is that what you’re after, or the everyday controls?')
  assert.equal(question("I don't know"), 'No pressure. Would you rather look around, change how the city looks, or how it runs?')
  assert.equal(question('pizza'), 'That’s not something I can do yet. Would you rather look around, change how the city looks, or how it runs?')
  assert.equal(question('run people over'), 'Nothing here can hurt anyone — every car stops for people, always. Would you rather look around, change how the city looks, or how it runs?')
})

test('why-questions follow the answers by depth', () => {
  const m = ask('change the time of day')
  assert.equal(m.next()?.depth, 0)
  m.answer('Night')
  assert.deepEqual(m.next(), { depth: 1, question: 'Is it the look you’re after, or fewer people about?', options: ['The look', 'Fewer people', 'Both'] })
  m.answer('The look')
  assert.equal(m.next(), null)
  assert.equal(m.depth, 2)
  assert.equal(m.brief().root, 'You want the city at night.')

  const perf = ask("I don't know")
  perf.answer('How it runs')
  assert.equal(perf.next()?.question, 'Is it every few seconds, or all the time?')
  perf.answer('All the time')
  assert.deepEqual(perf.next(), { depth: 2, question: 'Would you trade some detail for a steady frame rate?', options: ['Steady first', 'Keep the detail'] })
  perf.answer('Steady first')
  assert.equal(perf.next(), null)
  assert.equal(perf.brief().root, 'A steady frame rate matters more to you than detail.')
  assert.deepEqual(perf.brief().plan.map((s) => [s.control, s.value, s.immediate, s.ceiling]), [['quality', 1, true, true]], 'a steady frame never raises the tier')

  const walk = ask('just looking')
  walk.answer('Look around')
  assert.equal(walk.next()?.question, 'Anywhere in particular?')
  walk.answer('The market')
  assert.equal(walk.next(), null)
  assert.equal(walk.brief().root, 'You want to wander over to the Market Quarter.')

  // "Somewhere new" with nowhere in mind is a wander, not a dead end.
  const anywhere = ask('somewhere new', 'Anywhere')
  assert.equal(anywhere.next(), null)
  assert.equal(anywhere.brief().root, 'You want to wander and see what’s here.')
  assert.deepEqual(anywhere.brief().plan.map((s) => [s.control, s.value]), [['walk', 'explore']])
  assert.equal(question('somewhere new', 'The harbour'), 'On foot, or by car?', 'a district named in the answer goes on to how')
})

test('an answer that empties the frame is asked about as a miss, not as an impossible goal', () => {
  const missed = ask('people', 'dunno')
  assert.equal(missed.next()?.question, 'I didn’t catch that. Would you rather look around, change how the city looks, or how it runs?')
  missed.answer('How it runs')
  assert.equal(missed.next()?.question, 'Is it every few seconds, or all the time?')
  assert.equal(question('change the time of day', 'half past whenever'), 'I didn’t catch that. Would you rather look around, change how the city looks, or how it runs?')
  assert.equal(question('pizza'), 'That’s not something I can do yet. Would you rather look around, change how the city looks, or how it runs?', 'a goal with nothing to map keeps its own wording')
  // An answer to "what time" that names the crowd too has answered the next why as well.
  const both = ask('change the time of day', 'night, and fewer people')
  assert.equal(both.next(), null)
  assert.equal(both.brief().root, 'You want the look of night and quieter streets.')
  assert.deepEqual(both.brief().plan.map((s) => [s.control, s.value]), [['time', 22], ['crowd', 'fewer']])
})

test('early stop: an unambiguous goal asks nothing, and a settled one asks no more', () => {
  for (const goal of ['mute', 'more people', 'more cars', 'loud', 'battery is dying', 'walk', 'drive', 'controls', 'the console', 'make it 3pm and busy', 'no sound at night']) {
    const m = new FiveWhys(goal)
    assert.equal(m.next(), null, goal)
    assert.equal(m.depth, 0, goal)
    assert.ok(m.brief().plan.length > 0, goal)
  }
  const m = ask('make it night')
  m.answer('The look')
  assert.equal(m.next(), null)
  assert.equal(m.depth, 1)
  assert.equal(m.brief().root, 'You want the city at night.')
  assert.equal(ask('make it 3pm and busy').brief().root, 'You want the afternoon light and busier streets.', 'the goal answered the why itself')
})

test('answers resolve from chips and from free text alike', () => {
  const chip = ask('make it night', 'Fewer people').brief()
  assert.equal(chip.root, 'Quieter streets are what you’re after; night is a way to get there.')
  assert.deepEqual(chip.plan.map((s) => [s.control, s.value, s.immediate]), [['time', 22, true], ['crowd', 'fewer', false]])
  const free = ask('make it night', 'honestly I want fewer people around').brief()
  assert.deepEqual(free.plan.map((s) => [s.control, s.value]), chip.plan.map((s) => [s.control, s.value]))
  assert.equal(ask('make it night', 'Both').brief().root, 'You want the look of night and quieter streets.')
  assert.equal(ask('quiet', 'Fewer people').brief().plan.map((s) => s.control).join(), 'crowd')
  assert.equal(ask('quiet', 'the sound').brief().plan.map((s) => s.control).join(), 'audio')
  assert.equal(ask('quiet', 'Both').brief().plan.map((s) => s.control).join(), 'crowd,audio')
  assert.equal(ask('it feels laggy', 'Every few seconds').brief().plan[0].value, 'auto')
  assert.equal(ask('it feels laggy', 'All the time', 'nah').brief().root, 'You want a steady frame rate without giving up detail.', '"nah" is a no')
  assert.equal(ask('music', 'nah').brief().plan[0].value, 'off')
  assert.equal(ask('take me to the harbour', 'By car').brief().root, 'You want to see the Lakefront by car.')
  assert.equal(ask('midtown', 'On foot').brief().root, 'You want to see Midtown on foot.')
  assert.equal(ask('midtown').brief().plan[0].label, 'Make for Midtown, on the north side')
  assert.equal(ask('prettier', 'The light').brief().root, 'You want the golden-hour light at full fidelity.')
  assert.deepEqual(ask('prettier', 'The light').brief().plan.map((s) => s.control), ['quality', 'time'], 'the light brings the golden hour with it')
  assert.equal(ask('how do I drive').brief().root, 'You want to learn how to drive.')
  // Free text that names no time drops the reading and says so.
  const missed = ask('change the time of day', 'half past whenever').brief()
  assert.deepEqual(missed.plan, [])
  assert.deepEqual(missed.unmapped, ['A time of day: I didn’t catch one'])
})

test('next() is stable until answered; answer() asks the question itself if next() was skipped', () => {
  const m = new FiveWhys('make it night')
  const a = m.next()
  assert.equal(m.next(), a, 'the same step object until it is answered')
  assert.equal(m.depth, 0)
  const n = new FiveWhys('make it night')
  n.answer('The look')
  assert.equal(n.depth, 1)
  assert.equal(n.brief().whys[0].question, 'Is it the look you’re after, or fewer people about?')
  // With no question left, more text still refines the goal.
  n.answer('and no sound')
  assert.equal(n.depth, 1)
  assert.deepEqual(n.brief().plan.map((s) => s.control), ['time', 'audio'])
  // Nothing said is not an answer: the question stays pending.
  const blank = new FiveWhys('make it night')
  const q = blank.next()
  blank.answer('')
  blank.answer(' \u0000​ ')
  assert.equal(blank.depth, 0)
  assert.equal(blank.next(), q)
  assert.deepEqual(blank.brief().whys, [])
})

test('a goal or answer is kept as one clean line of at most GOAL_MAX characters', () => {
  const long = 'make it night '.repeat(40)
  const b = new FiveWhys(`\u0000  ${long}\t\n`).brief()
  assert.ok(b.goal.length <= GOAL_MAX)
  assert.doesNotMatch(b.goal, /\p{Cc}|\s{2}/u)
  assert.equal(b.plan[0].control, 'time')
  const m = new FiveWhys('make it night')
  m.answer('​The look​')
  assert.equal(m.brief().whys[0].answer, 'The look')
  // A cut at the limit never leaves half a surrogate pair (a lone surrogate would print as U+FFFD).
  const emoji = new FiveWhys(`${'x'.repeat(GOAL_MAX - 1)}😀 night`).brief().goal
  assert.ok(emoji.length <= GOAL_MAX)
  assert.doesNotMatch(emoji, /[\uD800-\uDFFF]/u, 'no lone surrogate (in unicode mode the class matches only unpaired ones)')
})

// ---------------------------------------------------------------------------------------------------
// Every path through the dialogue, for a corpus of goals

const CORPUS = [
  'make it night', 'it feels laggy', 'take me to the harbour', 'quiet please', "I don't know", 'mute', 'run people over',
  'make it rain at night', 'set the clock to 21:30', 'more people', 'no traffic', 'prettier', 'just looking around', 'go faster',
  'speed up the day', 'how do I drive', 'tweak the physics', 'fewer cars and make it night', 'ultra', 'battery is dying', 'noisy',
  'walk faster', 'the console', 'change the time of day', 'music', 'runs slow', 'empty', 'fewer people', 'sound', 'people',
  'traffic', 'settings', 'somewhere new', 'pizza', 'I want a dog and a house by the sea', 'no music at midnight', 'just looking',
  // Plain asks for Peak, beside other controls and the words a plain ask holds (PEAK_GOALS).
  'peak graphics', 'set quality beyond ultra', 'peak graphics and golden hour',
  'peak graphics with no traffic', 'can you turn on peak graphics?', 'i want peak graphics too', "i don't mind peak graphics",
  'no music and peak graphics', 'peak graphics but no traffic', 'peak graphics then golden hour',
  // Peak named but not plainly asked for: Sloane asks, and only her "Set Peak" reaches 5 (ASKED_GOALS).
  'is peak graphics worth it', 'what is peak quality', 'should i use peak settings', 'does my gpu support peak graphics?',
  'my pc can handle peak graphics', 'can i run peak graphics', "don't turn off peak graphics", 'stuck on peak graphics',
  'не peak graphics', 'mute peak graphics', 'peak graphics?',
  // Peak turned down or doubted: never 5 on any path, and never asked about. One goal for each way in.
  'turn off peak graphics', 'do not go above ultra', "i don't want peak graphics", 'reduce peak quality', 'it lags on peak settings',
  'my phone is hot on peak graphics', 'peak graphics is too heavy',
  'no peak graphics', 'i don’t want peak graphics', "i haven't asked for peak graphics", 'neither ultra nor peak graphics',
  'skip peak graphics', 'get rid of peak graphics', 'switch from peak graphics', 'peak graphics keeps freezing',
  'peak graphics though my card only has 4gb', 'peak graphics? no', 'set peak graphics to low', 'ultra instead of peak graphics',
  'peak graphics, no thanks', 'sun at its peak, graphics on ultra', 'no, not peak. graphics on ultra',
  "i want peak graphics but my laptop can't handle it", "i don't want golden hour and peak graphics", 'peak graphics is slow',
  'give up on peak graphics', 'take out peak graphics', 'peak graphics, turn it down', '!peak graphics',
] as const
/** The corpus goals that ask for Peak plainly: with ASKED_GOALS after "Set Peak", the only ones whose plan may reach 5. */
const PEAK_GOALS = new Set([
  'peak graphics', 'set quality beyond ultra', 'peak graphics and golden hour', 'peak graphics with no traffic', 'can you turn on peak graphics?',
  'i want peak graphics too', "i don't mind peak graphics", 'no music and peak graphics', 'peak graphics but no traffic',
  'peak graphics then golden hour',
])
/** The corpus goals Sloane asks about Peak for (quality.peak). */
const ASKED_GOALS = new Set([
  'is peak graphics worth it', 'what is peak quality', 'should i use peak settings', 'does my gpu support peak graphics?',
  'my pc can handle peak graphics', 'can i run peak graphics', "don't turn off peak graphics", 'stuck on peak graphics',
  'не peak graphics', 'mute peak graphics', 'peak graphics?',
])

interface Path { goal: string; answers: string[]; whys: FiveWhys; brief: Brief }
/** Every chip path from a goal to the end of its questions. */
function paths(goal: string): Path[] {
  const out: Path[] = []
  const walk = (answers: string[]) => {
    const whys = new FiveWhys(goal)
    for (const a of answers) whys.answer(a)
    const step = whys.next()
    if (!step) { out.push({ goal, answers, whys, brief: whys.brief() }); return }
    assert.equal(step.depth, answers.length, `${goal}: depth counts the whys asked`)
    assert.ok(step.options.length >= 2 && new Set(step.options).size === step.options.length, `${goal}: distinct chips`)
    for (const o of step.options) walk([...answers, o])
  }
  walk([])
  return out
}
const ALL = CORPUS.flatMap(paths)

test('every path ends, in at most five whys, with a well-formed brief', () => {
  assert.ok(ALL.length > 200, `${ALL.length} paths`)
  for (const p of ALL) {
    assert.ok(p.whys.depth <= MAX_WHYS, p.goal)
    assert.equal(p.whys.depth, p.answers.length)
    assert.equal(p.brief.whys.length, p.answers.length)
    assert.ok(p.brief.root.length > 0)
    assert.ok(p.brief.plan.length + p.brief.unmapped.length > 0, `${p.goal} [${p.answers}]: a plan or a reason`)
    for (const s of p.brief.plan) {
      assert.ok(s.label.length > 0 && s.modules.length > 0, `${p.goal}: ${s.control}`)
      assert.equal(s.immediate, s.control === 'time' || s.control === 'quality' || s.control === 'audio', `${p.goal}: only host controls are immediate`)
      if (s.control === 'time') assert.ok(typeof s.value === 'number' && s.value >= 0 && s.value < 24)
      if (s.control === 'quality') assert.ok(s.value === 'auto' || (typeof s.value === 'number' && s.value >= LITE_TIER && s.value <= PEAK_TIER))
      if (s.control === 'quality' && s.value === PEAK_TIER) {
        assert.ok(PEAK_GOALS.has(p.goal) || (ASKED_GOALS.has(p.goal) && p.answers.includes('Set Peak')), `${p.goal} [${p.answers}]: only a plain ask or "Set Peak" reaches 5`)
      }
      if (s.ceiling) assert.ok(s.control === 'quality' && typeof s.value === 'number' && s.value < PEAK_TIER, `${p.goal}: only a quality below Peak is a ceiling`)
      if (s.control === 'audio') assert.ok(s.value === 'on' || s.value === 'off' || (typeof s.value === 'number' && s.value >= 0 && s.value <= 100))
    }
    assert.equal(new Set(p.brief.plan.map((s) => s.control)).size, p.brief.plan.length, `${p.goal}: one step per control`)
    assert.equal(p.answers.includes('Set Peak'), ASKED_GOALS.has(p.goal) && p.answers.includes('Set Peak'), `${p.goal}: Sloane asks about Peak only when it is named but not plainly asked for`)
  }
})

test('a named Peak reaches tier 5 through the corpus; "max" and "best" stay Ultra', () => {
  assert.ok(PEAK_GOALS.has('set quality beyond ultra') && ALL.some((p) => p.goal === 'set quality beyond ultra' && p.brief.plan.some((s) => s.control === 'quality' && s.value === PEAK_TIER)))
  for (const goal of PEAK_GOALS) assert.ok(ALL.some((p) => p.goal === goal && p.brief.plan.some((s) => s.control === 'quality' && s.value === PEAK_TIER)), goal)
  // A goal Sloane asks about sets no tier until answered; "Set Peak" reaches 5 and "Ultra at most" an Ultra ceiling.
  for (const goal of ASKED_GOALS) {
    const ps = ALL.filter((p) => p.goal === goal)
    assert.ok(!new FiveWhys(goal).brief().plan.some((s) => s.control === 'quality'), `${goal}: nothing set before the answer`)
    assert.ok(ps.some((p) => p.answers.includes('Set Peak') && p.brief.plan.some((s) => s.control === 'quality' && s.value === PEAK_TIER)), goal)
    assert.ok(ps.some((p) => p.answers.includes('Ultra at most') && p.brief.plan.some((s) => s.control === 'quality' && s.value === 4 && s.ceiling)), goal)
  }
  assert.deepEqual(summary('max quality'), ['quality=4'])
  assert.deepEqual(summary('best graphics'), ['quality=4'])
})

test('every module a brief names exists under src/', () => {
  const named = new Set<string>()
  for (const p of ALL) {
    for (const s of p.brief.plan) for (const m of s.modules) named.add(m)
    for (const line of p.brief.markdown.matchAll(/`([^`]+)`/g)) if (line[1] !== 'src/') named.add(line[1])
  }
  assert.ok(named.size >= 20, `${named.size} modules named`)
  // statSync, not existsSync: existsSync answers false to every error, and on a machine whose scanner holds a fresh
  // file (EPERM on Windows) that read as "the module is missing"; a throw here carries the real cause.
  for (const m of named) assert.doesNotThrow(() => statSync(resolve(SRC, m)), m)
})

test('deterministic: the same goal and answers always give the same brief', () => {
  for (const p of ALL) {
    const again = new FiveWhys(p.goal)
    for (const a of p.answers) again.answer(a)
    assert.deepEqual(again.brief(), p.brief, `${p.goal} [${p.answers}]`)
    assert.deepEqual(again.brief(), again.brief(), 'brief() has no side effects')
  }
  assert.deepEqual(classify('make it night'), classify('make it night'))
})

/** 14A and IP: nothing the card or the brief says may carry these. */
const BANNED = /agent city|\bgta\b|matrix|pathfinder|pf2e|paizo|alpine|\bkill|attack|weapon|target|shoot|\bguns?\b|violen|injur|maim|wound|blood|\bdie\b|\bdead|death|crash|smash/i
/** What the card shows must read as plain speech: no paths, code, keys or shell. */
const SYNTAX = /[`~/\\$<>{}|]|\.ts\b|\.tsx\b|--|\bnpm\b|\bsudo\b/

test('content rules: 14A wording, no exclamation marks, no syntax in anything the card shows', () => {
  const spoken: string[] = []
  for (const p of ALL) {
    const m = new FiveWhys(p.goal)
    for (const a of p.answers) {
      const step = m.next()
      assert.ok(step)
      spoken.push(step.question, ...step.options)
      m.answer(a)
    }
    spoken.push(p.brief.root, ...p.brief.unmapped, ...p.brief.plan.map((s) => s.label))
    assert.doesNotMatch(p.brief.markdown, BANNED, p.goal)
  }
  assert.ok(spoken.length > 1000)
  for (const s of spoken) {
    assert.doesNotMatch(s, BANNED, s)
    assert.doesNotMatch(s, SYNTAX, s)
    assert.doesNotMatch(s, /!/, s)
  }
  // The refusal is pacifist and names no harm the city could do.
  const harm = new FiveWhys('run people over')
  assert.match(harm.next()?.question ?? '', /^Nothing here can hurt anyone — every car stops for people, always\./)
  assert.match(harm.brief().unmapped[0], /^Harm to anyone: not something this city can do/)
  assert.deepEqual(harm.brief().plan, [])
})

// ---------------------------------------------------------------------------------------------------
// The copyable brief

test('markdown brief golden: goal, why-chain, root intent, plan (now vs. later, ticked when applied), modules', () => {
  const m = ask('make it night', 'Fewer people')
  assert.equal(m.brief(['time']).markdown, [
    '# Architecture brief',
    '',
    '**Goal:** make it night',
    '',
    '## Why',
    '1. Is it the look you’re after, or fewer people about? — **Fewer people**',
    '',
    '## Root intent',
    'Quieter streets are what you’re after; night is a way to get there.',
    '',
    '## Plan',
    '### Now — the Concierge applies these',
    '- [x] Set the clock to 22:00 (night) — `01_Initialize_World/solar.ts`, `07_Execute_Actions/engine.ts`',
    '### Later — the operator’s console or a restart',
    '- [ ] Thin the crowd — `03_Spawn_Agents/crowdCompute.ts`, `05_Observe_Environment/governor.ts`, `07_Execute_Actions/engine.ts`',
    '',
    '---',
    '_Written by the concierge’s 5-Whys engine (deterministic, offline). Module paths are under `src/`._',
    '',
  ].join('\n'))
  assert.match(m.brief().markdown, /- \[ \] Set the clock/, 'unticked until the host applies it')
})

test('markdown brief: no questions, nothing mapped, and the unsupported are each said plainly', () => {
  const clear = new FiveWhys('mute').brief().markdown
  assert.match(clear, /## Why\n_No questions needed: the goal was clear\._/)
  assert.match(clear, /### Now — the Concierge applies these\n- \[ \] Turn the sound off — `07_Execute_Actions\/audio\.ts`/)
  assert.doesNotMatch(clear, /### Later/)
  const none = ask('pizza', 'The controls').brief()
  assert.equal(none.root, 'You want to learn the controls.')
  assert.match(none.markdown, /## Not mapped\n- “pizza”: nothing in the city maps to that yet\n/)
  const rain = new FiveWhys('make it rain at night').brief()
  assert.deepEqual(rain.unmapped, ['Weather: the city has one clear late-September day so far'])
  assert.match(rain.markdown, /- Weather: the city has one clear late-September day so far — would touch `01_Initialize_World\/solar\.ts`/)
  // Going indoors: the workplaces (01_Initialize_World/interiors.ts) are open, in both generated maps; nothing else is.
  const home = new FiveWhys('go inside my house').brief()
  assert.deepEqual(home.unmapped, ['Going indoors: only the six workplaces open onto the street, in the city and in the lakefront metropolis; every other building is a solid shell for now'])
  assert.match(home.markdown, /would touch `01_Initialize_World\/interiors\.ts`/)
  const empty = ask('pizza', 'nope').brief()
  assert.deepEqual(empty.plan, [])
  assert.match(empty.markdown, /## Plan\n_Nothing to change\._/)
})

test('brief() is always available and grows as answers arrive', () => {
  const m = new FiveWhys('quiet')
  const before = m.brief()
  assert.deepEqual(before.whys, [])
  assert.equal(before.root, 'You want quieter streets.')
  assert.deepEqual(before.plan.map((s: PlanStep) => s.control), ['crowd', 'audio'])
  m.answer('Less sound')
  const after = m.brief()
  assert.deepEqual(after.whys, [{ question: 'Quiet as in fewer people about, or as in less sound?', answer: 'Less sound' }])
  assert.deepEqual(after.plan.map((s) => [s.control, s.value, s.immediate]), [['audio', 30, true]])
  assert.equal(after.root, 'You want the sound softer.')
})

test('the console\'s goal command keeps the same limit as the Concierge (terminal/commands.ts GOAL_CHARS)', async () => {
  const { GOAL_CHARS } = await import('../07_Execute_Actions/terminal/commands.ts')
  assert.equal(GOAL_CHARS, GOAL_MAX)
})

test('a fix for heat or a slow frame is a ceiling on the tier, never a raise; a named tier is a target', () => {
  // The host (App.tsx qualityFor) pins the lower of a ceiling and the live tier, so a phone on Lite stays on Lite.
  const plan = (goal: string, ...answers: string[]) => {
    const w = ask(goal, ...answers)
    return w.brief().plan.filter((s) => s.control === 'quality').map((s) => [s.value, s.ceiling ?? false])
  }
  assert.deepEqual(plan('my phone is hot'), [[1, true]])
  assert.deepEqual(plan('battery'), [[1, true]])
  assert.deepEqual(plan('it feels laggy', 'All the time', 'Steady first'), [[1, true]])
  assert.deepEqual(plan('low quality'), [[1, false]], 'asking for Low by name pins Low')
  assert.deepEqual(plan('lowest quality'), [[LITE_TIER, false]])
  assert.deepEqual(plan('ultra'), [[4, false]])
  // Peak (tier 5, above the table) only when named, and always the tier to set: 5 is never a ceiling.
  assert.equal(PEAK_TIER, 5)
  assert.deepEqual(plan('peak graphics'), [[5, false]])
  assert.deepEqual(plan('beyond ultra'), [[5, false]])
  assert.deepEqual(plan('best graphics'), [[4, false]])
  // Peak beside a complaint is where the trouble is, never the tier to set: the complaint's ceiling, or Ultra's.
  assert.deepEqual(plan('my phone is hot on peak graphics'), [[1, true]])
  assert.deepEqual(plan('the fans spin up on peak settings'), [[1, true]])
  assert.deepEqual(plan('it lags on peak settings'), [[4, true]])
  assert.deepEqual(plan('it lags on peak settings', 'All the time', 'Steady first'), [[1, true]])
  // Peak in doubt (turned down, declined, a complaint about it, a question, another tier) is Ultra as a ceiling: a device
  // below Ultra keeps its tier. A word another rule took does not count ("no traffic"); any other does.
  assert.deepEqual(plan('turn off peak graphics'), [[4, true]])
  assert.equal(question('turn off peak graphics'), null, 'no question about detail or light for a Peak turned down')
  assert.deepEqual(plan("don't go beyond ultra"), [[4, true]])
  assert.deepEqual(plan('do not go above ultra'), [[4, true]])
  assert.deepEqual(plan("i don't want peak graphics"), [[4, true]])
  assert.deepEqual(plan('peak graphics is too heavy for my laptop'), [[4, true]])
  assert.deepEqual(plan('no thanks, peak graphics'), [[4, true]])
  assert.deepEqual(plan('peak graphics and no traffic'), [[5, false]])
  assert.deepEqual(plan('peak graphics with the sound off'), [[5, false]])
  assert.deepEqual(plan('peak graphics too'), [[5, false]])
  assert.deepEqual(plan("i don't mind peak graphics"), [[5, false]])
  assert.deepEqual(plan('can you turn on peak graphics?'), [[5, false]])
  assert.deepEqual(plan('set peak graphics to low'), [[4, true]])
  assert.deepEqual(plan('switch from peak quality to ultra'), [[4, true]])
  assert.deepEqual(plan('get rid of peak graphics'), [[4, true]])
  assert.deepEqual(plan('give up on peak graphics'), [[4, true]])
  assert.deepEqual(plan('take out peak graphics'), [[4, true]])
  assert.deepEqual(plan('peak graphics too detailed'), [[4, true]])
  assert.deepEqual(plan('peak graphics, turn it down').length, 1)
  assert.deepEqual(plan('peak graphics, turn it down'), [[4, true]], 'not the sound alone')
  assert.deepEqual(plan('!peak graphics'), [[4, true]])
  assert.deepEqual(plan('peak graphics? no'), [[4, true]])
  assert.deepEqual(plan('i do n\'t want peak graphics'), [[4, true]])
  assert.deepEqual(plan('i donʼt want peak graphics'), [[4, true]], 'a modifier-letter apostrophe')
  assert.deepEqual(plan('i don′t want peak graphics'), [[4, true]], 'a prime')
  for (const g of ['I canʼt hear anything', 'I can′t hear anything']) assert.deepEqual(classify(g), classify("I can't hear anything"), 'one apostrophe everywhere')
  assert.deepEqual(plan("i want peak graphics but my laptop can't handle it"), [[4, true]])
  assert.deepEqual(plan("i don't want golden hour and peak graphics"), [[4, true]])
  assert.deepEqual(plan('peak graphics is slow'), [[4, true]])
  assert.deepEqual(plan('peak graphics makes my laptop loud'), [[4, true]], 'a complaint another rule read still counts beside a Peak not plainly asked for')
  assert.deepEqual(plan('peak graphics at 60 fps'), [[4, true]], 'so does a frame rate')
  assert.deepEqual(plan('peak graphics though my card only has 4gb'), [[4, true]])
  assert.deepEqual(plan('peak graphics. my card only has 2gb'), [[4, true]], 'the whole goal counts, not only the stretch that names Peak')
  assert.deepEqual(plan('peak graphics, my laptop is old'), [[4, true]])
  assert.deepEqual(plan('peak graphics, set it to low'), [[4, true]])
  assert.deepEqual(plan('nobody would use peak graphics'), [[4, true]])
  assert.deepEqual(plan('no one would use peak graphics'), [[4, true]])
  assert.deepEqual(plan('peak graphics and nobody on the streets'), [[5, false]], 'nobody is the crowd here')
  assert.equal(ask('peak graphics and nobody on the streets').brief().plan.find((s) => s.control === 'crowd')?.value, 'none')
  assert.deepEqual(plan('peak quality auto'), [['auto', false]], 'a lower tier or auto the goal names stands')
  assert.equal(ask('peak graphics is slow').brief().root, 'You want the city to run smoother.')
  // Named but not plainly asked for (a question, a mention in passing, a keep): nothing is set until Sloane's question
  // is answered, and the console's goal, which asks nothing, changes no tier.
  const PEAK_QUESTION = 'Peak takes a big graphics card and about half a gigabyte more of its memory. Set Peak, or keep to Ultra at most?'
  for (const goal of ['is peak graphics worth it', 'does my gpu support peak graphics?', 'peak graphics?', 'peak graphics？', 'peak graphics؟',
    'how do i get peak graphics', 'would peak graphics look better', 'is peak graphics on', 'my pc can handle peak graphics', 'peak graphics is great',
    'peak graphics on my desktop too', 'can i run peak graphics', 'can you run peak graphics?', 'you can keep peak graphics', 'stuck on peak graphics',
    'mute peak graphics', 'не peak graphics', 'peak graphics 👎', "don't turn off peak graphics", 'leave it on peak graphics', 'raise it to peak quality',
    'peak settings on my phone', 'peak graphics and the music', "i don't mind peak graphics if it looks better", "i don't mind peak graphics, whatever",
    'leave it at peak graphics, nothing else', 'leave it on peak graphics, no traffic']) {
    assert.deepEqual(plan(goal), [], goal)
    assert.equal(ask(goal).brief().plan.some((s) => s.control === 'quality'), false, goal)
  }
  assert.equal(question('my pc can handle peak graphics'), PEAK_QUESTION)
  assert.equal(ask('my pc can handle peak graphics').brief().root, 'You asked about Peak, the tier above Ultra.')
  assert.deepEqual(plan('my pc can handle peak graphics', 'Set Peak'), [[5, false]])
  assert.equal(question('my pc can handle peak graphics', 'Set Peak'), 'Is it sharper detail you’re after, or the light and the sky?')
  assert.equal(question('what is peak quality', 'Set Peak'), 'Is it sharper detail you’re after, or the light and the sky?')
  assert.equal(ask('what is peak quality', 'Set Peak').brief().root, 'You want the sharpest picture this machine can draw.')
  assert.deepEqual(plan('my pc can handle peak graphics', 'Ultra at most'), [[4, true]])
  assert.deepEqual(plan('my pc can handle peak graphics', 'peak graphics please'), [[5, false]])
  assert.deepEqual(plan('my pc can handle peak graphics', 'yes'), [], 'a yes to an either-or sets nothing')
  assert.equal(ask('my pc can handle peak graphics', 'yes').brief().root, 'You asked about Peak, the tier above Ultra.')
  assert.deepEqual(plan('my pc can handle peak graphics', 'no'), [[4, true]])
  assert.deepEqual(plan('my pc can handle peak graphics', 'yes but it lags'), [[4, true]])
  assert.deepEqual(plan('my pc can handle peak graphics', 'my laptop is hot'), [[1, true]])
  assert.deepEqual(plan('my pc can handle peak graphics', 'let it decide'), [['auto', false]])
  // Typed in place of the chip: Peak with only ways of asking or choosing beside it is Set Peak; a sign, a question or a
  // word Sloane cannot read is no choice, and a no is Ultra at most.
  for (const a of ['peak please', 'Peak, thanks', 'set peak please', 'please set peak', 'yes peak', 'yes, set peak', 'set it to peak', 'turn on peak',
    'go with peak', 'peak mode', 'definitely peak', 'yes go for peak', 'go peak', 'yes!! set peak']) assert.deepEqual(plan('is peak graphics worth it', a), [[5, false]], a)
  for (const a of ['!peak', '-peak', '¬peak', '~peak', 'not peak', 'no peak please', 'peak, no']) assert.deepEqual(plan('is peak graphics worth it', a), [[4, true]], a)
  for (const a of ['peak?', 'set peak?', 'не peak', 'peak 👎', '❌ peak', 'peak is expensive', 'what does peak do']) assert.deepEqual(plan('is peak graphics worth it', a), [], a)
  // A plain ask holds only ways of asking and joining words; a question mark only on a request.
  for (const goal of ['can u turn on peak graphics?', 'pls can you turn on peak graphics?', 'could i have peak quality?', 'will you turn on peak graphics?',
    'may i have peak graphics?', 'beyond-ultra', 'peak graphics please', 'keep peak graphics']) assert.deepEqual(plan(goal), [[5, false]], goal)
  assert.deepEqual(plan('sun at its peak, graphics on ultra'), [[4, false]])
  assert.deepEqual(plan('no, not peak. graphics on ultra'), [[4, false]])
  assert.deepEqual(plan('the peak; graphics please'), [[4, false]])
  for (const goal of ['set it to peak graphics', 'i want it on peak graphics', '“peak graphics” please', 'peak graphics…']) assert.deepEqual(plan(goal), [[5, false]], goal)
  assert.deepEqual(plan('it set peak graphics again'), [], 'a report, not an ask')
  // A turn-down before the Peak name takes Peak with it, unless Peak has its own way of asking after it.
  for (const goal of ['turn off the music and peak graphics', 'stop the music and peak graphics', 'get rid of the cars and peak graphics',
    'music off, peak graphics too', 'keep the music off and peak graphics too', 'can you turn off the music and peak graphics?']) assert.deepEqual(plan(goal), [[4, true]], goal)
  assert.equal(ask('turn off the music and peak graphics').brief().plan.find((s) => s.control === 'audio')?.value, 'off')
  for (const goal of ['turn off the music and turn on peak graphics', 'turn the music off and set peak graphics', 'turn off the sound, i want peak graphics',
    'less traffic and peak graphics']) assert.deepEqual(plan(goal), [[5, false]], goal)
  for (const goal of ['chill on peak graphics', 'relax the peak graphics']) assert.deepEqual(plan(goal), [], goal)
  assert.deepEqual(plan('turn off the music, set it to noon and remove the cars and peak graphics'), [[4, true]], 'the last turn-down before Peak')
  assert.deepEqual(plan('go all out with peak graphics'), [[5, false]])
  // Another control's word that may be about Peak, after its name too.
  assert.deepEqual(plan('peak graphics and mute'), [])
  assert.deepEqual(plan('peak graphics too early'), [[4, true]])
  // Struck out with any run of signs or dashes; a question mark outside ASCII is never plain.
  for (const goal of ['~~peak graphics~~', '--peak graphics', '—peak graphics', '!=peak graphics', 'night,-peak graphics']) assert.deepEqual(plan(goal), [[4, true]], goal)
  for (const goal of ['peak graphics⸮', '¿peak graphics?', 'peak graphics‽']) assert.deepEqual(plan(goal), [], goal)
  // An answer in words to the detail-or-light question: on Peak, a turn-down, a complaint or another tier counts as if it
  // stood in the goal, whatever cue it also holds; elsewhere only a plain ask for Peak changes the tier.
  assert.deepEqual(plan('peak graphics', "i don't want peak graphics"), [[4, true]])
  assert.deepEqual(plan('peak graphics', "i don't want peak graphics at all"), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'the light, but not peak graphics'), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'my card only has 4gb'), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'medium is enough'), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'it lags'), [[4, true]])
  assert.equal(ask('peak graphics', 'it lags').brief().root, 'You want the city to run smoother.')
  assert.deepEqual(plan('beyond ultra', 'my laptop is hot'), [[1, true]])
  assert.deepEqual(plan('peak graphics', 'Sharper detail'), [[5, false]])
  assert.deepEqual(plan('peak graphics', 'whatever'), [[5, false]])
  assert.deepEqual(plan('make it prettier', 'peak graphics please'), [[5, false]])
  // Any answer that names Peak sets the tier as a goal would, whichever question it answers.
  assert.deepEqual(plan('peak graphics and golden hour', 'the light, but not peak graphics'), [[4, true]])
  assert.deepEqual(plan('peak graphics and golden hour', "i don't want peak graphics"), [[4, true]])
  assert.deepEqual(plan('peak graphics at night', 'the look, but not peak graphics'), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'cancel peak graphics'), [], 'named but not plainly turned down: Peak comes off and Sloane asks')
  assert.equal(question('peak graphics', 'cancel peak graphics'), PEAK_QUESTION)
  assert.deepEqual(plan('peak graphics', 'cancel peak graphics', 'Set Peak'), [[5, false]])
  assert.deepEqual(plan('peak graphics', 'cancel peak graphics', 'Ultra at most'), [[4, true]])
  assert.deepEqual(plan('turn off peak graphics', 'peak graphics'), [[5, false]], 'a plain ask later changes the mind')
  assert.equal(ask('turn off peak graphics', 'peak graphics').brief().root, 'You want the sharpest picture this machine can draw.')
  const auto = ask('auto quality and change the time of day', 'night, but not peak graphics').brief()
  assert.deepEqual(auto.plan.find((s) => s.control === 'quality')?.value, 'auto')
  assert.equal(auto.root.includes('not Peak'), false, 'auto can still reach Peak, so no "not Peak"')
  // A slow frame or heat in any answer, or the smoother choice, makes a Peak named anywhere an Ultra ceiling.
  assert.deepEqual(plan('peak graphics and golden hour', 'it lags'), [[4, true]])
  assert.deepEqual(plan('peak graphics and golden hour', 'the light, but it lags'), [[4, true]], 'beside a chip cue too')
  assert.deepEqual(plan('make it prettier', 'is peak graphics worth it'), [[4, false]], 'an Ultra the frame holds stands a passing mention')
  assert.deepEqual(plan('make it prettier', "i don't want peak graphics"), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'it runs badly'), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'cooler please'), [[1, true]])
  assert.deepEqual(plan('my laptop is hot', 'peak graphics'), [[4, true]])
  assert.deepEqual(plan('settings', 'Smoother', 'peak graphics'), [[4, true]])
  assert.deepEqual(plan('fewer people', 'Smoother', 'peak graphics'), [[4, true]])
  assert.deepEqual(plan('make it prettier but my laptop gets hot', "i don't want peak graphics"), [[1, true]], 'a turn-down of Peak never raises a lower tier')
  assert.deepEqual(plan('make it prettier', 'high quality'), [[4, false]], 'as before Peak: the answer is a cue, not a tier')
  assert.deepEqual(plan('peak graphics', 'ultra is fine'), [[4, true]])
  assert.deepEqual(plan('peak graphics', 'the light, on ultra'), [[4, true]])
  // An answer with no question left joins the frame, and a turn-down of Peak there never raises a lower tier or auto.
  assert.deepEqual(plan('my laptop gets hot', "i don't want peak graphics"), [[1, true]])
  assert.deepEqual(plan('quality auto', "i don't want peak graphics"), [['auto', false]])
  assert.deepEqual(ask('max graphics and fewer people', 'the faces in the crowd').brief().plan.find((s) => s.control === 'crowd')?.value, 'fewer')
  // "peak" in its other senses is not the tier.
  assert.deepEqual(plan('lower the peak traffic'), [])
  assert.deepEqual(plan('come down from the peak'), [])
  assert.equal(ask('turn off peak graphics').brief().root, 'You want the city at Ultra or below, not Peak.')
  assert.equal(ask('it lags on peak settings').brief().root, 'You want the city to run smoother.')
})
