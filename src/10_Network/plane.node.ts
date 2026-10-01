/**
 * Why does this file exist? It is an Authority (replication.ts) over an open plane: no buildings and no ground but
 * standing height, the walk clamped the way the realm clamps it (simProtocol.ts footWish) and integrated substep by
 * substep, a car bounded by the velocity cap, the same tolerance and reach as the mirror. The core's and the client's
 * tests run the room on it when a test is about the protocol rather than the city, and `planeStep` is the honest
 * client those tests drive. The host always runs the headless Ring-0 mirror (mirror.node.ts), whose own tests prove it
 * against the page's realm.
 * What breaks if it is removed? The protocol's tests would need the whole city to say anything.
 */
import { footWish, RUN } from '../07_Execute_Actions/simProtocol.ts'
import { LIMITS, type Authority, type InputMessage, type Run, type Truth } from './replication.ts'

export const PLANE = Object.freeze({
  /** One substep, s. */
  h: 1 / 60,
  /** Where a body stands on the plane, m (the capsule centre). */
  standing: 0.92,
  /** The mirror's tolerance and reach (mirror.node.ts MIRROR), m. */
  tolerance: 0.25,
  reach: 8,
  /** Where peer `id` starts: a metre apart along x. */
  spawnGap: 1,
})

/** An honest client on the plane: `at` walked by `runs` (clamped as the realm clamps), where its claim would be. */
export function planeStep(at: { x: number; z: number }, runs: readonly Run[]): { x: number; y: number; z: number } {
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
    },
    judge(id, input: InputMessage) {
      const b = body(id)
      const refuse = (reason: string) => ({ ok: false as const, pose: copy(b), reason })
      let n = 0
      for (const r of input.segs) n += r[2]
      const t = n * PLANE.h
      let x: number, y: number, z: number, start: { x: number; z: number }
      if (input.mode === 'foot') {
        if (input.from && !b.driving) return refuse('exit point without a car')
        if (!input.from && b.driving) return refuse('on foot without leaving the car')
        start = input.from ?? b
        if (input.from && Math.hypot(start.x - b.x, start.z - b.z) > PLANE.reach) return refuse('exit point out of reach of the car')
        const end = planeStep(start, input.segs)
        x = end.x
        y = end.y
        z = end.z
        const off = Math.hypot(input.claim.x - x, input.claim.y - y, input.claim.z - z)
        if (!(off <= PLANE.tolerance)) return refuse(`claim ${off.toFixed(2)} m from the plane's pose`)
      } else {
        start = b
        const reach = (b.driving ? 0 : PLANE.reach) + LIMITS.driveSpeed * t + 0.5
        const moved = Math.hypot(input.claim.x - b.x, input.claim.z - b.z)
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
      return { ok: true as const, pose: copy(b) }
    },
    settle(id) {
      const b = body(id)
      Object.assign(b, { y: PLANE.standing, vx: 0, vz: 0, speed: 0, driving: false })
      return copy(b)
    },
  }
}
