// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins how Sloane's dispatch is wired into the page: the dead end is gone from every
 * runtime source (no goal is answered with "not something I can do yet"); App builds the team runner over what the page
 * already has (the bridge's one reader of the columns, the air gap's vouch, the realm's standing, this map's
 * workplaces, the recruiter), ticks it from the frame loop on its own interval, hands its lanes to the HUD's snapshot
 * and the Concierge, and puts the same runner behind the console's `lanes` and `goal`; the Concierge rewords a brief's
 * sentence through a Voice and never a Mind; and Sloane's voice (onboarding/voice.ts sloaneVoice) keeps every number,
 * stands on the planner's sentence on any failure or timeout, and never decides anything.
 * What breaks if it is removed? The dead end could come back, a team could be opened outside the one runner, the
 * Concierge could reach a model directly, or a rewording could drop the count of sub-agents it describes.
 */
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import type { Mind } from './operator.ts'
import { SLOANE_REWORD_MS, keepNumbers, sloanePrompt, sloaneVoice } from './onboarding/voice.ts'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const read = (rel: string): string => readFileSync(join(SRC, rel), 'utf8')

/** Every runtime source under src/ (no tests), as [path, text]. */
function sources(dir = SRC, acc: [string, string][] = []): [string, string][] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) { sources(full, acc); continue }
    if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue
    acc.push([full.slice(SRC.length), readFileSync(full, 'utf8')])
  }
  return acc
}

test('the dead end is gone: no runtime source answers a goal with "not something I can do yet", and the intent engine has no unmapped probe', () => {
  const guilty = sources().filter(([, text]) => /not something I can do yet|nothing in the city maps to that yet, so/i.test(text)).map(([f]) => f)
  assert.deepEqual(guilty, [])
  const intent = read('06_Make_Decisions/intent.ts')
  assert.doesNotMatch(intent, /kind: 'unmapped'/, 'the redirect probe that ended a goal is gone')
  assert.match(intent, /control: 'dispatch'/)
  assert.match(intent, /teamOf\(work, input\)/)
})

test('App: the team runner over the page\'s own parts, ticked from the frame loop, behind the HUD, the Concierge and the console', () => {
  const src = read('App.tsx')
  assert.equal((src.match(/new TeamRunner\(/g) ?? []).length, 1, 'one runner')
  assert.match(src, /tables: \(\) => engineBridge\.soa\?\.tables\(\) \?\? null/, 'the bridge\'s one reader of the columns')
  assert.match(src, /contained: \(\) => airgapInstalled\(globalThis\)/, 'the air gap vouches, or the gate fails closed')
  assert.match(src, /panic: \(\) => e\.panicReason/)
  assert.match(src, /rooms: \(\) => e\.teamRooms/)
  assert.match(src, /centre: \(\) => e\.teamCentre/, 'a desk this map has no room for reads around where the player started')
  assert.match(src, /recruit: \(skill\) => r\.recruit\(skill\)/, 'the same ask recruit makes')
  assert.match(src, /rally: \(agent, x, z\) => r\.rally\(agent, x, z\)/)
  assert.match(src, /log: \(line\) => \{ console\.error\(line\); e\.toast\('Lane isolated', line\) \}/)
  assert.match(src, /if \(crew && now - lastTeam >= TEAM_TICK_MS\) \{ lastTeam = now; crew\.tick\(\) \}/, 'on its own interval, never per frame')
  assert.match(src, /if \(crew\) \{ s\.supplier\.lanes = crew\.lines\(\); s\.supplier\.team = crew\.line\(\) \}\n\s*if \(recruiter\) s\.supplier\.recruiting = hudLine\(/, 'the snapshot carries the lanes and the one line; the pinned activity line stays byte-identical')
  const hud = read('07_Execute_Actions/Hud.tsx')
  assert.match(hud, /const team = s\.supplier\.team \?\? ''/)
  assert.match(hud, /\[dotted \? 'MIC · on-device' : '', rcLine, team\]\.filter\(Boolean\)\.join\(' · '\)/, 'the MIC chip reads the team line after the activity line (the MIC dot only without the host\'s microphone pill)')
  assert.match(src, /const lanes = team\.console\(\)/)
  assert.match(src, /goal: \(text: string\) => goalPlan\(text, \{ \.\.\.engineBridge, lanes \}\),\n\s*lanes,/, 'the console\'s goal and lanes share the one runner')
  assert.match(src, /if \(step\.control === 'dispatch' && step\.team && b\.lanes\) \{ b\.lanes\.dispatch\(step\.team\); return true \}/, 'the card dispatches through the bridge')
  assert.match(src, /else if \(step\.control === 'dispatch' && step\.team && b\.lanes\) \{\n\s*const d = b\.lanes\.dispatch\(step\.team\)/, 'and so does goal')
  assert.match(src, /crew\?\.dispose\(\)/)
  assert.match(src, /setSloane\(sloaneVoice\(mind, SLOANE_REWORD_MS, \(\) => local\.settings\(\)\.provider !== 'scripted' && !pageCold\(\)\)\)/, 'Sloane\'s words through the router\'s order, never with the scripted provider or a model file still to be loaded, asked at every sentence')
  assert.match(src, /reword=\{sloane\}\s*lanes=\{hud\.supplier\.lanes \?\? null\}/)
  // The runner is never given the engine itself, the simulation or a mind.
  const start = src.indexOf('new TeamRunner(')
  const block = src.slice(start, src.indexOf('})', start))
  assert.doesNotMatch(block, /\bmind\b|\.sim\b|engine\b/)
})

test('the Concierge rewords through a Voice and shows the team: no Mind, no .answer( of a model, the planner\'s sentence until the words arrive', () => {
  const card = read('07_Execute_Actions/Concierge.tsx')
  assert.match(card, /import type \{ Chat, ChatTurn, Voice \} from '\.\/onboarding\/voice\.ts'/)
  assert.doesNotMatch(card, /\bMind\b/)
  assert.equal((card.match(/\.answer\(/g) ?? []).length, 2, 'whys.answer(text) and resume\'s whys.answer(a): the person\'s own answers, no model')
  assert.match(card, /reword\.say\(root, ctl\.signal\)\.then\(\(text\) => \{ if \(!ctl\.signal\.aborted && text && text !== root\) setWorded\(\{ brief: b, text \}\) \}, \(\) => \{\}\)/)
  assert.match(card, /return \(\) => ctl\.abort\(\)/, 'a new brief or a card that goes ends the ask')
  assert.match(card, /worded\?\.brief === brief \? worded\.text : brief\.root/, 'the words belong to one brief (the brief itself, not its sentence: a later brief with the same root starts from the planner\'s words)')
  assert.match(card, /data-team aria-label="The team at work"/)
  assert.match(card, /lanes\.slice\(0, TEAM_ROWS\)/)
  // What is spoken stays the planner's sentence (spokenLine reads brief.root, never the rewording).
  assert.match(card, /case 'goal': return dialogue\.step \? dialogue\.step\.question : dialogue\.brief \? dialogue\.brief\.root/)
})

test('the engine hands the team runner its rooms with their door fronts on this map\'s lane, and the realm\'s standing; the runner imports no engine, renderer or React', () => {
  const engine = read('07_Execute_Actions/engine.ts')
  assert.match(engine, /get teamRooms\(\): readonly \{ kind: string; name: string; door: \{ x: number; z: number \} \}\[\]/)
  assert.match(engine, /get teamCentre\(\): \{ readonly x: number; readonly z: number \} \{ return this\.startAt \}/)
  assert.match(engine, /places, landmark, streets, start: spawn,/)
  assert.match(engine, /door: doorFront\(r, this\.streets\?\.lane \?\? CITY\.lane\)/)
  assert.match(engine, /get panicReason\(\): string \| null \{ return this\.sim\.state\.kernel\.audit\.panic \?\? this\.lockReason \}/)
  const team = read('08_Swarm/team.ts')
  const imports = [...team.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]!)
  for (const spec of imports) assert.doesNotMatch(spec, /engine|three|react|cognition|09_/, `team.ts imports '${spec}'`)
  assert.doesNotMatch(team, /\bfetch\b|\beval\b|new Function|setTimeout|setInterval/, 'the runner has no clock and no door of its own')
})

/** A mind that answers with the given text, in pieces, or fails as told. */
function mindOf(say: string | Error | 'hang'): Mind & { prompts: string[] } {
  const prompts: string[] = []
  const m = {
    prompts,
    answer: (req: { prompt: string; signal: AbortSignal }, onPiece: (p: { kind: 'text'; text: string }) => void) => {
      prompts.push(req.prompt)
      if (say instanceof Error) return Promise.reject(say)
      if (say === 'hang') return new Promise<void>((_, reject) => { req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true }) })
      for (const piece of say.split(' ')) onPiece({ kind: 'text', text: `${piece} ` })
      return Promise.resolve()
    },
  }
  return m as unknown as Mind & { prompts: string[] }
}

test('sloaneVoice: Sloane\'s own words for a brief, every number kept, the planner\'s sentence on a dropped number, a long answer, a refusal, a failure or a timeout', async () => {
  const root = 'You want the city to work on it: 24 sub-agents across metro operations, the warehouse and the robotics lab.'
  const live = new AbortController()
  // Reworded, the numbers kept: Sloane's words show.
  const warm = mindOf('Lovely. I am sending 24 of my people to metro operations, the warehouse and the robotics lab for you.')
  assert.equal(await sloaneVoice(warm).say(root, live.signal), 'Lovely. I am sending 24 of my people to metro operations, the warehouse and the robotics lab for you.')
  assert.equal(warm.prompts.length, 1)
  assert.equal(warm.prompts[0], sloanePrompt(root))
  assert.match(warm.prompts[0]!, /You are Sloane, the concierge/)
  assert.match(warm.prompts[0]!, /Keep every number and every place name exactly/)
  assert.ok(warm.prompts[0]!.endsWith(`\n\n${root}`))
  // A rewording that drops the count is not Sloane's: the planner's sentence stands.
  assert.equal(await sloaneVoice(mindOf('I am sending a few people over to help with that.')).say(root, live.signal), root)
  assert.deepEqual(keepNumbers(root), ['24'])
  assert.deepEqual(keepNumbers('Nothing maps to that directly, so 2 scouts are on it: they read the city and report.'), ['2'])
  assert.deepEqual(keepNumbers('You want the city at night.'), [])
  // Too long, a word the gate refuses, an empty answer, a failure, a hang past the timeout: the planner's sentence every time.
  assert.equal(await sloaneVoice(mindOf(`24 ${'very '.repeat(60)}long`)).say(root, live.signal), root)
  assert.equal(await sloaneVoice(mindOf('24 people are on it, and a bowl of punch for everyone')).say(root, live.signal), root, 'the conduct screen is blunt, and it stands')
  assert.equal(await sloaneVoice(mindOf('')).say(root, live.signal), root)
  assert.equal(await sloaneVoice(mindOf(new Error('no model'))).say(root, live.signal), root)
  assert.equal(await sloaneVoice(mindOf('hang'), 20).say(root, live.signal), root)
  assert.equal(SLOANE_REWORD_MS, 4000)
  // An aborted ask (a new brief, a card that went) answers the planner's sentence at once.
  const gone = new AbortController()
  gone.abort()
  const idle = mindOf('24 anything')
  assert.equal(await sloaneVoice(idle).say(root, gone.signal), root)
  assert.equal(idle.prompts.length, 0, 'nothing asked after the card went')
})
