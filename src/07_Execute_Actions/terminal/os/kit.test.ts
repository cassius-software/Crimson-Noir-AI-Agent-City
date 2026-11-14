// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is what the tests of the console's operating layer share: a whole system started in
 * memory on a clock the test moves by hand, a way to type a line at its shell and get back exactly what it printed,
 * and a few short cuts (write a file, read a file). It holds no test of its own; it is named as one so it is never
 * part of the page.
 * What breaks if it is removed? Every test file in this folder would build its own system, each a little differently.
 */
import { decode, encode } from './bytes.ts'
import type { Program } from './kernel.ts'
import { ROOT_CRED } from './fs.ts'
import type { CityHost } from './shell.ts'
import { System } from './system.ts'
import type { SystemOptions } from './system.ts'
import { now } from './task.ts'

/** A system under test. */
export interface Kit {
  readonly system: System
  /**
   * Types `line` at the shell, runs until nothing can move, and gives back what was printed: each ordinary line as
   * it is, each error line with `!` before it, and anything posted to the host as `POST <json>`.
   */
  sh(line: string): string[]
  /** Runs until nothing can move, without typing anything; what was printed. */
  settle(): string[]
  /** Moves the clock on by `ms` milliseconds (nothing runs until `sh` or `settle`). */
  tick(ms: number): void
  /** Writes a file straight to the file system (no shell involved). */
  write(path: string, text: string | Uint8Array): void
  /** A file's text, straight from the file system. */
  read(path: string): string
  /** A file's bytes, straight from the file system. */
  bytes(path: string): Uint8Array
  /** Whether a path names something. */
  exists(path: string): boolean
}

/** The clock every kit starts at: 2026-11-14 18:00:00 UTC, in milliseconds since 1970. */
export const START = 1794679200000

/** Starts a system with these programs in /bin (the shell is always there) and settles it at its first prompt. */
export function boot(programs: Readonly<Record<string, Program>>, opts: Partial<SystemOptions> & { city?: CityHost } = {}): Kit {
  let t = 0
  const system = new System({
    hostname: 'crimson-noir',
    version: 'Crimson Noir OS test',
    clock: () => t,
    wall: () => START + t,
    programs,
    ...opts,
  })
  const collect = (): string[] => {
    const out: string[] = []
    // A generous budget: a test that never settles fails on the count below, not by hanging.
    for (let turns = 0; turns < 10000; turns++) {
      for (const e of system.run(1_000_000, Number.POSITIVE_INFINITY)) {
        out.push(e.kind === 'post' ? `POST ${JSON.stringify(e.payload)}` : `${e.kind === 'err' ? '!' : ''}${e.text}`)
      }
      if (system.idle) return out
    }
    throw new Error('the system never settled')
  }
  collect()
  const vfs = system.kernel.vfs
  return {
    system,
    sh(line) {
      system.type(line)
      return collect()
    },
    settle: collect,
    tick(ms) { t += ms },
    write(path, text) { now(vfs.writeFile(path, '/', ROOT_CRED, typeof text === 'string' ? encode(text) : text)) },
    read(path) { return decode(now(vfs.readFile(path, '/', ROOT_CRED))) },
    bytes(path) { return now(vfs.readFile(path, '/', ROOT_CRED)) },
    exists(path) { return now(vfs.access(path, '/', ROOT_CRED, 0)) },
  }
}
