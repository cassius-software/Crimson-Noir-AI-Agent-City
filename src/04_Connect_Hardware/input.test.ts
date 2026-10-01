/**
 * Why does this file exist? It drives the real Input class through a minimal fake DOM (document, window and
 * canvas as EventTargets, pointer capture and pointer lock simulated) to prove the first-person look
 * contract: no zoom and no wheel handling, dragging with the primary button turns the head without pointer
 * lock, a click (no drag) captures the pointer, pitch is clamped to ±PITCH_LIMIT, the terminal and lost
 * focus end a drag, touch drag uses first-person sensitivity, the right stick turns the head,
 * `padFamily` follows the controller used last, and the ping is one edge from Q, the middle mouse button
 * (never a drag) and a pad's right shoulder.
 * What breaks if it is removed? A regression to orbit-camera input (a wheel zoom, a click that must come
 * first, an unclamped pitch that flips the view) could ship unnoticed.
 */
import assert from 'node:assert/strict'
import { afterEach, beforeEach, test } from 'node:test'
import { HalBus } from './hal.ts'
import { Input, isEditableTarget, LOOK, PITCH_LIMIT } from './input.ts'
import { PAD } from './gamepad.ts'
import type { GamepadLike } from './web-hardware.d.ts'

class FakeDocument extends EventTarget {
  pointerLockElement: unknown = null
  visibilityState = 'visible'
  exitPointerLock(): void {
    this.pointerLockElement = null
    this.dispatchEvent(new Event('pointerlockchange'))
  }
}

class FakeCanvas extends EventTarget {
  readonly captured = new Set<number>()
  lockRequests = 0
  lockAllowed = true
  private readonly doc: FakeDocument
  constructor(doc: FakeDocument) {
    super()
    this.doc = doc
  }
  setPointerCapture(id: number): void { this.captured.add(id) }
  releasePointerCapture(id: number): void {
    if (this.captured.delete(id)) this.dispatchEvent(ev('lostpointercapture', { pointerId: id }))
  }
  hasPointerCapture(id: number): boolean { return this.captured.has(id) }
  requestPointerLock(): Promise<void> {
    this.lockRequests++
    if (!this.lockAllowed) return Promise.reject(new Error('NotAllowedError'))
    this.doc.pointerLockElement = this
    this.doc.dispatchEvent(new Event('pointerlockchange'))
    return Promise.resolve()
  }
}

function ev(type: string, props: Record<string, unknown> = {}): Event {
  return Object.assign(new Event(type), props)
}

const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
  ev(type, { pointerId: 1, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: x, clientY: y, ...extra })

function pad(opts: { id?: string; index?: number; axes?: number[]; pressed?: number[] } = {}): GamepadLike {
  return {
    id: opts.id ?? 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)',
    index: opts.index ?? 0,
    connected: true,
    mapping: 'standard',
    timestamp: 1,
    axes: opts.axes ?? [0, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: !!opts.pressed?.includes(i), value: opts.pressed?.includes(i) ? 1 : 0 })),
  }
}

const g = globalThis as unknown as { document?: unknown; window?: unknown }
let doc: FakeDocument, win: EventTarget, canvas: FakeCanvas, pads: GamepadLike[], input: Input

beforeEach(() => {
  doc = new FakeDocument()
  win = new EventTarget()
  g.document = doc
  g.window = win
  canvas = new FakeCanvas(doc)
  pads = []
  const hal = new HalBus({ navigator: { getGamepads: () => pads } })
  input = new Input(canvas as unknown as HTMLCanvasElement, hal)
})

afterEach(() => {
  input.dispose()
  delete g.document
  delete g.window
})

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps

test('first person: no zoom, and the mouse wheel does nothing', () => {
  assert.equal('zoom' in input, false)
  const before = { yaw: input.yaw, pitch: input.pitch }
  const wheel = ev('wheel', { deltaY: 120 })
  canvas.dispatchEvent(wheel)
  assert.equal(wheel.defaultPrevented, false, 'the wheel is not captured')
  assert.deepEqual({ yaw: input.yaw, pitch: input.pitch }, before)
  assert.ok(close(PITCH_LIMIT, (85 * Math.PI) / 180))
})

test('zero-click look: dragging with the primary button turns the head without pointer lock', () => {
  const yaw0 = input.yaw, pitch0 = input.pitch
  canvas.dispatchEvent(mouse('pointerdown', 400, 300))
  assert.equal(input.dragging, true)
  assert.ok(canvas.captured.has(1), 'the drag keeps the pointer when it leaves the canvas')
  canvas.dispatchEvent(mouse('pointermove', 450, 280))
  canvas.dispatchEvent(mouse('pointermove', 500, 260))
  assert.ok(close(input.yaw, yaw0 - 100 * LOOK.mouse), 'dragging right turns right (yaw down)')
  assert.ok(close(input.pitch, pitch0 + 40 * LOOK.mouse), 'dragging up looks up')
  assert.ok(input.lastLook > 0)
  canvas.dispatchEvent(mouse('pointerup', 500, 260))
  assert.equal(input.dragging, false)
  assert.equal(canvas.captured.size, 0, 'capture released')
  assert.equal(canvas.lockRequests, 0, 'a drag never captures the pointer')
  assert.equal(input.locked, false)
})

test('a click (press and release without travel) captures the pointer; then plain mouse movement looks', async () => {
  canvas.dispatchEvent(mouse('pointerdown', 400, 300))
  canvas.dispatchEvent(mouse('pointermove', 402, 301))
  canvas.dispatchEvent(mouse('pointerup', 402, 301))
  assert.equal(canvas.lockRequests, 1)
  assert.equal(input.locked, true)
  assert.equal(input.engaged, true)
  const yaw = input.yaw
  doc.dispatchEvent(ev('mousemove', { movementX: -50, movementY: 0 }))
  assert.ok(close(input.yaw, yaw + 50 * LOOK.mouse), 'locked: movement turns the head with no button held')
  // While locked, presses do not start drags (and so do not double-count movement).
  canvas.dispatchEvent(mouse('pointerdown', 400, 300))
  assert.equal(input.dragging, false)
  canvas.dispatchEvent(mouse('pointermove', 600, 300))
  assert.ok(close(input.yaw, yaw + 50 * LOOK.mouse))
  // A denied lock (embedded page, too soon after Esc) is harmless: dragging still works.
  doc.exitPointerLock()
  canvas.lockAllowed = false
  canvas.dispatchEvent(mouse('pointerdown', 10, 10))
  canvas.dispatchEvent(mouse('pointerup', 10, 10))
  await Promise.resolve()
  assert.equal(input.locked, false)
  canvas.dispatchEvent(mouse('pointerdown', 10, 10))
  canvas.dispatchEvent(mouse('pointermove', 30, 10))
  assert.ok(close(input.yaw, yaw + 50 * LOOK.mouse - 20 * LOOK.mouse))
})

test('pitch is clamped to ±PITCH_LIMIT by every look source; yaw is not wrapped or clamped', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 0, -100000))
  assert.equal(input.pitch, PITCH_LIMIT)
  canvas.dispatchEvent(mouse('pointermove', 0, 100000))
  assert.equal(input.pitch, -PITCH_LIMIT)
  canvas.dispatchEvent(mouse('pointerup', 0, 100000))
  input.touchLook(0, -1e6)
  assert.equal(input.pitch, PITCH_LIMIT)
  pads.push(pad({ axes: [0, 0, 0, 1] }))
  for (let i = 0; i < 200; i++) input.poll(1 / 60)
  assert.equal(input.pitch, -PITCH_LIMIT)
  input.touchLook(-1e4, 0)
  assert.ok(input.yaw > 40, 'yaw accumulates freely (unwrapped)')
})

test('only the primary mouse button drags; touch and pen engage the touch controls instead', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0, { button: 2, buttons: 2 }))
  assert.equal(input.dragging, false)
  canvas.dispatchEvent(mouse('pointerdown', 0, 0, { pointerType: 'touch' }))
  assert.equal(input.dragging, false)
  assert.equal(input.touch, true)
  assert.equal(input.device, 'touch')
  assert.equal(input.engaged, true)
})

test('ping: Q, the middle mouse button and the right shoulder queue one edge each; a field, the terminal and a held key never do', () => {
  const yaw = input.yaw
  doc.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }))
  assert.equal(input.take('ping'), true)
  assert.equal(input.take('ping'), false, 'one edge per press')
  doc.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: true }))
  assert.equal(input.take('ping'), false, 'a held key repeats nothing')
  const typed = ev('keydown', { code: 'KeyQ', repeat: false })
  Object.defineProperty(typed, 'target', { value: { tagName: 'INPUT' } })
  doc.dispatchEvent(typed)
  assert.equal(input.take('ping'), false, 'typing in a field')
  input.suspend(true)
  doc.dispatchEvent(ev('keydown', { code: 'KeyQ', repeat: false }))
  assert.equal(input.take('ping'), false, 'the terminal is open')
  input.suspend(false)

  const middle = Object.assign(new Event('pointerdown', { cancelable: true }), { pointerId: 1, pointerType: 'mouse', button: 1, buttons: 4, clientX: 0, clientY: 0 })
  canvas.dispatchEvent(middle)
  assert.equal(middle.defaultPrevented, true, 'no autoscroll')
  assert.equal(input.dragging, false, 'the middle button never drags')
  assert.equal(input.take('ping'), true)
  canvas.dispatchEvent(mouse('pointermove', 40, 0, { buttons: 4 }))
  assert.equal(input.yaw, yaw, 'moving with it held is not a look')
  assert.equal(canvas.lockRequests, 0)
  canvas.dispatchEvent(mouse('pointerup', 40, 0))
  assert.equal(canvas.lockRequests, 0, 'nor a click that captures the pointer')
  input.suspend(true)
  canvas.dispatchEvent(mouse('pointerdown', 0, 0, { button: 1, buttons: 4 }))
  assert.equal(input.take('ping'), false, 'suspended: ignored')
  input.suspend(false)

  pads.push(pad({ pressed: [PAD.r1] }))
  input.poll(1 / 60)
  assert.equal(input.take('ping'), true, 'right shoulder')
  input.poll(1 / 60)
  assert.equal(input.take('ping'), false, 'held')
  input.press('ping')
  assert.equal(input.take('ping'), true, 'the touch button and the harness press it')
})

test('a drag ends when the button is found released, when focus is lost, and when the terminal opens', () => {
  const yaw = input.yaw
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 10, 0, { buttons: 0 }))
  assert.equal(input.dragging, false, 'button released where no pointerup reached us')
  assert.equal(input.yaw, yaw, 'that move is not a look')
  assert.equal(canvas.lockRequests, 0)

  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  win.dispatchEvent(new Event('blur'))
  assert.equal(input.dragging, false)
  assert.equal(canvas.captured.size, 0)
  canvas.dispatchEvent(mouse('pointermove', 50, 0))
  assert.equal(input.yaw, yaw)

  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  doc.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: false }))
  assert.equal(input.down('KeyW'), true)
  input.suspend(true)
  assert.equal(input.dragging, false)
  assert.equal(input.down('KeyW'), false)
  canvas.dispatchEvent(mouse('pointermove', 50, 0))
  canvas.dispatchEvent(mouse('pointerup', 50, 0))
  assert.equal(input.yaw, yaw)
  assert.equal(canvas.lockRequests, 0, 'no capture while the terminal is open')
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  assert.equal(input.dragging, false, 'suspended: presses are ignored')
  input.suspend(false)
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 5, 0))
  assert.ok(input.yaw < yaw, 'resumed')
})

test('the terminal releases pointer lock', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointerup', 0, 0))
  assert.equal(input.locked, true)
  input.suspend(true)
  assert.equal(input.locked, false)
  const yaw = input.yaw
  doc.dispatchEvent(ev('mousemove', { movementX: 40, movementY: 0 }))
  assert.equal(input.yaw, yaw)
})

test('touch drag turns the head at first-person sensitivity', () => {
  const yaw = input.yaw, pitch = input.pitch
  input.touchLook(100, -50)
  assert.ok(close(input.yaw, yaw - 100 * LOOK.touchYaw))
  assert.ok(close(input.pitch, pitch + 50 * LOOK.touchPitch))
  const swipe = 180 * LOOK.touchYaw
  assert.ok(swipe > 0.75 && swipe < 1.35, `a 180 px thumb swipe turns ${(swipe * 180 / Math.PI).toFixed(0)}°`)
  input.touchLook(Number.NaN, 5)
  assert.ok(Number.isFinite(input.yaw) && Number.isFinite(input.pitch))
  assert.equal(input.device, 'touch')
})

test('the right stick turns the head; the left stick walks; padFamily follows the pad used last', () => {
  assert.equal(input.padFamily, null)
  pads.push(pad())
  input.poll(1 / 60)
  assert.equal(input.padFamily, null, 'connected, not used')
  assert.equal(input.device, 'keyboard+mouse')
  const yaw = input.yaw, pitch = input.pitch
  pads[0] = pad({ axes: [0, -1, 1, -0.3] })
  for (let i = 0; i < 60; i++) input.poll(1 / 60)
  assert.equal(input.padFamily, 'numbered')
  assert.equal(input.device, 'gamepad')
  assert.equal(input.engaged, true)
  assert.ok(input.analog.moveY > 0.99, 'left stick forward walks forward')
  assert.ok(yaw - input.yaw > 1.2 && yaw - input.yaw < 2.4 + 1.3, `1 s full right turned ${(yaw - input.yaw).toFixed(2)} rad`)
  assert.ok(input.pitch > pitch, 'stick up looks up')
  pads[0] = pad({ id: 'Controller (XInput STANDARD GAMEPAD)', pressed: [PAD.south] })
  input.poll(1 / 60)
  assert.equal(input.padFamily, 'abxy', 'a different pad in the same slot')
  assert.equal(input.take('interact'), true)
  pads.length = 0
  input.poll(1 / 60)
  assert.equal(input.padFamily, null, 'all disconnected')
})

test('looking with the captured mouse after a controller switches the HUD back to keyboard and mouse', () => {
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointerup', 0, 0))
  assert.equal(input.locked, true)
  pads.push(pad({ axes: [0, 0, 1, 0] }))
  input.poll(1 / 60)
  assert.equal(input.device, 'gamepad')
  pads[0] = pad()
  input.poll(1 / 60)
  doc.dispatchEvent(ev('mousemove', { movementX: 0, movementY: 0 }))
  assert.equal(input.device, 'gamepad', 'a zero movement is not use')
  doc.dispatchEvent(ev('mousemove', { movementX: 12, movementY: -3 }))
  assert.equal(input.device, 'keyboard+mouse')
  assert.equal(input.padFamily, 'numbered', 'the pad family is kept for when the controller is picked up again')
})

test('a stick released mid-turn stops the head within a few frames', () => {
  pads.push(pad({ axes: [0, 0, 1, 0] }))
  for (let i = 0; i < 30; i++) input.poll(1 / 60)
  pads[0] = pad()
  for (let i = 0; i < 12; i++) input.poll(1 / 60)
  const settled = input.yaw
  for (let i = 0; i < 30; i++) input.poll(1 / 60)
  assert.equal(input.yaw, settled)
})

test('after dispose nothing reacts', () => {
  input.dispose()
  const yaw = input.yaw
  canvas.dispatchEvent(mouse('pointerdown', 0, 0))
  canvas.dispatchEvent(mouse('pointermove', 100, 0))
  canvas.dispatchEvent(mouse('pointerup', 100, 0))
  doc.dispatchEvent(ev('keydown', { code: 'KeyW', repeat: false }))
  assert.equal(input.yaw, yaw)
  assert.equal(input.down('KeyW'), false)
  assert.equal(canvas.lockRequests, 0)
})

test('editable targets never take game keys', () => {
  assert.equal(isEditableTarget({ tagName: 'input' } as unknown as EventTarget), true)
  assert.equal(isEditableTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget), true)
  assert.equal(isEditableTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget), true)
  assert.equal(isEditableTarget({ tagName: 'CANVAS' } as unknown as EventTarget), false)
  assert.equal(isEditableTarget(null), false)
})
