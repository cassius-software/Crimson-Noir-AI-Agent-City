// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
// Why does this file exist? TypeScript's DOM lib types the WebGPU interfaces but not the flag
// namespaces browsers expose as globals; the raw compute passes need them.
// What breaks if it is removed? `tsc` rejects every GPUBufferUsage / GPUMapMode reference.

declare const GPUBufferUsage: {
  readonly MAP_READ: 0x0001
  readonly MAP_WRITE: 0x0002
  readonly COPY_SRC: 0x0004
  readonly COPY_DST: 0x0008
  readonly INDEX: 0x0010
  readonly VERTEX: 0x0020
  readonly UNIFORM: 0x0040
  readonly STORAGE: 0x0080
  readonly INDIRECT: 0x0100
  readonly QUERY_RESOLVE: 0x0200
}

declare const GPUMapMode: {
  readonly READ: 0x0001
  readonly WRITE: 0x0002
}
