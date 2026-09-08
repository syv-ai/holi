/**
 * Simplified live preview (D22): a pure decoration builder over the syntax
 * tree + wiki-link grammar. Lines the selection touches render RAW (no
 * concealing decorations there); everything else renders. Rebuilds on
 * docChanged/selectionSet/viewport — a plain recompute, no animation.
 */
import { syntaxTree } from '@codemirror/language'
import type { SyntaxNode } from '@lezer/common'
import { Facet, RangeSetBuilder, type EditorState } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { fileKind, parseWikiLinks, resolveImageRef, type TaskStatus } from '@holi/shared'
import { frontmatterRegion } from './frontmatter-region'
import { ImageWidget } from './imageWidget'
import { vaultAssetUrl } from '../lib/vault-asset'
import { WikiLinkChip } from './wikiLinkChips'

/** Doc-path existence lookup for chip styling; wired from server metadata. */
export const docExistsFacet = Facet.define<(path: string) => boolean, (path: string) => boolean>({
  combine: (values) => values[0] ?? (() => true),
})

/** The open note's vault path, so live-preview can resolve note-relative image
 *  targets (`![](img.png)`). Static per editor instance — the view is rebuilt
 *  per doc (EditorPane), so there is nothing to keep live here. */
export const notePathFacet = Facet.define<string, string>({
  combine: (values) => values[0] ?? '',
})

/** A task chip's rendered fields, resolved by path from the board's task store. */
export interface TaskChip {
  title: string
  status: TaskStatus
  /** YYYY-MM-DD; shown in the hover preview, not on the inline chip. */
  due?: string
}

/** Path → task lookup for chips, the sibling of `docExistsFacet`. The unwired default
 * says "no path is a task", so a bare editor renders every link as a note chip. */
export const taskByPathFacet = Facet.define<
  (path: string) => TaskChip | null,
  (path: string) => TaskChip | null
>({
  combine: (values) => values[0] ?? (() => null),
})

const conceal = Decoration.replace({})
const strong = Decoration.mark({ class: 'cm-strong' })
const emphasis = Decoration.mark({ class: 'cm-emphasis' })
const strike = Decoration.mark({ class: 'cm-strikethrough' })
const inlineCode = Decoration.mark({ class: 'cm-inline-code' })
const quoteMark = Decoration.mark({ class: 'cm-quote-mark' })
const linkText = Decoration.mark({ class: 'cm-md-link' })
const headingLine = (level: number) => Decoration.line({ class: `cm-heading cm-heading-${level}` })
const codeLine = Decoration.line({ class: 'cm-code-line' })

/**
 * A list line's indent, as its nesting depth. The length itself is in `theme.ts`.
 *
 * Depth is the only number that crosses, deliberately. An earlier version also
 * boxed the marker to a measured width so that a wrapped bullet could hang under
 * its own text; that needed the rendered width of `- ` in the vault's font,
 * which no CSS unit knows and only a layout measurement could supply. It was
 * more machinery than the result was worth. A wrapped line comes back to the
 * marker, as it always has.
 */
const listLine = (depth: number) =>
  Decoration.line({ class: 'cm-list', attributes: { style: `--list-depth:${depth}` } })

/** The marker, so the theme can hold the text off it. The one space markdown
 *  requires is not much of a gap in a proportional face. */
const listMark = Decoration.mark({ class: 'cm-list-mark' })
/** A bullet marker, raw. Same box as the dot below, so swapping one for the
 *  other on the active line moves nothing (FR-3b). */
const listBullet = Decoration.mark({ class: 'cm-list-mark cm-list-bullet' })

/**
 * `-`, `*` and `+` are three spellings of one thing, so they draw as one thing.
 *
 * The ladder is the browser's own disc / circle / square, which is what a nested
 * list looks like everywhere else, so the glyph says the depth a second time.
 * Ordered markers are left alone: a number carries meaning that a dot cannot.
 */
const BULLETS = ['•', '◦', '▪']

/**
 * `a.`, `A.`, `a)` — an ordered list markdown does not have.
 *
 * CommonMark's ordered list is decimal only, so the parser reads these as an
 * ordinary paragraph and the tree has nothing to say about them. They are the
 * one kind of list line this file has to find for itself.
 */
const ALPHA_MARKER = /^([ \t]*)([A-Za-z][.)])[ \t]/

class BulletWidget extends WidgetType {
  constructor(readonly glyph: string) {
    super()
  }

  override eq(other: BulletWidget): boolean {
    return other.glyph === this.glyph
  }

  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = 'cm-list-mark cm-list-bullet'
    el.textContent = this.glyph
    return el
  }
}

/**
 * A task's `[ ]`, as something you can click.
 *
 * Unconditional, unlike every other swap in this file: it is a control, not a
 * rendering of text, and a control that disappeared whenever the caret was on
 * its line could not be clicked from there at all. Being unconditional is also
 * what keeps the line still (FR-3b) — there is no second state to move to.
 *
 * The position comes from the DOM at click time rather than from a field, so an
 * edit elsewhere in the line cannot leave a stale offset behind, and the source
 * is checked before it is written: a widget that has outlived its text writes
 * nothing.
 */
class TaskCheckWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super()
  }

  override eq(other: TaskCheckWidget): boolean {
    return other.checked === this.checked
  }

  override toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('span')
    box.className = this.checked ? 'cm-task-check cm-task-check-done' : 'cm-task-check'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.textContent = this.checked ? '✓' : ''
    box.addEventListener('mousedown', (event) => {
      // Keep the caret where it is. A click that moved it would put the caret on
      // this line, and the line the caret is on renders its marker raw.
      event.preventDefault()
      if (view.state.readOnly) return
      const pos = view.posAtDOM(box)
      if (!/^\[[ xX]\]$/.test(view.state.sliceDoc(pos, pos + 3))) return
      view.dispatch({ changes: { from: pos, to: pos + 3, insert: this.checked ? '[ ]' : '[x]' } })
    })
    return box
  }

  /** The box handles its own clicks; CodeMirror should not read them as edits. */
  override ignoreEvent(): boolean {
    return true
  }
}

class HrWidget extends WidgetType {
  override toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'cm-hr'
    return el
  }
}

/** Line numbers (1-based) the primary selection touches — these render raw. */
export function activeLines(state: EditorState): Set<number> {
  const lines = new Set<number>()
  const sel = state.selection.main
  const fromLine = state.doc.lineAt(sel.from).number
  const toLine = state.doc.lineAt(sel.to).number
  for (let n = fromLine; n <= toLine; n++) lines.add(n)
  return lines
}

export function buildDecorations(state: EditorState, from: number, to: number): DecorationSet {
  const active = activeLines(state)
  const isActive = (pos: number) => active.has(state.doc.lineAt(pos).number)
  // The frontmatter widget owns [0, fmEnd) as one atomic block-replace, so
  // nothing here may decorate inside it — GFM parses the leading `---` lines as
  // thematic breaks, and an HR (or a stray heading/paragraph mark) fighting the
  // block is exactly the mess the widget exists to remove.
  const fmEnd = frontmatterRegion(state.doc.toString())?.to ?? 0
  // Collect first (tree iteration + regex scan), sort, then feed the builder
  const ranges: { from: number; to: number; deco: Decoration }[] = []
  // The open note's path, so `![](img.png)` resolves note-relative in the walk below.
  const notePath = state.facet(notePathFacet)

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const activeHere = isActive(node.from)
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const level = Number(node.name.slice('ATXHeading'.length))
          const line = state.doc.lineAt(node.from)
          ranges.push({ from: line.from, to: line.from, deco: headingLine(level) })
          break
        }
        case 'HeaderMark': {
          // conceal "# " (mark + the following space) on inactive lines
          if (!activeHere) {
            const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
            ranges.push({ from: node.from, to: end, deco: conceal })
          }
          break
        }
        case 'StrongEmphasis':
          ranges.push({ from: node.from, to: node.to, deco: strong })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 2, deco: conceal })
            ranges.push({ from: node.to - 2, to: node.to, deco: conceal })
          }
          break
        case 'Emphasis':
          ranges.push({ from: node.from, to: node.to, deco: emphasis })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 1, deco: conceal })
            ranges.push({ from: node.to - 1, to: node.to, deco: conceal })
          }
          break
        case 'Strikethrough':
          ranges.push({ from: node.from, to: node.to, deco: strike })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 2, deco: conceal })
            ranges.push({ from: node.to - 2, to: node.to, deco: conceal })
          }
          break
        case 'InlineCode':
          ranges.push({ from: node.from, to: node.to, deco: inlineCode })
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.from + 1, deco: conceal })
            ranges.push({ from: node.to - 1, to: node.to, deco: conceal })
          }
          break
        case 'FencedCode': {
          const first = state.doc.lineAt(node.from).number
          const last = state.doc.lineAt(node.to).number
          for (let n = first; n <= last; n++) {
            const line = state.doc.line(n)
            ranges.push({ from: line.from, to: line.from, deco: codeLine })
          }
          break
        }
        case 'ListItem': {
          // Only the line the marker is on. A `ListItem` spans its children too
          // — a nested list, a lazy continuation, a fenced block — and those
          // lines carry their own indentation in the source; padding them as
          // well would double it, and would shift a fenced block away from the
          // code it is aligned with.
          const mark = node.node.firstChild
          if (mark === null || mark.name !== 'ListMark') break
          // A marker with nothing after it is still a list item to the parser,
          // so `- ` and `1.` indent the line the moment they are typed and it
          // jumps out from under you. Wait for the space that makes it a list
          // you can put something in.
          if (!/[ \t]/.test(state.sliceDoc(mark.to, mark.to + 1))) break
          // Depth from the tree, never from the leading spaces: `BulletList` and
          // `OrderedList` nest around each `ListItem`, so the parent chain says
          // how deep this is no matter how the author typed it. `-`, `*` and
          // `1.` all arrive here the same way.
          let depth = 0
          for (let p = node.node.parent; p !== null; p = p.parent) {
            if (p.name === 'BulletList' || p.name === 'OrderedList') depth++
          }
          const line = state.doc.lineAt(node.from)
          ranges.push({ from: line.from, to: line.from, deco: listLine(depth) })
          // The author's own indentation goes away, or it would be added to the
          // padding and a four-space list would sit twice as far in as a
          // two-space one. Only the whitespace immediately before the marker: a
          // list inside a blockquote has a `> ` in front of it, and that is
          // styled, not hidden. Concealed on the active line too, so the line
          // sits in the same place with the caret on it as without (FR-3b).
          let lead = mark.from
          while (lead > line.from && /[ \t]/.test(state.sliceDoc(lead - 1, lead))) lead--
          if (lead < mark.from) ranges.push({ from: lead, to: mark.from, deco: conceal })
          // A task's checkbox IS its marker, so the `- ` in front of it goes,
          // space and all, and the box lands where a bullet would have. Drawing
          // both would say "list item" twice.
          const task = mark.nextSibling
          const taskMark = task?.name === 'Task' ? task.firstChild : null
          if (taskMark !== null && taskMark !== undefined && taskMark.name === 'TaskMarker') {
            ranges.push({ from: mark.from, to: mark.to + 1, deco: conceal })
            ranges.push({
              from: taskMark.from,
              to: taskMark.to,
              deco: Decoration.replace({
                widget: new TaskCheckWidget(state.sliceDoc(taskMark.from, taskMark.to) !== '[ ]'),
              }),
            })
            break
          }
          // The marker draws as a bullet, except on the line the caret is on,
          // where every other mark in this file shows its source too. The two
          // wear the same box, so the swap costs no movement.
          const isBullet = /^[-*+]$/.test(state.sliceDoc(mark.from, mark.to))
          const glyph = BULLETS[Math.min(depth, BULLETS.length) - 1] ?? BULLETS[0]!
          ranges.push({
            from: mark.from,
            to: mark.to,
            deco:
              isBullet && !activeHere
                ? Decoration.replace({ widget: new BulletWidget(glyph) })
                : isBullet
                  ? listBullet
                  : listMark,
          })
          break
        }
        case 'QuoteMark':
          ranges.push({ from: node.from, to: node.to, deco: quoteMark })
          break
        case 'HorizontalRule':
          if (!activeHere) {
            ranges.push({ from: node.from, to: node.to, deco: Decoration.replace({ widget: new HrWidget() }) })
          }
          break
        case 'Link': {
          // [text](url) → conceal "[", "](url)" ; style text
          const text = state.sliceDoc(node.from, node.to)
          const close = text.indexOf('](')
          if (close !== -1 && text.endsWith(')')) {
            const url = text.slice(close + 2, -1)
            ranges.push({
              from: node.from + 1,
              to: node.from + close,
              deco: Decoration.mark({ class: 'cm-md-link', attributes: { 'data-href': url } }),
            })
            if (!activeHere) {
              ranges.push({ from: node.from, to: node.from + 1, deco: conceal })
              ranges.push({ from: node.from + close, to: node.to, deco: conceal })
            }
          } else {
            ranges.push({ from: node.from, to: node.to, deco: linkText })
          }
          break
        }
        case 'Image': {
          // ![alt](target). Rendered as the image unless the cursor is on this
          // line (then the raw markdown shows, like every other widget).
          if (activeHere) break
          const text = state.sliceDoc(node.from, node.to)
          const m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(text)
          if (m === null) break
          const alt = m[1] ?? ''
          const target = m[2] ?? ''
          const ref = resolveImageRef(notePath, target)
          const src = ref.kind === 'external' ? ref.url : vaultAssetUrl(ref.path)
          ranges.push({
            from: node.from,
            to: node.to,
            deco: Decoration.replace({ widget: new ImageWidget(src, alt) }),
          })
          break
        }
      }
    },
  })

  // Alphabetic ordered lists, which are not in the tree (see ALPHA_MARKER).
  // Found by reading lines, and deliberately fussy about which ones count: a
  // paragraph opening "A. Smith said" is a sentence, not a list. So the line has
  // to either sit inside a list already — `a.` under `1.`, which is what these
  // are nearly always for — or begin a block, which is the same rule markdown
  // itself puts on an ordered list interrupting a paragraph.
  const firstLine = state.doc.lineAt(from).number
  const lastLine = state.doc.lineAt(to).number
  for (let n = firstLine; n <= lastLine; n++) {
    const line = state.doc.line(n)
    const m = ALPHA_MARKER.exec(line.text)
    if (m === null) continue
    const markFrom = line.from + m[1]!.length
    const markTo = markFrom + m[2]!.length
    // The enclosing lists give the depth, and a fence vetoes the whole thing:
    // `a) hello` inside a code block is code.
    let depth = 0
    let fenced = false
    for (
      let p: SyntaxNode | null = syntaxTree(state).resolveInner(markFrom, 1);
      p !== null;
      p = p.parent
    ) {
      if (p.name === 'BulletList' || p.name === 'OrderedList') depth++
      if (p.name === 'FencedCode' || p.name === 'CodeBlock') fenced = true
    }
    if (fenced) continue
    if (depth === 0 && n > 1 && state.doc.line(n - 1).text.trim() !== '') continue
    ranges.push({ from: line.from, to: line.from, deco: listLine(depth + 1) })
    if (markFrom > line.from) ranges.push({ from: line.from, to: markFrom, deco: conceal })
    ranges.push({ from: markFrom, to: markTo, deco: listMark })
  }

  // wiki-links via the shared grammar (not part of the markdown tree)
  const docExists = state.facet(docExistsFacet)
  const taskByPath = state.facet(taskByPathFacet)
  const visible = state.sliceDoc(from, to)
  for (const link of parseWikiLinks(visible)) {
    const start = from + link.start
    const end = from + link.end
    if (isActive(start)) continue
    if (fileKind(link.target) === 'image') {
      // [[img.png]] embeds are vault-relative (used as-is); render inline.
      ranges.push({
        from: start,
        to: end,
        deco: Decoration.replace({
          widget: new ImageWidget(vaultAssetUrl(link.target), link.label ?? link.target),
        }),
      })
      continue
    }
    // A path that resolves to a task renders a task chip (orb + title); everything else
    // is a note chip, existing or missing. An explicit `|Label` wins over the live title.
    const task = taskByPath(link.target)
    const chip = task
      ? new WikiLinkChip(link.target, link.label ?? task.title, true, { status: task.status })
      : new WikiLinkChip(link.target, link.label ?? link.target, docExists(link.target))
    ranges.push({ from: start, to: end, deco: Decoration.replace({ widget: chip }) })
  }

  const kept = ranges.filter((r) => r.from >= fmEnd)
  kept.sort((a, b) => a.from - b.from || a.to - b.to || (a.deco.spec.widget ? 1 : -1))
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of kept) builder.add(r.from, r.to, r.deco)
  return builder.finish()
}

export const livePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet

    constructor(readonly view: EditorView) {
      this.decorations = this.build()
    }

    update(update: ViewUpdate): void {
      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.build()
      }
    }

    private build(): DecorationSet {
      // visible ranges only (PRD §reveal logic: performance)
      const sets: DecorationSet[] = []
      for (const range of this.view.visibleRanges) {
        sets.push(buildDecorations(this.view.state, range.from, range.to))
      }
      return sets.length === 1 ? sets[0]! : joinSets(sets)
    }
  },
  { decorations: (v) => v.decorations },
)

function joinSets(sets: DecorationSet[]): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const set of sets) {
    const iter = set.iter()
    while (iter.value) {
      builder.add(iter.from, iter.to, iter.value)
      iter.next()
    }
  }
  return builder.finish()
}
