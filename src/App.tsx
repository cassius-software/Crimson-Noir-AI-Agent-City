// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the page's React shell: the city (`GuiShell`) or the console alone (`TtyShell`, under
 * `?boot=tty`), the engine mounted with the page's options, and around it the boot veil, the HUD, the concierge, the
 * wardrobe card and the touch and console overlays. A first visit opens on the concierge's onboarding instead
 * (07_Execute_Actions/onboarding), which builds the lakefront metropolis in the background and hands the city its
 * outcome; the map walked (the metropolis, the embedded region, or the procedural city) is decided here (loadMap). It builds what the engine is handed through its seams instead of
 * importing (the cognition router with the model kept in this page, the network client), keeps the visitor's look and
 * session token, and screens the room's names and chat under 14A once more as they arrive. The model file kept in this
 * page is picked here too: one hidden file input, opened from the console's `ask file` or the Menu, or a file dropped on
 * the city on a desktop. The operator's progression reaches the city here too: the page's one keeper (progress.ts) is
 * earned into by the engine's deeds, the recruiter's arrivals and understood requests, and the wardrobe card, and its one
 * listener cues each success (the engine's chime and tap, the HUD's chip).
 * What breaks if it is removed? Nothing is mounted: the page is blank.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Engine, type EngineOptions } from './07_Execute_Actions/engine.ts'
import { Hud } from './07_Execute_Actions/Hud.tsx'
import { Terminal, type TerminalHandle } from './07_Execute_Actions/terminal/Terminal.tsx'
import { offlineBridge, type LookBridge, type ModelBridge, type NetBridge, type PendingAct, type TerminalBridge } from './07_Execute_Actions/terminal/bridge.ts'
import { hudLine, recruitBridge, Recruiter, speechEnv } from './08_Swarm/recruitment.ts'
import { isOpen as micIsOpen, Microphone, voiceStatus } from './04_Connect_Hardware/microphone.ts'
import { accessBridge, accessFromQuery, applyAccess, CAPTION_PX, cycleScale, highContrast, keepAccess, loadAccess, saveAccess, toggleContrast, type AccessSettings } from './07_Execute_Actions/access.ts'
import { browserDwellEnv, DwellClicker } from './04_Connect_Hardware/dwell.ts'
import { browserScanEnv, Scanner } from './04_Connect_Hardware/scanning.ts'
import { Announcer } from './07_Execute_Actions/announcer.ts'
import { TaskRouter } from './08_Swarm/taskRouter.ts'
import { deferredLedger, followRecruiter, indexedDbLedger, memoryBridge, SwarmMemory } from './08_Swarm/memory.ts'
import { airgapInstalled, loopbackFetch } from './02_Define_The_Rules/airgap.ts'
import { createMindRouter } from './09_Cognition/router.ts'
import { figureFromAdapters } from './09_Cognition/modelFit.ts'
import { shellGpuMemory } from './07_Execute_Actions/desktopShell.ts'
import { createInPageMind, type InPageMind } from './09_Cognition/inPage.ts'
import { runtimeMode } from './09_Cognition/inPageCaps.ts'
import { holdTier, type GpuMode, type PlanEnv } from './09_Cognition/inPagePlan.ts'
import { createModelStore, workerCopy, type KeptModel } from './09_Cognition/modelStore.ts'
import CopyWorker from './09_Cognition/modelStore.worker.ts?worker&inline'
import { createWllamaRuntime } from './09_Cognition/wllamaRuntime.ts'
import { canShareMemory } from './07_Execute_Actions/sharedBridge.ts'
import { trackWorker } from './07_Execute_Actions/longTasks.ts'
import { createLocalSpeech } from './09_Cognition/localSpeech.ts'
import { createNetClient } from './10_Network/netClient.ts'
import { admissibleChat, admissibleName } from './10_Network/replication.ts'
import type { NetControls } from './07_Execute_Actions/engine.ts'
import { GATE_CHECK_NAMES, type GateHandle, type GateLease, type Mind, type SkillGate } from './07_Execute_Actions/operator.ts'
import { TouchControls } from './04_Connect_Hardware/TouchControls.tsx'
import { isEditableTarget } from './04_Connect_Hardware/input.ts'
import type { SipocSnapshot } from './05_Observe_Environment/telemetry.ts'
import { BootVeil } from './07_Execute_Actions/BootVeil.tsx'
import { LockScreen, RecoveryCard } from './07_Execute_Actions/RecoveryCard.tsx'
import { ActCard } from './07_Execute_Actions/ActCard.tsx'
import { usePadNav } from './07_Execute_Actions/padNav.ts'
import { AUTO_RELOAD_KEY, autoReload, BOOT_STAGE, classify, explainHalt, firstScreen, FRAME_FAULT, haltClass, pageEnv } from './07_Execute_Actions/bootFailure.ts'
import { probeGpu, WebGPUUnavailableError, type GpuProbe } from './01_Initialize_World/gpuDevice.ts'
import { Concierge } from './07_Execute_Actions/Concierge.tsx'
import { Customizer } from './07_Execute_Actions/Customizer.tsx'
import { StoreCard } from './07_Execute_Actions/StoreCard.tsx'
import { HomeCard } from './07_Execute_Actions/HomeCard.tsx'
import { createShopkeeper, progressionPurse, type Shopkeeper } from './07_Execute_Actions/shopkeeper.ts'
import type { StoreItem } from './07_Execute_Actions/storeCatalog.ts'
import { DEED_BASE, PROPERTY_KINDS } from './01_Initialize_World/properties.ts'
import { loadProfile, type Profile } from './05_Observe_Environment/profile.ts'
import { loadLook, saveLook } from './05_Observe_Environment/lookStore.ts'
import { changeLook, describeLook, LOOK_SLOTS, lookFromSeed, type Look, type LookChange } from './03_Spawn_Agents/look.ts'
import { PLAYER_INDEX } from './03_Spawn_Agents/crowdCompute.ts'
import { clampPlayers } from './07_Execute_Actions/viewports.ts'
import type { PlanStep } from './06_Make_Decisions/intent.ts'
import { BRAND } from './brand.ts'
import embeddedRegion, { regionFirst } from 'virtual:region-pack'
import { validatePack, type RegionPack } from './01_Initialize_World/region/pack.ts'
import { ZONE, type Zone } from './01_Initialize_World/lakefront.ts'
import { LakefrontBuilder } from './01_Initialize_World/lakefrontClient.ts'
import { zoneOf } from './01_Initialize_World/lakefrontPack.ts'
import { builderPort } from './01_Initialize_World/lakefrontWorkerPort.ts'
import { screenNames } from './01_Initialize_World/assets/cc0.ts'
import { Onboarding, type Outcome } from './07_Execute_Actions/onboarding/Onboarding.tsx'
import { loadMapChoice, loadOnboarding, mapWanted, needsOnboarding, saveMapChoice, type MapChoice, type SavedOnboarding } from './07_Execute_Actions/onboarding/script.ts'
import { modelVoice, scriptedVoice, type Voice } from './07_Execute_Actions/onboarding/voice.ts'
import { ConciergeSpeaker, conciergeBridge, synthEnv, type ConciergeOut } from './07_Execute_Actions/onboarding/speaker.ts'
import { heardNow } from './07_Execute_Actions/onboarding/heard.ts'
import { useMentor } from './07_Execute_Actions/onboarding/useMentor.ts'
import { FirstWalkCard } from './07_Execute_Actions/onboarding/FirstWalk.tsx'
import { createExam } from './07_Execute_Actions/onboarding/exam.ts'
import { loadFirstWalk, needsFirstWalk } from './07_Execute_Actions/onboarding/firstWalkStore.ts'
import { useFirstWalk } from './07_Execute_Actions/onboarding/useFirstWalk.ts'
import { ROOM, toWorld } from './01_Initialize_World/interiors.ts'
import { yawFacing } from './07_Execute_Actions/head.ts'
import { MAX_WALK_MS } from './07_Execute_Actions/scriptedWalk.ts'
import { cueOf, earnFromRecruiter, hudProgress, pageProgress, progressBridge, worthCue, type ProgressCue } from './07_Execute_Actions/progress.ts'
import { SKILL_TITLE } from './02_Define_The_Rules/progression.ts'
import { agentBridge, identityLine, Roster, voiceProfile } from './08_Swarm/roster.ts'
import { parseRequest, SKILLS } from './03_Spawn_Agents/skills.ts'
import { FiveWhys } from './06_Make_Decisions/intent.ts'
import type { GoalPlan } from './07_Execute_Actions/terminal/bridge.ts'
import type { Voice as SpeechVoice } from './07_Execute_Actions/operator.ts'
import type { Event as MentorEvent } from './09_Cognition/tutorial.ts'
import { PROGRAM, WALK, type WalkEvent } from './09_Cognition/firstWalk.ts'

const HUD_INTERVAL_MS = 100
/**
 * Frames in a row that may throw once the city is up before it halts as a frame-loop fault (bootFailure.ts): one
 * transient throw costs a frame, not the session; a throw on every frame is a stopped city with a card, not a frozen one.
 */
const FRAME_FAULTS = 30
/** Where the cognition router's settings (the provider, each provider's server and model, the network key) are kept between visits. */
const COGNITION_KEY = 'civic-simulation:cognition:v2'
/** Where the local speech server's settings (its server, voice, model, auto) are kept between visits. */
const SPEECH_KEY = 'civic-simulation:speech:v1'
/** Characters of a streaming answer the HUD shows. */
const ANSWER_TAIL = 72
/** Where the network session token (`net join <url> <token>`) is kept between visits, like the cognition key; never in the page source. */
const NET_TOKEN_KEY = 'civic-simulation:net:v1'
/** The elite tier's passphrase record (operator.ts EliteVault): a salted hash, never the words. */
const ELITE_KEY = 'civic-simulation:elite:v1'

/** The page's own fetch, held to this machine (airgap.ts loopbackFetch): the model and speech clients speak through it, and nothing else does. */
const pageFetch = loopbackFetch((url, init) => window.fetch(url, init))

/** `make()` the first time it is asked for, and the same value every time after. */
function once<T>(make: () => T): () => T {
  let made: { value: T } | null = null
  return () => (made ??= { value: make() }).value
}

/**
 * One copy worker (modelStore.worker.ts, bundled into this file like the physics worker), counted among the page's
 * live workers (longTasks.ts) until workerCopy ends it.
 */
function copyWorker(): Worker {
  const worker = new CopyWorker({ name: 'model-copy' })
  const untrack = trackWorker()
  const terminate = worker.terminate.bind(worker)
  worker.terminate = () => { terminate(); untrack() }
  return worker
}

/**
 * The runtime under the model kept in this page (09_Cognition/wllamaRuntime.ts), one per page, made the first time
 * that model is asked about (whether this page can run one included): it starts nothing until a model loads.
 * ?debug lets its native log through.
 */
const PAGE_RUNTIME = once(() => createWllamaRuntime({ debug: new URLSearchParams(window.location.search).has('debug') }))
/**
 * Why this page cannot run the model kept in it (inPageCaps.ts runtimeMode: the browser lacks a piece, or the page was
 * opened from a file), or null: where it cannot, the Menu offers no Model file and `ask file` opens no picker.
 */
const PAGE_MODEL_REFUSAL = once((): string | null => {
  const mode = runtimeMode(PAGE_RUNTIME().caps())
  return mode.ok ? null : mode.reason
})
/** Where the page keeps model files (its own storage, 09_Cognition/modelStore.ts), one per page, each file copied by a worker of its own. */
const PAGE_MODELS = once(() => createModelStore({ copy: workerCopy(copyWorker) }))
/** The toasts' title for the model file kept in this page. */
const MODEL_FILE = 'Model file'
/** How long after the page has its focus back a file picker that said nothing (no change, no cancel) counts as closed. */
const PICK_SETTLE_MS = 1000

/** The page's local storage for one key; a browser that refuses storage keeps the settings for this visit only. */
const pageStore = (key: string) => ({
  load: (): string | null => {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  save: (value: string): void => {
    try {
      localStorage.setItem(key, value)
    } catch {
      // storage refused
    }
  },
})

/** The homes the shopkeeper says the player owns, one bit per property index (bit i: deed DEED_BASE + i). */
function ownedHomes(keeper: Shopkeeper): number {
  let mask = 0
  for (let i = 0; i < PROPERTY_KINDS.length; i++) if (keeper.owns(DEED_BASE + i)) mask |= 1 << i
  return mask
}

/**
 * The console's network knob over the engine's session controls (NetControls), with the session token kept on this
 * machine: a token given is saved and reused by a later `join` without one; `forget` drops it. Nothing else of the
 * session lives here: the engine joins, draws and leaves.
 */
function netBridge(net: NetControls, store: { load(): string | null; save(value: string): void }): NetBridge {
  return Object.freeze({
    join: (url: string, token?: string): Promise<string> => {
      const kept = store.load()
      const t = token?.trim() || kept || ''
      if (t === '') return Promise.reject(new Error('a session token is required (net join <url> <token>; it is kept for next time)'))
      if (token && token.trim() !== kept) store.save(token.trim())
      return net.join(url, t)
    },
    leave: () => net.leave(),
    status: () => net.status(),
    forget: () => {
      if (!store.load()) return 'no token kept'
      store.save('')
      return 'token forgotten'
    },
  })
}

/**
 * The console's look knob (terminal/bridge.ts LookBridge) over App's own look state, so the React state, the saved
 * look (lookStore.ts) and the player's body stay one thing: a change goes through `wear` (wearLook), which saves
 * it and re-dresses agent PLAYER_INDEX through the engine; `show` reads what is worn now, or what a pedestrian
 * wears (the engine's word, else the hash's look for that index). `random` without a seed draws one here, so the
 * pure change stays deterministic.
 */
function lookBridge(host: { worn(): Look; seed(): number; wear(look: Look): void; lookOf(agent: number): Look | null; agents: number }): LookBridge {
  return Object.freeze({
    show: (agent?: number): string[] => {
      if (agent === undefined || agent === PLAYER_INDEX) return describeLook(host.worn())
      if (!Number.isInteger(agent) || agent < 0 || agent >= host.agents) throw new Error(`no pedestrian ${agent} (0-${host.agents - 1})`)
      return describeLook(host.lookOf(agent) ?? lookFromSeed(agent))
    },
    set: (change: LookChange): string[] => {
      const seeded = change.kind === 'random' && !Number.isFinite(change.seed) ? { kind: 'random' as const, seed: Math.floor(Math.random() * 0x7fffffff) } : change
      const r = changeLook(host.worn(), seeded, host.seed())
      if (r.look === null) throw new Error(r.error)
      host.wear(r.look)
      return describeLook(r.look)
    },
  })
}

/**
 * The HUD's view of the operator's local model and voice: an answer streaming in (its latest words, that the model
 * is still thinking, or what the model in this page is doing first: loading, reading the prompt), what the model in
 * this page is doing with no answer waiting (loading, a file being kept), or who is speaking aloud.
 */
function activityText(a: { thinking: number; tail: string } | null, speaking: number, model: string | null = null): string {
  if (!a) return model ? `${model.charAt(0).toUpperCase()}${model.slice(1)}` : speaking >= 0 ? `Speaking · agent ${speaking}` : ''
  if (a.tail) return `Answering: …${a.tail.replace(/\s+/g, ' ').trimStart()}`
  if (model) return `Answering · ${model}`
  return a.thinking ? `Answering · thinking (${a.thinking})` : 'Answering · waiting for the model'
}

/** An error as the plain words it carries. */
const plain = (e: unknown): string => (e instanceof Error ? e.message : String(e))

/** "1.2 GB", "640 MB" or "153 KB". */
function sizeText(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** navigator.deviceMemory in GB (Chromium only, rounded by the browser), or undefined where the browser does not say. */
function deviceMemory(): number | undefined {
  const m = (navigator as { deviceMemory?: unknown }).deviceMemory
  return typeof m === 'number' && Number.isFinite(m) && m > 0 ? m : undefined
}

/** The console's line for `ask gpu <mode>`: where the model kept in this page runs from its next load. */
function gpuLine(mode: GpuMode): string {
  if (mode === 'on') return 'on: the model runs on the GPU from its next load (one the GPU cannot load runs on the processor)'
  if (mode === 'off') return 'off: the model runs on the processor from its next load'
  return 'auto: the model runs on the GPU from its next load on a desktop whose GPU has shader-f16, else on the processor'
}

/** The browser's file picker over the page's hidden file input (filePicker). */
interface FilePicker {
  open(): Promise<File[] | null>
  dispose(): void
}

/**
 * The browser's file picker over one hidden file input, which has no accept attribute (a phone greys out a .gguf it
 * has no type for). open() clicks the input at once, so it must be called inside the tap or the key that asked (a
 * browser opens its picker only then, and refuses here without one), and resolves with the files chosen, or null for
 * none: on the input's change or cancel, or, where a browser sends neither, PICK_SETTLE_MS after the page has its focus
 * back. The input is emptied after each read, so the same file can be chosen again. A choice that arrives after its
 * picker counted as closed goes to `late`.
 */
function filePicker(input: HTMLInputElement, late: (files: File[]) => void): FilePicker {
  let waiting: ((files: File[] | null) => void) | null = null
  let timer = 0
  const read = (): File[] | null => {
    const files = Array.from(input.files ?? [])
    input.value = ''
    return files.length ? files : null
  }
  const settle = (files: File[] | null): void => {
    window.clearTimeout(timer)
    window.removeEventListener('focus', onFocus)
    const w = waiting
    waiting = null
    if (w) w(files)
    else if (files) late(files)
  }
  const onChange = (): void => settle(read())
  const onCancel = (): void => settle(null)
  function onFocus(): void {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => { if (waiting) settle(read()) }, PICK_SETTLE_MS)
  }
  input.addEventListener('change', onChange)
  input.addEventListener('cancel', onCancel)
  return {
    open: () => {
      const activation = (navigator as { userActivation?: { isActive?: boolean } }).userActivation
      if (activation && activation.isActive === false) return Promise.reject(new Error('the browser opens its file picker only from a tap or a key: Menu › Model file, or ask file at the console'))
      // A picker still waiting (its browser never said how it closed) counts as closed with nothing chosen.
      settle(null)
      const chosen = new Promise<File[] | null>((resolve) => { waiting = resolve })
      input.value = ''
      window.addEventListener('focus', onFocus)
      input.click()
      return chosen
    },
    dispose: () => {
      input.removeEventListener('change', onChange)
      input.removeEventListener('cancel', onCancel)
      settle(null)
    },
  }
}

/**
 * The region every build carries (vite.config.ts regionPack), unpacked and checked when the page walks it: ?region=on
 * in any build, by default in the pilot build. Nothing is fetched: the bytes are in this file. Its names pass the CC0
 * gate (assets/cc0.ts) on the way, as every asset that reaches the page does.
 */
async function loadRegion(): Promise<RegionPack> {
  const bytes = Uint8Array.from(atob(embeddedRegion), (c) => c.charCodeAt(0))
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  const pack = validatePack(JSON.parse(text))
  const purged = screenNames([pack.name, ...pack.names, ...pack.attribution], 'embedded region')
  if (purged.length) throw new Error(`the embedded region names something after a weapon: ${purged.map((p) => p.asset).join(', ')}`)
  return pack
}

/** Which map the page walks and, for the generated metropolis, the pack the onboarding already built and where it starts. */
interface MapPlan { choice: MapChoice; pack: RegionPack | null; zone: Zone }

/**
 * The map the engine is handed: the embedded region, the lakefront metropolis (the pack the onboarding built, or one
 * built now in the worker for ?map=lakefront and returning visitors), or null for the procedural city.
 */
async function loadMap(plan: MapPlan): Promise<RegionPack | null> {
  if (plan.choice === 'region') return loadRegion()
  if (plan.choice !== 'lakefront') return null
  if (plan.pack) return plan.pack
  const b = new LakefrontBuilder(readOptions().seed, builderPort())
  try { return await b.pack(plan.zone) } finally { b.dispose() }
}

/** Which shell the page boots: 'gui' (the city) or 'tty' (?boot=tty: the full-screen console alone, no engine). */
type BootTrack = 'gui' | 'tty'

type Options = EngineOptions & { debug: boolean; boot: BootTrack; vram: string | null }

/** The console's bridge in the TTY shell: no engine exists, so everything but the identity commands says so. */
const TTY_BRIDGE: TerminalBridge = offlineBridge({ ...BRAND, track: 'tty' })

/**
 * Reloads the page on `track` (Track B's `boot gui|tty`): the URL keeps every other option. A reload, not a
 * remount: no engine teardown races, and the single file needs no server.
 */
function reboot(track: BootTrack): void {
  const url = new URL(window.location.href)
  if (track === 'tty') url.searchParams.set('boot', 'tty')
  else url.searchParams.delete('boot')
  window.location.assign(url.toString())
}

/** The cards' 'Open the console': the ?boot=tty shell, which needs no GPU (the only console route on a touch screen). */
const toConsole = (): void => reboot('tty')

/**
 * A graphics reset while the page was hidden (the player was in another app or tab, or switched away while the city
 * loaded): once the page is visible again (at once, if it already is) it restarts by itself, at most once per
 * AUTO_RELOAD_GAP_MS and never where the time of the last restart cannot be kept (bootFailure.ts autoReload); a reset
 * seen while visible keeps the card and its Restart. Returns the unwatch.
 */
function reloadWhenVisible(hiddenAtLoss: boolean): () => void {
  if (!hiddenAtLoss) return noop
  const back = () => {
    if (document.hidden) return
    document.removeEventListener('visibilitychange', back)
    let lastMs: number | null = null
    let storageOk = true
    try {
      const v = localStorage.getItem(AUTO_RELOAD_KEY)
      lastMs = v === null ? null : Number(v)
    } catch {
      storageOk = false
    }
    if (!autoReload({ lastMs, nowMs: Date.now(), hiddenAtLoss, storageOk })) return
    try {
      localStorage.setItem(AUTO_RELOAD_KEY, String(Date.now()))
    } catch {
      return
    }
    window.location.reload()
  }
  // A boot that failed in the background may only report it once the player is back: then it is now.
  if (!document.hidden) {
    back()
    return noop
  }
  document.addEventListener('visibilitychange', back)
  return () => document.removeEventListener('visibilitychange', back)
}

/**
 * Reloads the page on a map (the console's `map city|lakefront|default`): the choice is kept between visits, because
 * the desktop app has no address bar to say `?map=` in, and the URL's own map words are dropped so the kept choice
 * (or, after `default`, the usual order: the onboarding's metropolis, else the procedural city) decides.
 */
function remap(choice: 'city' | 'lakefront' | 'default'): void {
  saveMapChoice(choice === 'default' ? null : choice)
  const url = new URL(window.location.href)
  url.searchParams.delete('map')
  url.searchParams.delete('region')
  window.location.assign(url.toString())
}

const noop = (): void => {}

function readOptions(): Options {
  const q = new URLSearchParams(window.location.search)
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(q.get(key))
    return q.has(key) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  }
  // Lowercased once so ?quality=Lite or ?quality=AUTO read as the words they are (num() reads the raw value for digits).
  const quality = q.get('quality')?.toLowerCase() ?? null
  return {
    // Absent: the device profile decides (governor.ts defaultAgents: 14,000 on a desktop GPU, fewer on phones).
    agents: q.has('crowd') ? Math.round(num('crowd', 14000, 256, 60000)) : undefined,
    // Absent: the device profile decides (governor.ts defaultCars: 36, or 12 on a lite profile).
    cars: q.has('cars') ? Math.round(num('cars', 36, 0, 48)) : undefined,
    pixelRatio: num('scale', Math.min(window.devicePixelRatio, 1), 0.25, 2),
    seed: Math.round(num('seed', 1337, 0, 2 ** 31)),
    // Golden hour: the sun about 10° up in the west (solar.ts), long warm light for the first look.
    startHour: num('time', 17, 0, 24),
    dayMinutes: num('day', 24, 1, 1440),
    shadows: q.get('shadows') !== '0',
    post: q.get('post') !== '0',
    rigCapsules: q.get('rigs') === 'capsules',
    profile: q.has('profile'),
    // -1 (or the word 'lite') is Lite, below Minimal; 0…4 are Minimal…Ultra; 5 (or the word 'peak') is Peak, above Ultra.
    quality: quality === null || quality === 'auto' ? 'auto' : quality === 'lite' ? -1 : quality === 'peak' ? 5 : Math.round(num('quality', 3, -1, 5)),
    targetFps: Math.round(num('fps', 0, 0, 240)),
    audio: q.get('audio') !== '0',
    // Closed captions of every spatial sound (captions.ts); ?captions=0 keeps the HUD's strip empty.
    captions: q.get('captions') !== '0',
    // Controller rumble and phone vibration (the guardrails' feel and a check's tap); ?haptics=0 starts them off.
    haptics: q.get('haptics') !== '0',
    debug: q.has('debug'),
    // Track B: ?boot=tty mounts the full-screen console alone (no canvas, no engine, no WebGPU, no worker, no audio).
    boot: q.get('boot') === 'tty' ? 'tty' : 'gui',
    // The AI fleet on fixed tracks (zero-jam rings); ?tracks=0 restores the random street-hopping routes.
    tracks: q.get('tracks') !== '0',
    // The cinema camera (24 fps, 180° shutter, ND, film response); ?cinema=0 draws every frame with ACES.
    cinema: q.get('cinema') !== '0',
    // The ragdoll balance machine over the pedestrians near the operator; ?ragdoll=0 keeps everyone on the GPU alone.
    ragdoll: q.get('ragdoll') !== '0',
    // Local split screen: ?players=2..4 cuts the canvas into a viewport per player (viewports.ts clamps it to 1..4).
    players: clampPlayers(q.get('players')),
    // The lite profile (governor.ts DeviceProfile.lite): ?lite=1 forces it on any device, ?lite=0 keeps it off; absent,
    // the device profile decides (an entry-level phone GPU such as a Mali-G52 is lite).
    lite: q.get('lite') === '1' ? true : q.get('lite') === '0' ? false : undefined,
    // The Peak candidacy (governor.ts peakCandidate): ?peak=1 lets any desktop's governor try Peak, ?peak=0 keeps it off;
    // absent, the device profile decides. A phone or a lite profile never tries it, and none does without GPU timestamps.
    peak: q.get('peak') === '1' ? true : q.get('peak') === '0' ? false : undefined,
    // The scene's multisampling (governor.ts msaaCandidate): ?msaa=1 draws 4 samples a pixel on any desktop, ?msaa=0
    // never; absent, the device profile decides. A phone or a lite profile never does. Read once, at boot.
    msaa: q.get('msaa') === '1' ? true : q.get('msaa') === '0' ? false : undefined,
    // The post chain's ambient occlusion (governor.ts aoCandidate): ?ao=0 leaves it out; absent (or ?ao=1), any desktop
    // builds it and Ultra and Peak run it. A phone or a lite profile never builds it. Read once, at boot.
    ao: q.get('ao') === '1' ? true : q.get('ao') === '0' ? false : undefined,
    // The GPUs' memory in GB for the size of model auto gives Ollama (09_Cognition/modelFit.ts): the NixOS launcher adds
    // it from nvidia-smi or the amdgpu driver; ask vram at the console beats it, and it beats the Windows app's reading;
    // absent (and with no reading), auto keeps its usual model.
    vram: q.get('vram'),
  }
}

/**
 * Track B: the bare console. Nothing of the city is built: no canvas, no Engine.create, no WebGPU adapter request,
 * no physics worker, no audio, no HUD. The terminal runs over the offline bridge (the identity commands work; the
 * rest says 'engine not running'); a `boot gui` result reloads into the city, and so does 'Back to the city', the one
 * way back for a player who came here from a recovery card with only a pad or a touch screen (its A presses it).
 */
function TtyShell() {
  const back = useRef<HTMLDivElement>(null)
  usePadNav(back)
  return (
    <main className="relative h-full w-full overflow-hidden bg-black">
      <div ref={back} data-way-out="" className="absolute right-[max(0.75rem,env(safe-area-inset-right))] top-[max(0.75rem,env(safe-area-inset-top))] z-[10000]">
        <button type="button" onClick={() => reboot('gui')} className="min-h-11 rounded-xl border border-white/25 bg-black/80 px-4 py-2 font-sans text-sm font-semibold text-slate-200 outline-none ring-white/40 hover:bg-white/10 focus-visible:ring-4">
          Back to the city
        </button>
      </div>
      <Terminal bridge={TTY_BRIDGE} fullscreen onOpenChange={noop} onBoot={reboot} onMap={remap} />
    </main>
  )
}

/**
 * The voice the onboarding speaks with: the configured model backend's rewording when it answers in time, else the
 * script. With the auto provider (the default), the scripted provider, the in-page provider, or the Claude provider and
 * no key kept, nothing is asked (the script is the voice): a first visit on a fresh machine makes no request at all,
 * the scripted provider, which answers a request with nobody tethered with a line of its own, never rewords the
 * guide's lines, and a model file kept in this page is never loaded while the city is still being built (this router
 * is handed no runtime for one).
 */
function onboardingVoice(): Voice {
  const router = createMindRouter({ fetch: pageFetch, store: pageStore(COGNITION_KEY) })
  const s = router.settings()
  if (s.provider === 'auto' || s.provider === 'scripted' || s.provider === 'inpage' || (s.provider === 'claude' && !s.key)) return scriptedVoice()
  return modelVoice(router, (line) => (/morning, sunset or night/i.test(line) ? ['morning', 'sunset', 'night'] : /sound on/i.test(line) ? ['sound'] : []))
}

/** The operating system's own contrast switch (`prefers-contrast: more`), which the 'auto' contrast setting follows (access.ts). */
const PREFERS_MORE = (() => {
  let list: MediaQueryList | null = null
  const media = () => (list ??= window.matchMedia('(prefers-contrast: more)'))
  return {
    subscribe(onChange: () => void) {
      const m = media()
      m.addEventListener('change', onChange)
      return () => m.removeEventListener('change', onChange)
    },
    matches: () => media().matches,
    server: () => false,
  }
})()

function App() {
  // Read once: the boot track decides which shell mounts, so the hooks of each shell live in that shell.
  const [options] = useState(readOptions)
  // Accessibility (07_Execute_Actions/access.ts): kept between visits, set for one visit in the URL, and written onto
  // <html> (data-contrast, --ui-zoom) here, above every shell, so the onboarding, the console alone and the way-out
  // card hold it too; 'auto' contrast follows the system's switch. What is kept and what is live are followed by hand:
  // a change keeps only the fields it changes (keepAccess), so a setting the URL gave for one visit is not written down
  // by a later switch of something else; a reset is kept whole.
  const [start] = useState(() => { const kept = loadAccess(); return { kept, live: accessFromQuery(new URLSearchParams(window.location.search), kept) } })
  const [access, setAccessState] = useState(start.live)
  const keptRef = useRef(start.kept)
  const liveRef = useRef(start.live)
  const prefersMore = useSyncExternalStore(PREFERS_MORE.subscribe, PREFERS_MORE.matches, PREFERS_MORE.server)
  const onAccess = useCallback((next: AccessSettings, whole?: boolean) => {
    keptRef.current = whole === true ? next : keepAccess(keptRef.current, liveRef.current, next)
    liveRef.current = next
    setAccessState(next)
    saveAccess(keptRef.current)
  }, [])
  useEffect(() => { applyAccess(access, prefersMore, document.documentElement) }, [access, prefersMore])
  // The hands (access.ts dwell, scan): a pointer resting on a control presses it; the controls offered in turn, Space
  // pressing the one offered. Here above every shell, so the onboarding and the console alone have them too.
  useEffect(() => {
    if (!access.dwell) return
    const dwell = new DwellClicker(browserDwellEnv())
    dwell.start()
    return () => dwell.stop()
  }, [access.dwell])
  useEffect(() => {
    if (!access.scan) return
    const scan = new Scanner(browserScanEnv())
    scan.start()
    return () => scan.stop()
  }, [access.scan])
  // A first visit (no saved onboarding, no profile) opens on the concierge's onboarding, which builds the metropolis in the
  // background and hands its outcome here; a returning visitor goes straight to the map they chose (script.ts).
  const [saved] = useState<SavedOnboarding | null>(loadOnboarding)
  const [onboard] = useState(() => needsOnboarding(new URLSearchParams(window.location.search), saved, loadProfile()))
  // The first walk (onboarding/firstWalkStore.ts): on until its exit program has unlocked the city once, unless the URL says otherwise.
  const [walk] = useState(() => needsFirstWalk(new URLSearchParams(window.location.search), loadFirstWalk()))
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [voice] = useState(onboardingVoice)
  // Sloane's spoken voice, one for the onboarding and the city (the link is filled in once the engine is up).
  const [link] = useState<SpeakerLink>(() => ({ sound: () => true, source: null }))
  const [speaker] = useState(() => new ConciergeSpeaker({ env: synthEnv(), sound: () => link.sound(), source: () => link.source }))
  // A first visit is asked of nobody until a quick look says this browser can run the city at all (a secure page,
  // navigator.gpu, a core adapter: gpuDevice.ts probeGpu); one that cannot gets the recovery card instead of the whole
  // onboarding and a metropolis build first. The splash stays up meanwhile. Never for ?boot=tty, which needs no GPU.
  const [probe, setProbe] = useState<GpuProbe | null>(null)
  const probing = options.boot !== 'tty' && onboard
  useEffect(() => {
    if (!probing) return
    let live = true
    void probeGpu(navigator.gpu, window.isSecureContext !== false, window.location.origin).then((p) => { if (live) setProbe(p) })
    return () => { live = false }
  }, [probing])
  if (options.boot === 'tty') return <TtyShell />
  if (onboard && !outcome) {
    const first = firstScreen({ onboard, probe })
    if (first === 'probing') return <BootVeil ready={false} onDone={noop} onConsole={toConsole} stage={BOOT_STAGE.probe} />
    if (first === 'card' && probe && !probe.ok) return <RecoveryCard failure={classify(probe.error, pageEnv())} onConsole={toConsole} />
    return <Onboarding seed={options.seed} onDone={setOutcome} port={builderPort} voice={voice} speaker={speaker} />
  }
  const chosen = outcome?.saved ?? saved
  const choice = mapWanted(new URLSearchParams(window.location.search), chosen, regionFirst, loadMapChoice())
  const zone = zoneOf(chosen?.place) ?? ZONE.metropolis
  const shellOptions = outcome?.options ? { ...options, ...outcome.options } : options
  // Sloane watches the first minutes of a visitor who has just walked in from the onboarding (never the expert path).
  const mentored = outcome !== null && !outcome.saved.skipped
  return <GuiShell options={shellOptions} plan={{ choice, pack: outcome?.pack ?? null, zone }} mentored={mentored} walk={walk} voice={voice} speaker={speaker} link={link} access={access} prefersMore={prefersMore} onAccess={onAccess} />
}

/**
 * The tier a brief's quality step pins: its own value, or, for a ceiling (a fix for heat or a slow frame), the lower of
 * that and the live tier, so the fix never moves a device onto a heavier tier than the one it is on.
 */
function qualityFor(step: PlanStep, b: Pick<TerminalBridge, 'quality'>): 'auto' | number {
  const v = step.value as 'auto' | number
  return step.ceiling && typeof v === 'number' ? Math.min(v, b.quality().tier) : v
}

/**
 * The console's `goal` (terminal/bridge.ts GoalPlan): the goal planned as Sloane plans one (06_Make_Decisions/intent.ts),
 * its immediate steps applied through the same knobs the Concierge uses (the clock, the quality tier, the sound).
 */
function goalPlan(text: string, b: Pick<TerminalBridge, 'setClock' | 'quality' | 'audio'>): GoalPlan {
  const brief = new FiveWhys(text).brief()
  const steps: { label: string; state: 'done' | 'later' | 'failed'; detail?: string }[] = []
  for (const step of brief.plan) {
    if (!step.immediate) { steps.push({ label: step.label, state: 'later' }); continue }
    try {
      if (step.control === 'time' && typeof step.value === 'number') b.setClock(step.value)
      else if (step.control === 'quality' && (step.value === 'auto' || typeof step.value === 'number')) b.quality(qualityFor(step, b))
      else if (step.control === 'audio' && (step.value === 'on' || step.value === 'off' || typeof step.value === 'number')) b.audio(step.value)
      else { steps.push({ label: step.label, state: 'later' }); continue }
      steps.push({ label: step.label, state: 'done' })
    } catch (e) {
      steps.push({ label: step.label, state: 'failed', detail: e instanceof Error ? e.message : String(e) })
    }
  }
  return { root: brief.root, steps, notes: brief.unmapped }
}

/**
 * What Sloane's voice reads of the page (onboarding/speaker.ts): whether the sound is on (the onboarding before the
 * city is up: yes, the card only asks once sound was chosen on; the city: its soundscape's state), and the operator's
 * speech provider with the soundscape that places it at the player's head, once the engine exists.
 */
interface SpeakerLink { sound(): boolean; source: { voice: SpeechVoice; out: ConciergeOut } | null }

/** The city: the engine over the canvas, the HUD, the Concierge, the touch controls and the drop-down console. */
/** The most "Walk for me" keeps walking for, wall-clock ms (the stage's three metres end it long before on any ordinary frame). */
const SHOW_WALK_MS = 60_000

function GuiShell({ options, plan, mentored, walk, voice, speaker, link, access, prefersMore, onAccess }: {
  options: Options; plan: MapPlan; mentored: boolean; walk: boolean; voice: Voice; speaker: ConciergeSpeaker; link: SpeakerLink
  access: AccessSettings; prefersMore: boolean; onAccess: (next: AccessSettings, whole?: boolean) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // The city's element (a model file dropped on it is kept, on a desktop) and the hidden file input the picker opens.
  const mainRef = useRef<HTMLElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // The Menu's Model file: the picker opened inside the tap, then the file kept (set once the engine is up).
  const modelFileRef = useRef<(() => void) | null>(null)
  const onModelFile = useCallback(() => modelFileRef.current?.(), [])
  const engineRef = useRef<Engine | null>(null)
  const termOpenRef = useRef(false)
  const termRef = useRef<TerminalHandle>(null)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [bridge, setBridge] = useState<TerminalBridge | null>(null)
  const [termOpen, setTermOpen] = useState(false)
  const [hud, setHud] = useState<SipocSnapshot | null>(null)
  const [hudVisible, setHudVisible] = useState(true)
  const [adapter, setAdapter] = useState('')
  // Why the boot failed (whatever was thrown, words from bootFailure.ts classify), or null while nothing has.
  const [error, setError] = useState<{ cause: unknown } | null>(null)
  // What the boot is doing, for the veil's 'Still starting' line (bootFailure.ts BOOT_STAGE).
  const [stage, setStage] = useState<string>(BOOT_STAGE.map)
  // Read synchronously, so the very first render already knows a returning visitor.
  const [profile, setProfile] = useState<Profile | null>(loadProfile)
  // The look the visitor chose (lookStore.ts), or null: then their own seed's look (the first use of profile.seed),
  // or, unnamed, the hash's for the player's body. The wardrobe card is Sloane's to open.
  const [look, setLook] = useState<Look | null>(loadLook)
  const [lookOpen, setLookOpen] = useState(false)
  // The player's own agents (08_Swarm/roster.ts): the card's second tab and the console's `agent` share it; the engine
  // reads who a hired pedestrian goes by for their prompts, and `say` speaks them in their own provider voice.
  const [roster] = useState(() => new Roster())
  const [agents, setAgents] = useState(() => roster.list())
  useEffect(() => roster.onChange(() => setAgents(roster.list())), [roster])
  // The microphone (04_Connect_Hardware/microphone.ts): opened as the city starts (MIC_OPEN_BY_DEFAULT, the one line)
  // unless the visitor muted it or said no at the browser's prompt on an earlier visit; the pill, V, the right stick's
  // click and the Menu's item mute and unmute it, the switch kept between visits; one per shell, disposed with it. The
  // engine hands the presses here and never opens one itself.
  const [mic] = useState(() => new Microphone())
  const onMic = useCallback(() => { void mic.toggle() }, [mic])
  // Closed, not disposed, on unmount: React's development double mount runs this cleanup and then the shell again with
  // the same microphone, which must still open; close() drops any open still in flight and releases the device.
  useEffect(() => () => { mic.close() }, [mic])
  // Accessibility (access.ts): high contrast in force now; the settings behind refs for the console's bridge, which is
  // built once with the engine; the colour-vision filter handed to the post chain as it changes.
  const high = highContrast(access, prefersMore)
  const accessRef = useRef(access)
  const prefersRef = useRef(prefersMore)
  useEffect(() => { accessRef.current = access; prefersRef.current = prefersMore }, [access, prefersMore])
  useEffect(() => { engine?.setVision(access.vision) }, [engine, access.vision])
  useEffect(() => { engine?.input.setHand(access.pad) }, [engine, access.pad])
  // The screen reader's lines (announcer.ts), one per shell: it keeps what it has said.
  const [announcer] = useState(() => new Announcer())
  // Sloane's voice and the microphone: the detector allows for the page's own voice (the pill reads Speaking) and learns
  // her echo at each line's start, a line that cuts the one still playing included; speech starting while Sloane
  // speaks cuts the line (barge-in).
  useEffect(() => {
    const untell = speaker.onSpeaking((on) => mic.setSpeaking(on))
    const unline = speaker.onLine(() => mic.newLine())
    const barge = () => speaker.stop()
    mic.addEventListener('barge', barge)
    return () => {
      untell()
      unline()
      mic.setSpeaking(false)
      mic.removeEventListener('barge', barge)
    }
  }, [mic, speaker])
  // Words the visitor said near the open microphone that were not a recruitment request: Sloane's (Concierge.tsx heard).
  const [heard, setHeard] = useState<{ id: number; text: string } | null>(null)
  useEffect(() => {
    engine?.setIdentities((agent) => { const id = roster.byAgent(agent); return id ? identityLine(id) : null })
    return () => engine?.setIdentities(null)
  }, [engine, roster])
  // The operator tier names who proposes a city action (`Mara (agent 17, Design)`) by the roster's name for the hire.
  useEffect(() => {
    engine?.setNameOf((agent) => roster.byAgent(agent)?.name ?? null)
    return () => engine?.setNameOf(null)
  }, [engine, roster])
  // The card re-dresses a hired agent at once; a profile name is the browser tier's, not a provider voice.
  const wearAgentLook = useCallback((name: string, next: Look | null) => {
    const id = roster.set(name, 'look', next)
    if (id.agent !== null) engineRef.current?.setLook(id.agent, id.look)
  }, [roster])
  const onSay = useCallback((text: string) => { void speaker.speak(text) }, [speaker])
  const onHear = useCallback((voice: string, line: string) => { void speaker.preview(line, voice) }, [speaker])
  const lookOpenRef = useRef(false)
  // The storefronts (01_Initialize_World/storefronts.ts): the one shopkeeper every purchase goes through, the shop whose
  // card is open (its index in engine.shops, or null), and the line being tried on (worn on the body, never kept). It buys
  // through the page's one progression keeper: its level, its credits, its purchase gate (progress.ts).
  const [keeper] = useState(() => createShopkeeper({ purse: progressionPurse(pageProgress()) }))
  const [storeOpen, setStoreOpen] = useState<number | null>(null)
  // The frame loop's view of it: the open shop's index, or null.
  const storeOpenRef = useRef<number | null>(null)
  const [trying, setTrying] = useState<{ id: number; look: Look } | null>(null)
  // The homes (01_Initialize_World/properties.ts): the home whose doorstep card is open (its property index, 0 to 6), or
  // null, and the frame loop's view of it.
  const [homeOpen, setHomeOpen] = useState<number | null>(null)
  const homeOpenRef = useRef<number | null>(null)
  const [veilDone, setVeilDone] = useState(false)
  // A Ring-0 kernel panic: the engine is halted and the reason is shown over everything.
  const [locked, setLocked] = useState<string | null>(null)
  const lockedRef = useRef(locked)
  useEffect(() => { lockedRef.current = locked }, [locked])
  // A city action an agent proposed, waiting for the operator's OK (07_Execute_Actions/acts.ts; the bridge's acts.follow
  // feeds it): the card, the input shield and the HUD line all derive from this one state, and actRef is the frame
  // loop's view of it. Every proposal, decision and end: the card and the shield come up on `proposed` and go on
  // `ended`; with the console closed a toast says what was proposed and how it ended (open, the lines are in the
  // scrollback). A refusal or a withdrawal toasts nothing (the person did it); an abort is the gate wrapper's `Task aborted`.
  const [act, setAct] = useState<PendingAct | null>(null)
  const actRef = useRef<PendingAct | null>(null)
  useEffect(() => bridge?.operator.acts.follow((ev) => {
    actRef.current = ev.kind === 'proposed' ? ev.act : null
    setAct(actRef.current)
    if (termOpenRef.current) return
    if (ev.kind === 'proposed') engineRef.current?.toast('City action', `${ev.act.who} proposes: ${ev.act.sentence} (Y allows, N refuses)`)
    else if (ev.kind === 'ended' && (ev.end.state === 'done' || ev.end.state === 'failed' || ev.end.state === 'denied')) engineRef.current?.toast('City action', `${ev.end.state === 'denied' ? 'refused' : ev.end.state}: ${ev.end.line}`)
  }), [bridge])
  // While a proposal waits, the pad's edges and the touch taps are the card's (04_Connect_Hardware/input.ts shield): the
  // south face button presses the card, never the car door, so the OK cannot break the proposer's tether. Keys, sticks
  // and the mouse stay the game's.
  useEffect(() => { engineRef.current?.input.shield(act !== null) }, [act])
  // The card's two buttons (and its Y and N): through the operator bridge, so the proposal runs under the proposer's
  // tether like `act ok`; a press after the proposal ended (the console answered first, the tether broke) is nothing.
  const allowAct = useCallback(() => { try { void bridge?.operator.acts.allow('card').result.catch(noop) } catch { /* already ended */ } }, [bridge])
  const refuseAct = useCallback(() => { try { bridge?.operator.acts.refuse('card') } catch { /* already ended */ } }, [bridge])
  // The first walk (onboarding/useFirstWalk.ts): Sloane's six stages before the city is the visitor's, ended only by the
  // console's exit program. Its reports come from the Concierge (a goal sent), the console (a line run, its opening),
  // the HUD (the microphone, the captions) and, in time, the exam; walkRef is the handlers' view of it.
  const fw = useFirstWalk({ active: walk && veilDone, engine, hud, family: hud?.supplier.glyphs ?? 'keyboard', name: profile?.name ?? '', voice, termOpen })
  const walking = walk && !fw.passed
  // Sloane's card (not her chip) on screen: in a wide window too narrow for both, the walk's card steps aside for it.
  const [sloaneOpen, setSloaneOpen] = useState(false)
  const walkRef = useRef(fw)
  useEffect(() => { walkRef.current = fw }, [fw])
  const onGoalSent = useCallback(() => walkRef.current.note('goal'), [])
  const listening = hud?.supplier.recruiting?.listening === true
  useEffect(() => { if (listening) walkRef.current.note('mic') }, [listening])
  // The captions turned (on or off) since the city came up: a change, not the state, is the visitor's doing.
  const captionsOn = hud !== null && hud.customer.captions !== undefined
  const hasHud = hud !== null
  const captionsRef = useRef<boolean | null>(null)
  useEffect(() => {
    if (!hasHud) return
    if (captionsRef.current !== null && captionsRef.current !== captionsOn) walkRef.current.note('captions')
    captionsRef.current = captionsOn
  }, [captionsOn, hasHud])
  const typeWalk = useCallback((line: string) => termRef.current?.type(line), [])
  const runWalk = useCallback(() => termRef.current?.run(), [])
  // Sloane's quiet watch over a first visitor (onboarding/useMentor.ts), once the walk is over: its lines reach the
  // Concierge as nudges, and a prompt sent to someone in the city is reported to it from the mind below (noteRef,
  // built once with the engine).
  const { nudge, note: noteMentor } = useMentor({ active: mentored && veilDone && !walking, engine, hud, family: hud?.supplier.glyphs ?? 'keyboard', name: profile?.name ?? '', voice })
  const noteRef = useRef<(e: MentorEvent) => void>(noteMentor)
  useEffect(() => { noteRef.current = noteMentor }, [noteMentor])
  const onGoal = useCallback(() => noteRef.current('goal'), [])

  useEffect(() => { engine?.setPlayerName(profile?.name ?? '') }, [engine, profile])
  // The player's own body wears it from the start (agent PLAYER_INDEX; the engine writes the crowd's look word).
  const worn = useMemo(() => look ?? (profile ? lookFromSeed(profile.seed) : null), [look, profile])
  // A line tried on in a shop is worn over it until it is bought or the card closes.
  useEffect(() => { engine?.setLook(PLAYER_INDEX, trying?.look ?? worn) }, [engine, worn, trying])
  const wearLook = useCallback((next: Look) => { setLook(next); saveLook(next) }, [])
  // The console's `look` knob reads these (the bridge is built once, with the engine).
  const wornRef = useRef<Look | null>(null)
  const seedRef = useRef(PLAYER_INDEX)
  useEffect(() => { wornRef.current = worn; seedRef.current = profile?.seed ?? PLAYER_INDEX }, [worn, profile])
  // Whether this visit to the wardrobe has earned its check yet: a new visit (openLook, the only way the card opens)
  // starts again.
  const lookDeedRef = useRef(false)
  const openLook = useCallback(() => { lookDeedRef.current = false; setLookOpen(true); noteRef.current('wardrobe') }, [])
  const closeLook = useCallback(() => setLookOpen(false), [])
  // A shop's card: E, B or the HUD's chip inside a storefront opens it (the engine's onBrowse, the chip's tap); the
  // mirror camera turns round the body while it is open, and closing it gives the eye back and takes any try-on off.
  const openStore = useCallback((index: number) => { setLookOpen(false); setStoreOpen(index) }, [])
  const closeStore = useCallback(() => { setStoreOpen(null); setTrying(null) }, [])
  const onTry = useCallback((id: number | null, next: Look | null) => setTrying(id !== null && next ? { id, look: next } : null), [])
  useEffect(() => { engine?.setShowroom(storeOpen) }, [engine, storeOpen])
  // A home's doorstep card: E, B or the HUD's chip inside a home opens it (the engine's onHome, the chip's tap). The
  // engine holds the avatar still while it is open, and refuses it unless the avatar stands in that home on foot in a
  // city that runs: then nothing opens. The effect keeps the engine's hold on the card as it is (a close from anywhere
  // lets go); a card left open out of its home (a teleport, a new engine) is closed by the HUD's tick below.
  const openHome = useCallback((home: number) => {
    // Never under the console: the card would be hidden there while the engine held the avatar still.
    if (termOpenRef.current || engineRef.current?.setHomeCard(home) !== true) return
    setLookOpen(false); setStoreOpen(null); setTrying(null); setHomeOpen(home)
  }, [])
  const closeHome = useCallback(() => setHomeOpen(null), [])
  // The doorstep card is player 1's: in split screen only seat 0's pads press or move through it (input.ts).
  const playerOnePad = useCallback((padIndex: number) => engineRef.current?.input.playerOnePad(padIndex) ?? true, [])
  useEffect(() => { engine?.setHomeCard(homeOpen) }, [engine, homeOpen])
  // Which homes the player owns, for the HUD's chip and the minimaps: the shopkeeper's every change (a purchase here or
  // on a doorstep, a reset from the console) is told to the engine.
  useEffect(() => {
    if (!engine) return
    engine.setOwnedHomes(ownedHomes(keeper))
    return keeper.onChange(() => engine.setOwnedHomes(ownedHomes(keeper)))
  }, [engine, keeper])
  // A deed's row at the design house: Visit (Go home once owned) takes the avatar to the home's doorstep, and says why
  // when it cannot; the row says where the home stands. The store card closes by itself once the avatar is out of the shop.
  const goHome = useCallback((item: StoreItem) => {
    const e = engineRef.current
    if (e && item.kind === 'deed' && !e.goHome(item.index)) e.toast('Home', 'Walk there: a shared room replays your steps')
  }, [])
  const whereFor = useCallback((item: StoreItem) => (item.kind === 'deed' ? engine?.homeWhere(item.index) ?? null : null), [engine])
  // The card's changes, worn as the console's are. The card calls this on every swatch and every slider step, so only
  // the first change of a visit that really alters the look earns Architecture and commerce (progress.ts), retried
  // while no action is left. The console's `look` keeps wearLook and earns for itself, so the two never pay twice.
  const wearFromCard = useCallback((next: Look) => {
    const was = wornRef.current ?? lookFromSeed(seedRef.current)
    wearLook(next)
    if (!lookDeedRef.current && LOOK_SLOTS.some((slot) => next[slot] !== was[slot]) && pageProgress().earn('commerce')) lookDeedRef.current = true
  }, [wearLook])

  // A brief's immediate steps go through the terminal bridge (the same four operator knobs), never the engine.
  const applyIntent = useCallback((step: PlanStep): boolean => {
    const b = bridge
    if (!b) return false
    if (step.control === 'time' && typeof step.value === 'number') { b.setClock(step.value); return true }
    if (step.control === 'quality' && (step.value === 'auto' || typeof step.value === 'number')) { b.quality(qualityFor(step, b)); return true }
    if (step.control === 'audio' && (step.value === 'on' || step.value === 'off' || typeof step.value === 'number')) { b.audio(step.value); return true }
    return false
  }, [bridge])

  /**
   * The walk's accessible path (FirstWalk.tsx's one button per stage): Sloane does the stage's action for a visitor
   * who cannot. A turn of the head and four metres forward, as the keys would do it; a goal planned as the card plans
   * one; the visitor put down at the nearest parked car's door and the door opened; put down just inside the nearest
   * workplace's doorway; the wardrobe card opened (the visitor puts it away, which finishes the stage); the console
   * opened on `laws`; the program's first line typed into the prompt. Everything goes
   * through the same controls the console's operator tier has (engine.simControls), never past the realm.
   */
  const showWalk = useCallback(() => {
    const e = engineRef.current
    const w = walkRef.current
    if (!e || !w.stage) return
    const c = e.simControls()
    switch (w.stage) {
      case 'move': {
        e.input.yaw += 0.7
        const yaw = e.input.yaw
        // Walks where the visitor now looks (on foot, forward is (-sin yaw, -cos yaw): controls.ts readControls) until
        // the stage is passed or the avatar is a metre past its three metres, asking again every quarter second: a
        // scripted walk is held for wall-clock time, and on a slow frame (a software GPU) the realm's clamped steps
        // fall far behind the clock, so one hold covers less ground than it says. A minute is the most it tries.
        const vx = -Math.sin(yaw) * 1.4, vz = -Math.cos(yaw) * 1.4
        const from = c.avatar.position()
        const until = performance.now() + SHOW_WALK_MS
        c.avatar.walk(vx, vz, MAX_WALK_MS)
        const id = window.setInterval(() => {
          if (engineRef.current !== e) { window.clearInterval(id); return }
          const at = c.avatar.position()
          const far = Math.hypot(at.x - from.x, at.z - from.z) >= WALK.walkMetres + 1
          if (walkRef.current.stage === 'move' && !far && performance.now() < until) { c.avatar.walk(vx, vz, MAX_WALK_MS); return }
          window.clearInterval(id)
          c.avatar.walk(0, 0, 0)
        }, 250)
        return
      }
      case 'voice': {
        const plan = bridge?.goal?.('make it night')
        if (!plan) return
        e.toast('Sloane', `${plan.root}: ${plan.steps.map((st) => `${st.label} (${st.state})`).join(', ')}`)
        w.note('goal')
        return
      }
      case 'fleet': {
        const at = c.avatar.position()
        let pick = -1, best = Number.POSITIVE_INFINITY
        for (let i = 0; i < c.vehicles.count(); i++) {
          const v = c.vehicles.state(i)
          if (v.mode === 'player') continue
          // A parked car first, the nearest moving one only when none is parked.
          const d = Math.hypot(v.x - at.x, v.z - at.z) + (v.mode === 'parked' ? 0 : 1e6)
          if (d < best) { best = d; pick = i }
        }
        if (pick < 0) return
        const v = c.vehicles.state(pick)
        // Beside the car (its forward is (sin h, cos h); this is the side at its left), facing it (head.ts yawFacing turns
        // the heading towards the car into the yaw that looks that way); the door is the realm's to open.
        const px = v.x + Math.cos(v.heading) * 2.2, pz = v.z - Math.sin(v.heading) * 2.2
        c.avatar.teleport(px, pz, yawFacing(Math.atan2(v.x - px, v.z - pz)))
        window.setTimeout(() => { if (engineRef.current === e) e.interact() }, 400)
        return
      }
      case 'work': {
        const at = c.avatar.position()
        let room = null, near = Number.POSITIVE_INFINITY
        for (const r of e.workplaces()) {
          const d = Math.hypot(r.door.x - at.x, r.door.z - at.z)
          if (d < near) { near = d; room = r }
        }
        if (!room) return
        // The hub: the point just inside the doorway every route through the room passes, facing the room.
        const p = toWorld(room, ROOM.hub, 0)
        c.avatar.teleport(p.x, p.z, yawFacing(Math.atan2(room.cx - p.x, room.cz - p.z)))
        return
      }
      case 'style': openLook(); return
      case 'ring0': termRef.current?.run('laws'); return
      case 'exam': termRef.current?.type(`noir ${PROGRAM[0]}`); return
    }
  }, [bridge, openLook])

  // The console suspends game input (and releases pointer lock) while it owns the keyboard; the wardrobe card likewise
  // while it is open (the console opening puts the card away). The walk hears of the console opening, and of the
  // wardrobe card put away after it was open (Done, the close button, Escape or the console taking over).
  const onTermOpen = useCallback((open: boolean) => {
    termOpenRef.current = open
    setTermOpen(open)
    if (open) { setLookOpen(false); setStoreOpen(null); setTrying(null); setHomeOpen(null); walkRef.current.note('console') }
    engineRef.current?.input.suspend(open || lookOpenRef.current || storeOpenRef.current !== null || homeOpenRef.current !== null)
  }, [])
  // The walk's look stage hears of the wardrobe card, a shop's card or a home's doorstep card put away after it was open
  // (Done, ×, Escape, the console taking over, or walking out of the shop or the home): what changed or was bought, if
  // anything, is the visitor's choice.
  const lookWas = useRef(false)
  const storeWas = useRef(false)
  const homeWas = useRef(false)
  useEffect(() => {
    lookOpenRef.current = lookOpen
    storeOpenRef.current = storeOpen
    homeOpenRef.current = homeOpen
    engineRef.current?.input.suspend(lookOpen || storeOpen !== null || homeOpen !== null || termOpenRef.current)
    if (lookWas.current && !lookOpen) walkRef.current.note('wardrobe')
    lookWas.current = lookOpen
    if (storeWas.current && storeOpen === null) walkRef.current.note('store')
    storeWas.current = storeOpen !== null
    if (homeWas.current && homeOpen === null) walkRef.current.note('home')
    homeWas.current = homeOpen !== null
  }, [lookOpen, storeOpen, homeOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyH' && !e.repeat && !termOpenRef.current && !isEditableTarget(e.target)) setHudVisible((v) => !v)
    }
    // Browsers only start audio from a user gesture; every gesture is a chance to (re)unlock it (every player's soundscape).
    const unlock = () => engineRef.current?.unlockAudio()
    // The microphone's own context, opened at boot without a gesture (a kept switch), wakes on the first one too.
    const wake = () => mic.resume()
    window.addEventListener('keydown', onKey)
    for (const type of ['pointerdown', 'keydown', 'touchend', 'click'] as const) {
      window.addEventListener(type, unlock, { capture: true })
      window.addEventListener(type, wake, { capture: true })
    }
    return () => {
      window.removeEventListener('keydown', onKey)
      for (const type of ['pointerdown', 'keydown', 'touchend', 'click'] as const) {
        window.removeEventListener(type, unlock, { capture: true })
        window.removeEventListener(type, wake, { capture: true })
      }
    }
  }, [mic])

  // What the city was booted with, pinned at mount: App renders again whenever an accessibility setting or the system's
  // contrast switch changes, and hands down a fresh plan object each time, which must not tear the city down and build
  // it again (a remap or a reboot reloads the page, so nothing is lost by reading these once).
  const [boot] = useState(() => ({ options, plan }))
  useEffect(() => {
    const canvas = canvasRef.current
    const { options, plan } = boot
    if (!canvas) return
    let engine: Engine | null = null
    let recruiter: Recruiter | null = null
    let router: TaskRouter | null = null
    /** Stops following the recruiter: its events into the swarm's memory, its list into the roster's hires. */
    let unfollow: (() => void) | null = null
    /** Unties the microphone from the recogniser and Sloane's ear (set once the engine is up). */
    let unlisten: (() => void) | null = null
    /** Stops the page's keeper cueing this city's checks (its one listener), and the recruiter's events earning. */
    let uncheck: (() => void) | null = null
    let unearn: (() => void) | null = null
    /** The last success worth a cue (progress.ts cueOf), set by that listener and read by the loop for the HUD's chip:
     *  a plain variable, so a check earned inside a frame or a worker message touches no React state. */
    let cue: ProgressCue | null = null
    /** The answer streaming in from the local model, for the HUD (null when none is). */
    let answering: { thinking: number; tail: string } | null = null
    /** The city router's model kept in this page (inPage.ts), shut down with the city; null until the engine is up. */
    let inPageMind: InPageMind | null = null
    /** What the model in this page is doing, for the HUD's activity line: its own phase (loading, reading the prompt)
     *  and a model file being kept (its copy's progress); null when neither is. */
    let modelPhase: string | null = null
    let keepLine: string | null = null
    /** Takes back what the model's wiring added to the page (the picker, the drop, the page's lifecycle). */
    let unModel = noop
    let raf = 0
    let cancelled = false
    let lastHud = 0
    /** Whether the HUD has had its first snapshot (the veil lifts on it), and how many frames in a row have thrown. */
    let shown = false
    let throws = 0
    /** Stops watching for the page's return after a graphics reset in the background (reloadWhenVisible). */
    let unwatch = noop

    // The single requestAnimationFrame loop: the engine advances one synchronized step per tick and
    // React only sees a snapshot every HUD_INTERVAL_MS, so the HUD never re-renders at frame rate. A frame that throws
    // never ends the loop silently: before the first snapshot it is the boot's failure (the card); after it, the loop
    // carries on, and FRAME_FAULTS throws in a row halt the city as a frame-loop fault (the card again).
    const loop = (now: number) => {
      if (!engine || engine.halted) return
      try {
        engine.frame(now)
        if (now - lastHud > HUD_INTERVAL_MS) {
          lastHud = now
          const s = engine.snapshot()
          // The operator's progression chip: the keeper's own cache builds its strings only when what it shows changed
          // (a check, a purchase, the round's refill, the cue going stale), so this costs a few comparisons a tick.
          s.supplier.progress = hudProgress(pageProgress(), cue, now)
          // The screen reader's line (announcer.ts): the district, a vehicle beside you, a seat taken or left, a toast.
          if (accessRef.current.announce) { const said = announcer.next(s, now); if (said) s.customer.announce = said }
          // The microphone's pill: its phase, Sloane speaking over it, which detector, and whether words are recognised.
          s.supplier.voice = { phase: mic.phase, detail: mic.state.detail, speaking: speaker.speaking, path: mic.path, words: recruiter !== null && recruiter.mic.state === 'listening' }
          if (recruiter) s.supplier.recruiting = hudLine(recruiter, router?.running ?? 0, activityText(answering, engine.speaking, modelPhase ?? keepLine))
          // A city action waiting for the operator's OK takes the activity line (the MIC chip reads it, console open or closed).
          if (recruiter && actRef.current) s.supplier.recruiting = hudLine(recruiter, router?.running ?? 0, `Waiting for your OK: ${actRef.current.who} proposes: ${actRef.current.sentence}`)
          setHud(s)
          // Out of the open shop (a teleport, the console's own moves) or into a headset (the card is not drawn there, and
          // the game's input must not stay suspended): its card goes.
          if (storeOpenRef.current !== null && ((s.customer.shop?.index ?? -1) !== storeOpenRef.current || s.supplier.xr.state === 'vr' || s.supplier.xr.state === 'ar')) closeStore()
          // Out of the home whose card is open, or into a headset, the doorstep card goes the same way.
          if (homeOpenRef.current !== null && ((s.customer.home?.index ?? -1) !== homeOpenRef.current || s.supplier.xr.state === 'vr' || s.supplier.xr.state === 'ar')) closeHome()
          shown = true
        }
        throws = 0
      } catch (err) {
        // A frame that halted the city itself (a Ring-0 panic throws out of the frame) keeps that halt's own screen.
        if (engine.halted) return
        console.error(err)
        const why = `${FRAME_FAULT} ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`
        if (!shown) {
          setError({ cause: err })
          engine.halt(why)
          return
        }
        if (++throws >= FRAME_FAULTS) {
          engine.halt(why)
          return
        }
      }
      raf = requestAnimationFrame(loop)
    }
    const onResize = () => engine?.resize()

    const onStage = (st: keyof typeof BOOT_STAGE) => { if (!cancelled) setStage(BOOT_STAGE[st]) }
    loadMap(plan).then((region) => Engine.create(canvas, { ...options, region }, onStage)).then(
      (e) => {
        if (cancelled) {
          e.dispose()
          return
        }
        onStage('crowd')
        engine = e
        engineRef.current = e
        // Recruitment: voice (on-device) and the console, over the engine's narrow host. A halt closes the microphone.
        const r = new Recruiter(e.recruitHost())
        recruiter = r
        // The capability gateway over the recruiter's copy of the swarm: every operator script and prompt runs through
        // it, and a task a broken tether stops also toasts, so it shows with the console closed.
        const tasks = new TaskRouter(r)
        router = tasks
        const gate: SkillGate = {
          submit<T>(requires: readonly string[], task: (lease: GateLease) => T | PromiseLike<T>): GateHandle<T> {
            const h = tasks.submit(requires, task)
            void h.verdict.then((v) => { if (v.state === 'Aborted') e.toast('Task aborted', `Spatial tether lost: ${v.message}`) })
            return h
          },
        }
        // The cognition router (only ever asked on the operator's command): the Claude API through a gateway on this
        // machine, a model server on this machine, or the model file kept in this page, swapped at the console. Its
        // fetch is the page's own (already held to this machine by the air gap main.tsx installed) under the gate's own
        // wrapper once more. Its answer's pieces are shown on the HUD only after the lease let them through.
        // The model kept in this page (09_Cognition/inPage.ts) is this router's one in-page mind, over the page's one
        // runtime and store: it plans by the engine's profile of this device, holds the city's tier down while it loads
        // or answers (inPagePlan.ts holdTier), and says what it is doing on the HUD's activity line. The onboarding's
        // router has none: a model is never loaded while the city is still being built.
        const device = (): Omit<PlanEnv, 'gpuMode' | 'gpuFailed'> => ({
          mobile: e.profile.mobile, lite: e.profile.lite, gpuClass: e.profile.gpuClass,
          cores: navigator.hardwareConcurrency || 4, memoryGb: deviceMemory(), isolated: canShareMemory(), f16: e.gpuF16,
        })
        let inPage!: InPageMind
        // The Windows app's reading of the GPUs' memory (src-tauri/src/gpu.rs), asked once as this router is built and
        // judged by modelFit.ts figureFromAdapters (the launcher's sum, DXGI's own floor); until it answers, and in a
        // browser, none.
        let appVram: number | null = null
        void shellGpuMemory().then((bytes) => { appVram = figureFromAdapters(bytes) })
        const local = createMindRouter({
          fetch: pageFetch,
          store: pageStore(COGNITION_KEY),
          inPage: (store) => (inPage = createInPageMind({
            runtime: () => PAGE_RUNTIME(),
            store: PAGE_MODELS(),
            kept: store,
            env: device,
            busy: (on, place) => e.holdQuality(on && place ? holdTier(device(), place.gpu) : null),
            onPhase: (text) => { modelPhase = text },
          })),
          // The address's GPU figure (?vram=): auto may give Ollama a bigger model it already has, by what Ollama measured.
          vram: options.vram,
          // The Windows app's figure, below the address's and the console's.
          appVram: () => appVram,
        })
        inPageMind = inPage
        const mind: Mind = {
          ...local,
          answer: (req, onPiece) => {
            const live = { thinking: 0, tail: '' }
            answering = live
            noteRef.current('talk')
            return local.answer(req, (p) => {
              onPiece(p)
              if (p.kind === 'text') live.tail = (live.tail + p.text).slice(-ANSWER_TAIL)
              else live.thinking++
            }).finally(() => { if (answering === live) answering = null })
          },
        }
        // The swarm's memory for this city (this world seed): in the page's IndexedDB on this machine (for this visit
        // only if the browser refuses it), fed by the recruiter's arrivals and releases and by the operator tier's
        // tasks (its diary). Nothing in it reaches the physics worker.
        const memory = new SwarmMemory(deferredLedger((async () => indexedDbLedger(window.indexedDB))()), options.seed)
        const unfollowMemory = followRecruiter(memory, r)
        // A hire on the roster lasts while that person stays with the operator: one the recruiter's list no longer has
        // (they left, or were dismissed) is let go and dressed as the city dresses them. Every hire ends with the city.
        const unmirror = r.onMirror((list) => { for (const agent of roster.keepOnly(list.map((v) => v.agent))) e.setLook(agent, null) })
        unfollow = () => { unfollowMemory(); unmirror(); roster.keepOnly([]) }
        // The local speech server (only ever asked on the operator's command, only on this machine): the audio it
        // returns is placed by the engine's soundscape at the speaker's head.
        const voice = createLocalSpeech({ fetch: pageFetch, store: pageStore(SPEECH_KEY) })
        // Sloane's voice now reads the city's sound and can speak through the operator's provider at the player's head.
        // Only a running soundscape is sound on: not off, not suspended in a hidden tab, not locked before a gesture.
        link.sound = () => e.audio.status().state === 'running'
        link.source = { voice, out: e.conciergeOut() }
        // A hired agent's own provider voice (a profile name is the browser tier's, not a provider voice).
        const voiceOf = (agent: number): string | null => {
          const v = roster.byAgent(agent)?.voice ?? null
          return v !== null && voiceProfile(v) === null ? v : null
        }
        // A walk ping (go or gather) at a sidewalk point near the operator asks an Active recruit over to it: the engine
        // plans it from its own copies (08_Swarm/ping.ts rallyPlan), the recruiter checks the page's copy, the physics
        // realm decides on its own readings; its answer is a toast either way.
        e.onRally = (req) => { void r.rally(req.agent, req.x, req.z).then((o) => e.toast('Rally', o.message)) }
        // The microphone's presses (V, the right stick's click, the Menu's item) arrive through the engine as one action.
        e.onMute = onMic
        // The on-device recogniser (recruitment.ts) runs while the microphone is open, where the browser promises one
        // (Firefox has none: the pill shows the level and speech only), and its microphone is never open without the
        // pill: `recruit listen` opens the pill's microphone too, and a mute stops the recogniser. What it hears that
        // is not a recruitment request goes to Sloane (Concierge.tsx heard; heard.ts decides what of it is a goal).
        const words = (): boolean => { const R = speechEnv().Recognition; return R !== null && 'processLocally' in R.prototype }
        let micWasOpen = false
        const onMicChange = () => {
          const open = mic.open
          const st = r.mic.state
          const live = st === 'listening' || st === 'starting'
          // Settled closed (off, muted, blocked, failed) rather than still opening: the recogniser stops whatever the
          // edge, so a mute pressed while the pill read Opening never leaves it listening behind a Muted pill.
          if (!open && mic.phase !== 'opening') { micWasOpen = false; if (live) r.stop(); return }
          if (open === micWasOpen) return
          micWasOpen = open
          if (open && !live && words()) void r.listen()
        }
        mic.addEventListener('change', onMicChange)
        const onRecruiterMic = (ev: Event) => {
          if ((ev as CustomEvent<{ state: string }>).detail.state === 'listening' && !mic.open && mic.phase !== 'opening') void mic.listen()
        }
        r.addEventListener('mic', onRecruiterMic)
        let heardId = 0
        // Sloane's own line coming back through the speakers is not the visitor's: nothing heard while she speaks, or
        // within heard.ts HEARD_QUIET_MS of her last line, reaches her.
        let quietAt = Number.NEGATIVE_INFINITY
        // A line the visitor cut (a barge-in: the detector hears speech as she stops) leaves no quiet tail: what follows
        // is theirs, the words they cut her off to say.
        const unquiet = speaker.onSpeaking((on) => { if (!on && !mic.speech) quietAt = performance.now() })
        const onHeard = (ev: Event) => {
          const t = (ev as CustomEvent<{ transcript: string }>).detail.transcript
          if (!heardNow(speaker.speaking, performance.now(), quietAt)) return
          if (parseRequest(t) === null) setHeard({ id: ++heardId, text: t })
        }
        r.addEventListener('heard', onHeard)
        unlisten = () => {
          mic.removeEventListener('change', onMicChange)
          r.removeEventListener('mic', onRecruiterMic)
          r.removeEventListener('heard', onHeard)
          unquiet()
        }
        // The microphone opens as the city starts: on a first visit (the one line), or as the visitor left it (on, not muted).
        if (mic.opensAtBoot()) void mic.listen()
        // The operator's progression (progress.ts, the page's one keeper). The city's own deeds earn into it: the engine
        // says which (a boarding, the clock, ghost and rain keys), someone recruited arriving, a spoken request understood.
        // One listener cues every success, the console's and the city's alike: the chime and the tap (checkCue) at once,
        // and the HUD's chip from the loop. A reroll that climbs to a success is cued as any success is; one that stayed
        // a success paid nothing and is not cued again (worthCue).
        e.onDeed = (skill) => { pageProgress().earn(skill) }
        uncheck = pageProgress().subscribe((c) => {
          if (worthCue(c)) {
            cue = cueOf(c, performance.now())
            e.checkCue(c.degree, SKILL_TITLE[c.skill])
          }
        })
        unearn = earnFromRecruiter(pageProgress(), r)
        // The opt-in network client (10_Network/netClient.ts): built over the page's own socket constructor, never
        // connected at boot, handed to the engine through its NetHost seam (the engine draws the room's poses as
        // ghosts and feeds the client player 1's input) and to the console through the bridge. The room's chat and
        // pings reach the engine's captions only after the core's 14A screen is applied once more here: the host is
        // not trusted either.
        const net = createNetClient({
          onChat: (m) => {
            const name = admissibleName(m.name), text = admissibleChat(m.text)
            if (name !== null && text !== null) e.netChat(m.from, name, text)
          },
          onPing: (m) => e.netPing(m.from, m.kind, m.x, m.y, m.z),
        })
        e.setNet(net)
        e.onHalt = (reason) => {
          // A graphics reset takes the model in this page off the GPU for good (inPage.ts noteGpuReset), before it is
          // shut down with the rest of the city.
          if (haltClass(reason) === 'gpu-reset') inPage.noteGpuReset()
          void inPage.dispose()
          unfollow?.()
          uncheck?.()
          unearn?.()
          unlisten?.()
          tasks.dispose()
          r.dispose()
          mic.close()
          setLocked(reason)
          // A graphics reset in the background restarts once the player is back (once per two minutes at most).
          if (haltClass(reason) === 'gpu-reset') unwatch = reloadWhenVisible(document.hidden)
        }
        // The model file kept in this page, picked or dropped: kept (copied into the page's storage, its progress on
        // the HUD's activity line), then chosen, with the inpage provider answering from now on; a desktop loads it at
        // once so the first ask does not wait, a phone only when asked. One file is copied at a time; files kept earlier
        // stay kept until forgotten. Where this page cannot run the model, inPage.keep refuses before anything is copied
        // or chosen, so the provider is left as it was.
        let keeping = false
        let hinted = false
        const keepPicked = async (files: readonly File[]): Promise<string> => {
          if (keeping) throw new Error('a model file is being kept in this page already: wait for it to finish')
          keeping = true
          keepLine = 'keeping the model file in this page'
          let kept: KeptModel
          try {
            kept = await inPage.keep(files, (done, total) => {
              keepLine = `keeping the model file in this page ${total > 0 ? Math.min(100, Math.max(0, Math.floor((done / total) * 100))) : 0}%`
            })
          } finally {
            keeping = false
            keepLine = null
          }
          local.setProvider('inpage')
          local.setModel(kept.name)
          // A served page that is not cross-origin isolated but has the service worker gets isolation (the worker adds
          // the headers) by reloading once, and with it more than one thread for the model: said once a visit.
          if (!hinted && /^https?:$/.test(window.location.protocol) && window.crossOriginIsolated !== true && navigator.serviceWorker?.controller) {
            hinted = true
            e.toast(MODEL_FILE, 'reload once to let the model use more than one thread')
          }
          const warm = !e.profile.mobile && !e.profile.lite
          if (warm) void inPage.load().then((line) => e.toast(MODEL_FILE, line), (err: unknown) => e.toast(MODEL_FILE, plain(err)))
          return `${kept.name} is kept in this page (${sizeText(kept.bytes)}${kept.durable ? '' : ', for this visit only'}): the inpage provider answers with it now${warm ? ', and it is loading' : ''}`
        }
        /** A pick from the Menu or a drop: what was kept, or why not, as a toast (the console prints its own). */
        const keepAndSay = (chosen: Promise<File[] | null>): void => {
          void chosen.then((files) => (files ? keepPicked(files) : null)).then((line) => { if (line) e.toast(MODEL_FILE, line) }, (err: unknown) => e.toast(MODEL_FILE, plain(err)))
        }
        const input = fileRef.current
        const picker = input ? filePicker(input, (files) => keepAndSay(Promise.resolve(files))) : null
        // The picker opens at once, inside the tap or the Enter keydown that asked: nothing is awaited before it. Where
        // this page cannot run the model it does not open at all, and the reason is the answer (inPage.keep refuses too).
        const pickFiles = (): Promise<File[] | null> => {
          const cannot = PAGE_MODEL_REFUSAL()
          if (cannot !== null) return Promise.reject(new Error(cannot))
          return picker ? picker.open() : Promise.reject(new Error('this page has no file picker'))
        }
        modelFileRef.current = () => keepAndSay(pickFiles())
        // A .gguf (or every part of a split one) dropped on the city is kept as a pick is, on a desktop (a phone has
        // nothing to drag). Any file dropped is the page's, so the browser never leaves the city to open it.
        const main = mainRef.current
        const onDragOver = (ev: DragEvent): void => {
          if (!ev.dataTransfer?.types.includes('Files')) return
          ev.preventDefault()
          ev.dataTransfer.dropEffect = 'copy'
        }
        const onDrop = (ev: DragEvent): void => {
          const files = Array.from(ev.dataTransfer?.files ?? [])
          if (!files.length) return
          ev.preventDefault()
          const models = files.filter((f) => /\.gguf$/i.test(f.name))
          if (models.length) keepAndSay(Promise.resolve(models))
          else e.toast(MODEL_FILE, 'only a .gguf model file (or every part of a split one) can be dropped on the city')
        }
        if (main && !e.profile.mobile) {
          main.addEventListener('dragover', onDragOver)
          main.addEventListener('drop', onDrop)
        }
        // The page in the background: a phone unloads the model after a minute there (inPage.ts background); the page
        // back in view keeps it. A page that unloads (a reload, a closed tab, the city's own restart) did not die in a
        // load it was running, so it takes that load's crash mark with it (inPage.ts leave): only a page the system
        // kills, which runs no pagehide, leaves one.
        const onVisibility = (): void => { if (document.hidden) inPage.background(); else inPage.foreground() }
        const onPageHide = (): void => { inPage.leave(); inPage.background() }
        document.addEventListener('visibilitychange', onVisibility)
        window.addEventListener('pagehide', onPageHide)
        unModel = () => {
          modelFileRef.current = null
          picker?.dispose()
          main?.removeEventListener('dragover', onDragOver)
          main?.removeEventListener('drop', onDrop)
          document.removeEventListener('visibilitychange', onVisibility)
          window.removeEventListener('pagehide', onPageHide)
        }
        // The console's `ask file` and `ask gpu` (terminal/bridge.ts ModelBridge).
        const modelBridge: ModelBridge = Object.freeze({
          pick: () => pickFiles().then((files) => (files ? keepPicked(files) : 'no model file was chosen')),
          forget: (name?: string) => inPage.forget(name),
          load: () => inPage.load(),
          unload: () => inPage.unload(),
          gpu: (mode: GpuMode) => gpuLine(inPage.setGpu(mode)),
          log: () => inPage.log(),
        })
        if (termOpenRef.current || lookOpenRef.current || storeOpenRef.current !== null || homeOpenRef.current !== null) e.input.suspend(true)
        // E, B or the HUD's chip inside a storefront opens its card (the chip calls openStore itself), and inside a home
        // its doorstep card (the chip calls openHome itself).
        e.onBrowse = openStore
        e.onHome = openHome
        setEngine(e)
        const engineBridge = e.terminalBridge(gate, mind, voice, memory.diary(), voiceOf, pageStore(ELITE_KEY))
        setBridge(Object.freeze({
          ...engineBridge,
          // The map this shell walks, for the console's `map` status line (the choice itself is remap's).
          brand: Object.freeze({ ...engineBridge.brand, map: plan.choice }),
          recruit: recruitBridge(r),
          agent: agentBridge(roster, { recruit: (skill) => recruitBridge(r).ask(skill), wear: (agent, look) => e.setLook(agent, look), skills: () => SKILLS }),
          concierge: conciergeBridge(speaker),
          mic: Object.freeze({
            status: () => voiceStatus(mic, speaker.speaking, words()
              ? r.mic.state === 'listening' ? 'on-device recognition listening (recruitment.ts): a skill asked for, or "Sloane, ..." for a goal' : 'on-device recognition available: it listens while the microphone is open'
              : 'on-device recognition: none in this browser; the pill shows the level and speech only (recruit <skill> types a request)'),
            on: (on: boolean) => (on ? mic.listen().then((st) => `${st.phase}${st.detail ? ` · ${st.detail}` : ''}`) : (mic.mute(), 'muted: the device is released')),
          }),
          access: accessBridge(() => accessRef.current, () => prefersRef.current, onAccess, () => engineRef.current?.visionBlocked() ?? null),
          goal: (text: string) => goalPlan(text, engineBridge),
          // The operator's level, credits and skills (progress.ts): the page's one keeper, which the console earns into.
          progress: progressBridge(pageProgress()),
          memory: memoryBridge(memory, r),
          net: netBridge(e.net, pageStore(NET_TOKEN_KEY)),
          model: modelBridge,
          // The first walk's exam, behind NoirScript's verify_ring0 / spawn_subagents / unlock_city: it reads the
          // kernel (the laws, the host's vouch for the air gap, the audit standing), asks people over through the
          // recruiter's own lane, and tells the walk; it has no write surface of its own.
          exam: createExam({
            contained: () => airgapInstalled(globalThis),
            standing: () => lockedRef.current === null,
            laws: () => engineBridge.laws(),
            checks: () => GATE_CHECK_NAMES,
            ask: (skill) => r.tryAsk(skill),
            nonce: crypto.getRandomValues(new Uint32Array(1))[0] ?? 1,
            stage: () => walkRef.current.stage,
            on: () => walk,
            note: (ev) => walkRef.current.note(ev),
          }),
          // The player's look: App's state is the one source (the wardrobe card and the console share it).
          look: lookBridge({
            worn: () => wornRef.current ?? lookFromSeed(seedRef.current),
            seed: () => seedRef.current,
            wear: wearLook,
            lookOf: (agent) => e.lookOf(agent),
            agents: e.recruitHost().agents,
          }),
        }))
        // The fallback without a microphone, in the browser's console: recruit("Rust").
        Object.assign(window, { recruit: (skill: string) => r.recruit(skill) })
        setAdapter(e.adapter)
        window.addEventListener('resize', onResize)
        if (options.debug) {
          Object.assign(window, {
            __SIM__: {
              snapshot: () => e.snapshot(),
              errors: () => e.errors,
              setHour: (h: number) => e.debugSetHour(h),
              teleport: (x: number, z: number, yaw = 0) => e.debugTeleport(x, z, yaw),
              interact: () => e.interact(),
              hold: (code: string, on: boolean) => e.input.hold(code, on),
              look: (yaw: number, pitch: number) => { e.input.yaw = yaw; e.input.pitch = pitch },
              // A ping where the head looks (the Q key's path), as plain data: what it met and where.
              ping: (kind: 'go' | 'look' | 'gather' | 'wait' = 'go') => e.pingAt(kind),
              // The wardrobe (03_Spawn_Agents/look.ts): dress an agent (0 is the player) in a look, or null for the hash's.
              wear: (agent: number, look: Look | null) => e.setLook(agent, look),
              lookOf: (agent = PLAYER_INDEX) => e.lookOf(agent),
              // The storefronts: where they stand, the E key's own path into a shop's card, and the one shopkeeper.
              shops: () => e.shops.map((s, index) => ({ index, kind: s.kind, name: s.name, door: s.door, fitting: s.fitting })),
              browse: () => e.browse(),
              shopkeeper: keeper,
              // The homes: where they stand (the arrival is Go home's spot on the sidewalk), and the E key's own path into a
              // home's doorstep card.
              homes: () => e.homes.map((h) => ({ home: h.home, kind: h.kind, name: h.name, address: h.address, side: h.side, door: h.door, arrival: h.arrival })),
              openHome: () => e.openHome(),
              // The network session (10_Network): join a room, leave it, or read it as plain data.
              net: e.net,
              // Headless browsers cannot take pointer lock; this hides the capture hint for screenshots.
              pretendLocked: () => { e.input.locked = true },
              // The first walk (09_Cognition/firstWalk.ts): the stage on the card (null when off or passed), and a report into it.
              walk: () => walkRef.current.stage,
              walkNote: (ev: WalkEvent) => walkRef.current.note(ev),
              // The physics realm as the harness sees it: the mirrored state, the command queue (dbg* accepted), the next state.
              sim: e.debugSim(),
              engine: e,
            },
          })
        }
        raf = requestAnimationFrame(loop)
      },
      (err: unknown) => {
        setError({ cause: err })
        // The phone took the GPU back while the city loaded in the background: restart once the player is back.
        if (!cancelled && err instanceof WebGPUUnavailableError && err.code === 'gpu-reset' && err.background) unwatch = reloadWhenVisible(true)
      },
    )
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      unwatch()
      window.removeEventListener('resize', onResize)
      engineRef.current = null
      unlisten?.()
      mic.close()
      speaker.stop()
      link.source = null
      link.sound = () => true
      setEngine(null)
      setBridge(null)
      unfollow?.()
      uncheck?.()
      unearn?.()
      router?.dispose()
      recruiter?.dispose()
      unModel()
      void inPageMind?.dispose()
      if ((window as { recruit?: unknown }).recruit) delete (window as { recruit?: unknown }).recruit
      engine?.dispose()
    }
  }, [boot, wearLook, link, roster, speaker, walk, keeper, openStore, closeStore, openHome, closeHome, mic, onMic, onAccess, announcer])

  // The open home's name and street address as the engine knows them (the city's grid, or a region's own streets).
  const opened = homeOpen !== null ? engine?.homes.find((h) => h.home === homeOpen) : undefined
  const homeInfo = opened ? { name: opened.name, address: opened.address } : undefined

  // The boot's failure first; else a halt that is not an audit. Words for this device (bootFailure.ts).
  const env = useMemo(() => pageEnv(), [])
  const failure = error !== null ? classify(error.cause, env) : locked !== null && haltClass(locked) !== 'audit' ? explainHalt(locked, env) : null

  return (
    <main ref={mainRef} className="relative h-full w-full overflow-hidden bg-slate-900">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      {/* The picker's file input: no accept (a phone greys out a .gguf it has no type for), and hidden by its size
          and opacity, never by display, so every browser still opens it from a click. */}
      <input ref={fileRef} type="file" multiple tabIndex={-1} aria-hidden="true" className="pointer-events-none absolute left-0 top-0 h-px w-px opacity-0" />
      <Hud s={hud} adapter={adapter} visible={hudVisible} terminalOpen={termOpen} mapLayer={engine?.mapLayer ?? null} highContrast={high} captionPx={CAPTION_PX[access.captions]} mic={mic} onMic={onMic} onBrowse={openStore} homes={engine?.homes ?? null} onHome={openHome} />
      {/* No touch controls under a home's doorstep card: the avatar is held still there, and the card takes the taps. */}
      {engine && hud && !termOpen && homeOpen === null && (
        <TouchControls
          input={engine.input}
          driving={hud.input.mode === 'vehicle'}
          nearVehicle={hud.input.nearVehicle}
          menu={{
            onConsole: () => termRef.current?.open(),
            // No Model file where this page cannot run the model (PAGE_MODEL_REFUSAL).
            onModelFile: PAGE_MODEL_REFUSAL() === null ? onModelFile : undefined,
            onHud: () => setHudVisible((v) => !v),
            hudVisible,
            ghost: hud.output.ghost === true,
            rain: hud.output.matrix === true,
            // The headset item only where a session can be asked for; the tap itself is the user activation.
            onHeadset: hud.supplier.xr.state === 'unsupported' ? undefined : () => engine.toggleXr(),
            headset: hud.supplier.xr.state === 'vr' || hud.supplier.xr.state === 'ar',
            mic: hud.supplier.voice ? micIsOpen(hud.supplier.voice.phase) : false,
            // Accessibility (access.ts): the two settings most wanted on a phone; the rest is the console's `access`.
            contrast: high,
            onContrast: () => onAccess(toggleContrast(access, prefersMore)),
            textScale: access.scale,
            onTextScale: () => onAccess(cycleScale(access)),
          }}
        />
      )}
      {/* Never over a halted city: the way-out card (RecoveryCard.tsx) holds focus on Restart, and Sloane's name field,
          shown as the veil finishes fading, would take it (a halt in the veil's last second, as the browser smoke's
          thrown frame is). The look card and the action card step aside the same way below. */}
      {hud && (
        <Concierge
          visible={veilDone && hudVisible && !termOpen && !lookOpen && storeOpen === null && homeOpen === null && locked === null}
          profile={profile}
          onProfile={setProfile}
          family={hud.supplier.glyphs}
          overlay={hud.supplier.touch}
          driving={hud.input.mode === 'vehicle'}
          dark={hud.customer.daylight < 0.35}
          onIntent={applyIntent}
          onLook={openLook}
          nudge={nudge}
          onGoal={onGoal}
          onGoalSent={onGoalSent}
          onSay={onSay}
          heard={heard}
          beside={walking && fw.card !== null}
          zoom={access.scale / 100}
          onOpen={setSloaneOpen}
        />
      )}
      {/* The first walk's card (onboarding/FirstWalk.tsx): over the HUD, under the console; away while the wardrobe, a
          shop's card or a home's doorstep card is open or the city is halted, and in a wide window under 60 rem across while Sloane's card is open
          (from 60 rem her card stands left of it). It has no close: the console's exit program ends it. */}
      {hud && walking && fw.card && (
        <FirstWalkCard
          visible={veilDone && !lookOpen && storeOpen === null && homeOpen === null && locked === null}
          card={fw.card}
          beat={fw.beat}
          exam={fw.exam}
          overlay={hud.supplier.touch}
          termOpen={termOpen}
          onShow={showWalk}
          onType={typeWalk}
          onRun={runWalk}
          onSay={onSay}
          crowded={sloaneOpen}
          zoom={access.scale / 100}
        />
      )}
      {hud && (
        <Customizer
          visible={lookOpen && veilDone && !termOpen && locked === null}
          look={worn}
          seed={profile?.seed ?? 0}
          onChange={wearFromCard}
          onClose={closeLook}
          dark={hud.customer.daylight < 0.35}
          agents={agents}
          roster={roster}
          onAgentLook={wearAgentLook}
          onHear={onHear}
        />
      )}
      {hud && (
        <StoreCard
          visible={storeOpen !== null && veilDone && !termOpen && locked === null}
          shop={storeOpen !== null ? engine?.shops[storeOpen] ?? null : null}
          keeper={keeper}
          look={worn ?? lookFromSeed(PLAYER_INDEX)}
          trying={trying?.id ?? null}
          mirror={hud.customer.shop?.showroom === true}
          onTry={onTry}
          onWear={wearLook}
          onGo={goHome}
          whereFor={whereFor}
          onClose={closeStore}
          dark={hud.customer.daylight < 0.35}
        />
      )}
      {hud && (
        <HomeCard
          visible={homeOpen !== null && veilDone && !termOpen && locked === null}
          home={homeOpen}
          keeper={keeper}
          homeInfo={homeInfo}
          pad={act === null || !bridge}
          padFrom={playerOnePad}
          onClose={closeHome}
          dark={hud.customer.daylight < 0.35}
        />
      )}
      <Terminal ref={termRef} bridge={bridge} onOpenChange={onTermOpen} onBoot={reboot} onMap={remap} onLine={fw.line} />
      {/* A city action waiting for the operator's OK (ActCard.tsx): over the console, under the recovery card; never
          while the city is halted, never before the veil lifts. The console beneath stays usable (y, n, act ok, act no). */}
      {act && veilDone && locked === null && bridge && <ActCard act={act} termOpen={termOpen} onAllow={allowAct} onRefuse={refuseAct} />}
      {/* From the first render: React swaps index.html's identical splash for this, which fades into the city
          once the first snapshot exists (or lifts to show the recovery card or the lock screen). */}
      <BootVeil ready={hud !== null || error !== null || locked !== null} onDone={() => setVeilDone(true)} onConsole={toConsole} stage={stage} />
      {/* A real Ring-0 audit failure keeps its lock screen; a graphics reset, a realm fault or a frame loop that kept
          failing, like a failed boot, gets the recovery card (bootFailure.ts). Both have Restart, focused. */}
      {failure === null && locked !== null && <LockScreen reason={locked} />}
      {failure && <RecoveryCard failure={failure} adapter={adapter} onConsole={toConsole} />}
    </main>
  )
}

export default App
