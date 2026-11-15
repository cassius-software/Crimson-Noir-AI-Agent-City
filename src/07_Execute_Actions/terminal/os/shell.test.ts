// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the shell (shell.ts) and its `test` (cond.ts) to what they promise at the prompt
 * and in a script: every expansion (variables and the ${} forms, $( ) in its own task, sums, patterns against the file
 * system up to their limit, word splitting), pipelines and lists and the status they carry, background jobs,
 * redirections that put every descriptor back on every path, each builtin's options, refusals and status, scripts run
 * by name or by sh, the city's own commands inside pipes and lists (lines that arrive later, answers the host shows
 * itself, Ctrl+C giving up the wait), Ctrl+C and Ctrl+D at every moment, the caps on nesting, and the console's own
 * shell starting again. It began with what the reviewers of the programs proved the shell once got wrong: a program
 * the shell runs in its own place that meets a closed pipe ends quietly, a line of thousands of `!` is answered
 * rather than ending the shell, two long numbers are never compared after rounding, a city command inside `$( )` ends
 * at the `)` that closes it, and a builtin whose write is refused fails alone, without taking the rest of the line.
 * What breaks if it is removed? Any of those could change without a test noticing: a descriptor or a task lost on
 * every failed line until nothing more can start, a loop or a long value that holds the page up, a wait that Ctrl+C
 * cannot end, a long pasted line run as two commands, `printenv BIG | true` printing a broken-pipe complaint again.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OsError } from './errno.ts'
import { FILE_PROGRAMS } from './fileutils.ts'
import { ROOT_CRED } from './fs.ts'
import { PROCS_MAX } from './kernel.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'
import { PIPE_MAX } from './pipe.ts'
import type { CityHost, CityLine } from './shell.ts'
import { SYS_MANUAL, SYS_PROGRAMS } from './sysutils.ts'
import { Later, now } from './task.ts'
import { TEXT_PROGRAMS } from './textutils.ts'

const programs = { ...FILE_PROGRAMS, ...SYS_PROGRAMS }
/** Every program the tests below lean on: files, text and the system's own. */
const all = { ...FILE_PROGRAMS, ...SYS_PROGRAMS, ...TEXT_PROGRAMS }

/** The number of the console's own shell (it changes when the shell is started again). */
function shellPid(k: Kit): number {
  return k.system.kernel.ps().find((p) => p.argv[0] === '-sh' && p.state !== 'end')?.pid ?? 0
}

/** The descriptors the console's shell holds open, straight from the kernel's table. */
function descriptors(k: Kit): number[] {
  const out: number[] = []
  for (const [fd, ch] of (k.system.kernel.proc(shellPid(k))?.fds ?? []).entries()) if (ch !== null && ch !== undefined) out.push(fd)
  return out
}

/** Tasks that ended and that nobody has collected: each holds a place in the task table. */
function uncollected(k: Kit): string[] {
  return k.system.kernel.ps().filter((p) => p.state === 'end').map((p) => `${p.pid} ${p.name}`)
}

test('a program run in the shell\'s own place that meets a closed pipe ends quietly, with 141', () => {
  const k = boot(programs, { manual: SYS_MANUAL })
  k.write('/tmp/big', 'x'.repeat(81920))
  // The last command of a pipe runs in place of the shell task (exec): its closed pipe is the program's own end.
  assert.deepEqual(k.sh('BIG=$(cat /tmp/big); export BIG; printenv BIG | true; echo $?'), ['0'])
  assert.deepEqual(k.sh('sh -c "printenv BIG" | true; echo $?'), ['0'])
  assert.deepEqual(k.sh('cat /tmp/big /tmp/big | true; echo $?'), ['0'])
  // A program that fails after it started is the program's failure, said by the kernel, never "not found".
  assert.deepEqual(k.sh('sh -c "cat /tmp/big > /dev/full"; echo $?'), ['!cat: write error: no space left on device', '1'])
})

test('test: a line of thousands of ! is counted, not recursed into', () => {
  const k = boot(programs, { manual: SYS_MANUAL })
  k.sh("x='!'; for i in 0 1 2 3 4 5 6 7 8 9 10 11 12 13; do x=\"$x $x\"; done")
  // 16384 of them: an even number, so the answer is the word's own.
  assert.deepEqual(k.sh('/bin/test $x y; echo $?; test $x y; echo $?; [ $x ! y ]; echo $?'), ['0', '0', '1'])
  // A last ! is a word, not an operator.
  assert.deepEqual(k.sh('[ ! ! ]; echo $?; [ ! ]; echo $?'), ['1', '0'])
})

test('test: whole numbers compare exactly, and one too long to be exact is refused', () => {
  const k = boot(programs, { manual: SYS_MANUAL })
  assert.deepEqual(k.sh('[ 9007199254740991 -gt 9007199254740990 ]; echo $?; [ " 007 " -eq 7 ]; echo $?; [ -3 -lt +2 ]; echo $?'), ['0', '0', '0'])
  assert.deepEqual(k.sh('/bin/test 99999999999999999999 -eq 99999999999999999998; echo $?'), [
    "!test: '99999999999999999999' is too large to be exact",
    '2',
  ])
  assert.deepEqual(k.sh('[ 9007199254740993 -eq 9007199254740992 ]; echo $?'), ["![: '9007199254740993' is too large to be exact", '2'])
})

/** A city of three commands that answers with what it was given: its name, its arguments and the line. */
const ECHO_CITY: CityHost = {
  has: (name) => name === 'time' || name === 'laws' || name === 'noir',
  whole: (name) => name === 'noir',
  run: (name, args, line) => ({ lines: [{ text: `${name}[${args.join('|')}] ${line}`, err: false }], later: null }),
}

test('a city command inside $( ) ends at the ) that closes it, quotes and its own brackets aside', () => {
  const k = boot(programs, { manual: SYS_MANUAL, city: ECHO_CITY })
  assert.deepEqual(k.sh('echo "it is $(time)"'), ['it is time[] time'])
  assert.deepEqual(k.sh('x=$(laws a b); echo "[$x]"'), ['[laws[a|b] laws a b]'])
  assert.deepEqual(k.sh('echo $(time ")" x)'), ['time[)|x] time ")" x'])
  // One that takes its line whole takes it up to the ) that no ( of its own opened.
  assert.deepEqual(k.sh('echo "$(noir print(1) + (2))" after'), ['noir[print(1) + (2)] noir print(1) + (2) after'])
  assert.deepEqual(k.sh('echo $(echo $(time 12:00))'), ['time[12:00] time 12:00'])
  // Outside $( ) a ) is still one of the command's own words, as the console has always read it.
  assert.deepEqual(k.sh('time a ) b'), ['time[a|)|b] time a ) b'])
  assert.deepEqual(k.sh('echo still here'), ['still here'])
})

test('a builtin whose write is refused fails alone: said, status 1, and the line goes on', () => {
  const k = boot(programs, { manual: SYS_MANUAL })
  assert.deepEqual(k.sh('echo lost > /dev/full; echo "next $?"'), ['!ash: echo: no space left on device', 'next 1'])
  assert.deepEqual(k.sh('pwd > /dev/full || echo refused'), ['!ash: pwd: no space left on device', 'refused'])
})

// Expansion.

test('variables and the ${} forms: set, empty and unset each take their own branch', () => {
  const k = boot(all)
  k.sh('s=val; e=')
  assert.deepEqual(k.sh('echo "[$s][$e][$n][${s}x]"'), ['[val][][][valx]'])
  assert.deepEqual(k.sh('echo "[${s:-d}][${e:-d}][${n:-d}][${e-d}][${n-d}]"'), ['[val][d][d][][d]'])
  assert.deepEqual(k.sh('echo "[${s:+a}][${e:+a}][${e+a}][${n+a}]"'), ['[a][][a][]'])
  // := and = give the variable the word as well; a special parameter cannot be given one this way.
  assert.deepEqual(k.sh('echo "[${n:=dflt}][$n][${e=kept}][${e:=filled}][$e]"'), ['[dflt][dflt][][filled][filled]'])
  assert.deepEqual(k.sh('echo ${1:=a}; echo not here'), ['!ash: 1: cannot be given a value this way'])
  assert.deepEqual(k.sh('echo ${#s} ${#n} ${#none} ${#}'), ['3 4 0 0'])
  // ? passes a set value (even an empty one, without the colon); otherwise it says why and gives the line up, status 2.
  assert.deepEqual(k.sh('z=; echo "[${s?}][${z?}][${s:?}]"'), ['[val][][val]'])
  assert.deepEqual(k.sh('echo ${none:?gone wrong}; echo not here'), ['!ash: none: gone wrong'])
  assert.deepEqual(k.sh('echo $?'), ['2'])
  assert.deepEqual(k.sh('echo ${none?}'), ['!ash: none: parameter not set'])
  // An empty value is set: the message says what is true of it.
  assert.deepEqual(k.sh('echo ${z:?}'), ['!ash: z: parameter is empty'])
  // The special parameters.
  assert.deepEqual(k.sh('echo "$- $0 $#"; false; echo $?'), ['i sh 0', '1'])
})

test('the trims cut the shortest or longest match from either end, and a quoted pattern matches only itself', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('v=foo.tar.gz; echo ${v%.*} ${v%%.*} ${v#*.} ${v##*.} ${v%.zip} ${v#} ${none%x}.'), ['foo.tar foo tar.gz gz foo.tar.gz foo.tar.gz .'])
  assert.deepEqual(k.sh('p=/home/operator/notes.txt; echo ${p##*/} ${p%/*} ${p#/home/}'), ['notes.txt /home/operator operator/notes.txt'])
  assert.deepEqual(k.sh('w=\'a*b\'; echo ${w#"a*"} ${w#a*} "${w%"*b"}" ${w%\\*b} ${w%[b]}'), ['b *b a a a*'])
})

test('a trim of a long value counts its steps: the others keep their turns, and Ctrl+C gives it up', () => {
  const k = boot(all)
  k.write('/tmp/long', 'x'.repeat(4000))
  k.sh('v=$(cat /tmp/long)')
  // `*y` never matches: every one of the 4001 ends is tried, each a walk along the value.
  k.system.type('t=${v%*y}; echo done')
  assert.deepEqual(k.system.run(2000, Number.POSITIVE_INFINITY), [])
  assert.equal(k.system.idle, false)
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $? "[${t-unset}]"'), ['130 [unset]'])
  // Left alone it finishes with the right answer.
  assert.deepEqual(k.sh('t=${v%*y}; echo ${#t} ${#v}; u=${v#x*}; echo ${#u} [${v##x*}]'), ['4000 4000', '3999 []'])
})

test('$( ) runs in its own task: its output without the line ends at its end, split unless quoted', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('x=$(printf "a  b\\n\\n\\n"); echo "[$x]"; echo [$x]'), ['[a  b]', '[a b]'])
  assert.deepEqual(k.sh('echo "$(echo one; echo two)"; echo $(echo one; echo two)'), ['one', 'two', 'one two'])
  // What it changes stays in its task.
  assert.deepEqual(k.sh('x=$(cd /; pwd; y=inner); pwd; echo "[$x][${y-unset}]"'), ['/home/operator', '[/][unset]'])
  // A command that is only assignments has the status of its last $( ); exit inside one ends that task only.
  assert.deepEqual(k.sh('x=$(exit 3); echo $?; x=$(true); echo $?; x=$(sh -c "exit 4"); echo $?'), ['3', '0', '4'])
  assert.deepEqual(k.sh('echo "[$(exit 5)]" $?'), ['[] 0'])
  assert.deepEqual(k.sh('echo $(cat /nonexistent) after'), ['!cat: /nonexistent: no such file or directory', 'after'])
  assert.deepEqual(uncollected(k), [])
})

test('$$ is the shell\'s own number, in the tasks it starts for a pipe or a $( ) too', () => {
  const k = boot(all)
  const pid = String(shellPid(k))
  assert.deepEqual(k.sh('echo $$; echo $(echo $$); echo $$ | cat; { echo $$; } | cat'), [pid, pid, pid, pid])
  // A shell started as a program has its own.
  const inner = k.sh('sh -c "echo \\$\\$"')
  assert.equal(inner.length, 1)
  assert.notEqual(inner[0], pid)
})

test('$( ) whose output is too much to keep is refused, and its task is still collected', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('x=$(yes); echo not here'), ['!ash: too much to hold in memory'])
  assert.deepEqual(k.sh('echo $? "[${x-unset}]"'), ['1 [unset]'])
  assert.deepEqual(uncollected(k), [])
  assert.deepEqual(descriptors(k), [0, 1, 2])
})

test('$( ) and source nest at most 32 deep (NEST_MAX), and a refusal leaves nothing behind', () => {
  const k = boot(all)
  const nested = (n: number): string => {
    let line = 'echo bottom'
    for (let i = 0; i < n; i++) line = `echo $(${line})`
    return line
  }
  assert.deepEqual(k.sh(`${nested(32)}; echo $?`), ['bottom', '0'])
  // The 33rd is refused inside its own task: the words around it are what is left.
  assert.deepEqual(k.sh(`${nested(33)}; echo $?`), ['!ash: command substitution nested too deep', '', '0'])
  // 32 scripts that read the next one are fine; a 33rd is refused, and the line is given up.
  for (let i = 1; i <= 33; i++) k.write(`/tmp/n${i}`, i === 32 ? 'echo deepest\n' : `. /tmp/n${i + 1}\n`)
  assert.deepEqual(k.sh('. /tmp/n1; echo $?'), ['deepest', '0'])
  // A pipeline's stage or a job is no level of its own: the same 32 run there too (they were refused), and 33 are not.
  assert.deepEqual(k.sh(`${nested(32)} | cat; . /tmp/n1 | cat; true | . /tmp/n1`), ['bottom', 'deepest', 'deepest'])
  assert.deepEqual(k.sh(`${nested(32)} & wait`).slice(1), ['bottom'])
  assert.deepEqual(k.sh(`${nested(33)} | cat`), ['!ash: command substitution nested too deep', ''])
  k.write('/tmp/n32', '. /tmp/n33\n')
  k.write('/tmp/n33', 'echo too deep\n')
  assert.deepEqual(k.sh('. /tmp/n1; echo not here'), ['!ash: scripts that read scripts nested too deep'])
  assert.deepEqual(k.sh('echo $?'), ['2'])
  k.write('/tmp/self', '. /tmp/self\n')
  assert.deepEqual(k.sh('. /tmp/self'), ['!ash: scripts that read scripts nested too deep'])
  // The count went back down: a script one level deep still runs.
  assert.deepEqual(k.sh('. /tmp/n33'), ['too deep'])
  assert.deepEqual(uncollected(k), [])
  assert.deepEqual(descriptors(k), [0, 1, 2])
})

test('lists nest at most 256 deep in one task (DEPTH_MAX), counting through source: deeper is refused, never a fault', () => {
  const k = boot(all)
  const pid = shellPid(k)
  // Each read of this script runs 31 loops and an if inside one another: 33 lists more. Seven reads fit; eight do not,
  // and without the cap the host's own stack ran out (the console's shell faulted and was started again).
  let body = 'n=$((n+1)); if [ $n -lt $max ]; then . /tmp/deep; else echo "bottom $n"; fi'
  for (let i = 0; i < 31; i++) body = `while :; do ${body}; break; done`
  k.write('/tmp/deep', `${body}\n`)
  assert.deepEqual(k.sh('n=0; max=7; . /tmp/deep; echo $?'), ['bottom 7', '0'])
  assert.deepEqual(k.sh('n=0; max=8; . /tmp/deep; echo not here'), ['!ash: commands nested too deep'])
  assert.deepEqual(k.sh('echo $? $n'), ['2 7'])
  assert.equal(shellPid(k), pid)
  // What was counted on the way in was counted back out: the same script, a loop and break run as before.
  assert.deepEqual(k.sh('n=0; max=7; . /tmp/deep; for i in 1 2; do break; done; echo $?'), ['bottom 7', '0'])
  assert.deepEqual(descriptors(k), [0, 1, 2])
})

test('sums: $(( )) is a whole number, and one that is malformed gives the line up with status 2', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('echo $((1 + 2 * 3)) "$((7 / 2))" $((7 % 3)) $((-(3))) $((1 < 2)) $((unset))'), ['7 3 1 -3 1 0'])
  assert.deepEqual(k.sh('x=4; echo $((x * x)) $(($x + 1)) "$(( $(echo 6) * 7 ))"'), ['16 5 42'])
  assert.deepEqual(k.sh('echo $((1 / 0)); echo not here'), ['!ash: $((1 / 0)): division by zero'])
  assert.deepEqual(k.sh('echo $?'), ['2'])
})

test('patterns: the matching names in order; one that matches nothing stays; quotes and dots keep their meaning', () => {
  const k = boot(all)
  k.sh('mkdir -p /tmp/g/d')
  for (const name of ['a.txt', 'b.txt', 'c.md', '.hidden', 'd/x']) k.write(`/tmp/g/${name}`, '')
  assert.deepEqual(k.sh('cd /tmp/g; echo *; echo *.txt; echo ?.md; echo [!a]*; echo [a-b].*; echo .*; echo */x; echo /tmp/g/*.md'), [
    'a.txt b.txt c.md d', 'a.txt b.txt', 'c.md', 'b.txt c.md d', 'a.txt b.txt', '.hidden', 'd/x', '/tmp/g/c.md',
  ])
  assert.deepEqual(k.sh('echo "*" \'*.txt\' \\* nothing* d/*/y; p="*.txt"; echo $p "$p"'), ['* *.txt * nothing* d/*/y', 'a.txt b.txt *.txt'])
  // A pattern that ends in a slash names directories only, and keeps the slash.
  assert.deepEqual(k.sh('echo */; echo [a-d]*/; echo *.txt/; echo /tmp/g/*/; cd'), ['d/', 'd/', '*.txt/', '/tmp/g/d/'])
})

test('a pattern may match 16384 names (MATCHES_MAX) and no more', () => {
  const k = boot(all)
  const vfs = k.system.kernel.vfs
  now(vfs.mkdir('/home/operator/m', '/', ROOT_CRED))
  for (let i = 0; i < 128; i++) {
    now(vfs.mkdir(`/home/operator/m/${i}`, '/', ROOT_CRED))
    for (let j = 0; j < 128; j++) now(vfs.mkdir(`/home/operator/m/${i}/${j}`, '/', ROOT_CRED))
  }
  assert.deepEqual(k.sh('echo m/*/* | wc -w'), ['16384'])
  now(vfs.mkdir('/home/operator/m/0/one-more', '/', ROOT_CRED))
  assert.deepEqual(k.sh('echo m/*/*; echo not here'), ['!ash: a pattern matches too many names'])
  assert.deepEqual(k.sh('echo $?; echo m/0/1*/ | wc -w'), ['2', '39'])
})

test('word splitting: blanks cut an unquoted expansion, an empty one vanishes, and "$@" keeps each argument whole', () => {
  const k = boot(all)
  const split = 'x="  a   b  "; for w in $x; do echo "<$w>"; done; e=; for w in $e; do echo never; done; for w in "$e"; do echo "<$w>"; done'
  assert.deepEqual(k.sh(`${split}; echo "x\${e}y"`), ['<a>', '<b>', '<>', 'xy'])
  assert.deepEqual(k.sh("sh -c 'for a in \"$@\"; do echo \"[$a]\"; done; echo \"$#\" \"$*\" \"$0\" ${#1}; for a in $@; do echo \"<$a>\"; done' name 'a b' c"), [
    '[a b]', '[c]', '2 a b c name 3', '<a>', '<b>', '<c>',
  ])
  assert.deepEqual(k.sh("sh -c 'for a in \"$@\"; do echo never; done; echo \"[$@]\" \"[x$@]\" $#'"), ['[] [x] 0'])
  assert.deepEqual(k.sh('echo ~ ~/a ~root ~operator ~nobody x~ "~"; a=~/z; echo $a'), [
    '/home/operator /home/operator/a /home/operator /home/operator ~nobody x~ ~', '/home/operator/z',
  ])
})

test('a word expands to at most 64 MiB (WORD_MAX), a command to twice that: a value that doubles is refused, never a fault', () => {
  const k = boot(all)
  const pid = shellPid(k)
  // Without the cap the value doubled until the host refused to hold it, and the console's shell faulted.
  assert.deepEqual(k.sh('x=a; while :; do x="$x$x"; done; echo not here'), ['!ash: a word may expand to at most 67108864 characters'])
  assert.deepEqual(k.sh('echo $? ${#x}; echo "$x" | wc -c'), ['2 67108864', '67108865'])
  // Each word fits, all of them together do not.
  assert.deepEqual(k.sh(': "$x" "$x"; echo not here'), ['!ash: the words of a command may expand to at most 134217728 characters'])
  assert.deepEqual(k.sh('echo $?; unset x'), ['2'])
  assert.equal(shellPid(k), pid)
})

test('the words of a command expand to at most 262144 fields (FIELDS_MAX): a long value split at every blank is refused at once', () => {
  const k = boot(all)
  // 262145 lines of one letter: one field too many. Without the cap a value of a few MiB split this way held the page up
  // for seconds, and one of 64 MiB took more memory than the host had.
  k.sh('x=$(yes | head -c 524290)')
  assert.deepEqual(k.sh('for w in $x; do :; done; echo not here'), ['!ash: a command may expand to at most 262144 words'])
  // The command's own name counts too.
  assert.deepEqual(k.sh('echo $?; : ${x#y?}; echo not here'), ['2', '!ash: a command may expand to at most 262144 words'])
  // One fewer fits; quoted, the value is one field.
  assert.deepEqual(k.sh('echo ${x#y?y?} | wc -w; echo "$x" | wc -l; unset x'), ['262143', '262145'])
})

// Pipelines, lists, jobs.

test('a pipeline runs each stage as its own task, carries the last stage\'s status, and runs the last in place of the shell', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('y=0; y=1 | true; cd /tmp | true; echo a | read r; echo "$y $(pwd) [${r-unset}]"'), ['0 /home/operator [unset]'])
  assert.deepEqual(k.sh('false | true; echo $?; true | false; echo $?; true | exit 4; echo $?; ! true | false; echo $?; ! true; echo $?'), [
    '0', '1', '4', '0', '1',
  ])
  assert.deepEqual(k.sh('false && echo no || echo yes; true && echo and; false || false; echo $?; true; false; echo $?'), ['yes', 'and', '1', '1'])
  // ps is the last stage: it runs in the stage's own task, whose parent is the shell itself.
  const row = k.sh('true | ps').find((l) => / ps$/.test(l)) ?? ''
  assert.equal(row.trim().split(/\s+/)[1], String(shellPid(k)), row)
  assert.deepEqual(k.sh('printf "c\\nb\\na\\n" | sort | head -2 | tr a-z A-Z'), ['A', 'B'])
})

test('a stage writing to a closed pipe ends quietly, builtin or program, and leaves no task behind', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('yes | head -2; echo $?'), ['y', 'y', '0'])
  assert.deepEqual(k.sh('while :; do echo y; done | head -1; echo $?'), ['y', '0'])
  assert.deepEqual(k.sh('{ while :; do echo y; done; } | true; echo $?'), ['0'])
  assert.deepEqual(k.sh('sh -c "while :; do echo z; done" | head -1'), ['z'])
  assert.deepEqual(uncollected(k), [])
  assert.equal(k.system.kernel.ps().length, 2)
})

test('a pipeline that cannot start all its stages says so and leaves no task or descriptor behind', () => {
  const k = boot(all)
  const line = Array.from({ length: PROCS_MAX + 6 }, () => 'true').join(' | ')
  assert.deepEqual(k.sh(`${line}; echo $?`), ['!ash: cannot start a pipeline: too many tasks', '1'])
  assert.deepEqual(uncollected(k), [])
  assert.equal(k.system.kernel.ps().length, 2)
  assert.deepEqual(descriptors(k), [0, 1, 2])
  assert.deepEqual(k.sh('echo a | cat'), ['a'])
  // Stages that did start are stopped, not left to read the terminal: the next typed line is the shell's again.
  const readers = Array.from({ length: PROCS_MAX + 6 }, () => 'cat').join(' | ')
  assert.deepEqual(k.sh(`${readers}; echo $?`), ['!ash: cannot start a pipeline: too many tasks', '1'])
  assert.equal(k.system.atPrompt, true)
  assert.equal(k.system.capturing, false)
  assert.deepEqual(k.sh('echo typed'), ['typed'])
  assert.deepEqual(uncollected(k), [])
  assert.equal(k.system.kernel.ps().length, 2)
})

test('background jobs: the shell says the job and its number, jobs lists it, and the prompt says how it ended', () => {
  const k = boot(all)
  const first = k.sh('sleep 100 & echo "[$!]"')
  assert.equal(first.length, 2)
  const pid = /^\[1\] (\d+)$/.exec(first[0])?.[1]
  assert.ok(pid !== undefined, first[0])
  assert.equal(first[1], `[${pid}]`)
  assert.deepEqual(k.sh('jobs'), ['[1]  Running    sleep 100'])
  // The report waits for the prompt: it comes before what the next line prints.
  k.tick(100000)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('jobs; echo next'), ['[1]  Done    sleep 100', 'next'])
  const second = k.sh('sh -c "exit 3" &')
  assert.match(second[0] ?? '', /^\[1\] \d+$/)
  assert.deepEqual(k.sh('echo next'), ['next', '[1]  Exit 3    sh -c "exit 3"'])
  // A job's input is nothing at all: it never takes a line meant for the shell.
  assert.deepEqual(k.sh('cat & wait; echo "waited $?"').slice(1), ['waited 0'])
})

test('wait collects a job\'s status, fg brings one back, stop ends one; each refuses what is not a job', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('sleep 5 & sleep 9 &').map((l) => l.replace(/\d+$/, 'N')), ['[1] N', '[2] N'])
  assert.deepEqual(k.sh('wait %1; echo "wait $?"'), [])
  k.tick(5000)
  assert.deepEqual(k.settle(), ['wait 0'])
  assert.deepEqual(k.sh('jobs'), ['[2]  Running    sleep 9'])
  assert.deepEqual(k.sh('fg; echo "fg $?"'), ['sleep 9'])
  k.tick(4000)
  assert.deepEqual(k.settle(), ['fg 0'])
  assert.deepEqual(k.sh('sh -c "exit 6" & wait $!; echo $?').slice(1), ['6'])
  assert.deepEqual(k.sh('wait %9; echo $?; wait 999; echo $?; wait abc; echo $?'), ['!wait: %9: no such job', '127', '127', '!wait: abc: no such job', '127'])
  assert.deepEqual(k.sh('fg; echo $?; fg %4; echo $?; fg 1; echo $?'), [
    '!fg: current: no such job', '1', '!fg: %4: no such job', '1', '!fg: 1: no such job', '1',
  ])
  assert.deepEqual(k.sh('stop; echo $?; stop %9; echo $?; stop 999; echo $?; stop 1; echo $?'), [
    '!usage: stop <task number>|%<job> ...', '2', '!stop: %9: no such job', '1', '!stop: 999: no such task', '1', '!stop: 1: task 1 cannot be stopped', '1',
  ])
  // stop ends the whole job: its shell and every program it started.
  assert.equal(k.sh('sleep 50 &').length, 1)
  // A job asked to stop ends after the line that asked: the first prompt after that says so.
  assert.deepEqual(k.sh('stop %1; echo $?'), ['0'])
  assert.deepEqual(k.sh('echo next'), ['next', '[1]  Exit 143    sleep 50'])
  assert.equal(k.sh('sleep 60 | cat &').length, 1)
  assert.deepEqual(k.sh('stop %1'), [])
  assert.deepEqual(k.sh('echo next'), ['next', '[1]  Exit 143    sleep 60 | cat'])
  assert.deepEqual(k.system.kernel.ps().map((p) => p.name), ['init', '-sh'])
  assert.deepEqual(uncollected(k), [])
})

test('wait at the console gives up on Ctrl+C, and the job goes on', () => {
  const k = boot(all)
  assert.equal(k.sh('sleep 100 &').length, 1)
  assert.deepEqual(k.sh('wait; echo not here'), [])
  assert.equal(k.system.interrupt(), false)
  assert.deepEqual(k.settle(), [])
  assert.equal(k.system.atPrompt, true)
  assert.deepEqual(k.sh('echo $?; jobs'), ['130', '[1]  Running    sleep 100'])
  k.tick(100000)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('jobs'), ['[1]  Done    sleep 100'])
})

test('jobs that ended are collected as the next one starts: a script or a line may start many', () => {
  const k = boot(all)
  // Each job has ended by the time the next starts (the wait for /bin/true gives it its turn); none may stay behind.
  assert.deepEqual(k.sh("sh -c 'for i in $(seq 80); do true & /bin/true; done; echo started'; echo $?"), ['started', '0'])
  const out = k.sh('for i in $(seq 80); do true & /bin/true; done; echo $?')
  // Only the shell's word on each job, and the status of the loop: no refusal.
  assert.deepEqual(out.filter((l) => !/^\[\d+\] /.test(l)), ['0'])
  assert.deepEqual(k.sh('jobs'), [])
  assert.deepEqual(uncollected(k), [])
})

// Redirections.

test('redirections: > >> < 2> 2>&1 >&- <&- each do what they say, and one that fails runs nothing', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('echo one > /tmp/r; echo two >> /tmp/r; cat < /tmp/r; cat /nonexistent 2> /tmp/e; cat /tmp/e'), [
    'one', 'two', 'cat: /nonexistent: no such file or directory',
  ])
  // In order: 2>&1 copies where 1 goes now, so the error goes to the screen and the output nowhere.
  assert.deepEqual(k.sh('{ echo out; echo err >&2; } 2>&1 > /dev/null; { echo out; echo err >&2; } > /dev/null 2>&1; echo $?'), ['err', '0'])
  assert.deepEqual(k.sh('echo x >&-; echo $?; cat <&-; echo $?; echo x >&7; echo $?; echo x >&foo; echo $?'), [
    '!ash: echo: bad file descriptor', '1', '!cat: bad file descriptor', '1', '!ash: 7: bad descriptor', '1', '!ash: foo: bad descriptor', '1',
  ])
  // The first file was made before the second could not be opened; the command itself never ran.
  assert.deepEqual(k.sh('echo lost > /tmp/never < /nonexistent; echo $?'), ['!ash: /nonexistent: no such file or directory', '1'])
  assert.equal(k.read('/tmp/never'), '')
  assert.deepEqual(k.sh('echo x > /bin/x; echo $?; echo x > /tmp; echo $?; > /tmp/made; echo $?'), [
    '!ash: /bin/x: read-only file system', '1', '!ash: /tmp: is a directory', '1', '0',
  ])
  assert.equal(k.exists('/tmp/made'), true)
  assert.deepEqual(k.sh('{ read x <&3; echo "[$x]"; } 3< /tmp/r; cat 3< /tmp/r <&3'), ['[one]', 'one', 'two'])
  assert.deepEqual(k.sh('for i in 1 2; do echo $i; done > /tmp/loop; if true; then echo yes; fi >> /tmp/loop; cat /tmp/loop'), ['1', '2', 'yes'])
  assert.deepEqual(descriptors(k), [0, 1, 2])
})

test('redirections put every descriptor back, on every error path', () => {
  const k = boot(all)
  const lines = [
    'echo hi 3>/tmp/b 4>/tmp/c 5</nonexistent',
    'echo ok 2>/tmp/e1 > ${nope:?bad}',
    'cat <<EOF > /tmp/x 2> ${nope:?bad}\nhello\nEOF',
    'x=$(cat /nonexistent)',
    'echo $(echo a > /nonexistent/x)',
    'read x < /nonexistent',
    'echo x | cat < /nonexistent',
    'true 3< /tmp/b 4< /tmp/b 5< /tmp/b 6< /tmp/b 7< /tmp/b 8< /tmp/b 9< /tmp/b',
  ]
  for (const line of lines) {
    k.sh(line)
    assert.deepEqual(descriptors(k), [0, 1, 2], line)
  }
  // Groups inside groups, each with a redirection of its own, until the descriptors run out: refused, all put back.
  let deep = 'echo deep'
  for (let i = 0; i < 40; i++) deep = `{ ${deep}; } 3>>/tmp/f${i % 3}`
  assert.deepEqual(k.sh(`${deep}; echo $?`), ['!ash: too many open files', '1'])
  assert.deepEqual(descriptors(k), [0, 1, 2])
  assert.deepEqual(k.sh('ls /proc/self/fd; ls /proc/$$/fd'), ['0  1  2', '0  1  2'])
  assert.deepEqual(uncollected(k), [])
})

test('here-documents expand unless the marker is quoted, <<- strips tabs, and one longer than a pipe is refused', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('cat <<EOF\na $HOME b\n$(echo sub) $((2+3))\n\\$HOME \\\\ \\x "q" \'s\'\nEOF'), [
    'a /home/operator b', 'sub 5', '$HOME \\ \\x "q" \'s\'',
  ])
  assert.deepEqual(k.sh("cat <<'EOF'\na $HOME $(nope)\nEOF"), ['a $HOME $(nope)'])
  assert.deepEqual(k.sh('cat <<"E F"\nx $y\nE F'), ['x $y'])
  assert.deepEqual(k.sh('\tcat <<-EOF\n\t\ttabbed $USER\n\tEOF'), ['tabbed root'])
  assert.deepEqual(k.sh('cat <<A <<B\nfirst\nA\nsecond\nB'), ['second'])
  assert.deepEqual(k.sh('cat <<EOF | wc -l; echo after\n1\n2\nEOF'), ['2', 'after'])
  assert.deepEqual(k.sh('cat <<EOF\nEOF\necho $?'), ['0'])
  assert.deepEqual(k.sh('{ read a <&3; read b <&3; echo "$b $a"; } 3<<EOF\none\ntwo\nEOF'), ['two one'])
  // PIPE_MAX bytes fit (the last line's end counts); one more is refused and the command does not run.
  assert.deepEqual(k.sh(`cat <<EOF | wc -c\n${'z'.repeat(PIPE_MAX - 1)}\nEOF`), [String(PIPE_MAX)])
  assert.deepEqual(k.sh(`cat <<EOF; echo $?\n${'z'.repeat(PIPE_MAX)}\nEOF`), [`!ash: a heredoc is longer than ${PIPE_MAX} bytes`, '1'])
  assert.deepEqual(descriptors(k), [0, 1, 2])
})

// Builtins.

test('cd and pwd: home, -, a refusal for each reason, and PWD and OLDPWD kept', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('cd /tmp; pwd; cd; pwd; cd -; echo "$OLDPWD $PWD"; cd ..; pwd; cd'), ['/tmp', '/home/operator', '/tmp', '/home/operator /tmp', '/'])
  assert.deepEqual(k.sh('cd /nonexistent; echo $?; cd /etc/passwd; echo $?; cd ""; echo $?; pwd'), [
    '!cd: /nonexistent: no such file or directory', '1', '!cd: /etc/passwd: not a directory', '1', '!cd: : no such file or directory', '1', '/home/operator',
  ])
  assert.deepEqual(k.sh('unset OLDPWD; cd -; echo $?; h=$HOME; unset HOME; cd; echo $?; HOME=$h; export HOME'), [
    '!cd: OLDPWD is not set', '1', '!cd: HOME is not set', '1',
  ])
  // PWD is handed on: a program started after cd sees where the shell is.
  assert.deepEqual(k.sh('cd /etc; printenv PWD; sh -c pwd; pwd extra words; cd'), ['/etc', '/etc', '/etc'])
})

test('echo: -n, -e and the escapes it knows; anything else is a word', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('echo -n a; echo -e "b\\nc\\\\d"; echo -ne "e\\n"; echo -en "f\\0g" | wc -c; echo -- x; echo -E y; echo; echo -n; echo -n -e "h\\n"'), [
    'ab', 'c\\d', 'e', '3', '-- x', '-E y', '', 'h',
  ])
  assert.deepEqual(k.sh('echo -e "\\x41 \\q"; echo "\\n"'), ['\\x41 \\q', '\\n'])
})

test('read: one line, split over the names it is given; no input is status 1; a last line without its end still counts', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('read a b c <<EOF\n  one two three four  \nEOF\necho "[$a][$b][$c]"'), ['[one][two][three four]'])
  assert.deepEqual(k.sh('read a b c <<EOF\none\nEOF\necho "[$a][$b][$c]" $?'), ['[one][][] 0'])
  assert.deepEqual(k.sh('read <<EOF\n  keep  spaces  \nEOF\necho "[$REPLY]"'), ['[  keep  spaces  ]'])
  assert.deepEqual(k.sh('x=old; read x < /dev/null; echo $? "[$x]"; : > /tmp/empty; read y < /tmp/empty; echo $?'), ['1 []', '1'])
  // A last line with no line end is still a line (status 0); only the read after it finds nothing.
  k.write('/tmp/p', 'only')
  assert.deepEqual(k.sh('printf "a\\nb" | while read l; do echo "<$l>"; done; { read a; echo "$? [$a]"; read b; echo "$? [$b]"; } < /tmp/p'), [
    '<a>', '<b>', '0 [only]', '1 []',
  ])
  // A backslash is dropped and the character after it kept, unless -r keeps backslashes as they are.
  k.write('/tmp/bs', 'a\\b c\\d e\n')
  assert.deepEqual(k.sh('read x y < /tmp/bs; echo "[$x][$y]"; read -r x y < /tmp/bs; echo "[$x][$y]"'), ['[ab][cd e]', '[a\\b][c\\d e]'])
  // Only one line is taken: the rest is there for the next reader.
  assert.deepEqual(k.sh('printf "1\\n2\\n3\\n" | { read a; cat; }'), ['2', '3'])
  assert.deepEqual(k.sh('read 1x; echo $?; read -r a-b; echo $?; read x <&-; echo $?'), [
    '!read: 1x: not a name', '2', '!read: a-b: not a name', '2', '!ash: read: bad file descriptor', '1',
  ])
})

test('export and unset: export hands a variable on, lists what is handed on, and refuses what is not a name', () => {
  const k = boot(all)
  assert.deepEqual(k.sh("export A=1; sh -c 'echo $A'; A=2; sh -c 'echo $A'; unset A; sh -c 'echo \"[$A]\"'; printenv A; echo $?"), ['1', '2', '[]', '1'])
  // A name exported before it has a value is handed on once it has one.
  assert.deepEqual(k.sh("export L; sh -c 'echo \"[$L]\"'; L=later; sh -c 'echo \"[$L]\"'"), ['[]', '[later]'])
  assert.deepEqual(k.sh('export 1x a-b C=3; echo $?; printenv C'), ['!export: 1x: not a name', '!export: a-b: not a name', '1', '3'])
  k.sh('unset A L C; export Q="it\'s"')
  // Sorted by name, each value quoted so that the line could be typed again.
  assert.deepEqual(k.sh('export | head -2; export | head -6 | tail -2; export | tail -1'), [
    "export HOME='/home/operator'", "export HOSTNAME='crimson-noir'", "export PWD='/home/operator'", "export Q='it'\\''s'", "export USER='root'",
  ])
  assert.deepEqual(k.sh('x=1; unset x nothing-here; echo "[${x-unset}]" $?'), ['[unset] 0'])
})

test('exit: the status it is given (mod 256), 2 for one that is not a number, the last one by default', () => {
  const k = boot(all)
  const exits = ["'exit 3'", "'exit 256'", "'exit abc'", "'false; exit'", "'exit 1 2'"].map((c) => `sh -c ${c}; echo $?`).join('; ')
  assert.deepEqual(k.sh(exits), ['3', '0', '2', '1', '1'])
  // Inside $( ) and inside a script read with source, exit ends that task.
  k.write('/tmp/ex', 'echo before\nexit 3\necho after\n')
  assert.deepEqual(k.sh("x=$(echo in; exit 9; echo never); echo \"$? [$x]\"; sh -c '. /tmp/ex; echo not here'; echo $?"), ['9 [in]', 'before', '3'])
  // The console's own shell does not end: there, exit is only the status (no city here to close the console).
  assert.deepEqual(k.sh('exit 7; echo "still here $?"; exit abc; echo $?'), ['still here 7', '2'])
  assert.deepEqual(k.sh('. /tmp/ex; echo "still here $?"'), ['before', 'after', 'still here 0'])
})

test('source and .: a file name is needed; the arguments are $1... while it runs; return ends it; #! is a comment', () => {
  const k = boot(all)
  k.write('/tmp/rt', '#!/bin/sh\necho "in $1 $#"\nreturn 7\necho no\n')
  assert.deepEqual(k.sh('. /tmp/rt a b; echo $? $#; source /tmp/rt; echo $?'), ['in a 2', '7 0', 'in  0', '7'])
  assert.deepEqual(k.sh('source; echo $?; . /nonexistent; echo $?; . /tmp; echo $?'), [
    '!source: a file name is needed', '2', '!.: /nonexistent: no such file or directory', '1', '!.: /tmp: is a directory', '1',
  ])
  k.write('/tmp/bad', 'echo never\nif then\n')
  assert.deepEqual(k.sh('. /tmp/bad; echo $?'), ["!ash: /tmp/bad: syntax error: 'if' needs a command before 'then'", '2'])
  // A script read with source runs in this shell: what it sets stays.
  k.write('/tmp/set', 'S=set; cd /tmp\n')
  assert.deepEqual(k.sh('. /tmp/set; echo $S; pwd; cd'), ['set', '/tmp'])
})

test('type, umask, shift, true, false and :', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('type echo [ ls /bin/ls nope ./nope; echo $?; type; echo $?'), [
    'echo is a shell builtin', '[ is a shell builtin', 'ls is /bin/ls', '/bin/ls is /bin/ls', '!nope: not found', '!./nope: not found', '1', '0',
  ])
  assert.deepEqual(k.sh('umask; umask 077; umask; umask 8; echo $?; umask 12345; echo $?; umask; umask 0022'), [
    '0022', '0077', '!umask: 8: not an octal number', '2', '!umask: 12345: not an octal number', '2', '0077',
  ])
  k.sh('umask 027; mkdir /tmp/um; umask 022')
  assert.equal(now(k.system.kernel.vfs.stat('/tmp/um', '/', ROOT_CRED)).mode & 0o777, 0o750)
  assert.deepEqual(k.sh("sh -c 'shift; echo $1 $#; shift 5; echo $?; shift x; echo $?; shift 1; echo $# $?; shift; echo $?' n a b"), [
    'b 1', '!shift: not that many parameters', '1', '!shift: not that many parameters', '1', '0 0', '!shift: not that many parameters', '1',
  ])
  assert.deepEqual(k.sh('true; echo $?; false; echo $?; :; echo $?; : ignored words; echo $?; true --help; echo $?'), ['0', '1', '0', '0', '0'])
})

test('break, continue and return: how many loops, what is not a count, and return where there is nothing to return from', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('for i in 1 2 3; do for j in a b; do echo $i$j; break 5; done; done; echo $?'), ['1a', '0'])
  assert.deepEqual(k.sh('for i in 1 2 3; do for j in a b; do if [ $j = b ]; then continue 2; fi; echo $i$j; done; echo never; done'), ['1a', '2a', '3a'])
  assert.deepEqual(k.sh('i=0; while [ $i -lt 3 ]; do i=$((i+1)); echo $i; done; until [ $i -eq 0 ]; do i=$((i-1)); done; echo $i'), ['1', '2', '3', '0'])
  assert.deepEqual(k.sh('for i in 1 2 3; do while true; do continue 2; done; done; echo out; i=0; while break; do i=1; done; echo $i'), ['out', '0'])
  // A loop that never ran has status 0, one that did has its body's last status.
  assert.deepEqual(k.sh('false; while false; do :; done; echo $?; for x in; do :; done; echo $?; for i in 1 2; do false; done; echo $?'), ['0', '0', '1'])
  assert.deepEqual(k.sh('break; echo $?; continue; echo $?; break 0; echo $?; continue x; echo $?; return -1; echo $?'), [
    '0', '0', '!break: 0: not a count', '2', '!continue: x: not a count', '2', '!return: -1: not a count', '2',
  ])
  // break and continue reach through a script read with source to the loop around it.
  k.write('/tmp/brk', 'break\n')
  assert.deepEqual(k.sh('for i in 1 2; do . /tmp/brk; echo $i; done; echo out'), ['out'])
  // return in a script run by sh ends it with that status; typed at the prompt it gives the line up, and $? says so.
  assert.deepEqual(k.sh("sh -c 'return 5; echo no'; echo $?"), ['5'])
  assert.deepEqual(k.sh('return 6; echo no'), [])
  assert.deepEqual(k.sh('echo $?'), ['6'])
})

test('loops nest as deep as the parser follows (64); break with a large count leaves them all; deeper is refused', () => {
  const k = boot(all)
  const loops = (n: number): string => {
    let body = 'echo in; break 1000'
    for (let i = 0; i < n; i++) body = `for v${i} in 1 2; do ${body}; done`
    return body
  }
  assert.deepEqual(k.sh(`${loops(64)}; echo "out $?"`), ['in', 'out 0'])
  assert.deepEqual(k.sh(`${loops(65)}; echo not here`), ['!ash: syntax error: nested too deep'])
  assert.deepEqual(k.sh('echo $?; for i in 1; do for j in 1; do break; done; echo inner-only; done'), ['2', 'inner-only'])
})

test('set is not one of the shell\'s commands: set -e is not supported, as the manual says', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('set -e; echo $?; false; echo "goes on $?"'), ['!ash: set: not found', '127', 'goes on 1'])
})

// Variables around a command.

test('NAME=value before a builtin holds for that command only, and everything is put back as it was', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('x=1; x=2 true; echo $x; unset y; y=7 true; echo "[${y-unset}]"'), ['1', '[unset]'])
  assert.deepEqual(k.sh('HOME=/tmp cd; pwd; echo $HOME; cd'), ['/tmp', '/home/operator'])
  // The same name twice: the value before both comes back.
  assert.deepEqual(k.sh('x=0; x=1 x=2 true; echo $x'), ['0'])
  // A name exported before it had a value stays exported.
  assert.deepEqual(k.sh("export q; q=1 true; q=5; sh -c 'echo \"[$q]\"'"), ['[5]'])
  // A later value that cannot be expanded gives the line up, and the earlier one is put back too.
  assert.deepEqual(k.sh('a=0; a=1 b=${nope:?no} true; echo not here'), ['!ash: nope: no'])
  assert.deepEqual(k.sh('echo "$a [${b-unset}]"'), ['0 [unset]'])
  // The words are expanded before the assignments take hold.
  assert.deepEqual(k.sh('v=old; v=new echo $v'), ['old'])
})

test('NAME=value before a program is in that program\'s environment only', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('x=9 printenv x; echo "[${x-unset}]"; y=3; y=4 printenv y; printenv y; echo $?'), ['9', '[unset]', '4', '1'])
  assert.deepEqual(k.sh("z=5 sh -c 'echo $z'; PATH=/nowhere ls /; echo $?"), ['5', '!ash: ls: not found', '127'])
  assert.deepEqual(k.sh('w=1 > /tmp/w; echo "[$w]"; cat /tmp/w'), ['[1]'])
})

// Scripts.

test('scripts: a text file runs by name, #! names the shell, and sh takes a file, -c or its input', () => {
  const k = boot(all)
  k.write('/tmp/plain', 'echo "plain $0 $1"\n')
  k.write('/tmp/bang', '#!/bin/sh\necho "banged $0 $1"\nexit 4\n')
  k.write('/tmp/nox', 'echo never\n')
  k.sh('chmod +x /tmp/plain /tmp/bang')
  assert.deepEqual(k.sh('/tmp/plain arg; echo $?; /tmp/bang b; echo $?'), ['plain /tmp/plain arg', '0', 'banged /tmp/bang b', '4'])
  assert.deepEqual(k.sh('/tmp/nox; echo $?; /tmp; echo $?; nope; echo $?; /tmp/nope; echo $?'), [
    '!ash: /tmp/nox: permission denied', '126', '!ash: /tmp: is a directory', '126', '!ash: nope: not found', '127', '!ash: /tmp/nope: not found', '127',
  ])
  assert.deepEqual(k.sh('sh /tmp/nox; echo $?; sh /tmp/missing; echo $?; sh -c; echo $?'), [
    'never', '0', '!ash: /tmp/missing: no such file or directory', '127', '!ash: -c needs a command', '2',
  ])
  assert.deepEqual(k.sh("sh -c 'echo $0 $1 $2' name a b; echo 'echo piped $0; exit 3' | sh; echo $?; sh < /dev/null; echo $?"), [
    'name a b', 'piped sh', '3', '0',
  ])
  assert.deepEqual(k.sh("sh -c 'if then'; echo $?; sh -c 'echo ${'; echo $?"), [
    "!ash: syntax error: 'if' needs a command before 'then'", '2', '!ash: syntax error: bad substitution', '2',
  ])
  // A script in ~/bin runs by its name alone; a script can run a script.
  k.sh('mkdir /home/operator/bin; chmod +x /tmp/plain')
  k.write('/home/operator/bin/hello', 'echo "mine $1"; /tmp/plain from-hello\n')
  k.sh('chmod +x /home/operator/bin/hello')
  assert.deepEqual(k.sh('hello a | cat; type hello'), ['mine a', 'plain /tmp/plain from-hello', 'hello is /home/operator/bin/hello'])
  assert.deepEqual(uncollected(k), [])
})

test('a script that runs itself stops at the task limit, says so once, and leaves nothing behind', () => {
  const k = boot(all)
  k.write('/tmp/rec', 'sh /tmp/rec\n')
  assert.deepEqual(k.sh('sh /tmp/rec; echo $?'), ['!ash: sh: too many tasks', '126'])
  assert.equal(k.system.kernel.ps().length, 2)
  assert.deepEqual(uncollected(k), [])
  assert.deepEqual(k.sh('echo fine | cat'), ['fine'])
})

// The city's own commands.

interface TestCity {
  readonly host: CityHost
  readonly calls: string[]
  pending: Later<readonly CityLine[]> | null
}

/** A city whose commands answer at once, with error lines among the others, by throwing, or later (the test settles them). */
function testCity(): TestCity {
  const c: TestCity = {
    calls: [],
    pending: null,
    host: {
      has: (name) => ['stats', 'mixed', 'boom', 'slow', 'posty', 'exit', 'echo'].includes(name),
      whole: () => false,
      run: (name, args, line, direct) => {
        c.calls.push(`${name}[${args.join('|')}] ${line}${direct ? ' (direct)' : ''}`)
        if (name === 'stats') return { lines: [{ err: false, text: 'fps 60' }, { err: false, text: 'cars 3' }], later: null }
        if (name === 'mixed') return { lines: [{ err: false, text: 'a' }, { err: true, text: 'b' }, { err: false, text: 'c' }], later: null }
        if (name === 'boom') throw new Error('it broke')
        if (name === 'slow' || name === 'posty') {
          c.pending = new Later<readonly CityLine[]>()
          if (name === 'posty' && direct) return { lines: [], later: c.pending, post: { shown: args }, status: 0 }
          return { lines: [{ err: false, text: 'started' }], later: c.pending }
        }
        return { lines: [{ err: false, text: `${name} ran` }], later: null }
      },
    },
  }
  return c
}

/** What the city command that answers later is waiting with. */
function pendingOf(c: TestCity): Later<readonly CityLine[]> {
  if (c.pending === null) throw new Error('no city command is waiting')
  return c.pending
}

test('city commands run inside pipes, lists, redirections and $( ) through the same handler', () => {
  const c = testCity()
  const k = boot(all, { city: c.host })
  assert.deepEqual(k.sh('stats; echo $?; stats | wc -l; stats > /tmp/st; cat /tmp/st; x=$(stats); echo "[$x]"'), [
    'fps 60', 'cars 3', '0', '2', 'fps 60', 'cars 3', '[fps 60', 'cars 3]',
  ])
  // Error lines go to the error output in their place, and make the status 1.
  assert.deepEqual(k.sh('mixed; echo $?; mixed 2> /dev/null; echo $?; mixed 2>&1 | cat'), ['a', '!b', 'c', '1', 'a', 'c', '1', 'a', 'b', 'c'])
  assert.deepEqual(k.sh('boom; echo $?; boom | cat; echo $?'), ['!boom: it broke', '1', '!boom: it broke', '0'])
  // The shell's own builtin keeps its name; the city says which of its commands it has.
  assert.deepEqual(k.sh('echo hi; type stats echo'), ['hi', 'stats is a city command', 'echo is a shell builtin'])
  assert.deepEqual(c.calls, [
    'stats[] stats (direct)', 'stats[] stats', 'stats[] stats', 'stats[] stats',
    'mixed[] mixed (direct)', 'mixed[] mixed', 'mixed[] mixed', 'boom[] boom (direct)', 'boom[] boom',
  ])
})

test('a city command that answers later is waited for; Ctrl+C at the console gives up the wait, not the command', () => {
  const c = testCity()
  const k = boot(all, { city: c.host })
  assert.deepEqual(k.sh('slow a; echo "after $?"'), ['started'])
  assert.equal(k.system.atPrompt, false)
  pendingOf(c).resolve([{ err: false, text: 'later line' }, { err: true, text: 'later err' }])
  assert.deepEqual(k.settle(), ['later line', '!later err', 'after 1'])
  assert.deepEqual(k.sh('slow b; echo not here'), ['started'])
  assert.equal(k.system.interrupt(), false)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['130'])
  // What arrives after is nobody's: nothing is shown.
  pendingOf(c).resolve([{ err: false, text: 'too late' }])
  assert.deepEqual(k.settle(), [])
  // Inside a pipe the stage waits; Ctrl+C ends the stage and gives the line up.
  assert.deepEqual(k.sh('slow c | wc -l; echo not here'), [])
  assert.equal(k.system.interrupt(), true)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['130'])
  assert.deepEqual(k.sh('slow d | wc -l'), [])
  pendingOf(c).resolve([{ err: false, text: 'x' }])
  assert.deepEqual(k.settle(), ['2'])
})

test('a city command whose later answer is refused fails alone: said, status 1, and the line goes on', () => {
  const c = testCity()
  const k = boot(all, { city: c.host })
  assert.deepEqual(k.sh('slow; echo "after $?"'), ['started'])
  pendingOf(c).reject(new OsError('EIO'))
  assert.deepEqual(k.settle(), ['!slow: input/output error', 'after 1'])
  assert.deepEqual(k.sh('slow | cat; echo "after $?"'), ['started'])
  pendingOf(c).reject(new OsError('EIO'))
  assert.deepEqual(k.settle(), ['!slow: input/output error', 'after 0'])
})

test('a city command whose write is refused fails alone, as a builtin does: said with its name, status 1, and the line goes on', () => {
  const c = testCity()
  const k = boot(all, { city: c.host })
  assert.deepEqual(k.sh('stats > /dev/full; echo "next $?"'), ['!stats: no space left on device', 'next 1'])
  assert.deepEqual(k.sh('slow > /dev/full; echo "next $?"'), ['!slow: no space left on device', 'next 1'])
  // In a script too: the script goes on.
  assert.deepEqual(k.sh("sh -c 'stats > /dev/full; echo \"next $?\"'; echo $?"), ['!stats: no space left on device', 'next 1', '0'])
  assert.deepEqual(descriptors(k), [0, 1, 2])
})

test('a city command typed with nothing in between may be shown by the host itself; its status still counts', () => {
  const c = testCity()
  const k = boot(all, { city: c.host })
  assert.deepEqual(k.sh('posty z; echo "st $?"'), ['POST {"shown":["z"]}'])
  pendingOf(c).resolve([{ err: true, text: 'bad later' }])
  assert.deepEqual(k.settle(), ['st 1'])
  // With a pipe, a redirection or inside a script it is lines, as any program's.
  assert.deepEqual(k.sh('posty y | cat'), ['started'])
  pendingOf(c).resolve([{ err: false, text: 'fine' }])
  assert.deepEqual(k.settle(), ['fine'])
  // At the console exit is the city's own command (it closes the console); the shell goes on.
  assert.deepEqual(k.sh('exit 3; echo "after $?"'), ['exit ran', 'after 0'])
  assert.deepEqual(c.calls.slice(-1), ['exit[3] exit 3 (direct)'])
})

// Ctrl+C, Ctrl+D and the console's own shell.

test('Ctrl+C ends the foreground job, forgets the lines typed ahead, and gives the line up with status 130', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('sleep 100; echo not here'), [])
  k.system.type('echo typed ahead')
  assert.equal(k.system.interrupt(), true)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['130'])
  for (const line of ['sleep 100 | cat; echo not here', 'x=$(sleep 100); echo not here', 'sh -c "sleep 100; echo not here"; echo nor here']) {
    assert.deepEqual(k.sh(line), [], line)
    assert.equal(k.system.interrupt(), true, line)
    assert.deepEqual(k.settle(), [], line)
    assert.deepEqual(k.sh('echo $?'), ['130'], line)
  }
  assert.deepEqual(uncollected(k), [])
  assert.deepEqual(descriptors(k), [0, 1, 2])
})

test('an endless loop yields on the kernel\'s step count: the host gets its turn back, and Ctrl+C ends the loop', () => {
  const k = boot(all)
  k.system.type('while :; do :; done; echo not here')
  assert.deepEqual(k.system.run(20000, Number.POSITIVE_INFINITY), [])
  assert.equal(k.system.idle, false)
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['130'])
  // The same loop in the background: the shell at the prompt keeps answering, and stop ends it.
  k.system.type('while :; do :; done &')
  assert.match(k.system.run(20000, Number.POSITIVE_INFINITY).map((e) => (e.kind === 'post' ? '' : e.text)).join(' '), /^\[1\] \d+$/)
  k.system.type('echo alive')
  assert.deepEqual(k.system.run(20000, Number.POSITIVE_INFINITY), [{ kind: 'out', text: 'alive' }])
  k.system.type('stop %1')
  k.system.run(20000, Number.POSITIVE_INFINITY)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo next'), ['next', '[1]  Exit 143    while :; do :; done'])
})

test('Ctrl+C at the wrong moment: between the parts of a line, at a continuation prompt, at the prompt itself', () => {
  const k = boot(all)
  // read ends with no input, but the rest of the line is given up all the same.
  assert.deepEqual(k.sh('read x || echo "not here"; echo nor here'), [])
  assert.equal(k.system.interrupt(), false)
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['130'])
  // A command still being typed is dropped without a word; Ctrl+D instead says what was missing.
  assert.deepEqual(k.sh('while true; do'), [])
  assert.equal(k.system.prompt, '> ')
  assert.equal(k.system.capturing, true)
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $?'), ['0'])
  assert.deepEqual(k.sh('echo "open'), [])
  k.system.end()
  assert.deepEqual(k.settle(), ['!ash: syntax error: a quote is left open'])
  assert.deepEqual(k.sh('echo $?'), ['2'])
  // At the prompt there is nothing to give up.
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  assert.equal(k.system.atPrompt, true)
  assert.deepEqual(k.sh('echo $?'), ['0'])
})

test('Ctrl+C while read waits at the console gives the line up with 130, at the end of a line or a loop too', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('x=old; read x'), [])
  assert.equal(k.system.interrupt(), false)
  assert.deepEqual(k.settle(), [])
  // It was 1, the status of a read that found no input, as if nothing had been pressed.
  assert.deepEqual(k.sh('echo $? $x'), ['130 old'])
  assert.deepEqual(k.sh('while read x; do echo "<$x>"; done'), [])
  assert.deepEqual(k.sh('typed'), ['<typed>'])
  k.system.interrupt()
  assert.deepEqual(k.settle(), [])
  // It was 0: the loop ended as if its input had.
  assert.deepEqual(k.sh('echo $? $x'), ['130 typed'])
})

test('the console\'s own shell: Ctrl+D keeps it; a shell started from it ends on Ctrl+D or exit', () => {
  const k = boot(all)
  const pid = String(shellPid(k))
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $$'), [pid])
  assert.deepEqual(k.sh('sh'), [])
  const inner = k.sh('echo $$; exit 3')
  assert.equal(inner.length, 1)
  assert.notEqual(inner[0], pid)
  assert.deepEqual(k.sh('echo $? $$'), [`3 ${pid}`])
  assert.deepEqual(k.sh('sh'), [])
  k.system.end()
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo $? $$'), [`0 ${pid}`])
})

test('the console\'s own shell starts again after it is stopped, and reads the profiles again', () => {
  const k = boot(all)
  const before = shellPid(k)
  k.write('/etc/profile', 'P=etc; echo from etc\n')
  k.write('/home/operator/.profile', 'echo "from home $P"\n')
  k.sh('X=1; stop $$')
  k.tick(249)
  assert.deepEqual(k.settle(), [])
  assert.equal(k.system.atPrompt, false)
  k.tick(1)
  assert.deepEqual(k.settle(), ['from etc', 'from home etc'])
  const after = shellPid(k)
  assert.notEqual(after, before)
  assert.deepEqual(k.sh('echo $$ $P "[${X-unset}]" $?'), [`${after} etc [unset] 0`])
  // A profile that does not parse is said and skipped; one that loops is ended by Ctrl+C.
  k.write('/home/operator/.profile', 'if then\n')
  k.sh('stop $$')
  k.tick(250)
  assert.deepEqual(k.settle(), ['from etc', "!ash: /home/operator/.profile: syntax error: 'if' needs a command before 'then'"])
  k.write('/home/operator/.profile', 'while :; do :; done\n')
  k.sh('stop $$')
  k.tick(250)
  k.system.run(20000, Number.POSITIVE_INFINITY)
  assert.equal(k.system.idle, false)
  k.system.interrupt()
  k.settle()
  assert.equal(k.system.atPrompt, true)
  assert.deepEqual(k.sh('echo ready'), ['ready'])
})

test('a profile that cannot be read, or whose commands are refused, is said and passed over: the console\'s shell still starts', () => {
  const k = boot(all)
  const before = shellPid(k)
  // A directory where the profile should be ended every shell started at the console, again and again.
  k.sh('mkdir /home/operator/.profile')
  k.write('/etc/profile', 'echo from etc\nx=$(yes)\necho not here\n')
  k.sh('stop $$')
  k.tick(250)
  assert.deepEqual(k.settle(), ['from etc', '!ash: /etc/profile: too much to hold in memory', '!ash: /home/operator/.profile: is a directory'])
  assert.equal(k.system.atPrompt, true)
  assert.notEqual(shellPid(k), before)
  assert.deepEqual(k.sh('echo ready $?'), ['ready 0'])
  assert.deepEqual(uncollected(k), [])
})

test('a typed line longer than one read is still one command', () => {
  const k = boot(all)
  assert.deepEqual(k.sh(`x=${'a'.repeat(70000)}; echo \${#x}`), ['70000'])
  assert.deepEqual(k.sh(`echo '${'b'.repeat(65530)} c' | wc -c`), ['65533'])
})

test('read at the console takes the next typed line, whatever it says, and the console knows it', () => {
  const k = boot(all)
  assert.deepEqual(k.sh('read x; echo "got [$x]"'), [])
  assert.equal(k.system.capturing, true)
  assert.equal(k.system.atPrompt, false)
  assert.deepEqual(k.sh('stats | wc -l'), ['got [stats | wc -l]'])
  assert.equal(k.system.atPrompt, true)
  assert.equal(k.system.capturing, false)
  // A line longer than read keeps (1 MiB) is still all read's: the rest is dropped, never run as a command.
  assert.deepEqual(k.sh('read x; echo "got ${#x}"'), [])
  assert.deepEqual(k.sh(`${'a'.repeat((1 << 20) + 70000)}; echo not run`), [`got ${(1 << 20) + 1}`])
  assert.deepEqual(k.sh('echo $?'), ['0'])
})

// test and [ (cond.ts).

test('test: no arguments, one argument, and the questions about text and files', () => {
  const k = boot(all)
  const asks = (line: string): string[] => k.sh(line.split(';').map((q) => `${q.trim()}; echo $?`).join('; '))
  assert.deepEqual(asks('test; test ""; test x; test -n; test -z; test !; test -a'), ['1', '1', '0', '0', '0', '0', '0'])
  assert.deepEqual(asks('[ -z "" ]; [ -n "" ]; [ -z a ]; [ ! -z a ]; [ -n a ]; [ ! ! -n a ]'), ['0', '1', '1', '0', '0', '0'])
  k.write('/tmp/f', 'data')
  k.write('/tmp/empty', '')
  assert.deepEqual(asks('[ -e /tmp/f ]; [ -f /tmp/f ]; [ -d /tmp ]; [ -f /tmp ]; [ -d /tmp/f ]; [ -e /nonexistent ]; [ -f /nonexistent ]'), [
    '0', '0', '0', '1', '1', '1', '1',
  ])
  assert.deepEqual(asks('[ -s /tmp/f ]; [ -s /tmp/empty ]; [ -s /nonexistent ]'), ['0', '1', '1'])
  // /bin is read-only; /etc/passwd may be read but not run.
  assert.deepEqual(asks('[ -r /etc/passwd ]; [ -w /tmp/f ]; [ -w /bin/ls ]; [ -x /bin/ls ]; [ -x /etc/passwd ]; [ -r /nonexistent ]; [ -e "" ]'), [
    '0', '0', '1', '0', '1', '1', '1',
  ])
  assert.deepEqual(asks('[ -t 0 ]; [ -t 0 ] < /dev/null; [ -t x ]; [ -t 7 ]'), ['0', '1', '1', '1'])
})

test('test: the two-sided questions, -nt and -ot, and how ! -a -o and brackets bind', () => {
  const k = boot(all)
  const asks = (line: string): string[] => k.sh(line.split(';').map((q) => `${q.trim()}; echo $?`).join('; '))
  assert.deepEqual(asks('[ a = a ]; [ a = b ]; [ a == a ]; [ a != b ]; [ -f = -f ]; [ "" = "" ]; [ = = = ]'), ['0', '1', '0', '0', '0', '0', '0'])
  assert.deepEqual(asks('[ 2 -lt 10 ]; [ 10 -le 10 ]; [ 3 -gt 2 ]; [ 2 -ge 3 ]; [ 1 -ne 1 ]; [ 1 -eq 01 ]; [ -0 -eq 0 ]'), ['0', '0', '0', '1', '1', '0', '0'])
  k.write('/tmp/old', 'o')
  k.tick(1000)
  k.write('/tmp/new', 'n')
  assert.deepEqual(asks('[ /tmp/new -nt /tmp/old ]; [ /tmp/old -nt /tmp/new ]; [ /tmp/old -ot /tmp/new ]; [ /tmp/new -nt /tmp/new ]'), ['0', '1', '0', '1'])
  // A file that is not there is older than any that is.
  assert.deepEqual(asks('[ /tmp/new -nt /none ]; [ /none -nt /tmp/new ]; [ /none -ot /tmp/new ]; [ /tmp/new -ot /none ]; [ /none -nt /none ]'), [
    '0', '1', '0', '1', '1',
  ])
  // -a binds tighter than -o; ! binds to the next question; brackets group.
  assert.deepEqual(asks('[ a -o "" -a "" ]; [ "" -a a -o a ]; [ ! "" -a "" ]; [ \\( a -o "" \\) -a "" ]; [ ! \\( a = a \\) ]; [ \\( \\( a \\) \\) ]'), [
    '0', '0', '1', '1', '1', '0',
  ])
})

test('test: a malformed question is status 2 with its reason; brackets nest at most 64 deep', () => {
  const k = boot(all)
  const bad = ['test a b', 'test "" -a', 'test \\( a', 'test a -eq 1', 'test 1 -eq', '[ a', '[ ]'].map((q) => `${q}; echo $?`).join('; ')
  assert.deepEqual(k.sh(bad), [
    '!test: too many arguments', '2', '!test: an argument is missing', '2', "!test: '(' needs ')'", '2', "!test: 'a' is not a whole number", '2',
    '!test: too many arguments', '2', "![: missing ']'", '2', '1',
  ])
  assert.deepEqual(k.sh('[ "" -eq 0 ]; echo $?; [ 1.5 -lt 2 ]; echo $?; [ 0x10 -gt 1 ]; echo $?'), [
    "![: '' is not a whole number", '2', "![: '1.5' is not a whole number", '2', "![: '0x10' is not a whole number", '2',
  ])
  const nest = (n: number): string => `test ${'\\( '.repeat(n)}a${' \\)'.repeat(n)}; echo $?`
  assert.deepEqual(k.sh(nest(63)), ['0'])
  assert.deepEqual(k.sh(nest(64)), ['!test: nested too deep', '2'])
  assert.deepEqual(k.sh(`/bin/${nest(64).slice(0, -9)}; echo $?`), ['!test: nested too deep', '2'])
})

test('test: a ! before a two-sided operator, and a ( alone, are texts like any other', () => {
  const k = boot(all)
  const asks = (line: string): string[] => k.sh(line.split(';').map((q) => `${q.trim()}; echo $?`).join('; '))
  // A quoted variable that holds ! is compared, not taken for a negation (it was status 2, too many arguments).
  k.sh("b='!'")
  assert.deepEqual(asks('[ "$b" = x ]; [ "$b" = "!" ]; [ "$b" != y ]; [ "$b" -a x ]; [ "$b" -o "" ]; /bin/test ! = !'), ['1', '0', '0', '0', '0', '0'])
  // Where nothing joins it to the next word, ! still turns the answer around.
  assert.deepEqual(asks('[ ! a = b ]; [ ! = ]; [ ! -n x ]; [ ! "$b" ]; [ ! ! = x ]'), ['0', '1', '1', '1', '0'])
  // One word asks only whether it is empty, whatever it says (it was status 2, an argument is missing).
  k.sh("p='('")
  assert.deepEqual(asks('[ "$p" ]; [ ! "$p" ]; [ -n "$p" ]; [ "$p" = "(" ]; /bin/test "("'), ['0', '1', '0', '0', '0'])
  assert.deepEqual(k.sh('test \\( a; echo $?'), ["!test: '(' needs ')'", '2'])
})
