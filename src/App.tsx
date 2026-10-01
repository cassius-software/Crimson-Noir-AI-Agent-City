import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Engine, type EngineOptions } from './07_Execute_Actions/engine.ts'
import { Hud } from './07_Execute_Actions/Hud.tsx'
import { Terminal } from './07_Execute_Actions/terminal/Terminal.tsx'
import { offlineBridge, type LookBridge, type NetBridge, type TerminalBridge } from './07_Execute_Actions/terminal/bridge.ts'
import { hudLine, recruitBridge, Recruiter } from './08_Swarm/recruitment.ts'
import { TaskRouter } from './08_Swarm/taskRouter.ts'
import { deferredLedger, followRecruiter, indexedDbLedger, memoryBridge, SwarmMemory } from './08_Swarm/memory.ts'
import { createMindRouter } from './09_Cognition/router.ts'
import { createLocalSpeech } from './09_Cognition/localSpeech.ts'
import { createNetClient } from './10_Network/netClient.ts'
import { admissibleChat, admissibleName } from './10_Network/replication.ts'
import type { NetControls } from './07_Execute_Actions/engine.ts'
import type { GateHandle, GateLease, Mind, SkillGate } from './07_Execute_Actions/operator.ts'
import { TouchControls } from './04_Connect_Hardware/TouchControls.tsx'
import { isEditableTarget } from './04_Connect_Hardware/input.ts'
import type { SipocSnapshot } from './05_Observe_Environment/telemetry.ts'
import { MonolithLogo } from './MonolithLogo.tsx'
import { BootVeil } from './07_Execute_Actions/BootVeil.tsx'
import { Concierge } from './07_Execute_Actions/Concierge.tsx'
import { Customizer } from './07_Execute_Actions/Customizer.tsx'
import { loadProfile, type Profile } from './05_Observe_Environment/profile.ts'
import { loadLook, saveLook } from './05_Observe_Environment/lookStore.ts'
import { changeLook, describeLook, lookFromSeed, type Look, type LookChange } from './03_Spawn_Agents/look.ts'
import { PLAYER_INDEX } from './03_Spawn_Agents/crowdCompute.ts'
import { clampPlayers } from './07_Execute_Actions/viewports.ts'
import type { PlanStep } from './06_Make_Decisions/intent.ts'
import { BRAND } from './brand.ts'
import embeddedRegion from 'virtual:region-pack'
import { validatePack, type RegionPack } from './01_Initialize_World/region/pack.ts'

const HUD_INTERVAL_MS = 100
/** Where the cognition router's settings (the provider, each provider's server and model, the network key) are kept between visits. */
const COGNITION_KEY = 'civic-simulation:cognition:v2'
/** Where the local speech server's settings (its server, voice, model, auto) are kept between visits. */
const SPEECH_KEY = 'civic-simulation:speech:v1'
/** Characters of a streaming answer the HUD shows. */
const ANSWER_TAIL = 72
/** Where the network session token (`net join <url> <token>`) is kept between visits, like the cognition key; never in the page source. */
const NET_TOKEN_KEY = 'civic-simulation:net:v1'

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
 * The HUD's view of the operator's local model and voice: an answer streaming in (its latest words, or that the model
 * is still thinking), or who is speaking aloud.
 */
function activityText(a: { thinking: number; tail: string } | null, speaking: number): string {
  if (!a) return speaking >= 0 ? `Speaking · agent ${speaking}` : ''
  if (a.tail) return `Answering: …${a.tail.replace(/\s+/g, ' ').trimStart()}`
  return a.thinking ? `Answering · thinking (${a.thinking})` : 'Answering · waiting for the model'
}

/**
 * The region the pilot build carries (vite.config.ts regionPack), unpacked and checked; null in every other build, or
 * when the page asks for the procedural city (?region=off). Nothing is fetched: the bytes are in this file.
 */
async function loadRegion(): Promise<RegionPack | null> {
  if (!embeddedRegion || new URLSearchParams(window.location.search).get('region') === 'off') return null
  const bytes = Uint8Array.from(atob(embeddedRegion), (c) => c.charCodeAt(0))
  const text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text()
  return validatePack(JSON.parse(text))
}

/** Which shell the page boots: 'gui' (the city) or 'tty' (?boot=tty: the full-screen console alone, no engine). */
type BootTrack = 'gui' | 'tty'

type Options = EngineOptions & { debug: boolean; boot: BootTrack }

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

function readOptions(): Options {
  const q = new URLSearchParams(window.location.search)
  const num = (key: string, fallback: number, min: number, max: number) => {
    const v = Number(q.get(key))
    return q.has(key) && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback
  }
  const quality = q.get('quality')
  return {
    // Absent: the device profile decides (governor.ts defaultAgents: 14,000 on a desktop GPU, fewer on phones).
    agents: q.has('crowd') ? Math.round(num('crowd', 14000, 256, 60000)) : undefined,
    cars: Math.round(num('cars', 36, 0, 48)),
    pixelRatio: num('scale', Math.min(window.devicePixelRatio, 1), 0.25, 2),
    seed: Math.round(num('seed', 1337, 0, 2 ** 31)),
    // Golden hour: the sun about 10° up in the west (solar.ts), long warm light for the first look.
    startHour: num('time', 17, 0, 24),
    dayMinutes: num('day', 24, 1, 1440),
    shadows: q.get('shadows') !== '0',
    post: q.get('post') !== '0',
    profile: q.has('profile'),
    quality: quality === null || quality === 'auto' ? 'auto' : Math.round(num('quality', 3, 0, 4)),
    targetFps: Math.round(num('fps', 0, 0, 240)),
    audio: q.get('audio') !== '0',
    // Closed captions of every spatial sound (captions.ts); ?captions=0 keeps the HUD's strip empty.
    captions: q.get('captions') !== '0',
    debug: q.has('debug'),
    // Track B: ?boot=tty mounts the full-screen console alone (no canvas, no engine, no WebGPU, no worker, no audio).
    boot: q.get('boot') === 'tty' ? 'tty' : 'gui',
    // The AI fleet on fixed tracks (zero-jam rings); ?tracks=0 restores the random street-hopping routes.
    tracks: q.get('tracks') !== '0',
    // The cinema camera (24 fps, 180° shutter, ND, film response); ?cinema=0 draws every frame with ACES.
    cinema: q.get('cinema') !== '0',
    // Local split screen: ?players=2..4 cuts the canvas into a viewport per player (viewports.ts clamps it to 1..4).
    players: clampPlayers(q.get('players')),
  }
}

const noop = (): void => {}

/**
 * Track B: the bare console. Nothing of the city is built: no canvas, no Engine.create, no WebGPU adapter request,
 * no physics worker, no audio, no HUD. The terminal runs over the offline bridge (the identity commands work; the
 * rest says 'engine not running'); a `boot gui` result reloads into the city.
 */
function TtyShell() {
  return (
    <main className="relative h-full w-full overflow-hidden bg-black">
      <Terminal bridge={TTY_BRIDGE} fullscreen onOpenChange={noop} onBoot={reboot} />
    </main>
  )
}

function App() {
  // Read once: the boot track decides which shell mounts, so the hooks of each shell live in that shell.
  const [options] = useState(readOptions)
  return options.boot === 'tty' ? <TtyShell /> : <GuiShell options={options} />
}

/** The city: the engine over the canvas, the HUD, the Concierge, the touch controls and the drop-down console. */
function GuiShell({ options }: { options: Options }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<Engine | null>(null)
  const termOpenRef = useRef(false)
  const [engine, setEngine] = useState<Engine | null>(null)
  const [bridge, setBridge] = useState<TerminalBridge | null>(null)
  const [termOpen, setTermOpen] = useState(false)
  const [hud, setHud] = useState<SipocSnapshot | null>(null)
  const [hudVisible, setHudVisible] = useState(true)
  const [adapter, setAdapter] = useState('')
  const [error, setError] = useState<string | null>(null)
  // Read synchronously, so the very first render already knows a returning visitor.
  const [profile, setProfile] = useState<Profile | null>(loadProfile)
  // The look the visitor chose (lookStore.ts), or null: then their own seed's look (the first use of profile.seed),
  // or, unnamed, the hash's for the player's body. The wardrobe card is Wren's to open.
  const [look, setLook] = useState<Look | null>(loadLook)
  const [lookOpen, setLookOpen] = useState(false)
  const lookOpenRef = useRef(false)
  const [veilDone, setVeilDone] = useState(false)
  // A Ring-0 kernel panic: the engine is halted and the reason is shown over everything.
  const [locked, setLocked] = useState<string | null>(null)

  useEffect(() => { engine?.setPlayerName(profile?.name ?? '') }, [engine, profile])
  // The player's own body wears it from the start (agent PLAYER_INDEX; the engine writes the crowd's look word).
  const worn = useMemo(() => look ?? (profile ? lookFromSeed(profile.seed) : null), [look, profile])
  useEffect(() => { engine?.setLook(PLAYER_INDEX, worn) }, [engine, worn])
  const wearLook = useCallback((next: Look) => { setLook(next); saveLook(next) }, [])
  // The console's `look` knob reads these (the bridge is built once, with the engine).
  const wornRef = useRef<Look | null>(null)
  const seedRef = useRef(PLAYER_INDEX)
  useEffect(() => { wornRef.current = worn; seedRef.current = profile?.seed ?? PLAYER_INDEX }, [worn, profile])
  const openLook = useCallback(() => setLookOpen(true), [])
  const closeLook = useCallback(() => setLookOpen(false), [])

  // A brief's immediate steps go through the terminal bridge (the same four operator knobs), never the engine.
  const applyIntent = useCallback((step: PlanStep): boolean => {
    const b = bridge
    if (!b) return false
    if (step.control === 'time' && typeof step.value === 'number') { b.setClock(step.value); return true }
    if (step.control === 'quality' && (step.value === 'auto' || typeof step.value === 'number')) { b.quality(step.value); return true }
    if (step.control === 'audio' && (step.value === 'on' || step.value === 'off' || typeof step.value === 'number')) { b.audio(step.value); return true }
    return false
  }, [bridge])

  // The console suspends game input (and releases pointer lock) while it owns the keyboard; the wardrobe card likewise
  // while it is open (the console opening puts the card away).
  const onTermOpen = useCallback((open: boolean) => {
    termOpenRef.current = open
    setTermOpen(open)
    if (open) setLookOpen(false)
    engineRef.current?.input.suspend(open || lookOpenRef.current)
  }, [])
  useEffect(() => {
    lookOpenRef.current = lookOpen
    engineRef.current?.input.suspend(lookOpen || termOpenRef.current)
  }, [lookOpen])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'KeyH' && !e.repeat && !termOpenRef.current && !isEditableTarget(e.target)) setHudVisible((v) => !v)
    }
    // Browsers only start audio from a user gesture; every gesture is a chance to (re)unlock it (every player's soundscape).
    const unlock = () => engineRef.current?.unlockAudio()
    window.addEventListener('keydown', onKey)
    for (const type of ['pointerdown', 'keydown', 'touchend', 'click'] as const) window.addEventListener(type, unlock, { capture: true })
    return () => {
      window.removeEventListener('keydown', onKey)
      for (const type of ['pointerdown', 'keydown', 'touchend', 'click'] as const) window.removeEventListener(type, unlock, { capture: true })
    }
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    let engine: Engine | null = null
    let recruiter: Recruiter | null = null
    let router: TaskRouter | null = null
    /** Stops writing the recruiter's events into the swarm's memory. */
    let unfollow: (() => void) | null = null
    /** The answer streaming in from the local model, for the HUD (null when none is). */
    let answering: { thinking: number; tail: string } | null = null
    let raf = 0
    let cancelled = false
    let lastHud = 0

    // The single requestAnimationFrame loop: the engine advances one synchronized step per tick and
    // React only sees a snapshot every HUD_INTERVAL_MS, so the HUD never re-renders at frame rate.
    const loop = (now: number) => {
      if (!engine || engine.halted) return
      engine.frame(now)
      if (now - lastHud > HUD_INTERVAL_MS) {
        lastHud = now
        const s = engine.snapshot()
        if (recruiter) s.supplier.recruiting = hudLine(recruiter, router?.running ?? 0, activityText(answering, engine.speaking))
        setHud(s)
      }
      raf = requestAnimationFrame(loop)
    }
    const onResize = () => engine?.resize()

    loadRegion().then((region) => Engine.create(canvas, { ...options, region })).then(
      (e) => {
        if (cancelled) {
          e.dispose()
          return
        }
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
        // The cognition router (only ever asked on the operator's command): the Claude API over the network, or a model
        // server on this machine, swapped at the console. Its answer's pieces are shown on the HUD only after the lease
        // let them through.
        const local = createMindRouter({ fetch: (url, init) => window.fetch(url, init), store: pageStore(COGNITION_KEY) })
        const mind: Mind = {
          ...local,
          answer: (req, onPiece) => {
            const live = { thinking: 0, tail: '' }
            answering = live
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
        unfollow = followRecruiter(memory, r)
        // The local speech server (only ever asked on the operator's command, only on this machine): the audio it
        // returns is placed by the engine's soundscape at the speaker's head.
        const voice = createLocalSpeech({ fetch: (url, init) => window.fetch(url, init), store: pageStore(SPEECH_KEY) })
        // A walk ping (go or gather) at a sidewalk point near the operator asks an Active recruit over to it: the engine
        // plans it from its own copies (08_Swarm/ping.ts rallyPlan), the recruiter checks the page's copy, the physics
        // realm decides on its own readings; its answer is a toast either way.
        e.onRally = (req) => { void r.rally(req.agent, req.x, req.z).then((o) => e.toast('Rally', o.message)) }
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
          unfollow?.()
          tasks.dispose()
          r.dispose()
          setLocked(reason)
        }
        if (termOpenRef.current || lookOpenRef.current) e.input.suspend(true)
        setEngine(e)
        setBridge(Object.freeze({
          ...e.terminalBridge(gate, mind, voice, memory.diary()),
          recruit: recruitBridge(r),
          memory: memoryBridge(memory, r),
          net: netBridge(e.net, pageStore(NET_TOKEN_KEY)),
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
              // The network session (10_Network): join a room, leave it, or read it as plain data.
              net: e.net,
              // Headless browsers cannot take pointer lock; this hides the capture hint for screenshots.
              pretendLocked: () => { e.input.locked = true },
              // The physics realm as the harness sees it: the mirrored state, the command queue (dbg* accepted), the next state.
              sim: e.debugSim(),
              engine: e,
            },
          })
        }
        raf = requestAnimationFrame(loop)
      },
      (err: unknown) => setError(err instanceof Error ? err.message : String(err)),
    )
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      engineRef.current = null
      setEngine(null)
      setBridge(null)
      unfollow?.()
      router?.dispose()
      recruiter?.dispose()
      if ((window as { recruit?: unknown }).recruit) delete (window as { recruit?: unknown }).recruit
      engine?.dispose()
    }
  }, [options, wearLook])

  return (
    <main className="relative h-full w-full overflow-hidden bg-slate-900">
      <canvas ref={canvasRef} className="block h-full w-full touch-none" />
      <Hud s={hud} adapter={adapter} visible={hudVisible} terminalOpen={termOpen} mapLayer={engine?.mapLayer ?? null} />
      {engine && hud && !termOpen && (
        <TouchControls input={engine.input} driving={hud.input.mode === 'vehicle'} nearVehicle={hud.input.nearVehicle} />
      )}
      {hud && (
        <Concierge
          visible={veilDone && hudVisible && !termOpen && !lookOpen}
          profile={profile}
          onProfile={setProfile}
          family={hud.supplier.glyphs}
          driving={hud.input.mode === 'vehicle'}
          dark={hud.customer.daylight < 0.35}
          onIntent={applyIntent}
          onLook={openLook}
        />
      )}
      {hud && (
        <Customizer
          visible={lookOpen && veilDone && !termOpen && locked === null}
          look={worn}
          seed={profile?.seed ?? 0}
          onChange={wearLook}
          onClose={closeLook}
          dark={hud.customer.daylight < 0.35}
        />
      )}
      <Terminal bridge={bridge} onOpenChange={onTermOpen} onBoot={reboot} />
      {/* From the first render: React swaps index.html's identical splash for this, which fades into the city
          once the first snapshot exists (or lifts to show the error card). */}
      <BootVeil ready={hud !== null || error !== null} onDone={() => setVeilDone(true)} />
      {locked && (
        <div role="alertdialog" aria-live="assertive" className="absolute inset-0 z-[10000] flex items-center justify-center bg-black p-8 font-mono text-sm text-slate-200">
          <div className="max-w-2xl">
            <div className="text-xs tracking-[0.3em] text-rose-400">[RING-0 FATAL]</div>
            <div className="mt-3 text-2xl font-semibold text-white">SYSTEM LOCKED</div>
            <div className="mt-2 break-words text-slate-300">{locked}</div>
            <div className="mt-6 text-xs text-slate-500">
              The Ring-0 audit found a broken invariant after the physics step. Physics and rendering are halted and the
              hardware bus has been disconnected. Reload the page to start again.
            </div>
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center p-8 font-sans text-sm">
          <div className="max-w-xl rounded-2xl border border-white/70 bg-white/80 p-6 text-slate-900 shadow-2xl backdrop-blur-xl">
            <div className="mb-3 flex items-center gap-3">
              <MonolithLogo size={36} title="" />
              <div className="text-lg font-semibold">{BRAND.name} couldn’t start</div>
            </div>
            <div>{error}</div>
            <div className="mt-3 text-xs text-slate-500">
              {BRAND.name} needs WebGPU: a current Chrome, Edge or Brave on desktop or Android, or Safari 26 on iPhone, iPad and Mac.
              The crowd simulation runs as WGSL compute and has no WebGL path.
            </div>
          </div>
        </div>
      )}
    </main>
  )
}

export default App
