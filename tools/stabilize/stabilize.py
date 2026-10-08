# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
"""
Why does this file exist? It is the autonomous stabilization loop: it runs the repository's suites again and again
(the chaos fuzzer of the KV pager on fresh seeds each run, the stress run on the GPU, the core's determinism and
kernel-fuzz suites, the page's seeded property suites at a scale and seed of each run's own, and the whole test
suites) and keeps a probabilistic JSON log (docs/stabilization/progress.json): every run with its command, seed,
outcome and duration, and per suite the pass count, the posterior mean of the pass probability under a uniform
prior (Beta(passes + 1, failures + 1)) and the Wilson 95% lower bound, so "passes consistently" is a number with an
interval, not an impression. Each suite carries its SIPOC line (supplier, input, process, output, customer) so a
reader knows what a failure would mean and who it would reach. A failing run keeps the tail of its output in the
log, for the next iteration to work from.

    python3 tools/stabilize/stabilize.py [--rounds N] [--only SUITE,...] [--chaos-seeds S] [--fuzz-scale K]

What breaks if it is removed? The suites run once, on their fixed seeds, and nobody can say how often they pass.
"""
import argparse
import json
import math
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
LOG = os.path.join(ROOT, "docs", "stabilization", "progress.json")
OS = os.path.join(ROOT, "crimson_noir_os")
KV = os.path.join(ROOT, "native", "kv-pager")


def suites(args):
    """The suites, each a function of the round number giving (command, cwd, env, seed note)."""
    gpu = {"NOIR_REQUIRE_GPU": "1"} if args.require_gpu else {}
    return {
        "rust-test": {
            "sipoc": {
                "supplier": "crimson_noir_os workspace (noir_core, the hosted runtime, the boot crate's tests)",
                "input": "the committed sources, containment.nix and containment.lock",
                "process": "cargo test --workspace --locked (CPU, and the GPU twin on lavapipe when NOIR_REQUIRE_GPU=1)",
                "output": "every unit, determinism, kernel-fuzz, terminal-fuzz and GPU-twin test green",
                "customer": "the release bake (build-release.yml) and the self-test the booted image runs",
            },
            "run": lambda r: (["cargo", "test", "--workspace", "--locked", "-q"], OS, gpu, "fixed seeds"),
        },
        "determinism": {
            "sipoc": {
                "supplier": "noir_core (kernels.rs, lanes.rs, matrix.rs, system.rs, term.rs)",
                "input": "the scripted run of the locked configuration, run whole and tick by tick",
                "process": "cargo test -p noir_core --test determinism",
                "output": "bit-identical matrices, the pinned fingerprint 0x83765bab, zero hot-path allocations",
                "customer": "the booted image's self-test, which must reproduce the build machine's answer",
            },
            "run": lambda r: (["cargo", "test", "-p", "noir_core", "--test", "determinism", "-q"], OS, {}, "fixed"),
        },
        "kernels-fuzz": {
            "sipoc": {
                "supplier": "noir_core kernels (the scalar reference and the SIMD lanes)",
                "input": "seeded adversarial rows and worlds (masks of all ones, NaN positions, extreme weights)",
                "process": "cargo test -p noir_core --test kernels_fuzz",
                "output": "the SIMD tick leaves the scalar tick's bits; a tick touches only its own row",
                "customer": "containment (the dropped-pointer and loop-breaker defenses) and the GPU twin",
            },
            "run": lambda r: (["cargo", "test", "-p", "noir_core", "--test", "kernels_fuzz", "-q"], OS, {}, "fixed"),
        },
        "chaos": {
            "sipoc": {
                "supplier": "native/kv-pager (the structure-of-arrays page table)",
                "input": f"{args.chaos_seeds} fresh seeds a round x 2,000 chaotic spawn/fork/append/despawn ops, pools of 4..128 pages, three keyings",
                "process": "cargo run --release --bin chaos -- --first-seed <round x seeds>",
                "output": "no page lost or mapped twice, every agent reads back its tokens, no false refusal, every page reclaimed",
                "customer": "a native host's paged attention (corrupt attention is the failure this guards)",
            },
            "run": lambda r: (
                ["cargo", "run", "--release", "-q", "--bin", "chaos", "--", "--seeds", str(args.chaos_seeds), "--ops", "2000",
                 "--first-seed", str(r * args.chaos_seeds), "--shared-threads", "4", "--shared-ops", "40000"],
                KV, {}, f"seeds {r * args.chaos_seeds}..{(r + 1) * args.chaos_seeds - 1}"),
        },
        "stress": {
            "sipoc": {
                "supplier": "native/kv-pager GPU pool and the paged-attention WGSL kernel",
                "input": "100 agents in 10 squads on a 16x16 grid, a fixed pool, synthetic keys and values, seed <round>",
                "process": "cargo run --release --features gpu --bin stress -- --pool-mib 768 --steps 4 --seed <round>",
                "output": "every agent's attention equals a CPU reference from its own tokens; the no-sharing baseline is refused",
                "customer": "the local model's decode on a native host",
            },
            "run": lambda r: (
                ["cargo", "run", "--release", "-q", "--features", "gpu", "--bin", "stress", "--", "--pool-mib", "768", "--steps", "4",
                 "--seed", str(7 + r)],
                KV, {}, f"seed {7 + r}"),
        },
        "native-test": {
            "sipoc": {
                "supplier": "native/routing, native/kv-pager, native/kv-pager-wasm",
                "input": "the committed sources",
                "process": "cargo test in each crate (the chaos property tests among them)",
                "output": "every native test green",
                "customer": "the page's WebAssembly modules (the air-gap check rebuilds them from these crates)",
            },
            "run": lambda r: (["sh", "tools/selfheal/checks.sh", "native-test"], ROOT, {}, "fixed"),
        },
        "page-test": {
            "sipoc": {
                "supplier": "src/ (the page's ten stages)",
                "input": "the committed sources",
                "process": "node --test src/**/*.test.ts",
                "output": "the whole page suite green (the drivers' hazard table held to its reference among them)",
                "customer": "the single-file build the page ships as",
            },
            "run": lambda r: (["node", "--test", "src/**/*.test.ts"], ROOT, {}, "fixed"),
        },
        "page-fuzz": {
            "sipoc": {
                "supplier": "the seeded property suites (src/**/*.fuzz.test.ts, property.ts)",
                "input": f"FUZZ_SCALE={args.fuzz_scale}, FUZZ_SEED=<round> (cases the fixed seeds never draw)",
                "process": "node --test src/**/*.fuzz.test.ts",
                "output": "every property holds on this round's cases; a failure prints the seed and run that replay it",
                "customer": "the nightly fuzz workflow (fuzz.yml) and the audits",
            },
            "run": lambda r: (["node", "--test", "src/**/*.fuzz.test.ts"], ROOT,
                              {"FUZZ_SCALE": str(args.fuzz_scale), "FUZZ_SEED": str(1000 + r)}, f"FUZZ_SEED {1000 + r}"),
        },
    }


def wilson_lower(passes, n, z=1.959964):
    if n == 0:
        return 0.0
    p = passes / n
    d = 1 + z * z / n
    centre = p + z * z / (2 * n)
    spread = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return max(0.0, (centre - spread) / d)


def load():
    if os.path.exists(LOG):
        with open(LOG, encoding="utf-8") as f:
            return json.load(f)
    return {"runs": [], "suites": {}}


def save(log):
    os.makedirs(os.path.dirname(LOG), exist_ok=True)
    with open(LOG, "w", encoding="utf-8") as f:
        json.dump(log, f, indent=1)
        f.write("\n")


def commit():
    try:
        return subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except Exception:
        return "unknown"


def summarize(log, defs):
    for name, d in defs.items():
        runs = [r for r in log["runs"] if r["suite"] == name]
        n = len(runs)
        passes = sum(1 for r in runs if r["ok"])
        log["suites"][name] = {
            "sipoc": d["sipoc"],
            "runs": n,
            "passes": passes,
            "failures": n - passes,
            "pass_rate": (passes / n) if n else None,
            "posterior_mean_pass_probability": (passes + 1) / (n + 2),
            "wilson_lower_95": wilson_lower(passes, n),
            "seconds_total": round(sum(r["seconds"] for r in runs), 1),
            "last": runs[-1]["at"] if runs else None,
        }
    log["generated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    log["commit"] = commit()
    log["note"] = ("posterior_mean_pass_probability is the mean of Beta(passes + 1, failures + 1), the pass probability "
                   "under a uniform prior; wilson_lower_95 is the Wilson score interval's lower bound at 95%.")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--rounds", type=int, default=3)
    ap.add_argument("--only", default="")
    ap.add_argument("--chaos-seeds", type=int, default=2000)
    ap.add_argument("--fuzz-scale", type=int, default=3)
    ap.add_argument("--require-gpu", action="store_true", help="fail rust-test when no GPU adapter is present")
    ap.add_argument("--tail", type=int, default=40, help="lines of output kept for a failing run")
    args = ap.parse_args()
    defs = suites(args)
    wanted = [s for s in args.only.split(",") if s] or list(defs)
    for s in wanted:
        if s not in defs:
            sys.exit(f"no suite named {s}; suites: {', '.join(defs)}")
    log = load()
    failed = 0
    for rnd in range(args.rounds):
        for name in wanted:
            cmd, cwd, env, seed = defs[name]["run"](rnd)
            full_env = dict(os.environ, **env)
            t = time.time()
            p = subprocess.run(cmd, cwd=cwd, env=full_env, capture_output=True, text=True)
            secs = round(time.time() - t, 1)
            ok = p.returncode == 0
            failed += 0 if ok else 1
            entry = {
                "suite": name,
                "round": rnd,
                "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
                "commit": commit(),
                "command": " ".join(cmd),
                "env": env,
                "seed": seed,
                "ok": ok,
                "exit": p.returncode,
                "seconds": secs,
            }
            if not ok:
                out = (p.stdout + "\n" + p.stderr).strip().splitlines()
                entry["tail"] = out[-args.tail:]
            log["runs"].append(entry)
            summarize(log, defs)
            save(log)
            s = log["suites"][name]
            print(f"[{rnd + 1}/{args.rounds}] {name}: {'ok' if ok else 'FAILED'} in {secs}s ({seed}); "
                  f"{s['passes']}/{s['runs']} passes, posterior {s['posterior_mean_pass_probability']:.3f}, "
                  f"wilson lower {s['wilson_lower_95']:.3f}", flush=True)
    print(f"log: {os.path.relpath(LOG, ROOT)}")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    if shutil.which("cargo") is None:
        sys.exit("cargo is needed")
    main()
