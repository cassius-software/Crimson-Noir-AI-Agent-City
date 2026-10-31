// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the evidence that Sloane's voice, the player's agents and the avatar's eye are wired
 * through the page: one speaker built by App and shared by the onboarding and the city, the card saying each line it
 * shows, the console's `agent`, `sloane` and `goal` reaching their bridges, a hired agent's identity reaching their
 * prompts, and the player's own look setting the first-person eye. Source-level, as the other wiring tests are: the
 * components need a browser to render.
 * What breaks if it is removed? A prop or a bridge could be dropped and Sloane would be silent, the roster unreachable
 * from the console, or the eye stuck at the reference height, with every unit test still green.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')

test('App: one speaker for the onboarding and the city, its sound and provider filled in once the engine is up and reset when it goes', () => {
  const src = read('../../App.tsx')
  assert.equal((src.match(/new ConciergeSpeaker\(/g) ?? []).length, 1, 'built once')
  assert.match(src, /<Onboarding [^>]*speaker=\{speaker\}/)
  assert.match(src, /<GuiShell [^>]*speaker=\{speaker\} link=\{link\}/)
  assert.match(src, /link\.sound = \(\) => e\.audio\.status\(\)\.state === 'running'/, 'silent while the city\'s sound is off, suspended or locked')
  assert.match(src, /link\.source = \{ voice, out: e\.conciergeOut\(\) \}/)
  assert.match(src, /speaker\.stop\(\)\s*link\.source = null/, 'a city that goes takes its voice with it')
  assert.match(src, /onSay=\{onSay\}/)
})

test('App: the console\'s agent, sloane and goal each reach their own bridge; a hired agent\'s identity and provider voice reach the engine', () => {
  const src = read('../../App.tsx')
  assert.match(src, /agent: agentBridge\(roster, \{/)
  assert.match(src, /concierge: conciergeBridge\(speaker\)/)
  assert.match(src, /goal: \(text: string\) => goalPlan\(text, engineBridge\)/)
  assert.match(src, /e\.terminalBridge\(gate, mind, voice, memory\.diary\(\), voiceOf, pageStore\(ELITE_KEY\)\)/)
  assert.match(src, /engine\?\.setIdentities\(/)
  assert.match(src, /r\.onMirror\(\(list\) => \{ for \(const agent of roster\.keepOnly\(list\.map\(\(v\) => v\.agent\)\)\) e\.setLook\(agent, null\) \}\)/, 'a hire ends when they leave')
  assert.match(src, /unfollow = \(\) => \{ unfollowMemory\(\); unmirror\(\); roster\.keepOnly\(\[\]\) \}/, 'and with the city')
  assert.match(src, /voiceProfile\(v\) === null \? v : null/, 'a profile name is the browser tier\'s, never sent to a provider')
  assert.match(src, /agents=\{agents\}\s*roster=\{roster\}\s*onAgentLook=\{wearAgentLook\}/)
  assert.match(src, /onAgentLook=\{wearAgentLook\}\s*onHear=\{onHear\}/)
  assert.match(src, /void speaker\.preview\(line, voice\)/, 'the card\'s Hear button goes through the one speaker')
  // The goal goes through the same three knobs the Concierge uses, never the engine.
  const start = src.indexOf('function goalPlan(')
  const plan = src.slice(start, src.indexOf('\n}\n', start))
  assert.doesNotMatch(plan, /engine|\.sim\b/)
})

test('the card and the onboarding: each line said once as plain words, never before the visitor chose sound on, stopped when the onboarding goes', () => {
  const card = read('../Concierge.tsx')
  assert.match(card, /onSay\?\(text: string\): void/)
  assert.match(card, /const spokenKey = view === 'nudge' && nudge \? `nudge:\$\{nudge\.id\}` : spoken/, 'a reworded nudge is not said twice')
  assert.match(card, /if \(!visible \|\| spokenKey === saidRef\.current\) return/, 'hidden and shown again is not a new line')
  const onboarding = read('./Onboarding.tsx')
  assert.match(onboarding, /if \(answers\.audio !== true \|\| step === 'name' \|\| step === 'place' \|\| step === 'time' \|\| step === 'sound'\) return/)
  assert.match(onboarding, /useEffect\(\(\) => \(\) => speakerRef\.current\?\.stop\(\), \[\]\)/)
})

test('the engine: the player\'s look sets the eye, Sloane is heard at the player\'s head with no walls between, a hired agent\'s identity rides their context', () => {
  const src = read('../engine.ts')
  assert.match(src, /if \(agent === PLAYER_INDEX\) this\.rig\.setEyeHeight\(eyeHeightFor\(look === null \? 1 : heightScale\(look\)\)\)/)
  assert.match(src, /this\.audio\.speak\(buffer, eye\.x, eye\.z, 0, text, \{ agent: PLAYER_INDEX, label: CONCIERGE_LABEL \}\)/)
  assert.match(src, /sp\.walls = speaking && !this\.conciergeVoice/)
  assert.match(src, /if \(this\.conciergeVoice\) this\.listenFor\(this\.views\[k\], k, st, dt, pedestrian, undefined\)/, 'split screen: the other players still hear the pedestrian, where they are')
  const out = src.slice(src.indexOf('  conciergeOut(): ConciergeOut {'), src.indexOf('  speechOut(): SpeechOut {'))
  assert.doesNotMatch(out, /this\.speaker = /, 'Sloane leaves the pedestrian speaker as it was')
  assert.match(src, /identity: this\.identityOf\?\.\(agent\) \?\? null/)
  assert.match(src, /operatorBridge\(this\.simControls\(\), gate, mind, undefined, \{[^}]*voiceOf, vault \}\)/)
})

test('the Customizer edits the roster and the look only: it reaches no engine, bridge or renderer of its own', () => {
  const src = read('../Customizer.tsx')
  const imports = [...src.matchAll(/^import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1])
  for (const spec of imports) assert.doesNotMatch(spec, /engine|terminal|three|bridge/, `Customizer imports '${spec}'`)
})
