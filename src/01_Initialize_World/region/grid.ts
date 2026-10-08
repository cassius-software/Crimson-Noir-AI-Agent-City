// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The one grid every region of the map shares (region/projection.ts), so regions compiled
 * separately line up edge to edge: a transverse Mercator whose central meridian and origin sit at the middle of the
 * modelled area's downtown, true to scale there. Only numbers: no place is named.
 * What breaks if it is removed? Each region would need its own frame, and two regions could not meet.
 */
import type { Grid } from './projection.ts'

export const REGION_GRID: Grid = Object.freeze({ lon0: -79.4, lat0: 43.65, k0: 1 })
