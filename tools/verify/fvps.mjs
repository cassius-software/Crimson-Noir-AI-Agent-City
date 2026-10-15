#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the formal verification step (FVPS) for a machine without a POSIX shell: Windows
 * cmd.exe or PowerShell, where `sh tools/verify/fvps.sh` answers "'sh' is not recognized". `npm run verify
 * [-- all|kani [HARNESS...]|smt|wasm|ir]` runs the same four parts fvps.sh runs, with the same programs, the same
 * arguments and the same pass/fail reading of their output; fvps.sh stays what ci.yml, build-release.yml and
 * tools/selfheal/checks.sh run, so the release gate is unchanged. The two must say the same thing: a change to one
 * is a change to the other (the harness lists, the flags, the log patterns are copied verbatim).
 * - smt: tools/verify/fvps_smt.py under the first Python found (python3, python, then the py launcher);
 * - wasm: tools/verify/wasm_airgap.py over the committed modules; with the wasm32-unknown-unknown target installed,
 *   the crates are rebuilt and compared too, except on Windows, where rustc writes the source paths of panic
 *   locations with backslashes, so the bytes differ from the committed (Linux-built) modules by construction and the
 *   comparison is skipped with a note;
 * - ir: the routing core's LLVM IR, scanned for external calls exactly as fvps.sh scans it;
 * - kani: `cargo kani` per harness. Kani runs on Linux and macOS only, so on Windows `npm run verify` (all) leaves it out
 *   with a note and its last line says so, since no proof failed; `npm run verify -- kani` on Windows is an error
 *   (use WSL).
 * What breaks if it is removed? A Windows machine cannot run the proofs the README names without WSL or Git Bash.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const WINDOWS = process.platform === 'win32'
const args = process.argv.slice(2)
const mode = args[0] ?? 'all'
let status = 0
/** The parts not run on this platform, named in the last line so a pass never reads as more than it is. */
const skipped = []

const CORE_HARNESSES = [
  'masks_mean_what_the_kernels_take_them_to_mean', 'compare_exchange_orders_the_pair', 'bitonic_pass_stays_in_bounds',
  'flush_zeroes_one_row_only', 'agent_tick_is_isolated_to_its_own_row', 'relax_pass_stays_in_bounds',
]
const ROUTING_HARNESSES = [
  'arena_setter_never_traps', 'no_track_is_refused_not_trapped', 'no_track_is_refused_by_the_projection',
  'check_never_traps_on_any_arena', 'pose_at_never_traps_on_one_piece', 'pose_at_never_traps_on_two_pieces',
  'next_stop_and_speed_limit_never_trap', 'project_onto_never_traps_on_a_short_piece',
]

// The same flag build-wasm.mjs and fvps.sh use: the checkout mapped to one fixed prefix, so a rebuild gives the committed bytes.
const WASM_RUSTFLAGS = `--remap-path-prefix=${ROOT}=/crimson-noir`
const TARGET = 'wasm32-unknown-unknown'

/** Runs a program with an argument vector (never a shell), in the repository root unless `cwd` says otherwise. */
function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: opts.capture ? 'pipe' : 'inherit', ...opts })
  if (r.error) return { ok: false, out: '', err: r.error.message, missing: r.error.code === 'ENOENT' }
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? '', missing: false }
}

function error(msg) { console.log(`::error::${msg}`); status = 1 }

/** The Python this machine has: `python3` on Linux and macOS, `python` or the `py -3` launcher on Windows. */
function python() {
  for (const [cmd, pre] of [['python3', []], ['python', []], ['py', ['-3']]]) {
    const r = run(cmd, [...pre, '-c', 'import sys; sys.exit(0 if sys.version_info[0] == 3 else 1)'], { capture: true })
    if (r.ok) return { cmd, pre }
  }
  return undefined
}

function wasmTargetInstalled() {
  const r = run('rustup', ['target', 'list', '--installed'], { capture: true })
  return r.ok && r.out.split(/\r?\n/).includes(TARGET)
}

// Not `-I`: isolated mode drops the user site-packages, where `pip install z3-solver` lands (as fvps.sh says).
function runSmt() {
  const py = python()
  if (!py) { error('smt: no Python 3 found (python3, python or py); pip install z3-solver needs one'); return }
  if (!run(py.cmd, [...py.pre, 'tools/verify/fvps_smt.py']).ok) status = 1
}

function runWasm() {
  const py = python()
  if (!py) { error('wasm: no Python 3 found (python3, python or py)'); return }
  const env = { ...process.env, RUSTFLAGS: WASM_RUSTFLAGS }
  if (wasmTargetInstalled() && !WINDOWS) {
    for (const crate of ['native/routing', 'native/kv-pager-wasm']) {
      if (!run('cargo', ['build', '--release', '--target', TARGET, '--manifest-path', `${crate}/Cargo.toml`, '--quiet'], { env }).ok) { error(`wasm: cargo build of ${crate} failed`); return }
    }
    const ok = run(py.cmd, [...py.pre, '-I', 'tools/verify/wasm_airgap.py',
      '--rebuilt-routing', `native/routing/target/${TARGET}/release/routing.wasm`,
      '--rebuilt-kv-pager', `native/kv-pager-wasm/target/${TARGET}/release/kv_pager_wasm.wasm`]).ok
    if (!ok) status = 1
  } else {
    if (WINDOWS && wasmTargetInstalled()) console.log('wasm: on Windows a rebuild embeds backslash source paths and cannot match the committed (Linux-built) bytes; checking the committed modules only (ci.yml compares a rebuild on Linux)')
    else console.log(`${TARGET} is not installed: checking the committed modules only`)
    if (!run(py.cmd, [...py.pre, '-I', 'tools/verify/wasm_airgap.py']).ok) status = 1
  }
}

function runIr() {
  if (!wasmTargetInstalled()) { console.log(`ir: ${TARGET} is not installed; skipped`); return }
  const env = { ...process.env, RUSTFLAGS: WASM_RUSTFLAGS }
  if (!run('cargo', ['rustc', '--manifest-path', 'native/routing/Cargo.toml', '--release', '--target', TARGET, '--quiet', '--', '--emit=llvm-ir'], { env }).ok) { error('ir: cargo rustc failed'); return }
  const ir = join(ROOT, 'native/routing/target', TARGET, 'release/deps/routing.ll')
  if (!existsSync(ir)) { error(`ir: ${ir} was not emitted`); return }
  const lines = readFileSync(ir, 'utf8').split(/\r?\n/)
  // Everything the module can call that is not defined in it. Allowed: LLVM intrinsics, the four libm symbols the
  // crate declares (math.rs; resolved by compiler-builtins at link), and core's panic entry points, which the wasm32
  // panic handler turns into `unreachable` traps. The patterns are fvps.sh's run_ir, one for one.
  const declared = lines.filter((l) => l.startsWith('declare ')).map((l) => l.replace(/^declare [^@]*@([A-Za-z0-9_.$]+).*/, '$1'))
  const bad = declared.filter((s) => !/^llvm\./.test(s) && !/^(sqrt|floor|ceil|atan2)$/.test(s) && !/core[0-9]*(panicking|slice5index|panic)/.test(s))
  const traps = lines.filter((l) => /call .*@(_RNv[A-Za-z0-9_]*(panic_bounds_check|slice_index_fail|panic)|llvm\.trap)/.test(l)).length
  const defined = lines.filter((l) => l.startsWith('define')).length
  console.log(`ir: ${defined} functions defined, ${declared.length} external declarations, ${traps} trap sites (panic entry points the harnesses prove unreachable)`)
  if (bad.length > 0) error(`ir: the routing core calls outside itself: ${bad.join(' ')}`)
  else console.log('ir: no external call but LLVM intrinsics, libm and core\'s panic traps')
}

function kaniOne(dir, harness, extra) {
  const log = join(mkdtempSync(join(tmpdir(), 'kani-')), `kani-${basename(dir)}-${harness}.log`)
  console.log(`::group::kani ${dir} ${harness}`)
  const r = run('cargo', ['kani', ...extra, '--harness', harness], { cwd: join(ROOT, dir), capture: true })
  const text = r.out + r.err
  writeFileSync(log, text)
  const lines = text.split(/\r?\n/)
  const picked = lines.filter((l) => /^(VERIFICATION|Verification Time|Failed Checks| \*\*|CBMC|error)/.test(l))
  console.log((picked.length > 0 ? picked : lines.slice(-20)).join('\n'))
  console.log('::endgroup::')
  if (lines.some((l) => l.startsWith('VERIFICATION:- SUCCESSFUL'))) console.log(`kani ${dir} ${harness}: proved`)
  else error(`kani ${dir} ${harness}: FAILED (see ${log})`)
}

// `kani` alone runs every harness; `kani NAME...` runs the named ones. The routing harnesses run with the checker's
// floating-point checks off (--no-overflow-checks), as fvps.sh explains: a NaN is not a trap; traps are the subject.
function runKani(wanted, { optional = false } = {}) {
  if (WINDOWS) {
    const why = 'Kani runs on Linux and macOS only; run `sh tools/verify/fvps.sh kani` under WSL'
    if (optional) { console.log(`kani: not run on Windows (${why})`); skipped.push('kani') } else error(`kani: ${why}`)
    return
  }
  if (run('cargo-kani', ['--version'], { capture: true }).missing) { error('cargo kani is not installed (cargo install kani-verifier && cargo kani setup)'); return }
  const pick = (h) => wanted.length === 0 || wanted.includes(h)
  for (const h of CORE_HARNESSES) if (pick(h)) kaniOne('crimson_noir_os', h, ['-p', 'noir_core'])
  for (const h of ROUTING_HARNESSES) if (pick(h)) kaniOne('native/routing', h, ['-Z', 'stubbing', '--no-overflow-checks'])
}

switch (mode) {
  case 'all': runSmt(); runWasm(); runIr(); runKani([], { optional: WINDOWS }); break
  case 'kani': runKani(args.slice(1)); break
  case 'smt': runSmt(); break
  case 'wasm': runWasm(); break
  case 'ir': runIr(); break
  default: console.error('fvps.mjs: all|kani|smt|wasm|ir'); process.exit(2)
}
if (status !== 0) { console.log('::error::FVPS: a proof failed; the build is refused'); process.exit(1) }
if (skipped.length > 0) console.log(`FVPS (${mode}): every proof that runs on this platform holds; not run here: ${skipped.join(', ')}`)
else console.log(`FVPS (${mode}): every proof holds`)
