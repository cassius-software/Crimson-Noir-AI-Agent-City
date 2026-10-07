/**
 * Why does this file exist? It is the realm's fleet of scheduled craft: the train sets on the elevated loop, the
 * drones on their corridors and the planes on the racetrack of the fixed track network (06_Make_Decisions/
 * tracks.ts). Each is a pure function of the realm's own clock (scheduledPose), so a step only evaluates the
 * timetable at simTime and packs the result as plain numbers (simProtocol.ts TRACK_POSE) for the page to draw and
 * for the Ring-0 audit to read before it leaves. No craft has a Rapier body, a driver or a Bouncer ruling: INV-1
 * (tracks.test.ts) proves their corridors never meet the street, the sidewalk or a car lane, so none can reach a
 * person, and the audit holds them to that (every value finite, every craft at or above its corridor's floor). The
 * craft never interact: a set's place depends on t alone, never on another set's. Nothing here is loaded, and
 * nothing returned is a reference into it.
 * What breaks if it is removed? The realm has no trains, drones or planes to report, and the sky and the elevated
 * loop stay empty.
 */
import { lapSeconds, poseAt, projectOnto, scheduledCount, scheduledPose, wrap, type Track, type TrackNetwork } from '../06_Make_Decisions/tracks.ts'
import { TRACK_KINDS, TRACK_POSE } from './simProtocol.ts'

/**
 * Half the window of the central difference a train's speed is read from, s. Its timetable is continuous in speed
 * (comfortable acceleration between stations), so the chord over 2h is within a·h/2 = 0.025 m/s of the true speed.
 */
const SPEED_WINDOW = 1 / 60

/** One scheduled craft: which track, and which of that track's `count` it is. */
interface Craft {
  readonly track: Track
  readonly kind: number
  readonly index: number
  readonly count: number
}

export class TrackFleet {
  /** Every scheduled craft of the network in buffer order: track by track (by id), each track's craft by index. */
  readonly #craft: readonly Craft[]
  /** Per craft: the last arc length written, the hint for a train's next projection (NaN before the first write). */
  readonly #s: Float64Array
  /** Number of craft, and so of TRACK_POSE slices, in every buffer this fleet writes. */
  readonly count: number
  /** Floats a buffer needs: count × TRACK_POSE.stride. */
  readonly length: number

  constructor(network: TrackNetwork) {
    const craft: Craft[] = []
    for (const track of network.tracks) {
      if (track.kind === 'car') continue
      const kind = TRACK_KINDS.indexOf(track.kind)
      const count = scheduledCount(track)
      for (let index = 0; index < count; index++) craft.push({ track, kind, index, count })
    }
    this.#craft = craft
    this.#s = new Float64Array(craft.length).fill(NaN)
    this.count = craft.length
    this.length = craft.length * TRACK_POSE.stride
    Object.freeze(this)
  }

  /** The track id and kind code of craft `i` (what a renderer groups by); the buffer carries the same two numbers. */
  craftAt(i: number): { track: number; kind: number; index: number; count: number } {
    const c = this.#craft[i]
    if (!c) throw new RangeError(`no craft ${i} (0–${this.count - 1})`)
    return { track: c.track.id, kind: c.kind, index: c.index, count: c.count }
  }

  /**
   * Fills `out` with every craft's TRACK_POSE slice at realm time `t` (s), in buffer order, and returns it. A pure
   * function of t: the same t always writes the same numbers, whatever was written before. `out` must hold at
   * least `length` floats; the floats past that are left alone.
   */
  writePoses(t: number, out: Float32Array): Float32Array {
    if (out.length < this.length) throw new RangeError(`the craft buffer holds ${out.length} floats, ${this.length} are needed`)
    const craft = this.#craft
    const hints = this.#s
    for (let i = 0; i < craft.length; i++) {
      const c = craft[i], track = c.track
      const o = i * TRACK_POSE.stride
      const p = scheduledPose(track, c.index, c.count, t)
      let s: number, speed: number
      if (track.kind === 'train') {
        // The timetable's arc length is not exported: project the pose back onto the loop from the last one (a
        // stale hint, as after a long idle, falls back to the global search), and read the speed off the chord.
        s = projectOnto(track, p.x, p.z, hints[i]).s
        const a = scheduledPose(track, c.index, c.count, t - SPEED_WINDOW)
        const b = scheduledPose(track, c.index, c.count, t + SPEED_WINDOW)
        speed = Math.hypot(b.x - a.x, b.z - a.z) / (2 * SPEED_WINDOW)
      } else {
        // scheduledPose for a drone or a plane is poseAt(track, index · L / count + speed · t): the same arc length.
        s = wrap(track, (c.index * track.length) / c.count + track.speedLimit * t)
        speed = track.speedLimit
      }
      hints[i] = s
      out[o + TRACK_POSE.x] = p.x
      out[o + TRACK_POSE.y] = p.y
      out[o + TRACK_POSE.z] = p.z
      out[o + TRACK_POSE.heading] = p.heading
      out[o + TRACK_POSE.kind] = c.kind
      out[o + TRACK_POSE.track] = track.id
      out[o + TRACK_POSE.s] = s
      out[o + TRACK_POSE.speed] = speed
    }
    return out
  }

  /** Seconds after which craft `i` is back where it was: its track's lap (the train timetable's, with its dwells). */
  periodOf(i: number): number {
    const c = this.#craft[i]
    if (!c) throw new RangeError(`no craft ${i} (0–${this.count - 1})`)
    return lapSeconds(c.track)
  }

  /** Where craft `i` would be at `t`, in doubles (what the buffer rounds to f32). */
  poseOf(i: number, t: number): { x: number; y: number; z: number; heading: number } {
    const c = this.#craft[i]
    if (!c) throw new RangeError(`no craft ${i} (0–${this.count - 1})`)
    const p = scheduledPose(c.track, c.index, c.count, t)
    return { x: p.x, y: p.y, z: p.z, heading: p.heading }
  }
}

Object.freeze(TrackFleet)
Object.freeze(TrackFleet.prototype)

/** The track's own pose at arc length `s` (for a renderer laying a train set's cars along the loop behind its head). */
export function trackPoseAt(track: Track, s: number): { x: number; y: number; z: number; heading: number } {
  const p = poseAt(track, s)
  return { x: p.x, y: p.y, z: p.z, heading: p.heading }
}
