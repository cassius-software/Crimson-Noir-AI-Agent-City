// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the conversation with the person near the player (talk.ts TalkController) over
 * fakes: a host whose scans are scripted by who stands where, a PersonChat whose replies the test settles by hand
 * (noting each prompt and stop signal), a speaker whose lines end when the test says, and an injected clock. The
 * transitions: nobody, someone offered, a conversation, the person thinking, speaking and listening again. A key opens
 * with the field focused and a tap does not; a stale chip opens nobody; a greeting opens and is the first turn, and
 * other talk is left for Sloane; a line said to Sloane closes the conversation and goes to her. The staring setter is
 * told once on opening and once on every ending, never for a person only offered and never per tick. The replies: a
 * request queued behind Sloane's is stopped and the script answers; patience gives the script the turn and leaves a
 * loading request to stop itself at its first words, which are never shown; a new line stops a streaming reply and
 * asks again; a turn while a late request holds the model takes the script; a refused turn gets a deflection and is
 * forgotten by the model; a reply that reads as a recruitment request is never shown or said; every other failure
 * falls back. The endings: a goodbye is said and then closes, 60 s idle closes, a card or a car closes as 'away',
 * the endings the player did not choose are toasted, and no timer is left after an ending or dispose. The label moves
 * only by more than half a pixel. And talk.ts is held at the source: the setter called only from #link and #unlink,
 * no model asked directly, no import of the 14A gate or the console, and the waiting phase equal to the in-page model's.
 * What breaks if it is removed? A conversation could open by itself, stay open for good, leave a timer or a request
 * behind, show a model's words after the script answered, turn heads on every tick, or wait behind Sloane, unnoticed.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { TALK_AGAIN_MS, TALK_REACH, TALK_SCAN_MS, type TalkEnd, type TalkEye } from '../08_Swarm/talkLink.ts'
import { fillLine, LINES, openerFor, talkWho, type TalkWho } from '../08_Swarm/talkLines.ts'
import type { ConciergeOut, PersonVoice, Tier } from './onboarding/speaker.ts'
import type { ChatResult, PersonChat, PersonTurn } from './onboarding/voice.ts'
import type { ScreenPoint } from './screenPoint.ts'
import {
  BEAT_MIN_MS, BEAT_SPAN_MS, IDLE_MS, NOBODY_LINE, NOBODY_TOAST_MS, PATIENCE_MS, READ_MAX_MS, READ_MIN_MS, READ_MS_PER_CHAR, TalkController, TRANSCRIPT_LINES, voiceVolume,
  WAITING_PHASE,
  type TalkClock, type TalkHost, type TalkLabelEl,
} from './talk.ts'

const SOURCE = readFileSync(new URL('./talk.ts', import.meta.url), 'utf8')
/** The source without its comments (a line comment starts at // not preceded by a colon, as in URLs). */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
const BEAT = BEAT_MIN_MS + BEAT_SPAN_MS
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

/** A clock whose timers run only when the test moves it on. */
function clockOf() {
  let t = 1000
  let seq = 0
  const timers = new Map<number, { at: number; fn: () => void }>()
  const clock: TalkClock = {
    now: () => t,
    after: (ms, fn) => {
      const id = ++seq
      timers.set(id, { at: t + ms, fn })
      return id
    },
    cancel: (h) => { timers.delete(h as number) },
  }
  return {
    clock,
    get t() { return t },
    get pending() { return timers.size },
    advance(ms: number): void {
      const end = t + ms
      for (;;) {
        let next: [number, { at: number; fn: () => void }] | null = null
        for (const e of timers) if (e[1].at <= end && (next === null || e[1].at < next[1].at)) next = e
        if (next === null) break
        timers.delete(next[0])
        t = Math.max(t, next[1].at)
        next[1].fn()
      }
      t = end
    },
  }
}

interface Person { d: number; walls?: number; gone?: boolean }

/** A city where the test says who stands how far away; the nominee is the nearest in reach with no wall. */
function hostOf() {
  const people = new Map<number, Person>()
  const follows: number[] = []
  const captions: [number, string, boolean][] = []
  const state: { blocked: 'car' | 'away' | 'halted' | null; spot: ScreenPoint; speed: number } = { blocked: null, spot: { sx: 0.5, sy: 0.4 }, speed: 0 }
  const eye: TalkEye = { x: 0, z: 0, feetY: 0, yaw: 0, speed: 0 }
  const out: ConciergeOut = { decode: () => Promise.reject(new Error('no audio here')), play: () => { throw new Error('no audio here') } }
  const host: TalkHost = {
    agents: 5000,
    blocked: () => state.blocked,
    eye: () => {
      eye.speed = state.speed
      return eye
    },
    scan(current, s) {
      for (const [row, p] of people) {
        if (p.gone || p.d > TALK_REACH || (p.walls ?? 0) > 0) continue
        if (p.d < s.bestScore) {
          s.best = row
          s.bestScore = p.d
        }
      }
      const p = current < 0 ? undefined : people.get(current)
      if (!p || p.gone) return
      s.curGone = false
      s.curD = p.d
      s.curWalls = p.walls ?? 0
      s.curScore = p.d
      s.curX = 0
      s.curZ = -p.d
    },
    follow: (row) => { follows.push(row) },
    place: () => state.spot,
    context: (row) => ({ agent: row, surroundings: 'On a quiet corner of the block.', recent: [] }),
    out: () => out,
    caption: (row, label, on) => { captions.push([row, label, on]) },
    hour: () => 12,
  }
  return { host, people, follows, captions, state }
}

interface Call {
  readonly prompt: string
  readonly name: string
  readonly turns: readonly PersonTurn[]
  readonly signal: AbortSignal
  readonly onText?: (soFar: string) => void
  readonly onPhase?: (phase: string | null) => void
  settle(r: ChatResult): void
}

/** A chat whose replies the test settles; a stop settles a reply as converse does ('failed', 'stopped'). */
function chatOf() {
  const calls: Call[] = []
  const chat: PersonChat = {
    reply: (prompt, name, turns, signal, onText, onPhase) => new Promise<ChatResult>((resolve) => {
      calls.push({ prompt, name, turns, signal, onText, onPhase, settle: resolve })
      signal.addEventListener('abort', () => resolve({ kind: 'failed', why: 'stopped' }), { once: true })
    }),
  }
  return { chat, calls }
}

/** A speaker whose lines end at once in `auto`'s tier, or when the test says (auto null); a new line or stop() cuts the last. */
function speakerOf(auto: Tier | null) {
  const said: { text: string; v: PersonVoice }[] = []
  let pending: ((t: Tier) => void) | null = null
  let stops = 0
  const speaker = {
    person: (text: string, v: PersonVoice): Promise<Tier> => new Promise<Tier>((resolve) => {
      pending?.('browser')
      said.push({ text, v })
      pending = resolve
      if (auto !== null) {
        pending = null
        resolve(auto)
      }
    }),
    stop: (): void => {
      stops++
      const p = pending
      pending = null
      p?.('browser')
    },
  }
  return {
    speaker, said,
    get stops() { return stops },
    get busy() { return pending !== null },
    finish(t: Tier = 'browser'): void {
      const p = pending
      pending = null
      p?.(t)
    },
  }
}

/** A controller over the fakes, with what it told the page, and `step` to let time pass a frame (50 ms) at a time. */
function rig(o: { tier?: Tier | null; mic?: boolean } = {}) {
  const c = clockOf()
  const h = hostOf()
  const ch = chatOf()
  const sp = speakerOf(o.tier === undefined ? 'browser' : o.tier)
  const partner: (number | null)[] = []
  const opened: boolean[] = []
  const sloane: string[] = []
  const toasts: [string, string][] = []
  const ctl = new TalkController({
    host: h.host, chat: ch.chat, speaker: sp.speaker,
    who: (row) => talkWho(row, null, null, null),
    partner: (row) => { partner.push(row) },
    onOpen: (on) => { opened.push(on) },
    onSloane: (text) => { sloane.push(text) },
    toast: (title, body) => { toasts.push([title, body]) },
    micOpen: () => o.mic === true,
    clock: c.clock,
  })
  const step = async (ms: number): Promise<void> => {
    const end = c.t + ms
    while (c.t < end) {
      c.advance(Math.min(50, end - c.t))
      ctl.tick(c.t)
      await flush()
    }
  }
  /** Someone at `d` m on row `row`, offered after two scans. */
  const near = async (row = 7, d = 2): Promise<void> => {
    h.people.set(row, { d })
    await step(2 * TALK_SCAN_MS + 50)
    assert.equal(ctl.ui().state, 'near')
    assert.equal(ctl.ui().who?.row, row)
  }
  /** A conversation with row 7 opened by a tap, its opener said. */
  const open = async (): Promise<void> => {
    await near()
    ctl.press('tap', ctl.ui().serial)
    await flush()
    assert.equal(ctl.ui().state, 'open')
  }
  const them = (): string[] => ctl.ui().lines.filter((l) => l.who === 'them').map((l) => l.text)
  return { c, h, ch, sp, ctl, partner, opened, sloane, toasts, step, near, open, them }
}

const who7 = (): TalkWho => talkWho(7, null, null, null)
const filled = (lines: readonly string[], who: TalkWho = who7()): string[] => lines.map((l) => fillLine(l, who))

test('off, someone offered after two scans, a conversation, the person thinking, speaking, and listening again', async () => {
  const r = rig({ tier: null })
  assert.equal(r.ctl.ui().state, 'off')
  assert.equal(r.ctl.hud(), undefined)
  r.h.people.set(7, { d: 2 })
  await r.step(50)
  assert.equal(r.ctl.ui().state, 'off', 'one scan does not offer')
  await r.step(TALK_SCAN_MS)
  const ui = r.ctl.ui()
  assert.equal(ui.state, 'near')
  assert.equal(ui.who?.label, who7().label)
  assert.equal(r.ctl.hud()?.state, 'near')
  assert.equal(r.ctl.hud()?.serial, ui.serial)
  assert.deepEqual(r.h.follows, [7], 'the engine follows the person offered, once')
  await r.step(TALK_SCAN_MS)
  r.ctl.press('keyboard')
  assert.equal(r.ctl.ui().state, 'open')
  assert.equal(r.ctl.ui().turn, 'speaking', 'the opener is said at once')
  assert.deepEqual(r.them(), [openerFor(who7(), 12)])
  assert.match(r.ctl.ui().said, /^Talking to Pedestrian 7 \(/)
  assert.equal(r.sp.said[0].v.volume, voiceVolume(2))
  assert.equal(r.sp.said[0].v.pick, who7().voice.pick)
  assert.equal(r.sp.said[0].v.out, null, 'a passer-by has no provider voice')
  r.sp.finish()
  await flush()
  assert.equal(r.ctl.ui().turn, 'listening')
  assert.equal(r.ctl.hud()?.state, 'open')
  assert.equal(r.ctl.send('what do you do all day?'), 'sent')
  assert.equal(r.ctl.ui().turn, 'thinking')
  assert.equal(r.ctl.hud()?.state, 'thinking')
  assert.equal(r.ch.calls.length, 1)
  const call = r.ch.calls[0]
  assert.equal(call.name, 'Pedestrian 7')
  assert.match(call.prompt, /Person: what do you do all day\?\nPedestrian 7:$/)
  assert.match(call.prompt, /On a quiet corner of the block\./, 'what is known about them reaches the prompt')
  assert.deepEqual(call.turns.map((t) => t.who), ['them', 'you'])
  call.onPhase?.('reading the prompt 30%')
  assert.equal(r.ctl.ui().status, 'Reading the conversation · 30%')
  call.onPhase?.(null)
  call.onText?.('I keep the ')
  assert.deepEqual(r.ctl.ui().lines.at(-1), { id: r.ctl.ui().lines.at(-1)?.id, who: 'them', text: 'I keep the ', live: true })
  call.settle({ kind: 'said', text: 'I keep the lights on.' })
  await flush()
  assert.equal(r.ctl.ui().turn, 'speaking')
  assert.equal(r.ctl.ui().status, 'Speaking')
  assert.equal(r.ctl.hud()?.state, 'speaking')
  assert.deepEqual(r.ctl.ui().lines.map((l) => [l.who, l.text, l.live]).slice(-2), [['you', 'what do you do all day?', false], ['them', 'I keep the lights on.', false]])
  assert.equal(r.ctl.ui().said, 'Pedestrian 7: I keep the lights on.', 'the final reply is announced once')
  assert.equal(r.sp.said.at(-1)?.text, 'I keep the lights on.')
  r.sp.finish()
  await flush()
  assert.equal(r.ctl.ui().turn, 'listening')
  assert.equal(r.ctl.ui().status, '')
  assert.ok(Object.isFrozen(r.ctl.ui()) && Object.isFrozen(r.ctl.ui().lines))
})

test('a key opens with the field focused, a tap never does, and a pad does only while no microphone is open; open, T focuses and the pad closes', async () => {
  const k = rig()
  await k.near()
  const f = k.ctl.ui().focus
  k.ctl.press('keyboard')
  assert.equal(k.ctl.ui().focus, f + 1)
  k.ctl.press('keyboard')
  assert.equal(k.ctl.ui().focus, f + 2, 'T while open focuses the field again')
  k.ctl.press('pad')
  assert.equal(k.ctl.ui().state, 'off', 'the pad button while open closes')
  assert.deepEqual(k.partner, [7, null])

  const t = rig()
  await t.near()
  const g = t.ctl.ui().focus
  t.ctl.press('tap', t.ctl.ui().serial)
  assert.equal(t.ctl.ui().state, 'open')
  assert.equal(t.ctl.ui().focus, g, 'no soft keyboard springs up on touch')

  for (const mic of [false, true]) {
    const p = rig({ mic })
    await p.near()
    const h = p.ctl.ui().focus
    p.ctl.press('pad')
    assert.equal(p.ctl.ui().state, 'open')
    assert.equal(p.ctl.ui().focus, mic ? h : h + 1, `pad with the microphone ${mic ? 'open' : 'closed'}`)
  }
})

test('a stale chip opens nobody: a tap must carry the serial of the proposal it showed', async () => {
  const r = rig()
  await r.near(7, 3)
  const stale = r.ctl.ui().serial
  r.h.people.set(9, { d: 1 })
  await r.step(3 * TALK_SCAN_MS)
  assert.equal(r.ctl.ui().who?.row, 9, 'someone clearly nearer replaces the person offered')
  assert.notEqual(r.ctl.ui().serial, stale)
  r.ctl.press('tap', stale)
  assert.equal(r.ctl.ui().state, 'near')
  assert.deepEqual(r.partner, [])
  r.ctl.press('tap')
  assert.equal(r.ctl.ui().state, 'near', 'a tap with no serial is stale too')
  r.ctl.press('tap', r.ctl.ui().serial)
  assert.equal(r.ctl.ui().state, 'open')
  assert.deepEqual(r.partner, [9])
})

test('a greeting to the person offered opens and is the first turn; other talk, and a line to Sloane, are left for her', async () => {
  const r = rig()
  await r.near()
  assert.equal(r.ctl.hear('so anyway the bus was late again'), false)
  assert.equal(r.ctl.hear('Sloane, hello'), false)
  assert.equal(r.ctl.hear('   '), false)
  assert.equal(r.ctl.ui().state, 'near')
  assert.deepEqual(r.partner, [])
  assert.equal(r.ctl.hear('hello   there'), true)
  assert.equal(r.ctl.ui().state, 'open')
  assert.deepEqual(r.partner, [7])
  assert.deepEqual(r.ctl.ui().lines.map((l) => [l.who, l.text]), [['you', 'hello there']], 'no opener: the greeting is the first turn')
  assert.equal(r.ch.calls.length, 1)
  assert.deepEqual(r.ch.calls[0].turns, [{ who: 'you', text: 'hello there' }])
  assert.equal(r.ctl.ui().focus, 0, 'a spoken start asks for no focus')

  const far = rig()
  assert.equal(far.ctl.hear('hello'), false, 'nobody offered: a greeting is Sloane\'s to ignore')
})

test('a line to Sloane closes the conversation: heard, it is left for her card; typed, it goes to her', async () => {
  const h = rig()
  await h.open()
  assert.equal(h.ctl.hear('what   do you do for work?'), true, 'while open, a line not said to Sloane is the partner\'s')
  assert.deepEqual(h.ch.calls[0].turns.at(-1), { who: 'you', text: 'what do you do for work?' })
  assert.equal(h.ctl.hear('Sloane, make it night'), false)
  assert.equal(h.ctl.ui().state, 'off')
  assert.deepEqual(h.partner, [7, null])
  assert.deepEqual(h.sloane, [], 'App hands a heard line on itself')
  assert.deepEqual(h.toasts, [])

  const t = rig()
  await t.open()
  assert.equal(t.ctl.send('  Sloane,   make it night '), 'gone')
  assert.equal(t.ctl.ui().state, 'off')
  assert.deepEqual(t.sloane, ['Sloane, make it night'])
  assert.equal(t.ctl.send('hello'), 'gone', 'nothing is open any more')

  const e = rig()
  await e.open()
  assert.equal(e.ctl.send('   '), 'empty')
  assert.equal(e.ctl.ui().state, 'open')
})

test('the staring setter is told once on opening and once on every ending, never for someone offered and never per tick', async () => {
  const ends: Record<TalkEnd, (r: ReturnType<typeof rig>) => Promise<void> | void> = {
    done: (r) => r.ctl.end('done'),
    bye: async (r) => {
      r.ctl.send('ok, bye')
      await r.step(BEAT + 50)
    },
    walked: async (r) => {
      r.h.people.set(7, { d: 13 })
      await r.step(TALK_SCAN_MS + 50)
    },
    gone: async (r) => {
      r.h.people.set(7, { d: 2, gone: true })
      await r.step(TALK_SCAN_MS + 50)
    },
    away: (r) => r.ctl.setBlocked(true),
    idle: async (r) => {
      for (let i = 0; i < 700 && r.ctl.ui().state === 'open'; i++) await r.step(100)
    },
    sloane: (r) => { assert.equal(r.ctl.hear('Sloane?'), false) },
    dispose: (r) => r.ctl.dispose(),
  }
  for (const [why, finish] of Object.entries(ends) as [TalkEnd, (r: ReturnType<typeof rig>) => Promise<void> | void][]) {
    const r = rig()
    await r.near()
    await r.step(10 * TALK_SCAN_MS)
    assert.deepEqual(r.partner, [], `${why}: nothing while only offered`)
    r.ctl.press('keyboard')
    await r.step(10 * TALK_SCAN_MS)
    assert.deepEqual(r.partner, [7], `${why}: once on opening`)
    await finish(r)
    assert.equal(r.ctl.ui().state, 'off', why)
    assert.deepEqual(r.partner, [7, null], `${why}: once on the ending`)
    assert.deepEqual(r.opened, [true, false], why)
    await r.step(10 * TALK_SCAN_MS)
    r.ctl.end('done')
    assert.deepEqual(r.partner, [7, null], `${why}: nothing after`)
  }
})

test('a request queued behind Sloane\'s is stopped at once and the script answers within a beat', async () => {
  const r = rig()
  await r.open()
  r.ctl.send('what do you do for work?')
  const call = r.ch.calls[0]
  call.onPhase?.(WAITING_PHASE)
  assert.equal(call.signal.aborted, true, 'nothing waits behind Sloane')
  assert.equal(r.ctl.ui().turn, 'thinking')
  await r.step(BEAT + 50)
  const said = r.them().at(-1) ?? ''
  assert.ok(filled(LINES.stranger.work).includes(said), said)
  assert.equal(r.ch.calls.length, 1)
  assert.equal(r.c.pending, 0)
})

test('patience: the script answers now, a loading request is given up late, stops itself at its first words, and none of them is shown', async () => {
  const r = rig()
  await r.open()
  r.ctl.send('what do you do for work?')
  const call = r.ch.calls[0]
  call.onPhase?.('reading the prompt 30%')
  await r.step(PATIENCE_MS - 100)
  assert.equal(r.them().length, 1, 'still waiting on the model')
  assert.equal(r.ctl.ui().status, 'Reading the conversation · 30%')
  await r.step(150)
  assert.equal(r.them().length, 2, 'the script answered at once')
  assert.ok(filled(LINES.stranger.work).includes(r.them()[1]))
  assert.equal(call.signal.aborted, false, 'a model reading its prompt is not stopped (it would unload)')
  // A turn while the late request still holds the model goes to the script.
  r.ctl.send('and what are you good at?')
  await r.step(BEAT + 50)
  assert.equal(r.ch.calls.length, 1)
  assert.equal(r.them().length, 3)
  // A later phase changes nothing on screen; the first words stop it, and they are never shown.
  call.onPhase?.('reading the prompt 90%')
  assert.equal(r.ctl.ui().status, '')
  call.onText?.('Secret words of the late reply')
  assert.equal(call.signal.aborted, true)
  await flush()
  assert.ok(!r.ctl.ui().lines.some((l) => /Secret/.test(l.text)))
  assert.ok(!r.sp.said.some((s) => /Secret/.test(s.text)))
  // Once it has gone, the next turn asks the model again.
  r.ctl.send('who are you, then?')
  assert.equal(r.ch.calls.length, 2)
})

test('a late request that has to wait stops itself', async () => {
  const r = rig()
  await r.open()
  r.ctl.send('what do you do for work?')
  const call = r.ch.calls[0]
  call.onPhase?.('loading the model in this page')
  r.ctl.send('never mind, who are you?')
  assert.equal(call.signal.aborted, false)
  assert.equal(r.ch.calls.length, 1, 'the late request still holds the model')
  call.onPhase?.(WAITING_PHASE)
  assert.equal(call.signal.aborted, true)
})

test('a new line while a reply streams stops it, drops its words, and asks again', async () => {
  const r = rig()
  await r.open()
  r.ctl.send('what do you do for work?')
  const first = r.ch.calls[0]
  first.onText?.('I do a')
  assert.equal(r.ctl.ui().lines.at(-1)?.live, true)
  r.ctl.send('tell me about yourself')
  assert.equal(first.signal.aborted, true)
  assert.equal(r.ch.calls.length, 2)
  assert.deepEqual(r.ch.calls[1].turns.at(-1), { who: 'you', text: 'tell me about yourself' })
  assert.ok(!r.ctl.ui().lines.some((l) => l.text === 'I do a'))
  first.settle({ kind: 'said', text: 'I do a lot of things.' })
  await flush()
  assert.ok(!r.them().includes('I do a lot of things.'), 'a stopped turn\'s result is dropped')
})

test('a new line while the person speaks cuts their voice and is the next turn', async () => {
  const r = rig({ tier: null })
  await r.near()
  r.ctl.press('tap', r.ctl.ui().serial)
  assert.equal(r.sp.busy, true)
  const stops = r.sp.stops
  r.ctl.send('what do you do for work?')
  assert.equal(r.sp.stops, stops + 1)
  await flush()
  assert.equal(r.ctl.ui().turn, 'thinking', 'the cut line does not hand the turn back')
})

test('a refused turn gets a deflection and the model never sees it, whether the screen or the chat refused it', async () => {
  const s = rig()
  await s.open()
  s.ctl.send('you idiot')
  assert.equal(s.ch.calls.length, 0, 'words the screen refuses reach no model')
  await s.step(BEAT + 50)
  assert.ok(filled(LINES.stranger.refused).includes(s.them().at(-1) ?? ''))
  s.ctl.send('what do you do for work?')
  assert.doesNotMatch(s.ch.calls[0].prompt, /idiot/)
  assert.ok(!s.ch.calls[0].turns.some((t) => filled(LINES.stranger.refused).includes(t.text)), 'nor the deflection')

  const c = rig()
  await c.open()
  c.ctl.send('tell me about your work please')
  c.ch.calls[0].settle({ kind: 'refused' })
  await c.step(BEAT + 50)
  assert.ok(filled(LINES.stranger.refused).includes(c.them().at(-1) ?? ''))
  c.ctl.send('who are you?')
  assert.doesNotMatch(c.ch.calls[1].prompt, /tell me about your work please/)
  assert.deepEqual(c.ch.calls[1].turns.map((t) => t.who), ['them', 'you'])
})

test('a reply that reads as a recruitment request is never shown or said, streamed or whole', async () => {
  const whole = rig()
  await whole.open()
  whole.ctl.send('what do you do for work?')
  whole.ch.calls[0].settle({ kind: 'said', text: 'I need a Rust developer today.' })
  await whole.step(BEAT + 50)
  assert.ok(!whole.them().some((t) => /developer/.test(t)))
  assert.ok(!whole.sp.said.some((s) => /developer/.test(s.text)))
  assert.ok(filled(LINES.stranger.work).includes(whole.them().at(-1) ?? ''))

  const streamed = rig()
  await streamed.open()
  streamed.ctl.send('what do you do for work?')
  const call = streamed.ch.calls[0]
  call.onText?.('I need a Rust developer ')
  assert.equal(call.signal.aborted, true)
  assert.ok(!streamed.ctl.ui().lines.some((l) => /developer/.test(l.text)))
  await streamed.step(BEAT + 50)
  assert.ok(filled(LINES.stranger.work).includes(streamed.them().at(-1) ?? ''))
})

test('held, none, slow and failed fall back to the script line for what was asked', async () => {
  const results: ChatResult[] = [{ kind: 'held' }, { kind: 'none', why: 'not warm' }, { kind: 'slow', why: 'stalled' }, { kind: 'failed', why: 'broke' }]
  for (const result of results) {
    const r = rig()
    await r.open()
    r.ctl.send('what do you do for work?')
    r.ch.calls[0].settle(result)
    await flush()
    assert.equal(r.ctl.ui().turn, 'thinking', `${result.kind}: a beat first`)
    await r.step(BEAT + 50)
    assert.ok(filled(LINES.stranger.work).includes(r.them().at(-1) ?? ''), result.kind)
    assert.equal(r.c.pending, 0, result.kind)
  }
})

test('a goodbye takes the script, is said, and then closes; with no voice, after its reading time', async () => {
  const r = rig({ tier: null })
  await r.near()
  r.ctl.press('tap', r.ctl.ui().serial)
  r.sp.finish()
  await flush()
  r.ctl.send('thanks, bye')
  assert.equal(r.ch.calls.length, 0)
  await r.step(BEAT + 50)
  assert.ok(filled(LINES.stranger.bye).includes(r.them().at(-1) ?? ''))
  assert.equal(r.ctl.ui().state, 'open', 'still open while the farewell is said')
  r.sp.finish()
  await flush()
  assert.equal(r.ctl.ui().state, 'off')
  assert.deepEqual(r.partner, [7, null])
  assert.deepEqual(r.toasts, [], 'the player chose this ending')

  const quiet = rig({ tier: 'silent' })
  await quiet.open()
  quiet.ctl.send('goodbye')
  for (let i = 0; i < 20 && quiet.them().length < 2; i++) await quiet.step(50)
  const farewell = quiet.them().at(-1) ?? ''
  assert.ok(filled(LINES.stranger.bye).includes(farewell))
  const reading = Math.min(READ_MAX_MS, Math.max(READ_MIN_MS, farewell.length * READ_MS_PER_CHAR))
  await quiet.step(reading - 100)
  assert.equal(quiet.ctl.ui().state, 'open', 'the farewell stays on screen for its reading time')
  await quiet.step(200)
  assert.equal(quiet.ctl.ui().state, 'off')
})

test('60 s with nothing going on closes the conversation; a draft in the field keeps it', async () => {
  const r = rig()
  await r.open()
  await r.step(IDLE_MS - 500)
  assert.equal(r.ctl.ui().state, 'open')
  await r.step(1000)
  assert.equal(r.ctl.ui().state, 'off')
  assert.deepEqual(r.toasts, [['Talk', `${who7().label} went back to their day.`]])

  const d = rig()
  await d.open()
  d.ctl.setDraft('I was going to say', true)
  await d.step(IDLE_MS + 1000)
  assert.equal(d.ctl.ui().state, 'open')
})

test('blocked closes as away, with no toast and the voice cut; blocked while offered lets go; nothing opens while blocked', async () => {
  const r = rig({ tier: null })
  await r.near()
  r.ctl.press('tap', r.ctl.ui().serial)
  const stops = r.sp.stops
  r.ctl.setBlocked(true)
  assert.equal(r.ctl.ui().state, 'off')
  assert.deepEqual(r.partner, [7, null])
  assert.equal(r.sp.stops, stops + 1, 'a card opening cuts the line')
  assert.deepEqual(r.toasts, [])
  await r.step(4 * TALK_SCAN_MS)
  assert.equal(r.ctl.ui().state, 'off', 'nobody is offered while blocked')
  r.ctl.press('keyboard')
  assert.equal(r.ctl.hear('hello'), false)
  assert.deepEqual(r.toasts, [], 'no "nobody near" while blocked')
  r.ctl.setBlocked(false)
  await r.step(3 * TALK_SCAN_MS)
  assert.equal(r.ctl.ui().state, 'off', 'the last partner is not offered again at once')
  await r.step(TALK_AGAIN_MS)
  assert.equal(r.ctl.ui().state, 'near')

  const car = rig()
  await car.open()
  car.h.state.blocked = 'car'
  await car.step(50)
  assert.equal(car.ctl.ui().state, 'off')
  assert.deepEqual(car.partner, [7, null])

  const offered = rig()
  await offered.near()
  offered.h.state.blocked = 'away'
  await offered.step(50)
  assert.equal(offered.ctl.ui().state, 'off')
  assert.equal(offered.ctl.hud(), undefined)
  assert.deepEqual(offered.h.follows, [7, -1])
})

test('the endings the player did not choose are toasted: walked on, had to go, back to their day; a busy one holds to 12 m', async () => {
  const w = rig()
  await w.open()
  w.h.people.set(7, { d: 7 })
  await w.step(TALK_SCAN_MS + 50)
  assert.equal(w.ctl.ui().state, 'off')
  assert.deepEqual(w.toasts, [['Talk', `${who7().label} walked on.`]])

  const g = rig()
  await g.open()
  g.h.people.set(7, { d: 2, gone: true })
  await g.step(TALK_SCAN_MS + 50)
  assert.deepEqual(g.toasts, [['Talk', `${who7().label} had to go.`]])

  const busy = rig()
  await busy.open()
  busy.ctl.send('what do you do for work?')
  busy.h.people.set(7, { d: 7 })
  await busy.step(2 * TALK_SCAN_MS)
  assert.equal(busy.ctl.ui().state, 'open', 'a reply on its way holds past 6 m')
  busy.h.people.set(7, { d: 13 })
  await busy.step(TALK_SCAN_MS + 50)
  assert.equal(busy.ctl.ui().state, 'off')
  assert.equal(busy.ch.calls[0].signal.aborted, false, 'given up late, not stopped')
  assert.deepEqual(busy.toasts, [['Talk', `${who7().label} walked on.`]])
})

test('no timer is left after an ending or after dispose', async () => {
  const asked = rig()
  await asked.open()
  asked.ctl.send('what do you do for work?')
  assert.ok(asked.c.pending > 0, 'patience is running')
  asked.ctl.end('done')
  assert.equal(asked.c.pending, 0)

  const beat = rig()
  await beat.open()
  beat.ctl.send('bye then')
  assert.ok(beat.c.pending > 0, 'the beat is running')
  beat.ctl.dispose()
  assert.equal(beat.c.pending, 0)

  const read = rig({ tier: 'silent' })
  await read.open()
  assert.ok(read.c.pending > 0, 'the reading time is running')
  read.h.people.set(7, { d: 13 })
  await read.step(TALK_SCAN_MS + 50)
  assert.equal(read.ctl.ui().state, 'off')
  assert.equal(read.c.pending, 0)

  const busy = rig()
  await busy.open()
  busy.ctl.send('what do you do for work?')
  busy.ch.calls[0].onPhase?.('loading the model in this page')
  busy.ctl.dispose()
  assert.equal(busy.c.pending, 0)
  assert.equal(busy.ch.calls[0].signal.aborted, true, 'dispose leaves no request behind')
})

test('dispose closes, follows nobody, and makes every later call do nothing; twice is safe', async () => {
  const r = rig()
  await r.open()
  let told = 0
  r.ctl.subscribe(() => { told++ })
  r.ctl.dispose()
  r.ctl.dispose()
  assert.equal(r.ctl.ui().state, 'off')
  assert.equal(r.h.follows.at(-1), -1)
  assert.deepEqual(r.partner, [7, null])
  assert.deepEqual(r.opened, [true, false])
  const after = told
  r.ctl.press('keyboard')
  r.ctl.tick(r.c.t + 1000)
  assert.equal(r.ctl.hear('hello'), false)
  assert.equal(r.ctl.send('hello'), 'gone')
  r.ctl.preview('open')
  assert.equal(r.ctl.ui().state, 'off')
  assert.equal(r.ctl.hud(), undefined)
  assert.equal(told, after, 'no subscriber is told after dispose')
  assert.deepEqual(r.toasts, [])
})

test('the label moves only by more than half a pixel, stays inside the layer, and hides off screen and with nobody', async () => {
  const r = rig()
  const writes: string[] = []
  const shown: string[] = []
  const el: TalkLabelEl = {
    style: {
      set transform(v: string) { writes.push(v) },
      get transform() { return writes.at(-1) ?? '' },
      set visibility(v: string) { shown.push(v) },
      get visibility() { return shown.at(-1) ?? '' },
    },
  }
  r.ctl.attachLabel(el)
  r.ctl.setLayerSize(1000, 500)
  r.ctl.setLabelWidth(120)
  await r.step(50)
  assert.deepEqual(shown, ['hidden'])
  assert.deepEqual(writes, [])
  await r.near()
  assert.deepEqual(shown, ['hidden', 'visible'])
  assert.deepEqual(writes, ['translate3d(500.0px, 200.0px, 0) translate(-50%, -100%)'], 'one write while it stands still')
  r.h.state.spot = { sx: 0.5003, sy: 0.4 }
  await r.step(100)
  assert.equal(writes.length, 1, 'a 0.3 px move is not written')
  r.h.state.spot = { sx: 0.5008, sy: 0.4 }
  await r.step(50)
  assert.equal(writes.length, 2, 'a 0.8 px move is')
  r.h.state.spot = { sx: 0.995, sy: 0.001 }
  await r.step(50)
  assert.equal(writes.at(-1), 'translate3d(932.0px, 8.0px, 0) translate(-50%, -100%)', 'held 8 px inside, by half its width')
  r.h.state.spot = { sx: Number.NaN, sy: Number.NaN }
  await r.step(50)
  assert.equal(shown.at(-1), 'hidden')
  assert.equal(writes.length, 3, 'hiding writes no transform')
})

test('a press with nobody near says so at most every 5 s; a stale tap says nothing; hud() is the same object while nothing changed', async () => {
  const r = rig()
  r.ctl.press('keyboard')
  r.ctl.press('pad')
  r.ctl.press('tap', 1)
  assert.deepEqual(r.toasts, [['Talk', NOBODY_LINE]])
  await r.step(NOBODY_TOAST_MS)
  r.ctl.press('pad')
  assert.equal(r.toasts.length, 2)

  await r.near(7, 2)
  const a = r.ctl.hud()
  assert.equal(r.ctl.hud(), a)
  assert.equal(a?.metres, 2)
  assert.equal(a?.word, 'ahead')
  r.h.people.set(7, { d: 3 })
  await r.step(TALK_SCAN_MS)
  assert.notEqual(r.ctl.hud(), a)
  assert.equal(r.ctl.hud()?.metres, 3)
})

test('the transcript keeps the last lines, frozen, and ui() is new only on an edge', async () => {
  const r = rig()
  await r.open()
  let told = 0
  r.ctl.subscribe(() => { told++ })
  const before = r.ctl.ui()
  await r.step(4 * TALK_SCAN_MS)
  assert.equal(r.ctl.ui(), before, 'scans that change nothing make no new snapshot')
  assert.equal(told, 0)
  for (let i = 0; i < 6; i++) {
    r.ctl.send('thanks a lot')
    await r.step(BEAT + 50)
  }
  assert.equal(r.ctl.ui().lines.length, TRANSCRIPT_LINES)
  assert.ok(r.ctl.ui().lines.every((l) => Object.isFrozen(l)))
  assert.ok(told > 0)
})

test('the debug partner: offered and opened without a link, a partner call or a caption, with real replies', async () => {
  const r = rig()
  r.ctl.preview('near')
  assert.equal(r.ctl.ui().state, 'near')
  assert.equal(r.ctl.ui().preview, true)
  assert.equal(r.ctl.hud()?.state, 'near')
  r.ctl.preview('open')
  assert.equal(r.ctl.ui().state, 'open')
  await flush()
  assert.equal(r.them().length, 1, 'the opener')
  assert.equal(r.ctl.send('hi there'), 'sent')
  r.ch.calls[0].settle({ kind: 'none', why: 'not warm' })
  await r.step(BEAT + 50)
  assert.equal(r.them().length, 2, 'the script answers')
  assert.deepEqual(r.partner, [])
  assert.deepEqual(r.h.captions, [])
  assert.ok(r.sp.said.every((s) => s.v.caption === undefined && s.v.out === null))
  r.ctl.preview(null)
  assert.equal(r.ctl.ui().state, 'off')
  assert.equal(r.ctl.ui().preview, false)
  assert.deepEqual(r.partner, [])
})

test('talk.ts at the source: the setter only in #link and #unlink, no model asked directly, no gate or console import, the in-page waiting phase', () => {
  const calls = [...CODE.matchAll(/\.partner\(/g)].length
  assert.equal(calls, 2, 'two calls in all')
  const body = (head: string): string => {
    const at = CODE.indexOf(head)
    assert.ok(at > 0, head)
    return CODE.slice(at, CODE.indexOf('\n  }\n', at))
  }
  assert.equal([...body('  #link(row: number): void {').matchAll(/\.partner\(/g)].length, 1)
  assert.equal([...body('  #unlink(): void {').matchAll(/\.partner\(/g)].length, 1)
  assert.match(body('  #link(row: number): void {'), /if \(this\.#partnered === row\) return\n\s*this\.#partnered = row\n/)
  assert.match(body('  #unlink(): void {'), /if \(this\.#partnered === null\) return\n\s*this\.#partnered = null\n/)
  assert.doesNotMatch(SOURCE, /\.answer\s*\(/)
  // Spelled in parts, so this file does not carry the words a sweep of new files looks for.
  assert.doesNotMatch(SOURCE, new RegExp(['per', 'form'].join(''), 'i'))
  assert.doesNotMatch(SOURCE, new RegExp(['ring0', 'Gate'].join('')))
  assert.doesNotMatch(SOURCE, /from '[^']*terminal\//)
  const specs = [...SOURCE.matchAll(/from '([^']+)'/g)].map((m) => m[1])
  assert.ok(specs.length > 5 && specs.every((s) => !/three|react/.test(s)), 'no three, no React')
  const inPage = readFileSync(new URL('../09_Cognition/inPage.ts', import.meta.url), 'utf8')
  assert.equal(/export const WAITING = '([^']+)'/.exec(inPage)?.[1], WAITING_PHASE)
  const bootloader = readFileSync(new URL('./bootloader.test.ts', import.meta.url), 'utf8')
  const forbidden = /^const FORBIDDEN = \/(.+)\/([a-z]*)$/m.exec(bootloader)
  assert.ok(forbidden, 'the house regex is read from bootloader.test.ts')
  assert.doesNotMatch(SOURCE, new RegExp(forbidden[1], forbidden[2]))
})
