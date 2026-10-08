// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the ephemeral, zero-trust container the self-healing agent re-runs the checks
 * in. A patch the planner formulated is never run in the agent's own tree: the tree is copied, the copy is
 * streamed into a fresh container as a tar archive (the container mounts nothing of the host), the checks run in
 * it, and the container is gone when they end. Only the checks' output and exit status come back.
 *
 * The containment (CONTAINMENT below is the one definition; tools/sandbox/probe.sh is the proof that it holds):
 * - the air gap: `--network none` puts the checks in a network namespace of their own with only the loopback
 *   interface, no route, no DNS and no proxy (the proxy variables are passed empty, so a client finds none);
 * - no host trust: no bind mount at all. The tree arrives as a tar stream on stdin into /work, a tmpfs mounted
 *   `noexec,nosuid,nodev` (nothing a check writes there, and nothing a patch plants there, can be run or made a
 *   device); /tmp is the same kind of tmpfs; the image's root is read-only; the build output lives in /build,
 *   an anonymous volume docker creates empty for this container and removes with it (`--rm`), the one place with
 *   exec, because cargo's test binaries run from it. The Docker and D-Bus sockets, the runner's checkout (whose
 *   .git carries the workflow token), the home directory and every other host path are simply absent;
 * - no privilege: the process is the image's unprivileged `sandbox` user (uid 10001), with every capability
 *   dropped (`--cap-drop ALL`), `no-new-privileges` (a setuid file raises nothing), docker's default seccomp
 *   profile (no mount, no new user namespace, no ptrace of another process, no kernel keyring, no bpf) and
 *   private pid, ipc and cgroup namespaces; memory and process count are bounded;
 * - no secrets: the container's environment is built from an allowlist (ENV_ALLOWED) and never from the agent's
 *   own environment, where ANTHROPIC_API_KEY and GH_TOKEN live. A name that looks like a credential is refused.
 * What this does not do: the checks run the tree's own code (build scripts, tests, npm scripts) through the
 * interpreters and compilers the image carries; that is their job. The containment bounds what such code can
 * reach (nothing off the machine, nothing of the host, no privilege, no persistence), not whether it runs.
 * Where no docker is available (a developer's shell, the agent's own tests) `SELFHEAL_SANDBOX=host` runs the same
 * copy in a subprocess, which is isolation of the tree but not of the machine, and the report says which was used.
 * What breaks if it is removed? A patch would be tested in the tree it came from, with the network on.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const IMAGE = 'crimson-noir-selfheal-sandbox'

/** What is left out of the copy, at any depth: build output, dependencies the image carries, the history. */
export const EXCLUDE = ['.git', 'node_modules', 'target', 'dist', 'dist-ssr', 'dist-pilot', '.cache', '__pycache__']

/**
 * The containment policy, as data, so the tests can hold it and the report can print it. Every entry is a
 * `docker run` argument; the order is the order on the command line.
 */
export const CONTAINMENT = {
  /** The air gap: a network namespace with the loopback interface only. */
  network: ['--network', 'none'],
  /** No privilege: an unprivileged user, no capability, no privilege gain, docker's default seccomp profile. */
  privilege: ['--user', 'sandbox', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true'],
  /** Namespaces of its own (the pid and network ones are always private; these are spelled out). */
  namespaces: ['--ipc', 'private', '--cgroupns', 'private', '--hostname', 'sandbox'],
  /** The filesystem: a read-only root, tmpfs for the tree and /tmp (noexec,nosuid,nodev), one build volume. */
  filesystem: [
    '--read-only',
    '--tmpfs', '/work:rw,noexec,nosuid,nodev,size=1g,mode=1777',
    '--tmpfs', '/tmp:rw,noexec,nosuid,nodev,size=512m,mode=1777',
    '--mount', 'type=volume,dst=/build',
  ],
  /** Bounds. */
  bounds: ['--memory', '12g', '--pids-limit', '4096'],
}

/** Environment names the container may be given (besides those the image sets); everything else is refused. */
export const ENV_ALLOWED = new Set(['NOIR_REQUIRE_GPU', 'SELFHEAL_KANI', 'FUZZ_SCALE', 'FUZZ_SEED', 'RUST_BACKTRACE', 'CI'])

/** A name that looks like a credential is never passed, allowlist or not. */
export const CREDENTIAL_NAME = /TOKEN|SECRET|KEY|PASSWORD|PASSWD|CREDENTIAL|AUTH|COOKIE/i

/** The proxy variables, passed empty so that no client in the container finds a proxy. */
const PROXY_NAMES = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']

/**
 * The `-e NAME=VALUE` arguments for `env`: the allowed names only, no credential-shaped name, and the proxy
 * variables emptied. Throws on a refused name: a caller that tries to hand the sandbox a secret is a bug.
 */
export function envArgs(env = {}) {
  const out = []
  for (const [k, v] of Object.entries(env)) {
    if (CREDENTIAL_NAME.test(k)) throw new Error(`sandbox: refusing to pass ${k} into the container (a credential-shaped name)`)
    if (!ENV_ALLOWED.has(k)) throw new Error(`sandbox: ${k} is not an environment variable the container may be given`)
    out.push('-e', `${k}=${v}`)
  }
  for (const p of PROXY_NAMES) out.push('-e', `${p}=`)
  out.push('-e', 'HOME=/tmp/home', '-e', 'TMPDIR=/tmp', '-e', 'XDG_CACHE_HOME=/tmp/home/.cache')
  return out
}

/**
 * The whole `docker run` argument list for `checks` on a tree that arrives on stdin. `sh -c` in the container:
 * unpacks the tree into /work, links the image's installed modules and the build volume in (each crate's
 * `target` is a link to /build, the one mount with exec), then runs the checks.
 */
export function dockerArgs(checks, env = {}) {
  return [
    'run', '--rm', '-i',
    ...CONTAINMENT.network, ...CONTAINMENT.privilege, ...CONTAINMENT.namespaces, ...CONTAINMENT.filesystem, ...CONTAINMENT.bounds,
    ...envArgs(env),
    '-w', '/work',
    IMAGE, 'sh', '-c', ENTRY, 'checks', ...checks,
  ]
}

/** The container's entry script (a POSIX sh -c body; `$@` are the checks). */
export const ENTRY = [
  'set -e',
  'mkdir -p /tmp/home',
  'tar -xf - --no-same-owner -C /work',
  // A directory of links, not a link to the directory: tsc writes its build info under node_modules/.tmp, and
  // /deps is read-only; the packages themselves (and .bin, on the exec-able image layer) resolve through the links.
  'mkdir /work/node_modules && for e in /deps/node_modules/* /deps/node_modules/.[!.]*; do ln -s "$e" /work/node_modules/; done',
  'for d in crimson_noir_os native/routing native/kv-pager native/kv-pager-wasm; do mkdir -p "/build/$d" && ln -s "/build/$d" "/work/$d/target"; done',
  'exec sh tools/selfheal/checks.sh "$@"',
].join('\n')

/** A fresh copy of `tree` under the temp directory; the caller removes it. */
export function copyTree(tree) {
  const dir = mkdtempSync(join(tmpdir(), 'selfheal-'))
  cpSync(tree, dir, { recursive: true, filter: (src) => !src.slice(tree.length + 1).split('/').some((part) => EXCLUDE.includes(part)) })
  return dir
}

/**
 * The tree as a tar archive (a Buffer), without EXCLUDE; what the container is given. The archive holds the
 * tree's entries, not the tree itself (`.`): the container unpacks into /work as an unprivileged user, and a
 * `.` entry would make tar restore the mount point's mode and time, which that user may not.
 */
export function tarTree(tree) {
  const entries = readdirSync(tree).filter((n) => !EXCLUDE.includes(n))
  if (entries.length === 0) throw new Error(`sandbox: nothing to send from ${tree}`)
  const r = spawnSync('tar', ['-C', tree, ...EXCLUDE.map((e) => `--exclude=${e}`), '-cf', '-', ...entries], { maxBuffer: 1024 * 1024 * 1024 })
  if (r.status !== 0) throw new Error(`sandbox: tar of ${tree} failed: ${r.stderr}`)
  return r.stdout
}

/** True when docker can run a container here. */
export function dockerAvailable() {
  const r = spawnSync('docker', ['info'], { stdio: 'ignore' })
  return r.status === 0
}

/** Which sandbox the run uses: 'docker' unless SELFHEAL_SANDBOX=host or docker is missing. */
export function sandboxKind(env = process.env) {
  if (env.SELFHEAL_SANDBOX === 'host') return 'host'
  if (env.SELFHEAL_SANDBOX === 'docker') return 'docker'
  return dockerAvailable() ? 'docker' : 'host'
}

/** Builds the sandbox image from the tree's lockfiles (once; docker's own cache makes a rebuild cheap). */
export function buildImage(tree, log = console.log) {
  log(`sandbox: building ${IMAGE} from tools/selfheal/Dockerfile.sandbox`)
  execFileSync('docker', ['build', '-q', '-t', IMAGE, '-f', join(tree, 'tools/selfheal/Dockerfile.sandbox'), tree], { stdio: ['ignore', 'inherit', 'inherit'] })
}

/**
 * Runs `sh tools/selfheal/checks.sh CHECKS...` on `tree` in the sandbox. Returns { ok, output, kind }. In the
 * docker sandbox the tree is streamed in and the host keeps nothing of the run; in the host sandbox a copy is
 * made and removed. `timeoutMs` bounds the run (the loop breaker's cousin: a hung check is a failed one).
 */
export function runChecks(tree, checks, { kind = sandboxKind(), timeoutMs = 60 * 60 * 1000, env = {}, log = console.log } = {}) {
  if (kind === 'docker') {
    if (!existsSync(join(tree, 'tools/selfheal/Dockerfile.sandbox'))) throw new Error('no tools/selfheal/Dockerfile.sandbox in the tree')
    log(`sandbox: docker run, air-gapped, no host mount (${checks.join(' ')})`)
    const r = spawnSync('docker', dockerArgs(checks, env), { input: tarTree(tree), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs })
    const raw = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\nsandbox: ${r.error.message}` : '')
    // Paths in the output name /work; the tree's own paths are what the map reads.
    return { ok: r.status === 0, output: raw.split('/work/').join(tree + '/'), kind }
  }
  const copy = copyTree(tree)
  try {
    log(`sandbox: host subprocess in ${copy} (${checks.join(' ')})`)
    if (existsSync(join(tree, 'node_modules')) && !existsSync(join(copy, 'node_modules'))) {
      spawnSync('ln', ['-s', join(tree, 'node_modules'), join(copy, 'node_modules')])
    }
    // A nested `node --test` must not think it is a child of the test runner that started the agent.
    const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')))
    const r = spawnSync('sh', ['tools/selfheal/checks.sh', ...checks], { cwd: copy, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, env: { ...clean, ...env } })
    const raw = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\nsandbox: ${r.error.message}` : '')
    return { ok: r.status === 0, output: raw.split(copy).join(tree), kind }
  } finally {
    removeCopy(copy, log)
  }
}

/**
 * Removes a copy the host sandbox ran on. A copy that cannot be removed is logged and left: a leftover temporary
 * directory is not a failed check, and must not end the agent's run.
 */
export function removeCopy(copy, log = console.log) {
  try {
    rmSync(copy, { recursive: true, force: true })
  } catch (e) {
    log(`sandbox: could not remove ${copy} (${e.code ?? e.message}); it is left behind`)
  }
}
