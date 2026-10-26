/**
 * Syntax highlighting for the plain-text editor, chosen by file name. Not a
 * general code editor, two narrow sets:
 *
 * - config: `.holi/settings/app.yaml`, a `.yaml`, a `.env`, the odd `.toml`.
 * - the web three: a vault app (a `<name>.app` folder) is unbuilt HTML, CSS and JS.
 *   TypeScript is left out on purpose: nothing compiles it.
 *
 * JSON and YAML also get a validity linter, since agent-written config fails
 * silently otherwise. The web three get none: no cheap, correct parse exists
 * for a half-typed document.
 */
import { css } from '@codemirror/lang-css'
import { colorPicker, wrapperClassName } from '@replit/codemirror-css-color-picker'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json, jsonParseLinter } from '@codemirror/lang-json'
import { yaml } from '@codemirror/lang-yaml'
import { StreamLanguage } from '@codemirror/language'
import { linter, type Diagnostic } from '@codemirror/lint'
import type { Extension } from '@codemirror/state'
import { EditorView, showPanel, type Panel } from '@codemirror/view'
import { properties } from '@codemirror/legacy-modes/mode/properties'
import { shell } from '@codemirror/legacy-modes/mode/shell'
import { toml } from '@codemirror/legacy-modes/mode/toml'
import { parse as parseYaml, YAMLParseError } from 'yaml'

/** `ini` covers the whole properties/env family (`.env`, `.ini`, `.conf`). */
export type LangId = 'json' | 'yaml' | 'toml' | 'ini' | 'shell' | 'javascript' | 'html' | 'css'

/**
 * What each extension is, once, for both questions asked of a path: `cm`, the
 * CodeMirror grammar the plain-text editor loads (a narrow set, on purpose),
 * and `shiki`, the grammar name the read-only code view highlights with (a
 * wide one). An entry with only one of them is a format only that side knows.
 */
interface Lang {
  cm?: LangId
  shiki?: string
}
const lang = (shiki: string | undefined, cm?: LangId): Lang => ({ shiki, cm })

const BY_EXT: Record<string, Lang> = {
  astro: lang('astro'),
  bash: lang('shell', 'shell'),
  c: lang('c'),
  cc: lang('cpp'),
  cfg: lang(undefined, 'ini'),
  cjs: lang('javascript', 'javascript'),
  conf: lang(undefined, 'ini'),
  cpp: lang('cpp'),
  cs: lang('csharp'),
  css: lang('css', 'css'),
  cts: lang('typescript'),
  diff: lang('diff'),
  env: lang(undefined, 'ini'),
  go: lang('go'),
  gql: lang('graphql'),
  graphql: lang('graphql'),
  h: lang('c'),
  hpp: lang('cpp'),
  htm: lang('html', 'html'),
  html: lang('html', 'html'),
  ini: lang('ini', 'ini'),
  java: lang('java'),
  js: lang('javascript', 'javascript'),
  json: lang('json', 'json'),
  jsonc: lang('json', 'json'),
  json5: lang('json'),
  jsx: lang('jsx'),
  kt: lang('kotlin'),
  kts: lang('kotlin'),
  less: lang('less'),
  mjs: lang('javascript', 'javascript'),
  mts: lang('typescript'),
  patch: lang('diff'),
  php: lang('php'),
  properties: lang(undefined, 'ini'),
  py: lang('python'),
  rb: lang('ruby'),
  rs: lang('rust'),
  scss: lang('scss'),
  sh: lang('shell', 'shell'),
  sql: lang('sql'),
  svelte: lang('svelte'),
  svg: lang('xml'),
  swift: lang('swift'),
  toml: lang('toml', 'toml'),
  ts: lang('typescript'),
  tsx: lang('tsx'),
  vue: lang('vue'),
  xml: lang('xml'),
  yaml: lang('yaml', 'yaml'),
  yml: lang('yaml', 'yaml'),
  zsh: lang('shell', 'shell'),
}

/** Files known by their whole name, which have no extension worth reading. */
const BY_NAME: Record<string, Lang> = {
  dockerfile: lang('docker'),
  makefile: lang('makefile'),
  gnumakefile: lang('makefile'),
  '.npmrc': lang('ini'),
  '.editorconfig': lang('ini'),
  '.gitconfig': lang('ini'),
  '.zshrc': lang('shell', 'shell'),
  '.bashrc': lang('shell', 'shell'),
  '.profile': lang('shell'),
}

/** A path's last segment, lower-cased. */
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1).toLowerCase()

/**
 * Which grammars a path has. Dotfiles (`.env`, `.bashrc`) have no extension in
 * the `name.ext` sense and are matched by name; `.env.local` is caught by the
 * `.env` prefix.
 */
function langOf(path: string): Lang {
  const base = baseName(path)
  const named = BY_NAME[base]
  if (named !== undefined) return named
  if (base === '.env' || base.startsWith('.env.')) return lang('dotenv', 'ini')
  if (base.endsWith('.dockerfile')) return lang('docker')
  if (base.startsWith('.')) {
    // A dotfile's only dot is its name, not an extension (`.gitignore`).
    return base.endsWith('rc') &&
      (base.includes('bash') || base.includes('zsh') || base.includes('sh'))
      ? lang(undefined, 'shell')
      : {}
  }
  const dot = base.lastIndexOf('.')
  return dot > 0 ? (BY_EXT[base.slice(dot + 1)] ?? {}) : {}
}

/** Which CodeMirror language a vault path is, or `null` for plain text. */
export function languageIdForPath(path: string): LangId | null {
  return langOf(path).cm ?? null
}

/** Which grammar the code view highlights a vault file with; undefined is plain text. */
export function codeLanguage(path: string): string | undefined {
  return langOf(path).shiki
}

const LEGACY: Record<'toml' | 'ini' | 'shell', StreamLanguage<unknown>> = {
  toml: StreamLanguage.define(toml),
  ini: StreamLanguage.define(properties),
  shell: StreamLanguage.define(shell),
}

/** A YAML linter: `@codemirror/lang-yaml` ships none. `YAMLParseError`
 *  carries a precise `[from, to]` for the underline. */
function yamlLinter(): Extension {
  return linter((view): Diagnostic[] => {
    const text = view.state.doc.toString()
    if (text.trim() === '') return []
    try {
      parseYaml(text)
      return []
    } catch (err) {
      const len = view.state.doc.length
      if (err instanceof YAMLParseError) {
        const [from, to] = err.pos
        return [
          {
            from: Math.min(from, len),
            to: Math.min(Math.max(to, from + 1), len),
            severity: 'error',
            message: err.message,
          },
        ]
      }
      return [
        {
          from: 0,
          to: len,
          severity: 'error',
          message: err instanceof Error ? err.message : 'Invalid YAML',
        },
      ]
    }
  })
}

/**
 * The swatch without the extension's `outline: 1px solid #eee`, a bright ring
 * on a dark editor. `EditorView.theme` beats its `baseTheme`, the documented
 * way to restyle it.
 */
const colorSwatchLook = EditorView.theme({
  [`.${wrapperClassName}`]: { outline: 'none', borderRadius: '2px' },
})

/**
 * The extensions that highlight (and, for JSON/YAML, lint) a path. Empty when
 * the path has no known language.
 */
export function languageForPath(path: string): Extension[] {
  const id = languageIdForPath(path)
  if (id === null) return []
  if (id === 'json') return [json(), linter(jsonParseLinter())]
  if (id === 'yaml') return [yaml(), yamlLinter()]
  if (id === 'javascript') return [javascript()]
  // `colorPicker` finds colours through the CSS grammar, so it belongs only with
  // the two languages that have it; `html()` nests CSS in `<style>` and
  // `style=`, so inline colours get a swatch too.
  //
  // The swatch sits LEFT of the value, deliberately: the extension places it at
  // the `from` a pick replaces, moving it means owning the tree walk, and a
  // column of declarations gets an aligned column of swatches.
  if (id === 'html') return [html(), colorPicker, colorSwatchLook]
  if (id === 'css') return [css(), colorPicker, colorSwatchLook]
  return [LEGACY[id]]
}

/**
 * Does the content parse as its language? EditorPane's save gate, the plain
 * analogue of `frontmatterValid`. Only JSON and YAML are gated; everything else,
 * and an empty buffer, is valid.
 */
export function syntaxValid(path: string, text: string): boolean {
  if (text.trim() === '') return true
  const id = languageIdForPath(path)
  try {
    if (id === 'json') JSON.parse(text)
    else if (id === 'yaml') parseYaml(text)
    else return true
    return true
  } catch {
    return false
  }
}

/**
 * A validity strip for the formats `syntaxValid` gates: neutral while it
 * parses, red while the autosave is held. A CodeMirror panel, so it stays
 * pinned while the doc scrolls.
 */
export function validityStatus(path: string): Extension {
  const id = languageIdForPath(path)
  if (id !== 'json' && id !== 'yaml') return []
  const label = id.toUpperCase()
  return showPanel.of((view): Panel => {
    const dom = document.createElement('div')
    dom.className = 'cm-validity'
    const dot = document.createElement('span')
    dot.className = 'cm-validity-dot'
    const text = document.createElement('span')
    text.className = 'cm-validity-label'
    dom.append(dot, text)
    const paint = (v: EditorView) => {
      const ok = syntaxValid(path, v.state.doc.toString())
      dom.classList.toggle('cm-validity-invalid', !ok)
      text.textContent = ok ? label : `Invalid ${label}`
      dom.title = ok
        ? `${label} — valid`
        : `${label} does not parse — autosave paused until it is fixed`
    }
    paint(view)
    return {
      dom,
      top: false,
      update: (u) => {
        if (u.docChanged) paint(u.view)
      },
    }
  })
}
