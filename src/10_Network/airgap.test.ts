// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the structural proof of the product's air gap, read off the source: no runtime
 * source under src/ imports a '.node.ts' module (the host stays out of the page's import graph, so Vite never bundles
 * node:http); every runtime source that names an outbound primitive (fetch(, WebSocket, XMLHttpRequest, EventSource,
 * RTCPeerConnection, sendBeacon, WebTransport, importScripts, import( of an http string) or a URL literal off this
 * machine is in an explicit allowlist, and each allowlisted call site goes through the gate (02_Define_The_Rules/
 * airgap.ts loopbackOnly, or an alias of it, named in the enclosing function); the gate itself is pure, defines every
 * alias and guard in terms of loopbackOnly, and is installed by main.tsx and physics.worker.ts before anything else;
 * the replication core takes its 14A verdicts from conduct.ts; the network stage's imports stay inside the allowlist
 * (never the realm); and the in-page model runtime is reached only through its adapter (09_Cognition/wllamaRuntime.ts:
 * the one file that names wllama or its pinned module, both imported dynamically), which switches wllama's
 * compatibility build (a CDN) off the moment it makes an instance, hands it a cache that keeps nothing, and makes the
 * module a page-made blob: URL, while no source names one of wllama's download paths. What breaks if it is removed? A page file could quietly open a socket of its own,
 * import the host, or name a server off this machine, and "the page sends nothing off this machine" would erode
 * without a test going red.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = fileURLToPath(new URL('..', import.meta.url))
const SELF = fileURLToPath(import.meta.url)
const GATE = '02_Define_The_Rules/airgap.ts'
// The scanner defence is plain JavaScript (tools/ carries no types); a computed specifier keeps the page's typecheck off it.
const HELD: string = '../../tools/test/held.mjs'
/** readFileSync that waits out a file a Windows on-access scanner holds (tools/test/held.mjs): the walks in this file read hundreds. */
const { readHeld } = (await import(HELD)) as { readHeld(path: string, encoding: 'utf8'): string }

function* files(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    // A `nix build` run inside src/ leaves its result link here (tools/license/headers.mjs nixLeftover): not source.
    if (name === 'result' || name.startsWith('result-') || name === '.direnv') continue
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
    .map((f) => [relative(SRC, f).replaceAll('\\', '/'), readHeld(f, 'utf8')])

const specifiers = (text: string): string[] =>
  [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3])

/** An address off this machine: a ws(s) or http(s) URL whose host is not loopback (the SVG namespace is an XML name, not an address). */
const OFF_MACHINE = /\b(?:wss?|https?):\/\/(?!localhost\b|127\.\d|\[::1\]|www\.w3\.org\/)[\w.-]+/
/** The primitives through which anything could leave the page, and a dynamic import of a remote module. */
const PRIMITIVES = /\bfetch\s*\(|\bWebSocket\b|\bXMLHttpRequest\b|\bEventSource\b|\bRTCPeerConnection\b|\bsendBeacon\b|\bWebTransport\b|\bimportScripts\b|\bimport\s*\(\s*[`'"]https?:/

/**
 * The call sites that may name a primitive, by file: the line each stands on and what its enclosing function must
 * name (the gate or one of its aliases), or null for a mere presence check that addresses nothing.
 */
const ALLOWED: Record<string, { line: RegExp; guard: RegExp | null }[]> = {
  // The page's own fetch, handed to the model and speech clients under the gate's wrapper (which goes through loopbackOnly).
  'App.tsx': [{ line: /window\.fetch\(url, init\)/, guard: /\bloopbackFetch\(/ }],
  // The room client's one socket, made only for a URL netServer (the gate's ws alias) admits; a presence check for the voice stub.
  '10_Network/netClient.ts': [
    { line: /new WebSocket\(url, protocols\)/, guard: /\bnetServer\(url\)/ },
    { line: /typeof RTCPeerConnection === 'undefined'/, guard: null },
  ],
}

/** The text of the function enclosing line `i`: from the nearest line above that opens one (an arrow, `function`, or a method) down to `i`. */
function enclosing(lines: readonly string[], i: number): string {
  const opens = /=>|\bfunction\b|^\s*(?:(?:async|static|get|set)\s+)*[\w$]+\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/
  let j = i
  while (j > 0 && !opens.test(lines[j]) && i - j < 40) j--
  return lines.slice(j, i + 1).join('\n')
}

test('no runtime source under src imports a .node.ts module but another .node.ts: the host and its mirror never enter the page\'s import graph', () => {
  const sources = runtimeSources()
  assert.ok(sources.length > 50, `${sources.length} runtime sources read`)
  assert.ok(sources.some(([name]) => name.endsWith('.node.ts')), 'the host is among the runtime sources scanned')
  for (const [name, text] of sources) {
    // The host imports the mirror: both are Node-only, and nothing on the page imports either.
    if (name.endsWith('.node.ts')) continue
    for (const spec of specifiers(text)) assert.doesNotMatch(spec, /\.node(?:\.ts)?$/, `${name} imports ${spec}`)
  }
})

test('no runtime source names an address off this machine; every outbound primitive is at an allowlisted site whose enclosing function goes through the gate', () => {
  const seen = new Set<string>()
  for (const [name, text] of runtimeSources()) {
    const c = code(text)
    const address = c.match(OFF_MACHINE)
    assert.equal(address, null, `${name} names ${address?.[0]}`)
    if (name === GATE) continue
    // The host speaks the WebSocket protocol by name in its upgrade headers; it is Node-only and never on the page.
    if (name.endsWith('.node.ts')) {
      assert.doesNotMatch(c, /\bfetch\s*\(|new WebSocket\b|XMLHttpRequest|EventSource|RTCPeerConnection|sendBeacon|WebTransport/, `${name} opens a connection of its own`)
      continue
    }
    const lines = c.split('\n')
    const sites = ALLOWED[name] ?? []
    lines.forEach((line, i) => {
      if (!PRIMITIVES.test(line)) return
      const site = sites.find((s) => s.line.test(line))
      assert.ok(site, `${name}:${i + 1} names an outbound primitive outside the allowlist: ${line.trim()}`)
      seen.add(`${name} ${site.line.source}`)
      if (site.guard) assert.match(enclosing(lines, i), site.guard, `${name}:${i + 1} does not go through the gate: ${line.trim()}`)
    })
  }
  for (const [name, sites] of Object.entries(ALLOWED)) for (const s of sites) assert.ok(seen.has(`${name} ${s.line.source}`), `${name}: allowlisted site not found (${s.line.source})`)
  assert.ok(OFF_MACHINE.test('fetch("wss://rooms.example.net")'))
  assert.ok(OFF_MACHINE.test("'https://api.example.com'"))
  assert.equal('ws://127.0.0.1:8787 http://localhost:11434 http://[::1]:1 xmlns="http://www.w3.org/2000/svg"'.match(OFF_MACHINE), null)
  assert.ok(PRIMITIVES.test('navigator.sendBeacon(u)') && PRIMITIVES.test('await import("https://x/y.js")') && PRIMITIVES.test('new XMLHttpRequest()'))
  assert.ok(!PRIMITIVES.test('fetchFn(url)') && !PRIMITIVES.test('import("./local.ts")'))
})

test('the gate is pure and one: every alias and every guard is defined through loopbackOnly, and nothing else defines "this machine"', () => {
  const text = readFileSync(join(SRC, GATE), 'utf8')
  assert.deepEqual(specifiers(text), [], 'airgap.ts imports nothing')
  const c = code(text)
  assert.match(c, /export function loopbackOnly\(url: unknown\): string \| null \{\n  return loopbackUrl\(url\)\?\.origin \?\? null\n\}/)
  assert.match(c, /export function loopbackServer\(url: unknown\)[^]*?const u = loopbackUrl\(url\)/)
  assert.match(c, /export function netServer\(url: unknown\)[^]*?const u = loopbackUrl\(url\)/)
  assert.match(c, /export function loopbackFetch[^]*?loopbackOnly\(url\) === null \? Promise\.reject/)
  assert.match(c, /const admit = [^]*?if \(loopbackOnly\(u\.href\) !== null\) return u\.href/)
  // Every primitive the guard hands on is given admit()'s string: fetch (a string, a Request), the two constructors, open, importScripts.
  assert.equal(c.match(/\badmit\(/g)?.length, 4, 'fetch (a string, a Request), the constructors and open go through admit')
  assert.match(c, /urls\.map\(admit\)/, 'importScripts too')
  assert.match(c, /fix\(g, 'fetch', fetch\)/)
  assert.match(c, /guardConstructor\('WebSocket'\)\n  guardConstructor\('EventSource'\)/)
  assert.match(c, /fix\(proto, 'open', open\)/)
  assert.match(c, /\['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport'\]/)
  assert.match(c, /fix\(nav, 'sendBeacon', undefined\)/)
  assert.match(c, /writable: false, configurable: false/)
  // The three clients' own checks are the gate's aliases, not definitions of their own.
  for (const [file, alias] of [['09_Cognition/localCompute.ts', 'loopbackServer'], ['09_Cognition/claudeApi.ts', 'loopbackServer'], ['10_Network/netClient.ts', 'netServer']]) {
    const t = readFileSync(join(SRC, file), 'utf8')
    assert.ok(specifiers(t).includes(`../${GATE}`), `${file} imports the gate`)
    assert.match(t, new RegExp(`import \\{ ${alias} \\} from '\\.\\./${GATE.replace('.', '\\.')}'`), `${file} takes ${alias} from the gate`)
    assert.doesNotMatch(code(t), /\.hostname\b|new URL\(/, `${file} has no definition of this machine of its own`)
  }
  assert.doesNotMatch(code(readFileSync(join(SRC, '09_Cognition/localSpeech.ts'), 'utf8')), /\.hostname\b|new URL\(/, 'the speech client has none either')
})

test('main.tsx and physics.worker.ts install the air gap on their global before anything else', () => {
  for (const [file, spec] of [['main.tsx', `./${GATE}`], ['07_Execute_Actions/physics.worker.ts', `../${GATE}`]]) {
    const text = readFileSync(join(SRC, file), 'utf8')
    assert.equal(specifiers(text)[0], spec, `${file}: the gate is the first import`)
    const statements = code(text).split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('import '))
    assert.equal(statements[0], 'installAirgap(globalThis)', `${file}: the first statement installs the gate`)
  }
  // Nothing else installs it: the page's global once, the worker's once.
  for (const [name, text] of runtimeSources()) {
    if (name === GATE || name === 'main.tsx' || name === '07_Execute_Actions/physics.worker.ts') continue
    assert.doesNotMatch(code(text), /\binstallAirgap\b/, `${name} installs the gate`)
  }
})

/** The in-page model runtime's adapter, the only file allowed to name wllama. */
const ADAPTER = '09_Cognition/wllamaRuntime.ts'
/** wllama's paths that fetch a model (or its metadata) from the network: none is ever named in src. */
const DOWNLOADS = /loadModelFromHF|loadModelFromUrl|\.download\(|getHF/

/** The text from the parenthesis at `open` to the one that closes it, both included. */
function balanced(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')' && --depth === 0) return text.slice(open, i + 1)
  }
  return text.slice(open)
}

test('the in-page runtime is reached only through its adapter, which switches wllama\'s CDN build off at once, hands it a cache that keeps nothing and never names a download path', () => {
  const sources = runtimeSources()
  assert.ok(sources.some(([name]) => name === ADAPTER), 'the adapter is among the runtime sources scanned')
  for (const [name, text] of sources) {
    const c = code(text)
    // Comments may say what the adapter does; only the adapter's code names the package or the pinned module.
    if (name !== ADAPTER) assert.doesNotMatch(c, /@wllama\/|virtual:wllama-runtime/, `${name} names wllama`)
    assert.doesNotMatch(c, /\.setCompat\((?!null\))/, `${name} points wllama's compatibility build somewhere`)
    assert.doesNotMatch(c, /\bnew\s+(?!lib\.Wllama\()[\w.]*\bWllama\(/, `${name} makes a wllama of its own`)
  }
  // Every source (tests too, but this file) stays off wllama's download paths and its model manager's downloads.
  for (const f of files(SRC)) {
    if (f === SELF) continue
    const c = code(readHeld(f, 'utf8'))
    assert.doesNotMatch(c, DOWNLOADS, `${relative(SRC, f)} names a wllama download path`)
  }

  const adapter = code(readFileSync(join(SRC, ADAPTER), 'utf8'))
  // Both are imported dynamically (the first time a model loads; the package's types are read the same way), never at module load.
  assert.deepEqual([...new Set(specifiers(adapter).filter((s) => /wllama/.test(s)))].sort(), ['@wllama/wllama/esm/index.js', 'virtual:wllama-runtime'])
  assert.doesNotMatch(adapter, /^\s*import\s+[^(]*['"](?:@wllama\/|virtual:wllama-runtime)/m, 'a static import of wllama')
  // One construction, and the very next statement turns the compatibility build (pointed at a CDN by the constructor) off.
  const made = [...adapter.matchAll(/(?:const|let)\s+(\w+)\s*=\s*new lib\.Wllama\(/g)]
  assert.equal(made.length, 1, 'one place makes a wllama')
  assert.equal(adapter.match(/new lib\.Wllama\(/g)?.length, 1)
  const [m] = made
  const open = m.index + m[0].length - 1
  const args = balanced(adapter, open)
  const next = adapter.slice(open + args.length)
  assert.match(next, new RegExp(`^\\s*\\n\\s*${m[1]}\\.setCompat\\(null\\)\\n`), 'setCompat(null) is the next statement after the constructor')
  // Its cache keeps nothing, so wllama never stores, lists or reads a model of its own.
  assert.match(args, /\bcacheManager: new lib\.CacheManager\(\[NO_STORAGE\]\)/, 'a cacheManager is passed: the one that keeps nothing')
  const store = /const NO_STORAGE: WllamaStorage = Object\.freeze\(\{([^]*?)\n\}\)/.exec(adapter)?.[1] ?? ''
  assert.match(store, /isSupported: \(\) => true/)
  assert.match(store, /read: async \(\) => null/)
  assert.match(store, /write: async \(\) => \{\n\s*throw new Error\(/)
  assert.match(store, /list: async \(\) => \[\]/)
  // The module reaches wllama as a page-made blob: URL, never a data: URL (wllama pastes its URL into the worker's source).
  assert.match(adapter, /URL\.createObjectURL\(new Blob\(\[raw\], \{ type: 'application\/wasm' \}\)\)/)
  assert.doesNotMatch(adapter, /['"`]data:/)

  assert.ok(DOWNLOADS.test('w.loadModelFromHF({})') && DOWNLOADS.test('modelManager.download(u)') && DOWNLOADS.test('getHFModelSource(x)'))
  assert.ok(!DOWNLOADS.test('a.downloaded') && !DOWNLOADS.test('download: 1'))
  assert.equal(balanced('f(a(b), c) d', 1), '(a(b), c)')
})

test('the replication core takes its 14A verdicts from conduct.ts screen, and the stage imports only what the allowlist names', () => {
  const core = readFileSync(join(SRC, '10_Network/replication.ts'), 'utf8')
  assert.match(core, /^import \{ screen \} from '\.\.\/02_Define_The_Rules\/conduct\.ts'$/m)
  assert.match(code(core), /screen\(n\)\.admissible/, 'names go through the screen')
  assert.match(code(core), /screen\(l\)\.admissible/, 'chat lines go through the screen')
  assert.doesNotMatch(code(core), /\bnew RegExp\b|LEXICON/, 'no lexicon of its own')
  const allowed: Record<string, string[]> = {
    'replication.ts': ['../02_Define_The_Rules/conduct.ts', '../02_Define_The_Rules/integrity.ts', '../07_Execute_Actions/simProtocol.ts', '../08_Swarm/ping.ts'],
    'netClient.ts': ['./replication.ts', '../08_Swarm/ping.ts', `../${GATE}`],
    // node:fs and node:path read one file, once, at startup: the digest the operator pinned in
    // crimson_noir_os/containment.lock, which opens the ledger door (Phase 14). Nothing is ever written.
    'replication.node.ts': [
      'node:crypto', 'node:fs', 'node:http', 'node:net', 'node:path', 'node:url', '../02_Define_The_Rules/integrity.ts', './ledger.node.ts',
      './ledger.ts', './mirror.node.ts', './replication.ts',
    ],
    // The ledger door's check is pure: the 14A screen for the configuration's names, the hash chain, the fold.
    'ledger.ts': ['../02_Define_The_Rules/conduct.ts', '../02_Define_The_Rules/integrity.ts'],
    // The door itself: the room's envelope seal, and the host's frame code passed in (replication.node.ts and node:net
    // for their types only). It opens no connection of its own.
    'ledger.node.ts': ['node:net', '../02_Define_The_Rules/integrity.ts', './ledger.ts', './replication.ts', './replication.node.ts'],
    // The host's authority is a realm of its own on the server (Phase 12): the city, Rapier, the avatar's controller and
    // the Ring-0 audit, never the page's realm (no simCore, no fleet, no laws) and never on the page.
    'mirror.node.ts': [
      '../01_Initialize_World/city.ts', '../02_Define_The_Rules/ring0.ts', '../07_Execute_Actions/physics.ts', '../07_Execute_Actions/player.ts',
      '../07_Execute_Actions/simProtocol.ts', './garage.node.ts', './replication.ts',
    ],
    // Its garage (Phase 13): one car's physics shared with the page (carRig.ts) and the track network's geometry, again
    // never the page's realm, its fleet or its bouncer. The seed's indoor workplaces (interiors.ts, pure geometry the
    // city already hollows) say where a car left in one puts its driver.
    'garage.node.ts': [
      '../01_Initialize_World/city.ts', '../01_Initialize_World/interiors.ts', '../02_Define_The_Rules/ring0.ts', '../06_Make_Decisions/tracks.ts', '../07_Execute_Actions/carRig.ts',
      '../07_Execute_Actions/physics.ts', '../07_Execute_Actions/simProtocol.ts',
    ],
    'plane.node.ts': ['../07_Execute_Actions/simProtocol.ts', './replication.ts'],
    // The telemetry pipeline (Phase 18) is pure: frames, digests and the per-node hash chain; it opens nothing and
    // reaches no realm. Its links are whatever carries a frame (the fuzz drives it through a chaotic one in memory).
    'telemetry.ts': ['../02_Define_The_Rules/integrity.ts'],
  }
  for (const [file, list] of Object.entries(allowed)) {
    const text = readFileSync(join(SRC, '10_Network', file), 'utf8')
    assert.doesNotMatch(text, /\bimport\s*\(|\brequire\s*\(/, `${file}: dynamic import`)
    const specs = specifiers(text)
    assert.ok(specs.length > 0, `${file}: imports parsed`)
    for (const spec of specs) assert.ok(list.includes(spec), `${file} imports '${spec}'`)
    const realms = file === 'mirror.node.ts' || file === 'garage.node.ts' ? ['simCore', 'vehicles', 'laws'] : ['simCore', 'vehicles', 'laws', 'ring0', 'physics']
    for (const realm of realms) assert.ok(!specs.some((s) => s.includes(realm)), `${file} reaches the realm (${realm})`)
  }
  // Every source of the stage is in the list above (or is a test).
  for (const f of readdirSync(join(SRC, '10_Network'))) if (!f.endsWith('.test.ts')) assert.ok(f in allowed, `10_Network/${f} has no import allowlist`)
  // The ledger door only answers: neither of its files can open a connection of its own.
  for (const f of ['ledger.ts', 'ledger.node.ts']) {
    const text = code(readFileSync(join(SRC, '10_Network', f), 'utf8'))
    assert.doesNotMatch(text, /\bnew WebSocket\b|\bcreateConnection\b|\bconnect\(|\bfetch\(|\brequest\(/, `${f} opens a connection`)
  }
  // The page half opens nothing at module load: a socket is made only inside connect().
  const client = code(readFileSync(join(SRC, '10_Network/netClient.ts'), 'utf8'))
  assert.equal(client.match(/new WebSocket\(/g)?.length, 1)
  assert.doesNotMatch(client, /^\s*(?:const|let)\s+\w+\s*=\s*new WebSocket/m, 'no socket at module scope')
})
