// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the empirical verification of the sandbox's containment, one command:
 * `node tools/sandbox/verify.mjs [--no-build] [--checks NAME,...] [--out DIR]`, run by ci.yml's sandbox job on
 * every pull request. Three experiments, in order, each a `docker run` of the sandbox image:
 * 1. the probes, contained: tools/sandbox/probe.sh runs through tools/selfheal/sandbox.mjs with exactly the
 *    arguments the self-healing agent uses (dockerArgs); every escape attempt must be denied;
 * 2. the probes, uncontained (the control): the same image and the same probes, started with the containment
 *    taken away (root, the host's network and pid namespace, a writable workspace, a credential file and a
 *    token-shaped variable handed in). The probes that the containment is there to deny must now report an
 *    escape; a probe that stays "denied" in the control would be one that cannot tell, and the experiment fails;
 * 3. the checks, contained: the named checks (`--checks`, by default a page build and the native crates' tests)
 *    run in the sandbox and must pass, so the containment is one the checks can live in (a sandbox nothing runs
 *    in proves nothing).
 * The evidence is written to DIR/report.json: the policy (CONTAINMENT), every probe's line from both runs, the
 * checks' status, and a verdict; ci.yml keeps it as an artifact. Exit 0 only when all three hold.
 * What breaks if it is removed? The containment flags are asserted by a unit test and never exercised.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { CONTAINMENT, ENTRY, IMAGE, buildImage, runChecks, tarTree } from '../selfheal/sandbox.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const TREE = resolve(HERE, '../..')

/** The probes the control must flip to "escaped": the ones whose denial is the containment's doing. */
export const MUST_FLIP = ['net.interfaces', 'net.route', 'net.tcp', 'priv.uid', 'priv.caps', 'priv.pidns', 'exec.work.elf', 'exec.work.script', 'exec.setuid', 'mount.work.flags', 'mount.root', 'mount.binds', 'cred.env', 'cred.files']

/** The probe lines of an output: the JSON objects, one per line, in order; the summary last. */
export function parseProbes(output) {
  const lines = []
  for (const line of output.split('\n')) {
    if (!line.startsWith('{')) continue
    try { lines.push(JSON.parse(line)) } catch { /* a line of a check's own output that happens to start with a brace */ }
  }
  return { probes: lines.filter((l) => l.probe), summary: lines.find((l) => l.summary) ?? null }
}

/** The control's `docker run` arguments: the same image, entry and probe, the containment taken away. */
export function controlArgs(fakeCredentialDir) {
  return [
    'run', '--rm', '-i',
    '--user', 'root', '--pid', 'host',
    '-v', `${fakeCredentialDir}:/root/.ssh:ro`,
    '-e', 'GITHUB_TOKEN=control-not-a-secret',
    '-e', 'HOME=/root',
    '-w', '/work',
    IMAGE, 'sh', '-c', ENTRY, 'checks', 'sandbox-probe',
  ]
}

function parseArgs(argv) {
  const o = { build: true, checks: ['page-build', 'native-test'], out: join(tmpdir(), 'crimson-noir-sandbox') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-build') o.build = false
    else if (a === '--checks') o.checks = argv[++i].split(',').filter(Boolean)
    else if (a === '--out') o.out = argv[++i]
    else throw new Error(`verify.mjs: unknown argument ${a}`)
  }
  return o
}

export function verify(options, log = console.log) {
  const report = { image: IMAGE, policy: CONTAINMENT, contained: null, control: null, checks: null, verdict: 'failed', problems: [] }
  const problem = (s) => { report.problems.push(s); log(`::error::${s}`) }

  // 1. The probes, contained.
  log('sandbox verify 1/3: the escape probes, contained')
  const contained = runChecks(TREE, ['sandbox-probe'], { kind: 'docker', timeoutMs: 10 * 60 * 1000, log })
  const c = parseProbes(contained.output)
  report.contained = { ok: contained.ok, ...c }
  if (!c.summary) problem(`the contained probe run produced no summary:\n${contained.output.slice(-2000)}`)
  for (const p of c.probes) if (p.observed !== 'denied') problem(`contained: ${p.probe} ${p.observed}: ${p.detail}`)
  if (c.summary && c.summary.total < 30) problem(`contained: only ${c.summary.total} probes ran`)
  for (const p of c.probes) log(`  ${p.observed === 'denied' ? 'denied ' : 'ESCAPED'} ${p.probe}: ${p.detail}`)

  // 2. The probes, uncontained.
  log('sandbox verify 2/3: the same probes in the weakened control')
  const fake = mkdtempSync(join(tmpdir(), 'sandbox-control-'))
  try {
    writeFileSync(join(fake, 'id_ed25519'), '-----BEGIN OPENSSH PRIVATE KEY-----\ncontrol: not a key\n-----END OPENSSH PRIVATE KEY-----\n')
    const r = spawnSync('docker', controlArgs(fake), { input: tarTree(TREE), encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, timeout: 10 * 60 * 1000 })
    const output = (r.stdout ?? '') + (r.stderr ?? '') + (r.error ? `\ncontrol: ${r.error.message}` : '')
    const k = parseProbes(output)
    report.control = { status: r.status, ...k }
    if (!k.summary) problem(`the control run produced no summary:\n${output.slice(-2000)}`)
    const observed = new Map(k.probes.map((p) => [p.probe, p]))
    for (const name of MUST_FLIP) {
      const p = observed.get(name)
      if (!p) problem(`control: ${name} did not run`)
      else if (p.observed !== 'escaped') problem(`control: ${name} stayed "${p.observed}" with the containment removed: the probe cannot tell (${p.detail})`)
    }
    for (const p of k.probes) log(`  ${p.observed === 'denied' ? 'denied ' : 'escaped'} ${p.probe}: ${p.detail}`)
  } finally {
    rmSync(fake, { recursive: true, force: true })
  }

  // 3. The checks, contained.
  if (options.checks.length) {
    log(`sandbox verify 3/3: the checks ${options.checks.join(', ')}, contained`)
    const r = runChecks(TREE, options.checks, { kind: 'docker', log })
    report.checks = { names: options.checks, ok: r.ok, tail: r.output.slice(-4000) }
    if (!r.ok) problem(`the checks ${options.checks.join(', ')} failed in the sandbox:\n${r.output.slice(-4000)}`)
    else log(`  ${options.checks.join(', ')}: ok`)
  } else {
    report.checks = { names: [], ok: true, tail: '' }
  }

  report.verdict = report.problems.length === 0 ? 'contained' : 'failed'
  mkdirSync(options.out, { recursive: true })
  writeFileSync(join(options.out, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  log(`sandbox verify: ${report.verdict} (${report.contained?.summary?.denied ?? 0}/${report.contained?.summary?.total ?? 0} probes denied contained, ${report.control?.summary?.escaped ?? 0} escaped in the control); report at ${join(options.out, 'report.json')}`)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  if (options.build) buildImage(TREE)
  const report = verify(options)
  process.exit(report.verdict === 'contained' ? 0 : 1)
}
