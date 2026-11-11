// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the wiring of the player's own agents posted at their homes' workstations to its
 * boundaries, which Node cannot run as the page does, so it reads the source as the other wiring tests do. The engine
 * draws the posts (staffView.ts) and lists the workstations (homeSeats) after the homes' own draw, and tells the realm
 * nothing; it never reaches the store, the roster, the team runner, the dispatcher or the recruiter. App keeps the
 * posts in this browser, hands the engine only names on the roster, and posts or stands down only where the engine
 * allows furnishing; nobody is moved (no rally, no tether, no recruiter, no operator). The dispatcher, the team runner
 * and the lanes know nothing of it.
 * What breaks if it is removed? A post could reach the physics realm or the crowd, a stored name the roster never
 * screened could reach the engine, or staffing could start moving the hired pedestrian around, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const flat = (s: string) => s.replace(/\s+/g, ' ')
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}
const between = (src: string, from: string, to: string) => {
  const a = src.indexOf(from)
  assert.ok(a >= 0, `missing ${from}`)
  const b = src.indexOf(to, a + from.length)
  assert.ok(b > a, `missing ${to} after ${from}`)
  return src.slice(a, b)
}
/** What a module imports: every `from '...'` it names, a multi-line import list included. */
const importsOf = (src: string): string[] => [...src.matchAll(/^import\b[^;]*?from '([^']+)'/gm)].map((m) => m[1])

test('the engine draws the posts and lists the workstations after the homes\' own draw, and tells the realm nothing', () => {
  const raw = read('./engine.ts')
  const src = flat(raw)
  const set = between(src, ' setStaff(posts: readonly StaffPost[]): void {', ' blockedCells(')
  assert.ok(set.includes('this.homeStaff = Object.freeze(posts.slice(0, STAFF_VIEW.max))'), 'at most one figure per roster agent')
  assert.ok(set.includes('this.redrawHomes()'))
  assert.doesNotMatch(set, /sim\.send|sendHomes|netClient/, 'nothing is sent')
  const draw = between(src, ' private redrawHomes(): void {', ' private sendHomes(')
  const homes = 'this.world.setHomes(homeInstances(this.homes, this.homeRecord, this.homeDeeds, this.homeLines, { room: this.netRoom, base: this.homeBase, draft }))'
  const seats = 'this.seats = homeSeats(this.homes, this.homeRecord, this.homeDeeds, this.homeLines, this.homeStaff, { room: this.netRoom, base: this.homeBase })'
  before(draw, homes, seats, 'the homes first, as they were')
  before(draw, seats, 'this.staffView.set(staffFigures(this.seats, this.homeStaff))', 'then the figures at the seats just listed')
  assert.ok(between(src, ' private constructor(p: {', ' static async create(').includes('p.world.scene.add(this.staffView.group)'))
  assert.ok(between(src, ' dispose(): void {', ' this.input.dispose()').includes('this.staffView.dispose()'))
  const getter = between(src, ' get homeSeats(): readonly HomeSeat[] {', ' get panicReason()')
  assert.ok(getter.includes('return this.halted || this.disposed ? Object.freeze([]) : this.seats'), 'none once the city has stopped')
  // The new getter sits beside the team runner's, which stay as they were (teamWiring.test.ts pins them).
  before(src, ' get teamCentre(): ', ' get homeSeats(): ', 'after the team runner\'s rooms and centre')
  const imports = importsOf(raw)
  for (const never of ['staffStore.ts', 'roster.ts', '/team.ts', 'dispatch.ts', 'recruitment.ts']) {
    assert.ok(!imports.some((m) => m.endsWith(never)), `engine.ts never imports ${never}`)
  }
  assert.ok(imports.includes('./staffView.ts'))
})

test('App keeps the posts in this browser, hands the engine only names on the roster, and posts or stands down only where the engine allows furnishing; nobody is moved', () => {
  const app = flat(read('../App.tsx'))
  assert.ok(app.includes("import { loadStaff, postOf, postTo, saveStaff, standDownAt, type StaffRecord } from './05_Observe_Environment/staffStore.ts'"))
  assert.ok(app.includes('const [posts, setPosts] = useState<StaffRecord>(loadStaff)'), 'read once at mount')
  assert.ok(app.includes('const commitStaff = useCallback((next: StaffRecord): null => { postsRef.current = next; setPosts(next); saveStaff(next); return null }, [])'), 'every change saved at once')
  const effect = between(app, 'engine?.setStaff(posts.flatMap((p) => {', '}, [engine, posts, agents, roster])')
  assert.ok(effect.includes('const id = roster.get(p.name) if (!id) return []'), 'only names on the roster reach the engine')
  assert.ok(effect.includes('const look = id.look ?? lookFromSeed(seedFromName(id.name))'), 'in their look, their seed\'s while they have none')
  assert.ok(effect.includes('present: id.agent === null'), 'away while hired')
  const hooks = between(app, ' const furnishHooks = useMemo((): FurnishHooks | null => (engine ? {', '} : null), [engine, keeper])')
  const staff = between(hooks, 'staff: {', ' }, ')
  assert.ok(staff.includes('post: (home: number, c: number, r: number, name: string) => engine.furnishRefusal(home) ?? commitStaff(postTo('))
  assert.ok(staff.includes('standDown: (home: number, c: number, r: number) => engine.furnishRefusal(home) ?? commitStaff(standDownAt('))
  assert.doesNotMatch(staff, /rally|dismiss|recruit|roster\.(?:set|add|remove|bind)|operator|tether/, 'nobody is moved')
})

test('the dispatcher, the team runner and the lanes know nothing of staffing', () => {
  for (const rel of ['../06_Make_Decisions/dispatch.ts', '../08_Swarm/team.ts', '../08_Swarm/lanes.ts']) {
    assert.doesNotMatch(read(rel), /homeSeat|staffStore|staffView|setStaff/, `${rel} is untouched`)
  }
  assert.ok(!importsOf(read('../08_Swarm/team.ts')).some((m) => m.endsWith('ring0Gate.ts')), 'team.ts never imports the gate')
})
