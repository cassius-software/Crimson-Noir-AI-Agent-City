// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the way in: createInstance() takes the back ends an app offers, reads every
 * adapter each one reports, checks each report (a back end that reports a malformed adapter is refused here rather
 * than trusted later), orders them GPUs first, and opens devices on them with the features, limits and queues an app
 * asks for, each checked against what the adapter offers.
 * What breaks if it is removed? An app would have no way to find an adapter or open a device, and a device could
 * open with a feature or a limit its adapter does not have.
 *
 * Rules (all pinned by core.test.ts):
 * - Adapters are read once, when the instance is made, and ordered by kind (gpu, integrated, software, reference),
 *   then by the order of the back ends, then by the order each back end reported them; `index` is the position in
 *   that order. Each Adapter is a frozen copy of its report.
 * - A report needs every limit as a whole number of at least 1 (groupSize three of them), known features, heaps and
 *   memory kinds and queue groups numbered by position, each kind on a heap that exists and host-visible exactly when
 *   it is `upload` or `readback`, and at least one queue group. A malformed one is refused with code `device`.
 * - open(): every feature asked for is offered by the adapter (else `feature`). Each limit asked for replaces the
 *   adapter's for the device, and is held to it (else `limit`): a count or size at most the adapter's, each of the
 *   three groupSize values at most the adapter's, and an alignment (`offsetAlign`, `copyRowAlign`) a multiple of the
 *   adapter's, since a smaller alignment would ask more of the adapter rather than less. Queues default to one of
 *   group 0; each group is named once, exists, and asks for 1 to its count of queues.
 * - With `checks` false the instance keeps every check that protects a back end from a call it cannot carry out
 *   (sizes, formats, ranges, kinds, states) and drops those on objects in use by queued work; ordering is the
 *   ordering checker's.
 */
import type { Adapter, AdapterKind, Backend, BackendDevice, Device, DeviceInfo, Feature, Instance, InstanceInfo, Limits, MemoryKindName } from './api.ts'
import { FEATURES } from './api.ts'
import { DeviceImpl } from './device.ts'
import { fail } from './fault.ts'
import type { Fault } from './fault.ts'
import { Core, choice, drive, every, flag, guard, isObj, labelOf, listOf, names, record, whole } from './sync.ts'
import type { Obj, Report } from './sync.ts'
import { say } from './verify.ts'

export const ADAPTER_KINDS = every<AdapterKind>({ gpu: true, integrated: true, software: true, reference: true })
export const MEMORY_KIND_NAMES = every<MemoryKindName>({ device: true, images: true, upload: true, readback: true })

/** How a device's request for each limit is held to the adapter's: at most it, a multiple of it, or three at most it. */
const LIMIT_RULES: { readonly [K in keyof Limits]: 'most' | 'align' | 'axes' } = Object.freeze({
  imageSize: 'most', imageLayers: 'most', sets: 'most', bindings: 'most', uniformRange: 'most', storageRange: 'most', offsetAlign: 'align',
  stageUniforms: 'most', stageStorage: 'most', stageImages: 'most', stageSamplers: 'most', stageStorageImages: 'most', dynamicUniforms: 'most',
  dynamicStorage: 'most', vertexBuffers: 'most', vertexAttributes: 'most', vertexStride: 'most', interStage: 'most', colorAttachments: 'most',
  constants: 'most', groupInvocations: 'most', groupSize: 'axes', groups: 'most', bufferSize: 'most', allocationSize: 'most', allocations: 'most',
  copyRowAlign: 'align', updateSize: 'most',
})
export const LIMIT_NAMES = Object.freeze(Object.keys(LIMIT_RULES) as (keyof Limits)[])

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** Three whole numbers of at least 1. */
function axes(x: unknown, where: string, what: string): readonly [number, number, number] {
  if (!Array.isArray(x) || x.length !== 3) fail('invalid', `${where}: ${what} is three whole numbers, not ${say(x)}`)
  const [a, b, c] = (x as unknown[]).map((n, i) => whole(n, where, `${what} ${'xyz'[i]}`, 1))
  return Object.freeze([a, b, c] as const)
}

/** A back end's adapter report, checked and copied; anything malformed is the back end's fault (code `device`). */
function adapterOf(report: unknown, backend: string, position: number, index: number): Adapter {
  const where = `back end ${JSON.stringify(backend)} adapter ${position}`
  const read = (): Adapter => {
    const o = record(report, ['name', 'kind', 'limits', 'features', 'heaps', 'kinds', 'groups'], where, 'the report')
    if (typeof o.name !== 'string') fail('invalid', `${where}: the name is a string, not ${say(o.name)}`)
    const kind = choice(ADAPTER_KINDS, o.kind, where, 'the kind')
    const l = record(o.limits, LIMIT_NAMES, where, 'the limits')
    const limits = {} as Mutable<Limits>
    for (const k of LIMIT_NAMES) {
      if (k === 'groupSize') limits.groupSize = axes(l.groupSize, where, 'the limit groupSize')
      else limits[k] = whole(l[k], where, `the limit ${k}`, 1)
    }
    const features = names(FEATURES, o.features, where, 'the features', true)
    const numbered = <T>(x: unknown, what: string, parse: (e: Obj, at: string) => T): readonly T[] => Object.freeze(listOf(x, where, what).map((e, i) => {
      const at = `${where}: ${what} ${i}`
      if (!isObj(e) || e.index !== i) fail('invalid', `${at}: an entry is an object whose index is its position, ${i}`)
      return Object.freeze(parse(e, at))
    }))
    const heaps = numbered(o.heaps, 'heap', (e, at) => {
      record(e, ['index', 'size', 'local'], at, 'the heap')
      return { index: e.index as number, size: whole(e.size, at, 'the size', 1), local: flag(e.local, at, 'local', false) }
    })
    const kinds = numbered(o.kinds, 'memory kind', (e, at) => {
      record(e, ['index', 'name', 'heap', 'host'], at, 'the memory kind')
      const name = choice(MEMORY_KIND_NAMES, e.name, at, 'the name')
      const heap = whole(e.heap, at, 'the heap')
      if (heap >= heaps.length) fail('invalid', `${at}: there is no heap ${heap}`)
      const host = flag(e.host, at, 'host', false)
      if (host !== (name === 'upload' || name === 'readback')) fail('invalid', `${at}: ${name} memory is ${host ? 'not ' : ''}seen by the host`)
      return { index: e.index as number, name, heap, host }
    })
    const groups = numbered(o.groups, 'queue group', (e, at) => {
      record(e, ['index', 'graphics', 'compute', 'copy', 'count'], at, 'the queue group')
      return { index: e.index as number, graphics: flag(e.graphics, at, 'graphics', false), compute: flag(e.compute, at, 'compute', false), copy: flag(e.copy, at, 'copy', false), count: whole(e.count, at, 'the count', 1) }
    })
    if (groups.length === 0) fail('invalid', `${where}: an adapter has at least one queue group`)
    return Object.freeze({ name: o.name, kind, limits: Object.freeze(limits), features, heaps, kinds, groups, index, backend })
  }
  try {
    return read()
  } catch (e) {
    return fail('device', e instanceof Error ? e.message : `${where}: the report could not be read`)
  }
}

/** The limits a device opens with: the adapter's, with each one asked for held to it and put in its place. */
function deviceLimits(adapter: Limits, x: unknown, where: string): Limits {
  if (x === undefined) return adapter
  const asked = record(x, LIMIT_NAMES, where, 'the limits')
  const out: Mutable<Limits> = { ...adapter }
  for (const k of LIMIT_NAMES) {
    const v = asked[k]
    if (v === undefined) continue
    const rule = LIMIT_RULES[k]
    if (k === 'groupSize') {
      const g = axes(v, where, 'the limit groupSize')
      g.forEach((n, i) => {
        if (n > adapter.groupSize[i]) fail('limit', `${where}: groupSize ${'xyz'[i]} ${n} is more than the adapter allows, ${adapter.groupSize[i]}`)
      })
      out.groupSize = g
      continue
    }
    const n = whole(v, where, `the limit ${k}`, 1)
    const has = adapter[k]
    if (rule === 'most' && n > has) fail('limit', `${where}: the limit ${k} ${n} is more than the adapter allows, ${has}`)
    if (rule === 'align' && n % has !== 0) fail('limit', `${where}: the alignment ${k} ${n} is not a multiple of the adapter's, ${has}`)
    out[k] = n
  }
  return Object.freeze(out)
}

class InstanceImpl implements Instance {
  readonly app: string
  readonly checks: boolean
  private readonly report: Report
  private readonly list: readonly Adapter[]
  /** Each adapter's back end and its position in that back end's own list. */
  private readonly origin: ReadonlyMap<Adapter, { readonly backend: Backend; readonly position: number }>

  constructor(app: string, checks: boolean, report: Report, backends: readonly Backend[]) {
    this.app = app
    this.checks = checks
    this.report = report
    const found: { readonly report: unknown; readonly backend: Backend; readonly b: number; readonly position: number }[] = []
    backends.forEach((backend, b) => {
      const where = `back end ${JSON.stringify(backend.name)} adapters`
      const reports: unknown = drive(where, () => backend.adapters())
      listOf(reports, where, 'the reports').forEach((report, position) => found.push({ report, backend, b, position }))
    })
    const rank = (r: unknown): number => {
      const k = ADAPTER_KINDS.indexOf((isObj(r) ? r.kind : undefined) as AdapterKind)
      return k < 0 ? ADAPTER_KINDS.length : k
    }
    const order = found.map((f, i) => ({ f, i })).sort((x, y) => rank(x.f.report) - rank(y.f.report) || x.f.b - y.f.b || x.i - y.i)
    const origin = new Map<Adapter, { readonly backend: Backend; readonly position: number }>()
    this.list = Object.freeze(order.map(({ f }, index) => {
      const adapter = adapterOf(f.report, f.backend.name, f.position, index)
      origin.set(adapter, { backend: f.backend, position: f.position })
      return adapter
    }))
    this.origin = origin
  }

  adapters(): readonly Adapter[] {
    return this.list
  }

  open(adapter: Adapter, info?: DeviceInfo): Device {
    const where = 'instance open'
    return guard(this.report, where, () => {
      const from = this.origin.get(adapter)
      if (from === undefined) fail('invalid', `${where}: the adapter is not one of this instance's adapters (${say(adapter)})`)
      const o = record(info, ['features', 'limits', 'queues', 'label'], where, 'the device info', true)
      const features = o.features === undefined ? Object.freeze([] as Feature[]) : names(FEATURES, o.features, where, 'the features', true)
      for (const f of features) if (!adapter.features.includes(f)) fail('feature', `${where}: ${adapter.name} does not offer the feature ${f}`)
      const limits = deviceLimits(adapter.limits, o.limits, where)
      const queues = o.queues === undefined ? [{ group: 0, count: 1 }] : listOf(o.queues, where, 'the queues').map((q, i) => {
        const at = `${where}: queues[${i}]`
        const qo = record(q, ['group', 'count'], at, 'the queue request')
        const group = whole(qo.group, at, 'the group')
        if (group >= adapter.groups.length) fail('invalid', `${at}: ${adapter.name} has no queue group ${group}`)
        const count = whole(qo.count, at, 'the count', 1)
        if (count > adapter.groups[group].count) fail('limit', `${at}: queue group ${group} has ${adapter.groups[group].count} queue${adapter.groups[group].count === 1 ? '' : 's'}, not ${count}`)
        return { group, count }
      })
      if (queues.length === 0) fail('invalid', `${where}: the device opens at least one queue`)
      queues.forEach((q, i) => {
        if (queues.findIndex((r) => r.group === q.group) !== i) fail('invalid', `${where}: queue group ${q.group} is named twice`)
      })
      const label = labelOf(o.label, where)
      const backend = from.backend
      const opened: unknown = drive(where, () => backend.open(from.position, features, limits))
      if (!isObj(opened)) fail('device', `${where}: the back end opened no device`)
      const core = new Core(opened as unknown as BackendDevice, adapter, limits, features, this.checks, this.report)
      return new DeviceImpl(core, label, queues)
    })
  }
}

/** The entry point of Nightglass: an instance over the back ends offered, in order of preference. */
export function createInstance(info: InstanceInfo): Instance {
  // The report callback is read first, on its own, so every refusal of the rest of the info can be reported.
  const report = guard(null, 'createInstance', () => {
    const r = isObj(info) ? info.report : undefined
    if (r !== undefined && typeof r !== 'function') fail('invalid', `createInstance: report is a function, not ${say(r)}`)
    return (r ?? null) as ((fault: Fault) => void) | null
  })
  return guard(report, 'createInstance', () => {
    const where = 'createInstance'
    const o = record(info, ['app', 'backends', 'checks', 'report'], where, 'the instance info')
    if (o.app !== undefined && typeof o.app !== 'string') fail('invalid', `${where}: app is a string, not ${say(o.app)}`)
    const backends = listOf(o.backends, where, 'the back ends').map((b, i) => {
      const at = `${where}: backends[${i}]`
      if (!isObj(b) || typeof b.name !== 'string' || typeof b.adapters !== 'function' || typeof b.open !== 'function') fail('invalid', `${at}: a back end has a name, adapters() and open()`)
      return b as unknown as Backend
    })
    backends.forEach((b, i) => {
      if (backends.findIndex((c) => c.name === b.name) !== i) fail('invalid', `${where}: two back ends are named ${JSON.stringify(b.name)}`)
    })
    return new InstanceImpl((o.app ?? '') as string, flag(o.checks, where, 'checks', true), report, backends)
  })
}
