// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The type of the embedded region (vite.config.ts regionPack): the region pack's gzipped
 * bytes as base64, carried by every build, and whether the page opens on it (the pilot build) or on the procedural
 * city until the URL asks for it (?region=on).
 * What breaks if it is removed? App.tsx's import of it does not type-check.
 */
declare module 'virtual:region-pack' {
  export const regionFirst: boolean
  const pack: string
  export default pack
}
