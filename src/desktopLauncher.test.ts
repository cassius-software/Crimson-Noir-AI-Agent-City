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
import { DXGI_FLOOR_BYTES, figureFromAdapters, VRAM_MAX_GB } from './09_Cognition/modelFit.ts'

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
  GPU_FLOOR_BYTES: number
  VRAM_MAX_GB: number
  gpuMemory(o?: { smi?: () => string | null; drm?: string; list?: (d: string) => string[]; read?: (f: string) => string }): { gb: number; from: 'nvidia-smi' | 'amdgpu' } | null
  withVram(q: URLSearchParams, probe?: () => { gb: number; from: string } | null): { gb: number; from: string } | null
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
  // The Ollama option: its own enable, a package per backend (nixpkgs 26.05 removed services.ollama.acceleration), loopback.
  assert.match(module, /^ {4}ollama = \{\n {6}enable = lib\.mkEnableOption/m, 'an option of its own, apart from the city\'s enable')
  assert.match(module, /default = "vulkan";/, 'the free, cached GPU build by default')
  assert.match(module, /llmPackage = if llm\.acceleration == null then null else "ollama-\$\{llm\.acceleration\}";/)
  assert.doesNotMatch(module, /^\s*(host|port) = /m, 'host and port stay nixpkgs\' own 127.0.0.1:11434, where auto looks, so a system\'s own value wins')
  assert.match(module, /OLLAMA_IGPU_ENABLE = lib\.mkDefault "1";/, 'an integrated GPU only when asked for')
  assert.match(module, /ask connect ollama http:\/\/localhost:/, 'the port warning names the command that works under auto')
  assert.doesNotMatch(module, /^\s*acceleration = (?!lib\.mkOption)/m, 'services.ollama.acceleration is gone in nixpkgs 26.05')
  for (const never of [/openFirewall/, /OLLAMA_HOST/, /modelsDir/, /services\.ollama\.models\b/, /OLLAMA_CONTEXT_LENGTH/]) assert.doesNotMatch(module, never, String(never))
  const flakeChecks = read('flake.nix')
  for (const proof of ['plain.pkgs.ollama-vulkan.drvPath', 'cpu.pkgs.ollama-cpu.drvPath', 'cuda.config.hardware.graphics.enable', '(env igpu).OLLAMA_IGPU_ENABLE == "1"', '(env ownDefault).OLLAMA_HOST == "0.0.0.0:11434"', '!(builtins.tryEval cuda.config.services.ollama.package.drvPath).success', '(env theirs).OLLAMA_ORIGINS == "https://b.example"', 'lib.length (ours theirs) == 3']) assert.ok(flakeChecks.includes(proof), `nix flake check proves ${proof}`)
})

test('CI boots the Ollama option in a NixOS VM, in a job of its own outside nix flake check, and fails without KVM', () => {
  const flake = read('flake.nix')
  assert.match(flake, /^ {6}vmTests = forAll \(/m, 'an output of its own')
  assert.match(flake, /import \.\/tools\/nix\/ollama-test\.nix \{ module = self\.nixosModules\.default; \}/, 'the flake\'s own module, not a copy')
  const checks = flake.slice(flake.indexOf('      checks = forAll ('))
  assert.ok(flake.indexOf('vmTests = forAll') < flake.indexOf('      checks = forAll ('))
  for (const never of ['ollama-test', 'runNixOSTest', 'vmTests']) assert.ok(!checks.includes(never), `checks holds no ${never}: nix flake check runs without KVM`)

  const vm = read('tools/nix/ollama-test.nix')
  assert.equal(headers.licenseOf('tools/nix/ollama-test.nix'), 'mit')
  assert.match(vm, /^\{ module \}:$/m)
  assert.match(vm, /imports = \[ module \];/)
  assert.match(vm, /acceleration = "cpu";/, 'the runner has no GPU, and the binary cache has the CPU build')
  assert.match(vm, /qemu\.forceAccel = true;/, 'no KVM is an error, never software emulation')
  assert.ok(vm.includes(`LAUNCHER = "http://127.0.0.1:${launcher.PORT}"`), 'the launcher\'s own origin')
  for (const proof of ['machine.wait_for_unit("ollama.service")', 'assert listeners == ["127.0.0.1:11434"]', 'assert tags == {"models": []}', 'for origin in (LAUNCHER, EXTRA):', 'assert got == ("200", origin)', 'assert got == ("403", None)', 'assert f"OLLAMA_ORIGINS={EXTRA}" in env']) assert.ok(vm.includes(proof), `the VM test checks ${proof}`)

  const jobs = read('.github/workflows/nix.yml').split(/^jobs:$/m)[1] ?? ''
  const [flakeJob = '', vmJob = ''] = jobs.split(/^ {2}vm:$/m)
  assert.ok(vmJob, 'the VM runs in a job of its own')
  assert.match(flakeJob, /nix flake check/)
  assert.doesNotMatch(flakeJob, /kvm/i, 'nix flake check\'s job needs no KVM')
  assert.match(vmJob, /timeout-minutes: \d+/)
  assert.match(vmJob, /if \[ ! -c \/dev\/kvm \]; then\n\s+echo "::error::[^"\n]+"\n\s+exit 1/, 'no KVM fails, saying so')
  assert.ok(vmJob.includes('KERNEL=="kvm", GROUP="kvm", MODE="0666"'), 'the udev rule opens /dev/kvm to Nix\'s build users')
  assert.match(vmJob, /udevadm trigger --name-match=kvm/)
  assert.match(vmJob, /extra-system-features = kvm nixos-test/)
  assert.ok(vmJob.indexOf('/dev/kvm') < vmJob.indexOf('install-nix'), 'KVM is checked before anything is installed')
  assert.match(vmJob, /run: nix build -L --no-link \.#vmTests\.x86_64-linux\.ollama$/m)
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

/** No amdgpu folder: the nvidia-smi cases never fall through to this machine's own /sys. */
const NO_DRM = { list: (): string[] => { throw new Error('no driver folder') } }

test('gpuMemory reads nvidia-smi\'s MiB per GPU, skips [N/A] and GPUs under 4 GiB, and rounds the sum down to 0.1 GB', () => {
  assert.equal(launcher.GPU_FLOOR_BYTES, 4 * 2 ** 30)
  assert.deepEqual(launcher.gpuMemory({ smi: () => '24564\n24564\n', ...NO_DRM }), { gb: 47.9, from: 'nvidia-smi' })
  assert.deepEqual(launcher.gpuMemory({ smi: () => '24564\n', ...NO_DRM }), { gb: 23.9, from: 'nvidia-smi' }, 'a 24 GB card: 23.99 GiB, rounded down')
  assert.deepEqual(launcher.gpuMemory({ smi: () => '81559\n81559\n81559\n81559\n', ...NO_DRM }), { gb: 318.5, from: 'nvidia-smi' }, 'four 80 GB cards')
  assert.deepEqual(launcher.gpuMemory({ smi: () => ' 24564 \r\n[N/A]\n2048\n', ...NO_DRM }), { gb: 23.9, from: 'nvidia-smi' }, 'spaces and a CRLF trimmed; [N/A] and a 2 GiB GPU not counted')
  // Nothing nvidia-smi said counts: the amdgpu driver is asked next, and with none of it, no figure.
  const amd = { list: () => ['card0'], read: () => '25753026560\n' }
  assert.deepEqual(launcher.gpuMemory({ smi: () => '[N/A]\n2048\n', ...amd }), { gb: 23.9, from: 'amdgpu' }, '[N/A] and a carve-out fall through')
  assert.equal(launcher.gpuMemory({ smi: () => '[N/A]\n2048\n', ...NO_DRM }), null)
  assert.deepEqual(launcher.gpuMemory({ smi: () => null, ...amd }), { gb: 23.9, from: 'amdgpu' }, 'no nvidia-smi, or one that failed')
  assert.equal(launcher.gpuMemory({ smi: () => '', ...NO_DRM }), null)
  assert.equal(launcher.gpuMemory({ smi: () => '24564.5\n-24564\n0x6000\n1e5\n', ...NO_DRM }), null, 'only whole MiB')
  assert.equal(launcher.gpuMemory({ smi: () => '9'.repeat(30), ...NO_DRM }), null, 'a count past any GPU is not believed')
  assert.equal(launcher.gpuMemory({ smi: () => `${'81559\n'.repeat(64)}`, ...NO_DRM }), null, 'above the page\'s 4096 GB ceiling: no figure')
})

test('both desktops: the launcher and the Windows app sum and round alike, and a 4 GB card counts on both though DXGI reads it a little under', () => {
  const MIB = 2 ** 20
  // DXGI's dedicated memory runs a little under nvidia-smi's total, so the app's floor sits under the launcher's.
  assert.ok(DXGI_FLOOR_BYTES < launcher.GPU_FLOOR_BYTES && DXGI_FLOOR_BYTES > 3 * 2 ** 30)
  // The same byte counts (none between the two floors): the same figure.
  for (const mib of [[24564], [24564, 24564], [81559, 81559, 81559, 81559], [2048], [2048, 8192], [3072], [4096], [], Array.from({ length: 64 }, () => 81559), Array.from({ length: 51 }, () => 81920)]) {
    const smi = launcher.gpuMemory({ smi: () => mib.map((m) => `${m}\n`).join(''), ...NO_DRM })
    assert.equal(figureFromAdapters(mib.map((m) => m * MIB)), smi?.gb ?? null, mib.join(','))
  }
  // One 4 GB card as each reads it: nvidia-smi's 4096 MiB, and DXGI's 3,949 MB (dxdiag's figure for one such card in a
  // public report). A figure on both, the app's a little smaller.
  assert.deepEqual(launcher.gpuMemory({ smi: () => '4096\n', ...NO_DRM }), { gb: 4, from: 'nvidia-smi' })
  assert.equal(figureFromAdapters([3949 * MIB]), 3.8)
})

test('gpuMemory falls back to the amdgpu driver\'s VRAM per card in a temporary sysfs tree; connector folders and carve-outs are skipped', () => {
  const drm = mkdtempSync(join(tmpdir(), 'launcher-drm-'))
  const card = (name: string, text: string | null) => {
    mkdirSync(join(drm, name, 'device'), { recursive: true })
    if (text !== null) writeFileSync(join(drm, name, 'device', 'mem_info_vram_total'), text)
  }
  try {
    assert.equal(launcher.gpuMemory({ smi: () => null, drm }), null, 'an empty folder: no figure')
    card('card0', '25753026560\n')
    assert.deepEqual(launcher.gpuMemory({ smi: () => null, drm }), { gb: 23.9, from: 'amdgpu' })
    // The same bytes again under names that are not cards: a connector and a render node.
    card('card0-DP-1', '25753026560\n')
    card('renderD128', '25753026560\n')
    card('card1', '536870912\n')
    card('card2', null)
    card('card3', 'not a number\n')
    assert.deepEqual(launcher.gpuMemory({ smi: () => null, drm }), { gb: 23.9, from: 'amdgpu' }, 'the connector, the render node, a 512 MiB carve-out, a card with no file and one with no number are skipped')
    card('card4', '17163091968\n')
    assert.deepEqual(launcher.gpuMemory({ smi: () => null, drm }), { gb: 39.9, from: 'amdgpu' }, 'two cards add up')
    assert.deepEqual(launcher.gpuMemory({ smi: () => '24564\n', drm }), { gb: 23.9, from: 'nvidia-smi' }, 'nvidia-smi\'s figure comes first')
    assert.equal(launcher.gpuMemory({ smi: () => null, drm: join(drm, 'missing') }), null, 'no driver folder: no figure, nothing thrown')
  } finally {
    rmSync(drm, { recursive: true, force: true })
  }
})

test('withVram: vram= on the command line wins, vram=0 included; else the probe\'s figure is added; no figure, nothing added', () => {
  let asked = 0
  const probe = () => { asked++; return { gb: 23.9, from: 'nvidia-smi' } }
  for (const words of [['vram=0'], ['quality=4', 'vram=12'], ['vram']]) {
    const o = launcher.options(words, { AGENT_CITY_DIST: '/srv/page' })
    const before = o.query.toString()
    assert.equal(launcher.withVram(o.query, probe), null, words.join(' '))
    assert.equal(o.query.toString(), before, words.join(' '))
  }
  assert.equal(asked, 0, 'a figure on the command line is not even probed')

  const o = launcher.options(['quality=4'], { AGENT_CITY_DIST: '/srv/page' })
  assert.deepEqual(launcher.withVram(o.query, probe), { gb: 23.9, from: 'nvidia-smi' })
  assert.equal(o.query.toString(), 'quality=4&vram=23.9')
  assert.equal(asked, 1)
  const whole = new URLSearchParams()
  launcher.withVram(whole, () => ({ gb: 24, from: 'amdgpu' }))
  assert.equal(whole.toString(), 'vram=24.0', 'always one decimal, as the page reads it')

  const none = new URLSearchParams('players=2')
  assert.equal(launcher.withVram(none, () => null), null)
  assert.equal(none.toString(), 'players=2', 'no figure: the address is main\'s')
})

test('--check never probes the GPU, the help names vram=, the ceiling is the page\'s, and nothing runs through a shell', () => {
  const src = read('tools/web/launch.mjs')
  const check = src.indexOf('if (o.check) return')
  const probe = src.indexOf('withVram(o.query)')
  assert.ok(check > 0 && probe > check, '--check returns before the probe')
  assert.equal(src.split('withVram(o.query)').length, 2, 'one probe, in main')
  const help = /const HELP = `([^`]*)`/.exec(src)
  assert.ok(help, 'the launcher has its HELP text')
  assert.match(help[1], /vram=<GB>/)
  assert.equal(launcher.VRAM_MAX_GB, VRAM_MAX_GB, 'the launcher never hands the page a figure it would ignore')
  assert.doesNotMatch(src, /\bexecSync?\s*\(|shell:\s*true/)
  assert.match(src, /spawnSync\('nvidia-smi', \[/, 'nvidia-smi by name with an argument list')
})
