// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The type of the embedded in-page model runtime (vite.config.ts wllamaRuntime): wllama's
 * WebAssembly module, pinned under third_party/wllama/<version>/, as the base64 of its gzip, with the raw module's
 * sha256 and length (what the adapter checks after it gunzips) and the pinned version. Only the adapter imports it,
 * dynamically.
 * What breaks if it is removed? The adapter's import of it does not type-check.
 */
declare module 'virtual:wllama-runtime' {
  /** The pinned wllama version, e.g. "3.8.1". */
  export const version: string
  /** The sha256 of the raw module, lowercase hex. */
  export const sha256: string
  /** The raw module's length in bytes. */
  export const bytes: number
  /** The module's gzip, as base64. */
  const gz: string
  export default gz
}
