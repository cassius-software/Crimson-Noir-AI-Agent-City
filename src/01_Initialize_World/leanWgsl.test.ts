// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the shader text the page ships (leanWgsl.node.ts, vite.config.ts leanShaders):
 * every `.wgsl` file under src without its comments and nothing else changed (each shipped line is the file's own
 * line up to its comment, on the same line number, the licence header kept), WGSL's comment rules on small cases
 * (nested blocks, a block over lines, a block between two tokens, every line break the language has), and the build's
 * wiring: the plugin answers a `?raw` import of a shader in the page's bundle and in the workers', as it must, because
 * the crowd's shaders ride in both.
 * What breaks if it is removed? A change to the stripping that ate a token, moved a line or dropped the licence, or a
 * build that left the plugin out of the worker's list, would ship without a test noticing: the first is a shader that
 * no longer compiles or reports the wrong line, the second a page that carries the worker's copy of the comments
 * again (about 41 KB), which the byte budget alone would not catch.
 */
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { leanShaders } from '../../vite.config.ts'
import { isRawWgsl, leanWgsl } from './leanWgsl.node.ts'

const SRC = fileURLToPath(new URL('..', import.meta.url))

/** Every .wgsl file under src. */
function shaders(dir = SRC): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...shaders(p))
    else if (name.endsWith('.wgsl')) out.push(p)
  }
  return out.sort()
}

test('every shader ships as its own lines without their comments, the licence header kept', () => {
  const files = shaders()
  assert.ok(files.length >= 5, 'the crowd, its two ways, the flow field and the rain mesh')
  let saved = 0
  for (const file of files) {
    const source = readFileSync(file, 'utf8')
    // The property below reads a line comment as everything from the first `//`; a block comment would need the
    // scanner's own state, so a shader that starts using one gets its cases here first.
    assert.ok(!source.includes('/*'), `${file}: no block comment (the line-by-line property below assumes none)`)
    // A Windows checkout may hold the files with CRLF line ends; the shipped text has line feeds either way.
    const lines = source.split(/\r?\n/)
    const lean = leanWgsl(source).split('\n')
    assert.equal(lean.length, lines.length, `${file}: every line stays on its number`)
    assert.deepEqual(lean.slice(0, 3), lines.slice(0, 3), `${file}: the licence header, word for word`)
    assert.match(lean[1], /SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary/)
    for (let i = 3; i < lines.length; i++) {
      const at = lines[i].indexOf('//')
      const code = (at < 0 ? lines[i] : lines[i].slice(0, at)).trimEnd()
      assert.equal(lean[i], code, `${file}:${i + 1}: the line's code and nothing of its comment`)
    }
    assert.ok(!lean.slice(3).join('\n').includes('//'), `${file}: no comment past the header`)
    assert.equal(leanWgsl(lean.join('\n')), lean.join('\n'), `${file}: stripping twice changes nothing`)
    saved += source.length - lean.join('\n').length
  }
  // The comments are most of what the page carried for nothing: a floor, so a stripping that quietly stopped is seen.
  assert.ok(saved > 30_000, `the comments were ${saved} bytes of the shaders`)
})

test("WGSL's comment rules: line comments, nested blocks, a block between tokens, every line break", () => {
  assert.equal(leanWgsl('let a = 1; // one\nlet b = 2;'), 'let a = 1;\nlet b = 2;')
  assert.equal(leanWgsl('  // a whole line\n  x += 1;'), '\n  x += 1;', 'a comment line leaves its line break')
  assert.equal(leanWgsl('a/**/b'), 'a b', 'a block is one space: the tokens either side stay apart')
  assert.equal(leanWgsl('a /* one /* two */ still one */ b'), 'a   b', 'blocks nest')
  assert.equal(leanWgsl('a /* over\n  lines // not a line comment */ b\nc'), 'a\n  b\nc', 'a block over lines keeps the line count')
  assert.equal(leanWgsl('a // not a block /* \nb */ c'), 'a\nb */ c', 'a line comment hides a block opener')
  assert.equal(leanWgsl('x = a / b; y = c * d;'), 'x = a / b; y = c * d;', 'a division and a product are no comment')
  assert.equal(leanWgsl('let a = 1;   \t'), 'let a = 1;', 'trailing spaces go')
  assert.equal(leanWgsl(''), '')
  // A line comment ends at any of WGSL's line breaks; what follows is code and must stay.
  for (const br of ['\n', '\r\n', '\r', '\v', '\f', '\u0085', 'LS', 'PS']) {
    const real = br === 'LS' ? String.fromCharCode(0x2028) : br === 'PS' ? String.fromCharCode(0x2029) : br
    assert.equal(leanWgsl(`a // gone${real}b`), 'a\nb', `line break U+${real.charCodeAt(0).toString(16)}`)
  }
  // Only the leading run of header lines is kept; the same words further down are a comment like any other.
  assert.equal(leanWgsl('// Copyright (c) someone\n// SPDX-License-Identifier: X\n// why\nfn f() {}\n// Copyright again'), '// Copyright (c) someone\n// SPDX-License-Identifier: X\n\nfn f() {}\n')
  assert.equal(leanWgsl('// why first\n// Copyright (c) someone\nfn f() {}'), '\n\nfn f() {}', 'a header is a header only at the head')
})

test('the build strips a shader imported as text, in the page and in its workers', async () => {
  assert.ok(isRawWgsl('/repo/src/03_Spawn_Agents/crowd.wgsl?raw'))
  assert.ok(isRawWgsl('C:/repo/src/03_Spawn_Agents/crowd.wgsl?import&raw'), 'the dev server adds a word before it')
  assert.ok(isRawWgsl('/repo/src/a.wgsl?raw&t=1'))
  assert.ok(!isRawWgsl('/repo/src/a.wgsl'), 'not a plain import')
  assert.ok(!isRawWgsl('/repo/src/a.wgsl?url'))
  assert.ok(!isRawWgsl('/repo/src/a.wgsl.ts?raw'))
  assert.ok(!isRawWgsl('/repo/src/a.ts?raw'), 'only shaders: any other text ships as it is')
  assert.ok(!isRawWgsl('/repo/src/a.wgsl?rawish'))

  const plugin = leanShaders()
  assert.equal(plugin.enforce, 'pre', "before Vite's own raw loader")
  assert.equal(plugin.apply, undefined, 'the dev server and the build serve the same text')
  const load = plugin.load as (id: string) => string | null
  const file = join(SRC, '03_Spawn_Agents', 'crowdWayLite.wgsl')
  const module = load(`${file}?raw`)
  assert.ok(module, 'the plugin answers a shader asked for as text')
  assert.ok(module.startsWith('export default "'), 'the module Vite expects of a raw import')
  const text = JSON.parse(module.slice('export default '.length)) as string
  assert.equal(text, leanWgsl(readFileSync(file, 'utf8')))
  assert.match(text, /fn roomWay\(/)
  assert.doesNotMatch(text, /What breaks if it is removed/)
  assert.equal(load(`${file}?import&raw`), module)
  assert.equal(load(join(SRC, 'brand.ts')), null, 'nothing else is this plugin\'s to load')
  assert.equal(load(`${join(SRC, 'brand.ts')}?raw`), null)

  // The page's bundle and each worker's are built from separate plugin lists; the physics worker carries the crowd's
  // shaders, so a plugin only in the page's list would leave half the comments in the file.
  const config = readFileSync(new URL('../../vite.config.ts', import.meta.url), 'utf8')
  assert.match(config, /\n  plugins: \[leanShaders\(\), /, "first in the page's list")
  assert.match(config, /\n  worker: \{ plugins: \(\) => \[leanShaders\(\), workerNotices\(\)\] \},\r?\n/, "and in the workers'")
})
