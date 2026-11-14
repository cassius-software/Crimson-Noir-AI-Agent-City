// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the city as files, for the console's operating layer (os/): the readings under
 * /proc/city (what `stats`, `laws`, `kernel`, `hardware`, `rooms` and `lanes` print, the unified namespace as a tree
 * of one small file per topic, the crowd's and the cars' columns as rows of numbers) and the knobs under /sys/city
 * (the clock, the quality tier, the sound, the view switches, and, while the operator tier is unlocked, every tuning
 * key). Nothing here is a second way into the city: a reading is the console command's own lines, made when the
 * file is read, and a write runs the same command with the value written, through the same handler, the same checks
 * and the same tier locks, so `echo 18:30 > /sys/city/time` is `time 18:30` and is refused exactly when that is. A
 * file read or written earns no check (the progression counts commands typed, not files touched). It imports the
 * bridge as a type only and reaches the city through what commands.ts hands it.
 * What breaks if it is removed? /proc/city and /sys/city are gone: the shell's programs can no longer read the city
 * (`grep`, `sort` and `head` over its readings) and a script can no longer set a knob by writing a file.
 */
import type { SoaBridge, TerminalBridge } from './bridge.ts'
import { OsError, dir, knob, text } from './os/index.ts'
import type { SynthDir, SynthNode } from './os/index.ts'

/** What this file needs of the console (commands.ts builds it over its own command table). */
export interface CityConsole {
  /** The bridge as it is now (the terminal can be handed another between two lines). */
  bridge(): TerminalBridge
  /** Runs one of the console's own commands now, without the check it could earn, and gives its lines; a handler that throws answers with an error line. */
  command(name: string, args: readonly string[]): readonly { readonly kind: string; readonly text: string }[]
  /** The tuning keys (`physics.<key>`, `shaders.<key>`) with their values while the operator tier is unlocked; null while it is locked or the tables do not read. */
  tuning(): readonly (readonly [string, string])[] | null
}

/** The manual page for these files (`man city`): the console adds it to the layer's own pages. */
export const CITY_MANUAL: Readonly<Record<string, string>> = Object.freeze({
  city: `NAME
    city - the city as files: readings under /proc/city, knobs under /sys/city

USAGE
    cat /proc/city/NAME
    echo VALUE > /sys/city/NAME

WHAT IT DOES
    Every file here is one of the console's own commands seen as a file.
    Reading one runs the command and gives its lines; writing one runs
    the command with what was written. Nothing here is a second way in:
    a write is checked, and refused, exactly as the command would be.
    Reading or writing a file earns no check.

READINGS (/proc/city, read-only)
    stats      what stats --once prints
    laws       the laws, as laws prints them
    kernel     interventions per law, as kernel prints them
    hardware   the machine the city sized itself for
    rooms      the indoor workplaces of this map
    lanes      the team at work
    version    the product version
    crowd      one line per person: x z, in city metres
    cars       one line per car: x z heading speed mode
    frame      fps, frame time and its 95th percentile, one per line
    topics/    the unified namespace as a tree: a directory per level,
               a file per topic that holds its value
    /proc/cpuinfo and /proc/meminfo say what the browser tells the
    page about the machine (threads, class, graphics adapter; memory
    only where the browser says, and never more than 8 GiB).

    crowd and cars print at most 16384 rows; when there are more, a last
    line that starts with # says how many were left out.

KNOBS (/sys/city, read and write)
    time       the city clock: echo 18:30 > /sys/city/time
    quality    the render tier: auto, lite, peak, or -1 to 5
    audio      the soundscape: on, off, or 0 to 100
    ghost  rain  render  captions  haptics      on or off
    operator   whether the operator tier is unlocked (read-only)
    physics/ shaders/   one file per tuning key, listed only while the
               operator tier is unlocked (operator unlock); writing one
               is set physics.KEY VALUE

NOTES
    On the console alone (boot tty) there is no city: most readings
    then say so when read. A reading is made at the moment it is read;
    two reads can differ.

EXAMPLE
    sort -n /proc/city/crowd | head -n 5
    echo off > /sys/city/rain
`,
})

/** The most rows a column file prints: more are counted in a last line that starts with `#`, never cut in silence. */
export const ROWS_MAX = 16384

/** A command's lines as a file's text; its first error line as a refusal, in the command's own words. */
function said(c: CityConsole, errno: 'EIO' | 'EINVAL', name: string, args: readonly string[]): string {
  const lines = c.command(name, args)
  const bad = lines.find((l) => l.kind === 'err')
  if (bad !== undefined) throw new OsError(errno, bad.text)
  let out = ''
  for (const l of lines) out += `${l.text}\n`
  return out
}

/** A read-only file that reads as a console command prints. */
const reading = (c: CityConsole, name: string, ...args: string[]): SynthNode => text(() => said(c, 'EIO', name, args))

/** A file that reads as the command's status and takes the command's argument when written. */
const setting = (c: CityConsole, name: string): SynthNode => knob(
  () => said(c, 'EIO', name, []),
  (value) => {
    const args = value.split(/\s+/).filter((w) => w !== '')
    if (args.length === 0) throw new OsError('EINVAL', `${name}: a value is needed`)
    said(c, 'EINVAL', name, args)
  },
)

/** Why a reading is not there on this host: the console alone keeps no city. */
function absent(b: TerminalBridge): never {
  throw new OsError('ENOSYS', b.brand.track === 'tty' ? 'kept by the city: boot gui to see it' : 'not available on this page')
}

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** A number as a column prints it: two decimals, a value that is not a number as 0. */
const cell = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '0.00')

/** Rows of numbers, one row per line, the cells of a row separated by one blank. */
function rows(n: number, row: (i: number) => string): string {
  const shown = Math.max(0, Math.min(n, ROWS_MAX))
  let out = ''
  for (let i = 0; i < shown; i++) out += `${row(i)}\n`
  if (n > shown) out += `# ${n - shown} more rows not shown\n`
  return out
}

/** The city's columns as the bridge copies them out (the same copies NoirScript reads). */
function tables(c: CityConsole): ReturnType<SoaBridge['tables']> {
  const b = c.bridge()
  if (!b.soa) absent(b)
  try {
    return b.soa.tables()
  } catch (e) {
    throw new OsError('EIO', words(e))
  }
}

/** One retained topic: its levels under the root, and its value as the console prints it. */
interface Topic { readonly path: readonly string[]; readonly value: string }

/** Every retained topic, from the rows the bridge formats (`~/a/b/c  value`); none on a host that publishes none. */
function topics(c: CityConsole): Topic[] {
  const t = c.bridge().topics
  if (!t) return []
  let list: readonly string[]
  try {
    list = t.list()
  } catch {
    return []
  }
  const out: Topic[] = []
  for (const row of list) {
    const at = row.indexOf('  ')
    if (at <= 0) continue
    const name = row.slice(0, at)
    const path = (name.startsWith('~/') ? name.slice(2) : name).split('/')
    // A level that could not be a file name here is left out rather than renamed.
    if (path.some((p) => p === '' || p === '.' || p === '..')) continue
    out.push({ path, value: row.slice(at + 2) })
  }
  return out
}

/** The namespace as a directory: a level is a directory, a topic is a file that holds its value. */
function topicDir(c: CityConsole, prefix: readonly string[]): SynthDir {
  const under = (t: Topic): boolean => t.path.length > prefix.length && prefix.every((p, i) => t.path[i] === p)
  return {
    kind: 'dir',
    names() {
      const names = new Set<string>()
      for (const t of topics(c)) if (under(t)) names.add(t.path[prefix.length])
      return [...names].sort()
    },
    child(name) {
      let leaf = false
      let more = false
      for (const t of topics(c)) {
        if (!under(t) || t.path[prefix.length] !== name) continue
        if (t.path.length === prefix.length + 1) leaf = true
        else more = true
      }
      if (more) return topicDir(c, [...prefix, name])
      if (!leaf) return null
      const path = [...prefix, name]
      return text(() => {
        const hit = topics(c).find((t) => t.path.length === path.length && path.every((p, i) => t.path[i] === p))
        if (hit === undefined) throw new OsError('ENOENT')
        return `${hit.value}\n`
      })
    },
  }
}

/** One table of tuning keys as a directory (`physics`, `shaders`): empty while the operator tier is locked. */
function tuningDir(c: CityConsole, table: 'physics' | 'shaders'): SynthDir {
  const head = `${table}.`
  const keys = (): string[] => (c.tuning() ?? []).filter(([k]) => k.startsWith(head)).map(([k]) => k.slice(head.length)).filter((k) => k !== '' && !k.includes('/') && k !== '.' && k !== '..')
  return {
    kind: 'dir',
    names: () => keys().sort(),
    child(key) {
      if (!keys().includes(key)) return null
      return knob(
        () => {
          const hit = (c.tuning() ?? []).find(([k]) => k === head + key)
          if (hit === undefined) throw new OsError('EACCES', "locked; type 'operator unlock' first")
          return `${hit[1]}\n`
        },
        (value) => { said(c, 'EINVAL', 'set', [head + key, value]) },
      )
    },
  }
}

/** What the machine is, as far as the page knows: a few `name value` lines. */
function machine(c: CityConsole, what: 'cpu' | 'memory'): string {
  let h: ReturnType<TerminalBridge['hardware']>
  try {
    h = c.bridge().hardware()
  } catch (e) {
    throw new OsError('EIO', words(e))
  }
  if (what === 'cpu') {
    return [
      `threads   ${h.cores === undefined ? 'unknown (this browser does not say)' : String(h.cores)}`,
      `class     ${h.class}`,
      `graphics  ${h.adapter}`,
      `host      ${h.host}`,
    ].join('\n') + '\n'
  }
  // The browser rounds what it says and never says more than 8.
  return `memory    ${h.memoryGb === undefined ? 'unknown (this browser does not say)' : h.memoryGb >= 8 ? '8 GiB or more' : `about ${h.memoryGb} GiB`}\n`
}

/** The host's files: what goes under /proc and under /sys beside the kernel's own. */
export function cityFiles(c: CityConsole): { readonly proc: Readonly<Record<string, SynthNode>>; readonly sys: Readonly<Record<string, SynthNode>> } {
  const city = dir({
    stats: reading(c, 'stats', '--once'),
    laws: reading(c, 'laws'),
    kernel: reading(c, 'kernel'),
    hardware: reading(c, 'hardware'),
    rooms: reading(c, 'rooms'),
    lanes: reading(c, 'lanes'),
    version: reading(c, 'version'),
    crowd: text(() => {
      const t = tables(c).crowd
      return rows(t.n, (i) => `${cell(t.x[i])} ${cell(t.z[i])}`)
    }),
    cars: text(() => {
      const t = tables(c).cars
      return rows(t.n, (i) => `${cell(t.x[i])} ${cell(t.z[i])} ${cell(t.heading[i])} ${cell(t.speed[i])} ${String(t.mode[i] ?? 0)}`)
    }),
    frame: text(() => {
      const f = tables(c).frame
      return `fps ${cell(f.fps)}\nms ${cell(f.ms)}\np95 ${cell(f.p95)}\n`
    }),
    topics: topicDir(c, []),
  })
  const knobs = dir({
    time: setting(c, 'time'),
    quality: setting(c, 'quality'),
    audio: setting(c, 'audio'),
    ghost: setting(c, 'ghost'),
    rain: setting(c, 'rain'),
    render: setting(c, 'render'),
    captions: setting(c, 'captions'),
    haptics: setting(c, 'haptics'),
    operator: reading(c, 'operator', 'status'),
    physics: tuningDir(c, 'physics'),
    shaders: tuningDir(c, 'shaders'),
  })
  return {
    proc: { city, cpuinfo: text(() => machine(c, 'cpu')), meminfo: text(() => machine(c, 'memory')) },
    sys: { city: knobs },
  }
}
