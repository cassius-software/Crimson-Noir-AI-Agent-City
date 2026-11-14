// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the wiring of auto's sizing of the Ollama model by the GPUs' memory (modelFit.ts),
 * which App, the engine's wrappers and the console carry and Node cannot run as a page: App reads vram= from the
 * page's address and hands it to the page's router alone (built in one place, pageMind.ts createPageMind, for the city
 * and for the console alone; the onboarding's router never answers under auto, so it is given none); the scripted and cloud fallback wrappers bind the router's setVram, so `ask vram` reaches it; modelFit.ts
 * stays a pure rule that imports only localCompute.ts (this machine's check included) and asks no server itself; the
 * router is the module that uses it; and the operator's and the bridge's askSet both take 'vram'. In the Windows app,
 * the page's router asks the shell for the GPUs' memory once as it is built (desktopShell.ts shellGpuMemory over
 * src-tauri/src/gpu.rs, handed in by App), judges it by modelFit.ts figureFromAdapters, and keeps it for itself alone, below the address's figure. The larger
 * context the router may ask of Ollama (modelFit.ts widen) is handed to the Ollama client alone, with each answer.
 * What breaks if it is removed? The launcher's vram= could stop reaching the router, the onboarding's router could
 * start sizing a model of its own, a wrapper could hide setVram so `ask vram` says no provider grows with the GPU, or
 * the pure rule could start asking a server or judging what is on this machine by itself, or a chat-format client
 * could be handed Ollama's context, with no test going red.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8')
const between = (src: string, from: string, to: string): string => {
  const a = src.indexOf(from), b = src.indexOf(to, a + from.length)
  assert.ok(a >= 0 && b > a, `missing ${from} ... ${to}`)
  return src.slice(a, b)
}
/** The code without its comments (a line comment starts at // not preceded by a colon, as in URLs; JSX comments too). */
const code = (text: string): string => text.replace(/\{?\/\*[\s\S]*?\*\/\}?/g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
/** Every module a source imports: static, dynamic, or for its effect alone (as airgap.test.ts reads them). */
const specifiers = (text: string): string[] =>
  [...text.matchAll(/\bfrom\s+['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3])
/** How many times `re` (a /g pattern) occurs in `text`. */
const count = (text: string, re: RegExp): number => text.match(re)?.length ?? 0

const APP = read('../App.tsx')
const APP_CODE = code(APP)
const PAGE_MIND = read('./pageMind.ts')
const PAGE_MIND_CODE = code(PAGE_MIND)
/** The page router's one call (pageMind.ts createPageMind), from its line to the return after it. */
const PAGE_ROUTER = between(PAGE_MIND, '  const router = createMindRouter({', '  return Object.freeze({ router, inPage, native })')
/** The city's call of it (App.tsx GuiShell). */
const CITY = between(APP, '        const { router: local, inPage, native: appMind } = minds.createPageMind({', '        inPageMind = inPage\n')
/** The console alone's call of it (App.tsx ttyBridge). */
const TTY = between(APP, 'function ttyBridge(vram: string | null): TerminalBridge {', '\n}\n')
const MODEL_FIT = read('./modelFit.ts')
const ROUTER = read('./router.ts')
const LOCAL_CODE = code(read('./localCompute.ts'))
const OPERATOR = read('../07_Execute_Actions/operator.ts')
const BRIDGE = read('../07_Execute_Actions/terminal/bridge.ts')
/** The optional setters both wrappers bind to the mind they wrap (the engine puts them in front of the router). */
const BOUND = "['setThink', 'setApi', 'setProvider', 'setKey', 'setEffort', 'setVram', 'connect']"

test('App: vram= in the address is read once, as written, and handed to the page\'s router alone; the onboarding\'s router gets none', () => {
  assert.match(APP, /^type Options = EngineOptions & \{ debug: boolean; boot: BootTrack; vram: string \| null \}$/m, 'Options carries the raw query value')
  const opts = between(APP, 'function readOptions(): Options {', '\n}\n')
  assert.match(opts, /^ {4}vram: q\.get\('vram'\),$/m, 'readOptions passes ?vram= on as written; modelFit.ts readGb judges it')
  assert.equal(count(APP_CODE, /\bq\.get\('vram'\)/g), 1, 'read in one place')
  assert.match(CITY, /^ {10}vram: options\.vram,$/m, 'a property of the city\'s call, beside fetch and store, not of the in-page mind\'s')
  assert.equal(count(APP_CODE, /\bvram: options\.vram\b/g), 1, 'the city hands it once')
  // The console alone is handed the same address's value by App, and hands it to the same maker.
  assert.match(APP, /if \(options\.boot === 'tty'\) return <TtyShell vram=\{options\.vram\} \/>/)
  assert.match(TTY, /^ {6}vram,$/m)
  assert.equal(count(APP_CODE, /\bcreatePageMind\(/g), 2, 'the city\'s and the console alone\'s, and no third')
  assert.equal(count(APP_CODE, /\bcreateMindRouter\(/g), 0, 'App builds no router itself')
  assert.match(PAGE_ROUTER, /^ {4}vram: d\.vram,$/m, 'a property of the router\'s own call')
  assert.equal(count(PAGE_MIND_CODE, /\bcreateMindRouter\(/g), 2, 'the onboarding\'s and the page\'s, and no third')
  const onboarding = between(PAGE_MIND, 'export function onboardingVoice(fetch: FetchLike, store: SettingsStore): Voice {', '\n}\n')
  assert.match(onboarding, /const router = createMindRouter\(\{ fetch, store \}\)/, 'the onboarding\'s router: its fetch and store, nothing more')
  assert.doesNotMatch(onboarding, /vram/, 'the onboarding\'s router sizes nothing')
})

test('the scripted and cloud fallback wrappers bind the router\'s setVram, so ask vram reaches it through the engine', () => {
  for (const file of ['./cloudFallback.ts', './scripted.ts']) {
    const t = code(read(file))
    assert.ok(t.includes(`for (const k of ${BOUND} as const) {`), `${file} binds setVram beside the other optional setters`)
  }
})

test('modelFit.ts is a pure rule: it imports only localCompute.ts, this machine\'s check included, and asks no server itself', () => {
  assert.deepEqual(specifiers(MODEL_FIT), ['./localCompute.ts'])
  assert.match(MODEL_FIT, /^import \{ [^}]*\bloopbackServer\b[^}]* \} from '\.\/localCompute\.ts'$/m, 'what is on this machine is the gate\'s word, through localCompute.ts')
  for (const re of [/\bfetch\b/, /\bfetchFn\b/, /\.answer\s*\(/, /\bnew URL\(/, /\.hostname\b/]) {
    assert.doesNotMatch(MODEL_FIT, re, `modelFit.ts has no ${re.source}`)
  }
  // The readers it is fed from keep no check of their own either (airgap.test.ts pins the gate's alias there).
  assert.doesNotMatch(code(read('./localCompute.ts')), /\bnew URL\(|\.hostname\b/, 'placementOf and installedSizes go through loopbackServer')
})

test('the router is the module that sizes by modelFit.ts: it imports it, and its figure is the console\'s, else the address\'s, else the Windows app\'s', () => {
  assert.ok(specifiers(ROUTER).includes('./modelFit.ts'), 'router.ts imports modelFit.ts')
  assert.match(ROUTER, /^import \{ [^}]*\bfigureOf\b[^}]* \} from '\.\/modelFit\.ts'$/m)
  assert.match(ROUTER, /\bfigureOf\(kept\.fit\?\.vram \?\? null, vram, appVram\?\.\(\) \?\? null\)/, 'the vram App hands the router is the address\'s figure, and appVram the app\'s')
  assert.equal(count(code(ROUTER), /\bfigureOf\(/g), 1, 'one figure, read in one place')
})

test('the Windows app\'s GPU reading is asked once a router, judged by figureFromAdapters, and kept by the page\'s router alone', () => {
  assert.ok(specifiers(APP).includes('./07_Execute_Actions/desktopShell.ts'), 'App imports the shell view')
  assert.match(PAGE_MIND, /^import \{ figureFromAdapters \} from '\.\/modelFit\.ts'$/m)
  assert.match(APP, /^import \{ shellGpuMemory, shellModel, shellModelFetch, shellRunner \} from '\.\/07_Execute_Actions\/desktopShell\.ts'$/m, 'the GPU reading, the app\'s model (siteModel.ts APP_MODEL) and the app\'s own runner')
  // App hands the reading over and never asks it itself; the city and the console alone hand the same one.
  assert.equal(count(APP_CODE, /\bshellGpuMemory\(/g), 0, 'App never asks it')
  assert.equal(count(APP_CODE, /\bgpuMemory: shellGpuMemory,/g), 2, 'the city\'s and the console alone\'s calls')
  assert.match(CITY, /^ {10}gpuMemory: shellGpuMemory,$/m)
  assert.match(TTY, /^ {6}gpuMemory: shellGpuMemory,$/m)
  const create = between(PAGE_MIND, 'export function createPageMind(d: PageMindDeps): PageMind {', '  const router = createMindRouter({')
  assert.match(create, /^ {2}let appVram: number \| null = null\n {2}void d\.gpuMemory\(\)\.then\(\(bytes\) => \{ appVram = figureFromAdapters\(bytes\) \}, \(\) => \{\}\)\n$/m, 'asked as the router is built, judged by figureFromAdapters')
  assert.equal(count(PAGE_MIND_CODE, /\bgpuMemory\(\)/g), 1, 'asked in one place')
  assert.match(PAGE_ROUTER, /^ {4}appVram: \(\) => appVram,$/m, 'a property of the router\'s own call')
  assert.equal(count(PAGE_MIND_CODE, /\bappVram: \(\) =>/g), 1, 'one router is handed it')
  assert.doesNotMatch(between(PAGE_MIND, 'export function onboardingVoice(', '\n}\n'), /appVram|gpuMemory/, 'the onboarding\'s router sizes nothing')
})

test('the operator\'s askSet and the bridge\'s both take \'vram\', and the mind\'s setter is optional', () => {
  const union = (src: string, re: RegExp): string[] => {
    const m = re.exec(src)
    assert.ok(m, `missing ${re.source}`)
    return m[1].split(' | ')
  }
  assert.ok(union(OPERATOR, /\baskSet: \(key: ([^,]+), value: string\): string =>/).includes("'vram'"), 'operator.ts askSet')
  assert.ok(union(BRIDGE, /\baskSet\(key: ([^,]+), value: string\): string$/m).includes("'vram'"), 'bridge.ts askSet')
  assert.match(OPERATOR, /^ {2}setVram\?\(value: string\): string$/m, 'Mind.setVram: absent on a mind that sizes nothing')
  assert.match(OPERATOR, /if \(key === 'vram'\) \{\n\s+if \(!mind\.setVram\) throw new Error\('no model provider on this page grows with the GPU'\)\n\s+return mind\.setVram\(value\)\n\s+\}/)
})

test('the context the router asks for reaches the Ollama client alone, worked out once as each answer is sent; modelFit.ts still imports only localCompute.ts', () => {
  const c = code(ROUTER)
  const flown = between(c, '  const flown = async (s: Flight | null, m: Mind, req: AnswerRequest, onPiece: (p: Piece) => void): Promise<Answer> => {', '\n  }\n')
  assert.match(flown, /^ {6}return await ollama\.answer\(req, onPiece, s\.ctx\)$/m, 'at the context its flight is noted at')
  assert.equal(count(c, /\.answer\([^)]*, s\.ctx\)/g), 1, 'one call hands a context')
  assert.equal(count(c, /\bollama\.answer\(/g), 1, 'every Ollama answer goes through flown')
  assert.doesNotMatch(LOCAL_CODE, /\bcontextFor\b/, 'the client asks the router for nothing as it sends')
  for (const p of ['llamacpp', 'openai']) assert.doesNotMatch(between(c, `  const ${p} = createLocalCompute({`, '\n'), /context/i, p)
  assert.deepEqual(specifiers(MODEL_FIT), ['./localCompute.ts'])
})
