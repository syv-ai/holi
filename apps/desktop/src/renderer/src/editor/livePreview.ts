/**
 * Live preview: a pure decoration builder over the syntax tree + wiki-link
 * grammar. The ELEMENT the selection touches renders raw; everything else
 * renders, including the rest of its line (D91, narrowing D22's whole-line
 * reveal). `revealedSpans` is the rule: touched edges included, innermost only.
 * Rebuilds on docChanged/selectionSet/viewport.
 */
import { syntaxTree } from '@codemirror/language'
import { Check, createElement } from 'lucide'
import type { SyntaxNode, SyntaxNodeRef } from '@lezer/common'
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
import { alphaListAt } from './lists'
import { ImageWidget } from './imageWidget'
import { vaultAssetUrl } from '../lib/vault-asset'
import { WikiLinkChip } from './wikiLinkChips'

/** Doc-path existence lookup for chip styling, wired from the vault snapshot's
 *  paths via `EditorDeps.docExists`. */
export const docExistsFacet = Facet.define<(path: string) => boolean, (path: string) => boolean>({
  combine: (values) => values[0] ?? (() => true),
})

/** The open note's vault path, for note-relative image targets. Static: the
 *  view is rebuilt per document. */
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

/**
 * Set on a table cell's editor only: a cell has no blocks. The plugin already
 * strips most block nodes from a cell's parser, but that list is theirs, not
 * ours. Not covered by it: the alphabetic-list regex scan, and images, which
 * markdown counts as inline.
 */
export const inlineOnlyFacet = Facet.define<boolean, boolean>({
  combine: (values) => values[0] ?? false,
})

/** What `inlineOnlyFacet` turns off. */
const BLOCK_NODES = new Set([
  'ATXHeading1',
  'ATXHeading2',
  'ATXHeading3',
  'ATXHeading4',
  'ATXHeading5',
  'ATXHeading6',
  'SetextHeading1',
  'SetextHeading2',
  'HeaderMark',
  'FencedCode',
  'ListItem',
  'QuoteMark',
  'HorizontalRule',
  'Image',
])

const conceal = Decoration.replace({})
const strong = Decoration.mark({ class: 'cm-strong' })
const emphasis = Decoration.mark({ class: 'cm-emphasis' })
const strike = Decoration.mark({ class: 'cm-strikethrough' })
const inlineCode = Decoration.mark({ class: 'cm-inline-code' })
const quoteMark = Decoration.mark({ class: 'cm-quote-mark' })
const linkText = Decoration.mark({ class: 'cm-md-link' })
/**
 * `raw` lives on the LINE, not the mark, so the `#` can slide: the unchanged
 * mark keeps its DOM element across a selection move. A class flip on the mark
 * would rebuild it, and a transition cannot cross a recreated node.
 */
const headingLine = (level: number, raw: boolean) =>
  Decoration.line({ class: `cm-heading cm-heading-${level}${raw ? ' cm-heading-raw' : ''}` })

/** The `# `, always in the DOM, its box opened and closed by the theme. */
const headingMark = Decoration.mark({ class: 'cm-heading-mark' })
const codeLine = Decoration.line({ class: 'cm-code-line' })

/**
 * A list line's indent, as its nesting depth; the length is in `theme.ts`.
 * Hanging a wrapped line under its text was rejected: it needs the measured
 * width of `- ` in the vault's font, too much machinery for the result.
 */
const listLine = (depth: number) =>
  Decoration.line({ class: 'cm-list', attributes: { style: `--list-depth:${depth}` } })

/** The marker, so the theme can hold the text off it. The one space markdown
 *  requires is not much of a gap in a proportional face. */
const listMark = Decoration.mark({ class: 'cm-list-mark' })
/** A bullet marker, raw. Same box as the dot below, so swapping one for the
 *  other on the active line moves nothing. */
const listBullet = Decoration.mark({ class: 'cm-list-mark cm-list-bullet' })

/** `-`, `*` and `+` draw alike, in the browser's disc / circle / square ladder
 *  by depth. Ordered markers are left alone. */
const BULLETS = ['•', '◦', '▪']

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
 * A task's `[ ]`, as a clickable box. Unconditional, unlike every other swap
 * here: a control that vanished with the caret on its line could not be
 * clicked from there.
 *
 * The position is read from the DOM at click time, and the source is checked
 * before writing, so a widget that outlived its text writes nothing.
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
    // lucide's Check, as the rest of the app draws a tick; sized by the box.
    if (this.checked)
      box.append(createElement(Check, { class: 'cm-task-tick', 'aria-hidden': 'true' }))
    box.addEventListener('mousedown', (event) => {
      // Keep the caret where it is.
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

/** A range in the document: the unit live preview reveals (D91). */
export interface Span {
  from: number
  to: number
}

/** Spans are compared by value: they are built twice, once to decide what the
 *  caret is on and once to decorate. */
export function spanKey(span: Span): string {
  return `${span.from}:${span.to}`
}

/**
 * Does the selection touch this span? Edge-inclusive, so the `**` you just
 * typed stay visible until you move off the word instead of closing and
 * shifting the line under your fingers.
 */
export function touches(sel: Span, span: Span): boolean {
  return sel.from <= span.to && sel.to >= span.from
}

/**
 * Of the spans the selection touches, the ones with nothing smaller inside them:
 * with the caret on a link inside bold text, only the link comes back raw.
 * Containment is strict, so two elements sharing a range do not cancel out.
 */
export function revealedSpans(spans: Span[], sel: Span): Set<string> {
  const touched = spans.filter((s) => touches(sel, s))
  const out = new Set<string>()
  for (const s of touched) {
    const holdsASmallerOne = touched.some(
      (o) => o.from >= s.from && o.to <= s.to && (o.from > s.from || o.to < s.to),
    )
    if (!holdsASmallerOne) out.add(spanKey(s))
  }
  return out
}

/**
 * The range that, when the selection touches it, shows an element's source.
 * Usually the element itself; a heading's `#` and a list marker belong to their
 * LINE, so the caret need not land on the marker itself.
 *
 * `null` for everything not concealed conditionally: fenced code, quote marks,
 * the frontmatter block, a list's leading indent.
 */
function revealSpan(
  state: EditorState,
  node: SyntaxNodeRef | SyntaxNode | null,
  inlineOnly: boolean,
): Span | null {
  if (node === null) return null
  if (inlineOnly && BLOCK_NODES.has(node.name)) return null
  switch (node.name) {
    case 'ATXHeading1':
    case 'ATXHeading2':
    case 'ATXHeading3':
    case 'ATXHeading4':
    case 'ATXHeading5':
    case 'ATXHeading6':
    case 'SetextHeading1':
    case 'SetextHeading2':
    case 'StrongEmphasis':
    case 'Emphasis':
    case 'Strikethrough':
    case 'InlineCode':
    case 'Link':
    case 'Image':
    case 'HorizontalRule':
      return { from: node.from, to: node.to }
    // A `#` is revealed by its heading, not by its own two columns.
    case 'HeaderMark':
      return revealSpan(state, node.node.parent, inlineOnly)
    case 'ListItem': {
      const mark = node.node.firstChild
      if (mark === null || mark.name !== 'ListMark') return null
      const line = state.doc.lineAt(node.from)
      return { from: line.from, to: line.to }
    }
    default:
      return null
  }
}

export function buildDecorations(state: EditorState, from: number, to: number): DecorationSet {
  // The tree is walked twice: an element cannot know whether a smaller one
  // inside it is being edited until the whole span list exists.
  const visible = state.sliceDoc(from, to)
  // Wiki-links are not in the markdown tree; parsed once here, reused below.
  const wikiLinks = parseWikiLinks(visible)
  const spans: Span[] = wikiLinks.map((link) => ({ from: from + link.start, to: from + link.end }))
  const wikiSpans = [...spans]
  const inlineOnly = state.facet(inlineOnlyFacet)
  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      const span = revealSpan(state, node, inlineOnly)
      if (span === null) return
      // The markdown parser reads the inner `[x]` of `[[x]]` as a shortcut Link
      // and a `|**Label**` as strong text. Left in, those would shadow the
      // wiki-link and its chip would never open.
      if (wikiSpans.some((w) => span.from >= w.from && span.to <= w.to)) return
      spans.push(span)
    },
  })
  const revealed = revealedSpans(spans, state.selection.main)
  const isActive = (span: Span | null) => span !== null && revealed.has(spanKey(span))
  // The frontmatter widget owns [0, fmEnd), so nothing may decorate inside it:
  // GFM parses the leading `---` lines as thematic breaks.
  const fmEnd = frontmatterRegion(state.doc.toString())?.to ?? 0
  // Collect first (tree iteration + regex scan), sort, then feed the builder
  const ranges: { from: number; to: number; deco: Decoration }[] = []
  const notePath = state.facet(notePathFacet)

  syntaxTree(state).iterate({
    from,
    to,
    enter(node) {
      if (inlineOnly && BLOCK_NODES.has(node.name)) return
      const activeHere = isActive(revealSpan(state, node, inlineOnly))
      switch (node.name) {
        case 'ATXHeading1':
        case 'ATXHeading2':
        case 'ATXHeading3':
        case 'ATXHeading4':
        case 'ATXHeading5':
        case 'ATXHeading6': {
          const level = Number(node.name.slice('ATXHeading'.length))
          const line = state.doc.lineAt(node.from)
          ranges.push({ from: line.from, to: line.from, deco: headingLine(level, activeHere) })
          break
        }
        case 'HeaderMark': {
          // "# " — the mark and the space after it.
          const end = state.sliceDoc(node.to, node.to + 1) === ' ' ? node.to + 1 : node.to
          const heading = node.node.parent
          if (heading !== null && heading.name.startsWith('ATXHeading')) {
            // Marked unconditionally, never replaced: a replace removes the
            // element a transition needs. State rides on the line (`headingLine`).
            ranges.push({ from: node.from, to: end, deco: headingMark })
            break
          }
          // A setext underline has no heading line to carry that state: plain swap.
          if (!activeHere) ranges.push({ from: node.from, to: end, deco: conceal })
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
          // Only the marker's line: a `ListItem` spans its children too, whose
          // lines carry their own source indentation.
          const mark = node.node.firstChild
          if (mark === null || mark.name !== 'ListMark') break
          // Wait for the space after the marker, or the line jumps the moment a
          // bare `-` or `1.` is typed.
          if (!/[ \t]/.test(state.sliceDoc(mark.to, mark.to + 1))) break
          // Depth from the tree's parent chain, never from the leading spaces.
          let depth = 0
          for (let p = node.node.parent; p !== null; p = p.parent) {
            if (p.name === 'BulletList' || p.name === 'OrderedList') depth++
          }
          const line = state.doc.lineAt(node.from)
          ranges.push({ from: line.from, to: line.from, deco: listLine(depth) })
          // Conceal the author's indentation, always, so the depth alone places
          // the line. Only the whitespace right before the marker: a blockquote's
          // `> ` is styled, not hidden.
          let lead = mark.from
          while (lead > line.from && /[ \t]/.test(state.sliceDoc(lead - 1, lead))) lead--
          if (lead < mark.from) ranges.push({ from: lead, to: mark.from, deco: conceal })
          // A task's checkbox is its marker, so the `- ` in front of it goes.
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
          // A bullet glyph, except on the active line; both wear the same box.
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
            ranges.push({
              from: node.from,
              to: node.to,
              deco: Decoration.replace({ widget: new HrWidget() }),
            })
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
          // ![alt](target). Rendered unless the selection touches it.
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

  // Alphabetic ordered lists, which the parser does not report (predicate in
  // `lists.ts`). A regex over lines, so it is switched off by hand in a cell.
  const lastLine = inlineOnly ? 0 : state.doc.lineAt(to).number
  for (let n = state.doc.lineAt(from).number; n <= lastLine; n++) {
    const line = state.doc.line(n)
    const item = alphaListAt(state, line)
    if (item === null) continue
    ranges.push({ from: line.from, to: line.from, deco: listLine(item.depth) })
    if (item.markFrom > line.from) {
      ranges.push({ from: line.from, to: item.markFrom, deco: conceal })
    }
    ranges.push({ from: item.markFrom, to: item.markTo, deco: listMark })
  }

  // wiki-links via the shared grammar (not part of the markdown tree)
  const docExists = state.facet(docExistsFacet)
  const taskByPath = state.facet(taskByPathFacet)
  for (const link of wikiLinks) {
    const start = from + link.start
    const end = from + link.end
    if (isActive({ from: start, to: end })) continue
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
      // Visible ranges only, for performance.
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
