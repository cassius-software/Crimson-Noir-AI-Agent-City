// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? The shaders are `.wgsl` files imported as text (`?raw`), so the single-file page carried
 * every comment in them, and carried crowd.wgsl and its way files twice (the page's bundle and the physics worker's):
 * about 83 KB of a page held to a byte budget (tools/verify/page_dist.mjs), which no GPU reads. leanWgsl is a shader's
 * text without its comments, for the build and the dev server (vite.config.ts leanShaders) and for the CI tool that
 * compiles every crowd kernel (tools/browser/kernels.mjs), so what is compiled there is what ships.
 * The tokens are the file's own: only a comment's text goes, with the spaces before it. Every line stays where it is
 * (a comment's line break is kept), so the line and column of a compilation message still name the source file's line
 * (src/01_Initialize_World/gpuPipelines.ts quotes them on the recovery card). The licence header at the head of the
 * file stays word for word: the shader text in the page still says whose it is.
 * Node only (the build and the tools; hence .node.ts): nothing in the page imports it.
 * What breaks if it is removed? The build (vite.config.ts imports it) and tools/browser/kernels.mjs; without the
 * plugin the page carries the comments again and goes over its budget.
 */

/** WGSL's line breaks (the specification's list): a line comment ends at any of them, not only at a line feed. */
const LINE_BREAK = /\r\n|[\n\v\f\r\u0085\u2028\u2029]/

/** A line of the licence header at the head of a file (tools/license/headers.mjs writes its three lines). */
const HEADER_LINE = /^\/\/.*(?:Copyright|SPDX-License-Identifier|LICENSE)/

/**
 * A WGSL source without its comments, line for line: `// ...` to the end of its line, and `/* ... *\/` blocks (which
 * nest in WGSL, and may run over lines) as one space, so the tokens either side of a block stay apart. WGSL has no
 * string literals, so `//` and `/*` open a comment wherever they stand outside one. The leading licence header lines
 * are kept, and each line's trailing spaces go. The lines are joined by line feeds whatever broke them in the file.
 */
export function leanWgsl(source: string): string {
  const out: string[] = []
  let depth = 0
  let header = true
  for (const line of source.split(LINE_BREAK)) {
    if (header && HEADER_LINE.test(line)) {
      out.push(line.trimEnd())
      continue
    }
    header = false
    let kept = ''
    for (let i = 0; i < line.length; i++) {
      const two = line.slice(i, i + 2)
      if (depth > 0) {
        if (two === '/*') { depth++; i++ } else if (two === '*/') { depth--; i++; if (depth === 0) kept += ' ' }
      } else if (two === '//') {
        break
      } else if (two === '/*') {
        depth = 1
        i++
      } else {
        kept += line[i]
      }
    }
    out.push(kept.trimEnd())
  }
  return out.join('\n')
}

/** A module id that asks for a shader as text: Vite's `./x.wgsl?raw` (the dev server may add other query words). */
export const isRawWgsl = (id: string): boolean => /\.wgsl\?(?:[^#]*&)?raw(?:&|$)/.test(id)
