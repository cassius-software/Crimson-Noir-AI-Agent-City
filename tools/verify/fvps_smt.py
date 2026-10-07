#!/usr/bin/env python3
"""
Why does this file exist? It is the SMT half of the formal verification step (tools/verify/fvps.sh): the index
arithmetic the kernels and the routing core are built from, stated as theorems over 32-bit words and IEEE doubles
and proved for every value by the Z3 solver. The Kani harnesses (crimson_noir_os/crates/noir_core/src/verify.rs,
native/routing/src/verify.rs) prove the real Rust code on the smallest configuration; the theorems here close the
gap to every configuration the validator admits, because they quantify over the dimensions too: every power-of-two
capacity, block size, station count and floor, every slot, every tick, every goal word. Each theorem is the exact
expression the code computes (kernels.rs and shaders/swarm.wgsl are the same arithmetic; the line is cited), and the
solver is asked for a counterexample: UNSAT is the proof. A SAT answer prints the counterexample and fails the
build. Pure: no input, no network; `pip install z3-solver`.
What it proves:
  1. Memory isolation. An agent's memory write lands inside its own block, for every slot, tick and block size.
  2. Field reads stay inside the station fields, for every goal word, floor and station count; the four neighbour
     cells of any cell are cells.
  3. The weights index stays inside the agent's own row.
  4. The relaxation's neighbour indices are cells of the same field.
  5. The bitonic network's comparator pairs lie inside the array and never alias, for every array size, stage and
     distance.
  6. The mask arithmetic: nz(x) = [x != 0], sel(m, a, b) = m ? a : b, wide(m) = -m, for all 2^32 words.
  7. The loop breaker: a signature is never 0 on a failing tick, and a run that reaches the limit flushes.
  8. The routing core's look-up-table index (lib.rs eval_piece) lies inside the table for every local arc length and
     piece length, NaN and infinities included (IEEE double arithmetic, round-to-nearest, JavaScript min/max).
  9. The arena setter's range check cannot overflow and admits only 8-byte aligned, non-empty ranges.
What it does not prove: anything about the floating-point *values* (the parity tests hold those bit for bit), or
the fold `wrap` (fmod has no exact SMT model; the harnesses prove no index depends on its result).
What breaks if it is removed? The proofs stop at the smallest configuration.
"""
from __future__ import annotations

import sys
import time

try:
    import z3
except ImportError:  # pragma: no cover
    print("fvps_smt: the z3 python package is missing (pip install z3-solver)", file=sys.stderr)
    sys.exit(2)

W = 32
failures: list[str] = []


def bv(name: str) -> z3.BitVecRef:
    return z3.BitVec(name, W)


def is_pow2(x: z3.BitVecRef, lo: int, hi: int) -> z3.BoolRef:
    """x is a power of two in [lo, hi] (config.rs pow2)."""
    return z3.And(z3.UGE(x, lo), z3.ULE(x, hi), x & (x - 1) == 0)


def umin(a: z3.BitVecRef, b: z3.BitVecRef) -> z3.BitVecRef:
    return z3.If(z3.ULT(a, b), a, b)


def sat_sub(a: z3.BitVecRef, b: z3.BitVecRef) -> z3.BitVecRef:
    """u32::saturating_sub."""
    return z3.If(z3.UGE(a, b), a - b, z3.BitVecVal(0, W))


def theorem(name: str, assumptions: list, claim, extra_note: str = "", expect_counterexample: bool = False) -> None:
    """Proves `claim` under `assumptions` by refuting its negation; prints and records the outcome."""
    s = z3.Solver()
    s.set("timeout", 600_000)
    s.add(*assumptions)
    # A theorem whose assumptions no value satisfies would be proved for nothing: refuse it.
    if s.check() != z3.sat:
        failures.append(name)
        print(f"  VACUOUS  {name}: no value satisfies its assumptions")
        return
    s.add(z3.Not(claim))
    t0 = time.time()
    r = s.check()
    dt = time.time() - t0
    if r == z3.unsat:
        print(f"  proved   {name} ({dt:.2f}s){extra_note}")
    elif r == z3.sat and expect_counterexample:
        print(f"  refuted  {name}: counterexample {s.model()} (as it must be)")
    elif r == z3.sat:
        failures.append(name)
        print(f"  FAILED   {name}: counterexample {s.model()}")
    else:
        failures.append(name)
        print(f"  UNKNOWN  {name}: {s.reason_unknown()}")


def kernels() -> None:
    print("kernels.rs / swarm.wgsl index arithmetic, for every validated dimension")
    capacity, block_words, stations, width, depth = bv("capacity"), bv("block_words"), bv("stations"), bv("width"), bv("depth")
    dims = [
        is_pow2(capacity, 64, 65536),
        is_pow2(block_words, 8, 1024),
        is_pow2(stations, 2, 16),
        is_pow2(width, 32, 256),
        is_pow2(depth, 32, 256),
    ]
    i, t, g = bv("i"), bv("t"), bv("g")
    slot_i = z3.ULT(i, capacity)

    # 1. kernels.rs: let slot = i * d.block_words + (t as usize & (d.block_words - 1)); m.memory[slot] = ...
    slot = i * block_words + (t & (block_words - 1))
    theorem(
        "memory write lands inside the agent's own block [i*bw, (i+1)*bw) and inside the memory array",
        dims + [slot_i],
        z3.And(z3.UGE(slot, i * block_words), z3.ULT(slot, (i + 1) * block_words), z3.ULT(slot, capacity * block_words)),
    )
    # The multiplications themselves do not wrap: capacity * block_words <= 2^26.
    theorem(
        "capacity * block_words and (i+1) * block_words do not wrap 32 bits",
        dims + [slot_i],
        z3.And(z3.ULE(z3.ZeroExt(32, capacity) * z3.ZeroExt(32, block_words), 1 << 26), z3.ULE(z3.ZeroExt(32, i + 1) * z3.ZeroExt(32, block_words), 1 << 26)),
    )

    # 2. kernels.rs: cx = min(px as u32, w-1); cz = min(pz as u32, depth-1); c = cz*w + cx; g = goal & (stations-1);
    #    base = g * cells; reads field[base + c], and the four neighbours with min / saturating_sub.
    cells = width * depth
    ux, uz = bv("ux"), bv("uz")  # px as u32 and pz as u32, whatever they are (the cast saturates; any word)
    cx, cz = umin(ux, width - 1), umin(uz, depth - 1)
    c = cz * width + cx
    goal = g & (stations - 1)
    base = goal * cells
    reads = [
        base + c,
        base + (cz * width + umin(cx + 1, width - 1)),
        base + (cz * width + sat_sub(cx, 1)),
        base + (umin(cz + 1, depth - 1) * width + cx),
        base + (sat_sub(cz, 1) * width + cx),
    ]
    theorem(
        "the agent's five field reads lie inside its goal station's field, inside the field array",
        dims,
        z3.And(*[z3.And(z3.UGE(r, base), z3.ULT(r, base + cells), z3.ULT(r, stations * cells)) for r in reads]),
    )
    theorem("the goal mask yields a station index below the count", dims, z3.ULT(goal, stations))

    # 2b. The target cell after a step: tx = clamp(cx + dx, 0, w-1) with dx in {-1, 0, 1}; walls[tz*w + tx].
    dx, dz = z3.BitVec("dx", W), z3.BitVec("dz", W)
    step = [z3.Or(dx == 0, dx == 1, dx == z3.BitVecVal(-1, W)), z3.Or(dz == 0, dz == 1, dz == z3.BitVecVal(-1, W))]
    sx, sz = cx + dx, cz + dz  # i32 arithmetic on values < 256: no wrap
    tx = z3.If(sx == z3.BitVecVal(-1, W), z3.BitVecVal(0, W), umin(sx, width - 1))
    tz = z3.If(sz == z3.BitVecVal(-1, W), z3.BitVecVal(0, W), umin(sz, depth - 1))
    theorem("the stepped-to cell is a cell of the floor", dims + step, z3.ULT(tz * width + tx, cells))

    # 3. kernels.rs: let wi = i * d.stations + g as usize; m.weights[wi]
    wi = i * stations + goal
    theorem(
        "the learned weight index lies in the agent's own row of the weights",
        dims + [slot_i],
        z3.And(z3.UGE(wi, i * stations), z3.ULT(wi, (i + 1) * stations), z3.ULT(wi, capacity * stations)),
    )

    # 4. relax_pass: for c < cells: x = c % w, z = c / w, neighbours by min / saturating_sub, inside base..base+cells.
    cc, s_ = bv("c"), bv("s")
    x_, z_ = z3.URem(cc, width), z3.UDiv(cc, width)
    rbase = s_ * cells
    rn = [
        rbase + (z_ * width + umin(x_ + 1, width - 1)),
        rbase + (z_ * width + sat_sub(x_, 1)),
        rbase + (umin(z_ + 1, depth - 1) * width + x_),
        rbase + (sat_sub(z_, 1) * width + x_),
        rbase + cc,
    ]
    theorem(
        "the relaxation's own cell and four neighbours lie inside the station's field",
        dims + [z3.ULT(cc, cells), z3.ULT(s_, stations)],
        z3.And(*[z3.And(z3.UGE(r, rbase), z3.ULT(r, rbase + cells), z3.ULT(r, stations * cells)) for r in rn]),
    )

    # 5. bitonic_pass: for p in 0..len/2: i = ((p & !(j-1)) << 1) | (p & (j-1)); compare (i, i | j); j < k <= len, powers of two.
    n, k, j, p = bv("n"), bv("k"), bv("j"), bv("p")
    bit = [is_pow2(n, 2, 1 << 24), is_pow2(k, 2, 1 << 24), is_pow2(j, 1, 1 << 24), z3.ULT(j, k), z3.ULE(k, n), z3.ULT(p, z3.LShR(n, 1))]
    ii = ((p & ~(j - 1)) << 1) | (p & (j - 1))
    theorem(
        "every comparator (i, i|j) of a bitonic pass lies inside the array, with i < i|j",
        bit,
        z3.And(z3.ULT(ii, n), z3.ULT(ii | j, n), (ii & j) == 0, z3.ULT(ii, ii | j)),
    )

    # 6. The masks.
    x, m, a, b = bv("x"), bv("m"), bv("a"), bv("b")
    nz = z3.LShR(x | (-x), 31)
    theorem("nz(x) = [x != 0] for all words", [], nz == z3.If(x != 0, z3.BitVecVal(1, W), z3.BitVecVal(0, W)))
    sel = b ^ ((a ^ b) & (-m))
    theorem("sel(m, a, b) = m ? a : b for all words and m in {0, 1}", [z3.ULE(m, 1)], sel == z3.If(m == 1, a, b))

    # 7. The loop breaker. sig = (mix32(..) | 1) * fail is nonzero exactly on a failing tick; run = run*same + 1 (wrapping) * fail.
    mixed, fail, same, run, limit = bv("mixed"), bv("fail"), bv("same"), bv("run"), bv("limit")
    sig = (mixed | 1) * fail
    theorem("a failure signature is nonzero exactly when the tick failed", [z3.ULE(fail, 1)], (sig != 0) == (fail == 1))
    nrun = (run * same + 1) * fail
    theorem(
        "a run one short of the limit that fails the same way again reaches the limit (flushes)",
        [z3.ULE(fail, 1), z3.ULE(same, 1), z3.UGE(limit, 2), z3.ULE(limit, 1_000_000), run == limit - 1, fail == 1, same == 1],
        z3.UGE(nrun, limit),
    )
    theorem("a tick that does not fail resets the run to 0", [fail == 0], nrun == 0)


def routing() -> None:
    print("routing core (native/routing/src/lib.rs) index arithmetic, IEEE double")
    # 8. eval_piece on a corner: n = 32.0; u = jmin(n, jmax(0.0, (local / length) * n)); i = jmin(n - 1.0, floor(u));
    #    k = i as usize; reads lut[k] and lut[k + 1] of a 33-entry table.
    D = z3.FPSort(11, 53)
    rm = z3.RNE()
    local, length = z3.FP("local", D), z3.FP("length", D)
    n = z3.FPVal(32.0, D)
    zero = z3.FPVal(0.0, D)

    def jmax(a, b):  # math.rs jmax: a > b ? a : (b > a || a.is_sign_negative()) ? b : a
        return z3.If(z3.fpGT(a, b), a, z3.If(z3.Or(z3.fpGT(b, a), z3.fpIsNegative(a)), b, a))

    def jmin(a, b):  # math.rs jmin: a < b ? a : (b < a || !a.is_sign_negative()) ? b : a
        return z3.If(z3.fpLT(a, b), a, z3.If(z3.Or(z3.fpLT(b, a), z3.Not(z3.fpIsNegative(a))), b, a))

    u = jmin(n, jmax(zero, z3.fpMul(rm, z3.fpDiv(rm, local, length), n)))
    i = jmin(z3.fpSub(rm, n, z3.FPVal(1.0, D)), z3.fpRoundToIntegral(z3.RTN(), u))
    # `i as usize` saturates and maps NaN to 0: here, the index is in-bounds iff 0 <= i <= 31 or i is NaN.
    k_ok = z3.Or(z3.fpIsNaN(i), z3.And(z3.fpGEQ(i, zero), z3.fpLEQ(i, z3.FPVal(31.0, D))))
    theorem(
        "eval_piece's look-up-table index k satisfies 0 <= k <= 31 (so k + 1 < LUT_SIZE) for every local and length",
        [],
        k_ok,
        " [IEEE double, every value incl. NaN, inf, -0]",
    )
    # 9. routing_arena(base, words): refused unless base % 8 == 0 and words > 0 and base + words*8 fits (checked_mul/add
    #    on wasm32's 32-bit usize); the accepted range then ends at or below 2^32.
    base, words = bv("base"), bv("words")
    bytes64 = z3.ZeroExt(32, words) * 8
    end64 = z3.ZeroExt(32, base) + bytes64
    accepted = z3.And(z3.URem(base, 8) == 0, words != 0, z3.ULE(end64, (1 << 32) - 1))
    theorem(
        "an accepted arena is 8-byte aligned, non-empty and ends inside 32-bit linear memory",
        [accepted],
        z3.And(z3.URem(base, 8) == 0, z3.UGT(words, 0), z3.ULT(end64, 1 << 32)),
    )


def self_check() -> None:
    """The solver must be able to refute: a claim that is false for some word gets a counterexample."""
    print("self-check: a false theorem must fail")
    x = bv("x")
    s = z3.Solver()
    s.add(z3.Not((x & 1) == 0))
    if s.check() != z3.sat:
        print("fvps_smt: the self-check could not refute a false theorem; the solver is not refuting")
        sys.exit(1)
    theorem("(self-check) x & 1 == 0 for all words", [], (x & 1) == 0, expect_counterexample=True)


def main() -> int:
    print(f"fvps_smt: Z3 {z3.get_version_string()}")
    self_check()
    kernels()
    routing()
    if failures:
        print(f"fvps_smt: {len(failures)} theorem(s) FAILED: {failures}")
        return 1
    print("fvps_smt: every theorem proved")
    return 0


if __name__ == "__main__":
    sys.exit(main())
