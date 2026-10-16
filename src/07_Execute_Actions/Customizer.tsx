// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the wardrobe's card (Track A of the character customizer), in two tabs. "You": the
 * player's own look, slot by slot, out of the crowd's closed business-casual catalogue (03_Spawn_Agents/look.ts).
 * Every slot is a row of the options look.ts allows for the body chosen — named options as a segmented control,
 * colours as swatches drawn from the crowd's own palettes — with the eight presets, a "randomise" that asks
 * lookFromSeed for the look the hash would give some other number, a reset to the look the visitor's own seed gives,
 * and the short shareable code (formatLookCode / parseLookCode, checksummed) to write down or paste. Every change is
 * worn at once: the host writes it to the player's body (engine.setLook) and keeps it (lookStore.ts). "Agents": the
 * player's own agents (08_Swarm/roster.ts), one tab each: a name, pronouns, a role in the player's words, a voice (one
 * of the twelve profiles, or a voice the speech provider knows), and the same wardrobe for their look, worn by the
 * pedestrian hired as them the moment it changes; hiring itself is the console's (agent hire <name> <skill>), so the
 * card never reaches the swarm. There is no mirror by design: the first-person eye never sees its own body, so the
 * card previews with swatches alone; the shadow, the body the cull draws and every other viewer see the look. Sloane's
 * chip opens it; Esc, the close button or Done puts it away.
 * What breaks if it is removed? The player can only change their look or their agents by typing at the console, and
 * nothing shows them what the wardrobe holds.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  LOOK_PRESETS, LOOK_SLOTS, formatLookCode, lookFromSeed, lookOptions, lookSwatch, parseLookCode, withLookSlot,
  type Look, type LookBody, type LookSlot,
} from '../03_Spawn_Agents/look.ts'
import { seedFromName } from '../05_Observe_Environment/profile.ts'
import { PRONOUNS, ROSTER_MAX, VOICE_PROFILES, voiceProfile, type AgentIdentity, type Roster } from '../08_Swarm/roster.ts'

export interface CustomizerProps {
  /** Show the card (the host passes false while the boot veil covers the page or the terminal is open). */
  visible: boolean
  /** The look worn now, or null while the hash dresses the player (the card then starts from `seed`'s look). */
  look: Look | null
  /** The visitor's own seed (profile.ts): the look it gives is the card's starting point and what Reset returns to. */
  seed: number
  /** Called with every change; the host wears it at once and keeps it. */
  onChange(look: Look): void
  onClose(): void
  /** Optional: the HUD's night glass (snapshot.customer.daylight < 0.35). */
  dark?: boolean
  /** Optional: the player's own agents, and the roster that keeps them (the host re-renders on its changes). */
  agents?: readonly AgentIdentity[]
  roster?: Roster
  /** Optional: an agent's look changed (null: as the hash dresses them); the host wears it on their pedestrian. */
  onAgentLook?(name: string, look: Look | null): void
  /** Optional: say a line in an agent's voice (a profile or a provider voice), for the Hear button. */
  onHear?(voice: string, line: string): void
}

/** What each slot is called on the card, by body where the cloth differs. */
function slotLabel(slot: LookSlot, body: LookBody): string {
  switch (slot) {
    case 'body': return 'Body'
    case 'height': return 'Height'
    case 'build': return 'Build'
    case 'skin': return 'Skin'
    case 'hairStyle': return 'Hair'
    case 'hairColour': return 'Hair colour'
    case 'top': return body === 1 ? 'Blazer' : body === 3 ? 'Top' : 'Jacket'
    case 'bottom': return body === 3 ? 'Skirt' : body === 1 ? 'Chinos' : 'Trousers'
    case 'shirt': return body >= 2 ? 'Blouse' : 'Shirt'
    case 'shoes': return 'Shoes'
    case 'tie': return 'Tie'
    case 'eyewear': return 'Glasses'
    case 'bag': return 'Bag'
    case 'cup': return 'Cup'
  }
}

/** A number for lookFromSeed that nobody chose: a fresh look out of the same wardrobe on every press. */
const randomSeed = (): number => {
  const out = new Uint32Array(1)
  try { crypto.getRandomValues(out) } catch { out[0] = Math.floor(Math.random() * 0x100000000) }
  return out[0]
}

const hex6 = (n: number) => `#${n.toString(16).padStart(6, '0')}`

/** The card's glass, by daylight. */
interface Theme { muted: string; rule: string; pill: string; pillOn: string; ring: string; field: string; primary: string }

function themeOf(dark: boolean): Theme {
  return {
    muted: dark ? 'text-slate-300/80' : 'text-slate-500',
    rule: dark ? 'border-white/10' : 'border-slate-900/10',
    pill: dark ? 'border-white/15 bg-white/10 hover:bg-white/20' : 'border-slate-900/15 bg-white/60 hover:bg-white',
    pillOn: dark ? 'border-white bg-white text-slate-900' : 'border-slate-900 bg-slate-900 text-white',
    ring: dark ? 'ring-white' : 'ring-slate-900',
    field: dark
      ? 'border-white/15 bg-slate-950/40 text-slate-50 placeholder:text-slate-400 focus:border-white/40'
      : 'border-slate-900/15 bg-white/85 text-slate-900 placeholder:text-slate-400 focus:border-slate-900/40',
    primary: dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white',
  }
}

/** The wardrobe itself: presets, the slot rows and the code row, over one look; every change goes out through `onChange`. */
function LookEditor({ worn, seed, onChange, t }: { worn: Look; seed: number; onChange(look: Look): void; t: Theme }) {
  const body = worn.body as LookBody
  /** A code being typed to wear, and why the last one was refused. */
  const [code, setCode] = useState('')
  const [refused, setRefused] = useState(false)
  /** The code last copied to the clipboard: "Copied" shows while the look is still that one. */
  const [copied, setCopied] = useState('')
  const set = (slot: LookSlot, value: number) => {
    const next = withLookSlot(worn, slot, value)
    if (next) onChange(next)
  }
  const wearCode = (e: FormEvent) => {
    e.preventDefault()
    const parsed = parseLookCode(code)
    if (!parsed) { setRefused(true); return }
    setRefused(false)
    setCode('')
    onChange(parsed)
  }
  const code6 = formatLookCode(worn)
  const copy = () => {
    try {
      void navigator.clipboard.writeText(code6).then(() => setCopied(code6), () => setCopied(''))
    } catch {
      setCopied('')
    }
  }
  return (
    <>
      <div className={`mt-3 flex flex-wrap gap-1.5`} data-row="presets">
        {LOOK_PRESETS.map((p) => (
          <button
            key={p.name}
            type="button"
            onClick={() => onChange(p.look)}
            className={`rounded-full border px-2.5 py-1 text-[12px] capitalize ${formatLookCode(p.look) === code6 ? t.pillOn : t.pill}`}
          >
            {p.name}
          </button>
        ))}
        <button type="button" onClick={() => onChange(lookFromSeed(randomSeed()))} className={`rounded-full border px-2.5 py-1 text-[12px] ${t.pill}`} data-action="randomise">
          Randomise
        </button>
        <button type="button" onClick={() => onChange(lookFromSeed(seed))} className={`rounded-full border px-2.5 py-1 text-[12px] ${t.pill}`} data-action="reset">
          Reset
        </button>
      </div>

      <div className={`mt-3 border-t pt-3 ${t.rule}`}>
        {LOOK_SLOTS.map((slot) => {
          const options = lookOptions(body, slot)
          const current = worn[slot]
          return (
            <div key={slot} className="mb-2 flex items-start gap-3" data-slot={slot}>
              <div className={`w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>{slotLabel(slot, body)}</div>
              <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="radiogroup" aria-label={slotLabel(slot, body)}>
                {options.map((o, i) => {
                  const on = i === current
                  // A colour is a swatch; a named option is a pill (the matching trousers' carries the jacket's cloth).
                  const hex = o.hex ?? (slot === 'bottom' && i === 0 && o.name === 'matching' ? lookSwatch(worn, 'top') : null)
                  if (o.hex !== null) {
                    return (
                      <button
                        key={i}
                        type="button"
                        role="radio"
                        aria-checked={on}
                        aria-label={o.name}
                        title={o.name}
                        onClick={() => set(slot, i)}
                        style={{ backgroundColor: hex6(o.hex) }}
                        className={`h-6 w-6 rounded-full border border-black/20 ${on ? `ring-2 ring-offset-1 ${t.ring}` : ''}`}
                      />
                    )
                  }
                  return (
                    <button
                      key={i}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => set(slot, i)}
                      className={`rounded-full border px-2.5 py-0.5 text-[12px] capitalize ${on ? t.pillOn : t.pill}`}
                    >
                      {hex !== null && (
                        <span aria-hidden className="mr-1 inline-block h-2.5 w-2.5 rounded-full border border-black/20 align-middle" style={{ backgroundColor: hex6(hex) }} />
                      )}
                      {o.name}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className={`mt-2 border-t pt-3 ${t.rule}`} data-row="code">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`text-[11px] font-semibold tracking-wider uppercase ${t.muted}`}>Code</span>
          <code className="rounded-md border border-current/15 px-2 py-0.5 font-mono text-[12px]" data-look-code>{code6}</code>
          <button type="button" onClick={copy} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`}>{copied === code6 ? 'Copied' : 'Copy'}</button>
          <form onSubmit={wearCode} className="flex min-w-0 items-center gap-1.5">
            <input
              value={code}
              onChange={(e) => { setCode(e.target.value); setRefused(false) }}
              placeholder="Paste a code"
              aria-label="A look code to wear"
              aria-invalid={refused || undefined}
              spellCheck={false}
              autoComplete="off"
              className={`w-32 rounded-md border px-2 py-0.5 font-mono text-[12px] outline-none ${t.field}`}
            />
            <button type="submit" className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`}>Wear</button>
          </form>
        </div>
        {refused && <p className={`mt-1 text-[11px] ${t.muted}`} role="alert">That is not a look code from this wardrobe.</p>}
      </div>
    </>
  )
}

/** One agent's tab: who they are, how they sound, and their look over the same wardrobe. */
function AgentEditor({ id, roster, onAgentLook, onHear, onForget, t }: { id: AgentIdentity; roster: Roster; onAgentLook?(name: string, look: Look | null): void; onHear?(voice: string, line: string): void; onForget(): void; t: Theme }) {
  const [role, setRole] = useState(id.role)
  const [voiceText, setVoiceText] = useState(voiceProfile(id.voice) ? '' : id.voice)
  const [refused, setRefused] = useState<string | null>(null)
  const seed = id.agent ?? seedFromName(id.name)
  const worn = id.look ?? lookFromSeed(seed)
  const change = (field: 'pronouns' | 'role' | 'voice', value: string) => {
    try { roster.set(id.name, field, value); setRefused(null) } catch (e) { setRefused(e instanceof Error ? e.message : String(e)) }
  }
  const wear = (look: Look | null) => {
    try {
      if (onAgentLook) onAgentLook(id.name, look)
      else roster.set(id.name, 'look', look)
      setRefused(null)
    } catch (e) { setRefused(e instanceof Error ? e.message : String(e)) }
  }
  const label = `text-[11px] font-semibold tracking-wider uppercase ${t.muted}`
  return (
    <div data-agent={id.name}>
      <p className={`mt-2 text-[12px] ${t.muted}`} data-agent-hired={id.agent ?? ''}>
        {id.agent === null
          ? <>Not hired yet. In the console (~): <code className="font-mono">agent hire {id.name} &lt;skill&gt;</code> asks someone nearby over as {id.name}.</>
          : <>Hired as pedestrian {id.agent}: they answer <code className="font-mono">ask</code> and <code className="font-mono">say</code> as {id.name}.</>}
      </p>
      <div className="mt-3 flex items-start gap-3">
        <div className={`w-20 shrink-0 pt-1 ${label}`}>Pronouns</div>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5" role="radiogroup" aria-label="Pronouns">
          {PRONOUNS.map((p) => (
            <button key={p} type="button" role="radio" aria-checked={id.pronouns === p} onClick={() => change('pronouns', p)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${id.pronouns === p ? t.pillOn : t.pill}`}>{p}</button>
          ))}
        </div>
      </div>
      <div className="mt-2 flex items-start gap-3">
        <div className={`w-20 shrink-0 pt-1 ${label}`}>Role</div>
        <input
          value={role}
          onChange={(e) => setRole(e.target.value)}
          onBlur={() => { if (role.trim() !== id.role) change('role', role) }}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); change('role', role) } }}
          maxLength={48}
          placeholder="What they are for, in your words"
          aria-label="Role"
          autoComplete="off"
          className={`min-w-0 flex-1 rounded-md border px-2 py-0.5 text-[12px] outline-none ${t.field}`}
        />
      </div>
      <div className="mt-2 flex items-start gap-3">
        <div className={`w-20 shrink-0 pt-1 ${label}`}>Voice</div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Voice profile">
            {VOICE_PROFILES.map((p) => (
              <button key={p.name} type="button" role="radio" aria-checked={id.voice === p.name} title={p.blurb} onClick={() => change('voice', p.name)} className={`rounded-full border px-2.5 py-0.5 text-[12px] capitalize ${id.voice === p.name ? t.pillOn : t.pill}`}>{p.name}</button>
            ))}
          </div>
          <form onSubmit={(e) => { e.preventDefault(); if (voiceText.trim()) change('voice', voiceText) }} className="flex items-center gap-1.5">
            <input
              value={voiceText}
              onChange={(e) => setVoiceText(e.target.value)}
              placeholder="Or a voice your speech provider lists"
              aria-label="A provider voice"
              spellCheck={false}
              autoComplete="off"
              className={`w-56 max-w-full rounded-md border px-2 py-0.5 text-[12px] outline-none ${t.field}`}
            />
            <button type="submit" className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`}>Use</button>
            {onHear && (
              <button type="button" onClick={() => onHear(id.voice, `Hi, I’m ${id.name}.${id.role ? ` ${id.role[0].toUpperCase()}${id.role.slice(1)}, at your service.` : ''}`)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`} data-action="agent-hear" title="Hear this voice (the city's sound must be on)">Hear</button>
            )}
          </form>
        </div>
      </div>
      {refused && <p className={`mt-2 text-[11px] ${t.muted}`} role="alert">{refused}</p>}
      <div className={`mt-3 flex flex-wrap items-center gap-2 border-t pt-3 ${t.rule}`}>
        <span className={label}>Look</span>
        <button type="button" onClick={() => wear(null)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${id.look === null ? t.pillOn : t.pill}`} data-action="agent-hash">As the city dresses them</button>
        <button type="button" onClick={onForget} className={`ml-auto rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`} data-action="agent-forget">Forget {id.name}</button>
      </div>
      <LookEditor worn={worn} seed={seed} onChange={wear} t={t} />
    </div>
  )
}

export function Customizer({ visible, look, seed, onChange, onClose, dark = false, agents = [], roster, onAgentLook, onHear }: CustomizerProps) {
  const cardRef = useRef<HTMLElement>(null)
  /** Which tab: the player ('you'), or an agent by name. */
  const [tab, setTab] = useState<string>('you')
  const [newName, setNewName] = useState('')
  const [newRefused, setNewRefused] = useState<string | null>(null)

  // Esc puts the card away (captured, so the game's own key handling never sees it while the card has the keyboard).
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose() }
    }
    window.addEventListener('keydown', onKey, true)
    cardRef.current?.focus()
    return () => window.removeEventListener('keydown', onKey, true)
  }, [visible, onClose])

  if (!visible) return null
  const worn = look ?? lookFromSeed(seed)
  const body = worn.body as LookBody
  const t = themeOf(dark)
  const glass = dark
    ? 'border-white/10 bg-slate-900/70 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/80 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const current = tab === 'you' ? null : agents.find((a) => a.name === tab) ?? null
  const showing = current ? 'agent' : 'you'
  const addAgent = (e: FormEvent) => {
    e.preventDefault()
    if (!roster) return
    try {
      const id = roster.add(newName)
      setNewName('')
      setNewRefused(null)
      setTab(id.name)
    } catch (err) {
      setNewRefused(err instanceof Error ? err.message : String(err))
    }
  }
  const forget = (name: string) => {
    if (!roster) return
    try {
      // A hired agent's pedestrian goes back to the look the city gives them before the record goes.
      if (roster.get(name)?.agent != null) onAgentLook?.(name, null)
      roster.remove(name)
    } catch { /* already gone */ }
    setTab('you')
  }

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4 font-sans text-[13px] antialiased">
      <aside
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label={current ? `${current.name}'s look` : 'Your look'}
        data-customizer={body}
        data-customizer-tab={showing}
        className={`pointer-events-auto flex max-h-full w-[min(36rem,100%)] flex-col rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} outline-none`}
      >
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight">{current ? current.name : 'Your look'}</div>
            <p className={`mt-1 text-[12px] leading-snug ${t.muted}`}>
              {current
                ? 'One of your own agents. Everything here is what the city already wears; their look is worn the moment they are hired.'
                : 'Everything here is what the city already wears. Each change is worn at once: your eye never sees itself, but your shadow and everyone else do.'}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] ${t.pill}`}>×</button>
        </div>

        {roster && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5 px-5" role="tablist" aria-label="Who to dress" data-row="tabs">
            <button type="button" role="tab" aria-selected={tab === 'you'} onClick={() => setTab('you')} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${tab === 'you' ? t.pillOn : t.pill}`}>You</button>
            {agents.map((a) => (
              <button key={a.name} type="button" role="tab" aria-selected={tab === a.name} onClick={() => setTab(a.name)} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${tab === a.name ? t.pillOn : t.pill}`} data-agent-tab={a.name}>
                {a.name}
              </button>
            ))}
            {agents.length < ROSTER_MAX && (
              <form onSubmit={addAgent} className="flex items-center gap-1.5">
                <input
                  value={newName}
                  onChange={(e) => { setNewName(e.target.value); setNewRefused(null) }}
                  maxLength={24}
                  placeholder="New agent’s name"
                  aria-label="A new agent’s name"
                  aria-invalid={newRefused !== null || undefined}
                  autoComplete="off"
                  className={`w-36 rounded-md border px-2 py-0.5 text-[12px] outline-none ${t.field}`}
                />
                <button type="submit" className={`rounded-full border px-2.5 py-0.5 text-[12px] ${t.pill}`} data-action="agent-new">Add</button>
              </form>
            )}
          </div>
        )}
        {newRefused && <p className={`mt-1 px-5 text-[11px] ${t.muted}`} role="alert">{newRefused}</p>}

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          {current && roster
            ? <AgentEditor key={current.name} id={current} roster={roster} onAgentLook={onAgentLook} onHear={onHear} onForget={() => forget(current.name)} t={t} />
            : <LookEditor worn={worn} seed={seed} onChange={onChange} t={t} />}
        </div>

        <div className={`flex justify-end border-t px-5 py-3 ${t.rule}`}>
          <button type="button" onClick={onClose} className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold ${t.primary}`} data-action="done">Done</button>
        </div>
      </aside>
    </div>
  )
}
