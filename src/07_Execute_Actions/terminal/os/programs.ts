// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the list of what /bin holds and what the manual says: every program of the
 * operating layer under the name it runs by, and every manual page under the name `man` finds it by, gathered from
 * the files that write them so the system is built with one table of each.
 * What breaks if it is removed? The system would start with an empty /bin and an empty manual.
 */
import { DIFF_MANUAL, DIFF_PROGRAMS } from './diff.ts'
import { FILE_MANUAL, FILE_PROGRAMS } from './fileutils.ts'
import { GREP_MANUAL, GREP_PROGRAMS } from './grep.ts'
import type { Program } from './kernel.ts'
import { OS_MANUAL } from './manual.ts'
import { SED_MANUAL, SED_PROGRAMS } from './sed.ts'
import { SYS_MANUAL, SYS_PROGRAMS } from './sysutils.ts'
import { TEXT_MANUAL, TEXT_PROGRAMS } from './textutils.ts'

/** The tables as the files write them, each under the name of its file (programs.test.ts checks none overlap). */
export const PROGRAM_TABLES: Readonly<Record<string, Readonly<Record<string, Program>>>> = Object.freeze({
  fileutils: FILE_PROGRAMS,
  textutils: TEXT_PROGRAMS,
  sysutils: SYS_PROGRAMS,
  diff: DIFF_PROGRAMS,
  grep: GREP_PROGRAMS,
  sed: SED_PROGRAMS,
})

/** The manual's tables as the files write them, each under the name of its file. */
export const MANUAL_TABLES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  manual: OS_MANUAL,
  fileutils: FILE_MANUAL,
  textutils: TEXT_MANUAL,
  sysutils: SYS_MANUAL,
  diff: DIFF_MANUAL,
  grep: GREP_MANUAL,
  sed: SED_MANUAL,
})

/** Every program, by the name it runs by. */
export const PROGRAMS: Readonly<Record<string, Program>> = Object.freeze(Object.assign({}, ...Object.values(PROGRAM_TABLES)))

/** Every manual page, by name. */
export const MANUAL: Readonly<Record<string, string>> = Object.freeze(Object.assign({}, ...Object.values(MANUAL_TABLES)))
