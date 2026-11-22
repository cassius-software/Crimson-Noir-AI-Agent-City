// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The conversation panel's text field (TalkLayer.tsx Conversation) keeps four rules that a
 * React render cannot keep by itself, so they live here, with no DOM and no React, where Node can test them.
 * - FieldDraft: the field's text as the controller (talk.ts setDraft) must hear it. React's state lags a render behind,
 *   and the blur that lets go of the keyboard after a sent line fires inside the send handler, so a blur reading that
 *   state told the controller the line just sent was still in the field: the conversation was never idle again. The
 *   latest text is kept here at once, a sent line empties it before the field lets go, and every report reads it.
 * - mayFocus: a focus request (T, or a pad with the microphone shut) takes the keyboard unless another text field holds
 *   it. A focused button gives it up: most browsers leave a clicked button focused, and the letters typed for the
 *   person would otherwise reach the city's keys (G for ghost view, E into a car).
 * - escapeAction: Esc that reaches the page, from anywhere but a text field, finishes the conversation (clearing a draft
 *   first, as Esc in the field does), so the Esc on the Done button still holds once the field has let go.
 * - RepeatGate: the auto-repeats of a key already held down when the field took the keyboard type nothing, so T held a
 *   moment too long does not fill the field with t's.
 * What breaks if it is removed? The panel has nothing to keep these rules with: a conversation that never closes for
 * being idle after a typed line, a T that leaves the keyboard on a button, an Esc that does nothing after a sent line,
 * or a field that fills with the key that opened it.
 */
import { isEditableTarget } from '../04_Connect_Hardware/input.ts'

/** Who hears the field's text and focus (talk.ts TalkController.setDraft). */
export interface DraftSink {
  setDraft(text: string, focused: boolean): void
}

/** The field's text as the controller hears it, kept the moment it changes, never a render late. */
export class FieldDraft {
  #text = ''
  readonly #sink: DraftSink

  constructor(sink: DraftSink) {
    this.#sink = sink
  }

  /** What the field holds now. */
  get text(): string {
    return this.#text
  }

  /** Typed into, or cleared by Esc: heard with the field focused. */
  type(text: string): void {
    this.#text = text
    this.#sink.setDraft(text, true)
  }

  /** The field took the keyboard. */
  focus(): void {
    this.#sink.setDraft(this.#text, true)
  }

  /** The field let go of the keyboard. */
  blur(): void {
    this.#sink.setDraft(this.#text, false)
  }

  /**
   * A line was sent: the field is empty from now on, before `letGo` runs (on a keyboard it blurs the field, and that
   * blur, fired at once, must read an empty field), and the controller then hears it empty, focused or not as
   * `focused` says once that is done.
   */
  sent(letGo: () => void, focused: () => boolean): void {
    this.#text = ''
    letGo()
    this.#sink.setDraft('', focused())
  }
}

/**
 * Whether a focus request may move the keyboard into the field: always, unless another text field has it (a field
 * inside the panel, `inPanel`, does not count). The page, the canvas and any focused button give it up.
 */
export function mayFocus(active: Element | null, inPanel: (el: Element) => boolean): boolean {
  return active === null || !isEditableTarget(active) || inPanel(active)
}

/** A key event as escapeAction reads it (a DOM KeyboardEvent is one). */
export interface EscapeKey {
  readonly key: string
  readonly defaultPrevented: boolean
  readonly isComposing?: boolean
  readonly target: EventTarget | null
}

/**
 * What Esc does when it reaches the page past the field: nothing (null) when it is not Esc, was already handled, is
 * an input method's, or came from a text field (the panel's own field handles its Esc itself and stops it); else it
 * clears a draft, and with none it ends the conversation.
 */
export function escapeAction(e: EscapeKey, draft: string): 'clear' | 'end' | null {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing === true || isEditableTarget(e.target)) return null
  return draft ? 'clear' : 'end'
}

/**
 * Drops the auto-repeats of a key already held when the field took the keyboard by a focus request. A fresh press
 * (any key down that is not a repeat) lets repeats through again, so a key held while typing still repeats.
 */
export class RepeatGate {
  #held = false

  /** The field took the keyboard by a focus request: a key held now is the one that asked. */
  focused(): void {
    this.#held = true
  }

  /** A key down in the field: whether it may type. */
  pass(repeat: boolean): boolean {
    if (!repeat) this.#held = false
    return !this.#held
  }
}
