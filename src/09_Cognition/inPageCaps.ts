// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is how the page knows, before it starts anything, whether this browser can run the
 * in-page model's runtime (wllama's native build): a few cheap questions asked of the global, answered in a plain
 * sentence. The runtime needs four things and says nothing useful when one is missing. It reads the model file while
 * paused in the middle of the WebAssembly (JSPI: WebAssembly.Suspending and WebAssembly.promising). Its glue makes one
 * shared memory with 64-bit addresses, giving the limits as BigInts (wllama's initMemory), even with one thread. Its
 * code is full of vector instructions (SIMD) and of the legacy try, catch and delegate instructions that Emscripten's
 * -fwasm-exceptions emits, with a tag section. wllama's constructor starts its own SIMD and exception check without
 * waiting for it, so a browser without them would only fail deep inside a load; this file asks first. Cross-origin
 * isolation is not needed: without it Chromium still makes the shared 64-bit memory, and wllama quietly runs one
 * thread, so isolation only decides threads (canShareMemory, the same test the physics bridge uses). The page must
 * not have an opaque origin, though: wllama always starts its worker as a module worker from a blob: URL, and Chromium
 * refuses that worker on a page opened from a file (its origin reads "null"; the worker's error carries no message, and
 * a classic worker from the same blob would run), so there every load would fail. Whether the page can keep files
 * (OPFS) and whether it has WebGPU are read here too, for the console's rows.
 * The SIMD and exception modules below are written by hand from the WebAssembly specification, a few dozen bytes
 * each, and only validated, never compiled or run. Every probe reads only the global it is handed, so the Node tests
 * hand it fakes that lack one piece at a time; it makes no request, touches no DOM and never throws.
 * What breaks if it is removed? The in-page mind would start the runtime in a browser that cannot run it, and the
 * operator would see a load that hangs or aborts with no reason, where the script should have stood in with one.
 */
import { canShareMemory } from '../07_Execute_Actions/sharedBridge.ts'

/** What this browser offers the in-page runtime. */
export interface Caps {
  /** WebAssembly.Suspending and WebAssembly.promising are both functions: the runtime can pause while it reads the file. */
  jspi: boolean
  /** A shared memory with 64-bit addresses and BigInt limits can be made, as the runtime's glue makes it. */
  mem64shared: boolean
  /** Our own SIMD module validates. */
  simd: boolean
  /** Our own exception-handling module (a tag, try, throw, catch) validates. */
  exceptions: boolean
  /** The page can share memory with a worker (canShareMemory): the runtime may use more than one thread. */
  isolated: boolean
  /** The page can keep files in its origin private file system (navigator.storage.getDirectory). */
  opfs: boolean
  /** The page has navigator.gpu. */
  webgpu: boolean
  /**
   * The page's origin is opaque: opened from a file (location.protocol file:), or any page whose origin reads "null".
   * Chromium refuses a module worker made from a blob: URL there, and the runtime's worker is one.
   */
  opaque: boolean
}

/** Whether the runtime can run here: with threads (isolated) or one thread, or the plain reason it cannot. */
export type RuntimeMode = { ok: true; threads: boolean } | { ok: false; reason: string }

/** The parts of a global the probes read; anything may be missing. */
interface Probed {
  WebAssembly?: {
    Suspending?: unknown
    promising?: unknown
    Memory?: new (descriptor: object) => unknown
    validate?: (bytes: Uint8Array) => boolean
  }
  navigator?: { storage?: { getDirectory?: unknown }; gpu?: unknown }
  SharedArrayBuffer?: unknown
  crossOriginIsolated?: boolean
  location?: { protocol?: unknown }
  /** The global's own origin (self.origin): "null" when it is opaque. */
  origin?: unknown
}

/** The module preamble: the magic "\0asm" and version 1. */
const PREAMBLE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00] as const

/**
 * A module with one function of type () -> i32 that takes a 128-bit constant, applies a lane-wise i8x16 operation and
 * reads lane 0 back as its result. It validates only where WebAssembly SIMD does (prefix 0xfd).
 */
const SIMD_MODULE = new Uint8Array([
  ...PREAMBLE,
  0x01, 0x05, 0x01, 0x60, 0x00, 0x01, 0x7f, // type section: one type, () -> (i32)
  0x03, 0x02, 0x01, 0x00, // function section: one function, of type 0
  0x0a, 0x1b, 0x01, 0x19, 0x00, // code section (27 bytes): one body of 25 bytes, no locals
  0xfd, 0x0c, ...new Array<number>(16).fill(0xfe), // v128.const: sixteen lanes of -2
  0xfd, 0x60, // i8x16.abs
  0xfd, 0x16, 0x00, // i8x16.extract_lane_u 0
  0x0b, // end
])

/**
 * A module with one exception tag and one function of type () -> () whose body throws that tag inside a try and
 * catches it. This is the legacy encoding (try 0x06, catch 0x07), the one wllama's binary uses throughout (it has no
 * try_table), so the check matches what the runtime needs. The tag section (id 13) sits between the function and the
 * code sections, as the specification orders them.
 */
const EXCEPTIONS_MODULE = new Uint8Array([
  ...PREAMBLE,
  0x01, 0x04, 0x01, 0x60, 0x00, 0x00, // type section: one type, () -> ()
  0x03, 0x02, 0x01, 0x00, // function section: one function, of type 0
  0x0d, 0x03, 0x01, 0x00, 0x00, // tag section: one tag, attribute 0 (an exception), of type 0
  0x0a, 0x0b, 0x01, 0x09, 0x00, // code section (11 bytes): one body of 9 bytes, no locals
  0x06, 0x40, // try, no result
  0x08, 0x00, // throw tag 0
  0x07, 0x00, // catch tag 0
  0x0b, // end of the try
  0x0b, // end
])

/** Whether `bytes` validate here; false when there is no validator or it throws. Hands over a copy, so ours stay intact. */
function validates(w: Probed['WebAssembly'], bytes: Uint8Array): boolean {
  try {
    return w?.validate?.(bytes.slice()) === true
  } catch {
    return false
  }
}

/**
 * Whether the memory the runtime's glue asks for can be made: shared, 64-bit addresses, limits given as BigInts (the
 * glue's initMemory passes initial: BigInt(2048), maximum: 65536n), here at one page so the probe costs nothing. Only
 * the BigInt form is asked. The specification takes an i64 memory's limits as BigInts, as the glue passes them. An
 * engine whose JS API predates the address key (Node 22's V8 12.4 still calls it index) ignores it: from Number limits
 * it builds an ordinary 32-bit memory without a word, one the glue's import would refuse, while BigInt limits make it
 * throw a TypeError.
 */
function sharedI64(w: Probed['WebAssembly']): boolean {
  try {
    const Memory = w?.Memory
    if (typeof Memory !== 'function') return false
    new Memory({ initial: 1n, maximum: 1n, shared: true, address: 'i64' })
    return true
  } catch {
    return false
  }
}

/** `read()`, or `otherwise` when reading the global throws (a getter that refuses this context). */
function asked<T>(read: () => T, otherwise: T): T {
  try {
    return read()
  } catch {
    return otherwise
  }
}

/** Asks `g` (the page's global unless a test hands it another) what it offers the runtime. Reads only from `g`; never throws. */
export function probe(g: object = globalThis): Caps {
  const p = g as Probed
  const w = asked(() => p.WebAssembly, undefined)
  return {
    jspi: asked(() => typeof w?.Suspending === 'function' && typeof w.promising === 'function', false),
    mem64shared: sharedI64(w),
    simd: validates(w, SIMD_MODULE),
    exceptions: validates(w, EXCEPTIONS_MODULE),
    isolated: asked(() => canShareMemory(p), false),
    opfs: asked(() => typeof p.navigator?.storage?.getDirectory === 'function', false),
    webgpu: asked(() => !!p.navigator?.gpu, false),
    opaque: asked(() => p.location?.protocol === 'file:' || p.origin === 'null', false),
  }
}

/** Where a browser that has all four lives, said after each reason. */
const WHERE = 'Chrome 137 or later on a computer or Android can'

/** What the runtime needs, in the order a missing piece is named, each with the plain reason given when it is missing. */
const NEEDS: readonly (readonly [keyof Caps, string])[] = [
  ['jspi', `this browser cannot pause the model's runtime while it reads the file (JSPI); ${WHERE}`],
  ['mem64shared', `this browser cannot give the model's runtime the shared 64-bit memory it is built for (WebAssembly Memory64); ${WHERE}`],
  ['simd', `this browser cannot run the vector instructions the model's runtime is built with (WebAssembly SIMD); ${WHERE}`],
  ['exceptions', `this browser cannot run the error handling the model's runtime is built with (WebAssembly exceptions); ${WHERE}`],
]

/** Why a page with an opaque origin (opened from a file) cannot run the runtime, and where it can. */
export const OPAQUE_REASON =
  "a page opened from a file cannot start the model's runtime, since the browser refuses its worker there: open the city from a server instead (npm run preview, the launcher, the Windows app or the web copy)"

/**
 * Whether the runtime can run with these caps (phase 1: it needs JSPI, the shared 64-bit memory, SIMD and exceptions,
 * on a page whose origin is not opaque), or the reason naming the first piece missing; a browser that lacks a piece is
 * named before the page's origin, since serving the page would not help it. Isolation is not required: without it the
 * runtime runs one thread.
 */
export function runtimeMode(c: Caps): RuntimeMode {
  for (const [need, reason] of NEEDS) if (!c[need]) return { ok: false, reason }
  if (c.opaque) return { ok: false, reason: OPAQUE_REASON }
  return { ok: true, threads: c.isolated }
}

/** One plain line for the console's runtime row, e.g. "this browser runs it (one thread: the page is not cross-origin isolated)". */
export function capsLine(c: Caps): string {
  const mode = runtimeMode(c)
  if (!mode.ok) return mode.reason
  return mode.threads ? 'this browser runs it' : 'this browser runs it (one thread: the page is not cross-origin isolated)'
}
