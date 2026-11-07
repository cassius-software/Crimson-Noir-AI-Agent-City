// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the capability word of a sub-agent lane: one 32-bit word per lane, kept the
 * structure-of-arrays way (a Uint32Array, as the kernel's fuse keeps its own in noir_core kernels.rs), and the
 * arithmetic that reads it without a branch. Four bits can be granted (CAP_MOVE, CAP_WORKPLACE_TASK,
 * CAP_VEHICLE_TELEOP, CAP_SUBAGENT_SPAWN); every other bit is forbidden for good (CAP_FORBIDDEN_MASK), and the top
 * four of them name the doors of the host no lane is ever let through (the network, dynamic code, a window, the
 * host process), so a fault can say which door was tried. `violation(asked, held)` is the one check, the kernel's
 * `asked & !caps` in TypeScript; a `CapabilityLanes` table grants only grantable bits, and a lane it has zeroed is
 * sealed: nothing is ever granted to it again. `FaultLedger` is the audit trail of the lanes the Ring-0 lane
 * panic (ring0Panic.ts lanePanic) isolated: every fault hashed over the one before it with the city's own SHA-256
 * (integrity.ts), so a fault cannot be removed or reworded after the fact without the chain saying so. The Ring-0
 * action gate (ring0Gate.ts LaneCapable) reads these words; the lanes themselves run in 08_Swarm. Pure: no clock, no
 * randomness, no I/O, nothing of the DOM.
 * What breaks if it is removed? A sub-agent lane would have no word saying what it may do, nothing would strip a
 * forbidden bit from a grant, and a lane's isolation would leave no hash behind it.
 */
import { canonical, sha256 } from './integrity.ts'

// ---------------------------------------------------------------------------------------------------
// The bits

/** No capability: a lane that may do nothing, which is also what a zeroed lane holds. */
export const CAP_NONE = 0
/** Walk: a rally to a sidewalk point, asked of the physics realm, which decides on its own readings. */
export const CAP_MOVE = 1 << 0
/** Work: a station in an indoor workplace, and the bounded program run there each tick. */
export const CAP_WORKPLACE_TASK = 1 << 1
/** A car's intent (the elite tier's NoirScript write): the only way a lane reaches a vehicle. */
export const CAP_VEHICLE_TELEOP = 1 << 2
/** Open a lane under one's own: the root orchestrator's bit, never a sub-agent's. */
export const CAP_SUBAGENT_SPAWN = 1 << 3
/** Every bit a lane can be granted. */
export const CAP_GRANTABLE = (CAP_MOVE | CAP_WORKPLACE_TASK | CAP_VEHICLE_TELEOP | CAP_SUBAGENT_SPAWN) >>> 0

/** The doors, bits 28..31: named so that a refusal can say which one was tried. None is ever granted. */
export const CAP_NET = 1 << 28
export const CAP_CODE = 1 << 29
export const CAP_WINDOW = 1 << 30
export const CAP_HOST = 0x8000_0000
/** The four doors together. */
export const CAP_DOORS = (CAP_NET | CAP_CODE | CAP_WINDOW | CAP_HOST) >>> 0
/** Every bit that is not grantable: the four doors and the reserved bits between. `grant` strips it, `violation` sees it. */
export const CAP_FORBIDDEN_MASK = (~CAP_GRANTABLE) >>> 0

/** The named bits, in bit order. */
export const CAP_NAMES: readonly { readonly bit: number; readonly name: string }[] = Object.freeze([
  Object.freeze({ bit: CAP_MOVE, name: 'move' }),
  Object.freeze({ bit: CAP_WORKPLACE_TASK, name: 'workplace task' }),
  Object.freeze({ bit: CAP_VEHICLE_TELEOP, name: 'vehicle teleop' }),
  Object.freeze({ bit: CAP_SUBAGENT_SPAWN, name: 'sub-agent spawn' }),
  Object.freeze({ bit: CAP_NET, name: 'the network' }),
  Object.freeze({ bit: CAP_CODE, name: 'dynamic code' }),
  Object.freeze({ bit: CAP_WINDOW, name: 'a window' }),
  Object.freeze({ bit: CAP_HOST, name: 'the host process' }),
])

/** The names of a word's bits, lowest first; a reserved bit is named by its number. */
export function capNames(mask: number): string[] {
  const m = mask >>> 0
  const out: string[] = []
  for (let bit = 0; bit < 32; bit++) {
    const w = (1 << bit) >>> 0
    if ((m & w) === 0) continue
    out.push(CAP_NAMES.find((c) => c.bit === w)?.name ?? `reserved bit ${bit}`)
  }
  return out
}

/** A word as the console prints it: eight hex digits. */
export const capHex = (mask: number): string => `0x${(mask >>> 0).toString(16).padStart(8, '0')}`

// ---------------------------------------------------------------------------------------------------
// The doors

/** A door of the host and the forbidden bit it stands under. */
export interface Door { readonly name: string; readonly bit: number }

/**
 * The doors no lane is let through, by the name a script would use. The network and a window are the page's
 * outbound primitives, which the air gap (airgap.ts installAirgap) guards or removes on the page's global for every
 * script alike; dynamic code and the host process are not reachable from a lane at all (a lane runs NoirScript,
 * whose folder names none of them, pinned by its own air-gap test). The list is what `doorOf` answers and what the
 * air gap's test checks itself against, so the two cannot part.
 */
export const FORBIDDEN_DOORS: readonly Door[] = Object.freeze([
  ...['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport', 'navigator.sendBeacon'].map((name) => Object.freeze({ name, bit: CAP_NET })),
  ...['eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'importScripts', 'WebAssembly'].map((name) => Object.freeze({ name, bit: CAP_CODE })),
  ...['window.open', 'open'].map((name) => Object.freeze({ name, bit: CAP_WINDOW })),
  ...['process', 'require', 'fs', 'child_process', 'Deno', 'Bun'].map((name) => Object.freeze({ name, bit: CAP_HOST })),
])

/** The forbidden bit a door's name stands under, or 0 for a name that is no door. */
export function doorOf(name: string): number {
  return FORBIDDEN_DOORS.find((d) => d.name === name)?.bit ?? 0
}

// ---------------------------------------------------------------------------------------------------
// The arithmetic, without a branch

/** The bits asked for that are not held: 0 means admitted. The kernel's `asked & !caps` (kernels.rs). */
export const violation = (asked: number, held: number): number => (asked & ~held) >>> 0

/** The forbidden bits of a word: 0 when it asks for grantable bits only. */
export const forbidden = (asked: number): number => (asked & CAP_FORBIDDEN_MASK) >>> 0

/** The door bits of a word: 0 when it names no door. */
export const doors = (asked: number): number => (asked & CAP_DOORS) >>> 0

/** The grantable bits of a word. */
export const grantable = (asked: number): number => (asked & CAP_GRANTABLE) >>> 0

/** The most lanes one table holds. */
export const MAX_LANES = 1024

/**
 * The capability words of a plan's lanes, one Uint32 each. A grant keeps only grantable bits; a zeroed lane is
 * sealed, and a sealed lane's word stays 0 whatever is granted afterwards (`& (sealed - 1)`: all ones for an open
 * lane, 0 for a sealed one). A lane number outside the table holds nothing and is granted nothing.
 */
export class CapabilityLanes {
  readonly #mask: Uint32Array
  readonly #sealed: Uint8Array

  constructor(lanes: number) {
    const n = Number.isInteger(lanes) && lanes > 0 ? Math.min(lanes, MAX_LANES) : 0
    this.#mask = new Uint32Array(n)
    this.#sealed = new Uint8Array(n)
  }

  /** How many lanes the table holds. */
  get count(): number { return this.#mask.length }

  /** Every lane's word, a copy. */
  words(): Uint32Array { return this.#mask.slice() }

  /** What a lane holds; 0 for a lane the table does not have. */
  held(lane: number): number {
    return this.#has(lane) ? this.#mask[lane]! : 0
  }

  /** Grants the grantable bits of `bits` to an open lane and returns what the lane holds now (0 on a sealed lane). */
  grant(lane: number, bits: number): number {
    if (!this.#has(lane)) return 0
    const open = (this.#sealed[lane]! - 1) >>> 0
    this.#mask[lane] = ((this.#mask[lane]! | grantable(bits)) & open) >>> 0
    return this.#mask[lane]!
  }

  /** Takes bits off a lane and returns what it holds now. */
  revoke(lane: number, bits: number): number {
    if (!this.#has(lane)) return 0
    this.#mask[lane] = (this.#mask[lane]! & ~bits) >>> 0
    return this.#mask[lane]!
  }

  /** The bits `asked` that the lane does not hold: 0 admits. A lane the table does not have holds nothing. */
  check(lane: number, asked: number): number {
    return violation(asked, this.held(lane))
  }

  /** Zeroes a lane's word and seals it; returns the bits it held. */
  zero(lane: number): number {
    if (!this.#has(lane)) return 0
    const was = this.#mask[lane]!
    this.#mask[lane] = 0
    this.#sealed[lane] = 1
    return was
  }

  /** Whether a lane has been zeroed and sealed. */
  isolated(lane: number): boolean {
    return this.#has(lane) && this.#sealed[lane] === 1
  }

  #has(lane: number): boolean {
    return Number.isInteger(lane) && lane >= 0 && lane < this.#mask.length
  }
}

// ---------------------------------------------------------------------------------------------------
// The audit trail

/** Why a lane was isolated: a VM bound (the gas budget, an index, memory, depth, output), a bit it did not hold, a door, or another law. */
export type FaultKind = 'gas' | 'bounds' | 'memory' | 'depth' | 'output' | 'capability' | 'door' | 'law'

export const FAULT_KINDS: readonly FaultKind[] = Object.freeze(['gas', 'bounds', 'memory', 'depth', 'output', 'capability', 'door', 'law'])

/** One fault as the lane runner reports it: the lane, why, the words involved, the steps it had taken and the tick. */
export interface LaneFault {
  readonly lane: number
  readonly kind: FaultKind
  readonly reason: string
  readonly asked: number
  readonly held: number
  readonly steps: number
  readonly tick: number
}

/** A fault on the ledger: numbered, linked to the hash before it, and hashed over its whole body. */
export interface FaultRecord extends LaneFault {
  readonly seq: number
  readonly prev: string
  readonly hash: string
}

/** The hash an empty ledger stands on. */
export const LEDGER_GENESIS: string = sha256('crimson-noir:lane-ledger:v1')

const bodyOf = (r: FaultRecord): Omit<FaultRecord, 'hash'> =>
  ({ seq: r.seq, prev: r.prev, lane: r.lane, kind: r.kind, reason: r.reason, asked: r.asked, held: r.held, steps: r.steps, tick: r.tick })

/** The hash of a record's body: SHA-256 over its canonical form (sorted keys, so the field order never matters). */
export const faultHash = (r: Omit<FaultRecord, 'hash'>): string => sha256(canonical(r))

/** A fault is a frozen record; a number that is not a finite integer is kept as 0, so the hash is of plain data. */
const whole = (n: number): number => (Number.isSafeInteger(n) ? n + 0 : 0)

/**
 * The hash-chained trail of isolated lanes. `record` appends and returns the record; `verify` recomputes the chain
 * from the genesis hash and names the first record that does not hold.
 */
export class FaultLedger {
  readonly #records: FaultRecord[] = []
  #head: string = LEDGER_GENESIS

  get length(): number { return this.#records.length }
  /** The newest hash, the genesis hash while empty. */
  get head(): string { return this.#head }

  /** Every record, oldest first (the records are frozen; the array is a copy). */
  records(): FaultRecord[] { return this.#records.slice() }

  record(f: LaneFault): FaultRecord {
    const kind: FaultKind = FAULT_KINDS.includes(f.kind) ? f.kind : 'law'
    const body = {
      seq: this.#records.length, prev: this.#head,
      lane: whole(f.lane), kind, reason: typeof f.reason === 'string' ? f.reason.slice(0, 512) : '',
      asked: whole(f.asked) >>> 0, held: whole(f.held) >>> 0, steps: whole(f.steps), tick: whole(f.tick),
    }
    const rec: FaultRecord = Object.freeze({ ...body, hash: faultHash(body) })
    this.#records.push(rec)
    this.#head = rec.hash
    return rec
  }

  /** Whether every record links to the one before it and hashes to its own body, from the genesis hash. */
  verify(): { readonly ok: true } | { readonly ok: false; readonly at: number; readonly why: string } {
    let prev = LEDGER_GENESIS
    for (let i = 0; i < this.#records.length; i++) {
      const r = this.#records[i]!
      if (r.seq !== i) return { ok: false, at: i, why: 'is out of sequence' }
      if (r.prev !== prev) return { ok: false, at: i, why: 'does not link to the record before it' }
      if (r.hash !== faultHash(bodyOf(r))) return { ok: false, at: i, why: 'its hash is not the hash of its body' }
      prev = r.hash
    }
    return prev === this.#head ? { ok: true } : { ok: false, at: this.#records.length, why: 'the head is not the newest hash' }
  }
}

Object.freeze(capNames)
Object.freeze(doorOf)
Object.freeze(violation)
Object.freeze(forbidden)
Object.freeze(doors)
Object.freeze(grantable)
