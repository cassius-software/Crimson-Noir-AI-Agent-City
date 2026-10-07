/**
 * Why does this file exist? It is the authoritative check of a Crimson Noir OS weight ledger, pure and synchronous, for
 * the host's second door (ledger.node.ts). The OS's agents learn one way only: an agent whose role was declared with
 * `learn` docks at a station and folds the trip's reward into its weight for that station (crimson_noir_os
 * kernels.rs: w + ((reward - w) >> learnShift)); and a row is wiped to zero when its pointer is dropped or the loop
 * breaker flushes it. The hosted runtime records each of those events as a ledger entry, hash-chained from GENESIS
 * (each entry's hash is the SHA-256 of its canonical body followed by the hash before it, as the swarm's memory ledger
 * chains its episodes), and sends the entries here in bounded chunks.
 * The host trusts nothing it is sent:
 * - The configuration text must hash to the digest the operator pinned (crimson_noir_os/containment.lock), and is then
 *   read strictly. Its names pass the 14A screen, and it must still declare the bare-metal image air-gapped
 *   (network = false): the bridge belongs to the hosted runtime, never to the image.
 * - Every entry must link. It names an agent the pool has. A learn entry names a station the world has, a reward the
 *   kernel can produce, and an agent whose role was declared with `learn`. Ticks never go back.
 * - The weights are folded here as the entries arrive, the kernel's own integer arithmetic. The seal must name this
 *   chain's head and count and the digest of these weights.
 * The weights a verified ledger leaves are what other runtimes of the same configuration and seed may fetch (the fleet
 * sync); each one re-checks them before it adopts them.
 * What breaks if it is removed? The ledger door would have nothing to judge a ledger by.
 */
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { canonical, isDigest, sha256 } from '../02_Define_The_Rules/integrity.ts'

/** The ledger door's subprotocol, offered beside `auth.<token>` in place of the room's. */
export const LEDGER_SUBPROTOCOL = 'crimson.1'
/** One client frame, bytes (a chunk of entries, or the configuration's canonical text). */
export const LEDGER_FRAME = 16384
/** Entries in one `entries` message, at most; and in one ledger. */
export const LEDGER_CHUNK = 64
export const LEDGER_MAX_ENTRIES = 200_000
/** The configuration's canonical text, characters, at most. */
export const CONFIG_MAX = 8192
/** Weight pairs in one `weights` message the host sends. */
export const WEIGHTS_CHUNK = 512
/** The hash before the first entry. */
export const LEDGER_GENESIS = '0'.repeat(64)

/**
 * The seal of the configuration's own scripted run, as crimson_noir_os/containment.seal pins it (`cargo run -- seal`
 * writes that file): the ledger the door keeps for the fleet. Any other verified ledger is answered `verified` and
 * not kept.
 */
export interface LedgerSeal {
  readonly head: string
  readonly count: number
  readonly weights: string
}

/** containment.seal read strictly: comment lines, then `head`, `count` and `weights` once each. Null for anything else. */
export function readSeal(text: string): LedgerSeal | null {
  const fields = new Map<string, string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const m = /^(head|count|weights) (\S+)$/.exec(line)
    if (m === null || fields.has(m[1])) return null
    fields.set(m[1], m[2])
  }
  const head = fields.get('head')
  const count = fields.get('count')
  const weights = fields.get('weights')
  if (head === undefined || count === undefined || weights === undefined) return null
  if (!isDigest(head) || !isDigest(weights) || !/^(?:0|[1-9]\d{0,8})$/.test(count) || Number(count) > LEDGER_MAX_ENTRIES) return null
  return Object.freeze({ head, count: Number(count), weights })
}
/** The rewards the kernel can produce: (1 << 22) / (min(clock, 1 << 20) + 64), at clock 0 and at the cap. */
export const REWARD_MAX = Math.floor((1 << 22) / 64)
export const REWARD_MIN = Math.floor((1 << 22) / ((1 << 20) + 64))
/**
 * Whether the kernel can produce `r` at all, not merely whether it lies between the two: some k = clock + 64 in
 * 64..(1 << 20) + 64 has floor((1 << 22) / k) = r. The k that give r run up to floor((1 << 22) / r), and the quotient
 * only falls as k grows, so the one to try is the largest that is also a clock's: the lesser of that and the cap.
 */
export function producible(r: number): boolean {
  if (!(Number.isInteger(r) && r >= REWARD_MIN && r <= REWARD_MAX)) return false
  const k = Math.min(Math.floor((1 << 22) / r), (1 << 20) + 64)
  return k >= 64 && Math.floor((1 << 22) / k) === r
}
/** Entry kinds: a reward folded in, or an agent's row wiped. */
export const LEARN = 0
export const WIPE = 1
/** The capabilities containment.nix may declare. */
export const CAPABILITIES = Object.freeze(['move', 'route', 'learn', 'memory', 'spawn'])

export interface Role {
  readonly name: string
  readonly count: number
  readonly caps: readonly string[]
}

/** What the ledger check reads from containment.nix's canonical form. */
export interface CrimsonConfig {
  readonly name: string
  readonly seed: number
  readonly capacity: number
  readonly stations: number
  readonly learnShift: number
  readonly network: boolean
  readonly roles: readonly Role[]
}

export type Judged<T> = { ok: true; value: T } | { ok: false; reason: string }
const no = <T,>(reason: string): Judged<T> => ({ ok: false, reason })

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x)
const whole = (u: unknown, max: number): u is number => typeof u === 'number' && Number.isSafeInteger(u) && u >= 0 && u <= max
const pow2 = (n: number): boolean => n > 0 && (n & (n - 1)) === 0

/**
 * containment.nix's canonical form, read strictly: `{`, then one `  key = value;` line per setting (a whole number, a
 * boolean, a quoted string, or a list of quoted strings), then `}`. The keys and roles the ledger needs must be there
 * and sensible; anything malformed is refused.
 */
export function readCanonical(text: unknown): Judged<CrimsonConfig> {
  if (typeof text !== 'string' || text.length > CONFIG_MAX) return no('the configuration is not text of a sensible size')
  const lines = text.split('\n')
  if (lines[0] !== '{' || lines.at(-1) !== '' || lines.at(-2) !== '}') return no('the configuration is not in canonical form')
  const values = new Map<string, string | number | boolean | string[]>()
  for (const line of lines.slice(1, -2)) {
    const m = /^ {2}([A-Za-z][A-Za-z0-9.]*) = (.*);$/.exec(line)
    if (!m) return no('a configuration line is not `key = value;`')
    const [, key, raw] = m
    if (values.has(key)) return no(`${key} is set twice`)
    let v: string | number | boolean | string[]
    if (/^(0|[1-9][0-9]{0,15})$/.test(raw)) v = Number(raw)
    else if (raw === 'true' || raw === 'false') v = raw === 'true'
    else if (/^"[\x20-\x21\x23-\x5b\x5d-\x7e]*"$/.test(raw)) v = raw.slice(1, -1)
    else if (/^\[( "[a-z_0-9-]+")* \]$/.test(raw)) v = [...raw.matchAll(/"([a-z_0-9-]+)"/g)].map((x) => x[1])
    else return no(`${key} has a value the canonical form never writes`)
    if (typeof v === 'number' && !Number.isSafeInteger(v)) return no(`${key} is too large`)
    values.set(key, v)
  }
  const num = (k: string): number | null => (typeof values.get(k) === 'number' ? (values.get(k) as number) : null)
  const name = values.get('system.name')
  const seed = num('system.seed'), capacity = num('pool.capacity'), stations = num('world.stations'), learnShift = num('kernels.learnShift')
  const network = values.get('containment.network')
  if (typeof name !== 'string' || name.length === 0 || name.length > 32) return no('system.name is missing')
  if (seed === null || capacity === null || stations === null || learnShift === null) return no('a setting the ledger needs is missing')
  if (!pow2(capacity) || capacity > 65536) return no('pool.capacity is not a power of two up to 65536')
  if (!pow2(stations) || stations > 16) return no('world.stations is not a power of two up to 16')
  if (learnShift < 1 || learnShift > 15) return no('kernels.learnShift is outside 1..15')
  if (network !== false) return no('the configuration does not declare the image air-gapped (containment.network = false)')
  const roles: Role[] = []
  for (const key of values.keys()) {
    const m = /^roles\.([a-z]{1,16})\.count$/.exec(key)
    if (!m) continue
    const count = num(key)
    const caps = values.get(`roles.${m[1]}.caps`)
    if (count === null || count < 1 || !Array.isArray(caps) || caps.some((c) => !CAPABILITIES.includes(c))) return no(`roles.${m[1]} is malformed`)
    roles.push(Object.freeze({ name: m[1], count, caps: Object.freeze([...caps]) }))
  }
  if (roles.length === 0 || roles.length > 16) return no('the configuration declares no roles, or too many')
  if (roles.reduce((s, r) => s + r.count, 0) > capacity) return no('the roles declare more agents than the pool holds')
  // Every name the configuration carries passes the 14A screen.
  for (const text of [name, ...roles.map((r) => r.name)]) {
    if (!screen(text).admissible) return no('a name in the configuration does not pass the 14A screen')
  }
  return { ok: true, value: Object.freeze({ name, seed, capacity, stations, learnShift, network: false, roles: Object.freeze(roles) }) }
}

/** The role spawned into slot `agent`: the roles fill the pool in their declared order. */
export function roleOf(config: CrimsonConfig, agent: number): Role | null {
  let first = 0
  for (const r of config.roles) {
    if (agent < first + r.count) return r
    first += r.count
  }
  return null
}

/** One ledger entry's body: [kind, tick, agent, station, reward] (a wipe carries station and reward 0). */
export type EntryBody = readonly [number, number, number, number, number]

/** The link: SHA-256 of the entry's canonical body followed by the hash before it. */
export const link = (body: EntryBody, previous: string): string => sha256(canonical(body) + previous)

/** One connection's ledger as it arrives: the configuration, the chain so far, and the weights folded so far. */
export interface LedgerSession {
  config: CrimsonConfig | null
  digest: string
  head: string
  count: number
  tick: number
  weights: Int32Array
  sealed: boolean
}

export const newSession = (): LedgerSession => ({ config: null, digest: '', head: LEDGER_GENESIS, count: 0, tick: 0, weights: new Int32Array(0), sealed: false })

/** Opens a session on a configuration text whose SHA-256 must be `pinned`. */
export function begin(s: LedgerSession, text: unknown, pinned: string): Judged<CrimsonConfig> {
  if (s.config !== null) return no('hello twice')
  if (typeof text !== 'string') return no('the configuration is not text')
  const digest = sha256(text)
  if (digest !== pinned) return no('the configuration is not the one the operator pinned (containment.lock)')
  const read = readCanonical(text)
  if (!read.ok) return read
  s.config = read.value
  s.digest = digest
  s.weights = new Int32Array(read.value.capacity * read.value.stations)
  return read
}

/**
 * Admits one entry, `[kind, tick, agent, station, reward, hash]`: its shape, the containment rules, its link; then
 * folds it into the session's weights. A refusal names the entry by its place in the ledger.
 */
export function admit(s: LedgerSession, u: unknown): Judged<number> {
  const c = s.config
  const at = `entry ${s.count + 1}`
  if (c === null) return no('entries before hello')
  if (s.sealed) return no('entries after the seal')
  if (s.count >= LEDGER_MAX_ENTRIES) return no(`more than ${LEDGER_MAX_ENTRIES} entries`)
  if (!Array.isArray(u) || u.length !== 6) return no(`${at}: not [kind, tick, agent, station, reward, hash]`)
  const [kind, tick, agent, station, reward, hash] = u as unknown[]
  if (!whole(kind, WIPE) || !whole(tick, 0xffff_ffff) || !whole(agent, c.capacity - 1) || !whole(station, 0xffff) || !whole(reward, 0xffff_ffff)) {
    return no(`${at}: a field is not a whole number in range`)
  }
  if (!isDigest(hash)) return no(`${at}: the hash is not a SHA-256 digest`)
  if (tick < s.tick) return no(`${at}: the tick goes back`)
  if (kind === LEARN) {
    if (station >= c.stations) return no(`${at}: station ${station} is not one of the world's ${c.stations}`)
    if (!producible(reward)) return no(`${at}: reward ${reward} is not one the kernel can produce`)
    const role = roleOf(c, agent)
    if (role === null || !role.caps.includes('learn')) return no(`${at}: agent ${agent} (${role?.name ?? 'no role'}) was never declared with learn`)
  } else if (station !== 0 || reward !== 0) return no(`${at}: a wipe carries no station or reward`)
  const body: EntryBody = [kind, tick, agent, station, reward]
  if (hash !== link(body, s.head)) return no(`${at}: the chain breaks here`)
  // The fold: the kernel's integer arithmetic (i32, an arithmetic shift), or the row wiped.
  const row = agent * c.stations
  if (kind === LEARN) {
    const w = s.weights[row + station]
    s.weights[row + station] = (w + (((reward - w) | 0) >> c.learnShift)) | 0
  } else s.weights.fill(0, row, row + c.stations)
  s.head = hash
  s.count++
  s.tick = tick
  return { ok: true, value: s.count }
}

/** The non-zero weights in index order, as [index, weight] pairs. */
export function pairs(weights: Int32Array): [number, number][] {
  const out: [number, number][] = []
  for (let i = 0; i < weights.length; i++) if (weights[i] !== 0) out.push([i, weights[i]])
  return out
}

/** The digest both ends compute over a set of weights: SHA-256 of the canonical non-zero pairs. */
export const weightsDigest = (weights: Int32Array): string => sha256(canonical(pairs(weights)))

/**
 * The containment rules over folded weights: every weight within the rewards' range, and a non-zero one only in a row
 * whose role was declared with `learn`. The fold keeps both by construction; this checks it.
 */
export function contained(c: CrimsonConfig, weights: Int32Array): string | null {
  for (let i = 0; i < weights.length; i++) {
    const w = weights[i]
    if (w === 0) continue
    if (w < 0 || w > REWARD_MAX) return `weight ${i} (${w}) is outside 0..${REWARD_MAX}`
    if (!roleOf(c, Math.floor(i / c.stations))?.caps.includes('learn')) return `weight ${i} belongs to a role never declared with learn`
  }
  return null
}

/** The seal: the session's head, count and weights must be what the client says they are, and contained. */
export function seal(s: LedgerSession, u: Record<string, unknown>): Judged<{ head: string; count: number; weights: string }> {
  if (s.config === null) return no('seal before hello')
  if (s.sealed) return no('sealed twice')
  if (!isDigest(u.head) || !whole(u.count, LEDGER_MAX_ENTRIES) || !isDigest(u.weights)) return no('seal: head, count and weights')
  if (u.head !== s.head || u.count !== s.count) return no(`seal: the chain here ends at entry ${s.count}, ${s.head.slice(0, 12)}`)
  const digest = weightsDigest(s.weights)
  if (u.weights !== digest) return no('seal: the weights are not the fold of the entries')
  const fault = contained(s.config, s.weights)
  if (fault !== null) return no(`seal: ${fault}`)
  s.sealed = true
  return { ok: true, value: { head: s.head, count: s.count, weights: digest } }
}

/** The client's messages on the ledger door, by shape. */
export type LedgerMessage =
  | { t: 'hello'; v: 1; config: string }
  | { t: 'entries'; list: unknown[] }
  | { t: 'seal'; head: string; count: number; weights: string }
  | { t: 'fetch' }

export function readLedgerMessage(u: unknown): Judged<LedgerMessage> {
  if (!isRecord(u) || typeof u.t !== 'string') return no('not a message')
  switch (u.t) {
    case 'hello':
      if (u.v !== 1) return no('hello: protocol version')
      // The configuration's digest pins everything else, its seed included.
      if (typeof u.config !== 'string' || u.config.length > CONFIG_MAX) return no('hello: config')
      return { ok: true, value: { t: 'hello', v: 1, config: u.config } }
    case 'entries':
      if (!Array.isArray(u.list) || u.list.length === 0 || u.list.length > LEDGER_CHUNK) return no(`entries: 1 to ${LEDGER_CHUNK} at a time`)
      return { ok: true, value: { t: 'entries', list: u.list } }
    case 'seal':
      return { ok: true, value: { t: 'seal', head: u.head as string, count: u.count as number, weights: u.weights as string } }
    case 'fetch':
      return { ok: true, value: { t: 'fetch' } }
    default:
      return no('not a ledger message')
  }
}
