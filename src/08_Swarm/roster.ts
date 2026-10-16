// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the roster of the agents the player makes their own: a name, pronouns, a role (what
 * they are for, in the player's words), a voice (one of the twelve voice profiles the page can shape a voice with, or
 * a voice name the chosen speech provider knows), a look out of the crowd's wardrobe (03_Spawn_Agents/look.ts), and,
 * once hired, which pedestrian row they are: hiring asks someone nearby with a skill over (08_Swarm/recruitment.ts) and
 * dresses them in the roster's look. A hire lasts while that person stays with the operator (App releases it when the
 * recruiter's list no longer has them) and never past the visit: the binding is not kept, since a new page has a new
 * physics worker and no tether. Everything typed into a roster record is held to what the page can show (a name as
 * profile.ts keeps it, one word, admissible under the 14A screen like the role; a role one line long; a voice name one
 * word long; a look the wardrobe validates), and the roster is kept in local storage under its own key, at most
 * ROSTER_MAX records. `identityLine` is what a prompt is told about a
 * hired agent (08_Swarm/shortTerm.ts carries it with the here and now). Pure: no DOM, no engine, no clock.
 * What breaks if it is removed? Agents are numbers with skills: nothing can be named, given a voice or dressed to be
 * found again, and the Customizer's second tab and the console's `agent` command have no record to edit.
 */
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { formatLookCode, parseLookCode, validateLook, type Look } from '../03_Spawn_Agents/look.ts'
import { NAME_MAX, sanitizeName } from '../05_Observe_Environment/profile.ts'
import type { AgentBridge } from '../07_Execute_Actions/terminal/bridge.ts'

/** At most this many agents on the roster: the swarm is a few people the player knows, not a crowd. */
export const ROSTER_MAX = 12
/** A role is one line, at most this long. */
export const ROLE_MAX = 48
/** Where the roster is kept between visits (keyed by the package id, like the profile). */
export const ROSTER_KEY = 'civic-simulation:roster:v1'

export const PRONOUNS = ['they/them', 'she/her', 'he/him', 'any'] as const
export type Pronouns = (typeof PRONOUNS)[number]

/**
 * A voice profile: how the page shapes a voice it synthesises itself (the browser's own offline voices, by pitch and
 * rate: 1 is the voice as it comes) and the character the operator's speech provider is told nothing about (a provider
 * voice is named instead). Twelve, as the directive asked: six that lean neither way, three lighter, three deeper.
 * Sloane's is `velvet`.
 */
export interface VoiceProfile {
  readonly name: string
  readonly pitch: number
  readonly rate: number
  readonly blurb: string
}
export const VOICE_PROFILES: readonly VoiceProfile[] = Object.freeze([
  { name: 'velvet', pitch: 0.9, rate: 0.95, blurb: 'smooth and unhurried; Sloane\'s own' },
  { name: 'even', pitch: 1, rate: 1, blurb: 'level, plain' },
  { name: 'quick', pitch: 1, rate: 1.12, blurb: 'brisk, to the point' },
  { name: 'calm', pitch: 0.95, rate: 0.88, blurb: 'slow and settled' },
  { name: 'dry', pitch: 0.92, rate: 1.04, blurb: 'flat, a little wry' },
  { name: 'warm', pitch: 1.05, rate: 0.96, blurb: 'soft, friendly' },
  { name: 'bright', pitch: 1.2, rate: 1.06, blurb: 'lighter, lively' },
  { name: 'clear', pitch: 1.15, rate: 1, blurb: 'lighter, precise' },
  { name: 'light', pitch: 1.25, rate: 0.98, blurb: 'lighter, gentle' },
  { name: 'deep', pitch: 0.78, rate: 0.95, blurb: 'deeper, steady' },
  { name: 'low', pitch: 0.72, rate: 0.9, blurb: 'deeper, slow' },
  { name: 'gravel', pitch: 0.8, rate: 1.02, blurb: 'deeper, rough-edged' },
].map((p) => Object.freeze(p)))
/** Sloane's own voice profile. */
export const CONCIERGE_PROFILE = 'velvet'

/** The profile of that name, or null (a voice name the provider knows is not a profile). */
export const voiceProfile = (name: string): VoiceProfile | null => VOICE_PROFILES.find((p) => p.name === name.trim().toLowerCase()) ?? null

/** One agent of the player's own. */
export interface AgentIdentity {
  readonly name: string
  readonly pronouns: Pronouns
  /** What they are for, in the player's words ('' until given). */
  readonly role: string
  /** A voice profile's name, or a provider voice's name. */
  readonly voice: string
  /** Their look, or null for the look the hash gives the body hired. */
  readonly look: Look | null
  /** The pedestrian row hired as them, or null before the hire. */
  readonly agent: number | null
}

export const isPronouns = (v: unknown): v is Pronouns => typeof v === 'string' && (PRONOUNS as readonly string[]).includes(v)

/** A role as it is kept: one line, trimmed, at most ROLE_MAX, admissible under the 14A screen; '' for nothing usable. */
export function sanitizeRole(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const role = raw.replace(/\s+/g, ' ').trim().slice(0, ROLE_MAX).trim()
  if (!role || !screen(role).admissible) return ''
  return role
}

/**
 * An agent's name as it is kept: a name profile.ts would keep, one word (the console's `agent` reads the name as the
 * first word after it), admissible under the 14A screen (it reaches every prompt they answer); '' for nothing usable.
 */
export function sanitizeAgentName(raw: unknown): string {
  const name = sanitizeName(typeof raw === 'string' ? raw : '')
  if (!name || /\s/.test(name) || !screen(name).admissible) return ''
  return name
}

/** A voice as it is kept: one word (a profile's name, or a provider voice name), at most NAME_MAX; '' for nothing usable. */
export function sanitizeVoice(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const v = raw.trim()
  if (!v || /[\s\r\n]/.test(v) || v.length > NAME_MAX) return ''
  return v
}

/**
 * The identity a value is, or null: a name profile.ts would keep, pronouns from PRONOUNS, a role and a voice as kept
 * here, a look the wardrobe validates (or null), an agent row that is a non-negative integer (or null).
 */
export function validateIdentity(raw: unknown): AgentIdentity | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const name = sanitizeAgentName(r.name)
  if (!name) return null
  const pronouns: Pronouns = isPronouns(r.pronouns) ? r.pronouns : 'they/them'
  const role = sanitizeRole(r.role)
  const voice = sanitizeVoice(r.voice) || VOICE_PROFILES[1].name
  const look = r.look === null || r.look === undefined ? null : validateLook(r.look)
  if (r.look !== null && r.look !== undefined && look === null) return null
  const agent = typeof r.agent === 'number' && Number.isInteger(r.agent) && r.agent > 0 ? r.agent : null
  return Object.freeze({ name, pronouns, role, voice, look, agent })
}

/** A fresh identity with a name and the defaults (they/them, no role, the plain voice, the hash's look, not hired). */
export function newIdentity(name: string): AgentIdentity | null {
  return validateIdentity({ name, pronouns: 'they/them', role: '', voice: VOICE_PROFILES[1].name, look: null, agent: null })
}

const NAME_RULE = (raw: unknown): string => `not a name the city can keep: '${String(raw)}' (one word, business-casual)`

export interface KeyStore { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

function browserStore(): KeyStore | null {
  try { return (globalThis as { localStorage?: KeyStore }).localStorage ?? null } catch { return null }
}

/** The roster read back: only valid records, names unique (first wins, case-insensitively), at most ROSTER_MAX, none hired. */
export function loadRoster(store: KeyStore | null = browserStore()): AgentIdentity[] {
  if (!store) return []
  let raw: string | null
  try { raw = store.getItem(ROSTER_KEY) } catch { return [] }
  if (typeof raw !== 'string' || !raw || raw.length > 64 * 1024) return []
  try {
    const d = JSON.parse(raw) as { v?: unknown; agents?: unknown }
    if (!d || typeof d !== 'object' || d.v !== 1 || !Array.isArray(d.agents)) return []
    const out: AgentIdentity[] = []
    const seen = new Set<string>()
    for (const a of d.agents) {
      const id = validateIdentity(a)
      if (!id || seen.has(id.name.toLowerCase())) continue
      seen.add(id.name.toLowerCase())
      out.push(id.agent === null ? id : Object.freeze({ ...id, agent: null }))
      if (out.length === ROSTER_MAX) break
    }
    return out
  } catch { return [] }
}

export function saveRoster(agents: readonly AgentIdentity[], store: KeyStore | null = browserStore()): void {
  if (!store) return
  // A hire is this visit's alone: the next page has no tether to the same person.
  try { store.setItem(ROSTER_KEY, JSON.stringify({ v: 1, agents: agents.map((a) => ({ ...a, agent: null })) })) } catch { /* storage unavailable */ }
}

/** What a prompt is told about a hired agent: who they go by and what they are for. */
export function identityLine(id: AgentIdentity): string {
  const who = id.pronouns === 'any' ? id.name : `${id.name} (${id.pronouns})`
  return id.role ? `You go by ${who}, ${id.role}.` : `You go by ${who}.`
}

/** The console's view of one record. */
export function describeIdentity(id: AgentIdentity): string[] {
  return [
    `${id.name}  ${id.pronouns}${id.role ? `  ${id.role}` : ''}`,
    `  voice  ${id.voice}${voiceProfile(id.voice) ? ` (profile: ${voiceProfile(id.voice)!.blurb})` : ' (a voice the speech provider knows)'}`,
    `  look   ${id.look ? formatLookCode(id.look) : 'as the hash dresses them'}`,
    `  hired  ${id.agent === null ? 'not yet: agent hire <name> [<skill>]' : `pedestrian ${id.agent}`}`,
  ]
}

/** What the roster's console bridge needs of the page: the recruiter, and the wardrobe on a pedestrian. */
export interface RosterHost {
  /** Asks someone nearby with `skill` over; `agent` is their pedestrian row when they come. */
  recruit(skill: string): Promise<{ ok: boolean; message: string; agent?: number }>
  /** Dresses pedestrian `agent` in `look` (null: the hash's); false when the city has stopped or there is no such row. */
  wear(agent: number, look: Look | null): boolean
  /** The swarm's skills, for the hire's default and its usage line. */
  skills(): readonly string[]
}

/** The console's `agent` command over a roster (terminal/bridge.ts AgentBridge). */
export function agentBridge(roster: Roster, host: RosterHost): AgentBridge {
  const hiredLines = (id: AgentIdentity): string[] => describeIdentity(id)
  return Object.freeze({
    list: (): string[] => {
      const all = roster.list()
      if (!all.length) return ['no agents on the roster yet: agent new <name> adds one (at most 12)']
      return all.flatMap(hiredLines)
    },
    add: (name: string): string[] => hiredLines(roster.add(name)),
    set: (name: string, field: 'pronouns' | 'role' | 'voice' | 'look' | 'name', value: string): string[] => {
      const id = roster.set(name, field, value)
      // A hired agent's new look is worn at once.
      if (field === 'look' && id.agent !== null) host.wear(id.agent, id.look)
      return hiredLines(id)
    },
    hire: async (name: string, skill: string): Promise<string> => {
      const id = roster.get(name)
      if (!id) throw new Error(`no agent called '${String(name)}' on the roster: agent new <name> adds one`)
      if (id.agent !== null) return `${id.name} is already hired as pedestrian ${id.agent} (agent dismiss ${id.name} lets them go)`
      const o = await host.recruit(skill)
      if (!o.ok || o.agent === undefined) return o.message
      const hired = roster.bind(id.name, o.agent)
      // Always dressed as this record says (null: the city's own look), whatever another record had them wear.
      host.wear(o.agent, hired.look)
      return `${hired.name} is on the way: ${o.message}`
    },
    dismiss: (name: string): string => {
      const id = roster.get(name)
      if (!id) throw new Error(`no agent called '${String(name)}' on the roster`)
      if (id.agent === null) return `${id.name} is not hired`
      host.wear(id.agent, null)
      roster.bind(id.name, null)
      return `${id.name} let go (pedestrian ${id.agent} keeps walking; recruit dismiss breaks the tether)`
    },
    forget: (name: string): string => {
      const gone = roster.remove(name)
      if (gone.agent !== null) host.wear(gone.agent, null)
      return `${gone.name} forgotten`
    },
    voices: (): string[] => VOICE_PROFILES.map((p) => `${p.name.padEnd(8)}${p.blurb}`),
  })
}

/**
 * The roster as the page uses it: records by name (case-insensitive), added, changed slot by slot, bound to a
 * pedestrian on hire, let go, removed; every change kept in `store`. The list handed out is a copy.
 */
export class Roster {
  #agents: AgentIdentity[]
  readonly #store: KeyStore | null
  readonly #listeners = new Set<() => void>()

  constructor(store: KeyStore | null = browserStore()) {
    this.#store = store
    this.#agents = loadRoster(store)
  }

  list(): readonly AgentIdentity[] { return [...this.#agents] }
  get(name: string): AgentIdentity | null {
    const key = sanitizeName(name).toLowerCase()
    return this.#agents.find((a) => a.name.toLowerCase() === key) ?? null
  }
  /** The record hired as pedestrian `agent`, or null. */
  byAgent(agent: number): AgentIdentity | null { return this.#agents.find((a) => a.agent === agent) ?? null }

  /** Told of every change. Returns the unsubscribe. */
  onChange(fn: () => void): () => void {
    this.#listeners.add(fn)
    return () => { this.#listeners.delete(fn) }
  }

  /** Adds a new agent by name; throws when the name is not usable, taken, or the roster is full. */
  add(name: string): AgentIdentity {
    const id = newIdentity(name)
    if (!id) throw new Error(NAME_RULE(name))
    const taken = this.get(id.name)
    if (taken) throw new Error(`there is already an agent called ${taken.name}`)
    if (this.#agents.length >= ROSTER_MAX) throw new Error(`the roster is full (${ROSTER_MAX} agents): agent forget <name> frees a place`)
    this.#agents.push(id)
    this.#keep()
    return id
  }

  /** Changes one field of `name`'s record; throws when the value is not usable. */
  set(name: string, field: 'pronouns' | 'role' | 'voice' | 'look' | 'name', value: unknown): AgentIdentity {
    const i = this.#index(name)
    const was = this.#agents[i]
    let next: AgentIdentity | null
    switch (field) {
      case 'pronouns':
        if (!isPronouns(value)) throw new Error(`pronouns are one of ${PRONOUNS.join(', ')}`)
        next = { ...was, pronouns: value }
        break
      case 'role': {
        const role = sanitizeRole(value)
        if (!role && typeof value === 'string' && value.trim()) throw new Error('a role is one plain line, at most 48 characters, and kept business-casual')
        next = { ...was, role }
        break
      }
      case 'voice': {
        const voice = sanitizeVoice(value)
        if (!voice) throw new Error(`a voice is one word: a profile (${VOICE_PROFILES.map((p) => p.name).join(', ')}) or a voice the speech provider lists`)
        next = { ...was, voice }
        break
      }
      case 'look': {
        const look = value === null || value === 'none' || value === 'hash' ? null : typeof value === 'string' ? parseLookCode(value) : validateLook(value)
        if (look === null && value !== null && value !== 'none' && value !== 'hash') throw new Error('not a look code from this wardrobe')
        next = { ...was, look }
        break
      }
      case 'name': {
        const fresh = sanitizeAgentName(value)
        if (!fresh) throw new Error(NAME_RULE(value))
        const taken = this.get(fresh)
        if (taken && taken !== was) throw new Error(`there is already an agent called ${taken.name}`)
        next = { ...was, name: fresh }
        break
      }
    }
    const id = validateIdentity(next)
    if (!id) throw new Error('that change leaves the record unusable')
    this.#agents[i] = id
    this.#keep()
    return id
  }

  /** Binds `name` to pedestrian `agent` (null: let go). */
  bind(name: string, agent: number | null): AgentIdentity {
    const i = this.#index(name)
    if (agent !== null && !(Number.isInteger(agent) && agent > 0)) throw new Error(`not a pedestrian's number: ${String(agent)}`)
    // One body per record: another record already hired as that pedestrian lets them go.
    if (agent !== null) this.#agents = this.#agents.map((a) => (a.agent === agent ? Object.freeze({ ...a, agent: null }) : a))
    this.#agents[i] = Object.freeze({ ...this.#agents[i], agent })
    this.#keep()
    return this.#agents[i]
  }

  /**
   * Lets go every record hired as a pedestrian not in `present` (the recruiter's list: they left, or were dismissed).
   * Returns the pedestrian rows let go; nothing is saved or told when nobody was.
   */
  keepOnly(present: Iterable<number>): number[] {
    const here = new Set(present)
    const gone: number[] = []
    this.#agents = this.#agents.map((a) => {
      if (a.agent === null || here.has(a.agent)) return a
      gone.push(a.agent)
      return Object.freeze({ ...a, agent: null })
    })
    if (gone.length) this.#keep()
    return gone
  }

  remove(name: string): AgentIdentity {
    const i = this.#index(name)
    const [gone] = this.#agents.splice(i, 1)
    this.#keep()
    return gone
  }

  #index(name: string): number {
    const key = sanitizeName(name).toLowerCase()
    const i = this.#agents.findIndex((a) => a.name.toLowerCase() === key)
    if (i < 0) throw new Error(`no agent called '${String(name)}' on the roster: agent new <name> adds one`)
    return i
  }

  #keep(): void {
    saveRoster(this.#agents, this.#store)
    for (const fn of this.#listeners) fn()
  }
}
