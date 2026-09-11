/**
 * A menu of the values a setting accepts, in the settings files themselves.
 *
 * **Because the file is the source of truth and the settings tab is a window
 * onto it.** Editing `.holi/settings/*.yaml` by hand — or having the agent edit
 * it — is a first-class way to change this vault, so the file should not be the
 * least comfortable place to do it.
 *
 * **Colours are not here.** A hex gets its swatch from `color-swatches.ts`,
 * which decorates any hex in any file because that is an editor feature, not a
 * settings one. This module is only for the thing an editor cannot know: which
 * words a particular key will accept.
 *
 * **Line matching, not the YAML syntax tree.** These four files are generated
 * by `writeSettingsText`/`writeThemeText`, so their shape is known: one
 * `key: value` per line, two-space indent inside a palette, a leading `# ` when
 * the entry is not set. A parse would buy correctness on documents this module
 * deliberately does not claim to handle, and cost a tree walk on every
 * keystroke.
 *
 * **A key names its control, whichever block it is in.** Theme tokens are
 * unique across `light:` and `dark:`, so a swatch does not need to know which
 * palette it is in — which is what keeps this line-local and cheap.
 */
import { Decoration, EditorView, ViewPlugin, WidgetType } from '@codemirror/view'
import type { DecorationSet, ViewUpdate } from '@codemirror/view'
import type { Extension, Range } from '@codemirror/state'
import { SETTINGS_FILE, SETTINGS_LOCAL_FILE, VAULT_SETTINGS } from '@holi/shared'
import { cssColorToHex } from '@/lib/css-color'

/** The two files this applies to. Deliberately not "any YAML": the menu is
 *  derived from a schema, and a key called `landing` in somebody's own note is
 *  not a setting. The theme pair is absent because it is CSS and holds no
 *  fixed-set values — its colours are the editor's business, not this one's. */
const FILES: readonly string[] = [SETTINGS_FILE, SETTINGS_LOCAL_FILE]

export function isSettingsFilePath(path: string): boolean {
  return FILES.includes(path)
}

/** `  # primary: "#8b5cf6"` → its parts. The `# ` is optional and means the
 *  entry is not set; the value may be absent for the same reason.
 *
 *  **The key may be camelCase.** Theme tokens are kebab (`card-foreground`) but
 *  settings keys are not (`dailyNotes`, `maxCommittedFileBytes`), and a
 *  lowercase-only pattern silently matched `landing` and `hooks` while missing
 *  four of the six settings — no error, just no control. */
const LINE = /^(\s*)(#\s*)?([A-Za-z][A-Za-z0-9-]*):[ \t]*(.*)$/

interface Entry {
  indent: string
  commented: boolean
  key: string
  /** Where the value sits in the document, so a pick can replace exactly it.
   *  Equal `from`/`to` for a set-me-up line that has no value yet. */
  from: number
  to: number
  value: string
}

function readLine(text: string, lineStart: number): Entry | null {
  const m = LINE.exec(text)
  if (m === null) return null
  const [, indent, hash, key, rest] = m
  const value = rest!.trim()
  // Trailing comments are not written by the generators, so anything after the
  // value is somebody's own note and must not be swallowed by a replacement.
  const valueStart = text.length - rest!.length + (rest!.length - rest!.trimStart().length)
  return {
    indent: indent!,
    commented: hash !== undefined,
    key: key!,
    from: lineStart + valueStart,
    to: lineStart + valueStart + value.length,
    value,
  }
}

/** A menu of the values a key accepts. */
class ChoiceWidget extends WidgetType {
  constructor(
    readonly current: string,
    readonly options: readonly { value: string; label: string }[],
    readonly onPick: (value: string) => void,
    readonly label: string,
  ) {
    super()
  }

  override eq(other: ChoiceWidget): boolean {
    return other.current === this.current && other.options === this.options
  }

  override toDOM(): HTMLElement {
    const select = document.createElement('select')
    select.className = 'cm-settings-choice'
    select.setAttribute('aria-label', this.label)
    for (const option of this.options) {
      const el = document.createElement('option')
      el.value = option.value
      el.textContent = option.label
      if (option.value === this.current) el.selected = true
      select.appendChild(el)
    }
    select.addEventListener('change', () => this.onPick(select.value))
    return select
  }

  override ignoreEvent(): boolean {
    return false
  }
}

/** The values a settings key offers, as they are written in a file. `null` for
 *  a key with no fixed set — a number, or a landing target written by hand. */
function choicesFor(key: string): readonly { value: string; label: string }[] | null {
  const setting = VAULT_SETTINGS.find((s) => s.key === key)
  if (setting === undefined) return null
  if (setting.type.kind === 'boolean') {
    return [
      { value: 'true', label: 'true' },
      { value: 'false', label: 'false' },
    ]
  }
  if (setting.type.kind !== 'enum') return null
  return setting.type.options.map((o) => ({
    value: String(o.value),
    label: `${o.value} — ${o.label}`,
  }))
}

/**
 * Replace an entry's value, uncommenting the line if it was a comment.
 *
 * **Picking a colour on a commented line SETS it**, which is the interaction the
 * file's own shape implies: a commented entry is one whose value Holi is
 * choosing, and reaching for the swatch is how you take that decision back.
 */
function applyValue(view: EditorView, entry: Entry, lineFrom: number, written: string): void {
  if (!entry.commented) {
    view.dispatch({ changes: { from: entry.from, to: entry.to, insert: written } })
    return
  }
  view.dispatch({
    changes: {
      from: lineFrom,
      to: entry.to,
      insert: `${entry.indent}${entry.key}: ${written}`,
    },
  })
}

/** One control the file offers, independent of what is on screen. */
export interface SettingsControl {
  /** 1-based, as an editor counts them. */
  line: number
  key: string
  /** Whether the entry is currently a comment, i.e. Holi is choosing. */
  commented: boolean
}

/**
 * Every control a settings document offers.
 *
 * Exported because it is the behaviour worth pinning: `build` below turns this
 * into decorations, but CodeMirror only builds DOM for the lines it is
 * rendering, so a test that counted swatches in the DOM would be measuring the
 * viewport rather than this module.
 */
export function controlsIn(path: string, text: string): SettingsControl[] {
  if (!isSettingsFilePath(path)) return []
  const out: SettingsControl[] = []
  text.split('\n').forEach((lineText, i) => {
    const entry = readLine(lineText, 0)
    if (entry === null) return
    if (choicesFor(entry.key) === null) return
    out.push({ line: i + 1, key: entry.key, commented: entry.commented })
  })
  return out
}

/**
 * Every line, not `view.visibleRanges`.
 *
 * The usual reason to walk the viewport is cost, and there is none here: these
 * four files are generated and the largest is the theme's ~130 lines, so the
 * whole document is cheaper than the bookkeeping to avoid it. It also removes a
 * real correctness trap — the viewport is a measured quantity, so a decoration
 * built from it depends on layout having happened, and anything measuring zero
 * height (a pane opening, a test) silently gets no controls at all rather than
 * an error.
 */
function build(view: EditorView): DecorationSet {
  const marks: Range<Decoration>[] = []
  const doc = view.state.doc
  for (let n = 1; n <= doc.lines; n++) {
    const line = doc.line(n)
    const entry = readLine(line.text, line.from)
    if (entry === null) continue
    const widget = widgetFor(view, entry, line.from)
    // After the value, never before: a widget at the head of the line would sit
    // between the indent and the key and read as part of the name.
    if (widget !== null) marks.push(Decoration.widget({ widget, side: 1 }).range(line.to))
  }
  return Decoration.set(marks, true)
}

function widgetFor(view: EditorView, entry: Entry, lineFrom: number): WidgetType | null {
  const choices = choicesFor(entry.key)
  if (choices === null) return null
  return new ChoiceWidget(
    entry.value,
    choices,
    (picked) => applyValue(view, entry, lineFrom, picked),
    entry.key,
  )
}

const theme = EditorView.baseTheme({
  '.cm-settings-choice': {
    marginLeft: '0.5em',
    font: 'inherit',
    fontSize: '0.85em',
    color: 'var(--muted-foreground)',
    background: 'transparent',
    border: '1px solid var(--border)',
    borderRadius: '3px',
    cursor: 'pointer',
  },
})

/** Swatches and menus for `.holi/settings/*.yaml`; nothing for anything else. */
export function settingsControls(path: string): Extension[] {
  if (!isSettingsFilePath(path)) return []
  return [
    theme,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet
        constructor(view: EditorView) {
          this.decorations = build(view)
        }
        update(update: ViewUpdate): void {
          if (update.docChanged) this.decorations = build(update.view)
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ]
}
