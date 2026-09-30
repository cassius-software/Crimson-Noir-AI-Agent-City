// Why does this file exist? The world compiler's command line: it reads what fetch.mjs and odb.py cached, runs the
// pure compiler (src/01_Initialize_World/region/compile.ts), refuses a pack in which any real name survives, and writes
// the region pack, gzipped, where the build embeds it.
// What breaks if it is removed? The cached sources cannot become a region pack.
//
// Usage: node tools/world/compile.mjs <cacheDir> <out.region.json.gz> <name> <west> <south> <east> <north>
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { compileRegion, ordinaryWords, realNamesIn } from '../../src/01_Initialize_World/region/compile.ts'
import { validatePack, polygonCount } from '../../src/01_Initialize_World/region/pack.ts'
import { REGION_GRID } from '../../src/01_Initialize_World/region/grid.ts'
import { REAL_PLACES } from './real-places.mjs'

const [dir, out, name, ...box] = process.argv.slice(2)
const bbox = box.map(Number)
if (!dir || !out || !name || bbox.length !== 4 || bbox.some((n) => !Number.isFinite(n))) {
  console.error('usage: node tools/world/compile.mjs <cacheDir> <out.region.json.gz> <name> <west> <south> <east> <north>')
  process.exit(2)
}
const read = (f) => JSON.parse(readFileSync(join(dir, f), 'utf8'))
const roads = read('roads.json'), water = read('water.json')
const buildings = readdirSync(dir).filter((f) => /^buildings-.*\.json$/.test(f)).flatMap((f) => read(f).buildings)

// Every real name the sources hold, and the region's places: none may reach the pack.
const deny = [
  ...REAL_PLACES,
  ...roads.features.flatMap((f) => [f.attributes.STREET_NAME_BODY, f.attributes.FULL_STREET_NAME]).filter(Boolean),
  ...water.features.map((f) => f.attributes.OFFICIAL_NAME_LABEL).filter(Boolean),
]
const attribution = [
  'Contains information licensed under the Open Government Licence – Ontario (Ontario Road Network; Ontario Hydro Network).',
  'Contains information licensed under the Open Government Licence – Canada (Statistics Canada, Open Database of Buildings).',
  'The building data includes information licensed under the Open Government Licence – Toronto.',
  'Geometry only: every name in this region is fictional, and no source endorses this product.',
]
const t0 = Date.now()
const pack = compileRegion({ name, grid: REGION_GRID, bbox, roads: roads.features, water: water.features, buildings, deny, attribution })
validatePack(JSON.parse(JSON.stringify(pack)))
const leaks = realNamesIn(pack, deny, ordinaryWords(roads.features))
if (leaks.length) {
  console.error(`refused: ${leaks.length} real names survive, e.g.\n  ${leaks.slice(0, 20).join('\n  ')}`)
  process.exit(1)
}
const json = JSON.stringify(pack)
const gz = gzipSync(json, { level: 9 })
writeFileSync(out, gz)
const b = pack.bounds
console.log(`${name}: ${((b.x1 - b.x0) / 1000).toFixed(2)} × ${((b.z1 - b.z0) / 1000).toFixed(2)} km, ${pack.roads.cls.length} roads, ` +
  `${polygonCount(pack.buildings)} buildings, ${polygonCount(pack.water)} water bodies, ${pack.names.length - 1} fictional names; ` +
  `${(json.length / 1e6).toFixed(1)} MB JSON, ${(gz.length / 1e6).toFixed(2)} MB gzipped, in ${Date.now() - t0} ms -> ${out}`)
