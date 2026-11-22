# The console's operating layer

This is the design of the small operating system the Ring-0 console carries beside its own commands (`MANUAL.md`,
"Files, programs and the shell", says how to use it). The implementation is one folder and the files around it:

- `src/07_Execute_Actions/terminal/os/`: the layer itself. `index.ts` is its one door; `system.ts` puts it together;
  `kernel.ts` (the kernel, and `class Sys`, every call a program can make), `task.ts`, `pipe.ts` and `tty.ts` run
  tasks; `vfs.ts`, `memfs.ts`, `synth.ts`, `procfs.ts`, `devices.ts`, `path.ts`, `fs.ts` and `image.ts` are the file
  system and the disk's image; `parser.ts`, `shell.ts`, `arith.ts` and `cond.ts` are the shell; `programs.ts` gathers
  the programs of `fileutils.ts`, `textutils.ts`, `sysutils.ts`, `diff.ts`, `grep.ts` and `sed.ts`, with their manual
  pages and the three of `manual.ts`; `regex.ts` is the pattern engine; `lib.ts`, `bytes.ts`, `errno.ts` and `sha.ts`
  are what the programs share.
- `terminal/commands.ts`: the gate in `run()` that decides who takes a typed line, and `OsSession`, which holds the
  layer for the console (its turns, the console commands it runs for the shell, what it printed, the saving of the
  disk).
- `terminal/cityfs.ts`: the city as files, under `/proc/city` and `/sys/city`.
- `consoleDisk.ts`: where the disk is kept between visits, in the browser's IndexedDB.
- `terminal/Terminal.tsx` and `App.tsx`: the prompt, the keys, the timer that gives the layer its turns, the history,
  the one disk store both consoles share, and the save the page waits for before it goes.

Every limit and timing on this page is a constant in those files; the test counts at the end are as they stood when
this page was written.

## What it is and why

The console's prompt is two things at once. It is the city's console, as it always was: `help` lists its commands
(`stats`, `time`, `quality` and the rest), and each of them, typed alone, runs exactly as it did before the layer
existed. It is also a small operating system of its own: a tree of directories with a disk that is kept between
visits, 67 programs in `/bin` that read and write files, and a shell that joins them with pipes, redirections,
variables, loops and scripts. The city's commands take part in that shell, so `stats --once | grep fps` works, and
the city can be read as files under `/proc/city` and set by writing to files under `/sys/city`.

The layer rests on four decisions, each held by tests:

- **Nothing reaches the machine.** The files live in the page's memory and, when the browser allows it, in the
  page's own IndexedDB. No program can open a file of the computer, reach the network or read the clock by itself:
  the folder imports nothing from outside, names no host global, and is handed its clocks, its random bytes and its
  saved disk by whoever builds it (`os/airgap.test.ts` scans every file for this).
- **It never holds the page up.** Every program is a generator that the kernel runs in short turns, and the host
  gives the kernel a budget of steps and a deadline on each call, so a program that loops for ever runs only in those
  short turns, and Ctrl+C stops it.
- **It is deterministic and bounded.** The same calls in the same order, on the same clock readings, give the same
  result, because every wait is a question the scheduler asks again, never a timer. Every table, buffer, file system
  and expansion has a cap. Past most of them a call is refused by name with nothing changed; the terminal's lines and
  backlog and the generated files under `/proc` and `/sys` are cut instead.
- **Nothing changes for a console command typed alone.** The gate sends such a line to the console's own handler,
  exactly as before; only the other lines go to the shell.

## How a typed line is routed

`run()` in `commands.ts` asks four questions, in this order:

1. **Is something already reading the terminal?** A program that reads what is typed (`cat > notes`), or the shell
   in the middle of a command it needs more lines for (after `for w in a b; do`, under the `> ` prompt), takes the
   next line whatever it says, even when it names a console command.
2. **Is it `y` or `n` alone while a proposed city action waits?** Then it is `act ok` or `act no`, as before.
3. **Does it start with a command that takes the rest of its line whole?** `run`, `ask`, `say`, `r0`, `ring0`,
   `noir`, `goal`, `agent`, `sloane` and `swarm` go to the console with the whole line, operators and all.
4. **Is it one of the console's commands, typed without an operator standing alone?** Then the console runs it as it
   always did. `echo` is the exception: it is the shell's, so its words are expanded.

Everything else goes to the shell. An operator counts when it stands alone between blanks (`|`, `||`, `&&`, `;`, `&`,
or a redirection such as `>`, `>>`, `<`, `2>`, `2>&1`), when a word after the first ends in `;`, or when the line
holds a second line (`hasOperator` in `parser.ts`; its tests check that it agrees with the shell about where a
console command ends).

| Typed line | Who runs it | Why |
| --- | --- | --- |
| `stats` | the console, as before | a console command, alone |
| `time 18:30` | the console | the same; the argument is read the console's way |
| `ls -l /bin` | the shell | not a console command |
| `echo $HOME` | the shell | `echo` is the shell's, so `$HOME` is expanded |
| `stats --once \| grep fps` | the shell, which runs `stats` through the console's handler | a `\|` stands alone |
| `laws > laws.txt` | the shell | a redirection stands alone |
| `ask what opens late?` | the console | `ask` takes the rest of its line whole |
| `rain on`, while `cat > notes` reads | `cat`, as its input | a program is reading the terminal |

A console built with no host (a test that calls `replSession()` alone) has no layer: it is its command table alone,
and an unknown word is still `ash: <word>: not found`. On the page both consoles (the city's, and the console alone
at `?boot=tty`) have the layer, and `help` gains one line that points at `man intro` and `ls /bin`. The shell's
messages start with `ash:`, the prefix the console's own messages already used.

`shellLine` hands the line to the terminal, gives the layer one turn of at most 30 ms (`LINE_MS`), and answers with
what was printed by then; the rest follows on the timer. A line that holds `|`, `;`, `&`, `<` or `>`, or starts
with `for`, `while`, `until` or `if`, earns the progression's check toward the Computers skill (`progress.ts`) when it
is back at the prompt within that first turn, with nothing left to run and no error line in what it printed; the
check's line comes after everything the line printed. The test is on the line's text, so a quoted `|` counts too. Any
other line, a line still running after that turn, a failed line, and lines typed as a program's input earn nothing.
The console commands a shell line runs earn none of their own checks: `rain on | wc -l` counts no check line, and a
loop that sets the time three times earns no Optics check, only the line's own.

The history keeps a key, a token or a passphrase as dots (`redactForHistory`): the key of `ask key` and `say key`, what
follows the provider in `ask connect` (a leading http(s) address with no `@` in it stays), the token of `net join`, and
the passphrase of `ring0 unlock --elite` and `ring0 elite set`, each with everything after it on the line. It dots them
at the line's start and, in a shell line, wherever the shell starts a command (after `;`, `|`, `&&`, `then` and the
like); a line the console takes whole (question 3) is dotted only at its start, since nothing later in it runs as a
command. A secret the shell hands a console command in a form the typed text does not show (`sh -c 'ask key ...'`, a
quoted name, a script piped to `sh`) is recorded as the command takes it, and the console dots it in every history entry
that holds it (`OsSession.takeSecrets`, `scrubSecrets`). It is found as typed, with any run of blanks standing for one
(the shell hands a command that takes the rest of its line its words joined by one space), and as the shell read it,
with quotes and backslashes left out of both and a backslash before a line end joining the two lines, so
`"ring0" unlock --elite correct  horse`, `"ask" key sk-'V'7` and a key split by a backslash and Shift+Enter are dotted
too; the earliest place either way is where the dots start. The entries are searched as one text, so a key typed over
two of them (a continuation, a quote left open over Enter) dots the first from where it starts and the second whole.
No pattern is compiled from a secret, so one of any length is found in time that grows with the history's length. The
rows `history` lists are dotted the same way: the line that runs it, and every earlier entry, with the secrets taken in
this same turn as well as those the console has dotted already, so `"ask" key ...; history > notes` writes no key to
the disk. Each secret dots the listed line once, as it is taken, so a loop that hands one over again and again makes
the listing no slower. The reply to the shell's own `read` is input, as a program's is: it stays out of the history.

## The kernel

### Tasks are generators

A program is a function `(sys, argv) => Task<number>`, where a `Task` is a generator that yields a `Wait` and returns
the exit status. A `Wait` is a question, `ready()`, with a word for `ps` (`sleep`, `pipe`, `tty`, `wait`, `io`,
`city`) and, for a wait on the clock, the time it names. When a program cannot go on (an empty pipe, a child that has
not finished, a sleep), it yields the wait, and the kernel asks the question again on a later pass. An answer that
arrives from outside later (the saved disk, a console command's later lines) is a `Later`, which the host settles
once; a driver that answers at once hands back the value itself, and the same code serves both. `now()` runs a task
that must never wait (the host listing a directory for Tab) and refuses by name if it would.

Every call a program makes goes through its `Sys` object: files (`open`, `read`, `write`, `seek`, `stat`, `list`,
`mkdir`, `unlink`, `rename`, `chmod` and the rest), descriptors (`dup`, `dup2`, `pipe`, `close`), tasks (`spawn`,
`exec`, `wait`, `poll`, `stop`), the clock (`now`, `wall`, `sleep`), the terminal (`prompt`, `foreground`) and mounts.

### The scheduler's step budget and deadline

The host calls `run(steps, deadline)`. The kernel passes over the task table in order of task number, starting after
the task whose turn ended the previous call, and gives each task that can go on one turn: it runs to its next wait, or
until it has made 256 calls into the kernel (`SLICE`), when it must let the others run. Every 8 calls (`LOOK`) the
turn also looks at the clock and ends there once the deadline has come, so a turn whose calls each move many bytes
(`cat /dev/zero`, `seq` into a file) still hands the page back on time. `run` returns as soon as the budget of calls
is spent, the clock reaches the deadline, or nothing can move. Nothing in the kernel starts a timer or reads a clock
of its own; it reads only the clock the host gave it.

The console gives it 200,000 calls (`PUMP_STEPS`) and 30 ms for a typed line. After that `Terminal.tsx` gives it a
turn of 4 ms every 16 ms while it has work (12 ms when the console is full screen, where there is no city to draw),
and looks every 250 ms when it has none. A shell loop of 20,000 rounds answers its first turn with nothing and
finishes over later turns (`terminal/oslayer.test.ts`).

A turn can end only at a call into the kernel: JavaScript between two calls is not cut. So every long loop in the
programs makes a call (`sys.step()` counts one; `sys.breathe()` gives the turn away at once), and grep and sed count
the pattern engine's work and give the turn away after about every 131,072 steps of it.

How a task ends: its return value, cut to eight bits; `sys.exit(n)`; a refusal it did not catch, which prints the
reason on its error output and ends it with 1; a write to a pipe nobody reads, which ends it quietly with 141; any
other fault, which ends it with 70 and a line in the kernel's log (`dmesg`). A fault never reaches the host. Ctrl+C
ends a task with 130, and `stop` with 143 unless told otherwise. If task 1 ever ended, every other task would be
stopped with 137.

### Descriptors and pipes

A task holds up to 32 descriptors (`FDS_MAX`), each an open file, a pipe end or the terminal. Several descriptors may
share one, and it is closed when the last of them goes. A new descriptor takes the lowest free number. `spawn` hands
the child descriptors by the parent's numbers (by default 0, 1 and 2), and `ls /proc/<n>/fd` with `cat` shows what
each is (a path, `pipe:[3]`, `tty`).

A pipe holds 65,536 bytes (`PIPE_MAX`). A writer waits while it is full and a reader while it is empty; a reader is
told the end has come once the last writer has closed, and a writer is refused once the last reader has closed, which
is how `seq 1 1000000 | head -1` stops. A write of 4,096 bytes or fewer goes in whole or waits, so two such writes
from different writers never mix.

### The terminal

Going out, `tty.ts` turns bytes into lines: UTF-8 put back together across writes, a carriage return back to the first
column, a tab to the next multiple of eight, colour and cursor sequences and other control characters dropped, and
ordinary and error output kept apart so the console can colour them. A line is cut at 2,048 characters, and at most
4,000 lines wait to be collected (older ones are dropped and counted). Coming in, typed lines queue, at most 256 at
once (more is refused whole: `ash: too many lines are waiting to be read`), and each read takes one line. Only the
foreground group may read: a job left in the background that reads is told the input has ended, so it never takes a
line meant for another. Ctrl+D on an empty line is one end of input for whoever reads; on a line with text,
`Terminal.tsx` deletes the character after the caret, as it shows (a flag, a skin tone, joined emoji and a letter with
its accents go whole, as the browser's own forward delete takes them, where the browser has `Intl.Segmenter`; else one
code point, both halves of a surrogate pair together), or the selection instead, as readline does, and a held Ctrl+D
that has just emptied the line does not go on to end the input. A write of more than 16 KiB reaches the screen a piece
at a time (`SCREEN_PIECE`), with a breath between pieces, so one line of megabytes cannot hold the page past its turn;
each piece ends where a character does, so another writer in the breath, or a Ctrl+C that ends the writer, never meets
half a character. In the city, a key that opens the console (`isToggleKey` in `commands.ts`: the key left of 1, or a
typed `` ` `` or `~`) closes it only when it is the key left of 1 (or a lone `` ` ``), pressed alone (no Shift, Alt,
Ctrl, Meta or AltGr, which Linux and ChromeOS report as AltGraph alone) on an empty line, and only where that key types
`` ` ``, `^`, `²`, `§` or `½` or is a dead key (`closesOpenConsole`); anything else that key types is the layout's own
character (Hungarian `0`, Russian `ё`, Italian `\`, Norwegian `|`), always typed. So the shell's `~` and the language's
`~` and `^` can be typed on every board, and no layout loses a character it needs to begin a line. The repeats of a held
key that opened the console type nothing in it. Esc closes the console from any line.

### Groups, jobs and Ctrl+C

Every task is in a group. The console's shell gives each job it runs a group of its own and hands that group the
terminal; a job sent to the background with `&` has its own group but not the terminal. `jobs`, `fg`, `wait` and
`stop` are the shell's commands for them.

Ctrl+C (the Stop button on a touch screen) forgets the lines typed ahead, ends every task of the foreground group with
130, and tells the console's shell to give up the line it was running. A shell waiting at its prompt is handed an end
of input, so it notices at once and drops a command it was half way through reading. Background jobs and task 1 go
on. There is no key that pauses a job to resume it later.

### The task table and its caps

| Cap | Value |
| --- | --- |
| Tasks at once | 64 (`PROCS_MAX`); one more is refused |
| Descriptors per task | 32 (`FDS_MAX`) |
| A task's arguments, and its environment | 131,072 bytes each (`ARGS_MAX`) |
| Calls in one turn | 256 (`SLICE`) |
| Calls between two looks at the clock | 8 (`LOOK`) |
| Statuses kept for a `wait` that comes late | 256 |
| Lines of the kernel's log | 200 |
| Scripts whose `#!` line names another script | 4 deep |
| Mounts | 32 |

`spawn` and `exec` look the program up first, so a name that runs nothing is refused before anything changes; `wait`
and `poll` answer only for a task's own children, and a task whose parent ends passes to task 1. Task 1 reads the
saved disk, lays out the tree, mounts the file systems and starts the shell at the terminal. When that shell ends, or
cannot be started because the table is full, task 1 logs why and tries again a quarter of a second later, for as long
as the console lives.

## The file system

### The tree

`vfs.ts` is one tree of drivers mounted over directories. It walks a path one name at a time and is the one place
that checks the permission bits against who asks, refuses writes to a read-only mount, keeps a mount point from being
moved or removed, and refuses a move from one driver to another (`mv` then copies and removes). There are no links, so
`..` is settled from the path's own text before the walk, and no spelling of a path can step outside the tree. A path
that ends in `/` names a directory or nothing, so `rm notes/` never removes the file `notes`.

- **`/`, the disk** (`memfs.ts`, kept between visits): `/home/operator` (`~`, with a `README` on a new disk), `/etc`
  (`hostname`, `passwd`), `/mnt` (empty), and anything made outside the mounts below.
- **`/bin`** (read-only, part of the page): one file per program, whose first line `#!native <name>` names the body
  the kernel runs.
- **`/usr`** (read-only, part of the page): `/usr/share/man`, one file per manual page, and `/usr/apps`, empty.
- **`/tmp`** (`memfs.ts`, scratch, gone when the page closes): mode 1777, the sticky bit, so a name in it is removed
  or moved only by its owner, the directory's owner or user 0.
- **`/proc`** (generated): a directory per task (`status`, `cmdline`, `cwd`, `environ`, `fd/`), `self`, `mounts`,
  `uptime` and `version`, and the host's `city/`, `cpuinfo` and `meminfo`.
- **`/sys`** (generated): `kernel/hostname`, `kernel/version`, and the host's `city/`.
- **`/dev`** (generated): `null`, `zero`, `full`, `random` and `urandom` (bytes from the source the host hands over;
  without one they read as an error), and `tty`.

A generated file is made when it is read, from the state of that moment, so its size always shows as 0. You are
user 0 at the prompt, and the permission bits still decide which files run as programs. The shell's path is
`~/bin:/bin:/usr/apps`, so a script kept in `~/bin` runs by its name.

### Limits

| Limit | Value |
| --- | --- |
| The disk at `/` | 8 MiB (8,388,608 bytes); see below for what counts |
| One file on the disk | as large as the disk |
| Files and directories on the disk | 4,096 (`DISK_NODES`; why: "When it is saved", below) |
| `/tmp` | 4 MiB; one file up to 4 MiB; 16,384 files and directories |
| `/bin` | 1 MiB; files up to 4,096 bytes; 4,096 nodes; sealed once built |
| `/usr` | 4 MiB; files up to 1 MiB; 4,096 nodes; sealed once built |
| A name | 255 characters, no `/` and no NUL, and it must survive being written as UTF-8 |
| A path | 4,096 characters, as typed and once made canonical |
| Depth | 64 names |
| A whole file read at once (`readFile`, `readAll`) | 64 MiB |
| A generated file under `/proc` or `/sys` | cut at 1 MiB |
| One read of a device | 65,536 bytes |

The disk and `/tmp` count every file's bytes plus 64 bytes and the length of its name for each file and directory, so
a great many empty files cannot hide from the capacity. Past a limit of a disk, of `/tmp` or of a path, the call is
refused by name (`ENOSPC`, `EFBIG`, `ENAMETOOLONG` and the like) and nothing is changed. Every change to the disk moves
a counter, which is how the console knows the disk needs saving.

### How the disk is kept

**The image** (`image.ts`) is the whole disk as one array of bytes: the header `CNDISK1\n`, a count, every file and
directory in an order where a directory comes before what it holds (its kind, permission bits, owner, group, time,
the index of its directory, its name, its bytes), then the SHA-256 of all of that. Reading an image trusts nothing in
it: the seal is checked first, every length against what is left, and each node is put back through the disk's own
calls, so a name a file cannot have, a file inside a file or more than the disk may hold is refused exactly as it
would be from a program. An image that fails any check is refused whole, and the disk is left empty, its root as it
was. An image that passes its checks but holds something other than a directory where `/bin`, `/usr`, `/tmp`, `/dev`,
`/proc` or `/sys` is mounted is not refused: that entry is moved to the first free name of `tmp.file`, `tmp.file.1` and
so on (for `/tmp`; the same for the others), the kernel's log (`dmesg`) says so, the rest of the disk comes back, and
the disk is saved again as it now stands. When the disk has no room for the longer name, the entry stays where it is,
the log says so, and nothing is mounted there. `umount` cannot make such an entry from the prompt: it leaves those six
mounted.

The body and its seal can be made apart (`System.snapshotBody`, with image.ts `sealed` and `SEAL_BYTES`). Where the
page has the browser's own SHA-256 (`crypto.subtle`), which does not hold the page up while it works, a timed save is
sealed with it. A save made as the page is hidden or goes is sealed at once with the layer's own (`sha.ts`), so the
store is asked before anything else is waited for; so is every save where the browser has no digest, and one whose
digest fails, answers anything but a 32-byte seal, or has not answered within 4 seconds (`SEAL_MS` in `Terminal.tsx`).
An image that comes back is always checked with the layer's own.

**The store** (`consoleDisk.ts`) is one IndexedDB database of the page, `civic-simulation:console-disk`, with one object
store, `disk`. Its row `image` holds the disk, stored with a generation number; the copies of images that failed their
check are rows beside it: the first under `refused`, each later, different one under `refused:` and the hex of its last
8 bytes, at most 8 in all (`REFUSED_MAX`). A copy is never written over, and the same image again adds nothing. Every
wait on the browser is given 4 seconds (`OPEN_MS`): opening the database and reading the image together, each save, and
each copy set aside. A load past it is refused, as a store that could not be read is; a save past it answers `failed`,
and a write that still lands later moves this page's generation with the stored one. A timed save is one transaction
that asks for the stored generation and the write together, and undoes itself, write and all, unless the stored
generation is this page's as it stands when the read answers; then it answers `stale` and has written nothing, so a
second tab that fell behind never writes over the newer disk. The browser runs the site's writing transactions one after
another, in the order they were asked for, so by the time that read answers every earlier write of this page has landed
(and moved its generation, even one the console gave up on) or failed: a save asked while the page's own late write
still waits in line is kept, not told `stale`. Every write's generation is above any the page asked for before. A save
made as the page goes (`save(image, true)`) cannot wait for a read: a page being reloaded runs nothing after it has
gone, and its storage work ends with it. It is one write, committed at once (`IDBTransaction.commit`), and answers
`stale` without writing when another page of the site has said it saved a newer generation: each page says so after
every save it kept, on a `BroadcastChannel` named after the database, and a save made as the page goes says so as soon
as it is committed, since a page being reloaded never sees it answer (if that write then fails, the other page has been
told `stale` wrongly, but it has been told). It also cuts short this page's timed save still with the store, which would
hold it up behind a read: the timed save answers as the write that replaced it does, whose image holds all it held. A
save another page made in the last few milliseconds, before its word arrived, can still be written over by it. If the
store could not be read at all (refused, failed, or no answer), the console says so at once and every save is refused
for the visit, because an image that may still be there must not be replaced by an empty disk. Both consoles hand the
layer the same store; a console opened again in the same page reads the disk afresh, so it gets what was last saved.

**When it is saved.** `Terminal.tsx` saves the disk 1.5 seconds after it sees a change (`SAVE_MS`; with more than 1 MiB
in use, 1.5 seconds for each MiB, and at least 50 times as long as the last image took to make, `SAVE_SPACING`, so
saving a disk of many small files takes no more than a fiftieth of the page's time; 10 seconds at most), and at once
when the page is hidden and when it starts to go: while a change is unsaved or a save is on its way, the page listens
for `beforeunload`, which comes while a reload or a navigation can still write (`pagehide` comes too late for that in
Chrome), and listens no more once all is saved, so the browser can still keep the page whole for the back button. A
timed save still on its way then is asked for again, committed at once, since the page going would take it along, and a
save asked while one is with the store asks for the newest image at once, behind it, not once it has answered. A change
made in the last moment before a reload can still be lost, more likely on a large disk. Before the page goes it saves at
once and waits for the store's answer, 4 seconds at most, then goes anyway: before `boot` or `map` reloads the page, and
before **Back to the city** or the cards' **Open the console** does (App.tsx `reboot`, through `Terminal.flushAll`). It
waits once: when the store did not answer in time, the page's own reload that follows goes at once. Only a disk that
changed since its last image is saved; one that came back as it was saved is not written again. The image is made on the
page's own thread (`System.snapshotBody`) in one pass that sizes it and one that writes it, into one array with room for
its seal, each file's bytes copied once straight from the disk (`MemFs.bytesOf`): a few milliseconds for a disk of 4,096
small files on a laptop, tens of milliseconds for one near its 8 MiB, with the browser's digest and the store each
copying it once more. The cap of 4,096 files bounds the walk; the bytes are what a full disk costs, and why its saves
are spaced by that cost. On the next visit the saved image's seal is checked with the browser's own digest before the
disk is restored (`SystemOptions.sealChecked`): its hashing runs off the page's thread, but the call copies the image on
it, several milliseconds for a full disk, and the restore walks it again, so a disk near its 8 MiB costs the boot tens
of milliseconds on a slow machine. Without a digest, or when it answers anything else, the layer's own SHA-256 checks
it. A digest that answers the seal itself, not as a promise, is taken as its answer.

**What the system does with what it is given.** Until the store has answered, the system waits (`waiting`): nothing
is laid out, and typed lines wait. Then it is one of:

- `new`: there was no image, or it could not be read (the log says why). The tree is laid out, and a new disk gets
  `/etc/hostname`, `/etc/passwd` and `~/README`.
- `restored`: the image passed its checks, and the disk is as it was saved.
- `refused`: the image failed. The disk starts empty and new, and before anything is saved the old image is copied
  to a row of its own beside it; the console says `disk: the saved disk failed its check and was set aside; this is a
  new, empty one`. If that copy cannot be kept (8 are kept already, or the store refused it or did not answer), the
  stored image is left where it is and this visit's files are not kept.

**When there is nowhere to keep it.** The console says once `disk: files are not kept between visits from here on:` with
the reason, and the files then last as long as the page. The reasons: the store could not be read
(`the storage could not be read, so nothing is written over what it may hold`), said as the console starts; another page
of the site saved a newer disk (`reload this one to open it`); saving failed three times running, which is also what
a browser that gives the page no storage comes to (`the browser refused to store them`; a save the store did not answer
within 4 seconds, and an image that could not be made, whose change stays owed, each count as one); or the console was
given no store at all (`this page has nowhere to keep them`), said only once the disk holds a change of the person's
own, since a new disk that holds only what every disk starts with has nothing to lose. Clearing the site's data in the
browser erases the disk.

## The shell

`parser.ts` reads a line or a script into a tree, and `shell.ts` runs it. `man sh` is the user's description; in
short:

- **Words and quotes:** blanks separate words; `'single quotes'` keep everything; `"double quotes"` keep blanks but
  still replace `$variables` and `$(commands)`; a backslash keeps the next character; `#` at the start of a word begins
  a comment.
- **Variables:** `NAME=value`, `$NAME`, `${NAME}`, `${NAME:-word}`, `${NAME:=word}`, `${NAME:+word}`,
  `${NAME:?message}`, `${#NAME}`, `${NAME%pat}`, `${NAME%%pat}`, `${NAME#pat}`, `${NAME##pat}`, `export`, `unset`,
  `$?`, `$$`, `$!`, `$1`, `$2` and on, `$#`, `$@`, and `~` for the home directory.
- **Substitution and sums:** `$(command)`, each run in a task of its own, and `$((...))`, whole-number arithmetic that
  is exact or refused by name (division by zero, a number past the largest safe integer, text that is no sum).
- **Patterns:** `*`, `?` and `[a-z]` over file names, in order; a pattern that matches nothing stays as typed; names
  that start with a dot only for a pattern that starts with one. Matching costs at most the name's length times the
  pattern's.
- **Joining:** `|`, `;`, `&&`, `||`, `&`, `!` and `{ a; b; }`.
- **Redirection:** `>`, `>>`, `<`, `2>`, `2>&1`, and here-documents with `<<` and `<<-`.
- **Conditions and loops:** `if`, `elif`, `else`, `while`, `until`, `for ... in`, `break`, `continue`, `return`, and
  `test` and `[ ]` (`cond.ts`).
- **Its own commands** (24 names): `cd`, `pwd`, `echo`, `read`, `export`, `unset`, `exit`, `source` and `.`, `type`,
  `umask`, `shift`, `true`, `false`, `:`, `test`, `[`, `jobs`, `wait`, `fg`, `stop`, `break`, `continue`, `return`.
- **The prompt:** `host:directory# ` with `~` for the home directory, or `PS1` when it is set (`\h`, `\w`, `\u`,
  `\$`); `> ` while a command needs more lines.
- **At login:** each time the console's shell starts, it reads `/etc/profile` and then `~/.profile`, where they exist
  and can be read, as `source` would, so a variable or a `PS1` set there holds at the prompt. A new disk has neither.
  `exit` in a profile closes the console as it does at the prompt: what was typed before the shell started is dropped,
  the rest of the login (the next profile) does not run, and the first prompt's `$?` is its status.
  One that cannot be read, or whose commands are refused, is said (`ash: /etc/profile: is a directory`) and passed
  over.
- **Exit:** `exit` at the console's own shell closes the console (`exit` is the console's word for that) and gives up
  the rest of the line and of any file read with `source` on the way, so `cd /nowhere || exit; rm -r *` removes nothing,
  `while true; do exit; done` closes the console once, and the next prompt's `$?` is the status `exit` was given. What
  was typed with it or ahead of it is dropped too, as with Ctrl+C: `cd /tmp/build || exit` and `rm -r *` sent as two
  lines of one entry (Shift+Enter, or a paste) remove nothing. In a
  job sent to the background, a `$( )` or a stage of a pipe, it ends that part alone, with its status, and the console
  stays open; in a script run as a program or with `sh -c`, it ends that shell.
- **Status:** that of the last command; 2 for a line it could not read; 127 when a command was not found; 130 after
  Ctrl+C.

What it does not do, as `man sh` says: no functions, no `case`, no `( )` subshells, no `set`, no arrays, no
backquotes (use `$( )`), no pausing a job with a key to resume it, and no aliases. A script written for a larger shell
may need changes.

Its caps: a pattern expands to at most 16,384 names; one word to at most 67,108,864 characters (64 Mi), and all the
words of one command to twice that; one command to at most 262,144 words; `$( )` and `source` nest 32 deep; lists
(loop bodies, groups, conditions, scripts read with `source`) nest 256 deep in one task; the reader nests 64 deep; a
here-document holds at most 65,536 bytes; a sum nests 64 deep. Each is refused by name rather than running the page
out of memory or stack.

### The city's commands inside the shell

When the first word of a command is one of the console's commands, typed plain (not quoted and not after an
assignment), the parser reads the rest of that command the console's way: quotes removed, nothing replaced or
expanded, ending at a line end, at `|`, `||`, `&&`, `;` or `&` standing alone between blanks, at a word that ends in
`;`, or at the `)` that closes a `$( )`; a redirection that stands alone applies to the command. So
`topic list ~/# | wc -l` hands `~/#` to `topic` as typed. The commands that take the rest of their line whole still
do. The shell runs the command through the same handler the console uses, with the same checks and tier locks:

- **Typed straight to the screen** (no pipe, no redirection), the command's answer reaches the console as its own
  result, in order with the lines around it, so `echo before; clear; echo after` clears the screen between the two
  lines, and a live view still draws.
- **Inside a pipe or a file**, only its lines are passed on: clearing the screen, closing the console or a live view
  happen only when the command is typed at the prompt.
- **An answer that comes later** is waited for: `ps -f` shows the shell waiting on `city`, and Ctrl+C gives up the
  wait.
- **Its status** is 1 when its answer held an error line and 0 otherwise, so `time 99 || echo refused` prints the
  refusal and then `refused`.
- **A proposal is answered only at the prompt.** `act ok` and `act no` run by the shell (in a pipe, a list, a loop, a
  job, a script or a profile) decide nothing and print
  `act: a proposal is answered at the prompt: type act ok, act no, y or n on its own`, so no job or script can answer,
  in the person's name, a proposal nobody has read. `act`, `act log`, `act list` and `act gate` still run there. Typed
  alone, `act ok`, `act no`, `y` and `n` answer as before.
- **At most 32 a turn.** The shell runs at most 32 console commands in one turn of the layer (`CITY_TURN_MAX`), each
  read or write of a file under `/proc/city` or `/sys/city` counted as one; the rest wait for the next turn, in order,
  and the shell waits with them. So `while true; do rain on; rain off; done` reaches the city 32 times a turn, at the
  pace of the turns, and never fills the engine's queue of commands, which drops what does not fit (the person's own
  among them). A turn the console gives because an answer arrived goes on with the share it has until a frame (16 ms)
  has passed, and within the share's time (a turn's worth from when the share began), so a loop whose command answers
  at once (`memory`, over a store kept in memory) cannot run a new share on each answer, even beside a job that fills
  every turn; and `Terminal.tsx` gives such a turn as a task of its own, never inside the promise that brought the
  answer, so the page draws and reads keys between them. Commands owed to a later turn run within that turn's time, one
  at least, and one owed to a line Ctrl+C gives up, or to a job that has ended (tasks asked to end are ended first, so
  a command under `timeout` goes with it), is dropped rather than run for nobody, without a word beyond the `^C`.

### When a city command and a program share a name

The shell looks a name up in this order: its own commands, then the console's commands, then the files along its
path. A quoted name (`"time"`) or a name after an assignment is still the console's command, only with its words read
the shell's way; a path runs the program. Five names are shared today:

- `echo`: the shell's own wins, inside the shell and, through the gate, at the prompt.
- `exit`: the shell's own; in the console's shell it runs the console's `exit`, which closes the console, and then
  gives up the rest of the line (above).
- `time`, `uname`, `whoami`: the console's command answers, and `/bin/time sleep 1` runs the program.

`type <name>` says which of them the shell would run.

## The city as files

`cityfs.ts` builds the host's part of `/proc` and `/sys`. Most files there are console commands seen as files:
reading one runs the command and gives its lines; writing one runs the command with what was written, through the
same handler, the same checks and the same tier locks. The rows (`crowd`, `cars`, `frame`), `topics/`, `cpuinfo` and
`meminfo` read the same tables and reports the commands read. So `echo 18:30 > /sys/city/time` is `time 18:30`, and
it is refused, with the command's own message and status 1, exactly when `time 18:30` would be. Nothing here is a
second way in, and a file read or written earns none of the console commands' own progression checks (the shell line
around it is counted as any shell line is). Each read or write of a file under `/proc/city` or `/sys/city` counts as
one of the 32 console commands the shell may run in a turn (`CITY_TURN_MAX`, above); past them it is answered on a
later turn, so a loop that writes a knob goes no faster than one that runs the command. No file answers a proposal:
none runs `act ok` or `act no`, and the console refuses either for a file as it does for the shell.

- **Readings, `/proc/city`** (read-only): `stats` (what `stats --once` prints), `laws`, `kernel`, `hardware`,
  `rooms`, `lanes`, `version`; `crowd` (one line per person, `x z` in city metres), `cars` (one line per car,
  `x z heading speed mode`) and `frame` (`fps`, `ms`, `p95`, one per line), each number with two decimals but a
  car's mode, a whole number; and `topics/`, the unified namespace as a tree: a directory per level, a file per topic
  holding its value. `crowd` and `cars` print at most 16,384 rows (`ROWS_MAX`); when there are more, a last line
  starting with `#` says how many were left out.
- **The machine:** `/proc/cpuinfo` (threads, class, graphics adapter, host) and `/proc/meminfo` (memory only where the
  browser says it, shown as `8 GiB or more` from 8 up).
- **Knobs, `/sys/city`** (read and write): `time`, `quality`, `audio`, `ghost`, `rain`, `render`, `captions`,
  `haptics`; `operator` (read-only: whether the operator tier is unlocked); and `physics/` and `shaders/`, one file per
  tuning key, listed only while the operator tier is unlocked, where a write is `set physics.<key> <value>`.

On the console alone (`?boot=tty`) there is no city: most readings are refused when read, each with its command's own
message (`stats: engine not running`), and `crowd`, `cars` and `frame` with `kept by the city: boot gui to see it`. A
reading is made when it is read, so two reads can differ. `man city` is the user's page.

## The programs

`/bin` holds 67 programs: the 66 of the six program files below, and `sh`, the shell itself. The console's manual
holds 70 pages: one for each of those 66, the three topic pages of `manual.ts` (`intro`, `sh`, `files`), and `city`,
which the console adds. Each line below says what the programs do and the gaps their own pages admit.

**Files** (`fileutils.ts`, 19):

- `basename`, `dirname`, `realpath`: the last name of a path, the path without it, the path in full.
- `cat [-n]`: files one after another, numbered with `-n`.
- `chmod [-R]`: permission bits by number or by clauses (`u+x`, `go-w`, `X`, `t`); a clause cannot copy one set from
  another (`g=u`).
- `cp [-r]`: copies files and trees; no `-p`; a copy that fails part way leaves what was written; devices in a tree
  are reported and not copied.
- `df [-h]`: how full each file system is; `/proc`, `/sys` and `/dev` show `-`.
- `du [-s] [-h]`: the bytes in files; directories, devices and generated files count nothing.
- `find`: `-name`, `-iname`, `-path`, `-type`, `-empty`, `-size`, `-newer`, `-maxdepth`, `-mindepth`, `-print`,
  `-delete`, `-exec ... ;`, with `!`, `-o` and `\( \)`; no `-exec ... +`, `-prune`, `-mtime` or `-user`; `-exec`
  runs programs, not the shell's own commands; `-delete` refuses a search from `/`; 64 directories deep at most.
- `ls [-laAd1RhFStr]`: names in columns on the screen, one per line into a pipe; the long form has no link count, no
  group and no `total` line.
- `mkdir [-p] [-m mode]`, `rmdir [-p]`, `touch [-c]`: make directories, remove empty ones, make or stamp files;
  `touch` sets only the present time.
- `mv`: moves and renames, and never asks before replacing; a mount point cannot be moved; a move between file systems
  that fails part way may leave a directory partly in both places, each part reported.
- `rm [-r] [-f]`: never `/`, a path that ends in `.` or `..`, a mount point, or anything in a read-only place.
- `stat`, `tree [-a] [-d] [-L depth]`: what is known about a file; a directory and what is below it, drawn.
- `mount`, `umount`: what is attached where, and detaching; attaching a folder from the prompt is not available yet,
  and `mount` with any argument says so and does nothing. `umount` leaves `/` and the system's own `/bin`, `/usr`,
  `/tmp`, `/dev`, `/proc` and `/sys` where they are (`umount: /tmp: the system keeps it mounted`, status 1; the list
  is `MOUNT_POINTS` in `system.ts`), so today there is nothing it can detach.

**Text** (`textutils.ts`, 21):

- `head`, `tail`, `tac`: the first lines, the last lines, the lines last first; no `tail -f`; `tail` and `tac` refuse
  to hold more than 64 MiB.
- `wc [-lwmc]`, `nl`, `rev`, `fold`: count, number, reverse and fold lines; `nl` knows no pages or sections; `fold`
  counts every character as one column.
- `sort [-rnufb] [-k field] [-t sep]`: character-code order only; `-k` takes one field; no `-o` or `-c`; at most
  64 MiB held.
- `uniq [-cdui]`, `cut`, `paste`, `tr [-cds]`, `tee [-a]`: `uniq` takes no output file; `tr`'s classes are ASCII only,
  and `[=c=]` and `[c*n]` are not read.
- `seq`, `yes`, `echo`, `printf`: numbers, a repeated line, words, formatted text; `seq` reads no exponents and fits
  every number in 15 digits; `printf` has no `%f`, `%e`, `%g`, `*` or `#`.
- `base64 [-d]`, `hexdump [-C]`, `sha256sum`: an encoding, a dump of the bytes, and a digest that reads a piece at a
  time; no `sha256sum -c`; `hexdump` prints repeated lines rather than a `*`.
- `xargs [-0r] [-n count] [-I word]`: runs a program with words read from its input; not the shell's own commands;
  no `-L`, `-s`, `-t`, `-p` or `-E`.
- `cut -f` and `-c`, `fold`, `nl`, `paste`, `rev`, `sort`, `tr`, `uniq` and `xargs` read UTF-8 text, and other bytes
  come out as U+FFFD; the line tools among them may cut a line longer than 1,048,576 characters.

**System** (`sysutils.ts`, 21):

- `ps [-eAf]`, `dmesg`, `uptime`: the tasks (with `-f`, their group, what they wait on and their directory), the
  kernel's log (200 lines, which cannot be cleared), the time since start; `ps` has no memory or time columns.
- `env [-i]`, `printenv`, `id`, `whoami`, `hostname`, `uname [-asnv]`: the environment, and who and where you are;
  only user 0 has a name; the host name cannot be changed; no `uname -r` or `-m`.
- `date [-u] [+format]`, `cal`: the day and a calendar, in UTC; `date` cannot set the clock; `cal` marks no today and
  takes a month as a number.
- `sleep`, `timeout`, `time`: wait; stop a command after a time; say how long a command took. `timeout` and `time` run
  programs only, not the shell's own commands or the city's; `time` measures only the time that passed and times
  only the first command of a pipe; `timeout` has no options.
- `man [-k]`, `which`: the manual (a page printed whole, with no stopping after each screenful; `-k` searches names and
  summaries), and the file a name runs (files only: `type` says what the shell would really run).
- `test`, `[`, `true`, `false`, `pwd`: files for other programs to start (`env test -d /tmp`); typed at the prompt,
  the shell's own commands of those names answer.

**Comparing** (`diff.ts`, 3):

- `diff [-u] [-U N] [-q] [-i] [-b] [-w]`: the fewest changes between two text files of up to 100,000 lines each; past
  20,000 changed lines, or a search that runs too long, one change from the first difference to the last; a binary
  file is only reported as different; no directories, no `-c`, no side-by-side form.
- `cmp [-s] [-l]`: two files byte by byte.
- `comm [-1] [-2] [-3]`: the lines two sorted files share and the lines they do not; a file out of order is reported
  once.

**Searching and editing** (`grep.ts`, `sed.ts`):

- `grep [-cEFhHilLnoqrsvwx] [-m N] [-A N] [-B N] [-C N]`: the lines that match; no back-references, no patterns read
  from a file, no colours; word characters are ASCII; a binary file prints `Binary file NAME matches`; `-r` goes 64
  directories deep.
- `sed [-n] [-E] [-i] [-e script]`: addresses, `s` with its flags `g`, `N`, `p` and `i`, the commands
  `d p = q y a i c n N D P h H g G x { }`, and editing in place; no labels or branches (`b`, `t`, `:label`), no `r`,
  `w` or `l`, no `-f`, no `\1` inside a pattern, no `\L` or `\U`; the pattern and hold spaces hold at most 8 MiB each.

**The shell:** `sh [script]` and `sh -c 'commands'`.

## The pattern engine

`regex.ts` is the layer's own regular-expression engine, and the only one its programs use on a pattern somebody
typed; the host's own matcher is never given one. A matcher that tries one path at a time can be handed a pattern
that outlasts the page: `(a+)+$` over thirty `a`s and a `b` takes such a matcher in the order of 2 to the power 30
steps. This engine reads the pattern into a tree, lays the tree out as a short list of instructions, and runs the list
by keeping every path alive at once: all the paths at one position of the text take their step together, and an
instruction is visited at most once per position. A search therefore costs at most 2 x (instructions) x (characters
+ 1) steps whatever the pattern and the text, and nothing in it recurses on the text. On that pattern it gives up in
at most 5,000 steps, and its steps grow in step with the text (`regex.test.ts`). Among the matches that start
leftmost, it gives the one a path-at-a-time matcher would reach first: repetition is greedy, and of two alternatives
the one written first wins a tie.

**Pausable.** A search can also be handed out as a scan: `run(budget)` does about that much work and returns, and the
next run goes on from exactly where it stopped, with the same paths alive. The answer and the step count are exactly
those of the same search done in one go, however the work is cut up. grep and sed run every search this way, so a long
one gives the other tasks a turn between runs and stops at Ctrl+C.

**Syntax.** Always the extended kind: `.` (any character, a line feed too); `[abc]`, `[a-z]`, `[^a-z]`, and the named
classes such as `[:alpha:]` inside a set; `^` and `$`, the start and end of the whole text (to grep a line, to sed the
pattern space); `( )` that group and capture; `|`; `*`, `+`, `?`, `{m}`, `{m,}`, `{m,n}`; `\t \n \r`; `\w \d \s`
and `\W \D \S`; `\b \B`; `\< \>`. Marks may be stacked, each repeating everything before it, so there is no lazy
repetition. The classes, `\w` and the word edges know the ASCII letters and digits only. With case ignored, two
characters match when they fold to the same one.

**Refusals,** each by name: a back-reference (`\1`, which cannot be matched in linear time), an unknown letter escape,
`[=a=]` and `[.a.]`, a range written backwards, `[:alpha:]` outside a set, an unmatched bracket, a repetition mark
with nothing before it, a pattern longer than 4,096 characters, groups nested more than 100 deep, and a pattern that
would lay out as more than 20,000 instructions, counted before anything is laid out, so `a{1000}{1000}` is refused
without being expanded. grep and sed also cap all the patterns given at once at 1,048,576 instructions.

## The air gap and the folder's rules

`os/airgap.test.ts` reads the text of every file in the folder and holds it to these rules:

- **Nothing from outside the folder.** A source imports only its siblings; a test may also use `node:assert/strict`,
  `node:test` and `node:fs`, and nothing else. No `require`, no dynamic import. `index.ts` is the one door the rest of
  the page uses.
- **No door to the host.** No dynamic code, no global object, no window or document, no network, no timers, no clock,
  no randomness, no storage, no workers, nothing asynchronous. Time, random bytes and the saved disk are handed in by
  whoever builds the system (`commands.ts` and `Terminal.tsx` on the page, a clock moved by hand in the tests).
- **Plain text.** The code of every source is printable ASCII, so every message a program prints of its own is;
  every file is named by one lower-case word; no tabs.
- **House words.** None of the words the repository bans from its console sources, and none of the words of harm.
- **The header.** The three licence lines, then a doc comment that answers "Why does this file exist?" and "What
  breaks if it is removed?".

Why: the layer's promise is that a program sees only what the kernel hands it. One import of a host module, or one
read of the real clock, would break that promise and the determinism the tests rely on, and nothing else would show
that it had gone. With the scan, a test fails as soon as one appears by name.

## How to add a program

1. **Write the body** in the file of its group, or in a new file named by one lower-case word. A program is a
   generator over `Sys`; every call that may wait is `yield*`-ed, and it returns its status:

   ```ts
   const hello: Program = function* (sys, argv) {
     if (argv.length > 2) { yield* sys.eprint('usage: hello [name]\n'); return 2 }
     yield* sys.print(`hello, ${argv[1] ?? 'operator'}\n`)
     return 0
   }
   ```

   `lib.ts` holds what the programs share: the option reader, the line reader and the buffered writer, the loop over
   named files, the reasons in a person's words. A long loop must make a kernel call now and then (`sys.step()` or
   `sys.breathe()`). A refusal left uncaught ends the task with status 1 and its reason on the error output; catch it
   where the program should go on (to the next file, say).
2. **Write its manual page**: `NAME`, then a summary line `    name - what it does`, then, in this order and only
   these, `USAGE` and `WHAT IT DOES` (both required), `OPTIONS`, `NOTES` (the honest gaps), `STATUS` (required),
   `EXAMPLE` and `SEE ALSO`; plain ASCII, at most 78 columns, no blank at the end of a line, and one line end at the
   end.
3. **Export both tables** from the file (`FOO_PROGRAMS` and `FOO_MANUAL`) and add them to `PROGRAM_TABLES` and
   `MANUAL_TABLES` in `programs.ts`. `programs.test.ts` then checks that no name is claimed twice, that every program
   has a page, that every page has the shape, and that a booted system's `/bin` and manual are exactly these tables.
4. **Test it the way a person meets it.** `boot(PROGRAMS)` from `kit.test.ts` starts a whole system in memory on a
   clock the test moves by hand, and `k.sh('hello world | wc -c')` types a line and gives back exactly what was
   printed (an error line starts with `!`). Check the output, the files left behind and the status, every option and
   every refusal.
5. **Keep the folder's rules:** the licence header and the two questions, no import from outside, ASCII code.

## How it is tested

The counts are as they stood when this page was written; `grep -c '^test(' <file>` recounts them. In `terminal/os/`:

- `airgap.test.ts` (6): the folder's rules above, on every file's text.
- `kernel.test.ts` (45): turns shared fairly; the budget and the deadline end `run` even for a task that never waits;
  spawn and exec refuse before changing anything; wait and poll for a task's own children; its caps; descriptors
  handed down and closed; pipes; Ctrl+C for the foreground group alone; Ctrl+D; sleeps; faults that end with 70 and
  never reach the host.
- `tty.test.ts` (16): lines across writes and split characters; the two streams apart; carriage return, backspace and
  tab; sequences dropped; the line and backlog caps; at most 256 typed lines, a flood refused whole; one end of input.
- `vfs.test.ts` (52): the walk and its permission checks; mount points; open flags; the sticky bit; moves; the depth
  and length limits; a trailing `/`; the disk's accounting; generated files, `/proc` and `/dev`.
- `path.test.ts` (12): canonical paths, each limit at its edge, shell patterns in linear time.
- `image.test.ts` (19): every kind of tree comes back exactly; the layout as documented; every corrupt or hostile
  image is refused whole and leaves the disk empty; the body and its seal made apart give the same image.
- `system.test.ts` (20): the tree task 1 lays out; each state of the saved disk; the count of files the disk holds; an
  entry of the wrong kind at a mount point moved aside under a free name; the image with or without its seal, the disk
  counted as saved only once it is made; the bytes in use; the shell started again when it ends; Tab's lists, filtered
  by the word before any file is checked; no saved disk, however it was left, keeps the shell from coming back.
- `parser.test.ts` (22): every construct read into the tree; console commands read the console's way; `hasOperator`
  agreeing with the shell; when more lines are needed; the nesting caps.
- `shell.test.ts` (65): every expansion, pipelines, lists, jobs, redirections, each of its own commands, scripts,
  console commands in pipes and lists, `exit` at the console ending the line, a sourced script, a loop and what was
  typed with it or ahead of it, Ctrl+C and
  Ctrl+D at awkward moments, and its caps.
- `arith.test.ts` (12): sums exact or refused by name; `&&`, `||` and `? :` working out only the side they take; the
  nesting cap.
- `lib.test.ts` (22): the shared line reader, writer, option reader, calendar, byte helpers and reasons.
- `sha.test.ts` (5): SHA-256 against the standard's own examples and every length where the padding changes shape,
  fed whole or in pieces.
- `regex.test.ts` (30): each construct; each refusal by its message; generated patterns beside the host's matcher;
  step counts on the shapes that stall other matchers; linear growth; scans cut at every budget.
- `fileutils.test.ts` (58), `textutils.test.ts` (61), `sysutils.test.ts` (32): the options and refusals of the file,
  text and system programs, typed at the real shell, among them `umount` refusing the system's own mounts, `rev`
  and `fold` working through a long line a slice at a time, and a line of megabytes reaching the screen in pieces.
- `diff.test.ts` (21): diff, cmp and comm, with generated pairs whose output is applied back to rebuild the second
  file.
- `grep.test.ts` (33): its options, binary files, long lines, stalling patterns, searches cut into turns and stopped
  by Ctrl+C.
- `sed.test.ts` (24): every address and command, editing in place, the words of every refusal, the limits, long
  searches stopped by Ctrl+C.
- `programs.test.ts` (4): the gathered tables and the shape of every manual page.
- `kit.test.ts` (0): the shared system under test; it holds no test of its own.

Around the folder, `terminal/oslayer.test.ts` (57) holds the console to the gate, console commands in pipes, the city as
files, lines typed while a program reads (and the reply to `read`), Ctrl+C, Tab, the progression check (once a line,
none for the console commands inside it), a proposal answered only at the prompt, at most 32 console commands a turn (a
turn's share and its time kept across answers that arrive at once, the waits between answers not counted against it,
Ctrl+C right after an answer given a share of its own, an owed command dropped with the line Ctrl+C gives up, under
`timeout` too, and without a word), the secrets the shell hands a command recorded for the history and found however
they were typed (over two entries, joined by a backslash, one key inside another, of any size) and not seen where the
shell never read them, `history` in a shell line (earlier entries dotted in the same turn, and a key split over two
Enters dotted in both, in that turn and a later one), every fate of the disk, a save sealed by the host's digest (or the
layer's own when the host's is no seal, and a digest that answers without a promise) or at once as the page goes (the
newest image asked for behind one with the store, a timed one still on its way asked again), timed, and never
throwing, the saved seal checked by the host's digest, the ten console lessons (`tutorial <n>`) passing with the layer
on, and the wiring in `Terminal.tsx` and `App.tsx`;
`consoleDisk.test.ts` (18) holds the store to its generations, its write asked for with
its read, its refusal to write over what it could not read, a fresh read for a console opened again, the rows an image
is set aside in (never one over another, eight at most), and the 4-second bound on the read, each save and each copy,
with a late write keeping the generations in step (one still in line ahead of the next save too), and the save made as
the page goes (one write committed at once, skipped when another page has said it saved a newer disk, its word said
at once, and this page's timed save cut short for it), over a stand-in
for IndexedDB; `consoleWiring.test.ts` (9) pins from their source what Node cannot render in `Terminal.tsx` and
`App.tsx`: what a closed console holds, Tab's row of at most 200 names, which results end a live view, the history's
dots, Ctrl+D on a line with text, the save the page waits for (once) before it goes, the seal and timing of a save, the
listener for the page starting to go, an answer's turn given as a task of its own, and the toggle key closing the
console only alone on an empty line, the repeats of the press that opened it typing nothing (`commands.test.ts` holds
`closesOpenConsole` to the layouts, and the browser smoke test's desktop run types `~` and a `` ` `` in the console,
closes it from an empty line and opens it again with `~` held down). That is 559 tests in the folder's 20 test files,
and 643 with the three around it. The browser's real IndexedDB is not exercised by these tests.

## What it does not do yet

- **No folder of the computer can be attached.** `/mnt` is empty, and `mount` with an argument says this is not
  available yet. A driver's calls may already answer later (a `Later`), as a folder of the computer would.
- **No full-screen programs and no application windows.** The terminal drops colour and cursor sequences, so a
  program can print lines and nothing else. `/usr/apps` is on the path and empty.
- **No networking.** Nothing in the folder can reach the network, by rule.
- **No programs written in Crimson Noir Script.** The `noir` command runs the console's second language as before,
  one line at a time, at the prompt or from a shell script; there is no program for it in `/bin`, so a file of it
  cannot be run as a program.
- **A secret the shell builds from parts is in no typed line.** `"ask" key sk-$(cat part)` or `"${P}..."` hands the
  command a key that appears in no history entry as such, so the entry stays as typed (the expression, not the key),
  as the scrollback above already shows it.
- **A change in the last moment before a reload can be lost.** The save made as the page starts to go is committed at
  once, but a large disk's write may not finish before the page is gone: on a disk with more than 1 MiB in use, a change
  is sure to be kept across a reload only once its timed save has landed (1.5 s for each MiB, 10 s at most).
- **Saving or restoring a full disk holds the page.** A disk near its 8 MiB costs a frame or two on a laptop to save,
  and about as much at boot to check and restore, more on a slow machine: the walk, the browser's digest and the store
  each copy it on the page's thread. Making and storing the image in slices across turns would end it.
- **`jobs` and `ps -f` show a job's line as typed.** A key or a token on a line sent to the background
  (`net join <url> <token> &`) is dotted in the history, but `jobs` and `ps -f` list the line as it was typed, as the
  scrollback above it already shows it. A secret on a line that never ran its command (`false && "ask" key ...`, a
  line with a syntax error) is dotted only in the plain forms above, since no command took it.
- **The gaps above:** each program's page admits its own, and the shell has no functions, `case`, subshells, `set`,
  arrays, backquotes, aliases or pausing a job.
