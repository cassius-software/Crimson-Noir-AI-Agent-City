// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The page's half of a Ring-0 kernel panic, and the lane panic beside it. The audit itself
 * runs in the physics worker (ring0.ts via simCore.ts); when it halts the simulation, the page logs the fatal line,
 * severs the hardware bridge and throws SYSTEM LOCKED out of the frame (`kernelPanic`). A sub-agent lane that
 * overran its budget, reached past its memory or asked for a capability it does not hold is not the realm: it is
 * one lane of many, so `lanePanic` logs the lane's line, zeroes that lane's capability word through the table it is
 * given (a bitwise clear, sealed for good: capabilities.ts), appends the fault to the hash-chained ledger and
 * returns, and the frame goes on. Kept apart from ring0.ts so the page's bundle carries these two functions and not
 * the auditor.
 * What breaks if it is removed? A panic in the physics realm would not lock the page or cut the hardware, and a
 * runaway lane would have nothing to isolate it short of halting the whole city.
 */
import type { FaultRecord, LaneFault } from './capabilities.ts'

/**
 * Frozen. Logs `[RING-0 FATAL] <reason>`, runs `sever()` (a failing sever is logged and must not stop the
 * halt), then throws `Error('SYSTEM LOCKED: <reason>')`. Never returns.
 */
export function kernelPanic(reason: string, sever: () => void): never {
  console.error(`[RING-0 FATAL] ${reason}`)
  try {
    sever()
  } catch (e) {
    console.error('[RING-0 FATAL] severing the hardware bridge failed:', e)
  }
  throw new Error(`SYSTEM LOCKED: ${reason}`)
}

/** The capability table a lane panic zeroes a lane in (capabilities.ts CapabilityLanes). */
export interface LaneTable { zero(lane: number): number }
/** The ledger a lane panic records on (capabilities.ts FaultLedger). */
export interface LaneLedger { record(fault: LaneFault): FaultRecord }

/** A lane's log line: the lane, the kind, the reason, the two words and the audit hash's first sixteen hex digits. */
const hex = (n: number): string => `0x${(n >>> 0).toString(16).padStart(8, '0')}`

/**
 * Frozen. Isolates one lane without touching the frame: logs `[RING-0 LANE <n>] isolated (<kind>): <reason>`, zeroes
 * the lane's capability word (sealed: the table grants it nothing again), records the fault on the ledger and
 * returns the record. Never throws: a table or a ledger that fails is logged, and the lane is still reported
 * isolated to the caller (null stands for a record the ledger could not take). `log` is console.error unless a
 * host gives its own.
 */
export function lanePanic(fault: LaneFault, lanes: LaneTable, ledger: LaneLedger, log: (line: string) => void = (line) => console.error(line)): FaultRecord | null {
  let record: FaultRecord | null = null
  try {
    lanes.zero(fault.lane)
  } catch (e) {
    say(log, `[RING-0 LANE ${fault.lane}] zeroing the lane failed: ${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    record = ledger.record(fault)
  } catch (e) {
    say(log, `[RING-0 LANE ${fault.lane}] the ledger refused the fault: ${e instanceof Error ? e.message : String(e)}`)
  }
  say(log, `[RING-0 LANE ${fault.lane}] isolated (${fault.kind}): ${fault.reason}; held ${hex(fault.held)}, asked ${hex(fault.asked)}, ${fault.steps} steps, tick ${fault.tick}; audit ${record ? record.hash.slice(0, 16) : '(none)'}`)
  return record
}

/** A log that throws must not stop the panic either. */
function say(log: (line: string) => void, line: string): void {
  try {
    log(line)
  } catch {
    // the host's log failed: nothing more can be said
  }
}

Object.freeze(kernelPanic)
Object.freeze(lanePanic)
