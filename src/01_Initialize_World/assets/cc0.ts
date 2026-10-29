// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the CC0 asset gate: the product ships no weapons, so every asset that reaches the
 * page through a loading path (a mesh or texture manifest, a region pack's names, a zone layout's districts) is
 * screened here before it is used. An asset whose name, path, tag or any metadata text contains `gun`, `rifle`,
 * `pistol` or `weapon`, in any case and anywhere in the word, is purged and the purge is logged with the word that
 * caught it. The match is by containment, as the rule says, so `shotgun`, `handgun` and `Weaponry` are caught; the
 * one exception is a short, fixed list of ordinary words that merely contain `gun` (`gunmetal`, `gunwale`, `begun`, `burgundy`,
 * `gunny`), which pass as whole words. Nothing is fetched here and nothing is decoded: this is a filter over names.
 * What breaks if it is removed? A weapon mesh in a manifest, or a weapon word in a generated name, would reach the page.
 */

/** The words no asset may carry, lower case. */
export const FORBIDDEN_WORDS: readonly string[] = Object.freeze(['gun', 'rifle', 'pistol', 'weapon'])

/** Whole words that contain a forbidden word and are not one: they pass. */
export const ALLOWED_WORDS: readonly string[] = Object.freeze(['gunmetal', 'gunwale', 'gunwales', 'begun', 'gunny', 'gunnysack', 'burgundy'])

/** Matches any forbidden word anywhere in the text, in any case. */
export const FORBIDDEN_RE = new RegExp(FORBIDDEN_WORDS.join('|'), 'i')

const WORD_RE = /[\p{L}\p{N}]+/gu

/** The first forbidden word found in `text` (after the allowed words are taken out), or null when it is clean. */
export function forbiddenWordIn(text: string): string | null {
  if (typeof text !== 'string' || !FORBIDDEN_RE.test(text)) return null
  // Drop the allowed whole words, then look again: a text that only had `gunmetal` in it is clean.
  const stripped = text.replace(WORD_RE, (w) => (ALLOWED_WORDS.includes(w.toLowerCase()) ? '' : w))
  const m = FORBIDDEN_RE.exec(stripped)
  return m ? m[0].toLowerCase() : null
}

/** An asset as a loading path describes it: a name, where it comes from, and any text about it. */
export interface AssetRecord {
  name: string
  path?: string
  tags?: readonly string[]
  /** Any other text about the asset (a title, a description, an author field, a licence note). */
  metadata?: Readonly<Record<string, unknown>>
}

export interface Purge { asset: string; field: string; word: string }

export interface Screened<T extends AssetRecord> {
  kept: T[]
  purged: Purge[]
}

/** Every text of an asset, by field name, metadata flattened one level (nested objects are stringified). */
function* texts(a: AssetRecord): Generator<[string, string]> {
  yield ['name', a.name]
  if (a.path) yield ['path', a.path]
  for (const t of a.tags ?? []) yield ['tag', t]
  for (const [k, v] of Object.entries(a.metadata ?? {})) yield [`metadata.${k}`, typeof v === 'string' ? v : JSON.stringify(v) ?? '']
}

/** Whether one asset passes, or the field and word that fail it. */
export function screenAsset(a: AssetRecord): Purge | null {
  for (const [field, text] of texts(a)) {
    const word = forbiddenWordIn(text)
    if (word) return { asset: a.name, field, word }
  }
  return null
}

/**
 * Screens a list of assets: the clean ones are kept in order, the rest purged, each purge logged once through `log`
 * (the console's warning by default) as "cc0: purged <asset> (<field> contains "<word>")".
 */
export function screenAssets<T extends AssetRecord>(assets: readonly T[], log: (line: string) => void = (line) => console.warn(line)): Screened<T> {
  const kept: T[] = [], purged: Purge[] = []
  for (const a of assets) {
    const p = screenAsset(a)
    if (p) { purged.push(p); log(purgeLine(p)) } else kept.push(a)
  }
  return { kept, purged }
}

export const purgeLine = (p: Purge): string => `cc0: purged ${JSON.stringify(p.asset)} (${p.field} contains "${p.word}")`

/**
 * Screens every name a region pack carries (the region's, its streets' and water bodies', its attribution lines): a
 * generated or compiled world must not name anything after a weapon either. Returns the offending names.
 */
export function screenNames(names: Iterable<string>, where: string, log: (line: string) => void = (line) => console.warn(line)): Purge[] {
  const purged: Purge[] = []
  for (const n of names) {
    const word = forbiddenWordIn(n)
    if (word) { const p = { asset: n, field: where, word }; purged.push(p); log(purgeLine(p)) }
  }
  return purged
}
