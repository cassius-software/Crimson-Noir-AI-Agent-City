// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It tests the disk's image (image.ts), the bytes the host keeps between visits: that every
 * kind of tree comes back exactly (empty files, every byte value, deep trees, permission bits, owners, times, many
 * nodes), that the layout is the one the file describes (built here by hand, apart from the code), and that every
 * image that is corrupt or was made to do harm is refused whole: cut short at every length, any byte changed, a wrong
 * header or version, a count or a length that lies, a name with a slash or a dot or two, a node inside a file or
 * inside a later node, more than the disk may hold. A refused image must leave the disk empty, its root as it was.
 * What breaks if it is removed? A change to the image could lose a person's files between visits, or let one bad
 * save leave half a disk behind, and nothing would say so until a person came back to find their files gone.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { concat, encode, hex, writeU32 } from './bytes.ts'
import { OsError } from './errno.ts'
import { ROOT_CRED } from './fs.ts'
import type { Stat } from './fs.ts'
import { SEAL_BYTES, dump, dumpBody, restore, sealed } from './image.ts'
import { MemFs, NODE_COST } from './memfs.ts'
import type { MemFsOptions } from './memfs.ts'
import { sha256 } from './sha.ts'

const MAGIC = 'CNDISK1\n'

/** A disk in memory, roomy unless told otherwise; its clock says 1000. */
const disk = (opts: Partial<MemFsOptions> = {}): MemFs => new MemFs({ capacity: 64 << 20, maxFile: 8 << 20, maxNodes: 65536, clock: () => 1000, ...opts })

const dir = (fs: MemFs, parent: number, name: string): number => fs.create(parent, name, 'dir', 0o755, ROOT_CRED)

function file(fs: MemFs, parent: number, name: string, data: Uint8Array | string = ''): number {
  const ino = fs.create(parent, name, 'file', 0o644, ROOT_CRED)
  const bytes = typeof data === 'string' ? encode(data) : data
  if (bytes.length > 0) fs.write(ino, 0, bytes)
  return ino
}

/** Every node of a disk, one line each, sorted: path, kind, permission bits, owner, time, and a file's length and digest. */
function listing(fs: MemFs): string[] {
  const out: string[] = []
  const todo: [number, string][] = [[fs.root, '']]
  for (let next = todo.pop(); next !== undefined; next = todo.pop()) {
    const [ino, path] = next
    const st = fs.stat(ino)
    const body = st.kind === 'file' ? ` ${st.size} ${hex(sha256(fs.read(ino, 0, st.size)))}` : ''
    out.push(`${path === '' ? '/' : path} ${st.kind} ${st.mode.toString(8)} ${st.uid}:${st.gid} ${st.mtime}${body}`)
    if (st.kind === 'dir') for (const e of fs.list(ino)) todo.push([e.ino, `${path}/${e.name}`])
  }
  return out.sort()
}

/** Restores an image into a new disk and checks it holds what the first one did, and saves back to the same bytes. */
function roundTrip(fs: MemFs, opts: Partial<MemFsOptions> = {}): MemFs {
  const image = dump(fs)
  const back = disk(opts)
  restore(image, back)
  assert.deepEqual(listing(back), listing(fs))
  assert.deepEqual(dump(back), image)
  return back
}

/** One node as the image lays it out, every field open to a lie. */
interface Raw {
  kind?: number
  mode?: number
  uid?: number
  gid?: number
  mtime?: number
  parent?: number
  name?: string | Uint8Array
  /** Overrides the name's length as written. */
  nameLength?: number
  /** A file's bytes (a file is kind 2). */
  data?: Uint8Array
  /** Overrides the file's length as written. */
  size?: number
}

/** The image's body, built by hand from the layout image.ts describes: header, count, then each node. */
function body(nodes: readonly Raw[], count = nodes.length, magic = MAGIC): Uint8Array {
  const chunks: Uint8Array[] = [encode(magic)]
  const n = new Uint8Array(4)
  writeU32(n, 0, count)
  chunks.push(n)
  for (const node of nodes) {
    const name = typeof node.name === 'string' ? encode(node.name) : node.name ?? new Uint8Array(0)
    const head = new Uint8Array(25)
    const kind = node.kind ?? 1
    const mode = node.mode ?? 0o755
    head[0] = kind
    head[1] = mode & 255
    head[2] = (mode >> 8) & 255
    writeU32(head, 3, node.uid ?? 0)
    writeU32(head, 7, node.gid ?? 0)
    new DataView(head.buffer).setFloat64(11, node.mtime ?? 0, true)
    writeU32(head, 19, node.parent ?? 0)
    const length = node.nameLength ?? name.length
    head[23] = length & 255
    head[24] = (length >> 8) & 255
    chunks.push(head, name)
    if (kind === 2) {
      const data = node.data ?? new Uint8Array(0)
      const size = new Uint8Array(4)
      writeU32(size, 0, node.size ?? data.length)
      chunks.push(size, data)
    }
  }
  return concat(chunks)
}

/** A body with its seal after it: what an image that was made to do harm would look like. */
const seal = (b: Uint8Array): Uint8Array => concat([b, sha256(b)])
const build = (nodes: readonly Raw[], count?: number, magic?: string): Uint8Array => seal(body(nodes, count, magic))

const ROOT: Raw = { kind: 1, mode: 0o755, name: '' }

/** Fails unless a disk is empty: only its root, nothing charged beyond it, and the root as `root` says. */
function isEmpty(fs: MemFs, root: Stat, what: string): void {
  assert.deepEqual(fs.list(fs.root), [], what)
  assert.equal(fs.usage().used, NODE_COST, what)
  assert.equal(fs.usage().nodes, 1, what)
  const st = fs.stat(fs.root)
  assert.deepEqual([st.mode, st.uid, st.gid, st.mtime], [root.mode, root.uid, root.gid, root.mtime], `${what}: the root as it was`)
}

/** Restores an image that must be refused, as EINVAL; the disk is then empty and its root unchanged. The reason. */
function refused(image: Uint8Array, what: string, fs: MemFs = disk()): string {
  const root = fs.stat(fs.root)
  let reason: string | null = null
  try {
    restore(image, fs)
  } catch (e) {
    if (!(e instanceof OsError)) throw e
    assert.equal(e.errno, 'EINVAL', `${what}: ${e.message}`)
    reason = e.message
  }
  assert.ok(reason !== null, `${what}: restored`)
  isEmpty(fs, root, what)
  return reason
}

/** A small tree with a little of everything, for the tests that change images byte by byte. */
function small(): MemFs {
  const fs = disk()
  const etc = dir(fs, fs.root, 'etc')
  file(fs, etc, 'hostname', 'crimson-noir\n')
  const home = dir(fs, fs.root, 'home')
  const me = dir(fs, home, 'operator')
  file(fs, me, 'empty')
  file(fs, me, 'bytes', Uint8Array.of(0, 255, 10, 13, 128))
  fs.setattr(me, { mode: 0o700, uid: 1000, gid: 100, mtime: 1794679200000.5 })
  return fs
}

test('image: the layout is the one image.ts describes, node by node, and sealed with the SHA-256 of all before it', () => {
  const fs = disk()
  assert.deepEqual(dump(fs), build([{ ...ROOT, mtime: 1000 }]))
  const d = dir(fs, fs.root, 'd')
  const f = file(fs, d, 'f', 'hi')
  file(fs, fs.root, 'a')
  fs.setattr(f, { mode: 0o600, uid: 7, gid: 8, mtime: -1.5 })
  // A directory before what it holds, each directory's entries in the order of their names; a node names its directory by index.
  assert.deepEqual(dump(fs), build([
    { ...ROOT, mtime: 1000 },
    { kind: 2, mode: 0o644, mtime: 1000, parent: 0, name: 'a' },
    { kind: 1, mode: 0o755, mtime: 1000, parent: 0, name: 'd' },
    { kind: 2, mode: 0o600, uid: 7, gid: 8, mtime: -1.5, parent: 2, name: 'f', data: encode('hi') },
  ]))
  assert.equal(new TextDecoder().decode(dump(fs).subarray(0, 8)), MAGIC)
  // Making an image changes nothing on the disk.
  const version = fs.version
  dump(fs)
  assert.equal(fs.version, version)
})

test('image: every kind of tree comes back exactly, and saves back to the same bytes', () => {
  // Nothing at all, and the root's own attributes.
  const none = disk()
  roundTrip(none)
  none.setattr(none.root, { mode: 0o1777, uid: 4294967295, gid: 65536, mtime: 0 })
  roundTrip(none)

  const fs = disk()
  const files = dir(fs, fs.root, 'files')
  file(fs, files, 'empty')
  const all = new Uint8Array(256 * 3)
  for (let i = 0; i < all.length; i++) all[i] = (i * 7) & 255
  file(fs, files, 'every byte', all)
  const noisy = new Uint8Array(200000)
  let x = 12345
  for (let i = 0; i < noisy.length; i++) {
    x = (x * 1103515245 + 12345) % 2147483648
    noisy[i] = x & 255
  }
  file(fs, files, 'noise', noisy)
  // A file cut shorter keeps only what is left, whatever its array still holds.
  const cut = file(fs, files, 'cut', 'x'.repeat(1000))
  fs.truncate(cut, 10)
  // Names of every sort a file may have.
  for (const name of ['été', '\u{1f600} face', ' lead and trail ', '-n', '*?[', 'x'.repeat(255), '中'.repeat(255), '.hidden', '..dots', 'a\\b', '�']) {
    file(fs, files, name, name)
  }
  // Permission bits, owners and times at their edges.
  const modes = dir(fs, fs.root, 'modes')
  for (const [i, mode] of [0, 0o1777, 0o644, 0o700, 0o4755, 0o111].entries()) fs.setattr(file(fs, modes, `m${i}`), { mode })
  const owners = dir(fs, fs.root, 'owners')
  for (const [i, uid] of [0, 1, 1000, 65535, 65536, 2147483648, 4294967295].entries()) fs.setattr(file(fs, owners, `u${i}`), { uid, gid: 4294967295 - uid })
  const times = dir(fs, fs.root, 'times')
  for (const [i, mtime] of [0, -1, -1.5, 0.25, 1794679200000.125, 8.64e15, -8.64e15, Number.MAX_VALUE, Number.MIN_VALUE].entries()) {
    fs.setattr(file(fs, times, `t${i}`), { mtime })
  }
  // Deep: as deep as a path may go, a file at the bottom.
  let deep = dir(fs, fs.root, 'deep')
  for (let i = 0; i < 70; i++) deep = dir(fs, deep, `level${i}`)
  file(fs, deep, 'bottom', 'found')
  // Many: thousands of nodes across many directories.
  const many = dir(fs, fs.root, 'many')
  for (let d = 0; d < 40; d++) {
    const sub = dir(fs, many, `d${d}`)
    for (let f = 0; f < 100; f++) file(fs, sub, `f${f}`, f % 10 === 0 ? `${d}/${f}` : '')
  }
  // Directories' times are set last, so filling them did not move them.
  fs.setattr(times, { mtime: 5 })
  fs.setattr(fs.root, { mtime: 6, mode: 0o711 })
  const back = roundTrip(fs)
  assert.equal(back.usage().nodes, fs.usage().nodes)
  assert.equal(back.usage().used, fs.usage().used)
})

test('image: the same tree gives the same bytes whatever order it was built in', () => {
  const one = disk()
  const two = disk()
  const names = ['b', 'a', 'c', 'B', 'é', '10', '9', 'aa']
  for (const n of names) file(one, one.root, n, n)
  for (const n of [...names].reverse()) file(two, two.root, n, n)
  const d1 = dir(one, one.root, 'z')
  file(one, d1, 'y')
  const d2 = dir(two, two.root, 'z')
  file(two, d2, 'y')
  for (const fs of [one, two]) for (const e of fs.list(fs.root)) fs.setattr(e.ino, { mtime: 1 })
  for (const fs of [one, two]) fs.setattr(fs.root, { mtime: 1 })
  assert.deepEqual(dump(one), dump(two))
})

test('image: a tree far deeper than any path (renames can build one) is saved and comes back', () => {
  // Thirty thousand directories, one inside the next: the image is made without a call per level.
  const fs = disk()
  let at = fs.root
  for (let i = 0; i < 30000; i++) at = dir(fs, at, 'd')
  file(fs, at, 'bottom', 'still here')
  const back = disk()
  restore(dump(fs), back)
  let ino = back.root
  let depth = 0
  for (;;) {
    const entries = back.list(ino)
    assert.equal(entries.length, 1)
    if (entries[0].kind === 'file') break
    ino = entries[0].ino
    depth++
  }
  assert.equal(depth, 30000)
  const bottom = back.lookup(ino, 'bottom')
  assert.equal(new TextDecoder().decode(back.read(bottom, 0, 100)), 'still here')
})

test('image: cut short at every length, it is refused, and the disk is left empty', () => {
  const image = dump(small())
  for (let n = 0; n < image.length; n++) refused(image.subarray(0, n), `the first ${n} bytes`)
  // Cut and sealed again, as a hand that wanted it read would do: every cut is still refused.
  const b = image.subarray(0, image.length - 32)
  for (let n = 0; n < b.length; n++) refused(seal(b.subarray(0, n)), `the first ${n} bytes, sealed again`)
  // One byte more at the end, sealed or not.
  refused(concat([image, Uint8Array.of(0)]), 'a byte after the seal')
  assert.match(refused(seal(concat([b, Uint8Array.of(0)])), 'a byte after the last node'), /bytes left over/)
})

test('image: any byte changed is refused by the seal, and changed and sealed again it is refused cleanly or read whole', () => {
  const image = dump(small())
  for (let i = 0; i < image.length; i++) {
    for (const bit of [1, 128]) {
      const bad = image.slice()
      bad[i] ^= bit
      const why = refused(bad, `byte ${i} ^ ${bit}`)
      if (i >= MAGIC.length) assert.match(why, i < image.length - 32 ? /the seal does not match/ : /seal/, `byte ${i}`)
    }
  }
  // Sealed again, a changed byte is either a different image that is read whole, or refused with nothing left behind.
  const b = image.subarray(0, image.length - 32)
  let read = 0
  for (let i = 0; i < b.length; i++) {
    for (const bit of [1, 4, 128]) {
      const bad = b.slice()
      bad[i] ^= bit
      const fs = disk()
      const root = fs.stat(fs.root)
      try {
        restore(seal(bad), fs)
        read++
        // What came back is a disk like any other: it saves, and the save reads back the same.
        roundTrip(fs)
      } catch (e) {
        if (!(e instanceof OsError)) throw e
        assert.equal(e.errno, 'EINVAL', `byte ${i} ^ ${bit}: ${e.message}`)
        isEmpty(fs, root, `byte ${i} ^ ${bit}`)
      }
    }
  }
  // Bytes, bits, owners and times are free to change; the rest is checked.
  assert.ok(read > 0)
})

test('image: a wrong header or version is refused, sealed or not', () => {
  const image = dump(small())
  for (let i = 0; i < MAGIC.length; i++) {
    const bad = image.slice()
    bad[i] ^= 32
    assert.match(refused(bad, `header byte ${i}`), /^not a disk image \(wrong header\)$/)
    assert.match(refused(seal(bad.subarray(0, bad.length - 32)), `header byte ${i}, sealed`), /wrong header/)
  }
  for (const magic of ['CNDISK2\n', 'CNDISK0\n', 'cndisk1\n', 'CNDISK1\r', 'CNDISK1 ']) {
    assert.match(refused(build([ROOT], 1, magic), magic), /wrong header/, JSON.stringify(magic))
  }
  assert.match(refused(new Uint8Array(0), 'nothing'), /too short/)
  assert.match(refused(encode(MAGIC), 'a header alone'), /too short/)
  assert.match(refused(new Uint8Array(1000), 'zeros'), /wrong header/)
})

test('image: a count of nodes that lies is refused: too many, too few, none, or more than any image could hold', () => {
  const nodes: Raw[] = [ROOT, { kind: 2, mode: 0o644, parent: 0, name: 'f', data: encode('x') }, { kind: 1, parent: 0, name: 'd' }]
  restore(build(nodes), disk())
  assert.match(refused(build(nodes, 4), 'one more'), /cut short/)
  assert.match(refused(build(nodes, 2), 'one fewer'), /bytes left over/)
  assert.match(refused(build(nodes, 0), 'none'), /no root/)
  assert.match(refused(build([], 0), 'none and nothing'), /no root/)
  assert.match(refused(build(nodes, 4294967295), 'four billion'), /cut short/)
})

test('image: a length that lies is refused: a name or a file running past the end, or eating the next node', () => {
  const ok: Raw[] = [ROOT, { kind: 2, parent: 0, name: 'f', data: encode('abc') }, { kind: 2, parent: 0, name: 'g', data: encode('defg') }]
  restore(build(ok), disk())
  assert.match(refused(build([ROOT, { kind: 2, parent: 0, name: 'f', nameLength: 65535 }]), 'a name past the end'), /cut short/)
  assert.match(refused(build([ROOT, { kind: 2, parent: 0, name: 'f', data: encode('abc'), size: 4 }]), 'a file one past the end'), /cut short/)
  assert.match(refused(build([ROOT, { kind: 2, parent: 0, name: 'f', data: encode('abc'), size: 4294967295 }]), 'a file of four billion'), /cut short/)
  assert.match(refused(build([ROOT, { kind: 2, parent: 0, name: 'f', data: encode('abc'), size: 2 }]), 'a file one short'), /./)
  // A first file that claims the second as its bytes: the count then finds nothing where the second should be.
  const eating = body(ok)
  const at = eating.indexOf(102) + 1
  writeU32(eating, at, 3 + 25 + 1 + 4 + 4)
  assert.match(refused(seal(eating), 'a file that eats the next node'), /cut short/)
  // The root's name given a length, so the root's own bytes are read as its name.
  assert.match(refused(build([{ ...ROOT, nameLength: 3 }, { kind: 1, parent: 0, name: 'd' }]), 'a root that has a name'), /./)
})

test('image: a name that no file may have is refused: a slash, a dot or two, nothing, a NUL, too long, or twice in one place', () => {
  const nameOf = (name: string | Uint8Array): string => refused(build([ROOT, { kind: 2, mode: 0o644, parent: 0, name }]), JSON.stringify(name))
  for (const bad of ['a/b', '/', '/etc', '.', '..', '', 'a\0b', 'x'.repeat(256)]) nameOf(bad)
  assert.match(nameOf('.'), /not a name a file can have/)
  assert.match(nameOf('x'.repeat(256)), /name too long/)
  // A directory named twice, or a file and a directory of one name.
  assert.match(refused(build([ROOT, { kind: 1, parent: 0, name: 'd' }, { kind: 1, parent: 0, name: 'd' }]), 'twice'), /file exists/)
  assert.match(refused(build([ROOT, { kind: 2, parent: 0, name: 'd' }, { kind: 1, parent: 0, name: 'd' }]), 'a file and a directory'), /file exists/)
  // The same names in different directories are fine.
  const fs = disk()
  restore(build([ROOT, { kind: 1, parent: 0, name: 'd' }, { kind: 1, parent: 1, name: 'd' }, { kind: 2, parent: 2, name: 'd' }]), fs)
  assert.equal(fs.list(fs.lookup(fs.lookup(fs.root, 'd'), 'd'))[0].name, 'd')
  // Bytes that are no UTF-8 are read as U+FFFD, a name like any other; two such names in one place are one name twice.
  const odd = disk()
  restore(build([ROOT, { kind: 2, parent: 0, name: Uint8Array.of(0xff) }]), odd)
  assert.deepEqual(odd.list(odd.root).map((e) => e.name), ['�'])
  const twoOdd = build([ROOT, { kind: 2, parent: 0, name: Uint8Array.of(0xff) }, { kind: 2, parent: 0, name: Uint8Array.of(0xfe) }])
  assert.match(refused(twoOdd, 'two odd names'), /file exists/)
})

test('image: a node outside any directory is refused: inside itself, inside a later node, inside a file, or no root first', () => {
  const f: Raw = { kind: 2, parent: 0, name: 'f' }
  assert.match(refused(build([ROOT, { kind: 1, parent: 1, name: 'self' }]), 'inside itself'), /outside any directory/)
  assert.match(refused(build([ROOT, { kind: 1, parent: 2, name: 'a' }, { kind: 1, parent: 1, name: 'b' }]), 'a cycle'), /outside any directory/)
  assert.match(refused(build([ROOT, { kind: 1, parent: 4294967295, name: 'far' }]), 'far away'), /outside any directory/)
  assert.match(refused(build([ROOT, f, { kind: 2, parent: 1, name: 'g' }]), 'inside a file'), /outside any directory/)
  assert.match(refused(build([ROOT, f, { kind: 1, parent: 1, name: 'g' }]), 'a directory inside a file'), /outside any directory/)
  assert.match(refused(build([{ kind: 2, name: '' }]), 'a file first'), /the first node is not the root/)
  assert.match(refused(build([{ kind: 1, name: 'root' }]), 'a named first'), /the first node is not the root/)
  // The root's own directory index means nothing; a second root does not exist.
  restore(build([{ ...ROOT, parent: 12345 }]), disk())
  assert.match(refused(build([ROOT, { kind: 1, parent: 0, name: '' }]), 'a second root'), /not a name a file can have/)
})

test('image: a kind that is no kind, or a time that is no number, is refused', () => {
  for (const kind of [0, 3, 255]) assert.match(refused(build([ROOT, { kind, parent: 0, name: 'x' }]), `kind ${kind}`), /an unknown kind of node/)
  for (const mtime of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    assert.match(refused(build([ROOT, { kind: 2, parent: 0, name: 'x', mtime }]), `time ${mtime}`), /a time that is no number/)
    assert.match(refused(build([{ ...ROOT, mtime }]), `root time ${mtime}`), /a time that is no number/)
  }
  // Permission bits past what a node keeps are dropped, as the disk drops them from any program.
  const fs = disk()
  restore(build([ROOT, { kind: 2, parent: 0, name: 'x', mode: 0xffff }]), fs)
  assert.equal(fs.stat(fs.lookup(fs.root, 'x')).mode, 0o1777)
})

test('image: more than the disk may hold is refused by the disk itself, and nothing of it stays', () => {
  const big = disk()
  file(big, big.root, 'big', new Uint8Array(100000))
  const image = dump(big)
  assert.match(refused(image, 'a file past the largest', disk({ maxFile: 99999 })), /^not a disk image \(file too large\)$/)
  assert.match(refused(image, 'past the capacity', disk({ capacity: 100000 })), /^not a disk image \(no space left on device\)$/)
  const crowded = disk()
  for (let i = 0; i < 50; i++) file(crowded, crowded.root, `f${i}`)
  assert.match(refused(dump(crowded), 'too many nodes', disk({ maxNodes: 50 })), /no room for another file/)
  restore(dump(crowded), disk({ maxNodes: 51 }))
  // A hand-built image that claims a file far larger than it carries never gets as far as the disk.
  assert.match(refused(build([ROOT, { kind: 2, parent: 0, name: 'f', size: 1 << 30 }]), 'a lie about size'), /cut short/)
  // Many nodes that each cost little still run out of room by name.
  const nodes: Raw[] = [ROOT]
  for (let i = 0; i < 3000; i++) nodes.push({ kind: 1, parent: 0, name: `d${i}` })
  assert.match(refused(build(nodes), 'thousands of directories', disk({ capacity: 64 * 1000 })), /no space left on device/)
})

test('image: a disk that is not empty is refused and left as it was', () => {
  const fs = disk()
  file(fs, fs.root, 'mine', 'keep me')
  const before = listing(fs)
  assert.throws(() => restore(dump(small()), fs), (e: unknown) => e instanceof OsError && e.errno === 'EINVAL' && e.message === 'the disk is not empty')
  assert.deepEqual(listing(fs), before)
})

test('image: a refused image never changes the root, even one refused at its very last byte', () => {
  // The root's bits, owner and time are put back last; a refusal before that point leaves them as they were.
  const fs = disk()
  fs.setattr(fs.root, { mode: 0, uid: 1234, gid: 5678, mtime: 42 })
  file(fs, fs.root, 'f', 'x')
  const b = dump(fs).subarray(0, dump(fs).length - 32)
  const into = disk()
  into.setattr(into.root, { mode: 0o755, uid: 0, gid: 0, mtime: 7 })
  assert.match(refused(seal(concat([b, Uint8Array.of(1)])), 'a byte left over', into), /bytes left over/)
  const st = into.stat(into.root)
  assert.deepEqual([st.mode, st.uid, st.gid, st.mtime], [0o755, 0, 0, 7])
  // The same disk takes a good image afterwards.
  restore(dump(fs), into)
  assert.deepEqual(listing(into), listing(fs))
})

test('image: an image handed over as part of a larger array is read from its own first byte', () => {
  const image = dump(small())
  const larger = new Uint8Array(image.length + 21)
  larger.set(image, 13)
  const fs = disk()
  restore(larger.subarray(13, 13 + image.length), fs)
  assert.deepEqual(listing(fs), listing(small()))
})

test('image: the body and its seal can be made apart, so a host may seal with its own digest: the same bytes as a whole image', () => {
  const fs = small()
  const body = dumpBody(fs)
  const whole = dump(fs)
  assert.equal(SEAL_BYTES, 32)
  assert.equal(body.length, whole.length - SEAL_BYTES)
  assert.deepEqual(body, whole.subarray(0, body.length))
  assert.deepEqual(sealed(body, sha256(body)), whole)
  const into = disk()
  restore(sealed(body, sha256(body)), into)
  assert.deepEqual(listing(into), listing(fs))
  // Making the body changes nothing on the disk.
  const version = fs.version
  dumpBody(fs)
  assert.equal(fs.version, version)
  // A seal of any other length could never be checked, so it is refused rather than written; a wrong digest of the
  // right length makes an image that restore refuses.
  for (const length of [0, 31, 33, 64]) assert.throws(() => sealed(body, new Uint8Array(length)), RangeError, String(length))
  assert.throws(() => restore(sealed(body, new Uint8Array(SEAL_BYTES)), disk()), (e: unknown) => e instanceof OsError && e.errno === 'EINVAL')
})
