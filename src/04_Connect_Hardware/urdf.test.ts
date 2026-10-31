// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the URDF reader (urdf.ts): the XML reader on what a robot description file
 * carries (a declaration, a doctype, comments, CDATA, entities, both quote styles, self-closing tags, balanced and
 * unbalanced tags), a two-joint arm read whole (links, masses, shapes, joint kinds, origins, axes normalised, limits,
 * dynamics, mimic, the root and the movable order), urdfdom's refusals with urdfdom's own sentences (no type, a
 * revolute joint without limits, a limit without effort or velocity, a dynamics with nothing in it, no parent or
 * child, no robot name), a mesh as no shape, and a xacro file turned away before parsing. No robot here.
 * What breaks if it is removed? A URDF could be read into the wrong tree, or a bad one accepted, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseUrdf, parseVec3, parseXml } from './urdf.ts'

const ARM = `<?xml version="1.0"?>
<!DOCTYPE robot [ <!ENTITY pi "3.14159"> ]>
<!-- a two-joint arm on a fixed base -->
<robot name="arm2">
  <link name="base">
    <inertial><mass value="4.0"/><inertia ixx="1" ixy="0" ixz="0" iyy="1" iyz="0" izz="1"/></inertial>
    <collision><origin xyz="0 0 0.05"/><geometry><box size="0.2 0.2 0.1"/></geometry></collision>
    <visual><geometry><mesh filename="package://arm/meshes/base.stl"/></geometry></visual>
  </link>
  <link name='upper'>
    <inertial><mass value='1.5'/></inertial>
    <visual><origin xyz="0 0 0.15" rpy="0 0 0"/><geometry><cylinder radius="0.03" length="0.3"/></geometry></visual>
  </link>
  <link name="fore">
    <inertial><mass value="0.8"/></inertial>
    <collision><geometry><capsule radius="0.02" length="0.25"/></geometry></collision>
  </link>
  <link name="tool"><visual><geometry><mesh filename="tool.dae"/></geometry></visual></link>
  <joint name="shoulder" type="revolute">
    <parent link="base"/><child link="upper"/>
    <origin xyz="0 0 0.1" rpy="0 0 1.5708"/>
    <axis xyz="0 2 0"/>
    <limit lower="-1.57" upper="1.57" effort="20" velocity="2.5"/>
    <dynamics damping="0.1" friction="0.05"/>
  </joint>
  <joint name="elbow" type="revolute">
    <parent link="upper"/><child link="fore"/>
    <origin xyz="0 0 0.3"/>
    <axis xyz="0 1 0"/>
    <limit upper="2.4" effort="10" velocity="3"/>
  </joint>
  <joint name="wrist_fixed" type="fixed">
    <parent link="fore"/><child link="tool"/>
    <origin xyz="0 0 0.25"/>
  </joint>
  <![CDATA[ not for us ]]>
  <gazebo reference="base"><material>Gazebo/Grey</material></gazebo>
</robot>
`

test('the XML reader: declaration, doctype, comments, CDATA, entities, both quotes, self-closing and nested tags', () => {
  const r = parseXml(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e "v">]><!-- c --><a x="1 &amp; 2" y='&lt;&#65;&#x42;&apos;'><b/><c>text<![CDATA[<d>]]></c><!-- --></a>`)
  assert.ok(r.ok)
  assert.equal(r.value.name, 'a')
  assert.deepEqual(r.value.attrs, { x: '1 & 2', y: "<AB'" })
  assert.deepEqual(r.value.children.map((c) => c.name), ['b', 'c'])
  assert.equal(r.value.children[1].children.length, 0, 'CDATA is skipped, text is dropped')
  for (const [text, why] of [
    ['<a><b></a>', /<\/a> closes <b>/],
    ['<a>', /unterminated <a>/],
    ['<a x=1/>', /quoted value expected/],
    ['<a x="1" x="2"/>', /given twice/],
    ['<a/><b/>', /second root/],
    ['no tags', /no root element/],
    ['</a>', /nothing open/],
    ['<a><!-- never closed', /unterminated comment/],
  ] as const) {
    const bad = parseXml(text)
    assert.ok(!bad.ok && why.test(bad.reason), `${text}: ${bad.ok ? 'accepted' : bad.reason}`)
  }
  assert.deepEqual(parseVec3(' 1  -2.5\t3e-2 ', 'v'), { ok: true, value: [1, -2.5, 0.03] })
  assert.ok(!parseVec3('1 2', 'v').ok && !parseVec3('1 2 x', 'v').ok && !parseVec3(undefined, 'v').ok)
})

test('a two-joint arm is read whole: links, masses, shapes, joints in order, axes normalised, the root and the movable order', () => {
  const r = parseUrdf(ARM)
  assert.ok(r.ok, r.ok ? '' : r.reason)
  const m = r.value
  assert.equal(m.robot, 'arm2')
  assert.equal(m.root, 'base')
  assert.deepEqual(m.links.map((l) => [l.name, l.mass, l.shape.kind]), [['base', 4, 'box'], ['upper', 1.5, 'cylinder'], ['fore', 0.8, 'capsule'], ['tool', 0, 'none']])
  assert.deepEqual(m.links[0].shape, { kind: 'box', size: [0.2, 0.2, 0.1] })
  assert.deepEqual(m.links[0].shapeOrigin, { xyz: [0, 0, 0.05], rpy: [0, 0, 0] }, 'the collision shape is preferred to the visual mesh')
  assert.deepEqual(m.links[1].shape, { kind: 'cylinder', radius: 0.03, length: 0.3 })
  assert.deepEqual(m.links[1].shapeOrigin.xyz, [0, 0, 0.15], 'the visual serves when there is no collision')
  assert.deepEqual(m.joints.map((j) => [j.name, j.kind, j.parent, j.child]), [['shoulder', 'revolute', 'base', 'upper'], ['elbow', 'revolute', 'upper', 'fore'], ['wrist_fixed', 'fixed', 'fore', 'tool']])
  const s = m.joints[0]
  assert.deepEqual(s.origin, { xyz: [0, 0, 0.1], rpy: [0, 0, 1.5708] })
  assert.deepEqual(s.axis, [0, 1, 0], 'the axis is normalised')
  assert.deepEqual([s.lower, s.upper, s.effort, s.velocity, s.damping, s.friction], [-1.57, 1.57, 20, 2.5, 0.1, 0.05])
  const e = m.joints[1]
  assert.deepEqual([e.lower, e.upper, e.effort, e.velocity, e.damping, e.friction], [0, 2.4, 10, 3, 0, 0], 'lower defaults to 0; no dynamics is 0 and 0')
  assert.deepEqual(m.joints[2].origin.xyz, [0, 0, 0.25])
  assert.deepEqual(m.movable, [0, 1], 'the fixed wrist has no entry in q')
})

test('urdfdom\'s refusals, with its sentences: type, limits, effort, velocity, dynamics, parent, child, the robot\'s name', () => {
  const robot = (body: string, name = ' name="r"') => `<robot${name}><link name="a"/><link name="b"/>${body}</robot>`
  const cases: [string, RegExp][] = [
    [robot('<joint name="j"><parent link="a"/><child link="b"/></joint>'), /has no type, check to see if it's a reference/],
    [robot('<joint name="j" type="revolute"><parent link="a"/><child link="b"/></joint>'), /is of type REVOLUTE but it does not specify limits/],
    [robot('<joint name="j" type="prismatic"><parent link="a"/><child link="b"/></joint>'), /is of type PRISMATIC without limits|PRISMATIC but it does not specify limits/],
    [robot('<joint name="j" type="revolute"><parent link="a"/><child link="b"/><limit velocity="1"/></joint>'), /joint limit: no effort/],
    [robot('<joint name="j" type="revolute"><parent link="a"/><child link="b"/><limit effort="1"/></joint>'), /joint limit: no velocity/],
    [robot('<joint name="j" type="continuous"><parent link="a"/><child link="b"/><dynamics/></joint>'), /joint dynamics element specified with no damping and no friction/],
    [robot('<joint name="j" type="fixed"><child link="b"/></joint>'), /parent link name is not specified/],
    [robot('<joint name="j" type="fixed"><parent link="a"/></joint>'), /child link name is not specified/],
    [robot('<joint name="j" type="bendy"><parent link="a"/><child link="b"/></joint>'), /has no known type/],
    [robot('<joint name="j" type="fixed"><parent link="a"/><child link="c"/></joint>'), /child link 'c' is not declared/],
    [robot('<joint name="j" type="fixed"><parent link="a"/><child link="b"/><mimic/></joint>'), /no mimic joint specified/],
    [robot('<joint name="j" type="fixed"><parent link="a"/><child link="b"/><axis xyz="0 0 0"/></joint>'), /axis is the zero vector/],
    [robot('<joint name="j" type="revolute"><parent link="a"/><child link="b"/><limit lower="1" upper="0" effort="1" velocity="1"/></joint>'), /lower 1 is above upper 0/],
    [robot('<joint name="j" type="fixed"><parent link="a"/><child link="b"/></joint>', ''), /No name given for the robot/],
    ['<robot name="r"><link name="a"/><link name="b"/></robot>', /more than one root link/],
    ['<robot name="r"><link name="a"/><link name="b"/><joint name="j" type="fixed"><parent link="a"/><child link="b"/></joint><joint name="k" type="fixed"><parent link="b"/><child link="a"/></joint></robot>', /no root link/],
    ['<robot name="r"><link name="a"/><link name="a"/></robot>', /declared twice/],
    ['<robot name="r"><link name="a"/><link name="b"/><link name="c"/><joint name="j" type="fixed"><parent link="a"/><child link="b"/></joint><joint name="k" type="fixed"><parent link="c"/><child link="b"/></joint></robot>', /has two parents/],
    ['<robot name="r"><link name="a"/><link name="b"/><link name="c"/><link name="d"/><joint name="j" type="fixed"><parent link="a"/><child link="b"/></joint><joint name="k" type="fixed"><parent link="c"/><child link="d"/></joint><joint name="l" type="fixed"><parent link="d"/><child link="c"/></joint></robot>', /not reached from the root/],
    ['<robot name="r"><link name="a"><inertial><mass value="-1"/></inertial></link></robot>', /mass must be a finite number/],
    ['<robot name="r"><link name="a"><collision><geometry><box size="1 1"/></geometry></collision></link></robot>', /box size needs three numbers/],
    ['<robot name="r"><link name="a"><collision><geometry><torus r="1"/></geometry></collision></link></robot>', /unknown geometry <torus>/],
    ['<model name="r"/>', /root element is <model>, not <robot>/],
    ['<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r"><xacro:property name="w" value="1"/></robot>', /xacro file: expand it first/],
    ['<robot name="r"><link name="a" width="${w}"/></robot>', /xacro/],
  ]
  for (const [text, why] of cases) {
    const r = parseUrdf(text)
    assert.ok(!r.ok, `accepted: ${text}`)
    assert.match(r.reason, why, text)
  }
})

test('what is read leniently: a mesh is a link with no shape, a mimic is recorded, a continuous joint keeps no limits, a single link is a robot', () => {
  const r = parseUrdf(`<robot name="wheel"><link name="body"><visual><geometry><mesh filename="x.stl"/></geometry></visual></link><link name="w"><collision><geometry><sphere radius="0.1"/></geometry></collision></link><link name="w2"/>
    <joint name="axle" type="continuous"><parent link="body"/><child link="w"/><axis xyz="0 0 1"/><limit lower="-9" upper="9" effort="5" velocity="50"/><dynamics damping="0.01"/></joint>
    <joint name="axle2" type="continuous"><parent link="body"/><child link="w2"/><axis xyz="0 0 1"/><mimic joint="axle" multiplier="-1"/></joint></robot>`)
  assert.ok(r.ok, r.ok ? '' : r.reason)
  assert.equal(r.value.links[0].shape.kind, 'none')
  const a = r.value.joints[0]
  assert.deepEqual([a.lower, a.upper, a.effort, a.velocity, a.damping], [0, 0, 5, 50, 0.01], 'a continuous joint keeps its caps and drops its range')
  assert.deepEqual(r.value.joints[1].mimic, { joint: 'axle', multiplier: -1, offset: 0 })
  assert.deepEqual(r.value.movable, [0, 1])
  const one = parseUrdf('<robot name="brick"><link name="only"/></robot>')
  assert.ok(one.ok && one.value.root === 'only' && one.value.movable.length === 0)
})
