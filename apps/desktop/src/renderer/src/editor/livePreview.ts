/**
 * Simplified live preview (D22): a pure decoration builder over the syntax
 * tree + wiki-link grammar. Lines the selection touches render RAW (no
 * concealing decorations there); everything else renders. Rebuilds on
 * docChanged/selectionSet/viewport — a plain recompute, no animation.
 */
import { syntaxTree } from '@codemirror/language'
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
          ranges.push({ from: mark.from, to: mark.to, deco: listMark })
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
