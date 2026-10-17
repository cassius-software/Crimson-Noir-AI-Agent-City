// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the one place the map builder's worker is instantiated (Vite bundles the `?worker&inline`
 * import into the single file), kept apart from lakefrontClient.ts so that tests, which have no bundler, import the
 * client alone. Without workers (an odd embedding) the inline port stands in.
 * What breaks if it is removed? The page builds the map on its own thread.
 */
import LakefrontWorker from './lakefront.worker.ts?worker&inline'
import { inlinePort, reportingPort, type BuilderPort, type BuilderWorker } from './lakefrontClient.ts'
import { trackWorker } from '../07_Execute_Actions/longTasks.ts'

/** A port to the builder: a worker where the page has them, the inline builder otherwise. */
export function builderPort(): BuilderPort {
  if (typeof Worker !== 'function') return inlinePort()
  try {
    // Its failure as a whole (a script that does not load, an uncaught throw) reaches the client as an error.
    const worker = reportingPort(new LakefrontWorker({ name: 'lakefront' }) as unknown as BuilderWorker)
    // Counted among the live worker threads (longTasks.ts) until the client terminates it.
    const untrack = trackWorker()
    const terminate = worker.terminate.bind(worker)
    worker.terminate = () => { terminate(); untrack() }
    return worker
  } catch {
    return inlinePort()
  }
}
