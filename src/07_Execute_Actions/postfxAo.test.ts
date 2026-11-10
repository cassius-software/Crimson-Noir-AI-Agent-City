// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the post chain's ambient occlusion (postfx.ts GatedSSAO, buildAo): built only
 * when the boot asks, on the scene pass's own depth with normals rebuilt from it (so the scene pass keeps its targets
 * and no scene pipeline changes, at one sample or four), built applying nothing at half resolution with one tap, its
 * passes skipped while off after a first, always-drawn frame, and its targets let go by release().
 * What breaks if it is removed? A change could add a normal target to the scene pass (every material's pipeline
 * rebuilt, every tier paying for it), render the occlusion's passes on tiers that never show it, divide by zero taps,
 * or leak a refused chain's targets, and only a real GPU would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoxGeometry, InstancedMesh, MeshStandardNodeMaterial, PerspectiveCamera, Scene, type NodeFrame, type WebGPURenderer } from 'three/webgpu'
import SSAONode from 'three/addons/tsl/display/SSAONode.js'
import { AO, GatedSSAO, buildPost } from './postfx.ts'

const renderer = { toneMapping: 4, outputColorSpace: 'srgb', reversedDepthBuffer: true } as unknown as WebGPURenderer

interface Target { addEventListener(type: string, fn: () => void): void }
interface PassLike {
  isPassNode?: boolean; scene?: unknown; getTextureNode(name: string): unknown; getMRT(): { outputNodes: Record<string, unknown> } | null
  getChildren?: () => Iterable<unknown>
}

/** Every node `root` reads from, itself included. */
function reach(root: unknown): Set<PassLike> {
  const seen = new Set<PassLike>()
  const visit = (n: unknown) => {
    if (!n || typeof n !== 'object' || seen.has(n as PassLike)) return
    seen.add(n as PassLike)
    for (const c of (n as PassLike).getChildren?.() ?? []) visit(c)
  }
  visit(root)
  return seen
}

function chain(cinema: boolean, sceneSamples: 0 | 4, ao?: boolean) {
  const world = new Scene()
  const resorted = [new InstancedMesh(new BoxGeometry(), new MeshStandardNodeMaterial(), 2)]
  const camera = new PerspectiveCamera()
  const built = buildPost(renderer, world, camera, cinema ? { resorted } : null, null, ao === undefined ? { sceneSamples } : { sceneSamples, ao })
  const scenePass = [...reach(built.pipeline.outputNode)].find((n) => n.isPassNode && n.scene === world)
  assert.ok(scenePass, 'the scene pass')
  return { built, scenePass, camera }
}

test('buildPost: no occlusion unless the boot asks for it', () => {
  for (const cinema of [true, false]) {
    for (const ao of [undefined, false]) assert.equal(chain(cinema, 0, ao).built.ao, null, `cinema ${cinema}, ao ${String(ao)}`)
  }
})

test('buildPost with the occlusion: on the scene pass\'s own depth, normals rebuilt from it, the scene pass\'s targets unchanged', () => {
  for (const cinema of [true, false]) {
    for (const samples of [0, 4] as const) {
      const at = `cinema ${cinema}, ${samples || 1}x`
      const { built, scenePass, camera } = chain(cinema, samples, true)
      assert.ok(built.ao, at)
      const node = built.ao.node
      assert.ok(node instanceof GatedSSAO && node instanceof SSAONode, `${at}: three's SSAONode, gated`)
      assert.equal(node.depthNode, scenePass.getTextureNode('depth'), `${at}: the scene pass's own depth (three caches it per name)`)
      assert.equal((node.normalNode as unknown as { type: string }).type, 'SampleNode', `${at}: normals rebuilt from depth, not a target of the scene pass`)
      assert.equal((node as unknown as { _camera: unknown })._camera, camera, `${at}: the scene's camera`)
      // No attachment added: cinema keeps colour and velocity, the video chain its single colour target.
      const mrt = scenePass.getMRT()
      if (cinema) assert.deepEqual(Object.keys(mrt?.outputNodes ?? {}).sort(), ['output', 'velocity'], at)
      else assert.equal(mrt, null, at)
      // Built applying nothing: half resolution, the blur on, one tap (the occlusion divides by it), strength 0, off.
      assert.equal(node.resolutionScale, AO.resolutionScale)
      assert.equal(AO.resolutionScale, 0.5)
      assert.equal(node.blurEnabled, true)
      assert.equal(node.samples.value, 1)
      assert.equal(node.radius.value, AO.radius)
      assert.equal(node.intensity.value, AO.intensity)
      assert.equal(node.bias.value, AO.bias)
      assert.equal(built.ao.strength.value, 0)
      assert.equal(node.on, false)
    }
  }
})

test('GatedSSAO: the first frame always draws (the boot\'s validated draw); after it, only frames it is on for', (t) => {
  const drawn = t.mock.method(SSAONode.prototype, 'updateBefore', () => undefined)
  const { built } = chain(true, 4, true)
  const node = built.ao!.node
  const frame = {} as NodeFrame
  node.updateBefore(frame)
  assert.equal(drawn.mock.callCount(), 1, 'off, but the first call draws')
  node.updateBefore(frame)
  node.updateBefore(frame)
  assert.equal(drawn.mock.callCount(), 1, 'off: skipped')
  node.on = true
  node.updateBefore(frame)
  node.updateBefore(frame)
  assert.equal(drawn.mock.callCount(), 3, 'on: every frame')
  node.on = false
  node.updateBefore(frame)
  assert.equal(drawn.mock.callCount(), 3, 'off again: skipped')
})

test('buildPost: release() lets go of the occlusion\'s two targets too (the boot\'s 1x fallback)', () => {
  for (const cinema of [true, false]) {
    const { built } = chain(cinema, 4, true)
    const node = built.ao!.node as unknown as { _aoRenderTarget: Target; _blurRenderTarget: Target }
    const freed: string[] = []
    node._aoRenderTarget.addEventListener('dispose', () => freed.push('ao'))
    node._blurRenderTarget.addEventListener('dispose', () => freed.push('blur'))
    built.release()
    assert.deepEqual(freed.sort(), ['ao', 'blur'], `cinema ${cinema}`)
  }
})

test('AO: frozen tuning, the fades ordered', () => {
  assert.ok(Object.isFrozen(AO) && Object.isFrozen(AO.bright) && Object.isFrozen(AO.haze) && Object.isFrozen(AO.smear))
  for (const [lo, hi] of [AO.bright, AO.haze, AO.smear]) assert.ok(lo >= 0 && lo < hi, `${lo} < ${hi}`)
  assert.ok(AO.bright[1] <= 4, 'a pixel bright enough to bloom (threshold 4) keeps all its light')
  assert.ok(AO.radius > 0 && AO.intensity > 0 && AO.bias >= 0)
})
