// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the lane runner: the isolated logical lanes a dispatched plan's sub-agents run in.
 * A lane is one NoirScript session of its own (terminal/noirscript: its own arena, so no lane reads another's
 * memory) with a capability word (02_Define_The_Rules/capabilities.ts), a program the dispatcher wrote for it and
 * a tag naming what its last printed line measures. Each tick (`step`) runs every open lane's program once against
 * one snapshot of the city's columns, under the lane limits (MAX_OPS_PER_TICK instructions, a short output, a
 * quarter-megabyte arena, a shallow stack), and puts the result to the Ring-0 action gate (ring0Gate.ts admitLane):
 * a program that ran its gas out, reached past its bounds, or asked a write for a capability the lane does not hold
 * trips the lane panic (ring0Panic.ts lanePanic), which zeroes the lane's word for good and hashes the fault onto
 * the runner's ledger; the other lanes and the frame go on. `ask` puts an effect outside the VM (a rally, a station)
 * to the same gate before the host makes it. Nothing here throws out of `step` or `ask`: a host that fails is an
 * error on the lane's view, a program with a plain mistake keeps its lane, and a vouch the host cannot give fails
 * closed. Deterministic: the same specs, the same tables in the same order give the same views and the same ledger.
 * What breaks if it is removed? A sub-agent's program would run on the console's session with the console's budget,
 * nothing would isolate a runaway one short of halting the city, and no capability word would be read before an
 * effect.
 */
import { CapabilityLanes, CAP_VEHICLE_TELEOP, doors, type FaultKind, type FaultRecord, type LaneFault } from '../02_Define_The_Rules/capabilities.ts'
import { FaultLedger } from '../02_Define_The_Rules/capabilities.ts'
import { admitLane, sentence, type GateVerdict, type LaneBound, type Vouched } from '../02_Define_The_Rules/ring0Gate.ts'
import { lanePanic } from '../02_Define_The_Rules/ring0Panic.ts'
import { EMPTY_TABLES, LANE_LIMITS, NoirSession, type NoirFault, type NoirHost, type NoirLimits, type NoirTables, type NoirWrites } from '../07_Execute_Actions/terminal/noirscript/index.ts'

/** The most lanes one runner opens: a plan that asks for more gets this many, and says so (`dropped`). */
export const LANE_MAX = 32

/** One lane as the dispatcher orders it. */
export interface LaneSpec {
  /** What the sub-agent is for, in words ('warehouse lead', 'schedule analyst'). */
  readonly role: string
  /** The capability bits it is granted (forbidden bits are stripped by the table). */
  readonly caps: number
  /** The NoirScript line run each tick; its last printed line is the tag's reading. */
  readonly program: string
  /**
   * Declarations run once, before the first tick's program, in the lane's session (a cursor the program walks, a fn it
   * calls): what a program would otherwise redeclare every tick, filling the arena. Its steps count against that
   * tick's budget and a bound it reaches isolates the lane as the program's would.
   */
  readonly prelude?: string
  /** What the reading is ('people at the warehouse'). */
  readonly tag: string
}

/** A lane as the HUD, the console and the Concierge show it. */
export interface LaneView {
  readonly lane: number
  readonly role: string
  readonly tag: string
  /** The capability word now (0 once isolated). */
  readonly held: number
  readonly state: 'ready' | 'isolated'
  /** Ticks the program has run. */
  readonly ticks: number
  /** The instructions the last tick took, and the total over every tick. */
  readonly steps: number
  readonly total: number
  /** The last line the program printed: the tag's reading; null before the first. */
  readonly value: string | null
  /** The last tick's error text (a plain error keeps the lane running), or null. */
  readonly error: string | null
  /** Why the lane was isolated, and the fault record's hash; null while it runs. */
  readonly fault: FaultKind | null
  readonly audit: string | null
}

/** What the runner reads of its host: the vouch, the realm's standing, and where to log a panic. */
export interface LaneDeps {
  /** Whether the air gap is installed on this global (airgap.ts airgapInstalled); null fails closed. */
  contained(): Vouched
  /** The Ring-0 audit's panic reason, or null while the realm stands. */
  panic(): string | null
  /** The lane panic's line (console.error unless given). */
  log?(line: string): void
}

/** The outcome of `ask`: admitted, or the law's sentence and the lane isolated. */
export type Asked = { readonly ok: true } | { readonly ok: false; readonly reason: string }

interface Lane {
  readonly spec: LaneSpec
  readonly session: NoirSession
  ticks: number
  steps: number
  total: number
  value: string | null
  error: string | null
  fault: FaultKind | null
  audit: string | null
}

const text = (e: unknown): string => (e instanceof Error ? e.message : String(e))

export class LaneRunner {
  readonly #lanes: Lane[]
  readonly #table: CapabilityLanes
  readonly #ledger = new FaultLedger()
  readonly #deps: LaneDeps
  readonly #limits: NoirLimits
  readonly #dropped: number
  #tick = 0

  constructor(specs: readonly LaneSpec[], deps: LaneDeps, limits: NoirLimits = LANE_LIMITS) {
    const kept = specs.slice(0, LANE_MAX)
    this.#dropped = specs.length - kept.length
    this.#deps = deps
    this.#limits = limits
    this.#table = new CapabilityLanes(kept.length)
    this.#lanes = kept.map((spec, lane) => {
      this.#table.grant(lane, spec.caps)
      return { spec, session: new NoirSession(limits), ticks: 0, steps: 0, total: 0, value: null, error: null, fault: null, audit: null }
    })
  }

  /** Lanes open or isolated; the specs a plan asked for beyond LANE_MAX. */
  get count(): number { return this.#lanes.length }
  get dropped(): number { return this.#dropped }
  /** Ticks run so far. */
  get tick(): number { return this.#tick }
  /** The audit trail of isolated lanes. */
  get ledger(): Pick<FaultLedger, 'length' | 'head' | 'records' | 'verify'> { return this.#ledger }
  /** A lane's capability word now. */
  held(lane: number): number { return this.#table.held(lane) }
  isolated(lane: number): boolean { return this.#table.isolated(lane) }
  /** How many lanes still run. */
  get open(): number { return this.#lanes.reduce((n, _, i) => n + (this.#table.isolated(i) ? 0 : 1), 0) }

  views(): LaneView[] {
    return this.#lanes.map((l, lane) => Object.freeze({
      lane, role: l.spec.role, tag: l.spec.tag, held: this.#table.held(lane), state: this.#table.isolated(lane) ? 'isolated' as const : 'ready' as const,
      ticks: l.ticks, steps: l.steps, total: l.total, value: l.value, error: l.error, fault: l.fault, audit: l.audit,
    }))
  }

  /**
   * One tick: every open lane's program once, each against the same tables (null: the empty city) and, for a lane
   * holding vehicle teleop, the host's write surface (its `intent` alone; the operator's knobs are nobody's lane's).
   * Never throws. Returns the views after the tick.
   */
  step(tables: NoirTables | null, write?: NoirWrites | null): LaneView[] {
    this.#tick++
    const t = tables ?? EMPTY_TABLES
    for (let lane = 0; lane < this.#lanes.length; lane++) {
      if (this.#table.isolated(lane)) continue
      const l = this.#lanes[lane]!
      const held = this.#table.held(lane)
      let asked = 0
      const writes: NoirWrites = {
        intent: (car, throttle, brake, steer) => {
          asked |= CAP_VEHICLE_TELEOP
          if ((held & CAP_VEHICLE_TELEOP) === 0) throw new Error('lane: vehicle teleop is not held')
          if (!write) throw new Error('lane: the host gave no write surface')
          return write.intent(car, throttle, brake, steer)
        },
        tune: () => { throw new Error("lane: tune is the operator's knob, not a lane's") },
        cull: () => { throw new Error("lane: cull is the operator's knob, not a lane's") },
        steer: () => { throw new Error("lane: steer is the operator's knob, not a lane's") },
      }
      const host: NoirHost = { tables: () => t, write: writes, locked: 'lane: no write surface' }
      let steps = 0
      let fault: { kind: LaneBound; text: string } | null = null
      try {
        if (l.ticks === 0 && l.spec.prelude !== undefined) {
          const p = l.session.run(l.spec.prelude, host)
          steps += p.steps
          if (p.out.length > 0) l.value = p.out[p.out.length - 1]!
          if (p.fault !== undefined) fault = { kind: p.fault satisfies NoirFault, text: p.error ?? p.fault }
        }
        // A prelude that reached a bound is the tick's fault; the program waits for a verdict it will not get.
        const r = fault === null ? l.session.run(l.spec.program, host) : null
        l.ticks++
        if (r !== null) {
          steps += r.steps
          if (r.out.length > 0) l.value = r.out[r.out.length - 1]!
          l.error = r.error ?? null
          if (r.fault !== undefined) fault = { kind: r.fault satisfies NoirFault, text: r.error ?? r.fault }
        }
        l.steps = steps
        l.total += steps
      } catch (e) {
        // The session never throws; a host that does is an error on the view and the lane runs again next tick.
        l.error = `lane: ${text(e)}`
      }
      this.#judge(lane, held, asked, steps, fault)
    }
    return this.views()
  }

  /** An effect outside the VM (a rally, a station), the moment before the host makes it: admitted, or refused and the lane isolated. */
  ask(lane: number, caps: number): Asked {
    if (!Number.isInteger(lane) || lane < 0 || lane >= this.#lanes.length) return { ok: false, reason: 'no such lane' }
    if (this.#table.isolated(lane)) return { ok: false, reason: `lane ${lane} is isolated` }
    const v = this.#judge(lane, this.#table.held(lane), caps, 0, null)
    return v.admitted ? { ok: true } : { ok: false, reason: sentence(v) }
  }

  /** The gate's verdict on a lane's tick or effect; a refusal is the lane panic. */
  #judge(lane: number, held: number, asked: number, steps: number, fault: { kind: LaneBound; text: string } | null): GateVerdict {
    const v = admitLane({ contained: this.#vouch(), panic: this.#standing(), held, asked, steps, budget: this.#limits.steps, fault })
    if (v.admitted) return v
    const l = this.#lanes[lane]!
    const kind = kindOf(v, asked, fault)
    const f: LaneFault = { lane, kind, reason: sentence(v), asked, held, steps, tick: this.#tick }
    const rec: FaultRecord | null = lanePanic(f, this.#table, this.#ledger, this.#deps.log)
    l.fault = kind
    l.audit = rec?.hash ?? null
    return v
  }

  /** The host's vouch; a host that throws has vouched nothing. */
  #vouch(): Vouched {
    try {
      const v = this.#deps.contained()
      return v === true ? true : v === false ? false : null
    } catch {
      return null
    }
  }

  /** The realm's standing; a host that throws is read as halted for the reason it threw. */
  #standing(): string | null {
    try {
      const p = this.#deps.panic()
      return typeof p === 'string' ? p : null
    } catch (e) {
      return `the host could not say whether the realm stands: ${text(e)}`
    }
  }
}

/** The kind a refusal is recorded under: the gate's first refusal names it. */
function kindOf(v: GateVerdict, asked: number, fault: { kind: LaneBound; text: string } | null): FaultKind {
  const first = v.failed[0]?.check
  if (first === 'GasWithin') return 'gas'
  if (first === 'MemoryWithin') return fault?.kind ?? 'memory'
  if (first === 'LaneCapable') return doors(asked) !== 0 ? 'door' : 'capability'
  return 'law'
}
