/**
 * Why does this file exist? It pins the page-side wiring of Track B, the bootloader (console map item 9.2 A and B),
 * which the engine, the terminal and App carry and Node cannot run: the render switch (present() begins with the
 * guard, so nothing is drawn while the console has the screen, yet the sun, the step requests, the head, the
 * haptics and the audio go on and the governor holds), its one canvas clear, the bridge surface the console stage
 * binds (`render`, the brand's track), the snapshot field and the HUD's chip, the full-screen terminal that no key
 * closes, the ?boot=tty shell that builds no engine at all, and that nothing of it reaches the physics realm.
 * What breaks if it is removed? The guard could slide into frame() (skipping a step request), the shell could
 * quietly start the engine, or the realm's protocol could grow a render word, unnoticed.
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
const before = (src: string, first: string, second: string, why: string) => {
  const a = src.indexOf(first), b = src.indexOf(second)
  assert.ok(a >= 0, `missing ${first}`)
  assert.ok(b >= 0, `missing ${second}`)
  assert.ok(a < b, why)
}

/** Words no shipped line of this stage may carry (compliance.test.ts holds the product-wide list). */
const FORBIDDEN = /\btarget\b|\bthe matrix\b|\bmatrix[- ](?:style|like|rain|code|effect)\b|\bdigital rain\b|\bragdoll\b/i

test('engine: present() begins with the render guard, which keeps the sun fresh and draws nothing; frame() is unchanged', () => {
  const src = read('./engine.ts')
  const present = between(src, '  private present(', '  private expose(')
  const head = between(present, '  private present(', 'const cam = this.world.camera')
  assert.match(head, /if \(!this\.rendering\) \{\n\s*this\.sun = sunAt\(this\.hours\)\n\s*return\n\s*\}/, 'the guard, with the sun kept for the listener and the snapshot')
  assert.doesNotMatch(head, /\.render\(|crowd\.step\(|world\.update\(|flushDissolve/, 'nothing is drawn or culled before the guard')
  assert.ok(present.includes('this.post.render()') && present.includes('this.gpu.renderer.render(this.world.scene, cam)'), 'the draws stay in present()')
  // frame(): the pinned gated block (cinema.test.ts) is untouched, nothing returns after the pacer, and the only new
  // word is the governor's hold.
  const frame = between(src, '  frame(nowMs: number): void {', '  /** One drawn frame')
  const gated = /if \(this\.pacer === null \|\| this\.pacer\.tick\(nowMs\)\) \{\n((?:\s*\/\/.*\n)*)\s*if \(this\.pacer !== null\) this\.quality\.governor\.present\(nowMs\)\n\s*this\.present\(nowMs, st, focusX, focusZ\)\n\s*\}/
  assert.match(frame, gated, 'the pacer still gates present() alone')
  assert.doesNotMatch(frame.slice(frame.indexOf('this.pacer.tick(nowMs)')), /\breturn\b/)
  assert.match(frame, /^ {4}if \(this\.rendering && this\.quality\.governor\.sample\(realDt, nowMs\) !== null\) this\.applyTier\(\)$/m, 'the governor holds while nothing is drawn')
  assert.equal(frame.match(/this\.rendering/g)?.length, 1, 'the flag gates the governor and nothing else in frame()')
  assert.match(frame, /^ {4}if \(sim\.request\(\{ dt: this\.pendingDt, foot, drive \}\)\) this\.pendingDt = 0$/m, 'every animation frame still requests its step')
  assert.ok(frame.includes('this.listen(dt, st)'), 'the listener is fed whether or not a frame is drawn')
})

test('engine: setRendering clears the canvas once when turning off, cuts when turning on, and the bridge and snapshot carry it', () => {
  const src = read('./engine.ts')
  assert.match(src, /^ {2}private rendering = true$/m)
  const set = between(src, '  setRendering(on: boolean): string {', '  /**\n   * Ghost view on or off')
  assert.equal(src.match(/renderer\.clear\(\)/g)?.length, 1, 'one clear in the whole engine')
  assert.ok(set.includes('this.gpu.renderer.clear()'), 'it is the switch-off clear')
  before(set, 'this.rendering = on', 'this.gpu.renderer.clear()', 'the flag is set before the clear')
  assert.match(set, /if \(on\) \{\n\s*\/\/[^\n]*\n\s*this\.marked = false\n\s*return 'on'\n\s*\}/, 'on again: the next presented frame is a cut')
  assert.doesNotMatch(set, /sim\.send|applyTier|setTier|setAuto/, 'nothing reaches the realm or moves the tier')
  assert.doesNotMatch(set, FORBIDDEN)
  const snapshot = between(src, '  snapshot(): SipocSnapshot {', '  terminalBridge(')
  assert.match(snapshot, /^ {8}rendering: this\.rendering,$/m)
  assert.match(read('../05_Observe_Environment/telemetry.ts'), /^ {4}rendering\?: boolean$/m)
  const bridge = between(src, '  terminalBridge(gate: SkillGate', '  /** Control glyphs')
  assert.match(bridge, /render: \(arg\?: 'on' \| 'off'\) => \(arg === undefined \? \(this\.rendering \? 'on' : 'off'\) : this\.setRendering\(arg === 'on'\)\)/)
  assert.match(bridge, /brand: Object\.freeze\(\{ name: BRAND\.name, version: BRAND\.version, host: BRAND\.host, track: 'gui' as const \}\)/)
  // The facade the operator tier scripts see is untouched (operator.test.ts pins its keys): the switch is bridge-only.
  const controls = between(src, '  simControls(): SimControls {', '  /** ?debug harness hooks. */')
  assert.doesNotMatch(controls, /rendering|setRendering/)
})

test('bridge: render() is on the TerminalBridge, the offline stand-in refuses it, and the brand may name its track', () => {
  const src = read('./terminal/bridge.ts')
  assert.match(src, /^ {2}render\(arg\?: 'on' \| 'off'\): string$/m)
  assert.match(src, /readonly brand: \{ name: string; version: string; host: string; track\?: 'gui' \| 'tty' \}/)
  const off = offlineBridge({ name: 'T', version: '0', host: 't', track: 'tty' })
  assert.throws(() => off.render(), /engine not running/)
  assert.throws(() => off.render('off'), /engine not running/)
  assert.equal(off.brand.track, 'tty')
  assert.equal(offlineBridge({ name: 'T', version: '0', host: 't' }).brand.track, undefined)
  assert.match(read('./terminal/commands.ts'), /boot\?: 'gui' \| 'tty'/, 'the result field the boot command will set')
})

test('air gap: the physics realm names nothing of the render switch or the boot track', () => {
  for (const file of ['./simProtocol.ts', './simCore.ts', './physics.worker.ts']) {
    assert.doesNotMatch(read(file), /setRendering|\brendering\b|renderer\.clear|boot=tty|\btty\b|TtyShell|GuiShell/i, file)
  }
  // The realm's client on the page carries no switch either (its one 'rendering' is prose about the parallel thread).
  assert.doesNotMatch(read('./simClient.ts'), /setRendering|renderer\.clear|boot=tty|\btty\b|TtyShell|GuiShell/i)
})

test('terminal: full screen is open from the start, black, full height, and neither the toggle key, Esc nor `exit` closes it; a boot result reaches the host', () => {
  const src = read('./terminal/Terminal.tsx')
  assert.match(src, /fullscreen\?: boolean/)
  assert.match(src, /onBoot\?\(track: 'gui' \| 'tty'\): void/)
  assert.match(src, /const \[open, setOpen\] = useState\(fullscreen\)/, 'open from the first render')
  assert.match(src, /\.r0-root\[data-full\]\{height:100%;[^}]*background:#000[^}]*\}/, 'full height, black')
  assert.match(src, /data-full=\{fullscreen \|\| undefined\}/)
  const keys = between(src, 'const onKey = (e: KeyboardEvent) => {', "window.addEventListener('keydown', onKey, true)")
  assert.match(keys, /if \(isToggleKey\(e\)\) \{\n\s*if \(fullRef\.current\) return/, 'the toggle key does not close it')
  assert.match(keys, /if \(e\.key === 'Escape' && !live && fullRef\.current\) return/, 'Esc does not close it')
  assert.match(src, /if \(r\.close && !fullscreen\) setOpen\(false\)/, '`exit` does not close it')
  assert.match(src, /if \(r\.boot\) onBoot\?\.\(r\.boot\)/)
})

test('app: ?boot=tty mounts the full-screen terminal alone over the offline bridge; reboot(track) reloads the page on that track', () => {
  const app = read('../App.tsx')
  assert.match(app, /boot: q\.get\('boot'\) === 'tty' \? 'tty' : 'gui'/)
  assert.match(app, /const \[options\] = useState\(readOptions\)/, 'read once')
  assert.match(app, /options\.boot === 'tty' \? <TtyShell \/> : <GuiShell options=\{options\} \/>/)
  const tty = between(app, 'function TtyShell() {', 'function App() {')
  assert.match(tty, /<Terminal bridge=\{TTY_BRIDGE\} fullscreen onOpenChange=\{noop\} onBoot=\{reboot\} \/>/)
  assert.match(tty, /bg-black/)
  assert.doesNotMatch(tty, /canvas|Engine|navigator\.gpu|Worker|audio|Hud|TouchControls|Concierge|BootVeil|useEffect|requestAnimationFrame/, 'no city at all')
  assert.match(app, /const TTY_BRIDGE: TerminalBridge = offlineBridge\(\{ \.\.\.BRAND, track: 'tty' \}\)/)
  const reboot = between(app, 'function reboot(track: BootTrack): void {', 'function readOptions(')
  assert.match(reboot, /url\.searchParams\.set\('boot', 'tty'\)/)
  assert.match(reboot, /url\.searchParams\.delete\('boot'\)/)
  assert.match(reboot, /window\.location\.assign\(url\.toString\(\)\)/)
  // The engine's useEffect lives in the GUI shell, the only one that reads the canvas.
  const gui = between(app, 'function GuiShell({ options }: { options: Options }) {', 'export default App')
  assert.ok(gui.includes('Engine.create(canvas, { ...options, region })'))
  assert.equal(app.match(/Engine\.create\(/g)?.length, 1)
  assert.match(gui, /<Terminal bridge=\{bridge\} onOpenChange=\{onTermOpen\} onBoot=\{reboot\} \/>/)
})

test('hud: the black canvas is explained by a chip that outlives the H key', () => {
  const hud = read('./Hud.tsx')
  assert.match(hud, /const renderChip = s\.output\.rendering === false && \(/)
  assert.match(hud, /RENDER OFF · console only/)
  assert.equal(hud.match(/\{renderChip\}/g)?.length, 3, 'beside the ghost chip in both layouts, and with the HUD hidden')
  assert.ok(hud.includes('{!visible && renderChip && ('), 'shown with the HUD hidden')
  assert.ok(hud.includes('{!visible && (recChip || rc?.listening || captionStrip) && ('), 'the captions pin is untouched')
  assert.doesNotMatch(between(hud, 'const renderChip', 'const toasts'), FORBIDDEN)
})
