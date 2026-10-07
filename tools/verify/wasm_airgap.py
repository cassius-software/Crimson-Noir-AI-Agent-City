#!/usr/bin/env python3
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
What breaks if it is removed? A crate change that adds an import, or a stale committed module, reaches the page
unnoticed.
"""
from __future__ import annotations

import argparse
import base64
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
        "functions": {  # prefixCache.ts binds these (kv_no_block is the "no block" sentinel the host reads once)
            "kv_block_tokens", "kv_new", "kv_free", "kv_scratch", "kv_scratch_len", "kv_out", "kv_spawn", "kv_fork",
            "kv_append", "kv_despawn", "kv_len", "kv_stats", "kv_check", "kv_no_block",
        },
    },
}

SECTION = {0: "custom", 1: "type", 2: "import", 3: "function", 4: "table", 5: "memory", 6: "global", 7: "export",
           8: "start", 9: "element", 10: "code", 11: "data", 12: "datacount"}
KIND = {0: "func", 1: "table", 2: "memory", 3: "global"}


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
    for p in problems:
        print("::error::" + p)
    if problems:
        return 1
    print("wasm_airgap: both modules import nothing, own one memory, export only what the host binds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
