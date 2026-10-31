// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It lists a compiled NoirScript function one instruction per line, the way `noir asm`
 * shows it: a header naming the function, its signature and its frame, then `0012  ADD_F32X4`, `0013  CALL fib 1`,
 * `0007  JMP_IF_NOT 0021`. Lane counts become the X4/X8 suffix, jump destinations are printed as addresses, calls
 * name their callee and its parameter count, and `print` names the types it formats. It reads the same opcode
 * tables the VM runs, so the listing cannot disagree with the machine.
 * What breaks if it is removed? `asm` has nothing to show and no test can pin the compiler's output by eye.
 */
import { tyName } from './ast.ts'
import type { CompiledFn } from './vm.ts'
import { LANED, OPERANDS, OP_NAMES, Op } from './vm.ts'

const addr = (a: number): string => String(a).padStart(4, '0')

/** The listing of one function; `callee(index)` names the functions CALL refers to. */
export function disassemble(fn: CompiledFn, callee: (index: number) => CompiledFn | undefined): string[] {
  const lines: string[] = [`fn ${fn.name}(${fn.params.map(tyName).join(', ')}) -> ${tyName(fn.ret)}  frame ${fn.frameSize} stack ${fn.maxStack}`]
  const code = fn.code
  let pc = 0
  while (pc < code.length) {
    const start = pc
    const op = code[pc++]!
    const name = OP_NAMES[op] ?? `OP_${op}`
    const count = OPERANDS[op] ?? 0
    const operands: number[] = []
    if (count < 0) {
      const n = code[pc++]!
      operands.push(n)
      for (let k = 0; k < n; k++) operands.push(code[pc++]!)
    } else for (let k = 0; k < count; k++) operands.push(code[pc++]!)
    lines.push(`${addr(start)}  ${render(op, name, operands, fn, callee)}`)
  }
  return lines
}

function render(op: number, name: string, operands: number[], fn: CompiledFn, callee: (index: number) => CompiledFn | undefined): string {
  switch (op) {
    case Op.JMP: case Op.JMP_IF: case Op.JMP_IF_NOT: return `${name} ${addr(operands[0]!)}`
    case Op.QNEXT: return `${name} ${operands[0]} ${operands[1]} ${addr(operands[2]!)}`
    case Op.CALL: {
      const f = callee(operands[0]!)
      return f === undefined ? `${name} #${operands[0]}` : `${name} ${f.name} ${f.params.length}`
    }
    case Op.PRINT: return `${name} ${operands[0]}${operands.slice(1).map((t) => ` ${tyName(fn.types[t]!)}`).join('')}`
    default: {
      if (LANED.has(op)) {
        const lanes = operands[0]!
        const rest = operands.slice(1)
        return `${name}${lanes > 1 ? `X${lanes}` : ''}${rest.map((o) => ` ${o}`).join('')}`
      }
      return `${name}${operands.map((o) => ` ${o}`).join('')}`
    }
  }
}
