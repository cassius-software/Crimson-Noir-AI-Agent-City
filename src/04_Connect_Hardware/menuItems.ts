// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one list of the keyboard's one-key actions that a phone's touch Menu
 * (TouchControls.tsx MenuSheet) and a pad's menu (07_Execute_Actions/PadMenu.tsx) both draw, so the two never drift
 * apart: the console, the model file, the clock, ghost view, rain mode, the microphone, the headset, high contrast,
 * the text size and the HUD.
 * What breaks if it is removed? Both menus lose their items.
 */
import type { Input } from './input.ts'
import type { TouchMenuHost } from './TouchControls.tsx'

/**
 * One of the Menu's items. `id` keys an item whose label changes as it is pressed (the text size), so React keeps the
 * same button, with its focus and the scan's place, instead of mounting a new one each press. `keep` leaves the menu
 * open after it (another hour on the clock); `gesture` marks an item the browser only allows inside a person's own
 * press (a file picker, a headset session), which a pad's button is not (the pad's menu, PadMenu.tsx, says so).
 */
export interface MenuItem { label: string; id?: string; on?: boolean; run: () => void; keep?: boolean; gesture?: boolean }

/**
 * The Menu's items: the keyboard's one-key actions, for a phone's touch Menu and a pad's menu (PadMenu.tsx) alike, so
 * the two never drift apart. Each runs its action at once; neither engages the touch controls (the touch sheet does
 * that itself, for its own taps).
 */
export function menuItems(host: TouchMenuHost, input: Pick<Input, 'press'>): MenuItem[] {
  return [
    { label: 'Console', run: host.onConsole },
    ...(host.onModelFile ? [{ label: 'Model file', run: host.onModelFile, gesture: true }] : []),
    { label: 'Clock −1 h', run: () => input.press('timeBack'), keep: true },
    { label: 'Clock +1 h', run: () => input.press('timeForward'), keep: true },
    { label: 'Ghost view', on: host.ghost, run: () => input.press('ghost') },
    { label: 'Rain mode', on: host.rain, run: () => input.press('matrix') },
    // The microphone: the same press as V and the right stick's click (the engine hands it to the host's switch).
    { label: 'Microphone', on: host.mic === true, run: () => input.press('mute') },
    ...(host.onHeadset ? [{ label: 'Headset', on: host.headset === true, run: host.onHeadset, gesture: true }] : []),
    // Accessibility (access.ts): the two settings most wanted on a phone; the rest is the console's `access`.
    ...(host.onContrast ? [{ label: 'High contrast', on: host.contrast === true, run: host.onContrast }] : []),
    ...(host.onTextScale ? [{ label: `Text size ${host.textScale ?? 100} %`, id: 'text-size', run: host.onTextScale, keep: true }] : []),
    { label: host.hudVisible ? 'Hide HUD' : 'Show HUD', run: host.onHud },
  ]
}
