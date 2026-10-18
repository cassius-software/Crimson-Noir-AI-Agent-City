// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the page-side wiring of the model kept in this page (09_Cognition/inPage.ts, the
 * `inpage` provider), which App, the touch Menu and the engine carry and Node cannot run: the city's router is the one
 * handed an in-page mind (the onboarding's keeps the stand-in and never asks it), over one runtime and one store per
 * page, made on first use, the store copying through its own counted worker; the mind plans by the engine's profile of
 * this device and its GPU's shader-f16, holds the city's tier down while it works and shows its phase on the HUD's
 * activity line; the picker is one hidden file input with no accept, hidden by size and opacity, clicked at once inside
 * the tap or key that asked; a file picked or dropped (on a desktop) is kept, chosen, and on a desktop loaded at once;
 * the Menu's Model file calls the host inside its click handler, and neither it nor the picker is offered where this
 * page cannot run the model (the mind's keep refuses there too); the page's lifecycle reaches the mind; a graphics
 * reset notes the GPU before the mind is shut down; the console reaches it through the bridge's model; and it is shut
 * down with the city.
 * What breaks if it is removed? The picker could stop opening on a phone (an await before the click, an accept list,
 * display:none), the onboarding could load a model while the city is built, the city could keep its full tier while the
 * model works, or a GPU reset could load the model onto the GPU again, with no test going red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

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
/** The code without its comments (a line comment starts at // not preceded by a colon, as in URLs; JSX comments too). */
const code = (text: string): string => text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

const APP = read('../App.tsx')
const APP_CODE = code(APP)
const TOUCH = read('../04_Connect_Hardware/TouchControls.tsx')
const ENGINE = read('./engine.ts')
/** The effect that builds the city around the engine (its frame loop, the engine's wiring, its teardown). */
const EFFECT = between(APP, '    const canvas = canvasRef.current\n', '  // The boot\'s failure first')
/** The part of it that runs once the engine is up. */
const CITY = between(EFFECT, '    loadMap(plan).then((region) => Engine.create(', '    return () => {\n      cancelled = true')
/** The city router's call, from its line to the line after it. */
const CITY_ROUTER = between(CITY, '        const local = createMindRouter({', '        inPageMind = inPage\n')

test('App: the city\'s router alone is handed an in-page mind, one per router; the onboarding\'s keeps the stand-in and never asks it', () => {
  assert.equal(APP_CODE.match(/\bcreateMindRouter\(/g)?.length, 2, 'the onboarding\'s and the city\'s')
  assert.equal(APP_CODE.match(/\binPage: \(store\) =>/g)?.length, 1, 'one router is handed the factory')
  assert.equal(APP_CODE.match(/\bcreateInPageMind\(/g)?.length, 1, 'one mind is made')
  assert.match(CITY_ROUTER, /^ {8}const local = createMindRouter\(\{\n {10}fetch: pageFetch,\n {10}store: pageStore\(COGNITION_KEY\),\n {10}inPage: \(store\) => \(inPage = createInPageMind\(\{\n/, 'inside the city router\'s own call, over its own slice of the store')
  const onboarding = between(APP, 'function onboardingVoice(): Voice {', '\n}\n')
  assert.match(onboarding, /const router = createMindRouter\(\{ fetch: pageFetch, store: pageStore\(COGNITION_KEY\) \}\)/, 'no runtime for the onboarding')
  assert.match(onboarding, /if \(s\.provider === 'auto' \|\| s\.provider === 'scripted' \|\| s\.provider === 'inpage' \|\| \(s\.provider === 'claude' && !s\.key\)\) return scriptedVoice\(\)/, 'a model kept in this page is never asked while the city is built')
})

test('App: one runtime and one store per page, made on first use; the store copies through its own worker, counted among the page\'s workers', () => {
  assert.match(APP, /^import CopyWorker from '\.\/09_Cognition\/modelStore\.worker\.ts\?worker&inline'$/m)
  assert.match(APP, /^import \{ createWllamaRuntime \} from '\.\/09_Cognition\/wllamaRuntime\.ts'$/m)
  assert.match(APP, /^const PAGE_RUNTIME = once\(\(\) => createWllamaRuntime\(\{ debug: new URLSearchParams\(window\.location\.search\)\.has\('debug'\) \}\)\)$/m)
  assert.match(APP, /^const PAGE_MODELS = once\(\(\) => createModelStore\(\{ copy: workerCopy\(copyWorker\) \}\)\)$/m)
  assert.equal(APP_CODE.match(/\bcreateWllamaRuntime\(/g)?.length, 1)
  assert.equal(APP_CODE.match(/\bcreateModelStore\(/g)?.length, 1)
  before(APP, 'const pageFetch = loopbackFetch(', 'const PAGE_RUNTIME = once(', 'beside the page\'s other singletons, outside every component')
  assert.ok(APP.indexOf('const PAGE_MODELS = once(') < APP.indexOf('function App() {'))
  const made = between(APP, 'function once<T>(make: () => T): () => T {', '\n}\n')
  assert.match(made, /return \(\) => \(made \?\?= \{ value: make\(\) \}\)\.value/, 'made once, on the first call')
  const worker = between(APP, 'function copyWorker(): Worker {', '\n}\n')
  assert.match(worker, /const worker = new CopyWorker\(\{ name: 'model-copy' \}\)\n\s+const untrack = trackWorker\(\)\n\s+const terminate = worker\.terminate\.bind\(worker\)\n\s+worker\.terminate = \(\) => \{ terminate\(\); untrack\(\) \}/)
  assert.match(CITY_ROUTER, /runtime: \(\) => PAGE_RUNTIME\(\),\n\s+store: PAGE_MODELS\(\),\n\s+kept: store,\n\s+env: device,/, 'the runtime asked for only when the mind needs it')
})

test('App: the mind plans by the engine\'s profile, holds the city\'s tier down while it works, and shows its phase on the HUD\'s activity line', () => {
  const device = between(CITY, '        const device = (): Omit<PlanEnv, \'gpuMode\' | \'gpuFailed\'> => ({', '        })\n')
  assert.match(device, /mobile: e\.profile\.mobile, lite: e\.profile\.lite, gpuClass: e\.profile\.gpuClass,/)
  assert.match(device, /cores: navigator\.hardwareConcurrency \|\| 4, memoryGb: deviceMemory\(\), isolated: canShareMemory\(\), f16: e\.gpuF16,/)
  assert.match(CITY_ROUTER, /busy: \(on, place\) => e\.holdQuality\(on && place \? holdTier\(device\(\), place\.gpu\) : null\),/, 'held while it works, let go after')
  assert.match(CITY_ROUTER, /onPhase: \(text\) => \{ modelPhase = text \},/)
  assert.match(EFFECT, /s\.supplier\.recruiting = hudLine\(recruiter, router\?\.running \?\? 0, activityText\(answering, engine\.speaking, modelPhase \?\? keepLine\)\)/, 'the line the HUD already shows while a model works')
  const activity = between(APP, 'function activityText(', '\n}\n')
  assert.match(activity, /if \(!a\) return model \?/, 'with no answer waiting, what the model is doing')
  assert.match(activity, /if \(model\) return `Answering · \$\{model\}`/, 'before the first piece, why the answer waits')
  before(activity, 'if (a.tail)', 'if (model)', 'the answer\'s own words win once they come')
})

test('App: the picker is one hidden file input with no accept, hidden by size and opacity, never by display', () => {
  assert.equal(APP_CODE.match(/type="file"/g)?.length, 1)
  const tag = APP_CODE.match(/<input ref=\{fileRef\}[^>]*\/>/)?.[0]
  assert.ok(tag, 'the file input')
  assert.match(tag, /type="file" multiple/)
  assert.doesNotMatch(tag, /\baccept\b/, 'a phone greys out a .gguf it has no type for')
  const classes = tag.match(/className="([^"]*)"/)?.[1].split(/\s+/) ?? []
  for (const off of ['hidden', 'invisible', 'sr-only', 'contents']) assert.ok(!classes.includes(off), `display:none or the like (${off}): some browsers will not open it`)
  assert.doesNotMatch(tag, /\shidden(?=[\s=/>])|\bstyle=|\bdisplay\b/, 'nor a hidden attribute or a style')
  for (const on of ['opacity-0', 'h-px', 'w-px', 'pointer-events-none']) assert.ok(classes.includes(on), `hidden by size and opacity (${on})`)
  assert.match(tag, /aria-hidden="true"/)
  before(APP, '<main ref={mainRef}', '<input ref={fileRef}', 'inside the city\'s element, from the first render')
})

test('App: the picker is clicked at once inside the tap or key that asked: nothing is awaited before the click', () => {
  const picker = between(APP, 'function filePicker(input: HTMLInputElement, late: (files: File[]) => void): FilePicker {', '\n}\n')
  const open = between(picker, '    open: () => {', '      return chosen\n')
  assert.doesNotMatch(open, /\bawait\b|\basync\b|\.then\(|setTimeout|queueMicrotask|requestAnimationFrame/, 'a promise or a timer before the click loses the user activation')
  assert.match(open, /\n {6}input\.click\(\)\n$/, 'the click is the open\'s last step before it returns')
  before(open, 'window.addEventListener(\'focus\', onFocus)', 'input.click()', 'listening before the picker can close')
  assert.match(picker, /input\.addEventListener\('change', onChange\)\n\s+input\.addEventListener\('cancel', onCancel\)/, 'settled on change or cancel')
  assert.match(picker, /timer = window\.setTimeout\(\(\) => \{ if \(waiting\) settle\(read\(\)\) \}, PICK_SETTLE_MS\)/, 'or, where a browser sends neither, after the page has its focus back')
  assert.match(APP, /^const PICK_SETTLE_MS = 1000$/m)
  assert.match(picker, /const files = Array\.from\(input\.files \?\? \[\]\)\n\s+input\.value = ''/, 'emptied after each read')
  // The ways in call it synchronously: the console's pick (inside the Enter keydown) and the Menu (inside its click).
  const pickFiles = between(CITY, '        const pickFiles = (): Promise<File[] | null> => {', '\n        }\n')
  assert.doesNotMatch(pickFiles, /\bawait\b|\basync\b|\.then\(|setTimeout|queueMicrotask/, 'nothing before the picker opens but a synchronous check')
  assert.match(pickFiles, /const cannot = PAGE_MODEL_REFUSAL\(\)\n\s+if \(cannot !== null\) return Promise\.reject\(new Error\(cannot\)\)\n\s+return picker \? picker\.open\(\) : Promise\.reject\(new Error\('this page has no file picker'\)\)$/, 'where this page cannot run the model, no picker opens and the reason is the answer')
  assert.match(CITY, /^ {10}pick: \(\) => pickFiles\(\)\.then\(\(files\) => \(files \? keepPicked\(files\) : 'no model file was chosen'\)\),$/m)
  assert.match(CITY, /^ {8}modelFileRef\.current = \(\) => keepAndSay\(pickFiles\(\)\)$/m)
  assert.match(APP, /const onModelFile = useCallback\(\(\) => modelFileRef\.current\?\.\(\), \[\]\)/)
})

test('the Menu: a Model file item that calls the host inside its click handler, and App hands it over', () => {
  const host = between(TOUCH, 'export interface TouchMenuHost {', '\n}\n')
  assert.match(host, /^ {2}onModelFile\?: \(\) => void$/m)
  const sheet = between(TOUCH, 'function MenuSheet(', '\n}\n')
  assert.match(sheet, /\.\.\.\(host\.onModelFile \? \[\{ label: 'Model file', run: host\.onModelFile \}\] : \[\]\),/)
  // act() runs the item's own function at once, inside the button's onClick (a whole tap), never on pointerdown.
  assert.match(sheet, /const act = \(fn: \(\) => void, close = true\) => \(\) => \{\n\s+input\.engageTouch\(\)\n\s+fn\(\)\n/)
  assert.match(sheet, /onClick=\{act\(it\.run, !it\.keep\)\}/)
  assert.doesNotMatch(between(sheet, 'role={it.on === undefined', '</button>'), /onPointerDown/, 'a pointerdown is not a tap the picker opens for')
  assert.match(APP_CODE, /onConsole: \(\) => termRef\.current\?\.open\(\),\n\s+onModelFile: PAGE_MODEL_REFUSAL\(\) === null \? onModelFile : undefined,\n/, 'no Model file where this page cannot run the model')
  const refusal = between(APP, 'const PAGE_MODEL_REFUSAL = once((): string | null => {', '\n})\n')
  assert.match(refusal, /const mode = runtimeMode\(PAGE_RUNTIME\(\)\.caps\(\)\)\n\s+return mode\.ok \? null : mode\.reason$/, 'the runtime\'s own probe, as the mind reads it')
  assert.match(APP, /^import \{ runtimeMode \} from '\.\/09_Cognition\/inPageCaps\.ts'$/m)
})

test('App: a file picked or dropped is kept, chosen, and the inpage provider answers; a desktop loads it at once, a phone only when asked', () => {
  const keep = between(CITY, '        const keepPicked = async (files: readonly File[]): Promise<string> => {', '\n        }\n')
  before(keep, 'kept = await inPage.keep(files, (done, total) => {', 'local.setProvider(\'inpage\')', 'chosen only once it is kept')
  before(keep, 'local.setProvider(\'inpage\')', 'local.setModel(kept.name)', 'the provider, then its model')
  assert.match(keep, /keepLine = `keeping the model file in this page \$\{/, 'the copy\'s progress on the HUD\'s line')
  assert.match(keep, /\} finally \{\n\s+keeping = false\n\s+keepLine = null\n\s+\}/, 'the line is cleared however the copy ends')
  assert.match(keep, /const warm = !e\.profile\.mobile && !e\.profile\.lite\n\s+if \(warm\) void inPage\.load\(\)/, 'not on a phone or a lite profile (D12)')
  // D18: a served page, not isolated, with the service worker: one line, never a confirm().
  assert.match(keep, /if \(!hinted && \/\^https\?:\$\/\.test\(window\.location\.protocol\) && window\.crossOriginIsolated !== true && navigator\.serviceWorker\?\.controller\) \{\n\s+hinted = true\n\s+e\.toast\(MODEL_FILE, 'reload once to let the model use more than one thread'\)/)
  assert.doesNotMatch(APP_CODE, /\bconfirm\(/)
  // Dropped on the city: .gguf files only, desktops only, and the browser never opens a dropped file itself.
  const drop = between(CITY, '        const onDrop = (ev: DragEvent): void => {', '\n        }\n')
  assert.match(drop, /ev\.preventDefault\(\)\n\s+const models = files\.filter\(\(f\) => \/\\\.gguf\$\/i\.test\(f\.name\)\)\n\s+if \(models\.length\) keepAndSay\(Promise\.resolve\(models\)\)/)
  assert.match(CITY, /if \(main && !e\.profile\.mobile\) \{\n\s+main\.addEventListener\('dragover', onDragOver\)\n\s+main\.addEventListener\('drop', onDrop\)/)
  assert.match(CITY, /const keepAndSay = \(chosen: Promise<File\[\] \| null>\): void => \{\n\s+void chosen\.then\(\(files\) => \(files \? keepPicked\(files\) : null\)\)/, 'the Menu and a drop keep through the same path')
})

test('App: the page\'s lifecycle reaches the mind; a graphics reset notes the GPU before the mind is shut down; the console reaches it; it ends with the city', () => {
  assert.match(CITY, /const onVisibility = \(\): void => \{ if \(document\.hidden\) inPage\.background\(\); else inPage\.foreground\(\) \}/)
  assert.match(CITY, /const onPageHide = \(\): void => \{ inPage\.leave\(\); inPage\.background\(\) \}/, 'a page that unloads takes its load\'s crash mark with it')
  assert.match(CITY, /document\.addEventListener\('visibilitychange', onVisibility\)\n\s+window\.addEventListener\('pagehide', onPageHide\)/)
  const halt = between(CITY, '        e.onHalt = (reason) => {', '\n        }\n')
  assert.match(halt, /^ {10}if \(haltClass\(reason\) === 'gpu-reset'\) inPage\.noteGpuReset\(\)$/m)
  before(halt, 'inPage.noteGpuReset()', 'void inPage.dispose()', 'the GPU noted while the mind still knows where the model was')
  before(halt, 'void inPage.dispose()', 'unfollow?.()', 'then shut down with the rest, as before')
  assert.match(halt, /if \(haltClass\(reason\) === 'gpu-reset'\) unwatch = reloadWhenVisible\(document\.hidden\)/, 'the restart is unchanged')
  // The host terminal bridge, beside the network session and the look.
  assert.match(CITY, /net: netBridge\(e\.net, pageStore\(NET_TOKEN_KEY\)\),\n\s+model: modelBridge,\n/)
  const bridge = between(CITY, '        const modelBridge: ModelBridge = Object.freeze({', '        })\n')
  for (const verb of ['pick: () => pickFiles()', 'forget: (name?: string) => inPage.forget(name)', 'load: () => inPage.load()', 'unload: () => inPage.unload()', 'gpu: (mode: GpuMode) => gpuLine(inPage.setGpu(mode))', 'log: () => inPage.log()']) {
    assert.ok(bridge.includes(verb), `the bridge's model: ${verb}`)
  }
  // Teardown: the wiring taken back and the mind shut down (the model unloaded) with the city.
  const teardown = between(EFFECT, '    return () => {\n      cancelled = true', '\n    }\n  }, [')
  assert.match(teardown, /unModel\(\)\n\s+void inPageMind\?\.dispose\(\)/)
  const un = between(CITY, '        unModel = () => {', '\n        }\n')
  for (const off of ['modelFileRef.current = null', 'picker?.dispose()', "main?.removeEventListener('drop', onDrop)", "document.removeEventListener('visibilitychange', onVisibility)", "window.removeEventListener('pagehide', onPageHide)"]) {
    assert.ok(un.includes(off), `taken back: ${off}`)
  }
})

test('the engine: its device profile kept, the GPU\'s shader-f16 read off the city\'s own device, and a quality hold applied at once', () => {
  assert.match(ENGINE, /^ {2}readonly profile: DeviceProfile$/m)
  assert.match(ENGINE, /^ {2}readonly gpuF16: boolean$/m)
  assert.match(ENGINE, /^ {4}this\.profile = p\.profile\n {4}this\.gpuF16 = p\.gpu\.device\.features\.has\('shader-f16'\)$/m)
  const create = between(ENGINE, '  static async create(', '\n  }\n')
  assert.match(create, /const profile = profileDevice\(hints, requested\.lite\)/)
  assert.match(create, /const engine = new Engine\(\{\n\s+canvas, gpu, world, crowd, sim, view, rigView, profile,/, 'the profile create() decided, ?lite applied')
  const hold = between(ENGINE, '  holdQuality(cap: number | null): void {', '\n  }\n')
  assert.match(hold, /if \(this\.disposed\) return\n\s+this\.quality\.governor\.hold\(cap, performance\.now\(\)\)\n\s+this\.applyTier\(\)$/, 'the governor\'s clock, then the tier applied as the console\'s quality does')
})
