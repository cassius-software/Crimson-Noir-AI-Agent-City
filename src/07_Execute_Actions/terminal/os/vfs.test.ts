// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the file system (vfs.ts, over memfs.ts) to the promises the programs lean on:
 * a name that ends in a slash names a directory or nothing, no tree can be moved to where its deepest path would be
 * past the depth limit, and a file too big for the whole file system is out of space, not some other refusal.
 * What breaks if it is removed? `rm notes/` could remove a file again, a move could leave a tree nothing can reach
 * or remove, and a full disk could be reported as a file that is too large.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encode } from './bytes.ts'
import { OsError } from './errno.ts'
import { ROOT_CRED } from './fs.ts'
import { FILE_PROGRAMS } from './fileutils.ts'
import { boot } from './kit.test.ts'
import { DEPTH_MAX } from './path.ts'
import { now } from './task.ts'
import { O_CREATE, O_READ, O_WRITE } from './vfs.ts'

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
