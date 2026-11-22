// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the console's path arithmetic: it turns whatever a person or a program typed
 * ("../a//b/.", "notes.txt") into one absolute, canonical path against a working directory, splits a path into its
 * names, and matches one name against a shell pattern (`*`, `?`, `[a-z]`). The file system has no links, so
 * resolving `.` and `..` on the text alone is exact: no path can step out of a mounted folder by its spelling,
 * because every path is made canonical here before any driver sees a name. Limits are refused by name: a name is at
 * most NAME_MAX characters (UTF-16 units), a path PATH_MAX, and at most DEPTH_MAX names deep.
 * What breaks if it is removed? Every caller would resolve paths its own way, and `..` or a doubled slash would
 * mean different things to the shell, the kernel and a mounted drive.
 */
import { refuse } from './errno.ts'

/** The longest single name, in UTF-16 units (a driver that stores it may check it again). */
export const NAME_MAX = 255
/** The longest path, in UTF-16 units. */
export const PATH_MAX = 4096
/** The most names deep a canonical path may be. */
export const DEPTH_MAX = 64

/** Whether a single name may be stored: not empty, not `.` or `..`, no slash, no NUL, within NAME_MAX. */
export function validName(name: string): boolean {
  return name.length > 0 && name.length <= NAME_MAX && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\0')
}

/**
 * The names of the absolute, canonical form of `path` taken against `cwd` (itself absolute): no empty name, no `.`,
 * no `..` (one above the root stays at the root). Refuses a path that is empty, too long (as typed or once made
 * canonical), too deep, or holds a NUL or an over-long name.
 */
export function parts(path: string, cwd = '/'): string[] {
  if (path.length === 0) refuse('ENOENT')
  if (path.length > PATH_MAX || cwd.length > PATH_MAX) refuse('ENAMETOOLONG')
  if (path.includes('\0')) refuse('EINVAL', 'a path cannot hold a NUL')
  const out: string[] = []
  const feed = (text: string): void => {
    for (const name of text.split('/')) {
      if (name === '' || name === '.') continue
      if (name === '..') { out.pop(); continue }
      if (name.length > NAME_MAX) refuse('ENAMETOOLONG')
      out.push(name)
    }
  }
  if (!path.startsWith('/')) feed(cwd)
  feed(path)
  if (out.length > DEPTH_MAX) refuse('ENAMETOOLONG', `a path is at most ${DEPTH_MAX} names deep`)
  // The canonical form must fit too, or a directory could be made and entered that no path could name again.
  let length = 0
  for (const name of out) length += name.length + 1
  if (length > PATH_MAX) refuse('ENAMETOOLONG')
  return out
}

/** The absolute, canonical form of `path` against `cwd`: `/a/b`, or `/` for the root. */
export function normalize(path: string, cwd = '/'): string {
  return `/${parts(path, cwd).join('/')}`
}

/** The canonical path of a list of names. */
export const fromParts = (names: readonly string[]): string => `/${names.join('/')}`

/** The last name of a path as typed (`/a/b/` gives `b`, `/` gives `/`, `x` gives `x`). */
export function basename(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  const cut = path.lastIndexOf('/', end - 1)
  if (end === 1 && path[0] === '/') return '/'
  return path.slice(cut + 1, end)
}

/** Everything before the last name of a path as typed (`/a/b` gives `/a`, `b` gives `.`, `/b` gives `/`). */
export function dirname(path: string): string {
  let end = path.length
  while (end > 1 && path[end - 1] === '/') end--
  const cut = path.lastIndexOf('/', end - 1)
  if (cut < 0) return '.'
  if (cut === 0) return '/'
  let stop = cut
  while (stop > 1 && path[stop - 1] === '/') stop--
  return path.slice(0, stop)
}

/** `dir` and `name` as one path, with exactly one slash between them. */
export function join(dir: string, name: string): string {
  if (dir === '') return name
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`
}

/** Whether `text` holds a pattern character that is not escaped by a backslash. */
export function hasPattern(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '\\') { i++; continue }
    if (c === '*' || c === '?' || c === '[') return true
  }
  return false
}

/** One parsed bracket set `[...]`: where it ends in the pattern, and whether `ch` is in it. A set that never closes is null. */
function bracket(pattern: string, at: number, ch: string): { end: number; hit: boolean } | null {
  let i = at + 1
  let negate = false
  if (pattern[i] === '!' || pattern[i] === '^') { negate = true; i++ }
  let hit = false
  let first = true
  for (;;) {
    if (i >= pattern.length) return null
    let lo = pattern[i]
    if (lo === ']' && !first) break
    first = false
    if (lo === '\\' && i + 1 < pattern.length) { i++; lo = pattern[i] }
    i++
    if (pattern[i] === '-' && i + 1 < pattern.length && pattern[i + 1] !== ']') {
      let hi = pattern[i + 1]
      i += 2
      if (hi === '\\' && i < pattern.length) { hi = pattern[i]; i++ }
      if (ch >= lo && ch <= hi) hit = true
    } else if (ch === lo) hit = true
  }
  return { end: i + 1, hit: hit !== negate }
}

/**
 * Whether `name` matches the shell pattern: `*` any run of characters, `?` any one, `[a-z]` a set (`[!...]` its
 * complement), a backslash making the next character literal. A name that starts with a dot is matched only by a
 * pattern that starts with one, so `*` never lists hidden names; with `dots` the text is no file name and a leading
 * dot is a character like any other. Linear in name times pattern: the star retries from one remembered position,
 * never a tree of them.
 */
export function matches(pattern: string, name: string, dots = false): boolean {
  if (!dots && name.startsWith('.') && !pattern.startsWith('.')) return false
  let p = 0
  let n = 0
  let starP = -1
  let starN = 0
  while (n < name.length) {
    const pc = pattern[p]
    let step = false
    if (pc === '*') {
      starP = p
      starN = n
      p++
      continue
    }
    if (pc === '?') { p++; n++; step = true }
    else if (pc === '[') {
      const set = bracket(pattern, p, name[n])
      if (set === null) {
        if (name[n] === '[') { p++; n++; step = true }
      } else if (set.hit) { p = set.end; n++; step = true }
    } else if (pc === '\\' && p + 1 < pattern.length) {
      if (pattern[p + 1] === name[n]) { p += 2; n++; step = true }
    } else if (pc !== undefined && pc === name[n]) { p++; n++; step = true }
    if (step) continue
    if (starP < 0) return false
    p = starP + 1
    starN++
    n = starN
  }
  while (pattern[p] === '*') p++
  return p === pattern.length
}
