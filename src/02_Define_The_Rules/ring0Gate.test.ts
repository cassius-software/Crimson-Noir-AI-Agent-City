// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the Ring-0 action gate (ring0Gate.ts) to its word, check by check: every check
 * refuses exactly what it names and nothing else, refusals come in rank order with the highest law first, the same
 * intent gives the same verdict every time, the First-Law table is exactly what every catalogue verb reaches (proved
 * by running each verb over a recording facade) and classifies every leaf of the facade, and the exports cannot be
 * altered. The last tests read the runtime sources: a model's words reach the city by one road only, and the gate
 * stands at every moment on it.
 * What breaks if it is removed? A check could be loosened, a verb could reach a new leaf, or an emitter could be added
 * around the gate, with nothing to say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ACTION_LEAVES, admitAsk, admitProposal, admitRun, admitWords, CHECK_INVARIANT, CHECK_LAW, CHECKS, invariantsOf, KINETIC, KINETIC_FREE, kineticLeaves, REASONS, sentence,
  type AskIntent, type CheckName, type GateVerdict, type ProposalIntent, type RunIntent,
} from './ring0Gate.ts'
import { INVARIANTS } from './guardrails.ts'
import { LAW_NAMES, LAWS } from './laws.ts'
import { parseAction, perform, VERBS, type CityKnobs } from '../06_Make_Decisions/actions.ts'
import { scriptApi, type SimControls } from '../07_Execute_Actions/operator.ts'
import type { SipocSnapshot } from '../05_Observe_Environment/telemetry.ts'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
// The scanner defence is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const HELD: string = '../../tools/test/held.mjs'
/** readFileSync that waits out a file a Windows on-access scanner holds (tools/test/held.mjs): the walk below reads hundreds. */
const { readHeld } = (await import(HELD)) as { readHeld(path: string, encoding: 'utf8'): string }

// ---------------------------------------------------------------- the intents that pass

const ASK: AskIntent = Object.freeze({ contained: true, endpoint: 'http://localhost:11434', unlocked: true })
const PROPOSAL: ProposalIntent = Object.freeze({ contained: true, line: 'ACTION: time 22:00', catalogued: true, unlocked: true, vacant: true })
const RUN: RunIntent = Object.freeze({ contained: true, verb: 'time', panic: null, unlocked: true, allowedBy: 'console', held: true, proposer: true, chainOk: true })

const ADMITTED: GateVerdict = Object.freeze({ admitted: true, law: null, failed: Object.freeze([]) })

/** The verdict a single failed check gives. */
const refusedBy = (check: CheckName, reason: string): GateVerdict => ({ admitted: false, law: CHECK_LAW[check], failed: [{ law: CHECK_LAW[check], check, reason }] })

test('the table: twelve checks, named once, in rank order under the four laws, each with a sentence; every check stands under an invariant or none; everything is frozen', () => {
  assert.equal(CHECKS.length, 12)
  assert.equal(new Set(CHECKS.map((c) => c.name)).size, CHECKS.length)
  for (let i = 1; i < CHECKS.length; i++) assert.ok(CHECKS[i - 1].law <= CHECKS[i].law, `${CHECKS[i].name} is ranked under ${CHECKS[i - 1].name}`)
  assert.deepEqual([...new Set(CHECKS.map((c) => c.law))], LAWS.map((l) => l.id), 'every law has a check')
  for (const c of CHECKS) {
    assert.match(c.text, /\w+ \w+/, c.name)
    assert.equal(CHECK_LAW[c.name], c.law)
    const inv = CHECK_INVARIANT[c.name]
    assert.ok(inv === null || INVARIANTS.includes(inv), `${c.name} → ${inv}`)
  }
  assert.deepEqual(Object.keys(CHECK_INVARIANT).sort(), CHECKS.map((c) => c.name).sort())
  for (const o of [CHECKS, ...CHECKS, CHECK_LAW, CHECK_INVARIANT, REASONS, ACTION_LEAVES, ...Object.values(ACTION_LEAVES), KINETIC, KINETIC_FREE]) assert.ok(Object.isFrozen(o))
  for (const f of [admitAsk, admitProposal, admitRun, admitWords, sentence, invariantsOf, kineticLeaves]) assert.ok(Object.isFrozen(f), f.name)
  assert.deepEqual(admitAsk(ASK), ADMITTED)
  assert.deepEqual(admitProposal(PROPOSAL), ADMITTED)
  assert.deepEqual(admitRun(RUN), ADMITTED)
  assert.deepEqual(admitWords('Should it be morning, sunset or night when you arrive?'), ADMITTED)
  assert.equal(sentence(ADMITTED), '')
  assert.deepEqual(invariantsOf(ADMITTED), [])
})

test('before a model is asked: contained (true only), on this machine or none, unlocked; each refusal names its check and nothing else', () => {
  assert.deepEqual(admitAsk({ ...ASK, endpoint: null }), ADMITTED, 'no endpoint: the script, or a model in this page')
  assert.deepEqual(admitAsk({ ...ASK, endpoint: 'https://127.0.0.1:8443/v1' }), ADMITTED, 'https to this machine, a path dropped')
  assert.deepEqual(admitAsk({ ...ASK, endpoint: 'http://[::1]:8080' }), ADMITTED)
  for (const vouched of [null, false] as const) assert.deepEqual(admitAsk({ ...ASK, contained: vouched }), refusedBy('Contained', REASONS.Contained), String(vouched))
  assert.deepEqual(admitAsk({ ...ASK, endpoint: 'https://api.example.com' }), refusedBy('LoopbackOnly', 'https://api.example.com is not on this machine'))
  assert.deepEqual(admitAsk({ ...ASK, endpoint: 'http://user:pw@localhost:11434' }), refusedBy('LoopbackOnly', 'http://user:pw@localhost:11434 is not on this machine'), 'credentials in the URL')
  assert.deepEqual(admitAsk({ ...ASK, endpoint: 'ws://localhost:8787' }), refusedBy('LoopbackOnly', 'ws://localhost:8787 is not on this machine'), 'a model server speaks http(s)')
  assert.deepEqual(admitAsk({ ...ASK, unlocked: false }), refusedBy('OperatorUnlocked', REASONS.OperatorUnlocked))
  // Everything at once: every check that failed, in rank order, and the Zeroth Law named first.
  const all = admitAsk({ contained: null, endpoint: 'https://api.example.com', unlocked: false })
  assert.deepEqual(all.failed.map((r) => r.check), ['Contained', 'LoopbackOnly', 'OperatorUnlocked'])
  assert.equal(all.law, 0)
  assert.equal(sentence(all), `Zeroth Law: ${REASONS.Contained}`)
  assert.deepEqual(invariantsOf(all), ['LoopbackOnly', 'HumanOverrideSupreme'], 'the two Zeroth-Law checks share one invariant, named once')
})

test('an ACTION line read: contained, screened, of the catalogue, unlocked, one at a time', () => {
  assert.deepEqual(admitProposal({ ...PROPOSAL, contained: null }), refusedBy('Contained', REASONS.Contained))
  assert.deepEqual(admitProposal({ ...PROPOSAL, line: 'ACTION: time 22:00 you idiot' }), refusedBy('Conduct14A', 'the line failed the 14A screen (toxicity)'))
  assert.deepEqual(admitProposal({ ...PROPOSAL, catalogued: { reason: "no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound, or none)" } }), refusedBy('Catalogued', "no city action called 'teleport' (time, rain, light, quality, cars, crowd, sound, or none)"), 'the catalogue\'s own words')
  assert.deepEqual(admitProposal({ ...PROPOSAL, catalogued: { reason: '' } }), refusedBy('Catalogued', REASONS.Catalogued), 'a catalogue that gave no reason')
  assert.deepEqual(admitProposal({ ...PROPOSAL, unlocked: false }), refusedBy('OperatorUnlocked', REASONS.OperatorUnlocked))
  assert.deepEqual(admitProposal({ ...PROPOSAL, vacant: false }), refusedBy('OneAtATime', REASONS.OneAtATime))
  const all = admitProposal({ contained: false, line: 'kill the lights', catalogued: { reason: 'x' }, unlocked: false, vacant: false })
  assert.deepEqual(all.failed.map((r) => r.check), ['Contained', 'Conduct14A', 'Catalogued', 'OperatorUnlocked', 'OneAtATime'])
  assert.equal(sentence(all), `Zeroth Law: ${REASONS.Contained}`)
  assert.deepEqual(invariantsOf(all), ['LoopbackOnly', 'ConductScreen14A', 'HumanOverrideSupreme'], 'the catalogue is the gate\'s own: no invariant')
  // The words alone, for a line shown as the city's own.
  assert.deepEqual(admitWords('Pick a time of day!'), ADMITTED)
  assert.deepEqual(admitWords('Morning, sunset or night, you idiot?'), refusedBy('Conduct14A', 'the line failed the 14A screen (toxicity)'))
})

test('an allowed action about to run: contained, the realm standing, kinetic-free, unlocked, allowed by a person, the lease held, the proposer bound, the chain whole', () => {
  for (const verb of VERBS) assert.deepEqual(admitRun({ ...RUN, verb }), ADMITTED, verb)
  for (const by of ['console', 'card', 'host'] as const) assert.deepEqual(admitRun({ ...RUN, allowedBy: by }), ADMITTED, by)
  assert.deepEqual(admitRun({ ...RUN, contained: null }), refusedBy('Contained', REASONS.Contained))
  assert.deepEqual(admitRun({ ...RUN, panic: 'RUNAWAY: 41.0 m/s' }), refusedBy('RealmStanding', 'the realm has halted: RUNAWAY: 41.0 m/s'))
  assert.deepEqual(admitRun({ ...RUN, verb: 'teleport' }), refusedBy('KineticFree', "'teleport' reaches (not in the First-Law table)"))
  assert.deepEqual(admitRun({ ...RUN, verb: 'constructor' }), refusedBy('KineticFree', "'constructor' reaches (not in the First-Law table)"), 'a prototype name is not a verb')
  assert.deepEqual(admitRun({ ...RUN, unlocked: false }), refusedBy('OperatorUnlocked', REASONS.OperatorUnlocked))
  assert.deepEqual(admitRun({ ...RUN, allowedBy: null }), refusedBy('PersonAllowed', REASONS.PersonAllowed))
  assert.deepEqual(admitRun({ ...RUN, held: false }), refusedBy('LeaseHeld', REASONS.LeaseHeld))
  assert.deepEqual(admitRun({ ...RUN, proposer: false }), refusedBy('ProposerBound', REASONS.ProposerBound))
  assert.deepEqual(admitRun({ ...RUN, chainOk: false }), refusedBy('ChainVerified', REASONS.ChainVerified))
  const all = admitRun({ contained: null, verb: 'teleport', panic: 'RUNAWAY', unlocked: false, allowedBy: null, held: false, proposer: false, chainOk: false })
  assert.deepEqual(all.failed.map((r) => r.check), ['Contained', 'RealmStanding', 'KineticFree', 'OperatorUnlocked', 'PersonAllowed', 'LeaseHeld', 'ProposerBound', 'ChainVerified'])
  assert.deepEqual(all.failed.map((r) => r.law), [0, 1, 1, 2, 2, 3, 3, 3])
  assert.deepEqual(invariantsOf(all), ['LoopbackOnly', 'HumanOverrideSupreme', 'CapabilityTethered', 'ProvenanceChained'])
  // The lower laws alone: the highest of them is named.
  const lower = admitRun({ ...RUN, held: false, allowedBy: null, panic: 'x' })
  assert.equal(lower.law, 1)
  assert.equal(sentence(lower), 'First Law: the realm has halted: x')
  assert.equal(sentence(admitRun({ ...RUN, held: false, allowedBy: null })), `Second Law: ${REASONS.PersonAllowed}`)
  assert.equal(sentence(admitRun({ ...RUN, chainOk: false })), `Third Law: ${REASONS.ChainVerified}`)
})

test('deterministic: the same intent gives the same verdict every time, as frozen values the caller cannot alter; the gate keeps no clock, no randomness and no I/O', () => {
  const i: RunIntent = { contained: true, verb: 'cars', panic: 'x', unlocked: false, allowedBy: 'card', held: true, proposer: false, chainOk: true }
  const a = admitRun(i)
  for (let n = 0; n < 50; n++) assert.deepEqual(admitRun(i), a)
  assert.ok(Object.isFrozen(a) && Object.isFrozen(a.failed) && a.failed.every((r) => Object.isFrozen(r)))
  assert.throws(() => { (a as { admitted: boolean }).admitted = true }, TypeError)
  const src = code(readHeld(join(SRC, '02_Define_The_Rules/ring0Gate.ts'), 'utf8'))
  assert.doesNotMatch(src, /\bDate\b|Math\.random|\bfetch\b|\bsetTimeout\b|\bimport\s*\(|\bprocess\b|\bwindow\b|\bglobalThis\b|\bnavigator\b/)
  assert.deepEqual(specifiers(src).sort(), ['./airgap.ts', './conduct.ts', './guardrails.ts', './laws.ts'], 'it reads the rules and nothing else')
})

// ---------------------------------------------------------------- the First-Law table, proved against the catalogue

/** A SimControls whose every leaf records its dotted name and answers with a plain value; typed, so a leaf added to SimControls fails this file's typecheck until it is listed here. */
function recordingSim(): { sim: SimControls; calls: string[] } {
  const calls: string[] = []
  const sim: SimControls = {
    clock: { hours: () => { calls.push('clock.hours'); return 22 }, set: () => { calls.push('clock.set') } },
    quality: {
      state: () => { calls.push('quality.state'); return { tier: 1, label: 'Lite', auto: false, renderScale: 1, targetMs: 16.7 } },
      set: () => { calls.push('quality.set') },
    },
    avatar: {
      position: () => { calls.push('avatar.position'); return { x: 0, z: 0, heading: 0, feetY: 0 } },
      teleport: () => { calls.push('avatar.teleport') },
      interact: () => { calls.push('avatar.interact') },
      walk: () => { calls.push('avatar.walk') },
    },
    vehicles: {
      count: () => { calls.push('vehicles.count'); return 2 },
      state: (i) => { calls.push('vehicles.state'); return { x: 0, z: 0, heading: 0, speed: 0, mode: i === 1 ? 'player' : 'ai', suv: false } },
      setMode: () => { calls.push('vehicles.setMode') },
      recover: () => { calls.push('vehicles.recover') },
      intent: () => { calls.push('vehicles.intent') },
      nearest: () => { calls.push('vehicles.nearest'); return 0 },
    },
    physics: { tune: () => { calls.push('physics.tune'); return {} }, set: () => { calls.push('physics.set') } },
    shaders: { uniforms: () => { calls.push('shaders.uniforms'); return { 'light.haze': 1.5, 'light.exposure': 1, 'light.sun': 1, 'light.fill': 1 } }, set: () => { calls.push('shaders.set') } },
    crowd: {
      stats: () => { calls.push('crowd.stats'); return { drawnNear: 0, drawnFar: 0, nudges: 0, waiting: 0, crossing: 0, retreating: 0 } },
      cull: () => { calls.push('crowd.cull') },
      positions: () => { calls.push('crowd.positions'); return new Float32Array(0) },
    },
    kernel: {
      stats: () => { calls.push('kernel.stats'); return { law1: 0, law2: 0, law3: 0, sensorFlips: 0, shielded: false, last: '', audit: { ticks: 0, perimeterBreaches: 0, velocityCaps: 0, closest: Infinity, panic: null } } },
      blindSensing: () => { calls.push('kernel.blindSensing') },
    },
    snapshot: () => { calls.push('snapshot'); return { customer: { clock: '22:00' } } as unknown as SipocSnapshot },
  }
  return { sim, calls }
}

/** Every leaf of a SimControls, dotted (`clock.set`, `snapshot`). */
const leavesOf = (o: object, prefix = ''): string[] =>
  Object.entries(o).flatMap(([k, v]) => (typeof v === 'function' ? [`${prefix}${k}`] : leavesOf(v as object, `${prefix}${k}.`)))

/** One value or more of every verb, as a model would write them. */
const VALUES: Readonly<Record<string, readonly string[]>> = {
  time: ['22:00', 'night', '06:30'], rain: ['on', 'off'], light: ['haze 1.5', 'exposure 0.8', 'sun 2', 'fill 0.5'], quality: ['auto', 'lite', 'minimal', 'ultra'],
  cars: ['park', 'drive'], crowd: ['50', '0', '100'], sound: ['on', 'off', '40'],
}

test('the First-Law table is exact: every catalogue verb, run over a recording facade with each of its values, reaches the leaves ACTION_LEAVES says and no other; every verb is kinetic-free', () => {
  assert.deepEqual(Object.keys(ACTION_LEAVES).sort(), [...VERBS].sort(), 'one row per verb')
  assert.deepEqual(Object.keys(VALUES).sort(), [...VERBS].sort())
  for (const verb of VERBS) {
    const reached = new Set<string>()
    for (const value of VALUES[verb]) {
      const { sim, calls } = recordingSim()
      const city: CityKnobs = { rain: () => { calls.push('city.rain') }, audio: () => { calls.push('city.audio') } }
      const p = parseAction(`ok\nACTION: ${verb} ${value}`)
      assert.equal(p.kind, 'proposed', `${verb} ${value}`)
      if (p.kind !== 'proposed') continue
      perform(p.action, scriptApi(sim), city)
      for (const c of calls) reached.add(c)
    }
    assert.deepEqual([...reached].sort(), [...ACTION_LEAVES[verb]].sort(), verb)
    assert.deepEqual(kineticLeaves(verb), [], verb)
  }
})

test('every leaf of the facade and both city knobs is classified kinetic or kinetic-free, never both; no verb reaches a kinetic leaf', () => {
  const all = [...leavesOf(recordingSim().sim), 'city.rain', 'city.audio'].sort()
  assert.deepEqual([...KINETIC, ...KINETIC_FREE].sort(), all)
  assert.equal(new Set([...KINETIC, ...KINETIC_FREE]).size, all.length, 'disjoint')
  for (const leaf of KINETIC) for (const verb of VERBS) assert.ok(!ACTION_LEAVES[verb].includes(leaf), `${verb} reaches ${leaf}`)
  assert.deepEqual(kineticLeaves('(not a verb)'), ['(not in the First-Law table)'])
  assert.ok(Object.isFrozen(kineticLeaves('(not a verb)')))
})

// ---------------------------------------------------------------- the one road, read at the source

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    // A `nix build` run inside src/ leaves its result link here (tools/license/headers.mjs nixLeftover): not source.
    if (name === 'result' || name.startsWith('result-') || name === '.direnv') continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

/** The code of a source file without its comments (a line comment starts at // not preceded by a colon, as in URLs). */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every runtime (non-test) source under src/, as [relative path, code without comments]. */
const runtimeSources = (): [string, string][] =>
  [...files(SRC)]
    .filter((f) => f !== SELF && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))
    .map((f) => [relative(SRC, f).replaceAll('\\', '/'), code(readHeld(f, 'utf8'))])

const specifiers = (text: string): string[] =>
  [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3])

const sources = runtimeSources()
const having = (re: RegExp): string[] => sources.filter(([, text]) => re.test(text)).map(([file]) => file).sort()
const source = (file: string): string => sources.find(([f]) => f === file)?.[1] ?? assert.fail(`${file} is not a runtime source`)

test('a model is answered through Mind.answer in the providers, their wrappers, the operator tier and the onboarding voice, and nowhere else', () => {
  // Every `.answer(` in the runtime, whatever its argument: the Mind contract in the providers, their wrappers, the
  // operator tier and the onboarding voice, and the concierge's `whys.answer(text)`, which is the person's own answer
  // to a question (Concierge.tsx, no model). A new call anywhere fails this pin until it is placed on the road.
  assert.deepEqual(having(/\.answer\s*\(/), [
    '07_Execute_Actions/Concierge.tsx', '07_Execute_Actions/onboarding/voice.ts', '07_Execute_Actions/operator.ts', '09_Cognition/cloudFallback.ts', '09_Cognition/router.ts', '09_Cognition/scripted.ts', 'App.tsx',
  ])
  assert.doesNotMatch(source('07_Execute_Actions/Concierge.tsx'), /\bMind\b|\.answer\s*\(\s*(?:req\b|\{)/, 'the concierge asks no model')
  // The two that reach a model's own API are named for the router and the in-page runtime only.
  assert.deepEqual(having(/\bclaudeAnswer\b/), ['09_Cognition/claudeApi.ts', '09_Cognition/router.ts'])
  assert.deepEqual(having(/\bcreateChatCompletion\b/), ['09_Cognition/wllamaRuntime.ts'])
})

test('the operator tier: every ask passes admitAsk before the gateway and the model; the one answer call is behind the 14A screen; the keeper is built with the vouch', () => {
  const op = source('07_Execute_Actions/operator.ts')
  const askThrough = op.slice(op.indexOf('const askThrough = ('), op.indexOf('const orchestrator = createSwarm('))
  assert.ok(askThrough.length > 0, 'askThrough precedes the swarm')
  const admit = askThrough.indexOf('admitAsk({ contained: contained(), endpoint: endpoint(), unlocked })')
  const gated = askThrough.indexOf('gatedAsk(')
  assert.ok(admit > 0 && gated > admit, 'the gate is asked before the ask is gated')
  assert.match(askThrough, /if \(!admitted\.admitted\) throw new Error\(`ask: \$\{lawSentence\(admitted\)\}`\)/)
  assert.equal((op.match(/\.answer\(\s*(?:req\b|\{)/g) ?? []).length, 1, 'one answer call in the tier')
  assert.match(op, /gate\.submit\(skills, \(lease\) => screen\(prompt\)\.admissible \? mind\.answer\(/, 'the model is asked under the lease, and only for an admissible prompt')
  assert.deepEqual(having(/\bcreateActs\b/), ['07_Execute_Actions/acts.ts', '07_Execute_Actions/operator.ts'])
  assert.match(op, /createActs\(\{[^}]*\bcontained,/, 'the keeper is handed the same vouch')
  assert.deepEqual(having(/\boperatorBridge\b/), ['07_Execute_Actions/engine.ts', '07_Execute_Actions/operator.ts'])
  assert.match(source('07_Execute_Actions/engine.ts'), /operatorBridge\([^\n]*contained: \(\) => airgapInstalled\(globalThis\)/, 'the engine vouches for the air gap main.tsx installed')
})

test('the keeper: perform is called once in the runtime, inside the lease\'s use, on an admitted admitRun verdict; the onboarding voice screens a rewording with admitWords', () => {
  // The bare identifier, however it is called or passed: defined in actions.ts, named in acts.ts (its import and one call) and nowhere else.
  assert.deepEqual(having(/\bperform\b/), ['06_Make_Decisions/actions.ts', '07_Execute_Actions/acts.ts'], 'the catalogue is performed in one place')
  const acts = source('07_Execute_Actions/acts.ts')
  assert.equal((acts.match(/\bperform\b/g) ?? []).length, 2, 'the import and the one call')
  assert.match(acts, /lease\.use\(\(\)[^\n]*=> \{\n\s*const facade = deps\.facade\(lease\)\n\s*const verdict = admitRun\(\{[\s\S]{0,400}?\}\)\n\s*return verdict\.admitted \? \{ ok: true, line: perform\(w\.action, facade, deps\.city\) \} : \{ ok: false, verdict \}\n\s*\}\)/)
  assert.match(acts, /const pre = admitProposal\(\{ contained: deps\.contained\(\), line, catalogued: p\.kind === 'refused' \? \{ reason: p\.reason \} : true, unlocked: deps\.unlocked\(\), vacant: pending === null \}\)\n\s*if \(p\.kind === 'refused' \|\| !pre\.admitted\) \{/, 'every ACTION line, readable or not, passes the gate')
  const voice = source('07_Execute_Actions/onboarding/voice.ts')
  assert.match(voice, /!admitWords\(said\)\.admitted\) return line/)
  // The gate is imported by the three that stand on the road, and by nothing else at runtime.
  assert.deepEqual(having(/from '[./]*02_Define_The_Rules\/ring0Gate\.ts'|from '\.\/ring0Gate\.ts'/), ['07_Execute_Actions/acts.ts', '07_Execute_Actions/onboarding/voice.ts', '07_Execute_Actions/operator.ts'])
})

test('the console names the law the way the gate does', () => {
  // The law names the kernel prints and the gate's refusals share one table.
  for (const c of CHECKS) assert.match(sentence({ admitted: false, law: c.law, failed: [{ law: c.law, check: c.name, reason: 'x' }] }), new RegExp(`^${LAW_NAMES[c.law]}: x$`))
})
