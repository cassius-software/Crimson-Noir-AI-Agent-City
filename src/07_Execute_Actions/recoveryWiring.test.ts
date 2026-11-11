// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side ways out of a city that cannot start or has stopped, which App, the
 * engine, the boot veil and the cards carry and Node cannot run: the pad's edge-triggered A and d-pad (padNav.ts, run
 * here, with padEdges, the same edge rule for any buttons a card names, and padStep held to what it did before it),
 * the veil's 'Still starting' line after BOOT_VEIL.slowMs of visible time that never fails the boot, the cards'
 * Restart (a reload, focused) and Open the console (?boot=tty), the card on any boot failure and on every halt but a
 * Ring-0 audit, the frame loop that never dies silently (a throw before the first snapshot is the boot's failure,
 * FRAME_FAULTS throws in a row afterwards halt), the background graphics reset that restarts once the page is back,
 * the probe before a first visit's onboarding, and the engine's page device loss, first-frame validation scope and
 * clean-up of a boot that failed partway.
 * What breaks if it is removed? Any of those could quietly return to a black screen with nothing to press, or the
 * slow-boot line could become a timeout that fails the software adapter's minutes-long boot in the browser smoke.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { PAD, padEdges, padStep } from './padNav.ts'
import { waitedFor } from './bootFailure.ts'
import { createRng } from '../02_Define_The_Rules/degrees.ts'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const APP = read('../App.tsx')
const VEIL = read('./BootVeil.tsx')
const CARD = read('./RecoveryCard.tsx')
const ENGINE = read('./engine.ts')

/** A pad with these standard-mapping buttons held (all 17: 16 is the guide button). */
const pad = (...held: number[]) => ({ buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: held.includes(i) })) })

test('padStep: A presses, the d-pad moves focus, and only a button that goes down counts', () => {
  const there = padStep(new Set(), [pad(), pad()]).held // two pads, nothing held: the poll before
  assert.deepEqual(padStep(there, [pad(PAD.a)]).action, 'press')
  assert.deepEqual(padStep(there, [pad(PAD.down)]).action, 'next')
  assert.deepEqual(padStep(there, [pad(PAD.right)]).action, 'next')
  assert.deepEqual(padStep(there, [pad(PAD.up)]).action, 'previous')
  assert.deepEqual(padStep(there, [pad(PAD.left)]).action, 'previous')
  assert.deepEqual(padStep(there, [null, undefined]).action, null, 'no pads, nothing')
  const held = padStep(there, [pad(PAD.a), pad()]).held
  assert.equal(padStep(held, [pad(PAD.a), pad()]).action, null, 'held A: nothing until it is let go')
  assert.equal(padStep(padStep(held, [pad(), pad()]).held, [pad(PAD.a), pad()]).action, 'press', 'let go and pressed again')
  assert.equal(padStep(held, [pad(PAD.a), pad(PAD.a)]).action, 'press', 'another pad\'s A is its own press')
  assert.equal(padStep(there, [pad(PAD.a, PAD.down)]).action, 'press', 'A first')
  // A pad that shows up with A held (the browser reveals a pad on a button press: the A that left the last page).
  const appeared = padStep(new Set(), [pad(PAD.a)])
  assert.equal(appeared.action, null, 'a pad that appears with A down: nothing')
  assert.equal(padStep(appeared.held, [pad(PAD.a)]).action, null, 'still held: nothing')
  assert.equal(padStep(padStep(appeared.held, [pad()]).held, [pad(PAD.a)]).action, 'press', 'let go and pressed: a press')
  assert.equal(padStep(there, [pad(), pad(), pad(PAD.a)]).action, null, 'a third pad arriving with A down: nothing')
  // One hand: start, the shared centre button, does what that hand's side cannot; the shoulders (its glance) never act.
  assert.equal(padStep(there, [pad(PAD.start)]).action, null, 'both hands: start is nothing here')
  assert.equal(padStep(there, [pad(PAD.start)], 'left').action, 'press', 'the left hand presses with start (its d-pad moves)')
  assert.equal(padStep(there, [pad(PAD.down)], 'left').action, 'next')
  assert.equal(padStep(there, [pad(PAD.start)], 'right').action, 'next', 'the right hand moves on with start (A presses)')
  assert.equal(padStep(there, [pad(PAD.a)], 'right').action, 'press')
  for (const hand of ['left', 'right'] as const) for (const shoulder of [4, 5]) assert.equal(padStep(there, [pad(shoulder)], hand).action, null, `${hand} hand: a glance with ${shoulder === 4 ? 'L1' : 'R1'} neither presses nor moves`)
  assert.equal(padStep(padStep(there, [pad(PAD.start)], 'left').held, [pad(PAD.start)], 'left').action, null, 'held start: an edge, like A')
  // The hook reads the page's hand on every poll.
  assert.match(read('./padNav.ts'), /padStep\(prev \?\? new Set\(\), padsFor\(readPads\(\), accept\), pageHand\(\)\)/)
  assert.match(read('./padNav.ts'), /document\.documentElement\.dataset\.pad\b[\s\S]{0,80}v === 'left' \|\| v === 'right' \? v : 'both'/, 'the hand is the one access.ts writes on <html data-pad>; anything else is both hands')
  assert.match(read('./access.ts'), /root\.dataset\.pad = s\.pad/, 'and access.ts writes it')
  // usePadNav: the first poll only learns what is held, so the A that was driving cannot restart the city.
  assert.match(read('./padNav.ts'), /const first = prev === null[\s\S]*if \(!first && action && el\)/)
})

test('padEdges: any buttons a card names count on their down edge only, and the first poll only learns what is held', () => {
  // Every button the home card's furnishing reads (plan section 7): A, B, X, Y, LB and RB, LT and RT, View, Menu and
  // the d-pad. The stick presses (10, 11) and the guide button (16) are not among them.
  const B = [PAD.a, 1, 2, 3, 4, 5, 6, 7, 8, 9, PAD.up, PAD.down, PAD.left, PAD.right]
  const down = (prev: ReadonlySet<string>, pads: Parameters<typeof padEdges>[1]) => [...padEdges(prev, pads, B).down].sort((a, b) => a - b)
  // The first poll: everything already held is learned, nothing is pressed, whatever is down.
  const first = padEdges(new Set(), [pad(4, 5, 3), pad(PAD.a)], B)
  assert.deepEqual([...first.down], [], 'the first poll presses nothing')
  assert.deepEqual([...first.held].sort(), ['0:', '0:3', '0:4', '0:5', '1:', '1:0'])
  // Still held: nothing. Each button then counts on the poll it goes down, and only then.
  assert.deepEqual(down(first.held, [pad(4, 5, 3), pad(PAD.a)]), [], 'held through: nothing')
  const quiet = padEdges(first.held, [pad(), pad()], B).held
  assert.deepEqual(down(quiet, [pad(4), pad()]), [4], 'a shoulder goes down')
  assert.deepEqual(down(quiet, [pad(4, 9), pad(2)]), [2, 4, 9], 'several at once, across pads')
  assert.deepEqual(down(quiet, [pad(5), pad(5)]), [5], 'the same button on two pads counts once')
  assert.deepEqual(down(quiet, [pad(6, PAD.up), pad(7, PAD.right)]), [6, 7, PAD.up, PAD.right], 'the triggers and the d-pad too')
  const holding = padEdges(quiet, [pad(3), pad()], B)
  assert.deepEqual([...holding.down], [3])
  assert.deepEqual(down(holding.held, [pad(3), pad()]), [], 'held: nothing until it is let go')
  assert.deepEqual(down(padEdges(holding.held, [pad(), pad()], B).held, [pad(3), pad()]), [3], 'let go and pressed again')
  // Only the named buttons are read: the stick presses and the guide button are not among these.
  assert.deepEqual(down(quiet, [pad(10, 11, 16), pad(16)]), [], 'unnamed buttons are not read')
  assert.ok(!padEdges(quiet, [pad(10), pad()], B).held.has('0:10'), 'nor kept as held')
  // A pad that shows up with a button down counts it from its next press; a pad that goes away is forgotten.
  assert.deepEqual(down(quiet, [pad(), pad(), pad(4)]), [], 'a third pad arriving with a shoulder down: nothing')
  const gone = padEdges(quiet, [null, pad()], B).held
  assert.ok(!gone.has('0:'), 'pad 0 left')
  assert.deepEqual(down(gone, [pad(4), pad()]), [], 'pad 0 back with a shoulder down: learned, not pressed')
  assert.deepEqual(down(quiet, [undefined, null]), [], 'no pads, nothing')
  assert.deepEqual(down(quiet, [{ buttons: [{ pressed: false }] }, pad()]), [], 'a pad with fewer buttons than named reads the rest as up')
  // The usual loop: the first poll only learns, every later poll's edges count.
  let prev: Set<string> | null = null
  const presses: number[][] = []
  for (const pads of [[pad(PAD.a)], [pad(PAD.a)], [pad()], [pad(PAD.a, 1)], [pad(1)], [pad(8)]]) {
    const r = padEdges(prev ?? new Set(), pads, B)
    if (prev !== null) presses.push([...r.down].sort((a, b) => a - b))
    prev = r.held
  }
  assert.deepEqual(presses, [[], [], [0, 1], [], [8]])
})

test('padStep is padEdges over A and the d-pad, and behaves exactly as it did before padEdges', () => {
  // The previous padStep, kept here word for word, against the one that now rides on padEdges.
  type Pads = Parameters<typeof padStep>[1]
  const before = (prev: ReadonlySet<string>, pads: Pads) => {
    const held = new Set<string>()
    pads.forEach((p, i) => {
      if (!p) return
      held.add(`${i}:`)
      for (const b of [PAD.a, PAD.up, PAD.down, PAD.left, PAD.right]) if (p.buttons[b]?.pressed) held.add(`${i}:${b}`)
    })
    const down = (b: number) => [...held].some((k) => k.endsWith(`:${b}`) && !prev.has(k) && prev.has(k.slice(0, k.indexOf(':') + 1)))
    const action = down(PAD.a) ? 'press' : down(PAD.down) || down(PAD.right) ? 'next' : down(PAD.up) || down(PAD.left) ? 'previous' : null
    return { held, action }
  }
  const rng = createRng(2026)
  const pick = (n: number) => Math.floor(rng() * n)
  const randomPads = (): Pads => Array.from({ length: pick(4) }, () => {
    const kind = pick(6)
    if (kind === 0) return null
    if (kind === 1) return undefined
    return pad(...Array.from({ length: pick(4) }, () => pick(17)))
  })
  const t0 = performance.now()
  let presses = 0
  for (let run = 0; run < 600; run++) {
    let a = new Set<string>(), b = new Set<string>()
    for (let poll = 0; poll < 12; poll++) {
      const pads = randomPads()
      const now = padStep(a, pads), then = before(b, pads)
      assert.equal(now.action, then.action, `run ${run}, poll ${poll}`)
      assert.deepEqual([...now.held].sort(), [...then.held].sort(), `run ${run}, poll ${poll}`)
      if (now.action) presses++
      a = now.held
      b = then.held
    }
  }
  assert.ok(presses > 500, `${presses} actions seen: the runs press as well as hold`)
  assert.ok(performance.now() - t0 < 2000, 'quick')
})

test('the boot veil: the \'Still starting\' line after 20 s of visible time, a hint that never fails the boot', () => {
  assert.match(VEIL, /slowMs: 20_000,/)
  assert.match(VEIL, /waited = waitedFor\(waited, t - last, document\.hidden\)/)
  assert.match(VEIL, /\{slow && !fading && onConsole && <StillStarting onConsole=\{onConsole\} stage=\{stage\} \/>\}/)
  assert.doesNotMatch(VEIL.slice(VEIL.indexOf('const id = window.setInterval'), VEIL.indexOf('}, [ready, slow, phase, onConsole])')), /onDone|reject|throw/, 'only the line')
  // Visible time only: a phone switched away for a minute is not counted, nor a suspended page's long gap.
  assert.equal(waitedFor(0, 1_000, false), 1_000)
  assert.equal(waitedFor(5_000, 60_000, true), 5_000, 'hidden: nothing')
  assert.equal(waitedFor(5_000, 60_000, false), 7_000, 'a suspended page\'s gap counts for two ticks')
  assert.match(APP, /<BootVeil ready=\{hud !== null \|\| error !== null \|\| locked !== null\} onDone=\{\(\) => setVeilDone\(true\)\} onConsole=\{toConsole\} stage=\{stage\} \/>/)
})

test('the \'Still starting\' line names the step: every step Engine.create reports, in order, and App\'s own around it', () => {
  const create = ENGINE.slice(ENGINE.indexOf('  static async create('), ENGINE.indexOf('  /** The minimap'))
  const order = ['gpu', 'world', 'physics', 'shaders', 'frame'].map((st) => create.indexOf(`onStage('${st}'`))
  assert.ok(order.every((i) => i > 0), `each step reported: ${order}`)
  // The world step carries the adapter's line: the card names the GPU when the boot fails before the engine stands.
  assert.ok(create.includes("onStage('world', gpu.adapterInfo)"), 'the adapter with the world step')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'in the order the boot takes them')
  assert.ok(create.indexOf("onStage('gpu')") < create.indexOf('createRenderer('), 'the device step before the device is asked for')
  assert.ok(create.indexOf("onStage('shaders')") < create.indexOf('compileAsync('), 'the shaders before they compile')
  assert.match(APP, /Engine\.create\(canvas, \{ \.\.\.options, region \}, onStage\)/)
  assert.match(APP, /if \(first === 'probing'\) return <BootVeil ready=\{false\} onDone=\{noop\} onConsole=\{toConsole\} stage=\{BOOT_STAGE\.probe\} \/>/)
  assert.match(CARD, /Still starting\{stage \? `: \$\{stage\}` : ''\}… a slow GPU can take a few minutes\./)
})

test('a GPU lost while the city loaded in the background: the boot says so, and the page restarts once the player is back', () => {
  const create = ENGINE.slice(ENGINE.indexOf('  static async create('), ENGINE.indexOf('  /** The minimap'))
  assert.match(create, /hidden: document\.hidden \}/, 'hidden when the boot began')
  assert.match(create, /const onVisibility = \(\): void => \{ if \(document\.hidden\) boot\.hidden = true \}/, 'or at any time during it')
  assert.match(create, /new WebGPUUnavailableError\('gpu-reset', `The GPU device was lost while the city was built[^`]*`, boot\.hidden\)/)
  assert.match(create, /\} finally \{\n\s+document\.removeEventListener\('visibilitychange', onVisibility\)/)
  // three draws nothing on a lost device, so the first missing buffer is the reset too (world.ts gpuBufferOf).
  assert.match(read('../01_Initialize_World/world.ts'), /_isDeviceLost === true\) \{\n\s+throw new WebGPUUnavailableError\('gpu-reset'/)
  assert.match(APP, /if \(!cancelled && err instanceof WebGPUUnavailableError && err\.code === 'gpu-reset' && err\.background\) unwatch = reloadWhenVisible\(true\)/)
  const fn = APP.slice(APP.indexOf('function reloadWhenVisible('), APP.indexOf('/**', APP.indexOf('function reloadWhenVisible(')))
  assert.match(fn, /if \(!document\.hidden\) \{\n\s+back\(\)\n\s+return noop\n\s+\}/, 'already back: at once')
})

test('the cards: Restart reloads the page and has focus; Open the console is the ?boot=tty shell', () => {
  assert.match(CARD, /function restart\(\): void \{\n\s+window\.location\.reload\(\)\n\}/, 'a reload, never a remount')
  for (const [name, from, to] of [['RecoveryCard', 'export function RecoveryCard', 'export function LockScreen'], ['LockScreen', 'export function LockScreen', 'export function StillStarting']]) {
    const c = CARD.slice(CARD.indexOf(from), CARD.indexOf(to))
    assert.match(c, /<button ref=\{restartRef\} type="button" autoFocus(?:=\{!openIn\})? onClick=\{restart\}/, `${name}: Restart, focused`)
    assert.match(c, /useTakeFocus\((?:openIn \? openRef : )?restartRef\)/, `${name}: focused again after mount, the mouse let go`)
    assert.match(c, /usePadNav\(root\)\n\s+useEnterRestarts\(\)/, `${name}: a pad's A and Enter`)
    assert.match(c, /role="alertdialog"/, `${name}: announced`)
  }
  const card = CARD.slice(CARD.indexOf('export function RecoveryCard'), CARD.indexOf('export function LockScreen'))
  assert.match(card, /onClick=\{onConsole\}[^>]*>\s*Open the console/)
  assert.match(card, /\{failure\.webgpuLine && </, 'the WebGPU line only where WebGPU is what is missing')
  assert.match(card, /<details[\s\S]*\{failure\.detail\}[\s\S]*\{line\}[\s\S]*<\/details>/, 'the raw message and the copyable line under Details')
  assert.match(APP, /const toConsole = \(\): void => reboot\('tty'\)/)
  // Pointer lock would keep every click on the canvas beneath: the mouse is the player's again before Restart is focused.
  assert.match(CARD, /function useTakeFocus\([^)]*\): void \{\n\s+useEffect\(\(\) => \{\n\s+if \(document\.pointerLockElement\) document\.exitPointerLock\(\)\n\s+first\.current\?\.focus\(\)/)
  // Another browser one tap away (Firefox on Android): the first button, focused; Restart stays.
  assert.match(card, /\{openIn && \(\n\s+<button ref=\{openRef\} type="button" autoFocus onClick=\{\(\) => \{ window\.location\.href = openIn\.href \}\}/)
  assert.match(card, /useTakeFocus\(openIn \? openRef : restartRef\)/)
  // React focuses an autoFocus button as it mounts, before the effect: Restart carries it only when it is the one to
  // have focus, or a look between the mount and the effect finds focus on Restart (seen in the browser smoke).
  assert.match(card, /<button ref=\{restartRef\} type="button" autoFocus=\{!openIn\}/)
  assert.equal(card.match(/type="button" autoFocus/g)?.length, 2, 'Open in Chrome and Restart, never both at once')
  // Enter restarts from anywhere but a field, a focused button (which takes it natively) or Details (which opens).
  assert.match(CARD, /e\.target\.closest\('button, summary'\)\)\) return\n\s+e\.preventDefault\(\)\n\s+restart\(\)/)
})

test('the console shell: a way back to the city a pad or a finger can press, and the console leaves its keys alone', () => {
  const tty = APP.slice(APP.indexOf('function TtyShell() {'), APP.indexOf('function onboardingVoice('))
  assert.match(tty, /usePadNav\(back\)/, 'its own pad scope (never the terminal\'s hidden Close)')
  assert.match(tty, /<div ref=\{back\} data-way-out=""[^>]*z-\[10000\][^>]*>\s*<button type="button" onClick=\{\(\) => reboot\('gui'\)\}[^>]*>\s*Back to the city/)
  // The console's window-capture keydown would pull Enter on a card's (or this) button into its hidden prompt.
  const term = read('./terminal/Terminal.tsx')
  assert.match(term, /if \(inside\) return[^\n]*\n(\s+\/\/[^\n]*\n)+\s+if \(e\.target instanceof Element && e\.target\.closest\('\[role="alertdialog"\], \[data-way-out\]'\)\) return\n\s+\/\/ Aimed elsewhere/)
})

test('App: the card on a failed boot and on every halt but a Ring-0 audit, which keeps its lock screen', () => {
  assert.match(APP, /const \[error, setError\] = useState<\{ cause: unknown \} \| null>\(null\)/)
  assert.match(APP, /\(err: unknown\) => \{\n\s+setError\(\{ cause: err \}\)\n/, 'whatever Engine.create threw, classified by the card')
  assert.match(APP, /const failure = error !== null \? classify\(error\.cause, env\) : locked !== null && haltClass\(locked\) !== 'audit' \? explainHalt\(locked, env\) : null/)
  assert.match(APP, /\{failure === null && locked !== null && <LockScreen reason=\{locked\} \/>\}/)
  assert.match(APP, /\{failure && <RecoveryCard failure=\{failure\} adapter=\{adapter\} onConsole=\{toConsole\} \/>\}/)
  assert.doesNotMatch(APP, /\{error && \(/, 'the old card is gone')
})

test('App: the frame loop never dies silently', () => {
  assert.match(APP, /^const FRAME_FAULTS = 30$/m)
  const end = 'raf = requestAnimationFrame(loop)\n    }'
  const loop = APP.slice(APP.indexOf('const loop = (now: number) => {'), APP.indexOf(end) + end.length)
  assert.match(loop, /try \{\n\s+engine\.frame\(now\)/, 'the frame inside the try')
  assert.match(loop, /\} catch \(err\) \{\n\s+\/\/[^\n]*\n\s+if \(engine\.halted\) return\n/, 'a Ring-0 panic thrown out of the frame keeps SYSTEM LOCKED')
  assert.match(loop, /if \(!shown\) \{\n\s+setError\(\{ cause: err \}\)\n\s+engine\.halt\(why\)\n\s+return\n\s+\}/, 'before the first snapshot: the boot\'s failure')
  assert.match(loop, /if \(\+\+throws >= FRAME_FAULTS\) \{\n\s+engine\.halt\(why\)\n\s+return\n\s+\}/, 'afterwards: a run of throws halts')
  assert.match(loop, /const why = `\$\{FRAME_FAULT\} /)
  assert.match(loop, /throws = 0\n\s+\} catch/, 'a good frame resets the run')
  assert.match(loop, /\}\n\s+raf = requestAnimationFrame\(loop\)\n\s+\}$/, 'and the loop is scheduled again after a throw')
})

test('App: a graphics reset in the background restarts once the page is back; never without storage', () => {
  assert.match(APP, /if \(haltClass\(reason\) === 'gpu-reset'\) unwatch = reloadWhenVisible\(document\.hidden\)/)
  const fn = APP.slice(APP.indexOf('function reloadWhenVisible('), APP.indexOf('/**', APP.indexOf('function reloadWhenVisible(')))
  assert.match(fn, /if \(!hiddenAtLoss\) return noop/, 'a reset seen while visible keeps the card')
  assert.match(fn, /try \{\n\s+const v = localStorage\.getItem\(AUTO_RELOAD_KEY\)[\s\S]*\} catch \{\n\s+storageOk = false\n\s+\}/)
  assert.match(fn, /if \(!autoReload\(\{ lastMs, nowMs: Date\.now\(\), hiddenAtLoss, storageOk \}\)\) return/)
  assert.match(fn, /try \{\n\s+localStorage\.setItem\(AUTO_RELOAD_KEY, String\(Date\.now\(\)\)\)\n\s+\} catch \{\n\s+return\n\s+\}\n\s+window\.location\.reload\(\)/, 'the time is kept before the reload, or there is none')
  assert.match(APP, /cancelAnimationFrame\(raf\)\n\s+unwatch\(\)/)
})

test('App: a first visit is probed before the onboarding; ?boot=tty never is', () => {
  const app = APP.slice(APP.indexOf('function App() {'), APP.indexOf('const chosen = outcome?.saved ?? saved'))
  assert.match(app, /const probing = options\.boot !== 'tty' && onboard/)
  assert.match(app, /probeGpu\(navigator\.gpu, window\.isSecureContext !== false, window\.location\.origin\)/)
  assert.ok(app.indexOf("if (options.boot === 'tty') return <TtyShell />") < app.indexOf('firstScreen('), 'the console first')
  assert.match(app, /if \(first === 'probing'\) return <BootVeil ready=\{false\}/)
  assert.match(app, /if \(first === 'card' && probe && !probe\.ok\) return <RecoveryCard failure=\{classify\(probe\.error, pageEnv\(\)\)\} onConsole=\{toConsole\} \/>/)
  assert.ok(app.indexOf('firstScreen(') < app.indexOf('<Onboarding '), 'before the onboarding')
})

test('engine: a lost page device halts as a graphics reset; the first frame draws in a validation scope; a failed boot lets go', () => {
  const ctor = ENGINE.slice(ENGINE.indexOf('void p.gpu.device.lost.then('), ENGINE.indexOf('  static async create('))
  assert.match(ctor, /if \(this\.disposed \|\| info\.reason === 'destroyed'\) return/, 'its own destroy() is not a loss')
  assert.match(ctor, /this\.halt\(`\$\{GRAPHICS_RESET\} the page's GPU device was lost/)
  const create = ENGINE.slice(ENGINE.indexOf('  static async create('), ENGINE.indexOf('  /** The minimap'))
  // Both paths, each in a scope of its own, except that a chain capped off (?post=0, split screen, a lite profile) is never
  // drawn, so never compiled.
  assert.match(create, /gpu\.device\.pushErrorScope\('validation'\)\n\s+gpu\.renderer\.render\(world\.scene, world\.camera\)\n\s+const invalid = await gpu\.device\.popErrorScope\(\)\n\s+stillThere\(\)\n\s+if \(invalid\) throw new Error\(`the first frame failed WebGPU validation: \$\{invalid\.message\}`\)\n\s+if \(options\.post\) \{\n\s+gpu\.device\.pushErrorScope\('validation'\)\n\s+post\.render\(\)\n\s+const refused = await gpu\.device\.popErrorScope\(\)\n\s+stillThere\(\)/)
  assert.match(create, /\} else if \(refused\) throw new Error\(`the first frame failed WebGPU validation: \$\{refused\.message\}`\)/)
  assert.match(create, /\} catch \(e\) \{\n\s+void simBoot\?\.then\(\(s\) => s\.terminate\(\), \(\) => \{\}\)\n\s+releaseGpu\(gpu\)\n[\s\S]*?\n\s+throw e\n\s+\} finally \{/)
  assert.ok(create.indexOf('try {') < create.indexOf('buildWorld('), 'everything after the device is inside the try')
  assert.match(ENGINE, /releaseGpu\(this\.gpu\)/, 'dispose lets go the same way')
})

test('App: Sloane never greets over a halted city, so the card keeps focus on Restart', () => {
  // The veil's onDone fires up to fadeMs + graceMs after the fade starts; a halt inside that window (the browser smoke's
  // thrown frame right after the veil lifts) shows the card first and Sloane's name field second, which would take the
  // focus from Restart (Concierge.tsx focusField takes it from anything but another text field). The Customizer and the
  // ActCard are gated on the same lock (lookWiring.test.ts, actWiring.test.ts).
  assert.match(APP, /<Concierge\n\s*visible=\{veilDone && hudVisible && !termOpen && !lookOpen && storeOpen === null && homeOpen === null && locked === null\}/)
})
