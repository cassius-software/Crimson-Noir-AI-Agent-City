// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of NoirScript's tables (terminal/noirscript), which Node
 * cannot run as a page: the engine's bridge hands the console one reader (`soa.tables`) that builds fresh copies of
 * the crowd's x and z, the cars' pose columns, the kernel's counters and the frame clock, and no writer of its own
 * (the writes a line may make are the elite tier's surface, operator.ts, handed to the VM only while that tier is
 * open, with the tier's own lock message otherwise); the offline stand-in has no columns at all (the console alone
 * runs NoirScript over empty tables); and the console reaches the VM only through its index module, which the bridge
 * names as a type alone.
 * What breaks if it is removed? The engine could hand the VM a live view of the realm, or a write, and only the
 * browser would show it.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { offlineBridge } from './terminal/bridge.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} … ${to}`)
  return src.slice(a, b)
}

test('engine: one reader on the bridge, building copies of the columns from the realm\'s newest reading, and no writer', () => {
  const src = read('./engine.ts')
  assert.match(src, /^import type \{ NoirTables \} from '\.\/terminal\/noirscript\/index\.ts'$/m, 'the engine names the tables as a type alone')
  const bridge = between(src, '  terminalBridge(gate: SkillGate', '  /** Control glyphs')
  assert.match(bridge, /^ {6}soa: Object\.freeze\(\{ tables: \(\) => this\.soaTables\(\) \}\),$/m)
  const method = between(src, '  private soaTables(): NoirTables {', '  private crowdStats(): CrowdStats {')
  // The crowd off the zero-copy bridge, split into two fresh arrays; the cars from the poses into fresh arrays.
  assert.match(method, /b\.agentXZ\(this\.crowdXZ\)/)
  assert.match(method, /crowdX = new Float32Array\(n\)/)
  assert.match(method, /crowdZ = new Float32Array\(n\)/)
  assert.match(method, /const x = new Float32Array\(cars\), z = new Float32Array\(cars\), heading = new Float32Array\(cars\), speed = new Float32Array\(cars\), mode = new Int32Array\(cars\)/)
  assert.match(method, /p\[o \+ POSE\.x\]/)
  assert.match(method, /p\[o \+ POSE\.speed\]/)
  assert.match(method, /p\[o \+ POSE\.mode\] \| 0/)
  assert.match(method, /mode\[i\] = m >= 0 && m <= 2 \? m : 0/, 'mode 0 ai, 1 player, 2 parked, nothing else')
  assert.match(method, /flips: k\.sensorFlips, shielded: k\.shielded/)
  assert.match(method, /frame: \{ fps: mean > 0 \? 1000 \/ mean : 0, ms: mean, p95 \}/)
  // Nothing in the reader reaches the realm's inbox or any knob: it reads, copies and returns.
  assert.doesNotMatch(method, /sim\.send|this\.tuning|setMode|intent|recover|teleport|governor|\.cull\(/)
  // The realm's own arrays are never returned: every array handed out is one made here.
  assert.doesNotMatch(method, /return (p|st\.poses|this\.crowdXZ)\b/)
  assert.doesNotMatch(method, /\.subarray\(/)
})

test('bridge: the surface is one reader; the offline stand-in has no columns; the console takes the VM from its index alone', () => {
  const bridge = read('./terminal/bridge.ts')
  assert.match(bridge, /^export interface SoaBridge \{\n {2}tables\(\): NoirTables\n\}$/m)
  assert.match(bridge, /^ {2}soa\?: SoaBridge$/m)
  assert.match(bridge, /^import type \{ NoirTables \} from '\.\/noirscript\/index\.ts'$/m)
  assert.equal(offlineBridge({ name: 'T', version: '0', host: 't' }).soa, undefined)
  const commands = read('./terminal/commands.ts')
  assert.match(commands, /^import \{ ELITE_LIMITS, EMPTY_TABLES, NoirSession, type NoirHost, type NoirTables \} from '\.\/noirscript\/index\.ts'$/m)
  // The host the console builds for a run carries the tables, the elite tier's writes while that tier is open (and
  // only then the raised limits), and the tier's own lock message; nothing else of the bridge reaches the VM.
  const handler = between(commands, '  noir(args, b, _history, _line, session) {', '  // ---- the operator tier ----')
  assert.match(handler, /tables = b\.soa\.tables\(\)/)
  assert.match(handler, /const writes = eliteWritesOf\(b\)/)
  assert.match(handler, /const host: NoirHost = writes === null \? \{ tables: \(\) => tables, locked: NOIR_LOCKED \} : \{ tables: \(\) => tables, write: writes, locked: NOIR_LOCKED \}/)
  assert.match(handler, /n\.run\(rest, host, writes === null \? undefined : ELITE_LIMITS\)/)
  assert.doesNotMatch(handler, /b\.operator|api\.|sim\./)
  assert.match(commands, /^function eliteWritesOf\(b: TerminalBridge\): EliteWrites \| null \{\n {2}try \{ return b\.operator\?\.elite\.writes\(\) \?\? null \} catch \{ return null \}\n\}$/m)
  assert.match(commands, /^const NOIR_LOCKED = "elite tier locked: 'ring0 unlock --elite <passphrase>' opens it"$/m)
  // The same words the tier itself refuses with (operator.ts's requireElite), so a script and the console agree.
  assert.match(read('./operator.ts'), /elite tier locked: 'ring0 unlock --elite <passphrase>' opens it/)
  // Nothing of the VM is imported anywhere else in the terminal.
  for (const file of ['./terminal/Terminal.tsx', './terminal/repl.ts']) assert.doesNotMatch(read(file), /noirscript/, file)
})
