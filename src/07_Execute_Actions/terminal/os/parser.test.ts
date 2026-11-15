// Copyright (c) 2026 Julian Cassius Subban. All Rights Reserved.
// SPDX-License-Identifier: LicenseRef-CrimsonNoir-Proprietary
// Proprietary core of Crimson Noir OS / Agent City. Not open source; licensed under the terms in LICENSE.
/**
 * Why does this file exist? It holds the shell's reader (parser.ts) to what it promises: every construct read into
 * the tree the shell runs (words and their quoting, the `$` forms, lists, pipelines, the compound commands,
 * redirections and heredocs), the city's own commands read the console's way, `hasOperator` agreeing with the
 * shell about where such a command ends, the `incomplete` flag set exactly when more lines could finish the text,
 * and every nesting refused by name at the cap instead of running the reader out of stack.
 * What breaks if it is removed? A change to the reader could split a word differently, leave the console asking for
 * a line that can never finish a command, or let a deep line end the console's shell, and nothing would say so.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boot } from './kit.test.ts'
import { NO_CITY, ShellSyntax, hasOperator, parse } from './parser.ts'
import type { AndOr, CityNames, Command, List, Pipeline, Redirect, Seg, Word } from './parser.ts'

/** A city of a few commands; `noir` and `say` take the rest of their line whole. */
const CITY: CityNames = {
  has: (name) => ['time', 'laws', 'stats', 'weather', 'goto', 'noir', 'say'].includes(name),
  whole: (name) => name === 'noir' || name === 'say',
}

// A short text for each part of the tree, so that one line of a test says what was read.
// Quoted text is in '...', a quoted expansion in "...", pieces of one word are joined by +, a city command is @name[args].

function seg(s: Seg): string {
  switch (s.t) {
    case 'lit': return s.q ? `'${s.s}'` : s.s
    case 'home': return `HOME(${s.user})`
    case 'var': {
      const body = s.op === '' ? `$${s.name}` : s.op === 'len' ? `\${#${s.name}}` : `\${${s.name}${s.op}${word(s.arg ?? [])}}`
      return s.q ? `"${body}"` : body
    }
    case 'cmd': return s.q ? `"$(${list(s.body)})"` : `$(${list(s.body)})`
    case 'sum': {
      const body = `$((${s.text.map((p) => (p.t === 'lit' ? p.s : seg(p))).join('')}))`
      return s.q ? `"${body}"` : body
    }
  }
}

const word = (w: Word): string => w.map(seg).join('+')

const redirect = (r: Redirect): string => `${r.fd}${r.op}${word(r.word)}`

const after = (rs: readonly Redirect[]): string => rs.map((r) => ` ${redirect(r)}`).join('')

function command(c: Command): string {
  switch (c.t) {
    case 'simple': return [...c.assigns.map((a) => `${a.name}=${word(a.value)}`), ...c.words.map(word), ...c.redirects.map(redirect)].join(' ')
    case 'city': return `@${c.name}${JSON.stringify(c.args)}${after(c.redirects)}`
    case 'if': {
      const clauses = c.clauses.map((k, i) => `${i === 0 ? 'if' : 'elif'} ${list(k.cond)} then ${list(k.then)}`).join(' ')
      return `${clauses}${c.otherwise === null ? '' : ` else ${list(c.otherwise)}`} fi${after(c.redirects)}`
    }
    case 'loop': return `${c.until ? 'until' : 'while'} ${list(c.cond)} do ${list(c.body)} done${after(c.redirects)}`
    case 'for': return `for ${c.name}${c.words === null ? '' : ` in${c.words.map((w) => ` ${word(w)}`).join('')}`} do ${list(c.body)} done${after(c.redirects)}`
    case 'group': return `{ ${list(c.body)} }${after(c.redirects)}`
  }
}

const pipeline = (p: Pipeline): string => `${p.negate ? '! ' : ''}${p.cmds.map(command).join(' | ')}`

const andOr = (a: AndOr): string => `${pipeline(a.first)}${a.rest.map((r) => ` ${r.op} ${pipeline(r.cmd)}`).join('')}`

function list(l: List): string {
  return l.items.map((it) => `${andOr(it.cmd)}${it.bg ? ' &' : ''}`).join('; ')
}

const show = (src: string, city: CityNames = NO_CITY): string => list(parse(src, city))

/** What the reader refuses `src` with, or null when it reads it. Anything thrown but a ShellSyntax fails the test. */
function refusal(src: string, city: CityNames = NO_CITY): { message: string; incomplete: boolean } | null {
  try {
    parse(src, city)
    return null
  } catch (e) {
    if (e instanceof ShellSyntax) return { message: e.message, incomplete: e.incomplete }
    throw e
  }
}

/** The one command of a one-command script. */
function only(src: string, city: CityNames = NO_CITY): Command {
  const l = parse(src, city)
  assert.equal(l.items.length, 1, src)
  const item = l.items[0]
  assert.equal(item.cmd.rest.length, 0, src)
  assert.equal(item.cmd.first.cmds.length, 1, src)
  return item.cmd.first.cmds[0]
}

/** The words of a one-command script's simple command. */
function wordsOf(src: string): readonly Word[] {
  const c = only(src)
  assert.ok(c.t === 'simple', src)
  return c.words
}

/** The redirections of every simple command, in order, through the whole tree. */
function redirectsOf(l: List): Redirect[] {
  const out: Redirect[] = []
  const walkWord = (w: Word): void => {
    for (const s of w) {
      if (s.t === 'cmd') walkList(s.body)
      else if (s.t === 'var' && s.arg !== null) walkWord(s.arg)
    }
  }
  const walkCmd = (c: Command): void => {
    if (c.t === 'simple') c.words.forEach(walkWord)
    if (c.t === 'if') for (const k of c.clauses) { walkList(k.cond); walkList(k.then) }
    if (c.t === 'if' && c.otherwise !== null) walkList(c.otherwise)
    if (c.t === 'loop') { walkList(c.cond); walkList(c.body) }
    if (c.t === 'for' || c.t === 'group') walkList(c.body)
    out.push(...c.redirects)
  }
  const walkList = (x: List): void => {
    for (const it of x.items) for (const p of [it.cmd.first, ...it.cmd.rest.map((r) => r.cmd)]) p.cmds.forEach(walkCmd)
  }
  walkList(l)
  return out
}

const lit = (s: string, q = true): Seg => ({ t: 'lit', s, q })

/** A small, fixed sequence of numbers, so that generated lines are the same on every run. */
function sequence(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x
  }
}

/** The console's own splitting of a line into words (commands.ts tokenize): null while a quote is open. */
function consoleWords(line: string): string[] | null {
  const words: string[] = []
  let cur = ''
  let inWord = false
  let quote = ''
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote === "'") {
      if (c === "'") quote = ''
      else cur += c
    } else if (quote === '"') {
      if (c === '"') quote = ''
      else if (c === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) cur += line[++i]
      else cur += c
    } else if (c === "'" || c === '"') {
      quote = c
      inWord = true
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i]
      inWord = true
    } else if (c === ' ' || c === '\t' || c === '\n') {
      if (inWord) words.push(cur)
      cur = ''
      inWord = false
    } else {
      cur += c
      inWord = true
    }
  }
  if (quote !== '') return null
  if (inWord) words.push(cur)
  return words
}

/** Whether the shell would run `line` as the console does: one city command, alone, with the console's own words. */
function sameAsConsole(line: string): boolean {
  const words = consoleWords(line)
  if (words === null) return false
  let l: List
  try {
    l = parse(line, CITY)
  } catch (e) {
    if (e instanceof ShellSyntax) return false
    throw e
  }
  if (l.items.length !== 1 || l.items[0].bg) return false
  const a = l.items[0].cmd
  if (a.rest.length !== 0 || a.first.negate || a.first.cmds.length !== 1) return false
  const c = a.first.cmds[0]
  return c.t === 'city' && c.redirects.length === 0 && JSON.stringify(c.args) === JSON.stringify(words.slice(1))
}

// Words.

test('words: blanks split them, quotes and backslashes join them, and nothing is expanded while reading', () => {
  assert.equal(show('echo  a\tb'), 'echo a b')
  assert.equal(show(`echo 'a b' "c d" e\\ f`), "echo 'a b' 'c d' e+' '+f")
  assert.equal(show(`echo a"b"'c'd`), "echo a+'b'+'c'+d")
  // An empty pair of quotes is still a word.
  assert.equal(show(`echo "" ''`), "echo '' ''")
  assert.equal(wordsOf(`echo ""`).length, 2)
  // Inside "...", a backslash escapes only $ " and \ ; before anything else it stays.
  assert.equal(show(`echo "\\$x \\" \\\\ \\a"`), `echo '$x " \\ \\a'`)
  // Single quotes keep everything, a backslash and a $ included.
  assert.equal(show(`echo '\\$x "'`), `echo '\\$x "'`)
  // A backslash at a line end joins the lines, inside a word, between words and inside "...".
  assert.equal(show('ec\\\nho a'), 'echo a')
  assert.equal(show('echo a \\\n b'), 'echo a b')
  assert.equal(show('echo "a\\\nb"'), "echo 'ab'")
  // # starts a comment only at the start of a word; odd bytes are only characters.
  assert.equal(show('echo a#b'), 'echo a#b')
  assert.equal(show('echo \u00e9 \u0001 \u2603 \u0000x'), 'echo \u00e9 \u0001 \u2603 \u0000x')
  assert.equal(show('echo \r'), 'echo \r')
})

test('nothing to read: an empty script, blanks, line ends and comments are an empty list', () => {
  for (const src of ['', '   ', '\t', '\n\n\n', '# only a comment', '  # one\n# two\n', ' \\\n ']) assert.deepEqual(parse(src).items, [], JSON.stringify(src))
})

test('$ forms: names, the special parameters, and a $ that stands for itself', () => {
  assert.equal(show('echo $x $x_1 ${x} $1 $10 $? $$ $# $@ $* $- $! $0'), 'echo $x $x_1 $x $1 $1+0 $? $$ $# $@ $* $- $! $0')
  assert.equal(show('echo $ a$ $. "$" $/ $%'), "echo $ a$ $. '$' $/ $%")
  assert.equal(show('echo "$x" "a $x b" a$x'), `echo "$x" 'a '+"$x"+' b' a+$x`)
  assert.equal(show('echo $x$y'), 'echo $x+$y')
})

test('${ } forms: every operator, the length, and a word inside that keeps its own quoting', () => {
  for (const op of [':-', '-', ':=', '=', ':+', '+', ':?', '?', '%', '%%', '#', '##']) {
    assert.equal(show(`echo \${x${op}w}`), `echo \${x${op}w}`, op)
    assert.equal(show(`echo "\${x${op}w}"`), `echo "\${x${op}'w'}"`, op)
  }
  assert.equal(show('echo ${#x} ${#} ${#?} ${#1} ${?} ${1}'), 'echo ${#x} $# ${#?} ${#1} $? $1')
  assert.equal(show('echo ${x:-a b} ${x:-} ${x#*.} ${x##*/} ${x%.*}'), 'echo ${x:-a b} ${x:-} ${x#*.} ${x##*/} ${x%.*}')
  assert.equal(show("echo ${x:-'a b'} ${x%\"a\"}"), "echo ${x:-'a b'} ${x%'a'}")
  // Inside "...", a single quote in the word is a character.
  assert.equal(show(`echo "\${x:-'a'}"`), `echo "\${x:-''a''}"`)
  assert.equal(show('echo ${x:-"a $y"} ${x:-\\}}'), `echo \${x:-'a '+"$y"} \${x:-'}'}`)
  assert.equal(show('echo ${x:-${y:-$(echo z)}}'), 'echo ${x:-${y:-$(echo z)}}')
  for (const src of ['echo ${}', 'echo ${x!}', 'echo ${ x}', 'echo ${-x}', 'echo ${x:}', 'echo ${#x!}', 'echo ${&}']) {
    assert.deepEqual(refusal(src), { message: 'bad substitution', incomplete: false }, src)
  }
})

test('$( ) and $(( )): a list inside, nesting, and a ) inside quotes or a comment', () => {
  assert.equal(show('echo $(a | b; c)'), 'echo $(a | b; c)')
  assert.equal(show('echo "$(a "b c")"'), `echo "$(a 'b c')"`)
  assert.equal(show('echo $(echo ")") $(echo \\))'), "echo $(echo ')') $(echo ')')")
  assert.equal(show('echo $(echo a # not ) here\n)'), 'echo $(echo a)')
  assert.equal(show('x=$(\n a\n b\n)'), 'x=$(a; b)')
  assert.equal(show('echo $(echo $(echo $(echo deep)))'), 'echo $(echo $(echo $(echo deep)))')
  assert.equal(show('echo $((1 + $x * (2 - y))) "$((2*3))" $(( (1) ))'), `echo $((1 + "$x" * (2 - y))) "$((2*3))" $(( (1) ))`)
  assert.equal(show('echo $(( $((1)) + ${x:-2} ))'), `echo $(( "$((1))" + "\${x:-'2'}" ))`)
  assert.deepEqual(refusal('echo $((1)'), { message: "'$((' has no '))'", incomplete: false })
  assert.deepEqual(refusal('echo $((1) )'), { message: "'$((' has no '))'", incomplete: false })
  assert.deepEqual(refusal('echo $(a))'), { message: "unexpected ')'", incomplete: false })
})

test('~ at the start of a word, and after the = of an assignment', () => {
  assert.equal(show('echo ~ ~/a ~op/b a~ ~+ "~" \\~ ~a-b'), "echo HOME() HOME()+/a HOME(op)+/b a~ ~+ '~' '~' ~a-b")
  assert.equal(show('x=~/a y=a:~/b cmd ~'), 'x=HOME()+/a y=a:~/b cmd HOME()')
  assert.equal(show('echo ~|cat'), 'echo HOME() | cat')
})

// Lists and compound commands.

test('lists, pipelines and and-or chains: what joins what, and the text of each item', () => {
  assert.equal(show('a | b | c && d || e; f & g'), 'a | b | c && d || e; f &; g')
  assert.equal(show('a&&b||c'), 'a && b || c')
  assert.equal(show('a;b&c'), 'a; b &; c')
  assert.equal(show('! a | b'), '! a | b')
  assert.equal(show('a |\n b'), 'a | b')
  assert.equal(show('a &&\n\n b ||\n c'), 'a && b || c')
  assert.equal(show('a\nb\n\nc;'), 'a; b; c')
  assert.equal(show('x=1 y=$z'), 'x=1 y=$z')
  assert.equal(show('x= cmd'), 'x= cmd')
  assert.deepEqual(parse('a | b ;  c &  d').items.map((i) => i.text), ['a | b', 'c', 'd'])
  assert.deepEqual(parse('a | b ;  c &').items.map((i) => i.bg), [false, true])
  for (const [src, message] of [['| a', "unexpected '|'"], ['a | | b', "unexpected '|'"], ['a ;; b', "unexpected ';'"], [';', "unexpected ';'"],
    ['&', "unexpected '&'"],
    ['a & & b', "unexpected '&'"], ['a &&& b', "unexpected '&'"], ['a || || b', "unexpected '|'"], [')', "unexpected ')'"], ['echo a)', "unexpected ')'"],
    ['echo a(b)', "unexpected '('"], ['(a)', "unexpected '('"]]) {
    assert.deepEqual(refusal(src), { message, incomplete: false }, src)
  }
})

test('if, while, until, for and { }, in every layout, with reserved words read only where a command starts', () => {
  assert.equal(show('if a; then b; elif c; then d; else e; fi'), 'if a then b elif c then d else e fi')
  assert.equal(show('if a\nthen\n  b\nfi'), 'if a then b fi')
  assert.equal(show('if a; b; then c; d; fi'), 'if a; b then c; d fi')
  assert.equal(show('while a; do b; done'), 'while a do b done')
  assert.equal(show('until a; do b; done'), 'until a do b done')
  assert.equal(show('while a\ndo\nb\ndone'), 'while a do b done')
  assert.equal(show('for x in a "b c" $y; do echo $x; done'), "for x in a 'b c' $y do echo $x done")
  assert.equal(show('for x; do b; done'), 'for x do b done')
  assert.equal(show('for x do b; done'), 'for x do b done')
  assert.equal(show('for x\ndo b\ndone'), 'for x do b done')
  assert.equal(show('for x\nin a b\ndo b; done'), 'for x in a b do b done')
  assert.equal(show('for x in; do b; done'), 'for x in do b done')
  assert.equal(show('for x in a b # note\ndo b; done'), 'for x in a b do b done')
  assert.equal(show('{ a; b; } > f'), '{ a; b } 1>f')
  assert.equal(show('if a; then while b; do for i in 1 2; do { c; }; done; done; fi > out 2>&1 | wc'),
    'if a then while b do for i in 1 2 do { c } done done fi 1>out 2>&1 | wc')
  assert.equal(show('echo if then else elif fi do done for in { } !'), 'echo if then else elif fi do done for in { } !')
  assert.equal(show('if a; then echo fi; fi'), 'if a then echo fi fi')
  for (const [src, message] of [['fi', "unexpected 'fi'"], ['then', "unexpected 'then'"], ['done', "unexpected 'done'"], ['do x', "unexpected 'do'"],
    ['}', "unexpected '}'"], ['else', "unexpected 'else'"], ['in', "unexpected 'in'"], ['if then b; fi', "'if' needs a command before 'then'"],
    ['while do b; done', "'while' needs a command before 'do'"], ['for 1 in a; do b; done', "'for' needs a variable name"],
    ['for x-y in a; do b; done', "'for' needs 'do'"], ['if a; then b; fi c', "unexpected 'c'"], ['{ a; } b', "unexpected 'b'"],
    ['if a; then b; done', "unexpected 'done'"], ['while a; do b; fi', "unexpected 'fi'"], ['{echo a; }', "unexpected '}'"]]) {
    assert.deepEqual(refusal(src), { message, incomplete: false }, src)
  }
})

test('redirections: every operator, a descriptor before it, a name after it', () => {
  assert.equal(show('a < in > out >> log 2> err 2>&1 <&3 >&2'), 'a 0<in 1>out 1>>log 2>err 2>&1 0<&3 1>&2')
  assert.equal(show('a <in >out 2>>e'), 'a 0<in 1>out 2>>e')
  assert.equal(show('a2>f'), 'a2 1>f')
  assert.equal(show('a 12>f'), 'a 12 1>f')
  assert.equal(show('> f'), '1>f')
  assert.equal(show('> f a'), 'a 1>f')
  assert.equal(show('a > "$x y" 2>&-'), `a 1>"$x"+' y' 2>&-`)
  assert.equal(show('x=1 > f'), 'x=1 1>f')
  for (const src of ['a >', 'a > | b', 'a <>', 'a >;', 'a 2>&', 'cat <<', 'cat << ;']) {
    const r = refusal(src)
    assert.ok(r !== null && /needs a name after it$/.test(r.message) && !r.incomplete, `${src}: ${JSON.stringify(r)}`)
  }
})

test('heredocs: the text after the line end, expanded unless the marker was quoted, tabs dropped by <<-', () => {
  const here = (src: string, city: CityNames = NO_CITY): (Word | null)[] => redirectsOf(parse(src, city)).map((r) => r.here)
  assert.deepEqual(here('cat <<E\nhello $x\n\\$y \\\\ \\a\nE'), [[lit('hello '), { t: 'var', name: 'x', op: '', arg: null, q: true }, lit('\n$y \\ \\a\n')]])
  for (const marker of ["'E'", '"E"', '\\E', "E''", 'E"" ']) assert.deepEqual(here(`cat <<${marker}\n$x \\$\nE`), [[lit('$x \\$\n')]], marker)
  assert.deepEqual(here('cat <<-E\n\t\ta\n  b\n\tE'), [[lit('a\n  b\n')]])
  assert.deepEqual(here('cat <<E\n\tE\nE'), [[lit('\tE\n')]])
  assert.deepEqual(here('cat <<A; cat <<B\na\nA\nb\nB'), [[lit('a\n')], [lit('b\n')]])
  assert.deepEqual(here('cat <<A <<B\na\nA\nb\nB'), [[lit('a\n')], [lit('b\n')]])
  assert.deepEqual(here('cat <<E\nE \n E\nE'), [[lit('E \n E\n')]])
  assert.deepEqual(here('cat <<E\na\\\nb\nE'), [[lit('ab\n')]])
  assert.deepEqual(here('cat <<E\nE'), [[]])
  assert.deepEqual(here("cat <<'E'\nE"), [[lit('')]])
  // Inside $( ), after the $( ) closed on the line, inside an if: the text still comes after the line end.
  assert.deepEqual(here('echo $(cat <<E\nin\nE\n)'), [[lit('in\n')]])
  assert.deepEqual(here('echo $(cat <<E) after\nbody\nE'), [[lit('body\n')]])
  assert.deepEqual(here('if true; then cat <<E; fi\nx\nE'), [[lit('x\n')]])
  assert.equal(show('cat <<E file\nx\nE\necho next'), 'cat file 0<<E; echo next')
  // A command inside the text is read as it would be anywhere else, a city command too.
  const inner = here('cat <<E\n$(noir print(1))\nE', CITY)[0]
  assert.ok(inner !== null && inner[0].t === 'cmd', JSON.stringify(inner))
  assert.equal(inner[0].t === 'cmd' ? list(inner[0].body) : '', '@noir["print(1)"]')
  assert.deepEqual(refusal('cat <<$x\nx\n$x'), { message: 'a heredoc marker must be plain text', incomplete: false })
  assert.deepEqual(refusal('cat <<E\nlast line'), { message: "heredoc 'E' has no end", incomplete: true })
  assert.deepEqual(refusal('cat <<E'), { message: "heredoc 'E' has no text", incomplete: true })
})

test('comments: from a # at the start of a word to the line end, and nowhere else', () => {
  assert.equal(show('echo a # b | c'), 'echo a')
  assert.equal(show('# x\necho a # y\necho b'), 'echo a; echo b')
  assert.equal(show(`echo a#b '#c' "#d" \\#e`), "echo a#b '#c' '#d' '#'+e")
  assert.equal(show('echo $(a # )\n)'), 'echo $(a)')
  assert.equal(show('echo a;# b\necho c'), 'echo a; echo c')
})

// The city's own commands.

test('a city command keeps the console\'s own reading: quotes removed, nothing expanded, blanks the only split', () => {
  assert.equal(show('time 18:30', CITY), '@time["18:30"]')
  assert.equal(show('goto ~/# a&b x|y a;b "a b" \'c\' d\\ e $HOME >f 2>x', CITY), '@goto["~/#","a&b","x|y","a;b","a b","c","d e","$HOME",">f","2>x"]')
  assert.equal(show('time a ) b ( # note', CITY), '@time["a",")","b","(","#","note"]')
  assert.equal(show('time "|" \'&&\' \\; ";" a\\;', CITY), '@time["|","&&",";",";","a;"]')
  assert.equal(show('time "a\nb"', CITY), '@time["a\\nb"]')
  // It ends at an operator that stands alone, at a ; that ends a word, and at a line end.
  assert.equal(show('time a | grep x', CITY), '@time["a"] | grep x')
  assert.equal(show('time a && b || c', CITY), '@time["a"] && b || c')
  assert.equal(show('time a; b', CITY), '@time["a"]; b')
  assert.equal(show('time a;', CITY), '@time["a"]')
  assert.equal(show('time ;', CITY), '@time[]')
  assert.equal(show('time a & b', CITY), '@time["a"] &; b')
  assert.equal(show('time a\nb', CITY), '@time["a"]; b')
  assert.equal(show('time a > f b 2>&1', CITY), '@time["a","b"] 1>f 2>&1')
  assert.equal(show('time >> "a b"', CITY), '@time[] 1>>\'a b\'')
  assert.equal(show('a | time x&y | laws', CITY), 'a | @time["x&y"] | @laws[]')
  assert.equal(show('if time; then laws a; fi', CITY), 'if @time[] then @laws["a"] fi')
  // One that takes its line whole takes all of it, operators and all, up to the line end.
  assert.equal(show('noir print(1) | x; y && "z', CITY), '@noir["print(1) | x; y && \\"z"]')
  assert.equal(show('noir   ', CITY), '@noir[]')
  assert.equal(show('noir a\nb', CITY), '@noir["a"]; b')
  assert.equal(show('say agent: it\'s "here" & now', CITY), '@say["agent: it\'s \\"here\\" & now"]')
  // Inside $( ) each ends at the ) that closes the substitution.
  assert.equal(show('echo $(time a b) $(noir f(1) + (2)) "$(time ")" x)" $(time a;)', CITY),
    'echo $(@time["a","b"]) $(@noir["f(1) + (2)"]) "$(@time[")","x"])" $(@time["a"])')
  assert.equal(show('echo $(noir ")" \')\' \\) (x))', CITY), 'echo $(@noir["\\")\\" \')\' \\\\) (x)"])')
  // Not a city command: a quoted or escaped name, a name after an assignment, a name that is an argument.
  assert.equal(show('"time" a|b', CITY), "'time' a | b")
  assert.equal(show('\\time a', CITY), "'t'+ime a")
  assert.equal(show('X=1 time a|b', CITY), 'X=1 time a | b')
  assert.equal(show('echo time a|b', CITY), 'echo time a | b')
  assert.equal(show('time a|b'), 'time a | b')
  // The line, as typed, for the handler that wants it.
  const c = only('time  a  "b c" > f', CITY)
  assert.ok(c.t === 'city')
  assert.equal(c.line, 'time  a  "b c"')
  const w = only('  noir x  y  ', CITY)
  assert.ok(w.t === 'city')
  assert.deepEqual([w.args, w.line], [['x  y'], 'noir x  y'])
  assert.deepEqual(refusal('time "a', CITY), { message: 'a quote is left open', incomplete: true })
  assert.deepEqual(refusal('time a > | b', CITY), { message: "'>' needs a name after it", incomplete: false })
})

test('hasOperator: an operator standing alone after the first word, a word ending in ;, or a second line', () => {
  const cases: [string, boolean][] = [
    ['time', false], ['time 18:30', false], ['  time  a  b  ', false], ['', false], ['   ', false],
    ['time | grep x', true], ['time || x', true], ['time && x', true], ['time ; x', true], ['time &', true], ['time a;', true], ['time ;;', true],
    ['time > f', true], ['time >> f', true], ['time < f', true], ['time 2> f', true], ['time 2>&1', true], ['time >&2', true], ['time 1>>f x', false],
    ['time 1>> f', true], ['time\t|\tx', true],
    ['goto ~/#', false], ['goto a&b', false], ['goto x|y', false], ['time a;b', false], ['time >f', false], ['time "|"', false], ["time '&&'", false],
    ['time \\|', false], ['time ";"', false], ['time a\\;', false], ["time 'a';", false], ['time <<E', false], ['time <&0', false], ['time >&x', false],
    ['time # | x', true], ['time "a | b', false], ['time | "a', true], ["time 'a b' | c", true],
    ['time\nx', true], ['time a\n', false], ['time\n\n  ', false], ['time "a\nb"', false], ['\ntime a', false], ['time a \\\nb', false],
    ['time a\n# note', true],
  ]
  for (const [line, want] of cases) assert.equal(hasOperator(line), want, JSON.stringify(line))
})

test('hasOperator agrees with the shell: false exactly when the shell would run the console command as the console does', () => {
  const pieces = ['a', '18:30', '~/#', 'a&b', 'x|y', 'a;b', '>f', '|', '||', '&&', ';', '&', '>', '>>', '<', '2>', '2>&1', '>&2', 'a;', ';;', '"|"', "'&&'",
    '\\;', '"a b"', "'c d'", '#', '(', ')', '$(x)', '$HOME', '""', '"a"b', '<<', 'x=1', '{', '}', 'if', '!', 'f', '\\', '"a\\"b"', 'a\\ b']
  const gaps = [' ', ' ', ' ', '  ', '\t', '\n', ' \\\n ']
  const next = sequence(20261115)
  const names = ['time', 'laws', 'stats', 'weather', 'goto']
  let differ = 0
  for (let n = 0; n < 4000; n++) {
    let line = names[next() % names.length]
    const count = next() % 6
    for (let i = 0; i < count; i++) line += gaps[next() % gaps.length] + pieces[next() % pieces.length]
    if (next() % 4 === 0) line += gaps[next() % gaps.length]
    const shell = !sameAsConsole(line)
    if (shell) differ++
    assert.equal(hasOperator(line), shell, JSON.stringify(line))
  }
  // The lines tried cover both answers well.
  assert.ok(differ > 1000 && differ < 3000, String(differ))
})

// The incomplete flag.

test('incomplete: set on every unfinished form, and the next line can finish each one', () => {
  const unfinished: [string, string, CityNames?][] = [
    ["echo 'a", "b'"], ['echo "a', 'b"'], ['echo a\\', 'b'], ['echo "a\\', 'b"'], ['echo $(a', ')'], ['echo $(a |', 'b)'], ['echo "$(a', ')"'],
    ['echo $((1 +', '2))'], ['echo $(( (1', ') ))'], ['echo ${x:-a', '}'], ["echo ${x:-'a", "'}"], ['echo "${x:-"a', '"}"'], ['echo ${x:-$(a', ')}'],
    ['if a', 'then b; fi'], ['if a; then', 'b; fi'], ['if a; then b', 'fi'], ['if a; then b; else', 'c; fi'],
    ['if a; then b; elif c', 'then d; fi'], ['if', 'a; then b; fi'],
    ['while', 'a; do b; done'], ['while a', 'do b; done'], ['while a; do b', 'done'], ['until a; do', 'b; done'],
    ['for x', 'do b; done'], ['for x in a b', 'do echo; done'], ['for x in a; do', 'b; done'], ['for x in \\', 'a b; do c; done'],
    ['{', 'a; }'], ['{ a;', '}'], ['a |', 'b'], ['a &&', 'b'], ['a ||', 'b'], ['a | \\', 'b'], ['echo a \\', 'b'], ['echo > \\', 'f'],
    ['cat <<E', 'text\nE'], ['cat <<E\ntext', 'E'], ['cat <<A <<B\na\nA', 'b\nB'], ['echo $(cat <<E)', 'x\nE'],
    ['time "a', 'b"', CITY], ['echo $(time "a', 'b")', CITY], ['echo $(noir f(1)', ')', CITY], ['echo $(time a', ')', CITY],
    // A backslash at the very end asks for the next line wherever it stands.
    ['for x \\', 'in a; do b; done'], ['if a; then b; fi \\', '> f'], ['{ a; } \\', '2>&1'], ['! \\', 'a'], ['while a; do b; done \\', '| c'], ['a; \\', 'b'],
  ]
  for (const [src, more, city] of unfinished) {
    const r = refusal(src, city)
    assert.ok(r !== null && r.incomplete, `${JSON.stringify(src)}: ${JSON.stringify(r)}`)
    assert.equal(refusal(`${src}\n${more}`, city), null, `${JSON.stringify(src)} + ${JSON.stringify(more)}`)
  }
})

test('incomplete: never set on a form no further line could finish', () => {
  const finished: [string, CityNames?][] = [
    ['echo >'], ['cat <<'], ['echo 2>&'], ['for'], ['for 1'], ['!'], ['! # c'], ['echo ${'], ['echo ${x'], ['echo ${#'], ['echo ${#x'],
    ['echo "${x'], ['echo ${x!}'],
    ['echo $((1)'], ['fi'], ['a | | b'], ['a ;; b'], ['if then b; fi'], [')'], ['echo a)'], ['a & & b'], ['echo a(b'],
    ['time >', CITY], ['time a > ;', CITY],
    // Heredoc text is read once its marker line is found: no later line can finish what is open inside it.
    ['cat <<E\n$(echo\nE'], ['cat <<E\n${x:-a\nE'], ['cat <<E\n$((1 +\nE'], ['cat <<E\n$(echo "a\nE'], ['cat <<E\n$(echo\nE\necho more'],
  ]
  for (const [src, city] of finished) {
    const r = refusal(src, city)
    assert.ok(r !== null && !r.incomplete, `${JSON.stringify(src)}: ${JSON.stringify(r)}`)
    // And a further line does not help.
    for (const more of ['x', '}', ')', 'fi', 'done', 'E']) assert.notEqual(refusal(`${src}\n${more}`, city), null, `${JSON.stringify(src)} + ${more}`)
  }
})

// Nesting and size.

/** `open` n times, then `middle`, then `close` n times. */
const nest = (open: string, middle: string, close: string, n: number): string => open.repeat(n) + middle + close.repeat(n)

test('nesting: 64 levels of any form are read, the 65th is refused by name, and 100000 never run the reader out of stack', () => {
  const forms: [string, string, string][] = [
    ['echo $(', 'x', ')'], ['echo "$(', 'x', ')"'], ['echo $(( $((', '1', ')) ))'], ['if a; then ', 'b', '; fi'], ['while a; do ', 'b', '; done'],
    ['until a; do ', 'b', '; done'], ['for i in 1; do ', 'b', '; done'], ['{ ', 'b', '; }'], ['echo ${x:-', 'y', '}'], ['echo "${x:-"', 'y', '"}"'],
    ['echo ${x:-$(', 'y', ')}'], ['if a; then { ', 'b', '; }; fi'],
  ]
  for (const [open, middle, close] of forms) {
    // Each form below opens one level per repeat, except the pairs ($(( $(( and if-then-{) that open two.
    const per = open.includes('$(( $((') || open.includes('then {') || open.includes('${x:-$(') ? 2 : 1
    const ok = Math.floor(64 / per)
    assert.equal(refusal(nest(open, middle, close, ok)), null, `${open} x ${ok}`)
    assert.deepEqual(refusal(nest(open, middle, close, ok + 1)), { message: 'nested too deep', incomplete: false }, `${open} x ${ok + 1}`)
    assert.deepEqual(refusal(nest(open, middle, close, 100000)), { message: 'nested too deep', incomplete: false }, `${open} x 100000`)
  }
  // Mixed forms count together.
  assert.deepEqual(refusal(nest('echo $(', nest('if a; then ', 'b', '; fi', 33), ')', 32)), { message: 'nested too deep', incomplete: false })
  assert.equal(refusal(nest('echo $(', nest('if a; then ', 'b', '; fi', 32), ')', 32)), null)
})

test('nesting: a heredoc inside $( ) inside a heredoc counts toward the same cap', () => {
  const heredocs = (levels: number): string => {
    let s = 'cat <<M0\n'
    for (let i = 1; i <= levels; i++) s += `$(cat <<M${i}\n`
    s += 'x\n'
    for (let i = levels; i >= 1; i--) s += `M${i}\n)\n`
    return `${s}M0\n`
  }
  assert.equal(refusal(heredocs(64)), null)
  assert.deepEqual(refusal(heredocs(65)), { message: 'nested too deep', incomplete: false })
  assert.deepEqual(refusal(heredocs(5000)), { message: 'nested too deep', incomplete: false })
})

test('size: lines of 100000 characters, thousands of pipes, ands and items are read whole and in one pass', () => {
  const big = 'a'.repeat(100000)
  assert.equal(show(`echo ${big}`), `echo ${big}`)
  assert.equal(wordsOf(`echo ${'a '.repeat(50000)}`).length, 50001)
  assert.equal(show(`echo "${big}"`), `echo '${big}'`)
  assert.deepEqual(wordsOf(`echo ${'\\\\'.repeat(50000)}`)[1], Array(50000).fill(lit('\\')))
  assert.deepEqual(refusal(`echo ${'a '.repeat(50000)}"`), { message: 'a quote is left open', incomplete: true })
  assert.deepEqual(refusal(`echo ${big}'`), { message: 'a quote is left open', incomplete: true })
  const pipes = parse(Array(10000).fill('a').join(' | '))
  assert.equal(pipes.items[0].cmd.first.cmds.length, 10000)
  assert.equal(parse(Array(10000).fill('a').join(' && ')).items[0].cmd.rest.length, 9999)
  assert.equal(parse(Array(10000).fill('a').join('; ')).items.length, 10000)
  assert.equal(parse(Array(10000).fill('a &').join(' ')).items.length, 10000)
  assert.equal(parse(Array(10000).fill('a').join('\n')).items.length, 10000)
  assert.equal(parse(`${'! '.repeat(10000)}a`).items[0].cmd.first.negate, true)
  assert.deepEqual(refusal('('.repeat(100000)), { message: "unexpected '('", incomplete: false })
  assert.deepEqual(refusal(')'.repeat(100000)), { message: "unexpected ')'", incomplete: false })
  assert.deepEqual(refusal('|'.repeat(100000)), { message: "unexpected '|'", incomplete: false })
  assert.equal(parse(`echo ${'$'.repeat(100000)}`).items.length, 1)
  assert.equal(parse(`# ${big}\necho a`).items.length, 1)
  // Two thousand heredocs on one line, their texts after it.
  const docs = parse(`${Array(2000).fill('cat <<E').join('; ')}\n${Array(2000).fill('t\nE').join('\n')}`)
  assert.equal(docs.items.length, 2000)
  assert.ok(redirectsOf(docs).every((r) => r.here !== null && r.here.length === 1))
  // A city command with a long line, and hasOperator over it.
  const cityLine = `time ${'a '.repeat(50000)}`
  const c = only(cityLine, CITY)
  assert.equal(c.t === 'city' ? c.args.length : 0, 50000)
  assert.equal(hasOperator(cityLine), false)
  assert.equal(hasOperator(`${cityLine}a|`), false)
  assert.equal(hasOperator(`${cityLine}| x`), true)
  assert.equal(only(`noir ${big}`, CITY).t, 'city')
  assert.equal(hasOperator(`time ${'"a'.repeat(30000)}`), false)
})

test('quotes left open at every position: the answer is "incomplete", never a crash', () => {
  for (const [line, city] of [['echo a b | wc -l && ls x; cat f > g &', NO_CITY], ['time a b | wc -l; laws x', CITY]] as const) {
    for (let k = 0; k <= line.length; k++) {
      for (const q of ["'", '"']) {
        const src = line.slice(0, k) + q + line.slice(k)
        assert.deepEqual(refusal(src, city), { message: 'a quote is left open', incomplete: true }, src)
        assert.equal(typeof hasOperator(src), 'boolean')
      }
    }
  }
  // Every cut of a script that uses everything is read or refused by name.
  const script = 'x=$(printf \'%s\' "$y") ; for i in 1 2; do echo ${i:-\'z\'} "$((i + 1))" | wc > f 2>&1; done && if a; then { b; }; fi\n' +
    'cat <<-E\n\tbody $x\n\tE\n! time a;b | laws\nnoir go(1)'
  for (let k = 0; k <= script.length; k++) {
    refusal(script.slice(0, k), CITY)
    hasOperator(script.slice(0, k))
  }
  assert.equal(refusal(script, CITY), null)
})

// At the prompt.

test('at the prompt: a line nested too deep is refused, and the shell goes on with its variables', () => {
  const k = boot({})
  assert.deepEqual(k.sh('x=kept'), [])
  // Each line stays under the 64 KiB the shell reads of a typed line at once.
  assert.deepEqual(k.sh(`echo ${nest('${x:-', 'y', '}', 10000)}`), ['!ash: syntax error: nested too deep'])
  assert.deepEqual(k.sh(`echo ${nest('$(echo ', 'y', ')', 8000)}`), ['!ash: syntax error: nested too deep'])
  assert.deepEqual(k.sh('echo $x'), ['kept'])
})

test('at the prompt: an unfinished line asks for more, a line no more could finish is refused at once', () => {
  const k = boot({})
  assert.deepEqual(k.sh('if true'), [])
  assert.equal(k.system.atPrompt, false)
  assert.deepEqual(k.sh('then echo yes'), [])
  assert.deepEqual(k.sh('fi'), ['yes'])
  assert.deepEqual(k.sh('for x \\'), [])
  assert.deepEqual(k.sh('in a b; do echo $x; done'), ['a', 'b'])
  assert.deepEqual(k.sh('echo >'), ["!ash: syntax error: '>' needs a name after it"])
  assert.equal(k.system.atPrompt, true)
  assert.deepEqual(k.sh('cat <<E\n$(echo\nE'), ["!ash: syntax error: '$(' has no ')'"])
  assert.equal(k.system.atPrompt, true)
  assert.deepEqual(k.sh('echo ${x'), ['!ash: syntax error: bad substitution'])
  assert.deepEqual(k.sh('echo still here'), ['still here'])
})
