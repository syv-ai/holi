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
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
  Transaction,
  type Extension,
  type Range,
} from '@codemirror/state'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import {
  Decoration,
  drawSelection,
  EditorView,
  keymap,
  WidgetType,
  type DecorationSet,
} from '@codemirror/view'
import { splitFrontmatter } from '@holi/shared'
import {
  frontmatterBlockRange,
  frontmatterRegion,
  frontmatterYamlValid,
} from './frontmatter-region'

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

/** The chevron IS the status indicator now — no separate orb. Neutral normally,
 *  red when the YAML won't parse; the field count lives in its tooltip. Shared by
 *  the initial render and the live refresh so the two can never disagree. */
function paintChevron(el: HTMLElement, body: string): void {
  const valid = frontmatterYamlValid(regionTextFrom(body))
  el.classList.toggle('cm-fm-invalid', !valid)
  const n = keyCount(body)
  el.title = valid
    ? `frontmatter · ${n} field${n === 1 ? '' : 's'}`
    : 'frontmatter — invalid YAML'
}

class FrontmatterWidget extends WidgetType {
  private nested: EditorView | null = null
  /** The revealed chevron, kept so a nested edit can recolour it in place — the
   *  widget maps rather than rebuilds on its own write (to keep the nested caret),
   *  so nothing else would refresh the invalid-YAML cue live. */
  private chevron: HTMLElement | null = null

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
      // Collapsed is just a bare chevron — no orb, no label, no box. The chevron
      // reddens if the YAML is invalid; the field count is in its tooltip.
      const pill = document.createElement('button')
      pill.type = 'button'
      pill.className = 'cm-fm-pill'
      pill.setAttribute('data-frontmatter-pill', '')
      pill.textContent = '▸'
      paintChevron(pill, this.body)
      pill.onmousedown = (e) => {
        e.preventDefault()
        view.dispatch({ effects: toggleFrontmatter.of(true) })
      }
      wrap.appendChild(pill)
      return wrap
    }

    // Expanded reads as ONE widget: a collapse chevron sitting to the left of the
    // YAML, no "frontmatter" title, no border, no box — just the fields.
    const row = document.createElement('div')
    row.className = 'cm-fm-reveal'

    const chevron = document.createElement('button')
    chevron.type = 'button'
    chevron.className = 'cm-fm-chevron'
    chevron.setAttribute('data-frontmatter-header', '')
    chevron.textContent = '▾'
    paintChevron(chevron, this.body)
    this.chevron = chevron
    chevron.onmousedown = (e) => {
      e.preventDefault()
      view.dispatch({ effects: toggleFrontmatter.of(false) })
    }
    row.appendChild(chevron)

    const host = document.createElement('div')
    host.className = 'cm-fm-body'
    row.appendChild(host)
    wrap.appendChild(row)

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
          const body = u.state.doc.toString()
          this.writeBack(view, body)
          // Recolour the chevron here: the write-back is our own edit, so the
          // widget maps instead of rebuilding and the cue would otherwise stay
          // frozen — the invalid-YAML feedback has to be live while you type.
          if (this.chevron !== null) paintChevron(this.chevron, body)
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
    this.chevron = null
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
  // `frontmatterBlockRange`, not `frontmatterRegion`: the decoration stops at
  // the closing fence's line END, so the first body position stays on the first
  // body line rather than being swallowed into the widget's row. See the long
  // comment there — this one character is the whole of the stray-caret bug.
  const block = frontmatterBlockRange(doc)
  if (block === null) return Decoration.none
  const expanded = state.field(frontmatterExpandedField, false) ?? false
  const widget = new FrontmatterWidget(expanded, frontmatterBody(doc))
  const range: Range<Decoration> = Decoration.replace({ widget, block: true }).range(
    block.from,
    block.to,
  )
  return Decoration.set([range])
}

/**
 * The block-replace lives in a **StateField**, not a ViewPlugin: CodeMirror
 * forbids block decorations from plugins (`RangeError: Block decorations may not
 * be specified via plugins`), which aborts EditorView construction — so a note
 * with frontmatter would open blank. The table widget provides its block decos
 * the same way (a StateField), and this is the difference between the two.
 *
 * The map-don't-rebuild rule is preserved: our own write-back maps the existing
 * set through the change so the nested editor keeps its caret; a genuine change
 * (edit from the root, toggle, external reload) recomputes from scratch.
 */
const frontmatterDecoField = StateField.define<DecorationSet>({
  create: (state) => frontmatterDecorations(state),
  update(deco, tr) {
    const ownEdit = tr.annotation(frontmatterEdit)
    const toggled = tr.effects.some((e) => e.is(toggleFrontmatter))
    // Our own write-back: map, do not rebuild, so the nested editor lives.
    if (ownEdit && !toggled) return deco.map(tr.changes)
    if (tr.docChanged || toggled) return frontmatterDecorations(tr.state)
    return deco
  },
  provide: (f) => [
    EditorView.decorations.from(f),
    // Atomic: the caret cannot land inside the replaced region; it is edited
    // only through the nested editor. The guard the table widget relies on too.
    EditorView.atomicRanges.of((view) => view.state.field(f, false) ?? Decoration.none),
  ],
})

const frontmatterTheme = EditorView.baseTheme({
  '.cm-fm': { margin: '0 0 0.5rem 0' },
  // Collapsed: a bare chevron, nothing else.
  '.cm-fm-pill': {
    padding: '0.05rem 0.15rem',
    fontSize: '0.8rem',
    lineHeight: '1.2',
    color: '#6b6b6b',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  // Expanded: one borderless unit — the chevron sits to the left of the YAML,
  // no title, no box. The chevron aligns to the first line.
  '.cm-fm-reveal': { display: 'flex', alignItems: 'flex-start', gap: '0.4rem' },
  '.cm-fm-chevron': {
    padding: '0',
    paddingTop: '0.05rem',
    fontSize: '0.8rem',
    lineHeight: '1.4',
    color: '#6b6b6b',
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
  },
  '.cm-fm-pill:hover, .cm-fm-chevron:hover': { color: '#a3a3a3' },
  '.cm-fm-body': { flex: '1', minWidth: '0' },
  // Invalid YAML reddens the chevron — the only status cue, and it wins on hover.
  '.cm-fm-pill.cm-fm-invalid, .cm-fm-chevron.cm-fm-invalid': { color: '#f87171' },
})

/** Where the editable body starts — just past the frontmatter block, or 0 when
 *  there is none. EditorPane seeds the initial caret here so it never opens to
 *  the left of the widget. */
export function bodyStart(doc: string): number {
  return frontmatterRegion(doc)?.to ?? 0
}

/**
 * The block is edited only through the nested editor — never from the root. Two
 * guards make that true, because the atomic-range facet alone leaves the
 * top-of-document boundary reachable (caret to the left of the widget) and lets
 * a Backspace at the edge delete the whole block as an atomic unit:
 *
 *  - a **change filter** drops any *user* edit that touches the region. It keys
 *    on `userEvent`, so programmatic reloads/merges (no userEvent) and our own
 *    write-back (`frontmatterEdit`) pass untouched — the load-bearing
 *    external-reload machinery is not affected.
 *  - a **transaction filter** pushes any root caret that lands at or before the
 *    block down to just after it. There is nothing to edit above the frontmatter.
 */
const protectFrontmatter = EditorState.changeFilter.of((tr) => {
  const region = frontmatterRegion(tr.startState.doc.toString())
  if (region === null) return true
  if (tr.annotation(frontmatterEdit) || tr.annotation(Transaction.userEvent) === undefined) return true
  return [region.from, region.to]
})

const caretBelowFrontmatter = EditorState.transactionFilter.of((tr) => {
  const region = frontmatterRegion(tr.newDoc.toString())
  if (region === null) return tr
  const sel = tr.newSelection
  // Only nudge a bare caret that lands at or before the block; a real selection
  // (select-all, a drag) is left alone so those still work — the block just
  // cannot be edited, via the change filter.
  if (!(sel.ranges.length === 1 && sel.main.empty && sel.main.from < region.to)) return tr
  // `assoc: 1` — bind the caret to the character AFTER it. `region.to` is the
  // seam between the widget's last line and the first body line, and a caret
  // that associates backwards there renders on the widget's side of it.
  return [tr, { selection: EditorSelection.cursor(region.to, 1) }]
})

/** The whole frontmatter feature, one extension. Register AFTER livePreview so
 *  the block-replace owns the region's rendering. */
export const frontmatterExtension: Extension = [
  frontmatterExpandedField,
  frontmatterDecoField,
  frontmatterTheme,
  protectFrontmatter,
  caretBelowFrontmatter,
]
