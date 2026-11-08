// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the workstation cells (cells.ts) without Rapier: every cell with a robot builds
 * through the one judge, within the realm's bounds, with the joints its kind promises; the map from a workplace kind
 * to a cell covers the twenty kinds named and answers `console` for any other string, prototype names included; and
 * the URDF writer round-trips every cell and the built-in demo arm through urdf.ts to an equal manifest, names
 * escaped, a continuous joint's caps kept. (That each cell also stands in Rapier is articulated.test.ts's.)
 * What breaks if it is removed? A cell could carry a number the realm refuses, or come back from its own URDF changed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CELL_KINDS, CELL_OF_WORKPLACE, cellFor, cellManifest, toUrdf, type RobotCell } from './cells.ts'
import { buildable, buildManifest, validName } from './jointState.ts'
import { demoArm } from './robotLink.ts'
import { parseUrdf } from './urdf.ts'

const ROBOT_CELLS = CELL_KINDS.filter((k): k is RobotCell => k !== 'console')

test('every cell builds through the one judge, within the realm\'s bounds, with the joints its kind promises', () => {
  const promised: Record<RobotCell, string[]> = {
    arm: ['revolute', 'revolute', 'revolute', 'revolute', 'revolute', 'revolute'],
    gantry: ['prismatic', 'prismatic', 'revolute'],
    shaker: ['prismatic'],
    treadmill: ['continuous'],
  }
  assert.deepEqual(ROBOT_CELLS, ['arm', 'gantry', 'shaker', 'treadmill'])
  for (const c of ROBOT_CELLS) {
    const m = cellManifest(c, `${c}-0`)
    assert.equal(m.robot, `${c}-0`)
    assert.equal(buildable(m), null, c)
    assert.deepEqual(m.movable.map((i) => m.joints[i].kind), promised[c], c)
    assert.ok(m.links.every((l) => l.mass > 0 && validName(l.name)), `${c}: every link has a mass and a name`)
    assert.ok(m.links.every((l) => l.inertiaScale === undefined), `${c}: no inertia scale of its own`)
    for (const i of m.movable) {
      const j = m.joints[i]
      assert.ok(j.effort > 0 && j.velocity > 0, `${c}: ${j.name} has caps`)
      if (j.kind !== 'continuous') assert.ok(j.lower < j.upper, `${c}: ${j.name} has a range`)
    }
  }
  assert.throws(() => cellManifest('arm', 'bad name'), /name/)
})

test('the map: five cell kinds, the twenty workplace kinds named, console for any kind this file does not know', () => {
  assert.deepEqual(CELL_KINDS, ['arm', 'gantry', 'shaker', 'treadmill', 'console'])
  const expected: Record<string, string> = {
    roboticsLab: 'arm', warehouse: 'gantry', serverVault: 'console', metroOps: 'console', controlTower: 'console', kitchen: 'arm',
    microFab: 'gantry', twinStudio: 'console', fleetBay: 'arm', greenhouse: 'gantry', acousticsLab: 'shaker', responseCenter: 'console',
    clearingFloor: 'console', gaitLab: 'treadmill', microgrid: 'console', consoleDeck: 'console', telemetryCommand: 'console',
    boardroom: 'console', legalChambers: 'console', clinic: 'treadmill',
  }
  assert.equal(Object.keys(CELL_OF_WORKPLACE).length, 20)
  for (const [k, v] of Object.entries(expected)) assert.equal(cellFor(k), v, k)
  for (const v of Object.values(CELL_OF_WORKPLACE)) assert.ok(CELL_KINDS.includes(v))
  for (const k of ['nothing', '', 'constructor', 'toString', '__proto__', 'ROBOTICSLAB']) assert.equal(cellFor(k), 'console', k)
})

test('toUrdf round trip: every cell and the demo arm read back equal; names are escaped; a continuous joint keeps its caps', () => {
  for (const m of [...ROBOT_CELLS.map((c) => cellManifest(c, c)), demoArm()]) {
    const text = toUrdf(m)
    assert.ok(text.startsWith('<?xml version="1.0"?>\n<robot name="'), m.robot)
    const back = parseUrdf(text)
    assert.ok(back.ok, `${m.robot}: ${(back as { reason?: string }).reason}`)
    assert.deepEqual(back.value, m, m.robot)
  }
  const belt = toUrdf(cellManifest('treadmill', 'belt'))
  assert.match(belt, /<joint name="belt" type="continuous">/)
  assert.match(belt, /<limit effort="20" velocity="30"\/>/)
  assert.doesNotMatch(belt, /lower=/)
  assert.match(belt, /<cylinder radius="0.05" length="0.6"\/>/)
  // Names with XML's own characters, a dynamics element and a mimic survive the trip.
  // (A manifest name may carry &, < and >, never a double quote: jointState.ts reserves it with the line characters.)
  const odd = buildManifest('a&b<c>', [{ name: 'root', mass: 1 }, { name: 'tip', mass: 0 }, { name: 'twin', mass: 0.5, shape: { kind: 'sphere', radius: 0.01 } }], [
    { name: "j'1", kind: 'revolute', parent: 'root', child: 'tip', axis: [1, 1, 0], lower: -1, upper: 1, effort: 2, velocity: 3, damping: 0.1 },
    { name: 'j2', kind: 'prismatic', parent: 'tip', child: 'twin', axis: [0, 0, 1], lower: 0, upper: 0.1, effort: 2, velocity: 3, mimic: { joint: "j'1", multiplier: 2, offset: 0.5 } },
  ])
  assert.ok(odd.ok, (odd as { reason?: string }).reason)
  const text = toUrdf(odd.value)
  assert.match(text, /<robot name="a&amp;b&lt;c&gt;">/)
  assert.match(text, /<dynamics damping="0.1" friction="0"\/>/)
  assert.match(text, /<mimic joint="j'1" multiplier="2" offset="0.5"\/>/)
  const back = parseUrdf(text)
  assert.ok(back.ok, (back as { reason?: string }).reason)
  assert.equal(back.value.robot, 'a&b<c>')
  assert.deepEqual(back.value.joints[1].mimic, { joint: "j'1", multiplier: 2, offset: 0.5 })
  assert.equal(back.value.joints[0].damping, 0.1)
  const a = back.value.joints[0].axis
  assert.ok(Math.abs(a[0] - Math.SQRT1_2) < 1e-12 && Math.abs(a[1] - Math.SQRT1_2) < 1e-12, 'a diagonal axis comes back normalised')
})
