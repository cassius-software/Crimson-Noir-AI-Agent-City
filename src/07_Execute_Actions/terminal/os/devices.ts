// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is /dev: the handful of devices every script expects. `null` takes anything and
 * holds nothing, `zero` gives zeros for as long as it is read, `full` refuses every write as a full disk would,
 * `random` and `urandom` give bytes from the source the host handed over (the kernel has none of its own), and
 * `tty` is the terminal of whoever opens it.
 * What breaks if it is removed? `> /dev/null` has nowhere to go, and a script cannot write to the screen past a
 * redirection.
 */
import { EMPTY } from './bytes.ts'
import { refuse } from './errno.ts'
import type { Kernel } from './kernel.ts'
import { dir } from './synth.ts'
import type { SynthDir, SynthStream } from './synth.ts'

/** The most bytes one read of a device hands back. */
const READ_MAX = 65536

/** The devices. `entropy` fills an array with bytes nobody can foretell; without it `random` reads as EIO. */
export function devices(kernel: Kernel, entropy: ((bytes: Uint8Array) => void) | null): SynthDir {
  const nothing: SynthStream = { kind: 'stream', read: () => EMPTY, write: (data) => data.length }
  const zero: SynthStream = { kind: 'stream', read: (length) => new Uint8Array(Math.min(length, READ_MAX)), write: (data) => data.length }
  const full: SynthStream = { kind: 'stream', read: (length) => new Uint8Array(Math.min(length, READ_MAX)), write: () => refuse('ENOSPC') }
  const random: SynthStream = {
    kind: 'stream',
    mode: 0o444,
    read(length) {
      if (entropy === null) refuse('EIO', 'this machine has no random source')
      const out = new Uint8Array(Math.min(length, READ_MAX))
      entropy(out)
      return out
    },
    write: () => refuse('EACCES'),
  }
  const tty: SynthStream = {
    kind: 'stream',
    read(length) {
      // Whoever reads here reads the keyboard as the terminal would give it: nothing unless a line is waiting.
      const proc = kernel.current
      if (proc === null || proc.pgid !== kernel.tty.foreground) return EMPTY
      return kernel.tty.take(length) ?? EMPTY
    },
    write(data) {
      kernel.tty.write('out', data)
      return data.length
    },
  }
  return dir({ null: nothing, zero, full, random, urandom: random, tty })
}
