// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the catalogue of city actions (actions.ts): the parser reads the protocol's
 * eleven answers as the contract says (a line glued to prose is refused with its reason, two different lines are
 * refused, identical and synonymous ones merge, `none` proposes nothing, an unknown verb and a wrong value are refused
 * with the verb's hint, a dial out of range is clamped and noted, the text is the answer with the line removed); every
 * verb's synonyms and values at both ends of their range; a clock reading never wraps; every sentence, done line and
 * hint passes the 14A screen, the card's content rules and has no exclamation mark; the four prompt lines name every
 * verb; the light ranges equal world.ts by its source text (world.ts itself is never imported: it needs the GPU);
 * `perform` makes exactly one facade call per verb (one setMode per car not driven, 64 at most) and reaches rain mode
 * and the sound only through the city knobs; the `act list` rows; and the scripted provider's line over the prompts
 * the browser smoke types.
 * What breaks if it is removed? A model's line could run as something other than the catalogue's own words, a clamp
 * or a refusal could go quiet, and a change to world.ts's ranges would go unnoticed here.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { formatClock } from '../01_Initialize_World/solar.ts'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { LITE_TIER, TIERS } from '../05_Observe_Environment/governor.ts'
import type { ScriptApi } from '../07_Execute_Actions/operator.ts'
import {
  ACTION_RULES, catalogueLines, HINTS, LIGHT_RANGE, MAX_CAR_SENDS, MORE_THAN_ONE, NOT_ALONE, parseAction, perform, scriptedAction, sentence, VERBS,
  type Action, type CityKnobs, type Parsed,
} from './actions.ts'
import { TIMES } from './intent.ts'

// ---------------------------------------------------------------- helpers

/** The proposal of a parse, or a failed assertion naming the input. */
function proposed(input: string): Parsed & { kind: 'proposed' } {
  const p = parseAction(input)
  assert.equal(p.kind, 'proposed', `${JSON.stringify(input)} → ${JSON.stringify(p)}`)
  return p as Parsed & { kind: 'proposed' }
}
/** The refusal of a parse, or a failed assertion naming the input. */
function refused(input: string): Parsed & { kind: 'refused' } {
  const p = parseAction(input)
  assert.equal(p.kind, 'refused', `${JSON.stringify(input)} → ${JSON.stringify(p)}`)
  return p as Parsed & { kind: 'refused' }
}
const canonical = (input: string): string => proposed(input).action.canonical
const reason = (input: string): string => refused(input).reason
const act = (input: string): Action => proposed(input).action

/** A recording stand-in for the leased script facade: every write is noted, reads too, and the driven car refuses setMode. */
function fakeSim(opts: { cars?: number; driven?: number } = {}) {
  const writes: string[] = []
  const reads: string[] = []
  let hours = 12
  let tier: number | 'auto' = 3
  const uniforms: Record<string, number> = { 'light.haze': 1, 'light.exposure': 1, 'light.sun': 1, 'light.fill': 1 }
  const sim = {
    clock: { hours: () => { reads.push('clock.hours'); return hours }, set: (h: number) => { writes.push(`clock.set ${h}`); hours = h } },
    quality: {
      state: () => {
        reads.push('quality.state')
        return tier === 'auto' ? { tier: 2, label: 'Medium', auto: true } : { tier, label: tier < 0 ? 'Lite' : TIERS[tier].label, auto: false }
      },
      set: (t: number | 'auto') => { writes.push(`quality.set ${t}`); tier = t },
    },
    vehicles: {
      count: () => { reads.push('vehicles.count'); return opts.cars ?? 0 },
      state: (i: number) => { reads.push(`vehicles.state ${i}`); return { mode: i === opts.driven ? 'player' : 'ai' } },
      setMode: (i: number, mode: string) => {
        if (i === opts.driven) throw new Error('that car is being driven')
        writes.push(`vehicles.setMode ${i} ${mode}`)
      },
    },
    shaders: { uniforms: () => { reads.push('shaders.uniforms'); return { ...uniforms } }, set: (k: string, v: number) => { writes.push(`shaders.set ${k} ${v}`); uniforms[k] = v } },
    crowd: { cull: (c: { density?: number }) => { writes.push(`crowd.cull ${JSON.stringify(c)}`) } },
  }
  return { sim: sim as unknown as ScriptApi, writes, reads }
}
function fakeCity() {
  const calls: string[] = []
  const city: CityKnobs = { rain: (on) => { calls.push(`rain ${on}`) }, audio: (level) => { calls.push(`audio ${level}`) } }
  return { city, calls }
}

/** The card's own content rules (intent.test.ts), which everything the city says about an action must pass too. */
const BANNED = /agent city|\bgta\b|matrix|pathfinder|pf2e|paizo|alpine|\bkill|attack|weapon|target|shoot|\bguns?\b|violen|injur|maim|wound|blood|\bdie\b|\bdead|death|crash|smash/i
const SYNTAX = /[`~/\\$<>{}|]|\.ts\b|\.tsx\b|--|\bnpm\b|\bsudo\b/
/** A sentence or a done line: words, digits, a colon and a percent sign, and a decimal point only inside a number. */
const PLAIN = /^[A-Za-z0-9 :%]+$/

// ---------------------------------------------------------------- the protocol

test('the eleven answers of the protocol read as the contract says: proposed, refused with the reason, or nothing, with the line stripped from the text', () => {
  const one = proposed('It will be dark soon.\nACTION: time 22:00')
  assert.deepEqual([one.action.canonical, one.text, one.line, one.note], ['time 22:00', 'It will be dark soon.', 'ACTION: time 22:00', undefined])
  const two = proposed('`Action - Clock night.`')
  assert.deepEqual([two.action.canonical, two.text], ['time 22:00', ''], 'synonym, named time, backticks and the full stop stripped')
  assert.equal(canonical('ACTION: time 9 pm'), 'time 21:00')
  const four = proposed('ACTION: light haze 9')
  assert.deepEqual([four.action.canonical, four.note], ['light haze 4', 'clamped from 9'])
  const five = proposed('ACTION: rain on\nSure.\nACTION: rain on')
  assert.deepEqual([five.action.canonical, five.text], ['rain on', 'Sure.'], 'identical lines merge')
  assert.equal(reason('ACTION: rain on\nACTION: time 12:00'), MORE_THAN_ONE)
  assert.equal(reason('ACTION: teleport 10 20'), "no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound)")
  assert.equal(reason('I set the clock for you. ACTION: time 21:00'), NOT_ALONE)
  assert.equal(reason('ACTION: clock 25:00'), 'time takes HH:MM from 00:00 to 23:59, or a name from midnight to night')
  assert.deepEqual(parseAction('ACTION: none'), { kind: 'none', text: '' })
  // Eleven: a thinking piece and a cut answer never reach the parser (acts.ts, rule 0); the text itself is nothing proposed.
  assert.deepEqual(parseAction('ok'), { kind: 'none', text: 'ok' })
  assert.deepEqual(parseAction('ACTION: nothing\nthanks'), { kind: 'none', text: 'thanks' })
  // The shape every proposal and refusal has.
  assert.deepEqual(Object.keys(one).sort(), ['action', 'kind', 'line', 'text'])
  assert.deepEqual(Object.keys(four).sort(), ['action', 'kind', 'line', 'note', 'text'])
  assert.ok(Object.isFrozen(one.action))
})

test('a line of its own: a head glued to prose is refused with its reason, a decorated line on its own is read, and the text keeps every other line', () => {
  assert.equal(reason('I set the clock for you. ACTION: time 21:00'), NOT_ALONE)
  assert.equal(reason('Sure.\nThe next action: open the console.'), NOT_ALONE)
  assert.equal(reason('So, city action = time 20:00 is what I propose.'), NOT_ALONE)
  assert.equal(reason('city action = time 20:00 is what I propose'), HINTS.time, 'a line that opens with the head is the line: its value is read, and refused for what it is')
  const glued = refused('I set the clock for you. ACTION: time 21:00')
  assert.deepEqual([glued.text, glued.line], ['I set the clock for you. ACTION: time 21:00', undefined], 'nothing was stripped: no line stood alone')
  for (const [line, c] of [
    ['**ACTION:** time 20:00', 'time 20:00'], ['- action: "quality lite"', 'quality lite'], ['> City action = cars park', 'cars park'],
    ['  ACTION — crowd 50.  ', 'crowd 50'], ['Action: Sound Off', 'sound off'], ['ACTION:time 6:30', 'time 06:30'], ['_action - rain off_', 'rain off'],
  ] as const) assert.equal(canonical(line), c, line)
  const p = proposed('First line.\n\nACTION: rain on\nLast line.\n\n')
  assert.deepEqual([p.text, p.line], ['First line.\n\nLast line.', 'ACTION: rain on'], 'the line and its break go; the rest stays; trailing white space is trimmed')
  assert.equal(parseAction('Plain answer with no line.\n').text, 'Plain answer with no line.')
  assert.equal(parseAction('An answer with the word action in it: it takes action.').kind, 'none', 'a head is the word followed by a separator')
})

test('more than one action: two different lines are refused, never the first taken; identical and synonymous lines merge into one', () => {
  assert.equal(reason('ACTION: rain on\nACTION: time 12:00'), MORE_THAN_ONE)
  assert.equal(reason('ACTION: time 12:00\nACTION: rain on'), MORE_THAN_ONE)
  assert.equal(reason('ACTION: none\nACTION: rain on'), MORE_THAN_ONE)
  assert.equal(reason('ACTION: crowd 50\nACTION: crowd 51'), MORE_THAN_ONE)
  const merged = proposed('ACTION: time 9 pm\nACTION: clock 21:00\nfine')
  assert.deepEqual([merged.action.canonical, merged.text, merged.line], ['time 21:00', 'fine', 'ACTION: time 9 pm'], 'the same canonical form is one proposal; the first line rides along')
  assert.equal(canonical('ACTION: crowd fewer\nACTION: people 50%'), 'crowd 50')
  assert.equal(canonical('ACTION: light haze 9\nACTION: haze 4'), 'light haze 4', 'merged after the clamp')
  assert.equal(parseAction('ACTION: none\nACTION: nothing').kind, 'none')
  // A line that cannot be read is refused for its own reason, whichever line it is.
  assert.equal(reason('ACTION: rain on\nACTION: teleport 1 2'), "no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound)")
})

test('never wrapped: the clock takes 00:00 to 23:59, am and pm, or a named time; 25:00 and 24:00 are refused, not wrapped', () => {
  for (const bad of ['clock 25:00', 'time 24:00', 'time 7:60', 'time 13 pm', 'time 0 am', 'time 99', 'time -1', 'time 22:00:00', 'time tonight', 'time', 'hour 2 5']) {
    assert.equal(reason(`ACTION: ${bad}`), HINTS.time, bad)
  }
  for (const [v, c] of [
    ['23:59', '23:59'], ['00:00', '00:00'], ['0:00', '00:00'], ['0', '00:00'], ['7', '07:00'], ['12 am', '00:00'], ['12 pm', '12:00'], ['9pm', '21:00'], ['9:30 AM', '09:30'],
    ['1 pm', '13:00'], ['Golden Hour', '17:23'], ['dawn', '06:15'], ['dusk', '18:30'], ['midnight', '00:00'], ['night', '22:00'],
  ] as const) assert.equal(canonical(`ACTION: time ${v}`), `time ${c}`, v)
  for (const [h, name] of TIMES) assert.equal(canonical(`ACTION: hour ${name}`), `time ${formatClock(h)}`, name)
  // The clock set reads back the very minute the sentence named, for every minute of the day.
  for (const [h, m] of [[0, 0], [6, 15], [17, 23], [22, 0], [23, 59], [9, 1], [12, 30]]) {
    const value = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    const f = fakeSim()
    assert.equal(perform(act(`ACTION: time ${value}`), f.sim, undefined), `the clock is set to ${value}`)
    const set = Number(f.writes[0].split(' ')[1])
    assert.ok(set >= h + m / 60 && set < h + (m + 1) / 60 && set < 24, `${value} → ${set}`)
  }
})

test('haze 9 clamps to 4, noted: every light dial is clamped into its range at both ends with the clamp noted, rounded to two decimals, and refused when not a number', () => {
  const four = proposed('ACTION: light haze 9')
  assert.deepEqual([four.action.canonical, four.note], ['light haze 4', 'clamped from 9'])
  assert.deepEqual([proposed('ACTION: light haze -1').action.value, proposed('ACTION: light haze -1').note], ['haze 0', 'clamped from -1'])
  for (const key of ['haze', 'exposure', 'sun', 'fill'] as const) {
    const [lo, hi] = LIGHT_RANGE[key]
    const over = proposed(`ACTION: light ${key} ${hi + 2}`)
    assert.deepEqual([over.action.value, over.note], [`${key} ${hi}`, `clamped from ${hi + 2}`], key)
    const under = proposed(`ACTION: ${key} ${lo - 1}`)
    assert.deepEqual([under.action.value, under.note], [`${key} ${lo}`, `clamped from ${lo - 1}`], `bare ${key}`)
    const edge = proposed(`ACTION: lights ${key} ${hi}`)
    assert.deepEqual([edge.action.value, edge.note], [`${key} ${hi}`, undefined], 'the end of the range itself is not a clamp')
    assert.equal(proposed(`ACTION: lighting ${key} ${lo}`).note, undefined)
  }
  assert.deepEqual([proposed('ACTION: light haze 1.5').action.canonical, proposed('ACTION: light haze 1.5').note], ['light haze 1.5', undefined])
  assert.equal(canonical('ACTION: haze 0.333'), 'light haze 0.33', 'two decimals at most')
  assert.equal(canonical('ACTION: light exposure .5'), 'light exposure 0.5')
  assert.equal(proposed('ACTION: light exposure 0.1').note, 'clamped from 0.1')
  for (const bad of ['light 2', 'light haze', 'light haze two', 'light glow 1', 'light haze 1 2', 'haze', 'light haze 1e400', 'light haze NaN']) assert.equal(reason(`ACTION: ${bad}`), HINTS.light, bad)
  assert.equal(sentence(four.action), 'set the light haze to 4')
})

test('no city action called: an unknown verb is refused naming it and the seven verbs; weather is not rain; every synonym names its verb', () => {
  const hint = (v: string) => `no city action called '${v}' (time, rain, light, quality, cars, crowd, sound)`
  assert.equal(reason('ACTION: teleport 10 20'), hint('teleport'))
  assert.equal(reason('ACTION: weather on'), hint('weather'))
  assert.equal(reason('ACTION: weather rain'), hint('weather'))
  assert.equal(reason('ACTION:'), hint(''))
  assert.equal(reason('ACTION: pizza!!! now'), hint('pizza'), 'the word is quoted in plain letters, nothing else')
  assert.equal(reason('ACTION: spawn'), hint('spawn'))
  assert.equal(reason('ACTION: avatar.teleport(1, 2)'), hint('avatar.teleport1'))
  assert.equal(reason(`ACTION: ${'x'.repeat(100)}`), hint('x'.repeat(24)), 'cut short')
  // A lexicon word the stream screen could not see (it reads `k!i!l!l` as four letters) is assembled by the stripping
  // and must not be quoted back: the reason reaches the console, the chain and the proposer's next prompt.
  for (const line of ['ACTION: k!i!l!l 10', 'ACTION: s*h*o*o*t now', 'ACTION: w.e.a.p.o.n']) {
    const r = reason(line)
    assert.equal(r, 'no city action by that name (time, rain, light, quality, cars, crowd, sound)', line)
    assert.equal(screen(r).admissible, true, line)
  }
  const synonyms: [string, string][] = [
    ['time 22:00', 'time 22:00'], ['clock 22:00', 'time 22:00'], ['hour 22:00', 'time 22:00'],
    ['rain on', 'rain on'],
    ['light haze 1', 'light haze 1'], ['lights haze 1', 'light haze 1'], ['lighting haze 1', 'light haze 1'], ['haze 1', 'light haze 1'], ['exposure 1', 'light exposure 1'], ['sun 1', 'light sun 1'], ['fill 1', 'light fill 1'],
    ['quality low', 'quality low'], ['tier low', 'quality low'], ['graphics low', 'quality low'],
    ['cars park', 'cars park'], ['car park', 'cars park'], ['traffic park', 'cars park'], ['vehicles park', 'cars park'],
    ['crowd 50', 'crowd 50'], ['people 50', 'crowd 50'], ['pedestrians 50', 'crowd 50'],
    ['sound off', 'sound off'], ['audio off', 'sound off'], ['volume off', 'sound off'],
  ]
  for (const [line, c] of synonyms) assert.equal(canonical(`ACTION: ${line}`), c, line)
  assert.deepEqual(VERBS, ['time', 'rain', 'light', 'quality', 'cars', 'crowd', 'sound'])
})

test('quality: the labels, lite and auto, and integers clamped into Lite…Ultra with the clamp noted; the sentence names the tier', () => {
  for (const [v, c] of [['auto', 'auto'], ['lite', 'lite'], ['Minimal', 'minimal'], ['low', 'low'], ['MEDIUM', 'medium'], ['high', 'high'], ['ultra', 'ultra'], ['-1', 'lite'], ['0', 'minimal'], ['2', 'medium'], ['4', 'ultra']] as const) {
    const p = proposed(`ACTION: quality ${v}`)
    assert.deepEqual([p.action.canonical, p.note], [`quality ${c}`, undefined], v)
  }
  assert.deepEqual([proposed('ACTION: quality 9').action.value, proposed('ACTION: quality 9').note], ['ultra', 'clamped from 9'])
  assert.deepEqual([proposed('ACTION: tier -3').action.value, proposed('ACTION: tier -3').note], ['lite', 'clamped from -3'])
  assert.equal(LITE_TIER, -1)
  for (const bad of ['quality', 'quality best', 'quality 1.5', 'quality auto low', 'graphics potato']) assert.equal(reason(`ACTION: ${bad}`), HINTS.quality, bad)
  assert.equal(sentence(act('ACTION: quality low')), 'set the quality to Low')
  assert.equal(sentence(act('ACTION: quality lite')), 'set the quality to Lite')
  assert.equal(sentence(act('ACTION: quality auto')), 'let the quality govern itself')
  assert.equal(sentence(act('ACTION: quality 4')), 'set the quality to Ultra')
})

test('rain, cars, crowd and sound: their words and numbers, the clamps at both ends noted, and the hint for anything else', () => {
  assert.equal(canonical('ACTION: rain ON'), 'rain on')
  assert.equal(canonical('ACTION: rain off'), 'rain off')
  for (const bad of ['rain', 'rain heavy', 'rain 50', 'rain on off']) assert.equal(reason(`ACTION: ${bad}`), HINTS.rain, bad)
  for (const [v, c] of [['park', 'park'], ['parked', 'park'], ['stop', 'park'], ['drive', 'drive'], ['ai', 'drive'], ['go', 'drive'], ['release', 'drive']] as const) assert.equal(canonical(`ACTION: cars ${v}`), `cars ${c}`, v)
  for (const bad of ['cars', 'cars fewer', 'cars 50', 'cars park now']) assert.equal(reason(`ACTION: ${bad}`), HINTS.cars, bad)
  for (const [v, c] of [['none', '0'], ['fewer', '50'], ['half', '50'], ['more', '100'], ['full', '100'], ['0', '0'], ['100', '100'], ['50%', '50'], ['50 %', '50'], ['49.6', '50'], ['7.4', '7']] as const) {
    const p = proposed(`ACTION: crowd ${v}`)
    assert.deepEqual([p.action.canonical, p.note], [`crowd ${c}`, undefined], v)
  }
  assert.deepEqual([proposed('ACTION: crowd 150').action.value, proposed('ACTION: crowd 150').note], ['100', 'clamped from 150'])
  assert.deepEqual([proposed('ACTION: people -5').action.value, proposed('ACTION: people -5').note], ['0', 'clamped from -5'])
  for (const bad of ['crowd', 'crowd many', 'crowd 5 0', 'crowd NaN', 'crowd 50%%']) assert.equal(reason(`ACTION: ${bad}`), HINTS.crowd, bad)
  for (const [v, c] of [['on', 'on'], ['off', 'off'], ['mute', 'off'], ['0', '0'], ['100', '100'], ['40%', '40'], ['39.5', '40']] as const) {
    const p = proposed(`ACTION: sound ${v}`)
    assert.deepEqual([p.action.canonical, p.note], [`sound ${c}`, undefined], v)
  }
  assert.deepEqual([proposed('ACTION: sound 250%').action.value, proposed('ACTION: sound 250%').note], ['100', 'clamped from 250'])
  assert.deepEqual([proposed('ACTION: volume -10').action.value, proposed('ACTION: volume -10').note], ['0', 'clamped from -10'])
  for (const bad of ['sound', 'sound loud', 'sound on 50', 'audio up']) assert.equal(reason(`ACTION: ${bad}`), HINTS.sound, bad)
  assert.equal(sentence(act('ACTION: rain on')), 'turn rain mode on')
  assert.equal(sentence(act('ACTION: rain off')), 'turn rain mode off')
  assert.equal(sentence(act('ACTION: cars park')), 'park every car')
  assert.equal(sentence(act('ACTION: cars drive')), 'let every car drive')
  assert.equal(sentence(act('ACTION: crowd 50')), 'set the crowd to 50%')
  assert.equal(sentence(act('ACTION: sound on')), 'turn the sound on')
  assert.equal(sentence(act('ACTION: sound off')), 'turn the sound off')
  assert.equal(sentence(act('ACTION: sound 40')), 'set the volume to 40%')
  assert.equal(sentence(act('ACTION: time 22:00')), 'set the clock to 22:00')
  assert.equal(sentence(act('ACTION: light haze 1.5')), 'set the light haze to 1.5')
})

// ---------------------------------------------------------------- what the city says

/** Every line the city can say about an action: sentences and done lines at both ends of every range, every hint, the rows and the prompt. */
function everythingSaid(): { sentences: string[]; done: string[]; other: string[] } {
  const lines = [
    'time 00:00', 'time 23:59', 'time 17:23', 'rain on', 'rain off', 'light haze 0', 'light haze 4', 'light exposure 0.25', 'light exposure 3', 'light sun 0', 'light sun 3', 'light fill 0', 'light fill 3',
    'quality auto', 'quality lite', 'quality minimal', 'quality low', 'quality medium', 'quality high', 'quality ultra', 'cars park', 'cars drive', 'crowd 0', 'crowd 100', 'crowd 50',
    'sound on', 'sound off', 'sound 0', 'sound 100', 'sound 40',
  ]
  const sentences: string[] = []
  const done: string[] = []
  for (const l of lines) {
    const a = act(`ACTION: ${l}`)
    sentences.push(sentence(a))
    for (const opts of [{ cars: 0 }, { cars: 1 }, { cars: 8 }, { cars: 70, driven: 3 }]) done.push(perform(a, fakeSim(opts).sim, fakeCity().city))
  }
  const other = [
    ...Object.values(HINTS), NOT_ALONE, MORE_THAN_ONE, reason('ACTION: teleport 10 20'), reason('ACTION:'), ...catalogueLines(), ...ACTION_RULES,
    'clamped from 9', 'rain mode is not reachable from here', 'the sound is not reachable from here',
  ]
  return { sentences, done, other }
}

test('content sweep: every sentence, done line, hint, row and prompt line passes the 14A screen and the card\'s rules, with no exclamation mark; sentences and done lines have no syntax but a colon and a percent sign', () => {
  const { sentences, done, other } = everythingSaid()
  const all = [...sentences, ...done, ...other]
  assert.ok(all.length > 150, `${all.length} lines`)
  for (const s of all) {
    assert.ok(s.length > 0 && !/\n|\s$/.test(s), JSON.stringify(s))
    assert.equal(screen(s).admissible, true, s)
    assert.doesNotMatch(s, BANNED, s)
    assert.doesNotMatch(s, SYNTAX, s)
    assert.doesNotMatch(s, /!/, s)
  }
  for (const s of [...sentences, ...done]) assert.match(s.replace(/(\d)\.(\d)/g, '$1$2'), PLAIN, s)
  assert.deepEqual(new Set(sentences).size, sentences.length, 'every value its own sentence')
})

test('the four prompt lines: the example stands alone and parses, every verb is named, nothing in them is refused by the screen or carries an exclamation mark', () => {
  assert.equal(ACTION_RULES.length, 4)
  assert.ok(Object.isFrozen(ACTION_RULES))
  assert.equal(ACTION_RULES[1], 'ACTION: time 20:00')
  assert.equal(canonical(ACTION_RULES[1]), 'time 20:00')
  assert.match(ACTION_RULES[0], /^City actions: /)
  assert.match(ACTION_RULES[0], /exactly like this example:$/)
  for (const verb of VERBS) assert.match(ACTION_RULES[2], new RegExp(`\\b${verb}\\b`), verb)
  for (const [, name] of TIMES) assert.ok(ACTION_RULES[2].includes(name), name)
  assert.match(ACTION_RULES[3], /ACTION: none also means none/)
  assert.match(ACTION_RULES[3], /never say that it happened\.$/)
  for (const line of ACTION_RULES) {
    assert.equal(screen(line).admissible, true, line)
    assert.doesNotMatch(line, /!/, line)
    assert.doesNotMatch(line, /\n/, line)
  }
  assert.equal(parseAction(ACTION_RULES.join('\n')).kind, 'proposed', 'the whole rule text has one line standing alone (the example)')
})

test('source pin against world.ts: the light ranges mirrored here equal LIGHT_TUNE_RANGE by its source text, and world.ts is never imported', () => {
  const world = readFileSync(new URL('../01_Initialize_World/world.ts', import.meta.url), 'utf8')
  const m = /export const LIGHT_TUNE_RANGE[^=]*=\s*\{\s*([^}]*)\}/.exec(world)
  assert.ok(m, 'world.ts declares LIGHT_TUNE_RANGE')
  const pinned: Record<string, [number, number]> = {}
  for (const pair of m![1].matchAll(/(\w+):\s*\[\s*([\d.]+)\s*,\s*([\d.]+)\s*\]/g)) pinned[pair[1]] = [Number(pair[2]), Number(pair[3])]
  assert.deepEqual(pinned, { haze: [0, 4], exposure: [0.25, 3], sun: [0, 3], fill: [0, 3] }, 'world.ts as read')
  assert.deepEqual(Object.fromEntries(Object.entries(LIGHT_RANGE).map(([k, v]) => [k, [...v]])), pinned)
  assert.ok(Object.isFrozen(LIGHT_RANGE) && Object.values(LIGHT_RANGE).every((r) => Object.isFrozen(r)))
  const self = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(self, /from '[^']*(?:world\.ts|three|\.wgsl)[^']*'/, 'the catalogue never pulls the GPU world in')
  const imports = [...self.matchAll(/^import (type )?\{[^}]*\} from '([^']+)'/gm)].map((i) => `${i[1] ?? ''}${i[2]}`).sort()
  assert.deepEqual(imports, ['../01_Initialize_World/solar.ts', '../02_Define_The_Rules/conduct.ts', '../05_Observe_Environment/governor.ts', './intent.ts', 'type ../07_Execute_Actions/operator.ts'], 'downward imports only; operator.ts as a type')
  assert.doesNotMatch(self, /fetch\(|WebSocket|localStorage|indexedDB|eval\(|new Function|import\(/, 'pure: no I/O, no code built at run time')
})

// ---------------------------------------------------------------- the scripted provider

test('rain on please: the scripted provider\'s line over the prompts the smoke types, the rain word included; a question, a bare noun and a value-less control propose nothing', () => {
  const table: [string, string | null, string | null][] = [
    ['make it night', 'ACTION: time 22:00', 'set the clock to 22:00'],
    ['make it noon', 'ACTION: time 12:00', 'set the clock to 12:00'],
    ['thin the crowd', 'ACTION: crowd 50', 'set the crowd to 50%'],
    ['lowest quality please', 'ACTION: quality lite', 'set the quality to Lite'],
    ['make it golden hour', 'ACTION: time 17:23', 'set the clock to 17:23'],
    ['turn the sound off', 'ACTION: sound off', 'turn the sound off'],
    ['rain on please', 'ACTION: rain on', 'turn rain mode on'],
    ['fewer cars on the roads', 'ACTION: cars park', 'park every car'],
    ['hi', null, null],
    ['park the cars', null, null],
    ['how does car.grip work?', null, null],
    ['rain mode off', 'ACTION: rain off', 'turn rain mode off'],
    ['Rain OFF now', 'ACTION: rain off', 'turn rain mode off'],
    ['clear the streets', 'ACTION: crowd 0', 'set the crowd to 0%'],
    ['more people please', 'ACTION: crowd 100', 'set the crowd to 100%'],
    ['no traffic', 'ACTION: cars park', 'park every car'],
    ['more cars', 'ACTION: cars drive', 'let every car drive'],
    ['adaptive quality', 'ACTION: quality auto', 'let the quality govern itself'],
    ['ultra graphics', 'ACTION: quality ultra', 'set the quality to Ultra'],
    ['sound please', 'ACTION: sound on', 'turn the sound on'],
    ['volume 30', 'ACTION: sound 30', 'set the volume to 30%'],
    ['it is raining', null, null],
    ['', null, null],
  ]
  for (const [prompt, line, said] of table) {
    assert.equal(scriptedAction(prompt), line, prompt)
    if (line) assert.equal(sentence(act(line)), said, prompt)
  }
  assert.equal(scriptedAction('make it night'), scriptedAction('make it night'), 'deterministic')
})

// ---------------------------------------------------------------- perform

test('perform makes exactly one facade call per verb, reads the done line back off the facade, and reaches rain mode and the sound only through the city knobs', () => {
  const run = (line: string, opts: { cars?: number; driven?: number } = {}) => {
    const f = fakeSim(opts)
    const c = fakeCity()
    const done = perform(act(line), f.sim, c.city)
    return { done, writes: f.writes, reads: f.reads, city: c.calls }
  }
  const time = run('ACTION: time 22:00')
  assert.deepEqual([time.done, time.writes.length, time.city, time.reads], ['the clock is set to 22:00', 1, [], ['clock.hours']])
  assert.match(time.writes[0], /^clock\.set 22\.0000/)
  const rain = run('ACTION: rain on')
  assert.deepEqual([rain.done, rain.writes, rain.city], ['rain mode is on', [], ['rain true']])
  assert.deepEqual(run('ACTION: rain off').done, 'rain mode is off')
  const light = run('ACTION: light haze 1.5')
  assert.deepEqual([light.done, light.writes, light.city], ['the light haze is 1.5', ['shaders.set light.haze 1.5'], []])
  assert.deepEqual(run('ACTION: exposure 0.25').writes, ['shaders.set light.exposure 0.25'])
  const quality = run('ACTION: quality low')
  assert.deepEqual([quality.done, quality.writes], ['the quality is Low', ['quality.set 1']])
  assert.deepEqual(run('ACTION: quality lite').writes, ['quality.set -1'])
  const auto = run('ACTION: quality auto')
  assert.deepEqual([auto.done, auto.writes], ['the quality governs itself', ['quality.set auto']])
  const crowd = run('ACTION: crowd 50')
  assert.deepEqual([crowd.done, crowd.writes], ['the crowd is at 50% until the quality tier next changes', ['crowd.cull {"density":0.5}']])
  assert.deepEqual(run('ACTION: crowd 0').writes, ['crowd.cull {"density":0}'])
  const sound = run('ACTION: sound 40')
  assert.deepEqual([sound.done, sound.writes, sound.city], ['the volume is 40%', [], ['audio 40']])
  assert.deepEqual([run('ACTION: sound on').done, run('ACTION: sound on').city], ['the sound is on', ['audio on']])
  assert.deepEqual([run('ACTION: sound mute').done, run('ACTION: sound mute').city], ['the sound is off', ['audio off']])
  // Without the city knobs, rain mode and the sound are refused with a plain Error and nothing is called.
  for (const [line, message] of [['ACTION: rain on', 'rain mode is not reachable from here'], ['ACTION: sound off', 'the sound is not reachable from here']] as const) {
    const f = fakeSim()
    assert.throws(() => perform(act(line), f.sim, undefined), (e: unknown) => e instanceof Error && e.constructor === Error && e.message === message)
    assert.deepEqual(f.writes, [])
  }
  // A hand-made action outside the catalogue is an error, never a call.
  const f = fakeSim()
  assert.throws(() => perform({ verb: 'time', value: '25:00', canonical: 'time 25:00' }, f.sim, undefined), /not a catalogue action: time 25:00/)
  assert.throws(() => perform({ verb: 'spawn' as 'time', value: '1', canonical: 'spawn 1' }, f.sim, undefined), /not a catalogue action: spawn 1/)
  assert.throws(() => sentence({ verb: 'crowd', value: 'lots', canonical: 'crowd lots' }), /not a catalogue action/)
  assert.deepEqual(f.writes, [])
})

test('cars: one setMode per car that is not being driven, the driven one skipped, 64 at most, and the done line counts what was sent', () => {
  const eight = fakeSim({ cars: 8 })
  assert.equal(perform(act('ACTION: cars park'), eight.sim, undefined), '8 cars parked')
  assert.deepEqual(eight.writes, Array.from({ length: 8 }, (_, i) => `vehicles.setMode ${i} parked`))
  const drive = fakeSim({ cars: 8, driven: 2 })
  assert.equal(perform(act('ACTION: cars drive'), drive.sim, undefined), '7 cars handed to their drivers')
  assert.deepEqual(drive.writes, [0, 1, 3, 4, 5, 6, 7].map((i) => `vehicles.setMode ${i} ai`), 'the driven car is left alone, never offered to the facade')
  assert.equal(MAX_CAR_SENDS, 64)
  const many = fakeSim({ cars: 120, driven: 3 })
  assert.equal(perform(act('ACTION: cars park'), many.sim, undefined), '64 of 119 cars parked')
  assert.equal(many.writes.length, 64)
  assert.deepEqual(many.writes.slice(0, 4), ['vehicles.setMode 0 parked', 'vehicles.setMode 1 parked', 'vehicles.setMode 2 parked', 'vehicles.setMode 4 parked'])
  assert.equal(many.writes.at(-1), 'vehicles.setMode 64 parked')
  const exact = fakeSim({ cars: 64 })
  assert.equal(perform(act('ACTION: cars drive'), exact.sim, undefined), '64 cars handed to their drivers', 'at the cap with none left over, no "of"')
  assert.equal(perform(act('ACTION: cars park'), fakeSim({ cars: 1 }).sim, undefined), '1 car parked')
  assert.equal(perform(act('ACTION: cars park'), fakeSim({ cars: 1, driven: 0 }).sim, undefined), '0 cars parked')
  assert.equal(perform(act('ACTION: cars park'), fakeSim().sim, undefined), '0 cars parked')
})

// ---------------------------------------------------------------- the rows, purity

test('the act list rows: one per verb in catalogue order, the verb padded to 10 and the values to 36, plain words only', () => {
  const rows = catalogueLines()
  assert.deepEqual(rows, [
    '  time      HH:MM, or midnight to night          set the clock',
    '  rain      on, off                              turn rain mode on or off',
    '  light     haze, exposure, sun or fill, a number set a light dial',
    '  quality   auto, lite, minimal to ultra         pin or free the quality tier',
    '  cars      park, drive                          park every car, or let them drive',
    '  crowd     0 to 100                             set the crowd density',
    '  sound     on, off, 0 to 100                    the sound and its volume',
  ])
  assert.deepEqual(rows.map((r) => r.slice(2, 12).trim()), [...VERBS])
  for (const r of rows) {
    assert.equal(r.slice(0, 2), '  ')
    assert.equal(r.charAt(11), ' ', 'the values start at column 12')
  }
  assert.ok(Object.isFrozen(rows))
  assert.deepEqual(catalogueLines(), rows, 'the same every time')
})

test('pure and total: the parser never throws, reads the same text the same way, and every canonical line reads back to itself', () => {
  const odd = ['', '\n', '\n\n\n', '   ', 'ACTION', 'ACTION:'.repeat(500), `ACTION: ${'x'.repeat(10_000)}`, 'ACTION: time 22:00\r\nok\r\n', '\u0000ACTION: rain on\u0000', 'action:\n:action', 'ACTION: 時間 22:00', '🙂 ACTION: crowd 50 🙂', 'ACTION: time 22:00 '.repeat(40)]
  for (const o of odd) {
    let p: Parsed | null = null
    assert.doesNotThrow(() => { p = parseAction(o) }, JSON.stringify(o))
    assert.deepEqual(parseAction(o), p, 'deterministic')
  }
  assert.deepEqual(parseAction(undefined as unknown as string), { kind: 'none', text: '' })
  assert.deepEqual(parseAction(42 as unknown as string), { kind: 'none', text: '42' })
  assert.equal(canonical('ACTION: time 22:00\r\nok\r\n'), 'time 22:00')
  assert.equal(parseAction('ACTION: time 22:00\r\nok\r\n').text, 'ok')
  assert.equal(reason('ACTION: time 22:00 '.repeat(40)), HINTS.time, 'one physical line is one candidate, however often the head repeats in it: its value is not a time')
  for (const line of ['time 22:00', 'time 00:00', 'rain on', 'light haze 1.5', 'light exposure 0.25', 'quality lite', 'quality auto', 'quality ultra', 'cars park', 'cars drive', 'crowd 50', 'crowd 0', 'sound off', 'sound 40']) {
    const p = proposed(`ACTION: ${line}`)
    assert.deepEqual([p.action.canonical, p.action.value, p.note], [line, line.slice(line.indexOf(' ') + 1), undefined], line)
    assert.equal(canonical(`ACTION: ${p.action.canonical}`), line, 'round trip')
  }
})
