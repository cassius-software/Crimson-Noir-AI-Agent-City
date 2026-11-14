// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place the page's cognition router and its providers are built, for the city
 * (App.tsx GuiShell, once the engine is up) and for the console alone (App.tsx TtyShell, the first time `ask` is used),
 * so the two cannot drift: the same providers in the same auto order (router.ts AUTO_ORDER: the servers on this
 * machine, the model the app runs itself where the shell has a runner, the model file kept in this page, the Claude
 * gateway on this machine), the same kept settings, the same sizing. The host hands in what only it has: the page's
 * fetch and store, the one runtime and store for the model kept in the page, the device as it knows it (the engine's
 * profile in the city; the browser's own hints in the console, browserDevice), the shell's runner and GPU reading, the
 * address's ?vram=, and where to hold the city's tier and show the model's phase (none in the console). Nothing here
 * starts a model, fetches a model file or asks the shell anything but its GPU reading: building the router chooses
 * nothing; the providers act only when asked. App.tsx imports this module with a dynamic import, so the console alone
 * starts without any of it (and with no engine, canvas, WebGPU, worker or audio). The onboarding's voice is decided
 * here too (onboardingVoice), over a router with no in-page model, from the same module.
 * What breaks if it is removed? Neither the city nor the console has a model to ask.
 */
import { createMindRouter, type MindRouter } from './router.ts'
import { figureFromAdapters } from './modelFit.ts'
import { createNativeMind, type NativeHost, type NativeMind } from './nativeMind.ts'
import { createInPageMind, type InPageMind, type InPageRuntime } from './inPage.ts'
import { holdTier, placement, type PlanEnv } from './inPagePlan.ts'
import type { ModelStore } from './modelStore.ts'
import type { FetchLike, SettingsStore } from './localCompute.ts'
import { profileDevice, readDeviceHints } from '../05_Observe_Environment/governor.ts'
import { canShareMemory } from '../07_Execute_Actions/sharedBridge.ts'
import { modelVoice, scriptedVoice, type Voice } from '../07_Execute_Actions/onboarding/voice.ts'

/** The device as the model kept in this page plans by it (inPagePlan.ts PlanEnv, without the GPU mode the mind fills). */
export type PageDevice = Omit<PlanEnv, 'gpuMode' | 'gpuFailed'>

export interface PageMindDeps {
  /** The page's own fetch (held to this machine by the air gap main.tsx installed). */
  fetch: FetchLike
  /** Where the router keeps its settings (App.tsx COGNITION_KEY), the same for the city and the console. */
  store: SettingsStore
  /** The page's one runtime and store for the model kept in it, made the first time they are asked for. */
  runtime: () => InPageRuntime
  models: () => ModelStore
  /** The device as the host knows it. */
  device: () => PageDevice
  /** The app's own model runner (desktopShell.ts shellRunner), or null in a browser. */
  runner: NativeHost | null
  /** The shell's reading of the GPUs' memory (desktopShell.ts shellGpuMemory), asked once as the router is built. */
  gpuMemory: () => Promise<number[] | null>
  /** The address's GPU figure (?vram=), for auto's Ollama model. */
  vram: string | null
  /** Holds the city's tier at most here while a model works (inPagePlan.ts holdTier), null to let it go; absent: no city. */
  hold?: (tier: number | null) => void
  /** The model's phase for the HUD (loading, reading the prompt), null to clear it; absent: none shown. */
  onPhase?: (text: string | null) => void
  /** Why the model the app carries cannot start, or null when it can (nativeMind.ts onFailed): Sloane's card says it. */
  onAppFailed?: (why: string | null) => void
}

/** The router, and the two minds it holds that the host also speaks to directly (the file kept, the app's model). */
export interface PageMind {
  readonly router: MindRouter
  readonly inPage: InPageMind
  readonly native: NativeMind
}

/**
 * The page's router over every provider. The model kept in this page plans by `device`, holds the tier while it loads
 * or answers and says its phase; the model the app runs itself is capped as the one in this page would be on this
 * device (shorter on a phone), holds the tier while it answers (it runs on the processor, or on Apple silicon's GPU,
 * whose tier is the integrated one either way), says the same phase and tells `onAppFailed` why it cannot start. The
 * shell's GPU reading, judged by modelFit.ts figureFromAdapters, sits below the address's figure and the console's.
 */
export function createPageMind(d: PageMindDeps): PageMind {
  let inPage!: InPageMind
  let native!: NativeMind
  // The Windows app's reading of the GPUs' memory (src-tauri/src/gpu.rs), asked once as this router is built; until it
  // answers, and in a browser, none.
  let appVram: number | null = null
  void d.gpuMemory().then((bytes) => { appVram = figureFromAdapters(bytes) }, () => {})
  const router = createMindRouter({
    fetch: d.fetch,
    store: d.store,
    inPage: (store) => (inPage = createInPageMind({
      runtime: () => d.runtime(),
      store: d.models(),
      kept: store,
      env: d.device,
      busy: (on, place) => d.hold?.(on && place ? holdTier(d.device(), place.gpu) : null),
      onPhase: (text) => d.onPhase?.(text),
    })),
    native: () => (native = createNativeMind({
      host: d.runner,
      maxTokens: () => placement({ ...d.device(), gpuMode: 'auto', gpuFailed: false }).maxTokens,
      busy: (on) => d.hold?.(on ? holdTier(d.device(), false) : null),
      onPhase: (text) => d.onPhase?.(text),
      onFailed: (why) => d.onAppFailed?.(why),
    })),
    vram: d.vram,
    appVram: () => appVram,
  })
  return Object.freeze({ router, inPage, native })
}

/**
 * The device as the browser alone says it, for the console, which never asks for a GPU adapter: the adapter unknown,
 * and no shader-f16 read, so the model kept in this page runs on the processor there unless `ask gpu on` was kept.
 */
export function browserDevice(): PageDevice {
  const h = readDeviceHints('')
  const p = profileDevice(h)
  return { mobile: p.mobile, lite: p.lite, gpuClass: p.gpuClass, cores: h.cores, memoryGb: h.memoryGb, isolated: canShareMemory(), f16: false }
}

/**
 * The voice the onboarding speaks with: the configured model backend's rewording when it answers in time, else the
 * script. With the auto provider (the default), the scripted provider, the in-page provider, or the Claude provider and
 * no key kept, nothing is asked (the script is the voice): a first visit on a fresh machine makes no request at all,
 * the scripted provider, which answers a request with nobody tethered with a line of its own, never rewords the
 * guide's lines, and a model file kept in this page is never loaded while the city is still being built (this router
 * is handed no runtime for one).
 */
export function onboardingVoice(fetch: FetchLike, store: SettingsStore): Voice {
  const router = createMindRouter({ fetch, store })
  const s = router.settings()
  if (s.provider === 'auto' || s.provider === 'scripted' || s.provider === 'inpage' || (s.provider === 'claude' && !s.key)) return scriptedVoice()
  return modelVoice(router, (line) => (/morning, sunset or night/i.test(line) ? ['morning', 'sunset', 'night'] : /sound on/i.test(line) ? ['sound'] : []))
}
