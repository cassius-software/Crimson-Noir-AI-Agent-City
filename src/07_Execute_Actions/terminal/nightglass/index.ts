// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the public face of Nightglass: the one module an app, the console or an agent
 * imports to draw. It names what a caller may hold and nothing else: the way in (createInstance), the reference
 * renderer as a back end (softBackend), the error every refusal raises (Fault), the image formats and their texel
 * arithmetic, the Lens shader form with its builder, binary codec, checker, listing and block layout, its lowering to
 * WGSL, and every type of the interface in api.ts and lens.ts. The parts behind it (the core's object classes, the
 * ordering checker, the rasteriser, the texture unit, the output merger and the shader interpreter) stay inside the
 * folder, so they can change without breaking a caller.
 * What breaks if it is removed? Every caller would import from the folder's inner files, reach for internals that
 * were never promised, and break whenever one of them moved; nothing would say which names are the interface.
 *
 * Rules (pinned by scene.test.ts):
 * - The values listed here are the whole run-time surface; scene.test.ts pins the list, so adding or dropping a name
 *   is a deliberate change to the interface.
 * - Every type api.ts and lens.ts export is exported, since those two files are the contract the back ends and the
 *   shader tools meet at. Classes are exported as types only where a caller annotates with them (LensBuilder).
 */

// The way in, and the reference renderer as a back end.
export { FEATURES } from './api.ts'
export { createInstance } from './instance.ts'
export { SOFT_HEAP, SOFT_LIMITS, SOFT_STEPS, softBackend } from './soft.ts'
export type { SoftOptions } from './soft.ts'

// Refusals.
export { FAULT_CODES, Fault, fail, isFault } from './fault.ts'
export type { FaultCode } from './fault.ts'

// Image formats, and the arithmetic that turns a texel's bytes into numbers and back (for filling and reading images).
export { FORMATS, FORMAT_NAMES, decodeTexel, encodeTexel, isFormat, sampleKind } from './formats.ts'
export type { Format, FormatInfo, FormatKind } from './formats.ts'

// Lens: the shader form, the builder that writes it, the binary form, the checker and the listing.
export {
  BINARY, BUILTINS, DERIVATIVES, LENS_LIMITS, LENS_MAGIC, LENS_VERSION, SCALARS, STAGES, TERNARY, UNARY, VALUE_TYPES, boolOf, columnOf,
  componentsOf, isGrid, isScalar, isValueType, isVector, layoutBlock, place, placeValue, scalarOf, strideOf, vectorOf, walk, widthOf,
} from './lens.ts'
export { arrayOf, block, lens } from './builder.ts'
export type {
  BlockRes, BlockSpec, FieldSpec, ImageRes, LensBuilder, Operand, Out, PathStep, Res, SamplerRes, StorageImageRes, Val, Var,
} from './builder.ts'
export { decode, encode, looksLikeLens } from './binary.ts'
export { verify } from './verify.ts'
export { disassemble } from './disasm.ts'

// The lowering of a Lens module to WGSL, for the GPU back end, and where it keeps the inline constants.
export { WGSL_HIDDEN, positionSure, toWgsl } from './wgsl.ts'
export type { WgslOptions, WgslOut } from './wgsl.ts'

// Every type of the interface and of the shader form.
export type * from './api.ts'
export type * from './lens.ts'
