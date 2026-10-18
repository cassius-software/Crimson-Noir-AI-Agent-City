// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page's last way out, index.html's boot watchdog, which has to work where
 * nothing else of the page does: it is classic ES5 (no arrow, no let or const, no template), it sits in <head> before
 * the page's module (in the source and, once built, in dist/index.html, where the module stands after the splash at
 * the end of the body: vite.config.ts moduleAfterBody), and, run here in a fake page, it draws its card with Restart focused when the module never ran (a cut-off
 * download), when it could not be read (a SyntaxError) or when it threw while loading, adds what the city will need
 * where the browser plainly lacks it (a secure address, iOS 26, WebGPU; nothing under ?boot=tty), and stays out of
 * the way once main.tsx said it started; Enter and a pad's A restart, and the console it may offer keeps the page's
 * other query words. The <noscript> words and main.tsx's hand-over of React's uncaught errors are pinned too.
 * What breaks if it is removed? A browser that cannot run the page could be left on a black splash with nothing to
 * press, in the installed iPhone app and the Windows app that have no reload of their own, with no test to notice.
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Script, createContext } from 'node:vm'
import { moduleAfterBody } from '../vite.config.ts'

const SOURCE = readFileSync(new URL('../index.html', import.meta.url), 'utf8')
const DIST = new URL('../dist/index.html', import.meta.url)
const MAIN = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8')

/** The watchdog's code: the classic script with id boot-watchdog. */
function watchdog(html: string): string {
  const m = html.match(/<script id="boot-watchdog">([\s\S]*?)<\/script>/)
  assert.ok(m, 'one boot-watchdog script')
  return m[1]
}

/** The page's layout as the watchdog must find it: in <head>, before the first module script. */
function assertOrder(html: string, where: string): void {
  const dog = html.indexOf('<script id="boot-watchdog">'), mod = html.indexOf('<script type="module"'), head = html.indexOf('</head>')
  assert.ok(dog > 0, `${where}: the watchdog is there`)
  assert.ok(mod > 0, `${where}: the module is there`)
  assert.ok(dog < mod, `${where}: the watchdog comes before the page's module`)
  assert.ok(dog < head, `${where}: in <head>, so it has run before any of the body is parsed`)
  assert.equal(html.split('<script id="boot-watchdog">').length, 2, `${where}: once`)
}

test('the watchdog is classic ES5 in <head> before the page\'s module, in the source and in the built single file', () => {
  assertOrder(SOURCE, 'index.html')
  const code = watchdog(SOURCE)
  assert.doesNotMatch(code, /=>|`|\b(?:let|const|class|async|await)\s/, 'ES5: an old browser parses it')
  assert.doesNotMatch(code, /\binset:|overflow-wrap:\s*anywhere/, 'and lays the card out')
  if (existsSync(DIST)) {
    const built = readFileSync(DIST, 'utf8')
    assertOrder(built, 'dist/index.html')
    assert.doesNotMatch(watchdog(built), /%BRAND_/, 'the brand tokens are filled in')
    assert.match(built, /<noscript>/)
  }
})

test('the built page paints its splash before the 10 MB module has downloaded: the module ends the body', () => {
  const page = '<html><head><script id="boot-watchdog">w()</script><script type="module" crossorigin>a("<script>");b()</script><style>x</style></head><body><div id="root">splash</div><noscript>n</noscript></body></html>'
  const moved = moduleAfterBody(page)
  assert.equal(moved, '<html><head><script id="boot-watchdog">w()</script><style>x</style></head><body><div id="root">splash</div><noscript>n</noscript><script type="module" crossorigin>a("<script>");b()</script>\n  </body></html>')
  assert.equal(moved.length, page.length + 3, 'nothing lost but the line break added')
  const two = page.replace('<style>', '<script type="module">c()</script><style>')
  assert.equal(moduleAfterBody(two), two, 'two module scripts: left as it is')
  assert.equal(moduleAfterBody('<html><body></body></html>'), '<html><body></body></html>', 'none: left as it is')
  if (existsSync(DIST)) {
    const built = readFileSync(DIST, 'utf8')
    const mod = built.indexOf('<script type="module"'), root = built.indexOf('<div id="root">'), body = built.lastIndexOf('</body>')
    assert.ok(root > 0 && root < mod, 'dist/index.html: the splash comes before the module')
    assert.ok(built.indexOf('</script>', mod) < body, 'dist/index.html: and the module ends inside the body')
  }
})

test('without JavaScript the page says how to turn it on, and that the Files app preview runs no scripts', () => {
  const m = SOURCE.match(/<body>[\s\S]*<noscript>([\s\S]*?)<\/noscript>[\s\S]*<\/body>/)
  assert.ok(m, 'a <noscript> in the body')
  assert.match(m[1], /%BRAND_NAME% needs JavaScript/)
  assert.match(m[1], /Settings &gt; Apps &gt; Safari &gt; Advanced &gt; JavaScript/)
  assert.match(m[1], /Files app.*open the page's https:\/\/ address in Safari/s)
  assert.match(m[1], /z-index: 10002/, 'above the splash')
})

/** A fake element: enough DOM for the watchdog's card. */
class El {
  tagName: string
  children: (El | { text: string })[] = []
  attrs: Record<string, string> = {}
  type = ''
  onclick: (() => void) | null = null
  private page: Page
  constructor(tag: string, page: Page) { this.tagName = tag.toUpperCase(); this.page = page }
  setAttribute(k: string, v: string) { this.attrs[k] = v }
  getAttribute(k: string) { return this.attrs[k] ?? null }
  appendChild(c: El | { text: string }) { this.children.push(c); return c }
  focus() { this.page.document.activeElement = this }
  click() { this.onclick?.() }
  get text(): string { return this.children.map((c) => c.text).join('') }
  /** Every element below this one, depth first. */
  all(): El[] { return this.children.flatMap((c) => (c instanceof El ? [c, ...c.all()] : [])) }
}

/** A fake page the watchdog runs in. */
class Page {
  listeners: Record<string, ((e: unknown) => void)[]> = {}
  timers: (() => void)[] = []
  intervals: (() => void)[] = []
  reloads = 0
  assigned: string[] = []
  pads: { buttons: { pressed: boolean }[] }[] = []
  body: El
  document: { body: El; documentElement: El; activeElement: El | null; createElement(t: string): El; createTextNode(t: string): { text: string }; querySelector(q: string): unknown }
  window: Record<string, unknown>
  ua = 'TestAgent/1.0'
  nav: Record<string, unknown> = {}
  constructor(search = '') {
    this.body = new El('body', this)
    this.document = {
      body: this.body,
      documentElement: new El('html', this),
      activeElement: null,
      createElement: (t) => new El(t, this),
      createTextNode: (t) => ({ text: t }),
      querySelector: (q) => (q === 'meta[name="application-name"]' ? { getAttribute: () => 'Crimson Noir: Agent City' } : null),
    }
    this.window = {
      location: { search, pathname: '/play/index.html', hash: '', reload: () => { this.reloads++ }, assign: (u: string) => { this.assigned.push(u) } },
      addEventListener: (t: string, f: (e: unknown) => void) => { (this.listeners[t] ??= []).push(f) },
    }
  }
  run(code: string) {
    const context = createContext({
      window: this.window,
      document: this.document,
      navigator: { userAgent: this.ua, getGamepads: () => this.pads, ...this.nav },
      setTimeout: (f: () => void) => { this.timers.push(f) },
      setInterval: (f: () => void) => { this.intervals.push(f) },
    })
    new Script(code).runInContext(context)
  }
  fire(type: string, e: unknown = {}) {
    for (const f of this.listeners[type] ?? []) f(e)
    for (const t of this.timers.splice(0)) t()
  }
  get card(): El | undefined { return this.body.children.find((c): c is El => c instanceof El && c.attrs.role === 'alertdialog') }
  buttons(): El[] { return this.card?.all().filter((e) => e.tagName === 'BUTTON') ?? [] }
}

test('a module that never ran: at load the card says so, with Restart focused and no console', () => {
  const p = new Page()
  p.run(watchdog(SOURCE))
  p.fire('load')
  const card = p.card
  assert.ok(card, 'the card is up')
  assert.equal(card.all().find((e) => e.tagName === 'H1')?.text, 'Crimson Noir: Agent City couldn’t start', 'the name from the page\'s application-name')
  assert.match(card.all().map((e) => e.text).join(' '), /did not finish downloading, or this browser did not run its script/)
  assert.match(card.all().map((e) => e.text).join(' '), /Software Update/)
  assert.deepEqual(p.buttons().map((b) => b.text), ['Restart'], 'the console is in the same script that never ran')
  assert.equal(p.document.activeElement, p.buttons()[0], 'Restart has focus')
  p.buttons()[0].click()
  assert.equal(p.reloads, 1, 'Restart reloads the page')
})

test('a SyntaxError or a throw while loading has its own words and its message; a page that started is left alone', () => {
  const old = new Page()
  old.run(watchdog(SOURCE))
  old.fire('error', { error: { name: 'SyntaxError', message: 'Unexpected token \'?\'' } })
  old.fire('load')
  const words = old.card!.all().map((e) => e.text).join(' ')
  assert.match(words, /could not read the page’s script: it is older than Crimson Noir: Agent City needs, or the download was cut off/)
  assert.match(words, /SyntaxError: Unexpected token '\?' · build %BRAND_VERSION% · TestAgent\/1\.0/, 'the detail line (the token is filled at build)')
  const threw = new Page()
  threw.run(watchdog(SOURCE))
  threw.fire('error', { error: { name: 'TypeError', message: 'x is not a function' } })
  threw.fire('load')
  assert.match(threw.card!.all().map((e) => e.text).join(' '), /stopped while it was loading.*TypeError: x is not a function/s)
  const fine = new Page()
  fine.run(watchdog(SOURCE))
  fine.window.__bootDone = true
  fine.fire('error', { error: { name: 'Error', message: 'later' } })
  fine.fire('load')
  assert.equal(fine.card, undefined, 'main.tsx said it started: no card')
})

test('what the city will need, where the browser plainly lacks it; nothing of the GPU under ?boot=tty', () => {
  const words = (p: Page) => { p.run(watchdog(SOURCE)); p.fire('load'); return p.card!.all().map((e) => e.text).join(' ') }
  const old = new Page('?map=lakefront')
  old.ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
  assert.match(words(old), /needs iOS 26 on this iPhone \(iPhone 11, iPhone SE \(2nd generation\) and newer\)/)
  const ipad = new Page()
  ipad.ua = 'Mozilla/5.0 (iPad; CPU OS 17_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.7 Mobile/15E148 Safari/604.1'
  assert.match(words(ipad), /needs iPadOS 26 on this iPad/)
  const plain = new Page()
  plain.window.isSecureContext = false
  assert.match(words(plain), /needs a secure address: open the page over https:\/\//)
  assert.match(words(new Page()), /needs WebGPU: a current Chrome, Edge or Brave, or Safari 26/, 'no navigator.gpu')
  const home = new Page()
  home.ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  home.nav = { standalone: true }
  assert.match(words(home), /needs iOS 26 on this iPhone/, 'a home-screen app has no Version/ token: no WebGPU there means an old iOS')
  const homeNew = new Page()
  homeNew.ua = home.ua
  homeNew.nav = { standalone: true, gpu: {} }
  assert.doesNotMatch(words(homeNew), /also needs/, 'a home-screen app with WebGPU is told nothing more')
  const app = new Page()
  app.window.__TAURI_INTERNALS__ = {}
  const appWords = words(app)
  assert.match(appWords, /needs WebGPU: update WebView2 \(Windows Update\) and the graphics driver/, 'the Windows app')
  assert.doesNotMatch(appWords, /Chrome|Safari/, 'the Windows app cannot switch browsers')
  const fine = new Page()
  fine.nav = { gpu: {} }
  assert.doesNotMatch(words(fine), /also needs/, 'a browser with WebGPU on a secure page is told nothing more')
  const tty = new Page('?boot=tty')
  tty.ua = old.ua
  assert.doesNotMatch(words(tty), /also needs|WebGPU|iOS 26/, 'the console needs no GPU and no iOS 26')
})

test('__bootFatal draws once, offers the console on ?boot=tty keeping the other query words, and Enter and A restart', () => {
  const p = new Page('?map=lakefront&boot=gui&players=2')
  p.run(watchdog(SOURCE))
  const fatal = p.window.__bootFatal as (t: string, l: string[], d: string, c: boolean) => void
  fatal('Crimson Noir: Agent City stopped', ['Something failed.'], 'Error: boom', true)
  fatal('again', [], '', false)
  assert.equal(p.body.children.length, 1, 'once')
  assert.deepEqual(p.buttons().map((b) => b.text), ['Restart', 'Open the console'])
  p.buttons()[1].click()
  assert.deepEqual(p.assigned, ['/play/index.html?boot=tty&map=lakefront&players=2'])
  // Enter outside a button restarts (a focused button takes Enter natively).
  p.fire('keydown', { key: 'Enter', target: { tagName: 'BODY' } })
  assert.equal(p.reloads, 1)
  p.fire('keydown', { key: 'Enter', target: { tagName: 'BUTTON' } })
  assert.equal(p.reloads, 1)
  // A pad's A: an edge, so the A held when the card appeared does nothing until it is let go.
  p.pads = [{ buttons: [{ pressed: true }] }]
  p.document.activeElement = p.buttons()[0]
  for (const f of p.intervals) f()
  assert.equal(p.reloads, 1, 'held from before: nothing')
  p.pads = [{ buttons: [{ pressed: false }] }]
  for (const f of p.intervals) f()
  p.pads = [{ buttons: [{ pressed: true }] }]
  for (const f of p.intervals) f()
  assert.equal(p.reloads, 2, 'a fresh press of A presses the focused Restart')
  // A second pad that shows up with A down (a browser reveals a pad on a press) presses nothing until it is let go.
  p.pads = [{ buttons: [{ pressed: false }] }, { buttons: [{ pressed: true }] }]
  for (const f of p.intervals) f()
  assert.equal(p.reloads, 2, 'a pad appearing with A down: nothing')
  p.pads = [{ buttons: [{ pressed: false }] }, { buttons: [{ pressed: false }] }]
  for (const f of p.intervals) f()
  p.pads = [{ buttons: [{ pressed: false }] }, { buttons: [{ pressed: true }] }]
  for (const f of p.intervals) f()
  assert.equal(p.reloads, 3, 'then let go and pressed: a press')
})

test('main.tsx hands React\'s uncaught errors to the watchdog and stands it down once it has run', () => {
  assert.match(MAIN, /createRoot\(document\.getElementById\('root'\)!, \{\n\s+\/\/[^\n]*\n[^\n]*\n\s+onUncaughtError\(error\) \{/)
  assert.match(MAIN, /window\.__bootFatal\?\.\(/)
  assert.match(MAIN, /<\/StrictMode>,\n\)\n\/\/[^\n]*\nwindow\.__bootDone = true\n/, 'right after render')
})
