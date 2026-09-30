# Why does this file exist? A remote zip's table of contents, read with two small range requests (the end record, then
# the central directory), so the world compiler fetches only the member it needs. Standard library only.
# What breaks if it is removed? Every building extract downloads a whole province's archive to find one member.
#
# Usage: python tools/world/zipdir.py <url>
import struct
import sys
import urllib.request


def get(url, start, end):
    req = urllib.request.Request(url, headers={'Range': f'bytes={start}-{end}'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def size_of(url):
    req = urllib.request.Request(url, method='HEAD')
    with urllib.request.urlopen(req, timeout=60) as r:
        return int(r.headers['Content-Length'])


def directory(url):
    total = size_of(url)
    tail = get(url, max(0, total - 65557), total - 1)
    at = tail.rfind(b'PK\x05\x06')
    if at < 0:
        raise ValueError('no end-of-central-directory record')
    (_, _, _, _, count, cd_size, cd_offset, _) = struct.unpack('<IHHHHIIH', tail[at:at + 22])
    # ZIP64: the classic fields are saturated; the ZIP64 end record sits just before the locator.
    if cd_offset == 0xFFFFFFFF or count == 0xFFFF:
        loc = tail.rfind(b'PK\x06\x07')
        (_, _, z64_offset, _) = struct.unpack('<IIQI', tail[loc:loc + 20])
        rec = get(url, z64_offset, z64_offset + 55)
        # signature, record size, versions made/needed, disk numbers, entries on this disk, then these three.
        count, cd_size, cd_offset = struct.unpack('<QQQ', rec[32:56])
    cd = get(url, cd_offset, cd_offset + cd_size - 1)
    out, p = [], 0
    for _ in range(count):
        (sig, _, _, _, method, _, _, crc, csize, usize, nlen, xlen, clen, _, _, _, loff) = struct.unpack('<IHHHHHHIIIHHHHHII', cd[p:p + 46])
        assert sig == 0x02014B50, 'bad central directory entry'
        name = cd[p + 46:p + 46 + nlen].decode('utf-8', 'replace')
        extra = cd[p + 46 + nlen:p + 46 + nlen + xlen]
        # ZIP64 extra field: sizes and offset when saturated.
        q = 0
        while q + 4 <= len(extra):
            hid, hsz = struct.unpack('<HH', extra[q:q + 4])
            if hid == 1:
                vals = list(struct.unpack('<' + 'Q' * (hsz // 8), extra[q + 4:q + 4 + hsz]))
                if usize == 0xFFFFFFFF: usize = vals.pop(0)
                if csize == 0xFFFFFFFF: csize = vals.pop(0)
                if loff == 0xFFFFFFFF: loff = vals.pop(0)
            q += 4 + hsz
        out.append({'name': name, 'method': method, 'compressed': csize, 'size': usize, 'offset': loff, 'crc': crc})
        p += 46 + nlen + xlen + clen
    return total, out


if __name__ == '__main__':
    total, entries = directory(sys.argv[1])
    print(f'{total} bytes, {len(entries)} members')
    for e in entries:
        print(f"  {e['name']}  {e['compressed']} -> {e['size']} (method {e['method']}, at {e['offset']})")
