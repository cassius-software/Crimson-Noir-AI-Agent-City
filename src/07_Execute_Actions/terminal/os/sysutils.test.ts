// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the system programs (sysutils.ts) the way a person meets them: typed at the real
 * shell of a system held in memory, on a clock that moves only when the test moves it, with what they print, the
 * bytes they leave in a file and the status they end with all checked. Every option is used at least once, and so
 * are the ways each program is refused or cut short: a wrong call, a name that runs nothing, a directory where a
 * program is wanted, a file that may not be run, a clock outside the calendar, an output that takes nothing, a reader
 * that leaves early, a command that outlives its limit and Ctrl+C in the middle of a wait. Every manual page is held
 * to the one shape.
 * What breaks if it is removed? A change to one of these programs could alter what a script depends on (a status,
 * the form of the time, the columns of a listing, the words of a refusal) or leave a stopped command running, and
 * nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ROOT_CRED } from './fs.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'
import { SYS_MANUAL, SYS_PROGRAMS } from './sysutils.ts'
import { now } from './task.ts'

/** A system with these programs and their manual. */
const fresh = (): Kit => boot(SYS_PROGRAMS, { manual: SYS_MANUAL })

/** The names of the tasks that are running: only the first task and the shell once a command has ended. */
const tasks = (k: Kit): string[] => k.system.kernel.ps().map((p) => p.name)
const AT_REST = ['init', '-sh']

/** What a command printed, without the shell's own remarks (it names itself first on those lines). */
const own = (lines: readonly string[]): string[] => lines.filter((l) => !l.startsWith('!ash:'))

/** A file that may be run, straight on the file system. */
function runnable(k: Kit, path: string, text: string, mode = 0o755): void {
  k.write(path, text)
  now(k.system.kernel.vfs.chmod(path, '/', ROOT_CRED, mode))
}

const mkdir = (k: Kit, path: string): void => now(k.system.kernel.vfs.mkdir(path, '/', ROOT_CRED, 0o755))

/** The person's own directory for programs, with a script in it that names no interpreter (the shell runs it). */
function withGreet(k: Kit): void {
  mkdir(k, '/home/operator/bin')
  runnable(k, '/home/operator/bin/greet', 'echo hello $1 $WHO\n')
}

/** A text as a pattern that matches only itself. */
const literal = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Builds, in the shell, an exported variable BIG of 81920 letters. */
const BIG = 'x=aaaaaaaaaa; for i in 1 2 3 4 5 6 7 8 9 10 11 12 13; do x=$x$x; done; export BIG=$x'

const NAMES = [
  '[', 'cal', 'date', 'dmesg', 'env', 'false', 'hostname', 'id', 'man', 'printenv', 'ps', 'pwd', 'sleep', 'test', 'time', 'timeout', 'true', 'uname',
  'uptime', 'which', 'whoami',
]

// The manual, and what every program shares

test('manual: every program has a page, each in the one shape, plain and narrow', () => {
  assert.deepEqual(Object.keys(SYS_PROGRAMS).sort(), NAMES)
  assert.deepEqual(Object.keys(SYS_MANUAL).sort(), NAMES)
  assert.ok(Object.isFrozen(SYS_PROGRAMS) && Object.isFrozen(SYS_MANUAL))
  const order = ['NAME', 'USAGE', 'WHAT IT DOES', 'OPTIONS', 'NOTES', 'STATUS', 'EXAMPLE']
  for (const name of NAMES) {
    const page = SYS_MANUAL[name]
    assert.ok(page.endsWith('\n') && !page.endsWith('\n\n') && !page.startsWith('\n'), name)
    const lines = page.split('\n')
    assert.equal(lines[0], 'NAME', name)
    assert.match(lines[1], new RegExp(`^    ${literal(name)} - [a-z][^.]*$`), name)
    assert.equal(lines[2], '', name)
    assert.equal(lines[3], 'USAGE', name)
    assert.ok(lines[4] === `    ${name}` || lines[4].startsWith(`    ${name} `), name)
    const heads: string[] = []
    for (const [i, line] of lines.entries()) {
      assert.ok(line.length <= 78, `${name}:${i + 1}: ${line.length} columns`)
      assert.match(line, /^[\x20-\x7e]*$/, `${name}:${i + 1}`)
      assert.ok(!line.endsWith(' '), `${name}:${i + 1}: a blank at the end`)
      if (line === '' || line.startsWith('    ')) continue
      assert.ok(order.includes(line), `${name}:${i + 1}: ${line}`)
      assert.equal(lines[i - 1] ?? '', '', `${name}:${i + 1}: a heading follows an empty line`)
      heads.push(line)
    }
    assert.deepEqual(heads, order.filter((h) => heads.includes(h)), name)
    for (const must of ['NAME', 'USAGE', 'WHAT IT DOES', 'STATUS', 'EXAMPLE']) assert.ok(heads.includes(must), `${name}: ${must}`)
    // A section has something in it, and the example uses the program.
    for (const head of heads) assert.notEqual(lines[lines.indexOf(head) + 1] ?? '', '', `${name}: ${head} is empty`)
    assert.ok(lines[lines.indexOf('EXAMPLE') + 1].includes(name), name)
    assert.doesNotMatch(page, /https?:|www\./, name)
  }
})

test('manual: a wrong call prints the usage of the page, and the status is 2', () => {
  const k = fresh()
  const wrong: Record<string, string> = {
    pwd: '/bin/pwd x', sleep: 'sleep', env: 'env -z', printenv: 'printenv -z', date: 'date +%F +%T', cal: 'cal 1 2 3', which: 'which', id: 'id x',
    whoami: 'whoami x', hostname: 'hostname x', uname: 'uname x', uptime: 'uptime x', dmesg: 'dmesg -c', ps: 'ps x', man: 'man a b', timeout: 'timeout 1',
    time: 'time',
  }
  assert.deepEqual(Object.keys(wrong).sort(), NAMES.filter((n) => !['[', 'test', 'true', 'false'].includes(n)))
  for (const [name, line] of Object.entries(wrong)) {
    const out = k.sh(`${line}; echo $?`)
    const page = SYS_MANUAL[name].split('\n')
    const usage = page.slice(4, page.indexOf('', 4)).map((l) => l.slice(4))
    const expected = [`!usage: ${usage[0]}`, ...usage.slice(1).map((l) => `!       ${l}`), '2']
    assert.deepEqual(out.filter((l) => !l.startsWith(`!${name}: `)), expected, line)
  }
  // What was wrong is said first, when there are words for it.
  assert.deepEqual(k.sh('env -z'), ["!env: unknown option '-z'", '!usage: env [-i] [name=value ...] [command [argument ...]]'])
})

test('a refused write to the ordinary output is said once, as a write error, with status 1', () => {
  const k = fresh()
  k.system.kernel.log('a line for dmesg')
  const cmds = ['date', 'cal', 'cal 2026', 'env', 'env -i A=1', 'printenv', 'printenv HOME', 'id', 'id -u', 'whoami', 'hostname', 'uname', 'uptime', 'dmesg', 'ps',
    'man', 'man cal', 'man -k cal', 'which date', '/bin/pwd']
  for (const cmd of cmds) {
    const name = cmd.split(' ')[0].replace('/bin/', '')
    assert.deepEqual(k.sh(`${cmd} > /dev/full; echo $?`), [`!${name}: write error: no space left on device`, '1'], cmd)
  }
  // A command env runs answers for itself.
  assert.deepEqual(k.sh('env date > /dev/full; echo $?'), ['!date: write error: no space left on device', '1'])
})

test('a closed pipe ends a program quietly, however much it had left to say', () => {
  const k = fresh()
  assert.deepEqual(k.sh(BIG), [])
  const format = '+%F%T%s%j%n'.repeat(4000)
  for (const cmd of ['env', 'printenv', 'printenv BIG', `date ${format}`, 'man', 'man cal', 'cal 2026', 'ps -f', 'env env', `env date ${format}`]) {
    assert.deepEqual(own(k.sh(`${cmd} | true; echo $?`)), ['0'], cmd)
    assert.deepEqual(tasks(k), AT_REST, cmd)
  }
})

// true, false, pwd

test('true and false: a status and nothing else, whatever the arguments', () => {
  const k = fresh()
  assert.deepEqual(k.sh('/bin/true; echo $?; /bin/false; echo $?'), ['0', '1'])
  assert.deepEqual(k.sh('/bin/true --help -x y; echo $?; /bin/false --help; echo $?'), ['0', '1'])
  assert.deepEqual(k.sh('env true && echo yes; env false || echo no'), ['yes', 'no'])
  assert.deepEqual(k.sh('/bin/true < /dev/zero > /tmp/o; echo $?'), ['0'])
  assert.equal(k.read('/tmp/o'), '')
})

test('pwd: the working directory', () => {
  const k = fresh()
  assert.deepEqual(k.sh('/bin/pwd'), ['/home/operator'])
  assert.deepEqual(k.sh('cd /tmp; /bin/pwd; /bin/pwd -L; /bin/pwd -P; /bin/pwd -LP; cd /; /bin/pwd'), ['/tmp', '/tmp', '/tmp', '/tmp', '/'])
  assert.deepEqual(k.sh('cd /usr/share/man; env pwd > /tmp/o'), [])
  assert.equal(k.read('/tmp/o'), '/usr/share/man\n')
  assert.deepEqual(k.sh('/bin/pwd -z; echo $?'), ["!pwd: unknown option '-z'", '!usage: pwd [-L | -P]', '2'])
  assert.deepEqual(k.sh('/bin/pwd /tmp; echo $?'), ['!usage: pwd [-L | -P]', '2'])
})

// sleep

test('sleep: waits on the clock, in seconds, with a decimal point or a unit', () => {
  const k = fresh()
  assert.deepEqual(k.sh('sleep 1; echo hi'), [])
  k.tick(999)
  assert.deepEqual(k.settle(), [])
  k.tick(1)
  assert.deepEqual(k.settle(), ['hi'])
  const cases: [string, number][] = [['0.5', 500], ['.25', 250], ['2.', 2000], ['3s', 3000], ['1.5m', 90000], ['1m', 60000], ['1h', 3_600_000], ['0.001', 1], ['007', 7000]]
  for (const [arg, ms] of cases) {
    assert.deepEqual(k.sh(`sleep ${arg}; echo done $?`), [], arg)
    k.tick(ms - 1)
    assert.deepEqual(k.settle(), [], arg)
    k.tick(1)
    assert.deepEqual(k.settle(), ['done 0'], arg)
  }
  assert.deepEqual(k.sh('sleep 0; echo now; sleep 0s; sleep .0; echo still'), ['now', 'still'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('sleep: a wrong length is refused; Ctrl+C ends the wait', () => {
  const k = fresh()
  const use = '!usage: sleep seconds'
  for (const arg of ['x', '1d', '1e3', '1.2.3', '1 s', '.', 's', '"1 "', '0x10', '""']) {
    const shown = arg.startsWith('"') ? arg.slice(1, -1) : arg
    if (arg === '1 s') assert.deepEqual(k.sh(`sleep ${arg}; echo $?`), [use, '2'])
    else assert.deepEqual(k.sh(`sleep ${arg}; echo $?`), [`!sleep: '${shown}' is not a length of time`, use, '2'], arg)
  }
  assert.deepEqual(k.sh('sleep; echo $?'), [use, '2'])
  assert.deepEqual(k.sh('sleep 1 2; echo $?'), [use, '2'])
  assert.deepEqual(k.sh('sleep -1; echo $?'), ["!sleep: unknown option '-1'", use, '2'])
  assert.deepEqual(k.sh('sleep 100; echo after'), [])
  assert.deepEqual(tasks(k), [...AT_REST, 'sleep'])
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(tasks(k), AT_REST)
  k.tick(200_000)
  assert.deepEqual(k.settle(), [])
})

// test, [

test('test and [: the shell\'s own questions, as programs another program can start', () => {
  const k = fresh()
  k.write('/tmp/f', 'x')
  k.write('/tmp/empty', '')
  assert.deepEqual(k.sh('/bin/test -d /tmp; echo $?; /bin/test -f /tmp; echo $?; /bin/test -f /tmp/f; echo $?'), ['0', '1', '0'])
  assert.deepEqual(k.sh('/bin/test -s /tmp/f; echo $?; /bin/test -s /tmp/empty; echo $?; /bin/test -e /nosuch; echo $?'), ['0', '1', '1'])
  assert.deepEqual(k.sh('/bin/test; echo $?; /bin/test word; echo $?; /bin/test ""; echo $?'), ['1', '0', '1'])
  assert.deepEqual(k.sh('/bin/test 3 -lt 10 -a abc = abc; echo $?; /bin/test ! 3 -gt 10; echo $?; /bin/test 3 -gt 10 -o -z ""; echo $?'), ['0', '0', '0'])
  assert.deepEqual(k.sh('/bin/test 1 -eq x; echo $?'), ["!test: 'x' is not a whole number", '2'])
  assert.deepEqual(k.sh('/bin/test a b; echo $?'), ['!test: too many arguments', '2'])
  assert.deepEqual(k.sh('/bin/[ a = a ]; echo $?; /bin/[ a = b ]; echo $?; /bin/[ ]; echo $?'), ['0', '1', '1'])
  assert.deepEqual(k.sh('/bin/[ a = a; echo $?; /bin/[; echo $?'), ["![: missing ']'", '2', "![: missing ']'", '2'])
  assert.deepEqual(k.sh('/bin/[ 1 -eq x ]; echo $?'), ["![: 'x' is not a whole number", '2'])
  assert.deepEqual(k.sh('env [ -d /tmp ] && echo dir; env test -z "" && echo empty'), ['dir', 'empty'])
  // The same answers as the shell's own.
  for (const q of ['-d /tmp', '-x /bin/env', '-r /tmp/f', '-w /bin/env', 'a != b', '\\( 1 -eq 1 \\) -o 1 -eq 2', '-n ""', '/tmp/f -nt /nosuch', '-t 0']) {
    const [mine, builtin] = [k.sh(`/bin/test ${q}; echo $?`), k.sh(`test ${q}; echo $?`)]
    assert.deepEqual(mine, builtin, q)
  }
})

// env, printenv

test('env: the environment sorted by name', () => {
  const k = fresh()
  const start = ['HOME=/home/operator', 'HOSTNAME=crimson-noir', 'LOGNAME=root', 'PATH=/home/operator/bin:/bin:/usr/apps', 'PWD=/home/operator', 'SHELL=/bin/sh', 'TERM=console', 'USER=root']
  assert.deepEqual(k.sh('env'), start)
  assert.deepEqual(k.sh('export b=2; export a=1; export Z=0; env'), [...start, 'Z=0', 'a=1', 'b=2'])
  assert.deepEqual(k.sh('env -i'), [])
  assert.deepEqual(k.sh('env -i B=2 A=1 C=x=y D= B=3'), ['A=1', 'B=3', 'C=x=y', 'D='])
  assert.deepEqual(k.sh('env -i -- A=1'), ['A=1'])
  assert.deepEqual(k.sh('env -i A=1 env'), ['A=1'])
  // Nothing changes for the shell.
  assert.deepEqual(k.sh('env HOME=/tmp A=1 printenv HOME A; printenv HOME A; echo $?'), ['/tmp', '1', '/home/operator', '1'])
})

test('env: runs a command with values added, and ends with its status', () => {
  const k = fresh()
  assert.deepEqual(k.sh('env GREETING=hello printenv GREETING'), ['hello'])
  assert.deepEqual(k.sh('env -i printenv; echo $?'), ['0'])
  assert.deepEqual(k.sh('env /bin/false; echo $?; env sh -c "exit 7"; echo $?'), ['1', '7'])
  assert.deepEqual(k.sh('env A=1 sh -c \'echo $A $0 $1\' zero one'), ['1 zero one'])
  assert.deepEqual(k.sh('env nosuch; echo $?'), ['!env: nosuch: not found', '127'])
  assert.deepEqual(k.sh('env =x; echo $?'), ['!env: =x: not found', '127'])
  assert.deepEqual(k.sh('env PATH=/tmp date; echo $?'), ['!env: date: not found', '127'])
  assert.deepEqual(k.sh('env A=1 /tmp; echo $?'), ['!env: /tmp: is a directory', '126'])
  k.write('/tmp/text', 'echo hi\n')
  assert.deepEqual(k.sh('env /tmp/text; echo $?'), ['!env: /tmp/text: permission denied', '126'])
  // A file that may be run but names no interpreter is a script of the shell, as the shell itself takes it.
  withGreet(k)
  assert.deepEqual(k.sh('env WHO=you greet there; echo $?'), ['hello there you', '0'])
  assert.deepEqual(k.sh('env -i WHO=you /home/operator/bin/greet there'), ['hello there you'])
  // A refusal inside the command is the command's own, not one to start it.
  assert.deepEqual(k.sh('env printenv -z; echo $?'), ["!printenv: unknown option '-z'", '!usage: printenv [name ...]', '2'])
  // Very long values pass whole.
  assert.deepEqual(k.sh(`${BIG}; env -i BIG=$BIG printenv BIG > /tmp/o; echo $?`), ['0'])
  assert.equal(k.read('/tmp/o'), `${'a'.repeat(81920)}\n`)
  assert.deepEqual(tasks(k), AT_REST)
})

test('printenv: the values of the names given, or every name=value', () => {
  const k = fresh()
  assert.deepEqual(k.sh('printenv HOME'), ['/home/operator'])
  assert.deepEqual(k.sh('printenv HOME NOSUCH USER; echo $?'), ['/home/operator', 'root', '1'])
  assert.deepEqual(k.sh('printenv NOSUCH; echo $?'), ['1'])
  assert.deepEqual(k.sh('printenv'), k.sh('env'))
  assert.deepEqual(k.sh('X=hidden; printenv X; echo $?; export X; printenv X; echo $?'), ['1', 'hidden', '0'])
  assert.deepEqual(k.sh('export E=; printenv E > /tmp/o; echo $?'), ['0'])
  assert.equal(k.read('/tmp/o'), '\n')
  assert.deepEqual(k.sh('printenv HOME=/home/operator; echo $?'), ['1'])
  assert.deepEqual(k.sh('printenv -- HOME'), ['/home/operator'])
})

// date

test('date: the moment in UTC, in the usual form or a format', () => {
  const k = fresh()
  assert.deepEqual(k.sh('date'), ['Sat Nov 14 18:00:00 UTC 2026'])
  assert.deepEqual(k.sh('date -u'), ['Sat Nov 14 18:00:00 UTC 2026'])
  assert.deepEqual(k.sh('date +%Y-%m-%d_%H:%M:%S'), ['2026-11-14_18:00:00'])
  assert.deepEqual(k.sh("date '+%a %b %e %j %u %y %Z %s %F %T %%'"), ['Sat Nov 14 318 6 26 UTC 1794679200 2026-11-14 18:00:00 %'])
  assert.deepEqual(k.sh('date -u +plain'), ['plain'])
  assert.deepEqual(k.sh('date +a%nb%tc%%%% > /tmp/o'), [])
  assert.equal(k.read('/tmp/o'), 'a\nb\tc%%\n')
  assert.deepEqual(k.sh('date + > /tmp/o'), [])
  assert.equal(k.read('/tmp/o'), '\n')
  assert.deepEqual(k.sh('date > /tmp/o'), [])
  assert.equal(k.read('/tmp/o'), 'Sat Nov 14 18:00:00 UTC 2026\n')
  // Single digits: %e pads with a blank, the others with a zero.
  k.tick(18 * 86_400_000 + 6 * 3_600_000 + 5 * 60_000 + 7999)
  assert.deepEqual(k.sh('date'), ['Thu Dec  3 00:05:07 UTC 2026'])
  assert.deepEqual(k.sh("date '+%d|%e|%m|%H|%M|%S|%j|%u|%s'"), ['03| 3|12|00|05|07|337|4|1796256307'])
  k.tick(3 * 86_400_000)
  assert.deepEqual(k.sh('date +%a%u'), ['Sun7'])
  k.tick(28 * 86_400_000)
  assert.deepEqual(k.sh('date +%F%j%y'), ['2027-01-0300327'])
})

test('date: a format it cannot print, or a time to set, is refused', () => {
  const k = fresh()
  const use = '!usage: date [-u] [+format]'
  assert.deepEqual(k.sh('date +%D; echo $?'), ["!date: '%D' is not something this program can print", use, '2'])
  assert.deepEqual(k.sh('date +%Y%q; echo $?'), ["!date: '%q' is not something this program can print", use, '2'])
  assert.deepEqual(k.sh('date +abc%; echo $?'), ["!date: a '%' at the end of the format names nothing", use, '2'])
  assert.deepEqual(k.sh('date 202611141800; echo $?'), ["!date: '202611141800' is not a format: a format starts with +", use, '2'])
  assert.deepEqual(k.sh('date -z; echo $?'), ["!date: unknown option '-z'", use, '2'])
  assert.deepEqual(k.sh('date +%F %T; echo $?'), [use, '2'])
  // A character beyond plain ASCII after a % is named whole, even one that takes two code units.
  assert.deepEqual(k.sh('date +%é'), ["!date: '%é' is not something this program can print", use])
  assert.deepEqual(k.sh('date +%\u{1f600}x'), ["!date: '%\u{1f600}' is not something this program can print", use])
})

test('date and cal: a clock outside the years 1 to 9999', () => {
  const late = boot(SYS_PROGRAMS, { wall: () => 253_402_300_800_000 })
  assert.deepEqual(late.sh('date; date +%Y%y%j'), ['Sat Jan  1 00:00:00 UTC 10000', '1000000001'])
  assert.deepEqual(late.sh('cal; echo $?'), ['!cal: the clock says the year 10000, and a calendar is drawn for the years 1 to 9999 only', '1'])
  assert.deepEqual(late.sh('cal 1 9999 > /dev/null; echo $?'), ['0'])
  const early = boot(SYS_PROGRAMS, { wall: () => -62_167_219_200_000 })
  assert.deepEqual(early.sh('date; date +%s'), ['Sat Jan  1 00:00:00 UTC 0000', '-62167219200'])
  assert.deepEqual(early.sh('cal; echo $?'), ['!cal: the clock says the year 0, and a calendar is drawn for the years 1 to 9999 only', '1'])
})

// cal

const NOVEMBER = ['   November 2026', 'Su Mo Tu We Th Fr Sa', ' 1  2  3  4  5  6  7', ' 8  9 10 11 12 13 14', '15 16 17 18 19 20 21', '22 23 24 25 26 27 28', '29 30']

test('cal: a month as a table, Sunday first, today not marked', () => {
  const k = fresh()
  assert.deepEqual(k.sh('cal'), NOVEMBER)
  assert.deepEqual(k.sh('cal 11 2026'), NOVEMBER)
  assert.deepEqual(k.sh('cal 011 02026'), NOVEMBER)
  assert.deepEqual(k.sh('cal > /tmp/o'), [])
  assert.equal(k.read('/tmp/o'), `${NOVEMBER.join('\n')}\n`)
  assert.deepEqual(k.sh('cal 2 2024'), ['   February 2024', 'Su Mo Tu We Th Fr Sa', '             1  2  3', ' 4  5  6  7  8  9 10', '11 12 13 14 15 16 17', '18 19 20 21 22 23 24', '25 26 27 28 29'])
  assert.deepEqual(k.sh('cal 2 2023').slice(2), ['          1  2  3  4', ' 5  6  7  8  9 10 11', '12 13 14 15 16 17 18', '19 20 21 22 23 24 25', '26 27 28'])
  assert.deepEqual(k.sh('cal 2 1900').slice(2), ['             1  2  3', ' 4  5  6  7  8  9 10', '11 12 13 14 15 16 17', '18 19 20 21 22 23 24', '25 26 27 28'])
  assert.deepEqual(k.sh('cal 2 2000').slice(2), ['       1  2  3  4  5', ' 6  7  8  9 10 11 12', '13 14 15 16 17 18 19', '20 21 22 23 24 25 26', '27 28 29'])
  assert.deepEqual(k.sh('cal 1 1'), ['     January 1', 'Su Mo Tu We Th Fr Sa', '    1  2  3  4  5  6', ' 7  8  9 10 11 12 13', '14 15 16 17 18 19 20', '21 22 23 24 25 26 27', '28 29 30 31'])
  assert.deepEqual(k.sh('cal 12 9999'), ['   December 9999', 'Su Mo Tu We Th Fr Sa', '          1  2  3  4', ' 5  6  7  8  9 10 11', '12 13 14 15 16 17 18', '19 20 21 22 23 24 25', '26 27 28 29 30 31'])
  // Today's rules carried back: September 1752 is a whole month here.
  assert.deepEqual(k.sh('cal 9 1752').slice(2, 4), ['                1  2', ' 3  4  5  6  7  8  9'])
  assert.equal(k.sh('cal 9 1752').length, 7)
  // A month of six weeks.
  assert.deepEqual(k.sh('cal 5 2026').slice(-2), ['24 25 26 27 28 29 30', '31'])
  k.tick(17 * 86_400_000)
  assert.deepEqual(k.sh('cal').slice(0, 3), ['   December 2026', 'Su Mo Tu We Th Fr Sa', '       1  2  3  4  5'])
})

test('cal: a whole year, three months side by side', () => {
  const k = fresh()
  const year = k.sh('cal 2026')
  assert.equal(year[0], `${' '.repeat(30)}2026`)
  assert.equal(year.length, 35)
  assert.deepEqual(year.slice(1, 5), ['', '      January               February               March',
    'Su Mo Tu We Th Fr Sa  Su Mo Tu We Th Fr Sa  Su Mo Tu We Th Fr Sa', '             1  2  3   1  2  3  4  5  6  7   1  2  3  4  5  6  7'])
  for (const line of year) assert.ok(line.length <= 64 && !line.endsWith(' '), line)
  // Each month in the year is the month alone, cut out of its column.
  for (let month = 1; month <= 12; month++) {
    const top = year.findIndex((l) => l.includes(['January', 'April', 'July', 'October'][Math.floor((month - 1) / 3)]))
    const left = ((month - 1) % 3) * 22
    const alone = k.sh(`cal ${month} 2026`).slice(1)
    const cut = year.slice(top + 1, top + 1 + alone.length).map((l) => l.slice(left, left + 20).trimEnd())
    assert.deepEqual(cut, alone, String(month))
    const after = year[top + 1 + alone.length]
    assert.ok(after === undefined || after === '' || after.slice(left, left + 20).trim() === '', String(month))
  }
  assert.equal(k.sh('cal 1')[0], `${' '.repeat(31)}1`)
  assert.equal(k.sh('cal 9999')[0], `${' '.repeat(30)}9999`)
})

test('cal: a month or a year outside the calendar is refused', () => {
  const k = fresh()
  const use = '!usage: cal [[month] year]'
  for (const year of ['0', '10000', 'x', '20x6', '+5', '']) {
    assert.deepEqual(k.sh(`cal "${year}"; echo $?`), [`!cal: '${year}' is not a year (1 to 9999)`, use, '2'], year)
  }
  for (const month of ['0', '13', 'Nov', '1.5']) assert.deepEqual(k.sh(`cal ${month} 2026; echo $?`), [`!cal: '${month}' is not a month (1 to 12)`, use, '2'], month)
  assert.deepEqual(k.sh('cal 13 0; echo $?'), ["!cal: '0' is not a year (1 to 9999)", use, '2'])
  assert.deepEqual(k.sh('cal -1; echo $?'), ["!cal: unknown option '-1'", use, '2'])
  assert.deepEqual(k.sh('cal 1 2 3; echo $?'), [use, '2'])
})

// which, id, whoami, hostname, uname

test('which: the file each name runs, along PATH', () => {
  const k = fresh()
  assert.deepEqual(k.sh('which date'), ['/bin/date'])
  assert.deepEqual(k.sh('which date sh nosuch man; echo $?'), ['/bin/date', '/bin/sh', '!which: nosuch: not found', '/bin/man', '1'])
  assert.deepEqual(k.sh('which /bin/date ./nosuch /tmp /dev/null ""; echo $?'), ['/bin/date', '!which: ./nosuch: not found', '!which: /tmp: not found', '!which: /dev/null: not found', '!which: : not found', '1'])
  // A command the shell carries out itself has no file.
  assert.deepEqual(k.sh('which cd; echo $?'), ['!which: cd: not found', '1'])
  // Your own directory comes first, but only for a file you may run; a directory of the name is passed over.
  mkdir(k, '/home/operator/bin')
  k.write('/home/operator/bin/date', 'echo mine\n')
  mkdir(k, '/home/operator/bin/cal')
  assert.deepEqual(k.sh('which date cal'), ['/bin/date', '/bin/cal'])
  now(k.system.kernel.vfs.chmod('/home/operator/bin/date', '/', ROOT_CRED, 0o700))
  assert.deepEqual(k.sh('which date cal'), ['/home/operator/bin/date', '/bin/cal'])
  // The PATH it is handed, an empty entry for the working directory, the usual places when there is none.
  assert.deepEqual(k.sh('PATH=/tmp:/bin which date; echo $?'), ['/bin/date', '0'])
  assert.deepEqual(k.sh('cd /home/operator/bin; PATH=:/bin which date'), ['./date'])
  assert.deepEqual(k.sh('env -i /bin/which date env'), ['/bin/date', '/bin/env'])
  assert.deepEqual(k.sh('which; echo $?'), ['!usage: which name ...', '2'])
  assert.deepEqual(k.sh('which -a date; echo $?'), ["!which: unknown option '-a'", '!usage: which name ...', '2'])
})

test('id, whoami, hostname: who and where', () => {
  const k = fresh()
  const use = '!usage: id [-u | -g | -G] [-n]'
  assert.deepEqual(k.sh('id'), ['uid=0(root) gid=0(root)'])
  assert.deepEqual(k.sh('id -u; id -g; id -G; id -un; id -gn; id -Gn; id -n -u'), ['0', '0', '0', 'root', 'root', 'root', 'root'])
  assert.deepEqual(k.sh('id -n; echo $?'), [use, '2'])
  assert.deepEqual(k.sh('id -ug; echo $?'), [use, '2'])
  assert.deepEqual(k.sh('id root; echo $?'), [use, '2'])
  assert.deepEqual(k.sh('id -z; echo $?'), ["!id: unknown option '-z'", use, '2'])
  assert.deepEqual(k.sh('whoami; echo $?'), ['root', '0'])
  assert.deepEqual(k.sh('whoami -z; echo $?'), ["!whoami: unknown option '-z'", '!usage: whoami', '2'])
  assert.deepEqual(k.sh('hostname'), ['crimson-noir'])
  assert.deepEqual(k.sh('hostname other; echo $?; hostname'), ['!usage: hostname', '2', 'crimson-noir'])
  assert.deepEqual(boot(SYS_PROGRAMS, { hostname: 'elsewhere' }).sh('hostname; uname -n'), ['elsewhere', 'elsewhere'])
})

test('uname: the system, the host and the version', () => {
  const k = fresh()
  assert.deepEqual(k.sh('uname'), ['CrimsonNoir'])
  assert.deepEqual(k.sh('uname -a'), ['CrimsonNoir crimson-noir Crimson Noir OS test'])
  assert.deepEqual(k.sh('uname -s; uname -n; uname -v; uname -nv; uname -vs; uname -a -s'),
    ['CrimsonNoir', 'crimson-noir', 'Crimson Noir OS test', 'crimson-noir Crimson Noir OS test', 'CrimsonNoir Crimson Noir OS test', 'CrimsonNoir crimson-noir Crimson Noir OS test'])
  assert.deepEqual(k.sh('uname -r; echo $?'), ["!uname: unknown option '-r'", '!usage: uname [-asnv]', '2'])
  // The version as /proc/version holds it, kept on one line.
  const odd = boot(SYS_PROGRAMS, { version: 'two\nlines\u0007' })
  assert.deepEqual(odd.sh('uname -a'), ['CrimsonNoir crimson-noir two?lines?'])
})

// uptime, dmesg, ps

test('uptime: the time since the start, in the largest units, and the tasks', () => {
  const k = fresh()
  assert.deepEqual(k.sh('uptime'), ['up 0 sec, 3 tasks'])
  const steps: [number, string][] = [
    [59_999, 'up 59 sec'], [1, 'up 1 min'], [120_000, 'up 3 min'], [3_600_000 - 180_000 + 300_000, 'up 1 h 5 min'], [3_300_000, 'up 2 h'],
    [86_400_000 - 7_200_000, 'up 1 day'], [7_500_000, 'up 1 day 2 h 5 min'], [86_400_000, 'up 2 days 2 h 5 min'],
  ]
  for (const [ms, text] of steps) {
    k.tick(ms)
    assert.deepEqual(k.sh('uptime'), [`${text}, 3 tasks`], text)
  }
  assert.match(k.sh('sleep 100 &').join(), /^\[1\] [0-9]+$/)
  assert.deepEqual(k.sh('uptime'), ['up 2 days 2 h 5 min, 5 tasks'])
  assert.deepEqual(k.sh('uptime -p; echo $?'), ["!uptime: unknown option '-p'", '!usage: uptime', '2'])
})

test('dmesg: the kernel\'s log, a line each, oldest first', () => {
  const k = fresh()
  assert.deepEqual(k.sh('dmesg; echo $?'), ['0'])
  k.system.kernel.log('first line')
  k.tick(1500)
  k.system.kernel.log('second line')
  assert.deepEqual(k.sh('dmesg'), ['[     0.000] first line', '[     1.500] second line'])
  assert.deepEqual(k.sh('dmesg > /tmp/o'), [])
  assert.equal(k.read('/tmp/o'), '[     0.000] first line\n[     1.500] second line\n')
  for (let i = 0; i < 250; i++) k.system.kernel.log(`line ${i}`)
  const out = k.sh('dmesg')
  assert.equal(out.length, 200)
  assert.equal(out[0], '[     1.500] line 50')
  assert.equal(out[199], '[     1.500] line 249')
  assert.deepEqual(k.sh('dmesg x; echo $?'), ['!usage: dmesg', '2'])
})

/** The column a heading starts in. */
const column = (head: string, word: string): number => head.indexOf(word)

test('ps: a line per task, in aligned columns', () => {
  const k = fresh()
  const out = k.sh('ps')
  assert.equal(out[0], 'PID  PPID  STATE  STEPS  COMMAND')
  assert.equal(out.length, 4)
  assert.match(out[1], /^  1     0  wait +[0-9]+  init$/)
  assert.match(out[2], /^  2     1  wait +[0-9]+  -sh$/)
  assert.match(out[3], /^ +[0-9]+     2  run +[0-9]+  ps$/)
  const at = column(out[0], 'COMMAND')
  const steps = column(out[0], 'STEPS') + 'STEPS'.length - 1
  for (const line of out.slice(1)) {
    assert.ok(line[at - 1] === ' ' && line[at] !== ' ', line)
    assert.match(line[2] + line[steps], /^[0-9]{2}$/, line)
  }
  assert.deepEqual(k.sh('ps -z; echo $?'), ["!ps: unknown option '-z'", '!usage: ps [-eAf]', '2'])
  assert.deepEqual(k.sh('ps 1; echo $?'), ['!usage: ps [-eAf]', '2'])
})

test('ps -f: the group, what a task waits for, its directory and its arguments', () => {
  const k = fresh()
  assert.deepEqual(k.sh('sleep 10 &'), ['[1] 3'])
  for (const flags of ['-f', '-ef', '-Af', '-e -f']) {
    const out = k.sh(`cd /tmp; ps ${flags}`)
    assert.match(out[0], /^PID  PPID  GROUP  STATE  WAITS  STEPS  DIR +COMMAND$/)
    assert.equal(out.length, 6, flags)
    assert.match(out[1], /^  1     0      1  wait   wait +[0-9]+  \/ +init$/)
    assert.match(out[2], /^  2     1      2  wait   wait +[0-9]+  \/tmp +-sh$/)
    assert.match(out[3], /^  3     2      3  wait   wait +[0-9]+  \/home\/operator  sh$/)
    assert.match(out[4], /^  4     3      3  wait   sleep +[0-9]+  \/home\/operator  sleep 10$/)
    assert.match(out[5], new RegExp(`^ +[0-9]+     2 +[0-9]+  run    - +[0-9]+  /tmp +ps ${literal(flags)}$`))
    const at = column(out[0], 'COMMAND')
    for (const line of out.slice(1)) assert.ok(line[at - 1] === ' ' && line[at] !== ' ', line)
  }
  assert.deepEqual(k.sh('ps -e').length, 6)
  assert.deepEqual(k.sh('ps -A')[0], 'PID  PPID  STATE  STEPS  COMMAND')
  // A task that has ended, before the task that started it has asked how, is listed as ended once.
  k.tick(10_000)
  assert.deepEqual(k.settle(), [])
  const ended = k.sh('ps')
  assert.match(ended[3], /^  3     2  end +[0-9]+  sh$/)
  assert.equal(ended[5], '[1]  Done    sleep 10')
  assert.equal(k.sh('ps').length, 4)
})

// man

test('man: a page, whole', () => {
  const k = fresh()
  assert.deepEqual(k.sh('man cal > /tmp/o; echo $?'), ['0'])
  assert.equal(k.read('/tmp/o'), SYS_MANUAL.cal)
  assert.deepEqual(k.sh('man [ > /tmp/o; echo $?'), ['0'])
  assert.equal(k.read('/tmp/o'), SYS_MANUAL['['])
  assert.deepEqual(k.sh('man date'), SYS_MANUAL.date.slice(0, -1).split('\n'))
  assert.deepEqual(k.sh('man nosuch; echo $?'), ['!man: no page for nosuch', '1'])
  // A page is one name in the manual's directory: a path is no page, whatever it leads to.
  for (const name of ['.', '..', '../man/cal', '/usr/share/man/cal', 'Cal']) {
    assert.deepEqual(k.sh(`man ${name}; echo $?`), [`!man: no page for ${name}`, '1'], name)
  }
  assert.deepEqual(k.sh('man cal date; echo $?'), ['!usage: man [name]', '!       man -k word', '2'])
  assert.deepEqual(k.sh('man -z; echo $?'), ["!man: unknown option '-z'", '!usage: man [name]', '!       man -k word', '2'])
  // With no manual at all.
  const bare = boot(SYS_PROGRAMS)
  assert.deepEqual(bare.sh('man; echo $?; man cal; echo $?'), ['0', '!man: no page for cal', '1'])
})

test('man: every page with its summary, sorted and aligned', () => {
  const k = fresh()
  const out = k.sh('man')
  const expected = NAMES.map((name) => `${name.padEnd(8)}  ${SYS_MANUAL[name].split('\n')[1].slice(`    ${name} - `.length)}`)
  assert.deepEqual(out, expected)
  assert.equal(out[0], '[         ask a question about files, text or numbers, written in brackets')
  assert.equal(out[1], 'cal       print a calendar')
  // Pages that are odd in shape: no summary line, no line at all, a control character in the summary.
  const odd = boot(SYS_PROGRAMS, { manual: { zeta: 'NAME\n    zeta - a\u0007b\n', bare: 'just text\n', empty: '', long: `NAME\n    long - ${'x'.repeat(5000)}\n` } })
  assert.deepEqual(odd.sh('man > /tmp/o; echo $?'), ['0'])
  assert.equal(odd.read('/tmp/o'), `bare\nempty\nlong   ${'x'.repeat(5000)}\nzeta   a?b\n`)
  assert.deepEqual(odd.sh('man -k A?B; man -k JUST; echo $?'), ['zeta  a?b', "!man: nothing about 'JUST'", '1'])
})

test('man -k: the pages whose name or summary holds a word, in any letter case', () => {
  const k = fresh()
  assert.deepEqual(k.sh('man -k calendar'), ['cal  print a calendar'])
  assert.deepEqual(k.sh('man -k CALENDAR'), ['cal  print a calendar'])
  assert.deepEqual(k.sh('man -k TiMe'), [
    'date     print the day and the time', 'sleep    wait for a length of time', 'time     run a command and say how long it took',
    'timeout  run a command, and stop it if it takes too long', 'uptime   print how long the system has been running',
  ])
  assert.deepEqual(k.sh("man -k 'the name'"), ['hostname  print the name of this system', 'uname     print the name and the version of the system', 'whoami    print the name of the user you are'])
  assert.deepEqual(k.sh('man -k [; echo $?'), ['[  ask a question about files, text or numbers, written in brackets', '0'])
  assert.deepEqual(k.sh('man -k zzz; echo $?'), ["!man: nothing about 'zzz'", '1'])
  assert.deepEqual(k.sh("man -k '.*'; echo $?"), ["!man: nothing about '.*'", '1'])
  assert.deepEqual(k.sh('man -k; echo $?'), ['!usage: man [name]', '!       man -k word', '2'])
  assert.deepEqual(k.sh('man -k a b; echo $?'), ['!usage: man [name]', '!       man -k word', '2'])
  assert.equal(k.sh('man -k ""').length, NAMES.length)
})

// timeout, time

test('timeout: the command\'s own status when it ends in time', () => {
  const k = fresh()
  // A command that ends at once is answered at once: the clock does not move.
  assert.deepEqual(k.sh('timeout 5 true; echo $?; timeout 5 false; echo $?; timeout 5 sh -c "exit 9"; echo $?'), ['0', '1', '9'])
  // It looks at the command every 20 milliseconds, so an ending is noticed at most that much later.
  assert.deepEqual(k.sh('timeout 5 sleep 1; echo $?'), [])
  k.tick(999)
  assert.deepEqual(k.settle(), [])
  k.tick(1)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.system.kernel.ps().map((p) => `${p.name} ${p.state}`), ['init wait', '-sh wait', 'timeout wait', 'sleep end'])
  k.tick(19)
  assert.deepEqual(k.settle(), ['0'])
  // One that ends as timeout wakes is seen at once.
  assert.deepEqual(k.sh('timeout 5 sleep 0.02; echo $?'), [])
  k.tick(20)
  assert.deepEqual(k.settle(), ['0'])
  // No limit at all.
  assert.deepEqual(k.sh('timeout 0 sleep 2000; echo $?'), [])
  k.tick(2_000_000)
  assert.deepEqual(k.settle(), ['0'])
  // What the command prints passes through, and input from a pipe reaches it.
  assert.deepEqual(k.sh("timeout 5 sh -c 'echo one; sleep 2; echo two'; echo $?"), ['one'])
  k.tick(2000)
  assert.deepEqual(k.settle(), ['two'])
  k.tick(20)
  assert.deepEqual(k.settle(), ['0'])
  assert.deepEqual(k.sh("echo hi | timeout 5 sh -c 'read x; echo got $x'"), ['got hi'])
  // It cannot read what is typed: that input ends at once.
  assert.deepEqual(k.sh("timeout 5 sh -c 'read x; echo $?'"), ['1'])
  withGreet(k)
  assert.deepEqual(k.sh('timeout 5 greet you; echo $?'), ['hello you', '0'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('timeout: a command still running when the time is up is stopped, with what it started, and the status is 124', () => {
  const k = fresh()
  assert.deepEqual(k.sh('timeout 1 sleep 5; echo $?'), [])
  assert.deepEqual(tasks(k), [...AT_REST, 'timeout', 'sleep'])
  const group = k.system.kernel.ps()
  assert.equal(group[3].pgid, group[3].pid)
  assert.notEqual(group[3].pgid, group[2].pgid)
  k.tick(999)
  assert.deepEqual(k.settle(), [])
  k.tick(1)
  assert.deepEqual(k.settle(), ['124'])
  assert.deepEqual(tasks(k), AT_REST)
  const limits: [string, string, number][] = [['0.5', 'sleep 1', 500], ['1m', 'sleep 2m', 60_000], ['.25s', 'sleep 1', 250], ['1h', 'sleep 2h', 3_600_000]]
  for (const [limit, cmd, ms] of limits) {
    assert.deepEqual(k.sh(`timeout ${limit} ${cmd}; echo $?`), [], limit)
    k.tick(ms - 1)
    assert.deepEqual(k.settle(), [], limit)
    k.tick(1)
    assert.deepEqual(k.settle(), ['124'], limit)
  }
  // The tasks the command started are stopped with it, and print nothing later.
  assert.deepEqual(k.sh("timeout 1 sh -c 'echo one; sleep 5; echo late'; echo $?"), ['one'])
  assert.deepEqual(tasks(k), [...AT_REST, 'timeout', 'sh', 'sleep'])
  k.tick(1000)
  assert.deepEqual(k.settle(), ['124'])
  assert.deepEqual(tasks(k), AT_REST)
  k.tick(10_000)
  assert.deepEqual(k.settle(), [])
})

test('timeout: Ctrl+C stops it and the command; a command that cannot start; wrong calls', () => {
  const k = fresh()
  assert.deepEqual(k.sh('timeout 10 sleep 5; echo after'), [])
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(tasks(k), AT_REST)
  k.tick(20_000)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('timeout 1 nosuch; echo $?'), ['!timeout: nosuch: not found', '127'])
  assert.deepEqual(k.sh('timeout 1 /tmp; echo $?'), ['!timeout: /tmp: is a directory', '126'])
  k.write('/tmp/text', 'echo hi\n')
  assert.deepEqual(k.sh('timeout 1 /tmp/text; echo $?'), ['!timeout: /tmp/text: permission denied', '126'])
  const use = '!usage: timeout seconds command [argument ...]'
  assert.deepEqual(k.sh('timeout x sleep 1; echo $?'), ["!timeout: 'x' is not a length of time", use, '2'])
  assert.deepEqual(k.sh('timeout 1d sleep 1; echo $?'), ["!timeout: '1d' is not a length of time", use, '2'])
  assert.deepEqual(k.sh('timeout 1; echo $?; timeout; echo $?'), [use, '2', use, '2'])
  assert.deepEqual(k.sh('timeout -s TERM 1 sleep 1; echo $?'), ["!timeout: unknown option '-s'", use, '2'])
  assert.deepEqual(tasks(k), AT_REST)
})

test('time: how long a command took, on the error output, and the command\'s status', () => {
  const k = fresh()
  assert.deepEqual(k.sh('time sleep 1; echo $?'), [])
  k.tick(1000)
  assert.deepEqual(k.settle(), ['!real 1.00s', '0'])
  assert.deepEqual(k.sh('time sleep 0.25'), [])
  k.tick(250)
  assert.deepEqual(k.settle(), ['!real 0.25s'])
  assert.deepEqual(k.sh('time sleep 1h'), [])
  k.tick(3_600_000)
  assert.deepEqual(k.settle(), ['!real 3600.00s'])
  assert.deepEqual(k.sh('time false; echo $?'), ['!real 0.00s', '1'])
  assert.deepEqual(k.sh('time sh -c "echo out; exit 3"; echo $?'), ['out', '!real 0.00s', '3'])
  // The line does not go where the command's output goes.
  assert.deepEqual(k.sh('time sh -c "echo out" > /tmp/o'), ['!real 0.00s'])
  assert.equal(k.read('/tmp/o'), 'out\n')
  assert.deepEqual(k.sh('time nosuch; echo $?'), ['!time: nosuch: not found', '127'])
  assert.deepEqual(k.sh('time /tmp; echo $?'), ['!time: /tmp: is a directory', '126'])
  withGreet(k)
  assert.deepEqual(k.sh('time greet you'), ['hello you', '!real 0.00s'])
  assert.deepEqual(k.sh('time; echo $?'), ['!usage: time command [argument ...]', '2'])
  assert.deepEqual(k.sh('time -p sleep 1; echo $?'), ["!time: unknown option '-p'", '!usage: time command [argument ...]', '2'])
  // Ctrl+C stops it and the command: no time is printed.
  assert.deepEqual(k.sh('time sleep 5'), [])
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(tasks(k), AT_REST)
})
