// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the wardrobe's card (Track A of the character customizer): the player's own look,
 * slot by slot, out of the crowd's closed business-casual catalogue (03_Spawn_Agents/look.ts). Every slot is a row of
 * the options look.ts allows for the body chosen — named options as a segmented control, colours as swatches drawn
 * from the crowd's own palettes — with the eight presets, a "randomise" that asks lookFromSeed for the look the hash
 * would give some other number, a reset to the look the visitor's own seed gives, and the short shareable code
 * (formatLookCode / parseLookCode, checksummed) to write down or paste. Every change is worn at once: the host writes
 * it to the player's body (engine.setLook) and keeps it (lookStore.ts). There is no mirror by design: the first-person
 * eye never sees its own body, so the card previews with swatches alone; the shadow, the body the cull draws and every
 * other viewer see the look. Wren's chip opens it; Esc, the close button or Done puts it away.
 * What breaks if it is removed? The player can only change their look by typing at the console, and nothing shows
 * them what the wardrobe holds.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import {
  LOOK_PRESETS, LOOK_SLOTS, formatLookCode, lookFromSeed, lookOptions, lookSwatch, parseLookCode, withLookSlot,
  type Look, type LookBody, type LookSlot,
} from '../03_Spawn_Agents/look.ts'

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

export function Customizer({ visible, look, seed, onChange, onClose, dark = false }: CustomizerProps) {
  const cardRef = useRef<HTMLElement>(null)
  /** A code being typed to wear, and why the last one was refused. */
  const [code, setCode] = useState('')
  const [refused, setRefused] = useState(false)
  /** The code last copied to the clipboard: "Copied" shows while the look is still that one. */
  const [copied, setCopied] = useState('')

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

  const glass = dark
    ? 'border-white/10 bg-slate-900/70 text-slate-50 shadow-[0_20px_60px_rgba(0,0,0,0.45)]'
    : 'border-white/70 bg-white/80 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.28)]'
  const muted = dark ? 'text-slate-300/80' : 'text-slate-500'
  const rule = dark ? 'border-white/10' : 'border-slate-900/10'
  const pill = dark ? 'border-white/15 bg-white/10 hover:bg-white/20' : 'border-slate-900/15 bg-white/60 hover:bg-white'
  const pillOn = dark ? 'border-white bg-white text-slate-900' : 'border-slate-900 bg-slate-900 text-white'
  const ring = dark ? 'ring-white' : 'ring-slate-900'
  const field = dark
    ? 'border-white/15 bg-slate-950/40 text-slate-50 placeholder:text-slate-400 focus:border-white/40'
    : 'border-slate-900/15 bg-white/85 text-slate-900 placeholder:text-slate-400 focus:border-slate-900/40'
  const primary = dark ? 'bg-white text-slate-900' : 'bg-slate-900 text-white'

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
  const hex6 = (n: number) => `#${n.toString(16).padStart(6, '0')}`

  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center p-4 font-sans text-[13px] antialiased">
      <aside
        ref={cardRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="false"
        aria-label="Your look"
        data-customizer={body}
        className={`pointer-events-auto flex max-h-full w-[min(36rem,100%)] flex-col rounded-3xl border backdrop-blur-2xl backdrop-saturate-150 ${glass} outline-none`}
      >
        <div className="flex items-start gap-3 px-5 pt-4">
          <div className="min-w-0 flex-1">
            <div className="text-base font-semibold leading-tight">Your look</div>
            <p className={`mt-1 text-[12px] leading-snug ${muted}`}>
              Everything here is what the city already wears. Each change is worn at once: your eye never sees itself,
              but your shadow and everyone else do.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={`shrink-0 rounded-full border px-2.5 py-1 text-[12px] ${pill}`}>×</button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-2">
          <div className={`mt-3 flex flex-wrap gap-1.5`} data-row="presets">
            {LOOK_PRESETS.map((p) => (
              <button
                key={p.name}
                type="button"
                onClick={() => onChange(p.look)}
                className={`rounded-full border px-2.5 py-1 text-[12px] capitalize ${formatLookCode(p.look) === code6 ? pillOn : pill}`}
              >
                {p.name}
              </button>
            ))}
            <button type="button" onClick={() => onChange(lookFromSeed(randomSeed()))} className={`rounded-full border px-2.5 py-1 text-[12px] ${pill}`} data-action="randomise">
              Randomise
            </button>
            <button type="button" onClick={() => onChange(lookFromSeed(seed))} className={`rounded-full border px-2.5 py-1 text-[12px] ${pill}`} data-action="reset">
              Reset
            </button>
          </div>

          <div className={`mt-3 border-t pt-3 ${rule}`}>
            {LOOK_SLOTS.map((slot) => {
              const options = lookOptions(body, slot)
              const current = worn[slot]
              return (
                <div key={slot} className="mb-2 flex items-start gap-3" data-slot={slot}>
                  <div className={`w-20 shrink-0 pt-1 text-[11px] font-semibold tracking-wider uppercase ${muted}`}>{slotLabel(slot, body)}</div>
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
                            className={`h-6 w-6 rounded-full border border-black/20 ${on ? `ring-2 ring-offset-1 ${ring}` : ''}`}
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
                          className={`rounded-full border px-2.5 py-0.5 text-[12px] capitalize ${on ? pillOn : pill}`}
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

          <div className={`mt-2 border-t pt-3 ${rule}`} data-row="code">
            <div className="flex flex-wrap items-center gap-2">
              <span className={`text-[11px] font-semibold tracking-wider uppercase ${muted}`}>Code</span>
              <code className="rounded-md border border-current/15 px-2 py-0.5 font-mono text-[12px]" data-look-code>{code6}</code>
              <button type="button" onClick={copy} className={`rounded-full border px-2.5 py-0.5 text-[12px] ${pill}`}>{copied === code6 ? 'Copied' : 'Copy'}</button>
              <form onSubmit={wearCode} className="flex min-w-0 items-center gap-1.5">
                <input
                  value={code}
                  onChange={(e) => { setCode(e.target.value); setRefused(false) }}
                  placeholder="Paste a code"
                  aria-label="A look code to wear"
                  aria-invalid={refused || undefined}
                  spellCheck={false}
                  autoComplete="off"
                  className={`w-32 rounded-md border px-2 py-0.5 font-mono text-[12px] outline-none ${field}`}
                />
                <button type="submit" className={`rounded-full border px-2.5 py-0.5 text-[12px] ${pill}`}>Wear</button>
              </form>
            </div>
            {refused && <p className={`mt-1 text-[11px] ${muted}`} role="alert">That is not a look code from this wardrobe.</p>}
          </div>
        </div>

        <div className={`flex justify-end border-t px-5 py-3 ${rule}`}>
          <button type="button" onClick={onClose} className={`rounded-full px-3.5 py-1.5 text-[12px] font-semibold ${primary}`} data-action="done">Done</button>
        </div>
      </aside>
    </div>
  )
}
