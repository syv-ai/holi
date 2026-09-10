/**
 * Syntax highlighting for the plain-text editor, chosen by file name.
 *
 * The vault is mostly markdown (its own editor) plus two narrow sets that are
 * *not* a general code editor:
 *
 * - **config** — `.holi/settings/theme.yaml`, a `.yaml`, a `.env`, the odd `.toml`.
 * - **the web three** — an app under `.holi/apps/` is unbuilt HTML, CSS and JS
 *   the browser runs as-is, so those are the only source files the editor
 *   actually meets. TypeScript is left out on purpose: nothing compiles it, so
 *   highlighting `.ts` would advertise a language the runtime does not have.
 *
 * JSON also gets a validity linter (`theme.json` is agent-written, and a red
 * squiggle beats a silent parse failure the resolver quietly falls back from).
 * The web three get none — there is no cheap, correct parse for a half-typed
 * document, and a squiggle that cries wolf mid-keystroke is worse than silence.
 *
 * The decision — which language a path is — is `languageIdForPath`, a pure
 * string classifier that is the only part worth testing. `languageForPath` is
 * the thin glue from that id to CodeMirror extensions.
 */
import { css } from '@codemirror/lang-css'
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

const BY_EXT: Record<string, LangId> = {
  json: 'json',
  jsonc: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  env: 'ini',
  properties: 'ini',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  html: 'html',
  htm: 'html',
  css: 'css',
}

/**
 * Which language a vault path is, or `null` for none (edit as plain text).
 *
 * Dotfiles need care: `.env`, `.bashrc` and friends have no extension in the
 * `basename.ext` sense — the leading dot is not an extension separator — so they
 * are matched by name. `.env.local` (a real local-override name) is caught by the
 * `.env` prefix, not the `local` suffix.
 */
export function languageIdForPath(path: string): LangId | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase()

  // Dotfiles: no `name.ext` split to make, so classify by the whole name.
  if (base.startsWith('.')) {
    if (base === '.env' || base.startsWith('.env.')) return 'ini'
    if (
      base.endsWith('rc') &&
      (base.includes('bash') || base.includes('zsh') || base.includes('sh'))
    )
      return 'shell'
    return null
  }

  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  return BY_EXT[ext] ?? null
}

const LEGACY: Record<'toml' | 'ini' | 'shell', StreamLanguage<unknown>> = {
  toml: StreamLanguage.define(toml),
  ini: StreamLanguage.define(properties),
  shell: StreamLanguage.define(shell),
}

/** A linter squiggle for YAML — `@codemirror/lang-yaml` ships no linter, so this
 *  mirrors `jsonParseLinter` by parsing with the same `yaml` the frontmatter gate
 *  uses. `YAMLParseError` carries a precise `[from, to]`, so the underline lands
 *  on the offending span rather than the whole file. */
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
 * The CodeMirror extensions that highlight (and, for JSON/YAML, lint) a given
 * path. Empty when the path has no known language — the plain stack then renders
 * it as undecorated text.
 */
export function languageForPath(path: string): Extension[] {
  const id = languageIdForPath(path)
  if (id === null) return []
  if (id === 'json') return [json(), linter(jsonParseLinter())]
  if (id === 'yaml') return [yaml(), yamlLinter()]
  if (id === 'javascript') return [javascript()]
  // `html()` already nests JS and CSS for `<script>`/`<style>` blocks, which is
  // most of what an app's `index.html` contains.
  if (id === 'html') return [html()]
  if (id === 'css') return [css()]
  return [LEGACY[id]]
}

/**
 * Does the file's content parse as its language? The save gate (EditorPane)
 * reads this to hold off autosave and ⌘S while it is false — the plain-text
 * analogue of `frontmatterValid` for notes.
 *
 * Only the formats we can cheaply parse are gated (JSON, YAML); everything else
 * — toml/ini/shell, the web three, unknown text — has no gate (always valid),
 * and an empty buffer is valid: there is nothing yet to be invalid, matching the
 * frontmatter gate.
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
 * An always-visible validity dot for the gated formats — the plain-text twin of
 * the frontmatter chevron. A bottom status strip carrying a dot + the format
 * name: neutral while it parses, red the moment it doesn't (and the autosave is
 * held). Only the formats `syntaxValid` actually gates (JSON, YAML) get one — a
 * dot on a format we never gate would be a status that means nothing.
 *
 * It lives in a CodeMirror panel, not the React tree, so it stays pinned while
 * the doc scrolls (the whole point — the squiggle can scroll away, a held save
 * should not) and matches the rest of the editor's self-contained hex styling.
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
