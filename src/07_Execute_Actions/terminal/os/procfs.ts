// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It is the kernel's own part of /proc: a directory for every running task (its status,
 * its arguments, its directory, its environment and its open descriptors, each a small text file), `self` for
 * whichever task is looking, and the kernel's own readings (`mounts`, `uptime`, `version`). Every file is made when
 * it is read, from the table as it stands at that moment. The host adds the city's readings beside these.
 * What breaks if it is removed? `ps` still works (it asks the kernel), but nothing about a task can be read as a
 * file, and a script cannot find out what is mounted.
 */
import type { Kernel, ProcInfo } from './kernel.ts'
import { dir, text } from './synth.ts'
import type { SynthDir, SynthNode } from './synth.ts'

/** Whether a name is a number spelled the one way it is listed: digits, with no leading zero. `01` finds nothing. */
const numeral = (name: string): boolean => /^(0|[1-9][0-9]*)$/.test(name)

function task(kernel: Kernel, pid: number): SynthDir | null {
  const find = (): ProcInfo | null => kernel.ps().find((p) => p.pid === pid) ?? null
  if (find() === null) return null
  const gone = '(ended)\n'
  const fds: SynthDir = {
    kind: 'dir',
    names: () => {
      const p = find()
      const out: string[] = []
      if (p !== null) p.fds.forEach((label, fd) => { if (label !== null) out.push(String(fd)) })
      return out
    },
    child: (name) => {
      const p = find()
      const label = p === null || !numeral(name) ? undefined : p.fds[Number(name)]
      return label === null || label === undefined ? null : text(() => `${label}\n`)
    },
  }
  return dir({
    status: text(() => {
      const p = find()
      if (p === null) return gone
      return `Name:\t${p.name}\nState:\t${p.state === 'run' ? 'R (running)' : p.state === 'wait' ? `S (waiting: ${p.why})` : 'Z (ended)'}\nPid:\t${p.pid}\nPPid:\t${p.ppid}\nPgid:\t${p.pgid}\nUid:\t${p.uid}\nCalls:\t${p.steps}\nStarted:\t${((p.started - kernel.booted) / 1000).toFixed(3)}\n`
    }),
    cmdline: text(() => { const p = find(); return p === null ? gone : `${p.argv.join(' ')}\n` }),
    cwd: text(() => { const p = find(); return p === null ? gone : `${p.cwd}\n` }),
    environ: text(() => {
      const p = find()
      if (p === null) return gone
      let out = ''
      for (const [k, v] of p.env) out += `${k}=${v}\n`
      return out
    }, 0o400),
    fd: fds,
  })
}

/**
 * The kernel's part of /proc, with `extra` (the host's readings) beside it. A name in `extra` wins over none of the
 * kernel's (a task's number, `self`, a fixed reading), and is not listed beside it either.
 */
export function procfs(kernel: Kernel, version: string, extra: Readonly<Record<string, SynthNode>> = {}): SynthDir {
  const fixed: Record<string, SynthNode> = {
    mounts: text(() => kernel.vfs.mounts().map((m) => `${m.source} ${m.path} ${m.driver.type} ${m.driver.readOnly ? 'ro' : 'rw'}\n`).join('')),
    uptime: text(() => `${((kernel.clock() - kernel.booted) / 1000).toFixed(2)}\n`),
    version: text(() => `${version}\n`),
  }
  const names = (): string[] => {
    const out = kernel.ps().map((p) => String(p.pid))
    out.push('self')
    for (const name of Object.keys(fixed)) out.push(name)
    for (const name of Object.keys(extra)) if (!Object.hasOwn(fixed, name) && name !== 'self' && !numeral(name)) out.push(name)
    return out
  }
  return {
    kind: 'dir',
    names,
    child(name) {
      if (name === 'self') return kernel.current === null ? null : task(kernel, kernel.current.pid)
      if (numeral(name)) return task(kernel, Number(name))
      if (Object.hasOwn(fixed, name)) return fixed[name]
      return Object.hasOwn(extra, name) ? extra[name] : null
    },
  }
}
