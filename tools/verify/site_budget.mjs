#!/usr/bin/env node
// Copyright (c) 2026 Julian Cassius Subban
// SPDX-License-Identifier: MIT
// Auxiliary tooling of Crimson Noir OS / Agent City, open source under the MIT License (LICENSES/MIT.txt).
/**
 * Why does this file exist? It refuses what GitHub would not publish, before it is uploaded. Two commands, each
 * printing one plain line per check with the size and the limit, and exiting 1 with every file or folder that fails
 * named (2 for a command line it does not take):
 *   site <dir>
 *     The web copy (dist-web/, which carries the site's model beside the page) as GitHub Pages publishes it: every
 *     file in the folder, at any depth, summed, is at most SITE_BUDGET, 950,000,000 bytes, a margin under the 1 GB
 *     GitHub Pages publishes at most for a site. When it is over, the largest files are named. web.yml runs it after
 *     the model is placed, before the upload.
 *   assets <file or folder>...
 *     Each file (a folder: every file in it, at any depth) is under ASSET_LIMIT, 2 GiB (2,147,483,648 bytes): GitHub
 *     refuses a release asset of 2 GiB or more. build-matrix.yml runs it on each target's out/<target>/ before the
 *     upload, windows-app.yml on its three folders, build-release.yml on the media it bakes, and current.yml on the
 *     artifacts it downloads, before tools/build/current.mjs puts them on the release. tools/build/macAudit.mjs takes
 *     ASSET_LIMIT from here, so the number has one source.
 * A size is what fs.stat says the file holds: the bytes an upload sends (a sparse file at its full length). A symbolic
 * link is followed, and what it names counts at its own size, as an upload that follows links sends it (and the safe
 * side for one that does not); a link to nothing, or a link back to a folder that holds it, fails the run by name,
 * since it cannot be measured. A folder itself counts nothing, and anything that is neither a file nor a folder fails.
 * The limits are constants. The functions take others only as arguments, for the tests; the command line takes no flag
 * and reads no environment variable, so no workflow can move a limit or skip a check.
 * What breaks if it is removed? A web copy too big for GitHub Pages, or a release file too big for GitHub, is found
 * only when GitHub refuses the upload, after every build has run.
 */
import { lstatSync, readdirSync, readlinkSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The web copy's budget: 950 MB (950,000,000 bytes), under the 1 GB GitHub Pages publishes at most for a site. */
export const SITE_BUDGET = 950_000_000
/** GitHub refuses a release asset of 2 GiB or more. */
export const ASSET_LIMIT = 2 * 1024 ** 3
/** How many of the largest files a site over its budget names. */
export const LARGEST = 5

export const USAGE = 'usage: node tools/verify/site_budget.mjs site <dir> | assets <file or folder>...'

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`
const message = (e) => (e instanceof Error ? e.message : String(e))

/**
 * Every file at `path` (the file itself, or every file under a folder, at any depth, sorted by name), each with its
 * size, links followed; and why anything there cannot be measured.
 */
export function walk(path) {
  const files = []
  const problems = []
  const visit = (p, holders) => {
    let st
    try {
      st = lstatSync(p)
    } catch (e) {
      problems.push(e?.code === 'ENOENT' ? `${p} does not exist` : `${p}: ${message(e)}`)
      return
    }
    if (st.isSymbolicLink()) {
      let to = '?'
      try { to = readlinkSync(p) } catch { /* named as '?' */ }
      try {
        st = statSync(p)
      } catch (e) {
        problems.push(e?.code === 'ELOOP'
          ? `${p} is a symbolic link that loops (to ${to}): it cannot be measured`
          : `${p} is a symbolic link to ${to}, which does not exist: it cannot be measured`)
        return
      }
    }
    if (st.isFile()) {
      files.push({ path: p, size: st.size })
      return
    }
    if (st.isDirectory()) {
      let real, names
      try {
        real = realpathSync(p)
        names = readdirSync(p).sort()
      } catch (e) {
        problems.push(`${p}: ${message(e)}`)
        return
      }
      if (holders.includes(real)) {
        problems.push(`${p} is a link back to ${real}, a folder that holds it: it cannot be measured`)
        return
      }
      for (const name of names) visit(join(p, name), [...holders, real])
      return
    }
    problems.push(`${p} is neither a file nor a folder`)
  }
  visit(path, [])
  return { files, problems }
}

/** Pure. The web copy's check: its files' sizes summed against `budget` (at most). One line, and the problem if over. */
export function siteReport(name, files, budget = SITE_BUDGET) {
  const total = files.reduce((n, f) => n + f.size, 0)
  const over = total - budget
  const line = `site_budget: site ${name} ${total} bytes in ${plural(files.length, 'file')} (budget: at most ${budget}): ${over > 0 ? `over by ${plural(over, 'byte')}` : 'ok'}`
  if (over <= 0) return { line, problems: [] }
  const largest = [...files].sort((a, b) => b.size - a.size || (a.path < b.path ? -1 : 1)).slice(0, LARGEST)
  return {
    line,
    problems: [`${name} is ${total} bytes, over the web copy's budget of ${budget} (GitHub Pages publishes no site over 1 GB); its largest files: ${largest.map((f) => `${f.path} (${f.size})`).join(', ')}`],
  }
}

/** Pure. One release file's check: its size against `limit` (under it). One line, and the problem if it is not. */
export function assetReport(file, limit = ASSET_LIMIT) {
  const ok = file.size < limit
  return {
    line: `site_budget: asset ${file.path} ${file.size} bytes (limit: under ${limit}): ${ok ? 'ok' : 'too big'}`,
    problems: ok ? [] : [`${file.path} is ${file.size} bytes, not under the ${limit}-byte limit (GitHub refuses a release asset of 2 GiB or more)`],
  }
}

/** The command line: returns the exit code, printing through `out` (console by default). It takes no limit. */
export function main(argv, out = console) {
  const [command, ...paths] = argv
  const known = command === 'site' ? paths.length === 1 : command === 'assets' && paths.length > 0
  if (!known || paths.some((p) => p.startsWith('-'))) {
    out.error(USAGE)
    return 2
  }
  const lines = []
  const problems = []
  if (command === 'site') {
    const dir = paths[0]
    let folder = false
    try { folder = statSync(dir).isDirectory() } catch { /* walk() says why */ }
    // Not a folder: what walk() finds wrong with the path (missing, a link to nothing), or that it is a file.
    const w = folder ? walk(dir) : { files: [], problems: walk(dir).problems.slice(0, 1) }
    if (!folder && w.problems.length === 0) w.problems.push(`${dir} is not a folder`)
    problems.push(...w.problems)
    const r = siteReport(dir, w.files)
    lines.push(r.line)
    problems.push(...r.problems)
  } else {
    for (const p of paths) {
      const w = walk(p)
      problems.push(...w.problems)
      if (w.files.length === 0 && w.problems.length === 0) lines.push(`site_budget: asset ${p}: no files`)
      for (const f of w.files) {
        const r = assetReport(f)
        lines.push(r.line)
        problems.push(...r.problems)
      }
    }
  }
  for (const l of lines) out.log(l)
  for (const p of problems) out.error(`::error::site_budget: ${p}`)
  return problems.length === 0 ? 0 : 1
}

/** Whether this file is the script node was asked to run, by its real path: a run through a link to it still checks. */
function invoked() {
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (process.argv[1] && invoked()) process.exitCode = main(process.argv.slice(2))
