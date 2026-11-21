// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the file system to its promises: vfs.ts (the walk with its permission checks
 * for user 0 and everyone else, mount points that cannot be moved or removed, open flags, descriptors and their
 * count, the sticky bit, moves within one mount and never past the depth or length limits, a name that ends in a
 * slash, or `.` and `..`, naming a directory or nothing), memfs.ts (every byte, node and name charged and given back,
 * growth refused without changing anything and out of space before too large, a change counter that moves only on a
 * change, names its own image can keep, link counts kept rather than counted on every stat), synth.ts (a generated
 * file read whole once so small reads see one text, a reading that answers later, a knob that takes or refuses a
 * value, numbers of paths that lead nowhere forgotten), procfs.ts
 * (a directory per task, `self`, the kernel's readings, each name found one way only) and devices.ts (null, zero,
 * full, random with and without a source, the terminal). Most tests call the file system directly with a Cred,
 * since the kernel starts every task as user 0; a few type at the prompt where that is the promise.
 * What breaks if it is removed? `rm notes/` could remove a file again, a move could leave a tree nothing can reach
 * or remove, a full disk could be reported as a file that is too large, a refused write could still change the disk,
 * a user could read through a directory it may not search, and a saved disk could come back refused.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decode, encode } from './bytes.ts'
import { OsError, refuse } from './errno.ts'
import { ROOT_CRED, R, W, X } from './fs.ts'
import type { Cred, Driver, Entry, Stat, Usage } from './fs.ts'
import { FILE_PROGRAMS } from './fileutils.ts'
import { dump, restore } from './image.ts'
import { boot } from './kit.test.ts'
import { MemFs, NODE_COST } from './memfs.ts'
import type { MemFsOptions } from './memfs.ts'
import { DEPTH_MAX, NAME_MAX, PATH_MAX } from './path.ts'
import { GENERATED_MAX, SynthFs, dir, knob, text } from './synth.ts'
import type { SynthDir, SynthFile, SynthStream } from './synth.ts'
import { Later, now } from './task.ts'
import type { Task } from './task.ts'
import { MOUNTS_MAX, O_APPEND, O_CREATE, O_EXCL, O_READ, O_TRUNC, O_WRITE, READ_FILE_MAX, STICKY, Vfs } from './vfs.ts'
import type { Mount } from './vfs.ts'

/** The errno a call refuses with, or null when it does not refuse. */
function errnoOf(run: () => unknown): string | null {
  try {
    run()
    return null
  } catch (e) {
    if (e instanceof OsError) return e.errno
    throw e
  }
}

/** The errno a task refuses with when run where nothing may wait, or null when it does not refuse. */
function refusal(task: Task<unknown>): string | null {
  return errnoOf(() => now(task))
}

/** The words a call refuses with. */
function messageOf(run: () => unknown): string {
  try {
    run()
  } catch (e) {
    if (e instanceof OsError) return e.message
    throw e
  }
  return assert.fail('the call was not refused')
}

/** The words a task refuses with when run where nothing may wait. */
function reasonOf(task: Task<unknown>): string {
  return messageOf(() => now(task))
}

/** Someone who is not user 0, another in the same group, and a stranger. */
const USER: Cred = Object.freeze({ uid: 1000, gid: 1000 })
const PEER: Cred = Object.freeze({ uid: 1002, gid: 1000 })
const OTHER: Cred = Object.freeze({ uid: 1001, gid: 1001 })

/** A file system of its own: one memory driver at /, no kernel, a clock that stands at 0. */
function bare(opts: Partial<MemFsOptions> = {}): { fs: MemFs; vfs: Vfs } {
  const fs = new MemFs({ capacity: 1 << 20, maxFile: 1 << 20, maxNodes: 1000, clock: () => 0, ...opts })
  return { fs, vfs: new Vfs(fs, 'disk') }
}

function put(vfs: Vfs, path: string, data: string, cred: Cred = ROOT_CRED, mode?: number): void {
  now(vfs.writeFile(path, '/', cred, encode(data), mode === undefined ? {} : { mode }))
}

function get(vfs: Vfs, path: string, cred: Cred = ROOT_CRED): string {
  return decode(now(vfs.readFile(path, '/', cred)))
}

function names(vfs: Vfs, path: string, cred: Cred = ROOT_CRED): string[] {
  return now(vfs.list(path, '/', cred)).map((e) => e.name)
}

function mountAt(vfs: Vfs, path: string): Mount {
  return vfs.mounts().find((m) => m.path === path) ?? assert.fail(`nothing is mounted at ${path}`)
}

/** More than the scratch space of a kit that is given its default: a write that can never fit. */
const TMP_ROOM = (4 << 20) + 1

/** A read-only driver with one file of a given size, read as zeros, and one stream that never ends. */
class Sized implements Driver {
  readonly type = 'test'
  readonly readOnly = true
  readonly generated = false
  readonly root = 1
  private readonly size: number
  private readonly zeros = new Uint8Array(65536)
  constructor(size: number) {
    this.size = size
  }
  lookup(at: number, name: string): number {
    if (at !== 1) refuse('ENOTDIR')
    return name === 'file' ? 2 : name === 'endless' ? 3 : refuse('ENOENT')
  }
  stat(ino: number): Stat {
    const kind = ino === 1 ? 'dir' : ino === 2 ? 'file' : 'stream'
    return { kind, ino, mode: 0o444, uid: 0, gid: 0, size: ino === 2 ? this.size : 0, mtime: 0, nlink: 1 }
  }
  list(): Entry[] { return [{ name: 'file', kind: 'file', ino: 2 }, { name: 'endless', kind: 'stream', ino: 3 }] }
  read(ino: number, offset: number, length: number): Uint8Array {
    const n = ino === 3 ? length : Math.max(0, Math.min(length, this.size - offset))
    return this.zeros.subarray(0, Math.min(n, this.zeros.length))
  }
  write(): number { return refuse('EROFS') }
  truncate(): void { refuse('EROFS') }
  create(): number { return refuse('EROFS') }
  remove(): void { refuse('EROFS') }
  rename(): void { refuse('EROFS') }
  setattr(): void { refuse('EROFS') }
  usage(): Usage { return { capacity: 0, used: 0, nodes: 3 } }
}

test('a name that ends in a slash names a directory, or nothing', () => {
  const k = boot({})
  const vfs = k.system.kernel.vfs
  k.write('/tmp/f', 'kept')
  now(vfs.mkdir('/tmp/d', '/', ROOT_CRED))
  for (const path of ['/tmp/f/', '/tmp/f/.', '/tmp/f//']) {
    assert.equal(errnoOf(() => now(vfs.stat(path, '/', ROOT_CRED))), 'ENOTDIR', path)
    assert.equal(errnoOf(() => now(vfs.open(path, '/', ROOT_CRED, O_READ))), 'ENOTDIR', path)
    assert.equal(errnoOf(() => now(vfs.unlink(path, '/', ROOT_CRED))), 'ENOTDIR', path)
    assert.equal(errnoOf(() => now(vfs.rename(path, '/tmp/g', '/', ROOT_CRED))), 'ENOTDIR', path)
  }
  // A file cannot take a directory's name either, and open never makes one.
  assert.equal(errnoOf(() => now(vfs.rename('/tmp/f', '/tmp/g/', '/', ROOT_CRED))), 'ENOTDIR')
  assert.equal(errnoOf(() => now(vfs.open('/tmp/new/', '/', ROOT_CRED, O_WRITE | O_CREATE))), 'EISDIR')
  assert.equal(k.exists('/tmp/new'), false)
  assert.equal(k.read('/tmp/f'), 'kept')
  // A directory is found by any of the forms, and moved by them.
  for (const path of ['/tmp/d/', '/tmp/d/.', '/tmp/d//', '/tmp/d/../d/']) assert.equal(now(vfs.stat(path, '/', ROOT_CRED)).kind, 'dir', path)
  now(vfs.rename('/tmp/d/', '/tmp/e/', '/', ROOT_CRED))
  assert.equal(k.exists('/tmp/e'), true)
  // The root stays the root.
  assert.equal(now(vfs.stat('/', '/', ROOT_CRED)).kind, 'dir')
  assert.equal(now(vfs.stat('/..', '/', ROOT_CRED)).kind, 'dir')
})

test('the programs see the same: cat, touch, mv and rm refuse a file named as a directory', () => {
  const k = boot(FILE_PROGRAMS)
  k.write('/tmp/f', 'kept\n')
  assert.deepEqual(k.sh('cd /tmp; cat f/; touch g/; mv f/ x; rm f/; echo $?; ls'), [
    '!cat: f/: not a directory',
    '!touch: g/: is a directory',
    '!mv: f/: not a directory',
    '!rm: f/: not a directory',
    '1',
    'f',
  ])
  assert.equal(k.read('/tmp/f'), 'kept\n')
})

test('`.` and `..` name a directory or nothing, even when the working directory went and a file took its name', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/d', '/', ROOT_CRED))
  now(vfs.mkdir('/d/e', '/', ROOT_CRED))
  assert.equal(now(vfs.stat('.', '/d/e', ROOT_CRED)).kind, 'dir')
  assert.equal(now(vfs.stat('..', '/d/e', ROOT_CRED)).ino, now(vfs.stat('/d', '/', ROOT_CRED)).ino)
  assert.deepEqual(names(vfs, '.'), ['d'])
  // A task works in /d/e (and in /d/e/sub, whose `..` is /d/e); the directory is removed and a file is made in its place.
  now(vfs.rmdir('/d/e', '/', ROOT_CRED))
  put(vfs, '/d/e', 'not a directory')
  const calls: [string, Task<unknown>][] = [
    ['stat .', vfs.stat('.', '/d/e', ROOT_CRED)], ['open .', vfs.open('.', '/d/e', ROOT_CRED, O_READ)], ['read .', vfs.readFile('.', '/d/e', ROOT_CRED)],
    ['write .', vfs.writeFile('.', '/d/e', ROOT_CRED, encode('x'))], ['unlink .', vfs.unlink('.', '/d/e', ROOT_CRED)],
    ['rename .', vfs.rename('.', '/moved', '/d/e', ROOT_CRED)], ['stat ..', vfs.stat('..', '/d/e/sub', ROOT_CRED)],
    ['read ..', vfs.readFile('..', '/d/e/sub', ROOT_CRED)],
  ]
  for (const [what, call] of calls) assert.equal(refusal(call), 'ENOTDIR', what)
  assert.equal(now(vfs.access('.', '/d/e', ROOT_CRED, 0)), false)
  assert.equal(get(vfs, '/d/e'), 'not a directory')
  // With nothing there at all, open never makes a file of `.` or `..`.
  now(vfs.unlink('/d/e', '/', ROOT_CRED))
  assert.equal(refusal(vfs.open('.', '/d/e', ROOT_CRED, O_WRITE | O_CREATE)), 'EISDIR')
  assert.equal(refusal(vfs.open('..', '/d/e/sub', ROOT_CRED, O_WRITE | O_CREATE)), 'EISDIR')
  assert.deepEqual(names(vfs, '/d'), [])
  // At the prompt: cat reads no file through `.`, and a redirection to `.` makes none.
  const k = boot(FILE_PROGRAMS)
  assert.deepEqual(k.sh('mkdir /tmp/d; cd /tmp/d; rmdir /tmp/d; echo hi > /tmp/d; cat .; echo $?; cd /'), ['!cat: .: not a directory', '1'])
  const out = k.sh('mkdir /tmp/e; cd /tmp/e; rmdir /tmp/e; echo hi > .; echo $?; cd /; ls /tmp')
  assert.equal(out.length, 3, out.join('|'))
  assert.match(out[0], /^!.*\.: is a directory$/)
  assert.deepEqual(out.slice(1), ['1', 'd'])
})

test('a tree cannot move to where its deepest path would pass the depth limit', () => {
  const k = boot({})
  const vfs = k.system.kernel.vfs
  // /tmp/t/n1/.../n62 is exactly DEPTH_MAX names deep.
  const names = Array.from({ length: DEPTH_MAX - 2 }, (_, i) => `n${i + 1}`)
  let path = '/tmp/t'
  now(vfs.mkdir(path, '/', ROOT_CRED))
  for (const name of names) {
    path = `${path}/${name}`
    now(vfs.mkdir(path, '/', ROOT_CRED))
  }
  now(vfs.mkdir('/tmp/x', '/', ROOT_CRED))
  // One level deeper is one too many: refused, and nothing moved.
  const e = (() => {
    try {
      now(vfs.rename('/tmp/t', '/tmp/x/t', '/', ROOT_CRED))
      return null
    } catch (err) {
      return err
    }
  })()
  assert.ok(e instanceof OsError)
  assert.equal(e.errno, 'ENAMETOOLONG')
  assert.match(e.message, /at most 64 names deep/)
  assert.equal(k.exists('/tmp/t/n1'), true)
  assert.equal(k.exists('/tmp/x/t'), false)
  // The same depth, or shallower, is fine; so is a file, which has nothing below it.
  now(vfs.rename('/tmp/t/n1', '/tmp/x/n1', '/', ROOT_CRED))
  assert.equal(k.exists(`/tmp/x/${names.join('/')}`), true)
  now(vfs.rename('/tmp/x/n1/n2', '/tmp/n2', '/', ROOT_CRED))
  k.write('/tmp/file', 'f')
  const deepDir = `/tmp/n2/${names.slice(2, -1).join('/')}`
  now(vfs.rename('/tmp/file', `${deepDir}/file`, '/', ROOT_CRED))
  assert.equal(k.exists(`${deepDir}/file`), true)
})

test('a file bigger than the whole file system is out of space, not too large', () => {
  const k = boot({}, { tmpBytes: 4096 })
  const vfs = k.system.kernel.vfs
  assert.equal(errnoOf(() => now(vfs.writeFile('/tmp/big', '/', ROOT_CRED, new Uint8Array(5000)))), 'ENOSPC')
  // What fits still fits.
  now(vfs.writeFile('/tmp/small', '/', ROOT_CRED, encode('fits')))
  assert.equal(k.read('/tmp/small'), 'fits')
})

// The walk and its permission checks.

test('a user who is not user 0 must be able to search every directory on the way; user 0 searches any', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/a', '/', ROOT_CRED, 0o755))
  now(vfs.mkdir('/a/b', '/', ROOT_CRED, 0o755))
  put(vfs, '/a/b/f', 'x', ROOT_CRED, 0o644)
  assert.equal(get(vfs, '/a/b/f', USER), 'x')
  // Others may read /a but not search it: the names show, nothing under them can be reached.
  now(vfs.chmod('/a', '/', ROOT_CRED, 0o754))
  assert.deepEqual(names(vfs, '/a', USER), ['b'])
  assert.equal(refusal(vfs.stat('/a/b', '/', USER)), 'EACCES')
  assert.equal(refusal(vfs.stat('/a/b/f', '/', USER)), 'EACCES')
  assert.equal(refusal(vfs.readFile('/a/b/f', '/', USER)), 'EACCES')
  assert.equal(refusal(vfs.list('/a/b', '/', USER)), 'EACCES')
  assert.equal(refusal(vfs.writeFile('/a/b/g', '/', USER, encode('y'))), 'EACCES')
  assert.equal(now(vfs.access('/a/b/f', '/', USER, 0)), false)
  // A working directory inside gives no way round: a relative path is walked from the root too.
  assert.equal(refusal(vfs.stat('f', '/a/b', USER)), 'EACCES')
  // The search bit is asked of the directories only: the last name needs none of its own.
  now(vfs.chmod('/a', '/', ROOT_CRED, 0o711))
  now(vfs.chmod('/a/b/f', '/', ROOT_CRED, 0))
  assert.equal(now(vfs.stat('/a/b/f', '/', USER)).mode, 0)
  assert.equal(now(vfs.access('/a/b/f', '/', USER, 0)), true)
  assert.equal(now(vfs.access('/a/b/f', '/', USER, R)), false)
  // User 0 is stopped by no bit on a directory.
  now(vfs.chmod('/a', '/', ROOT_CRED, 0))
  now(vfs.chmod('/a/b', '/', ROOT_CRED, 0))
  assert.equal(get(vfs, '/a/b/f'), 'x')
  assert.deepEqual(names(vfs, '/a/b'), ['f'])
  // The root itself is searched like any directory.
  now(vfs.chmod('/a', '/', ROOT_CRED, 0o755))
  now(vfs.chmod('/', '/', ROOT_CRED, 0o700))
  assert.equal(refusal(vfs.stat('/a', '/', USER)), 'EACCES')
  assert.equal(now(vfs.stat('/', '/', USER)).kind, 'dir')
  // A file in the middle of a path is no directory, for anyone.
  now(vfs.chmod('/', '/', ROOT_CRED, 0o755))
  now(vfs.chmod('/a/b', '/', ROOT_CRED, 0o755))
  assert.equal(refusal(vfs.stat('/a/b/f/g', '/', USER)), 'ENOTDIR')
  assert.equal(refusal(vfs.stat('/a/b/f/g', '/', ROOT_CRED)), 'ENOTDIR')
})

test('listing a directory takes R, finding a name in it takes X, and each works without the other', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/x', '/', ROOT_CRED, 0o711))
  put(vfs, '/x/known', 'k')
  assert.equal(refusal(vfs.list('/x', '/', USER)), 'EACCES')
  assert.equal(get(vfs, '/x/known', USER), 'k')
  now(vfs.chmod('/x', '/', ROOT_CRED, 0o744))
  assert.deepEqual(names(vfs, '/x', USER), ['known'])
  assert.equal(refusal(vfs.readFile('/x/known', '/', USER)), 'EACCES')
  // Names come back sorted by code unit, whatever order they were made in.
  for (const name of ['b', 'B', 'a', '_', '10', '9']) put(vfs, `/x/${name}`, '')
  assert.deepEqual(names(vfs, '/x'), ['10', '9', 'B', '_', 'a', 'b', 'known'])
  assert.equal(refusal(vfs.list('/x/known', '/', ROOT_CRED)), 'ENOTDIR')
  assert.equal(refusal(vfs.list('/nowhere', '/', ROOT_CRED)), 'ENOENT')
})

test('a file opens with the rights its bits give: the owner\'s bits first, then the group\'s, then everyone else\'s', () => {
  const { vfs } = bare()
  put(vfs, '/f', 'text')
  now(vfs.chown('/f', '/', ROOT_CRED, USER.uid, USER.gid))
  // The owner is judged by the owner's bits alone, even when the others may do more.
  now(vfs.chmod('/f', '/', ROOT_CRED, 0o047))
  assert.equal(refusal(vfs.open('/f', '/', USER, O_READ)), 'EACCES')
  assert.equal(now(vfs.access('/f', '/', USER, R)), false)
  // The same group: read, not write.
  assert.equal(get(vfs, '/f', PEER), 'text')
  assert.equal(refusal(vfs.open('/f', '/', PEER, O_WRITE)), 'EACCES')
  assert.equal(refusal(vfs.open('/f', '/', PEER, O_READ | O_WRITE)), 'EACCES')
  // Everyone else: all three.
  assert.equal(now(vfs.access('/f', '/', OTHER, R | W | X)), true)
  put(vfs, '/f', 'other', OTHER)
  assert.equal(get(vfs, '/f'), 'other')
  // Opened for neither reading nor writing, a file asks for no right at all.
  now(vfs.chmod('/f', '/', ROOT_CRED, 0))
  now(vfs.open('/f', '/', OTHER, 0)).close()
})

test('user 0 reads and writes anything and searches any directory, but runs a file only when some run bit is set', () => {
  const { vfs } = bare()
  put(vfs, '/f', 'x')
  now(vfs.mkdir('/d', '/', ROOT_CRED, 0))
  for (const mode of [0, 0o644, 0o600]) {
    now(vfs.chmod('/f', '/', ROOT_CRED, mode))
    assert.equal(now(vfs.access('/f', '/', ROOT_CRED, R | W)), true)
    assert.equal(now(vfs.access('/f', '/', ROOT_CRED, X)), false, mode.toString(8))
  }
  for (const mode of [0o100, 0o010, 0o001]) {
    now(vfs.chmod('/f', '/', ROOT_CRED, mode))
    assert.equal(now(vfs.access('/f', '/', ROOT_CRED, X)), true, mode.toString(8))
  }
  assert.equal(now(vfs.access('/d', '/', ROOT_CRED, R | W | X)), true)
  assert.equal(now(vfs.access('/nothing', '/', ROOT_CRED, 0)), false)
  assert.equal(now(vfs.access('/f/', '/', ROOT_CRED, 0)), false)
})

test('a file made by open is its maker\'s to write on that open, whatever bits it was given', () => {
  const { vfs } = bare()
  now(vfs.chmod('/', '/', ROOT_CRED, 0o777))
  const h = now(vfs.open('/mine', '/', USER, O_WRITE | O_CREATE, 0o000))
  now(h.write(encode('made')))
  h.close()
  const st = now(vfs.stat('/mine', '/', ROOT_CRED))
  assert.deepEqual([st.uid, st.gid, st.mode, st.size], [USER.uid, USER.gid, 0, 4])
  // The next open is judged by the bits.
  assert.equal(refusal(vfs.open('/mine', '/', USER, O_WRITE)), 'EACCES')
  assert.equal(refusal(vfs.open('/mine', '/', USER, O_READ)), 'EACCES')
  assert.equal(get(vfs, '/mine'), 'made')
  // Bits above the nine are never given by open: no sticky file.
  now(vfs.open('/wide', '/', USER, O_WRITE | O_CREATE, 0o7777)).close()
  assert.equal(now(vfs.stat('/wide', '/', USER)).mode, 0o777)
})

test('making, removing or renaming a name takes write and search on its directory, not on the file', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/d', '/', ROOT_CRED, 0o755))
  put(vfs, '/d/f', 'old', ROOT_CRED, 0o666)
  now(vfs.mkdir('/d/sub', '/', ROOT_CRED, 0o777))
  // The file takes writes; its directory takes no new names from USER.
  put(vfs, '/d/f', 'new', USER)
  assert.equal(get(vfs, '/d/f'), 'new')
  now(vfs.open('/d/f', '/', USER, O_WRITE | O_CREATE | O_TRUNC)).close()
  assert.equal(get(vfs, '/d/f'), '')
  assert.equal(refusal(vfs.writeFile('/d/g', '/', USER, encode('g'))), 'EACCES')
  assert.equal(refusal(vfs.mkdir('/d/e', '/', USER)), 'EACCES')
  assert.equal(refusal(vfs.unlink('/d/f', '/', USER)), 'EACCES')
  assert.equal(refusal(vfs.rmdir('/d/sub', '/', USER)), 'EACCES')
  assert.equal(refusal(vfs.rename('/d/f', '/d/g', '/', USER)), 'EACCES')
  // A move needs both directories: out of /d is refused even into a directory USER may write.
  assert.equal(refusal(vfs.rename('/d/f', '/d/sub/f', '/', USER)), 'EACCES')
  // Write without search is not enough either.
  now(vfs.chmod('/d', '/', ROOT_CRED, 0o776))
  assert.equal(refusal(vfs.unlink('/d/f', '/', USER)), 'EACCES')
  now(vfs.chmod('/d', '/', ROOT_CRED, 0o777))
  now(vfs.rename('/d/f', '/d/sub/f', '/', USER))
  now(vfs.mkdir('/d/e', '/', USER))
  now(vfs.unlink('/d/sub/f', '/', USER))
  now(vfs.rmdir('/d/sub', '/', USER))
  now(vfs.rmdir('/d/e', '/', USER))
  assert.deepEqual(names(vfs, '/d'), [])
})

test('in a sticky directory only the name\'s owner, the directory\'s owner or user 0 removes, moves or replaces a name', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/s', '/', ROOT_CRED, 0o1777))
  assert.equal(now(vfs.stat('/s', '/', ROOT_CRED)).mode, 0o1777)
  assert.equal(STICKY, 0o1000)
  put(vfs, '/s/u', 'users', USER, 0o666)
  now(vfs.mkdir('/s/ud', '/', USER, 0o777))
  put(vfs, '/s/o', 'others', OTHER)
  assert.equal(refusal(vfs.unlink('/s/u', '/', OTHER)), 'EPERM')
  assert.equal(refusal(vfs.rmdir('/s/ud', '/', OTHER)), 'EPERM')
  assert.equal(refusal(vfs.rename('/s/u', '/s/mine', '/', OTHER)), 'EPERM')
  assert.equal(refusal(vfs.rename('/s/o', '/s/u', '/', OTHER)), 'EPERM')
  assert.deepEqual(names(vfs, '/s'), ['o', 'u', 'ud'])
  // The bit guards the name, not the bytes: a file anyone may write is still written.
  put(vfs, '/s/u', 'written', OTHER)
  assert.equal(get(vfs, '/s/u'), 'written')
  // A name's owner may do what it likes with it, and replace its own names.
  now(vfs.rename('/s/o', '/s/o2', '/', OTHER))
  put(vfs, '/s/u2', 'second', USER)
  now(vfs.rename('/s/u2', '/s/u', '/', USER))
  assert.equal(get(vfs, '/s/u'), 'second')
  // The directory's owner may take any name in it, and so may user 0.
  now(vfs.chown('/s', '/', ROOT_CRED, PEER.uid, PEER.gid))
  now(vfs.unlink('/s/u', '/', PEER))
  now(vfs.rmdir('/s/ud', '/', ROOT_CRED))
  now(vfs.unlink('/s/o2', '/', ROOT_CRED))
  // Without the bit, anyone who may write the directory may take a name.
  put(vfs, '/s/u', 'again', USER)
  now(vfs.chmod('/s', '/', ROOT_CRED, 0o777))
  now(vfs.unlink('/s/u', '/', OTHER))
  assert.deepEqual(names(vfs, '/s'), [])
})

test('chmod is the owner\'s and user 0\'s, chown is user 0\'s alone, and utime is the owner\'s or a writer\'s', () => {
  const { vfs } = bare()
  now(vfs.chmod('/', '/', ROOT_CRED, 0o777))
  put(vfs, '/f', 'x', USER, 0o644)
  assert.equal(refusal(vfs.chmod('/f', '/', OTHER, 0o777)), 'EPERM')
  now(vfs.chmod('/f', '/', USER, 0o600))
  assert.equal(now(vfs.stat('/f', '/', USER)).mode, 0o600)
  // Only the nine bits and the sticky bit are kept.
  now(vfs.chmod('/f', '/', USER, 0o7777))
  assert.equal(now(vfs.stat('/f', '/', USER)).mode, 0o1777)
  assert.equal(refusal(vfs.chown('/f', '/', USER, USER.uid, USER.gid)), 'EPERM')
  now(vfs.chown('/f', '/', ROOT_CRED, OTHER.uid, OTHER.gid))
  const st = now(vfs.stat('/f', '/', ROOT_CRED))
  assert.deepEqual([st.uid, st.gid], [OTHER.uid, OTHER.gid])
  // utime: the owner even with no bits, anyone who may write, user 0; nobody else.
  now(vfs.chmod('/f', '/', ROOT_CRED, 0))
  now(vfs.utime('/f', '/', OTHER, 1234))
  assert.equal(now(vfs.stat('/f', '/', OTHER)).mtime, 1234)
  assert.equal(refusal(vfs.utime('/f', '/', USER, 5)), 'EACCES')
  now(vfs.chmod('/f', '/', ROOT_CRED, 0o666))
  now(vfs.utime('/f', '/', USER, 5))
  now(vfs.utime('/f', '/', ROOT_CRED, 6))
  assert.equal(now(vfs.stat('/f', '/', ROOT_CRED)).mtime, 6)
  for (const call of [vfs.chmod('/none', '/', ROOT_CRED, 0), vfs.chown('/none', '/', ROOT_CRED, 0, 0), vfs.utime('/none', '/', ROOT_CRED, 0)]) {
    assert.equal(refusal(call), 'ENOENT')
  }
})

test('a read-only mount refuses every change as EROFS, and access says writing it is not to be had', () => {
  const { vfs } = bare()
  const ro = new MemFs({ type: 'romfs', capacity: 4096, maxFile: 4096, maxNodes: 10, clock: () => 0 })
  ro.write(ro.create(ro.root, 'f', 'file', 0o666, ROOT_CRED), 0, encode('sealed'))
  ro.create(ro.root, 'd', 'dir', 0o777, ROOT_CRED)
  ro.seal()
  assert.equal(ro.readOnly, true)
  now(vfs.mkdir('/ro', '/', ROOT_CRED))
  now(vfs.mount('/ro', ro, 'rom', ROOT_CRED))
  assert.equal(get(vfs, '/ro/f'), 'sealed')
  const changes: Task<unknown>[] = [
    vfs.open('/ro/f', '/', ROOT_CRED, O_WRITE), vfs.open('/ro/new', '/', ROOT_CRED, O_WRITE | O_CREATE), vfs.writeFile('/ro/f', '/', ROOT_CRED, encode('x')),
    vfs.truncate('/ro/f', '/', ROOT_CRED, 0), vfs.mkdir('/ro/e', '/', ROOT_CRED), vfs.unlink('/ro/f', '/', ROOT_CRED), vfs.rmdir('/ro/d', '/', ROOT_CRED),
    vfs.rename('/ro/f', '/ro/g', '/', ROOT_CRED), vfs.chmod('/ro/f', '/', ROOT_CRED, 0), vfs.chown('/ro/f', '/', ROOT_CRED, 1, 1),
    vfs.utime('/ro/f', '/', ROOT_CRED, 1),
  ]
  for (const call of changes) assert.equal(refusal(call), 'EROFS')
  assert.equal(now(vfs.access('/ro/f', '/', ROOT_CRED, W)), false)
  assert.equal(now(vfs.access('/ro/f', '/', USER, R | W)), false)
  assert.equal(now(vfs.access('/ro/f', '/', USER, R)), true)
  // Nothing changed, and nothing is left open.
  assert.equal(get(vfs, '/ro/f'), 'sealed')
  assert.equal(mountAt(vfs, '/ro').opens, 0)
  vfs.umount('/ro', ROOT_CRED)
})

// Open flags and descriptors.

test('open: O_CREATE makes, O_EXCL refuses a name already taken, O_TRUNC cuts, O_APPEND writes at the end', () => {
  const { vfs } = bare()
  assert.equal(refusal(vfs.open('/f', '/', ROOT_CRED, O_READ)), 'ENOENT')
  assert.equal(refusal(vfs.open('/no/f', '/', ROOT_CRED, O_WRITE | O_CREATE)), 'ENOENT')
  now(vfs.open('/f', '/', ROOT_CRED, O_WRITE | O_CREATE | O_EXCL)).close()
  assert.equal(now(vfs.stat('/f', '/', ROOT_CRED)).size, 0)
  put(vfs, '/f', 'abcdef')
  assert.equal(refusal(vfs.open('/f', '/', ROOT_CRED, O_WRITE | O_CREATE | O_EXCL | O_TRUNC)), 'EEXIST')
  assert.equal(get(vfs, '/f'), 'abcdef')
  // O_EXCL means nothing without O_CREATE; O_TRUNC means nothing without O_WRITE.
  now(vfs.open('/f', '/', ROOT_CRED, O_READ | O_EXCL)).close()
  now(vfs.open('/f', '/', ROOT_CRED, O_READ | O_TRUNC)).close()
  assert.equal(get(vfs, '/f'), 'abcdef')
  // Without O_TRUNC a write lays bytes over the old ones.
  const over = now(vfs.open('/f', '/', ROOT_CRED, O_WRITE))
  now(over.write(encode('XY')))
  over.close()
  assert.equal(get(vfs, '/f'), 'XYcdef')
  // O_APPEND: every write goes to the end as it is at that moment, wherever the position was put.
  const app = now(vfs.open('/f', '/', ROOT_CRED, O_WRITE | O_APPEND))
  now(app.seek(0, 0))
  now(app.write(encode('1')))
  const other = now(vfs.open('/f', '/', ROOT_CRED, O_WRITE))
  now(other.seek(7, 0))
  now(other.write(encode('--')))
  now(app.write(encode('2')))
  app.close()
  other.close()
  assert.equal(get(vfs, '/f'), 'XYcdef1--2')
  now(vfs.writeFile('/f', '/', ROOT_CRED, encode('!'), { append: true }))
  assert.equal(get(vfs, '/f'), 'XYcdef1--2!')
  now(vfs.open('/f', '/', ROOT_CRED, O_WRITE | O_TRUNC)).close()
  assert.equal(get(vfs, '/f'), '')
  // A file in the middle of the path is no directory.
  assert.equal(refusal(vfs.open('/f/g', '/', ROOT_CRED, O_WRITE | O_CREATE)), 'ENOTDIR')
  assert.equal(refusal(vfs.open('/f/g', '/', USER, O_WRITE | O_CREATE)), 'ENOTDIR')
})

test('a descriptor reads and writes only as it was opened, does nothing once closed, and is counted once', () => {
  const { vfs } = bare()
  put(vfs, '/f', 'abc')
  const root = mountAt(vfs, '/')
  const r = now(vfs.open('/f', '/', ROOT_CRED, O_READ))
  const w = now(vfs.open('/f', '/', ROOT_CRED, O_WRITE))
  assert.equal(root.opens, 2)
  assert.equal(refusal(r.write(encode('x'))), 'EBADF')
  assert.equal(refusal(r.truncate(0)), 'EBADF')
  assert.equal(refusal(w.read(1)), 'EBADF')
  assert.equal(now(r.read(0)).length, 0)
  assert.equal(now(r.read(-5)).length, 0)
  assert.equal(decode(now(r.read(100))), 'abc')
  assert.equal(now(r.read(100)).length, 0)
  assert.equal(now(r.stat()).size, 3)
  assert.equal(now(r.stat()).dev, root.id)
  r.close()
  r.close()
  assert.equal(root.opens, 1)
  for (const call of [r.read(1), r.seek(0, 0), r.stat()]) assert.equal(refusal(call), 'EBADF')
  w.close()
  assert.equal(refusal(w.write(encode('x'))), 'EBADF')
  assert.equal(refusal(w.truncate(0)), 'EBADF')
  assert.equal(root.opens, 0)
})

test('a directory, and the root, cannot be opened as a file; they are listed', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/d', '/', ROOT_CRED))
  for (const path of ['/', '/d', '/d/', '.']) {
    assert.equal(refusal(vfs.open(path, '/', ROOT_CRED, O_READ)), 'EISDIR', path)
    assert.equal(refusal(vfs.open(path, '/', ROOT_CRED, O_WRITE | O_CREATE)), 'EISDIR', path)
    assert.equal(refusal(vfs.readFile(path, '/', ROOT_CRED)), 'EISDIR', path)
  }
  assert.equal(refusal(vfs.truncate('/d', '/', ROOT_CRED, 0)), 'EISDIR')
  assert.equal(mountAt(vfs, '/').opens, 0)
})

test('seek: from the start, from the position and from the end; never before the start, never past a safe number', () => {
  const { vfs } = bare()
  put(vfs, '/f', 'abcdef')
  const h = now(vfs.open('/f', '/', ROOT_CRED, O_READ))
  assert.equal(now(h.seek(2, 0)), 2)
  assert.equal(decode(now(h.read(2))), 'cd')
  assert.equal(now(h.seek(-1, 1)), 3)
  assert.equal(decode(now(h.read(1))), 'd')
  assert.equal(now(h.seek(-2, 2)), 4)
  assert.equal(decode(now(h.read(9))), 'ef')
  for (const [offset, whence] of [[-1, 0], [-7, 2], [-100, 1]] as const) assert.equal(refusal(h.seek(offset, whence)), 'EINVAL')
  // A refused seek leaves the position where it was.
  assert.equal(now(h.seek(0, 1)), 6)
  assert.equal(now(h.seek(Number.MAX_SAFE_INTEGER, 0)), Number.MAX_SAFE_INTEGER)
  assert.equal(refusal(h.seek(1, 1)), 'EINVAL')
  // Past the end reads nothing.
  assert.equal(now(h.read(4)).length, 0)
  h.close()
})

test('a write past the end leaves zeros between, never bytes a longer past left behind, and the gap is charged', () => {
  const { fs, vfs } = bare()
  put(vfs, '/f', 'ab')
  const before = fs.usage().used
  const h = now(vfs.open('/f', '/', ROOT_CRED, O_READ | O_WRITE))
  now(h.seek(10, 0))
  assert.equal(now(h.write(encode('z'))), 1)
  assert.equal(now(h.seek(0, 1)), 11)
  assert.deepEqual([...now(vfs.readFile('/f', '/', ROOT_CRED))], [97, 98, 0, 0, 0, 0, 0, 0, 0, 0, 122])
  assert.equal(fs.usage().used, before + 9)
  // Fill to 40, cut to 20 (the array is kept), then grow again both ways: what shows past 20 is zeros.
  now(h.seek(0, 0))
  now(h.write(encode('x'.repeat(40))))
  now(h.truncate(20))
  now(h.seek(30, 0))
  now(h.write(encode('y')))
  const grown = now(vfs.readFile('/f', '/', ROOT_CRED))
  assert.equal(decode(grown.subarray(0, 20)), 'x'.repeat(20))
  assert.deepEqual([...grown.subarray(20, 30)], new Array(10).fill(0))
  assert.equal(grown[30], 121)
  now(h.truncate(20))
  now(h.truncate(35))
  assert.deepEqual([...now(vfs.readFile('/f', '/', ROOT_CRED)).subarray(20)], new Array(15).fill(0))
  // The position stays where it was after a cut: the next write leaves a gap again.
  now(h.truncate(0))
  now(h.write(encode('w')))
  assert.equal(now(vfs.stat('/f', '/', ROOT_CRED)).size, 32)
  h.close()
  now(vfs.unlink('/f', '/', ROOT_CRED))
  assert.equal(fs.usage().used, before - NODE_COST - 1 - 2)
})

test('a write of nothing changes nothing, even from a position past the end', () => {
  const { fs, vfs } = bare()
  put(vfs, '/f', 'abc')
  const used = fs.usage().used
  const version = fs.version
  const h = now(vfs.open('/f', '/', ROOT_CRED, O_WRITE))
  now(h.seek(100, 0))
  assert.equal(now(h.write(new Uint8Array(0))), 0)
  h.close()
  assert.equal(now(vfs.stat('/f', '/', ROOT_CRED)).size, 3)
  assert.equal(get(vfs, '/f'), 'abc')
  assert.equal(fs.usage().used, used)
  assert.equal(fs.version, version)
})

test('truncate cuts and extends with zeros, refuses a negative size, a file past the largest, and anything but a file', () => {
  const { vfs } = bare({ maxFile: 100 })
  put(vfs, '/f', 'abcdef')
  now(vfs.truncate('/f', '/', ROOT_CRED, 3))
  assert.equal(get(vfs, '/f'), 'abc')
  now(vfs.truncate('/f', '/', ROOT_CRED, 5))
  assert.deepEqual([...now(vfs.readFile('/f', '/', ROOT_CRED))], [97, 98, 99, 0, 0])
  assert.equal(refusal(vfs.truncate('/f', '/', ROOT_CRED, -1)), 'EINVAL')
  assert.equal(refusal(vfs.truncate('/f', '/', ROOT_CRED, 1.5)), 'EINVAL')
  assert.equal(refusal(vfs.truncate('/f', '/', ROOT_CRED, 101)), 'EFBIG')
  now(vfs.truncate('/f', '/', ROOT_CRED, 100))
  assert.equal(refusal(vfs.truncate('/none', '/', ROOT_CRED, 0)), 'ENOENT')
  // A user who may not write the file may not cut it.
  assert.equal(refusal(vfs.truncate('/f', '/', USER, 0)), 'EACCES')
  assert.equal(now(vfs.stat('/f', '/', ROOT_CRED)).size, 100)
  assert.equal(mountAt(vfs, '/').opens, 0)
})

test('the open count: a mount cannot be taken away while a file on it is open, and a task abandoned by now() still closes', () => {
  const k = boot({})
  const vfs = k.system.kernel.vfs
  k.write('/tmp/f', 'open')
  const tmp = mountAt(vfs, '/tmp')
  const h = now(vfs.open('/tmp/f', '/', ROOT_CRED, O_READ))
  const h2 = now(vfs.open('/tmp/f', '/', ROOT_CRED, O_READ))
  assert.equal(tmp.opens, 2)
  assert.equal(errnoOf(() => vfs.umount('/tmp', ROOT_CRED)), 'EBUSY')
  h.close()
  h.close()
  assert.equal(tmp.opens, 1)
  assert.equal(errnoOf(() => vfs.umount('/tmp', ROOT_CRED)), 'EBUSY')
  h2.close()
  assert.equal(tmp.opens, 0)
  // A file read whole, cut, or written whole is closed again on every path, refused or not.
  k.read('/tmp/f')
  assert.equal(refusal(vfs.truncate('/tmp/f', '/', ROOT_CRED, -1)), 'EINVAL')
  assert.equal(refusal(vfs.writeFile('/tmp/big', '/', ROOT_CRED, new Uint8Array(TMP_ROOM))), 'ENOSPC')
  assert.equal(tmp.opens, 0)
  // A reading that would wait, read where nothing may: refused, and its descriptor is closed on the way out.
  const later = new Later<string>()
  const { vfs: own } = bare()
  now(own.mkdir('/s', '/', ROOT_CRED))
  now(own.mount('/s', new SynthFs('test', dir({ late: { kind: 'file', read: () => later } }), () => 0), 'test', ROOT_CRED))
  assert.equal(refusal(own.readFile('/s/late', '/', ROOT_CRED)), 'EAGAIN')
  assert.equal(mountAt(own, '/s').opens, 0)
  own.umount('/s', ROOT_CRED)
  // And with nothing open, /tmp goes, the disk's own directory shows again, and the same driver comes back.
  vfs.umount('/tmp', ROOT_CRED)
  assert.equal(k.exists('/tmp/f'), false)
  assert.equal(now(vfs.stat('/tmp', '/', ROOT_CRED)).mode, 0o755)
  now(vfs.mount('/tmp', tmp.driver, 'tmpfs', ROOT_CRED))
  assert.equal(k.read('/tmp/f'), 'open')
})

// Making, removing and moving names.

test('mkdir, rmdir and unlink each refuse by name, and change nothing when they do', () => {
  const { fs, vfs } = bare()
  now(vfs.mkdir('/d', '/', ROOT_CRED))
  put(vfs, '/d/f', 'x')
  const version = fs.version
  const cases: [Task<unknown>, string][] = [
    [vfs.mkdir('/', '/', ROOT_CRED), 'EEXIST'], [vfs.mkdir('/d', '/', ROOT_CRED), 'EEXIST'], [vfs.mkdir('/d/f', '/', ROOT_CRED), 'EEXIST'],
    [vfs.mkdir('/no/e', '/', ROOT_CRED), 'ENOENT'], [vfs.mkdir('/d/f/e', '/', ROOT_CRED), 'ENOTDIR'],
    [vfs.rmdir('/', '/', ROOT_CRED), 'EBUSY'], [vfs.rmdir('/d', '/', ROOT_CRED), 'ENOTEMPTY'], [vfs.rmdir('/d/f', '/', ROOT_CRED), 'ENOTDIR'],
    [vfs.rmdir('/none', '/', ROOT_CRED), 'ENOENT'], [vfs.unlink('/', '/', ROOT_CRED), 'EBUSY'], [vfs.unlink('/d', '/', ROOT_CRED), 'EISDIR'],
    [vfs.unlink('/d/', '/', ROOT_CRED), 'EISDIR'], [vfs.unlink('/d/none', '/', ROOT_CRED), 'ENOENT'], [vfs.unlink('/d/f/', '/', ROOT_CRED), 'ENOTDIR'],
  ]
  for (const [call, errno] of cases) assert.equal(refusal(call), errno)
  assert.equal(fs.version, version)
  assert.match(reasonOf(vfs.rmdir('/', '/', ROOT_CRED)), /the root directory/)
  // The slash forms of a directory work as the plain name does.
  now(vfs.mkdir('/e/', '/', ROOT_CRED))
  now(vfs.rmdir('/e/', '/', ROOT_CRED))
  now(vfs.unlink('/d/f', '/', ROOT_CRED))
  now(vfs.rmdir('/d/.', '/', ROOT_CRED))
  assert.deepEqual(names(vfs, '/'), [])
})

test('rename replaces a file, or an empty directory with a directory, and gives back what the replaced name held', () => {
  const { fs, vfs } = bare()
  put(vfs, '/f', 'moved')
  put(vfs, '/g', 'replaced!')
  now(vfs.mkdir('/d', '/', ROOT_CRED))
  now(vfs.mkdir('/e', '/', ROOT_CRED))
  now(vfs.mkdir('/full', '/', ROOT_CRED))
  put(vfs, '/full/x', '')
  const used = fs.usage().used
  now(vfs.rename('/f', '/g', '/', ROOT_CRED))
  assert.equal(get(vfs, '/g'), 'moved')
  assert.equal(fs.usage().used, used - NODE_COST - 1 - 'replaced!'.length)
  now(vfs.rename('/d', '/e', '/', ROOT_CRED))
  assert.deepEqual(names(vfs, '/'), ['e', 'full', 'g'])
  const version = fs.version
  const cases: [Task<unknown>, string][] = [
    [vfs.rename('/e', '/full', '/', ROOT_CRED), 'ENOTEMPTY'], [vfs.rename('/e', '/g', '/', ROOT_CRED), 'ENOTDIR'],
    [vfs.rename('/g', '/e', '/', ROOT_CRED), 'EISDIR'], [vfs.rename('/none', '/x', '/', ROOT_CRED), 'ENOENT'],
    [vfs.rename('/g', '/none/g', '/', ROOT_CRED), 'ENOENT'], [vfs.rename('/', '/x', '/', ROOT_CRED), 'EBUSY'], [vfs.rename('/g', '/', '/', ROOT_CRED), 'EBUSY'],
  ]
  for (const [call, errno] of cases) assert.equal(refusal(call), errno)
  // A name moved onto itself is no change at all.
  now(vfs.rename('/g', '/g', '/', ROOT_CRED))
  now(vfs.rename('/e', './e/', '/', ROOT_CRED))
  assert.equal(fs.version, version)
  assert.equal(get(vfs, '/g'), 'moved')
})

test('rename: a directory never moves into itself, and a file under its own name is no directory', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/d', '/', ROOT_CRED))
  now(vfs.mkdir('/d/sub', '/', ROOT_CRED))
  put(vfs, '/f', 'x')
  for (const to of ['/d/x', '/d/sub/x', '/d/sub']) {
    assert.equal(refusal(vfs.rename('/d', to, '/', ROOT_CRED)), 'EINVAL', to)
    assert.match(reasonOf(vfs.rename('/d', to, '/', ROOT_CRED)), /cannot move into itself/)
  }
  // A file is not a directory, so nothing can be under it: it is not said to be one.
  assert.equal(refusal(vfs.rename('/f', '/f/x', '/', ROOT_CRED)), 'ENOTDIR')
  assert.equal(refusal(vfs.rename('/f', '/f/x', '/', USER)), 'ENOTDIR')
  assert.deepEqual(names(vfs, '/'), ['d', 'f'])
})

test('the programs see the same: mv of a file under its own name says it is not a directory', () => {
  const k = boot(FILE_PROGRAMS)
  k.write('/tmp/f', 'kept')
  const out = k.sh('cd /tmp; mv f f/x; echo $?')
  assert.equal(out.length, 2)
  assert.match(out[0], /^!mv: .*not a directory$/)
  assert.equal(out[1], '1')
  assert.equal(k.read('/tmp/f'), 'kept')
})

test('mount points are never removed, moved or replaced, no tree with a mount inside it moves, and moves never cross mounts', () => {
  const k = boot({})
  const vfs = k.system.kernel.vfs
  k.write('/tmp/f', 'scratch')
  for (const call of [vfs.rmdir('/tmp', '/', ROOT_CRED), vfs.unlink('/tmp', '/', ROOT_CRED), vfs.rename('/tmp', '/tmp2', '/', ROOT_CRED),
    vfs.rename('/etc/hostname', '/tmp', '/', ROOT_CRED), vfs.rmdir('/tmp/.', '/', ROOT_CRED), vfs.rename('/proc', '/home/p', '/', ROOT_CRED)]) {
    assert.equal(refusal(call), 'EBUSY')
  }
  assert.match(reasonOf(vfs.rmdir('/tmp', '/', ROOT_CRED)), /a mount point/)
  now(vfs.mkdir('/mnt/a', '/', ROOT_CRED))
  now(vfs.mkdir('/mnt/a/b', '/', ROOT_CRED))
  const extra = new MemFs({ capacity: 4096, maxFile: 4096, maxNodes: 10, clock: () => 0 })
  now(vfs.mount('/mnt/a/b', extra, 'extra', ROOT_CRED))
  assert.equal(refusal(vfs.rename('/mnt/a', '/mnt/c', '/', ROOT_CRED)), 'EBUSY')
  assert.match(reasonOf(vfs.rename('/mnt', '/mnt2', '/', ROOT_CRED)), /a mount point is inside it/)
  assert.equal(refusal(vfs.rmdir('/mnt/a', '/', ROOT_CRED)), 'ENOTEMPTY')
  assert.equal(errnoOf(() => vfs.umount('/mnt/a', ROOT_CRED)), 'EINVAL')
  // Across mounts a move is EXDEV, either way, and inside the inner mount it is its own business.
  assert.equal(refusal(vfs.rename('/tmp/f', '/home/f', '/', ROOT_CRED)), 'EXDEV')
  assert.equal(refusal(vfs.rename('/etc/hostname', '/tmp/h', '/', ROOT_CRED)), 'EXDEV')
  assert.equal(refusal(vfs.rename('/mnt/a/x', '/mnt/a/b/x', '/', ROOT_CRED)), 'EXDEV')
  put(vfs, '/mnt/a/b/x', 'inner')
  now(vfs.rename('/mnt/a/b/x', '/mnt/a/b/y', '/', ROOT_CRED))
  vfs.umount('/mnt/a/b', ROOT_CRED)
  now(vfs.rename('/mnt/a', '/mnt/c', '/', ROOT_CRED))
  assert.deepEqual(names(vfs, '/mnt/c'), ['b'])
  assert.equal(k.read('/tmp/f'), 'scratch')
})

test('a tree cannot move to where a path in it would pass PATH_MAX, and what it holds stays reachable', () => {
  const { vfs } = bare({ maxNodes: 100 })
  // /p/q/c/<15 names of 255>/<the rest>: a file whose path is exactly PATH_MAX long.
  for (const dir of ['/p', '/p/q', '/p/q/r', '/z']) now(vfs.mkdir(dir, '/', ROOT_CRED))
  let path = '/p/q/c'
  now(vfs.mkdir(path, '/', ROOT_CRED))
  for (let i = 0; i < 15; i++) {
    path += `/${String.fromCharCode(97 + i).repeat(NAME_MAX)}`
    now(vfs.mkdir(path, '/', ROOT_CRED))
  }
  const file = `${path}/${'f'.repeat(PATH_MAX - path.length - 1)}`
  assert.equal(file.length, PATH_MAX)
  put(vfs, file, 'deep')
  // A longer name at the same depth, a deeper place, a shallower place with a longer path: each one past the limit.
  for (const to of ['/p/q/cd', '/p/q/r/c', '/ccccccc']) {
    assert.equal(refusal(vfs.rename('/p/q/c', to, '/', ROOT_CRED)), 'ENAMETOOLONG', to)
    assert.match(reasonOf(vfs.rename('/p/q/c', to, '/', ROOT_CRED)), /at most 4096 characters long/)
  }
  assert.equal(get(vfs, file), 'deep')
  assert.deepEqual(names(vfs, '/p/q'), ['c', 'r'])
  // The same length, or shorter, is fine; and the file itself may always move somewhere shallower.
  now(vfs.rename('/p/q/c', '/p/q/e', '/', ROOT_CRED))
  now(vfs.rename('/p/q/e', '/e', '/', ROOT_CRED))
  const moved = `/e${file.slice('/p/q/c'.length)}`
  assert.equal(get(vfs, moved), 'deep')
  now(vfs.rename(moved, '/z/deep', '/', ROOT_CRED))
  assert.equal(get(vfs, '/z/deep'), 'deep')
  // One past the limit is refused when typed, too.
  assert.equal(refusal(vfs.stat(`${file}x`, '/', ROOT_CRED)), 'ENAMETOOLONG')
})

// Mounts.

test('mount and umount: user 0 alone, a directory only, one driver once and one place once, at most MOUNTS_MAX', () => {
  const k = boot({})
  const vfs = k.system.kernel.vfs
  const fresh = (): MemFs => new MemFs({ capacity: 4096, maxFile: 4096, maxNodes: 10, clock: () => 0 })
  const tmp = mountAt(vfs, '/tmp')
  assert.equal(refusal(vfs.mount('/mnt', fresh(), 'x', USER)), 'EPERM')
  assert.equal(refusal(vfs.mount('/etc/hostname', fresh(), 'x', ROOT_CRED)), 'ENOTDIR')
  assert.equal(refusal(vfs.mount('/nowhere', fresh(), 'x', ROOT_CRED)), 'ENOENT')
  assert.equal(refusal(vfs.mount('/', fresh(), 'x', ROOT_CRED)), 'EBUSY')
  assert.match(reasonOf(vfs.mount('/tmp', fresh(), 'x', ROOT_CRED)), /mounted there already/)
  assert.match(reasonOf(vfs.mount('/mnt', tmp.driver, 'x', ROOT_CRED)), /that driver is mounted already/)
  assert.equal(errnoOf(() => vfs.umount('/tmp', USER)), 'EPERM')
  assert.match(messageOf(() => vfs.umount('/', ROOT_CRED)), /the root stays mounted/)
  assert.match(messageOf(() => vfs.umount('/home', ROOT_CRED)), /not a mount point/)
  // Fill the table: each mount gets its own number, and one past MOUNTS_MAX is refused.
  const before = vfs.mounts().length
  const made: string[] = []
  for (let i = before; i < MOUNTS_MAX; i++) {
    const path = `/mnt/m${i}`
    now(vfs.mkdir(path, '/', ROOT_CRED))
    const m = now(vfs.mount(path, fresh(), `m${i}`, ROOT_CRED))
    assert.equal(m.path, path)
    made.push(path)
  }
  assert.equal(vfs.mounts().length, MOUNTS_MAX)
  assert.equal(new Set(vfs.mounts().map((m) => m.id)).size, MOUNTS_MAX)
  now(vfs.mkdir('/mnt/last', '/', ROOT_CRED))
  assert.equal(refusal(vfs.mount('/mnt/last', fresh(), 'x', ROOT_CRED)), 'ENOSPC')
  // A mount inside a mount holds the outer one in place.
  const inner = made[0]
  now(vfs.mkdir(`${inner}/in`, '/', ROOT_CRED))
  vfs.umount(made[1], ROOT_CRED)
  now(vfs.mount(`${inner}/in`, fresh(), 'in', ROOT_CRED))
  assert.match(messageOf(() => vfs.umount(inner, ROOT_CRED)), /a mount point is inside it/)
  vfs.umount(`${inner}/in/`, ROOT_CRED)
  for (const path of made.filter((p) => p !== made[1])) vfs.umount(path, ROOT_CRED)
  assert.equal(vfs.mounts().length, before)
  assert.deepEqual(vfs.mounts().map((m) => m.path), ['/', '/bin', '/usr', '/tmp', '/dev', '/proc', '/sys'])
})

test('a path crosses into a mount and back out by its own text, and stat names the mount as the device', () => {
  const k = boot({})
  const vfs = k.system.kernel.vfs
  const root = now(vfs.stat('/', '/', ROOT_CRED))
  const tmp = now(vfs.stat('/tmp', '/', ROOT_CRED))
  assert.notEqual(tmp.dev, root.dev)
  assert.equal(tmp.dev, mountAt(vfs, '/tmp').id)
  assert.equal(tmp.mode, 0o1777)
  assert.equal(now(vfs.stat('/tmp/..', '/', ROOT_CRED)).dev, root.dev)
  assert.equal(now(vfs.stat('../../etc', '/tmp', ROOT_CRED)).dev, root.dev)
  assert.equal(now(vfs.stat('/tmp/../tmp/.', '/', ROOT_CRED)).dev, tmp.dev)
  assert.equal(vfs.usage(mountAt(vfs, '/tmp')).capacity, 4 << 20)
  assert.equal(vfs.usage(mountAt(vfs, '/proc')).capacity, 0)
})

// readFile and writeFile.

test('readFile reads at most READ_FILE_MAX bytes: a larger file or an endless device is refused, and closed again', () => {
  const { vfs } = bare()
  now(vfs.mkdir('/big', '/', ROOT_CRED))
  const fake = new Sized(READ_FILE_MAX + 1)
  now(vfs.mount('/big', fake, 'test', ROOT_CRED))
  assert.equal(refusal(vfs.readFile('/big/file', '/', ROOT_CRED)), 'EFBIG')
  assert.equal(refusal(vfs.readFile('/big/endless', '/', ROOT_CRED)), 'EFBIG')
  assert.equal(mountAt(vfs, '/big').opens, 0)
  vfs.umount('/big', ROOT_CRED)
  now(vfs.mount('/big', new Sized(READ_FILE_MAX), 'test', ROOT_CRED))
  assert.equal(now(vfs.readFile('/big/file', '/', ROOT_CRED)).length, READ_FILE_MAX)
})

// Names and paths at their limits.

test('a name of NAME_MAX is kept, moved and removed; one longer is refused everywhere a name is given', () => {
  const { vfs } = bare()
  const long = 'n'.repeat(NAME_MAX)
  const longer = `${long}n`
  put(vfs, `/${long}`, 'x')
  now(vfs.mkdir(`/${'d'.repeat(NAME_MAX)}`, '/', ROOT_CRED))
  assert.deepEqual(names(vfs, '/'), ['d'.repeat(NAME_MAX), long])
  now(vfs.rename(`/${long}`, `/${'m'.repeat(NAME_MAX)}`, '/', ROOT_CRED))
  for (const call of [vfs.writeFile(`/${longer}`, '/', ROOT_CRED, encode('x')), vfs.mkdir(`/${longer}`, '/', ROOT_CRED), vfs.stat(`/${longer}`, '/', ROOT_CRED),
    vfs.rename(`/${'m'.repeat(NAME_MAX)}`, `/${longer}`, '/', ROOT_CRED), vfs.unlink(`/${longer}`, '/', ROOT_CRED)]) {
    assert.equal(refusal(call), 'ENAMETOOLONG')
  }
  // A name is counted in UTF-16 units, as path.ts counts it: one of NAME_MAX accented letters is kept.
  const accented = 'é'.repeat(NAME_MAX)
  put(vfs, `/${accented}`, 'e')
  assert.equal(get(vfs, `/${accented}`), 'e')
  now(vfs.unlink(`/${'m'.repeat(NAME_MAX)}`, '/', ROOT_CRED))
  now(vfs.rmdir(`/${'d'.repeat(NAME_MAX)}`, '/', ROOT_CRED))
  assert.deepEqual(names(vfs, '/'), [accented])
})

test('a path may be DEPTH_MAX names deep and no deeper, wherever it is typed from', () => {
  const { vfs } = bare()
  let path = ''
  for (let i = 1; i <= DEPTH_MAX; i++) {
    path += `/${i}`
    now(vfs.mkdir(path, '/', ROOT_CRED))
  }
  assert.equal(now(vfs.stat(path, '/', ROOT_CRED)).kind, 'dir')
  assert.equal(refusal(vfs.mkdir(`${path}/x`, '/', ROOT_CRED)), 'ENAMETOOLONG')
  assert.equal(refusal(vfs.writeFile(`${path}/x`, '/', ROOT_CRED, encode(''))), 'ENAMETOOLONG')
  assert.equal(refusal(vfs.mkdir('x', path, ROOT_CRED)), 'ENAMETOOLONG')
  assert.match(reasonOf(vfs.mkdir('x', path, ROOT_CRED)), /at most 64 names deep/)
  // `..` is settled before the walk, so a deep start and a climb back is a short path.
  now(vfs.writeFile('../x', path, ROOT_CRED, encode('up')))
  assert.equal(get(vfs, `${path.slice(0, path.lastIndexOf('/'))}/x`), 'up')
})

test('thousands of names in one directory: each made, found and listed in order, all removed, and the space given back', () => {
  const { fs, vfs } = bare({ maxNodes: 4000, capacity: 1 << 20 })
  now(vfs.mkdir('/many', '/', ROOT_CRED))
  const start = fs.usage()
  const count = 3000
  const all = Array.from({ length: count }, (_, i) => `f${String(i).padStart(4, '0')}`)
  for (const name of all.slice().reverse()) put(vfs, `/many/${name}`, name)
  assert.deepEqual(names(vfs, '/many'), all)
  assert.equal(get(vfs, '/many/f1234'), 'f1234')
  const used = fs.usage()
  assert.equal(used.nodes, start.nodes + count)
  assert.equal(used.used, start.used + count * (NODE_COST + 5 + 5))
  assert.equal(now(vfs.stat('/many', '/', ROOT_CRED)).nlink, 2)
  for (const name of all) now(vfs.unlink(`/many/${name}`, '/', ROOT_CRED))
  assert.deepEqual(fs.usage(), start)
  now(vfs.rmdir('/many', '/', ROOT_CRED))
})

/** How many times `run` looks a key up in any Map: a measure of the work a call does that needs no clock. */
function lookups(run: () => unknown): number {
  const get = Map.prototype.get
  let count = 0
  Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown): unknown {
    count++
    return get.call(this, key)
  }
  try {
    run()
  } finally {
    Map.prototype.get = get
  }
  return count
}

test('a directory\'s link count follows its subdirectories through every change, and stat never counts them one by one', () => {
  const { fs, vfs } = bare({ maxNodes: 5000, capacity: 1 << 22 })
  const nlink = (path: string): number => now(vfs.stat(path, '/', ROOT_CRED)).nlink
  const links = (): number[] => ['/', '/a', '/b'].map(nlink)
  assert.equal(nlink('/'), 2)
  for (const path of ['/a', '/b', '/a/x', '/a/y']) now(vfs.mkdir(path, '/', ROOT_CRED))
  put(vfs, '/a/f', 'file')
  assert.deepEqual(links(), [4, 4, 2])
  assert.deepEqual([nlink('/a/x'), nlink('/a/f')], [2, 1])
  // Moved to another directory, onto an empty directory there, within one directory; a file moved counts for nothing.
  now(vfs.rename('/a/x', '/b/x', '/', ROOT_CRED))
  assert.deepEqual(links(), [4, 3, 3])
  now(vfs.rename('/a/y', '/b/x', '/', ROOT_CRED))
  assert.deepEqual(links(), [4, 2, 3])
  now(vfs.rename('/b/x', '/b/z', '/', ROOT_CRED))
  now(vfs.rename('/a/f', '/b/f', '/', ROOT_CRED))
  assert.deepEqual(links(), [4, 2, 3])
  // Refusals count nothing.
  assert.equal(refusal(vfs.rmdir('/b', '/', ROOT_CRED)), 'ENOTEMPTY')
  assert.equal(refusal(vfs.rename('/b', '/b/z/b', '/', ROOT_CRED)), 'EINVAL')
  assert.equal(refusal(vfs.rename('/b/f', '/b/z', '/', ROOT_CRED)), 'EISDIR')
  assert.equal(errnoOf(() => fs.rename(fs.root, 'a', fs.root, 'b')), 'ENOTEMPTY')
  assert.deepEqual(links(), [4, 2, 3])
  now(vfs.rename('/a', '/b/z/a', '/', ROOT_CRED))
  assert.deepEqual([nlink('/'), nlink('/b'), nlink('/b/z')], [3, 3, 3])
  // The image brings the same counts back; a wiped disk's root has none.
  const back = new MemFs({ capacity: 1 << 22, maxFile: 1 << 20, maxNodes: 5000, clock: () => 0 })
  restore(dump(fs), back)
  const backLinks = ['/', '/b', '/b/z', '/b/z/a'].map((path) => now(new Vfs(back, 'disk').stat(path, '/', ROOT_CRED)).nlink)
  assert.deepEqual(backLinks, [3, 3, 3, 2])
  now(vfs.unlink('/b/f', '/', ROOT_CRED))
  now(vfs.rmdir('/b/z/a', '/', ROOT_CRED))
  now(vfs.rmdir('/b/z', '/', ROOT_CRED))
  assert.deepEqual([nlink('/'), nlink('/b')], [3, 2])
  fs.wipe()
  assert.equal(nlink('/'), 2)
  // Thousands of subdirectories: a stat of their directory, or a name made or removed beside them, looks none of them up.
  // (Counting them on every stat made filling one directory, or emptying it, take time that grew with the square.)
  const big = fs.create(fs.root, 'big', 'dir', 0o755, ROOT_CRED)
  for (let i = 0; i < 3000; i++) fs.create(big, `d${i}`, 'dir', 0o755, ROOT_CRED)
  assert.equal(fs.stat(big).nlink, 3002)
  assert.ok(lookups(() => fs.stat(big)) <= 2)
  assert.ok(lookups(() => now(vfs.mkdir('/big/new', '/', ROOT_CRED))) < 50)
  assert.ok(lookups(() => now(vfs.writeFile('/big/file', '/', ROOT_CRED, encode('x')))) < 50)
  assert.ok(lookups(() => now(vfs.unlink('/big/file', '/', ROOT_CRED))) < 50)
  assert.ok(lookups(() => now(vfs.rmdir('/big/new', '/', ROOT_CRED))) < 50)
  assert.equal(nlink('/big'), 3002)
})

// The memory driver.

test('memfs charges every byte, every node and every name, and gives all of it back', () => {
  const { fs, vfs } = bare()
  const start = fs.usage()
  assert.deepEqual(start, { capacity: 1 << 20, used: NODE_COST, nodes: 1 })
  now(vfs.mkdir('/d', '/', ROOT_CRED))
  assert.equal(fs.usage().used, start.used + NODE_COST + 1)
  put(vfs, '/d/abc', '0123456789')
  assert.equal(fs.usage().used, start.used + 2 * NODE_COST + 1 + 3 + 10)
  now(vfs.truncate('/d/abc', '/', ROOT_CRED, 4))
  assert.equal(fs.usage().used, start.used + 2 * NODE_COST + 1 + 3 + 4)
  now(vfs.truncate('/d/abc', '/', ROOT_CRED, 20))
  assert.equal(fs.usage().used, start.used + 2 * NODE_COST + 1 + 3 + 20)
  now(vfs.rename('/d/abc', '/d/abcdef', '/', ROOT_CRED))
  assert.equal(fs.usage().used, start.used + 2 * NODE_COST + 1 + 6 + 20)
  now(vfs.rename('/d/abcdef', '/a', '/', ROOT_CRED))
  assert.equal(fs.usage().used, start.used + 2 * NODE_COST + 1 + 1 + 20)
  assert.equal(fs.usage().nodes, 3)
  // Writing over bytes already there costs nothing more; the driver keeps its own copy of what it was given and hands out copies.
  const given = encode('x'.repeat(20))
  now(vfs.writeFile('/a', '/', ROOT_CRED, given))
  given.fill(0)
  now(vfs.readFile('/a', '/', ROOT_CRED)).fill(0)
  assert.equal(get(vfs, '/a'), 'x'.repeat(20))
  assert.equal(fs.usage().used, start.used + 2 * NODE_COST + 1 + 1 + 20)
  now(vfs.unlink('/a', '/', ROOT_CRED))
  now(vfs.rmdir('/d', '/', ROOT_CRED))
  assert.deepEqual(fs.usage(), start)
})

test('memfs refuses growth past its capacity or its largest file without changing anything, out of space first', () => {
  // Room for the root, one node named f, and 100 bytes.
  const fs = new MemFs({ capacity: NODE_COST * 2 + 1 + 100, maxFile: 1000, maxNodes: 10, clock: () => 0 })
  const f = fs.create(fs.root, 'f', 'file', 0o644, ROOT_CRED)
  assert.equal(fs.write(f, 0, new Uint8Array(100).fill(65)), 100)
  assert.equal(fs.usage().used, fs.usage().capacity)
  const version = fs.version
  const unchanged = (): void => {
    assert.equal(fs.stat(f).size, 100)
    assert.equal(fs.usage().used, fs.usage().capacity)
    assert.equal(fs.version, version)
    assert.equal(decode(fs.read(f, 0, 1000)), 'A'.repeat(100))
  }
  assert.equal(errnoOf(() => fs.write(f, 100, encode('B'))), 'ENOSPC')
  assert.equal(errnoOf(() => fs.write(f, 95, encode('BBBBBB'))), 'ENOSPC')
  assert.equal(errnoOf(() => fs.truncate(f, 101)), 'ENOSPC')
  assert.equal(errnoOf(() => fs.create(fs.root, 'g', 'file', 0o644, ROOT_CRED)), 'ENOSPC')
  assert.equal(errnoOf(() => fs.create(fs.root, 'g', 'dir', 0o755, ROOT_CRED)), 'ENOSPC')
  unchanged()
  // Bytes inside the file are rewritten freely.
  fs.write(f, 0, encode('BB'))
  assert.equal(fs.usage().used, fs.usage().capacity)
  // The largest file: refused as too large when there is room, as out of space when there is not.
  const roomy = new MemFs({ capacity: 1 << 20, maxFile: 50, maxNodes: 10, clock: () => 0 })
  const g = roomy.create(roomy.root, 'g', 'file', 0o644, ROOT_CRED)
  roomy.write(g, 0, new Uint8Array(50))
  const used = roomy.usage().used
  assert.equal(errnoOf(() => roomy.write(g, 50, encode('x'))), 'EFBIG')
  assert.equal(errnoOf(() => roomy.write(g, 1000, encode('x'))), 'EFBIG')
  assert.equal(errnoOf(() => roomy.truncate(g, 51)), 'EFBIG')
  assert.equal(errnoOf(() => roomy.write(g, (1 << 20) * 2, encode('x'))), 'ENOSPC')
  assert.equal(roomy.stat(g).size, 50)
  assert.equal(roomy.usage().used, used)
  // No position before the start, none that is not a whole safe number.
  for (const at of [-1, 0.5, Number.MAX_SAFE_INTEGER + 2]) assert.equal(errnoOf(() => roomy.write(g, at, encode('x'))), 'EINVAL', String(at))
  assert.equal(errnoOf(() => roomy.read(g, -1, 1)), 'EINVAL')
  assert.equal(errnoOf(() => roomy.read(g, 0, -1)), 'EINVAL')
  assert.equal(errnoOf(() => roomy.read(roomy.root, 0, 1)), 'EISDIR')
  assert.equal(errnoOf(() => roomy.write(roomy.root, 0, encode('x'))), 'EISDIR')
  assert.equal(errnoOf(() => roomy.truncate(roomy.root, 0)), 'EISDIR')
})

test('memfs holds at most maxNodes nodes, the root among them', () => {
  const fs = new MemFs({ capacity: 1 << 20, maxFile: 100, maxNodes: 3, clock: () => 0 })
  fs.create(fs.root, 'a', 'file', 0o644, ROOT_CRED)
  fs.create(fs.root, 'b', 'dir', 0o755, ROOT_CRED)
  const version = fs.version
  assert.equal(errnoOf(() => fs.create(fs.root, 'c', 'file', 0o644, ROOT_CRED)), 'ENOSPC')
  assert.equal(fs.version, version)
  assert.equal(fs.usage().nodes, 3)
  fs.remove(fs.root, 'a')
  fs.create(fs.root, 'c', 'file', 0o644, ROOT_CRED)
  assert.deepEqual(fs.list(fs.root).map((e) => e.name).sort(), ['b', 'c'])
})

test('memfs charges a longer name before it moves anything, after giving back what a replaced name held', () => {
  const fs = new MemFs({ capacity: NODE_COST * 3 + 1 + 2 + 3, maxFile: 100, maxNodes: 10, clock: () => 0 })
  const a = fs.create(fs.root, 'a', 'file', 0o644, ROOT_CRED)
  const bb = fs.create(fs.root, 'bb', 'file', 0o644, ROOT_CRED)
  fs.write(bb, 0, encode('xyz'))
  assert.equal(fs.usage().used, fs.usage().capacity)
  const version = fs.version
  assert.equal(errnoOf(() => fs.rename(fs.root, 'a', fs.root, 'aa')), 'ENOSPC')
  assert.equal(fs.version, version)
  assert.equal(fs.lookup(fs.root, 'a'), a)
  // Onto bb, whose node, name and bytes are given back first: it fits.
  fs.rename(fs.root, 'a', fs.root, 'bb')
  assert.equal(fs.lookup(fs.root, 'bb'), a)
  assert.equal(fs.usage().used, NODE_COST * 2 + 2)
  // The driver refuses on its own what the layer above would: a bad name, a missing one, a directory into itself.
  const own = new MemFs({ capacity: 1 << 20, maxFile: 100, maxNodes: 10, clock: () => 0 })
  own.create(own.root, 'bb', 'file', 0o644, ROOT_CRED)
  const d = own.create(own.root, 'd', 'dir', 0o755, ROOT_CRED)
  const e = own.create(d, 'e', 'dir', 0o755, ROOT_CRED)
  assert.equal(errnoOf(() => own.rename(own.root, 'd', e, 'd')), 'EINVAL')
  assert.equal(errnoOf(() => own.rename(own.root, 'd', d, 'x')), 'EINVAL')
  assert.equal(errnoOf(() => own.rename(own.root, 'none', own.root, 'x')), 'ENOENT')
  assert.equal(errnoOf(() => own.rename(own.root, 'bb', own.root, 'x'.repeat(256))), 'ENAMETOOLONG')
  for (const bad of ['', '.', '..', 'a/b', 'a\0b']) assert.equal(errnoOf(() => own.rename(own.root, 'bb', own.root, bad)), 'EINVAL', JSON.stringify(bad))
  assert.equal(errnoOf(() => own.lookup(own.lookup(own.root, 'bb'), 'x')), 'ENOTDIR')
})

test('memfs refuses a name it could not keep: empty, a dot or two, a slash, a NUL, too long, or text that is not whole', () => {
  const fs = new MemFs({ capacity: 1 << 20, maxFile: 100, maxNodes: 100, clock: () => 0 })
  const make = (name: string): string | null => errnoOf(() => fs.create(fs.root, name, 'file', 0o644, ROOT_CRED))
  for (const bad of ['', '.', '..', 'a/b', 'a\0b']) assert.equal(make(bad), 'EINVAL', JSON.stringify(bad))
  assert.equal(make('x'.repeat(256)), 'ENAMETOOLONG')
  // Half a surrogate pair cannot be written as UTF-8: two such names would come back from the image as one.
  for (const bad of ['a\uD800', 'a\uDBFF', '\uDC00b', 'x\uDC00\uD800y']) assert.equal(make(bad), 'EINVAL', JSON.stringify(bad))
  const ok = fs.create(fs.root, 'ok', 'file', 0o644, ROOT_CRED)
  assert.equal(errnoOf(() => fs.rename(fs.root, 'ok', fs.root, 'a\uD800')), 'EINVAL')
  assert.equal(fs.lookup(fs.root, 'ok'), ok)
  assert.equal(make('ok'), 'EEXIST')
  // Whole text of any kind is fine, and comes back from the image exactly.
  const good = ['😀 face', '�', 'été', 'x'.repeat(255), '中'.repeat(255), ' lead and trail ', '-n', '*?[']
  for (const name of good) assert.equal(make(name), null, JSON.stringify(name))
  const back = new MemFs({ capacity: 1 << 20, maxFile: 100, maxNodes: 100, clock: () => 0 })
  restore(dump(fs), back)
  assert.deepEqual(back.list(back.root).map((e) => e.name).sort(), fs.list(fs.root).map((e) => e.name).sort())
})

test('memfs counts every change and nothing else, so the disk is saved when it changed and only then', () => {
  const fs = new MemFs({ capacity: 4096, maxFile: 4096, maxNodes: 10, clock: () => 7 })
  const v = (): number => fs.version
  let last = v()
  const changed = (what: string): void => {
    assert.ok(v() > last, what)
    last = v()
  }
  const same = (what: string): void => assert.equal(v(), last, what)
  const f = fs.create(fs.root, 'f', 'file', 0o644, ROOT_CRED)
  changed('create')
  fs.stat(f)
  fs.list(fs.root)
  fs.lookup(fs.root, 'f')
  fs.read(f, 0, 10)
  fs.usage()
  same('reading')
  errnoOf(() => fs.create(fs.root, 'f', 'file', 0o644, ROOT_CRED))
  errnoOf(() => fs.write(f, 0, new Uint8Array(5000)))
  errnoOf(() => fs.remove(fs.root, 'none'))
  errnoOf(() => fs.rename(fs.root, 'f', fs.root, ''))
  same('refusals')
  fs.write(f, 0, encode('x'))
  changed('write')
  fs.truncate(f, 0)
  changed('truncate')
  fs.setattr(f, { mode: 0o600 })
  changed('setattr')
  fs.rename(fs.root, 'f', fs.root, 'f')
  same('a move onto itself')
  fs.rename(fs.root, 'f', fs.root, 'g')
  changed('rename')
  fs.remove(fs.root, 'g')
  changed('remove')
  fs.wipe()
  changed('wipe')
  assert.equal(fs.stat(fs.root).mtime, 7)
  // The system hands the host an image only when its disk changed: not for reading, not for /tmp, not for a refused write.
  const k = boot({}, { diskBytes: 64 << 10 })
  assert.notEqual(k.system.snapshot(), null)
  assert.equal(k.system.snapshot(), null)
  assert.equal(k.system.dirty, false)
  k.read('/etc/hostname')
  k.write('/tmp/scratch', 'not the disk')
  assert.equal(errnoOf(() => now(k.system.kernel.vfs.writeFile('/etc/hostname', '/', ROOT_CRED, new Uint8Array(65 << 10), { append: true }))), 'ENOSPC')
  assert.equal(k.system.snapshot(), null)
  now(k.system.kernel.vfs.chmod('/etc/hostname', '/', ROOT_CRED, 0o600))
  assert.equal(k.system.dirty, true)
  const image = k.system.snapshot()
  assert.ok(image !== null)
  const back = new MemFs({ capacity: 64 << 10, maxFile: 64 << 10, maxNodes: 100, clock: () => 0 })
  restore(image, back)
  assert.equal(back.stat(back.lookup(back.lookup(back.root, 'etc'), 'hostname')).mode, 0o600)
})

test('memfs: a wiped disk keeps only its root, a sealed one says it is read-only, and a forgotten number finds nothing', () => {
  const { fs, vfs } = bare()
  put(vfs, '/f', 'gone soon')
  const h = now(vfs.open('/f', '/', ROOT_CRED, O_READ))
  const used = fs.usage().used
  now(vfs.unlink('/f', '/', ROOT_CRED))
  // The name and its bytes are given back at once; the descriptor finds nothing behind it.
  assert.equal(fs.usage().used, used - NODE_COST - 1 - 9)
  assert.equal(refusal(h.read(5)), 'ENOENT')
  assert.match(reasonOf(h.read(5)), /stale file handle/)
  h.close()
  now(vfs.mkdir('/d', '/', ROOT_CRED))
  put(vfs, '/d/x', 'x')
  const ino = now(vfs.stat('/d/x', '/', ROOT_CRED)).ino
  fs.wipe()
  assert.deepEqual(names(vfs, '/'), [])
  assert.deepEqual(fs.usage(), { capacity: 1 << 20, used: NODE_COST, nodes: 1 })
  assert.equal(errnoOf(() => fs.stat(ino)), 'ENOENT')
  // A number is never handed out twice, even after a wipe.
  put(vfs, '/new', '')
  assert.ok(now(vfs.stat('/new', '/', ROOT_CRED)).ino > ino)
  assert.equal(fs.readOnly, false)
  fs.seal()
  assert.equal(fs.readOnly, true)
  assert.equal(refusal(vfs.writeFile('/new', '/', ROOT_CRED, encode('x'))), 'EROFS')
  assert.equal(fs.type, 'memfs')
})

// Generated files: synth.ts.

/** A file system with a generated tree at /s over the memory root. */
function synthAt(top: SynthDir): { vfs: Vfs; sfs: SynthFs } {
  const { vfs } = bare()
  now(vfs.chmod('/', '/', ROOT_CRED, 0o755))
  now(vfs.mkdir('/s', '/', ROOT_CRED))
  const sfs = new SynthFs('test', top, () => 42)
  now(vfs.mount('/s', sfs, 'test', ROOT_CRED))
  return { vfs, sfs }
}

test('a generated file is made once, on the first read, so small reads see one text; the next open sees the next', () => {
  let made = 0
  const { vfs, sfs } = synthAt(dir({ n: text(() => `reading ${++made}\n${'line\n'.repeat(5)}`) }))
  const h = now(vfs.open('/s/n', '/', ROOT_CRED, O_READ))
  assert.equal(made, 0)
  // Before the first read the file has no length, as such files have none.
  assert.equal(now(h.seek(0, 2)), 0)
  let all = ''
  for (;;) {
    const piece = now(h.read(3))
    if (piece.length === 0) break
    assert.ok(piece.length <= 3)
    all += decode(piece)
  }
  assert.equal(all, `reading 1\n${'line\n'.repeat(5)}`)
  assert.equal(made, 1)
  // Seeking moves through the same text; the end is now its length.
  assert.equal(now(h.seek(0, 2)), all.length)
  assert.equal(now(h.seek(8, 0)), 8)
  assert.equal(decode(now(h.read(4))), '1\nli')
  assert.equal(made, 1)
  h.close()
  assert.equal(get(vfs, '/s/n').split('\n')[0], 'reading 2')
  // The driver itself reads at an offset, from a text made afresh each time.
  const ino = sfs.lookup(sfs.root, 'n')
  const piece = sfs.read(ino, 8, 3)
  assert.ok(piece instanceof Uint8Array)
  assert.equal(decode(piece), '3\nl')
  const past = sfs.read(ino, 1000, 3)
  assert.ok(past instanceof Uint8Array)
  assert.equal(past.length, 0)
})

test('a generated file longer than GENERATED_MAX is cut there', () => {
  const { vfs } = synthAt(dir({ huge: text(() => 'x'.repeat(GENERATED_MAX + 10)), bytes: { kind: 'file', read: () => new Uint8Array(GENERATED_MAX * 2) } }))
  assert.equal(now(vfs.readFile('/s/huge', '/', ROOT_CRED)).length, GENERATED_MAX)
  assert.equal(now(vfs.readFile('/s/bytes', '/', ROOT_CRED)).length, GENERATED_MAX)
})

test('a reading that answers later: the reader waits for it, gets it whole, or gets its refusal', () => {
  const later = new Later<string>()
  const { vfs } = synthAt(dir({ late: { kind: 'file', read: () => later } }))
  const t = vfs.readFile('/s/late', '/', ROOT_CRED)
  const first = t.next()
  if (first.done === true) assert.fail('the read did not wait')
  assert.equal(first.value.ready(), false)
  later.resolve('arrived\n')
  const last = t.next()
  assert.equal(last.done, true)
  if (last.done === true) assert.equal(decode(last.value), 'arrived\n')
  // At the prompt: cat waits without holding anything up, and prints when the answer comes.
  const answer = new Later<string>()
  const refused = new Later<string>()
  const k = boot(FILE_PROGRAMS, { proc: { late: { kind: 'file', read: () => answer }, gone: { kind: 'file', read: () => refused } } })
  assert.deepEqual(k.sh('cat /proc/late; echo after'), [])
  answer.resolve('arrived\n')
  assert.deepEqual(k.settle(), ['arrived', 'after'])
  assert.deepEqual(k.sh('cat /proc/gone; echo $?'), [])
  refused.reject(new OsError('EIO', 'the reading did not come'))
  assert.deepEqual(k.settle(), ['!cat: /proc/gone: the reading did not come', '1'])
})

test('Ctrl+C while a reading has not answered ends the reader and closes its file; the answer that comes later goes nowhere', () => {
  const answer = new Later<string>()
  const k = boot(FILE_PROGRAMS, { proc: { late: { kind: 'file', read: () => answer } } })
  const proc = mountAt(k.system.kernel.vfs, '/proc')
  assert.deepEqual(k.sh('cat /proc/late; echo after'), [])
  assert.equal(proc.opens, 1)
  assert.equal(k.system.interrupt(), true)
  k.settle()
  assert.equal(proc.opens, 0)
  answer.resolve('too late\n')
  assert.deepEqual(k.settle(), [])
  assert.deepEqual(k.sh('echo still here'), ['still here'])
})

test('a knob takes the written value with its line end trimmed, may refuse it, judges by who writes, and may answer later', () => {
  let value = 'day'
  const writers: number[] = []
  const slow = new Later<void>()
  const mode: SynthFile = knob(() => `${value}\n`, (v, cred) => {
    writers.push(cred.uid)
    if (v !== 'day' && v !== 'night') refuse('EINVAL', 'day or night')
    value = v
  })
  const open: SynthFile = knob(() => 'open\n', (_v, cred) => { if (cred.uid !== 0) refuse('EPERM', 'only user 0 sets this') }, 0o666)
  const { vfs } = synthAt(dir({ mode, open, fixed: text(() => 'fixed\n'), slow: { kind: 'file', read: () => '', write: () => slow } }))
  put(vfs, '/s/mode', '  night \n')
  assert.equal(value, 'night')
  assert.equal(get(vfs, '/s/mode'), 'night\n')
  assert.equal(refusal(vfs.writeFile('/s/mode', '/', ROOT_CRED, encode('noon\n'))), 'EINVAL')
  assert.match(reasonOf(vfs.writeFile('/s/mode', '/', ROOT_CRED, encode('noon\n'))), /day or night/)
  assert.equal(value, 'night')
  // Its bits come first: 0o644 by default, so a user cannot write it at all and the handler never hears.
  assert.equal(now(vfs.stat('/s/mode', '/', ROOT_CRED)).mode, 0o644)
  assert.equal(refusal(vfs.writeFile('/s/mode', '/', USER, encode('day'))), 'EACCES')
  assert.deepEqual(writers, [0, 0, 0])
  // A knob anyone may open still judges by the writer.
  assert.equal(refusal(vfs.writeFile('/s/open', '/', USER, encode('x'))), 'EPERM')
  put(vfs, '/s/open', 'x')
  // A reading takes no value, even from user 0.
  assert.equal(now(vfs.stat('/s/fixed', '/', ROOT_CRED)).mode, 0o444)
  assert.match(reasonOf(vfs.writeFile('/s/fixed', '/', ROOT_CRED, encode('x'))), /this reading cannot be set/)
  assert.equal(get(vfs, '/s/fixed'), 'fixed\n')
  // A value that is set later: the writer waits for it.
  const t = vfs.writeFile('/s/slow', '/', ROOT_CRED, encode('1'))
  assert.equal(t.next().done, false)
  slow.resolve(undefined)
  assert.equal(t.next().done, true)
  // At the prompt.
  let city = 'day'
  const setCity = (v: string): void => {
    if (v !== 'day' && v !== 'night') refuse('EINVAL', 'day or night')
    city = v
  }
  const k = boot(FILE_PROGRAMS, { sys: { mode: knob(() => `${city}\n`, setCity) } })
  const out = k.sh('echo noon > /sys/mode; echo $?; cat /sys/mode; echo night > /sys/mode; cat /sys/mode')
  assert.equal(out.length, 4)
  assert.match(out[0], /^!.*: day or night$/)
  assert.deepEqual(out.slice(1), ['1', 'day', 'night'])
})

test('a generated tree: nothing is made, removed, moved or re-moded in it, and its bits and kinds are as described', () => {
  const stream: SynthStream = { kind: 'stream', read: (length) => new Uint8Array(Math.min(length, 4)).fill(1), write: (data) => data.length }
  const top = dir({ r: text(() => 'r\n'), k: knob(() => '', () => {}), m: text(() => '', 0o400), d: dir({}), s: stream })
  const { vfs, sfs } = synthAt(top)
  const calls: Task<unknown>[] = [
    vfs.mkdir('/s/new', '/', ROOT_CRED), vfs.writeFile('/s/new', '/', ROOT_CRED, encode('x')), vfs.unlink('/s/r', '/', ROOT_CRED),
    vfs.rmdir('/s/d', '/', ROOT_CRED), vfs.rename('/s/r', '/s/q', '/', ROOT_CRED), vfs.chmod('/s/r', '/', ROOT_CRED, 0o777),
    vfs.chown('/s/r', '/', ROOT_CRED, 1, 1), vfs.utime('/s/r', '/', ROOT_CRED, 1),
  ]
  for (const call of calls) assert.equal(refusal(call), 'EPERM')
  // Someone who is not user 0 may not even ask: the directories are 0o555.
  assert.equal(refusal(vfs.writeFile('/s/new', '/', USER, encode('x'))), 'EACCES')
  const modes = Object.fromEntries(['r', 'k', 'm', 'd', 's'].map((n) => [n, now(vfs.stat(`/s/${n}`, '/', ROOT_CRED)).mode]))
  assert.deepEqual(modes, { r: 0o444, k: 0o644, m: 0o400, d: 0o555, s: 0o666 })
  assert.equal(refusal(vfs.readFile('/s/m', '/', USER)), 'EACCES')
  const st = now(vfs.stat('/s/r', '/', ROOT_CRED))
  assert.deepEqual([st.size, st.uid, st.mtime, st.nlink], [0, 0, 42, 1])
  assert.deepEqual(now(vfs.list('/s', '/', ROOT_CRED)).map((e) => `${e.name}:${e.kind}`), ['d:dir', 'k:file', 'm:file', 'r:file', 's:stream'])
  assert.equal(refusal(vfs.open('/s/d', '/', ROOT_CRED, O_READ)), 'EISDIR')
  assert.equal(refusal(vfs.stat('/s/r/x', '/', ROOT_CRED)), 'ENOTDIR')
  assert.equal(refusal(vfs.stat('/s/none', '/', ROOT_CRED)), 'ENOENT')
  // A fixed directory finds only its own children, never a name every object answers to.
  for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) assert.equal(refusal(vfs.stat(`/s/${name}`, '/', ROOT_CRED)), 'ENOENT', name)
  assert.equal(sfs.usage().capacity, 0)
  // A stream has no position and is asked afresh on every read.
  const h = now(vfs.open('/s/s', '/', ROOT_CRED, O_READ | O_WRITE))
  assert.deepEqual([...now(h.read(10))], [1, 1, 1, 1])
  assert.deepEqual([...now(h.read(2))], [1, 1])
  assert.equal(refusal(h.seek(0, 0)), 'ESPIPE')
  assert.equal(refusal(h.truncate(0)), 'EINVAL')
  assert.equal(now(h.write(encode('abc'))), 3)
  h.close()
})

test('a generated tree forgets the numbers of paths that lead nowhere, and refuses to remember too many that do', () => {
  const live = new Set<string>()
  const top: SynthDir = { kind: 'dir', names: () => [...live], child: (name) => (live.has(name) ? text(() => `${name}\n`) : null) }
  const sfs = new SynthFs('test', top, () => 0)
  live.add('keep')
  const keep = sfs.lookup(sfs.root, 'keep')
  assert.equal(sfs.lookup(sfs.root, 'keep'), keep)
  // Ten thousand names come and go: their numbers are forgotten as the table fills, the live one is kept.
  for (let i = 0; i < 10000; i++) {
    live.add(`n${i}`)
    sfs.lookup(sfs.root, `n${i}`)
    live.delete(`n${i}`)
  }
  assert.ok(sfs.usage().nodes <= 8192)
  assert.equal(sfs.lookup(sfs.root, 'keep'), keep)
  // A number whose path leads nowhere finds nothing; it stands for the path, so the name coming back finds it again.
  live.add('back')
  const back = sfs.lookup(sfs.root, 'back')
  live.delete('back')
  assert.equal(errnoOf(() => sfs.stat(back)), 'ENOENT')
  assert.equal(errnoOf(() => sfs.read(back, 0, 1)), 'ENOENT')
  live.add('back')
  assert.equal(sfs.lookup(sfs.root, 'back'), back)
  // A name the directory lists but cannot find is left out of the listing.
  const ghost = new SynthFs('test', { kind: 'dir', names: () => ['real', 'ghost'], child: (name) => (name === 'real' ? text(() => '') : null) }, () => 0)
  assert.deepEqual(ghost.list(ghost.root).map((e) => e.name), ['real'])
  // 8191 live names besides the top are remembered; one more is refused by name.
  const full = new SynthFs('test', top, () => 0)
  live.clear()
  for (let i = 0; i < 8192; i++) live.add(`m${i}`)
  for (let i = 0; i < 8191; i++) full.lookup(full.root, `m${i}`)
  assert.equal(errnoOf(() => full.lookup(full.root, 'm8191')), 'ENOMEM')
  assert.match(messageOf(() => full.lookup(full.root, 'm8191')), /too many names/)
})

// /proc and /dev.

test('/proc: a directory per task, self for whoever reads, and the kernel\'s own mounts, uptime and version', () => {
  const k = boot(FILE_PROGRAMS)
  const vfs = k.system.kernel.vfs
  assert.deepEqual(k.sh('cat /proc/version'), ['Crimson Noir OS test'])
  assert.deepEqual(k.sh('cat /proc/mounts'), [
    'disk / diskfs rw', 'rom /bin romfs ro', 'rom /usr romfs ro', 'tmpfs /tmp tmpfs rw', 'devfs /dev devfs rw', 'proc /proc proc rw', 'sysfs /sys sysfs rw',
  ])
  const line = 'cat /proc/self/cmdline /proc/self/cwd /proc/1/cmdline'
  assert.deepEqual(k.sh(line), [line, '/home/operator', 'init'])
  const status = k.sh('cat /proc/self/status')
  assert.match(status[0], /^Name:\s+cat$/)
  assert.ok(status.some((l) => /^State:\s+R \(running\)$/.test(l)), status.join('|'))
  assert.ok(status.some((l) => /^Uid:\s+0$/.test(l)), status.join('|'))
  assert.deepEqual(k.sh('ls /proc/self/fd'), ['0  1  2'])
  assert.equal(get(vfs, '/proc/1/fd/0'), 'tty\n')
  k.tick(1500)
  assert.equal(get(vfs, '/proc/uptime'), '1.50\n')
  // Outside any task there is no self, and a task's environment is its owner's alone to read.
  assert.equal(refusal(vfs.stat('/proc/self', '/', ROOT_CRED)), 'ENOENT')
  assert.equal(now(vfs.stat('/proc/1/environ', '/', ROOT_CRED)).mode, 0o400)
  assert.equal(refusal(vfs.readFile('/proc/1/environ', '/', USER)), 'EACCES')
  assert.match(get(vfs, '/proc/2/environ'), /^HOME=\/home\/operator$/m)
  // A directory for every task in the table, and none for a number that is not one; read from outside a task, no self.
  const listed = names(vfs, '/proc')
  assert.ok(listed.includes('1') && listed.includes('mounts') && !listed.includes('self'), listed.join(' '))
  assert.ok(k.sh('ls /proc')[0].split(/\s+/).includes('self'))
  const pids = listed.filter((n) => /^[0-9]+$/.test(n)).map(Number).sort((a, b) => a - b)
  assert.deepEqual(pids, k.system.kernel.ps().map((p) => p.pid))
  assert.equal(refusal(vfs.stat('/proc/999', '/', ROOT_CRED)), 'ENOENT')
})

test('/proc names each task one way only, and a reading the host names like one of the kernel\'s is not listed twice', () => {
  const k = boot(FILE_PROGRAMS, { proc: { self: text(() => 'host\n'), mounts: text(() => 'host\n'), city: text(() => 'city\n') } })
  const vfs = k.system.kernel.vfs
  assert.equal(now(vfs.stat('/proc/1', '/', ROOT_CRED)).kind, 'dir')
  for (const path of ['/proc/01', '/proc/001', '/proc/1/fd/00', '/proc/1/fd/01', '/proc/+1', '/proc/1.0']) {
    assert.equal(refusal(vfs.stat(path, '/', ROOT_CRED)), 'ENOENT', path)
  }
  const out = k.sh('ls /proc')
  assert.equal(out.length, 1)
  const listed = out[0].split(/\s+/)
  assert.equal(listed.filter((n) => n === 'self').length, 1)
  assert.equal(listed.filter((n) => n === 'mounts').length, 1)
  assert.ok(listed.includes('city'))
  assert.match(k.sh('cat /proc/mounts')[0], /^disk \/ diskfs rw$/)
  for (const name of ['constructor', '__proto__', 'toString']) assert.equal(refusal(vfs.stat(`/proc/${name}`, '/', ROOT_CRED)), 'ENOENT', name)
  assert.deepEqual(k.sh('cat /proc/city'), ['city'])
})

test('/dev: null holds nothing, zero gives zeros, full refuses every write, random needs a source, tty is the terminal', () => {
  const k = boot({})
  const vfs = k.system.kernel.vfs
  assert.equal(now(vfs.readFile('/dev/null', '/', ROOT_CRED)).length, 0)
  put(vfs, '/dev/null', 'gone')
  const zero = now(vfs.open('/dev/zero', '/', ROOT_CRED, O_READ))
  assert.deepEqual([...now(zero.read(5))], [0, 0, 0, 0, 0])
  // One read hands back at most 64 KiB, however much is asked.
  assert.equal(now(zero.read(1 << 20)).length, 65536)
  assert.equal(now(zero.read(0)).length, 0)
  assert.equal(refusal(zero.seek(0, 0)), 'ESPIPE')
  assert.equal(now(zero.stat()).kind, 'stream')
  zero.close()
  put(vfs, '/dev/zero', 'taken')
  assert.equal(refusal(vfs.writeFile('/dev/full', '/', ROOT_CRED, encode('x'))), 'ENOSPC')
  const full = now(vfs.open('/dev/full', '/', ROOT_CRED, O_READ))
  assert.deepEqual([...now(full.read(3))], [0, 0, 0])
  full.close()
  assert.equal(refusal(vfs.readFile('/dev/random', '/', ROOT_CRED)), 'EIO')
  assert.match(reasonOf(vfs.readFile('/dev/urandom', '/', ROOT_CRED)), /no random source/)
  assert.equal(now(vfs.stat('/dev/random', '/', ROOT_CRED)).mode, 0o444)
  assert.equal(refusal(vfs.writeFile('/dev/random', '/', ROOT_CRED, encode('x'))), 'EACCES')
  assert.equal(refusal(vfs.writeFile('/dev/null', '/', USER, encode('x'))), null)
  assert.equal(refusal(vfs.writeFile('/dev/random', '/', USER, encode('x'))), 'EACCES')
  // The terminal: written straight to the screen; read by nobody outside a task.
  put(vfs, '/dev/tty', 'to the screen\n')
  assert.deepEqual(k.settle(), ['to the screen'])
  const tty = now(vfs.open('/dev/tty', '/', ROOT_CRED, O_READ))
  assert.equal(now(tty.read(10)).length, 0)
  tty.close()
  assert.equal(mountAt(vfs, '/dev').opens, 0)
  // With a source, random gives what the source gives, at most 64 KiB a read.
  let asked = 0
  const seeded = boot({}, { entropy: (bytes) => { asked++; bytes.fill(7) } })
  const r = now(seeded.system.kernel.vfs.open('/dev/urandom', '/', ROOT_CRED, O_READ))
  assert.deepEqual([...now(r.read(4))], [7, 7, 7, 7])
  assert.equal(now(r.read(1 << 20)).length, 65536)
  r.close()
  assert.equal(asked, 2)
})
