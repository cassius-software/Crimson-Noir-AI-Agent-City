// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It pins the code dissolve's render half (codeDissolve.ts): the helper builds on a
 * MeshStandardNodeMaterial without a renderer, with and without an existing mask, position and emissive node, and
 * returns the same material; its position graph holds the fold select onto the origin and folds positionPrevious
 * only in a pass that writes motion vectors; its mask is the existing mask AND the cells' survival; the colour is
 * the base dimmed by the amount; the emissive adds the ink in the kind's green; roughness and metalness are left
 * alone; and the two glyphs are a '0' and a '1' drawn from strokes on the unit box. The compiled shader itself runs
 * only in a WebGPU browser (the orchestrator's probe).
 * What breaks if it is removed? The fold could stop reaching the origin, the mask could replace (not AND) a car's
 * cabin mask, or a pass without a velocity target could be handed a previous position, unnoticed.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { MeshStandardNodeMaterial, type Node, type NodeBuilder } from 'three/webgpu'
import { Fn, attribute, float, frontFacing, positionLocal, positionPrevious, screenCoordinate, screenSize, stack, setCurrentStack, uniform, vec3 } from 'three/tsl'
import { BINARY_GLYPHS, CODE_DISSOLVE, applyCodeDissolve } from './codeDissolve.ts'

type N = { type?: string; op?: string; condNode?: unknown; ifNode?: unknown; elseNode?: unknown; aNode?: unknown; bNode?: unknown; getChildren?: () => Iterable<unknown> }

/** Every node `root` reads from, itself included (ghost.test.ts's walk). */
const reach = (root: unknown): Set<N> => {
  const seen = new Set<N>()
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object' || seen.has(n as N)) return
    seen.add(n as N)
    for (const c of (n as N).getChildren?.() ?? []) visit(c)
  }
  visit(root)
  return seen
}

/**
 * The position node is a TSL function (it needs the builder to know whether the pass writes motion vectors): run its
 * body with a builder that says so or not, on a stack of its own, and return the output and what was pushed.
 */
function runPosition(material: MeshStandardNodeMaterial, previous: boolean): { out: unknown; pushed: unknown[] } {
  // Fn()() hands back a var intent over the call node: unwrap down to the call.
  type Call = { isShaderCallNodeInternal?: boolean; node?: Call; shaderNode: { jsFunc: (b: unknown) => unknown } }
  let call = material.positionNode as unknown as Call
  while (!call.isShaderCallNodeInternal && call.node) call = call.node
  assert.ok(call.isShaderCallNodeInternal, 'the position node is a TSL function call')
  const s = stack()
  setCurrentStack(s)
  try {
    const out = call.shaderNode.jsFunc({ needsPreviousData: () => previous })
    return { out, pushed: [...s.nodes] }
  } finally {
    setCurrentStack(null)
  }
}

const GREEN: readonly [number, number, number] = [0.3, 0.95, 0.6]

test('builds without a renderer on a bare material and returns it: position, mask, colour and emissive set, roughness and metalness untouched', () => {
  const m = new MeshStandardNodeMaterial()
  const amount = uniform(0)
  const origin = vec3(0, 0, 0)
  const back = applyCodeDissolve(m, amount, origin, GREEN)
  assert.equal(back, m)
  assert.ok(m.positionNode && m.maskNode && m.colorNode && m.emissiveNode)
  assert.equal(m.roughnessNode, null)
  assert.equal(m.metalnessNode, null)
  // The fold: a select whose "if" branch is the origin and whose "else" is the geometry's own position.
  const { out, pushed } = runPosition(m, false)
  const fold = [...reach(out)].find((n) => n.type === 'ConditionalNode' && n.ifNode === origin)
  assert.ok(fold, 'the fold select onto the origin')
  assert.equal(fold.elseNode, positionLocal, 'a material without a position node folds positionLocal')
  assert.equal(pushed.length, 0, 'a pass without a velocity target is handed no previous position')
  // The mask: the cells' survival; the amount is read in it.
  assert.ok([...reach(m.maskNode)].some((n) => n === amount), 'the mask reads the amount')
  assert.ok([...reach(m.colorNode)].some((n) => n === amount), 'the colour reads the amount')
  assert.ok([...reach(m.emissiveNode)].some((n) => n === amount), 'the ink reads the amount')
})

test('an existing mask is kept and ANDed; an existing position node is kept under the fold; positionPrevious folds only with motion vectors', () => {
  const m = new MeshStandardNodeMaterial()
  const cabin = frontFacing.or(attribute('paint', 'vec3').x.greaterThan(0.5))
  m.maskNode = cabin
  const swayed = positionLocal.add(vec3(0.1, 0, 0))
  const treeLike = Fn((builder: NodeBuilder) => {
    if ((builder as NodeBuilder & { needsPreviousData(): boolean }).needsPreviousData()) positionPrevious.assign(positionPrevious.add(swayed))
    return swayed
  })()
  m.positionNode = treeLike
  const night = uniform(0.5)
  const lamp = vec3(1, 0.8, 0.5).mul(night)
  m.emissiveNode = lamp
  const base = vec3(0.2, 0.3, 0.4)
  m.colorNode = base
  const amount = attribute('dissolve', 'float')
  const origin = positionLocal.mul(0)
  applyCodeDissolve(m, amount, origin, GREEN)
  // Mask: an AND whose operands reach the old mask and the survival (which reads the amount).
  const and = [...reach(m.maskNode)].find((n) => n.type === 'OperatorNode' && n.op === '&&' && (reach(n.aNode).has(cabin as unknown as N) || reach(n.bNode).has(cabin as unknown as N)))
  assert.ok(and, 'the mask is the old mask AND the survival')
  const other = reach(and.aNode).has(cabin as unknown as N) ? and.bNode : and.aNode
  assert.ok(reach(other).has(amount as unknown as N), 'the other operand is the survival, read from the amount')
  // Position: the fold keeps the tree's own node as its "else" branch.
  const plain = runPosition(m, false)
  const fold = [...reach(plain.out)].find((n) => n.type === 'ConditionalNode' && n.ifNode === origin)
  assert.ok(fold)
  assert.equal(fold.elseNode, treeLike, 'the existing position node is folded, not replaced')
  assert.equal(plain.pushed.length, 0)
  const motion = runPosition(m, true)
  assert.equal(motion.pushed.length, 1, 'one statement with motion vectors: the previous position folded')
  const assign = motion.pushed[0] as { type?: string; targetNode?: unknown; sourceNode?: unknown }
  assert.equal(assign.type, 'AssignNode')
  assert.equal(assign.targetNode, positionPrevious)
  const prevFold = [...reach(assign.sourceNode)].find((n) => n.type === 'ConditionalNode' && n.ifNode === origin)
  assert.ok(prevFold && reach(prevFold.elseNode).has(positionPrevious as unknown as N), 'previous folds onto the origin too, else stays itself')
  // Colour: the base, dimmed by the amount. Emissive: the lamp's own glow still reaches it, plus the ink.
  assert.ok(reach(m.colorNode).has(base as unknown as N) && reach(m.colorNode).has(amount as unknown as N))
  assert.ok(reach(m.emissiveNode).has(lamp as unknown as N), 'the lamp still glows at night')
  assert.ok(reach(m.emissiveNode).has(night as unknown as N))
  assert.ok(reach(m.emissiveNode).has(amount as unknown as N))
})

test('the same amount node drives several materials; a float node or a uniform both serve', () => {
  const amount = float(0.5)
  const a = applyCodeDissolve(new MeshStandardNodeMaterial(), amount, vec3(0), GREEN)
  const b = applyCodeDissolve(new MeshStandardNodeMaterial(), amount, vec3(1, 2, 3), [0.85, 1, 0.85])
  assert.notEqual(a, b)
  assert.ok(reach(a.maskNode).has(amount as unknown as N) && reach(b.maskNode).has(amount as unknown as N))
  // Applying twice nests: the second mask ANDs the first.
  const twice = applyCodeDissolve(a, uniform(0), vec3(0), GREEN)
  assert.ok([...reach(twice.maskNode)].some((n) => n.type === 'OperatorNode' && n.op === '&&'))
})

test('the look: an alphabet of exactly two glyphs, a 0 and a 1, from strokes on the unit box; a top-down fold threshold', () => {
  assert.deepEqual(Object.keys(BINARY_GLYPHS), ['zero', 'one'])
  for (const [name, strokes] of Object.entries(BINARY_GLYPHS)) {
    assert.ok(strokes.length >= 1, name)
    for (const [ax, ay, bx, by] of strokes) {
      for (const c of [ax, ay, bx, by]) assert.ok(c >= 0 && c <= 1, `${name}: ${c} is off the box`)
      assert.ok(Math.hypot(bx - ax, by - ay) > 0.1, `${name}: a stroke has length`)
    }
  }
  // The '0' is a closed outline: every stroke's end is another's start.
  for (const [, , bx, by] of BINARY_GLYPHS.zero) assert.ok(BINARY_GLYPHS.zero.some(([ax, ay]) => ax === bx && ay === by))
  // The '1' has one full-height vertical.
  assert.ok(BINARY_GLYPHS.one.some(([ax, ay, bx, by]) => ax === bx && Math.abs(by - ay) === 1))
  assert.ok(Object.isFrozen(CODE_DISSOLVE))
  assert.ok(CODE_DISSOLVE.fold > 0.99 && CODE_DISSOLVE.fold < 1)
  assert.ok(CODE_DISSOLVE.idle > 0 && CODE_DISSOLVE.idle < 0.01)
  assert.ok(CODE_DISSOLVE.rows > 20 && CODE_DISSOLVE.glow > 1 && CODE_DISSOLVE.trail > 0)
  assert.ok(CODE_DISSOLVE.speed > 0 && CODE_DISSOLVE.speedSpread >= 0)
})

test('no renderer is needed: the nodes are three\'s, nothing in the graph is a pass', () => {
  const m = applyCodeDissolve(new MeshStandardNodeMaterial(), uniform(0), vec3(0), GREEN)
  for (const root of [m.maskNode, m.colorNode, m.emissiveNode] as Node[]) {
    for (const n of reach(root)) assert.ok(!(n as { isPassNode?: boolean }).isPassNode, 'no pass in a material graph')
  }
})

/** three's TSL `hash` on the CPU (crowd.ts tslHash): PCG on the seed's integer part, as a u32 (a WGSL f32 → u32 saturates). */
function pcg(seed: number): number {
  const u = seed <= 0 ? 0 : seed >= 2 ** 32 ? 2 ** 32 - 1 : Math.trunc(seed)
  const state = (Math.imul(u >>> 0, 747796405) + 2891336453) >>> 0
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0
  return (((word >>> 22) ^ word) >>> 0) / 2 ** 32
}

test('the survival keys stay a different seed per cell however long the page has run (a fractional, signed seed collapsed to one key in minutes)', () => {
  const f = Math.fround
  // The shader's arithmetic in f32 at 1080p (40 rows of 27 px cells, 17 px wide): column, fall, row, key.
  const cols = Math.floor(1920 / Math.floor(27 * 0.64)), rows = CODE_DISSOLVE.rows
  const keySeed = (cx: number, cy: number, t: number): number => {
    const column = pcg(f(f(cx * 7.13) + 0.5))
    const fallen = f(t * f(f(column * CODE_DISSOLVE.speedSpread) + CODE_DISSOLVE.speed))
    const r = Math.floor(f(cy - fallen))
    const row = f(r - CODE_DISSOLVE.keyRows * Math.floor(r / CODE_DISSOLVE.keyRows))
    return f(f(cx * (CODE_DISSOLVE.keyRows + 3)) + row)
  }
  for (const t of [0, 60, 600, 3600, 86_400]) {
    const keys = new Set<number>()
    for (let cx = 0; cx < cols; cx++) {
      for (let cy = 0; cy < rows; cy++) {
        const seed = keySeed(cx, cy, t)
        assert.ok(Number.isInteger(seed) && seed >= 0 && seed < 2 ** 24, `t ${t}: seed ${seed} is not a whole number in f32's exact range`)
        keys.add(pcg(seed))
      }
    }
    assert.ok(keys.size >= 0.9 * cols * rows, `t ${t} s: ${keys.size} distinct keys of ${cols * rows}`)
  }
  // The source builds exactly that seed.
  const src = readFileSync(new URL('./codeDissolve.ts', import.meta.url), 'utf8')
  assert.match(src, /const row = mod\(floor\(c\.y\.sub\(fallen\)\), CODE_DISSOLVE\.keyRows\)\n\s*const key = hash\(c\.x\.mul\(CODE_DISSOLVE\.keyRows \+ 3\)\.add\(row\)\)/)
})

test('the shadow is masked by the amount alone: no screen cell reaches the shadow pass, an existing shadow mask is kept', () => {
  const amount = uniform(0)
  const m = applyCodeDissolve(new MeshStandardNodeMaterial(), amount, vec3(0), GREEN)
  assert.ok(m.maskShadowNode, 'a shadow mask of its own')
  const screenNodes = new Set<N>([...reach(screenCoordinate), ...reach(screenSize)].filter((n) => n.type === 'ScreenNode'))
  assert.ok(screenNodes.size > 0)
  const screen = (n: N) => screenNodes.has(n)
  assert.ok([...reach(m.maskNode)].some(screen), 'the visible mask is the screen\'s cells')
  assert.ok(![...reach(m.maskShadowNode)].some(screen), 'the shadow mask reads no screen coordinate')
  assert.ok(reach(m.maskShadowNode).has(amount as unknown as N), 'it reads the amount')
  const own = uniform(true)
  const kept = new MeshStandardNodeMaterial()
  kept.maskShadowNode = own as unknown as Node<'bool'>
  applyCodeDissolve(kept, amount, vec3(0), GREEN)
  assert.ok(reach(kept.maskShadowNode).has(own as unknown as N), 'an existing shadow mask is ANDed, not replaced')
})
