// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the system that puts the console's operating layer together (system.ts): the
 * tree task 1 lays out and the files a new disk is given, the file systems it mounts, the shell it keeps at the
 * terminal (started again when it ends, even when no task can be made for a moment), and each state of the saved
 * disk: waiting for the host, new, restored, refused and set aside. It checks what the host relies on (the image with
 * or without its seal, marked saved only once it is made, dirty, pristine, the bytes in use, the prompt, Tab's lists)
 * and that no saved disk, however it was left, keeps the shell from coming back or is set aside for less than a
 * failed check: a file where a directory belongs or where a file system is mounted, a full disk, an image built to do
 * harm.
 * What breaks if it is removed? A disk a person left in an odd state could leave the console with no shell on every
 * visit after, or a new disk could be taken for a saved one and overwrite it, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { concat, encode } from './bytes.ts'
import { OsError } from './errno.ts'
import { FILE_PROGRAMS } from './fileutils.ts'
import { ROOT_CRED } from './fs.ts'
import { SEAL_BYTES, dump, restore, sealed } from './image.ts'
import { PROCS_MAX } from './kernel.ts'
import type { Program } from './kernel.ts'
import { boot } from './kit.test.ts'
import type { Kit } from './kit.test.ts'
import { MemFs } from './memfs.ts'
import { sha256 } from './sha.ts'
import { dir, knob, text } from './synth.ts'
import { DISK_BYTES, DISK_NODES, HOME, PATH, TMP_BYTES } from './system.ts'
import { Later, now } from './task.ts'
import { O_READ } from './vfs.ts'

/** The names of the tasks that are running. */
const tasks = (k: Kit): string[] => k.system.kernel.ps().map((p) => p.name)

/** The number of the shell at the terminal. */
function shellPid(k: Kit): number {
  const sh = k.system.kernel.ps().find((p) => p.name === '-sh')
  assert.ok(sh !== undefined, 'a shell runs')
  return sh.pid
}

/** Whether the kernel's log has a line that holds `text`. */
const logged = (k: Kit, text: string): boolean => k.system.kernel.dmesg().some((l) => l.includes(text))

/** A disk in memory, as the host's own would be, to read an image back into. */
const blank = (): MemFs => new MemFs({ capacity: DISK_BYTES, maxFile: DISK_BYTES, maxNodes: 65536, clock: () => 0 })

/** Fails unless the shell answers at the prompt. */
function answers(k: Kit): void {
  assert.equal(k.system.atPrompt, true, 'at the prompt')
  assert.deepEqual(k.sh('echo here'), ['here'])
}

test('system: a new disk is laid out and given its first files, and the shell waits at its prompt in the home directory', () => {
  const k = boot(FILE_PROGRAMS, { manual: { ls: 'a page', cat: 'another\n' } })
  const s = k.system
  assert.equal(s.state, 'new')
  assert.equal(s.refused, null)
  const tree = ['/bin', '/dev', '/etc', '/home', HOME, '/mnt', '/proc', '/sys', '/tmp', '/usr', '/usr/share/man', '/usr/apps']
  for (const path of tree) assert.ok(k.exists(path), path)
  assert.equal(k.read('/etc/hostname'), 'crimson-noir\n')
  assert.equal(k.read('/etc/passwd'), `root:x:0:0:operator:${HOME}:/bin/sh\n`)
  assert.ok(k.read(`${HOME}/README`).startsWith('This is your home directory.'))
  assert.equal(k.read('/usr/share/man/ls'), 'a page\n')
  assert.equal(k.read('/usr/share/man/cat'), 'another\n')
  assert.equal(k.read('/sys/kernel/hostname'), 'crimson-noir\n')
  assert.equal(k.read('/sys/kernel/version'), 'Crimson Noir OS test\n')
  // Each program is a file in /bin naming the body the kernel runs; the shell is one of them; /bin and /usr cannot be written.
  for (const name of [...Object.keys(FILE_PROGRAMS), 'sh']) assert.equal(k.read(`/bin/${name}`), `#!native ${name}\n`, name)
  const vfs = s.kernel.vfs
  assert.equal(now(vfs.stat('/bin/ls', '/', ROOT_CRED)).mode, 0o755)
  for (const path of ['/bin/new', '/bin/ls', '/usr/share/man/new']) {
    assert.throws(() => k.write(path, 'x'), (e: unknown) => e instanceof OsError && e.errno === 'EROFS', path)
  }
  assert.equal(now(vfs.stat('/tmp', '/', ROOT_CRED)).mode, 0o1777)
  const mounts = vfs.mounts().map((m) => `${m.path} ${m.driver.type} ${m.source}`)
  assert.deepEqual(mounts, ['/ diskfs disk', '/bin romfs rom', '/usr romfs rom', '/tmp tmpfs tmpfs', '/dev devfs devfs', '/proc proc proc', '/sys sysfs sysfs'])
  assert.deepEqual([s.disk.usage().capacity, vfs.usage(vfs.mounts()[3]).capacity], [DISK_BYTES, TMP_BYTES])
  // The shell: at its prompt, in the home directory, with the environment every script expects.
  assert.equal(s.atPrompt, true)
  assert.equal(s.capturing, false)
  assert.equal(s.prompt, 'crimson-noir:~# ')
  assert.equal(s.cwd, HOME)
  assert.deepEqual(k.sh('echo $HOME $USER $LOGNAME $SHELL $TERM $HOSTNAME; echo $PATH'), [`${HOME} root root /bin/sh console crimson-noir`, PATH])
  assert.deepEqual(tasks(k), ['init', '-sh'])
  assert.equal(s.idle, true)
})

test('system: a new disk is pristine and dirty until its first image; then only a change makes it dirty, and any change of the person\'s ends pristine', () => {
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  assert.equal(s.pristine, true)
  assert.equal(s.dirty, true)
  const first = s.snapshot()
  assert.ok(first !== null)
  assert.equal(s.snapshot(), null)
  assert.equal(s.dirty, false)
  assert.equal(s.pristine, true)
  // The image holds exactly the new disk.
  const back = blank()
  restore(first, back)
  assert.deepEqual(back.list(back.root).map((e) => e.name).sort(), ['bin', 'dev', 'etc', 'home', 'mnt', 'proc', 'sys', 'tmp', 'usr'])
  // Reading, and writing to /tmp, change nothing that is saved.
  k.sh('cat ~/README > /dev/null; echo scratch > /tmp/x; ls /proc > /dev/null')
  assert.equal(s.dirty, false)
  assert.equal(s.pristine, true)
  k.sh('echo mine > ~/notes')
  assert.equal(s.dirty, true)
  assert.equal(s.pristine, false)
  const second = s.snapshot()
  assert.ok(second !== null)
  assert.equal(s.dirty, false)
  // Taking the person's file away again does not make the disk new again.
  k.sh('rm ~/notes')
  assert.equal(s.pristine, false)
  assert.equal(s.dirty, true)
  // An image given null starts a new disk too.
  assert.equal(boot({}, { image: null }).system.state, 'new')
})

test('system: the image can be had without its seal, for a host that seals it with its own digest; either way the disk counts as saved only once the image is made', () => {
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  const body = s.snapshotBody()
  assert.ok(body !== null)
  assert.equal(s.dirty, false)
  assert.equal(s.snapshotBody(), null)
  assert.equal(s.snapshot(), null)
  const back = blank()
  restore(sealed(body, sha256(body)), back)
  assert.deepEqual(back.list(back.root).map((e) => e.name).sort(), ['bin', 'dev', 'etc', 'home', 'mnt', 'proc', 'sys', 'tmp', 'usr'])
  // The same disk gives the same bytes either way.
  k.sh('echo mine > ~/notes')
  const whole = dump(s.disk)
  assert.deepEqual(s.snapshotBody(), whole.subarray(0, whole.length - SEAL_BYTES))
  // An image that cannot be made (the browser refuses the memory for it) leaves the change owed, so it is tried again.
  for (const make of [() => s.snapshotBody(), () => s.snapshot()]) {
    k.sh('echo more >> ~/notes')
    const read = s.disk.read
    const bytesOf = s.disk.bytesOf
    s.disk.read = () => { throw new RangeError('Array buffer allocation failed') }
    s.disk.bytesOf = () => { throw new RangeError('Array buffer allocation failed') }
    try {
      assert.throws(make, RangeError)
    } finally {
      s.disk.read = read
      s.disk.bytesOf = bytesOf
    }
    assert.equal(s.dirty, true)
    const image = make()
    assert.ok(image !== null)
    assert.equal(s.dirty, false)
  }
})

test('system: the bytes in use on the disk are the ones df counts, and only the disk\'s', () => {
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  const used = (): number => Number(k.sh('df /')[1].split(/ +/)[3])
  assert.equal(s.diskUsed, s.disk.usage().used)
  assert.equal(used(), Math.ceil(s.diskUsed / 1024))
  const before = s.diskUsed
  k.write(`${HOME}/big`, new Uint8Array(100000))
  // The file's bytes, and what a node and its name cost.
  assert.equal(s.diskUsed, before + 100000 + 64 + 'big'.length)
  assert.equal(used(), Math.ceil(s.diskUsed / 1024))
  k.write('/tmp/scratch', new Uint8Array(50000))
  assert.equal(s.diskUsed, before + 100000 + 64 + 'big'.length)
})

test('system: the disk holds at most DISK_NODES files and directories, so a save and the next visit\'s restore stay short', () => {
  assert.equal(DISK_NODES, 4096)
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  // As many empty files as one line could make: the disk refuses the one past its count, and /tmp has its own.
  k.sh('mkdir ~/many')
  let made = 0
  let refused = ''
  for (let i = 0; i < DISK_NODES; i++) {
    try {
      k.write(`${HOME}/many/f${i}`, '')
      made++
    } catch (e) {
      refused = String(e)
      break
    }
  }
  assert.ok(made > DISK_NODES - 64 && made < DISK_NODES, `${made} files made`)
  assert.match(refused, /no room for another file/)
  assert.deepEqual(k.sh('touch /tmp/more; echo $?'), ['0'])
  // A full disk still makes its image and comes back whole.
  const image = s.snapshot()
  assert.ok(image !== null)
  const back = new MemFs({ capacity: DISK_BYTES, maxFile: DISK_BYTES, maxNodes: DISK_NODES, clock: () => 0 })
  restore(image, back)
  assert.equal(back.usage().nodes, s.disk.usage().nodes)
})

test('system: before the host says whether there is a saved disk, nothing is laid out, nothing is saved, and typed lines wait', () => {
  const image = new Later<Uint8Array | null>()
  const k = boot(FILE_PROGRAMS, { image })
  const s = k.system
  assert.equal(s.state, 'waiting')
  assert.deepEqual(tasks(k), ['init'])
  assert.deepEqual(s.disk.list(s.disk.root), [])
  assert.equal(s.snapshot(), null)
  assert.equal(s.dirty, false)
  assert.equal(s.pristine, false)
  assert.equal(s.atPrompt, false)
  assert.equal(s.capturing, false)
  assert.equal(s.prompt, '')
  assert.equal(s.cwd, HOME)
  assert.equal(s.idle, true)
  assert.deepEqual(s.commands(), [])
  // What is typed meanwhile is run once the shell is there; too many lines waiting are turned away.
  assert.equal(s.type('echo early'), true)
  assert.deepEqual(k.settle(), [])
  assert.equal(s.type(Array.from({ length: 300 }, (_, i) => `echo ${i}`).join('\n')), false)
  image.resolve(null)
  assert.deepEqual(k.settle(), ['early'])
  assert.equal(s.state, 'new')
  assert.equal(s.pristine, true)
  answers(k)
})

test('system: a saved disk the host could not read starts a new disk, and the log says why', () => {
  const image = new Later<Uint8Array | null>()
  const k = boot({}, { image })
  image.reject(new OsError('EIO', 'the store is locked'))
  k.settle()
  assert.equal(k.system.state, 'new')
  assert.ok(logged(k, 'the saved disk could not be read: the store is locked'))
  answers(k)
})

test('system: a saved disk comes back as it was saved, given nothing new, and needs no saving until it changes', () => {
  const one = boot(FILE_PROGRAMS)
  assert.deepEqual(one.sh('echo kept > ~/notes; mkdir ~/bin; echo echo from my script > ~/bin/mine; chmod 755 ~/bin/mine'), [])
  assert.deepEqual(one.sh('rm ~/README; rmdir /mnt; chmod 700 ~'), [])
  const image = one.system.snapshot()
  assert.ok(image !== null)
  // A host that hands the image over later, under another name.
  const later = new Later<Uint8Array | null>()
  const k = boot(FILE_PROGRAMS, { image: later, hostname: 'elsewhere' })
  assert.equal(k.system.state, 'waiting')
  later.resolve(image)
  k.settle()
  const s = k.system
  assert.equal(s.state, 'restored')
  assert.equal(s.refused, null)
  assert.equal(k.read(`${HOME}/notes`), 'kept\n')
  assert.equal(k.exists(`${HOME}/README`), false)
  assert.equal(k.read('/etc/hostname'), 'crimson-noir\n')
  assert.equal(now(s.kernel.vfs.stat(HOME, '/', ROOT_CRED)).mode, 0o700)
  // What the system lays out is there again, mounted as before.
  assert.ok(k.exists('/mnt'))
  assert.equal(s.kernel.vfs.mounts().length, 7)
  assert.deepEqual(k.sh('mine'), ['from my script'])
  assert.ok(s.commands().includes('mine'))
  assert.equal(s.dirty, false)
  assert.equal(s.pristine, false)
  assert.equal(s.snapshot(), null)
  k.sh('echo more >> ~/notes')
  assert.equal(s.dirty, true)
  assert.equal(s.pristine, false)
  assert.ok(s.snapshot() !== null)
})

test('system: a saved disk that fails its checks is set aside whole, and a new disk takes its place', () => {
  const one = boot(FILE_PROGRAMS)
  one.sh('echo kept > ~/notes')
  const good = one.system.snapshot()
  assert.ok(good !== null)
  const corrupt = good.slice()
  corrupt[corrupt.length >> 1] ^= 1
  const k = boot(FILE_PROGRAMS, { image: corrupt })
  const s = k.system
  assert.equal(s.state, 'refused')
  assert.equal(s.refused, corrupt)
  assert.ok(logged(k, 'the saved disk was set aside: not a disk image (the seal does not match)'))
  assert.equal(k.exists(`${HOME}/notes`), false)
  assert.ok(k.read(`${HOME}/README`).startsWith('This is your home directory.'))
  assert.equal(s.pristine, true)
  assert.equal(s.dirty, true)
  // The image the host is then handed is the new disk, not the one set aside.
  const fresh = s.snapshot()
  assert.ok(fresh !== null)
  const back = blank()
  restore(fresh, back)
  assert.ok(!back.list(back.lookup(back.lookup(back.root, 'home'), 'operator')).some((e) => e.name === 'notes'))
  answers(k)
  // Not an image at all, and an image too large for this disk.
  assert.equal(boot({}, { image: encode('just some text') }).system.state, 'refused')
  const small = boot(FILE_PROGRAMS, { image: good, diskBytes: 1024 })
  assert.equal(small.system.state, 'refused')
  assert.ok(logged(small, 'the saved disk was set aside: not a disk image (no space left on device)'))
  // So small a disk cannot even take what a new one is given: the log says so, and the shell still starts.
  assert.ok(logged(small, `${HOME}/README could not be written: no space left on device`))
  answers(small)
})

test('system: an image built so that its root has other bits and owner, then refused at its last byte, leaves the new root as a new one', () => {
  const fs = blank()
  fs.setattr(fs.root, { mode: 0, uid: 4242, gid: 4242 })
  fs.create(fs.root, 'f', 'file', 0o644, ROOT_CRED)
  const image = dump(fs)
  const b = concat([image.subarray(0, image.length - 32), Uint8Array.of(0)])
  const k = boot({}, { image: concat([b, sha256(b)]) })
  assert.equal(k.system.state, 'refused')
  assert.ok(logged(k, 'bytes left over'))
  const st = now(k.system.kernel.vfs.stat('/', '/', ROOT_CRED))
  assert.deepEqual([st.mode, st.uid, st.gid], [0o755, 0, 0])
})

test('system: a home that became a file at the prompt does not keep the shell from coming back on the next visit', () => {
  const one = boot(FILE_PROGRAMS)
  assert.deepEqual(one.sh('cd /; rm -r /home; echo x > /home; echo $?'), ['0'])
  const image = one.system.snapshot()
  assert.ok(image !== null)
  const k = boot(FILE_PROGRAMS, { image })
  assert.equal(k.system.state, 'restored')
  assert.ok(logged(k, `${HOME} could not be made: not a directory`))
  assert.deepEqual(tasks(k), ['init', '-sh'])
  answers(k)
  // The person can put it right from there.
  assert.deepEqual(k.sh(`cd /; rm /home; mkdir -p ${HOME}; cd; pwd`), [HOME])
})

test('system: a file where a file system is mounted (an image built so, or saved before umount kept them) is moved aside under a free name, and the rest of the disk comes back', () => {
  for (const name of ['bin', 'usr', 'tmp', 'dev', 'proc', 'sys']) {
    const fs = blank()
    const f = fs.create(fs.root, name, 'file', 0o644, ROOT_CRED)
    fs.write(f, 0, encode(`was ${name}\n`))
    // The first free name is taken by a file of the person's own, which stays as it is.
    const taken = fs.create(fs.root, `${name}.file`, 'file', 0o644, ROOT_CRED)
    fs.write(taken, 0, encode('mine\n'))
    const home = fs.create(fs.create(fs.root, 'home', 'dir', 0o755, ROOT_CRED), 'operator', 'dir', 0o755, ROOT_CRED)
    fs.write(fs.create(home, 'novel.txt', 'file', 0o644, ROOT_CRED), 0, encode('CHAPTER-ONE\n'))
    const k = boot(FILE_PROGRAMS, { image: dump(fs) })
    const s = k.system
    assert.equal(s.state, 'restored', name)
    assert.equal(s.refused, null, name)
    assert.ok(logged(k, `/${name} on the saved disk was not a directory: it is kept as /${name}.file.1`), name)
    assert.equal(k.read(`/${name}.file.1`), `was ${name}\n`, name)
    assert.equal(k.read(`/${name}.file`), 'mine\n', name)
    assert.equal(k.read(`${HOME}/novel.txt`), 'CHAPTER-ONE\n', name)
    assert.ok(s.kernel.vfs.mounts().some((m) => m.path === `/${name}`), `/${name} is mounted`)
    assert.deepEqual(tasks(k), ['init', '-sh'])
    answers(k)
    // The disk as it now stands is saved, and comes back with nothing more to move.
    assert.equal(s.dirty, true, name)
    const image = s.snapshot()
    assert.ok(image !== null)
    const again = boot(FILE_PROGRAMS, { image })
    assert.equal(again.system.state, 'restored', name)
    assert.ok(!logged(again, 'on the saved disk was not a directory'), name)
    assert.equal(again.read(`/${name}.file.1`), `was ${name}\n`, name)
    assert.equal(again.system.dirty, false, name)
  }
  // With no room on the disk for the longer name, the file stays where it is and the log says so; the mount there
  // fails and is said too, and the disk is still restored, the file whole and the shell at its prompt.
  const full = blank()
  for (const name of ['bin', 'dev', 'etc', 'home', 'mnt', 'proc', 'sys', 'usr']) {
    full.create(full.root, name, 'dir', 0o755, ROOT_CRED)
  }
  full.create(full.lookup(full.root, 'home'), 'operator', 'dir', 0o755, ROOT_CRED)
  const tmp = full.create(full.root, 'tmp', 'file', 0o644, ROOT_CRED)
  const usage = full.usage()
  full.write(tmp, 0, new Uint8Array(usage.capacity - usage.used))
  const k = boot(FILE_PROGRAMS, { image: dump(full) })
  assert.equal(k.system.state, 'restored')
  assert.ok(logged(k, '/tmp on the saved disk is not a directory and could not be moved aside: no space left on device'))
  assert.ok(logged(k, '/tmp could not be mounted: not a directory'))
  assert.equal(k.bytes('/tmp').length, usage.capacity - usage.used)
  answers(k)
  // A file where a plain directory of the tree belongs is the person's own business: the disk is kept as it is.
  const fs = blank()
  fs.create(fs.root, 'mnt', 'file', 0o644, ROOT_CRED)
  const kept = boot(FILE_PROGRAMS, { image: dump(fs) })
  assert.equal(kept.system.state, 'restored')
  assert.ok(!kept.exists('/mnt.file'))
  answers(kept)
})

test('system: a saved disk that came back full, missing a directory of the tree, still gives a shell, and the log says what is missing', () => {
  const one = boot(FILE_PROGRAMS, { diskBytes: 64 << 10 })
  assert.deepEqual(one.sh('rmdir /mnt; echo $?'), ['0'])
  const usage = one.system.disk.usage()
  one.write(`${HOME}/big`, new Uint8Array(usage.capacity - usage.used - 64 - 3))
  assert.equal(one.system.disk.usage().used, usage.capacity)
  const image = one.system.snapshot()
  assert.ok(image !== null)
  const k = boot(FILE_PROGRAMS, { image, diskBytes: 64 << 10 })
  assert.equal(k.system.state, 'restored')
  assert.ok(logged(k, '/mnt could not be made: no space left on device'))
  assert.equal(k.exists('/mnt'), false)
  answers(k)
  assert.deepEqual(k.sh('rm ~/big; mkdir /mnt; echo $?'), ['0'])
})

test('system: the shell at the terminal is started again when it ends, after a pause, every time', () => {
  const k = boot({})
  const s = k.system
  for (let round = 0; round < 3; round++) {
    const pid = shellPid(k)
    s.kernel.stop(pid)
    assert.deepEqual(k.settle(), [])
    assert.ok(logged(k, "the console's shell ended with status 143: starting another"))
    // No shell for a moment: nothing at the prompt, and the host is told when to look again.
    assert.deepEqual(tasks(k), ['init'])
    assert.equal(s.atPrompt, false)
    assert.equal(s.prompt, '')
    assert.equal(typeof s.nextWake, 'number')
    k.tick(249)
    k.settle()
    assert.deepEqual(tasks(k), ['init'])
    k.tick(1)
    k.settle()
    assert.notEqual(shellPid(k), pid)
    answers(k)
  }
  // Ctrl+D at the prompt is no way out of the console's shell; Ctrl+C there ends nothing.
  const pid = shellPid(k)
  s.end()
  k.settle()
  assert.equal(shellPid(k), pid)
  assert.equal(s.interrupt(), false)
  k.settle()
  answers(k)
})

test('system: a shell that cannot be started for a moment (no room for another task) is tried again, and task 1 lives on', () => {
  const k = boot({})
  const s = k.system
  const kernel = s.kernel
  const init = kernel.proc(1)
  assert.ok(init !== undefined)
  const forever: Program = function* (sys) {
    yield* sys.sleep(1e12)
    return 0
  }
  s.kernel.stop(shellPid(k))
  k.settle()
  // Every place in the table taken while init waits to start the next shell.
  const fillers: number[] = []
  while (kernel.ps().length < PROCS_MAX) fillers.push(now(kernel.spawn(init, ['filler'], { program: forever })).pid)
  k.tick(250)
  k.settle()
  assert.ok(logged(k, "the console's shell could not be started: too many tasks: trying again"))
  assert.equal(kernel.proc(1)?.state === 'ended', false)
  assert.ok(!tasks(k).includes('-sh'))
  // Room again: the next try brings the shell back.
  for (const pid of fillers.slice(0, 3)) kernel.stop(pid)
  k.settle()
  k.tick(250)
  k.settle()
  assert.ok(tasks(k).includes('-sh'))
  answers(k)
})

test('system: what the console shows and how it takes a typed line, while a job reads the terminal and while a command is unfinished', () => {
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  assert.deepEqual(k.sh('cat'), [])
  assert.deepEqual([s.atPrompt, s.capturing, s.prompt], [false, true, ''])
  assert.deepEqual(k.sh('echo this is input, not a command'), ['echo this is input, not a command'])
  s.end()
  k.settle()
  assert.deepEqual([s.atPrompt, s.capturing, s.prompt], [true, false, 'crimson-noir:~# '])
  assert.deepEqual(k.sh('if true; then'), [])
  assert.deepEqual([s.atPrompt, s.capturing, s.prompt], [false, true, '> '])
  assert.deepEqual(k.sh('echo inside; fi'), ['inside'])
  assert.equal(s.atPrompt, true)
  // A job that runs and does not read: nothing is shown before the next line, and Ctrl+C ends it.
  s.type('cat /dev/zero > /dev/null')
  s.run(100, Number.POSITIVE_INFINITY)
  assert.deepEqual([s.atPrompt, s.capturing, s.prompt, s.idle], [false, false, '', false])
  assert.equal(s.interrupt(), true)
  k.settle()
  answers(k)
  k.sh('cd /usr/share; PS1="\\w> "')
  assert.equal(s.cwd, '/usr/share')
  assert.equal(s.prompt, '/usr/share> ')
})

test('system: Tab\'s list of commands is every file along the shell\'s path that may be run, sorted, each once', () => {
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  const builtin = [...Object.keys(FILE_PROGRAMS), 'sh'].sort()
  assert.deepEqual(s.commands(), builtin)
  assert.deepEqual(k.sh('mkdir ~/bin; echo echo mine > ~/bin/mine; chmod 755 ~/bin/mine; echo not run > ~/bin/plain'), [])
  assert.deepEqual(k.sh('mkdir ~/bin/sub; echo echo > ~/bin/cat; chmod 755 ~/bin/cat'), [])
  assert.deepEqual(s.commands(), [...builtin, 'mine'].sort())
  // The shell's own path, as it stands: an empty entry is the directory it works in, and one that is not there offers nothing.
  k.sh('PATH=/nowhere::; cd /bin')
  assert.deepEqual(s.commands(), builtin)
  k.sh(`PATH=${HOME}/bin`)
  assert.deepEqual(s.commands(), ['cat', 'mine'])
  k.sh('PATH=/nowhere')
  assert.deepEqual(s.commands(), [])
})

test('system: Tab\'s list of commands for a word holds only the names that start with it, and checks no other name', () => {
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  assert.deepEqual(k.sh('mkdir ~/bin; cd ~/bin; for i in 1 2 3 4 5 6 7 8 9 10 11 12; do echo echo t$i > t$i; done; chmod 755 t1 t10 t2; cd'), [])
  assert.deepEqual(s.commands('t1'), ['t1', 't10'])
  assert.deepEqual(s.commands('t'), ['t1', 't10', 't2', 'touch', 'tree'])
  assert.deepEqual(s.commands('c'), ['cat', 'chmod', 'cp'])
  assert.deepEqual(s.commands('zz'), [])
  assert.deepEqual(s.commands(''), s.commands())
  // The check of each file is what costs over a large directory: a name that cannot complete the word is never checked.
  const vfs = s.kernel.vfs
  const access = vfs.access
  let checked = 0
  vfs.access = function (...args) {
    checked++
    return access.apply(vfs, args)
  }
  try {
    assert.deepEqual(s.commands('zz'), [])
    assert.equal(checked, 0)
    assert.deepEqual(s.commands('t1'), ['t1', 't10'])
    // t1, t10, t11 and t12 in ~/bin (the last two may not be run), and nothing along the rest of the path starts so.
    assert.equal(checked, 4)
  } finally {
    vfs.access = access
  }
})

test('system: Tab completes a path as typed, ~ for home, a directory ending in a slash, names with a dot only when asked for', () => {
  const k = boot(FILE_PROGRAMS)
  const s = k.system
  k.write(`${HOME}/.hidden`, '')
  k.write(`${HOME}/notes`, '')
  k.sh('mkdir ~/sub; touch ~/sub/a ~/sub/b')
  assert.deepEqual(s.complete('~/RE'), ['~/README'])
  assert.deepEqual(s.complete('~/'), ['~/README', '~/notes', '~/sub/'])
  assert.deepEqual(s.complete('~/.'), ['~/.hidden'])
  assert.deepEqual(s.complete(''), ['README', 'notes', 'sub/'])
  assert.deepEqual(s.complete('.'), ['.hidden'])
  assert.deepEqual(s.complete('sub/'), ['sub/a', 'sub/b'])
  assert.deepEqual(s.complete('/b'), ['/bin/'])
  assert.deepEqual(s.complete('/bin/ca'), ['/bin/cat'])
  assert.deepEqual(s.complete(`${HOME}/no`), [`${HOME}/notes`])
  assert.deepEqual(s.complete('/nosuch/x'), [])
  assert.deepEqual(s.complete('~/notes/x'), [])
  assert.deepEqual(s.complete('zzz'), [])
  k.sh('cd sub')
  assert.deepEqual(s.complete(''), ['a', 'b'])
  assert.deepEqual(s.complete('../n'), ['../notes'])
})

test('system: the host\'s readings and knobs, and its source of random bytes, are where a program looks for them', () => {
  let time = '18:00'
  const k = boot({}, {
    proc: { city: dir({ stats: text(() => 'fps 60\n') }) },
    sys: { city: dir({ time: knob(() => `${time}\n`, (value) => { time = value }) }) },
    entropy: (bytes) => bytes.fill(7),
  })
  assert.equal(k.read('/proc/city/stats'), 'fps 60\n')
  assert.deepEqual(k.sh('echo 21:15 > /sys/city/time; echo $?'), ['0'])
  assert.equal(time, '21:15')
  assert.equal(k.read('/sys/kernel/hostname'), 'crimson-noir\n')
  const r = now(k.system.kernel.vfs.open('/dev/urandom', '/', ROOT_CRED, O_READ))
  assert.deepEqual(now(r.read(3)), Uint8Array.of(7, 7, 7))
  r.close()
  const none = boot({})
  const z = now(none.system.kernel.vfs.open('/dev/random', '/', ROOT_CRED, O_READ))
  assert.throws(() => now(z.read(3)), (e: unknown) => e instanceof OsError && e.errno === 'EIO')
  z.close()
  assert.ok(none.read('/proc/version').includes('Crimson Noir OS test'))
})
