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
import { fileKind, parseWikiLinks, resolveImageRef } from '@holi/shared'
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

/** What a `[[task:<id>]]` chip should say, and whether its target is gone (D27's
 * tombstone). Resolved by the renderer against `tasksAtom` — the editor never joins. */
export interface TaskChipInfo {
  label: string
  missing: boolean
}

/** Task id → title lookup for chips, the sibling of `docExistsFacet`.
 *
 * The unwired default shows the raw id and claims **nothing** about existence: a chip
 * that says "[deleted task]" because a facet was never provided would be a fresh lie of
 * exactly the kind this change exists to remove. */
export const taskInfoFacet = Facet.define<(id: string) => TaskChipInfo, (id: string) => TaskChipInfo>(
  {
    combine: (values) => values[0] ?? ((id) => ({ label: id, missing: false })),
  },
)

const conceal = Decoration.replace({})
const strong = Decoration.mark({ class: 'cm-strong' })
const emphasis = Decoration.mark({ class: 'cm-emphasis' })
const strike = Decoration.mark({ class: 'cm-strikethrough' })
const inlineCode = Decoration.mark({ class: 'cm-inline-code' })
const quoteMark = Decoration.mark({ class: 'cm-quote-mark' })
const linkText = Decoration.mark({ class: 'cm-md-link' })
const headingLine = (level: number) => Decoration.line({ class: `cm-heading cm-heading-${level}` })
const codeLine = Decoration.line({ class: 'cm-code-line' })

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
  const taskInfo = state.facet(taskInfoFacet)
  const visible = state.sliceDoc(from, to)
  for (const link of parseWikiLinks(visible)) {
    const start = from + link.start
    const end = from + link.end
    if (isActive(start)) continue
    // Both kinds get a chip. Task links used to fall out here, which meant the app's own
    // `@`-mention wrote `[[task:<id>]]` that its own editor rendered as raw text.
    let chip: WikiLinkChip
    if (link.kind === 'task') {
      const info = taskInfo(link.target)
      // An explicit `|Label` wins over the live title — the author asked for those words.
      chip = new WikiLinkChip('task', link.target, link.label ?? info.label, !info.missing)
    } else if (fileKind(link.target) === 'image') {
      // [[img.png]] embeds are vault-relative (used as-is); render inline.
      ranges.push({
        from: start,
        to: end,
        deco: Decoration.replace({
          widget: new ImageWidget(vaultAssetUrl(link.target), link.label ?? link.target),
        }),
      })
      continue
    } else {
      chip = new WikiLinkChip('note', link.target, link.label ?? link.target, docExists(link.target))
    }
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
