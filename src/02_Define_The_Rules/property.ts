/**
 * Why does this file exist? It is the property harness the fuzz suites share (Phase 13): a seeded stream of numbers
 * (every case is reproducible from its seed and index), generators for the values that break code (NaN, the
 * infinities, signed zero, the largest and the smallest doubles, a 32-bit rounding, a value one unit in the last place
 * away), a structural mutator that turns a well-formed message into the near misses an attacker sends (a field
 * dropped, swapped for another type, a number replaced by an adversarial one or nudged by an ulp, an array grown, a
 * key added), and `forAll`, which runs a property over generated cases and, on the first that fails, throws with the
 * case, its index and the seed to replay it. Pure: no clock, no I/O, no dependency; only tests import it.
 * What breaks if it is removed? The fuzz suites would each grow a generator of their own, or a failure would print a
 * case nobody can replay.
 */

/** A seeded source of cases. */
export interface Gen {
  readonly seed: number
  /** A number in [0, 1). */
  next(): number
  /** An integer in [lo, hi]. */
  int(lo: number, hi: number): number
  /** A number in [lo, hi). */
  float(lo: number, hi: number): number
  /** True with probability p. */
  bool(p?: number): boolean
  pick<T>(xs: readonly T[]): T
}

/** Mulberry32: small, fast, and the same on every machine (the cases are the seed's, not the platform's). */
export function gen(seed: number): Gen {
  let s = seed >>> 0
  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32
  }
  return {
    seed: seed >>> 0,
    next,
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    float: (lo, hi) => lo + next() * (hi - lo),
    bool: (p = 0.5) => next() < p,
    pick: (xs) => xs[Math.floor(next() * xs.length)],
  }
}

/** One unit in the last place of x (the gap to the next double away from zero). */
export function ulp(x: number): number {
  if (!Number.isFinite(x)) return Number.NaN
  const a = Math.abs(x)
  if (a === 0) return Number.MIN_VALUE
  const b = new Float64Array([a])
  const i = new BigInt64Array(b.buffer)
  i[0] += 1n
  return b[0] - a
}

/** Numbers that break code that only expects ordinary ones. */
export const ADVERSARIAL_NUMBERS: readonly number[] = Object.freeze([
  0, -0, Number.NaN, Infinity, -Infinity, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2 ** 53, -(2 ** 53), 2 ** 53 + 2,
  1e-308, 2.2250738585072014e-308, 0.1 + 0.2, Math.fround(0.1), 1 - Number.EPSILON / 2, 2 ** 31, -(2 ** 31), 2 ** 32, 1e21, -1e21, 4096.000001, 1e-7,
])

/** An adversarial number, or `x` nudged: by an ulp either way, rounded to 32 bits, negated, scaled by a power of ten. */
export function nastyNumber(g: Gen, x = 0): number {
  switch (g.int(0, 6)) {
    case 0: return g.pick(ADVERSARIAL_NUMBERS)
    case 1: return x + (g.bool() ? 1 : -1) * ulp(x)
    case 2: return Math.fround(x)
    case 3: return -x
    case 4: return x * 10 ** g.int(-8, 8)
    case 5: return x + g.float(-1e-6, 1e-6)
    default: return g.float(-1e4, 1e4)
  }
}

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === 'object' && u !== null && !Array.isArray(u)

/** A plain value of any JSON-ish shape, a few levels deep. */
export function anyValue(g: Gen, depth = 2): unknown {
  switch (g.int(0, depth > 0 ? 8 : 5)) {
    case 0: return nastyNumber(g)
    case 1: return g.int(-5, 5)
    case 2: return g.pick(['', 'x', 'input', 'join', 'drive', 'foot', 'enter', 'exit', '\u0000', 'a'.repeat(g.int(0, 5000)), '\ud800'])
    case 3: return g.bool()
    case 4: return null
    case 5: return undefined
    case 6: return Array.from({ length: g.int(0, 6) }, () => anyValue(g, depth - 1))
    default: {
      const o: Record<string, unknown> = {}
      for (let i = g.int(0, 4); i > 0; i--) o[g.pick(['t', 'x', 'y', 'z', 'seq', 'fix', 'segs', 'door', 'state', 'car', 'enter', 'exit', '__proto__', 'constructor'])] = anyValue(g, depth - 1)
      return o
    }
  }
}

/**
 * A near miss of `value`: a copy with one change somewhere inside it (`changes` of them): a key dropped or added, a
 * value swapped for another type, a number replaced by an adversarial one or nudged, an array grown or shrunk.
 */
export function mutate(value: unknown, g: Gen, changes = 1): unknown {
  let out = structuredClone(value)
  for (let c = 0; c < changes; c++) out = mutateOnce(out, g)
  return out
}

function mutateOnce(v: unknown, g: Gen): unknown {
  if (typeof v === 'number') return nastyNumber(g, v)
  if (Array.isArray(v)) {
    if (v.length === 0 || g.bool(0.2)) {
      const copy = [...v]
      if (g.bool() && copy.length > 0) copy.splice(g.int(0, copy.length - 1), 1)
      else copy.splice(g.int(0, copy.length), 0, anyValue(g, 1))
      return copy
    }
    const i = g.int(0, v.length - 1)
    const copy = [...v]
    copy[i] = g.bool(0.85) ? mutateOnce(v[i], g) : anyValue(g, 1)
    return copy
  }
  if (isRecord(v)) {
    const keys = Object.keys(v)
    const copy: Record<string, unknown> = { ...v }
    const roll = g.next()
    if (keys.length === 0 || roll < 0.1) copy[g.pick(['extra', 'from', 'door', 'car', '__proto__', 'toJSON'])] = anyValue(g, 1)
    else if (roll < 0.2) delete copy[g.pick(keys)]
    else {
      const k = g.pick(keys)
      copy[k] = g.bool(0.85) ? mutateOnce(v[k], g) : anyValue(g, 1)
    }
    return copy
  }
  return g.bool(0.5) ? anyValue(g, 1) : v
}

/** Deeply frozen: the object and everything reachable from it. */
export function deeplyFrozen(u: unknown): boolean {
  if (typeof u !== 'object' || u === null) return true
  if (!Object.isFrozen(u)) return false
  return Object.values(u).every(deeplyFrozen)
}

/** Every number anywhere inside `u`. */
export function numbersIn(u: unknown, out: number[] = []): number[] {
  if (typeof u === 'number') out.push(u)
  else if (typeof u === 'object' && u !== null) for (const v of Object.values(u)) numbersIn(v, out)
  return out
}

/**
 * The nightly fuzz run's knobs, read once from the environment (none in a browser): FUZZ_SCALE multiplies every
 * property's `runs` (a whole number, 1 by default), and FUZZ_SEED is added to every property's seed, so a scheduled
 * run explores cases the suite's fixed seeds never draw. A failure's message names the seed and run count that
 * replay it, so the knobs never hide a case: replay with `{ seed, runs }` as printed, and no knob set.
 */
export const FUZZ = Object.freeze((() => {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {}
  const read = (name: string, min: number): number => {
    const raw = env[name]
    if (raw === undefined || raw === '') return min === 1 ? 1 : 0
    const n = Number(raw)
    if (!Number.isSafeInteger(n) || n < min) throw new Error(`${name} must be a whole number of at least ${min}: ${JSON.stringify(raw)}`)
    return n
  }
  return { scale: read('FUZZ_SCALE', 1), seed: read('FUZZ_SEED', 0) }
})())

/**
 * Runs `check` on `runs` cases made by `make` from the seeded stream (times FUZZ_SCALE, from the seed plus FUZZ_SEED:
 * see FUZZ). The first case that throws fails the property with its index, the seed that replays it, and the case
 * itself.
 */
export function forAll<T>(name: string, o: { seed: number; runs: number }, make: (g: Gen, i: number) => T, check: (c: T, i: number) => void): void {
  o = { seed: o.seed + FUZZ.seed, runs: o.runs * FUZZ.scale }
  const g = gen(o.seed)
  for (let i = 0; i < o.runs; i++) {
    const c = make(g, i)
    try {
      check(c, i)
    } catch (e) {
      let shown: string
      try {
        shown = JSON.stringify(c, (_k, v: unknown) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))?.slice(0, 600) ?? String(c)
      } catch {
        shown = String(c)
      }
      const why = e instanceof Error ? e.message : String(e)
      throw new Error(`property '${name}' failed on case ${i} of seed ${o.seed} (replay: { seed: ${o.seed}, runs: ${i + 1} }): ${why}\ncase: ${shown}`, { cause: e })
    }
  }
}
