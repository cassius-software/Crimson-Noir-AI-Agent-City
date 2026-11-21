// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the terminal as the programs see it: the one place where bytes written by a
 * program become lines the console can show, and where a line the person typed becomes bytes a program can read.
 * Going out, it puts UTF-8 back together across writes, assembles lines (a carriage return goes back to the first
 * column, a tab moves to the next eighth, colour and cursor sequences are dropped until a later slice draws them),
 * keeps ordinary output and error output apart so the console can colour them, and bounds everything: a line is cut
 * at LINE_MAX and only the newest EVENTS_MAX lines are kept if nobody collects them. Coming in, it queues typed
 * lines and hands one line to each read; only the foreground group may read, so a job left in the background is
 * told the input has ended instead of stealing a line meant for another.
 * What breaks if it is removed? Programs have no screen and no keyboard: only files and pipes.
 */
import { EMPTY, encode } from './bytes.ts'

/** What the host collects: a finished line of output, or something a program posted for the host itself. */
export type TtyEvent =
  | { readonly kind: 'out' | 'err'; readonly text: string }
  | { readonly kind: 'post'; readonly payload: unknown }

/** The longest line, in characters: a longer one is cut into several. */
export const LINE_MAX = 2048
/** The most uncollected lines kept: older ones are dropped and counted. */
export const EVENTS_MAX = 4000
/** The most typed lines waiting to be read. */
export const INPUT_MAX = 256

type Stream = 'out' | 'err'

export class Tty {
  private events: TtyEvent[] = []
  /** Lines (not posts) in `events`, and how many of the oldest of them are dropped but not yet taken out. */
  private lines = 0
  private stale = 0
  /** The line being assembled, a character in each cell, and the column the next character goes to. */
  private cells: string[] = []
  private col = 0
  private open: Stream | null = null
  private readonly decoders = { out: new TextDecoder('utf-8'), err: new TextDecoder('utf-8') }
  /**
   * Where each stream's escape sequence stands: 0 none, 1 after ESC, 2 inside CSI, 3 inside an OSC string, 4 OSC
   * after ESC. Each stream has its own, so one stream's half-written sequence never eats the other's characters.
   */
  private readonly escape = { out: 0, err: 0 }
  /** Lines dropped because nobody collected them. */
  dropped = 0
  /** Typed lines not yet read, each ending in a line feed; null marks an end of input (Ctrl+D). */
  private input: (Uint8Array | null)[] = []
  /** The group whose tasks may read. */
  foreground = 0
  /** Tasks waiting for a typed line, by number. */
  readonly readers = new Set<number>()
  /** What the console shows before the next typed line: set by whoever is about to read. */
  prompt = ''
  /** Whether that reader is in the middle of a command it needs more lines for (so the next line is its, whatever it says). */
  continuing = false
  /** Whether the next line is the reply the shell's own `read` waits for, not a command: the console keeps it out of its history. */
  reply = false

  /** A program's bytes on the way to the screen. */
  write(stream: Stream, bytes: Uint8Array): void {
    if (this.open !== null && this.open !== stream) this.flush()
    const text = this.decoders[stream].decode(bytes, { stream: true })
    for (const ch of text) this.put(stream, ch)
  }

  private put(stream: Stream, ch: string): void {
    const code = ch.codePointAt(0) ?? 0
    const at = this.escape[stream]
    // A line feed ends any sequence and is still a line end, so a sequence left open never hides the lines after it.
    if (at !== 0 && code !== 10) {
      // ESC [ ... final byte, or ESC ] ... BEL / ESC \, or ESC and one more character.
      if (at === 1) this.escape[stream] = ch === '[' ? 2 : ch === ']' ? 3 : 0
      else if (at === 2) { if (code >= 0x40 && code <= 0x7e) this.escape[stream] = 0 }
      else if (at === 3) { if (code === 7) this.escape[stream] = 0; else if (code === 27) this.escape[stream] = 4 }
      else this.escape[stream] = 0
      return
    }
    this.escape[stream] = 0
    if (code === 10) { this.open = stream; this.flush(); return }
    if (code === 13) { this.col = 0; return }
    if (code === 27) { this.escape[stream] = 1; return }
    if (code === 8) { if (this.col > 0) this.col--; return }
    if (code === 9) {
      // To the next eighth, never past the longest line (a tab at its end stays there), moving over what is there.
      const to = Math.min((Math.floor(this.col / 8) + 1) * 8, LINE_MAX)
      while (this.col < to) {
        if (this.col < this.cells.length) this.col++
        else this.cell(stream, ' ')
      }
      return
    }
    // The other control characters, the second set (128 to 159) as well as the first, are dropped too.
    if (code < 32 || (code >= 127 && code < 160)) return
    this.cell(stream, ch)
  }

  private cell(stream: Stream, ch: string): void {
    if (this.col >= LINE_MAX) { this.open = stream; this.flush() }
    this.open = stream
    while (this.cells.length < this.col) this.cells.push(' ')
    this.cells[this.col++] = ch
  }

  /** Ends the line being assembled, if any, so the host can collect it. */
  flush(): void {
    if (this.open === null) return
    this.push({ kind: this.open, text: this.cells.join('') })
    this.cells = []
    this.col = 0
    this.open = null
  }

  /** Something for the host itself, kept in order with the lines around it. */
  post(payload: unknown): void {
    this.flush()
    this.events.push({ kind: 'post', payload })
  }

  private push(event: TtyEvent): void {
    this.events.push(event)
    if (event.kind !== 'post') this.lines++
    if (this.events.length - this.stale > EVENTS_MAX && this.lines > this.stale) {
      // Drop the oldest line; something posted for the host is never dropped. A dropped line is only counted here
      // and taken out with the others in one pass now and then: one at a time, a flood of lines would cost the
      // whole kept list for every line.
      this.stale++
      this.dropped++
      if (this.stale >= EVENTS_MAX) this.prune()
    }
  }

  /** Takes the dropped lines (the oldest `stale` lines) out of the list. */
  private prune(): void {
    if (this.stale === 0) return
    let skip = this.stale
    const kept: TtyEvent[] = []
    for (const e of this.events) {
      if (skip > 0 && e.kind !== 'post') skip--
      else kept.push(e)
    }
    this.events = kept
    this.lines -= this.stale
    this.stale = 0
  }

  /** Everything finished since the last call, oldest first. A line still being assembled stays. */
  drain(): TtyEvent[] {
    this.prune()
    if (this.events.length === 0) return []
    const out = this.events
    this.events = []
    this.lines = 0
    return out
  }

  /** Whether anything waits to be collected. */
  get pending(): boolean { return this.events.length > this.stale }

  /** What the person typed: one or more lines; a text that does not end in a line feed is given one. False when the queue is full. */
  feed(text: string): boolean {
    const lines = text.split('\n')
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
    if (this.input.length + lines.length > INPUT_MAX) return false
    for (const line of lines) this.input.push(encode(`${line}\n`))
    return true
  }

  /** The person ended the input (Ctrl+D on an empty line). */
  end(): void {
    if (this.input.length < INPUT_MAX) this.input.push(null)
  }

  /** Forgets what was typed and not yet read. */
  forget(): void { this.input = [] }

  /** Whether a typed line (or an end of input) waits. */
  get typed(): boolean { return this.input.length > 0 }

  /** Up to `length` bytes of the next typed line; no bytes at an end of input; null when nothing was typed yet. */
  take(length: number): Uint8Array | null {
    if (this.input.length === 0) return null
    const first = this.input[0]
    if (first === null) { this.input.shift(); return EMPTY }
    if (first.length <= length) { this.input.shift(); return first }
    this.input[0] = first.subarray(length)
    return first.subarray(0, length)
  }
}
