/**
 * Why does this file exist? It is the First Law's last line of defence inside Rapier. The bouncer
 * (laws.ts) brakes every car for a person in its path, but a person can step out closer than any car can
 * stop. Before every world.step() the sanctuary sweeps each moving vehicle's footprint over the coming
 * step; the moment one would reach a person, that person's collider flips from Solid to Sensor in the same
 * call. A sensor takes part in no contact, so the vehicle passes with no impulse on either side. The person
 * is nudged sideways out of the footprint (never through a wall) and turns solid again once every vehicle
 * has kept its distance for a moment. GPU pedestrians are not Rapier bodies (crowd.wgsl nudges them
 * itself); the Rapier people are the players' avatars and, while a pedestrian near the operator is promoted
 * to a physical body, each segment of that body, registered as a ward of its own and rebound (rebind) each
 * time its slot is built again.
 * What breaks if it is removed? A car that reaches the avatar runs into an immovable kinematic capsule: the
 * car stops dead or rebounds, and a vehicle collides with a person, which 14A forbids.
 */
import { RAPIER } from './physics.ts'

/** A person in the Rapier world: an upright capsule (`halfHeight` of the cylinder part, `radius`). */
export interface PersonBody { body: RAPIER.RigidBody; collider: RAPIER.Collider; radius: number; halfHeight: number }

/**
 * A vehicle as the sanctuary sees it: a rectangle in (x, z); forward is (sin heading, cos heading). The Fleet
 * samples it each substep as plain numbers, so no Rapier handle of a vehicle ever leaves the Fleet.
 */
export interface VehicleFootprint {
  id: number
  /** Chassis centre, m. */
  x: number
  z: number
  /** Chassis velocity in (x, z), m/s, and yaw rate about +y, rad/s: the sweep reads these, so slides and spins count. */
  vx: number
  vz: number
  wy: number
  /** False while the chassis collider is disabled: it cannot touch anybody and is skipped. */
  active: boolean
  halfLength: number
  halfWidth: number
  /** Chassis-forward speed, m/s. Informational. */
  speed: number
  heading: number
}

export interface Nudge { dx: number; dz: number }

/** The sweep covers the coming step twice over, so a speed change inside the step cannot outrun it. */
const LOOKAHEAD_STEPS = 2
/**
 * Metres beyond the swept footprint that already count as touching. Covers the person's own motion over
 * the lookahead (a 5.2 m/s run moves 0.17 m in 2/60 s) and Rapier's contact prediction distance.
 */
const MARGIN = 0.25
/** m/s. A footprint point slower than this is standing still: a parked car stays a solid obstacle. */
const MOVING = 0.1
/**
 * m/s. A footprint point opening the gap faster than this is pulling away (or being pushed away by the
 * person) and cannot reach them during the step.
 */
const RECEDING = 0.05
/**
 * Metres of overlap that only a teleport or a respawn can produce: a character controller stops 0.02 m
 * from the chassis collider, which sits 0.04 m inside the footprint. Overlap this deep shields the person
 * even from a stationary vehicle, so Rapier never depenetrates a car off a person.
 */
const DEEP = 0.1
/** Extra metres the nudge clears beyond the margin, so the restore check passes with room to spare. */
const EXIT = 0.05
/**
 * Metres within which a moving vehicle keeps a shielded person shielded. The nudge stops just past MARGIN,
 * so without this a car sweeping by on a curve would get a solid person back mid-pass and flip them again
 * a few steps later.
 */
const RELEASE = 0.6
/** Seconds a shielded person must stay clear of every vehicle before turning solid again. */
const HOLD = 0.3
/** Sideways speed of the safety nudge, m/s: a quick sidestep (0.1 m per 60 Hz step). */
const NUDGE_SPEED = 6
/** Vehicles whose centre is farther than this (m) are not examined: from there, reaching a person within the lookahead takes over 250 m/s. */
const COARSE = 12
/** The wall probe is lifted this far (m) so the ground, and anything the character would step onto, is ignored. */
const PROBE_LIFT = 0.3
/** Gap (m) the wall probe keeps, matching the character controller's offset. */
const PROBE_SKIN = 0.02
/** Only fixed, solid geometry (buildings, poles, ground) can stop a nudge; vehicles and people cannot. */
const WALLS = RAPIER.QueryFilterFlags.ONLY_FIXED | RAPIER.QueryFilterFlags.EXCLUDE_SENSORS

interface Ward {
  person: PersonBody
  /** The person's shape for wall probes (people stand upright). */
  probe: RAPIER.Capsule
  sensor: boolean
  /** Seconds every vehicle has kept clear while shielded. */
  clear: number
  /**
   * Nudge side (+1 = the vehicle's right, −1 = its left) and the vehicle it was chosen against (−1 = none),
   * which also keeps its turn as the one pushed against.
   */
  side: number
  sideOf: number
}

export class Sanctuary {
  private readonly world: RAPIER.World
  private readonly wards: Ward[] = []
  private readonly nudges: Nudge[] = []
  private flipCount = 0
  // Scratch, so guard() does not allocate per substep.
  private readonly at = { x: 0, y: 0, z: 0 }
  private readonly pos = { x: 0, y: 0, z: 0 }
  private readonly dir = { x: 0, y: 0, z: 0 }
  private readonly upright = { x: 0, y: 0, z: 0, w: 1 }

  constructor(world: RAPIER.World) {
    this.world = world
  }

  /** Cumulative Solid→Sensor transitions across every registered person. */
  get flips(): number {
    return this.flipCount
  }

  /**
   * Registers a person (starts solid; the sanctuary owns the collider's sensor flag from here on) and returns their
   * ward index: guard()'s nudges and isSensor() are read by it, in register() order.
   */
  register(person: PersonBody): number {
    person.collider.setSensor(false)
    this.wards.push({ person, probe: new RAPIER.Capsule(person.halfHeight, person.radius), sensor: false, clear: 0, side: 1, sideOf: -1 })
    this.nudges.push({ dx: 0, dz: 0 })
    return this.wards.length - 1
  }

  /**
   * Gives ward `i` a new body of the same shape (a slot built again after its last body left the world): the ward
   * starts over, solid, with no episode kept from the body before. An unknown index is refused.
   */
  rebind(i: number, person: PersonBody): void {
    const ward = this.wards[i]
    if (!ward) throw new RangeError(`no ward ${i} (0–${this.wards.length - 1})`)
    ward.person = person
    ward.sensor = false
    ward.clear = 0
    ward.side = 1
    ward.sideOf = -1
    person.collider.setSensor(false)
    const out = this.nudges[i]
    out.dx = 0
    out.dz = 0
  }

  /**
   * Run BEFORE every world.step(). Flips a person to a sensor when a moving vehicle's footprint, swept over
   * the coming step, would come within the margin of them; restores them once, for the hold time, no vehicle
   * footprint has been within the margin and no moving one within RELEASE. Returns each person's safety
   * nudge for this step, index-aligned with register() order (zero unless shielded and in a vehicle's way).
   * The array is reused between calls.
   */
  guard(vehicles: readonly VehicleFootprint[], h: number): Nudge[] {
    const tau = h * LOOKAHEAD_STEPS
    for (let i = 0; i < this.wards.length; i++) {
      const ward = this.wards[i]
      const out = this.nudges[i]
      out.dx = 0
      out.dz = 0
      const { body, collider, radius } = ward.person
      if (!collider.isValid()) {
        ward.sensor = false
        continue
      }
      // Out of the world (seated in a car): nothing can touch it, so it waits solid.
      if (!collider.isEnabled()) {
        this.restore(ward)
        continue
      }
      const p = body.translation(this.at)
      let danger = false, occupied = false
      let push: VehicleFootprint | null = null, pushRank = 0, pushGap = Infinity, pushW = 0
      for (let j = 0; j < vehicles.length; j++) {
        const v = vehicles[j]
        const rx = p.x - v.x, rz = p.z - v.z
        if (rx * rx + rz * rz > COARSE * COARSE) continue
        if (!v.active) continue
        // Vehicle frame: u along forward F = (fx, fz), w along its right R = (−fz, fx).
        const fx = Math.sin(v.heading), fz = Math.cos(v.heading)
        const u = rx * fx + rz * fz, w = rz * fx - rx * fz
        const du = Math.abs(u) - v.halfLength, dw = Math.abs(w) - v.halfWidth
        const inside = du <= 0 && dw <= 0
        const reach = inside ? Math.max(du, dw) : Math.hypot(Math.max(du, 0), Math.max(dw, 0))
        const gap = reach - radius
        // Velocity of the footprint point nearest the person (translation plus yaw), and how fast it closes.
        const wy = v.wy
        const qu = Math.max(-v.halfLength, Math.min(v.halfLength, u)), qw = Math.max(-v.halfWidth, Math.min(v.halfWidth, w))
        const qx = qu * fx - qw * fz, qz = qu * fz + qw * fx
        const vx = v.vx + wy * qz, vz = v.vz - wy * qx
        const speed = Math.hypot(vx, vz)
        const closing = inside ? speed : (vx * (rx - qx) + vz * (rz - qz)) / reach
        const moving = speed > MOVING
        const receding = moving && closing < -RECEDING
        const approaching = moving && !receding
        const sweeping = approaching && gap <= Math.max(0, closing) * tau + MARGIN
        const passing = approaching && gap <= RELEASE
        const reaches = sweeping || gap < -DEEP
        const near = gap <= MARGIN
        if (reaches) danger = true
        // Any moving vehicle this close holds the shield, even one falling away for the moment: a turning
        // car's flank can pull back from the person just before its rear corner swings back in.
        if (near || (moving && gap <= RELEASE)) occupied = true
        // The nudge pushes away from one vehicle. A moving one sweeping toward or passing close by the
        // person outranks one that is only near or standing on them (a person is never nudged toward a
        // passing vehicle to clear a parked one), and the vehicle already pushed against keeps its turn
        // within a rank, so a person between two vehicles is not bounced from one to the other. A vehicle
        // pulling away is not pushed against unless it still overlaps the person.
        if (passing || reaches || (near && !(receding && gap > 0))) {
          const rank = (sweeping || passing ? 4 : 2) + (v.id === ward.sideOf ? 1 : 0)
          if (rank > pushRank || (rank === pushRank && gap < pushGap)) {
            push = v
            pushRank = rank
            pushGap = gap
            pushW = w
          }
        }
      }
      if (danger && !ward.sensor) {
        collider.setSensor(true)
        ward.sensor = true
        this.flipCount++
      }
      if (!ward.sensor) continue
      if (danger || occupied) ward.clear = 0
      else if ((ward.clear += h) >= HOLD) {
        this.restore(ward)
        continue
      }
      if (push) this.nudge(ward, push, pushW, p, h, out)
    }
    return this.nudges
  }

  /** True while any registered person is a sensor. */
  shielded(): boolean {
    for (const ward of this.wards) if (ward.sensor) return true
    return false
  }

  isSensor(i: number): boolean {
    return this.wards[i]?.sensor === true
  }

  private restore(ward: Ward): void {
    if (ward.sensor) ward.person.collider.setSensor(false)
    ward.sensor = false
    ward.clear = 0
    ward.sideOf = -1
  }

  /**
   * Sideways out of vehicle `v`'s footprint: toward the side the person already leans to (the vehicle's
   * right, the curb side, on a tie). A person in the vehicle's path takes the other side when a wall blocks
   * that one and the other is open; a person beside the vehicle is never carried across it. The side is
   * kept for the episode so the nudge never oscillates; with walls on both sides it stops at the wall.
   */
  private nudge(ward: Ward, v: VehicleFootprint, w: number, p: RAPIER.Vector, h: number, out: Nudge): void {
    const fx = Math.sin(v.heading), fz = Math.cos(v.heading)
    const target = v.halfWidth + ward.person.radius + MARGIN + EXIT
    const chosen = ward.sideOf === v.id
    const inPath = Math.abs(w) < v.halfWidth
    // Beside the vehicle always away from it, even against the kept side: a vehicle sliding or spinning
    // faster than the nudge can leave the person on its other flank.
    let s = !inPath ? (w > 0 ? 1 : -1) : chosen ? ward.side : w > -1e-3 ? 1 : -1
    let need = target - s * w
    if (need <= 0) return
    let free = this.probe(ward, p, -s * fz, s * fx, need)
    if (free < need - 1e-3 && inPath) {
      const need2 = target + s * w
      const free2 = this.probe(ward, p, s * fz, -s * fx, need2)
      if (free2 >= need2 - 1e-3 || (!chosen && free2 > free)) {
        s = -s
        need = need2
        free = free2
      }
    }
    ward.side = s
    ward.sideOf = v.id
    const step = Math.max(0, Math.min(need, free, NUDGE_SPEED * h))
    out.dx = -s * fz * step
    out.dz = s * fx * step
  }

  /** Free distance (m) the person can move along the unit direction (dx, dz) before fixed geometry, up to `max`. */
  private probe(ward: Ward, p: RAPIER.Vector, dx: number, dz: number, max: number): number {
    this.pos.x = p.x
    this.pos.y = p.y + PROBE_LIFT
    this.pos.z = p.z
    this.dir.x = dx
    this.dir.z = dz
    const hit = this.world.castShape(this.pos, this.upright, this.dir, ward.probe, PROBE_SKIN, max, false, WALLS)
    return hit ? hit.time_of_impact : max
  }
}
