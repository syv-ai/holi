/**
 * The language inside a markdown fence.
 *
 * ````
 * ```python
 * def f(): ...
 * ```
 * ````
 *
 * `markdown()` parses a fence's body as **plain text** unless it is handed a
 * `codeLanguages`, so every fence in every note rendered as one flat grey slab
 * (`.cm-code-line`) with no tokens in it. This is the table that was missing.
 *
 * **Not `@codemirror/language-data`,** which is the canonical answer to exactly
 * this and was the first thing considered. It resolves ~100 languages, and it
 * pays for them: ~40 new packages in the tree, each arriving as its own
 * dynamic-import chunk, and a *deferred* load — the fence parses as text, then
 * re-parses once the grammar lands. Every grammar below is already a dependency
 * (`legacy-modes` came in for the plain editor's toml/ini/shell) and resolves
 * synchronously, so a fence is highlighted in the first parse. The cost is that
 * the table is finite: an unlisted language is not an error, it is the grey
 * block we had before, and adding one is a line here.
 *
 * This is a **different question** from `languages.ts`, which is deliberately
 * narrow — the vault holds config and the unbuilt web three, so those are the
 * only *files* the editor meets. A note quotes whatever its author was working
 * on that day, and guessing that set narrowly is how you get a grey slab.
 */
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdownLanguage } from '@codemirror/lang-markdown'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage, type Language, type StreamParser } from '@codemirror/language'
import { clojure } from '@codemirror/legacy-modes/mode/clojure'
import { c, cpp, csharp, dart, java, kotlin, objectiveC, scala } from '@codemirror/legacy-modes/mode/clike'
import { cmake } from '@codemirror/legacy-modes/mode/cmake'
import { diff } from '@codemirror/legacy-modes/mode/diff'
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile'
import { erlang } from '@codemirror/legacy-modes/mode/erlang'
import { go } from '@codemirror/legacy-modes/mode/go'
import { groovy } from '@codemirror/legacy-modes/mode/groovy'
import { haskell } from '@codemirror/legacy-modes/mode/haskell'
import { http } from '@codemirror/legacy-modes/mode/http'
import { julia } from '@codemirror/legacy-modes/mode/julia'
import { lua } from '@codemirror/legacy-modes/mode/lua'
import { nginx } from '@codemirror/legacy-modes/mode/nginx'
import { perl } from '@codemirror/legacy-modes/mode/perl'
import { powerShell } from '@codemirror/legacy-modes/mode/powershell'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { protobuf } from '@codemirror/legacy-modes/mode/protobuf'
import { python } from '@codemirror/legacy-modes/mode/python'
import { r } from '@codemirror/legacy-modes/mode/r'
import { ruby } from '@codemirror/legacy-modes/mode/ruby'
import { rust } from '@codemirror/legacy-modes/mode/rust'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { standardSQL } from '@codemirror/legacy-modes/mode/sql'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { swift } from '@codemirror/legacy-modes/mode/swift'
import { toml } from '@codemirror/legacy-modes/mode/toml'

/**
 * The fence's language token: the first word of the info string, lowercased.
 *
 * A fence carries more than a name in the wild — ` ```js title="a.js" `,
 * ` ```python {1,3} `, ` ```{r setup} ` (knitr), ` ```.ts `. Everything after
 * the first whitespace is metadata for some other tool, and the leading `.` and
 * `{` are punctuation those tools chose, not part of the name.
 */
export function fenceLanguageId(info: string): string {
  return (info.trim().split(/[\s,{}]+/).find((w) => w !== '') ?? '')
    .replace(/^\./, '')
    .toLowerCase()
}

/** A legacy stream mode, wrapped once and reused — `StreamLanguage.define` builds
 *  a parser, and a fence lookup runs on every parse of every note. */
const stream = (() => {
  const cache = new Map<StreamParser<unknown>, Language>()
  return (parser: StreamParser<unknown>): Language => {
    const hit = cache.get(parser)
    if (hit !== undefined) return hit
    const made = StreamLanguage.define(parser)
    cache.set(parser, made)
    return made
  }
})()

/** Same idea for the Lezer grammars: `javascript()` builds a `LanguageSupport`
 *  each call, and we only ever want the `Language` inside it. */
const lezer = (() => {
  const cache = new Map<string, Language>()
  return (key: string, make: () => Language): Language => {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const made = make()
    cache.set(key, made)
    return made
  }
})()

/**
 * Fence name → grammar. Aliases are spelled out rather than normalised by rule,
 * because the rules disagree with each other: `sh` and `console` are both shell,
 * `rs` is rust, `rb` is ruby, and `r` is R.
 */
const FENCE: Record<string, () => Language> = {
  // ── The web, from real Lezer grammars ────────────────────────────────
  javascript: () => lezer('js', () => javascript().language),
  js: () => lezer('js', () => javascript().language),
  mjs: () => lezer('js', () => javascript().language),
  cjs: () => lezer('js', () => javascript().language),
  node: () => lezer('js', () => javascript().language),
  jsx: () => lezer('jsx', () => javascript({ jsx: true }).language),
  // TypeScript is absent from `languages.ts` on purpose — nothing in the vault
  // compiles a `.ts` file. A fence is a *quotation*, not something the runtime
  // is expected to run, so that argument does not reach here.
  typescript: () => lezer('ts', () => javascript({ typescript: true }).language),
  ts: () => lezer('ts', () => javascript({ typescript: true }).language),
  tsx: () => lezer('tsx', () => javascript({ typescript: true, jsx: true }).language),
  html: () => lezer('html', () => html().language),
  htm: () => lezer('html', () => html().language),
  xml: () => lezer('html', () => html().language),
  svg: () => lezer('html', () => html().language),
  css: () => lezer('css', () => css().language),
  json: () => lezer('json', () => json().language),
  jsonc: () => lezer('json', () => json().language),
  json5: () => lezer('json', () => json().language),
  yaml: () => lezer('yaml', () => yaml().language),
  yml: () => lezer('yaml', () => yaml().language),
  markdown: () => markdownLanguage,
  md: () => markdownLanguage,

  // ── Everything else, from the legacy stream modes ────────────────────
  python: () => stream(python),
  py: () => stream(python),
  shell: () => stream(shell),
  sh: () => stream(shell),
  bash: () => stream(shell),
  zsh: () => stream(shell),
  console: () => stream(shell),
  'shell-session': () => stream(shell),
  sql: () => stream(standardSQL),
  go: () => stream(go),
  golang: () => stream(go),
  rust: () => stream(rust),
  rs: () => stream(rust),
  ruby: () => stream(ruby),
  rb: () => stream(ruby),
  java: () => stream(java),
  c: () => stream(c),
  'c++': () => stream(cpp),
  cpp: () => stream(cpp),
  'c#': () => stream(csharp),
  csharp: () => stream(csharp),
  cs: () => stream(csharp),
  objc: () => stream(objectiveC),
  kotlin: () => stream(kotlin),
  kt: () => stream(kotlin),
  scala: () => stream(scala),
  swift: () => stream(swift),
  dart: () => stream(dart),
  groovy: () => stream(groovy),
  clojure: () => stream(clojure),
  erlang: () => stream(erlang),
  haskell: () => stream(haskell),
  hs: () => stream(haskell),
  julia: () => stream(julia),
  lua: () => stream(lua),
  perl: () => stream(perl),
  r: () => stream(r),
  powershell: () => stream(powerShell),
  ps1: () => stream(powerShell),
  toml: () => stream(toml),
  ini: () => stream(properties),
  conf: () => stream(properties),
  env: () => stream(properties),
  dotenv: () => stream(properties),
  properties: () => stream(properties),
  diff: () => stream(diff),
  patch: () => stream(diff),
  dockerfile: () => stream(dockerFile),
  docker: () => stream(dockerFile),
  cmake: () => stream(cmake),
  nginx: () => stream(nginx),
  http: () => stream(http),
  protobuf: () => stream(protobuf),
  proto: () => stream(protobuf),
  latex: () => stream(stex),
  tex: () => stream(stex),
}

/**
 * The grammar for a fence's info string, or `null` for one we don't know (which
 * renders exactly as it did before: the grey block, no tokens).
 *
 * Handed to `markdown({ codeLanguages })` as a **function** rather than a list of
 * `LanguageDescription`s. Both are accepted; the function form returns a
 * `Language` on the spot, and the description form goes through an async `load`
 * whose whole purpose is deferring a dynamic import we are not doing.
 */
export function fenceLanguage(info: string): Language | null {
  const make = FENCE[fenceLanguageId(info)]
  return make === undefined ? null : make()
}
