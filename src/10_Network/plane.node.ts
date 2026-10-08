// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is an Authority (replication.ts) over an open plane: no buildings and no ground but
 * standing height, the walk clamped the way the realm clamps it (simProtocol.ts footWish) and integrated substep by
 * substep, a car taken within the realm's door and bounded by the velocity cap (the plane has no car physics: the
 * claim is kept when a car could have reached it), the same tolerance as the mirror. The core's and the client's
 * tests run the room on it when a test is about the protocol rather than the city, and `planeStep` is the honest
 * client those tests drive. The host always runs the headless Ring-0 mirror (mirror.node.ts), whose own tests prove it
 * against the page's realm.
 * What breaks if it is removed? The protocol's tests would need the whole city to say anything.
 */
import { ENTER_RANGE, footWish, RUN } from '../07_Execute_Actions/simProtocol.ts'
import { LIMITS, type Authority, type CarFix, type FootRun, type InputMessage, type Truth } from './replication.ts'

export const PLANE = Object.freeze({
  /** One substep, s. */
  h: 1 / 60,
  /** Where a body stands on the plane, m (the capsule centre). */
  standing: 0.92,
  /** How far a foot claim may sit from the plane's pose, m. */
  tolerance: 0.25,
  /** How far an exit point may sit from the car, m (the realm puts the driver 2.1 m beside it). */
  reach: 3,
  /** Where peer `id` starts: a metre apart along x. */
  spawnGap: 1,
})

/** An honest client on the plane: `at` walked by `runs` (clamped as the realm clamps), where its claim would be. */
export function planeStep(at: { x: number; z: number }, runs: readonly FootRun[]): { x: number; y: number; z: number } {
  let x = at.x, z = at.z
  for (const [vx, vz, n] of runs) {
    const w = footWish(vx, vz)
    for (let i = 0; i < n; i++) {
      x += w.x * PLANE.h
      z += w.z * PLANE.h
    }
  }
  return { x, y: PLANE.standing, z }
}

/** An open-plane authority; `world` is the name a join must give. */
export function planeAuthority(world = 'plane'): Authority & { readonly bodies: ReadonlyMap<number, Truth> } {
  const bodies = new Map<number, Truth>()
  /** The car each peer drives: its index and state (the chassis where the last claim kept it, at rest). */
  const cars = new Map<number, CarFix>()
  const body = (id: number): Truth => {
    const b = bodies.get(id)
    if (!b) throw new Error(`peer ${id} is not on the plane`)
    return b
  }
  const copy = (b: Truth): Truth => ({ ...b })
  return {
    world,
    bodies,
    join(id) {
      const b: Truth = { x: (id - 1) * PLANE.spawnGap, y: PLANE.standing, z: 0, heading: 0, vx: 0, vz: 0, speed: 0, driving: false }
      bodies.set(id, b)
      return copy(b)
    },
    leave(id) {
      bodies.delete(id)
      cars.delete(id)
    },
    judge(id, input: InputMessage) {
      const b = body(id)
      const refuse = (reason: string) => ({ ok: false as const, pose: copy(b), reason })
      let n = 0
      for (const r of input.segs) n += r[r.length - 1]
      const t = n * PLANE.h
      let x: number, y: number, z: number, start: { x: number; z: number } = b
      const d = input.door
      if (d && 'enter' in d) {
        if (b.driving) return refuse('enter: already at a wheel')
        const s = d.enter.state
        if (Math.hypot(s.x - b.x, s.z - b.z) > ENTER_RANGE) return refuse('enter: out of the door\'s reach')
        start = s
      } else if (d) {
        if (!b.driving) return refuse('exit: not at a wheel')
        if (Math.hypot(d.exit.x - b.x, d.exit.z - b.z) > PLANE.reach) return refuse('exit: out of reach of the car')
        start = d.exit
      } else if (b.driving !== (input.mode === 'drive')) {
        return refuse(b.driving ? 'on foot without leaving the car' : 'at a wheel without taking one')
      }
      if (input.mode === 'foot') {
        const end = planeStep(start, input.segs as FootRun[])
        x = end.x
        y = end.y
        z = end.z
        const off = Math.hypot(input.claim.x - x, input.claim.y - y, input.claim.z - z)
        if (!(off <= PLANE.tolerance)) return refuse(`claim ${off.toFixed(2)} m from the plane's pose`)
      } else {
        const reach = LIMITS.driveSpeed * t + 0.5
        const moved = Math.hypot(input.claim.x - start.x, input.claim.z - start.z)
        if (!(moved <= reach)) return refuse(`a car cannot cover ${moved.toFixed(1)} m in ${n} substeps`)
        ;({ x, y, z } = input.claim)
      }
      if (Math.abs(x) > LIMITS.range || Math.abs(z) > LIMITS.range) return refuse('off the plane')
      const driving = input.mode === 'drive'
      const top = driving ? LIMITS.driveSpeed : RUN
      let vx = t > 0 ? (x - start.x) / t : 0, vz = t > 0 ? (z - start.z) / t : 0
      const speed = Math.hypot(vx, vz)
      if (speed > top) {
        vx *= top / speed
        vz *= top / speed
      }
      Object.assign(b, { x, y, z, vx, vz, speed: Math.hypot(vx, vz), driving, heading: Math.atan2(Math.sin(input.heading), Math.cos(input.heading)) })
      if (d && 'enter' in d) cars.set(id, { index: d.enter.car, state: d.enter.state })
      if (!driving) cars.delete(id)
      const car = cars.get(id)
      if (car) cars.set(id, { index: car.index, state: { ...car.state, x, y, z } })
      return { ok: true as const, pose: copy(b) }
    },
    settle(id) {
      const b = body(id)
      const car = cars.get(id)
      if (b.driving && car) {
        // The car stays the truth, at rest where the last kept claim left it.
        const state = { ...car.state, vx: 0, vy: 0, vz: 0, wx: 0, wy: 0, wz: 0 }
        cars.set(id, { index: car.index, state })
        Object.assign(b, { vx: 0, vz: 0, speed: 0 })
        return { ...copy(b), car: { index: car.index, state } }
      }
      Object.assign(b, { y: PLANE.standing, vx: 0, vz: 0, speed: 0, driving: false })
      return copy(b)
    },
  }
}
