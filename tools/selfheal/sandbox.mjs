/**
 * Why does this file exist? It is the ephemeral container the self-healing agent re-runs the checks in. A patch the
 * planner formulated is never run in the agent's own tree: the tree is copied, the copy is run inside a fresh
 * container (`docker run --rm`, no network, the image built once per run from tools/selfheal/Dockerfile.sandbox
 * with every toolchain and dependency already in it) and the container is gone when the checks end. Only the
 * checks' output and exit status come back. Where no docker is available (a developer's shell, the agent's own
 * tests) `SELFHEAL_SANDBOX=host` runs the same copy in a subprocess, which is isolation of the tree but not of the
 * machine, and the report says which was used.
 * What breaks if it is removed? A patch would be tested in the tree it came from, with the network on.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const IMAGE = 'crimson-noir-selfheal-sandbox'

/** What is left out of the copy: build output and dependencies the image carries (or the copy reinstalls). */
const EXCLUDE = new Set(['.git', 'node_modules', 'target', 'dist', '.cache'])

/** A fresh copy of `tree` under the temp directory; the caller removes it. */
export function copyTree(tree) {
  const dir = mkdtempSync(join(tmpdir(), 'selfheal-'))
  cpSync(tree, dir, { recursive: true, filter: (src) => !EXCLUDE.has(src.slice(tree.length + 1).split('/')[0] ?? '') })
  return dir
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
 * Runs `sh tools/selfheal/checks.sh CHECKS...` on a copy of `tree` in the sandbox. Returns { ok, output, kind } and
 * removes the copy. `timeoutMs` bounds the run (the loop breaker's cousin: a hung check is a failed one).
 */
export function runChecks(tree, checks, { kind = sandboxKind(), timeoutMs = 60 * 60 * 1000, env = {}, log = console.log } = {}) {
  const copy = copyTree(tree)
  try {
    let r
    if (kind === 'docker') {
      if (!existsSync(join(tree, 'tools/selfheal/Dockerfile.sandbox'))) throw new Error('no tools/selfheal/Dockerfile.sandbox in the tree')
      log(`sandbox: docker run --network none (${checks.join(' ')})`)
      r = spawnSync('docker', [
        'run', '--rm', '--network', 'none', '--memory', '12g', '--pids-limit', '4096',
        '-v', `${copy}:/work`, '-w', '/work',
        ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        IMAGE, 'sh', '-c', 'cp -r /deps/node_modules . 2>/dev/null; sh tools/selfheal/checks.sh "$@"', 'checks', ...checks,
      ], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs })
    } else {
      log(`sandbox: host subprocess in ${copy} (${checks.join(' ')})`)
      if (existsSync(join(tree, 'node_modules')) && !existsSync(join(copy, 'node_modules'))) {
        spawnSync('ln', ['-s', join(tree, 'node_modules'), join(copy, 'node_modules')])
      }
      // A nested `node --test` must not think it is a child of the test runner that started the agent.
      const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('NODE_TEST')))
      r = spawnSync('sh', ['tools/selfheal/checks.sh', ...checks], { cwd: copy, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: timeoutMs, env: { ...clean, ...env } })
    }
    // Paths in the output name the copy (or /work in the container); the tree's own paths are what the map reads.
    const raw = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\nsandbox: ${r.error.message}` : '')
    const output = raw.split(copy).join(tree).split('/work/').join(tree + '/')
    return { ok: r.status === 0, output, kind }
  } finally {
    rmSync(copy, { recursive: true, force: true })
  }
}
