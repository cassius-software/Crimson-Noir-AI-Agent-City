#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It is the self-healing agent of the pipeline (.github/workflows/selfheal.yml spawns it
 * when ci.yml or build-release.yml fails), the loop in one place:
 *   1. Isolate: run the checks that failed, in the sandbox (sandbox.mjs), and read their output into failures
 *      (failures.mjs). A failure that does not reproduce ends the run with a report, not a patch.
 *   2. Map: each failure's file and line to its locus in the syntax tree (ast.mjs): the declaration the patch may
 *      replace, whole.
 *   3. Formulate: a planner (planner.mjs) proposes structural edits or a regeneration command, with its reasoning.
 *   4. Verify: the patch is applied to a copy, the failed checks are run first, then every check, in a fresh
 *      container. A failure feeds the next attempt.
 *   5. Dampen: at most `--max-attempts` (3) attempts; and if an attempt leaves the same failures as the one before
 *      (the same tests, the same messages: failures.signature), the loop stops early, because another round with
 *      the same information would spend tokens on the same answer. The planner has a call budget of its own.
 *   6. Deliver: when every check passes, the patch goes to a `selfheal-<run>-<sha7>` branch with a documented pull
 *      request (`--push`): the failure, the loci, every attempt, the diff and the sandbox's own results. The agent
 *      never merges; a person does, after reading it. Without `--push` the patch and the report are written to
 *      `--out` and nothing leaves the machine.
 * Options: --checks a,b (the failed checks; `all` to isolate by running everything), --planner claude|builtin|none,
 * --max-attempts N, --out DIR, --push, --run-id ID, --tree DIR, --sandbox docker|host, --dry-run (no planner call).
 * What breaks if it is removed? A red pipeline stays red until a person looks.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { lineOf, locusOf, replaceLocus } from './ast.mjs'
import { parse, signature } from './failures.mjs'
import { plannerFor } from './planner.mjs'
import { copyTree, runChecks, sandboxKind } from './sandbox.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const MAX_ATTEMPTS = 3

export function parseArgs(argv) {
  const o = { checks: ['all'], planner: 'claude', maxAttempts: MAX_ATTEMPTS, out: null, push: false, runId: String(Date.now()), tree: resolve(HERE, '../..'), sandbox: null, dryRun: false, base: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], v = argv[i + 1]
    if (a === '--checks') { o.checks = v.split(',').filter(Boolean); i++ }
    else if (a === '--planner') { o.planner = v; i++ }
    else if (a === '--max-attempts') { o.maxAttempts = Math.max(1, Math.min(MAX_ATTEMPTS, Number(v))); i++ }
    else if (a === '--out') { o.out = v; i++ }
    else if (a === '--push') o.push = true
    else if (a === '--run-id') { o.runId = v.replace(/[^A-Za-z0-9._-]/g, ''); i++ }
    else if (a === '--tree') { o.tree = resolve(v); i++ }
    else if (a === '--sandbox') { o.sandbox = v; i++ }
    else if (a === '--base') { o.base = v; i++ }
    else if (a === '--dry-run') o.dryRun = true
    else throw new Error(`unknown option ${a}`)
  }
  return o
}

/** Splits a checks.sh run's output by check and parses each failed check's section. */
export function failuresOf(output, tree) {
  const out = []
  const re = /::group::check (\S+)\n([\s\S]*?)::endgroup::\ncheck \1: (ok|FAILED)/g
  let m
  while ((m = re.exec(output)) !== null) {
    if (m[3] === 'FAILED') out.push(...parse(m[1], m[2], tree))
  }
  if (out.length === 0 && /check \S+: FAILED|sandbox: /.test(output)) {
    const tail = output.split('\n').filter((l) => l.trim()).slice(-30).join('\n')
    out.push({ check: 'sandbox', test: 'run', message: tail, file: null, line: null })
  }
  return out
}

/** The loci the failures point at, read from `tree`, de-duplicated. */
export function lociOf(failures, tree) {
  const seen = new Map()
  for (const f of failures) {
    if (!f.file || !f.line) continue
    const path = join(tree, f.file)
    if (!existsSync(path)) continue
    const text = readFileSync(path, 'utf8')
    const l = locusOf(f.file, f.line, text)
    if (!l) continue
    const key = `${f.file}:${l.start}`
    if (!seen.has(key)) seen.set(key, { file: f.file, kind: l.kind, name: l.name, line: lineOf(text, l.start), endLine: lineOf(text, Math.max(l.start, l.end - 1)), text: l.text })
  }
  return [...seen.values()]
}

/** Applies a plan to `tree` in place: structural edits, or commands. Returns { ok, reason?, changed: [files] }. */
export function applyPlan(p, tree, loci, log = () => {}) {
  const changed = new Set()
  if (p.kind === 'edits') {
    const shown = new Set(loci.map((l) => `${l.file}:${l.name}`))
    for (const e of p.edits) {
      if (!shown.has(`${e.file}:${e.name}`)) return { ok: false, reason: `the plan edits ${e.file}:${e.name}, which was not among the loci shown` }
      const path = join(tree, e.file)
      const text = readFileSync(path, 'utf8')
      const r = replaceLocus(e.file, text, e.name, e.replacement, e.kind ?? null)
      if (!r.ok) return { ok: false, reason: r.reason }
      writeFileSync(path, r.text)
      changed.add(e.file)
      log(`applied: ${e.file} ${r.locus.kind} ${e.name}`)
    }
  } else if (p.kind === 'commands') {
    for (const c of p.commands) {
      const r = spawnSync(c.argv[0], c.argv.slice(1), { cwd: join(tree, c.cwd ?? '.'), encoding: 'utf8', timeout: 20 * 60 * 1000 })
      if (r.status !== 0) return { ok: false, reason: `${c.argv.join(' ')} failed:\n${(r.stdout ?? '') + (r.stderr ?? '')}`.slice(0, 4000) }
      log(`ran: ${c.argv.join(' ')}`)
    }
    const st = spawnSync('git', ['status', '--porcelain'], { cwd: tree, encoding: 'utf8' })
    for (const l of (st.stdout ?? '').split('\n')) if (l.trim()) changed.add(l.slice(3).trim())
  } else {
    return { ok: false, reason: p.rationale || 'no patch' }
  }
  return { ok: true, changed: [...changed] }
}

/** The diff of a copy against its tree's HEAD (the copy has no .git: compared file by file). */
export function diffOf(copy, tree, files) {
  let out = ''
  for (const f of files) {
    const r = spawnSync('git', ['diff', '--no-index', '--', join(tree, f), join(copy, f)], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    out += (r.stdout ?? '').replace(new RegExp(tree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'a').replace(new RegExp(copy.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), 'b')
  }
  return out
}

/** The pull request body: everything a reviewer needs to judge the patch without re-running it. */
export function report(state) {
  const { runId, checks, failures, loci, attempts, result, sandbox, planner } = state
  const lines = []
  lines.push(`# Self-healing run ${runId}`)
  lines.push('')
  lines.push(`**Before:** the checks \`${checks.join(', ')}\` failed on the commit this branch starts from. The agent isolated ${failures.length} failure(s) in a sandbox (${sandbox}), mapped them to ${loci.length} declaration(s) in the syntax tree, and asked the planner (${planner}) for a structural patch.`)
  lines.push('')
  lines.push(result.ok
    ? `**After:** attempt ${result.attempt} of at most ${state.maxAttempts} makes every check pass in a fresh container (\`sh tools/selfheal/checks.sh all\`). This pull request carries that patch and nothing else. It is not merged by anyone but a person: read the rationale and the diff, and run the checks again where you can.`
    : `**After:** no patch passed. ${result.reason} Nothing was pushed; this report is the whole result.`)
  lines.push('')
  lines.push('The agent may only replace a whole declaration it was shown or regenerate a committed file with the repository\'s own tool; it cannot delete or loosen a test, a proof or a lint rule, and it never merges.')
  lines.push('')
  lines.push('## The failures')
  for (const f of failures) lines.push(`- \`${f.check}\` ${f.test}${f.file ? ` (${f.file}:${f.line})` : ''}\n  \`\`\`\n  ${f.message.split('\n').slice(0, 12).join('\n  ')}\n  \`\`\``)
  lines.push('')
  lines.push('## The syntax-tree map')
  if (loci.length === 0) lines.push('No failure pointed at a declaration the agent could map.')
  for (const l of loci) lines.push(`- ${l.file}: ${l.kind} \`${l.name}\` (lines ${l.line}-${l.endLine})`)
  lines.push('')
  lines.push('## Attempts')
  for (const a of attempts) {
    lines.push(`### Attempt ${a.n}: ${a.ok ? 'passed' : 'failed'}`)
    lines.push(`Plan (${a.plan.kind}${a.plan.confidence ? `, confidence ${a.plan.confidence}` : ''}): ${a.plan.rationale || '(none)'}`)
    if (a.plan.edits.length) lines.push(`Edited: ${a.plan.edits.map((e) => `\`${e.file}\` ${e.name}`).join(', ')}`)
    if (a.plan.commands.length) lines.push(`Ran: ${a.plan.commands.map((c) => `\`${c.argv.join(' ')}\``).join(', ')}`)
    if (a.applyReason) lines.push(`Not applied: ${a.applyReason}`)
    if (a.summary) lines.push(`\n\`\`\`\n${a.summary.split('\n').slice(0, 30).join('\n')}\n\`\`\``)
    lines.push('')
  }
  if (result.ok && state.diff) {
    lines.push('## The patch')
    lines.push('```diff')
    lines.push(state.diff.length > 60000 ? state.diff.slice(0, 60000) + '\n… (cut; the branch carries the whole patch)' : state.diff)
    lines.push('```')
  }
  return lines.join('\n')
}

/** The loop. `deps` injects the sandbox runner and the planner for tests. Returns the state (see report). */
export async function heal(options, deps = {}) {
  const log = deps.log ?? ((s) => console.log(s))
  const run = deps.runChecks ?? runChecks
  const kind = options.sandbox ?? sandboxKind()
  const planner = deps.planner ?? plannerFor(options.planner, { log })
  const state = { runId: options.runId, checks: options.checks, maxAttempts: options.maxAttempts, failures: [], loci: [], attempts: [], result: { ok: false, reason: '' }, sandbox: kind, planner: planner.name, diff: '', changed: [] }

  log(`selfheal ${options.runId}: isolating ${options.checks.join(', ')} in the ${kind} sandbox`)
  const first = run(options.tree, options.checks, { kind, log })
  if (first.ok) {
    state.result = { ok: false, reason: 'The failure did not reproduce in the sandbox: every check passed on the unchanged tree.' }
    return state
  }
  state.failures = failuresOf(first.output, options.tree)
  state.loci = lociOf(state.failures, options.tree)
  log(`selfheal: ${state.failures.length} failure(s), ${state.loci.length} locus/loci`)
  const failedChecks = [...new Set(state.failures.map((f) => f.check).filter((c) => c !== 'sandbox'))]
  let previous = signature(state.failures)

  for (let n = 1; n <= options.maxAttempts; n++) {
    const ctx = { failures: state.failures, loci: state.loci, attempts: state.attempts }
    const p = options.dryRun ? { kind: 'none', edits: [], commands: [], rationale: 'dry run', confidence: 0 } : await planner.propose(ctx)
    const attempt = { n, plan: p, ok: false, summary: '', applyReason: null }
    state.attempts.push(attempt)
    if (p.kind === 'none') {
      attempt.summary = p.rationale
      state.result = { ok: false, reason: `The planner proposed no patch at attempt ${n}: ${p.rationale}` }
      log(`attempt ${n}: no patch (${p.rationale})`)
      return state
    }
    const copy = copyTree(options.tree)
    try {
      const applied = applyPlan(p, copy, state.loci, log)
      if (!applied.ok) {
        attempt.applyReason = applied.reason
        attempt.summary = applied.reason
        log(`attempt ${n}: not applied: ${applied.reason}`)
        if (n > 1 && state.attempts[n - 2].applyReason === applied.reason) {
          state.result = { ok: false, reason: `Attempts ${n - 1} and ${n} proposed patches that could not be applied for the same reason (${applied.reason}); the loop stops here.` }
          return state
        }
        continue
      }
      const quick = failedChecks.length ? run(copy, failedChecks, { kind, log }) : { ok: true, output: '' }
      const full = quick.ok ? run(copy, ['all'], { kind, log }) : quick
      attempt.ok = full.ok
      if (full.ok) {
        state.diff = diffOf(copy, options.tree, applied.changed)
        state.changed = applied.changed
        state.patched = copy
        attempt.summary = 'every check passed'
        state.result = { ok: true, attempt: n }
        log(`attempt ${n}: every check passed`)
        return state
      }
      const failures = failuresOf(full.output, copy)
      const sig = signature(failures)
      attempt.summary = failures.map((f) => `${f.check} ${f.test}: ${f.message.split('\n').filter((l) => l.trim()).slice(0, 4).join(' | ')}`).join('\n') || full.output.split('\n').slice(-20).join('\n')
      log(`attempt ${n}: failed (${failures.length} failure(s))`)
      if (sig === previous) {
        state.result = { ok: false, reason: `Attempt ${n} left exactly the failures attempt ${n - 1 || 'zero (the unpatched tree)'} had; the loop stops here rather than ask the planner the same question again.` }
        return state
      }
      previous = sig
      if (failures.length) {
        state.failures = failures
        const loci = lociOf(failures, copy)
        if (loci.length) state.loci = loci
      }
    } finally {
      if (state.patched !== copy) spawnSync('rm', ['-rf', copy])
    }
  }
  state.result = { ok: false, reason: `${options.maxAttempts} attempts did not resolve the failure; the loop stops to prevent token drain.` }
  return state
}

/** Pushes the patch as a selfheal-* branch and opens the pull request with `gh`. Never merges. */
export function deliver(state, options, log = console.log) {
  const sha = execFileSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: options.tree, encoding: 'utf8' }).trim()
  const branch = `selfheal-${options.runId}-${sha}`
  const base = options.base ?? execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: options.tree, encoding: 'utf8' }).trim()
  for (const f of state.changed) {
    mkdirSync(join(options.tree, f, '..'), { recursive: true })
    writeFileSync(join(options.tree, f), readFileSync(join(state.patched, f)))
  }
  const git = (...a) => execFileSync('git', a, { cwd: options.tree, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] })
  git('checkout', '-b', branch)
  git('add', '--', ...state.changed)
  git('-c', 'user.name=selfheal agent', '-c', 'user.email=selfheal@users.noreply.github.com', 'commit', '-m', `selfheal: ${state.attempts.at(-1).plan.rationale.split('\n')[0].slice(0, 72)}\n\nSelf-healing run ${options.runId}, attempt ${state.result.attempt}: the checks ${options.checks.join(', ')} failed; this patch makes every check pass in a fresh container. See the pull request for the failures, the syntax-tree map and every attempt.`)
  git('push', '-u', 'origin', branch)
  log(`pushed ${branch}`)
  const body = report(state)
  const r = spawnSync('gh', ['pr', 'create', '--base', base, '--head', branch, '--title', `selfheal: ${state.attempts.at(-1).plan.rationale.split('\n')[0].slice(0, 60)}`, '--body-file', '-'], { cwd: options.tree, input: body, encoding: 'utf8' })
  if (r.status !== 0) {
    log(`the pull request was not created (${(r.stderr ?? '').trim()}); the branch ${branch} is pushed. If the error names permissions: the repository setting "Allow GitHub Actions to create and approve pull requests" must be on.`)
    return { branch, pr: null }
  }
  log(`opened ${r.stdout.trim()}`)
  return { branch, pr: r.stdout.trim() }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const state = await heal(options)
  const body = report(state)
  if (options.out) {
    mkdirSync(options.out, { recursive: true })
    writeFileSync(join(options.out, 'report.md'), body)
    if (state.diff) writeFileSync(join(options.out, 'selfheal.patch'), state.diff)
    console.log(`report: ${join(options.out, 'report.md')}`)
  }
  if (state.result.ok && options.push) deliver(state, options)
  else if (state.result.ok) console.log('a patch passed every check; run with --push to open the pull request')
  else console.log(`no patch: ${state.result.reason}`)
  if (state.patched) spawnSync('rm', ['-rf', state.patched])
  process.exit(state.result.ok ? 0 : 3)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2) })
}
