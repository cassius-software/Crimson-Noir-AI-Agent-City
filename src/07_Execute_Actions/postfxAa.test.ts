// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It proves the post chain's multisampling (postfx.ts buildPost): the scene pass takes the
 * samples the boot decided and no others (never the renderer's, which split screen may set), its colour is resolved
 * and not stored while its depth is stored for the sun shafts, ghost view's pass stays at one sample and after FXAA,
 * and release() lets go of the chain's targets for the boot's 1x fallback.
 * What breaks if it is removed? A change could let the scene pass inherit the renderer's samples, multisample the ghost
 * pass, drop the depth the shafts read, or leak a refused chain's targets, and only a real GPU would show it.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BoxGeometry, FloatType, HalfFloatType, InstancedMesh, MeshStandardNodeMaterial, PerspectiveCamera, Scene, StorageBufferAttribute, type WebGPURenderer } from 'three/webgpu'
import { buildPost } from './postfx.ts'
import { createGhost, type GhostSource } from './ghost.ts'
import type { Box } from '../01_Initialize_World/city.ts'

const renderer = { toneMapping: 4, outputColorSpace: 'srgb', reversedDepthBuffer: false } as unknown as WebGPURenderer

function source(): GhostSource {
  const boxes: Box[] = [[0, 0, 0, 10, 30, 20]]
  return { boxes, furniture: { lamps: [[4, 4, 0]], trees: [], signals: [] }, suv: [false], crowdPos: new StorageBufferAttribute(new Float32Array(16 * 4), 4), agents: 16 }
}

interface Target { samples: number; storeMultisampledColorBuffer: boolean; storeMultisampledDepthBuffer: boolean; depthTexture: { type: number } | null; addEventListener(type: string, fn: () => void): void }
interface PassLike {
  isPassNode?: boolean; type?: string; scene?: unknown; options: { samples?: number }; renderTarget: Target
  getMRT(): { has(k: string): boolean } | null; setup(builder: unknown): unknown; getChildren?: () => Iterable<unknown>
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

function chain(cinema: boolean, sceneSamples?: 0 | 4) {
  const g = createGhost(source())
  const world = new Scene()
  const resorted = [new InstancedMesh(new BoxGeometry(), new MeshStandardNodeMaterial(), 2)]
  const built = sceneSamples === undefined
    ? buildPost(renderer, world, new PerspectiveCamera(), cinema ? { resorted } : null, g)
    : buildPost(renderer, world, new PerspectiveCamera(), cinema ? { resorted } : null, g, { sceneSamples })
  const all = [...reach(built.pipeline.outputNode)]
  const passes = all.filter((n) => n.isPassNode)
  const scenePass = passes.find((p) => p.scene === world)
  const ghostPass = passes.find((p) => p.scene === g.scene)
  assert.ok(scenePass && ghostPass, 'a scene pass and a ghost pass')
  return { built, all, passes, scenePass, ghostPass }
}

test('buildPost at 4 samples: the scene pass is multisampled from its construction, colour not stored, depth stored; ghost view stays at one sample', () => {
  for (const cinema of [true, false]) {
    const { passes, scenePass, ghostPass, all, built } = chain(cinema, 4)
    assert.equal(passes.length, 2, `cinema ${cinema}: ${passes.length} passes`)
    assert.equal(scenePass.options.samples, 4)
    assert.equal(scenePass.renderTarget.samples, 4, 'the target is 4x before any shader that reads its depth is built')
    assert.equal(scenePass.renderTarget.storeMultisampledColorBuffer, false, 'resolved as the pass ends, never stored')
    assert.equal(scenePass.renderTarget.storeMultisampledDepthBuffer, true, 'the sun shafts read the multisampled depth')
    assert.ok(scenePass.renderTarget.depthTexture, 'the scene pass has its depth texture')
    if (cinema) {
      const m = scenePass.getMRT()
      assert.ok(m && m.has('output') && m.has('velocity'), 'cinema: colour and velocity, both multisampled and resolved')
    } else assert.equal(scenePass.getMRT(), null)
    assert.equal(ghostPass.options.samples, 0, 'ghost view: one sample')
    assert.equal(ghostPass.getMRT(), null, 'ghost view: no velocity')
    // The ghost is laid on after FXAA (as ghost.test.ts proves for the default chain).
    const fx = all.find((n) => n.type === 'FXAANode')
    assert.ok(fx, 'FXAA stays')
    assert.notEqual(built.pipeline.outputNode, fx)
    assert.ok(!reach(fx).has(ghostPass), `cinema ${cinema}: the ghost is not under FXAA`)
  }
})

test('buildPost by default: both passes at one sample whatever the renderer has, colour stored as three does by default', () => {
  for (const cinema of [true, false]) {
    for (const samples of [undefined, 0] as const) {
      const { scenePass, ghostPass } = chain(cinema, samples)
      assert.equal(scenePass.options.samples, 0)
      assert.equal(ghostPass.options.samples, 0)
      assert.equal(scenePass.renderTarget.samples, 0)
      assert.equal(scenePass.renderTarget.storeMultisampledColorBuffer, true, 'the 1x graph is three\'s default')
    }
  }
  // three's setup takes the pass's own samples over the renderer's (split screen's renderer may have 4).
  const { scenePass } = chain(true)
  scenePass.setup({ renderer: { samples: 4, getOutputBufferType: () => HalfFloatType, reversedDepthBuffer: true } })
  assert.equal(scenePass.renderTarget.samples, 0, 'the renderer\'s samples never reach the scene pass')
  const multi = chain(true, 4).scenePass
  multi.setup({ renderer: { samples: 0, getOutputBufferType: () => HalfFloatType, reversedDepthBuffer: true } })
  assert.equal(multi.renderTarget.samples, 4)
  assert.equal(multi.renderTarget.depthTexture?.type, FloatType, 'reversed depth: depth32float, multisampled')
})

test('buildPost refuses a sample count WebGPU does not have', () => {
  for (const n of [1, 2, 8]) {
    assert.throws(() => buildPost(renderer, new Scene(), new PerspectiveCamera(), null, null, { sceneSamples: n as 0 }), RangeError, `${n}`)
  }
})

test('buildPost: release() lets go of the scene and ghost targets (the boot\'s 1x fallback)', () => {
  for (const cinema of [true, false]) {
    const { built, scenePass, ghostPass } = chain(cinema, 4)
    const freed: string[] = []
    scenePass.renderTarget.addEventListener('dispose', () => freed.push('scene'))
    ghostPass.renderTarget.addEventListener('dispose', () => freed.push('ghost'))
    built.release()
    assert.deepEqual(freed.sort(), ['ghost', 'scene'], `cinema ${cinema}`)
  }
})
