/**
 * Why does this file exist? It is the structural guard on the product's air gap now that a network stage exists: no
 * runtime source under src/ imports a '.node.ts' module (the host stays out of the page's import graph, so Vite never
 * bundles node:http); only the two opt-in clients, 09_Cognition/claudeApi.ts and 10_Network/netClient.ts, may name a
 * network address off this machine or the WebSocket / RTCPeerConnection constructors in their code; the host itself
 * names no address off this machine; the replication core takes its 14A verdicts from 02_Define_The_Rules/conduct.ts
 * and nowhere else; and the stage's imports stay inside the allowlist (never the realm: simCore, vehicles, laws).
 * What breaks if it is removed? A page file could quietly import the host or open a socket of its own, and the
 * "works offline, sends nothing unless asked" guarantee would erode without a test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) yield* files(p)
    else if (/\.(ts|tsx)$/.test(name)) yield p
  }
}

/** The code of a source file without its comments (a line comment starts at // not preceded by a colon, as in URLs). */
const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Every runtime (non-test) source under src/, as [relative path, text]. */
const runtimeSources = (): [string, string][] =>
  [...files(SRC)]
    .filter((f) => f !== SELF && !/\.test\.tsx?$/.test(f) && !/\.d\.ts$/.test(f))
    .map((f) => [relative(SRC, f).replaceAll('\\', '/'), readFileSync(f, 'utf8')])

const specifiers = (text: string): string[] =>
  [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3])

/** An address off this machine: a ws(s) or http(s) URL whose host is not loopback (the SVG namespace is an XML name, not an address). */
const OFF_MACHINE = /\b(?:wss?|https?):\/\/(?!localhost\b|127\.\d|\[::1\]|www\.w3\.org\/)[\w.-]+/
const SOCKETS = /\b(?:WebSocket|RTCPeerConnection)\b/

const CLIENTS = ['09_Cognition/claudeApi.ts', '10_Network/netClient.ts']

test('no runtime source under src imports a .node.ts module: the host never enters the page\'s import graph', () => {
  const sources = runtimeSources()
  assert.ok(sources.length > 50, `${sources.length} runtime sources read`)
  assert.ok(sources.some(([name]) => name.endsWith('.node.ts')), 'the host is among the runtime sources scanned')
  for (const [name, text] of sources) {
    for (const spec of specifiers(text)) assert.doesNotMatch(spec, /\.node(?:\.ts)?$/, `${name} imports ${spec}`)
  }
})

test('only the two opt-in clients name an address off this machine or a socket constructor; the host names no address off this machine', () => {
  for (const [name, text] of runtimeSources()) {
    const c = code(text)
    const address = c.match(OFF_MACHINE)
    if (!CLIENTS.includes(name)) assert.equal(address, null, `${name} names ${address?.[0]}`)
    // The host speaks the WebSocket protocol by name in its upgrade headers; it is Node-only and never on the page.
    if (name.endsWith('.node.ts')) continue
    const socket = c.match(SOCKETS)
    if (!CLIENTS.includes(name)) assert.equal(socket, null, `${name} names ${socket?.[0]}`)
  }
  for (const name of CLIENTS) {
    const c = code(readFileSync(join(SRC, name), 'utf8'))
    assert.ok(OFF_MACHINE.test(c) || SOCKETS.test(c), `${name} is a client`)
  }
  assert.ok(OFF_MACHINE.test('fetch("wss://rooms.example.net")'))
  assert.equal('ws://127.0.0.1:8787 http://localhost:11434 http://[::1]:1 xmlns="http://www.w3.org/2000/svg"'.match(OFF_MACHINE), null)
})

test('the replication core takes its 14A verdicts from conduct.ts screen, and the stage imports only what the allowlist names', () => {
  const core = readFileSync(join(SRC, '10_Network/replication.ts'), 'utf8')
  assert.match(core, /^import \{ screen \} from '\.\.\/02_Define_The_Rules\/conduct\.ts'$/m)
  assert.match(code(core), /screen\(n\)\.admissible/, 'names go through the screen')
  assert.match(code(core), /screen\(l\)\.admissible/, 'chat lines go through the screen')
  assert.doesNotMatch(code(core), /\bnew RegExp\b|LEXICON/, 'no lexicon of its own')
  const allowed: Record<string, string[]> = {
    'replication.ts': ['../02_Define_The_Rules/conduct.ts', '../07_Execute_Actions/simProtocol.ts', '../08_Swarm/ping.ts'],
    'netClient.ts': ['./replication.ts', '../08_Swarm/ping.ts'],
    'replication.node.ts': ['node:crypto', 'node:http', 'node:net', 'node:url', './replication.ts'],
  }
  for (const [file, list] of Object.entries(allowed)) {
    const text = readFileSync(join(SRC, '10_Network', file), 'utf8')
    assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/, `${file}: dynamic import`)
    const specs = specifiers(text)
    assert.ok(specs.length > 0, `${file}: imports parsed`)
    for (const spec of specs) assert.ok(list.includes(spec), `${file} imports '${spec}'`)
    for (const realm of ['simCore', 'vehicles', 'laws', 'ring0', 'physics']) assert.ok(!specs.some((s) => s.includes(realm)), `${file} reaches the realm (${realm})`)
  }
  // The page half opens nothing at module load: a socket is made only inside connect().
  const client = code(readFileSync(join(SRC, '10_Network/netClient.ts'), 'utf8'))
  assert.equal(client.match(/new WebSocket\(/g)?.length, 1)
  assert.doesNotMatch(client, /^\s*(?:const|let)\s+\w+\s*=\s*new WebSocket/m, 'no socket at module scope')
})
