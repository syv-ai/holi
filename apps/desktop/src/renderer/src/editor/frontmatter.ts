/**
 * Frontmatter as one in-editor widget (FR-2 hide / FR-16 reveal).
 *
 * Modelled on the table widget (`codemirror-markdown-tables`): an atomic
 * block-`replace` decoration over the region, hosting its own nested
 * `EditorView`, whose edits are **dispatched back to the root** over the
 * region's range with a marker annotation so the plugin does not rebuild (and
 * so lose the nested caret) on its own write. The difference from the table is
 * two render states — a collapsed pill (this is the FR-2 hide) and, on reveal, a
 * nested *plain* editor (no markdown stack, so `⌘B` cannot corrupt a key).
 *
 * The region is **always** replaced by the widget: the root frontmatter text is
 * never edited directly, only through the nested editor's write-back. Because
 * the write-back reconstructs the `---` fences every time, breaking the YAML
 * body never dissolves the block — it only turns the status dot red (and, via
 * `frontmatterValid`, holds off the save).
 */
import {
  Annotation,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
  type Range,
} from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { splitFrontmatter } from '@holi/shared'
import { frontmatterRegion, frontmatterYamlValid } from './frontmatter-region'

/** Flip the reveal state. The pill and the header chevron both dispatch this. */
export const toggleFrontmatter = StateEffect.define<boolean>()

/** Marks a transaction as the widget's own write-back, so the view plugin maps
 *  its decorations through it rather than rebuilding and remounting the nested
 *  editor mid-keystroke — the table widget's `table.edit` annotation, renamed. */
const frontmatterEdit = Annotation.define<boolean>()

/** Revealed or collapsed. Starts collapsed — FR-2 hides frontmatter by default. */
export const frontmatterExpandedField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(toggleFrontmatter)) return e.value
    return value
  },
})

/** Does the document's frontmatter parse? The save gate (EditorPane) reads this
 *  to hold off autosave and ⌘S while it is false. */
export function frontmatterValid(state: EditorState): boolean {
  return frontmatterYamlValid(state.doc.toString())
}

/** The raw YAML body between the fences (trailing newline included), or '' when
 *  the document has no parseable fence. */
function frontmatterBody(doc: string): string {
  try {
    return splitFrontmatter(doc).yaml ?? ''
  } catch {
    return ''
  }
}

/** Reconstruct the whole region from an edited YAML body, fences always intact
 *  so the block never dissolves under a temporarily-broken body. */
export function regionTextFrom(body: string): string {
  const inner = body === '' || body.endsWith('\n') ? body : `${body}\n`
  return `---\n${inner}---\n`
}

/** Count top-level `key:` lines — the pill's "N fields". Best-effort, never throws. */
function keyCount(body: string): number {
  return body.split('\n').filter((l) => /^\S.*:/.test(l)).length
}

function statusDot(body: string): HTMLElement {
  const dot = document.createElement('span')
  const valid = frontmatterYamlValid(regionTextFrom(body))
  dot.className = `cm-fm-dot ${valid ? 'cm-fm-dot-ok' : 'cm-fm-dot-bad'}`
  dot.title = valid ? 'frontmatter is valid YAML' : 'frontmatter is not valid YAML'
  return dot
}

class FrontmatterWidget extends WidgetType {
  private nested: EditorView | null = null

  constructor(
    readonly expanded: boolean,
    readonly body: string,
  ) {
    super()
  }

  /** Reuse the DOM (and the live nested editor) when nothing relevant changed.
   *  The write-back skips rebuild entirely; a genuine rebuild (toggle, external
   *  reload) makes a widget that differs here and so replaces the DOM. */
  override eq(other: FrontmatterWidget): boolean {
    return other.expanded === this.expanded && other.body === this.body
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'cm-fm'
    wrap.setAttribute('data-frontmatter', this.expanded ? 'expanded' : 'collapsed')

    if (!this.expanded) {
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'cm-fm-pill'
      pill.setAttribute('data-frontmatter-pill', '')
      pill.appendChild(statusDot(this.body))
      const label = document.createElement('span')
      const n = keyCount(this.body)
      label.textContent = `▸ frontmatter · ${n} field${n === 1 ? '' : 's'}`
      pill.appendChild(label)
      pill.onmousedown = (e) => {
        e.preventDefault()
        view.dispatch({ effects: toggleFrontmatter.of(true) })
      }
      wrap.appendChild(pill)
      return wrap
    }

    const header = document.createElement('button')
    header.type = 'button'
    header.className = 'cm-fm-header'
    header.setAttribute('data-frontmatter-header', '')
    header.appendChild(statusDot(this.body))
    const label = document.createElement('span')
    label.textContent = '▾ frontmatter'
    header.appendChild(label)
    header.onmousedown = (e) => {
      e.preventDefault()
      view.dispatch({ effects: toggleFrontmatter.of(false) })
    }
    wrap.appendChild(header)

    const host = document.createElement('div')
    host.className = 'cm-fm-body'
    wrap.appendChild(host)

    // A PLAIN editor over the YAML body: basic editing + history only. No
    // markdown, no live-preview, no formatting keymap — that is the whole point
    // of a separate surface (notes-editor.md §Frontmatter reveal control).
    this.nested = new EditorView({
      parent: host,
      doc: this.body.replace(/\n$/, ''),
      extensions: [
        history(),
        drawSelection(),
        EditorView.lineWrapping,
        keymap.of([...defaultKeymap, ...historyKeymap]),
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return
          this.writeBack(view, u.state.doc.toString())
        }),
        EditorView.theme({ '&': { backgroundColor: 'transparent' }, '.cm-content': { padding: 0 } }),
      ],
    })
    return wrap
  }

  /** Push the nested body back to the root over the current region, fences
   *  rebuilt, marked as our own edit so the plugin does not remount us. */
  private writeBack(view: EditorView, body: string): void {
    const region = frontmatterRegion(view.state.doc.toString())
    if (region === null) return
    view.dispatch({
      changes: { from: region.from, to: region.to, insert: regionTextFrom(body) },
      annotations: frontmatterEdit.of(true),
    })
  }

  override destroy(): void {
    this.nested?.destroy()
    this.nested = null
  }

  override ignoreEvent(): boolean {
    // Events inside the widget (typing in the nested editor, clicking the pill)
    // are the widget's own — the root must not treat them as its input.
    return true
  }
}

/**
 * The decoration set — pure over the state, so it is unit-testable without a DOM
 * exactly as `buildDecorations` is. One atomic block-replace over the region, or
 * nothing when the document has no frontmatter.
 */
export function frontmatterDecorations(state: EditorState): DecorationSet {
  const doc = state.doc.toString()
  const region = frontmatterRegion(doc)
  if (region === null) return Decoration.none
  const expanded = state.field(frontmatterExpandedField, false) ?? false
  const widget = new FrontmatterWidget(expanded, frontmatterBody(doc))
  const range: Range<Decoration> = Decoration.replace({ widget, block: true }).range(
    region.from,
    region.to,
  )
  return Decoration.set([range])
}

const frontmatterView = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(readonly view: EditorView) {
      this.decorations = frontmatterDecorations(view.state)
    }

    update(update: ViewUpdate): void {
      const ownEdit = update.transactions.some((tr) => tr.annotation(frontmatterEdit))
      const toggled = update.transactions.some((tr) =>
        tr.effects.some((e) => e.is(toggleFrontmatter)),
      )
      if (ownEdit && !toggled) {
        // Our own write-back: map, do not rebuild, so the nested editor lives.
        this.decorations = this.decorations.map(update.changes)
        return
      }
      if (update.docChanged || toggled) {
        this.decorations = frontmatterDecorations(update.state)
      }
    }
  },
  {
    decorations: (v) => v.decorations,
    // Atomic: the caret cannot land inside the replaced region; it is edited
    // only through the nested editor. The guard the table widget relies on too.
    provide: (plugin) =>
      EditorView.atomicRanges.of((view) => view.plugin(plugin)?.decorations ?? Decoration.none),
  },
)

const frontmatterTheme = EditorView.baseTheme({
  '.cm-fm': { margin: '0 0 0.75rem 0' },
  '.cm-fm-pill, .cm-fm-header': {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '0.4rem',
    padding: '0.15rem 0.5rem',
    fontSize: '0.75rem',
    color: '#a3a3a3',
    background: '#1c1c1c',
    border: '1px solid #2a2a2a',
    borderRadius: '0.375rem',
    cursor: 'pointer',
  },
  '.cm-fm-body': {
    marginTop: '0.25rem',
    border: '1px solid #2a2a2a',
    borderRadius: '0.375rem',
    padding: '0.25rem 0.5rem',
    background: '#141414',
  },
  '.cm-fm-dot': {
    width: '0.5rem',
    height: '0.5rem',
    borderRadius: '9999px',
    display: 'inline-block',
  },
  '.cm-fm-dot-ok': { background: '#4ade80' },
  '.cm-fm-dot-bad': { background: '#f87171' },
})

/** The whole frontmatter feature, one extension. Register AFTER livePreview so
 *  the block-replace owns the region's rendering. */
export const frontmatterExtension: Extension = [
  frontmatterExpandedField,
  frontmatterView,
  frontmatterTheme,
]
