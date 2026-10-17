#!/bin/sh
# Copyright (c) 2026 Julian Cassius Subban
# SPDX-License-Identifier: MIT
# Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
# Why does this file exist? It is the one list of the checks the pipeline runs, by name, so that ci.yml, the
# self-healing agent (tools/selfheal/agent.mjs) and its sandbox run exactly the same commands and a check is spelled
# once. `sh tools/selfheal/checks.sh NAME...` runs the named checks in order from the repository root and exits 1 on
# the first failure; `all` runs every check; `list` prints the names. Each check's output is what the agent's
# failure parsers read (failures.mjs), so a check keeps its tool's own output format.
# What breaks if it is removed? The agent, CI and a contributor would each run a different idea of "the checks".
set -u
cd "$(dirname "$0")/../.."

ALL="page-tsc page-lint page-test page-build page-smoke native-test rust-test rust-clippy fvps-smt fvps-wasm fvps-kani selfheal-test license-headers"

run_one() {
  case "$1" in
    page-tsc)      npx tsc -b ;;
    page-lint)     npx oxlint ;;
    page-test)     node --test "src/**/*.test.ts" ;;
    page-build)    npm run build && ! grep -qE 'from *"node:(net|http|https|fs|child_process)"|replication\.node|mirror\.node' dist/index.html ;;
    page-smoke)    node tools/net/smoke.mjs ;;
    native-test)   cargo test --manifest-path native/routing/Cargo.toml && cargo test --manifest-path native/kv-pager/Cargo.toml && cargo test --manifest-path native/kv-pager-wasm/Cargo.toml ;;
    rust-test)     (cd crimson_noir_os && cargo test --workspace --locked) ;;
    rust-clippy)   (cd crimson_noir_os && cargo clippy --workspace --all-targets --locked -- -D warnings) && cargo clippy --manifest-path native/routing/Cargo.toml --all-targets -- -D warnings ;;
    fvps-smt)      python3 tools/verify/fvps_smt.py ;;
    fvps-wasm)     sh tools/verify/fvps.sh wasm ;;
    fvps-kani)     sh tools/verify/fvps.sh kani ;;
    selfheal-test) node --test tools/selfheal/*.test.mjs ;;
    license-headers) node tools/license/headers.mjs check ;;
    # Not in ALL: it needs a Chrome or Chromium (ci.yml's browser job has one) and dist/ from page-build. The
    # screenshots go to $BROWSER_SHOTS when it is set.
    page-browser)  node tools/browser/smoke.mjs ${BROWSER_SHOTS:+--out "$BROWSER_SHOTS"} ;;
    # Not in ALL: it passes only inside the docker sandbox (tools/sandbox/verify.mjs runs it there, and ci.yml's
    # sandbox job); on a host it reports the host's escapes, which is its control.
    sandbox-probe) sh tools/sandbox/probe.sh ;;
    *) echo "checks.sh: no check named $1" >&2; return 2 ;;
  esac
}

if [ "$#" -eq 0 ] || [ "$1" = "list" ]; then echo "$ALL"; exit 0; fi
if [ "$1" = "all" ]; then set -- $ALL; fi
for c in "$@"; do
  echo "::group::check $c"
  if run_one "$c"; then echo "::endgroup::"; echo "check $c: ok"; else s=$?; echo "::endgroup::"; echo "check $c: FAILED ($s)"; exit 1; fi
done
