// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? A file is bytes and a console is text, and this is the one place the two meet: UTF-8
 * both ways (through the platform's own TextEncoder and TextDecoder, which are pure functions of their input: an
 * ill-formed sequence decodes to U+FFFD and never throws), base64 both ways for the saved image of the disk, hex for
 * a digest, joining byte arrays, and splitting text into lines the way every text program here does. Nothing in it
 * reads a clock, a random source or any state.
 * What breaks if it is removed? Each program would convert text its own way, and a file written by one could read
 * back differently in another.
 */
import { refuse } from './errno.ts'

const ENCODER = new TextEncoder()
const DECODER = new TextDecoder('utf-8', { fatal: false })

/** No bytes at all (shared, never written). */
export const EMPTY: Uint8Array = new Uint8Array(0)

/** The UTF-8 bytes of `text` (a lone surrogate becomes U+FFFD, as the platform encodes it). */
export function encode(text: string): Uint8Array {
  return ENCODER.encode(text)
}

/** The text of UTF-8 `bytes`; ill-formed input gives U+FFFD, never an error. */
export function decode(bytes: Uint8Array): string {
  return DECODER.decode(bytes)
}

/** The arrays end to end in one new array. */
export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) { out.set(c, at); at += c.length }
  return out
}

const HEX = '0123456789abcdef'

/** Lower-case hex, two digits a byte. */
export function hex(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    s += HEX[b >> 4]! + HEX[b & 15]!
  }
  return s
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_VALUE: Int16Array = (() => {
  const t = new Int16Array(128).fill(-1)
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i
  return t
})()

/** Standard base64 with padding. */
export function toBase64(bytes: Uint8Array): string {
  const parts: string[] = []
  let s = ''
  const n = bytes.length
  for (let i = 0; i < n; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < n ? bytes[i + 1]! : 0
    const c = i + 2 < n ? bytes[i + 2]! : 0
    s += B64[a >> 2]! + B64[((a & 3) << 4) | (b >> 4)]! + (i + 1 < n ? B64[((b & 15) << 2) | (c >> 6)]! : '=') + (i + 2 < n ? B64[c & 63]! : '=')
    if (s.length >= 8192) { parts.push(s); s = '' }
  }
  parts.push(s)
  return parts.join('')
}

/**
 * The bytes of standard base64 text (blanks and line ends are skipped). Refuses, as EINVAL, a character outside the
 * alphabet, padding anywhere but the end, or a length that is no whole number of bytes.
 */
export function fromBase64(text: string): Uint8Array {
  const digits: number[] = []
  let pad = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (code === 32 || code === 9 || code === 10 || code === 13) continue
    if (code === 61) { pad++; continue }
    const v = code < 128 ? B64_VALUE[code]! : -1
    if (v < 0 || pad > 0) refuse('EINVAL', 'not base64')
    digits.push(v)
  }
  const rem = digits.length & 3
  if (rem === 1 || pad > 2 || (pad > 0 && ((digits.length + pad) & 3) !== 0)) refuse('EINVAL', 'not base64')
  const out = new Uint8Array((digits.length >> 2) * 3 + (rem === 0 ? 0 : rem - 1))
  let at = 0
  for (let i = 0; i < digits.length; i += 4) {
    const a = digits[i]!
    const b = digits[i + 1] ?? 0
    const c = digits[i + 2] ?? 0
    const d = digits[i + 3] ?? 0
    const word = (a << 18) | (b << 12) | (c << 6) | d
    if (at < out.length) out[at++] = (word >> 16) & 255
    if (at < out.length) out[at++] = (word >> 8) & 255
    if (at < out.length) out[at++] = word & 255
  }
  return out
}

/**
 * The lines of a text: split at each line feed, a carriage return before it dropped, and no empty last line for a
 * text that ends with a line feed (so "a\nb\n" and "a\nb" are both two lines, and "" is none).
 */
export function linesOf(text: string): string[] {
  if (text.length === 0) return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    if (l.endsWith('\r')) lines[i] = l.slice(0, -1)
  }
  return lines
}

/** A 32-bit unsigned integer, little-endian, at `at`. */
export function readU32(bytes: Uint8Array, at: number): number {
  return (bytes[at]! | (bytes[at + 1]! << 8) | (bytes[at + 2]! << 16) | (bytes[at + 3]! << 24)) >>> 0
}

/** Writes a 32-bit unsigned integer, little-endian, at `at`. */
export function writeU32(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 255
  bytes[at + 1] = (value >>> 8) & 255
  bytes[at + 2] = (value >>> 16) & 255
  bytes[at + 3] = (value >>> 24) & 255
}
