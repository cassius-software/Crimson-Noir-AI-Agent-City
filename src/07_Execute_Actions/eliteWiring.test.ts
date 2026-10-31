// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins what the elite tier can and cannot reach, structurally: its write surface calls
 * four things and nothing else (the tuning facade `set` uses, a scripted intent, the crowd's density, the feature
 * inspector), every one through the operator's frozen facade, which by type has no door to the laws, the Bouncer, the
 * Sanctuary, the Ring-0 auditor or the kernel's blinding; the passphrase leaves the tier only as a salted hash; the
 * host hands the record's keeping through the engine; and the console refuses unlock and set before the tier is asked.
 * What breaks if it is removed? A later change could give the elite tier a fifth write, or a door to the laws, and only
 * a reader of the diff would notice.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}

test('the elite tier writes through four facade calls and nothing else, and reaches nothing of the laws', () => {
  const op = read('./operator.ts')
  const elite = between(op, '  let elite = false', '  return Object.freeze({\n    unlock:')
  assert.ok(elite.length > 500)
  // The code alone: the comments name what is out of reach, the code must not.
  const code = elite.replace(/^\s*\/\/.*$/gm, '')
  // The four writes, each gated on the tier being open.
  assert.equal(elite.match(/requireElite\(\)/g)?.length, 4, 'tune, intent, cull, steer each require the tier open')
  assert.match(elite, /setKnob\(table, m \? m\[2\] : key, value\)/)
  assert.match(elite, /api\.vehicles\.intent\(car, throttle, brake, steer\)/)
  assert.match(elite, /api\.crowd\.cull\(\{ density \}\)/)
  assert.match(elite, /features\.steer\(feature, value\)/)
  // Every reach into the city goes through `api` (the frozen ScriptApi) or the inspector: no `sim.`, no engine, no kernel.
  assert.deepEqual([...new Set(code.match(/\bapi\.[a-z]+\.[a-z]+/gi) ?? [])].sort(), ['api.crowd.cull', 'api.vehicles.intent'])
  assert.doesNotMatch(code, /\bsim\.|laws|bouncer|sanctuary|blindSensing|kernel|ring0\.ts|setMode|recover|teleport|governor|gatedExec|gate\.submit/i)
  // The facade the writes go through has, by type, no kernel door but its readouts.
  assert.match(op, /^export type ScriptApi = Omit<SimControls, 'kernel'> & \{ kernel: \{ stats\(\): KernelStats \} \}$/m)
  // The passphrase leaves the tier only as a salted SHA-256 record; nothing else is ever saved.
  assert.equal(op.match(/vault\.save\(/g)?.length, 1)
  assert.match(elite, /vault\.save\(`v1:\$\{salt\}:\$\{digest\(salt, words\)\}`\)/)
  assert.match(elite, /const digest = \(salt: string, passphrase: string\): string => sha256\(`\$\{salt\}:\$\{passphrase\}`\)/)
  assert.doesNotMatch(elite, /diary|awareness|remember|note\(/, 'the passphrase is never noted anywhere')
  // The operator's lock closes the elite tier and forgets the wrong-passphrase count.
  const lock = between(op, '    lock: () => {\n      unlocked = false', '    },')
  assert.match(lock, /elite = false/)
  assert.match(lock, /wrongPassphrases = 0/)
  // The banner names what stays in force.
  const banner = between(op, 'export const ELITE_BANNER', '])')
  for (const word of ['three laws', 'Bouncer', 'Sanctuary', 'Ring-0 auditor', '14A screen']) assert.ok(banner.includes(word), word)
})

test('the host keeps the record through the engine; the console refuses unlock and set before the tier is asked; the history keeps no passphrase', () => {
  const app = read('../App.tsx')
  assert.match(app, /^const ELITE_KEY = 'civic-simulation:elite:v1'$/m)
  assert.match(app, /e\.terminalBridge\(gate, mind, voice, memory\.diary\(\), voiceOf, pageStore\(ELITE_KEY\)\)/)
  const engine = read('./engine.ts')
  assert.match(engine, /terminalBridge\(gate: SkillGate, givenMind: Mind, voice\?: Voice, diary\?: Diary, voiceOf\?: \(agent: number\) => string \| null, vault\?: EliteVault\): TerminalBridge \{/)
  assert.match(engine, /operatorBridge\(this\.simControls\(\), gate, mind, undefined, \{ [^}]*voiceOf, vault \}\)/)
  const commands = read('./terminal/commands.ts')
  const handler = between(commands, '  ring0(args, b) {', '  // Raw: args[0] is the rest of the line')
  assert.equal(handler.match(/if \(!op\.unlocked\(\)\) return locked\('ring0'\)/g)?.length, 2, 'unlock and set refused before the tier')
  // The passphrase (unlock[2], set[1]) reaches only the tier's own calls: never a printed line, never a string.
  assert.deepEqual([...new Set(handler.match(/out\(op\.elite\.(status|lock|set)\(/g) ?? [])].sort(), ['out(op.elite.lock(', 'out(op.elite.set(', 'out(op.elite.status('])
  assert.doesNotMatch(handler, /out\(\s*(rest|unlock\[2\]|set\[1\])|\$\{(rest|unlock\[2\]|set\[1\])/, 'the passphrase is never printed')
  assert.match(commands, /\.replace\(\/\^\(\\s\*ring0\\s\+unlock\\s\+--elite\\s\+\)\\S\[\\s\\S\]\*\$\/, '\$1••••'\)/)
  assert.match(commands, /\.replace\(\/\^\(\\s\*ring0\\s\+elite\\s\+set\\s\+\)\\S\[\\s\\S\]\*\$\/, '\$1••••'\)/)
  // The bridge's surface is six members, the offline stand-in refuses each.
  const bridge = read('./terminal/bridge.ts')
  assert.match(bridge, /^export interface EliteBridge \{$/m)
  assert.match(bridge, /^ {6}elite: \{ status: down, unlocked: down, unlock: down, lock: down, set: down, writes: down \},$/m)
})
