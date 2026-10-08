# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
# Why does this file exist? The world compiler's building stage: it streams one province file of the Open Database of
# Buildings (Statistics Canada, Open Government Licence – Canada) straight out of its remote zip (inflating as it
# downloads, so the archive itself never touches the disk), pulls the footprints inside a box through the GeoPackage's
# spatial index, writes them as longitude/latitude with their heights and storeys, and deletes the GeoPackage. The disk
# never holds more than one province file. Standard library only.
# What breaks if it is removed? The compiler has no buildings.
#
# Usage: python tools/world/odb.py <zip url> <out.json> <work dir> <west> <south> <east> <north>
import json
import math
import os
import sqlite3
import struct
import sys
import time
import urllib.request
import zlib

sys.path.insert(0, os.path.dirname(__file__))
from zipdir import directory, get  # noqa: E402

# ---------------------------------------------------------------- NAD83 / Statistics Canada Lambert (EPSG:3347)
A = 6378137.0
F = 1 / 298.257222101  # GRS 1980
E = math.sqrt(2 * F - F * F)
LCC = dict(lat1=49.0, lat2=77.0, lat0=63.390675, lon0=-91.86666666666666, x0=6200000.0, y0=3000000.0)


def _m(phi):
    return math.cos(phi) / math.sqrt(1 - (E * math.sin(phi)) ** 2)


def _t(phi):
    s = E * math.sin(phi)
    return math.tan(math.pi / 4 - phi / 2) / ((1 - s) / (1 + s)) ** (E / 2)


_p1, _p2, _p0 = (math.radians(LCC[k]) for k in ('lat1', 'lat2', 'lat0'))
_N = (math.log(_m(_p1)) - math.log(_m(_p2))) / (math.log(_t(_p1)) - math.log(_t(_p2)))
_FF = _m(_p1) / (_N * _t(_p1) ** _N)
_R0 = A * _FF * _t(_p0) ** _N
_L0 = math.radians(LCC['lon0'])


def forward(lon, lat):
    r = A * _FF * _t(math.radians(lat)) ** _N
    th = _N * (math.radians(lon) - _L0)
    return LCC['x0'] + r * math.sin(th), LCC['y0'] + _R0 - r * math.cos(th)


def inverse(x, y):
    dx, dy = x - LCC['x0'], _R0 - (y - LCC['y0'])
    r = math.copysign(math.hypot(dx, dy), _N)
    th = math.atan2(dx * (1 if _N > 0 else -1), dy * (1 if _N > 0 else -1))
    t = (r / (A * _FF)) ** (1 / _N)
    phi = math.pi / 2 - 2 * math.atan(t)
    for _ in range(15):
        s = E * math.sin(phi)
        nxt = math.pi / 2 - 2 * math.atan(t * ((1 - s) / (1 + s)) ** (E / 2))
        if abs(nxt - phi) < 1e-12:
            phi = nxt
            break
        phi = nxt
    return math.degrees(th / _N + _L0), math.degrees(phi)


# ---------------------------------------------------------------- the member, streamed and inflated
def stream_member(url, entry, dest):
    head = get(url, entry['offset'], entry['offset'] + 29)
    sig, _, _, method, _, _, _, _, _, nlen, xlen = struct.unpack('<IHHHHHIIIHH', head)
    assert sig == 0x04034B50 and method == 8, 'expected a deflated member'
    start = entry['offset'] + 30 + nlen + xlen
    req = urllib.request.Request(url, headers={'Range': f"bytes={start}-{start + entry['compressed'] - 1}"})
    inflate = zlib.decompressobj(-15)
    crc, done, t0 = 0, 0, time.time()
    with urllib.request.urlopen(req, timeout=120) as r, open(dest, 'wb') as out:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            data = inflate.decompress(chunk)
            crc = zlib.crc32(data, crc)
            out.write(data)
            done += len(chunk)
            print(f"\r  {done / 1e6:.0f} / {entry['compressed'] / 1e6:.0f} MB ({done / max(1e-3, time.time() - t0) / 1e6:.1f} MB/s)", end='', flush=True)
        tail = inflate.flush()
        crc = zlib.crc32(tail, crc)
        out.write(tail)
    print()
    if crc != entry['crc']:
        raise ValueError(f"CRC mismatch: {crc:08x} != {entry['crc']:08x}")


# ---------------------------------------------------------------- GeoPackage geometry
def wkb_polygons(b, o=0):
    """(polygons, next offset): each polygon a list of rings, each ring a list of (x, y)."""
    order = '<' if b[o] == 1 else '>'
    (kind,) = struct.unpack(order + 'I', b[o + 1:o + 5])
    kind %= 1000  # ISO Z/M offsets
    o += 5
    if kind == 3:
        (nr,) = struct.unpack(order + 'I', b[o:o + 4]); o += 4
        rings = []
        for _ in range(nr):
            (np_,) = struct.unpack(order + 'I', b[o:o + 4]); o += 4
            pts = struct.unpack(order + 'd' * (2 * np_), b[o:o + 16 * np_]); o += 16 * np_
            rings.append(list(zip(pts[0::2], pts[1::2])))
        return [rings], o
    if kind == 6:
        (n,) = struct.unpack(order + 'I', b[o:o + 4]); o += 4
        polys = []
        for _ in range(n):
            p, o = wkb_polygons(b, o)
            polys += p
        return polys, o
    raise ValueError(f'unsupported WKB type {kind}')


def gpkg_polygons(blob):
    flags = blob[3]
    env = (flags >> 1) & 7
    size = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[env]
    return wkb_polygons(blob, 8 + size)[0]


def extract(gpkg, bbox):
    db = sqlite3.connect(gpkg)
    table, geom, srs = db.execute("select table_name, column_name, srs_id from gpkg_geometry_columns").fetchone()
    (definition,) = db.execute("select definition from gpkg_spatial_ref_sys where srs_id=?", (srs,)).fetchone()
    cols = [r[1] for r in db.execute(f'pragma table_info("{table}")')]
    print(f'  table {table}, geometry {geom}, srs {srs}, columns {cols}')
    if srs == 4326:
        fwd, inv = (lambda x, y: (x, y)), (lambda x, y: (x, y))
    elif srs == 3347 or 'Statistics Canada' in definition or 'Statistics_Canada' in definition:
        fwd, inv = forward, inverse
    else:
        raise ValueError(f'unexpected spatial reference {srs}: {definition[:120]}')
    w, s, e, n = bbox
    corners = [fwd(x, y) for x in (w, e) for y in (s, n)] + [fwd((w + e) / 2, n), fwd((w + e) / 2, s)]
    minx, maxx = min(c[0] for c in corners), max(c[0] for c in corners)
    miny, maxy = min(c[1] for c in corners), max(c[1] for c in corners)
    rtree = f'rtree_{table}_{geom}'
    keep = [c for c in ('id', 'height', 'floors', 'type', 'csdname', 'dataset', 'source') if c in cols]
    pk = [r[1] for r in db.execute(f'pragma table_info("{table}")') if r[5]][0]
    q = f'select {", ".join(f"t.{c}" for c in keep)}, t."{geom}" from "{table}" t join "{rtree}" r on t."{pk}" = r.id ' \
        f'where r.maxx >= ? and r.minx <= ? and r.maxy >= ? and r.miny <= ?'
    out = []
    for row in db.execute(q, (minx, maxx, miny, maxy)):
        attrs = dict(zip(keep, row[:-1]))
        for poly in gpkg_polygons(row[-1]):
            rings = [[[round(c, 7) for c in inv(x, y)] for (x, y) in ring] for ring in poly]
            lons = [p[0] for p in rings[0]]
            lats = [p[1] for p in rings[0]]
            if max(lons) < w or min(lons) > e or max(lats) < s or min(lats) > n:
                continue
            out.append({**attrs, 'rings': rings})
    db.close()
    return out


if __name__ == '__main__':
    url, out_file, work = sys.argv[1:4]
    bbox = [float(v) for v in sys.argv[4:8]]
    os.makedirs(work, exist_ok=True)
    total, entries = directory(url)
    entry = next(e for e in entries if e['name'].endswith('.gpkg'))
    dest = os.path.join(work, entry['name'])
    try:
        print(f"streaming {entry['name']} ({entry['compressed'] / 1e6:.0f} MB -> {entry['size'] / 1e6:.0f} MB)")
        stream_member(url, entry, dest)
        found = extract(dest, bbox)
    finally:
        if os.path.exists(dest):
            os.remove(dest)
    with open(out_file, 'w', encoding='utf-8') as f:
        json.dump({'source': url, 'member': entry['name'], 'licence': 'Open Government Licence – Canada', 'bbox': bbox,
                   'fetched': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'buildings': found}, f)
    print(f'{len(found)} buildings in the box -> {out_file}')
