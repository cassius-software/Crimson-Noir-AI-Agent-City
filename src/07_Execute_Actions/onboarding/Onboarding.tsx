// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the first thing a new visitor sees: a quiet full-screen card on the brand's ink where
 * Wren, the concierge, talks them into their city in plain words. Four short turns (a name, where to start, what time of
 * day, sound on or off), each answered with one typed word or one tap, while the lakefront metropolis is built in the
 * background (lakefrontClient.ts over its worker) and its progress is told in plain words under the conversation; a
 * small map of the five regions appears as soon as it is built, with the visitor's start marked. At the end one button
 * walks in. A returning visitor never sees this (script.ts needsOnboarding); someone who knows their way around has a
 * skip link to the expert path (the procedural city, the page's own defaults). The words are the script's, or the
 * configured model's rewording of them when it answers in time (voice.ts). Built from the brand tokens alone
 * (src/brand/tokens.css): ink, titanium, one crimson dot.
 * What breaks if it is removed? A first visitor is dropped into the city with no idea what it is or what to do, and the
 * lakefront map is never built for them.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type JSX } from 'react'
import { REGIONS, ZONE, type Zone } from '../../01_Initialize_World/lakefront.ts'
import { LakefrontBuilder, type BuilderPort } from '../../01_Initialize_World/lakefrontClient.ts'
import { STAGE_WORDS, type BuildStage } from '../../01_Initialize_World/lakefrontPack.ts'
import type { RegionPack } from '../../01_Initialize_World/region/pack.ts'
import { NAME_MAX, saveProfile, sanitizeName, seedFromName } from '../../05_Observe_Environment/profile.ts'
import { MonolithLogo } from '../../MonolithLogo.tsx'
import { CONCIERGE_NAME } from '../Concierge.tsx'
import {
  NO_ANSWERS, SKIPPED, answer, choicesFor, lineFor, nextStep, optionsFrom, outcomeOf, said, saveOnboarding, type Answers, type SavedOnboarding, type Step,
} from './script.ts'
import { scriptedVoice, type Voice } from './voice.ts'

/** What the onboarding hands the page when it is over. */
export interface Outcome {
  saved: SavedOnboarding
  /** The page options the answers set (none when skipped). */
  options: { startHour: number; audio: boolean } | null
  /** The map built in the background, starting where the visitor chose (null when skipped, or when the build failed). */
  pack: RegionPack | null
}

interface Turn { who: 'wren' | 'you'; text: string }

/** The ink shades the five regions and the lake are drawn in on the small map (titanium steps; crimson is the start). */
const ZONE_INK: readonly string[] = ['#5a5a60', '#8c8c90', '#c8c8cc', '#2c2e36', '#e7e9ec', '#0a0a0e']

/** The small map: one pixel per block, the five regions in titanium, the sea in ink, the start as a crimson dot. */
function ZoneMap({ zones, blocks, start }: { zones: Uint8Array; blocks: number; start: Zone | null }): JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const c = ref.current
    const ctx = c?.getContext('2d')
    if (!c || !ctx) return
    c.width = blocks; c.height = blocks
    const img = ctx.createImageData(blocks, blocks)
    let sk = 0, sm = 0, sn = 0
    for (let i = 0; i < blocks * blocks; i++) {
      const z = zones[i]
      const hex = ZONE_INK[z] ?? ZONE_INK[5]
      img.data[i * 4] = parseInt(hex.slice(1, 3), 16); img.data[i * 4 + 1] = parseInt(hex.slice(3, 5), 16); img.data[i * 4 + 2] = parseInt(hex.slice(5, 7), 16); img.data[i * 4 + 3] = 255
      if (start !== null && z === start) { sk += (i % blocks) + 0.5; sm += Math.floor(i / blocks) + 0.5; sn++ }
    }
    ctx.putImageData(img, 0, 0)
    if (sn) {
      ctx.fillStyle = '#e8203a'
      ctx.beginPath(); ctx.arc(sk / sn, sm / sn, Math.max(1.5, blocks / 40), 0, Math.PI * 2); ctx.fill()
    }
  }, [zones, blocks, start])
  const where = start === null ? 'Your city, seen from above: five regions and the lake.' : `Your city from above. The red dot is where you start: ${REGIONS[start].name}.`
  return <canvas ref={ref} role="img" aria-label={where} className="h-28 w-28 rounded-noir-control border border-noir-titanium-800 [image-rendering:pixelated]" style={{ imageRendering: 'pixelated' }} />
}

export interface OnboardingProps {
  /** The world seed (the page's `?seed`, 1337 by default): the map is built for it. */
  seed: number
  onDone(outcome: Outcome): void
  /** The builder's port: the worker (lakefrontWorkerPort.ts builderPort), or the inline one. */
  port(): BuilderPort
  /** Who says the lines: the script, or the configured model over it (voice.ts). */
  voice?: Voice
}

export function Onboarding({ seed, onDone, port, voice = scriptedVoice() }: OnboardingProps): JSX.Element {
  const [step, setStep] = useState<Step>('name')
  const [answers, setAnswers] = useState<Answers>(NO_ANSWERS)
  const [turns, setTurns] = useState<Turn[]>([])
  const [line, setLine] = useState('')
  const [typed, setTyped] = useState('')
  const [stage, setStage] = useState<BuildStage | null>(null)
  const [zones, setZones] = useState<{ grid: Uint8Array; blocks: number } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [leaving, setLeaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const builderRef = useRef<LakefrontBuilder | null>(null)
  const doneRef = useRef(onDone)
  useEffect(() => { doneRef.current = onDone }, [onDone])

  // The build starts the moment the card opens, before a word is said.
  useEffect(() => {
    let b: LakefrontBuilder
    try {
      b = new LakefrontBuilder(seed, port(), {
        onStage: (s) => setStage(s),
        onBuilt: (_counts, grid) => setZones({ grid, blocks: Math.round(Math.sqrt(grid.length)) }),
      })
    } catch (err) {
      setFailed(err instanceof Error ? err.message : String(err))
      return
    }
    builderRef.current = b
    b.pack(ZONE.metropolis).catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)))
    return () => { b.dispose(); builderRef.current = null }
  }, [seed, port])

  // Wren's line for the step: the script at once, the model's rewording if it comes in time.
  useEffect(() => {
    const scripted = lineFor(step, answers, CONCIERGE_NAME)
    setLine(scripted)
    const ctl = new AbortController()
    void voice.say(scripted, ctl.signal).then((s) => { if (!ctl.signal.aborted && s !== scripted) setLine(s) })
    return () => ctl.abort()
    // The answers a step's line reads were fixed when the step was entered.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, voice])

  useEffect(() => { if (step === 'name') inputRef.current?.focus() }, [step])

  const choices = useMemo(() => choicesFor(step), [step])

  const take = useCallback((value: unknown) => {
    const next = answer(answers, step, value)
    setAnswers(next)
    setTurns((t) => [...t, { who: 'wren', text: line }, { who: 'you', text: said(step, next) }])
    setStep(nextStep(step))
  }, [answers, step, line])

  const onName = (e: FormEvent) => {
    e.preventDefault()
    take(sanitizeName(typed))
  }

  const finish = useCallback(async () => {
    if (leaving) return
    setLeaving(true)
    const name = sanitizeName(answers.name)
    if (name) saveProfile({ name, seed: seedFromName(name) })
    const saved = outcomeOf(answers)
    saveOnboarding(saved)
    let pack: RegionPack | null = null
    try { pack = (await builderRef.current?.pack(answers.place ?? ZONE.metropolis)) ?? null } catch (err) { setFailed(err instanceof Error ? err.message : String(err)) }
    doneRef.current({ saved, options: optionsFrom(answers), pack })
  }, [answers, leaving])

  const skip = useCallback(() => {
    if (leaving) return
    setLeaving(true)
    saveOnboarding(SKIPPED)
    doneRef.current({ saved: SKIPPED, options: null, pack: null })
  }, [leaving])

  const building = stage !== 'ready' && !failed
  const progress = failed ? 'The city could not be built; the first one will open instead.' : stage ? `${STAGE_WORDS[stage]}${stage === 'ready' ? '.' : '…'}` : 'Getting ready…'

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="onboarding-title" data-onboarding={step} className="absolute inset-0 z-[1100] flex overflow-y-auto bg-noir-ink px-4 py-6 font-noir-text text-noir-titanium-200 antialiased">
      <div className="noir-panel m-auto flex w-full max-w-md flex-col gap-4 p-4 sm:p-6">
        <header className="flex items-center gap-3">
          <MonolithLogo size={28} title="" />
          <div className="min-w-0">
            <div id="onboarding-title" className="truncate text-[17px] font-semibold leading-[22px] text-noir-titanium-100">{CONCIERGE_NAME}</div>
            <div className="noir-label">your guide</div>
          </div>
          <span className="ml-auto inline-block h-2 w-2 rounded-full bg-noir-crimson" aria-hidden="true" />
        </header>
        <div className="noir-rule" aria-hidden="true" />

        <ol className="flex flex-col gap-2 text-[15px] leading-5" aria-label="What was said so far">
          {turns.map((t, i) => (
            <li key={i} className={t.who === 'wren' ? 'max-w-[90%] text-noir-titanium-400' : 'max-w-[90%] self-end rounded-noir-control border border-noir-titanium-800 bg-noir-ink-2 px-3 py-1.5 text-noir-titanium-100'}>
              {t.text}
            </li>
          ))}
          <li className="text-noir-titanium-100" aria-live="polite" data-onboarding-line>{line}</li>
        </ol>

        {step === 'name' && (
          <form onSubmit={onName} className="flex gap-2">
            <input
              ref={inputRef}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              maxLength={NAME_MAX}
              autoComplete="off"
              aria-label="Your name"
              placeholder="Your name"
              className="min-w-0 flex-1 rounded-noir-control border border-noir-titanium-800 bg-noir-ink-2 px-3 py-2 text-[15px] text-noir-titanium-100 placeholder:text-noir-titanium-600 focus:border-noir-crimson focus:outline-none"
            />
            <button type="submit" className="noir-button">{typed.trim() ? 'That’s me' : 'Skip'}</button>
          </form>
        )}

        {choices && (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Your answer">
            {choices.map((c) => (
              <button key={c.label} type="button" onClick={() => take(c.value)} title={c.blurb} className="noir-button" data-choice={c.label}>{c.label}</button>
            ))}
          </div>
        )}

        {step === 'ready' && (
          <div className="flex flex-col gap-3">
            <button type="button" onClick={() => void finish()} disabled={leaving} className="noir-button is-active self-start px-5 py-2.5 text-[15px] disabled:opacity-60" data-onboarding-enter>
              {leaving ? 'Opening the door…' : building ? 'Walk in when it’s ready' : 'Walk in'}
            </button>
          </div>
        )}

        <div className="border-t border-noir-titanium-800" aria-hidden="true" />
        <footer className="flex items-center gap-3">
          {zones && <ZoneMap zones={zones.grid} blocks={zones.blocks} start={answers.place} />}
          <div className="min-w-0 flex-1">
            <div className="noir-label">Building your city</div>
            <div className="mt-1 text-[13px] leading-[18px] text-noir-titanium-400" aria-live="polite" data-onboarding-stage={stage ?? ''}>{progress}</div>
          </div>
        </footer>
        <div className="text-right">
          <button type="button" onClick={skip} className="text-[13px] text-noir-titanium-600 underline-offset-2 hover:text-noir-titanium-400 hover:underline" data-onboarding-skip>
            I know my way around, skip this
          </button>
        </div>
      </div>
    </div>
  )
}
