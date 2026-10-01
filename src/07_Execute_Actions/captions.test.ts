/**
 * Why does this file exist? It pins the caption feed (captions.ts): a bearing at each of the eight compass points
 * reads the right hour, arrow and side word on both sides of the head, distances round as the HUD shows them, a
 * continuing sound is captioned once and refreshed rather than repeated, a change retexts its line in place, a stop
 * holds the line for the hold and then expires it, a live line nobody refreshes expires, speech ranks first and a
 * speaker's words are kept verbatim, the feed never exceeds its bound (and evicts the lowest-ranked record first), the
 * ambient beds toggle with hysteresis, records are pooled, and no caption string carries a scrubbed brand, a combat
 * word or a phrase the 14A screen refuses.
 * What breaks if it is removed? A car could be captioned on every control pass, speech could scroll off before it is
 * read, a left-hand sound could read as right-hand, or a word the product scrubbed could reach the HUD unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { screen } from '../02_Define_The_Rules/conduct.ts'
import { ARROWS, CAPTIONS, CaptionTrack, bearing, captionText, roundMetres, soundText, type CaptionEvent, type ListenerPose, type SoundKind } from './captions.ts'

const AT_ORIGIN: ListenerPose = { x: 0, z: 0, yaw: 0 }

const ev = (kind: SoundKind, phase: CaptionEvent['phase'], t: number, extra: Partial<CaptionEvent> = {}): CaptionEvent =>
  ({ kind, phase, source: 0, x: 0, z: -10, t, ...extra })

// ---------------------------------------------------------------------------------------------------
// Bearing

test('bearing: the eight compass points around a listener facing −z read the right hour, arrow and word', () => {
  // Head forward = (−sin yaw, −cos yaw): yaw 0 faces −z, and +x is the right hand.
  const points: [number, number, number, string, string][] = [
    [0, -10, 12, '↑', 'ahead'],
    [10, -10, 2, '↗', 'ahead right'],   // 45° right of ahead rounds to 2 o'clock (1.5 → 2)
    [10, 0, 3, '→', 'right'],
    [10, 10, 5, '↘', 'behind right'],
    [0, 10, 6, '↓', 'behind'],
    [-10, 10, 8, '↙', 'behind left'],   // 225° → 7.5 → 8
    [-10, 0, 9, '←', 'left'],
    [-10, -10, 11, '↖', 'ahead left'],  // 315° → 10.5 → 11
  ]
  for (const [x, z, hour, arrow, word] of points) {
    const b = bearing(AT_ORIGIN, x, z)
    assert.equal(b.hour, hour, `(${x}, ${z}) hour`)
    assert.equal(b.arrow, arrow, `(${x}, ${z}) arrow`)
    assert.equal(b.word, word, `(${x}, ${z}) word`)
    assert.ok(ARROWS.includes(b.arrow))
  }
})

test('bearing: exact clock hours on both sides, and the head frame turns with the yaw', () => {
  const r = 20
  for (let h = 1; h <= 12; h++) {
    const a = (h % 12) * (Math.PI / 6)                    // clockwise from ahead
    const x = r * Math.sin(a), z = -r * Math.cos(a)        // ahead is −z, right is +x
    assert.equal(bearing(AT_ORIGIN, x, z).hour, h, `hour ${h}`)
    const side = bearing(AT_ORIGIN, x, z).word
    if (h >= 1 && h <= 5) assert.match(side, /right/, `hour ${h} is on the right`)
    if (h >= 7 && h <= 11) assert.match(side, /left/, `hour ${h} is on the left`)
  }
  // Facing +x (yaw = −π/2: forward = (−sin yaw, −cos yaw) = (1, 0)), a point at +x is ahead and a point at −z is on the left.
  const east: ListenerPose = { x: 0, z: 0, yaw: -Math.PI / 2 }
  assert.equal(bearing(east, 10, 0).word, 'ahead')
  assert.equal(bearing(east, 0, -10).word, 'left')
  assert.equal(bearing(east, 0, 10).word, 'right')
  assert.equal(bearing(east, -10, 0).word, 'behind')
  // Facing +z (yaw = π): −z is behind, +x is left.
  const south: ListenerPose = { x: 5, z: 5, yaw: Math.PI }
  assert.equal(bearing(south, 5, -5).word, 'behind')
  assert.equal(bearing(south, 15, 5).word, 'left')
  assert.equal(bearing(south, -5, 5).word, 'right')
  // The listener's own position is subtracted.
  assert.equal(bearing({ x: 100, z: 100, yaw: 0 }, 100, 90).word, 'ahead')
})

test('bearing: distance rounds to 1 m under 10 m and to 5 m beyond; a point at the eye is ahead at 0 m; non-finite never throws', () => {
  assert.equal(roundMetres(0), 0)
  assert.equal(roundMetres(3.4), 3)
  assert.equal(roundMetres(9.6), 10)
  assert.equal(roundMetres(12), 10)
  assert.equal(roundMetres(12.5), 15)
  assert.equal(roundMetres(27), 25)
  assert.equal(roundMetres(28), 30)
  assert.ok(Number.isNaN(roundMetres(NaN)))
  assert.ok(Number.isNaN(roundMetres(Infinity)))
  assert.equal(bearing(AT_ORIGIN, 0, -3.4).metres, 3)
  assert.equal(bearing(AT_ORIGIN, 0, -27).metres, 25)
  assert.equal(bearing(AT_ORIGIN, 3, -4).metres, 5)
  const here = bearing(AT_ORIGIN, 0, 0)
  assert.equal(here.metres, 0)
  assert.equal(here.hour, 12)
  assert.equal(here.word, 'ahead')
  for (const [x, z] of [[NaN, 0], [0, NaN], [Infinity, 0]]) {
    const b = bearing(AT_ORIGIN, x, z)
    assert.equal(b.hour, 0)
    assert.equal(b.arrow, '')
    assert.equal(b.word, '')
    assert.ok(Number.isNaN(b.metres))
  }
  const b = bearing({ x: NaN, z: 0, yaw: 0 }, 1, 1)
  assert.equal(b.arrow, '')
  // An `out` object is reused, not replaced.
  const out = { hour: 0, arrow: '', word: '' as const, metres: NaN }
  assert.equal(bearing(AT_ORIGIN, 0, -10, out), out)
  assert.equal(out.hour, 12)
})

// ---------------------------------------------------------------------------------------------------
// Text

test('soundText and captionText: every kind reads as the house style, with the arrow, side and distance', () => {
  assert.equal(soundText(ev('engine', 'start', 0, { detail: 'approaching' })), '[car approaching]')
  assert.equal(soundText(ev('engine', 'start', 0, { detail: 'passing' })), '[car passing]')
  assert.equal(soundText(ev('engine', 'start', 0)), '[car nearby]')
  assert.equal(soundText(ev('engine', 'change', 0, { detail: 'up' })), '[car shifting up]')
  assert.equal(soundText(ev('engine', 'change', 0, { detail: 'down' })), '[car shifting down]')
  assert.equal(soundText(ev('engine', 'change', 0)), '', 'a change with no word keeps the text')
  assert.equal(soundText(ev('engine', 'stop', 0)), '', 'a stop keeps the text')
  assert.equal(soundText(ev('tyres', 'start', 0)), '[tyre noise]')
  assert.equal(soundText(ev('murmur', 'start', 0)), '[crowd murmur]')
  assert.equal(soundText(ev('murmur', 'start', 0, { detail: 'busy' })), '[crowd murmur, busy]')
  assert.equal(soundText(ev('murmur', 'change', 0, { detail: 'quiet' })), '[crowd murmur, quiet]')
  assert.equal(soundText(ev('murmur', 'change', 0)), '', 'a level-only change keeps the text')
  assert.equal(soundText(ev('walk-signal', 'start', 0, { detail: 'ns' })), '[walk signal: cuckoo, north–south]')
  assert.equal(soundText(ev('walk-signal', 'start', 0, { detail: 'ew' })), '[walk signal: chirp, east–west]')
  assert.equal(soundText(ev('walk-signal', 'start', 0)), '[walk signal]')
  assert.equal(soundText(ev('cue', 'start', 0)), '[someone coming over]')
  assert.equal(soundText(ev('speech', 'start', 0, { agent: 1234, text: 'over here, by the lamp' })), 'Pedestrian 1234: over here, by the lamp')
  assert.equal(soundText(ev('speech', 'start', 0, { label: 'Pedestrian 1234 (Rust)', text: 'hello' })), 'Pedestrian 1234 (Rust): hello')
  assert.equal(soundText(ev('speech', 'start', 0, { agent: 7, text: 'hello', detail: 'muffled' })), 'Pedestrian 7 (muffled): hello')
  assert.equal(soundText(ev('speech', 'start', 0, { agent: 7 })), '[Pedestrian 7 speaking]')
  assert.equal(soundText(ev('speech', 'start', 0)), '[Someone speaking]')
  assert.equal(soundText(ev('cabin', 'start', 0)), '[in the car: outside muffled]')
  assert.equal(soundText(ev('cabin', 'stop', 0)), '[out of the car: outside clear]')
  assert.equal(soundText(ev('peer', 'start', 0, { label: 'Ada' })), '[voice: Ada]')
  assert.equal(soundText(ev('peer', 'start', 0, { agent: 2 })), '[voice: player 2]')
  assert.equal(soundText(ev('peer', 'start', 0)), '[voice: a player]')
  assert.equal(soundText(ev('peer', 'change', 0, { label: 'Ada', text: 'on my way' })), 'Ada: on my way')
  assert.equal(soundText(ev('ping', 'start', 0, { label: 'the lamp' })), '[ping: the lamp]')
  assert.equal(soundText(ev('ping', 'start', 0)), '[ping]')

  const track = new CaptionTrack()
  track.push(ev('engine', 'start', 1, { x: 20, z: -20, detail: 'approaching' }), AT_ORIGIN)
  const [line] = track.lines(1)
  assert.equal(captionText(line), '↗ [car approaching] · ahead right, 30 m')
  track.push(ev('cabin', 'start', 1, { x: NaN, z: NaN }), AT_ORIGIN)
  const cabin = track.lines(1).find((l) => l.kind === 'cabin')
  assert.ok(cabin)
  assert.equal(captionText(cabin), '[in the car: outside muffled]', 'a sound with no place is the text alone')
})

test('speech text is kept verbatim: punctuation, quotes, unicode and spacing untouched', () => {
  const said = '  "Ça va?" — fine, thanks… 3 × 4 = 12; <ok> & done  '
  assert.equal(soundText(ev('speech', 'start', 0, { agent: 42, text: said })), `Pedestrian 42: ${said}`)
  const track = new CaptionTrack()
  track.push(ev('speech', 'start', 0, { agent: 42, text: said, x: 0, z: -2 }), AT_ORIGIN)
  const [line] = track.lines(0)
  assert.equal(line.text, `Pedestrian 42: ${said}`)
  assert.equal(captionText(line), `↑ Pedestrian 42: ${said} · ahead, 2 m`)
})

// ---------------------------------------------------------------------------------------------------
// The track

test('dedupe: a continuing sound is one line, refreshed; a change retexts it in place; a change for an unknown sound is ignored', () => {
  const track = new CaptionTrack()
  assert.equal(track.push(ev('engine', 'start', 0, { source: 3, detail: 'approaching', x: 0, z: -40 }), AT_ORIGIN), true)
  for (let t = 0.1; t < 2; t += 0.1) {
    assert.equal(track.push(ev('engine', 'start', t, { source: 3, detail: 'approaching', x: 0, z: -40 + t * 10 }), AT_ORIGIN), false, `repeat at ${t}`)
  }
  assert.equal(track.size, 1)
  let [line] = track.lines(2)
  assert.equal(line.id, 1)
  assert.equal(line.text, '[car approaching]')
  assert.equal(line.metres, 20, 'the place follows the latest event')
  assert.equal(line.since, 0, 'the text has not changed')
  assert.equal(track.push(ev('engine', 'change', 2.5, { source: 3, detail: 'up', x: 0, z: -15 }), AT_ORIGIN), true)
  ;[line] = track.lines(2.6)
  assert.equal(line.id, 1, 'the same record')
  assert.equal(line.text, '[car shifting up]')
  assert.equal(line.since, 2.5)
  assert.equal(line.metres, 15)
  assert.equal(track.push(ev('engine', 'change', 2.7, { source: 3, x: 0, z: -12 }), AT_ORIGIN), false, 'a place-only change')
  assert.equal(track.lines(2.8)[0].metres, 10)
  assert.equal(track.push(ev('engine', 'change', 3, { source: 9, detail: 'up' }), AT_ORIGIN), false, 'no such sound')
  assert.equal(track.push(ev('engine', 'stop', 3, { source: 9 }), AT_ORIGIN), false)
  assert.equal(track.size, 1)
  assert.equal(track.issued, 1)
  // Another source of the same kind is another line.
  assert.equal(track.push(ev('engine', 'start', 3, { source: 4, detail: 'passing' }), AT_ORIGIN), true)
  assert.equal(track.size, 2)
  assert.equal(track.issued, 2)
})

test('stop and expiry: a stopped line holds for `hold` (speech for `speechHold`) then goes; a repeated stop is ignored; a start revives it', () => {
  const track = new CaptionTrack()
  track.push(ev('engine', 'start', 0, { detail: 'approaching' }), AT_ORIGIN)
  track.push(ev('speech', 'start', 0, { source: 7, agent: 7, text: 'hello' }), AT_ORIGIN)
  assert.equal(track.push(ev('engine', 'stop', 1), AT_ORIGIN), true)
  assert.equal(track.push(ev('engine', 'stop', 1.1), AT_ORIGIN), false, 'already stopped')
  assert.equal(track.push(ev('speech', 'stop', 1, { source: 7 }), AT_ORIGIN), true)
  let lines = track.lines(1 + CAPTIONS.hold - 0.01)
  assert.deepEqual(lines.map((l) => [l.kind, l.live]), [['speech', false], ['engine', false]])
  lines = track.lines(1 + CAPTIONS.hold)
  assert.deepEqual(lines.map((l) => l.kind), ['speech'], 'the engine line is gone at the end of its hold')
  lines = track.lines(1 + CAPTIONS.speechHold)
  assert.equal(lines.length, 0, 'the speech line is gone at the end of its longer hold')
  assert.equal(track.size, 0)
  // A start during the hold revives the stopped line (same record, live again).
  track.push(ev('cue', 'start', 10, { source: 1 }), AT_ORIGIN)
  track.push(ev('cue', 'stop', 11, { source: 1 }), AT_ORIGIN)
  const id = track.lines(11)[0].id
  assert.equal(track.push(ev('cue', 'start', 12, { source: 1 }), AT_ORIGIN), true)
  const [cue] = track.lines(12)
  assert.equal(cue.id, id)
  assert.equal(cue.live, true)
  // The cabin's stop carries its own words.
  track.push(ev('cabin', 'start', 20, { x: NaN, z: NaN }), AT_ORIGIN)
  track.push(ev('cabin', 'stop', 21, { x: NaN, z: NaN }), AT_ORIGIN)
  assert.equal(track.lines(21).find((l) => l.kind === 'cabin')?.text, '[out of the car: outside clear]')
})

test('expiry: a live line nobody refreshes lasts `ttl`; a refresh extends it', () => {
  const track = new CaptionTrack({ ttl: 4 })
  track.push(ev('walk-signal', 'start', 0, { detail: 'ns' }), AT_ORIGIN)
  assert.equal(track.lines(3.99).length, 1)
  assert.equal(track.push(ev('walk-signal', 'start', 3, { detail: 'ns' }), AT_ORIGIN), false, 'the same sound, continuing')
  assert.equal(track.lines(6.99).length, 1, 'refreshed at 3 s, so alive until 7 s')
  assert.equal(track.lines(7).length, 0)
  assert.equal(track.size, 0)
})

test('ordering: speech, peer, ping, cue, walk signal, cabin, engine, tyres, murmur; newest first within a kind', () => {
  const track = new CaptionTrack({ maxLines: 16, ttl: 100 })
  const kinds: SoundKind[] = ['murmur', 'tyres', 'engine', 'cabin', 'walk-signal', 'cue', 'ping', 'peer', 'speech']
  kinds.forEach((k, i) => track.push(ev(k, 'start', i, { source: 1, agent: 1, text: 'hi', label: 'x', x: NaN, z: NaN }), AT_ORIGIN))
  assert.deepEqual(track.lines(10).map((l) => l.kind), [...kinds].reverse())
  track.push(ev('engine', 'start', 20, { source: 2, detail: 'approaching' }), AT_ORIGIN)
  track.push(ev('engine', 'start', 21, { source: 3, detail: 'passing' }), AT_ORIGIN)
  const engines = track.lines(22).filter((l) => l.kind === 'engine').map((l) => l.source)
  assert.deepEqual(engines, [3, 2, 1], 'newest first')
  // A change retexts a line and makes it the newest of its kind.
  track.push(ev('engine', 'change', 23, { source: 1, detail: 'up' }), AT_ORIGIN)
  assert.deepEqual(track.lines(24).filter((l) => l.kind === 'engine').map((l) => l.source), [1, 3, 2])
})

test('bound: lines() never exceeds maxLines and the track never exceeds capacity; the lowest-ranked record is evicted first', () => {
  const track = new CaptionTrack({ maxLines: 2, capacity: 4 })
  for (let i = 0; i < 10; i++) track.push(ev('engine', 'start', i, { source: i, detail: 'passing' }), AT_ORIGIN)
  assert.equal(track.size, 4)
  assert.equal(track.lines(10).length, 2)
  assert.deepEqual(track.lines(10).map((l) => l.source), [9, 8], 'the newest two')
  // Speech outranks the engines: it is kept, the oldest engine goes.
  track.push(ev('speech', 'start', 11, { source: 7, agent: 7, text: 'hello' }), AT_ORIGIN)
  assert.equal(track.size, 4)
  assert.deepEqual(track.lines(12).map((l) => l.kind), ['speech', 'engine'])
  for (let i = 0; i < 10; i++) track.push(ev('murmur', 'start', 12 + i * 0.1, { source: i }), AT_ORIGIN)
  assert.equal(track.size, 4)
  assert.ok(track.lines(13).some((l) => l.kind === 'speech'), 'speech survives a flood of murmur')
  assert.equal(track.lines(13).length, 2)
  assert.equal(track.lines(13 + CAPTIONS.ttl).length, 0, 'everything expires in the end')
  // Expired records make room before anything is evicted.
  const t2 = new CaptionTrack({ maxLines: 3, capacity: 3, hold: 1 })
  t2.push(ev('speech', 'start', 0, { source: 1, agent: 1, text: 'a' }), AT_ORIGIN)
  t2.push(ev('speech', 'stop', 0, { source: 1 }), AT_ORIGIN)
  t2.push(ev('cue', 'start', 0, { source: 1 }), AT_ORIGIN)
  t2.push(ev('cue', 'start', 0, { source: 2 }), AT_ORIGIN)
  t2.push(ev('cue', 'start', 5, { source: 3 }), AT_ORIGIN)
  assert.deepEqual(t2.lines(5).map((l) => `${l.kind}:${l.source}`).sort(), ['cue:1', 'cue:2', 'cue:3'], 'the held speech expired, both cues stayed')
  // Options are clamped: capacity is never below maxLines, nonsense falls back to the defaults.
  const t3 = new CaptionTrack({ maxLines: 5, capacity: 1, hold: NaN, ttl: -1 })
  assert.equal(t3.capacity, 5)
  assert.equal(t3.hold, CAPTIONS.hold)
  assert.equal(t3.ttl, CAPTIONS.ttl)
})

test('records are pooled: ids keep counting, objects are reused, lines() returns the same array, clear() empties it', () => {
  const track = new CaptionTrack({ capacity: 2 })
  track.push(ev('cue', 'start', 0, { source: 1 }), AT_ORIGIN)
  const first = track.lines(0)[0]
  track.push(ev('cue', 'stop', 0, { source: 1 }), AT_ORIGIN)
  track.lines(CAPTIONS.hold + 1) // expires it into the pool
  track.push(ev('cue', 'start', 10, { source: 2 }), AT_ORIGIN)
  const second = track.lines(10)[0]
  assert.equal(second, first, 'the same object, reused')
  assert.equal(second.id, 2)
  assert.equal(track.lines(10), track.lines(10))
  track.clear()
  assert.equal(track.size, 0)
  assert.equal(track.lines(10).length, 0)
  track.push(ev('cue', 'start', 11, { source: 2 }), AT_ORIGIN)
  assert.equal(track.lines(11)[0].id, 3, 'ids never repeat')
  // Malformed events are refused, never thrown on.
  assert.equal(track.push({ kind: 'engine', phase: 'start', source: 0, x: 0, z: 0, t: NaN }, AT_ORIGIN), false)
  assert.equal(track.push({ kind: 'toString' as SoundKind, phase: 'start', source: 0, x: 0, z: 0, t: 0 }, AT_ORIGIN), false)
  assert.equal(track.push(null as unknown as CaptionEvent, AT_ORIGIN), false)
})

test('lines(now, listener) re-bears every line against the head as it turns', () => {
  const track = new CaptionTrack()
  track.push(ev('cue', 'start', 0, { x: 0, z: -10 }), AT_ORIGIN)
  assert.equal(track.lines(0)[0].word, 'ahead')
  assert.equal(track.lines(0, { x: 0, z: 0, yaw: Math.PI / 2 })[0].word, 'right', 'turned to face −x, the cue is on the right')
  assert.equal(track.lines(0, { x: 0, z: -20, yaw: 0 })[0].word, 'behind')
  assert.equal(track.lines(0, { x: 0, z: -20, yaw: 0 })[0].metres, 10)
})

test('ambient: a bed is captioned once its level reaches ambientOn, retexts quiet/busy, and ends under ambientOff', () => {
  const track = new CaptionTrack()
  const L = AT_ORIGIN
  assert.equal(track.ambient('murmur', 0, 0.04, 5, 0, 0, L), false, 'under the on threshold')
  assert.equal(track.ambient('murmur', 0, 0.06, 5, 0, 1, L), true)
  assert.equal(track.lines(1)[0].text, '[crowd murmur, quiet]')
  assert.equal(track.ambient('murmur', 0, 0.03, 5, 0, 2, L), false, 'between the thresholds: still on, nothing new')
  assert.equal(track.size, 1)
  assert.equal(track.ambient('murmur', 0, 0.7, 5, 0, 3, L), true)
  assert.equal(track.lines(3)[0].text, '[crowd murmur, busy]')
  assert.equal(track.ambient('murmur', 0, 0.6, 5, 0, 4, L), false, 'still busy')
  assert.equal(track.ambient('murmur', 0, 0.2, 5, 0, 5, L), true)
  assert.equal(track.lines(5)[0].text, '[crowd murmur, quiet]')
  assert.equal(track.ambient('murmur', 0, 0.01, 5, 0, 6, L), true, 'off')
  assert.equal(track.lines(6)[0].live, false)
  assert.equal(track.lines(6 + CAPTIONS.hold).length, 0)
  assert.equal(track.ambient('murmur', 0, 0.01, 5, 0, 7, L), false, 'stays off')
  assert.equal(track.ambient('tyres', 2, 0.5, 5, 0, 8, L), true)
  assert.equal(track.lines(8)[0].text, '[tyre noise]')
  assert.equal(track.ambient('tyres', 2, 0.9, 5, 0, 9, L), false, 'tyres have no busy word')
  assert.equal(track.ambient('tyres', 2, NaN, 5, 0, 10, L), true, 'a non-finite level reads as silence')
  track.clear()
  assert.equal(track.ambient('murmur', 0, 0.06, 5, 0, 11, L), true, 'clear() forgets the ambient state too')
  // A bed whose record expired (nobody fed its level for `ttl`) or was evicted is captioned afresh.
  assert.equal(track.lines(11 + CAPTIONS.ttl).length, 0)
  assert.equal(track.ambient('murmur', 0, 0.06, 5, 0, 30, L), true, 'captioned again after its record expired')
  const small = new CaptionTrack({ maxLines: 1, capacity: 1 })
  assert.equal(small.ambient('murmur', 0, 0.5, 5, 0, 0, L), true)
  small.push(ev('speech', 'start', 1, { source: 1, agent: 1, text: 'hi' }), L)
  assert.equal(small.lines(1)[0].kind, 'speech', 'the murmur record was evicted')
  assert.equal(small.ambient('murmur', 0, 0.5, 5, 0, 2, L), true, 'captioned again after eviction')
})

test('determinism: the same events in the same order give the same lines', () => {
  const run = (): string[] => {
    const track = new CaptionTrack()
    const L: ListenerPose = { x: 3, z: -2, yaw: 0.4 }
    for (let i = 0; i < 40; i++) {
      const kind: SoundKind = (['engine', 'tyres', 'cue', 'speech', 'walk-signal'] as const)[i % 5]
      track.push(ev(kind, i % 7 === 6 ? 'stop' : i % 3 === 0 ? 'start' : 'change', i * 0.3, { source: i % 4, agent: i, text: `line ${i}`, detail: i % 2 ? 'up' : 'ns', x: (i * 37) % 50 - 25, z: (i * 53) % 60 - 30 }), L)
    }
    return track.lines(12, L).map(captionText)
  }
  assert.deepEqual(run(), run())
})

// ---------------------------------------------------------------------------------------------------
// Compliance

/** The brands the operator scrubbed (compliance.test.ts SCRUBBED) and combat words no caption may carry. */
const SCRUBBED: readonly RegExp[] = [
  /\bxbox\b/i, /\bnintendo\b/i, /\bjoy-?cons?\b/i, /\bthe matrix\b/i, /\bmatrix[- ](?:style|like|rain|code|effect)\b/i, /\bdigital rain\b/i,
  /\b(attack|kill|weapon|target|shoot|gun|violence|injur\w*|damage|fight|hit|strike|crash|collide|collision|honk)\b/i,
]

test('no caption string carries a scrubbed brand, a combat word or a phrase the 14A screen refuses', () => {
  const kinds: SoundKind[] = ['engine', 'tyres', 'murmur', 'walk-signal', 'cue', 'speech', 'cabin', 'peer', 'ping']
  const details = [undefined, 'approaching', 'passing', 'up', 'down', 'idle', 'quiet', 'busy', 'ns', 'ew', 'muffled', 'clear']
  const texts = new Set<string>()
  for (const kind of kinds) for (const phase of ['start', 'change', 'stop'] as const) for (const detail of details) {
    texts.add(soundText(ev(kind, phase, 0, { detail })))
    texts.add(soundText(ev(kind, phase, 0, { detail, agent: 12, label: 'Pedestrian 12 (Rust)' })))
  }
  const track = new CaptionTrack({ maxLines: 64, capacity: 64 })
  kinds.forEach((k, i) => track.push(ev(k, 'start', 0, { source: i, agent: i, x: 10, z: -10 }), AT_ORIGIN))
  for (const line of track.lines(0)) texts.add(captionText(line))
  texts.delete('')
  assert.ok(texts.size >= 25, `${texts.size} caption strings`)
  for (const text of texts) {
    for (const re of SCRUBBED) assert.doesNotMatch(text, re, text)
    assert.equal(screen(text).admissible, true, text)
    assert.doesNotMatch(text, /[✕○△□]/u, text)
  }
})
