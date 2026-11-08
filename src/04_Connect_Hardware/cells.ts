// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the workstation cells of the indoor workplaces (01_Initialize_World/interiors.ts):
 * the robot a station of each kind of room would have, as a joint-bridge manifest the realm builds like any robot.
 * Five cell kinds: `arm`, a six-joint revolute chain of a tabletop collaborative arm's size (about 15 kg, 60 N·m at
 * the shoulder); `gantry`, two prismatic axes under a slab and a wrist, a pick-and-place frame; `shaker`, one
 * prismatic axis of ±25 mm under a table, a vibration table; `treadmill`, one continuous joint, the front roller of a
 * gait belt (a 50 mm roller at 30 rad/s is 1.5 m/s, a walking pace); and `console`, a desk with no robot. A map from
 * a workplace kind id to its cell covers the kinds the city has and the ones being added, keyed by string with
 * `console` for any kind it does not know, so a new room kind needs no change here to be legal. `toUrdf` writes any
 * manifest back out as URDF XML that urdf.ts reads to an equal manifest (the round trip is the test), so a cell can
 * be handed to a ROS tool, and a URDF-described robot can stand at a station. Every number is inside
 * jointState.ts REALM_BOUNDS and every cell goes through buildManifest, so the realm never sees one it would refuse.
 * Pure: no DOM, no three.js, no engine; the engine's rooms reach it only through the console's `robot cell`.
 * What breaks if it is removed? The workplaces have stations but nothing to put at them, and no manifest can be
 * written back out as a URDF.
 */
import { buildManifest, type JointSpec, type LinkSpec, type Manifest } from './jointState.ts'

export type CellKind = 'arm' | 'gantry' | 'shaker' | 'treadmill' | 'console'
export const CELL_KINDS: readonly CellKind[] = Object.freeze(['arm', 'gantry', 'shaker', 'treadmill', 'console'])
/** The cells that have a robot. */
export type RobotCell = Exclude<CellKind, 'console'>

/**
 * Which cell a workplace kind gets, by its id. The six kinds the city has today and the sixteen that are coming are
 * all here; anything else is a `console` (cellFor). Keyed by string on purpose: never by the workplace enumeration.
 */
export const CELL_OF_WORKPLACE: Readonly<Record<string, CellKind>> = Object.freeze({
  roboticsLab: 'arm', warehouse: 'gantry', serverVault: 'console', metroOps: 'console', controlTower: 'console', kitchen: 'arm',
  microFab: 'gantry', twinStudio: 'console', fleetBay: 'arm', greenhouse: 'gantry', acousticsLab: 'shaker', responseCenter: 'console',
  clearingFloor: 'console', gaitLab: 'treadmill', microgrid: 'console', consoleDeck: 'console', telemetryCommand: 'console',
  boardroom: 'console', legalChambers: 'console', clinic: 'treadmill',
})

/** The cell of a workplace kind id; `console` for a kind this file does not know. */
export function cellFor(kind: string): CellKind {
  return Object.hasOwn(CELL_OF_WORKPLACE, kind) ? CELL_OF_WORKPLACE[kind] : 'console'
}

type Links = { name: string; mass: number; shape: LinkSpec['shape']; shapeOrigin?: LinkSpec['shapeOrigin'] }[]
type Joints = Partial<JointSpec>[]

const up = (z: number): LinkSpec['shapeOrigin'] => ({ xyz: [0, 0, z], rpy: [0, 0, 0] })
const at = (x: number, y: number, z: number): JointSpec['origin'] => ({ xyz: [x, y, z], rpy: [0, 0, 0] })

/**
 * A six-joint arm: yaw, shoulder, elbow, wrist roll, wrist pitch, tool roll, stacked along z as a tabletop
 * collaborative arm is (reach about 0.9 m, 14.6 kg). Efforts fall from 60 N·m at the shoulder to 6 N·m at the tool
 * and speeds rise from 3 to 6 rad/s, the proportions of that class; the limits leave each joint short of a full turn.
 */
function arm(): { links: Links; joints: Joints } {
  return {
    links: [
      { name: 'base', mass: 6, shape: { kind: 'cylinder', radius: 0.1, length: 0.12 }, shapeOrigin: up(0.06) },
      { name: 'shoulder_link', mass: 3, shape: { kind: 'cylinder', radius: 0.06, length: 0.15 }, shapeOrigin: up(0.075) },
      { name: 'upper_arm', mass: 2.5, shape: { kind: 'capsule', radius: 0.045, length: 0.35 }, shapeOrigin: up(0.175) },
      { name: 'forearm', mass: 1.5, shape: { kind: 'capsule', radius: 0.04, length: 0.3 }, shapeOrigin: up(0.15) },
      { name: 'wrist_1', mass: 0.8, shape: { kind: 'cylinder', radius: 0.035, length: 0.08 }, shapeOrigin: up(0.04) },
      { name: 'wrist_2', mass: 0.5, shape: { kind: 'cylinder', radius: 0.03, length: 0.08 }, shapeOrigin: up(0.04) },
      { name: 'tool', mass: 0.3, shape: { kind: 'box', size: [0.05, 0.05, 0.08] }, shapeOrigin: up(0.04) },
    ],
    joints: [
      { name: 'base_yaw', kind: 'revolute', parent: 'base', child: 'shoulder_link', origin: at(0, 0, 0.12), axis: [0, 0, 1], lower: -2.9, upper: 2.9, effort: 60, velocity: 3 },
      { name: 'shoulder_pitch', kind: 'revolute', parent: 'shoulder_link', child: 'upper_arm', origin: at(0, 0, 0.15), axis: [0, 1, 0], lower: -2, upper: 2, effort: 60, velocity: 3 },
      { name: 'elbow', kind: 'revolute', parent: 'upper_arm', child: 'forearm', origin: at(0, 0, 0.35), axis: [0, 1, 0], lower: -2.5, upper: 2.5, effort: 30, velocity: 3 },
      { name: 'wrist_roll', kind: 'revolute', parent: 'forearm', child: 'wrist_1', origin: at(0, 0, 0.3), axis: [0, 0, 1], lower: -3, upper: 3, effort: 12, velocity: 4 },
      { name: 'wrist_pitch', kind: 'revolute', parent: 'wrist_1', child: 'wrist_2', origin: at(0, 0, 0.08), axis: [0, 1, 0], lower: -2, upper: 2, effort: 12, velocity: 4 },
      { name: 'tool_roll', kind: 'revolute', parent: 'wrist_2', child: 'tool', origin: at(0, 0, 0.08), axis: [0, 0, 1], lower: -3.1, upper: 3.1, effort: 6, velocity: 6 },
    ],
  }
}

/**
 * A gantry: a 1.4 × 1.0 m slab a metre up (40 kg, the frame), a carriage on a 1.2 m rail along x, a cross slide of
 * 0.8 m along y and a wrist about z. Linear efforts of 200 and 150 N at 1 m/s move a few kilograms briskly; the
 * wrist's 5 N·m turns a light head.
 */
function gantry(): { links: Links; joints: Joints } {
  return {
    links: [
      { name: 'frame', mass: 40, shape: { kind: 'box', size: [1.4, 1, 0.08] }, shapeOrigin: up(1) },
      { name: 'carriage', mass: 6, shape: { kind: 'box', size: [0.12, 0.12, 0.08] } },
      { name: 'cross_slide', mass: 3, shape: { kind: 'box', size: [0.1, 0.1, 0.06] } },
      { name: 'head', mass: 0.5, shape: { kind: 'cylinder', radius: 0.03, length: 0.1 }, shapeOrigin: up(-0.05) },
    ],
    joints: [
      { name: 'rail', kind: 'prismatic', parent: 'frame', child: 'carriage', origin: at(-0.6, -0.4, 0.9), axis: [1, 0, 0], lower: 0, upper: 1.2, effort: 200, velocity: 1 },
      { name: 'cross', kind: 'prismatic', parent: 'carriage', child: 'cross_slide', origin: at(0, 0, -0.08), axis: [0, 1, 0], lower: 0, upper: 0.8, effort: 150, velocity: 1 },
      { name: 'wrist', kind: 'revolute', parent: 'cross_slide', child: 'head', origin: at(0, 0, -0.04), axis: [0, 0, 1], lower: -3.14, upper: 3.14, effort: 5, velocity: 6 },
    ],
  }
}

/** A vibration table: a 30 kg base and an 8 kg table on one vertical axis of ±25 mm, 2 kN at up to 1 m/s. */
function shaker(): { links: Links; joints: Joints } {
  return {
    links: [
      { name: 'base', mass: 30, shape: { kind: 'box', size: [0.8, 0.8, 0.5] }, shapeOrigin: up(0.25) },
      { name: 'table', mass: 8, shape: { kind: 'box', size: [0.6, 0.6, 0.04] }, shapeOrigin: up(0.02) },
    ],
    joints: [
      { name: 'vibrate', kind: 'prismatic', parent: 'base', child: 'table', origin: at(0, 0, 0.55), axis: [0, 0, 1], lower: -0.025, upper: 0.025, effort: 2000, velocity: 1 },
    ],
  }
}

/**
 * A gait belt: a 25 kg deck and its front roller (a 50 mm cylinder lying across the deck, 4 kg) on one continuous
 * joint about y; 20 N·m at up to 30 rad/s, which is 1.5 m/s at the belt, a walking pace.
 */
function treadmill(): { links: Links; joints: Joints } {
  return {
    links: [
      { name: 'deck', mass: 25, shape: { kind: 'box', size: [1.6, 0.7, 0.15] }, shapeOrigin: up(0.075) },
      { name: 'roller', mass: 4, shape: { kind: 'cylinder', radius: 0.05, length: 0.6 }, shapeOrigin: { xyz: [0, 0, 0], rpy: [Math.PI / 2, 0, 0] } },
    ],
    joints: [
      { name: 'belt', kind: 'continuous', parent: 'deck', child: 'roller', origin: at(0.6, 0, 0.2), axis: [0, 1, 0], effort: 20, velocity: 30 },
    ],
  }
}

const CELLS: Readonly<Record<RobotCell, () => { links: Links; joints: Joints }>> = Object.freeze({ arm, gantry, shaker, treadmill })

/** The manifest of a cell's robot, named `name` (a robot name: letters, digits, _ . -), through the one judge. */
export function cellManifest(cell: RobotCell, name: string): Manifest {
  const c = CELLS[cell]()
  const m = buildManifest(name, c.links, c.joints)
  if (!m.ok) throw new Error(`cell ${cell}: ${m.reason}`)
  return m.value
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const vec = (v: readonly number[]): string => v.map(String).join(' ')

/**
 * A manifest as URDF XML: each link's mass and its shape as a `<collision>`, each joint's origin, parent, child, axis,
 * limit (effort and velocity alone for a continuous joint that has them), dynamics when nonzero and mimic when
 * present. Numbers are written in full, so urdf.ts parseUrdf reads the text back to an equal manifest. Not carried:
 * a link's inertiaScale (a URDF holds a tensor, which the reader does not read) and the shape origin of a link
 * without a shape.
 */
export function toUrdf(m: Manifest): string {
  const lines = ['<?xml version="1.0"?>', `<robot name="${esc(m.robot)}">`]
  for (const l of m.links) {
    lines.push(`  <link name="${esc(l.name)}">`)
    if (l.mass > 0) lines.push(`    <inertial><mass value="${l.mass}"/></inertial>`)
    const s = l.shape
    if (s.kind !== 'none') {
      const geometry = s.kind === 'box' ? `<box size="${vec(s.size)}"/>` : s.kind === 'sphere' ? `<sphere radius="${s.radius}"/>` : `<${s.kind} radius="${s.radius}" length="${s.length}"/>`
      lines.push(`    <collision><origin xyz="${vec(l.shapeOrigin.xyz)}" rpy="${vec(l.shapeOrigin.rpy)}"/><geometry>${geometry}</geometry></collision>`)
    }
    lines.push('  </link>')
  }
  for (const j of m.joints) {
    lines.push(`  <joint name="${esc(j.name)}" type="${j.kind}">`)
    lines.push(`    <origin xyz="${vec(j.origin.xyz)}" rpy="${vec(j.origin.rpy)}"/>`)
    lines.push(`    <parent link="${esc(j.parent)}"/>`)
    lines.push(`    <child link="${esc(j.child)}"/>`)
    lines.push(`    <axis xyz="${vec(j.axis)}"/>`)
    if (j.kind === 'revolute' || j.kind === 'prismatic') lines.push(`    <limit lower="${j.lower}" upper="${j.upper}" effort="${j.effort}" velocity="${j.velocity}"/>`)
    else if (j.effort > 0 || j.velocity > 0) lines.push(`    <limit effort="${j.effort}" velocity="${j.velocity}"/>`)
    if (j.damping > 0 || j.friction > 0) lines.push(`    <dynamics damping="${j.damping}" friction="${j.friction}"/>`)
    if (j.mimic) lines.push(`    <mimic joint="${esc(j.mimic.joint)}" multiplier="${j.mimic.multiplier}" offset="${j.mimic.offset}"/>`)
    lines.push('  </joint>')
  }
  lines.push('</robot>', '')
  return lines.join('\n')
}
