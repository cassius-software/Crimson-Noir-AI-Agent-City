/**
 * Why does this file exist? It is the part of the self-healing loop that formulates a patch. The agent
 * (agent.mjs) hands it the failures, the loci they map to (ast.mjs) and what the earlier attempts tried; it answers
 * with a plan: structural edits (a named declaration replaced whole) or commands (a generated file regenerated
 * with the repository's own tool), with the reasoning written down for the pull request. Two planners:
 * - `builtin`: the remedies that need no model, for failures whose fix is a regeneration the repository already
 *   scripts (a committed WebAssembly module behind its crate: `npm run native:wasm`; the pinned seal behind the
 *   scripted run: `cargo run -- seal`). Deterministic, offline.
 * - `claude`: the Claude API (the official SDK, `claude-opus-5-5`, adaptive thinking, a JSON schema the answer
 *   must fit), given the failures, each locus's source and the attempts so far, asked for the smallest structural
 *   patch. It may only edit loci it was shown (plus a test's own locus) and may answer "no patch" with a reason.
 *   Token drain is bounded here as well as in the loop: one call per attempt, at most `maxCalls` calls per run.
 * `plannerFor(name)` picks one; a fake planner is injected by the tests.
 * What breaks if it is removed? The loop can isolate and map a failure but never propose a fix.
 */

/** The shape every plan has. `edits`: [{file, name, kind?, replacement}]; `commands`: [{cwd?, argv}]. */
export function plan(kind, { edits = [], commands = [], rationale = '', confidence = 0 } = {}) {
  return { kind, edits, commands, rationale, confidence }
}

export const NO_PATCH = plan('none', { rationale: 'no planner could propose a patch' })

/** The built-in remedies, by what the failure says. */
export function builtinPlanner() {
  return {
    name: 'builtin',
    calls: 0,
    async propose({ failures }) {
      const text = failures.map((f) => `${f.test}\n${f.message}`).join('\n')
      if (/routing core: layout entry|_SHA256|module in the tree|routing\.wasm|kvPager\.wasm|stale|native:wasm/.test(text)) {
        return plan('commands', { commands: [{ argv: ['npm', 'run', 'native:wasm'] }], rationale: 'A committed WebAssembly module no longer matches its crate: rebuilt with the repository\'s own tool (npm run native:wasm).', confidence: 0.6 })
      }
      if (/containment\.seal|seal is not pinned|the seal/.test(text)) {
        return plan('commands', { commands: [{ cwd: 'crimson_noir_os', argv: ['cargo', 'run', '--quiet', '--', 'seal'] }], rationale: 'The pinned seal no longer matches the configuration\'s scripted run: re-pinned with cargo run -- seal.', confidence: 0.5 })
      }
      return NO_PATCH
    },
  }
}

const SYSTEM = `You repair a failing check in a software repository by formulating one small, structural patch.
You are given the failures a check reported, the source of the declaration each failure points at (its "locus":
a whole function, method, class, test, constant or Rust item), and what earlier attempts changed and how they
failed. Answer with a plan that fits the JSON schema you were given.

Rules:
- Edit only loci you were shown, by file and declaration name, replacing the whole declaration with new text that
  keeps its name and signature unless the failure is in the signature itself. Keep the repository's conventions
  (its comment style, no new dependencies, no new files).
- Never weaken a check: do not delete, skip or loosen a test, an assertion, a proof harness or a lint rule to make
  it pass. If the test is wrong and the code is right, say so in the rationale and fix the test's own locus only
  when its expectation is plainly mistaken.
- Prefer the smallest change that addresses the cause the failure names. If you cannot see a sound patch, answer
  kind "none" with the reason; that is a good answer.
- confidence is your honest estimate (0 to 1) that the patch makes every check pass.`

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'edits', 'rationale', 'confidence'],
  properties: {
    kind: { type: 'string', enum: ['edits', 'none'] },
    edits: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['file', 'name', 'replacement'],
        properties: {
          file: { type: 'string', description: 'repository-relative path of a file a locus was shown from' },
          name: { type: 'string', description: 'the declaration name of the locus to replace' },
          kind: { type: 'string', description: 'the locus kind, when the name is ambiguous' },
          replacement: { type: 'string', description: 'the whole new text of the declaration' },
        },
      },
    },
    rationale: { type: 'string', description: 'what the cause is and why this patch addresses it; written into the pull request' },
    confidence: { type: 'number' },
  },
}

/** The prompt for one attempt: failures, loci, history. Bounded in size (each locus and message is cut). */
export function describe({ failures, loci, attempts }, limit = 6000) {
  const cut = (s, n = limit) => (s.length > n ? s.slice(0, n) + `\n… (${s.length - n} more characters)` : s)
  const parts = []
  parts.push('# Failures')
  for (const f of failures) parts.push(`- check ${f.check}, ${f.test}${f.file ? ` at ${f.file}:${f.line}` : ''}\n${cut(f.message, 1500)}`)
  parts.push('\n# Loci (the declarations the failures point at; edit these by file and name)')
  for (const l of loci) parts.push(`## ${l.file} — ${l.kind} ${l.name} (lines ${l.line}-${l.endLine})\n\`\`\`\n${cut(l.text)}\n\`\`\``)
  if (attempts.length) {
    parts.push('\n# Earlier attempts in this run')
    for (const a of attempts) parts.push(`## Attempt ${a.n}: ${a.plan.kind} — ${a.plan.rationale}\nEdited: ${a.plan.edits.map((e) => `${e.file}:${e.name}`).join(', ') || a.plan.commands.map((c) => c.argv.join(' ')).join('; ')}\nResult: ${a.ok ? 'passed' : 'failed'}\n${cut(a.summary, 2000)}`)
  }
  return parts.join('\n')
}

/** The Claude planner. `maxCalls` bounds the run; `client` is injectable for tests. */
export function claudePlanner({ model = 'claude-opus-5-5', maxCalls = 3, client = null, log = console.log } = {}) {
  return {
    name: `claude (${model})`,
    calls: 0,
    async propose(ctx) {
      if (this.calls >= maxCalls) return plan('none', { rationale: `the planner's budget of ${maxCalls} calls is spent` })
      this.calls++
      const c = client ?? (await (async () => {
        const { default: Anthropic } = await import('@anthropic-ai/sdk')
        return new Anthropic()
      })())
      log(`planner: asking ${model} (call ${this.calls} of ${maxCalls})`)
      const stream = c.beta.messages.stream({
        model,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high', format: { type: 'json_schema', schema: SCHEMA } },
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: describe(ctx) }],
      })
      const message = await stream.finalMessage()
      if (message.stop_reason === 'refusal') return plan('none', { rationale: `the model declined: ${message.stop_details?.explanation ?? 'no explanation'}` })
      if (message.stop_reason === 'max_tokens') return plan('none', { rationale: 'the model\'s answer was cut at max_tokens' })
      const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('')
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        return plan('none', { rationale: 'the model\'s answer was not the JSON it was asked for' })
      }
      if (parsed.kind !== 'edits' || !Array.isArray(parsed.edits) || parsed.edits.length === 0) return plan('none', { rationale: parsed.rationale ?? 'no patch', confidence: 0 })
      return plan('edits', { edits: parsed.edits, rationale: parsed.rationale, confidence: Number(parsed.confidence) || 0 })
    },
  }
}

/** A planner that proposes nothing (`--planner none`): the loop then only isolates and reports. */
export function nonePlanner() {
  return { name: 'none', calls: 0, async propose() { return NO_PATCH } }
}

/** Chains planners: the first non-empty plan wins. */
export function chain(...planners) {
  return {
    name: planners.map((p) => p.name).join(' then '),
    get calls() { return planners.reduce((n, p) => n + p.calls, 0) },
    async propose(ctx) {
      for (const p of planners) {
        const r = await p.propose(ctx)
        if (r.kind !== 'none') return r
      }
      return NO_PATCH
    },
  }
}

export function plannerFor(name, options = {}) {
  switch (name) {
    case 'builtin': return builtinPlanner()
    case 'claude': return chain(builtinPlanner(), claudePlanner(options))
    case 'none': return nonePlanner()
    default: throw new Error(`no planner named ${name}`)
  }
}
