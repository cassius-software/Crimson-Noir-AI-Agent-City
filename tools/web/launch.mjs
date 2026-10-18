#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the one command that opens the built city on a Linux desktop, and what `nix run`
 * runs (flake.nix). It serves dist/index.html to this machine only (127.0.0.1) with the two cross-origin isolation
 * headers, so the physics bridge shares memory with its worker as it does under `npm run preview`, and opens it in
 * Chrome or Chromium as an app window with WebGPU on Vulkan. The address stays http://127.0.0.1:4180 from one run to
 * the next because the page keeps its settings (the onboarding, the map, the room token, a model key) per address,
 * and a local model server such as Ollama accepts a loopback address but not a page opened from a file. The browser
 * gets a profile of its own, so its WebGPU switches apply even while another Chrome window is open.
 * Usage: node tools/web/launch.mjs [key=value ...] [--port 4180] [--dir dist] [--x11] [--no-browser] [--check].
 * Each key=value becomes a query parameter of the page (quality=4, map=lakefront, players=2: MANUAL.md, On NixOS).
 * AGENT_CITY_PORT, AGENT_CITY_DIST, AGENT_CITY_X11=1 and AGENT_CITY_CHROME_FLAGS (extra switches, space separated) set
 * the same from the environment; CHROME names the browser (a path, or a command on PATH). `--check` is CI's proof that
 * the launcher's server serves the page so it runs: it serves the page on a free port to a headless browser on the
 * software adapter and exits 0 once the city draws frames, cross-origin isolated and with no exception on the page.
 * What breaks if it is removed? `nix run` and the NixOS package have nothing to start; dist/index.html still plays
 * from a disk (with the copying bridge) or under `npm run preview`.
 */
import { spawn } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { homedir, hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Browser, findChrome, SOFTWARE_WEBGPU } from '../browser/cdp.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The fixed address's port: not one the repo's other servers use (5173, 4173, 8787, 8089, 8090, 8880, 11434, 8080, 1234). */
export const PORT = 4180

/** The X11 window class of the app window, which the desktop entry's StartupWMClass names. */
export const APP_CLASS = 'crimson-noir-agent-city'

/** The profile's folder inside the browser's data folder: named, not Chromium's `Default`, because it is part of the
 *  window's Wayland name, which would otherwise be every Chromium app window's on 127.0.0.1 (Syncthing's, a dev
 *  server's). */
export const PROFILE_NAME = 'AgentCity'

/** What Chromium names the app window under Wayland, where it ignores --class: built from the address's host and path
 *  (no port, no query) and the profile's folder. tools/nix/app.nix gives it a hidden desktop entry. */
export const WAYLAND_APP_ID = `chrome-127.0.0.1__-${PROFILE_NAME}`

/** Every answer's headers: isolation for the shared bridge, nothing cached (a new build shows at once). The page
 *  carries its own content policy. */
export const HEADERS = Object.freeze({
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
})

/** A second launch's question and a serving launcher's answer: the question carries a fresh random nonce, the answer
 *  is the nonce signed with the server's token (HMAC-SHA256), and the token sits in a file only this user can read. So
 *  the token itself is never sent, an old answer is no use for a new question, and only this user's own launcher can
 *  answer: the second launch opens the profile (and the keys it keeps for the address) on nothing else. */
export const CHALLENGE = 'X-Agent-City-Challenge'
export const MARK = 'X-Agent-City-Launcher'

/** The answer to a challenge: the nonce signed with the token. */
export const proof = (token, nonce) => createHmac('sha256', token).update(nonce).digest('hex')

/** The signals that end the launcher; each one still runs its exit handlers (the window and the token file go too). */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']

/** The page's light load for a software rasterizer (tools/browser/smoke.mjs LIGHT): what `--check` opens. */
const LIGHT = 'debug&onboarding=0&crowd=512&cars=8&scale=0.5&cinema=0&audio=0'

/** How long `--check` waits for the first frames on the software adapter. */
const CHECK_MS = 240_000

/** Reads the command line and the environment; the command line wins. Throws on a word it does not know. */
export function options(argv = process.argv.slice(2), env = process.env) {
  const extra = (env.AGENT_CITY_CHROME_FLAGS ?? '').split(/\s+/).filter(Boolean)
  // Split on spaces with no quoting: a stray word would reach Chromium as an address to open beside the app window.
  for (const w of extra) if (!w.startsWith('-')) throw new Error(`AGENT_CITY_CHROME_FLAGS takes switches only, each starting with -- and with no space in its value: ${w}`)
  const o = {
    dir: env.AGENT_CITY_DIST || join(ROOT, 'dist'),
    port: Number(env.AGENT_CITY_PORT || PORT),
    query: new URLSearchParams(),
    x11: env.AGENT_CITY_X11 === '1',
    browser: true,
    check: false,
    help: false,
    extra,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const value = () => {
      const v = argv[++i]
      if (v === undefined || v.startsWith('-')) throw new Error(`${a} needs a value (try --help)`)
      return v
    }
    if (a === '--port') o.port = Number(value())
    else if (a === '--dir') o.dir = value()
    else if (a === '--x11') o.x11 = true
    else if (a === '--no-browser') o.browser = false
    else if (a === '--check') o.check = true
    else if (a === '--help' || a === '-h') o.help = true
    else if (/^[A-Za-z][\w-]*(=.*)?$/.test(a)) {
      const eq = a.indexOf('=')
      o.query.append(eq < 0 ? a : a.slice(0, eq), eq < 0 ? '' : a.slice(eq + 1))
    } else throw new Error(`unknown argument ${a} (try --help)`)
  }
  if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error(`not a port: ${o.port}`)
  o.dir = resolve(o.dir)
  return o
}

/**
 * The switches for the app window. Chrome keeps only the last --enable-features it is given, so every feature goes in
 * one list: Vulkan (WebGPU's backend on Linux), the window decorations a Wayland window needs (nixpkgs' wrapper asks
 * for them with its own list, which comes first and would otherwise be dropped), and any the extra switches name.
 * --enable-webgpu-developer-features gives the page the adapter's full name (adapter.info.description, empty
 * otherwise), which the governor reads to tell an AMD card from an AMD APU and to start a named card on its tier.
 */
export function chromeFlags({ url, profile, x11 = false, extra = [], env = process.env }) {
  const features = ['Vulkan']
  const wayland = !x11 && Boolean(env.WAYLAND_DISPLAY) && (env.XDG_SESSION_TYPE === 'wayland' || Boolean(env.NIXOS_OZONE_WL))
  if (wayland) features.push('WaylandWindowDecorations')
  const rest = []
  for (const f of extra) {
    const m = /^--enable-features=(.*)$/.exec(f)
    if (m) for (const name of m[1].split(',')) { if (name && !features.includes(name)) features.push(name) }
    else rest.push(f)
  }
  return [
    `--user-data-dir=${profile}`, `--profile-directory=${PROFILE_NAME}`, '--no-first-run', '--no-default-browser-check', '--password-store=basic',
    `--class=${APP_CLASS}`, '--window-size=1440,900', '--enable-unsafe-webgpu', '--enable-webgpu-developer-features',
    `--enable-features=${features.join(',')}`,
    ...(x11 ? ['--ozone-platform=x11'] : []), ...rest, `--app=${url}`,
  ]
}

/** Answers GET and HEAD for the page (/ and /index.html) and nothing else, every answer with HEADERS, and with the
 *  answer to a well-formed challenge when the launcher has a token. */
export function respond(page, token = '') {
  return (req, res) => {
    const nonce = req.headers[CHALLENGE.toLowerCase()]
    const headers = token && typeof nonce === 'string' && /^[0-9a-f]{32}$/.test(nonce) ? { ...HEADERS, [MARK]: proof(token, nonce) } : HEADERS
    // The path by plain string: a target no URL parser accepts (`//[`) must not throw out of the server.
    const path = (req.url ?? '/').split('?')[0]
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { ...headers, Allow: 'GET, HEAD' }).end(); return }
    if (path !== '/' && path !== '/index.html') { res.writeHead(404, headers).end(); return }
    res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': page.length })
    res.end(req.method === 'HEAD' ? undefined : page)
  }
}

/** Serves the page on 127.0.0.1 at `port` (0 picks a free one); resolves to the server, rejects with the listen error. */
export function serve(page, port, token = '') {
  const server = createServer(respond(page, token))
  return new Promise((ok, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => { server.off('error', fail); ok(server) })
  })
}

/** The launcher's folder under XDG state (else ~/.local/state), private to this user: the browser's profile. */
function stateDir(env = process.env) {
  const dir = join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), APP_CLASS)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Where the tokens live: the user's runtime folder when there is one (private, and emptied at logout and at boot, so
 *  a launcher killed outright leaves nothing behind for long), else the state folder. */
function runtimeDir(env = process.env) {
  if (!env.XDG_RUNTIME_DIR || !existsSync(env.XDG_RUNTIME_DIR)) return stateDir(env)
  const dir = join(env.XDG_RUNTIME_DIR, APP_CLASS)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/** Where a serving launcher keeps its token: readable by this user alone. Another user can bind the port too, and only
 *  the token tells this user's server from theirs. */
export const tokenFile = (dir, port) => join(dir, `server-${port}.token`)

/** Writes a new token for the port, readable by this user alone (a fresh file, then renamed over the old one). */
function writeToken(file, token) {
  const tmp = `${file}.${process.pid}`
  rmSync(tmp, { force: true })
  writeFileSync(tmp, token, { mode: 0o600, flag: 'wx' })
  renameSync(tmp, file)
}

/** Whether what answers on the port is this user's launcher: it must sign a fresh nonce with the token in this user's
 *  file. */
export function ours(port, file) {
  let token
  try { token = readFileSync(file, 'utf8').trim() } catch { return Promise.resolve(false) }
  if (!token) return Promise.resolve(false)
  const nonce = randomBytes(16).toString('hex')
  return new Promise((ok) => {
    const req = request({ host: '127.0.0.1', port, method: 'HEAD', path: '/', timeout: 2000, headers: { [CHALLENGE]: nonce } }, (res) => {
      res.resume()
      ok(res.headers[MARK.toLowerCase()] === proof(token, nonce))
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => ok(false))
    req.end()
  })
}

/** Whether a process lives (one of another user answers EPERM, and still lives). */
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}

/**
 * The browser already running with this profile on this machine, from Chromium's SingletonLock link
 * (`<hostname>-<pid>`), or null. A browser started on the profile then hands its window to that one and leaves.
 */
export function profileOwner(profile) {
  let target
  try { target = readlinkSync(join(profile, 'SingletonLock')) } catch { return null }
  const cut = target.lastIndexOf('-')
  const pid = Number(target.slice(cut + 1))
  if (cut < 1 || target.slice(0, cut) !== hostname() || !Number.isInteger(pid) || pid <= 0 || !alive(pid)) return null
  // A lock left by a crash can name a pid since reused: where /proc says what runs there, it must be this profile's.
  if (existsSync('/proc/self')) {
    try { if (!readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes(profile)) return null } catch { return null }
  }
  return pid
}

function readPage(dir) {
  const file = join(dir, 'index.html')
  if (!existsSync(file)) throw new Error(`no page at ${file}: run \`npm run build\` first, or pass --dir`)
  return readFileSync(file)
}

/** CI's proof: the launcher's own server, a headless browser on the software adapter, frames drawn, isolated, no
 *  exception on the page. The window's switches, profile and fixed port are src/desktopLauncher.test.ts's to hold. */
async function check(o) {
  const chrome = findChrome()
  if (!chrome) throw new Error('no Chrome or Chromium found: set CHROME')
  const server = await serve(readPage(o.dir), 0)
  const origin = `http://127.0.0.1:${server.address().port}`
  const browser = await Browser.launch(chrome, [...SOFTWARE_WEBGPU, '--window-size=960,540'])
  const errors = []
  browser.on('Runtime.exceptionThrown', (p) => errors.push(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text))
  let ok = false
  try {
    await browser.send('Page.navigate', { url: `${origin}/?${LIGHT}` })
    const fps = await browser.waitFor('!!window.__SIM__ && window.__SIM__.snapshot().output.fps', CHECK_MS)
    const page = await browser.eval(`({ isolated: crossOriginIsolated, shared: typeof SharedArrayBuffer === 'function',
      adapter: window.__SIM__.snapshot().process.gpu, tier: window.__SIM__.snapshot().quality?.label ?? null })`)
    console.log(`launcher check  ${origin}  ${chrome}`)
    console.log(`  frames drawn (${fps} fps on ${page.adapter}${page.tier ? `, ${page.tier}` : ''})`)
    console.log(`  cross-origin isolated: ${page.isolated}, SharedArrayBuffer: ${page.shared}`)
    console.log(`  exceptions: ${errors.length ? errors.slice(0, 3).join(' | ') : 'none'}`)
    ok = page.isolated && page.shared && errors.length === 0
  } finally {
    await browser.close()
    server.close()
  }
  return ok
}

const HELP = `Crimson Noir: Agent City launcher
  crimson-noir-agent-city [key=value ...] [--port N] [--dir DIR] [--x11] [--no-browser] [--check]
  key=value       a query parameter of the page (quality=4, map=lakefront, players=2, lite=1)
  --port N        the port on 127.0.0.1 (default ${PORT}; the page keeps its settings per address)
  --dir DIR       the folder holding index.html (default: the build's dist/)
  --x11           run the window under X11 (XWayland) when WebGPU will not start under Wayland
  --no-browser    serve only, and print the address
  --check         CI: boot the city headless on the software adapter and exit 0 once it draws
Environment: AGENT_CITY_PORT, AGENT_CITY_DIST, AGENT_CITY_X11=1, AGENT_CITY_CHROME_FLAGS (switches only, no spaces
inside a value), CHROME (a path, or a command on PATH such as google-chrome-stable).`

/** Said when Nix's Chromium dies at start off NixOS: the likeliest cause, and the way round it. */
const SANDBOX_HINT = `the browser stopped at start. Off NixOS, Nix's Chromium cannot start its sandbox where the distribution
restricts unprivileged user namespaces (Ubuntu 23.10 and newer): open the city in a browser installed from the
distribution or its vendor instead, e.g. CHROME=google-chrome-stable (MANUAL.md, On NixOS).`

/** Whether the browser is Nix's (a store path, or a link into the store such as ~/.nix-profile/bin/chromium). */
function fromStore(chrome) {
  try { return realpathSync(chrome).startsWith('/nix/store/') } catch { return false }
}

async function main() {
  const o = options()
  if (o.help) { console.log(HELP); return 0 }
  if (o.check) return (await check(o)) ? 0 : 1

  const page = readPage(o.dir)
  const query = o.query.toString()
  const url = `http://127.0.0.1:${o.port}/${query ? `?${query}` : ''}`
  const state = stateDir()
  const file = tokenFile(runtimeDir(), o.port)
  const token = randomBytes(16).toString('hex')
  let server = null
  try {
    server = await serve(page, o.port, token)
    writeToken(file, token)
    // The file goes with the server: removed on the way out, unless a later launcher has taken the port since.
    process.on('exit', () => { try { if (readFileSync(file, 'utf8') === token) rmSync(file) } catch { /* gone already */ } })
  } catch (e) {
    if (e?.code !== 'EADDRINUSE') throw e
    // The address must not move (the settings live with it): this user's launcher already there serves this window too.
    if (!(await ours(o.port, file))) throw new Error(`port ${o.port} on 127.0.0.1 is taken by another program or another user: free it, or pass --port (the page then starts with fresh settings)`)
    console.log(`the city is already served at ${url}`)
  }
  if (server) console.log(`serving the city at ${url} (this machine only; Ctrl+C stops it)`)
  if (!o.browser) {
    if (!server) return 0
    console.log('open it in Chrome or Chromium with WebGPU (chrome://gpu: "WebGPU: Hardware accelerated")')
    // Stopped by a signal, the process still runs its exit handlers, so the token file goes with the server.
    for (const s of SIGNALS) process.on(s, () => process.exit(130))
    return new Promise(() => {})
  }

  const chrome = findChrome()
  if (!chrome) {
    throw new Error(process.env.CHROME
      ? `CHROME=${process.env.CHROME} is neither a file nor a command on PATH`
      : 'no Chrome or Chromium found: install one, or set CHROME (open the address above in it)')
  }
  const profile = join(state, 'chromium')
  mkdirSync(profile, { recursive: true, mode: 0o700 })
  const child = spawn(chrome, chromeFlags({ url, profile, x11: o.x11, extra: o.extra }), { stdio: 'inherit' })
  const running = () => child.exitCode === null && child.signalCode === null
  // However the launcher ends (a crash included), its window goes with it, where a reload would load whatever took the
  // port next.
  process.on('exit', () => { if (running()) child.kill('SIGTERM') })
  const stop = () => {
    if (!running()) {
      if (server) console.error(`launcher: the window for ${url} stays open in the browser already running with this profile, now without its server: close it`)
      process.exit(130)
    }
    child.kill('SIGTERM')
    setTimeout(() => { child.kill('SIGKILL'); process.exit(130) }, 3000).unref()
  }
  for (const s of SIGNALS) process.on(s, stop)
  // A window on another launcher's server closes when that server stops, for the same reason.
  const watch = server ? null : setInterval(() => {
    ours(o.port, file).then((up) => {
      if (up || !running()) return
      console.log(`the server at ${url} stopped; closing the window`)
      child.kill('SIGTERM')
    })
  }, 3000)
  return new Promise((done, fail) => {
    const finish = (code) => {
      if (watch) clearInterval(watch)
      if (server) { server.closeAllConnections(); server.close() }
      done(code)
    }
    child.on('error', fail)
    child.on('exit', (code, signal) => {
      // A browser of this profile was running already (or started a moment before this one): this one handed it the
      // window and left, and the lock now names it. Serve while it runs.
      const owner = code === 0 ? profileOwner(profile) : null
      if (server && owner !== null && owner !== child.pid) {
        console.log(`the window opened in the browser already running with this profile (pid ${owner}); serving while it runs, Ctrl+C stops`)
        const timer = setInterval(() => { if (!alive(owner)) { clearInterval(timer); finish(0) } }, 2000)
        return
      }
      // Chromium ends a failed sandbox start with a trap (or an abort, headless); a wrapper that does not exec says so
      // in its exit code.
      const died = signal === 'SIGTRAP' || signal === 'SIGABRT' || code === 133 || code === 134
      if (died && fromStore(chrome) && !existsSync('/run/wrappers')) console.error(`launcher: ${SANDBOX_HINT}`)
      finish(code ?? (signal ? 1 : 0))
    })
  })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { console.error(`launcher: ${e instanceof Error ? e.message : e}`); process.exit(1) })
}
