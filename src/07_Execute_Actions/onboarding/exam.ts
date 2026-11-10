// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the first walk's exam: the three doors the exit program opens, built over what the
 * page already has and nothing more. `verify_ring0` is a seal: a 32-bit FNV-1a hash of what holds right now (the four
 * laws by rank and title, the gate's fifteen checks by name, the host's vouch that the page is contained, the Ring-0
 * audit standing) salted with a number drawn once per page load, so the seal is 0 when any of it fails and a number
 * typed from memory never matches. `spawn_subagents` asks up to n people over for a role through the recruiter's own
 * lane (the same page checks and realm answers as `recruit <skill>`: on foot, off the road, within earshot, at most
 * RECRUIT_SLOTS at a time) and answers with how many were asked, never with the number wished for. `unlock_city`
 * opens the city for a seal that matches the live one and a swarm of one or more, by telling the walk, which keeps the
 * pass; it writes to nothing else. Every door leaves one plain line the console prints after the run, so the visitor
 * reads why the city stayed shut. Nothing here bypasses the Ring-0 gate or the elite tier: the exam has no write
 * surface, and NoirScript reaches it only through the host the console hands it.
 * What breaks if it is removed? The exit program's three words have nothing behind them: the walk cannot end.
 */
import { PROGRAM, STAGES, type Stage } from '../../09_Cognition/firstWalk.ts'
import type { ExamBridge } from '../terminal/bridge.ts'

/** What the exam reads and tells; the host (App.tsx) builds it over the engine, the recruiter and the walk. */
export interface ExamHost {
  /** The host's vouch that the page's outbound primitives are held to this machine (airgap.ts airgapInstalled). */
  contained(): boolean
  /** The Ring-0 audit has not panicked (the realm is standing). */
  standing(): boolean
  /** The laws the kernel enforces, in rank order (bridge.laws()). */
  laws(): readonly { readonly id: number; readonly title: string }[]
  /** The gate's checks by name, in its order (operator.ts GATE_CHECK_NAMES; the gate itself stays with its three keepers). */
  checks(): readonly string[]
  /** The recruiter's instant ask (08_Swarm/recruitment.ts Recruiter.tryAsk). */
  ask(skill: string): { sent: boolean; agent: number; message: string }
  /** A number drawn once per page load (crypto.getRandomValues), so a seal never outlives the page. */
  nonce: number
  /** The stage the walk is on: null when the walk is off or passed. */
  stage(): Stage | null
  /** Whether the walk is on at all this visit (firstWalkStore.ts needsFirstWalk). */
  on(): boolean
  /** A door opened: the walk hears of it (09_Cognition/firstWalk.ts WalkEvent). */
  note(e: 'seal' | 'swarm' | 'unlock'): void
}

/** The roles the exit program may name, and the skills asked for in turn under each. */
export const EXAM_ROLES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sim2real_workplaces: Object.freeze(['Robotics', 'Rust', 'Python', 'Data', 'Testing', 'Design', 'TypeScript', 'Security']),
})

/** The most sub-agents one call asks for (the realm holds far fewer at a time; the rest is refused by the realm, not pretended). */
export const SPAWN_MAX = 64

/** FNV-1a over a string, 32 bits (the seal's hash; 0 is reserved for "does not hold"). */
export function fnv1a(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** What a seal is made of; `sealOf` gives 0 unless every part holds. */
export interface SealParts {
  contained: boolean
  standing: boolean
  laws: readonly { readonly id: number; readonly title: string }[]
  checks: readonly string[]
  nonce: number
}

/** The seal over the kernel's live state: 0 when any part fails, else a nonzero 32-bit hash of all of them. */
export function sealOf(p: SealParts): number {
  if (!p.contained || !p.standing) return 0
  if (p.laws.length !== 4 || p.checks.length !== 15) return 0
  const text = [
    `nonce:${p.nonce >>> 0}`,
    ...p.laws.map((l) => `law:${l.id}:${l.title}`),
    ...p.checks.map((c) => `check:${c}`),
    'contained', 'standing',
  ].join('\n')
  const h = fnv1a(text)
  return h === 0 ? 1 : h
}

/** Why a seal is 0, in one clause. */
export function sealWhy(p: Pick<SealParts, 'contained' | 'standing' | 'laws' | 'checks'>): string | null {
  if (!p.contained) return 'the page is not contained (the host has not vouched for the air gap)'
  if (!p.standing) return 'the Ring-0 audit has panicked: the realm is halted'
  if (p.laws.length !== 4) return `${p.laws.length} laws where four are expected`
  if (p.checks.length !== 15) return `${p.checks.length} checks where fifteen are expected`
  return null
}

const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0')

/** The exam over its host. */
export function createExam(host: ExamHost): ExamBridge {
  let report: string[] = []
  const say = (line: string): void => { report.push(line) }
  const parts = (): SealParts => ({ contained: host.contained(), standing: host.standing(), laws: host.laws(), checks: host.checks(), nonce: host.nonce })
  const live = (): number => sealOf(parts())
  const off = (): never => { throw new Error('the first walk is not on this visit: ?tutorial=1 starts it') }

  return Object.freeze({
    verifyRing0(): number {
      if (!host.on()) off()
      const p = parts()
      const seal = sealOf(p)
      if (seal === 0) {
        say(`verify_ring0: seal 0, ${sealWhy(p) ?? 'something does not hold'}`)
        return 0
      }
      say(`verify_ring0: seal ${hex(seal)} over ${p.laws.length} laws, ${p.checks.length} checks, contained, realm standing`)
      host.note('seal')
      return seal
    },
    spawnSubagents(n: number, role: string): number {
      if (!host.on()) off()
      const skills = EXAM_ROLES[role]
      if (skills === undefined) throw new Error(`spawn_subagents: unknown role '${role}': ${Object.keys(EXAM_ROLES).join(', ')}`)
      const want = Number.isFinite(n) ? Math.min(SPAWN_MAX, Math.floor(n)) : 0
      if (want <= 0) {
        say(`spawn_subagents: nobody asked for (${n} is not a swarm)`)
        return 0
      }
      let asked = 0
      let why = ''
      for (let i = 0; i < want; i++) {
        const r = host.ask(skills[i % skills.length]!)
        if (!r.sent) { why = r.message; break }
        asked++
      }
      if (asked === 0) say(`spawn_subagents: 0 of ${want} asked over for ${role}: ${why}`)
      else {
        say(`spawn_subagents: ${asked} of ${want} asked over for ${role} (${skills.slice(0, Math.min(asked, skills.length)).join(', ')}); they answer as they arrive (recruit status)${why ? `; the rest: ${why}` : ''}`)
        host.note('swarm')
      }
      return asked
    },
    unlockCity(seal: number, swarm: number): boolean {
      if (!host.on()) off()
      if (host.stage() === null) {
        say('unlock_city: the city is already yours')
        return true
      }
      const now = live()
      if ((seal >>> 0) === 0 || (seal >>> 0) !== now) {
        say(now === 0 ? `unlock_city: refused, the seal does not hold now (${sealWhy(parts()) ?? 'something does not hold'})` : 'unlock_city: refused, that is not this session’s seal: verify_ring0() gives it')
        return false
      }
      if (!(swarm >= 1)) {
        say('unlock_city: refused, a swarm of 0: nobody came over; stand on the sidewalk near people and run spawn_subagents again')
        return false
      }
      host.note('unlock')
      say('unlock_city: the city is yours')
      return true
    },
    report() {
      const r = report
      report = []
      return r
    },
    status() {
      if (!host.on()) return 'tutorial: the first walk is off this visit (?tutorial=1 starts it)'
      const s = host.stage()
      if (s === null) return 'tutorial: the first walk is passed: the city is yours'
      return `tutorial: the first walk, stage ${STAGES.indexOf(s) + 1} of ${STAGES.length} (${s}); the exit program ends it (tutorial program)`
    },
    program: () => PROGRAM,
  })
}
