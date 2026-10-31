# NoirScript: the console's typed, compiled language

This is the language the console's `noir` command runs (`MANUAL.md` says how to reach it). The implementation is
`src/07_Execute_Actions/terminal/noirscript/`: `lexer.ts`, `ast.ts`, `parser.ts`, `types.ts`, `compiler.ts`, `vm.ts`,
`intrinsics.ts`, `disasm.ts`, `format.ts` and `index.ts` (the public face), with the tests `lexer.test.ts`,
`parser.test.ts`, `types.test.ts`, `vm.test.ts`, `session.test.ts`, `fuzz.test.ts` and `airgap.test.ts` beside them.
Nothing in that directory imports from outside it (the air gap the console keeps), and every type is defined there.
Where this text said less than the implementation had to decide, the decision is marked **pinned** here and held by
a test.

NoirScript sits beside R0 (`repl.ts`, the Forth) as the console's second language: statically typed, compiled to
bytecode, run on a bounded VM over one contiguous memory arena (structure-of-arrays, 64-byte-aligned columns), with
128-bit and 256-bit lane types and branchless intrinsics, and read-only typed access to the city's SoA columns
(crowd, cars, kernel, frame) handed in by the host at run time. It is Turing complete (unbounded loops, recursion,
addressable arrays), deterministic (no clock, no randomness; f32 is true IEEE binary32 via Math.fround; i32/u32 wrap),
and bounded (steps, output, memory, call depth), and it never throws out of `run`.
There is no JIT and no dynamic code generation: the console forbids dynamic code; it is a bytecode VM.

## Public API (`index.ts`)
```ts
export interface NoirColumns { readonly n: number }               // every table has n (rows)
export interface NoirTables {
  readonly crowd: { readonly n: number; readonly x: Float32Array; readonly z: Float32Array }
  readonly cars:  { readonly n: number; readonly x: Float32Array; readonly z: Float32Array; readonly heading: Float32Array; readonly speed: Float32Array; readonly mode: Int32Array } // mode 0 ai, 1 player, 2 parked
  readonly kernel: { readonly law1: number; readonly law2: number; readonly law3: number; readonly flips: number; readonly shielded: boolean }
  readonly frame: { readonly fps: number; readonly ms: number; readonly p95: number }
}
export const EMPTY_TABLES: NoirTables     // every n 0, every array empty, every scalar 0/false
/** Writes the elite tier allows (absent: every write intrinsic fails with the host's reason). Each may throw: the message becomes the run's error. */
export interface NoirWrites {
  tune(key: string, value: number): number
  intent(car: number, throttle: number, brake: number, steer: number): boolean
  cull(density: number): number
  steer(feature: string, value: number): number
}
export interface NoirHost { tables(): NoirTables; readonly write?: NoirWrites; readonly locked?: string } // `locked`: the message a write intrinsic fails with when `write` is absent (default "elite tier locked")
export interface NoirLimits { readonly steps: number; readonly out: number; readonly cells: number; readonly depth: number }
export const LIMITS: NoirLimits        // { steps: 1_000_000, out: 16_384, cells: 262_144 (1 MiB of 32-bit cells), depth: 1_024 }
export const ELITE_LIMITS: NoirLimits  // { steps: 50_000_000, out: 65_536, cells: 4_194_304 (16 MiB), depth: 4_096 }
export interface NoirResult { readonly out: string[]; readonly error?: string; readonly steps: number; readonly defined: readonly string[] } // defined: fns and globals this line declared
export class NoirSession {
  constructor(limits?: NoirLimits)
  /** Compiles and runs one line (may hold several statements and newlines). Never throws. */
  run(source: string, host?: NoirHost | null, limits?: NoirLimits): NoirResult   // limits are made sane first (see Session)
  /** Compiles only and returns the bytecode listing (or the compile error as `error`). */
  asm(source: string): NoirResult
  /** Forgets every function and global and zeroes memory. */
  reset(): void
  /** The language: keywords, types, intrinsics, then user fns and globals in order of definition. */
  words(): string[]
}
export const KEYWORDS: readonly string[]; export const TYPE_NAMES: readonly string[]; export const INTRINSIC_NAMES: readonly string[]
export function f32Text(x: number): string   // shortest decimal that round-trips through Math.fround (see Printing)
```

## Lexical structure (`lexer.ts`)
- Whitespace and comments (`// to end of line`, `/* ... */` non-nesting) separate tokens.
- Integer literals: decimal `42`, hex `0xFF`, binary `0b1010`, with `_` separators allowed between digits (each `_`
  has a digit on both sides: `1_`, `1__0`, `0x_F` and `1._5` are "malformed ... literal"); suffix `u`
  makes a u32 literal (`7u`, `0xFFu`). A decimal literal above 2^32-1 is a lexical error; above 2^31-1 unsuffixed
  is a type error unless it adopts u32 (below).
- Float literals: `1.5`, `2.`, `.5` is NOT allowed, `1e3`, `2.5e-2`, optional suffix `f` (`1.0f`). Always f32.
- Identifiers `[A-Za-z_][A-Za-z0-9_]*`. Strings `"..."` with escapes `\n \t \" \\`, used only as arguments to
  `print`/`println` and the host write intrinsics (`tune`, `steer`); a string anywhere else is a type error.
- Keywords: `fn let mut if else while for in loop break continue return true false as query where`.
  Types: `i32 u32 f32 bool void f32x4 i32x4 u32x4 u32x8 col`.
- Operators/punctuation: `+ - * / % & | ^ ~ ! << >> == != < <= > >= && || = += -= *= /= %= &= |= ^= <<= >>= -> .. ..= . , ; : :: ( ) { } [ ]`.
- Each token carries line and column (1-based). Lexical errors: "1:5: unexpected character '@'", "unterminated string",
  "integer literal too large".

## Grammar (`parser.ts`, a Pratt parser for expressions; recursive descent for statements)
```
program   := item* ;  item := fnDecl | statement
fnDecl    := 'fn' IDENT '(' params? ')' ( '->' type )? block          // top level only; body returns `type` (void if omitted)
params    := IDENT ':' type ( ',' IDENT ':' type )*
type      := 'i32' | 'u32' | 'f32' | 'bool' | 'void' | 'f32x4' | 'i32x4' | 'u32x4' | 'u32x8'
           | '[' type ';' INT ']'                                     // fixed-size array of scalar or vector type, INT >= 1, <= 1_048_576
           | 'col' '<' ('f32'|'i32'|'u32') '>'                        // a host column (read-only), never an array element
statement := letStmt | assign | ifStmt | whileStmt | loopStmt | forStmt | 'break' ';' | 'continue' ';'
           | 'return' expr? ';' | block | expr ';'
letStmt   := 'let' 'mut'? IDENT ( ':' type )? '=' expr ';'
assign    := lvalue ( '=' | '+=' | '-=' | '*=' | '/=' | '%=' | '&=' | '|=' | '^=' | '<<=' | '>>=' ) expr ';'
lvalue    := IDENT | IDENT '[' expr ']'                                // array element or vector lane of a mutable variable
ifStmt    := 'if' expr block ( 'else' ( ifStmt | block ) )?           // condition type bool; no parentheses needed
whileStmt := 'while' expr block ;  loopStmt := 'loop' block
forStmt   := 'for' IDENT 'in' expr ( '..' | '..=' ) expr block        // bounds i32 or u32 (same type); the variable is immutable in the body
block     := '{' statement* '}'
expr      := Pratt. Binding power, lowest first:
             1 `||`   2 `&&`   3 `== !=`   4 `< <= > >=`   5 `|`   6 `^`   7 `&`   8 `<< >>`   9 `+ -`   10 `* / %`
             11 prefix `- ! ~`   12 `as` type (postfix, left-assoc)   13 postfix: call `f(args)`, index `a[e]`, field `e.name`, method `e.len()`
primary   := INT | FLOAT | STRING | 'true' | 'false' | IDENT | '(' expr ')'
           | '[' expr ';' INT ']'                                      // array filled with a value (array literal form 1)
           | '[' expr ( ',' expr )* ']'                                // array literal form 2 (all same type)
           | 'query' IDENT 'where' expr                                 // see Tables
           | 'if' expr block 'else' block                               // if-expression: both blocks end in an expression of the same type
```
A block used as an expression ends with an expression without `;`. Blocks as statements may end that way too (value
discarded) only when the type is void; otherwise it is an error "value not used: end it with ';'". Keep it simple:
only `if` expressions and fn bodies use block values; a fn body whose last statement is an expression without `;`
returns it.
Parse errors: "2:14: expected ';' after statement, got '}'", "expected expression", "unexpected 'else'".

## Static typing (`types.ts`)
- Every expression has one type from: i32 u32 f32 bool void str f32x4 i32x4 u32x4 u32x8 [T;N] col<T> (str only for
  literals). No implicit conversions. `as` casts between i32/u32/f32 and bool->i32/u32 (0/1); f32->int truncates
  toward zero and SATURATES (NaN -> 0; like a saturating conversion); i32<->u32 reinterpret bits; int->f32 rounds to
  nearest f32. Vectors cast lane-wise between f32x4/i32x4/u32x4 (same rules); u32x8 casts only to u32x8.
- Literal adoption: an UNSUFFIXED integer literal takes the type of the other operand of a binary operator, the
  declared type of a `let x: T =`, a parameter's type, or a return type when that type is u32 (literal must be
  >= 0) or f32 (any integer literal); **pinned**: also the type of the typed elements beside it in an array literal
  (`[1, 2.0]` is `[f32; 2]`) and of the other arm of an if-expression, through an else-if chain in either direction.
  Otherwise it is i32. A float literal is always f32. So `let a: f32 = 2;` ok,
  `x_f32 * 2` ok, `7u + 1` ok (u32), `1 + 1.5` ok (f32), `let k: u32 = -1;` error "literal -1 does not fit u32".
- Arithmetic `+ - * / %` on i32/u32/f32 and on vectors lane-wise (same type both sides); `%` on floats is fmod
  (JS `%`). Bitwise `& | ^ ~ << >>` on i32/u32 and on i32x4/u32x4/u32x8; shift count is the same type as the left
  side (or an adopted literal) and is masked to 5 bits like hardware; `>>` is arithmetic for i32/i32x4, logical for
  u32/u32x4/u32x8. Comparisons on scalars give bool; `== !=` also on bool. `&& || !` only on bool (short-circuit).
  Unary `-` on i32/f32 and f32x4/i32x4 (not u32). Vector comparisons are intrinsics (below), never operators.
- Index `a[i]`: a is [T;N] or col<T> or a vector; i is i32 or u32 (adopted literal ok); bounds-checked at run time.
  `a.len()` -> i32 for arrays/cols/vectors (4 or 8).
- Field access `.x .y .z .w` on 4-lane vectors (lanes 0..3) as read-only sugar for `v[0..3]`.
- `let` without `mut` is immutable (assignment is "cannot assign to immutable 'x'"); array elements and vector
  lanes are assignable only on `mut` variables. Shadowing allowed in inner blocks; redeclaring in the same block is
  an error. Variables must be declared before use. A `for` variable is immutable. **Pinned**: a fn's body is its
  parameters' block and a for loop's body is its variable's block, so `fn f(a: i32) { let a = 2; }` redeclares.
- Functions: top level only, must be declared with full signatures; calls check arity and each argument type;
  recursion and mutual recursion allowed within a line (two passes: collect signatures, then check bodies); a fn
  from an earlier line of the session may be called; redefining a fn or a global in a later line replaces it (the
  new one takes effect for later lines; earlier compiled code is gone anyway since each line compiles afresh against
  the session's current globals/fns). Arrays and vectors are passed by VALUE (copied); cols by reference (read-only).
  A non-void fn must return on every path ("missing return in fn 'f' -> i32"); `return;` only in void fns.
- Globals: a top-level `let` persists in the session (name, type, mutability, value). Top-level `let mut` may be
  assigned by later lines. **Pinned**: a table name or an intrinsic name cannot be declared in any scope, and a name
  is a fn or a variable, never both ("'f' is a fn and cannot be declared", "'h' is a variable and cannot be a fn").
- Unused values: an expression statement whose type is not void is an error unless it is a call ("value not used").
- `print(args...)` / `println(args...)`: any types (str literals allowed); print joins with one space and ends the
  line; println is the same (keep both for ergonomics; both end with a newline). `print()` prints an empty line.
- Errors carry `line:col:` and a clear message. Every type error names both types where two are involved
  ("type mismatch: i32 + f32 (use 'as f32' or 'as i32')"). **Pinned** positions: an error about a value points at
  the expression's first token, except a binary operation or a cast, which point at the operator; an error about a
  field, method or declared name points at that name.

## Tables (the city's SoA columns) and `query`
Identifiers `crowd`, `cars`, `kernel`, `frame` are built-in tables (reserved; cannot be declared). Field access:
`crowd.n: i32`, `crowd.x: col<f32>`, `crowd.z`, `cars.n`, `cars.x cars.z cars.heading cars.speed: col<f32>`,
`cars.mode: col<i32>`, `kernel.law1 .law2 .law3 .flips: i32`, `kernel.shielded: bool`, `frame.fps .ms .p95: f32`.
`let xs = crowd.x;` binds a col<f32> (reference; reads only). A col may be a fn parameter (`fn f(xs: col<f32>)`).
**Pinned**: a col is the column's name, one cell the VM resolves against each run's snapshot, so a col bound on an
earlier line reads the current snapshot (empty under a null host), a fn may return one, an if-expression may choose
one, and a col global whose `let` never ran names no column (`col<f32>[0]`).
The tables are read ONCE at the start of a run from `host.tables()` (null host -> EMPTY_TABLES) and copied into the
arena as 64-byte-aligned columns (so a run is a consistent snapshot and a Float32Array the host hands over is never
written; copy into the arena with `set`). If the copies do not fit the arena, the run fails "memory exhausted".
`query T where <expr>` : T is a table name; inside <expr> the table's columns are in scope by their bare names as
scalars for the current row (`x`, `z`, `speed`, `mode`, ...; `n` is not) and so is everything else in scope; the
expression must be bool; the value is the i32 count of rows where it is true. **Pinned**: a row costs the steps of
its where expression plus three (the loop's own instructions).
`load_f32x4(col, i)` (and `load_i32x4`, `load_u32x4`, `load_u32x8`) read 4 (8) consecutive lanes from a column
starting at i; lanes past the end read as 0 (no error) so a loop can stride by 4 over any length.

## Intrinsics (`intrinsics.ts`; one table drives the checker, the compiler and the VM; INTRINSIC_NAMES exports it)
Scalars: `min(a,b) max(a,b) abs(a) clamp(x,lo,hi)` on i32/f32/u32 (abs not u32); `sqrt floor ceil trunc` f32
(sqrt = Math.fround(Math.sqrt(x)): correctly rounded for f32); `select(mask: u32, a, b)` on i32/u32/f32 where mask
is 0 or 0xFFFFFFFF (bitwise: b ^ ((a ^ b) & mask) on the bit patterns; for f32 operate on the bits via the arena
views so it is branchless and exact); `mask(b: bool) -> u32` (0 or 0xFFFFFFFF); `popcount(u32) clz(u32) ctz(u32)
rotl(u32, u32) rotr(u32, u32)` -> u32; `morton2(x: u32, y: u32) -> u32` (interleave the low 16 bits, x in the even
bits) and `demorton2x(m) demorton2y(m)`; `fmin fmax` not needed (min/max on f32 propagate NaN like Math.min).
Vectors: constructors `f32x4(a,b,c,d) i32x4(...) u32x4(...) u32x8(8 args)`, `splat_f32x4(x) splat_i32x4 splat_u32x4
splat_u32x8`; lane-wise `min max abs(f32x4,i32x4) sqrt(f32x4) select(mask: u32x4|u32x8, a, b)` (mask lanes
0/0xFFFFFFFF; for f32x4 select takes a u32x4 mask); comparisons `vlt(a,b) vle vgt vge veq vne` for f32x4/i32x4/u32x4
-> u32x4 and for u32x8 -> u32x8; horizontals `hsum(v)` (f32x4->f32 summing lanes 0+1+2+3 in order with fround after
each add; int vectors -> their scalar type, wrapping), `hmin hmax`; `any(mask) all(mask)` -> bool for u32x4/u32x8;
`load_*` above; `store` is not needed (write lanes with `v[i] = x` on a mut vector, or write arrays).
Host: `tune(key: str, v: f32) -> f32`, `intent(car: i32, throttle: f32, brake: f32, steer: f32) -> bool`,
`cull(density: f32) -> f32`, `steer(feature: str, v: f32) -> f32`. Without `host.write` these fail at RUN time with
`host.locked ?? 'elite tier locked'` as the error (they still type-check and compile, so `asm` works).
Overload resolution is by argument types; a mismatch names the signatures: "min: no form takes (i32, f32)".

## Bytecode and VM (`compiler.ts`, `vm.ts`)
- One `ArrayBuffer` arena of `limits.cells * 4` bytes with `Float32Array`, `Int32Array`, `Uint32Array` views over the
  SAME buffer (so f32 is exact binary32 and `select` on f32 works on bits). Layout (cells): [globals][session arrays and
  table copies, 64-byte aligned][frames + operand stack, growing up]. Vectors occupy 4 or 8 consecutive cells; arrays
  N*width cells. Locals are cells in the frame. A value on the operand stack is 1, 4 or 8 cells by type (a col is 1).
  Globals may fill three quarters of the arena; the last quarter is for the tables and the frames. **Pinned**: a line
  run with larger limits grows the arena for good (so every global stays reachable), but any line adds globals and
  uses frames only within its own limits' cells, so the larger arena is not a larger allowance for the lines after it.
- Bytecode is an `Int32Array` program with typed opcodes (ADD_I32, ADD_F32, ADD_F32X4, LT_U32, SELECT_I32, ...),
  operands inline; a constant pool for f32/str; a function table (entry, frame size, param cells). Calls push a
  frame; `limits.depth` frames at most ("stack overflow (depth 1024)"). Each executed instruction is a step (a vector
  op is one step); **pinned**: an instruction that moves w cells (an array load, store, fill, copy or return) costs
  w / 16 steps more, taken before the move, so the budget bounds the work and a run never exceeds it; past
  `limits.steps` -> "step budget exhausted (1000000)". `a.len()` builds no pure receiver (a name or a literal), but
  any other receiver runs (its calls, its bounds checks).
- Division/modulo by zero on integers -> "division by zero"; floats follow IEEE. i32 ops wrap (`| 0`, `Math.imul`),
  u32 ops wrap (`>>> 0`), f32 ops round through `Math.fround` after EVERY operation (never fuse two).
- Out-of-bounds index -> "index 9 out of bounds (len 8)". Output beyond `limits.out` characters -> "output limit
  exhausted (16384)". Arena exhausted -> "memory exhausted".
- After an error the session stays usable: globals and fns survive; the operand stack and frames are discarded.
- The compiler emits straight-line code for `select`/`mask` (no branch); `&& ||` branch (short-circuit by definition).
- `disasm.ts`: one line per instruction `0012  ADD_F32X4` / `0013  CALL fib 1` / `0007  JMP_IF_NOT 0021`, plus a header
  per function; `asm()` returns these lines as `out`.

## Printing (`format.ts`)
- i32/u32 decimal; bool `true`/`false`; f32 via `f32Text`: the shortest `toPrecision(p)` for p in 1..9 whose
  `Math.fround(Number(text))` equals the value, written as JS writes a number (`0.1`, `2`, `1.5`; **pinned**: exponent
  form below 1e-6 and from 1e21, `1e-7`, `3.4028235e+38`), `NaN`, `inf`, `-inf`; vectors `f32x4(1, 2.5, 0, -1)`,
  `u32x8(...)`; arrays `[1, 2, 3]` (more than 64 elements: the first 64 then `, ... (N more)`); cols `col<f32>[n]`
  with the column's length in this run's snapshot; str as written (escapes decoded).

## Session (`index.ts`)
- `run(source)`: lex, parse, check against the session's env (its fns, globals, the tables, the intrinsics),
  compile, then run top-level statements in order; items of the line are installed in the session only if the WHOLE
  line compiles (a bad line installs nothing). A run-time error keeps the fns and globals declared by the line
  (they compiled) but reports the error. `defined` lists the names.
- `words()` order: KEYWORDS, TYPE_NAMES, table names, INTRINSIC_NAMES, then user fns and globals in definition order.
- Limits (the constructor's and a `run`'s) are made sane before use: a field that is missing or not a finite number
  falls back to the session's (NaN is not "no budget"), negatives become 0, cells are capped at 16,777,216 (64 MiB)
  and depth at 1,048,576; an arena the machine cannot give is "memory exhausted". A host write that calls `run` on
  the same session while a line runs gets `error: "session busy: a host write re-entered run()"` and installs
  nothing. A host `write` that is not an object (null, say) is no write surface: the locked message.
- No `console.log` anywhere. Nothing async.

## What the tests pin (every bullet is at least one test)
lexer: every token kind with positions; separators; suffixes; hex/binary; errors with line:col; comments.
parser: precedence (`1 + 2 * 3`, `a << 1 + 2`, `-x as f32`, `a && b || c`), right structure for if/else-if chains,
for ranges, array literals, query, if-expression, method calls, and every parse error message pinned.
types: adoption rules; every mismatch message; immutability; shadowing; missing return; arity; unknown names;
reserved table names; query scope; col params; vector lanes; `as` rules; value not used; str misuse.
vm: wrap-around i32/u32 (`2147483647 + 1 == -2147483648`), u32 `0u - 1u == 4294967295u`, f32 exactness
(`0.1 + 0.2` prints `0.3` as f32? compute: fround(fround(0.1)+fround(0.2)) = 0.3 (as f32 text "0.3")—pin whatever
f32Text gives and assert it equals the fround arithmetic), division by zero, saturating casts, shifts masked,
vectors lane-wise with select/mask/compare/hsum, morton round trip, popcount/clz/ctz/rot, arrays (fill, literal, by
value in calls), bounds errors, recursion (fib(20) == 6765, ackermann(2,3) == 9), mutual recursion, for/while/loop
with break/continue, nested blocks and shadowing, if-expression, globals across lines and `let mut` reassigned by a
later line, fn redefinition, step budget (an endless loop ends with the named error and the next line works),
output cap, depth cap (unbounded recursion -> "stack overflow (depth 1024)" never a JS RangeError), memory cap
(a huge array), ELITE_LIMITS raise them, `asm` listing non-empty and deterministic.
Tables: a fake host with 10 crowd rows and 3 cars; `query cars where speed > 5.0` equals a hand count; a for loop
over `crowd.n` summing `crowd.x[i]`; `load_f32x4` striding by 4 over 10 rows with zero fill; tables are a snapshot
(mutating the host's arrays after `run` started changes nothing); null host -> EMPTY_TABLES; write intrinsics fail
with the locked message without `host.write`, and call through with it (record the calls), a throwing write becomes
the error.
Turing witness: Rule 110 (a universal cellular automaton) over a 64-cell array for 32 generations, output pinned
against a direct JS implementation in the test; a small tape-machine interpreter written in NoirScript.
Branchless witness: for 1000 seeded triples, `select(mask(a < b), a, b) == min(a, b)` and the f32 form.
Determinism: two sessions fed the same 30 lines print identical output and steps.
fuzz (seeded, >= 2000 cases): random token soup and random grammar-shaped programs never throw out of
`run` (every failure is `error` text), never take more than `limits.steps` steps, and leave the session usable.
airgap: every file in the folder has no import from outside the folder and none of: eval, Function, WebAssembly,
globalThis, window, document, fetch, Date, Math.random, setTimeout, setInterval, import(, localStorage, console.

## Reference examples (session.test.ts runs them line by line on one session)
```
let mut s = 0; for i in 0..10 { s += i * i; } print(s);                      // 285
fn fib(n: i32) -> i32 { if n < 2 { n } else { fib(n - 1) + fib(n - 2) } } print(fib(20));   // 6765
let v = f32x4(1.0, 2.0, 3.0, 4.0); let w = v * splat_f32x4(2.0); print(w, hsum(w));   // f32x4(2, 4, 6, 8) 20
let m = vlt(f32x4(1.0, 5.0, 3.0, 7.0), splat_f32x4(4.0)); print(select(m, splat_f32x4(1.0), splat_f32x4(0.0)));  // f32x4(1, 0, 1, 0)
let near = query cars where speed > 5.0; print(near);
let mut acc = splat_f32x4(0.0); let mut i = 0; while i < crowd.n { acc = acc + load_f32x4(crowd.x, i); i += 4; } print(hsum(acc));
print(morton2(3u, 5u), popcount(0xF0F0u), 7 >> 1, -8 >> 1, (0u - 1u) >> 28);
```
