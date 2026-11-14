// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the pipe: what `a | b` puts between two programs. One side writes bytes, the other
 * reads them in order, and it holds at most PIPE_MAX of them, so a fast writer waits for a slow reader instead of
 * filling memory. It counts its two sides: when the last writer closes, a reader that finds it empty is told the end
 * has come; when the last reader closes, a writer is refused (EPIPE), which is how `seq 1 1000000 | head -1` stops.
 * A write of PIPE_ATOMIC bytes or fewer goes in whole or waits, so two writers' lines never interleave mid-line.
 * What breaks if it is removed? Programs cannot be joined: every one would read files and write to the screen only.
 */
import { EMPTY } from './bytes.ts'
import { refuse } from './errno.ts'
import type { Task } from './task.ts'

/** The most bytes a pipe holds. */
export const PIPE_MAX = 65536
/** A write this long or shorter is never split. */
export const PIPE_ATOMIC = 4096

export class Pipe {
  readonly id: number
  private chunks: Uint8Array[] = []
  /** Bytes of the first chunk already read. */
  private head = 0
  size = 0
  readers = 0
  writers = 0

  constructor(id: number) {
    this.id = id
  }

  /** Up to `length` bytes, in order; waits while the pipe is empty and someone may still write; none at the end. */
  *read(length: number): Task<Uint8Array> {
    if (length <= 0) return EMPTY
    while (this.size === 0) {
      if (this.writers === 0) return EMPTY
      yield { why: 'pipe', ready: () => this.size > 0 || this.writers === 0 }
    }
    const first = this.chunks[0]
    const take = Math.min(length, first.length - this.head)
    const out = first.slice(this.head, this.head + take)
    this.head += take
    this.size -= take
    if (this.head === first.length) {
      this.chunks.shift()
      this.head = 0
    }
    return out
  }

  /** Writes all of `data`, waiting for room; EPIPE once nobody is left to read. */
  *write(data: Uint8Array): Task<number> {
    let done = 0
    while (done < data.length) {
      if (this.readers === 0) refuse('EPIPE')
      const left = data.length - done
      const need = data.length <= PIPE_ATOMIC ? left : 1
      const room = PIPE_MAX - this.size
      if (room < need) {
        yield { why: 'pipe', ready: () => PIPE_MAX - this.size >= need || this.readers === 0 }
        continue
      }
      const take = Math.min(left, room)
      // A copy: the writer may reuse its array.
      this.chunks.push(data.slice(done, done + take))
      this.size += take
      done += take
    }
    return done
  }
}
