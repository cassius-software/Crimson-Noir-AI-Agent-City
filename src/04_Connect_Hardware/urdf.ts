// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It reads a URDF (the Unified Robot Description Format, the XML every ROS robot is
 * described in) into the joint bridge's manifest (jointState.ts): the robot's name, each `<link>` with its mass and
 * the first collision or visual shape it names, and each `<joint>` with its type, parent, child, origin, axis,
 * limits, dynamics and mimic, in document order. It carries its own small XML reader (elements, attributes, the five
 * entities, comments, processing instructions and CDATA skipped) because the page has a DOMParser and Node has
 * none, and one reader proved in Node is worth more than two. It reads what urdfdom reads and refuses what urdfdom
 * refuses, with the same sentences where it has them: an unknown joint type, a revolute or prismatic joint without a
 * `<limit>` or a limit without effort or velocity, a `<dynamics>` with neither attribute, a mesh (which the realm
 * cannot load: the link gets no shape), and a file that still carries xacro (macros are not expanded here). Pure.
 * What breaks if it is removed? A robot can be described to the bridge only as JSON by hand.
 */
import { buildManifest, type Checked, type Manifest, type Pose, type Shape, type Vec3 } from './jointState.ts'

/** One element of the XML tree: text is dropped (a URDF carries everything in attributes). */
export interface XmlElement { readonly name: string; readonly attrs: Readonly<Record<string, string>>; readonly children: readonly XmlElement[] }

const ENTITIES: Readonly<Record<string, string>> = Object.freeze({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })
function unescape(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole
    }
    return ENTITIES[e] ?? whole
  })
}

const NAME_START = /[A-Za-z_:]/
const NAME_CHAR = /[A-Za-z0-9_:.-]/

/**
 * Reads one XML document into its root element. Strict about what a URDF needs (balanced tags, quoted attributes)
 * and lenient about what it does not (a doctype, processing instructions and comments are skipped).
 */
export function parseXml(text: string): Checked<XmlElement> {
  let i = 0
  const n = text.length
  const fail = (what: string): { ok: false; reason: string } => ({ ok: false, reason: `XML: ${what} at offset ${i}` })
  const skipSpace = () => { while (i < n && /\s/.test(text[i])) i++ }
  const readName = (): string | null => {
    if (i >= n || !NAME_START.test(text[i])) return null
    const s = i
    i++
    while (i < n && NAME_CHAR.test(text[i])) i++
    return text.slice(s, i)
  }
  type Open = { name: string; attrs: Record<string, string>; children: XmlElement[] }
  const stack: Open[] = []
  let root: XmlElement | null = null
  const close = (el: Open): Checked<XmlElement> | null => {
    const done: XmlElement = { name: el.name, attrs: Object.freeze(el.attrs), children: Object.freeze(el.children) }
    if (stack.length) { stack[stack.length - 1].children.push(done); return null }
    if (root) return fail('a second root element')
    root = done
    return null
  }
  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      if (stack.length) return fail(`unterminated <${stack[stack.length - 1].name}>`)
      break
    }
    i = lt
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4)
      if (end < 0) return fail('unterminated comment')
      i = end + 3
      continue
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9)
      if (end < 0) return fail('unterminated CDATA')
      i = end + 3
      continue
    }
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i + 2)
      if (end < 0) return fail('unterminated processing instruction')
      i = end + 2
      continue
    }
    if (text.startsWith('<!', i)) {
      // A doctype, possibly with an internal subset in brackets.
      let depth = 0
      let j = i + 2
      for (; j < n; j++) {
        if (text[j] === '[') depth++
        else if (text[j] === ']') depth--
        else if (text[j] === '>' && depth <= 0) break
      }
      if (j >= n) return fail('unterminated doctype')
      i = j + 1
      continue
    }
    if (text.startsWith('</', i)) {
      i += 2
      const name = readName()
      if (!name) return fail('a close tag without a name')
      skipSpace()
      if (text[i] !== '>') return fail(`'>' expected after </${name}`)
      i++
      const open = stack.pop()
      if (!open) return fail(`</${name}> with nothing open`)
      if (open.name !== name) return fail(`</${name}> closes <${open.name}>`)
      const r = close(open)
      if (r) return r
      continue
    }
    i++
    const name = readName()
    if (!name) return fail('a tag without a name')
    const attrs: Record<string, string> = {}
    for (;;) {
      skipSpace()
      if (i >= n) return fail(`unterminated <${name}>`)
      if (text[i] === '/' && text[i + 1] === '>') {
        i += 2
        const r = close({ name, attrs, children: [] })
        if (r) return r
        break
      }
      if (text[i] === '>') {
        i++
        stack.push({ name, attrs, children: [] })
        break
      }
      const key = readName()
      if (!key) return fail(`an attribute without a name in <${name}>`)
      skipSpace()
      if (text[i] !== '=') return fail(`'=' expected after ${key} in <${name}>`)
      i++
      skipSpace()
      const quote = text[i]
      if (quote !== '"' && quote !== "'") return fail(`a quoted value expected for ${key} in <${name}>`)
      const end = text.indexOf(quote, i + 1)
      if (end < 0) return fail(`unterminated value of ${key} in <${name}>`)
      if (key in attrs) return fail(`attribute ${key} given twice in <${name}>`)
      attrs[key] = unescape(text.slice(i + 1, end))
      i = end + 1
    }
  }
  if (stack.length) return fail(`unterminated <${stack[stack.length - 1].name}>`)
  if (!root) return { ok: false, reason: 'XML: no root element' }
  return { ok: true, value: root }
}

const child = (el: XmlElement, name: string): XmlElement | undefined => el.children.find((c) => c.name === name)
const bad = (reason: string): { ok: false; reason: string } => ({ ok: false, reason })

/** "x y z" (any whitespace) as three finite numbers. */
export function parseVec3(s: string | undefined, what: string): Checked<Vec3> {
  if (s === undefined) return bad(`${what} is missing`)
  const parts = s.trim().split(/\s+/)
  if (parts.length !== 3) return bad(`${what} needs three numbers, got '${s}'`)
  const v = parts.map(Number)
  if (!v.every(Number.isFinite)) return bad(`${what} is not three numbers: '${s}'`)
  return { ok: true, value: [v[0], v[1], v[2]] }
}

function parseNumber(s: string | undefined, what: string): Checked<number> {
  if (s === undefined) return bad(`${what} is missing`)
  const v = Number(s.trim())
  if (s.trim() === '' || !Number.isFinite(v)) return bad(`${what} is not a number: '${s}'`)
  return { ok: true, value: v }
}

function parseOrigin(el: XmlElement | undefined, what: string): Checked<Pose> {
  if (!el) return { ok: true, value: { xyz: [0, 0, 0], rpy: [0, 0, 0] } }
  const xyz = el.attrs.xyz === undefined ? { ok: true as const, value: [0, 0, 0] as Vec3 } : parseVec3(el.attrs.xyz, `${what} origin xyz`)
  if (!xyz.ok) return xyz
  const rpy = el.attrs.rpy === undefined ? { ok: true as const, value: [0, 0, 0] as Vec3 } : parseVec3(el.attrs.rpy, `${what} origin rpy`)
  if (!rpy.ok) return rpy
  return { ok: true, value: { xyz: xyz.value, rpy: rpy.value } }
}

function parseGeometry(g: XmlElement | undefined, what: string): Checked<Shape> {
  const shape = g?.children[0]
  if (!shape) return bad(`${what}: a geometry needs a shape`)
  switch (shape.name) {
    case 'box': {
      const size = parseVec3(shape.attrs.size, `${what} box size`)
      return size.ok ? { ok: true, value: { kind: 'box', size: size.value } } : size
    }
    case 'cylinder':
    case 'capsule': {
      const radius = parseNumber(shape.attrs.radius, `${what} ${shape.name} radius`)
      if (!radius.ok) return radius
      const length = parseNumber(shape.attrs.length, `${what} ${shape.name} length`)
      if (!length.ok) return length
      return { ok: true, value: { kind: shape.name, radius: radius.value, length: length.value } }
    }
    case 'sphere': {
      const radius = parseNumber(shape.attrs.radius, `${what} sphere radius`)
      return radius.ok ? { ok: true, value: { kind: 'sphere', radius: radius.value } } : radius
    }
    case 'mesh':
      return { ok: true, value: { kind: 'none' } }
    default:
      return bad(`${what}: unknown geometry <${shape.name}>`)
  }
}

/** Signs that the text is a xacro source, not a URDF: it must be expanded first. */
const XACRO = /xmlns:xacro=|<xacro:|\$\{|\$\(/

/** A URDF as text, read into the bridge's manifest. */
export function parseUrdf(text: string): Checked<Manifest> {
  if (XACRO.test(text)) return bad('this is a xacro file: expand it first (xacro file.xacro > file.urdf); macros are not expanded here')
  const xml = parseXml(text)
  if (!xml.ok) return xml
  const robot = xml.value
  if (robot.name !== 'robot') return bad(`the root element is <${robot.name}>, not <robot>`)
  if (robot.attrs.name === undefined || robot.attrs.name === '') return bad('No name given for the robot.')
  const links: unknown[] = []
  const joints: unknown[] = []
  for (const el of robot.children) {
    if (el.name === 'link') {
      const name = el.attrs.name
      const what = `link '${name ?? '?'}'`
      let mass = 0
      const inertial = child(el, 'inertial')
      const massEl = inertial && child(inertial, 'mass')
      if (massEl) {
        const m = parseNumber(massEl.attrs.value, `${what} mass`)
        if (!m.ok) return m
        mass = m.value
      }
      let shape: Shape = { kind: 'none' }
      let shapeOrigin: Pose = { xyz: [0, 0, 0], rpy: [0, 0, 0] }
      const body = child(el, 'collision') ?? child(el, 'visual')
      if (body) {
        const g = parseGeometry(child(body, 'geometry'), what)
        if (!g.ok) return g
        shape = g.value
        const o = parseOrigin(child(body, 'origin'), what)
        if (!o.ok) return o
        shapeOrigin = o.value
      }
      links.push({ name, mass, shape, shapeOrigin })
    } else if (el.name === 'joint') {
      const name = el.attrs.name
      const what = `joint '${name ?? '?'}'`
      const type = el.attrs.type
      if (type === undefined) return bad(`${what} has no type, check to see if it's a reference.`)
      const origin = parseOrigin(child(el, 'origin'), what)
      if (!origin.ok) return origin
      const axisEl = child(el, 'axis')
      let axis: Vec3 = [1, 0, 0]
      if (axisEl) {
        const a = parseVec3(axisEl.attrs.xyz, `${what} axis xyz`)
        if (!a.ok) return a
        axis = a.value
      }
      const j: Record<string, unknown> = { name, kind: type, parent: child(el, 'parent')?.attrs.link, child: child(el, 'child')?.attrs.link, origin: origin.value, axis }
      if (j.parent === undefined) return bad(`${what}: parent link name is not specified`)
      if (j.child === undefined) return bad(`${what}: child link name is not specified`)
      const limit = child(el, 'limit')
      if (limit) {
        for (const [key, dflt] of [['lower', 0], ['upper', 0]] as const) {
          if (limit.attrs[key] === undefined) { j[key] = dflt; continue }
          const v = parseNumber(limit.attrs[key], `${what} limit ${key}`)
          if (!v.ok) return v
          j[key] = v.value
        }
        for (const key of ['effort', 'velocity'] as const) {
          if (limit.attrs[key] === undefined) return bad(`${what}: joint limit: no ${key}`)
          const v = parseNumber(limit.attrs[key], `${what} limit ${key}`)
          if (!v.ok) return v
          j[key] = v.value
        }
      } else if (type === 'revolute' || type === 'prismatic') {
        return bad(`${what} is of type ${type.toUpperCase()} but it does not specify limits`)
      }
      const dynamics = child(el, 'dynamics')
      if (dynamics) {
        if (dynamics.attrs.damping === undefined && dynamics.attrs.friction === undefined) return bad(`${what}: joint dynamics element specified with no damping and no friction`)
        for (const key of ['damping', 'friction'] as const) {
          if (dynamics.attrs[key] === undefined) continue
          const v = parseNumber(dynamics.attrs[key], `${what} dynamics ${key}`)
          if (!v.ok) return v
          j[key] = v.value
        }
      }
      const mimic = child(el, 'mimic')
      if (mimic) {
        if (mimic.attrs.joint === undefined) return bad(`${what}: joint mimic: no mimic joint specified`)
        const m: Record<string, unknown> = { joint: mimic.attrs.joint }
        for (const key of ['multiplier', 'offset'] as const) {
          if (mimic.attrs[key] === undefined) continue
          const v = parseNumber(mimic.attrs[key], `${what} mimic ${key}`)
          if (!v.ok) return v
          m[key] = v.value
        }
        j.mimic = m
      }
      joints.push(j)
    }
    // <material>, <transmission>, <gazebo> and the like are not the bridge's.
  }
  return buildManifest(robot.attrs.name, links, joints)
}
