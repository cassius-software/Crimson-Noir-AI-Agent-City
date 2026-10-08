// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
// Why does this file exist? It is the world compiler's first stage: it pulls the open government data a region of the
// map is built from, clipped to a box, into a local cache. Nothing here ships: the product never touches the network
// (the air gap); the compiled world pack it leads to is a local file.
// - Roads: the Ontario Road Network composite (Government of Ontario, Open Government Licence – Ontario), one segment
//   per record with its class, lanes, speed, one-way flow and names. The names are read only so the compiler can
//   replace every one of them with a fictional name and prove none survives.
// - Water: the Ontario Hydro Network waterbodies (Government of Ontario, Open Government Licence – Ontario), at their
//   1:10,000 source scale, generalized to about a metre.
// What breaks if it is removed? The compiler has no roads or water to build a region from.
//
// Usage: node tools/world/fetch.mjs <cacheDir> <west> <south> <east> <north>
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const SOURCES = {
  roads: {
    url: 'https://services1.arcgis.com/TJH5KDher0W13Kgo/arcgis/rest/services/Ontario_Road_Network_Composite_Service/FeatureServer/5',
    fields: [
      'OBJECTID', 'ROAD_NET_ELEMENT_ID', 'ROAD_CLASS', 'ROAD_ELEMENT_TYPE', 'DIRECTION_OF_TRAFFIC_FLOW', 'SPEED_LIMIT',
      'NUMBER_OF_LANES', 'PAVEMENT_STATUS', 'JURISDICTION', 'ROUTE_NUMBER', 'FULL_STREET_NAME', 'STREET_NAME_BODY',
      'STREET_TYPE_SUFFIX', 'L_STANDARD_MUNICIPALITY', 'R_STANDARD_MUNICIPALITY',
    ],
    licence: 'Open Government Licence – Ontario',
    offset: 0,
  },
  water: {
    url: 'https://ws.lioservices.lrc.gov.on.ca/arcgis2/rest/services/LIO_OPEN_DATA/LIO_Open01/MapServer/25',
    fields: ['OBJECTID', 'OGF_ID', 'WATERBODY_TYPE', 'OFFICIAL_NAME_LABEL', 'PERMANENCY'],
    licence: 'Open Government Licence – Ontario',
    // About a metre (degrees of latitude): the shoreline as surveyed, without its sub-metre vertices.
    offset: 0.00001,
  },
}

const PAGE = 1000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function page(src, bbox, offset) {
  const q = new URLSearchParams({
    where: '1=1', geometry: bbox.join(','), geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: src.fields.join(','), returnGeometry: 'true',
    geometryPrecision: '7', orderByFields: 'OBJECTID', resultOffset: String(offset), resultRecordCount: String(PAGE), f: 'json',
  })
  if (src.offset) q.set('maxAllowableOffset', String(src.offset))
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(`${src.url}/query`, { method: 'POST', body: q, headers: { 'content-type': 'application/x-www-form-urlencoded' } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const j = await res.json()
      if (j.error) throw new Error(JSON.stringify(j.error).slice(0, 200))
      return j
    } catch (e) {
      if (attempt >= 5) throw e
      console.warn(`  retry ${attempt} at offset ${offset}: ${e.message}`)
      await sleep(2000 * attempt)
    }
  }
}

async function pull(name, bbox, dir) {
  const src = SOURCES[name]
  const features = []
  for (let offset = 0; ; offset += PAGE) {
    const j = await page(src, bbox, offset)
    features.push(...j.features)
    process.stdout.write(`\r${name}: ${features.length}`)
    if (!j.exceededTransferLimit && j.features.length < PAGE) break
    await sleep(250) // polite pacing
  }
  process.stdout.write('\n')
  const out = { source: src.url, licence: src.licence, bbox, fetched: new Date().toISOString(), features }
  const file = join(dir, `${name}.json`)
  writeFileSync(file, JSON.stringify(out))
  return { file, count: features.length }
}

const [dir, ...box] = process.argv.slice(2)
const bbox = box.map(Number)
if (!dir || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n)) || bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
  console.error('usage: node tools/world/fetch.mjs <cacheDir> <west> <south> <east> <north>')
  process.exit(2)
}
mkdirSync(dir, { recursive: true })
for (const name of Object.keys(SOURCES)) console.log(await pull(name, bbox, dir))
