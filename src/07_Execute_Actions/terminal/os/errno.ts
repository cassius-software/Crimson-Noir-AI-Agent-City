// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one list of the reasons a file-system or kernel call can be refused, each with
 * the short name a program tests for (ENOENT, EACCES ...) and the words a person reads ("no such file or directory"),
 * and the one error type that carries them. Every refusal inside the console's operating layer is an OsError; the
 * layer's public face turns it into a line of text, so nothing here ever reaches the host as a thrown exception.
 * What breaks if it is removed? The file system, the kernel, the shell and every program would each invent their own
 * failures, and no program could tell "not found" from "not allowed".
 */

/** The reasons a call is refused. The names follow the long-standing convention so a program reads as expected. */
export type Errno =
  | 'ENOENT' | 'EEXIST' | 'ENOTDIR' | 'EISDIR' | 'ENOTEMPTY' | 'EACCES' | 'EPERM' | 'EROFS' | 'EINVAL' | 'ENOSPC' | 'EFBIG'
  | 'ENAMETOOLONG' | 'EXDEV' | 'EBUSY' | 'EBADF' | 'EMFILE' | 'ENOSYS' | 'EIO' | 'EAGAIN' | 'EPIPE' | 'ESRCH' | 'ECHILD'
  | 'ENOEXEC' | 'E2BIG' | 'ENOTTY' | 'ESPIPE' | 'ENOMEM' | 'EINTR'

/** What each reason says to a person, in lower case, with no full stop (a program's name and the path go in front). */
export const ERRNO_TEXT: Readonly<Record<Errno, string>> = Object.freeze({
  ENOENT: 'no such file or directory',
  EEXIST: 'file exists',
  ENOTDIR: 'not a directory',
  EISDIR: 'is a directory',
  ENOTEMPTY: 'directory not empty',
  EACCES: 'permission denied',
  EPERM: 'operation not permitted',
  EROFS: 'read-only file system',
  EINVAL: 'invalid argument',
  ENOSPC: 'no space left on device',
  EFBIG: 'file too large',
  ENAMETOOLONG: 'name too long',
  EXDEV: 'cannot move across file systems',
  EBUSY: 'resource busy',
  EBADF: 'bad file descriptor',
  EMFILE: 'too many open files',
  ENOSYS: 'not supported here',
  EIO: 'input/output error',
  EAGAIN: 'resource not ready',
  EPIPE: 'broken pipe',
  ESRCH: 'no such task',
  ECHILD: 'no child tasks',
  ENOEXEC: 'not a program',
  E2BIG: 'argument list too long',
  ENOTTY: 'not a terminal',
  ESPIPE: 'cannot seek here',
  ENOMEM: 'out of memory',
  EINTR: 'interrupted',
})

/**
 * A refused call. `errno` is the reason a program tests; `detail`, when a driver has more to say than the reason's
 * own words (a tier that is locked, say), replaces them in the message a person reads.
 */
export class OsError extends Error {
  readonly errno: Errno
  constructor(errno: Errno, detail?: string) {
    super(detail ?? ERRNO_TEXT[errno])
    this.errno = errno
  }
}

/** Throws the refusal. */
export function refuse(errno: Errno, detail?: string): never {
  throw new OsError(errno, detail)
}

/** The words of anything thrown: an OsError's message, another error's message, or the value as text. */
export function reasonOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
