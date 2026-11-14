// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one door into the console's operating layer for the rest of the page: the
 * system to build and hold, the shapes the host fills in (the city's commands, the readings under /proc and /sys,
 * a saved disk that arrives later), and the two questions the console asks of a typed line. Nothing else in the
 * folder is imported from outside it.
 * What breaks if it is removed? The console would reach into the layer's files one by one, and a change inside the
 * layer would break its callers.
 */
export { OsError } from './errno.ts'
export { hasOperator } from './parser.ts'
export { MANUAL, PROGRAMS } from './programs.ts'
export type { CityHost, CityLine, CityResult } from './shell.ts'
export { BUILTIN_NAMES } from './shell.ts'
export { dir, knob, text } from './synth.ts'
export type { SynthDir, SynthFile, SynthNode } from './synth.ts'
export { DISK_BYTES, HOME, System } from './system.ts'
export type { DiskState, SystemOptions } from './system.ts'
export { Later } from './task.ts'
export type { TtyEvent } from './tty.ts'
