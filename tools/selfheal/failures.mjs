/**
 * Why does this file exist? It is the first step of the self-healing loop (tools/selfheal/agent.mjs): reading a
 * failed check's output into failures a patch can be aimed at. Each checker prints failures its own way; this file
 * knows the four the pipeline runs and turns each into the same record: which check, which test or diagnostic, the
 * message, and the source file and line it points at (the test's own location for a node test, the panic site for
 * a cargo test, the diagnostic's position for tsc, oxlint and a Kani harness). Pure: text in, records out; no I/O.
 * The signature of a set of failures (`signature`) is what the loop breaker compares between attempts: the same
 * failing tests with the same messages mean a patch changed nothing that mattered.
 * What breaks if it is removed? The agent has nothing to map to the syntax tree and nothing to tell apart.
 */

/** One failure a check reported. `file` is repository-relative when it could be made so. */
export function failure(check, test, message, file = null, line = null) {
  return { check, test, message: message.trim(), file, line }
}

/** A path as the repository knows it: absolute paths and file:// URLs under `root` are made relative. */
export function relative(path, root) {
  let p = path.startsWith('file://') ? decodeURI(path.slice('file://'.length)) : path
  if (root && p.startsWith(root + '/')) p = p.slice(root.length + 1)
  return p
}

/** `node --test` TAP output: every `not ok` subtest with its location, error and the first stack frame in the tree. */
export function parseNodeTest(text, root = '') {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*not ok \d+ - (.*)$/.exec(lines[i])
    if (!m) continue
    const name = m[1].replace(/ # .*$/, '')
    let location = null, error = [], inError = false, stackFile = null, stackLine = null
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (/^\s*\.\.\.\s*$/.test(l)) break
      const loc = /^\s*location: '(.*):(\d+):\d+'$/.exec(l)
      if (loc) location = [loc[1], Number(loc[2])]
      if (/^\s*error: \|-?$/.test(l)) { inError = true; continue }
      if (inError) {
        if (/^\s{4}\S/.test(l) || l.trim() === '') { error.push(l.trim()); continue }
        inError = false
      }
      const frame = /^\s+(?:[^\s(]+ )?\(?((?:file:\/\/)?\/[^):]+\.(?:ts|tsx|mjs|js)):(\d+):\d+\)?$/.exec(l)
      if (frame && stackFile === null) { stackFile = frame[1]; stackLine = Number(frame[2]) }
    }
    const [file, line] = stackFile ? [stackFile, stackLine] : location ?? [null, null]
    out.push(failure('page-test', name, error.join('\n').trim() || 'failed', file ? relative(file, root) : null, line))
  }
  return out
}

/** `cargo test` output: each `---- name stdout ----` block with its panic site. */
export function parseCargoTest(text, crateDir = '') {
  const out = []
  const re = /^---- (\S+) stdout ----\n([\s\S]*?)(?=^---- \S+ stdout ----\n|^failures:\n|^test result:)/gm
  let m
  while ((m = re.exec(text)) !== null) {
    const body = m[2]
    const at = /panicked at ([^:\n]+):(\d+):\d+:\n?([^\n]*)/.exec(body)
    const file = at ? (crateDir ? `${crateDir}/${at[1]}` : at[1]) : null
    out.push(failure('rust-test', m[1], at ? (at[3] + '\n' + body.split('\n').slice(0, 8).join('\n')) : body.slice(0, 400), file, at ? Number(at[2]) : null))
  }
  return out
}

/** `tsc` diagnostics: `file(line,col): error TSnnnn: message`. */
export function parseTsc(text) {
  const out = []
  for (const m of text.matchAll(/^(\S+?)\((\d+),\d+\): error (TS\d+): (.*)$/gm)) {
    out.push(failure('page-tsc', m[3], m[4], m[1], Number(m[2])))
  }
  return out
}

/** `oxlint` diagnostics: a `rule` line, then `,-[file:line:col]`. */
export function parseOxlint(text) {
  const out = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const head = /^\s*[×!⚠]\s+(?:(\S+)\s*:\s*)?(.*)$/.exec(lines[i]) || /^\s*(?:error|warning)(?:\[(\S+)\])?:\s*(.*)$/.exec(lines[i])
    if (!head) continue
    for (let j = i + 1; j < Math.min(i + 6, lines.length); j++) {
      const loc = /\[([^\]:]+):(\d+):\d+\]/.exec(lines[j])
      if (loc) { out.push(failure('page-lint', head[1] ?? 'lint', head[2], loc[1], Number(loc[2]))); break }
    }
  }
  return out
}

/** `cargo kani` output: a failed harness, with the `Failed Checks` lines and their files. */
export function parseKani(text, crateDir = '') {
  const out = []
  for (const m of text.matchAll(/^Failed Checks: (.*)\n(?:\s*File: "([^"]+)", line (\d+), in (\S+))?/gm)) {
    out.push(failure('fvps-kani', m[4] ?? 'harness', m[1], m[2] ? (crateDir ? `${crateDir}/${m[2]}` : m[2]) : null, m[3] ? Number(m[3]) : null))
  }
  for (const m of text.matchAll(/^Verification failed for - (\S+)$/gm)) {
    if (!out.some((f) => f.message.includes(m[1]) || f.test === m[1])) out.push(failure('fvps-kani', m[1], 'verification failed', null, null))
  }
  return out
}

/** The parser for a check's name (tools/selfheal/checks.sh). Unknown checks get one failure carrying the tail of the output. */
export function parse(check, text, root = '') {
  switch (check) {
    case 'page-test': return parseNodeTest(text, root)
    case 'rust-test': return parseCargoTest(text, 'crimson_noir_os')
    case 'native-test': return parseCargoTest(text, 'native')
    case 'page-tsc': return parseTsc(text)
    case 'page-lint': return parseOxlint(text)
    case 'fvps-kani': return parseKani(text)
    default: return [failure(check, check, text.split('\n').filter((l) => l.trim()).slice(-20).join('\n'))]
  }
}

/**
 * What the loop breaker compares: the sorted failing tests and their whole messages, whitespace folded, with the
 * volatile parts (durations, addresses, temp paths) blanked. Stable across runs of the same failure.
 */
export function signature(failures) {
  const fold = (m) => m.replace(/\d+(?:\.\d+)?\s*m?s\b/g, '#').replace(/0x[0-9a-f]+/gi, '#').replace(/\/tmp\/\S+/g, '#').replace(/\s+/g, ' ').trim()
  return failures.map((f) => `${f.check}|${f.test}|${fold(f.message)}`).sort().join('\n')
}
