// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place the map builder's worker is instantiated (Vite bundles the `?worker&inline`
 * import into the single file), kept apart from californiaClient.ts so that tests, which have no bundler, import the
 * client alone. Without workers (an odd embedding) the inline port stands in.
 * What breaks if it is removed? The page builds the map on its own thread.
 */
import CaliforniaWorker from './california.worker.ts?worker&inline'
import { inlinePort, type BuilderPort } from './californiaClient.ts'

/** A port to the builder: a worker where the page has them, the inline builder otherwise. */
export function builderPort(): BuilderPort {
  if (typeof Worker !== 'function') return inlinePort()
  try {
    return new CaliforniaWorker({ name: 'california' }) as unknown as BuilderPort
  } catch {
    return inlinePort()
  }
}
