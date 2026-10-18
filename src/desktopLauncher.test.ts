// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the desktop launcher `nix run` starts (tools/web/launch.mjs) and the flake around
 * it: the address stays http://127.0.0.1:4180 unless told otherwise (the page keeps its settings per address), every
 * answer carries the two isolation headers the shared bridge needs, nothing but the page is served and no request can
 * crash the server, a second launch trusts the port only when it signs a fresh nonce with this user's token (which is
 * itself never sent), Chrome gets one
 * --enable-features list (it keeps only the last one it is given, so a second list would drop Vulkan), CHROME may
 * name a command, and the Nix files keep the shape CI's nix workflow relies on. That workflow boots the city from the
 * Nix package in Chromium; this file catches the same mistakes without Nix.
 * What breaks if it is removed? A launcher change could lose the isolation headers, move the address (and with it every
 * saved setting), serve files beside the page, open the profile's saved keys on another user's server, or drop
 * WebGPU's Vulkan switch, and only a NixOS desktop would show it.
 */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import type { Server } from 'node:http'
import { hostname, tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test } from 'node:test'

// tools/ is plain JavaScript with no types; a computed specifier keeps the page's typecheck off it.
const LAUNCH: string = '../tools/web/launch.mjs'
const launcher = (await import(LAUNCH)) as {
  PORT: number
  APP_CLASS: string
  WAYLAND_APP_ID: string
  PROFILE_NAME: string
  CHALLENGE: string
  MARK: string
  proof(token: string, nonce: string): string
  HEADERS: Readonly<Record<string, string>>
  options(argv: string[], env: Record<string, string | undefined>): { dir: string; port: number; query: URLSearchParams; x11: boolean; browser: boolean; check: boolean; help: boolean; extra: string[] }
  chromeFlags(o: { url: string; profile: string; x11?: boolean; extra?: string[]; env?: Record<string, string | undefined> }): string[]
  serve(page: Buffer, port: number, token?: string): Promise<Server>
  tokenFile(dir: string, port: number): string
  ours(port: number, file: string): Promise<boolean>
  profileOwner(profile: string): number | null
}
const CDP: string = '../tools/browser/cdp.mjs'
const cdp = (await import(CDP)) as { findChrome(explicit?: string): string | null }
const HEADERS_TOOL: string = '../tools/license/headers.mjs'
const headers = (await import(HEADERS_TOOL)) as { licenseOf(rel: string): string | null; nixLeftover(name: string): boolean }

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')

test('the address is 127.0.0.1:4180 by default; key=value words become the page\'s query; a stray word, a bad port or a missing value is refused', () => {
  const d = launcher.options([], { AGENT_CITY_DIST: '/srv/page' })
  assert.equal(d.port, 4180)
  assert.equal(launcher.PORT, 4180)
  assert.equal(d.dir, resolve('/srv/page'))
  assert.equal(d.query.toString(), '')
  assert.ok(d.browser && !d.check && !d.x11)

  const o = launcher.options(['quality=4', 'map=lakefront', 'debug', '--port', '4190', '--x11'], { AGENT_CITY_DIST: '/srv/page' })
  assert.equal(o.query.toString(), 'quality=4&map=lakefront&debug=')
  assert.equal(o.port, 4190)
  assert.equal(o.x11, true)

  const env = launcher.options([], { AGENT_CITY_DIST: '/p', AGENT_CITY_PORT: '4200', AGENT_CITY_X11: '1', AGENT_CITY_CHROME_FLAGS: ' --ozone-platform=x11  --enable-features=VaapiVideoDecoder ' })
  assert.equal(env.port, 4200)
  assert.equal(env.x11, true)
  assert.deepEqual(env.extra, ['--ozone-platform=x11', '--enable-features=VaapiVideoDecoder'])

  assert.throws(() => launcher.options(['--bogus'], {}), /unknown argument --bogus/)
  assert.throws(() => launcher.options(['--port', '0'], {}), /not a port/)
  assert.throws(() => launcher.options(['--port', '70000'], {}), /not a port/)
  assert.throws(() => launcher.options(['../etc'], {}), /unknown argument/)
  // A switch with no value must not take the next switch, or the current folder, in its place.
  assert.throws(() => launcher.options(['--dir'], {}), /--dir needs a value/)
  assert.throws(() => launcher.options(['--dir', '--x11'], {}), /--dir needs a value/)
  assert.throws(() => launcher.options(['--port'], {}), /--port needs a value/)
  // A quoted value split at its space would reach Chromium as an address to open beside the app window.
  assert.throws(() => launcher.options([], { AGENT_CITY_CHROME_FLAGS: '--user-agent="Agent City"' }), /switches only/)
})

test('Chrome gets its own profile, an app window, WebGPU, and exactly one --enable-features list with Vulkan in it', () => {
  const url = 'http://127.0.0.1:4180/?quality=4'
  const plain = launcher.chromeFlags({ url, profile: '/state/p', env: {} })
  assert.equal(plain.at(-1), `--app=${url}`, 'the address comes last')
  assert.ok(plain.includes('--user-data-dir=/state/p') && plain.includes('--enable-unsafe-webgpu') && plain.includes('--enable-webgpu-developer-features') && plain.includes(`--class=${launcher.APP_CLASS}`))
  // The profile's folder is part of the Wayland window's name: Chromium's `Default` would name every 127.0.0.1 app.
  assert.ok(plain.includes(`--profile-directory=${launcher.PROFILE_NAME}`) && launcher.PROFILE_NAME !== 'Default')
  assert.equal(launcher.WAYLAND_APP_ID, `chrome-127.0.0.1__-${launcher.PROFILE_NAME}`)
  assert.deepEqual(plain.filter((f) => f.startsWith('--enable-features=')), ['--enable-features=Vulkan'])
  assert.ok(!plain.some((f) => /no-sandbox|swiftshader|ozone-platform/.test(f)), 'a desktop window keeps the sandbox and the real GPU')

  // A Wayland window wants its decorations; nixpkgs' wrapper asks with a list of its own, which a later list drops.
  const features = (env: Record<string, string>, x11 = false) => launcher.chromeFlags({ url, profile: '/p', x11, env }).filter((f) => f.startsWith('--enable-features='))
  assert.deepEqual(features({ NIXOS_OZONE_WL: '1', WAYLAND_DISPLAY: 'wayland-0' }), ['--enable-features=Vulkan,WaylandWindowDecorations'])
  assert.deepEqual(features({ XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: 'wayland-0' }), ['--enable-features=Vulkan,WaylandWindowDecorations'], 'any Wayland session')
  assert.deepEqual(features({ XDG_SESSION_TYPE: 'x11', DISPLAY: ':0' }), ['--enable-features=Vulkan'])
  assert.deepEqual(features({ NIXOS_OZONE_WL: '1', WAYLAND_DISPLAY: 'wayland-0' }, true), ['--enable-features=Vulkan'])
  assert.ok(launcher.chromeFlags({ url, profile: '/p', x11: true, env: {} }).includes('--ozone-platform=x11'))

  const extra = launcher.chromeFlags({ url, profile: '/p', env: {}, extra: ['--enable-features=Vulkan,VaapiVideoDecoder', '--ignore-gpu-blocklist'] })
  assert.deepEqual(extra.filter((f) => f.startsWith('--enable-features=')), ['--enable-features=Vulkan,VaapiVideoDecoder'], 'extra features join the one list, once each')
  assert.ok(extra.includes('--ignore-gpu-blocklist'))
  assert.equal(extra.at(-1), `--app=${url}`)
})

/** One request to the server, with the request target exactly as given; resolves to the status, headers and body. A
 *  server that never answers fails it in 5 s, so a handler that throws fails the test instead of hanging the run. */
function ask(port: number, method: string, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((ok, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, timeout: 5000 }, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    req.on('timeout', () => req.destroy(new Error(`no answer to ${method} ${path}`)))
    req.on('error', fail)
    req.end()
  })
}

/** Closes a server and every connection it still holds, so a failed test cannot keep the run alive. */
const shut = (server: Server) => { server.closeAllConnections(); server.close() }

test('the launcher serves the page alone, to loopback, every answer isolated and uncached, and no request target crashes it', async () => {
  const page = Buffer.from('<!doctype html><title>city</title>')
  const server = await launcher.serve(page, 0, 'tok')
  try {
    const address = server.address()
    assert.ok(address && typeof address === 'object')
    assert.equal(address.address, '127.0.0.1')
    for (const path of ['/', '/index.html', '/?quality=4&map=lakefront']) {
      const r = await ask(address.port, 'GET', path)
      assert.equal(r.status, 200, path)
      assert.equal(r.body, page.toString(), path)
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8')
    }
    const head = await ask(address.port, 'HEAD', '/')
    assert.equal(head.status, 200)
    assert.equal(head.body, '')
    assert.equal(head.headers[launcher.MARK.toLowerCase()], undefined, 'the token is never sent, and nothing answers without a question')
    const nonce = 'ab'.repeat(16)
    const asked = await ask(address.port, 'HEAD', '/', { [launcher.CHALLENGE]: nonce })
    assert.equal(asked.headers[launcher.MARK.toLowerCase()], launcher.proof('tok', nonce), 'a question gets the nonce signed with the token')
    assert.notEqual(launcher.proof('tok', nonce), 'tok')
    assert.notEqual(launcher.proof('tok', nonce), launcher.proof('tok', 'cd'.repeat(16)), 'an old answer does not fit a new question')
    assert.equal((await ask(address.port, 'HEAD', '/', { [launcher.CHALLENGE]: 'tok' })).headers[launcher.MARK.toLowerCase()], undefined, 'a malformed question gets no answer')
    const missing = await ask(address.port, 'GET', '/sw.js')
    assert.equal(missing.status, 404)
    const posted = await ask(address.port, 'POST', '/')
    assert.equal(posted.status, 405)
    assert.equal(posted.headers.allow, 'GET, HEAD')
    // Targets a URL parser refuses, or that try another path: still one answer each, and the server still up.
    for (const path of ['//[', '//index.html', '/index.html/..', '/%2e%2e/etc/passwd', 'http://127.0.0.1/']) {
      assert.equal((await ask(address.port, 'GET', path)).status, 404, path)
    }
    assert.equal((await ask(address.port, 'GET', '/')).status, 200, 'the server outlived them')
    for (const r of [head, asked, missing, posted]) {
      assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin')
      assert.equal(r.headers['cross-origin-embedder-policy'], 'require-corp')
      assert.equal(r.headers['cache-control'], 'no-store')
      assert.equal(r.headers['x-content-type-options'], 'nosniff')
      assert.equal(r.headers['content-security-policy'], undefined, 'the page carries its own policy')
    }
  } finally {
    shut(server)
  }
  const plain = await launcher.serve(page, 0)
  try {
    const port = (plain.address() as { port: number }).port
    assert.equal((await ask(port, 'HEAD', '/', { [launcher.CHALLENGE]: 'ab'.repeat(16) })).headers[launcher.MARK.toLowerCase()], undefined, 'no token, no answer (--check)')
  } finally {
    shut(plain)
  }
})

test('a second launch opens its window on the port only when it signs a fresh nonce with the token in this user\'s file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'launcher-token-'))
  const server = await launcher.serve(Buffer.from('city'), 0, 'secret-token')
  try {
    const port = (server.address() as { port: number }).port
    const file = launcher.tokenFile(dir, port)
    assert.equal(file, join(dir, `server-${port}.token`))
    assert.equal(await launcher.ours(port, file), false, 'no token file: not ours')
    writeFileSync(file, 'someone-else')
    assert.equal(await launcher.ours(port, file), false, 'another token: not ours')
    writeFileSync(file, 'secret-token\n')
    assert.equal(await launcher.ours(port, file), true)
    writeFileSync(file, '')
    assert.equal(await launcher.ours(port, file), false, 'an empty file matches nothing')
  } finally {
    shut(server)
  }
  // A server that hands out a token it read somewhere, or answers every question the same way, is not ours.
  const replay = createServer((_req, res) => res.writeHead(200, { [launcher.MARK]: 'secret-token' }).end())
  await new Promise<void>((ok) => replay.listen(0, '127.0.0.1', ok))
  try {
    const port = (replay.address() as { port: number }).port
    const file = launcher.tokenFile(dir, port)
    writeFileSync(file, 'secret-token')
    assert.equal(await launcher.ours(port, file), false, 'the token itself is no answer')
  } finally {
    shut(replay)
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a browser already running on the profile is found by its SingletonLock, and only when it lives and is that profile\'s', { skip: process.platform !== 'linux' && 'Chromium\'s lock and /proc are Linux\'s' }, async () => {
  const profile = mkdtempSync(join(tmpdir(), 'launcher-profile-'))
  const lock = join(profile, 'SingletonLock')
  const relock = (target: string) => { rmSync(lock, { force: true }); symlinkSync(target, lock) }
  // A stand-in for the browser: a live process whose command line names the profile, as Chromium's does.
  const browser = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', '--', `--user-data-dir=${profile}`], { stdio: 'ignore' })
  try {
    assert.equal(launcher.profileOwner(profile), null, 'no lock')
    relock(`${hostname()}-${browser.pid}`)
    assert.equal(launcher.profileOwner(profile), browser.pid)
    relock(`another-host-${browser.pid}`)
    assert.equal(launcher.profileOwner(profile), null, 'a lock from another machine (a shared home)')
    relock(`${hostname()}-${process.pid}`)
    assert.equal(launcher.profileOwner(profile), null, 'a live pid that is not this profile\'s browser (a reused pid)')
    relock(`${hostname()}-2147483646`)
    assert.equal(launcher.profileOwner(profile), null, 'a pid that is gone')
  } finally {
    browser.kill()
    rmSync(profile, { recursive: true, force: true })
  }
})

test('CHROME may name a command on PATH, as a shell would find it, or a path', () => {
  const root = mkdtempSync(join(tmpdir(), 'launcher-path-'))
  const [early, dir] = [join(root, 'early'), join(root, 'bin')]
  const bin = join(dir, process.platform === 'win32' ? 'fakechrome.exe' : 'fakechrome')
  mkdirSync(dir, { recursive: true })
  writeFileSync(bin, '')
  chmodSync(bin, 0o755)
  // Earlier on PATH, a folder of that name: a shell passes over it, and so must the search.
  mkdirSync(join(early, process.platform === 'win32' ? 'fakechrome.exe' : 'fakechrome'), { recursive: true })
  if (process.platform !== 'win32') {
    // And, where files carry an execute bit, a file without one.
    mkdirSync(join(root, 'plain'))
    writeFileSync(join(root, 'plain', 'fakechrome'), '')
    chmodSync(join(root, 'plain', 'fakechrome'), 0o644)
  }
  const path = process.env.PATH
  try {
    process.env.PATH = [early, join(root, 'plain'), dir].join(delimiter)
    assert.equal(cdp.findChrome('fakechrome'), bin)
    assert.equal(cdp.findChrome(bin), bin)
    assert.equal(cdp.findChrome('no-such-browser'), null)
    assert.equal(cdp.findChrome(join(dir, 'missing')), null)
  } finally {
    process.env.PATH = path
    rmSync(root, { recursive: true, force: true })
  }
})

test('the flake builds the page with npm\'s lockfile and wraps the launcher with defaults a person can override', () => {
  const flake = read('flake.nix')
  assert.match(flake, /inputs\.nixpkgs\.url = "https:\/\/channels\.nixos\.org\/nixos-\d\d\.\d\d\/nixexprs\.tar\.xz"/)
  for (const f of ['tools/nix/page.nix', 'tools/nix/app.nix', 'tools/nix/module.nix']) assert.ok(flake.includes(`./${f}`), `flake.nix uses ${f}`)
  assert.match(flake, /allowPage = pkg: lib\.getName pkg == "crimson-noir-agent-city-page";/, 'the flake\'s own outputs allow the unfree page by name, and nothing else')
  const lock = JSON.parse(read('flake.lock')) as { nodes: { nixpkgs: { locked: { narHash: string; url: string } } } }
  assert.match(lock.nodes.nixpkgs.locked.narHash, /^sha256-/)
  assert.match(lock.nodes.nixpkgs.locked.url, /^https:\/\/releases\.nixos\.org\/nixos\//, 'locked to one release, not the moving channel')

  const page = read('tools/nix/page.nix')
  assert.match(page, /npmDeps = importNpmLock \{/, 'packages come by the lockfile\'s integrity hashes')
  assert.match(page, /inherit packageLock;/, 'the lockfile less the other platforms\' downloads')
  assert.match(page, /pname = "crimson-noir-agent-city-page";/)
  assert.match(page, /npmBuildScript = "build";/, 'the plain page: the web copy\'s worker would serve a stale page after an update')
  assert.match(page, /install -Dm444 dist\/index\.html \$out\/share\/crimson-noir-agent-city\/index\.html/)
  assert.match(page, /fileset = lib\.fileset\.gitTracked root;/, 'in a checkout, git\'s files and nothing the checkout grew')
  assert.match(page, /free = false;/, 'the proprietary core says so (LICENSE, section 1)')
  assert.match(page, /install -Dm444 src-tauri\/icons\/icon\.png /, 'the icon is Reserved Material: it ships in the unfree package')

  const app = read('tools/nix/app.nix')
  assert.match(app, /--set-default AGENT_CITY_DIST \$\{page\}\/share\/crimson-noir-agent-city/)
  assert.match(app, /--set-default CHROME \$\{lib\.getExe chromium\}/, 'CHROME stays a default, so another browser can be named')
  assert.match(app, /mainProgram = "crimson-noir-agent-city";/, 'what nix run starts')
  assert.match(app, new RegExp(`startupWMClass = "${launcher.APP_CLASS}";`), 'the menu entry finds the X11 window launch.mjs opens')
  assert.ok(app.includes(`name = "${launcher.WAYLAND_APP_ID}";`), 'a hidden entry names the Wayland window')
  assert.match(app, /license = lib\.licenses\.mit;/)
  assert.ok(!app.includes('src-tauri/icons'), 'the MIT package links the page\'s icon instead of carrying it')

  const module = read('tools/nix/module.nix')
  assert.match(module, /hardware\.graphics\.enable = lib\.mkDefault true;/, 'Chromium\'s WebGPU needs the Vulkan driver')
  assert.match(module, /destination = "\/etc\/udev\/rules\.d\/70-[\w-]+\.rules";/, 'uaccess rules before 73-seat-late')
  assert.doesNotMatch(module, /services\.udev\.extraRules\s*=/, 'extraRules land in 99-local.rules, after uaccess is applied')
})

test('Nix leaves nothing the repository\'s walkers, the page build or git would pick up', () => {
  const ignore = read('.gitignore').split('\n').map((l) => l.trim())
  // Tailwind scans what git does not ignore: an unignored result link would put the store's class names in the page.
  for (const name of ['result', 'result-*', '.direnv/']) assert.ok(ignore.includes(name), `.gitignore lacks ${name}`)
  assert.ok(headers.nixLeftover('result') && headers.nixLeftover('result-page') && headers.nixLeftover('.direnv'))
  assert.ok(!headers.nixLeftover('results.md') && !headers.nixLeftover('src'))
  assert.equal(headers.licenseOf('flake.nix'), 'mit')
  assert.equal(headers.licenseOf('tools/nix/module.nix'), 'mit')
})
