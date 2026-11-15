// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one error Nightglass raises. Every refusal, from a malformed shader word to a
 * draw outside a pass, is a Fault with a stable code (the kind of mistake) and a sentence that names the object and
 * the rule, so a caller can branch on the code and a person can read the sentence.
 * What breaks if it is removed? Each module would invent its own error, a caller could not tell a misuse of the API
 * from a bug inside it, and the tests could not pin which rule refused a call.
 */

/** The kinds of refusal. A code never changes meaning once shipped; new kinds are added at the end. */
export const FAULT_CODES = [
  /** A descriptor or argument breaks a rule of the call (a size of zero, an unknown format, a missing field). */
  'invalid',
  /** The call is valid on its own but not in the object's present state (recording ended, a pass already open). */
  'state',
  /** A limit of the device or of the API was passed (too many bindings, an image larger than the device allows). */
  'limit',
  /** A feature the call needs was not asked for when the device opened. */
  'feature',
  /** A memory request could not be met (the heap is full, a host view of memory the host cannot see). */
  'memory',
  /** Two objects do not fit together (a pipeline built for another pass layout, a set made from another layout). */
  'mismatch',
  /** A shader in the binary form is malformed or breaks a rule of the form. */
  'lens',
  /** A read or write is not ordered after the write it depends on: a barrier or a semaphore is missing. */
  'hazard',
  /** An image is used in a layout other than the one the call needs. */
  'layout',
  /** An object was used after it was destroyed, or destroyed while queued work still uses it. */
  'lifetime',
  /** The back end refused or lost the device; the message is the back end's own. */
  'device',
  /** A bound of a shader's run on the reference renderer was passed (a loop that never ends). */
  'bound',
] as const

export type FaultCode = (typeof FAULT_CODES)[number]

/** A refusal from Nightglass. `code` says which kind of rule; `message` says which object and which rule. */
export class Fault extends Error {
  readonly code: FaultCode

  constructor(code: FaultCode, message: string) {
    super(message)
    this.name = 'Fault'
    this.code = code
  }
}

/** Raises a Fault. Written as a function so a check reads as one line: `size > 0 || fail('invalid', ...)`. */
export function fail(code: FaultCode, message: string): never {
  throw new Fault(code, message)
}

/** True when the value is a Fault (of the given code, when one is named). */
export function isFault(value: unknown, code?: FaultCode): value is Fault {
  return value instanceof Fault && (code === undefined || value.code === code)
}
