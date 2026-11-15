// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the console to what the operating layer (os/) promised it: with no host the
 * console is its command table alone, to the letter; with one, a console command typed alone still runs exactly as
 * it did, everything else is the shell's, the shell runs a console command inside a pipe or a list through the same
 * handler, the city reads as files under /proc/city and its knobs take a write under /sys/city with the command's
 * own checks, a line typed while a program reads the terminal is that program's, and the disk comes back on the
 * next visit, is never written over by a page that fell behind, and is set aside rather than lost when it fails
 * its check.
 * What breaks if it is removed? Any of those could change without a test noticing, and the first to notice would be
 * someone whose files were gone.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { offlineBridge, type TerminalBridge } from './bridge.ts'
import { LINE_MS, completeLine, complete, replSession, run, type CommandResult, type DiskStore, type OsHost, type OsSession, type ReplSession } from './commands.ts'

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
      command: (name, args) => { c.earned.push(`${name} ${args.join(' ')}`); return name === 'sh' && c.paying ? ['check: Computers'] : [] },
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

test('a line typed while a program reads the terminal is that program\'s, even when it names a console command', () => {
  const b = city()
  const s = replSession(host())
  const os = osOf(s)
  assert.deepEqual(all('cat > /tmp/typed', b, s), [])
  assert.equal(os.system.capturing, true)
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
  assert.deepEqual(all('echo $w; done', b, s), ['a', 'b'])
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
