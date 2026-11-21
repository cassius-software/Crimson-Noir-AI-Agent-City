// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the console to what the operating layer (os/) promised it: with no host the
 * console is its command table alone, to the letter; with one, a console command typed alone still runs exactly as
 * it did, everything else is the shell's, the shell runs a console command inside a pipe or a list through the same
 * handler and tier locks (earning no check of its own: the line earns, once), the city reads as files under
 * /proc/city and its knobs take a write under /sys/city with the command's own checks, a line typed while a program
 * reads the terminal is that program's, Ctrl+C gives the prompt back, Tab gives back names the shell reads as typed,
 * and the disk comes back on the next visit, is never written over by a page that fell behind, loses no change to a
 * save that failed or was asked for during another, is said not to be kept as soon as that is so, and is set aside
 * rather than lost when it fails its check. It also holds that a proposal is answered only at the prompt, that a loop
 * drives the city no faster than CITY_TURN_MAX commands a turn, that a secret the shell hands a command is recorded for
 * the history, and that a save is sealed by the host's digest, or at once as the page goes, and never throws.
 * What breaks if it is removed? Any of those could change without a test noticing, and the first to notice would be
 * someone whose files were gone.
 */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { offlineBridge, type ActEnd, type ActsBridge, type PendingAct, type TerminalBridge } from './bridge.ts'
import { CITY_TURN_MAX, LINE_MS, completeLine, complete, redactForHistory, replSession, run, scrubSecrets, type CommandResult, type DiskStore, type OsHost, type OsSession, type ReplSession } from './commands.ts'

const BRAND = { name: 'TESTBRAND', version: '9.8.7', host: 'testhost' }

interface City extends TerminalBridge {
  calls: string[]
  unlocked: boolean
  earned: string[]
  /** Whether a finished shell line pays its check (only the test of checks turns it on, so other tests read clean output). */
  paying: boolean
}

/** A city small enough to read here: a clock, the rain switch, three topics, two people, one car, two tuning keys. */
function city(): City {
  const calls: string[] = []
  let hours = 12
  let rain = 'off'
  const tuning = { physics: { gravity: 9.81, drag: 0.3 }, shaders: { fog: 0.5 } }
  const off = offlineBridge(BRAND)
  const two = (n: number): string => String(n).padStart(2, '0')
  const c: City = {
    ...off,
    calls,
    unlocked: false,
    earned: [],
    paying: false,
    clock: () => `${two(Math.floor(hours))}:${two(Math.round((hours % 1) * 60))}`,
    setClock: (h) => { hours = h; calls.push(`setClock ${h}`) },
    laws: () => [{ id: 1, title: 'First', text: 'the first law' }, { id: 2, title: 'Second', text: 'the second law' }],
    rain: (arg) => { if (arg) { rain = arg; calls.push(`rain ${arg}`) } return rain },
    topics: {
      list: () => ['~/Area/Core/Line/Traffic/Cell/Lights/phase  green', '~/Area/Core/Line/Crowd/Cell/People/count  412', '~/Namespace/Bus/topics  3'],
      get: () => null, children: () => [], status: () => '3 topics',
    },
    soa: {
      tables: () => ({
        crowd: { n: 2, x: Float32Array.of(1.5, -2), z: Float32Array.of(3, 4.25) },
        cars: { n: 1, x: Float32Array.of(10), z: Float32Array.of(20), heading: Float32Array.of(0.5), speed: Float32Array.of(7), mode: Int32Array.of(2) },
        kernel: { law1: 0, law2: 0, law3: 0, flips: 0, shielded: false },
        frame: { fps: 60, ms: 16.6, p95: 18 },
      }),
    },
    operator: {
      ...off.operator,
      unlocked: () => c.unlocked,
      tuning: () => tuning,
      tune: (table, key, value) => { calls.push(`tune ${table}.${key} ${value}`); (tuning[table] as Record<string, number>)[key] = value; return value },
    },
    progress: {
      status: () => [], table: () => [], train: () => '', reroll: () => [], reset: () => '',
      command: (name, args) => {
        c.earned.push(`${name} ${args.join(' ')}`)
        if (!c.paying) return []
        return name === 'sh' ? ['check: Computers'] : name === 'rain' || name === 'time' ? ['check: Optics'] : []
      },
    },
  }
  return c
}

/** A host on a clock the test moves; `disk` when the test keeps one. */
function host(disk: DiskStore | null = null): OsHost & { t: number } {
  const h = { brand: BRAND, t: 0, clock: () => h.t, wall: () => 1794679200000 + h.t, disk }
  return h
}

const texts = (r: CommandResult): string[] => r.lines.map((l) => (l.kind === 'err' ? `!${l.text}` : l.text))
const osOf = (s: ReplSession): OsSession => {
  assert.ok(s.os, 'the session runs the operating layer')
  return s.os
}
/** Everything a line printed: its result, then whatever else the layer had queued. */
function all(line: string, b: TerminalBridge, s: ReplSession): string[] {
  const out = texts(run(line, b, [], s))
  const os = osOf(s)
  for (let r = os.next(); r !== null; r = os.next()) out.push(...texts(r))
  return out
}
/** Lets promises settle (a saved disk arriving, a save answering), then gives the layer a turn. */
async function settle(s: ReplSession): Promise<string[]> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
  const os = osOf(s)
  os.pump(LINE_MS)
  const out: string[] = []
  for (let r = os.next(); r !== null; r = os.next()) out.push(...texts(r))
  return out
}

test('without a host the console is its command table alone: no layer, and a program name is still not found', () => {
  const s = replSession()
  assert.equal(s.os, null)
  const b = city()
  assert.deepEqual(texts(run('ls', b, [], s)), ['!ash: ls: not found'])
  assert.deepEqual(texts(run('time | cat', b, [], s)), ["!usage: time [HH[:MM]]"])
  assert.deepEqual(completeLine('l', s), complete('l'))
  assert.doesNotMatch(texts(run('help', b, [], s)).join('\n'), /man intro/)
})

test('a console command typed alone runs exactly as it does without the layer; help gains one line that points at the manual', () => {
  const b = city()
  const s = replSession(host())
  const bare = replSession()
  for (const line of ['time', 'laws', 'time 25', 'rain on', 'rain', 'whoami', 'version', 'uname -a', 'history', 'quality 9', 'topic', 'stats']) {
    assert.deepEqual(run(line, b, ['x'], s), run(line, b, ['x'], bare), line)
  }
  const help = texts(run('help', b, [], s))
  assert.deepEqual(help.slice(0, -1), texts(run('help', b, [], bare)))
  assert.match(help[help.length - 1], /man intro/)
  // The line was the console's own: nothing was queued behind it.
  assert.equal(osOf(s).next(), null)
})

test('everything else is the shell: programs, pipes, variables; an unknown word is still "not found"', () => {
  const b = city()
  const s = replSession(host())
  assert.deepEqual(all('echo one two | wc -w', b, s), ['2'])
  assert.deepEqual(all('X=5; echo $((X * 2))', b, s), ['10'])
  assert.deepEqual(all('nosuchthing', b, s), ['!ash: nosuchthing: not found'])
  assert.deepEqual(all('echo "it is $(time)"', b, s), ['it is 12:00'])
  assert.deepEqual(all('pwd', b, s), ['/home/operator'])
  assert.equal(osOf(s).prompt, 'testhost:~# ')
  all('cd /tmp', b, s)
  assert.equal(osOf(s).prompt, 'testhost:/tmp# ')
})

test('the shell runs a console command inside a pipe, a list or a redirection through the same handler', () => {
  const b = city()
  const s = replSession(host())
  // Two laws' lines and the ranking note under them say "law".
  assert.deepEqual(all('laws | grep -c law', b, s), ['3'])
  assert.deepEqual(all('time 18:30 && time', b, s), ['18:30', '18:30'])
  assert.deepEqual(b.calls, ['setClock 18.5'])
  assert.deepEqual(all('time 99 || echo refused', b, s), ["!time: invalid time '99'", '!usage: time [HH[:MM]]', 'refused'])
  assert.deepEqual(all('laws > /tmp/laws; wc -l < /tmp/laws', b, s), ['5'])
  // A console command keeps its own reading of its arguments: nothing in them is expanded.
  assert.deepEqual(all('topic list ~/# | wc -l', b, s), ['3'])
  // One that takes the rest of its line whole still does, operators and all.
  assert.deepEqual(texts(run('r0 1 2 + . ; 3 .', b, [], s)), texts(run('r0 1 2 + . ; 3 .', b, [], replSession())))
})

test('a console command inside the shell that clears the screen or draws live reaches the console as its own result, in order', () => {
  const b = city()
  const s = replSession(host())
  const first = run('echo before; clear; echo after', b, [], s)
  assert.deepEqual(texts(first), ['before'])
  const os = osOf(s)
  const second = os.next()
  assert.equal(second?.clear, true)
  assert.deepEqual(texts(os.next() ?? { lines: [] }), ['after'])
  assert.equal(os.next(), null)
})

test('the city reads as files: /proc/city holds what the commands print, the topics as a tree, the columns as rows', () => {
  const b = city()
  const s = replSession(host())
  assert.deepEqual(all('cat /proc/city/laws', b, s), texts(run('laws', city(), [], replSession())))
  // The console is a terminal, so ls lays the names out in columns there.
  assert.deepEqual(all('ls /proc/city/topics', b, s), ['Area  Namespace'])
  assert.deepEqual(all('ls /proc/city/topics | cat', b, s), ['Area', 'Namespace'])
  assert.deepEqual(all('cat /proc/city/topics/Area/Core/Line/Traffic/Cell/Lights/phase', b, s), ['green'])
  assert.deepEqual(all('cat /proc/city/topics/Namespace/Bus/topics', b, s), ['3'])
  assert.deepEqual(all('cat /proc/city/crowd', b, s), ['1.50 3.00', '-2.00 4.25'])
  assert.deepEqual(all('cat /proc/city/cars', b, s), ['10.00 20.00 0.50 7.00 2'])
  assert.deepEqual(all('cat /proc/city/frame', b, s), ['fps 60.00', 'ms 16.60', 'p95 18.00'])
  // A reading the host cannot give says so in the command's own words.
  assert.deepEqual(all('cat /proc/city/stats', b, s), ['!cat: /proc/city/stats: stats: engine not running'])
  assert.deepEqual(all('cat /proc/city/topics/Area/Nowhere', b, s), ['!cat: /proc/city/topics/Area/Nowhere: no such file or directory'])
  // Each line went to the progression as a shell line (which pays nothing without a pipe or a loop); none ran a
  // console command's own check.
  assert.deepEqual(b.earned.filter((e) => !e.startsWith('sh ')), [], 'reading a file earns no command check')
})

test('a knob under /sys/city takes a write through the same command, checks and all', () => {
  const b = city()
  const s = replSession(host())
  assert.deepEqual(all('cat /sys/city/time', b, s), ['12:00'])
  assert.deepEqual(all('echo 21:15 > /sys/city/time; cat /sys/city/time', b, s), ['21:15'])
  assert.deepEqual(b.calls, ['setClock 21.25'])
  const refused = all('echo 99:99 > /sys/city/time; echo $?', b, s)
  assert.match(refused[0], /^!ash: .*time: invalid time '99:99'$/)
  assert.equal(refused[refused.length - 1], '1')
  assert.deepEqual(b.calls, ['setClock 21.25'], 'a refused write reached nothing')
  assert.deepEqual(all('echo on > /sys/city/rain; cat /sys/city/rain', b, s), ['rain on'])
  // The tuning keys are the operator tier's: nothing is listed while it is locked, and each is a file once it is not.
  assert.deepEqual(all('ls /sys/city/physics', b, s), [])
  b.unlocked = true
  assert.deepEqual(all('ls -1 /sys/city/physics', b, s), ['drag', 'gravity'])
  assert.deepEqual(all('cat /sys/city/physics/gravity', b, s), ['9.81'])
  assert.deepEqual(all('echo 3.7 > /sys/city/physics/gravity; cat /sys/city/physics/gravity', b, s), ['3.7'])
  assert.deepEqual(b.calls.slice(-1), ['tune physics.gravity 3.7'])
  b.unlocked = false
  assert.match(all('echo 1 > /sys/city/physics/gravity', b, s)[0], /^!ash: /)
  assert.deepEqual(b.calls.slice(-1), ['tune physics.gravity 3.7'], 'locked again: the write reached nothing')
})

test('the operator tier\'s lock holds inside the shell: a console command in a pipe or a list, and a knob a job writes after the lock', () => {
  const b = city()
  const h = host()
  const s = replSession(h)
  const os = osOf(s)
  assert.deepEqual(all('set physics.gravity 1 | cat', b, s), ["!set: locked; type 'operator unlock' first"])
  assert.deepEqual(all('get physics; echo $?', b, s), ["!get: locked; type 'operator unlock' first", '1'])
  b.unlocked = true
  // A job started while the tier is open writes the knob only after it has locked again: refused, nothing tuned.
  all('{ sleep 1; echo 2 > /sys/city/physics/gravity; echo $?; } &', b, s)
  b.unlocked = false
  h.t += 1000
  os.pump(LINE_MS)
  const later: string[] = []
  for (let r = os.next(); r !== null; r = os.next()) later.push(...texts(r))
  assert.match(later.join('\n'), /^!ash: .*gravity/m)
  assert.equal(later[later.length - 1], '1')
  assert.deepEqual(b.calls.filter((c) => c.startsWith('tune')), [], 'nothing reached the tuning tables')
  // Nor can a file name a key the tier does not list, open or not.
  b.unlocked = true
  assert.match(all('echo 1 > /sys/city/physics/nosuchkey', b, s)[0], /^!ash: /)
  assert.deepEqual(b.calls.filter((c) => c.startsWith('tune')), [])
})

test('a line typed while a program reads the terminal is that program\'s, even when it names a console command', () => {
  const b = city()
  const s = replSession(host())
  const os = osOf(s)
  assert.equal(os.system.feeding, false, 'a command line is not a program\'s input')
  assert.deepEqual(all('cat > /tmp/typed', b, s), [])
  assert.equal(os.system.capturing, true)
  assert.equal(os.system.feeding, true, 'the console keeps it out of its history')
  assert.equal(os.prompt, '')
  assert.deepEqual(all('time 03:00', b, s), [])
  assert.deepEqual(all('rain on', b, s), [])
  assert.deepEqual(b.calls, [], 'neither line reached the city')
  os.system.end()
  os.pump(LINE_MS)
  assert.equal(os.system.capturing, false)
  assert.deepEqual(all('cat /tmp/typed', b, s), ['time 03:00', 'rain on'])
  // A command the shell is still reading the rest of takes the next line too.
  assert.deepEqual(all('for w in a b; do', b, s), [])
  assert.equal(os.prompt, '> ')
  assert.equal(os.system.feeding, false, 'the rest of a command is the shell\'s, not a program\'s input')
  assert.deepEqual(all('echo $w; done', b, s), ['a', 'b'])
  // A program's input keeps its blanks, as typed.
  assert.deepEqual(all('cat > /tmp/indent', b, s), [])
  assert.deepEqual(all('    four in', b, s), [])
  os.system.end()
  os.pump(LINE_MS)
  assert.deepEqual(all("grep -c '^    four in$' /tmp/indent", b, s), ['1'])
})

test('a job that does not read leaves the console its own commands; Ctrl+C ends the job', () => {
  const b = city()
  const h = host()
  const s = replSession(h)
  const os = osOf(s)
  assert.deepEqual(all('sleep 100', b, s), [])
  assert.equal(os.system.capturing, false)
  assert.equal(os.prompt, '')
  // The city still answers at once.
  assert.deepEqual(texts(run('time', b, [], s)), ['12:00'])
  // A line for the shell waits its turn behind the job.
  assert.deepEqual(all('echo later', b, s), [])
  os.system.interrupt()
  os.pump(LINE_MS)
  // Ctrl+C forgets what was typed ahead, as a terminal does.
  assert.equal(os.next(), null)
  assert.equal(os.prompt, 'testhost:~# ')
  assert.deepEqual(all('echo $?', b, s), ['130'])
  // A job in the background goes on as the clock does, and its output arrives when the host gives the layer a turn.
  assert.match(all('(sleep 5; echo woke) &', b, s).join('\n'), /^!?ash: /, 'no subshell parentheses: said, not guessed')
  all('{ sleep 5; echo woke; } &', b, s)
  h.t += 5000
  os.pump(LINE_MS)
  assert.deepEqual(texts(os.next() ?? { lines: [] }), ['woke'])
})

test('the gate: blanks before a console command and an operator inside its quotes leave it the console\'s; a second line makes it the shell\'s', () => {
  const b = city()
  const s = replSession(host())
  const bare = replSession()
  for (const line of ['  time', 'time "18:30 | x"', "rain 'on;'", 'time 18:30 # a note', 'rain on&']) {
    assert.deepEqual(run(line, b, [], s), run(line, b, [], bare), line)
  }
  assert.equal(osOf(s).next(), null, 'nothing went to the shell')
  // A line after it is a second command: the shell runs both, the console command through its handler.
  assert.deepEqual(all('time\necho done', b, s), ['12:00', 'done'])
  // Without a waiting proposal `y` is no word of the console's, so the shell says it is not found.
  assert.deepEqual(all('y', b, s), ['!ash: y: not found'])
})

test('Ctrl+C gives up the wait on a console command that answers later, at the prompt and inside a pipe', () => {
  const b = city()
  b.xr = () => new Promise<string>(() => {})
  const s = replSession(host())
  const os = osOf(s)
  assert.deepEqual(all('echo x; xr vr', b, s), ['x', 'headset: asking the browser...'])
  assert.equal(os.prompt, '', 'the shell waits for the answer')
  assert.equal(os.system.capturing, false)
  os.system.interrupt()
  os.pump(LINE_MS)
  assert.equal(os.prompt, 'testhost:~# ')
  assert.deepEqual(all('echo $?', b, s), ['130'])
  assert.deepEqual(all('xr vr | cat', b, s), ['headset: asking the browser...'])
  assert.equal(os.prompt, '')
  os.system.interrupt()
  os.pump(LINE_MS)
  assert.equal(os.prompt, 'testhost:~# ')
  assert.deepEqual(all('echo $?', b, s), ['130'])
})

test('a console command the shell runs earns no check of its own: only its lines go down a pipe or into a file, and the line earns once', () => {
  const b = city()
  b.paying = true
  const s = replSession(host())
  // Typed alone it is the console's, and earns as it always has.
  assert.deepEqual(all('rain on', b, s), ['rain on', 'check: Optics'])
  assert.deepEqual(all('rain off > /tmp/r; cat /tmp/r', b, s), ['rain off', 'check: Computers'])
  assert.deepEqual(all('rain on | wc -l', b, s), ['1', 'check: Computers'])
  // A loop runs the command three times and is still one line typed.
  assert.deepEqual(all('for h in 1 2 3; do time 10:00; done', b, s), ['10:00', '10:00', '10:00', 'check: Computers'])
  // Straight to the screen, its result is its own and the line's check comes after everything it printed.
  assert.deepEqual(all('echo x; rain off', b, s), ['x', 'rain off', 'check: Computers'])
  // A failed console command in the line: nothing is earned.
  assert.deepEqual(all('time 99; echo y', b, s), ["!time: invalid time '99'", '!usage: time [HH[:MM]]', 'y'])
  assert.deepEqual(b.earned, [
    'rain on', 'sh rain off > /tmp/r; cat /tmp/r', 'sh rain on | wc -l', 'sh for h in 1 2 3; do time 10:00; done', 'sh echo x; rain off',
  ])
})

test('Tab escapes what the shell would read otherwise, so a completed line names that one file; a word just after an operator is a command', () => {
  const b = city()
  const s = replSession(host())
  all('mkdir "/tmp/my dir"; echo inside > "/tmp/my dir/a;b"; echo tilde > /tmp/~t', b, s)
  assert.deepEqual(completeLine('cat /tmp/my', s), ['cat /tmp/my\\ dir/'])
  assert.deepEqual(completeLine('cat /tmp/my\\ dir/', s), ['cat /tmp/my\\ dir/a\\;b'])
  // A word begun in quotes is completed and given back escaped.
  assert.deepEqual(completeLine('cat "/tmp/my dir/a', s), ['cat /tmp/my\\ dir/a\\;b'])
  // Entered as completed, the line reads that file and runs nothing else.
  assert.deepEqual(all(completeLine('cat /tmp/my\\ dir/a', s)[0], b, s), ['inside'])
  assert.deepEqual(all(completeLine('cat /tmp/~', s)[0], b, s), ['tilde'])
  // The home directory is still `~/`.
  assert.deepEqual(completeLine('cat ~/RE', s), ['cat ~/README'])
  assert.deepEqual(completeLine('ls|wc', s), ['ls|wc'])
  assert.deepEqual(completeLine('cd /tmp;pw', s), ['cd /tmp;pwd'])
  assert.deepEqual(completeLine('echo $(pw', s), ['echo $(pwd'])
  assert.deepEqual(completeLine('ls 2>/tmp/my', s), ['ls 2>/tmp/my\\ dir/'])
})

test('Tab: console commands, the shell\'s own and programs where a command goes; the console\'s own arguments; then files', () => {
  const b = city()
  const s = replSession(host())
  const names = completeLine('', s).map((l) => l.trim())
  for (const n of ['stats', 'cd', 'ls', 'cat', 'grep', 'help']) assert.ok(names.includes(n), n)
  assert.deepEqual(completeLine('hal pair ', s), complete('hal pair '))
  assert.deepEqual(completeLine('st', s).filter((l) => l === 'stats' || l === 'stat'), ['stat', 'stats'])
  all('mkdir -p /tmp/work/sub; echo x > /tmp/work/notes.txt', b, s)
  assert.deepEqual(completeLine('cat /tmp/wo', s), ['cat /tmp/work/'])
  assert.deepEqual(completeLine('cat /tmp/work/', s), ['cat /tmp/work/notes.txt', 'cat /tmp/work/sub/'])
  assert.deepEqual(completeLine('ls | gr', s), ['ls | grep'])
  assert.deepEqual(completeLine('cat ~/RE', s), ['cat ~/README'])
})

test('a shell line that puts programs together earns its check once it has finished without an error; one program alone does not', () => {
  const b = city()
  b.paying = true
  const s = replSession(host())
  assert.deepEqual(all('echo a | cat', b, s), ['a', 'check: Computers'])
  assert.deepEqual(b.earned, ['sh echo a | cat'])
  assert.deepEqual(all('ls /nosuch | cat', b, s).filter((l) => l.startsWith('check')), [])
  all('pwd', b, s)
  all('cat > /tmp/x', b, s)
  all('a | b', b, s)
  osOf(s).system.end()
  assert.deepEqual(b.earned, ['sh echo a | cat', 'sh ls /nosuch | cat', 'sh pwd'].filter((_, i) => i !== 1), 'a failed line and a program\'s input earn nothing')
})

/** A store in memory that behaves as the real one is meant to: generations, and failures on request. */
function memoryDisk(): DiskStore & { image: Uint8Array | null; gen: number; aside: Uint8Array[]; fail: boolean; refuseAside: boolean; open(): DiskStore } {
  const shared = {
    image: null as Uint8Array | null, gen: 0, aside: [] as Uint8Array[], fail: false, refuseAside: false,
    open(): DiskStore {
      let mine = 0
      return {
        load: async () => { mine = shared.gen; return shared.image },
        save: async (image) => {
          if (shared.fail) return 'failed'
          if (shared.gen !== mine) return 'stale'
          shared.image = image.slice()
          mine = ++shared.gen
          return 'kept'
        },
        setAside: async (image) => { if (shared.refuseAside) return false; shared.aside.push(image); return true },
      }
    },
  }
  const first = shared.open()
  return Object.assign(shared, first)
}

test('the disk comes back on the next visit; /tmp does not', async () => {
  const b = city()
  const disk = memoryDisk()
  const one = replSession(host(disk.open()))
  await settle(one)
  all('echo kept > note; mkdir bin; echo gone > /tmp/scratch', b, one)
  assert.equal(osOf(one).unsavedChanges, true)
  await osOf(one).save()
  assert.equal(osOf(one).unsavedChanges, false)
  assert.ok(disk.image && disk.image.length > 0)
  const two = replSession(host(disk.open()))
  await settle(two)
  assert.equal(osOf(two).system.state, 'restored')
  assert.deepEqual(all('cat note; ls /tmp', b, two), ['kept'])
  assert.equal(osOf(two).unsavedChanges, false, 'a disk that came back as it was saved needs no saving')
  // Nothing changed: nothing is written.
  const gen = disk.gen
  await osOf(two).save()
  assert.equal(disk.gen, gen)
})

test('a page that fell behind never writes over the newer disk, and says once that its files are no longer kept', async () => {
  const b = city()
  const disk = memoryDisk()
  const one = replSession(host(disk.open()))
  const two = replSession(host(disk.open()))
  await settle(one)
  await settle(two)
  all('echo first > a', b, one)
  await osOf(one).save()
  const kept = disk.image
  all('echo second > b', b, two)
  await osOf(two).save()
  assert.equal(disk.image, kept, 'the newer disk is untouched')
  const said = await settle(two)
  assert.equal(said.length, 1)
  assert.match(said[0], /^disk: files are not kept between visits from here on: another page of this site saved a newer disk/)
  all('echo third > c', b, two)
  await osOf(two).save()
  assert.equal(disk.image, kept)
  assert.deepEqual(await settle(two), [], 'said once')
  assert.match(all('dmesg | grep -c "not kept"', b, two)[0], /^1$/)
})

test('a store that keeps failing is given up on after three tries, with the reason; one that recovers loses nothing', async () => {
  const b = city()
  const disk = memoryDisk()
  const s = replSession(host(disk.open()))
  await settle(s)
  all('echo v1 > f', b, s)
  disk.fail = true
  await osOf(s).save()
  assert.equal(osOf(s).unsavedChanges, true, 'still owed')
  disk.fail = false
  await osOf(s).save()
  assert.equal(osOf(s).unsavedChanges, false)
  assert.ok(disk.image)
  disk.fail = true
  for (let i = 0; i < 3; i++) {
    all(`echo ${i} > g`, b, s)
    await osOf(s).save()
  }
  const said = await settle(s)
  assert.match(said.join('\n'), /disk: files are not kept between visits from here on: the browser refused to store them/)
  assert.equal(osOf(s).unsavedChanges, false, 'no longer tried')
})

test('with nowhere to keep a disk the console says so when the first file is written, not before', async () => {
  const b = city()
  const s = replSession(host(null))
  // A new disk with nothing of the person's on it has nothing to save: a host's save timer is not kept going for it.
  assert.equal(osOf(s).unsavedChanges, false)
  assert.deepEqual(all('echo hello', b, s), ['hello'])
  await osOf(s).save()
  assert.deepEqual(await settle(s), [], 'the disk only holds what every disk starts with: nothing to lose yet')
  all('echo x > mine', b, s)
  await osOf(s).save()
  assert.match((await settle(s)).join('\n'), /disk: files are not kept between visits from here on: this page has nowhere to keep them/)
})

test('a saved disk that fails its check is set aside before anything is saved, and left where it is when it cannot be', async () => {
  const b = city()
  const disk = memoryDisk()
  disk.image = Uint8Array.of(1, 2, 3, 4)
  disk.gen = 7
  const s = replSession(host(disk.open()))
  const said = await settle(s)
  assert.equal(osOf(s).system.state, 'refused')
  assert.deepEqual([...disk.aside[0]], [1, 2, 3, 4])
  assert.match([...said, ...(await settle(s))].join('\n'), /disk: the saved disk failed its check and was set aside; this is a new, empty one/)
  all('echo new > f', b, s)
  await osOf(s).save()
  assert.equal(disk.gen, 8, 'the new disk is saved over it only after the copy was kept')

  const stuck = memoryDisk()
  stuck.image = Uint8Array.of(9, 9)
  stuck.gen = 3
  stuck.refuseAside = true
  const t = replSession(host(stuck.open()))
  const told = [...(await settle(t)), ...(await settle(t))]
  assert.match(told.join('\n'), /could not be copied aside, so it is left where it is/)
  all('echo new > f', b, t)
  await osOf(t).save()
  assert.deepEqual([...(stuck.image ?? [])], [9, 9], 'the stored image is untouched')
  assert.equal(stuck.gen, 3)
})

/** A store whose saves answer only when the test says, and whose load gives what was last kept. */
function slowDisk(): DiskStore & { stored: Uint8Array | null; asked: Uint8Array[]; answer(how: 'kept' | 'failed'): void } {
  const waiting: ((how: 'kept' | 'failed') => void)[] = []
  const d = {
    stored: null as Uint8Array | null,
    asked: [] as Uint8Array[],
    answer(how: 'kept' | 'failed') { waiting.shift()?.(how) },
    load: async () => d.stored,
    save: (image: Uint8Array) => new Promise<'kept' | 'stale' | 'failed'>((resolve) => {
      d.asked.push(image)
      waiting.push((how) => {
        if (how === 'kept') d.stored = image.slice()
        resolve(how)
      })
    }),
    setAside: async () => true,
  }
  return d
}

/** Lets promises settle without giving the layer a turn. */
async function ticks(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

test('a save asked for while one is on its way (the page hidden just then) is made once that one answers, with the disk as it is then', async () => {
  const b = city()
  const disk = slowDisk()
  const s = replSession(host(disk))
  await settle(s)
  all('echo one > a', b, s)
  const first = osOf(s).save()
  all('echo two > b', b, s)
  const second = osOf(s).save()
  assert.equal(disk.asked.length, 1)
  disk.answer('kept')
  await first
  await ticks()
  assert.equal(disk.asked.length, 2, 'the second save went out when the first answered')
  disk.answer('kept')
  await second
  assert.equal(osOf(s).unsavedChanges, false)
  const next = replSession(host(disk))
  await settle(next)
  assert.deepEqual(all('cat a b', b, next), ['one', 'two'])
})

test('after a failed save the next one keeps the disk as it is now, not the image that failed', async () => {
  const b = city()
  const disk = slowDisk()
  const s = replSession(host(disk))
  await settle(s)
  all('echo one > a', b, s)
  const first = osOf(s).save()
  disk.answer('failed')
  await first
  assert.equal(osOf(s).unsavedChanges, true)
  all('echo two > b', b, s)
  const second = osOf(s).save()
  disk.answer('kept')
  await second
  assert.equal(osOf(s).unsavedChanges, false, 'nothing is owed: what was kept holds both files')
  const next = replSession(host(disk))
  await settle(next)
  assert.deepEqual(all('cat a b', b, next), ['one', 'two'])
})

test('a store that cannot be read: the console says at once that its files are not kept, and writes nothing over it', async () => {
  const b = city()
  const disk = memoryDisk()
  disk.image = Uint8Array.of(5, 5)
  disk.gen = 4
  const store: DiskStore = { ...disk.open(), load: () => Promise.reject(new Error('read refused')) }
  const s = replSession(host(store))
  const said = [...(await settle(s)), ...(await settle(s))]
  assert.equal(osOf(s).system.state, 'new')
  assert.match(said.join('\n'), /^disk: files are not kept between visits from here on: the storage could not be read/m)
  all('echo x > f', b, s)
  assert.equal(osOf(s).unsavedChanges, false)
  await osOf(s).save()
  assert.equal(disk.gen, 4)
  assert.deepEqual([...(disk.image ?? [])], [5, 5])
})

test('a long job answers with what it has after a moment and goes on as the host gives it turns', () => {
  const b = city()
  const h = host()
  // The clock moves on a millisecond each time it is read, as a busy page's does, so a turn ends at its deadline:
  // the line comes back, and the job is not done.
  let reads = 0
  h.clock = () => h.t + ++reads
  const s = replSession(h)
  const os = osOf(s)
  const first = run('i=0; while [ $i -lt 20000 ]; do i=$((i + 1)); done; echo $i', b, [], s)
  assert.deepEqual(texts(first), [])
  assert.equal(os.busy, true)
  let out: string[] = []
  for (let turns = 0; turns < 2000 && os.busy; turns++) {
    os.pump(LINE_MS)
    for (let r = os.next(); r !== null; r = os.next()) out = out.concat(texts(r))
  }
  assert.deepEqual(out, ['20000'])
})

test('wiring: the page hands both consoles the one disk store; the terminal gives the layer turns, its prompt, Ctrl+C and Ctrl+D, and saves when hidden', () => {
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  assert.equal(app.match(/disk=\{CONSOLE_DISK\(\)\}/g)?.length, 2, 'the city console and the console alone')
  assert.match(app, /const CONSOLE_DISK = once\(\(\) => \{[\s\S]*?consoleDisk\(factory, \(fn, ms\) => window\.setTimeout\(fn, ms\)\)/)
  const term = readFileSync(new URL('./Terminal.tsx', import.meta.url), 'utf8')
  assert.match(term, /replSession\(\{\s*brand: \(bridge \?\? OFFLINE\)\.brand,\s*clock: \(\) => performance\.now\(\),\s*wall: \(\) => Date\.now\(\),/)
  assert.match(term, /disk: diskRef\.current,/)
  assert.match(term, /for \(let r = os\.next\(\); r !== null; r = os\.next\(\)\) applyRef\.current\(r\)/)
  assert.match(term, /os\.pump\(fullRef\.current \? OS_TURN_FULL_MS : OS_TURN_MS\)/)
  assert.match(term, /const prompt = ps1 \?\? `\$\{b\.brand\.host\}:~# `/)
  assert.match(term, /os\.system\.interrupt\(\)/)
  assert.match(term, /if \(el\.value === ''\) endInput\(\)/)
  assert.match(term, /window\.addEventListener\('pagehide', flush\)/)
  assert.match(term, /document\.addEventListener\('visibilitychange', hidden\)/)
  // A touch screen has no Ctrl key: the two buttons stand in for the two chords while a job has the terminal.
  assert.match(term, /<button type="button" onClick=\{endInput\}>End input<\/button>/)
  assert.match(term, />Stop<\/button>/)
})

/** The city with a queue of proposed actions kept as the tier keeps it: one waits at a time, and who answered it is written down. */
function proposing(): City & { propose(sentence: string): void; answered: string[] } {
  const c = city()
  let waiting: PendingAct | null = null
  let seq = 0
  const answered: string[] = []
  const acts: ActsBridge = {
    ...c.operator.acts,
    pending: () => waiting,
    allow: (by) => {
      const act = waiting
      if (act === null) throw new Error('nothing is waiting for your OK')
      waiting = null
      answered.push(`allowed ${act.seq} by ${by ?? 'host'}`)
      const end: ActEnd = { state: 'done', line: `act ${act.seq}: done` }
      return { act, result: Promise.resolve(end) }
    },
    refuse: (by) => {
      const act = waiting
      if (act === null) throw new Error('nothing is waiting for your OK')
      waiting = null
      answered.push(`refused ${act.seq} by ${by ?? 'host'}`)
      return act
    },
  }
  return Object.assign(c, {
    operator: { ...c.operator, acts },
    answered,
    propose(sentence: string) {
      waiting = { seq: ++seq, who: 'agent 17 (Design)', agent: 17, serial: 1, skills: ['design'], verb: 'clock', canonical: 'clock 22:00', sentence, since: 0 }
    },
  })
}

test('a proposal is answered only at the prompt: a job, a pipe or a script that runs act ok or act no is refused, and act ok or n typed alone still answers', () => {
  const b = proposing()
  b.unlocked = true
  const h = host()
  const s = replSession(h)
  const os = osOf(s)
  const refusal = '!act: a proposal is answered at the prompt: type act ok, act no, y or n on its own'
  // A loop in the background that would allow each proposal as it came, with nothing typed for it.
  all('while true; do act ok; sleep 1; done &', b, s)
  b.propose('set the clock to 22:00')
  let shown: string[] = []
  for (let i = 0; i < 3; i++) {
    h.t += 1000
    os.pump(LINE_MS)
    for (let r = os.next(); r !== null; r = os.next()) shown = shown.concat(texts(r))
  }
  assert.ok(shown.includes(refusal), shown.join('\n'))
  assert.deepEqual(b.answered, [], 'the job answered nothing')
  all('stop %1', b, s)
  all("echo 'act no' > /tmp/no.sh", b, s)
  assert.deepEqual(all('sh /tmp/no.sh', b, s), [refusal])
  assert.deepEqual(all('act ok | cat; act no', b, s), [refusal, refusal])
  assert.deepEqual(b.answered, [])
  // What only reads still runs from the shell.
  assert.match(all('act | cat', b, s)[0], /^act 1: waiting for your OK: agent 17 \(Design\) proposes: set the clock to 22:00/)
  // Typed alone at the prompt, the answer is the person's.
  assert.deepEqual(texts(run('act ok', b, [], s)), ['act 1: allowed: set the clock to 22:00'])
  b.propose('turn the rain on')
  assert.deepEqual(texts(run('n', b, [], s)), ['act 2: refused: turn the rain on (agent 17 is told next time)'])
  assert.deepEqual(b.answered, ['allowed 1 by console', 'refused 2 by console'])
})

test('a shell loop drives the city at most CITY_TURN_MAX console commands a turn: the rest wait for the next turn, in order, and a knob written in a loop counts the same', () => {
  assert.equal(CITY_TURN_MAX, 32)
  const b = city()
  const h = host()
  // The clock moves a millisecond every hundred reads, as a fast page's does: a turn could run thousands of commands
  // before its deadline.
  let reads = 0
  h.clock = () => h.t + Math.floor(++reads / 100)
  const s = replSession(h)
  const os = osOf(s)
  const turns: number[] = []
  let before = b.calls.length
  run('while true; do rain on; rain off; done', b, [], s)
  for (let i = 0; i < 6; i++) {
    turns.push(b.calls.length - before)
    before = b.calls.length
    assert.equal(os.busy, true, 'what is owed keeps the host giving turns')
    os.pump(4)
    while (os.next() !== null) { /* shown */ }
  }
  assert.ok(turns.every((n) => n > 0 && n <= CITY_TURN_MAX), turns.join(' '))
  assert.ok(b.calls.every((c, i) => c === (i % 2 === 0 ? 'rain on' : 'rain off')), 'in the order the loop ran them')
  os.system.interrupt()
  os.pump(LINE_MS)
  while (os.next() !== null) { /* shown */ }
  before = b.calls.length
  run('while true; do echo on > /sys/city/rain; done', b, [], s)
  for (let i = 0; i < 4; i++) {
    const n = b.calls.length - before
    assert.ok(n > 0 && n <= CITY_TURN_MAX, `a knob written in a loop: ${n} in one turn`)
    before = b.calls.length
    os.pump(4)
    while (os.next() !== null) { /* shown */ }
  }
  os.system.interrupt()
  os.pump(LINE_MS)
  // A line of more commands than one turn's share: the rest run on the next turn, each once, in order, shown in order.
  const t = city()
  const u = replSession(host())
  const hours = [...Array(24).keys(), ...Array(24).keys()]
  const printed = texts(run(hours.map((h) => `time ${h}`).join('; '), t, [], u))
  assert.equal(t.calls.length, CITY_TURN_MAX, 'the first turn runs its share')
  assert.equal(osOf(u).busy, true)
  osOf(u).pump(LINE_MS)
  for (let r = osOf(u).next(); r !== null; r = osOf(u).next()) printed.push(...texts(r))
  assert.deepEqual(t.calls, hours.map((h) => `setClock ${h}`))
  assert.deepEqual(printed, hours.map((h) => `${String(h).padStart(2, '0')}:00`))
})

test('a key, a token or a passphrase that a console command takes from the shell is recorded once, so the console can dot it in its history in whatever form it was typed', () => {
  const b = city()
  const s = replSession(host())
  const os = osOf(s)
  for (const line of [
    "sh -c 'ask key sk-SECRET3'",
    "echo 'ring0 unlock --elite open sesame' | sh",
    'X=1 ask connect claude http://localhost:8089 sk-ant-4',
    '"net" join ws://127.0.0.1:9 TOKEN5',
    "sh -c 'say key k6'",
    "printf 'ring0 elite set new phrase\\n' | sh",
    '\\ask connect openai sk-proj-7',
  ]) all(line, b, s)
  assert.deepEqual(os.takeSecrets(), ['sk-SECRET3', 'open sesame', 'sk-ant-4', 'TOKEN5', 'k6', 'new phrase', 'sk-proj-7'])
  assert.deepEqual(os.takeSecrets(), [], 'handed over once')
  // Nothing that is not a secret is recorded: an address, a setting, a key cleared, a command only echoed.
  for (const line of [
    "sh -c 'ask connect ollama http://localhost:11434'", "sh -c 'ask model m'", "sh -c 'ask key none'", "sh -c 'say key NONE'",
    "sh -c 'net join ws://127.0.0.1:9'", 'echo ask key x | cat',
  ]) all(line, b, s)
  assert.deepEqual(os.takeSecrets(), [])
  // The console dots each one where it stands in a line it kept, with everything after it.
  const history = ["sh -c 'ask key sk-SECRET3'", 'echo hello', '"net" join ws://127.0.0.1:9 TOKEN5 ; echo ok']
  scrubSecrets(history, ['sk-SECRET3', 'TOKEN5', ''])
  assert.deepEqual(history, ["sh -c 'ask key ••••", 'echo hello', '"net" join ws://127.0.0.1:9 ••••'])
})

test('history run by the shell lists the line as it was typed as its last row, so history | tail and history | grep agree with what the history then holds', () => {
  const b = city()
  const s = replSession(host())
  const shown = (line: string, history: string[]): string[] => {
    const out = texts(run(line, b, history, s))
    for (let r = osOf(s).next(); r !== null; r = osOf(s).next()) out.push(...texts(r))
    return out
  }
  assert.deepEqual(shown('history | tail -n 2', ['time', 'laws']), ['    2  laws', '    3  history | tail -n 2'])
  assert.deepEqual(shown('history | grep tail', ['time', 'laws', 'history | tail -n 2']), ['    3  history | tail -n 2', '    4  history | grep tail'])
  // A secret typed earlier on the same line is dotted there, as the history keeps it: never printed back.
  const rows = shown('true; net join wss://r.example TOKEN123; history | cat', []).filter((l) => /^ +\d/.test(l))
  assert.deepEqual(rows, ['    1  ' + redactForHistory('true; net join wss://r.example TOKEN123; history | cat')])
  assert.doesNotMatch(rows.join('\n'), /TOKEN123/)
})

test('Tab asks the system only for the programs that start with the word, so a large directory on the path is not checked file by file', () => {
  const b = city()
  const s = replSession(host())
  const os = osOf(s)
  all('mkdir -p ~/bin; echo "echo hi" > ~/bin/tool1; chmod 755 ~/bin/tool1', b, s)
  const asked: string[] = []
  const commands = os.system.commands.bind(os.system)
  os.system.commands = (prefix = '') => { asked.push(prefix); return commands(prefix) }
  assert.deepEqual(completeLine('too', s), ['tool1'])
  assert.deepEqual(completeLine('ls | gr', s), ['ls | grep'])
  assert.deepEqual(asked, ['too', 'gr'])
})

/** SHA-256 as a host's own digest gives it (off the page's thread, in a browser): node's, here. */
const nodeSha = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash('sha256').update(bytes).digest())

test('a save is sealed with the host\'s own digest when it has one, and the next visit reads it back', async () => {
  const b = city()
  const disk = memoryDisk()
  const h = host(disk.open())
  const sealed: number[] = []
  h.digest = async (bytes) => { sealed.push(bytes.length); return nodeSha(bytes) }
  const s = replSession(h)
  await settle(s)
  all('echo sealed > note', b, s)
  await osOf(s).save()
  assert.equal(sealed.length, 1, 'the host sealed the image')
  assert.equal(disk.image?.length, sealed[0] + 32, 'the image is the body and its seal after it')
  const next = replSession(host(disk.open()))
  await settle(next)
  assert.equal(osOf(next).system.state, 'restored')
  assert.deepEqual(all('cat note', b, next), ['sealed'])
})

test('a save asked for as the page goes is sealed at once and reaches the store before anything is awaited, even while another waits for its seal', async () => {
  const b = city()
  const disk = slowDisk()
  const h = host(disk)
  const seals: (() => void)[] = []
  h.digest = (bytes) => new Promise((resolve) => { seals.push(() => resolve(nodeSha(bytes))) })
  const s = replSession(h)
  await settle(s)
  const os = osOf(s)
  all('echo one > a', b, s)
  const quick = os.save({ now: true })
  assert.equal(disk.asked.length, 1, 'the store was asked before save returned')
  assert.equal(seals.length, 0, 'sealed here, not by the host')
  disk.answer('kept')
  await quick
  // A save on the timer waits for the host's seal; the page goes meanwhile, and the quick save takes it over.
  all('echo two > b', b, s)
  const timed = os.save()
  await ticks()
  assert.equal(seals.length, 1)
  assert.equal(disk.asked.length, 1, 'the timer\'s save still waits for its seal')
  all('echo three > c', b, s)
  const going = os.save({ now: true })
  assert.equal(disk.asked.length, 2, 'asked at once, with what the timer\'s save held and the change since')
  seals[0]()
  await ticks()
  assert.equal(disk.asked.length, 2, 'the seal that came late asks nothing more')
  disk.answer('kept')
  await going
  await timed
  assert.equal(os.unsavedChanges, false)
  const next = replSession(host(disk))
  await settle(next)
  assert.deepEqual(all('cat a b c', b, next), ['one', 'two', 'three'])
})

test('a save whose image cannot be made never throws: it counts as a failed save, the change stays owed and the next try keeps it, and three lose the disk', async () => {
  const b = city()
  const disk = memoryDisk()
  const s = replSession(host(disk.open()))
  await settle(s)
  const os = osOf(s)
  const system = os.system
  all('echo the-only-copy > notes', b, s)
  // The browser refuses the memory for the image.
  const refuse = (): never => { throw new RangeError('Array buffer allocation failed') }
  const refusing = () => { system.snapshot = refuse; system.snapshotBody = refuse }
  const giving = () => { Reflect.deleteProperty(system, 'snapshot'); Reflect.deleteProperty(system, 'snapshotBody') }
  refusing()
  let saving: Promise<void> = Promise.resolve()
  assert.doesNotThrow(() => { saving = os.save() })
  await saving
  assert.equal(os.unsavedChanges, true, 'still owed')
  giving()
  await os.save()
  assert.equal(os.unsavedChanges, false)
  const next = replSession(host(disk.open()))
  await settle(next)
  assert.deepEqual(all('cat notes', b, next), ['the-only-copy'])
  refusing()
  for (let i = 0; i < 3; i++) {
    all(`echo ${i} > more`, b, s)
    await os.save()
  }
  giving()
  assert.match((await settle(s)).join('\n'), /disk: files are not kept between visits from here on: the browser refused to store them/)
})
