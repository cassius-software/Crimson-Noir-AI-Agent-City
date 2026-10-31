// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the air gap of NoirScript, checked on the text of every file in this folder: no
 * import from outside the folder (the tests may use node's assert, test runner and file system, nothing else), no
 * door to the host (no dynamic code, no global object, no clock, no randomness, no timers, no network, no DOM, no
 * storage, nothing asynchronous), none of the words the repository bans from its console sources, and the licence
 * header with its two questions at the head of every file. The scan reads the files with node:fs, this one included,
 * which is why the names it looks for are spelled here with a mark in the middle.
 * What breaks if it is removed? A door to the host, an outside import or a banned word could creep into the one
 * module of the console that must have none, and the console's determinism would rest on nothing.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { test } from 'node:test'

const DIR = new URL('./', import.meta.url)
const FILES: readonly string[] = readdirSync(DIR).filter((name) => !name.startsWith('.')).sort()
const read = (name: string): string => readFileSync(new URL(name, DIR), 'utf8')
const isTest = (name: string): boolean => name.endsWith('.test.ts')
/** The scan reads this file too, so the names it looks for carry a `_` that this strips. */
const unmark = (s: string): string => s.replaceAll('_', '')

const HEADER = [
  '// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.',
  '// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary',
  '// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.',
]

test('the folder holds only TypeScript: the public index, the internal modules and the seven test files the spec names', () => {
  assert.ok(FILES.length >= 10, FILES.join(', '))
  for (const name of FILES) assert.match(name, /^[a-z]+(\.test)?\.ts$/, name)
  for (const name of ['index.ts', 'lexer.test.ts', 'parser.test.ts', 'types.test.ts', 'vm.test.ts', 'session.test.ts', 'fuzz.test.ts', 'airgap.test.ts']) assert.ok(FILES.includes(name), name)
})

test('no file imports from outside the folder; the tests may use node:assert, node:test and node:fs only', () => {
  const allowed = new Set(['node:assert/strict', 'node:test', 'node:fs'])
  for (const name of FILES) {
    const src = read(name)
    const specifiers = [...src.matchAll(/\b(?:from|import)\s+'([^']*)'/g)].map((m) => m[1]!)
    assert.ok(specifiers.length > 0 || name === 'ast.ts', `${name} imports nothing?`)
    for (const spec of specifiers) {
      if (spec.startsWith('./')) {
        assert.match(spec, /^\.\/[a-z]+\.ts$/, `${name}: ${spec} must name a sibling .ts file`)
        assert.ok(FILES.includes(spec.slice(2)), `${name}: ${spec} is not in the folder`)
      } else {
        assert.ok(isTest(name), `${name}: ${spec} is an import from outside the folder`)
        assert.ok(allowed.has(spec), `${name}: ${spec} is not one of node's allowed test modules`)
      }
    }
    assert.doesNotMatch(src, /\brequire\s*\(/, `${name}: require`)
    assert.doesNotMatch(src, new RegExp(`\\b${unmark('imp_ort')}\\s*\\(`), `${name}: a dynamic import`)
  }
})

test('no file names a door to the host: no dynamic code, global object, clock, randomness, timers, network, DOM, storage or asynchrony', () => {
  const words = ['ev_al', 'Func_tion', 'WebAs_sembly', 'global_This', 'win_dow', 'docu_ment', 'fe_tch', 'Da_te', 'setTime_out', 'setInter_val', 'queueMicro_task', 'requestAnimation_Frame',
    'XMLHttp_Request', 'Web_Socket', 'Wor_ker', 'local_Storage', 'session_Storage', 'indexed_DB', 'navi_gator', 'pro_cess', 'cry_pto', 'perfor_mance', 'Pro_mise', 'as_ync', 'aw_ait', 'Shared_ArrayBuffer', 'Ato_mics']
  const doors = words.map((w) => new RegExp(`\\b${unmark(w)}\\b`))
  doors.push(new RegExp(`\\bMath\\s*\\.\\s*${unmark('ran_dom')}\\b`), new RegExp(`\\b${unmark('cons_ole')}\\s*\\.`), /\bnew\s+Func/, /\bwith\s*\(/)
  for (const name of FILES) {
    const src = read(name)
    for (const door of doors) {
      const m = src.match(door)
      assert.equal(m, null, `${name}: "${m?.[0]}"`)
    }
  }
})

test('no file carries a banned word: the rain effect is "rain mode", no third-party product, no word of harm in a console source', () => {
  const banned = ['mat_rix', 'mat_rices', 'qu_ake', 'g_ta', 'alp_ine', 'path_finder', 'busy_box', 'x_box', 'nint_endo', 'digital r_ain', 'the m_atrix'].map((w) => new RegExp(`\\b${unmark(w)}`, 'i'))
  const harm = new RegExp(`\\b(${['att_ack', 'ki_ll', 'wea_pon', 'tar_get', 'sho_ot', 'g_un', 'viol_ence', 'inj_ur', 'dam_age'].map(unmark).join('|')})`, 'i')
  for (const name of FILES) {
    const src = read(name)
    for (const re of banned) {
      const m = src.match(re)
      assert.equal(m, null, `${name}: "${m?.[0]}"`)
    }
    const m = src.match(harm)
    assert.equal(m, null, `${name}: "${m?.[0]}"`)
  }
})

test('every file opens with the three licence lines, then a doc comment that says why it exists and what breaks without it', () => {
  for (const name of FILES) {
    const lines = read(name).split('\n')
    assert.deepEqual(lines.slice(0, 3), HEADER, name)
    assert.equal(lines[3], '/**', `${name}: the doc comment follows the licence`)
    const head = lines.slice(0, 40).join('\n')
    assert.ok(head.includes('Why does this file exist?'), `${name}: why`)
    assert.ok(head.includes('What breaks if it is removed?'), `${name}: what breaks`)
    assert.ok(lines.every((l) => !/\t/.test(l)), `${name}: tabs`)
  }
})

test('the code of the sources is ASCII (so is everything the console could print), and the public index exports only what the spec names', () => {
  for (const name of FILES) {
    if (isTest(name)) continue
    // Comments may use typographic punctuation; the code, and so every string the console could print, is plain ASCII.
    const code = read(name).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
    for (const [i, line] of code.split('\n').entries()) assert.match(line, /^[\x20-\x7e]*$/, `${name}:${i + 1}: ${line}`)
  }
  const index = read('index.ts')
  const exported = [...index.matchAll(/^export (?:const|class|function|interface|type) (\w+)/gm)].map((m) => m[1]!)
  const reexported = [...index.matchAll(/^export (type )?\{([^}]*)\} from/gm)].flatMap((m) => m[2]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0))
  assert.deepEqual([...exported, ...reexported].sort(), ['ELITE_LIMITS', 'EMPTY_TABLES', 'INTRINSIC_NAMES', 'KEYWORDS', 'LIMITS', 'NoirColumns', 'NoirHost', 'NoirLimits', 'NoirResult', 'NoirSession', 'NoirTables', 'NoirWrites', 'TYPE_NAMES', 'f32Text'])
})
