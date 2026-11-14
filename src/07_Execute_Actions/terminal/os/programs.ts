// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the list of what /bin holds and what the manual says: every program of the
 * operating layer under the name it runs by, and every manual page under the name `man` finds it by, gathered from
 * the files that write them so the system is built with one table of each.
 * What breaks if it is removed? The system would start with an empty /bin and an empty manual.
 */
import type { Program } from './kernel.ts'

/** Every program, by the name it runs by. */
export const PROGRAMS: Readonly<Record<string, Program>> = Object.freeze({})

/** Every manual page, by name. */
export const MANUAL: Readonly<Record<string, string>> = Object.freeze({})
