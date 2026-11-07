// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the team runner: what happens once Sloane's planner (06_Make_Decisions/dispatch.ts)
 * has a team for a goal. It opens one lane a sub-agent in the lane runner (lanes.ts), each lane's probe placed at its
 * desk's door front (the host's rooms, 01_Initialize_World/interiors.ts doorFront), and steps them a tick at a time against the city's
 * columns; every tick and every effect goes through the Ring-0 gate inside the runner, so a lane that overruns or
 * reaches is isolated there and this file only reports it. Bodies are opportunistic and honest: for each desk the team
 * names, one person within earshot with the desk's skill is asked over through the host's recruiter (the same ask
 * `recruit <skill>` makes, after `ask` on the lane's word for the move), and once they have arrived, if the player is
 * standing within rally range of that desk's door, they are sent to it; the tether (03_Spawn_Agents/skills.ts
 * RELEASE_DISTANCE, the Third Law's) is never loosened, so a desk across the city is reported as that many metres
 * away, not walked to. Everything the HUD, the Concierge and the console show of a team is read here: the lane lines,
 * the one-line summary, the status table, the fault ledger. Nothing here throws: a host that fails is a note.
 * What breaks if it is removed? A dispatch step is a label on the card and nothing runs: no lanes, no readings, no
 * one asked over, and the console's `lanes` has nothing to show.
 */
import { CAP_MOVE, capNames } from '../02_Define_The_Rules/capabilities.ts'
import { RALLY_RANGE } from '../03_Spawn_Agents/skills.ts'
import { deskOf, laneSpec, teamLabel, type DeskId, type Team } from '../06_Make_Decisions/dispatch.ts'
import type { NoirTables } from '../07_Execute_Actions/terminal/noirscript/index.ts'
import { LaneRunner, type LaneView } from './lanes.ts'

/** How often the host steps a team: four ticks a second is a reading a lane every quarter second, far under its gas. */
export const TEAM_TICK_MS = 250
/** Notes kept of what came of the bodies (the newest last). */
export const NOTES_MAX = 8

/** A workplace as the runner needs it: its kind (as the map names it), its name, and its door front on the sidewalk. */
export interface TeamRoom { readonly kind: string; readonly name: string; readonly door: { readonly x: number; readonly z: number } }

/** What the runner reads of its host, all of it already in the page: the columns, the vouch, the realm, the rooms, the people. */
export interface TeamHost {
  /** The city's columns now (terminal/bridge.ts SoaBridge), or null for the empty city. */
  tables(): NoirTables | null
  /** Whether the air gap is installed (airgap.ts airgapInstalled); null fails closed (the gate's Vouched). */
  contained(): boolean | null
  /** The Ring-0 audit's panic reason, or null while the realm stands. */
  panic(): string | null
  /** The indoor workplaces of this map (none in a surveyed region). */
  rooms(): readonly TeamRoom[]
  /** Where the player stands on foot, or null (driving, halted). */
  operator(): { x: number; z: number } | null
  /** The recruiter's list: who was asked over, and who has arrived. */
  recruits(): readonly { readonly agent: number; readonly arrived: boolean }[]
  /** Asks the nearest person within earshot with the skill over (08_Swarm/recruitment.ts recruit). */
  recruit(skill: string): Promise<{ readonly ok: boolean; readonly agent: number; readonly message: string }>
  /** Asks an arrived recruit to walk to a sidewalk point (recruitment.ts rally). */
  rally(agent: number, x: number, z: number): Promise<{ readonly ok: boolean; readonly message: string }>
  /** The lane panic's line (console.error unless given). */
  log?(line: string): void
}

/** A lane as the HUD's snapshot and the Concierge show it. */
export interface LaneLine { readonly tag: string; readonly role: string; readonly state: 'ready' | 'isolated'; readonly reading: string | null }

/** What a dispatch opened. */
export interface Dispatched { readonly lanes: number; readonly dropped: number; readonly label: string; readonly bodies: number }

/** The console's surface over a team (terminal/bridge.ts LanesBridge). */
export interface TeamConsole {
  status(): string[]
  ledger(verify: boolean): string[]
  stop(): string
  dispatch(team: Team): { lanes: number; dropped: number }
}

type BodyState = 'asked' | 'coming' | 'refused' | 'rallied'
interface Body { readonly kind: DeskId; readonly tag: string; readonly lane: number; readonly skill: string; agent: number; state: BodyState; note: string }

/** The room a desk is at on this map (either name of a first room), or null when the map has none. */
const roomFor = (rooms: readonly TeamRoom[], kind: DeskId): TeamRoom | null => {
  const kinds = deskOf(kind).kinds
  return rooms.find((r) => kinds.includes(r.kind)) ?? null
}

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const metres = (a: { x: number; z: number }, b: { x: number; z: number }): number => Math.hypot(a.x - b.x, a.z - b.z)

export class TeamRunner {
  readonly #host: TeamHost
  #team: Team | null = null
  #runner: LaneRunner | null = null
  #bodies: Body[] = []
  #notes: string[] = []
  /** Bumped by every dispatch and stop: a promise from an earlier team changes nothing. */
  #gen = 0

  constructor(host: TeamHost) {
    this.#host = host
  }

  get team(): Team | null { return this.#team }
  /** Ticks the current team has run. */
  get ticks(): number { return this.#runner?.tick ?? 0 }

  /**
   * Opens the team's lanes (replacing any team before it), each probe placed at its desk's door front, and asks one
   * person over for each desk whose first lane's word admits the move. Never throws.
   */
  dispatch(team: Team): Dispatched {
    this.#gen++
    const gen = this.#gen
    this.#notes = []
    const rooms = this.#rooms()
    const specs = team.lanes.map((l) => laneSpec(l, roomFor(rooms, l.kind)?.door ?? null))
    const runner = new LaneRunner(specs, {
      contained: () => this.#host.contained(),
      panic: () => this.#host.panic(),
      ...(this.#host.log ? { log: this.#host.log.bind(this.#host) } : {}),
    })
    this.#team = team
    this.#runner = runner
    this.#bodies = []
    for (const kind of team.kinds) {
      const lane = team.lanes.findIndex((l) => l.kind === kind)
      if (lane < 0 || lane >= runner.count) continue
      const desk = deskOf(kind)
      const body: Body = { kind, tag: team.lanes[lane]!.tag, lane, skill: desk.skill, agent: -1, state: 'asked', note: `asking someone with ${desk.skill} over` }
      this.#bodies.push(body)
      const asked = runner.ask(lane, CAP_MOVE)
      if (!asked.ok) {
        body.state = 'refused'
        body.note = asked.reason
        this.#note(`${body.tag}: ${asked.reason}`)
        continue
      }
      let outcome: Promise<{ readonly ok: boolean; readonly agent: number; readonly message: string }>
      try {
        outcome = this.#host.recruit(desk.skill)
      } catch (e) {
        body.state = 'refused'
        body.note = text(e)
        this.#note(`${body.tag}: ${body.note}`)
        continue
      }
      void Promise.resolve(outcome).then(
        (o) => {
          if (gen !== this.#gen) return
          body.agent = o.ok ? o.agent : -1
          body.state = o.ok ? 'coming' : 'refused'
          body.note = o.message
          this.#note(`${body.tag}: ${o.message}`)
        },
        (e: unknown) => {
          if (gen !== this.#gen) return
          body.state = 'refused'
          body.note = text(e)
          this.#note(`${body.tag}: ${body.note}`)
        },
      )
    }
    // Dropped: what the planner left beyond TEAM_MAX, plus anything the runner would (none: the two caps are pinned equal).
    return { lanes: runner.count, dropped: team.dropped + runner.dropped, label: teamLabel(team), bodies: this.#bodies.length }
  }

  /** One tick: every lane's probe against the columns now, then any arrived body sent to its desk when the player stands near it. Never throws. */
  tick(): void {
    const runner = this.#runner
    if (!runner) return
    let tables: NoirTables | null = null
    try {
      tables = this.#host.tables()
    } catch (e) {
      this.#note(`columns: ${text(e)}`)
    }
    runner.step(tables)
    const gen = this.#gen
    let arrived: readonly { readonly agent: number; readonly arrived: boolean }[] = []
    let at: { x: number; z: number } | null = null
    try {
      arrived = this.#host.recruits()
      at = this.#host.operator()
    } catch (e) {
      this.#note(`people: ${text(e)}`)
      return
    }
    if (at === null) return
    let rooms: readonly TeamRoom[] | null = null
    for (const body of this.#bodies) {
      if (body.state !== 'coming') continue
      if (!arrived.some((r) => r.agent === body.agent && r.arrived)) continue
      const room = roomFor((rooms ??= this.#rooms()), body.kind)
      if (!room) { body.note = `nowhere to send them: this map has no ${deskOf(body.kind).title.replace(/^the /, '')}`; continue }
      const door = room.door
      const away = metres(at, door)
      if (away > RALLY_RANGE) { body.note = `agent ${body.agent} is with you; the ${room.name} is ${Math.round(away)} m away (within ${RALLY_RANGE} m they are sent in)`; continue }
      const asked = runner.ask(body.lane, CAP_MOVE)
      if (!asked.ok) { body.state = 'refused'; body.note = asked.reason; this.#note(`${body.tag}: ${asked.reason}`); continue }
      body.state = 'rallied'
      body.note = `agent ${body.agent} sent to the ${room.name}`
      let outcome: Promise<{ readonly ok: boolean; readonly message: string }>
      try {
        outcome = this.#host.rally(body.agent, door.x, door.z)
      } catch (e) {
        body.note = text(e)
        this.#note(`${body.tag}: ${body.note}`)
        continue
      }
      void Promise.resolve(outcome).then(
        (o) => { if (gen === this.#gen) { body.note = o.message; this.#note(`${body.tag}: ${o.message}`) } },
        (e: unknown) => { if (gen === this.#gen) { body.note = text(e); this.#note(`${body.tag}: ${body.note}`) } },
      )
    }
  }

  views(): LaneView[] { return this.#runner?.views() ?? [] }

  /** The lanes for the HUD's snapshot and the Concierge: tag, desk, state and the last reading. */
  lines(): LaneLine[] {
    return this.views().map((v) => Object.freeze({ tag: v.tag, role: v.role, state: v.state, reading: v.value }))
  }

  /** One line for the HUD: "Team 24 · telemetry 8, warehouse 8, robotics 8 · 1 isolated · 2 coming over"; '' without a team. */
  line(): string {
    const team = this.#team
    const runner = this.#runner
    if (!team || !runner) return ''
    const views = runner.views()
    const perDesk = team.kinds.map((k) => `${deskOf(k).short} ${views.filter((v) => team.lanes[v.lane]!.kind === k).length}`)
    const isolated = views.filter((v) => v.state === 'isolated').length
    const coming = this.#bodies.filter((b) => b.state === 'coming').length
    const seated = this.#bodies.filter((b) => b.state === 'rallied').length
    return [
      `${team.scouting ? 'Scouts' : 'Team'} ${views.length}`, perDesk.join(', '),
      ...(isolated ? [`${isolated} isolated`] : []), ...(coming ? [`${coming} coming over`] : []), ...(seated ? [`${seated} at their desk`] : []),
    ].join(' · ')
  }

  /** The console's status: the team, a table of its lanes, the bodies and the latest notes. */
  status(): string[] {
    const team = this.#team
    const runner = this.#runner
    if (!team || !runner) return ['lanes: nobody dispatched; tell Sloane a goal about work, or type goal <words...>']
    const views = runner.views()
    const isolated = views.filter((v) => v.state === 'isolated').length
    const dropped = team.dropped + runner.dropped
    const lines = [
      `team: ${teamLabel(team)} (${views.length - isolated} running, ${isolated} isolated${dropped ? `, ${dropped} asked for beyond the cap` : ''}) · tick ${runner.tick}`,
      `  ${'LANE'.padEnd(6)}${'TAG'.padEnd(14)}${'STATE'.padEnd(10)}${'WORD'.padEnd(22)}${'STEPS'.padEnd(7)}READING`,
      ...views.map((v) => `  ${String(v.lane).padEnd(6)}${v.tag.padEnd(14)}${v.state.padEnd(10)}${(capNames(v.held).join(', ') || 'none').padEnd(22)}${String(v.steps).padEnd(7)}${v.state === 'isolated' ? `${v.fault}: ${v.error ?? ''}`.trim() : v.value ?? 'starting'}`),
    ]
    if (this.#bodies.length) {
      lines.push(`bodies: one asked over a desk (${this.#bodies.length}); sent in when you stand within ${RALLY_RANGE} m of the desk's door`)
      for (const b of this.#bodies) lines.push(`  ${b.tag.padEnd(14)}${b.state.padEnd(10)}${b.note}`)
    }
    if (this.#notes.length) lines.push('notes:', ...this.#notes.map((n) => `  ${n}`))
    return lines
  }

  /** The fault ledger: every isolated lane in order, and the chain's verdict when asked. */
  ledger(verify: boolean): string[] {
    const runner = this.#runner
    const team = this.#team
    if (!runner || !team) return ['lanes: nobody dispatched, so no ledger']
    const records = runner.ledger.records()
    const lines = records.length
      ? records.map((r) => `  #${r.seq} lane ${r.lane} ${team.lanes[r.lane]?.tag ?? ''} ${r.kind} at tick ${r.tick}: ${r.reason} (${r.hash.slice(0, 16)})`)
      : ['  no lane has been isolated']
    lines.unshift(`ledger: ${records.length} ${records.length === 1 ? 'record' : 'records'}, head ${runner.ledger.head.slice(0, 16)}`)
    if (verify) {
      const v = runner.ledger.verify()
      lines.push(v.ok ? '  chain verified: every hash recomputes from the one before it' : `  chain broken at #${v.at}: ${v.why}`)
    }
    return lines
  }

  /** Closes every lane. The people asked over stay with the player (recruit dismiss lets them go). */
  stop(): string {
    const runner = this.#runner
    if (!runner) return 'nobody dispatched'
    const n = runner.count
    this.#gen++
    this.#team = null
    this.#runner = null
    this.#bodies = []
    this.#notes = []
    return `released: ${n} ${n === 1 ? 'lane' : 'lanes'} closed; the people asked over stay with you (recruit dismiss lets them go)`
  }

  /** The console's surface (terminal/bridge.ts LanesBridge). */
  console(): TeamConsole {
    return Object.freeze({
      status: () => this.status(),
      ledger: (verify: boolean) => this.ledger(verify),
      stop: () => this.stop(),
      dispatch: (team: Team) => { const d = this.dispatch(team); return { lanes: d.lanes, dropped: d.dropped } },
    })
  }

  dispose(): void {
    if (this.#runner) this.stop()
    else this.#gen++
  }

  #rooms(): readonly TeamRoom[] {
    try {
      return this.#host.rooms()
    } catch (e) {
      this.#note(`rooms: ${text(e)}`)
      return []
    }
  }

  #note(line: string): void {
    this.#notes.push(line)
    if (this.#notes.length > NOTES_MAX) this.#notes.splice(0, this.#notes.length - NOTES_MAX)
  }
}
