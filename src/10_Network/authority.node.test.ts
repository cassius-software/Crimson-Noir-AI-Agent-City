/**
 * Why does this file exist? It proves client-side prediction with snap reconciliation end to end, the way the page runs
 * it: the page's own physics realm (SimCore, the code the worker runs, over the city of the seed) is the prediction,
 * the page's network client (netClient.ts over Node's WebSocket) reports each realm step paired with the request that
 * ran it, exactly as engine.ts pairs them (the walking velocity asked, the substeps run, the pose reached, the
 * correction carried out), and the real host (replication.node.ts) judges every step on its headless Ring-0 mirror.
 * An honest walk through the city, walls included, is never corrected; a position written into the page's realm (a
 * teleport the room never made: memory manipulation) is refused the moment the claim arrives, and the page, snapped to
 * the truth by one teleport, walks on honest with the room. It also shows the room's other players seeing the truth,
 * not the lie.
 * What breaks if it is removed? The engine's pairing of state and request, or the client's handling of a correction,
 * could drift from what the mirror replays, and every honest player would be snapped for nothing.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateCity, streetFurniture } from '../01_Initialize_World/city.ts'
import { SimCore } from '../07_Execute_Actions/simCore.ts'
import { POSE, RUN, type SimCommand } from '../07_Execute_Actions/simProtocol.ts'
import { createNetClient, type Move, type NetClient } from './netClient.ts'
import { startHost } from './replication.node.ts'

const SEED = 1337
const IDLE = { steer: 0, fwd: 0, back: 0, handbrake: false }
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  for (let t = 0; t < ms; t += 10) {
    if (cond()) return
    await sleep(10)
  }
  assert.ok(cond(), `still waiting: ${what}`)
}

/**
 * The page: its realm, its client, and engine.ts's bookkeeping in miniature (netSent, netFix, netMoveOf, netFrame):
 * a frame asks for a step with this frame's walking velocity and any queued teleport, the state that answers is
 * reported as the room's move, and a new correction queues one teleport for the next request.
 */
async function page(url: string, token: string, name: string) {
  const sim = await SimCore.create({ seed: SEED, cars: 0, agents: 256, boxes: generateCity(SEED), furniture: streetFurniture(SEED), spawn: { x: 500, z: 500 }, debug: false }, null)
  const poses = new Float32Array(POSE.stride)
  const client: NetClient = createNetClient()
  let fix = 0
  const queued: SimCommand[] = []
  let at = { x: 0, y: 0, z: 0 }
  const frame = (dt: number, foot: { x: number; z: number }, cheat?: SimCommand): void => {
    // netFrame: a new correction is one teleport, queued for the next request.
    const c = client.correction()
    if (client.status === 'joined' && c && c.fix > fix) {
      fix = c.fix
      queued.push({ c: 'teleport', x: c.x, z: c.z })
    }
    const cmds = [...queued.splice(0), ...(cheat ? [cheat] : [])]
    // The request carries the frame's foot and the correction it carries out; its state is the room's move.
    const sent = { x: foot.x, z: foot.z, fix }
    const st = sim.step({ dt, foot: { ...foot, heading: 0 }, drive: IDLE, cmds }, poses)
    at = { x: st.avatar.x, y: st.avatar.y, z: st.avatar.z }
    if (client.status === 'joined') {
      const m: Move = { mode: 'foot', x: sent.x, z: sent.z, n: st.physics.steps, heading: 0, at, fix: sent.fix }
      client.move(m)
    }
  }
  assert.equal(client.connect(url, token, name, `city/${SEED}`), null)
  return { client, frame, get at() { return at } }
}

test('prediction and snap reconciliation end to end: an honest walk is never corrected; a position written into the page is refused at once and snapped back', async () => {
  const host = await startHost({ secret: 'authority-secret', tickHz: 20 })
  try {
    const ada = await page(host.url, host.token('ada'), 'Ada')
    const bob = await page(host.url, host.token('bob'), 'Bob')
    await until(() => ada.client.status === 'joined' && bob.client.status === 'joined', 'both welcomed')
    const truth = (): { x: number; z: number } => host.room.peers.get(ada.client.id)!
    // Frames at 60 Hz with the odd long one (a frame of 50 ms runs three substeps), walking east into the lot beside
    // the spawn sidewalk (a wall), then south along it, then standing.
    const walk = async (frames: number, foot: { x: number; z: number }): Promise<void> => {
      for (let k = 0; k < frames; k++) {
        const dt = k % 7 === 6 ? 0.05 : 1 / 60
        ada.frame(dt, foot)
        bob.frame(dt, { x: 0, z: 0 })
        await sleep(dt * 1000)
      }
    }
    await walk(60, { x: RUN, z: 0 })
    await walk(90, { x: 0.5, z: RUN })
    await walk(20, { x: 0, z: 0 })
    await until(() => Math.hypot(truth().x - ada.at.x, truth().z - ada.at.z) < 1e-3, 'the room holds where the page is')
    assert.equal(ada.client.corrections, 0, `honest: ${ada.client.corrected}`)
    assert.ok(ada.at.x < 327, `the wall stopped the walk east (x ${ada.at.x.toFixed(2)})`)
    const honest = { x: truth().x, z: truth().z }

    // Memory manipulation: the page's own realm is told to put the player 30 m along, a teleport the room never made.
    const t0 = performance.now()
    ada.frame(1 / 60, { x: 0, z: 0 }, { c: 'teleport', x: honest.x, z: honest.z + 30 })
    await until(() => ada.client.corrections === 1, 'the correction')
    const ms = performance.now() - t0
    assert.match(ada.client.corrected ?? '', /claim .* from the mirror's pose/)
    assert.deepEqual([truth().x, truth().z], [honest.x, honest.z], 'the room never moved the player')
    // Bob, in the same room, sees Ada where the room has her, never where she claimed to be.
    await until(() => bob.client.poses().some((p) => p.id === ada.client.id), 'Bob sees Ada')
    const seen = bob.client.poses().find((p) => p.id === ada.client.id)!
    assert.ok(Math.abs(seen.z - honest.z) < 0.5, `Bob sees Ada at z ${seen.z.toFixed(2)}, the truth ${honest.z.toFixed(2)}`)
    // The page applies the correction (one teleport) and walks on, honest again: no further corrections.
    await walk(60, { x: 0, z: -RUN })
    // Within a centimetre, not to the bit: the realm's first move after a teleport still reads its capsule's collider
    // where the last step left it (a world step moves the collider), the mirror's teleport moves it at once, and
    // against a wall the two slides differ by a millimetre or two. The room's tolerance is 25 cm.
    await until(() => Math.hypot(truth().x - ada.at.x, truth().z - ada.at.z) < 0.01, 'the room and the page agree again')
    assert.equal(ada.client.corrections, 1, `no correction after the snap: ${ada.client.corrected}`)
    assert.ok(ms < 250, `refused and corrected ${ms.toFixed(1)} ms after the claim was sent`)
    assert.equal(bob.client.corrections, 0)
    const st = host.stats()
    assert.equal(st.corrected, 1)
    assert.ok(st.kept > 200, `${st.kept} steps kept`)
    ada.client.leave()
    bob.client.leave()
  } finally {
    await host.close()
  }
})
