/**
 * Why does this file exist? It proves the seating plan: keyboard and mouse at seat 0, pads in index order into
 * the lowest free seat among 1..3 and then seat 0, a pad that disappears freeing its seat at once, seated pads
 * keeping their seat however the list is ordered or the table changes, HID pads at index 16+ seating like any
 * other, a table set for fewer players seating fewer pads — and that one seat's pad drives only that seat's
 * edges, analog frame and head motion.
 * What breaks if it is removed? Two players could swap bodies between frames, or a pad could go on steering
 * player 1 after joining as player 2, and nothing would notice.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PAD, PAD_EDGE, PadLook } from './gamepad.ts'
import { PITCH_LIMIT } from './input.ts'
import { clampPlayers, KEYBOARD_SEAT, PadSeat, queueEdges, SEATS, SEATS_RANGE, SeatTable, type Seat } from './seats.ts'
import type { GamepadLike } from './web-hardware.d.ts'
import type { Action } from './input.ts'

function pad(opts: { index?: number; id?: string; axes?: number[]; pressed?: number[]; values?: Record<number, number>; mapping?: string; connected?: boolean } = {}): GamepadLike {
  const buttons = Array.from({ length: 17 }, (_, i) => {
    const value = opts.values?.[i] ?? (opts.pressed?.includes(i) ? 1 : 0)
    return { pressed: value > 0.5 || !!opts.pressed?.includes(i), value }
  })
  return {
    id: opts.id ?? 'Test pad (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    index: opts.index ?? 0,
    connected: opts.connected ?? true,
    mapping: opts.mapping ?? 'standard',
    timestamp: 1,
    axes: opts.axes ?? [0, 0, 0, 0],
    buttons,
  }
}

/** seat → pad index for every seat, the table's whole state in one line. */
const plan = (t: SeatTable): number[] => Array.from({ length: SEATS }, (_, s) => t.padIndexOf(s))

test('constants: four seats, one to four players, the keyboard at seat 0', () => {
  assert.equal(SEATS, 4)
  assert.deepEqual(SEATS_RANGE, [1, 4])
  assert.ok(Object.isFrozen(SEATS_RANGE))
  assert.equal(KEYBOARD_SEAT, 0)
  assert.equal(clampPlayers(4), 4)
  assert.equal(clampPlayers(2.9), 2)
  assert.equal(clampPlayers(0), 1)
  assert.equal(clampPlayers(-3), 1)
  assert.equal(clampPlayers(99), 4)
  assert.equal(clampPlayers(NaN), 1)
  assert.equal(clampPlayers(Infinity), 4)
  assert.equal(new SeatTable().players, 1, 'one player by default: today\'s game')
  assert.equal(new SeatTable(7).players, 4)
})

test('four players: pads fill seats 1..3 in index order, then seat 0, then wait', () => {
  const t = new SeatTable(4)
  assert.equal(t.assign([pad({ index: 0 })]), true)
  assert.deepEqual(plan(t), [-1, 0, -1, -1], 'the first pad is player 2, not the keyboard\'s player')
  assert.equal(t.seatOf(0), 1)
  assert.equal(t.count, 1)
  // Two pads arrive in one frame, listed high index first: the lower index takes the lower seat.
  assert.equal(t.assign([pad({ index: 3 }), pad({ index: 0 }), pad({ index: 1 })]), true)
  assert.deepEqual(plan(t), [-1, 0, 1, 3])
  // A fourth pad shares seat 0 with the keyboard; a fifth has nowhere to sit.
  t.assign([pad({ index: 3 }), pad({ index: 0 }), pad({ index: 1 }), pad({ index: 5 }), pad({ index: 7 })])
  assert.deepEqual(plan(t), [5, 0, 1, 3])
  assert.equal(t.seatOf(7), -1)
  assert.equal(t.count, 4)
  assert.equal(t.occupied(0), true)
  assert.equal(t.occupied(3), true)
})

test('a lone pad drives player 1 when the table seats one player; a second pad waits', () => {
  const t = new SeatTable(1)
  t.assign([pad({ index: 0 }), pad({ index: 1 })])
  assert.deepEqual(plan(t), [0, -1, -1, -1])
  assert.equal(t.seatOf(1), -1)
  assert.equal(t.occupied(1), false, 'seat 1 is not in play')
  // Two players: seat 1 first, then the keyboard's seat.
  const two = new SeatTable(2)
  two.assign([pad({ index: 4 }), pad({ index: 2 }), pad({ index: 9 })])
  assert.deepEqual(plan(two), [4, 2, -1, -1])
  assert.equal(two.seatOf(9), -1)
})

test('a pad that disappears frees its seat at once; the next joiner takes the lowest free seat', () => {
  const t = new SeatTable(4)
  t.assign([pad({ index: 0 }), pad({ index: 1 }), pad({ index: 2 })])
  assert.deepEqual(plan(t), [-1, 0, 1, 2])
  // Pad 1 unplugged: seat 2 is free, the others keep theirs.
  assert.equal(t.assign([pad({ index: 0 }), pad({ index: 2 })]), true)
  assert.deepEqual(plan(t), [-1, 0, -1, 2])
  assert.equal(t.seatOf(1), -1)
  // A new pad joins the freed seat, not the end of the table.
  t.assign([pad({ index: 0 }), pad({ index: 2 }), pad({ index: 6 })])
  assert.deepEqual(plan(t), [-1, 0, 6, 2])
  // The same index coming back takes what is free then (seat 0, the last resort), never evicts anyone.
  t.assign([pad({ index: 0 }), pad({ index: 2 }), pad({ index: 6 }), pad({ index: 1 })])
  assert.deepEqual(plan(t), [1, 0, 6, 2])
  // A listed pad that reports disconnected is gone.
  t.assign([pad({ index: 0 }), pad({ index: 2, connected: false }), pad({ index: 6 }), pad({ index: 1 })])
  assert.deepEqual(plan(t), [1, 0, 6, -1])
  // Everyone gone.
  assert.equal(t.assign([]), true)
  assert.deepEqual(plan(t), [-1, -1, -1, -1])
  assert.equal(t.assign(null), false, 'nothing to change')
  assert.equal(t.count, 0)
})

test('stability: seated pads keep their seats across frames, list order and other pads coming and going', () => {
  const t = new SeatTable(4)
  const a = pad({ index: 2 }), b = pad({ index: 0 }), c = pad({ index: 17, id: 'DualSense (HID)' })
  t.assign([a, b, c])
  const first = plan(t)
  assert.deepEqual(first, [-1, 0, 2, 17], 'a HID-decoded pad at index 17 seats like any other')
  for (let frame = 0; frame < 50; frame++) {
    const list = frame % 2 ? [c, a, b] : [b, c, a]
    assert.equal(t.assign(list), false, `frame ${frame}: nothing changed`)
    assert.deepEqual(plan(t), first)
  }
  // The HAL lists HID pads first and reorders: still the same seats.
  t.assign([c, b, a, pad({ index: 1 })])
  assert.deepEqual(plan(t), [1, 0, 2, 17])
  t.assign([c, a, pad({ index: 1 })])
  assert.deepEqual(plan(t), [1, -1, 2, 17], 'pad 0 left: only its seat changed')
  t.assign([c, a, pad({ index: 1 }), pad({ index: 0 })])
  assert.deepEqual(plan(t), [1, 0, 2, 17], 'pad 0 back: the free seat, the others untouched')
})

test('deterministic: the same frames give the same plan, whatever the pads\' order in each frame', () => {
  const frames = [[0, 3], [3, 0, 1], [1, 3], [1, 3, 5, 2], [2, 5], [], [9, 8]]
  const run = (reverse: boolean) => {
    const t = new SeatTable(4)
    const out: number[][] = []
    for (const f of frames) {
      const list = f.map((index) => pad({ index }))
      t.assign(reverse ? list.reverse() : list)
      out.push(plan(t))
    }
    return out
  }
  const forward = run(false)
  assert.deepEqual(run(true), forward)
  assert.deepEqual(forward[forward.length - 1], [-1, 8, 9, -1])
})

test('only connected standard pads seat; a pad index below zero has no seat; seats outside the table read empty', () => {
  const t = new SeatTable(4)
  t.assign([pad({ index: 0, mapping: '' }), pad({ index: 1, connected: false }), null, undefined, pad({ index: 2 })])
  assert.deepEqual(plan(t), [-1, 2, -1, -1])
  assert.equal(t.seatOf(-1), -1)
  assert.equal(t.padIndexOf(-1), -1)
  assert.equal(t.padIndexOf(4), -1)
  assert.equal(t.occupied(4), false)
})

test('setPlayers shrinks the table and unseats pads beyond it; clear stands everyone up', () => {
  const t = new SeatTable(4)
  t.assign([pad({ index: 0 }), pad({ index: 1 }), pad({ index: 2 }), pad({ index: 3 })])
  assert.deepEqual(plan(t), [3, 0, 1, 2])
  t.setPlayers(2)
  assert.equal(t.players, 2)
  assert.deepEqual(plan(t), [3, 0, -1, -1])
  // The unseated pads do not come back while every seat in play is taken.
  assert.equal(t.assign([pad({ index: 0 }), pad({ index: 1 }), pad({ index: 2 }), pad({ index: 3 })]), false)
  assert.deepEqual(plan(t), [3, 0, -1, -1])
  t.setPlayers(4)
  t.assign([pad({ index: 0 }), pad({ index: 1 }), pad({ index: 2 }), pad({ index: 3 })])
  assert.deepEqual(plan(t), [3, 0, 1, 2], 'they rejoin in index order')
  t.clear()
  assert.deepEqual(plan(t), [-1, -1, -1, -1])
  t.setPlayers(0.5)
  assert.equal(t.players, 1)
})

test('queueEdges: every edge bit to its action, nothing else', () => {
  const q = new Set<Action>()
  queueEdges(0, q)
  assert.equal(q.size, 0)
  queueEdges(PAD_EDGE.interact | PAD_EDGE.timeBack, q)
  assert.deepEqual([...q].sort(), ['interact', 'timeBack'])
  queueEdges(PAD_EDGE.reset | PAD_EDGE.timeForward, q)
  assert.deepEqual([...q].sort(), ['interact', 'reset', 'timeBack', 'timeForward'])
  q.clear()
  queueEdges(1 << 30, q)
  assert.equal(q.size, 0)
})

test('PadSeat: edges and analog are per seat, and a held button never repeats', () => {
  const t = new SeatTable(4)
  const seats = [new PadSeat(), new PadSeat(), new PadSeat()]
  const poll = (pads: GamepadLike[], dt = 1 / 60) => {
    t.assign(pads)
    for (let s = 0; s < 3; s++) seats[s].poll(pads, t, (s + 1) as Seat, dt, 1000)
  }
  // Pad 0 is seat 1, pad 3 is seat 2. South on pad 3, the stick on pad 0.
  poll([pad({ index: 0, axes: [0, -1, 0, 0] }), pad({ index: 3, pressed: [PAD.south] })])
  assert.equal(seats[1].take('interact'), true, 'seat 2 got the press')
  assert.equal(seats[0].take('interact'), false, 'seat 1 did not')
  assert.equal(seats[2].take('interact'), false)
  assert.equal(seats[0].analog.moveY, 1, 'seat 1 walks forward')
  assert.equal(seats[1].analog.moveY, 0, 'seat 2 stands')
  assert.equal(seats[0].down('KeyW'), false, 'a pad has no keys')
  assert.equal(seats[1].active, true)
  assert.equal(seats[0].used, true)
  assert.equal(seats[2].used, false)
  assert.equal(seats[1].padFamily, 'numbered')
  assert.equal(seats[2].padFamily, null)
  // Still held: no second edge.
  poll([pad({ index: 0, axes: [0, -1, 0, 0] }), pad({ index: 3, pressed: [PAD.south] })])
  assert.equal(seats[1].take('interact'), false)
  // Released and pressed again: one more.
  poll([pad({ index: 0 }), pad({ index: 3 })])
  poll([pad({ index: 0 }), pad({ index: 3, pressed: [PAD.south, PAD.east] })])
  assert.equal(seats[1].take('interact'), true)
  assert.equal(seats[1].analog.handbrake, true)
  assert.equal(seats[0].analog.handbrake, false)
  // press() queues programmatically; release() drops what is queued.
  seats[2].press('reset')
  assert.equal(seats[2].take('reset'), true)
  seats[2].press('ghost')
  seats[2].release()
  assert.equal(seats[2].take('ghost'), false)
})

test('PadSeat: the right stick turns the head like Input (right = yaw down), pitch is clamped, lastLook is stamped', () => {
  const t = new SeatTable(4)
  const seat = new PadSeat()
  const dt = 1 / 60
  // A reference integration with the same look axis: the seat's yaw must match it exactly.
  const ref = new PadLook(), step = { yaw: 0, pitch: 0 }
  let refYaw = 0
  const right = pad({ index: 0, axes: [0, 0, 1, 0] })
  for (let i = 0; i < 60; i++) {
    t.assign([right])
    seat.poll([right], t, 1, dt, 500 + i)
    ref.step(1, 0, dt, step)
    refYaw -= step.yaw
  }
  assert.ok(seat.yaw < -1, `turned right: yaw ${seat.yaw}`)
  assert.ok(Math.abs(seat.yaw - refYaw) < 1e-12, 'the same eased look as a lone PadLook')
  assert.equal(seat.lastLook, 559, 'the caller\'s clock, at the last frame that looked')
  assert.equal(seat.pitch, -0.05, 'untouched: the stick was level')
  // Up, held for seconds: the head stops at the limit.
  const up = pad({ index: 0, axes: [0, 0, 0, -1] })
  for (let i = 0; i < 300; i++) { t.assign([up]); seat.poll([up], t, 1, dt, 2000) }
  assert.equal(seat.pitch, PITCH_LIMIT)
  // A pad in another seat does not move this head; a centred stick leaves lastLook alone.
  const before = seat.yaw, stamp = seat.lastLook
  const other = pad({ index: 5, axes: [0, 0, 1, 0] })
  t.assign([up, other])
  assert.equal(t.seatOf(5), 2)
  seat.release()
  seat.poll([pad({ index: 0 }), other], t, 1, dt, 9000)
  assert.equal(seat.yaw, before)
  assert.equal(seat.lastLook, stamp)
})
