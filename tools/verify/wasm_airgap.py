#!/usr/bin/env python3
# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
"""
Why does this file exist? It is the air-gap and isolation check of the WebAssembly modules the page carries
(tools/verify/fvps.sh runs it; src/06_Make_Decisions/routing.wasm.ts and src/09_Cognition/kvPager.wasm.ts carry the
modules as base64). It reads each module's binary sections (the WebAssembly binary format, no library) and refuses
the build unless:
  - the import section is absent or empty: the module can call nothing of the host, so it cannot reach the network,
    the DOM, a clock or another module; everything it computes it computes from its own linear memory (the Phase 11
    air gap, at the module boundary);
  - there is exactly one memory and it is the module's own, exported under the name the host expects: the host
    writes the arena into it and the module cannot address any other memory;
  - the exported functions are exactly the set the host binds (routingWasm.ts / prefixCache.ts), so nothing else is
    callable and nothing the host relies on is missing;
  - there is no start function: nothing runs at instantiation but what the host calls;
  - any table is unexported (an indirect-call table the host cannot write to);
  - the bytes in the tree are the bytes the file's own SHA-256 line names, and, when the crate is rebuilt
    (`--rebuilt PATH`), the rebuilt module is byte-identical to the committed one.
A trap inside the module (`unreachable`, an out-of-bounds load) stops that call and nothing else: the harnesses in
native/routing/src/verify.rs prove the routing core reaches none on a well-formed or malformed arena.
A third policy, pinned third-party, holds a module this repository does not build to what was reviewed when it was
pinned: wllama's build of llama.cpp, the in-page model runtime (third_party/wllama/<version>/, written from the npm
package by tools/native/wllama-pack.mjs). It reads the committed gz with the standard library alone (gzip, hashlib),
so it runs where there is no node_modules: the rust and fvps jobs and the release bake. It refuses the build unless:
  - the module's bytes hash to the line SHA256SUMS names for it, and the gz to its own line;
  - its imports are exactly the reviewed list in IMPORTS, all from `env` and `wasi_snapshot_preview1` (the
    Emscripten glue the page's adapter instantiates it with), and no import is named for a socket, a connection or a
    request (sock, connect, accept, send, recv, fetch, http, xhr, websocket): whatever the module reaches, it reaches
    through a function the page's own JavaScript hands it, under the page's policy;
  - its one memory is imported, shared, with 64-bit addresses and a maximum (flags 7), and it defines no memory of
    its own.
What breaks if it is removed? A crate change that adds an import, or a stale committed module, reaches the page
unnoticed; so does a pinned runtime swapped for one that imports more than was reviewed.
"""
from __future__ import annotations

import argparse
import base64
import gzip
import hashlib
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

MODULES = {
    "routing": {
        "file": ROOT / "src/06_Make_Decisions/routing.wasm.ts",
        "prefix": "ROUTING_WASM",
        "functions": {
            "routing_arena", "routing_check", "routing_out", "routing_pose_at", "routing_project_onto",
            "routing_next_stop", "routing_speed_limit_at", "routing_layout",
        },
    },
    "kv-pager": {
        "file": ROOT / "src/09_Cognition/kvPager.wasm.ts",
        "prefix": "KV_PAGER_WASM",
        "functions": {  # the module's whole surface: what prefixCache.ts binds, plus kv_no_block (the "no block" sentinel, read by the tests)
            "kv_block_tokens", "kv_new", "kv_free", "kv_scratch", "kv_scratch_len", "kv_out", "kv_spawn", "kv_fork",
            "kv_append", "kv_despawn", "kv_len", "kv_stats", "kv_check", "kv_no_block",
        },
    },
}

SECTION = {0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global", 7: "export",
           8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount"}
KIND = {0: "func", 1: "table", 2: "memory", 3: "global", 4: "tag"}

# Modules this repository does not build, pinned as published and held to what was reviewed (the third policy).
PINNED = {
    "wllama": {
        "dir": ROOT / "third_party/wllama/3.8.1",
        "gz": "wllama.wasm.gz",
        "raw": "wllama.wasm",
        "modules": {"env", "wasi_snapshot_preview1"},
        "memory_flags": 7,  # bit 0 a maximum, bit 1 shared, bit 2 64-bit addresses (memory64)
    },
}
NETWORK = re.compile(r"sock|connect|accept|send|recv|fetch|http|xhr|websocket", re.IGNORECASE)


def leb(buf: bytes, i: int) -> tuple[int, int]:
    r, s = 0, 0
    while True:
        x = buf[i]
        i += 1
        r |= (x & 0x7F) << s
        s += 7
        if not x & 0x80:
            return r, i


def sections(buf: bytes) -> list[tuple[int, bytes]]:
    if buf[:8] != b"\x00asm\x01\x00\x00\x00":
        raise ValueError("not a WebAssembly 1.0 module")
    out, i = [], 8
    while i < len(buf):
        sid = buf[i]
        n, i = leb(buf, i + 1)
        out.append((sid, buf[i:i + n]))
        i += n
    return out


def exports(body: bytes) -> list[tuple[str, str]]:
    cnt, j = leb(body, 0)
    out = []
    for _ in range(cnt):
        n, j = leb(body, j)
        name = body[j:j + n].decode()
        j += n
        kind = body[j]
        j += 1
        _, j = leb(body, j)
        out.append((name, KIND.get(kind, str(kind))))
    return out


def imports(body: bytes) -> list[tuple[str, str, str, int | None]]:
    """The import section in order: module, name, kind, and a memory's limit flags (None for any other kind)."""
    cnt, j = leb(body, 0)
    out = []
    for _ in range(cnt):
        n, j = leb(body, j)
        module = body[j:j + n].decode()
        j += n
        n, j = leb(body, j)
        name = body[j:j + n].decode()
        j += n
        kind = body[j]
        j += 1
        flags = None
        if kind == 0:  # a function: its type index
            _, j = leb(body, j)
        elif kind in (1, 2):  # limits (a table's after its element type): flags, minimum, and a maximum when bit 0 is set
            j += kind == 1
            lim = body[j]
            _, j = leb(body, j + 1)
            if lim & 1:
                _, j = leb(body, j)
            flags = lim if kind == 2 else None
        elif kind == 3:  # a global: its value type and mutability
            j += 2
        elif kind == 4:  # a tag: its attribute and type index
            _, j = leb(body, j + 1)
        else:
            raise ValueError(f"import {module}.{name}: unknown kind {kind}")
        out.append((module, name, KIND[kind], flags))
    if j != len(body):
        raise ValueError("the import section does not end where its size says")
    return out


def sha256sums(text: str) -> dict[str, str]:
    """sha256sum's lines (`<hex>  <name>`) as name to hash."""
    out = {}
    for line in text.splitlines():
        m = re.fullmatch(r"([0-9a-f]{64}) [ *](.+)", line)
        if m:
            out[m.group(2)] = m.group(1)
    return out


def check_pinned(name: str, spec: dict) -> list[str]:
    problems = []
    d = spec["dir"]
    gz = (d / spec["gz"]).read_bytes()
    raw = gzip.decompress(gz)
    sha = hashlib.sha256(raw).hexdigest()
    sums = sha256sums((d / "SHA256SUMS").read_text())
    if sums.get(spec["raw"]) != sha:
        problems.append(f"{name}: the module in {spec['gz']} hashes to {sha[:16]}…, not the {spec['raw']} line of SHA256SUMS")
    if sums.get(spec["gz"]) != hashlib.sha256(gz).hexdigest():
        problems.append(f"{name}: {spec['gz']} does not hash to its line of SHA256SUMS")
    secs = sections(raw)
    found = []
    for sid, body in secs:
        if sid == 2:
            found += imports(body)
    listed = [line for line in (d / "IMPORTS").read_text().splitlines() if line]
    lines = [f"{m}.{n} {k}" for m, n, k, _ in found]
    if lines != listed:
        extra = sorted(set(lines) - set(listed))
        missing = sorted(set(listed) - set(lines))
        problems.append(f"{name}: the imports are not the reviewed IMPORTS list (not listed: {extra}; listed but absent: {missing}"
                        f"{'; the same set in another order' if not extra and not missing else ''})")
    foreign = sorted({m for m, _, _, _ in found} - spec["modules"])
    if foreign:
        problems.append(f"{name}: imports from {foreign}; only {sorted(spec['modules'])} are allowed")
    network = [f"{m}.{n}" for m, n, _, _ in found if NETWORK.search(n) or NETWORK.search(m)]
    if network:
        problems.append(f"{name}: imports named for the network: {network}")
    memories = [(m, n, f) for m, n, k, f in found if k == "memory"]
    if len(memories) != 1 or memories[0][2] != spec["memory_flags"]:
        problems.append(f"{name}: memory imports {[(f'{m}.{n}', f) for m, n, f in memories]}; exactly one, with flags {spec['memory_flags']} (shared, 64-bit, a maximum)")
    own = sum(leb(body, 0)[0] for sid, body in secs if sid == 5)
    if own:
        problems.append(f"{name}: the module defines {own} memory of its own")
    print(f"{name} (pinned): {len(raw)} bytes from {len(gz)} gzipped, sha256 {sha[:16]}…, {len(found)} imports "
          f"({', '.join(f'{sum(1 for x in found if x[0] == m)} {m}' for m in sorted({x[0] for x in found}))}), "
          f"memory flags {[f for _, _, f in memories]}, {own} memory of its own")
    return problems


def module_bytes(file: Path, prefix: str) -> tuple[bytes, str]:
    text = file.read_text()
    m = re.search(prefix + r"_BASE64 =\n  '([A-Za-z0-9+/=]+)'", text)
    sha = re.search(prefix + r"_SHA256 = '([0-9a-f]{64})'", text)
    size = re.search(prefix + r"_BYTES = (\d+)", text)
    if not (m and sha and size):
        raise ValueError(f"{file}: not a generated module file")
    b = base64.b64decode(m.group(1))
    if len(b) != int(size.group(1)):
        raise ValueError(f"{file}: {len(b)} bytes, the file says {size.group(1)}")
    if hashlib.sha256(b).hexdigest() != sha.group(1):
        raise ValueError(f"{file}: the bytes do not hash to the SHA-256 the file names")
    return b, sha.group(1)


def check(name: str, spec: dict, rebuilt: Path | None) -> list[str]:
    problems = []
    b, sha = module_bytes(spec["file"], spec["prefix"])
    secs = sections(b)
    by = {}
    for sid, body in secs:
        by.setdefault(sid, []).append(body)
    imports = 0
    for body in by.get(2, []):
        imports += leb(body, 0)[0]
    if imports:
        problems.append(f"{name}: the module imports {imports} item(s); the air gap allows none")
    memories = 0
    for body in by.get(5, []):
        memories += leb(body, 0)[0]
    if memories != 1:
        problems.append(f"{name}: {memories} memories; exactly one is the module's own")
    if 8 in by:
        problems.append(f"{name}: the module has a start function")
    ex = []
    for body in by.get(7, []):
        ex += exports(body)
    names = {n for n, _ in ex}
    kinds = {n: k for n, k in ex}
    if kinds.get("memory") != "memory":
        problems.append(f"{name}: the memory is not exported as 'memory'")
    funcs = {n for n, k in ex if k == "func"}
    expected = spec["functions"]
    if expected is not None and funcs != expected:
        problems.append(f"{name}: exported functions {sorted(funcs)} are not the host's {sorted(expected)}")
    if any(k == "table" for _, k in ex):
        problems.append(f"{name}: a table is exported")
    extra = names - funcs - {"memory"}
    if extra:
        problems.append(f"{name}: unexpected exports {sorted(extra)}")
    if rebuilt is not None:
        rb = rebuilt.read_bytes()
        if rb != b:
            problems.append(f"{name}: the committed module ({len(b)} bytes, {sha[:16]}…) differs from the rebuilt one ({len(rb)} bytes, {hashlib.sha256(rb).hexdigest()[:16]}…); run npm run native:wasm")
    print(f"{name}: {len(b)} bytes, sha256 {sha[:16]}…, {imports} imports, {memories} memory, {len(funcs)} functions exported, "
          f"sections {[SECTION.get(s, s) for s, _ in secs]}")
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--rebuilt-routing", type=Path, help="a freshly built routing.wasm to compare with the committed module")
    ap.add_argument("--rebuilt-kv-pager", type=Path, help="a freshly built kv_pager_wasm.wasm to compare with the committed module")
    a = ap.parse_args()
    problems = []
    problems += check("routing", MODULES["routing"], a.rebuilt_routing)
    problems += check("kv-pager", MODULES["kv-pager"], a.rebuilt_kv_pager)
    problems += check_pinned("wllama", PINNED["wllama"])
    for p in problems:
        print("::error::" + p)
    if problems:
        return 1
    print("wasm_airgap: both modules import nothing, own one memory, export only what the host binds; the pinned wllama "
          "module is the reviewed one and imports only its listed host functions and one shared 64-bit memory")
    return 0


if __name__ == "__main__":
    sys.exit(main())
