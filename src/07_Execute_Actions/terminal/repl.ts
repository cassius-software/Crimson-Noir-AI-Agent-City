/**
 * Why does this file exist? It is R0, the console's own language: a small Forth-like stack machine, the product's
 * own, that is Turing-complete (unbounded loops and recursion over 65 536 addressable cells) and blind. It is the
 * whole compute surface of the bare console (the ?boot=tty track has no engine at all) and the same machine inside
 * the city's console. A line is compiled into a program and run against a data stack of 32-bit integers, a bounded
 * return stack and a bounded Int32Array; the only output is the lines the result carries. The module reaches
 * nothing: no dynamic code, no global object, no clock, no randomness, no network, no storage, no timers, no DOM;
 * it has no import line at all, and the city is reachable from the console only as before, through the operator
 * tier and the capability gateway. Every run is bounded by a step budget and an output cap, so a runaway word ends
 * with a named error and the machine stays usable: the dictionary and the memory survive, the data stack is cleared.
 * Deterministic: the same lines in the same order always give the same output.
 * What breaks if it is removed? The console has no language of its own, and the bare console computes nothing.
 */

/** The limits of one run: instructions per line, characters printed per line, cells of memory. */
export const REPL = Object.freeze({ maxSteps: 1_000_000, maxOut: 16_384, cells: 65_536 })

/** The bounds of the two stacks (words deep); a runaway recursion ends with 'return stack overflow'. */
const STACK_DEPTH = 4_096
const RETURN_DEPTH = 4_096

/** What one line gave: the lines printed, the first error if any, and the instructions it took. */
export interface ReplResult {
  out: string[]
  error?: string
  steps: number
}

/** A compiled word: a primitive runs on the machine; a colon definition is a program. */
interface Colon { readonly kind: 'colon'; readonly name: string; code: Instr[] }
interface Prim { readonly kind: 'prim'; readonly name: string; readonly run: (m: Runtime) => void }
type Word = Colon | Prim

/** One instruction of a compiled program. Branch destinations are indices into the same program. */
type Instr =
  | { readonly op: 'lit'; readonly n: number }
  | { readonly op: 'str'; readonly s: string }
  | { readonly op: 'call'; readonly word: Word }
  | { readonly op: 'branch'; readonly to: number }
  | { readonly op: 'zbranch'; readonly to: number }
  | { readonly op: 'exit' }

/** The named errors a run can end with. */
class R0Error extends Error {}
function fail(message: string): never { throw new R0Error(message) }

/** The mutable state a primitive sees: the data stack, the memory and the printer. */
interface Runtime {
  stack: number[]
  memory: Int32Array
  print(text: string): void
  pop(): number
  push(n: number): void
  address(a: number): number
}

const wrap = (n: number): number => n | 0
const flag = (b: boolean): number => (b ? -1 : 0)

/** Every built-in word, in the order `words()` lists them. */
const PRIMITIVES: readonly Prim[] = [
  // Arithmetic (32-bit wrap; `/` and `mod` truncate toward zero and refuse a zero divisor).
  prim('+', (m) => { const b = m.pop(), a = m.pop(); m.push(a + b) }),
  prim('-', (m) => { const b = m.pop(), a = m.pop(); m.push(a - b) }),
  prim('*', (m) => { const b = m.pop(), a = m.pop(); m.push(mul32(a, b)) }),
  prim('/', (m) => { const b = m.pop(), a = m.pop(); if (b === 0) fail('division by zero'); m.push(a / b) }),
  prim('mod', (m) => { const b = m.pop(), a = m.pop(); if (b === 0) fail('division by zero'); m.push(a % b) }),
  prim('negate', (m) => m.push(-m.pop())),
  prim('abs', (m) => { const a = m.pop(); m.push(a < 0 ? -a : a) }),
  prim('min', (m) => { const b = m.pop(), a = m.pop(); m.push(a < b ? a : b) }),
  prim('max', (m) => { const b = m.pop(), a = m.pop(); m.push(a > b ? a : b) }),
  prim('1+', (m) => m.push(m.pop() + 1)),
  prim('1-', (m) => m.push(m.pop() - 1)),
  // Comparison: true is -1, false is 0.
  prim('=', (m) => { const b = m.pop(), a = m.pop(); m.push(flag(a === b)) }),
  prim('<>', (m) => { const b = m.pop(), a = m.pop(); m.push(flag(a !== b)) }),
  prim('<', (m) => { const b = m.pop(), a = m.pop(); m.push(flag(a < b)) }),
  prim('>', (m) => { const b = m.pop(), a = m.pop(); m.push(flag(a > b)) }),
  prim('<=', (m) => { const b = m.pop(), a = m.pop(); m.push(flag(a <= b)) }),
  prim('>=', (m) => { const b = m.pop(), a = m.pop(); m.push(flag(a >= b)) }),
  // Logic: `and`, `or`, `xor`, `invert` are bitwise (they compose flags); `not` is logical (0 becomes -1).
  prim('and', (m) => { const b = m.pop(), a = m.pop(); m.push(a & b) }),
  prim('or', (m) => { const b = m.pop(), a = m.pop(); m.push(a | b) }),
  prim('xor', (m) => { const b = m.pop(), a = m.pop(); m.push(a ^ b) }),
  prim('invert', (m) => m.push(~m.pop())),
  prim('not', (m) => m.push(flag(m.pop() === 0))),
  prim('lshift', (m) => { const b = m.pop(), a = m.pop(); m.push(a << (b & 31)) }),
  prim('rshift', (m) => { const b = m.pop(), a = m.pop(); m.push(a >>> (b & 31)) }),
  // The data stack.
  prim('dup', (m) => { const a = m.pop(); m.push(a); m.push(a) }),
  prim('drop', (m) => { m.pop() }),
  prim('swap', (m) => { const b = m.pop(), a = m.pop(); m.push(b); m.push(a) }),
  prim('over', (m) => { const b = m.pop(), a = m.pop(); m.push(a); m.push(b); m.push(a) }),
  prim('rot', (m) => { const c = m.pop(), b = m.pop(), a = m.pop(); m.push(b); m.push(c); m.push(a) }),
  prim('-rot', (m) => { const c = m.pop(), b = m.pop(), a = m.pop(); m.push(c); m.push(a); m.push(b) }),
  prim('nip', (m) => { const b = m.pop(); m.pop(); m.push(b) }),
  prim('tuck', (m) => { const b = m.pop(), a = m.pop(); m.push(b); m.push(a); m.push(b) }),
  prim('2dup', (m) => { const b = m.pop(), a = m.pop(); m.push(a); m.push(b); m.push(a); m.push(b) }),
  prim('2drop', (m) => { m.pop(); m.pop() }),
  prim('depth', (m) => m.push(m.stack.length)),
  // Memory: 65 536 cells of 32-bit integers, addressed 0 to 65535.
  prim('@', (m) => m.push(m.memory[m.address(m.pop())]!)),
  prim('!', (m) => { const a = m.address(m.pop()); m.memory[a] = m.pop() }),
  prim('+!', (m) => { const a = m.address(m.pop()); m.memory[a] = wrap(m.memory[a]! + m.pop()) }),
  // Output.
  prim('.', (m) => m.print(`${m.pop()} `)),
  prim('emit', (m) => m.print(String.fromCharCode(m.pop() & 0xffff))),
  prim('cr', (m) => m.print('\n')),
  prim('space', (m) => m.print(' ')),
  prim('spaces', (m) => { const n = m.pop(); if (n > 0) m.print(' '.repeat(n)) }),
]

/** The words the compiler handles itself; they are listed so `words()` is the whole language. */
const COMPILER_WORDS: readonly string[] = [':', ';', 'if', 'else', 'then', 'begin', 'until', 'while', 'repeat', 'exit', '."', '(', '\\']

function prim(name: string, run: (m: Runtime) => void): Prim {
  return { kind: 'prim', name, run }
}

/** 32-bit multiplication without the double's rounding (the low 32 bits of the product). */
function mul32(a: number, b: number): number {
  const ah = (a >>> 16) & 0xffff, al = a & 0xffff
  const bh = (b >>> 16) & 0xffff, bl = b & 0xffff
  return (al * bl + (((ah * bl + al * bh) << 16) >>> 0)) | 0
}

/** A number token: decimal, or hexadecimal after 0x, wrapped to 32 bits. Anything else is a word. */
function parseNumber(token: string): number | null {
  if (/^-?\d+$/.test(token)) return wrap(Number(token))
  if (/^-?0x[0-9a-f]+$/i.test(token)) {
    const neg = token.startsWith('-')
    const n = Number.parseInt(neg ? token.slice(3) : token.slice(2), 16)
    return wrap(neg ? -n : n)
  }
  return null
}

/** The tokens of a line: whitespace-separated words, `." text"` as one string token, comments dropped. */
type Token = { readonly kind: 'word'; readonly text: string } | { readonly kind: 'string'; readonly text: string }

function tokenize(line: string): Token[] {
  const tokens: Token[] = []
  const chars = line
  let i = 0
  const n = chars.length
  while (i < n) {
    const c = chars[i]!
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { i++; continue }
    let j = i
    while (j < n && !/\s/.test(chars[j]!)) j++
    const word = chars.slice(i, j)
    if (word.startsWith('."')) {
      // The string runs after one separating space (if any) up to the closing quote.
      const start = chars[i + 2] === ' ' ? i + 3 : i + 2
      const end = chars.indexOf('"', start)
      if (end < 0) fail('unterminated string')
      tokens.push({ kind: 'string', text: chars.slice(start, end) })
      i = end + 1
    } else if (word === '(') {
      const end = chars.indexOf(')', j)
      if (end < 0) fail('unterminated comment')
      i = end + 1
    } else if (word === '\\') {
      break
    } else {
      tokens.push({ kind: 'word', text: word.toLowerCase() })
      i = j
    }
  }
  return tokens
}

/** An open control structure while compiling: the instruction to patch, or the loop head to branch back to. */
type Open = { readonly kind: 'if' | 'else' | 'begin' | 'while'; readonly at: number }

/**
 * Compiles a line into a program and the colon definitions it declares. Control structures work at the top level
 * as well as inside a definition. Definitions are resolved against the dictionary and against each other, so a
 * word may call itself and a word defined earlier in the same line; they are installed only if the whole line
 * compiles, and a redefinition shadows the old word without changing the words already compiled against it.
 */
function compile(line: string, dictionary: Map<string, Word>): { program: Instr[]; defined: Colon[] } {
  const tokens = tokenize(line)
  const defined: Colon[] = []
  const pending = new Map<string, Word>()
  const lookup = (name: string): Word | undefined => pending.get(name) ?? dictionary.get(name)
  const top: Instr[] = []
  let code = top
  let current: Colon | null = null
  let open: Open[] = []
  const savedOpen: Open[] = []
  for (let t = 0; t < tokens.length; t++) {
    const tok = tokens[t]!
    if (tok.kind === 'string') { code.push({ op: 'str', s: tok.text }); continue }
    const w = tok.text
    switch (w) {
      case ':': {
        if (current !== null) fail('nested definition')
        const name = tokens[++t]
        if (name === undefined || name.kind !== 'word') fail('definition without a name')
        if (parseNumber(name.text) !== null || COMPILER_WORDS.includes(name.text)) fail(`cannot define '${name.text}'`)
        current = { kind: 'colon', name: name.text, code: [] }
        code = current.code
        savedOpen.push(...open)
        open = []
        break
      }
      case ';': {
        if (current === null) fail("';' outside a definition")
        if (open.length > 0) fail(`'${open[open.length - 1]!.kind}' without its end`)
        code.push({ op: 'exit' })
        pending.set(current.name, current)
        defined.push(current)
        current = null
        code = top
        open = savedOpen.splice(0)
        break
      }
      case 'if':
        open.push({ kind: 'if', at: code.length })
        code.push({ op: 'zbranch', to: -1 })
        break
      case 'else': {
        const o = open.pop()
        if (o === undefined || o.kind !== 'if') fail("'else' without 'if'")
        open.push({ kind: 'else', at: code.length })
        code.push({ op: 'branch', to: -1 })
        code[o.at] = { op: 'zbranch', to: code.length }
        break
      }
      case 'then': {
        const o = open.pop()
        if (o === undefined || (o.kind !== 'if' && o.kind !== 'else')) fail("'then' without 'if'")
        code[o.at] = { op: o.kind === 'if' ? 'zbranch' : 'branch', to: code.length }
        break
      }
      case 'begin':
        open.push({ kind: 'begin', at: code.length })
        break
      case 'until': {
        const o = open.pop()
        if (o === undefined || o.kind !== 'begin') fail("'until' without 'begin'")
        code.push({ op: 'zbranch', to: o.at })
        break
      }
      case 'while': {
        const o = open[open.length - 1]
        if (o === undefined || o.kind !== 'begin') fail("'while' without 'begin'")
        open.push({ kind: 'while', at: code.length })
        code.push({ op: 'zbranch', to: -1 })
        break
      }
      case 'repeat': {
        const w1 = open.pop()
        const b = open.pop()
        if (w1 === undefined || w1.kind !== 'while' || b === undefined || b.kind !== 'begin') fail("'repeat' without 'begin … while'")
        code.push({ op: 'branch', to: b.at })
        code[w1.at] = { op: 'zbranch', to: code.length }
        break
      }
      case 'exit':
        if (current === null) fail("'exit' outside a definition")
        code.push({ op: 'exit' })
        break
      default: {
        const n = parseNumber(w)
        if (n !== null) { code.push({ op: 'lit', n }); break }
        const word = current !== null && current.name === w ? current : lookup(w)
        if (word === undefined) fail(`unknown word '${w}'`)
        code.push({ op: 'call', word })
      }
    }
  }
  if (current !== null) fail(`unterminated definition ':' ${current.name}`)
  if (open.length > 0) fail(`'${open[open.length - 1]!.kind}' without its end`)
  return { program: top, defined }
}

/**
 * The R0 machine. `run(line)` compiles and runs one line against the machine's dictionary and memory and returns
 * what it printed; `reset()` forgets every definition and zeroes the memory; `words()` lists the language.
 */
export class Machine {
  private readonly dictionary = new Map<string, Word>()
  private readonly user: string[] = []
  private readonly memory = new Int32Array(REPL.cells)
  private stack: number[] = []

  constructor() {
    for (const p of PRIMITIVES) this.dictionary.set(p.name, p)
  }

  /** Every definition forgotten, the memory zeroed, the stack emptied. */
  reset(): void {
    this.dictionary.clear()
    for (const p of PRIMITIVES) this.dictionary.set(p.name, p)
    this.user.length = 0
    this.memory.fill(0)
    this.stack = []
  }

  /** The language: the compiler's words, the primitives, then the user's definitions in the order made. */
  words(): string[] {
    return [...COMPILER_WORDS, ...PRIMITIVES.map((p) => p.name), ...this.user]
  }

  /** Compiles and runs one line. Never throws: every failure is a named error in the result. */
  run(line: string): ReplResult {
    const out: string[] = []
    let pendingLine = ''
    let printed = 0
    let steps = 0
    const print = (text: string): void => {
      printed += text.length
      if (printed > REPL.maxOut) fail(`output limit exhausted (${REPL.maxOut})`)
      let rest = text
      for (;;) {
        const nl = rest.indexOf('\n')
        if (nl < 0) { pendingLine += rest; break }
        out.push(pendingLine + rest.slice(0, nl))
        pendingLine = ''
        rest = rest.slice(nl + 1)
      }
    }
    const stack = this.stack
    const rt: Runtime = {
      stack,
      memory: this.memory,
      print,
      pop: () => {
        if (stack.length === 0) fail('stack underflow')
        return stack.pop()!
      },
      push: (n) => {
        if (stack.length >= STACK_DEPTH) fail('stack overflow')
        stack.push(wrap(n))
      },
      address: (a) => {
        if (a < 0 || a >= REPL.cells) fail(`address out of range (${a})`)
        return a
      },
    }
    try {
      const { program, defined } = compile(line, this.dictionary)
      for (const d of defined) {
        if (!this.user.includes(d.name)) this.user.push(d.name)
        this.dictionary.set(d.name, d)
      }
      // The interpreter: an explicit return stack of (program, pc) frames, so recursion never touches the host's.
      const frames: { code: Instr[]; pc: number }[] = [{ code: program, pc: 0 }]
      while (frames.length > 0) {
        const f = frames[frames.length - 1]!
        if (f.pc >= f.code.length) { frames.pop(); continue }
        if (steps === REPL.maxSteps) fail(`step budget exhausted (${REPL.maxSteps})`)
        steps++
        const ins = f.code[f.pc++]!
        switch (ins.op) {
          case 'lit': rt.push(ins.n); break
          case 'str': print(ins.s); break
          case 'branch': f.pc = ins.to; break
          case 'zbranch': if (rt.pop() === 0) f.pc = ins.to; break
          case 'exit': frames.pop(); break
          case 'call':
            if (ins.word.kind === 'prim') ins.word.run(rt)
            else {
              if (frames.length >= RETURN_DEPTH) fail('return stack overflow')
              frames.push({ code: ins.word.code, pc: 0 })
            }
            break
        }
      }
      if (pendingLine.length > 0) out.push(pendingLine)
      return { out, steps }
    } catch (e) {
      if (pendingLine.length > 0) out.push(pendingLine)
      this.stack = []
      const error = e instanceof R0Error ? e.message : 'internal error'
      return { out, error, steps }
    }
  }
}
