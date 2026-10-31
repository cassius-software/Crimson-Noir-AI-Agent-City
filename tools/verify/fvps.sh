#!/bin/sh
# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
# Why does this file exist? It is the formal verification step of the pipeline (FVPS), one command: `sh
# tools/verify/fvps.sh [all|kani [HARNESS...]|smt|wasm|ir]`, run by ci.yml and before every release bake (build-release.yml), and
# by tools/selfheal/checks.sh. It hard-fails the build when any proof fails. A machine without a POSIX shell (Windows
# cmd.exe or PowerShell) runs the same step as `npm run verify` (tools/verify/fvps.mjs, kept one for one with this file):
# - kani: the Kani model checker (CBMC, bit-precise) over the proof harnesses in
#   crimson_noir_os/crates/noir_core/src/verify.rs (the kernels: an agent's tick touches only its own row, weights
#   and memory block, stays on the floor, never traps) and native/routing/src/verify.rs (the WebAssembly routing
#   core never traps on any arena, and every index it computes is in bounds). Needs `cargo kani` (cargo install
#   kani-verifier && cargo kani setup). Each harness runs on its own: the checker's memory is the bound.
# - smt: tools/verify/fvps_smt.py, the index arithmetic of the kernels and the core as theorems over 32-bit words and
#   IEEE doubles, proved by Z3 for every validated dimension (pip install z3-solver).
# - wasm: tools/verify/wasm_airgap.py, the modules the page carries import nothing, own one memory and export only
#   what the host binds; with a toolchain for wasm32-unknown-unknown present, the routing crate is rebuilt and must
#   give the committed bytes.
# - ir: the routing core's LLVM IR, emitted from the same compilation that makes the module, scanned for what it
#   can call: only LLVM intrinsics, the four libm functions compiler-builtins provides, and core's panic entry
#   points (every one of which is a trap the harnesses prove unreachable). Any other external call fails the build.
# What this proves and does not prove is written at the top of each harness file and script; in one line: no
# execution path of the verified functions reaches a memory trap or an out-of-bounds index for the dimensions the
# harnesses fix and for every dimension the theorems quantify over, and the modules cannot reach anything outside
# their own memory. It does not prove the floating-point values (the parity tests do, bit for bit).
# What breaks if it is removed? Nothing in the pipeline proves anything; the tests alone run on chosen inputs.
set -eu
cd "$(dirname "$0")/../.."
mode=${1:-all}
status=0

kani_one() {
  # $1 crate dir, $2 harness, $3... extra args
  dir=$1; h=$2; shift 2
  log=${TMPDIR:-/tmp}/kani-$(basename "$dir")-$h.log
  echo "::group::kani $dir $h"
  (cd "$dir" && cargo kani "$@" --harness "$h" > "$log" 2>&1) || true
  grep -E "^(VERIFICATION|Verification Time|Failed Checks| \*\*|CBMC|error)" "$log" || tail -n 20 "$log"
  echo "::endgroup::"
  if grep -q "^VERIFICATION:- SUCCESSFUL" "$log"; then echo "kani $dir $h: proved"; else echo "::error::kani $dir $h: FAILED (see $log)"; status=1; fi
}

CORE_HARNESSES="masks_mean_what_the_kernels_take_them_to_mean compare_exchange_orders_the_pair bitonic_pass_stays_in_bounds
  flush_zeroes_one_row_only agent_tick_is_isolated_to_its_own_row relax_pass_stays_in_bounds
  an_undeclared_privilege_drops_the_pointer_for_every_matrix a_declared_request_never_drops_the_pointer"
ROUTING_HARNESSES="arena_setter_never_traps no_track_is_refused_not_trapped no_track_is_refused_by_the_projection
  check_never_traps_on_any_arena pose_at_never_traps_on_one_piece pose_at_never_traps_on_two_pieces
  next_stop_and_speed_limit_never_trap project_onto_never_traps_on_a_short_piece"

# `kani` alone runs every harness; `kani NAME...` runs the named ones (ci.yml spreads them over parallel jobs).
# The routing harnesses run with the checker's floating-point checks off (--no-overflow-checks): an operation that
# produces a NaN is not a trap (a NaN arc length answers NaN, as the TypeScript reference does; the parity fuzz
# holds that), and the harnesses' subject is what traps: bounds, pointers, integer overflow, unwraps, assertions.
run_kani() {
  command -v cargo-kani > /dev/null || { echo "::error::cargo kani is not installed (cargo install kani-verifier && cargo kani setup)"; return 1; }
  wanted="$*"
  for h in $CORE_HARNESSES; do
    if [ -z "$wanted" ] || echo " $wanted " | grep -q " $h "; then kani_one crimson_noir_os "$h" -p noir_core; fi
  done
  for h in $ROUTING_HARNESSES; do
    if [ -z "$wanted" ] || echo " $wanted " | grep -q " $h "; then kani_one native/routing "$h" -Z stubbing --no-overflow-checks; fi
  done
}

# Not `python3 -I`: isolated mode drops the user site-packages, where a runner's `pip install z3-solver` lands.
run_smt() { python3 tools/verify/fvps_smt.py || status=1; }

# The modules are built with the checkout mapped to one fixed prefix (tools/native/build-wasm.mjs REMAP), so a
# rebuild on any machine gives the committed bytes; the same flag here, or the comparison below would fail on every
# other checkout path.
WASM_RUSTFLAGS="--remap-path-prefix=$(pwd)=/crimson-noir"

run_wasm() {
  if rustup target list --installed 2> /dev/null | grep -q wasm32-unknown-unknown; then
    RUSTFLAGS="$WASM_RUSTFLAGS" cargo build --release --target wasm32-unknown-unknown --manifest-path native/routing/Cargo.toml --quiet
    RUSTFLAGS="$WASM_RUSTFLAGS" cargo build --release --target wasm32-unknown-unknown --manifest-path native/kv-pager-wasm/Cargo.toml --quiet
    python3 -I tools/verify/wasm_airgap.py \
      --rebuilt-routing native/routing/target/wasm32-unknown-unknown/release/routing.wasm \
      --rebuilt-kv-pager native/kv-pager-wasm/target/wasm32-unknown-unknown/release/kv_pager_wasm.wasm || status=1
  else
    echo "wasm32-unknown-unknown is not installed: checking the committed modules only"
    python3 -I tools/verify/wasm_airgap.py || status=1
  fi
}

run_ir() {
  rustup target list --installed 2> /dev/null | grep -q wasm32-unknown-unknown || { echo "ir: wasm32-unknown-unknown is not installed; skipped"; return 0; }
  RUSTFLAGS="$WASM_RUSTFLAGS" cargo rustc --manifest-path native/routing/Cargo.toml --release --target wasm32-unknown-unknown --quiet -- --emit=llvm-ir
  ir=native/routing/target/wasm32-unknown-unknown/release/deps/routing.ll
  test -f "$ir" || { echo "::error::ir: $ir was not emitted"; status=1; return 0; }
  # Everything the module can call that is not defined in it. Allowed: LLVM intrinsics, the four libm symbols the
  # crate declares (math.rs; resolved by compiler-builtins at link, no import results: wasm_airgap proves it), and
  # core's panic entry points, which the wasm32 panic handler turns into `unreachable` traps.
  bad=$(grep -E '^declare ' "$ir" | sed -E 's/^declare [^@]*@([A-Za-z0-9_.$]+).*/\1/' \
    | grep -vE '^llvm\.' | grep -vE '^(sqrt|floor|ceil|atan2)$' | grep -vE 'core[0-9]*(panicking|slice5index|panic)' || true)
  traps=$(grep -cE 'call .*@(_RNv[A-Za-z0-9_]*(panic_bounds_check|slice_index_fail|panic)|llvm\.trap)' "$ir" || true)
  echo "ir: $(grep -c '^define' "$ir") functions defined, $(grep -c '^declare' "$ir") external declarations, $traps trap sites (panic entry points the harnesses prove unreachable)"
  if [ -n "$bad" ]; then echo "::error::ir: the routing core calls outside itself: $bad"; status=1; else echo "ir: no external call but LLVM intrinsics, libm and core's panic traps"; fi
}

case "$mode" in
  all) run_smt; run_wasm; run_ir; run_kani ;;
  kani) shift; run_kani "$@" ;;
  smt) run_smt ;;
  wasm) run_wasm ;;
  ir) run_ir ;;
  *) echo "fvps.sh: all|kani|smt|wasm|ir" >&2; exit 2 ;;
esac
if [ "$status" -ne 0 ]; then echo "::error::FVPS: a proof failed; the build is refused"; exit 1; fi
echo "FVPS ($mode): every proof holds"
